/**
 * Match-day opening of captain's reports (`openMatchDayReports`) against dynalite with the REAL
 * repo: at/after 18:00 SAST every fixture played today (or yesterday — the lookback) opens its
 * two reports to the CHAIRS, result or not; a later result fills the summary in silently.
 *
 *  - idempotent (open-if-absent + NOTIFY# ledger): a re-run sends nothing;
 *  - skips: dateTbc, cancelled, slot refs, unreleased series, pre-go-live, a shut window (no
 *    enumeration at all), a spent deadline (the rest waits for the next run);
 *  - a side with ANY report row is left alone — a portal-filed report, and a VOID one (the
 *    opener must never resurrect a report withdrawn by a cleared result);
 *  - inside `runTenantSync` its counts live under `matchDay`, never in `reportNotices`, and a
 *    result pulled in the same run keeps its captain recipient.
 *
 * "now" is today's SAST date at a chosen hour; match dates are SAST days relative to it.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaptainsReport, Series, TenantConfig } from '../src/types.js';
import type { SyncResult } from '../src/medicoach-sync-contract.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4721;
const TABLE = 'SmartClubReportMatchDay';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const SECRET = 'stub-shared-secret';
const EXAMPLES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docs/integrations/medicoach-sync-examples',
);
const example = (name: string) =>
  JSON.parse(readFileSync(path.join(EXAMPLES, `${name}.json`), 'utf8'));

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
/** Today's SAST date at hh:mm SAST, as a UTC instant. */
const sastToday = (h: number, m = 0) => {
  const day = new Date(Date.now() + 2 * HOUR).toISOString().slice(0, 10);
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - 2 * HOUR + (h * 60 + m) * 60_000);
};
const AT_1400 = sastToday(14);
const AT_1800 = sastToday(18);
const sastDay = (offset: number) =>
  new Date(AT_1800.getTime() + 2 * HOUR + offset * DAY).toISOString().slice(0, 10);
const TODAY = sastDay(0);
const YESTERDAY = sastDay(-1);
const GO_LIVE = sastDay(-30);
const CAPTAIN_KEY = '0'.repeat(64); // the shared example's captainRef natural key
const CAPTAIN_REF = `smartclub:dolphins:player:${CAPTAIN_KEY}`;
const S1 = 's-planb-premier-men-t20-g1';

let ddb: Server;
let repo: typeof import('../src/repo.js');
let reports: typeof import('../src/captains-reports.js');
let contract: typeof import('../src/medicoach-sync-contract.js');

