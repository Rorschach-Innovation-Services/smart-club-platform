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

describe('compliance doc view-url + replace', () => {
  const baseClub = {
    id: 'docclub',
    name: 'Doc Club CC',
    district: 'Test District',
    sub: 'sub-1',
    chair: 'Chair',
    affiliation: 'not_started' as const,
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

  test('upload-url signs Word content types and falls back to PDF for unknown ones', async () => {
    const docx = await app.request('/clubs/docclub/docs/agm/upload-url', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    });
    assert.equal(docx.status, 200);
    const docxBody = (await docx.json()) as { objectKey: string; contentType: string };
    assert.ok(docxBody.objectKey.endsWith('.docx'), 'objectKey carries the docx extension');
    assert.equal(
      docxBody.contentType,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'echoes the signed content type',
    );

    // Present-but-unknown must 400 (silently signing as PDF would orphan the
    // upload when the record PATCH later rejects it); MISSING falls back to PDF.
    const bogus = await app.request('/clubs/docclub/docs/agm/upload-url', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ contentType: 'application/zip' }),
    });
    assert.equal(bogus.status, 400);

    const noBody = await app.request('/clubs/docclub/docs/agm/upload-url', {
      method: 'POST',
      headers: headers(ADMIN),
    });
    assert.equal(noBody.status, 200);
    const noBodyRes = (await noBody.json()) as { objectKey: string; contentType: string };
    assert.ok(noBodyRes.objectKey.endsWith('.pdf'), 'missing type falls back to pdf');
    assert.equal(noBodyRes.contentType, 'application/pdf');
  });

  test('recorded objectKeys must live under the club own prefix', async () => {
    // Record integrity is the security gate for view-url and the safeguarding
    // DELETE — a foreign club's key must never get on record.
    const foreign = await app.request('/clubs/docclub/docs/agm', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ objectKey: 'dolphins/other-club/agm-x.pdf', size: 100 }),
    });
    assert.equal(foreign.status, 400);

    const viaGeneric = await app.request('/clubs/docclub', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        docMeta: { agm: { objectKey: 'dolphins/other-club/agm-x.pdf', size: 100 } },
      }),
    });
    assert.equal(viaGeneric.status, 400);
  });

  test('PATCH rejects a non-PDF/Word contentType but accepts a missing one', async () => {
    const bad = await app.request('/clubs/docclub/docs/agm', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        objectKey: 'dolphins/docclub/agm-x.zip',
        size: 100,
        contentType: 'application/zip',
      }),
    });
    assert.equal(bad.status, 400);
  });
});

