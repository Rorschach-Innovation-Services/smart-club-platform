/**
 * Tests for scripts/cleanup-scorecard-confirmations.ts — the one-off delete of the retired chair
 * scorecard digest's orphaned `TENANT#<t>#SCORECONF` partition, against an in-process dynalite
 * table. The rows are seeded with raw Puts (their key helpers and repo functions are gone):
 *
 *  - a dry-run (the default) finds the rows and deletes nothing;
 *  - `--tenant=<id> --confirm` deletes exactly that tenant's partition — the other tenant's
 *    partition and the tenant's neighbouring rows (config, a captain's report) survive;
 *  - a full `--confirm` then clears the rest; a re-run finds nothing;
 *  - an unknown flag exits 1 without touching anything.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4711;
const TABLE = 'SmartClubCleanupScorecardConfirmations';
dynaliteEnv(DDB_PORT, TABLE);

type Script = typeof import('../scripts/cleanup-scorecard-confirmations.js');

let ddbServer: Server;
let repo: typeof import('../src/repo.js');
let script: Script;
let raw: import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
let lib: typeof import('@aws-sdk/lib-dynamodb');

const tenantConfig = (tenant: string) =>
  ({
    tenant,
    branding: { name: tenant, title: tenant, logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
  }) as unknown as TenantConfig;

const put = (pk: string, sk: string, extra: Record<string, unknown> = {}) =>
  raw.send(new lib.PutCommand({ TableName: TABLE, Item: { pk, sk, ...extra } }));

const partition = async (pk: string) =>
  (
    await raw.send(
      new lib.QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': pk },
      }),
    )
  ).Items ?? [];

const quiet = () => {};

before(async () => {
  ddbServer = await startDynalite(DDB_PORT, TABLE);
  repo = await import('../src/repo.js');
  script = await import('../scripts/cleanup-scorecard-confirmations.js');
  lib = await import('@aws-sdk/lib-dynamodb');
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  raw = lib.DynamoDBDocumentClient.from(
    new DynamoDBClient({
      endpoint: process.env.DYNAMO_ENDPOINT,
      region: 'localhost',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }),
  );

  for (const t of ['alpha', 'beta']) await repo.putTenantConfig(tenantConfig(t));
  // alpha: two digests, a counter and a send claim; beta: one digest.
  await put('TENANT#alpha#SCORECONF', 'SCORECONF#2026-W40#umzinto', {
    memberId: 'm-1',
    entries: { f1: { action: 'correction', feedback: 'Xolani Zulu was caught' } },
  });
  await put('TENANT#alpha#SCORECONF', 'SCORECONF#2026-W41#umzinto', { memberId: 'm-2' });
  await put('TENANT#alpha#SCORECONF', 'COUNTER#SC#2026', { n: 2 });
  await put('TENANT#alpha#SCORECONF', 'NOTIFY#SCORECONF#2026-W40#umzinto', { status: 'sent' });
  await put('TENANT#beta#SCORECONF', 'SCORECONF#2026-W40#warriors', { memberId: 'm-3' });
  // Neighbours that must survive: another partition of the same tenant.
  await put('TENANT#alpha#CAPREPORT', 'CAPREPORT#s1#f1#umzinto', { status: 'pending' });
});

after(async () => {
  await stopDynalite(ddbServer);
});

describe('cleanup-scorecard-confirmations', () => {
  test('dry-run (default) finds the rows and deletes nothing', async () => {
    const res = await script.cleanupScorecardConfirmations({ log: quiet });
    assert.equal(res.tenantsScanned, 2);
    assert.equal(res.rowsFound, 5);
    assert.equal(res.rowsDeleted, 0);
    assert.deepEqual(
      res.tenants.sort((a, b) => a.tenant.localeCompare(b.tenant)),
      [
        { tenant: 'alpha', rows: 4 },
        { tenant: 'beta', rows: 1 },
      ],
    );
    assert.equal((await partition('TENANT#alpha#SCORECONF')).length, 4);
    assert.equal((await partition('TENANT#beta#SCORECONF')).length, 1);
  });

  test('--tenant --confirm deletes only that partition', async () => {
    assert.equal(await script.main(['--tenant=alpha', '--confirm'], { log: quiet }), 0);
    assert.equal((await partition('TENANT#alpha#SCORECONF')).length, 0);
    assert.equal((await partition('TENANT#beta#SCORECONF')).length, 1, 'other tenant untouched');
    assert.equal((await partition('TENANT#alpha#CAPREPORT')).length, 1, 'neighbour untouched');
    assert.ok(await repo.getTenantConfig('alpha'), 'tenant config untouched');
  });

  test('a full --confirm clears the rest; a re-run finds nothing', async () => {
    const res = await script.cleanupScorecardConfirmations({ confirm: true, log: quiet });
    assert.equal(res.rowsDeleted, 1);
    assert.equal((await partition('TENANT#beta#SCORECONF')).length, 0);
    const again = await script.cleanupScorecardConfirmations({ confirm: true, log: quiet });
    assert.equal(again.rowsFound, 0);
    assert.deepEqual(again.tenants, []);
    assert.equal((await partition('TENANT#alpha#CAPREPORT')).length, 1, 'neighbour untouched');
  });

  test('an unknown flag exits 1', async () => {
    const errors: string[] = [];
    assert.equal(await script.main(['--yes'], { log: quiet, error: (l) => errors.push(l) }), 1);
    assert.match(errors[0], /unknown flag "--yes"/);
  });
});
