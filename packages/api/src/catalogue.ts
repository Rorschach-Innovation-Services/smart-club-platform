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
 * Accepted compliance-upload content types → stored object-key extension.
 * Mirror of DOC_MIME_TYPES in the frontend's data.jsx. Word covers Google Docs
 * (which exports .docx/.pdf). The presigned PUT is minted with exactly one of
 * these, so S3 rejects anything else at upload time.
 */
export const DOC_CONTENT_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

/**
 * Safeguarding is a per-person certificate: a club needs one for at least two
 * people, stored as docMeta.safeguarding = { files: [...] }. Mirror of
 * MIN_SAFEGUARDING_FILES in the frontend's data.jsx.
 */
export const MIN_SAFEGUARDING_FILES = 2;
/** Upper bound on stored safeguarding certificates — a runaway-append backstop. */
export const MAX_SAFEGUARDING_FILES = 10;

/** Accepted coach-experience buckets (mirror of COACH_EXPERIENCE in the frontend's data.jsx). */
export const COACH_EXPERIENCE = new Set(['0-3', '4-10', '10+']);

/**
 * Lightweight SA-ID gate: 13 digits encoding a real YYMMDD. Mirrors the core of
 * dobFromSaId in index.ts (without the DOB return). Used to reject malformed
 * chair/coach IDs server-side, since validateClubPatch is the only guard on
 * exco/coach bodies.
 */
export function isValidSaId(idNumber: string): boolean {
  if (!/^\d{13}$/.test(idNumber)) return false;
  const mm = Number(idNumber.slice(2, 4));
  const dd = Number(idNumber.slice(4, 6));
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/** True when a value is a parseable date string (ISO or yyyy-mm-dd). */
function isParseableDate(v: unknown): boolean {
  if (typeof v !== 'string' || !v.trim()) return false;
  return !Number.isNaN(new Date(v).getTime());
}

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
 *
 * exco/coaches bodies were previously unchecked, so the affiliation form's new
 * governance fields (chair ID/term, coach ID/experience) are validated here —
 * this is the only server gate that sees them.
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
    exco?: Record<string, unknown>;
    coaches?: unknown[];
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

  // Chair governance fields (idNumber / termStart / termEnd) — only when supplied.
  const chair = (patch.exco as Record<string, unknown> | undefined)?.chair as
    | Record<string, unknown>
    | undefined;
  if (chair) {
    if (chair.idNumber && !isValidSaId(String(chair.idNumber))) {
      return 'chair idNumber must be a valid 13-digit RSA ID';
    }
    if (chair.termStart && !isParseableDate(chair.termStart))
      return 'invalid chair term start date';
    if (chair.termEnd && !isParseableDate(chair.termEnd)) return 'invalid chair term end date';
  }

  // Coach governance fields — only when supplied.
  if (Array.isArray(patch.coaches)) {
    for (const c of patch.coaches as Record<string, unknown>[]) {
      if (!c || typeof c !== 'object') continue;
      if (c.idNumber && !isValidSaId(String(c.idNumber))) {
        return 'coach idNumber must be a valid 13-digit RSA ID';
      }
      if (c.yearsExperience && !COACH_EXPERIENCE.has(String(c.yearsExperience))) {
        return `invalid coach experience bucket: ${String(c.yearsExperience)}`;
      }
      if (c.yearStarted && !/^\d{4}$/.test(String(c.yearStarted))) {
        return 'coach yearStarted must be a 4-digit year';
      }
    }
  }
  return null;
}
