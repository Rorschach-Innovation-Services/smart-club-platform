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
} from '@aws-sdk/lib-dynamodb';
import {
  clubKey,
  clubGsi1,
  clubsListGsi1pk,
  seriesKey,
  seriesGsi1,
  seriesListGsi1pk,
  playerKey,
  playersListKey,
  tokenKey,
  tenantConfigKey,
  userKey,
  userTenantMarkerKey,
  userGsi1,
  usersListGsi1pk,
} from './keys.js';
import type { Club, Series, TenantConfig, UserProfile, PlayerRegistration } from './types.js';

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

/** Thrown when a version-checked write loses a race. Handlers map this to HTTP 409. */
export class VersionConflictError extends Error {
  constructor() {
    super('version conflict');
    this.name = 'VersionConflictError';
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

  // Existing markers for this user.
  const existing = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': userKey(user.sub).pk, ':s': 'TENANT#' },
    }),
  );
  const wanted = new Set(user.memberships.map((m) => m.tenantId));
  const have = new Set((existing.Items ?? []).map((i) => String(i.sk).slice('TENANT#'.length)));

  // Markers are best-effort reconciled here and re-converged on the next putUser
  // (e.g. a /me save), so a partial failure self-heals.
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

/** Delete a user's META record (their Cognito account is removed separately). */
export async function deleteUser(sub: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: userKey(sub) }));
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

  const clubs = await listClubs(tenant);
  for (const club of clubs) {
    keys.push(clubKey(tenant, club.id));
    const players = await listPlayers(tenant, club.id);
    for (const p of players) keys.push(playerKey(tenant, club.id, p.naturalKey));
  }
  for (const s of await listSeries(tenant)) keys.push(seriesKey(tenant, s.id));
  for (const u of await listTenantUsers(tenant)) keys.push(userTenantMarkerKey(u.sub, tenant));

  await batchDelete(keys);
  return keys.length;
}
