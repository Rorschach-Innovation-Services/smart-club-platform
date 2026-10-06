/**
 * Professional team: squad, selection and team-level analysis over a franchise's scorecards
 * (pro-scorecards.ts). Pure — no React.
 *
 * Ratings follow the national scouting report so a squad player and a scouted player read on
 * the same kind of scale: every index is 100 = the average of everyone who played in those
 * matches (both sides) in that format; small samples are shrunk towards that average; batting
 * index = √(runs-per-innings index × strike-rate index), bowling index = √(economy index ×
 * wicket-rate index). In multi-day cricket staying in matters more than scoring speed, so
 * runs per innings and wicket rate carry three quarters of the weight there.
 *
 * The scorecards carry no ball-by-ball, so nothing here is by over or phase except what the
 * fall of wickets records (the over each wicket fell).
 */
import { dismissalKind, fielderOf, isOut, partnershipByWicket, runSources } from './scouting';
import type { DismissalKind } from './scouting';
import type { ScoutInnings } from './scouting-matches';
import {
  oversToBalls,
  shortTeam,
  type Gender,
  type ProFormat,
  type ProMatch,
} from './pro-scorecards';

/* ─── The squad: which side in the files is "us" ─── */

export interface Squad {
  gender: Gender;
  /** The word every one of our team names shares, e.g. "hawks". */
  key: string;
  /** The most-used full name, e.g. "Highveld Hawks". */
  name: string;
  matches: ProMatch[];
}

const GENERIC = new Set(['ladies', 'women', 'cricket', 'club', 'cc', 'the', 'and']);

/**
 * One squad per gender: the team-name word that appears on one side of every match (a
 * franchise's files are all its own games, under changing sponsor names).
 */
export function detectSquads(matches: ProMatch[]): Squad[] {
  const out: Squad[] = [];
  for (const gender of ['men', 'women'] as Gender[]) {
    const ms = matches.filter((m) => m.gender === gender);
    if (!ms.length) continue;
    const counts = new Map<string, number>();
    for (const m of ms) {
      const words = new Set(
        [m.home, m.away]
          .flatMap((t) => t.toLowerCase().split(/\s+/))
          .filter((w) => w.length > 2 && !GENERIC.has(w)),
      );
      words.forEach((w) => counts.set(w, (counts.get(w) ?? 0) + 1));
    }
    // Ties (sponsor words travel with the club name) go to the word nearest the end — the
    // club's own name ("Acme Bank Highveld Hawks" → "hawks") rather than the sponsor's.
    const lastPos = (w: string) =>
      Math.max(
        ...ms.flatMap((m) =>
          [m.home, m.away].map((t) => {
            const ws = t
              .toLowerCase()
              .split(/\s+/)
              .filter((x) => !GENERIC.has(x));
            const i = ws.indexOf(w);
            return i < 0 ? -Infinity : i - ws.length;
          }),
        ),
      );
    const best = [...counts].sort((a, b) => b[1] - a[1] || lastPos(b[0]) - lastPos(a[0]))[0];
    if (!best || best[1] < ms.length * 0.8) continue;
    const key = best[0];
    const names = new Map<string, number>();
    const mine = ms.filter((m) => [m.home, m.away].some((t) => t.toLowerCase().includes(key)));
    mine.forEach((m) =>
      [m.home, m.away]
        .filter((t) => t.toLowerCase().includes(key))
        .forEach((t) => names.set(t, (names.get(t) ?? 0) + 1)),
    );
    const name = [...names].sort((a, b) => b[1] - a[1])[0][0];
    out.push({ gender, key, name, matches: mine });
  }
  return out;
}

export const isUs = (squad: Squad, team: string) => team.toLowerCase().includes(squad.key);
export const opponentOf = (squad: Squad, m: ProMatch) =>
  shortTeam(isUs(squad, m.home) ? m.away : m.home);

/* ─── Filters ─── */

export interface ProFilter {
  format: ProFormat | 'all';
  season: string | 'all';
}

export const seasonsOf = (ms: ProMatch[]) => [...new Set(ms.map((m) => m.season))].sort().reverse();

export function filterMatches(squad: Squad, f: ProFilter) {
  return squad.matches.filter(
    (m) =>
      (f.format === 'all' || m.format === f.format) &&
      (f.season === 'all' || m.season === f.season),
  );
}

/* ─── Baselines (everyone in those matches, both sides) ─── */

