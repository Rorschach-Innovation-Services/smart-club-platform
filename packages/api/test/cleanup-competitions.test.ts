/**
 * Tests for scripts/cleanup-competitions.ts — the post-burn-in strip of the retired
 * competition layer's inert leftovers (`competitions`, `note` on leagues; `ladder`/`outcome`
 * on stage specs), guarded against leagues the setup migration never reached.
 *
 * Same harness as migrate-league-setups.test.ts (in-process dynalite, real repo functions).
 * Each describe scopes the cleanup to its own tenant through a store whose listTenants
 * filters the registry, so one tenant's unmigrated league never leaks into another
 * describe's exit status.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Competition,
  CompetitionStructure,
  League,
  SeasonCalendar,
  TenantConfig,
} from '../src/types.js';

const DDB_PORT = 4653; // after migrate-league-setups (4652)
const TABLE = 'SmartClubCleanupCompetitionsTest';
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

type Script = typeof import('../scripts/cleanup-competitions.js');
type CleanupStore = import('../scripts/cleanup-competitions.js').CleanupStore;

// Resolved in before().
let ddbServer: Server;
let repo: typeof import('../src/repo.js');
let cleanupCompetitions: Script['cleanupCompetitions'];
let main: Script['main'];
let backupDir: string;

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
  ({ cleanupCompetitions, main } = await import('../scripts/cleanup-competitions.js'));
  backupDir = await mkdtemp(join(tmpdir(), 'competitions-cleanup-backup-'));
});

after(async () => {
  ddbServer?.close();
  if (backupDir) await rm(backupDir, { recursive: true, force: true });
});

const baseConfig = (tenant: string, over: Partial<TenantConfig> = {}): TenantConfig => ({
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

/** A league as STORED — it may still carry the retired `note` the type no longer declares. */
const league = (key: string, over: Partial<League> & { note?: string } = {}): League =>
  ({
    key,
    label: key,
    group: 'Men',
    district: 'All districts',
    ...over,
  }) as League;

const CAL: SeasonCalendar = {
  id: 'cal-2026',
  label: '2026/27',
  blocks: [{ id: 'b1', label: 'Season', start: '2026-09-01', end: '2027-03-31' }],
};

const stage = (id: string, legacy: Record<string, unknown> = {}) => ({
  id,
  name: id,
  format: { kind: 'round-robin' as const, legs: 1 as const },
  entrants: { kind: 'all-registered' as const },
  schedule: { blockIndex: 0, cadence: { kind: 'weekly' as const } },
  ...legacy,
});

/** A structure as STORED — its stages may still carry the retired `ladder`/`outcome`. */
const structure = (id: string, stages: ReturnType<typeof stage>[]): CompetitionStructure =>
  ({ id, name: id, version: 3, source: 'operator', overs: 50, stages }) as CompetitionStructure;

const comp = (id: string): Competition => ({
  id,
  label: id,
  matchFormat: { overs: 50 },
  structureId: 'st-a',
  calendarId: 'cal-2026',
});

const SETUP = { structureId: 'st-a', calendarId: 'cal-2026' };

/**
 * The real repo, with the tenant registry narrowed to the given tenants. Delegates lazily:
 * describes build their store before `before()` has imported the repo.
 */
const scopedStore = (...tenants: string[]): CleanupStore => ({
  listTenants: async () => (await repo.listTenants()).filter((t) => tenants.includes(t.tenant)),
  getTenantConfig: (tenant) => repo.getTenantConfig(tenant),
  putTenantConfig: (config) => repo.putTenantConfig(config),
});

const silent = { log: () => {}, error: () => {} };

