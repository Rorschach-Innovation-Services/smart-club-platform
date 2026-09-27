/**
 * Tenant-configured competition defaults (ADR 0014) and the built-in fallbacks they replace.
 *
 * Only two fields survive as tenant configuration (config-only, no UI): `venueAliases`
 * (clash-gate input) and `travel` (costing). Match formats, match days and default start
 * times revert to built-ins — overs now live on the structure (`CompetitionStructure.overs`).
 *
 * The fallbacks are what the platform used before tenants could configure any of this, so
 * a tenant with no `competitionDefaults` behaves exactly as it did. Pure and shared by the
 * console and the API.
 */
import type { CompetitionDefaults, MatchFormatDefault, TimeSlot, Weekday } from './types';

/**
 * The match formats offered when a tenant has configured none.
 * @deprecated Formats revert to built-ins and overs live on the structure; deleted in WS6.
 */
export const FALLBACK_MATCH_FORMATS: readonly MatchFormatDefault[] = [
  { label: 'Twenty20 (16-25 overs)', overs: 20 },
  { label: 'One-Day (40-50 overs)', overs: 50 },
  { label: 'Multi-Day' },
  { label: 'The Hundred' },
];

/**
 * Default start times for a double-header day: a morning and an afternoon match.
 * @deprecated Kept only for downstream consumers until WS6; the engine's templates use
 * their own inline constant.
 */
export const FALLBACK_TIME_SLOTS: readonly TimeSlot[] = [
  { label: 'Morning', start: '08:00' },
  { label: 'Afternoon', start: '13:30' },
];

/**
 * Saturday.
 * @deprecated Kept only for downstream consumers until WS6.
 */
export const FALLBACK_MATCH_DAYS: readonly Weekday[] = [6];

export const FALLBACK_TRAVEL: Readonly<{ costPerKm: number; carsPerAwayTrip: number }> = {
  costPerKm: 4.5,
  carsPerAwayTrip: 3,
};

export interface ResolvedCompetitionDefaults {
  /**
   * The tenant's own ground-name aliases (`normaliseName` form). Absent ⇒ `{}`. The API's
   * clash gates merge these over the code defaults (`venueAliasesFor`).
   */
  venueAliases: Record<string, string>;
  travel: { costPerKm: number; carsPerAwayTrip: number };
  /** @deprecated Reverts to built-ins; deleted in WS6. Still resolved until then. */
  matchFormats: MatchFormatDefault[];
  /** @deprecated Reverts to built-ins; deleted in WS6. Still resolved until then. */
  matchDays: Weekday[];
  /** @deprecated Reverts to built-ins; deleted in WS6. Still resolved until then. */
  timeSlots: TimeSlot[];
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
    venueAliases: { ...(d?.venueAliases ?? {}) },
    travel: { ...(d?.travel ?? FALLBACK_TRAVEL) },
    matchFormats: (d?.matchFormats?.length ? d.matchFormats : FALLBACK_MATCH_FORMATS).map((f) => ({
      ...f,
    })),
    matchDays: [...(d?.matchDays?.length ? d.matchDays : FALLBACK_MATCH_DAYS)],
    timeSlots: (d?.timeSlots?.length ? d.timeSlots : FALLBACK_TIME_SLOTS).map((s) => ({ ...s })),
  };
}
