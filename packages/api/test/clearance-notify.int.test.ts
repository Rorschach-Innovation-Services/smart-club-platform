/**
 * Clearance notification fan-out + the admin "Send reminder" route, through the REAL Hono app on
 * an in-process dynalite.
 *
 * Creation (every site calls notifyClearanceOpened): the source chair's existing notice, plus a
 * destination-chair email (comm-log kind `clearance-inbound` on the destination club) and one email
 * per tenant admin (platform operators excluded, not comm-logged). When the source club's daily cap
 * fires, the destination rows are `skipped` and no admin email goes out. Admin reassign (bypassCap)
 * inherits the fan-out.
 *
 * Remind: one reminder per clearance per tenant day via the shared INVITE# claim — 409 on a repeat
 * — logged as kind `clearance-reminder`, which never consumes the creation cap. 409 on a resolved
 * clearance, 422 on an off-system source.
 *
 * Senders run in dry-run (no FROM_EMAIL); admin emails are observed from the dry-run log line.
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

const DDB_PORT = 4691;
const TABLE = 'SmartClubTest';
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
type ClubCommEvent = import('../src/types.js').ClubCommEvent;

const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: `sub-${email}`, email, memberships })).toString('base64');
const ADMIN = devAuth('admin@union.test', [{ tenantId: TENANT, role: 'admin', clubIds: [] }]);
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

const mkClub = (id: string, name: string, extra: Partial<Club> = {}): Club =>
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
    ...extra,
  }) as Club;

let seq = 0;
const mkPlayer = (clubId: string, extra: Partial<PlayerRegistration> = {}): PlayerRegistration => {
  seq++;
  return {
    naturalKey: `nk-${seq}`,
    clubId,
    firstName: 'Player',
    lastName: `Number${seq}`,
    dob: '1994-02-02',
    idNumber: `ID${String(seq).padStart(6, '0')}`,
    isMinor: false,
    status: 'active',
    consentAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
    ...extra,
  } as PlayerRegistration;
};

/** Seed a source + destination club pair with a player at the source; returns their ids. */
async function seedPair(prefix: string, srcExtra: Partial<Club> = {}) {
  const src = `${prefix}-src`;
  const dst = `${prefix}-dst`;
  await repo.createClub(TENANT, mkClub(src, `${prefix} Source CC`, srcExtra));
  await repo.createClub(TENANT, mkClub(dst, `${prefix} Dest CC`));
  const player = mkPlayer(src);
  await repo.createPlayer(TENANT, player);
  return { src, dst, player };
}

const openClearance = (src: string, dst: string, player: PlayerRegistration) =>
  app.request(`/clubs/${dst}/clearances`, {
    method: 'POST',
    headers: headers(repOf(dst)),
    body: JSON.stringify({ fromClubId: src, playerNaturalKey: player.naturalKey }),
  });

const commLog = async (clubId: string): Promise<ClubCommEvent[]> =>
  (await repo.getClub(TENANT, clubId))?.commLog ?? [];

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
const adminEmailsSent = () =>
  logged
    .filter((l) => l.includes('clearance-opened (admin) notice'))
    .map((l) => l.replace(/^.* to /, ''))
    .sort();

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

  // Two real admins, one operator who also holds admin (operator auto-admin), and a rep.
  const { PLATFORM_TENANT } = await import('../src/types.js');
  const users = [
    {
      sub: 'u-admin-1',
      email: 'admin1@union.test',
      memberships: [{ tenantId: TENANT, role: 'admin', clubIds: [] }],
    },
    {
      sub: 'u-admin-2',
      email: 'admin2@union.test',
      memberships: [{ tenantId: TENANT, role: 'admin', clubIds: [] }],
    },
    {
      sub: 'u-operator',
      email: 'operator@platform.test',
      memberships: [
        { tenantId: TENANT, role: 'admin', clubIds: [] },
        { tenantId: PLATFORM_TENANT, role: 'operator', clubIds: [] },
      ],
    },
    {
      sub: 'u-rep',
      email: 'rep@club.test',
      memberships: [{ tenantId: TENANT, role: 'rep', clubIds: ['x'] }],
    },
  ];
  for (const u of users) {
    await repo.putUser({ ...u, onboardingSeen: {} } as import('../src/types.js').UserProfile);
  }
});

after(async () => {
  console.log = realLog;
  await new Promise<void>((resolve) => ddbServer.close(() => resolve()));
});

describe('listTenantAdminEmails', () => {
  test('returns tenant admins only, excluding platform operators and reps', async () => {
    const { listTenantAdminEmails } = await import('../src/notify/admin-emails.js');
    assert.deepEqual((await listTenantAdminEmails(repo, TENANT)).sort(), [
      'admin1@union.test',
      'admin2@union.test',
    ]);
    assert.deepEqual(await listTenantAdminEmails(repo, 'no-such-tenant'), []);
  });
});

