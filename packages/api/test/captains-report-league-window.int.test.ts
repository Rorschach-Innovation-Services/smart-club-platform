/**
 * Per-league captain's report notice timing (`League.captainsReport`), end to end against
 * dynalite with the REAL puller, retry, match-day opener and reminders.
 *
 * Dolphins' premier league defers its match-day notices to the CSA-scraped result (landing
 * ~04:30 Monday) and may notify from 04:00 SAST; every other league keeps 18:00 exactly:
 *
 *  - the result-hook path notifies a premier result at 04:45, a no-override tenant does not;
 *  - a mixed REPORTOPEN# batch at 05:00 drains ONLY the premier marker;
 *  - the match-day opener holds premier fixtures for their result, and opens them card-less
 *    only past the following Monday 12:00 SAST with still no stored result;
 *  - reminders follow each report's league window;
 *  - a tenant with no override keeps the old early returns byte-identical.
 *
 * Every date is fixed (Sat 24 / Sun 25 / Mon 26 Oct 2026) and every call passes `now`.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { League, Series, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4761;
const TABLE = 'SmartClubReportLeagueWindow';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const SECRET = 'stub-shared-secret';
const EXAMPLES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docs/integrations/medicoach-sync-examples',
);
const example = (name: string) =>
  JSON.parse(readFileSync(path.join(EXAMPLES, `${name}.json`), 'utf8'));

const SAT = '2026-10-24';
const SUN = '2026-10-25';
const MON = '2026-10-26';
const HOUR = 3600 * 1000;
/** `day` at hh:mm SAST, as a UTC instant. */
const at = (day: string, h: number, m = 0) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) - 2 * HOUR + (h * 60 + m) * 60_000);

const PREMIER = 's-planb-premier-men-t20-g1';
const PROMO = 's-promotion-run-g1';
const PREMIER_REF = `smartclub:dolphins:fixture:${PREMIER}:f3`;
const PROMO_REF = `smartclub:dolphins:fixture:${PROMO}:f7`;

let ddb: Server;
let repo: typeof import('../src/repo.js');
let puller: typeof import('../src/medicoach-sync/puller.js');
let contract: typeof import('../src/medicoach-sync-contract.js');
let reports: typeof import('../src/captains-reports.js');

// ── Stub medicoach (serves `page`) ──
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
const club = (id: string, email: string) =>
  ({
    id,
    name: id,
    district: 'd',
    sub: '',
    chair: `${id} chair`,
    exco: { chair: { name: `${id} chair`, email } },
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

const series = (
  id: string,
  teams: string[],
  fixtures: unknown[],
  link: { leagueKey: string } | { seasonRunId: string },
): Series =>
  ({
    id,
    name: `${id} T20`,
    ...link,
    startDate: SAT,
    teams,
    participants: teams.map((t) => ({ teamId: t, clubId: t, name: t, venue: 'Oval' })),
    fixtures,
    kind: 'series',
    approved: true,
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  }) as unknown as Series;

const fx = (id: string, home: string, away: string, date = SAT) => ({
  id,
  round: 1,
  date,
  time: '10:00',
  home,
  away,
});

const PREMIER_LEAGUE: League = {
  key: 'premier',
  label: 'Premier League',
  group: 'Overarching Leagues',
  district: 'All districts',
  captainsReport: { deferMatchDayNotices: true, noticeFromHour: 4 },
};
const PROMO_LEAGUE: League = {
  key: 'promotion',
  label: 'Promotion League',
  group: 'Overarching Leagues',
  district: 'All districts',
};

async function seed(overrides = true) {
  const premier = overrides ? PREMIER_LEAGUE : { ...PREMIER_LEAGUE, captainsReport: undefined };
  await repo.putTenantConfig({
    tenant: 'dolphins',
    branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: { medicoachSync: true },
    integrations: { medicoach: { goLiveDate: '2026-09-01' } },
    leagues: [premier, PROMO_LEAGUE],
  } as unknown as TenantConfig);
  for (const id of ['umzinto', 'african-warriors', 'c', 'd'])
    await repo.createClub('dolphins', club(id, `chair@${id}.test`));
  // Premier: a plan-B series carrying its own leagueKey.
  await repo.putSeries(
    'dolphins',
    series(PREMIER, ['umzinto', 'african-warriors'], [fx('f3', 'umzinto', 'african-warriors')], {
      leagueKey: 'premier',
    }),
  );
  // Promotion: a season-run series (no leagueKey of its own — resolved through the run).
  await repo.putSeasonRun('dolphins', {
    id: 'run-promo',
    leagueKey: 'promotion',
    seasonLabel: '2026/27',
    stages: [],
    structureSnapshot: {},
    calendarSnapshot: {},
    version: 1,
  } as never);
  await repo.putSeries(
    'dolphins',
    series(PROMO, ['c', 'd'], [fx('f7', 'c', 'd')], { seasonRunId: 'run-promo' }),
  );
}

async function storeResult(seriesId: string, fixtureId: string, ref: string, marker: boolean) {
  const recordedAt = '2026-10-25T23:00:00.000Z';
  await repo.putFixtureResultIfNewer('dolphins', {
    seriesId,
    fixtureId,
    ref,
    orderAt: recordedAt,
    recordedAt,
    homeScore: '200/5',
    awayScore: '150/9',
    summary: 'Home won by 50 runs',
    winner: 'home',
    method: 'normal',
    resultSource: 'live',
    scoringSide: 'home',
    storedAt: recordedAt,
  } as never);
  if (marker)
    await repo.putReportOpenMarker('dolphins', {
      ref,
      seriesId,
      fixtureId,
      recordedAt,
      createdAt: recordedAt,
      attempts: 0,
    });
}

// ── Capturing sender ──
type Notice = import('../src/captains-reports.js').ReportNotice;
const notices: Notice[] = [];
const sendNotice = async (n: Notice) => {
  notices.push(n);
  return n.channels.map((channel) => ({ channel, status: 'sent' as const }));
};
const deps = (now: Date) => ({ repo, now: () => now, log: () => {}, sendNotice });
const seriesOfNotices = () => [...new Set(notices.map((n) => n.reportId.split('~')[0]))].sort();

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
  reports = await import('../src/captains-reports.js');
  reports.setReportNoticeWindowOverride(undefined); // the real clock rule; tests pass `now`
  await startStub();
});

