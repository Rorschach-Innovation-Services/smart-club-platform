/**
 * Set team (ADR 0018) edge cases and failure modes through the real PATCH /series/:id on
 * dynalite: participant add/drop on set, replace and revert; the no-op set; team double-booking
 * (`team_busy`); foreign / unknown / malformed team ids; a legacy series; a medicoach-synced
 * series (`win:`/`lose:` sides refused, `pos:`/`tbd:` sides reported for a bundle top-up and
 * never pushed); released and withheld series; approval recall on a draft; and the orphan check
 * on a series that had no teams to judge by. Every refusal asserts the status, the code and
 * that nothing was stored.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Club, Series, TenantConfig } from '../src/types.js';

const DDB_PORT = 4701; // next free odd port after 4699
const TABLE = 'SmartClubSetSideEdgeTest';
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
const SYNC = 'synct';
const OTHER = 'othertenant';
const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
const ADMIN = devAuth('admin@test', [
  { tenantId: T, role: 'admin', clubIds: [] },
  { tenantId: SYNC, role: 'admin', clubIds: [] },
]);
const REP = devAuth('rep@test', [{ tenantId: T, role: 'rep', clubIds: ['pretoria'] }]);
const headers = (tenant: string, auth: string) => ({
  'x-tenant': tenant,
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

const BEST3 = 'tbd:Best%203rd%20place';
const GA = 'pos:s-g-a:1';
type Fx = Record<string, unknown> & { id: string; slots?: { home?: string; away?: string } };

const ko = (id: string, over: Partial<Series> = {}): Series =>
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
        home: GA,
        away: BEST3,
        stage: 'Quarter-final',
      },
      {
        id: 'f2',
        round: 1,
        date: '2027-02-14',
        time: '13:30',
        home: 'pos:s-g-b:1',
        away: 'tbd:Runner-up%201',
        stage: 'Quarter-final',
      },
      {
        id: 'f3',
        round: 2,
        date: '2027-02-21',
        time: '09:00',
        home: 'win:f1',
        away: 'win:f2',
        stage: 'Final',
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

const patch = (tenant: string, id: string, body: Record<string, unknown>, auth = ADMIN) =>
  app.request(`/series/${id}`, {
    method: 'PATCH',
    headers: headers(tenant, auth),
    body: JSON.stringify(body),
  });
const setSide = async (
  id: string,
  op: { fixtureId: string; side: 'home' | 'away'; teamId: string | null },
  tenant = T,
) => patch(tenant, id, { setSide: op, version: (await repo.getSeries(tenant, id))!.version });
const fx = (s: Series | null, id: string) => (s!.fixtures as Fx[]).find((f) => f.id === id)!;
const body = async (res: Response) => (await res.json()) as Record<string, unknown>;

/** A refusal leaves the stored series exactly as it was. */
async function refused(
  res: Response,
  status: number,
  code: string | undefined,
  tenant: string,
  id: string,
  before: Series | null,
) {
  assert.equal(res.status, status, await res.clone().text());
  const b = await body(res);
  if (code) assert.equal(b.code, code);
  assert.deepEqual(await repo.getSeries(tenant, id), before, 'nothing stored');
  return b;
}

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
  for (const tenant of [T, SYNC]) {
    await repo.putClub(tenant, club('irene', 'Irene', 'Irene Oval'));
    await repo.putClub(tenant, club('pretoria', 'Pretoria', 'Pretoria Oval'));
    await repo.putClub(
      tenant,
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
  }
  await repo.putClub(OTHER, club('foreign', 'Foreign CC', 'Far Away Oval'));
  await repo.putTenantConfig({
    tenant: SYNC,
    branding: { name: 'Sync', title: 'Sync', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: { medicoachSync: true },
  } as unknown as TenantConfig);
});

after(() => new Promise<void>((resolve) => ddbServer.close(() => resolve())));

