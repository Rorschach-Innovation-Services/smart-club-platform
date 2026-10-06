/**
 * Developmental milestones: what a player's numbers look like at each stage of the pathway, from
 * age-group cricket to the professional game, and who stands out against them. Pure.
 *
 * There are no dates of birth in any of the sources, so a stage is the level of cricket, not an
 * age: an age-group event (its age group), senior club cricket, the national scouting report's
 * selected club players, and the franchises. Each stage is summarised per format and gender —
 * the spread of strike rate, runs per innings, economy and wickets — and a player is rated
 * against the stage's median (100 = typical for that stage), shrunk towards 100 on a small
 * sample the way the national report does (30/60/120 balls faced, 24/48/96 balls bowled).
 *
 * From that:
 *   - the bar at each stage (quartiles, and the top 10% — the benchmark),
 *   - the benchmark players at each stage, and the outliers well clear of their stage,
 *   - season-on-season improvers in the professional game,
 *   - players seen at two stages (club → franchise) and where they stood at each.
 *
 * Raw numbers are not compared across stages: the opposition gets harder going up (franchise
 * T20 batters strike more slowly than the national report's club batters), and the report's
 * group is its selection — the top of club cricket, not all of it. Standing within a stage is
 * what carries from one stage to the next.
 */
import { normName } from './pro-exits';
import type { ProFormat, ProMatch } from './pro-scorecards';
import { shortTeam } from './pro-scorecards';
import type { ScoutPool } from './scout-pool';
import type { ScoutingEvent } from './scouting-data';
import type { ScoutMatch } from './scouting-matches';

export type Disc = 'bat' | 'bowl';
export type Gender = 'men' | 'women';
export type Format = ProFormat;

export interface Stage {
  key: string;
  label: string;
  /** Order up the pathway: an age group by its age, senior club 20, scouted 21, pro 30. */
  rung: number;
  /** Where the numbers came from, for the caption. */
  source: string;
}

/** One player's numbers at one stage, in one format (and season, where known). */
export interface Line {
  name: string;
  /** Normalised name, for finding the same player at another stage. */
  id: string;
  team: string;
  stage: Stage;
  gender: Gender;
  format: Format;
  season?: string;
  matches: number;
  inns: number;
  runs: number;
  balls: number;
  outs: number;
  f4: number;
  f6: number;
  bBalls: number;
  bRuns: number;
  wkts: number;
}

/* ─── Reading the sources ─── */

export const formatOfEvent = (event: string, overs?: number): Format => {
  const e = event.toLowerCase();
  if (/day|time|first class/.test(e)) return 'Multi-day';
  if (/t20|\b20\b|twenty/.test(e) || overs === 20) return 'T20';
  return 'One-Day';
};

export const stageOfAge = (ageGroup: string): Stage => {
  const m = /u\s?(\d{1,2})/i.exec(ageGroup);
  if (m)
    return { key: `U${m[1]}`, label: `U${m[1]}`, rung: Number(m[1]), source: 'age-group events' };
  return { key: 'senior', label: 'Senior club', rung: 20, source: 'club and university matches' };
};

export const SCOUTED: Stage = {
  key: 'scouted',
  label: 'Scouted club',
  rung: 21,
  source: 'national scouting report — its selection, the top of club cricket',
};
export const PRO: Stage = {
  key: 'pro',
  label: 'Professional',
  rung: 30,
  source: 'franchise scorecards',
};

const genderOfText = (t: string): Gender =>
  /\b(girls?|women|ladies)\b/i.test(t) ? 'women' : 'men';

const blank = (
  name: string,
  team: string,
  stage: Stage,
  gender: Gender,
  format: Format,
  season?: string,
): Line => ({
  name,
  id: normName(name),
  team,
  stage,
  gender,
  format,
  season,
  matches: 0,
  inns: 0,
  runs: 0,
  balls: 0,
  outs: 0,
  f4: 0,
  f6: 0,
  bBalls: 0,
  bRuns: 0,
  wkts: 0,
});

const ballsOf = (o: string) => {
  const [a, b] = String(o).split('.');
  return (Number(a) || 0) * 6 + (Number(b) || 0);
};

