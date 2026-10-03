/**
 * Weekly umpire appointments import — load the union's appointments workbook (e.g.
 * "KZNCU Umpires appointments Runner 3 - 4 October 2026") into per-fixture FIXOFFICIALS#
 * items. DRY-RUN by default:
 *
 *   npx sst shell --stage <stage> -- npx tsx src/import-umpire-appointments.ts \
 *     --tenant dolphins --file "<appointments xlsx>" --parse-only     # parse only, no repo
 *   … --tenant dolphins --file "<xlsx>"                               # dry run: match + report
 *   … --tenant dolphins --file "<xlsx>" --create-umpires              # dry run, plan new umpires
 *   … --tenant dolphins --file "<xlsx>" [--create-umpires] --confirm  # write
 *   npx tsx src/import-umpire-appointments.ts --tenant dolphins --file "<xlsx>" \
 *     --snapshot <planb-backup.json>                                  # match against a local
 *                                                                     # series dump, no AWS
 *
 * The sheet repeats a section per league, each with its own header row (`Ref | Month | Day |
 * Time | Date | Home Team | Away Team | Venue | [Referee] | Umpire | Umpire`). Column
 * positions differ between sections, so columns are mapped BY HEADER NAME per section. The
 * section's league is the label in the Ref column ("Premier league T20"); an unknown label
 * stops the run — the map below must be extended deliberately.
 *
 * Each row is matched to an existing fixture by league + date + UNORDERED team pair, with
 * the time used only to break a tie. Team names go through the fixture importers' shared
 * club resolution (club-name-resolve.ts) plus this sheet's own typo table. Fail-closed:
 * an unresolved, ambiguous or duplicated row is listed and NOT written; venue or time
 * differences are reported, never applied. Umpires resolve through the registry's
 * aliases; unknown names are listed and only created with --create-umpires.
 *
 * Idempotent: a re-run writes only appointments that differ ("0 changed" on a repeat).
 */
import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Club, FixtureOfficials, Series, Umpire } from './types.js';
import {
  buildClubIndex,
  normaliseClubName,
  resolveClub,
  stripLetterSuffix,
} from './club-name-resolve.js';
import { groundKey } from './venue-clash.js';
import {
  findUmpireDoubleBookings,
  MAX_UMPIRES_PER_FIXTURE,
  normaliseUmpireAlias,
  type UmpireBooking,
} from '../../engine/src/umpires.js';
import { applyUmpireInput, umpireIdFor } from './umpires.js';

// `./repo.js` (and its AWS SDK deps) is imported dynamically inside `main()` so the pure
// parser/matcher and their unit tests load without a table configured.

// ───────────────────────── Configuration ─────────────────────────

/** Which series a sheet section's rows can land in. */
export interface SectionLeague {
  /** Series `leagueKey`s searched for this section. */
  leagueKeys: string[];
  /** Only series of this format (T20 ⇒ 20 overs). */
  maxOvers: number;
}

/**
 * Sheet section label (normalised: lowercase, letters/digits/spaces only) → league. The
 * veterans T20 section covers both veterans divisions — the pair + date identifies the
 * series. An unlisted label is a hard stop.
 */
export const SECTION_LEAGUES: Record<string, SectionLeague> = {
  'premier league t20': { leagueKeys: ['premier'], maxOvers: 20 },
  'promotion league t20': { leagueKeys: ['promotion'], maxOvers: 20 },
  'womens premier league t20': { leagueKeys: ['premierWomen'], maxOvers: 20 },
  'veterans league t20': { leagueKeys: ['veterans-premier', 'veterans-promotion'], maxOvers: 20 },
};

/**
 * This sheet's spellings that the fixture importers' tables don't cover, as normal form →
 * normal form (club-name-resolve's `normaliseClubName`). Redirects only correct spelling;
 * the shared lookup still decides the club, so no club id is hard-coded here.
 */
