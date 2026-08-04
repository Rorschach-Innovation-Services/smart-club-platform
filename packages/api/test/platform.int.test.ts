/**
 * Integration tests for the platform-operator surface (Phase 2):
 *   - /platform/* auth gate (401 / 403 / operator pass)
 *   - tenant create → list → get → patch flow, dup-slug 409, slug validation 400s
 *   - registry-GSI persistence across whole-item config Puts (the delisting regression)
 *   - reconcileUserMarkers PLATFORM_TENANT ('*') skip, both directions
 *   - grantTenantAdmin via POST /platform/tenants/:slug/admins (offline Cognito stub)
 *   - logo-upload presigned POST policy, DNS instruction sheet
 *   - seed demotion (create-if-absent vs --force overwrite)
 *
 * Same harness as api.int.test.ts: in-process dynalite + the real Hono app via
 * app.request(), auth via the LOCAL_AUTH x-dev-auth bypass.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load,
// index.ts reads TUTORIALS_BASE_URL / TUTORIALS_BUCKET at module load.
const DDB_PORT = 4601; // distinct from api.int.test.ts (4599) — files can run in parallel
const TABLE = 'SmartClubPlatformTest';
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.LOCAL_AUTH = '1';
process.env.STAGE = 'local';
process.env.USER_POOL_ID = 'test-pool';
process.env.AWS_REGION ??= 'localhost';
process.env.UPLOADS_BUCKET = 'test-uploads';
process.env.TUTORIALS_BUCKET = 'test-tutorials';
process.env.TUTORIALS_BASE_URL = 'https://tutorials.test';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_MAX_ATTEMPTS = '1';

const devAuthAs = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const OPERATOR = devAuthAs('op-1', 'operator@platform', [
  { tenantId: '*', role: 'operator', clubIds: [] },
]);
const DOLPHINS_ADMIN = devAuthAs('adm-1', 'admin@test', [
  { tenantId: 'dolphins', role: 'admin', clubIds: [] },
]);

const platformHeaders = (auth: string) => ({
  'x-dev-auth': auth,
  'content-type': 'application/json',
});
const tenantHeaders = (auth: string, tenant: string) => ({
  'x-tenant': tenant,
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

// Resolved in before().
let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let seed: typeof import('../src/seed-core.js');

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

  seed = await import('../src/seed-core.js');
  await seed.seedTenantConfig('dolphins');
  ({ app } = await import('../src/index.js'));
  repo = await import('../src/repo.js');
});

after(() => {
  ddbServer?.close();
});

describe('platform auth gate', () => {
  test('unauthenticated → 401', async () => {
    const res = await app.request('/platform/tenants');
    assert.equal(res.status, 401);
  });

  test('tenant admin without the * membership → 403', async () => {
    const res = await app.request('/platform/tenants', {
      headers: platformHeaders(DOLPHINS_ADMIN),
    });
    assert.equal(res.status, 403);
  });

  test('rep with a literal "*" tenantId but wrong role → 403', async () => {
    const sneaky = devAuthAs('x', 'x@test', [{ tenantId: '*', role: 'admin', clubIds: [] }]);
    const res = await app.request('/platform/tenants', { headers: platformHeaders(sneaky) });
    assert.equal(res.status, 403);
  });

  test('operator membership passes', async () => {
    const res = await app.request('/platform/tenants', { headers: platformHeaders(OPERATOR) });
    assert.equal(res.status, 200);
  });
});

describe('tenant create → list → get → patch', () => {
  test('POST /platform/tenants creates with seed-parity defaults', async () => {
    const res = await app.request('/platform/tenants', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        slug: 'sharks',
        branding: { name: 'Hollywoodbets Sharks' },
        submissionDeadline: '2026-09-30',
        features: { whatsappInvites: false },
      }),
    });
    assert.equal(res.status, 201);
    const cfg = (await res.json()) as import('../src/types.js').TenantConfig;
    assert.equal(cfg.tenant, 'sharks');
    assert.equal(cfg.branding.name, 'Hollywoodbets Sharks');
    assert.equal(cfg.branding.title, 'Hollywoodbets Sharks'); // title ← name default
    assert.equal(cfg.branding.copy.footer, 'Powered by Medicoach');
    // Role-token era (semantic theming): the neutral family seeds --brand-* tokens.
    assert.ok(cfg.branding.colors['--brand-primary'], 'neutral color family seeded');
    assert.deepEqual(cfg.features, { whatsappInvites: false });
    assert.deepEqual(cfg.leagues, []);
    // Explicit [] (not field-absent): a portal-created client opts OUT of the
    // legacy DEFAULT_DISTRICTS fallback — signup is blocked until configured.
    assert.deepEqual(cfg.districts, []);
  });

  test('duplicate slug → 409', async () => {
    const res = await app.request('/platform/tenants', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        slug: 'sharks',
        branding: { name: 'Sharks Again' },
        submissionDeadline: '2026-09-30',
      }),
    });
    assert.equal(res.status, 409);
  });

  // NOTE: uppercase input is normalized (lowercased) before validation, so it is
  // NOT invalid — 'SHARKS' would collide with 'sharks' (409), tested above.
  for (const slug of ['sh@rks', '1bad', 'a', '-x', 'has space', 'x'.repeat(33)]) {
    test(`invalid slug "${slug}" → 400`, async () => {
      const res = await app.request('/platform/tenants', {
        method: 'POST',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({ slug, branding: { name: 'X' }, submissionDeadline: '2026-09-30' }),
      });
      assert.equal(res.status, 400);
    });
  }

  for (const slug of ['www', 'api', 'platform', 'admin']) {
    test(`reserved slug "${slug}" → 400`, async () => {
      const res = await app.request('/platform/tenants', {
        method: 'POST',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({ slug, branding: { name: 'X' }, submissionDeadline: '2026-09-30' }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /reserved/);
    });
  }

  test('missing branding.name → 400', async () => {
    const res = await app.request('/platform/tenants', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ slug: 'nameless', submissionDeadline: '2026-09-30' }),
    });
    assert.equal(res.status, 400);
  });

  test('missing/invalid submissionDeadline → 400', async () => {
    const res = await app.request('/platform/tenants', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ slug: 'undated', branding: { name: 'X' } }),
    });
    assert.equal(res.status, 400);
  });

  test('GET /platform/tenants lists the projection, sorted by slug', async () => {
    const res = await app.request('/platform/tenants', { headers: platformHeaders(OPERATOR) });
    assert.equal(res.status, 200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    const slugs = rows.map((r) => r.tenant);
    assert.ok(slugs.includes('dolphins') && slugs.includes('sharks'));
    assert.deepEqual(slugs, [...slugs].sort());
    const sharks = rows.find((r) => r.tenant === 'sharks')!;
    assert.deepEqual(Object.keys(sharks).sort(), [
      'adminCount',
      'clubCount',
      'features',
      'logoUrl',
      'name',
      'playerCount',
      'submissionDeadline',
      'teamCount',
      'tenant',
      'title',
    ]);
    assert.equal(sharks.adminCount, 0);
    // Fresh tenant: fleet rollup counts start at zero.
    assert.equal(sharks.clubCount, 0);
    assert.equal(sharks.teamCount, 0);
    assert.equal(sharks.playerCount, 0);
  });

  test('GET /platform/tenants/:slug/overview sanitizes clubs and rolls up counts', async () => {
    // A club carrying every sensitive field the projection must strip.
    await repo.createClub('sharks', {
      id: 'leaky',
      name: 'Leaky CC',
      district: 'Test District',
      sub: 'rep-sub',
      chair: 'Chair Person',
      affiliation: 'complete' as const,
      cqi: 75,
      docs: { constitution: true },
      players: 0,
      playerCount: 7,
      teams: 0,
      women: 0,
      juniors: 0,
      color: '#123456',
      ground: { venue: 'Secret Oval', address: '1 Private Rd' },
      leagues: ['premier', 'u13'],
      leagueTeams: { premier: 3 },
      // Named sides carry venue/address/coords the projection must strip to {id,name}.
      teamRosters: {
        premier: [
          {
            id: 'tm_a',
            name: 'Leaky A',
            venue: 'Hidden Nets',
            address: '2 Secret St',
            lat: -29.1,
            lon: 31.1,
          },
          { id: 'tm_b', name: 'Leaky B' },
        ],
      },
      exco: {
        chair: {
          name: 'Chair Person',
          email: 'chair@leaky.test',
          cell: '0821112222',
          idNumber: '900101',
        },
      },
      notes: [{ id: 'n1', text: 'internal admin note', author: 'a', at: '2026-06-01' }],
      playerRegLink: { token: 'live-secret-token', createdAt: '2026-06-01' },
      docMeta: { constitution: { objectKey: 'sharks/leaky/const.pdf', size: 1 } },
      cqiAnswers: { q1: 'answer' },
      version: 1,
    } as unknown as Parameters<typeof repo.createClub>[1]);

    // One REAL player row (bumps the denormalized counter 7 → 8): feeds the
    // demographics assertions below. Its team key is not in sharks' (empty)
    // catalogue, so it lands in `unattributed`, never in `perLeague`.
    await repo.createPlayer('sharks', {
      naturalKey: 'demo-1',
      clubId: 'leaky',
      firstName: 'Demo',
      lastName: 'Player',
      dob: '1990-05-05',
      gender: 'Male',
      race: 'African',
      team: 'premier',
      isMinor: false,
      consentAt: '2026-06-01T00:00:00.000Z',
      createdAt: '2026-06-01T00:00:00.000Z',
    });

    // finally, not inline: an assertion failure must still erase the club, or the
    // leak cascades into the later sharks count assertions and buries the real error.
    try {
      const res = await app.request('/platform/tenants/sharks/overview', {
        headers: platformHeaders(OPERATOR),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        clubs: Array<Record<string, unknown>>;
        clearances: unknown[];
        leagues: unknown[];
        districts: string[];
        demographics: {
          totalPlayers: number;
          ageGroups: unknown[];
          gender: Array<{ label: string; count: number }>;
          race: unknown[];
          perLeague: Record<string, unknown>;
          unattributed: { totalPlayers: number };
        };
      };
      const club = body.clubs.find((c) => c.id === 'leaky')!;
      // Allowlist projection — nothing sensitive may ride along (POPIA + live token).
      assert.deepEqual(Object.keys(club).sort(), [
        'affiliation',
        'chair',
        'chairContact',
        'cqi',
        'district',
        'docs',
        'id',
        'leagueTeams',
        'leagues',
        'name',
        'players',
        'teamRosters',
      ]);
      assert.equal(club.players, 8); // denormalized playerCount (7 seeded + 1 real row)
      // Chair contact crosses picked field-by-field — the idNumber must not.
      assert.deepEqual(club.chairContact, {
        name: 'Chair Person',
        email: 'chair@leaky.test',
        cell: '0821112222',
      });
      // Rosters are stripped to {id,name} — no venue/address/coords.
      assert.deepEqual(club.teamRosters, {
        premier: [
          { id: 'tm_a', name: 'Leaky A' },
          { id: 'tm_b', name: 'Leaky B' },
        ],
      });
      assert.ok(Array.isArray(body.clearances));

      // Demographics ride the overview payload: buckets only, counted from REAL
      // player rows (1) — expected to drift from the denormalized `players` (8).
      assert.equal(body.demographics.totalPlayers, 1);
      assert.equal(body.demographics.unattributed.totalPlayers, 1);
      assert.deepEqual(body.demographics.perLeague, {}); // orphaned key ≠ a perLeague entry
      assert.ok(!('unattributed' in body.demographics.perLeague));
      assert.equal(body.demographics.gender.find((g) => g.label === 'Male')?.count, 1);

      // The list rollup reflects the same club: 3 premier sides + 1 u13 default.
      const list = await app.request('/platform/tenants', { headers: platformHeaders(OPERATOR) });
      const row = ((await list.json()) as Array<Record<string, unknown>>).find(
        (r) => r.tenant === 'sharks',
      )!;
      assert.equal(row.clubCount, 1);
      assert.equal(row.teamCount, 4);
      assert.equal(row.playerCount, 8); // 7 seeded on the counter + 1 real registration
    } finally {
      // Erase via the real cascade so later sharks count assertions stay unaffected.
      const leaky = await repo.getClub('sharks', 'leaky');
      if (leaky) await repo.eraseClubData('sharks', leaky);
    }
  });

  test('overview: unknown slug → 404, tenant admin → 403', async () => {
    const missing = await app.request('/platform/tenants/ghost/overview', {
      headers: platformHeaders(OPERATOR),
    });
    assert.equal(missing.status, 404);
    const forbidden = await app.request('/platform/tenants/dolphins/overview', {
      headers: platformHeaders(DOLPHINS_ADMIN),
    });
    assert.equal(forbidden.status, 403);
  });

  test('GET /platform/tenants/:slug returns the full config; unknown → 404', async () => {
    const ok = await app.request('/platform/tenants/sharks', {
      headers: platformHeaders(OPERATOR),
    });
    assert.equal(ok.status, 200);
    const cfg = (await ok.json()) as import('../src/types.js').TenantConfig;
    assert.equal(cfg.branding.name, 'Hollywoodbets Sharks');
    assert.equal(cfg.submissionDeadline, '2026-09-30');

    const missing = await app.request('/platform/tenants/ghost', {
      headers: platformHeaders(OPERATOR),
    });
    assert.equal(missing.status, 404);
  });

  test('PUT /platform/tenants/:slug merge-patches whitelisted fields only', async () => {
    const res = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        submissionDeadline: '2026-10-31',
        features: { whatsappInvites: true },
        adminCount: 99, // outside the whitelist — must be ignored
      }),
    });
    assert.equal(res.status, 200);
    const cfg = (await res.json()) as import('../src/types.js').TenantConfig;
    assert.equal(cfg.submissionDeadline, '2026-10-31');
    assert.deepEqual(cfg.features, { whatsappInvites: true });
    assert.equal(cfg.branding.name, 'Hollywoodbets Sharks'); // untouched
    const stored = await repo.getTenantConfig('sharks');
    assert.notEqual(stored?.adminCount, 99);
  });

  test('PUT /platform/tenants/:slug knownClubs: persists normalized entries, rejects junk', async () => {
    // Ids are derived server-side from the trimmed name — a client-sent id is ignored.
    const ok = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        knownClubs: [{ name: '  Kingsmead CC ', id: 'evil-id' }, { name: 'Umbilo United' }],
      }),
    });
    assert.equal(ok.status, 200);
    const stored = await repo.getTenantConfig('sharks');
    assert.deepEqual(stored?.knownClubs, [
      { id: 'kingsmead-cc', name: 'Kingsmead CC' },
      { id: 'umbilo-united', name: 'Umbilo United' },
    ]);

    // Shape junk → 400 (this payload used to be silently ignored pre-directory).
    const junk = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ knownClubs: [{ evil: true }] }),
    });
    assert.equal(junk.status, 400);

    // Two names that slug identically are the SAME directory club → 409.
    const dupes = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ knownClubs: [{ name: 'Kingsmead CC' }, { name: 'Kingsmead-CC' }] }),
    });
    assert.equal(dupes.status, 409);
  });

  test('PUT /platform/tenants/:slug on unknown tenant → 404', async () => {
    const res = await app.request('/platform/tenants/ghost', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ submissionDeadline: '2026-10-31' }),
    });
    assert.equal(res.status, 404);
  });

  test('PUT /platform/tenants/:slug with an unparseable deadline → 400', async () => {
    const res = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ submissionDeadline: 'not-a-date' }),
    });
    assert.equal(res.status, 400);
    const stored = await repo.getTenantConfig('sharks');
    assert.equal(stored?.submissionDeadline, '2026-10-31'); // untouched
  });

  // ── Operator-managed league catalogue (order-dependent: builds on 'sharks' above,
  //    resets leagues to [] at the end so later describes see clean shared state). ──

  const LEAGUES = [
    { key: 'premier', label: 'Premier League', group: 'Senior Leagues', district: 'All districts' },
    { key: 'reserve', label: 'Reserve League', group: 'Senior Leagues', district: 'All districts' },
  ];

  test('PUT /platform/tenants/:slug leagues round-trips and persists', async () => {
    const res = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ leagues: LEAGUES }),
    });
    assert.equal(res.status, 200);
    const cfg = (await res.json()) as import('../src/types.js').TenantConfig;
    assert.deepEqual(cfg.leagues, LEAGUES);
    const stored = await repo.getTenantConfig('sharks');
    assert.deepEqual(stored?.leagues, LEAGUES);
  });

  // Error bodies are asserted so the shape 400s can't regress into the delete
  // guard's "clubs are registered" 409 (validation must run before the guard).
  for (const [name, leagues, status, message] of [
    ['a duplicate league key', [...LEAGUES, { ...LEAGUES[0] }], 409, /duplicate league key/],
    ['a blank label', [{ ...LEAGUES[0], label: '  ' }], 400, /needs a label/],
    ['a non-string key', [{ ...LEAGUES[0], key: 7 }], 400, /needs a key/],
    ['a non-array payload', { premier: true }, 400, /must be an array/],
  ] as const) {
    test(`PUT /platform/tenants/:slug leagues with ${name} → ${status}`, async () => {
      const res = await app.request('/platform/tenants/sharks', {
        method: 'PUT',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({ leagues }),
      });
      assert.equal(res.status, status);
      assert.match(((await res.json()) as { error: string }).error, message);
      const stored = await repo.getTenantConfig('sharks');
      assert.deepEqual(stored?.leagues, LEAGUES); // untouched
    });
  }

  test('operator delete guard: dropping a league clubs reference → 409; unreferenced → 200', async () => {
    await repo.createClub('sharks', {
      id: 'guardcc',
      name: 'Guard CC',
      district: 'Test District',
      sub: '',
      chair: 'Carlton',
      affiliation: 'not_started',
      cqi: 0,
      docs: {},
      players: 0,
      teams: 0,
      women: 0,
      juniors: 0,
      color: '#123456',
      ground: {},
      leagues: ['premier'],
      version: 1,
    } as unknown as import('../src/types.js').Club);

    // 'premier' is referenced by guardcc — removing it must be rejected with the count.
    const blocked = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ leagues: LEAGUES.filter((l) => l.key !== 'premier') }),
    });
    assert.equal(blocked.status, 409);
    const err = (await blocked.json()) as { error: string };
    assert.match(err.error, /1 club is registered for "Premier League"/);
    assert.deepEqual((await repo.getTenantConfig('sharks'))?.leagues, LEAGUES); // untouched

    // 'reserve' is unreferenced — removing it goes through.
    const ok = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ leagues: LEAGUES.filter((l) => l.key !== 'reserve') }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(
      (await repo.getTenantConfig('sharks'))?.leagues,
      LEAGUES.filter((l) => l.key !== 'reserve'),
    );
  });

  // The guardcc club row intentionally persists (leagues: []) — nothing later in
  // this file lists sharks clubs, and the dynalite instance is per-file.
  test('leagues cleanup: unreference then clear the catalogue', async () => {
    const guard = await repo.getClub('sharks', 'guardcc');
    assert.ok(guard);
    await repo.putClub('sharks', { ...guard, leagues: [] });
    const res = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ leagues: [] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await repo.getTenantConfig('sharks'))?.leagues, []);
  });

  // ── Operator-managed districts (order-dependent: continues on 'sharks', which now
  //    has leagues: [] and explicit districts: []; ends by resetting districts to []
  //    and guardcc to its original 'Test District'). ──

  const DISTRICTS2 = ['North', 'South'];

  test('PUT /platform/tenants/:slug districts round-trips and persists', async () => {
    const res = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ districts: DISTRICTS2 }),
    });
    assert.equal(res.status, 200);
    const cfg = (await res.json()) as import('../src/types.js').TenantConfig;
    assert.deepEqual(cfg.districts, DISTRICTS2);
    assert.deepEqual((await repo.getTenantConfig('sharks'))?.districts, DISTRICTS2);
  });

  // Error bodies asserted so the shape 400s can't regress into the referrer
  // guard's "still in use" 409 (validation must run before the guard).
  for (const [name, districts, status, message] of [
    ['a non-array payload', { north: true }, 400, /must be an array/],
    ['a blank entry', ['North', '  '], 400, /needs a name/],
    ['the reserved sentinel', ['North', 'All districts'], 400, /reserved/],
    // Names are stored trimmed, so the reserved check must compare trimmed too —
    // otherwise this persists and bricks the operator's next save.
    ['a whitespace-padded sentinel', ['North', ' All districts '], 400, /reserved/],
    ['a duplicate', ['North', 'North'], 409, /duplicate district/],
  ] as const) {
    test(`PUT /platform/tenants/:slug districts with ${name} → ${status}`, async () => {
      const res = await app.request('/platform/tenants/sharks', {
        method: 'PUT',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({ districts }),
      });
      assert.equal(res.status, status);
      assert.match(((await res.json()) as { error: string }).error, message);
      assert.deepEqual((await repo.getTenantConfig('sharks'))?.districts, DISTRICTS2); // untouched
    });
  }

  test('district names are stored trimmed', async () => {
    const res = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ districts: [' North ', 'South'] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await repo.getTenantConfig('sharks'))?.districts, DISTRICTS2);
  });

  test('league.district is validated against the tenant districts (+ sentinel)', async () => {
    const zonal = { key: 'zonal', label: 'Zonal League', group: 'Senior Leagues' };
    const bad = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ leagues: [{ ...zonal, district: 'East' }] }),
    });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /unknown district "East"/);
    assert.deepEqual((await repo.getTenantConfig('sharks'))?.leagues, []); // untouched

    const ok = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ leagues: [{ ...zonal, district: 'North' }] }),
    });
    assert.equal(ok.status, 200);
  });

  test('district referrer guard: club reference blocks removal', async (t) => {
    const guard = await repo.getClub('sharks', 'guardcc');
    assert.ok(guard);
    await repo.putClub('sharks', { ...guard, district: 'North' });
    // Restore guardcc BEFORE the league-referrer test even if an assertion below
    // fails — the 409 leaves it in 'North', which would otherwise wrongly block
    // the combined-patch 200 and cascade-fail the downstream tests.
    t.after(() => repo.putClub('sharks', { ...guard, district: 'Test District' }));
    const res = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      // Drops 'North' — referenced by guardcc AND the zonal league from above.
      body: JSON.stringify({ districts: ['South'] }),
    });
    assert.equal(res.status, 409);
    assert.match(
      ((await res.json()) as { error: string }).error,
      /"North" is still in use — 1 club and 1 league/,
    );
    assert.deepEqual((await repo.getTenantConfig('sharks'))?.districts, DISTRICTS2); // untouched
  });

  test('district referrer guard: league reference blocks removal; combined patch passes', async () => {
    // Only the zonal league references 'North' now.
    const blocked = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ districts: ['South'] }),
    });
    assert.equal(blocked.status, 409);
    assert.match(
      ((await blocked.json()) as { error: string }).error,
      /"North" is still in use — 0 clubs and 1 league/,
    );

    // One PUT may drop a district AND its leagues together — the guard evaluates
    // the post-patch league view, so this passes.
    const combined = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ districts: ['South'], leagues: [] }),
    });
    assert.equal(combined.status, 200);
    const stored = await repo.getTenantConfig('sharks');
    assert.deepEqual(stored?.districts, ['South']);
    assert.deepEqual(stored?.leagues, []);
  });

  test('districts cleanup: clear the catalogue', async () => {
    // Passes because the guard only checks REMOVED districts and guardcc's
    // 'Test District' was never in the catalogue (pre-existing orphan references
    // never block unrelated saves).
    const res = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ districts: [] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await repo.getTenantConfig('sharks'))?.districts, []);
  });

  // ── Catalogue size: no artificial count limit; only the DynamoDB 400KB item
  //    ceiling, which must degrade to a clear 400 rather than an opaque 500.
  //    NB sharks has explicit districts: [] here, so every league below must use
  //    the 'All districts' sentinel — any other district would 400 on validation
  //    before the size path is ever exercised. ──

  test('no count limit: 500 leagues save and round-trip', async (t) => {
    // Reset via t.after so a failed assertion can't leave 500 leagues on sharks
    // for the rest of this order-dependent file.
    t.after(async () => {
      const cfg = await repo.getTenantConfig('sharks');
      if (cfg) await repo.putTenantConfig({ ...cfg, leagues: [] });
    });
    const many = Array.from({ length: 500 }, (_, i) => ({
      key: `bulk-${i}`,
      label: `Bulk League ${i}`,
      group: 'Senior Leagues',
      district: 'All districts',
    }));
    const res = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ leagues: many }),
    });
    assert.equal(res.status, 200);
    assert.equal((await repo.getTenantConfig('sharks'))?.leagues?.length, 500);
  });

  test('DynamoDB item-size ceiling degrades to a clear 400, not a 500', async () => {
    // ~50 leagues × ~10KB notes ≈ 500KB — a legitimate payload (league fields
    // have no length caps) that exceeds the 400KB item limit, which dynalite
    // enforces with the same message as real DynamoDB.
    const huge = Array.from({ length: 50 }, (_, i) => ({
      key: `huge-${i}`,
      label: `Huge League ${i}`,
      group: 'Senior Leagues',
      district: 'All districts',
      note: 'x'.repeat(10_000),
    }));
    const res = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ leagues: huge }),
    });
    assert.equal(res.status, 400);
    // The message assertion matters: it distinguishes the ceiling 400 from a
    // wrong-reason validation 400.
    assert.match(((await res.json()) as { error: string }).error, /storage ceiling/);
    assert.deepEqual((await repo.getTenantConfig('sharks'))?.leagues, []); // untouched
  });
});

describe('registry GSI persistence (delisting regression)', () => {
  test('tenant stays listed after PUT /tenant/config (whole-item Put path)', async () => {
    const sharksAdmin = devAuthAs('adm-s', 'sharks-admin@test', [
      { tenantId: 'sharks', role: 'admin', clubIds: [] },
    ]);
    const res = await app.request('/tenant/config', {
      method: 'PUT',
      headers: tenantHeaders(sharksAdmin, 'sharks'),
      body: JSON.stringify({ submissionDeadline: '2026-11-30' }),
    });
    assert.equal(res.status, 200);
    const listed = await repo.listTenants();
    assert.ok(
      listed.some((t) => t.tenant === 'sharks'),
      'sharks must survive a whole-config save',
    );
  });

  test('tenant stays listed after a direct repo.putTenantConfig of a READ config', async () => {
    // stripKeys removes the gsi attrs on read — putTenantConfig must re-derive them.
    const cfg = await repo.getTenantConfig('sharks');
    assert.ok(cfg);
    await repo.putTenantConfig(cfg!);
    const listed = await repo.listTenants();
    assert.ok(listed.some((t) => t.tenant === 'sharks'));
  });

  test('ensureTenantConfigGsi backfills a pre-registry row', async () => {
    // Simulate a legacy row: write the CONFIG item raw, WITHOUT gsi attrs.
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, PutCommand } = await import('@aws-sdk/lib-dynamodb');
    const ddb = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        endpoint: process.env.DYNAMO_ENDPOINT,
        region: 'localhost',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          pk: 'TENANT#legacy',
          sk: 'CONFIG',
          tenant: 'legacy',
          branding: { name: 'Legacy', title: 'Legacy', logoUrl: '', colors: {}, copy: {} },
          submissionDeadline: '2026-09-30',
          knownClubs: [],
        },
      }),
    );
    assert.ok(!(await repo.listTenants()).some((t) => t.tenant === 'legacy'));
    await repo.ensureTenantConfigGsi('legacy');
    assert.ok((await repo.listTenants()).some((t) => t.tenant === 'legacy'));
  });
});

describe('tenant-admin PUT /tenant/config hardening', () => {
  const rawDdb = async () => {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
    return DynamoDBDocumentClient.from(
      new DynamoDBClient({
        endpoint: process.env.DYNAMO_ENDPOINT,
        region: 'localhost',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      }),
    );
  };

  test('pk/sk/gsi1* in the body cannot retarget another tenant row or the registry', async () => {
    const sharksBefore = await repo.getTenantConfig('sharks');
    const res = await app.request('/tenant/config', {
      method: 'PUT',
      headers: tenantHeaders(DOLPHINS_ADMIN, 'dolphins'),
      body: JSON.stringify({
        submissionDeadline: '2027-01-31',
        pk: 'TENANT#sharks', // key-override attempt: clobber sharks' row
        sk: 'CONFIG',
        gsi1pk: 'PLATFORM#TENANTS',
        gsi1sk: 'aaaa', // registry-corruption attempt: re-sort/delist
      }),
    });
    assert.equal(res.status, 200);

    // Own row updated in place…
    const dolphins = await repo.getTenantConfig('dolphins');
    assert.equal(dolphins?.submissionDeadline, '2027-01-31');
    // …the other tenant is untouched…
    assert.deepEqual(await repo.getTenantConfig('sharks'), sharksBefore);
    // …and the stored row keeps its derived keys (registry slug included).
    const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
    const raw = await (
      await rawDdb()
    ).send(new GetCommand({ TableName: TABLE, Key: { pk: 'TENANT#dolphins', sk: 'CONFIG' } }));
    assert.equal(raw.Item?.gsi1pk, 'PLATFORM#TENANTS');
    assert.equal(raw.Item?.gsi1sk, 'dolphins');
    const listed = await repo.listTenants();
    assert.ok(
      listed.some((t) => t.tenant === 'dolphins'),
      'dolphins still listed under its own slug',
    );
  });

  test('features/tutorials/tutorialsNoFallback/adminCount/districts are stripped from tenant-admin patches', async () => {
    const before = await repo.getTenantConfig('dolphins');
    const res = await app.request('/tenant/config', {
      method: 'PUT',
      headers: tenantHeaders(DOLPHINS_ADMIN, 'dolphins'),
      body: JSON.stringify({
        features: { selfServeBranding: true, whatsappInvites: false },
        tutorials: [{ key: 'evil', title: 'Evil', src: 'https://evil.example/x.mp4' }],
        tutorialsNoFallback: true,
        adminCount: 99,
        districts: ['Evil District'],
      }),
    });
    assert.equal(res.status, 200);
    const after = await repo.getTenantConfig('dolphins');
    assert.deepEqual(after?.features, before?.features, 'flags unchanged');
    assert.deepEqual(after?.tutorials, before?.tutorials);
    assert.equal(
      after?.tutorialsNoFallback,
      before?.tutorialsNoFallback,
      'tutorialsNoFallback unchanged (operator-only)',
    );
    assert.equal(after?.adminCount, before?.adminCount);
    assert.deepEqual(
      after?.districts,
      before?.districts,
      'district list unchanged (operator-only)',
    );
  });

  // Dolphins has NO districts field, so tenant-admin league writes validate against
  // the DEFAULT_DISTRICTS fallback union — a regression here would lock every
  // legacy-tenant admin out of league edits.
  test('tenant-admin league write validates district against the fallback union', async (t) => {
    const before = await repo.getTenantConfig('dolphins');
    assert.ok(before);
    t.after(() => repo.putTenantConfig(before)); // restore the seeded catalogue

    const newLeague = { key: 'hardening-lg', label: 'Hardening League', group: 'Senior Leagues' };
    const bad = await app.request('/tenant/config', {
      method: 'PUT',
      headers: tenantHeaders(DOLPHINS_ADMIN, 'dolphins'),
      body: JSON.stringify({
        leagues: [...(before.leagues ?? []), { ...newLeague, district: 'Atlantis' }],
      }),
    });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /unknown district "Atlantis"/);

    const ok = await app.request('/tenant/config', {
      method: 'PUT',
      headers: tenantHeaders(DOLPHINS_ADMIN, 'dolphins'),
      body: JSON.stringify({
        leagues: [...(before.leagues ?? []), { ...newLeague, district: 'KCCD' }],
      }),
    });
    assert.equal(ok.status, 200);
    const stored = await repo.getTenantConfig('dolphins');
    assert.ok(stored?.leagues?.some((l) => l.key === 'hardening-lg'));
  });

  // `applyTenantConfigPatch(tenant, patch, { preserveCompetitions: true })` — League
  // competitions (ADR 0008 format streams) are operator-only. A tenant-admin PUT can
  // still rename/reorder leagues, but whatever it sends for `competitions` must be
  // discarded in favour of what is already stored, never merged or unioned in.
  test('PUT /tenant/config never changes a league’s stored competitions', async (t) => {
    const before = await repo.getTenantConfig('dolphins');
    assert.ok(before);
    t.after(() => repo.putTenantConfig(before));

    const calendar = {
      id: 'preserve-comp-cal',
      label: '2026/27',
      blocks: [{ id: 'b1', label: 'Block 1', start: '2026-09-13', end: '2026-12-13' }],
    };
    const structure = {
      id: 'preserve-comp-st',
      name: 'Flat round robin',
      version: 1,
      stages: [
        {
          id: 'season',
          name: 'League season',
          format: { kind: 'round-robin', legs: 1 },
          entrants: { kind: 'all-registered' },
          schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
        },
      ],
    };
    const realCompetitions = [
      {
        id: 'comp-1',
        label: '50 Over',
        structureId: 'preserve-comp-st',
        calendarId: 'preserve-comp-cal',
      },
    ];
    const league = {
      key: 'preserve-comp-lg',
      label: 'Preserve Competitions League',
      group: 'Senior Leagues',
      district: 'KCCD',
      competitions: realCompetitions,
    };

    // Operator establishes the real binding first.
    const setup = await app.request('/platform/tenants/dolphins', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        calendars: [...(before.calendars ?? []), calendar],
        structures: [...(before.structures ?? []), structure],
        leagues: [...(before.leagues ?? []), league],
      }),
    });
    assert.equal(setup.status, 200);

    // Tenant admin tries to smuggle a different competitions array through a routine
    // rename patch — a plausible forgery, and the exact one ADR 0008 fences off.
    const forged = await app.request('/tenant/config', {
      method: 'PUT',
      headers: tenantHeaders(DOLPHINS_ADMIN, 'dolphins'),
      body: JSON.stringify({
        leagues: [
          ...(before.leagues ?? []),
          { ...league, label: 'Renamed by tenant admin', competitions: [] },
        ],
      }),
    });
    assert.equal(forged.status, 200);

    const stored = await repo.getTenantConfig('dolphins');
    const storedLeague = stored?.leagues?.find((l) => l.key === 'preserve-comp-lg');
    assert.ok(storedLeague, 'league itself still saved (rename honoured)');
    assert.equal(storedLeague?.label, 'Renamed by tenant admin', 'non-competition fields DO patch');
    assert.deepEqual(
      storedLeague?.competitions,
      realCompetitions,
      'competitions untouched by the tenant-admin patch, not emptied',
    );
  });
});

describe('reconcileUserMarkers PLATFORM_TENANT skip', () => {
  test('putUser with a * membership writes no TENANT#* marker', async () => {
    await repo.putUser({
      sub: 'op-2',
      email: 'op2@platform',
      memberships: [
        { tenantId: '*', role: 'operator', clubIds: [] },
        { tenantId: 'dolphins', role: 'admin', clubIds: [] },
      ],
      onboardingSeen: {},
    });
    const markers = await repo.queryAll({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': 'USER#op-2', ':s': 'TENANT#' },
    });
    assert.deepEqual(
      markers.map((m) => m.sk),
      ['TENANT#dolphins'],
    );
    // And the operator never surfaces in any tenant roster under '*'.
    const roster = await repo.listTenantUsers('*');
    assert.equal(roster.length, 0);
  });

  test('a stray TENANT#* marker is ignored by the revoked-delete loop', async () => {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, PutCommand } = await import('@aws-sdk/lib-dynamodb');
    const ddb = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        endpoint: process.env.DYNAMO_ENDPOINT,
        region: 'localhost',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      }),
    );
    // Legacy stray marker (as if written before the skip existed).
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { pk: 'USER#op-3', sk: 'TENANT#*', sub: 'op-3', email: 'op3@platform' },
      }),
    );
    // Reconcile with NO '*' membership — the revoked-delete loop must skip it.
    await repo.putUser({
      sub: 'op-3',
      email: 'op3@platform',
      memberships: [{ tenantId: 'dolphins', role: 'rep', clubIds: ['c1'] }],
      onboardingSeen: {},
    });
    const markers = await repo.queryAll({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': 'USER#op-3', ':s': 'TENANT#' },
    });
    assert.deepEqual(markers.map((m) => m.sk).sort(), ['TENANT#*', 'TENANT#dolphins']);
  });
});

describe('POST /platform/tenants/:slug/admins (grantTenantAdmin)', () => {
  test('grants the first admin: membership + adminCount recount', async () => {
    const res = await app.request('/platform/tenants/sharks/admins', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ email: 'Chair@Sharks.co.za ' }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      tenant: string;
      email: string;
      sub: string;
      adminCount: number;
    };
    assert.equal(body.tenant, 'sharks');
    assert.equal(body.email, 'chair@sharks.co.za'); // normalized
    assert.equal(body.adminCount, 1);

    const user = await repo.getUser(body.sub);
    assert.ok(
      user?.memberships.some((m) => m.tenantId === 'sharks' && m.role === 'admin'),
      'admin membership written',
    );
    const cfg = await repo.getTenantConfig('sharks');
    assert.equal(cfg?.adminCount, 1);
  });

  test('is idempotent per email (re-grant keeps adminCount at 1)', async () => {
    const res = await app.request('/platform/tenants/sharks/admins', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ email: 'chair@sharks.co.za' }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { adminCount: number };
    assert.equal(body.adminCount, 1);
  });

  test('unknown tenant → 404', async () => {
    const res = await app.request('/platform/tenants/ghost/admins', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ email: 'a@b.co.za' }),
    });
    assert.equal(res.status, 404);
  });

  test('invalid email → 400', async () => {
    const res = await app.request('/platform/tenants/sharks/admins', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    assert.equal(res.status, 400);
  });
});

/**
 * Auto-granting tenant-admin to every operator on tenant creation.
 *
 * This deliberately widens the tenant boundary (an operator membership alone grants no
 * club access), so the behaviour is pinned here rather than left to manual checking —
 * including the negative: someone who is NOT an operator must not be swept in.
 */
