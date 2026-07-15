/**
 * Repository — all DynamoDB access for the single table. Callers pass a tenant
 * and the repo builds tenant-scoped keys via ./keys, so no handler ever touches
 * a raw key. Club/series writes use optimistic concurrency (version check).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  DeleteCommand,
  BatchWriteCommand,
  TransactWriteCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
  clubKey,
  clubInviteKey,
  clubGsi1,
  clubsListGsi1pk,
  seriesKey,
  seriesGsi1,
  seriesListGsi1pk,
  playerKey,
  playersListKey,
  clearanceKey,
  inboundClearanceKey,
  clearancesListKey,
  inboundClearancesListKey,
  clearanceGsi1,
  clearancesListGsi1pk,
  registrationReviewKey,
  registrationReviewsListKey,
  registrationReviewGsi1,
  registrationReviewsListGsi1pk,
  tokenKey,
  tenantConfigKey,
  tenantConfigGsi1,
  tenantsListGsi1pk,
  exportLogKey,
  exportLogsListKey,
  userKey,
  userTenantMarkerKey,
  userGsi1,
  usersListGsi1pk,
} from './keys.js';
import { PLATFORM_TENANT } from './types.js';
import type {
  Club,
  ClubCommEvent,
  ExportLogEntry,
  League,
  SendResult,
  Series,
  TenantConfig,
  UserProfile,
  PlayerRegistration,
  PlayerClearance,
  RegistrationReview,
  RegistrationReviewResolution,
} from './types.js';

import { tableName } from './env.js';
import { teamIdsForClub } from './teams.js';

const TABLE = tableName();
// DYNAMO_ENDPOINT points at a local DynamoDB (dynalite) for offline dev; any
// credentials are accepted by the local clone. Unset in AWS (uses the role).
const localEndpoint = process.env.DYNAMO_ENDPOINT;
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient(
    localEndpoint
      ? {
          endpoint: localEndpoint,
          region: 'localhost',
          credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
        }
      : {},
  ),
  { marshallOptions: { removeUndefinedValues: true } },
);

const s3 = new S3Client({});
const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET;

/**
 * Best-effort delete of stored upload objects (compliance PDFs, player ID docs) during
 * tenant/cohort erasure — so a POPIA "right to erasure" actually removes the files, not
 * just the DynamoDB rows. Skips local-dev keys and never throws: a failed object delete is
 * logged (recoverable via a bucket lifecycle rule) and must not abort the erase.
 */
async function deleteUploadObjects(objectKeys: string[]): Promise<void> {
  if (!UPLOADS_BUCKET) return;
  for (const key of objectKeys) {
    if (!key || key.startsWith('local/')) continue;
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: UPLOADS_BUCKET, Key: key }));
    } catch (err) {
      console.warn(`erase: failed to delete upload object ${key}`, err);
    }
  }
}

/**
 * Pull every stored objectKey off a club (docMeta) — used to purge S3 on erasure.
 * Safeguarding is the one multi-file doc (`{ files: [...] }` instead of a single
 * `objectKey`), so its per-file keys are collected too — mirroring how the API's
 * assertDocMetaObjectKeys walks a docMeta patch. Missing them would leave
 * safeguarding certificates (PII) in the bucket after an erase. Exported for the
 * test suite — the dynalite harness has no S3, so collection is asserted directly.
 */
export function clubDocObjectKeys(club: Club): string[] {
  const docMeta = (club.docMeta ?? {}) as Record<
    string,
    { objectKey?: string; files?: Array<{ objectKey?: string }> } | undefined
  >;
  const keys: string[] = [];
  for (const m of Object.values(docMeta)) {
    if (typeof m?.objectKey === 'string') keys.push(m.objectKey);
    if (Array.isArray(m?.files)) {
      for (const f of m.files) {
        if (typeof f?.objectKey === 'string') keys.push(f.objectKey);
      }
    }
  }
  return keys;
}

/** Thrown when a version-checked write loses a race. Handlers map this to HTTP 409. */
export class VersionConflictError extends Error {
  constructor() {
    super('version conflict');
    this.name = 'VersionConflictError';
  }
}

/**
 * Thrown when a transactional admin-decrement (demote/remove) would leave a tenant
 * with zero admins — the CONFIG `adminCount > 1` condition failed. Handlers map this
 * to HTTP 409 "cannot remove the last admin".
 */
export class LastAdminError extends Error {
  constructor() {
    super('cannot remove the last admin');
    this.name = 'LastAdminError';
  }
}

const stripKeys = <T>(item: Record<string, unknown> | undefined): T | null => {
  if (!item) return null;
  const { pk, sk, gsi1pk, gsi1sk, ...rest } = item;
  return rest as T;
};

/**
 * Drain a Query across LastEvaluatedKey pages. A single Query response is capped at
 * 1 MB, so any enumeration that feeds an erase cascade MUST page — a >1MB partition
 * would otherwise silently truncate to its first page and leave residue an erase
 * promised to remove. Passes the input through untouched, so callers may set `Limit`
 * for smaller pages — the int tests use that to drive multi-page reads against
 * dynalite, where seeding a real >1MB partition isn't practical (hence the export).
 */
export async function queryAll(input: QueryCommandInput): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey: startKey }));
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

// ── Tenant config ──

export async function getTenantConfig(tenant: string): Promise<TenantConfig | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: tenantConfigKey(tenant) }));
  return stripKeys<TenantConfig>(res.Item);
}

/** Create a tenant config; fails if the slug is already taken (collision guard). */
export async function createTenantConfig(config: TenantConfig): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      // gsi1 (the platform tenant registry) is derived HERE, at the write choke
      // point: stripKeys removes gsi attrs on read, so a caller round-tripping a
      // read config could never carry them back. Derived keys spread LAST so a
      // config that smuggles pk/sk/gsi1* can never override them.
      Item: { ...config, ...tenantConfigKey(config.tenant), ...tenantConfigGsi1(config.tenant) },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
}

export async function putTenantConfig(config: TenantConfig): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      // Whole-item Put: re-derive gsi1 so a config save can't delist the tenant
      // from the platform registry (see createTenantConfig). Derived keys spread
      // LAST so a config that smuggles pk/sk/gsi1* can never override them.
      Item: { ...config, ...tenantConfigKey(config.tenant), ...tenantConfigGsi1(config.tenant) },
    }),
  );
}

/**
 * Enumerate every tenant's CONFIG row (the platform registry), sorted by slug.
 * Queries the PLATFORM#TENANTS gsi1 partition — rows written before the registry
 * index existed need ensureTenantConfigGsi (backfill-branding runs it).
 */
export async function listTenants(): Promise<TenantConfig[]> {
  const items = await queryAll({
    TableName: TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': tenantsListGsi1pk() },
  });
  // gsi1sk = slug, so the query returns slug order already; sort defensively anyway.
  return items
    .map((i) => stripKeys<TenantConfig>(i)!)
    .sort((a, b) => a.tenant.localeCompare(b.tenant));
}

/**
 * Idempotent registry-index backfill: SET the PLATFORM#TENANTS gsi1 attrs on an
 * EXISTING CONFIG row (no-op when already present — same values every time).
 * Throws ConditionalCheckFailedException when the row doesn't exist (callers
 * read first, so that only fires on a delete race).
 */
export async function ensureTenantConfigGsi(tenant: string): Promise<void> {
  const gsi = tenantConfigGsi1(tenant);
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: tenantConfigKey(tenant),
      UpdateExpression: 'SET gsi1pk = :p, gsi1sk = :s',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':p': gsi.gsi1pk, ':s': gsi.gsi1sk },
    }),
  );
}

/**
 * Update only the support-contact copy slot. Uses a targeted UpdateExpression
 * (not a whole-config read-modify-write) so it physically cannot clobber a
 * concurrent leagues/deadline write — TenantConfig has no version guard.
 * Throws ConditionalCheckFailedException if the config row doesn't exist
 * (handler maps that to 404).
 *
 * Precondition: the `branding.copy` map must already exist on the row — setting
 * a nested path can't create its parent. This holds for every config we write
 * (the TenantConfig type makes `branding.copy` required and seed-core always
 * populates it), so a missing parent would mean a malformed/hand-edited row; it
 * would surface as a ValidationException → unmapped 500 rather than the 404.
 */
export async function updateSupportCopy(tenant: string, support: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: tenantConfigKey(tenant),
      UpdateExpression: 'SET #b.#c.#s = :v',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#b': 'branding', '#c': 'copy', '#s': 'support' },
      ExpressionAttributeValues: { ':v': support },
    }),
  );
}

/**
 * Targeted SET of the league catalogue (leaves branding/deadline/knownClubs/adminCount
 * untouched), guarded so a concurrent admin save can't be clobbered: by default the write
 * only lands while the stored catalogue is still ABSENT or EMPTY. Returns true if written,
 * false if the guard failed (raced to populated, or the CONFIG row vanished). The CALLER
 * decides whether to attempt this based on a prior read (see seedLeaguesOnly) — this is the
 * race net, not the policy. `force` drops the empty-array half of the guard so an explicitly
 * forced repair can overwrite a present-but-empty catalogue.
 */
export async function backfillLeagues(
  tenant: string,
  leagues: League[],
  force = false,
): Promise<boolean> {
  const guard = force
    ? 'attribute_exists(pk)'
    : 'attribute_exists(pk) AND (attribute_not_exists(#l) OR size(#l) = :zero)';
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: tenantConfigKey(tenant),
        UpdateExpression: 'SET #l = :v',
        ConditionExpression: guard,
        ExpressionAttributeNames: { '#l': 'leagues' },
        ExpressionAttributeValues: force ? { ':v': leagues } : { ':v': leagues, ':zero': 0 },
      }),
    );
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * Targeted SET of the league catalogue to a caller-computed MERGED list, guarded so a
 * concurrent admin save can't be clobbered: the write only lands while the stored catalogue
 * still has exactly the size the caller read (or is absent). Returns false if the guard fired
 * (raced) — the caller re-reads and reports. The additive-merge policy lives in the caller
 * (seed-core's mergeSnapshotLeagues); this is just the race net, mirroring backfillLeagues.
 */
export async function mergeLeagues(
  tenant: string,
  leagues: League[],
  expectedCount: number,
): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: tenantConfigKey(tenant),
        UpdateExpression: 'SET #l = :v',
        ConditionExpression:
          'attribute_exists(pk) AND (attribute_not_exists(#l) OR size(#l) = :expected)',
        ExpressionAttributeNames: { '#l': 'leagues' },
        ExpressionAttributeValues: { ':v': leagues, ':expected': expectedCount },
      }),
    );
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/** The branding-only merge patch backfill-branding.ts writes. All parts optional. */
export interface BrandingMergePatch {
  /** Full caller-merged color map (existing tokens + seed tokens, seed winning). */
  colors?: Record<string, string>;
  /** Individual copy slots to SET — only these slots are touched, never the map. */
  copySlots?: Record<string, string>;
  faviconUrl?: string;
  logoUrl?: string;
}

/**
 * Targeted merge-patch of a tenant's branding (backfill-branding CLI). Uses a
 * single UpdateExpression that SETs only `branding.colors`, the named
 * `branding.copy.<slot>` paths, and (optionally) faviconUrl/logoUrl — so it
 * physically cannot clobber adminCount, clubSignupLink, leagues, deadline, or
 * admin-edited copy slots like `copy.support` (same isolation rationale as
 * updateSupportCopy above, which also documents the `branding.copy`-must-exist
 * precondition). Guarded on row existence: throws
 * ConditionalCheckFailedException for a missing tenant (caller reads first, so
 * this only fires on a delete race).
 */
