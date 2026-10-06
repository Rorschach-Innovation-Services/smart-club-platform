import { describe, it, expect } from 'vitest';
import { SAMPLE_PRO_MATCHES as ms } from './pro-sample';
import type { ProMatch } from './pro-scorecards';
import {
  baselines,
  batIndex,
  bowlIndex,
  detectSquads,
  filterMatches,
  overOfWicket,
  squadPlayers,
  teamComparisons,
  teamSummary,
  wicketsByPhase,
  type Baseline,
} from './pro-team';

const T20: Baseline = {
  format: 'T20',
  rpi: 20,
  sr: 130,
  avg: 25,
  ballsPerInns: 15,
  econ: 8,
  bpw: 20,
  dotPct: 38,
  boundaryPct: 18,
};

describe('who the squad is', () => {
  it('finds one squad per gender in the files, by the club word rather than the sponsor', () => {
    const squads = detectSquads(ms);
    expect(squads.map((s) => [s.gender, s.key, s.name])).toEqual([
      ['men', 'hawks', 'Highveld Hawks'],
      ['women', 'hawks', 'Highveld Hawks Women'],
    ]);
    // A sponsor that travels with the name never wins a tie with the club's own word.
    const renamed = ms
      .filter((m) => m.gender === 'men')
      .map((m) => ({
        ...m,
        home: m.home.replace('Highveld Hawks', 'Acme Bank Highveld Hawks'),
        away: m.away.replace('Highveld Hawks', 'Acme Bank Highveld Hawks'),
      })) as ProMatch[];
    expect(detectSquads(renamed)[0].key).toBe('hawks');
  });
});

describe('ratings on the national report’s scale', () => {
  it('rates an average player at 100 and shrinks a cameo towards the average', () => {
    const avg = batIndex({ runs: 200, balls: 200 / 1.3, inns: 10 }, T20)!;
    expect(Math.round(avg.idx)).toBe(100);
    const cameo = batIndex({ runs: 30, balls: 10, inns: 1 }, T20)!;
    const proven = batIndex({ runs: 600, balls: 300, inns: 15 }, T20)!;
    expect(cameo.srIdx).toBeLessThan(200); // raw 300 SR, shrunk
    expect(proven.idx).toBeGreaterThan(cameo.idx);
  });

  it('rewards cheap bowling and wickets, with the same shrinkage', () => {
    const avg = bowlIndex({ balls: 240, runs: 320, wkts: 12 }, T20)!;
    expect(Math.round(avg.idx)).toBe(100);
    const tight = bowlIndex({ balls: 240, runs: 240, wkts: 16 }, T20)!;
    expect(tight.econIdx).toBeGreaterThan(100);
    expect(tight.wktIdx).toBeGreaterThan(100);
  });

  it('sets each format’s average from everyone in those games', () => {
    const b = baselines(ms.filter((m) => m.gender === 'men'));
    expect(b.T20!.sr).toBeGreaterThan(b['One-Day']!.sr);
    expect(b['One-Day']!.sr).toBeGreaterThan(b['Multi-day']!.sr);
  });
});

describe('selection signals', () => {
  const [men] = detectSquads(ms);
  const players = squadPlayers(men, { format: 'all', season: 'all' }, ms);

  it('gives every player a signal with reasons in plain words', () => {
    expect(players.length).toBeGreaterThan(8);
    for (const p of players) {
      expect(['promote', 'hold', 'watch', 'drop']).toContain(p.signal.kind);
      expect(p.signal.reasons.length).toBeGreaterThan(0);
    }
  });

  it('promotes only on strong recent form backed by the season, and flags risk only when both are low', () => {
    const idx = (p: (typeof players)[number], w: 'idx' | 'recent') =>
      p.role === 'Bowler'
        ? p[w].bowl?.idx
        : p.role === 'All-rounder'
          ? Math.max(p[w].bat?.idx ?? 0, p[w].bowl?.idx ?? 0)
          : p[w].bat?.idx;
    for (const p of players.filter((x) => x.signal.kind === 'promote')) {
      expect(idx(p, 'recent')!).toBeGreaterThanOrEqual(115);
      expect(idx(p, 'idx')!).toBeGreaterThanOrEqual(100);
    }
    for (const p of players.filter((x) => x.signal.kind === 'drop')) {
      expect(idx(p, 'recent')!).toBeLessThanOrEqual(80);
      expect(idx(p, 'idx')!).toBeLessThanOrEqual(92);
    }
  });

  it('keeps batting lines in date order with where the batter came in', () => {
    const p = players.find((x) => x.bat.lines.some((l) => l.pos >= 3))!;
    const dates = p.bat.lines.map((l) => l.date);
    expect([...dates].sort()).toEqual(dates);
    const later = p.bat.lines.find((l) => l.pos >= 3)!;
    expect(later.cameIn.over).not.toBeNull();
  });
});

