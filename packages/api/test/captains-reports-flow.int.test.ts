/**
 * Captain's-report flow fixes (ADR 0016): withheld venue on the link, honest per-channel
 * delivery, the link-expiry window, "Send to captain", the one reminder, reports for matches
 * not in the fixture list, attributing free-text umpires, and the WhatsApp status webhook.
 *
 * Same harness as captains-reports.int.test.ts: a STUB medicoach serves the shared contract
 * examples, the REAL puller stores results against an in-process dynalite table, and the
 * REAL Hono app serves the routes. Only the outbound sender is replaced (`sendNotice`).
 * Dates are relative to the real clock (link tokens are verified against `Date.now()`).
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

const DDB_PORT = 4673;
const TABLE = 'SmartClubCaptainsReportsV2';
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
/** Yesterday: always inside the 7-day window, so the link is live. */
const MATCH_DATE = isoDay(-1);
const GO_LIVE = isoDay(-30);
const CAPTAIN_KEY = '0'.repeat(64); // the example's captainRef natural key

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

// ── Helpers for this file ──
type NoticeResultLike = import('../src/captains-reports.js').NoticeResult;
let respond: (n: Notice) => NoticeResultLike[] = (n) =>
  n.channels.map((channel, i) => ({
    channel,
    status: 'sent',
    messageId: `wamid.${n.reportId}.${channel}.${i}`,
  }));

const defaultRespond = respond;
beforeEach(async () => {
  respond = defaultRespond;
  // Routes (forward) use the module's default sender: capture it the same way.
  const { setDefaultReportNoticeSender } = await import('../src/captains-reports.js');
  setDefaultReportNoticeSender(capture.sendNotice);
});
after(async () => {
  const { setDefaultReportNoticeSender } = await import('../src/captains-reports.js');
  setDefaultReportNoticeSender(undefined);
});

const capture = {
  log: (l: string) => logLines.push(l),
  sendNotice: async (n: Notice) => {
    notices.push(n);
    return respond(n);
  },
};

const pull = (nowIso?: string) =>
  puller.runMedicoachSync('dolphins', 'cron', {
    repo,
    url: stubUrl,
    secret: SECRET,
    ...(nowIso ? { now: () => new Date(nowIso) } : {}),
    log: (l) => logLines.push(l),
    captainsReports: capture,
  });

const own = async () => (await reportsOf()).find((r) => r.clubId === 'umzinto')!;
const opp = async () => (await reportsOf()).find((r) => r.clubId === 'african-warriors')!;
const linkGet = (token: string, suffix = '') =>
  app.request(`/captains-report-link/${token}${suffix}`);
const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
const clubPath = (id: string, suffix = '') =>
  `/club/captains-reports/${encodeURIComponent(id)}${suffix}`;
const ROSTER_REP = REP_UMZINTO;

async function setWithheld(withheld: Record<string, true> | undefined) {
  const s = (await repo.getSeries('dolphins', 's-planb-premier-men-t20-g1'))!;
  const next = { ...s } as Series & { withheld?: unknown };
  if (withheld) next.withheld = withheld;
  else delete next.withheld;
  await repo.putSeries('dolphins', next as Series);
}

// ── 1. Withheld venue ──
describe('a series that withholds its venue', () => {
  test('the report stores no venue; the link and the club portal show none until the reveal', async () => {
    await setWithheld({ venue: true, time: true });
    await seedCaptain();
    page = liveResultPage('live');
    await pull();
    const report = await own();
    assert.equal(report.venue, undefined, 'no venue snapshot while withheld');
    const token = tokenOf(notices.find((n) => n.reportId === report.id)!);

    const linked = await json<{ report: Record<string, unknown> }>(await linkGet(token));
    assert.equal(linked.report.venue, undefined);
    assert.equal(linked.report.venueWithheld, true);
    assert.ok(!JSON.stringify(linked).includes('Kingsmead'));

    const portal = await json<Record<string, unknown>>(
      await app.request(clubPath(report.id), { headers: headers(ROSTER_REP) }),
    );
    assert.equal(portal.venue, undefined);
    assert.equal(portal.venueWithheld, true);
    const list = await json<Array<Record<string, unknown>>>(
      await app.request('/club/captains-reports?clubId=umzinto', { headers: headers(ROSTER_REP) }),
    );
    assert.ok(!JSON.stringify(list).includes('Kingsmead'));

    // The reveal: the next read shows the venue (re-evaluated at read time).
    await setWithheld(undefined);
    const after = await json<{ report: Record<string, unknown> }>(await linkGet(token));
    assert.equal(after.report.venue, 'Kingsmead Oval');
    assert.equal(after.report.venueWithheld, undefined);
    const portalAfter = await json<Record<string, unknown>>(
      await app.request(clubPath(report.id), { headers: headers(ROSTER_REP) }),
    );
    assert.equal(portalAfter.venue, 'Kingsmead Oval');
  });

  test('a series that withholds only the time still shows the venue', async () => {
    await setWithheld({ time: true });
    page = liveResultPage('live');
    await pull();
    const report = await own();
    assert.equal(report.venue, 'Kingsmead Oval');
  });
});