export const APPOINTMENT_NAME_REDIRECTS: Record<string, string> = {
  amazimtoti: 'amanzimtoti', // "Amazimtoti" typo
  tongaatassoication: 'tongaat', // "Tongaat Cricket Assoication" typo
  acc: 'amanzimtoti', // "ACC" = Amanzimtoti CC (Premier, at Toti Oval 1)
};

export const normaliseSectionLabel = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// ───────────────────────── Parser ─────────────────────────

/** One appointment row off the sheet, trimmed. */
export interface AppointmentRow {
  /** 1-based worksheet row, for the report. */
  sheetRow: number;
  /** The section label as written (trimmed), e.g. "Premier league T20". */
  section: string;
  /** ISO date (YYYY-MM-DD), from Month (1st of the month) + Date (day number). */
  date: string;
  /** HH:MM local (Africa/Johannesburg) start, when the row has one. */
  time?: string;
  /** Kick-off as an ISO instant in SAST (UTC+02:00, no daylight saving). */
  kickoff?: string;
  home: string;
  away: string;
  venue: string;
  referee?: string;
  /** Umpire names in sheet order (empty cells dropped). */
  umpires: string[];
}

export interface ParseResult {
  sheet: string;
  rows: AppointmentRow[];
  /** Rows that looked like fixtures but couldn't be read (bad date etc.), never written. */
  problems: string[];
}

/** The header names this parser maps, normalised. */
type Column = 'ref' | 'month' | 'day' | 'time' | 'date' | 'home' | 'away' | 'venue' | 'referee';

const HEADER_NAMES: Record<string, Column> = {
  ref: 'ref',
  refno: 'ref',
  month: 'month',
  day: 'day',
  time: 'time',
  date: 'date',
  hometeam: 'home',
  awayteam: 'away',
  venue: 'venue',
  referee: 'referee',
};

const headerKey = (v: unknown) =>
  cellText(v)
    .toLowerCase()
    .replace(/[^a-z]+/g, '');

/** Text of a cell: rich text joined, formula results unwrapped, always trimmed. */
export function cellText(v: unknown): string {
  if (v == null || v instanceof Date) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText))
      return (o.richText as Array<{ text: string }>)
        .map((r) => r.text)
        .join('')
        .trim();
    if ('result' in o) return cellText(o.result);
    if (typeof o.text === 'string') return o.text.trim();
    return '';
  }
  return String(v).replace(/\s+/g, ' ').trim();
}

const unwrap = (v: unknown): unknown =>
  v && typeof v === 'object' && !(v instanceof Date) && 'result' in (v as object)
    ? (v as { result: unknown }).result
    : v;

const pad = (n: number) => String(n).padStart(2, '0');

/** A time cell: a 1899-epoch Date (exceljs, wall clock in UTC fields), a fraction of a
 * day, or "HH:MM" text. */
export function cellTime(raw: unknown): string | undefined {
  const v = unwrap(raw);
  if (v instanceof Date) {
    if (v.getUTCFullYear() >= 1970) return undefined;
    return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
  }
  if (typeof v === 'number' && v >= 0 && v < 1) {
    const mins = Math.round(v * 24 * 60);
    return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
  }
  const m = cellText(v).match(/^(\d{1,2})[:h.](\d{2})/i);
  return m ? `${pad(Number(m[1]))}:${m[2]}` : undefined;
}

/** Year + month from the Month cell: a Date on the 1st (or any day) of the month. */
function cellYearMonth(raw: unknown): { y: number; m: number } | undefined {
  const v = unwrap(raw);
  if (v instanceof Date && v.getUTCFullYear() >= 1970)
    return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1 };
  const t = cellText(v).match(/^(\d{4})-(\d{2})/);
  return t ? { y: Number(t[1]), m: Number(t[2]) } : undefined;
}

/** The fixture date: Month (year+month) + Date (day number). A full date in the Date
 * column wins on its own. */