/**
 * Lines from scorecards (age-group events, club matches, the franchises). `seasons` splits a
 * player's lines by season (the professional game); events are one season each.
 */
export function linesFromMatches(
  ms: (ScoutMatch | ProMatch)[],
  stage: Stage,
  opts: {
    gender?: (m: ScoutMatch | ProMatch) => Gender;
    team?: (name: string) => string;
    seasons?: boolean;
  } = {},
): Line[] {
  const by = new Map<string, Line & { games: Set<string> }>();
  for (const m of ms) {
    const pm = m as ProMatch;
    const format: Format = pm.format ?? formatOfEvent(m.event, m.overs);
    const gender: Gender =
      opts.gender?.(m) ?? pm.gender ?? genderOfText(`${m.home} ${m.away} ${m.event}`);
    const season = opts.seasons ? pm.season : undefined;
    for (const inn of m.innings ?? []) {
      const get = (name: string, team: string) => {
        const k = `${normName(name)}|${format}|${gender}|${season ?? ''}`;
        const cur =
          by.get(k) ??
          ({
            ...blank(name, opts.team?.(team) ?? shortTeam(team), stage, gender, format, season),
            games: new Set<string>(),
          } as Line & { games: Set<string> });
        cur.games.add(m.id);
        by.set(k, cur);
        return cur;
      };
      for (const r of inn.batting) {
        const l = get(r.n, inn.bat);
        if (r.b > 0 || (r.out && !/not out|did not bat|dnb|absent/i.test(r.out))) l.inns++;
        l.runs += r.r;
        l.balls += r.b;
        l.f4 += r.f4;
        l.f6 += r.f6;
        if (r.out && !/not out|retired not|did not bat|dnb|absent/i.test(r.out)) l.outs++;
      }
      for (const r of inn.bowling) {
        const l = get(r.n, inn.fld);
        l.bBalls += ballsOf(r.o);
        l.bRuns += r.r;
        l.wkts += r.w;
      }
    }
  }
  return [...by.values()].map(({ games, ...l }) => ({ ...l, matches: games.size }));
}

/** Lines from a scouting pool (aggregates per player, T20 club cricket). */
export function linesFromPool(pool: ScoutPool, stage: Stage = SCOUTED): Line[] {
  const format: Format = /50|one|odi/i.test(pool.format ?? '') ? 'One-Day' : 'T20';
  return pool.players.map((p) => {
    const l = blank(p.name, p.club, stage, pool.gender === 'women' ? 'women' : 'men', format);
    const games = p.games ?? 0;
    l.matches = games;
    if (p.bat) {
      l.inns = p.bat.inns ?? games;
      l.runs = p.bat.runs;
      l.balls = p.bat.balls;
      l.f4 = p.bat.fours ?? 0;
      l.f6 = p.bat.sixes ?? 0;
      // Outs from the average where the report gives one.
      l.outs = p.bat.avg ? Math.round(p.bat.runs / p.bat.avg) : l.inns;
    }
    if (p.bowl) {
      l.bBalls = ballsOf(p.bowl.overs);
      l.bRuns = p.bowl.runs;
      l.wkts = p.bowl.wkts;
    }
    return l;
  });
}

/** Every stage the platform can see, as lines. */
export function allLines(
  events: ScoutingEvent[],
  pools: ScoutPool[],
  proMatches: ProMatch[],
): { lines: Line[]; proBySeason: Line[] } {
  const lines: Line[] = [];
  for (const ev of events) {
    const teamName = (code: string) => ev.teams.find((t) => t.code === code)?.name ?? code;
    lines.push(
      ...linesFromMatches(ev.matches, stageOfAge(ev.ageGroup), {
        gender: () => genderOfText(`${ev.name} ${ev.ageGroup}`),
        team: (t) => teamName(t),
      }),
    );
  }
  for (const pool of pools) lines.push(...linesFromPool(pool));
  lines.push(...linesFromMatches(proMatches, PRO));
  return { lines, proBySeason: linesFromMatches(proMatches, PRO, { seasons: true }) };
}

/* ─── Measures ─── */