describe('Set team — participants on set, replace and revert (A1–A4)', () => {
  test('(1) a pos: side takes an outside team: snapshot + teams[] + setTeamAdded, version +1', async () => {
    await repo.putSeries(T, ko('e1'));
    const res = await setSide('e1', { fixtureId: 'f1', side: 'home', teamId: 'tm_cent_a' });
    assert.equal(res.status, 200);
    const s = (await repo.getSeries(T, 'e1'))!;
    assert.equal(s.version, 2);
    assert.equal(fx(s, 'f1').home, 'tm_cent_a');
    assert.deepEqual(fx(s, 'f1').slots, { home: GA });
    assert.ok(s.teams.includes('tm_cent_a'));
    assert.deepEqual(s.setTeamAdded, ['tm_cent_a']);
    assert.equal(
      s.participants!.find((p) => p.teamId === 'tm_cent_a')?.name,
      'Centurion A',
      'snapshot name',
    );
  });

  test('(3) revert drops an outside team nothing names any more', async () => {
    await repo.putSeries(T, ko('e3'));
    await setSide('e3', { fixtureId: 'f1', side: 'away', teamId: 'tm_cent_b' });
    const res = await setSide('e3', { fixtureId: 'f1', side: 'away', teamId: null });
    assert.equal(res.status, 200);
    const s = (await repo.getSeries(T, 'e3'))!;
    assert.equal(fx(s, 'f1').away, BEST3);
    assert.ok(!s.teams.includes('tm_cent_b'));
    assert.ok(!s.participants!.some((p) => p.teamId === 'tm_cent_b'));
    assert.deepEqual(s.setTeamAdded, []);
  });

  test('(3) revert keeps an outside team another fixture still names', async () => {
    await repo.putSeries(T, ko('e3b'));
    await setSide('e3b', { fixtureId: 'f1', side: 'away', teamId: 'tm_cent_b' });
    await setSide('e3b', { fixtureId: 'f2', side: 'away', teamId: 'tm_cent_b' });
    await setSide('e3b', { fixtureId: 'f1', side: 'away', teamId: null });
    const s = (await repo.getSeries(T, 'e3b'))!;
    assert.equal(fx(s, 'f2').away, 'tm_cent_b');
    assert.ok(s.teams.includes('tm_cent_b'));
    assert.ok(s.participants!.some((p) => p.teamId === 'tm_cent_b'));
  });

  test("(3) a series' own team is never dropped by a revert", async () => {
    await repo.putSeries(T, ko('e3c'));
    await setSide('e3c', { fixtureId: 'f1', side: 'away', teamId: 'pretoria' });
    await setSide('e3c', { fixtureId: 'f1', side: 'away', teamId: null });
    const s = (await repo.getSeries(T, 'e3c'))!;
    assert.deepEqual(s.teams, ['irene', 'pretoria']);
    assert.equal(s.participants!.length, 2);
  });

  test('(4) replacing a set outside team drops the old one when unreferenced', async () => {
    await repo.putSeries(T, ko('e4'));
    await setSide('e4', { fixtureId: 'f1', side: 'away', teamId: 'tm_cent_b' });
    const res = await setSide('e4', { fixtureId: 'f1', side: 'away', teamId: 'tm_cent_a' });
    assert.equal(res.status, 200);
    const s = (await repo.getSeries(T, 'e4'))!;
    assert.equal(fx(s, 'f1').away, 'tm_cent_a');
    assert.deepEqual(fx(s, 'f1').slots, { away: BEST3 }, 'original placeholder kept');
    assert.ok(!s.teams.includes('tm_cent_b'));
    assert.ok(s.teams.includes('tm_cent_a'));
    assert.deepEqual(s.setTeamAdded, ['tm_cent_a']);
  });
});

