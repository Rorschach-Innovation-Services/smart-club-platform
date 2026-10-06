/**
 * Call-ups, made objective. A squad player and a scouted player never share a raw scale
 * (different leagues), so both are placed by percentile within their own population on the
 * same measures: a squad bowler among the squad's bowlers, a candidate among the pool's. The
 * squad player's weakest measure says what cover is needed; candidates are ranked by how well
 * they rate on those measures, that weakest one counting double. Pure.
 */

export type Disc = 'bat' | 'bowl';

export interface Measure {
  key: string;
  label: string;
  better: 'high' | 'low';
  /** Leave out of "weakest" (an overall index, not a skill). */
  overall?: boolean;
  fmt: (v: number) => string;
}

const f0 = (v: number) => Math.round(v).toString();
const f1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
const f2 = (v: number) => v.toFixed(2);

export const MEASURES: Record<Disc, Measure[]> = {
  bat: [
    { key: 'idx', label: 'Batting index', better: 'high', overall: true, fmt: f0 },
    { key: 'sr', label: 'Strike rate', better: 'high', fmt: f0 },
    { key: 'avg', label: 'Average', better: 'high', fmt: f1 },
  ],
  bowl: [
    { key: 'idx', label: 'Bowling index', better: 'high', overall: true, fmt: f0 },
    { key: 'econ', label: 'Economy', better: 'low', fmt: f1 },
    { key: 'wpo', label: 'Wickets per over', better: 'high', fmt: f2 },
    { key: 'dot', label: 'Dot balls %', better: 'high', fmt: f0 },
  ],
};

export type Values = Record<string, number | null | undefined>;

/** 0–100: the share of the population this value is at least as good as. */
export function percentileOf(v: number, population: number[], better: 'high' | 'low') {
  if (!population.length) return null;
  const atLeast = population.filter((x) => (better === 'high' ? v >= x : v <= x)).length;
  return Math.round((atLeast / population.length) * 100);
}

export type Percentiles = Record<string, number | null>;

/** Percentile on each measure, within the population's values for that measure. */
export function percentiles(values: Values, population: Values[], measures: Measure[]): Percentiles {
  const out: Percentiles = {};
  for (const m of measures) {
    const v = values[m.key];
    const pop = population.map((p) => p[m.key]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    out[m.key] = typeof v === 'number' && Number.isFinite(v) ? percentileOf(v, pop, m.better) : null;
  }
  return out;
}

/** The skill measure the player ranks lowest on (not the overall index). */
export function weakest(p: Percentiles, measures: Measure[]) {
  const skills = measures.filter((m) => !m.overall && p[m.key] !== null);
  if (!skills.length) return null;
  return skills.reduce((lo, m) => ((p[m.key] as number) < (p[lo.key] as number) ? m : lo));
}

/**
 * How well a candidate covers the need: mean percentile across the measures they have, the
 * squad player's weakest measure counted twice. Needs at least two measures to say anything.
 */
export function fitScore(p: Percentiles, measures: Measure[], weakKey: string | null) {
  let sum = 0;
  let w = 0;
  for (const m of measures) {
    const v = p[m.key];
    if (v === null || v === undefined) continue;
    const weight = m.key === weakKey ? 2 : 1;
    sum += v * weight;
    w += weight;
  }
  const have = measures.filter((m) => p[m.key] !== null && p[m.key] !== undefined).length;
  return have >= 2 ? Math.round(sum / w) : null;
}

export const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};
