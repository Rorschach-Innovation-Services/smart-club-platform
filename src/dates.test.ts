import { describe, it, expect } from 'vitest';
import {
  daysSince,
  daysUntilDate,
  formatDay,
  formatDayLong,
  formatDayMid,
  formatDayYear,
  formatStamp,
  formatStampDay,
  formatTime,
  formatWeekdayDay,
  formatWeekdayDayYear,
  formatWeekdayLong,
  formatWeekdayName,
  isRealDate,
  monthsUntil,
  timeAgo,
  todayDate,
  wholeYearsSince,
} from './dates';

describe('date-only display', () => {
  // The whole reason this module exists: `en-ZA` rendered "21 Jun" while `en-GB`
  // rendered "13 Sept" in the same console. dayjs formats from its own bundled locale,
  // so the abbreviation is identical everywhere and across runtimes.
  it('uses one set of month abbreviations everywhere', () => {
    expect(formatDay('2026-09-13')).toBe('13 Sep');
    expect(formatDay('2026-06-21')).toBe('21 Jun');
    expect(formatDayYear('2026-09-13')).toBe('13 Sep 2026');
  });

  it('spells the month out for the long and mid forms', () => {
    expect(formatDayLong('2026-06-21')).toBe('21 June 2026');
    expect(formatDayMid('2026-06-21')).toBe('21 June');
  });

  it('renders weekdays', () => {
    expect(formatWeekdayDay('2026-09-13')).toBe('Sun 13 Sep');
    expect(formatWeekdayDayYear('2026-09-13')).toBe('Sun 13 Sep 2026');
    expect(formatWeekdayName('2026-09-13')).toBe('Sunday');
    expect(formatWeekdayLong('2026-09-13')).toBe('Sunday, 13 September 2026');
  });

  /**
   * The bug this prevents. `new Date('2026-09-13')` parses at UTC midnight and then
   * renders in the host's zone, so anywhere west of Greenwich a fixture on the 13th
   * displayed as the 12th. Anchoring to UTC makes the calendar day fixed.
   */
  it('never shifts a calendar day, whatever the host zone', () => {
    for (const iso of ['2026-01-01', '2026-09-13', '2026-12-31']) {
      expect(formatDayYear(iso)).toBe(
        `${Number(iso.slice(8))} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`,
      );
    }
  });

  it('renders nothing for missing or malformed input rather than "Invalid Date"', () => {
    for (const fn of [formatDay, formatDayYear, formatDayLong, formatWeekdayDay]) {
      expect(fn(undefined)).toBe('');
      expect(fn('')).toBe('');
      expect(fn('not a date')).toBe('');
    }
  });

  it('accepts a full timestamp where a stored field can be either shape', () => {
    expect(formatDay('2026-09-13T10:00:00.000Z')).toBe('13 Sep');
  });
});

describe('instant display', () => {
  it('renders a timestamp in local wall-clock terms', () => {
    // Built from local parts so the expectation holds in any zone.
    const iso = new Date(2026, 5, 4, 14, 32).toISOString();
    expect(formatStamp(iso)).toBe('4 Jun 2026, 14:32');
    expect(formatStampDay(iso)).toBe('4 Jun 2026');
  });

  it('is blank for missing input', () => {
    expect(formatStamp(undefined)).toBe('');
    expect(formatStampDay('')).toBe('');
  });
});

describe('formatTime', () => {
  it('normalises a valid HH:MM time', () => {
    expect(formatTime('09:00')).toBe('09:00');
    expect(formatTime('13:30')).toBe('13:30');
  });

  it('is null for missing or malformed input', () => {
    expect(formatTime(undefined)).toBeNull();
    expect(formatTime('')).toBeNull();
    expect(formatTime('not a time')).toBeNull();
    expect(formatTime('9:00')).toBeNull(); // not zero-padded — reject rather than guess
    expect(formatTime('25:00')).toBeNull();
    expect(formatTime('2026-09-13')).toBeNull();
  });
});