describe('team level', () => {
  const [men] = detectSquads(ms);
  const t20 = filterMatches(men, { format: 'T20', season: 'all' });

  it('counts results that add up to the games played', () => {
    const s = teamSummary(men, t20);
    expect(s.won + s.lost + s.drawn + s.tied + s.noResult).toBe(s.played);
    expect(s.played).toBe(t20.length);
  });

  it('splits the fall of wickets into phases without losing any', () => {
    const rows = wicketsByPhase(men, t20, 'T20');
    const fow = t20.flatMap((m) => m.innings ?? []).reduce((n, i) => n + i.fow.length, 0);
    expect(rows.reduce((n, r) => n + r.lost + r.taken, 0)).toBe(fow);
    expect(overOfWicket('15.2')).toBe(16);
    expect(overOfWicket('15.0')).toBe(15);
    expect(overOfWicket('0.3')).toBe(1);
  });

  it('compares us with opponents per innings', () => {
    const c = teamComparisons(men, t20);
    expect(c.ours.length + c.theirs.length).toBe(
      t20.reduce((n, m) => n + (m.innings?.length ?? 0), 0),
    );
    expect(c.runRate.ours).toBeGreaterThan(4);
    expect(c.partnerships.ours).toHaveLength(10);
  });
});

describe('one player, sliced', () => {
  const [men] = detectSquads(ms);
  const players = squadPlayers(men, { format: 'all', season: 'all' }, ms);
  const p = players.find((x) => x.bat.inns >= 5 && x.bowl.inns >= 3) ?? players[0];

  it('splits batting by format without losing a run', async () => {
    const { batSplits } = await import('./pro-team');
    const s = batSplits(p.bat.lines, (l) => l.format);
    expect(s.reduce((n, x) => n + x.runs, 0)).toBe(p.bat.runs);
    expect(s.reduce((n, x) => n + x.inns, 0)).toBe(p.bat.inns);
    for (const x of s) if (x.outs) expect(x.avg).toBeCloseTo(x.runs / x.outs);
  });

  it('splits bowling by opponent and keeps the best figures', async () => {
    const { bowlSplits } = await import('./pro-team');
    const s = bowlSplits(p.bowl.lines, (l) => l.opp);
    expect(s.reduce((n, x) => n + x.wkts, 0)).toBe(p.bowl.wkts);
    expect(s.reduce((n, x) => n + x.balls, 0)).toBe(p.bowl.balls);
    expect(s.every((x) => /^\d+\/\d+$/.test(x.best))).toBe(true);
  });

  it('puts every innings in exactly one score band and every spell in one wicket band', async () => {
    const { scoreBands, wicketBands } = await import('./pro-team');
    expect(scoreBands(p.bat.lines).reduce((n, b) => n + b.n, 0)).toBe(p.bat.inns);
    expect(wicketBands(p.bowl.lines).reduce((n, b) => n + b.n, 0)).toBe(p.bowl.inns);
    expect(
      scoreBands([{ r: 0 }, { r: 9 }, { r: 50 }, { r: 100 }] as never).map((b) => b.n),
    ).toEqual([1, 1, 0, 0, 1, 1]);
  });
});
