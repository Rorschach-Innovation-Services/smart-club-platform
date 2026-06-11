/**
 * Integration tests for the support-contact + club-notes write paths.
 *
 * Boots an in-process dynalite (pure-JS DynamoDB clone), creates the single
 * table, seeds a tenant, and drives the REAL Hono app via `app.request()` — no
 * network, no AWS. Auth uses the dev bypass (LOCAL_AUTH=1, x-dev-auth header),
 * the same path the offline stack uses.
 *
 * Run with the API package's test runner (tsx --test), which resolves the
 * NodeNext ".js" import specifiers to their ".ts" sources.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4599; // distinct from the dev stack's 4567
const TABLE = 'SmartClubTest';
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.LOCAL_AUTH = '1';
process.env.STAGE = 'local';
process.env.USER_POOL_ID = 'test-pool';
process.env.AWS_REGION ??= 'localhost';
// Compliance-doc view-url presigns locally (no network); dummy creds let SigV4 sign.
// A failed delete-on-replace must not hang the suite — cap S3 retries.
process.env.UPLOADS_BUCKET = 'test-uploads';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_MAX_ATTEMPTS = '1';

const devAuth = (memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email: 'admin@test', memberships })).toString('base64');
/** devAuth with an explicit sub/email — needed for multi-user team-management tests. */
const devAuthAs = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const ADMIN = devAuth([{ tenantId: 'dolphins', role: 'admin', clubIds: [] }]);
const REP = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['testers'] }]);

const headers = (auth: string) => ({
  'x-tenant': 'dolphins',
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

// Resolved in before().
let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');

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
});

after(() => {
  ddbServer?.close();
});

describe('PUT /tenant/support', () => {
  test('admin can edit; value is recombined as "Name · email"', async () => {
    const res = await app.request('/tenant/support', {
      method: 'PUT',
      headers: headers(ADMIN),
      body: JSON.stringify({ name: 'New Office', email: 'help@dolphinscricket.co.za' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { support: string };
    assert.equal(body.support, 'New Office · help@dolphinscricket.co.za');
  });

  test('club rep is forbidden (403)', async () => {
    const res = await app.request('/tenant/support', {
      method: 'PUT',
      headers: headers(REP),
      body: JSON.stringify({ name: 'Sneaky', email: 'rep@evil.com' }),
    });
    assert.equal(res.status, 403);
  });

  test('invalid email is rejected (400)', async () => {
    const res = await app.request('/tenant/support', {
      method: 'PUT',
      headers: headers(ADMIN),
      body: JSON.stringify({ name: 'Office', email: 'not-an-email' }),
    });
    assert.equal(res.status, 400);
  });

  test('blank name is rejected (400)', async () => {
    const res = await app.request('/tenant/support', {
      method: 'PUT',
      headers: headers(ADMIN),
      body: JSON.stringify({ name: '   ', email: 'a@b.co.za' }),
    });
    assert.equal(res.status, 400);
  });

  test('targeted write preserves sibling copy slots and leagues', async () => {
    const before = await repo.getTenantConfig('dolphins');
    const leaguesBefore = before?.leagues?.length ?? 0;
    assert.ok(leaguesBefore > 0, 'fixture should seed leagues');

    await app.request('/tenant/support', {
      method: 'PUT',
      headers: headers(ADMIN),
      body: JSON.stringify({ name: 'Cricket Services', email: 'support@dolphinscricket.co.za' }),
    });

    const after = await repo.getTenantConfig('dolphins');
    assert.equal(after?.branding.copy.support, 'Cricket Services · support@dolphinscricket.co.za');
    // Siblings untouched by the surgical SET branding.copy.support.
    assert.equal(after?.branding.copy.welcome, before?.branding.copy.welcome);
    assert.equal(after?.branding.copy.footer, before?.branding.copy.footer);
    assert.equal(after?.leagues?.length, leaguesBefore);
  });
});

describe('POST /clubs/:id/notes', () => {
  const baseClub = {
    id: 'testers',
    name: 'Testers CC',
    district: 'Test District',
    sub: 'sub-1',
    chair: 'Chair',
    affiliation: 'not_started' as const,
    paid: false,
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
  };

  before(async () => {
    await repo.createClub('dolphins', baseClub);
  });

  test('admin can append a note', async () => {
    const res = await app.request('/clubs/testers/notes', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ text: 'First note' }),
    });
    assert.equal(res.status, 200);
    const club = (await res.json()) as { notes?: unknown[] };
    assert.equal(club.notes?.length, 1);
  });

  test('blank text is rejected (400)', async () => {
    const res = await app.request('/clubs/testers/notes', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ text: '  ' }),
    });
    assert.equal(res.status, 400);
  });

  test('unknown club yields 404', async () => {
    const res = await app.request('/clubs/ghost/notes', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ text: 'hi' }),
    });
    assert.equal(res.status, 404);
  });

  test('concurrent appends compose via list_append (both land)', async () => {
    const start = (await repo.getClub('dolphins', 'testers'))?.notes?.length ?? 0;
    const mk = (text: string) => ({ id: text, text, author: 'a@test', at: '2026-06-03T00:00:00Z' });
    await Promise.all([
      repo.appendClubNote('dolphins', 'testers', mk('parallel-A')),
      repo.appendClubNote('dolphins', 'testers', mk('parallel-B')),
    ]);
    const after = await repo.getClub('dolphins', 'testers');
    assert.equal(after?.notes?.length, start + 2);
  });
});

describe('POST /clubs', () => {
  type ExcoChair = {
    chair?: string;
    exco?: { chair?: { name?: string; email?: string; cell?: string } };
  };

  test('admin onboard persists chair contact into exco.chair', async () => {
    const res = await app.request('/clubs', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({
        name: 'Verify FC',
        chair: 'Carlton',
        chairEmail: 'carlton@verifyfc.co.za',
        chairCell: '083 456 7890',
        district: 'Test District',
      }),
    });
    assert.equal(res.status, 201);
    const club = (await res.json()) as ExcoChair;
    // Both the top-level chair name and the nested exco.chair contact are populated.
    assert.equal(club.chair, 'Carlton');
    assert.equal(club.exco?.chair?.name, 'Carlton');
    assert.equal(club.exco?.chair?.email, 'carlton@verifyfc.co.za');
    assert.equal(club.exco?.chair?.cell, '083 456 7890');
  });

  test('chair name only defaults email/cell to empty strings (not undefined)', async () => {
    const res = await app.request('/clubs', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ name: 'Partial FC', chair: 'Solo', district: 'Test District' }),
    });
    assert.equal(res.status, 201);
    const club = (await res.json()) as ExcoChair;
    assert.equal(club.exco?.chair?.name, 'Solo');
    assert.equal(club.exco?.chair?.email, '');
    assert.equal(club.exco?.chair?.cell, '');
  });

  test('name-only onboard leaves exco undefined (no fake data)', async () => {
    const res = await app.request('/clubs', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ name: 'Bare Club', district: 'Test District' }),
    });
    assert.equal(res.status, 201);
    const club = (await res.json()) as ExcoChair;
    assert.equal(club.exco, undefined);
  });
});

describe('PATCH /clubs/:id — chair contact (repair existing clubs)', () => {
  type ExcoFull = {
    chair?: string;
    version?: number;
    exco?: {
      chair?: { name?: string; email?: string; cell?: string };
      sec?: { name?: string; email?: string };
    };
  };

  const mkClub = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    district: 'Test District',
    sub: '',
    chair: 'Carlton',
    affiliation: 'not_started' as const,
    paid: false,
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
  });

  test('sets exco.chair on a club created without any exco (the Westlake case)', async () => {
    await repo.createClub('dolphins', mkClub('repairme'));
    const res = await app.request('/clubs/repairme', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        chair: 'Carlton',
        exco: { chair: { name: 'Carlton', email: 'carlton@repair.co.za', cell: '083 111 2222' } },
        version: 1,
      }),
    });
    assert.equal(res.status, 200);
    const club = (await res.json()) as ExcoFull;
    assert.equal(club.chair, 'Carlton');
    assert.equal(club.exco?.chair?.email, 'carlton@repair.co.za');
    assert.equal(club.exco?.chair?.cell, '083 111 2222');
  });

  test('a full-exco patch preserves sibling members (sec)', async () => {
    await repo.createClub(
      'dolphins',
      mkClub('hassec', { exco: { sec: { name: 'Sam Sec', email: 'sam@sec.co.za' } } }),
    );
    // Client sends the FULL exco (sibling merged in) because the server shallow-merges.
    const res = await app.request('/clubs/hassec', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        chair: 'New Chair',
        exco: {
          sec: { name: 'Sam Sec', email: 'sam@sec.co.za' },
          chair: { name: 'New Chair', email: 'chair@hassec.co.za', cell: '082 000 0000' },
        },
        version: 1,
      }),
    });
    assert.equal(res.status, 200);
    const club = (await res.json()) as ExcoFull;
    assert.equal(club.exco?.chair?.email, 'chair@hassec.co.za');
    assert.equal(club.exco?.sec?.name, 'Sam Sec');
    assert.equal(club.exco?.sec?.email, 'sam@sec.co.za');
  });

  test('a stale version is rejected with 409 (modal stays open for retry)', async () => {
    await repo.createClub('dolphins', mkClub('staleclub')); // version 1
    const res = await app.request('/clubs/staleclub', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        chair: 'Carlton',
        exco: { chair: { name: 'Carlton', email: 'c@stale.co.za', cell: '' } },
        version: 99, // mismatched → conflict
      }),
    });
    assert.equal(res.status, 409);
  });
});

