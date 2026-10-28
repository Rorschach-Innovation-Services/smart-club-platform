/**
 * Pre-match captain squad links against dynalite with the REAL repo (and the real app for the
 * public `/squad-link/:token` routes):
 *
 *  - the D-1 morning opener: flag gate, 08:00 window, tomorrow-only, both sides, idempotent;
 *  - the recipient ladder per TEAM: designation → last captain → chair (minor / no contact
 *    falls through), `tm_` sides never share a last captain, veterans resolve through VETAFFIL#;
 *  - the template gate: WhatsApp only once `squad_selection_due` is registered, email always;
 *  - the link: roster (minors included, names only, veterans expanded), drafts, CAS 409,
 *    submit + re-submit (re-queued), still loadable after submit, 410 once the fixture moved;
 *  - the void hook (+ §8 void push; transient fixture reads never void; fixture-change voids
 *    self-heal; pending-after-match-day settles `expired`), the outbox flush (pushOutcome,
 *    fixture-unmapped retried then given up, voids retained to +7 days), SQUADOPEN# retries on
 *    the marker's own target + too-old;
 *  - erasure scrubs TEAMCAPTAIN#/TEAMLASTCAPT# rows and squad-request mentions.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Series, SquadRequest, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4743; // unique: 4599–4741 are taken
const TABLE = 'SmartClubSquadLinks';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const T = 'dolphins';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const sastToday = (h: number, m = 0) => {
  const day = new Date(Date.now() + 2 * HOUR).toISOString().slice(0, 10);
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - 2 * HOUR + (h * 60 + m) * 60_000);
};
const AT_0700 = sastToday(7, 59);
const AT_0800 = sastToday(8);
const AT_1900 = sastToday(19);
const sastDay = (offset: number) =>
  new Date(AT_1900.getTime() + 2 * HOUR + offset * DAY).toISOString().slice(0, 10);
const TODAY = sastDay(0);
const TOMORROW = sastDay(1);
const GO_LIVE = sastDay(-30);
const S1 = 's-premier-t20';
const LINK_SECRET = 'local-dev-captains-report-link-secret'; // env.ts's LOCAL_AUTH fallback
const K = (n: number) => String(n).repeat(64).slice(0, 64);

let ddb: Server;
let repo: typeof import('../src/repo.js');
let squad: typeof import('../src/squad-requests.js');
let squads: typeof import('../src/medicoach-sync/squads.js');
let reports: typeof import('../src/captains-reports.js');
let app: (typeof import('../src/index.js'))['app'];

const NAMES: Record<string, string> = {
  umzinto: 'Umzinto CC',
  'african-warriors': 'African Warriors',
  vets: 'Vets CC',
};
const club = (id: string, chair: { name: string; email?: string; cell?: string }, over = {}) =>
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
    ...over,
  }) as never;

const fx = (id: string, home: string, away: string, over: Record<string, unknown> = {}) => ({
  id,
  round: 1,
  date: TOMORROW,
  time: '09:00',
  home,
  away,
  ...over,
});

const series = (
  fixtures: unknown[],
  participants: Array<{ teamId: string; clubId: string; name: string }>,
): Series =>
  ({
    id: S1,
    name: 'Premier T20',
    leagueKey: 'premier',
    startDate: TODAY,
    teams: participants.map((p) => p.teamId),
    participants: participants.map((p) => ({ ...p, venue: 'Kingsmead Oval' })),
    fixtures,
    kind: 'series',
    approved: true,
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  }) as unknown as Series;

const P_UMZ = { teamId: 'umzinto', clubId: 'umzinto', name: 'Umzinto CC' };
const P_AW = { teamId: 'african-warriors', clubId: 'african-warriors', name: 'African Warriors' };

async function seed(
  opts: {
    features?: Record<string, boolean>;
    fixtures?: unknown[];
    participants?: (typeof P_UMZ)[];
  } = {},
) {
  await repo.putTenantConfig({
    tenant: T,
    branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: opts.features ?? { medicoachSync: true, preMatchSquadLinks: true },
    integrations: { medicoach: { goLiveDate: GO_LIVE } },
  } as unknown as TenantConfig);
  await repo.createClub(
    T,
    club('umzinto', { name: 'Uma Chair', email: 'chair@umzinto.test', cell: '0821234567' }),
  );
  await repo.createClub(T, club('african-warriors', { name: 'Awa Chair', email: 'chair@aw.test' }));
  await repo.putSeries(
    T,
    series(
      opts.fixtures ?? [fx('f1', 'umzinto', 'african-warriors')],
      opts.participants ?? [P_UMZ, P_AW],
    ),
  );
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
    consentAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as never);
}

type Notice = import('../src/squad-requests.js').SquadNotice;
const notices: Notice[] = [];
let outcome: () => 'sent' | 'failed' = () => 'sent';
let templateStatus = 'pending';
const deps = (at: Date = AT_1900, extra: Record<string, unknown> = {}) => ({
  repo,
  now: () => at,
  log: () => {},
  sendNotice: async (n: Notice) => {
    notices.push(n);
    return n.channels.map((channel) => ({ channel, status: outcome() }));
  },
  whatsappTemplateStatus: () => templateStatus,
  ...extra,
});
const cfg = async () => (await repo.getTenantConfig(T))!;
const open = async (at: Date = AT_1900, extra: Record<string, unknown> = {}) =>
  squad.openPreMatchSquadRequests(T, await cfg(), deps(at, extra));
const requests = async () =>
  (await repo.listSquadRequests(T)).sort((a, b) => a.id.localeCompare(b.id));
const reqOf = async (teamId: string, fixtureId = 'f1') =>
  (await repo.getSquadRequest(T, S1, fixtureId, teamId))!;

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
  squad = await import('../src/squad-requests.js');
  squads = await import('../src/medicoach-sync/squads.js');
  reports = await import('../src/captains-reports.js');
  app = (await import('../src/index.js')).app;
});

after(async () => {
  squad.setDefaultSquadNoticeSender(undefined);
  await stopDynalite(ddb);
});

beforeEach(async () => {
  await resetTable();
  notices.length = 0;
  outcome = () => 'sent';
  templateStatus = 'pending';
});

describe('the D-1 morning opener', () => {
  test('flag absent (default off) ⇒ nothing opens', async () => {
    await seed({ features: { medicoachSync: true } });
    const sum = await open();
    assert.equal(sum.disabled, true);
    assert.equal((await requests()).length, 0);
    assert.equal(notices.length, 0);
  });

  test('before 08:00 SAST nothing is read or sent; from 08:00 the first run delivers', async () => {
    await seed();
    const sum = await open(AT_0700);
    assert.equal(sum.windowClosed, true);
    assert.equal((await requests()).length, 0);
    assert.equal(notices.length, 0);
    const morning = await open(AT_0800);
    assert.equal(morning.windowClosed, undefined);
    assert.equal(morning.opened, 2);
    assert.equal(notices.length, 2);
  });

  test('the retry pass is gated on the same 08:00 window', async () => {
    await seed();
    outcome = () => 'failed';
    await open(AT_0800);
    outcome = () => 'sent';
    const early = await squad.retryPendingSquadOpens(T, deps(AT_0700));
    assert.equal(early.deferred, 2);
    assert.equal(early.done, 0);
    const late = await squad.retryPendingSquadOpens(T, deps(sastToday(9)));
    assert.equal(late.done, 2);
  });

  test("only tomorrow's fixtures, both sides, chairs by default; a re-run sends nothing", async () => {
    await seed({
      fixtures: [
        fx('f1', 'umzinto', 'african-warriors'),
        fx('f2', 'umzinto', 'african-warriors', { date: TODAY }),
        fx('f3', 'umzinto', 'african-warriors', { date: sastDay(2) }),
        fx('f4', 'umzinto', 'african-warriors', { status: 'cancelled' }),
      ],
    });
    const sum = await open();
    assert.equal(sum.opened, 2);
    assert.equal(sum.notified, 2);
    const rs = await requests();
    assert.deepEqual(
      rs.map((r) => r.id),
      [`${S1}~f1~african-warriors`, `${S1}~f1~umzinto`],
    );
    for (const r of rs) {
      assert.equal(r.status, 'pending');
      assert.equal(r.recipient.kind, 'chair');
      assert.equal(r.matchDate, TOMORROW);
      assert.equal(r.fixtureRef, `smartclub:${T}:fixture:${S1}:f1`);
      assert.equal(new Date(r.linkExpiresAt).getTime(), squad.squadLinkExpiry(TOMORROW) * 1000);
    }
    assert.equal(notices.length, 2);
    assert.ok(notices.every((n) => n.url.includes('/sq/')));
    assert.equal((await repo.listSquadOpenMarkers(T)).length, 0, 'markers settled');

    const again = await open(sastToday(20));
    assert.equal(again.opened + again.notified, 0);
    assert.equal(notices.length, 2);
  });

  test('template pending ⇒ email only; registered ⇒ email + WhatsApp', async () => {
    await seed();
    await open();
    assert.ok(notices.every((n) => n.channels.join() === 'email'));
    await resetTable();
    notices.length = 0;
    templateStatus = 'registered';
    await seed();
    await open();
    assert.ok(notices.every((n) => n.channels.join() === 'email,whatsapp'));
  });
});

describe('recipient ladder (per team)', () => {
  test('designation beats last captain beats chair; a minor designee falls through', async () => {
    await seed();
    await player(K(1), 'umzinto', 'Designee');
    await player(K(2), 'umzinto', 'Lastcap');
    await repo.putTeamLastCaptain(T, {
      clubId: 'umzinto',
      teamId: 'umzinto',
      naturalKey: K(2),
      name: 'Lastcap Test',
      seenAt: '2026-10-01T00:00:00.000Z',
    });
    await repo.putTeamCaptain(T, {
      clubId: 'umzinto',
      teamId: 'umzinto',
      playerKey: K(1),
      setBy: 'rep',
      setAt: '2026-10-01T00:00:00.000Z',
    });
    let rec = await squad.resolveSquadRecipient(
      repo,
      T,
      (await repo.getClub(T, 'umzinto'))!,
      'umzinto',
    );
    assert.equal(rec.rung, 'designated');
    assert.equal(rec.contact.name, 'Designee Test');

    // The designee becomes a minor: the last captain answers.
    await repo.deleteTeamCaptain(T, 'umzinto', 'umzinto');
    await player(K(3), 'umzinto', 'Junior', { isMinor: true });
    await repo.putTeamCaptain(T, {
      clubId: 'umzinto',
      teamId: 'umzinto',
      playerKey: K(3),
      setBy: 'rep',
      setAt: '2026-10-01T00:00:00.000Z',
    });
    rec = await squad.resolveSquadRecipient(
      repo,
      T,
      (await repo.getClub(T, 'umzinto'))!,
      'umzinto',
    );
    assert.equal(rec.rung, 'last-captain');

    await open();
    const umz = await reqOf('umzinto');
    assert.equal(umz.recipient.kind, 'captain');
    assert.equal(umz.recipient.name, 'Lastcap Test');
    const toCaptain = notices.find((n) => n.recipientKind === 'captain')!;
    assert.equal(toCaptain.ccEmail, 'chair@umzinto.test', 'the chair is cc’d');
    assert.equal((await reqOf('african-warriors')).recipient.kind, 'chair');
  });

  test('a minor last captain ⇒ chair', async () => {
    await seed();
    await player(K(4), 'umzinto', 'Kid', { isMinor: true });
    await repo.putTeamLastCaptain(T, {
      clubId: 'umzinto',
      teamId: 'umzinto',
      naturalKey: K(4),
      name: 'Kid Test',
      seenAt: '2026-10-01T00:00:00.000Z',
    });
    const rec = await squad.resolveSquadRecipient(
      repo,
      T,
      (await repo.getClub(T, 'umzinto'))!,
      'umzinto',
    );
    assert.equal(rec.rung, 'chair');
  });

  test('tm_ sides of one club: separate requests; the last captain is per TEAM', async () => {
    const A = 'tm_umzinto_premier_0';
    const B = 'tm_umzinto_premier_1';
    await seed({
      fixtures: [fx('f1', A, B)],
      participants: [
        { teamId: A, clubId: 'umzinto', name: 'Umzinto A' },
        { teamId: B, clubId: 'umzinto', name: 'Umzinto B' },
      ],
    });
    await player(K(5), 'umzinto', 'Acap');
    await repo.putTeamLastCaptain(T, {
      clubId: 'umzinto',
      teamId: A,
      naturalKey: K(5),
      name: 'Acap Test',
      seenAt: '2026-10-01T00:00:00.000Z',
    });
    await open();
    const a = await reqOf(A);
    const b = await reqOf(B);
    assert.equal(a.id, `${S1}~f1~${A}`);
    assert.equal(a.teamName, 'Umzinto A');
    assert.equal(a.recipient.kind, 'captain');
    assert.equal(b.recipient.kind, 'chair', "team A's captain is never reused for team B");
    assert.equal(b.opponentName, 'Umzinto A');
  });

  test("a captain's report captain is recorded as the team's last captain", async () => {
    await seed({ fixtures: [fx('f1', 'umzinto', 'african-warriors', { date: TODAY })] });
    await player(K(6), 'umzinto', 'Skip');
    await reports.openCaptainReports(
      {
        tenant: T,
        seriesId: S1,
        fixtureId: 'f1',
        ref: `smartclub:${T}:fixture:${S1}:f1`,
        result: {
          homeScore: '1',
          awayScore: '0',
          summary: 's',
          winner: 'home',
          method: 'normal',
          noResult: false,
          source: 'live',
          recordedAt: AT_1900.toISOString(),
          scoringSide: 'home',
          captainRef: `smartclub:${T}:player:${K(6)}`,
          medicoachMatchUrl: null,
        },
        config: await cfg(),
      },
      {
        repo,
        now: () => AT_1900,
        sendNotice: async () => [],
        linkSecret: () => 's',
        linkBase: () => 'b',
      },
    );
    const last = await repo.getTeamLastCaptain(T, 'umzinto', 'umzinto');
    assert.equal(last?.naturalKey, K(6));
    assert.equal(last?.name, 'Skip Test');
    assert.equal(await repo.getTeamLastCaptain(T, 'african-warriors', 'african-warriors'), null);
  });

  test('veterans: the designee resolves via VETAFFIL#; the roster expands to affiliates', async () => {
    await seed({
      fixtures: [fx('f1', 'vets', 'african-warriors')],
      participants: [{ teamId: 'vets', clubId: 'vets', name: 'Vets CC' }, P_AW],
    });
    await repo.createClub(T, club('vets', { name: 'Vet Chair', email: 'chair@vets.test' }));
    await player(K(7), 'umzinto', 'Oldie');
    await repo.putVeteransAffiliation(T, {
      naturalKey: K(7),
      playerName: 'Oldie Test',
      veteransClubId: 'vets',
      primaryClubId: 'umzinto',
      primaryClubName: 'Umzinto CC',
      createdAt: '2026-01-01T00:00:00.000Z',
    } as never);
    await repo.putTeamCaptain(T, {
      clubId: 'vets',
      teamId: 'vets',
      playerKey: K(7),
      setBy: 'rep',
      setAt: '2026-10-01T00:00:00.000Z',
    });
    await open();
    const v = await reqOf('vets');
    assert.equal(v.recipient.kind, 'captain');
    assert.equal(v.recipient.name, 'Oldie Test');
    const roster = await squad.squadRoster(repo, T, v, LINK_SECRET);
    assert.deepEqual(
      roster.map((e) => e.name),
      ['Oldie Test'],
    );
  });
});

describe('the public link', () => {
  const tokenOf = (teamId: string) =>
    notices.find((n) => n.requestId === `${S1}~f1~${teamId}`)!.token;
  const get = (token: string, suffix = '') => app.request(`/squad-link/${token}${suffix}`);
  type LinkBody = {
    request: { modified: string; status: string; selection: { captainName?: string } };
    roster: Array<{ id: string; name: string }>;
    candidates: Array<{ id: string; name: string }>;
  };
  const json = async (res: Response | Promise<Response>) => (await (await res).json()) as LinkBody;
  const put = (token: string, body: unknown) =>
    app.request(`/squad-link/${token}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  async function openWithRoster() {
    await seed();
    await player(K(1), 'umzinto', 'Adult');
    await player(K(2), 'umzinto', 'Minor', { isMinor: true, email: 'minor@x.test' });
    await open(AT_1900, { linkSecret: () => LINK_SECRET });
  }

  test('roster: minors included, names + opaque ids only; no-store', async () => {
    await openWithRoster();
    const res = await get(tokenOf('umzinto'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const text = await res.text();
    assert.doesNotMatch(text, new RegExp(K(1)), 'no natural key leaves the server');
    assert.doesNotMatch(text, /@x\.test/, 'no player contact');
    const body = JSON.parse(text);
    assert.deepEqual(
      body.roster.map((r: { name: string }) => r.name),
      ['Adult Test', 'Minor Test'],
    );
    assert.equal(body.canForward, true);
    assert.equal(body.request.recipient.memberId, undefined);
  });

  test('draft, CAS 409, submit, still loadable, re-submit re-queues', async () => {
    await openWithRoster();
    const token = tokenOf('umzinto');
    const first = await json(get(token));
    const [adult, minor] = first.roster;
    // Submit with nothing selected is refused.
    assert.equal(
      (await put(token, { expectedModified: first.request.modified, submit: true })).status,
      400,
    );
    const draft = await put(token, {
      expectedModified: first.request.modified,
      players: [adult.id],
    });
    assert.equal(draft.status, 200);
    const afterDraft = await json(draft);
    assert.equal(afterDraft.request.status, 'pending');
    // A stale tab (the old modified) is refused.
    const stale = await put(token, {
      expectedModified: first.request.modified,
      players: [minor.id],
      submit: true,
    });
    assert.equal(stale.status, 409);
    const submitted = await put(token, {
      expectedModified: afterDraft.request.modified,
      players: [adult.id, minor.id],
      guests: [{ name: 'Guest Person' }],
      captainId: adult.id,
      submit: true,
    });
    assert.equal(submitted.status, 200);
    const s1 = await json(submitted);
    assert.equal(s1.request.status, 'submitted');
    assert.equal(s1.request.selection.captainName, 'Adult Test');
    const row1 = (await repo.listPendingSquadSync(T))[0];
    assert.equal(row1.op, 'upsert');
    // The captain is recorded as the team's last captain.
    assert.equal((await repo.getTeamLastCaptain(T, 'umzinto', 'umzinto'))?.naturalKey, K(1));

    // A submitted squad still loads and can be changed until expiry.
    const reload = await get(token);
    assert.equal(reload.status, 200);
    const again = await put(token, {
      expectedModified: s1.request.modified,
      players: [adult.id],
      submit: true,
    });
    assert.equal(again.status, 200);
    const rows = await repo.listPendingSquadSync(T);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].submittedAt >= row1.submittedAt, 're-queued with the newer submit');
  });

  test('a bad token is 404; a moved fixture voids the request (410) and queues a §8 void', async () => {
    await openWithRoster();
    assert.equal((await get('nope.nope')).status, 404);
    const token = tokenOf('umzinto');
    const first = await json(get(token));
    await put(token, {
      expectedModified: first.request.modified,
      players: [first.roster[0].id],
      submit: true,
    });
    for (const r of await repo.listPendingSquadSync(T))
      await repo.deletePendingSquadSyncIfUnchanged(T, r.requestId, r.submittedAt);
    const s = (await repo.getSeries(T, S1))!;
    (s.fixtures as Array<Record<string, unknown>>)[0].date = sastDay(8);
    await repo.putSeries(T, s);
    const res = await get(token);
    assert.equal(res.status, 410);
    assert.equal((await reqOf('umzinto')).status, 'void');
    const rows = await repo.listPendingSquadSync(T);
    assert.deepEqual(
      rows.map((r) => [r.requestId, r.op]),
      [[`${S1}~f1~umzinto`, 'void']],
    );
  });

  const editFixture = async (edit: (f: Record<string, unknown>) => void) => {
    const s = (await repo.getSeries(T, S1))!;
    edit((s.fixtures as Array<Record<string, unknown>>)[0]);
    await repo.putSeries(T, s);
  };
  const sweep = (at: Date = AT_1900) => squad.voidChangedSquadRequests(T, { repo, now: () => at });

  test('blip: the date wiggles away and back ⇒ 410, then the ORIGINAL link works again', async () => {
    await openWithRoster();
    const token = tokenOf('umzinto');
    const first = await json(get(token));
    await put(token, {
      expectedModified: first.request.modified,
      players: [first.roster[0].id],
      submit: true,
    });
    for (const r of await repo.listPendingSquadSync(T))
      await repo.deletePendingSquadSyncIfUnchanged(T, r.requestId, r.submittedAt);
    const before = await reqOf('umzinto');
    const sent = notices.length;

    await editFixture((f) => (f.date = sastDay(8)));
    assert.equal((await get(token)).status, 410);
    assert.equal((await reqOf('umzinto')).voidReason, 'fixture changed');
    await editFixture((f) => (f.date = TOMORROW));
    assert.equal((await get(token)).status, 410, 'still void until the sweep heals it');

    // Healed on MATCH DAY: recovery, not a new send.
    const sum = await sweep(new Date(AT_1900.getTime() + DAY));
    assert.equal(sum.reopened, 1, 'only the side the load voided');
    const healed = await reqOf('umzinto');
    assert.equal(healed.status, 'submitted');
    assert.equal(healed.voidReason, undefined);
    assert.equal(healed.recipient.memberId, before.recipient.memberId);
    assert.deepEqual(healed.deliveries, before.deliveries, 'NOTIFY ledger / deliveries untouched');
    const again = await get(token);
    assert.equal(again.status, 200);
    assert.equal((await json(again)).request.status, 'submitted');
    assert.equal(notices.length, sent, 'no re-notice');
    const rows = await repo.listPendingSquadSync(T);
    assert.deepEqual(
      rows.map((r) => [r.requestId, r.op]),
      [[`${S1}~f1~umzinto`, 'upsert']],
      'the submitted squad is re-pushed over the void',
    );
  });

  test('a missing fixture or an absent date is transient: 410, never voided', async () => {
    await openWithRoster();
    const token = tokenOf('umzinto');
    assert.equal((await get(token)).status, 200);
    const saved = (await repo.getSeries(T, S1))!.fixtures;

    await editFixture((f) => delete f.date);
    let res = await get(token);
    assert.equal(res.status, 410);
    assert.match(((await res.json()) as { error: string }).error, /temporarily unavailable/);
    assert.equal((await sweep()).voided, 0);

    const s = (await repo.getSeries(T, S1))!;
    s.fixtures = [];
    await repo.putSeries(T, s);
    res = await get(token);
    assert.equal(res.status, 410);
    assert.equal((await sweep()).voided, 0);
    for (const r of await requests()) assert.equal(r.status, 'pending');
    assert.equal((await repo.listPendingSquadSync(T)).length, 0);

    const back = (await repo.getSeries(T, S1))!;
    back.fixtures = saved;
    await repo.putSeries(T, back);
    assert.equal((await get(token)).status, 200, 'the same link works once the read recovers');
  });

  test('an admin-voided request never self-heals', async () => {
    await openWithRoster();
    const token = tokenOf('umzinto');
    const r = await reqOf('umzinto');
    assert.equal(await squad.adminVoidSquadRequest(repo, T, r, AT_1900.toISOString()), 'voided');
    const sum = await sweep();
    assert.equal(sum.reopened, 0);
    assert.equal((await reqOf('umzinto')).status, 'void');
    assert.equal((await get(token)).status, 410);
  });

  test('forward is the chair link only; the forwarded captain gets a fresh link', async () => {
    await openWithRoster();
    const token = tokenOf('umzinto');
    const cands = await json(get(token, '/forward-candidates'));
    assert.deepEqual(
      cands.candidates.map((c: { name: string }) => c.name),
      ['Adult Test'],
      'minors are never forward candidates',
    );
    const res = await app.request(`/squad-link/${token}/forward`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidateId: cands.candidates[0].id }),
    });
    assert.equal(res.status, 200);
    const r = await reqOf('umzinto');
    assert.equal(r.recipient.kind, 'captain');
    assert.equal(r.forwardCount, 1);
    // The chair's own link keeps working.
    assert.equal((await get(token)).status, 200);
  });
});

describe('void sweep and the §8 outbox', () => {
  async function submitted(): Promise<SquadRequest> {
    await seed();
    await player(K(1), 'umzinto', 'Adult');
    await open();
    const r = await reqOf('umzinto');
    const roster = await squad.squadRoster(repo, T, r, 'x');
    await squad.saveSquad(
      { repo, now: () => AT_1900, linkSecret: () => 'x' },
      {
        tenant: T,
        request: r,
        body: {
          expectedModified: r.modified,
          players: [roster[0].id],
          captainId: roster[0].id,
          guests: [{ name: 'G' }],
          submit: true,
        },
      },
    );
    return reqOf('umzinto');
  }

  const fakeFetch = (answer: Record<string, unknown> | Error, seen: unknown[] = []) =>
    (async (_url: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body));
      if (answer instanceof Error) throw answer;
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as unknown as typeof fetch;

  const flush = (f: typeof fetch) =>
    squads.flushSquadOutbox(T, {
      repo,
      url: 'http://mc',
      secret: 's',
      fetch: f,
      now: () => AT_1900,
      log: () => {},
    });

  test('applied ⇒ pushOutcome recorded, row deleted; the body carries §4 player refs', async () => {
    await submitted();
    const seen: Array<Record<string, unknown>> = [];
    const sum = await flush(
      fakeFetch({ applied: true, mappedPlayers: 1, unmappedAsGuest: 0, guests: 1 }, seen),
    );
    assert.equal(sum.applied, 1);
    assert.equal((await repo.listPendingSquadSync(T)).length, 0);
    const body = seen[0];
    assert.equal(body.op, 'upsert');
    assert.equal(body.side, 'home');
    assert.deepEqual(body.players, [{ ref: `smartclub:${T}:player:${K(1)}`, name: 'Adult Test' }]);
    assert.equal(body.captainRef, `smartclub:${T}:player:${K(1)}`);
    assert.deepEqual(body.guests, [{ name: 'G' }]);
    const r = await reqOf('umzinto');
    assert.equal(r.pushOutcome?.applied, true);
    assert.equal(r.pushOutcome?.mappedPlayers, 1);
    assert.ok(r.pushedAt);
  });

  test('stale / scoring-started are terminal', async () => {
    await submitted();
    await flush(
      fakeFetch({
        applied: false,
        reason: 'scoring-started',
        mappedPlayers: 0,
        unmappedAsGuest: 0,
        guests: 0,
      }),
    );
    assert.equal((await repo.listPendingSquadSync(T)).length, 0);
    assert.equal((await reqOf('umzinto')).pushOutcome?.reason, 'scoring-started');
  });

  test('fixture-unmapped is retried (row kept), then given up after the cap', async () => {
    await submitted();
    const unmapped = fakeFetch({
      applied: false,
      reason: 'fixture-unmapped',
      mappedPlayers: 0,
      unmappedAsGuest: 0,
      guests: 0,
    });
    const s1 = await flush(unmapped);
    assert.equal(s1.unmapped, 1);
    const rows = await repo.listPendingSquadSync(T);
    assert.equal(rows.length, 1, 'kept for a retry — not completed');
    assert.equal(rows[0].attempts, 1);
    for (let i = 1; i < squads.SQUAD_PUSH_MAX_ATTEMPTS; i++) await flush(unmapped);
    assert.equal((await repo.listPendingSquadSync(T)).length, 0);
    assert.equal((await reqOf('umzinto')).pushOutcome?.reason, 'gave-up');
  });

  test('transport errors never advance the unmapped bound; only unmapped answers give up', async () => {
    await submitted();
    const captured: string[] = [];
    const unmapped = fakeFetch({
      applied: false,
      reason: 'fixture-unmapped',
      mappedPlayers: 0,
      unmappedAsGuest: 0,
      guests: 0,
    });
    const down = fakeFetch(new Error('ECONNREFUSED'));
    const go = (f: typeof fetch) =>
      squads.flushSquadOutbox(T, {
        repo,
        url: 'http://mc',
        secret: 's',
        fetch: f,
        now: () => AT_1900,
        log: () => {},
        captureException: (e) => captured.push(e.message),
      });
    // 7 unreachable + 1 unmapped: the old shared counter would have given up here.
    for (let i = 0; i < squads.SQUAD_PUSH_MAX_ATTEMPTS - 1; i++) await go(down);
    await go(unmapped);
    let [row] = await repo.listPendingSquadSync(T);
    assert.ok(row, 'not given up');
    assert.equal(row.attempts, squads.SQUAD_PUSH_MAX_ATTEMPTS);
    assert.equal(row.unmappedAttempts, 1);
    for (let i = 1; i < squads.SQUAD_PUSH_MAX_ATTEMPTS - 1; i++) {
      await go(down);
      await go(unmapped);
    }
    [row] = await repo.listPendingSquadSync(T);
    assert.ok(row);
    assert.equal(row.unmappedAttempts, squads.SQUAD_PUSH_MAX_ATTEMPTS - 1);
    assert.equal(captured.length, 0);
    await go(unmapped);
    assert.equal((await repo.listPendingSquadSync(T)).length, 0);
    assert.equal((await reqOf('umzinto')).pushOutcome?.reason, 'gave-up');
    assert.equal(captured.length, 1);
    assert.match(
      captured[0],
      new RegExp(`${squads.SQUAD_PUSH_MAX_ATTEMPTS} fixture-unmapped answers`),
    );
  });

  test('erasing a player in a submitted FUTURE squad queues a rebuilt upsert without them', async () => {
    await submitted();
    await flush(fakeFetch({ applied: true, mappedPlayers: 1, unmappedAsGuest: 0, guests: 1 }));
    assert.equal((await repo.listPendingSquadSync(T)).length, 0);
    const at = new Date(AT_1900.getTime() + HOUR).toISOString();
    await repo.erasePlayerData(T, K(1), { by: 'admin@test', at });
    const rows = await repo.listPendingSquadSync(T);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].op, 'upsert');
    assert.equal(rows[0].submittedAt, at, 'a fresh submittedAt, so it supersedes');
    const seen: Array<Record<string, unknown>> = [];
    await flush(
      fakeFetch({ applied: true, mappedPlayers: 0, unmappedAsGuest: 0, guests: 1 }, seen),
    );
    assert.deepEqual(seen[0].players, [], 'the erased player is absent');
    assert.equal(seen[0].captainRef, undefined);
    assert.equal(seen[0].submittedAt, at);
    assert.doesNotMatch(JSON.stringify(seen[0]), new RegExp(K(1)));
  });

  test('erasing a player in an EXPIRED submitted squad pushes nothing', async () => {
    const r = await submitted();
    await flush(fakeFetch({ applied: true, mappedPlayers: 1, unmappedAsGuest: 0, guests: 1 }));
    const at = new Date(Date.parse(r.linkExpiresAt) + HOUR).toISOString();
    await repo.erasePlayerData(T, K(1), { by: 'admin@test', at });
    assert.equal((await repo.listPendingSquadSync(T)).length, 0);
    assert.deepEqual((await reqOf('umzinto')).selection?.players, [], 'still scrubbed locally');
  });

  test('medicoach unreachable ⇒ the row stays with an attempt', async () => {
    await submitted();
    const sum = await flush(fakeFetch(new Error('ECONNREFUSED')));
    assert.equal(sum.errors, 1);
    assert.equal((await repo.listPendingSquadSync(T))[0].attempts, 1);
  });

  test('a cancelled fixture: the sweep voids and pushes op:void', async () => {
    await submitted();
    await flush(fakeFetch({ applied: true, mappedPlayers: 1, unmappedAsGuest: 0, guests: 1 }));
    const s = (await repo.getSeries(T, S1))!;
    (s.fixtures as Array<Record<string, unknown>>)[0].status = 'cancelled';
    await repo.putSeries(T, s);
    const { voided } = await squad.voidChangedSquadRequests(T, { repo, now: () => AT_1900 });
    assert.equal(voided, 2, 'both sides (one submitted, one pending)');
    const rows = await repo.listPendingSquadSync(T);
    assert.deepEqual(
      rows.map((r) => r.op),
      ['void'],
      'only the submitted side owes medicoach a void',
    );
    const seen: Array<Record<string, unknown>> = [];
    await flush(
      fakeFetch({ applied: true, mappedPlayers: 0, unmappedAsGuest: 0, guests: 0 }, seen),
    );
    assert.equal(seen[0].op, 'void');
    assert.deepEqual(seen[0].players, []);
  });

  const dayAfterMatch = (n: number) => new Date(AT_1900.getTime() + (1 + n) * DAY);
  const flushAt = (f: typeof fetch, at: Date, captured: string[] = []) =>
    squads.flushSquadOutbox(T, {
      repo,
      url: 'http://mc',
      secret: 's',
      fetch: f,
      now: () => at,
      log: () => {},
      captureException: (e) => captured.push(e.message),
    });
  const ok = { applied: true, mappedPlayers: 0, unmappedAsGuest: 0, guests: 0 };

  async function voidQueued() {
    await submitted();
    await flush(fakeFetch({ applied: true, mappedPlayers: 1, unmappedAsGuest: 0, guests: 1 }));
    const s = (await repo.getSeries(T, S1))!;
    (s.fixtures as Array<Record<string, unknown>>)[0].status = 'cancelled';
    await repo.putSeries(T, s);
    await squad.voidChangedSquadRequests(T, { repo, now: () => AT_1900 });
    assert.deepEqual(
      (await repo.listPendingSquadSync(T)).map((r) => r.op),
      ['void'],
    );
  }

  test('an unsent §8 void survives the +1 cutoff and delivers on recovery', async () => {
    await voidQueued();
    const captured: string[] = [];
    const down = fakeFetch(new Error('ECONNREFUSED'));
    // matchDate+2: an upsert would be dropped here.
    let sum = await flushAt(down, dayAfterMatch(2), captured);
    assert.equal(sum.dropped, 0);
    assert.equal(sum.errors, 1);
    const seen: Array<Record<string, unknown>> = [];
    sum = await flushAt(fakeFetch(ok, seen), dayAfterMatch(3), captured);
    assert.equal(sum.applied, 1);
    assert.equal(seen[0].op, 'void');
    assert.equal((await repo.listPendingSquadSync(T)).length, 0);
    assert.equal(captured.length, 0);
  });

  test('an unsent §8 void retries through matchDate+7, then is dropped with Sentry', async () => {
    await voidQueued();
    const captured: string[] = [];
    const down = fakeFetch(new Error('ECONNREFUSED'));
    let sum = await flushAt(down, dayAfterMatch(squads.SQUAD_VOID_RETENTION_DAYS), captured);
    assert.equal(sum.dropped, 0, 'still retried on matchDate+7');
    assert.equal(captured.length, 0);
    sum = await flushAt(down, dayAfterMatch(squads.SQUAD_VOID_RETENTION_DAYS + 1), captured);
    assert.equal(sum.dropped, 1);
    assert.equal(sum.sent, 0);
    assert.equal((await repo.listPendingSquadSync(T)).length, 0);
    assert.equal(captured.length, 1);
    assert.match(captured[0], /squad void dropped undelivered/);
  });

  test('a plain upsert keeps the matchDate+1 drop (no Sentry)', async () => {
    await submitted();
    const captured: string[] = [];
    const down = fakeFetch(new Error('ECONNREFUSED'));
    let sum = await flushAt(down, dayAfterMatch(1), captured);
    assert.equal(sum.dropped, 0);
    sum = await flushAt(down, dayAfterMatch(2), captured);
    assert.equal(sum.dropped, 1);
    assert.equal(captured.length, 0);
  });

  test('pending after match day settles void `expired`; match day stays live; never self-heals', async () => {
    await submitted(); // umzinto submitted, african-warriors pending
    const sweep = (at: Date) => squad.voidChangedSquadRequests(T, { repo, now: () => at });
    const queued = (await repo.listPendingSquadSync(T)).length;
    const sent = notices.length;
    let sum = await sweep(dayAfterMatch(0)); // match day
    assert.equal(sum.expired, 0);
    assert.equal((await reqOf('african-warriors')).status, 'pending');
    sum = await sweep(dayAfterMatch(1));
    assert.equal(sum.expired, 1, 'only the pending side');
    const aw = await reqOf('african-warriors');
    assert.equal(aw.status, 'void');
    assert.equal(aw.voidReason, 'expired');
    assert.equal((await reqOf('umzinto')).status, 'submitted', 'a submitted squad is left alone');
    assert.equal((await repo.listPendingSquadSync(T)).length, queued, 'no §8 push');
    assert.equal(notices.length, sent, 'no notice');
    sum = await sweep(dayAfterMatch(1));
    assert.deepEqual(sum, { voided: 0, reopened: 0, expired: 0 });
  });
});

describe('SQUADOPEN# retries', () => {
  test("a failed notice keeps the marker; the retry acts on the marker's target", async () => {
    await seed();
    outcome = () => 'failed';
    const sum = await open();
    assert.equal(sum.failed, 2);
    const markers = await repo.listSquadOpenMarkers(T);
    assert.equal(markers.length, 2);
    assert.ok(markers.every((m) => m.matchDate === TOMORROW && m.attempts === 1));
    outcome = () => 'sent';
    const r = await squad.retryPendingSquadOpens(T, deps(sastToday(21)));
    assert.equal(r.done, 2);
    assert.equal((await repo.listSquadOpenMarkers(T)).length, 0);
    assert.equal(notices.filter((n) => n.channels.length).length, 4);
  });

  test('too-old: a marker whose evening has passed is dropped, nothing sent', async () => {
    await seed({ fixtures: [fx('f1', 'umzinto', 'african-warriors', { date: TODAY })] });
    await repo.putSquadOpenMarker(T, {
      requestId: `${S1}~f1~umzinto`,
      seriesId: S1,
      fixtureId: 'f1',
      teamId: 'umzinto',
      matchDate: TODAY,
      createdAt: new Date(AT_1900.getTime() - DAY).toISOString(),
      attempts: 1,
    });
    const r = await squad.retryPendingSquadOpens(T, deps());
    assert.equal(r.dropped, 1);
    assert.equal(notices.length, 0);
    assert.equal((await requests()).length, 0);
  });

  test('gives up after the attempt cap (the marker stays as a send-free tombstone)', async () => {
    await seed();
    outcome = () => 'failed';
    await open();
    for (let i = 1; i < squad.SQUAD_OPEN_MAX_ATTEMPTS; i++)
      await squad.retryPendingSquadOpens(T, deps(sastToday(20)));
    const markers = await repo.listSquadOpenMarkers(T);
    assert.equal(markers.length, 2);
    assert.ok(markers.every((m) => m.gaveUpAt && m.attempts === squad.SQUAD_OPEN_MAX_ATTEMPTS));
    const before = notices.length;
    await squad.retryPendingSquadOpens(T, deps(sastToday(21)));
    assert.equal(notices.length, before, 'a tombstone is never retried');
  });

  test('interleaved runs: the opener never resets attempts; one send per run; one give-up report', async () => {
    await seed();
    outcome = () => 'failed';
    const captured: Array<{ requestId: unknown; lastError: unknown }> = [];
    const extra = {
      captureException: (_e: Error, ctx: { extra: Record<string, unknown> }) =>
        captured.push({ requestId: ctx.extra.requestId, lastError: ctx.extra.lastError }),
    };
    // A sync run = retry pass, then the opener (runTenantSync's order).
    const run = async (h: number) => {
      const at = sastToday(19, h);
      await squad.retryPendingSquadOpens(T, deps(at, extra));
      await open(at, extra);
    };
    const sendsPerSide = () => {
      const c = new Map<string, number>();
      for (const n of notices) c.set(n.requestId, (c.get(n.requestId) ?? 0) + 1);
      return c;
    };
    let prev = 0;
    for (let i = 0; i < squad.SQUAD_OPEN_MAX_ATTEMPTS + 2; i++) {
      const sentBefore = notices.length;
      await run(i);
      const markers = await repo.listSquadOpenMarkers(T);
      assert.equal(markers.length, 2, 'a marker per side, never dropped by the opener');
      const attempts = Math.max(...markers.map((m) => m.attempts));
      if (i < squad.SQUAD_OPEN_MAX_ATTEMPTS) {
        assert.equal(attempts, prev + 1, `run ${i}: attempts strictly increase`);
        assert.equal(notices.length - sentBefore, 2, `run ${i}: one send per side, not two`);
      } else {
        assert.equal(attempts, squad.SQUAD_OPEN_MAX_ATTEMPTS, 'capped');
        assert.equal(notices.length - sentBefore, 0, `run ${i}: nothing sent after give-up`);
      }
      prev = attempts;
    }
    assert.ok([...sendsPerSide().values()].every((n) => n === squad.SQUAD_OPEN_MAX_ATTEMPTS));
    assert.equal(captured.length, 2, 'exactly one Sentry report per request');
    assert.equal(new Set(captured.map((c) => c.requestId)).size, 2);
  });

  test('deadline-truncated sides still get a marker, and the retry pass opens them', async () => {
    await seed();
    const sum = await open(AT_1900, { deadlineMs: Date.now() - 1 });
    assert.equal(sum.deferred, 2);
    assert.equal(notices.length, 0, 'nothing sent past the deadline');
    const markers = await repo.listSquadOpenMarkers(T);
    assert.equal(markers.length, 2);
    assert.ok(markers.every((m) => m.attempts === 0 && m.matchDate === TOMORROW));
    const r = await squad.retryPendingSquadOpens(T, deps(sastToday(20)));
    assert.equal(r.done, 2);
    assert.equal(notices.length, 2);
  });

  test('the give-up Sentry extra carries the error NAME, never provider text', async () => {
    await seed();
    const captured: Array<Record<string, unknown>> = [];
    const extra = {
      // A provider-style throw escaping the opening (its message embeds an address).
      repo: {
        ...repo,
        claimSquadRequestNotify: async () => {
          const e = new Error('Email address is not verified: chair@umzinto.test');
          e.name = 'MessageRejected';
          throw e;
        },
      },
      captureException: (_e: Error, ctx: { extra: Record<string, unknown> }) =>
        captured.push(ctx.extra),
    };
    await open(AT_1900, extra);
    for (let i = 1; i < squad.SQUAD_OPEN_MAX_ATTEMPTS; i++)
      await squad.retryPendingSquadOpens(T, deps(sastToday(20), extra));
    assert.equal(captured.length, 2);
    for (const c of captured) assert.equal(c.lastError, 'MessageRejected');
    for (const m of await repo.listSquadOpenMarkers(T)) {
      assert.equal(m.lastError, 'MessageRejected');
      assert.doesNotMatch(JSON.stringify(m), /@umzinto/);
    }
  });
});

describe('admin + designation routes', () => {
  const devAuth = (email: string, memberships: unknown) =>
    Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
  const ADMIN = devAuth('admin@test', [{ tenantId: T, role: 'admin', clubIds: [] }]);
  const REP_UMZ = devAuth('rep@umzinto.test', [{ tenantId: T, role: 'rep', clubIds: ['umzinto'] }]);
  const REP_AW = devAuth('rep@aw.test', [
    { tenantId: T, role: 'rep', clubIds: ['african-warriors'] },
  ]);
  const h = (auth: string) => ({
    'x-tenant': T,
    'x-dev-auth': auth,
    'content-type': 'application/json',
  });

  type Cand = { id: string; name: string; affiliate?: true };
  type CapRes = { captain: { candidateId: string; name: string; affiliate?: true } | null };
  const candidatesOf = async (auth: string, clubId: string, teamId = clubId) => {
    const res = await app.request(`/clubs/${clubId}/teams/${teamId}/captain-candidates`, {
      headers: h(auth),
    });
    const text = await res.text();
    return {
      status: res.status,
      text,
      body: res.status === 200 ? (JSON.parse(text) as { candidates: Cand[] }) : null,
    };
  };
  const putCap = (auth: string, clubId: string, body: unknown, teamId = clubId) =>
    app.request(`/clubs/${clubId}/teams/${teamId}/captain`, {
      method: 'PUT',
      headers: h(auth),
      body: JSON.stringify(body),
    });

  test('a club rep sets and clears their team captain by candidate id; another club gets 403', async () => {
    await seed();
    await player(K(1), 'umzinto', 'Cap');
    const path = '/clubs/umzinto/teams/umzinto/captain';
    const cands = await candidatesOf(REP_UMZ, 'umzinto');
    assert.equal(cands.status, 200);
    assert.ok(!cands.text.includes(K(1)), 'no natural key in the candidates payload');
    const cap = cands.body!.candidates.find((c) => c.name === 'Cap Test')!;
    assert.ok(cap && !cap.affiliate);
    const set = await putCap(REP_UMZ, 'umzinto', { candidateId: cap.id });
    assert.equal(set.status, 200);
    const setText = await set.text();
    assert.ok(!setText.includes(K(1)));
    assert.equal((JSON.parse(setText) as CapRes).captain!.name, 'Cap Test');
    assert.equal((await repo.getTeamCaptain(T, 'umzinto', 'umzinto'))?.playerKey, K(1));
    const got = await app.request(path, { headers: h(REP_UMZ) });
    const gotText = await got.text();
    assert.ok(!gotText.includes(K(1)), 'GET serves no natural key');
    const gotBody = JSON.parse(gotText) as CapRes & { captain: Record<string, unknown> };
    assert.equal(gotBody.captain!.candidateId, cap.id);
    assert.equal('playerKey' in gotBody.captain!, false);
    assert.equal((await app.request(path, { headers: h(REP_AW) })).status, 403);
    assert.equal((await candidatesOf(REP_AW, 'umzinto')).status, 403);
    assert.equal((await putCap(REP_AW, 'umzinto', { candidateId: cap.id })).status, 403);
    assert.equal((await putCap(REP_UMZ, 'umzinto', { candidateId: 'bogus' })).status, 400);
    assert.equal(
      (await putCap(REP_UMZ, 'umzinto', { playerKey: K(1) })).status,
      400,
      'the natural-key wire shape is gone',
    );
    assert.equal(
      (await app.request('/clubs/umzinto/teams/tm_other_x_0/captain', { headers: h(REP_UMZ) }))
        .status,
      404,
    );
    assert.equal((await candidatesOf(REP_UMZ, 'umzinto', 'tm_other_x_0')).status, 404);
    await putCap(REP_UMZ, 'umzinto', { candidateId: null });
    assert.equal(await repo.getTeamCaptain(T, 'umzinto', 'umzinto'), null);
  });

  test('veterans: an affiliate is a candidate (no ID number served) and, designated, gets the squad link', async () => {
    await seed({
      fixtures: [fx('f1', 'vets', 'african-warriors')],
      participants: [{ teamId: 'vets', clubId: 'vets', name: 'Vets CC' }, P_AW],
    });
    await repo.createClub(T, club('vets', { name: 'Vet Chair', email: 'chair@vets.test' }));
    await player(K(7), 'umzinto', 'Oldie');
    await repo.putVeteransAffiliation(T, {
      naturalKey: K(7),
      playerName: 'Oldie Test',
      veteransClubId: 'vets',
      primaryClubId: 'umzinto',
      primaryClubName: 'Umzinto CC',
      createdAt: '2026-01-01T00:00:00.000Z',
    } as never);
    const REP_VETS = devAuth('rep@vets.test', [{ tenantId: T, role: 'rep', clubIds: ['vets'] }]);
    const cands = await candidatesOf(REP_VETS, 'vets');
    assert.equal(cands.status, 200);
    assert.ok(!cands.text.includes(K(7)), 'no ID number in the candidates payload');
    assert.deepEqual(
      cands.body!.candidates.map(({ name, affiliate }) => ({ name, affiliate })),
      [{ name: 'Oldie Test', affiliate: true }],
    );
    const set = await putCap(REP_VETS, 'vets', { candidateId: cands.body!.candidates[0].id });
    assert.equal(set.status, 200);
    const got = await app.request('/clubs/vets/teams/vets/captain', { headers: h(REP_VETS) });
    const gotText = await got.text();
    assert.ok(!gotText.includes(K(7)));
    const gotBody = JSON.parse(gotText) as CapRes;
    assert.equal(gotBody.captain!.name, 'Oldie Test');
    assert.equal(gotBody.captain!.affiliate, true);
    await open();
    const v = await reqOf('vets');
    assert.equal(v.recipient.kind, 'captain');
    assert.equal(v.recipient.name, 'Oldie Test');
  });

  test('GET /admin/squad-requests is admin-only and serves no keys or contacts', async () => {
    await seed();
    await open();
    assert.equal((await app.request('/admin/squad-requests', { headers: h(REP_UMZ) })).status, 403);
    const res = await app.request('/admin/squad-requests', { headers: h(ADMIN) });
    assert.equal(res.status, 200);
    const rows = (await res.json()) as SquadRequest[];
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r: SquadRequest) => r.recipient.memberId === undefined));
  });
});

describe('admin resend + void', () => {
  const devAuth = (email: string, memberships: unknown) =>
    Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
  const ADMIN = devAuth('admin@test', [{ tenantId: T, role: 'admin', clubIds: [] }]);
  const REP_UMZ = devAuth('rep@umzinto.test', [{ tenantId: T, role: 'rep', clubIds: ['umzinto'] }]);
  const h = (auth: string) => ({
    'x-tenant': T,
    'x-dev-auth': auth,
    'content-type': 'application/json',
  });
  const ID = `${S1}~f1~umzinto`;
  const post = (action: 'resend' | 'void', auth = ADMIN, id = ID) =>
    app.request(`/admin/squad-requests/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: h(auth),
    });
  const linkGet = (token: string) => app.request(`/squad-link/${token}`);
  const tokenOf = () => notices.filter((n) => n.requestId === ID).at(-1)!.token;

  beforeEach(() => {
    // The routes send through the module default: capture it like the opener's deps do.
    squad.setDefaultSquadNoticeSender(async (n) => {
      notices.push(n);
      return n.channels.map((channel) => ({ channel, status: 'sent' as const }));
    });
  });

  async function opened() {
    await seed();
    await player(K(1), 'umzinto', 'Adult');
    await open(AT_1900, { linkSecret: () => LINK_SECRET });
  }

  async function submit() {
    const r = await reqOf('umzinto');
    const roster = await squad.squadRoster(repo, T, r, LINK_SECRET);
    await squad.saveSquad(
      { repo, linkSecret: () => LINK_SECRET },
      {
        tenant: T,
        request: r,
        body: {
          expectedModified: r.modified,
          players: [roster[0].id],
          captainId: roster[0].id,
          guests: [],
          submit: true,
        },
      },
    );
    return reqOf('umzinto');
  }

  test('both are admin-only (rep 403) and 404 an unknown id', async () => {
    await opened();
    assert.equal((await post('resend', REP_UMZ)).status, 403);
    assert.equal((await post('void', REP_UMZ)).status, 403);
    assert.equal((await post('resend', ADMIN, `${S1}~nope~umzinto`)).status, 404);
    assert.equal((await post('void', ADMIN, 'not-an-id')).status, 404);
    assert.equal((await reqOf('umzinto')).status, 'pending', 'a refused call changes nothing');
  });

  test('resend rotates memberId: the old link 410s, the new one loads; one notice per resend', async () => {
    await opened();
    const before = await reqOf('umzinto');
    const oldToken = tokenOf();
    assert.equal((await linkGet(oldToken)).status, 200);
    const sent = notices.length;
    const res = await post('resend');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { notice: string; request: SquadRequest };
    assert.equal(body.notice, 'sent');
    assert.equal(body.request.recipient.memberId, undefined, 'never served');
    const after = await reqOf('umzinto');
    assert.notEqual(after.recipient.memberId, before.recipient.memberId);
    assert.equal(notices.length, sent + 1, 'exactly one notice');
    assert.equal(notices.at(-1)!.recipientKind, 'chair');
    assert.equal((await linkGet(oldToken)).status, 410);
    assert.equal((await linkGet(tokenOf())).status, 200);
  });

  test('resend re-runs the ladder: a captain designated since opening gets the new link', async () => {
    await opened();
    assert.equal((await reqOf('umzinto')).recipient.kind, 'chair');
    await repo.putTeamCaptain(T, {
      clubId: 'umzinto',
      teamId: 'umzinto',
      playerKey: K(1),
      setBy: 'rep',
      setAt: '2026-10-01T00:00:00.000Z',
    });
    assert.equal((await post('resend')).status, 200);
    const r = await reqOf('umzinto');
    assert.equal(r.recipient.kind, 'captain');
    assert.equal(r.recipient.name, 'Adult Test');
    assert.equal(notices.at(-1)!.to.email, 'adult@x.test');
    assert.equal(notices.at(-1)!.ccEmail, 'chair@umzinto.test');
  });

  test('resend is refused (409) once submitted or void, and sends nothing', async () => {
    await opened();
    await submit();
    const sent = notices.length;
    const r1 = await post('resend');
    assert.equal(r1.status, 409);
    assert.match(((await r1.json()) as { error: string }).error, /submitted/);
    assert.equal((await post('void')).status, 200);
    assert.equal((await post('resend')).status, 409);
    assert.equal(notices.length, sent);
  });

  test('void of a PENDING request: links 410, no §8 push queued; a second void is 409', async () => {
    await opened();
    const token = tokenOf();
    const res = await post('void');
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { voidPushQueued: boolean }).voidPushQueued, false);
    const r = await reqOf('umzinto');
    assert.equal(r.status, 'void');
    assert.equal(r.voidReason, 'voided by admin');
    assert.equal((await linkGet(token)).status, 410);
    assert.deepEqual(await repo.listPendingSquadSync(T), []);
    assert.equal((await post('void')).status, 409);
  });

  test('void of a SUBMITTED request queues the §8 op:void push', async () => {
    await opened();
    await submit();
    const res = await post('void');
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { voidPushQueued: boolean }).voidPushQueued, true);
    const rows = await repo.listPendingSquadSync(T);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].requestId, ID);
    assert.equal(rows[0].op, 'void');
  });
});

describe('WhatsApp delivery statuses for squad sends', () => {
  const ID = `${S1}~f1~umzinto`;
  async function openedWithWhatsApp() {
    templateStatus = 'registered';
    await seed();
    await squad.openPreMatchSquadRequests(
      T,
      await cfg(),
      deps(AT_1900, {
        sendNotice: async (n: Notice) => {
          notices.push(n);
          return n.channels.map((channel) => ({
            channel,
            status: 'sent' as const,
            messageId: `wamid.${n.requestId}.${channel}`,
          }));
        },
      }),
    );
  }
  const status = (id: string, s: 'delivered' | 'read' | 'failed') => ({
    id,
    status: s,
    at: '2026-10-27T18:00:00.000Z',
    ...(s === 'failed' ? { error: 'Message undeliverable' } : {}),
  });

  test('a status for a squad send updates the squad request, never a captains report', async () => {
    await openedWithWhatsApp();
    const { applyWhatsAppStatuses } = await import('../src/notify/whatsapp-status.js');
    const wamid = `wamid.${ID}.whatsapp`;
    const lookup = await repo.getWhatsAppMessageLookup(wamid);
    assert.equal(lookup?.kind, 'squad-request');
    assert.equal(await repo.getWhatsAppMessageRef(wamid), null, 'not a report ref');
    const sum = await applyWhatsAppStatuses(repo, [status(wamid, 'delivered')]);
    assert.deepEqual(sum, { matched: 1, unknown: 0, stale: 0 });
    const wa = (await reqOf('umzinto')).deliveries!.find((d) => d.channel === 'whatsapp')!;
    assert.equal(wa.providerStatus, 'delivered');
    assert.deepEqual(await repo.listCaptainsReports(T), []);
    // Forward-only, like report deliveries.
    const again = await applyWhatsAppStatuses(repo, [status(wamid, 'delivered')]);
    assert.equal(again.stale, 1);
    await applyWhatsAppStatuses(repo, [status(wamid, 'failed')]);
    const failed = (await reqOf('umzinto')).deliveries!.find((d) => d.channel === 'whatsapp')!;
    assert.equal(failed.providerStatus, 'failed');
    assert.equal(failed.providerError, 'Message undeliverable');
  });

  test('back-compat: a legacy WAMSG# ref with NO kind still updates the captains report', async () => {
    await seed();
    const report = {
      id: `${S1}~f1~umzinto`,
      seriesId: S1,
      fixtureId: 'f1',
      clubId: 'umzinto',
      status: 'pending',
      source: 'auto',
      matchDate: TODAY,
      side: 'home',
      clubName: 'Umzinto CC',
      opponentName: 'African Warriors',
      competition: 'Premier T20',
      umpiresSnapshot: [],
      recipient: { kind: 'chair', memberId: 'm1', name: 'Uma Chair' },
      captainName: '',
      umpires: [],
      general: '',
    };
    await repo.createCaptainsReport(T, report as never);
    const wamid = 'wamid.legacy.report';
    await repo.recordCaptainsReportDeliveries(T, report as never, [
      {
        channel: 'whatsapp',
        status: 'sent',
        purpose: 'opened',
        recipientKind: 'chair',
        at: '2026-10-27T17:00:00.000Z',
        messageId: wamid,
      } as never,
    ]);
    // A ref written before the discriminator existed: no `kind` attribute at all.
    const { DynamoDBClient, PutItemCommand } = await import('@aws-sdk/client-dynamodb');
    const c = new DynamoDBClient({
      endpoint: process.env.DYNAMO_ENDPOINT,
      region: 'localhost',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });
    await c.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: {
          pk: { S: `WAMSG#${wamid}` },
          sk: { S: 'WAMSG' },
          tenant: { S: T },
          seriesId: { S: S1 },
          fixtureId: { S: 'f1' },
          clubId: { S: 'umzinto' },
        },
      }),
    );
    const { applyWhatsAppStatuses } = await import('../src/notify/whatsapp-status.js');
    const sum = await applyWhatsAppStatuses(repo, [status(wamid, 'read')]);
    assert.deepEqual(sum, { matched: 1, unknown: 0, stale: 0 });
    const r = await repo.getCaptainsReport(T, S1, 'f1', 'umzinto');
    assert.equal(r!.deliveries!.find((d) => d.channel === 'whatsapp')!.providerStatus, 'read');
  });
});

describe('player erasure', () => {
  test('TEAMCAPTAIN# / TEAMLASTCAPT# rows and squad mentions are scrubbed', async () => {
    await seed();
    await player(K(1), 'umzinto', 'Gone');
    await repo.putTeamCaptain(T, {
      clubId: 'umzinto',
      teamId: 'umzinto',
      playerKey: K(1),
      setBy: 'rep',
      setAt: '2026-10-01T00:00:00.000Z',
    });
    await repo.putTeamLastCaptain(T, {
      clubId: 'umzinto',
      teamId: 'umzinto',
      naturalKey: K(1),
      name: 'Gone Test',
      seenAt: '2026-10-01T00:00:00.000Z',
    });
    await open();
    const r = await reqOf('umzinto');
    assert.equal(r.recipient.name, 'Gone Test');
    const counts = await repo.erasePlayerData(T, K(1), { by: 'admin@test' });
    assert.equal(counts?.teamCaptainRows, 2);
    assert.equal(counts?.squadRequestsScrubbed, 1);
    assert.equal(await repo.getTeamCaptain(T, 'umzinto', 'umzinto'), null);
    assert.equal(await repo.getTeamLastCaptain(T, 'umzinto', 'umzinto'), null);
    const after = await reqOf('umzinto');
    assert.equal(after.recipient.name, '[removed]');
    assert.equal(after.recipientContact, undefined);
  });
});