// ── 2. Honest delivery status ──
describe('per-channel delivery on each report', () => {
  test('records each channel with its reason; notifiedAt only when something was sent', async () => {
    // umzinto chair: email + cell; african-warriors chair: email only.
    respond = (n) =>
      n.channels.map((channel) =>
        channel === 'whatsapp' && !n.to.cell
          ? { channel, status: 'skipped', reason: 'no-cell' }
          : { channel, status: 'sent', messageId: `wamid.${n.reportId}.${channel}` },
      );
    page = liveResultPage('live');
    await pull();
    const a = await opp();
    assert.ok(a.notifiedAt, 'email went out');
    assert.deepEqual(
      a.deliveries!.map((d) => [d.channel, d.status, d.reason ?? null, d.purpose, d.recipientKind]),
      [
        ['email', 'sent', null, 'opened', 'chair'],
        ['whatsapp', 'skipped', 'no-cell', 'opened', 'chair'],
      ],
    );
    // Views never carry provider message ids or contact details.
    const admin = await json<Array<Record<string, unknown>>>(
      await app.request('/captains-reports', { headers: headers(ADMIN) }),
    );
    const text = JSON.stringify(admin);
    assert.ok(!text.includes('wamid.'), 'no message ids served');
    assert.ok(!text.includes('chairMemberId') && !text.includes('recipientContact'));
    const row = admin.find((r) => r.id === a.id)!;
    assert.equal((row.deliveries as unknown[]).length, 2);
  });

  test('a club with no chair contact: "no-contact" on every channel, never notified', async () => {
    const c = (await repo.getClub('dolphins', 'african-warriors'))!;
    await repo.putClub('dolphins', { ...c, exco: { chair: { name: 'Awa Chair' } } } as never);
    page = liveResultPage('live');
    await pull();
    const a = await opp();
    assert.equal(a.notifiedAt, undefined);
    assert.deepEqual(
      a.deliveries!.map((d) => [d.channel, d.status, d.reason]),
      [
        ['email', 'skipped', 'no-contact'],
        ['whatsapp', 'skipped', 'no-contact'],
      ],
    );
    assert.ok(!logLines.some((l) => /notified 2/.test(l)), 'not counted as notified');

    const gaps = await json<{ clubs: Array<{ id: string; name: string }> }>(
      await app.request('/captains-reports/contact-gaps', { headers: headers(ADMIN) }),
    );
    assert.deepEqual(
      gaps.clubs.map((g) => g.id),
      ['african-warriors'],
    );
    assert.equal(
      (await app.request('/captains-reports/contact-gaps', { headers: headers(REP_UMZINTO) }))
        .status,
      403,
    );
  });

  test('the real sender in dry-run records "dry-run", not "sent"', async () => {
    page = liveResultPage('live');
    const { setDefaultReportNoticeSender } = await import('../src/captains-reports.js');
    setDefaultReportNoticeSender(undefined); // the real SES + Meta senders (NOTIFY_DRY_RUN=1)
    await puller.runMedicoachSync('dolphins', 'cron', {
      repo,
      url: stubUrl,
      secret: SECRET,
      log: () => {},
      captainsReports: { log: () => {} },
    });
    const a = await own();
    assert.equal(a.notifiedAt, undefined);
    assert.ok(a.deliveries!.length >= 1);
    for (const d of a.deliveries!) {
      assert.equal(d.status, 'skipped');
      assert.equal(d.reason, 'dry-run');
    }
  });
});

