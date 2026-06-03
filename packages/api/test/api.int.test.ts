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
