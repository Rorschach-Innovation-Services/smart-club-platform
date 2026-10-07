import { describe, it, expect } from 'vitest';
import {
  PRO,
  SCOUTED,
  benchmarkPlayers,
  climbers,
  formatOfEvent,
  improvers,
  isOutlier,
  linesFromMatches,
  linesFromPool,
  qualifies,
  quantiles,
  rateStage,
  stageOfAge,
  stageRows,
  stagesOf,
  type Line,
  type Stage,
} from './milestones';
import type { ScoutPool } from './scout-pool';
import type { ScoutMatch } from './scouting-matches';

const U13 = stageOfAge('U13');

/** An invented player's line: `sr` and `rpi` set the batting, `econ` and `wp10` the bowling. */
function line(
  name: string,
  stage: Stage,
  o: {
    sr?: number;
    rpi?: number;
    inns?: number;
    econ?: number;
    wp10?: number;
    overs?: number;
    format?: Line['format'];
    season?: string;
    gender?: Line['gender'];
    team?: string;
  } = {},
): Line {
  const inns = o.inns ?? 6;
  const runs = Math.round((o.rpi ?? 20) * inns);
  const balls = Math.round((runs / (o.sr ?? 100)) * 100);
  const bBalls = (o.overs ?? 0) * 6;
  return {
    name,
    id: name.toLowerCase(),
    team: o.team ?? 'Hawks',
    stage,
    gender: o.gender ?? 'men',
    format: o.format ?? 'T20',
    season: o.season,
    matches: inns,
    inns,
    runs,
    balls,
    outs: inns,
    f4: 0,
    f6: 0,
    bBalls,
    bRuns: Math.round(((o.econ ?? 6) * bBalls) / 6),
    wkts: Math.round(((o.wp10 ?? 1) * bBalls) / 60),
  };
}

/** Ten players at a stage with strike rates 60, 70 … 150 and runs per innings 10 … 28. */
const ladderOf = (stage: Stage, offset = 0) =>
  Array.from({ length: 10 }, (_, i) =>
    line(`${stage.key} p${i}`, stage, { sr: 60 + i * 10 + offset, rpi: 10 + i * 2 }),
  );

describe('reading the sources', () => {
  it('names stages by age group and formats by the event', () => {
    expect(stageOfAge('U13')).toMatchObject({ key: 'U13', rung: 13 });
    expect(stageOfAge('Senior')).toMatchObject({ key: 'senior', rung: 20 });
    expect(formatOfEvent('T20')).toBe('T20');
    expect(formatOfEvent('50-Over')).toBe('One-Day');
    expect(formatOfEvent('4-Day')).toBe('Multi-day');
  });

  it('adds up a player across scorecards: innings, outs, balls, bowling', () => {
    const m = (id: string, bat: [number, number, string]): ScoutMatch => ({
      id,
      date: '2026-01-01',
      event: 'T20',
      stage: '',
      overs: 20,
      venue: '',
      home: 'Hawks',
      away: 'Kestrels',
      winner: null,
      result: '',
      innings: [
        {
          bat: 'Hawks',
          fld: 'Kestrels',
          total: 0,
          wkts: 0,
          overs: '20',
          extras: 0,
          exb: { w: 0, nb: 0, b: 0, lb: 0 },
          batting: [{ n: 'Ann Hawk', pos: 1, r: bat[0], b: bat[1], f4: 1, f6: 1, out: bat[2] }],
          bowling: [{ n: 'Ben Kestrel', o: '3.2', m: 0, r: 20, w: 2, wd: 0, nb: 0, dots: 8 }],
          fow: [],
          perOver: [],
        },
      ],
    });
    const ls = linesFromMatches(
      [m('1', [30, 20, 'b Ben Kestrel']), m('2', [10, 10, 'not out'])],
      U13,
    );
    const ann = ls.find((l) => l.name === 'Ann Hawk')!;
    expect(ann).toMatchObject({ inns: 2, runs: 40, balls: 30, outs: 1, f4: 2, f6: 2, matches: 2 });
    const ben = ls.find((l) => l.name === 'Ben Kestrel')!;
    expect(ben).toMatchObject({ bBalls: 40, bRuns: 40, wkts: 4, team: 'Kestrels' });
  });

  it('reads a scouting pool as one T20 line per player', () => {
    const pool: ScoutPool = {
      id: 'p',
      name: 'Invented pool',
      gender: 'men',
      format: 'T20',
      source: '',
      date: '2026-01-01',
      players: [
        {
          name: 'Cal Hawk',
          club: 'Riverside',
          union: 'Highveld',
          role: 'Batter',
          games: 4,
          bat: { inns: 4, runs: 160, balls: 100, sr: 160, avg: 53.3 },
          bowl: { overs: '6.3', runs: 50, wkts: 3, econ: 7.7 },
          lists: [],
        },
      ],
    };
    const [l] = linesFromPool(pool);
    expect(l).toMatchObject({
      stage: SCOUTED,
      format: 'T20',
      inns: 4,
      runs: 160,
      outs: 3,
      bBalls: 39,
    });
  });
});