describe('POST /platform/tenants — auto-grant admin to operators', () => {
  test('every operator gets tenant-admin on a newly created tenant', async () => {
    // Two operators, indexed via the PLATFORM#OPERATORS marker that putUser maintains.
    for (const [sub, email] of [
      ['auto-op-1', 'autoop1@platform'],
      ['auto-op-2', 'autoop2@platform'],
    ]) {
      await repo.putUser({
        sub,
        email,
        memberships: [{ tenantId: '*', role: 'operator', clubIds: [] }],
        onboardingSeen: {},
      });
    }
    // A non-operator who must NOT be granted anything.
    await repo.putUser({
      sub: 'auto-rep-1',
      email: 'autorep@test',
      memberships: [{ tenantId: 'dolphins', role: 'rep', clubIds: ['ukzn'] }],
      onboardingSeen: {},
    });

    const res = await app.request('/platform/tenants', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        slug: 'autograntunion',
        branding: { name: 'Auto Grant Union' },
        submissionDeadline: '2027-06-01',
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { operatorAdmins: { granted: string[]; failed: string[] } };

    assert.deepEqual(body.operatorAdmins.failed, [], 'no grant failed');
    for (const email of ['autoop1@platform', 'autoop2@platform'])
      assert.ok(body.operatorAdmins.granted.includes(email), `${email} granted`);

    for (const sub of ['auto-op-1', 'auto-op-2']) {
      const user = await repo.getUser(sub);
      assert.ok(
        user?.memberships.some((m) => m.tenantId === 'autograntunion' && m.role === 'admin'),
        `${sub} holds admin on the new tenant`,
      );
      assert.ok(
        user?.memberships.some((m) => m.tenantId === '*' && m.role === 'operator'),
        `${sub} keeps its operator membership`,
      );
    }

    const rep = await repo.getUser('auto-rep-1');
    assert.ok(
      !rep?.memberships.some((m) => m.tenantId === 'autograntunion'),
      'a non-operator is NOT swept into the grant',
    );

    // adminCount drives the transactional last-admin guard; a wrong value here would
    // either lock the tenant or let its last admin be removed.
    const cfg = await repo.getTenantConfig('autograntunion');
    assert.ok((cfg?.adminCount ?? 0) >= 2, 'adminCount reflects the auto-granted admins');
  });

  test('operators are enumerable without appearing in any tenant roster', async () => {
    const operators = await repo.listOperators();
    const emails = operators.map((o) => o.email);
    assert.ok(emails.includes('autoop1@platform'), 'operator is in the operator index');

    // The invariant reconcileUserMarkers protects: '*' is not a tenant, so an operator
    // must never surface in a tenant's user listing.
    const roster = await repo.listTenantUsers('*');
    assert.deepEqual(roster, [], 'no tenant roster exists for the platform sentinel');
  });
});

describe('POST /platform/tenants/:slug/logo-upload', () => {
  test('presigned POST with size + content-type policy and a public URL', async () => {
    const res = await app.request('/platform/tenants/sharks/logo-upload', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ contentType: 'image/png' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      url: string;
      fields: Record<string, string>;
      objectKey: string;
      publicUrl: string;
    };
    assert.ok(body.url.includes('test-tutorials'), 'targets the tutorial-assets bucket');
    assert.match(body.objectKey, /^branding\/sharks\/logo-[0-9a-f]{8}\.png$/);
    assert.equal(body.publicUrl, `https://tutorials.test/${body.objectKey}`);
    assert.equal(body.fields['Content-Type'], 'image/png');
    assert.equal(body.fields['Cache-Control'], 'public, max-age=31536000, immutable');
    // The signed policy must carry the 1 MB cap, the content type and the cache
    // header — a field without its matching policy condition makes S3 reject the POST.
    const policy = JSON.parse(Buffer.from(body.fields.Policy, 'base64').toString('utf8')) as {
      conditions: unknown[];
    };
    assert.ok(
      policy.conditions.some(
        (cond) =>
          Array.isArray(cond) &&
          cond[0] === 'content-length-range' &&
          cond[1] === 0 &&
          cond[2] === 1024 * 1024,
      ),
      'content-length-range 0..1MB enforced',
    );
    assert.ok(
      policy.conditions.some(
        (cond) =>
          Array.isArray(cond) &&
          cond[0] === 'eq' &&
          cond[1] === '$Cache-Control' &&
          cond[2] === 'public, max-age=31536000, immutable',
      ),
      'Cache-Control policy condition signed',
    );
  });

  test('svg and webp map to their extensions', async () => {
    for (const [ct, ext] of [
      ['image/svg+xml', 'svg'],
      ['image/webp', 'webp'],
    ] as const) {
      const res = await app.request('/platform/tenants/sharks/logo-upload', {
        method: 'POST',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({ contentType: ct }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { objectKey: string };
      assert.ok(body.objectKey.endsWith(`.${ext}`));
    }
  });

  test('disallowed content type → 400', async () => {
    const res = await app.request('/platform/tenants/sharks/logo-upload', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ contentType: 'image/gif' }),
    });
    assert.equal(res.status, 400);
  });

  test('unknown tenant → 404', async () => {
    const res = await app.request('/platform/tenants/ghost/logo-upload', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ contentType: 'image/png' }),
    });
    assert.equal(res.status, 404);
  });

  test('kind:"hero" → jpeg allowed, 4 MB cap, hero- key, immutable cache header', async () => {
    const res = await app.request('/platform/tenants/sharks/logo-upload', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ contentType: 'image/jpeg', kind: 'hero' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { fields: Record<string, string>; objectKey: string };
    assert.match(body.objectKey, /^branding\/sharks\/hero-[0-9a-f]{8}\.jpg$/);
    assert.equal(body.fields['Cache-Control'], 'public, max-age=31536000, immutable');
    const policy = JSON.parse(Buffer.from(body.fields.Policy, 'base64').toString('utf8')) as {
      conditions: unknown[];
    };
    assert.ok(
      policy.conditions.some(
        (cond) =>
          Array.isArray(cond) &&
          cond[0] === 'content-length-range' &&
          cond[1] === 0 &&
          cond[2] === 4 * 1024 * 1024,
      ),
      'content-length-range 0..4MB enforced',
    );
    assert.ok(
      policy.conditions.some(
        (cond) =>
          Array.isArray(cond) &&
          cond[0] === 'eq' &&
          cond[1] === '$Cache-Control' &&
          cond[2] === 'public, max-age=31536000, immutable',
      ),
      'Cache-Control policy condition signed',
    );
  });

  test('kind:"hero" rejects svg → 400; unknown kind → 400, not a silent logo fallback', async () => {
    const svg = await app.request('/platform/tenants/sharks/logo-upload', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ contentType: 'image/svg+xml', kind: 'hero' }),
    });
    assert.equal(svg.status, 400);

    const typo = await app.request('/platform/tenants/sharks/logo-upload', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ contentType: 'image/png', kind: 'bg' }),
    });
    assert.equal(typo.status, 400);
    const body = (await typo.json()) as { error: string };
    assert.match(body.error, /kind/);
  });
});

