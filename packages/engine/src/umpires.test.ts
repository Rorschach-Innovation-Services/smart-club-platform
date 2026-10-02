import { describe, it, expect } from 'vitest';
import {
  findUmpireDoubleBookings,
  normaliseUmpireAlias,
  umpireAliasSet,
  type UmpireBooking,
} from './umpires';

const booking = (over: Partial<UmpireBooking> & { fixtureId: string }): UmpireBooking => ({
  umpireId: 'u-ngubane',
  seriesId: 's1',
  date: '2026-10-04',
  time: '09:00',
  venue: 'Kingsmead Oval',
  ...over,
});

describe('normaliseUmpireAlias', () => {
  it('collapses dots, spaces and case', () => {
    expect(normaliseUmpireAlias('A.Ngubane')).toBe('angubane');
    expect(normaliseUmpireAlias(' A. Ngubane ')).toBe('angubane');
    expect(normaliseUmpireAlias('L.Van Edan Govender')).toBe('lvanedangovender');
  });

  it('drops accents', () => {
    expect(normaliseUmpireAlias('J.Müller')).toBe('jmuller');
  });

  it('builds a deduplicated alias set from the name fields', () => {
    expect(
      umpireAliasSet({
        displayName: 'A.Ngubane',
        fullName: 'Andile Ngubane',
        aliases: ['A Ngubane'],
      }),
    ).toEqual(['angubane', 'andilengubane']);
  });
});

describe('findUmpireDoubleBookings', () => {
  it('does not warn for the same ground at 09:00 and 13:30', () => {
    const out = findUmpireDoubleBookings([
      booking({ fixtureId: 'f1', time: '09:00' }),
      booking({ fixtureId: 'f2', time: '13:30' }),
    ]);
    expect(out).toEqual([]);
  });

  it('does not warn for the same ground spelled differently', () => {
    const out = findUmpireDoubleBookings([
      booking({ fixtureId: 'f1', venue: 'Kingsmead Oval' }),
      booking({ fixtureId: 'f2', venue: 'KINGSMEAD  OVAL ' }),
    ]);
    expect(out).toEqual([]);
  });

  it('warns for two different grounds at overlapping times', () => {
    const out = findUmpireDoubleBookings([
      booking({ fixtureId: 'f1', time: '09:00', venue: 'Kingsmead Oval' }),
      booking({ fixtureId: 'f2', seriesId: 's2', time: '11:00', venue: 'Toti Oval 1' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].a.fixtureId).toBe('f1');
    expect(out[0].b.fixtureId).toBe('f2');
  });

  it('assumes a four-hour slot: 09:00 and 13:30 at different grounds do not overlap', () => {
    const out = findUmpireDoubleBookings([
      booking({ fixtureId: 'f1', time: '09:00', venue: 'Kingsmead Oval' }),
      booking({ fixtureId: 'f2', time: '13:30', venue: 'Toti Oval 1' }),
    ]);
    expect(out).toEqual([]);
  });

  it('treats 09:00 and 12:59 at different grounds as overlapping', () => {
    const out = findUmpireDoubleBookings([
      booking({ fixtureId: 'f1', time: '09:00', venue: 'Kingsmead Oval' }),
      booking({ fixtureId: 'f2', time: '12:59', venue: 'Toti Oval 1' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('honours an explicit end time over the default slot', () => {
    const out = findUmpireDoubleBookings([
      booking({ fixtureId: 'f1', time: '09:00', endTime: '11:00', venue: 'Kingsmead Oval' }),
      booking({ fixtureId: 'f2', time: '11:30', venue: 'Toti Oval 1' }),
    ]);
    expect(out).toEqual([]);
  });

  it('warns when a different-ground fixture has no start time', () => {
    const out = findUmpireDoubleBookings([
      booking({ fixtureId: 'f1', time: '09:00', venue: 'Kingsmead Oval' }),
      booking({ fixtureId: 'f2', time: undefined, venue: 'Toti Oval 1' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('never warns across different dates, different umpires or an unknown ground', () => {
    const out = findUmpireDoubleBookings([
      booking({ fixtureId: 'f1', venue: 'Kingsmead Oval' }),
      booking({ fixtureId: 'f2', date: '2026-10-03', venue: 'Toti Oval 1' }),
      booking({ fixtureId: 'f3', umpireId: 'u-other', venue: 'Toti Oval 1' }),
      booking({ fixtureId: 'f4', venue: undefined }),
    ]);
    expect(out).toEqual([]);
  });

  it('ignores the same fixture listed twice', () => {
    const out = findUmpireDoubleBookings([
      booking({ fixtureId: 'f1', venue: 'Kingsmead Oval' }),
      booking({ fixtureId: 'f1', venue: 'Toti Oval 1' }),
    ]);
    expect(out).toEqual([]);
  });
});
