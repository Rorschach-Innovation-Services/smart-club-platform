/* ─── Scouting: pure derivations over a ScoutingEvent (no React) ─── */

import type { ScoutPlayer, ScoutProfile, ScoutingEvent } from './scouting-data';
import type { ScoutMatch, ScoutInnings, ScoutBatRow, ScoutBowlRow } from './scouting-matches';

export type LeaderMetric = 'runs' | 'wkts' | 'sr' | 'econ' | 'dismissals';

export interface LeaderDef {
  key: LeaderMetric;
  label: string;
  /** Short qualifier shown under the chart, e.g. the sample-size floor. */
  note: string;
  /** Lower is better (economy). */
  ascending?: boolean;
  value: (p: ScoutPlayer) => number | null;
  qualifies: (p: ScoutPlayer) => boolean;
  format: (v: number) => string;
}

// Sample-size floors match the source report (40+ balls faced, 8+ overs bowled).
export const MIN_BALLS_FACED = 40;
export const MIN_BALLS_BOWLED = 48;

const dismissals = (p: ScoutPlayer) => (p.ct ?? 0) + (p.st ?? 0) + (p.ro ?? 0);

export const LEADERS: LeaderDef[] = [
  {
    key: 'runs',
    label: 'Most runs',
    note: 'All batters',
    value: (p) => p.runs,
    qualifies: (p) => (p.runs ?? 0) > 0,
    format: (v) => String(v),
  },
  {
    key: 'wkts',
    label: 'Most wickets',
    note: 'Run-outs excluded',
    value: (p) => p.wkts,
    qualifies: (p) => (p.wkts ?? 0) > 0,
    format: (v) => String(v),
  },
  {
    key: 'sr',
    label: 'Strike rate',
    note: `${MIN_BALLS_FACED}+ balls faced`,
    value: (p) => p.sr,
    qualifies: (p) => (p.balls ?? 0) >= MIN_BALLS_FACED,
    format: (v) => v.toFixed(1),
  },
  {
    key: 'econ',
    label: 'Economy',
    note: `${MIN_BALLS_BOWLED / 6}+ overs · lower is better`,
    ascending: true,
    value: (p) => p.econ,
    qualifies: (p) => (p.ballsBowled ?? 0) >= MIN_BALLS_BOWLED,
    format: (v) => v.toFixed(2),
  },
  {
    key: 'dismissals',
    label: 'Fielding',
    note: 'Catches + stumpings + run-outs',
    value: (p) => dismissals(p),
    qualifies: (p) => dismissals(p) > 0,
    format: (v) => String(v),
  },
];

export const leaderDef = (key: LeaderMetric) => LEADERS.find((l) => l.key === key)!;

/** Ranked leaderboard for one metric, optionally limited to a hub. Ties break on name. */
export function leaderboard(players: ScoutPlayer[], key: LeaderMetric, hub = '', limit = 15) {
  const def = leaderDef(key);
  return players
    .filter((p) => (!hub || p.hub === hub) && def.qualifies(p) && def.value(p) != null)
    .map((p) => ({ player: p, value: def.value(p) as number }))
    .sort((a, b) =>
      a.value === b.value
        ? a.player.name.localeCompare(b.player.name)
        : def.ascending
          ? a.value - b.value
          : b.value - a.value,
    )
    .slice(0, limit);
}

/** Overs as cricket notation from legal balls (133 → "22.1"). */
export const oversOf = (balls: number | null) =>
  balls == null ? '–' : `${Math.floor(balls / 6)}${balls % 6 ? `.${balls % 6}` : ''}`;

export const ballsPerWicket = (p: ScoutPlayer) =>
  p.wkts && p.ballsBowled ? p.ballsBowled / p.wkts : null;

export type PlayerRole = 'batter' | 'bowler' | 'all-rounder' | 'squad';

/**
 * A light role read from the numbers — 40+ runs or 40+ balls faced counts as batting,
 * 4+ overs as bowling. Used for filtering only, never as a label of record.
 */
export function roleOf(p: ScoutPlayer): PlayerRole {
  const bats = (p.runs ?? 0) >= 40 || (p.balls ?? 0) >= 40;
  const bowls = (p.ballsBowled ?? 0) >= 24;
  if (bats && bowls) return 'all-rounder';
  if (bowls) return 'bowler';
  if (bats) return 'batter';
  return 'squad';
}

/** Runs plus 20 per wicket — the source register's ordering, used as a contribution score. */
export const contribution = (p: ScoutPlayer) => (p.runs ?? 0) + 20 * (p.wkts ?? 0);

