/**
 * Tests for scripts/migrate-flat-runs.ts — the one-off rewrite of season runs stored under
 * the retired `__flat__` sentinel onto a real competition + structure (+ calendar when the
 * run's dates exist nowhere in config).
 *
 * Same harness as migrate-block-index.test.ts (in-process dynalite, real repo functions),
 * plus the REAL Hono app for the one thing only a route can prove: a migrated run rebases
 * cleanly, keeping `stage-1` and its confirmed groups.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type {
  CompetitionStructure,
  League,
  SeasonCalendar,
  SeasonRun,
  Series,
  TenantConfig,
} from '../src/types.js';

const DDB_PORT = 4645; // next free odd port after season-quick-start (4643)
const TABLE = 'SmartClubMigrateFlatRunsTest';
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

// Resolved in before().
let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let migrateFlatRuns: (typeof import('../scripts/migrate-flat-runs.js'))['migrateFlatRuns'];

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

  ({ app } = await import('../src/index.js'));
  repo = await import('../src/repo.js');
  ({ migrateFlatRuns } = await import('../scripts/migrate-flat-runs.js'));
});

after(() => {
  ddbServer?.close();
});

const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');

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

const league = (key: string): League => ({
  key,
  label: key,
  group: 'Men',
  district: 'All districts',
});

const singleBlock = (id: string, label: string, start: string, end: string, blockId = 'b1') =>
  ({
    id,
    label,
    blocks: [{ id: blockId, label: 'Season', start, end }],
  }) satisfies SeasonCalendar;

/** The snapshot shape the flat-season client wrote (see buildFlatSeasonRun). */
const flatStructure = (seasonLabel: string): CompetitionStructure => ({
  id: 'st-flat-default',
  name: 'Flat season',
  version: 1,
  stages: [
    {
      id: 'stage-1',
      name: seasonLabel,
      format: { kind: 'round-robin', legs: 1 },
      entrants: { kind: 'all-registered' },
      schedule: {
        blockIndex: 0,
        cadence: { kind: 'every-n-weeks', n: 2 },
        activateFrom: '2026-10-01',
      },
    },
  ],
});

const flatRun = (over: Partial<SeasonRun> & Pick<SeasonRun, 'id' | 'leagueKey'>): SeasonRun => ({
  competitionId: '__flat__',
  seasonLabel: '2026/27',
  structureSnapshot: flatStructure('2026/27'),
  calendarSnapshot: singleBlock('cal-flat-x', '2026/27', '2026-09-01', '2027-03-31'),
  stages: [{ specId: 'stage-1', status: 'awaiting-entrants', groups: [] }],
  version: 1,
  flatFormat: { seriesType: 'One Day', overs: 50 },
  ...over,
});

const series = (id: string, seasonRunId: string, calendarId: string): Series => ({
  id,
  name: `Series ${id}`,
  startDate: '2026-09-01',
  teams: ['a', 'b'],
  fixtures: [],
  schedule: { calendarId, blockId: 'b1', cadence: { kind: 'weekly' } },
  seasonRunId,
  stageSpecId: 'stage-1',
  groupId: 'g1',
  released: true,
  releasedAt: '2026-08-20T00:00:00.000Z',
  approved: true,
  approvedAt: '2026-08-19T00:00:00.000Z',
  version: 3,
});