describe('PUT /platform/tenants/:slug — tutorials / tutorialsNoFallback', () => {
  test('persists tutorials + tutorialsNoFallback and returns them', async () => {
    const tutorials = [
      { title: 'Getting started', url: 'https://tutorials.test/tutorials/sharks/video-abc.mp4' },
      {
        title: 'Advanced setup',
        url: 'https://tutorials.test/tutorials/sharks/video-def.mp4',
        poster: 'https://tutorials.test/tutorials/sharks/poster-abc.jpg',
      },
    ];
    const res = await app.request('/platform/tenants/sharks', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ tutorials, tutorialsNoFallback: true }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tutorials: unknown; tutorialsNoFallback: boolean };
    assert.deepEqual(body.tutorials, tutorials);
    assert.equal(body.tutorialsNoFallback, true);
    const stored = await repo.getTenantConfig('sharks');
    assert.deepEqual(stored?.tutorials, tutorials);
    assert.equal(stored?.tutorialsNoFallback, true);
  });

  test('invalid shapes 400: not an array, too many entries, empty title, non-https url', async () => {
    const put = (tutorials: unknown) =>
      app.request('/platform/tenants/sharks', {
        method: 'PUT',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({ tutorials }),
      });

    assert.equal((await put('nope')).status, 400);

    const tooMany = Array.from({ length: 51 }, (_, i) => ({
      title: `Video ${i}`,
      url: `https://tutorials.test/tutorials/sharks/video-${i}.mp4`,
    }));
    assert.equal((await put(tooMany)).status, 400);

    assert.equal(
      (await put([{ title: '  ', url: 'https://tutorials.test/x.mp4' }])).status,
      400,
    );

    assert.equal((await put([{ title: 'x', url: 'not-a-url' }])).status, 400);
    assert.equal((await put([{ title: 'x', url: 'http://insecure.test/x.mp4' }])).status, 400);
    assert.equal(
      (
        await put([
          { title: 'x', url: 'https://tutorials.test/x.mp4', poster: 'http://insecure.test/p.jpg' },
        ])
      ).status,
      400,
    );
  });

  test('orphan cleanup: a dropped tenant-scoped url triggers DeleteObjects with exactly that key; a default-set url is never deleted', async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    s3Mock.on(DeleteObjectsCommand).resolves({});
    try {
      const kept = {
        title: 'Kept',
        url: 'https://tutorials.test/tutorials/sharks/video-kept.mp4',
      };
      const dropped = {
        title: 'Dropped',
        url: 'https://tutorials.test/tutorials/sharks/video-dropped.mp4',
      };
      const defaultSet = {
        title: 'Shared default',
        url: 'https://tutorials.test/tutorials/01-creating-account.mp4',
      };

      // Seed the tenant with all three, then save down to just `kept`.
      let res = await app.request('/platform/tenants/sharks', {
        method: 'PUT',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({ tutorials: [kept, dropped, defaultSet] }),
      });
      assert.equal(res.status, 200);
      s3Mock.resetHistory();

      res = await app.request('/platform/tenants/sharks', {
        method: 'PUT',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({ tutorials: [kept] }),
      });
      assert.equal(res.status, 200);

      const calls = s3Mock.commandCalls(DeleteObjectsCommand);
      assert.equal(calls.length, 1, 'exactly one DeleteObjects batch call');
      const keys = calls[0].args[0].input.Delete?.Objects?.map((o) => o.Key);
      assert.deepEqual(keys, ['tutorials/sharks/video-dropped.mp4']);
    } finally {
      s3Mock.restore();
    }
  });

  test('orphan cleanup: DeleteObjects failure is swallowed — the save still succeeds and persists', async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    s3Mock.on(DeleteObjectsCommand).resolves({});
    try {
      const dropped = {
        title: 'Dropped',
        url: 'https://tutorials.test/tutorials/sharks/video-dropped.mp4',
      };
      let res = await app.request('/platform/tenants/sharks', {
        method: 'PUT',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({ tutorials: [dropped] }),
      });
      assert.equal(res.status, 200);

      s3Mock.reset();
      s3Mock.on(DeleteObjectsCommand).rejects(new Error('S3 unavailable'));

      const newTutorials = [
        { title: 'Replacement', url: 'https://tutorials.test/tutorials/sharks/video-new.mp4' },
      ];
      res = await app.request('/platform/tenants/sharks', {
        method: 'PUT',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({ tutorials: newTutorials }),
      });
      assert.equal(res.status, 200, 'save succeeds even though the cleanup delete failed');
      const body = (await res.json()) as { tutorials: unknown };
      assert.deepEqual(body.tutorials, newTutorials);
      const stored = await repo.getTenantConfig('sharks');
      assert.deepEqual(stored?.tutorials, newTutorials);
    } finally {
      s3Mock.restore();
    }
  });

  test('orphan cleanup: dropping only a poster (url kept) triggers DeleteObjects for the poster key', async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    s3Mock.on(DeleteObjectsCommand).resolves({});
    try {
      const withPoster = {
        title: 'Has poster',
        url: 'https://tutorials.test/tutorials/sharks/video-kept.mp4',
        poster: 'https://tutorials.test/tutorials/sharks/poster-old.jpg',
      };
      let res = await app.request('/platform/tenants/sharks', {
        method: 'PUT',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({ tutorials: [withPoster] }),
      });
      assert.equal(res.status, 200);
      s3Mock.resetHistory();

      const withoutPoster = { title: 'Has poster', url: withPoster.url };
      res = await app.request('/platform/tenants/sharks', {
        method: 'PUT',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({ tutorials: [withoutPoster] }),
      });
      assert.equal(res.status, 200);

      const calls = s3Mock.commandCalls(DeleteObjectsCommand);
      assert.equal(calls.length, 1, 'exactly one DeleteObjects batch call');
      const keys = calls[0].args[0].input.Delete?.Objects?.map((o) => o.Key);
      assert.deepEqual(keys, ['tutorials/sharks/poster-old.jpg']);
    } finally {
      s3Mock.restore();
    }
  });
});

