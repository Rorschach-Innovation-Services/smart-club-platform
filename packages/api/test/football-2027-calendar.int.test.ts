/**
 * Phase-1 proof gate for the Smart School vertical (plan 1K): the Cape Peninsula Schools
 * Football League's REAL 2027 Term 2 + Term 3 fixture calendar, generated end-to-end.
 *
 * Built through the real write paths only — the operator creates a football tenant
 * (POST /platform/tenants), configures one age-group league plus a fixtures-only KO Cup,
 * each bound to ITS OWN calendar and structure (PUT /platform/tenants/:slug), the admin
 * starts a season run per competition (POST /season-runs) and generates it
 * (POST /season-runs/:id/stages/:specId/generate). Dates are then checked against the
 * week table on the client's registration form:
 *
 *   Term 2 (from 13 Apr 2027)                      Term 3 (from 20 Jul 2027)
 *   wk1  13–16 Apr  league                          wk11 20–23 Jul  league
 *   wk2  19–24 Apr  league                          wk12 26–30 Jul  league
 *   wk3  28–30 Apr  KO R1                           wk13  2–6 Aug   league
 *   wk4  10–14 May  league                          wk14  semis ("Fri 14 Aug")
 *   wk5  17–21 May  league                          wk15 16–20 Aug  league
 *   wk6  17–21 May  KO R2 (form repeats wk5 dates)  wk16 23–27 Aug  league
 *   wk7  24–28 May  league                          final Fri 3 Sep
 *   wk8  31 May–4 Jun league
 *   wk9   7–11 Jun  KO R3
 *   wk10 14–18 Jun  league + KO R4
 *
 * How the engine carries it (the plan's caution: a stage lives in ONE block, round-robin
 * legs are atomic, excludeDates are calendar-wide — so league and cup cannot share one
 * calendar):
 * - League calendar: ONE block 13 Apr → 27 Aug with the June–July school holiday as a
 *   break, the Wednesdays of the non-league weeks (wk3, the unnumbered 3–7 May week, wk9,
 *   wk14) excluded, and a Wednesday cadence. 12 league Wednesdays; a 12-school single
 *   round robin needs 11.
 * - KO Cup calendar (League.fixturesOnly): ONE block 26 Apr → 3 Sep, the same holiday
 *   break, every Friday that is not a cup week excluded, and a Friday cadence. Six cup
 *   Fridays; a 33–64 entrant knockout is six rounds (preliminary + R32 + R16 + QF + SF + F).
 *   League on Wednesday and cup on Friday means the weeks the form double-books (wk5/wk6,
 *   wk10) never put a school on two fixtures the same day.
 *
 * Same harness as season-generate.int.test.ts: in-process dynalite + the REAL Hono app.
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Club, SeasonCalendar, SeasonRun, Series, StageSpec } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4653; // next free odd port after sport-vertical (4651)
const TABLE = 'SmartClubFootball2027Test';
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

const TENANT = 'cpsfl';
const devAuth = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const OPERATOR = devAuth('op-1', 'operator@platform', [
  { tenantId: '*', role: 'operator', clubIds: [] },
]);
const ADMIN = devAuth('adm-1', 'admin@cpsfl', [{ tenantId: TENANT, role: 'admin', clubIds: [] }]);
const headers = (auth: string) => ({
  'x-tenant': TENANT,
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

// ── The client's form, as data ──

type WeekKind = 'league' | 'ko';
interface FormWeek {
  week: number;
  start: string;
  end: string;
  kind: WeekKind;
  label: string;
}
/** Every numbered week on the form. wk6 repeats wk5's dates verbatim ("*WEEK 6 - ROUND 2
 * KNOCK OUT FIXTURES - 17-21 MAY"); wk14's only anchor on the form is the semis date. */