describe('safeguarding multi-file certificates', () => {
  const baseClub = {
    id: 'sgclub',
    name: 'Safeguard CC',
    district: 'Test District',
    sub: 'sub-1',
    chair: 'Chair',
    affiliation: 'not_started' as const,
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
  const KEY_A = 'dolphins/sgclub/safeguarding-a.pdf';
  const KEY_B = 'dolphins/sgclub/safeguarding-b.docx';
  const upload = (objectKey: string, extra: Record<string, unknown> = {}) =>
    app.request('/clubs/sgclub/docs/safeguarding', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ objectKey, size: 500, ...extra }),
    });
  const getClub = async () =>
    (await repo.getClub('dolphins', 'sgclub')) as {
      docs: Record<string, boolean>;
      docMeta?: Record<string, { files?: { objectKey: string }[]; markedCompliant?: boolean }>;
    };

  before(async () => {
    await repo.createClub('dolphins', baseClub);
  });

  test('one certificate is below the minimum — doc stays incomplete', async () => {
    const res = await upload(KEY_A);
    assert.equal(res.status, 200);
    const club = await getClub();
    assert.equal(club.docs.safeguarding, false, 'one file does not satisfy the 2-person minimum');
    assert.equal(club.docMeta?.safeguarding?.files?.length, 1);
  });

  test('a second certificate appends (no replace) and completes the doc', async () => {
    const res = await upload(KEY_B, {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    assert.equal(res.status, 200);
    const club = await getClub();
    assert.equal(club.docs.safeguarding, true);
    assert.deepEqual(
      club.docMeta?.safeguarding?.files?.map((f) => f.objectKey),
      [KEY_A, KEY_B],
      'both certificates coexist',
    );
  });

  test('re-recording the same objectKey is idempotent', async () => {
    const res = await upload(KEY_B);
    assert.equal(res.status, 200);
    const club = await getClub();
    assert.equal(club.docMeta?.safeguarding?.files?.length, 2);
  });

  test('view-url presigns a specific stored file and 404s a foreign objectKey', async () => {
    const ok = await app.request('/clubs/sgclub/docs/safeguarding/view-url', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ objectKey: KEY_B }),
    });
    assert.equal(ok.status, 200);

    const foreign = await app.request('/clubs/sgclub/docs/safeguarding/view-url', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ objectKey: 'dolphins/other-club/secret.pdf' }),
    });
    assert.equal(foreign.status, 404, 'cannot presign a key not on record');

    const legacyNoBody = await app.request('/clubs/sgclub/docs/safeguarding/view-url', {
      method: 'POST',
      headers: headers(ADMIN),
    });
    assert.equal(legacyNoBody.status, 200, 'no objectKey defaults to the first file');
  });

  test('a stale-client generic PATCH (bare sentinel) cannot erase the files array', async () => {
    // Old admin tabs send docMeta.safeguarding = { markedCompliant: true } wholesale.
    const res = await app.request('/clubs/sgclub', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        docs: { safeguarding: true },
        docMeta: { safeguarding: { markedCompliant: true, at: '2026-06-11T00:00:00.000Z' } },
      }),
    });
    assert.equal(res.status, 200);
    const club = await getClub();
    assert.equal(club.docMeta?.safeguarding?.files?.length, 2, 'stored files survived');
    assert.equal(club.docMeta?.safeguarding?.markedCompliant, true, 'sentinel applied');
  });

  test('a stale-client revert (docs flag false) cannot un-comply a met minimum', async () => {
    const club = await getClub();
    const { safeguarding: _gone, ...metaWithout } = club.docMeta ?? {};
    const res = await app.request('/clubs/sgclub', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        docs: { ...club.docs, safeguarding: false },
        docMeta: metaWithout,
      }),
    });
    assert.equal(res.status, 200);
    const after = await getClub();
    assert.equal(after.docMeta?.safeguarding?.files?.length, 2, 'files restored on omission');
    assert.equal(after.docs.safeguarding, true, 'flag re-derived from the preserved minimum');
  });

  test('removing a certificate below the minimum un-completes the doc', async () => {
    const res = await app.request('/clubs/sgclub/docs/safeguarding/file', {
      method: 'DELETE',
      headers: headers(ADMIN),
      body: JSON.stringify({ objectKey: KEY_B }),
    });
    assert.equal(res.status, 200);
    const club = await getClub();
    assert.deepEqual(
      club.docMeta?.safeguarding?.files?.map((f) => f.objectKey),
      [KEY_A],
    );
    assert.equal(club.docs.safeguarding, false, 'one remaining file is below the minimum');
  });

  test('DELETE 404s an objectKey not on record and 400s non-safeguarding keys', async () => {
    const missing = await app.request('/clubs/sgclub/docs/safeguarding/file', {
      method: 'DELETE',
      headers: headers(ADMIN),
      body: JSON.stringify({ objectKey: 'dolphins/sgclub/never-uploaded.pdf' }),
    });
    assert.equal(missing.status, 404);

    const wrongKey = await app.request('/clubs/sgclub/docs/constitution/file', {
      method: 'DELETE',
      headers: headers(ADMIN),
      body: JSON.stringify({ objectKey: KEY_A }),
    });
    assert.equal(wrongKey.status, 400);
  });

  test('the 10-file cap holds on both the append route and the generic PATCH', async () => {
    // Seed a full record at the repo layer (bypassing the API caps).
    const tenFiles = Array.from({ length: 10 }, (_, i) => ({
      objectKey: `dolphins/sgclub/safeguarding-cap-${i}.pdf`,
      size: 10,
      uploadedAt: '2026-01-01',
    }));
    await repo.updateClub(
      'dolphins',
      'sgclub',
      { docMeta: { safeguarding: { files: tenFiles } }, docs: { safeguarding: true } },
      'test-seed',
      new Date().toISOString(),
    );

    const eleventh = await upload('dolphins/sgclub/safeguarding-cap-11.pdf');
    assert.equal(eleventh.status, 400, 'append route rejects an 11th certificate');

    const viaGeneric = await app.request('/clubs/sgclub', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        docMeta: {
          safeguarding: {
            files: [
              ...tenFiles,
              { objectKey: 'dolphins/sgclub/safeguarding-cap-11.pdf', size: 10 },
            ],
          },
        },
      }),
    });
    assert.equal(viaGeneric.status, 400, 'generic PATCH rejects an oversized files array');
  });

  test('a legacy single-object upload counts as one file and appends cleanly', async () => {
    // Seed the pre-multi-file shape directly at the repo layer.
    const legacy = { objectKey: 'dolphins/sgclub/legacy.pdf', size: 9, uploadedAt: '2026-01-01' };
    await repo.updateClub(
      'dolphins',
      'sgclub',
      { docMeta: { safeguarding: legacy }, docs: { safeguarding: true } },
      'test-seed',
      new Date().toISOString(),
    );

    const res = await upload('dolphins/sgclub/safeguarding-new.pdf');
    assert.equal(res.status, 200);
    const after = await getClub();
    assert.deepEqual(
      after.docMeta?.safeguarding?.files?.map((f) => f.objectKey),
      ['dolphins/sgclub/legacy.pdf', 'dolphins/sgclub/safeguarding-new.pdf'],
      'legacy file normalized into the array, new file appended',
    );
    assert.equal(after.docs.safeguarding, true, 'two files satisfy the minimum');
  });

  test('a booked safeguarding course is preserved through the generic PATCH merge', async () => {
    // Seed one stored file so the merge branch (stored.files.length > 0) engages.
    await repo.updateClub(
      'dolphins',
      'sgclub',
      {
        docMeta: {
          safeguarding: {
            files: [
              { objectKey: 'dolphins/sgclub/sg-keep.pdf', size: 10, uploadedAt: '2026-01-01' },
            ],
          },
        },
        docs: { safeguarding: false },
      },
      'test-seed',
      new Date().toISOString(),
    );
    const res = await app.request('/clubs/sgclub', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        docs: { safeguarding: true },
        docMeta: { safeguarding: { files: [], courseBooked: true, courseDate: '2026-09-01' } },
      }),
    });
    assert.equal(res.status, 200);
    const club = (await getClub()) as {
      docs: Record<string, boolean>;
      docMeta?: Record<string, { files?: unknown[]; courseBooked?: boolean; courseDate?: string }>;
    };
    assert.equal(club.docMeta?.safeguarding?.courseBooked, true, 'booking carried through merge');
    assert.equal(club.docMeta?.safeguarding?.courseDate, '2026-09-01');
    assert.equal(club.docMeta?.safeguarding?.files?.length, 1, 'stored file preserved by merge');
    assert.equal(club.docs.safeguarding, true, 'course booking keeps the doc satisfied');
  });

  test('a booked course with no files survives an unrelated generic PATCH', async () => {
    await repo.updateClub(
      'dolphins',
      'sgclub',
      { docMeta: {}, docs: { safeguarding: false } },
      'test-seed',
      new Date().toISOString(),
    );
    const book = await app.request('/clubs/sgclub', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        docs: { safeguarding: true },
        docMeta: { safeguarding: { files: [], courseBooked: true, courseDate: '2026-10-01' } },
      }),
    });
    assert.equal(book.status, 200);
    // A real client spreads existing docMeta when touching another doc — the booking must ride along.
    const mid = (await getClub()) as { docMeta?: Record<string, unknown> };
    const follow = await app.request('/clubs/sgclub', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        docMeta: {
          ...mid.docMeta,
          constitution: { markedCompliant: true, at: '2026-06-11T00:00:00.000Z' },
        },
      }),
    });
    assert.equal(follow.status, 200);
    const after = (await getClub()) as {
      docs: Record<string, boolean>;
      docMeta?: Record<string, { courseBooked?: boolean }>;
    };
    assert.equal(after.docMeta?.safeguarding?.courseBooked, true, 'booking survived');
    assert.equal(after.docs.safeguarding, true);
  });

  test('clearing the booking (omitting courseBooked) un-declares the course', async () => {
    await repo.updateClub(
      'dolphins',
      'sgclub',
      {
        docMeta: { safeguarding: { files: [], courseBooked: true, courseDate: '2026-11-01' } },
        docs: { safeguarding: true },
      },
      'test-seed',
      new Date().toISOString(),
    );
    const res = await app.request('/clubs/sgclub', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        docs: { safeguarding: false },
        docMeta: { safeguarding: { files: [] } },
      }),
    });
    assert.equal(res.status, 200);
    const club = (await getClub()) as {
      docs: Record<string, boolean>;
      docMeta?: Record<string, { courseBooked?: boolean }>;
    };
    assert.equal(club.docMeta?.safeguarding?.courseBooked ?? false, false, 'booking cleared');
    assert.equal(club.docs.safeguarding, false);
  });

  test('clearing a booking while stored files coexist drops the flag, keeps the files', async () => {
    // Exercise the merge branch (stored.files.length > 0) for the clear path.
    const files = [
      { objectKey: 'dolphins/sgclub/sg-x.pdf', size: 10, uploadedAt: '2026-01-01' },
      { objectKey: 'dolphins/sgclub/sg-y.pdf', size: 10, uploadedAt: '2026-01-01' },
    ];
    await repo.updateClub(
      'dolphins',
      'sgclub',
      {
        docMeta: { safeguarding: { files, courseBooked: true, courseDate: '2026-12-01' } },
        docs: { safeguarding: true },
      },
      'test-seed',
      new Date().toISOString(),
    );
    const res = await app.request('/clubs/sgclub', {
      method: 'PATCH',
      headers: headers(ADMIN),
      // Client keeps the files but omits courseBooked → clears the booking.
      body: JSON.stringify({ docs: { safeguarding: true }, docMeta: { safeguarding: { files } } }),
    });
    assert.equal(res.status, 200);
    const club = (await getClub()) as {
      docs: Record<string, boolean>;
      docMeta?: Record<string, { files?: unknown[]; courseBooked?: boolean }>;
    };
    assert.equal(club.docMeta?.safeguarding?.courseBooked ?? false, false, 'booking cleared');
    assert.equal(club.docMeta?.safeguarding?.files?.length, 2, 'files preserved by the merge');
    assert.equal(club.docs.safeguarding, true, 'two files still satisfy the minimum');
  });
});

