/**
 * Offline-dev degrade path for the tutorial-upload presign route: with no
 * TUTORIALS_BUCKET configured (local dev without cloud assets), the route must
 * 501 with a clear message instead of presigning against an empty bucket.
 *
 * Own file because index.ts reads TUTORIALS_BUCKET at module load — the main
 * platform suite needs it SET, this suite needs it EMPTY. Mirrors
 * platform-logo-offline.int.test.ts.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

// Env must be set BEFORE importing repo/app (module-load reads).
const DDB_PORT = 4604; // distinct from api.int (4599), platform.int (4601), logo-offline (4603)
const TABLE = 'SmartClubTutorialOfflineTest';
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.LOCAL_AUTH = '1';
process.env.STAGE = 'local';
process.env.USER_POOL_ID = 'test-pool';
process.env.AWS_REGION ??= 'localhost';
process.env.UPLOADS_BUCKET = 'test-uploads';
process.env.TUTORIALS_BUCKET = ''; // the point of this suite
process.env.TUTORIALS_BASE_URL = '';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_MAX_ATTEMPTS = '1';

const OPERATOR = Buffer.from(
  JSON.stringify({
    sub: 'op-1',
    email: 'operator@platform',
    memberships: [{ tenantId: '*', role: 'operator', clubIds: [] }],
  }),
).toString('base64');

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];

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
});

after(() => {
  ddbServer?.close();
});

describe('POST /platform/tenants/:slug/tutorial-upload without TUTORIALS_BUCKET', () => {
  test('→ 501 with a clear offline-dev message', async () => {
    const res = await app.request('/platform/tenants/dolphins/tutorial-upload', {
      method: 'POST',
      headers: { 'x-dev-auth': OPERATOR, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'poster', contentType: 'image/jpeg', sizeBytes: 1024 }),
    });
    assert.equal(res.status, 501);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /cloud assets bucket/);
  });

  test('unknown tenant still wins → 404, bad shape still wins → 400 (before the 501)', async () => {
    const missing = await app.request('/platform/tenants/ghost/tutorial-upload', {
      method: 'POST',
      headers: { 'x-dev-auth': OPERATOR, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'poster', contentType: 'image/jpeg', sizeBytes: 1024 }),
    });
    assert.equal(missing.status, 404);

    const badKind = await app.request('/platform/tenants/dolphins/tutorial-upload', {
      method: 'POST',
      headers: { 'x-dev-auth': OPERATOR, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'bogus', contentType: 'image/jpeg', sizeBytes: 1024 }),
    });
    assert.equal(badKind.status, 400);

    const badType = await app.request('/platform/tenants/dolphins/tutorial-upload', {
      method: 'POST',
      headers: { 'x-dev-auth': OPERATOR, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'poster', contentType: 'image/gif', sizeBytes: 1024 }),
    });
    assert.equal(badType.status, 400);

    const badSize = await app.request('/platform/tenants/dolphins/tutorial-upload', {
      method: 'POST',
      headers: { 'x-dev-auth': OPERATOR, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'poster', contentType: 'image/jpeg', sizeBytes: -1 }),
    });
    assert.equal(badSize.status, 400);
  });
});
