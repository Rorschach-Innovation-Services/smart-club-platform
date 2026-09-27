/**
 * Tests for scripts/migrate-league-setups.ts — the additive migration that gives every
 * league still on competitions[] its one `setup`, moving each competition's overs onto
 * its structure (cloning a shared structure only on conflicting overs).
 *
 * Same harness as backfill-venue-aliases.test.ts (in-process dynalite, real repo functions).
 * Each describe scopes the migration to its own tenant through a store whose
 * listTenants filters the registry, so one tenant's extras never leak into another
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
  SeasonRun,
  TenantConfig,
} from '../src/types.js';

const DDB_PORT = 4652; // after season-live-calendar (4651)
const TABLE = 'SmartClubMigrateLeagueSetupsTest';
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

type Script = typeof import('../scripts/migrate-league-setups.js');
type MigrationStore = import('../scripts/migrate-league-setups.js').MigrationStore;

// Resolved in before().
let ddbServer: Server;
let repo: typeof import('../src/repo.js');
let migrateLeagueSetups: Script['migrateLeagueSetups'];
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
  ({ migrateLeagueSetups, main } = await import('../scripts/migrate-league-setups.js'));
  backupDir = await mkdtemp(join(tmpdir(), 'league-setups-backup-'));
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

const league = (key: string, over: Partial<League> = {}): League => ({
  key,
  label: key,
  group: 'Men',
  district: 'All districts',
  ...over,
});

const calendar = (id: string, start: string, end: string): SeasonCalendar => ({
  id,
  label: id,
  blocks: [{ id: 'b1', label: 'Season', start, end }],
});

const structure = (id: string, name: string, over: Partial<CompetitionStructure> = {}) =>
  ({
    id,
    name,
    version: 1,
    source: 'operator',
    stages: [
      {
        id: 'stage-1',
        name: 'League',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'all-registered' },
        schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
      },
    ],
    ...over,
  }) satisfies CompetitionStructure;

const comp = (
  id: string,
  structureId: string,
  calendarId: string,
  overs?: number,
  over: Partial<Competition> = {},
): Competition => ({
  id,
  label: id,
  ...(overs !== undefined ? { matchFormat: { overs } } : {}),
  structureId,
  calendarId,
  ...over,
});

const run = (
  over: Partial<SeasonRun> & Pick<SeasonRun, 'id' | 'leagueKey'>,
  generated = false,
): SeasonRun => ({
  seasonLabel: '2026/27',
  structureSnapshot: structure('st-snap', 'Snapshot'),
  calendarSnapshot: calendar('cal-2026', '2026-09-01', '2027-03-31'),
  stages: [
    {
      specId: 'stage-1',
      status: generated ? 'generated' : 'awaiting-entrants',
      groups: generated ? [{ id: 'g1', label: 'A', entrants: ['a', 'b'], seriesId: 's1' }] : [],
    },
  ],
  version: 1,
  ...over,
});

/**
 * The real repo, with the tenant registry narrowed to the given tenants. Delegates lazily:
 * describes build their store before `before()` has imported the repo.
 */
const scopedStore = (...tenants: string[]): MigrationStore => ({
  listTenants: async () => (await repo.listTenants()).filter((t) => tenants.includes(t.tenant)),
  listSeasonRuns: (tenant) => repo.listSeasonRuns(tenant),
  getTenantConfig: (tenant) => repo.getTenantConfig(tenant),
  putTenantConfig: (config) => repo.putTenantConfig(config),
});

const silent = { log: () => {}, error: () => {} };