describe('POST /clubs/:id/send-invite', () => {
  // FROM_EMAIL / WHATSAPP_* are unset in the test env, so notify/ runs in dry-run:
  // sends "succeed" with synthetic ids and no real SES/Meta calls are made.
  const base = (id: string, exco?: Record<string, unknown>) => ({
    id,
    name: `${id} CC`,
    district: 'Test District',
    sub: 's',
    chair: 'Chair',
    affiliation: 'not_started' as const,
    paid: false,
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
    ...(exco ? { exco } : {}),
  });

  before(async () => {
    await repo.createClub(
      'dolphins',
      base('invitee', {
        chair: { name: 'Carlton', email: 'carlton@invitee.co.za', cell: '0768563601' },
      }),
    );
    await repo.createClub('dolphins', base('nocontact'));
  });

  const send = (id: string, body: unknown, auth = ADMIN) =>
    app.request(`/clubs/${id}/send-invite`, {
      method: 'POST',
      headers: headers(auth),
      body: JSON.stringify(body),
    });

  // Link must be a trusted origin (localhost in dev) AND target this club's path.
  const valid = {
    channels: ['email', 'whatsapp'],
    link: 'http://localhost:3201/club/invitee',
    idempotencyKey: 'k1',
  };

  test('dry-run sends both channels and records the comm log', async () => {
    const res = await send('invitee', valid);
    assert.equal(res.status, 201);
    const body = (await res.json()) as { results: { channel: string; status: string }[] };
    assert.equal(body.results.length, 2);
    assert.ok(body.results.every((r) => r.status === 'sent'));
    const club = await repo.getClub('dolphins', 'invitee');
    assert.equal(club?.commLog?.length, 2);
  });

  test('same idempotency key replays without re-sending or re-logging', async () => {
    const res = await send('invitee', valid); // same key 'k1'
    assert.equal(res.status, 200);
    const body = (await res.json()) as { deduped?: boolean; results: unknown[] };
    assert.equal(body.deduped, true);
    const club = await repo.getClub('dolphins', 'invitee');
    assert.equal(club?.commLog?.length, 2, 'no extra comm-log entries on replay');
  });

  test('missing chair contact yields skipped (not failed) per channel', async () => {
    const res = await send('nocontact', {
      channels: ['email', 'whatsapp'],
      link: 'http://localhost:3201/club/nocontact',
      idempotencyKey: 'k-nocontact',
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      results: { status: string; error?: string; to?: string }[];
    };
    assert.ok(body.results.every((r) => r.status === 'skipped'));
    assert.ok(body.results.every((r) => !!r.error));
    // #6: a skip with no value on file must not persist an empty `to`.
    assert.ok(body.results.every((r) => r.to === undefined));
  });

  test('empty channels is rejected (400)', async () => {
    const res = await send('invitee', {
      channels: [],
      link: 'http://localhost:3201/club/invitee',
      idempotencyKey: 'k2',
    });
    assert.equal(res.status, 400);
  });

  test('unknown channel is rejected (400)', async () => {
    const res = await send('invitee', {
      channels: ['sms'],
      link: 'http://localhost:3201/club/invitee',
      idempotencyKey: 'k3',
    });
    assert.equal(res.status, 400);
  });

  test('non-http link is rejected (400)', async () => {
    const res = await send('invitee', {
      channels: ['email'],
      link: 'javascript:alert(1)',
      idempotencyKey: 'k4',
    });
    assert.equal(res.status, 400);
  });

  test('#5: link on an untrusted host is rejected (400)', async () => {
    const res = await send('invitee', {
      channels: ['email'],
      link: 'https://evil.example.com/club/invitee',
      idempotencyKey: 'k-host',
    });
    assert.equal(res.status, 400);
  });

  test('#5: link targeting a different club path is rejected (400)', async () => {
    const res = await send('invitee', {
      channels: ['email'],
      link: 'http://localhost:3201/club/some-other-club',
      idempotencyKey: 'k-path',
    });
    assert.equal(res.status, 400);
  });

  test('missing idempotencyKey is rejected (400)', async () => {
    const res = await send('invitee', {
      channels: ['email'],
      link: 'http://localhost:3201/club/invitee',
    });
    assert.equal(res.status, 400);
  });

  test('club rep is forbidden (403)', async () => {
    const res = await send('invitee', valid, REP);
    assert.equal(res.status, 403);
  });

  test('unknown club yields 404', async () => {
    const res = await send('ghost', {
      ...valid,
      link: 'http://localhost:3201/club/ghost',
      idempotencyKey: 'k5',
    });
    assert.equal(res.status, 404);
  });
});

describe('POST /clubs/:id/send-fixtures', () => {
  // FROM_EMAIL / WHATSAPP_* unset ⇒ notify/ runs dry-run (synthetic ids, no real sends).
  // REP is scoped to clubIds ['testers'] (module-level), so it may share for 'testers'.
  const OTHER_REP = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['elsewhere'] }]);

  const club = (id: string) => ({
    id,
    name: `${id} CC`,
    district: 'Test District',
    sub: 's',
    chair: 'Chair',
    affiliation: 'not_started' as const,
    paid: false,
    cqi: 0,
    docs: {},
    players: 0,
    teams: 0,
    women: 0,
    juniors: 0,
    color: '#123456',
    ground: { venue: `${id} Oval`, lat: -29.85, lon: 31.02 },
    leagues: [],
    version: 1,
  });

  const player = (clubId: string, n: string, extra: Record<string, unknown>) => ({
    naturalKey: n,
    clubId,
    firstName: n,
    lastName: 'Player',
    dob: '1995-01-01',
    isMinor: false,
    consentAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
    ...extra,
  });

  before(async () => {
    // 'testers' already exists (created by the notes suite) and REP is scoped to it.
    await repo.createClub('dolphins', club('rivals'));
    await repo.createClub('dolphins', club('emptyfix')); // no released series → 409
    await repo.putSeries('dolphins', {
      id: 'fx-series',
      name: 'Premier League · 2026/27',
      startDate: '2026-06-01',
      teams: ['testers', 'rivals'],
      fixtures: [{ home: 'rivals', away: 'testers', date: '2026-06-01', round: 1 }],
      released: true,
      releasedAt: '2026-06-01T00:00:00.000Z',
      version: 1,
    });
    // 3 players: one reachable, one minor (skipped — no guardian contact), one with no contact.
    await repo.createPlayer(
      'dolphins',
      player('testers', 'Reachable', { email: 'reach@testers.co.za', cell: '0768563601' }),
    );
    await repo.createPlayer(
      'dolphins',
      player('testers', 'Minor', {
        email: 'kid@testers.co.za',
        cell: '0760000000',
        isMinor: true,
        guardianName: 'Guardian',
      }),
    );
    await repo.createPlayer('dolphins', player('testers', 'Nocontact', {}));
  });

  const send = (id: string, body: unknown, auth: string) =>
    app.request(`/clubs/${id}/send-fixtures`, {
      method: 'POST',
      headers: headers(auth),
      body: JSON.stringify(body),
    });

  test('rep shares released fixtures with players (201) — minors/no-contact skipped', async () => {
    const res = await send(
      'testers',
      { channels: ['email', 'whatsapp'], idempotencyKey: 'fx1' },
      REP,
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      results: { channel: string; status: string; summary?: string }[];
    };
    // One PII-free summary row per channel (not one per recipient); the count lives in
    // `summary`, never `error`.
    assert.equal(body.results.length, 2);
    const email = body.results.find((r) => r.channel === 'email');
    // 1 reachable sent; minor + no-contact skipped → "1 sent · 2 skipped" (no failure denom).
    assert.equal(email?.status, 'sent');
    assert.equal(email?.summary, '1 sent · 2 skipped');
    // Comm log records the broadcast as kind:'fixtures' summaries with no recipient PII.
    const stored = await repo.getClub('dolphins', 'testers');
    assert.equal(stored?.commLog?.length, 2);
    assert.ok(stored?.commLog?.every((e) => e.kind === 'fixtures'));
    assert.ok(stored?.commLog?.every((e) => e.to === undefined));
  });

  test('same idempotency key replays without re-sending or re-logging', async () => {
    const res = await send(
      'testers',
      { channels: ['email', 'whatsapp'], idempotencyKey: 'fx1' },
      REP,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { deduped?: boolean };
    assert.equal(body.deduped, true);
    const stored = await repo.getClub('dolphins', 'testers');
    assert.equal(stored?.commLog?.length, 2, 'no extra comm-log entries on replay');
  });

  test('a rep scoped to another club is forbidden (403)', async () => {
    const res = await send('testers', { channels: ['email'], idempotencyKey: 'fx-403' }, OTHER_REP);
    assert.equal(res.status, 403);
  });

  test('unknown channel is rejected (400)', async () => {
    const res = await send('testers', { channels: ['sms'], idempotencyKey: 'fx-sms' }, REP);
    assert.equal(res.status, 400);
  });

  test('missing idempotencyKey is rejected (400)', async () => {
    const res = await send('testers', { channels: ['email'] }, REP);
    assert.equal(res.status, 400);
  });

  test('no released fixtures yields 409', async () => {
    // Admin passes assertClubAccess for any club; emptyfix has no released series.
    const res = await send('emptyfix', { channels: ['email'], idempotencyKey: 'fx-empty' }, ADMIN);
    assert.equal(res.status, 409);
  });

  test('unknown club yields 404', async () => {
    const res = await send('ghostclub', { channels: ['email'], idempotencyKey: 'fx-ghost' }, ADMIN);
    assert.equal(res.status, 404);
  });

  test('replay survives the series being un-released (idempotency beats state change)', async () => {
    const key = 'fx-replay';
    // First send while the series is released → succeeds and stores a summary.
    const first = await send('testers', { channels: ['email'], idempotencyKey: key }, REP);
    assert.equal(first.status, 201);
    // Admin un-releases the only series this club is in.
    await repo.putSeries('dolphins', {
      id: 'fx-series',
      name: 'Premier League · 2026/27',
      startDate: '2026-06-01',
      teams: ['testers', 'rivals'],
      fixtures: [{ home: 'rivals', away: 'testers', date: '2026-06-01', round: 1 }],
      released: false,
      releasedAt: null,
      version: 1,
    });
    // Retry with the SAME key must REPLAY the stored summary (200/deduped), not 409 —
    // the claim now precedes the "no released fixtures" gate.
    const retry = await send('testers', { channels: ['email'], idempotencyKey: key }, REP);
    assert.equal(retry.status, 200);
    const body = (await retry.json()) as { deduped?: boolean; results: unknown[] };
    assert.equal(body.deduped, true);
    assert.equal(body.results.length, 1);
  });
});

