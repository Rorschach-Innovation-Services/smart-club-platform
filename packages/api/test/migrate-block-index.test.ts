/**
 * Tests for scripts/migrate-block-index.ts — the one-off rewrite of legacy
 * `StageSchedule.blockId` into `StageSchedule.blockIndex`, on BOTH `TenantConfig.structures`
 * and `SeasonRun.structureSnapshot`.
 *
 * Same harness as season-venues.int.test.ts: in-process dynalite, real repo functions
 * (`listTenants`/`putTenantConfig`/`listSeasonRuns`/`putSeasonRun`) — the script only ever
 * calls repo, never touches DynamoDB directly, so this exercises it exactly as `sst shell`
 * would, minus AWS.
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
  TenantConfig,
} from '../src/types.js';

const DDB_PORT = 4609; // distinct from api.int (4599), platform.int (4601), logo-offline (4603), backfill-team (4605), season-venues (4607)
const TABLE = 'SmartClubMigrateBlockIndexTest';
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.STAGE = 'local';
process.env.AWS_REGION ??= 'localhost';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_MAX_ATTEMPTS = '1';

// Resolved in before().
let ddbServer: Server;
let repo: typeof import('../src/repo.js');
let migrateBlockIndex: (typeof import('../scripts/migrate-block-index.js'))['migrateBlockIndex'];

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
  ({ migrateBlockIndex } = await import('../scripts/migrate-block-index.js'));
});

after(() => {
  ddbServer?.close();
});

/** A minimal but complete TenantConfig — enough to pass createTenantConfig's shape. */
const baseConfig = (tenant: string): TenantConfig => ({
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
});

const cal = (id: string, blockIds: string[]): SeasonCalendar => ({
  id,
  label: id,
  blocks: blockIds.map((bid, i) => ({
    id: bid,
    label: `Block ${i + 1}`,
    start: '2026-09-01',
    end: '2026-12-01',
  })),
});

/** A single-stage structure still on the legacy `blockId` shape, optionally carrying the
 *  authorial `calendarId`. Cast through `unknown` — `CompetitionStructure` no longer types
 *  `calendarId`, but the raw stored JSON (and the migration script) still has to handle it. */
const legacyStructure = (id: string, blockId: string, calendarId?: string): CompetitionStructure =>
  ({
    id,
    name: id,
    version: 1,
    stages: [
      {
        id: `${id}-stage-1`,
        name: 'Stage 1',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'all-registered' },
        schedule: { blockId, cadence: { kind: 'weekly' } },
      },
    ],
    ...(calendarId !== undefined ? { calendarId } : {}),
  }) as unknown as CompetitionStructure;

