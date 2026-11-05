/**
 * titans `--revert` + `--propagate-deletes` against an in-process dynalite table (the REAL repo,
 * `deleteSeriesWithSync` and outbox), DELETE /series parity:
 *
 *   - with features.medicoachSync on, `--revert --confirm` WITHOUT the flag refuses and deletes
 *     nothing;
 *   - with the flag, every exported fixture gets an `op: "delete"` row with `origin: "cli"`, and
 *     the rows are present after the run — i.e. written AFTER the `deleteSeriesSyncState` wipe
 *     (which drops every outbox row of the series).
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Series, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4731;
const TABLE = 'SmartClubTitansRevertPropagate';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const T = 'titans';

let ddb: Server;
let repo: typeof import('../src/repo.js');
let titans: typeof import('../src/import-titans-fixtures.js');
let backupDir: string;
let SID: string;

const fx = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  round: 1,
  date: '2026-10-18',
  time: '10:00',
  home: 'a',
  away: 'b',
  venueName: 'Aloe Park',
  ...over,
});

const series = (id: string) =>
  ({
    id,
    name: 'Premier League',
    leagueKey: 'premier-league',
    startDate: '2026-10-18',
    teams: ['a', 'b', 'c', 'd'],
    participants: ['a', 'b', 'c', 'd'].map((t) => ({
      teamId: t,
      clubId: t,
      name: `Team ${t.toUpperCase()}`,
    })),
    fixtures: [fx('f1'), fx('f2', { home: 'c', away: 'd' })],
    approved: false,
    released: false,
    releasedAt: null,
    version: 1,
  }) as unknown as Series;

async function resetTable() {
  const { DynamoDBClient, ScanCommand, DeleteItemCommand } =
    await import('@aws-sdk/client-dynamodb');
  const c = new DynamoDBClient({
    endpoint: process.env.DYNAMO_ENDPOINT,
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  // Test-only reset of the in-process table.
  const items = (await c.send(new ScanCommand({ TableName: TABLE }))).Items ?? [];
  for (const i of items)
    await c.send(new DeleteItemCommand({ TableName: TABLE, Key: { pk: i.pk, sk: i.sk } }));
}

const quietly = async (fn: () => Promise<void>) => {
  const saved = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try {
    await fn();
  } finally {
    [console.log, console.warn, console.error] = saved;
  }
};

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  repo = await import('../src/repo.js');
  titans = await import('../src/import-titans-fixtures.js');
  backupDir = await mkdtemp(join(tmpdir(), 'titans-revert-'));
  SID = titans.WRITABLE_SERIES_IDS[0];
});

after(async () => {
  await stopDynalite(ddb);
});

beforeEach(async () => {
  await resetTable();
  await repo.putTenantConfig({
    tenant: T,
    branding: { name: 'Titans', title: 'Titans', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: { medicoachSync: true },
  } as unknown as TenantConfig);
  await repo.putSeries(T, series(SID));
  process.exitCode = undefined;
});

describe('titans --revert with medicoach sync on', () => {
  test('refuses without --propagate-deletes and deletes nothing', async () => {
    await quietly(() =>
      titans.runRevert(titans.parseArgs(['--revert', '--confirm', '--backup-dir', backupDir])),
    );
    assert.equal(process.exitCode, 1);
    process.exitCode = undefined;
    assert.ok(await repo.getSeries(T, SID), 'series must survive a refused revert');
    assert.deepEqual(await repo.listPendingSync(T), []);
  });

  test('--propagate-deletes queues cli-origin delete rows that survive the sync-state wipe', async () => {
    await quietly(() =>
      titans.runRevert(
        titans.parseArgs([
          '--revert',
          '--confirm',
          '--propagate-deletes',
          '--backup-dir',
          backupDir,
        ]),
      ),
    );
    assert.notEqual(process.exitCode, 1);
    assert.equal(await repo.getSeries(T, SID), null);
    const rows = (await repo.listPendingSync(T)).filter((r) => r.seriesId === SID);
    assert.deepEqual(rows.map((r) => r.fixtureId).sort(), ['f1', 'f2']);
    for (const r of rows) {
      assert.equal(r.op, 'delete');
      assert.equal(r.origin, 'cli');
    }
  });
});