describe('POST /platform/tenants/:slug/tutorial-upload', () => {
  test('poster → mode "post" with a tutorials/<slug>/ key and matching policy conditions', async () => {
    const res = await app.request('/platform/tenants/sharks/tutorial-upload', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ kind: 'poster', contentType: 'image/jpeg', sizeBytes: 1024 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      mode: string;
      url: string;
      fields: Record<string, string>;
      objectKey: string;
      publicUrl: string;
    };
    assert.equal(body.mode, 'post');
    assert.match(body.objectKey, /^tutorials\/sharks\/poster-[0-9a-f]{8}\.jpg$/);
    assert.equal(body.publicUrl, `https://tutorials.test/${body.objectKey}`);
    const policy = JSON.parse(Buffer.from(body.fields.Policy, 'base64').toString('utf8')) as {
      conditions: unknown[];
    };
    assert.ok(
      policy.conditions.some(
        (cond) =>
          Array.isArray(cond) &&
          cond[0] === 'content-length-range' &&
          cond[1] === 0 &&
          cond[2] === 4 * 1024 * 1024,
      ),
    );
  });

  test('small video (under the multipart threshold) → mode "post"', async () => {
    const res = await app.request('/platform/tenants/sharks/tutorial-upload', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        kind: 'video',
        contentType: 'video/mp4',
        sizeBytes: 10 * 1024 * 1024,
        fileName: 'My Drill Video.MP4',
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { mode: string; objectKey: string };
    assert.equal(body.mode, 'post');
    assert.match(body.objectKey, /^tutorials\/sharks\/video-[0-9a-f]{8}-mydrillvideomp4\.mp4$/);
  });

  test('small video (post mode) → content-length-range caps at MULTIPART_THRESHOLD, not the 2 GiB video max', async () => {
    const res = await app.request('/platform/tenants/sharks/tutorial-upload', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ kind: 'video', contentType: 'video/mp4', sizeBytes: 10 * 1024 * 1024 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { mode: string; fields: Record<string, string> };
    assert.equal(body.mode, 'post');
    const policy = JSON.parse(Buffer.from(body.fields.Policy, 'base64').toString('utf8')) as {
      conditions: unknown[];
    };
    assert.ok(
      policy.conditions.some(
        (cond) =>
          Array.isArray(cond) &&
          cond[0] === 'content-length-range' &&
          cond[1] === 0 &&
          cond[2] === 100 * 1024 * 1024, // MULTIPART_THRESHOLD, not the 2 GiB video maxBytes
      ),
    );
  });

  test('video sizeBytes over the multipart threshold → mode "multipart" with ceil(size/partSize) partUrls', async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'upload-xyz' });
    try {
      const sizeBytes = 101 * 1024 * 1024; // just over the 100 MiB threshold
      const res = await app.request('/platform/tenants/sharks/tutorial-upload', {
        method: 'POST',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({ kind: 'video', contentType: 'video/mp4', sizeBytes }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        mode: string;
        uploadId: string;
        partSizeBytes: number;
        partUrls: { partNumber: number; url: string }[];
      };
      assert.equal(body.mode, 'multipart');
      assert.equal(body.uploadId, 'upload-xyz');
      assert.equal(body.partSizeBytes, 32 * 1024 * 1024);
      assert.equal(body.partUrls.length, Math.ceil(sizeBytes / (32 * 1024 * 1024)));
      assert.deepEqual(
        body.partUrls.map((p) => p.partNumber),
        Array.from({ length: body.partUrls.length }, (_, i) => i + 1),
      );
    } finally {
      s3Mock.restore();
    }
  });

  test('bad kind, bad contentType, bad sizeBytes → 400', async () => {
    const post = (body: unknown) =>
      app.request('/platform/tenants/sharks/tutorial-upload', {
        method: 'POST',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify(body),
      });
    assert.equal((await post({ kind: 'poster', contentType: 'video/mp4' })).status, 400);
    assert.equal(
      (await post({ kind: 'poster', contentType: 'image/jpeg', sizeBytes: -1 })).status,
      400,
    );
    assert.equal(
      (await post({ kind: 'video', contentType: 'video/mp4', sizeBytes: 999_999_999_999 }))
        .status,
      400,
    );
    assert.equal(
      (await post({ kind: 'bogus', contentType: 'video/mp4', sizeBytes: 1 })).status,
      400,
    );
  });

  test('unknown tenant → 404', async () => {
    const res = await app.request('/platform/tenants/ghost/tutorial-upload', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ kind: 'poster', contentType: 'image/jpeg', sizeBytes: 1024 }),
    });
    assert.equal(res.status, 404);
  });
});

