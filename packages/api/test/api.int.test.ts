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
// Pure module (no env reads at load) — safe to import before the env block below.
import { DEFAULT_DISTRICTS } from '../src/catalogue.js';

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

describe('PATCH /clubs/:id — rename + flag', () => {
  type Renamable = {
    name?: string;
    nameChangePending?: boolean;
    previousName?: string;
    notes?: { text: string; author: string }[];
  };

  const mkClub = (id: string, name: string) => ({
    id,
    name,
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
  });

  test('a rep rename applies live, is flagged, and appends an audit note', async () => {
    // A rep bound to its OWN dedicated club ('repren') — isolated from the shared 'testers'.
    const REP_OWN = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['repren'] }]);
    await repo.createClub('dolphins', mkClub('repren', 'Rep Ren CC'));
    const res = await app.request('/clubs/repren', {
      method: 'PATCH',
      headers: headers(REP_OWN),
      body: JSON.stringify({ name: 'Rep Renamed CC', version: 1 }),
    });
    assert.equal(res.status, 200);
    const club = (await res.json()) as Renamable;
    assert.equal(club.name, 'Rep Renamed CC');
    assert.equal(club.nameChangePending, true);
    assert.equal(club.previousName, 'Rep Ren CC');
    assert.ok(
      club.notes?.some((n) => n.text.includes('Rep Ren CC') && n.text.includes('Rep Renamed CC')),
      'expected an audit note recording the rename',
    );
  });

  test('a rep cannot forge or self-dismiss the flag — server forces the real values', async () => {
    const REP_OWN = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['forgeren'] }]);
    await repo.createClub('dolphins', mkClub('forgeren', 'Forge Ren CC'));
    // The rep tries to rename AND sneak nameChangePending:false / a fake previousName.
    const res = await app.request('/clubs/forgeren', {
      method: 'PATCH',
      headers: headers(REP_OWN),
      body: JSON.stringify({
        name: 'Forge Renamed CC',
        nameChangePending: false,
        previousName: 'a fake history',
        version: 1,
      }),
    });
    assert.equal(res.status, 200);
    const club = (await res.json()) as Renamable;
    // Server overrides the forged values: flag is forced true, previousName is the real one.
    assert.equal(club.nameChangePending, true);
    assert.equal(club.previousName, 'Forge Ren CC');
  });

  test('an admin rename applies without a flag but still records an audit note', async () => {
    await repo.createClub('dolphins', mkClub('adminren', 'Admin Ren CC'));
    const res = await app.request('/clubs/adminren', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ name: 'Admin Renamed CC', version: 1 }),
    });
    assert.equal(res.status, 200);
    const club = (await res.json()) as Renamable;
    assert.equal(club.name, 'Admin Renamed CC');
    assert.ok(!club.nameChangePending, 'admin rename must not raise the review flag');
    assert.ok(
      club.notes?.some((n) => n.text.includes('Admin Renamed CC')),
      'expected an audit note even for an admin rename',
    );
  });

  test('an admin can acknowledge a pending rename (clears the flag)', async () => {
    await repo.createClub(
      'dolphins',
      Object.assign(mkClub('ackren', 'Ack Ren CC'), {
        nameChangePending: true,
        previousName: 'Old Ack CC',
      }),
    );
    const res = await app.request('/clubs/ackren', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ nameChangePending: false, previousName: '', version: 1 }),
    });
    assert.equal(res.status, 200);
    const club = (await res.json()) as Renamable;
    assert.equal(club.nameChangePending, false);
  });

  test('renaming to an existing club name is rejected (400)', async () => {
    await repo.createClub('dolphins', mkClub('alphacc', 'Alpha CC'));
    await repo.createClub('dolphins', mkClub('betacc', 'Beta CC'));
    const res = await app.request('/clubs/betacc', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ name: 'Alpha CC', version: 1 }),
    });
    assert.equal(res.status, 400);
  });

  test('a rename that collides on slug (not name) is rejected (400)', async () => {
    // "Gamma CC" and "Gamma-CC" differ as names but both slug to 'gamma-cc' — the id
    // collision the check exists to catch (mirrors the signup guard at index.ts ~546).
    await repo.createClub('dolphins', mkClub('gamma-cc', 'Gamma CC'));
    await repo.createClub('dolphins', mkClub('deltacc', 'Delta CC'));
    const res = await app.request('/clubs/deltacc', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ name: 'Gamma-CC', version: 1 }),
    });
    assert.equal(res.status, 400);
  });

  test('a name with no alphanumerics (slugs to empty) is rejected (400)', async () => {
    await repo.createClub('dolphins', mkClub('punctren', 'Punct Ren CC'));
    const res = await app.request('/clubs/punctren', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ name: '!!!', version: 1 }),
    });
    assert.equal(res.status, 400);
  });

  test('a no-op rename (same name) does not flag or append a note', async () => {
    await repo.createClub('dolphins', mkClub('noopren', 'No-op Ren CC'));
    const res = await app.request('/clubs/noopren', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ name: 'No-op Ren CC', version: 1 }),
    });
    assert.equal(res.status, 200);
    const club = (await res.json()) as Renamable & { version?: number };
    assert.ok(!club.nameChangePending, 'a no-op rename must not raise the flag');
    assert.ok(
      !club.notes?.some((n) => n.text.includes('Renamed')),
      'a no-op rename must not append an audit note',
    );
  });

  test('an empty/whitespace name is rejected (400)', async () => {
    await repo.createClub('dolphins', mkClub('blankren', 'Blank Ren CC'));
    const res = await app.request('/clubs/blankren', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ name: '   ', version: 1 }),
    });
    assert.equal(res.status, 400);
  });
});

describe('PATCH /clubs/:id — CQI involvementReasons (chairperson motivation)', () => {
  const mkClub = (id: string) => ({
    id,
    name: `${id} CC`,
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
  });

  test('accepts a multi-select of known reasons and round-trips them', async () => {
    await repo.createClub('dolphins', mkClub('involveok'));
    const reasons = [
      'Passion and love for the game of cricket',
      'Volunteering and serving the community',
    ];
    const res = await app.request('/clubs/involveok', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ cqiAnswers: { involvementReasons: reasons }, version: 1 }),
    });
    assert.equal(res.status, 200);
    const club = (await res.json()) as {
      cqi: number;
      cqiAnswers?: { involvementReasons?: string[] };
    };
    assert.deepEqual(club.cqiAnswers?.involvementReasons, reasons);
    // A draft save persists cqiAnswers WITHOUT scoring the club — it stays "not submitted".
    assert.equal(club.cqi, 0);
  });

  test('rejects an unknown reason (400)', async () => {
    await repo.createClub('dolphins', mkClub('involvebad'));
    const res = await app.request('/clubs/involvebad', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        cqiAnswers: { involvementReasons: ['Just here for the snacks'] },
        version: 1,
      }),
    });
    assert.equal(res.status, 400);
  });

  test('accepts an empty array (field is optional)', async () => {
    await repo.createClub('dolphins', mkClub('involveempty'));
    const res = await app.request('/clubs/involveempty', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ cqiAnswers: { involvementReasons: [] }, version: 1 }),
    });
    assert.equal(res.status, 200);
  });

  test('accepts a cqiAnswers patch that omits involvementReasons (governance-only)', async () => {
    await repo.createClub('dolphins', mkClub('involveabsent'));
    const res = await app.request('/clubs/involveabsent', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ cqiAnswers: { constitution: true }, version: 1 }),
    });
    assert.equal(res.status, 200);
  });

  test('accepts an explicit null cqiAnswers without crashing the guard', async () => {
    await repo.createClub('dolphins', mkClub('involvenull'));
    const res = await app.request('/clubs/involvenull', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ cqiAnswers: null, version: 1 }),
    });
    assert.equal(res.status, 200);
  });
});

describe('PATCH /clubs/:id — chair onboarding on affiliation complete', () => {
  // FROM_EMAIL / WHATSAPP_* unset ⇒ notify/ runs dry-run (synthetic ids, no real sends).
  // STAGE='local' ⇒ the localhost link fallback is allowed (deliverableBaseUrl).
  type WithLink = {
    playerRegLink?: { token: string; createdAt: string };
  };

  const mkClub = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    district: 'Test District',
    sub: '',
    chair: 'Carlton',
    affiliation: 'in_progress' as const,
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

  test('first completion mints a reg-link and sends both channels (dry-run)', async () => {
    await repo.createClub(
      'dolphins',
      mkClub('onboardme', {
        exco: { chair: { name: 'Carlton', email: 'chair@onboard.co.za', cell: '083 111 2222' } },
      }),
    );
    const res = await app.request('/clubs/onboardme', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ affiliation: 'complete', version: 1 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as WithLink;
    const token = body.playerRegLink?.token;
    assert.ok(token, 'a player-registration link was minted');

    // Comm events are appended after the affiliation write returns, so read them back.
    const stored = await repo.getClub('dolphins', 'onboardme');
    assert.equal(stored?.commLog?.length, 2, 'one event per channel');
    assert.ok(stored?.commLog?.every((e) => e.kind === 'reglink'));
    const email = stored?.commLog?.find((e) => e.channel === 'email');
    const wa = stored?.commLog?.find((e) => e.channel === 'whatsapp');
    assert.equal(email?.status, 'sent');
    assert.equal(email?.idempotencyKey, `reglink-${token}-email`);
    assert.equal(wa?.status, 'sent');
    assert.equal(wa?.to, '27831112222', 'cell normalized to E.164 for WhatsApp');
    assert.equal(wa?.idempotencyKey, `reglink-${token}-whatsapp`);
  });

  test('whatsapp is skipped (not failed) when the chair has no cell on file', async () => {
    await repo.createClub(
      'dolphins',
      mkClub('nocell', { exco: { chair: { name: 'No Cell', email: 'nocell@onboard.co.za' } } }),
    );
    const res = await app.request('/clubs/nocell', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ affiliation: 'complete', version: 1 }),
    });
    assert.equal(res.status, 200);
    const stored = await repo.getClub('dolphins', 'nocell');
    const wa = stored?.commLog?.find((e) => e.channel === 'whatsapp');
    assert.equal(wa?.status, 'skipped');
    assert.equal(stored?.commLog?.find((e) => e.channel === 'email')?.status, 'sent');
  });

  test('re-completion with a pre-existing link does not re-send (fresh-mint gate)', async () => {
    await repo.createClub(
      'dolphins',
      mkClub('alreadylinked', {
        exco: { chair: { name: 'Carlton', email: 'chair@linked.co.za', cell: '083 111 2222' } },
        playerRegLink: { token: 'pre-existing', createdAt: '2026-06-01T00:00:00.000Z' },
      }),
    );
    const res = await app.request('/clubs/alreadylinked', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ affiliation: 'complete', version: 1 }),
    });
    assert.equal(res.status, 200);
    const stored = await repo.getClub('dolphins', 'alreadylinked');
    assert.equal((stored as WithLink).playerRegLink?.token, 'pre-existing', 'link not re-minted');
    assert.ok(!stored?.commLog?.length, 'no onboarding send on re-confirmation');
  });
});

