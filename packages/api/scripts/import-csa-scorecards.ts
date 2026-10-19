/**
 * One-off: import the CSA scoring site's premier scorecards (cricketpvcms.co.za — KZNCU T20
 * Premier Men / Women are scored there, not in medicoach) as FIXSCORECARD rows, so the
 * captain's report asks premier sides to confirm the scorecard like every other fixture.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/import-csa-scorecards.ts \
 *     --stage=<stage> [--tenant=dolphins] --file="<xlsx>" [--date=2026-10-18] \
 *     [--series=<id>,<id>] [--fill-summaries] [--backup-dir=<dir>] [--confirm]
 *
 * The workbook (Matches / Innings / Batting / Bowling sheets) is parsed and every innings is
 * validated against InningsScorecardWireSchema before anything is looked up. Fixtures are
 * found with Query/Get only (no scans): `listSeries` + `getSeasonRun` pick the series whose
 * league is `premier` / `premierWomen` (or `--series`), and each workbook match is matched to
 * the ONE fixture on its date whose two sides are the workbook's two teams, in either order.
 * Hard stops (exit 1, nothing written — no backup either): a workbook error, a match with 0
 * or >1 candidate fixtures (add a TEAM_ALIASES entry), two matches claiming one fixture. A
 * premier fixture with no workbook row is only a warning (bye / washout).
 *
 * Dry run (default) prints the plan and writes ONLY the JSON backup (existing FIXSCORECARD
 * rows + the fixtures' captain's-report statuses / result summaries). `--confirm` stores each
 * card (`available`, `terminal`, `medicoachMatchId: csa-<match id>`, `sourceUrl` = the CSA
 * link) — a plain replace, so a re-run is idempotent; an unchanged card keeps its original
 * `fetchedAt` so submitted scorecard answers never turn stale. `--fill-summaries` also sets
 * `resultSummary` on each side's report, only while it is pending AND has none.
 *
 * Exit status: 1 for a bad flag, a stage mismatch or any hard stop; else 0.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import ExcelJS from 'exceljs';
import type { Club, Series, StoredFixtureScorecard } from '../src/types.js';
import {
  InningsScorecardWireSchema,
  type InningsScorecardWire,
} from '../src/medicoach-sync-contract.js';
import { sstStage } from './backfill-captains-report-notices.js';

const DEFAULT_BACKUP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE =
  'usage: import-csa-scorecards --stage=<stage> [--tenant=<id>] --file=<xlsx> ' +
  '[--date=YYYY-MM-DD] [--series=<id>,…] [--fill-summaries] [--backup-dir=<dir>] [--confirm]';

const PREMIER_LEAGUES = { men: 'premier', women: 'premierWomen' } as const;

/**
 * Workbook team spelling → Smart Club spelling, both as `normaliseTeam` returns them. Filled
 * from the dry run's "no fixture" errors; comment each entry with the workbook's spelling.
 */
export const TEAM_ALIASES: Record<string, string> = {
  // Filled from the prod dry run of 19 Oct 2026 (SC names from its WARN lines):
  'hollywoodbets crusaders': 'crusaders', // "Hollywoodbets Crusaders 1st XI" → SC "Crusaders"
  'harlequins dbn': 'harlequins', // "Harlequins CC DBN 1st XI" → SC "Harlequins Cricket Club"
  // "Chatsworth Sporting CC 1st XI" (men + women) → SC "Hollywoodbets Chatsworth Sporting"
  'chatsworth sporting': 'hollywoodbets chatsworth sporting',
  'kccd mancosa': 'kccd', // "KCCD MANCOSA Women's 1st XI" → SC "KCCD"
};

export interface ImportArgs {
  stage: string;
  tenant: string;
  file: string;
  date?: string;
  seriesIds?: string[];
  fillSummaries: boolean;
  /** Workbook match ids whose reports' resultSummary may be REPLACED (pending-only). */
  overwriteSummaries?: string[];
  backupDir?: string;
  confirm: boolean;
}