export interface Metric {
  key: string;
  label: string;
  short: string;
  better: 'high' | 'low';
  fmt: (v: number) => string;
  value: (l: Line) => number | null;
}

const f0 = (v: number) => Math.round(v).toString();
const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);

export const METRICS: Record<Disc, Metric[]> = {
  bat: [
    {
      key: 'sr',
      label: 'Strike rate',
      short: 'SR',
      better: 'high',
      fmt: f0,
      value: (l) => (l.balls ? (l.runs / l.balls) * 100 : null),
    },
    {
      key: 'rpi',
      label: 'Runs per innings',
      short: 'Runs/inns',
      better: 'high',
      fmt: f1,
      value: (l) => (l.inns ? l.runs / l.inns : null),
    },
    {
      key: 'bnd',
      label: 'Boundary balls %',
      short: 'Bdry %',
      better: 'high',
      fmt: f0,
      value: (l) => (l.balls ? ((l.f4 + l.f6) / l.balls) * 100 : null),
    },
  ],
  bowl: [
    {
      key: 'econ',
      label: 'Economy',
      short: 'Econ',
      better: 'low',
      fmt: f2,
      value: (l) => (l.bBalls ? (l.bRuns / l.bBalls) * 6 : null),
    },
    {
      key: 'wp10',
      label: 'Wickets per 10 overs',
      short: 'Wkts/10',
      better: 'high',
      fmt: f2,
      value: (l) => (l.bBalls ? (l.wkts / l.bBalls) * 60 : null),
    },
  ],
};
export const metricOf = (disc: Disc, key: string) =>
  METRICS[disc].find((m) => m.key === key) ?? METRICS[disc][0];

/** The two measures each discipline's rating is built from. */
const CORE: Record<Disc, [string, string]> = { bat: ['sr', 'rpi'], bowl: ['econ', 'wp10'] };

/** Enough of a sample to count in a stage's spread. */
export const MIN: Record<Disc, Record<Format, number>> = {
  bat: { T20: 20, 'One-Day': 30, 'Multi-day': 60 },
  bowl: { T20: 24, 'One-Day': 36, 'Multi-day': 90 },
};
/** Shrinkage constants (balls) — the national report's. */
const K: Record<Disc, Record<Format, number>> = {
  bat: { T20: 30, 'One-Day': 60, 'Multi-day': 120 },
  bowl: { T20: 24, 'One-Day': 48, 'Multi-day': 96 },
};

export const sampleOf = (l: Line, disc: Disc) => (disc === 'bat' ? l.balls : l.bBalls);
/** Age-group cricket is short: a junior qualifies on half the senior sample. */
export const minFor = (l: Pick<Line, 'format' | 'stage'>, disc: Disc) =>
  l.stage.rung < 20 ? Math.ceil(MIN[disc][l.format] / 2) : MIN[disc][l.format];
export const qualifies = (l: Line, disc: Disc) =>
  sampleOf(l, disc) >= minFor(l, disc) && (disc === 'bowl' || l.inns >= 2);

export interface Quantiles {
  n: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export function quantiles(xs: number[]): Quantiles | null {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const q = (p: number) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  return { n: s.length, p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9) };
}

export interface StageRow {
  stage: Stage;
  q: Quantiles;
  /** The benchmark: the top 10% (p90, or p10 where lower is better). */
  benchmark: number;
}

/** Fewer qualifying players than this and a stage isn't drawn. */
export const MIN_PLAYERS = 8;

const select = (lines: Line[], gender: Gender, format: Format) =>
  lines.filter((l) => l.gender === gender && l.format === format);

/** The stages in this gender and format, bottom of the pathway first. */
export function stagesOf(lines: Line[], disc: Disc, gender: Gender, format: Format): Stage[] {
  const seen = new Map<string, { stage: Stage; n: number }>();
  for (const l of select(lines, gender, format))
    if (qualifies(l, disc)) {
      const s = seen.get(l.stage.key) ?? { stage: l.stage, n: 0 };
      s.n++;
      seen.set(l.stage.key, s);
    }
  return [...seen.values()]
    .filter((s) => s.n >= MIN_PLAYERS)
    .map((s) => s.stage)
    .sort((a, b) => a.rung - b.rung);
}

