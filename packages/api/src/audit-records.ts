/**
 * Audit trail, Phase 3 — field-level old → new values for team & access, tenant settings,
 * clubs and club documents (ADR 0023; contract: docs/api/audit.md). Pure: no Hono, no
 * DynamoDB. Each record type diffs an explicit, flattened projection through
 * {@link diffFields}, so nothing outside the listed fields is ever compared or stored.
 *
 * Masking (recorded as changed, no value) on top of {@link isMaskedField}:
 *   - credentials: any leaf named like a token / secret / password / API key / webhook, or a
 *     value (an object) holding a key so named at any depth — key names, not value text;
 *   - clubs: free text (`notes`, `cqiAnswers`), coaches (ID numbers), every ground field off
 *     the allow-list (addresses), the player-registration link, the chair and every committee
 *     field but the term dates (committee members have no record an erasure could find them
 *     by), every document field other than its status, dates, size and type (object keys, file
 *     names and uploader details are masked), and any field whose value is an object or a list
 *     holding one; named sides are recorded by their names only;
 *   - tenant config: the scorecard-correction recipient list (people's emails).
 *
 * Second group (players, clearances, series / fixtures, competitions, season runs, venues):
 *   - players: ID / passport number, date of birth, minor flag, nationality, gender, race,
 *     contacts, guardian, postal address, the free-text previous club and transfer note, and
 *     ID-document metadata (object keys);
 *   - clearances, veterans requests: the free-text note and reject / override / decline
 *     reasons;
 *   - registration reviews: the previous club the player typed (free text) or named (no id);
 *   - competitions: a team with no club behind it;
 *   - venues: the address, the note, and each unavailable window's reason (only its dates are
 *     kept).
 *
 * Third group (postponements, captain's reports, squads, team captains):
 *   - postponements: the request reason, each proposal's note and the decline reason;
 *   - captain's reports: the captain's name, the general comments, the scorecard feedback,
 *     each umpire's "other concern" and comments, a free-text umpire's name (no registry
 *     record to scrub it by) and the recipient's contact;
 *   - squads: guest names (counted only) and the recipient's contact.
 * Players, registry umpires and clubs named by value (a selected player, a captain, a rated
 * umpire, a club, a fixture's home / away side, a competition team) always carry a `ref`; a
 * `<home> v <away>` label carries the club behind each side (`clubIds`, see matchLabel).
 * Organisation contacts in tenant settings are values.
 */
import { diffFields, isMaskedField, stable } from './audit.js';
import type {
  AuditChange,
  AuditRef,
  CaptainsReport,
  Club,
  Membership,
  PlayerClearance,
  PlayerRegistration,
  PostponementRequest,
  RegistrationReview,
  SeasonRun,
  Series,
  SquadRequest,
  TenantConfig,
  Venue,
  VeteransRequest,
} from './types.js';

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Leaf names whose value is a credential. */
const SECRET_RE = /(token|secret|password|api[-_]?key|webhook)/i;

/** True when `v` holds a credential-named key at any depth. */
function hasSecret(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  return Object.entries(v).some(([k, x]) => SECRET_RE.test(k) || hasSecret(x));
}

const leafOf = (field: string) => field.slice(field.lastIndexOf('.') + 1);

// ── Team & access ──

/**
 * A membership's role and club scope, before → after (`undefined` ⇒ none: an invite or a
 * removal). Each club added or removed is its own `clubIds` change carrying a `ref` to the
 * club, so the change sits in that club's history and a club deletion strips its name.
 */
export function membershipChanges(
  before: Pick<Membership, 'role' | 'clubIds'> | undefined,
  after: Pick<Membership, 'role' | 'clubIds'> | undefined,
  clubName: (id: string) => string,
): AuditChange[] {
  const changes = diffFields(
    before ? { role: before.role } : null,
    after ? { role: after.role } : null,
    { fields: ['role'] },
  );
  const was = before?.clubIds ?? [];
  const now = after?.clubIds ?? [];
  for (const id of was)
    if (!now.includes(id))
      changes.push({ field: 'clubIds', from: clubName(id), ref: { type: 'club', id } });
  for (const id of now)
    if (!was.includes(id))
      changes.push({ field: 'clubIds', to: clubName(id), ref: { type: 'club', id } });
  return changes;
}

// ── Clubs ──

/**
 * Top-level club fields diffed with values (`leagueTeams` and `teamRosters` are projected per
 * league by {@link clubAuditView}).
 */
const CLUB_FIELDS = [
  'name',
  'district',
  'sub',
  'affiliation',
  'cqi',
  'teams',
  'women',
  'juniors',
  'color',
  'leagues',
  'remindersOptIn',
  'amendmentPending',
  'nameChangePending',
  'previousName',
] as const;

/**
 * Top-level club fields recorded as changed without a value. `chair` is the chair's name (a
 * copy of `exco.chair.name`): committee members are people with no record an erasure could
 * find them by, so their details are never stored.
 */
const CLUB_MASKED = ['chair', 'cqiAnswers', 'coaches', 'notes', 'playerRegLink'] as const;

/**
 * Committee fields stored with values (`exco.<role>.<field>`): the term dates only. Names,
 * contacts and every other committee field are masked — the entry says which office changed,
 * never who holds it (removing an office bearer is how a departed member is erased).
 */
const EXCO_VALUE_FIELDS: ReadonlySet<string> = new Set(['termStart', 'termEnd']);

/** Ground fields stored with values (`ground.<field>`); any other one (addresses) is masked. */
const GROUND_VALUE_FIELDS: ReadonlySet<string> = new Set([
  'venue',
  'secondaryVenue',
  'suburb',
  'lat',
  'lon',
  'pitchCount',
]);

/** Document fields stored with values (`docMeta.<key>.<field>`); every other one is masked. */
const DOC_VALUE_FIELDS: ReadonlySet<string> = new Set([
  'fileCount',
  'size',
  'contentType',
  'uploadedAt',
  'uploadedByRole',
  'markedCompliant',
  'at',
  'courseBooked',
  'courseDate',
  'meetingBooked',
  'meetingDate',
  'unavailable',
  'expiry',
  'expiresAt',
  'expiryDate',
]);

/**
 * The club as audit fields: the top-level fields, `leagueTeams.<league>` (the count),
 * `teamRosters.<league>` (the named sides' NAMES only — a side's own venue, address and pin
 * are never read), `ground.<field>`, `exco.<role>.<field>`, `docs.<key>` (the satisfied flag)
 * and `docMeta.<key>.<field>` (a multi-file doc adds `fileCount` and a masked `files`). A deep
 * copy, so a later in-place edit of `club` cannot change a captured "before".
 */
