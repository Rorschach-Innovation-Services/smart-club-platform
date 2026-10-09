/**
 * Match Centre Connection Console, Phase 1 (ADR 0020) end to end: a STUB medicoach on a free
 * localhost port answers `POST /integrations/smartclub/import/check-refs` (verifying every
 * signature with the contract helper), schedule pushes and empty change pages, while the REAL
 * write path, outbox flush, reconciliation and Hono app run against an in-process dynalite
 * table.
 *
 *  - awaiting carry is persisted (MCAWAIT#): new fixtures of a mapped series (unioned, firstSeen
 *    kept) and refs a schedule push comes back `unmapped` for;
 *  - the reconciliation marks unmapped refs, clears series medicoach now has in full, drops
 *    rows of deleted series, leaves draft rows alone and stamps MCRECON#; a 404, a dry run or a
 *    down medicoach stamps `mcReachable: false` and leaves the rows untouched; the cron runs it
 *    when the last stamp is over a day old (an hour after a failed attempt);
 *  - GET /platform/tenants/:slug/medicoach/connection (exact shape, dry run, never synced, live),
 *    GET /platform/medicoach/overview, POST …/medicoach/reconcile — operators only;
 *  - hardening: check-refs pathologies (non-JSON, contract violations, unasked refs, timeout,
 *    a failing second chunk), series lifecycle (back to draft, deleted, league unmapped),
 *    MCAWAIT union/replace, overlapping runs serialised by the per-tenant lease (busy / 409,
 *    rerun, expiry takeover, a stale holder's release, per-chunk renewal, a lost lease aborting
 *    without writes, non-decreasing stamps), the 24h / 1h-retry gate boundaries,
 *    connection/overview edges and the best-effort write path.
 */