// ── Stub medicoach (the run-ordering test only) ──
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
const NAMES: Record<string, string> = {
  umzinto: 'Umzinto CC',
  'african-warriors': 'African Warriors',
  c: 'C CC',
  d: 'D CC',
  nochair: 'No Chair CC',
};
const club = (id: string, chair: { name: string; email?: string; cell?: string }) =>
  ({
    id,
    name: NAMES[id] ?? id,
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

const series = (
  id: string,
  teams: string[],
  fixtures: unknown[],
  over: Record<string, unknown> = {},
): Series =>
  ({
    id,
    name: `${id} T20`,
    leagueKey: 'premier',
    startDate: YESTERDAY,
    teams,
    participants: teams.map((t) => ({
      teamId: t,
      clubId: t,
      name: NAMES[t] ?? t,
      venue: 'Kingsmead Oval',
    })),
    fixtures,
    kind: 'series',
    approved: true,
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
    ...over,
  }) as unknown as Series;

const fx = (id: string, home: string, away: string, over: Record<string, unknown> = {}) => ({
  id,
  round: 1,
  date: TODAY,
  time: '09:00',
  home,
  away,
  ...over,
});

const TEAMS = ['umzinto', 'african-warriors', 'c', 'd', 'nochair'];

async function seed(opts: { goLive?: string | null; fixtures?: unknown[] } = {}) {
  const goLive = opts.goLive === undefined ? GO_LIVE : opts.goLive;
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
  await repo.createClub('dolphins', club('nochair', { name: '' }));
  await repo.putSeries(
    'dolphins',
    series(S1, TEAMS, opts.fixtures ?? [fx('f3', 'umzinto', 'african-warriors')]),
  );
}

async function seedCaptain() {
  await repo.createPlayer('dolphins', {
    naturalKey: CAPTAIN_KEY,
    clubId: 'umzinto',
    firstName: 'Sanele',
    lastName: 'Mthembu',
    email: 'captain@umzinto.test',
    cell: '0831234567',
    isMinor: false,
  } as never);
}

type Notice = import('../src/captains-reports.js').ReportNotice;
const notices: Notice[] = [];
const logLines: string[] = [];
let outcome: (n: Notice) => 'sent' | 'failed' = () => 'sent';
const sendNotice = async (n: Notice) => {
  notices.push(n);
  return n.channels.map((channel) => ({ channel, status: outcome(n) }));
};
const reportDeps = () => ({
  log: (l: string) => logLines.push(l),
  sendNotice,
  linkSecret: () => 'test-secret',
  linkBase: () => 'https://platform.test',
});

const open = async (
  at: Date = AT_1800,
  extra: { deadlineMs?: number } = {},
  opts?: { targetDates?: string[]; seriesIds?: string[] },
) =>
  reports.openMatchDayReports(
    'dolphins',
    (await repo.getTenantConfig('dolphins'))!,
    { repo, now: () => at, ...reportDeps(), ...extra },
    opts,
  );

const reportsOf = async () =>
  (await repo.listCaptainsReports('dolphins')).sort((a, b) => a.id.localeCompare(b.id));

const result = (over: Partial<SyncResult> = {}): SyncResult => ({
  homeScore: '184/6 (20)',
  awayScore: '161/9 (20)',
  summary: 'Umzinto won by 23 runs',
  winner: 'home',
  method: 'normal',
  noResult: false,
  source: 'live',
  recordedAt: new Date(AT_1800.getTime() + HOUR).toISOString(),
  scoringSide: 'home',
  captainRef: CAPTAIN_REF,
  medicoachMatchUrl: null,
  ...over,
});

/** The result path (puller hook) for fixture `fixtureId` of S1. */
const resultEvent = async (fixtureId: string, r: SyncResult, at: Date = AT_1800) =>
  reports.openCaptainReports(
    {
      tenant: 'dolphins',
      seriesId: S1,
      fixtureId,
      ref: `smartclub:dolphins:fixture:${S1}:${fixtureId}`,
      result: r,
      config: (await repo.getTenantConfig('dolphins'))!,
    },
    { repo, now: () => at, ...reportDeps() },
  );

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
  reports = await import('../src/captains-reports.js');
  contract = await import('../src/medicoach-sync-contract.js');
  await startStub();
});

after(async () => {
  reports.setReportNoticeWindowOverride(undefined);
  await new Promise<void>((r) => stub.close(() => r()));
  await stopDynalite(ddb);
});

beforeEach(async () => {
  await resetTable();
  notices.length = 0;
  logLines.length = 0;
  page = null;
  outcome = () => 'sent';
  reports.setReportNoticeWindowOverride(undefined); // the real clock rule; tests pass `now`
});