export function profileFor(event: ScoutingEvent, name: string): ScoutProfile[] {
  return event.profiles.filter((p) => p.name === name);
}

export function median(values: number[]) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Batters for the scoring-speed v reliability map (avg falls back to runs when never out). */
export function batterPoints(players: ScoutPlayer[]) {
  return players
    .filter((p) => (p.balls ?? 0) >= MIN_BALLS_FACED && p.sr != null)
    .map((p) => ({ player: p, x: p.sr as number, y: p.avg ?? (p.runs as number) }));
}

/** Bowlers for the control v wicket-taking map (8+ overs and at least one wicket). */
export function bowlerPoints(players: ScoutPlayer[]) {
  return players
    .filter((p) => (p.ballsBowled ?? 0) >= MIN_BALLS_BOWLED && (p.wkts ?? 0) > 0 && p.econ != null)
    .map((p) => ({ player: p, x: p.econ as number, y: ballsPerWicket(p) as number }));
}

/**
 * Index ratings within one competition, as in the national scouting report: 100 = the
 * competition's average; small samples are blended with that average as if the player had
 * faced 30 more balls (bowled 24) at the average rate; batting index = √(runs-per-innings
 * index × strike-rate index), bowling index = √(economy index × wicket-rate index).
 * Runs per innings uses matches batted in (these events are one innings a side).
 */
export interface EventIndex {
  player: ScoutPlayer;
  bat: { rpiIdx: number; srIdx: number; idx: number } | null;
  bowl: { econIdx: number; wktIdx: number; idx: number } | null;
  qualifiesBat: boolean;
  qualifiesBowl: boolean;
}

export function eventIndices(players: ScoutPlayer[]): EventIndex[] {
  const batters = players.filter((p) => (p.balls ?? 0) > 0 && p.runs !== null);
  const bowlers = players.filter((p) => (p.ballsBowled ?? 0) > 0 && p.runsConceded !== null);
  const sum = (xs: ScoutPlayer[], f: (p: ScoutPlayer) => number | null) =>
    xs.reduce((n, p) => n + (f(p) ?? 0), 0);
  const lgRuns = sum(batters, (p) => p.runs);
  const lgBalls = sum(batters, (p) => p.balls);
  const lgInns = sum(batters, (p) => p.m);
  const lgSR = lgBalls ? (lgRuns / lgBalls) * 100 : 0;
  const lgRPI = lgInns ? lgRuns / lgInns : 0;
  const lgBallsPerInns = lgInns ? lgBalls / lgInns : 1;
  const lgBowlBalls = sum(bowlers, (p) => p.ballsBowled);
  const lgEcon = lgBowlBalls ? (sum(bowlers, (p) => p.runsConceded) / lgBowlBalls) * 6 : 0;
  const lgWkts = sum(bowlers, (p) => p.wkts);
  const lgBPW = lgWkts ? lgBowlBalls / lgWkts : 0;
  const K_BAT = 30;
  const K_BOWL = 24;
  return players.map((p) => {
    let bat: EventIndex['bat'] = null;
    if ((p.balls ?? 0) > 0 && p.runs !== null && lgSR && lgRPI) {
      const sr = ((p.runs + (K_BAT * lgSR) / 100) / (p.balls! + K_BAT)) * 100;
      const kInns = K_BAT / lgBallsPerInns;
      const rpi = (p.runs + kInns * lgRPI) / (Math.max(1, p.m) + kInns);
      const rpiIdx = (rpi / lgRPI) * 100;
      const srIdx = (sr / lgSR) * 100;
      bat = { rpiIdx, srIdx, idx: Math.sqrt(rpiIdx * srIdx) };
    }
    let bowl: EventIndex['bowl'] = null;
    if ((p.ballsBowled ?? 0) > 0 && p.runsConceded !== null && lgEcon && lgBPW) {
      const b = p.ballsBowled!;
      const econ = ((p.runsConceded + (K_BOWL * lgEcon) / 6) / (b + K_BOWL)) * 6;
      const wpb = ((p.wkts ?? 0) + K_BOWL / lgBPW) / (b + K_BOWL);
      const econIdx = (lgEcon / econ) * 100;
      const wktIdx = wpb * lgBPW * 100;
      bowl = { econIdx, wktIdx, idx: Math.sqrt(econIdx * wktIdx) };
    }
    return {
      player: p,
      bat,
      bowl,
      qualifiesBat: (p.balls ?? 0) >= MIN_BALLS_FACED,
      qualifiesBowl: (p.ballsBowled ?? 0) >= MIN_BALLS_BOWLED,
    };
  });
}

export function teamName(event: ScoutingEvent, code: string) {
  return event.teams.find((t) => t.code === code)?.name ?? code;
}

