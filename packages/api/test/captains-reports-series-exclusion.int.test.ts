/**
 * The per-series captain's-report exclusion (`captainsReportsExcludedSeriesPrefixes`): a
 * series whose name starts with a listed prefix (trimmed, case-insensitive) behaves as if the
 * tenant kill switch were off for it alone — no opens (result hook, match day, REPORTOPEN#
 * retry), no notices, no reminders, markers deleted — while a non-excluded series in the same
 * tenant is unchanged, an issued link still loads, and an absent field changes nothing.
 * Dates are all relative to the real clock (none pinned).
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Series, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4793; // unique
const TABLE = 'SmartClubReportSeriesExclusion';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const T = 'dolphins';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const sastToday = (h: number) => {
  const day = new Date(Date.now() + 2 * HOUR).toISOString().slice(0, 10);
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - 2 * HOUR + h * HOUR);
};
const AT_1900 = sastToday(19);
const TODAY = new Date(AT_1900.getTime() + 2 * HOUR).toISOString().slice(0, 10);
const GO_LIVE = new Date(AT_1900.getTime() - 30 * DAY).toISOString().slice(0, 10);
const DEADLINE = new Date(AT_1900.getTime() + 30 * DAY).toISOString().slice(0, 10);
const RELEASED_AT = new Date(AT_1900.getTime() - 60 * DAY).toISOString();
const S1 = 's1'; // "EMCU Division 1" (excluded)
const S2 = 's2'; // "Premier" (not excluded)
const SECRET = 'kill-switch-secret';

let ddb: Server;
let repo: typeof import('../src/repo.js');
let reports: typeof import('../src/captains-reports.js');
let app: (typeof import('../src/index.js'))['app'];

const club = (id: string) =>
  ({
    id,
    name: id,
    district: 'd',
    sub: '',
    chair: `${id} chair`,
    exco: { chair: { name: `${id} chair`, email: `chair@${id}.test` } },
    affiliation: 'complete',
    cqi: 0,
    docs: {},
    players: 0,
    teams: 1,
    women: 0,
    juniors: 0,
    color: '#000',
    leagues: ['premier'],
  }) as never;

async function seed(prefixes?: string[]) {
  const features: Record<string, boolean> = {};
  await repo.putTenantConfig({
    tenant: T,
    branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: DEADLINE,
    knownClubs: [],
    features: { medicoachSync: true, ...features },
    integrations: { medicoach: { goLiveDate: GO_LIVE } },
    ...(prefixes ? { captainsReportsExcludedSeriesPrefixes: prefixes } : {}),
  } as unknown as TenantConfig);
  await repo.createClub(T, club('c'));
  await repo.createClub(T, club('d'));
  await repo.createClub(T, club('a'));
  await repo.createClub(T, club('b'));
  const putOne = (SID: string, NAME: string, h: string, a: string) =>
    repo.putSeries(T, {
      id: SID,
      name: NAME,
      leagueKey: 'premier',
      startDate: TODAY,
      teams: [h, a],
      participants: [
        { teamId: h, clubId: h, name: h },
        { teamId: a, clubId: a, name: a },
      ],
      fixtures: [{ id: 'f1', round: 1, date: TODAY, time: '09:00', home: h, away: a }],
      kind: 'series',
      approved: true,
      released: true,
      releasedAt: RELEASED_AT,
      version: 1,
    } as unknown as Series);
  await putOne(S1, 'EMCU Division 1', 'a', 'b');
  await putOne(S2, 'Premier', 'c', 'd');
}

const setPrefixes = async (prefixes: string[] | undefined) => {
  const cfg = (await repo.getTenantConfig(T))!;
  await repo.putTenantConfig({ ...cfg, captainsReportsExcludedSeriesPrefixes: prefixes });
};
const reportsFor = async (seriesId: string) =>
  (await repo.listCaptainsReports(T)).filter((r) => r.seriesId === seriesId);
const OPERATOR = Buffer.from(
  JSON.stringify({
    sub: 'op-1',
    email: 'operator@platform',
    memberships: [{ tenantId: '*', role: 'operator', clubIds: [] }],
  }),
).toString('base64');

const notices: unknown[] = [];
const deps = (at: Date = AT_1900) => ({
  repo,
  now: () => at,
  log: () => {},
  linkSecret: () => SECRET,
  linkBase: () => 'https://p.test',
  sendNotice: async (n: { channels: Array<'email' | 'whatsapp'>; token: string }) => {
    notices.push(n);
    return n.channels.map((channel) => ({ channel, status: 'sent' as const }));
  },
});

const result = {
  homeScore: '1',
  awayScore: '0',
  summary: 'A won',
  winner: 'home' as const,
  method: 'normal' as const,
  noResult: false,
  source: 'live' as const,
  recordedAt: AT_1900.toISOString(),
  scoringSide: 'home' as const,
  captainRef: null,
  medicoachMatchUrl: null,
};

async function resetTable() {
  const { DynamoDBClient, ScanCommand, DeleteItemCommand } =
    await import('@aws-sdk/client-dynamodb');
  const c = new DynamoDBClient({
    endpoint: process.env.DYNAMO_ENDPOINT,
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  for (const i of (await c.send(new ScanCommand({ TableName: TABLE }))).Items ?? [])
    await c.send(new DeleteItemCommand({ TableName: TABLE, Key: { pk: i.pk, sk: i.sk } }));
}

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  repo = await import('../src/repo.js');
  reports = await import('../src/captains-reports.js');
  app = (await import('../src/index.js')).app;
});
after(async () => stopDynalite(ddb));
beforeEach(async () => {
  await resetTable();
  notices.length = 0;
});

const EMCU = ['  emcu '];
const tokenOf = (n: unknown) => (n as { token: string }).token;

const storeResultAndMarker = async (seriesId: string) => {
  const ref = `smartclub:${T}:fixture:${seriesId}:f1`;
  await repo.putFixtureResultIfNewer(T, {
    seriesId,
    fixtureId: 'f1',
    ref,
    orderAt: result.recordedAt,
    recordedAt: result.recordedAt,
    homeScore: '1',
    awayScore: '0',
    summary: 'A won',
    storedAt: result.recordedAt,
  } as never);
  await repo.putReportOpenMarker(T, {
    ref,
    seriesId,
    fixtureId: 'f1',
    recordedAt: result.recordedAt,
    createdAt: result.recordedAt,
    attempts: 0,
  });
};

describe('captainsReportsExcludedSeriesPrefixes', () => {
  test('absent ⇒ both series open on match day as before', async () => {
    await seed();
    const sum = await reports.openMatchDayReports(T, (await repo.getTenantConfig(T))!, deps());
    assert.equal(sum.opened, 4);
    assert.equal(notices.length, 4);
  });

  test('match day: excluded series opens nothing; the other series is unchanged', async () => {
    await seed(EMCU);
    const sum = await reports.openMatchDayReports(T, (await repo.getTenantConfig(T))!, deps());
    assert.equal(sum.opened, 2);
    assert.equal(notices.length, 2);
    assert.equal((await reportsFor(S1)).length, 0);
    assert.equal((await reportsFor(S2)).length, 2);
  });

  test('result hook: excluded series is skipped as disabled; the other opens', async () => {
    await seed(EMCU);
    const config = (await repo.getTenantConfig(T))!;
    const target = (seriesId: string) => ({
      tenant: T,
      seriesId,
      fixtureId: 'f1',
      ref: `smartclub:${T}:fixture:${seriesId}:f1`,
      result,
      config,
    });
    const ex = await reports.openCaptainReports(target(S1), deps());
    assert.equal(ex.skipped, 'disabled');
    assert.equal((await reportsFor(S1)).length, 0);
    assert.equal(notices.length, 0);
    const ok = await reports.openCaptainReports(target(S2), deps());
    assert.equal(ok.skipped, undefined);
    assert.equal((await reportsFor(S2)).length, 2);
  });

  test('retry: excluded series marker is deleted unsent (even before 18:00); the other drains', async () => {
    await seed(EMCU);
    await storeResultAndMarker(S1);
    await storeResultAndMarker(S2);
    // Before the notice window: the excluded marker is still dropped, the other stays queued.
    const early = await reports.retryPendingReportOpens(T, deps(sastToday(10)));
    assert.equal(early.deferred, 1);
    assert.deepEqual(
      (await repo.listReportOpenMarkers(T)).map((m) => m.seriesId),
      [S2],
    );
    const out = await reports.retryPendingReportOpens(T, deps());
    assert.equal(out.done, 1);
    assert.equal((await repo.listReportOpenMarkers(T)).length, 0);
    assert.equal((await reportsFor(S1)).length, 0);
    assert.equal((await reportsFor(S2)).length, 2);
  });

  test('reminders: excluded series gets none; an issued link still loads; the other is reminded', async () => {
    await seed();
    await reports.openMatchDayReports(T, (await repo.getTenantConfig(T))!, deps());
    assert.equal(notices.length, 4);
    await setPrefixes(['EMCU Division']);
    const later = new Date(AT_1900.getTime() + 6 * DAY);
    const rem = await reports.sendReportReminders(T, deps(later));
    assert.equal(rem.sent, 2, 'only the non-excluded series is reminded');
    const issuedTokens = (notices.slice(0, 4) as Array<{ token: string }>).map(tokenOf);
    let loaded = 0;
    for (const tok of issuedTokens) {
      const linked = await reports.loadLinkedReport(repo, tok, later.getTime(), SECRET);
      if (linked.ok) loaded++;
    }
    assert.equal(loaded, 4, 'issued links (excluded series included) keep working');
  });

  test('PUT /platform/tenants/:slug validates, trims, stores and returns the field', async () => {
    await seed();
    const put = (body: unknown) =>
      app.request(`/platform/tenants/${T}`, {
        method: 'PUT',
        headers: { 'x-dev-auth': OPERATOR, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    for (const bad of [
      'EMCU',
      [''],
      ['  '],
      [1],
      ['x'.repeat(201)],
      Array.from({ length: 21 }, (_, i) => `p${i}`),
    ]) {
      const res = await put({ captainsReportsExcludedSeriesPrefixes: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    // The length limit applies AFTER trimming: 200 chars plus padding is accepted.
    const padded = await put({ captainsReportsExcludedSeriesPrefixes: [`  ${'x'.repeat(200)}  `] });
    assert.equal(padded.status, 200);
    const res = await put({ captainsReportsExcludedSeriesPrefixes: [' EMCU '] });
    assert.equal(res.status, 200);
    const json = (await res.json()) as TenantConfig;
    assert.deepEqual(json.captainsReportsExcludedSeriesPrefixes, ['EMCU']);
    assert.deepEqual((await repo.getTenantConfig(T))?.captainsReportsExcludedSeriesPrefixes, [
      'EMCU',
    ]);
    const get = await app.request(`/platform/tenants/${T}`, {
      headers: { 'x-dev-auth': OPERATOR },
    });
    assert.deepEqual(((await get.json()) as TenantConfig).captainsReportsExcludedSeriesPrefixes, [
      'EMCU',
    ]);
  });
});