describe('no-result match-day open', () => {
  test('opens both reports to the chairs, no summary, one notice each; a re-run sends zero', async () => {
    await seed();
    const sum = await open();
    assert.deepEqual(sum, {
      fixtures: 1,
      opened: 2,
      notified: 2,
      failed: 0,
      deferred: 0,
      skipped: 0,
    });
    const rs = await reportsOf();
    assert.equal(rs.length, 2);
    for (const r of rs) {
      assert.equal(r.status, 'pending');
      assert.equal(r.source, 'auto');
      assert.equal(r.recipient.kind, 'chair');
      assert.equal(r.resultSummary, null);
      assert.equal(r.fixtureRef, undefined, 'a match-day open has no medicoach ref');
      assert.ok(r.notifiedAt);
    }
    assert.deepEqual(rs.map((r) => r.recipient.name).sort(), ['Awa Chair', 'Uma Chair']);
    assert.equal(notices.length, 2);
    assert.ok(notices.every((n) => n.recipientKind === 'chair' && n.purpose === 'opened'));

    const again = await open(sastToday(18, 15));
    assert.equal(again.opened + again.notified, 0);
    assert.equal(again.skipped, 2, 'both sides already have a report');
    await open(sastToday(21));
    assert.equal(notices.length, 2, 're-runs send nothing');
  });

  test('a later result fills the summary in, notifies nobody, keeps the chair recipient', async () => {
    await seed();
    await seedCaptain();
    await open();
    const before = await reportsOf();
    await resultEvent('f3', result(), sastToday(19));
    const afterRs = await reportsOf();
    assert.equal(notices.length, 2, 'no second notice');
    for (const r of afterRs) {
      assert.equal(r.resultSummary, 'Umzinto won by 23 runs');
      assert.equal(r.recipient.kind, 'chair');
      const was = before.find((b) => b.id === r.id)!;
      assert.equal(r.recipient.memberId, was.recipient.memberId, 'recipient unchanged');
    }
  });
});

describe('skips', () => {
  test('dateTbc, cancelled and slot-ref sides are skipped; a rescheduled (postponed) fixture opens', async () => {
    await seed({
      fixtures: [
        fx('tbc', 'c', 'd', { dateTbc: true, status: 'postponed' }),
        fx('canc', 'c', 'd', { status: 'cancelled' }),
        fx('slot', 'umzinto', 'win:r1m1'),
        fx('moved', 'c', 'd', { status: 'postponed' }),
      ],
    });
    const sum = await open();
    assert.equal(sum.fixtures, 4);
    assert.equal(sum.skipped, 2, 'dateTbc + cancelled');
    const rs = await reportsOf();
    assert.deepEqual(rs.map((r) => r.id).sort(), [
      `${S1}~moved~c`,
      `${S1}~moved~d`,
      `${S1}~slot~umzinto`,
    ]);
    const slot = rs.find((r) => r.fixtureId === 'slot')!;
    assert.equal(slot.opponentName, 'TBC');
  });

  test('an unreleased series and one not yet activated are not walked', async () => {
    await seed({ fixtures: [] });
    await repo.putSeries(
      'dolphins',
      series('s-unreleased', ['c', 'd'], [fx('u1', 'c', 'd')], { released: false }),
    );
    await repo.putSeries(
      'dolphins',
      series('s-later', ['c', 'd'], [fx('l1', 'c', 'd')], { activateFrom: sastDay(5) }),
    );
    const sum = await open();
    assert.equal(sum.fixtures, 0);
    assert.deepEqual(await reportsOf(), []);
  });

  test('before go-live (and with no go-live date) nothing opens', async () => {
    await seed({ goLive: sastDay(1) });
    const sum = await open();
    assert.equal(sum.opened, 0);
    assert.equal(sum.skipped, 2);
    await resetTable();
    await seed({ goLive: null });
    assert.equal((await open()).opened, 0);
    assert.deepEqual(await reportsOf(), []);
    assert.equal(notices.length, 0);
  });

  test('a shut window returns at once without enumerating anything', async () => {
    await seed();
    let listed = 0;
    const counting = {
      ...repo,
      listSeries: async (t: string) => {
        listed++;
        return repo.listSeries(t);
      },
    } as typeof repo;
    const sum = await reports.openMatchDayReports(
      'dolphins',
      (await repo.getTenantConfig('dolphins'))!,
      { repo: counting, now: () => AT_1400, ...reportDeps() },
    );
    assert.deepEqual(sum, {
      fixtures: 0,
      opened: 0,
      notified: 0,
      failed: 0,
      deferred: 0,
      skipped: 0,
      windowClosed: true,
    });
    assert.equal(listed, 0, 'no listSeries on a daytime run');
    assert.deepEqual(await reportsOf(), []);
  });

  test('a spent deadline defers the rest to the next run, which finishes once', async () => {
    await seed({
      fixtures: [fx('f3', 'umzinto', 'african-warriors'), fx('f4', 'c', 'd')],
    });
    const spent = await open(AT_1800, { deadlineMs: Date.now() - 1 });
    assert.equal(spent.deferred, 2);
    assert.equal(spent.opened, 0);
    const next = await open(sastToday(18, 15));
    assert.equal(next.opened, 4);
    assert.equal(notices.length, 4);
  });

  test('the default lookback covers yesterday but not the day before', async () => {
    await seed({
      fixtures: [
        fx('y', 'umzinto', 'african-warriors', { date: YESTERDAY }),
        fx('old', 'c', 'd', { date: sastDay(-2) }),
      ],
    });
    const sum = await open();
    assert.equal(sum.fixtures, 1);
    assert.deepEqual(
      (await reportsOf()).map((r) => r.fixtureId),
      ['y', 'y'],
    );
    // An explicit date list reaches further (the backfill's way).
    const explicit = await open(AT_1800, {}, { targetDates: [sastDay(-2)] });
    assert.equal(explicit.opened, 2);
  });

  test('seriesIds narrows the walk', async () => {
    await seed();
    await repo.putSeries('dolphins', series('s-other', ['c', 'd'], [fx('o1', 'c', 'd')]));
    const sum = await open(AT_1800, {}, { seriesIds: ['s-other'] });
    assert.equal(sum.opened, 2);
    assert.ok((await reportsOf()).every((r) => r.seriesId === 's-other'));
  });
});

