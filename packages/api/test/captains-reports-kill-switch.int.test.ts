/**
 * The `captainsReports` tenant kill switch (default ON): off ⇒ no automatic report opens
 * (result hook, match day, REPORTOPEN# retry), no notices and no reminders — while a link
 * already issued keeps loading. Absent ⇒ unchanged behaviour (the other captains-reports
 * suites pin the rest of it).
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Series, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4745; // unique: 4599–4743 are taken
const TABLE = 'SmartClubReportKillSwitch';
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
const S1 = 's1';
const SECRET = 'kill-switch-secret';

let ddb: Server;
let repo: typeof import('../src/repo.js');
let reports: typeof import('../src/captains-reports.js');

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

async function seed(features: Record<string, boolean>) {
  await repo.putTenantConfig({
    tenant: T,
    branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: { medicoachSync: true, ...features },
    integrations: { medicoach: { goLiveDate: GO_LIVE } },
  } as unknown as TenantConfig);
  await repo.createClub(T, club('a'));
  await repo.createClub(T, club('b'));
  await repo.putSeries(T, {
    id: S1,
    name: 'Premier',
    leagueKey: 'premier',
    startDate: TODAY,
    teams: ['a', 'b'],
    participants: [
      { teamId: 'a', clubId: 'a', name: 'A' },
      { teamId: 'b', clubId: 'b', name: 'B' },
    ],
    fixtures: [{ id: 'f1', round: 1, date: TODAY, time: '09:00', home: 'a', away: 'b' }],
    kind: 'series',
    approved: true,
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  } as unknown as Series);
}

const setFeature = async (on: boolean) => {
  const cfg = (await repo.getTenantConfig(T))!;
  await repo.putTenantConfig({ ...cfg, features: { ...cfg.features, captainsReports: on } });
};

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
});
after(async () => stopDynalite(ddb));
beforeEach(async () => {
  await resetTable();
  notices.length = 0;
});

describe('captainsReports kill switch', () => {
  test('default (absent) ⇒ match-day opens as before', async () => {
    await seed({});
    const sum = await reports.openMatchDayReports(T, (await repo.getTenantConfig(T))!, deps());
    assert.equal(sum.opened, 2);
    assert.equal(notices.length, 2);
  });

  test('off ⇒ match-day opens nothing and reads nothing', async () => {
    await seed({ captainsReports: false });
    const sum = await reports.openMatchDayReports(T, (await repo.getTenantConfig(T))!, deps());
    assert.equal(sum.disabled, true);
    assert.equal((await repo.listCaptainsReports(T)).length, 0);
    assert.equal(notices.length, 0);
  });

  test('off ⇒ the result hook opens nothing', async () => {
    await seed({ captainsReports: false });
    const out = await reports.openCaptainReports(
      {
        tenant: T,
        seriesId: S1,
        fixtureId: 'f1',
        ref: `smartclub:${T}:fixture:${S1}:f1`,
        result,
        config: (await repo.getTenantConfig(T))!,
      },
      deps(),
    );
    assert.equal(out.skipped, 'disabled');
    assert.equal((await repo.listCaptainsReports(T)).length, 0);
    assert.equal(notices.length, 0);
  });

  test('off ⇒ queued REPORTOPEN# markers are dropped, never sent', async () => {
    await seed({ captainsReports: false });
    await repo.putFixtureResultIfNewer(T, {
      seriesId: S1,
      fixtureId: 'f1',
      ref: `smartclub:${T}:fixture:${S1}:f1`,
      orderAt: result.recordedAt,
      recordedAt: result.recordedAt,
      homeScore: '1',
      awayScore: '0',
      summary: 'A won',
      storedAt: result.recordedAt,
    } as never);
    await repo.putReportOpenMarker(T, {
      ref: `smartclub:${T}:fixture:${S1}:f1`,
      seriesId: S1,
      fixtureId: 'f1',
      recordedAt: result.recordedAt,
      createdAt: result.recordedAt,
      attempts: 0,
    });
    const out = await reports.retryPendingReportOpens(T, deps());
    assert.equal(out.retried, 0);
    assert.equal((await repo.listReportOpenMarkers(T)).length, 0);
    assert.equal((await repo.listCaptainsReports(T)).length, 0);
    assert.equal(notices.length, 0);
  });

  test('off ⇒ no reminders; an issued link still loads', async () => {
    await seed({});
    await reports.openMatchDayReports(T, (await repo.getTenantConfig(T))!, deps());
    assert.equal(notices.length, 2);
    const token = (notices[0] as { token: string }).token;
    await setFeature(false);
    // Six days on, 19:00: inside the reminder window.
    const later = new Date(AT_1900.getTime() + 6 * DAY);
    const rem = await reports.sendReportReminders(T, deps(later));
    assert.equal(rem.sent + rem.due, 0);
    assert.equal(notices.length, 2);
    const linked = await reports.loadLinkedReport(repo, token, later.getTime(), SECRET);
    assert.equal(linked.ok, true, 'issued links keep working');
    // Back on: the reminders are due again.
    await setFeature(true);
    const rem2 = await reports.sendReportReminders(T, deps(later));
    assert.equal(rem2.sent, 2);
  });
});
