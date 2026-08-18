/**
 * Server-side copy of the shared cricket catalogue defaults, used to validate
 * affiliation input. Districts, leagues and compliance-doc catalogues are per-tenant
 * config (operator-managed); the constants here are the read-time fallback for legacy
 * tenant rows without an explicit field (ADR 0005 froze doc keys; ADR 0009 unfroze
 * them into TenantConfig.requiredDocs).
 */
import type { DocFormat, RequiredDoc } from './types.js';

/**
 * Fallback district list for tenants with no `districts` field on their config row
 * (pre-whitelabel tenants; no backfill — see resolveDistricts). Keep in sync with
 * DISTRICTS in the frontend's src/data.ts: drift would make a legacy tenant's first
 * operator save silently drop a default the operator never saw rendered.
 */
export const DEFAULT_DISTRICTS: string[] = [
  'Ethekwini Metro Cricket Union',
  'Umkhanyakude Cricket District',
  'Ugu Cricket District',
  'KCCD',
  'Illembe Cricket District',
];

/**
 * Server mirror of OVERARCHING_DISTRICT in the frontend's src/leagues.ts — the
 * sentinel a league uses to appear in every district's picker. Never a valid
 * tenant district (validateDistricts reserves it) but always a valid league.district.
 */
export const OVERARCHING_DISTRICT = 'All districts';

/**
 * The tenant's effective district list: the explicit config value when present
 * (including a deliberate [] on a freshly created client, which blocks club signup
 * until the operator configures districts), else the shared defaults.
 */
export function resolveDistricts(cfg?: { districts?: string[] } | null): string[] {
  return cfg?.districts ?? DEFAULT_DISTRICTS;
}

/**
 * The shared default compliance-doc catalogue — today's six keys expressed
 * declaratively (mirror of DEFAULT_REQUIRED_DOCS in the frontend's data.ts). This is
 * the read-time fallback for tenants without an explicit `requiredDocs` config field,
 * and it is behavior-identical to the pre-ADR-0009 hardcoded set: same keys, same
 * escape hatches, same accepted types. Keep the two mirrors in sync.
 */
export const DEFAULT_REQUIRED_DOCS: RequiredDoc[] = [
  {
    key: 'constitution',
    name: 'Club constitution',
    desc: 'Your club’s adopted constitution',
  },
  {
    key: 'agm',
    name: 'AGM minutes',
    desc: 'Minutes of your most recent Annual General Meeting',
    allowMeetingBooked: true,
  },
  {
    key: 'financials',
    name: 'Annual financial statements',
    desc: 'Most recent annual financial statements',
    allowUnavailable: true,
  },
  {
    key: 'exco',
    name: 'Executive committee',
    desc: 'Captured on the affiliation form',
    kind: 'form',
  },
  {
    key: 'codeOfConduct',
    name: 'Code of conduct',
    desc: 'Your club’s signed code of conduct',
  },
  {
    key: 'safeguarding',
    name: 'Safeguarding certificates',
    desc: 'Safeguarding certificates for at least two club officials',
    multiFile: true,
    minFiles: 2,
    maxFiles: 10,
    allowCourseBooked: true,
  },
];

/**
 * The tenant's effective compliance-doc catalogue: the explicit config value when
 * present (including a deliberate [] meaning "no compliance docs"), else the shared
 * defaults. Same contract as resolveDistricts — legacy rows need no backfill.
 */
export function resolveRequiredDocs(cfg?: { requiredDocs?: RequiredDoc[] } | null): RequiredDoc[] {
  return cfg?.requiredDocs ?? DEFAULT_REQUIRED_DOCS;
}

/** The catalogue minus archived entries — what completion counts and upload flows see. */
export function activeRequiredDocs(cfg?: { requiredDocs?: RequiredDoc[] } | null): RequiredDoc[] {
  return resolveRequiredDocs(cfg).filter((d) => !d.archived);
}

/**
 * The key of the ACTIVE doc marked with this role, or null when no doc carries it
 * (an unassigned role — the self-serve wizards 409 with role-assignment guidance
 * rather than falling back to a literal key). Archived docs never resolve — the
 * role is retired along with the key.
 */