const FORM_WEEKS: FormWeek[] = [
  { week: 1, start: '2027-04-13', end: '2027-04-16', kind: 'league', label: 'wk1' },
  { week: 2, start: '2027-04-19', end: '2027-04-24', kind: 'league', label: 'wk2' },
  { week: 3, start: '2027-04-28', end: '2027-04-30', kind: 'ko', label: 'KO R1' },
  { week: 4, start: '2027-05-10', end: '2027-05-14', kind: 'league', label: 'wk4' },
  { week: 5, start: '2027-05-17', end: '2027-05-21', kind: 'league', label: 'wk5' },
  { week: 6, start: '2027-05-17', end: '2027-05-21', kind: 'ko', label: 'KO R2' },
  { week: 7, start: '2027-05-24', end: '2027-05-28', kind: 'league', label: 'wk7' },
  { week: 8, start: '2027-05-31', end: '2027-06-04', kind: 'league', label: 'wk8' },
  { week: 9, start: '2027-06-07', end: '2027-06-11', kind: 'ko', label: 'KO R3' },
  { week: 10, start: '2027-06-14', end: '2027-06-18', kind: 'league', label: 'wk10' },
  { week: 10, start: '2027-06-14', end: '2027-06-18', kind: 'ko', label: 'KO R4' },
  { week: 11, start: '2027-07-20', end: '2027-07-23', kind: 'league', label: 'wk11' },
  { week: 12, start: '2027-07-26', end: '2027-07-30', kind: 'league', label: 'wk12' },
  { week: 13, start: '2027-08-02', end: '2027-08-06', kind: 'league', label: 'wk13' },
  // The form says "Fri 14 Aug" — but 14 Aug 2027 is a SATURDAY. Week 14 of this term runs
  // Mon 9 – Fri 13 Aug (wk13 is 2–6 Aug, wk15 16–20 Aug), so the semis' Friday is 13 Aug.
  { week: 14, start: '2027-08-09', end: '2027-08-13', kind: 'ko', label: 'KO semis' },
  { week: 15, start: '2027-08-16', end: '2027-08-20', kind: 'league', label: 'wk15' },
  { week: 16, start: '2027-08-23', end: '2027-08-27', kind: 'league', label: 'wk16' },
  { week: 17, start: '2027-09-03', end: '2027-09-03', kind: 'ko', label: 'KO final' },
];
const leagueWeeks = FORM_WEEKS.filter((w) => w.kind === 'league');
const koWeeks = FORM_WEEKS.filter((w) => w.kind === 'ko');
const inWeek = (date: string, w: FormWeek) => date >= w.start && date <= w.end;
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const WED = 3;
const FRI = 5;

const HOLIDAY = { label: 'June–July school holiday', start: '2027-06-19', end: '2027-07-19' };

/** League: Wednesdays of every league week; the Wednesdays of the other weeks excluded. */
const LEAGUE_CALENDAR: SeasonCalendar = {
  id: 'cal-league-2027',
  label: '2027 league (Terms 2+3)',
  blocks: [{ id: 'terms', label: 'Terms 2 + 3', start: '2027-04-13', end: '2027-08-27' }],
  breaks: [HOLIDAY],
  // wk3 (KO R1), the unnumbered 3–7 May week, wk9 (KO R3), wk14 (KO semis).
  excludeDates: ['2027-04-28', '2027-05-05', '2027-06-09', '2027-08-11'],
};

/** KO Cup: Fridays of the cup weeks only. */
const KO_FRIDAYS = [
  '2027-04-30',
  '2027-05-21',
  '2027-06-11',
  '2027-06-18',
  '2027-08-13',
  '2027-09-03',
];
const KO_CALENDAR: SeasonCalendar = {
  id: 'cal-ko-2027',
  label: '2027 KO Cup',
  blocks: [{ id: 'cup', label: 'KO Cup', start: '2027-04-26', end: '2027-09-03' }],
  breaks: [HOLIDAY],
  excludeDates: [
    '2027-05-07',
    '2027-05-14',
    '2027-05-28',
    '2027-06-04',
    '2027-07-23',
    '2027-07-30',
    '2027-08-06',
    '2027-08-20',
    '2027-08-27',
  ],
};