export function rowDate(monthCell: unknown, dateCell: unknown): string | undefined {
  const d = unwrap(dateCell);
  if (d instanceof Date && d.getUTCFullYear() >= 1970) return d.toISOString().slice(0, 10);
  const ym = cellYearMonth(monthCell);
  const day = typeof d === 'number' ? d : Number(cellText(d));
  if (!ym || !Number.isInteger(day) || day < 1 || day > 31) return undefined;
  const probe = new Date(Date.UTC(ym.y, ym.m - 1, day));
  if (probe.getUTCMonth() !== ym.m - 1) return undefined; // e.g. 31 September
  return `${ym.y}-${pad(ym.m)}-${pad(day)}`;
}

/**
 * Parse every sheet section: find each header row (it has a "Home Team" cell), map its
 * columns by name, and read the rows below it until the next header. Every value is
 * trimmed. A row needs both teams to count; one with teams but no readable date is a
 * problem (listed, never written).
 */
export function parseAppointmentsWorkbook(wb: ExcelJS.Workbook): ParseResult {
  const ws = wb.worksheets.find((w) => /runner|appointment/i.test(w.name)) ?? wb.worksheets[0];
  if (!ws) throw new Error('the workbook has no sheets');
  const rows: AppointmentRow[] = [];
  const problems: string[] = [];
  let cols: Partial<Record<Column, number>> | null = null;
  let umpireCols: number[] = [];
  let section = '';

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values: unknown[] = [];
    for (let c = 1; c <= Math.max(row.cellCount, 12); c++) values[c] = row.getCell(c).value;

    // Header row: any cell reading "Home Team".
    if (values.some((v) => headerKey(v) === 'hometeam')) {
      cols = {};
      umpireCols = [];
      values.forEach((v, c) => {
        const k = headerKey(v);
        if (k === 'umpire' || k === 'umpires') umpireCols.push(c);
        else if (HEADER_NAMES[k] && cols![HEADER_NAMES[k]] === undefined)
          cols![HEADER_NAMES[k]] = c;
      });
      if (!cols.home || !cols.away)
        throw new Error(`row ${rowNumber}: header has no Home Team / Away Team column`);
      return;
    }
    if (!cols) return; // title rows above the first header
    const c = cols as Partial<Record<Column, number>>;
    const get = (k: Column) => (c[k] ? values[c[k]!] : undefined);
    const home = cellText(get('home'));
    const away = cellText(get('away'));
    if (!home && !away) return; // blank / stray cells (e.g. a lone page number)
    const label = cellText(get('ref'));
    if (label) section = label;
    if (!home || !away) {
      problems.push(`row ${rowNumber}: only one team (${home || '—'} v ${away || '—'})`);
      return;
    }
    const date = rowDate(get('month'), get('date'));
    if (!date) {
      problems.push(`row ${rowNumber}: ${home} v ${away} — no readable date`);
      return;
    }
    const time = cellTime(get('time'));
    const referee = cellText(get('referee'));
    rows.push({
      sheetRow: rowNumber,
      section,
      date,
      ...(time ? { time, kickoff: `${date}T${time}:00+02:00` } : {}),
      home,
      away,
      venue: cellText(get('venue')),
      ...(referee ? { referee } : {}),
      umpires: umpireCols.map((col) => cellText(values[col])).filter(Boolean),
    });
  });
  return { sheet: ws.name, rows, problems };
}

/** Every section label the rows use that SECTION_LEAGUES doesn't know. */
export function unknownSections(rows: AppointmentRow[]): string[] {
  return [
    ...new Set(
      rows.map((r) => r.section).filter((s) => !SECTION_LEAGUES[normaliseSectionLabel(s)]),
    ),
  ];
}

// ───────────────────────── Matcher ─────────────────────────

/** A sheet team name resolved to a club, plus its lettered side if the sheet gave one. */
export interface ResolvedTeam {
  clubId: string;
  /** 0 for "A", 1 for "B", … ; undefined when the sheet name carries no letter. */
  side?: number;
}

const redirect = (name: string): string => {
  const n = normaliseClubName(name);
  return APPOINTMENT_NAME_REDIRECTS[n] ?? name;
};

