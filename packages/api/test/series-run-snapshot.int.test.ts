/**
 * Integration tests for the series schedule guard on a season-run series.
 *
 * A flat season started with custom dates builds a run whose `calendarSnapshot` is a
 * synthetic `cal-flat-<league>` that exists ONLY inside the run, never in tenant config.
 * Stage generation writes that snapshot's calendarId/blockId onto every series, so
 * validating a run-backed series against `config.calendars` 400'd every generate. The
 * rule pinned here: a series with `seasonRunId` is checked against its run's snapshot; a
 * series without one is still checked against tenant config.
 *
 * Same harness as season-venues.int.test.ts: in-process dynalite + the REAL Hono app via
 * `app.request()`. Auth uses the dev bypass (LOCAL_AUTH=1, x-dev-auth).
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { CompetitionStructure, SeasonCalendar, SeasonRun, Series } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4641; // next free odd port after the 4639 suite
const TABLE = 'SmartClubSeriesRunSnapshotTest';
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

/** The synthetic flat-season calendar — present on the run, absent from tenant config. */
const FLAT_CALENDAR: SeasonCalendar = {
  id: 'cal-flat-test',
  label: '2026/27',
  blocks: [{ id: 'b1', label: 'Season', start: '2026-10-03', end: '2027-03-27' }],
};

const STRUCTURE: CompetitionStructure = {
  id: 'st-flat',
  name: 'Flat round robin',
  version: 1,
  stages: [
    {
      id: 'stage-1',
      name: 'League',
      format: { kind: 'round-robin', legs: 1 },
      entrants: { kind: 'all-registered' },
      schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
    },
  ],
};

const RUN = {
  id: 'sr-flat',
  leagueKey: 'friendlies',
  competitionId: 'comp-flat',
  seasonLabel: '2026/27',
  structureSnapshot: STRUCTURE,
  calendarSnapshot: FLAT_CALENDAR,
  stages: [],
  version: 1,
} as unknown as SeasonRun;

const series = (over: Partial<Series> = {}): Series =>
  ({
    id: 's-flat',
    name: 'Friendlies · 2026/27',
    startDate: '2026-10-03',
    teams: [],
    fixtures: [],
    seasonRunId: 'sr-flat',
    schedule: { calendarId: 'cal-flat-test', blockId: 'b1', cadence: { kind: 'weekly' } },
    ...over,
  }) as unknown as Series;

const postSeries = (body: Series) =>
  app.request('/series', { method: 'POST', headers: headers(ADMIN), body: JSON.stringify(body) });

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

  // The whole point: the tenant has NO calendars, so the flat calendar can only be found
  // on the run snapshot. Strip any the seed may grow in future.
  const config = await repo.getTenantConfig('dolphins');
  assert.ok(config, 'seeded tenant config');
  await repo.putTenantConfig({ ...config, calendars: [] });

  const res = await app.request('/season-runs', {
    method: 'POST',
    headers: headers(ADMIN),
    body: JSON.stringify(RUN),
  });
  assert.equal(res.status, 201, await res.text());
});

after(() => {
  ddbServer?.close();
});

describe('series schedule on a season-run series', () => {
  test('a calendar that exists only on the run snapshot is accepted', async () => {
    const res = await postSeries(series());
    assert.equal(res.status, 201, await res.text());
    const stored = await repo.getSeries('dolphins', 's-flat');
    assert.equal(stored?.schedule?.calendarId, 'cal-flat-test');
  });

  test('a PATCH of the schedule is checked against the stored run snapshot too', async () => {
    const ok = await app.request('/series/s-flat', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        version: 1,
        schedule: { calendarId: 'cal-flat-test', blockId: 'b1', cadence: { kind: 'weekly' } },
      }),
    });
    assert.equal(ok.status, 200, await ok.text());

    const bad = await app.request('/series/s-flat', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        version: 2,
        schedule: { calendarId: 'cal-flat-test', blockId: 'nope', cadence: { kind: 'weekly' } },
      }),
    });
    assert.equal(bad.status, 400);
  });

  test('a block that is not on the snapshot is rejected', async () => {
    const res = await postSeries(
      series({
        id: 's-bad-block',
        schedule: { calendarId: 'cal-flat-test', blockId: 'b9', cadence: { kind: 'weekly' } },
      } as Partial<Series>),
    );
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /block that doesn't exist/);
  });

  test('a series naming a season run that does not exist is rejected', async () => {
    const res = await postSeries(series({ id: 's-no-run', seasonRunId: 'sr-missing' }));
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /season run that doesn't exist/);
  });

  test('a series without a run is still checked against tenant config', async () => {
    const res = await postSeries(series({ id: 's-no-run-id', seasonRunId: undefined }));
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /calendar that doesn't exist/);
  });
});
