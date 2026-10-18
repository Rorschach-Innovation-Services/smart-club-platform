/**
 * Fixture create/delete propagation in the smart club → medicoach schedule push (contract §2
 * "Create/delete ops", 2026-10-18). A STUB medicoach answers pushes per op; the REAL diff
 * helper, outbox, flush and Hono app run against an in-process dynalite table.
 *
 *   - a fixture added to a released, mapped series is queued as `op: "create"` with its wire
 *     payload; an undated one is not (awaiting carry) until it gets a date;
 *   - a removed fixture (and every fixture of a deleted series) is a self-contained
 *     `op: "delete"` row that survives its series;
 *   - the one collapse rule (create + edit, create + removal, delete + re-add of the same /
 *     another match) and putPendingSync's op-aware condition (a delete is never replaced by an
 *     upsert; same-millisecond ties go to the superseding op);
 *   - the flush: op rows in their own batches, creates feeders-first, `created` clears the
 *     awaiting-carry ref, a delete answer never records one;
 *   - a draft's held create still goes out as a create on release.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PendingScheduleSync, Series, TenantConfig, Venue } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4727;
const TABLE = 'SmartClubMedicoachCreateDelete';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const T = 'dolphins';
const SECRET = 'stub-shared-secret';
const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
const ADMIN = devAuth('admin@test', [{ tenantId: T, role: 'admin', clubIds: [] }]);
const headers = () => ({ 'x-tenant': T, 'x-dev-auth': ADMIN, 'content-type': 'application/json' });

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let schedule: typeof import('../src/medicoach-sync/schedule.js');
let contract: typeof import('../src/medicoach-sync-contract.js');

// ── Stub medicoach ──
interface Change {
  ref: string;
  op?: string;
  schedule: Record<string, unknown>;
  create?: Record<string, unknown>;
}
let stub: Server;
let stubUrl = '';
const pushes: Array<{ changes: Change[]; valid: boolean }> = [];
/** Default: an upsert applies, a create is created, a delete is deleted. */
let answer: (c: Change) => string = (c) =>
  c.op === 'create' ? 'created' : c.op === 'delete' ? 'deleted' : 'applied';

