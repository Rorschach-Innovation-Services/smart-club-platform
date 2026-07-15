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
        knownClubs: [{ evil: true }], // outside the whitelist — must be ignored
        adminCount: 99, // ditto
      }),
    });
    assert.equal(res.status, 200);
    const cfg = (await res.json()) as import('../src/types.js').TenantConfig;
    assert.equal(cfg.submissionDeadline, '2026-10-31');
    assert.deepEqual(cfg.features, { whatsappInvites: true });
    assert.equal(cfg.branding.name, 'Hollywoodbets Sharks'); // untouched
    const stored = await repo.getTenantConfig('sharks');
    assert.deepEqual(stored?.knownClubs, []);
    assert.notEqual(stored?.adminCount, 99);
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

  test('features/tutorials/adminCount/districts are stripped from tenant-admin patches', async () => {
    const before = await repo.getTenantConfig('dolphins');
    const res = await app.request('/tenant/config', {
      method: 'PUT',
      headers: tenantHeaders(DOLPHINS_ADMIN, 'dolphins'),
      body: JSON.stringify({
        features: { selfServeBranding: true, whatsappInvites: false },
        tutorials: [{ key: 'evil', title: 'Evil', src: 'https://evil.example/x.mp4' }],
        adminCount: 99,
        districts: ['Evil District'],
      }),
    });
    assert.equal(res.status, 200);
    const after = await repo.getTenantConfig('dolphins');
    assert.deepEqual(after?.features, before?.features, 'flags unchanged');
    assert.deepEqual(after?.tutorials, before?.tutorials);
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
    // The signed policy must carry the 1 MB cap and the exact content type.
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
