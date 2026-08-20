/**
 * Integration tests for the dev-only local upload sink (self-serve onboarding):
 *   - POST /platform/tenants/:slug/doc-intake/presign mints a /local-uploads/ URL
 *     instead of an S3 presigned PUT when isLocalUploadsMode() is true
 *   - PUT /local-uploads/local/* then GET /local-uploads/local/* round-trips bytes
 *   - path traversal (`..`) and disallowed characters are rejected before touching disk
 *   - POST /platform/tenants/:slug/roster-intake/parse succeeds against a workbook
 *     committed through the real PUT route (not written to disk directly)
 *   - POST /platform/tenants/:slug/clubs/:clubId/docs/:key/view-url (and its tenant-side
 *     twin) return a /local-uploads/ URL for a `local/`-prefixed stored key
 *
 * Same harness as doc-intake.int.test.ts / roster-intake.int.test.ts: in-process
 * dynalite + the real Hono app via app.request(), auth via the LOCAL_AUTH x-dev-auth
 * bypass. Unlike doc-intake.int.test.ts, this file ALSO sets LOCAL_UPLOADS_DIR (the
 * seam that flips isLocalUploadsMode() on) — every other *.int.test.ts leaves it unset
 * so they keep exercising the S3 presign path unchanged.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { Club, RequiredDoc } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
// Port distinct from every other *.int.test.ts (see roster-intake.int.test.ts's
// registry; next free after 4621 is 4623).
const DDB_PORT = 4623;
const TABLE = 'SmartClubLocalUploadsTest';
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

const devAuthAs = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const OPERATOR = devAuthAs('op-1', 'operator@platform', [
  { tenantId: '*', role: 'operator', clubIds: [] },
]);
const platformHeaders = (auth: string) => ({
  'x-dev-auth': auth,
  'content-type': 'application/json',
});
const REP = devAuthAs('rep-1', 'rep@club', [
  { tenantId: 'localuploads', role: 'rep', clubIds: ['clubalpha', 'clubrepview'] },
]);
const repHeaders = (auth: string) => ({
  'x-dev-auth': auth,
  'x-tenant': TENANT,
  'content-type': 'application/json',
});

const TENANT = 'localuploads';

const CATALOGUE: RequiredDoc[] = [
  { key: 'constitution', name: 'Constitution' },
  { key: 'member-db', name: 'Member database', role: 'memberDatabase', accepts: ['xlsx'] },
];

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

before(async () => {
  uploadsDir = await mkdtemp(path.join(tmpdir(), 'local-uploads-test-'));
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

  await repo.putTenantConfig({
    tenant: TENANT,
    branding: {
      name: 'Local Uploads Union',
      title: 'Local Uploads',
      logoUrl: '',
      colors: {},
      copy: {},
    },
    submissionDeadline: '2026-12-31',
    knownClubs: [],
    leagues: [],
    districts: ['Test District'],
    requiredDocs: CATALOGUE,
  });
  await repo.createClub(TENANT, baseClub('clubalpha'));
});

after(async () => {
  await new Promise<void>((resolve) => ddbServer.close(() => resolve()));
  await rm(uploadsDir, { recursive: true, force: true });
});

describe('POST /platform/tenants/:slug/doc-intake/presign — local mode', () => {
  test('mints a /local-uploads/ URL with a local/-prefixed objectKey instead of an S3 presign', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/doc-intake/presign`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          {
            clubId: 'clubalpha',
            docKey: 'constitution',
            contentType: 'application/pdf',
            size: 100,
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      items: Array<{ ok: boolean; uploadUrl?: string; objectKey?: string }>;
    };
    const item = body.items[0];
    assert.equal(item.ok, true);
    assert.ok(item.objectKey!.startsWith('local/'));
    assert.ok(item.uploadUrl!.includes(`/local-uploads/${item.objectKey}`));
  });
});

describe('PUT/GET /local-uploads/local/* — local mode', () => {
  test('PUT then GET round-trips the exact bytes, and the file lands on disk under LOCAL_UPLOADS_DIR', async () => {
    const objectKey = `local/${TENANT}/clubalpha/roundtrip-${Date.now()}.pdf`;
    const bytes = Buffer.from('%PDF-1.4 fake pdf bytes for round-trip test');

    const putRes = await app.request(`/local-uploads/${objectKey}`, {
      method: 'PUT',
      body: bytes,
    });
    assert.equal(putRes.status, 200);
    assert.deepEqual(await putRes.json(), { ok: true });

    const onDisk = await readFile(path.join(uploadsDir, objectKey.slice('local/'.length)));
    assert.deepEqual(onDisk, bytes);

    const getRes = await app.request(`/local-uploads/${objectKey}?ct=application/pdf`, {
      method: 'GET',
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get('content-type'), 'application/pdf');
    assert.equal(getRes.headers.get('content-disposition'), 'inline');
    const got = Buffer.from(await getRes.arrayBuffer());
    assert.deepEqual(got, bytes);
  });

  test('GET without a stored file → 404', async () => {
    const res = await app.request(`/local-uploads/local/${TENANT}/clubalpha/does-not-exist.pdf`, {
      method: 'GET',
    });
    assert.equal(res.status, 404);
  });

  test('path traversal (`..`) is rejected before touching the filesystem, on both PUT and GET', async () => {
    // A literal (unencoded) ".." would be collapsed by URL dot-segment normalization
    // before this even reaches the route — WHATWG URL removes dot-segments by splitting
    // on literal, unencoded "/" only. Encoding just the slashes (%2f) keeps the ".."
    // literal in the path so it survives normalization and reaches the handler intact —
    // the actual case our own regex check (not the URL parser) has to catch.
    const traversal = `local/${TENANT}/..%2f..%2fetc%2fpasswd`;
    const putRes = await app.request(`/local-uploads/${traversal}`, {
      method: 'PUT',
      body: Buffer.from('nope'),
    });
    assert.equal(putRes.status, 400);

    const getRes = await app.request(`/local-uploads/${traversal}`, { method: 'GET' });
    assert.equal(getRes.status, 400);
  });

  test('a literal ".." segment is stripped by URL normalization before it ever reaches the route — never 200s', async () => {
    const traversal = `local/${TENANT}/../../etc/passwd`;
    const res = await app.request(`/local-uploads/${traversal}`, {
      method: 'PUT',
      body: Buffer.from('nope'),
    });
    assert.notEqual(res.status, 200);
  });

  test('a disallowed character in the path is rejected', async () => {
    const res = await app.request(`/local-uploads/local/${TENANT}/clubalpha/weird%00name.pdf`, {
      method: 'PUT',
      body: Buffer.from('nope'),
    });
    assert.equal(res.status, 400);
  });
});

describe('POST .../roster-intake/parse against a workbook committed through the local sink', () => {
  test('parses a member-database xlsx uploaded via the real PUT route (not written to disk directly)', async () => {
    // Mint the objectKey exactly like the operator UI would: presign, then PUT bytes to
    // the returned uploadUrl's path.
    const presignRes = await app.request(`/platform/tenants/${TENANT}/doc-intake/presign`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          {
            clubId: 'clubalpha',
            docKey: 'member-db',
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: 1,
          },
        ],
      }),
    });
    const presignBody = (await presignRes.json()) as {
      items: Array<{ ok: boolean; uploadUrl: string; objectKey: string }>;
    };
    const { uploadUrl, objectKey } = presignBody.items[0];

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Seniors');
    ws.addRow(['First Name', 'Last Name', 'Date of Birth', 'Gender']);
    ws.addRow(['Pat', 'Parsed', '1995-06-01', 'Female']);
    const xlsxBuffer = Buffer.from(await wb.xlsx.writeBuffer());

    const uploadPath = new URL(uploadUrl).pathname;
    const putRes = await app.request(uploadPath, { method: 'PUT', body: xlsxBuffer });
    assert.equal(putRes.status, 200);

    // Commit the objectKey onto the club's docMeta the way doc-intake/commit would —
    // exercised end-to-end via the real commit route.
    const commitRes = await app.request(`/platform/tenants/${TENANT}/doc-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          {
            clubId: 'clubalpha',
            docKey: 'member-db',
            objectKey,
            size: xlsxBuffer.length,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          },
        ],
      }),
    });
    assert.equal(commitRes.status, 200, await commitRes.text());

    const parseRes = await app.request(`/platform/tenants/${TENANT}/roster-intake/parse`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ clubId: 'clubalpha', allowMissingId: true }),
    });
    assert.equal(parseRes.status, 200);
    const parseBody = (await parseRes.json()) as {
      parseable: boolean;
      sheets: Array<{ rows: Array<{ firstName: string }> }>;
    };
    assert.equal(parseBody.parseable, true);
    assert.equal(parseBody.sheets[0].rows[0].firstName, 'Pat');
  });
});

describe('view-url routes — local mode', () => {
  test('platform twin returns a /local-uploads/ URL for a local/-prefixed stored key', async () => {
    const objectKey = `local/${TENANT}/clubalpha/constitution-viewtest.pdf`;
    await app.request(`/local-uploads/${objectKey}`, {
      method: 'PUT',
      body: Buffer.from('%PDF-1.4 view-url test'),
    });
    await repo.createClub(
      TENANT,
      baseClub('clubviewurl', {
        constitution: { objectKey, size: 10, contentType: 'application/pdf' },
      }),
    );

    const res = await app.request(
      `/platform/tenants/${TENANT}/clubs/clubviewurl/docs/constitution/view-url`,
      {
        method: 'POST',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({ objectKey }),
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { viewUrl: string };
    assert.ok(body.viewUrl.includes(`/local-uploads/${objectKey}`));
  });

  test('tenant-side twin returns a /local-uploads/ URL for a local/-prefixed stored key', async () => {
    const objectKey = `local/${TENANT}/clubrepview/constitution-repview.pdf`;
    await app.request(`/local-uploads/${objectKey}`, {
      method: 'PUT',
      body: Buffer.from('%PDF-1.4 rep view-url test'),
    });
    await repo.createClub(
      TENANT,
      baseClub('clubrepview', {
        constitution: { objectKey, size: 10, contentType: 'application/pdf' },
      }),
    );

    const res = await app.request(`/clubs/clubrepview/docs/constitution/view-url`, {
      method: 'POST',
      headers: repHeaders(REP),
      body: JSON.stringify({ objectKey }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { viewUrl: string };
    assert.ok(body.viewUrl.includes(`/local-uploads/${objectKey}`));
  });
});
