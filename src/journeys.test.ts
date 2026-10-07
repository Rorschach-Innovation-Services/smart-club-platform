import { describe, it, expect } from 'vitest';
import { samplePlayers } from './journeys-sample';
import {
  BANDS,
  average,
  boardFor,
  boards,
  boomBust,
  flowBySeason,
  formatsOf,
  funnel,
  improversAcross,
  journeyOf,
  journeys,
  median,
  medianScore,
  quantile,
  rungOf,
  routesToPro,
  schoolOrigins,
  seasonsOf,
  strikeRate,
  tally,
  type JourneyPlayer,
  type SeasonRow,
} from './journeys';

const row = (p: Partial<SeasonRow>): SeasonRow => ({
  season: 2024,
  setting: 'school',
  team: 'A School',
  level: 'U13 A',
  bracket: 'U13',
  format: 'T20',
  games: 5,
  bat: [],
  bowl: [],
  ...p,
});
const player = (id: string, rows: SeasonRow[], gender: 'men' | 'women' = 'men'): JourneyPlayer => ({
  id,
  name: `Player ${id}`,
  gender,
  rows,
});
const inn = (r: number, b: number, out = true) => ({ r, b, out });

describe('counting', () => {
  it('tallies balls faced and bowled, average, median and strike rate', () => {
    const t = tally([
      row({
        bat: [inn(10, 12), inn(30, 25), inn(0, 3), inn(20, 20, false)],
        bowl: [{ b: 12, r: 14, w: 2 }],
      }),
    ]);
    expect(t.balls).toBe(60);
    expect(t.runs).toBe(60);
    expect(t.outs).toBe(3);
    expect(average(t)).toBe(20);
    expect(medianScore(t)).toBe(15);
    expect(strikeRate(t)).toBe(100);
    expect(t.hs).toBe(30);
    expect(t.bBalls).toBe(12);
    expect(t.wkts).toBe(2);
  });

  it('leaves the average empty until a player has been out', () => {
    expect(average(tally([row({ bat: [inn(40, 30, false)] })]))).toBeNull();
  });

  it('computes quantiles and the median', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([])).toBeNull();
  });

  it('splits innings into bust, steady and boom by bracket, summing to one', () => {
    const [lo, hi] = BANDS.U13;
    const b = boomBust(
      [row({ bat: [inn(lo - 1, 5), inn(lo, 9), inn(hi, 20), inn(hi + 40, 40)] })],
      'U13',
    );
    expect(b).toEqual({ bust: 0.25, steady: 0.25, boom: 0.5, n: 4 });
    expect(boomBust([], 'U13').n).toBe(0);
  });
});

describe('a journey', () => {
  it('reads the origin, route, gaps, status and time to the franchise', () => {
    const p = player('x', [
      row({ season: 2020, team: 'Hill School' }),
      row({ season: 2020, setting: 'rep', team: 'Province week', level: 'Week' }),
      row({ season: 2022, setting: 'club', team: 'Park CC', bracket: 'U15' }),
      row({ season: 2023, setting: 'pro', team: 'Hawks', bracket: 'Pro', games: 8 }),
    ]);
    const j = journeyOf(p, 2025);
    expect(j.school).toBe('Hill School');
    expect(j.first).toBe(2020);
    expect(j.last).toBe(2023);
    expect(j.gaps).toEqual([2021]);
    // Representative weeks are counted but aren't a step on the route.
    expect(j.route).toEqual(['school', 'club', 'pro']);
    expect(j.games.rep).toBe(5);
    expect(j.reachedPro).toBe(true);
    expect(j.yearsToPro).toBe(3);
    expect(j.highest).toBe('Pro');
    expect(j.status).toBe('exited');
  });

  it('calls a player active in the latest season, and new in their first', () => {
    const a = player('a', [row({ season: 2024 }), row({ season: 2025 })]);
    const n = player('n', [row({ season: 2025 })]);
    expect(journeyOf(a, 2025).status).toBe('active');
    expect(journeyOf(n, 2025).status).toBe('new');
  });
});