describe('eraseTenantData removes INVITE# idempotency markers', () => {
  // Regression guard: markers carry recipient contact and aren't in the gsi1 club
  // listing, so erasure must enumerate them explicitly (repo.listClubInviteKeys).
  test('a marker is gone after tenant erasure (key reclaims fresh)', async () => {
    // No tenant config needed — erasure + claim work on keys directly.
    await repo.createClub('erasetest', {
      id: 'ec',
      name: 'Erase CC',
      district: 'Test District',
      sub: 's',
      chair: 'Chair',
      affiliation: 'not_started' as const,
      paid: false,
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
    });

    // Claim creates the marker; a second claim of the same key sees it (replay).
    assert.equal(await repo.claimInviteSend('erasetest', 'ec', 'kE', ['email']), null);
    const replay = await repo.claimInviteSend('erasetest', 'ec', 'kE', ['email']);
    assert.ok(replay, 'marker should exist before erasure (replay, not fresh claim)');

    await repo.eraseTenantData('erasetest');

    // After erasure the marker is gone, so the same key claims fresh (returns null).
    assert.equal(
      await repo.claimInviteSend('erasetest', 'ec', 'kE', ['email']),
      null,
      'marker should have been deleted by eraseTenantData',
    );
  });

  test('clearCohort also removes markers (and its CONFIG/USER guard tolerates INVITE# keys)', async () => {
    await repo.createClub('cohorttest', {
      id: 'cc',
      name: 'Cohort CC',
      district: 'Test District',
      sub: 's',
      chair: 'Chair',
      affiliation: 'not_started' as const,
      paid: false,
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
    });
    assert.equal(await repo.claimInviteSend('cohorttest', 'cc', 'kC', ['whatsapp']), null);
    // Must not throw on the INVITE# key (the guard only rejects CONFIG / USER#).
    await repo.clearCohort('cohorttest');
    assert.equal(
      await repo.claimInviteSend('cohorttest', 'cc', 'kC', ['whatsapp']),
      null,
      'marker should have been deleted by clearCohort',
    );
  });
});

describe('PATCH /clubs/:id/progression', () => {
  before(async () => {
    await repo.createClub('dolphins', {
      id: 'progclub',
      name: 'Prog CC',
      district: 'Test District',
      sub: 'sub-1',
      chair: 'Chair',
      affiliation: 'not_started',
      paid: false,
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
    });
  });

  test('admin can switch a club to payment-gated; it persists', async () => {
    const res = await app.request('/clubs/progclub/progression', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ progressionMode: 'payment' }),
    });
    assert.equal(res.status, 200);
    const club = (await res.json()) as { progressionMode?: string };
    assert.equal(club.progressionMode, 'payment');
    // Round-trips through the store, not just the response.
    const stored = await repo.getClub('dolphins', 'progclub');
    assert.equal((stored as { progressionMode?: string })?.progressionMode, 'payment');
  });

  test('club rep is forbidden (403)', async () => {
    const res = await app.request('/clubs/progclub/progression', {
      method: 'PATCH',
      headers: headers(REP),
      body: JSON.stringify({ progressionMode: 'submission' }),
    });
    assert.equal(res.status, 403);
  });

  test('invalid mode is rejected (400)', async () => {
    const res = await app.request('/clubs/progclub/progression', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ progressionMode: 'whenever' }),
    });
    assert.equal(res.status, 400);
  });

  test('malformed/empty body is a 400, not a 500', async () => {
    const res = await app.request('/clubs/progclub/progression', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: 'not json',
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /clubs — progression default', () => {
  test('onboarded club defaults to submission-driven progression', async () => {
    const res = await app.request('/clubs', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ name: 'Default Prog FC', district: 'Test District' }),
    });
    assert.equal(res.status, 201);
    const club = (await res.json()) as { progressionMode?: string };
    assert.equal(club.progressionMode, 'submission');
  });
});