describe('Set team — refusals (A5–A12)', () => {
  test('(5) setting the team a side already holds is a 409 no_change with no write', async () => {
    await repo.putSeries(T, ko('e5'));
    await setSide('e5', { fixtureId: 'f1', side: 'away', teamId: 'pretoria' });
    const before = await repo.getSeries(T, 'e5');
    const res = await setSide('e5', { fixtureId: 'f1', side: 'away', teamId: 'pretoria' });
    await refused(res, 409, 'no_change', T, 'e5', before);
  });

  test('(6) a stale version is the plain concurrency 409; nothing written', async () => {
    await repo.putSeries(T, ko('e6'));
    const before = await repo.getSeries(T, 'e6');
    const res = await patch(T, 'e6', {
      setSide: { fixtureId: 'f1', side: 'away', teamId: 'pretoria' },
      version: 0,
    });
    const b = await refused(res, 409, undefined, T, 'e6', before);
    assert.equal(b.error, 'series changed; refetch');
  });

  test('(8) a team already playing at that date and time is 409 team_busy; another time is fine', async () => {
    await repo.putSeries(T, {
      ...ko('busy'),
      teams: ['tm_cent_a', 'irene'],
      participants: [
        { teamId: 'tm_cent_a', clubId: 'centurion', name: 'Centurion A' },
        { teamId: 'irene', clubId: 'irene', name: 'Irene' },
      ],
      released: true,
      releasedAt: '2027-01-01T00:00:00Z',
      approved: true,
      fixtures: [
        {
          id: 'f1',
          round: 1,
          date: '2027-02-14',
          time: '09:00',
          home: 'tm_cent_a',
          away: 'irene',
          venueName: 'Somewhere Else Oval',
        },
      ],
    } as Series);
    await repo.putSeries(T, ko('e8'));
    const before = await repo.getSeries(T, 'e8');
    const res = await setSide('e8', { fixtureId: 'f1', side: 'away', teamId: 'tm_cent_a' });
    const b = await refused(res, 409, 'team_busy', T, 'e8', before);
    assert.match(String(b.error), /Centurion A already plays on 2027-02-14 09:00 \(KO busy\)/);
    // f2 is 13:30 the same day: allowed (different slot).
    const ok = await setSide('e8', { fixtureId: 'f2', side: 'away', teamId: 'tm_cent_a' });
    assert.equal(ok.status, 200);
    await repo.deleteSeries(T, 'busy');
  });

  test('(9)(10) a team on both sides, and a side that was never a placeholder, are refused', async () => {
    await repo.putSeries(T, {
      ...ko('e9'),
      fixtures: [{ id: 'f1', round: 1, date: '2027-02-14', home: 'irene', away: BEST3 }],
    } as Series);
    const before = await repo.getSeries(T, 'e9');
    await refused(
      await setSide('e9', { fixtureId: 'f1', side: 'away', teamId: 'irene' }),
      400,
      undefined,
      T,
      'e9',
      before,
    );
    const b = await refused(
      await setSide('e9', { fixtureId: 'f1', side: 'home', teamId: 'pretoria' }),
      409,
      undefined,
      T,
      'e9',
      before,
    );
    assert.match(String(b.error), /not a knockout placeholder/);
  });

  test('(11) a club rep is refused (403), nothing stored', async () => {
    await repo.putSeries(T, ko('e11'));
    const before = await repo.getSeries(T, 'e11');
    const res = await patch(
      T,
      'e11',
      { setSide: { fixtureId: 'f1', side: 'away', teamId: 'pretoria' }, version: 1 },
      REP,
    );
    await refused(res, 403, undefined, T, 'e11', before);
  });

  test("(12) another tenant's club, an unknown club and a malformed tm_ id are 400", async () => {
    await repo.putSeries(T, ko('e12'));
    const before = await repo.getSeries(T, 'e12');
    for (const teamId of ['foreign', 'no-such-club', 'tm_', 'tm_cent_z', '   '])
      await refused(
        await setSide('e12', { fixtureId: 'f1', side: 'away', teamId }),
        400,
        undefined,
        T,
        'e12',
        before,
      );
  });
});