describe('clearance creation fan-out', () => {
  test('source chair (clearance), destination chair (clearance-inbound) and every admin are notified', async () => {
    const { src, dst, player } = await seedPair('fan');
    const res = await openClearance(src, dst, player);
    assert.equal(res.status, 201);
    const clearance = (await res.json()) as PlayerClearance;

    const srcLog = await commLog(src);
    assert.deepEqual(srcLog.map((e) => `${e.kind}/${e.channel}/${e.status}`).sort(), [
      'clearance/email/sent',
      'clearance/whatsapp/sent',
    ]);

    const dstLog = await commLog(dst);
    assert.equal(dstLog.length, 1);
    assert.equal(dstLog[0].kind, 'clearance-inbound');
    assert.equal(dstLog[0].channel, 'email');
    assert.equal(dstLog[0].status, 'sent');
    assert.equal(dstLog[0].to, `chair@${dst}.test`);
    assert.equal(dstLog[0].idempotencyKey, `clearance-${clearance.id}-inbound-email`);
    assert.match(dstLog[0].messageId ?? '', /^dry-run-/);

    assert.deepEqual(adminEmailsSent(), ['admin1@union.test', 'admin2@union.test']);
  });

  test('a destination chair with no email on file gets a skipped inbound row', async () => {
    await repo.createClub(TENANT, mkClub('noemail-src', 'NoEmail Source CC'));
    await repo.createClub(
      TENANT,
      mkClub('noemail-dst', 'NoEmail Dest CC', {
        exco: { chair: { name: 'X', email: '', cell: '' } },
      } as Partial<Club>),
    );
    const player = mkPlayer('noemail-src');
    await repo.createPlayer(TENANT, player);
    assert.equal((await openClearance('noemail-src', 'noemail-dst', player)).status, 201);
    const dstLog = await commLog('noemail-dst');
    assert.equal(dstLog.length, 1);
    assert.equal(dstLog[0].kind, 'clearance-inbound');
    assert.equal(dstLog[0].status, 'skipped');
  });

  test('when the source-club daily cap fires, destination rows are skipped and admins are not emailed', async () => {
    const { src, dst, player } = await seedPair('cap');
    const at = new Date().toISOString();
    await repo.appendClubCommEvents(
      TENANT,
      src,
      [1, 2, 3].map((i) => ({
        id: `seed-${i}`,
        channel: 'email' as const,
        status: 'sent' as const,
        at,
        by: 'seed',
        idempotencyKey: `clearance-seed-${i}-email`,
        kind: 'clearance' as const,
      })),
    );
    assert.equal((await openClearance(src, dst, player)).status, 201);

    const fresh = (await commLog(src)).filter((e) => !e.id.startsWith('seed-'));
    assert.ok(fresh.length > 0 && fresh.every((e) => e.status === 'skipped'));
    const dstLog = await commLog(dst);
    assert.equal(dstLog.length, 1);
    assert.equal(dstLog[0].kind, 'clearance-inbound');
    assert.equal(dstLog[0].status, 'skipped');
    assert.equal(dstLog[0].error, 'daily clearance-notice cap reached');
    assert.deepEqual(adminEmailsSent(), []);
  });

  test('admin reassign (cap bypassed) notifies the new source, the destination and admins', async () => {
    await repo.createClub(TENANT, mkClub('ra-dst', 'Reassign Dest CC'));
    await repo.createClub(TENANT, mkClub('ra-new', 'Reassign New Source CC'));
    const player = mkPlayer('ra-dst', {
      status: 'clearance-pending',
    } as Partial<PlayerRegistration>);
    const clearance = {
      id: 'clr-reassign',
      playerNaturalKey: player.naturalKey,
      playerName: `${player.firstName} ${player.lastName}`,
      fromClubId: 'ra-directory',
      fromClubName: 'Directory CC',
      fromClubDirectory: true,
      toClubId: 'ra-dst',
      toClubName: 'Reassign Dest CC',
      origin: 'registration',
      requestedAt: new Date().toISOString(),
      feesCleared: false,
      misconductCleared: false,
      status: 'pending',
      clubApprovedAt: null,
      adminOverrideAt: null,
      version: 0,
    } as unknown as PlayerClearance;
    await repo.createPlayerWithSourcelessClearance(TENANT, player, clearance);

    const res = await app.request(`/admin/clearances/${clearance.id}/reassign`, {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ fromClubId: 'ra-directory', newFromClubId: 'ra-new', version: 0 }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual((await commLog('ra-new')).map((e) => `${e.kind}/${e.channel}`).sort(), [
      'clearance/email',
      'clearance/whatsapp',
    ]);
    const dstLog = await commLog('ra-dst');
    assert.deepEqual(
      dstLog.map((e) => `${e.kind}/${e.status}`),
      ['clearance-inbound/sent'],
    );
    assert.deepEqual(adminEmailsSent(), ['admin1@union.test', 'admin2@union.test']);
  });
});

describe('POST /admin/clearances/:cid/remind', () => {
  const remind = (cid: string, fromClubId: string, auth = ADMIN) =>
    app.request(`/admin/clearances/${cid}/remind`, {
      method: 'POST',
      headers: headers(auth),
      body: JSON.stringify({ fromClubId }),
    });

  test('re-sends to the source chair once per day, logs clearance-reminder, and never consumes the cap', async () => {
    const { src, dst, player } = await seedPair('rem');
    const clearance = (await (await openClearance(src, dst, player)).json()) as PlayerClearance;

    const first = await remind(clearance.id, src);
    assert.equal(first.status, 200);
    const { results } = (await first.json()) as {
      results: Array<{ channel: string; status: string }>;
    };
    assert.deepEqual(results.map((r) => `${r.channel}/${r.status}`).sort(), [
      'email/sent',
      'whatsapp/sent',
    ]);

    const reminders = (await commLog(src)).filter((e) => e.kind === 'clearance-reminder');
    assert.equal(reminders.length, 2);
    assert.ok(reminders.every((e) => e.by === 'admin@union.test'));
    assert.ok(
      reminders.every((e) =>
        new RegExp(
          `^clearance-${clearance.id}-reminder-\\d{4}-\\d{2}-\\d{2}-(email|whatsapp)$`,
        ).test(e.idempotencyKey),
      ),
    );

    const again = await remind(clearance.id, src);
    assert.equal(again.status, 409);
    assert.match(((await again.json()) as { error: string }).error, /already reminded today/);
    assert.equal((await commLog(src)).filter((e) => e.kind === 'clearance-reminder').length, 2);

    // The cap counts only `clearance` email rows: 1 creation notice so far, so two more creations
    // against this source still notify despite the reminder rows.
    for (let i = 0; i < 2; i++) {
      const dest = `rem-more-${i}`;
      await repo.createClub(TENANT, mkClub(dest, `Rem More ${i} CC`));
      const p = mkPlayer(src);
      await repo.createPlayer(TENANT, p);
      assert.equal((await openClearance(src, dest, p)).status, 201);
    }
    const creationEmails = (await commLog(src)).filter(
      (e) => e.kind === 'clearance' && e.channel === 'email',
    );
    assert.equal(creationEmails.length, 3);
    assert.ok(creationEmails.every((e) => e.status === 'sent'));
  });

  test('404 unknown, 409 resolved, 422 off-system source, 400 missing fromClubId, 403 for a rep', async () => {
    const { src, dst, player } = await seedPair('remerr');
    const clearance = (await (await openClearance(src, dst, player)).json()) as PlayerClearance;

    assert.equal((await remind('nope', src)).status, 404);
    assert.equal((await remind(clearance.id, '')).status, 400);
    assert.equal((await remind(clearance.id, src, repOf(src))).status, 403);

    const override = await app.request(`/admin/clearances/${clearance.id}/override`, {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ fromClubId: src, issueCertificate: false }),
    });
    assert.equal(override.status, 200, await override.clone().text());
    assert.equal((await remind(clearance.id, src)).status, 409);

    await repo.createClub(TENANT, mkClub('dir-dst', 'Dir Dest CC'));
    const dirPlayer = mkPlayer('dir-dst', {
      status: 'clearance-pending',
    } as Partial<PlayerRegistration>);
    const dirClearance = {
      id: 'clr-dir',
      playerNaturalKey: dirPlayer.naturalKey,
      playerName: 'Dir Player',
      fromClubId: 'dir-source',
      fromClubName: 'Off System CC',
      fromClubDirectory: true,
      toClubId: 'dir-dst',
      toClubName: 'Dir Dest CC',
      origin: 'registration',
      requestedAt: new Date().toISOString(),
      feesCleared: false,
      misconductCleared: false,
      status: 'pending',
      clubApprovedAt: null,
      adminOverrideAt: null,
      version: 0,
    } as unknown as PlayerClearance;
    await repo.createPlayerWithSourcelessClearance(TENANT, dirPlayer, dirClearance);
    const res = await remind('clr-dir', 'dir-source');
    assert.equal(res.status, 422);
    assert.match(((await res.json()) as { error: string }).error, /no chair on file/);
  });
});
