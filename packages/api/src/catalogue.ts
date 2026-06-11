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
 * Server-side mirror of REQUIRED_DOCS in the frontend's data.jsx — the only
 * compliance-doc keys the API accepts. Without this gate any authenticated
 * client (e.g. a stale pre-deploy SPA tab) can write retired or arbitrary keys,
 * recreating the orphaned-PII state that cleanup-club-inventory exists to
 * remove (see docs/guides/popia-compliance.md). Keep in sync when
 * REQUIRED_DOCS changes.
 */
export const DOC_KEYS = new Set([
  'constitution',
  'agm',
  'financials',
  'exco',
  'codeOfConduct',
  'safeguarding',
]);

/**
 * Validate an affiliation/CQI patch. Throws a message string on failure
 * (callers map to HTTP 400). Only checks fields present in the patch.
 *
 * Leagues are now per-tenant (admin-managed in TenantConfig), so valid league
 * keys are supplied by the caller — the tenant's catalogue keys plus any keys
 * already on the club (so removing an orphaned/deleted league still validates).
 * Doc keys follow the same union pattern: DOC_KEYS plus keys already on the
 * club, so a patch can still carry/clear a retired key that predates the
 * cleanup script, but can never introduce one.
 */
export function validateClubPatch(
  patch: {
    district?: string;
    leagues?: string[];
    docs?: Record<string, unknown>;
    docMeta?: Record<string, unknown>;
    // Accepted as part of a club patch but no longer validated here — the
    // representation sum-to-100 rule was removed when those fields became head-counts.
    cqiAnswers?: Record<string, unknown>;
  },
  validLeagueKeys: Set<string>,
  validDocKeys: Set<string>,
): string | null {
  if (patch.district && !VALID_DISTRICTS.has(patch.district)) {
    return `unknown district: ${patch.district}`;
  }
  if (patch.leagues) {
    const bad = patch.leagues.filter((k) => !validLeagueKeys.has(k));
    if (bad.length) return `unknown league keys: ${bad.join(', ')}`;
  }
  const docKeys = [...Object.keys(patch.docs ?? {}), ...Object.keys(patch.docMeta ?? {})];
  const badDocs = [...new Set(docKeys.filter((k) => !validDocKeys.has(k)))];
  if (badDocs.length) return `unknown document keys: ${badDocs.join(', ')}`;
  return null;
}