export async function mergeBrandingPatch(tenant: string, patch: BrandingMergePatch): Promise<void> {
  const sets: string[] = [];
  const names: Record<string, string> = { '#b': 'branding' };
  const values: Record<string, unknown> = {};
  if (patch.colors) {
    names['#colors'] = 'colors';
    values[':colors'] = patch.colors;
    sets.push('#b.#colors = :colors');
  }
  const slots = Object.entries(patch.copySlots ?? {});
  if (slots.length > 0) names['#copy'] = 'copy';
  slots.forEach(([slot, value], i) => {
    names[`#s${i}`] = slot;
    values[`:s${i}`] = value;
    sets.push(`#b.#copy.#s${i} = :s${i}`);
  });
  if (patch.faviconUrl) {
    names['#fav'] = 'faviconUrl';
    values[':fav'] = patch.faviconUrl;
    sets.push('#b.#fav = :fav');
  }
  if (patch.logoUrl) {
    names['#logo'] = 'logoUrl';
    values[':logo'] = patch.logoUrl;
    sets.push('#b.#logo = :logo');
  }
  if (sets.length === 0) return;
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: tenantConfigKey(tenant),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

// ── Clubs ──

export async function listClubs(tenant: string): Promise<Club[]> {
  // queryAll, not a single Query: the gsi1 projects full club items (ALL), so a growing
  // cohort crosses the 1MB page cap at roughly 50–200 clubs — a single page would
  // silently truncate every count and dashboard derived from this list.
  const items = await queryAll({
    TableName: TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': clubsListGsi1pk(tenant) },
  });
  return items.map((i) => stripKeys<Club>(i)!);
}

export async function getClub(tenant: string, clubId: string): Promise<Club | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: clubKey(tenant, clubId) }));
  return stripKeys<Club>(res.Item);
}

/** Insert a new club (used by onboarding + seed). Fails if the id already exists. */
export async function createClub(tenant: string, club: Club): Promise<Club> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...clubKey(tenant, club.id),
        ...clubGsi1(tenant, club.name),
        ...club,
        version: club.version ?? 1,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
  return club;
}

/** Upsert a club (used by seed; overwrites, no version guard). */
export async function putClub(tenant: string, club: Club): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...clubKey(tenant, club.id),
        ...clubGsi1(tenant, club.name),
        ...club,
        version: club.version ?? 1,
      },
    }),
  );
}

/**
 * Apply a partial update to a club under optimistic concurrency. Reads the current
 * record, merges, and writes with a version guard — a lost race throws
 * VersionConflictError (→ 409). Always re-derives gsi1 from the (possibly new) name.
 */
export async function updateClub(
  tenant: string,
  clubId: string,
  patch: Partial<Club>,
  changedBy: string,
  changedAt: string,
): Promise<Club> {
  const current = await getClub(tenant, clubId);
  if (!current) throw new Error('club not found');
  // Honor a client-supplied expected version (true optimistic concurrency);
  // fall back to the current version for callers that don't send one.
  const expectedVersion = patch.version ?? current.version ?? 0;
  // Shallow merge: a patch key (e.g. `docMeta`) REPLACES the current value
  // wholesale, it is not deep-merged per sub-key. The client's reversible
  // "Mark as compliant" revert relies on this — it omits a doc key from the
  // docMeta it sends to remove an override. Deep-merging here would resurrect
  // those removed keys and silently break revert.
  const next: Club = {
    ...current,
    ...patch,
    id: clubId,
    version: expectedVersion + 1,
    changedBy,
    changedAt,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          ...clubKey(tenant, clubId),
          ...clubGsi1(tenant, next.name),
          ...next,
        },
        // Update of an existing row: guard strictly on version. (No
        // attribute_not_exists OR — that would resurrect a concurrently-deleted
        // row and weakens the conflict check.)
        ConditionExpression: 'version = :v',
        ExpressionAttributeValues: { ':v': expectedVersion },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new VersionConflictError();
    }
    throw err;
  }
  return next;
}

/**
 * Append a note to a club's communication log. Uses a DynamoDB `list_append`
 * UpdateExpression (not read-modify-write) so concurrent note posts compose
 * instead of clobbering each other — there is no version guard precisely so two
 * simultaneous appends both land. The version still bumps for audit/OCC of other
 * writers. Guards on row existence (handler does the 404 with a clearer message).
 *
 * Caveat: because the bump is unconditional (no `version = :v` guard), an append
 * can invalidate the OCC token of a concurrent version-guarded updateClub, handing
 * it a spurious 409. The UI mitigates this by seeding its club caches from this
 * function's ALL_NEW response right after a note add, so the next edit carries the
 * bumped version.
 */
export async function appendClubNote(
  tenant: string,
  clubId: string,
  note: { id: string; text: string; author: string; at: string },
): Promise<Club> {
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: clubKey(tenant, clubId),
      UpdateExpression:
        'SET notes = list_append(if_not_exists(notes, :empty), :new), ' +
        'version = if_not_exists(version, :zero) + :one, changedBy = :by, changedAt = :at',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: {
        ':empty': [],
        ':new': [note],
        ':zero': 0,
        ':one': 1,
        ':by': note.author,
        ':at': note.at,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return stripKeys<Club>(res.Attributes) as Club;
}

/**
 * Append real onboarding-invite send events to a club's comm log. Same `list_append`
 * strategy as appendClubNote (no version guard) so concurrent appends compose. Best
 * effort from the caller's perspective: the messages already went out before this
 * runs, so a failure here must not be treated as a send failure.
 */
export async function appendClubCommEvents(
  tenant: string,
  clubId: string,
  events: ClubCommEvent[],
): Promise<Club> {
  if (events.length === 0) return (await getClub(tenant, clubId)) as Club;
  const stampedBy = events[events.length - 1].by;
  const stampedAt = events[events.length - 1].at;
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: clubKey(tenant, clubId),
      UpdateExpression:
        'SET commLog = list_append(if_not_exists(commLog, :empty), :new), ' +
        'version = if_not_exists(version, :zero) + :one, changedBy = :by, changedAt = :at',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: {
        ':empty': [],
        ':new': events,
        ':zero': 0,
        ':one': 1,
        ':by': stampedBy,
        ':at': stampedAt,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return stripKeys<Club>(res.Attributes) as Club;
}

/** Outcome of a duplicate idempotency claim: prior results + whether the first attempt is still running. */
export interface InviteSendReplay {
  pending: boolean;
  results: SendResult[];
}

/**
 * Server-side idempotency for invite sends. Atomically claims an idempotency key by
 * writing a marker item (separate sk in the club's collection) under
 * `attribute_not_exists(pk)`. Returns:
 *   - `null` when the claim succeeds → the caller proceeds to send.
 *   - an {@link InviteSendReplay} when the key was already claimed → the caller
 *     short-circuits. `pending` is true when the first attempt hasn't completed yet
 *     (no results to replay), so the UI can say "already sending" rather than showing
 *     a silent no-op.
 * This stops a lost-response retry (or a second tab/admin) from re-sending the same
 * keyed attempt. Each fresh admin click uses a new key, so genuine retries still send.
 */
export async function claimInviteSend(
  tenant: string,
  clubId: string,
  idempotencyKey: string,
  channels: string[],
  kind: 'invite' | 'fixtures' = 'invite',
): Promise<InviteSendReplay | null> {
  const startedAt = new Date().toISOString();
  // TTL (epoch seconds): the marker only needs to outlive a lost-response retry window,
  // so let DynamoDB reap it after ~72h instead of accumulating one item per send forever.
  // (Tenant/cohort erasure still deletes any that haven't expired — see listClubInviteKeys.)
  const expiresAt = Math.floor(Date.now() / 1000) + 72 * 60 * 60;
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          ...clubInviteKey(tenant, clubId, idempotencyKey),
          // Markers for both sends share the INVITE# sk prefix (so erasure finds both);
          // `kind` keeps a fixtures marker distinguishable from an onboarding invite.
          kind,
          channels,
          status: 'in_progress',
          startedAt,
          expiresAt,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return null;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      const res = await ddb.send(
        new GetCommand({ TableName: TABLE, Key: clubInviteKey(tenant, clubId, idempotencyKey) }),
      );
      const item = res.Item as
        | { status?: string; results?: SendResult[]; kind?: string }
        | undefined;
      // The invite/fixtures markers share the INVITE# keyspace; `kind` disambiguates them.
      // A key reused across kinds must never replay the wrong send's results — refuse it.
      const priorKind = (item?.kind as 'invite' | 'fixtures') ?? 'invite';
      if (priorKind !== kind) {
        throw new Error(
          `idempotency key ${idempotencyKey} already used for a ${priorKind} send (got ${kind})`,
        );
      }
      return { pending: item?.status !== 'completed', results: item?.results ?? [] };
    }
    throw err;
  }
}

/**
 * Delete an idempotency marker so the key can be reclaimed fresh. Used when a send
 * aborts AFTER the claim but BEFORE completion (e.g. a validation 409), so the failed
 * attempt doesn't poison a legitimate retry for the full 72h TTL.
 *
 * Safe to call unconditionally: only the request that WON the `attribute_not_exists`
 * claim reaches this path. A concurrent retry on the same key lost the claim (got a
 * pending/completed replay) and never created a marker of its own, so there is no
 * sibling marker for this delete to clobber — the shared key serializes ownership.
 */
export async function releaseInviteClaim(
  tenant: string,
  clubId: string,
  idempotencyKey: string,
): Promise<void> {
  await ddb.send(
    new DeleteCommand({ TableName: TABLE, Key: clubInviteKey(tenant, clubId, idempotencyKey) }),
  );
}

/** Record the outcome on the idempotency marker so a replay returns the same results. */
export async function completeInviteSend(
  tenant: string,
  clubId: string,
  idempotencyKey: string,
  results: SendResult[],
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: clubInviteKey(tenant, clubId, idempotencyKey),
      UpdateExpression: 'SET #r = :r, #s = :done, completedAt = :at',
      ExpressionAttributeNames: { '#r': 'results', '#s': 'status' },
      ExpressionAttributeValues: {
        ':r': results,
        ':done': 'completed',
        ':at': new Date().toISOString(),
      },
    }),
  );
}

/**
 * Keys of all invite-idempotency markers for a club (sk begins `INVITE#`). These items
 * carry recipient contact in their stored results, so tenant/cohort erasure must delete
 * them too — they're not reachable via the gsi1 club listing that the erase paths use.
 */
async function listClubInviteKeys(
  tenant: string,
  clubId: string,
): Promise<Array<{ pk: string; sk: string }>> {
  const { pk } = clubKey(tenant, clubId);
  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': pk, ':s': 'INVITE#' },
    ProjectionExpression: 'pk, sk',
  });
  return items.map((i) => ({ pk: i.pk as string, sk: i.sk as string }));
}

// ── Export audit log ──

/**
 * Record one player-register export. The sk carries the ISO timestamp then a uuid,
 * so a fresh item is written per export (uuid ⇒ no collision, no condition needed)
 * and history sorts chronologically under the tenant pk.
 */
export async function putExportLog(tenant: string, entry: ExportLogEntry): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...exportLogKey(tenant, entry.at, entry.id), ...entry },
    }),
  );
}

/** Enumerate a tenant's export-log item keys (for erasure — these sit above the pk-prefix sweep). */
async function listExportLogKeys(tenant: string): Promise<Array<{ pk: string; sk: string }>> {
  const { pk, skPrefix } = exportLogsListKey(tenant);
  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': pk, ':s': skPrefix },
    ProjectionExpression: 'pk, sk',
  });
  return items.map((i) => ({ pk: i.pk as string, sk: i.sk as string }));
}

// ── Series ──

export async function listSeries(tenant: string): Promise<Series[]> {
  // Paginate: each series embeds its fixtures array, so a tenant's series can exceed a single
  // 1 MB Query page. A truncated list would silently strand dead-club references in the club-
  // removal sweep (eraseClubData), so page through every result.
  const items = await queryAll({
    TableName: TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': seriesListGsi1pk(tenant) },
  });
  return items.map((i) => stripKeys<Series>(i)!);
}

export async function getSeries(tenant: string, seriesId: string): Promise<Series | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: seriesKey(tenant, seriesId) }),
  );
  return stripKeys<Series>(res.Item);
}

export async function putSeries(tenant: string, series: Series): Promise<Series> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...seriesKey(tenant, series.id),
        ...seriesGsi1(tenant, series.startDate),
        ...series,
        version: series.version ?? 1,
      },
    }),
  );
  return series;
}

/** Version-checked replace of a series (fixtures embedded). 409 on conflict. */
export async function updateSeries(
  tenant: string,
  seriesId: string,
  patch: Partial<Series>,
): Promise<Series> {
  const current = await getSeries(tenant, seriesId);
  if (!current) throw new Error('series not found');
  const expectedVersion = (patch.version as number | undefined) ?? current.version ?? 0;
  const next: Series = {
    ...current,
    ...patch,
    id: seriesId,
    version: expectedVersion + 1,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          ...seriesKey(tenant, seriesId),
          ...seriesGsi1(tenant, next.startDate),
          ...next,
        },
        ConditionExpression: 'version = :v',
        ExpressionAttributeValues: { ':v': expectedVersion },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new VersionConflictError();
    }
    throw err;
  }
  return next;
}

