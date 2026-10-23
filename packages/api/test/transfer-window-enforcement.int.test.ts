/**
 * Transfer windows end to end, through the REAL Hono app on an in-process dynalite.
 *
 *  - config: operator PUT persists (validated + sorted), admin PUT strips it, GET /tenant and
 *    GET /tenant/config serve the windows plus a server-computed status;
 *  - while closed (ADR 0017, revised 2026-10-23) EVERY registration path refuses with the same
 *    structured 409 (`transferWindow: { closed, nextWindow? }`): public link (+ its ID presign;
 *    the uploaded ID document is deleted), rep request, chair single add (new player or
 *    transfer), operator intake commit, admin override, source-club issue, manual remind —
 *    nothing written, nobody notified. Reject / reassign / reopen stay allowed;
 *  - windows gate a clearances-off tenant too; a windowless tenant is unaffected;
 *  - Reopen of a historical window-rejected clearance lands a clearance-pending destination
 *    row (which then approves once a window opens), and is BLOCKED when the person has
 *    registered anywhere since;
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
const emailsSent = () => logged.filter((l) => l.includes('[notify:email dry-run] would send'));

/** The structured 409 every closed-window refusal shares. */
async function assertClosed409(res: Response, nextWindow: TransferWindow | undefined) {
  assert.equal(res.status, 409, await res.clone().text());
  const body = (await res.json()) as {
    error: string;
    transferWindow?: { closed: boolean; nextWindow?: TransferWindow };
  };
  assert.match(body.error, /^player registration is closed — /);
  assert.deepEqual(body.transferWindow, { closed: true, ...(nextWindow ? { nextWindow } : {}) });
}

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

/**
 * A historical window-closed auto-reject (no production writer any more), seeded directly:
 * canonical + mirror only, the would-be destination row on the snapshot.
 */
async function seedWindowRejected(src: string, dst: string, id: ReturnType<typeof identity>) {
  const { playerNaturalKey } = await import('../src/player-identity.js');
  const { randomUUID } = await import('node:crypto');
  const naturalKey = playerNaturalKey(id as Partial<PlayerRegistration>);
  const srcClub = (await repo.getClub(TENANT, src))!;
  const dstClub = (await repo.getClub(TENANT, dst))!;
  const pendingPlayer = {
    ...(id as Partial<PlayerRegistration>),
    naturalKey,
    clubId: dst,
    status: 'clearance-pending',
    isMinor: false,
    team: teamKey,
    lastClub: srcClub.name,
    registeredVia: 'link',
    idDocMeta: {
      objectKey: `local/${TENANT}/${dst}/${id.idNumber}.png`,
      size: 100,
      contentType: 'image/png',
    },
    version: 0,
    consentAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
  } as PlayerRegistration;
  return repo.createAutoRejectedClearance(TENANT, pendingPlayer, {
    id: randomUUID(),
    playerNaturalKey: naturalKey,
    playerName: `${id.firstName} ${id.lastName}`,
    idNumber: id.idNumber,
    team: teamKey,
    fromClubId: src,
    toClubId: dst,
    fromClubName: srcClub.name,
    toClubName: dstClub.name,
    requestedAt: '2026-09-01T00:00:00.000Z',
    origin: 'registration',
    feesCleared: false,
    misconductCleared: false,
    status: 'rejected',
    rejectedAt: '2026-09-01T00:00:00.000Z',
    rejectedBy: 'system:transfer-window',
    rejectReason: 'Outside transfer window — next window: Winter',
    rejectOutcome: 'not-registered',
    clubApprovedAt: null,
    adminOverrideAt: null,
    version: 0,
  } as PlayerClearance);
}