// ── 5. Expiry window ──
describe('the link expiry window', () => {
  test('max(match + 7 days, result received + 3 days), at 23:59:59 SAST', async () => {
    const { reportLinkExpiry } = await import('../src/captains-reports.js');
    const iso = (s: number) => new Date(s * 1000).toISOString();
    // Received the day after: the match rule wins.
    assert.equal(
      iso(reportLinkExpiry('2026-10-04', Date.parse('2026-10-05T10:00:00Z'))),
      '2026-10-11T21:59:59.000Z',
    );
    // Received 8 days later: received + 3 wins.
    assert.equal(
      iso(reportLinkExpiry('2026-10-04', Date.parse('2026-10-12T10:00:00Z'))),
      '2026-10-15T21:59:59.000Z',
    );
    const { fmtExpiry } = await import('../src/captains-reports.js');
    assert.equal(fmtExpiry(reportLinkExpiry('2026-10-04')), 'Sunday, 11 Oct');
    // 23:30Z on 12 Oct is already 13 Oct in SAST.
    assert.equal(
      iso(reportLinkExpiry('2026-10-04', Date.parse('2026-10-12T23:30:00Z'))),
      '2026-10-16T21:59:59.000Z',
    );
  });

  test('a late result for an older match still opens, and the expiry is stored and shown', async () => {
    const s = (await repo.getSeries('dolphins', 's-planb-premier-men-t20-g1'))!;
    await repo.putSeries('dolphins', {
      ...s,
      fixtures: [fx('f3', 'umzinto', 'african-warriors', { date: isoDay(-10) })],
    } as Series);
    page = liveResultPage('live');
    await pull();
    const report = await own();
    assert.equal(report.status, 'pending');
    const { reportLinkExpiry } = await import('../src/captains-reports.js');
    const expected = reportLinkExpiry(isoDay(-10), Date.now());
    assert.equal(report.linkExpiresAt, new Date(expected * 1000).toISOString());
    const token = tokenOf(notices.find((n) => n.reportId === report.id)!);
    const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    assert.equal(payload.e, expected, 'the token carries the stored expiry');
    const linked = await json<{ report: Record<string, unknown> }>(await linkGet(token));
    assert.equal(linked.report.linkExpiresAt, report.linkExpiresAt);
  });
});

// ── 4. Chair sends the report on to the match captain ──
async function seedRoster() {
  const p = (key: string, first: string, over: Record<string, unknown> = {}) =>
    repo.createPlayer('dolphins', {
      naturalKey: key,
      clubId: 'umzinto',
      firstName: first,
      lastName: 'Player',
      isMinor: false,
      status: 'active',
      email: `${first.toLowerCase()}@umzinto.test`,
      ...over,
    } as never);
  await p('k-adult', 'Adult');
  await p('k-cellonly', 'Cellonly', { email: undefined, cell: '0820000002' });
  await p('k-minor', 'Minor', { isMinor: true });
  await p('k-nocontact', 'Nocontact', { email: undefined });
  await p('k-inactive', 'Inactive', { status: 'inactive' });
  await repo.createPlayer('dolphins', {
    naturalKey: 'k-other-club',
    clubId: 'african-warriors',
    firstName: 'Other',
    lastName: 'Club',
    isMinor: false,
    email: 'other@aw.test',
  } as never);
}