describe('migrate-league-setups', () => {
  const T = 'lsmig';
  const store = scopedStore(T);
  const CAL_2025 = calendar('cal-2025', '2025-09-01', '2026-03-31');
  const CAL_2026 = calendar('cal-2026', '2026-09-01', '2027-03-31');
  const leagues: League[] = [
    // Kept by recency: c-50 (cal-2026). Extra c-t20 conflicts on the shared structure.
    league('premier', {
      competitions: [
        comp('c-50', 'st-shared', 'cal-2026', 50),
        comp('c-t20', 'st-shared', 'cal-2025', 20),
      ],
    }),
    // Kept by recency is the SECOND entry; it carries exclusions.
    league('div-one', {
      competitions: [
        comp('c-old', 'st-league', 'cal-2025', 40),
        comp('c-new', 'st-league', 'cal-2026', 40, { excludeTeamIds: ['team-x'] }),
      ],
    }),
    league('div-two', { competitions: [comp('c-only', 'st-t20', 'cal-2026', 20)] }),
    // Kept competition conflicts with premier's 50 on st-shared → setup on the clone.
    league('women', { competitions: [comp('c-w', 'st-shared', 'cal-2026', 30)] }),
    league('set-already', {
      setup: { structureId: 'st-league', calendarId: 'cal-2025' },
      competitions: [comp('c-x', 'st-t20', 'cal-2026', 99)],
    }),
    league('no-comps'),
  ];
  let preImage: TenantConfig | null;

  test('sets up a tenant with competitions, runs and an already-set-up league', async () => {
    await repo.createTenantConfig(
      baseConfig(T, {
        leagues,
        calendars: [CAL_2025, CAL_2026],
        structures: [
          structure('st-shared', 'Shared'),
          structure('st-league', 'League'),
          structure('st-t20', 'T20 League'),
        ],
      }),
    );
    // Ungenerated, snapshot on the old calendar → re-dates.
    await repo.putSeasonRun(
      T,
      run({ id: 'run-ungen-moves', leagueKey: 'div-two', calendarSnapshot: CAL_2025 }),
    );
    // Ungenerated, already on the kept calendar → not reported.
    await repo.putSeasonRun(T, run({ id: 'run-ungen-same', leagueKey: 'div-two' }));
    // Generated on the shared structure, pre-overs snapshot → the clone's name/overs differ.
    await repo.putSeasonRun(
      T,
      run(
        {
          id: 'run-gen-drift',
          leagueKey: 'women',
          structureSnapshot: structure('st-shared', 'Shared'),
        },
        true,
      ),
    );
    // Generated, snapshot matches the migrated structure → not reported.
    await repo.putSeasonRun(
      T,
      run(
        {
          id: 'run-gen-ok',
          leagueKey: 'div-two',
          structureSnapshot: structure('st-t20', 'T20 League', { overs: 20 }),
        },
        true,
      ),
    );
    // Frozen but with no series back-pointer is still generated — never a calendar change.
    await repo.putSeasonRun(
      T,
      run({
        id: 'run-frozen',
        leagueKey: 'div-two',
        calendarSnapshot: CAL_2025,
        calendarFrozenAt: '2026-09-01T00:00:00.000Z',
        structureSnapshot: structure('st-t20', 'T20 League', { overs: 20 }),
      }),
    );
    preImage = await repo.getTenantConfig(T);
  });

  test('dry-run reports everything, exits 1 on extras, and writes nothing', async () => {
    const lines: string[] = [];
    const result = await migrateLeagueSetups({ log: (l) => lines.push(l), store, backupDir });

    assert.equal(result.leaguesFound, 4);
    assert.equal(result.leaguesMigrated, 4);
    assert.equal(result.alreadySetUp, 1);
    const byLeague = new Map(result.plans.map((p) => [p.leagueKey, p]));
    assert.deepEqual(byLeague.get('premier')?.setup, {
      structureId: 'st-shared',
      calendarId: 'cal-2026',
    });
    assert.equal(byLeague.get('div-one')?.competitionId, 'c-new', 'picked by calendar recency');
    assert.deepEqual(byLeague.get('women')?.setup, {
      structureId: 'st-st-shared-women',
      calendarId: 'cal-2026',
    });
    assert.equal(byLeague.get('women')?.onClone, true);

    assert.deepEqual(
      result.extras.map((e) => [e.leagueKey, e.competitionId, e.structureId, e.calendarId]),
      [
        ['premier', 'c-t20', 'st-shared', 'cal-2025'],
        ['div-one', 'c-old', 'st-league', 'cal-2025'],
      ],
    );
    assert.deepEqual(
      result.clones.map((c) => [c.cloneId, c.overs, c.kept]),
      [
        ['st-st-shared-premier', 20, false],
        ['st-st-shared-women', 30, true],
      ],
    );
    assert.deepEqual(
      result.excludedTeams.map((x) => [x.leagueKey, x.excludeTeamIds]),
      [['div-one', ['team-x']]],
    );
    assert.deepEqual(
      result.calendarChanges.map((c) => [c.runId, c.fromCalendarId, c.toCalendarId]),
      [['run-ungen-moves', 'cal-2025', 'cal-2026']],
    );
    assert.deepEqual(
      result.formatDrift.map((d) => [d.runId, d.migrated.name, d.migrated.overs]),
      [['run-gen-drift', 'Shared · 30 overs', 30]],
    );
    assert.ok(lines.some((l) => l.includes('[dry-run] lsmig')));
    assert.ok(lines.some((l) => /^STOP: 2 extra competition/.test(l)));
    assert.deepEqual(result.backups, []);
    assert.deepEqual(await readdir(backupDir), [], 'no backup on a dry-run');
    assert.deepEqual(await repo.getTenantConfig(T), preImage, 'nothing written');

    assert.equal(await main([], { ...silent, store }), 1, 'the prod gate: extras exit 1');
  });

  test('--confirm writes setup additively, moves overs, clones, and backs up first', async () => {
    const status = await main(['--confirm', `--backup-dir=${backupDir}`], { ...silent, store });
    assert.equal(status, 1, 'extras still exit 1 under --confirm');

    const cfg = await repo.getTenantConfig(T);
    const lg = (key: string) => cfg?.leagues?.find((l) => l.key === key);
    assert.deepEqual(lg('premier')?.setup, { structureId: 'st-shared', calendarId: 'cal-2026' });
    assert.deepEqual(lg('div-one')?.setup, { structureId: 'st-league', calendarId: 'cal-2026' });
    assert.deepEqual(lg('div-two')?.setup, { structureId: 'st-t20', calendarId: 'cal-2026' });
    assert.deepEqual(lg('women')?.setup, {
      structureId: 'st-st-shared-women',
      calendarId: 'cal-2026',
    });
    assert.deepEqual(lg('set-already'), leagues[4], 'an already set-up league is untouched');
    assert.equal(lg('no-comps')?.setup, undefined);
    for (const original of leagues)
      assert.deepEqual(
        lg(original.key)?.competitions,
        original.competitions,
        `${original.key}: competitions[] kept byte-equal`,
      );

    const st = (id: string) => cfg?.structures?.find((s) => s.id === id);
    assert.equal(st('st-shared')?.overs, 50, 'first-written overs stay on the original');
    assert.equal(st('st-league')?.overs, 40);
    assert.equal(st('st-t20')?.overs, 20);
    assert.equal(st('st-shared')?.source, 'operator');
    const extraClone = st('st-st-shared-premier');
    assert.equal(extraClone?.overs, 20);
    assert.equal(extraClone?.name, 'Shared · 20 overs');
    assert.equal(extraClone?.source, undefined, 'clone source unset');
    assert.deepEqual(extraClone?.stages, structure('st-shared', 'Shared').stages);
    assert.equal(st('st-st-shared-women')?.overs, 30);
    assert.equal(cfg?.structures?.length, 5);

    const files = await readdir(backupDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^league-setups-backup-lsmig-.+\.json$/);
    const backup = JSON.parse(await readFile(join(backupDir, files[0]), 'utf8')) as TenantConfig;
    assert.deepEqual(backup, preImage, 'the backup is the full pre-image');
  });

  test('a second run finds nothing to do, writes nothing, and exits 0', async () => {
    const before = await repo.getTenantConfig(T);
    const lines: string[] = [];
    const result = await migrateLeagueSetups({
      confirm: true,
      log: (l) => lines.push(l),
      store,
      backupDir,
    });
    assert.equal(result.leaguesFound, 0);
    assert.equal(result.leaguesMigrated, 0);
    assert.equal(result.alreadySetUp, 5, 'every league with competitions is now set up');
    assert.deepEqual(result.extras, []);
    assert.ok(lines.some((l) => /already set up — left untouched/.test(l)));
    assert.deepEqual(await repo.getTenantConfig(T), before);
    assert.equal((await readdir(backupDir)).length, 1, 'no new backup');
    assert.equal(await main(['--confirm', `--backup-dir=${backupDir}`], { ...silent, store }), 0);
  });
});

