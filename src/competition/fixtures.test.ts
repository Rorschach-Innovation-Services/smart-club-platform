import { describe, it, expect } from 'vitest';
import {
  fixturesFromDates,
  fixturesFromPlan,
  legacyRoundDates,
  roundRobinPairings,
  roundsForTeamCount,
  type Pairing,
} from './fixtures';
import { planRoundDates } from './calendar';
import type { SeasonCalendar } from '../types';

/** The confirmed 2026/27 Top Six, in the order the union's spreadsheet lists them. */
const TOP_SIX = [
  'Delta',
  'Hollywoodbets Crusaders',
  'Amanzimtoti',
  'UKZN',
  'Hillary Malvern',
  'Harlequins',
];

/** Pairings as order-insensitive keys, so home/away doesn't affect the comparison. */
const asSets = (rounds: Pairing[][]) => rounds.map((r) => r.map((p) => [...p].sort().join(' v ')));

describe('roundRobinPairings', () => {
  const rounds = roundRobinPairings(TOP_SIX);

  it('produces n-1 rounds of n/2 pairings for an even roster', () => {
    expect(rounds).toHaveLength(5);
    for (const r of rounds) expect(r).toHaveLength(3);
  });

  it('has every team meet every other exactly once', () => {
    const seen = rounds.flat().map((p) => [...p].sort().join('|'));
    expect(new Set(seen).size).toBe(15); // C(6,2)
    expect(seen).toHaveLength(15);
  });

  it('gives each team exactly one fixture per round', () => {
    for (const r of rounds) {
      const playing = r.flat();
      expect(new Set(playing).size).toBe(playing.length);
    }
  });

  // The union built its spreadsheet with the same circle method, so the PAIRINGS must
  // line up exactly — this is the check that our rotation matches theirs.
  it('reproduces the union spreadsheet pairings round for round', () => {
    const sets = asSets(rounds);
    expect(sets[0].sort()).toEqual(
      [
        'Delta v Harlequins',
        'Hillary Malvern v Hollywoodbets Crusaders',
        'Amanzimtoti v UKZN',
      ].sort(),
    );
    expect(sets[1].sort()).toEqual(
      [
        'Delta v Hillary Malvern',
        'Harlequins v UKZN',
        'Amanzimtoti v Hollywoodbets Crusaders',
      ].sort(),
    );
  });

  // Documented divergence: we alternate home/away by round, the hand-built spreadsheet
  // doesn't. Pinned so the behaviour can't drift silently in either direction.
  it('alternates home and away by round', () => {
    expect(rounds[0][0]).toEqual(['Delta', 'Harlequins']);
    expect(rounds[1][0]).toEqual(['Hillary Malvern', 'Delta']);
  });

  it('carries a bye for an odd roster — fewer pairings, more rounds', () => {
    const odd = roundRobinPairings(['a', 'b', 'c', 'd', 'e']);
    expect(odd).toHaveLength(5);
    for (const r of odd) expect(r).toHaveLength(2); // one team sits out each round
    const seen = odd.flat().map((p) => [...p].sort().join('|'));
    expect(new Set(seen).size).toBe(10); // C(5,2)
  });

  it('returns nothing for fewer than two teams', () => {
    expect(roundRobinPairings([])).toEqual([]);
    expect(roundRobinPairings(['solo'])).toEqual([]);
  });

  it('does not mutate the caller’s array', () => {
    const teams = [...TOP_SIX];
    roundRobinPairings(teams);
    expect(teams).toEqual(TOP_SIX);
  });
});

describe('roundsForTeamCount', () => {
  it('is n-1 for an even roster and n for an odd one (the bye round)', () => {
    expect(roundsForTeamCount(6)).toBe(5);
    expect(roundsForTeamCount(12)).toBe(11);
    expect(roundsForTeamCount(5)).toBe(5);
    expect(roundsForTeamCount(1)).toBe(0);
  });
});

describe('legacyRoundDates — the pre-calendar behaviour, preserved', () => {
  it('steps one round per week by default', () => {
    expect(legacyRoundDates(3, '2026-08-01')).toEqual(['2026-08-01', '2026-08-08', '2026-08-15']);
  });

  it('spreads rounds so the last lands on the end date', () => {
    const dates = legacyRoundDates(5, '2026-08-01', { endDateISO: '2026-08-29', spread: true });
    expect(dates[0]).toBe('2026-08-01');
    expect(dates[4]).toBe('2026-08-29');
  });

  it('ignores the end date when spread is off', () => {
    const dates = legacyRoundDates(3, '2026-08-01', { endDateISO: '2026-08-05', spread: false });
    expect(dates).toEqual(['2026-08-01', '2026-08-08', '2026-08-15']);
  });

  it('never stacks two rounds on one date when the window is too short', () => {
    const dates = legacyRoundDates(5, '2026-08-01', { endDateISO: '2026-08-03', spread: true });
    expect(new Set(dates).size).toBe(dates.length);
  });

  // Review finding: the dayjs port turned a thrown RangeError into fixtures dated the
  // string "Invalid Date", which POST /series happily stores and the club portal then
  // renders blank. A crash at the point of the mistake beats a persisted one.
  it('throws on an invalid start date rather than dating fixtures "Invalid Date"', () => {
    expect(() => legacyRoundDates(3, 'not-a-date')).toThrow(/invalid start date/i);
    expect(() => legacyRoundDates(3, '')).toThrow(/invalid start date/i);
    expect(() => legacyRoundDates(3, null as unknown as string)).toThrow(/invalid start date/i);
    // `dayjs.utc(undefined)` returns NOW, so `isValid()` alone waves this through and
    // every round silently gets dated from today — the exact persisted-bad-data outcome
    // the guard exists to stop.
    expect(() => legacyRoundDates(3, undefined as unknown as string)).toThrow(
      /invalid start date/i,
    );
  });
});

