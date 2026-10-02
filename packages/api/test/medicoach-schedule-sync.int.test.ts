/**
 * Medicoach ↔ smart club SCHEDULE sync (ADR 0016, Slices 3 and 4) end to end: a STUB
 * medicoach on a free localhost port serves `GET /changes` pages and answers
 * `POST /schedule` pushes (verifying every signature with the contract helper), while the
 * REAL puller, outbox flush and Hono app run against an in-process dynalite table.
 *
 * Slice 3 (inbound): a newer medicoach change is applied (no echo into the outbox); an older
 * one is dropped and logged; a change that would clash, or names an unknown ground, is held
 * as SYNCCONFLICT# (not applied) and emails the admins once; the admin inbox applies (clash
 * gate re-run) or discards it.
 *
 * Slice 4 (outbound): an admin edit queues PENDINGSYNC#, several edits collapse, a flush
 * sends one signed batch and deletes the rows on success, `error`/HTTP failures keep them for
 * the next run; the CLI helper queues from shift-fixture-dates; and stage generate/rebase on
 * synced released series 409 unless `allowResync`.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  Club,
  SeasonCalendar,
  SeasonRun,
  Series,
  StageSpec,
  SyncConflict,
  TenantConfig,
  Venue,
} from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4671; // next free odd port after captains-reports (4667) / 4669 unused
const TABLE = 'SmartClubMedicoachScheduleSync';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const T = 'dolphins';
const SECRET = 'stub-shared-secret';
const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
const ADMIN = devAuth('admin@test', [{ tenantId: T, role: 'admin', clubIds: [] }]);
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
let contract: typeof import('../src/medicoach-sync-contract.js');

// ── Stub medicoach ──
let stub: Server;
let stubUrl = '';
let pages: unknown[] = [];
interface Push {
  verified: boolean;
  body: {
    version: number;
    tenant: string;
    changes: Array<{ ref: string; schedule: Record<string, unknown> }>;
  };
}
const pushes: Push[] = [];
/** How the stub answers a push: per-ref status, or a whole-request HTTP failure. */
let pushStatus: (ref: string) => string = () => 'applied';
let pushHttpFail: number | null = null;

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
      if (req.method === 'POST') {
        const body = JSON.parse(raw);
        pushes.push({ verified: check.ok, body });
        if (!check.ok) return void res.writeHead(401).end('{}');
        if (pushHttpFail) return void res.writeHead(pushHttpFail).end('{"error":"down"}');
        const results = body.changes.map((c: { ref: string }) => {
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
      if (!check.ok) return void res.writeHead(401).end('{}');
      const page = pages.length > 1 ? pages.shift() : pages[0];
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
const S1 = 's-planb-premier-men-t20-g1';
const S2 = 's-planb-premier-men-t20-g2';
const REF = (seriesId: string, fixtureId: string) =>
  `smartclub:${T}:fixture:${seriesId}:${fixtureId}`;

const VENUES: Venue[] = [
  { id: 'v-toti-1', name: 'Toti Oval 1' },
  { id: 'v-kingsmead', name: 'Kingsmead Oval' },
  { id: 'v-lahee', name: 'Lahee Park' },
];

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

async function seed() {
  await repo.putTenantConfig({
    tenant: T,
    branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: { medicoachSync: true },
  } as unknown as TenantConfig);
  for (const v of VENUES) await repo.putVenue(T, v);
  await repo.putSeries(
    T,
    series(S1, [fx('f1'), fx('f2', { home: 'c', away: 'd', time: '13:30' })]),
  );
  // Another released series already booking Toti Oval 1 on 11 Oct at 13:30.
  await repo.putSeries(
    T,
    series(S2, [
      fx('f1', {
        date: '2026-10-11',
        time: '13:30',
        home: 'c',
        away: 'd',
        venueId: 'v-toti-1',
        venueName: 'Toti Oval 1',
      }),
    ]),
  );
}

/** Medicoach's edit instants, relative to the real clock: smart-club edits made by a test
 * (stamped `now`) are always newer than MC_AT and MC_LATER. */
const MC_AT = new Date(Date.now() - 2 * 3600_000).toISOString();
const MC_LATER = new Date(Date.now() - 3600_000).toISOString();

/** One changes page carrying `changes` (schedule only, no result). */
function changesPage(
  changes: Array<{ ref: string; schedule: Record<string, unknown> }>,
  cursor = 'c-1',
) {
  return {
    version: 1,
    tenant: T,
    nextCursor: cursor,
    hasMore: false,
    fixtures: changes.map((c) => ({
      ref: c.ref,
      syncStamp: '2026-10-06T11:20:00.000Z',
      schedule: {
        scheduledTime: '2026-10-11T13:30:00+02:00',
        timeTbc: false,
        dateTbc: false,
        venue: 'Kingsmead Oval',
        postponed: false,
        cancelled: false,
        changedAt: MC_AT,
        ...c.schedule,
      },
      teams: { homeRef: null, awayRef: null },
      result: null,
      resultClearedAt: null,
    })),
  };
}

const conflictEmails: SyncConflict[] = [];
const pull = () =>
  puller.runMedicoachSync(T, 'cron', {
    repo,
    url: stubUrl,
    secret: SECRET,
    log: () => {},
    onResultStored: async () => {},
    notifyConflict: async (_t, c) => {
      conflictEmails.push(c);
    },
  });
const flush = () =>
  schedule.flushScheduleOutbox(T, 'cron', { repo, url: stubUrl, secret: SECRET, log: () => {} });

const fixtureOf = async (seriesId: string, fixtureId: string) =>
  ((await repo.getSeries(T, seriesId))!.fixtures as Array<Record<string, unknown>>).find(
    (f) => f.id === fixtureId,
  )!;

const patchFixture = async (seriesId: string, fixtureId: string, over: Record<string, unknown>) => {
  const s = (await repo.getSeries(T, seriesId))!;
  const fixtures = (s.fixtures as Array<Record<string, unknown>>).map((f) =>
    f.id === fixtureId ? { ...f, ...over } : f,
  );
  return app.request(`/series/${seriesId}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ fixtures, version: s.version }),
  });
};

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
  pages = [];
  pushes.length = 0;
  pushStatus = () => 'applied';
  pushHttpFail = null;
  conflictEmails.length = 0;
});

describe('Slice 3 — inbound schedule changes', () => {
  test('a newer medicoach schedule is applied through the gates, with no echo into the outbox', async () => {
    pages = [
      changesPage([
        {
          ref: REF(S1, 'f1'),
          schedule: { scheduledTime: '2026-10-11T08:30:00Z', venue: 'Lahee Park' },
        },
      ]),
    ];
    const summary = await pull();
    assert.equal(summary.counts.scheduleDiffers, 1);
    assert.equal(summary.counts.scheduleApplied, 1);
    const f1 = await fixtureOf(S1, 'f1');
    // 08:30Z is 10:30 in Africa/Johannesburg.
    assert.equal(f1.date, '2026-10-11');
    assert.equal(f1.time, '10:30');
    assert.equal(f1.venueId, 'v-lahee');
    assert.equal(f1.venueName, 'Lahee Park');
    assert.deepEqual(f1.schedule, { changedAt: MC_AT });
    const s1 = (await repo.getSeries(T, S1))!;
    // Released state, withheld and approval are exactly as an in-season admin edit leaves them.
    assert.equal(s1.released, true);
    assert.equal(s1.approved, true);
    assert.equal(s1.version, 2);
    // origin = medicoach: nothing is queued back.
    assert.deepEqual(await repo.listPendingSync(T), []);

    // The same page again: nothing differs any more.
    pages = [
      changesPage([
        {
          ref: REF(S1, 'f1'),
          schedule: { scheduledTime: '2026-10-11T08:30:00Z', venue: 'Lahee Park' },
        },
      ]),
    ];
    const again = await pull();
    assert.equal(again.counts.scheduleDiffers, 0);
  });

  test('timeTbc clears the time, postponed sets the status, and a draft loses its approval', async () => {
    await repo.putSeries(T, series('s-draft', [fx('f1')], { released: false, releasedAt: null }));
    pages = [
      changesPage([
        {
          ref: REF('s-draft', 'f1'),
          schedule: {
            scheduledTime: '2026-10-04T00:00:00+02:00',
            timeTbc: true,
            postponed: true,
          },
        },
      ]),
    ];
    const summary = await pull();
    assert.equal(summary.counts.scheduleApplied, 1);
    const f1 = await fixtureOf('s-draft', 'f1');
    assert.equal(f1.time, undefined);
    assert.equal(f1.status, 'postponed');
    const draft = (await repo.getSeries(T, 's-draft'))!;
    assert.equal(draft.approved, false, 'a fixtures edit on a draft recalls approval');
    assert.equal(draft.released, false);
  });

  test('an older medicoach change is dropped and logged; smart club keeps its schedule', async () => {
    await patchFixture(S1, 'f1', { time: '10:00' }); // stamps schedule.changedAt = now
    const ours = (await fixtureOf(S1, 'f1')).schedule as { changedAt: string };
    assert.ok(ours.changedAt > MC_AT, 'the admin edit is newer');
    pages = [
      changesPage([
        { ref: REF(S1, 'f1'), schedule: { scheduledTime: '2026-10-04T12:00:00+02:00' } },
      ]),
    ];
    const summary = await pull();
    assert.equal(summary.counts.scheduleStale, 1);
    assert.equal((await fixtureOf(S1, 'f1')).time, '10:00');
    const [row] = await repo.listSyncLogs(T);
    assert.deepEqual(row.scheduleStaleRefs, [REF(S1, 'f1')]);
    assert.equal(row.counts.scheduleStale, 1);
  });

  test('a change that would clash is held as a conflict, not applied, and emails the admins once', async () => {
    // f2 (c v d) → Toti Oval 1 on 11 Oct 13:30, which S2/f1 already holds.
    const clash = changesPage([
      {
        ref: REF(S1, 'f2'),
        schedule: { scheduledTime: '2026-10-11T13:30:00+02:00', venue: 'Toti Oval 1' },
      },
    ]);
    pages = [clash];
    const summary = await pull();
    assert.equal(summary.counts.scheduleConflicts, 1);
    const f2 = await fixtureOf(S1, 'f2');
    assert.equal(f2.date, '2026-10-04', 'not applied');
    assert.equal(f2.venueName, 'Kingsmead Oval');
    const conflict = (await repo.getSyncConflict(T, REF(S1, 'f2')))!;
    assert.equal(conflict.reason, 'clash');
    assert.match(conflict.detail[0], /Toti Oval 1 on 2026-10-11 13:30 is already booked/);
    assert.ok(conflict.notifiedAt, 'admins notified');
    assert.equal(conflictEmails.length, 1);

    // The same proposal again (a replayed page): no second email, nothing rewritten.
    pages = [clash];
    await pull();
    assert.equal(conflictEmails.length, 1);

    // A NEWER proposal for the same ref replaces it (latest wins) and emails again.
    pages = [
      changesPage([
        {
          ref: REF(S1, 'f2'),
          schedule: {
            scheduledTime: '2026-10-11T13:30:00+02:00',
            venue: 'Toti Oval 1',
            changedAt: MC_LATER,
          },
        },
      ]),
    ];
    await pull();
    assert.equal(conflictEmails.length, 2);
    const latest = (await repo.listSyncConflicts(T)).map((c) => c.proposed.changedAt);
    assert.deepEqual(latest, [MC_LATER]);
  });

  test('a venue that matches no ground is held as a conflict', async () => {
    pages = [changesPage([{ ref: REF(S1, 'f1'), schedule: { venue: 'Somewhere Unknown' } }])];
    const summary = await pull();
    assert.equal(summary.counts.scheduleConflicts, 1);
    const conflict = (await repo.getSyncConflict(T, REF(S1, 'f1')))!;
    assert.equal(conflict.reason, 'venue-unresolved');
    assert.match(conflict.detail[0], /Somewhere Unknown/);
    assert.equal((await fixtureOf(S1, 'f1')).date, '2026-10-04');
  });
});

describe('Slice 3 — the admin conflict inbox', () => {
  const holdClash = async () => {
    pages = [
      changesPage([
        {
          ref: REF(S1, 'f2'),
          schedule: { scheduledTime: '2026-10-11T13:30:00+02:00', venue: 'Toti Oval 1' },
        },
      ]),
    ];
    await pull();
  };
  const post = (p: string, body: unknown) =>
    app.request(`/integrations/medicoach/${p}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });

  test('status lists the conflict; Apply re-runs the clash gate and refuses while it still clashes', async () => {
    await holdClash();
    const status = await app.request('/integrations/medicoach/status', { headers: headers() });
    assert.equal(status.status, 200);
    const body = (await status.json()) as {
      enabled: boolean;
      conflicts: Array<SyncConflict & { proposedText: string }>;
      outbox: { count: number };
    };
    assert.equal(body.enabled, true);
    assert.equal(body.conflicts.length, 1);
    assert.equal(body.conflicts[0].proposedText, '2026-10-11 13:30 · Toti Oval 1');

    const refused = await post('conflicts/apply', { ref: REF(S1, 'f2') });
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { code: string }).code, 'venue_clash');
    assert.ok(await repo.getSyncConflict(T, REF(S1, 'f2')), 'still held');
  });

  test('Apply once the clash is gone: written as an admin edit and queued back to medicoach', async () => {
    await holdClash();
    // The other fixture moves away, so the ground is free.
    await patchFixture(S2, 'f1', { time: '09:00' });
    const res = await post('conflicts/apply', { ref: REF(S1, 'f2') });
    assert.equal(res.status, 200);
    const f2 = await fixtureOf(S1, 'f2');
    assert.equal(f2.date, '2026-10-11');
    assert.equal(f2.venueName, 'Toti Oval 1');
    assert.equal(await repo.getSyncConflict(T, REF(S1, 'f2')), null);
    const queued = (await repo.listPendingSync(T)).find((p) => p.ref === REF(S1, 'f2'))!;
    assert.equal(queued.origin, 'admin');
    assert.equal(queued.schedule.venue, 'Toti Oval 1');
  });

  test('Discard keeps smart club schedule, re-stamps it and queues it for medicoach', async () => {
    await holdClash();
    const res = await post('conflicts/discard', { ref: REF(S1, 'f2') });
    assert.equal(res.status, 200);
    assert.equal(await repo.getSyncConflict(T, REF(S1, 'f2')), null);
    const f2 = await fixtureOf(S1, 'f2');
    assert.equal(f2.date, '2026-10-04');
    const stamp = (f2.schedule as { changedAt: string }).changedAt;
    assert.ok(stamp > MC_AT, 're-stamped newer than the proposal');
    const queued = (await repo.listPendingSync(T)).find((p) => p.ref === REF(S1, 'f2'))!;
    assert.equal(queued.schedule.scheduledTime, '2026-10-04T13:30:00+02:00');
    assert.equal(queued.schedule.changedAt, stamp);

    // The discarded proposal arriving again is now older: dropped, not re-held.
    await holdClash();
    assert.equal(await repo.getSyncConflict(T, REF(S1, 'f2')), null);
  });

  test('an unknown conflict ref is a 404; a missing ref a 400', async () => {
    assert.equal((await post('conflicts/apply', { ref: 'smartclub:x' })).status, 404);
    assert.equal((await post('conflicts/discard', {})).status, 400);
  });
});

