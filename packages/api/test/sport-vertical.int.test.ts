/**
 * Integration tests for the sport vertical (plan 1A/1B): the operator-only sport/seasonLabel
 * fields, the module 403 guards, player positions, and the registration write path with the
 * clearances module off (no clearances, no reviews; a player registered elsewhere is noted on
 * the new row and the other club's roster is never touched).
 *
 * Boots an in-process dynalite, seeds the cricket 'dolphins' tenant plus a football 'fc'
 * tenant, and drives the REAL Hono app via `app.request()` (LOCAL_AUTH dev bypass).
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

const DDB_PORT = 4657; // unique: next free odd port after season-live-calendar (4655)
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

/** A chair/admin portal registration (POST /clubs/:id/players) with the same base identity. */
async function portalRegister(
  tenant: string,
  auth: string,
  clubId: string,
  extra: Record<string, unknown>,
) {
  const tenantCfg = await repo.getTenantConfig(tenant);
  return app.request(`/clubs/${clubId}/players`, {
    method: 'POST',
    headers: headers(auth, tenant),
    body: JSON.stringify({
      firstName: 'Cam',
      lastName: 'Portal',
      idType: 'passport',
      dob: '2000-01-01',
      nationality: 'South African',
      race: 'African',
      gender: 'Male',
      cell: '0820000003',
      team: tenantCfg?.leagues?.[0]?.key ?? 'u15',
      district: 'North',
      ...extra,
    }),
  });
}