describe('POST /platform/tenants/:slug/tutorial-upload/complete and /abort', () => {
  test('complete: objectKey outside tutorials/<slug>/ → 400', async () => {
    const res = await app.request('/platform/tenants/sharks/tutorial-upload/complete', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        objectKey: 'tutorials/otherclient/video-abc.mp4',
        uploadId: 'up-1',
        parts: [{ partNumber: 1, etag: '"abc"' }],
      }),
    });
    assert.equal(res.status, 400);
  });

  test('complete: objectKey containing ".." → 400', async () => {
    const res = await app.request('/platform/tenants/sharks/tutorial-upload/complete', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        objectKey: 'tutorials/sharks/../01-creating-account.mp4',
        uploadId: 'up-1',
        parts: [{ partNumber: 1, etag: '"abc"' }],
      }),
    });
    assert.equal(res.status, 400);
  });

  test('complete: empty parts → 400', async () => {
    const res = await app.request('/platform/tenants/sharks/tutorial-upload/complete', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        objectKey: 'tutorials/sharks/video-abc.mp4',
        uploadId: 'up-1',
        parts: [],
      }),
    });
    assert.equal(res.status, 400);
  });

  test('complete: missing parts → 400', async () => {
    const res = await app.request('/platform/tenants/sharks/tutorial-upload/complete', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        objectKey: 'tutorials/sharks/video-abc.mp4',
        uploadId: 'up-1',
      }),
    });
    assert.equal(res.status, 400);
  });

  test('complete: succeeds with parts sorted by partNumber → returns publicUrl', async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    s3Mock.on(CompleteMultipartUploadCommand).resolves({});
    try {
      const res = await app.request('/platform/tenants/sharks/tutorial-upload/complete', {
        method: 'POST',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({
          objectKey: 'tutorials/sharks/video-abc.mp4',
          uploadId: 'up-1',
          parts: [
            { partNumber: 2, etag: '"two"' },
            { partNumber: 1, etag: '"one"' },
          ],
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { publicUrl: string };
      assert.equal(body.publicUrl, 'https://tutorials.test/tutorials/sharks/video-abc.mp4');
      const call = s3Mock.commandCalls(CompleteMultipartUploadCommand)[0];
      assert.deepEqual(call.args[0].input.MultipartUpload?.Parts, [
        { ETag: '"one"', PartNumber: 1 },
        { ETag: '"two"', PartNumber: 2 },
      ]);
    } finally {
      s3Mock.restore();
    }
  });

  test('abort: objectKey outside tutorials/<slug>/ → 400', async () => {
    const res = await app.request('/platform/tenants/sharks/tutorial-upload/abort', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ objectKey: 'tutorials/otherclient/video-abc.mp4', uploadId: 'up-1' }),
    });
    assert.equal(res.status, 400);
  });

  test('abort: objectKey containing ".." → 400', async () => {
    const res = await app.request('/platform/tenants/sharks/tutorial-upload/abort', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        objectKey: 'tutorials/sharks/../01-creating-account.mp4',
        uploadId: 'up-1',
      }),
    });
    assert.equal(res.status, 400);
  });

  test('abort: succeeds (and swallows NoSuchUpload) → { ok: true }', async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    s3Mock.on(AbortMultipartUploadCommand).resolves({});
    try {
      const res = await app.request('/platform/tenants/sharks/tutorial-upload/abort', {
        method: 'POST',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({ objectKey: 'tutorials/sharks/video-abc.mp4', uploadId: 'up-1' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });

      s3Mock.reset();
      const err = Object.assign(new Error('no such upload'), { name: 'NoSuchUpload' });
      s3Mock.on(AbortMultipartUploadCommand).rejects(err);
      const res2 = await app.request('/platform/tenants/sharks/tutorial-upload/abort', {
        method: 'POST',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({ objectKey: 'tutorials/sharks/video-abc.mp4', uploadId: 'gone' }),
      });
      assert.equal(res2.status, 200);
      assert.deepEqual(await res2.json(), { ok: true });
    } finally {
      s3Mock.restore();
    }
  });
});

