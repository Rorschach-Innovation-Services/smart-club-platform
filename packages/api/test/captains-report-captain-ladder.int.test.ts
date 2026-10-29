/**
 * The captain's-report recipient ladder (`resolveCaptainLadder`, via `openReportsForFixture`)
 * against dynalite with the REAL repo. Per side: medicoach scorecard captain (scoring side's
 * `captainRef`) → this fixture's SUBMITTED squad-link captain → designated captain for the
 * series' competition → last known captain for it → chair. Every rung re-resolves the player
 * fresh (minor / no contact falls through). The last-captain row is written only from the
 * medicoach rung. Every date in this file is pinned.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Series, SquadRequest, TenantConfig } from '../src/types.js';
import type { SyncResult } from '../src/medicoach-sync-contract.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4797; // unique
const TABLE = 'SmartClubReportCaptainLadder';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const T = 'dolphins';
const NOW = new Date('2026-10-18T17:00:00.000Z'); // 19:00 SAST on match day
const MATCH = '2026-10-18';
const GO_LIVE = '2026-09-01';
const SEEN = '2026-10-01T00:00:00.000Z';
const S1 = 's-premier';
const S2 = 's-vets';
const SC1 = 'league:premier';
const SC2 = 'league:vets';
const K = (n: number) => String(n).repeat(64).slice(0, 64);
const ref = (k: string) => `smartclub:${T}:player:${k}`;

let ddb: Server;
let repo: typeof import('../src/repo.js');
let reports: typeof import('../src/captains-reports.js');

const club = (id: string, name: string, email: string) =>
  ({
    id,
    name,
    district: 'd',
    sub: '',
    chair: `${name} Chair`,
    exco: { chair: { name: `${name} Chair`, email } },
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

const series = (id: string, leagueKey: string): Series =>
  ({
    id,
    name: `${id} T20`,
    leagueKey,
    startDate: MATCH,
    teams: ['umzinto', 'aw'],
    participants: [
      { teamId: 'umzinto', clubId: 'umzinto', name: 'Umzinto CC', venue: 'Oval' },
      { teamId: 'aw', clubId: 'aw', name: 'African Warriors', venue: 'Oval' },
    ],
    fixtures: [{ id: 'f1', round: 1, date: MATCH, time: '09:00', home: 'umzinto', away: 'aw' }],
    kind: 'series',
    approved: true,
    released: true,
    releasedAt: SEEN,
    version: 1,
  }) as unknown as Series;

async function seed() {
  await repo.putTenantConfig({
    tenant: T,
    branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: { medicoachSync: true },
    integrations: { medicoach: { goLiveDate: GO_LIVE } },
  } as unknown as TenantConfig);
  await repo.createClub(T, club('umzinto', 'Umzinto CC', 'chair@umz.test'));
  await repo.createClub(T, club('aw', 'African Warriors', 'chair@aw.test'));
  await repo.putSeries(T, series(S1, 'premier'));
  await repo.putSeries(T, series(S2, 'vets'));
}

async function player(
  nk: string,
  clubId: string,
  first: string,
  over: Record<string, unknown> = {},
) {
  await repo.createPlayer(T, {
    naturalKey: nk,
    clubId,
    firstName: first,
    lastName: 'Test',
    email: `${first.toLowerCase()}@x.test`,
    cell: '0831234567',
    isMinor: false,
    dob: '1990-01-01',
    consentAt: SEEN,
    createdAt: SEEN,
    ...over,
  } as never);
}

const designate = (clubId: string, teamId: string, scope: string, playerKey: string) =>
  repo.putTeamCaptain(T, { clubId, teamId, scope, playerKey, setBy: 'rep', setAt: SEEN });
const lastCaptain = (clubId: string, teamId: string, scope: string, naturalKey: string) =>
  repo.putTeamLastCaptain(T, { clubId, teamId, scope, naturalKey, name: 'x', seenAt: SEEN });

async function squadRequest(
  teamId: string,
  captainKey: string,
  status: SquadRequest['status'],
  seriesId = S1,
) {
  await repo.openSquadRequestIfAbsent(T, {
    id: `${seriesId}~f1~${teamId}`,
    seriesId,
    fixtureId: 'f1',
    teamId,
    clubId: teamId,
    status,
    fixtureRef: `smartclub:${T}:fixture:${seriesId}:f1`,
    matchDate: MATCH,
    side: teamId === 'umzinto' ? 'home' : 'away',
    clubName: teamId,
    teamName: teamId,
    opponentName: 'x',
    competition: 'c',
    recipient: { kind: 'chair', memberId: 'm', name: 'c' },
    selection: { players: [{ key: captainKey, name: 'p' }], guests: [], captainKey },
    linkExpiresAt: '2026-10-18T21:59:59.000Z',
    ...(status === 'submitted' ? { submittedAt: SEEN, submittedVia: 'link' as const } : {}),
    ...(status === 'void' ? { voidedAt: SEEN, voidReason: 'fixture changed' } : {}),
    modified: 'm1',
  } as unknown as SquadRequest);
}

const result = (captainKey: string | null): SyncResult =>
  ({
    source: 'live',
    scoringSide: 'home',
    captainRef: captainKey ? ref(captainKey) : null,
    summary: 'Umzinto won',
  }) as unknown as SyncResult;

const notices: Array<{ reportId: string; to: { name: string }; recipientKind: string }> = [];
async function openFor(seriesId: string, res: SyncResult | null) {
  return reports.openReportsForFixture(
    {
      tenant: T,
      seriesId,
      fixtureId: 'f1',
      result: res,
      config: (await repo.getTenantConfig(T))!,
      receivedAt: NOW,
    },
    {
      repo,
      now: () => NOW,
      log: () => {},
      sendNotice: async (n) => {
        notices.push(n);
        return n.channels.map((channel) => ({ channel, status: 'sent' as const }));
      },
    },
  );
}
const reportOf = async (clubId: string, seriesId = S1) =>
  (await repo.getCaptainsReport(T, seriesId, 'f1', clubId))!;

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
});
after(async () => stopDynalite(ddb));
beforeEach(async () => {
  await resetTable();
  notices.length = 0;
  await seed();
  await player(K(1), 'umzinto', 'Medi');
  await player(K(2), 'umzinto', 'Squad');
  await player(K(3), 'umzinto', 'Desig');
  await player(K(4), 'umzinto', 'Lastcap');
});

describe("captain's report recipient ladder", () => {
  test('medicoach captain overrides the squad-link captain, designation and last captain', async () => {
    await squadRequest('umzinto', K(2), 'submitted');
    await designate('umzinto', 'umzinto', SC1, K(3));
    await lastCaptain('umzinto', 'umzinto', SC1, K(4));
    await openFor(S1, result(K(1)));
    const r = await reportOf('umzinto');
    assert.equal(r.recipient.kind, 'captain');
    assert.equal(r.recipient.rung, 'medicoach');
    assert.equal(r.recipient.name, 'Medi Test');
    assert.equal(r.captainName, 'Medi Test');
    // The medicoach captain is recorded as the last captain.
    assert.equal((await repo.getTeamLastCaptain(T, 'umzinto', 'umzinto', SC1))?.naturalKey, K(1));
    // The served view never carries the rung or a key.
    const view = reports.reportView(r) as unknown as { recipient: Record<string, unknown> };
    assert.deepEqual(Object.keys(view.recipient).sort(), ['kind', 'name']);
  });

  test('squad-link captain overrides designation (no medicoach captain); no last-captain write', async () => {
    await squadRequest('umzinto', K(2), 'submitted');
    await designate('umzinto', 'umzinto', SC1, K(3));
    await openFor(S1, result(null));
    const r = await reportOf('umzinto');
    assert.equal(r.recipient.rung, 'squad-link');
    assert.equal(r.recipient.name, 'Squad Test');
    assert.equal(await repo.getTeamLastCaptain(T, 'umzinto', 'umzinto', SC1), null);
  });

  test('a void or pending squad request is ignored', async () => {
    await squadRequest('umzinto', K(2), 'void');
    await designate('umzinto', 'umzinto', SC1, K(3));
    await openFor(S1, null);
    assert.equal((await reportOf('umzinto')).recipient.rung, 'designated');

    await resetTable();
    await seed();
    await player(K(2), 'umzinto', 'Squad');
    await player(K(3), 'umzinto', 'Desig');
    await squadRequest('umzinto', K(2), 'pending');
    await designate('umzinto', 'umzinto', SC1, K(3));
    await openFor(S1, null);
    assert.equal((await reportOf('umzinto')).recipient.name, 'Desig Test');
  });

  test('designation answers with no result, and for the NON-scoring side; never writes last captain', async () => {
    await player(K(5), 'aw', 'Awdesig');
    await designate('aw', 'aw', SC1, K(5));
    await designate('umzinto', 'umzinto', SC1, K(3));
    await openFor(S1, result(K(1))); // home scored
    const away = await reportOf('aw');
    assert.equal(away.recipient.kind, 'captain');
    assert.equal(away.recipient.rung, 'designated');
    assert.equal(away.recipient.name, 'Awdesig Test');
    assert.equal(await repo.getTeamLastCaptain(T, 'aw', 'aw', SC1), null);
    assert.equal((await reportOf('umzinto')).recipient.rung, 'medicoach');
    const n = notices.find((x) => x.reportId === away.id)!;
    assert.equal(n.to.name, 'Awdesig Test');
    assert.equal(n.recipientKind, 'captain');
  });

  test('designation is scoped per competition (same club + teamId in two leagues)', async () => {
    await designate('umzinto', 'umzinto', SC1, K(3));
    await designate('umzinto', 'umzinto', SC2, K(4));
    await openFor(S1, null);
    await openFor(S2, null);
    assert.equal((await reportOf('umzinto', S1)).recipient.name, 'Desig Test');
    assert.equal((await reportOf('umzinto', S2)).recipient.name, 'Lastcap Test');
  });

  test('a minor / no-contact designee falls through to the last captain, then the chair', async () => {
    await player(K(6), 'umzinto', 'Minor', { isMinor: true });
    await designate('umzinto', 'umzinto', SC1, K(6));
    await lastCaptain('umzinto', 'umzinto', SC1, K(4));
    await openFor(S1, null);
    let r = await reportOf('umzinto');
    assert.equal(r.recipient.rung, 'last-captain');
    assert.equal(r.recipient.name, 'Lastcap Test');

    await resetTable();
    await seed();
    await player(K(7), 'umzinto', 'Nocontact', { email: '', cell: '' });
    await player(K(6), 'umzinto', 'Minor', { isMinor: true });
    await designate('umzinto', 'umzinto', SC1, K(7));
    await lastCaptain('umzinto', 'umzinto', SC1, K(6));
    await openFor(S1, null);
    r = await reportOf('umzinto');
    assert.equal(r.recipient.kind, 'chair');
    assert.equal(r.recipient.rung, 'chair');
    assert.equal(r.recipient.name, 'Umzinto CC Chair');
  });
});

describe('re-targeting an already-open pending report', () => {
  const SECRET = 'ladder-test-secret';
  const tokenOf = (r: import('../src/types.js').CaptainsReport) =>
    reports.reportLink(T, r, SECRET, 'https://x.test').token;
  const linkOk = async (token: string) =>
    (await reports.loadLinkedReport(repo, token, NOW.getTime(), SECRET)).ok;
  const reportDeps = () => ({
    repo,
    now: () => NOW,
    linkSecret: () => SECRET,
    log: () => {},
    sendNotice: async (n: import('../src/captains-reports.js').ReportNotice) => {
      notices.push(n);
      return n.channels.map((channel) => ({ channel, status: 'sent' as const }));
    },
  });

  test('designated open, then a result with a different medicoach captain ⇒ re-targeted once', async () => {
    await designate('umzinto', 'umzinto', SC1, K(3));
    await openFor(S1, null);
    const before = await reportOf('umzinto');
    assert.equal(before.recipient.rung, 'designated');
    const oldToken = tokenOf(before);
    assert.equal(await linkOk(oldToken), true);
    const sent = notices.length;

    await openFor(S1, result(K(1)));
    const after1 = await reportOf('umzinto');
    assert.equal(after1.recipient.rung, 'medicoach');
    assert.equal(after1.recipient.name, 'Medi Test');
    assert.equal(after1.captainName, 'Medi Test');
    assert.notEqual(after1.recipient.memberId, before.recipient.memberId);
    assert.equal(await linkOk(oldToken), false, 'the old link is dead');
    assert.equal(await linkOk(tokenOf(after1)), true);
    const fresh = notices.slice(sent);
    assert.equal(fresh.length, 1, 'the new captain is notified once');
    assert.equal(fresh[0].to.name, 'Medi Test');
    assert.equal(fresh[0].recipientKind, 'captain');

    await openFor(S1, result(K(1)));
    assert.equal(notices.length, sent + 1, 'a re-run is a no-op');
    assert.equal((await reportOf('umzinto')).recipient.memberId, after1.recipient.memberId);
  });

  test('the same person winning a higher rung ⇒ no re-target, no message', async () => {
    await designate('umzinto', 'umzinto', SC1, K(1));
    await openFor(S1, null);
    const before = await reportOf('umzinto');
    const sent = notices.length;
    await openFor(S1, result(K(1)));
    const after1 = await reportOf('umzinto');
    assert.equal(after1.recipient.memberId, before.recipient.memberId);
    assert.equal(after1.recipient.rung, 'designated');
    assert.equal(notices.length, sent);
  });

  test('a submitted report is never re-targeted', async () => {
    await designate('umzinto', 'umzinto', SC1, K(3));
    await openFor(S1, null);
    const r = await reportOf('umzinto');
    const { DynamoDBClient, UpdateItemCommand, ScanCommand } =
      await import('@aws-sdk/client-dynamodb');
    const c = new DynamoDBClient({
      endpoint: process.env.DYNAMO_ENDPOINT,
      region: 'localhost',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });
    const item = ((await c.send(new ScanCommand({ TableName: TABLE }))).Items ?? []).find(
      (i) => i.id?.S === r.id && i.status?.S === 'pending',
    )!;
    await c.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: { pk: item.pk, sk: item.sk },
        UpdateExpression: 'SET #s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': { S: 'submitted' } },
      }),
    );
    const sent = notices.length;
    await openFor(S1, result(K(1)));
    const after1 = await reportOf('umzinto');
    assert.equal(after1.status, 'submitted');
    assert.equal(after1.recipient.memberId, r.recipient.memberId);
    assert.equal(notices.length, sent);
  });

  test('a squad submit re-targets a designated / last-captain / chair report, never a medicoach one', async () => {
    for (const [prep, rung] of [
      [() => designate('umzinto', 'umzinto', SC1, K(3)), 'designated'],
      [() => lastCaptain('umzinto', 'umzinto', SC1, K(4)), 'last-captain'],
      [async () => {}, 'chair'],
    ] as const) {
      await resetTable();
      await seed();
      await player(K(2), 'umzinto', 'Squad');
      await player(K(3), 'umzinto', 'Desig');
      await player(K(4), 'umzinto', 'Lastcap');
      await prep();
      await openFor(S1, null);
      const before = await reportOf('umzinto');
      assert.equal(before.recipient.rung, rung);
      await squadRequest('umzinto', K(2), 'submitted');
      const sent = notices.length;
      const req = (await repo.getSquadRequest(T, S1, 'f1', 'umzinto'))!;
      assert.equal(
        await reports.retargetReportForSquadCaptain(reportDeps(), T, req),
        'retargeted',
        rung,
      );
      const after1 = await reportOf('umzinto');
      assert.equal(after1.recipient.rung, 'squad-link');
      assert.equal(after1.recipient.name, 'Squad Test');
      assert.equal(notices.length, sent + 1);
      assert.equal(await reports.retargetReportForSquadCaptain(reportDeps(), T, req), 'none');
      assert.equal(notices.length, sent + 1, 'idempotent');
    }

    await resetTable();
    await seed();
    await player(K(1), 'umzinto', 'Medi');
    await player(K(2), 'umzinto', 'Squad');
    await openFor(S1, result(K(1)));
    const med = await reportOf('umzinto');
    assert.equal(med.recipient.rung, 'medicoach');
    await squadRequest('umzinto', K(2), 'submitted');
    const sent = notices.length;
    const req = (await repo.getSquadRequest(T, S1, 'f1', 'umzinto'))!;
    assert.equal(await reports.retargetReportForSquadCaptain(reportDeps(), T, req), 'none');
    assert.equal((await reportOf('umzinto')).recipient.memberId, med.recipient.memberId);
    assert.equal(notices.length, sent);
  });

  test('saveSquad submit wires the re-target (pending squad request submitted via the flow)', async () => {
    await designate('umzinto', 'umzinto', SC1, K(3));
    await openFor(S1, null);
    await squadRequest('umzinto', K(2), 'pending');
    const squad = await import('../src/squad-requests.js');
    const r = (await repo.getSquadRequest(T, S1, 'f1', 'umzinto'))!;
    const roster = await squad.squadRoster(repo, T, r, SECRET);
    const pick = roster.find((e) => e.name.startsWith('Squad'))!;
    const sent = notices.length;
    await squad.saveSquad(
      {
        repo,
        now: () => NOW,
        linkSecret: () => SECRET,
        sendReportNotice: reportDeps().sendNotice,
      },
      {
        tenant: T,
        request: r,
        body: {
          expectedModified: r.modified,
          players: [pick.id],
          captainId: pick.id,
          submit: true,
        },
      },
    );
    const after1 = await reportOf('umzinto');
    assert.equal(after1.recipient.rung, 'squad-link');
    assert.equal(after1.recipient.name, 'Squad Test');
    assert.equal(notices.length, sent + 1);
  });
});
