/**
 * Integration tests for the sport vertical (plan 1A/1B): the operator-only sport/seasonLabel
 * fields, the module 403 guards, player positions, and the registration write path with the
 * clearances module off (no clearances, no reviews; an active-elsewhere player transfers).
 *
 * Boots an in-process dynalite, seeds the cricket 'dolphins' tenant plus a football 'fc'
 * tenant, and drives the REAL Hono app via `app.request()` (LOCAL_AUTH dev bypass).
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

const DDB_PORT = 4651; // next free odd port after backfill-venue-aliases (4649)
const TABLE = 'SmartClubVerticalTest';
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

const devAuth = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const FC_ADMIN = devAuth('fc-adm', 'admin@fc', [{ tenantId: 'fc', role: 'admin', clubIds: [] }]);
const DOL_ADMIN = devAuth('dol-adm', 'admin@dol', [
  { tenantId: 'dolphins', role: 'admin', clubIds: [] },
]);
const OPERATOR = devAuth('op-1', 'operator@platform', [
  { tenantId: '*', role: 'operator', clubIds: [] },
]);

const headers = (auth: string, tenant: string) => ({
  'x-tenant': tenant,
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');

const mkClub = (id: string, name: string) => ({
  id,
  name,
  district: 'North',
  sub: `sub-${id}`,
  chair: 'Chair',
  affiliation: 'not_started' as const,
  cqi: 0,
  docs: {},
  players: 0,
  teams: 0,
  women: 0,
  juniors: 0,
  color: '#333333',
  ground: {},
  leagues: [],
  version: 1,
});

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
  await seed.seedTenantConfig('dolphins');
  ({ app } = await import('../src/index.js'));
  repo = await import('../src/repo.js');
  const created = await app.request('/platform/tenants', {
    method: 'POST',
    headers: headers(OPERATOR, 'fc'),
    body: JSON.stringify({
      slug: 'fc',
      branding: { name: 'Cape Schools Football' },
      submissionDeadline: '2027-03-01',
      sport: 'football',
      seasonLabel: '2027',
    }),
  });
  assert.equal(created.status, 201);
  for (const [id, name] of [
    ['fc-a', 'Alpha High'],
    ['fc-b', 'Beta High'],
  ]) {
    await repo.createClub('fc', mkClub(id, name));
    await repo.putToken(`${id}-token`, 'fc', id, '2026-06-01T00:00:00.000Z');
  }
  for (const [id, name] of [
    ['dv-a', 'Vertical A CC'],
    ['dv-b', 'Vertical B CC'],
  ]) {
    await repo.createClub('dolphins', mkClub(id, name));
    await repo.putToken(`${id}-token`, 'dolphins', id, '2026-06-01T00:00:00.000Z');
  }
});

after(() => {
  ddbServer?.close();
});

/** Presign an ID doc under the link club, then submit a self-registration through it. */
async function register(clubId: string, extra: Record<string, unknown>) {
  const token = `${clubId}-token`;
  const up = await app.request(`/register/${clubId}/id-doc/upload-url?t=${token}`, {
    method: 'POST',
    body: JSON.stringify({ contentType: 'image/png' }),
  });
  const { objectKey } = (await up.json()) as { objectKey: string };
  const tenantCfg = await repo.getTenantConfig(clubId.startsWith('fc') ? 'fc' : 'dolphins');
  return app.request(`/register/${clubId}?t=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firstName: 'Sam',
      lastName: 'Player',
      idType: 'passport',
      dob: '2000-01-01',
      nationality: 'South African',
      race: 'African',
      gender: 'Male',
      cell: '0820000000',
      team: tenantCfg?.leagues?.[0]?.key ?? 'u15',
      district: 'North',
      idDocMeta: { objectKey, size: 100, contentType: 'image/png' },
      ...extra,
    }),
  });
}

const findPlayer = async (tenant: string, clubId: string, idNumber: string) =>
  (await repo.listPlayers(tenant, clubId)).find((p) => p.idNumber === idNumber);

describe('operator-only sport + seasonLabel', () => {
  test('POST /platform/tenants seeds football defaults and GET /tenant serves the vertical', async () => {
    const cfg = await repo.getTenantConfig('fc');
    assert.equal(cfg?.sport, 'football');
    assert.equal(cfg?.seasonLabel, '2027');
    assert.deepEqual(cfg?.requiredDocs, []);
    assert.equal(cfg?.tutorialsNoFallback, true);
    assert.equal(cfg?.features?.whatsappInvites, false);
    const pub = (await (await app.request('/tenant?tenant=fc')).json()) as Record<string, unknown>;
    assert.equal(pub.sport, 'football');
    assert.equal(pub.seasonLabel, '2027');
    const dol = (await (await app.request('/tenant?tenant=dolphins')).json()) as Record<
      string,
      unknown
    >;
    assert.equal(dol.sport, undefined, 'legacy tenant: sport absent ⇒ cricket client-side');
  });

  test('POST /platform/tenants rejects an unknown sport or a bad season label', async () => {
    const post = (extra: Record<string, unknown>) =>
      app.request('/platform/tenants', {
        method: 'POST',
        headers: headers(OPERATOR, 'x'),
        body: JSON.stringify({
          slug: 'badsport',
          branding: { name: 'Bad' },
          submissionDeadline: '2027-03-01',
          ...extra,
        }),
      });
    assert.equal((await post({ sport: 'rugby' })).status, 400);
    assert.equal((await post({ seasonLabel: 'x'.repeat(40) })).status, 400);
  });

  test('PUT /tenant/config cannot set sport or seasonLabel', async () => {
    const res = await app.request('/tenant/config', {
      method: 'PUT',
      headers: headers(FC_ADMIN, 'fc'),
      body: JSON.stringify({ sport: 'cricket', seasonLabel: 'hijacked' }),
    });
    assert.equal(res.status, 200);
    const cfg = await repo.getTenantConfig('fc');
    assert.equal(cfg?.sport, 'football');
    assert.equal(cfg?.seasonLabel, '2027');
  });

  test('PUT /platform/tenants/:slug can set both, and validates them', async () => {
    const put = (body: Record<string, unknown>) =>
      app.request('/platform/tenants/dolphins', {
        method: 'PUT',
        headers: headers(OPERATOR, 'dolphins'),
        body: JSON.stringify(body),
      });
    assert.equal((await put({ sport: 'hockey' })).status, 400);
    assert.equal((await put({ seasonLabel: '' })).status, 400);
    assert.equal((await put({ sport: 'cricket', seasonLabel: ' 2026/27 ' })).status, 200);
    const cfg = await repo.getTenantConfig('dolphins');
    assert.equal(cfg?.sport, 'cricket');
    assert.equal(cfg?.seasonLabel, '2026/27');
  });
});

describe('module guards (403 for football, unchanged for cricket)', () => {
  const get = (path: string, auth: string, tenant: string) =>
    app.request(path, { headers: headers(auth, tenant) });

  test('each disabled route family 403s on the football tenant', async () => {
    for (const path of [
      '/admin/clearances',
      '/admin/registration-reviews',
      '/admin/veterans-requests',
      '/clubs/fc-a/clearances',
      '/clubs/fc-a/veterans-requests',
      '/clubs/fc-a/veterans-affiliates',
      '/clubs/fc-a/veterans-candidates?q=sam',
    ]) {
      assert.equal((await get(path, FC_ADMIN, 'fc')).status, 403, path);
    }
    const doc = await app.request('/clubs/fc-a/docs/constitution/upload-url', {
      method: 'POST',
      headers: headers(FC_ADMIN, 'fc'),
      body: JSON.stringify({ contentType: 'application/pdf' }),
    });
    assert.equal(doc.status, 403);
    const vetClub = await app.request('/clubs/fc-a/players/nk/veterans-club', {
      method: 'DELETE',
      headers: headers(FC_ADMIN, 'fc'),
    });
    assert.equal(vetClub.status, 403);
  });

  test('club PATCH rejects cqi / cqiAnswers when the CQI module is off', async () => {
    const patch = (body: Record<string, unknown>) =>
      app.request('/clubs/fc-a', {
        method: 'PATCH',
        headers: headers(FC_ADMIN, 'fc'),
        body: JSON.stringify(body),
      });
    assert.equal((await patch({ cqi: 50 })).status, 403);
    assert.equal((await patch({ cqiAnswers: { q1: 'yes' } })).status, 403);
    assert.equal((await patch({ ground: { pitchCount: 3 } })).status, 200);
    assert.equal((await repo.getClub('fc', 'fc-a'))?.ground.pitchCount, 3);
    assert.equal((await patch({ ground: { pitchCount: 2.5 } })).status, 400);
  });

  test('the same routes still answer on the cricket tenant', async () => {
    for (const path of [
      '/admin/clearances',
      '/admin/registration-reviews',
      '/admin/veterans-requests',
      '/clubs/dv-a/clearances',
      '/clubs/dv-a/veterans-affiliates',
    ]) {
      assert.equal((await get(path, DOL_ADMIN, 'dolphins')).status, 200, path);
    }
    const res = await app.request('/clubs/dv-a', {
      method: 'PATCH',
      headers: headers(DOL_ADMIN, 'dolphins'),
      body: JSON.stringify({ cqi: 40 }),
    });
    assert.equal(res.status, 200);
  });

  test('a module.* flag re-enables a family for the football tenant', async () => {
    const put = (features: Record<string, boolean>) =>
      app.request('/platform/tenants/fc', {
        method: 'PUT',
        headers: headers(OPERATOR, 'fc'),
        body: JSON.stringify({ features }),
      });
    assert.equal((await put({ whatsappInvites: false, 'module.clearances': true })).status, 200);
    assert.equal((await get('/admin/clearances', FC_ADMIN, 'fc')).status, 200);
    assert.equal((await put({ whatsappInvites: false })).status, 200);
    assert.equal((await get('/admin/clearances', FC_ADMIN, 'fc')).status, 403);
  });
});

describe('registration with the clearances module off (football)', () => {
  test('declared previous school with no roster record → active, no clearance, no review', async () => {
    const res = await register('fc-a', { idNumber: 'FC001', lastClubId: 'fc-b' });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true });
    const p = await findPlayer('fc', 'fc-a', 'FC001');
    assert.equal(p?.status, 'active');
    assert.equal(p?.lastClub, 'Beta High');
    assert.deepEqual(await repo.listAllClearances('fc'), []);
    assert.deepEqual(await repo.listAllReviews('fc'), []);
  });

  test('off-system typed previous school → active, no registration review', async () => {
    const res = await register('fc-a', { idNumber: 'FC002', lastClub: 'Ghost High' });
    assert.equal(res.status, 201);
    assert.equal((await findPlayer('fc', 'fc-a', 'FC002'))?.status, 'active');
    assert.deepEqual(await repo.listAllReviews('fc'), []);
  });

  test('active at another school → registered here, old roster row deactivated, both noted', async () => {
    assert.equal((await register('fc-b', { idNumber: 'FC003' })).status, 201);
    assert.equal((await findPlayer('fc', 'fc-b', 'FC003'))?.status, 'active');

    const res = await register('fc-a', { idNumber: 'FC003', lastClubId: 'fc-b' });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true });
    const moved = await findPlayer('fc', 'fc-a', 'FC003');
    const old = await findPlayer('fc', 'fc-b', 'FC003');
    assert.equal(moved?.status, 'active');
    assert.equal(moved?.lastClub, 'Beta High');
    assert.match(moved?.transferNote ?? '', /Transferred from Beta High/);
    assert.equal(old?.status, 'inactive');
    assert.match(old?.transferNote ?? '', /Moved to Alpha High/);
    assert.deepEqual(await repo.listAllClearances('fc'), []);
    assert.deepEqual(await repo.listAllReviews('fc'), []);
  });

  test('positions: a known position is stored, an unknown one is 400', async () => {
    assert.equal((await register('fc-a', { idNumber: 'FC004', position: 'Striker' })).status, 201);
    assert.equal((await findPlayer('fc', 'fc-a', 'FC004'))?.position, 'Striker');
    assert.equal(
      (await register('fc-a', { idNumber: 'FC005', position: 'Wicketkeeper' })).status,
      400,
    );

    const portal = (position: string) =>
      app.request('/clubs/fc-a/players', {
        method: 'POST',
        headers: headers(FC_ADMIN, 'fc'),
        body: JSON.stringify({
          firstName: 'Pat',
          lastName: `Keeper${position.length}`,
          idType: 'passport',
          idNumber: `FCP${position.length}`,
          dob: '2001-01-01',
          nationality: 'South African',
          race: 'African',
          gender: 'Female',
          cell: '0820000001',
          team: 'u16',
          district: 'North',
          position,
        }),
      });
    assert.equal((await portal('Bowler')).status, 400);
    const ok = await portal('Goalkeeper');
    assert.equal(ok.status, 201);
    assert.equal(((await ok.json()) as { position?: string }).position, 'Goalkeeper');
  });
});

describe('registration with the clearances module on (cricket) is unchanged', () => {
  test('declared previous club still opens a pending clearance; positions are not stored', async () => {
    const res = await register('dv-a', {
      idNumber: 'DV001',
      lastClubId: 'dv-b',
      position: 'Striker',
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), {
      ok: true,
      clearance: { fromClubName: 'Vertical B CC' },
    });
    const p = await findPlayer('dolphins', 'dv-a', 'DV001');
    assert.equal(p?.status, 'clearance-pending');
    assert.equal(p?.position, undefined);
    assert.equal(p?.transferNote, undefined);
    const clearances = (await repo.listAllClearances('dolphins')).filter(
      (cl) => cl.idNumber === 'DV001',
    );
    assert.equal(clearances.length, 1);
  });

  test('active at another club still opens a clearance and leaves the source row active', async () => {
    assert.equal((await register('dv-b', { idNumber: 'DV002' })).status, 201);
    const res = await register('dv-a', { idNumber: 'DV002', lastClubId: 'dv-b' });
    assert.equal(res.status, 201);
    assert.equal((await findPlayer('dolphins', 'dv-a', 'DV002'))?.status, 'clearance-pending');
    const src = await findPlayer('dolphins', 'dv-b', 'DV002');
    assert.notEqual(src?.status, 'inactive');
    assert.equal(src?.transferNote, undefined);
  });
});