describe('cleanup-competitions', () => {
  const T = 'ccleanup';
  const store = scopedStore(T);
  const LADDER = { winPoints: 4, bonusPoints: 1, lossPoints: 0, tiePoints: 2, abandonedPoints: 2 };
  let preImage: TenantConfig | null;

  test('sets up a migrated tenant still carrying the retired fields', async () => {
    await repo.createTenantConfig(
      baseConfig(T, {
        calendars: [CAL],
        structures: [
          structure('st-a', [
            stage('pools', { ladder: { ...LADDER, order: ['points'] } }),
            stage('final', { outcome: { champion: [1] } }),
          ]),
          structure('st-clean', [stage('only')]),
        ],
        leagues: [
          league('premier', { setup: SETUP, competitions: [comp('c-50')], note: 'Sat only' }),
          league('div-one', { setup: SETUP, competitions: [] }),
          league('noted', { note: 'legacy note' }),
          league('clean', { setup: SETUP }),
        ],
      }),
    );
    preImage = await repo.getTenantConfig(T);
  });

  test('dry-run reports every strip, exits 0, and writes nothing', async () => {
    const lines: string[] = [];
    const result = await cleanupCompetitions({ log: (l) => lines.push(l), store, backupDir });

    assert.equal(result.tenantsCleaned, 1);
    assert.equal(result.competitionsStripped, 2);
    assert.equal(result.notesStripped, 2);
    assert.equal(result.stagesStripped, 2);
    assert.deepEqual(result.cleanups, [
      {
        tenant: T,
        competitions: ['premier', 'div-one'],
        notes: ['premier', 'noted'],
        stages: ['st-a/pools', 'st-a/final'],
      },
    ]);
    assert.deepEqual(result.unmigrated, []);
    assert.ok(lines.some((l) => l.includes(`[dry-run] ${T}`)));
    assert.ok(lines.some((l) => /^dry-run complete: 1 tenant\(s\) would be cleaned/.test(l)));
    assert.deepEqual(await readdir(backupDir), [], 'no backup on a dry-run');
    assert.deepEqual(await repo.getTenantConfig(T), preImage, 'nothing written');
    assert.equal(await main([], { ...silent, store }), 0);
  });

  test('--confirm strips the retired fields, keeps everything else, and backs up first', async () => {
    const status = await main(['--confirm', `--backup-dir=${backupDir}`], { ...silent, store });
    assert.equal(status, 0);

    const cfg = await repo.getTenantConfig(T);
    for (const lg of cfg?.leagues ?? []) {
      assert.equal('competitions' in lg, false, `${lg.key}: competitions stripped`);
      assert.equal('note' in lg, false, `${lg.key}: note stripped`);
    }
    const lg = (key: string) => cfg?.leagues?.find((l) => l.key === key);
    assert.deepEqual(lg('premier'), league('premier', { setup: SETUP }));
    assert.deepEqual(
      lg('noted'),
      league('noted'),
      'an unbound league without competitions is fine',
    );
    assert.deepEqual(lg('clean'), league('clean', { setup: SETUP }));

    const st = (id: string) => cfg?.structures?.find((s) => s.id === id);
    for (const s of st('st-a')?.stages ?? []) {
      assert.equal('ladder' in s, false, `${s.id}: ladder stripped`);
      assert.equal('outcome' in s, false, `${s.id}: outcome stripped`);
    }
    assert.deepEqual(st('st-a')?.stages, [stage('pools'), stage('final')]);
    assert.equal(st('st-a')?.version, 3, 'no version bump — the stripped fields were never read');
    assert.equal(st('st-a')?.overs, 50);
    assert.deepEqual(st('st-clean'), preImage?.structures?.[1], 'a clean structure is untouched');
    assert.deepEqual(cfg?.calendars, [CAL]);

    const files = await readdir(backupDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^competitions-cleanup-backup-ccleanup-.+\.json$/);
    const backup = JSON.parse(await readFile(join(backupDir, files[0]), 'utf8')) as TenantConfig;
    assert.deepEqual(backup, preImage, 'the backup is the full pre-image');
  });

  test('a second run finds nothing to do, writes nothing, and exits 0', async () => {
    const before = await repo.getTenantConfig(T);
    const result = await cleanupCompetitions({
      confirm: true,
      log: () => {},
      store,
      backupDir,
    });
    assert.equal(result.tenantsCleaned, 0);
    assert.deepEqual(result.cleanups, []);
    assert.deepEqual(await repo.getTenantConfig(T), before);
    assert.equal((await readdir(backupDir)).length, 1, 'no new backup');
    assert.equal(await main(['--confirm', `--backup-dir=${backupDir}`], { ...silent, store }), 0);
  });
});