export function clubAuditView(club: Partial<Club> | null | undefined): Record<string, unknown> {
  if (!club) return {};
  const c = structuredClone(club) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of [...CLUB_FIELDS, ...CLUB_MASKED]) if (c[f] !== undefined) out[f] = c[f];
  if (isObj(c.leagueTeams))
    for (const [k, v] of Object.entries(c.leagueTeams)) out[`leagueTeams.${k}`] = v;
  if (isObj(c.teamRosters))
    for (const [k, list] of Object.entries(c.teamRosters))
      out[`teamRosters.${k}`] = (Array.isArray(list) ? list : []).map((t) =>
        isObj(t) && typeof t.name === 'string' ? t.name : null,
      );
  if (isObj(c.ground)) for (const [k, v] of Object.entries(c.ground)) out[`ground.${k}`] = v;
  if (isObj(c.exco))
    for (const [role, m] of Object.entries(c.exco)) {
      if (isObj(m)) for (const [k, v] of Object.entries(m)) out[`exco.${role}.${k}`] = v;
      else out[`exco.${role}`] = m;
    }
  if (isObj(c.docs)) for (const [k, v] of Object.entries(c.docs)) out[`docs.${k}`] = v;
  if (isObj(c.docMeta))
    for (const [key, m] of Object.entries(c.docMeta)) {
      if (!isObj(m)) {
        out[`docMeta.${key}`] = m;
        continue;
      }
      for (const [k, v] of Object.entries(m)) {
        if (k === 'files' && Array.isArray(v)) out[`docMeta.${key}.fileCount`] = v.length;
        out[`docMeta.${key}.${k}`] = v;
      }
    }
  return out;
}

/** Whether a {@link clubAuditView} field is recorded without its value. */
export function clubFieldMasked(field: string): boolean {
  const parts = field.split('.');
  const leaf = parts[parts.length - 1];
  if ((CLUB_MASKED as readonly string[]).includes(parts[0])) return true;
  if (parts[0] === 'exco') return parts.length < 3 || !EXCO_VALUE_FIELDS.has(leaf);
  if (parts[0] === 'docMeta') return parts.length < 3 || !DOC_VALUE_FIELDS.has(leaf);
  if (parts[0] === 'ground') return parts.length !== 2 || !GROUND_VALUE_FIELDS.has(leaf);
  return isMaskedField(leaf) || SECRET_RE.test(leaf);
}

/**
 * A value that could hide a nested field nobody vetted: an object, or a list holding one. A
 * club field whose value is structured is masked whatever its name (every vetted field is a
 * scalar or a list of scalars once projected by {@link clubAuditView}).
 */
const isStructured = (v: unknown): boolean =>
  !!v &&
  typeof v === 'object' &&
  (!Array.isArray(v) || v.some((x) => !!x && typeof x === 'object'));

/** "Nothing" on a create: an unset counter, flag, string or list adds no information. */
const isEmptyValue = (v: unknown) =>
  v === undefined ||
  v === null ||
  v === false ||
  v === 0 ||
  v === '' ||
  (Array.isArray(v) && v.length === 0);

/**
 * Field changes between two versions of a club (`before` null ⇒ create: unset fields are
 * left out). Capture `before` with {@link clubAuditView} right after the read when the
 * handler might edit the record in place.
 */
export function clubChanges(
  before: Partial<Club> | Record<string, unknown> | null | undefined,
  after: Partial<Club> | null | undefined,
  opts: { beforeView?: Record<string, unknown> } = {},
): AuditChange[] {
  const b = opts.beforeView ?? clubAuditView(before as Partial<Club> | null);
  const a = clubAuditView(after);
  const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const mask = fields.filter((f) => clubFieldMasked(f) || isStructured(a[f]) || isStructured(b[f]));
  const changes = diffFields(b, a, { fields, mask });
  if (before || opts.beforeView) return changes;
  return changes.filter((c) => c.masked || !isEmptyValue(c.to));
}

// ── Tenant settings ──

/** What a tenant admin can write through PUT /tenant/config (the rest is stripped there). */
export const TENANT_CONFIG_ADMIN_FIELDS = [
  'branding',
  'submissionDeadline',
  'leagues',
  'competitionDefaults',
] as const;

/** What the operator portal (PUT /platform/tenants/:slug) can write. */
export const TENANT_CONFIG_OPERATOR_FIELDS = [
  ...TENANT_CONFIG_ADMIN_FIELDS,
  'sport',
  'seasonLabel',
  'districts',
  'knownClubs',
  'calendars',
  'structures',
  'requiredDocs',
  'tutorials',
  'tutorialsNoFallback',
  'features',
  'transferWindows',
  'fixtureReminders',
  'captainsReportsExcludedSeriesPrefixes',
  'officialsContactLine',
  'scorecardCorrectionRecipients',
  'orgContact',
  'clearanceCertTemplate',
  'integrations',
] as const;

/** Config fields recorded without values (a list of people's email addresses). */
const CONFIG_MASKED: ReadonlySet<string> = new Set(['scorecardCorrectionRecipients']);

/** A list item as people name it (a league's label, a document's name, …). */
const itemName = (x: unknown): unknown => {
  if (!isObj(x)) return x;
  for (const k of ['label', 'name', 'title', 'key', 'id'])
    if (typeof x[k] === 'string' && x[k]) return x[k];
  return x;
};

/**
 * A changed list, within the caps: the items removed (`from`) and added (`to`), whole (each
 * capped as text). A pure reorder lists every item's name, before and after. A short list of
 * plain values (≤ 20) is kept whole.
 */
function summariseList(from: unknown[], to: unknown[]): [unknown[], unknown[]] {
  const plain = (xs: unknown[]) => xs.every((x) => x === null || typeof x !== 'object');
  if (plain(from) && plain(to) && from.length <= 20 && to.length <= 20) return [from, to];
  const fk = new Set(from.map(stable));
  const tk = new Set(to.map(stable));
  const removed = from.filter((x) => !tk.has(stable(x)));
  const added = to.filter((x) => !fk.has(stable(x)));
  if (!removed.length && !added.length) return [from.map(itemName), to.map(itemName)];
  return [removed, added];
}