describe('existing rows are left alone', () => {
  test('a portal-filed side is untouched; the other side opens to its chair', async () => {
    await seed();
    const now = AT_1800.toISOString();
    const filed: CaptainsReport = {
      id: reports.captainsReportId(S1, 'f3', 'umzinto'),
      seriesId: S1,
      fixtureId: 'f3',
      clubId: 'umzinto',
      status: 'submitted',
      source: 'manual',
      matchDate: TODAY,
      side: 'home',
      clubName: 'Umzinto CC',
      opponentName: 'African Warriors',
      competition: 'x',
      resultSummary: null,
      umpiresSnapshot: [],
      recipient: { kind: 'chair', memberId: 'm-portal', name: 'Uma Chair' },
      captainName: 'Portal Person',
      umpires: [],
      general: 'filed from the portal',
      createdAt: now,
      updatedAt: now,
    } as CaptainsReport;
    assert.ok(await repo.openCaptainsReportIfAbsent('dolphins', filed));
    const sum = await open();
    assert.equal(sum.opened, 1);
    assert.equal(sum.skipped, 1);
    const own = await repo.getCaptainsReport('dolphins', S1, 'f3', 'umzinto');
    assert.equal(own?.status, 'submitted');
    assert.equal(own?.general, 'filed from the portal');
    assert.equal(own?.recipient.memberId, 'm-portal');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].clubName, 'African Warriors');
  });

  test('a VOID report is never resurrected by the opener; a re-recorded result still reopens it', async () => {
    await seed();
    await seedCaptain();
    await resultEvent('f3', result());
    assert.equal(notices.length, 2);
    // The result is cleared in medicoach: pending reports are voided.
    for (const r of await reportsOf())
      await repo.voidOrFlagCaptainsReport('dolphins', r, 'result cleared in medicoach');
    const sum = await open(sastToday(19));
    assert.equal(sum.opened, 0);
    assert.equal(sum.skipped, 2);
    assert.ok(
      (await reportsOf()).every((r) => r.status === 'void'),
      'still withdrawn',
    );
    await open(sastToday(20));
    assert.equal(notices.length, 2, 'no fresh notice, run after run');

    // The existing result path re-opens it (new recipient id ⇒ a new notice).
    await resultEvent(
      'f3',
      result({ recordedAt: new Date(AT_1800.getTime() + 3 * HOUR).toISOString() }),
      sastToday(21),
    );
    assert.ok((await reportsOf()).every((r) => r.status === 'pending'));
    assert.equal(notices.length, 4);
  });

  test('a chair-less club: recorded undelivered, its claim completed — never retried', async () => {
    await seed({ fixtures: [fx('f9', 'c', 'nochair')] });
    const sum = await open();
    assert.equal(sum.opened, 2);
    assert.equal(sum.notified, 1);
    assert.equal(notices.length, 1, 'no send attempted without a contact');
    const r = (await repo.getCaptainsReport('dolphins', S1, 'f9', 'nochair'))!;
    assert.equal(r.notifiedAt, undefined);
    assert.ok(r.deliveries?.length && r.deliveries.every((d) => d.reason === 'no-contact'));
    const claim = await repo.getCaptainsReportNotify(
      'dolphins',
      r.id,
      `recipient#${r.recipient.memberId}`,
    );
    assert.notEqual(claim?.status, 'in_progress');
    const again = await open(sastToday(19));
    assert.equal(again.skipped, 2, 'settled: not walked again');
  });

  test('a notice that failed on every channel is counted failed and resent by the next run', async () => {
    await seed();
    outcome = (n) => (n.clubName === 'Umzinto CC' ? 'failed' : 'sent');
    const sum = await open();
    assert.equal(sum.opened, 2);
    assert.equal(sum.failed, 1);
    assert.equal(sum.notified, 1);
    outcome = () => 'sent';
    const next = await open(sastToday(18, 15));
    assert.equal(next.notified, 1);
    assert.equal(next.opened, 0);
    assert.equal(notices.filter((n) => n.clubName === 'Umzinto CC').length, 2);
    assert.equal(notices.filter((n) => n.clubName === 'African Warriors').length, 1);
  });
});

