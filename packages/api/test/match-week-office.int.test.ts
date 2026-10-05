/**
 * Match-week office (ADR 0017): scorers, result confirmations, ground time/balls, and the
 * guard on removing fixtures medicoach already holds — end to end against the REAL Hono app
 * and the REAL sync puller on in-process dynalite, with the FAILURE MODES first-class:
 *
 *  Scorers      — register validation, partial officials writes never drop the other part,
 *                 unknown/inactive/duplicate/too many refused, renames show, rep visibility,
 *                 a removed fixture's appointments are cleaned up.
 *  Confirmation — only the result the admin LOOKED AT can be confirmed (409 result_changed),
 *                 no result / a cleared result can't be, a newer result from medicoach leaves
 *                 the confirmation stale (and the puller can't wipe it), series delete and
 *                 tenant erasure take it, admin-only, sync-off refused.
 *  Ground play  — stored from the pull, shown on the result; a malformed block never blocks
 *                 the result; a medicoach that doesn't send it still syncs.
 *  Removal      — a released, synced series refuses dropping a fixture (409
 *                 synced_fixture_removed) unless confirmed; drafts and unsynced tenants don't.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Series, StoredFixtureResult, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4693; // next free odd port after medicoach-sync-ux (4689)
const TABLE = 'SmartClubMatchWeek';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const T = 'dolphins';
const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
const ADMIN = devAuth('admin@test', [{ tenantId: T, role: 'admin', clubIds: [] }]);
const REP_A = devAuth('rep@test', [{ tenantId: T, role: 'rep', clubIds: ['a'] }]);

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let puller: typeof import('../src/medicoach-sync/puller.js');

const call = (method: string, path: string, body?: unknown, auth = ADMIN) =>
  app.request(path, {
    method,
    headers: { 'x-tenant': T, 'x-dev-auth': auth, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const json = async <X = Record<string, unknown>>(res: Response) => (await res.json()) as X;

type Fx = Record<string, unknown> & { id: string };
const getSeriesAs = async (auth = ADMIN) =>
  json<Array<Series & { fixtures: Fx[] }>>(await call('GET', '/series', undefined, auth));
const fixtureOf = async (seriesId: string, fixtureId: string, auth = ADMIN) =>
  (await getSeriesAs(auth))
    .find((s) => s.id === seriesId)
    ?.fixtures.find((f) => f.id === fixtureId);

const series = (id: string, over: Partial<Series> = {}) =>
  ({
    id,
    name: `Series ${id}`,
    leagueKey: 'premier',
    startDate: '2026-10-03',
    teams: ['a', 'b', 'c'],
    participants: [
      { teamId: 'a', clubId: 'a', name: 'Alpha CC' },
      { teamId: 'b', clubId: 'b', name: 'Beta CC' },
      { teamId: 'c', clubId: 'c', name: 'Gamma CC' },
    ],
    fixtures: [
      { id: 'f1', round: 1, date: '2026-10-03', time: '10:00', home: 'a', away: 'b' },
      { id: 'f2', round: 1, date: '2026-10-03', time: '13:00', home: 'b', away: 'c' },
      { id: 'f3', round: 2, date: '2026-10-10', time: '10:00', home: 'c', away: 'a' },
    ],
    kind: 'series',
    approved: true,
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
    ...over,
  }) as unknown as Series;

const result = (seriesId: string, fixtureId: string, recordedAt: string): StoredFixtureResult => ({
  seriesId,
  fixtureId,
  ref: `smartclub:${T}:fixture:${seriesId}:${fixtureId}`,
  orderAt: recordedAt,
  homeScore: '150/4 (20)',
  awayScore: '149/9 (20)',
  summary: 'Alpha CC won by 6 wickets',
  winner: 'home',
  method: 'normal',
  noResult: false,
  resultSource: 'live',
  recordedAt,
  storedAt: recordedAt,
});

const setFeatures = async (features: Record<string, boolean>) => {
  const cfg = await repo.getTenantConfig(T);
  await repo.putTenantConfig({ ...cfg!, features } as TenantConfig);
};

/** One signed-contract page served to the REAL puller via an injected fetch. */
async function pull(fixtures: unknown[]) {
  const page = {
    version: 1,
    tenant: T,
    nextCursor: new Date().toISOString(),
    hasMore: false,
    fixtures,
  };
  return puller.runMedicoachSync(T, 'manual', {
    repo,
    url: 'http://stub',
    secret: 'stub',
    fetch: (async () =>
      new Response(JSON.stringify(page), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    onResultStored: async () => {},
    onResultCleared: async () => {},
    log: () => {},
  });
}
const change = (
  seriesId: string,
  fixtureId: string,
  res: Record<string, unknown> | null,
  clearedAt: string | null = null,
) => ({
  ref: `smartclub:${T}:fixture:${seriesId}:${fixtureId}`,
  syncStamp: new Date().toISOString(),
  schedule: {
    scheduledTime: '2026-10-03T10:00:00+02:00',
    timeTbc: false,
    dateTbc: false,
    venue: null,
    postponed: false,
    cancelled: false,
    changedAt: '1970-01-01T00:00:00.000Z',
  },
  teams: { homeRef: null, awayRef: null },
  result: res,
  resultClearedAt: clearedAt,
});
const liveResult = (recordedAt: string, extra: Record<string, unknown> = {}) => ({
  homeScore: '184/6 (20)',
  awayScore: '161/9 (20)',
  summary: 'Alpha CC won by 23 runs',
  winner: 'home',
  method: 'normal',
  noResult: false,
  source: 'live',
  recordedAt,
  scoringSide: 'home',
  captainRef: null,
  medicoachMatchUrl: null,
  ...extra,
});

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  ({ app } = await import('../src/index.js'));
  repo = await import('../src/repo.js');
  puller = await import('../src/medicoach-sync/puller.js');
  await repo.putTenantConfig({
    tenant: T,
    branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: { medicoachSync: true },
  } as unknown as TenantConfig);
});