describe('compliance doc view-url + replace', () => {
  const baseClub = {
    id: 'docclub',
    name: 'Doc Club CC',
    district: 'Test District',
    sub: 'sub-1',
    chair: 'Chair',
    affiliation: 'not_started' as const,
    paid: false,
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
  };
  const DOC_REP = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['docclub'] }]);
  const OTHER_REP = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['elsewhere'] }]);

  before(async () => {
    await repo.createClub('dolphins', baseClub);
  });

  test('mark a doc uploaded, then mint a presigned view-url (admin)', async () => {
    const up = await app.request('/clubs/docclub/docs/constitution', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ objectKey: 'dolphins/docclub/constitution-a.pdf', size: 1000 }),
    });
    assert.equal(up.status, 200);

    const res = await app.request('/clubs/docclub/docs/constitution/view-url', {
      method: 'POST',
      headers: headers(ADMIN),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { viewUrl?: string };
    assert.ok(body.viewUrl?.startsWith('https://'), 'returns a presigned https URL');
  });

  test('owning rep can mint a view-url', async () => {
    const res = await app.request('/clubs/docclub/docs/constitution/view-url', {
      method: 'POST',
      headers: headers(DOC_REP),
    });
    assert.equal(res.status, 200);
  });

  test('view-url is 404 when the document has no file on record', async () => {
    const res = await app.request('/clubs/docclub/docs/agm/view-url', {
      method: 'POST',
      headers: headers(ADMIN),
    });
    assert.equal(res.status, 404);
  });

  test('a rep without access to the club is rejected (403)', async () => {
    const res = await app.request('/clubs/docclub/docs/constitution/view-url', {
      method: 'POST',
      headers: headers(OTHER_REP),
    });
    assert.equal(res.status, 403);
  });

  test('unknown/retired doc keys are rejected on all three routes (400)', async () => {
    // 'clubInventory' was retired from REQUIRED_DOCS for 2026/27 — a stale SPA tab
    // or direct call must not be able to repopulate it after cleanup-club-inventory.
    for (const key of ['clubInventory', 'notARealDoc']) {
      const upload = await app.request(`/clubs/docclub/docs/${key}/upload-url`, {
        method: 'POST',
        headers: headers(ADMIN),
      });
      assert.equal(upload.status, 400, `${key} upload-url`);

      const patch = await app.request(`/clubs/docclub/docs/${key}`, {
        method: 'PATCH',
        headers: headers(ADMIN),
        body: JSON.stringify({ objectKey: `dolphins/docclub/${key}-x.pdf`, size: 1000 }),
      });
      assert.equal(patch.status, 400, `${key} patch`);

      const view = await app.request(`/clubs/docclub/docs/${key}/view-url`, {
        method: 'POST',
        headers: headers(ADMIN),
      });
      assert.equal(view.status, 400, `${key} view-url`);
    }
  });

  test('generic club PATCH rejects unknown doc keys but allows carrying existing ones', async () => {
    // A stale pre-deploy admin tab's "mark all compliant" sends docs/docMeta wholesale —
    // it must not be able to (re)introduce a retired key via the generic PATCH route.
    const bad = await app.request('/clubs/docclub', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ docs: { clubInventory: true } }),
    });
    assert.equal(bad.status, 400);

    // Keys already on the club remain patchable so pre-cleanup records can still be
    // carried or cleared. Seed the retired key at the repo layer (bypassing the API
    // gate) to simulate a club that uploaded before the key was retired.
    const seeded = (await repo.getClub('dolphins', 'docclub')) as {
      docs: Record<string, boolean>;
    };
    await repo.updateClub(
      'dolphins',
      'docclub',
      { docs: { ...seeded.docs, clubInventory: true } },
      'test-seed',
      new Date().toISOString(),
    );

    const club = (await repo.getClub('dolphins', 'docclub')) as { docs: Record<string, boolean> };
    assert.equal(club.docs.clubInventory, true, 'retired key seeded');
    const carry = await app.request('/clubs/docclub', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ docs: { ...club.docs, agm: true } }),
    });
    assert.equal(carry.status, 200, 'carrying an existing retired key is allowed');

    // Clearing the retired key (sending docs without it) is also allowed…
    const { clubInventory: _retired, ...withoutRetired } = club.docs;
    const clear = await app.request('/clubs/docclub', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ docs: { ...withoutRetired, agm: true } }),
    });
    assert.equal(clear.status, 200, 'clearing the retired key is allowed');

    // …and once cleared, the key is gone from the record and can no longer be reintroduced.
    const after = (await repo.getClub('dolphins', 'docclub')) as { docs: Record<string, boolean> };
    assert.equal('clubInventory' in after.docs, false, 'retired key cleared from record');
    const reintroduce = await app.request('/clubs/docclub', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ docs: { ...after.docs, clubInventory: true } }),
    });
    assert.equal(reintroduce.status, 400, 'cleared retired key cannot be reintroduced');
  });

  test('replacing a doc updates the stored objectKey (delete-on-replace path)', async () => {
    const res = await app.request('/clubs/docclub/docs/constitution', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ objectKey: 'dolphins/docclub/constitution-b.pdf', size: 2000 }),
    });
    assert.equal(res.status, 200);
    const club = (await repo.getClub('dolphins', 'docclub')) as {
      docMeta?: Record<string, { objectKey?: string }>;
    };
    assert.equal(club.docMeta?.constitution?.objectKey, 'dolphins/docclub/constitution-b.pdf');
  });
});

