/**
 * Integration tests for `POST /season-runs/:id/stages/:specId/generate` — the server-side
 * write of one season stage (ADR 0014, amending ADR 0004).
 *
 * What is pinned:
 * - admin-only (a rep 403s); 404 for an unknown run or stage; the run-version 409 and the
 *   awaiting-entrants 409;
 * - a 2-group round-robin stage writes two DRAFT series under the deterministic ids
 *   `s-<run>-<stage>-<group>` and updates the run (groups[].seriesId, status generated,
 *   staleSchedule cleared, version bumped);
 * - regenerate replaces in place (same ids, same content, `released: false` kept, a renamed
 *   series keeps its name) and a repeat is idempotent;
 * - a released series is never overwritten without `confirmReleasedOverwrite` (409
 *   `released_overwrite` naming it, nothing written), and with it the overwrite runs
 *   through the SAME in-season clash gate as PATCH /series (structured `venue_clash` 409).
 *
 * Same harness as season-quick-start.int.test.ts: in-process dynalite + the REAL Hono app.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Club, SeasonCalendar, SeasonRun, Series, StageSpec } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4647; // next free odd port after the 4645 suite
const TABLE = 'SmartClubSeasonGenerateTest';
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
const REP = devAuth('rep@test', [{ tenantId: TENANT, role: 'rep', clubIds: ['gen-a'] }]);

const headers = (auth: string) => ({
  'x-tenant': TENANT,
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

const LEAGUE_KEY = 'gen-league';

const CALENDAR: SeasonCalendar = {
  id: 'cal-gen',
  label: '2026/27',
  blocks: [
    { id: 'b1', label: 'Block 1', start: '2026-09-12', end: '2026-12-12' },
    { id: 'b2', label: 'Block 2', start: '2027-01-09', end: '2027-03-27' },
  ],
};

const POOLS: StageSpec = {
  id: 'pools',
  name: 'Pool stage',
  format: { kind: 'round-robin', legs: 1 },
  entrants: { kind: 'seeded-split', groups: { kind: 'even', count: 2 }, method: 'snake' },
  schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
};
const FINAL: StageSpec = {
  id: 'final',
  name: 'Final',
  format: { kind: 'round-robin', legs: 1 },
  entrants: { kind: 'manual' },
  schedule: { blockIndex: 1, cadence: { kind: 'weekly' } },
};

const CLUB_IDS = ['gen-a', 'gen-b', 'gen-c', 'gen-d', 'gen-e', 'gen-f'];

// Resolved in before().
let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');

interface GenerateResponse {
  run: SeasonRun;
  series: Series[];
}
interface ErrorBody {
  error: string;
  code?: string;
  seriesIds?: string[];
  clashes?: Array<{ fixtureId: string; ground: string; with: { seriesId: string } }>;
}

const generate = (runId: string, specId: string, body: unknown, auth = ADMIN) =>
  app.request(`/season-runs/${runId}/stages/${specId}/generate`, {
    method: 'POST',
    headers: headers(auth),
    body: JSON.stringify(body),
  });

/** A fresh run (version 1) on the two-stage structure. */
async function seedRun(id: string): Promise<SeasonRun> {
  const run: SeasonRun = {
    id,
    leagueKey: LEAGUE_KEY,
    competitionId: 'cmp-gen',
    seasonLabel: `Season ${id}`,
    structureSnapshot: {
      id: 'st-gen',
      name: 'Pools then final',
      version: 1,
      stages: [POOLS, FINAL],
    },
    calendarSnapshot: CALENDAR,
    stages: [
      // A rebase's marker: generating is the catch-up it asks for, so it must be cleared.
      { specId: 'pools', status: 'ready', groups: [], staleSchedule: true },
      { specId: 'final', status: 'awaiting-entrants', groups: [] },
    ],
    version: 1,
  };
  await repo.putSeasonRun(TENANT, run);
  return run;
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
    leagues: [
      ...(cfg!.leagues ?? []),
      {
        key: LEAGUE_KEY,
        label: 'Gen League',
        group: 'Men',
        district: 'All districts',
        competitions: [
          {
            id: 'cmp-gen',
            label: '50 Over',
            matchFormat: { overs: 50 },
            structureId: 'st-gen',
            calendarId: 'cal-gen',
          },
        ],
      },
    ],
    calendars: [...(cfg!.calendars ?? []), CALENDAR],
    structures: [
      ...(cfg!.structures ?? []),
      { id: 'st-gen', name: 'Pools then final', version: 1, stages: [POOLS, FINAL] },
    ],
  });
  // Six single-side clubs, each with its own home ground — the generated fixtures carry no
  // venue, so the clash gate reads the home side's club ground.
  for (const id of CLUB_IDS)
    await repo.putClub(TENANT, {
      id,
      name: `Club ${id.slice(4).toUpperCase()}`,
      leagues: [LEAGUE_KEY],
      ground: { venue: `${id.slice(4).toUpperCase()} Gen Oval` },
    } as unknown as Club);
});