describe('the invented sample', () => {
  const players = samplePlayers();
  const seasons = seasonsOf(players);
  const js = journeys(players);

  it('is stable, has both genders, every bracket and franchise players', () => {
    expect(samplePlayers()).toBe(players);
    expect(players.length).toBeGreaterThan(150);
    expect(players.some((p) => p.gender === 'women')).toBe(true);
    const seen = new Set(players.flatMap((p) => p.rows.map((r) => r.bracket)));
    for (const b of ['U9', 'U13', 'U19', 'Senior', 'Pro']) expect(seen.has(b as never)).toBe(true);
    expect(js.filter((j) => j.reachedPro).length).toBeGreaterThan(10);
    expect(seasons[0]).toBe(2016);
    expect(seasons[seasons.length - 1]).toBe(2026);
  });

  it('only ever invents players: no row is dated before the data starts', () => {
    for (const p of players) for (const r of p.rows) expect(r.season).toBeGreaterThanOrEqual(2016);
  });

  it('rates players within their own bracket, and finds outliers in the top tenth', () => {
    const fmt = formatsOf(players, 'men')[0];
    const bs = boards(players, fmt, 'men');
    expect(bs.map((b) => b.bracket)).toEqual(
      [...bs.map((b) => b.bracket)].sort((a, c) => rungOf(a) - rungOf(c)),
    );
    let outliers = 0;
    for (const b of bs)
      for (const l of b.lines) {
        for (const pct of [l.batPct, l.bowlPct])
          if (pct !== null) expect(pct).toBeGreaterThanOrEqual(0);
        if (l.batOutlier) {
          outliers++;
          expect(l.batPct).toBeGreaterThanOrEqual(85);
          expect(average(l.t) as number).toBeGreaterThanOrEqual(
            (b.bat as { benchmark: number }).benchmark,
          );
        }
      }
    expect(outliers).toBeGreaterThan(3);
  });

  it('puts the benchmark above the median at every bracket', () => {
    for (const b of boards(players, 'One-Day', 'men'))
      if (b.bat) expect(b.bat.benchmark).toBeGreaterThanOrEqual(b.bat.p50);
  });

  it('measures participation as balls faced and bowled per player each season', () => {
    const b = boardFor(players, 'U15', 'One-Day', 'men');
    expect(b.ballsFaced).toBeGreaterThan(0);
    expect(b.ballsBowled).toBeGreaterThan(0);
  });

  it('finds climbers who gained 30+ points moving up a bracket', () => {
    const bs = boards(players, 'One-Day', 'men');
    for (const c of improversAcross(bs, 'bat')) {
      expect(c.gain).toBeGreaterThanOrEqual(30);
      expect(rungOf(c.to.bracket)).toBeGreaterThan(rungOf(c.from.bracket));
    }
  });

  it('counts who came in and who left each season without counting the first as an entry', () => {
    const flow = flowBySeason(js, seasons);
    expect(flow[0].entered).toBe(0);
    expect(flow[flow.length - 1].left).toBe(0);
    expect(flow.reduce((a, f) => a + f.entered, 0)).toBe(
      js.filter((j) => j.first > seasons[0]).length,
    );
    for (const f of flow) expect(f.active).toBeGreaterThan(0);
  });

  it('builds a pipeline where nobody moves up who was never there', () => {
    for (const r of funnel(js, 'men', seasons[0])) {
      expect(r.onward).toBeLessThanOrEqual(r.ever);
      if (r.share !== null) {
        expect(r.share).toBeGreaterThanOrEqual(0);
        expect(r.share).toBeLessThanOrEqual(1);
      }
    }
  });

  it('accounts for every franchise player in the routes and the school origins', () => {
    const pros = js.filter((j) => j.reachedPro);
    expect(routesToPro(js).reduce((a, r) => a + r.n, 0)).toBe(pros.length);
    expect(schoolOrigins(js).reduce((a, o) => a + o.reachedPro, 0)).toBeLessThanOrEqual(
      pros.length,
    );
    expect(schoolOrigins(js).every((o) => o.reachedPro <= o.players)).toBe(true);
  });
});
