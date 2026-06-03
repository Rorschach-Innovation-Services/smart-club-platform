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