after(() => {
  ddbServer?.close();
});

describe('POST /season-runs/:id/stages/:specId/generate — guards', () => {
  test('a club rep cannot generate', async () => {
    await seedRun('run-guard-rep');
    assert.equal((await generate('run-guard-rep', 'pools', { version: 1 }, REP)).status, 403);
  });

  test('an unknown run or stage is a 404', async () => {
    await seedRun('run-guard-404');
    const noRun = await generate('run-nope', 'pools', { version: 1 });
    assert.equal(noRun.status, 404);
    const noStage = await generate('run-guard-404', 'no-such-stage', { version: 1 });
    assert.equal(noStage.status, 404);
  });

  test('a missing version is a 400; a stale version is the PATCH 409', async () => {
    await seedRun('run-guard-version');
    assert.equal((await generate('run-guard-version', 'pools', {})).status, 400);
    const stale = await generate('run-guard-version', 'pools', { version: 7 });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as ErrorBody).error, 'season run changed; refetch');
    assert.equal(await repo.getSeries(TENANT, 's-run-guard-version-pools-g1'), null);
  });

  test('a stage with no confirmed or derivable entrants is a 409', async () => {
    await seedRun('run-guard-awaiting');
    const res = await generate('run-guard-awaiting', 'final', { version: 1 });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as ErrorBody).error, 'stage is awaiting entrants');
    const run = await repo.getSeasonRun(TENANT, 'run-guard-awaiting');
    assert.equal(run!.version, 1, 'the run is untouched');
  });
});