/** Resolve a sheet team name through the shared club resolution + this sheet's redirects. */
export function resolveSheetTeam(
  raw: string,
  clubs: Club[],
  byNorm: Map<string, Club>,
): ResolvedTeam | undefined {
  const direct = resolveClub(redirect(raw), clubs, byNorm);
  if (direct) return { clubId: direct.id };
  const suffix = stripLetterSuffix(raw);
  if (!suffix) return undefined;
  const club = resolveClub(redirect(suffix.base), clubs, byNorm);
  if (!club) return undefined;
  return { clubId: club.id, side: suffix.letter.charCodeAt(0) - 'A'.charCodeAt(0) };
}

/** A fixture side's club + lettered index (`tm_<club>_<league>_<i>`), from the series. */
function sideOf(series: Series, teamId: unknown): ResolvedTeam | undefined {
  if (typeof teamId !== 'string' || !teamId) return undefined;
  const p = (series.participants ?? []).find((x) => x.teamId === teamId);
  const clubId = p?.clubId ?? teamId;
  const m = teamId.startsWith('tm_') ? teamId.match(/_(\d+)$/) : null;
  return { clubId, ...(m ? { side: Number(m[1]) } : {}) };
}

/** A plain sheet name matches the club's plain or A side; "X A" matches A or plain. */
function sameTeam(sheet: ResolvedTeam, fixtureSide: ResolvedTeam | undefined): boolean {
  if (!fixtureSide || sheet.clubId !== fixtureSide.clubId) return false;
  const a = sheet.side ?? 0;
  const b = fixtureSide.side ?? 0;
  return a === b;
}

interface FixtureLite {
  id: string;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  venueName?: string;
  venueOverride?: string;
  [key: string]: unknown;
}

export interface MatchedRow {
  row: AppointmentRow;
  seriesId: string;
  seriesName: string;
  fixtureId: string;
  fixture: FixtureLite;
  /** Human notes: time tie-break, time/venue differences (reported, never applied). */
  notes: string[];
}

export interface UnmatchedRow {
  row: AppointmentRow;
  kind: 'unknown-team' | 'no-fixture' | 'ambiguous' | 'duplicate';
  reason: string;
}

export interface MatchResult {
  matched: MatchedRow[];
  unmatched: UnmatchedRow[];
}

const fixtureVenue = (s: Series, f: FixtureLite): string => {
  if (f.venueOverride) return f.venueOverride;
  if (f.venueName) return f.venueName;
  const home = (s.participants ?? []).find((p) => p.teamId === f.home);
  return home?.venue ?? '';
};

const label = (r: AppointmentRow) =>
  `row ${r.sheetRow} ${r.section} ${r.date}${r.time ? ` ${r.time}` : ''} ${r.home} v ${r.away}`;

/**
 * Match every parsed row to one fixture. Unknown sections must already have been rejected
 * (see `unknownSections`). Rows that resolve to the same fixture are all reported as
 * duplicates and none is matched — one of them is wrong and the sheet must say which.
 */