describe('migrate-flat-runs', () => {
  const T = 'flatmig';
  const OP_CAL = singleBlock('cal-op', 'Operator 2026/27', '2026-09-13', '2027-03-28');
  // Same dates as a custom-dates flat run below, but its own block id — rule 2 reuses it.
  const OP_CAL_2 = singleBlock('cal-op-2', 'Division 2 dates', '2026-10-01', '2027-02-28', 'blk-x');

  test('sets up a custom-dates run, a config-calendar run, a dates-match run and a real run', async () => {
    await repo.createTenantConfig(
      baseConfig(T, {
        leagues: [league('premier-men'), league('div-one'), league('div-two')],
        calendars: [OP_CAL, OP_CAL_2],
      }),
    );
    await repo.putSeasonRun(
      T,
      flatRun({
        id: 'run-custom',
        leagueKey: 'premier-men',
        calendarSnapshot: singleBlock(
          'cal-flat-premier-men',
          '2026/27',
          '2026-09-01',
          '2027-03-31',
        ),
        stages: [
          {
            specId: 'stage-1',
            status: 'generated',
            groups: [
              { id: 'g1', label: 'Group A', entrants: ['a', 'b', 'c'], seriesId: 's-custom' },
            ],
          },
        ],
      }),
    );
    await repo.putSeries(T, series('s-custom', 'run-custom', 'cal-flat-premier-men'));
    // An operator calendar, its first-round start clamped in the snapshot — still reused.
    await repo.putSeasonRun(
      T,
      flatRun({
        id: 'run-config',
        leagueKey: 'div-one',
        calendarSnapshot: { ...OP_CAL, blocks: [{ ...OP_CAL.blocks[0], start: '2026-09-20' }] },
        flatFormat: { seriesType: 'T20', overs: 20 },
      }),
    );
    await repo.putSeasonRun(
      T,
      flatRun({
        id: 'run-match',
        leagueKey: 'div-two',
        calendarSnapshot: singleBlock('cal-flat-div-two', '2026/27', '2026-10-01', '2027-02-28'),
      }),
    );
    await repo.putSeries(T, series('s-match', 'run-match', 'cal-flat-div-two'));
    // A real (non-flat) run — never touched.
    await repo.putSeasonRun(T, {
      ...flatRun({ id: 'run-real', leagueKey: 'premier-men', seasonLabel: '2025/26' }),
      competitionId: 'comp-real',
      flatFormat: undefined,
    });
  });

  test('dry-run plans every run and writes nothing', async () => {
    const lines: string[] = [];
    const result = await migrateFlatRuns({ confirm: false, log: (l) => lines.push(l) });
    assert.equal(result.runsFound, 3);
    assert.equal(result.runsMigrated, 3);
    const byRun = new Map(result.plans.map((p) => [p.runId, p]));
    assert.equal(byRun.get('run-custom')?.calendarAction, 'append');
    assert.equal(byRun.get('run-config')?.calendarAction, 'reuse');
    assert.equal(byRun.get('run-match')?.calendarAction, 'reuse (dates match)');
    assert.equal(byRun.get('run-match')?.calendarId, 'cal-op-2');
    assert.equal(byRun.get('run-match')?.seriesRewritten, 1);
    assert.equal(byRun.get('run-custom')?.seriesRewritten, 0);
    assert.ok(
      lines.some((l) => l.includes('[dry-run] flatmig')),
      'per-tenant table printed',
    );

    const cfg = await repo.getTenantConfig(T);
    assert.deepEqual(
      cfg?.calendars?.map((c) => c.id),
      ['cal-op', 'cal-op-2'],
    );
    assert.equal(cfg?.structures, undefined);
    assert.equal((await repo.getSeasonRun(T, 'run-custom'))?.competitionId, '__flat__');
    assert.equal(
      (await repo.getSeries(T, 's-match'))?.schedule?.calendarId,
      'cal-flat-div-two',
      'series untouched',
    );
  });

  test('--confirm migrates a custom-dates run: calendar appended, structure + competition minted', async () => {
    const result = await migrateFlatRuns({ confirm: true, log: () => {} });
    assert.equal(result.runsMigrated, 3);

    const cfg = await repo.getTenantConfig(T);
    const cal = cfg?.calendars?.find((c) => c.id === 'cal-flat-premier-men');
    assert.deepEqual(
      cal,
      singleBlock('cal-flat-premier-men', '2026/27', '2026-09-01', '2027-03-31'),
    );

    const structure = cfg?.structures?.find((s) => s.id === 'st-flat-run-custom');
    assert.equal(structure?.version, 1);
    assert.equal(structure?.templateId, 'flat-round-robin');
    assert.equal(structure?.source, 'migration');
    assert.equal(structure?.name, 'Flat season');
    // Stage id and every schedule field kept exactly.
    assert.deepEqual(structure?.stages, flatStructure('2026/27').stages);

    const comp = cfg?.leagues
      ?.find((l) => l.key === 'premier-men')
      ?.competitions?.find((c) => c.id === 'cmp-flat-run-custom');
    assert.deepEqual(comp, {
      id: 'cmp-flat-run-custom',
      label: 'One Day',
      matchFormat: { label: 'One Day', overs: 50 },
      structureId: 'st-flat-run-custom',
      calendarId: 'cal-flat-premier-men',
    });

    const run = await repo.getSeasonRun(T, 'run-custom');
    assert.equal(run?.competitionId, 'cmp-flat-run-custom');
    assert.deepEqual(run?.structureSnapshot, structure);
    assert.equal(run?.calendarSnapshot.id, 'cal-flat-premier-men');
    assert.equal(run?.flatFormat, undefined, 'flatFormat dropped');
    assert.equal(run?.stages[0].groups[0].seriesId, 's-custom', 'stage progress untouched');
    assert.equal(run?.version, 2, 'version-checked write bumps the version');

    const s = await repo.getSeries(T, 's-custom');
    assert.equal(s?.schedule?.calendarId, 'cal-flat-premier-men', 'id unchanged ⇒ not rewritten');
    assert.equal(s?.version, 3);
  });

  test('--confirm reuses a config calendar without adding one', async () => {
    const cfg = await repo.getTenantConfig(T);
    assert.equal(cfg?.calendars?.filter((c) => c.id === 'cal-op').length, 1);
    const comp = cfg?.leagues?.find((l) => l.key === 'div-one')?.competitions?.[0];
    assert.equal(comp?.calendarId, 'cal-op');
    assert.equal(comp?.label, 'T20');
    const run = await repo.getSeasonRun(T, 'run-config');
    assert.equal(
      run?.calendarSnapshot.blocks[0].start,
      '2026-09-20',
      'the snapshot stays as it was',
    );
  });

  test('--confirm rewrites the run and its series onto a date-matched calendar', async () => {
    const cfg = await repo.getTenantConfig(T);
    assert.deepEqual(
      cfg?.calendars?.map((c) => c.id),
      ['cal-op', 'cal-op-2', 'cal-flat-premier-men'],
      'no calendar appended for the dates match',
    );
    const run = await repo.getSeasonRun(T, 'run-match');
    assert.equal(run?.calendarSnapshot.id, 'cal-op-2');
    assert.equal(run?.calendarSnapshot.blocks[0].id, 'b1', 'block ids stay the snapshot’s own');
    const s = await repo.getSeries(T, 's-match');
    assert.equal(s?.schedule?.calendarId, 'cal-op-2');
    assert.equal(s?.version, 4, 'version-checked series write');
    assert.equal(s?.released, true, 'lifecycle fields preserved');
    assert.equal(s?.approved, true);
    assert.equal(s?.releasedAt, '2026-08-20T00:00:00.000Z');
  });

  test('the real run is untouched', async () => {
    const run = await repo.getSeasonRun(T, 'run-real');
    assert.equal(run?.competitionId, 'comp-real');
    assert.equal(run?.version, 1);
  });

  test('a second run is a no-op', async () => {
    const before = await repo.getTenantConfig(T);
    const result = await migrateFlatRuns({ confirm: true, log: () => {} });
    assert.equal(result.runsFound, 0);
    assert.equal(result.runsMigrated, 0);
    assert.deepEqual(await repo.getTenantConfig(T), before);
  });

  test('a later rebase keeps stage-1 and its groups', async () => {
    const ADMIN = devAuth('admin@flat', [{ tenantId: T, role: 'admin', clubIds: [] }]);
    const OPERATOR = devAuth('op@flat', [{ tenantId: '*', role: 'operator', clubIds: [] }]);
    const rebase = (body: unknown) =>
      app.request('/season-runs/run-custom/rebase', {
        method: 'POST',
        headers: { 'x-tenant': T, 'x-dev-auth': ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // On the migrated version itself: nothing to adopt, the run comes back as stored.
    const same = await rebase({ structureVersion: 1, version: 2 });
    assert.equal(same.status, 200);
    const sameRun = (await same.json()) as SeasonRun;
    assert.equal(sameRun.stages[0].specId, 'stage-1');
    assert.deepEqual(sameRun.stages[0].groups[0].entrants, ['a', 'b', 'c']);

    // An operator renames the structure (v2); adopting it keeps the stage and its groups.
    const cfg = await repo.getTenantConfig(T);
    const renamed = (cfg?.structures ?? []).map((st) =>
      st.id === 'st-flat-run-custom' ? { ...st, name: 'Premier flat season' } : st,
    );
    const put = await app.request(`/platform/tenants/${T}`, {
      method: 'PUT',
      headers: { 'x-dev-auth': OPERATOR, 'content-type': 'application/json' },
      body: JSON.stringify({ structures: renamed }),
    });
    assert.equal(put.status, 200);
    const res = await rebase({ structureVersion: 2, version: 2 });
    assert.equal(res.status, 200);
    const next = (await res.json()) as SeasonRun;
    assert.equal(next.structureSnapshot.version, 2);
    assert.equal(next.structureSnapshot.source, 'migration', 'the operator PUT keeps source');
    assert.deepEqual(
      next.stages.map((s) => s.specId),
      ['stage-1'],
    );
    assert.equal(next.stages[0].status, 'generated');
    assert.deepEqual(next.stages[0].groups[0].entrants, ['a', 'b', 'c']);
    assert.equal(next.stages[0].groups[0].seriesId, 's-custom');
  });
});

describe('migrate-flat-runs — collisions and orphans', () => {
  const T = 'flatmig-edge';

  test('two custom-dates seasons of one league get two calendars; a run whose league is gone is skipped', async () => {
    await repo.createTenantConfig(baseConfig(T, { leagues: [league('l1')] }));
    // Both seasons were minted `cal-flat-l1`, with different dates.
    await repo.putSeasonRun(
      T,
      flatRun({
        id: 'run-s1',
        leagueKey: 'l1',
        calendarSnapshot: singleBlock('cal-flat-l1', '2026/27', '2026-09-01', '2027-03-31'),
      }),
    );
    await repo.putSeasonRun(
      T,
      flatRun({
        id: 'run-s2',
        leagueKey: 'l1',
        seasonLabel: '2027/28',
        calendarSnapshot: singleBlock('cal-flat-l1', '2027/28', '2027-09-01', '2028-03-31'),
      }),
    );
    await repo.putSeasonRun(T, flatRun({ id: 'run-orphan', leagueKey: 'gone' }));

    const result = await migrateFlatRuns({ confirm: true, log: () => {} });
    assert.equal(result.runsMigrated, 2);
    assert.ok(
      result.skipped.some((s) => s.runId === 'run-orphan' && /no longer exists/.test(s.reason)),
    );

    const cfg = await repo.getTenantConfig(T);
    assert.equal(cfg?.calendars?.length, 2);
    for (const id of ['run-s1', 'run-s2']) {
      const run = await repo.getSeasonRun(T, id);
      const cal: SeasonCalendar | undefined = cfg?.calendars?.find(
        (c) => c.id === run?.calendarSnapshot.id,
      );
      assert.ok(cal, `${id}'s calendar is in config`);
      assert.deepEqual(cal?.blocks, run?.calendarSnapshot.blocks, `${id} keeps its own dates`);
    }
    assert.equal((await repo.getSeasonRun(T, 'run-orphan'))?.competitionId, '__flat__');

    // Converged: only the orphan is still found, and nothing more is written.
    const again = await migrateFlatRuns({ confirm: true, log: () => {} });
    assert.equal(again.runsFound, 1);
    assert.equal(again.runsMigrated, 0);
  });
});

describe('migrate-flat-runs — failures are reported, not fatal', () => {
  const T = 'flatmig-fail';
  let main: (typeof import('../scripts/migrate-flat-runs.js'))['main'];
  let store: import('../scripts/migrate-flat-runs.js').MigrationStore;
  const silent = { log: () => {}, error: () => {} };

  before(async () => {
    ({ main } = await import('../scripts/migrate-flat-runs.js'));
    // The real repo, except one series write fails the way a throttled or dropped
    // connection would — not a version conflict.
    store = {
      ...repo,
      updateSeries: async (tenant, id, patch) => {
        if (id === 'ser-broken') throw new Error('connection reset');
        return repo.updateSeries(tenant, id, patch);
      },
    };
  });

  test('a run whose series write throws is skipped with the reason; the next run still migrates', async () => {
    // Each run's dates match a config calendar with another id, so its series are rewritten.
    await repo.createTenantConfig(
      baseConfig(T, {
        leagues: [league('la'), league('lb')],
        calendars: [
          singleBlock('cal-a', 'A dates', '2026-09-05', '2027-03-06'),
          singleBlock('cal-b', 'B dates', '2026-09-12', '2027-03-13'),
        ],
      }),
    );
    await repo.putSeasonRun(
      T,
      flatRun({
        id: 'run-broken',
        leagueKey: 'la',
        calendarSnapshot: singleBlock('cal-flat-la', '2026/27', '2026-09-05', '2027-03-06'),
      }),
    );
    await repo.putSeasonRun(
      T,
      flatRun({
        id: 'run-fine',
        leagueKey: 'lb',
        calendarSnapshot: singleBlock('cal-flat-lb', '2026/27', '2026-09-12', '2027-03-13'),
      }),
    );
    await repo.putSeries(T, series('ser-broken', 'run-broken', 'cal-flat-la'));
    await repo.putSeries(T, series('ser-fine', 'run-fine', 'cal-flat-lb'));

    const lines: string[] = [];
    const result = await migrateFlatRuns({ confirm: true, log: (l) => lines.push(l), store });

    const skip = result.skipped.find((s) => s.tenant === T && s.runId === 'run-broken');
    assert.ok(skip, 'the failed run is reported');
    assert.match(skip!.reason, /connection reset/);
    assert.equal((await repo.getSeasonRun(T, 'run-broken'))?.competitionId, '__flat__');
    // The loop carried on.
    assert.equal((await repo.getSeasonRun(T, 'run-fine'))?.competitionId, 'cmp-flat-run-fine');
    assert.equal((await repo.getSeries(T, 'ser-fine'))?.schedule?.calendarId, 'cal-b');
    // The summary printed, skip included.
    assert.ok(lines.some((l) => /skipped: flatmig-fail · run "run-broken" — write failed/.test(l)));
    assert.ok(lines.some((l) => /^migration complete: /.test(l)));
  });

  test('--confirm exits 1 while anything is skipped; a dry-run and a bad flag behave', async () => {
    assert.equal(await main(['--confirm'], { ...silent, store }), 1);
    // A dry-run reports skips but is not a failure.
    assert.equal(await main(['--dry-run'], silent), 0);
    assert.equal(await main(['--bogus'], silent), 1);
  });

  test('the config is re-read right before the put, so a concurrent save survives', async () => {
    const T2 = 'flatmig-race';
    await repo.createTenantConfig(baseConfig(T2, { leagues: [league('lr')] }));
    await repo.putSeasonRun(T2, flatRun({ id: 'run-race', leagueKey: 'lr' }));
    const racing: typeof store = {
      ...repo,
      // Hand back the tenant list, then land an operator's settings save before the
      // migration gets to this tenant's put.
      listTenants: async () => {
        const listed = await repo.listTenants();
        const cur = await repo.getTenantConfig(T2);
        await repo.putTenantConfig({ ...cur!, submissionDeadline: '2026-12-31' });
        return listed;
      },
    };

    await migrateFlatRuns({ confirm: true, log: () => {}, store: racing });

    const cfg = await repo.getTenantConfig(T2);
    assert.equal(cfg?.submissionDeadline, '2026-12-31', 'the concurrent save is kept');
    assert.equal((await repo.getSeasonRun(T2, 'run-race'))?.competitionId, 'cmp-flat-run-race');
  });
});