export interface Baseline {
  format: ProFormat;
  /** Runs per batting innings (innings = faced a ball or was out). */
  rpi: number;
  sr: number;
  /** Runs per dismissal. */
  avg: number;
  ballsPerInns: number;
  econ: number;
  /** Balls per wicket (bowlers' wickets). */
  bpw: number;
  dotPct: number;
  boundaryPct: number;
}

const battedIn = (r: { b: number; out: string }) => r.b > 0 || isOut(r as never);

export function baselines(matches: ProMatch[]): Record<ProFormat, Baseline | null> {
  const res = {} as Record<ProFormat, Baseline | null>;
  for (const format of ['T20', 'One-Day', 'Multi-day'] as ProFormat[]) {
    const inns = matches.filter((m) => m.format === format).flatMap((m) => m.innings ?? []);
    let runs = 0;
    let balls = 0;
    let innsN = 0;
    let outs = 0;
    let bowlBalls = 0;
    let bowlRuns = 0;
    let wkts = 0;
    let dots = 0;
    let bnd = 0;
    for (const inn of inns) {
      for (const r of inn.batting) {
        if (!battedIn(r)) continue;
        runs += r.r;
        balls += r.b;
        innsN++;
        if (isOut(r)) outs++;
        bnd += r.f4 + r.f6;
      }
      for (const b of inn.bowling) {
        bowlBalls += oversToBalls(b.o);
        bowlRuns += b.r;
        wkts += b.w;
        dots += b.dots;
      }
    }
    res[format] =
      innsN && balls && bowlBalls && wkts
        ? {
            format,
            rpi: runs / innsN,
            sr: (runs / balls) * 100,
            avg: outs ? runs / outs : runs,
            ballsPerInns: balls / innsN,
            econ: (bowlRuns / bowlBalls) * 6,
            bpw: bowlBalls / wkts,
            dotPct: (dots / bowlBalls) * 100,
            boundaryPct: (bnd / balls) * 100,
          }
        : null;
  }
  return res;
}

/** Extra balls blended in at the league rate (the report's 30 faced / 24 bowled in T20). */
const SHRINK: Record<ProFormat, { bat: number; bowl: number }> = {
  T20: { bat: 30, bowl: 24 },
  'One-Day': { bat: 60, bowl: 48 },
  'Multi-day': { bat: 120, bowl: 96 },
};
/** Qualifying samples for rankings and signals. */
export const MIN_SAMPLE: Record<ProFormat, { balls: number; bowled: number }> = {
  T20: { balls: 40, bowled: 36 },
  'One-Day': { balls: 80, bowled: 72 },
  'Multi-day': { balls: 150, bowled: 180 },
};

export interface BatIndex {
  rpiIdx: number;
  srIdx: number;
  idx: number;
}
export interface BowlIndex {
  econIdx: number;
  wktIdx: number;
  idx: number;
}

export function batIndex(
  s: { runs: number; balls: number; inns: number },
  base: Baseline,
): BatIndex | null {
  if (!s.inns || !s.balls) return null;
  const k = SHRINK[base.format].bat;
  const sr = ((s.runs + (k * base.sr) / 100) / (s.balls + k)) * 100;
  const kInns = k / base.ballsPerInns;
  const rpi = (s.runs + kInns * base.rpi) / (s.inns + kInns);
  const rpiIdx = (rpi / base.rpi) * 100;
  const srIdx = (sr / base.sr) * 100;
  const idx =
    base.format === 'Multi-day'
      ? Math.pow(rpiIdx, 0.75) * Math.pow(srIdx, 0.25)
      : Math.sqrt(rpiIdx * srIdx);
  return { rpiIdx, srIdx, idx };
}

export function bowlIndex(
  s: { balls: number; runs: number; wkts: number },
  base: Baseline,
): BowlIndex | null {
  if (!s.balls) return null;
  const k = SHRINK[base.format].bowl;
  const econ = ((s.runs + (k * base.econ) / 6) / (s.balls + k)) * 6;
  const wktPerBall = (s.wkts + k / base.bpw) / (s.balls + k);
  const econIdx = (base.econ / econ) * 100;
  const wktIdx = wktPerBall * base.bpw * 100;
  const idx =
    base.format === 'Multi-day'
      ? Math.pow(wktIdx, 0.75) * Math.pow(econIdx, 0.25)
      : Math.sqrt(econIdx * wktIdx);
  return { econIdx, wktIdx, idx };
}