describe('GET /platform/tenants/:slug/dns', () => {
  test('returns the go-live steps as data', async () => {
    const res = await app.request('/platform/tenants/sharks/dns', {
      headers: platformHeaders(OPERATOR),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      tenant: string;
      liveUrl: string | null;
      steps: Array<{ key: string; title: string; detail: string; records?: unknown[] }>;
    };
    assert.equal(body.tenant, 'sharks');
    // Vanity upsell is now a single web-cert reissue (no per-tenant API cert).
    assert.deepEqual(
      body.steps.map((s) => s.key),
      ['web-certificate', 'client-dns', 'registry', 'deploy'],
    );
    // web + www CNAMEs (the client shares the platform API host — no api record here).
    const dns = body.steps.find((s) => s.key === 'client-dns')!;
    assert.equal(dns.records?.length, 2);
    const registry = body.steps.find((s) => s.key === 'registry')!;
    assert.match(registry.detail, /slug: 'sharks'/);
  });

  test('unknown tenant → 404', async () => {
    const res = await app.request('/platform/tenants/ghost/dns', {
      headers: platformHeaders(OPERATOR),
    });
    assert.equal(res.status, 404);
  });
});

describe('setup-complete milestone (D6)', () => {
  test('POST stamps setupCompletedAt/By, DELETE clears them, list reflects it', async () => {
    // Start from a fresh tenant so the assertions don't fight other suites.
    await app.request('/platform/tenants', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        slug: 'setupco',
        branding: { name: 'Setup Co' },
        submissionDeadline: '2026-09-30',
      }),
    });

    // Initially absent → list chip reads "In setup".
    const before = await (
      await app.request('/platform/tenants', { headers: platformHeaders(OPERATOR) })
    ).json();
    const row0 = (before as Array<{ tenant: string; setupCompletedAt?: string }>).find(
      (t) => t.tenant === 'setupco',
    );
    assert.equal(row0?.setupCompletedAt, undefined);

    // POST → stamped with the operator's email.
    const done = await app.request('/platform/tenants/setupco/setup-complete', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
    });
    assert.equal(done.status, 200);
    const doneBody = (await done.json()) as {
      setupCompletedAt?: string;
      setupCompletedBy?: string;
    };
    assert.ok(doneBody.setupCompletedAt, 'setupCompletedAt stamped');
    assert.equal(doneBody.setupCompletedBy, 'operator@platform');

    // List projection now carries it.
    const mid = await (
      await app.request('/platform/tenants', { headers: platformHeaders(OPERATOR) })
    ).json();
    const row1 = (mid as Array<{ tenant: string; setupCompletedAt?: string }>).find(
      (t) => t.tenant === 'setupco',
    );
    assert.ok(row1?.setupCompletedAt, 'list row shows Live');

    // DELETE → cleared (fields dropped, not stored as null).
    const reopened = await app.request('/platform/tenants/setupco/setup-complete', {
      method: 'DELETE',
      headers: platformHeaders(OPERATOR),
    });
    assert.equal(reopened.status, 200);
    const reopenedBody = (await reopened.json()) as {
      setupCompletedAt?: string;
      setupCompletedBy?: string;
    };
    assert.equal(reopenedBody.setupCompletedAt, undefined);
    assert.equal(reopenedBody.setupCompletedBy, undefined);
  });

  test('a config merge-patch cannot forge the milestone (shared strip choke point)', async () => {
    // PUT /platform/tenants/:slug and the tenant-admin PUT /tenant/config both run through
    // applyTenantConfigPatch, which strips setup fields — so neither can forge them.
    const res = await app.request('/platform/tenants/setupco', {
      method: 'PUT',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        setupCompletedAt: '2020-01-01T00:00:00.000Z',
        setupCompletedBy: 'forged@evil',
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { setupCompletedAt?: string; setupCompletedBy?: string };
    assert.equal(body.setupCompletedAt, undefined);
    assert.equal(body.setupCompletedBy, undefined);
  });

  test('unknown tenant → 404', async () => {
    const res = await app.request('/platform/tenants/ghost/setup-complete', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
    });
    assert.equal(res.status, 404);
  });

  test('non-operator is rejected by the platform gate', async () => {
    const res = await app.request('/platform/tenants/dolphins/setup-complete', {
      method: 'POST',
      headers: platformHeaders(DOLPHINS_ADMIN),
    });
    assert.equal(res.status, 403);
  });
});

describe('seed demotion (2F)', () => {
  test('re-seed of an existing tenant is a no-op ("exists")', async () => {
    // Mutate the live row the way a portal edit would.
    const cfg = await repo.getTenantConfig('dolphins');
    await repo.putTenantConfig({
      ...cfg!,
      branding: { ...cfg!.branding, name: 'Portal-Edited Dolphins' },
    });

    const result = await seed.seedTenantConfig('dolphins');
    assert.equal(result.status, 'exists');
    const after = await repo.getTenantConfig('dolphins');
    assert.equal(after?.branding.name, 'Portal-Edited Dolphins', 'edit not clobbered');
  });

  test('--force overwrites back to seed branding', async () => {
    const result = await seed.seedTenantConfig('dolphins', { force: true });
    assert.equal(result.status, 'overwritten');
    const after = await repo.getTenantConfig('dolphins');
    assert.equal(after?.branding.name, 'Hollywoodbets Dolphins');
    // Forced overwrite must still keep the tenant in the registry (gsi re-derived).
    assert.ok((await repo.listTenants()).some((t) => t.tenant === 'dolphins'));
  });
});

/**
 * Season calendars (ADR 0008) — operator-only setup data that drives fixture dates.
 * A malformed calendar silently mis-schedules a whole league, so the shape guard is
 * tested as hard as the referrer guard that stops one being deleted out from under a
 * series.
 */