/** A pending clearance src → dst opened by a rep request while a window was open. */
async function openPendingRequest(src: string, dst: string, nk: string): Promise<PlayerClearance> {
  await setWindows(openWindows());
  const res = await app.request(`/clubs/${dst}/clearances`, {
    method: 'POST',
    headers: headers(repOf(dst)),
    body: JSON.stringify({ fromClubId: src, playerNaturalKey: nk }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as PlayerClearance;
}

const chairAdd = (dst: string, id: ReturnType<typeof identity>, extra = {}) =>
  app.request(`/clubs/${dst}/players`, {
    method: 'POST',
    headers: headers(repOf(dst)),
    body: JSON.stringify({
      ...id,
      race: 'African',
      gender: 'Male',
      cell: '0831112222',
      team: teamKey,
      district: 'Ethekwini',
      ...extra,
    }),
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
    await assertClosed409(res, closedWindows()[0]);
    assert.equal((await repo.getPlayer(TENANT, src, nk))?.status, 'active');
    assert.equal((await repo.listClearancesForSource(TENANT, src)).length, 0);
  });

  test('a public transfer registration 409s: no clearance, no player rows, nobody notified', async () => {
    const { src, dst } = await seedPair('auto');
    const id = identity();
    const nk = await rosterAt(src, id);
    const srcCountBefore = await playerCount(src);
    const dstCountBefore = await playerCount(dst);

    await assertClosed409(await register(dst, id, { lastClubId: src }), closedWindows()[0]);

    assert.equal(await repo.getPlayer(TENANT, dst, nk), null);
    assert.equal((await repo.getPlayer(TENANT, src, nk))?.status, 'active');
    assert.equal(await playerCount(src), srcCountBefore);
    assert.equal(await playerCount(dst), dstCountBefore);
    assert.equal((await repo.listInboundForDest(TENANT, dst)).length, 0, 'no clearance row');
    assert.equal((await repo.listClearancesForSource(TENANT, src)).length, 0);
    for (const clubId of [src, dst]) {
      assert.equal(((await repo.getClub(TENANT, clubId))?.commLog ?? []).length, 0);
    }
    assert.equal(emailsSent().length, 0);
  });

  test('a declared on-system previous club with no roster row also 409s', async () => {
    const { src, dst } = await seedPair('srcless');
    await assertClosed409(await register(dst, identity(), { lastClubId: src }), closedWindows()[0]);
    assert.equal((await repo.listInboundForDest(TENANT, dst)).length, 0);
    assert.equal((await repo.listPlayers(TENANT, dst)).length, 0);
  });

  test('a plain first registration is blocked too', async () => {
    const { dst } = await seedPair('first');
    await assertClosed409(await register(dst, identity(), { lastClub: '—' }), closedWindows()[0]);
    assert.equal((await repo.listPlayers(TENANT, dst)).length, 0);
  });

  test('with no upcoming window the 409 carries no nextWindow', async () => {
    await setWindows([{ label: 'Past', start: shift(-60), end: shift(-30) }]);
    const { dst } = await seedPair('nonext');
    await assertClosed409(await register(dst, identity(), { lastClub: '—' }), undefined);
  });

  test("the refused submission's uploaded ID document is deleted (own-prefix keys only)", async () => {
    const { mkdtemp, mkdir, writeFile, access, rm } = await import('node:fs/promises');
    const path = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { randomUUID } = await import('node:crypto');
    const dir = await mkdtemp(path.join(tmpdir(), 'window-closed-'));
    const prevDir = process.env.LOCAL_UPLOADS_DIR;
    process.env.LOCAL_UPLOADS_DIR = dir; // local-disk upload sink (STAGE=local is set above)
    try {
      const { dst } = await seedPair('orphan');
      const put = async (objectKey: string) => {
        const onDisk = path.join(dir, objectKey.slice('local/'.length));
        await mkdir(path.dirname(onDisk), { recursive: true });
        await writeFile(onDisk, 'png');
        return onDisk;
      };
      const exists = (p: string) =>
        access(p).then(
          () => true,
          () => false,
        );
      const doc = (objectKey: string) => ({
        idDocMeta: { objectKey, size: 100, contentType: 'image/png' },
      });

      const ownKey = `local/${TENANT}/${dst}/reg-${randomUUID()}-id.png`;
      const own = await put(ownKey);
      await assertClosed409(await register(dst, identity(), doc(ownKey)), closedWindows()[0]);
      assert.equal(await exists(own), false, 'the unreferenced upload is gone');

      // A key under the club's prefix that is NOT a public-link upload shape is never deleted.
      const otherKey = `local/${TENANT}/${dst}/compliance-doc.png`;
      const other = await put(otherKey);
      await assertClosed409(await register(dst, identity(), doc(otherKey)), closedWindows()[0]);
      assert.equal(await exists(other), true, 'a non-registration key is left alone');
    } finally {
      if (prevDir === undefined) delete process.env.LOCAL_UPLOADS_DIR;
      else process.env.LOCAL_UPLOADS_DIR = prevDir;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the public ID-document presign 409s', async () => {
    const { dst } = await seedPair('presign');
    const res = await app.request(`/register/${dst}/id-doc/upload-url?t=tok-${dst}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/png' }),
    });
    await assertClosed409(res, closedWindows()[0]);
  });

  test('a player already mid-transfer elsewhere gets the closed 409, nothing new written', async () => {
    const { src, dst } = await seedPair('inflight');
    await repo.createClub(TENANT, mkClub('inflight-c', 'inflight C CC'));
    await repo.putToken('tok-inflight-c', TENANT, 'inflight-c', '2026-06-01T00:00:00.000Z');
    const id = identity();
    const nk = await rosterAt(src, id);
    await openPendingRequest(src, dst, nk);
    assert.equal((await repo.getPlayer(TENANT, src, nk))?.status, 'clearance-pending');

    await setWindows(closedWindows());
    logged = [];
    const res = await register('inflight-c', id, { lastClubId: src });
    await assertClosed409(res, closedWindows()[0]);
    assert.equal((await repo.listClearancesForSource(TENANT, src)).length, 1);
    assert.equal((await repo.listInboundForDest(TENANT, 'inflight-c')).length, 0);
    assert.equal(await repo.getPlayer(TENANT, 'inflight-c', nk), null);
    assert.equal(emailsSent().length, 0);
  });

  test('the chair portal refuses a transfer registration (409), writing nothing', async () => {
    const { src, dst } = await seedPair('portal');
    const id = identity();
    const nk = await rosterAt(src, id);
    await assertClosed409(await chairAdd(dst, id, { lastClubId: src }), closedWindows()[0]);
    assert.equal(await repo.getPlayer(TENANT, dst, nk), null);
    assert.equal((await repo.getPlayer(TENANT, src, nk))?.status, 'active');
    assert.equal((await repo.listInboundForDest(TENANT, dst)).length, 0);
  });

  test('the chair portal refuses a brand-new player (409)', async () => {
    const { dst } = await seedPair('portal-new');
    await assertClosed409(await chairAdd(dst, identity()), closedWindows()[0]);
    assert.equal((await repo.listPlayers(TENANT, dst)).length, 0);
  });

  test('the operator roster-intake commit 409s before reading any item', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/commit`, {
      method: 'POST',
      headers: headers(OPERATOR),
      body: JSON.stringify({ items: [] }),
    });
    await assertClosed409(res, closedWindows()[0]);
  });

  test('override, source-club issue and manual remind 409; the clearance stays pending', async () => {
    const { src, dst } = await seedPair('freeze');
    const nk = await rosterAt(src, identity());
    const pending = await openPendingRequest(src, dst, nk);
    await setWindows(closedWindows());

    const override = await app.request(`/admin/clearances/${pending.id}/override`, {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ fromClubId: src, issueCertificate: false }),
    });
    await assertClosed409(override, closedWindows()[0]);

    const issue = await app.request(`/clubs/${src}/clearances/${pending.id}`, {
      method: 'PATCH',
      headers: headers(repOf(src)),
      body: JSON.stringify({ feesCleared: true, misconductCleared: true, action: 'issue' }),
    });
    await assertClosed409(issue, closedWindows()[0]);

    logged = [];
    const remind = await app.request(`/admin/clearances/${pending.id}/remind`, {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ fromClubId: src }),
    });
    await assertClosed409(remind, closedWindows()[0]);
    assert.equal(emailsSent().length, 0);

    assert.equal((await repo.getClearance(TENANT, src, pending.id))?.status, 'pending');
    assert.equal((await repo.getPlayer(TENANT, src, nk))?.status, 'clearance-pending');
  });

  test('reject and reassign still succeed while closed', async () => {
    const { src, dst } = await seedPair('queue');
    const nk = await rosterAt(src, identity());
    const pending = await openPendingRequest(src, dst, nk);
    // A sourceless registration-origin clearance (declared club, no roster row) to reassign.
    const sl = await seedPair('queue-sl');
    await repo.createClub(TENANT, mkClub('queue-new', 'queue New CC'));
    assert.equal((await register(sl.dst, identity(), { lastClubId: sl.src })).status, 201);
    const [sourceless] = await repo.listInboundForDest(TENANT, sl.dst);
    assert.equal(sourceless?.status, 'pending');
    await setWindows(closedWindows());

    const reject = await app.request(`/admin/clearances/${pending.id}/reject`, {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ fromClubId: src }),
    });
    assert.equal(reject.status, 200, await reject.clone().text());

    const reassign = await app.request(`/admin/clearances/${sourceless.id}/reassign`, {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ fromClubId: sl.src, newFromClubId: 'queue-new' }),
    });
    assert.equal(reassign.status, 200, await reassign.clone().text());
  });
});