describe('inside runTenantSync', () => {
  const syncAt = async (at: Date, onOpenOutcome?: (o: unknown) => void) =>
    (await import('../src/medicoach-sync/run.js')).runTenantSync('dolphins', 'manual', {
      repo,
      url: stubUrl,
      secret: SECRET,
      now: () => at,
      log: (l) => logLines.push(l),
      captainsReports: { ...reportDeps(), ...(onOpenOutcome ? { onOpenOutcome } : {}) },
      opsDigestCell: () => null,
    });

  test('match-day counts land in `matchDay` only, never in `reportNotices`', async () => {
    await seed();
    page = { ...example('changes-live-result'), fixtures: [] };
    const outcomes: unknown[] = [];
    const run = await syncAt(AT_1800, (o) => outcomes.push(o));
    assert.deepEqual(run.reportNotices, { deferred: 0, opened: 0, notified: 0, failed: 0 });
    assert.equal(run.matchDay?.opened, 2);
    assert.equal(run.matchDay?.notified, 2);
    assert.deepEqual(outcomes, [], 'the caller-supplied outcome hook never sees match-day opens');
    assert.equal(notices.length, 2);

    const early = await syncAt(AT_1400);
    assert.equal(early.matchDay?.windowClosed, true);
  });

  test('a result pulled in the same run keeps its captain recipient', async () => {
    await seed();
    await seedCaptain();
    page = example('changes-live-result');
    const run = await syncAt(AT_1800);
    const rs = await reportsOf();
    const own = rs.find((r) => r.clubId === 'umzinto')!;
    assert.equal(own.recipient.kind, 'captain');
    assert.equal(own.resultSummary, 'Umzinto won by 23 runs');
    assert.equal(notices.length, 2, 'one notice per side, no match-day duplicate');
    assert.deepEqual(notices.map((n) => n.recipientKind).sort(), ['captain', 'chair']);
    assert.equal(run.matchDay?.opened ?? 0, 0);
  });
});