describe('/admin/users', () => {
  // A dedicated tenant so the admin marker GSI (which drives the last-admin counter)
  // is isolated from the other suites' users. FROM_EMAIL/WHATSAPP_* unset ⇒ notify/
  // runs in dry-run; LOCAL_AUTH=1 ⇒ Cognito is stubbed (ensurePasswordlessUser returns
  // a deterministic local-<sha1(email)> sub; sign-out/delete are no-ops).
  const T = 'team';
  const adminHeaders = (auth: string) => ({
    'x-tenant': T,
    'x-dev-auth': auth,
    'content-type': 'application/json',
  });
  // Caller tokens (the caller's own sub is independent of the users they create).
  const TADMIN = devAuthAs('caller-admin', 'caller@team.test', [
    { tenantId: T, role: 'admin', clubIds: [] },
  ]);
  const TREP = devAuthAs('caller-rep', 'rep@team.test', [
    { tenantId: T, role: 'rep', clubIds: ['c1'] },
  ]);

  // Deterministic offline sub for an email — mirrors cognito-users.localSub so a test
  // can address a just-created user by its sub.
  const subFor = async (email: string) => {
    const { createHash } = await import('node:crypto');
    return `local-${createHash('sha1').update(email.trim().toLowerCase()).digest('hex')}`;
  };

  const invite = (body: unknown, auth = TADMIN) =>
    app.request('/admin/users', {
      method: 'POST',
      headers: adminHeaders(auth),
      body: JSON.stringify(body),
    });
  const list = (auth = TADMIN) => app.request('/admin/users', { headers: adminHeaders(auth) });
  const patch = (sub: string, body: unknown, auth = TADMIN) =>
    app.request(`/admin/users/${sub}`, {
      method: 'PATCH',
      headers: adminHeaders(auth),
      body: JSON.stringify(body),
    });
  const remove = (sub: string, auth = TADMIN) =>
    app.request(`/admin/users/${sub}`, { method: 'DELETE', headers: adminHeaders(auth) });

  before(async () => {
    // Seed a blank config for the isolated tenant (no seed-core branding for 'team').
    await repo.putTenantConfig({
      tenant: T,
      branding: {
        name: 'Team Test Union',
        title: 'Team Test',
        logoUrl: '',
        colors: {},
        copy: {},
      },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [],
    });
  });

  test('GET lists invited users with role, clubIds and pending status', async () => {
    const adminEmail = 'list-admin@team.test';
    const repEmail = 'list-rep@team.test';
    assert.equal((await invite({ email: adminEmail, role: 'admin' })).status, 201);
    assert.equal(
      (await invite({ email: repEmail, role: 'rep', clubIds: ['c1', 'c2'] })).status,
      201,
    );

    const res = await list();
    assert.equal(res.status, 200);
    const rows = (await res.json()) as Array<{
      sub: string;
      email: string;
      role: string;
      clubIds: string[];
      invitedAt?: string;
      status: string;
    }>;
    const admin = rows.find((r) => r.email === adminEmail);
    const rep = rows.find((r) => r.email === repEmail);
    assert.ok(admin && rep, 'both invited users appear in the roster');
    assert.equal(admin!.role, 'admin');
    assert.deepEqual(admin!.clubIds, []);
    // clubIds come from the enriched profile (markers don't carry them).
    assert.deepEqual(rep!.clubIds.sort(), ['c1', 'c2']);
    assert.ok(rep!.invitedAt, 'invitedAt is stamped');
    // No sign-in yet ⇒ pending.
    assert.equal(admin!.status, 'pending');
    assert.equal(rep!.status, 'pending');
  });

  test('status flips to active once lastLoginAt is stamped (first sign-in)', async () => {
    const email = 'logs-in@team.test';
    await invite({ email, role: 'rep', clubIds: ['c1'] });
    const sub = await subFor(email);
    await repo.stampFirstLogin(sub); // simulate the PreTokenGen first-login stamp

    const rows = (await (await list()).json()) as Array<{ email: string; status: string }>;
    assert.equal(rows.find((r) => r.email === email)?.status, 'active');
  });

  test('POST returns a loginUrl + per-channel send results (dry-run) and normalizes email', async () => {
    const res = await invite({
      email: 'MixedCase@Team.Test',
      role: 'admin',
      channels: ['email', 'whatsapp'],
      link: 'http://localhost:5173/',
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      sub: string;
      email: string;
      loginUrl: string;
      results?: { channel: string; status: string }[];
    };
    // Email normalized to lowercase server-side.
    assert.equal(body.email, 'mixedcase@team.test');
    assert.equal(body.loginUrl, 'http://localhost:5173/');
    assert.equal(body.results?.length, 2);
    // Email "sends" in dry-run (synthetic id); WhatsApp is skipped — a staff invite has
    // no cell on file (email is the identity / primary staff channel).
    assert.equal(body.results?.find((r) => r.channel === 'email')?.status, 'sent');
    assert.equal(body.results?.find((r) => r.channel === 'whatsapp')?.status, 'skipped');
    // Stored email is the normalized form (so it matches the Cognito username on offboard).
    const stored = await repo.getUser(body.sub);
    assert.equal(stored?.email, 'mixedcase@team.test');
  });

  test('re-inviting an ALREADY-ACTIVE user is a 409 (no silent role reset)', async () => {
    const email = 'active-already@team.test';
    await invite({ email, role: 'rep', clubIds: ['c1'] });
    const sub = await subFor(email);
    await repo.stampFirstLogin(sub); // now active

    const res = await invite({ email, role: 'admin' });
    assert.equal(res.status, 409);
    // Role/scope unchanged by the rejected re-invite.
    const stored = await repo.getUser(sub);
    const m = stored?.memberships.find((mm) => mm.tenantId === T);
    assert.equal(m?.role, 'rep');
    assert.deepEqual(m?.clubIds, ['c1']);
  });

  test('PATCH promotes rep→admin (clubIds forced empty) and demotes admin→rep', async () => {
    const email = 'role-swap@team.test';
    await invite({ email, role: 'rep', clubIds: ['c1'] });
    const sub = await subFor(email);

    const up = await patch(sub, { role: 'admin' });
    assert.equal(up.status, 200);
    const upBody = (await up.json()) as { role: string; clubIds: string[] };
    assert.equal(upBody.role, 'admin');
    assert.deepEqual(upBody.clubIds, [], 'admins are forced to whole-union scope');

    // Demote back (another admin exists, so this is allowed).
    const down = await patch(sub, { role: 'rep', clubIds: ['c2'] });
    assert.equal(down.status, 200);
    const downBody = (await down.json()) as { role: string; clubIds: string[] };
    assert.equal(downBody.role, 'rep');
    assert.deepEqual(downBody.clubIds, ['c2']);
  });

  test('PATCH a rep to clubIds:[] is rejected (400 — would be a dead account)', async () => {
    const email = 'no-clubs@team.test';
    await invite({ email, role: 'rep', clubIds: ['c1'] });
    const sub = await subFor(email);
    const res = await patch(sub, { clubIds: [] });
    assert.equal(res.status, 400);
  });

  test('last-admin guard: demoting the only admin in a tenant is rejected (409)', async () => {
    // Fresh isolated tenant with exactly one admin.
    const solo = 'team-solo';
    await repo.putTenantConfig({
      tenant: solo,
      branding: { name: 'Solo', title: 'Solo', logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [],
    });
    const soloHeaders = (auth: string) => ({
      'x-tenant': solo,
      'x-dev-auth': auth,
      'content-type': 'application/json',
    });
    const soloAdminToken = devAuthAs('caller-solo', 'solo@team.test', [
      { tenantId: solo, role: 'admin', clubIds: [] },
    ]);
    const email = 'only-admin@solo.test';
    await app.request('/admin/users', {
      method: 'POST',
      headers: soloHeaders(soloAdminToken),
      body: JSON.stringify({ email, role: 'admin' }),
    });
    const sub = await subFor(email);
    // Only one admin ⇒ demote rejected by the transactional adminCount>1 guard.
    const res = await app.request(`/admin/users/${sub}`, {
      method: 'PATCH',
      headers: soloHeaders(soloAdminToken),
      body: JSON.stringify({ role: 'rep', clubIds: ['c1'] }),
    });
    assert.equal(res.status, 409);
    // Still an admin (the rejected transaction rolled back the user write too).
    const stored = await repo.getUser(sub);
    assert.equal(stored?.memberships.find((m) => m.tenantId === solo)?.role, 'admin');
    // Promoting a 2nd admin then demoting the first now succeeds (transactional decrement).
    await app.request('/admin/users', {
      method: 'POST',
      headers: soloHeaders(soloAdminToken),
      body: JSON.stringify({ email: 'second-admin@solo.test', role: 'admin' }),
    });
    const ok = await app.request(`/admin/users/${sub}`, {
      method: 'PATCH',
      headers: soloHeaders(soloAdminToken),
      body: JSON.stringify({ role: 'rep', clubIds: ['c1'] }),
    });
    assert.equal(ok.status, 200);
    // adminCount decremented back to 1.
    const cfg = await repo.getTenantConfig(solo);
    assert.equal(cfg?.adminCount, 1);
  });

  test('re-inviting a pending admin as a rep decrements adminCount (no drift, guard still holds)', async () => {
    const tn = 'team-reinvite';
    await repo.putTenantConfig({
      tenant: tn,
      branding: { name: 'RI', title: 'RI', logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [],
    });
    const h = (auth: string) => ({
      'x-tenant': tn,
      'x-dev-auth': auth,
      'content-type': 'application/json',
    });
    const caller = devAuthAs('caller-ri', 'ri@team.test', [
      { tenantId: tn, role: 'admin', clubIds: [] },
    ]);
    const reqUser = (body: unknown) =>
      app.request('/admin/users', {
        method: 'POST',
        headers: h(caller),
        body: JSON.stringify(body),
      });

    // Two stored admins A and B, both pending (never signed in).
    await reqUser({ email: 'a@ri.test', role: 'admin' });
    await reqUser({ email: 'b@ri.test', role: 'admin' });
    assert.equal((await repo.getTenantConfig(tn))?.adminCount, 2);

    // Re-invite still-pending admin A down to rep — an admin→rep transition that MUST
    // decrement adminCount. The bug left the counter at 2 (drift high), which would later
    // let the last-admin guard be bypassed.
    const subA = await subFor('a@ri.test');
    const re = await reqUser({ email: 'a@ri.test', role: 'rep', clubIds: ['c1'] });
    assert.equal(re.status, 201);
    assert.equal(
      (await repo.getUser(subA))?.memberships.find((m) => m.tenantId === tn)?.role,
      'rep',
    );
    assert.equal(
      (await repo.getTenantConfig(tn))?.adminCount,
      1,
      'adminCount must decrement on re-invite-demote',
    );

    // B is now the only admin — the guard must reject demoting them (defeated if drifted).
    const subB = await subFor('b@ri.test');
    const demoteB = await app.request(`/admin/users/${subB}`, {
      method: 'PATCH',
      headers: h(caller),
      body: JSON.stringify({ role: 'rep', clubIds: ['c1'] }),
    });
    assert.equal(demoteB.status, 409);
  });

  test('cross-tenant safety: PATCH in tenant A leaves tenant B membership + marker intact', async () => {
    // One user with memberships in BOTH 'team' (A) and 'dolphins' (B).
    const email = 'multi-tenant@team.test';
    const sub = await subFor(email);
    await repo.putUser({
      sub,
      email,
      memberships: [
        { tenantId: T, role: 'rep', clubIds: ['c1'] },
        { tenantId: 'dolphins', role: 'rep', clubIds: ['testers'] },
      ],
      onboardingSeen: {},
    });

    // PATCH the user in tenant A only.
    const res = await patch(sub, { role: 'rep', clubIds: ['c9'] });
    assert.equal(res.status, 200);

    const after = await repo.getUser(sub);
    // Tenant B membership untouched.
    const b = after?.memberships.find((m) => m.tenantId === 'dolphins');
    assert.deepEqual(b, { tenantId: 'dolphins', role: 'rep', clubIds: ['testers'] });
    // Tenant A reflects the patch.
    assert.deepEqual(after?.memberships.find((m) => m.tenantId === T)?.clubIds, ['c9']);
    // And tenant B's TENANT# marker still exists (asserted via the listing, not just the array).
    const bRoster = await repo.listTenantUsers('dolphins');
    assert.ok(
      bRoster.some((u) => u.sub === sub),
      'tenant B marker survives the tenant-A PATCH',
    );
  });

  test('cross-tenant safety: DELETE in tenant A leaves tenant B membership + marker intact', async () => {
    const email = 'multi-del@team.test';
    const sub = await subFor(email);
    await repo.putUser({
      sub,
      email,
      memberships: [
        { tenantId: T, role: 'rep', clubIds: ['c1'] },
        { tenantId: 'dolphins', role: 'rep', clubIds: ['testers'] },
      ],
      onboardingSeen: {},
    });

    const res = await remove(sub);
    assert.equal(res.status, 200);

    const after = await repo.getUser(sub);
    assert.ok(after, 'user still exists (kept tenant B membership)');
    assert.equal(after?.memberships.length, 1);
    assert.equal(after?.memberships[0].tenantId, 'dolphins');
    // Tenant B marker intact; tenant A marker gone.
    assert.ok((await repo.listTenantUsers('dolphins')).some((u) => u.sub === sub));
    assert.ok(!(await repo.listTenantUsers(T)).some((u) => u.sub === sub));
  });

  test('DELETE a rep removes their membership + marker', async () => {
    const email = 'remove-rep@team.test';
    await invite({ email, role: 'rep', clubIds: ['c1'] });
    const sub = await subFor(email);
    assert.ok((await repo.listTenantUsers(T)).some((u) => u.sub === sub));

    const res = await remove(sub);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.ok(!(await repo.listTenantUsers(T)).some((u) => u.sub === sub), 'marker is gone');
  });

  test('DELETE a single-membership user fully offboards them (USER# gone)', async () => {
    const email = 'offboard-me@team.test';
    await invite({ email, role: 'rep', clubIds: ['c1'] });
    const sub = await subFor(email);
    assert.ok(await repo.getUser(sub), 'user exists before removal');

    const res = await remove(sub);
    assert.equal(res.status, 200);
    assert.equal(await repo.getUser(sub), null, 'USER# record fully deleted');
  });

  test('last-admin guard on DELETE: removing the only admin is rejected (409)', async () => {
    const solo = 'team-del-solo';
    await repo.putTenantConfig({
      tenant: solo,
      branding: { name: 'Solo', title: 'Solo', logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [],
    });
    const soloHeaders = (auth: string) => ({
      'x-tenant': solo,
      'x-dev-auth': auth,
      'content-type': 'application/json',
    });
    const tok = devAuthAs('caller-del-solo', 'solo2@team.test', [
      { tenantId: solo, role: 'admin', clubIds: [] },
    ]);
    const email = 'last-admin@solo.test';
    await app.request('/admin/users', {
      method: 'POST',
      headers: soloHeaders(tok),
      body: JSON.stringify({ email, role: 'admin' }),
    });
    const sub = await subFor(email);
    const res = await app.request(`/admin/users/${sub}`, {
      method: 'DELETE',
      headers: soloHeaders(tok),
    });
    assert.equal(res.status, 409);
    // Still present (the guard ran before any delete).
    assert.ok(await repo.getUser(sub), 'last admin was not removed');
  });

  test('POST /admin/users/:sub/resend returns send results (dry-run)', async () => {
    const email = 'resend-me@team.test';
    await invite({ email, role: 'rep', clubIds: ['c1'] });
    const sub = await subFor(email);
    const res = await app.request(`/admin/users/${sub}/resend`, {
      method: 'POST',
      headers: adminHeaders(TADMIN),
      body: JSON.stringify({ channels: ['email'] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { results: { channel: string; status: string }[] };
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].status, 'sent');
  });

  test('a non-admin (rep) is forbidden (403)', async () => {
    const res = await list(TREP);
    assert.equal(res.status, 403);
  });
});

describe('reconcileTenantAdmins (orphan pruning)', () => {
  // reconcile takes an INJECTED `exists` so orphan logic is testable without Cognito.
  // The atomic ADD -1 prune (repo.pruneAdminMembership) is what keeps the count race-free;
  // the single-threaded harness can't exercise the concurrency, only the prune semantics.
  let reconcile: typeof import('../src/reconcile.js');
  before(async () => {
    reconcile = await import('../src/reconcile.js');
  });

  const OLD = '2026-01-01T00:00:00.000Z'; // well past the 10-min grace window
  const seedTenant = (t: string) =>
    repo.putTenantConfig({
      tenant: t,
      branding: { name: 'O', title: 'O', logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [],
    });
  const admin = (t: string, email: string, invitedAt: string) => ({
    sub: `sub-${email}`,
    email,
    memberships: [{ tenantId: t, role: 'admin' as const, clubIds: [], invitedAt }],
    onboardingSeen: {},
  });

  test('prunes an orphaned admin and frees the last-admin floor', async () => {
    const t = 'orphan-a';
    await seedTenant(t);
    await repo.putUser(admin(t, 'real@o.test', OLD));
    await repo.putUser(admin(t, 'orphan@o.test', OLD));
    await repo.recountAdmins(t); // adminCount = 2 (membership count, incl. the orphan)
    assert.equal((await repo.getTenantConfig(t))?.adminCount, 2);

    // Cognito reports the orphan gone; the real one present.
    await reconcile.reconcileTenantAdmins(t, async (email) => email !== 'orphan@o.test');

    assert.equal((await repo.getTenantConfig(t))?.adminCount, 1, 'orphan atomically decremented');
    const orphan = await repo.getUser('sub-orphan@o.test');
    assert.equal(
      orphan?.memberships.some((m) => m.tenantId === t),
      false,
      'orphan membership dropped',
    );
    // The real admin is now the genuine last admin → the guarded decrement refuses.
    await assert.rejects(() => repo.decrementAdminCount(t), repo.LastAdminError);
  });

  test('keeps an admin whose Cognito user exists (no-op)', async () => {
    const t = 'orphan-keep';
    await seedTenant(t);
    await repo.putUser(admin(t, 'a@o.test', OLD));
    await repo.putUser(admin(t, 'b@o.test', OLD));
    await repo.recountAdmins(t);
    await reconcile.reconcileTenantAdmins(t, async () => true);
    assert.equal((await repo.getTenantConfig(t))?.adminCount, 2, 'nothing pruned');
  });

  test('does NOT prune a just-invited admin within the grace window', async () => {
    const t = 'orphan-grace';
    await seedTenant(t);
    await repo.putUser(admin(t, 'fresh@o.test', new Date().toISOString())); // recent
    await repo.recountAdmins(t);
    await reconcile.reconcileTenantAdmins(t, async () => false); // reports missing
    assert.equal((await repo.getTenantConfig(t))?.adminCount, 1, 'grace window protects new admin');
    const fresh = await repo.getUser('sub-fresh@o.test');
    assert.ok(fresh?.memberships.some((m) => m.tenantId === t));
  });

  test('a transient Cognito error prunes nothing and does not throw', async () => {
    const t = 'orphan-transient';
    await seedTenant(t);
    await repo.putUser(admin(t, 'maybe@o.test', OLD));
    await repo.recountAdmins(t);
    await reconcile.reconcileTenantAdmins(t, async () => {
      throw new Error('cognito unavailable');
    });
    assert.equal((await repo.getTenantConfig(t))?.adminCount, 1, 'skipped on ambiguous failure');
  });
});

/**
 * `seedLeaguesOnly` — the manual leagues-backfill repair (--leagues-only). Exercises the
 * tri-state policy that surfaced in review: never falsely reassure on a missing CONFIG,
 * never clobber a populated or intentionally-emptied catalogue without --force, and fix the
 * actual dev-stage bug (CONFIG present but the `leagues` attribute absent).
 */
describe('seedLeaguesOnly (manual leagues backfill repair)', () => {
  let seed: typeof import('../src/seed-core.js');
  let snapshotCount = 0;

  before(async () => {
    seed = await import('../src/seed-core.js');
    snapshotCount = (await repo.getTenantConfig('dolphins'))?.leagues?.length ?? 0;
    assert.ok(snapshotCount > 0, 'precondition: dolphins seeded with a non-empty catalogue');
  });

  // Leave dolphins with its full catalogue so later suites (if any) see a healthy tenant.
  after(async () => {
    await seed.seedLeaguesOnly('dolphins', true);
  });

  test('tenant with no CONFIG row → config-missing (loud, not a silent skip)', async () => {
    const r = await seed.seedLeaguesOnly('unseeded-co');
    assert.deepEqual(r, { status: 'config-missing' });
  });

  test('already-populated catalogue → idempotent no-op', async () => {
    const before = await repo.getTenantConfig('dolphins');
    const r = await seed.seedLeaguesOnly('dolphins');
    assert.equal(r.status, 'already-populated');
    assert.equal(r.status === 'already-populated' && r.count, before?.leagues?.length);
  });

  test('intentionally-empty [] is respected without --force (empty-skipped)', async () => {
    await repo.backfillLeagues('dolphins', [], true); // admin-emptied state
    const r = await seed.seedLeaguesOnly('dolphins');
    assert.equal(r.status, 'empty-skipped');
    assert.equal((await repo.getTenantConfig('dolphins'))?.leagues?.length, 0, 'left untouched');
  });

  test('--force overwrites an empty catalogue from the snapshot', async () => {
    const r = await seed.seedLeaguesOnly('dolphins', true); // still [] from previous test
    assert.equal(r.status, 'backfilled');
    assert.equal(r.status === 'backfilled' && r.count, snapshotCount);
    assert.equal((await repo.getTenantConfig('dolphins'))?.leagues?.length, snapshotCount);
  });

  test('absent leagues attribute → backfilled (the dev-stage bug)', async () => {
    const cfg = await repo.getTenantConfig('dolphins');
    delete (cfg as { leagues?: unknown }).leagues; // simulate a pre-catalogue CONFIG
    await repo.putTenantConfig(cfg!);
    const r = await seed.seedLeaguesOnly('dolphins'); // no --force needed for absent
    assert.equal(r.status, 'backfilled');
    assert.equal(r.status === 'backfilled' && r.count, snapshotCount);
    assert.equal((await repo.getTenantConfig('dolphins'))?.leagues?.length, snapshotCount);
  });

  test('backfillLeagues guard refuses to clobber a populated catalogue (returns false, no-op)', async () => {
    // dolphins is populated (restored by the previous test) — the race net must hold.
    const before = (await repo.getTenantConfig('dolphins'))?.leagues ?? [];
    assert.ok(before.length > 0, 'precondition: catalogue populated');
    const intruder = [{ key: 'x', label: 'X', group: 'g', district: 'd' }];
    const wrote = await repo.backfillLeagues('dolphins', intruder, false);
    assert.equal(wrote, false, 'guard fails on a non-empty catalogue');
    const after = (await repo.getTenantConfig('dolphins'))?.leagues ?? [];
    assert.equal(after.length, before.length, 'existing catalogue left untouched');
  });
});

describe('POST /clubs/:id/players (chair registration)', () => {
  const REP_PLY = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['plyclub'] }]);
  let teamKey: string;

  before(async () => {
    await repo.createClub('dolphins', {
      id: 'plyclub',
      name: 'Players CC',
      district: 'Test District',
      sub: 's',
      chair: 'Chair',
      affiliation: 'not_started',
      paid: true,
      cqi: 0,
      docs: {},
      players: 0,
      teams: 0,
      women: 0,
      juniors: 0,
      color: '#abcdef',
      ground: {},
      leagues: [],
      version: 1,
    });
    teamKey = ((await repo.getTenantConfig('dolphins'))?.leagues ?? [])[0]?.key ?? '';
    assert.ok(teamKey, 'precondition: tenant has a league catalogue');
  });

  const reg = (extra: Record<string, unknown>, auth = REP_PLY) =>
    app.request('/clubs/plyclub/players', {
      method: 'POST',
      headers: headers(auth),
      body: JSON.stringify({
        firstName: 'Sanele',
        lastName: 'Mthembu',
        idNumber: '0107224082088',
        race: 'African',
        gender: 'Male',
        cell: '0829014421',
        team: teamKey,
        district: 'Ethekwini',
        ...extra,
      }),
    });

  test('registers a player and derives DOB from the RSA ID', async () => {
    const res = await reg({});
    assert.equal(res.status, 201);
    const body = (await res.json()) as { dob: string; status: string; registeredVia: string };
    assert.equal(body.dob, '2001-07-22');
    assert.equal(body.status, 'active');
    assert.equal(body.registeredVia, 'portal');
  });

  test('duplicate (same naturalKey) is rejected (409)', async () => {
    const res = await reg({});
    assert.equal(res.status, 409);
  });

  test('invalid ID number is rejected (400)', async () => {
    const res = await reg({ idNumber: '123', cell: '0820000001' });
    assert.equal(res.status, 400);
  });

  test('missing required field is rejected (400)', async () => {
    const res = await app.request('/clubs/plyclub/players', {
      method: 'POST',
      headers: headers(REP_PLY),
      body: JSON.stringify({ firstName: 'No', lastName: 'Team' }),
    });
    assert.equal(res.status, 400);
  });

  test('unknown team/league is rejected (400)', async () => {
    const res = await reg({ team: 'not-a-real-league', cell: '0820000002' });
    assert.equal(res.status, 400);
  });

  test('a rep for another club cannot register here (403)', async () => {
    const other = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['testers'] }]);
    const res = await reg({ cell: '0820000003' }, other);
    assert.equal(res.status, 403);
  });
});

describe('Player clearances (inter-club transfer + move)', () => {
  const REP_SRC = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['clr-src'] }]);
  const REP_DST = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['clr-dst'] }]);

  const mkClub = (id: string, name: string) => ({
    id,
    name,
    district: 'Test District',
    sub: 's',
    chair: 'Chair',
    affiliation: 'not_started' as const,
    paid: true,
    cqi: 0,
    docs: {},
    players: 0,
    teams: 0,
    women: 0,
    juniors: 0,
    color: '#abcdef',
    ground: {},
    leagues: [],
    version: 1,
  });
  const mkPlayer = (clubId: string, nk: string) => ({
    naturalKey: nk,
    clubId,
    firstName: 'Move',
    lastName: 'Me',
    dob: '1995-01-01',
    isMinor: false,
    status: 'active' as const,
    consentAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
  });

  before(async () => {
    await repo.createClub('dolphins', mkClub('clr-src', 'Source CC'));
    await repo.createClub('dolphins', mkClub('clr-dst', 'Destination CC'));
    await repo.createPlayer('dolphins', mkPlayer('clr-src', 'mover'));
  });

  const create = (auth: string, body: unknown) =>
    app.request('/clubs/clr-dst/clearances', {
      method: 'POST',
      headers: headers(auth),
      body: JSON.stringify(body),
    });

  test('the destination club initiates; the source player goes clearance-pending', async () => {
    const res = await create(REP_DST, { fromClubId: 'clr-src', playerNaturalKey: 'mover' });
    assert.equal(res.status, 201);
    const player = await repo.getPlayer('dolphins', 'clr-src', 'mover');
    assert.equal(player?.status, 'clearance-pending');
  });

  test('cross-club guard: a rep who does not own the destination is forbidden (403)', async () => {
    const res = await create(REP_SRC, { fromClubId: 'clr-src', playerNaturalKey: 'mover' });
    assert.equal(res.status, 403);
  });

  test('a duplicate pending request for the same player is rejected (409)', async () => {
    const res = await create(REP_DST, { fromClubId: 'clr-src', playerNaturalKey: 'mover' });
    assert.equal(res.status, 409);
  });

  test('referencing a player who is not at the source club yields 404', async () => {
    const res = await create(REP_DST, { fromClubId: 'clr-src', playerNaturalKey: 'ghost' });
    assert.equal(res.status, 404);
  });

  test('source club lists the request as incoming; destination sees it as outbound', async () => {
    const srcRes = await app.request('/clubs/clr-src/clearances', { headers: headers(REP_SRC) });
    const src = (await srcRes.json()) as { incoming: unknown[]; outbound: unknown[] };
    assert.equal(src.incoming.length, 1);
    const dstRes = await app.request('/clubs/clr-dst/clearances', { headers: headers(REP_DST) });
    const dst = (await dstRes.json()) as { incoming: unknown[]; outbound: unknown[] };
    assert.equal(dst.outbound.length, 1);
  });

  test('source rep cannot read the destination club’s clearances (403)', async () => {
    const res = await app.request('/clubs/clr-dst/clearances', { headers: headers(REP_SRC) });
    assert.equal(res.status, 403);
  });

  test('issuing moves the player to the destination and resolves the request', async () => {
    const list = (await (
      await app.request('/clubs/clr-src/clearances', { headers: headers(REP_SRC) })
    ).json()) as { incoming: { id: string }[] };
    const cid = list.incoming[0].id;
    const res = await app.request(`/clubs/clr-src/clearances/${cid}`, {
      method: 'PATCH',
      headers: headers(REP_SRC),
      body: JSON.stringify({ feesCleared: true, misconductCleared: true, action: 'issue' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, 'approved');
    assert.equal(await repo.getPlayer('dolphins', 'clr-src', 'mover'), null);
    const moved = await repo.getPlayer('dolphins', 'clr-dst', 'mover');
    assert.equal(moved?.status, 'active');
    assert.equal(moved?.clubId, 'clr-dst');
  });

  test('issuing without both confirmations is rejected (400)', async () => {
    await repo.createPlayer('dolphins', mkPlayer('clr-src', 'mover2'));
    await create(REP_DST, { fromClubId: 'clr-src', playerNaturalKey: 'mover2' });
    const list = (await (
      await app.request('/clubs/clr-src/clearances', { headers: headers(REP_SRC) })
    ).json()) as { incoming: { id: string; playerNaturalKey: string; status: string }[] };
    const cid = list.incoming.find(
      (x) => x.playerNaturalKey === 'mover2' && x.status === 'pending',
    )!.id;
    const res = await app.request(`/clubs/clr-src/clearances/${cid}`, {
      method: 'PATCH',
      headers: headers(REP_SRC),
      body: JSON.stringify({ feesCleared: true, action: 'issue' }),
    });
    assert.equal(res.status, 400);
  });

  test('admin override refuses a request still inside the 14-day window (409)', async () => {
    const list = (await (
      await app.request('/clubs/clr-src/clearances', { headers: headers(REP_SRC) })
    ).json()) as { incoming: { id: string; playerNaturalKey: string; status: string }[] };
    const cid = list.incoming.find(
      (x) => x.playerNaturalKey === 'mover2' && x.status === 'pending',
    )!.id;
    const res = await app.request(`/admin/clearances/${cid}/override`, {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ fromClubId: 'clr-src' }),
    });
    assert.equal(res.status, 409);
  });

  test('admin override issues an overdue request directly', async () => {
    // Seed an overdue clearance straight through the repo (requestedAt 21 days ago).
    await repo.createPlayer('dolphins', mkPlayer('clr-src', 'mover3'));
    const old = new Date(Date.now() - 21 * 86_400_000).toISOString();
    await repo.createClearance('dolphins', {
      id: 'clr-overdue',
      playerNaturalKey: 'mover3',
      playerName: 'Move Me',
      fromClubId: 'clr-src',
      toClubId: 'clr-dst',
      fromClubName: 'Source CC',
      toClubName: 'Destination CC',
      requestedAt: old,
      feesCleared: false,
      misconductCleared: false,
      status: 'pending',
      clubApprovedAt: null,
      adminOverrideAt: null,
      version: 0,
    });
    const res = await app.request('/admin/clearances/clr-overdue/override', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ fromClubId: 'clr-src' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, 'admin-override');
    const moved = await repo.getPlayer('dolphins', 'clr-dst', 'mover3');
    assert.equal(moved?.clubId, 'clr-dst');
  });

  test('the move rejects when the player already exists at the destination (409)', async () => {
    await repo.createPlayer('dolphins', mkPlayer('clr-src', 'mover4'));
    await repo.createPlayer('dolphins', mkPlayer('clr-dst', 'mover4')); // collision at destination
    await create(REP_DST, { fromClubId: 'clr-src', playerNaturalKey: 'mover4' });
    const list = (await (
      await app.request('/clubs/clr-src/clearances', { headers: headers(REP_SRC) })
    ).json()) as { incoming: { id: string; playerNaturalKey: string; status: string }[] };
    const cid = list.incoming.find(
      (x) => x.playerNaturalKey === 'mover4' && x.status === 'pending',
    )!.id;
    const res = await app.request(`/clubs/clr-src/clearances/${cid}`, {
      method: 'PATCH',
      headers: headers(REP_SRC),
      body: JSON.stringify({ feesCleared: true, misconductCleared: true, action: 'issue' }),
    });
    assert.equal(res.status, 409);
    // The player must NOT have been removed from the source (no half-move).
    assert.ok(await repo.getPlayer('dolphins', 'clr-src', 'mover4'));
  });

  test('createClearance is race-safe: a second create for an already-pending player is rejected', async () => {
    // Drives repo.createClearance directly to bypass the handler's TOCTOU list-check and
    // exercise the atomic player-status guard (#s <> :pending) — the real invariant.
    await repo.createPlayer('dolphins', mkPlayer('clr-src', 'racer'));
    const base = {
      playerNaturalKey: 'racer',
      playerName: 'Move Me',
      fromClubId: 'clr-src',
      toClubId: 'clr-dst',
      fromClubName: 'Source CC',
      toClubName: 'Destination CC',
      requestedAt: new Date().toISOString(),
      feesCleared: false,
      misconductCleared: false,
      status: 'pending' as const,
      clubApprovedAt: null,
      adminOverrideAt: null,
      version: 0,
    };
    await repo.createClearance('dolphins', { ...base, id: 'race-1' });
    await assert.rejects(
      () => repo.createClearance('dolphins', { ...base, id: 'race-2' }),
      (err: Error) => err.name === 'DuplicatePendingClearanceError',
    );
    // Only the first clearance landed — no orphaned canonical/mirror from the rejected create.
    const src = await repo.listClearancesForSource('dolphins', 'clr-src');
    assert.equal(src.filter((x) => x.playerNaturalKey === 'racer').length, 1);
  });
});