after(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
  await stopDynalite(ddb);
});

beforeEach(async () => {
  await resetTable();
  notices.length = 0;
  page = null;
});

const config = async () => (await repo.getTenantConfig('dolphins'))!;
const matchDayAt = async (now: Date) =>
  reports.openMatchDayReports('dolphins', await config(), deps(now));

describe('reportNoticeWindowOpenFor (pure)', () => {
  test('no league / no override is exactly the 18:00 rule; noticeFromHour moves the start', () => {
    const { isReportNoticeWindowOpen, reportNoticeWindowOpenFor, isReportNoticeWindowOpenFor } =
      reports;
    for (const h of [0, 3, 4, 12, 17, 18, 23]) {
      const t = at(MON, h, 30);
      assert.equal(isReportNoticeWindowOpenFor(t), isReportNoticeWindowOpen(t));
      assert.equal(isReportNoticeWindowOpenFor(t, PROMO_LEAGUE), isReportNoticeWindowOpen(t));
      assert.equal(reportNoticeWindowOpenFor(t, PROMO_LEAGUE), isReportNoticeWindowOpen(t));
    }
    assert.equal(isReportNoticeWindowOpenFor(at(MON, 3, 59), PREMIER_LEAGUE), false);
    assert.equal(isReportNoticeWindowOpenFor(at(MON, 4), PREMIER_LEAGUE), true);
    assert.equal(isReportNoticeWindowOpenFor(at(MON, 23, 59), PREMIER_LEAGUE), true);
    reports.setReportNoticeWindowOverride(() => false);
    try {
      assert.equal(reportNoticeWindowOpenFor(at(MON, 12), PREMIER_LEAGUE), false, 'override wins');
    } finally {
      reports.setReportNoticeWindowOverride(undefined);
    }
  });

  test('the deferred fallback is the following Monday 12:00 SAST', () => {
    assert.equal(reports.deferredFallbackAt(SAT), at(MON, 12).getTime());
    assert.equal(reports.deferredFallbackAt(SUN), at(MON, 12).getTime());
    assert.equal(reports.deferredFallbackAt(MON), at('2026-11-02', 12).getTime());
  });
});