after(async () => {
  await stopDynalite(ddb);
});

/* ───────────────────────────── Scorers ───────────────────────────── */

describe('scorer register', () => {
  test('creates, refuses a duplicate name and bad contact details, deactivates', async () => {
    const created = await call('POST', '/scorers', {
      displayName: 'Futhi Dube',
      phone: '0821234567',
    });
    assert.equal(created.status, 201);
    assert.equal((await json(created)).id, 's-futhi-dube');
    const dup = await call('POST', '/scorers', { displayName: ' futhi  DUBE ' });
    assert.equal(dup.status, 409);
    assert.equal((await json<{ code: string }>(dup)).code, 'scorer_name_taken');
    assert.equal(
      (await call('POST', '/scorers', { displayName: 'X', email: 'not-an-email' })).status,
      400,
    );
    assert.equal((await call('POST', '/scorers', { displayName: '   ' })).status, 400);
    assert.equal((await call('POST', '/scorers', { displayName: 'Y', active: false })).status, 400);
    const off = await call('PATCH', '/scorers/s-futhi-dube', { active: false });
    assert.equal((await json<{ active: boolean }>(off)).active, false);
    assert.equal((await call('PATCH', '/scorers/s-nobody', { active: false })).status, 404);
    await call('PATCH', '/scorers/s-futhi-dube', { active: true });
  });

  test('is admin only', async () => {
    assert.equal((await call('GET', '/scorers', undefined, REP_A)).status, 403);
    assert.equal(
      (await call('POST', '/scorers', { displayName: 'Rep Scorer' }, REP_A)).status,
      403,
    );
  });
});