const LEAGUE_STAGE: StageSpec = {
  id: 'league',
  name: 'League',
  format: { kind: 'round-robin', legs: 1 },
  entrants: { kind: 'all-registered' },
  schedule: { blockIndex: 0, cadence: { kind: 'weekdays', days: [WED] } },
};
const KO_STAGE: StageSpec = {
  id: 'cup',
  name: 'Knockout',
  format: { kind: 'knockout', pairing: 'seeded' },
  entrants: { kind: 'all-registered' },
  schedule: { blockIndex: 0, cadence: { kind: 'weekdays', days: [FRI] } },
};

const U15 = 'boys-u15';
const KO = 'ko-cup';
/** 12 schools in the U15 league; 28 more enter only the cup — 40 cup entrants ⇒ 6 rounds. */
const LEAGUE_SCHOOLS = Array.from(
  { length: 12 },
  (_, i) => `sch-${String(i + 1).padStart(2, '0')}`,
);
const CUP_ONLY_SCHOOLS = Array.from(
  { length: 28 },
  (_, i) => `sch-${String(i + 13).padStart(2, '0')}`,
);

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let clash: typeof import('../src/venue-clash.js');

interface Fixture {
  id: string;
  round: number;
  date: string;
  home: string;
  away: string;
}
interface GenerateResponse {
  run: SeasonRun;
  series: Series[];
  warnings?: string[];
}

async function startRun(
  id: string,
  competitionId: string,
  leagueKey: string,
  stage: StageSpec,
  calendar: SeasonCalendar,
) {
  const res = await app.request('/season-runs', {
    method: 'POST',
    headers: headers(ADMIN),
    body: JSON.stringify({
      id,
      leagueKey,
      competitionId,
      seasonLabel: '2027',
      structureSnapshot: { id: `st-${id}`, name: stage.name, version: 1, stages: [stage] },
      calendarSnapshot: calendar,
      stages: [{ specId: stage.id, status: 'ready', groups: [] }],
    }),
  });
  assert.equal(res.status, 201, await res.clone().text());
}

async function generate(runId: string, specId: string) {
  return app.request(`/season-runs/${runId}/stages/${specId}/generate`, {
    method: 'POST',
    headers: headers(ADMIN),
    body: JSON.stringify({ version: 1 }),
  });
}

/** Round → its (single) date. Fails if a round is split across dates. */
function roundDates(fixtures: Fixture[]): string[] {
  const byRound = new Map<number, Set<string>>();
  for (const f of fixtures) {
    if (!byRound.has(f.round)) byRound.set(f.round, new Set());
    byRound.get(f.round)!.add(f.date);
  }
  return [...byRound.keys()]
    .sort((a, b) => a - b)
    .map((r) => {
      const dates = [...byRound.get(r)!];
      assert.equal(dates.length, 1, `round ${r} is played on one day, got ${dates.join(', ')}`);
      return dates[0];
    });
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
  ({ app } = await import('../src/index.js'));
  repo = await import('../src/repo.js');
  clash = await import('../src/venue-clash.js');

  // 1. The operator creates the football client with its '2027' season label.
  const created = await app.request('/platform/tenants', {
    method: 'POST',
    headers: headers(OPERATOR),
    body: JSON.stringify({
      slug: TENANT,
      branding: { name: 'Cape Peninsula Schools Football' },
      submissionDeadline: '2027-03-01',
      sport: 'football',
      seasonLabel: '2027',
    }),
  });
  assert.equal(created.status, 201, await created.clone().text());

  // 2. Districts, the U15 league and the fixtures-only KO Cup — each bound to its own
  //    calendar + structure — through the operator's config write.
  const put = await app.request(`/platform/tenants/${TENANT}`, {
    method: 'PUT',
    headers: headers(OPERATOR),
    body: JSON.stringify({
      districts: ['North', 'South', 'East', 'West', 'CBD & Atlantic Seaboard'],
      calendars: [LEAGUE_CALENDAR, KO_CALENDAR],
      structures: [
        { id: 'st-league', name: 'Single round robin', version: 1, stages: [LEAGUE_STAGE] },
        { id: 'st-cup', name: 'Knockout cup', version: 1, stages: [KO_STAGE] },
      ],
      leagues: [
        {
          key: U15,
          label: 'Boys U15',
          group: 'Boys',
          district: 'All districts',
          competitions: [
            {
              id: 'cmp-u15',
              label: 'League',
              structureId: 'st-league',
              calendarId: LEAGUE_CALENDAR.id,
            },
          ],
        },
        {
          key: KO,
          label: 'KO Cup',
          group: 'Boys',
          district: 'All districts',
          fixturesOnly: true,
          competitions: [
            { id: 'cmp-ko', label: 'KO Cup', structureId: 'st-cup', calendarId: KO_CALENDAR.id },
          ],
        },
      ],
    }),
  });
  assert.equal(put.status, 200, await put.clone().text());

  // 3. Schools, each with its own home field, affiliation complete.
  const school = (id: string, leagues: string[]) =>
    repo.putClub(TENANT, {
      id,
      name: `School ${id.slice(4)}`,
      district: 'North',
      leagues,
      ground: { venue: `School ${id.slice(4)} Field`, pitchCount: 2 },
      affiliation: 'complete',
    } as unknown as Club);
  for (const id of LEAGUE_SCHOOLS) await school(id, [U15, KO]);
  for (const id of CUP_ONLY_SCHOOLS) await school(id, [KO]);
});