describe('the result-hook path', () => {
  test('a premier result pulled at 04:45 Monday opens and notifies at once', async () => {
    await seed();
    page = example('changes-live-result');
    const s = await puller.runMedicoachSync('dolphins', 'cron', {
      repo,
      url: stubUrl,
      secret: SECRET,
      now: () => at(MON, 4, 45),
      log: () => {},
      captainsReports: { log: () => {}, sendNotice },
    });
    assert.equal(s.counts.resultsStored, 1);
    assert.equal(s.reportsDeferred, undefined);
    assert.equal(notices.length, 2);
    assert.deepEqual(seriesOfNotices(), [PREMIER]);
    assert.deepEqual(await repo.listReportOpenMarkers('dolphins'), []);
  });

  test('without the override the same 04:45 pull is deferred to 18:00 (default unchanged)', async () => {
    await seed(false);
    page = example('changes-live-result');
    const s = await puller.runMedicoachSync('dolphins', 'cron', {
      repo,
      url: stubUrl,
      secret: SECRET,
      now: () => at(MON, 4, 45),
      log: () => {},
      captainsReports: { log: () => {}, sendNotice },
    });
    assert.equal(s.reportsDeferred, 1);
    assert.equal(notices.length, 0);
    assert.equal((await repo.listReportOpenMarkers('dolphins')).length, 1);
  });
});

describe('retryPendingReportOpens', () => {
  test('a mixed batch at 05:00 drains only the premier marker; 18:00 drains the rest', async () => {
    await seed();
    await storeResult(PREMIER, 'f3', PREMIER_REF, true);
    await storeResult(PROMO, 'f7', PROMO_REF, true);

    const early = await reports.retryPendingReportOpens('dolphins', deps(at(MON, 5)));
    assert.deepEqual(early, { retried: 1, done: 1, failed: 0, gaveUp: 0, deferred: 1 });
    assert.deepEqual(seriesOfNotices(), [PREMIER]);
    const left = await repo.listReportOpenMarkers('dolphins');
    assert.deepEqual(
      left.map((m) => [m.ref, m.attempts]),
      [[PROMO_REF, 0]],
      'the other league keeps its marker untouched (a deferral is not an attempt)',
    );

    notices.length = 0;
    const evening = await reports.retryPendingReportOpens('dolphins', deps(at(MON, 18)));
    assert.equal(evening.done, 1);
    assert.deepEqual(seriesOfNotices(), [PROMO]);
    assert.deepEqual(await repo.listReportOpenMarkers('dolphins'), []);
  });

  test('without any override a closed window returns at once, every marker deferred', async () => {
    await seed(false);
    await storeResult(PREMIER, 'f3', PREMIER_REF, true);
    await storeResult(PROMO, 'f7', PROMO_REF, true);
    const r = await reports.retryPendingReportOpens('dolphins', deps(at(MON, 5)));
    assert.deepEqual(r, { retried: 0, done: 0, failed: 0, gaveUp: 0, deferred: 2 });
    assert.equal(notices.length, 0);
  });
});

describe('openMatchDayReports', () => {
  test('premier is held for its result; promotion opens card-less at 18:00 as before', async () => {
    await seed();
    const satEvening = await matchDayAt(at(SAT, 18, 30));
    assert.equal(satEvening.opened, 2);
    assert.equal(satEvening.held, 1);
    assert.deepEqual(seriesOfNotices(), [PROMO]);

    notices.length = 0;
    // Sunday evening and Monday early (premier's window is open, the fallback is not due).
    for (const t of [at(SUN, 18, 30), at(MON, 5), at(MON, 11, 59)]) await matchDayAt(t);
    assert.equal(notices.length, 0);
    const premierReports = (await repo.listCaptainsReports('dolphins')).filter(
      (r) => r.seriesId === PREMIER,
    );
    assert.deepEqual(premierReports, []);
  });

  test('past Monday 12:00 a premier fixture with no stored result opens card-less', async () => {
    await seed();
    const s = await matchDayAt(at(MON, 12, 15));
    assert.equal(s.opened, 2);
    assert.deepEqual(seriesOfNotices(), [PREMIER]);
    const opened = (await repo.listCaptainsReports('dolphins')).filter(
      (r) => r.seriesId === PREMIER,
    );
    assert.equal(opened.length, 2);
    for (const r of opened) {
      assert.equal(r.resultSummary, null, 'card-less');
      assert.equal(r.recipient.kind, 'chair');
    }
    notices.length = 0;
    await matchDayAt(at(MON, 12, 30));
    assert.equal(notices.length, 0, 'a re-run sends nothing');
  });

  test('past Monday 12:00 a premier fixture WITH a stored result is left to the result path', async () => {
    await seed();
    await storeResult(PREMIER, 'f3', PREMIER_REF, false);
    const s = await matchDayAt(at(MON, 12, 15));
    assert.equal(s.opened, 0);
    assert.equal(notices.length, 0);
  });

  test('without any override a closed window returns the old shape without reading', async () => {
    await seed(false);
    const s = await matchDayAt(at(SAT, 14));
    assert.deepEqual(s, {
      fixtures: 0,
      opened: 0,
      notified: 0,
      failed: 0,
      deferred: 0,
      skipped: 0,
      windowClosed: true,
    });
    const evening = await matchDayAt(at(SAT, 18, 30));
    assert.equal(evening.opened, 4, 'both leagues open card-less at 18:00 as before');
    assert.equal('held' in evening, false);
  });
});