describe('season calendars (ADR 0008)', () => {
  const T = 'calendars';
  const OP = platformHeaders(OPERATOR);
  const CAL_ADMIN = devAuthAs('cal-adm', 'admin@cal', [
    { tenantId: T, role: 'admin', clubIds: [] },
  ]);

  const validCalendar = () => ({
    id: 'cal_2026_27',
    label: '2026/27',
    timezone: 'Africa/Johannesburg',
    blocks: [
      { id: 'b1', label: 'Block 1', start: '2026-09-13', end: '2026-12-13' },
      { id: 'b2', label: 'Block 2', start: '2027-01-18', end: '2027-03-28' },
    ],
    breaks: [{ label: 'Mid-season break', start: '2026-12-14', end: '2027-01-17' }],
    excludeDates: ['2026-09-24'],
  });

  const putCalendars = (calendars: unknown) =>
    app.request(`/platform/tenants/${T}`, {
      method: 'PUT',
      headers: OP,
      body: JSON.stringify({ calendars }),
    });

  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

  // Own tenant so calendar writes can't disturb the other suites' configs.
  before(async () => {
    await repo.putTenantConfig({
      tenant: T,
      branding: { name: 'Calendar Union', title: 'Cal', logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [],
    });
  });

  // GET /tenant is an explicit allowlist. Calendars and structures were each omitted
  // from it once, and both times the admin console silently lost the feature — the
  // create-series calendar row didn't render, and "Start a season" said the structure
  // didn't exist. Calendars are still served here (the create-series form reads them
  // off this already-fetched payload); structures moved to the AUTHENTICATED
  // /tenant/config, because GET /tenant is anonymous and hit on every public page load.
  test('GET /tenant exposes calendars, and no longer ships structures anonymously', async () => {
    await putCalendars([validCalendar()]);
    const res = await app.request('/tenant', { headers: { 'x-tenant': T } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(Array.isArray(body.calendars), 'calendars present');
    assert.equal((body.calendars as unknown[]).length, 1);
    assert.equal(body.structures, undefined, 'structures must not ride the anonymous payload');
    // …and still no operator-only or sensitive config.
    assert.equal(body.knownClubs, undefined);
    assert.equal(body.requiredDocs, undefined);
  });

  // The other half of that move: whatever leaves GET /tenant must arrive somewhere the
  // admin console can actually reach, or "Start a season" breaks again.
  test('GET /tenant/config serves structures to an authenticated admin, minus the signup link', async () => {
    await app.request(`/platform/tenants/${T}`, {
      method: 'PUT',
      headers: OP,
      body: JSON.stringify({
        structures: [
          {
            id: 'st_flat',
            name: 'Flat round robin',
            version: 1,
            stages: [
              {
                id: 'stage_1',
                name: 'League',
                format: { kind: 'round-robin', legs: 1 },
                entrants: { kind: 'all-registered' },
                schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
              },
            ],
          },
        ],
      }),
    });
    const res = await app.request('/tenant/config', { headers: tenantHeaders(CAL_ADMIN, T) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(Array.isArray(body.structures), 'structures present for an authed admin');
    assert.ok(Array.isArray(body.calendars), 'calendars present too');
    // An explicit allowlist, not "the row minus clubSignupLink" — any tenant member can
    // call this, reps included, and a denylist leaks every field added to TenantConfig
    // from then on.
    for (const held of [
      'clubSignupLink',
      'knownClubs',
      'requiredDocs',
      'adminCount',
      'setupCompletedBy',
    ]) {
      assert.equal(body[held], undefined, `${held} must not ride /tenant/config`);
    }
  });

  test('GET /tenant/config is not anonymous', async () => {
    const res = await app.request('/tenant/config', { headers: { 'x-tenant': T } });
    assert.equal(res.status, 401);
  });

  test('operator can write a calendar; it round-trips', async () => {
    const res = await putCalendars([validCalendar()]);
    assert.equal(res.status, 200);
    const stored = await repo.getTenantConfig(T);
    assert.equal(stored?.calendars?.length, 1);
    assert.equal(stored?.calendars?.[0].blocks.length, 2);
    assert.equal(stored?.calendars?.[0].breaks?.[0].start, '2026-12-14');
    assert.deepEqual(stored?.calendars?.[0].excludeDates, ['2026-09-24']);
  });

  test('tenant admins cannot write calendars — stripped like districts (ADR 0006)', async () => {
    const before = await repo.getTenantConfig(T);
    const res = await app.request('/tenant/config', {
      method: 'PUT',
      headers: tenantHeaders(CAL_ADMIN, T),
      body: JSON.stringify({
        calendars: [{ ...validCalendar(), id: 'forged', label: 'Forged' }],
      }),
    });
    assert.equal(res.status, 200);
    const after = await repo.getTenantConfig(T);
    assert.deepEqual(after?.calendars, before?.calendars, 'calendar list unchanged');
  });

  test('rejects a calendar with no playing block', async () => {
    const res = await putCalendars([{ ...validCalendar(), blocks: [] }]);
    assert.equal(res.status, 400);
    assert.match(await errorOf(res), /at least one playing block/);
  });

  test('rejects a block that ends before it starts', async () => {
    const cal = validCalendar();
    cal.blocks[0] = { id: 'b1', label: 'Backwards', start: '2026-12-13', end: '2026-09-13' };
    const res = await putCalendars([cal]);
    assert.equal(res.status, 400);
    assert.match(await errorOf(res), /"Backwards" ends before it starts/);
  });

  // dayjs's lenient mode rolls 31 Feb into March — a date the operator never entered.
  test('rejects an impossible date rather than rolling it over', async () => {
    const cal = validCalendar();
    cal.blocks[0].start = '2026-02-31';
    const res = await putCalendars([cal]);
    assert.equal(res.status, 400);
    assert.match(await errorOf(res), /valid start and end dates/);
  });

  test('rejects a malformed excluded date', async () => {
    const res = await putCalendars([{ ...validCalendar(), excludeDates: ['24/09/2026'] }]);
    assert.equal(res.status, 400);
    assert.match(await errorOf(res), /not a valid excluded date/);
  });

  test('rejects duplicate calendar ids and duplicate block ids', async () => {
    const dupCal = await putCalendars([validCalendar(), validCalendar()]);
    assert.equal(dupCal.status, 409);
    assert.match(await errorOf(dupCal), /duplicate calendar id/);

    const cal = validCalendar();
    cal.blocks[1].id = 'b1';
    const dupBlock = await putCalendars([cal]);
    assert.equal(dupBlock.status, 409);
    assert.match(await errorOf(dupBlock), /duplicate block id/);
  });

  test('rejects a break that ends before it starts', async () => {
    const cal = validCalendar();
    cal.breaks = [{ label: 'Bad break', start: '2027-01-17', end: '2026-12-14' }];
    const res = await putCalendars([cal]);
    assert.equal(res.status, 400);
    assert.match(await errorOf(res), /"Bad break" ends before it starts/);
  });

  test('a failed write leaves the stored calendar untouched', async () => {
    const before = await repo.getTenantConfig(T);
    await putCalendars([{ ...validCalendar(), blocks: [] }]);
    const after = await repo.getTenantConfig(T);
    assert.deepEqual(after?.calendars, before?.calendars);
  });

  test('deleting a calendar a series is scheduled against is blocked', async () => {
    await putCalendars([validCalendar()]);
    await repo.putSeries(T, {
      id: 'cal-bound-series',
      name: 'Premier Men · 50 Over',
      startDate: '2026-09-13',
      teams: ['alpha', 'bravo'],
      fixtures: [{ home: 'alpha', away: 'bravo', date: '2026-09-13', round: 1 }],
      schedule: { calendarId: 'cal_2026_27', blockId: 'b1', cadence: { kind: 'weekly' } },
      released: false,
      releasedAt: null,
      version: 1,
    });

    const res = await putCalendars([]);
    assert.equal(res.status, 409);
    assert.match(await errorOf(res), /1 series is scheduled against "2026\/27"/);
    // Guard is a real block, not a warning — the calendar survives.
    assert.equal((await repo.getTenantConfig(T))?.calendars?.length, 1);
  });

  test('editing a referenced calendar in place is allowed — only removal is guarded', async () => {
    const cal = validCalendar();
    cal.blocks[0].end = '2026-12-20';
    const res = await putCalendars([cal]);
    assert.equal(res.status, 200);
    const stored = await repo.getTenantConfig(T);
    assert.equal(stored?.calendars?.[0].blocks[0].end, '2026-12-20');
  });

  // NOT a blocking guard (that's the removal case above) — a live series' schedule stays
  // a live reference to its calendar on purpose (mid-season date edits flowing into
  // regenerate is the feature). This just surfaces that to the operator instead of
  // leaving it a silent surprise at the next regenerate. `cal-bound-series` (from the
  // deletion-guard test above) is still scheduled against `cal_2026_27` at this point.
  test('editing a referenced calendar’s blocks surfaces a warning naming the affected series', async () => {
    assert.ok(
      await repo.getSeries(T, 'cal-bound-series'),
      'precondition: the earlier test’s series is still scheduled against this calendar',
    );
    const cal = validCalendar();
    cal.blocks[0].end = '2026-12-21'; // a real block-shape change from the prior test's state
    const res = await putCalendars([cal]);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { warnings?: string[] };
    assert.ok(Array.isArray(body.warnings), 'warnings present on a changed, referenced calendar');
    assert.match(body.warnings![0], /1 series is scheduled against '2026\/27'/);
    assert.match(body.warnings![0], /regenerating it will follow the new dates/);
  });

  test('no warnings key when the edit does not touch any referenced calendar’s blocks', async () => {
    // Same blocks as currently stored — content-identical, so nothing "changed".
    const stored = await repo.getTenantConfig(T);
    const res = await putCalendars(stored?.calendars ?? []);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { warnings?: string[] };
    assert.equal(body.warnings, undefined, 'no warnings key on a no-op block resave');
  });

  test('no warnings key when a changed calendar has no series scheduled against it', async () => {
    const spare = { ...validCalendar(), id: 'cal_unreferenced', label: 'Unreferenced' };
    await putCalendars([...((await repo.getTenantConfig(T))?.calendars ?? []), spare]);

    const changed = { ...spare, blocks: [{ ...spare.blocks[0], end: '2026-12-22' }] };
    const stored = await repo.getTenantConfig(T);
    const res = await putCalendars([
      ...(stored?.calendars ?? []).filter((c) => c.id !== 'cal_unreferenced'),
      changed,
    ]);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { warnings?: string[] };
    assert.equal(
      body.warnings,
      undefined,
      'no series references this calendar, so nothing to warn about',
    );
  });

  test('deleting an unreferenced calendar succeeds', async () => {
    const spare = { ...validCalendar(), id: 'cal_spare', label: '2027/28' };
    assert.equal((await putCalendars([validCalendar(), spare])).status, 200);

    const res = await putCalendars([validCalendar()]);
    assert.equal(res.status, 200);
    const stored = await repo.getTenantConfig(T);
    assert.deepEqual(
      stored?.calendars?.map((cal) => cal.id),
      ['cal_2026_27'],
    );
  });

  // A series with no `schedule` predates calendars entirely and must never pin one.
  test('a legacy series without a schedule does not block calendar deletion', async () => {
    await repo.putSeries(T, {
      id: 'legacy-series',
      name: 'Legacy',
      startDate: '2026-09-13',
      teams: ['alpha', 'bravo'],
      fixtures: [],
      released: false,
      releasedAt: null,
      version: 1,
    });
    await repo.deleteSeries(T, 'cal-bound-series');

    const res = await putCalendars([]);
    assert.equal(res.status, 200);
    assert.deepEqual((await repo.getTenantConfig(T))?.calendars, []);
  });
});

/**
 * Competition structures (ADR 0008) — operator-managed stage pipelines leagues bind to.
 * The pipeline-integrity check matters most: a stage deriving from a LATER stage is a
 * cycle, and a season built from one would be permanently unresolvable with no clue why.
 */
describe('competition structures (ADR 0008)', () => {
  const T = 'structures';
  const OP = platformHeaders(OPERATOR);
  const ST_ADMIN = devAuthAs('st-adm', 'admin@st', [{ tenantId: T, role: 'admin', clubIds: [] }]);

  const stage = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    format: { kind: 'round-robin', legs: 2 },
    entrants: { kind: 'manual' },
    schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
    ...extra,
  });

  const structure = (extra: Record<string, unknown> = {}) => ({
    id: 'split-league',
    name: 'Split league with mid-season swap',
    version: 1,
    stages: [stage('double-round'), stage('final-round')],
    ...extra,
  });

  const calendar = {
    id: 'cal',
    label: '2026/27',
    blocks: [{ id: 'b1', label: 'Block 1', start: '2026-09-13', end: '2026-12-13' }],
  };

  const put = (body: unknown) =>
    app.request(`/platform/tenants/${T}`, {
      method: 'PUT',
      headers: OP,
      body: JSON.stringify(body),
    });
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

  before(async () => {
    await repo.putTenantConfig({
      tenant: T,
      branding: { name: 'Structure Union', title: 'St', logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [],
      calendars: [calendar],
    });
  });

  test('operator can write a structure; it round-trips', async () => {
    const res = await put({ structures: [structure()] });
    assert.equal(res.status, 200);
    const stored = await repo.getTenantConfig(T);
    assert.equal(stored?.structures?.length, 1);
    assert.equal(stored?.structures?.[0].stages.length, 2);
  });

  // Version numbers are SERVER-OWNED (ADR 0008 phase 1): a client's `version` is
  // ignored outright, and only a real content change mints `existing.version + 1`.
  // Uses its own structure id so it can't disturb `split-league`'s state for the
  // surrounding tests, and restores the tenant's structures afterward — the later
  // "still used by 1 competition" test depends on `structures.length === 1`.
  describe('structure version numbers are server-owned', () => {
    const versioned = (extra: Record<string, unknown> = {}) => ({
      id: 'version-test',
      name: 'Version test',
      version: 1,
      stages: [stage('only-stage')],
      ...extra,
    });

    let priorConfig: Awaited<ReturnType<typeof repo.getTenantConfig>>;
    before(async () => {
      priorConfig = await repo.getTenantConfig(T);
    });
    after(async () => {
      if (priorConfig) await repo.putTenantConfig(priorConfig);
    });

    test('a brand-new structure id starts at version 1, regardless of what the client sends', async () => {
      const res = await put({ structures: [versioned({ version: 999 })] });
      assert.equal(res.status, 200);
      const stored = await repo.getTenantConfig(T);
      assert.equal(stored?.structures?.find((s) => s.id === 'version-test')?.version, 1);
    });

    test('a real content change bumps the version by exactly 1, ignoring a forged client version', async () => {
      const stored = await repo.getTenantConfig(T);
      const rest = (stored?.structures ?? []).filter((s) => s.id !== 'version-test');
      const res = await put({
        structures: [...rest, versioned({ name: 'Version test, renamed', version: 42 })],
      });
      assert.equal(res.status, 200);
      const afterPatch = await repo.getTenantConfig(T);
      assert.equal(afterPatch?.structures?.find((s) => s.id === 'version-test')?.version, 2);
    });

    test('an unchanged resave keeps the existing version number', async () => {
      const stored = await repo.getTenantConfig(T);
      const current = stored?.structures?.find((s) => s.id === 'version-test');
      assert.ok(current);
      const rest = (stored?.structures ?? []).filter((s) => s.id !== 'version-test');
      // Same content, byte for byte, but a deliberately wrong client-sent version.
      const res = await put({
        structures: [...rest, { ...current, version: 12345 }],
      });
      assert.equal(res.status, 200);
      const afterPatch = await repo.getTenantConfig(T);
      assert.equal(afterPatch?.structures?.find((s) => s.id === 'version-test')?.version, 2);
    });
  });

  test('tenant admins cannot write structures — stripped like calendars', async () => {
    const before = await repo.getTenantConfig(T);
    const res = await app.request('/tenant/config', {
      method: 'PUT',
      headers: tenantHeaders(ST_ADMIN, T),
      body: JSON.stringify({ structures: [structure({ id: 'forged', name: 'Forged' })] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await repo.getTenantConfig(T))?.structures, before?.structures);
  });

  test('rejects a structure with no stages', async () => {
    const res = await put({ structures: [structure({ stages: [] })] });
    assert.equal(res.status, 400);
    assert.match(await errorOf(res), /needs at least one stage/);
  });

  test('rejects an unknown format, entrant rule or cadence', async () => {
    const badFormat = await put({
      structures: [structure({ stages: [stage('s1', { format: { kind: 'league-ish' } })] })],
    });
    assert.equal(badFormat.status, 400);
    assert.match(await errorOf(badFormat), /unknown format/);

    const badEntrants = await put({
      structures: [structure({ stages: [stage('s1', { entrants: { kind: 'vibes' } })] })],
    });
    assert.equal(badEntrants.status, 400);
    assert.match(await errorOf(badEntrants), /unknown entrant rule/);

    const badCadence = await put({
      structures: [
        structure({
          stages: [stage('s1', { schedule: { blockIndex: 0, cadence: { kind: 'lunar' } } })],
        }),
      ],
    });
    assert.equal(badCadence.status, 400);
    assert.match(await errorOf(badCadence), /unknown cadence/);
  });

  // roundsPerDay (double-headers, ADR 0008): 1 is fine on its own, 2 needs exactly two
  // slots — one round is the AM sitting, the other the PM sitting.
  describe('rejects a stage schedule with a bad roundsPerDay', () => {
    const T20_SLOTS = [
      { label: 'Morning', start: '08:00' },
      { label: 'Afternoon', start: '13:30' },
    ];

    test('roundsPerDay: 1 is accepted', async () => {
      const res = await put({
        structures: [
          structure({
            stages: [
              stage('double-round', {
                schedule: { blockIndex: 0, cadence: { kind: 'weekly' }, roundsPerDay: 1 },
              }),
              stage('final-round'),
            ],
          }),
        ],
      });
      assert.equal(res.status, 200);
    });

    test('roundsPerDay: 2 with exactly two slots is accepted', async () => {
      const res = await put({
        structures: [
          structure({
            stages: [
              stage('double-round', {
                schedule: {
                  blockIndex: 0,
                  cadence: { kind: 'weekly' },
                  roundsPerDay: 2,
                  slots: T20_SLOTS,
                },
              }),
              stage('final-round'),
            ],
          }),
        ],
      });
      assert.equal(res.status, 200);
    });

    test('roundsPerDay: 2 with one slot is rejected', async () => {
      const res = await put({
        structures: [
          structure({
            stages: [
              stage('double-round', {
                schedule: {
                  blockIndex: 0,
                  cadence: { kind: 'weekly' },
                  roundsPerDay: 2,
                  slots: [T20_SLOTS[0]],
                },
              }),
              stage('final-round'),
            ],
          }),
        ],
      });
      assert.equal(res.status, 400);
      assert.match(await errorOf(res), /exactly two slots for two rounds per day/);
    });

    test('roundsPerDay: 2 with three slots is rejected', async () => {
      const res = await put({
        structures: [
          structure({
            stages: [
              stage('double-round', {
                schedule: {
                  blockIndex: 0,
                  cadence: { kind: 'weekly' },
                  roundsPerDay: 2,
                  slots: [...T20_SLOTS, { label: 'Evening', start: '18:00' }],
                },
              }),
              stage('final-round'),
            ],
          }),
        ],
      });
      assert.equal(res.status, 400);
      assert.match(await errorOf(res), /exactly two slots for two rounds per day/);
    });

    test('a roundsPerDay other than 1 or 2 is rejected', async () => {
      const res = await put({
        structures: [
          structure({
            stages: [
              stage('double-round', {
                schedule: { blockIndex: 0, cadence: { kind: 'weekly' }, roundsPerDay: 3 },
              }),
              stage('final-round'),
            ],
          }),
        ],
      });
      assert.equal(res.status, 400);
      assert.match(await errorOf(res), /roundsPerDay must be 1 or 2/);
    });
  });

  test('rejects a stage that plays an impossible number of legs', async () => {
    const res = await put({
      structures: [
        structure({ stages: [stage('s1', { format: { kind: 'round-robin', legs: 7 } })] }),
      ],
    });
    assert.equal(res.status, 400);
    assert.match(await errorOf(res), /1, 2 or 3 legs/);
  });

  test('rejects duplicate structure ids and duplicate stage ids', async () => {
    const dupStruct = await put({ structures: [structure(), structure()] });
    assert.equal(dupStruct.status, 409);
    assert.match(await errorOf(dupStruct), /duplicate structure id/);

    const dupStage = await put({
      structures: [structure({ stages: [stage('same'), stage('same')] })],
    });
    assert.equal(dupStage.status, 409);
    assert.match(await errorOf(dupStage), /duplicate stage id/);
  });

  // The pipeline-integrity guard: a stage may only derive from one BEFORE it.
  test('rejects a stage deriving from a later stage (a cycle)', async () => {
    const res = await put({
      structures: [
        structure({
          stages: [
            stage('first', {
              entrants: {
                kind: 'manual',
                derivedFrom: { rule: 'swap', fromStage: 'second', detail: 'backwards' },
              },
            }),
            stage('second'),
          ],
        }),
      ],
    });
    assert.equal(res.status, 400);
    assert.match(await errorOf(res), /does not come before it/);
  });

  test('rejects a stage deriving from itself', async () => {
    const res = await put({
      structures: [
        structure({
          stages: [
            stage('solo', {
              entrants: {
                kind: 'manual',
                derivedFrom: { rule: 'swap', fromStage: 'solo', detail: 'itself' },
              },
            }),
          ],
        }),
      ],
    });
    assert.equal(res.status, 400);
    assert.match(await errorOf(res), /does not come before it/);
  });

  test('accepts a stage deriving from an earlier one', async () => {
    const res = await put({
      structures: [
        structure({
          stages: [
            stage('double-round'),
            stage('final-round', {
              entrants: {
                kind: 'manual',
                derivedFrom: {
                  rule: 'swap',
                  fromStage: 'double-round',
                  detail: 'Top Six 6th ↔ Bottom Six 1st',
                  carryPoints: true,
                },
              },
            }),
          ],
        }),
      ],
    });
    assert.equal(res.status, 200);
  });

  test('a competition must point at a structure and calendar that exist', async () => {
    await put({ structures: [structure()] });
    const league = { key: 'premier', label: 'Premier', group: 'Senior', district: 'All districts' };

    const badStructure = await put({
      leagues: [
        {
          ...league,
          competitions: [{ id: 'c1', label: '50 Over', structureId: 'ghost', calendarId: 'cal' }],
        },
      ],
    });
    assert.equal(badStructure.status, 400);
    assert.match(await errorOf(badStructure), /structure that doesn't exist/);

    const badCalendar = await put({
      leagues: [
        {
          ...league,
          competitions: [
            { id: 'c1', label: '50 Over', structureId: 'split-league', calendarId: 'ghost' },
          ],
        },
      ],
    });
    assert.equal(badCalendar.status, 400);
    assert.match(await errorOf(badCalendar), /calendar that doesn't exist/);

    const ok = await put({
      leagues: [
        {
          ...league,
          competitions: [
            { id: 'c1', label: '50 Over', structureId: 'split-league', calendarId: 'cal' },
          ],
        },
      ],
    });
    assert.equal(ok.status, 200);
  });

  // `blockIndex` names a POSITION into whichever calendar the competition binds — the
  // structure alone can't check it (it has no calendar), so this is enforced only once
  // a competition actually binds a structure to a calendar. Each test uses its OWN
  // structure id and league key, and the describe block restores the tenant's config
  // afterward — the later "still used by 1 competition" test depends on
  // `structures.length === 1`.
  describe('block-count check against the bound calendar', () => {
    let priorConfig: Awaited<ReturnType<typeof repo.getTenantConfig>>;
    before(async () => {
      priorConfig = await repo.getTenantConfig(T);
    });
    after(async () => {
      if (priorConfig) await repo.putTenantConfig(priorConfig);
    });

    test('rejects a stage that plays past the end of the bound calendar', async () => {
      const stored = await repo.getTenantConfig(T);
      // `calendar` (this describe block's fixture) has exactly ONE block. A stage at
      // position 1 (the second block) has nowhere to land.
      await put({
        structures: [
          ...(stored?.structures ?? []),
          {
            id: 'overrun-test',
            name: 'Overrun test',
            version: 1,
            stages: [
              stage('only-stage', { schedule: { blockIndex: 1, cadence: { kind: 'weekly' } } }),
            ],
          },
        ],
      });
      const league = {
        key: 'overrun-league',
        label: 'Overrun League',
        group: 'Senior',
        district: 'All districts',
      };

      const overrun = await put({
        leagues: [
          {
            ...league,
            competitions: [
              { id: 'c1', label: '50 Over', structureId: 'overrun-test', calendarId: 'cal' },
            ],
          },
        ],
      });
      assert.equal(overrun.status, 400);
      const msg = await errorOf(overrun);
      assert.match(msg, /stage "only-stage"/);
      assert.match(msg, /plays in block 2/);
      assert.match(msg, /has only 1 block/);
    });

    test('accepts a stage that stays within the bound calendar', async () => {
      const stored = await repo.getTenantConfig(T);
      // Same calendar, one block — a stage at position 0 (the only block) fits exactly.
      await put({
        structures: [
          ...(stored?.structures ?? []).filter((s) => s.id !== 'overrun-test'),
          {
            id: 'inrange-test',
            name: 'In-range test',
            version: 1,
            stages: [
              stage('only-stage', { schedule: { blockIndex: 0, cadence: { kind: 'weekly' } } }),
            ],
          },
        ],
      });
      const league = {
        key: 'inrange-league',
        label: 'In-range League',
        group: 'Senior',
        district: 'All districts',
      };

      const res = await put({
        leagues: [
          {
            ...league,
            competitions: [
              { id: 'c1', label: '50 Over', structureId: 'inrange-test', calendarId: 'cal' },
            ],
          },
        ],
      });
      assert.equal(res.status, 200);
    });
  });

  test('excludeTeamIds must be an array of team ids', async () => {
    const league = { key: 'premier', label: 'Premier', group: 'Senior', district: 'All districts' };
    const comp = (excludeTeamIds: unknown) => ({
      leagues: [
        {
          ...league,
          competitions: [
            {
              id: 'c1',
              label: '50 Over',
              structureId: 'split-league',
              calendarId: 'cal',
              excludeTeamIds,
            },
          ],
        },
      ],
    });

    // A bare string is iterable, so it would pass a naive check and then be read
    // character by character on the client — the exact silent-wrong-answer case.
    const asString = await put(comp('tm_a'));
    assert.equal(asString.status, 400);
    assert.match(await errorOf(asString), /excludeTeamIds must be an array/);

    const withBlank = await put(comp(['tm_a', '  ']));
    assert.equal(withBlank.status, 400);

    const ok = await put(comp(['tm_a', 'tm_b']));
    assert.equal(ok.status, 200);
    assert.deepEqual(
      (await repo.getTenantConfig(T))?.leagues?.[0]?.competitions?.[0]?.excludeTeamIds,
      ['tm_a', 'tm_b'],
    );
  });

  test('deleting a structure a competition still binds to is blocked', async () => {
    const res = await put({ structures: [] });
    assert.equal(res.status, 409);
    assert.match(await errorOf(res), /still used by 1 competition/);
    assert.equal((await repo.getTenantConfig(T))?.structures?.length, 1);
  });

  test('one PUT may add a structure and the competition that uses it together', async () => {
    const stored = await repo.getTenantConfig(T);
    const res = await put({
      structures: [...(stored?.structures ?? []), structure({ id: 'flat', name: 'Flat' })],
      leagues: [
        {
          key: 'emcu1',
          label: 'EMCU Division 1',
          group: 'Senior',
          district: 'All districts',
          competitions: [{ id: 'c1', label: '50 Over', structureId: 'flat', calendarId: 'cal' }],
        },
      ],
    });
    assert.equal(res.status, 200);
  });
});

/** Season runs (ADR 0008) — the orchestration layer above Series. */
describe('season runs (ADR 0008)', () => {
  const T = 'seasonruns';
  const ADMIN = devAuthAs('sr-adm', 'admin@sr', [{ tenantId: T, role: 'admin', clubIds: [] }]);
  const REP = devAuthAs('sr-rep', 'rep@sr', [{ tenantId: T, role: 'rep', clubIds: ['alpha'] }]);
  const H = (auth: string) => tenantHeaders(auth, T);

  const run = (extra: Record<string, unknown> = {}) => ({
    id: 'run-1',
    leagueKey: 'premier',
    competitionId: 'c1',
    seasonLabel: '2026/27',
    structureSnapshot: {
      id: 'split',
      name: 'Split',
      version: 1,
      stages: [
        {
          id: 's1',
          name: 'Double round',
          format: { kind: 'round-robin', legs: 2 },
          entrants: { kind: 'manual' },
          schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
        },
      ],
    },
    calendarSnapshot: {
      id: 'cal',
      label: '2026/27',
      blocks: [{ id: 'b1', label: 'Block 1', start: '2026-09-13', end: '2026-12-13' }],
    },
    stages: [],
    version: 1,
    ...extra,
  });

  const post = (body: unknown, auth = ADMIN) =>
    app.request('/season-runs', { method: 'POST', headers: H(auth), body: JSON.stringify(body) });

  before(async () => {
    await repo.putTenantConfig({
      tenant: T,
      branding: { name: 'Run Union', title: 'Run', logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [],
    });
  });

  test('admin creates a run; it lists and reads back', async () => {
    const res = await post(run());
    assert.equal(res.status, 201);
    const body = (await res.json()) as { version: number; createdAt?: string };
    assert.equal(body.version, 1);
    assert.ok(body.createdAt, 'createdAt stamped server-side');

    const list = await app.request('/season-runs', { headers: H(ADMIN) });
    assert.equal(list.status, 200);
    assert.equal(((await list.json()) as unknown[]).length, 1);

    const one = await app.request('/season-runs/run-1', { headers: H(ADMIN) });
    assert.equal(one.status, 200);
  });

  test('reps can read but not write', async () => {
    assert.equal((await app.request('/season-runs', { headers: H(REP) })).status, 200);
    assert.equal((await post(run({ id: 'rep-run' }), REP)).status, 403);
  });

  test('rejects a run missing its structure or calendar snapshot', async () => {
    const noStructure = await post(run({ id: 'r2', structureSnapshot: undefined }));
    assert.equal(noStructure.status, 400);
    const noCalendar = await post(run({ id: 'r3', calendarSnapshot: undefined }));
    assert.equal(noCalendar.status, 400);
  });

  test('rejects a duplicate id rather than silently overwriting a live season', async () => {
    assert.equal((await post(run())).status, 409);
  });

  // Snapshots are what stop an operator's template edit reshaping a season in flight.
  test('the snapshots are immutable — a PATCH cannot replace them', async () => {
    const res = await app.request('/season-runs/run-1', {
      method: 'PATCH',
      headers: H(ADMIN),
      body: JSON.stringify({
        version: 1,
        structureSnapshot: { id: 'evil', name: 'Evil', version: 9, stages: [] },
        stages: [{ specId: 's1', status: 'ready', groups: [] }],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { structureSnapshot: { id: string }; stages: unknown[] };
    assert.equal(body.structureSnapshot.id, 'split', 'snapshot untouched');
    assert.equal(body.stages.length, 1, 'the legitimate part of the patch applied');
  });

  test('a stale version 409s so two admins cannot both resolve a stage', async () => {
    const stale = await app.request('/season-runs/run-1', {
      method: 'PATCH',
      headers: H(ADMIN),
      body: JSON.stringify({ version: 1, stages: [] }),
    });
    assert.equal(stale.status, 409);
  });

  test('deleting a run leaves the series its stages produced alone', async () => {
    await repo.putSeries(T, {
      id: 'from-run',
      name: 'Top Six',
      startDate: '2026-09-13',
      teams: ['alpha', 'bravo'],
      fixtures: [],
      seasonRunId: 'run-1',
      stageSpecId: 's1',
      groupId: 'g1',
      released: true,
      releasedAt: '2026-09-01T00:00:00.000Z',
      version: 1,
    });
    const res = await app.request('/season-runs/run-1', { method: 'DELETE', headers: H(ADMIN) });
    assert.equal(res.status, 200);
    assert.equal(await repo.getSeasonRun(T, 'run-1'), null);
    const orphan = await repo.getSeries(T, 'from-run');
    assert.ok(orphan, 'published fixtures survive — orphaning a pointer beats deleting a schedule');
    assert.equal(orphan?.seasonRunId, 'run-1');
  });

  test('404s for a run that does not exist', async () => {
    assert.equal((await app.request('/season-runs/ghost', { headers: H(ADMIN) })).status, 404);
    const patch = await app.request('/season-runs/ghost', {
      method: 'PATCH',
      headers: H(ADMIN),
      body: JSON.stringify({ stages: [] }),
    });
    assert.equal(patch.status, 404);
  });

  test('tenant erasure sweeps season runs', async () => {
    await repo.putSeasonRun(T, run({ id: 'to-erase' }) as never);
    assert.ok(await repo.getSeasonRun(T, 'to-erase'));
    await repo.eraseTenantData(T);
    assert.equal(await repo.getSeasonRun(T, 'to-erase'), null);
    assert.deepEqual(await repo.listSeasonRuns(T), []);
  });
});