const list = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Parse the CLI flags; throws (message = the reason) on anything bad or unknown. Pure. */
export function parseImportArgs(argv: string[]): ImportArgs {
  const out: Partial<ImportArgs> & { confirm: boolean; tenant: string; fillSummaries: boolean } = {
    confirm: false,
    tenant: 'dolphins',
    fillSummaries: false,
  };
  for (const arg of argv) {
    const [flag, ...rest] = arg.split('=');
    const value = rest.join('=').trim();
    if (arg === '--confirm') out.confirm = true;
    else if (arg === '--dry-run') out.confirm = false;
    else if (arg === '--fill-summaries') out.fillSummaries = true;
    else if (flag === '--stage' && value) out.stage = value;
    else if (flag === '--tenant' && value) out.tenant = value;
    else if (flag === '--file' && value) out.file = value;
    else if (flag === '--date' && value) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
        throw new Error(`--date must be YYYY-MM-DD, got "${value}"`);
      out.date = value;
    } else if (flag === '--series' && value) out.seriesIds = list(value);
    else if (flag === '--overwrite-summaries' && value) out.overwriteSummaries = list(value);
    else if (flag === '--backup-dir' && value) out.backupDir = value;
    else throw new Error(`unknown or empty flag "${arg}"`);
  }
  if (!out.stage) throw new Error('--stage is required');
  if (!out.file) throw new Error('--file is required');
  if (out.overwriteSummaries && !out.fillSummaries)
    throw new Error('--overwrite-summaries needs --fill-summaries');
  return out as ImportArgs;
}

// ───────────────────────── Workbook ─────────────────────────

export interface WorkbookBatter {
  pos: number;
  name: string;
  howOut: string;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  strikeRate: number;
}

export interface WorkbookBowler {
  name: string;
  overs: string;
  maidens: number;
  runs: number;
  wickets: number;
  economy: number;
  wides: number;
  noBalls: number;
}

export interface WorkbookFallOfWicket {
  wicket: number;
  runs: number;
  batterName: string;
  overs: string;
}

export interface WorkbookInnings {
  number: number;
  battingTeam: string;
  bowlingTeam: string;
  runs: number;
  wickets: number;
  overs: string;
  extras: {
    total: number;
    byes: number;
    legByes: number;
    wides: number;
    noBalls: number;
    penalties: number;
  };
  target?: number;
  fallOfWickets: WorkbookFallOfWicket[];
  batters: WorkbookBatter[];
  bowlers: WorkbookBowler[];
}

export interface WorkbookMatch {
  competition: string;
  matchId: string;
  date: string;
  venue: string;
  home: string;
  away: string;
  toss: string;
  result: string;
  firstInnings: string;
  secondInnings: string;
  link: string;
  /** The CSA tournament id: the link's path segment before the match id. */
  tournamentId: string;
  innings: WorkbookInnings[];
}

const cellText = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as { richText?: Array<{ text: string }>; text?: unknown; result?: unknown };
    if (o.richText)
      return o.richText
        .map((t) => t.text)
        .join('')
        .trim();
    if (o.text !== undefined) return cellText(o.text);
    if (o.result !== undefined) return cellText(o.result);
  }
  return String(v).trim();
};

type Row = Record<string, unknown>;

function sheetRows(wb: ExcelJS.Workbook, name: string, headers: string[]): Row[] {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`sheet "${name}" is missing`);
  const head = ws.getRow(1);
  const col: Record<string, number> = {};
  for (let c = 1; c <= ws.columnCount; c++) col[cellText(head.getCell(c).value)] = c;
  const missing = headers.filter((h) => !col[h]);
  if (missing.length) throw new Error(`sheet "${name}" lacks column(s): ${missing.join(', ')}`);
  const rows: Row[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const out: Row = { __row: r };
    let any = false;
    for (const h of headers) {
      const v = row.getCell(col[h]).value;
      if (cellText(v) !== '') any = true;
      out[h] = v;
    }
    if (any) rows.push(out);
  }
  return rows;
}

const at = (sheet: string, row: Row) => `${sheet} row ${row.__row}`;

function textOf(sheet: string, row: Row, h: string, required = true): string {
  const t = cellText(row[h]);
  if (required && !t) throw new Error(`${at(sheet, row)}: "${h}" is empty`);
  return t;
}

function numOf(sheet: string, row: Row, h: string, fallback?: number): number {
  const t = cellText(row[h]);
  if (t === '' && fallback !== undefined) return fallback;
  const n = Number(t);
  if (t === '' || !Number.isFinite(n))
    throw new Error(`${at(sheet, row)}: "${h}" is not a number (${t || 'empty'})`);
  return n;
}

// The CSA site writes a completed over's last ball as .6 ("8.6"), so .0–.6 all occur.
const OVERS_RE = /^\d+(\.[0-6])?$/;
function oversOf(sheet: string, row: Row, h: string): string {
  const t = textOf(sheet, row, h);
  if (!OVERS_RE.test(t)) throw new Error(`${at(sheet, row)}: "${h}" is not overs (${t})`);
  return t;
}