/* ─── Players ─── */

export interface BatLine {
  matchId: string;
  date: string;
  format: ProFormat;
  opp: string;
  /** Which of the team's innings in the match (1 or 2). */
  innsNo: number;
  pos: number;
  r: number;
  b: number;
  f4: number;
  f6: number;
  dots: number | null;
  out: string;
  isOut: boolean;
  kind: DismissalKind | null;
  /** The score and over when the player came in (from the previous wicket). */
  cameIn: { score: number; wkts: number; over: string | null };
}

export interface BowlLine {
  matchId: string;
  date: string;
  format: ProFormat;
  opp: string;
  balls: number;
  r: number;
  w: number;
  m: number;
  dots: number;
  wd: number;
  nb: number;
}

export type ProRole = 'Batter' | 'Bowler' | 'All-rounder' | 'Wicketkeeper';
export type SignalKind = 'promote' | 'hold' | 'watch' | 'drop';

export interface Signal {
  kind: SignalKind;
  /** Short headline, e.g. "In form", "Out of form", "Hot streak". */
  label: string;
  reasons: string[];
}

export interface ProPlayer {
  name: string;
  matches: number;
  /** Matches the squad played in this filter. */
  squadMatches: number;
  formats: ProFormat[];
  lastPlayed: string;
  role: ProRole;
  bat: {
    inns: number;
    notOuts: number;
    runs: number;
    balls: number;
    outs: number;
    avg: number | null;
    sr: number | null;
    f4: number;
    f6: number;
    dots: number;
    /** Balls whose dots were recorded (older exports may lack them). */
    dotBalls: number;
    dotPct: number | null;
    boundaryPct: number | null;
    hs: string | null;
    fifties: number;
    hundreds: number;
    avgPos: number | null;
    dismissals: Record<DismissalKind, number>;
    lines: BatLine[];
  };
  bowl: {
    inns: number;
    balls: number;
    runs: number;
    wkts: number;
    maidens: number;
    dots: number;
    wd: number;
    nb: number;
    econ: number | null;
    avg: number | null;
    sr: number | null;
    dotPct: number | null;
    best: string | null;
    hauls: number;
    lines: BowlLine[];
  };
  field: { ct: number; st: number; ro: number };
  /** Season-to-date indices for the filter (balls-weighted across formats). */
  idx: { bat: BatIndex | null; bowl: BowlIndex | null; ar: number | null };
  /** The last five innings / bowling innings on the same scale. */
  recent: { bat: BatIndex | null; bowl: BowlIndex | null; batN: number; bowlN: number };
  qualifies: { bat: boolean; bowl: boolean };
  signal: Signal;
}

const emptyDismissals = () =>
  Object.fromEntries(
    (['Bowled', 'Caught', 'LBW', 'Run out', 'Stumped', 'Other'] as DismissalKind[]).map((k) => [
      k,
      0,
    ]),
  ) as Record<DismissalKind, number>;

function batLines(squad: Squad, ms: ProMatch[]) {
  const by = new Map<string, BatLine[]>();
  for (const m of ms) {
    const opp = opponentOf(squad, m);
    let innsNo = 0;
    for (const inn of m.innings ?? []) {
      if (!isUs(squad, inn.bat)) continue;
      innsNo++;
      const fowByBatter = new Map(inn.fow.map((f, i) => [f.batter, i]));
      // Who came in when: the previous wicket's score/over for #3 onwards.
      const order = inn.batting;
      order.forEach((r, i) => {
        if (!battedIn(r)) return;
        let cameIn: BatLine['cameIn'] = { score: 0, wkts: 0, over: null };
        if (i >= 2) {
          // The (i-1)th wicket brought in batter i+1 (openers come in together).
          const f = inn.fow[i - 2];
          if (f) cameIn = { score: f.score, wkts: f.wkt, over: f.over };
        }
        void fowByBatter;
        const line: BatLine = {
          matchId: m.id,
          date: m.date,
          format: m.format,
          opp,
          innsNo,
          pos: r.pos,
          r: r.r,
          b: r.b,
          f4: r.f4,
          f6: r.f6,
          dots: r.dots ?? null,
          out: r.out,
          isOut: isOut(r),
          kind: dismissalKind(r.out),
          cameIn,
        };
        by.set(r.n, [...(by.get(r.n) ?? []), line]);
      });
    }
  }
  return by;
}

