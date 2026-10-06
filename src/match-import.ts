/**
 * The match library's one way in: every supported export is read into the same standard
 * match (the scouting match shape, plus where it came from), paired with the other export of
 * the same game, checked against what's already there, and only then saved. Pure — it runs in
 * the browser so the operator sees exactly what an upload will do before anything is stored.
 *
 * Supported files (detected from their content, not their name):
 *   - "Scorecard CSV": batting, bowling and fall of wickets per innings (pro-scorecards.ts).
 *   - "Ball by Ball": one row per delivery (match_id, competition, date, innings_no, …).
 *   - A standard match file (JSON) exported from the library.
 *
 * A scorecard is the official record of the cards; ball-by-ball adds every delivery (overs,
 * phases, spells). When both arrive for one game they are merged into one match, and any
 * difference between their totals is reported, never silently "fixed".
 */
import {
  csvRows,
  oversToBalls,
  parseScorecard,
  seasonOf,
  shortTeam,
  type Gender,
  type ProFormat,
  type ProMatch,
} from './pro-scorecards';
import type { ScoutBatRow, ScoutBowlRow, ScoutInnings } from './scouting-matches';

export const STANDARD_VERSION = 1;

export type SourceKind = 'scorecard' | 'ball-by-ball';

export interface LibraryMatch extends ProMatch {
  /** Stable library key: date, teams, gender (and a number for a second game that day). */
  key: string;
  v: number;
  competition?: string;
  /** The export's own match id, when it has one. */
  externalId?: string;
  sources: { kind: SourceKind; name: string }[];
  hasBalls: boolean;
}

export type FileKind = SourceKind | 'standard' | 'unknown';

export interface ReadFile {
  name: string;
  kind: FileKind;
  matches: ProMatch[];
  meta?: { competition?: string; externalId?: string };
  error?: string;
}

/* ─── Detecting and reading files ─── */

