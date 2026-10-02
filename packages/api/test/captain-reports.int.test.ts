/**
 * Integration tests for captain's post-match reports: a club submits and lists its own,
 * the union admin lists every club's, other clubs are refused, bad bodies are rejected,
 * and club erasure removes a club's reports. Boots an in-process dynalite and drives the
 * REAL Hono app.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { CaptainReport } from '../src/types.js';

const DDB_PORT = 4661; // next free even port after the highest in use (4659)
const TABLE = 'SmartClubTest';
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

const devAuth = (memberships: unknown, email = 'rep@test') =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
const ADMIN = devAuth([{ tenantId: 'dolphins', role: 'admin', clubIds: [] }], 'admin@test');
const REP_A = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['alpha'] }], 'a@test');
const REP_B = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['beta'] }], 'b@test');

const headers = (auth: string) => ({
  'x-tenant': 'dolphins',
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');

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
  color: '#123456',
  ground: {},
  leagues: [],
  version: 1,
});

const ratings = (v: number) => ({
  decisions: v,
  pressure: v,
  behaviour: v,
  communication: v,
  regulations: v,
});

const body = (over: Record<string, unknown> = {}) => ({
  date: '2026-09-27',
  side: 'Home',
  opponent: 'Beta CC',
  competition: 'Division 1',
  venue: 'Alpha Oval',
  captain: 'Sam Captain',
  fixtureKey: 's1:f1',
  umpires: [
    { name: 'Umpire One', ratings: ratings(4), concerns: ['lbw', 'bogus'], comments: 'Solid.' },
    { name: 'Umpire Two', ratings: ratings(2), concerns: [] },
  ],
  general: 'Good game.',
  ...over,
});

const post = (club: string, auth: string, b: unknown) =>
  app.request(`/clubs/${club}/captain-reports`, {
    method: 'POST',
    headers: headers(auth),
    body: JSON.stringify(b),
  });

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
  await repo.createClub('dolphins', mkClub('alpha', 'Alpha CC'));
  await repo.createClub('dolphins', mkClub('beta', 'Beta CC'));
});

after(() => {
  ddbServer?.close();
});

describe("captain's reports", () => {
  test('a club submits a report; server stamps club, author, ref and time', async () => {
    const res = await post('alpha', REP_A, body());
    assert.equal(res.status, 201);
    const r = (await res.json()) as CaptainReport;
    assert.equal(r.clubId, 'alpha');
    assert.equal(r.clubName, 'Alpha CC');
    assert.equal(r.submittedBy, 'a@test');
    assert.match(r.ref, /^CR-2026-[0-9A-F]{6}$/);
    assert.deepEqual(r.umpires[0].concerns, ['lbw'], 'unknown concern keys are dropped');
    assert.equal(r.umpires[1].ratings.decisions, 2);
  });

  test('a club lists only its own reports; the admin lists every club', async () => {
    const b = await post('beta', REP_B, body({ opponent: 'Alpha CC', side: 'Away' }));
    assert.equal(b.status, 201);
    const mine = (await (
      await app.request('/clubs/alpha/captain-reports', { headers: headers(REP_A) })
    ).json()) as CaptainReport[];
    assert.equal(mine.length, 1);
    assert.ok(mine.every((r: { clubId: string }) => r.clubId === 'alpha'));
    const all = (await (
      await app.request('/admin/captain-reports', { headers: headers(ADMIN) })
    ).json()) as CaptainReport[];
    assert.deepEqual(all.map((r: { clubId: string }) => r.clubId).sort(), ['alpha', 'beta']);
  });

  test("another club's rep can neither submit for nor read a club's reports", async () => {
    assert.equal((await post('alpha', REP_B, body())).status, 403);
    const res = await app.request('/clubs/alpha/captain-reports', { headers: headers(REP_B) });
    assert.equal(res.status, 403);
  });

  test('a rep cannot use the admin listing', async () => {
    const res = await app.request('/admin/captain-reports', { headers: headers(REP_A) });
    assert.equal(res.status, 403);
  });

  test('rejects incomplete or malformed reports', async () => {
    const bad = [
      body({ captain: '' }),
      body({ date: '27/09/2026' }),
      body({ side: 'Neutral' }),
      body({ umpires: [body().umpires[0]] }),
      body({ umpires: [{ ...body().umpires[0], ratings: ratings(6) }, body().umpires[1]] }),
      body({ umpires: [{ ...body().umpires[0], name: '' }, body().umpires[1]] }),
    ];
    for (const b of bad) assert.equal((await post('alpha', REP_A, b)).status, 400);
  });

  test("club erasure removes that club's reports", async () => {
    const club = await repo.getClub('dolphins', 'beta');
    await repo.eraseClubData('dolphins', club!);
    assert.equal((await repo.listCaptainReportsForClub('dolphins', 'beta')).length, 0);
    const all = await repo.listAllCaptainReports('dolphins');
    assert.deepEqual(
      all.map((r) => r.clubId),
      ['alpha'],
    );
  });
});