function bowlLines(squad: Squad, ms: ProMatch[]) {
  const by = new Map<string, BowlLine[]>();
  for (const m of ms) {
    const opp = opponentOf(squad, m);
    for (const inn of m.innings ?? []) {
      if (isUs(squad, inn.bat)) continue;
      for (const b of inn.bowling) {
        const balls = oversToBalls(b.o);
        if (!balls) continue;
        by.set(b.n, [
          ...(by.get(b.n) ?? []),
          {
            matchId: m.id,
            date: m.date,
            format: m.format,
            opp,
            balls,
            r: b.r,
            w: b.w,
            m: b.m,
            dots: b.dots,
            wd: b.wd,
            nb: b.nb,
          },
        ]);
      }
    }
  }
  return by;
}

function fieldingOf(squad: Squad, ms: ProMatch[]) {
  const by = new Map<string, { ct: number; st: number; ro: number }>();
  for (const m of ms)
    for (const inn of m.innings ?? []) {
      if (isUs(squad, inn.bat)) continue;
      for (const r of inn.batting) {
        const f = fielderOf(r.out);
        if (!f) continue;
        for (const n of f.names) {
          const name = n.replace(/\s*\(.*\)\s*$/, '').trim();
          const row = by.get(name) ?? { ct: 0, st: 0, ro: 0 };
          row[f.kind]++;
          by.set(name, row);
        }
      }
    }
  return by;
}

/** Balls-weighted index across formats (each against its own format's average). */
function combineBat(lines: BatLine[], bases: Record<ProFormat, Baseline | null>): BatIndex | null {
  const parts: { w: number; i: BatIndex }[] = [];
  for (const f of ['T20', 'One-Day', 'Multi-day'] as ProFormat[]) {
    const ls = lines.filter((l) => l.format === f);
    const base = bases[f];
    if (!ls.length || !base) continue;
    const i = batIndex(
      { runs: sum(ls, (l) => l.r), balls: sum(ls, (l) => l.b), inns: ls.length },
      base,
    );
    if (i) parts.push({ w: sum(ls, (l) => l.b) || 1, i });
  }
  if (!parts.length) return null;
  const W = sum(parts, (p) => p.w);
  return {
    rpiIdx: sum(parts, (p) => p.w * p.i.rpiIdx) / W,
    srIdx: sum(parts, (p) => p.w * p.i.srIdx) / W,
    idx: sum(parts, (p) => p.w * p.i.idx) / W,
  };
}

function combineBowl(
  lines: BowlLine[],
  bases: Record<ProFormat, Baseline | null>,
): BowlIndex | null {
  const parts: { w: number; i: BowlIndex }[] = [];
  for (const f of ['T20', 'One-Day', 'Multi-day'] as ProFormat[]) {
    const ls = lines.filter((l) => l.format === f);
    const base = bases[f];
    if (!ls.length || !base) continue;
    const i = bowlIndex(
      { balls: sum(ls, (l) => l.balls), runs: sum(ls, (l) => l.r), wkts: sum(ls, (l) => l.w) },
      base,
    );
    if (i) parts.push({ w: sum(ls, (l) => l.balls), i });
  }
  if (!parts.length) return null;
  const W = sum(parts, (p) => p.w);
  return {
    econIdx: sum(parts, (p) => p.w * p.i.econIdx) / W,
    wktIdx: sum(parts, (p) => p.w * p.i.wktIdx) / W,
    idx: sum(parts, (p) => p.w * p.i.idx) / W,
  };
}

function sum<T>(xs: T[], f: (x: T) => number) {
  return xs.reduce((n, x) => n + f(x), 0);
}

export const RECENT = 5;

/**
 * Every squad player in the filter, with indices, recent form and a selection signal.
 * `allMatches` (every file, both genders) sets the baselines so a one-format filter still
 * rates against a stable average.
 */