describe('appointing scorers beside umpires', () => {
  before(async () => {
    await repo.putSeries(T, series('s-off'));
    await call('POST', '/umpires', { displayName: 'A.Umpire' });
    await call('POST', '/umpires', { displayName: 'B.Umpire' });
    await call('POST', '/scorers', { displayName: 'Lionel N' });
    await call('POST', '/scorers', { displayName: 'Kevin P' });
    await call('POST', '/scorers', { displayName: 'Retired Scorer' });
    await call('PATCH', '/scorers/s-retired-scorer', { active: false });
  });
  const put = (body: unknown, fixture = 'f1') =>
    call('PUT', `/series/s-off/fixtures/${fixture}/officials`, body);

  test('scorers and umpires are saved independently — neither write drops the other', async () => {
    assert.equal((await put({ umpires: ['u-a-umpire', 'u-b-umpire'] })).status, 200);
    assert.equal((await put({ scorers: ['s-lionel-n', { scorerId: 's-kevin-p' }] })).status, 200);
    let o = (await fixtureOf('s-off', 'f1'))!.officials as Record<string, Array<{ name: string }>>;
    assert.deepEqual(
      o.umpires.map((u) => u.name),
      ['A.Umpire', 'B.Umpire'],
    );
    assert.deepEqual(
      o.scorers.map((x) => x.name),
      ['Lionel N', 'Kevin P'],
    );
    // Saving the umpires again (what the umpire picker sends) keeps the scorers.
    assert.equal((await put({ umpires: ['u-b-umpire'] })).status, 200);
    o = (await fixtureOf('s-off', 'f1'))!.officials as typeof o;
    assert.deepEqual(
      o.scorers.map((x) => x.name),
      ['Lionel N', 'Kevin P'],
    );
  });

  test('refuses unknown, inactive, repeated and too many scorers, and an empty body', async () => {
    for (const [body, status] of [
      [{ scorers: ['s-nobody'] }, 400],
      [{ scorers: ['s-retired-scorer'] }, 400],
      [{ scorers: ['s-lionel-n', 's-lionel-n'] }, 400],
      [{ scorers: ['s-lionel-n', 's-kevin-p', 's-futhi-dube'] }, 400],
      [{ scorers: 's-lionel-n' }, 400],
      [{}, 400],
    ] as const)
      assert.equal((await put(body)).status, status, JSON.stringify(body));
    assert.equal((await put({ scorers: ['s-lionel-n'] }, 'f99')).status, 404);
    assert.equal(
      (await call('PUT', '/series/s-off/fixtures/f1/officials', { scorers: [] }, REP_A)).status,
      403,
    );
  });

  test('a renamed scorer shows the new name; a rep sees scorers on its own fixtures only', async () => {
    await call('PATCH', '/scorers/s-kevin-p', { displayName: 'Kevin Pillay' });
    const o = (await fixtureOf('s-off', 'f1'))!.officials as Record<
      string,
      Array<{ name: string }>
    >;
    assert.deepEqual(
      o.scorers.map((x) => x.name),
      ['Lionel N', 'Kevin Pillay'],
    );
    await put({ scorers: ['s-lionel-n'] }, 'f2'); // Beta v Gamma — not rep A's
    assert.ok(
      ((await fixtureOf('s-off', 'f1', REP_A))!.officials as { scorers: unknown[] }).scorers,
    );
    assert.equal((await fixtureOf('s-off', 'f2', REP_A))!.officials, undefined);
  });

  test('clearing everything deletes the appointment', async () => {
    await put({ umpires: [], scorers: [], referee: null }, 'f2');
    assert.equal(await repo.getFixtureOfficials(T, 's-off', 'f2'), null);
  });
});

/* ───────────────────────────── Result confirmation ───────────────────────────── */