describe('registrationAccess gate (lock Players/Clearances until paid)', () => {
  // Runs against a THROWAWAY tenant so flipping registrationAccess can't leak into other
  // suites (no shared-config mutation, no after()-restore, no positional coupling).
  const GATE = 'gatetenant';
  const gHeaders = (auth: string) => ({
    'x-tenant': GATE,
    'x-dev-auth': auth,
    'content-type': 'application/json',
  });
  const REP_SRC = devAuth([{ tenantId: GATE, role: 'rep', clubIds: ['gate-src'] }]);
  const REP_DST = devAuth([{ tenantId: GATE, role: 'rep', clubIds: ['gate-dst'] }]);
  const REP_DSTP = devAuth([{ tenantId: GATE, role: 'rep', clubIds: ['gate-dst-paid'] }]);
  let teamKey: string;

  const club = (id: string, paid: boolean) => ({
    id,
    name: id,
    district: 'Test District',
    sub: 's',
    chair: 'Chair',
    affiliation: 'not_started' as const,
    paid,
    cqi: 0,
    docs: {},
    players: 0,
    teams: 0,
    women: 0,
    juniors: 0,
    color: '#abcdef',
    ground: {},
    leagues: [],
    version: 1,
  });
  const player = (clubId: string, nk: string, id13: string) => ({
    naturalKey: nk,
    clubId,
    firstName: 'Gate',
    lastName: nk,
    dob: '1995-01-01',
    idNumber: id13,
    isMinor: false,
    status: 'active' as const,
    consentAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
  });

  before(async () => {
    // Stand up a separate tenant locked to 'paid', reusing dolphins' league catalogue.
    const dolCfg = (await repo.getTenantConfig('dolphins'))!;
    teamKey = (dolCfg.leagues ?? [])[0]?.key ?? '';
    assert.ok(teamKey, 'expected a seeded league catalogue to derive a team key from');
    await repo.putTenantConfig({ ...dolCfg, tenant: GATE, registrationAccess: 'paid' });
    await repo.createClub(GATE, club('gate-src', true));
    await repo.createClub(GATE, club('gate-dst', false)); // unpaid → locked destination
    await repo.createClub(GATE, club('gate-dst-paid', true));
    await repo.createPlayer(GATE, player('gate-src', 'gp1', '9001011111111'));
    await repo.createPlayer(GATE, player('gate-src', 'gp2', '9001012222222'));
  });

  const regBody = (idNumber: string) => ({
    firstName: 'New',
    lastName: 'Player',
    idNumber,
    race: 'African',
    gender: 'Male',
    cell: '0820000000',
    team: teamKey,
    district: 'Ethekwini',
  });

  test('authed register is blocked at an unpaid club (403)', async () => {
    const res = await app.request('/clubs/gate-dst/players', {
      method: 'POST',
      headers: gHeaders(REP_DST),
      body: JSON.stringify(regBody('9203035034089')),
    });
    assert.equal(res.status, 403);
  });

  test('authed register succeeds at a paid club (proves it is the gate, not a block)', async () => {
    const res = await app.request('/clubs/gate-src/players', {
      method: 'POST',
      headers: gHeaders(REP_SRC),
      body: JSON.stringify(regBody('9203035034089')),
    });
    assert.equal(res.status, 201);
  });

  test('public registration link is blocked at an unpaid club (403)', async () => {
    await repo.putToken('gate-tok', GATE, 'gate-dst', '2026-06-01T00:00:00.000Z');
    const res = await app.request('/register/gate-dst?t=gate-tok', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant': GATE },
      body: JSON.stringify({ firstName: 'Pub', lastName: 'Reg', dob: '1995-01-01' }),
    });
    assert.equal(res.status, 403);
  });

  test('clearance request into an unpaid destination is blocked (403)', async () => {
    const res = await app.request('/clubs/gate-dst/clearances', {
      method: 'POST',
      headers: gHeaders(REP_DST),
      body: JSON.stringify({ fromClubId: 'gate-src', playerNaturalKey: 'gp1' }),
    });
    assert.equal(res.status, 403);
  });

  test('clearance request into a paid destination succeeds (201)', async () => {
    const res = await app.request('/clubs/gate-dst-paid/clearances', {
      method: 'POST',
      headers: gHeaders(REP_DSTP),
      body: JSON.stringify({ fromClubId: 'gate-src', playerNaturalKey: 'gp1' }),
    });
    assert.equal(res.status, 201);
  });

  test('carve-out: an already-pending clearance can still be issued into an unpaid destination', async () => {
    // Seed a request straight to the repo (bypassing the create gate), simulating one made
    // before the destination was locked, then issue it from the source.
    await repo.createClearance(GATE, {
      id: 'gate-inflight',
      playerNaturalKey: 'gp2',
      playerName: 'Gate gp2',
      fromClubId: 'gate-src',
      toClubId: 'gate-dst', // unpaid/locked
      fromClubName: 'gate-src',
      toClubName: 'gate-dst',
      requestedAt: new Date().toISOString(),
      feesCleared: false,
      misconductCleared: false,
      status: 'pending',
      clubApprovedAt: null,
      adminOverrideAt: null,
      version: 0,
    });
    const res = await app.request('/clubs/gate-src/clearances/gate-inflight', {
      method: 'PATCH',
      headers: gHeaders(REP_SRC),
      body: JSON.stringify({ feesCleared: true, misconductCleared: true, action: 'issue' }),
    });
    assert.equal(res.status, 200);
    const moved = await repo.getPlayer(GATE, 'gate-dst', 'gp2');
    assert.equal(moved?.clubId, 'gate-dst'); // landed in the unpaid club — carve-out holds
  });
});
