/**
 * Integration tests for the scorer merge (POST /scorers/:id/merge). Register basics
 * (create/patch/name clash/role gate) are covered in match-week-office.int.test.ts.
 *
 * Same harness as umpires.int.test.ts: in-process dynalite + the REAL Hono app via
 * app.request(); dev-auth bypass (LOCAL_AUTH=1) as a tenant ADMIN.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Series } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4801; // unique
const TABLE = 'SmartClubScorersTest';
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

const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
const ADMIN = devAuth('admin@test', [{ tenantId: 'dolphins', role: 'admin', clubIds: [] }]);
const headers = (auth: string) => ({
  'x-tenant': 'dolphins',
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

const series = (id: string): Series =>
  ({
    id,
    name: `Series ${id}`,
    leagueKey: 'premier',
    startDate: '2026-10-04',
    teams: ['home-club', 'away-club', 'other-club'],
    participants: [
      { teamId: 'home-club', clubId: 'home-club', name: 'Home Club' },
      { teamId: 'away-club', clubId: 'away-club', name: 'Away Club' },
      { teamId: 'other-club', clubId: 'other-club', name: 'Other Club' },
    ],
    fixtures: [
      {
        id: 'f1',
        round: 1,
        date: '2026-10-04',
        time: '09:00',
        home: 'home-club',
        away: 'away-club',
      },
      {
        id: 'f2',
        round: 1,
        date: '2026-10-04',
        time: '09:00',
        home: 'away-club',
        away: 'other-club',
      },
    ],
    kind: 'series',
    approved: true,
    approvedAt: '2026-09-01T00:00:00.000Z',
    released: false,
    releasedAt: null,
    version: 3,
  }) as Series;

const call = (method: string, path: string, body?: unknown, auth = ADMIN) =>
  app.request(path, {
    method,
    headers: headers(auth),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const createScorer = async (displayName: string) => {
  const res = await call('POST', '/scorers', { displayName });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { id: string }).id;
};

const createUmpire = async (displayName: string) => {
  const res = await call('POST', '/umpires', { displayName });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { id: string }).id;
};

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

  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');
});

after(() => new Promise<void>((resolve) => ddbServer.close(() => resolve())));

describe('scorer merge', () => {
  test('re-points every appointment, collapses a doubled fixture and retires the source', async () => {
    await repo.putSeries('dolphins', series('sc-merge'));
    const target = await createScorer('L.Naidoo');
    const dup = await createScorer('Lionel Naidoo');
    const other = await createScorer('K.Pillay');
    // f1: the duplicate is the scorer and the real entry the backup — one person, twice.
    const p1 = await call('PUT', '/series/sc-merge/fixtures/f1/officials', {
      scorers: [dup, target],
    });
    assert.equal(p1.status, 200, await p1.clone().text());
    // f2: the duplicate is the backup.
    await call('PUT', '/series/sc-merge/fixtures/f2/officials', { scorers: [other, dup] });

    const res = await call('POST', `/scorers/${dup}/merge`, { targetId: target });
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as {
      repointed: number;
      source: { active: boolean; mergedInto: string };
    };
    assert.equal(body.repointed, 2);
    assert.equal(body.source.active, false);
    assert.equal(body.source.mergedInto, target);

    const f1 = await repo.getFixtureOfficials('dolphins', 'sc-merge', 'f1');
    assert.deepEqual(f1!.scorers, [{ scorerId: target, name: 'L.Naidoo' }]);
    const f2 = await repo.getFixtureOfficials('dolphins', 'sc-merge', 'f2');
    assert.deepEqual(
      f2!.scorers?.map((x) => x.scorerId),
      [other, target],
    );
    const stored = await repo.getScorer('dolphins', dup);
    assert.equal(stored?.mergedInto, target);
    assert.equal(stored?.active, false);

    // A re-merge (stale page, double-click) is refused and names where it went.
    const again = await call('POST', `/scorers/${dup}/merge`, { targetId: other });
    assert.equal(again.status, 409);
    const refused = (await again.json()) as { code: string; mergedIntoName: string };
    assert.equal(refused.code, 'scorer_already_merged');
    assert.equal(refused.mergedIntoName, 'L.Naidoo');
    // A merged entry can't come back.
    assert.equal((await call('PATCH', `/scorers/${dup}`, { active: true })).status, 409);
  });

  test('refuses a bad request', async () => {
    const a = await createScorer('Bad A');
    const b = await createScorer('Bad B');
    assert.equal((await call('POST', `/scorers/${a}/merge`, {})).status, 400);
    assert.equal((await call('POST', `/scorers/${a}/merge`, { targetId: a })).status, 400);
    assert.equal((await call('POST', '/scorers/s-nobody/merge', { targetId: a })).status, 404);
    assert.equal((await call('POST', `/scorers/${a}/merge`, { targetId: 's-nobody' })).status, 404);
    await call('PATCH', `/scorers/${b}`, { active: false });
    assert.equal((await call('POST', `/scorers/${a}/merge`, { targetId: b })).status, 409);
  });

  test('merge preserves umpires and referee', async () => {
    await repo.putSeries('dolphins', series('sc-keep'));
    const target = await createScorer('N.Zulu');
    const dup = await createScorer('Nandi Zulu');
    const ump = await createUmpire('A.Ngubane');
    const ref = await createUmpire('R.Moodley');
    const put = await call('PUT', '/series/sc-keep/fixtures/f1/officials', {
      umpires: [ump],
      referee: { umpireId: ref },
      scorers: [dup],
    });
    assert.equal(put.status, 200, await put.clone().text());

    const res = await call('POST', `/scorers/${dup}/merge`, { targetId: target });
    assert.equal(res.status, 200, await res.clone().text());

    const f1 = await repo.getFixtureOfficials('dolphins', 'sc-keep', 'f1');
    assert.deepEqual(
      f1!.umpires.map((u) => u.umpireId),
      [ump],
    );
    assert.equal(f1!.referee?.umpireId, ref);
    assert.deepEqual(
      f1!.scorers?.map((x) => x.scorerId),
      [target],
    );
    assert.equal(f1!.updatedBy, 'admin@test');
  });
});
