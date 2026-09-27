import { describe, it, expect } from 'vitest';
import { FALLBACK_MATCH_FORMATS, resolveCompetitionDefaults } from './defaults';

describe('resolveCompetitionDefaults', () => {
  it('falls back to no aliases and the built-in travel cost when a tenant configured nothing', () => {
    for (const config of [undefined, null, {}, { competitionDefaults: {} }]) {
      const d = resolveCompetitionDefaults(config);
      expect(d.venueAliases).toEqual({});
      expect(d.travel).toEqual({ costPerKm: 4.5, carsPerAwayTrip: 3 });
    }
  });

  it('uses the tenant’s own venue aliases and travel cost', () => {
    const d = resolveCompetitionDefaults({
      competitionDefaults: {
        venueAliases: { acc1: 'toti1' },
        travel: { costPerKm: 6, carsPerAwayTrip: 2 },
      },
    });
    expect(d.venueAliases).toEqual({ acc1: 'toti1' });
    expect(d.travel).toEqual({ costPerKm: 6, carsPerAwayTrip: 2 });
  });

  it('returns fresh copies, so editing the result never edits the config or the fallbacks', () => {
    const config = {
      competitionDefaults: { venueAliases: { acc1: 'toti1' } as Record<string, string> },
    };
    const d = resolveCompetitionDefaults(config);
    d.venueAliases.acc1 = 'changed';
    d.travel.costPerKm = 99;
    expect(config.competitionDefaults.venueAliases.acc1).toBe('toti1');
    expect(resolveCompetitionDefaults().travel.costPerKm).toBe(4.5);
  });

  // Deprecated fields — still resolved for downstream consumers until WS6 deletes them.
  it('still resolves the deprecated format/day/slot fields until WS6', () => {
    const empty = resolveCompetitionDefaults({
      competitionDefaults: { matchFormats: [], matchDays: [], timeSlots: [] },
    });
    expect(empty.matchFormats).toEqual(FALLBACK_MATCH_FORMATS);
    expect(empty.matchDays).toEqual([6]);
    expect(empty.timeSlots).toEqual([
      { label: 'Morning', start: '08:00' },
      { label: 'Afternoon', start: '13:30' },
    ]);
    const set = resolveCompetitionDefaults({
      competitionDefaults: { matchFormats: [{ label: 'T20', overs: 20 }], matchDays: [0, 6] },
    });
    expect(set.matchFormats).toEqual([{ label: 'T20', overs: 20 }]);
    expect(set.matchDays).toEqual([0, 6]);
  });
});