describe('cleanup-competitions — an unmigrated league', () => {
  const T = 'ccleanup-unmigrated';
  const store = scopedStore(T);

  test('leaves the whole tenant untouched, reports the league, and exits 1 in both modes', async () => {
    await repo.createTenantConfig(
      baseConfig(T, {
        calendars: [CAL],
        structures: [structure('st-a', [stage('pools', { outcome: { champion: [1] } })])],
        leagues: [
          league('migrated', { setup: SETUP, competitions: [comp('c-ok')], note: 'n' }),
          league('stranded', { competitions: [comp('c-1'), comp('c-2')] }),
        ],
      }),
    );
    const before = await repo.getTenantConfig(T);

    const lines: string[] = [];
    const result = await cleanupCompetitions({ log: (l) => lines.push(l), store, backupDir });
    assert.deepEqual(result.unmigrated, [{ tenant: T, leagueKey: 'stranded', competitions: 2 }]);
    assert.equal(result.tenantsCleaned, 0);
    assert.ok(lines.some((l) => /stranded: 2 competition\(s\) and no setup/.test(l)));
    assert.ok(lines.some((l) => /^STOP: 1 unmigrated league/.test(l)));
    assert.equal(await main([], { ...silent, store }), 1);

    const backupsBefore = (await readdir(backupDir)).length;
    assert.equal(await main(['--confirm', `--backup-dir=${backupDir}`], { ...silent, store }), 1);
    assert.deepEqual(
      await repo.getTenantConfig(T),
      before,
      'nothing written — not even the migrated league',
    );
    assert.equal(
      (await readdir(backupDir)).length,
      backupsBefore,
      'no backup for a guarded tenant',
    );
  });
});

describe('cleanup-competitions — CLI flags', () => {
  test('an unknown flag exits 1 without scanning', async () => {
    const errors: string[] = [];
    assert.equal(await main(['--bogus'], { log: () => {}, error: (l) => errors.push(l) }), 1);
    assert.match(errors[0], /unknown flag "--bogus"/);
    assert.equal(await main(['--backup-dir='], silent), 1, 'an empty backup dir is refused');
  });

  test('the config is re-read right before the put, so a concurrent save survives', async () => {
    const T = 'ccleanup-race';
    await repo.createTenantConfig(
      baseConfig(T, {
        calendars: [CAL],
        structures: [structure('st-a', [stage('pools')])],
        leagues: [league('lr', { setup: SETUP, competitions: [comp('c-r')] })],
      }),
    );
    const racing: CleanupStore = {
      ...scopedStore(T),
      // Hand back the tenant list, then land an operator's save before the put.
      listTenants: async () => {
        const listed = (await repo.listTenants()).filter((t) => t.tenant === T);
        const cur = await repo.getTenantConfig(T);
        await repo.putTenantConfig({ ...cur!, submissionDeadline: '2026-12-31' });
        return listed;
      },
    };
    const result = await cleanupCompetitions({
      confirm: true,
      log: () => {},
      store: racing,
      backupDir,
    });
    assert.equal(result.tenantsCleaned, 1);
    const cfg = await repo.getTenantConfig(T);
    assert.equal(cfg?.submissionDeadline, '2026-12-31', 'the concurrent save is kept');
    assert.equal('competitions' in (cfg?.leagues?.[0] ?? {}), false);
    assert.deepEqual(cfg?.leagues?.[0].setup, SETUP);
  });
});
