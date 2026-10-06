/**
 * Transfer windows end to end, through the REAL Hono app on an in-process dynalite.
 *
 *  - config: operator PUT persists (validated + sorted), admin PUT strips it, GET /tenant and
 *    GET /tenant/config serve the windows plus a server-computed status;
 *  - a rep's clearance request while closed → 409 naming the next window, nothing written;
 *  - a public registration that would open a clearance while closed → 201 `transferWindow`,
 *    an auto-rejected canonical + mirror ONLY (no player rows, no count changes), both chairs +
 *    admins notified; a resubmission in the same closed stretch writes and sends nothing;
 *  - a plain first registration is never window-blocked; the chair portal refuses (409);
 *  - once a window opens the same person registers normally;
 *  - Reopen lands a clearance-pending destination row which then approves cleanly, and is
 *    BLOCKED when the person has registered anywhere since;
 *  - club erasure collects the snapshot's ID document.
 *
 * Senders run in dry-run (NOTIFY_DRY_RUN). Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

const DDB_PORT = 4695;
const TABLE = 'SmartClubTransferWindows';
const TENANT = 'dolphins';
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.LOCAL_AUTH = '1';
process.env.STAGE = 'local';
process.env.USER_POOL_ID = 'test-pool';
process.env.AWS_REGION ??= 'localhost';
process.env.UPLOADS_BUCKET = 'test-uploads';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_MAX_ATTEMPTS = '1';
process.env.NOTIFY_DRY_RUN = '1';

type Repo = typeof import('../src/repo.js');
type Club = import('../src/types.js').Club;
type PlayerRegistration = import('../src/types.js').PlayerRegistration;
type PlayerClearance = import('../src/types.js').PlayerClearance;
type TransferWindow = import('../src/types.js').TransferWindow;
type TenantConfig = import('../src/types.js').TenantConfig;

const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: `sub-${email}`, email, memberships })).toString('base64');
const ADMIN = devAuth('admin@union.test', [{ tenantId: TENANT, role: 'admin', clubIds: [] }]);
const OPERATOR = devAuth('operator@platform.test', [
  { tenantId: '*', role: 'operator', clubIds: [] },
]);
const repOf = (clubId: string) =>
  devAuth(`rep@${clubId}.test`, [{ tenantId: TENANT, role: 'rep', clubIds: [clubId] }]);
const headers = (auth: string) => ({
  'x-tenant': TENANT,
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: Repo;
let tenantToday: (now?: Date) => string;
let teamKey = '';

const mkClub = (id: string, name: string): Club =>
  ({
    id,
    name,
    district: 'Test District',
    sub: `sub-${id}`,
    chair: 'Chair',
    exco: { chair: { name: `${name} Chair`, email: `chair@${id}.test`, cell: '0821234567' } },
    affiliation: 'complete',
    cqi: 0,
    docs: {},
    players: 0,
    teams: 0,
    women: 0,
    juniors: 0,
    color: '#123456',
    ground: {},
    leagues: [],
    version: 1,
  }) as Club;

const shift = (days: number): string => {
  const d = new Date(`${tenantToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const closedWindows = (): TransferWindow[] => [
  { label: 'Winter', start: shift(30), end: shift(60) },
  { label: 'Summer', start: shift(-60), end: shift(-30) },
];
const openWindows = (): TransferWindow[] => [{ label: 'Now', start: shift(-1), end: shift(1) }];

const setWindows = async (transferWindows: unknown) =>
  app.request(`/platform/tenants/${TENANT}`, {
    method: 'PUT',
    headers: headers(OPERATOR),
    body: JSON.stringify({ transferWindows }),
  });

let seq = 0;
/** A passport identity (dob supplied), unique per call. */
const identity = () => {
  seq++;
  return {
    firstName: 'Tau',
    lastName: `Window${seq}`,
    idType: 'passport',
    idNumber: `TW${String(seq).padStart(6, '0')}`,
    dob: '1996-03-03',
    nationality: 'Zimbabwean',
  };
};

