/**
 * Medicoach sync — what the admin "Medicoach sync" page is told (ADR 0016), end to end against
 * a STUB medicoach and the REAL puller, outbox flush and Hono app on in-process dynalite:
 *
 * - the contract v1 venue cap: smart club never sends a venue longer than 200 characters and
 *   truncates a longer inbound one before resolving it against the ground list;
 * - an outbox row that failed 5+ times is reported as stuck (still retried), and the admin
 *   can Retry it now or Drop it;
 * - failures are explained in plain language (SYNCLOG `message`, the page's banner) with the
 *   technical detail kept beside it, and the last successful sync is recorded;
 * - the conflict inbox carries both schedules as comparable parts.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Series, TenantConfig, Venue } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4689;
const TABLE = 'SmartClubMedicoachSyncUx';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const T = 'dolphins';
const SECRET = 'stub-shared-secret';
const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
const ADMIN = devAuth('admin@test', [{ tenantId: T, role: 'admin', clubIds: [] }]);
const REP = devAuth('rep@test', [{ tenantId: T, role: 'rep', clubIds: ['a'] }]);
const headers = (auth = ADMIN) => ({
  'x-tenant': T,
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let puller: typeof import('../src/medicoach-sync/puller.js');
let schedule: typeof import('../src/medicoach-sync/schedule.js');
let run: typeof import('../src/medicoach-sync/run.js');
let contract: typeof import('../src/medicoach-sync-contract.js');

// ── Stub medicoach ──
let stub: Server;
let stubUrl = '';
let page: unknown = null;
let pullHttpFail: number | null = null;
let pushStatus: (ref: string) => string = () => 'applied';
const pushed: Array<{ ref: string; schedule: Record<string, unknown> }> = [];

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
      if (!check.ok) return void res.writeHead(401).end('{}');
      // The cron's awaiting-carry reconciliation (ADR 0020): this stub predates the endpoint.
      if (req.url === contract.IMPORT_CHECK_REFS_PATH)
        return void res.writeHead(404).end('{"error":"not found"}');
      if (req.method === 'POST') {
        const body = JSON.parse(raw) as {
          changes: Array<{ ref: string; schedule: Record<string, unknown> }>;
        };
        pushed.push(...body.changes);
        const results = body.changes.map((c) => {
          const status = pushStatus(c.ref);
          return {
            ref: c.ref,
            status,
            ...(status === 'error' ? { message: 'fixture locked' } : {}),
          };
        });
        return void res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ version: 1, results }));
      }
      if (pullHttpFail) return void res.writeHead(pullHttpFail).end('{"error":"nope"}');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(page));
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
const S1 = 's-ux-premier-t20';
const REF = (fixtureId: string) => `smartclub:${T}:fixture:${S1}:${fixtureId}`;
/** A ground whose real name is exactly the 200-character cap. */
const LONG_GROUND = `Long Ground ${'z'.repeat(200 - 'Long Ground '.length)}`;
const VENUES: Venue[] = [
  { id: 'v-kingsmead', name: 'Kingsmead Oval' },
  { id: 'v-lahee', name: 'Lahee Park' },
  { id: 'v-long', name: LONG_GROUND },
];

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
  await repo.putSeries(T, {
    id: S1,
    name: 'Premier T20',
    leagueKey: 'premier',
    startDate: '2026-10-04',
    teams: ['a', 'b', 'c', 'd'],
    participants: ['a', 'b', 'c', 'd'].map((t) => ({
      teamId: t,
      clubId: t,
      name: `Team ${t.toUpperCase()}`,
      venue: 'Kingsmead Oval',
    })),
    fixtures: [fx('f1'), fx('f2', { home: 'c', away: 'd', time: '13:30' })],
    kind: 'series',
    approved: true,
    approvedAt: '2026-09-01T00:00:00.000Z',
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  } as unknown as Series);
}

const MC_AT = new Date(Date.now() - 3600_000).toISOString();

