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
 * Accepted chairperson "why are you involved in club cricket?" answers, captured on the
 * affiliation form. Mirror of INVOLVEMENT_REASONS in the frontend's data.ts. Validated only
 * when present — the field is required client-side for NEW affiliations, but legacy clubs
 * predate it, so the server must never make it mandatory (that would 400 every correction).
 */
export const INVOLVEMENT_REASONS = new Set([
  'Passion and love for the game of cricket',
  'Giving back to the cricket community',
  'Continuing a family or personal cricket legacy',
  'Building friendships and community connections',
  'Promoting cricket in my local area',
  'Staying involved in cricket after my playing career',
  'Volunteering and serving the community',
]);

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
    name?: string;
    district?: string;
    leagues?: string[];
    leagueTeams?: Record<string, number>;
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
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (!n) return 'club name cannot be empty';
    if (n.length > 80) return 'club name must be 80 characters or fewer';
  }
  if (patch.district && !VALID_DISTRICTS.has(patch.district)) {
    return `unknown district: ${patch.district}`;
  }
  if (patch.leagues) {
    const bad = patch.leagues.filter((k) => !validLeagueKeys.has(k));
    if (bad.length) return `unknown league keys: ${bad.join(', ')}`;
  }
  if (patch.leagueTeams) {
    for (const [k, v] of Object.entries(patch.leagueTeams)) {
      if (!Number.isInteger(v) || v < 1 || v > 30) {
        return 'team counts must be whole numbers between 1 and 30';
      }
      // Reject orphaned keys: a leagueTeams key must be one of the leagues being entered
      // (only checkable when leagues is also in the patch). Mirrors the doc-key allowlist —
      // since updateClub PUTs the whole object, an orphaned count would persist forever.
      if (patch.leagues && !patch.leagues.includes(k)) {
        return 'leagueTeams has keys not in leagues';
      }
    }
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
    // Validate the reason ONLY when supplied — never required (legacy clubs predate it).
    if (
      chair.reasonForInvolvement &&
      !INVOLVEMENT_REASONS.has(String(chair.reasonForInvolvement))
    ) {
      return 'invalid chair reasonForInvolvement';
    }
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

/**
 * True when a club shows real evidence of having worked on its affiliation form —
 * more than the chair-only seed every signup club starts with (buildInitialExco sets
 * only `exco.chair {name,email,cell}`). Drives the one-off backfill that promotes stuck
 * `not_started` clubs to `in_progress`. Deliberately ignores the `docs.exco` flag: an
 * admin "Mark as compliant" override sets it with no form data, which would otherwise
 * misread an untouched club as a draft.
 */
export function hasAffiliationDraft(club: {
  exco?: Record<string, unknown>;
  leagues?: string[];
  coaches?: unknown[];
  ground?: Record<string, unknown>;
}): boolean {
  const exco = club.exco ?? {};
  const named = (role: string): boolean => {
    const m = exco[role] as { name?: unknown } | undefined;
    return typeof m?.name === 'string' && m.name.trim() !== '';
  };
  // A non-chair officer (sec/tre/vc) only ever comes from the affiliation form.
  if (named('sec') || named('tre') || named('vc')) return true;
  // Additional committee members are form-only too.
  const additional = exco.additionalMembers;
  if (Array.isArray(additional) && additional.some((m) => (m as { name?: unknown })?.name)) {
    return true;
  }
  // The chair seed carries only name/email/cell; these governance fields are form-only.
  const chair = (exco.chair ?? {}) as Record<string, unknown>;
  const FORM_ONLY_CHAIR = [
    'idNumber',
    'gender',
    'race',
    'termStart',
    'termEnd',
    'reasonForInvolvement',
  ];
  if (FORM_ONLY_CHAIR.some((k) => chair[k] != null && String(chair[k]).trim() !== '')) return true;
  // League selection, coaches, or a populated ground are all affiliation-form output.
  if (Array.isArray(club.leagues) && club.leagues.length > 0) return true;
  if (Array.isArray(club.coaches) && club.coaches.length > 0) return true;
  const ground = club.ground ?? {};
  if (Object.values(ground).some((v) => v != null && String(v).trim() !== '')) return true;
  return false;
}