describe('migrate-block-index', () => {
  const TENANT = 'migtest';

  test('sets up a tenant with every resolution scenario', async () => {
    const calendars: SeasonCalendar[] = [
      cal('cal-bound', ['legacy-block-1', 'other-1']),
      cal('cal-authored', ['legacy-block-2']),
      cal('cal-coverage', ['legacy-block-3']),
      cal('cal-ambiguous-a', ['legacy-block-4']),
      cal('cal-ambiguous-b', ['legacy-block-4']),
    ];

    const leagues: League[] = [
      {
        key: 'league-1',
        label: 'League 1',
        group: 'Men',
        district: 'All districts',
        competitions: [
          {
            id: 'comp-1',
            label: 'Comp 1',
            structureId: 'st-bound',
            calendarId: 'cal-bound',
          },
        ],
      },
    ];

    const structures: CompetitionStructure[] = [
      // 1. Binding resolution: comp-1 binds st-bound → cal-bound, which HAS legacy-block-1.
      legacyStructure('st-bound', 'legacy-block-1'),
      // 2. structure.calendarId resolution: no competition binds st-authored, but its own
      //    calendarId names cal-authored, which HAS legacy-block-2.
      legacyStructure('st-authored', 'legacy-block-2', 'cal-authored'),
      // 3. Unique-coverage resolution: no binding, no calendarId, exactly one calendar
      //    (cal-coverage) has legacy-block-3.
      legacyStructure('st-coverage', 'legacy-block-3'),
      // 4. Ambiguous coverage: no binding, calendarId points at a calendar that does NOT
      //    have the block, and TWO calendars (cal-ambiguous-a/b) have legacy-block-4.
      legacyStructure('st-ambiguous', 'legacy-block-4', 'cal-bound'),
    ];

    await repo.createTenantConfig({ ...baseConfig(TENANT), calendars, leagues, structures });
  });

  test('dry-run reports every resolution outcome and writes nothing', async () => {
    const lines: string[] = [];
    const result = await migrateBlockIndex({ confirm: false, log: (l) => lines.push(l) });

    assert.equal(
      result.stagesMigrated,
      3,
      'bound + authored + coverage resolve; ambiguous does not',
    );
    assert.equal(result.tenantsChanged, 1);
    assert.equal(result.unresolved.length, 1);
    assert.equal(result.unresolved[0].structureId, 'st-ambiguous');
    assert.equal(result.unresolved[0].reason, 'no-binding-ambiguous-coverage');

    // Nothing persisted — the stored config is untouched.
    const stored = await repo.getTenantConfig(TENANT);
    const storedStructures = stored?.structures as unknown as Array<{
      id: string;
      calendarId?: string;
      stages: Array<{ schedule: { blockId?: string; blockIndex?: number } }>;
    }>;
    assert.equal(
      storedStructures.find((s) => s.id === 'st-bound')?.stages[0].schedule.blockId,
      'legacy-block-1',
    );
    assert.ok(
      !('blockIndex' in storedStructures.find((s) => s.id === 'st-bound')!.stages[0].schedule),
    );

    assert.ok(
      lines.some((l) => l.includes('[dry-run]')),
      'dry-run prefixes its per-tenant lines',
    );
  });

  test('--confirm writes the resolved stages and drops calendarId only where fully resolved', async () => {
    const result = await migrateBlockIndex({ confirm: true, log: () => {} });
    assert.equal(result.stagesMigrated, 3);
    assert.equal(result.tenantsChanged, 1);
    assert.equal(result.unresolved.length, 1);

    const stored = await repo.getTenantConfig(TENANT);
    const byId = new Map(
      (
        stored?.structures as unknown as Array<{
          id: string;
          calendarId?: string;
          stages: Array<{ schedule: { blockId?: string; blockIndex?: number } }>;
        }>
      ).map((s) => [s.id, s]),
    );

    // Binding-resolved: blockIndex written, no calendarId to begin with.
    assert.equal(byId.get('st-bound')?.stages[0].schedule.blockIndex, 0);
    assert.equal(byId.get('st-bound')?.stages[0].schedule.blockId, undefined);

    // calendarId-resolved: blockIndex written, calendarId SHED (fully resolved).
    assert.equal(byId.get('st-authored')?.stages[0].schedule.blockIndex, 0);
    assert.equal(byId.get('st-authored')?.calendarId, undefined);

    // Unique-coverage resolved: blockIndex written.
    assert.equal(byId.get('st-coverage')?.stages[0].schedule.blockIndex, 0);

    // Ambiguous — left untouched, and its calendarId SURVIVES for a human to resolve.
    assert.equal(byId.get('st-ambiguous')?.stages[0].schedule.blockId, 'legacy-block-4');
    assert.equal(byId.get('st-ambiguous')?.stages[0].schedule.blockIndex, undefined);
    assert.equal(byId.get('st-ambiguous')?.calendarId, 'cal-bound');
  });

  test('re-running after --confirm reports zero changes (idempotent)', async () => {
    const result = await migrateBlockIndex({ confirm: true, log: () => {} });
    assert.equal(result.stagesMigrated, 0);
    assert.equal(result.tenantsChanged, 0);
    // The ambiguous stage is still unresolved and still reported every run.
    assert.equal(result.unresolved.length, 1);
    assert.equal(result.unresolved[0].structureId, 'st-ambiguous');
  });
});