describe('fixturesFromDates', () => {
  const rounds = roundRobinPairings(['a', 'b', 'c', 'd']);

  it('numbers fixtures sequentially and rounds from 1', () => {
    const fx = fixturesFromDates(rounds, ['2026-08-01', '2026-08-08', '2026-08-15']);
    expect(fx).toHaveLength(6);
    expect(fx[0]).toMatchObject({ id: 'f1', round: 1, date: '2026-08-01' });
    expect(fx[5]).toMatchObject({ id: 'f6', round: 3, date: '2026-08-15' });
  });

  it('carries no time when the schedule has no slots', () => {
    const fx = fixturesFromDates(rounds, ['2026-08-01']);
    expect(fx[0].time).toBeUndefined();
    expect(fx[0].slot).toBeUndefined();
  });

  it('cycles fixtures through the slots within a round', () => {
    const fx = fixturesFromDates(
      rounds,
      ['2026-08-01'],
      [
        { label: 'Morning', start: '08:00' },
        { label: 'Afternoon', start: '13:30' },
      ],
    );
    expect(fx.map((f) => f.time)).toEqual(['08:00', '13:30']);
    expect(fx.map((f) => f.slot)).toEqual(['Morning', 'Afternoon']);
  });

  // An over-constrained calendar returns fewer dates than rounds. Emitting a dateless
  // fixture would put "Invalid Date" in front of a club, so those rounds are dropped.
  it('drops rounds that have no date rather than inventing one', () => {
    const fx = fixturesFromDates(rounds, ['2026-08-01']);
    expect(fx).toHaveLength(2);
    expect(fx.every((f) => f.date === '2026-08-01')).toBe(true);
  });
});

describe('fixturesFromPlan — calendar-scheduled generation end to end', () => {
  const KZNCU: SeasonCalendar = {
    id: 'cal',
    label: '2026/27',
    blocks: [
      { id: 'b1', label: 'Block 1', start: '2026-09-13', end: '2026-12-13' },
      { id: 'b2', label: 'Block 2', start: '2027-01-18', end: '2027-03-28' },
    ],
    breaks: [{ label: 'the mid-season break', start: '2026-12-14', end: '2027-01-17' }],
  };

  it('dates a six-team round robin off the season calendar', () => {
    const plan = planRoundDates({
      calendar: KZNCU,
      blockId: 'b1',
      cadence: { kind: 'weekly' },
      rounds: roundsForTeamCount(TOP_SIX.length),
    });
    expect(plan.fits).toBe(true);

    const fx = fixturesFromPlan(TOP_SIX, plan.dates);
    expect(fx).toHaveLength(15); // 5 rounds × 3
    expect(fx[0].date).toBe('2026-09-13');
    expect(fx[fx.length - 1].date).toBe('2026-10-11');
  });

  // The whole point of the calendar: a league long enough to run past mid-December
  // must not put a single fixture inside the break.
  it('never places a fixture inside the mid-season break', () => {
    const plan = planRoundDates({
      calendar: KZNCU,
      blockId: 'b1',
      cadence: { kind: 'weekly' },
      rounds: roundsForTeamCount(14),
    });
    const fx = fixturesFromPlan(
      Array.from({ length: 14 }, (_, i) => `t${i}`),
      plan.dates,
    );
    expect(fx.length).toBeGreaterThan(0);
    for (const f of fx) {
      expect(f.date >= '2026-09-13' && f.date <= '2026-12-13').toBe(true);
    }
  });

  it('applies T20 morning/afternoon slots across a round', () => {
    const plan = planRoundDates({
      calendar: KZNCU,
      blockId: 'b1',
      cadence: { kind: 'weekly' },
      rounds: 1,
    });
    const fx = fixturesFromPlan(TOP_SIX, plan.dates, [
      { label: 'Morning', start: '09:00' },
      { label: 'Afternoon', start: '13:30' },
    ]);
    expect(fx.map((f) => f.time)).toEqual(['09:00', '13:30', '09:00']);
  });
});