export async function deleteSeries(tenant: string, seriesId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: seriesKey(tenant, seriesId) }));
}

/**
 * Strip a removed club from ONE draft series (used by eraseClubData). Re-reads the series so a
 * retry after a version conflict recomputes against the latest state (never clobbering a
 * concurrent edit). Removes the club from teams[] and drops any fixture that references it as
 * home/away, then re-opens the approval gate — same rule PATCH /series applies to a fixture edit.
 * No-op (returns false) if the series was already released or already cleaned by the time we read.
 * Released series are intentionally left alone elsewhere; this asserts it again defensively.
 * Stripping is keyed on the `home`/`away` fields only — if the fixture shape ever carries club
 * references elsewhere (e.g. a nested team pair), this filter would not catch them.
 */
async function stripClubFromDraftSeries(
  tenant: string,
  seriesId: string,
  clubId: string,
): Promise<boolean> {
  const cur = await getSeries(tenant, seriesId);
  if (!cur || cur.released === true) return false;
  // A multi-team club participates under its `tm_…` ids — strip the club's whole team
  // set (and its participant snapshot entries), not just a bare clubId.
  const mine = new Set(teamIdsForClub(cur, clubId));
  if (!cur.teams.some((t) => mine.has(t))) return false;
  const teams = cur.teams.filter((t) => !mine.has(t));
  const fixtures = (cur.fixtures as Array<{ home?: string; away?: string } | null>).filter(
    (f) => !f || (!mine.has(f.home ?? '') && !mine.has(f.away ?? '')),
  );
  const patch: Record<string, unknown> = { teams, fixtures, approved: false, approvedAt: null };
  if (Array.isArray(cur.participants)) {
    patch.participants = cur.participants.filter((p) => p.clubId !== clubId);
  }
  await updateSeries(tenant, seriesId, patch);
  return true;
}

// ── Player registrations ──

export async function listPlayers(tenant: string, clubId: string): Promise<PlayerRegistration[]> {
  const { pk, skPrefix } = playersListKey(tenant, clubId);
  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': pk, ':s': skPrefix },
  });
  return items.map((i) => stripKeys<PlayerRegistration>(i)!);
}

/**
 * The demographics projection of every player row across the given clubs — a
 * parallel per-club fan-out of the listPlayers Query, flattened. Cohorts are
 * hundreds of players and the fleet is small, so the fan-out matches the
 * existing fleet-rollup precedent (GET /platform/tenants) — revisit with a
 * bounded batch once tenants grow past a few dozen clubs.
 *
 * The ProjectionExpression is a POPIA data-minimisation measure, not an
 * optimisation: the insights endpoints only build anonymised histograms, so no
 * idNumbers/addresses/contact fields ever enter Lambda memory here. `clubId`
 * IS a stored attribute on every row (written by createPlayer), so no pk
 * parsing is needed.
 */
export async function listPlayerDemographics(
  tenant: string,
  clubIds: string[],
): Promise<Array<Pick<PlayerRegistration, 'clubId' | 'dob' | 'gender' | 'race' | 'team'>>> {
  const lists = await Promise.all(
    clubIds.map((clubId) => {
      const { pk, skPrefix } = playersListKey(tenant, clubId);
      return queryAll({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
        ProjectionExpression: '#c, #d, #g, #r, #t',
        // Alias every projected attribute (same convention as the '#s' status
        // alias in deletePlayer) so none can ever collide with a reserved word.
        ExpressionAttributeNames: {
          '#c': 'clubId',
          '#d': 'dob',
          '#g': 'gender',
          '#r': 'race',
          '#t': 'team',
        },
        ExpressionAttributeValues: { ':p': pk, ':s': skPrefix },
      });
    }),
  );
  return lists.flat() as Array<
    Pick<PlayerRegistration, 'clubId' | 'dob' | 'gender' | 'race' | 'team'>
  >;
}

/**
 * Recompute a club's denormalized `playerCount` from the source-of-truth PLAYER# rows and
 * correct any drift with an ATOMIC delta bump (`ADD playerCount :delta`) — never a whole-value
 * SET. The delta is strictly safer than a SET: a registration whose `ADD playerCount` lands
 * entirely after our `listPlayers` read composes with our bump (a SET would clobber it). It is
 * NOT perfectly exact under live traffic, though — `getClub` (reads `previous`) and
 * `listPlayers` (reads `actual`) are two separate reads, so a registration straddling that gap
 * can leave a ±1; that self-heals on any later quiescent run. Intended as an OUT-OF-BAND healer
 * (backfill-player-counts), not a live-path correction. Idempotent: a no-drift club skips the
 * write. Returns the counts so callers can report what changed.
 */
export async function reconcilePlayerCount(
  tenant: string,
  clubId: string,
): Promise<{ actual: number; previous: number; delta: number }> {
  const club = await getClub(tenant, clubId);
  if (!club) throw new Error('club not found');
  const previous = (club as { playerCount?: number }).playerCount ?? 0;
  const actual = (await listPlayers(tenant, clubId)).length;
  const delta = actual - previous;
  if (delta !== 0) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: clubKey(tenant, clubId),
        UpdateExpression: 'ADD playerCount :d',
        // Guard on the club still existing so a reconcile racing a club delete can't
        // resurrect a phantom item (same invariant createPlayer's bump protects).
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':d': delta },
      }),
    );
  }
  return { actual, previous, delta };
}

/**
 * Insert a registration (dedup on (club, naturalKey) via attribute_not_exists)
 * and atomically bump the club's denormalized `playerCount`. The count is read
 * straight off the club item on list/get, so the admin dashboard avoids an N+1
 * of COUNT queries. Throws ConditionalCheckFailedException on a duplicate.
 *
 * The two writes aren't transactional: a crash between them under-counts, but
 * `playerCount` is a display-only denormalization — the source of truth is the
 * PLAYER# items, so it's recomputable from `listPlayers` if it ever drifts.
 */
export async function createPlayer(tenant: string, player: PlayerRegistration): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...playerKey(tenant, player.clubId, player.naturalKey), ...player },
      ConditionExpression: 'attribute_not_exists(sk)',
    }),
  );
  // Only reached if the registration was new (the put above didn't throw).
  // Conditioned on the club still existing: a bare ADD UPSERTS, so an in-flight
  // registration racing an admin club delete would resurrect a phantom club item
  // (pk + playerCount only) and break the re-deletable invariant. The count is
  // display-only and recomputable, so the failed bump is swallowed; the orphaned
  // PLAYER# row is the accepted race residue (the route's getClub check bounds it).
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: clubKey(tenant, player.clubId),
        UpdateExpression: 'ADD playerCount :one',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':one': 1 },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
}

/**
 * Backfill helper (backfill-player-team): set a player's `team` league key ONLY
 * when the row has no `team` attribute at all. The `attribute_not_exists(team)`
 * guard makes overwriting a stored value impossible — orphaned keys included:
 * they are registration-time source data and re-attributing them would be a
 * separate, explicitly-consented migration. `attribute_exists(pk)` stops a
 * bare Update from resurrecting a phantom row for a concurrently-deleted
 * player. Returns false (instead of throwing) when the guard fails — the row
 * already has a team, or vanished — so the backfill can count skips cheaply.
 */
export async function setPlayerTeamIfAbsent(
  tenant: string,
  clubId: string,
  naturalKey: string,
  team: string,
): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: playerKey(tenant, clubId, naturalKey),
        UpdateExpression: 'SET #t = :t',
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#t)',
        ExpressionAttributeNames: { '#t': 'team' },
        ExpressionAttributeValues: { ':t': team },
      }),
    );
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * Hard-delete a player registration and purge its uploaded ID document (POPIA).
 *
 * The delete is conditional — the row must still exist AND not be mid-transfer
 * (`status <> 'clearance-pending'`). This closes a TOCTOU race: `createClearance`
 * atomically flips the source player to `clearance-pending` and writes a cross-club
 * mirror, so a clearance created between the route's status read and this delete would
 * otherwise leave that clearance pointing at a deleted player. On a lost race the
 * condition fails (ConditionalCheckFailedException → the route maps it to 409) and
 * nothing — including the S3 doc — is touched.
 *
 * Ordering: the conditional delete runs FIRST with `ReturnValues: 'ALL_OLD'`, then the
 * ID doc is purged from the returned attributes. Doing S3 first would delete a
 * mid-transfer player's ID doc when the race is lost; ALL_OLD keeps the objectKey
 * discoverable so the purge still happens on the success path, and a failed purge is
 * logged + recoverable via the bucket lifecycle rule (see deleteUploadObjects).
 *
 * `playerCount` is decremented only after a confirmed removal — the true inverse of
 * createPlayer's post-insert bump. The `attribute_exists(sk)` condition means a second
 * concurrent delete of the same player THROWS ConditionalCheckFailedException (the route
 * maps it to 409) before reaching the decrement, so the count can't be driven negative;
 * the `!removed` guard below is belt-and-suspenders for that already-impossible path.
 */
export async function deletePlayer(tenant: string, player: PlayerRegistration): Promise<void> {
  const res = await ddb.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: playerKey(tenant, player.clubId, player.naturalKey),
      ConditionExpression: 'attribute_exists(sk) AND #s <> :pending',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':pending': 'clearance-pending' },
      ReturnValues: 'ALL_OLD',
    }),
  );
  // A missing/already-deleted row throws ConditionalCheckFailedException above rather than
  // returning here, so in practice `removed` is always present — this is a defensive stop
  // that keeps the count untouched if that ever changes.
  const removed = res.Attributes as PlayerRegistration | undefined;
  if (!removed) return;
  // Both the row's own doc and any previous club's doc carried over by a
  // registration-origin clearance (nothing else references either).
  const objectKeys = [removed.idDocMeta?.objectKey, removed.previousIdDocMeta?.objectKey].filter(
    (k): k is string => !!k,
  );
  if (objectKeys.length) await deleteUploadObjects(objectKeys);
  // Mirror of createPlayer's count bump: display-only, recomputable, so a failed
  // decrement (club already gone) is swallowed rather than aborting the delete.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: clubKey(tenant, player.clubId),
        UpdateExpression: 'ADD playerCount :neg1',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':neg1': -1 },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
}

export async function getPlayer(
  tenant: string,
  clubId: string,
  naturalKey: string,
): Promise<PlayerRegistration | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: playerKey(tenant, clubId, naturalKey) }),
  );
  return stripKeys<PlayerRegistration>(res.Item);
}

/**
 * Every club in the tenant where this exact person (same `playerNaturalKey`) is already
 * registered, excluding one club (the destination). Used at self-registration time to route a
 * transfer to the player's REAL current club rather than the one they typed, and to stop the
 * same person being active at two clubs at once. O(clubs) point-gets in parallel; the public
 * register endpoint is token-gated + rate-limited so the fan-out is bounded. Matches on
 * naturalKey — the same key the clearance machinery addresses both rows by, so a divergent key
 * (e.g. a passport nationality respelling) won't match, exactly as a clearance couldn't anyway.
 */
export async function findPlayerAcrossClubs(
  tenant: string,
  naturalKey: string,
  excludeClubId: string,
): Promise<Array<{ clubId: string; clubName: string; status: PlayerRegistration['status'] }>> {
  const clubs = await listClubs(tenant);
  const hits = await Promise.all(
    clubs
      .filter((c) => c.id !== excludeClubId)
      .map(async (c) => {
        const p = await getPlayer(tenant, c.id, naturalKey);
        return p ? { clubId: c.id, clubName: c.name, status: p.status } : null;
      }),
  );
  return hits.filter((h): h is NonNullable<typeof h> => h !== null);
}

/**
 * Apply a partial update to a player registration under optimistic concurrency
 * (same version convention as updateClub: a client may pass an expected version;
 * legacy rows without one are treated as 0). Used by the ID-doc mark and roster
 * edits. A lost race throws VersionConflictError (→ 409).
 */
