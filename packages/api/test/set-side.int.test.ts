/**
 * Knockout "Set team" (ADR 0018) through the real PATCH /series/:id: the `setSide` action puts
 * a team into a placeholder side (keeping the placeholder in `slots`), adds an outside team to
 * the participants snapshot, reverts, and refuses a NEW ground clash on drafts and released
 * series alike. Plus the PATCH orphan-side check (risk R7).
 *
 * Same harness as in-season-clash-gate.int.test.ts: in-process dynalite + the real Hono app.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Club, Series } from '../src/types.js';

const DDB_PORT = 4699; // next free odd port after 4697
const TABLE = 'SmartClubSetSideTest';
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

const T = 'titans';
const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
const ADMIN = devAuth('admin@test', [{ tenantId: T, role: 'admin', clubIds: [] }]);
const REP = devAuth('rep@test', [{ tenantId: T, role: 'rep', clubIds: ['irene'] }]);
const headers = (auth: string) => ({
  'x-tenant': T,
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

const BEST3 = 'tbd:Best%203rd%20place';
const RU1 = 'tbd:Runner-up%201';

type Fx = Record<string, unknown> & { id: string };

/** A KO series whose eventual teams are irene + pretoria; centurion plays outside it. */
const koSeries = (id: string, over: Partial<Series> = {}): Series =>
  ({
    id,
    name: `KO ${id}`,
    leagueKey: 'womens-t20',
    startDate: '2027-02-14',
    teams: ['irene', 'pretoria'],
    participants: [
      { teamId: 'irene', clubId: 'irene', name: 'Irene', venue: 'Irene Oval' },
      { teamId: 'pretoria', clubId: 'pretoria', name: 'Pretoria', venue: 'Pretoria Oval' },
    ],
    fixtures: [
      {
        id: 'f1',
        round: 1,
        date: '2027-02-14',
        time: '09:00',
        home: 'pos:s-g-a:1',
        away: BEST3,
        stage: 'Quarter-final',
        venueStatus: 'unresolved',
      },
      {
        id: 'f2',
        round: 2,
        date: '2027-02-21',
        time: '09:00',
        home: 'win:f1',
        away: RU1,
        stage: 'Final',
        venueStatus: 'unresolved',
      },
    ],
    kind: 'series',
    approved: false,
    released: false,
    releasedAt: null,
    version: 1,
    ...over,
  }) as Series;

const club = (id: string, name: string, venue: string, over: Partial<Club> = {}): Club =>
  ({
    id,
    name,
    leagues: ['womens-t20'],
    ground: { venue, lat: -25.8, lon: 28.2 },
    version: 1,
    ...over,
  }) as unknown as Club;

const patch = (id: string, body: Record<string, unknown>, auth = ADMIN) =>
  app.request(`/series/${id}`, {
    method: 'PATCH',
    headers: headers(auth),
    body: JSON.stringify(body),
  });

const setSide = async (
  id: string,
  op: { fixtureId: string; side: 'home' | 'away'; teamId: string | null },
  version?: number,
) => {
  const v = version ?? (await repo.getSeries(T, id))!.version;
  return patch(id, { setSide: op, version: v });
};

const fx = (s: Series | null, id: string) =>
  (s!.fixtures as Fx[]).find((f) => f.id === id) as Fx & {
    slots?: { home?: string; away?: string };
  };

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');

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
  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');
  await repo.putClub(T, club('irene', 'Irene', 'Irene Oval'));
  await repo.putClub(T, club('pretoria', 'Pretoria', 'Pretoria Oval'));
  // Outside every KO series: the "Community Cup winner". Two sides in the T20 cup.
  await repo.putClub(
    T,
    club('centurion', 'Centurion', 'Centurion Park', {
      leagueTeams: { 'womens-t20': 2 },
      teamRosters: {
        'womens-t20': [
          { id: 'tm_cent_a', name: 'Centurion A' },
          { id: 'tm_cent_b', name: 'Centurion B', venue: 'Centurion B Field' },
        ],
      },
    } as Partial<Club>),
  );
});

after(() => new Promise<void>((resolve) => ddbServer.close(() => resolve())));

