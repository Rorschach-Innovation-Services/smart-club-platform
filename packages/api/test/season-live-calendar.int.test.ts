/**
 * Integration tests for "a season run's calendar follows the live tenant calendar until
 * its first fixtures are generated" (ADR 0014 Consequences, superseding ADR 0008's
 * "calendar rebase out of scope" for the ungenerated case).
 *
 * What is pinned:
 * - GET /season-runs[/:id] on an ungenerated run returns the calendar its competition is
 *   bound to NOW (an operator date edit, a rebind to another calendar), with
 *   `calendarLive: true` — and never writes the stored snapshot;
 * - the first generate is the freeze point: it materialises against the live calendar,
 *   stores it on the run, and from then on GET serves the stored copy with no overlay,
 *   whatever the operator does to the calendar next;
 * - an ungenerated run whose competition was unbound keeps its stored snapshot and says so
 *   (`calendarLive: false` + `warnings`);
 * - the calendar delete guard counts an ungenerated run by the calendar it FOLLOWS, not
 *   only by the one its stored snapshot names;
 * - a stage that did not fit the start-time calendar generates once the block is
 *   extended, with no delete-and-restart.
 *
 * Same harness as season-venues.int.test.ts: in-process dynalite + the REAL Hono app,
 * with runs started through `POST /season-runs` (season-run-harness.ts).
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type {
  Club,
  CompetitionStructure,
  SeasonCalendar,
  SeasonRun,
  Series,
} from '../src/types.js';
import { bindCompetition, startRunBody } from './season-run-harness.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4651; // next free odd port after backfill-venue-aliases (4649)
const TABLE = 'SmartClubSeasonLiveCalendarTest';
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
const OPERATOR = devAuth('operator@platform', [{ tenantId: '*', role: 'operator', clubIds: [] }]);

const headers = (auth: string) => ({
  'x-tenant': TENANT,
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

const LEAGUE_KEY = 'live-league';
const CLUB_IDS = ['live-a', 'live-b', 'live-c', 'live-d'];

const STRUCTURE: CompetitionStructure = {
  id: 'st-live',
  name: 'Live round robin',
  version: 1,
  stages: [
    {
      id: 'league',
      name: 'League',
      format: { kind: 'round-robin', legs: 1 },
      entrants: { kind: 'all-registered' },
      schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
    },
  ],
};

const cal = (id: string, label: string, start: string, end: string): SeasonCalendar => ({
  id,
  label,
  blocks: [{ id: 'b1', label: 'Block 1', start, end }],
});

// Resolved in before().
let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');

interface GenerateResponse {
  run: SeasonRun;
  series: Series[];
}

const getRun = async (id: string): Promise<SeasonRun> => {
  const res = await app.request(`/season-runs/${id}`, { headers: headers(ADMIN) });
  assert.equal(res.status, 200);
  return (await res.json()) as SeasonRun;
};

const listRun = async (id: string): Promise<SeasonRun | undefined> => {
  const res = await app.request('/season-runs', { headers: headers(ADMIN) });
  assert.equal(res.status, 200);
  return ((await res.json()) as SeasonRun[]).find((r) => r.id === id);
};

const startRun = async (id: string, competitionId: string): Promise<SeasonRun> => {
  const res = await app.request('/season-runs', {
    method: 'POST',
    headers: headers(ADMIN),
    body: JSON.stringify(startRunBody({ id, leagueKey: LEAGUE_KEY, competitionId })),
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as SeasonRun;
};

const generate = (id: string, version: number) =>
  app.request(`/season-runs/${id}/stages/league/generate`, {
    method: 'POST',
    headers: headers(ADMIN),
    body: JSON.stringify({ version }),
  });

/** The operator's real write path: replace one calendar (or drop it with `null`). */
async function operatorPutCalendar(id: string, next: SeasonCalendar | null): Promise<Response> {
  const cfg = await repo.getTenantConfig(TENANT);
  const calendars = (cfg!.calendars ?? [])
    .map((c) => (c.id === id ? next : c))
    .filter((c): c is SeasonCalendar => c !== null);
  return app.request(`/platform/tenants/${TENANT}`, {
    method: 'PUT',
    headers: { 'x-dev-auth': OPERATOR, 'content-type': 'application/json' },
    body: JSON.stringify({ calendars }),
  });
}

const bind = (competitionId: string, calendar: SeasonCalendar) =>
  bindCompetition(repo, TENANT, {
    leagueKey: LEAGUE_KEY,
    competitionId,
    structure: STRUCTURE,
    calendar,
  });

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

  // Four affiliated single-side clubs: a single round robin is 3 rounds.
  for (const id of CLUB_IDS)
    await repo.putClub(TENANT, {
      id,
      name: `Club ${id.slice(5).toUpperCase()}`,
      leagues: [LEAGUE_KEY],
      ground: { venue: `${id.slice(5).toUpperCase()} Live Oval` },
      affiliation: 'complete',
    } as unknown as Club);
});

after(() => {
  ddbServer?.close();
});