export async function updatePlayer(
  tenant: string,
  clubId: string,
  naturalKey: string,
  patch: Partial<PlayerRegistration>,
): Promise<PlayerRegistration> {
  const current = await getPlayer(tenant, clubId, naturalKey);
  if (!current) throw new Error('player not found');
  const expectedVersion = patch.version ?? current.version ?? 0;
  const next: PlayerRegistration = {
    ...current,
    ...patch,
    naturalKey,
    clubId,
    version: expectedVersion + 1,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { ...playerKey(tenant, clubId, naturalKey), ...next },
        ConditionExpression:
          'attribute_exists(sk) AND (version = :v OR attribute_not_exists(version))',
        ExpressionAttributeValues: { ':v': expectedVersion },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new VersionConflictError();
    }
    throw err;
  }
  return next;
}

// ── Player clearances (inter-club transfers) ──

/** Strip the gsi1 keys but keep nothing else removed — clearance has no extra system fields. */
export async function getClearance(
  tenant: string,
  fromClubId: string,
  id: string,
): Promise<PlayerClearance | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: clearanceKey(tenant, fromClubId, id) }),
  );
  return stripKeys<PlayerClearance>(res.Item);
}

/** Clearances a club must action (it is the source/current club). */
export async function listClearancesForSource(
  tenant: string,
  clubId: string,
): Promise<PlayerClearance[]> {
  const { pk, skPrefix } = clearancesListKey(tenant, clubId);
  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': pk, ':s': skPrefix },
  });
  return items.map((i) => stripKeys<PlayerClearance>(i)!);
}

/** Clearances incoming to a club (it is the destination) — read from its own mirror items. */
export async function listInboundForDest(
  tenant: string,
  clubId: string,
): Promise<PlayerClearance[]> {
  const { pk, skPrefix } = inboundClearancesListKey(tenant, clubId);
  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': pk, ':s': skPrefix },
  });
  return items.map((i) => stripKeys<PlayerClearance>(i)!);
}

/**
 * Every clearance in the tenant (admin console) — one row per request via the gsi1.
 * queryAll so a season's worth of requests can't silently truncate at the 1MB page.
 */
export async function listAllClearances(tenant: string): Promise<PlayerClearance[]> {
  const items = await queryAll({
    TableName: TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': clearancesListGsi1pk(tenant) },
  });
  return items.map((i) => stripKeys<PlayerClearance>(i)!);
}

/** The canonical (source) + mirror (destination) put items for a clearance. */
function clearanceItems(tenant: string, c: PlayerClearance) {
  return {
    canonical: {
      ...clearanceKey(tenant, c.fromClubId, c.id),
      ...clearanceGsi1(tenant, c.requestedAt),
      ...c,
    },
    mirror: {
      ...inboundClearanceKey(tenant, c.toClubId, c.id),
      ...c,
    },
  };
}

/**
 * Create a pending clearance: write the canonical (source) + mirror (destination)
 * items and flip the player's status to 'clearance-pending', atomically.
 *
 * The player-status update is the RACE-SAFE dedup guard: `#s <> :pending` makes the
 * write fail if the player already has a pending clearance, so two concurrent creates
 * for the same player can't both succeed (the handler's prior `listClearancesForSource`
 * check is only a friendly fast-path, not the invariant). A failed guard surfaces as
 * {@link DuplicatePendingClearanceError} (→ 409). The canonical put's attribute_not_exists
 * additionally stops a replayed id from double-writing.
 *
 * The dynalite (offline/test) path has no TransactWriteItems → sequential fallback. There
 * the GUARD MUST RUN FIRST so a duplicate aborts before any clearance item is written
 * (otherwise a rejected create would orphan the canonical/mirror pair). Production uses
 * the all-or-nothing transaction, where ordering is irrelevant.
 */
export async function createClearance(tenant: string, c: PlayerClearance): Promise<void> {
  const { canonical, mirror } = clearanceItems(tenant, c);
  const playerStatusUpdate = {
    TableName: TABLE,
    Key: playerKey(tenant, c.fromClubId, c.playerNaturalKey),
    UpdateExpression: 'SET #s = :pending ADD version :one',
    ConditionExpression: 'attribute_exists(sk) AND #s <> :pending',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':pending': 'clearance-pending', ':one': 1 },
  };
  try {
    if (localEndpoint) {
      // No ConditionCheck outside a transaction, so a plain existence read substitutes
      // for the destination-club guard (TOCTOU-wide, but this path is offline/test
      // only). It must run FIRST so a rejected create mutates nothing — not even the
      // player's status flip.
      if (!(await getClub(tenant, c.toClubId))) throw new DestinationClubGoneError();
      // Guard FIRST (see doc): a duplicate fails here before any clearance item lands.
      await ddb.send(new UpdateCommand(playerStatusUpdate));
      await ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: canonical,
          ConditionExpression: 'attribute_not_exists(sk)',
        }),
      );
      await ddb.send(new PutCommand({ TableName: TABLE, Item: mirror }));
      return;
    }
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            // A clearance must never be created INTO a club mid-delete: the orphaned
            // mirror would permanently strand the source player as 'clearance-pending'
            // (this very dedup guard would block any retry). Checking the destination
            // club key here aborts the whole create instead.
            ConditionCheck: {
              TableName: TABLE,
              Key: clubKey(tenant, c.toClubId),
              ConditionExpression: 'attribute_exists(pk)',
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: canonical,
              ConditionExpression: 'attribute_not_exists(sk)',
            },
          },
          { Put: { TableName: TABLE, Item: mirror } },
          { Update: playerStatusUpdate },
        ],
      }),
    );
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === 'TransactionCanceledException') {
      // CancellationReasons line up with TransactItems: index 0 is the destination
      // club's existence check — its failure means the club is mid-delete, not a
      // duplicate request. Any other conditional failure keeps the duplicate mapping.
      const reasons = (err as { CancellationReasons?: Array<{ Code?: string }> })
        .CancellationReasons;
      if (reasons?.[0]?.Code === 'ConditionalCheckFailed') throw new DestinationClubGoneError();
      throw new DuplicatePendingClearanceError();
    }
    if (name === 'ConditionalCheckFailedException') {
      throw new DuplicatePendingClearanceError();
    }
    throw err;
  }
}

/**
 * Public-registration variant of createClearance: the player registered directly with
 * the DESTINATION club while naming a previous club, so the destination row is created
 * up-front (status 'clearance-pending', self-asserted data) in the same atomic write
 * that opens the clearance and flips the SOURCE player to 'clearance-pending'.
 * Approval activates that row in place (resolveClearance's registration-origin branch)
 * instead of copying the source record; rejection deletes it.
 *
 * Guards mirror createClearance: the destination-club existence check (a create INTO a
 * mid-delete club must abort whole), attribute_not_exists on the dest player row (the
 * same (club, naturalKey) dedup plain registration has), and the source status flip as
 * the race-safe duplicate-clearance guard. The dest `playerCount` is bumped once, HERE
 * (same swallowed post-write style as createPlayer) — resolveClearance deliberately
 * skips its increment for registration-origin clearances.
 */
export async function createPlayerWithClearance(
  tenant: string,
  player: PlayerRegistration,
  c: PlayerClearance,
): Promise<void> {
  const { canonical, mirror } = clearanceItems(tenant, c);
  const destPlayerPut = {
    TableName: TABLE,
    Item: { ...playerKey(tenant, c.toClubId, player.naturalKey), ...player },
    ConditionExpression: 'attribute_not_exists(sk)',
  };
  const canonicalPut = {
    TableName: TABLE,
    Item: canonical,
    ConditionExpression: 'attribute_not_exists(sk)',
  };
  const sourceStatusUpdate = {
    TableName: TABLE,
    Key: playerKey(tenant, c.fromClubId, c.playerNaturalKey),
    UpdateExpression: 'SET #s = :pending ADD version :one',
    ConditionExpression: 'attribute_exists(sk) AND #s <> :pending',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':pending': 'clearance-pending', ':one': 1 },
  };
  try {
    if (localEndpoint) {
      // Sequential fallback (no TransactWriteItems offline). Mutate nothing on a
      // rejected create: existence pre-reads first (TOCTOU-wide, offline/test only),
      // then the duplicate-clearance guard; a dest-put failure rolls the flip back.
      if (!(await getClub(tenant, c.toClubId))) throw new DestinationClubGoneError();
      if (await getPlayer(tenant, c.toClubId, player.naturalKey)) {
        throw new PlayerExistsAtDestinationError();
      }
      await ddb.send(new UpdateCommand(sourceStatusUpdate));
      try {
        await ddb.send(new PutCommand(destPlayerPut));
      } catch (err: unknown) {
        // Roll the source flip back so a lost dedup race leaves the player untouched.
        await ddb.send(
          new UpdateCommand({
            TableName: TABLE,
            Key: playerKey(tenant, c.fromClubId, c.playerNaturalKey),
            UpdateExpression: 'SET #s = :active',
            ConditionExpression: '#s = :pending',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':active': 'active', ':pending': 'clearance-pending' },
          }),
        );
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
          throw new PlayerExistsAtDestinationError();
        }
        throw err;
      }
      await ddb.send(new PutCommand(canonicalPut));
      await ddb.send(new PutCommand({ TableName: TABLE, Item: mirror }));
    } else {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              // Same rationale as createClearance: never create INTO a club mid-delete.
              ConditionCheck: {
                TableName: TABLE,
                Key: clubKey(tenant, c.toClubId),
                ConditionExpression: 'attribute_exists(pk)',
              },
            },
            { Put: destPlayerPut },
            { Put: canonicalPut },
            { Put: { TableName: TABLE, Item: mirror } },
            { Update: sourceStatusUpdate },
          ],
        }),
      );
    }
  } catch (err: unknown) {
    if (err instanceof DestinationClubGoneError || err instanceof PlayerExistsAtDestinationError) {
      throw err;
    }
    const name = (err as { name?: string }).name;
    if (name === 'TransactionCanceledException') {
      // CancellationReasons line up with TransactItems: [0] dest club gone,
      // [1] player already at destination, anything else → duplicate clearance.
      const reasons = (err as { CancellationReasons?: Array<{ Code?: string }> })
        .CancellationReasons;
      if (reasons?.[0]?.Code === 'ConditionalCheckFailed') throw new DestinationClubGoneError();
      if (reasons?.[1]?.Code === 'ConditionalCheckFailed') {
        throw new PlayerExistsAtDestinationError();
      }
      throw new DuplicatePendingClearanceError();
    }
    if (name === 'ConditionalCheckFailedException') {
      throw new DuplicatePendingClearanceError();
    }
    throw err;
  }
  // Mirror of createPlayer's post-insert bump: display-only, recomputable, swallowed
  // when the club vanished mid-flight (a bare ADD would resurrect a phantom club).
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: clubKey(tenant, c.toClubId),
        UpdateExpression: 'ADD playerCount :one',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':one': 1 },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
}

/**
 * Toggle the source club's fees/misconduct confirmations on a still-pending clearance.
 * Version-guarded (OCC); touches only the canonical item — the mirror tracks `status`,
 * which doesn't change until approval. A lost race throws VersionConflictError (→ 409).
 */
export async function updateClearanceFlags(
  tenant: string,
  fromClubId: string,
  id: string,
  patch: { feesCleared?: boolean; misconductCleared?: boolean; expectedVersion?: number },
): Promise<PlayerClearance> {
  const current = await getClearance(tenant, fromClubId, id);
  if (!current) throw new Error('clearance not found');
  const expectedVersion = patch.expectedVersion ?? current.version ?? 0;
  const next: PlayerClearance = {
    ...current,
    feesCleared: patch.feesCleared ?? current.feesCleared,
    misconductCleared: patch.misconductCleared ?? current.misconductCleared,
    version: expectedVersion + 1,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          ...clearanceKey(tenant, fromClubId, id),
          ...clearanceGsi1(tenant, next.requestedAt),
          ...next,
        },
        ConditionExpression: 'version = :v',
        ExpressionAttributeValues: { ':v': expectedVersion },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new VersionConflictError();
    }
    throw err;
  }
  return next;
}

/** Raised when a clearance move can't run because the player already exists at the destination. */
export class PlayerExistsAtDestinationError extends Error {
  constructor() {
    super('player already registered at destination club');
    this.name = 'PlayerExistsAtDestinationError';
  }
}

/** Raised when a clearance create races another for the same player (already pending). */
export class DuplicatePendingClearanceError extends Error {
  constructor() {
    super('a clearance request for this player is already pending');
    this.name = 'DuplicatePendingClearanceError';
  }
}

