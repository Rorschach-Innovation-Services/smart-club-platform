/**
 * Integration tests for the rep-safe postponement clash hints (`POST /clubs/:id/clash-hints`,
 * ADR 0015). The contract is coarse booleans only, computed from the club-facing projection:
 * drafts, unreleased and not-yet-active series never influence a hint, and `groundBusy` never
 * reflects a booking whose venue is withheld (ADR 0011) — including withheld-within-released.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

const DDB_PORT = 4681; // next free odd port after postponements (4679/4680)
const TABLE = 'SmartClubTest';
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

const devAuth = (memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email: 'rep@test', memberships })).toString('base64');
const REP_HOME = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['home'] }]);
const REP_THIRD = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['third'] }]);

const DAY = 24 * 60 * 60 * 1000;
const d = (n: number) =>
  new Date(Date.now() + 2 * 60 * 60 * 1000 + n * DAY).toISOString().slice(0, 10);

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];

const mkClub = (id: string, name: string, ground: string) => ({
  id,
  name,
  district: 'Test District',
  sub: `sub-${id}`,
  chair: 'Chair',
  affiliation: 'not_started' as const,
  cqi: 0,
  docs: {},
  players: 0,
  teams: 0,
  women: 0,
  juniors: 0,
  color: '#123456',
  ground: { venue: ground },
  leagues: [],
  version: 1,
});

const participants = ['home', 'away', 'third', 'fourth', 'fifth'].map((id) => ({
  teamId: id,
  clubId: id,
  name: `${id} CC`,
}));

const fx = (id: string, date: string, home: string, away: string, extra = {}) => ({
  id,
  round: 1,
  date,
  time: '10:00',
  home,
  away,
  ...extra,
});

const mkSeries = (id: string, fixtures: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  name: `Series ${id}`,
  startDate: d(1),
  teams: participants.map((p) => p.teamId),
  participants,
  fixtures,
  approved: true,
  approvedAt: '2026-05-01T00:00:00.000Z',
  released: true,
  releasedAt: '2026-05-15T00:00:00.000Z',
  version: 1,
  ...extra,
});

// The home club's ground — every booking a test wants to detect (or prove invisible) sits here.
const GLENWOOD = { venueOverride: 'Glenwood Oval' };

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
  await seed.seedTenantConfig('dolphins');
  ({ app } = await import('../src/index.js'));
  const repo = await import('../src/repo.js');

  for (const [id, ground] of [
    ['home', 'Glenwood Oval'],
    ['away', 'Northlands Park'],
    ['third', 'Third Field'],
    ['fourth', 'Fourth Field'],
    ['fifth', 'Fifth Field'],
  ] as const) {
    await repo.createClub('dolphins', mkClub(id, `${id} CC`, ground) as never);
  }

  // The candidate fixtures (home v away) and visible bookings.
  await repo.putSeries(
    'dolphins',
    mkSeries('s-vis', [
      fx('h1', d(14), 'home', 'away'),
      fx('h9', d(15), 'third', 'fourth'),
      // A revealed booking of the home ground on d(21).
      fx('x1', d(21), 'third', 'fourth', GLENWOOD),
      // The away side already plays on d(28) at 14:00.
      fx('x2', d(28), 'away', 'fifth', { time: '14:00' }),
      // A cancelled fixture books nothing.
      fx('x3', d(70), 'third', 'fourth', { ...GLENWOOD, status: 'cancelled' }),
    ]),
  );
  // DRAFT: a Glenwood booking + a home-side match on d(35) — must not influence anything.
  await repo.putSeries(
    'dolphins',
    mkSeries(
      's-draft',
      [fx('dr1', d(35), 'third', 'fifth', GLENWOOD), fx('dr2', d(35), 'home', 'third')],
      { released: false, releasedAt: null, approved: false },
    ),
  );
  // RELEASED but activating in the future: same shape on d(42).
  await repo.putSeries(
    'dolphins',
    mkSeries(
      's-future',
      [fx('fu1', d(42), 'third', 'fourth', GLENWOOD), fx('fu2', d(42), 'home', 'fifth')],
      { activateFrom: d(300) },
    ),
  );
  // RELEASED with the VENUE withheld: a Glenwood booking on d(49) (must not make the ground
  // busy) and an away-side match on d(56) (dates are visible → team-busy is fair game).
  await repo.putSeries(
    'dolphins',
    mkSeries(
      's-wv',
      [fx('wv1', d(49), 'third', 'fifth', GLENWOOD), fx('wv2', d(56), 'away', 'fourth')],
      { withheld: { venue: true } },
    ),
  );
  // RELEASED with the TIME withheld but venue revealed: a 15:00 Glenwood booking on d(63).
  await repo.putSeries(
    'dolphins',
    mkSeries('s-wt', [fx('wt1', d(63), 'fourth', 'fifth', { ...GLENWOOD, time: '15:00' })], {
      withheld: { time: true },
    }),
  );
  // The club's OWN fixture inside a venue-withheld series.
  await repo.putSeries(
    'dolphins',
    mkSeries('s-own-wv', [fx('ow1', d(16), 'home', 'away')], { withheld: { venue: true } }),
  );
});

after(() => {
  ddbServer?.close();
});

type Hint = { groundBusy: boolean; homeTeamBusy: boolean; awayTeamBusy: boolean };

async function hints(
  candidates: Array<{ seriesId: string; fixtureId: string; date: string; time?: string }>,
  auth = REP_HOME,
  club = 'home',
): Promise<Hint[]> {
  const res = await app.request(`/clubs/${club}/clash-hints`, {
    method: 'POST',
    headers: { 'x-tenant': 'dolphins', 'x-dev-auth': auth, 'content-type': 'application/json' },
    body: JSON.stringify({ candidates }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return ((await res.json()) as { results: Hint[] }).results;
}

const move = (date: string, time?: string) => ({
  seriesId: 's-vis',
  fixtureId: 'h1',
  date,
  ...(time ? { time } : {}),
});

const FREE: Hint = { groundBusy: false, homeTeamBusy: false, awayTeamBusy: false };

test('a free date is all-clear; each result is exactly three booleans', async () => {
  const [r] = await hints([move(d(80))]);
  assert.deepEqual(r, FREE);
  assert.deepEqual(Object.keys(r).sort(), ['awayTeamBusy', 'groundBusy', 'homeTeamBusy']);
});

test('a revealed ground booking makes the ground busy; a cancelled one does not', async () => {
  const [busy, cancelled] = await hints([move(d(21)), move(d(70))]);
  assert.deepEqual(busy, { ...FREE, groundBusy: true });
  assert.deepEqual(cancelled, FREE);
});

test('team-busy follows the ledger slot rules', async () => {
  const [sameSlot, otherSlot, untimed] = await hints([
    move(d(28), '14:00'),
    move(d(28), '10:00'),
    move(d(28)),
  ]);
  assert.deepEqual(sameSlot, { ...FREE, awayTeamBusy: true });
  assert.deepEqual(otherSlot, FREE, 'two timed slots on one day do not collide');
  // h1 is stored at 10:00 and a candidate without a time keeps it → still the 10:00 slot.
  assert.deepEqual(untimed, FREE);
});

test('drafts and not-yet-active series never influence a hint', async () => {
  const [draftDay, futureDay] = await hints([move(d(35)), move(d(42))]);
  assert.deepEqual(draftDay, FREE);
  assert.deepEqual(futureDay, FREE);
});

test('withheld-within-released: a withheld-venue booking never makes the ground busy', async () => {
  const [venueHidden, awayPlays] = await hints([move(d(49)), move(d(56))]);
  assert.deepEqual(venueHidden, FREE, 'pre-reveal occupancy must not leak');
  // Dates are never withheld, so the away side's match in the same series still counts.
  assert.deepEqual(awayPlays, { ...FREE, awayTeamBusy: true });
});

test('a withheld-time booking occupies its whole day (no hidden kick-off leaks via slots)', async () => {
  const [r] = await hints([move(d(63), '10:00')]);
  assert.deepEqual(r, { ...FREE, groundBusy: true });
});

test("a candidate in the club's own venue-withheld series never reports the ground busy", async () => {
  const [r] = await hints([{ seriesId: 's-own-wv', fixtureId: 'ow1', date: d(21) }]);
  assert.equal(r.groundBusy, false);
});

test('validation: candidate count, own fixtures only, invisible series 404', async () => {
  const post = (body: unknown, auth = REP_HOME, club = 'home') =>
    app.request(`/clubs/${club}/clash-hints`, {
      method: 'POST',
      headers: { 'x-tenant': 'dolphins', 'x-dev-auth': auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ candidates: [] })).status, 400);
  assert.equal(
    (await post({ candidates: Array.from({ length: 21 }, () => move(d(80))) })).status,
    400,
  );
  assert.equal((await post({ candidates: [{ ...move(d(80)), date: '2026-13-01' }] })).status, 400);
  assert.equal((await post({ candidates: [{ ...move(d(80)), time: '9am' }] })).status, 400);
  // Another club's fixture.
  assert.equal(
    (await post({ candidates: [{ seriesId: 's-vis', fixtureId: 'h9', date: d(80) }] })).status,
    403,
  );
  // A rep cannot ask on behalf of another club.
  assert.equal((await post({ candidates: [move(d(80))] }, REP_THIRD, 'home')).status, 403);
  // Draft / future-active series 404 exactly like a missing one.
  for (const [seriesId, fixtureId] of [
    ['s-draft', 'dr2'],
    ['s-future', 'fu2'],
    ['nope', 'h1'],
  ]) {
    const res = await post({ candidates: [{ seriesId, fixtureId, date: d(80) }] });
    assert.equal(res.status, 404, seriesId);
  }
});
