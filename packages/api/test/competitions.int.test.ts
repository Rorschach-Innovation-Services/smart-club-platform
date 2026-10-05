/**
 * Leagues & tournaments (ADR 0018) — /competitions end to end against the REAL Hono app on
 * in-process dynalite: server-generated draws (preview = create), drafts through the normal
 * series path, league tables from medicoach results, the knockout filled from the group
 * tables, rename/points, regenerate and delete — with the refusals first-class:
 *   invalid spec (every problem listed), unknown club, rep, taken id, released (recall
 *   first), results already in, unknown competition, ground clashes reported on preview.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Series, StoredFixtureResult, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4695; // next free odd port after match-week-office (4693)
const TABLE = 'SmartClubCompetitions';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const T = 'dolphins';
const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
const ADMIN = devAuth('admin@test', [{ tenantId: T, role: 'admin', clubIds: [] }]);
const REP = devAuth('rep@test', [{ tenantId: T, role: 'rep', clubIds: ['c1'] }]);

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');

const call = (method: string, path: string, body?: unknown, auth = ADMIN) =>
  app.request(path, {
    method,
    headers: { 'x-tenant': T, 'x-dev-auth': auth, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const json = async <X = Record<string, unknown>>(res: Response) => (await res.json()) as X;

type Fx = {
  id: string;
  round: number;
  date: string;
  time?: string;
  home: string;
  away: string;
  slots?: Record<string, string>;
};
type S = Omit<Series, 'fixtures'> & {
  fixtures: Fx[];
  competition: Record<string, unknown>;
  maxOvers: number;
};

const team = (i: number) => ({
  teamId: `c${i}`,
  clubId: `c${i}`,
  name: `Club ${i}`,
  venue: `Ground ${i}`,
});
const spec = (over: Record<string, unknown> = {}) => ({
  type: 'league',
  name: 'Premier T20',
  leagueKey: 'premier',
  overs: 20,
  teams: [1, 2, 3, 4].map(team),
  format: { kind: 'round-robin', legs: 1 },
  schedule: { startDate: '2026-10-10', everyDays: 7, times: ['10:00'] },
  ...over,
});

const result = (
  s: string,
  f: string,
  at: string,
  over: Partial<StoredFixtureResult>,
): StoredFixtureResult => ({
  seriesId: s,
  fixtureId: f,
  ref: `smartclub:${T}:fixture:${s}:${f}`,
  orderAt: at,
  recordedAt: at,
  resultSource: 'live',
  noResult: false,
  storedAt: at,
  ...over,
});

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  ({ app } = await import('../src/index.js'));
  repo = await import('../src/repo.js');
  await repo.putTenantConfig({
    tenant: T,
    branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: { medicoachSync: true },
  } as unknown as TenantConfig);
  for (let i = 1; i <= 8; i++)
    await repo.createClub(T, {
      id: `c${i}`,
      name: `Club ${i}`,
      district: 'D',
      sub: `sub-${i}`,
      chair: 'Chair',
      affiliation: 'complete',
      cqi: 0,
      docs: {},
      players: 0,
      teams: 0,
      women: 0,
      juniors: 0,
      color: '#123456',
      ground: { venue: `Ground ${i}` },
      leagues: ['premier'],
      version: 1,
    } as never);
});

after(async () => {
  await stopDynalite(ddb);
});

describe('preview', () => {
  test('generates the draw server-side and writes nothing', async () => {
    const res = await call('POST', '/competitions/preview', { ...spec(), seed: 11 });
    assert.equal(res.status, 200);
    const p = await json<{
      id: string;
      series: S[];
      summary: { fixtures: number; rounds: number };
    }>(res);
    assert.match(p.id, /^c-premier-t20-[0-9a-f]{6}$/);
    assert.equal(p.summary.fixtures, 6);
    assert.equal(p.summary.rounds, 3);
    assert.equal(p.series[0].fixtures[0].time, '10:00');
    assert.deepEqual(await repo.listSeries(T), []);
  });

  test('refuses an invalid spec listing every problem, an unknown club, and a rep', async () => {
    let res = await call('POST', '/competitions/preview', spec({ name: '', overs: 0 }));
    assert.equal(res.status, 400);
    const body = await json<{ code: string; problems: string[] }>(res);
    assert.equal(body.code, 'invalid_competition');
    assert.deepEqual(body.problems, [
      'Give it a name.',
      'Overs must be a whole number from 1 to 200.',
    ]);
    res = await call(
      'POST',
      '/competitions/preview',
      spec({ teams: [team(1), { teamId: 'x', clubId: 'nope', name: 'Ghost CC' }] }),
    );
    assert.equal(res.status, 400);
    assert.equal((await json<{ code: string }>(res)).code, 'unknown_team');
    assert.equal((await call('POST', '/competitions/preview', 'not json')).status, 400);
    assert.equal((await call('POST', '/competitions/preview', spec(), REP)).status, 403);
    assert.equal((await call('POST', '/competitions', spec(), REP)).status, 403);
  });

  test('reports ground double-bookings against what is already scheduled', async () => {
    await repo.putSeries(T, {
      id: 's-existing',
      name: 'Existing',
      startDate: '2026-10-10',
      teams: ['c1', 'c5'],
      fixtures: [{ id: 'f1', round: 1, date: '2026-10-10', time: '10:00', home: 'c1', away: 'c5' }],
      released: true,
      releasedAt: '2026-09-01T00:00:00.000Z',
      version: 1,
    } as unknown as Series);
    try {
      // Club 1 is at home on 10 October in the new draw for some seeds — find one that clashes.
      let clashes: string[] = [];
      for (let seed = 0; seed < 20 && !clashes.length; seed++)
        clashes = (
          await json<{ clashes: string[] }>(
            await call('POST', '/competitions/preview', { ...spec(), seed }),
          )
        ).clashes;
      assert.ok(clashes.length > 0);
      assert.match(clashes[0], /Ground 1/);
    } finally {
      await repo.deleteSeries(T, 's-existing');
    }
  });
});

describe('create, tables, rename, delete — a league', () => {
  let id = '';
  test('the preview draw is the draw stored, as a draft', async () => {
    const preview = await json<{ id: string; series: S[] }>(
      await call('POST', '/competitions/preview', { ...spec(), seed: 5 }),
    );
    id = preview.id;
    const res = await call('POST', '/competitions', { ...spec(), seed: 5, id });
    assert.equal(res.status, 201);
    const created = await json<{ series: S[] }>(res);
    assert.deepEqual(
      created.series[0].fixtures.map((f) => [f.home, f.away, f.date]),
      preview.series[0].fixtures.map((f) => [f.home, f.away, f.date]),
    );
    assert.equal(created.series[0].released, false);
    assert.equal(created.series[0].approved, false);
    assert.deepEqual(created.series[0].competition.points, {
      win: 4,
      tie: 2,
      noResult: 2,
      loss: 0,
    });
    assert.equal((await call('POST', '/competitions', { ...spec(), id })).status, 409);
  });

  test('the league table ranks on points then net run rate, from the stored results', async () => {
    const s = (await repo.getSeries(T, id)) as unknown as S;
    const [f1, f2] = s.fixtures;
    await repo.putFixtureResultIfNewer(
      T,
      result(id, f1.id, '2026-10-10T15:00:00.000Z', {
        homeScore: '160/5 (20)',
        awayScore: '120/9 (20)',
        winner: 'home',
      }),
    );
    await repo.putFixtureResultIfNewer(
      T,
      result(id, f2.id, '2026-10-10T15:10:00.000Z', {
        homeScore: '100/2 (10)',
        awayScore: '99/10 (18)',
        winner: 'home',
      }),
    );
    const t = await json<{
      tables: Array<{
        complete: boolean;
        played: number;
        total: number;
        rows: Array<{ teamId: string; points: number; nrr: number | null }>;
      }>;
    }>(await call('GET', `/competitions/${id}/standings`));
    assert.equal(t.tables.length, 1);
    assert.deepEqual([t.tables[0].played, t.tables[0].total, t.tables[0].complete], [2, 6, false]);
    const top = t.tables[0].rows.slice(0, 2);
    assert.deepEqual(
      top.map((r) => r.points),
      [4, 4],
    );
    // f2's winner scored 100 in 10 overs v 99 all out (charged 20 overs): +5.05 beats +2.0.
    assert.equal(top[0].teamId, f2.home);
    assert.equal(top[0].nrr, 5.05);
    assert.equal(t.tables[0].rows.at(-1)!.points, 0);
  });

  test('rename and points apply to every series; bad points are refused', async () => {
    const res = await call('PATCH', `/competitions/${id}`, {
      name: 'Premier League T20',
      points: { win: 2, tie: 1, noResult: 1, loss: 0 },
    });
    assert.equal(res.status, 200);
    const s = (await repo.getSeries(T, id)) as unknown as S;
    assert.equal(s.name, 'Premier League T20');
    assert.deepEqual(s.competition.points, { win: 2, tie: 1, noResult: 1, loss: 0 });
    assert.equal(
      (
        await call('PATCH', `/competitions/${id}`, {
          points: { win: -1, tie: 1, noResult: 1, loss: 0 },
        })
      ).status,
      400,
    );
    assert.equal((await call('PATCH', `/competitions/${id}`, {})).status, 400);
    assert.equal((await call('PATCH', '/competitions/c-nope', { name: 'X' })).status, 404);
  });

  test('regenerate is refused once results are in', async () => {
    const res = await call('POST', `/competitions/${id}/regenerate`, { ...spec(), seed: 9 });
    assert.equal(res.status, 409);
    assert.equal((await json<{ code: string }>(res)).code, 'has_results');
  });

  test('a released competition must be recalled before it is deleted', async () => {
    const s = (await repo.getSeries(T, id)) as unknown as S;
    await call('PATCH', `/series/${id}`, { approved: true, version: s.version });
    const s2 = (await repo.getSeries(T, id)) as unknown as S;
    assert.equal(
      (await call('PATCH', `/series/${id}`, { released: true, version: s2.version })).status,
      200,
    );
    const res = await call('DELETE', `/competitions/${id}`);
    assert.equal(res.status, 409);
    assert.equal((await json<{ code: string }>(res)).code, 'competition_released');
    const s3 = (await repo.getSeries(T, id)) as unknown as S;
    await call('PATCH', `/series/${id}`, { released: false, version: s3.version });
    assert.equal((await call('DELETE', `/competitions/${id}`)).status, 200);
    assert.equal(await repo.getSeries(T, id), null);
    assert.equal(await repo.getFixtureResult(T, id, 'f1'), null, 'its results go with it');
    assert.equal((await call('DELETE', `/competitions/${id}`)).status, 404);
  });
});

describe('a tournament: groups then knockout', () => {
  let id = '';
  test('creates group series and a knockout seeded from the group tables', async () => {
    const res = await call(
      'POST',
      '/competitions',
      spec({
        type: 'tournament',
        name: 'Kingsmead Cup',
        teams: [1, 2, 3, 4, 5, 6, 7, 8].map(team),
        format: { kind: 'groups-knockout', groups: 2, qualifiers: 2, legs: 1 },
      }),
    );
    assert.equal(res.status, 201);
    const body = await json<{ id: string; series: S[] }>(res);
    id = body.id;
    assert.deepEqual(
      body.series.map((s) => s.name),
      ['Kingsmead Cup · Group A', 'Kingsmead Cup · Group B', 'Kingsmead Cup · Knockout'],
    );
    assert.match(body.series[2].fixtures[0].home, /^pos:.*-g1:1$/);
  });

  test('advance waits for unfinished groups, then fills the semis keeping the placeholders', async () => {
    let res = await call('POST', `/competitions/${id}/advance`, {});
    let body = await json<{ filled: number; waiting: string[] }>(res);
    assert.equal(body.filled, 0);
    assert.ok(body.waiting.some((w) => /isn't finished/.test(w)));

    // Every group game: the home side wins.
    for (const g of ['g1', 'g2']) {
      const s = (await repo.getSeries(T, `${id}-${g}`)) as unknown as S;
      for (const f of s.fixtures)
        await repo.putFixtureResultIfNewer(
          T,
          result(s.id as string, f.id, '2026-10-20T15:00:00.000Z', {
            homeScore: '150/5 (20)',
            awayScore: '140/8 (20)',
            winner: 'home',
          }),
        );
    }
    res = await call('POST', `/competitions/${id}/advance`, {});
    body = await json<{ filled: number; waiting: string[] }>(res);
    assert.equal(body.filled, 4);
    const ko = (await repo.getSeries(T, `${id}-ko`)) as unknown as S;
    assert.ok(!/^(pos|win):/.test(ko.fixtures[0].home));
    assert.match(ko.fixtures[0].slots!.home, /^pos:/);
    assert.match(ko.fixtures[2].home, /^win:/, 'the final waits for the semis');
    const t = await json<{ tables: unknown[] }>(await call('GET', `/competitions/${id}/standings`));
    assert.equal(t.tables.length, 2, 'one table per group, none for the knockout');
  });

  test('a league has no knockout to advance', async () => {
    const c = await json<{ id: string }>(
      await call('POST', '/competitions', spec({ name: 'Solo League' })),
    );
    const res = await call('POST', `/competitions/${c.id}/advance`, {});
    assert.equal(res.status, 409);
    assert.equal((await json<{ code: string }>(res)).code, 'no_knockout');
  });
});

describe('regenerate a draft', () => {
  test('a new seed replaces the draw in place; officials on the old draw go', async () => {
    const c = await json<{ id: string; series: S[] }>(
      await call('POST', '/competitions', { ...spec({ name: 'Redraw League' }), seed: 1 }),
    );
    await call('POST', '/umpires', { displayName: 'Ump One' });
    await call('PUT', `/series/${c.id}/fixtures/f1/officials`, { umpires: ['u-ump-one'] });
    const res = await call('POST', `/competitions/${c.id}/regenerate`, {
      ...spec({ name: 'Redraw League' }),
      seed: 99,
    });
    assert.equal(res.status, 200);
    const after = (await repo.getSeries(T, c.id)) as unknown as S;
    assert.notDeepEqual(
      after.fixtures.map((f) => [f.home, f.away]),
      c.series[0].fixtures.map((f) => [f.home, f.away]),
    );
    assert.equal(await repo.getFixtureOfficials(T, c.id, 'f1'), null);
    assert.equal((await call('POST', '/competitions/c-nope/regenerate', spec())).status, 404);
  });
});