describe('Send to captain', () => {
  async function chairLink() {
    page = liveResultPage('manual'); // manual result: both sides go to the chairs
    await pull();
    const report = await own();
    assert.equal(report.recipient.kind, 'chair');
    return { report, token: tokenOf(notices.find((n) => n.reportId === report.id)!) };
  }

  test('a chair link lists eligible own-club players by name only, and forwards', async () => {
    await seedRoster();
    const { report, token } = await chairLink();
    const linked = await json<{ canForward: boolean }>(await linkGet(token));
    assert.equal(linked.canForward, true);

    const cands = await json<{
      candidates: Array<{ id: string; name: string }>;
      remaining: number;
    }>(await linkGet(token, '/forward-candidates'));
    assert.deepEqual(
      cands.candidates.map((c) => c.name),
      ['Adult Player', 'Cellonly Player'],
    );
    assert.equal(cands.remaining, 3);
    for (const c of cands.candidates) assert.deepEqual(Object.keys(c).sort(), ['id', 'name']);
    const text = JSON.stringify(cands);
    assert.ok(!text.includes('k-adult') && !text.includes('@umzinto.test'));

    notices.length = 0;
    const fwd = await app.request(`/captains-report-link/${token}/forward`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ candidateId: cands.candidates[0].id }),
    });
    assert.equal(fwd.status, 200);
    assert.equal(notices.length, 1);
    const n = notices[0];
    assert.equal(n.recipientKind, 'captain');
    assert.equal(n.to.email, 'adult@umzinto.test');
    assert.equal(n.ccEmail, 'chair@umzinto.test');
    assert.equal(n.forwardedBy, 'Uma Chair');

    const after = await own();
    assert.equal(after.recipient.kind, 'captain');
    assert.equal(after.recipient.name, 'Adult Player');
    assert.equal(after.recipient.forwardedBy?.name, 'Uma Chair');
    assert.equal(after.forwardCount, 1);
    assert.equal(after.deliveries!.filter((d) => d.purpose === 'forwarded').length, 2);
    assert.ok(!JSON.stringify(after).includes('k-adult'), 'no roster key stored');

    // The chair keeps their link; the captain's link has no roster access.
    assert.equal((await linkGet(token)).status, 200);
    const capToken = tokenOf(n);
    const cap = await json<{ canForward: boolean }>(await linkGet(capToken));
    assert.equal(cap.canForward, false);
    assert.equal((await linkGet(capToken, '/forward-candidates')).status, 403);

    // First submit wins: the captain submits, the chair's link closes.
    const submit = await app.request(`/captains-report-link/${capToken}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ ...completeBody, umpires: completeBody.umpires, submit: true }),
    });
    assert.equal(submit.status, 200);
    assert.equal((await linkGet(token)).status, 410);
    assert.equal(report.id, after.id);
  });

  test('the old chair link can still submit after a forward (first submit wins)', async () => {
    await seedRoster();
    const { token } = await chairLink();
    const cands = await json<{ candidates: Array<{ id: string }> }>(
      await linkGet(token, '/forward-candidates'),
    );
    await app.request(`/captains-report-link/${token}/forward`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ candidateId: cands.candidates[0].id }),
    });
    const capToken = tokenOf(notices[notices.length - 1]);
    const submit = await app.request(`/captains-report-link/${token}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ ...completeBody, submit: true }),
    });
    assert.equal(submit.status, 200);
    assert.equal((await linkGet(capToken)).status, 410);
  });

  test('at most 3 forwards; an unknown or ineligible candidate is refused', async () => {
    await seedRoster();
    const { token } = await chairLink();
    const cands = await json<{ candidates: Array<{ id: string }> }>(
      await linkGet(token, '/forward-candidates'),
    );
    const forward = (candidateId: string) =>
      app.request(`/captains-report-link/${token}/forward`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ candidateId }),
      });
    assert.equal((await forward('not-a-candidate')).status, 404);
    for (let i = 0; i < 3; i++)
      assert.equal((await forward(cands.candidates[i % 2].id)).status, 200);
    const fourth = await forward(cands.candidates[0].id);
    assert.equal(fourth.status, 429);
    assert.equal((await own()).forwardCount, 3);
  });

  test('a captain link (auto-addressed) cannot forward or list the roster', async () => {
    await seedCaptain();
    await seedRoster();
    page = liveResultPage('live');
    await pull();
    const report = await own();
    assert.equal(report.recipient.kind, 'captain');
    const token = tokenOf(notices.find((n) => n.reportId === report.id)!);
    assert.equal((await linkGet(token, '/forward-candidates')).status, 403);
    const fwd = await app.request(`/captains-report-link/${token}/forward`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ candidateId: 'x' }),
    });
    assert.equal(fwd.status, 403);
  });

  test('the club portal can send a pending report to a captain; other clubs cannot', async () => {
    await seedRoster();
    const { report } = await chairLink();
    const cands = await json<{ candidates: Array<{ id: string; name: string }> }>(
      await app.request(clubPath(report.id, '/forward-candidates'), {
        headers: headers(REP_UMZINTO),
      }),
    );
    assert.deepEqual(
      cands.candidates.map((c) => c.name),
      ['Adult Player', 'Cellonly Player'],
    );
    assert.equal(
      (
        await app.request(clubPath(report.id, '/forward-candidates'), {
          headers: headers(REP_AW),
        })
      ).status,
      403,
    );
    notices.length = 0;
    const fwd = await app.request(clubPath(report.id, '/forward'), {
      method: 'POST',
      headers: headers(REP_UMZINTO),
      body: JSON.stringify({ candidateId: cands.candidates[1].id }),
    });
    assert.equal(fwd.status, 200);
    const view = await json<{
      recipient: { kind: string; name: string; forwardedBy?: { via: string } };
    }>(fwd);
    assert.equal(view.recipient.kind, 'captain');
    assert.equal(view.recipient.forwardedBy?.via, 'portal');
    assert.equal(notices[0].to.cell, '0820000002');
  });
});