describe('confirming a result', () => {
  const R1 = '2026-10-03T15:00:00.000Z';
  const R2 = '2026-10-03T16:30:00.000Z';
  before(async () => {
    await repo.putSeries(T, series('s-res'));
    await repo.putFixtureResultIfNewer(T, result('s-res', 'f1', R1));
  });
  const confirm = (body: unknown, fixture = 'f1', auth = ADMIN) =>
    call('POST', `/series/s-res/fixtures/${fixture}/result/confirm`, body, auth);

  test('confirms exactly the result the admin looked at, and shows who and when', async () => {
    const res = await confirm({ recordedAt: R1, note: 'Checked with the scorer' });
    assert.equal(res.status, 200);
    const r = (await fixtureOf('s-res', 'f1'))!.result as Record<string, unknown>;
    assert.equal((r.confirmation as { confirmedBy: string }).confirmedBy, 'admin@test');
    assert.equal((r.confirmation as { note: string }).note, 'Checked with the scorer');
    assert.equal(r.changedSinceConfirmed, false);
  });

  test('refuses a stale page: medicoach sent a newer result after the admin loaded it', async () => {
    await repo.putFixtureResultIfNewer(T, {
      ...result('s-res', 'f1', R2),
      homeScore: '151/4 (20)',
    });
    const res = await confirm({ recordedAt: R1 });
    assert.equal(res.status, 409);
    const body = await json<{ code: string; result: { homeScore: string } }>(res);
    assert.equal(body.code, 'result_changed');
    assert.equal(body.result.homeScore, '151/4 (20)'); // the page can show what changed
  });

  test('a newer result leaves the old confirmation stale until it is checked again', async () => {
    let r = (await fixtureOf('s-res', 'f1'))!.result as Record<string, unknown>;
    assert.equal(r.confirmation, null);
    assert.equal(r.changedSinceConfirmed, true);
    assert.equal((await confirm({ recordedAt: R2 })).status, 200);
    r = (await fixtureOf('s-res', 'f1'))!.result as Record<string, unknown>;
    assert.ok(r.confirmation);
    assert.equal(r.changedSinceConfirmed, false);
  });

  test('the confirmation survives the puller replacing the result item', async () => {
    // A replay of the same result through the real puller (whole-item Put of FIXRESULT#).
    await pull([change('s-res', 'f1', liveResult(R2))]);
    assert.ok(((await fixtureOf('s-res', 'f1'))!.result as Record<string, unknown>).confirmation);
  });

  test('cannot confirm a fixture with no result, or one medicoach cleared', async () => {
    assert.equal(
      (await json<{ code: string }>(await confirm({ recordedAt: R1 }, 'f2'))).code,
      'no_result',
    );
    await repo.putFixtureResultIfNewer(T, {
      seriesId: 's-res',
      fixtureId: 'f3',
      ref: 'x',
      orderAt: R2,
      cleared: true,
      clearedAt: R2,
      storedAt: R2,
    });
    const res = await confirm({ recordedAt: R2 }, 'f3');
    assert.equal(res.status, 409);
    assert.equal((await json<{ code: string }>(res)).code, 'no_result');
  });

  test('a clear from medicoach after confirming removes the result (nothing confirmed shows)', async () => {
    await repo.putFixtureResultIfNewer(T, result('s-res', 'f2', R1));
    assert.equal((await confirm({ recordedAt: R1 }, 'f2')).status, 200);
    await pull([change('s-res', 'f2', null, '2026-10-04T08:00:00.000Z')]);
    assert.equal((await fixtureOf('s-res', 'f2'))!.result, undefined);
  });

  test('validates the request and who may confirm', async () => {
    assert.equal((await confirm({})).status, 400);
    assert.equal((await confirm({ recordedAt: 'last saturday' })).status, 400);
    assert.equal((await confirm({ recordedAt: R2, note: 'x'.repeat(501) })).status, 400);
    assert.equal((await confirm({ recordedAt: R2 }, 'f99')).status, 404);
    assert.equal((await confirm({ recordedAt: R2 }, 'f1', REP_A)).status, 403);
    assert.equal(
      (await call('POST', '/series/s-nope/fixtures/f1/result/confirm', { recordedAt: R2 })).status,
      404,
    );
  });

  test('withdrawing is idempotent; a rep never sees confirmations', async () => {
    const del = () => call('DELETE', '/series/s-res/fixtures/f1/result/confirm');
    assert.equal((await del()).status, 200);
    assert.equal((await del()).status, 200);
    assert.equal(
      ((await fixtureOf('s-res', 'f1'))!.result as Record<string, unknown>).confirmation,
      null,
    );
    await confirm({ recordedAt: R2 });
    const repView = (await fixtureOf('s-res', 'f1', REP_A))!.result as Record<string, unknown>;
    assert.equal(repView.confirmation, null);
  });

  test('refused while the medicoach sync is off', async () => {
    await setFeatures({});
    try {
      assert.equal((await confirm({ recordedAt: R2 })).status, 409);
    } finally {
      await setFeatures({ medicoachSync: true });
    }
  });

  test('deleting the series takes its confirmations with it', async () => {
    await repo.putSeries(T, series('s-gone'));
    await repo.putFixtureResultIfNewer(T, result('s-gone', 'f1', R1));
    await call('POST', '/series/s-gone/fixtures/f1/result/confirm', { recordedAt: R1 });
    assert.equal((await call('DELETE', '/series/s-gone')).status, 200);
    assert.deepEqual(
      (await repo.listResultConfirmations(T)).filter((c) => c.seriesId === 's-gone'),
      [],
    );
  });
});

/* ───────────────────────────── Ground time and balls ───────────────────────────── */