describe('migrate-league-setups — conflict clone id already taken', () => {
  const T = 'lsmig-taken';
  const store = scopedStore(T);

  test('reuses a clone id only when its overs match; otherwise keeps suffixing', async () => {
    await repo.createTenantConfig(
      baseConfig(T, {
        calendars: [calendar('cal-2026', '2026-09-01', '2027-03-31')],
        structures: [
          structure('st-shared', 'Shared'),
          // Both the deterministic id AND its first suffix are taken, with other overs.
          structure('st-st-shared-women', 'Taken', { overs: 50 }),
          structure('st-st-shared-women-30', 'Also taken', { overs: 40 }),
          // The deterministic id for div-two is taken WITH matching overs → reused.
          structure('st-st-shared-div-two', 'Reusable', { overs: 20 }),
        ],
        leagues: [
          league('premier', { competitions: [comp('c-50', 'st-shared', 'cal-2026', 50)] }),
          league('women', { competitions: [comp('c-w', 'st-shared', 'cal-2026', 30)] }),
          league('div-two', { competitions: [comp('c-d', 'st-shared', 'cal-2026', 20)] }),
        ],
      }),
    );

    await migrateLeagueSetups({ confirm: true, log: () => {}, store, backupDir });

    const cfg = await repo.getTenantConfig(T);
    const lg = (key: string) => cfg?.leagues?.find((l) => l.key === key);
    const st = (id: string) => cfg?.structures?.find((s) => s.id === id);
    assert.equal(lg('women')?.setup?.structureId, 'st-st-shared-women-30-2');
    assert.equal(st('st-st-shared-women-30-2')?.overs, 30);
    assert.equal(st('st-st-shared-women-30')?.overs, 40, 'mismatched structure untouched');
    assert.equal(st('st-st-shared-women')?.overs, 50, 'mismatched structure untouched');
    assert.equal(lg('div-two')?.setup?.structureId, 'st-st-shared-div-two');
    assert.equal(st('st-st-shared-div-two')?.name, 'Reusable', 'matching overs → reused as-is');
    assert.equal(cfg?.structures?.length, 5, 'exactly one new clone minted');
  });
});