/** Top run-scorer and wicket-taker per hub (for team cards). */
export function hubLeaders(event: ScoutingEvent, code: string) {
  const squad = event.players.filter((p) => p.hub === code);
  return {
    squad: squad.length,
    topBat: leaderboard(squad, 'runs', '', 1)[0] ?? null,
    topBowl: leaderboard(squad, 'wkts', '', 1)[0] ?? null,
  };
}

/* ─── Match-level derivations (scorecards) ─── */

const ballsOf = (o: string) => {
  const [a, b] = String(o).split('.');
  return Number(a) * 6 + Number(b || 0);
};
export const ballsFromOvers = ballsOf;

/**
 * The fielder(s) credited in a dismissal — "c X b Y", "st X b Y", "c & b Y" (the bowler),
 * or "run out (X)" / "run out (X+Y)" when the scorer named them; null otherwise.
 */
export function fielderOf(out: string): { names: string[]; kind: 'ct' | 'st' | 'ro' } | null {
  const ro = /^run out \((.+?)\)/.exec(out || '');
  if (ro)
    return {
      names: ro[1]
        .split(/[+/]/)
        .map((n) => n.trim())
        .filter(Boolean),
      kind: 'ro',
    };
  const m = /^(c|st) (.+?) b (.+)$/.exec(out || '');
  if (!m || m[2] === '?') return null;
  return { names: [m[2] === '&' ? m[3] : m[2]], kind: m[1] === 'st' ? 'st' : 'ct' };
}

/** The bowler credited with a dismissal ("b X", "lbw b X", "c Y b X", "st Y b X", "c & b X"). */
export function bowlerOf(out: string): string | null {
  const m = /(?:^|\s)b (.+)$/.exec(out || '');
  return m ? m[1].trim() : null;
}

export const isOut = (row: ScoutBatRow) => !!row.out && !/^not out|^retired/.test(row.out);

export interface PlayerMatchLine {
  match: ScoutMatch;
  opp: string;
  bat: ScoutBatRow | null;
  bowl: ScoutBowlRow | null;
  ct: number;
  st: number;
  ro: number;
}

/** Every recorded match a player appeared in, oldest first. */
export function playerLog(event: ScoutingEvent, name: string, hub: string): PlayerMatchLine[] {
  const out: PlayerMatchLine[] = [];
  event.matches.forEach((m) => {
    if (!m.innings || (m.home !== hub && m.away !== hub)) return;
    let bat: ScoutBatRow | null = null;
    let bowl: ScoutBowlRow | null = null;
    let ct = 0;
    let st = 0;
    let ro = 0;
    m.innings.forEach((inn) => {
      if (inn.bat === hub) bat = inn.batting.find((r) => r.n === name) ?? bat;
      if (inn.fld === hub) {
        bowl = inn.bowling.find((r) => r.n === name) ?? bowl;
        inn.batting.forEach((r) => {
          const f = fielderOf(r.out);
          if (!f?.names.includes(name)) return;
          if (f.kind === 'st') st++;
          else if (f.kind === 'ro') ro++;
          else ct++;
        });
      }
    });
    if (bat || bowl || ct || st || ro)
      out.push({ match: m, opp: m.home === hub ? m.away : m.home, bat, bowl, ct, st, ro });
  });
  return out.sort((a, b) => a.match.date.localeCompare(b.match.date));
}

/** A player's record against each opponent, from their match log. */
export function vsTeams(log: PlayerMatchLine[]) {
  const by = new Map<
    string,
    {
      opp: string;
      m: number;
      inns: number;
      outs: number;
      runs: number;
      balls: number;
      wkts: number;
      conc: number;
      bb: number;
      ct: number;
    }
  >();
  log.forEach((l) => {
    const r = by.get(l.opp) ?? {
      opp: l.opp,
      m: 0,
      inns: 0,
      outs: 0,
      runs: 0,
      balls: 0,
      wkts: 0,
      conc: 0,
      bb: 0,
      ct: 0,
    };
    r.m++;
    if (l.bat) {
      r.inns++;
      r.runs += l.bat.r;
      r.balls += l.bat.b;
      if (isOut(l.bat)) r.outs++;
    }
    if (l.bowl) {
      r.wkts += l.bowl.w;
      r.conc += l.bowl.r;
      r.bb += ballsOf(l.bowl.o);
    }
    r.ct += l.ct + l.st + l.ro;
    by.set(l.opp, r);
  });
  return [...by.values()].sort((a, b) => a.opp.localeCompare(b.opp));
}