/**
 * Raised when a clearance write's DESTINATION club no longer exists (deleted
 * mid-flight). Failing the WHOLE write is the correct behavior: a mirror or moved
 * player landing in a deleted partition would be orphaned residue, and a pending
 * mirror in particular would permanently strand the source player as
 * 'clearance-pending' (createClearance's dedup guard blocks any retry). Handlers
 * map this to HTTP 409.
 */
export class DestinationClubGoneError extends Error {
  constructor() {
    super('destination club no longer exists');
    this.name = 'DestinationClubGoneError';
  }
}

/**
 * Resolve a clearance (club approval or admin override) and MOVE the player from the
 * source club to the destination, atomically:
 *   put player at destination (guarded attribute_not_exists) · delete player at source ·
 *   playerCount -1 source / +1 destination · canonical clearance status · mirror status.
 *
 * The destination put guard rejects the whole move when the player already has a
 * registration there (a returning player), surfaced as PlayerExistsAtDestinationError
 * (→ 409) — the clearance stays pending rather than half-applying. The canonical
 * clearance is version-guarded so a double approve/override can't run twice.
 *
 * REGISTRATION-ORIGIN clearances (origin: 'registration') invert the data flow: the
 * destination row already exists (created pending by the public registration, with the
 * player's own fresh data as source of truth), so instead of copying the source record
 * this branch ACTIVATES the destination row in place and skips the dest playerCount
 * increment (counted at registration). The source club's vetted ID doc is carried onto
 * the activated row as `previousIdDocMeta` — deliberately NOT purged from S3, since the
 * destination data is self-asserted and the source doc is the only surviving evidence
 * of the original identity if the transfer is later disputed.
 *
 * dynalite (offline/test) has no TransactWriteItems → sequential fallback in the same
 * order, with the same destination guard. Production uses the transaction.
 */
export async function resolveClearance(
  tenant: string,
  fromClubId: string,
  id: string,
  opts: { mode: 'club' | 'admin'; at: string; expectedVersion?: number },
): Promise<PlayerClearance> {
  const current = await getClearance(tenant, fromClubId, id);
  if (!current) throw new Error('clearance not found');
  const player = await getPlayer(tenant, fromClubId, current.playerNaturalKey);
  if (!player) throw new Error('player not found for clearance');

  const expectedVersion = opts.expectedVersion ?? current.version ?? 0;
  const status: PlayerClearance['status'] = opts.mode === 'admin' ? 'admin-override' : 'approved';
  const next: PlayerClearance = {
    ...current,
    status,
    feesCleared: opts.mode === 'admin' ? current.feesCleared : true,
    misconductCleared: opts.mode === 'admin' ? current.misconductCleared : true,
    clubApprovedAt: opts.mode === 'club' ? opts.at : (current.clubApprovedAt ?? null),
    adminOverrideAt: opts.mode === 'admin' ? opts.at : (current.adminOverrideAt ?? null),
    version: expectedVersion + 1,
  };

  const isRegistrationOrigin = current.origin === 'registration';

  const movedPlayer: PlayerRegistration = {
    ...player,
    clubId: current.toClubId,
    status: 'active',
    // Never carry a stale clearance-rejected flag onto the new club: a player rejected at
    // their previous club can later be transferred out cleanly (removeUndefinedValues drops
    // these before the put).
    clearanceRejectedAt: undefined,
    clearanceRejectedReason: undefined,
    version: (player.version ?? 0) + 1,
  };
  const { canonical, mirror } = clearanceItems(tenant, next);

  // Registration-origin: activate the pre-created destination row in place. The
  // status condition doubles as the race guard — a row that is no longer pending
  // (resolved/rejected concurrently) cancels the whole resolve.
  const carriedDoc = player.idDocMeta;
  const destActivate = {
    TableName: TABLE,
    Key: playerKey(tenant, current.toClubId, player.naturalKey),
    // REMOVE also scrubs any clearance-rejected flag (a no-op on a normal pending row) so a
    // player who was rejected and later cleared doesn't keep a stale warning.
    UpdateExpression: carriedDoc
      ? 'SET #s = :active, previousIdDocMeta = :doc ADD version :one REMOVE clearanceRejectedAt, clearanceRejectedReason'
      : 'SET #s = :active ADD version :one REMOVE clearanceRejectedAt, clearanceRejectedReason',
    ConditionExpression: 'attribute_exists(sk) AND #s = :pending',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':active': 'active',
      ':pending': 'clearance-pending',
      ':one': 1,
      ...(carriedDoc ? { ':doc': carriedDoc } : {}),
    },
  };

  const destPut = {
    TableName: TABLE,
    Item: { ...playerKey(tenant, current.toClubId, player.naturalKey), ...movedPlayer },
    ConditionExpression: 'attribute_not_exists(sk)',
  };
  const sourceDelete = {
    TableName: TABLE,
    Key: playerKey(tenant, fromClubId, player.naturalKey),
  };
  const sourceCount = {
    TableName: TABLE,
    Key: clubKey(tenant, fromClubId),
    UpdateExpression: 'ADD playerCount :neg',
    ExpressionAttributeValues: { ':neg': -1 },
  };
  const destCount = {
    TableName: TABLE,
    Key: clubKey(tenant, current.toClubId),
    UpdateExpression: 'ADD playerCount :one',
    // A bare ADD UPSERTS, so a transfer racing an admin club delete would resurrect a
    // phantom destination club item. Inside the transaction this condition doubles as
    // the destination-existence guard: a club deleted mid-move cancels the WHOLE move
    // (correct — the player must not land in a deleted partition). A separate
    // ConditionCheck can't carry this (one operation per item per transaction).
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':one': 1 },
  };
  const canonicalPut = {
    TableName: TABLE,
    Item: canonical,
    ConditionExpression: 'version = :v',
    ExpressionAttributeValues: { ':v': expectedVersion },
  };
  const mirrorPut = { TableName: TABLE, Item: mirror };

  if (localEndpoint && isRegistrationOrigin) {
    // Offline registration-origin: the canonical's version guard is the race
    // protection, so it runs FIRST — a lost race throws with nothing mutated.
    try {
      await ddb.send(new PutCommand(canonicalPut));
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        throw new VersionConflictError();
      }
      throw err;
    }
    try {
      await ddb.send(new UpdateCommand(destActivate));
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        // Dest row vanished / no longer pending: restore the canonical so the
        // clearance doesn't read as approved without the player ever activating.
        await ddb.send(
          new PutCommand({
            TableName: TABLE,
            Item: {
              ...clearanceKey(tenant, fromClubId, id),
              ...clearanceGsi1(tenant, current.requestedAt),
              ...current,
            },
          }),
        );
        throw new VersionConflictError();
      }
      throw err;
    }
    await ddb.send(new DeleteCommand(sourceDelete));
    await ddb.send(new UpdateCommand(sourceCount));
    await ddb.send(new PutCommand(mirrorPut));
    return next;
  }

  if (localEndpoint) {
    // Offline: enforce the destination collision guard FIRST so a returning player
    // aborts before anything is mutated, then apply the rest sequentially.
    try {
      await ddb.send(new PutCommand(destPut));
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        throw new PlayerExistsAtDestinationError();
      }
      throw err;
    }
    try {
      await ddb.send(new PutCommand(canonicalPut));
    } catch (err: unknown) {
      // Roll back the dest put so a lost OCC race doesn't leave the player in both clubs.
      await ddb.send(
        new DeleteCommand({
          TableName: TABLE,
          Key: playerKey(tenant, current.toClubId, player.naturalKey),
        }),
      );
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        throw new VersionConflictError();
      }
      throw err;
    }
    await ddb.send(new DeleteCommand(sourceDelete));
    await ddb.send(new UpdateCommand(sourceCount));
    // Offline the conditioned bump runs AFTER the move already landed, so a deleted
    // destination can only be swallowed here (the count is display-only); production's
    // transaction aborts the whole move instead.
    try {
      await ddb.send(new UpdateCommand(destCount));
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    }
    await ddb.send(new PutCommand(mirrorPut));
    return next;
  }

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: isRegistrationOrigin
          ? [
              // Activate the pre-created dest row in place; the dest count was bumped
              // at registration, so no destCount here (double-increment otherwise).
              { Update: destActivate },
              { Delete: sourceDelete },
              { Update: sourceCount },
              { Put: canonicalPut },
              { Put: mirrorPut },
            ]
          : [
              { Put: destPut },
              { Delete: sourceDelete },
              { Update: sourceCount },
              { Update: destCount },
              { Put: canonicalPut },
              { Put: mirrorPut },
            ],
      }),
    );
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException') {
      if (isRegistrationOrigin) {
        // Only two conditions exist in this branch: the canonical version guard and
        // the dest row's still-pending guard. Both mean "someone resolved/rejected
        // this first" — a refetch tells the caller the outcome. (A dest player being
        // present is the EXPECTED state here, so the collision re-read below would
        // misdiagnose; skip it.)
        throw new VersionConflictError();
      }
      // Either the destination guard (player already there) or the version guard (raced)
      // failed. Best-effort disambiguation by re-reading the destination: a present player
      // is reported as a collision. Note this can't perfectly distinguish a genuine version
      // race that a CONCURRENT successful resolve just won (which also lands the player at
      // the destination) — that edge is mislabelled as a collision. Both map to HTTP 409, so
      // only the message differs; the caller is told to refetch either way.
      const atDest = await getPlayer(tenant, current.toClubId, player.naturalKey);
      if (atDest) throw new PlayerExistsAtDestinationError();
      // Third possibility since destCount gained its existence condition: the
      // destination club was deleted mid-move and the transaction (correctly)
      // refused to land the player in its partition.
      if (!(await getClub(tenant, current.toClubId))) throw new DestinationClubGoneError();
      throw new VersionConflictError();
    }
    throw err;
  }
  return next;
}

/**
 * Reject a pending clearance (union admin, on the clubs' behalf): flip the canonical +
 * mirror to 'rejected', atomically.
 *
 * NON-registration (rep-initiated) clearances: the SOURCE player is returned to 'active'
 * (no destination row exists pre-approval).
 *
 * REGISTRATION-origin clearances: the player STAYS on the destination (current) club's
 * roster — the pre-created destination row is flipped 'clearance-pending' →
 * 'clearance-rejected' with the reject reason/date copied onto it (its self-asserted ID
 * doc is RETAINED) — and the SOURCE (previous) club row is DELETED, its playerCount
 * decremented and its ID docs purged from S3 (POPIA). The destination count is left alone
 * (the row was counted at registration and survives).
 *
 * The canonical's version guard is the OCC race protection (double reject, or reject
 * racing an approve, → VersionConflictError → 409 refetch). Every player write is
 * status-guarded (#s = 'clearance-pending') so a lost race can't clobber a row the
 * clearance no longer holds. The source item gets EITHER a reactivate (non-registration)
 * OR a delete (registration) — never both, which one TransactWriteItems would reject.
 *
 * dynalite (offline/test) sequential fallback: canonical FIRST (a lost race mutates
 * nothing), then mirror, then the guarded player writes with conditional failures
 * swallowed (same tolerance as eraseClubData's unstick).
 */
