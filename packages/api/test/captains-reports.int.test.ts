/**
 * Captain's reports end to end (ADR 0016, Slice 2 / Tasks 2.2–2.4): a STUB medicoach serves the
 * shared contract examples, the REAL puller stores the result and opens reports against an
 * in-process dynalite table, and the reports are then read and filed through the REAL Hono
 * app (club routes, the public submit-once link, the admin list).
 *
 * The only thing replaced is the outbound sender (SES + Meta): `sendNotice` captures each
 * notice so the test can assert who was addressed and follow the link it carried.
 *
 * Dates are relative to the real clock: link tokens are verified against `Date.now()`, so a
 * fixed match date would turn this file into a time bomb.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaptainsReport, Series, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4667;
const TABLE = 'SmartClubCaptainsReports';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const SECRET = 'stub-shared-secret';
const EXAMPLES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docs/integrations/medicoach-sync-examples',
);
const example = (name: string) =>
  JSON.parse(readFileSync(path.join(EXAMPLES, `${name}.json`), 'utf8'));

const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
const ADMIN = devAuth('admin@test', [{ tenantId: 'dolphins', role: 'admin', clubIds: [] }]);
const REP_UMZINTO = devAuth('rep@umzinto.test', [
  { tenantId: 'dolphins', role: 'rep', clubIds: ['umzinto'] },
]);
const REP_AW = devAuth('rep@aw.test', [
  { tenantId: 'dolphins', role: 'rep', clubIds: ['african-warriors'] },
]);
const headers = (auth?: string) => ({
  'x-tenant': 'dolphins',
  ...(auth ? { 'x-dev-auth': auth } : {}),
  'content-type': 'application/json',
});

const DAY = 24 * 3600 * 1000;
const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
/** Yesterday: always inside the 14-day window and before the deadline. */
const MATCH_DATE = isoDay(-1);
const GO_LIVE = isoDay(-30);
const CAPTAIN_KEY = '0'.repeat(64); // the example's captainRef natural key
const CAPTAIN_REF = `smartclub:dolphins:player:${CAPTAIN_KEY}`;

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
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
    series('s-planb-promotion-men-t20-g2', 'promotion', ['c', 'd'], [fx('f7', 'c', 'd')]),
  );
  await repo.putSeries(
    'dolphins',
    series('s-planb-premier-men-t20-g2', 'premier', ['c', 'd'], [fx('f1', 'c', 'd')]),
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

const runPull = () =>
  puller.runMedicoachSync('dolphins', 'cron', {
    repo,
    url: stubUrl,
    secret: SECRET,
    log: (l) => logLines.push(l),
    captainsReports: {
      log: (l) => logLines.push(l),
      sendNotice: async (n) => {
        notices.push(n);
        return n.channels.map((channel) => ({ channel, status: 'sent' as const }));
      },
    },
  });

const reportsOf = async () =>
  (await repo.listCaptainsReports('dolphins')).sort((a, b) => a.id.localeCompare(b.id));

const tokenOf = (n: Notice) => n.url.split('/r/')[1];

const fullUmpire = (umpireId: string, name: string) => ({
  umpireId,
  name,
  ratings: { decisions: 4, pressure: 4, behaviour: 5, communication: 4, regulations: 2 },
  concerns: { lbw: true },
  otherConcern: '',
  comments: 'Solid',
});
const completeBody = {
  captainName: 'Sanele Mthembu',
  declaration: true,
  general: 'Good game',
  umpires: [fullUmpire('u-ngubane', 'A.Ngubane'), fullUmpire('u-dlamini', 'S.Dlamini')],
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
});

