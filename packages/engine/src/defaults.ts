/**
 * Tenant-configured competition defaults (ADR 0014) and the built-in fallbacks they replace.
 *
 * The fallbacks are what the platform used before tenants could configure any of this, so
 * a tenant with no `competitionDefaults` behaves exactly as it did. Pure and shared by the
 * console and the API.
 */
import type { CompetitionDefaults, MatchFormatDefault, TimeSlot, Weekday } from './types';

/** The match formats offered when a tenant has configured none. */
export const FALLBACK_MATCH_FORMATS: readonly MatchFormatDefault[] = [
  { label: 'Twenty20 (16-25 overs)', overs: 20 },
  { label: 'One-Day (40-50 overs)', overs: 50 },
  { label: 'Multi-Day' },
  { label: 'The Hundred' },
];

/** Default start times for a double-header day: a morning and an afternoon match. */
export const FALLBACK_TIME_SLOTS: readonly TimeSlot[] = [
  { label: 'Morning', start: '08:00' },
  { label: 'Afternoon', start: '13:30' },
];

/** Saturday. */
export const FALLBACK_MATCH_DAYS: readonly Weekday[] = [6];

export const FALLBACK_TRAVEL: Readonly<{ costPerKm: number; carsPerAwayTrip: number }> = {
  costPerKm: 4.5,
  carsPerAwayTrip: 3,
};

export interface ResolvedCompetitionDefaults {
  matchFormats: MatchFormatDefault[];
  matchDays: Weekday[];
  timeSlots: TimeSlot[];
  travel: { costPerKm: number; carsPerAwayTrip: number };
}

/**
 * The tenant's defaults with every absent (or empty) field filled from the fallbacks.
 * Always returns fresh arrays and objects, so a caller may keep or edit the result without
 * touching the config or the fallback constants.
 */
export function resolveCompetitionDefaults(
  config?: { competitionDefaults?: CompetitionDefaults } | null,
): ResolvedCompetitionDefaults {
  const d = config?.competitionDefaults;
  return {
    matchFormats: (d?.matchFormats?.length ? d.matchFormats : FALLBACK_MATCH_FORMATS).map((f) => ({
      ...f,
    })),
    matchDays: [...(d?.matchDays?.length ? d.matchDays : FALLBACK_MATCH_DAYS)],
    timeSlots: (d?.timeSlots?.length ? d.timeSlots : FALLBACK_TIME_SLOTS).map((s) => ({ ...s })),
    travel: { ...(d?.travel ?? FALLBACK_TRAVEL) },
  };
}