// ── 9. One reminder before the link expires ──
describe('the reminder', () => {
  test('goes once, 2 days before expiry, to the current recipient with the same link', async () => {
    page = liveResultPage('manual');
    await pull();
    const report = await own();
    const firstToken = tokenOf(notices.find((n) => n.reportId === report.id)!);
    const expiryMs = Date.parse(report.linkExpiresAt!);
    const { sendReportReminders } = await import('../src/captains-reports.js');
    const at = (ms: number) => ({ repo, now: () => new Date(ms), ...capture });

    notices.length = 0;
    let sum = await sendReportReminders('dolphins', at(expiryMs - 3 * DAY));
    assert.equal(sum.sent, 0, 'too early');
    sum = await sendReportReminders('dolphins', at(expiryMs - 2 * DAY + 60_000));
    const mine = notices.filter((n) => n.reportId === report.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].reminder, true);
    assert.equal(tokenOf(mine[0]), firstToken, 'link unchanged');
    const after = await own();
    assert.ok(after.reminderSentAt);
    assert.equal(after.deliveries!.filter((d) => d.purpose === 'reminder').length, 2);

    notices.length = 0;
    await sendReportReminders('dolphins', at(expiryMs - DAY));
    assert.equal(notices.length, 0, 'at most once');
  });

  test('never for a submitted report or after the link expired', async () => {
    page = liveResultPage('manual');
    await pull();
    const report = await own();
    const expiryMs = Date.parse(report.linkExpiresAt!);
    await app.request(clubPath(report.id), {
      method: 'PUT',
      headers: headers(REP_UMZINTO),
      body: JSON.stringify({ ...completeBody, submit: true }),
    });
    const { sendReportReminders } = await import('../src/captains-reports.js');
    notices.length = 0;
    await sendReportReminders('dolphins', {
      repo,
      now: () => new Date(expiryMs - DAY),
      ...capture,
    });
    assert.equal(notices.filter((n) => n.reportId === report.id).length, 0);
    notices.length = 0;
    await sendReportReminders('dolphins', {
      repo,
      now: () => new Date(expiryMs + 1000),
      ...capture,
    });
    assert.equal(notices.length, 0);
  });

  test('the sync run sends due reminders (sync-enabled tenants only)', async () => {
    page = liveResultPage('manual');
    await pull();
    const report = await own();
    const expiryMs = Date.parse(report.linkExpiresAt!);
    const { runTenantSync } = await import('../src/medicoach-sync/run.js');
    notices.length = 0;
    page = { ...(page as object), fixtures: [], hasMore: false };
    const summary = await runTenantSync('dolphins', 'cron', {
      repo,
      url: stubUrl,
      secret: SECRET,
      now: () => new Date(expiryMs - DAY),
      log: () => {},
      captainsReports: capture,
    });
    assert.equal(summary.reminders?.sent, 2);
    assert.equal(notices.filter((n) => n.reminder).length, 2);
  });
});