/**
 * Config `fields` as audit fields: a nested object one level deep becomes dotted fields
 * (`branding.name`, `integrations.medicoach`), deeper values stay whole (stored as capped
 * text).
 */
function configView(
  cfg: Partial<TenantConfig> | null | undefined,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const c = (cfg ?? {}) as Record<string, unknown>;
  for (const f of fields) {
    const v = c[f];
    if (isObj(v)) for (const [k, x] of Object.entries(v)) out[`${f}.${k}`] = x;
    else if (v !== undefined) out[f] = v;
  }
  return out;
}

/**
 * Field changes between two versions of a tenant config, over `fields` only (pass
 * {@link TENANT_CONFIG_ADMIN_FIELDS} for an entry tenant admins can read). Lists are
 * summarised by {@link summariseList}; credentials and recipient lists are masked.
 */
export function tenantConfigChanges(
  before: Partial<TenantConfig> | null | undefined,
  after: Partial<TenantConfig> | null | undefined,
  fields: readonly string[],
): AuditChange[] {
  const b = configView(before, fields);
  const a = configView(after, fields);
  const names = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort(
    (x, y) => fields.indexOf(x.split('.')[0]) - fields.indexOf(y.split('.')[0]) || (x < y ? -1 : 1),
  );
  const mask: string[] = [];
  for (const n of names) {
    const leaf = leafOf(n);
    if (
      CONFIG_MASKED.has(n.split('.')[0]) ||
      SECRET_RE.test(leaf) ||
      isMaskedField(leaf) ||
      hasSecret(b[n]) ||
      hasSecret(a[n])
    )
      mask.push(n);
    else if ((Array.isArray(b[n]) || Array.isArray(a[n])) && stable(b[n]) !== stable(a[n])) {
      const [from, to] = summariseList(
        Array.isArray(b[n]) ? (b[n] as unknown[]) : [],
        Array.isArray(a[n]) ? (a[n] as unknown[]) : [],
      );
      if (b[n] !== undefined) b[n] = from;
      if (a[n] !== undefined) a[n] = to;
    }
  }
  return diffFields(b, a, { fields: names, mask });
}

// ── Shared (second group) ──

/**
 * A `refs` resolver for a field whose VALUE is a display name: each side's name maps to the id
 * it was stored with, so the change carries a `ref` (and `fromRef`) to that record.
 */
function nameRef(type: string, pairs: ReadonlyArray<[unknown, unknown]>) {
  const ids = new Map<unknown, string>();
  for (const [name, id] of pairs)
    if (name !== undefined && name !== null && typeof id === 'string' && id) ids.set(name, id);
  return (v: unknown): AuditRef | undefined => {
    const id = ids.get(v);
    return id ? { type, id } : undefined;
  };
}

/** `fields` of `rec` that are set, deep-copied (a later in-place edit cannot change them). */
function pick(
  rec: Record<string, unknown> | null | undefined,
  fields: readonly string[],
): Record<string, unknown> | null {
  if (!rec) return null;
  const out: Record<string, unknown> = {};
  for (const f of fields) if (rec[f] !== undefined) out[f] = rec[f];
  return structuredClone(out);
}

/** A create (`before` absent) leaves unset values out; masked fields that are set stay. */
const createOnly = (changes: AuditChange[], isCreate: boolean) =>
  isCreate ? changes.filter((c) => c.masked || !isEmptyValue(c.to)) : changes;

// ── Players ──

/** Player fields stored with values: names, team / role, status, club, veterans club. */
const PLAYER_VALUE_FIELDS = [
  'firstName',
  'lastName',
  'status',
  'clubId',
  'team',
  'position',
  'battingHand',
  'bowlingHand',
  'battingType',
  'bowlerType',
  'isAllRounder',
  'isWk',
  'registeredVia',
  'veteransClub',
] as const;

/** Player fields recorded as changed without a value (identity, contacts, documents, free text). */
const PLAYER_MASKED_FIELDS = [
  'idNumber',
  'passportNumber',
  'dob',
  'isMinor',
  'nationality',
  'gender',
  'race',
  'cell',
  'email',
  'guardianName',
  'postalAddress',
  'postalCode',
  'lastClub',
  'transferNote',
  'clearanceRejectedReason',
  'idDocMeta',
  'previousIdDocMeta',
] as const;

/** A player's audit label: their name. */
export const playerLabel = (p: Partial<PlayerRegistration> | null | undefined): string =>
  [p?.firstName, p?.lastName]
    .filter((x) => typeof x === 'string' && x.trim())
    .join(' ')
    .trim();

/**
 * Field changes between two versions of a player row (`before` null ⇒ a registration: unset
 * fields are left out; `after` null ⇒ a removal: what the row held). `clubId` carries a `ref`
 * to the club, `veteransClub` (the name) a `ref` to the veterans club.
 */
export function playerChanges(
  before: Partial<PlayerRegistration> | null | undefined,
  after: Partial<PlayerRegistration> | null | undefined,
): AuditChange[] {
  const fields = [...PLAYER_VALUE_FIELDS, ...PLAYER_MASKED_FIELDS];
  const b = pick(before as Record<string, unknown> | null, fields);
  const a = pick(after as Record<string, unknown> | null, fields);
  const changes = diffFields(b, a, {
    fields,
    mask: PLAYER_MASKED_FIELDS,
    refs: {
      clubId: 'club',
      veteransClub: nameRef('club', [
        [before?.veteransClub, before?.veteransClubId],
        [after?.veteransClub, after?.veteransClubId],
      ]),
    },
  });
  return createOnly(changes, !before);
}

// ── Clearances, veterans requests, registration reviews ──

const CLEARANCE_VALUE_FIELDS = [
  'status',
  'fromClub',
  'toClub',
  'team',
  'origin',
  'feesCleared',
  'misconductCleared',
  'rejectOutcome',
  'certificateDeclined',
  'certificate',
] as const;
const CLEARANCE_MASKED_FIELDS = ['note', 'rejectReason', 'overrideReason'] as const;

function clearanceView(c: Partial<PlayerClearance> | null | undefined) {
  if (!c) return null;
  return pick(
    {
      ...(c as Record<string, unknown>),
      fromClub: c.fromClubName,
      toClub: c.toClubName,
      certificate: c.certificateMeta?.serial,
    },
    [...CLEARANCE_VALUE_FIELDS, ...CLEARANCE_MASKED_FIELDS],
  );
}