/** POST the public registration form for `id` through `linkClubId`'s token. */
const register = (linkClubId: string, id: ReturnType<typeof identity>, extra = {}) =>
  app.request(`/register/${linkClubId}?t=tok-${linkClubId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...id,
      race: 'African',
      gender: 'Male',
      cell: '0831112222',
      team: teamKey,
      district: 'Ethekwini',
      idDocMeta: {
        objectKey: `local/${TENANT}/${linkClubId}/${id.idNumber}.png`,
        size: 100,
        contentType: 'image/png',
      },
      ...extra,
    }),
  });

/** A club pair with a reg-link token on the destination. */
async function seedPair(prefix: string) {
  const src = `${prefix}-src`;
  const dst = `${prefix}-dst`;
  await repo.createClub(TENANT, mkClub(src, `${prefix} Source CC`));
  await repo.createClub(TENANT, mkClub(dst, `${prefix} Dest CC`));
  await repo.putToken(`tok-${dst}`, TENANT, dst, '2026-06-01T00:00:00.000Z');
  return { src, dst };
}

/** Put `id` on `clubId`'s roster as an active player (bypassing every route). */
async function rosterAt(clubId: string, id: ReturnType<typeof identity>) {
  const { playerNaturalKey } = await import('../src/player-identity.js');
  const naturalKey = playerNaturalKey(id as Partial<PlayerRegistration>);
  await repo.createPlayer(TENANT, {
    ...(id as Partial<PlayerRegistration>),
    naturalKey,
    clubId,
    status: 'active',
    isMinor: false,
    consentAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
  } as PlayerRegistration);
  return naturalKey;
}

const playerCount = async (clubId: string): Promise<number> =>
  ((await repo.getClub(TENANT, clubId)) as { playerCount?: number } | null)?.playerCount ?? 0;

const inbound = async (dst: string) =>
  (await repo.listInboundForDest(TENANT, dst)).filter((x) => x.status === 'rejected');

// Dry-run email capture: every sender logs `[notify:email dry-run] would send …`.
let logged: string[] = [];
const realLog = console.log;
beforeEach(() => {
  logged = [];
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
});
afterEach(() => {
  console.log = realLog;
});
const autoRejectAdminEmails = () =>
  logged.filter((l) => l.includes('clearance-auto-rejected (admin) notice'));

before(async () => {
  const dynalite = (await import('dynalite')).default as (opts?: unknown) => Server;
  ddbServer = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => ddbServer.listen(DDB_PORT, resolve));
  const { DynamoDBClient, CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  const admin = new DynamoDBClient({
    endpoint: process.env.DYNAMO_ENDPOINT,
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  await admin.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi1pk', AttributeType: 'S' },
        { AttributeName: 'gsi1sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
  const seed = await import('../src/seed-core.js');
  await seed.seedTenantConfig(TENANT);
  ({ app } = await import('../src/index.js'));
  repo = await import('../src/repo.js');
  ({ tenantToday } = await import('../src/transfer-windows.js'));
  teamKey = ((await repo.getTenantConfig(TENANT))?.leagues ?? [])[0]?.key ?? '';
  assert.ok(teamKey, 'precondition: the seeded tenant has a league catalogue');
  await repo.putUser({
    sub: 'u-admin',
    email: 'admin1@union.test',
    memberships: [{ tenantId: TENANT, role: 'admin', clubIds: [] }],
    onboardingSeen: {},
  } as import('../src/types.js').UserProfile);
});

after(async () => {
  console.log = realLog;
  await new Promise<void>((resolve) => ddbServer.close(() => resolve()));
});

describe('config plumbing', () => {
  test('operator PUT validates, sorts and persists; admin PUT strips; both GETs serve status', async () => {
    const bad = await setWindows([{ label: 'X', start: '2026-02-30', end: '2026-03-01' }]);
    assert.equal(bad.status, 400);

    const windows = closedWindows(); // deliberately unsorted (Winter first)
    const put = await setWindows(windows);
    assert.equal(put.status, 200);
    const stored = (await repo.getTenantConfig(TENANT))?.transferWindows;
    assert.deepEqual(stored, [windows[1], windows[0]], 'sorted by start');

    const adminPut = await app.request('/tenant/config', {
      method: 'PUT',
      headers: headers(ADMIN),
      body: JSON.stringify({ transferWindows: [], transferWindowStatus: { open: true } }),
    });
    assert.equal(adminPut.status, 200);
    const after = await repo.getTenantConfig(TENANT);
    assert.deepEqual(after?.transferWindows, stored, 'admin cannot write transferWindows');
    assert.equal((after as { transferWindowStatus?: unknown }).transferWindowStatus, undefined);

    for (const res of [
      await app.request(`/tenant?tenant=${TENANT}`),
      await app.request('/tenant/config', { headers: headers(ADMIN) }),
    ]) {
      assert.equal(res.status, 200);
      const body = (await res.json()) as TenantConfig & {
        transferWindowStatus?: { open: boolean; next?: TransferWindow };
      };
      assert.deepEqual(body.transferWindows, stored);
      assert.deepEqual(body.transferWindowStatus, { open: false, next: windows[0] });
    }

    // An empty list means no restriction — and no status is served.
    await setWindows([]);
    const pub = (await (await app.request(`/tenant?tenant=${TENANT}`)).json()) as {
      transferWindows: unknown[];
      transferWindowStatus?: unknown;
    };
    assert.deepEqual(pub.transferWindows, []);
    assert.equal(pub.transferWindowStatus, undefined);
  });
});

describe('enforcement while closed', () => {
  beforeEach(async () => {
    assert.equal((await setWindows(closedWindows())).status, 200);
  });

  test('a rep request 409s naming the next window and writes nothing', async () => {
    const { src, dst } = await seedPair('rep');
    const nk = await rosterAt(src, identity());
    const res = await app.request(`/clubs/${dst}/clearances`, {
      method: 'POST',
      headers: headers(repOf(dst)),
      body: JSON.stringify({ fromClubId: src, playerNaturalKey: nk }),
    });
    assert.equal(res.status, 409);
    assert.match(
      ((await res.json()) as { error: string }).error,
      /^transfers are closed — next window: Winter/,
    );
    assert.equal((await repo.getPlayer(TENANT, src, nk))?.status, 'active');
    assert.equal((await repo.listClearancesForSource(TENANT, src)).length, 0);
  });

  test('a registration records an auto-rejected canonical + mirror and NO player rows', async () => {
    const { src, dst } = await seedPair('auto');
    const id = identity();
    const nk = await rosterAt(src, id);
    const srcCountBefore = await playerCount(src);
    const dstCountBefore = await playerCount(dst);

    const res = await register(dst, id, { lastClubId: src });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      ok: boolean;
      clearance?: unknown;
      transferWindow?: { closed: boolean; nextWindow?: TransferWindow };
    };
    assert.deepEqual(body.transferWindow, { closed: true, nextWindow: closedWindows()[0] });
    assert.equal(body.clearance, undefined, 'no clearance-pending copy for the form');

    // No player rows written or flipped, no count changes.
    assert.equal(await repo.getPlayer(TENANT, dst, nk), null);
    assert.equal((await repo.getPlayer(TENANT, src, nk))?.status, 'active');
    assert.equal(await playerCount(src), srcCountBefore);
    assert.equal(await playerCount(dst), dstCountBefore);

    const [mirror] = await inbound(dst);
    assert.ok(mirror, 'the destination mirror exists');
    assert.equal(mirror.rejectSnapshot, undefined, 'the mirror carries no snapshot');
    const raw = (await repo.getClearanceRaw(TENANT, src, mirror.id)) as PlayerClearance;
    assert.equal(raw.status, 'rejected');
    assert.equal(raw.origin, 'registration');
    assert.equal(raw.rejectedBy, 'system:transfer-window');
    assert.equal(raw.rejectOutcome, 'not-registered');
    assert.match(raw.rejectReason ?? '', /^Outside transfer window — next window: Winter \(/);
    assert.equal(raw.rejectSnapshot?.case, 'window-closed');
    const pending = raw.rejectSnapshot?.pendingPlayer;
    assert.equal(pending?.clubId, dst);
    assert.equal(pending?.status, 'clearance-pending');
    assert.equal(pending?.idDocMeta?.objectKey, `local/${TENANT}/${dst}/${id.idNumber}.png`);
    // The admin listing sees it, snapshot-stripped.
    const listed = (await repo.listAllClearances(TENANT)).find((x) => x.id === raw.id);
    assert.equal(listed?.status, 'rejected');
    assert.equal(listed?.rejectSnapshot, undefined);

    // Both chairs got the 'not-registered' rejected notice; admins got the auto-reject email.
    for (const clubId of [src, dst]) {
      const rows = ((await repo.getClub(TENANT, clubId))?.commLog ?? []).filter(
        (e) => e.kind === 'clearance-rejected',
      );
      assert.equal(rows.length, 1, `${clubId} chair notified once`);
      assert.equal(rows[0].by, 'system:transfer-window');
    }
    assert.equal(autoRejectAdminEmails().length, 1);
  });

  test('a resubmission in the same closed stretch writes nothing and re-notifies nobody', async () => {
    const { src, dst } = await seedPair('dup');
    const id = identity();
    await rosterAt(src, id);
    assert.equal((await register(dst, id, { lastClubId: src })).status, 201);
    const commBefore = (await repo.getClub(TENANT, dst))?.commLog?.length ?? 0;
    logged = [];

    const again = await register(dst, id, { lastClubId: src });
    assert.equal(again.status, 201);
    assert.equal(
      ((await again.json()) as { transferWindow?: { closed: boolean } }).transferWindow?.closed,
      true,
    );
    assert.equal((await inbound(dst)).length, 1, 'no second rejected clearance');
    assert.equal((await repo.listClearancesForSource(TENANT, src)).length, 1);
    assert.equal((await repo.getClub(TENANT, dst))?.commLog?.length ?? 0, commBefore);
    assert.equal(autoRejectAdminEmails().length, 0);
  });

  test('a declared on-system previous club with no roster row is also auto-rejected', async () => {
    const { src, dst } = await seedPair('srcless');
    const id = identity();
    const res = await register(dst, id, { lastClubId: src });
    assert.equal(res.status, 201);
    assert.equal(
      ((await res.json()) as { transferWindow?: { closed: boolean } }).transferWindow?.closed,
      true,
    );
    const [x] = await inbound(dst);
    assert.equal(x?.rejectOutcome, 'not-registered');
    assert.equal((await repo.listPlayers(TENANT, dst)).length, 0);
  });

  test('a plain first registration is never window-blocked', async () => {
    const { dst } = await seedPair('first');
    const res = await register(dst, identity(), { lastClub: '—' });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true });
    const [row] = await repo.listPlayers(TENANT, dst);
    assert.equal(row?.status, 'active');
  });

  test('the chair portal refuses a transfer registration (409), writing nothing', async () => {
    const { src, dst } = await seedPair('portal');
    const id = identity();
    const nk = await rosterAt(src, id);
    const res = await app.request(`/clubs/${dst}/players`, {
      method: 'POST',
      headers: headers(repOf(dst)),
      body: JSON.stringify({
        ...id,
        race: 'African',
        gender: 'Male',
        cell: '0831112222',
        team: teamKey,
        district: 'Ethekwini',
        lastClubId: src,
      }),
    });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /^transfers are closed/);
    assert.equal(await repo.getPlayer(TENANT, dst, nk), null);
    assert.equal((await repo.getPlayer(TENANT, src, nk))?.status, 'active');
    assert.equal((await repo.listInboundForDest(TENANT, dst)).length, 0);
  });
});

describe('after the window opens', () => {
  test('the same person registers normally despite the earlier auto-reject', async () => {
    await setWindows(closedWindows());
    const { src, dst } = await seedPair('later');
    const id = identity();
    const nk = await rosterAt(src, id);
    assert.equal((await register(dst, id, { lastClubId: src })).status, 201);

    await setWindows(openWindows());
    const res = await register(dst, id, { lastClubId: src });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      clearance?: { fromClubName: string };
      transferWindow?: unknown;
    };
    assert.equal(body.transferWindow, undefined);
    assert.equal(body.clearance?.fromClubName, 'later Source CC');
    assert.equal((await repo.getPlayer(TENANT, dst, nk))?.status, 'clearance-pending');
    assert.equal((await repo.getPlayer(TENANT, src, nk))?.status, 'clearance-pending');
    const statuses = (await repo.listInboundForDest(TENANT, dst)).map((x) => x.status).sort();
    assert.deepEqual(statuses, ['pending', 'rejected']);
  });
});

describe('reopen of a window-rejected clearance', () => {
  test('lands a clearance-pending destination row, then approves cleanly', async () => {
    await setWindows(closedWindows());
    const { src, dst } = await seedPair('reopen');
    const id = identity();
    const nk = await rosterAt(src, id);
    assert.equal((await register(dst, id, { lastClubId: src })).status, 201);
    const [x] = await inbound(dst);
    const dstCountBefore = await playerCount(dst);

    // Reopen is an admin action — allowed whatever the window says.
    const reopen = await app.request(`/admin/clearances/${x.id}/reopen`, {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ fromClubId: src }),
    });
    assert.equal(reopen.status, 200, await reopen.clone().text());
    const reopened = (await reopen.json()) as PlayerClearance;
    assert.equal(reopened.status, 'pending');
    assert.equal(reopened.rejectOutcome, undefined);
    assert.equal(reopened.rejectedBy, undefined);

    const dest = await repo.getPlayer(TENANT, dst, nk);
    assert.equal(dest?.status, 'clearance-pending');
    assert.equal(dest?.idDocMeta?.objectKey, `local/${TENANT}/${dst}/${id.idNumber}.png`);
    assert.equal((await repo.getPlayer(TENANT, src, nk))?.status, 'clearance-pending');
    assert.equal(await playerCount(dst), dstCountBefore + 1);
    const raw = await repo.getClearanceRaw(TENANT, src, x.id);
    assert.equal(raw?.rejectSnapshot, undefined, 'the snapshot is consumed');

    // The source club approves: the destination row activates, the source row goes.
    const issue = await app.request(`/clubs/${src}/clearances/${x.id}`, {
      method: 'PATCH',
      headers: headers(repOf(src)),
      body: JSON.stringify({ feesCleared: true, misconductCleared: true, action: 'issue' }),
    });
    assert.equal(issue.status, 200, await issue.clone().text());
    assert.equal(((await issue.json()) as PlayerClearance).status, 'approved');
    assert.equal((await repo.getPlayer(TENANT, dst, nk))?.status, 'active');
    assert.equal(await repo.getPlayer(TENANT, src, nk), null);
  });

  test('a sourceless window-rejected clearance reopens with no source row to flip', async () => {
    await setWindows(closedWindows());
    const { src, dst } = await seedPair('reopen-sl');
    const id = identity();
    assert.equal((await register(dst, id, { lastClubId: src })).status, 201);
    const [x] = await inbound(dst);
    const reopened = await repo.reopenClearance(TENANT, src, x.id, { at: 't', by: 'admin' });
    assert.equal(reopened.status, 'pending');
    assert.equal((await repo.listPlayers(TENANT, dst))[0]?.status, 'clearance-pending');
    assert.equal((await repo.listPlayers(TENANT, src)).length, 0);
  });

  test('is BLOCKED once the person has registered anywhere since', async () => {
    await setWindows(closedWindows());
    const { src, dst } = await seedPair('blocked');
    await repo.createClub(TENANT, mkClub('blocked-other', 'blocked Other CC'));
    const id = identity();
    assert.equal((await register(dst, id, { lastClubId: src })).status, 201);
    const [x] = await inbound(dst);
    // Since the auto-reject they joined a third club as a first registration.
    const nk = await rosterAt('blocked-other', id);

    const res = await app.request(`/admin/clearances/${x.id}/reopen`, {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ fromClubId: src }),
    });
    assert.equal(res.status, 409);
    assert.match(
      ((await res.json()) as { error: string }).error,
      /registered or transferred since/,
    );
    assert.equal(await repo.getPlayer(TENANT, dst, nk), null, 'nothing was restored');
    const raw = await repo.getClearanceRaw(TENANT, src, x.id);
    assert.equal(raw?.status, 'rejected');
    assert.equal(raw?.rejectSnapshot?.case, 'window-closed', 'snapshot intact for a later retry');
  });

  test('is BLOCKED when the source row is no longer active (mid-transfer elsewhere)', async () => {
    await setWindows(closedWindows());
    const { src, dst } = await seedPair('blocked2');
    const id = identity();
    const nk = await rosterAt(src, id);
    assert.equal((await register(dst, id, { lastClubId: src })).status, 201);
    const [x] = await inbound(dst);
    await repo.updatePlayer(TENANT, src, nk, { status: 'clearance-pending' });
    await assert.rejects(
      repo.reopenClearance(TENANT, src, x.id, { at: 't', by: 'admin' }),
      (e: unknown) => (e as { name?: string }).name === 'ClearanceReopenBlockedError',
    );
  });
});

describe('POPIA', () => {
  test('the snapshot ID document is collected for erasure and the club erase removes the record', async () => {
    await setWindows(closedWindows());
    const { src, dst } = await seedPair('erase');
    const id = identity();
    await rosterAt(src, id);
    assert.equal((await register(dst, id, { lastClubId: src })).status, 201);
    const [x] = await inbound(dst);
    const raw = (await repo.getClearanceRaw(TENANT, src, x.id))!;
    assert.deepEqual(repo.clearanceDocObjectKeys(raw), [
      `local/${TENANT}/${dst}/${id.idNumber}.png`,
    ]);

    await repo.eraseClubData(TENANT, (await repo.getClub(TENANT, dst))!);
    assert.equal(await repo.getClearanceRaw(TENANT, src, x.id), null, 'canonical erased');
    assert.equal((await repo.listInboundForDest(TENANT, dst)).length, 0, 'mirror erased');
  });
});