describe('migrate-league-setups — a tenant that would not validate', () => {
  const T = 'lsmig-bad';
  const store = scopedStore(T);

  test('is skipped whole and reported; exit 1 in both modes', async () => {
    await repo.createTenantConfig(
      baseConfig(T, {
        calendars: [calendar('cal-ok', '2026-09-01', '2027-03-31')],
        structures: [structure('st-ok', 'OK')],
        leagues: [
          league('good', { competitions: [comp('c-good', 'st-ok', 'cal-ok', 50)] }),
          // Its only calendar is gone: kept anyway (sorts oldest), and validateSetups refuses.
          league('broken', { competitions: [comp('c-broken', 'st-ok', 'cal-gone')] }),
        ],
      }),
    );
    const before = await repo.getTenantConfig(T);

    const result = await migrateLeagueSetups({ log: () => {}, store, backupDir });
    assert.equal(result.leaguesMigrated, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /would not validate: .*calendar that doesn't exist/);
    assert.equal(await main([], { ...silent, store }), 1);

    const backupsBefore = (await readdir(backupDir)).length;
    assert.equal(await main(['--confirm', `--backup-dir=${backupDir}`], { ...silent, store }), 1);
    const cfg = await repo.getTenantConfig(T);
    assert.deepEqual(cfg, before, 'nothing written — not even the good league');
    assert.equal(cfg?.structures?.[0].overs, undefined);
    assert.equal((await readdir(backupDir)).length, backupsBefore, 'no backup for a skip');
  });
});

describe('migrate-league-setups — CLI flags', () => {
  test('an unknown flag exits 1 without scanning', async () => {
    const errors: string[] = [];
    assert.equal(await main(['--bogus'], { log: () => {}, error: (l) => errors.push(l) }), 1);
    assert.match(errors[0], /unknown flag "--bogus"/);
    assert.equal(await main(['--backup-dir='], silent), 1, 'an empty backup dir is refused');
  });

  test('the config is re-read right before the put, so a concurrent save survives', async () => {
    const T = 'lsmig-race';
    await repo.createTenantConfig(
      baseConfig(T, {
        calendars: [calendar('cal-r', '2026-09-01', '2027-03-31')],
        structures: [structure('st-r', 'R')],
        leagues: [league('lr', { competitions: [comp('c-r', 'st-r', 'cal-r', 20)] })],
      }),
    );
    const racing = {
      ...scopedStore(T),
      // Hand back the tenant list, then land an operator's save before the put.
      listTenants: async () => {
        const listed = (await repo.listTenants()).filter((t) => t.tenant === T);
        const cur = await repo.getTenantConfig(T);
        await repo.putTenantConfig({ ...cur!, submissionDeadline: '2026-12-31' });
        return listed;
      },
    };
    const result = await migrateLeagueSetups({
      confirm: true,
      log: () => {},
      store: racing,
      backupDir,
    });
    assert.equal(result.leaguesMigrated, 1);
    const cfg = await repo.getTenantConfig(T);
    assert.equal(cfg?.submissionDeadline, '2026-12-31', 'the concurrent save is kept');
    assert.deepEqual(cfg?.leagues?.[0].setup, { structureId: 'st-r', calendarId: 'cal-r' });
  });
});