export function detectKind(text: string): FileKind {
  const head = text.replace(/^\uFEFF/, '').slice(0, 400);
  if (/^\s*[[{]/.test(head)) return 'standard';
  if (/^"?match_id"?,"?competition"?,"?date"?/i.test(head)) return 'ball-by-ball';
  if (/"MATCH INFO"/.test(head)) return 'scorecard';
  return 'unknown';
}

export function readFile(name: string, text: string): ReadFile {
  const kind = detectKind(text);
  try {
    if (kind === 'scorecard') {
      const m = parseScorecard(text, name.replace(/\.csv$/i, ''));
      return m
        ? { name, kind, matches: [m] }
        : { name, kind, matches: [], error: 'No innings found in this scorecard.' };
    }
    if (kind === 'ball-by-ball') {
      const r = parseBallByBall(text, name);
      return r
        ? {
            name,
            kind,
            matches: [r.match],
            meta: { competition: r.competition, externalId: r.externalId },
          }
        : { name, kind, matches: [], error: 'No deliveries found in this file.' };
    }
    if (kind === 'standard') {
      const raw = JSON.parse(text);
      const list = (Array.isArray(raw) ? raw : [raw]).filter(
        (m) => m && typeof m === 'object' && typeof m.date === 'string' && Array.isArray(m.innings),
      );
      if (!list.length) return { name, kind, matches: [], error: 'No matches in this file.' };
      return { name, kind, matches: list as ProMatch[] };
    }
  } catch (e) {
    return {
      name,
      kind,
      matches: [],
      error: e instanceof Error ? e.message : 'Could not read this file.',
    };
  }
  return {
    name,
    kind: 'unknown',
    matches: [],
    error: 'Not a scorecard, ball-by-ball or standard match file.',
  };
}

/* ─── Ball by ball ─── */

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** "27 Sept 2024" / "2024-09-27" → "2024-09-27". */
export function isoDate(s: string): string {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(t);
  if (!m) return '';
  const mon = MONTHS[m[2].toLowerCase().slice(0, 4)] ?? MONTHS[m[2].toLowerCase().slice(0, 3)];
  return mon ? `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}

/** "Ann Hawk (WK)" → "Ann Hawk" (the role tags aren't part of the name). */
export const cleanName = (n: string) =>
  n
    .replace(/\s*\((?:wk|c)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Format from the competition's name, else from how long the innings were. */
export function formatFromCompetition(competition: string | undefined): ProFormat | null {
  const c = (competition ?? '').toLowerCase();
  if (/pro\s?20|t20|twenty/.test(c)) return 'T20';
  if (/pro\s?50|one[\s-]?day|1\s?day|50[\s-]?over|list a/.test(c)) return 'One-Day';
  if (/4[\s-]?day|first[\s-]?class|1st[\s-]?class|multi[\s-]?day/.test(c)) return 'Multi-day';
  return null;
}

interface Delivery {
  over: number; // 0-based, as exported
  ball: number;
  batter: string;
  bowler: string;
  bat: number; // runs off the bat
  extra: '' | 'wd' | 'nb' | 'lb' | 'b';
  extraRuns: number;
  wicket: boolean;
  legal: boolean;
  commentary: string;
}

/** One delivery's outcome code ("●", "4", "2wd", "nb+4", "1lb", "W", "1W", "wd+W", "1?"). */
export function readOutcome(
  outcome: string,
  runsCol: string,
  extraCol: string,
  wicketCol: string,
  commentary: string,
) {
  const o = outcome.trim();
  let bat = 0;
  let extra: Delivery['extra'] = '';
  let extraRuns = 0;
  let m: RegExpExecArray | null;
  if (o === '●' || o === '' || o === '.') bat = 0;
  else if ((m = /^(\d+)$/.exec(o))) bat = Number(m[1]);
  else if ((m = /^(\d+)wd$/.exec(o))) {
    extra = 'wd';
    extraRuns = Number(m[1]);
  } else if ((m = /^(\d+)lb$/.exec(o))) {
    extra = 'lb';
    extraRuns = Number(m[1]);
  } else if ((m = /^(\d+)b$/.exec(o))) {
    extra = 'b';
    extraRuns = Number(m[1]);
  } else if (o === 'nb') {
    extra = 'nb';
    extraRuns = Math.max(1, Number(runsCol) || 1);
  } else if ((m = /^nb\+(\d+)$/.exec(o))) {
    extra = 'nb';
    extraRuns = 1;
    bat = Number(m[1]);
  } else if ((m = /^(\d+)W$/.exec(o))) bat = Number(m[1]);
  else if ((m = /^(\d+)\?$/.exec(o))) bat = Number(m[1]);
  else if (/^wd\+W$/.test(o)) {
    extra = 'wd';
    extraRuns = 1;
  } else if (o !== 'W') bat = Number(runsCol) || 0;
  if (!extra && extraCol && /^(wd|nb|lb|b)$/.test(extraCol)) {
    // Trust the column when the code didn't say (older exports).
    extra = extraCol as Delivery['extra'];
    extraRuns = extraRuns || Number(runsCol) || 0;
    bat = 0;
  }
  const wicket = /W/.test(o) || wicketCol === '1' || /\bOUT!/.test(commentary);
  return { bat, extra, extraRuns, wicket, legal: extra !== 'wd' && extra !== 'nb' };
}

/** "OUT! Caught, Jane Doe (WK) (38 - 43b, 4x4, 0x6)" → the how-out in the scouting convention. */
export function howOutFrom(
  commentary: string,
  bowler: string,
): { out: string; runs: number | null; balls: number | null } {
  const c = commentary.slice(commentary.indexOf('OUT!') >= 0 ? commentary.indexOf('OUT!') : 0);
  const stats = /\((\d+) - (\d+)b/.exec(c);
  const fielder = (s: string) => cleanName(s.replace(/\s*\(\d+ - .*$/, ''));
  let m: RegExpExecArray | null;
  let out = 'out';
  if (
    (m = /OUT! Caught(?: and Bowled)?,?\s*([^()]+?(?:\((?:WK|C)\))?)\s*\(\d/.exec(c)) &&
    !/Caught and Bowled/.test(c)
  )
    out = fielder(m[1]) === bowler ? `c & b ${bowler}` : `c ${fielder(m[1])} b ${bowler}`;
  else if (/Caught and Bowled/i.test(c)) out = `c & b ${bowler}`;
  else if (/OUT! Bowled/i.test(c)) out = `b ${bowler}`;
  else if (/Leg Before/i.test(c)) out = `lbw b ${bowler}`;
  else if ((m = /OUT! Stumped,?\s*([^()]+?(?:\((?:WK|C)\))?)\s*\(\d/.exec(c)))
    out = `st ${fielder(m[1])} b ${bowler}`;
  else if ((m = /OUT! Run Out,?\s*([^()]+?(?:\((?:WK|C)\))?)\s*(?:\(\d|$)/.exec(c)))
    out = `run out (${fielder(m[1])})`;
  else if (/Run Out/i.test(c)) out = 'run out';
  else if (/Hit Wicket/i.test(c)) out = `hit wicket b ${bowler}`;
  else if (/Retired (?:Injured|Hurt|Not Out)/i.test(c)) out = 'retired not out';
  else if (/Retired/i.test(c)) out = 'retired out';
  // A "W" with no dismissal written (e.g. a concussion replacement) isn't counted as a wicket.
  else if (!/OUT!/.test(c)) out = 'retired out';
  return { out, runs: stats ? Number(stats[1]) : null, balls: stats ? Number(stats[2]) : null };
}

/** Team names from "Ball by Ball (A vs B vs a) 27 Sept 2024.csv" (case-insensitive repeats dropped). */
function teamsFromName(name: string): string[] {
  const m = /\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*\d/.exec(name) ?? /\((.+)\)/.exec(name);
  if (!m) return [];
  const seen = new Set<string>();
  return m[1]
    .split(/\s+vs\s+/i)
    .map((s) => s.trim())
    .filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
}

export function parseBallByBall(text: string, name: string) {
  const rows = csvRows(text).filter((r) => r.some((c) => c !== ''));
  if (rows.length < 2) return null;
  const head = rows[0].map((h) => h.toLowerCase());
  const col = (k: string) => head.indexOf(k);
  const ix = {
    id: col('match_id'),
    comp: col('competition'),
    date: col('date'),
    inn: col('innings_no'),
    team: col('batting_team'),
    ob: col('over_ball'),
    outcome: col('outcome'),
    runs: col('runs'),
    extra: col('extra_type'),
    wicket: col('wicket'),
    bowler: col('bowler'),
    batter: col('batter'),
    comm: col('commentary'),
  };
  if (ix.inn < 0 || ix.ob < 0 || ix.batter < 0 || ix.bowler < 0) return null;
  const data = rows.slice(1);
  const date = isoDate(data[0][ix.date] ?? '');
  if (!date) return null;
  const competition = ix.comp >= 0 ? data[0][ix.comp] : undefined;
  const externalId = ix.id >= 0 ? data[0][ix.id] : undefined;

  // Group deliveries by innings number, in file order.
  const byInn = new Map<number, { team: string; ds: Delivery[] }>();
  for (const r of data) {
    const n = Number(r[ix.inn]) || 1;
    const team = r[ix.team];
    const [o, b] = String(r[ix.ob]).split('.').map(Number);
    const res = readOutcome(
      r[ix.outcome] ?? '',
      r[ix.runs] ?? '',
      r[ix.extra] ?? '',
      r[ix.wicket] ?? '',
      r[ix.comm] ?? '',
    );
    const g = byInn.get(n) ?? { team, ds: [] };
    g.ds.push({
      over: o || 0,
      ball: b || 0,
      batter: cleanName(r[ix.batter]),
      bowler: cleanName(r[ix.bowler]),
      commentary: r[ix.comm] ?? '',
      ...res,
    });
    byInn.set(n, g);
  }
  const teamNames = [...new Set([...byInn.values()].map((g) => g.team))];
  const fromName = teamsFromName(name);
  const sameTeam = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const all = [...teamNames];
  for (const t of fromName) if (!all.some((x) => sameTeam(x, t))) all.push(t);
  const home = all[0];
  const away = all[1] ?? 'Opponent not recorded';
  const other = (t: string) => (sameTeam(t, home) ? away : home);

  const innings: ScoutInnings[] = [...byInn.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, g]) => buildInnings(sameTeam(g.team, home) ? home : away, other(g.team), g.ds));

  const maxBalls = Math.max(...innings.map((i) => oversToBalls(i.overs)));
  const format: ProFormat =
    formatFromCompetition(competition) ??
    (innings.length > 2 || maxBalls > 300 ? 'Multi-day' : maxBalls > 120 ? 'One-Day' : 'T20');
  const gender: Gender = [home, away].some((t) => /\b(ladies|women)\b/i.test(t)) ? 'women' : 'men';
  const match: ProMatch = {
    id: externalId ? `bbb-${externalId}` : name.replace(/\.csv$/i, ''),
    date,
    event: format,
    stage: competition ?? '',
    overs: format === 'T20' ? 20 : format === 'One-Day' ? 50 : 0,
    venue: '',
    home,
    away,
    winner: null,
    result: '',
    innings,
    format,
    gender,
    season: seasonOf(date),
    resultKind: 'unknown',
  };
  decideInto(match);
  return { match, competition, externalId };
}

function buildInnings(bat: string, fld: string, ds: Delivery[]): ScoutInnings {
  const batting = new Map<string, ScoutBatRow & { order: number }>();
  const bowling = new Map<
    string,
    ScoutBowlRow & { balls: number; overRuns: Map<number, number> }
  >();
  const fow: ScoutInnings['fow'] = [];
  const perOver = new Map<number, [number, number]>();
  const balls: NonNullable<ScoutInnings['balls']> = [];
  const exb = { w: 0, nb: 0, b: 0, lb: 0 };
  let total = 0;
  let wkts = 0;
  let legal = 0;
  const crease: string[] = [];
  const bat_ = (n: string) => {
    if (!batting.has(n))
      batting.set(n, {
        n,
        pos: batting.size + 1,
        order: batting.size,
        r: 0,
        b: 0,
        f4: 0,
        f6: 0,
        out: 'not out',
        dots: 0,
      });
    if (!crease.includes(n)) crease.push(n);
    return batting.get(n)!;
  };
  // Run-outs, so one logged against the wrong batter can be moved: if the "dismissed" batter
  // faces again, it was their partner who went (a common scorer slip on non-striker run-outs).
  const runOuts = new Map<string, { partner: string | undefined; fowIdx: number; out: string }>();
  for (const d of ds) {
    const back = batting.get(d.batter);
    const ro = runOuts.get(d.batter);
    if (
      back &&
      back.out !== 'not out' &&
      ro?.partner &&
      batting.get(ro.partner)?.out === 'not out'
    ) {
      back.out = 'not out';
      batting.get(ro.partner)!.out = ro.out;
      fow[ro.fowIdx].batter = ro.partner;
      const at = crease.indexOf(ro.partner);
      if (at >= 0) crease.splice(at, 1);
      runOuts.delete(d.batter);
    }
    const striker = bat_(d.batter);
    const bw =
      bowling.get(d.bowler) ??
      (bowling.set(d.bowler, {
        n: d.bowler,
        o: '0',
        m: 0,
        r: 0,
        w: 0,
        wd: 0,
        nb: 0,
        dots: 0,
        balls: 0,
        overRuns: new Map(),
      }),
      bowling.get(d.bowler)!);
    const runs = d.bat + d.extraRuns;
    total += runs;
    // Batter: runs off the bat; a no-ball is a ball faced, a wide is not.
    striker.r += d.bat;
    if (d.extra !== 'wd') striker.b++;
    if (d.extra !== 'wd' && d.bat === 0) striker.dots = (striker.dots ?? 0) + 1;
    if (d.bat === 4) striker.f4++;
    if (d.bat === 6) striker.f6++;
    // Bowler: charged the bat runs, wides and no-balls; byes and leg byes aren't theirs.
    const charged = d.bat + (d.extra === 'wd' || d.extra === 'nb' ? d.extraRuns : 0);
    bw.r += charged;
    bw.overRuns.set(d.over, (bw.overRuns.get(d.over) ?? 0) + charged);
    if (d.extra === 'wd') bw.wd += d.extraRuns;
    if (d.extra === 'nb') bw.nb += 1;
    if (d.legal) {
      bw.balls++;
      legal++;
      if (charged === 0) bw.dots++;
    }
    if (d.extra) exb[d.extra === 'wd' ? 'w' : d.extra] += d.extraRuns;
    const po = perOver.get(d.over + 1) ?? [0, 0];
    po[0] += runs;
    let wicket = 0;
    if (d.wicket) {
      const how = howOutFrom(d.commentary, d.bowler);
      // Who's out: the striker, unless the scorer's "(runs - balls)" matches the other batter.
      let outName = striker.n;
      if (how.runs !== null) {
        const other = crease.find((n) => n !== striker.n);
        const o = other ? batting.get(other) : undefined;
        if (
          o &&
          !(striker.r === how.runs && striker.b === how.balls) &&
          o.r === how.runs &&
          o.b === how.balls
        )
          outName = o.n;
      }
      const row = batting.get(outName)!;
      if (!/^retired/.test(how.out)) {
        row.out = how.out;
        wkts++;
        wicket = 1;
        fow.push({ wkt: wkts, score: total, batter: outName, over: `${d.over}.${d.ball}` });
        if (!/^run out/.test(how.out)) bw.w++;
        else
          runOuts.set(outName, {
            partner: crease.find((n) => n !== outName),
            fowIdx: fow.length - 1,
            out: how.out,
          });
      } else row.out = how.out;
      crease.splice(crease.indexOf(outName), 1);
      po[1]++;
    }
    perOver.set(d.over + 1, po);
    balls.push([d.over + 1, d.ball, d.batter, d.bowler, d.bat, d.extra, d.extraRuns, wicket, -1]);
  }
  const bowlRows: ScoutBowlRow[] = [...bowling.values()].map((b) => {
    const full = Math.floor(b.balls / 6);
    return {
      n: b.n,
      o: `${full}${b.balls % 6 ? `.${b.balls % 6}` : ''}`,
      m: [...b.overRuns.values()].filter((r) => r === 0).length,
      r: b.r,
      w: b.w,
      wd: b.wd,
      nb: b.nb,
      dots: b.dots,
    };
  });
  return {
    bat,
    fld,
    total,
    wkts,
    overs: `${Math.floor(legal / 6)}${legal % 6 ? `.${legal % 6}` : ''}`,
    extras: exb.w + exb.nb + exb.b + exb.lb,
    exb,
    batting: [...batting.values()]
      .sort((a, b) => a.order - b.order)
      .map(({ order: _o, ...r }) => r),
    bowling: bowlRows,
    fow,
    perOver: [...perOver.entries()].sort((a, b) => a[0] - b[0]).map(([o, [r, w]]) => [o, r, w]),
    balls,
  };
}

/** Result from the totals (the same rules as the scorecard reader). */
function decideInto(m: ProMatch) {
  // Reuse the scorecard reader's decision by round-tripping through its shape is overkill;
  // the rules are short enough to apply here.
  const inns = m.innings ?? [];
  const short = shortTeam;
  if (m.format !== 'Multi-day') {
    if (inns.length < 2) {
      m.result = 'No result';
      return;
    }
    const [a, b] = inns;
    if (b.total > a.total) {
      m.winner = b.bat;
      m.result = `${short(b.bat)} won by ${10 - b.wkts} wicket${10 - b.wkts === 1 ? '' : 's'}`;
      m.resultKind = 'wickets';
    } else if (b.wkts >= 10 || oversToBalls(b.overs) >= m.overs * 6) {
      if (b.total === a.total) {
        m.result = 'Tied';
        m.resultKind = 'tie';
      } else {
        m.winner = a.bat;
        m.result = `${short(a.bat)} won by ${a.total - b.total} runs`;
        m.resultKind = 'runs';
      }
    } else m.result = 'Result not on the scorecard (reduced or abandoned)';
    return;
  }
  const sum = (t: string) => inns.filter((x) => x.bat === t).reduce((n, x) => n + x.total, 0);
  const last = inns[inns.length - 1];
  const other = last.bat === m.home ? m.away : m.home;
  if (inns.length === 4 && sum(last.bat) > sum(other)) {
    m.winner = last.bat;
    m.result = `${short(last.bat)} won by ${10 - last.wkts} wickets`;
    m.resultKind = 'wickets';
  } else if (inns.length === 4 && last.wkts >= 10 && sum(last.bat) < sum(other)) {
    m.winner = other;
    m.result = `${short(other)} won by ${sum(other) - sum(last.bat)} runs`;
    m.resultKind = 'runs';
  } else if (
    inns.length === 3 &&
    inns[1].bat === inns[2].bat &&
    inns[2].wkts >= 10 &&
    sum(inns[1].bat) < sum(inns[0].bat)
  ) {
    m.winner = inns[0].bat;
    m.result = `${short(inns[0].bat)} won by an innings and ${sum(inns[0].bat) - sum(inns[1].bat)} runs`;
    m.resultKind = 'innings';
  } else {
    m.result = 'Draw';
    m.resultKind = 'draw';
  }
}

/* ─── Pairing, duplicates and the import plan ─── */

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const teamSet = (m: ProMatch) =>
  [m.home, m.away]
    .filter((t) => !/not recorded/i.test(t))
    .map((t) => slug(shortTeam(t)))
    .sort();

export const baseKey = (m: ProMatch) => `${m.date}_${teamSet(m).join('-v-')}_${m.gender}`;

const firstTotals = (m: ProMatch) =>
  (m.innings ?? []).map((i) => `${slug(shortTeam(i.bat))}:${i.total}/${i.wkts}`);

/**
 * The same game? Same date, gender and teams (one side may be unrecorded on a ball-by-ball
 * file), and the first innings by the same side within a few runs (the two exports can
 * disagree on an extra or two). Two different games on one day differ in their totals.
 */
export function sameGame(a: ProMatch, b: ProMatch, tolerance?: number) {
  if (a.date !== b.date || a.gender !== b.gender) return false;
  const ta = teamSet(a);
  const tb = teamSet(b);
  if (!ta.some((t) => tb.includes(t))) return false;
  const ia = a.innings?.[0];
  const ib = b.innings?.[0];
  if (!ia || !ib) return true;
  const tol = tolerance ?? 6;
  return (
    slug(shortTeam(ia.bat)) === slug(shortTeam(ib.bat)) && Math.abs(ia.total - ib.total) <= tol
  );
}

/** Same game and the same numbers: nothing new in it. */
export const identical = (a: ProMatch, b: ProMatch) =>
  sameGame(a, b) && firstTotals(a).join() === firstTotals(b).join();

/**
 * Put a scorecard and the ball-by-ball of the same game together: the scorecard's cards
 * (official), the deliveries, per-over runs and the competition from the ball-by-ball.
 * Differences in innings totals are returned as warnings.
 */
export function mergeSources(
  card: ProMatch,
  bbb: ProMatch,
): { match: ProMatch; warnings: string[] } {
  const warnings: string[] = [];
  const inns = (card.innings ?? []).map((ci, k) => {
    const bi = bbb.innings?.[k];
    if (!bi) return ci;
    if (bi.total !== ci.total || bi.wkts !== ci.wkts)
      warnings.push(
        `${shortTeam(ci.bat)} innings ${k + 1}: scorecard ${ci.total}/${ci.wkts}, ball-by-ball ${bi.total}/${bi.wkts}`,
      );
    return { ...ci, perOver: bi.perOver, balls: bi.balls };
  });
  if ((bbb.innings?.length ?? 0) > (card.innings?.length ?? 0))
    warnings.push(
      `Ball-by-ball has ${bbb.innings!.length} innings, the scorecard ${card.innings!.length}`,
    );
  const format = formatFromCompetition(bbb.stage) ?? card.format;
  return {
    match: {
      ...card,
      innings: inns,
      format,
      event: format,
      stage: bbb.stage || card.stage,
      overs: format === 'T20' ? 20 : format === 'One-Day' ? 50 : 0,
    },
    warnings,
  };
}

export type Outcome =
  | 'new'
  | 'adds-balls'
  | 'adds-scorecard'
  | 'duplicate'
  | 'conflict'
  | 'unrecognised'
  | 'error';

export interface PlanItem {
  name: string;
  kind: FileKind;
  outcome: Outcome;
  key?: string;
  summary: string;
  warnings: string[];
}

const describe = (m: ProMatch) =>
  `${m.date} · ${shortTeam(m.home)} v ${shortTeam(m.away)} · ${(m.innings ?? []).map((i) => `${shortTeam(i.bat)} ${i.total}/${i.wkts}`).join(', ')}`;

const asLibrary = (
  m: ProMatch,
  key: string,
  src: { kind: SourceKind; name: string }[],
  meta?: ReadFile['meta'],
): LibraryMatch => ({
  ...m,
  key,
  v: STANDARD_VERSION,
  id: key,
  competition: meta?.competition ?? (m as LibraryMatch).competition ?? (m.stage || undefined),
  externalId: meta?.externalId ?? (m as LibraryMatch).externalId,
  sources: src,
  hasBalls: (m.innings ?? []).some((i) => (i.balls?.length ?? 0) > 0),
});

/**
 * What an upload would do, file by file, against the library as it stands. Returns the plan
 * (shown to the operator) and the matches to save (new or improved). Nothing is saved here.
 */
export function planImport(library: LibraryMatch[], files: ReadFile[]) {
  const work = new Map(library.map((m) => [m.key, m]));
  const changed = new Set<string>();
  const items: PlanItem[] = [];
  const freeKey = (m: ProMatch) => {
    const base = baseKey(m);
    if (!work.has(base)) return base;
    for (let n = 2; ; n++) if (!work.has(`${base}_${n}`)) return `${base}_${n}`;
  };
  // Scorecards first, so ball-by-ball files find their card whatever order they were dropped in.
  const order = [...files].sort((a, b) => rank(a.kind) - rank(b.kind));
  for (const f of order) {
    if (f.kind === 'unknown' || f.error) {
      items.push({
        name: f.name,
        kind: f.kind,
        outcome: f.kind === 'unknown' ? 'unrecognised' : 'error',
        summary: f.error ?? '',
        warnings: [],
      });
      continue;
    }
    for (const m of f.matches) {
      // A standard file keeps what it was: official cards if it came from a scorecard.
      const kind: SourceKind =
        f.kind === 'scorecard' || f.kind === 'ball-by-ball'
          ? f.kind
          : (m as LibraryMatch).sources?.some((x) => x.kind === 'scorecard')
            ? 'scorecard'
            : 'ball-by-ball';
      // A ball-by-ball file can be a few runs or an over short of its scorecard: pair it with
      // the closest game that day within 8%. Two scorecards must agree within 6 runs.
      const tolOf = (x: ProMatch) =>
        kind === 'ball-by-ball'
          ? Math.max(6, 0.08 * Math.max(x.innings?.[0]?.total ?? 0, m.innings?.[0]?.total ?? 0))
          : 6;
      const existing = [...work.values()]
        .filter((x) => sameGame(x, m, tolOf(x)))
        .sort(
          (x, y) =>
            Math.abs((x.innings?.[0]?.total ?? 0) - (m.innings?.[0]?.total ?? 0)) -
            Math.abs((y.innings?.[0]?.total ?? 0) - (m.innings?.[0]?.total ?? 0)),
        )[0];
      const sameDay = [...work.values()].find((x) => sameGame(x, m, Infinity));
      if (!existing && kind === 'ball-by-ball' && sameDay) {
        items.push({
          name: f.name,
          kind: f.kind,
          outcome: 'conflict',
          key: sameDay.key,
          summary: describe(sameDay),
          warnings: [
            `This ball-by-ball doesn't add up to the scorecard (${firstTotals(m).join(', ')} v ${firstTotals(sameDay).join(', ')}) — not attached. Check the export.`,
          ],
        });
        continue;
      }
      if (!existing) {
        const key =
          (m as LibraryMatch).key && f.kind === 'standard' ? (m as LibraryMatch).key : freeKey(m);
        work.set(
          key,
          asLibrary(
            m,
            key,
            f.kind === 'standard'
              ? ((m as LibraryMatch).sources ?? [{ kind, name: f.name }])
              : [{ kind, name: f.name }],
            f.meta,
          ),
        );
        changed.add(key);
        items.push({
          name: f.name,
          kind: f.kind,
          outcome: 'new',
          key,
          summary: describe(m),
          warnings: [],
        });
        continue;
      }
      const has = (k: SourceKind) => existing.sources.some((s) => s.kind === k);
      if (kind === 'ball-by-ball' && !existing.hasBalls) {
        const { match, warnings } = has('scorecard')
          ? mergeSources(existing, m)
          : { match: m, warnings: [] };
        work.set(
          existing.key,
          asLibrary(
            match,
            existing.key,
            [...existing.sources, { kind, name: f.name }],
            f.meta ?? { competition: existing.competition, externalId: existing.externalId },
          ),
        );
        changed.add(existing.key);
        items.push({
          name: f.name,
          kind: f.kind,
          outcome: 'adds-balls',
          key: existing.key,
          summary: describe(existing),
          warnings,
        });
        continue;
      }
      if (kind === 'scorecard' && !has('scorecard')) {
        const { match, warnings } = mergeSources(m, existing);
        work.set(
          existing.key,
          asLibrary(match, existing.key, [{ kind, name: f.name }, ...existing.sources], {
            competition: existing.competition,
            externalId: existing.externalId,
          }),
        );
        changed.add(existing.key);
        items.push({
          name: f.name,
          kind: f.kind,
          outcome: 'adds-scorecard',
          key: existing.key,
          summary: describe(existing),
          warnings,
        });
        continue;
      }
      // Already have this kind of record for the game.
      const same = kind === 'scorecard' ? identical(existing, m) : true;
      items.push({
        name: f.name,
        kind: f.kind,
        outcome: same ? 'duplicate' : 'conflict',
        key: existing.key,
        summary: describe(existing),
        warnings: same
          ? []
          : [
              `The library has ${firstTotals(existing).join(', ')}; this file says ${firstTotals(m).join(', ')}. The library copy is kept — delete it first to replace it.`,
            ],
      });
    }
  }
  return { items, save: [...changed].map((k) => work.get(k)!) };
}

const rank = (k: FileKind) =>
  k === 'standard' ? 0 : k === 'scorecard' ? 1 : k === 'ball-by-ball' ? 2 : 3;