describe('scope of the gate', () => {
  test('a clearances-off tenant with windows is gated too', async () => {
    const cfg = (await repo.getTenantConfig(TENANT))!;
    await repo.putTenantConfig({
      ...cfg,
      transferWindows: closedWindows(),
      features: { ...(cfg.features ?? {}), 'module.clearances': false },
    });
    try {
      const { dst } = await seedPair('nomod');
      await assertClosed409(await register(dst, identity(), { lastClub: '—' }), closedWindows()[0]);
      await assertClosed409(await chairAdd(dst, identity()), closedWindows()[0]);
      assert.equal((await repo.listPlayers(TENANT, dst)).length, 0);
    } finally {
      await repo.putTenantConfig(cfg);
    }
  });

  test('a windowless tenant is unaffected', async () => {
    await setWindows([]);
    const { src, dst } = await seedPair('nowin');
    const res = await register(dst, identity(), { lastClub: '—' });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true });
    const id = identity();
    await rosterAt(src, id);
    const transfer = await register(dst, id, { lastClubId: src });
    assert.equal(transfer.status, 201);
    assert.equal(
      ((await transfer.json()) as { clearance?: { fromClubName: string } }).clearance?.fromClubName,
      'nowin Source CC',
    );
  });
});

describe('reopen of a window-rejected clearance', () => {
  test('reopens while closed, stays pending until a window opens, then approves cleanly', async () => {
    await setWindows(closedWindows());
    const { src, dst } = await seedPair('reopen');
    const id = identity();
    const nk = await rosterAt(src, id);
    const x = await seedWindowRejected(src, dst, id);
    const dstCountBefore = await playerCount(dst);

    // Reopen is queue management — allowed whatever the window says.
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

    const issue = () =>
      app.request(`/clubs/${src}/clearances/${x.id}`, {
        method: 'PATCH',
        headers: headers(repOf(src)),
        body: JSON.stringify({ feesCleared: true, misconductCleared: true, action: 'issue' }),
      });
    // Still closed: the source club cannot complete it yet.
    await assertClosed409(await issue(), closedWindows()[0]);

    await setWindows(openWindows());
    const issued = await issue();
    assert.equal(issued.status, 200, await issued.clone().text());
    assert.equal(((await issued.json()) as PlayerClearance).status, 'approved');
    assert.equal((await repo.getPlayer(TENANT, dst, nk))?.status, 'active');
    assert.equal(await repo.getPlayer(TENANT, src, nk), null);
  });

  test('a sourceless window-rejected clearance reopens with no source row to flip', async () => {
    await setWindows(closedWindows());
    const { src, dst } = await seedPair('reopen-sl');
    const x = await seedWindowRejected(src, dst, identity());
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
    const x = await seedWindowRejected(src, dst, id);
    // Since the auto-reject they joined a third club.
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
    const x = await seedWindowRejected(src, dst, id);
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
    const x = await seedWindowRejected(src, dst, id);
    const raw = (await repo.getClearanceRaw(TENANT, src, x.id))!;
    assert.deepEqual(repo.clearanceDocObjectKeys(raw), [
      `local/${TENANT}/${dst}/${id.idNumber}.png`,
    ]);

    await repo.eraseClubData(TENANT, (await repo.getClub(TENANT, dst))!);
    assert.equal(await repo.getClearanceRaw(TENANT, src, x.id), null, 'canonical erased');
    assert.equal((await repo.listInboundForDest(TENANT, dst)).length, 0, 'mirror erased');
  });
});