export function squadPlayers(squad: Squad, f: ProFilter, allMatches: ProMatch[]): ProPlayer[] {
  const ms = filterMatches(squad, f);
  const bases = baselines(allMatches.filter((m) => m.gender === squad.gender));
  const bats = batLines(squad, ms);
  const bowls = bowlLines(squad, ms);
  const field = fieldingOf(squad, ms);
  const names = new Set<string>([...bats.keys(), ...bowls.keys()]);
  // Players who batted or bowled (fielding-only names can be substitutes: left out).
  const appearances = new Map<string, Set<string>>();
  for (const m of ms)
    for (const inn of m.innings ?? []) {
      const ours = isUs(squad, inn.bat) ? inn.batting.map((r) => r.n) : inn.bowling.map((b) => b.n);
      ours.forEach((n) => appearances.set(n, (appearances.get(n) ?? new Set()).add(m.id)));
    }

  const players: ProPlayer[] = [];
  for (const name of names) {
    const bl = (bats.get(name) ?? []).sort(
      (a, b) => a.date.localeCompare(b.date) || a.innsNo - b.innsNo,
    );
    const wl = (bowls.get(name) ?? []).sort((a, b) => a.date.localeCompare(b.date));
    const runs = sum(bl, (l) => l.r);
    const balls = sum(bl, (l) => l.b);
    const outs = bl.filter((l) => l.isOut).length;
    const dotLines = bl.filter((l) => l.dots !== null);
    const dismissals = emptyDismissals();
    bl.forEach((l) => l.kind && dismissals[l.kind]++);
    const hsLine = [...bl].sort((a, b) => b.r - a.r || Number(a.isOut) - Number(b.isOut))[0];
    const wBalls = sum(wl, (l) => l.balls);
    const wRuns = sum(wl, (l) => l.r);
    const wk = sum(wl, (l) => l.w);
    const bestLine = [...wl].sort((a, b) => b.w - a.w || a.r - b.r)[0];
    const fmts = [...new Set([...bl.map((l) => l.format), ...wl.map((l) => l.format)])];
    const minBat = Math.min(...fmts.map((x) => MIN_SAMPLE[x].balls));
    const minBowl = Math.min(...fmts.map((x) => MIN_SAMPLE[x].bowled));
    const fld = field.get(name) ?? { ct: 0, st: 0, ro: 0 };
    const p: ProPlayer = {
      name,
      matches: appearances.get(name)?.size ?? 0,
      squadMatches: ms.length,
      formats: fmts,
      lastPlayed: [...bl.map((l) => l.date), ...wl.map((l) => l.date)].sort().slice(-1)[0] ?? '',
      role: 'Batter',
      bat: {
        inns: bl.length,
        notOuts: bl.length - outs,
        runs,
        balls,
        outs,
        avg: outs ? runs / outs : null,
        sr: balls ? (runs / balls) * 100 : null,
        f4: sum(bl, (l) => l.f4),
        f6: sum(bl, (l) => l.f6),
        dots: sum(dotLines, (l) => l.dots ?? 0),
        dotBalls: sum(dotLines, (l) => l.b),
        dotPct: sum(dotLines, (l) => l.b)
          ? (sum(dotLines, (l) => l.dots ?? 0) / sum(dotLines, (l) => l.b)) * 100
          : null,
        boundaryPct: runs
          ? ((sum(bl, (l) => l.f4) * 4 + sum(bl, (l) => l.f6) * 6) / runs) * 100
          : null,
        hs: hsLine ? `${hsLine.r}${hsLine.isOut ? '' : '*'}` : null,
        fifties: bl.filter((l) => l.r >= 50 && l.r < 100).length,
        hundreds: bl.filter((l) => l.r >= 100).length,
        avgPos: bl.length ? sum(bl, (l) => l.pos) / bl.length : null,
        dismissals,
        lines: bl,
      },
      bowl: {
        inns: wl.length,
        balls: wBalls,
        runs: wRuns,
        wkts: wk,
        maidens: sum(wl, (l) => l.m),
        dots: sum(wl, (l) => l.dots),
        wd: sum(wl, (l) => l.wd),
        nb: sum(wl, (l) => l.nb),
        econ: wBalls ? (wRuns / wBalls) * 6 : null,
        avg: wk ? wRuns / wk : null,
        sr: wk ? wBalls / wk : null,
        dotPct: wBalls ? (sum(wl, (l) => l.dots) / wBalls) * 100 : null,
        best: bestLine ? `${bestLine.w}/${bestLine.r}` : null,
        hauls: wl.filter((l) => l.w >= (l.format === 'T20' ? 3 : l.format === 'One-Day' ? 4 : 5))
          .length,
        lines: wl,
      },
      field: fld,
      idx: { bat: combineBat(bl, bases), bowl: combineBowl(wl, bases), ar: null },
      recent: {
        bat: combineBat(bl.slice(-RECENT), bases),
        bowl: combineBowl(wl.slice(-RECENT), bases),
        batN: Math.min(RECENT, bl.length),
        bowlN: Math.min(RECENT, wl.length),
      },
      qualifies: { bat: balls >= minBat, bowl: wBalls >= minBowl },
      signal: { kind: 'hold', label: 'Hold', reasons: [] },
    };
    p.role = roleOf(p);
    if (p.idx.bat && p.idx.bowl && p.qualifies.bat && p.qualifies.bowl)
      p.idx.ar = Math.sqrt(p.idx.bat.idx * p.idx.bowl.idx);
    p.signal = signalOf(p, bases);
    players.push(p);
  }
  return players.sort((a, b) => b.matches - a.matches || a.name.localeCompare(b.name));
}