describe('sendReportReminders', () => {
  test('each report is reminded inside its own league window', async () => {
    await seed();
    await storeResult(PREMIER, 'f3', PREMIER_REF, true);
    await storeResult(PROMO, 'f7', PROMO_REF, true);
    await reports.retryPendingReportOpens('dolphins', deps(at(SAT, 18, 30)));
    assert.equal(notices.length, 4);
    // Links expire at the end of 31 Oct (match + 7); reminders are due from 29 Oct 23:59:59.
    notices.length = 0;
    const early = await reports.sendReportReminders('dolphins', deps(at('2026-10-30', 5)));
    assert.equal(early.sent, 2);
    assert.deepEqual(seriesOfNotices(), [PREMIER]);
    notices.length = 0;
    const evening = await reports.sendReportReminders('dolphins', deps(at('2026-10-30', 18)));
    assert.equal(evening.sent, 2);
    assert.deepEqual(seriesOfNotices(), [PROMO]);
  });

  test('without any override nothing is read or sent before 18:00', async () => {
    await seed(false);
    await storeResult(PREMIER, 'f3', PREMIER_REF, true);
    await reports.retryPendingReportOpens('dolphins', deps(at(SAT, 18, 30)));
    notices.length = 0;
    const early = await reports.sendReportReminders('dolphins', deps(at('2026-10-30', 5)));
    assert.deepEqual(early, { due: 0, sent: 0, undelivered: 0 });
    assert.equal(notices.length, 0);
  });
});

describe('read discipline and resolution', () => {
  /** `repo` with every call counted by name. */
  const counting = () => {
    const calls: string[] = [];
    const proxy = new Proxy(repo, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as typeof repo;
    return { proxy, calls };
  };

  test('no override + closed window: the sync-run paths read nothing beyond the old reads', async () => {
    await seed(false);
    await storeResult(PREMIER, 'f3', PREMIER_REF, true);
    const cfg = await config();
    const t = at(MON, 5);
    const { proxy, calls } = counting();
    const d = { ...deps(t), repo: proxy };
    const retry = await reports.retryPendingReportOpens('dolphins', d, { config: cfg });
    assert.equal(retry.deferred, 1);
    assert.deepEqual(calls, ['listReportOpenMarkers'], 'retry: only the marker list, as before');
    calls.length = 0;
    assert.deepEqual(await reports.sendReportReminders('dolphins', d, { config: cfg }), {
      due: 0,
      sent: 0,
      undelivered: 0,
    });
    assert.deepEqual(calls, [], 'reminders: nothing read');
    const md = await reports.openMatchDayReports('dolphins', cfg, d);
    assert.equal(md.windowClosed, true);
    assert.deepEqual(calls, [], 'match-day: nothing read');
  });

  test('a deferred league resolved through its season run (no series leagueKey) drains early', async () => {
    await seed();
    await repo.putSeasonRun('dolphins', {
      id: 'run-premier',
      leagueKey: 'premier',
      seasonLabel: '2026/27',
      stages: [],
      structureSnapshot: {},
      calendarSnapshot: {},
      version: 1,
    } as never);
    await repo.putSeries(
      'dolphins',
      series(PREMIER, ['umzinto', 'african-warriors'], [fx('f3', 'umzinto', 'african-warriors')], {
        seasonRunId: 'run-premier',
      }),
    );
    await storeResult(PREMIER, 'f3', PREMIER_REF, true);
    await storeResult(PROMO, 'f7', PROMO_REF, true);
    const r = await reports.retryPendingReportOpens('dolphins', deps(at(MON, 5)));
    assert.deepEqual([r.done, r.deferred], [1, 1]);
    assert.deepEqual(seriesOfNotices(), [PREMIER]);
  });

  test('a failed league lookup falls back to the default window instead of throwing', async () => {
    await seed();
    await storeResult(PREMIER, 'f3', PREMIER_REF, true);
    const broken = new Proxy(repo, {
      get(target, prop, recv) {
        if (prop === 'getSeries') return async () => Promise.reject(new Error('ddb blip'));
        return Reflect.get(target, prop, recv);
      },
    }) as typeof repo;
    const r = await reports.retryPendingReportOpens('dolphins', {
      ...deps(at(MON, 5)),
      repo: broken,
    });
    assert.deepEqual([r.done, r.deferred], [0, 1], 'held for 18:00, loop not aborted');
  });
});