describe('PATCH /series/:id setSide — Set team', () => {
  test('a series participant goes into a tbd: side; the placeholder is kept in slots', async () => {
    await repo.putSeries(T, koSeries('ko-1'));
    const res = await setSide('ko-1', { fixtureId: 'f1', side: 'away', teamId: 'pretoria' });
    assert.equal(res.status, 200);
    const s = await repo.getSeries(T, 'ko-1');
    const f1 = fx(s, 'f1');
    assert.equal(f1.away, 'pretoria');
    assert.deepEqual(f1.slots, { away: BEST3 });
    assert.equal(f1.home, 'pos:s-g-a:1', 'the other side is untouched');
    assert.equal(s!.version, 2);
    assert.equal(s!.participants!.length, 2, 'no new participant for an existing one');
  });

  test('a team from outside the series joins participants (snapshot) and teams[]', async () => {
    await repo.putSeries(T, koSeries('ko-2'));
    const res = await setSide('ko-2', { fixtureId: 'f2', side: 'away', teamId: 'tm_cent_b' });
    assert.equal(res.status, 200);
    const s = await repo.getSeries(T, 'ko-2');
    assert.equal(fx(s, 'f2').away, 'tm_cent_b');
    assert.ok(s!.teams.includes('tm_cent_b'));
    const p = s!.participants!.find((x) => x.teamId === 'tm_cent_b');
    assert.deepEqual(
      { clubId: p?.clubId, name: p?.name, venue: p?.venue },
      { clubId: 'centurion', name: 'Centurion B', venue: 'Centurion B Field' },
    );
  });

  test('revert puts the placeholder back and drops the slots entry', async () => {
    await repo.putSeries(T, koSeries('ko-3'));
    assert.equal(
      (await setSide('ko-3', { fixtureId: 'f1', side: 'away', teamId: 'irene' })).status,
      200,
    );
    const res = await setSide('ko-3', { fixtureId: 'f1', side: 'away', teamId: null });
    assert.equal(res.status, 200);
    const f1 = fx(await repo.getSeries(T, 'ko-3'), 'f1');
    assert.equal(f1.away, BEST3);
    assert.equal(f1.slots, undefined);
  });

  test('changing a set side keeps the ORIGINAL placeholder (never overwritten)', async () => {
    await repo.putSeries(T, koSeries('ko-4'));
    await setSide('ko-4', { fixtureId: 'f1', side: 'away', teamId: 'irene' });
    const res = await setSide('ko-4', { fixtureId: 'f1', side: 'away', teamId: 'pretoria' });
    assert.equal(res.status, 200);
    const f1 = fx(await repo.getSeries(T, 'ko-4'), 'f1');
    assert.equal(f1.away, 'pretoria');
    assert.deepEqual(f1.slots, { away: BEST3 });
  });

  test('a NEW clash is refused on a draft: the home team brings its ground into a booked slot', async () => {
    // Another series already has Irene Oval at 09:00 on the QF date.
    await repo.putSeries(T, {
      ...koSeries('busy-1'),
      teams: ['irene', 'pretoria'],
      fixtures: [
        {
          id: 'f1',
          round: 1,
          date: '2027-02-14',
          time: '09:00',
          home: 'irene',
          away: 'pretoria',
          venueName: 'Irene Oval',
        },
      ],
    } as Series);
    await repo.putSeries(T, koSeries('ko-5'));
    const before = await repo.getSeries(T, 'ko-5');
    const res = await setSide('ko-5', { fixtureId: 'f1', side: 'home', teamId: 'irene' });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; code: string; clashes: unknown[] };
    assert.equal(body.code, 'venue_clash');
    assert.match(body.error, /^Change blocked/);
    assert.match(body.error, /Best 3rd place/, 'the clash line names the tbd: side in words');
    assert.equal(body.clashes.length, 1);
    const after = await repo.getSeries(T, 'ko-5');
    assert.equal(after!.version, before!.version, 'nothing written');
    assert.equal(fx(after, 'f1').home, 'pos:s-g-a:1');
    await repo.deleteSeries(T, 'busy-1');
  });

  test('a released series takes Set team in-season and stays released; a clash is still refused', async () => {
    await repo.putSeries(
      T,
      koSeries('ko-6', { approved: true, released: true, releasedAt: '2027-01-01T00:00:00Z' }),
    );
    const ok = await setSide('ko-6', { fixtureId: 'f1', side: 'away', teamId: 'pretoria' });
    assert.equal(ok.status, 200);
    const s = await repo.getSeries(T, 'ko-6');
    assert.equal(s!.released, true);
    assert.equal(s!.releasedAt, '2027-01-01T00:00:00Z', 'releasedAt is not re-stamped');

    await repo.putSeries(T, {
      ...koSeries('busy-2'),
      fixtures: [
        {
          id: 'f1',
          round: 1,
          date: '2027-02-14',
          time: '09:00',
          home: 'irene',
          away: 'pretoria',
          venueName: 'Irene Oval',
        },
      ],
    } as Series);
    const res = await setSide('ko-6', { fixtureId: 'f1', side: 'home', teamId: 'irene' });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, 'venue_clash');
    await repo.deleteSeries(T, 'busy-2');
  });

  test('bad requests: unknown team, a non-placeholder side, unknown fixture, versions, reps', async () => {
    await repo.putSeries(T, koSeries('ko-7'));
    const status = async (r: Response | Promise<Response>) => (await r).status;
    assert.equal(
      await status(setSide('ko-7', { fixtureId: 'f1', side: 'away', teamId: 'ghost' })),
      400,
    );
    assert.equal(
      await status(setSide('ko-7', { fixtureId: 'f1', side: 'away', teamId: 'win:f2' })),
      400,
      'a placeholder is not a team',
    );
    assert.equal(
      await status(setSide('ko-7', { fixtureId: 'f9', side: 'away', teamId: 'irene' })),
      404,
    );
    assert.equal(
      await status(setSide('ko-7', { fixtureId: 'f1', side: 'away', teamId: null })),
      409,
      'nothing to revert',
    );
    assert.equal(
      await status(patch('ko-7', { setSide: { fixtureId: 'f1', side: 'away', teamId: 'irene' } })),
      400,
      'version is required',
    );
    assert.equal(
      await status(setSide('ko-7', { fixtureId: 'f1', side: 'away', teamId: 'irene' }, 99)),
      409,
      'stale version',
    );
    assert.equal(
      await status(
        patch('ko-7', { setSide: { fixtureId: 'f1', side: 'left', teamId: 'irene' }, version: 1 }),
      ),
      400,
    );
    assert.equal(
      await status(
        patch(
          'ko-7',
          { setSide: { fixtureId: 'f1', side: 'away', teamId: 'irene' }, version: 1 },
          REP,
        ),
      ),
      403,
      'admin-only',
    );
    // A real team side (not a placeholder, never set from one) is edited, not Set.
    await repo.putSeries(T, {
      ...koSeries('ko-8'),
      fixtures: [{ id: 'f1', round: 1, date: '2027-02-14', home: 'irene', away: BEST3 }],
    } as Series);
    assert.equal(
      await status(setSide('ko-8', { fixtureId: 'f1', side: 'home', teamId: 'pretoria' })),
      409,
    );
    assert.equal(
      await status(setSide('ko-8', { fixtureId: 'f1', side: 'away', teamId: 'irene' })),
      400,
      'a team cannot play itself',
    );
  });
});