describe('Slice 4 — the outbox', () => {
  test('an admin edit queues the ref; a flush sends one signed batch and deletes it', async () => {
    const res = await patchFixture(S1, 'f1', {
      time: '10:00',
      venueId: 'v-lahee',
      venueName: 'Lahee Park',
    });
    assert.equal(res.status, 200);
    const [row] = await repo.listPendingSync(T);
    assert.equal(row.ref, REF(S1, 'f1'));
    assert.equal(row.origin, 'admin');
    assert.deepEqual(
      { ...row.schedule, changedAt: 'x' },
      {
        scheduledTime: '2026-10-04T10:00:00+02:00',
        timeTbc: false,
        dateTbc: false,
        venue: 'Lahee Park',
        postponed: false,
        cancelled: false,
        changedAt: 'x',
      },
    );
    // The same instant is stamped on the fixture (most-recent-wins on the next pull).
    const f1 = await fixtureOf(S1, 'f1');
    assert.equal((f1.schedule as { changedAt: string }).changedAt, row.schedule.changedAt);
    // An edit that is not a schedule change (f2 untouched) queues nothing for f2.
    assert.equal((await repo.listPendingSync(T)).length, 1);

    const out = await flush();
    assert.equal(out.counts.sent, 1);
    assert.equal(out.counts.applied, 1);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].verified, true);
    assert.equal(pushes[0].body.tenant, T);
    assert.deepEqual(
      pushes[0].body.changes.map((c) => c.ref),
      [REF(S1, 'f1')],
    );
    assert.ok(
      contract.SchedulePushRequestSchema.safeParse(pushes[0].body).success,
      'the push body fits the v1 contract',
    );
    assert.deepEqual(await repo.listPendingSync(T), []);
    const [log] = await repo.listSyncLogs(T);
    assert.equal(log.kind, 'push');
    assert.equal(log.push?.applied, 1);
  });

  test('several edits before a flush collapse onto one row with the latest schedule', async () => {
    await patchFixture(S1, 'f1', { time: '10:00' });
    await patchFixture(S1, 'f1', { time: '11:00' });
    await patchFixture(S1, 'f1', { status: 'postponed' });
    const rows = await repo.listPendingSync(T);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].schedule.scheduledTime, '2026-10-04T11:00:00+02:00');
    assert.equal(rows[0].schedule.postponed, true);
    await flush();
    assert.equal(pushes[0].body.changes.length, 1);
  });

  test('an `error` answer keeps the row with its attempt count and is retried next run', async () => {
    await patchFixture(S1, 'f1', { time: '10:00' });
    pushStatus = () => 'error';
    const first = await flush();
    assert.equal(first.counts.errors, 1);
    let [row] = await repo.listPendingSync(T);
    assert.equal(row.attempts, 1);
    assert.equal(row.lastError, 'fixture locked');

    pushHttpFail = 503; // medicoach down: the row stays too
    await flush();
    [row] = await repo.listPendingSync(T);
    assert.equal(row.attempts, 2);
    assert.equal(row.lastError, 'medicoach answered HTTP 503');

    const status = (await (
      await app.request('/integrations/medicoach/status', { headers: headers() })
    ).json()) as {
      outbox: { count: number; failures: Array<{ attempts: number; lastError: string }> };
    };
    assert.equal(status.outbox.count, 1);
    assert.equal(status.outbox.failures[0].lastError, 'medicoach answered HTTP 503');

    pushHttpFail = null;
    pushStatus = () => 'stale'; // medicoach holds a newer edit: still a success → dropped
    const third = await flush();
    assert.equal(third.counts.stale, 1);
    assert.deepEqual(await repo.listPendingSync(T), []);
  });

  test('a flush with the secret unset is a dry run: nothing sent, rows kept', async () => {
    await patchFixture(S1, 'f1', { time: '10:00' });
    const out = await schedule.flushScheduleOutbox(T, 'cron', {
      repo,
      url: stubUrl,
      secret: '',
      log: () => {},
    });
    assert.equal(out.status, 'dry-run');
    assert.equal(pushes.length, 0);
    assert.equal((await repo.listPendingSync(T)).length, 1);
  });

  test('"Sync now" flushes the outbox before it pulls', async () => {
    await patchFixture(S1, 'f1', { time: '10:00' });
    const { runTenantSync } = await import('../src/medicoach-sync/run.js');
    pages = [changesPage([], 'c-9')];
    const summary = await runTenantSync(T, 'manual', {
      repo,
      url: stubUrl,
      secret: SECRET,
      log: () => {},
    });
    assert.equal(summary.push?.counts.applied, 1);
    assert.equal(summary.status, 'ok');
    assert.deepEqual(await repo.listPendingSync(T), []);
  });

  test('a tenant without the sync, or an unmapped league, queues nothing', async () => {
    await repo.putSeries(T, series('s-demo', [fx('f1')], { leagueKey: 'demo' }));
    await patchFixture('s-demo', 'f1', { time: '10:00' });
    assert.deepEqual(await repo.listPendingSync(T), []);
    const cfg = (await repo.getTenantConfig(T))!;
    await repo.putTenantConfig({ ...cfg, features: {} });
    await patchFixture(S1, 'f1', { time: '10:00' });
    assert.deepEqual(await repo.listPendingSync(T), []);
  });

  test('the shift-fixture-dates CLI queues every moved fixture through the shared helper', async () => {
    const { runShift } = await import('../src/shift-fixture-dates.js');
    const cwd = process.cwd();
    process.chdir(await mkdtemp(path.join(os.tmpdir(), 'shift-'))); // its backup file lands here
    const log = console.log;
    console.log = () => {};
    try {
      await runShift([
        '--tenant',
        T,
        '--series',
        S1,
        '--from-date',
        '2026-10-04',
        '--to-date',
        '2026-10-18',
        '--cascade',
        'none',
        '--confirm',
      ]);
    } finally {
      console.log = log;
      process.chdir(cwd);
    }
    assert.equal((await fixtureOf(S1, 'f1')).date, '2026-10-18');
    const rows = (await repo.listPendingSync(T)).sort((a, b) => a.ref.localeCompare(b.ref));
    assert.deepEqual(
      rows.map((r) => [r.ref, r.origin, r.schedule.scheduledTime]),
      [
        [REF(S1, 'f1'), 'cli', '2026-10-18T09:00:00+02:00'],
        [REF(S1, 'f2'), 'cli', '2026-10-18T13:30:00+02:00'],
      ],
    );
  });

  test('the import-planb write path uses the same helper (stamp before the put, enqueue after)', async () => {
    // import-planb's write loop is `recordScheduleDiff(existing, s, 'cli') → putSeries →
    // enqueue()`; this drives exactly that sequence on a re-imported copy with one moved row.
    const existing = (await repo.getSeries(T, S1))!;
    const reimported = structuredClone(existing);
    (reimported.fixtures as Array<Record<string, unknown>>)[1].time = '14:00';
    reimported.version = existing.version + 1;
    const handle = await schedule.recordScheduleDiff(repo, T, existing, reimported, 'cli');
    assert.deepEqual(handle.refs, [REF(S1, 'f2')]);
    assert.equal((await repo.listPendingSync(T)).length, 0, 'nothing queued before the write');
    await repo.putSeries(T, reimported);
    await handle.enqueue();
    const [row] = await repo.listPendingSync(T);
    assert.equal(row.schedule.scheduledTime, '2026-10-04T14:00:00+02:00');
    const stored = await fixtureOf(S1, 'f2');
    assert.equal((stored.schedule as { changedAt: string }).changedAt, row.schedule.changedAt);
  });
});