export function matchAppointments(
  rows: AppointmentRow[],
  allSeries: Series[],
  clubs: Club[],
): MatchResult {
  const byNorm = buildClubIndex(clubs);
  const matched: MatchedRow[] = [];
  const unmatched: UnmatchedRow[] = [];

  for (const row of rows) {
    const league = SECTION_LEAGUES[normaliseSectionLabel(row.section)];
    if (!league) throw new Error(`unknown section "${row.section}" (row ${row.sheetRow})`);
    const home = resolveSheetTeam(row.home, clubs, byNorm);
    const away = resolveSheetTeam(row.away, clubs, byNorm);
    if (!home || !away) {
      const missing = [!home && row.home, !away && row.away].filter(Boolean).join(', ');
      unmatched.push({ row, kind: 'unknown-team', reason: `no club for: ${missing}` });
      continue;
    }
    const inLeague = allSeries.filter(
      (s) =>
        league.leagueKeys.includes(String(s.leagueKey ?? '')) &&
        (s.maxOvers === league.maxOvers ||
          (s.maxOvers === undefined && /\bt20\b/i.test(String(s.name)))),
    );
    const pairMatches = (s: Series, f: FixtureLite) => {
      const h = sideOf(s, f.home);
      const a = sideOf(s, f.away);
      return (sameTeam(home, h) && sameTeam(away, a)) || (sameTeam(home, a) && sameTeam(away, h));
    };
    const pairFixtures = inLeague.flatMap((s) =>
      ((s.fixtures ?? []) as FixtureLite[]).filter((f) => pairMatches(s, f)).map((f) => ({ s, f })),
    );
    let candidates = pairFixtures.filter(({ f }) => f.date === row.date);
    const notes: string[] = [];
    if (candidates.length > 1 && row.time) {
      const byTime = candidates.filter(({ f }) => f.time === row.time);
      if (byTime.length === 1) notes.push(`tie broken by time ${row.time}`);
      candidates = byTime.length ? byTime : candidates;
    }
    if (candidates.length === 0) {
      const elsewhere = [...new Set(pairFixtures.map(({ f, s }) => `${f.date} (${s.id})`))];
      unmatched.push({
        row,
        kind: 'no-fixture',
        reason: elsewhere.length
          ? `no fixture for this pair on ${row.date}; it plays on ${elsewhere.slice(0, 4).join(', ')}`
          : `no fixture for this pair in ${league.leagueKeys.join('/')} T20 series`,
      });
      continue;
    }
    if (candidates.length > 1) {
      unmatched.push({
        row,
        kind: 'ambiguous',
        reason: `${candidates.length} fixtures fit: ${candidates
          .map(({ s, f }) => `${s.id}/${f.id} ${f.time ?? ''}`.trim())
          .join(', ')}`,
      });
      continue;
    }
    const { s, f } = candidates[0];
    if (row.time && f.time && row.time !== f.time)
      notes.push(`time differs: sheet ${row.time}, fixture ${f.time} (not changed)`);
    if (row.time && !f.time)
      notes.push(`fixture has no time; sheet says ${row.time} (not changed)`);
    const venue = fixtureVenue(s, f);
    if (row.venue && (!venue || groundKey(row.venue) !== groundKey(venue)))
      notes.push(`venue differs: sheet "${row.venue}", fixture "${venue || '—'}" (not changed)`);
    matched.push({
      row,
      seriesId: s.id,
      seriesName: String(s.name),
      fixtureId: f.id,
      fixture: f,
      notes,
    });
  }

  // Two rows on one fixture: report both, write neither.
  const byFixture = new Map<string, MatchedRow[]>();
  for (const m of matched) {
    const k = `${m.seriesId}#${m.fixtureId}`;
    byFixture.set(k, [...(byFixture.get(k) ?? []), m]);
  }
  const kept: MatchedRow[] = [];
  for (const group of byFixture.values()) {
    if (group.length === 1) kept.push(group[0]);
    else
      for (const m of group)
        unmatched.push({
          row: m.row,
          kind: 'duplicate',
          reason: `${group.length} sheet rows map to ${m.seriesId}/${m.fixtureId} (rows ${group
            .map((g) => g.row.sheetRow)
            .join(', ')})`,
        });
  }
  kept.sort((a, b) => a.row.sheetRow - b.row.sheetRow);
  unmatched.sort((a, b) => a.row.sheetRow - b.row.sheetRow);
  return { matched: kept, unmatched };
}

// ───────────────────────── Umpires + write plan ─────────────────────────

/** Sheet umpire names → registry entries by alias. Unknown names come back separately. */
export function resolveUmpireNames(
  names: string[],
  registry: Umpire[],
): { byName: Map<string, Umpire>; unknown: string[] } {
  const byAlias = new Map<string, Umpire>();
  for (const u of registry) {
    if (!u.active) continue;
    for (const a of u.aliases ?? []) byAlias.set(a, u);
  }
  const byName = new Map<string, Umpire>();
  const unknown = new Set<string>();
  for (const name of names) {
    const u = byAlias.get(normaliseUmpireAlias(name));
    if (u) byName.set(name, u);
    else unknown.add(name);
  }
  return { byName, unknown: [...unknown] };
}

