import { describe, it, expect } from 'vitest';
import {
  FALLBACK_MATCH_FORMATS,
  FALLBACK_TIME_SLOTS,
  resolveCompetitionDefaults,
} from './defaults';

describe('resolveCompetitionDefaults', () => {
  it('fills every field from the built-in fallbacks when a tenant configured nothing', () => {
    for (const config of [undefined, null, {}, { competitionDefaults: {} }]) {
      const d = resolveCompetitionDefaults(config);
      expect(d.matchFormats).toEqual(FALLBACK_MATCH_FORMATS);
      expect(d.matchDays).toEqual([6]);
      expect(d.timeSlots).toEqual(FALLBACK_TIME_SLOTS);
      expect(d.travel).toEqual({ costPerKm: 4.5, carsPerAwayTrip: 3 });
    }
  });

  it('uses each field the tenant set, and the fallback for the rest', () => {
    const d = resolveCompetitionDefaults({
      competitionDefaults: {
        matchFormats: [{ label: 'T20 (Pink Ball)', overs: 20, ballType: 'Pink' }],
        matchDays: [0, 6],
        travel: { costPerKm: 6, carsPerAwayTrip: 2 },
      },
    });
    expect(d.matchFormats).toEqual([{ label: 'T20 (Pink Ball)', overs: 20, ballType: 'Pink' }]);
    expect(d.matchDays).toEqual([0, 6]);
    expect(d.travel).toEqual({ costPerKm: 6, carsPerAwayTrip: 2 });
    expect(d.timeSlots).toEqual(FALLBACK_TIME_SLOTS);
  });

  it('treats an empty list as unset, so a tenant can never end up with no formats to pick', () => {
    const d = resolveCompetitionDefaults({
      competitionDefaults: { matchFormats: [], matchDays: [], timeSlots: [] },
    });
    expect(d.matchFormats).toEqual(FALLBACK_MATCH_FORMATS);
    expect(d.matchDays).toEqual([6]);
    expect(d.timeSlots).toEqual(FALLBACK_TIME_SLOTS);
  });

  it('returns fresh copies, so editing the result never edits the config or the fallbacks', () => {
    const config = { competitionDefaults: { timeSlots: [{ label: 'Only', start: '10:00' }] } };
    const d = resolveCompetitionDefaults(config);
    d.timeSlots[0].label = 'Changed';
    d.matchFormats[0].label = 'Changed';
    expect(config.competitionDefaults.timeSlots[0].label).toBe('Only');
    expect(FALLBACK_MATCH_FORMATS[0].label).toBe('Twenty20 (16-25 overs)');
  });
});