describe('result → reports → notices', () => {
  test('live result with a captainRef: captain link (chair cc) for the scoring side, chair for the other', async () => {
    await seedCaptain();
    page = liveResultPage('live');
    // The shared example names this player as the scoring side's captain.
    assert.equal((page as ReturnType<typeof example>).fixtures[0].result.captainRef, CAPTAIN_REF);
    await runPull();

    const reports = await reportsOf();
    assert.equal(reports.length, 2);
    const own = reports.find((r) => r.clubId === 'umzinto')!;
    const opp = reports.find((r) => r.clubId === 'african-warriors')!;
    assert.equal(own.status, 'pending');
    assert.equal(own.recipient.kind, 'captain');
    assert.equal(own.recipient.name, 'Sanele Mthembu');
    assert.equal(own.captainName, 'Sanele Mthembu');
    assert.equal(opp.recipient.kind, 'chair');
    assert.equal(opp.recipient.name, 'Awa Chair');
    assert.equal(own.matchDate, MATCH_DATE);
    assert.equal(own.resultSummary, 'Umzinto won by 23 runs');
    assert.deepEqual(
      own.umpiresSnapshot.map((u) => u.umpireId),
      ['u-ngubane', 'u-dlamini'],
    );
    // The player ref is never stored on the report.
    assert.ok(!JSON.stringify(reports).includes(CAPTAIN_KEY));

    assert.equal(notices.length, 2);
    const toCaptain = notices.find((n) => n.reportId === own.id)!;
    assert.equal(toCaptain.recipientKind, 'captain');
    assert.equal(toCaptain.to.email, 'captain@umzinto.test');
    assert.equal(toCaptain.ccEmail, 'chair@umzinto.test');
    assert.match(toCaptain.url, /\/r\/[^/]+$/);
    const toChair = notices.find((n) => n.reportId === opp.id)!;
    assert.equal(toChair.recipientKind, 'chair');
    assert.equal(toChair.to.email, 'chair@aw.test');
    assert.equal(toChair.ccEmail, undefined);

    // Nothing logged carries the player ref.
    assert.ok(!logLines.join('\n').includes(CAPTAIN_KEY));
  });

  test('a manual result goes to both chairs', async () => {
    page = example('changes-manual-and-cleared');
    page = { ...(page as object), hasMore: false };
    await runPull();
    const reports = (await reportsOf()).filter(
      (r) => r.seriesId === 's-planb-promotion-men-t20-g2',
    );
    assert.equal(reports.length, 2);
    assert.deepEqual(reports.map((r) => r.recipient.kind).sort(), ['chair', 'chair']);
    assert.deepEqual(notices.map((n) => n.to.email).sort(), ['chair@c.test', 'chair@d.test']);
  });

  test('an imported result opens no reports', async () => {
    await seedCaptain();
    page = liveResultPage('import');
    await runPull();
    assert.equal((await reportsOf()).length, 0);
    assert.equal(notices.length, 0);
  });

  test('no goLiveDate, or a match before it, opens nothing', async () => {
    await repo.putTenantConfig({
      ...(await repo.getTenantConfig('dolphins'))!,
      integrations: {},
    });
    page = liveResultPage('live');
    await runPull();
    assert.equal((await reportsOf()).length, 0);

    await resetTable();
    await seed(isoDay(0)); // go-live today ⇒ yesterday's match is before it
    page = liveResultPage('live');
    await runPull();
    assert.equal((await reportsOf()).length, 0);
  });

  test('a match older than 14 days opens nothing', async () => {
    const old = (await repo.getSeries('dolphins', 's-planb-premier-men-t20-g1'))!;
    await repo.putSeries('dolphins', {
      ...old,
      fixtures: [fx('f3', 'umzinto', 'african-warriors', { date: isoDay(-20) })],
    } as Series);
    page = liveResultPage('live');
    await runPull();
    assert.equal((await reportsOf()).length, 0);
  });

  test('a replay (re-pull of the same result) sends nothing again', async () => {
    await seedCaptain();
    page = liveResultPage('live');
    await runPull();
    assert.equal(notices.length, 2);
    await repo.putSyncCursor('dolphins', '0'); // force a full re-pull of the same page
    await runPull();
    assert.equal(notices.length, 2);
    assert.equal((await reportsOf()).length, 2);
  });

  test('a minor or contactless captain falls back to the chair', async () => {
    await seedCaptain({ isMinor: true });
    page = liveResultPage('live');
    await runPull();
    const own = (await reportsOf()).find((r) => r.clubId === 'umzinto')!;
    assert.equal(own.recipient.kind, 'chair');
    assert.equal(notices.find((n) => n.reportId === own.id)!.to.email, 'chair@umzinto.test');
  });

  test('a veterans captain resolves through the VETAFFIL# record to the primary club row', async () => {
    // The captain plays for umzinto's veterans side but is registered at african-warriors.
    await repo.createPlayer('dolphins', {
      naturalKey: CAPTAIN_KEY,
      clubId: 'african-warriors',
      firstName: 'Vet',
      lastName: 'Captain',
      email: 'vet@aw.test',
      isMinor: false,
    } as never);
    await repo.putVeteransAffiliation('dolphins', {
      naturalKey: CAPTAIN_KEY,
      playerName: 'Vet Captain',
      veteransClubId: 'umzinto',
      primaryClubId: 'african-warriors',
      primaryClubName: 'African Warriors',
      createdAt: '2026-09-01T00:00:00.000Z',
      source: 'admin',
    });
    page = liveResultPage('live');
    await runPull();
    const own = (await reportsOf()).find((r) => r.clubId === 'umzinto')!;
    assert.equal(own.recipient.kind, 'captain');
    assert.equal(notices.find((n) => n.reportId === own.id)!.to.email, 'vet@aw.test');
  });
});

