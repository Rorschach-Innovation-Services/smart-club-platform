/**
 * Integration tests for `POST /season-runs/quick-start` — an admin starting a season for a
 * league with no competition bound, by naming a template from the closed registry.
 *
 * What is pinned:
 * - admin-only (a rep 403s) and the 400/409 guards;
 * - the server writes calendar (when new) + structure (`source: 'quick-start'`, version 1)
 *   + binding into tenant config, and the run's snapshots are exactly what was written;
 * - placement over a multi-block calendar, with `startAfter` chaining for stages sharing a
 *   block;
 * - the 201 carries `warnings` only when a block of the chosen calendar is left unused;
 * - `POST /season-runs` refuses the retired `__flat__` sentinel.
 *
 * Same harness as season-run-rebase.int.test.ts: in-process dynalite + the REAL Hono app.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { League, SeasonCalendar, SeasonRun } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4643; // next free odd port after series-run-snapshot (4641)
const TABLE = 'SmartClubSeasonQuickStartTest';
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

const TENANT = 'dolphins';
const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
const ADMIN = devAuth('admin@test', [{ tenantId: TENANT, role: 'admin', clubIds: [] }]);
const REP = devAuth('rep@test', [{ tenantId: TENANT, role: 'rep', clubIds: ['testers'] }]);

const headers = (auth: string) => ({
  'x-tenant': TENANT,
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

const TWO_BLOCKS: SeasonCalendar = {
  id: 'cal-2627',
  label: '2026/27',
  blocks: [
    { id: 'b1', label: 'Block 1', start: '2026-09-13', end: '2026-12-13' },
    { id: 'b2', label: 'Block 2', start: '2027-01-10', end: '2027-03-28' },
  ],
};

const league = (key: string, label: string): League => ({
  key,
  label,
  group: 'Men',
  district: 'All districts',
});

const LEAGUES: League[] = [
  league('premier-men', 'Premier Men'),
  league('promotion-men', 'Promotion Men'),
  league('div-one', 'Division 1'),
  league('div-two', 'Division 2'),
  league('bound', 'Bound League'),
];

// Resolved in before().
let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');

const quickStart = (body: unknown, auth = ADMIN) =>
  app.request('/season-runs/quick-start', {
    method: 'POST',
    headers: headers(auth),
    body: JSON.stringify(body),
  });

const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
const codeOf = async (res: Response) => ((await res.json()) as { code?: string }).code;

interface QuickStartResponse {
  run: SeasonRun;
  competitionId: string;
  structureId: string;
  calendarId: string;
  warnings?: string[];
}

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
  await seed.seedTenantConfig(TENANT);
  ({ app } = await import('../src/index.js'));
  repo = await import('../src/repo.js');

  const cfg = await repo.getTenantConfig(TENANT);
  await repo.putTenantConfig({
    ...cfg!,
    leagues: LEAGUES.map((l) =>
      // One league already binds a competition to the two-block calendar.
      l.key === 'bound'
        ? {
            ...l,
            competitions: [
              {
                id: 'cmp-existing',
                label: '50 Over',
                structureId: 'st-existing',
                calendarId: 'cal-2627',
              },
            ],
          }
        : l,
    ),
    calendars: [TWO_BLOCKS],
    structures: [
      {
        id: 'st-existing',
        name: 'Existing',
        version: 1,
        stages: [
          {
            id: 'season',
            name: 'Season',
            format: { kind: 'round-robin', legs: 1 },
            entrants: { kind: 'all-registered' },
            schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
          },
        ],
      },
    ],
  });
});

after(() => {
  ddbServer?.close();
});

describe('POST /season-runs/quick-start — guards', () => {
  const valid = {
    leagueKey: 'premier-men',
    templateId: 'flat-round-robin',
    seasonLabel: '2030/31',
    calendar: { label: 'Guard season', start: '2030-09-01', end: '2031-03-31' },
  };

  test('a club rep cannot quick start', async () => {
    assert.equal((await quickStart(valid, REP)).status, 403);
  });

  test('an unknown or missing template is a 400', async () => {
    const res = await quickStart({ ...valid, templateId: 'no-such-template' });
    assert.equal(res.status, 400);
    assert.match(await errorOf(res), /known template/);
    assert.equal((await quickStart({ ...valid, templateId: undefined })).status, 400);
  });

  test('a blank season label, unknown league or unknown calendar is a 400', async () => {
    assert.equal((await quickStart({ ...valid, seasonLabel: '  ' })).status, 400);
    const noLeague = await quickStart({ ...valid, leagueKey: 'nope' });
    assert.equal(noLeague.status, 400);
    assert.match(await errorOf(noLeague), /unknown league/);
    const noCal = await quickStart({ ...valid, calendar: { id: 'cal-nope' } });
    assert.equal(noCal.status, 400);
    assert.match(await errorOf(noCal), /unknown calendar/);
  });

  test('bad dates are a 400 — strict YYYY-MM-DD, end on or after start', async () => {
    for (const calendar of [
      { label: 'X', start: '2030-02-31', end: '2031-03-31' },
      { label: 'X', start: '01/09/2030', end: '2031-03-31' },
      { label: 'X', start: '2031-03-31', end: '2030-09-01' },
      { label: '', start: '2030-09-01', end: '2031-03-31' },
      'cal-2627',
    ]) {
      const res = await quickStart({ ...valid, calendar });
      assert.equal(res.status, 400, JSON.stringify(calendar));
    }
    // The date refusals are coded so the console can say how to type a date.
    for (const calendar of [
      { label: 'X', start: '2030-02-31', end: '2031-03-31' },
      { label: 'X', start: '2031-03-31', end: '2030-09-01' },
    ])
      assert.equal(await codeOf(await quickStart({ ...valid, calendar })), 'invalid_dates');
  });

  test('placement must be one in-range whole number per stage', async () => {
    const pools = { ...valid, templateId: 'pools-to-knockout', calendar: { id: 'cal-2627' } };
    for (const placement of [[0], [0, 2], [0, 1.5], [-1, 0], 'x'])
      assert.equal(
        (await quickStart({ ...pools, placement })).status,
        400,
        JSON.stringify(placement),
      );
    // The message describes the 0-based check it made, not 1-based block labels.
    const res = await quickStart({ ...pools, placement: [0, 2] });
    const body = (await res.json()) as { error: string; code?: string };
    assert.match(body.error, /each stage's block must be between 0 and 1 \(0 = first block\)$/);
    assert.equal(body.code, 'bad_placement');
  });

  test('a malformed matchFormat is a 400', async () => {
    for (const matchFormat of ['50', { overs: 0 }, { overs: 'fifty' }, { label: ' ' }])
      assert.equal(
        (await quickStart({ ...valid, matchFormat })).status,
        400,
        JSON.stringify(matchFormat),
      );
  });

  test('none of the 400s wrote anything', async () => {
    const cfg = await repo.getTenantConfig(TENANT);
    assert.deepEqual(
      cfg?.calendars?.map((c) => c.id),
      ['cal-2627'],
    );
    assert.deepEqual(
      cfg?.structures?.map((s) => s.id),
      ['st-existing'],
    );
    assert.equal((await repo.listSeasonRuns(TENANT)).length, 0);
  });

  test('a league already bound to that calendar is a 409 — use Start a season', async () => {
    const res = await quickStart({
      ...valid,
      leagueKey: 'bound',
      calendar: { id: 'cal-2627' },
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; code?: string };
    assert.match(body.error, /already has a competition on "2026\/27"/);
    assert.equal(body.code, 'competition_exists');
  });
});

describe('POST /season-runs/quick-start — custom dates', () => {
  let body: QuickStartResponse;

  test('201: mints a calendar, a quick-start structure, a binding and a run', async () => {
    const res = await quickStart({
      leagueKey: 'premier-men',
      templateId: 'flat-round-robin',
      seasonLabel: ' 2026/27 ',
      calendar: { label: 'Premier 2026/27', start: '2026-09-13', end: '2027-03-28' },
      matchFormat: { label: '50 Over', overs: 50 },
    });
    assert.equal(res.status, 201);
    body = (await res.json()) as QuickStartResponse;

    const cfg = await repo.getTenantConfig(TENANT);
    const calendar = cfg?.calendars?.find((c) => c.id === body.calendarId);
    assert.deepEqual(calendar, {
      id: body.calendarId,
      label: 'Premier 2026/27',
      blocks: [{ id: 'b1', label: 'Season', start: '2026-09-13', end: '2027-03-28' }],
    });

    const structure = cfg?.structures?.find((s) => s.id === body.structureId);
    assert.equal(structure?.source, 'quick-start');
    assert.equal(structure?.version, 1);
    assert.equal(structure?.templateId, 'flat-round-robin');
    assert.equal(structure?.name, 'Premier Men · Flat round robin');

    const league = cfg?.leagues?.find((l) => l.key === 'premier-men');
    assert.deepEqual(league?.competitions, [
      {
        id: body.competitionId,
        label: '50 Over',
        matchFormat: { label: '50 Over', overs: 50 },
        structureId: body.structureId,
        calendarId: body.calendarId,
      },
    ]);

    const run = body.run;
    assert.equal(run.leagueKey, 'premier-men');
    assert.equal(run.competitionId, body.competitionId);
    assert.equal(run.seasonLabel, '2026/27', 'trimmed');
    assert.equal(run.version, 1);
    assert.equal(run.createdBy, 'admin@test');
    assert.ok(run.createdAt);
    assert.deepEqual(run.structureSnapshot, structure, 'snapshot is exactly what was written');
    assert.deepEqual(run.calendarSnapshot, calendar);
    assert.deepEqual(run.stages, [{ specId: 'season', status: 'awaiting-entrants', groups: [] }]);
    assert.deepEqual(await repo.getSeasonRun(TENANT, run.id), run, 'the run is stored');
    assert.equal('warnings' in body, false, 'a one-block custom calendar is fully covered');
  });

  test('the same league + season label again is a 409', async () => {
    const res = await quickStart({
      leagueKey: 'premier-men',
      templateId: 'flat-round-robin',
      seasonLabel: '2026/27',
      calendar: { label: 'Again', start: '2026-09-13', end: '2027-03-28' },
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; code?: string };
    assert.match(body.error, /already running/);
    assert.equal(body.code, 'season_exists');
  });

  test('the league is now bound to its new calendar, so quick start on it 409s', async () => {
    const res = await quickStart({
      leagueKey: 'premier-men',
      templateId: 'flat-round-robin',
      seasonLabel: '2027/28',
      calendar: { id: body.calendarId },
    });
    assert.equal(res.status, 409);
  });

  test('another league quick-starting reuses nothing and mints its own structure', async () => {
    const res = await quickStart({
      leagueKey: 'promotion-men',
      templateId: 'flat-round-robin',
      seasonLabel: '2026/27',
      calendar: { label: 'Promotion 2026/27', start: '2026-09-13', end: '2027-03-28' },
    });
    assert.equal(res.status, 201);
    const second = (await res.json()) as QuickStartResponse;
    assert.notEqual(second.structureId, body.structureId);
    assert.notEqual(second.calendarId, body.calendarId);
    assert.notEqual(second.competitionId, body.competitionId);
    const cfg = await repo.getTenantConfig(TENANT);
    assert.equal(cfg?.structures?.filter((s) => s.source === 'quick-start').length, 2);
    // No matchFormat ⇒ the competition is labelled with the template's name.
    const comp = cfg?.leagues?.find((l) => l.key === 'promotion-men')?.competitions?.[0];
    assert.equal(comp?.label, 'Flat round robin');
    assert.equal(comp?.matchFormat, undefined);
  });
});

describe('POST /season-runs/quick-start — existing calendar', () => {
  test('201 without minting a calendar', async () => {
    const before = await repo.getTenantConfig(TENANT);
    const res = await quickStart({
      leagueKey: 'div-one',
      templateId: 'flat-round-robin',
      seasonLabel: '2026/27',
      calendar: { id: 'cal-2627' },
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as QuickStartResponse;
    assert.equal(body.calendarId, 'cal-2627');
    const after = await repo.getTenantConfig(TENANT);
    assert.deepEqual(after?.calendars, before?.calendars, 'no calendar added');
    assert.deepEqual(body.run.calendarSnapshot, TWO_BLOCKS);
    // Default placement over two blocks: the single stage opens in block 1.
    assert.equal(body.run.structureSnapshot.stages[0].schedule.blockIndex, 0);
    // Both competitions on this calendar play in block 1, so block 2 is unused.
    assert.deepEqual(body.warnings, [
      '2026/27: Block 2 (10 Jan 2027 → 28 Mar 2027) — no competition on this calendar uses it',
    ]);
  });

  test('explicit placement over a two-block calendar places stages and chains same-block ones', async () => {
    const res = await quickStart({
      leagueKey: 'div-two',
      templateId: 'pools-to-knockout',
      seasonLabel: '2026/27',
      calendar: { id: 'cal-2627' },
      // Both stages in the second block: the knockout must chain after the pools.
      placement: [1, 1],
    });
    assert.equal(res.status, 201);
    const { run } = (await res.json()) as QuickStartResponse;
    const [pools, finals] = run.structureSnapshot.stages;
    assert.equal(pools.schedule.blockIndex, 1);
    assert.equal(pools.schedule.startAfter, undefined, 'the first stage chains onto nothing');
    assert.equal(finals.schedule.blockIndex, 1);
    assert.equal(finals.schedule.startAfter, 'previous-stage');
    assert.deepEqual(
      run.stages.map((s) => s.specId),
      ['pools', 'finals'],
    );
    assert.ok(run.stages.every((s) => s.status === 'awaiting-entrants'));
  });

  test('placement across blocks drops the chaining', async () => {
    const cfg = await repo.getTenantConfig(TENANT);
    await repo.putTenantConfig({
      ...cfg!,
      leagues: [...(cfg!.leagues ?? []), league('juniors', 'Juniors')],
    });
    const res = await quickStart({
      leagueKey: 'juniors',
      templateId: 'pools-to-knockout',
      seasonLabel: '2026/27',
      calendar: { id: 'cal-2627' },
      placement: [0, 1],
    });
    assert.equal(res.status, 201);
    const { run } = (await res.json()) as QuickStartResponse;
    const [pools, finals] = run.structureSnapshot.stages;
    assert.equal(pools.schedule.blockIndex, 0);
    assert.equal(finals.schedule.blockIndex, 1);
    assert.equal(finals.schedule.startAfter, undefined);
  });
});

describe('POST /season-runs — the flat sentinel is retired', () => {
  test('__flat__ is a 400 pointing at quick start', async () => {
    const res = await app.request('/season-runs', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({
        id: 'run-flat',
        leagueKey: 'premier-men',
        competitionId: '__flat__',
        seasonLabel: '2031/32',
        structureSnapshot: {
          id: 'st-flat-default',
          name: 'Flat season',
          version: 1,
          stages: [
            {
              id: 'stage-1',
              name: '2031/32',
              format: { kind: 'round-robin', legs: 1 },
              entrants: { kind: 'all-registered' },
              schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
            },
          ],
        },
        calendarSnapshot: TWO_BLOCKS,
        stages: [],
        flatFormat: { seriesType: 'One Day', overs: 50 },
      }),
    });
    assert.equal(res.status, 400);
    assert.match(await errorOf(res), /flat seasons are no longer supported; use quick start/);
    assert.equal(await repo.getSeasonRun(TENANT, 'run-flat'), null);
  });
});