describe('POST /season-runs/:id/stages/:specId/generate — writes', () => {
  const RUN = 'run-gen';
  const g1 = `s-${RUN}-pools-g1`;
  const g2 = `s-${RUN}-pools-g2`;
  let first: GenerateResponse;

  test('a 2-group round-robin stage writes two draft series and updates the run', async () => {
    await seedRun(RUN);
    const res = await generate(RUN, 'pools', { version: 1 });
    assert.equal(res.status, 200);
    first = (await res.json()) as GenerateResponse;

    assert.deepEqual(
      first.series.map((s) => s.id),
      [g1, g2],
    );
    for (const s of first.series) {
      assert.equal(s.released, false);
      assert.equal(s.approved, false);
      assert.equal(s.seasonRunId, RUN);
      assert.equal(s.stageSpecId, 'pools');
      assert.equal(s.teams.length, 3);
      assert.equal(s.fixtures.length, 3, 'a 3-team single round robin is 3 fixtures');
    }
    assert.equal(first.series[0].name, 'Gen League · Pool stage · Group A');
    assert.equal(first.series[0].seriesType, '50 Over');
    assert.equal(first.series[0].schedule?.blockId, 'b1');
    assert.deepEqual((await repo.getSeries(TENANT, g1))?.fixtures, first.series[0].fixtures);

    const pools = first.run.stages.find((s) => s.specId === 'pools')!;
    assert.equal(pools.status, 'generated');
    assert.equal(pools.staleSchedule, undefined);
    assert.deepEqual(
      pools.groups.map((g) => g.seriesId),
      [g1, g2],
    );
    assert.equal(first.run.version, 2);
    const stored = await repo.getSeasonRun(TENANT, RUN);
    assert.equal(stored!.version, 2);
    assert.equal(stored!.stages.find((s) => s.specId === 'pools')!.staleSchedule, undefined);
    // The other stage keeps its StageRun as it was.
    assert.equal(stored!.stages.find((s) => s.specId === 'final')!.status, 'awaiting-entrants');
  });

  test('regenerate replaces in place and keeps released:false and an admin-chosen name', async () => {
    // The admin renamed one series after generating it.
    const renamed = await app.request(`/series/${g1}`, {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ name: 'Pool A (renamed)', version: 1 }),
    });
    assert.equal(renamed.status, 200);

    const res = await generate(RUN, 'pools', { version: 2 });
    assert.equal(res.status, 200);
    const again = (await res.json()) as GenerateResponse;
    assert.deepEqual(
      again.series.map((s) => s.id),
      [g1, g2],
    );
    assert.equal(again.series[0].name, 'Pool A (renamed)');
    assert.equal(again.series[0].released, false);
    assert.equal(again.series[0].version, 3);
    assert.equal(again.series[1].version, 2);
    assert.equal(again.run.version, 3);
    assert.equal((await repo.listSeries(TENANT)).filter((s) => s.seasonRunId === RUN).length, 2);
  });

  test('a repeated call with the same inputs is idempotent — same ids, same content', async () => {
    const before = await repo.listSeries(TENANT);
    const res = await generate(RUN, 'pools', { version: 3 });
    assert.equal(res.status, 200);
    const again = (await res.json()) as GenerateResponse;
    for (const s of again.series) {
      const prev = before.find((p) => p.id === s.id)!;
      assert.deepEqual(s.fixtures, prev.fixtures);
      assert.deepEqual(s.teams, prev.teams);
      assert.deepEqual(s.participants, prev.participants);
      assert.equal(s.startDate, prev.startDate);
    }
    assert.deepEqual(
      again.run.stages.find((s) => s.specId === 'pools')!.groups,
      first.run.stages.find((s) => s.specId === 'pools')!.groups,
    );
    assert.equal(again.run.version, 4);
  });

  test('a released series is not overwritten without confirmation — 409 naming it, nothing written', async () => {
    const stored = (await repo.getSeries(TENANT, g1))!;
    await repo.putSeries(TENANT, {
      ...stored,
      released: true,
      releasedAt: '2026-09-01T00:00:00.000Z',
      approved: true,
    });
    const seriesBefore = await repo.listSeries(TENANT);
    const res = await generate(RUN, 'pools', { version: 4 });
    assert.equal(res.status, 409);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.code, 'released_overwrite');
    assert.deepEqual(body.seriesIds, [g1]);
    // Nothing written: neither series (the draft g2 included) nor the run.
    const seriesAfter = await repo.listSeries(TENANT);
    for (const id of [g1, g2])
      assert.equal(
        seriesAfter.find((s) => s.id === id)!.version,
        seriesBefore.find((s) => s.id === id)!.version,
      );
    assert.equal((await repo.getSeasonRun(TENANT, RUN))!.version, 4);
  });

  test('with confirmation the overwrite runs through the in-season clash gate', async () => {
    // The released schedule was moved off home grounds after release — so regenerating
    // (which puts every fixture back on its home side's ground) changes where games are.
    const stored = (await repo.getSeries(TENANT, g1))!;
    const moved = (stored.fixtures as Array<{ id: string }>).map((f) => ({
      ...f,
      venueOverride: `Elsewhere ${f.id}`,
    }));
    await repo.putSeries(TENANT, { ...stored, fixtures: moved });
    // Meanwhile another competition booked the ground the first regenerated fixture needs.
    const target = first.series[0].fixtures[0] as { date: string; home: string };
    const homeClub = CLUB_IDS.find((id) => id === target.home)!;
    const ground = `${homeClub.slice(4).toUpperCase()} Gen Oval`;
    await repo.putSeries(TENANT, {
      id: 'ext-clash',
      name: 'Another competition',
      startDate: target.date,
      teams: ['x', 'y'],
      fixtures: [
        { id: 'x1', round: 1, date: target.date, home: 'x', away: 'y', venueName: ground },
      ],
      released: false,
      releasedAt: null,
      version: 1,
    } as unknown as Series);

    const res = await generate(RUN, 'pools', { version: 4, confirmReleasedOverwrite: true });
    assert.equal(res.status, 409);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.code, 'venue_clash');
    assert.match(body.error, /^Change blocked — 1 venue clash/);
    assert.equal(body.clashes?.length, 1);
    assert.equal(body.clashes![0].with.seriesId, 'ext-clash');
    assert.equal(body.clashes![0].ground, ground);
    // The released series is untouched.
    const after = (await repo.getSeries(TENANT, g1))!;
    assert.equal(after.released, true);
    assert.deepEqual(after.fixtures, moved);
  });

  test('with confirmation and no clash, the released series is regenerated and stays released', async () => {
    await repo.deleteSeries(TENANT, 'ext-clash');
    const res = await generate(RUN, 'pools', { version: 4, confirmReleasedOverwrite: true });
    assert.equal(res.status, 200);
    const out = (await res.json()) as GenerateResponse;
    const s1 = out.series.find((s) => s.id === g1)!;
    assert.equal(s1.released, true);
    assert.equal(s1.releasedAt, '2026-09-01T00:00:00.000Z', 'releasedAt is not re-stamped');
    assert.deepEqual(s1.fixtures, first.series[0].fixtures);
    assert.equal(out.run.version, 5);
  });
});