// ── 6. A match that isn't in the fixture list ──
describe('reporting a match that is not listed', () => {
  const body = {
    clubId: 'umzinto',
    opponentName: 'Old Boys XI',
    matchDate: isoDay(-2),
    competition: 'Friendly',
    venue: 'Umzinto Oval',
    ...completeBody,
    umpires: [
      fullUmpire('u-ngubane', 'A.Ngubane'),
      { ...fullUmpire('', 'J. Free Text'), umpireId: undefined },
    ],
  };

  test('files and submits a manual-unlisted report', async () => {
    const res = await app.request('/club/captains-reports/unlisted', {
      method: 'POST',
      headers: headers(REP_UMZINTO),
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 201);
    const r = await json<CaptainsReport>(res);
    assert.equal(r.source, 'manual-unlisted');
    assert.equal(r.status, 'submitted');
    assert.match(r.ref!, /^CR-/);
    assert.equal(r.opponentName, 'Old Boys XI');
    assert.equal(r.venue, 'Umzinto Oval');
    assert.equal(r.competition, 'Friendly');
    assert.equal(r.clubName, 'Umzinto CC');
    assert.deepEqual(
      r.umpires.map((u) => [u.umpireId ?? null, u.name]),
      [
        ['u-ngubane', 'A.Ngubane'],
        [null, 'J. Free Text'],
      ],
    );
    const admin = await json<CaptainsReport[]>(
      await app.request('/captains-reports', { headers: headers(ADMIN) }),
    );
    assert.equal(admin.find((x) => x.id === r.id)?.source, 'manual-unlisted');
  });

  test('refuses a future date, a missing opponent, and another club', async () => {
    const post = (b: unknown, auth = REP_UMZINTO) =>
      app.request('/club/captains-reports/unlisted', {
        method: 'POST',
        headers: headers(auth),
        body: JSON.stringify(b),
      });
    const future = await post({ ...body, matchDate: isoDay(2) });
    assert.equal(future.status, 400);
    assert.equal((await json<{ code?: string }>(future)).code, 'match_in_future');
    assert.equal((await post({ ...body, opponentName: '  ' })).status, 400);
    assert.equal((await post({ ...body, matchDate: 'yesterday' })).status, 400);
    assert.equal((await post(body, REP_AW)).status, 403);
  });
});

// ── 7. Attributing free-text umpires ──
describe('a free-text umpire on a filed report', () => {
  async function filedWithFreeText() {
    const res = await app.request('/club/captains-reports/unlisted', {
      method: 'POST',
      headers: headers(REP_UMZINTO),
      body: JSON.stringify({
        clubId: 'umzinto',
        opponentName: 'Old Boys XI',
        matchDate: isoDay(-2),
        competition: 'Friendly',
        ...completeBody,
        umpires: [{ ...fullUmpire('', 'Sbu Dlamini'), umpireId: undefined }],
      }),
    });
    return json<CaptainsReport>(res);
  }
  const attribute = (id: string, index: number, b: unknown, auth = ADMIN) =>
    app.request(`/captains-reports/${encodeURIComponent(id)}/umpires/${index}/attribute`, {
      method: 'POST',
      headers: headers(auth),
      body: JSON.stringify(b),
    });

  test('the admin links it to a registry umpire, with an audit stamp', async () => {
    const r = await filedWithFreeText();
    const res = await attribute(r.id, 0, { umpireId: 'u-dlamini', action: 'linked' });
    assert.equal(res.status, 200);
    const out = await json<CaptainsReport>(res);
    assert.equal(out.umpires[0].umpireId, 'u-dlamini');
    assert.equal(out.umpires[0].name, 'S.Dlamini');
    assert.equal(out.umpires[0].attributed?.action, 'linked');
    assert.equal(out.umpires[0].attributed?.freeTextName, 'Sbu Dlamini');
    assert.equal(out.umpires[0].attributed?.by, 'admin@test');
    assert.equal(out.umpires[0].ratings.decisions, 4, 'ratings kept');
    // Already attributed ⇒ 409; unknown umpire ⇒ 400; reps ⇒ 403; bad index ⇒ 404.
    assert.equal(
      (await attribute(r.id, 0, { umpireId: 'u-ngubane', action: 'linked' })).status,
      409,
    );
    assert.equal((await attribute(r.id, 5, { umpireId: 'u-ngubane' })).status, 404);
    assert.equal((await attribute(r.id, 0, { umpireId: 'u-ngubane' }, REP_UMZINTO)).status, 403);
  });

  test('an unknown registry id is refused', async () => {
    const r = await filedWithFreeText();
    assert.equal((await attribute(r.id, 0, { umpireId: 'nobody', action: 'linked' })).status, 400);
  });
});

// ── 8. WhatsApp statuses forwarded by medicoach ──
describe('POST /integrations/whatsapp/status (forwarded by medicoach, sync-signed)', () => {
  const PATH = '/integrations/whatsapp/status';
  const status = (id: string, st: string, ts: number, errors?: unknown[]) => ({
    id,
    status: st,
    timestamp: String(ts),
    recipient_id: '27820000001',
    ...(errors ? { errors } : {}),
  });
  const forwarded = (...statuses: unknown[]) => JSON.stringify({ statuses });
  const post = (body: string, opts: { secret?: string; timestamp?: number; sign?: boolean } = {}) =>
    app.request(PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.sign === false
          ? {}
          : contract.signRequest({
              secret: opts.secret ?? SECRET,
              method: 'POST',
              pathAndQuery: PATH,
              body,
              ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
            })),
      },
      body,
    });
  const withSyncSecret = async (value: string | undefined, fn: () => Promise<void>) => {
    const prev = process.env.MEDICOACH_SYNC_SECRET;
    if (value === undefined) delete process.env.MEDICOACH_SYNC_SECRET;
    else process.env.MEDICOACH_SYNC_SECRET = value;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.MEDICOACH_SYNC_SECRET;
      else process.env.MEDICOACH_SYNC_SECRET = prev;
    }
  };

  test('fails closed without the sync secret, unsigned, mis-signed or stale', async () => {
    const body = forwarded(status('wamid.x', 'delivered', 1));
    await withSyncSecret('', async () => {
      assert.equal((await post(body)).status, 401);
    });
    await withSyncSecret(SECRET, async () => {
      assert.equal((await post(body, { sign: false })).status, 401);
      assert.equal((await post(body, { secret: 'wrong' })).status, 401);
      assert.equal((await post(body, { timestamp: Date.now() - 10 * 60_000 })).status, 401);
      const ok = await post(body);
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { matched: 0, unknown: 1, stale: 0 });
    });
  });

  test('matches statuses by message id onto the report delivery; never downgrades', async () => {
    respond = (n) =>
      n.channels.map((channel) => ({
        channel,
        status: 'sent',
        messageId: `wamid.${channel}.${n.to.email}`,
      }));
    page = liveResultPage('manual');
    await pull();
    const r = await own();
    assert.equal(r.deliveries!.find((d) => d.channel === 'whatsapp')!.status, 'sent');
    const id = 'wamid.whatsapp.chair@umzinto.test';
    const t0 = Math.floor(Date.now() / 1000);
    const wa = async () => (await own()).deliveries!.find((d) => d.channel === 'whatsapp')!;

    await withSyncSecret(SECRET, async () => {
      assert.equal((await post(forwarded(status(id, 'delivered', t0)))).status, 200);
      assert.equal((await wa()).providerStatus, 'delivered');

      await post(forwarded(status(id, 'read', t0 + 5)));
      await post(forwarded(status(id, 'delivered', t0 + 10))); // late, out of order
      const read = await wa();
      assert.equal(read.providerStatus, 'read');
      assert.ok(read.providerAt);

      // Meta's own envelope is accepted too.
      const envelope = JSON.stringify({
        entry: [{ changes: [{ value: { statuses: [status('wamid.unknown', 'read', t0)] } }] }],
      });
      assert.equal((await post(envelope)).status, 200);

      // A failed message on the other report shows Meta's error title.
      const otherId = (await opp()).deliveries!.find((d) => d.channel === 'whatsapp')!.messageId!;
      await post(
        forwarded(
          status(otherId, 'failed', t0, [{ code: 131026, title: 'Message undeliverable' }]),
        ),
      );
      const failed = (await opp()).deliveries!.find((d) => d.channel === 'whatsapp')!;
      assert.equal(failed.providerStatus, 'failed');
      assert.equal(failed.providerError, 'Message undeliverable');
    });
  });
});
