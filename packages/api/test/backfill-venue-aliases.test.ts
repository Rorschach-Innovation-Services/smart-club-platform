/**
 * Tests for scripts/backfill-venue-aliases.ts — the one-off copy of the code-default
 * ground-name aliases into the dolphins tenant's `competitionDefaults.venueAliases`.
 *
 * Same harness as migrate-flat-runs.test.ts (in-process dynalite, real repo functions).
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { TenantConfig } from '../src/types.js';

const DDB_PORT = 4649; // next free odd port after season-generate (4647)
const TABLE = 'SmartClubBackfillVenueAliasesTest';
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.LOCAL_AUTH = '1';
process.env.STAGE = 'local';
process.env.USER_POOL_ID = 'test-pool';
process.env.AWS_REGION ??= 'localhost';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_MAX_ATTEMPTS = '1';

let ddbServer: Server;
let repo: typeof import('../src/repo.js');
let backfill: (typeof import('../scripts/backfill-venue-aliases.js'))['backfillVenueAliases'];
let DEFAULTS: Record<string, string>;

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

  repo = await import('../src/repo.js');
  ({ backfillVenueAliases: backfill } = await import('../scripts/backfill-venue-aliases.js'));
  ({ DEFAULT_VENUE_ALIASES: DEFAULTS } = await import('../src/venue-clash.js'));
});

after(() => {
  ddbServer?.close();
});

const config = (tenant: string, over: Partial<TenantConfig> = {}): TenantConfig => ({
  tenant,
  branding: {
    name: tenant,
    title: tenant,
    logoUrl: '',
    colors: {},
    copy: { footer: 'Powered by Medicoach' },
  },
  submissionDeadline: '2026-01-01',
  knownClubs: [],
  leagues: [],
  ...over,
});

const quiet = () => {};

describe('backfill-venue-aliases', () => {
  test('a dry run reports the aliases it would write and writes nothing', async () => {
    await repo.putTenantConfig(config('dolphins', { competitionDefaults: { matchDays: [0] } }));
    const r = await backfill({ confirm: false, log: quiet });
    assert.equal(r.outcome, 'would-write');
    assert.equal(r.aliases, Object.keys(DEFAULTS).length);
    const stored = await repo.getTenantConfig('dolphins');
    assert.equal(stored?.competitionDefaults?.venueAliases, undefined);
  });

  test('--confirm writes the code defaults and keeps the rest of competitionDefaults', async () => {
    const r = await backfill({ confirm: true, log: quiet });
    assert.equal(r.outcome, 'written');
    const stored = await repo.getTenantConfig('dolphins');
    assert.deepEqual(stored?.competitionDefaults?.venueAliases, DEFAULTS);
    assert.deepEqual(stored?.competitionDefaults?.matchDays, [0]);
  });

  test('is idempotent: a second run finds the aliases and writes nothing', async () => {
    const before = await repo.getTenantConfig('dolphins');
    const r = await backfill({ confirm: true, log: quiet });
    assert.equal(r.outcome, 'already-set');
    assert.deepEqual(await repo.getTenantConfig('dolphins'), before);
  });

  test('never overwrites a map the operator set, even an empty one', async () => {
    await repo.putTenantConfig(config('dolphins', { competitionDefaults: { venueAliases: {} } }));
    const r = await backfill({ confirm: true, log: quiet });
    assert.equal(r.outcome, 'already-set');
    const stored = await repo.getTenantConfig('dolphins');
    assert.deepEqual(stored?.competitionDefaults?.venueAliases, {});
  });

  test('touches no other tenant', async () => {
    await repo.putTenantConfig(config('titans'));
    await backfill({ confirm: true, log: quiet });
    const titans = await repo.getTenantConfig('titans');
    assert.equal(titans?.competitionDefaults, undefined);
  });
});