/** The spread of one measure at each stage. */
export function stageRows(
  lines: Line[],
  disc: Disc,
  metricKey: string,
  gender: Gender,
  format: Format,
): StageRow[] {
  const m = metricOf(disc, metricKey);
  return stagesOf(lines, disc, gender, format).flatMap((stage) => {
    const vals = select(lines, gender, format)
      .filter((l) => l.stage.key === stage.key && qualifies(l, disc))
      .map((l) => m.value(l))
      .filter((v): v is number => v !== null);
    const q = quantiles(vals);
    return q ? [{ stage, q, benchmark: m.better === 'high' ? q.p90 : q.p10 }] : [];
  });
}

/* ─── Ratings within a stage ─── */

export interface Rated {
  line: Line;
  /** Each core measure as an index, 100 = the stage median, shrunk on a small sample. */
  idx: Record<string, number>;
  /** sqrt of the two core indices — the overall rating. */
  rating: number;
  /** Share of the stage this rating is at least as good as. */
  pct: number;
}

const toIndex = (v: number, median: number, better: 'high' | 'low') =>
  median > 0 && v > 0 ? (better === 'high' ? v / median : median / v) * 100 : 100;

const shrink = (idx: number, n: number, k: number) => 100 + ((idx - 100) * n) / (n + k);

/** Medians of the core measures for a group of lines (the reference a rating is against). */
export function medians(group: Line[], disc: Disc): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of CORE[disc]) {
    const m = metricOf(disc, key);
    const q = quantiles(
      group
        .filter((l) => qualifies(l, disc))
        .map((l) => m.value(l))
        .filter((v): v is number => v !== null),
    );
    out[key] = q?.p50 ?? 0;
  }
  return out;
}

export function rate(l: Line, disc: Disc, ref: Record<string, number>): Omit<Rated, 'pct'> {
  const n = sampleOf(l, disc);
  const k = K[disc][l.format];
  const idx: Record<string, number> = {};
  for (const key of CORE[disc]) {
    const m = metricOf(disc, key);
    const v = m.value(l);
    idx[key] = v === null ? 100 : shrink(toIndex(v, ref[key], m.better), n, k);
  }
  const [a, b] = CORE[disc];
  return { line: l, idx, rating: Math.sqrt(Math.max(1, idx[a]) * Math.max(1, idx[b])) };
}

/** Every qualifying player at a stage, rated against that stage, best first. */
export function rateStage(
  lines: Line[],
  disc: Disc,
  gender: Gender,
  format: Format,
  stageKey: string,
): Rated[] {
  const group = select(lines, gender, format).filter(
    (l) => l.stage.key === stageKey && qualifies(l, disc),
  );
  const ref = medians(group, disc);
  const rated = group.map((l) => rate(l, disc, ref));
  const sorted = rated.map((r) => r.rating).sort((a, b) => a - b);
  return rated
    .map((r) => ({
      ...r,
      pct: Math.round((sorted.filter((x) => x <= r.rating).length / sorted.length) * 100),
    }))
    .sort((a, b) => b.rating - a.rating);
}

/** The benchmark players: the top 10% of each stage (at least three). */
export function benchmarkPlayers(
  lines: Line[],
  disc: Disc,
  gender: Gender,
  format: Format,
): { stage: Stage; players: Rated[]; of: number }[] {
  return stagesOf(lines, disc, gender, format).map((stage) => {
    const all = rateStage(lines, disc, gender, format, stage.key);
    return {
      stage,
      players: all.slice(0, Math.max(3, Math.ceil(all.length * 0.1))),
      of: all.length,
    };
  });
}

/* ─── Outliers within each stage ─── */

/** Both core measures at least this far above the stage median: an all-round outlier. */
export const OUTLIER_IDX = 115;

/** Everyone qualifying at every stage, rated against their own stage. */
export function stageRatings(lines: Line[], disc: Disc, gender: Gender, format: Format): Rated[] {
  return stagesOf(lines, disc, gender, format).flatMap((s) =>
    rateStage(lines, disc, gender, format, s.key),
  );
}