/**
 * Field changes between two versions of a clearance (`before` null ⇒ opened). `fromClub` /
 * `toClub` hold the club names with a `ref` to each club; the player is never a value here
 * (the caller adds a `player` mention). Reasons and the note are masked.
 */
export function clearanceChanges(
  before: Partial<PlayerClearance> | null | undefined,
  after: Partial<PlayerClearance> | null | undefined,
): AuditChange[] {
  const changes = diffFields(clearanceView(before), clearanceView(after), {
    fields: [...CLEARANCE_VALUE_FIELDS, ...CLEARANCE_MASKED_FIELDS],
    mask: CLEARANCE_MASKED_FIELDS,
    refs: {
      fromClub: nameRef('club', [
        [before?.fromClubName, before?.fromClubId],
        [after?.fromClubName, after?.fromClubId],
      ]),
      toClub: nameRef('club', [
        [before?.toClubName, before?.toClubId],
        [after?.toClubName, after?.toClubId],
      ]),
    },
  });
  return createOnly(changes, !before);
}

const VETREQ_VALUE_FIELDS = ['status', 'primaryClub', 'veteransClub', 'leagueKey'] as const;
const VETREQ_MASKED_FIELDS = ['note', 'declineReason'] as const;

/**
 * Field changes between two versions of a veterans request (`before` null ⇒ created): status,
 * league, and both clubs by name with a `ref`; the note and decline reason are masked.
 */
export function veteransRequestChanges(
  before: Partial<VeteransRequest> | null | undefined,
  after: Partial<VeteransRequest> | null | undefined,
): AuditChange[] {
  const view = (r: Partial<VeteransRequest> | null | undefined) =>
    r
      ? pick(
          {
            ...(r as Record<string, unknown>),
            primaryClub: r.primaryClubName,
            veteransClub: r.veteransClubName,
          },
          [...VETREQ_VALUE_FIELDS, ...VETREQ_MASKED_FIELDS],
        )
      : null;
  const changes = diffFields(view(before), view(after), {
    fields: [...VETREQ_VALUE_FIELDS, ...VETREQ_MASKED_FIELDS],
    mask: VETREQ_MASKED_FIELDS,
    refs: {
      primaryClub: nameRef('club', [
        [before?.primaryClubName, before?.primaryClubId],
        [after?.primaryClubName, after?.primaryClubId],
      ]),
      veteransClub: nameRef('club', [
        [before?.veteransClubName, before?.veteransClubId],
        [after?.veteransClubName, after?.veteransClubId],
      ]),
    },
  });
  return createOnly(changes, !before);
}

const REVIEW_VALUE_FIELDS = ['kind', 'status', 'resolution', 'destClub'] as const;
/** The typed (free-text) previous club, and an on-system one held by name only (no id). */
const REVIEW_MASKED_FIELDS = ['typedPreviousClub', 'previousClub'] as const;

/**
 * A registration review's fields, before → after (`before` null ⇒ opened): kind, status,
 * resolution and the destination club by name (`ref` the club). The previous club the player
 * typed (free text) or named (no id to scrub it by) is masked; no player data is recorded —
 * the caller adds a `player` mention.
 */
export function registrationReviewChanges(
  before: Partial<RegistrationReview> | null | undefined,
  after: Partial<RegistrationReview> | null | undefined,
): AuditChange[] {
  const fields = [...REVIEW_VALUE_FIELDS, ...REVIEW_MASKED_FIELDS];
  const view = (r: Partial<RegistrationReview> | null | undefined) =>
    r
      ? pick(
          {
            ...(r as Record<string, unknown>),
            destClub: r.destClubName,
            previousClub: r.previousClubName,
          },
          fields,
        )
      : null;
  const changes = diffFields(view(before), view(after), {
    fields,
    mask: REVIEW_MASKED_FIELDS,
    refs: {
      destClub: nameRef('club', [
        [before?.destClubName, before?.destClubId],
        [after?.destClubName, after?.destClubId],
      ]),
    },
  });
  return createOnly(changes, !before);
}

// ── Series and fixtures ──

/** Top-level series fields diffed with values (fixtures are diffed per fixture). */
const SERIES_FIELDS = [
  'name',
  'startDate',
  'endDate',
  'dateMode',
  'activateFrom',
  'teams',
  'leagueKey',
  'seriesType',
  'maxOvers',
  'schedule',
  'seasonRunId',
  'stageSpecId',
  'groupId',
  'approved',
  'released',
  'withheld',
] as const;

/** Field changes between two versions of a series' top-level fields (`before` null ⇒ create). */
export function seriesChanges(
  before: Partial<Series> | null | undefined,
  after: Partial<Series> | null | undefined,
): AuditChange[] {
  const changes = diffFields(
    pick(before as Record<string, unknown> | null, SERIES_FIELDS),
    pick(after as Record<string, unknown> | null, SERIES_FIELDS),
    { fields: SERIES_FIELDS },
  );
  return createOnly(changes, !before);
}

/** Fixture fields diffed with values (`home` / `away` as team names, `venue` as the ground). */
const FIXTURE_FIELDS = [
  'date',
  'time',
  'slot',
  'round',
  'home',
  'away',
  'venue',
  'venueOverride',
  'venueStatus',
  'status',
  'originalDate',
  'dateTbc',
  'homeScore',
  'awayScore',
  'winner',
] as const;

type FixtureRow = Record<string, unknown>;

/** A series' team id → name (its participants snapshot; the id when it has none). */
export function seriesTeamName(series: Partial<Series> | null | undefined) {
  const names = new Map<string, string>();
  for (const p of series?.participants ?? []) if (p?.teamId && p.name) names.set(p.teamId, p.name);
  return (id: unknown): unknown =>
    typeof id === 'string' ? (names.get(id) ?? id) : id === undefined ? undefined : id;
}

/**
 * A series' team id → the club behind it: its participants snapshot, or — a legacy series
 * without one — the id itself (there every team id is a club id). A knockout slot reference
 * (`win:f3`) or an unknown team has no club.
 */
export function seriesTeamClub(series: Partial<Series> | null | undefined) {
  const parts = series?.participants ?? [];
  const byTeam = new Map(parts.filter((p) => p?.teamId).map((p) => [p.teamId, p.clubId]));
  return (id: unknown): string | undefined => {
    if (typeof id !== 'string' || !id) return undefined;
    if (parts.length) return byTeam.get(id) || undefined;
    return id.includes(':') ? undefined : id;
  };
}

/**
 * A `<home> v <away>` label and the club behind each side (`clubIds`, '' for none), from the
 * two sides' display names and team ids. A side without a name is left out of both.
 */