function changesPage(ref: string, schedule: Record<string, unknown>) {
  return {
    version: 1,
    tenant: T,
    nextCursor: 'c-1',
    hasMore: false,
    fixtures: [
      {
        ref,
        syncStamp: MC_AT,
        schedule: {
          scheduledTime: '2026-10-04T09:00:00+02:00',
          timeTbc: false,
          dateTbc: false,
          venue: 'Kingsmead Oval',
          postponed: false,
          cancelled: false,
          changedAt: MC_AT,
          ...schedule,
        },
        teams: { homeRef: null, awayRef: null },
        result: null,
        resultClearedAt: null,
      },
    ],
  };
}

const deps = (over: Record<string, unknown> = {}) => ({
  repo,
  url: stubUrl,
  secret: SECRET,
  log: () => {},
  onResultStored: async () => {},
  notifyConflict: async () => {},
  ...over,
});

const flush = () =>
  schedule.flushScheduleOutbox(T, 'cron', { repo, url: stubUrl, secret: SECRET, log: () => {} });

const fixtureOf = async (fixtureId: string) =>
  ((await repo.getSeries(T, S1))!.fixtures as Array<Record<string, unknown>>).find(
    (f) => f.id === fixtureId,
  )!;

const patchFixture = async (fixtureId: string, over: Record<string, unknown>) => {
  const s = (await repo.getSeries(T, S1))!;
  const fixtures = (s.fixtures as Array<Record<string, unknown>>).map((f) =>
    f.id === fixtureId ? { ...f, ...over } : f,
  );
  const res = await app.request(`/series/${S1}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ fixtures, version: s.version }),
  });
  assert.equal(res.status, 200, await res.clone().text());
};

interface StatusBody {
  health?: {
    lastSuccessAt?: string;
    lastAttemptAt?: string;
    lastError?: string;
    lastErrorAt?: string;
    lastErrorText?: string;
  };
  logs: Array<{ outcome: string; error?: string; message?: string; kind?: string }>;
  outbox: {
    count: number;
    failures: Array<{
      ref: string;
      attempts: number;
      stuck: boolean;
      lastError: string;
      lastErrorText: string;
    }>;
  };
  conflicts: Array<{
    current: Record<string, unknown>;
    proposedParts: {
      date?: string;
      time?: string;
      venue?: string;
      status: string;
      dateTbc?: boolean;
    };
    reason: string;
    detail: string[];
  }>;
}

const status = async (): Promise<StatusBody> => {
  const res = await app.request('/integrations/medicoach/status', { headers: headers() });
  assert.equal(res.status, 200);
  return (await res.json()) as StatusBody;
};

const post = (p: string, body: unknown, auth = ADMIN) =>
  app.request(`/integrations/medicoach/${p}`, {
    method: 'POST',
    headers: headers(auth),
    body: JSON.stringify(body),
  });

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

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');
  puller = await import('../src/medicoach-sync/puller.js');
  schedule = await import('../src/medicoach-sync/schedule.js');
  run = await import('../src/medicoach-sync/run.js');
  contract = await import('../src/medicoach-sync-contract.js');
  await startStub();
  // The app's routes (Retry) read the sync connection from the environment.
  process.env.MEDICOACH_SYNC_URL = stubUrl;
  process.env.MEDICOACH_SYNC_SECRET = SECRET;
});

after(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
  await stopDynalite(ddb);
});

beforeEach(async () => {
  await resetTable();
  await seed();
  page = changesPage(REF('f1'), {});
  pullHttpFail = null;
  pushStatus = () => 'applied';
  pushed.length = 0;
});

describe('contract v1 venue cap (200 characters)', () => {
  test('an outbound schedule never carries a venue longer than 200 characters', async () => {
    const long = `Westville Boys High Commons ${'y'.repeat(300)}`;
    await patchFixture('f1', { venueId: undefined, venueName: undefined, venueOverride: long });
    const [row] = await repo.listPendingSync(T);
    assert.equal(row.schedule.venue, long.slice(0, 200));
    await flush();
    assert.equal(pushed.length, 1);
    assert.equal((pushed[0].schedule.venue as string).length, 200);
  });

  test('an outbox row stored before the cap is truncated when it is sent', async () => {
    await repo.putPendingSync(T, {
      ref: REF('f1'),
      seriesId: S1,
      fixtureId: 'f1',
      schedule: {
        scheduledTime: '2026-10-04T09:00:00+02:00',
        timeTbc: false,
        dateTbc: false,
        venue: 'v'.repeat(260),
        postponed: false,
        cancelled: false,
        changedAt: new Date().toISOString(),
      },
      origin: 'admin',
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    });
    const out = await flush();
    assert.equal(out.counts.applied, 1);
    assert.equal(pushed[0].schedule.venue, 'v'.repeat(200));
  });

  test('a longer inbound venue is truncated before it is resolved against the grounds', async () => {
    page = changesPage(REF('f1'), {
      venue: `${LONG_GROUND} — overflow the sender should not send`,
    });
    const summary = await puller.runMedicoachSync(T, 'cron', deps());
    assert.equal(summary.counts.scheduleApplied, 1);
    const f1 = await fixtureOf('f1');
    assert.equal(f1.venueName, LONG_GROUND);
    assert.equal(f1.venueId, 'v-long');
  });
});

describe('a stuck outbox row (5+ failed pushes)', () => {
  async function failFiveTimes() {
    await patchFixture('f1', { time: '10:00' });
    pushStatus = () => 'error';
    for (let i = 0; i < 5; i++) await flush();
  }

  test('is reported as stuck with a plain-language reason, and is still retried', async () => {
    await patchFixture('f1', { time: '10:00' });
    pushStatus = () => 'error';
    for (let i = 0; i < 4; i++) await flush();
    let body = await status();
    assert.equal(body.outbox.failures[0].attempts, 4);
    assert.equal(body.outbox.failures[0].stuck, false);
    await flush();
    body = await status();
    assert.equal(body.outbox.failures[0].attempts, 5);
    assert.equal(body.outbox.failures[0].stuck, true);
    assert.equal(body.outbox.failures[0].lastError, 'fixture locked');
    assert.match(
      body.outbox.failures[0].lastErrorText,
      /medicoach couldn't apply this change: fixture locked/,
    );
    // No silent give-up: the next run still sends it.
    pushed.length = 0;
    await flush();
    assert.equal(pushed.length, 1);
  });

  test('Retry sends it now; once medicoach accepts it the row is gone', async () => {
    await failFiveTimes();
    pushStatus = () => 'applied';
    const res = await post('outbox/retry', { ref: REF('f1') });
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, 'sent');
    assert.deepEqual(await repo.listPendingSync(T), []);
  });

  test('Retry that fails again says so and keeps the row, its count restarted', async () => {
    await failFiveTimes();
    const res = await post('outbox/retry', { ref: REF('f1') });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; lastErrorText: string };
    assert.equal(body.status, 'failed');
    assert.match(body.lastErrorText, /fixture locked/);
    const [row] = await repo.listPendingSync(T);
    assert.equal(row.attempts, 1);
  });

  test('Drop deletes the row without sending it; unknown refs are 404 and reps are refused', async () => {
    await failFiveTimes();
    pushed.length = 0;
    assert.equal((await post('outbox/drop', { ref: REF('f1') }, REP)).status, 403);
    const res = await post('outbox/drop', { ref: REF('f1') });
    assert.equal(res.status, 200);
    assert.deepEqual(await repo.listPendingSync(T), []);
    assert.equal(pushed.length, 0);
    assert.equal((await post('outbox/drop', { ref: REF('f1') })).status, 404);
    assert.equal((await post('outbox/retry', { ref: REF('f9') })).status, 404);
    assert.equal((await post('outbox/retry', {})).status, 400);
  });
});

describe('plain-language errors and the last successful sync', () => {
  test('a 401 is explained in SYNCLOG and on the page, with the technical detail kept', async () => {
    pullHttpFail = 401;
    await assert.rejects(run.runTenantSync(T, 'manual', deps()));
    const body = await status();
    const log = body.logs.find((l) => l.outcome === 'error')!;
    assert.equal(log.error, 'medicoach answered HTTP 401');
    assert.equal(
      log.message,
      'medicoach rejected our credentials — check the MedicoachSyncSecret matches on both sides.',
    );
    assert.equal(body.health?.lastError, 'medicoach answered HTTP 401');
    assert.equal(body.health?.lastErrorText, log.message);
    assert.equal(body.health?.lastSuccessAt, undefined);
  });

  test('a timeout is explained, and a later good run records the last successful sync', async () => {
    const timeout = async () => {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    };
    await assert.rejects(run.runTenantSync(T, 'cron', deps({ fetch: timeout })));
    let body = await status();
    assert.equal(
      body.logs[0].message,
      "Couldn't reach medicoach — timed out. We'll try again automatically in 15 minutes.",
    );
    assert.ok(body.health?.lastErrorAt);

    // A quiet good run leaves no SYNCLOG row, but it is the last successful sync.
    page = { version: 1, tenant: T, nextCursor: 'c-2', hasMore: false, fixtures: [] };
    const logsBefore = body.logs.length;
    await run.runTenantSync(T, 'cron', deps());
    body = await status();
    assert.equal(body.logs.length, logsBefore);
    assert.ok(body.health?.lastSuccessAt);
    assert.ok(Date.parse(body.health!.lastSuccessAt!) >= Date.parse(body.health!.lastErrorAt!));
  });

  test('"Sync now" that fails answers 502 in plain language, the technical text beside it', async () => {
    pullHttpFail = 401;
    const res = await post('sync-now', {});
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string; code: string; technical: string };
    assert.equal(
      body.error,
      'medicoach rejected our credentials — check the MedicoachSyncSecret matches on both sides.',
    );
    assert.equal(body.code, 'sync_failed');
    assert.equal(body.technical, 'medicoach answered HTTP 401');
  });

  test('a dry run is never recorded as a successful sync', async () => {
    await run.runTenantSync(T, 'cron', deps({ secret: '' }));
    const body = await status();
    assert.equal(body.health?.lastSuccessAt, undefined);
  });
});

describe('the conflict inbox', () => {
  test('carries both schedules as comparable parts and the reason', async () => {
    page = changesPage(REF('f2'), {
      scheduledTime: '2026-10-11T14:00:00+02:00',
      venue: 'Nowhere Oval',
      postponed: true,
    });
    await puller.runMedicoachSync(T, 'cron', deps());
    const [c] = (await status()).conflicts;
    assert.equal(c.reason, 'venue-unresolved');
    assert.deepEqual(c.current, {
      date: '2026-10-04',
      time: '13:30',
      venue: 'Kingsmead Oval',
      status: 'scheduled',
    });
    assert.deepEqual(c.proposedParts, {
      date: '2026-10-11',
      time: '14:00',
      venue: 'Nowhere Oval',
      status: 'postponed',
    });
  });
});

describe('explainSyncError', () => {
  test('maps every technical failure to text an admin can act on', async () => {
    const { explainSyncError } = await import('../src/medicoach-sync/explain.js');
    const cases: Array<[string, RegExp]> = [
      [
        'medicoach unreachable: TimeoutError',
        /^Couldn't reach medicoach — timed out\. We'll try again automatically in 15 minutes\.$/,
      ],
      ['medicoach unreachable: TypeError', /^Couldn't reach medicoach — the connection failed\./],
      [
        'medicoach answered HTTP 401',
        /^medicoach rejected our credentials — check the MedicoachSyncSecret matches on both sides\.$/,
      ],
      ['medicoach answered HTTP 403', /medicoach refused access/],
      ['medicoach answered HTTP 503', /medicoach is unavailable right now \(HTTP 503\)/],
      ['medicoach answered HTTP 500', /medicoach had a server error \(HTTP 500\)/],
      ['medicoach answered HTTP 404', /check MedicoachSyncUrl/],
      ['medicoach answered with a body that is not JSON', /isn't sync data/],
      [
        'medicoach response failed the v1 contract at fixtures.0.ref',
        /didn't match the agreed format/,
      ],
      ['medicoach response failed the v1 contract', /didn't match the agreed format/],
      ['medicoach answered for a different tenant', /different union/],
      [
        'stopped after 50 pages with more still to fetch; the next run continues',
        /next run carries on/,
      ],
      ['internal error', /went wrong on our side/],
      ['medicoach returned no result for this fixture', /didn't confirm this change/],
      ['the stored schedule does not fit the v1 contract', /can't be sent/],
      ['fixture locked', /^medicoach couldn't apply this change: fixture locked\./],
    ];
    for (const [technical, human] of cases)
      assert.match(explainSyncError(technical), human, technical);
    assert.equal(explainSyncError(undefined), '');
  });
});