describe('migrate-block-index — season runs', () => {
  const TENANT = 'migtest-runs';

  test('sets up a tenant with a resolvable and an unresolvable season run', async () => {
    await repo.createTenantConfig(baseConfig(TENANT));

    const resolvableRun: SeasonRun = {
      id: 'run-resolvable',
      leagueKey: 'league-1',
      competitionId: 'comp-1',
      seasonLabel: '2026/27',
      calendarSnapshot: cal('run-cal-1', ['run-block-1', 'run-block-2']),
      structureSnapshot: legacyStructure('run-structure-1', 'run-block-2', 'cal-should-be-dropped'),
      stages: [],
      version: 1,
    };
    const unresolvableRun: SeasonRun = {
      id: 'run-unresolvable',
      leagueKey: 'league-1',
      competitionId: 'comp-2',
      seasonLabel: '2026/27',
      calendarSnapshot: cal('run-cal-2', ['run-block-3']),
      // Names a block that does not exist on this run's OWN calendarSnapshot.
      structureSnapshot: legacyStructure('run-structure-2', 'nowhere-block', 'cal-should-survive'),
      stages: [],
      version: 1,
    };

    await repo.putSeasonRun(TENANT, resolvableRun);
    await repo.putSeasonRun(TENANT, unresolvableRun);
  });

  test('dry-run reports both runs and writes nothing', async () => {
    const result = await migrateBlockIndex({ confirm: false, log: () => {} });
    assert.equal(result.runsScanned, 2);
    assert.equal(result.runsChanged, 1);
    assert.equal(result.runStagesMigrated, 1);
    assert.equal(result.unresolvedRuns.length, 1);
    assert.equal(result.unresolvedRuns[0].runId, 'run-unresolvable');

    const stored = await repo.getSeasonRun(TENANT, 'run-resolvable');
    const schedule = (
      stored?.structureSnapshot.stages[0] as unknown as {
        schedule: { blockId?: string; blockIndex?: number };
      }
    ).schedule;
    assert.equal(schedule.blockId, 'run-block-2', 'dry-run must not persist');
  });

  test("--confirm migrates the resolvable run's snapshot and leaves the other untouched", async () => {
    const result = await migrateBlockIndex({ confirm: true, log: () => {} });
    assert.equal(result.runStagesMigrated, 1);
    assert.equal(result.unresolvedRuns.length, 1);

    const resolved = await repo.getSeasonRun(TENANT, 'run-resolvable');
    const resolvedSchedule = (
      resolved?.structureSnapshot.stages[0] as unknown as {
        schedule: { blockId?: string; blockIndex?: number };
      }
    ).schedule;
    assert.equal(resolvedSchedule.blockIndex, 1, 'run-block-2 is index 1 on run-cal-1');
    assert.equal(resolvedSchedule.blockId, undefined);
    assert.equal(
      (resolved?.structureSnapshot as unknown as { calendarId?: string }).calendarId,
      undefined,
      'fully resolved snapshot sheds calendarId',
    );
    assert.equal(
      resolved?.version,
      1,
      'migration writes through repo directly — version is untouched',
    );

    const unresolved = await repo.getSeasonRun(TENANT, 'run-unresolvable');
    const unresolvedSchedule = (
      unresolved?.structureSnapshot.stages[0] as unknown as {
        schedule: { blockId?: string; blockIndex?: number };
      }
    ).schedule;
    assert.equal(unresolvedSchedule.blockId, 'nowhere-block', 'left untouched');
    assert.equal(
      (unresolved?.structureSnapshot as unknown as { calendarId?: string }).calendarId,
      'cal-should-survive',
      'unresolved snapshot keeps calendarId for a human to resolve',
    );
  });

  test('re-running after --confirm reports zero run changes (idempotent)', async () => {
    const result = await migrateBlockIndex({ confirm: true, log: () => {} });
    assert.equal(result.runStagesMigrated, 0);
    assert.equal(result.runsChanged, 0);
    assert.equal(result.unresolvedRuns.length, 1);
  });
});

describe('migrate-block-index — ambiguous bindings', () => {
  const TENANT = 'migtest-amb';

  test('two competitions binding one structure to DIFFERENT calendars is unresolved', async () => {
    // Both calendars carry the legacy block — position 0 on one, position 1 on the
    // other — so "just pick the first binding" would migrate to whichever index league
    // sort order happens to favour. The script must refuse instead.
    const calendars: SeasonCalendar[] = [
      cal('amb-cal-a', ['amb-block']),
      cal('amb-cal-b', ['other-block', 'amb-block']),
    ];
    const bindTo = (key: string, compId: string, calendarId: string): League => ({
      key,
      label: key,
      group: 'Men',
      district: 'All districts',
      competitions: [{ id: compId, label: compId, structureId: 'st-multi-bound', calendarId }],
    });
    await repo.createTenantConfig({
      ...baseConfig(TENANT),
      calendars,
      leagues: [
        bindTo('league-a', 'comp-a', 'amb-cal-a'),
        bindTo('league-b', 'comp-b', 'amb-cal-b'),
      ],
      structures: [legacyStructure('st-multi-bound', 'amb-block')],
    });

    const result = await migrateBlockIndex({ confirm: true, log: () => {} });
    const entry = result.unresolved.find((u) => u.structureId === 'st-multi-bound');
    assert.ok(entry, 'reported as unresolved');
    assert.equal(entry?.reason, 'ambiguous-bindings');

    const stored = await repo.getTenantConfig(TENANT);
    const st = (
      stored?.structures as unknown as Array<{
        id: string;
        stages: Array<{ schedule: { blockId?: string; blockIndex?: number } }>;
      }>
    ).find((s) => s.id === 'st-multi-bound');
    assert.equal(st?.stages[0].schedule.blockId, 'amb-block', 'left untouched');
    assert.equal(st?.stages[0].schedule.blockIndex, undefined);
  });
});
