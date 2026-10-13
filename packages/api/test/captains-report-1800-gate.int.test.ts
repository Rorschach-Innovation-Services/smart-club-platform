/**
 * The 18:00 SAST rule for captain's report notices, end to end against dynalite with the REAL
 * puller and sync run (a stub medicoach serves the shared contract example):
 *
 *  - before 18:00 a pulled result is stored, its REPORTOPEN# marker kept, nothing sent;
 *  - the first run at/after 18:00 drains the queue, one notice per report; re-runs send zero;
 *  - deferring is never an attempt, a cleared result sends nothing, a spent deadline leaves
 *    work queued, concurrent drains send once, reminders wait for 18:00 too;
 *  - REGRESSION (11 Oct 2026): a report whose notice went out by email only (WhatsApp
 *    skipped/failed) has a COMPLETED claim and gets zero sends on every later path.
 *
 * "now" is today's SAST date at a chosen hour; match dates follow the real clock (links valid).
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Series, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4717;
const TABLE = 'SmartClubReport1800Gate';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const SECRET = 'stub-shared-secret';
const EXAMPLES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docs/integrations/medicoach-sync-examples',
);
const example = (name: string) =>
  JSON.parse(readFileSync(path.join(EXAMPLES, `${name}.json`), 'utf8'));

const DAY = 24 * 3600 * 1000;
const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
/** Yesterday: always inside the 7-day window, so the link is live. */
const MATCH_DATE = isoDay(-1);
const GO_LIVE = isoDay(-30);
/** Fixtures nobody pulls a result for: dated outside the match-day opener's lookback, so the
 * 18:00 run does not open (and notify) them on its own. */
const BYSTANDER = { date: isoDay(-4) };
const CAPTAIN_KEY = '0'.repeat(64); // the example's captainRef natural key
const CAPTAIN_REF = `smartclub:dolphins:player:${CAPTAIN_KEY}`;

let ddb: Server;
let repo: typeof import('../src/repo.js');
let puller: typeof import('../src/medicoach-sync/puller.js');
let contract: typeof import('../src/medicoach-sync-contract.js');

// ── Stub medicoach ──
let stub: Server;
let stubUrl = '';
let page: unknown = null;