describe('Set team — legacy, synced, released, withheld, drafts (A13–A16)', () => {
  test('(13) a legacy series takes a club id (no snapshot started) and refuses a tm_ side', async () => {
    await repo.putSeries(T, ko('e13', { participants: undefined, teams: ['irene'] }));
    const before = await repo.getSeries(T, 'e13');
    await refused(
      await setSide('e13', { fixtureId: 'f1', side: 'away', teamId: 'tm_cent_a' }),
      400,
      undefined,
      T,
      'e13',
      before,
    );
    const ok = await setSide('e13', { fixtureId: 'f1', side: 'away', teamId: 'centurion' });
    assert.equal(ok.status, 200);
    const s = (await repo.getSeries(T, 'e13'))!;
    assert.equal(s.participants, undefined, 'no participant snapshot started');
    assert.deepEqual(s.teams, ['irene', 'centurion']);
    // Revert takes the club back out (Set team added it, nothing names it now).
    await setSide('e13', { fixtureId: 'f1', side: 'away', teamId: null });
    assert.deepEqual((await repo.getSeries(T, 'e13'))!.teams, ['irene']);
  });

  test('(14) synced series: a win: side is medicoach’s (409 sync_owned_side); revert too', async () => {
    await repo.putSeries(
      SYNC,
      ko('s14', { approved: true, released: true, releasedAt: '2027-01-01T00:00:00Z' }),
    );
    const before = await repo.getSeries(SYNC, 's14');
    const b = await refused(
      await setSide('s14', { fixtureId: 'f3', side: 'home', teamId: 'irene' }, SYNC),
      409,
      'sync_owned_side',
      SYNC,
      's14',
      before,
    );
    assert.match(String(b.error), /^medicoach decides this side/);
  });

  test('(14) synced series: a tbd: side is settable, reported for a bundle top-up, never pushed', async () => {
    await repo.putSeries(
      SYNC,
      ko('s14b', { approved: true, released: true, releasedAt: '2027-01-01T00:00:00Z' }),
    );
    // f1 is GA v Best 3rd: set both sides so it has two real teams.
    assert.equal(
      (await setSide('s14b', { fixtureId: 'f1', side: 'home', teamId: 'irene' }, SYNC)).status,
      200,
    );
    assert.deepEqual(await repo.listPendingSync(SYNC), [], 'one side still a tbd: — nothing');
    assert.equal(
      (await setSide('s14b', { fixtureId: 'f1', side: 'away', teamId: 'pretoria' }, SYNC)).status,
      200,
    );
    assert.deepEqual(await repo.listPendingSync(SYNC), [], 'never pushed (medicoach lacks it)');
    const logs = await repo.listSyncLogs(SYNC);
    const top = logs.find((l) => l.kind === 'new-fixtures');
    assert.ok(top, 'a new-fixtures SYNCLOG row');
    assert.deepEqual(top!.newFixtureRefs, ['smartclub:synct:fixture:s14b:f1']);
  });

  test('(15) a released series takes Set team, stays released, keeps releasedAt; a draft loses approval', async () => {
    await repo.putSeries(
      T,
      ko('e15', { approved: true, released: true, releasedAt: '2027-01-01T00:00:00Z' }),
    );
    assert.equal(
      (await setSide('e15', { fixtureId: 'f1', side: 'away', teamId: 'pretoria' })).status,
      200,
    );
    const s = (await repo.getSeries(T, 'e15'))!;
    assert.equal(s.released, true);
    assert.equal(s.releasedAt, '2027-01-01T00:00:00Z');
    assert.equal(s.approved, true);
    // The club sees the series with the team resolvable from the snapshot.
    const rep = await app.request('/series', { headers: headers(T, REP) });
    const mine = ((await rep.json()) as Series[]).find((x) => x.id === 'e15')!;
    assert.equal(fx(mine, 'f1').away, 'pretoria');
    assert.ok(mine.participants!.some((p) => p.teamId === 'pretoria' && p.name === 'Pretoria'));

    await repo.putSeries(T, ko('e15d', { approved: true, approvedAt: '2027-01-01T00:00:00Z' }));
    // (Pretoria now plays e15's f1 at that very slot — team_busy — so Irene goes in here.)
    const d = await setSide('e15d', { fixtureId: 'f1', side: 'away', teamId: 'irene' });
    assert.equal(d.status, 200, await d.text());
    assert.equal((await repo.getSeries(T, 'e15d'))!.approved, false, 'draft approval recalled');
  });

  test('(16) withheld times stay withheld after a Set team', async () => {
    await repo.putSeries(
      T,
      ko('e16', {
        approved: true,
        released: true,
        releasedAt: '2027-01-01T00:00:00Z',
        withheld: { time: true },
      }),
    );
    await setSide('e16', { fixtureId: 'f1', side: 'away', teamId: 'pretoria' });
    assert.deepEqual((await repo.getSeries(T, 'e16'))!.withheld, { time: true });
    const rep = await app.request('/series', { headers: headers(T, REP) });
    const mine = ((await rep.json()) as Series[]).find((x) => x.id === 'e16')!;
    assert.equal(fx(mine, 'f1').time, undefined, 'the club still sees no time');
  });
});

