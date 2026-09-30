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
import type { CompetitionDefaults } from './types';

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
}

/**
 * The tenant's defaults with every absent field filled from the fallbacks. Always returns
 * fresh objects, so a caller may keep or edit the result without touching the config or
 * the fallback constants.
 */
export function resolveCompetitionDefaults(
  config?: { competitionDefaults?: CompetitionDefaults } | null,
): ResolvedCompetitionDefaults {
  const d = config?.competitionDefaults;
  return {
    venueAliases: { ...(d?.venueAliases ?? {}) },
    travel: { ...(d?.travel ?? FALLBACK_TRAVEL) },
  };
}