export const isOutlier = (r: Rated, disc: Disc) => CORE[disc].every((k) => r.idx[k] >= OUTLIER_IDX);

/* ─── Improvers: season on season in the professional game ─── */

export interface Move {
  id: string;
  name: string;
  team: string;
  from: string;
  to: string;
  before: Rated;
  after: Rated;
  delta: number;
}

/**
 * Each player's rating in consecutive seasons they qualified in (rated within that season's
 * gender and format), and the change. Shrinkage keeps a lucky few balls from topping the list.
 */
export function improvers(bySeason: Line[], disc: Disc, gender: Gender, format: Format): Move[] {
  const pool = select(bySeason, gender, format);
  const seasons = [...new Set(pool.map((l) => l.season ?? ''))].filter(Boolean).sort();
  const ratedBy = new Map<string, Map<string, Rated>>();
  for (const s of seasons) {
    const group = pool.filter((l) => l.season === s && qualifies(l, disc));
    const ref = medians(group, disc);
    const rated = group.map((l) => rate(l, disc, ref));
    const sorted = rated.map((r) => r.rating).sort((a, b) => a - b);
    for (const r of rated) {
      const m = ratedBy.get(r.line.id) ?? new Map<string, Rated>();
      m.set(s, {
        ...r,
        pct: Math.round((sorted.filter((x) => x <= r.rating).length / sorted.length) * 100),
      });
      ratedBy.set(r.line.id, m);
    }
  }
  const out: Move[] = [];
  for (const [id, m] of ratedBy) {
    const ss = [...m.keys()].sort();
    if (ss.length < 2) continue;
    // The latest season against the one before it the player qualified in.
    const to = ss[ss.length - 1];
    const from = ss[ss.length - 2];
    const after = m.get(to)!;
    const before = m.get(from)!;
    out.push({
      id,
      name: after.line.name,
      team: after.line.team,
      from,
      to,
      before,
      after,
      delta: Math.round(after.rating - before.rating),
    });
  }
  return out.sort((a, b) => b.delta - a.delta);
}

/* ─── Players seen at two stages ─── */

export interface Climb {
  id: string;
  name: string;
  steps: { stage: Stage; team: string; rated: Rated }[];
}

/**
 * Players found (same name, accents and case ignored) at more than one stage, in any format:
 * where they stood in each stage — what a player who went up looked like below.
 */
export function climbers(lines: Line[], disc: Disc, gender: Gender): Climb[] {
  const rated = new Map<string, Rated[]>();
  // Age-group players are left out: a name shared with a senior player is almost always a
  // different person (a U13 in this season's files can't have played franchise cricket in it).
  for (const format of ['T20', 'One-Day', 'Multi-day'] as Format[])
    for (const r of stageRatings(lines, disc, gender, format))
      if (r.line.stage.rung >= 18) rated.set(r.line.id, [...(rated.get(r.line.id) ?? []), r]);
  return [...rated.entries()]
    .filter(([, rs]) => new Set(rs.map((r) => r.line.stage.key)).size >= 2)
    .map(([id, rs]) => {
      const steps = rs
        .sort(
          (a, b) =>
            a.line.stage.rung - b.line.stage.rung || a.line.format.localeCompare(b.line.format),
        )
        .map((r) => ({ stage: r.line.stage, team: r.line.team, rated: r }));
      return { id, name: steps[steps.length - 1].rated.line.name, steps };
    })
    .sort((a, b) => b.steps.length - a.steps.length || a.name.localeCompare(b.name));
}

/** Formats with at least two stages to compare, most stages first. */
export function formatsWithStages(lines: Line[], disc: Disc, gender: Gender): Format[] {
  return (['T20', 'One-Day', 'Multi-day'] as Format[])
    .map((f) => ({ f, n: stagesOf(lines, disc, gender, f).length }))
    .filter((x) => x.n >= 1)
    .sort((a, b) => b.n - a.n)
    .map((x) => x.f);
}

export const fmtMetric = (disc: Disc, key: string, v: number) => metricOf(disc, key).fmt(v);