after(() => {
  ddbServer?.close();
});

describe('2027 Cape Peninsula calendar — league + KO Cup on separate calendars', () => {
  let league: Series;
  let cup: Series;

  test('the U15 league generates 11 rounds, one per league week, on Wednesdays', async () => {
    await startRun('run-u15', 'cmp-u15', U15, LEAGUE_STAGE, LEAGUE_CALENDAR);
    const res = await generate('run-u15', 'league');
    assert.equal(res.status, 200, await res.clone().text());
    const out = (await res.json()) as GenerateResponse;
    assert.equal(out.series.length, 1);
    league = out.series[0];
    const fixtures = league.fixtures as Fixture[];
    assert.equal(fixtures.length, 66, '12 schools, single round robin');

    const dates = roundDates(fixtures);
    assert.equal(dates.length, 11);
    // Round r lands in the r-th league week of the form (wk16 is the spare week).
    assert.deepEqual(dates, [
      '2027-04-14', // wk1  13–16 Apr
      '2027-04-21', // wk2  19–24 Apr
      '2027-05-12', // wk4  10–14 May
      '2027-05-19', // wk5  17–21 May
      '2027-05-26', // wk7  24–28 May
      '2027-06-02', // wk8  31 May–4 Jun
      '2027-06-16', // wk10 14–18 Jun
      '2027-07-21', // wk11 20–23 Jul
      '2027-07-28', // wk12 26–30 Jul
      '2027-08-04', // wk13 2–6 Aug
      '2027-08-18', // wk15 16–20 Aug
    ]);
    dates.forEach((date, i) => {
      assert.ok(
        inWeek(date, leagueWeeks[i]),
        `round ${i + 1} (${date}) is in ${leagueWeeks[i].label}`,
      );
      assert.equal(weekday(date), WED);
    });
    // No league fixture in a cup-only week or the holiday.
    for (const f of fixtures) {
      assert.ok(
        leagueWeeks.some((w) => inWeek(f.date, w)),
        `${f.id} on ${f.date} is inside a league week`,
      );
      assert.ok(f.date < HOLIDAY.start || f.date > HOLIDAY.end, `${f.id} avoids the holiday`);
    }
  });

  test('the KO Cup generates six rounds on the cup Fridays, the final on Fri 3 Sep 2027', async () => {
    await startRun('run-ko', 'cmp-ko', KO, KO_STAGE, KO_CALENDAR);
    const res = await generate('run-ko', 'cup');
    assert.equal(res.status, 200, await res.clone().text());
    const out = (await res.json()) as GenerateResponse;
    assert.equal(out.series.length, 1);
    cup = out.series[0];
    const fixtures = cup.fixtures as Fixture[];
    assert.equal(cup.teams.length, 40);

    const dates = roundDates(fixtures);
    assert.deepEqual(dates, KO_FRIDAYS);
    const koOrder = ['KO R1', 'KO R2', 'KO R3', 'KO R4', 'KO semis', 'KO final'];
    dates.forEach((date, i) => {
      const w = koWeeks.find((k) => k.label === koOrder[i])!;
      assert.ok(inWeek(date, w), `cup round ${i + 1} (${date}) is in ${w.label}`);
      assert.equal(weekday(date), FRI);
    });
    // Bracket shape: 8 preliminaries (40 → 32), then 16, 8, 4, 2, 1.
    const perRound = [1, 2, 3, 4, 5, 6].map((r) => fixtures.filter((f) => f.round === r).length);
    assert.deepEqual(perRound, [8, 16, 8, 4, 2, 1]);
    const final = fixtures.filter((f) => f.round === 6);
    assert.equal(final.length, 1);
    assert.equal(final[0].date, '2027-09-03');
    assert.equal(weekday(final[0].date), FRI);
  });

  test('no clash is introduced — no ground double-booked, no school on two fixtures a day', async () => {
    const all = await repo.listSeries(TENANT);
    const [clubs, venues] = await Promise.all([repo.listClubs(TENANT), repo.listVenues(TENANT)]);
    for (const s of [league, cup]) {
      assert.deepEqual(clash.findClashes(s, all, clubs, venues), [], `${s.name} carries no clash`);
    }
    // A school is never booked twice on one date across the two competitions.
    const seen = new Map<string, string>();
    for (const s of [league, cup])
      for (const f of s.fixtures as Fixture[])
        for (const side of [f.home, f.away]) {
          if (!side || side.startsWith('win:') || side.startsWith('lose:')) continue;
          const key = `${side}|${f.date}`;
          assert.ok(
            !seen.has(key),
            `${side} plays twice on ${f.date} (${seen.get(key)} and ${f.id})`,
          );
          seen.set(key, f.id);
        }

    // And the product gate agrees: both series approve and release through PATCH /series,
    // whose release clash gate refuses any double-booking.
    for (const s of [league, cup]) {
      let version = (await repo.getSeries(TENANT, s.id))!.version;
      for (const patch of [{ approved: true }, { released: true }]) {
        const res = await app.request(`/series/${s.id}`, {
          method: 'PATCH',
          headers: headers(ADMIN),
          body: JSON.stringify({ ...patch, version }),
        });
        assert.equal(
          res.status,
          200,
          `${s.id} ${JSON.stringify(patch)}: ${await res.clone().text()}`,
        );
        version = ((await res.json()) as Series).version;
      }
    }
  });

  test('a Term-per-block calendar cannot hold the league — terms must be one block + a holiday break', async () => {
    // The obvious operator modelling (Term 2 and Term 3 as two blocks) puts the whole
    // 11-round round robin in ONE block; Term 2 has 7 league Wednesdays, so it overruns.
    // Pinned so the onboarding runbook keeps the single-block model above.
    const twoBlocks: SeasonCalendar = {
      ...LEAGUE_CALENDAR,
      id: 'cal-two-terms',
      blocks: [
        { id: 't2', label: 'Term 2', start: '2027-04-13', end: '2027-06-18' },
        { id: 't3', label: 'Term 3', start: '2027-07-20', end: '2027-08-27' },
      ],
      breaks: [],
    };
    await startRun('run-two-terms', 'cmp-u15', U15, LEAGUE_STAGE, twoBlocks);
    const res = await generate('run-two-terms', 'league');
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code?: string; error: string };
    assert.equal(body.code, 'does_not_fit');
    assert.match(body.error, /Term 2 fits 7/);
  });
});