/** Short text line for a match performance, e.g. "64 (52) · 1/12 (3) · 1 ct". */
export function performanceLine(l: PlayerMatchLine) {
  const bits: string[] = [];
  if (l.bat) bits.push(`${l.bat.r}${isOut(l.bat) ? '' : '*'} (${l.bat.b})`);
  if (l.bowl) bits.push(`${l.bowl.w}/${l.bowl.r} (${l.bowl.o})`);
  if (l.ct) bits.push(`${l.ct} ct`);
  if (l.st) bits.push(`${l.st} st`);
  if (l.ro) bits.push(`${l.ro} ro`);
  return bits.join(' · ') || 'Fielded';
}

/**
 * Runs, balls and wickets by phase, scaled to the allocated overs as in the source
 * report: the first 30% is the powerplay, the last 20% the death, the rest the middle.
 */
export function phaseSplit(inn: ScoutInnings, allocated: number) {
  const pp = Math.max(1, Math.round(allocated * 0.3));
  const death = allocated - Math.max(1, Math.round(allocated * 0.2));
  const phases = [
    { key: 'Powerplay', from: 1, to: pp },
    { key: 'Middle', from: pp + 1, to: death },
    { key: 'Death', from: death + 1, to: allocated },
  ];
  return phases.map((p) => {
    const overs = inn.perOver.filter(([o]) => o >= p.from && o <= p.to);
    const runs = overs.reduce((n, [, r]) => n + r, 0);
    const wkts = overs.reduce((n, [, , w]) => n + w, 0);
    return { ...p, overs: overs.length, runs, wkts, rr: overs.length ? runs / overs.length : null };
  });
}

/** Partnerships from the fall of wickets (the last one unbroken unless all out). */
export function partnerships(inn: ScoutInnings) {
  const out: { wkt: number; runs: number; unbroken: boolean }[] = [];
  let prev = 0;
  inn.fow.forEach((f) => {
    out.push({ wkt: f.wkt, runs: f.score - prev, unbroken: false });
    prev = f.score;
  });
  if (inn.wkts < 10 && inn.total > prev)
    out.push({ wkt: inn.fow.length + 1, runs: inn.total - prev, unbroken: true });
  return out;
}

/** Cumulative runs after each over, for the worm chart. */
export function worm(inn: ScoutInnings) {
  let total = 0;
  return inn.perOver.map(([o, r, w]) => {
    total += r;
    return { over: o, total, wkts: w };
  });
}

export function innStats(inn: ScoutInnings) {
  const balls = ballsOf(inn.overs);
  const fours = inn.batting.reduce((n, r) => n + r.f4, 0);
  const sixes = inn.batting.reduce((n, r) => n + r.f6, 0);
  return { balls, rr: balls ? (inn.total * 6) / balls : 0, fours, sixes };
}

/** Dots bowled by the side fielding in this innings (as a share of legal balls). */
export function dotPct(inn: ScoutInnings) {
  const dots = inn.bowling.reduce((n, r) => n + r.dots, 0);
  const balls = ballsOf(inn.overs);
  return balls ? (dots / balls) * 100 : 0;
}

/* ─── Team-view derivations (graphs) ─── */

/** Medicoach Live's eight scoring zones, in its zone-number order. */
export const ZONES = [
  { s: ['Third man', 'slips'], f: 'Third man and slips' },
  { s: ['Gully', 'point'], f: 'Gully and point' },
  { s: ['Cover'], f: 'Cover' },
  { s: ['Extra cover', 'mid-off'], f: 'Extra cover and mid-off' },
  { s: ['Mid-on', 'long-on'], f: 'Mid-on and long-on' },
  { s: ['Mid-wicket'], f: 'Mid-wicket' },
  { s: ['Square leg'], f: 'Square leg' },
  { s: ['Fine leg', 'leg slip'], f: 'Fine leg and leg slip' },
];

export interface Shot {
  runs: number;
  zone: number;
  batter: string;
  bowler: string;
}

/** Scoring shots with a recorded zone (needs ball-by-ball data). */
export function shotsOf(inns: ScoutInnings[], filter: { batter?: string; bowler?: string } = {}) {
  const out: Shot[] = [];
  inns.forEach((inn) =>
    (inn.balls ?? []).forEach(([, , batter, bowler, runs, , , , zone]) => {
      if (runs <= 0 || zone < 0 || zone > 7) return;
      if (filter.batter && batter !== filter.batter) return;
      if (filter.bowler && bowler !== filter.bowler) return;
      out.push({ runs, zone, batter, bowler });
    }),
  );
  return out;
}

export const hasBallData = (inns: ScoutInnings[]) => inns.some((i) => (i.balls?.length ?? 0) > 0);