export async function rejectClearance(
  tenant: string,
  fromClubId: string,
  id: string,
  opts: { at: string; by: string; reason?: string; expectedVersion?: number },
): Promise<PlayerClearance> {
  const current = await getClearance(tenant, fromClubId, id);
  if (!current) throw new Error('clearance not found');
  const expectedVersion = opts.expectedVersion ?? current.version ?? 0;
  const next: PlayerClearance = {
    ...current,
    status: 'rejected',
    rejectedAt: opts.at,
    rejectedBy: opts.by,
    ...(opts.reason ? { rejectReason: opts.reason } : {}),
    version: expectedVersion + 1,
  };
  const isRegistrationOrigin = current.origin === 'registration';
  // Capture the SOURCE (previous club) row up-front: it is deleted below, after which its
  // ID-doc objectKeys are unrecoverable and the S3 purge needs them. A long-lived source
  // row may carry BOTH a self-asserted idDocMeta and a vetted previousIdDocMeta.
  const sourcePending = isRegistrationOrigin
    ? await getPlayer(tenant, fromClubId, current.playerNaturalKey)
    : null;

  const { canonical, mirror } = clearanceItems(tenant, next);
  const canonicalPut = {
    TableName: TABLE,
    Item: canonical,
    ConditionExpression: 'version = :v',
    ExpressionAttributeValues: { ':v': expectedVersion },
  };
  const mirrorPut = { TableName: TABLE, Item: mirror };
  // Non-registration: restore the source player to active.
  const sourceReactivate = {
    TableName: TABLE,
    Key: playerKey(tenant, fromClubId, current.playerNaturalKey),
    UpdateExpression: 'SET #s = :active ADD version :one',
    ConditionExpression: 'attribute_exists(sk) AND #s = :pending',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':active': 'active',
      ':pending': 'clearance-pending',
      ':one': 1,
    },
  };
  // Registration-origin: flag the destination (current club) row as clearance-rejected in
  // place (kept on the roster), copying the reject reason/date onto it.
  const destRejectValues: Record<string, unknown> = {
    ':rejected': 'clearance-rejected',
    ':pending': 'clearance-pending',
    ':at': opts.at,
    ':one': 1,
  };
  let destRejectSet = 'SET #s = :rejected, clearanceRejectedAt = :at';
  if (opts.reason) {
    destRejectSet += ', clearanceRejectedReason = :reason';
    destRejectValues[':reason'] = opts.reason;
  }
  const destReject = {
    TableName: TABLE,
    Key: playerKey(tenant, current.toClubId, current.playerNaturalKey),
    UpdateExpression: `${destRejectSet} ADD version :one`,
    ConditionExpression: 'attribute_exists(sk) AND #s = :pending',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: destRejectValues,
  };
  // Registration-origin: delete the source (previous club) row — the player has moved.
  const sourceDelete = {
    TableName: TABLE,
    Key: playerKey(tenant, fromClubId, current.playerNaturalKey),
    ConditionExpression: 'attribute_exists(sk) AND #s = :pending',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':pending': 'clearance-pending' },
  };

  if (localEndpoint) {
    try {
      await ddb.send(new PutCommand(canonicalPut));
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        throw new VersionConflictError();
      }
      throw err;
    }
    await ddb.send(new PutCommand(mirrorPut));
    if (isRegistrationOrigin) {
      try {
        await ddb.send(new UpdateCommand(destReject));
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      }
      try {
        await ddb.send(new DeleteCommand(sourceDelete));
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      }
    } else {
      try {
        await ddb.send(new UpdateCommand(sourceReactivate));
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      }
    }
  } else {
    const items: NonNullable<
      ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
    > = [{ Put: canonicalPut }, { Put: mirrorPut }];
    // The source item gets a reactivate OR a delete — never both (registration-origin
    // keeps the destination and deletes the source; otherwise just restore the source).
    if (isRegistrationOrigin) {
      items.push({ Update: destReject }, { Delete: sourceDelete });
    } else {
      items.push({ Update: sourceReactivate });
    }
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (err: unknown) {
      const name = (err as { name?: string }).name;
      if (name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException') {
        throw new VersionConflictError();
      }
      throw err;
    }
  }

  if (isRegistrationOrigin) {
    // The SOURCE row is gone — decrement the SOURCE club's count. Display-only, swallowed
    // on a vanished club (a bare ADD would resurrect a phantom club item). The destination
    // count is untouched: that row was counted at registration and survives.
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: clubKey(tenant, fromClubId),
          UpdateExpression: 'ADD playerCount :neg1',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':neg1': -1 },
        }),
      );
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    }
    // Purge BOTH of the deleted source row's S3 objects (self-asserted + any vetted
    // previous-club doc it carried from an earlier approved transfer).
    await deleteUploadObjects(
      [sourcePending?.idDocMeta?.objectKey, sourcePending?.previousIdDocMeta?.objectKey].filter(
        (k): k is string => !!k,
      ),
    );
  }
  return next;
}

// ── Registration reviews (off-system alerts) ──

/** The single canonical put item for a review (destination-club partition + gsi1). */
function reviewItem(tenant: string, r: RegistrationReview) {
  return {
    ...registrationReviewKey(tenant, r.destClubId, r.id),
    ...registrationReviewGsi1(tenant, r.createdAt),
    ...r,
  };
}

/** Create a registration review (dedup on the id via attribute_not_exists). */
export async function createRegistrationReview(
  tenant: string,
  r: RegistrationReview,
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: reviewItem(tenant, r),
      ConditionExpression: 'attribute_not_exists(sk)',
    }),
  );
}

export async function getRegistrationReview(
  tenant: string,
  destClubId: string,
  id: string,
): Promise<RegistrationReview | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: registrationReviewKey(tenant, destClubId, id) }),
  );
  return stripKeys<RegistrationReview>(res.Item);
}

/** A club's own registration reviews (it is the destination). */
export async function listReviewsForClub(
  tenant: string,
  destClubId: string,
): Promise<RegistrationReview[]> {
  const { pk, skPrefix } = registrationReviewsListKey(tenant, destClubId);
  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': pk, ':s': skPrefix },
  });
  return items.map((i) => stripKeys<RegistrationReview>(i)!);
}

/**
 * Every registration review in the tenant (admin console) — one row each via the gsi1.
 * queryAll so a season's worth can't silently truncate at the 1MB page.
 */
export async function listAllReviews(tenant: string): Promise<RegistrationReview[]> {
  const items = await queryAll({
    TableName: TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': registrationReviewsListGsi1pk(tenant) },
  });
  return items.map((i) => stripKeys<RegistrationReview>(i)!);
}

/**
 * Flip an open review to 'resolved' with the given resolution, version-guarded. Also
 * REMOVEs any parked `pendingPlayer`/`pendingLastClubId` (a no-op for off-system alerts,
 * which never carry them) so a resolved review keeps no self-asserted PII. The
 * `version = :v AND status = 'open'` guard is the mutual-exclusion: a double-action loses →
 * VersionConflictError → 409 refetch.
 */
export async function resolveReview(
  tenant: string,
  destClubId: string,
  id: string,
  opts: {
    resolution: RegistrationReviewResolution;
    at: string;
    by: string;
    expectedVersion?: number;
  },
): Promise<RegistrationReview> {
  const current = await getRegistrationReview(tenant, destClubId, id);
  if (!current) throw new Error('registration review not found');
  const expectedVersion = opts.expectedVersion ?? current.version ?? 0;
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: registrationReviewKey(tenant, destClubId, id),
        UpdateExpression:
          'SET #st = :resolved, resolution = :res, resolvedAt = :at, resolvedBy = :by, version = :nv REMOVE pendingPlayer, pendingLastClubId',
        ConditionExpression: 'attribute_exists(sk) AND version = :v AND #st = :open',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':resolved': 'resolved',
          ':res': opts.resolution,
          ':at': opts.at,
          ':by': opts.by,
          ':nv': expectedVersion + 1,
          ':v': expectedVersion,
          ':open': 'open',
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return stripKeys<RegistrationReview>(res.Attributes)!;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new VersionConflictError();
    }
    throw err;
  }
}

// ── Registration tokens (global, self-describing) ──

/**
 * Two token shapes share the TOKEN# keyspace: player reg-links carry a `clubId`
 * (no `kind`), club signup links carry `kind: 'club-signup'` (no clubId). Each
 * consumer checks the field it requires, so neither token works on the other's
 * endpoints.
 */
export async function getToken(
  token: string,
): Promise<{ tenant: string; clubId?: string; kind?: 'club-signup'; createdAt: string } | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: tokenKey(token) }));
  return stripKeys(res.Item);
}

export async function putToken(
  token: string,
  tenant: string,
  clubId: string,
  createdAt: string,
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...tokenKey(token), tenant, clubId, createdAt },
    }),
  );
}

/** Store a tenant-wide club self-signup token (kind-tagged, no clubId). */
export async function putSignupToken(
  token: string,
  tenant: string,
  createdAt: string,
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...tokenKey(token), tenant, kind: 'club-signup', createdAt },
    }),
  );
}

/** Revoke a token so a regenerated reg-link invalidates the previous one. */
export async function deleteToken(token: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: tokenKey(token) }));
}

const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

/**
 * Hourly signup rate cap, kept on the TOKEN# item itself (no extra row to revoke).
 * Returns whether this signup is allowed. Two conditional updates, no read:
 *   1. start a fresh window (count = 1) when none exists or the current one aged out;
 *   2. otherwise increment under `signupCount < limit`.
 * Both writes are condition-guarded so concurrent requests can't blow past the cap
 * mid-window. At a window boundary two racers can both "win" the reset (the second
 * overwrites count back to 1) — that under-counts by the race width, which only ever
 * ADMITS a request the cap might have refused; it never blocks a legitimate one.
 * `attribute_exists(pk)` in step 1 (and the attribute reads in step 2) make a revoked
 * token fail both conditions → false. The caller surfaces false as a 429, so a token
 * revoked between route validation and this bump reads as "try later" rather than
 * "link dead" — a one-request-wide race, denied either way; the next attempt 404s
 * at validation.
 */
export async function bumpSignupTokenCounter(
  token: string,
  nowIso: string,
  limit: number,
): Promise<boolean> {
  const cutoff = new Date(new Date(nowIso).getTime() - SIGNUP_WINDOW_MS).toISOString();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: tokenKey(token),
        UpdateExpression: 'SET signupWindowStart = :now, signupCount = :one',
        ConditionExpression:
          'attribute_exists(pk) AND (attribute_not_exists(signupWindowStart) OR signupWindowStart < :cutoff)',
        ExpressionAttributeValues: { ':now': nowIso, ':one': 1, ':cutoff': cutoff },
      }),
    );
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: tokenKey(token),
        UpdateExpression: 'SET signupCount = signupCount + :one',
        ConditionExpression: 'signupWindowStart >= :cutoff AND signupCount < :limit',
        ExpressionAttributeValues: { ':one': 1, ':cutoff': cutoff, ':limit': limit },
      }),
    );
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * Per-destination-club hourly cap on inbound cross-club self-registrations. Where the
 * token counter throttles a single link, this throttles a single VICTIM club regardless
 * of which (or how many) links an attacker holds — so a leaked link can't be used to
 * spam another club's roster past this cap. The counter rides on the club META item
 * (definitely-exists, validated by the route just before, and swept with the club on
 * erasure) under `inboundReg*` attributes, using the same two-step window/increment race
 * discipline as bumpSignupTokenCounter: a window-boundary race only ever ADMITS a request
 * the cap might have refused, never blocks a legitimate one.
 */
export async function bumpClubInboundCounter(
  tenant: string,
  clubId: string,
  nowIso: string,
  limit: number,
): Promise<boolean> {
  const cutoff = new Date(new Date(nowIso).getTime() - SIGNUP_WINDOW_MS).toISOString();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: clubKey(tenant, clubId),
        UpdateExpression: 'SET inboundRegWindowStart = :now, inboundRegCount = :one',
        ConditionExpression:
          'attribute_exists(pk) AND (attribute_not_exists(inboundRegWindowStart) OR inboundRegWindowStart < :cutoff)',
        ExpressionAttributeValues: { ':now': nowIso, ':one': 1, ':cutoff': cutoff },
      }),
    );
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: clubKey(tenant, clubId),
        UpdateExpression: 'SET inboundRegCount = inboundRegCount + :one',
        ConditionExpression: 'inboundRegWindowStart >= :cutoff AND inboundRegCount < :limit',
        ExpressionAttributeValues: { ':one': 1, ':cutoff': cutoff, ':limit': limit },
      }),
    );
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * SET or REMOVE the tenant's club-signup-link pointer via a targeted UpdateExpression
 * (modeled on updateSupportCopy) — never a whole-config read-modify-write, so a
 * concurrent Settings save can't clobber it (TenantConfig has no version guard).
 * Throws ConditionalCheckFailedException when the CONFIG row doesn't exist.
 */
export async function updateClubSignupLink(
  tenant: string,
  link: { token: string; createdAt: string } | null,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: tenantConfigKey(tenant),
      ...(link
        ? {
            UpdateExpression: 'SET clubSignupLink = :v',
            ExpressionAttributeValues: { ':v': link },
          }
        : { UpdateExpression: 'REMOVE clubSignupLink' }),
      ConditionExpression: 'attribute_exists(pk)',
    }),
  );
}

// ── Users ──

export async function getUser(sub: string): Promise<UserProfile | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: userKey(sub) }));
  return stripKeys<UserProfile>(res.Item);
}

