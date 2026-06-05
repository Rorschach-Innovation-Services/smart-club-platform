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
  tokenKey,
  tenantConfigKey,
  userKey,
  userTenantMarkerKey,
  userGsi1,
  usersListGsi1pk,
} from './keys.js';
import type {
  Club,
  ClubCommEvent,
  League,
  SendResult,
  Series,
  TenantConfig,
  UserProfile,
  PlayerRegistration,
  PlayerClearance,
} from './types.js';

import { tableName } from './env.js';

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

/** Pull every stored objectKey off a club (docMeta) — used to purge S3 on erasure. */
function clubDocObjectKeys(club: Club): string[] {
  const docMeta = (club.docMeta ?? {}) as Record<string, { objectKey?: string } | undefined>;
  return Object.values(docMeta)
    .map((m) => m?.objectKey)
    .filter((k): k is string => typeof k === 'string');
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
      Item: { ...tenantConfigKey(config.tenant), ...config },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
}

export async function putTenantConfig(config: TenantConfig): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...tenantConfigKey(config.tenant), ...config },
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

// ── Clubs ──

export async function listClubs(tenant: string): Promise<Club[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :p',
      ExpressionAttributeValues: { ':p': clubsListGsi1pk(tenant) },
    }),
  );
  return (res.Items ?? []).map((i) => stripKeys<Club>(i)!);
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
 * it a spurious 409. The UI mitigates this by invalidating the club query right
 * after a note add, so the next edit re-reads the bumped version.
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
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': pk, ':s': 'INVITE#' },
      ProjectionExpression: 'pk, sk',
    }),
  );
  return (res.Items ?? []).map((i) => ({ pk: i.pk as string, sk: i.sk as string }));
}

// ── Series ──

export async function listSeries(tenant: string): Promise<Series[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :p',
      ExpressionAttributeValues: { ':p': seriesListGsi1pk(tenant) },
    }),
  );
  return (res.Items ?? []).map((i) => stripKeys<Series>(i)!);
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

// ── Player registrations ──

export async function listPlayers(tenant: string, clubId: string): Promise<PlayerRegistration[]> {
  const { pk, skPrefix } = playersListKey(tenant, clubId);
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': pk, ':s': skPrefix },
    }),
  );
  return (res.Items ?? []).map((i) => stripKeys<PlayerRegistration>(i)!);
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
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: clubKey(tenant, player.clubId),
      UpdateExpression: 'ADD playerCount :one',
      ExpressionAttributeValues: { ':one': 1 },
    }),
  );
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
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': pk, ':s': skPrefix },
    }),
  );
  return (res.Items ?? []).map((i) => stripKeys<PlayerClearance>(i)!);
}

/** Clearances incoming to a club (it is the destination) — read from its own mirror items. */
export async function listInboundForDest(
  tenant: string,
  clubId: string,
): Promise<PlayerClearance[]> {
  const { pk, skPrefix } = inboundClearancesListKey(tenant, clubId);
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': pk, ':s': skPrefix },
    }),
  );
  return (res.Items ?? []).map((i) => stripKeys<PlayerClearance>(i)!);
}

/** Every clearance in the tenant (admin console) — one row per request via the gsi1. */
export async function listAllClearances(tenant: string): Promise<PlayerClearance[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :p',
      ExpressionAttributeValues: { ':p': clearancesListGsi1pk(tenant) },
    }),
  );
  return (res.Items ?? []).map((i) => stripKeys<PlayerClearance>(i)!);
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
    if (name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException') {
      throw new DuplicatePendingClearanceError();
    }
    throw err;
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

  const movedPlayer: PlayerRegistration = {
    ...player,
    clubId: current.toClubId,
    status: 'active',
    version: (player.version ?? 0) + 1,
  };
  const { canonical, mirror } = clearanceItems(tenant, next);

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
    ExpressionAttributeValues: { ':one': 1 },
  };
  const canonicalPut = {
    TableName: TABLE,
    Item: canonical,
    ConditionExpression: 'version = :v',
    ExpressionAttributeValues: { ':v': expectedVersion },
  };
  const mirrorPut = { TableName: TABLE, Item: mirror };

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
    await ddb.send(new UpdateCommand(destCount));
    await ddb.send(new PutCommand(mirrorPut));
    return next;
  }

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
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
      // Either the destination guard (player already there) or the version guard (raced)
      // failed. Best-effort disambiguation by re-reading the destination: a present player
      // is reported as a collision. Note this can't perfectly distinguish a genuine version
      // race that a CONCURRENT successful resolve just won (which also lands the player at
      // the destination) — that edge is mislabelled as a collision. Both map to HTTP 409, so
      // only the message differs; the caller is told to refetch either way.
      const atDest = await getPlayer(tenant, current.toClubId, player.naturalKey);
      if (atDest) throw new PlayerExistsAtDestinationError();
      throw new VersionConflictError();
    }
    throw err;
  }
  return next;
}

// ── Registration tokens (global, self-describing) ──

export async function getToken(
  token: string,
): Promise<{ tenant: string; clubId: string; createdAt: string } | null> {
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

/** Revoke a token so a regenerated reg-link invalidates the previous one. */
export async function deleteToken(token: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: tokenKey(token) }));
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
  for (const m of user.memberships) {
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
  // Remove markers for revoked memberships.
  for (const tenantId of have) {
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
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :p',
      ExpressionAttributeValues: { ':p': usersListGsi1pk(tenant) },
    }),
  );
  return (res.Items ?? []).map((i) => ({
    sub: String(i.sub),
    email: String(i.email),
    role: String(i.role),
  }));
}

// ── Tenant erasure (POPIA offboarding) ──

async function batchDelete(keys: Array<{ pk: string; sk: string }>): Promise<void> {
  for (let i = 0; i < keys.length; i += 25) {
    const batch = keys.slice(i, i + 25);
    if (batch.length === 0) continue;
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: { [TABLE]: batch.map((Key) => ({ DeleteRequest: { Key } })) },
      }),
    );
  }
}

/**
 * Delete a tenant's data without a table Scan: query each known partition/index
 * (config, clubs+players, series, user markers) and batch-delete. Returns the
 * count removed. Reg-link TOKEN# items are global and not tenant-enumerable —
 * they harmlessly resolve to a now-deleted club (404) after erasure.
 *
 * Note: this deletes only the tenant's marker for a user, not the user's META
 * record or Cognito account — a multi-union user keeps their other memberships.
 * The erase-tenant CLI removes single-tenant users' accounts separately.
 */
export async function eraseTenantData(tenant: string): Promise<number> {
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
    // Invite markers aren't in the gsi1 listing — enumerate + delete them explicitly.
    for (const k of await listClubInviteKeys(tenant, club.id)) keys.push(k);
  }
  for (const s of await listSeries(tenant)) keys.push(seriesKey(tenant, s.id));
  for (const u of await listTenantUsers(tenant)) keys.push(userTenantMarkerKey(u.sub, tenant));

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