import { test, before, after, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Series, TenantConfig } from '../src/types.js';
import type { MedicoachConnectionView } from '../src/medicoach-sync/connection.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4713;
const TABLE = 'SmartClubMedicoachConnection';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const T = 'dolphins';
const OTHER = 'titans';
const SECRET = 'stub-shared-secret';
const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
const ADMIN = devAuth('admin@test', [{ tenantId: T, role: 'admin', clubIds: [] }]);
const OPERATOR = devAuth('ops@platform.test', [{ tenantId: '*', role: 'operator', clubIds: [] }]);
const headers = (auth = ADMIN) => ({
  'x-tenant': T,
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let schedule: typeof import('../src/medicoach-sync/schedule.js');
let reconcile: typeof import('../src/medicoach-sync/reconcile.js');
let run: typeof import('../src/medicoach-sync/run.js');
let contract: typeof import('../src/medicoach-sync-contract.js');

// ── Stub medicoach ──
let stub: Server;
let stubUrl = '';
interface CheckRefsCall {
  verified: boolean;
  body: { tenant: string; refs: string[] };
}
const checkCalls: CheckRefsCall[] = [];
/** Refs the stub answers `unmapped` (everything else is `mapped`). */
let unmappedRefs = new Set<string>();
/** A whole-request HTTP status for check-refs (404 = endpoint not deployed). */
let checkHttpFail: number | null = null;
let pushStatus: (ref: string) => string = () => 'applied';

function startStub(): Promise<void> {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const check = contract.verifySignature({
        secret: SECRET,
        method: req.method ?? 'GET',
        pathAndQuery: req.url ?? '',
        body: raw,
        timestampHeader: req.headers['x-sync-timestamp'] as string | undefined,
        signatureHeader: req.headers['x-sync-signature'] as string | undefined,
      });
      const json = (status: number, body: unknown) =>
        void res
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify(body));
      if (!check.ok) return json(401, {});
      if (req.method === 'POST' && req.url === contract.IMPORT_CHECK_REFS_PATH) {
        const body = JSON.parse(raw);
        checkCalls.push({ verified: check.ok, body });
        if (checkHttpFail) return json(checkHttpFail, { error: 'nope' });
        return json(200, {
          mapped: body.refs.filter((r: string) => !unmappedRefs.has(r)),
          unmapped: body.refs.filter((r: string) => unmappedRefs.has(r)),
        });
      }
      if (req.method === 'POST' && req.url === contract.SCHEDULE_PATH) {
        const body = JSON.parse(raw);
        return json(200, {
          version: 1,
          results: body.changes.map((c: { ref: string }) => ({
            ref: c.ref,
            status: pushStatus(c.ref),
          })),
        });
      }
      if (req.method === 'GET' && req.url?.startsWith(contract.CHANGES_PATH))
        return json(200, {
          version: 1,
          tenant: T,
          nextCursor: 'c-1',
          hasMore: false,
          fixtures: [],
        });
      return json(404, { error: 'unknown route' });
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
const S1 = 's-planb-premier-men-t20-g1';
const S2 = 's-planb-premier-men-t20-g2';
const REF = (seriesId: string, fixtureId: string) =>
  `smartclub:${T}:fixture:${seriesId}:${fixtureId}`;

const series = (id: string, fixtures: unknown[], over: Partial<Series> = {}): Series =>
  ({
    id,
    name: `Premier T20 ${id.slice(-2)}`,
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
    kind: 'series',
    approved: true,
    approvedAt: '2026-09-01T00:00:00.000Z',
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
    ...over,
  }) as unknown as Series;

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

const tenantConfig = (tenant: string, name: string, features: Record<string, boolean>) =>
  ({
    tenant,
    branding: { name, title: name, logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features,
  }) as unknown as TenantConfig;

async function seed() {
  await repo.putTenantConfig({
    ...tenantConfig(T, 'Dolphins', { medicoachSync: true }),
    integrations: { medicoach: { goLiveDate: '2026-10-01', playerSync: true } },
  } as unknown as TenantConfig);
  await repo.putTenantConfig(tenantConfig(OTHER, 'Titans', {}));
  await repo.putVenue(T, { id: 'v-kingsmead', name: 'Kingsmead Oval' });
  await repo.putSeries(
    T,
    series(S1, [
      fx('f1'),
      fx('f2', { home: 'c', away: 'd', time: '13:30' }),
      // A `pos:` side was never exported: never checked against medicoach.
      fx('f9', { home: 'pos:A:1', away: 'pos:B:2', date: '2026-11-29' }),
    ]),
  );
  // A draft: not walked by the reconciliation.
  await repo.putSeries(
    T,
    series(S2, [fx('f1', { home: 'c', away: 'd' })], { released: false, releasedAt: undefined }),
  );
}

async function resetTable() {
  const { DynamoDBClient, ScanCommand, DeleteItemCommand } =
    await import('@aws-sdk/client-dynamodb');
  const c = new DynamoDBClient({
    endpoint: process.env.DYNAMO_ENDPOINT,
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const items = (await c.send(new ScanCommand({ TableName: TABLE }))).Items ?? [];
  for (const i of items)
    await c.send(new DeleteItemCommand({ TableName: TABLE, Key: { pk: i.pk, sk: i.sk } }));
}

interface ReconcileOver {
  url?: string;
  now?: () => Date;
  fetch?: typeof fetch;
  repo?: typeof repo;
}

/** One reconciliation run as-is: a stamp, or `{ busy: true }` when another run holds the lease. */
const reconcileAttempt = (over: ReconcileOver = {}) =>
  reconcile.reconcileAwaitingCarry(T, {
    repo: over.repo ?? repo,
    url: over.url ?? stubUrl,
    secret: SECRET,
    log: () => {},
    ...(over.now ? { now: over.now } : {}),
    ...(over.fetch ? { fetch: over.fetch } : {}),
  });

/** A run expected to take the lease: its MCRECON# stamp (fails the test if it was busy). */
const reconcileNow = async (over: ReconcileOver = {}) => {
  const result = await reconcileAttempt(over);
  assert.ok(!reconcile.isReconcileBusy(result), 'the run took the lease');
  return result;
};

const awaitRow = async (seriesId: string) =>
  (await repo.listMcAwait(T)).find((r) => r.seriesId === seriesId);

const setLiveEnv = () => {
  process.env.MEDICOACH_SYNC_URL = stubUrl;
  process.env.MEDICOACH_SYNC_SECRET = SECRET;
};
const clearEnv = () => {
  delete process.env.MEDICOACH_SYNC_URL;
  delete process.env.MEDICOACH_SYNC_SECRET;
};

before(async () => {
  clearEnv();
  ddb = await startDynalite(DDB_PORT, TABLE);
  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');
  schedule = await import('../src/medicoach-sync/schedule.js');
  reconcile = await import('../src/medicoach-sync/reconcile.js');
  run = await import('../src/medicoach-sync/run.js');
  contract = await import('../src/medicoach-sync-contract.js');
  await startStub();
});

after(async () => {
  clearEnv();
  await new Promise<void>((r) => stub.close(() => r()));
  await stopDynalite(ddb);
});

beforeEach(async () => {
  clearEnv();
  await resetTable();
  await seed();
  checkCalls.length = 0;
  unmappedRefs = new Set();
  checkHttpFail = null;
  pushStatus = () => 'applied';
});

describe('awaiting carry — write path (MCAWAIT#)', () => {
  test('fixtures added to a mapped series are recorded per series, unioned, firstSeen kept', async () => {
    const addFixture = async (f: Record<string, unknown>) => {
      const s = (await repo.getSeries(T, S1))!;
      const res = await app.request(`/series/${S1}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ fixtures: [...(s.fixtures as unknown[]), f], version: s.version }),
      });
      assert.equal(res.status, 200, await res.text());
    };
    await addFixture(fx('f3', { date: '2026-11-08', home: 'a', away: 'c' }));
    const first = await awaitRow(S1);
    assert.ok(first);
    assert.deepEqual(first.refs, [REF(S1, 'f3')]);
    assert.equal(first.count, 1);
    assert.equal(first.seriesName, 'Premier T20 g1');
    assert.equal(first.leagueKey, 'premier');
    assert.equal(first.firstSeen, first.lastSeen);

    await new Promise((r) => setTimeout(r, 5)); // a later lastSeen
    await addFixture(fx('f4', { date: '2026-11-15', home: 'b', away: 'd' }));
    const second = (await awaitRow(S1))!;
    assert.deepEqual(second.refs.sort(), [REF(S1, 'f3'), REF(S1, 'f4')]);
    assert.equal(second.count, 2);
    assert.equal(second.firstSeen, first.firstSeen, 'firstSeen is kept');
    assert.ok(second.lastSeen > first.lastSeen, 'lastSeen moves on');
  });

  test('a schedule push answered `unmapped` records the ref as awaiting carry', async () => {
    const s = (await repo.getSeries(T, S1))!;
    const res = await app.request(`/series/${S1}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({
        fixtures: (s.fixtures as Array<Record<string, unknown>>).map((f) =>
          f.id === 'f2' ? { ...f, time: '14:00' } : f,
        ),
        version: s.version,
      }),
    });
    assert.equal(res.status, 200, await res.text());
    pushStatus = (ref) => (ref === REF(S1, 'f2') ? 'unmapped' : 'applied');
    const summary = await schedule.flushScheduleOutbox(T, 'cron', {
      repo,
      url: stubUrl,
      secret: SECRET,
      log: () => {},
    });
    assert.equal(summary.counts.unmapped, 1);
    assert.deepEqual((await awaitRow(S1))?.refs, [REF(S1, 'f2')]);
    assert.deepEqual(await repo.listPendingSync(T), [], 'the outbox row is still dropped');
  });
});

describe('reconciliation against medicoach check-refs', () => {
  test('marks unmapped refs, clears fully mapped series, drops deleted ones, leaves drafts', async () => {
    const now = new Date().toISOString();
    // Rows the write path left: a draft series (not walked) and a series since deleted.
    await repo.upsertMcAwait(T, { seriesId: S2, refs: [REF(S2, 'f1')] }, { now });
    await repo.upsertMcAwait(T, { seriesId: 's-gone', refs: ['smartclub:x'] }, { now });
    // A stale ref the write path recorded that medicoach now has.
    await repo.upsertMcAwait(T, { seriesId: S1, refs: [REF(S1, 'f1')] }, { now });
    unmappedRefs = new Set([REF(S1, 'f2')]);

    const stamp = await reconcileNow();
    assert.equal(checkCalls.length, 1);
    assert.ok(checkCalls[0].verified, 'signed like sync v1');
    assert.equal(checkCalls[0].body.tenant, T);
    assert.deepEqual(checkCalls[0].body.refs.sort(), [REF(S1, 'f1'), REF(S1, 'f2')]);
    assert.equal(stamp.mcReachable, true);
    assert.equal(stamp.checkedRefs, 2);
    assert.equal(stamp.unmappedTotal, 1);
    assert.deepEqual(await repo.getMcReconcile(T), stamp);

    const rows = await repo.listMcAwait(T);
    assert.deepEqual(rows.map((r) => r.seriesId).sort(), [S1, S2].sort());
    const s1 = rows.find((r) => r.seriesId === S1)!;
    assert.deepEqual(s1.refs, [REF(S1, 'f2')], 'replaced by the ground truth');
    assert.equal(s1.count, 1);
    assert.equal(s1.firstSeen, now, 'firstSeen kept across the replace');
    assert.deepEqual(rows.find((r) => r.seriesId === S2)!.refs, [REF(S2, 'f1')]);

    // Medicoach now has everything: the series row goes.
    unmappedRefs = new Set();
    const again = await reconcileNow();
    assert.equal(again.unmappedTotal, 0);
    assert.equal(await awaitRow(S1), undefined);
    assert.ok(await awaitRow(S2), 'the draft row is still left alone');
  });

  test('refs go in chunks of at most 500', async () => {
    const many = Array.from({ length: 501 }, (_, i) =>
      fx(`g${i}`, { date: '2026-10-04', home: 'a', away: 'b' }),
    );
    await repo.putSeries(T, series('s-big', many));
    await reconcileNow();
    assert.deepEqual(
      checkCalls.map((c) => c.body.refs.length),
      [500, 3],
    );
  });

  test('a 404 (endpoint not deployed) stamps unreachable and leaves the rows untouched', async () => {
    const now = new Date().toISOString();
    await repo.upsertMcAwait(T, { seriesId: S1, refs: [REF(S1, 'f1')] }, { now });
    checkHttpFail = 404;
    const stamp = await reconcileNow();
    assert.equal(stamp.mcReachable, false);
    assert.match(stamp.reason ?? '', /404/);
    assert.equal(stamp.checkedRefs, undefined);
    assert.deepEqual((await awaitRow(S1))?.refs, [REF(S1, 'f1')]);
    assert.equal((await awaitRow(S1))?.lastSeen, now, 'not touched');
  });

  test('a 500 or an unreachable medicoach also degrades gracefully', async () => {
    checkHttpFail = 500;
    assert.match((await reconcileNow()).reason ?? '', /HTTP 500/);
    const down = await reconcileNow({ url: 'http://127.0.0.1:1' });
    assert.equal(down.mcReachable, false);
    assert.match(down.reason ?? '', /unreachable/);
  });

  test('a dry run (secrets unset) makes no request and stamps the reason', async () => {
    const stamp = await reconcileNow({ url: '' });
    assert.equal(checkCalls.length, 0);
    assert.equal(stamp.mcReachable, false);
    assert.match(stamp.reason ?? '', /dry run/);
  });

  test('the cron reconciles only when the last stamp is absent or over a day old', async () => {
    const deps = { repo, url: stubUrl, secret: SECRET, log: () => {} };
    assert.ok(await reconcile.reconcileIfDue(T, deps), 'absent: runs');
    assert.equal(checkCalls.length, 1);
    assert.equal(await reconcile.reconcileIfDue(T, deps), null, 'fresh: skipped');
    assert.equal(checkCalls.length, 1);
    const later = () => new Date(Date.now() + 25 * 3600_000);
    assert.ok(await reconcile.reconcileIfDue(T, { ...deps, now: later }), 'stale: runs');
    assert.equal(checkCalls.length, 2);
  });

  test('a cron tenant sync runs the due reconciliation; "Sync now" does not', async () => {
    unmappedRefs = new Set([REF(S1, 'f1')]);
    const deps = { repo, url: stubUrl, secret: SECRET, log: () => {} };
    await run.runTenantSync(T, 'manual', deps);
    assert.equal(checkCalls.length, 0);
    assert.equal(await repo.getMcReconcile(T), null);
    await run.runTenantSync(T, 'cron', deps);
    assert.equal(checkCalls.length, 1);
    assert.equal((await repo.getMcReconcile(T))?.mcReachable, true);
    assert.deepEqual((await awaitRow(S1))?.refs, [REF(S1, 'f1')]);
  });
});

describe('operator endpoints', () => {
  const get = (path: string, auth = OPERATOR) =>
    app.request(path, { headers: { 'x-dev-auth': auth } });
  const view = async (res: Response | Promise<Response>) =>
    (await (await res).json()) as MedicoachConnectionView;

  const CONNECTION_KEYS = [
    'awaiting',
    'awaitingTotal',
    'dryRun',
    'goLiveDate',
    'health',
    'inferred',
    'lastReconcileAt',
    'mcReachable',
    'playerSync',
    'stage',
    'syncEnabled',
  ];

  test('connection: a never-synced tenant in a dry-run stage', async () => {
    const res = await get(`/platform/tenants/${T}/medicoach/connection`);
    assert.equal(res.status, 200);
    const body = await view(res);
    assert.deepEqual(Object.keys(body).sort(), CONNECTION_KEYS);
    assert.deepEqual(body, {
      stage: 'not_connected',
      inferred: true,
      syncEnabled: true,
      playerSync: true,
      goLiveDate: '2026-10-01',
      dryRun: true,
      mcReachable: null,
      lastReconcileAt: null,
      health: { status: 'dry-run', lastSuccessAt: null, lastError: null },
      awaitingTotal: 0,
      awaiting: [],
    });
  });

  test('connection: never synced with secrets set reads `never`; a tenant without the sync too', async () => {
    setLiveEnv();
    const body = await view(get(`/platform/tenants/${T}/medicoach/connection`));
    assert.equal(body.dryRun, false);
    assert.equal(body.stage, 'not_connected');
    assert.deepEqual(body.health, { status: 'never', lastSuccessAt: null, lastError: null });
    const other = await view(get(`/platform/tenants/${OTHER}/medicoach/connection`));
    assert.equal(other.syncEnabled, false);
    assert.equal(other.playerSync, false);
    assert.equal(other.goLiveDate, null);
    assert.equal(other.stage, 'not_connected');
  });

  test('connection: live, failing health, reconcile stamp and awaiting rows', async () => {
    setLiveEnv();
    await repo.putSyncHealth(T, {
      lastAttemptAt: '2026-10-08T08:15:00.000Z',
      lastSuccessAt: '2026-10-08T08:00:00.000Z',
      lastErrorAt: '2026-10-08T08:15:00.000Z',
      lastError: 'medicoach answered HTTP 502',
    });
    await repo.putMcReconcile(T, {
      lastReconcileAt: '2026-10-08T03:00:00.000Z',
      mcReachable: true,
      checkedRefs: 3,
      unmappedTotal: 3,
    });
    await repo.upsertMcAwait(
      T,
      { seriesId: S1, seriesName: 'Premier T20 g1', leagueKey: 'premier', refs: [REF(S1, 'f1')] },
      { now: '2026-10-07T10:00:00.000Z' },
    );
    await repo.upsertMcAwait(
      T,
      { seriesId: S2, refs: [REF(S2, 'f1'), REF(S2, 'f2')] },
      { now: '2026-10-07T11:00:00.000Z' },
    );
    const body = await view(get(`/platform/tenants/${T}/medicoach/connection`));
    assert.deepEqual(Object.keys(body).sort(), CONNECTION_KEYS);
    assert.equal(body.stage, 'live');
    assert.equal(body.mcReachable, true);
    assert.equal(body.lastReconcileAt, '2026-10-08T03:00:00.000Z');
    assert.deepEqual(body.health, {
      status: 'failing',
      lastSuccessAt: '2026-10-08T08:00:00.000Z',
      lastError: 'medicoach answered HTTP 502',
    });
    assert.equal(body.awaitingTotal, 3);
    assert.deepEqual(body.awaiting, [
      {
        seriesId: S2,
        seriesName: S2,
        leagueKey: '',
        count: 2,
        firstSeen: '2026-10-07T11:00:00.000Z',
        lastSeen: '2026-10-07T11:00:00.000Z',
      },
      {
        seriesId: S1,
        seriesName: 'Premier T20 g1',
        leagueKey: 'premier',
        count: 1,
        firstSeen: '2026-10-07T10:00:00.000Z',
        lastSeen: '2026-10-07T10:00:00.000Z',
      },
    ]);

    // A later success: ok.
    await repo.putSyncHealth(T, { lastSuccessAt: '2026-10-08T08:30:00.000Z' });
    const ok = await view(get(`/platform/tenants/${T}/medicoach/connection`));
    assert.equal(ok.health.status, 'ok');
  });

  test('connection: 404 for an unknown tenant', async () => {
    assert.equal((await get('/platform/tenants/nope/medicoach/connection')).status, 404);
  });

  test('overview: one row per registry tenant', async () => {
    await repo.upsertMcAwait(T, { seriesId: S1, refs: [REF(S1, 'f1')] }, { now: 'x' });
    const res = await get('/platform/medicoach/overview');
    assert.equal(res.status, 200);
    const { tenants } = (await res.json()) as { tenants: Array<{ tenant: string }> };
    const byTenant = Object.fromEntries(tenants.map((t) => [t.tenant, t]));
    assert.deepEqual(byTenant[T], {
      tenant: T,
      name: 'Dolphins',
      syncEnabled: true,
      dryRun: true,
      healthStatus: 'dry-run',
      awaitingTotal: 1,
      lastReconcileAt: null,
    });
    assert.deepEqual(byTenant[OTHER], {
      tenant: OTHER,
      name: 'Titans',
      syncEnabled: false,
      dryRun: true,
      healthStatus: 'dry-run',
      awaitingTotal: 0,
      lastReconcileAt: null,
    });
  });

  test('reconcile: runs now and answers the refreshed connection view', async () => {
    setLiveEnv();
    unmappedRefs = new Set([REF(S1, 'f2')]);
    const res = await app.request(`/platform/tenants/${T}/medicoach/reconcile`, {
      method: 'POST',
      headers: { 'x-dev-auth': OPERATOR },
    });
    assert.equal(res.status, 200);
    const body = await view(res);
    assert.equal(checkCalls.length, 1);
    assert.equal(body.mcReachable, true);
    assert.ok(body.lastReconcileAt);
    assert.equal(body.awaitingTotal, 1);
    assert.deepEqual(
      body.awaiting.map((a) => [a.seriesId, a.count]),
      [[S1, 1]],
    );
  });

  test('reconcile: a dry run answers 200 with mcReachable false', async () => {
    const res = await app.request(`/platform/tenants/${T}/medicoach/reconcile`, {
      method: 'POST',
      headers: { 'x-dev-auth': OPERATOR },
    });
    assert.equal(res.status, 200);
    const body = await view(res);
    assert.equal(body.mcReachable, false);
    assert.equal(body.dryRun, true);
    assert.equal(checkCalls.length, 0);
  });

  test('operators only: tenant admins get 403, no auth 401', async () => {
    const routes: Array<[string, string]> = [
      ['GET', `/platform/tenants/${T}/medicoach/connection`],
      ['GET', '/platform/medicoach/overview'],
      ['POST', `/platform/tenants/${T}/medicoach/reconcile`],
    ];
    for (const [method, path] of routes) {
      const asAdmin = await app.request(path, { method, headers: headers(ADMIN) });
      assert.equal(asAdmin.status, 403, `${method} ${path} as admin`);
      const anon = await app.request(path, { method });
      assert.equal(anon.status, 401, `${method} ${path} without auth`);
    }
    assert.equal(checkCalls.length, 0, 'a refused reconcile never reaches medicoach');
    assert.equal(await repo.getMcReconcile(T), null);
  });
});

// ── Hardening: failure modes and edge cases ──

/** A check-refs Response built in-process (no stub server round trip). */
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A `fetch` that answers check-refs from `answer(refsAsked)` and records each request's refs. */
function fakeCheckRefs(answer: (refs: string[]) => Response | Promise<Response>) {
  const calls: string[][] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    const refs = (JSON.parse(String(init?.body)) as { refs: string[] }).refs;
    calls.push(refs);
    return answer(refs);
  }) as typeof fetch;
  return { fetch: f, calls };
}

/** Answer `unmapped` for the asked refs in `unmapped`, `mapped` for the rest. */
const answerUnmapped = (unmapped: string[]) => (refs: string[]) =>
  jsonRes({
    mapped: refs.filter((r) => !unmapped.includes(r)),
    unmapped: refs.filter((r) => unmapped.includes(r)),
  });

/** A promise plus its resolver, to hold one side of an interleaving. */
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

describe('hardening — check-refs response pathologies', () => {
  test('a 200 whose body is not JSON stamps unreachable and leaves the rows untouched', async () => {
    const now = '2026-10-07T10:00:00.000Z';
    await repo.upsertMcAwait(T, { seriesId: S1, refs: [REF(S1, 'f1')] }, { now });
    const { fetch: f } = fakeCheckRefs(
      () => new Response('<html>502 Bad Gateway</html>', { status: 200 }),
    );
    const stamp = await reconcileNow({ fetch: f });
    assert.equal(stamp.mcReachable, false);
    assert.match(stamp.reason ?? '', /not JSON/);
    assert.deepEqual(await repo.getMcReconcile(T), stamp, 'the failure is stamped');
    const row = (await awaitRow(S1))!;
    assert.deepEqual(row.refs, [REF(S1, 'f1')]);
    assert.equal(row.lastSeen, now, 'not touched');
  });

  test('a 200 whose JSON violates the contract stamps unreachable, rows untouched', async () => {
    const now = '2026-10-07T10:00:00.000Z';
    await repo.upsertMcAwait(T, { seriesId: S1, refs: [REF(S1, 'f1')] }, { now });
    for (const body of [
      { mapped: 'x' },
      { mapped: [] }, // `unmapped` missing
      { mapped: [], unmapped: [1] },
      { mapped: [], unmapped: [''] }, // refs are non-empty strings
      null,
      [],
    ]) {
      const { fetch: f } = fakeCheckRefs(() => jsonRes(body));
      const stamp = await reconcileNow({ fetch: f });
      assert.equal(stamp.mcReachable, false, JSON.stringify(body));
      assert.match(stamp.reason ?? '', /contract/, JSON.stringify(body));
      assert.equal(stamp.checkedRefs, undefined);
    }
    const row = (await awaitRow(S1))!;
    assert.deepEqual(row.refs, [REF(S1, 'f1')]);
    assert.equal(row.lastSeen, now);
  });

  test('refs smart club never asked about are ignored — no MCAWAIT row is invented', async () => {
    const foreign = [
      REF('s-never-asked', 'z1'), // a series that does not exist
      REF(S2, 'f1'), // the draft: exists but was not walked, so not asked
      `smartclub:${OTHER}:fixture:${S1}:f1`, // another tenant's ref
      'garbage',
    ];
    const { fetch: f, calls } = fakeCheckRefs((refs) =>
      jsonRes({
        mapped: [...refs.filter((r) => r !== REF(S1, 'f2')), 'smartclub:mapped:but-unknown'],
        unmapped: [...refs.filter((r) => r === REF(S1, 'f2')), ...foreign],
      }),
    );
    const stamp = await reconcileNow({ fetch: f });
    assert.equal(calls.length, 1);
    assert.equal(stamp.mcReachable, true);
    assert.equal(stamp.checkedRefs, 2);
    assert.equal(stamp.unmappedTotal, 1, 'only the asked ref counts');
    const rows = await repo.listMcAwait(T);
    assert.deepEqual(
      rows.map((r) => [r.seriesId, r.refs]),
      [[S1, [REF(S1, 'f2')]]],
    );
    assert.deepEqual(await repo.listMcAwait(OTHER), [], 'nothing leaks to another tenant');
  });

  test('a hanging fetch is cut off by the request timeout: unreachable, not hung', async () => {
    // AbortSignal.timeout is time: replace it with a signal that fires in 20ms, and record the
    // timeout the code asked for. The fetch itself hangs until its signal aborts.
    let askedMs: number | undefined;
    mock.method(AbortSignal, 'timeout', (ms: number) => {
      askedMs = ms;
      const c = new AbortController();
      setTimeout(
        () => c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
        20,
      );
      return c.signal;
    });
    try {
      const hanging = ((_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          assert.ok(signal, 'the request carries an abort signal');
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })) as typeof fetch;
      const started = Date.now();
      const stamp = await reconcileNow({ fetch: hanging });
      assert.ok(Date.now() - started < 2000, 'returned promptly once the signal fired');
      assert.equal(askedMs, 10_000, 'the real request is capped at 10s');
      assert.equal(stamp.mcReachable, false);
      assert.match(stamp.reason ?? '', /unreachable: TimeoutError/);
    } finally {
      mock.restoreAll();
    }
  });

  test('a fetch rejecting with AbortError also stamps unreachable with the error name', async () => {
    const aborting = (async () => {
      throw new DOMException('This operation was aborted', 'AbortError');
    }) as typeof fetch;
    const stamp = await reconcileNow({ fetch: aborting });
    assert.equal(stamp.mcReachable, false);
    assert.match(stamp.reason ?? '', /unreachable: AbortError/);
  });

  test('a failure on the second chunk aborts the whole run — no partial rewrite', async () => {
    const many = Array.from({ length: 501 }, (_, i) => fx(`g${i}`));
    await repo.putSeries(T, series('s-big', many, { name: 'Big' }));
    const now = '2026-10-07T10:00:00.000Z';
    await repo.upsertMcAwait(T, { seriesId: S1, refs: [REF(S1, 'f1')] }, { now });
    let n = 0;
    const { fetch: f } = fakeCheckRefs((refs) =>
      ++n === 1 ? answerUnmapped(refs)(refs) : jsonRes({ error: 'boom' }, 503),
    );
    const stamp = await reconcileNow({ fetch: f });
    assert.equal(stamp.mcReachable, false);
    assert.match(stamp.reason ?? '', /HTTP 503/);
    assert.deepEqual(
      (await repo.listMcAwait(T)).map((r) => [r.seriesId, r.refs, r.lastSeen]),
      [[S1, [REF(S1, 'f1')], now]],
      'the first chunk answer is not half-applied',
    );
  });
});

describe('hardening — series lifecycle transitions', () => {
  const getConnection = async (tenant = T) =>
    (await (
      await app.request(`/platform/tenants/${tenant}/medicoach/connection`, {
        headers: { 'x-dev-auth': OPERATOR },
      })
    ).json()) as MedicoachConnectionView;

  test('a series back to draft keeps its row, and the connection view still reports it', async () => {
    const now = '2026-10-07T10:00:00.000Z';
    await repo.upsertMcAwait(T, { seriesId: S1, refs: [REF(S1, 'f1'), REF(S1, 'f2')] }, { now });
    const s1 = (await repo.getSeries(T, S1))!;
    await repo.putSeries(T, { ...s1, released: false, releasedAt: null } as Series);

    const stamp = await reconcileNow();
    assert.equal(stamp.mcReachable, true);
    assert.equal(stamp.checkedRefs, 0, 'nothing released to walk');
    assert.deepEqual(checkCalls[0].body.refs, [], 'still probed once (reachability)');
    const row = (await awaitRow(S1))!;
    assert.deepEqual(row.refs, [REF(S1, 'f1'), REF(S1, 'f2')]);
    assert.equal(row.lastSeen, now, 'left exactly as the write path recorded it');

    const view = await getConnection();
    assert.equal(view.awaitingTotal, 2);
    assert.deepEqual(
      view.awaiting.map((a) => [a.seriesId, a.count]),
      [[S1, 2]],
    );
  });

  test('a series deleted entirely loses its row', async () => {
    await repo.upsertMcAwait(T, { seriesId: S1, refs: [REF(S1, 'f1')] }, { now: 'x' });
    await repo.upsertMcAwait(T, { seriesId: S2, refs: [REF(S2, 'f1')] }, { now: 'x' });
    await repo.deleteSeries(T, S1);
    await repo.deleteSeries(T, S2); // a deleted draft goes too
    await reconcileNow();
    assert.deepEqual(await repo.listMcAwait(T), []);
    assert.equal((await getConnection()).awaitingTotal, 0);
  });

  test('a released series whose league becomes unmapped is left untouched (not walked)', async () => {
    unmappedRefs = new Set([REF(S1, 'f1')]);
    const first = await reconcileNow({ now: () => new Date('2026-10-07T03:00:00.000Z') });
    assert.equal(first.unmappedTotal, 1);
    const before = (await awaitRow(S1))!;

    // The league drops out of the sync (an excluded `demo`/`seed-*` league).
    const s1 = (await repo.getSeries(T, S1))!;
    await repo.putSeries(T, { ...s1, leagueKey: 'demo' } as Series);
    unmappedRefs = new Set(); // medicoach would now call everything mapped — never asked
    const second = await reconcileNow({ now: () => new Date('2026-10-08T03:00:00.000Z') });
    assert.equal(second.mcReachable, true);
    assert.equal(second.checkedRefs, 0);
    assert.deepEqual(checkCalls[1].body.refs, []);
    assert.deepEqual(await awaitRow(S1), before, 'row identical, lastSeen included');
  });
});

describe('hardening — MCAWAIT semantics', () => {
  test('the write path unions refs across repeated enqueues, keeps firstSeen, count = refs.length', async () => {
    const s = { id: S1, name: 'Premier T20 g1', leagueKey: 'premier' };
    const [a, b, c] = [REF(S1, 'a'), REF(S1, 'b'), REF(S1, 'c')];
    const steps: Array<[string[], string, string[]]> = [
      [[a, b], '2026-10-07T10:00:00.000Z', [a, b]],
      [[b, c], '2026-10-07T11:00:00.000Z', [a, b, c]],
      [[a], '2026-10-07T12:00:00.000Z', [a, b, c]],
      [[c, c], '2026-10-07T13:00:00.000Z', [a, b, c]],
    ];
    for (const [refs, at, expected] of steps) {
      await schedule.recordAwaitingCarry(repo, T, s, refs, at);
      const row = (await awaitRow(S1))!;
      assert.deepEqual([...row.refs].sort(), [...expected].sort(), at);
      assert.equal(row.count, row.refs.length, `count = refs.length at ${at}`);
      assert.equal(row.firstSeen, '2026-10-07T10:00:00.000Z', 'firstSeen kept');
      assert.equal(row.lastSeen, at);
      assert.equal(row.seriesName, 'Premier T20 g1');
    }
    assert.equal((await repo.listMcAwait(T)).length, 1, 'one row per series');
  });

  test('an empty enqueue writes nothing', async () => {
    await schedule.recordAwaitingCarry(repo, T, { id: S1, name: 'x' }, [], 'now');
    assert.deepEqual(await repo.listMcAwait(T), []);
  });

  test('reconcile replace shrinks the row as refs become mapped (3 → 2), firstSeen kept', async () => {
    const s1 = (await repo.getSeries(T, S1))!;
    await repo.putSeries(T, {
      ...s1,
      fixtures: [...(s1.fixtures as unknown[]), fx('f3', { home: 'a', away: 'd' })],
    } as Series);
    const [r1, r2, r3] = [REF(S1, 'f1'), REF(S1, 'f2'), REF(S1, 'f3')];

    unmappedRefs = new Set([r1, r2, r3]);
    await reconcileNow({ now: () => new Date('2026-10-06T03:00:00.000Z') });
    const full = (await awaitRow(S1))!;
    assert.deepEqual([...full.refs].sort(), [r1, r2, r3]);
    assert.equal(full.count, 3);

    unmappedRefs = new Set([r2, r3]); // medicoach carried f1
    const stamp = await reconcileNow({ now: () => new Date('2026-10-07T03:00:00.000Z') });
    const partial = (await awaitRow(S1))!;
    assert.deepEqual([...partial.refs].sort(), [r2, r3]);
    assert.equal(partial.count, partial.refs.length);
    assert.equal(partial.count, 2);
    assert.equal(partial.firstSeen, '2026-10-06T03:00:00.000Z');
    assert.equal(partial.lastSeen, '2026-10-07T03:00:00.000Z');
    assert.equal(stamp.unmappedTotal, 2);
  });
});

describe('hardening — overlapping reconciliations (per-tenant lease)', () => {
  const at = (iso: string) => () => new Date(iso);
  /** True while some run holds an unexpired lease at `now` (probes by trying to take it). */
  const leaseHeldAt = async (now: Date) => {
    const probe = await repo.acquireMcReconcileLease(T, {
      now,
      leaseMs: reconcile.RECONCILE_LEASE_MS,
    });
    if (probe) await repo.releaseMcReconcileLease(T, probe);
    return probe === null;
  };

  test('a second run while the first holds the lease is busy and writes nothing; the cron skips', async () => {
    const aAsked = gate();
    const releaseA = gate();
    // A: medicoach says f1 is unmapped, but its answer is held until we release it.
    const fA = fakeCheckRefs(async (refs) => {
      aAsked.open();
      await releaseA.p;
      return answerUnmapped([REF(S1, 'f1')])(refs);
    });
    // Wall clock throughout: the console route below cannot take an injected `now`.
    const runA = reconcileNow({ fetch: fA.fetch });
    await aAsked.p;

    // B: started while A holds the lease. It must not ask medicoach or touch rows/stamp.
    const fB = fakeCheckRefs(answerUnmapped([]));
    const writes: string[] = [];
    const spyRepo = {
      ...repo,
      upsertMcAwait: async (...a: Parameters<typeof repo.upsertMcAwait>) => {
        writes.push('upsertMcAwait');
        return repo.upsertMcAwait(...a);
      },
      deleteMcAwait: async (...a: Parameters<typeof repo.deleteMcAwait>) => {
        writes.push('deleteMcAwait');
        return repo.deleteMcAwait(...a);
      },
      putMcReconcile: async (...a: Parameters<typeof repo.putMcReconcile>) => {
        writes.push('putMcReconcile');
        return repo.putMcReconcile(...a);
      },
    } as typeof repo;
    const b = await reconcileAttempt({ repo: spyRepo, fetch: fB.fetch });
    assert.deepEqual(b, { busy: true });
    assert.equal(fB.calls.length, 0, 'a busy run never asks medicoach');
    assert.deepEqual(writes, [], 'a busy run writes no rows and no stamp');
    assert.equal(await repo.getMcReconcile(T), null, 'no stamp yet: A has not finished');

    // The cron, due (no stamp yet), treats busy as not due.
    const cron = await reconcile.reconcileIfDue(T, {
      repo,
      url: stubUrl,
      secret: SECRET,
      log: () => {},
      fetch: fB.fetch,
    });
    assert.equal(cron, null, 'cron: busy reads as not due');
    assert.equal(fB.calls.length, 0);

    // The console route answers 409 with a plain-English reason (ApiError toast).
    setLiveEnv();
    const res = await app.request(`/platform/tenants/${T}/medicoach/reconcile`, {
      method: 'POST',
      headers: { 'x-dev-auth': OPERATOR },
    });
    assert.equal(res.status, 409);
    const err = (await res.json()) as { error: string; code: string };
    assert.equal(err.code, 'reconcile_busy');
    assert.equal(
      err.error,
      'A reconciliation is already running for this client — try again in a moment.',
    );
    assert.equal(checkCalls.length, 0, 'the refused route never reached medicoach');

    releaseA.open();
    const stampA = await runA;
    const rows = await repo.listMcAwait(T);
    assert.deepEqual(
      rows.map((r) => [r.seriesId, r.refs, r.count]),
      [[S1, [REF(S1, 'f1')], 1]],
      "only A's answer applied",
    );
    assert.deepEqual(await repo.getMcReconcile(T), stampA, 'the stamp is whole, from A');
    assert.equal(stampA.unmappedTotal, rows.reduce((n, r) => n + r.count, 0));
  });

  test('after the first run completes the lease is released and a rerun succeeds', async () => {
    const first = await reconcileNow({
      fetch: fakeCheckRefs(answerUnmapped([REF(S1, 'f1')])).fetch,
      now: at('2026-10-08T03:00:00.000Z'),
    });
    assert.equal(first.unmappedTotal, 1);
    assert.equal(await leaseHeldAt(new Date('2026-10-08T03:00:01.000Z')), false, 'released');

    // Immediately after (well inside the 5-minute lease), the rerun takes the lease.
    const second = await reconcileNow({
      fetch: fakeCheckRefs(answerUnmapped([])).fetch,
      now: at('2026-10-08T03:00:01.000Z'),
    });
    assert.equal(second.unmappedTotal, 0);
    assert.deepEqual(await repo.listMcAwait(T), [], "the rerun's answer applied");
    assert.deepEqual(await repo.getMcReconcile(T), second);

    // A run that throws (a repo failure) still releases its lease.
    const failing = { ...repo, listSeries: async () => Promise.reject(new Error('ddb down')) };
    await assert.rejects(
      reconcileAttempt({ repo: failing as typeof repo, now: at('2026-10-08T03:00:02.000Z') }),
      /ddb down/,
    );
    assert.equal(await leaseHeldAt(new Date('2026-10-08T03:00:03.000Z')), false);
  });

  test('an expired lease (a crashed holder) is taken over by a new run', async () => {
    const T0 = Date.parse('2026-10-08T03:00:00.000Z');
    const L = reconcile.RECONCILE_LEASE_MS;
    assert.equal(L, 5 * 60 * 1000);
    // A holder that crashed without releasing: its lease is never deleted.
    const crashed = await repo.acquireMcReconcileLease(T, { now: new Date(T0), leaseMs: L });
    assert.ok(crashed);
    assert.equal(crashed.expiresAt, Math.ceil((T0 + L) / 1000));

    // Inside the lease: busy.
    const early = await reconcileAttempt({ now: () => new Date(T0 + L - 1000) });
    assert.deepEqual(early, { busy: true });
    assert.equal(checkCalls.length, 0);

    // Past expiresAt: the new run takes it and reconciles.
    unmappedRefs = new Set([REF(S1, 'f2')]);
    const late = await reconcileNow({ now: () => new Date(T0 + L + 1000) });
    assert.equal(late.mcReachable, true);
    assert.equal(late.unmappedTotal, 1);
    assert.equal(checkCalls.length, 1);
    assert.deepEqual((await awaitRow(S1))?.refs, [REF(S1, 'f2')]);
  });

  test("a stale holder's release never deletes the lease a new run re-acquired", async () => {
    const T0 = Date.parse('2026-10-08T03:00:00.000Z');
    const L = reconcile.RECONCILE_LEASE_MS;
    const stale = await repo.acquireMcReconcileLease(T, { now: new Date(T0), leaseMs: L });
    assert.ok(stale);

    // A new run takes over the expired lease and is held mid-flight.
    const asked = gate();
    const release = gate();
    const f = fakeCheckRefs(async (refs) => {
      asked.open();
      await release.p;
      return answerUnmapped([])(refs);
    });
    const after = T0 + L + 1000;
    const run2 = reconcileNow({ fetch: f.fetch, now: () => new Date(after) });
    await asked.p;

    // The stale holder (which outlived its lease) now releases: refused, nothing deleted.
    assert.equal(await repo.releaseMcReconcileLease(T, stale), false);
    assert.equal(await leaseHeldAt(new Date(after + 1000)), true, "the new run's lease stands");
    assert.deepEqual(
      await reconcileAttempt({ now: () => new Date(after + 2000) }),
      { busy: true },
      'a third run is still refused',
    );

    release.open();
    await run2;
    assert.equal(await leaseHeldAt(new Date(after + 3000)), false, 'released by its own holder');
  });

  test("a lease's identity is its random token, not its acquiredAt", async () => {
    const T0 = Date.parse('2026-10-08T03:00:00.000Z');
    const L = reconcile.RECONCILE_LEASE_MS;
    const held = await repo.acquireMcReconcileLease(T, { now: new Date(T0), leaseMs: L });
    assert.ok(held);
    assert.match(held.token, /^[0-9a-f-]{36}$/);
    // Same acquiredAt, different token (two holders in the same millisecond): no say over it.
    const twin = { ...held, token: '00000000-0000-4000-8000-000000000000' };
    assert.equal(
      await repo.renewMcReconcileLease(T, twin, { now: new Date(T0 + 1000), leaseMs: L }),
      false,
    );
    assert.equal(await repo.releaseMcReconcileLease(T, twin), false);
    assert.equal(await leaseHeldAt(new Date(T0 + 2000)), true, 'the real holder keeps it');
    assert.equal(
      await repo.renewMcReconcileLease(T, held, { now: new Date(T0 + 3000), leaseMs: L }),
      true,
    );
    assert.equal(await repo.releaseMcReconcileLease(T, held), true);
    const next = await repo.acquireMcReconcileLease(T, { now: new Date(T0), leaseMs: L });
    assert.ok(next);
    assert.notEqual(next.token, held.token, 'every acquire mints a fresh token');
    await repo.releaseMcReconcileLease(T, next);
  });

  /** A second released series big enough for two check-refs chunks (500 + 3 refs). */
  const seedTwoChunks = () =>
    repo.putSeries(
      T,
      series(
        's-big',
        Array.from({ length: 501 }, (_, i) =>
          fx(`g${i}`, { date: '2026-10-04', home: 'a', away: 'b' }),
        ),
      ),
    );

  test('a run longer than the lease renews it per chunk and keeps exclusivity', async () => {
    await seedTwoChunks();
    const T0 = Date.parse('2026-10-08T03:00:00.000Z');
    const MIN = 60_000;
    let clock = T0;
    const competitor: unknown[] = [];
    const f = fakeCheckRefs(async (refs) => {
      if (f.calls.length === 1) clock = T0 + 4 * MIN; // chunk 1 is slow: 4 minutes
      else {
        // Chunk 2 runs at +8 min — past the ORIGINAL expiry (+5), inside the renewed one (+9).
        clock = T0 + 8 * MIN;
        competitor.push(await reconcileAttempt({ now: () => new Date(T0 + 8 * MIN) }));
      }
      return answerUnmapped([REF(S1, 'f1')])(refs);
    });
    const stamp = await reconcileNow({ fetch: f.fetch, now: () => new Date(clock) });
    assert.deepEqual(
      f.calls.map((c) => c.length),
      [500, 3],
    );
    assert.deepEqual(competitor, [{ busy: true }], 'the renewed lease still excluded a new run');
    assert.equal(checkCalls.length, 0, 'the competitor never asked medicoach');
    assert.equal(stamp.mcReachable, true);
    assert.equal(stamp.lastReconcileAt, new Date(T0).toISOString(), 'stamped at the run start');
    assert.deepEqual(await repo.getMcReconcile(T), stamp);
    assert.deepEqual((await awaitRow(S1))?.refs, [REF(S1, 'f1')]);
    assert.equal(await leaseHeldAt(new Date(T0 + 8 * MIN + 1000)), false, 'released at the end');
  });

  test('a run that loses its lease mid-way aborts without writing rows or a stamp', async () => {
    await seedTwoChunks();
    const T0 = Date.parse('2026-10-08T03:00:00.000Z');
    const L = reconcile.RECONCILE_LEASE_MS;
    const seededAt = new Date(T0 - 3600_000).toISOString();
    await repo.upsertMcAwait(T, { seriesId: S1, refs: [REF(S1, 'f2')] }, { now: seededAt });
    let clock = T0;
    let takeover: Awaited<ReturnType<typeof repo.acquireMcReconcileLease>> = null;
    const f = fakeCheckRefs(async (refs) => {
      // Chunk 1 outlives the lease, and another run takes the expired lease meanwhile.
      clock = T0 + L + 1000;
      takeover = await repo.acquireMcReconcileLease(T, { now: new Date(clock), leaseMs: L });
      return answerUnmapped([])(refs);
    });
    const writes: string[] = [];
    const spyRepo = {
      ...repo,
      upsertMcAwait: async (...a: Parameters<typeof repo.upsertMcAwait>) => {
        writes.push('upsertMcAwait');
        return repo.upsertMcAwait(...a);
      },
      deleteMcAwait: async (...a: Parameters<typeof repo.deleteMcAwait>) => {
        writes.push('deleteMcAwait');
        return repo.deleteMcAwait(...a);
      },
      putMcReconcile: async (...a: Parameters<typeof repo.putMcReconcile>) => {
        writes.push('putMcReconcile');
        return repo.putMcReconcile(...a);
      },
    } as typeof repo;

    const result = await reconcileAttempt({
      repo: spyRepo,
      fetch: f.fetch,
      now: () => new Date(clock),
    });
    assert.ok(takeover, 'the other run took the expired lease');
    assert.deepEqual(result, { busy: true, leaseLost: true });
    assert.ok(reconcile.isReconcileBusy(result));
    assert.equal(f.calls.length, 1, 'no further chunk after the lease was lost');
    assert.deepEqual(writes, [], 'no row and no stamp written');
    assert.equal(await repo.getMcReconcile(T), null);
    const row = await awaitRow(S1);
    assert.deepEqual(row?.refs, [REF(S1, 'f2')], 'rows untouched');
    assert.equal(row?.lastSeen, seededAt);
    // The lost run's release did not delete the new holder's lease.
    assert.equal(await leaseHeldAt(new Date(clock + 1000)), true);

    // The cron reads a lost lease as not due, like any busy run.
    assert.equal(await repo.releaseMcReconcileLease(T, takeover!), true);
    let cronClock = T0;
    const g = fakeCheckRefs(async (refs) => {
      cronClock = T0 + L + 1000;
      await repo.acquireMcReconcileLease(T, { now: new Date(cronClock), leaseMs: L });
      return answerUnmapped([])(refs);
    });
    const cron = await reconcile.reconcileIfDue(T, {
      repo,
      url: stubUrl,
      secret: SECRET,
      log: () => {},
      fetch: g.fetch,
      now: () => new Date(cronClock),
    });
    assert.equal(cron, null, 'cron: a lost lease reads as not due');
    assert.equal(await repo.getMcReconcile(T), null);
  });

  test('sequential runs on the wall clock stamp non-decreasing lastReconcileAt', async () => {
    const stamps: string[] = [];
    for (let i = 0; i < 4; i++) {
      stamps.push((await reconcileNow()).lastReconcileAt);
      assert.equal((await repo.getMcReconcile(T))?.lastReconcileAt, stamps[i], 'latest stamp kept');
    }
    for (let i = 1; i < stamps.length; i++)
      assert.ok(stamps[i] >= stamps[i - 1], `stamp ${i} not before stamp ${i - 1}`);
  });
});

describe('hardening — the 24h cron gate', () => {
  const T0 = Date.parse('2026-10-08T03:00:00.000Z');
  const deps = (at: number) => ({
    repo,
    url: stubUrl,
    secret: SECRET,
    log: () => {},
    now: () => new Date(at),
  });

  test('exactly RECONCILE_INTERVAL_MS after the last stamp runs; 1ms under is skipped', async () => {
    await repo.putMcReconcile(T, {
      lastReconcileAt: new Date(T0).toISOString(),
      mcReachable: true,
      checkedRefs: 2,
      unmappedTotal: 0,
    });
    const I = reconcile.RECONCILE_INTERVAL_MS;
    assert.equal(I, 24 * 3600 * 1000);
    assert.equal(await reconcile.reconcileIfDue(T, deps(T0 + I - 1)), null, '1ms under: skipped');
    assert.equal(checkCalls.length, 0);
    const ran = await reconcile.reconcileIfDue(T, deps(T0 + I));
    assert.ok(ran, 'exactly at the interval: runs');
    assert.equal(ran.lastReconcileAt, new Date(T0 + I).toISOString());
    assert.equal(checkCalls.length, 1);
  });

  test('a successful stamp still waits the full 24h (not the 1h retry)', async () => {
    await repo.putMcReconcile(T, {
      lastReconcileAt: new Date(T0).toISOString(),
      mcReachable: true,
      checkedRefs: 2,
      unmappedTotal: 0,
    });
    const R = reconcile.RECONCILE_RETRY_MS;
    assert.equal(await reconcile.reconcileIfDue(T, deps(T0 + R)), null, '1h: skipped');
    assert.equal(
      await reconcile.reconcileIfDue(T, deps(T0 + reconcile.RECONCILE_INTERVAL_MS - 1)),
      null,
    );
    assert.equal(checkCalls.length, 0);
  });

  test('a failed (mcReachable:false) stamp retries after 1h, not 24h; 59min is skipped', async () => {
    await repo.putMcReconcile(T, {
      lastReconcileAt: new Date(T0).toISOString(),
      mcReachable: false,
      reason: 'medicoach has no check-refs endpoint yet (HTTP 404)',
    });
    const R = reconcile.RECONCILE_RETRY_MS;
    assert.equal(R, 3600 * 1000);
    assert.equal(await reconcile.reconcileIfDue(T, deps(T0 + 59 * 60_000)), null, '59min: skipped');
    assert.equal(checkCalls.length, 0);
    const ran = await reconcile.reconcileIfDue(T, deps(T0 + R));
    assert.ok(ran, 'exactly 1h after the failure: retried');
    assert.equal(ran.mcReachable, true);
    assert.equal(ran.lastReconcileAt, new Date(T0 + R).toISOString());
    assert.equal(checkCalls.length, 1);
    // Success now: the next run waits the full day again.
    assert.equal(await reconcile.reconcileIfDue(T, deps(T0 + 2 * R)), null);
    assert.equal(checkCalls.length, 1);
  });

  test('a dry-run stamp (also mcReachable:false) retries hourly, still making no request', async () => {
    const dry = (at: number) => ({ ...deps(at), url: '' });
    assert.ok(await reconcile.reconcileIfDue(T, dry(T0)), 'absent: runs (dry)');
    assert.equal(await reconcile.reconcileIfDue(T, dry(T0 + 59 * 60_000)), null);
    const again = await reconcile.reconcileIfDue(T, dry(T0 + reconcile.RECONCILE_RETRY_MS));
    assert.ok(again);
    assert.match(again.reason ?? '', /dry run/);
    assert.equal(checkCalls.length, 0);
  });

  test('the console button bypasses the gate after a failure', async () => {
    await repo.putMcReconcile(T, {
      lastReconcileAt: new Date().toISOString(),
      mcReachable: false,
      reason: 'medicoach has no check-refs endpoint yet (HTTP 404)',
    });
    assert.equal(await reconcile.reconcileIfDue(T, deps(Date.now())), null);
    assert.equal(checkCalls.length, 0);

    // The bypass: the console button reconciles regardless of the gate.
    setLiveEnv();
    const res = await app.request(`/platform/tenants/${T}/medicoach/reconcile`, {
      method: 'POST',
      headers: { 'x-dev-auth': OPERATOR },
    });
    assert.equal(res.status, 200);
    assert.equal(checkCalls.length, 1);
    assert.equal(((await res.json()) as MedicoachConnectionView).mcReachable, true);
  });

  test('an unparseable lastReconcileAt counts as never reconciled (runs)', async () => {
    await repo.putMcReconcile(T, { lastReconcileAt: 'not-a-date', mcReachable: true });
    assert.ok(await reconcile.reconcileIfDue(T, deps(T0)));
    assert.equal(checkCalls.length, 1);
  });
});

describe('hardening — connection and overview edges', () => {
  const get = (path: string) => app.request(path, { headers: { 'x-dev-auth': OPERATOR } });
  const overview = async () =>
    Object.fromEntries(
      (
        (await (await get('/platform/medicoach/overview')).json()) as {
          tenants: Array<Record<string, unknown> & { tenant: string }>;
        }
      ).tenants.map((t) => [t.tenant, t]),
    );

  test('sync switched off with stale MCAWAIT rows: still reported, the same in view and overview', async () => {
    setLiveEnv();
    // Titans has no medicoachSync; a row survives from when it had.
    await repo.putSeries(OTHER, series(S1, [fx('f1')]));
    await repo.upsertMcAwait(
      OTHER,
      { seriesId: S1, refs: [REF(S1, 'f1'), REF(S1, 'f2')] },
      { now: '2026-10-01T00:00:00.000Z' },
    );
    const conn = (await (
      await get(`/platform/tenants/${OTHER}/medicoach/connection`)
    ).json()) as MedicoachConnectionView;
    assert.equal(conn.syncEnabled, false);
    assert.equal(conn.stage, 'not_connected');
    assert.equal(conn.awaitingTotal, 2);
    assert.equal(conn.awaiting.length, 1);
    assert.equal((await overview())[OTHER].awaitingTotal, conn.awaitingTotal);

    // A reconcile walks nothing for a sync-off tenant (no series is mapped), so the row of an
    // existing series stays — it is only reported, never cleared, while the sync is off.
    const res = await app.request(`/platform/tenants/${OTHER}/medicoach/reconcile`, {
      method: 'POST',
      headers: { 'x-dev-auth': OPERATOR },
    });
    const after = (await res.json()) as MedicoachConnectionView;
    assert.equal(after.mcReachable, true);
    assert.equal(after.awaitingTotal, 2);
  });

  test('overview across a mix of tenants keeps each row to its own tenant', async () => {
    setLiveEnv();
    const LIONS = 'lions';
    await repo.putTenantConfig(tenantConfig(LIONS, 'Lions', { medicoachSync: true }));
    // Dolphins: healthy, two series awaiting carry.
    await repo.putSyncHealth(T, { lastSuccessAt: '2026-10-08T08:00:00.000Z' });
    await repo.putMcReconcile(T, {
      lastReconcileAt: '2026-10-08T03:00:00.000Z',
      mcReachable: true,
      checkedRefs: 3,
      unmappedTotal: 3,
    });
    await repo.upsertMcAwait(T, { seriesId: S1, refs: [REF(S1, 'f1')] }, { now: 'x' });
    await repo.upsertMcAwait(
      T,
      { seriesId: S2, refs: [REF(S2, 'f1'), REF(S2, 'f2')] },
      { now: 'x' },
    );
    // Lions: sync on, its last reconcile could not reach medicoach, sync has only failed.
    await repo.putMcReconcile(LIONS, {
      lastReconcileAt: '2026-10-08T02:00:00.000Z',
      mcReachable: false,
      reason: 'dry run (MedicoachSyncSecret unset) — no request made',
    });
    await repo.putSyncHealth(LIONS, {
      lastErrorAt: '2026-10-08T07:00:00.000Z',
      lastError: 'medicoach unreachable: TypeError',
    });
    // Titans: never synced, sync off.

    const rows = await overview();
    assert.deepEqual(rows[T], {
      tenant: T,
      name: 'Dolphins',
      syncEnabled: true,
      dryRun: false,
      healthStatus: 'ok',
      awaitingTotal: 3,
      lastReconcileAt: '2026-10-08T03:00:00.000Z',
    });
    assert.deepEqual(rows[LIONS], {
      tenant: LIONS,
      name: 'Lions',
      syncEnabled: true,
      dryRun: false,
      healthStatus: 'failing',
      awaitingTotal: 0,
      lastReconcileAt: '2026-10-08T02:00:00.000Z',
    });
    assert.deepEqual(rows[OTHER], {
      tenant: OTHER,
      name: 'Titans',
      syncEnabled: false,
      dryRun: false,
      healthStatus: 'never',
      awaitingTotal: 0,
      lastReconcileAt: null,
    });
  });

  test('SYNCHEALTH with lastErrorAt == lastSuccessAt reads ok (deterministic tie)', async () => {
    setLiveEnv();
    const at = '2026-10-08T08:00:00.000Z';
    await repo.putSyncHealth(T, {
      lastAttemptAt: at,
      lastSuccessAt: at,
      lastErrorAt: at,
      lastError: 'medicoach answered HTTP 502',
    });
    for (let i = 0; i < 3; i++) {
      const conn = (await (
        await get(`/platform/tenants/${T}/medicoach/connection`)
      ).json()) as MedicoachConnectionView;
      assert.equal(conn.health.status, 'ok', 'a failure must be strictly newer to read failing');
      assert.equal(conn.stage, 'live');
      assert.equal(conn.health.lastError, 'medicoach answered HTTP 502', 'still surfaced');
    }
    assert.equal((await overview())[T].healthStatus, 'ok');
  });
});

describe('hardening — recordAwaitingCarry is best-effort', () => {
  const throwingRepo = () =>
    ({
      ...repo,
      upsertMcAwait: async () => {
        throw new Error('ProvisionedThroughputExceededException');
      },
    }) as typeof repo;

  test('a throwing upsert is logged, never thrown', async () => {
    const errors = mock.method(console, 'error', () => {});
    try {
      await schedule.recordAwaitingCarry(
        throwingRepo(),
        T,
        { id: S1, name: 'x' },
        [REF(S1, 'f1')],
        '2026-10-08T00:00:00.000Z',
      );
      assert.equal(errors.mock.callCount(), 1);
      const line = String(errors.mock.calls[0].arguments[0]);
      assert.match(line, /awaiting-carry record failed/);
      assert.ok(line.includes(S1));
      assert.match(line, /ProvisionedThroughputExceededException/);
    } finally {
      mock.restoreAll();
    }
  });

  test('the series write path (new fixtures) still completes when the upsert throws', async () => {
    const errors = mock.method(console, 'error', () => {});
    try {
      const before = (await repo.getSeries(T, S1))!;
      const after = {
        ...before,
        fixtures: [...(before.fixtures as unknown[]), fx('f3', { home: 'a', away: 'c' })],
      } as Series;
      const handle = await schedule.recordScheduleDiff(throwingRepo(), T, before, after, 'admin', {
        log: () => {},
      });
      assert.deepEqual(handle.newRefs, [REF(S1, 'f3')]);
      assert.equal(await handle.enqueue(), 0, 'enqueue resolves');
      assert.equal(errors.mock.callCount(), 1);
      assert.deepEqual(await repo.listMcAwait(T), []);
      const logs = await repo.listSyncLogs(T);
      assert.ok(
        logs.some((l) => l.kind === 'new-fixtures'),
        'the SYNCLOG notice still landed',
      );
    } finally {
      mock.restoreAll();
    }
  });

  test('a schedule push answered `unmapped` still drops its outbox row when the upsert throws', async () => {
    const errors = mock.method(console, 'error', () => {});
    try {
      const s = (await repo.getSeries(T, S1))!;
      const res = await app.request(`/series/${S1}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({
          fixtures: (s.fixtures as Array<Record<string, unknown>>).map((f) =>
            f.id === 'f2' ? { ...f, time: '14:00' } : f,
          ),
          version: s.version,
        }),
      });
      assert.equal(res.status, 200, await res.text());
      pushStatus = () => 'unmapped';
      const summary = await schedule.flushScheduleOutbox(T, 'cron', {
        repo: throwingRepo(),
        url: stubUrl,
        secret: SECRET,
        log: () => {},
      });
      assert.equal(summary.counts.unmapped, 1);
      assert.equal(errors.mock.callCount(), 1);
      assert.deepEqual(await repo.listPendingSync(T), []);
      assert.deepEqual(await repo.listMcAwait(T), []);
    } finally {
      mock.restoreAll();
    }
  });
});