export function matchLabel(sides: ReadonlyArray<[name: unknown, clubId: string | undefined]>): {
  label: string;
  clubIds?: string[];
} {
  const kept = sides.filter(([n]) => n !== undefined && n !== null && n !== '');
  const clubIds = kept.map(([, c]) => c ?? '');
  return {
    label: kept.map(([n]) => String(n)).join(' v '),
    ...(clubIds.some(Boolean) ? { clubIds } : {}),
  };
}

function fixtureView(f: FixtureRow, team: (id: unknown) => unknown): Record<string, unknown> {
  const out = pick(f, FIXTURE_FIELDS) ?? {};
  out.home = team(f.home);
  out.away = team(f.away);
  const venue = f.venueName ?? f.venueId;
  if (venue !== undefined) out.venue = venue;
  else delete out.venue;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** One fixture as the audit trail records it. `id` is the fixture's own id (not prefixed). */
export interface FixtureAudit {
  id: string;
  label: string;
  /** The club behind each side of `label` (see audit.ts `auditTarget`). */
  clubIds?: string[];
  op: 'create' | 'update' | 'delete';
  changes: AuditChange[];
}

/**
 * Per-fixture changes between two fixture lists (matched by id): every added, removed or
 * changed fixture, in schedule order (removed ones last). Fixtures without an id are skipped.
 * `home` / `away` hold the team names, each with a `ref` to the club behind it (`fromRef` when
 * the side changed clubs); the label names both sides with their `clubIds`. The caller applies
 * the caps (the scope keeps the first 25 targets and counts the rest).
 */
export function fixtureChanges(
  before: Partial<Series> | null | undefined,
  after: Partial<Series> | null | undefined,
): { fixtures: FixtureAudit[]; added: number; removed: number; changed: number } {
  const teamBefore = seriesTeamName(before);
  const teamAfter = seriesTeamName(after);
  const clubBefore = seriesTeamClub(before);
  const clubAfter = seriesTeamClub(after);
  const rows = (s: Partial<Series> | null | undefined) =>
    ((s?.fixtures ?? []) as unknown[]).filter(
      (f): f is FixtureRow =>
        !!f && typeof f === 'object' && typeof (f as FixtureRow).id === 'string',
    );
  const was = new Map(rows(before).map((f) => [f.id as string, f]));
  const now = rows(after);
  const nowIds = new Set(now.map((f) => f.id as string));
  const label = (
    v: Record<string, unknown>,
    f: FixtureRow,
    club: (id: unknown) => string | undefined,
  ) =>
    matchLabel([
      [v.home, club(f.home)],
      [v.away, club(f.away)],
    ]);
  const refs = (b: FixtureRow | undefined, a: FixtureRow | undefined) => {
    const bv = b ? fixtureView(b, teamBefore) : undefined;
    const av = a ? fixtureView(a, teamAfter) : undefined;
    const side = (k: 'home' | 'away') =>
      nameRef('club', [
        [bv?.[k], clubBefore(b?.[k])],
        [av?.[k], clubAfter(a?.[k])],
      ]);
    return {
      venue: nameRef('venue', [
        [b?.venueName ?? b?.venueId, b?.venueId],
        [a?.venueName ?? a?.venueId, a?.venueId],
      ]),
      home: side('home'),
      away: side('away'),
    };
  };
  const out: FixtureAudit[] = [];
  let added = 0;
  let changed = 0;
  for (const f of now) {
    const id = f.id as string;
    const prev = was.get(id);
    const a = fixtureView(f, teamAfter);
    const b = prev ? fixtureView(prev, teamBefore) : null;
    const changes = createOnly(
      diffFields(b, a, { fields: FIXTURE_FIELDS, refs: refs(prev, f) }),
      !prev,
    );
    if (!prev) added++;
    else if (changes.length) changed++;
    else continue;
    out.push({ id, ...label(a, f, clubAfter), op: prev ? 'update' : 'create', changes });
  }
  let removed = 0;
  for (const [id, f] of was) {
    if (nowIds.has(id)) continue;
    removed++;
    const b = fixtureView(f, teamBefore);
    out.push({
      id,
      ...label(b, f, clubBefore),
      op: 'delete',
      changes: diffFields(b, null, { fields: FIXTURE_FIELDS, refs: refs(f, undefined) }),
    });
  }
  return { fixtures: out, added, removed, changed };
}

/**
 * The action a generic series PATCH reads as: reveal, set a knockout side, release, recall,
 * approve, a fixtures edit (any fixture added, removed or changed), unapprove (approval
 * withdrawn with no fixture touched), else a plain update. A fixtures edit that withdraws an
 * approval reads as the edit; the approved true → false change is still on the series target.
 */
export function seriesPatchAction(
  kind: { reveal?: boolean; setSide?: boolean },
  before: Partial<Series>,
  after: Partial<Series>,
  fixturesTouched: number,
): string {
  if (kind.reveal) return 'series.reveal';
  if (kind.setSide) return 'series.set-side';
  if (after.released === true && before.released !== true) return 'series.release';
  if (after.released !== true && before.released === true) return 'series.recall';
  if (after.approved === true && before.approved !== true) return 'series.approve';
  if (fixturesTouched > 0) return 'series.fixtures.edit';
  if (after.approved !== true && before.approved === true) return 'series.unapprove';
  return 'series.update';
}

// ── Competitions ──

/** Competition fields diffed with values (`teams` is diffed per team). */
const COMPETITION_FIELDS = [
  'name',
  'type',
  'leagueKey',
  'overs',
  'format',
  'schedule',
  'points',
  'seed',
] as const;

/** One competing team as the audit trail names it: its name and the club behind it. */
export interface CompetitionAuditTeam {
  name: string;
  clubId?: string;
}

/** What a competition's audit diff compares (team names and their clubs, not team ids). */
export interface CompetitionAuditView {
  name?: string;
  type?: string;
  leagueKey?: string;
  overs?: number;
  teams?: CompetitionAuditTeam[];
  format?: unknown;
  schedule?: unknown;
  points?: unknown;
  seed?: number;
}

/** Teams by name + club, first occurrence kept (a team plays in several series). */
export function competitionTeams(
  teams: ReadonlyArray<{ name?: string; clubId?: string } | null | undefined>,
): CompetitionAuditTeam[] {
  const seen = new Set<string>();
  const out: CompetitionAuditTeam[] = [];
  for (const t of teams) {
    if (!t?.name) continue;
    const k = `${t.name}\u0000${t.clubId ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ name: t.name, ...(t.clubId ? { clubId: t.clubId } : {}) });
  }
  return out;
}

/** A competition's config as stored on its series (the first series' meta, all teams). */
export function competitionViewOfSeries(series: readonly Partial<Series>[]): CompetitionAuditView {
  const s0 = series[0] as (Partial<Series> & { competition?: Record<string, unknown> }) | undefined;
  const meta = (s0?.competition ?? {}) as Record<string, unknown>;
  const teams = competitionTeams(series.flatMap((s) => s.participants ?? []));
  return {
    ...(pick(meta, ['name', 'type', 'format', 'schedule', 'points', 'seed']) ?? {}),
    ...(typeof s0?.leagueKey === 'string' ? { leagueKey: s0.leagueKey } : {}),
    ...(typeof s0?.maxOvers === 'number' ? { overs: s0.maxOvers } : {}),
    ...(teams.length ? { teams } : {}),
  };
}

/**
 * Field changes between two competition configs (`before` null ⇒ created). Teams are one
 * `teams` change per team removed (`from`) or added (`to`), its name with a `ref` to the club
 * behind it, so deleting that club strips that team only; a team with no club is recorded
 * masked (no record to scrub its name by). A reorder is not a change.
 */
export function competitionChanges(
  before: CompetitionAuditView | null | undefined,
  after: CompetitionAuditView | null | undefined,
): AuditChange[] {
  const changes = createOnly(
    diffFields(
      pick(before as Record<string, unknown> | null, COMPETITION_FIELDS),
      pick(after as Record<string, unknown> | null, COMPETITION_FIELDS),
      { fields: COMPETITION_FIELDS },
    ),
    !before,
  );
  const key = (t: CompetitionAuditTeam) => `${t.name}\u0000${t.clubId ?? ''}`;
  const was = before?.teams ?? [];
  const now = after?.teams ?? [];
  const wasKeys = new Set(was.map(key));
  const nowKeys = new Set(now.map(key));
  const teamChange = (t: CompetitionAuditTeam, side: 'from' | 'to'): AuditChange =>
    t.clubId
      ? { field: 'teams', [side]: t.name, ref: { type: 'club', id: t.clubId } }
      : { field: 'teams', masked: true };
  for (const t of was) if (!nowKeys.has(key(t))) changes.push(teamChange(t, 'from'));
  for (const t of now) if (!wasKeys.has(key(t))) changes.push(teamChange(t, 'to'));
  return changes;
}

// ── Season runs ──

/**
 * A season run as audit fields: `leagueKey`, `seasonLabel`, `calendarFrozenAt`, `structure`
 * (`<name> v<version>`), `calendar` (its label) and per stage `stages.<specId>.<field>` —
 * `status`, `groups` (`<label> (<entrants>)`), `pairingOverride`, `staleSchedule`,
 * `formatChanged`, `carriedPoints`. The stages' decision log (it names staff) is left out.
 */
export function seasonRunAuditView(
  run: Partial<SeasonRun> | null | undefined,
): Record<string, unknown> {
  if (!run) return {};
  const out: Record<string, unknown> = {};
  for (const f of ['leagueKey', 'seasonLabel', 'calendarFrozenAt'] as const)
    if (run[f] !== undefined) out[f] = run[f];
  const st = run.structureSnapshot;
  if (st) out.structure = `${st.name ?? st.id} v${st.version}`;
  if (run.calendarSnapshot) out.calendar = run.calendarSnapshot.label ?? run.calendarSnapshot.id;
  for (const s of run.stages ?? []) {
    if (!s?.specId) continue;
    const p = `stages.${s.specId}`;
    out[`${p}.status`] = s.status;
    out[`${p}.groups`] = (s.groups ?? []).map(
      (g) => `${g.label ?? g.id} (${(g.entrants ?? []).length})`,
    );
    for (const f of ['pairingOverride', 'staleSchedule', 'formatChanged', 'carriedPoints'] as const)
      if (s[f] !== undefined) out[`${p}.${f}`] = s[f];
  }
  return structuredClone(out);
}

/**
 * Field changes between two versions of a season run (`before` null ⇒ created). Capture
 * `beforeView` with {@link seasonRunAuditView} right after the read when the record may be
 * edited in place.
 */
export function seasonRunChanges(
  before: Partial<SeasonRun> | null | undefined,
  after: Partial<SeasonRun> | null | undefined,
  opts: { beforeView?: Record<string, unknown> } = {},
): AuditChange[] {
  const b = opts.beforeView ?? seasonRunAuditView(before);
  const a = seasonRunAuditView(after);
  const fields = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  return createOnly(diffFields(b, a, { fields }), !before && !opts.beforeView);
}

// ── Venues ──

const VENUE_VALUE_FIELDS = [
  'name',
  'suburb',
  'lat',
  'lon',
  'homeClubIds',
  'surfaces',
  'unavailable',
  'unavailableWeekdays',
] as const;
const VENUE_MASKED_FIELDS = ['address', 'note'] as const;

/**
 * Field changes between two versions of a venue (`before` null ⇒ created, `after` null ⇒
 * deleted). Unavailable windows keep their dates only (`<start> – <end>`; the reason is free
 * text); the address and note are masked.
 */
export function venueChanges(
  before: Partial<Venue> | null | undefined,
  after: Partial<Venue> | null | undefined,
): AuditChange[] {
  const fields = [...VENUE_VALUE_FIELDS, ...VENUE_MASKED_FIELDS];
  const view = (v: Partial<Venue> | null | undefined) =>
    v
      ? pick(
          {
            ...(v as Record<string, unknown>),
            unavailable: v.unavailable?.map((w) => `${w?.start} – ${w?.end}`),
          },
          fields,
        )
      : null;
  const changes = diffFields(view(before), view(after), { fields, mask: VENUE_MASKED_FIELDS });
  return createOnly(changes, !before);
}

// ── Postponements ──

const POSTPONEMENT_VALUE_FIELDS = [
  'status',
  'awaiting',
  'requestingClub',
  'opposingClub',
  'originalDate',
  'originalTime',
  'proposedDate',
  'proposedTime',
  'proposedVenue',
  'proposedBy',
  'proposals',
  'agreedDate',
] as const;
const POSTPONEMENT_MASKED_FIELDS = ['reason', 'note', 'declineReason'] as const;

/** A postponement request as audit fields (the LAST proposal is the one on the table). */
function postponementView(
  r: Partial<PostponementRequest> | null | undefined,
  clubName: (id: string) => string,
): Record<string, unknown> | null {
  if (!r) return null;
  const last = r.proposals?.[r.proposals.length - 1];
  const out = pick(
    {
      ...(r as Record<string, unknown>),
      requestingClub: r.requestingClubId ? clubName(r.requestingClubId) : undefined,
      opposingClub: r.opposingClubId ? clubName(r.opposingClubId) : undefined,
      proposedDate: last?.date,
      proposedTime: last?.time,
      proposedVenue: last?.venueName ?? last?.venueId,
      proposedBy: last?.by,
      proposals: r.proposals?.length,
      agreedDate: r.status === 'applied' || r.status === 'admin-final' ? last?.date : undefined,
      note: last?.note,
    },
    [...POSTPONEMENT_VALUE_FIELDS, ...POSTPONEMENT_MASKED_FIELDS],
  )!;
  for (const clubId of Object.keys(r.acknowledgements ?? {})) out[`acknowledged.${clubId}`] = true;
  return out;
}

/**
 * Field changes between two versions of a postponement request (`before` null ⇒ opened):
 * status, whose turn it is, both clubs by name (`ref` each), the original and proposed date /
 * time / venue (`ref` the venue when it has an id), who proposed, how many proposals, the
 * agreed date once applied or ruled, and `acknowledged.<clubId>` per club that acknowledged a
 * ruling (`ref` the club). The reason, the proposal's note and the decline reason are masked;
 * who typed what (emails) is never stored — the entry's actor says who.
 */
export function postponementChanges(
  before: Partial<PostponementRequest> | null | undefined,
  after: Partial<PostponementRequest> | null | undefined,
  clubName: (id: string) => string,
): AuditChange[] {
  const b = postponementView(before, clubName);
  const a = postponementView(after, clubName);
  const lastB = before?.proposals?.[before.proposals.length - 1];
  const lastA = after?.proposals?.[after.proposals.length - 1];
  const acks = [
    ...new Set([
      ...Object.keys(before?.acknowledgements ?? {}),
      ...Object.keys(after?.acknowledgements ?? {}),
    ]),
  ].map((id) => `acknowledged.${id}`);
  const refs: NonNullable<Parameters<typeof diffFields>[2]>['refs'] = {
    requestingClub: nameRef('club', [
      [b?.requestingClub, before?.requestingClubId],
      [a?.requestingClub, after?.requestingClubId],
    ]),
    opposingClub: nameRef('club', [
      [b?.opposingClub, before?.opposingClubId],
      [a?.opposingClub, after?.opposingClubId],
    ]),
    proposedVenue: nameRef('venue', [
      [lastB?.venueName ?? lastB?.venueId, lastB?.venueId],
      [lastA?.venueName ?? lastA?.venueId, lastA?.venueId],
    ]),
  };
  for (const f of acks) {
    const id = f.slice('acknowledged.'.length);
    refs[f] = () => ({ type: 'club', id });
  }
  const changes = diffFields(b, a, {
    fields: [...POSTPONEMENT_VALUE_FIELDS, ...POSTPONEMENT_MASKED_FIELDS, ...acks],
    mask: POSTPONEMENT_MASKED_FIELDS,
    refs,
  });
  return createOnly(changes, !before);
}

// ── Captain's reports ──

/** Report fields recorded without a value (free text and the person typed as captain). */
const REPORT_MASKED_FIELDS = ['captainName', 'general', 'scorecardFeedback'] as const;
/** Per-umpire fields recorded without a value. */
const REPORT_UMPIRE_MASKED: ReadonlySet<string> = new Set(['otherConcern', 'comments']);
const UMPIRE_FIELD_RE = /^umpires\.(\d+)\.(\w+)$/;

/** Ratings as one readable value: `decisions 4, pressure 3` (criteria in the stored order). */
const ratingsText = (r: Record<string, unknown> | undefined) =>
  Object.entries(r ?? {})
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');

/**
 * A report as audit fields: `status`, `submittedVia`, `ref` (the CR number), `declaration`,
 * `scorecard` (the answer: confirmed / correction), `recipientKind`, `forwardCount`, the masked
 * free text, and per umpire card `umpires.<n>.umpire` (the name), `.substitute`, `.ratings`,
 * `.concerns` (the ticked areas), `.otherConcern` / `.comments` (masked). Cards are numbered
 * from 1.
 */
function captainsReportView(r: Partial<CaptainsReport> | null | undefined) {
  if (!r) return null;
  const out: Record<string, unknown> = {
    ...pick(
      {
        ...(r as Record<string, unknown>),
        scorecard: r.scorecard?.action,
        scorecardFeedback: r.scorecard?.feedback || undefined,
        recipientKind: r.recipient?.kind,
        captainName: r.captainName || undefined,
        general: r.general || undefined,
      },
      [
        'status',
        'submittedVia',
        'ref',
        'declaration',
        'scorecard',
        'recipientKind',
        'forwardCount',
        ...REPORT_MASKED_FIELDS,
      ],
    ),
  };
  (r.umpires ?? []).forEach((u, i) => {
    if (!u) return;
    const p = `umpires.${i + 1}`;
    if (u.name) out[`${p}.umpire`] = u.name;
    if (u.substitute) out[`${p}.substitute`] = true;
    const ratings = ratingsText(u.ratings as Record<string, unknown>);
    if (ratings) out[`${p}.ratings`] = ratings;
    const concerns = Object.entries(u.concerns ?? {})
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    if (concerns.length) out[`${p}.concerns`] = concerns;
    if (u.otherConcern) out[`${p}.otherConcern`] = u.otherConcern;
    if (u.comments) out[`${p}.comments`] = u.comments;
  });
  return structuredClone(out);
}

/**
 * Field changes between two versions of a captain's report (`before` null ⇒ filed). Every
 * per-umpire change carries a `ref` to the registry umpire it rates (and `fromRef` when the
 * card named another), so erasing that umpire strips its name and ratings. A card naming a
 * free-text umpire (no registry id) records the name masked. The rating numbers and ticked
 * concern areas are kept; every comment is masked.
 */
export function captainsReportChanges(
  before: Partial<CaptainsReport> | null | undefined,
  after: Partial<CaptainsReport> | null | undefined,
): AuditChange[] {
  const b = captainsReportView(before) ?? {};
  const a = captainsReportView(after) ?? {};
  const fields = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const masked = fields.filter((f) => {
    const m = UMPIRE_FIELD_RE.exec(f);
    return (
      (REPORT_MASKED_FIELDS as readonly string[]).includes(f) ||
      (!!m && REPORT_UMPIRE_MASKED.has(m[2]))
    );
  });
  const changes = diffFields(before ? b : null, after ? a : null, { fields, mask: masked });
  const umpireAt = (r: Partial<CaptainsReport> | null | undefined, n: number) =>
    r?.umpires?.[n - 1];
  const out = changes.map((c): AuditChange => {
    const m = UMPIRE_FIELD_RE.exec(c.field);
    if (!m) return c;
    const n = Number(m[1]);
    const ub = umpireAt(before, n);
    const ua = umpireAt(after, n);
    // A free-text name has no record an erasure could find it by: the name is masked.
    if (m[2] === 'umpire' && ((ub?.name && !ub.umpireId) || (ua?.name && !ua.umpireId)))
      return { field: c.field, masked: true };
    const toRef = ua?.umpireId ? { type: 'umpire', id: ua.umpireId } : undefined;
    const fromRef = ub?.umpireId ? { type: 'umpire', id: ub.umpireId } : undefined;
    const ref = toRef ?? fromRef;
    if (!ref) return c;
    return {
      ...c,
      ref,
      ...(toRef && fromRef && toRef.id !== fromRef.id ? { fromRef } : {}),
    };
  });
  return createOnly(out, !before);
}

/**
 * A report (or squad link) sent on to a player: who it now goes to — the name, with a `ref`
 * to that player (their natural key) — and the new recipient's contact, masked. The previous
 * recipient's name is not repeated (it may be a chair or a portal user with no player record);
 * `recipientKind` old → new comes from the record's own diff.
 */
export function recipientForwardChanges(
  name: string | undefined,
  playerKey: string | undefined,
): AuditChange[] {
  return [
    ...(name && playerKey
      ? [{ field: 'recipient', to: name, ref: { type: 'player', id: playerKey } }]
      : name
        ? [{ field: 'recipient', masked: true as const }]
        : []),
    { field: 'recipientContact', masked: true },
  ];
}

/**
 * An admin attributing a free-text umpire on a submitted report to a registry umpire: the
 * card's umpire old (the typed name) → new (the registry name), both naming the registry umpire
 * (`ref`; erasing it strips both), and how (`registered` / `linked`).
 */
export function umpireAttributionChanges(
  index: number,
  freeTextName: string,
  umpire: { id: string; displayName: string },
  how: string,
): AuditChange[] {
  const p = `umpires.${index + 1}`;
  const ref = { type: 'umpire', id: umpire.id };
  return [
    { field: `${p}.umpire`, from: freeTextName, to: umpire.displayName, ref },
    { field: `${p}.attribution`, to: how, ref },
  ];
}

// ── Squads ──

/**
 * Field changes between two versions of a squad request: `status`, `recipientKind`,
 * `forwardCount`, `voidReason`, how many players and guests are selected (guest names are free
 * text: counted only), the captain (name, `ref` the player), and one `selection.player` change
 * per player added (`to`) or removed (`from`), each with a `ref` to that player. The caller's
 * scope caps the list (40 changes per target).
 */
export function squadRequestChanges(
  before: Partial<SquadRequest> | null | undefined,
  after: Partial<SquadRequest> | null | undefined,
): AuditChange[] {
  // The captain's name, or null when the key names nobody in `players` (no name to show —
  // the key itself is never a value: it is derived from an ID number).
  const captainName = (r: Partial<SquadRequest> | null | undefined) => {
    const key = r?.selection?.captainKey;
    if (!key) return undefined;
    return (r?.selection?.players ?? []).find((p) => p?.key === key)?.name ?? null;
  };
  const view = (r: Partial<SquadRequest> | null | undefined) =>
    r
      ? pick(
          {
            ...(r as Record<string, unknown>),
            recipientKind: r.recipient?.kind,
            'selection.players': r.selection?.players?.length,
            'selection.guests': r.selection?.guests?.length,
            // An unnamed captain compares by key (so a change still shows) but is masked below.
            'selection.captain':
              captainName(r) === null ? `#${r.selection?.captainKey}` : captainName(r),
          },
          [
            'status',
            'recipientKind',
            'forwardCount',
            'voidReason',
            'selection.players',
            'selection.guests',
            'selection.captain',
          ],
        )
      : null;
  const b = view(before);
  const a = view(after);
  const capRef = nameRef('player', [
    [b?.['selection.captain'], before?.selection?.captainKey],
    [a?.['selection.captain'], after?.selection?.captainKey],
  ]);
  const unnamedCaptain = captainName(before) === null || captainName(after) === null;
  const changes = createOnly(
    diffFields(b, a, {
      fields: [
        'status',
        'recipientKind',
        'forwardCount',
        'voidReason',
        'selection.players',
        'selection.guests',
        'selection.captain',
      ],
      ...(unnamedCaptain ? { mask: ['selection.captain'] } : {}),
      refs: { 'selection.captain': capRef },
    }),
    !before,
  );
  const was = new Map((before?.selection?.players ?? []).map((p) => [p.key, p.name]));
  const now = new Map((after?.selection?.players ?? []).map((p) => [p.key, p.name]));
  for (const [key, name] of now)
    if (!was.has(key))
      changes.push({ field: 'selection.player', to: name, ref: { type: 'player', id: key } });
  for (const [key, name] of was)
    if (!now.has(key))
      changes.push({ field: 'selection.player', from: name, ref: { type: 'player', id: key } });
  return changes;
}

/**
 * A team's designated captain for one competition, old → new: the name as the value with a
 * `ref` to the player (their natural key) on each side; `null` ⇒ none.
 */
export function teamCaptainChange(
  scope: string,
  before: { key: string; name: string } | null,
  after: { key: string; name: string } | null,
): AuditChange[] {
  if ((before?.key ?? null) === (after?.key ?? null)) return [];
  const toRef = after ? { type: 'player', id: after.key } : undefined;
  const fromRef = before ? { type: 'player', id: before.key } : undefined;
  return [
    {
      field: `captain.${scope}`,
      ...(before ? { from: before.name } : {}),
      ...(after ? { to: after.name } : {}),
      ref: (toRef ?? fromRef)!,
      ...(toRef && fromRef ? { fromRef } : {}),
    },
  ];
}