/**
 * Reconcile the per-membership TENANT# marker items against a user's current
 * memberships: upsert a marker for every membership (refreshing a changed
 * role/email), delete markers for revoked memberships. Best-effort and idempotent —
 * re-converges on the next call, so a partial failure self-heals. Shared by
 * `putUser` and the transactional admin-delta write so both keep markers in sync.
 */
async function reconcileUserMarkers(user: UserProfile): Promise<void> {
  const existing = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': userKey(user.sub).pk, ':s': 'TENANT#' },
    }),
  );
  const wanted = new Set(user.memberships.map((m) => m.tenantId));
  const have = new Set((existing.Items ?? []).map((i) => String(i.sk).slice('TENANT#'.length)));

  const writes: Promise<unknown>[] = [];
  // Upsert a marker for every current membership — unconditionally, so a changed
  // role/email on an existing membership refreshes the marker (not just new ones).
  // The PLATFORM membership (tenantId '*') is skipped SYMMETRICALLY (no upsert
  // here, no revoked-delete below): '*' is not a tenant, so an operator must
  // never surface in any tenant roster listing — and a legacy '*' marker is
  // likewise left alone rather than "reconciled".
  for (const m of user.memberships) {
    if (m.tenantId === PLATFORM_TENANT) continue;
    writes.push(
      ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: {
            ...userTenantMarkerKey(user.sub, m.tenantId),
            ...userGsi1(m.tenantId, user.email),
            sub: user.sub,
            email: user.email,
            role: m.role,
          },
        }),
      ),
    );
  }
  // Remove markers for revoked memberships ('*' markers are ignored — see above).
  for (const tenantId of have) {
    if (tenantId === PLATFORM_TENANT) continue;
    if (!wanted.has(tenantId)) {
      writes.push(
        ddb.send(
          new DeleteCommand({ TableName: TABLE, Key: userTenantMarkerKey(user.sub, tenantId) }),
        ),
      );
    }
  }
  await Promise.all(writes);
}

/**
 * Upsert a user: the META item (memberships = source of truth) plus one
 * tenant-marker item per membership so the user is listable under EVERY tenant
 * they belong to. Reconciles markers: removes markers for tenants no longer in
 * `memberships`, adds markers for new ones.
 */
export async function putUser(user: UserProfile): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      // META item carries memberships; no gsi1 (markers do the indexing).
      Item: { ...userKey(user.sub), ...user },
    }),
  );
  await reconcileUserMarkers(user);
}

/**
 * Stamp the user's first-ever sign-in. Writes `lastLoginAt` on the USER# META item
 * exactly ONCE per lifetime via `attribute_not_exists(lastLoginAt)` — subsequent
 * token refreshes hit the condition and no-op. Best-effort: swallows the conditional
 * failure AND every other error, because the caller (PreTokenGen) must never let a
 * failed write block token issuance / sign-in. Returns nothing.
 */
export async function stampFirstLogin(sub: string): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: userKey(sub),
        UpdateExpression: 'SET lastLoginAt = :now',
        // Once-per-lifetime: only the first sign-in (no lastLoginAt yet) writes.
        // attribute_exists(pk) keeps us from materializing a bare USER# row for a
        // user with no DynamoDB profile (e.g. a token minted before provisioning).
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(lastLoginAt)',
        ExpressionAttributeValues: { ':now': new Date().toISOString() },
      }),
    );
  } catch {
    // Expected on every refresh after the first sign-in (condition fails), and we
    // additionally swallow ALL errors: a sign-in must never break on this best-effort
    // status stamp. Not logged — the condition failure is the common, benign case.
  }
}

/**
 * Count a tenant's admins from the AUTHORITATIVE source (each user's `memberships`,
 * never the possibly-stale marker `role`) and write it to CONFIG.adminCount. Used to
 * lazily backfill the counter on legacy tenants before the lockout guard runs, and as
 * a repair. Returns the freshly-counted value.
 */
export async function recountAdmins(tenant: string): Promise<number> {
  const roster = await listTenantUsers(tenant);
  const profiles = await Promise.all(roster.map((u) => getUser(u.sub)));
  const count = profiles.filter((p) =>
    p?.memberships.some((m) => m.tenantId === tenant && m.role === 'admin'),
  ).length;
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: tenantConfigKey(tenant),
      UpdateExpression: 'SET adminCount = :n',
      ExpressionAttributeValues: { ':n': count },
    }),
  );
  return count;
}

/**
 * Conditionally decrement CONFIG.adminCount by one, refusing to drop below one admin
 * (the same `adminCount > 1` guard the transactional path uses). Used for a FULL
 * offboard DELETE, where the user's META item is deleted (not written) so there's no
 * user write to bundle into a transaction — the count is the only thing to adjust here.
 * Throws {@link LastAdminError} when it would remove the last admin.
 */
export async function decrementAdminCount(tenant: string): Promise<void> {
  await guardedConfigUpdate(tenant, {
    UpdateExpression: 'ADD adminCount :neg',
    ConditionExpression: 'adminCount > :one',
    ExpressionAttributeValues: { ':neg': -1, ':one': 1 },
  });
}

/**
 * Write a user's META item and adjust the tenant's CONFIG.adminCount ATOMICALLY in a
 * single TransactWriteItems, then reconcile the user's TENANT# markers.
 *
 * `adminDelta` is +1 (invite-as-admin / promote rep→admin), -1 (demote admin→rep /
 * remove an admin), or 0 (no role-tier change). For a -1 the CONFIG update carries
 * `ConditionExpression: adminCount > :one`, so the transaction is REJECTED — and the
 * user write rolled back — when it would drop the tenant to zero admins, surfacing as
 * {@link LastAdminError}. This makes the last-admin lockout race-free (no TOCTOU on a
 * point-in-time count). For +1/-1 the CONFIG must already carry adminCount; callers
 * backfill via recountAdmins first when it's absent (a legacy tenant).
 *
 * Markers are reconciled AFTER the transaction (they're a derived index, not part of
 * the atomic invariant) — same best-effort, self-healing reconciliation putUser uses.
 */
export async function writeUserWithAdminDelta(
  user: UserProfile,
  tenant: string,
  adminDelta: -1 | 0 | 1,
): Promise<void> {
  if (adminDelta === 0) {
    await putUser(user);
    return;
  }
  const configUpdate: AdminCountUpdate =
    adminDelta === 1
      ? {
          UpdateExpression: 'ADD adminCount :one',
          ExpressionAttributeValues: { ':one': 1 },
        }
      : {
          // Decrement guarded: refuse to go below one admin (last-admin lockout).
          UpdateExpression: 'ADD adminCount :neg',
          ConditionExpression: 'adminCount > :one',
          ExpressionAttributeValues: { ':neg': -1, ':one': 1 },
        };

  if (localEndpoint) {
    // Local DynamoDB (dynalite) has no TransactWriteItems support. Fall back to the
    // CONFIG update FIRST (its ConditionExpression still enforces the last-admin guard
    // on a decrement), then the user write. Not atomic — a crash between the two can
    // drift adminCount — but recountAdmins repairs it and this path is OFFLINE/TEST
    // only (production always has the real endpoint → the transaction below).
    await guardedConfigUpdate(tenant, configUpdate);
    await putUser(user);
    return;
  }

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              Item: { ...userKey(user.sub), ...user },
            },
          },
          {
            Update: {
              TableName: TABLE,
              Key: tenantConfigKey(tenant),
              ...configUpdate,
            },
          },
        ],
      }),
    );
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    // A guarded decrement that hit the floor cancels the whole transaction (so the
    // user write is rolled back too) — surface it as the typed last-admin error.
    if (name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException') {
      throw new LastAdminError();
    }
    throw err;
  }
  await reconcileUserMarkers(user);
}

/**
 * Apply a (possibly conditional) adminCount UpdateCommand to CONFIG, mapping a failed
 * `adminCount > 1` decrement guard to {@link LastAdminError}. Shared by the
 * dynalite fallback in writeUserWithAdminDelta and by decrementAdminCount.
 */
interface AdminCountUpdate {
  UpdateExpression: string;
  ConditionExpression?: string;
  ExpressionAttributeValues: Record<string, number>;
}

async function guardedConfigUpdate(tenant: string, update: AdminCountUpdate): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({ TableName: TABLE, Key: tenantConfigKey(tenant), ...update }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new LastAdminError();
    }
    throw err;
  }
}

/**
 * Prune one orphaned admin membership (a membership whose Cognito user is gone). The
 * caller passes `user` with this tenant's membership ALREADY removed; this writes that
 * META + `ADD adminCount -1` ATOMICALLY, then reconciles markers.
 *
 * UNLIKE the guarded decrement this is UNCONDITIONAL — removing a phantom admin must
 * always succeed (a tenant whose only "admin" was a phantom is already locked out, and
 * we still want the counter to reflect zero real admins). Using an `ADD` delta (never a
 * recompute-SET) keeps it race-free with concurrent invite/promote/remove; a double-prune
 * from two concurrent reconciles only drifts the counter LOW — the safe direction — and is
 * repaired by the next backfill. It NEVER deletes the user, so a multi-tenant user keeps
 * their other memberships; an emptied META item is harmless (no markers ⇒ unlistable) and
 * the reconcile CLI fully removes it.
 */
export async function pruneAdminMembership(user: UserProfile, tenant: string): Promise<void> {
  const decrement: AdminCountUpdate = {
    UpdateExpression: 'ADD adminCount :neg',
    ExpressionAttributeValues: { ':neg': -1 },
  };
  if (localEndpoint) {
    // dynalite has no TransactWriteItems — same non-atomic offline fallback shape as
    // writeUserWithAdminDelta (test/offline only; production uses the transaction below).
    await ddb.send(
      new UpdateCommand({ TableName: TABLE, Key: tenantConfigKey(tenant), ...decrement }),
    );
    await putUser(user);
    return;
  }
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: { ...userKey(user.sub), ...user } } },
        { Update: { TableName: TABLE, Key: tenantConfigKey(tenant), ...decrement } },
      ],
    }),
  );
  await reconcileUserMarkers(user);
}

/**
 * Delete a user fully: the META record AND every TENANT# marker (so an offboarded user
 * leaves no listable trace in any tenant). Their Cognito account is removed separately.
 * (eraseTenantData deletes a single tenant's marker without touching META — different
 * intent; this is the whole-user delete.)
 */
export async function deleteUser(sub: string): Promise<void> {
  const markers = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': userKey(sub).pk, ':s': 'TENANT#' },
      ProjectionExpression: 'pk, sk',
    }),
  );
  await Promise.all([
    ddb.send(new DeleteCommand({ TableName: TABLE, Key: userKey(sub) })),
    ...(markers.Items ?? []).map((i) =>
      ddb.send(
        new DeleteCommand({ TableName: TABLE, Key: { pk: i.pk as string, sk: i.sk as string } }),
      ),
    ),
  ]);
}

/** List a tenant's users for offboarding/erasure (via the marker items). */
export async function listTenantUsers(
  tenant: string,
): Promise<Array<{ sub: string; email: string; role: string }>> {
  const items = await queryAll({
    TableName: TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': usersListGsi1pk(tenant) },
  });
  return items.map((i) => ({
    sub: String(i.sub),
    email: String(i.email),
    role: String(i.role),
  }));
}

// ── Tenant erasure (POPIA offboarding) ──

/** Retries per chunk for UnprocessedItems before batchDelete gives up and throws. */
const BATCH_DELETE_RETRIES = 5;

/**
 * Batch-delete keys in chunks of 25 (the BatchWrite limit). BatchWrite reports
 * throttled writes via UnprocessedItems instead of throwing, so each chunk retries
 * its leftovers with bounded backoff — silently dropping them would leave residue
 * an erase promised to remove (POPIA) and break the re-deletable invariant the
 * club/tenant cascades rely on. Keys still unprocessed after the retries are an
 * error, not a shrug: the caller must know the erase did NOT complete.
 */
