import { describe, it, expect } from 'vitest';
import {
  generateRoundRobin,
  resolveSpread,
  greeting,
  safeguardingMeta,
  safeguardingSatisfied,
  ageFromSaId,
  termRemaining,
} from './data';

// 6 teams → 5 single round-robin rounds (each round = one match-day).
const SIX = ['a', 'b', 'c', 'd', 'e', 'f'];
const roundDates = (fixtures) => [...new Set(fixtures.map((f) => f.date))].sort();

describe('generateRoundRobin', () => {
  it('falls back to weekly rounds when no end date is given (backward-compatible)', () => {
    const dates = roundDates(generateRoundRobin(SIX, '2026-08-01'));
    expect(dates).toEqual(['2026-08-01', '2026-08-08', '2026-08-15', '2026-08-22', '2026-08-29']);
  });

  it('ignores the end date in reference mode (spread:false stays weekly)', () => {
    const dates = roundDates(
      generateRoundRobin(SIX, '2026-08-01', { endDateISO: '2026-08-05', spread: false }),
    );
    expect(dates[0]).toBe('2026-08-01');
    expect(dates[1]).toBe('2026-08-08'); // still +7 days, end date untouched
  });

  it('spreads rounds across the window, last round landing on the end date', () => {
    const dates = roundDates(
      generateRoundRobin(SIX, '2026-08-01', { endDateISO: '2026-08-05', spread: true }),
    );
    // 5 rounds over a 4-day window → one round per day, no collisions.
    expect(dates).toEqual(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05']);
  });

  it('spreads odd teams correctly — bye padding makes n rounds, not n-1', () => {
    // 5 teams pad to 6 → 5 rounds (the bye-padding invariant). A 4-day window
    // gives one round per day, last on the end date.
    const dates = roundDates(
      generateRoundRobin(['a', 'b', 'c', 'd', 'e'], '2026-08-01', {
        endDateISO: '2026-08-05',
        spread: true,
      }),
    );
    expect(dates).toEqual(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05']);
  });

  it('never stacks two rounds on the same date even when the window is too short', () => {
    // 5 rounds over a 2-day window would imply a sub-day step; the one-day floor
    // keeps every round on a distinct date (last round overruns the window).
    const dates = roundDates(
      generateRoundRobin(['a', 'b', 'c', 'd', 'e'], '2026-08-01', {
        endDateISO: '2026-08-03',
        spread: true,
      }),
    );
    expect(dates).toHaveLength(5);
    expect(dates).toEqual(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05']);
  });

  it('places a 2-team competition as a single fixture on the start date', () => {
    const fixtures = generateRoundRobin(['a', 'b'], '2026-08-01', {
      endDateISO: '2026-08-10',
      spread: true,
    });
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].date).toBe('2026-08-01');
  });

  it('returns no fixtures for fewer than two teams', () => {
    expect(generateRoundRobin(['a'], '2026-08-01')).toEqual([]);
  });
});

describe('resolveSpread (smart default — guards the create/regenerate parity)', () => {
  it('defaults a tournament to spread when no explicit mode is stored', () => {
    expect(resolveSpread({ kind: 'tournament', dateMode: '' })).toBe(true);
    expect(resolveSpread({ kind: 'tournament' })).toBe(true);
  });

  it('defaults a series to reference when no explicit mode is stored', () => {
    expect(resolveSpread({ kind: 'series', dateMode: '' })).toBe(false);
    expect(resolveSpread({ kind: 'series' })).toBe(false);
  });

  it('honours an explicit mode over the format default', () => {
    expect(resolveSpread({ kind: 'tournament', dateMode: 'reference' })).toBe(false);
    expect(resolveSpread({ kind: 'series', dateMode: 'spread' })).toBe(true);
  });

  it('produces identical fixtures on create then regenerate (the parity bug it guards)', () => {
    // Tournament with an end date, admin never touches the toggle. This is the
    // exact case where the create path's smart default once diverged from
    // regenerate's literal read of a blank dateMode.
    const teams = ['a', 'b', 'c', 'd', 'e', 'f'];
    const startDate = '2026-08-01';
    const endDate = '2026-08-05';

    // Create: smart default resolves spread; the form persists the resolved mode.
    const draft = { kind: 'tournament', dateMode: '', startDate, endDate, teams };
    const createFixtures = generateRoundRobin(teams, startDate, {
      endDateISO: endDate,
      spread: resolveSpread(draft),
    });
    const stored = { ...draft, dateMode: resolveSpread(draft) ? 'spread' : 'reference' };

    // Regenerate: reads the stored series back through the same helper.
    const regenFixtures = generateRoundRobin(stored.teams, stored.startDate, {
      endDateISO: stored.endDate,
      spread: resolveSpread(stored),
    });

    expect(regenFixtures).toEqual(createFixtures);
  });
});

describe('greeting', () => {
  const at = (h) => new Date(2026, 5, 11, h, 0, 0);
  it('is morning before noon', () => {
    expect(greeting(at(0))).toBe('Good morning');
    expect(greeting(at(11))).toBe('Good morning');
  });
  it('is afternoon from noon to 17:59', () => {
    expect(greeting(at(12))).toBe('Good afternoon');
    expect(greeting(at(17))).toBe('Good afternoon');
  });
  it('is evening from 18:00', () => {
    expect(greeting(at(18))).toBe('Good evening');
    expect(greeting(at(23))).toBe('Good evening');
  });
});

describe('safeguardingMeta', () => {
  it('normalizes missing meta to an empty file list', () => {
    expect(safeguardingMeta(undefined)).toEqual({
      files: [],
      markedCompliant: false,
      courseBooked: false,
      courseDate: '',
      at: undefined,
    });
  });

  it('normalizes a legacy single upload to a one-entry array', () => {
    const legacy = { objectKey: 't/c/safeguarding-x.pdf', size: 10, uploadedAt: '2026-01-01' };
    expect(safeguardingMeta(legacy)).toEqual({
      files: [legacy],
      markedCompliant: false,
      courseBooked: false,
      courseDate: '',
    });
  });

  it('normalizes the legacy admin sentinel to empty files with the flag', () => {
    expect(safeguardingMeta({ markedCompliant: true, at: '2026-01-01' })).toEqual({
      files: [],
      markedCompliant: true,
      courseBooked: false,
      courseDate: '',
      at: '2026-01-01',
    });
  });

  it('passes the canonical wrapper shape through', () => {
    const files = [{ objectKey: 'a' }, { objectKey: 'b' }];
    expect(safeguardingMeta({ files, markedCompliant: true, at: 'T' })).toEqual({
      files,
      markedCompliant: true,
      courseBooked: false,
      courseDate: '',
      at: 'T',
    });
  });

  it('surfaces a booked safeguarding course (no files yet)', () => {
    expect(safeguardingMeta({ files: [], courseBooked: true, courseDate: '2026-09-01' })).toEqual({
      files: [],
      markedCompliant: false,
      courseBooked: true,
      courseDate: '2026-09-01',
      at: undefined,
    });
    expect(safeguardingSatisfied({ files: [], courseBooked: true, courseDate: '2026-09-01' })).toBe(
      true,
    );
  });
});

describe('safeguardingSatisfied', () => {
  it('requires the two-person minimum', () => {
    expect(safeguardingSatisfied(undefined)).toBe(false);
    expect(safeguardingSatisfied({ files: [{ objectKey: 'a' }] })).toBe(false);
    expect(safeguardingSatisfied({ files: [{ objectKey: 'a' }, { objectKey: 'b' }] })).toBe(true);
  });

  it('honours an admin override regardless of file count', () => {
    expect(safeguardingSatisfied({ files: [], markedCompliant: true })).toBe(true);
  });
});

describe('ageFromSaId', () => {
  it('derives a whole-year age from a valid RSA ID', () => {
    // 900101… → born 1990-01-01. Age is at least 30 from any date after 2020.
    const age = ageFromSaId('9001015800086');
    expect(typeof age).toBe('number');
    expect(age).toBeGreaterThanOrEqual(30);
  });

  it('returns null for a malformed ID', () => {
    expect(ageFromSaId('123')).toBeNull();
    expect(ageFromSaId('')).toBeNull();
    expect(ageFromSaId(undefined)).toBeNull();
  });
});

describe('termRemaining', () => {
  it('reports expired for a past end date', () => {
    expect(termRemaining('2000-01-01').expired).toBe(true);
    expect(termRemaining('2000-01-01').label).toBe('expired');
  });

  it('returns an empty label when no end date is given', () => {
    expect(termRemaining('').label).toBe('');
    expect(termRemaining(undefined).label).toBe('');
  });

  it('produces a human label for a future end date', () => {
    const far = new Date();
    far.setFullYear(far.getFullYear() + 2);
    const t = termRemaining(far.toISOString());
    expect(t.expired).toBe(false);
    expect(t.years).toBeGreaterThanOrEqual(1);
    expect(t.label).toMatch(/left$/);
  });
});