/** Keeper if they've made a stumping; bowler/batter/all-rounder by how they're used. */
export function roleOf(p: Pick<ProPlayer, 'bat' | 'bowl' | 'field' | 'matches'>): ProRole {
  if (p.field.st > 0) return 'Wicketkeeper';
  const games = Math.max(1, p.matches);
  const oversPerGame = p.bowl.balls / 6 / games;
  const topSeven = p.bat.avgPos !== null && p.bat.avgPos <= 7.5 && p.bat.balls / games >= 12;
  if (oversPerGame >= 2 && topSeven) return 'All-rounder';
  if (oversPerGame >= 2) return 'Bowler';
  return 'Batter';
}

const pct = (idx: number) =>
  `${Math.abs(Math.round(idx - 100))}% ${idx >= 100 ? 'above' : 'below'}`;
const fmt1 = (v: number) => (Math.round(v * 10) / 10).toString();

/**
 * The selection signal, in plain words. Promote: the last five are well above average and the
 * season holds up. Drop: the last five are well below and so is the season. Watch: a dip from a
 * good season, a hot streak on a thin season, or too few games to say.
 */
export function signalOf(p: ProPlayer, bases: Record<ProFormat, Baseline | null>): Signal {
  void bases;
  const primary: 'bat' | 'bowl' =
    p.role === 'Bowler'
      ? 'bowl'
      : p.role === 'All-rounder'
        ? (p.recent.bowl?.idx ?? 0) > (p.recent.bat?.idx ?? 0)
          ? 'bowl'
          : 'bat'
        : 'bat';
  const recent = p.recent[primary];
  const season = p.idx[primary];
  const n = primary === 'bat' ? p.recent.batN : p.recent.bowlN;
  const enough = primary === 'bat' ? p.qualifies.bat : p.qualifies.bowl;
  const reasons: string[] = [];
  const lastN = primary === 'bat' ? p.bat.lines.slice(-RECENT) : [];
  const lastW = primary === 'bowl' ? p.bowl.lines.slice(-RECENT) : [];
  if (primary === 'bat' && lastN.length) {
    const r = sum(lastN, (l) => l.r);
    const b = sum(lastN, (l) => l.b);
    reasons.push(
      `Last ${lastN.length} innings: ${r} runs off ${b} balls${b ? ` (SR ${Math.round((r / b) * 100)})` : ''}`,
    );
  }
  if (primary === 'bowl' && lastW.length) {
    const w = sum(lastW, (l) => l.w);
    const b = sum(lastW, (l) => l.balls);
    const r = sum(lastW, (l) => l.r);
    reasons.push(
      `Last ${lastW.length} spells: ${w} wicket${w === 1 ? '' : 's'} in ${Math.floor(b / 6)}${b % 6 ? `.${b % 6}` : ''} overs at ${fmt1((r / b) * 6)} an over`,
    );
  }
  if (!recent || !season || !enough || n < 3)
    return {
      kind: 'watch',
      label: 'Small sample',
      reasons: [...reasons, 'Too few balls this season to rate fairly — keep watching'],
    };
  reasons.push(`Recent form ${pct(recent.idx)} average · season ${pct(season.idx)}`);
  const share = p.squadMatches ? p.matches / p.squadMatches : 1;
  if (recent.idx >= 115 && season.idx >= 100) {
    if (share < 0.6) reasons.push(`Played ${p.matches} of ${p.squadMatches} games — earn more`);
    if (primary === 'bat' && p.bat.avgPos !== null && p.bat.avgPos > 5.5 && recent.idx >= 125)
      reasons.push(`Batting at ${fmt1(p.bat.avgPos)} on average — try higher up`);
    return { kind: 'promote', label: share < 0.6 ? 'Promote' : 'In form', reasons };
  }
  if (recent.idx <= 80 && season.idx <= 92) {
    if (primary === 'bat') {
      const cheap = lastN.filter((l) => l.isOut && l.r < 10).length;
      if (cheap >= 2) reasons.push(`Out for under 10 in ${cheap} of the last ${lastN.length}`);
    }
    return { kind: 'drop', label: 'At risk', reasons };
  }
  if (recent.idx <= 85) return { kind: 'watch', label: 'Dip in form', reasons };
  if (recent.idx >= 120) return { kind: 'watch', label: 'Hot streak', reasons };
  return { kind: 'hold', label: 'Hold', reasons };
}