export function zoneRuns(shots: Shot[]) {
  const z = Array(8).fill(0) as number[];
  shots.forEach((s) => (z[s.zone] += s.runs));
  return z;
}

/** A team's innings: batting (inn.bat === code) and bowling (inn.fld === code), oldest first. */
export function teamInnings(event: ScoutingEvent, code: string) {
  const bat: { match: ScoutMatch; inn: ScoutInnings }[] = [];
  const bowl: { match: ScoutMatch; inn: ScoutInnings }[] = [];
  [...event.matches]
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach((m) =>
      m.innings?.forEach((inn) => {
        if (inn.bat === code) bat.push({ match: m, inn });
        if (inn.fld === code) bowl.push({ match: m, inn });
      }),
    );
  return { bat, bowl };
}

export type DismissalKind = 'Bowled' | 'Caught' | 'LBW' | 'Run out' | 'Stumped' | 'Other';
export const DISMISSAL_KINDS: DismissalKind[] = [
  'Bowled',
  'Caught',
  'LBW',
  'Run out',
  'Stumped',
  'Other',
];

export function dismissalKind(out: string): DismissalKind | null {
  if (!out || /^not out|^retired/.test(out)) return null;
  if (/^run out/.test(out)) return 'Run out';
  if (/^lbw/.test(out)) return 'LBW';
  if (/^st /.test(out)) return 'Stumped';
  if (/^c /.test(out)) return 'Caught';
  if (/^b /.test(out)) return 'Bowled';
  return 'Other';
}

export function dismissalCounts(inns: ScoutInnings[]) {
  const c = Object.fromEntries(DISMISSAL_KINDS.map((k) => [k, 0])) as Record<DismissalKind, number>;
  inns.forEach((inn) =>
    inn.batting.forEach((r) => {
      const k = dismissalKind(r.out);
      if (k) c[k]++;
    }),
  );
  return c;
}

/** Where the runs came from: boundaries, running, extras (+ any the scorer left unattributed). */
export function runSources(inns: ScoutInnings[]) {
  let boundaries = 0;
  let offBat = 0;
  let extras = 0;
  let total = 0;
  inns.forEach((inn) => {
    inn.batting.forEach((r) => {
      boundaries += r.f4 * 4 + r.f6 * 6;
      offBat += r.r;
    });
    extras += inn.extras;
    total += inn.total;
  });
  return {
    boundaries,
    running: Math.max(0, offBat - boundaries),
    extras,
    unattributed: Math.max(0, total - offBat - extras),
    total,
  };
}

/** Total runs and innings by batting position (1–11). */
export function runsByPosition(inns: ScoutInnings[]) {
  const rows = Array.from({ length: 11 }, (_, i) => ({ pos: i + 1, runs: 0, inns: 0, outs: 0 }));
  inns.forEach((inn) =>
    inn.batting.forEach((r) => {
      const row = rows[r.pos - 1];
      if (!row) return;
      row.runs += r.r;
      row.inns++;
      if (isOut(r)) row.outs++;
    }),
  );
  return rows;
}

/** Average and best partnership for each wicket across innings. */
export function partnershipByWicket(inns: ScoutInnings[]) {
  const rows = Array.from({ length: 10 }, (_, i) => ({ wkt: i + 1, total: 0, n: 0, best: 0 }));
  inns.forEach((inn) =>
    partnerships(inn).forEach((p) => {
      const row = rows[p.wkt - 1];
      if (!row) return;
      row.total += p.runs;
      row.n++;
      row.best = Math.max(row.best, p.runs);
    }),
  );
  return rows.map((r) => ({ ...r, avg: r.n ? r.total / r.n : 0 }));
}

/** Who bowls a team's overs, with economy and dot-ball share. */
export function bowlingUsage(inns: ScoutInnings[]) {
  const by = new Map<
    string,
    { n: string; balls: number; runs: number; wkts: number; dots: number; wd: number }
  >();
  inns.forEach((inn) =>
    inn.bowling.forEach((b) => {
      const r = by.get(b.n) ?? { n: b.n, balls: 0, runs: 0, wkts: 0, dots: 0, wd: 0 };
      r.balls += ballsOf(b.o);
      r.runs += b.r;
      r.wkts += b.w;
      r.dots += b.dots;
      r.wd += b.wd;
      by.set(b.n, r);
    }),
  );
  return [...by.values()]
    .map((r) => ({
      ...r,
      econ: r.balls ? (r.runs * 6) / r.balls : 0,
      dotPct: r.balls ? (r.dots / r.balls) * 100 : 0,
    }))
    .sort((a, b) => b.balls - a.balls);
}