describe('public registration ID-doc upload-url', () => {
  const regClub = {
    id: 'regclub',
    name: 'Reg CC',
    district: 'Test District',
    sub: 'sub-1',
    chair: 'Chair',
    affiliation: 'not_started' as const,
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
    await repo.createClub('dolphins', regClub);
    await repo.putToken('reg-upload-token', 'dolphins', 'regclub', '2026-06-01T00:00:00.000Z');
  });

  test('mints a presigned PUT under the club prefix for a valid token', async () => {
    const res = await app.request('/register/regclub/id-doc/upload-url?t=reg-upload-token', {
      method: 'POST',
      body: JSON.stringify({ contentType: 'image/jpeg' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      uploadUrl: string;
      objectKey: string;
      contentType: string;
    };
    assert.ok(body.uploadUrl.startsWith('http'), 'returns a presigned URL');
    assert.match(body.objectKey, /^dolphins\/regclub\/reg-.*-id\.jpg$/, 'own tenant/club prefix');
    assert.equal(body.contentType, 'image/jpeg');
  });

  test('rejects a missing token (400) and a foreign/invalid token (404)', async () => {
    const noTok = await app.request('/register/regclub/id-doc/upload-url', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(noTok.status, 400);
    const bad = await app.request('/register/regclub/id-doc/upload-url?t=not-a-real-token', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 404);
  });

  test('falls back to PDF for an unknown content type', async () => {
    const res = await app.request('/register/regclub/id-doc/upload-url?t=reg-upload-token', {
      method: 'POST',
      body: JSON.stringify({ contentType: 'application/zip' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { objectKey: string; contentType: string };
    assert.equal(body.contentType, 'application/pdf');
    assert.match(body.objectKey, /-id\.pdf$/);
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

  test('admin override issues a recent pending request (no time limit)', async () => {
    // Clearances no longer carry a 14-day window — the union may override any pending
    // request immediately. Seed a fresh (just-now) clearance and confirm it issues.
    await repo.createPlayer('dolphins', mkPlayer('clr-src', 'mover2b'));
    await repo.createClearance('dolphins', {
      id: 'clr-recent',
      playerNaturalKey: 'mover2b',
      playerName: 'Recent Mover',
      fromClubId: 'clr-src',
      toClubId: 'clr-dst',
      fromClubName: 'Source CC',
      toClubName: 'Destination CC',
      requestedAt: new Date().toISOString(),
      feesCleared: false,
      misconductCleared: false,
      status: 'pending',
      clubApprovedAt: null,
      adminOverrideAt: null,
      version: 0,
    });
    const res = await app.request('/admin/clearances/clr-recent/override', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ fromClubId: 'clr-src' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, 'admin-override');
    const moved = await repo.getPlayer('dolphins', 'clr-dst', 'mover2b');
    assert.equal(moved?.clubId, 'clr-dst');
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

describe('/admin/club-signup-link (lifecycle)', () => {
  // Dedicated tenant so minting/revoking links can't leak into the public-signup suite.
  const T = 'linktenant';
  const lHeaders = (auth: string) => ({
    'x-tenant': T,
    'x-dev-auth': auth,
    'content-type': 'application/json',
  });
  const LADMIN = devAuthAs('caller-link-admin', 'link-admin@link.test', [
    { tenantId: T, role: 'admin', clubIds: [] },
  ]);
  const LREP = devAuthAs('caller-link-rep', 'link-rep@link.test', [
    { tenantId: T, role: 'rep', clubIds: ['c1'] },
  ]);

  const adminGet = (auth = LADMIN) =>
    app.request('/admin/club-signup-link', { headers: lHeaders(auth) });
  const adminPost = (auth = LADMIN) =>
    app.request('/admin/club-signup-link', { method: 'POST', headers: lHeaders(auth) });
  const adminDelete = (auth = LADMIN) =>
    app.request('/admin/club-signup-link', { method: 'DELETE', headers: lHeaders(auth) });
  // Public endpoint: no auth headers at all (the token self-describes the tenant).
  const publicGet = (token: string) => app.request(`/club-signup?t=${token}`);

  type LinkBody = { clubSignupLink: { token: string; createdAt: string } | null };

  before(async () => {
    await repo.putTenantConfig({
      tenant: T,
      branding: { name: 'Link Test Union', title: 'Link Test', logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [],
    });
  });

  test('GET returns null before any link is minted', async () => {
    const res = await adminGet();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { clubSignupLink: null });
  });

  test('POST mints a link; GET returns it and the TOKEN# resolves on the public endpoint', async () => {
    const res = await adminPost();
    assert.equal(res.status, 200);
    const { clubSignupLink } = (await res.json()) as LinkBody;
    assert.ok(clubSignupLink?.token, 'a token was minted');
    assert.ok(clubSignupLink?.createdAt, 'createdAt is stamped');

    const got = (await (await adminGet()).json()) as LinkBody;
    assert.deepEqual(got.clubSignupLink, clubSignupLink, 'GET round-trips the stored pointer');

    const pub = await publicGet(clubSignupLink!.token);
    assert.equal(pub.status, 200, 'the public signup endpoint resolves the token');
  });

  test('rotation: a second POST issues a new token and the old one stops working', async () => {
    const oldToken = ((await (await adminGet()).json()) as LinkBody).clubSignupLink!.token;
    const res = await adminPost();
    assert.equal(res.status, 200);
    const next = ((await res.json()) as LinkBody).clubSignupLink!;
    assert.notEqual(next.token, oldToken, 'rotation mints a fresh token');

    assert.equal((await publicGet(next.token)).status, 200, 'new token works');
    assert.equal((await publicGet(oldToken)).status, 404, 'old token is revoked');
    assert.equal(await repo.getToken(oldToken), null, 'old TOKEN# item is gone');
  });

  test('PUT /tenant/config cannot clobber the server-owned pointer', async () => {
    const stored = ((await (await adminGet()).json()) as LinkBody).clubSignupLink!;
    const res = await app.request('/tenant/config', {
      method: 'PUT',
      headers: lHeaders(LADMIN),
      body: JSON.stringify({
        submissionDeadline: '2027-01-31',
        clubSignupLink: { token: 'forged-token', createdAt: '2026-01-01T00:00:00.000Z' },
      }),
    });
    assert.equal(res.status, 200);
    // The whole-config save landed, but the signup-link pointer was stripped from it.
    const after = ((await (await adminGet()).json()) as LinkBody).clubSignupLink;
    assert.deepEqual(after, stored, 'stored pointer survives a whole-config save');
    assert.equal((await publicGet('forged-token')).status, 404);
    const cfg = await repo.getTenantConfig(T);
    assert.equal(cfg?.submissionDeadline, '2027-01-31', 'the rest of the patch applied');
  });

  test('DELETE revokes the link (public 404, pointer cleared) and is idempotent', async () => {
    const token = ((await (await adminGet()).json()) as LinkBody).clubSignupLink!.token;
    const res = await adminDelete();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    assert.equal((await publicGet(token)).status, 404, 'revoked token no longer opens signup');
    assert.equal(await repo.getToken(token), null, 'TOKEN# item deleted');
    assert.deepEqual(await (await adminGet()).json(), { clubSignupLink: null });
    assert.equal((await repo.getTenantConfig(T))?.clubSignupLink, undefined, 'pointer cleared');

    const again = await adminDelete();
    assert.equal(again.status, 200, 'a second DELETE is a harmless no-op');
  });

  test('a TOKEN# item orphaned from the config pointer is inert (404)', async () => {
    // Simulate a partial rotation/revoke failure: the token item survives but the
    // pointer write was lost. The pointer match in resolveSignupTenant must make the
    // orphan inert rather than a live, invisible, irrevocable signup credential.
    const minted = ((await (await adminPost()).json()) as LinkBody).clubSignupLink!;
    assert.equal((await publicGet(minted.token)).status, 200, 'freshly minted token works');

    await repo.updateClubSignupLink(T, null);
    assert.ok(await repo.getToken(minted.token), 'TOKEN# item still exists');
    assert.equal((await publicGet(minted.token)).status, 404, 'pointer mismatch → inert');
  });

  test('a club rep is forbidden (403) on all three admin routes', async () => {
    assert.equal((await adminGet(LREP)).status, 403);
    assert.equal((await adminPost(LREP)).status, 403);
    assert.equal((await adminDelete(LREP)).status, 403);
  });

  test('anonymous requests are unauthenticated (401)', async () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await app.request('/admin/club-signup-link', {
        method,
        headers: { 'x-tenant': T, 'content-type': 'application/json' },
      });
      assert.equal(res.status, 401, `${method} without credentials`);
    }
  });
});

describe('public club self-registration (/club-signup)', () => {
  // Dedicated tenant; the link is minted through the real admin route in before().
  const T = 'signuptenant';
  const sHeaders = (auth: string) => ({
    'x-tenant': T,
    'x-dev-auth': auth,
    'content-type': 'application/json',
  });
  const SADMIN = devAuthAs('caller-signup-admin', 'signup-admin@su.test', [
    { tenantId: T, role: 'admin', clubIds: [] },
  ]);
  let token: string;

  // Deterministic offline sub for an email — mirrors cognito-users.localSub so the
  // membership ensurePasswordlessUser creates can be read back via repo.getUser.
  const subFor = async (email: string) => {
    const { createHash } = await import('node:crypto');
    return `local-${createHash('sha1').update(email.trim().toLowerCase()).digest('hex')}`;
  };

  /** Mint a signup link via the real admin route (any tenant). */
  const mintLink = async (tenant: string, adminAuth: string): Promise<string> => {
    const res = await app.request('/admin/club-signup-link', {
      method: 'POST',
      headers: { 'x-tenant': tenant, 'x-dev-auth': adminAuth, 'content-type': 'application/json' },
    });
    assert.equal(res.status, 200, 'precondition: link minted');
    const body = (await res.json()) as { clubSignupLink: { token: string } };
    return body.clubSignupLink.token;
  };

  const signupGet = (t?: string) => app.request(`/club-signup${t ? `?t=${t}` : ''}`);
  const signupPost = (body: unknown, t = token) =>
    app.request(`/club-signup?t=${t}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const validBody = (over: Record<string, unknown> = {}) => ({
    clubName: 'Sharks CC',
    district: 'KCCD',
    repName: 'Robin Rep',
    repEmail: 'robin@sharks.test',
    repCell: '083 555 0001',
    consent: true,
    ...over,
  });

  before(async () => {
    await repo.putTenantConfig({
      tenant: T,
      branding: { name: 'Signup Union', title: 'Signup', logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [],
    });
    token = await mintLink(T, SADMIN);
  });

  test('GET with a valid token returns the tenant, org name and district choices', async () => {
    const res = await signupGet(token);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tenant: string; orgName: string; districts: string[] };
    assert.equal(body.tenant, T);
    assert.equal(body.orgName, 'Signup Union');
    assert.ok(body.districts.includes('KCCD'), 'districts carry the catalogue values');
  });

  test('GET without a token is a 400', async () => {
    assert.equal((await signupGet()).status, 400);
  });

  test('POST without a token is a 400', async () => {
    const res = await app.request('/club-signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody()),
    });
    assert.equal(res.status, 400);
  });

  test('GET with an unknown token is a 404', async () => {
    assert.equal((await signupGet('not-a-real-token')).status, 404);
  });

  test('a player reg-link token cannot open signup (404)', async () => {
    // A reg-link token shares the TOKEN# keyspace but has clubId instead of kind.
    await repo.putToken('player-reg-tok', T, 'some-club', '2026-06-01T00:00:00.000Z');
    assert.equal((await signupGet('player-reg-tok')).status, 404);
    assert.equal((await signupPost(validBody(), 'player-reg-tok')).status, 404);
  });

  test('happy path: creates the club with provenance and the rep login (201)', async () => {
    const res = await signupPost(validBody());
    assert.equal(res.status, 201);
    const body = (await res.json()) as { clubId: string; clubName: string; email: string };
    assert.equal(body.clubId, 'sharks-cc');
    assert.equal(body.clubName, 'Sharks CC');
    assert.equal(body.email, 'robin@sharks.test');

    // Admin view: the club exists with chair contact + signup provenance.
    const clubRes = await app.request('/clubs/sharks-cc', { headers: sHeaders(SADMIN) });
    assert.equal(clubRes.status, 200);
    const club = (await clubRes.json()) as {
      chair: string;
      district: string;
      exco?: { chair?: { name: string; email: string; cell: string } };
      onboardedVia?: string;
      signupConsentAt?: string;
      changedBy?: string;
    };
    assert.equal(club.chair, 'Robin Rep');
    assert.equal(club.district, 'KCCD');
    assert.equal(club.exco?.chair?.name, 'Robin Rep');
    assert.equal(club.exco?.chair?.email, 'robin@sharks.test');
    assert.equal(club.exco?.chair?.cell, '0835550001', 'cell stored normalized (spaces stripped)');
    assert.equal(club.onboardedVia, 'self-signup');
    assert.ok(club.signupConsentAt, 'POPIA consent timestamp stamped');
    assert.equal(club.changedBy, 'robin@sharks.test');

    // The rep's USER# membership was created (deterministic LOCAL_AUTH sub).
    const user = await repo.getUser(await subFor('robin@sharks.test'));
    const m = user?.memberships.find((mm) => mm.tenantId === T);
    assert.equal(m?.role, 'rep');
    assert.deepEqual(m?.clubIds, ['sharks-cc']);
    assert.equal(m?.invitedBy, 'self-signup');
  });

  test('replay (same club + same chair email) is a 200 with no duplicate membership', async () => {
    const res = await signupPost(validBody());
    assert.equal(res.status, 200);
    const body = (await res.json()) as { clubId: string; replayed?: boolean };
    assert.equal(body.clubId, 'sharks-cc');
    assert.equal(body.replayed, true);

    const user = await repo.getUser(await subFor('robin@sharks.test'));
    const m = user?.memberships.find((mm) => mm.tenantId === T);
    assert.deepEqual(m?.clubIds, ['sharks-cc'], 'clubId appears exactly once after replay');
  });

  test('the same name from a different email is a 409 name_taken', async () => {
    const res = await signupPost(validBody({ repEmail: 'imposter@sharks.test' }));
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, 'name_taken');
    // The name check ran before ensurePasswordlessUser — no account minted.
    assert.equal(await repo.getUser(await subFor('imposter@sharks.test')), null);
  });

  test('a slug collision (different name, same id) is a 409 with no orphan club or user', async () => {
    const first = await signupPost(
      validBody({ clubName: 'Kingsmead-CC', repEmail: 'kc1@kings.test' }),
    );
    assert.equal(first.status, 201);
    assert.equal(((await first.json()) as { clubId: string }).clubId, 'kingsmead-cc');

    // "Kingsmead CC" differs as a name but slugs to the SAME id → name_taken, not a 500.
    const second = await signupPost(
      validBody({ clubName: 'Kingsmead CC', repEmail: 'kc2@kings.test' }),
    );
    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as { code?: string }).code, 'name_taken');

    assert.equal(await repo.getUser(await subFor('kc2@kings.test')), null, 'no orphan user');
    const club = await repo.getClub(T, 'kingsmead-cc');
    assert.equal(club?.name, 'Kingsmead-CC', 'the original club is untouched');
  });

  test('invalid input is rejected (400) before any club or account is created', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['name slugs to empty', validBody({ clubName: '!!!', repEmail: 'bad1@su.test' })],
      ['bad email', validBody({ repEmail: 'not-an-email' })],
      ['unknown district', validBody({ district: 'Atlantis District', repEmail: 'bad2@su.test' })],
      ['missing consent', { ...validBody({ repEmail: 'bad3@su.test' }), consent: undefined }],
      ['consent false', validBody({ consent: false, repEmail: 'bad4@su.test' })],
      ['over-length name', validBody({ clubName: 'X'.repeat(81), repEmail: 'bad5@su.test' })],
      ['over-length cell', validBody({ repCell: '0'.repeat(21), repEmail: 'bad6@su.test' })],
    ];
    for (const [label, body] of cases) {
      assert.equal((await signupPost(body)).status, 400, label);
    }
    // None of the rejects minted a login.
    for (const email of ['bad1@su.test', 'bad3@su.test', 'bad5@su.test']) {
      assert.equal(await repo.getUser(await subFor(email)), null, `${email} not minted`);
    }
  });

  test('cell normalization: +27/27/spaced/parenthesised variants all store 0835550001', async () => {
    // The happy path covers '083 555 0001'; these are the other accepted input shapes.
    const variants: Array<[string, string, string]> = [
      ['27835550001', 'Cell Variant One CC', 'cellv1@su.test'],
      ['+27 83-555-0001', 'Cell Variant Two CC', 'cellv2@su.test'],
      ['(083) 555 0001', 'Cell Variant Three CC', 'cellv3@su.test'],
    ];
    for (const [cell, clubName, email] of variants) {
      const res = await signupPost(validBody({ clubName, repEmail: email, repCell: cell }));
      assert.equal(res.status, 201, cell);
      const { clubId } = (await res.json()) as { clubId: string };
      const club = (await (
        await app.request(`/clubs/${clubId}`, { headers: sHeaders(SADMIN) })
      ).json()) as { exco?: { chair?: { cell?: string } } };
      assert.equal(club.exco?.chair?.cell, '0835550001', cell);
    }
  });

  test('an invalid cell is a 400 and mints no account', async () => {
    const cases: Array<[string, string, string, string]> = [
      ['12345', 'Bad Cell One CC', 'bad-cell-one-cc', 'badcell1@su.test'],
      // 09x sits outside even the deliberately permissive 06–08 superset.
      ['0935550001', 'Bad Cell Two CC', 'bad-cell-two-cc', 'badcell2@su.test'],
      ['08355500012', 'Bad Cell Three CC', 'bad-cell-three-cc', 'badcell3@su.test'], // 11 digits
    ];
    for (const [cell, clubName, slug, email] of cases) {
      const res = await signupPost(validBody({ clubName, repEmail: email, repCell: cell }));
      assert.equal(res.status, 400, cell);
      const body = (await res.json()) as { error?: string };
      assert.match(body.error ?? '', /South African cell/, cell);
      assert.equal(await repo.getUser(await subFor(email)), null, `${email} not minted`);
      assert.equal(await repo.getClub(T, slug), null, `${clubName} not created`);
    }
  });

  test('an absent cell is still accepted (the field is optional)', async () => {
    const res = await signupPost(
      validBody({ clubName: 'No Cell CC', repEmail: 'nocell@su.test', repCell: undefined }),
    );
    assert.equal(res.status, 201);
    const club = (await (
      await app.request('/clubs/no-cell-cc', { headers: sHeaders(SADMIN) })
    ).json()) as { exco?: { chair?: { cell?: string } } };
    assert.equal(club.exco?.chair?.cell, '', 'no cell stored, chair record still created');
  });

  test('an existing rep signing up a second club gains the clubId exactly once; other tenants intact', async () => {
    const email = 'multi@rep.test';
    const sub = await subFor(email);
    await repo.putUser({
      sub,
      email,
      memberships: [
        { tenantId: T, role: 'rep', clubIds: ['old-club'] },
        { tenantId: 'dolphins', role: 'rep', clubIds: ['testers'] },
      ],
      onboardingSeen: {},
    });

    const res = await signupPost(validBody({ clubName: 'Second CC', repEmail: email }));
    assert.equal(res.status, 201);

    const user = await repo.getUser(sub);
    const m = user?.memberships.find((mm) => mm.tenantId === T);
    assert.deepEqual(m?.clubIds, ['old-club', 'second-cc'], 'new clubId appended');
    assert.deepEqual(
      user?.memberships.find((mm) => mm.tenantId === 'dolphins'),
      { tenantId: 'dolphins', role: 'rep', clubIds: ['testers'] },
      'other-tenant membership untouched',
    );

    // A replay of the same signup must not append the clubId again.
    const replay = await signupPost(validBody({ clubName: 'Second CC', repEmail: email }));
    assert.equal(replay.status, 200);
    const after = await repo.getUser(sub);
    assert.deepEqual(
      after?.memberships.find((mm) => mm.tenantId === T)?.clubIds,
      ['old-club', 'second-cc'],
      'clubIds appended exactly once',
    );
  });

  test('an existing admin signing up a club keeps their admin membership untouched', async () => {
    const email = 'boss@union.test';
    const sub = await subFor(email);
    await repo.putUser({
      sub,
      email,
      memberships: [{ tenantId: T, role: 'admin', clubIds: [] }],
      onboardingSeen: {},
    });

    const res = await signupPost(validBody({ clubName: 'Boss CC', repEmail: email }));
    assert.equal(res.status, 201);
    assert.ok(await repo.getClub(T, 'boss-cc'), 'the club was created');

    const user = await repo.getUser(sub);
    assert.equal(user?.memberships.length, 1);
    const m = user?.memberships.find((mm) => mm.tenantId === T);
    assert.equal(m?.role, 'admin', 'admin role survives a self-signup');
    assert.deepEqual(m?.clubIds, [], 'admins keep whole-union scope (no clubId pinned)');
  });

  test('rate cap: the signup after the hourly limit is refused (429)', async () => {
    // Isolated tenant so burning the budget can't starve the other tests. The route's
    // limit is SIGNUPS_PER_HOUR = 30 (index.ts); consume 29 slots via the repo counter
    // (same atomic path the route takes), then prove #30 passes and #31 is capped.
    const RT = 'ratecaptenant';
    await repo.putTenantConfig({
      tenant: RT,
      branding: { name: 'Rate Cap Union', title: 'RC', logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [],
    });
    const RTADMIN = devAuthAs('caller-rc-admin', 'rc-admin@rc.test', [
      { tenantId: RT, role: 'admin', clubIds: [] },
    ]);
    const rcToken = await mintLink(RT, RTADMIN);

    const nowIso = new Date().toISOString();
    for (let i = 0; i < 29; i++) {
      assert.equal(await repo.bumpSignupTokenCounter(rcToken, nowIso, 30), true, `slot ${i + 1}`);
    }
    const within = await signupPost(
      validBody({ clubName: 'Last Within Cap CC', repEmail: 'cap30@rc.test' }),
      rcToken,
    );
    assert.equal(within.status, 201, 'signup #30 is still within the cap');

    const over = await signupPost(
      validBody({ clubName: 'Over Cap CC', repEmail: 'cap31@rc.test' }),
      rcToken,
    );
    assert.equal(over.status, 429, 'signup #31 hits the hourly cap');
    assert.equal(await repo.getUser(await subFor('cap31@rc.test')), null, 'no account minted');
    assert.equal(await repo.getClub(RT, 'over-cap-cc'), null, 'no club created');

    // Window expiry: the counter takes nowIso, so age the window out and the same
    // token admits signups again without any admin action.
    const twoHoursLater = new Date(Date.parse(nowIso) + 2 * 60 * 60 * 1000).toISOString();
    assert.equal(
      await repo.bumpSignupTokenCounter(rcToken, twoHoursLater, 30),
      true,
      'an aged-out window resets and admits the next signup',
    );
  });

  test('an erased tenant kills its signup link: GET/POST 404 and the token is revoked', async () => {
    const ET = 'erasesignup';
    await repo.putTenantConfig({
      tenant: ET,
      branding: { name: 'Erase Union', title: 'EU', logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [],
    });
    const ETADMIN = devAuthAs('caller-erase-admin', 'erase-admin@eu.test', [
      { tenantId: ET, role: 'admin', clubIds: [] },
    ]);
    const etToken = await mintLink(ET, ETADMIN);
    assert.equal((await signupGet(etToken)).status, 200, 'link works before erasure');

    await repo.eraseTenantData(ET);

    assert.equal((await signupGet(etToken)).status, 404);
    assert.equal((await signupPost(validBody({ repEmail: 'late@eu.test' }), etToken)).status, 404);
    assert.equal(await repo.getToken(etToken), null, 'erase revoked the TOKEN# item');
  });
});

describe('DELETE /clubs/:id (admin club deletion)', () => {
  // Dedicated tenant so the cascade can't disturb other suites' fixtures.
  const T = 'deltenant';
  const dHeaders = (auth: string) => ({
    'x-tenant': T,
    'x-dev-auth': auth,
    'content-type': 'application/json',
  });
  const DADMIN = devAuthAs('caller-del-admin', 'del-admin@del.test', [
    { tenantId: T, role: 'admin', clubIds: [] },
  ]);
  const DREP = devAuthAs('caller-del-rep', 'del-rep@del.test', [
    { tenantId: T, role: 'rep', clubIds: ['survivor'] },
  ]);

  const mkClub = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    district: 'Test District',
    sub: 's',
    chair: 'Chair',
    affiliation: 'not_started' as const,
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
    ...extra,
  });
  const mkPlayer = (clubId: string, nk: string, extra: Record<string, unknown> = {}) => ({
    naturalKey: nk,
    clubId,
    firstName: 'Del',
    lastName: 'Player',
    dob: '1995-01-01',
    isMinor: false,
    status: 'active' as const,
    consentAt: '2026-06-01T00:00:00.000Z',
    createdAt: '2026-06-01T00:00:00.000Z',
    ...extra,
  });
  const mkClearance = (id: string, nk: string, fromClubId: string, toClubId: string) => ({
    id,
    playerNaturalKey: nk,
    playerName: 'Del Player',
    fromClubId,
    toClubId,
    fromClubName: 'From CC',
    toClubName: 'To CC',
    requestedAt: new Date().toISOString(),
    feesCleared: false,
    misconductCleared: false,
    status: 'pending' as const,
    clubApprovedAt: null,
    adminOverrideAt: null,
    version: 0,
  });

  // Users the delete must sweep (seeded straight through the repo; the auth headers
  // above never create USER# rows, so the roster is exactly these three).
  const soloSub = 'del-solo-rep';
  const multiSub = 'del-multi-rep';
  const staffAdminSub = 'del-staff-admin';

  const del = (id: string, auth = DADMIN) =>
    app.request(`/clubs/${id}`, { method: 'DELETE', headers: dHeaders(auth) });

  before(async () => {
    await repo.putTenantConfig({
      tenant: T,
      branding: { name: 'Delete Union', title: 'Del', logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [],
    });
    // The doomed club carries every kind of sub-item the cascade must reach: a live
    // reg-link token, doc objectKeys (incl. the multi-file safeguarding shape),
    // players (one with an ID doc), clearances in BOTH directions, an invite marker.
    await repo.createClub(
      T,
      mkClub('doomed', 'Doomed CC', {
        playerRegLink: { token: 'del-reg-token', createdAt: '2026-06-01T00:00:00.000Z' },
        docMeta: {
          constitution: {
            objectKey: 'local/doomed-constitution.pdf',
            size: 1,
            uploadedAt: '2026-06-01T00:00:00.000Z',
          },
          safeguarding: {
            files: [
              {
                objectKey: 'local/doomed-sg-1.pdf',
                size: 1,
                uploadedAt: '2026-06-01T00:00:00.000Z',
              },
            ],
          },
        },
      }),
    );
    await repo.putToken('del-reg-token', T, 'doomed', '2026-06-01T00:00:00.000Z');
    await repo.createClub(T, mkClub('survivor', 'Survivor CC'));

    await repo.createPlayer(
      T,
      mkPlayer('doomed', 'p1', {
        idDocMeta: {
          objectKey: 'local/p1-id.pdf',
          size: 1,
          uploadedAt: '2026-06-01T00:00:00.000Z',
        },
      }),
    );
    await repo.createPlayer(T, mkPlayer('doomed', 'p2'));
    await repo.createPlayer(T, mkPlayer('survivor', 'stuck'));
    // Outgoing: doomed is the SOURCE (mirror lives under survivor).
    await repo.createClearance(T, mkClearance('clr-out', 'p1', 'doomed', 'survivor'));
    // Inbound: doomed is the DESTINATION — leaves survivor's player 'stuck' pending.
    await repo.createClearance(T, mkClearance('clr-in', 'stuck', 'survivor', 'doomed'));
    assert.equal(await repo.claimInviteSend(T, 'doomed', 'kDel', ['email']), null);

    await repo.putUser({
      sub: soloSub,
      email: 'solo@del.test',
      memberships: [{ tenantId: T, role: 'rep', clubIds: ['doomed'] }],
      onboardingSeen: {},
    });
    await repo.putUser({
      sub: multiSub,
      email: 'multi@del.test',
      memberships: [
        { tenantId: T, role: 'rep', clubIds: ['doomed', 'survivor'] },
        { tenantId: 'dolphins', role: 'rep', clubIds: ['testers'] },
      ],
      onboardingSeen: {},
    });
    await repo.putUser({
      sub: staffAdminSub,
      email: 'staff-admin@del.test',
      memberships: [{ tenantId: T, role: 'admin', clubIds: [] }],
      onboardingSeen: {},
    });
  });

  test('a rep is forbidden (403) and anonymous is unauthenticated (401)', async () => {
    assert.equal((await del('doomed', DREP)).status, 403);
    const anon = await app.request('/clubs/doomed', {
      method: 'DELETE',
      headers: { 'x-tenant': T, 'content-type': 'application/json' },
    });
    assert.equal(anon.status, 401);
    assert.ok(await repo.getClub(T, 'doomed'), 'the club survived the refused attempts');
  });

  test('an unknown club is a 404', async () => {
    assert.equal((await del('never-existed')).status, 404);
  });

  test('deleting cascades players, clearances (both partitions), markers and the token', async () => {
    const res = await del('doomed');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      removed: { players: 2, clearances: 2, users: 2 },
    });

    // Club + players gone; the route 404s like it never existed.
    assert.equal(await repo.getClub(T, 'doomed'), null);
    assert.deepEqual(await repo.listPlayers(T, 'doomed'), []);
    assert.equal((await app.request('/clubs/doomed', { headers: dHeaders(DADMIN) })).status, 404);

    // Both clearance directions cleaned INCLUDING the counterpart partitions: the
    // outgoing mirror under survivor and the inbound canonical under survivor.
    assert.deepEqual(await repo.listClearancesForSource(T, 'doomed'), []);
    assert.deepEqual(await repo.listInboundForDest(T, 'doomed'), []);
    assert.deepEqual(await repo.listInboundForDest(T, 'survivor'), []);
    assert.deepEqual(await repo.listClearancesForSource(T, 'survivor'), []);

    // The pending inbound clearance held survivor's player hostage — reset to active.
    assert.equal((await repo.getPlayer(T, 'survivor', 'stuck'))?.status, 'active');

    // Reg-link token revoked: the public registration link is dead.
    assert.equal(await repo.getToken('del-reg-token'), null);
    assert.equal((await app.request('/register/doomed?t=del-reg-token')).status, 404);

    // Invite marker gone — the same key claims fresh instead of replaying.
    assert.equal(await repo.claimInviteSend(T, 'doomed', 'kDel', ['email']), null);
  });

  test('membership sweep: solo rep offboarded, multi-club rep rescoped, admin untouched', async () => {
    // Single-club rep: fully offboarded — USER# META and all TENANT# markers gone.
    assert.equal(await repo.getUser(soloSub), null);
    const roster = await repo.listTenantUsers(T);
    assert.ok(!roster.some((u) => u.sub === soloSub), 'solo rep marker gone');

    // Multi-club rep: rescoped to the surviving club; the other tenant is intact.
    const multi = await repo.getUser(multiSub);
    assert.deepEqual(multi?.memberships.find((m) => m.tenantId === T)?.clubIds, ['survivor']);
    assert.deepEqual(
      multi?.memberships.find((m) => m.tenantId === 'dolphins'),
      { tenantId: 'dolphins', role: 'rep', clubIds: ['testers'] },
      'other-tenant membership untouched',
    );

    // Admins are never swept (clubIds: [] can't reference a club).
    const staff = await repo.getUser(staffAdminSub);
    assert.deepEqual(staff?.memberships, [{ tenantId: T, role: 'admin', clubIds: [] }]);
  });

  test('a second delete is a 404 (the cascade is idempotent, the route is honest)', async () => {
    assert.equal((await del('doomed')).status, 404);
  });

  test('race hardening: createPlayer against the deleted club cannot resurrect it', async () => {
    // The route's getClub check bounds this window; the repo-level call simulates an
    // in-flight registration landing after the delete. The PLAYER# row is accepted
    // residue — the conditioned playerCount bump must NOT recreate a club item.
    await repo.createPlayer(T, mkPlayer('doomed', 'ghost'));
    assert.equal(await repo.getClub(T, 'doomed'), null, 'no phantom club item from the bump');
  });

  test('race hardening: createClearance into the deleted club fails cleanly', async () => {
    await repo.createPlayer(T, mkPlayer('survivor', 'wants-out'));
    await assert.rejects(
      () => repo.createClearance(T, mkClearance('clr-late', 'wants-out', 'survivor', 'doomed')),
      (err: Error) => err.name === 'DestinationClubGoneError',
    );
    // The rejected create mutated nothing: no stranded pending player, no orphan items.
    assert.equal((await repo.getPlayer(T, 'survivor', 'wants-out'))?.status, 'active');
    assert.deepEqual(await repo.listClearancesForSource(T, 'survivor'), []);
    assert.deepEqual(await repo.listInboundForDest(T, 'doomed'), []);
  });

  // Cross-feature seam: a club created through the REAL public signup endpoint (with
  // its self-provisioned rep) must delete + offboard exactly like a seeded one — the
  // two features were built in separate commits and this is the only test that chains
  // POST /club-signup → DELETE /clubs/:id end to end.
  test('a self-signed-up club deletes and offboards its self-provisioned rep', async () => {
    const linkRes = await app.request('/admin/club-signup-link', {
      method: 'POST',
      headers: dHeaders(DADMIN),
    });
    const { clubSignupLink } = (await linkRes.json()) as {
      clubSignupLink: { token: string };
    };
    const signup = await app.request(`/club-signup?t=${clubSignupLink.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clubName: 'Self Made CC',
        district: 'KCCD', // signup validates against VALID_DISTRICTS (seeded clubs don't)
        repName: 'Self Rep',
        repEmail: 'self-rep@seam.test',
        consent: true,
      }),
    });
    assert.equal(signup.status, 201);
    const { clubId } = (await signup.json()) as { clubId: string };

    // The signup created a CONFIRMED user with a deterministic offline sub.
    const { createHash } = await import('node:crypto');
    const repSub = `local-${createHash('sha1').update('self-rep@seam.test').digest('hex')}`;
    assert.deepEqual(
      (await repo.getUser(repSub))?.memberships.find((m) => m.tenantId === T)?.clubIds,
      [clubId],
      'self-signup scoped the rep to the new club',
    );

    const del2 = await del(clubId);
    assert.equal(del2.status, 200);
    assert.deepEqual(await del2.json(), {
      ok: true,
      removed: { players: 0, clearances: 0, users: 1 },
    });

    // Sole club gone → the self-provisioned rep is fully offboarded, marker and all.
    assert.equal(await repo.getUser(repSub), null, 'self-signup rep fully offboarded');
    assert.ok(!(await repo.listTenantUsers(T)).some((u) => u.sub === repSub), 'rep marker swept');
    assert.equal(await repo.getClub(T, clubId), null);
  });
});

describe('queryAll (LastEvaluatedKey pagination)', () => {
  // A real >1MB page can't practically be seeded in dynalite, so a small `Limit`
  // (passed straight through queryAll's input) forces multiple pages instead — the
  // ExclusiveStartKey loop is the thing under test.
  test('drains every page when a small Limit forces multiple pages', async () => {
    const T = 'pagetenant';
    await repo.createClub(T, {
      id: 'pc',
      name: 'Pages CC',
      district: 'Test District',
      sub: 's',
      chair: 'Chair',
      affiliation: 'not_started' as const,
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
    for (let i = 0; i < 5; i++) {
      await repo.createPlayer(T, {
        naturalKey: `pager-${i}`,
        clubId: 'pc',
        firstName: 'Page',
        lastName: `Turner${i}`,
        dob: '1990-01-01',
        isMinor: false,
        consentAt: '2026-06-01T00:00:00.000Z',
        createdAt: '2026-06-01T00:00:00.000Z',
      });
    }
    const { playersListKey } = await import('../src/keys.js');
    const { pk, skPrefix } = playersListKey(T, 'pc');
    const items = await repo.queryAll({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': pk, ':s': skPrefix },
      Limit: 2, // 5 items at 2 per page = 3 pages
    });
    assert.equal(items.length, 5, 'all pages drained, not just the first');
  });
});

describe('clubDocObjectKeys (S3 purge key collection)', () => {
  // The dynalite harness has no S3, so the cascade tests can't observe which keys
  // would be purged — assert the collection directly. Safeguarding's multi-file
  // `files[]` shape is the one this function historically missed.
  const clubWith = (docMeta: Record<string, unknown>) =>
    ({ id: 'x', docMeta }) as unknown as Parameters<typeof repo.clubDocObjectKeys>[0];

  test('collects single-file objectKeys', () => {
    assert.deepEqual(
      repo.clubDocObjectKeys(clubWith({ constitution: { objectKey: 't/x/const.pdf', size: 1 } })),
      ['t/x/const.pdf'],
    );
  });

  test('collects safeguarding files[] entries', () => {
    assert.deepEqual(
      repo.clubDocObjectKeys(
        clubWith({
          safeguarding: { files: [{ objectKey: 't/x/sg1.pdf' }, { objectKey: 't/x/sg2.pdf' }] },
        }),
      ),
      ['t/x/sg1.pdf', 't/x/sg2.pdf'],
    );
  });

  test('collects mixed shapes and skips malformed entries', () => {
    assert.deepEqual(
      repo.clubDocObjectKeys(
        clubWith({
          constitution: { objectKey: 't/x/const.pdf' },
          safeguarding: { files: [{ objectKey: 't/x/sg1.pdf' }, {}], markedCompliant: true },
          agm: {}, // admin marked-compliant sentinel — no file
        }),
      ),
      ['t/x/const.pdf', 't/x/sg1.pdf'],
    );
  });

  test('empty/absent docMeta yields no keys', () => {
    assert.deepEqual(repo.clubDocObjectKeys(clubWith({})), []);
    assert.deepEqual(
      repo.clubDocObjectKeys({ id: 'x' } as unknown as Parameters<
        typeof repo.clubDocObjectKeys
      >[0]),
      [],
    );
  });
});