/* ─── Team level ─── */

export interface TeamSummary {
  played: number;
  won: number;
  lost: number;
  drawn: number;
  tied: number;
  noResult: number;
  results: {
    match: ProMatch;
    opp: string;
    outcome: 'W' | 'L' | 'D' | 'T' | 'NR';
    our: string;
    their: string;
  }[];
}

export function teamSummary(squad: Squad, ms: ProMatch[]): TeamSummary {
  const results = ms.map((m) => {
    const ours = (m.innings ?? []).filter((i) => isUs(squad, i.bat));
    const theirs = (m.innings ?? []).filter((i) => !isUs(squad, i.bat));
    const fmtInn = (xs: ScoutInnings[]) =>
      xs.map((i) => `${i.total}${i.wkts < 10 ? `/${i.wkts}` : ''}`).join(' & ') || '—';
    const outcome: TeamSummary['results'][number]['outcome'] =
      m.resultKind === 'tie'
        ? 'T'
        : m.resultKind === 'draw'
          ? 'D'
          : !m.winner
            ? 'NR'
            : isUs(squad, m.winner)
              ? 'W'
              : 'L';
    return {
      match: m,
      opp: opponentOf(squad, m),
      outcome,
      our: fmtInn(ours),
      their: fmtInn(theirs),
    };
  });
  const c = (o: string) => results.filter((r) => r.outcome === o).length;
  return {
    played: ms.length,
    won: c('W'),
    lost: c('L'),
    drawn: c('D'),
    tied: c('T'),
    noResult: c('NR'),
    results,
  };
}

/** Phases of an innings, by format (multi-day: new ball, middle, second new ball). */
export const PHASES: Record<ProFormat, { label: string; from: number; to: number }[]> = {
  T20: [
    { label: 'Powerplay 1–6', from: 1, to: 6 },
    { label: 'Middle 7–15', from: 7, to: 15 },
    { label: 'Death 16–20', from: 16, to: 20 },
  ],
  'One-Day': [
    { label: 'Powerplay 1–10', from: 1, to: 10 },
    { label: 'Middle 11–40', from: 11, to: 40 },
    { label: 'Death 41–50', from: 41, to: 50 },
  ],
  'Multi-day': [
    { label: 'New ball 1–20', from: 1, to: 20 },
    { label: 'Middle 21–80', from: 21, to: 80 },
    { label: '2nd new ball 81+', from: 81, to: 999 },
  ],
};

/** The over number (1-based) a wicket fell in, from "15.2" → 16; "15" (end of over) → 15. */
export const overOfWicket = (over: string) => {
  const [o, b] = String(over).split('.').map(Number);
  return b ? o + 1 : Math.max(1, o);
};

/**
 * Wickets lost (batting) and taken (bowling) per phase, from the fall of wickets — the only
 * by-phase signal a scorecard carries. Per innings, so formats with different innings counts
 * compare.
 */
export function wicketsByPhase(squad: Squad, ms: ProMatch[], format: ProFormat) {
  const phases = PHASES[format];
  const lost = phases.map(() => 0);
  const taken = phases.map(() => 0);
  let ourInns = 0;
  let theirInns = 0;
  for (const m of ms.filter((x) => x.format === format))
    for (const inn of m.innings ?? []) {
      const us = isUs(squad, inn.bat);
      if (us) ourInns++;
      else theirInns++;
      for (const f of inn.fow) {
        const o = overOfWicket(f.over);
        const i = phases.findIndex((p) => o >= p.from && o <= p.to);
        if (i < 0) continue;
        if (us) lost[i]++;
        else taken[i]++;
      }
    }
  return phases.map((p, i) => ({
    phase: p.label,
    lostPerInns: ourInns ? lost[i] / ourInns : 0,
    takenPerInns: theirInns ? taken[i] / theirInns : 0,
    lost: lost[i],
    taken: taken[i],
  }));
}