/**
 * Registry entries to create for unknown names, one per distinct alias ("V.Surujbally" and
 * "V.Surujbally " are one person). Ids avoid every id already taken.
 */
export function planNewUmpires(unknown: string[], registry: Umpire[], at: string): Umpire[] {
  const taken = new Set(registry.map((u) => u.id));
  const seen = new Set<string>();
  const out: Umpire[] = [];
  for (const name of unknown) {
    const alias = normaliseUmpireAlias(name);
    if (!alias || seen.has(alias)) continue;
    seen.add(alias);
    let id = umpireIdFor(name);
    for (let n = 2; taken.has(id); n++) id = `${umpireIdFor(name)}-${n}`;
    taken.add(id);
    out.push(applyUmpireInput(undefined, { displayName: name.trim() }, id, at));
  }
  return out;
}

export type WriteAction = 'new' | 'changed' | 'unchanged';

export interface PlannedWrite {
  match: MatchedRow;
  officials: FixtureOfficials;
  action: WriteAction;
  /** The appointment being replaced, for the report. */
  previous?: string[];
}

export interface WritePlan {
  writes: PlannedWrite[];
  /** Matched rows not written because an umpire is unknown (and not being created). */
  skipped: Array<{ match: MatchedRow; reason: string }>;
}

const sameOfficials = (a: FixtureOfficials | null | undefined, b: FixtureOfficials): boolean =>
  !!a &&
  a.umpires.map((u) => u.umpireId).join('|') === b.umpires.map((u) => u.umpireId).join('|') &&
  (a.referee?.umpireId ?? '') === (b.referee?.umpireId ?? '');

/**
 * Turn matched rows into FIXOFFICIALS writes. `existing` is the stored appointment per
 * `seriesId#fixtureId`; an identical one is `unchanged` (no write), which is what makes a
 * re-run report "0 changed". A fixture takes at most two umpires (the API refuses a third),
 * so a row naming more is listed as skipped, never truncated: dropping a name would
 * silently lose an appointment.
 */
export function planWrites(
  matched: MatchedRow[],
  byName: Map<string, Umpire>,
  existing: Map<string, FixtureOfficials>,
): WritePlan {
  const writes: PlannedWrite[] = [];
  const skipped: WritePlan['skipped'] = [];
  for (const m of matched) {
    const names = m.row.umpires;
    if (names.length > MAX_UMPIRES_PER_FIXTURE) {
      skipped.push({
        match: m,
        reason: `${names.length} umpires on the sheet; a fixture takes at most ${MAX_UMPIRES_PER_FIXTURE}`,
      });
      continue;
    }
    const missing = names.filter((n) => !byName.has(n));
    if (m.row.referee && !byName.has(m.row.referee)) missing.push(m.row.referee);
    if (missing.length) {
      skipped.push({ match: m, reason: `unknown umpire: ${missing.join(', ')}` });
      continue;
    }
    const ids: string[] = [];
    const umpires = names
      .map((n) => byName.get(n)!)
      .filter((u) => (ids.includes(u.id) ? false : (ids.push(u.id), true)))
      .map((u) => ({ umpireId: u.id, name: u.displayName }));
    const ref = m.row.referee ? byName.get(m.row.referee) : undefined;
    const officials: FixtureOfficials = {
      umpires,
      ...(ref ? { referee: { umpireId: ref.id, name: ref.displayName } } : {}),
    };
    const prev = existing.get(`${m.seriesId}#${m.fixtureId}`);
    const action: WriteAction = sameOfficials(prev, officials)
      ? 'unchanged'
      : prev && (prev.umpires.length || prev.referee)
        ? 'changed'
        : 'new';
    writes.push({
      match: m,
      officials,
      action,
      ...(action === 'changed' ? { previous: prev!.umpires.map((u) => u.name) } : {}),
    });
  }
  return { writes, skipped };
}