describe('the submit-once link', () => {
  test('serves one report with no roster data; draft, submit, then 410', async () => {
    await seedCaptain();
    page = liveResultPage('live');
    await runPull();
    const own = (await reportsOf()).find((r) => r.clubId === 'umzinto')!;
    const token = tokenOf(notices.find((n) => n.reportId === own.id)!);

    const got = await app.request(`/captains-report-link/${token}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(got.headers.get('cache-control'), 'no-store');
    const body = (await got.json()) as {
      report: Record<string, unknown> & { recipient: Record<string, unknown> };
      registry: Array<{ id: string; displayName: string }>;
    };
    assert.equal(body.report.id, own.id);
    assert.equal(body.report.recipient.memberId, undefined);
    assert.deepEqual(Object.keys(body.report.recipient).sort(), ['kind', 'name']);
    assert.ok(!('players' in body) && !('roster' in body));
    assert.deepEqual(
      body.registry.map((u) => u.displayName),
      ['A.Ngubane', 'S.Dlamini'],
    );
    assert.ok(!JSON.stringify(body).includes('captain@umzinto.test'));

    const draft = await app.request(`/captains-report-link/${token}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ ...completeBody, declaration: false }),
    });
    assert.equal(draft.status, 200);
    assert.equal(((await draft.json()) as { report: CaptainsReport }).report.status, 'pending');

    const incomplete = await app.request(`/captains-report-link/${token}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ ...completeBody, declaration: false, submit: true }),
    });
    assert.equal(incomplete.status, 400);

    const submit = await app.request(`/captains-report-link/${token}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ ...completeBody, submit: true }),
    });
    assert.equal(submit.status, 200);
    const submitted = ((await submit.json()) as { report: CaptainsReport }).report;
    assert.equal(submitted.status, 'submitted');
    assert.match(submitted.ref!, new RegExp(`^CR-${MATCH_DATE.slice(0, 4)}-0001$`));
    assert.equal(submitted.submittedVia, 'link');

    assert.equal((await app.request(`/captains-report-link/${token}`)).status, 410);
    const again = await app.request(`/captains-report-link/${token}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ ...completeBody, submit: true }),
    });
    assert.equal(again.status, 410);
  });

  test('a forged or tampered token is 404', async () => {
    await seedCaptain();
    page = liveResultPage('live');
    await runPull();
    const token = tokenOf(notices[0]);
    const [payload, sig] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), e: 9e12 }),
    ).toString('base64url');
    assert.equal((await app.request(`/captains-report-link/${forgedPayload}.${sig}`)).status, 404);
    assert.equal((await app.request('/captains-report-link/not-a-token')).status, 404);
  });

  test('a portal submit kills the link (first submit wins)', async () => {
    await seedCaptain();
    page = liveResultPage('live');
    await runPull();
    const own = (await reportsOf()).find((r) => r.clubId === 'umzinto')!;
    const token = tokenOf(notices.find((n) => n.reportId === own.id)!);
    const res = await app.request(`/club/captains-reports/${encodeURIComponent(own.id)}`, {
      method: 'PUT',
      headers: headers(REP_UMZINTO),
      body: JSON.stringify({ ...completeBody, submit: true }),
    });
    assert.equal(res.status, 200);
    assert.equal((await app.request(`/captains-report-link/${token}`)).status, 410);
  });
});

describe('club routes', () => {
  test('a club reads its own reports and never another club’s', async () => {
    await seedCaptain();
    page = liveResultPage('live');
    await runPull();
    const own = (await reportsOf()).find((r) => r.clubId === 'umzinto')!;
    const opp = (await reportsOf()).find((r) => r.clubId === 'african-warriors')!;

    const list = await app.request('/club/captains-reports?clubId=umzinto', {
      headers: headers(REP_UMZINTO),
    });
    assert.equal(list.status, 200);
    const mine = (await list.json()) as Array<{ id: string; recipient: Record<string, unknown> }>;
    assert.deepEqual(
      mine.map((r) => r.id),
      [own.id],
    );
    assert.equal(mine[0].recipient.memberId, undefined);

    assert.equal(
      (
        await app.request('/club/captains-reports?clubId=african-warriors', {
          headers: headers(REP_UMZINTO),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await app.request(`/club/captains-reports/${encodeURIComponent(opp.id)}`, {
          headers: headers(REP_UMZINTO),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await app.request(`/club/captains-reports/${encodeURIComponent(opp.id)}`, {
          method: 'PUT',
          headers: headers(REP_UMZINTO),
          body: JSON.stringify({ ...completeBody, submit: true }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await app.request(`/club/captains-reports/${encodeURIComponent(opp.id)}`, {
          headers: headers(REP_AW),
        })
      ).status,
      200,
    );
  });

  test('a double submit is 409', async () => {
    page = liveResultPage('live');
    await runPull();
    const own = (await reportsOf()).find((r) => r.clubId === 'umzinto')!;
    const put = () =>
      app.request(`/club/captains-reports/${encodeURIComponent(own.id)}`, {
        method: 'PUT',
        headers: headers(REP_UMZINTO),
        body: JSON.stringify({ ...completeBody, submit: true }),
      });
    assert.equal((await put()).status, 200);
    const second = await put();
    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as { code: string }).code, 'report_closed');
  });

  test('an appointed pair rejects an unknown umpire id; a registry substitute is flagged', async () => {
    page = liveResultPage('live');
    await runPull();
    const own = (await reportsOf()).find((r) => r.clubId === 'umzinto')!;
    const url = `/club/captains-reports/${encodeURIComponent(own.id)}`;
    const bad = await app.request(url, {
      method: 'PUT',
      headers: headers(REP_UMZINTO),
      body: JSON.stringify({ ...completeBody, umpires: [fullUmpire('u-nobody', 'X')] }),
    });
    assert.equal(bad.status, 400);
    await repo.createUmpire('dolphins', {
      id: 'u-sub',
      displayName: 'B.Sub',
      aliases: ['bsub'],
      active: true,
    });
    const ok = await app.request(url, {
      method: 'PUT',
      headers: headers(REP_UMZINTO),
      body: JSON.stringify({
        ...completeBody,
        umpires: [fullUmpire('u-ngubane', 'A.Ngubane'), fullUmpire('u-sub', 'whatever')],
      }),
    });
    assert.equal(ok.status, 200);
    const saved = (await ok.json()) as CaptainsReport;
    assert.deepEqual(
      saved.umpires.map((u) => [u.umpireId, u.name, !!u.substitute]),
      [
        ['u-ngubane', 'A.Ngubane', false],
        ['u-sub', 'B.Sub', true],
      ],
    );
  });

  test('the portal files a manual report for a fixture without one (once)', async () => {
    const post = () =>
      app.request('/club/captains-reports', {
        method: 'POST',
        headers: headers(REP_UMZINTO),
        body: JSON.stringify({
          seriesId: 's-planb-premier-men-t20-g1',
          fixtureId: 'f3',
          clubId: 'umzinto',
          ...completeBody,
        }),
      });
    const first = await post();
    assert.equal(first.status, 201);
    const created = (await first.json()) as CaptainsReport;
    assert.equal(created.status, 'submitted');
    assert.equal(created.source, 'manual');
    assert.equal(created.opponentName, 'African Warriors');
    const second = await post();
    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as { code: string }).code, 'report_exists');
    // Not your fixture → 403.
    const foreign = await app.request('/club/captains-reports', {
      method: 'POST',
      headers: headers(REP_UMZINTO),
      body: JSON.stringify({
        seriesId: 's-planb-promotion-men-t20-g2',
        fixtureId: 'f7',
        clubId: 'umzinto',
        ...completeBody,
      }),
    });
    assert.equal(foreign.status, 403);
  });
});

describe('a cleared result', () => {
  test('voids pending reports (their links die) and flags submitted ones', async () => {
    await seedCaptain();
    page = liveResultPage('live');
    await runPull();
    const own = (await reportsOf()).find((r) => r.clubId === 'umzinto')!;
    const opp = (await reportsOf()).find((r) => r.clubId === 'african-warriors')!;
    const oppToken = tokenOf(notices.find((n) => n.reportId === opp.id)!);
    // Umzinto submits before the clear; African Warriors does not.
    await app.request(`/club/captains-reports/${encodeURIComponent(own.id)}`, {
      method: 'PUT',
      headers: headers(REP_UMZINTO),
      body: JSON.stringify({ ...completeBody, submit: true }),
    });

    // Cleared after the example's recordedAt (a clear only wins when it is newer).
    const live = liveResultPage('live');
    const clearedAt = new Date(Date.parse(live.fixtures[0].result.recordedAt) + 60_000);
    const cleared = {
      ...live,
      nextCursor: clearedAt.toISOString(),
      fixtures: [{ ...live.fixtures[0], result: null, resultClearedAt: clearedAt.toISOString() }],
    };
    page = cleared;
    await runPull();

    const after = await reportsOf();
    assert.equal(after.find((r) => r.id === opp.id)!.status, 'void');
    const flagged = after.find((r) => r.id === own.id)!;
    assert.equal(flagged.status, 'submitted');
    assert.ok(flagged.flagged?.reason);
    assert.equal((await app.request(`/captains-report-link/${oppToken}`)).status, 410);
  });
});

describe('admin list', () => {
  test('filters by status (incl. derived late) and date; reps are refused', async () => {
    await seedCaptain();
    page = liveResultPage('live');
    await runPull();
    const all = await app.request('/captains-reports', { headers: headers(ADMIN) });
    assert.equal(all.status, 200);
    assert.equal(((await all.json()) as unknown[]).length, 2);
    const pending = await app.request('/captains-reports?status=pending', {
      headers: headers(ADMIN),
    });
    assert.equal(((await pending.json()) as unknown[]).length, 2);
    const late = await app.request('/captains-reports?status=late', { headers: headers(ADMIN) });
    assert.equal(((await late.json()) as unknown[]).length, 0);
    const outOfRange = await app.request(`/captains-reports?to=${isoDay(-5)}`, {
      headers: headers(ADMIN),
    });
    assert.equal(((await outOfRange.json()) as unknown[]).length, 0);
    assert.equal(
      (await app.request('/captains-reports', { headers: headers(REP_UMZINTO) })).status,
      403,
    );
  });
});

describe('erasure', () => {
  test('eraseTenantData removes reports, counters and the NOTIFY# ledger', async () => {
    await seedCaptain();
    page = liveResultPage('live');
    await runPull();
    await repo.nextCaptainsReportRef('dolphins', '2026');
    await repo.eraseTenantData('dolphins');
    const { DynamoDBClient, ScanCommand } = await import('@aws-sdk/client-dynamodb');
    const c = new DynamoDBClient({
      endpoint: process.env.DYNAMO_ENDPOINT,
      region: 'localhost',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });
    const left = ((await c.send(new ScanCommand({ TableName: TABLE }))).Items ?? []).filter((i) =>
      String(i.pk?.S).includes('#CAPREPORT'),
    );
    assert.equal(left.length, 0);
  });
});