export function docKeyForRole(
  requiredDocs: RequiredDoc[],
  role: NonNullable<RequiredDoc['role']>,
): string | null {
  return requiredDocs.find((d) => !d.archived && d.role === role)?.key ?? null;
}

/**
 * Every uploadable format → its exact MIME type (mirror of DOC_FORMAT_MIME in the
 * frontend's data.ts). Word covers Google Docs (exports .docx/.pdf); the spreadsheet
 * trio exists for catalogues whose docs are filled-in workbooks (league entry forms,
 * asset registers). The presigned PUT is minted with exactly one of these, so S3
 * rejects anything else at upload time.
 */
export const DOC_FORMAT_MIME: Record<DocFormat, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
};

/** The legacy accepted-format set — the default when a doc declares no `accepts`. */
export const DEFAULT_DOC_FORMATS: DocFormat[] = ['pdf', 'doc', 'docx'];

/**
 * Accepted content types for one doc definition, as mime → stored-extension. Pass
 * undefined (an unknown/retired key) to get the full format map — those keys were
 * valid under some earlier catalogue, so their stored files keep resolving.
 */
export function acceptedMimes(doc?: RequiredDoc): Record<string, string> {
  const formats = doc
    ? (doc.accepts ?? DEFAULT_DOC_FORMATS)
    : (Object.keys(DOC_FORMAT_MIME) as DocFormat[]);
  return Object.fromEntries(formats.map((f) => [DOC_FORMAT_MIME[f], f]));
}

/**
 * @deprecated ADR 0009 — kept only for pre-catalogue scripts/tests. Route code uses
 * resolveRequiredDocs(cfg); this frozen set no longer gates anything.
 */
export const DOC_KEYS = new Set(DEFAULT_REQUIRED_DOCS.map((d) => d.key));

/** @deprecated ADR 0009 — use acceptedMimes(doc). The legacy pdf/doc/docx map. */
export const DOC_CONTENT_TYPES: Record<string, string> = Object.fromEntries(
  DEFAULT_DOC_FORMATS.map((f) => [DOC_FORMAT_MIME[f], f]),
);

/**
 * Legacy safeguarding thresholds — now the per-doc defaults for any multiFile doc
 * that doesn't declare its own minFiles/maxFiles (mirror of the frontend's data.ts).
 */
export const MIN_SAFEGUARDING_FILES = 2;
/** Upper bound on stored files per multiFile doc — a runaway-append backstop. */
export const MAX_SAFEGUARDING_FILES = 10;
/** Absolute per-key stored-file ceiling: no catalogue may raise maxFiles beyond this. */
export const MAX_DOC_FILES_HARD_CAP = 20;

/**
 * Effective thresholds for a (possibly retired) multiFile doc.
 *
 * The `min` default is 1, matching what `validateRequiredDocs` accepts for a bare
 * `{ multiFile: true }` — the two used to disagree (validator 1, runtime 2), so such a
 * doc would validate and display as needing one file while the write path silently
 * demanded two. "Multi-file" means "more than one is allowed", not "more than one is
 * required"; a doc that genuinely needs two says so, as safeguarding does in
 * DEFAULT_REQUIRED_DOCS. The old 2 only ever applied to a doc with no explicit minFiles,
 * which for the shared defaults never happens.
 */
export function multiFileLimits(doc?: RequiredDoc): { min: number; max: number } {
  return {
    min: doc?.minFiles ?? 1,
    max: doc?.maxFiles ?? MAX_SAFEGUARDING_FILES,
  };
}

/** One stored compliance-document file (a multi-file doc holds an array of these). */
export interface DocFileEntry {
  objectKey: string;
  size: number;
  contentType?: string;
  uploadedAt: string;
  /** Operator email that committed this file (bulk-intake audit trail only). */
  uploadedBy?: string;
  /** Original filename as picked by the operator (bulk-intake audit trail only). */
  sourceName?: string;
}

/** docMeta normalized to one shape, whatever historical form it was stored in. */
export interface NormalizedDocMeta {
  files: DocFileEntry[];
  markedCompliant: boolean;
  courseBooked: boolean;
  courseDate: string;
  at?: string;
}