/** Same umpire at two different grounds with overlapping times, among the sheet's rows. */
export function sheetDoubleBookings(writes: PlannedWrite[]) {
  const bookings: UmpireBooking[] = writes.flatMap((w) =>
    w.officials.umpires.map((u) => ({
      umpireId: u.umpireId,
      seriesId: w.match.seriesId,
      fixtureId: w.match.fixtureId,
      date: w.match.row.date,
      time: w.match.row.time,
      venue: w.match.row.venue,
    })),
  );
  return findUmpireDoubleBookings(bookings);
}

/** Synthesise the club list from series participants (for `--snapshot` runs, no repo). */
export function clubsFromSeries(series: Series[]): Club[] {
  const byId = new Map<string, Club>();
  for (const s of series) {
    for (const p of s.participants ?? []) {
      if (byId.has(p.clubId) && p.teamId !== p.clubId) continue;
      const name = p.teamId === p.clubId ? p.name : p.name.replace(/\s+[A-C]$/, '');
      byId.set(p.clubId, { id: p.clubId, name } as Club);
    }
  }
  return [...byId.values()];
}

// ───────────────────────── CLI ─────────────────────────

export interface Args {
  tenant: string;
  file: string;
  parseOnly: boolean;
  confirm: boolean;
  createUmpires: boolean;
  snapshot: string;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    tenant: '',
    file: '',
    parseOnly: false,
    confirm: false,
    createUmpires: false,
    snapshot: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant') args.tenant = (argv[++i] ?? '').trim();
    else if (a === '--file') args.file = argv[++i] ?? '';
    else if (a === '--parse-only') args.parseOnly = true;
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--create-umpires') args.createUmpires = true;
    else if (a === '--snapshot') args.snapshot = argv[++i] ?? '';
    else throw new Error(`unknown flag ${a}`);
  }
  if (!args.file) throw new Error('--file <appointments xlsx> is required');
  if (!args.parseOnly && !args.tenant) throw new Error('--tenant <slug> is required');
  if (args.snapshot && args.confirm)
    throw new Error('--snapshot is a read-only rehearsal; it cannot be combined with --confirm');
  if (args.parseOnly && args.confirm) throw new Error('--parse-only never writes; drop --confirm');
  return args;
}

