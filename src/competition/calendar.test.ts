import { describe, it, expect } from 'vitest';
import {
  addDays,
  blockedReason,
  blockLengthDays,
  daysBetween,
  describeCadence,
  findBlock,
  formatIsoDate,
  isActivated,
  isValidIsoDate,
  planRoundDates,
  slotForIndex,
  todayIso,
  weekdayOf,
  type SeasonCalendar,
} from './calendar';

/**
 * The real KZNCU 2026/27 calendar from the union's structure documents: two playing
 * blocks either side of a mid-season break. Every assertion below that names a date is
 * cross-checked against the fixture spreadsheets the union produced by hand.
 */
const KZNCU: SeasonCalendar = {
  id: 'cal_2026_27',
  label: '2026/27',
  timezone: 'Africa/Johannesburg',
  blocks: [
    { id: 'b1', label: 'Block 1', start: '2026-09-13', end: '2026-12-13' },
    { id: 'b2', label: 'Block 2', start: '2027-01-18', end: '2027-03-28' },
  ],
  breaks: [{ label: 'the mid-season break', start: '2026-12-14', end: '2027-01-17' }],
};

const SATURDAY = 6;
const SUNDAY = 0;

describe('date helpers (UTC-anchored — must not drift by host offset)', () => {
  it('adds whole days across a month boundary', () => {
    expect(addDays('2026-09-13', 63)).toBe('2026-11-15');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('counts days between dates, signed', () => {
    expect(daysBetween('2026-09-13', '2026-12-13')).toBe(91);
    expect(daysBetween('2026-12-13', '2026-09-13')).toBe(-91);
  });

  it('reads the weekday without a local-time Date', () => {
    // Every fixture date in the union's spreadsheets is a Sunday.
    expect(weekdayOf('2026-09-13')).toBe(SUNDAY);
    expect(weekdayOf('2026-09-19')).toBe(SATURDAY);
  });

  it('rejects malformed and impossible dates', () => {
    expect(isValidIsoDate('2026-09-13')).toBe(true);
    expect(isValidIsoDate('2026-02-31')).toBe(false); // rolls over — must not pass
    expect(isValidIsoDate('13/09/2026')).toBe(false);
    expect(isValidIsoDate('')).toBe(false);
    expect(isValidIsoDate(undefined)).toBe(false);
  });

  it('formats for display and degrades quietly', () => {
    expect(formatIsoDate('2026-09-13')).toBe('13 Sep 2026');
    expect(formatIsoDate('nonsense')).toBe('');
  });

  it('measures a block inclusively at both ends', () => {
    expect(blockLengthDays(KZNCU.blocks[0])).toBe(92);
  });
});

describe('planRoundDates — KZNCU Premier Men 50 Over (weekly)', () => {
  // The spreadsheet: Top Six double round, 10 rounds, weekly from 13 Sep, R10 on 15 Nov.
  const plan = planRoundDates({
    calendar: KZNCU,
    blockId: 'b1',
    cadence: { kind: 'weekly' },
    rounds: 10,
  });

  it('places every round and reproduces the union spreadsheet dates', () => {
    expect(plan.fits).toBe(true);
    expect(plan.roundsPlaced).toBe(10);
    expect(plan.dates[0]).toBe('2026-09-13');
    expect(plan.dates[1]).toBe('2026-09-20');
    expect(plan.dates[9]).toBe('2026-11-15');
  });

  it('keeps every round inside the block', () => {
    for (const d of plan.dates) {
      expect(d >= '2026-09-13').toBe(true);
      expect(d <= '2026-12-13').toBe(true);
    }
  });

  it('reports the spare capacity operators need to see', () => {
    expect(plan.summary).toContain('13 Sep 2026 → 15 Nov 2026');
    expect(plan.summary).toContain('4 weeks spare');
  });
});

describe('planRoundDates — EMCU bi-weekly divisions overflow their block', () => {
  // 12 teams ⇒ 11 rounds. Every two weeks, Block 1 only fits 7.
  const plan = planRoundDates({
    calendar: KZNCU,
    blockId: 'b1',
    cadence: { kind: 'every-n-weeks', n: 2 },
    rounds: 11,
  });

  it('returns a PARTIAL plan rather than silently generating a short season', () => {
    expect(plan.fits).toBe(false);
    expect(plan.roundsPlaced).toBe(7);
    expect(plan.roundsRequested).toBe(11);
    expect(plan.dates[6]).toBe('2026-12-06');
  });

  it('names the shortfall and what to do about it', () => {
    expect(plan.summary).toContain("4 rounds don't fit");
    expect(plan.summary).toMatch(/Shorten the cadence|extend Block 1/);
  });

  it('fits once the cadence is weekly', () => {
    const weekly = planRoundDates({
      calendar: KZNCU,
      blockId: 'b1',
      cadence: { kind: 'weekly' },
      rounds: 11,
    });
    expect(weekly.fits).toBe(true);
  });
});

describe('planRoundDates — EMCU Division 5 (Saturdays only)', () => {
  const plan = planRoundDates({
    calendar: KZNCU,
    blockId: 'b1',
    cadence: { kind: 'weekdays', days: [SATURDAY] },
    rounds: 5,
  });

  it('places every round on a Saturday', () => {
    expect(plan.fits).toBe(true);
    expect(plan.dates.map(weekdayOf)).toEqual([SATURDAY, SATURDAY, SATURDAY, SATURDAY, SATURDAY]);
  });

  it('starts on the first Saturday on or after the block start', () => {
    // Block 1 opens Sunday 13 Sep, so the first Saturday is the 19th.
    expect(plan.dates[0]).toBe('2026-09-19');
  });

  it('supports multiple playing days', () => {
    const both = planRoundDates({
      calendar: KZNCU,
      blockId: 'b1',
      cadence: { kind: 'weekdays', days: [SATURDAY, SUNDAY] },
      rounds: 4,
    });
    expect(both.dates).toEqual(['2026-09-13', '2026-09-19', '2026-09-20', '2026-09-26']);
  });

  it('refuses to guess when no day is selected', () => {
    const none = planRoundDates({
      calendar: KZNCU,
      blockId: 'b1',
      cadence: { kind: 'weekdays', days: [] },
      rounds: 4,
    });
    expect(none.fits).toBe(false);
    expect(none.summary).toContain('Pick at least one day');
  });
});

describe('planRoundDates — breaks and excluded dates push rounds later, never drop them', () => {
  it('steps over a break inside a block instead of scheduling into it', () => {
    const withInnerBreak: SeasonCalendar = {
      ...KZNCU,
      breaks: [
        ...(KZNCU.breaks ?? []),
        { label: 'the exam window', start: '2026-09-20', end: '2026-10-04' },
      ],
    };
    const plan = planRoundDates({
      calendar: withInnerBreak,
      blockId: 'b1',
      cadence: { kind: 'weekly' },
      rounds: 3,
    });
    // 20 Sep, 27 Sep and 4 Oct all fall in the exam window — the league resumes on the 11th.
    expect(plan.dates).toEqual(['2026-09-13', '2026-10-11', '2026-10-18']);
    expect(plan.roundsPlaced).toBe(3);
    expect(plan.skipped.map((s) => s.date)).toEqual(['2026-09-20', '2026-09-27', '2026-10-04']);
    expect(plan.summary).toContain('3 dates moved past the exam window');
  });

  it('steps over one-off excluded dates', () => {
    const withHoliday: SeasonCalendar = { ...KZNCU, excludeDates: ['2026-09-20'] };
    const plan = planRoundDates({
      calendar: withHoliday,
      blockId: 'b1',
      cadence: { kind: 'weekly' },
      rounds: 3,
    });
    expect(plan.dates).toEqual(['2026-09-13', '2026-09-27', '2026-10-04']);
  });

  it('never schedules into the mid-season break — the defect this engine exists to fix', () => {
    // 20 weekly rounds from Block 1 would previously have run straight into January.
    const plan = planRoundDates({
      calendar: KZNCU,
      blockId: 'b1',
      cadence: { kind: 'weekly' },
      rounds: 20,
    });
    expect(plan.fits).toBe(false);
    for (const d of plan.dates) expect(blockedReason(KZNCU, d)).toBeNull();
    expect(plan.dates.every((d) => d <= '2026-12-13')).toBe(true);
  });
});

describe('planRoundDates — spread cadence (pre-calendar behaviour, break-aware)', () => {
  it('distributes rounds evenly and lands the last one on the block end', () => {
    const plan = planRoundDates({
      calendar: KZNCU,
      blockId: 'b2',
      cadence: { kind: 'spread' },
      rounds: 5,
    });
    expect(plan.fits).toBe(true);
    expect(plan.dates[0]).toBe('2027-01-18');
    expect(plan.dates[4]).toBe('2027-03-28');
  });

  it('never stacks two rounds on one date', () => {
    const plan = planRoundDates({
      calendar: KZNCU,
      blockId: 'b2',
      cadence: { kind: 'spread' },
      rounds: 30,
    });
    expect(new Set(plan.dates).size).toBe(plan.dates.length);
    for (let i = 1; i < plan.dates.length; i++) {
      expect(plan.dates[i] > plan.dates[i - 1]).toBe(true);
    }
  });

  it('nudges a blocked date forward', () => {
    const plan = planRoundDates({
      calendar: { ...KZNCU, excludeDates: ['2027-01-18'] },
      blockId: 'b2',
      cadence: { kind: 'spread' },
      rounds: 3,
    });
    expect(plan.dates[0]).toBe('2027-01-19');
  });
});

describe('planRoundDates — start date handling', () => {
  it('honours a later start inside the block', () => {
    const plan = planRoundDates({
      calendar: KZNCU,
      blockId: 'b1',
      cadence: { kind: 'weekly' },
      rounds: 2,
      startDate: '2026-10-04',
    });
    expect(plan.dates).toEqual(['2026-10-04', '2026-10-11']);
  });

  it('clamps a start before the block opens', () => {
    const plan = planRoundDates({
      calendar: KZNCU,
      blockId: 'b1',
      cadence: { kind: 'weekly' },
      rounds: 1,
      startDate: '2026-08-01',
    });
    expect(plan.dates).toEqual(['2026-09-13']);
  });

  it('names a start date that falls after the block closes', () => {
    const plan = planRoundDates({
      calendar: KZNCU,
      blockId: 'b1',
      cadence: { kind: 'weekly' },
      rounds: 1,
      startDate: '2027-02-01',
    });
    expect(plan.fits).toBe(false);
    expect(plan.summary).toContain('after Block 1 ends');
  });
});

describe('planRoundDates — degrades instead of throwing on bad config', () => {
  it('survives a block the operator has since deleted', () => {
    const plan = planRoundDates({
      calendar: KZNCU,
      blockId: 'gone',
      cadence: { kind: 'weekly' },
      rounds: 5,
    });
    expect(plan.fits).toBe(false);
    expect(plan.summary).toContain('no longer exists');
  });

  it('rejects a block that ends before it starts', () => {
    const reversed: SeasonCalendar = {
      ...KZNCU,
      blocks: [{ id: 'bad', label: 'Backwards', start: '2026-12-13', end: '2026-09-13' }],
    };
    const plan = planRoundDates({
      calendar: reversed,
      blockId: 'bad',
      cadence: { kind: 'weekly' },
      rounds: 3,
    });
    expect(plan.fits).toBe(false);
    expect(plan.summary).toContain('ends before it starts');
  });

  it('treats zero rounds as trivially satisfied', () => {
    const plan = planRoundDates({
      calendar: KZNCU,
      blockId: 'b1',
      cadence: { kind: 'weekly' },
      rounds: 0,
    });
    expect(plan.fits).toBe(true);
    expect(plan.dates).toEqual([]);
  });

  it('clamps a nonsensical week stride rather than looping forever', () => {
    const plan = planRoundDates({
      calendar: KZNCU,
      blockId: 'b1',
      cadence: { kind: 'every-n-weeks', n: 0 },
      rounds: 3,
    });
    expect(plan.dates).toEqual(['2026-09-13', '2026-09-20', '2026-09-27']);
  });
});

describe('blockedReason / findBlock', () => {
  it('reports break membership inclusively at both ends', () => {
    expect(blockedReason(KZNCU, '2026-12-14')).toBe('the mid-season break');
    expect(blockedReason(KZNCU, '2027-01-17')).toBe('the mid-season break');
    expect(blockedReason(KZNCU, '2027-01-18')).toBeNull();
  });

  it('reports excluded dates', () => {
    expect(blockedReason({ ...KZNCU, excludeDates: ['2026-10-04'] }, '2026-10-04')).toBe(
      'excluded date',
    );
  });

  it('finds a block by id', () => {
    expect(findBlock(KZNCU, 'b2')?.label).toBe('Block 2');
    expect(findBlock(KZNCU, 'nope')).toBeUndefined();
  });
});

describe('describeCadence', () => {
  it('reads as a human sentence fragment', () => {
    expect(describeCadence({ kind: 'weekly' })).toBe('weekly');
    expect(describeCadence({ kind: 'every-n-weeks', n: 2 })).toBe('every 2 weeks');
    expect(describeCadence({ kind: 'weekdays', days: [SATURDAY] })).toBe('Saturday only');
    expect(describeCadence({ kind: 'weekdays', days: [SATURDAY, SUNDAY] })).toBe(
      'Saturday / Sunday only',
    );
    expect(describeCadence({ kind: 'spread' })).toBe('spread across the block');
  });
});

describe('slotForIndex', () => {
  const slots = [
    { label: 'Morning', start: '08:00' },
    { label: 'Afternoon', start: '13:30' },
  ];

  it('cycles fixtures through the configured slots', () => {
    expect(slotForIndex(slots, 0)?.start).toBe('08:00');
    expect(slotForIndex(slots, 1)?.start).toBe('13:30');
    expect(slotForIndex(slots, 2)?.start).toBe('08:00');
  });

  it('is undefined when no slots are configured', () => {
    expect(slotForIndex(undefined, 0)).toBeUndefined();
    expect(slotForIndex([], 0)).toBeUndefined();
  });
});

describe('isActivated — junior delayed visibility', () => {
  it('hides a series until its activation date', () => {
    expect(isActivated('2027-01-18', '2026-11-01')).toBe(false);
    expect(isActivated('2027-01-18', '2027-01-17')).toBe(false);
  });

  it('shows it on and after the date', () => {
    expect(isActivated('2027-01-18', '2027-01-18')).toBe(true);
    expect(isActivated('2027-01-18', '2027-02-01')).toBe(true);
  });

  it('defaults to visible so nothing existing changes behaviour', () => {
    expect(isActivated(undefined, '2026-11-01')).toBe(true);
    expect(isActivated('', '2026-11-01')).toBe(true);
    expect(isActivated('not-a-date', '2026-11-01')).toBe(true);
  });
});

describe('todayIso', () => {
  it('reads the local calendar day, not the UTC instant', () => {
    // 23:30 on 13 Sep in a UTC+2 tenant is still the 13th locally; a naive
    // toISOString() would call it the 13th only by luck of the offset sign.
    const local = new Date(2026, 8, 13, 23, 30);
    expect(todayIso(local)).toBe('2026-09-13');
  });
});