function startStub(): Promise<void> {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      pushes.push({
        changes: body.changes,
        valid: contract.SchedulePushRequestSchema.safeParse(body).success,
      });
      const results = body.changes.map((c: Change) => ({ ref: c.ref, status: answer(c) }));
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ version: 1, results }));
    });
  });
  return new Promise((resolve) =>
    stub.listen(0, '127.0.0.1', () => {
      stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

// ── Seed ──
const S1 = 's-planb-premier-t20-g1';
const S2 = 's-planb-premier-t20-g2';
const REF = (seriesId: string, fixtureId: string) =>
  `smartclub:${T}:fixture:${seriesId}:${fixtureId}`;
const TEAM = (id: string) => `smartclub:${T}:team:premier:${id}`;
const COMP = `smartclub:${T}:competition:premier:t20`;

const VENUES: Venue[] = [
  { id: 'v-kingsmead', name: 'Kingsmead Oval' },
  { id: 'v-lahee', name: 'Lahee Park' },
];

const series = (id: string, group: number, fixtures: unknown[], over: Partial<Series> = {}) =>
  ({
    id,
    name: `Premier League · T20 · Group ${group}`,
    leagueKey: 'premier',
    startDate: '2026-10-04',
    teams: ['a', 'b', 'c', 'd'],
    participants: ['a', 'b', 'c', 'd'].map((t) => ({
      teamId: t,
      clubId: t,
      name: `Team ${t.toUpperCase()}`,
      venue: 'Kingsmead Oval',
    })),
    fixtures,
    approved: true,
    approvedAt: '2026-09-01T00:00:00.000Z',
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
    ...over,
  }) as unknown as Series;

/** A fixture ADDED by a test: its own date, so no ground is double-booked. */
const nf = (id: string, over: Record<string, unknown> = {}) =>
  fx(id, { date: '2026-11-08', home: 'a', away: 'c', ...over });

const fx = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  round: 1,
  date: '2026-10-04',
  time: '09:00',
  home: 'a',
  away: 'b',
  venueId: 'v-kingsmead',
  venueName: 'Kingsmead Oval',
  ...over,
});

async function seed() {
  await repo.putTenantConfig({
    tenant: T,
    branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: { medicoachSync: true },
  } as unknown as TenantConfig);
  for (const v of VENUES) await repo.putVenue(T, v);
  await repo.putSeries(T, series(S1, 1, [fx('f1'), fx('f2', { home: 'c', away: 'd' })]));
  await repo.putSeries(T, series(S2, 2, [fx('f1', { date: '2026-10-11' })]));
}

const flush = () =>
  schedule.flushScheduleOutbox(T, 'cron', { repo, url: stubUrl, secret: SECRET, log: () => {} });

const patch = async (seriesId: string, body: Record<string, unknown>) => {
  const s = (await repo.getSeries(T, seriesId))!;
  return app.request(`/series/${seriesId}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ version: s.version, ...body }),
  });
};
const fixturesOf = async (seriesId: string) =>
  (await repo.getSeries(T, seriesId))!.fixtures as Array<Record<string, unknown>>;
const addFixture = async (seriesId: string, f: Record<string, unknown>) =>
  patch(seriesId, { fixtures: [...(await fixturesOf(seriesId)), f] });
const removeFixture = async (seriesId: string, id: string) =>
  patch(seriesId, {
    fixtures: (await fixturesOf(seriesId)).filter((f) => f.id !== id),
    confirmRemoveSynced: true,
  });
const pending = async (ref: string) =>
  (await repo.listPendingSync(T)).find((r) => r.ref === ref) ?? null;
const awaiting = async (seriesId: string) =>
  (await repo.listMcAwait(T)).find((r) => r.seriesId === seriesId)?.refs ?? [];

async function resetTable() {
  const { DynamoDBClient, ScanCommand, DeleteItemCommand } =
    await import('@aws-sdk/client-dynamodb');
  const c = new DynamoDBClient({
    endpoint: process.env.DYNAMO_ENDPOINT,
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  // Test-only reset of the in-process table.
  const items = (await c.send(new ScanCommand({ TableName: TABLE }))).Items ?? [];
  for (const i of items)
    await c.send(new DeleteItemCommand({ TableName: TABLE, Key: { pk: i.pk, sk: i.sk } }));
}

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');
  schedule = await import('../src/medicoach-sync/schedule.js');
  contract = await import('../src/medicoach-sync-contract.js');
  await startStub();
});

after(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
  await stopDynalite(ddb);
});

beforeEach(async () => {
  await resetTable();
  await seed();
  pushes.length = 0;
  answer = (c) => (c.op === 'create' ? 'created' : c.op === 'delete' ? 'deleted' : 'applied');
});

describe('creates', () => {
  test('a fixture added to a released, mapped series is queued as a create with its payload', async () => {
    assert.equal((await addFixture(S1, nf('f3', { home: 'a', away: 'c', round: 4 }))).status, 200);
    const row = (await pending(REF(S1, 'f3')))!;
    assert.equal(row.op, 'create');
    assert.deepEqual(row.create, {
      competitionRef: COMP,
      sport: 'cricket',
      homeTeamRef: TEAM('a'),
      awayTeamRef: TEAM('c'),
      stage: 'Group stage',
      groupName: 'Group 1',
      round: 4,
    });
    assert.deepEqual(row.sides, { home: 'a', away: 'c' });
    // Stamped like an edit: the fixture carries the row's changedAt.
    const f3 = (await fixturesOf(S1)).find((f) => f.id === 'f3')!;
    assert.equal((f3.schedule as { changedAt: string }).changedAt, row.schedule.changedAt);
    assert.deepEqual(await awaiting(S1), [], 'a derivable create is not awaiting a carry');
  });

  test('flush sends op + create on the wire; `created` deletes the row and clears MCAWAIT', async () => {
    await repo.upsertMcAwait(
      T,
      { seriesId: S1, refs: [REF(S1, 'f3'), REF(S1, 'f9')] },
      { now: new Date().toISOString() },
    );
    await addFixture(S1, nf('f3', { home: 'a', away: 'c' }));
    const out = await flush();
    assert.equal(out.counts.created, 1);
    assert.equal(pushes.length, 1);
    assert.ok(pushes[0].valid, 'the push body fits the contract');
    const [c] = pushes[0].changes;
    assert.equal(c.op, 'create');
    assert.equal(c.create?.competitionRef, COMP);
    assert.equal(await pending(REF(S1, 'f3')), null);
    assert.deepEqual(await awaiting(S1), [REF(S1, 'f9')]);
    const [log] = await repo.listSyncLogs(T);
    assert.equal(log.push?.created, 1);
  });

  test('an undated fixture is not created (awaiting carry); gaining a date fires the create', async () => {
    await addFixture(S1, nf('f3', { date: undefined, time: undefined, home: 'a', away: 'c' }));
    assert.equal(await pending(REF(S1, 'f3')), null);
    assert.deepEqual(await awaiting(S1), [REF(S1, 'f3')]);
    const fixtures = (await fixturesOf(S1)).map((f) =>
      f.id === 'f3' ? { ...f, date: '2026-11-08', time: '10:00' } : f,
    );
    assert.equal((await patch(S1, { fixtures })).status, 200);
    const row = (await pending(REF(S1, 'f3')))!;
    assert.equal(row.op, 'create');
    assert.equal(row.schedule.scheduledTime, '2026-11-08T10:00:00+02:00');
  });

  test('a `pos:` side is never created; setting the team fires the create', async () => {
    await addFixture(S1, nf('f3', { home: 'pos:Group 2#1', away: 'c' }));
    assert.equal(await pending(REF(S1, 'f3')), null);
    const fixtures = (await fixturesOf(S1)).map((f) => (f.id === 'f3' ? { ...f, home: 'a' } : f));
    assert.equal((await patch(S1, { fixtures })).status, 200);
    assert.equal((await pending(REF(S1, 'f3')))?.op, 'create');
  });

  test('a series whose group label a sibling shares refuses the create (awaiting carry)', async () => {
    await repo.putSeries(T, series(S2, 1, [fx('f1')]));
    await addFixture(S1, nf('f3', { home: 'a', away: 'c' }));
    assert.equal(await pending(REF(S1, 'f3')), null);
    assert.deepEqual(await awaiting(S1), [REF(S1, 'f3')]);
  });

  test("a draft's create is held, and the release sends it as a create (not an upsert)", async () => {
    await repo.putSeries(T, series(S1, 1, [fx('f1')], { released: false, releasedAt: null }));
    await addFixture(S1, nf('f3', { home: 'a', away: 'c' }));
    assert.equal((await pending(REF(S1, 'f3')))?.heldUntilReveal, true);
    assert.equal((await flush()).held, 1);
    assert.equal(pushes.length, 0);
    assert.equal((await patch(S1, { approved: true })).status, 200);
    assert.equal((await patch(S1, { released: true })).status, 200);
    assert.equal((await pending(REF(S1, 'f3')))?.op, 'create', 'requeue kept the create');
    await flush();
    const sent = pushes.flatMap((p) => p.changes);
    assert.equal(sent.find((c) => c.ref === REF(S1, 'f3'))?.op, 'create');
    assert.equal(sent.find((c) => c.ref === REF(S1, 'f1'))?.op, undefined);
  });
});

describe('deletes', () => {
  test('a confirmed removal queues a self-contained delete; `deleted` never awaits a carry', async () => {
    const res = await removeFixture(S1, 'f2');
    assert.equal(res.status, 200);
    const row = (await pending(REF(S1, 'f2')))!;
    assert.equal(row.op, 'delete');
    assert.deepEqual(row.sides, { home: 'c', away: 'd' });
    answer = (c) => (c.op === 'delete' ? 'deleted' : 'applied');
    const out = await flush();
    assert.equal(out.counts.deleted, 1);
    assert.equal(pushes[0].changes[0].op, 'delete');
    assert.equal(await pending(REF(S1, 'f2')), null);
    assert.deepEqual(await repo.listMcAwait(T), []);
  });

  test('the 409 confirm gate stays, and says medicoach deletes its copy too', async () => {
    const s = (await repo.getSeries(T, S1))!;
    const res = await patch(S1, {
      fixtures: (s.fixtures as Array<{ id: string }>).filter((f) => f.id !== 'f2'),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code: string; error: string };
    assert.equal(body.code, 'synced_fixture_removed');
    assert.match(body.error, /deletes the medicoach copy, including any recorded result/);
    assert.match(body.error, /cancelled/);
  });

  test('delete rows survive their deleted series and are sent; its upsert rows are dropped', async () => {
    await removeFixture(S1, 'f2');
    const fixtures = (await fixturesOf(S1)).map((f) =>
      f.id === 'f1' ? { ...f, time: '11:00' } : f,
    );
    await patch(S1, { fixtures });
    assert.equal((await repo.listPendingSync(T)).length, 2);
    await repo.deleteSeries(T, S1);
    const out = await flush();
    assert.equal(out.pending, 1);
    assert.deepEqual(
      pushes.flatMap((p) => p.changes.map((c) => [c.ref, c.op])),
      [[REF(S1, 'f2'), 'delete']],
    );
    assert.deepEqual(await repo.listPendingSync(T), []);
  });

  test('DELETE /series queues a delete per exported fixture AFTER the sync-state wipe', async () => {
    await removeFixture(S1, 'f2'); // an earlier removal still queued
    await repo.putSeries(T, {
      ...(await repo.getSeries(T, S1))!,
      fixtures: [...(await fixturesOf(S1)), fx('f5', { home: 'tbd:Winner Plate', away: 'c' })],
    });
    const res = await app.request(`/series/${S1}`, { method: 'DELETE', headers: headers() });
    assert.equal(res.status, 200);
    const rows = await repo.listPendingSync(T);
    assert.deepEqual(rows.map((r) => [r.ref, r.op]).sort(), [
      [REF(S1, 'f1'), 'delete'],
      [REF(S1, 'f2'), 'delete'],
    ]);
    await flush();
    assert.equal(pushes.flatMap((p) => p.changes).length, 2);
    assert.deepEqual(await repo.listPendingSync(T), []);
  });
});

describe('collapse', () => {
  test('pending create + schedule edit → the create with the newer schedule', async () => {
    await addFixture(S1, nf('f3', { home: 'a', away: 'c' }));
    const first = (await pending(REF(S1, 'f3')))!;
    await new Promise((r) => setTimeout(r, 5));
    const fixtures = (await fixturesOf(S1)).map((f) =>
      f.id === 'f3' ? { ...f, time: '14:00' } : f,
    );
    await patch(S1, { fixtures });
    const row = (await pending(REF(S1, 'f3')))!;
    assert.equal(row.op, 'create');
    assert.deepEqual(row.create, first.create);
    assert.equal(row.schedule.scheduledTime, '2026-11-08T14:00:00+02:00');
    assert.ok(row.schedule.changedAt > first.schedule.changedAt);
  });

  test('pending create + removal → a delete (never dropped)', async () => {
    await addFixture(S1, nf('f3', { home: 'a', away: 'c' }));
    await new Promise((r) => setTimeout(r, 5));
    await removeFixture(S1, 'f3');
    assert.equal((await pending(REF(S1, 'f3')))?.op, 'delete');
  });

  test('pending delete + the same match re-added → a create', async () => {
    await removeFixture(S1, 'f2');
    await new Promise((r) => setTimeout(r, 5));
    await addFixture(S1, nf('f2', { home: 'c', away: 'd' }));
    const row = (await pending(REF(S1, 'f2')))!;
    assert.equal(row.op, 'create');
    assert.deepEqual(await awaiting(S1), []);
  });

  test('pending delete + ANOTHER match under the same id → the delete stays, the ref awaits a carry', async () => {
    await removeFixture(S1, 'f2');
    await new Promise((r) => setTimeout(r, 5));
    await addFixture(S1, nf('f2', { home: 'a', away: 'd' }));
    assert.equal((await pending(REF(S1, 'f2')))?.op, 'delete');
    assert.deepEqual(await awaiting(S1), [REF(S1, 'f2')]);
  });

  test('collapsePending (pure): the transition table', () => {
    const base = (over: Partial<PendingScheduleSync>): PendingScheduleSync => ({
      ref: 'r',
      seriesId: 's',
      fixtureId: 'f',
      schedule: {
        scheduledTime: null,
        timeTbc: true,
        dateTbc: true,
        venue: null,
        postponed: false,
        cancelled: false,
        changedAt: '2026-10-18T10:00:00.000Z',
      },
      origin: 'admin',
      enqueuedAt: '2026-10-18T10:00:00.000Z',
      attempts: 0,
      ...over,
    });
    const create = { competitionRef: 'c', sport: 'cricket', stage: 'Group stage' };
    const del = base({ op: 'delete', sides: { home: 'a', away: 'b' } });
    assert.deepEqual(schedule.collapsePending(del, base({})), { kind: 'await-carry' });
    assert.equal(
      schedule.collapsePending(del, base({ op: 'create', create, sides: { home: 'a', away: 'b' } }))
        .kind,
      'write',
    );
    assert.deepEqual(
      schedule.collapsePending(
        del,
        base({ op: 'create', create, sides: { home: 'b', away: 'a' } }),
      ),
      { kind: 'await-carry' },
    );
    const merged = schedule.collapsePending(base({ op: 'create', create }), base({}));
    assert.equal(merged.kind === 'write' && merged.row.op, 'create');
    assert.equal(
      schedule.collapsePending(base({ op: 'create', create }), base({ op: 'delete' })).kind ===
        'write',
      true,
    );
  });
});

describe('putPendingSync is op-aware (a DynamoDB condition: writers race)', () => {
  const row = (
    changedAt: string,
    over: Partial<PendingScheduleSync> = {},
  ): PendingScheduleSync => ({
    ref: REF(S1, 'f1'),
    seriesId: S1,
    fixtureId: 'f1',
    schedule: {
      scheduledTime: '2026-10-04T09:00:00+02:00',
      timeTbc: false,
      dateTbc: false,
      venue: 'Kingsmead Oval',
      postponed: false,
      cancelled: false,
      changedAt,
    },
    origin: 'admin',
    enqueuedAt: changedAt,
    attempts: 0,
    ...over,
  });
  const create = { competitionRef: COMP, sport: 'cricket', stage: 'Group stage' };
  const t1 = '2026-10-18T10:00:00.000Z';
  const t2 = '2026-10-18T10:00:01.000Z';
  const stored = async () => (await pending(REF(S1, 'f1')))!;

  test('a NEWER upsert never replaces a delete row', async () => {
    assert.equal(await repo.putPendingSync(T, row(t1, { op: 'delete' })), true);
    assert.equal(await repo.putPendingSync(T, row(t2)), false);
    assert.equal((await stored()).op, 'delete');
  });

  test('a newer create replaces a delete (the re-add); an older one does not', async () => {
    await repo.putPendingSync(T, row(t2, { op: 'delete' }));
    assert.equal(await repo.putPendingSync(T, row(t1, { op: 'create', create })), false);
    assert.equal((await stored()).op, 'delete');
    await repo.putPendingSync(T, row(t1, { op: 'delete' })); // older delete: kept t2
    assert.equal((await stored()).schedule.changedAt, t2);
    const t3 = '2026-10-18T10:00:02.000Z';
    assert.equal(await repo.putPendingSync(T, row(t3, { op: 'create', create })), true);
    assert.equal((await stored()).op, 'create');
  });

  test('same-millisecond ties go to the superseding op, never dropped', async () => {
    await repo.putPendingSync(T, row(t1));
    assert.equal(await repo.putPendingSync(T, row(t1, { op: 'create', create })), true);
    assert.equal(await repo.putPendingSync(T, row(t1)), false, 'an upsert never demotes a tie');
    assert.equal(await repo.putPendingSync(T, row(t1, { op: 'delete' })), true);
    assert.equal(await repo.putPendingSync(T, row(t1, { op: 'create', create })), false);
    assert.equal((await stored()).op, 'delete');
    // An equal snapshot of the same op stays a no-op.
    assert.equal(await repo.putPendingSync(T, row(t1, { op: 'delete' })), false);
  });

  test('a delete replaces any upsert, even one stamped later (clock skew)', async () => {
    await repo.putPendingSync(T, row(t2));
    assert.equal(await repo.putPendingSync(T, row(t1, { op: 'delete' })), true);
    assert.equal((await stored()).op, 'delete');
  });

  test('a flush answer for the create does not delete a same-instant delete that replaced it', async () => {
    await repo.putPendingSync(T, row(t1, { op: 'create', create }));
    await repo.putPendingSync(T, row(t1, { op: 'delete' }));
    assert.equal(await repo.deletePendingSyncIfUnchanged(T, REF(S1, 'f1'), t1, 'create'), false);
    assert.equal((await stored()).op, 'delete');
  });

  test('a racing writer that demotes a create falls back to awaiting carry, not corruption', async () => {
    // Writer A queued the create; writer B read before it existed and lands a newer upsert
    // straight through putPendingSync (bypassing the collapse read).
    await repo.putPendingSync(
      T,
      row(t1, { ref: REF(S1, 'f7'), fixtureId: 'f7', op: 'create', create }),
    );
    await repo.putPendingSync(T, row(t2, { ref: REF(S1, 'f7'), fixtureId: 'f7' }));
    assert.equal((await pending(REF(S1, 'f7')))?.op, undefined);
    answer = (c) => (c.op ? 'created' : 'unmapped'); // medicoach has no f7 to update
    const out = await flush();
    assert.equal(out.counts.unmapped, 1);
    assert.deepEqual(await awaiting(S1), [REF(S1, 'f7')]);
    assert.equal(await pending(REF(S1, 'f7')), null);
  });
});

describe('flush batching', () => {
  test('op rows go in their own batch: deletes, then creates feeders-first', async () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 18, 10, 0, s)).toISOString();
    const snap = (changedAt: string) => ({
      scheduledTime: '2026-11-01T09:00:00+02:00',
      timeTbc: false,
      dateTbc: false,
      venue: 'Kingsmead Oval',
      postponed: false,
      cancelled: false,
      changedAt,
    });
    const put = (fixtureId: string, s: number, over: Partial<PendingScheduleSync> = {}) =>
      repo.putPendingSync(T, {
        ref: REF(S1, fixtureId),
        seriesId: S1,
        fixtureId,
        schedule: snap(at(s)),
        origin: 'admin',
        enqueuedAt: at(s),
        attempts: 0,
        ...over,
      });
    const base = { competitionRef: COMP, sport: 'cricket', stage: 'Knockout' };
    // Enqueued slot-create first, so ordering is not an accident of insertion.
    await put('f8', 1, {
      op: 'create',
      create: {
        ...base,
        homeSlot: { kind: 'winner', ofFixtureRef: REF(S1, 'f6') },
        awaySlot: { kind: 'winner', ofFixtureRef: REF(S1, 'f7') },
      },
    });
    await put('f1', 2);
    await put('f6', 3, {
      op: 'create',
      create: { ...base, homeTeamRef: TEAM('a'), awayTeamRef: TEAM('b') },
    });
    await put('f2', 4, { op: 'delete' });
    const out = await flush();
    assert.equal(out.counts.sent, 4);
    assert.deepEqual(
      pushes.map((p) => p.changes.map((c) => c.ref.split(':').pop())),
      [['f1'], ['f2', 'f6', 'f8']],
    );
    assert.ok(pushes.every((p) => p.valid));
    assert.deepEqual(await repo.listPendingSync(T), []);
  });

  test('an op batch rejected by an older medicoach (HTTP 400) never fails the upserts', async () => {
    await removeFixture(S1, 'f2');
    const fixtures = (await fixturesOf(S1)).map((f) =>
      f.id === 'f1' ? { ...f, time: '11:00' } : f,
    );
    await patch(S1, { fixtures });
    const real = fetch;
    const out = await schedule.flushScheduleOutbox(T, 'cron', {
      repo,
      url: stubUrl,
      secret: SECRET,
      log: () => {},
      fetch: (async (url: string, init: RequestInit) =>
        String(init.body).includes('"op"')
          ? new Response('{"error":"strict"}', { status: 400 })
          : real(url, init)) as typeof fetch,
    });
    assert.equal(out.counts.applied, 1);
    assert.equal(out.counts.unreached, 1);
    assert.equal((await pending(REF(S1, 'f2')))?.op, 'delete', 'kept for the next run');
    assert.equal(await pending(REF(S1, 'f1')), null);
  });
});

describe('fixture id high-water mark', () => {
  test('every series write keeps maxFixtureIdEver: a removed id stays used', async () => {
    assert.equal((await repo.getSeries(T, S1))!.maxFixtureIdEver, 2);
    await removeFixture(S1, 'f2');
    assert.equal((await repo.getSeries(T, S1))!.maxFixtureIdEver, 2);
    // A whole-item put of a freshly built series object (an importer) never lowers it.
    const fresh = series(S1, 1, [fx('f1')]);
    delete (fresh as { maxFixtureIdEver?: number }).maxFixtureIdEver;
    await repo.putSeries(T, fresh);
    assert.equal((await repo.getSeries(T, S1))!.maxFixtureIdEver, 2);
    // An admin-minted id is absorbed.
    await addFixture(S1, nf('f1760000000000', { home: 'a', away: 'c' }));
    assert.equal((await repo.getSeries(T, S1))!.maxFixtureIdEver, 1760000000000);
  });

  test('the Plan-B importer never re-mints a removed fixture id', async () => {
    const { stabiliseFixtureIds } = await import('../src/import-planb-fixtures.js');
    await removeFixture(S1, 'f2');
    const stored = (await repo.getSeries(T, S1))!;
    const built = [
      {
        series: stored,
        fixtures: [
          { ...fx('f1') },
          { ...fx('f2', { home: 'b', away: 'd', date: '2026-11-22' }) },
        ] as never[],
      },
    ];
    stabiliseFixtureIds(T, built as never, [stored]);
    assert.deepEqual(
      (built[0].fixtures as Array<{ id: string }>).map((f) => f.id),
      ['f1', 'f3'],
    );
  });
});

describe('an upsert medicoach answers `unmapped` becomes a create (next run)', () => {
  const editF1 = async () => {
    const fixtures = (await fixturesOf(S1)).map((f) =>
      f.id === 'f1' ? { ...f, time: '11:00', venueId: 'v-lahee', venueName: 'Lahee Park' } : f,
    );
    assert.equal((await patch(S1, { fixtures })).status, 200);
  };

  test('converted to a queued create with the current schedule; MCAWAIT is not written', async () => {
    await editF1();
    answer = (c) => (c.op ? 'created' : 'unmapped');
    const out = await flush();
    assert.equal(out.counts.unmapped, 1);
    assert.equal(out.counts.convertedToCreate, 1);
    const row = (await pending(REF(S1, 'f1')))!;
    assert.equal(row.op, 'create');
    assert.equal(row.create?.competitionRef, COMP);
    assert.equal(row.schedule.scheduledTime, '2026-10-04T11:00:00+02:00');
    assert.equal(row.schedule.venue, 'Lahee Park');
    assert.deepEqual(await repo.listMcAwait(T), []);
    pushes.length = 0;
    await flush();
    assert.equal(pushes[0].changes[0].op, 'create');
    assert.equal(await pending(REF(S1, 'f1')), null);
  });

  test('a create that cannot be derived still records MCAWAIT', async () => {
    await repo.putSeries(T, series(S2, 1, [fx('f1', { date: '2026-10-11' })])); // same group label
    await editF1();
    answer = () => 'unmapped';
    await flush();
    assert.equal(await pending(REF(S1, 'f1')), null);
    assert.deepEqual(await awaiting(S1), [REF(S1, 'f1')]);
  });

  test('the converted create never replaces a delete queued meanwhile (op precedence)', async () => {
    await editF1();
    answer = () => 'unmapped';
    const real = fetch;
    const out = await schedule.flushScheduleOutbox(T, 'cron', {
      repo,
      url: stubUrl,
      secret: SECRET,
      log: () => {},
      // While the push is in flight the fixture is removed: a newer delete lands.
      fetch: (async (url: string, init: RequestInit) => {
        await repo.putPendingSync(T, {
          ref: REF(S1, 'f1'),
          seriesId: S1,
          fixtureId: 'f1',
          op: 'delete',
          sides: { home: 'a', away: 'b' },
          schedule: {
            scheduledTime: null,
            timeTbc: true,
            dateTbc: true,
            venue: null,
            postponed: false,
            cancelled: false,
            changedAt: new Date(Date.now() + 1000).toISOString(),
          },
          origin: 'admin',
          enqueuedAt: new Date().toISOString(),
          attempts: 0,
        });
        return real(url, init);
      }) as typeof fetch,
    });
    assert.equal(out.counts.unmapped, 1);
    assert.equal((await pending(REF(S1, 'f1')))?.op, 'delete');
  });
});

describe('admin feedback and cleanup', () => {
  test('PATCH answers medicoachAwaitingCarry for an added fixture that cannot be created', async () => {
    const ok = await addFixture(S1, nf('f3'));
    assert.equal(((await ok.json()) as Record<string, unknown>).medicoachAwaitingCarry, undefined);
    const undated = await addFixture(S1, nf('f4', { date: undefined, time: undefined }));
    assert.equal(undated.status, 200);
    const body = (await undated.json()) as Record<string, unknown>;
    assert.deepEqual(body.medicoachAwaitingCarry, ['f4']);
    // Echoed back on the next whole-series save, it is never stored.
    await patch(S1, { ...body, fixtures: await fixturesOf(S1) });
    assert.equal((await repo.getSeries(T, S1))!.medicoachAwaitingCarry, undefined);
  });

  test('DELETE /series clears its awaiting-carry row', async () => {
    await addFixture(S1, nf('f4', { date: undefined, time: undefined }));
    assert.deepEqual(await awaiting(S1), [REF(S1, 'f4')]);
    assert.equal(
      (await app.request(`/series/${S1}`, { method: 'DELETE', headers: headers() })).status,
      200,
    );
    assert.deepEqual(await repo.listMcAwait(T), []);
  });
});