/**
 * Normalize every historical docMeta shape to `{ files, markedCompliant, courseBooked,
 * courseDate, at }`: the `{ files: [...] }` wrapper as-is, a legacy single upload
 * `{ objectKey }` as a one-entry array, and a bare `{ markedCompliant }` sentinel as an
 * empty array with the flag set. Mirror of `safeguardingMeta` in the frontend's data.ts.
 *
 * Lives here, not in index.ts, because the import CLIs write docMeta through `repo` and
 * so cannot import the routes — they previously carried a hand-copied replica of this
 * function, and a drift between the two would silently corrupt stored compliance records
 * on a production write. Same reasoning as club-id.ts and player-identity.ts.
 */
export function normalizeDocMeta(meta: unknown): NormalizedDocMeta {
  const m = (meta ?? {}) as Record<string, unknown>;
  const courseBooked = !!m.courseBooked;
  const courseDate = (m.courseDate as string | undefined) || '';
  if (Array.isArray(m.files)) {
    return {
      files: m.files as DocFileEntry[],
      markedCompliant: !!m.markedCompliant,
      courseBooked,
      courseDate,
      at: m.at as string | undefined,
    };
  }
  if (m.objectKey) {
    return {
      files: [m as unknown as DocFileEntry],
      markedCompliant: !!m.markedCompliant,
      courseBooked,
      courseDate,
    };
  }
  return {
    files: [],
    markedCompliant: !!m.markedCompliant,
    courseBooked,
    courseDate,
    at: m.at as string | undefined,
  };
}

/**
 * Re-wrap normalized state as the stored docMeta value. `extra` carries the club-set
 * "course booked" flag + date so a generic merge or an append/delete recompute can't
 * strip it; both ride through only when truthy (the canonical course-booked shape is
 * `{ files, courseBooked: true, courseDate, at }`).
 */
export function docMetaValue(
  files: DocFileEntry[],
  markedCompliant: boolean,
  at?: string,
  extra?: { courseBooked?: boolean; courseDate?: string },
): Record<string, unknown> {
  const value: Record<string, unknown> = markedCompliant
    ? { files, markedCompliant: true, at }
    : { files };
  if (extra?.courseBooked) value.courseBooked = true;
  if (extra?.courseDate) value.courseDate = extra.courseDate;
  return value;
}

/** Accepted coach-experience buckets (mirror of COACH_EXPERIENCE in the frontend's data.jsx). */
export const COACH_EXPERIENCE = new Set(['0-3', '4-10', '10+']);

/**
 * Accepted chairperson "why are you involved in club cricket?" answers. Now captured on the
 * CQI form as a multi-select stored at `cqiAnswers.involvementReasons: string[]` (validated in
 * validateClubPatch). The legacy single-value `exco.chair.reasonForInvolvement` is still
 * accepted for back-compat with clubs that submitted before the move. Mirror of
 * INVOLVEMENT_REASONS in the frontend's data.ts. Validated only when present — the field is
 * optional/informational and never scored, so the server must never make it mandatory.
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
 * cleanup script, but can never introduce one. Districts follow it too:
 * the tenant's resolved list plus the club's current district, so a club with
 * a since-removed district can still be saved without changing it.
 *
 * exco/coaches bodies were previously unchecked, so the affiliation form's new
 * governance fields (chair ID/term, coach ID/experience) are validated here —
 * this is the only server gate that sees them.
 */
// CQI answers hold ~44 keys today (36 questions + 7 governance + involvementReasons);
// the cap leaves headroom for legacy orphan keys without letting the object grow unbounded.
const CQI_ANSWERS_MAX_KEYS = 60;
// Answer values are short (counts, ratings, money amounts, choice labels). Without a
// bound, an oversized string would only fail at DynamoDB's item limit as a raw 500.
const CQI_ANSWER_MAX_LEN = 200;