describe('the bar at each stage', () => {
  it('quantiles by linear interpolation', () => {
    expect(quantiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toMatchObject({ n: 10, p50: 5.5, p90: 9.1 });
    expect(quantiles([])).toBeNull();
  });

  it('a junior qualifies on half the senior sample', () => {
    const short = (stage: Stage) => ({ ...line('x', stage), balls: 12, inns: 2 });
    expect(qualifies(short(U13), 'bat')).toBe(true);
    expect(qualifies(short(PRO), 'bat')).toBe(false);
  });

  it('summarises each stage, bottom first, and drops a stage with too few players', () => {
    const lines = [...ladderOf(U13), ...ladderOf(PRO, 40), line('lone', SCOUTED, { sr: 200 })];
    expect(stagesOf(lines, 'bat', 'men', 'T20').map((s) => s.key)).toEqual(['U13', 'pro']);
    const rows = stageRows(lines, 'bat', 'sr', 'men', 'T20');
    expect(rows.map((r) => r.stage.key)).toEqual(['U13', 'pro']);
    expect(rows[0].q.p50).toBeCloseTo(105, 0);
    expect(rows[1].q.p50).toBeCloseTo(145, 0);
    // The benchmark is the top 10%: p90 where higher is better.
    expect(rows[1].benchmark).toBeCloseTo(rows[1].q.p90, 6);
  });

  it('for economy the benchmark is the low end', () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      line(`b${i}`, PRO, { overs: 10, econ: 5 + i * 0.5 }),
    );
    const [row] = stageRows(lines, 'bowl', 'econ', 'men', 'T20');
    expect(row.benchmark).toBeCloseTo(row.q.p10, 6);
    expect(row.benchmark).toBeLessThan(row.q.p50);
  });
});

describe('rating within a stage', () => {
  const lines = [
    ...ladderOf(U13),
    ...ladderOf(PRO, 40),
    line('U13 star', U13, { sr: 180, rpi: 40, inns: 8 }),
  ];

  it('rates against the stage median, best first, with a percentile', () => {
    const u13 = rateStage(lines, 'bat', 'men', 'T20', 'U13');
    expect(u13[0].line.name).toBe('U13 star');
    expect(u13[0].pct).toBe(100);
    expect(u13[0].rating).toBeGreaterThan(150);
    // The middle of the stage sits near 100.
    const mid = u13.find((r) => r.line.name === 'U13 p5')!;
    expect(mid.rating).toBeGreaterThan(90);
    expect(mid.rating).toBeLessThan(115);
  });

  it('an outlier is well clear of the stage on both measures', () => {
    const u13 = rateStage(lines, 'bat', 'men', 'T20', 'U13');
    expect(isOutlier(u13[0], 'bat')).toBe(true);
    expect(isOutlier(u13.find((r) => r.line.name === 'U13 p5')!, 'bat')).toBe(false);
  });

  it('the benchmark players are the top 10% of each stage, at least three', () => {
    const b = benchmarkPlayers(lines, 'bat', 'men', 'T20');
    expect(b.map((x) => x.stage.key)).toEqual(['U13', 'pro']);
    expect(b[0].players).toHaveLength(3);
    expect(b[0].players[0].line.name).toBe('U13 star');
    expect(b[0].of).toBe(11);
  });
});

describe('improvers and players who went up', () => {
  it('rates each season against that season and ranks the change', () => {
    const season = (s: string, rise: Record<string, number>) =>
      Array.from({ length: 10 }, (_, i) =>
        line(`p${i}`, PRO, { sr: 100 + i * 5 + (rise[`p${i}`] ?? 0), rpi: 20, season: s }),
      );
    const bySeason = [...season('2024/25', {}), ...season('2025/26', { p0: 80, p9: -60 })];
    const moves = improvers(bySeason, 'bat', 'men', 'T20');
    expect(moves).toHaveLength(10);
    expect(moves[0]).toMatchObject({ name: 'p0', from: '2024/25', to: '2025/26' });
    expect(moves[0].delta).toBeGreaterThan(15);
    expect(moves[moves.length - 1].name).toBe('p9');
    expect(moves[moves.length - 1].delta).toBeLessThan(-15);
  });

  it('finds a player at two stages, but never matches an age-group name to a senior one', () => {
    const lines = [
      ...ladderOf(U13),
      ...ladderOf(SCOUTED),
      ...ladderOf(PRO),
      line('Dee Hawk', SCOUTED, { sr: 150, rpi: 30 }),
      line('Dee Hawk', PRO, { sr: 120, rpi: 22 }),
      line('Eve Hawk', U13, { sr: 150, rpi: 30 }),
      line('Eve Hawk', PRO, { sr: 120, rpi: 22 }),
    ];
    const c = climbers(lines, 'bat', 'men');
    expect(c.map((x) => x.name)).toEqual(['Dee Hawk']);
    expect(c[0].steps.map((s) => s.stage.key)).toEqual(['scouted', 'pro']);
    expect(c[0].steps[0].rated.pct).toBeGreaterThan(c[0].steps[1].rated.pct - 100);
  });
});
