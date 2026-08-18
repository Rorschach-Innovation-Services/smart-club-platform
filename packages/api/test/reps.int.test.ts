/**
 * Integration tests for the operator rep-invite + committee-extract routes (self-serve
 * onboarding, ADR 0009 follow-up, plan 1.3):
 *   - GET  /platform/tenants/:slug/reps
 *   - POST /platform/tenants/:slug/reps
 *   - POST /platform/tenants/:slug/clubs/:clubId/committee-extract
 *   - POST /platform/tenants/:slug/clubs/:clubId/docs/:key/view-url
 *
 * Same harness as doc-intake.int.test.ts / roster-intake.int.test.ts: in-process dynalite
 * + the real Hono app via app.request(), auth via the LOCAL_AUTH x-dev-auth bypass
 * (which also stubs Cognito — ensurePasswordlessUser returns a deterministic
 * `local-<sha1(email)>` sub, no real pool involved), and the readUploadObject `local/` +
 * LOCAL_UPLOADS_DIR offline seam for the stored "committee list" xlsx fixtures.
 *
 * WEB_ORIGIN_MAP is set BEFORE the app is imported (origins.ts reads it once at module
 * load) so ONE tenant slug resolves a canonical web origin and a SECOND does not —
 * letting the loginUrl/`warning` test exercise both branches of resolveLoginUrl without
 * needing per-test env mutation.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { Club, RequiredDoc } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load, and
// origins.ts reads WEB_ORIGIN_MAP/WILDCARD_ENABLED once at import time.
// Port distinct from every other *.int.test.ts (next free after structure-intake's 4619).
const DDB_PORT = 4621;
const TABLE = 'SmartClubRepsTest';
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
process.env.WEB_ORIGIN_MAP = JSON.stringify({ repscanonical: 'https://repscanonical.example.org' });

const devAuthAs = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const OPERATOR = devAuthAs('op-1', 'operator@platform', [
  { tenantId: '*', role: 'operator', clubIds: [] },
]);
const platformHeaders = (auth: string) => ({
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

// Two tenants: one with a canonical web origin configured (WEB_ORIGIN_MAP above), one
// without — the dormant case that must surface `warning` rather than shipping the
// request Origin silently.
const CANONICAL_TENANT = 'repscanonical';
const DORMANT_TENANT = 'repsdormant';
const NOROLE_TENANT = 'repsnorole';

const CATALOGUE: RequiredDoc[] = [
  { key: 'member-db', name: 'Member database', role: 'memberDatabase' },
  { key: 'committee-list', name: 'Committee list', role: 'committee' },
];
const NOROLE_CATALOGUE: RequiredDoc[] = [{ key: 'committee-list', name: 'Committee list' }];

const baseClub = (id: string, docMeta?: Record<string, unknown>): Club =>
  ({
    id,
    name: id,
    district: 'Test District',
    sub: '',
    chair: 'Chair',
    affiliation: 'not_started',
    cqi: 0,
    docs: {},
    docMeta: docMeta ?? {},
    players: 0,
    teams: 0,
    women: 0,
    juniors: 0,
    color: '#123456',
    ground: {},
    leagues: [],
    version: 1,
  }) as Club;

let uploadsDir: string;
let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');

async function writeXlsx(
  relPath: string,
  build: (wb: ExcelJS.Workbook) => void,
): Promise<{ objectKey: string; size: number }> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  const abs = path.join(uploadsDir, relPath);
  const { mkdir, stat } = await import('node:fs/promises');
  await mkdir(path.dirname(abs), { recursive: true });
  await wb.xlsx.writeFile(abs);
  const { size } = await stat(abs);
  return { objectKey: `local/${relPath}`, size };
}

before(async () => {
  uploadsDir = await mkdtemp(path.join(tmpdir(), 'reps-test-'));
  process.env.LOCAL_UPLOADS_DIR = uploadsDir;

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

  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');

  for (const [tenant, requiredDocs] of [
    [CANONICAL_TENANT, CATALOGUE],
    [DORMANT_TENANT, CATALOGUE],
    [NOROLE_TENANT, NOROLE_CATALOGUE],
  ] as const) {
    await repo.putTenantConfig({
      tenant,
      branding: { name: `${tenant} Union`, title: tenant, logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [],
      districts: ['Test District'],
      requiredDocs,
    });
  }

  await repo.createClub(CANONICAL_TENANT, baseClub('clubA'));
  await repo.createClub(CANONICAL_TENANT, baseClub('clubB'));
  await repo.createClub(DORMANT_TENANT, baseClub('clubC'));
  await repo.createClub(NOROLE_TENANT, baseClub('clubnorole'));

  // ── Committee xlsx fixture: a chair (high), a vice-chair (medium), a treasurer with
  //    an email but no matching role keyword (low), and a secretary with neither — the
  //    last is not a candidate at all. ──
  const committeeFile = await writeXlsx('committee/list.xlsx', (wb) => {
    const ws = wb.addWorksheet('Committee');
    ws.addRow(['Name', 'Role', 'Email', 'Cell']);
    ws.addRow(['Nomsa Dlamini', 'Chairperson', 'nomsa@example.org', '0821234567']);
    ws.addRow(['Sipho Khumalo', 'Vice Chair', '', '0839876543']);
    ws.addRow(['Anele Mokoena', 'Treasurer', 'anele@example.org', '']);
    ws.addRow(['Thabo Nkosi', 'Secretary', '', '']);
  });
  await repo.createClub(
    CANONICAL_TENANT,
    baseClub('clubcommittee', {
      'committee-list': {
        objectKey: committeeFile.objectKey,
        size: committeeFile.size,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    }),
  );
  await repo.createClub(
    CANONICAL_TENANT,
    baseClub('clubcommitteepdf', {
      'committee-list': {
        objectKey: 'local/notreal.pdf',
        size: 100,
        contentType: 'application/pdf',
      },
    }),
  );
  await repo.createClub(CANONICAL_TENANT, baseClub('clubcommitteenofile'));
  await repo.createClub(
    CANONICAL_TENANT,
    baseClub('clubviewurl', {
      'committee-list': {
        objectKey: committeeFile.objectKey,
        size: committeeFile.size,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    }),
  );
});

after(async () => {
  await new Promise<void>((resolve) => ddbServer.close(() => resolve()));
  await rm(uploadsDir, { recursive: true, force: true });
});

describe('GET /platform/tenants/:slug/reps', () => {
  test('includes zero-rep clubs in coverage, and 404s an unknown tenant', async () => {
    const res = await app.request(`/platform/tenants/${CANONICAL_TENANT}/reps`, {
      headers: platformHeaders(OPERATOR),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      reps: Array<{ sub: string; email: string; clubIds: string[]; status: string }>;
      coverage: Array<{ clubId: string; repCount: number }>;
    };
    assert.ok(body.coverage.some((c) => c.clubId === 'clubA' && c.repCount === 0));

    const notFound = await app.request('/platform/tenants/noSuchTenant/reps', {
      headers: platformHeaders(OPERATOR),
    });
    assert.equal(notFound.status, 404);
  });
});

describe('POST /platform/tenants/:slug/reps', () => {
  test('unknown clubId → 400', async () => {
    const res = await app.request(`/platform/tenants/${CANONICAL_TENANT}/reps`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ email: 'rep1@example.org', clubIds: ['noSuchClub'] }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? '', /unknown club/);
  });

  test('no clubIds → 400', async () => {
    const res = await app.request(`/platform/tenants/${CANONICAL_TENANT}/reps`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ email: 'rep2@example.org', clubIds: [] }),
    });
    assert.equal(res.status, 400);
  });

  test('loginUrl is the tenant-canonical origin when one is configured — no warning', async () => {
    const res = await app.request(`/platform/tenants/${CANONICAL_TENANT}/reps`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ email: 'canonical-rep@example.org', clubIds: ['clubA'] }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      sub: string;
      email: string;
      loginUrl: string;
      warning?: string;
    };
    assert.equal(body.loginUrl, 'https://repscanonical.example.org');
    assert.equal(body.warning, undefined);

    const stored = await repo.getUser(body.sub);
    const membership = stored?.memberships.find((m) => m.tenantId === CANONICAL_TENANT);
    assert.equal(membership?.role, 'rep');
    assert.deepEqual(membership?.clubIds, ['clubA']);
  });

  test('dormant tenant (no canonical origin, no explicit link) → warning field present', async () => {
    const res = await app.request(`/platform/tenants/${DORMANT_TENANT}/reps`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ email: 'dormant-rep@example.org', clubIds: ['clubC'] }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { loginUrl: string; warning?: string };
    assert.ok(
      body.warning,
      'a dormant tenant surfaces the fallback instead of shipping it silently',
    );
    assert.match(body.warning!, /no canonical domain/);
  });

  test('explicit link suppresses the warning even on a dormant tenant', async () => {
    const res = await app.request(`/platform/tenants/${DORMANT_TENANT}/reps`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        email: 'dormant-rep-2@example.org',
        clubIds: ['clubC'],
        link: 'http://localhost:5173/some-path',
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { loginUrl: string; warning?: string };
    assert.equal(body.warning, undefined);
    assert.equal(body.loginUrl, 'http://localhost:5173/some-path');
  });

  test('existing ADMIN membership → 409, never a silent demote', async () => {
    const invite = await app.request(`/platform/tenants/${CANONICAL_TENANT}/reps`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ email: 'promoted-admin@example.org', clubIds: ['clubA'] }),
    });
    assert.equal(invite.status, 201);
    const { sub } = (await invite.json()) as { sub: string };

    // Simulate this user already being a tenant admin (e.g. granted via Team & Access).
    const profile = await repo.getUser(sub);
    const others = (profile?.memberships ?? []).filter((m) => m.tenantId !== CANONICAL_TENANT);
    await repo.putUser({
      sub,
      email: 'promoted-admin@example.org',
      memberships: [...others, { tenantId: CANONICAL_TENANT, role: 'admin', clubIds: [] }],
      onboardingSeen: profile?.onboardingSeen ?? {},
    });

    const res = await app.request(`/platform/tenants/${CANONICAL_TENANT}/reps`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ email: 'promoted-admin@example.org', clubIds: ['clubB'] }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? '', /Team & Access/);

    // Never silently demoted — still an admin with the ORIGINAL (empty) clubIds.
    const after = await repo.getUser(sub);
    const membership = after?.memberships.find((m) => m.tenantId === CANONICAL_TENANT);
    assert.equal(membership?.role, 'admin');
    assert.deepEqual(membership?.clubIds, []);
  });

  test('404 for an unknown tenant', async () => {
    const res = await app.request('/platform/tenants/noSuchTenant/reps', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ email: 'x@example.org', clubIds: ['clubA'] }),
    });
    assert.equal(res.status, 404);
  });
});

describe('POST /platform/tenants/:slug/clubs/:clubId/committee-extract', () => {
  test('role-unassigned catalogue → 409 with role-assignment guidance', async () => {
    const res = await app.request(
      `/platform/tenants/${NOROLE_TENANT}/clubs/clubnorole/committee-extract`,
      { method: 'POST', headers: platformHeaders(OPERATOR) },
    );
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? '', /assign the role in Required documents/);
  });

  test('club with no stored file → 409', async () => {
    const res = await app.request(
      `/platform/tenants/${CANONICAL_TENANT}/clubs/clubcommitteenofile/committee-extract`,
      { method: 'POST', headers: platformHeaders(OPERATOR) },
    );
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? '', /upload it via document intake first/);
  });

  test('PDF committee doc → 200 {status:"unparseable"}, never invites, no-store', async () => {
    const res = await app.request(
      `/platform/tenants/${CANONICAL_TENANT}/clubs/clubcommitteepdf/committee-extract`,
      { method: 'POST', headers: platformHeaders(OPERATOR) },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = (await res.json()) as { status: string; reason?: string };
    assert.equal(body.status, 'unparseable');
    assert.ok(body.reason);
  });

  test('xlsx committee doc extracts scored candidates', async () => {
    const res = await app.request(
      `/platform/tenants/${CANONICAL_TENANT}/clubs/clubcommittee/committee-extract`,
      { method: 'POST', headers: platformHeaders(OPERATOR) },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = (await res.json()) as {
      status: string;
      candidates: Array<{
        name: string;
        role: string;
        email?: string;
        cell?: string;
        confidence: string;
        sheet: string;
        rowNumber: number;
      }>;
    };
    assert.equal(body.status, 'ok');
    // Secretary (no role match, no email) never becomes a candidate at all.
    assert.equal(body.candidates.length, 3);
    const byName = Object.fromEntries(body.candidates.map((c) => [c.name, c]));
    assert.equal(byName['Nomsa Dlamini'].confidence, 'high');
    assert.equal(byName['Nomsa Dlamini'].email, 'nomsa@example.org');
    assert.equal(byName['Sipho Khumalo'].confidence, 'medium');
    assert.equal(byName['Anele Mokoena'].confidence, 'low');
    assert.ok(!('Thabo Nkosi' in byName));
  });

  test('404 for an unknown tenant / unknown club', async () => {
    const noTenant = await app.request(
      '/platform/tenants/noSuchTenant/clubs/clubcommittee/committee-extract',
      { method: 'POST', headers: platformHeaders(OPERATOR) },
    );
    assert.equal(noTenant.status, 404);
    const noClub = await app.request(
      `/platform/tenants/${CANONICAL_TENANT}/clubs/noSuchClub/committee-extract`,
      { method: 'POST', headers: platformHeaders(OPERATOR) },
    );
    assert.equal(noClub.status, 404);
  });
});

describe('POST /platform/tenants/:slug/clubs/:clubId/docs/:key/view-url', () => {
  test('unknown document key → 400', async () => {
    const res = await app.request(
      `/platform/tenants/${CANONICAL_TENANT}/clubs/clubviewurl/docs/not-a-real-key/view-url`,
      { method: 'POST', headers: platformHeaders(OPERATOR), body: JSON.stringify({}) },
    );
    assert.equal(res.status, 400);
  });

  test('catalogue key with nothing on record → 404 (on-record gate)', async () => {
    const res = await app.request(
      `/platform/tenants/${CANONICAL_TENANT}/clubs/clubcommitteenofile/docs/committee-list/view-url`,
      { method: 'POST', headers: platformHeaders(OPERATOR), body: JSON.stringify({}) },
    );
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? '', /no file on record/);
  });

  test('a requested objectKey not matching the stored one → 404', async () => {
    const res = await app.request(
      `/platform/tenants/${CANONICAL_TENANT}/clubs/clubviewurl/docs/committee-list/view-url`,
      {
        method: 'POST',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({ objectKey: 'local/committee/some-other-file.xlsx' }),
      },
    );
    assert.equal(res.status, 404);
  });

  test('on-record file → 200 {viewUrl}', async () => {
    const res = await app.request(
      `/platform/tenants/${CANONICAL_TENANT}/clubs/clubviewurl/docs/committee-list/view-url`,
      { method: 'POST', headers: platformHeaders(OPERATOR), body: JSON.stringify({}) },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { viewUrl: string };
    assert.ok(body.viewUrl.length > 0);
  });

  test('404 for an unknown tenant / unknown club', async () => {
    const noTenant = await app.request(
      '/platform/tenants/noSuchTenant/clubs/clubviewurl/docs/committee-list/view-url',
      { method: 'POST', headers: platformHeaders(OPERATOR), body: JSON.stringify({}) },
    );
    assert.equal(noTenant.status, 404);
    const noClub = await app.request(
      `/platform/tenants/${CANONICAL_TENANT}/clubs/noSuchClub/docs/committee-list/view-url`,
      { method: 'POST', headers: platformHeaders(OPERATOR), body: JSON.stringify({}) },
    );
    assert.equal(noClub.status, 404);
  });
});