function printParse(p: ParseResult) {
  console.log(`Sheet "${p.sheet}": ${p.rows.length} appointment rows`);
  const bySection = new Map<string, AppointmentRow[]>();
  for (const r of p.rows) bySection.set(r.section, [...(bySection.get(r.section) ?? []), r]);
  for (const [section, rows] of bySection) {
    console.log(`\n  ${section} — ${rows.length} fixture(s)`);
    for (const r of rows)
      console.log(
        `    r${r.sheetRow} ${r.date} ${r.time ?? '--:--'}  ${r.home} v ${r.away} @ ${r.venue || '—'}  [${r.umpires.join(', ') || 'no umpire'}]`,
      );
  }
  const two = p.rows.filter((r) => r.umpires.length >= 2).length;
  const names = new Set(p.rows.flatMap((r) => r.umpires.map(normaliseUmpireAlias)));
  console.log(
    `\n  ${two} fixture(s) with two umpires, ${p.rows.length - two} with one or none; ${names.size} distinct umpire(s)`,
  );
  for (const pr of p.problems) console.log(`  ! ${pr}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(args.file);
  const parsed = parseAppointmentsWorkbook(wb);
  printParse(parsed);
  const unknown = unknownSections(parsed.rows);
  if (unknown.length) {
    console.error(
      `\nUnknown section label(s): ${unknown.map((u) => `"${u}"`).join(', ')}. Add them to SECTION_LEAGUES first.`,
    );
    process.exitCode = 1;
    return;
  }
  if (args.parseOnly) return;

  type RepoModule = typeof import('./repo.js');
  let repo: RepoModule | null = null;
  let series: Series[];
  let clubs: Club[];
  let registry: Umpire[] = [];
  const existing = new Map<string, FixtureOfficials>();
  if (args.snapshot) {
    series = JSON.parse(await readFile(args.snapshot, 'utf8')) as Series[];
    clubs = clubsFromSeries(series);
    console.log(`\nSnapshot ${args.snapshot}: ${series.length} series (no registry, no writes)`);
  } else {
    repo = await import('./repo.js');
    [series, clubs, registry] = await Promise.all([
      repo.listSeries(args.tenant),
      repo.listClubs(args.tenant),
      repo.listUmpires(args.tenant),
    ]);
    for (const o of await repo.listFixtureOfficials(args.tenant))
      existing.set(`${o.seriesId}#${o.fixtureId}`, o);
  }

  const { matched, unmatched } = matchAppointments(parsed.rows, series, clubs);
  console.log(`\nMatched ${matched.length} of ${parsed.rows.length} rows`);
  for (const m of matched)
    if (m.notes.length)
      console.log(`  ~ ${label(m.row)} → ${m.seriesId}/${m.fixtureId}: ${m.notes.join('; ')}`);
  if (unmatched.length) {
    console.log(`\nNot matched (${unmatched.length}) — these rows are NOT written:`);
    for (const u of unmatched) console.log(`  ✗ ${label(u.row)} — ${u.kind}: ${u.reason}`);
  }

  const allNames = [
    ...new Set(
      matched.flatMap((m) => [...m.row.umpires, ...(m.row.referee ? [m.row.referee] : [])]),
    ),
  ];
  let { byName, unknown: unknownNames } = resolveUmpireNames(allNames, registry);
  const toCreate = args.createUmpires
    ? planNewUmpires(unknownNames, registry, new Date().toISOString())
    : [];
  if (unknownNames.length) {
    console.log(
      `\nUnknown umpire(s) (${unknownNames.length}): ${unknownNames.join(', ')}` +
        (args.createUmpires
          ? `\n  → ${args.confirm ? 'creating' : 'would create'} ${toCreate.length}: ${toCreate.map((u) => `${u.displayName} (${u.id})`).join(', ')}`
          : '\n  Rows naming them are skipped. Add them in the Umpires page, or re-run with --create-umpires.'),
    );
    if (args.createUmpires)
      ({ byName, unknown: unknownNames } = resolveUmpireNames(allNames, [
        ...registry,
        ...toCreate,
      ]));
  }

  const plan = planWrites(matched, byName, existing);
  const count = (a: WriteAction) => plan.writes.filter((w) => w.action === a).length;
  for (const w of plan.writes.filter((x) => x.action === 'changed'))
    console.log(
      `  ↻ ${label(w.match.row)}: ${w.previous!.join(', ') || '—'} → ${w.officials.umpires.map((u) => u.name).join(', ')}`,
    );
  for (const s of plan.skipped) console.log(`  – ${label(s.match.row)} skipped: ${s.reason}`);
  const doubles = sheetDoubleBookings(plan.writes);
  for (const d of doubles)
    console.log(
      `  ⚠ ${d.a.umpireId} on ${d.date}: ${d.a.venue} ${d.a.time ?? ''} and ${d.b.venue} ${d.b.time ?? ''} overlap`,
    );

  console.log(
    `\nSummary: ${parsed.rows.length} rows · ${matched.length} matched · ${unmatched.length} not matched · ` +
      `${plan.skipped.length} skipped (see above) · ${count('new')} new · ${count('changed')} changed · ` +
      `${count('unchanged')} unchanged · ${toCreate.length} umpire(s) to create · ${doubles.length} double-booking warning(s)`,
  );

  if (!args.confirm || !repo) {
    console.log('\nDry run — nothing written. Re-run with --confirm to write.');
    return;
  }
  const at = new Date().toISOString();
  for (const u of toCreate) await repo.createUmpire(args.tenant, u);
  let written = 0;
  for (const w of plan.writes) {
    if (w.action === 'unchanged') continue;
    await repo.putFixtureOfficials(args.tenant, w.match.seriesId, w.match.fixtureId, {
      ...w.officials,
      updatedAt: at,
      updatedBy: 'import-umpire-appointments',
    });
    written++;
  }
  console.log(`\nWrote ${written} appointment(s); created ${toCreate.length} umpire(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