describe('an ungenerated season follows the live calendar; the first generate freezes it', () => {
  const START = cal('cal-live-a', 'Live A', '2026-09-13', '2026-12-13');
  const EXTENDED = { ...START, blocks: [{ ...START.blocks[0], end: '2027-02-28' }] };
  const OTHER = cal('cal-live-t20', 'T20 window', '2027-01-10', '2027-03-28');
  const RUN = 'sr-live';

  test('an operator edit to the bound calendar shows on GET at once, flagged live', async () => {
    await bind('comp-live', START);
    const started = await startRun(RUN, 'comp-live');
    assert.deepEqual(started.calendarSnapshot, START);

    const put = await operatorPutCalendar(START.id, EXTENDED);
    assert.equal(put.status, 200, await put.clone().text());

    const got = await getRun(RUN);
    assert.deepEqual(got.calendarSnapshot, EXTENDED);
    assert.equal(got.calendarLive, true);
    assert.equal(got.version, 1, 'the overlay never changes the version a generate sends back');
    const listed = await listRun(RUN);
    assert.deepEqual(listed?.calendarSnapshot, EXTENDED);
    assert.equal(listed?.calendarLive, true);
    // Computed on read — the stored copy is still the start-time one.
    assert.deepEqual((await repo.getSeasonRun(TENANT, RUN))?.calendarSnapshot, START);
  });

  test('re-pointing the competition at another calendar shows THAT calendar', async () => {
    await bind('comp-live', OTHER);
    const got = await getRun(RUN);
    assert.deepEqual(got.calendarSnapshot, OTHER);
    assert.equal(got.calendarLive, true);
  });

  test('generate freezes the calendar as of that moment', async () => {
    const res = await generate(RUN, 1);
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as GenerateResponse;
    for (const s of body.series) {
      assert.equal(s.schedule?.calendarId, OTHER.id);
      assert.ok(
        (s.fixtures as Array<{ date: string }>).every(
          (f) => f.date >= '2027-01-10' && f.date <= '2027-03-28',
        ),
        'fixtures fall in the calendar the season follows now',
      );
    }
    assert.equal(body.run.calendarLive, undefined);
    assert.deepEqual(body.run.calendarSnapshot, OTHER);

    const stored = await repo.getSeasonRun(TENANT, RUN);
    assert.deepEqual(stored?.calendarSnapshot, OTHER);
    assert.equal(stored?.calendarLive, undefined, 'the flag is never stored');

    const got = await getRun(RUN);
    assert.equal(got.calendarLive, undefined);
    assert.deepEqual(got.calendarSnapshot, OTHER);
  });

  test('after generating, a later operator edit no longer reaches the season', async () => {
    const moved = { ...OTHER, blocks: [{ ...OTHER.blocks[0], start: '2027-01-17' }] };
    const put = await operatorPutCalendar(OTHER.id, moved);
    assert.equal(put.status, 200, await put.clone().text());
    const got = await getRun(RUN);
    assert.deepEqual(got.calendarSnapshot, OTHER, 'frozen at the first generate');
    assert.equal(got.calendarLive, undefined);
    assert.deepEqual((await listRun(RUN))?.calendarSnapshot, OTHER);
  });
});

describe('an ungenerated season whose binding is gone', () => {
  test('keeps its stored snapshot and says why', async () => {
    const START = cal('cal-unbind', 'Unbind', '2026-09-13', '2026-12-13');
    await bind('comp-unbind', START);
    await startRun('sr-unbind', 'comp-unbind');

    const cfg = await repo.getTenantConfig(TENANT);
    await repo.putTenantConfig({
      ...cfg!,
      leagues: (cfg!.leagues ?? []).map((l) =>
        l.key === LEAGUE_KEY
          ? { ...l, competitions: (l.competitions ?? []).filter((c) => c.id !== 'comp-unbind') }
          : l,
      ),
    });

    const got = await getRun('sr-unbind');
    assert.deepEqual(got.calendarSnapshot, START);
    assert.equal(got.calendarLive, false);
    assert.deepEqual(got.warnings, [
      "This season's competition or calendar was removed; showing the dates it started with.",
    ]);
    const listed = await listRun('sr-unbind');
    assert.equal(listed?.calendarLive, false);
    assert.equal(listed?.warnings?.length, 1);
  });
});

describe('calendar delete guard', () => {
  test('refuses to delete the calendar an ungenerated run follows, whatever its snapshot names', async () => {
    const STARTED_ON = cal('cal-started', 'Started on', '2026-09-13', '2026-12-13');
    const FOLLOWED = cal('cal-followed', 'Followed', '2026-09-20', '2026-12-20');
    await bind('comp-follow', STARTED_ON);
    await startRun('sr-follow', 'comp-follow');
    await bind('comp-follow', FOLLOWED);
    assert.equal(
      (await repo.getSeasonRun(TENANT, 'sr-follow'))?.calendarSnapshot.id,
      STARTED_ON.id,
      'the stored snapshot names the calendar it started on',
    );

    const res = await operatorPutCalendar(FOLLOWED.id, null);
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /1 season run was started on "Followed"/);
    assert.ok(
      (await repo.getTenantConfig(TENANT))?.calendars?.some((c) => c.id === FOLLOWED.id),
      'nothing was deleted',
    );
  });
});

describe('a stage that did not fit at start', () => {
  test('generates once the block is extended — no delete and restart', async () => {
    // Two Sundays; a 4-side single round robin needs three.
    const SHORT = cal('cal-short', 'Short', '2026-09-13', '2026-09-20');
    await bind('comp-fit', SHORT);
    await startRun('sr-fit', 'comp-fit');

    const refused = await generate('sr-fit', 1);
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { code?: string }).code, 'does_not_fit');

    const widened = { ...SHORT, blocks: [{ ...SHORT.blocks[0], end: '2026-10-11' }] };
    const put = await operatorPutCalendar(SHORT.id, widened);
    assert.equal(put.status, 200, await put.clone().text());

    const res = await generate('sr-fit', 1);
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as GenerateResponse;
    assert.equal(body.series.length, 1);
    assert.equal(body.series[0].fixtures.length, 6);
    assert.deepEqual((await repo.getSeasonRun(TENANT, 'sr-fit'))?.calendarSnapshot, widened);
  });
});