describe('consumers of tbd:/pos: sides (D23)', () => {
  const s = () =>
    ({
      ...ko('cons', { approved: true, released: true, releasedAt: '2027-01-01T00:00:00Z' }),
      fixtures: [
        { id: 'f1', round: 1, date: '2027-02-14', time: '09:00', home: 'irene', away: BEST3 },
        { id: 'f2', round: 1, date: '2027-02-14', time: '13:30', home: GA, away: BEST3 },
      ],
    }) as Series;
  const clubsById = async () => new Map((await repo.listClubs(T)).map((c) => [c.id, c]));

  test('send-fixtures schedule names the tbd: side in words; a club with no side gets nothing', async () => {
    const { buildClubSchedule } = await import('../src/index.js');
    const byId = await clubsById();
    const irene = buildClubSchedule(byId.get('irene')!, [s()], byId).text;
    assert.match(irene, /Best 3rd place/);
    assert.doesNotMatch(irene, /tbd:|pos:|TBA/);
    const pretoria = buildClubSchedule(byId.get('pretoria')!, [s()], byId).text;
    assert.doesNotMatch(pretoria, /KO cons/, 'a placeholder is nobody’s fixture');
  });

  test('fixture reminders: the opponent reads as its words; placeholders remind nobody', async () => {
    const { clubFixturesOn } = await import('../src/crons/fixture-reminders.js');
    const byId = await clubsById();
    const lines = clubFixturesOn(byId.get('irene')!, [s()], '2027-02-14', byId);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].opponentName, 'Best 3rd place');
    assert.deepEqual(clubFixturesOn(byId.get('pretoria')!, [s()], '2027-02-14', byId), []);
  });

  test('club portal projection keeps placeholder sides as they are (the UI labels them)', async () => {
    const { projectSeriesForClub } = await import('../src/series-projection.js');
    const p = projectSeriesForClub(s(), '2027-01-01')!;
    assert.equal(fx(p, 'f2').home, GA);
    assert.equal(fx(p, 'f2').away, BEST3);
  });

  test("captain's reports open for the real side only; the tbd: opponent is 'TBC'", async () => {
    const { openCaptainReports } = await import('../src/captains-reports.js');
    const opened: Array<{ clubId: string; opponentName: string }> = [];
    const series = s();
    const byId = await clubsById();
    const fake = new Proxy(
      {
        listCaptainsReportsForFixture: async () => [],
        getSeries: async () => series,
        getFixtureOfficials: async () => null,
        getClub: async (_t: string, id: string) => byId.get(id) ?? null,
        openCaptainsReportIfAbsent: async (
          _t: string,
          r: { clubId: string; opponentName: string },
        ) => {
          opened.push({ clubId: r.clubId, opponentName: r.opponentName });
          return true;
        },
      } as Record<string, unknown>,
      { get: (t, k: string) => t[k] ?? (async () => null) },
    );
    await openCaptainReports(
      {
        tenant: T,
        seriesId: 'cons',
        fixtureId: 'f1',
        ref: 'r',
        result: { source: 'medicoach', summary: 'x' } as never,
        config: { integrations: { medicoach: { goLiveDate: '2027-01-01' } } } as never,
        receivedAt: new Date('2027-02-14T18:00:00Z'),
      },
      {
        repo: fake as never,
        now: () => new Date('2027-02-14T18:00:00Z'),
        sendNotice: async () => [],
        linkSecret: () => 's',
        linkBase: () => 'http://x',
        log: () => {},
      },
    ).catch(() => {});
    assert.deepEqual(opened, [{ clubId: 'irene', opponentName: 'TBC' }]);
  });
});

describe('orphan check edge (B20)', () => {
  test('(20) a series with no teams to judge by can gain teams without its old sides blocking', async () => {
    await repo.putSeries(T, {
      ...ko('e20'),
      teams: [],
      participants: [],
      fixtures: [{ id: 'f1', round: 1, date: '2027-02-14', home: 'irene', away: 'mystery' }],
    } as unknown as Series);
    const s = (await repo.getSeries(T, 'e20'))!;
    const res = await patch(T, 'e20', { teams: ['irene'], version: s.version });
    assert.equal(res.status, 200, await res.text());
    // But a NEW orphan in the same series is still refused.
    const s2 = (await repo.getSeries(T, 'e20'))!;
    const bad = await patch(T, 'e20', {
      version: s2.version,
      fixtures: [
        ...(s2.fixtures as Fx[]),
        { id: 'f2', round: 2, date: '2027-02-21', home: 'irene', away: 'ghost' },
      ],
    });
    assert.equal(bad.status, 400);
    assert.equal((await body(bad)).code, 'orphan_side');
  });
});