/** Our innings and theirs, split, for the team-level comparisons. */
export function inningsSplit(squad: Squad, ms: ProMatch[]) {
  const ours: ScoutInnings[] = [];
  const theirs: ScoutInnings[] = [];
  ms.forEach((m) => (m.innings ?? []).forEach((i) => (isUs(squad, i.bat) ? ours : theirs).push(i)));
  return { ours, theirs };
}

export function teamComparisons(squad: Squad, ms: ProMatch[]) {
  const { ours, theirs } = inningsSplit(squad, ms);
  const rate = (xs: ScoutInnings[]) => {
    const balls = sum(xs, (i) => oversToBalls(i.overs));
    return balls ? (sum(xs, (i) => i.total) / balls) * 6 : 0;
  };
  const perInns = (xs: ScoutInnings[], f: (i: ScoutInnings) => number) =>
    xs.length ? sum(xs, f) / xs.length : 0;
  const extrasPer10 = (xs: ScoutInnings[]) => {
    // Extras conceded by the fielding side: our bowling = their innings.
    const balls = sum(xs, (i) => oversToBalls(i.overs));
    return balls ? (sum(xs, (i) => i.exb.w + i.exb.nb) / balls) * 60 : 0;
  };
  const dotShare = (xs: ScoutInnings[]) => {
    const balls = sum(xs, (i) => oversToBalls(i.overs));
    return balls ? (sum(xs, (i) => sum(i.bowling, (b) => b.dots)) / balls) * 100 : 0;
  };
  const topOrder = (xs: ScoutInnings[]) => {
    const at3 = xs.filter((i) => i.fow[2]).map((i) => i.fow[2].score);
    return at3.length ? sum(at3, (x) => x) / at3.length : null;
  };
  return {
    ours,
    theirs,
    runRate: { ours: rate(ours), theirs: rate(theirs) },
    runsPerInns: { ours: perInns(ours, (i) => i.total), theirs: perInns(theirs, (i) => i.total) },
    /** Wides + no-balls bowled per 10 overs: our discipline is in their innings. */
    widesNoBallsPer10: { ours: extrasPer10(theirs), theirs: extrasPer10(ours) },
    /** Dot-ball share forced with the ball: ours = their innings. */
    dotPct: { ours: dotShare(theirs), theirs: dotShare(ours) },
    scoreAt3rdWicket: { ours: topOrder(ours), theirs: topOrder(theirs) },
    partnerships: { ours: partnershipByWicket(ours), theirs: partnershipByWicket(theirs) },
    runSources: { ours: runSources(ours), theirs: runSources(theirs) },
    dismissalsSuffered: dismissalTally(ours),
    dismissalsTaken: dismissalTally(theirs),
  };
}

function dismissalTally(inns: ScoutInnings[]) {
  const c = emptyDismissals();
  inns.forEach((i) =>
    i.batting.forEach((r) => {
      const k = dismissalKind(r.out);
      if (k) c[k]++;
    }),
  );
  return c;
}

/** Runs and balls by batting position slot, for the batting-order picture. */
export function orderContribution(squad: Squad, ms: ProMatch[]) {
  const { ours } = inningsSplit(squad, ms);
  const slots = Array.from({ length: 11 }, (_, i) => ({
    pos: i + 1,
    runs: 0,
    balls: 0,
    inns: 0,
    outs: 0,
    players: new Map<string, number>(),
  }));
  ours.forEach((inn) =>
    inn.batting.forEach((r) => {
      const s = slots[r.pos - 1];
      if (!s || !battedIn(r)) return;
      s.runs += r.r;
      s.balls += r.b;
      s.inns++;
      if (isOut(r)) s.outs++;
      s.players.set(r.n, (s.players.get(r.n) ?? 0) + 1);
    }),
  );
  return slots.map((s) => ({
    pos: s.pos,
    inns: s.inns,
    avg: s.outs ? s.runs / s.outs : s.inns ? s.runs : 0,
    sr: s.balls ? (s.runs / s.balls) * 100 : 0,
    regulars: [...s.players]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([n, k]) => ({ n, k })),
  }));
}