async function batchDelete(keys: Array<{ pk: string; sk: string }>): Promise<void> {
  for (let i = 0; i < keys.length; i += 25) {
    let requests = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
    for (let attempt = 0; requests.length > 0; attempt++) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: requests } }));
      const unprocessed = res.UnprocessedItems?.[TABLE] ?? [];
      if (unprocessed.length === 0) break;
      if (attempt >= BATCH_DELETE_RETRIES) {
        throw new Error(
          `batchDelete: ${unprocessed.length} keys still unprocessed after ${BATCH_DELETE_RETRIES} retries`,
        );
      }
      // Linear backoff is enough: erases are rare, admin-triggered, and not latency-bound.
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      requests = unprocessed as typeof requests;
    }
  }
}

/**
 * Delete a tenant's data without a table Scan: query each known partition/index
 * (config, clubs+players, series, user markers) and batch-delete. Returns the
 * count removed. Player reg-link TOKEN# items are global and not tenant-enumerable —
 * they harmlessly resolve to a now-deleted club (404) after erasure. The club
 * SIGNUP token, unlike those, IS tenant-enumerable via the CONFIG pointer, and
 * left alive it would still pass the signup GET's token lookup — so it's revoked
 * here, before the CONFIG row (and with it the pointer) is deleted.
 *
 * Note: this deletes only the tenant's marker for a user, not the user's META
 * record or Cognito account — a multi-union user keeps their other memberships.
 * The erase-tenant CLI removes single-tenant users' accounts separately.
 */
export async function eraseTenantData(tenant: string): Promise<number> {
  const config = await getTenantConfig(tenant);
  if (config?.clubSignupLink?.token) await deleteToken(config.clubSignupLink.token);

  const keys: Array<{ pk: string; sk: string }> = [tenantConfigKey(tenant)];
  const objectKeys: string[] = [];

  const clubs = await listClubs(tenant);
  for (const club of clubs) {
    keys.push(clubKey(tenant, club.id));
    objectKeys.push(...clubDocObjectKeys(club));
    const players = await listPlayers(tenant, club.id);
    for (const p of players) {
      keys.push(playerKey(tenant, club.id, p.naturalKey));
      if (p.idDocMeta?.objectKey) objectKeys.push(p.idDocMeta.objectKey);
    }
    // Clearance items (canonical CLEARANCE# + mirror INBOUND_CLEARANCE#) live under club
    // pks but carry no gsi1/META listing, so enumerate them per club explicitly.
    for (const x of await listClearancesForSource(tenant, club.id)) {
      keys.push(clearanceKey(tenant, club.id, x.id));
    }
    for (const x of await listInboundForDest(tenant, club.id)) {
      keys.push(inboundClearanceKey(tenant, club.id, x.id));
    }
    // Registration reviews (REGREVIEW#) also live under club pks without a gsi1/META
    // listing — enumerate per club, and purge any held (cross-club) ID doc.
    for (const r of await listReviewsForClub(tenant, club.id)) {
      keys.push(registrationReviewKey(tenant, club.id, r.id));
      if (r.pendingPlayer?.idDocMeta?.objectKey)
        objectKeys.push(r.pendingPlayer.idDocMeta.objectKey);
    }
    // Invite markers aren't in the gsi1 listing — enumerate + delete them explicitly.
    for (const k of await listClubInviteKeys(tenant, club.id)) keys.push(k);
  }
  for (const s of await listSeries(tenant)) keys.push(seriesKey(tenant, s.id));
  for (const u of await listTenantUsers(tenant)) keys.push(userTenantMarkerKey(u.sub, tenant));
  // Export-audit items sit at pk `TENANT#<t>` (above the `TENANT#<t>#…` prefix sweep),
  // so enumerate them explicitly like invite markers.
  for (const k of await listExportLogKeys(tenant)) keys.push(k);

  await batchDelete(keys);
  await deleteUploadObjects(objectKeys);
  return keys.length;
}

/**
 * Blank a tenant's COHORT (clubs + their player registrations + series) while
 * KEEPING the tenant config and all users/markers. Used to wipe demo data from a
 * real tenant. Builds the delete set independently of eraseTenantData (which also
 * removes config + users) and asserts no config/user key slips in. Idempotent.
 */
export async function clearCohort(tenant: string): Promise<number> {
  const keys: Array<{ pk: string; sk: string }> = [];
  const objectKeys: string[] = [];
  for (const club of await listClubs(tenant)) {
    keys.push(clubKey(tenant, club.id));
    objectKeys.push(...clubDocObjectKeys(club));
    for (const p of await listPlayers(tenant, club.id)) {
      keys.push(playerKey(tenant, club.id, p.naturalKey));
      if (p.idDocMeta?.objectKey) objectKeys.push(p.idDocMeta.objectKey);
    }
    for (const x of await listClearancesForSource(tenant, club.id)) {
      keys.push(clearanceKey(tenant, club.id, x.id));
    }
    for (const x of await listInboundForDest(tenant, club.id)) {
      keys.push(inboundClearanceKey(tenant, club.id, x.id));
    }
    for (const r of await listReviewsForClub(tenant, club.id)) {
      keys.push(registrationReviewKey(tenant, club.id, r.id));
      if (r.pendingPlayer?.idDocMeta?.objectKey)
        objectKeys.push(r.pendingPlayer.idDocMeta.objectKey);
    }
    for (const k of await listClubInviteKeys(tenant, club.id)) keys.push(k);
  }
  for (const s of await listSeries(tenant)) keys.push(seriesKey(tenant, s.id));

  // Safety: never delete the tenant config or any user record.
  for (const k of keys) {
    if (k.sk === 'CONFIG' || k.pk.startsWith('USER#')) {
      throw new Error(`refusing to clear cohort: unexpected key ${k.pk} / ${k.sk}`);
    }
  }
  await batchDelete(keys);
  await deleteUploadObjects(objectKeys);
  return keys.length;
}

/**
 * Erase ONE club's data (admin club deletion — junk/abandoned signups, POPIA
 * "right to erasure" for the club's players). The caller passes the already-read
 * club so this never re-reads or guesses; user memberships are the ROUTE's job
 * (it must sweep them BEFORE calling this).
 *
 * Clearances span two partitions, so each direction also derives its counterpart
 * key: a source clearance's mirror lives under the DESTINATION club, an inbound
 * mirror's canonical under the SOURCE club — leaving either behind would point a
 * surviving club at a dead one forever. A pending inbound mirror additionally
 * holds the source club's player at 'clearance-pending' (createClearance's dedup
 * guard would block them permanently), so those players get a best-effort
 * conditional reset to 'active' — a RESET, not a restore: the prior status isn't
 * stored, matching resolveClearance's own convention.
 *
 * Ordering is the re-deletable invariant: every step is idempotent and the club
 * META is deleted via a separate DeleteCommand only AFTER batchDelete fully
 * succeeds (BatchWrite is unordered within a chunk, so "META last in the array"
 * would not actually be last). A crash at any point leaves a club that still
 * 200s on re-delete; only a complete cascade makes the club 404.
 */
export async function eraseClubData(
  tenant: string,
  club: Club,
): Promise<{ players: number; clearances: number; series: number; seriesFailed: number }> {
  // Revoke the reg-link token FIRST so the public registration route dies before the
  // cascade runs (same order eraseTenantData uses for the club-signup token).
  if (club.playerRegLink?.token) await deleteToken(club.playerRegLink.token);

  const keys: Array<{ pk: string; sk: string }> = [];
  const objectKeys: string[] = [...clubDocObjectKeys(club)];

  const players = await listPlayers(tenant, club.id);
  for (const p of players) {
    keys.push(playerKey(tenant, club.id, p.naturalKey));
    if (p.idDocMeta?.objectKey) objectKeys.push(p.idDocMeta.objectKey);
    if (p.previousIdDocMeta?.objectKey) objectKeys.push(p.previousIdDocMeta.objectKey);
  }

  // This club as SOURCE: canonical here, mirror under the destination club.
  const outgoing = await listClearancesForSource(tenant, club.id);
  for (const x of outgoing) {
    keys.push(clearanceKey(tenant, club.id, x.id));
    keys.push(inboundClearanceKey(tenant, x.toClubId, x.id));
    // A pending registration-origin clearance pre-created the player at the
    // DESTINATION as 'clearance-pending'. With this (source) club gone there is
    // nobody left to issue it and the clearance items are being erased, so activate
    // that row in place — it becomes the player's only surviving record once the
    // cascade deletes the source row. Best-effort, same shape as the inbound
    // unstick below.
    if (x.status === 'pending' && x.origin === 'registration') {
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: TABLE,
            Key: playerKey(tenant, x.toClubId, x.playerNaturalKey),
            UpdateExpression: 'SET #s = :active ADD version :one',
            ConditionExpression: 'attribute_exists(sk) AND #s = :pending',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':active': 'active',
              ':pending': 'clearance-pending',
              ':one': 1,
            },
          }),
        );
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      }
    }
  }

  // This club as DESTINATION: mirror here, canonical under the source club. Deleting
  // that canonical erases the surviving source club's transfer audit trail — accepted
  // and erasure-friendly (documented). Unstick still-pending source players (see doc).
  const inbound = await listInboundForDest(tenant, club.id);
  for (const x of inbound) {
    keys.push(inboundClearanceKey(tenant, club.id, x.id));
    keys.push(clearanceKey(tenant, x.fromClubId, x.id));
    if (x.status === 'pending') {
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: TABLE,
            Key: playerKey(tenant, x.fromClubId, x.playerNaturalKey),
            UpdateExpression: 'SET #s = :active ADD version :one',
            // Only flip a player this clearance actually holds pending — a player who
            // moved/changed since must not be clobbered. Best-effort: the failed
            // condition means there is nothing to unstick.
            ConditionExpression: 'attribute_exists(sk) AND #s = :pending',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':active': 'active',
              ':pending': 'clearance-pending',
              ':one': 1,
            },
          }),
        );
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      }
    }
  }

  // Registration reviews addressed to this club (it is the destination). Enumerate +
  // delete, and purge any held cross-club ID doc (self-asserted PII, POPIA).
  for (const r of await listReviewsForClub(tenant, club.id)) {
    keys.push(registrationReviewKey(tenant, club.id, r.id));
    if (r.pendingPlayer?.idDocMeta?.objectKey) objectKeys.push(r.pendingPlayer.idDocMeta.objectKey);
  }

  // Invite markers aren't in the gsi1 listing — enumerate + delete them explicitly
  // (they carry recipient contact in their stored results).
  for (const k of await listClubInviteKeys(tenant, club.id)) keys.push(k);

  await batchDelete(keys);
  // S3 purge BEFORE the META delete: the objectKeys are only derivable while the
  // club/player records exist, so a crash after META landed would strand the doc
  // PII unreachably. deleteUploadObjects never throws and S3 deletes are
  // idempotent, so running it first changes nothing else.
  await deleteUploadObjects(objectKeys);

  // Sweep DRAFT (unreleased) series so a deleted club doesn't linger in teams[]/fixtures.
  // Released series are left intact (they keep showing "Removed club" — preserves published
  // history). Best-effort and non-fatal: a single bad/contended series must not block the club
  // erasure. Runs BEFORE the META delete so a re-delete (club still 200s) retries any series left
  // behind — stripClubFromDraftSeries is a no-op once a series is already clean.
  let series = 0;
  let seriesFailed = 0;
  for (const s of await listSeries(tenant)) {
    if (s.released === true) continue;
    // Skip series the club isn't in — matched via its resolved team set (a multi-team
    // club is present under `tm_…` ids, not its clubId).
    const mine = teamIdsForClub(s, club.id);
    if (!mine.some((tid) => s.teams.includes(tid))) continue;
    try {
      if (await stripClubFromDraftSeries(tenant, s.id, club.id)) series++;
    } catch (err: unknown) {
      // One retry for an optimistic-lock race (a concurrent series edit); recomputed from a fresh
      // read inside the helper. A persistent failure leaves THIS series with the dead club —
      // logged and counted, not thrown, so the club deletion still completes.
      if (err instanceof VersionConflictError) {
        try {
          if (await stripClubFromDraftSeries(tenant, s.id, club.id)) series++;
          continue;
        } catch {
          /* fall through to the failure path */
        }
      }
      seriesFailed++;
      console.error(`eraseClubData: failed to strip club ${club.id} from series ${s.id}`, err);
    }
  }

  // META last, and only after everything else succeeded (see doc): the META item is
  // the re-deletability anchor — while it exists, the delete can always be retried.
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: clubKey(tenant, club.id) }));
  return {
    players: players.length,
    clearances: outgoing.length + inbound.length,
    series,
    seriesFailed,
  };
}