describe('GET /tenant — public tutorials', () => {
  test('returns the default tutorial set when the tenant has no override', async () => {
    const res = await app.request('/tenant', { headers: { 'x-tenant': 'dolphins' } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tutorials?: { title: string; url: string }[] };
    // Non-empty, well-formed default set. Each url carries the '/tutorials/' path segment
    // (relative here since TUTORIALS_BASE_URL is unset off-prod; absolute CDN URL in prod).
    assert.ok(Array.isArray(body.tutorials) && body.tutorials.length > 0);
    assert.ok(body.tutorials.every((t) => t.title && t.url.includes('/tutorials/')));
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

describe('POST /register/:clubId (public self-registration body)', () => {
  // The live registration path — exercised here at the body level (the suite otherwise only
  // covers the id-doc/upload-url subroute). Confirms nationality is required + persisted.
  const regClub = {
    id: 'regbody',
    name: 'Reg Body CC',
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
    color: '#222222',
    ground: {},
    leagues: [],
    version: 1,
  };
  let teamKey: string;
  let objectKey: string;

  before(async () => {
    await repo.createClub('dolphins', regClub);
    await repo.putToken('reg-body-token', 'dolphins', 'regbody', '2026-06-01T00:00:00.000Z');
    teamKey = ((await repo.getTenantConfig('dolphins'))?.leagues ?? [])[0]?.key ?? '';
    assert.ok(teamKey, 'precondition: tenant has a league catalogue');
    // Mint a real id-doc objectKey via the existing presign route (proven above).
    const up = await app.request('/register/regbody/id-doc/upload-url?t=reg-body-token', {
      method: 'POST',
      body: JSON.stringify({ contentType: 'image/png' }),
    });
    objectKey = ((await up.json()) as { objectKey: string }).objectKey;
  });

  const body = (extra: Record<string, unknown> = {}) => ({
    firstName: 'Tariro',
    lastName: 'Moyo',
    idType: 'passport',
    idNumber: 'PP0099',
    dob: '1998-04-10',
    nationality: 'Zimbabwean',
    race: 'African',
    gender: 'Female',
    cell: '0833334444',
    team: teamKey,
    district: 'Ethekwini',
    idDocMeta: { objectKey, size: 100, contentType: 'image/png' },
    ...extra,
  });

  test('accepts a self-registration with nationality and persists it (201)', async () => {
    const res = await app.request('/register/regbody?t=reg-body-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    });
    assert.equal(res.status, 201);
    const players = (await (
      await app.request('/clubs/regbody/players', { headers: headers(ADMIN) })
    ).json()) as { nationality?: string; lastName: string }[];
    const stored = players.find((p) => p.lastName === 'Moyo');
    assert.equal(stored?.nationality, 'Zimbabwean', 'nationality persisted on the public path');
  });

  test('rejects a self-registration missing nationality (400)', async () => {
    const res = await app.request('/register/regbody?t=reg-body-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body({ nationality: undefined, cell: '0833335555' })),
    });
    assert.equal(res.status, 400);
  });

  test('siblings sharing a parent email/cell but with distinct ID numbers both register (201)', async () => {
    // The reported bug, on the public self-registration path: a parent submits two children
    // with the same contact. Identity keys on each child's ID number, so both are accepted.
    const shared = { cell: '0833336666', email: 'guardian@moyo.test', nationality: 'Zimbabwean' };
    const first = await app.request('/register/regbody?t=reg-body-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body({ ...shared, idNumber: 'PP1111', firstName: 'Rudo' })),
    });
    const second = await app.request('/register/regbody?t=reg-body-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body({ ...shared, idNumber: 'PP2222', firstName: 'Farai' })),
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
  });
});

describe('POST /register — cross-club registrations, off-system alerts, admin ack', () => {
  const mkClub = (id: string, name: string) => ({
    id,
    name,
    district: 'Test District',
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
  let teamKey: string;
  let linkKey: string;
  let prevKey: string;

  before(async () => {
    await repo.createClub('dolphins', mkClub('rlink', 'Reg Link CC'));
    await repo.createClub('dolphins', mkClub('rdest', 'Reg Dest CC'));
    await repo.createClub('dolphins', mkClub('rprev', 'Reg Prev CC'));
    await repo.putToken('rev-link-token', 'dolphins', 'rlink', '2026-06-01T00:00:00.000Z');
    await repo.putToken('rev-prev-token', 'dolphins', 'rprev', '2026-06-01T00:00:00.000Z');
    teamKey = ((await repo.getTenantConfig('dolphins'))?.leagues ?? [])[0]?.key ?? '';
    const upLink = await app.request('/register/rlink/id-doc/upload-url?t=rev-link-token', {
      method: 'POST',
      body: JSON.stringify({ contentType: 'image/png' }),
    });
    linkKey = ((await upLink.json()) as { objectKey: string }).objectKey;
    const upPrev = await app.request('/register/rprev/id-doc/upload-url?t=rev-prev-token', {
      method: 'POST',
      body: JSON.stringify({ contentType: 'image/png' }),
    });
    prevKey = ((await upPrev.json()) as { objectKey: string }).objectKey;
  });

  const body = (objectKey: string, extra: Record<string, unknown> = {}) => ({
    firstName: 'Sipho',
    lastName: 'Ndlovu',
    idType: 'passport',
    idNumber: 'RV0001',
    dob: '1995-06-15',
    nationality: 'South African',
    race: 'African',
    gender: 'Male',
    cell: '0821110000',
    team: teamKey,
    district: 'Ethekwini',
    idDocMeta: { objectKey, size: 100, contentType: 'image/png' },
    ...extra,
  });
  const postLink = (extra: Record<string, unknown>) =>
    app.request('/register/rlink?t=rev-link-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body(linkKey, extra)),
    });
  const rosterIds = async (clubId: string) =>
    (
      (await (
        await app.request(`/clubs/${clubId}/players`, { headers: headers(ADMIN) })
      ).json()) as { idNumber?: string }[]
    ).map((p) => p.idNumber);
  const reviewByName = async (name: string) =>
    (await repo.listAllReviews('dolphins')).find((r) => r.playerName === name);

  test('first registration ("—") creates an active player and NO review', async () => {
    const res = await postLink({
      firstName: 'First',
      lastName: 'Reg',
      idNumber: 'RVA',
      lastClub: '—',
    });
    assert.equal(res.status, 201);
    assert.ok((await rosterIds('rlink')).includes('RVA'), 'player active in the link club');
    assert.equal(await reviewByName('First Reg'), undefined, 'first registration raises no alert');
  });

  test('off-system "Other" previous club → active player + admin off-system alert', async () => {
    const res = await postLink({
      firstName: 'Other',
      lastName: 'Sys',
      idNumber: 'RVB',
      lastClub: 'Ghost CC',
    });
    assert.equal(res.status, 201);
    assert.ok((await rosterIds('rlink')).includes('RVB'), 'player active in own club');
    const review = await reviewByName('Other Sys');
    assert.equal(review?.kind, 'off-system-alert');
    assert.equal(review?.typedPreviousClub, 'Ghost CC');
    assert.equal(review?.status, 'open');

    // Admin acknowledges it (must carry destClubId to rebuild the key).
    const ack = await app.request(`/admin/registration-reviews/${review!.id}/ack`, {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ destClubId: review!.destClubId }),
    });
    assert.equal(ack.status, 200);
    assert.equal((await reviewByName('Other Sys'))?.status, 'resolved');
  });

  test('cross-club (currentClubId ≠ link) with no on-system previous → active at the joining club, no review', async () => {
    const res = await postLink({
      firstName: 'Cross',
      lastName: 'Join',
      idNumber: 'RVC',
      currentClubId: 'rdest',
      lastClub: '—',
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true });
    assert.ok((await rosterIds('rdest')).includes('RVC'), 'player active at the joining club');
    assert.ok(!(await rosterIds('rlink')).includes('RVC'), 'no player row at the link club');
    assert.equal(await reviewByName('Cross Join'), undefined, 'no registration review created');
  });

  test('cross-club with an off-system previous → active at the joining club + alert attributed there', async () => {
    const res = await postLink({
      firstName: 'CrossOff',
      lastName: 'Sys',
      idNumber: 'RVE',
      currentClubId: 'rdest',
      lastClub: 'Ghost CC',
    });
    assert.equal(res.status, 201);
    assert.ok((await rosterIds('rdest')).includes('RVE'), 'active at the joining club');
    const review = await reviewByName('CrossOff Sys');
    assert.equal(review?.kind, 'off-system-alert');
    assert.equal(review?.typedPreviousClub, 'Ghost CC');
    // The alert is attributed to the JOINING club (rdest), not the link club (rlink).
    assert.equal(review?.destClubId, 'rdest');
  });

  test('previous club cannot equal a non-link current club (400)', async () => {
    // previous == current == a sibling (not the link club) is a transfer to yourself → 400.
    const selfGuard = await postLink({
      idNumber: 'RVF',
      currentClubId: 'rdest',
      lastClubId: 'rdest',
    });
    assert.equal(selfGuard.status, 400);
  });

  test('re-registration at the link club (previous == link) → active, no clearance, no review', async () => {
    const res = await postLink({
      firstName: 'Return',
      lastName: 'Ing',
      idNumber: 'RVH',
      lastClubId: 'rlink',
    });
    assert.equal(res.status, 201);
    // Landed active on the link club's own roster, with the link club recorded as history.
    const players = (await (
      await app.request('/clubs/rlink/players', { headers: headers(ADMIN) })
    ).json()) as { idNumber?: string; lastClub?: string; status?: string }[];
    const stored = players.find((p) => p.idNumber === 'RVH');
    assert.equal(stored?.status ?? 'active', 'active');
    assert.equal(stored?.lastClub, 'Reg Link CC');
    // No transfer machinery: no clearance and no registration review for this player.
    assert.ok(
      !(await repo.listAllClearances('dolphins')).some((c) => c.playerName === 'Return Ing'),
    );
    assert.equal(await reviewByName('Return Ing'), undefined);
  });

  test('cross-club with an on-system previous where the player is rostered opens a clearance immediately', async () => {
    // Seed the player at rprev via that club's own registration link (identical natural key).
    const seed = await app.request('/register/rprev?t=rev-prev-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        body(prevKey, { firstName: 'Trans', lastName: 'Fer', idNumber: 'RVG', lastClub: '—' }),
      ),
    });
    assert.equal(seed.status, 201);

    // The same person cross-registers into rdest via rlink's link, naming rprev as previous.
    // No hold — the clearance path handles it directly at registration time.
    const res = await postLink({
      firstName: 'Trans',
      lastName: 'Fer',
      idNumber: 'RVG',
      currentClubId: 'rdest',
      lastClubId: 'rprev',
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true, clearance: { fromClubName: 'Reg Prev CC' } });
    assert.equal(await reviewByName('Trans Fer'), undefined, 'no registration review created');

    // A registration-origin clearance rprev → rdest exists; the dest row is clearance-pending.
    const clr = (await repo.listAllClearances('dolphins')).find(
      (c) => c.playerName === 'Trans Fer',
    );
    assert.equal(clr?.fromClubId, 'rprev');
    assert.equal(clr?.toClubId, 'rdest');
    assert.equal(clr?.origin, 'registration');
    const destRow = (
      (await (await app.request('/clubs/rdest/players', { headers: headers(ADMIN) })).json()) as {
        idNumber?: string;
        status?: string;
      }[]
    ).find((p) => p.idNumber === 'RVG');
    assert.equal(destRow?.status, 'clearance-pending');
  });

  // Seed a player as active at rprev (via that club's own link) for the cross-club tests below.
  const seedAtPrev = (idNumber: string, firstName: string, lastName: string) =>
    app.request('/register/rprev?t=rev-prev-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body(prevKey, { firstName, lastName, idNumber, lastClub: '—' })),
    });

  test('auto-routes the clearance to the player’s REAL club when they name a different club', async () => {
    await seedAtPrev('RVM', 'Miss', 'Match'); // actually registered at rprev
    // They register into rdest but wrongly name the link club (rlink) as previous — they're not there.
    const res = await postLink({
      firstName: 'Miss',
      lastName: 'Match',
      idNumber: 'RVM',
      currentClubId: 'rdest',
      lastClubId: 'rlink',
    });
    assert.equal(res.status, 201);
    // Routed to rprev (where they ACTUALLY are), NOT the named rlink.
    assert.deepEqual(await res.json(), { ok: true, clearance: { fromClubName: 'Reg Prev CC' } });
    const clr = (await repo.listAllClearances('dolphins')).find(
      (c) => c.playerName === 'Miss Match',
    );
    assert.equal(clr?.fromClubId, 'rprev');
    assert.equal(clr?.toClubId, 'rdest');
    assert.match(clr?.note ?? '', /Reg Link CC/); // note records what they typed
    assert.match(clr?.note ?? '', /Reg Prev CC/); // and where they actually are
    // Not double-rostered: the destination row is clearance-pending, not a second active row.
    const destRow = (
      (await (await app.request('/clubs/rdest/players', { headers: headers(ADMIN) })).json()) as {
        idNumber?: string;
        status?: string;
      }[]
    ).find((p) => p.idNumber === 'RVM');
    assert.equal(destRow?.status, 'clearance-pending');
  });

  test('auto-routes to the real club even when the named previous club is off-system', async () => {
    await seedAtPrev('RVO', 'Off', 'Route');
    const res = await postLink({
      firstName: 'Off',
      lastName: 'Route',
      idNumber: 'RVO',
      currentClubId: 'rdest',
      lastClub: 'Ghost CC', // off-system name
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true, clearance: { fromClubName: 'Reg Prev CC' } });
    // A real transfer was detected, so NO off-system alert is raised.
    assert.equal(await reviewByName('Off Route'), undefined);
    const clr = (await repo.listAllClearances('dolphins')).find(
      (c) => c.playerName === 'Off Route',
    );
    assert.equal(clr?.fromClubId, 'rprev');
    assert.ok(clr?.note, 'mismatch note recorded');
  });

  test('a player already mid-transfer cannot open a competing registration (409)', async () => {
    await seedAtPrev('RVP', 'Pend', 'Ing');
    // First transfer flips the rprev row to clearance-pending.
    const first = await postLink({
      firstName: 'Pend',
      lastName: 'Ing',
      idNumber: 'RVP',
      currentClubId: 'rdest',
      lastClubId: 'rprev',
    });
    assert.equal(first.status, 201);
    // A second registration for the same identity is refused (indistinguishable 409).
    const second = await postLink({
      firstName: 'Pend',
      lastName: 'Ing',
      idNumber: 'RVP',
      lastClub: '—',
    });
    assert.equal(second.status, 409);
  });

  test('inbound cap: a foreign link flooding one club 429s past the per-hour limit', async () => {
    // A dedicated destination club so this test's 30+ inbound registrations stay isolated.
    await repo.createClub('dolphins', mkClub('rcap', 'Reg Cap CC'));
    let last: Awaited<ReturnType<typeof postLink>> | undefined;
    // CLUB_INBOUND_PER_HOUR = 30: the first 30 land active at rcap, the 31st is rate-limited.
    for (let i = 0; i < 31; i++) {
      last = await postLink({
        firstName: 'Flood',
        lastName: `N${i}`,
        idNumber: `RVCAP${i}`,
        currentClubId: 'rcap',
        lastClub: '—',
      });
    }
    assert.equal(last!.status, 429);
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

  test('inviting a malformed email is a clean 400 (not an opaque Cognito 500)', async () => {
    // EMAIL_RE rejects an internal space before AdminCreateUser is reached — the prod bug
    // (Sentry DOLPHINS-API-1: "Username should be an email" → 500) becomes a clear 400.
    const res = await invite({ email: 'mohau moabi@gmail.com', role: 'rep', clubIds: ['c1'] });
    assert.equal(res.status, 400);
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

  // ── PATCH /admin/users/:sub/email — correct a mistyped email (pending users) ──
  const patchEmail = (sub: string, body: unknown, auth = TADMIN) =>
    app.request(`/admin/users/${sub}/email`, {
      method: 'PATCH',
      headers: adminHeaders(auth),
      body: JSON.stringify(body),
    });

  test('PATCH email corrects a pending member, re-syncs the marker, and auto-resends', async () => {
    const wrong = 'tpyo@team.test';
    const right = 'typo@team.test';
    await invite({ email: wrong, role: 'rep', clubIds: ['c1'] });
    const sub = await subFor(wrong);

    const res = await patchEmail(sub, { email: right });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      sub: string;
      email: string;
      status: string;
      results: { channel: string; status: string }[];
    };
    assert.equal(body.email, right);
    assert.equal(body.status, 'pending');
    // Auto-resend goes out (dry-run "sent") to the corrected address.
    assert.equal(body.results.find((r) => r.channel === 'email')?.status, 'sent');

    // The sub is unchanged; the profile + the gsi1 marker now carry the new email,
    // so the roster lists the corrected address (and no longer the typo).
    assert.equal((await repo.getUser(sub))?.email, right);
    const rows = (await (await list()).json()) as Array<{ sub: string; email: string }>;
    assert.equal(rows.find((r) => r.sub === sub)?.email, right);
    assert.ok(!rows.some((r) => r.email === wrong), 'the typo address is gone from the roster');
  });

  test('PATCH email: a re-issued identical correction is a no-op (400 unchanged), DB stays converged', async () => {
    // Offline (LOCAL_AUTH=1) the Cognito relocation is stubbed, so this verifies only the
    // unchanged-guard. The actual Cognito Username path (sub-first with email-alias fallback)
    // can only be exercised against a real pool — see the dev smoke step in the plan.
    const wrong = 'retry-wrong@team.test';
    const right = 'retry-right@team.test';
    await invite({ email: wrong, role: 'rep', clubIds: ['c1'] });
    const sub = await subFor(wrong);

    assert.equal((await patchEmail(sub, { email: right })).status, 200);
    // Re-issue the identical correction — the unchanged-guard returns 400, DB untouched.
    assert.equal((await patchEmail(sub, { email: right })).status, 400);
    assert.equal((await repo.getUser(sub))?.email, right);
  });

  test('PATCH email on an ALREADY-ACTIVE member is rejected (400)', async () => {
    const email = 'already-active@team.test';
    await invite({ email, role: 'rep', clubIds: ['c1'] });
    const sub = await subFor(email);
    await repo.stampFirstLogin(sub); // they signed in ⇒ address already works
    const res = await patchEmail(sub, { email: 'new-active@team.test' });
    assert.equal(res.status, 400);
  });

  test('PATCH email to an address already used in the tenant is a 409', async () => {
    const taken = 'taken@team.test';
    const moving = 'moving@team.test';
    await invite({ email: taken, role: 'rep', clubIds: ['c1'] });
    await invite({ email: moving, role: 'rep', clubIds: ['c1'] });
    const sub = await subFor(moving);
    const res = await patchEmail(sub, { email: taken });
    assert.equal(res.status, 409);
    // The collision left the moving user's address untouched.
    assert.equal((await repo.getUser(sub))?.email, moving);
  });

  test('PATCH email rejects an invalid address (400) and an unknown sub (404)', async () => {
    const email = 'valid-check@team.test';
    await invite({ email, role: 'rep', clubIds: ['c1'] });
    const sub = await subFor(email);
    assert.equal((await patchEmail(sub, { email: 'not-an-email' })).status, 400);
    assert.equal((await patchEmail('local-nope', { email: 'who@team.test' })).status, 404);
  });

  test('PATCH email: a non-admin (rep) is forbidden (403)', async () => {
    const sub = await subFor('list-rep@team.test');
    const res = await patchEmail(sub, { email: 'x@team.test' }, TREP);
    assert.equal(res.status, 403);
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

/**
 * `mergeSnapshotLeagues` — the ADDITIVE leagues backfill (--merge-leagues): append only the
 * snapshot leagues whose key is missing from an already-populated tenant, preserving existing
 * and custom leagues (the propagation path for a stage whose CONFIG predates a new seed league).
 */
describe('mergeSnapshotLeagues (additive league backfill)', () => {
  let seed: typeof import('../src/seed-core.js');
  const NEW_KEY = 'promotion-women-s-league';
  let fullLeagues: { key: string; label: string; group: string; district: string }[] = [];

  before(async () => {
    seed = await import('../src/seed-core.js');
    fullLeagues = (await repo.getTenantConfig('dolphins'))?.leagues ?? [];
    assert.ok(
      fullLeagues.some((l) => l.key === NEW_KEY),
      'precondition: snapshot catalogue includes the new league',
    );
  });

  // Restore dolphins to its full catalogue so neighbouring suites see a healthy tenant.
  after(async () => {
    await seed.seedLeaguesOnly('dolphins', true);
  });

  // Force-write a chosen catalogue (touches only the leagues attribute), bypassing the merge.
  const setLeagues = (leagues: typeof fullLeagues) =>
    repo.backfillLeagues('dolphins', leagues, true);

  test('tenant with no CONFIG row → config-missing', async () => {
    const r = await seed.mergeSnapshotLeagues('unseeded-merge-co');
    assert.deepEqual(r, { status: 'config-missing' });
  });

  test('appends only the missing key, preserving existing leagues, no duplicates', async () => {
    const minus = fullLeagues.filter((l) => l.key !== NEW_KEY); // pre-women's-league state
    await setLeagues(minus);
    const r = await seed.mergeSnapshotLeagues('dolphins');
    assert.equal(r.status, 'merged');
    assert.ok(r.status === 'merged' && r.added.includes(NEW_KEY), 'added the new league key');
    const keys = (await repo.getTenantConfig('dolphins'))?.leagues?.map((l) => l.key) ?? [];
    for (const l of minus) assert.ok(keys.includes(l.key), `preserved existing league ${l.key}`);
    assert.ok(keys.includes(NEW_KEY), 'catalogue now contains the new league');
    assert.equal(new Set(keys).size, keys.length, 'no duplicate keys');
  });

  test('idempotent: a second merge on a full catalogue is a no-op (up-to-date)', async () => {
    await seed.seedLeaguesOnly('dolphins', true); // ensure full catalogue
    const count = (await repo.getTenantConfig('dolphins'))?.leagues?.length ?? 0;
    const r = await seed.mergeSnapshotLeagues('dolphins');
    assert.equal(r.status, 'up-to-date');
    assert.equal(r.status === 'up-to-date' && r.count, count);
    assert.equal((await repo.getTenantConfig('dolphins'))?.leagues?.length, count, 'unchanged');
  });

  test('preserves a custom (non-snapshot) league while adding missing snapshot leagues', async () => {
    await setLeagues([
      { key: 'custom-x', label: 'Custom X', group: 'Custom', district: 'All districts' },
    ]);
    const r = await seed.mergeSnapshotLeagues('dolphins');
    assert.equal(r.status, 'merged');
    const keys = (await repo.getTenantConfig('dolphins'))?.leagues?.map((l) => l.key) ?? [];
    assert.ok(keys.includes('custom-x'), 'custom league preserved');
    assert.ok(keys.includes(NEW_KEY) && keys.includes('premier'), 'snapshot leagues appended');
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
        nationality: 'South African',
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

  test('same person (same ID number) is rejected as a duplicate (409)', async () => {
    const res = await reg({});
    assert.equal(res.status, 409);
  });

  test('siblings sharing a parent email/cell but with distinct ID numbers both register (201)', async () => {
    // The reported bug: a parent registers two children with their OWN contact details.
    // Identity keys on the child's ID number, not the shared contact, so both succeed.
    const shared = { cell: '0820000200', email: 'parent@dolphins.test' };
    const a = await reg({ ...shared, idNumber: '9001015800086' }); // dob 1990-01-01
    const b = await reg({ ...shared, idNumber: '9202025800086' }); // dob 1992-02-02
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
  });

  test('two passport players sharing an ID number but from different countries both register (201)', async () => {
    // Passport numbers are unique only within an issuing country, so the key is namespaced
    // by nationality — the same string from two countries must not false-collide. Both share
    // the same cell so nationality is the ONLY differentiator (isolates the namespace fix).
    const shared = { idType: 'passport', idNumber: 'X9999999', cell: '0820000201' };
    const zw = await reg({ ...shared, dob: '1990-05-05', nationality: 'Zimbabwean' });
    const bd = await reg({ ...shared, dob: '1991-06-06', nationality: 'Bangladeshi' });
    assert.equal(zw.status, 201);
    assert.equal(bd.status, 201);
    // Same passport number AND same nationality is still a genuine duplicate.
    const dup = await reg({
      idType: 'passport',
      idNumber: 'X9999999',
      dob: '1990-05-05',
      nationality: 'Zimbabwean',
      cell: '0820000203',
    });
    assert.equal(dup.status, 409);
  });

  test('the stored key is an opaque hash — no raw ID number in it (POPIA)', async () => {
    // The key is the DynamoDB sk AND the :nk URL segment, so it must not leak the SA ID
    // into id-doc URLs / access logs / Sentry. Guards against a regression to plaintext keys.
    const idNumber = '8501015800086';
    const res = await reg({ idNumber, cell: '0820000210' });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { naturalKey: string };
    assert.match(body.naturalKey, /^[a-f0-9]{64}$/, 'naturalKey is a sha256 hex digest');
    assert.ok(!body.naturalKey.includes(idNumber), 'the raw ID number is not embedded in the key');
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

  test('registers a non-SA player by passport with a manual DOB (idNumber normalised)', async () => {
    const res = await reg({
      idType: 'passport',
      idNumber: ' a1234567 ',
      dob: '1999-03-15',
      nationality: 'Zimbabwean',
      cell: '0820000010',
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      dob: string;
      idType: string;
      idNumber: string;
      nationality: string;
    };
    assert.equal(body.dob, '1999-03-15');
    assert.equal(body.idType, 'passport');
    assert.equal(body.idNumber, 'A1234567'); // trimmed + upper-cased on store
    assert.equal(body.nationality, 'Zimbabwean'); // non-SA nationality round-trips
  });

  test('a registration missing nationality is rejected (400)', async () => {
    // 400 fires at the required-field gate before any createPlayer, so no unique cell is needed.
    const res = await reg({ nationality: undefined });
    assert.equal(res.status, 400);
  });

  test('a passport player without a DOB is rejected (400)', async () => {
    const res = await reg({ idType: 'passport', idNumber: 'B7654321', cell: '0820000011' });
    assert.equal(res.status, 400);
  });

  test('a passport minor without a guardian is rejected (400, POPIA)', async () => {
    const res = await reg({
      idType: 'passport',
      idNumber: 'C2468013',
      dob: '2015-01-01',
      cell: '0820000012',
    });
    assert.equal(res.status, 400);
  });

  test('a rep for another club cannot register here (403)', async () => {
    const other = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['testers'] }]);
    const res = await reg({ cell: '0820000003' }, other);
    assert.equal(res.status, 403);
  });
});

describe('DELETE /clubs/:id/players/:nk (chair removes a player)', () => {
  const REP_DEL = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['delclub'] }]);
  const REP_OTHER = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['testers'] }]);

  const mkClub = (id: string) => ({
    id,
    name: id,
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
    firstName: 'Del',
    lastName: nk,
    dob: '1995-01-01',
    isMinor: false,
    status: 'active' as const,
    consentAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
  });

  before(async () => {
    await repo.createClub('dolphins', mkClub('delclub'));
    await repo.createPlayer('dolphins', mkPlayer('delclub', 'del-me'));
    await repo.createPlayer('dolphins', mkPlayer('delclub', 'pending-me'));
  });

  const del = (nk: string, auth = REP_DEL) =>
    app.request(`/clubs/delclub/players/${nk}`, { method: 'DELETE', headers: headers(auth) });

  test('a rep for another club cannot delete here (403)', async () => {
    const res = await del('del-me', REP_OTHER);
    assert.equal(res.status, 403);
  });

  test('deleting a non-existent player yields 404', async () => {
    const res = await del('ghost');
    assert.equal(res.status, 404);
  });

  test('the chair deletes a player; the row is gone and playerCount drops by one', async () => {
    const before = (await repo.getClub('dolphins', 'delclub')) as { playerCount?: number };
    const res = await del('del-me');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(await repo.getPlayer('dolphins', 'delclub', 'del-me'), null);
    const after = (await repo.getClub('dolphins', 'delclub')) as { playerCount?: number };
    assert.equal(after.playerCount, (before.playerCount ?? 0) - 1);
  });

  test('deleting the same player again is a 404', async () => {
    const res = await del('del-me');
    assert.equal(res.status, 404);
  });

  test('a player mid-transfer (clearance-pending) is blocked (409) and left in place', async () => {
    await repo.updatePlayer('dolphins', 'delclub', 'pending-me', { status: 'clearance-pending' });
    const res = await del('pending-me');
    assert.equal(res.status, 409);
    assert.ok(await repo.getPlayer('dolphins', 'delclub', 'pending-me'));
  });

  test('repo.deletePlayer backstops the TOCTOU race: throws on a now-pending player, count intact', async () => {
    // Simulate the race the conditional delete guards: the route read the player as `active`
    // (its stale snapshot), but a concurrent createClearance flipped the stored row to
    // clearance-pending before the delete lands. deletePlayer's condition must catch it.
    await repo.createPlayer('dolphins', mkPlayer('delclub', 'race-me'));
    await repo.updatePlayer('dolphins', 'delclub', 'race-me', { status: 'clearance-pending' });
    const before = (await repo.getClub('dolphins', 'delclub')) as { playerCount?: number };
    await assert.rejects(
      // Pass the stale `active` snapshot the route would have held.
      () => repo.deletePlayer('dolphins', mkPlayer('delclub', 'race-me')),
      (err: unknown) => (err as { name?: string }).name === 'ConditionalCheckFailedException',
    );
    assert.ok(await repo.getPlayer('dolphins', 'delclub', 'race-me'), 'row must survive the block');
    const after = (await repo.getClub('dolphins', 'delclub')) as { playerCount?: number };
    assert.equal(after.playerCount, before.playerCount, 'count must be untouched');
  });
});

describe('PATCH /clubs/:id — affiliation field validation', () => {
  const mkClub = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
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
  let leagueKey: string;

  before(async () => {
    await repo.createClub('dolphins', mkClub('affclub'));
    // A club that completed affiliation BEFORE the reason field existed (no reasonForInvolvement).
    await repo.createClub(
      'dolphins',
      mkClub('legacyclub', {
        affiliation: 'complete',
        exco: { chair: { name: 'Old Chair', email: 'old@chair.co.za', cell: '0830000000' } },
      }),
    );
    leagueKey = ((await repo.getTenantConfig('dolphins'))?.leagues ?? [])[0]?.key ?? '';
    assert.ok(leagueKey, 'precondition: tenant has a league catalogue');
  });

  // version is omitted throughout: repo.updateClub defaults expectedVersion to current.version,
  // so omitting it never conflicts — the 400 cases fail validation before the version check anyway.
  const patch = (id: string, body: unknown) =>
    app.request(`/clubs/${id}`, {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify(body),
    });

  test('a valid chair reasonForInvolvement is accepted (200)', async () => {
    const res = await patch('affclub', {
      exco: {
        chair: {
          name: 'C',
          email: 'c@a.co.za',
          cell: '08',
          reasonForInvolvement: 'Promoting cricket in my local area',
        },
      },
    });
    assert.equal(res.status, 200);
  });

  test('an unknown chair reasonForInvolvement is rejected (400)', async () => {
    const res = await patch('affclub', {
      exco: {
        chair: { name: 'C', email: 'c@a.co.za', cell: '08', reasonForInvolvement: 'because' },
      },
    });
    assert.equal(res.status, 400);
  });

  test('a legacy complete club re-submits a correction WITHOUT a reason (200)', async () => {
    // The server must never require the reason — only the client gates it for NEW affiliations.
    const res = await patch('legacyclub', {
      exco: { chair: { name: 'Old Chair', email: 'old@chair.co.za', cell: '0830000001' } },
    });
    assert.equal(res.status, 200);
  });

  test('valid leagueTeams is accepted (200)', async () => {
    const res = await patch('affclub', { leagues: [leagueKey], leagueTeams: { [leagueKey]: 2 } });
    assert.equal(res.status, 200);
    const stored = (await repo.getClub('dolphins', 'affclub')) as {
      leagueTeams?: Record<string, number>;
    };
    assert.equal(stored.leagueTeams?.[leagueKey], 2);
  });

  test('a leagueTeams count over the cap is rejected (400)', async () => {
    const res = await patch('affclub', { leagues: [leagueKey], leagueTeams: { [leagueKey]: 31 } });
    assert.equal(res.status, 400);
  });

  test('a leagueTeams count below 1 is rejected (400)', async () => {
    const res = await patch('affclub', { leagues: [leagueKey], leagueTeams: { [leagueKey]: 0 } });
    assert.equal(res.status, 400);
  });

  test('an orphaned leagueTeams key (not in leagues) is rejected (400)', async () => {
    const res = await patch('affclub', { leagues: [leagueKey], leagueTeams: { 'orphan-key': 2 } });
    assert.equal(res.status, 400);
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

  test('a passport player is found for clearance despite ID case variance', async () => {
    // Isolated club pair so this extra clearance doesn't pollute the shared clr-src counts.
    await repo.createClub('dolphins', mkClub('pp-src', 'PP Source CC'));
    await repo.createClub('dolphins', mkClub('pp-dst', 'PP Destination CC'));
    await repo.createPlayer('dolphins', {
      ...mkPlayer('pp-src', 'passport-mover'),
      idType: 'passport',
      idNumber: 'A1234567', // stored already normalised (trim + uppercase)
    });
    const REP_PP_DST = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['pp-dst'] }]);
    // Destination rep retypes the passport in a different case — the lookup normalises both.
    const res = await app.request('/clubs/pp-dst/clearances', {
      method: 'POST',
      headers: headers(REP_PP_DST),
      body: JSON.stringify({ fromClubId: 'pp-src', idNumber: ' a1234567 ' }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { playerNaturalKey: string };
    assert.equal(body.playerNaturalKey, 'passport-mover');
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

describe('registration-origin clearances (previous-club dropdown on the public form)', () => {
  // A player registers at a NEW club naming their previous club: the destination row is
  // created 'clearance-pending' together with an origin:'registration' clearance the
  // source club (or the union) resolves. Reject (union-only) restores the source player
  // and removes the pending destination row.
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
  const REP_RCA = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['rc-a'] }]);
  let teamKey: string;
  let keyA: string; // presigned objectKey under rc-a
  let keyB: string; // presigned objectKey under rc-b

  const mintKey = async (clubId: string, token: string) => {
    const up = await app.request(`/register/${clubId}/id-doc/upload-url?t=${token}`, {
      method: 'POST',
      body: JSON.stringify({ contentType: 'image/png' }),
    });
    return ((await up.json()) as { objectKey: string }).objectKey;
  };

  const regBody = (extra: Record<string, unknown> = {}) => ({
    firstName: 'Thabo',
    lastName: 'Nkosi',
    idType: 'passport',
    idNumber: 'RC9001',
    dob: '1999-02-02',
    nationality: 'Zimbabwean',
    race: 'African',
    gender: 'Male',
    cell: '0831112222',
    team: teamKey,
    district: 'Ethekwini',
    idDocMeta: { objectKey: keyB, size: 100, contentType: 'image/png' },
    ...extra,
  });

  const registerAt = (clubId: string, token: string, body: Record<string, unknown>) =>
    app.request(`/register/${clubId}?t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  before(async () => {
    await repo.createClub('dolphins', mkClub('rc-a', 'RC Alpha CC'));
    await repo.createClub('dolphins', mkClub('rc-b', 'RC Beta CC'));
    await repo.putToken('rc-a-token', 'dolphins', 'rc-a', '2026-06-01T00:00:00.000Z');
    await repo.putToken('rc-b-token', 'dolphins', 'rc-b', '2026-06-01T00:00:00.000Z');
    teamKey = ((await repo.getTenantConfig('dolphins'))?.leagues ?? [])[0]?.key ?? '';
    assert.ok(teamKey, 'precondition: tenant has a league catalogue');
    keyA = await mintKey('rc-a', 'rc-a-token');
    keyB = await mintKey('rc-b', 'rc-b-token');
  });

  test('GET /register/:clubId lists the sibling clubs (excluding the registering club)', async () => {
    const res = await app.request('/register/rc-b?t=rc-b-token');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { clubs: { id: string; name: string }[] };
    assert.ok(Array.isArray(body.clubs), 'clubs list rides on the link context');
    assert.ok(
      body.clubs.some((cl) => cl.id === 'rc-a'),
      'sibling club present',
    );
    assert.ok(!body.clubs.some((cl) => cl.id === 'rc-b'), 'registering club excluded');
  });

  test('registering with a matching previous club creates a pending row + clearance', async () => {
    // Seed the player at the SOURCE via the same public route so both rows derive the
    // same naturalKey from the same identity fields.
    const seeded = await registerAt('rc-a', 'rc-a-token', {
      ...regBody({ cell: '0830000001' }),
      idDocMeta: { objectKey: keyA, size: 100, contentType: 'image/png' },
    });
    assert.equal(seeded.status, 201);

    const res = await registerAt('rc-b', 'rc-b-token', {
      ...regBody({ cell: '0830000002' }),
      lastClubId: 'rc-a',
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { ok: boolean; clearance?: { fromClubName: string } };
    assert.equal(body.clearance?.fromClubName, 'RC Alpha CC');

    const source = await repo.listPlayers('dolphins', 'rc-a');
    const srcRow = source.find((p) => p.idNumber === 'RC9001');
    assert.equal(srcRow?.status, 'clearance-pending', 'source player flipped pending');
    const dest = await repo.listPlayers('dolphins', 'rc-b');
    const dstRow = dest.find((p) => p.idNumber === 'RC9001');
    assert.equal(dstRow?.status, 'clearance-pending', 'destination row pre-created pending');
    assert.equal(dstRow?.lastClub, 'RC Alpha CC');
    assert.equal(dstRow?.cell, '0830000002', 'destination row carries the fresh data');

    const clr = (await repo.listClearancesForSource('dolphins', 'rc-a')).find(
      (x) => x.idNumber === 'RC9001',
    );
    assert.equal(clr?.origin, 'registration');
    assert.equal(clr?.status, 'pending');
    assert.ok(clr?.requestedAt, 'requestedAt set (feeds the admin-list gsi1 sort)');
    assert.equal(clr?.requestedBy, undefined, 'no rep initiated it');

    // Union sight: the clearance appears in the tenant-wide admin list.
    const adminList = (await (
      await app.request('/admin/clearances', { headers: headers(ADMIN) })
    ).json()) as { id: string }[];
    assert.ok(adminList.some((x) => x.id === clr!.id));

    const destClub = await repo.getClub('dolphins', 'rc-b');
    assert.equal(destClub?.playerCount, 1, 'destination count bumped once, at registration');
  });

  test('issuing the clearance activates the destination row in place (fresh data wins)', async () => {
    const clr = (await repo.listClearancesForSource('dolphins', 'rc-a')).find(
      (x) => x.idNumber === 'RC9001',
    )!;
    const res = await app.request(`/clubs/rc-a/clearances/${clr.id}`, {
      method: 'PATCH',
      headers: headers(REP_RCA),
      body: JSON.stringify({
        feesCleared: true,
        misconductCleared: true,
        action: 'issue',
        version: clr.version,
      }),
    });
    assert.equal(res.status, 200);
    const dest = (await repo.listPlayers('dolphins', 'rc-b')).find((p) => p.idNumber === 'RC9001');
    assert.equal(dest?.status, 'active');
    assert.equal(dest?.cell, '0830000002', 'activated row is the registration, not a copy');
    assert.equal(
      dest?.previousIdDocMeta?.objectKey,
      keyA,
      'source club’s vetted ID doc carried over as evidence',
    );
    const source = (await repo.listPlayers('dolphins', 'rc-a')).find(
      (p) => p.idNumber === 'RC9001',
    );
    assert.equal(source, undefined, 'source row removed on approval');
    const destClub = await repo.getClub('dolphins', 'rc-b');
    assert.equal(destClub?.playerCount, 1, 'no double-increment on approval');
  });

  test('no ID match at the claimed club falls back to a plain registration', async () => {
    const res = await registerAt('rc-b', 'rc-b-token', {
      ...regBody({ idNumber: 'RC9002', cell: '0830000003' }),
      lastClubId: 'rc-a',
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { clearance?: unknown };
    assert.equal(body.clearance, undefined, 'no clearance opened');
    const row = (await repo.listPlayers('dolphins', 'rc-b')).find((p) => p.idNumber === 'RC9002');
    assert.equal(row?.status, 'active');
    assert.equal(row?.lastClub, 'RC Alpha CC', 'claimed club stored as text');
  });

  test('self-referential lastClubId (== the club being joined) is a re-registration', async () => {
    // Previous club == the club whose link is used == current club → a re-registration at the
    // same club: active row, the club recorded as history, no clearance (nothing to transfer).
    const self = await registerAt('rc-b', 'rc-b-token', {
      ...regBody({ idNumber: 'RC9003' }),
      lastClubId: 'rc-b',
    });
    assert.equal(self.status, 201);
    assert.equal(((await self.json()) as { clearance?: unknown }).clearance, undefined);
    const row = (await repo.listPlayers('dolphins', 'rc-b')).find((p) => p.idNumber === 'RC9003');
    assert.equal(row?.status, 'active');
    assert.equal(row?.lastClub, 'RC Beta CC', 'own club recorded as last-registered history');
  });

  test('unknown lastClubId is rejected (400)', async () => {
    const unknown = await registerAt('rc-b', 'rc-b-token', {
      ...regBody({ idNumber: 'RC9019', cell: '0830000019' }),
      lastClubId: 'no-such-club',
    });
    assert.equal(unknown.status, 400);
  });

  test('union rejects a registration-origin clearance: player stays at destination flagged, removed from source', async () => {
    // Seed at source, then transfer-register at destination.
    await registerAt('rc-a', 'rc-a-token', {
      ...regBody({ idNumber: 'RC9004', cell: '0830000004' }),
      idDocMeta: { objectKey: keyA, size: 100, contentType: 'image/png' },
    });
    const reg = await registerAt('rc-b', 'rc-b-token', {
      ...regBody({ idNumber: 'RC9004', cell: '0830000005' }),
      lastClubId: 'rc-a',
    });
    assert.equal(reg.status, 201);
    const clr = (await repo.listClearancesForSource('dolphins', 'rc-a')).find(
      (x) => x.idNumber === 'RC9004' && x.status === 'pending',
    )!;
    const destCountBefore = (await repo.getClub('dolphins', 'rc-b'))?.playerCount ?? 0;
    const srcCountBefore = (await repo.getClub('dolphins', 'rc-a'))?.playerCount ?? 0;

    const res = await app.request(`/admin/clearances/${clr.id}/reject`, {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ fromClubId: 'rc-a', version: clr.version, reason: 'Fees owing' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      status: string;
      rejectedBy?: string;
      rejectReason?: string;
    };
    assert.equal(body.status, 'rejected');
    assert.equal(body.rejectReason, 'Fees owing');
    assert.ok(body.rejectedBy, 'rejecting admin recorded');

    // Source (previous club) row removed; destination (current club) row KEPT + flagged.
    const source = (await repo.listPlayers('dolphins', 'rc-a')).find(
      (p) => p.idNumber === 'RC9004',
    );
    assert.equal(source, undefined, 'source (previous club) player removed');
    const dest = (await repo.listPlayers('dolphins', 'rc-b')).find(
      (p) => p.idNumber === 'RC9004',
    ) as { status?: string; clearanceRejectedReason?: string; clearanceRejectedAt?: string };
    assert.equal(dest?.status, 'clearance-rejected', 'player stays at destination, flagged');
    assert.equal(dest?.clearanceRejectedReason, 'Fees owing');
    assert.ok(dest?.clearanceRejectedAt, 'reject timestamp copied onto the player');

    // Counts: destination unchanged (row survives), source −1 (row gone).
    assert.equal(
      (await repo.getClub('dolphins', 'rc-b'))?.playerCount ?? 0,
      destCountBefore,
      'destination count unchanged',
    );
    assert.equal(
      (await repo.getClub('dolphins', 'rc-a'))?.playerCount ?? 0,
      srcCountBefore - 1,
      'source count decremented',
    );
    // The mirror flipped too (destination club sees the outcome).
    const mirror = (await repo.listInboundForDest('dolphins', 'rc-b')).find((x) => x.id === clr.id);
    assert.equal(mirror?.status, 'rejected');
  });

  test('reject is admin-only (403 for reps) and pending-only (409 after resolution)', async () => {
    const clr = (await repo.listClearancesForSource('dolphins', 'rc-a')).find(
      (x) => x.idNumber === 'RC9004',
    )!;
    const rep = await app.request(`/admin/clearances/${clr.id}/reject`, {
      method: 'POST',
      headers: headers(REP_RCA),
      body: JSON.stringify({ fromClubId: 'rc-a' }),
    });
    assert.equal(rep.status, 403);
    const again = await app.request(`/admin/clearances/${clr.id}/reject`, {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ fromClubId: 'rc-a' }),
    });
    assert.equal(again.status, 409, 'already rejected');
  });

  test('a rep-initiated (request-origin) clearance can also be rejected', async () => {
    // Same lifecycle as the union office declining a normal transfer request: no
    // destination row exists, so reject only restores the source player.
    await repo.createPlayer('dolphins', {
      naturalKey: 'req-reject',
      clubId: 'rc-a',
      firstName: 'Stay',
      lastName: 'Put',
      dob: '1995-01-01',
      isMinor: false,
      status: 'active',
      consentAt: '2026-05-01T00:00:00.000Z',
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    await repo.createClearance('dolphins', {
      id: 'clr-req-reject',
      playerNaturalKey: 'req-reject',
      playerName: 'Stay Put',
      fromClubId: 'rc-a',
      toClubId: 'rc-b',
      fromClubName: 'RC Alpha CC',
      toClubName: 'RC Beta CC',
      requestedAt: new Date().toISOString(),
      feesCleared: false,
      misconductCleared: false,
      status: 'pending',
      clubApprovedAt: null,
      adminOverrideAt: null,
      version: 0,
    });
    const res = await app.request('/admin/clearances/clr-req-reject/reject', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ fromClubId: 'rc-a' }),
    });
    assert.equal(res.status, 200);
    const player = await repo.getPlayer('dolphins', 'rc-a', 'req-reject');
    assert.equal(player?.status, 'active', 'source player unstuck');
    assert.ok(
      await repo.getPlayer('dolphins', 'rc-b', 'req-reject').then((p) => p === null),
      'no destination row ever existed',
    );
  });

  test('a clearance-rejected player transferred out later loses the reject flag', async () => {
    // Seed a player already flagged clearance-rejected at rc-b (as if a prior registration
    // clearance had been rejected), then request-transfer them to rc-a and approve.
    await repo.createPlayer('dolphins', {
      naturalKey: 'scrub-reject',
      clubId: 'rc-b',
      firstName: 'Flag',
      lastName: 'Gone',
      dob: '1994-02-02',
      idNumber: 'RC9010',
      isMinor: false,
      status: 'clearance-rejected',
      clearanceRejectedAt: '2026-06-10T00:00:00.000Z',
      clearanceRejectedReason: 'Fees owing',
      consentAt: '2026-05-01T00:00:00.000Z',
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    await repo.createClearance('dolphins', {
      id: 'clr-scrub',
      playerNaturalKey: 'scrub-reject',
      playerName: 'Flag Gone',
      idNumber: 'RC9010',
      fromClubId: 'rc-b',
      toClubId: 'rc-a',
      fromClubName: 'RC Beta CC',
      toClubName: 'RC Alpha CC',
      requestedAt: new Date().toISOString(),
      feesCleared: false,
      misconductCleared: false,
      status: 'pending',
      clubApprovedAt: null,
      adminOverrideAt: null,
      version: 0,
    });
    await repo.resolveClearance('dolphins', 'rc-b', 'clr-scrub', {
      mode: 'admin',
      at: new Date().toISOString(),
    });

    const moved = (await repo.getPlayer('dolphins', 'rc-a', 'scrub-reject')) as {
      status?: string;
      clearanceRejectedAt?: string;
      clearanceRejectedReason?: string;
    } | null;
    assert.equal(moved?.status, 'active', 'transferred in as active');
    assert.equal(moved?.clearanceRejectedAt, undefined, 'stale reject timestamp scrubbed');
    assert.equal(moved?.clearanceRejectedReason, undefined, 'stale reject reason scrubbed');
    assert.equal(
      await repo.getPlayer('dolphins', 'rc-b', 'scrub-reject'),
      null,
      'source row removed on approve',
    );
  });

  test('registering while the player is already mid-clearance is a conflict with nothing written', async () => {
    // RC9005 gets a pending clearance rc-a → rc-b, then tries to transfer-register at a
    // third club naming rc-a: the atomic source guard rejects it, and the third club
    // must carry NO residue (no player row, no clearance items).
    await repo.createClub('dolphins', mkClub('rc-c', 'RC Gamma CC'));
    await repo.putToken('rc-c-token', 'dolphins', 'rc-c', '2026-06-01T00:00:00.000Z');
    const keyC = await mintKey('rc-c', 'rc-c-token');
    await registerAt('rc-a', 'rc-a-token', {
      ...regBody({ idNumber: 'RC9005', cell: '0830000006' }),
      idDocMeta: { objectKey: keyA, size: 100, contentType: 'image/png' },
    });
    const first = await registerAt('rc-b', 'rc-b-token', {
      ...regBody({ idNumber: 'RC9005', cell: '0830000007' }),
      lastClubId: 'rc-a',
    });
    assert.equal(first.status, 201);

    const second = await registerAt('rc-c', 'rc-c-token', {
      ...regBody({ idNumber: 'RC9005', cell: '0830000008' }),
      idDocMeta: { objectKey: keyC, size: 100, contentType: 'image/png' },
      lastClubId: 'rc-a',
    });
    assert.equal(second.status, 409);
    const cRoster = await repo.listPlayers('dolphins', 'rc-c');
    assert.equal(cRoster.length, 0, 'no player row at the third club');
    const cInbound = await repo.listInboundForDest('dolphins', 'rc-c');
    assert.equal(cInbound.length, 0, 'no clearance mirror at the third club');

    // Indistinguishability: the mid-clearance conflict must read exactly like a
    // duplicate registration, so the public endpoint can't probe transfer state.
    const dup = await registerAt('rc-b', 'rc-b-token', {
      ...regBody({ idNumber: 'RC9005', cell: '0830000009' }),
      lastClubId: 'rc-a',
    });
    assert.equal(dup.status, 409);
    assert.deepEqual(await dup.json(), await second.json(), 'identical conflict responses');
  });

  test('the public submit endpoint is rate-limited per token (429)', async () => {
    await repo.createClub('dolphins', mkClub('rc-rl', 'RC RateLimit CC'));
    await repo.putToken('rc-rl-token', 'dolphins', 'rc-rl', '2026-06-01T00:00:00.000Z');
    // Invalid bodies still consume quota (the cap runs before validation, like the
    // presign route) — so the loop is cheap 400s until the cap trips.
    let status = 0;
    for (let i = 0; i < 241 && status !== 429; i++) {
      const res = await registerAt('rc-rl', 'rc-rl-token', {});
      status = res.status;
    }
    assert.equal(status, 429, 'cap trips within the hourly budget');
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
    // This tenant's config row has NO districts field → the shared defaults must
    // resolve (the legacy-tenant fallback path).
    assert.deepEqual(body.districts, DEFAULT_DISTRICTS);
  });

  test('a tenant with explicit districts: [] blocks signup (GET empty, POST 400)', async () => {
    const ET = 'emptydistricts';
    const EADMIN = devAuthAs('caller-empty-admin', 'empty-admin@su.test', [
      { tenantId: ET, role: 'admin', clubIds: [] },
    ]);
    await repo.putTenantConfig({
      tenant: ET,
      branding: { name: 'Empty Union', title: 'Empty', logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [],
      districts: [], // freshly created client — operator hasn't configured districts yet
    });
    const etoken = await mintLink(ET, EADMIN);
    const get = await signupGet(etoken);
    assert.equal(get.status, 200);
    assert.deepEqual(((await get.json()) as { districts: string[] }).districts, []);
    const post = await signupPost(validBody(), etoken);
    assert.equal(post.status, 400);
    assert.match(((await post.json()) as { error: string }).error, /unknown district/);
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
    assert.ok(club.signupConsentAt, 'implied POPIA consent timestamp stamped on submit');
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
      ['over-length name', validBody({ clubName: 'X'.repeat(81), repEmail: 'bad5@su.test' })],
      ['over-length cell', validBody({ repCell: '0'.repeat(21), repEmail: 'bad6@su.test' })],
    ];
    for (const [label, body] of cases) {
      assert.equal((await signupPost(body)).status, 400, label);
    }
    // None of the rejects minted a login.
    for (const email of ['bad1@su.test', 'bad5@su.test']) {
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
      removed: { players: 2, clearances: 2, users: 2, series: 0, seriesFailed: 0 },
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
      removed: { players: 0, clearances: 0, users: 1, series: 0, seriesFailed: 0 },
    });

    // Sole club gone → the self-provisioned rep is fully offboarded, marker and all.
    assert.equal(await repo.getUser(repSub), null, 'self-signup rep fully offboarded');
    assert.ok(!(await repo.listTenantUsers(T)).some((u) => u.sub === repSub), 'rep marker swept');
    assert.equal(await repo.getClub(T, clubId), null);
  });
});

describe('DELETE /clubs/:id — draft series cascade', () => {
  // Own tenant so the series sweep can't disturb other suites.
  const T = 'delseries';
  const headers = (auth: string) => ({
    'x-tenant': T,
    'x-dev-auth': auth,
    'content-type': 'application/json',
  });
  const ADMIN = devAuthAs('caller-ds-admin', 'ds-admin@ds.test', [
    { tenantId: T, role: 'admin', clubIds: [] },
  ]);
  const del = (id: string) =>
    app.request(`/clubs/${id}`, { method: 'DELETE', headers: headers(ADMIN) });

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

  before(async () => {
    await repo.putTenantConfig({
      tenant: T,
      branding: { name: 'Series Union', title: 'Ser', logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [],
    });
    await repo.createClub(T, mkClub('alpha', 'Alpha CC'));
    await repo.createClub(T, mkClub('bravo', 'Bravo CC'));
    await repo.createClub(T, mkClub('charlie', 'Charlie CC'));

    // Draft series, approved, all three teams — alpha must be stripped and approval re-opened.
    await repo.putSeries(T, {
      id: 'draft-s',
      name: 'Draft Series',
      startDate: '2026-07-01',
      teams: ['alpha', 'bravo', 'charlie'],
      fixtures: [
        { home: 'alpha', away: 'bravo', date: '2026-07-01', round: 1 },
        { home: 'bravo', away: 'charlie', date: '2026-07-08', round: 2 },
      ],
      approved: true,
      approvedAt: '2026-06-15T00:00:00.000Z',
      released: false,
      releasedAt: null,
      version: 1,
    });
    // Released series with alpha — must be left untouched (preserves published history).
    await repo.putSeries(T, {
      id: 'rel-s',
      name: 'Released Series',
      startDate: '2026-07-01',
      teams: ['alpha', 'bravo'],
      fixtures: [{ home: 'alpha', away: 'bravo', date: '2026-07-01', round: 1 }],
      approved: true,
      approvedAt: '2026-06-15T00:00:00.000Z',
      released: true,
      releasedAt: '2026-06-20T00:00:00.000Z',
      version: 1,
    });
    // Draft 2-team series — removing alpha drops it below 2 teams; must be KEPT, not auto-deleted.
    await repo.putSeries(T, {
      id: 'twoteam-s',
      name: 'Two Team Series',
      startDate: '2026-07-01',
      teams: ['alpha', 'charlie'],
      fixtures: [{ home: 'alpha', away: 'charlie', date: '2026-07-01', round: 1 }],
      approved: false,
      approvedAt: null,
      released: false,
      releasedAt: null,
      version: 1,
    });
  });

  test('strips the club from draft series, drops its fixtures, re-opens approval; counts it', async () => {
    const res = await del('alpha');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { removed: { series: number; seriesFailed: number } };
    // alpha is in draft-s + twoteam-s (cleaned) and rel-s (skipped) → 2 cleaned, 0 failed.
    assert.equal(body.removed.series, 2);
    assert.equal(body.removed.seriesFailed, 0);

    const draft = await repo.getSeries(T, 'draft-s');
    assert.deepEqual(draft?.teams, ['bravo', 'charlie'], 'alpha removed from teams');
    assert.deepEqual(
      draft?.fixtures,
      [{ home: 'bravo', away: 'charlie', date: '2026-07-08', round: 2 }],
      'fixtures involving alpha dropped',
    );
    assert.equal(draft?.approved, false, 'approval re-opened after fixture change');
    assert.equal(draft?.approvedAt, null);
  });

  test('leaves released series intact (preserves published history)', async () => {
    const rel = await repo.getSeries(T, 'rel-s');
    assert.deepEqual(rel?.teams, ['alpha', 'bravo'], 'released teams untouched');
    assert.equal((rel?.fixtures as unknown[]).length, 1, 'released fixtures untouched');
    assert.equal(rel?.released, true);
    assert.equal(rel?.version, 1, 'released series never re-written');
  });

  test('keeps a now-degenerate (<2 team) draft series for admin review', async () => {
    const two = await repo.getSeries(T, 'twoteam-s');
    assert.ok(two, 'degenerate series not auto-deleted');
    assert.deepEqual(two?.teams, ['charlie']);
    assert.deepEqual(two?.fixtures, []);
  });

  test('series sweep is a no-op on re-run (idempotent / re-deletable)', async () => {
    // Drive eraseClubData twice directly: the first cleans, the second must skip every series
    // (alpha already gone from teams) and report series: 0 — proving the re-run guard.
    await repo.createClub(T, mkClub('echo', 'Echo CC'));
    await repo.createClub(T, mkClub('foxtrot', 'Foxtrot CC'));
    await repo.putSeries(T, {
      id: 'idem-s',
      name: 'Idem Series',
      startDate: '2026-07-01',
      teams: ['echo', 'foxtrot'],
      fixtures: [{ home: 'echo', away: 'foxtrot', date: '2026-07-01', round: 1 }],
      released: false,
      releasedAt: null,
      version: 1,
    });
    const club = (await repo.getClub(T, 'echo'))!;
    const first = await repo.eraseClubData(T, club);
    assert.equal(first.series, 1);
    const afterFirst = await repo.getSeries(T, 'idem-s');
    const second = await repo.eraseClubData(T, club);
    assert.equal(second.series, 0, 'no series re-touched on re-run');
    const afterSecond = await repo.getSeries(T, 'idem-s');
    assert.equal(afterSecond?.version, afterFirst?.version, 'series version not bumped twice');
    assert.deepEqual(afterSecond?.teams, ['foxtrot']);
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

// ─────────────── branding merge-patch (backfill-branding) + feature flags ───────────────

describe('branding merge-patch + tenant feature flags', () => {
  const T = 'brandfill';

  before(async () => {
    // A row shaped like a live pre-backfill tenant: legacy palette, admin-edited
    // support copy, a real adminCount and an active club-signup link — everything
    // the merge-patch must NOT clobber.
    await repo.putTenantConfig({
      tenant: T,
      branding: {
        name: 'Backfill Union',
        title: 'Backfill Smart Club',
        logoUrl: '/old-logo.png',
        colors: { '--green': '#1D9E75', '--navy': '#1B2A4A' },
        copy: { office: 'Backfill office', support: 'admin-edited support line' },
      },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [],
      adminCount: 3,
      clubSignupLink: { token: 'tok-123', createdAt: '2026-01-01T00:00:00Z' },
      features: { whatsappInvites: false },
    });
  });

  test('mergeBrandingPatch sets colors + new copy slots and preserves everything else', async () => {
    await repo.mergeBrandingPatch(T, {
      colors: { '--green': '#0E3529', '--navy': '#1B2A4A', '--green-mid': '#215F47' },
      copySlots: { orgShort: 'Backfill', cohortName: 'Backfill cohort' },
    });
    const cfg = await repo.getTenantConfig(T);
    assert.equal(cfg?.branding.colors['--green'], '#0E3529'); // corrected token
    assert.equal(cfg?.branding.colors['--navy'], '#1B2A4A'); // legacy token untouched
    assert.equal(cfg?.branding.colors['--green-mid'], '#215F47'); // new token added
    assert.equal(cfg?.branding.copy.orgShort, 'Backfill');
    assert.equal(cfg?.branding.copy.cohortName, 'Backfill cohort');
    // The paths outside the UpdateExpression survive verbatim.
    assert.equal(cfg?.branding.copy.support, 'admin-edited support line');
    assert.equal(cfg?.branding.copy.office, 'Backfill office');
    assert.equal(cfg?.branding.logoUrl, '/old-logo.png');
    assert.equal(cfg?.adminCount, 3);
    assert.deepEqual(cfg?.clubSignupLink, { token: 'tok-123', createdAt: '2026-01-01T00:00:00Z' });
    assert.deepEqual(cfg?.features, { whatsappInvites: false });
  });

  test('mergeBrandingPatch can set logoUrl/faviconUrl when explicitly asked', async () => {
    await repo.mergeBrandingPatch(T, { logoUrl: '/new-logo.svg', faviconUrl: '/favicon.png' });
    const cfg = await repo.getTenantConfig(T);
    assert.equal(cfg?.branding.logoUrl, '/new-logo.svg');
    assert.equal(cfg?.branding.faviconUrl, '/favicon.png');
  });

  test('an empty patch is a no-op (no write, no throw)', async () => {
    const beforeCfg = await repo.getTenantConfig(T);
    await repo.mergeBrandingPatch(T, {});
    assert.deepEqual(await repo.getTenantConfig(T), beforeCfg);
  });

  test('GET /tenant exposes the stored features map, defaulting to {}', async () => {
    const res = await app.request('/tenant', { headers: { 'x-tenant': T } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { features: Record<string, boolean> };
    assert.deepEqual(body.features, { whatsappInvites: false });

    // A tenant with no features attribute (the seeded dolphins row) → empty map.
    const dolphins = await app.request('/tenant', { headers: { 'x-tenant': 'dolphins' } });
    assert.equal(dolphins.status, 200);
    const dolphinsBody = (await dolphins.json()) as {
      features: Record<string, boolean>;
      districts: string[];
    };
    assert.deepEqual(dolphinsBody.features, {});
    // No districts field on the seeded row either → the shared defaults resolve.
    assert.deepEqual(dolphinsBody.districts, DEFAULT_DISTRICTS);
  });
});

describe('playerCount — client-clobber guard + drift reconcile', () => {
  const club = {
    id: 'countdrift',
    name: 'Countdrift CC',
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
  };
  const player = (n: string) => ({
    naturalKey: n,
    clubId: 'countdrift',
    firstName: n,
    lastName: 'Player',
    dob: '1995-01-01',
    isMinor: false,
    consentAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
  });

  before(async () => {
    await repo.createClub('dolphins', club);
    await repo.createPlayer('dolphins', player('Alpha'));
    await repo.createPlayer('dolphins', player('Bravo')); // counter now 2
  });

  test('PATCH strips a stale playerCount from the body (whole-item PUT cannot clobber it)', async () => {
    // A client re-sends the object it last loaded, including a now-stale playerCount:0.
    // Without the strip, updateClub's `{...current, ...patch}` PUT would persist 0.
    const res = await app.request('/clubs/countdrift', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ playerCount: 0, players: 0 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { players: number };
    assert.equal(body.players, 2, 'derived count survives the stale patch');
    const stored = (await repo.getClub('dolphins', 'countdrift')) as { playerCount?: number };
    assert.equal(stored.playerCount, 2, 'stored counter untouched');
  });

  test('editing a benign field cannot round-trip a stale playerCount (the real prod trigger)', async () => {
    // The production path: an admin renames the club and the client's last-loaded object
    // carries a now-stale playerCount:0 along in the same PATCH body. updateClub's whole-item
    // PUT would persist it without the strip.
    const res = await app.request('/clubs/countdrift', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ name: 'Countdrift Renamed CC', playerCount: 0 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { players: number; name: string };
    assert.equal(body.name, 'Countdrift Renamed CC');
    assert.equal(body.players, 2, 'rename must not clobber the counter');
    const stored = (await repo.getClub('dolphins', 'countdrift')) as { playerCount?: number };
    assert.equal(stored.playerCount, 2);
  });

  test('reconcilePlayerCount heals a drifted counter from the real PLAYER# rows', async () => {
    // Force drift the way the server race does: overwrite the stored counter low while the
    // two real rows remain (updateClub itself does not strip — only the route does).
    const before = await repo.getClub('dolphins', 'countdrift');
    await repo.updateClub(
      'dolphins',
      'countdrift',
      { playerCount: 0, version: before!.version },
      'test',
      new Date().toISOString(),
    );

    const result = await repo.reconcilePlayerCount('dolphins', 'countdrift');
    assert.deepEqual(result, { previous: 0, actual: 2, delta: 2 });

    const healed = (await repo.getClub('dolphins', 'countdrift')) as { playerCount?: number };
    assert.equal(healed.playerCount, 2);

    // Idempotent: a second pass is a no-op (delta 0, no write).
    const again = await repo.reconcilePlayerCount('dolphins', 'countdrift');
    assert.deepEqual(again, { previous: 2, actual: 2, delta: 0 });
  });
});

describe('GET /admin/insights/demographics', () => {
  const club = (id: string, leagues: string[]) =>
    ({
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
      ground: {},
      leagues,
      version: 1,
    }) as unknown as Parameters<typeof repo.createClub>[1];

  const player = (clubId: string, n: string, extra: Record<string, unknown>) => ({
    naturalKey: n,
    clubId,
    firstName: n,
    lastName: 'Player',
    dob: '1990-05-05',
    isMinor: false,
    consentAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
    ...extra,
  });

  before(async () => {
    // Register two demo leagues in the catalogue (merge — never clobber the
    // seeded config other suites read). Distinct keys keep the perLeague
    // assertions collision-proof against players other suites created.
    const cfg = await repo.getTenantConfig('dolphins');
    await repo.putTenantConfig({
      ...cfg!,
      leagues: [
        ...(cfg!.leagues ?? []),
        { key: 'demo-premier', label: 'Demo Premier', group: 'Seniors', district: 'Test District' },
        { key: 'demo-u13', label: 'Demo U13', group: 'Juniors', district: 'Test District' },
      ],
    });
    await repo.createClub('dolphins', club('demoa', ['demo-premier'])); // single-league
    await repo.createClub('dolphins', club('demob', ['demo-premier', 'demo-u13']));
    // demoa: declared league, single-league fallback, and an orphaned key.
    await repo.createPlayer(
      'dolphins',
      player('demoa', 'da1', { team: 'demo-premier', gender: 'Male', race: 'African' }),
    );
    await repo.createPlayer('dolphins', player('demoa', 'da2', { gender: 'Female' })); // no team → fallback
    await repo.createPlayer('dolphins', player('demoa', 'da3', { team: 'ghost-league' })); // orphaned
    // demob: same league key from a DIFFERENT club (cross-club aggregation),
    // a second league, and an ambiguous no-team row at a multi-league club.
    await repo.createPlayer(
      'dolphins',
      player('demob', 'db1', { team: 'demo-premier', gender: 'Male' }),
    );
    await repo.createPlayer(
      'dolphins',
      player('demob', 'db2', { team: 'demo-u13', dob: '2015-01-01' }),
    );
    await repo.createPlayer('dolphins', player('demob', 'db3', {}));
  });

  test('aggregates across clubs and splits per league via the attribution ladder', async () => {
    const res = await app.request('/admin/insights/demographics', { headers: headers(ADMIN) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      totalPlayers: number;
      ageGroups: Array<{ label: string; count: number }>;
      gender: Array<{ label: string; count: number }>;
      race: Array<{ label: string; count: number }>;
      perLeague: Record<
        string,
        { totalPlayers: number; gender: Array<{ label: string; count: number }> }
      >;
      unattributed: { totalPlayers: number };
    };

    // Cross-club aggregation: da1 + db1 (declared) + da2 (single-league fallback).
    const premier = body.perLeague['demo-premier'];
    assert.equal(premier.totalPlayers, 3);
    assert.deepEqual(premier.gender, [
      { label: 'Male', count: 2 },
      { label: 'Female', count: 1 },
      { label: 'Non-binary', count: 0 },
    ]);
    assert.equal(body.perLeague['demo-u13'].totalPlayers, 1);

    // da3 (orphaned key) + db3 (multi-league, no team) land in unattributed —
    // alongside every other suite's players (their clubs enter no leagues), so ≥.
    assert.ok(!('unattributed' in body.perLeague));
    assert.ok(body.unattributed.totalPlayers >= 2);

    // The cohort summary rides the top level and reconciles with the split.
    const perLeagueTotal = Object.values(body.perLeague).reduce((s, l) => s + l.totalPlayers, 0);
    assert.equal(body.totalPlayers, perLeagueTotal + body.unattributed.totalPlayers);
    assert.ok(Array.isArray(body.ageGroups) && Array.isArray(body.race));
  });

  test('rep role → 403 (the /admin/* middleware chain)', async () => {
    const res = await app.request('/admin/insights/demographics', { headers: headers(REP) });
    assert.equal(res.status, 403);
  });
});