describe('PATCH /series/:id — orphan fixture sides (R7)', () => {
  test('a whole-series PATCH that puts a non-participant side in is refused', async () => {
    await repo.putSeries(T, koSeries('or-1'));
    const s = (await repo.getSeries(T, 'or-1'))!;
    const fixtures = (s.fixtures as Fx[]).map((f) => (f.id === 'f1' ? { ...f, away: 'ghost' } : f));
    const res = await patch('or-1', { fixtures, version: s.version });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string; orphans: string[] };
    assert.equal(body.code, 'orphan_side');
    assert.deepEqual(body.orphans, ['f1 away ghost']);
  });

  test('placeholders, participants and Set-team sides all pass a whole-series PATCH', async () => {
    await repo.putSeries(T, koSeries('or-2'));
    await setSide('or-2', { fixtureId: 'f2', side: 'away', teamId: 'tm_cent_a' });
    const s = (await repo.getSeries(T, 'or-2'))!;
    const fixtures = (s.fixtures as Fx[]).map((f) => (f.id === 'f1' ? { ...f, time: '10:00' } : f));
    const res = await patch('or-2', { ...s, fixtures, version: s.version });
    assert.equal(res.status, 200);
    const after = await repo.getSeries(T, 'or-2');
    assert.deepEqual(fx(after, 'f2').slots, { away: RU1 }, 'slots survive a whole-object PATCH');
  });

  test('a series that ALREADY carries an orphan stays editable (only new orphans refused)', async () => {
    await repo.putSeries(T, {
      ...koSeries('or-3'),
      fixtures: [{ id: 'f1', round: 1, date: '2027-02-14', home: 'irene', away: 'old-gone-club' }],
    } as Series);
    const s = (await repo.getSeries(T, 'or-3'))!;
    const fixtures = (s.fixtures as Fx[]).map((f) => ({ ...f, time: '13:30' }));
    assert.equal((await patch('or-3', { fixtures, version: s.version })).status, 200);
  });
});