describe('ground time and balls from the pull', () => {
  before(async () => repo.putSeries(T, series('s-play')));

  test('stored with the result and shown on the fixture', async () => {
    const play = {
      startedAt: '2026-10-03T08:04:00.000Z',
      endedAt: '2026-10-03T11:31:00.000Z',
      legalBalls: 240,
      deliveries: 257,
    };
    const run = await pull([
      change('s-play', 'f1', liveResult('2026-10-03T11:32:00.000Z', { play })),
    ]);
    assert.equal(run.counts.resultsStored, 1);
    assert.deepEqual(
      ((await fixtureOf('s-play', 'f1'))!.result as Record<string, unknown>).play,
      play,
    );
  });

  test('a malformed block never blocks the result; an old medicoach without it still syncs', async () => {
    const run = await pull([
      change('s-play', 'f2', liveResult('2026-10-03T15:00:00.000Z', { play: { legalBalls: -1 } })),
      change('s-play', 'f3', liveResult('2026-10-10T15:00:00.000Z')),
    ]);
    assert.equal(run.status, 'ok');
    assert.equal(run.counts.resultsStored, 2);
    const f2 = (await fixtureOf('s-play', 'f2'))!.result as Record<string, unknown>;
    const f3 = (await fixtureOf('s-play', 'f3'))!.result as Record<string, unknown>;
    assert.equal(f2.play, null);
    assert.equal(f2.homeScore, '184/6 (20)');
    assert.equal(f3.play, null);
  });
});

/* ───────────────────────────── Removing synced fixtures ───────────────────────────── */

describe('removing a fixture medicoach already holds', () => {
  const without = (s: Series, fixtureId: string) => ({
    fixtures: (s.fixtures as Fx[]).filter((f) => f.id !== fixtureId),
    version: s.version,
  });

  test('a released, synced series refuses it and points at "mark cancelled"', async () => {
    await repo.putSeries(T, series('s-sync'));
    const s = (await repo.getSeries(T, 's-sync'))!;
    const res = await call('PATCH', '/series/s-sync', without(s, 'f2'));
    assert.equal(res.status, 409);
    const body = await json<{ code: string; fixtureIds: string[]; error: string }>(res);
    assert.equal(body.code, 'synced_fixture_removed');
    assert.deepEqual(body.fixtureIds, ['f2']);
    assert.match(body.error, /cancelled/);
    assert.equal(((await repo.getSeries(T, 's-sync'))!.fixtures as Fx[]).length, 3);
    // Marking it cancelled is the supported path.
    const cancelled = await call('PATCH', '/series/s-sync', {
      fixtures: (s.fixtures as Fx[]).map((f) =>
        f.id === 'f2' ? { ...f, status: 'cancelled' } : f,
      ),
      version: s.version,
    });
    assert.equal(cancelled.status, 200);
  });

  test('with confirmation it goes, and its appointments and confirmation go with it', async () => {
    await call('POST', '/scorers', { displayName: 'Cleanup Scorer' });
    await call('PUT', '/series/s-sync/fixtures/f3/officials', { scorers: ['s-cleanup-scorer'] });
    await repo.putFixtureResultIfNewer(T, result('s-sync', 'f3', '2026-10-10T15:00:00.000Z'));
    await call('POST', '/series/s-sync/fixtures/f3/result/confirm', {
      recordedAt: '2026-10-10T15:00:00.000Z',
    });
    const s = (await repo.getSeries(T, 's-sync'))!;
    const res = await call('PATCH', '/series/s-sync', {
      ...without(s, 'f3'),
      confirmRemoveSynced: true,
    });
    assert.equal(res.status, 200);
    assert.equal(await repo.getFixtureOfficials(T, 's-sync', 'f3'), null);
    assert.equal(await repo.getResultConfirmation(T, 's-sync', 'f3'), null);
    // The action key is never stored on the series.
    assert.equal('confirmRemoveSynced' in (await repo.getSeries(T, 's-sync'))!, false);
  });

  test('a draft series, or a tenant without the sync, removes freely', async () => {
    await repo.putSeries(T, series('s-draft', { released: false, approved: false }));
    let s = (await repo.getSeries(T, 's-draft'))!;
    assert.equal((await call('PATCH', '/series/s-draft', without(s, 'f1'))).status, 200);
    await setFeatures({});
    try {
      await repo.putSeries(T, series('s-nosync'));
      s = (await repo.getSeries(T, 's-nosync'))!;
      assert.equal((await call('PATCH', '/series/s-nosync', without(s, 'f1'))).status, 200);
    } finally {
      await setFeatures({ medicoachSync: true });
    }
  });

  test('a stale tab still gets the plain concurrency 409 first', async () => {
    const s = (await repo.getSeries(T, 's-sync'))!;
    const res = await call('PATCH', '/series/s-sync', {
      ...without(s, 'f1'),
      version: s.version - 1,
    });
    assert.equal(res.status, 409);
    assert.match((await json<{ error: string }>(res)).error, /series changed/);
  });
});