function startStub(): Promise<void> {
  stub = createServer((req, res) => {
    const check = contract.verifySignature({
      secret: SECRET,
      method: req.method ?? 'GET',
      pathAndQuery: req.url ?? '',
      body: '',
      timestampHeader: req.headers['x-sync-timestamp'] as string | undefined,
      signatureHeader: req.headers['x-sync-signature'] as string | undefined,
    });
    if (!check.ok) {
      res.writeHead(401).end('{"error":"bad signature"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(page));
  });
  return new Promise((resolve) =>
    stub.listen(0, '127.0.0.1', () => {
      stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

// ── Seed ──
const club = (id: string, chair: { name: string; email?: string; cell?: string }) =>
  ({
    id,
    name: id === 'umzinto' ? 'Umzinto CC' : id === 'african-warriors' ? 'African Warriors' : id,
    district: 'd',
    sub: '',
    chair: chair.name,
    exco: { chair },
    affiliation: 'complete',
    cqi: 0,
    docs: {},
    players: 0,
    teams: 1,
    women: 0,
    juniors: 0,
    color: '#000',
    ground: { venue: 'Ground' },
    leagues: ['premier'],
  }) as never;

const series = (id: string, leagueKey: string, teams: string[], fixtures: unknown[]): Series =>
  ({
    id,
    name: `${leagueKey} T20`,
    leagueKey,
    startDate: MATCH_DATE,
    teams,
    participants: teams.map((t) => ({
      teamId: t,
      clubId: t,
      name: t === 'umzinto' ? 'Umzinto CC' : t === 'african-warriors' ? 'African Warriors' : t,
      venue: 'Kingsmead Oval',
    })),
    fixtures,
    kind: 'series',
    approved: true,
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  }) as unknown as Series;

const fx = (id: string, home: string, away: string, over: Record<string, unknown> = {}) => ({
  id,
  round: 1,
  date: MATCH_DATE,
  time: '09:00',
  home,
  away,
  ...over,
});

async function seed(goLive: string | null = GO_LIVE) {
  await repo.putTenantConfig({
    tenant: 'dolphins',
    branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: { medicoachSync: true },
    ...(goLive ? { integrations: { medicoach: { goLiveDate: goLive } } } : {}),
  } as unknown as TenantConfig);
  await repo.createClub(
    'dolphins',
    club('umzinto', { name: 'Uma Chair', email: 'chair@umzinto.test', cell: '0821234567' }),
  );
  await repo.createClub(
    'dolphins',
    club('african-warriors', { name: 'Awa Chair', email: 'chair@aw.test' }),
  );
  await repo.createClub('dolphins', club('c', { name: 'C Chair', email: 'chair@c.test' }));
  await repo.createClub('dolphins', club('d', { name: 'D Chair', email: 'chair@d.test' }));
  await repo.putSeries(
    'dolphins',
    series(
      's-planb-premier-men-t20-g1',
      'premier',
      ['umzinto', 'african-warriors'],
      [fx('f3', 'umzinto', 'african-warriors', { venueName: 'Kingsmead Oval' })],
    ),
  );
  await repo.putSeries(
    'dolphins',
    series(
      's-planb-promotion-men-t20-g2',
      'promotion',
      ['c', 'd'],
      [fx('f7', 'c', 'd', BYSTANDER)],
    ),
  );
  await repo.putSeries(
    'dolphins',
    series('s-planb-premier-men-t20-g2', 'premier', ['c', 'd'], [fx('f1', 'c', 'd', BYSTANDER)]),
  );
  await repo.createUmpire('dolphins', {
    id: 'u-ngubane',
    displayName: 'A.Ngubane',
    aliases: ['angubane'],
    active: true,
  });
  await repo.createUmpire('dolphins', {
    id: 'u-dlamini',
    displayName: 'S.Dlamini',
    aliases: ['sdlamini'],
    active: true,
  });
  await repo.putFixtureOfficials('dolphins', 's-planb-premier-men-t20-g1', 'f3', {
    umpires: [
      { umpireId: 'u-ngubane', name: 'A.Ngubane' },
      { umpireId: 'u-dlamini', name: 'S.Dlamini' },
    ],
  });
}

async function seedCaptain(over: Record<string, unknown> = {}) {
  await repo.createPlayer('dolphins', {
    naturalKey: CAPTAIN_KEY,
    clubId: 'umzinto',
    firstName: 'Sanele',
    lastName: 'Mthembu',
    email: 'captain@umzinto.test',
    cell: '0831234567',
    isMinor: false,
    ...over,
  } as never);
}

// ── Running the puller with a capturing sender ──
type Notice = import('../src/captains-reports.js').ReportNotice;
const notices: Notice[] = [];
const logLines: string[] = [];

const liveResultPage = (source: 'live' | 'manual' | 'import' = 'live') => {
  const p = example('changes-live-result');
  p.fixtures[0].result.source = source;
  return p;
};

const reportsOf = async () =>
  (await repo.listCaptainsReports('dolphins')).sort((a, b) => a.id.localeCompare(b.id));

/** How many stored items (any partition) contain `needle` anywhere. */
async function tableItemsContaining(needle: string): Promise<number> {
  const { DynamoDBClient, ScanCommand } = await import('@aws-sdk/client-dynamodb');
  const c = new DynamoDBClient({
    endpoint: process.env.DYNAMO_ENDPOINT,
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const items = (await c.send(new ScanCommand({ TableName: TABLE }))).Items ?? [];
  return items.filter((i) => JSON.stringify(i).includes(needle)).length;
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

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  repo = await import('../src/repo.js');
  puller = await import('../src/medicoach-sync/puller.js');
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
  notices.length = 0;
  logLines.length = 0;
  page = null;
  outcome = () => 'sent';
});

const HOUR = 3600 * 1000;
/** Today's SAST date at hh:mm:ss SAST, as a UTC instant. */
const sastToday = (h: number, m = 0, s = 0) => {
  const day = new Date(Date.now() + 2 * HOUR).toISOString().slice(0, 10);
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - 2 * HOUR + ((h * 60 + m) * 60 + s) * 1000);
};
const AT_1400 = sastToday(14);
const AT_1800 = sastToday(18);
const LIVE_REF = 'smartclub:dolphins:fixture:s-planb-premier-men-t20-g1:f3';

/** Capture every notice; `outcome` decides each channel's status (default: all sent). */
type Outcome = (n: Notice, channel: 'email' | 'whatsapp') => 'sent' | 'failed' | 'skipped';
let outcome: Outcome = () => 'sent';
const sendNotice = async (n: Notice) => {
  notices.push(n);
  return n.channels.map((channel) => ({ channel, status: outcome(n, channel) }));
};
const reportDeps = () => ({ log: (l: string) => logLines.push(l), sendNotice });

const pullAt = (at: Date, extra: { deadlineMs?: number } = {}) =>
  puller.runMedicoachSync('dolphins', 'cron', {
    repo,
    url: stubUrl,
    secret: SECRET,
    now: () => at,
    log: (l) => logLines.push(l),
    captainsReports: reportDeps(),
    ...extra,
  });

const retryAt = async (at: Date, extra: { deadlineMs?: number } = {}) =>
  (await import('../src/captains-reports.js')).retryPendingReportOpens('dolphins', {
    repo,
    now: () => at,
    ...reportDeps(),
    ...extra,
  });

const remindAt = async (at: Date) =>
  (await import('../src/captains-reports.js')).sendReportReminders('dolphins', {
    repo,
    now: () => at,
    ...reportDeps(),
  });

/** The full sync run ("Sync now" = manual) at `at`. */
const syncNowAt = async (at: Date) =>
  (await import('../src/medicoach-sync/run.js')).runTenantSync('dolphins', 'manual', {
    repo,
    url: stubUrl,
    secret: SECRET,
    now: () => at,
    log: (l) => logLines.push(l),
    captainsReports: reportDeps(),
    opsDigestCell: () => null,
  });

describe('isReportNoticeWindowOpen', () => {
  test('17:59:59 SAST is closed, 18:00:00 is open, open to midnight, closed after', async () => {
    const { isReportNoticeWindowOpen, REPORT_NOTICE_HOUR } =
      await import('../src/captains-reports.js');
    assert.equal(REPORT_NOTICE_HOUR, 18);
    assert.equal(isReportNoticeWindowOpen(new Date('2026-10-11T15:59:59.999Z')), false);
    assert.equal(isReportNoticeWindowOpen(new Date('2026-10-11T16:00:00.000Z')), true);
    assert.equal(isReportNoticeWindowOpen(new Date('2026-10-11T21:59:59.999Z')), true);
    assert.equal(isReportNoticeWindowOpen(new Date('2026-10-11T22:00:00.000Z')), false); // 00:00
    assert.equal(isReportNoticeWindowOpen(new Date('2026-10-12T06:00:00.000Z')), false); // 08:00
    assert.equal(isReportNoticeWindowOpen(sastToday(17, 59, 59)), false);
    assert.equal(isReportNoticeWindowOpen(sastToday(18)), true);
  });
});

describe('the 18:00 SAST gate', () => {
  test('a 14:00 pull stores the result and keeps the marker with zero sends; 18:00 sends once; a re-run sends zero', async () => {
    await seedCaptain();
    page = liveResultPage('live');
    const early = await pullAt(AT_1400);
    assert.equal(early.status, 'ok');
    assert.equal(early.counts.resultsStored, 1);
    assert.equal(early.reportsDeferred, 1);
    assert.equal(notices.length, 0);
    assert.deepEqual(await reportsOf(), [], 'no report opened before 18:00');
    const [marker] = await repo.listReportOpenMarkers('dolphins');
    assert.equal(marker.ref, LIVE_REF);
    assert.equal(marker.attempts, 0, 'a deferral is not an attempt');
    assert.equal(marker.captainRef, CAPTAIN_REF, 'the captain is still addressable at 18:00');

    // The 18:00 run (same page replayed: nothing new pulled) drains the queue.
    const run = await syncNowAt(AT_1800);
    assert.equal(run.reports?.done, 1);
    assert.equal(run.reportsMessage, undefined);
    assert.deepEqual(run.reportNotices, { deferred: 0, opened: 2, notified: 2, failed: 0 });
    assert.equal(notices.length, 2, 'exactly one notice per report');
    assert.deepEqual(notices.map((n) => n.recipientKind).sort(), ['captain', 'chair']);
    assert.deepEqual(await repo.listReportOpenMarkers('dolphins'), []);
    assert.equal(await tableItemsContaining(CAPTAIN_REF), 0);

    await syncNowAt(sastToday(18, 15));
    await syncNowAt(sastToday(21));
    assert.equal(notices.length, 2, 'a re-run sends zero');
  });

  test('a result pulled after 18:00 sends immediately', async () => {
    page = liveResultPage('live');
    const s = await pullAt(sastToday(19, 30));
    assert.equal(s.reportsDeferred, undefined);
    assert.equal(notices.length, 2);
    assert.deepEqual(await repo.listReportOpenMarkers('dolphins'), []);
  });

  test('"Sync now" before 18:00 says the reports are queued, and sends nothing', async () => {
    page = liveResultPage('live');
    const run = await syncNowAt(AT_1400);
    const { REPORTS_QUEUED_MESSAGE } = await import('../src/medicoach-sync/run.js');
    assert.equal(run.reportsMessage, REPORTS_QUEUED_MESSAGE);
    assert.match(String(run.reportsMessage), /queued.*18:00/);
    assert.equal(run.reportNotices?.deferred, 1, 'one queued report, counted once (not per pass)');
    assert.equal(run.reports?.deferred, 1);
    assert.equal(notices.length, 0);
    assert.equal((await repo.listReportOpenMarkers('dolphins')).length, 1);
  });

  test('deferring many times never reaches the attempt limit', async () => {
    page = liveResultPage('live');
    await pullAt(AT_1400);
    const { REPORT_OPEN_MAX_ATTEMPTS } = await import('../src/captains-reports.js');
    for (let i = 0; i < REPORT_OPEN_MAX_ATTEMPTS * 3; i++) {
      const r = await retryAt(sastToday(8 + (i % 10), i));
      assert.deepEqual(r, { retried: 0, done: 0, failed: 0, gaveUp: 0, deferred: 1 });
    }
    await syncNowAt(sastToday(17, 45));
    const [marker] = await repo.listReportOpenMarkers('dolphins');
    assert.equal(marker.attempts, 0);
    assert.equal(notices.length, 0);
    const r = await retryAt(AT_1800);
    assert.equal(r.done, 1);
    assert.equal(notices.length, 2);
  });

  test('a result cleared before 18:00 sends no notice', async () => {
    page = liveResultPage('live');
    await pullAt(AT_1400);
    await repo.putFixtureResultIfNewer('dolphins', {
      seriesId: 's-planb-premier-men-t20-g1',
      fixtureId: 'f3',
      ref: LIVE_REF,
      orderAt: '2099-01-01T00:00:00.000Z',
      cleared: true,
      clearedAt: '2099-01-01T00:00:00.000Z',
      storedAt: new Date().toISOString(),
    });
    const r = await retryAt(AT_1800);
    assert.equal(r.retried, 0);
    assert.equal(notices.length, 0);
    assert.deepEqual(await repo.listReportOpenMarkers('dolphins'), []);
    assert.deepEqual(await reportsOf(), []);
  });

  test('when the deadline is spent, leftovers stay queued and send on the next run, once each', async () => {
    page = liveResultPage('live');
    // A pull at 18:00 already out of time: stored, deferred, marker kept.
    const s = await pullAt(AT_1800, { deadlineMs: Date.now() - 1 });
    assert.equal(s.reportsDeferred, 1);
    assert.equal(notices.length, 0);
    // The drain out of time too: untouched, not an attempt.
    const r1 = await retryAt(AT_1800, { deadlineMs: Date.now() - 1 });
    assert.deepEqual(r1, { retried: 0, done: 0, failed: 0, gaveUp: 0, deferred: 1 });
    const [marker] = await repo.listReportOpenMarkers('dolphins');
    assert.equal(marker.attempts, 0);
    // The next run has time: one notice per report.
    const r2 = await retryAt(sastToday(18, 15), { deadlineMs: Date.now() + 60_000 });
    assert.equal(r2.done, 1);
    assert.equal(notices.length, 2);
    await retryAt(sastToday(18, 30));
    await pullAt(sastToday(18, 30));
    assert.equal(notices.length, 2);
  });

  test('a deadline that runs out mid-opening keeps the marker; the next run notifies without re-opening', async () => {
    page = liveResultPage('live');
    await pullAt(AT_1400);
    // The deadline passes after the first notice: the second side is opened but not claimed.
    let deadline = Date.now() + 60_000;
    const { retryPendingReportOpens } = await import('../src/captains-reports.js');
    const deps = {
      repo,
      now: () => AT_1800,
      log: () => {},
      sendNotice: async (n: Notice) => {
        deadline = Date.now() - 1;
        return sendNotice(n);
      },
      get deadlineMs() {
        return deadline;
      },
    };
    const r1 = await retryPendingReportOpens('dolphins', deps);
    assert.equal(r1.deferred, 1);
    assert.equal(notices.length, 1);
    assert.equal((await repo.listReportOpenMarkers('dolphins')).length, 1);
    assert.equal((await reportsOf()).length, 2);
    const r2 = await retryAt(sastToday(18, 15));
    assert.equal(r2.done, 1);
    assert.equal(notices.length, 2);
    assert.equal(new Set(notices.map((n) => n.reportId)).size, 2, 'each report notified once');
    await retryAt(sastToday(18, 30));
    assert.equal(notices.length, 2);
  });

  test('two concurrent drains send each notice once', async () => {
    await seedCaptain();
    page = liveResultPage('live');
    await pullAt(AT_1400);
    await Promise.all([retryAt(AT_1800), retryAt(AT_1800), retryAt(AT_1800)]);
    assert.equal(notices.length, 2);
    assert.equal(new Set(notices.map((n) => n.reportId)).size, 2);
    assert.deepEqual(await repo.listReportOpenMarkers('dolphins'), []);
  });

  test('a notice that failed on every channel is delivered exactly once in total', async () => {
    page = liveResultPage('live');
    outcome = () => 'failed';
    await pullAt(AT_1800);
    assert.equal(notices.length, 2, 'both tried, both failed (claims released)');
    assert.equal((await repo.listReportOpenMarkers('dolphins')).length, 1);
    outcome = () => 'sent';
    await retryAt(sastToday(18, 15));
    await retryAt(sastToday(18, 30));
    await syncNowAt(sastToday(19));
    const delivered = notices.slice(2);
    assert.equal(delivered.length, 2, 'one delivered notice per report, in total');
    assert.equal(new Set(delivered.map((n) => n.reportId)).size, 2);
  });

  test('reminders: none before 18:00; one after; never a second', async () => {
    page = liveResultPage('live');
    await pullAt(AT_1800);
    assert.equal(notices.length, 2);
    const [r] = await reportsOf();
    const { reportExpirySeconds, isReportNoticeWindowOpen } =
      await import('../src/captains-reports.js');
    const expiryMs = reportExpirySeconds(r) * 1000; // 23:59:59 SAST on the last day
    const dueClosed = new Date(expiryMs - 24 * HOUR - 7 * HOUR); // 16:59:59 SAST, inside lead
    const dueOpen = new Date(expiryMs - 24 * HOUR - 6 * HOUR + 1000); // 18:00:00 SAST
    assert.equal(isReportNoticeWindowOpen(dueClosed), false);
    assert.equal(isReportNoticeWindowOpen(dueOpen), true);

    const before18 = await remindAt(dueClosed);
    assert.deepEqual(before18, { due: 0, sent: 0, undelivered: 0 });
    assert.equal(notices.length, 2);
    const at18 = await remindAt(dueOpen);
    assert.equal(at18.sent, 2);
    assert.equal(notices.filter((n) => n.reminder).length, 2);
    await remindAt(new Date(dueOpen.getTime() + HOUR));
    assert.equal(notices.filter((n) => n.reminder).length, 2, 'at most one reminder each');
  });
});

describe('never sent twice: the email-only report (regression, 11 Oct 2026)', () => {
  test('a claim completed with email sent and WhatsApp skipped/failed gets ZERO sends on every later path', async () => {
    await seedCaptain();
    page = liveResultPage('live');
    // Today's case: email delivered, WhatsApp unavailable (skipped on one side, failed on the
    // other). The notice counts as delivered and its claim completes.
    outcome = (n, channel) =>
      channel === 'email' ? 'sent' : n.recipientKind === 'captain' ? 'skipped' : 'failed';
    await pullAt(AT_1800);
    assert.equal(notices.length, 2);
    const reports = await reportsOf();
    assert.ok(
      reports.every((r) => r.notifiedAt),
      'email counts as delivered',
    );
    assert.deepEqual(await repo.listReportOpenMarkers('dolphins'), []);
    for (const r of reports) {
      const claim = await repo.getCaptainsReportNotify(
        'dolphins',
        r.id,
        `recipient#${r.recipient.memberId}`,
      );
      assert.equal(claim?.status, 'completed');
    }

    // From here on WhatsApp works: nothing may top it up.
    outcome = () => 'sent';
    notices.length = 0;

    // 1. The drain — even with a marker put back by hand (nothing in the code re-queues).
    await repo.putReportOpenMarker('dolphins', {
      ref: LIVE_REF,
      seriesId: 's-planb-premier-men-t20-g1',
      fixtureId: 'f3',
      recordedAt: (await repo.getFixtureResult('dolphins', 's-planb-premier-men-t20-g1', 'f3'))!
        .recordedAt!,
      createdAt: AT_1800.toISOString(),
      attempts: 0,
      captainRef: CAPTAIN_REF,
    });
    const drained = await retryAt(sastToday(19));
    assert.equal(drained.done, 1);
    assert.deepEqual(await repo.listReportOpenMarkers('dolphins'), []);
    // 2. "Sync now" and the cron pull (replayed page) after 18:00.
    await syncNowAt(sastToday(20));
    await pullAt(sastToday(21));
    // 3. Reminders when not yet due, and another evening's drain.
    await remindAt(sastToday(22));
    await retryAt(new Date(sastToday(18).getTime() + 24 * HOUR));
    assert.equal(notices.length, 0, 'zero sends on every later path');
    const after = await reportsOf();
    assert.deepEqual(
      after.map((r) => r.deliveries?.length),
      reports.map((r) => r.deliveries?.length),
      'no new delivery recorded',
    );
  });
});

describe('markReportOpenFailed on a marker already gone', () => {
  test('returns 0 and writes nothing (no resurrected attempts row)', async () => {
    const n = await repo.markReportOpenFailed('dolphins', LIVE_REF, 'boom', AT_1800.toISOString());
    assert.equal(n, 0);
    assert.deepEqual(await repo.listReportOpenMarkers('dolphins'), []);
  });
});