// ── Fixture identity survives a moved date; new fixtures are reported (ADR 0016) ──
describe('Slice 4 — moved dates keep their ref; new fixtures are reported', () => {
  test('a medicoach-applied date, then a re-import of the old sheet date, keeps the id and pushes', async () => {
    pages = [
      changesPage([
        { ref: REF(S1, 'f1'), schedule: { scheduledTime: '2026-10-18T09:00:00+02:00' } },
      ]),
    ];
    assert.equal((await pull()).counts.scheduleApplied, 1);
    assert.equal((await fixtureOf(S1, 'f1')).date, '2026-10-18');

    // The sheet still says 4 Oct: the importer's id stabilisation + write path.
    const { stabiliseFixtureIds } = await import('../src/import-planb-fixtures.js');
    const existing = (await repo.getSeries(T, S1))!;
    const sheetRows = [fx('f1'), fx('f2', { home: 'c', away: 'd', time: '13:30' })].map((f, i) => ({
      ...f,
      id: `f${i + 1}`,
    }));
    // Row order swapped so a row-order id would be wrong.
    const incoming = [sheetRows[1], sheetRows[0]].map((f, i) => ({ ...f, id: `f${i + 1}` }));
    const reimported = { ...structuredClone(existing), fixtures: incoming } as Series;
    const ids = stabiliseFixtureIds(
      T,
      [{ series: reimported, fixtures: incoming } as never],
      [existing],
    );
    assert.deepEqual(ids.removedRefs, []);
    assert.deepEqual(
      incoming.map((f) => `${f.id} ${f.home}v${f.away} ${f.date}`),
      ['f2 cvd 2026-10-04', 'f1 avb 2026-10-04'],
    );
    const handle = await schedule.recordScheduleDiff(repo, T, existing, reimported, 'cli');
    assert.deepEqual(handle.refs, [REF(S1, 'f1')]);
    assert.deepEqual(handle.newRefs, []);
    await repo.putSeries(T, reimported);
    await handle.enqueue();
    await flush();
    assert.deepEqual(
      pushes[0].body.changes.map((c) => [c.ref, c.schedule.scheduledTime]),
      [[REF(S1, 'f1'), '2026-10-04T09:00:00+02:00']],
    );
  });

  test('a fixture added to a mapped series is not pushed but reported for a bundle top-up', async () => {
    const s = (await repo.getSeries(T, S1))!;
    const fixtures = [
      ...(s.fixtures as unknown[]),
      fx('f3', { date: '2026-11-08', home: 'a', away: 'c' }),
    ];
    const lines: string[] = [];
    const after = { ...structuredClone(s), fixtures } as Series;
    const handle = await schedule.recordScheduleDiff(repo, T, s, after, 'cli', {
      log: (l) => lines.push(l),
    });
    assert.deepEqual(handle.newRefs, [REF(S1, 'f3')]);
    await repo.putSeries(T, after);
    await handle.enqueue();
    assert.deepEqual(await repo.listPendingSync(T), [], 'medicoach cannot create a match');
    assert.match(lines.join('\n'), /new fixture\(s\).*not in medicoach \(needs bundle top-up\)/);
    assert.ok(lines.join('\n').includes(REF(S1, 'f3')));
    const logs = await repo.listSyncLogs(T);
    assert.equal(logs[0].kind, 'new-fixtures');
    assert.deepEqual(logs[0].newFixtureRefs, [REF(S1, 'f3')]);

    // The same through an admin PATCH: logged too, and nothing queued.
    const cur = (await repo.getSeries(T, S1))!;
    const res = await app.request(`/series/${S1}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({
        version: cur.version,
        fixtures: [
          ...(cur.fixtures as unknown[]),
          fx('f4', { date: '2026-11-15', home: 'b', away: 'd' }),
        ],
      }),
    });
    assert.equal(res.status, 200);
    const again = await repo.listSyncLogs(T);
    assert.deepEqual(again[0].newFixtureRefs, [REF(S1, 'f4')]);
    assert.deepEqual(await repo.listPendingSync(T), []);
  });
});

// ── Bulk CLIs write version-checked against the series they read (ADR 0016) ──
describe('Slice 4 — bulk CLI writes never overwrite a newer series', () => {
  test('a series edited after the CLI read it is skipped with a re-run message; a clean one writes', async () => {
    const { writeSeriesFromSnapshot } = await import('../src/medicoach-sync/cli-write.js');
    // The CLI reads every series and works on copies (as resolve-venue-clashes does).
    const read = (await repo.listSeries(T)).find((x) => x.id === S1)!;
    const original = structuredClone(read);
    // Meanwhile an admin moves f1.
    assert.equal((await patchFixture(S1, 'f1', { time: '15:00' })).status, 200);
    // The CLI's change: f2 to Lahee Park.
    (read.fixtures as Array<Record<string, unknown>>)[1].venueId = 'v-lahee';
    (read.fixtures as Array<Record<string, unknown>>)[1].venueName = 'Lahee Park';
    const errors: string[] = [];
    const outcome = await writeSeriesFromSnapshot(repo, T, original, read, {
      error: (l) => errors.push(l),
    });
    assert.equal(outcome, 'drifted');
    assert.match(errors.join('\n'), /changed since this run read it.*NOT written.*Re-run/);
    assert.equal((await fixtureOf(S1, 'f1')).time, '15:00', "the admin's edit survives");
    assert.equal((await fixtureOf(S1, 'f2')).venueName, 'Kingsmead Oval');
    assert.deepEqual(
      (await repo.listPendingSync(T)).map((r) => [r.ref, r.origin]),
      [[REF(S1, 'f1'), 'admin']],
      'only the admin edit is queued; the stale f1 is never pushed back',
    );

    // Re-run from the current series: only the CLI's own change is diffed and queued.
    const fresh = (await repo.listSeries(T)).find((x) => x.id === S1)!;
    const base = structuredClone(fresh);
    (fresh.fixtures as Array<Record<string, unknown>>)[1].venueId = 'v-lahee';
    (fresh.fixtures as Array<Record<string, unknown>>)[1].venueName = 'Lahee Park';
    assert.equal(await writeSeriesFromSnapshot(repo, T, base, fresh), 'written');
    assert.equal((await fixtureOf(S1, 'f1')).time, '15:00');
    assert.equal((await fixtureOf(S1, 'f2')).venueName, 'Lahee Park');
    assert.equal((await repo.getSeries(T, S1))!.version, base.version + 1);
    const cli = (await repo.listPendingSync(T)).filter((r) => r.origin === 'cli');
    assert.deepEqual(
      cli.map((r) => r.ref),
      [REF(S1, 'f2')],
    );
  });

  test('a new series the CLI meant to create is not written over one that appeared meanwhile', async () => {
    const { writeSeriesFromSnapshot } = await import('../src/medicoach-sync/cli-write.js');
    const SN = 's-planb-premier-men-t20-g9';
    await repo.putSeries(T, series(SN, [fx('f1')]));
    const errors: string[] = [];
    const outcome = await writeSeriesFromSnapshot(
      repo,
      T,
      null,
      series(SN, [fx('f1', { time: '17:00' })]),
      {
        error: (l) => errors.push(l),
      },
    );
    assert.equal(outcome, 'drifted');
    assert.equal((await fixtureOf(SN, 'f1')).time, '09:00');
  });
});

// ── Withheld venue/time never reaches medicoach (ADR 0011 × 0016) ──
describe('Slice 4 — a draft or withheld series is held until released/revealed', () => {
  const SW = 's-planb-premier-men-t20-g3';
  const seedWithheld = (withheld: Series['withheld']) =>
    repo.putSeries(
      T,
      series(SW, [fx('f1'), fx('f2', { home: 'c', away: 'd', time: '13:30' })], { withheld }),
    );
  const status = async () =>
    (await (
      await app.request('/integrations/medicoach/status', { headers: headers() })
    ).json()) as {
      outbox: {
        count: number;
        held: Array<{ ref: string; proposed: string }>;
        failures: unknown[];
      };
    };
  const reveal = async (fields: string[]) => {
    const s = (await repo.getSeries(T, SW))!;
    return app.request(`/series/${SW}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ reveal: fields, version: s.version }),
    });
  };

  test('an edit on a withheld series is held, not sent; other series are unaffected', async () => {
    await seedWithheld({ venue: true });
    const res = await patchFixture(SW, 'f1', {
      time: '10:00',
      venueId: 'v-lahee',
      venueName: 'Lahee Park',
    });
    assert.equal(res.status, 200);
    assert.equal((await patchFixture(S1, 'f1', { time: '11:00' })).status, 200);
    const byRef = new Map((await repo.listPendingSync(T)).map((r) => [r.ref, r]));
    assert.equal(byRef.get(REF(SW, 'f1'))?.heldUntilReveal, true);
    assert.equal(byRef.get(REF(S1, 'f1'))?.heldUntilReveal, undefined);

    const out = await flush();
    assert.equal(out.held, 1);
    assert.equal(out.counts.sent, 1);
    assert.equal(pushes.length, 1);
    assert.deepEqual(
      pushes[0].body.changes.map((c) => c.ref),
      [REF(S1, 'f1')],
    );
    assert.ok(!JSON.stringify(pushes).includes('Lahee'), 'the withheld venue never left');
    const [left] = await repo.listPendingSync(T);
    assert.equal(left.ref, REF(SW, 'f1'));
    assert.equal(left.heldUntilReveal, true);
    assert.equal(left.attempts, 0);

    const st = await status();
    assert.equal(st.outbox.count, 1);
    assert.deepEqual(
      st.outbox.held.map((h) => h.ref),
      [REF(SW, 'f1')],
    );
    assert.deepEqual(st.outbox.failures, []);

    // Another run while still withheld: still nothing goes out.
    await flush();
    assert.equal(pushes.length, 1);
  });

  test('revealing the last withheld field sends every fixture with its real schedule', async () => {
    await seedWithheld({ venue: true, time: true });
    await patchFixture(SW, 'f1', { time: '10:00', venueId: 'v-lahee', venueName: 'Lahee Park' });

    // Venue revealed, time still withheld: the series is still held back.
    assert.equal((await reveal(['venue'])).status, 200);
    await flush();
    assert.equal(pushes.length, 0);
    assert.equal((await repo.listPendingSync(T)).length, 1);

    assert.equal((await reveal(['time'])).status, 200);
    const rows = (await repo.listPendingSync(T)).sort((a, b) => a.ref.localeCompare(b.ref));
    assert.deepEqual(
      rows.map((r) => [r.ref, r.heldUntilReveal, r.schedule.scheduledTime, r.schedule.venue]),
      [
        [REF(SW, 'f1'), undefined, '2026-10-04T10:00:00+02:00', 'Lahee Park'],
        [REF(SW, 'f2'), undefined, '2026-10-04T13:30:00+02:00', 'Kingsmead Oval'],
      ],
    );
    // Stamped on the fixtures in the reveal write (most-recent-wins on the next pull).
    const f2 = await fixtureOf(SW, 'f2');
    assert.equal((f2.schedule as { changedAt: string }).changedAt, rows[1].schedule.changedAt);
    const stored = (await repo.getSeries(T, SW))!;
    assert.equal(stored.withheld, undefined);
    assert.ok(stored.revealedAt?.time);

    const out = await flush();
    assert.equal(out.held, 0);
    assert.equal(out.counts.applied, 2);
    const sent = new Map(pushes[0].body.changes.map((c) => [c.ref, c.schedule]));
    assert.equal(sent.get(REF(SW, 'f1'))?.venue, 'Lahee Park');
    assert.equal(sent.get(REF(SW, 'f1'))?.scheduledTime, '2026-10-04T10:00:00+02:00');
    assert.equal(sent.get(REF(SW, 'f1'))?.timeTbc, false);
    assert.deepEqual(await repo.listPendingSync(T), []);
  });

  test('the flush decides against the live series: withheld after the enqueue holds, cleared sends', async () => {
    await patchFixture(S1, 'f1', { time: '10:00' });
    await repo.updateSeries(T, S1, { withheld: { time: true } });
    const out = await flush();
    assert.equal(out.held, 1);
    assert.equal(pushes.length, 0);
    assert.equal((await repo.listPendingSync(T))[0].heldUntilReveal, true);

    await repo.updateSeries(T, S1, { withheld: undefined });
    const next = await flush();
    assert.equal(next.held, 0);
    assert.equal(next.counts.applied, 1);
    assert.equal(pushes[0].body.changes[0].schedule.scheduledTime, '2026-10-04T10:00:00+02:00');
  });

  // A draft series of its own (dates clear of S1/S2 so the release gate finds no clash).
  const SD = 's-planb-premier-men-t20-g4';
  const seedDraft = () =>
    repo.putSeries(
      T,
      series(
        SD,
        [
          fx('f1', { date: '2026-11-01' }),
          fx('f2', { date: '2026-11-01', home: 'c', away: 'd', time: '13:30' }),
        ],
        { released: false, releasedAt: undefined },
      ),
    );
  const patchSeries = async (id: string, body: Record<string, unknown>) => {
    const s = (await repo.getSeries(T, id))!;
    return app.request(`/series/${id}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ version: s.version, ...body }),
    });
  };

  test('a draft edit is held; the release (nothing withheld) sends every fixture', async () => {
    await seedDraft();
    assert.equal((await patchFixture(SD, 'f1', { time: '10:00' })).status, 200);
    const [row] = await repo.listPendingSync(T);
    assert.equal(row.ref, REF(SD, 'f1'));
    assert.equal(row.heldUntilReveal, true);
    const out = await flush();
    assert.equal(out.held, 1);
    assert.equal(pushes.length, 0, 'a draft schedule never leaves smart club');

    // The draft edit recalled the approval; approve, then release with nothing withheld.
    assert.equal((await patchSeries(SD, { approved: true })).status, 200);
    assert.equal((await patchSeries(SD, { released: true })).status, 200);
    const rows = (await repo.listPendingSync(T)).sort((a, b) => a.ref.localeCompare(b.ref));
    assert.deepEqual(
      rows.map((r) => [r.ref, r.heldUntilReveal, r.schedule.scheduledTime]),
      [
        [REF(SD, 'f1'), undefined, '2026-11-01T10:00:00+02:00'],
        [REF(SD, 'f2'), undefined, '2026-11-01T13:30:00+02:00'],
      ],
    );
    const f2 = await fixtureOf(SD, 'f2');
    assert.equal((f2.schedule as { changedAt: string }).changedAt, rows[1].schedule.changedAt);
    const sent = await flush();
    assert.equal(sent.held, 0);
    assert.equal(sent.counts.applied, 2);
    assert.deepEqual(await repo.listPendingSync(T), []);
  });

  test('released with venue withheld, edited, then recalled: the flush sends nothing', async () => {
    await seedDraft();
    const rel = await patchSeries(SD, { released: true, withheld: { venue: true } });
    assert.equal(rel.status, 200);
    assert.deepEqual(await repo.listPendingSync(T), [], 'a withheld release queues nothing');
    assert.equal(
      (await patchFixture(SD, 'f1', { venueId: 'v-lahee', venueName: 'Lahee Park' })).status,
      200,
    );
    assert.equal((await repo.listPendingSync(T))[0].heldUntilReveal, true);

    assert.equal((await patchSeries(SD, { released: false })).status, 200);
    const out = await flush();
    assert.equal(out.held, 1);
    assert.equal(pushes.length, 0);
    assert.equal((await repo.listPendingSync(T))[0].heldUntilReveal, true);

    // The recall CLI's path (a direct repo write) holds just the same.
    await repo.updateSeries(T, SD, { released: true, withheld: undefined });
    await repo.updateSeries(T, SD, { released: false, releasedAt: null });
    await flush();
    assert.equal(pushes.length, 0);
    assert.ok(!JSON.stringify(pushes).includes('Lahee'));
  });

  test('an outbox row whose series was deleted is dropped, never pushed', async () => {
    await patchFixture(S1, 'f1', { time: '10:00' });
    await repo.deleteSeries(T, S1);
    const out = await flush();
    assert.equal(out.pending, 0);
    assert.equal(pushes.length, 0);
    assert.deepEqual(await repo.listPendingSync(T), []);
  });

  test('a pulled medicoach change still applies to a withheld series', async () => {
    await seedWithheld({ venue: true });
    pages = [changesPage([{ ref: REF(SW, 'f1'), schedule: { venue: 'Lahee Park' } }])];
    const summary = await pull();
    assert.equal(summary.counts.scheduleApplied, 1);
    assert.equal((await fixtureOf(SW, 'f1')).venueName, 'Lahee Park');
    assert.deepEqual(await repo.listPendingSync(T), []);
  });
});

// ── GET /series `syncMapped` resolves the league like the outbox does ──
describe('GET /series syncMapped', () => {
  test("a season-run series takes its run's league; an unmapped run league is not marked", async () => {
    for (const [run, leagueKey] of [
      ['run-mapped', 'premier'],
      ['run-demo', 'demo'],
    ])
      await repo.putSeasonRun(T, {
        id: run,
        leagueKey,
        seasonLabel: 'S',
        stages: [],
        version: 1,
      } as unknown as SeasonRun);
    for (const run of ['run-mapped', 'run-demo']) {
      const s = series(`s-${run}-g1`, [fx('f1')], { seasonRunId: run } as Partial<Series>);
      delete (s as { leagueKey?: string }).leagueKey;
      await repo.putSeries(T, s);
    }
    const res = await app.request('/series', { headers: headers() });
    assert.equal(res.status, 200);
    const list = (await res.json()) as Array<{
      id: string;
      fixtures: Array<{ syncMapped?: true }>;
    }>;
    const mapped = (id: string) => list.find((s) => s.id === id)!.fixtures[0].syncMapped;
    assert.equal(mapped('s-run-mapped-g1'), true);
    assert.equal(mapped('s-run-demo-g1'), undefined);
    assert.equal(mapped(S1), true, 'a series with its own leagueKey is still mapped');

    // The outbox agrees: an edit on the season-run series is queued.
    await patchFixture('s-run-mapped-g1', 'f1', { time: '10:00' });
    await patchFixture('s-run-demo-g1', 'f1', { time: '10:00' });
    assert.deepEqual(
      (await repo.listPendingSync(T)).map((r) => r.ref),
      [REF('s-run-mapped-g1', 'f1')],
    );
  });
});

// ── Stage generate / rebase on synced released series ──
describe('Slice 4 — generate and rebase refuse to orphan synced refs', () => {
  const LEAGUE = 'gen-league';
  const CAL: SeasonCalendar = {
    id: 'cal-gen',
    label: '2026/27',
    blocks: [{ id: 'b1', label: 'Block 1', start: '2026-09-12', end: '2026-12-12' }],
  };
  const POOLS: StageSpec = {
    id: 'pools',
    name: 'Pool stage',
    format: { kind: 'round-robin', legs: 1 },
    entrants: { kind: 'seeded-split', groups: { kind: 'even', count: 1 }, method: 'snake' },
    schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
  };
  const RUN = 'run-sync';
  const SID = `s-${RUN}-pools-g1`;

  async function seedRun() {
    const cfg = (await repo.getTenantConfig(T))!;
    await repo.putTenantConfig({
      ...cfg,
      leagues: [
        {
          key: LEAGUE,
          label: 'Gen League',
          group: 'Men',
          district: 'All districts',
          setup: { structureId: 'st-gen', calendarId: 'cal-gen' },
        },
      ],
      calendars: [CAL],
      structures: [{ id: 'st-gen', name: 'Pools', version: 1, overs: 20, stages: [POOLS] }],
    } as TenantConfig);
    for (const id of ['g-a', 'g-b', 'g-c'])
      await repo.putClub(T, {
        id,
        name: `Club ${id}`,
        leagues: [LEAGUE],
        ground: { venue: `${id} Oval` },
        affiliation: 'complete',
      } as unknown as Club);
    await repo.putSeasonRun(T, {
      id: RUN,
      leagueKey: LEAGUE,
      seasonLabel: 'S',
      structureSnapshot: { id: 'st-gen', name: 'Pools', version: 1, overs: 20, stages: [POOLS] },
      calendarSnapshot: CAL,
      stages: [{ specId: 'pools', status: 'ready', groups: [] }],
      version: 1,
    } as unknown as SeasonRun);
    const res = await generate({ version: 1 });
    assert.equal(res.status, 200);
    // Release it, and re-pair f1 so a regenerate really orphans that ref.
    const s = (await repo.getSeries(T, SID))!;
    const fixtures = structuredClone(s.fixtures) as Array<Record<string, unknown>>;
    [fixtures[0].home, fixtures[0].away] = ['g-x', 'g-y'];
    await repo.putSeries(T, {
      ...s,
      fixtures,
      released: true,
      releasedAt: '2026-09-01T00:00:00.000Z',
      approved: true,
    });
  }
  const generate = (body: Record<string, unknown>) =>
    app.request(`/season-runs/${RUN}/stages/pools/generate`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });

  test('generate: 409 sync_resync_required naming the orphaned refs; allowResync proceeds and lists them', async () => {
    await seedRun();
    const run = (await repo.getSeasonRun(T, RUN))!;
    const refused = await generate({ version: run.version, confirmReleasedOverwrite: true });
    assert.equal(refused.status, 409);
    const err = (await refused.json()) as {
      code: string;
      seriesIds: string[];
      orphanedRefs: string[];
    };
    assert.equal(err.code, 'sync_resync_required');
    assert.deepEqual(err.seriesIds, [SID]);
    assert.deepEqual(err.orphanedRefs, [REF(SID, 'f1')]);
    assert.equal((await repo.getSeasonRun(T, RUN))!.version, run.version, 'nothing written');

    const ok = await generate({
      version: run.version,
      confirmReleasedOverwrite: true,
      allowResync: true,
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(((await ok.json()) as { orphanedRefs: string[] }).orphanedRefs, [
      REF(SID, 'f1'),
    ]);
  });

  test('rebase: 409 when the changed stage has synced released series; allowResync lists every ref', async () => {
    await seedRun();
    const run = (await repo.getSeasonRun(T, RUN))!;
    const cfg = (await repo.getTenantConfig(T))!;
    const changed = { ...POOLS, schedule: { ...POOLS.schedule, cadence: { kind: 'fortnightly' } } };
    await repo.putTenantConfig({
      ...cfg,
      structures: [{ id: 'st-gen', name: 'Pools', version: 2, overs: 20, stages: [changed] }],
    } as TenantConfig);
    const body = { structureId: 'st-gen', structureVersion: 2, version: run.version };
    const rebase = (b: Record<string, unknown>) =>
      app.request(`/season-runs/${RUN}/rebase`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(b),
      });
    const refused = await rebase(body);
    assert.equal(refused.status, 409);
    const err = (await refused.json()) as { code: string; orphanedRefs: string[] };
    assert.equal(err.code, 'sync_resync_required');
    const s = (await repo.getSeries(T, SID))!;
    const all = (s.fixtures as Array<{ id: string }>).map((f) => REF(SID, f.id));
    assert.deepEqual(err.orphanedRefs, all);

    const ok = await rebase({ ...body, allowResync: true });
    assert.equal(ok.status, 200);
    assert.deepEqual(((await ok.json()) as { orphanedRefs: string[] }).orphanedRefs, all);
  });
});