const CRICKET_PROFILE = {
  battingHand: 'Left',
  bowlingHand: 'Right',
  battingType: 'Top order',
  bowlerType: 'Fast',
  isAllRounder: true,
  isWk: true,
};

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
    assert.equal((await put({ seasonLabel: '   ' })).status, 400, 'whitespace-only is junk');
    assert.equal((await put({ sport: 'cricket', seasonLabel: ' 2026/27 ' })).status, 200);
    const cfg = await repo.getTenantConfig('dolphins');
    assert.equal(cfg?.sport, 'cricket');
    assert.equal(cfg?.seasonLabel, '2026/27');
  });

  test('PUT /platform/tenants/:slug clears the season label with null or an empty string', async () => {
    const put = (body: Record<string, unknown>) =>
      app.request('/platform/tenants/dolphins', {
        method: 'PUT',
        headers: headers(OPERATOR, 'dolphins'),
        body: JSON.stringify(body),
      });
    for (const clear of [null, '']) {
      assert.equal((await put({ seasonLabel: '2031' })).status, 200);
      assert.equal((await repo.getTenantConfig('dolphins'))?.seasonLabel, '2031');
      const res = await put({ seasonLabel: clear });
      assert.equal(res.status, 200, `clear with ${JSON.stringify(clear)}`);
      assert.equal(((await res.json()) as Record<string, unknown>).seasonLabel, undefined);
      const cfg = await repo.getTenantConfig('dolphins');
      assert.equal(cfg?.seasonLabel, undefined);
      assert.ok(cfg && !('seasonLabel' in cfg), 'the attribute is removed, not stored blank');
      const pub = (await (await app.request('/tenant?tenant=dolphins')).json()) as Record<
        string,
        unknown
      >;
      assert.equal(pub.seasonLabel, undefined, 'GET /tenant falls back (no configured label)');
    }
    // An unrelated operator save leaves the (absent) label absent.
    assert.equal((await put({ sport: 'cricket' })).status, 200);
    assert.equal((await repo.getTenantConfig('dolphins'))?.seasonLabel, undefined);
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

  test('active at another school → registered here with a note; the other roster is NOT touched', async () => {
    assert.equal((await register('fc-b', { idNumber: 'FC003' })).status, 201);
    const before = await findPlayer('fc', 'fc-b', 'FC003');
    assert.equal(before?.status, 'active');

    const res = await register('fc-a', { idNumber: 'FC003', lastClubId: 'fc-b' });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true });
    const here = await findPlayer('fc', 'fc-a', 'FC003');
    assert.equal(here?.status, 'active');
    assert.equal(here?.lastClub, 'Beta High');
    assert.equal(here?.transferNote, 'Previously registered at Beta High.');
    // An unauthenticated link must never write another school's roster: the old row is
    // byte-for-byte what it was (admins resolve the duplicate by hand).
    assert.deepEqual(await findPlayer('fc', 'fc-b', 'FC003'), before);
    assert.deepEqual(await repo.listAllClearances('fc'), []);
    assert.deepEqual(await repo.listAllReviews('fc'), []);
  });

  test('a row left clearance-pending when the module was switched off does not strand the player', async () => {
    const putFeatures = (features: Record<string, boolean>) =>
      app.request('/platform/tenants/fc', {
        method: 'PUT',
        headers: headers(OPERATOR, 'fc'),
        body: JSON.stringify({ features }),
      });
    // Module ON: declaring Alpha High as the previous school opens a clearance and leaves the
    // Beta High row clearance-pending.
    assert.equal(
      (await putFeatures({ whatsappInvites: false, 'module.clearances': true })).status,
      200,
    );
    try {
      const opened = await register('fc-b', { idNumber: 'FC006', lastClubId: 'fc-a' });
      assert.equal(opened.status, 201);
      assert.equal((await findPlayer('fc', 'fc-b', 'FC006'))?.status, 'clearance-pending');
    } finally {
      assert.equal((await putFeatures({ whatsappInvites: false })).status, 200);
    }
    const pending = await findPlayer('fc', 'fc-b', 'FC006');
    const clearancesBefore = await repo.listAllClearances('fc');

    // Module OFF: the same identity registers at Alpha High — no 409, noted, pending row untouched.
    const res = await register('fc-a', { idNumber: 'FC006' });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true });
    const here = await findPlayer('fc', 'fc-a', 'FC006');
    assert.equal(here?.status, 'active');
    assert.equal(here?.transferNote, 'Previously registered at Beta High.');
    assert.equal(here?.lastClub, 'Beta High');
    assert.deepEqual(await findPlayer('fc', 'fc-b', 'FC006'), pending);
    assert.deepEqual(await repo.listAllClearances('fc'), clearancesBefore);
  });

  test('veterans module off: a posted veteransClubId is dropped on both registration paths', async () => {
    const res = await register('fc-a', { idNumber: 'FC007', veteransClubId: 'fc-b' });
    assert.equal(res.status, 201);
    const p = await findPlayer('fc', 'fc-a', 'FC007');
    assert.equal(p?.veteransClubId, undefined);
    assert.equal(p?.veteransClub, undefined);

    const portal = await app.request('/clubs/fc-a/players', {
      method: 'POST',
      headers: headers(FC_ADMIN, 'fc'),
      body: JSON.stringify({
        firstName: 'Vet',
        lastName: 'Portal',
        idType: 'passport',
        idNumber: 'FC008',
        dob: '1980-01-01',
        nationality: 'South African',
        race: 'African',
        gender: 'Male',
        cell: '0820000002',
        team: 'u16',
        district: 'North',
        veteransClubId: 'fc-b',
      }),
    });
    assert.equal(portal.status, 201);
    const body = (await portal.json()) as Record<string, unknown>;
    assert.equal(body.veteransClubId, undefined);
    assert.equal((await findPlayer('fc', 'fc-a', 'FC008'))?.veteransClubId, undefined);
    assert.deepEqual(await repo.listVeteransAffiliations('fc', 'fc-b'), []);
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

  test('posted cricket playing-profile fields are not stored on a positions tenant', async () => {
    const res = await register('fc-a', {
      idNumber: 'FC009',
      position: 'Striker',
      battingHand: 'Left',
      bowlingHand: 'Right',
      battingType: 'Top order',
      bowlerType: 'Fast',
      isAllRounder: true,
      isWk: true,
    });
    assert.equal(res.status, 201);
    const p = await findPlayer('fc', 'fc-a', 'FC009');
    assert.equal(p?.position, 'Striker');
    assert.equal(p?.battingHand, undefined);
    assert.equal(p?.bowlingHand, undefined);
    assert.equal(p?.battingType, undefined);
    assert.equal(p?.bowlerType, undefined);
    assert.equal(p?.isAllRounder, undefined);
    assert.equal(p?.isWk, undefined);
  });

  test('the chair route also drops posted cricket playing-profile fields on a positions tenant', async () => {
    const res = await portalRegister('fc', FC_ADMIN, 'fc-a', {
      idNumber: 'FC010',
      position: 'Striker',
      ...CRICKET_PROFILE,
    });
    assert.equal(res.status, 201);
    const p = await findPlayer('fc', 'fc-a', 'FC010');
    assert.equal(p?.position, 'Striker');
    for (const k of Object.keys(CRICKET_PROFILE)) {
      assert.equal(p?.[k as keyof typeof p], undefined, k);
    }
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

  test('veterans module on: a declared veterans club is stored and affiliated', async () => {
    const res = await register('dv-a', { idNumber: 'DV003', veteransClubId: 'dv-b' });
    assert.equal(res.status, 201);
    const p = await findPlayer('dolphins', 'dv-a', 'DV003');
    assert.equal(p?.status, 'active');
    assert.equal(p?.veteransClubId, 'dv-b');
    assert.equal(p?.veteransClub, 'Vertical B CC');
    const affs = await repo.listVeteransAffiliations('dolphins', 'dv-b');
    assert.ok(affs.some((a) => a.naturalKey === p?.naturalKey && a.primaryClubId === 'dv-a'));
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

  test('cricket playing-profile fields are still stored on a cricket tenant', async () => {
    const res = await register('dv-a', {
      idNumber: 'DV004',
      battingHand: 'Left',
      bowlerType: 'Fast',
      isWk: true,
    });
    assert.equal(res.status, 201);
    const p = await findPlayer('dolphins', 'dv-a', 'DV004');
    assert.equal(p?.battingHand, 'Left');
    assert.equal(p?.bowlerType, 'Fast');
    assert.equal(p?.isWk, true);
    assert.equal(p?.isAllRounder, false);
  });

  test('the chair route still stores cricket playing-profile fields on a cricket tenant', async () => {
    const res = await portalRegister('dolphins', DOL_ADMIN, 'dv-a', {
      idNumber: 'DV005',
      ...CRICKET_PROFILE,
    });
    assert.equal(res.status, 201);
    const p = await findPlayer('dolphins', 'dv-a', 'DV005');
    for (const [k, v] of Object.entries(CRICKET_PROFILE)) {
      assert.equal(p?.[k as keyof typeof p], v, k);
    }
  });
});

describe('POST /clubs/:id/exco — required office bearers + per-role merge', () => {
  const role = (who: string) => ({ name: `${who} Person`, cell: '0821112222', email: `${who}@x` });
  const postExco = (tenant: string, auth: string, clubId: string, body: unknown) =>
    app.request(`/clubs/${clubId}/exco`, {
      method: 'POST',
      headers: headers(auth, tenant),
      body: JSON.stringify(body),
    });

  test('football: a roster without the Director of Academics is 400 and nothing is written', async () => {
    await repo.createClub('fc', mkClub('fc-exco-a', 'Exco A High'));
    const res = await postExco('fc', FC_ADMIN, 'fc-exco-a', {
      chair: role('Principal'),
      sec: role('Sport'),
      tre: role('Football'),
    });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(await res.json()), /Director of Academics/);
    assert.equal((await repo.getClub('fc', 'fc-exco-a'))?.exco, undefined);
  });

  test('football: a full roster saves; a name-only edit keeps the stored chair governance fields', async () => {
    await repo.createClub('fc', {
      ...mkClub('fc-exco-b', 'Exco B High'),
      exco: {
        chair: {
          ...role('Principal'),
          idNumber: '8001015009087',
          termStart: '2024-01-01',
          termEnd: '2027-12-31',
        },
      },
    });
    const res = await postExco('fc', FC_ADMIN, 'fc-exco-b', {
      chair: { name: 'New Principal', cell: '0821112222', email: 'p@x', gender: '', race: '' },
      sec: role('Sport'),
      tre: role('Football'),
      vc: role('Academics'),
    });
    assert.equal(res.status, 200);
    const chair = (await repo.getClub('fc', 'fc-exco-b'))?.exco?.chair as Record<string, unknown>;
    assert.equal(chair.name, 'New Principal');
    assert.equal(chair.idNumber, '8001015009087', 'stored governance field survives the merge');
    assert.equal(chair.termEnd, '2027-12-31');
  });

  test('null clears a non-required role entirely; nulling or blanking a required role is 400', async () => {
    await repo.createClub('dolphins', {
      ...mkClub('dv-exco', 'Exco CC'),
      exco: {
        chair: role('Chair'),
        sec: role('Sec'),
        tre: role('Tre'),
        vc: { ...role('Vice'), gender: 'Female' },
      },
    });
    // Cricket's Vice-Chair stays optional: null removes the whole role (POPIA erasure).
    const cleared = await postExco('dolphins', DOL_ADMIN, 'dv-exco', { vc: null });
    assert.equal(cleared.status, 200);
    const exco = (await repo.getClub('dolphins', 'dv-exco'))?.exco as Record<string, unknown>;
    assert.equal('vc' in exco, false);
    assert.equal((exco.chair as { name: string }).name, 'Chair Person', 'absent roles are kept');

    // The combined stored+incoming roster must still carry every required role.
    assert.equal((await postExco('dolphins', DOL_ADMIN, 'dv-exco', { sec: null })).status, 400);
    assert.equal(
      (await postExco('dolphins', DOL_ADMIN, 'dv-exco', { tre: { email: '  ' } })).status,
      400,
    );
    assert.equal((await postExco('dolphins', DOL_ADMIN, 'dv-exco', ['nope'])).status, 400);
    const after = (await repo.getClub('dolphins', 'dv-exco'))?.exco as Record<string, unknown>;
    assert.equal(
      (after.sec as { name: string }).name,
      'Sec Person',
      'rejected saves write nothing',
    );
  });
});