describe('arithmetic', () => {
  it('counts whole days to a deadline, floored at 0', () => {
    const now = new Date(2026, 5, 18);
    expect(daysUntilDate('2026-06-21', now)).toBe(3);
    expect(daysUntilDate('2026-06-18', now)).toBe(0);
    expect(daysUntilDate('2026-01-01', now)).toBe(0);
    expect(daysUntilDate(undefined, now)).toBe(0);
  });

  it('counts whole days since an instant', () => {
    const now = Date.UTC(2026, 5, 18);
    expect(daysSince(new Date(now - 3 * 86400000).toISOString(), now)).toBe(3);
    expect(daysSince(new Date(now + 86400000).toISOString(), now)).toBe(0);
    expect(daysSince(undefined, now)).toBeNull();
    expect(daysSince('rubbish', now)).toBeNull();
  });

  it('formats a compact time-ago label', () => {
    const now = Date.UTC(2026, 5, 18, 12);
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(timeAgo(ago(0), now)).toBe('just now');
    expect(timeAgo(ago(59_000), now)).toBe('just now');
    expect(timeAgo(ago(60_000), now)).toBe('1m ago');
    expect(timeAgo(ago(3_600_000), now)).toBe('1h ago');
    expect(timeAgo(ago(3 * 86_400_000), now)).toBe('3d ago');
    expect(timeAgo(undefined, now)).toBe('');
  });
});

describe('isRealDate', () => {
  // Strict parsing is the point: the lenient Date constructor rolls 31 February into
  // March, so the old code had to re-read month and day to notice.
  it('rejects a day that does not exist instead of rolling it over', () => {
    expect(isRealDate('2027-02-31')).toBe(false);
    expect(isRealDate('2026-13-01')).toBe(false);
    expect(isRealDate('2026-02-28')).toBe(true);
    expect(isRealDate('2028-02-29')).toBe(true); // leap year
    expect(isRealDate('2027-02-29')).toBe(false);
  });

  it('rejects the wrong shape', () => {
    expect(isRealDate('13/09/2026')).toBe(false);
    expect(isRealDate('2026-09-13T00:00:00Z')).toBe(false);
    expect(isRealDate(undefined)).toBe(false);
  });
});

describe('wholeYearsSince', () => {
  it('counts completed years, not started ones', () => {
    const now = new Date(2026, 5, 18);
    expect(wholeYearsSince('1990-06-17', now)).toBe(36);
    expect(wholeYearsSince('1990-06-18', now)).toBe(36); // birthday today
    expect(wholeYearsSince('1990-06-19', now)).toBe(35); // tomorrow
  });

  it('is null for missing or malformed input', () => {
    expect(wholeYearsSince(undefined)).toBeNull();
    expect(wholeYearsSince('nope')).toBeNull();
  });
});

describe('monthsUntil', () => {
  it('reports whole months remaining', () => {
    const now = new Date(2026, 0, 15);
    expect(monthsUntil('2027-05-15', now)).toEqual({ months: 16, expired: false });
    expect(monthsUntil('2026-04-15', now)).toEqual({ months: 3, expired: false });
  });

  it('marks a past date expired', () => {
    const now = new Date(2026, 0, 15);
    expect(monthsUntil('2025-01-01', now)).toEqual({ months: 0, expired: true });
    expect(monthsUntil('2026-01-15', now)).toEqual({ months: 0, expired: true });
  });

  it('accepts a full timestamp, because the stored field can be either shape', () => {
    const now = new Date(2026, 0, 15);
    expect(monthsUntil('2027-01-15T00:00:00.000Z', now)?.expired).toBe(false);
  });

  it('is null for missing or malformed input', () => {
    expect(monthsUntil(undefined)).toBeNull();
    expect(monthsUntil('nope')).toBeNull();
  });
});

describe('todayDate', () => {
  it('reads the LOCAL calendar day, not the UTC instant', () => {
    // 23:30 local is still today locally; a naive toISOString() would roll over
    // to tomorrow anywhere east of Greenwich.
    expect(todayDate(new Date(2026, 8, 13, 23, 30))).toBe('2026-09-13');
    expect(todayDate(new Date(2026, 8, 13, 0, 30))).toBe('2026-09-13');
  });
});