export function validateClubPatch(
  patch: {
    name?: string;
    district?: string;
    leagues?: string[];
    leagueTeams?: Record<string, number>;
    teamRosters?: Record<string, { id?: unknown; name?: unknown }[]>;
    docs?: Record<string, unknown>;
    docMeta?: Record<string, unknown>;
    cqi?: unknown;
    cqiAnswers?: Record<string, unknown> | null;
    exco?: Record<string, unknown>;
    coaches?: unknown[];
  },
  validLeagueKeys: Set<string>,
  validDocKeys: Set<string>,
  validDistricts: Set<string>,
  /**
   * The tenant's resolved doc catalogue, for escape-hatch enforcement. Optional so the
   * seed/import CLIs that call this without a tenant config keep working — omitting it
   * only skips the sentinel check, never loosens the doc-key allowlist above.
   */
  docDefs?: RequiredDoc[],
  /** The club's stored docMeta, so an already-present sentinel is never newly rejected. */
  currentDocMeta?: Record<string, unknown>,
): string | null {
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (!n) return 'club name cannot be empty';
    if (n.length > 80) return 'club name must be 80 characters or fewer';
  }
  if (patch.district && !validDistricts.has(patch.district)) {
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
  // Named team rosters — present only for leagues a club fields >1 side in. Each id
  // must carry the reserved `tm_` prefix (so the teamId namespace stays disjoint from
  // clubId slugs) and be unique across all rosters; names are 1–80 chars. Keys, like
  // leagueTeams, must be among the leagues entered (no orphans persisting via the PUT).
  const allTeamIds = new Set<string>();
  if (patch.teamRosters) {
    for (const [k, roster] of Object.entries(patch.teamRosters)) {
      if (patch.leagues && !patch.leagues.includes(k)) {
        return 'teamRosters has keys not in leagues';
      }
      if (!Array.isArray(roster)) return 'teamRosters values must be arrays';
      // When the count is in the same patch, the roster must describe exactly that
      // many sides — a roster is only meaningful for a ≥2-side league, and a count/
      // roster-length mismatch would desync the named teams from the fixture pool.
      const count = patch.leagueTeams?.[k];
      if (typeof count === 'number') {
        if (count < 2) return 'teamRosters present for a league with fewer than 2 teams';
        if (roster.length !== count) return 'teamRosters length must match the team count';
      }
      for (const t of roster) {
        const id = typeof t?.id === 'string' ? t.id : '';
        if (!id || !id.startsWith('tm_')) return 'team id must be a non-empty tm_ id';
        if (allTeamIds.has(id)) return 'duplicate team id';
        allTeamIds.add(id);
        const name = typeof t?.name === 'string' ? t.name.trim() : '';
        if (!name) return 'team name cannot be empty';
        if (name.length > 80) return 'team name must be 80 characters or fewer';
      }
    }
  }
  const docKeys = [...Object.keys(patch.docs ?? {}), ...Object.keys(patch.docMeta ?? {})];
  const badDocs = [...new Set(docKeys.filter((k) => !validDocKeys.has(k)))];
  if (badDocs.length) return `unknown document keys: ${badDocs.join(', ')}`;
  // Hard per-key file ceiling. Per-doc maxFiles is enforced on the append routes; this
  // generic patch is the only other channel that can write a files[] array, and without
  // a bound a hostile PATCH could balloon docMeta toward the DynamoDB 400KB item limit.
  for (const [k, v] of Object.entries(patch.docMeta ?? {})) {
    const files = (v as { files?: unknown } | null)?.files;
    if (Array.isArray(files) && files.length > MAX_DOC_FILES_HARD_CAP) {
      return `no more than ${MAX_DOC_FILES_HARD_CAP} stored files for document "${k}"`;
    }
  }
  // Escape-hatch enforcement (ADR 0009). The three "we can't supply this" sentinels are
  // affordances the catalogue GRANTS per doc; without a server check they were UI-only,
  // so a rep or a stale tab could PATCH `{ unavailable: true }` onto a doc the operator
  // deliberately made unskippable and have it count complete.
  //
  // Only a sentinel this patch INTRODUCES is rejected: one already on the stored record
  // rides through untouched. Otherwise removing a flag from the catalogue would brick
  // every later save for clubs that had legitimately used it (every client spreads the
  // existing docMeta), stranding them with an unsaveable record. Cleaning up a stale
  // sentinel is the admin revert path's job, not this validator's.
  // Docs with no catalogue entry (retired, stored-only) are skipped — history can't be
  // retro-tightened, matching the doc-key union rule above.
  if (docDefs) {
    const SENTINELS: Array<{ field: string; flag: keyof RequiredDoc; label: string }> = [
      { field: 'unavailable', flag: 'allowUnavailable', label: 'marked unavailable' },
      {
        field: 'meetingBooked',
        flag: 'allowMeetingBooked',
        label: 'satisfied by a booked meeting',
      },
      { field: 'courseBooked', flag: 'allowCourseBooked', label: 'satisfied by a booked course' },
    ];
    for (const [k, v] of Object.entries(patch.docMeta ?? {})) {
      const def = docDefs.find((d) => d.key === k);
      if (!def) continue;
      const incoming = (v ?? {}) as Record<string, unknown>;
      const stored = (currentDocMeta?.[k] ?? {}) as Record<string, unknown>;
      for (const { field, flag, label } of SENTINELS) {
        if (incoming[field] && !stored[field] && !def[flag]) {
          return `"${def.name}" cannot be ${label}`;
        }
      }
    }
  }

  // CQI score + answers — shape checks only. The score is computed client-side (scoreCQI)
  // and provably capped at 100, so the server just bounds it. Answers stay loose on
  // purpose: values legitimately arrive as mixed boolean/number/string (the scorer
  // parseFloats), legacy clubs carry orphan keys, and both the rep and the admin submit
  // through this same route — a per-question kind mirror would buy little and break
  // corrective saves of exactly the malformed forms admins need to fix. An explicit null
  // (for either the object or a value) is treated as absent, matching stored legacy data.
  if (patch.cqi !== undefined) {
    if (typeof patch.cqi !== 'number' || !Number.isFinite(patch.cqi)) {
      return 'cqi must be a number';
    }
    if (patch.cqi < 0 || patch.cqi > 100) return 'cqi must be between 0 and 100';
  }
  if (patch.cqiAnswers != null) {
    if (typeof patch.cqiAnswers !== 'object' || Array.isArray(patch.cqiAnswers)) {
      return 'cqiAnswers must be an object';
    }
    const entries = Object.entries(patch.cqiAnswers);
    if (entries.length > CQI_ANSWERS_MAX_KEYS) return 'cqiAnswers has too many keys';
    for (const [k, v] of entries) {
      if (k === 'involvementReasons') continue; // validated below
      if (v != null && !['boolean', 'number', 'string'].includes(typeof v)) {
        return 'cqiAnswers values must be booleans, numbers or strings';
      }
      if (typeof v === 'string' && v.length > CQI_ANSWER_MAX_LEN) {
        return `cqiAnswers values must be ${CQI_ANSWER_MAX_LEN} characters or fewer`;
      }
    }
  }

  // Chairperson "why involved in club cricket" — informational, non-scoring, captured on the
  // CQI form as cqiAnswers.involvementReasons (multi-select). Validated ONLY when the key is
  // present so governance-only and draft submits still pass; an empty array is allowed (the
  // field is optional). Each entry must be a known reason.
  const involvementReasons = (patch.cqiAnswers as Record<string, unknown> | undefined)
    ?.involvementReasons;
  if (involvementReasons !== undefined) {
    if (
      !Array.isArray(involvementReasons) ||
      involvementReasons.some((r) => !INVOLVEMENT_REASONS.has(String(r)))
    ) {
      return 'invalid involvementReasons';
    }
  }

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
      // Per-team assignment: every referenced id must be a real roster team. Checked
      // only when the patch carries teamRosters (so a draft that omits rosters but
      // keeps coaches still passes); absent teamIds ⇒ covers all the club's sides.
      if (patch.teamRosters && Array.isArray(c.teamIds)) {
        const bad = (c.teamIds as unknown[]).find((id) => !allTeamIds.has(String(id)));
        if (bad !== undefined) return `coach assigned to unknown team: ${String(bad)}`;
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
