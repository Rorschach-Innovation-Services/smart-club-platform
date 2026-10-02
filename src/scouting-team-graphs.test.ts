import { describe, it, expect } from 'vitest';
import { SAMPLE_TOURNAMENT } from './scouting-sample';
import { SAMPLE_CLUB_MATCH } from './scouting-sample';
import {
  teamInnings,
  shotsOf,
  zoneRuns,
  hasBallData,
  runSources,
  dismissalCounts,
  dismissalKind,
  runsByPosition,
  partnershipByWicket,
  bowlingUsage,
} from './scouting';

const club = SAMPLE_CLUB_MATCH;
const [visInn, homeInn] = club.matches[0].innings!;

describe('sample club match (ball by ball)', () => {
  it('reproduces the official result from the balls', () => {
    expect([visInn.bat, visInn.total, visInn.wkts, visInn.overs]).toEqual(['VIS', 214, 9, '50']);
    expect([homeInn.bat, homeInn.total, homeInn.wkts, homeInn.overs]).toEqual([
      'HOM',
      216,
      4,
      '44',
    ]);
  });

  it('every innings reconciles ball by ball', () => {
    [visInn, homeInn].forEach((inn) => {
      const fromBalls = inn.balls!.reduce((n, b) => n + b[4] + b[6], 0);
      const bat = inn.batting.reduce((n, r) => n + r.r, 0);
      expect(fromBalls).toBe(inn.total);
      expect(bat + inn.extras).toBe(inn.total);
    });
  });

  it('wagon wheel zones hold every zoned run off the bat', () => {
    const shots = shotsOf([visInn]);
    expect(shots).toHaveLength(107);
    const z = zoneRuns(shots);
    expect(z).toHaveLength(8);
    expect(z.reduce((a, b) => a + b, 0)).toBe(shots.reduce((n, s) => n + s.runs, 0));
    expect(shots.every((s) => s.zone >= 0 && s.zone <= 7 && s.runs > 0)).toBe(true);
  });

  it('filters shots by batter and by bowler', () => {
    const top = visInn.batting.reduce((a, b) => (b.r > a.r ? b : a));
    const mine = shotsOf([visInn], { batter: top.n });
    expect(mine.every((s) => s.batter === top.n)).toBe(true);
    expect(mine.reduce((n, s) => n + s.runs, 0)).toBeLessThanOrEqual(top.r);
    const b = visInn.bowling[0].n;
    expect(shotsOf([visInn], { bowler: b }).every((s) => s.bowler === b)).toBe(true);
  });
});

describe('team graphs', () => {
  it('knows which data has ball-by-ball zones', () => {
    expect(hasBallData([visInn])).toBe(true);
    const { bat } = teamInnings(SAMPLE_TOURNAMENT, 'STH');
    expect(hasBallData(bat.map((x) => x.inn))).toBe(false);
    expect(shotsOf(bat.map((x) => x.inn))).toEqual([]);
  });

  it('splits runs into boundaries, running and extras that add to the total', () => {
    const s = runSources([visInn]);
    expect(s.boundaries + s.running + s.extras + s.unattributed).toBe(214);
    const { bat } = teamInnings(SAMPLE_TOURNAMENT, 'CEN');
    const k = runSources(bat.map((x) => x.inn));
    expect(k.boundaries + k.running + k.extras + k.unattributed).toBe(k.total);
  });

  it('counts dismissal types for wickets lost and taken', () => {
    expect(dismissalKind('c X b Y')).toBe('Caught');
    expect(dismissalKind('lbw b Y')).toBe('LBW');
    expect(dismissalKind('st X b Y')).toBe('Stumped');
    expect(dismissalKind('run out (X)')).toBe('Run out');
    expect(dismissalKind('b Y')).toBe('Bowled');
    expect(dismissalKind('not out')).toBeNull();
    const lost = dismissalCounts([visInn]);
    expect(Object.values(lost).reduce((a, b) => a + b, 0)).toBe(9);
    const taken = dismissalCounts([homeInn]);
    expect(Object.values(taken).reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('builds runs by position, partnerships by wicket and bowling usage', () => {
    const pos = runsByPosition([visInn]);
    expect(pos.reduce((n, p) => n + p.runs, 0)).toBe(214 - visInn.extras);
    const stands = partnershipByWicket([visInn]).filter((p) => p.n);
    expect(stands).toHaveLength(10); // 9 wickets + the unbroken last stand
    const usage = bowlingUsage([visInn]);
    expect(usage.reduce((n, u) => n + u.balls, 0)).toBe(300);
    expect(usage[0].balls).toBeGreaterThanOrEqual(usage[usage.length - 1].balls);
  });
});
