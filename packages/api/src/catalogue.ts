/**
 * Server-side copy of the (frozen, v1) cricket catalogue, used to validate
 * affiliation input. These mirror the shared defaults in the frontend's
 * data.jsx; per-tenant catalogue overrides are a phase-2 feature
 * (see docs/architecture/0005), so duplicating the frozen keys here is acceptable.
 */

export const VALID_DISTRICTS = new Set([
  'Ethekwini Metro Cricket Union',
  'Umkhanyakude Cricket District',
  'Ugu Cricket District',
  'KCCD',
  'Illembe Cricket District',
]);

/**
 * Validate an affiliation/CQI patch. Throws a message string on failure
 * (callers map to HTTP 400). Only checks fields present in the patch.
 *
 * Leagues are now per-tenant (admin-managed in TenantConfig), so valid league
 * keys are supplied by the caller — the tenant's catalogue keys plus any keys
 * already on the club (so removing an orphaned/deleted league still validates).
 */
export function validateClubPatch(
  patch: {
    district?: string;
    leagues?: string[];
    // Accepted as part of a club patch but no longer validated here — the
    // representation sum-to-100 rule was removed when those fields became head-counts.
    cqiAnswers?: Record<string, unknown>;
  },
  validLeagueKeys: Set<string>,
): string | null {
  if (patch.district && !VALID_DISTRICTS.has(patch.district)) {
    return `unknown district: ${patch.district}`;
  }
  if (patch.leagues) {
    const bad = patch.leagues.filter((k) => !validLeagueKeys.has(k));
    if (bad.length) return `unknown league keys: ${bad.join(', ')}`;
  }
  return null;
}