const FOW_RE = /(\d+)-(\d+) \(([^,]+), ([\d.]+) ov\)/g;

/** "1-49 (A Batter, 5.2 ov), 2-81 (…)" → entries; anything else in the cell throws. Pure. */
export function parseFallOfWickets(text: string): WorkbookFallOfWicket[] {
  const t = text.trim();
  if (!t) return [];
  const out: WorkbookFallOfWicket[] = [];
  for (const m of t.matchAll(FOW_RE))
    out.push({ wicket: Number(m[1]), runs: Number(m[2]), batterName: m[3].trim(), overs: m[4] });
  if (t.replace(FOW_RE, '').replace(/[,\s]/g, '') !== '' || !out.length)
    throw new Error(`unreadable fall of wickets: "${t}"`);
  return out;
}

/** The CSA tournament + match ids from a match link (…/<tournament>/<match>). Pure. */
export function csaLinkIds(link: string): { tournamentId: string; matchId: string } | null {
  const m = /^https?:\/\/[^/]+\/.*\/(\d+)\/(\d+)\/?$/.exec(link.trim());
  return m ? { tournamentId: m[1], matchId: m[2] } : null;
}

/** Parse the Matches / Innings / Batting / Bowling sheets; throws on anything malformed. */
export async function readWorkbook(path: string): Promise<WorkbookMatch[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const matchRows = sheetRows(wb, 'Matches', [
    'Competition',
    'Match ID',
    'Date',
    'Venue',
    'Home',
    'Away',
    'Toss',
    'Result',
    '1st innings',
    '2nd innings',
    'Link',
  ]);
  const inningsRows = sheetRows(wb, 'Innings', [
    'Match ID',
    'Innings',
    'Batting team',
    'Bowling team',
    'Runs',
    'Wickets',
    'Overs',
    'Extras',
    'Byes',
    'Leg byes',
    'Wides',
    'No balls',
    'Penalty',
    'Target',
    'Fall of wickets',
  ]);
  const battingRows = sheetRows(wb, 'Batting', [
    'Match ID',
    'Innings',
    'Pos',
    'Batter',
    'How out',
    'R',
    'B',
    '4s',
    '6s',
    'SR',
  ]);
  const bowlingRows = sheetRows(wb, 'Bowling', [
    'Match ID',
    'Innings',
    'Bowler',
    'O',
    'M',
    'R',
    'W',
    'Econ',
    'Wd',
    'Nb',
  ]);

  const matches: WorkbookMatch[] = [];
  const seen = new Set<string>();
  for (const row of matchRows) {
    const matchId = textOf('Matches', row, 'Match ID');
    if (seen.has(matchId)) throw new Error(`${at('Matches', row)}: match ${matchId} repeated`);
    seen.add(matchId);
    const date = textOf('Matches', row, 'Date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new Error(`${at('Matches', row)}: Date "${date}" is not YYYY-MM-DD`);
    const link = textOf('Matches', row, 'Link');
    const ids = csaLinkIds(link);
    if (!ids || ids.matchId !== matchId)
      throw new Error(
        `${at('Matches', row)}: link "${link}" does not end in /<tournament>/${matchId}`,
      );
    matches.push({
      competition: textOf('Matches', row, 'Competition'),
      matchId,
      date,
      venue: textOf('Matches', row, 'Venue', false),
      home: textOf('Matches', row, 'Home'),
      away: textOf('Matches', row, 'Away'),
      toss: textOf('Matches', row, 'Toss', false),
      result: textOf('Matches', row, 'Result', false),
      firstInnings: textOf('Matches', row, '1st innings', false),
      secondInnings: textOf('Matches', row, '2nd innings', false),
      link,
      tournamentId: ids.tournamentId,
      innings: [],
    });
  }
  const byId = new Map(matches.map((m) => [m.matchId, m]));
  const matchOf = (sheet: string, row: Row) => {
    const id = textOf(sheet, row, 'Match ID');
    const m = byId.get(id);
    if (!m) throw new Error(`${at(sheet, row)}: match ${id} is not on the Matches sheet`);
    return m;
  };

  for (const row of inningsRows) {
    const m = matchOf('Innings', row);
    const number = numOf('Innings', row, 'Innings');
    if (m.innings.some((i) => i.number === number))
      throw new Error(`${at('Innings', row)}: match ${m.matchId} innings ${number} repeated`);
    let fallOfWickets: WorkbookFallOfWicket[];
    try {
      fallOfWickets = parseFallOfWickets(textOf('Innings', row, 'Fall of wickets', false));
    } catch (err) {
      throw new Error(`${at('Innings', row)}: ${err instanceof Error ? err.message : err}`);
    }
    const target = cellText(row['Target']);
    m.innings.push({
      number,
      battingTeam: textOf('Innings', row, 'Batting team'),
      bowlingTeam: textOf('Innings', row, 'Bowling team'),
      runs: numOf('Innings', row, 'Runs'),
      wickets: numOf('Innings', row, 'Wickets'),
      overs: oversOf('Innings', row, 'Overs'),
      extras: {
        total: numOf('Innings', row, 'Extras', 0),
        byes: numOf('Innings', row, 'Byes', 0),
        legByes: numOf('Innings', row, 'Leg byes', 0),
        wides: numOf('Innings', row, 'Wides', 0),
        noBalls: numOf('Innings', row, 'No balls', 0),
        penalties: numOf('Innings', row, 'Penalty', 0),
      },
      ...(target ? { target: numOf('Innings', row, 'Target') } : {}),
      fallOfWickets,
      batters: [],
      bowlers: [],
    });
  }
  const inningsOf = (sheet: string, row: Row) => {
    const m = matchOf(sheet, row);
    const n = numOf(sheet, row, 'Innings');
    const inn = m.innings.find((i) => i.number === n);
    if (!inn) throw new Error(`${at(sheet, row)}: match ${m.matchId} has no innings ${n}`);
    return inn;
  };
  for (const row of battingRows)
    inningsOf('Batting', row).batters.push({
      pos: numOf('Batting', row, 'Pos'),
      name: textOf('Batting', row, 'Batter'),
      howOut: textOf('Batting', row, 'How out'),
      runs: numOf('Batting', row, 'R'),
      balls: numOf('Batting', row, 'B'),
      fours: numOf('Batting', row, '4s', 0),
      sixes: numOf('Batting', row, '6s', 0),
      strikeRate: numOf('Batting', row, 'SR', 0),
    });
  for (const row of bowlingRows)
    inningsOf('Bowling', row).bowlers.push({
      name: textOf('Bowling', row, 'Bowler'),
      overs: oversOf('Bowling', row, 'O'),
      maidens: numOf('Bowling', row, 'M', 0),
      runs: numOf('Bowling', row, 'R'),
      wickets: numOf('Bowling', row, 'W', 0),
      economy: numOf('Bowling', row, 'Econ', 0),
      wides: numOf('Bowling', row, 'Wd', 0),
      noBalls: numOf('Bowling', row, 'Nb', 0),
    });

  if (!matches.length) throw new Error('the Matches sheet has no matches');
  for (const m of matches) {
    m.innings.sort((a, b) => a.number - b.number);
    if (m.innings.length < 1 || m.innings.length > 2)
      throw new Error(`match ${m.matchId}: ${m.innings.length} innings (expected 1–2)`);
    for (const i of m.innings) {
      if (!i.batters.length || !i.bowlers.length)
        throw new Error(`match ${m.matchId} innings ${i.number}: no batting or bowling rows`);
      i.batters.sort((a, b) => a.pos - b.pos);
    }
  }
  // The About sheet states how many matches the export holds: a mismatch = a truncated file.
  const about = wb.getWorksheet('About');
  if (about) {
    for (let r = 1; r <= about.rowCount; r++) {
      const row = about.getRow(r);
      if (cellText(row.getCell(1).value) !== 'Matches') continue;
      const stated = Number(cellText(row.getCell(2).value));
      if (Number.isFinite(stated) && stated !== matches.length)
        throw new Error(`About says ${stated} matches, the Matches sheet holds ${matches.length}`);
    }
  }
  return matches;
}

/** The wire's dismissal type from CSA "How out" text; absent while not out. Pure. */
export function dismissalOf(howOut: string): string | undefined {
  const h = howOut.trim().toLowerCase();
  if (!h || h === 'not out' || h === 'dnb' || h === 'did not bat') return undefined;
  if (h.startsWith('run out')) return 'run out';
  if (h.startsWith('lbw')) return 'lbw';
  if (h.startsWith('st ')) return 'stumped';
  if (h.startsWith('c ')) return 'caught';
  if (h.startsWith('b ')) return 'bowled';
  if (h.startsWith('hit wicket')) return 'hit wicket';
  if (h.startsWith('retired')) return h.includes('hurt') ? 'retired hurt' : 'retired out';
  return undefined;
}

/** The match's innings on the wire, each validated with InningsScorecardWireSchema. */
export function toInningsWire(m: WorkbookMatch): InningsScorecardWire[] {
  return m.innings.map((i) => {
    const extras = i.extras;
    return InningsScorecardWireSchema.parse({
      battingTeamName: i.battingTeam,
      totalRuns: i.runs,
      wickets: i.wickets,
      overs: i.overs,
      extras: {
        byes: extras.byes,
        legByes: extras.legByes,
        wides: extras.wides,
        noBalls: extras.noBalls,
        penalties: extras.penalties,
        total: extras.total,
      },
      batters: i.batters.map((b) => {
        const dismissal = dismissalOf(b.howOut);
        return {
          order: b.pos,
          name: b.name,
          runs: b.runs,
          ballsFaced: b.balls,
          fours: b.fours,
          sixes: b.sixes,
          strikeRate: b.strikeRate,
          howOut: b.howOut,
          ...(dismissal ? { dismissal } : {}),
        };
      }),
      bowlers: i.bowlers.map((b, n) => ({
        order: n + 1,
        name: b.name,
        overs: b.overs,
        maidens: b.maidens,
        runsConceded: b.runs,
        wickets: b.wickets,
        economy: b.economy,
        wides: b.wides,
        noBalls: b.noBalls,
      })),
      fallOfWickets: i.fallOfWickets.map((f) => ({
        wicket: f.wicket,
        runs: f.runs,
        overs: f.overs,
        batterName: f.batterName,
      })),
    });
  });
}

// ───────────────────────── Fixture matching ─────────────────────────

/**
 * Lowercase, punctuation stripped, "1st xi" / "cc" / "cricket club" and women('s) dropped
 * (the series already fixes the gender), whitespace collapsed. Pure.
 */
export function normaliseTeam(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b1st xi\b/g, ' ')
    .replace(/\bcricket club\b/g, ' ')
    .replace(/\b(cc|womens|women|ladies)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const aliased = (n: string, aliases: Record<string, string>) => aliases[n] ?? n;

/** `premier` / `premierWomen` from a workbook competition name. Pure. */
export const leagueKeyOf = (competition: string) =>
  /\bwom[ae]n/i.test(competition) ? PREMIER_LEAGUES.women : PREMIER_LEAGUES.men;

export interface PremierSeries {
  series: Series;
  leagueKey: string;
}

interface FixtureLike {
  id: string;
  date?: string;
  home?: string;
  away?: string;
}

export interface FixtureMatch {
  match: WorkbookMatch;
  seriesId: string;
  fixtureId: string;
  /** The Smart Club fixture's home side is the workbook's AWAY team. */
  swapped: boolean;
  homeName: string;
  awayName: string;
}

export interface MatchOutcome {
  matched: FixtureMatch[];
  errors: string[];
  warnings: string[];
}

/**
 * Pair each workbook match with exactly one fixture: same date, same league (by competition),
 * the two sides equal to the workbook's two teams in either order. Deterministic and pure.
 */
export function matchFixtures(
  matches: WorkbookMatch[],
  series: PremierSeries[],
  clubs: Pick<Club, 'id' | 'name'>[],
  aliases: Record<string, string> = TEAM_ALIASES,
): MatchOutcome {
  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  const sideNames = (s: Series, teamId: string | undefined) => {
    if (!teamId) return { label: '(none)', names: new Set<string>() };
    const p = s.participants?.find((x) => x.teamId === teamId);
    const club = clubName.get(p?.clubId ?? teamId);
    const names = new Set(
      [p?.name, club, p ? undefined : teamId]
        .filter((x): x is string => !!x)
        .map((x) => aliased(normaliseTeam(x), aliases)),
    );
    return { label: p?.name ?? club ?? teamId, names };
  };
  const dates = new Set(matches.map((m) => m.date));
  const candidates = series.flatMap(({ series: s, leagueKey }) =>
    (s.fixtures as FixtureLike[])
      .filter((f) => f?.id && f.date && dates.has(f.date))
      .map((f) => ({ s, leagueKey, f, home: sideNames(s, f.home), away: sideNames(s, f.away) })),
  );

  const matched: FixtureMatch[] = [];
  const errors: string[] = [];
  const claimed = new Map<string, string>();
  for (const m of matches) {
    const league = leagueKeyOf(m.competition);
    const h = aliased(normaliseTeam(m.home), aliases);
    const a = aliased(normaliseTeam(m.away), aliases);
    const hits = candidates.filter(
      (c) =>
        c.leagueKey === league &&
        c.f.date === m.date &&
        ((c.home.names.has(h) && c.away.names.has(a)) ||
          (c.home.names.has(a) && c.away.names.has(h))),
    );
    const what = `match ${m.matchId} ${m.home} v ${m.away} (${m.competition}, ${m.date})`;
    if (hits.length !== 1) {
      errors.push(
        hits.length
          ? `${what}: ${hits.length} candidate fixtures (${hits.map((c) => `${c.s.id}/${c.f.id}`).join(', ')})`
          : `${what}: no ${league} fixture on that date between "${h}" and "${a}" — add a TEAM_ALIASES entry`,
      );
      continue;
    }
    const c = hits[0];
    const key = `${c.s.id}/${c.f.id}`;
    const prior = claimed.get(key);
    if (prior) {
      errors.push(`${what}: fixture ${key} is already claimed by match ${prior}`);
      continue;
    }
    claimed.set(key, m.matchId);
    matched.push({
      match: m,
      seriesId: c.s.id,
      fixtureId: c.f.id,
      swapped: !(c.home.names.has(h) && c.away.names.has(a)),
      homeName: c.home.label,
      awayName: c.away.label,
    });
  }
  const warnings = candidates
    .filter((c) => !claimed.has(`${c.s.id}/${c.f.id}`))
    .map(
      (c) =>
        `${c.leagueKey} fixture ${c.s.id}/${c.f.id} ${c.home.label} v ${c.away.label} ` +
        `(${c.f.date}) has no workbook row (bye / washout?) — left alone`,
    );
  return { matched, errors, warnings };
}

// ───────────────────────── Run ─────────────────────────

type RepoModule = typeof import('../src/repo.js');

export interface ImportDeps {
  repo: RepoModule;
  log?: (l: string) => void;
  now?: () => Date;
}

async function rawDdb() {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  const { tableName } = await import('../src/env.js');
  const endpoint = process.env.DYNAMO_ENDPOINT;
  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient(
      endpoint
        ? {
            endpoint,
            region: 'localhost',
            credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
          }
        : {},
    ),
  );
  return { ddb, UpdateCommand, table: tableName() };
}

/** "UKZN 1st XI Won By 60 Runs" → "UKZN 1st XI won by 60 runs". Pure. */
export const resultSummaryOf = (result: string) =>
  result.replace(
    /\bWon By (\d+) (Runs?|Wickets?)\b/,
    (_, n, u) => `won by ${n} ${u.toLowerCase()}`,
  );

const lineOf = (i: InningsScorecardWire) =>
  `${i.battingTeamName} ${i.totalRuns}/${i.wickets} (${i.overs} ov)`;

export async function runImport(args: ImportArgs, deps: ImportDeps): Promise<number> {
  const { repo } = deps;
  const log = deps.log ?? console.log;
  const now = deps.now ?? (() => new Date());

  let matches: WorkbookMatch[];
  const wire = new Map<string, InningsScorecardWire[]>();
  try {
    matches = await readWorkbook(resolve(args.file));
    if (args.date) matches = matches.filter((m) => m.date === args.date);
    if (!matches.length) throw new Error(`no workbook match on ${args.date}`);
    for (const m of matches) {
      try {
        wire.set(m.matchId, toInningsWire(m));
      } catch (err) {
        throw new Error(`match ${m.matchId}: scorecard fails the wire schema — ${err}`);
      }
    }
  } catch (err) {
    log(`ERROR ${err instanceof Error ? err.message : err}`);
    log('nothing written');
    return 1;
  }

  if (!(await repo.getTenantConfig(args.tenant))) {
    log(`tenant "${args.tenant}" not found`);
    return 1;
  }
  // Series discovery: one gsi Query for the series, one GetItem per distinct season run.
  const dates = new Set(matches.map((m) => m.date));
  const runLeague = new Map<string, string | null>();
  const premier: PremierSeries[] = [];
  const wanted = new Set<string>(Object.values(PREMIER_LEAGUES));
  // Why a series on the workbook date(s) did NOT qualify — printed when nothing matches,
  // so a failed run says whether the gap is the date, the season run or the league key.
  const diag: string[] = [];
  for (const s of await repo.listSeries(args.tenant)) {
    if (args.seriesIds && !args.seriesIds.includes(s.id)) continue;
    const onDate = (s.fixtures as FixtureLike[]).some((f) => f?.date && dates.has(f.date));
    if (!onDate) continue;
    if (!s.seasonRunId) {
      // Imported ("plan B") series carry no season run: fall back to the series NAME —
      // "Premier League …" ⇒ premier, "Premier Women's League …" ⇒ premierWomen. Promotion
      // and EMCU names contain no "premier", so they stay out.
      const fromName = /\bpremier\b/i.test(s.name)
        ? /wom[ae]n/i.test(s.name)
          ? PREMIER_LEAGUES.women
          : PREMIER_LEAGUES.men
        : null;
      if (fromName) premier.push({ series: s, leagueKey: fromName });
      else diag.push(`  ${s.id} "${s.name}": fixture on the date(s) but NO seasonRunId`);
      continue;
    }
    if (!runLeague.has(s.seasonRunId))
      runLeague.set(
        s.seasonRunId,
        (await repo.getSeasonRun(args.tenant, s.seasonRunId))?.leagueKey ?? null,
      );
    const leagueKey = runLeague.get(s.seasonRunId);
    if (leagueKey && wanted.has(leagueKey)) premier.push({ series: s, leagueKey });
    else
      diag.push(
        `  ${s.id} "${s.name}": on the date(s), leagueKey=${leagueKey ?? '(season run not found)'}`,
      );
  }
  if (!premier.length) {
    log(`ERROR no ${[...wanted].join('/')} series has a fixture on ${[...dates].join(', ')}`);
    log(
      diag.length
        ? `series that DO have fixtures on the date(s):\n${diag.join('\n')}`
        : 'no series at all has a fixture on the date(s) — check the fixture dates in Smart Club',
    );
    log('nothing written');
    return 1;
  }
  if (args.seriesIds) {
    const missing = args.seriesIds.filter((id) => !premier.some((p) => p.series.id === id));
    if (missing.length) {
      log(
        `ERROR --series ${missing.join(', ')}: not a premier / premierWomen series with a ` +
          'fixture on the workbook date(s)',
      );
      log('nothing written');
      return 1;
    }
  }
  const clubs = await repo.listClubs(args.tenant);
  const outcome = matchFixtures(matches, premier, clubs);

  log(
    `${args.confirm ? 'CONFIRM' : 'DRY RUN'} tenant=${args.tenant} stage=${args.stage} ` +
      `matches=${matches.length} series=${premier.map((p) => `${p.series.id}(${p.leagueKey})`).join(',') || '(none)'}` +
      `${args.fillSummaries ? ' --fill-summaries' : ''}`,
  );
  for (const w of outcome.warnings) log(`WARN ${w}`);
  if (outcome.errors.length) {
    for (const e of outcome.errors) log(`ERROR ${e}`);
    log('nothing written');
    return 1;
  }

  const plan: Array<{
    fm: FixtureMatch;
    innings: InningsScorecardWire[];
    existing: StoredFixtureScorecard | null;
    reports: Awaited<ReturnType<RepoModule['listCaptainsReportsForFixture']>>;
  }> = [];
  for (const fm of outcome.matched) {
    const [existing, reports] = await Promise.all([
      repo.getFixtureScorecard(args.tenant, fm.seriesId, fm.fixtureId),
      repo.listCaptainsReportsForFixture(args.tenant, fm.seriesId, fm.fixtureId),
    ]);
    const innings = wire.get(fm.match.matchId)!;
    plan.push({ fm, innings, existing: existing ?? null, reports });
    const m = fm.match;
    log(
      `  match ${m.matchId} → ${fm.seriesId}/${fm.fixtureId} ${fm.homeName} v ${fm.awayName}` +
        `${fm.swapped ? ' (HOME/AWAY SWAPPED vs the workbook)' : ''}`,
    );
    for (const i of innings)
      log(
        `    ${lineOf(i)} — ${i.batters.length} batters, ${i.bowlers.length} bowlers, ${i.fallOfWickets.length} FOW`,
      );
    log(`    result: ${m.result || '(none)'}  link: ${m.link}`);
    log(
      `    stored card: ${
        existing
          ? `${existing.medicoachMatchId} available=${existing.available} fetchedAt=${existing.fetchedAt}`
          : '(none)'
      }`,
    );
    for (const r of reports)
      log(
        `    report ${r.side} ${r.clubName}: ${r.status} resultSummary=${r.resultSummary ?? '(none)'}`,
      );
    if (!reports.length) log('    reports: (none opened)');
  }

  const dir = args.backupDir ? resolve(args.backupDir) : DEFAULT_BACKUP_DIR;
  await mkdir(dir, { recursive: true });
  const file = join(
    dir,
    `csa-scorecards-backup-${args.tenant}-${now().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  await writeFile(
    file,
    JSON.stringify(
      {
        tenant: args.tenant,
        stage: args.stage,
        workbook: resolve(args.file),
        fixtures: plan.map((p) => ({
          seriesId: p.fm.seriesId,
          fixtureId: p.fm.fixtureId,
          csaMatchId: p.fm.match.matchId,
          scorecard: p.existing,
          reports: p.reports.map((r) => ({
            id: r.id,
            status: r.status,
            resultSummary: r.resultSummary ?? null,
          })),
        })),
      },
      null,
      2,
    ),
  );
  log(`backup: ${file}`);

  if (!args.confirm) {
    log(`DRY RUN done: ${plan.length} card(s) would be stored. Re-run with --confirm to write.`);
    return 0;
  }

  const fetchedAt = now().toISOString();
  const raw = args.fillSummaries ? await rawDdb() : null;
  const { captainsReportKey } = await import('../src/keys.js');
  let stored = 0;
  let unchanged = 0;
  let filled = 0;
  for (const { fm, innings, existing, reports } of plan) {
    // Deep equality, not stringify: a DynamoDB roundtrip may reorder object keys.
    const same = !!existing?.available && isDeepStrictEqual(existing.innings ?? null, innings);
    if (same) unchanged++;
    const card: StoredFixtureScorecard = {
      seriesId: fm.seriesId,
      fixtureId: fm.fixtureId,
      medicoachMatchId: `csa-${fm.match.matchId}`,
      medicoachTournamentId: `csa-${fm.match.tournamentId}`,
      schemaVersion: 1,
      // Unchanged content keeps its fetchedAt, so answers given against it never look stale.
      fetchedAt: same ? existing!.fetchedAt : fetchedAt,
      available: true,
      matchState: 'Complete',
      innings,
      terminal: true,
      sourceUrl: fm.match.link,
    };
    await repo.putFixtureScorecard(args.tenant, card);
    stored++;
    log(
      `  stored ${fm.seriesId}/${fm.fixtureId} (csa ${fm.match.matchId})` +
        `${same ? ' — content unchanged, fetchedAt kept' : ''}`,
    );
    if (!raw || !fm.match.result) continue;
    const summary = resultSummaryOf(fm.match.result);
    // --overwrite-summaries: named matches replace a WRONG existing summary (still pending-only)
    // — e.g. a mislinked medicoach result. Everything else only fills a missing one.
    const overwrite = args.overwriteSummaries?.includes(fm.match.matchId) ?? false;
    for (const r of reports) {
      try {
        await raw.ddb.send(
          new raw.UpdateCommand({
            TableName: raw.table,
            Key: captainsReportKey(args.tenant, r.seriesId, r.fixtureId, r.clubId),
            UpdateExpression: 'SET resultSummary = :s, updatedAt = :now',
            ConditionExpression:
              'attribute_exists(pk) AND #st = :pending' +
              (overwrite
                ? ' AND (attribute_not_exists(resultSummary) OR resultSummary <> :s)'
                : ' AND (attribute_not_exists(resultSummary) OR resultSummary = :null OR resultSummary = :empty)'),
            ExpressionAttributeNames: { '#st': 'status' },
            ExpressionAttributeValues: {
              ':s': summary,
              ':now': fetchedAt,
              ':pending': 'pending',
              ...(overwrite ? {} : { ':null': null, ':empty': '' }),
            },
          }),
        );
        filled++;
        log(
          `    resultSummary ${overwrite ? 'OVERWRITTEN' : 'set'} on ${r.side} ${r.clubName}: ${summary}`,
        );
      } catch (err) {
        if ((err as { name?: string })?.name !== 'ConditionalCheckFailedException') throw err;
      }
    }
  }
  log(
    `done: stored=${stored} (unchanged=${unchanged})` +
      `${args.fillSummaries ? ` summaries filled=${filled}` : ''}`,
  );
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let args: ImportArgs;
  try {
    args = parseImportArgs(argv);
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : err}\n${USAGE}`);
    return 1;
  }
  const actual = sstStage();
  if (actual !== args.stage) {
    console.error(`REFUSED: --stage=${args.stage} but sst shell stage is ${actual ?? '(none)'}`);
    return 1;
  }
  const repo = await import('../src/repo.js');
  return runImport(args, { repo });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((status) => process.exit(status))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
