/**
 * Chair scorecard confirmations end to end against an in-process dynalite table (real repo):
 * the Monday cron (`runScorecardConfirmations`) builds one digest per club per week, the REAL
 * Hono app serves the public `/scorecard-confirm-link/:token` routes and the operator
 * `/platform/scorecard-confirmations` routes, and the REAL medicoach puller / scorecard fetch
 * void and stale-flag entries.
 *
 * Replaced: the outbound senders (the chair digest notice and the operator correction email
 * are captured) and medicoach's HTTP (a fake `fetch`).
 *
 * Dates are relative to the real clock: link tokens are verified against `Date.now()`, so the
 * week under test is always the most recent completed one.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type {
  ScorecardConfirmation,
  Series,
  StoredFixtureResult,
  TenantConfig,
  UserProfile,
} from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4701;
const TABLE = 'SmartClubScorecardConfirmations';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const T = 'dolphins';
const S1 = 's-premier';
const S2 = 's-promotion';

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let sc: typeof import('../src/scorecard-confirmations.js');
let cron: typeof import('../src/crons/scorecard-confirmations-run.js');
let puller: typeof import('../src/medicoach-sync/puller.js');
let fetchMod: typeof import('../src/medicoach-sync/scorecard-fetch.js');

let WEEK = '';
let MON = '';
let SAT = '';
let SUN = '';
const dayBefore = (d: string) =>
  new Date(Date.parse(`${d}T00:00:00Z`) - 24 * 3600 * 1000).toISOString().slice(0, 10);

const devAuth = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const OPERATOR = devAuth('op-1', 'ops1@platform.test', [
  { tenantId: '*', role: 'operator', clubIds: [] },
]);
const ADMIN = devAuth('adm', 'admin@union.test', [{ tenantId: T, role: 'admin', clubIds: [] }]);
const json = (auth?: string) => ({
  'content-type': 'application/json',
  ...(auth ? { 'x-dev-auth': auth } : {}),
});

// ── Captured senders ──
type Notice = import('../src/scorecard-confirmations.js').ScorecardNotice;
type Correction = import('../src/scorecard-confirmations.js').ScorecardCorrectionNotice;
const notices: Notice[] = [];
const corrections: Correction[] = [];
const captureNotice = async (n: Notice) => {
  notices.push(n);
  return n.channels.map((channel) => ({ channel, status: 'sent' as const }));
};

const run = (over: Record<string, unknown> = {}) =>
  cron.runScorecardConfirmations({
    sendNotice: captureNotice,
    log: () => {},
    captureException: (err) => {
      throw err;
    },
    ...over,
  });

// ── Seed ──
const club = (
  id: string,
  name: string,
  chair: { name: string; email?: string; cell?: string },
  over: Record<string, unknown> = {},
) =>
  ({
    id,
    name,
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
    ground: { venue: 'Home Ground' },
    leagues: ['premier'],
    ...over,
  }) as never;

const fx = (id: string, date: string, home: string, away: string) => ({
  id,
  round: 1,
  date,
  time: '09:00',
  home,
  away,
});

const series = (
  id: string,
  name: string,
  parts: Array<[teamId: string, clubId: string, name: string]>,
  fixtures: unknown[],
): Series =>
  ({
    id,
    name,
    leagueKey: 'premier',
    startDate: MON,
    teams: parts.map((p) => p[0]),
    participants: parts.map(([teamId, clubId, n]) => ({
      teamId,
      clubId,
      name: n,
      venue: `${n} Oval`,
    })),
    fixtures,
    kind: 'series',
    approved: true,
    released: true,
    releasedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  }) as unknown as Series;

async function putConfig(over: Record<string, unknown> = {}) {
  await repo.putTenantConfig({
    tenant: T,
    branding: { name: 'KZN Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: { medicoachSync: true },
    integrations: { medicoach: { goLiveDate: '2020-01-01' } },
    scorecardConfirmations: { enabled: true },
    ...over,
  } as unknown as TenantConfig);
}

const storeResult = (
  seriesId: string,
  fixtureId: string,
  over: Partial<StoredFixtureResult> = {},
) =>
  repo.putFixtureResultIfNewer(T, {
    seriesId,
    fixtureId,
    ref: `smartclub:${T}:fixture:${seriesId}:${fixtureId}`,
    orderAt: '2026-01-02T10:00:00.000Z',
    recordedAt: '2026-01-02T10:00:00.000Z',
    resultSource: 'live',
    homeScore: '184/6 (20)',
    awayScore: '161/9 (20)',
    summary: 'Home won by 23 runs',
    winner: 'home',
    medicoachMatchUrl: 'https://medicoach.example/match/1',
    medicoachMatchId: `pma-${fixtureId}`,
    medicoachTournamentId: 'tour-9',
    storedAt: '2026-01-02T10:00:00.000Z',
    ...over,
  });

const innings = () => [
  {
    battingTeamName: 'Umzinto 1sts',
    totalRuns: 184,
    wickets: 6,
    overs: '20.0',
    extras: { byes: 0, legByes: 1, wides: 4, noBalls: 0, penalties: 0, total: 5 },
    batters: [
      {
        order: 1,
        name: 'A Batter',
        runs: 64,
        ballsFaced: 41,
        fours: 6,
        sixes: 3,
        strikeRate: 156.1,
        howOut: 'not out',
      },
    ],
    bowlers: [
      {
        order: 1,
        name: 'C Bowler',
        overs: '4.0',
        maidens: 0,
        runsConceded: 31,
        wickets: 2,
        economy: 7.75,
        wides: 2,
        noBalls: 0,
      },
    ],
    fallOfWickets: [{ wicket: 1, runs: 22, overs: '2.6', batterName: 'B Batter' }],
  },
];

async function seed() {
  await putConfig();
  await repo.createClub(
    T,
    club('umzinto', 'Umzinto CC', {
      name: 'Uma Chair',
      email: 'chair@umzinto.test',
      cell: '0821234567',
    }),
  );
  await repo.createClub(
    T,
    club('african-warriors', 'African Warriors', { name: 'Awa Chair', email: 'chair@aw.test' }),
  );
  // Opted out of chair notices; and a club whose chair has no contact at all.
  await repo.createClub(
    T,
    club('c', 'C Club', { name: 'C Chair', email: 'chair@c.test' }, { remindersOptIn: false }),
  );
  await repo.createClub(T, club('d', 'D Club', { name: 'D Chair' }));
  await repo.putSeries(
    T,
    series(
      S1,
      'Premier T20',
      [
        ['umz-1', 'umzinto', 'Umzinto 1sts'],
        ['aw-1', 'african-warriors', 'African Warriors'],
      ],
      [
        fx('f1', SAT, 'umz-1', 'aw-1'), // live result
        fx('f2', SUN, 'aw-1', 'umz-1'), // import result → never in a digest
        fx('f3', MON, 'umz-1', 'aw-1'), // result arrives late (top-up)
        fx('f0', dayBefore(MON), 'umz-1', 'aw-1'), // the week before → out of window
      ],
    ),
  );
  await repo.putSeries(
    T,
    series(
      S2,
      'Promotion T20',
      [
        ['c', 'c', 'C Club'],
        ['d', 'd', 'D Club'],
      ],
      [fx('f7', SAT, 'c', 'd')],
    ),
  );
  await storeResult(S1, 'f1');
  await storeResult(S1, 'f2', { resultSource: 'import' });
  await storeResult(S1, 'f0');
  await storeResult(S2, 'f7', { resultSource: 'manual', medicoachMatchUrl: null });
  const users: UserProfile[] = [
    {
      sub: 'op-1',
      email: 'Ops1@Platform.test',
      memberships: [{ tenantId: '*', role: 'operator', clubIds: [] }],
      onboardingSeen: {},
    },
    {
      // An operator who is ALSO a tenant admin (operator auto-admin).
      sub: 'op-2',
      email: 'ops2@platform.test',
      memberships: [
        { tenantId: T, role: 'admin', clubIds: [] },
        { tenantId: '*', role: 'operator', clubIds: [] },
      ],
      onboardingSeen: {},
    },
    {
      sub: 'adm',
      email: 'admin@union.test',
      memberships: [{ tenantId: T, role: 'admin', clubIds: [] }],
      onboardingSeen: {},
    },
  ];
  for (const u of users) await repo.putUser(u);
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

const digest = (clubId: string) => repo.getScorecardConfirmation(T, WEEK, clubId);
const noticeFor = (clubId: string) => notices.find((n) => n.clubId === clubId)!;
const getLink = (token: string) => app.request(`/scorecard-confirm-link/${token}`);
const answer = (token: string, seriesId: string, fixtureId: string, body: unknown) =>
  app.request(`/scorecard-confirm-link/${token}/fixtures/${seriesId}/${fixtureId}`, {
    method: 'PUT',
    headers: json(),
    body: JSON.stringify(body),
  });
type View = import('../src/scorecard-confirmations.js').ScorecardConfirmView;

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');
  sc = await import('../src/scorecard-confirmations.js');
  cron = await import('../src/crons/scorecard-confirmations-run.js');
  puller = await import('../src/medicoach-sync/puller.js');
  fetchMod = await import('../src/medicoach-sync/scorecard-fetch.js');
  WEEK = sc.lastCompletedWeekKey(new Date());
  [MON, SUN] = sc.windowForWeekKey(WEEK);
  SAT = dayBefore(SUN);
  sc.setDefaultScorecardNoticeSender(captureNotice);
  sc.setDefaultScorecardCorrectionSender(async (n) => {
    corrections.push(n);
    return { messageId: 'm-1' };
  });
});

after(async () => {
  sc.setDefaultScorecardNoticeSender(undefined);
  sc.setDefaultScorecardCorrectionSender(undefined);
  await stopDynalite(ddb);
});

beforeEach(async () => {
  await resetTable();
  await seed();
  notices.length = 0;
  corrections.length = 0;
});

describe('the Monday cron', () => {
  test('one digest per club per week, home AND away clubs; opt-out and no-contact recorded, not sent', async () => {
    const summary = await run();
    assert.equal(summary.weekKey, WEEK);
    assert.equal(summary.tenants, 1);
    assert.equal(summary.clubsProcessed, 4);
    assert.equal(summary.created, 4);
    assert.equal(summary.sent, 2);
    assert.equal(summary.skipped, 2);
    assert.equal(summary.errors, 0);

    const umz = (await digest('umzinto'))!;
    const aw = (await digest('african-warriors'))!;
    // Only the live in-window result: the import result (f2) and last week's (f0) are out.
    assert.deepEqual(Object.keys(umz.entries), [`${S1}#f1`]);
    assert.deepEqual(Object.keys(aw.entries), [`${S1}#f1`]);
    assert.equal(umz.entries[`${S1}#f1`].side, 'home');
    assert.equal(aw.entries[`${S1}#f1`].side, 'away');
    assert.equal(umz.entries[`${S1}#f1`].homeTeamName, 'Umzinto 1sts');
    assert.equal(umz.entries[`${S1}#f1`].awayTeamName, 'African Warriors');
    assert.equal(umz.entries[`${S1}#f1`].competition, 'Premier T20');
    assert.equal(umz.entries[`${S1}#f1`].status, 'pending');
    assert.ok(umz.notifiedAt);
    assert.deepEqual(
      umz.deliveries?.map((d) => [d.channel, d.status, d.purpose, d.recipientKind]),
      [
        ['email', 'sent', 'opened', 'chair'],
        ['whatsapp', 'sent', 'opened', 'chair'],
      ],
    );

    // The opted-out club and the no-contact club still get their digest — just no notice.
    const c = (await digest('c'))!;
    const d = (await digest('d'))!;
    assert.deepEqual(Object.keys(c.entries), [`${S2}#f7`]);
    assert.deepEqual(Object.keys(d.entries), [`${S2}#f7`]);
    assert.equal(c.notifiedAt, undefined);
    assert.equal(c.deliveries, undefined);
    // The no-contact club's digest says why nothing went out.
    assert.equal(d.notifiedAt, undefined);
    assert.deepEqual(
      d.deliveries?.map((x) => [x.channel, x.status, x.reason, x.purpose, x.recipientKind]),
      [
        ['email', 'skipped', 'no-contact', 'opened', 'chair'],
        ['whatsapp', 'skipped', 'no-contact', 'opened', 'chair'],
      ],
    );

    assert.deepEqual(notices.map((n) => n.clubId).sort(), ['african-warriors', 'umzinto']);
    const n = noticeFor('umzinto');
    assert.equal(n.to.email, 'chair@umzinto.test');
    assert.equal(n.matchCount, 1);
    assert.equal(n.weekLabel, sc.weekLabel(WEEK));
    assert.equal(n.orgName, 'KZN Dolphins');
    assert.match(n.url, /\/sc\/[^/]+$/);
    assert.deepEqual(n.channels, ['email', 'whatsapp']);

    // The comm log names the kind and never an address.
    const umzClub = await repo.getClub(T, 'umzinto');
    const rows = (umzClub?.commLog ?? []).filter((r) => r.kind === 'scorecard-confirm');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => !r.to));
  });

  test('refs are SC-YYYY-NNNN, unique and sequential per tenant/year', async () => {
    await run();
    const year = WEEK.slice(0, 4);
    const refs = (await repo.listScorecardConfirmations(T, WEEK)).map((r) => r.ref).sort();
    assert.deepEqual(
      refs,
      [1, 2, 3, 4].map((n) => `SC-${year}-000${n}`),
    );
    assert.equal(await repo.nextScorecardConfirmRef(T, year), `SC-${year}-0005`);
  });

  test('claim idempotency: a second run creates and sends nothing', async () => {
    await run();
    const second = await run();
    assert.equal(second.created, 0);
    assert.equal(second.sent, 0);
    assert.equal(second.toppedUp, 0);
    assert.equal(second.skipped, 4);
    assert.equal(notices.length, 2);
    assert.equal((await digest('umzinto'))!.deliveries?.length, 2);
  });

  test('a late result TOPS UP the existing digest without a re-send', async () => {
    await run();
    const before = (await digest('umzinto'))!;
    await storeResult(S1, 'f3');
    const summary = await run();
    assert.equal(summary.toppedUp, 2);
    assert.equal(summary.created, 0);
    assert.equal(summary.sent, 0);
    assert.equal(notices.length, 2);
    const after = (await digest('umzinto'))!;
    assert.deepEqual(Object.keys(after.entries).sort(), [`${S1}#f1`, `${S1}#f3`]);
    // Same digest: same ref, same link.
    assert.equal(after.ref, before.ref);
    assert.equal(after.memberId, before.memberId);
  });

  test('a total send failure releases the claim so the next run retries', async () => {
    const failing = async (n: Notice) =>
      n.channels.map((channel) => ({
        channel,
        status: 'failed' as const,
        reason: 'send-failed' as const,
      }));
    const first = await run({ sendNotice: failing });
    assert.equal(first.sent, 0);
    const retry = await run();
    assert.equal(retry.sent, 2);
    assert.equal(notices.length, 2);
  });

  test('a send that only SKIPPED (no email, WhatsApp template pending) releases the claim; once the template is registered the next run sends', async () => {
    const { WHATSAPP_TEMPLATES } = await import('../src/notify/whatsapp-templates.js');
    const tpl = WHATSAPP_TEMPLATES.scorecardConfirmDue as { status: string };
    const realStatus = tpl.status;
    // A cell-only chair for the club that had no contact at all.
    const d = (await repo.getClub(T, 'd'))!;
    await repo.putClub(T, {
      ...d,
      exco: { chair: { name: 'D Chair', cell: '0829876543' } },
    } as never);
    // The REAL sender (its template gate and address checks); a dry-run WhatsApp id stands
    // for a real one so a registered template counts as delivered.
    const realSender = async (n: Notice) =>
      (await sc.sendScorecardNotice(n)).map((r) =>
        r.messageId?.startsWith('dry-run-') ? { ...r, messageId: 'wamid.test' } : r,
      );
    const onlyD = async (n: Notice) => (n.clubId === 'd' ? realSender(n) : captureNotice(n));
    try {
      tpl.status = 'pending';
      const first = await run({ sendNotice: onlyD });
      assert.equal(first.errors, 0);
      const d1 = (await digest('d'))!;
      assert.equal(d1.notifiedAt, undefined);
      assert.deepEqual(
        d1.deliveries?.map((x) => [x.channel, x.status, x.reason]),
        [
          ['email', 'skipped', 'no-email'],
          ['whatsapp', 'skipped', 'template-pending'],
        ],
      );
      // An identical second run records nothing new (no unbounded growth, no comm-log spam).
      await run({ sendNotice: onlyD });
      assert.equal((await digest('d'))!.deliveries?.length, 2);
      const commRows = async () =>
        ((await repo.getClub(T, 'd'))?.commLog ?? []).filter((r) => r.kind === 'scorecard-confirm')
          .length;
      assert.equal(await commRows(), 2);

      // The template is approved: the claim was released, so this run sends — and completes.
      tpl.status = 'registered';
      const third = await run({ sendNotice: onlyD });
      assert.equal(third.sent, 1);
      const d3 = (await digest('d'))!;
      assert.ok(d3.notifiedAt);
      assert.deepEqual(
        d3.deliveries?.slice(-2).map((x) => [x.channel, x.status]),
        [
          ['email', 'skipped'],
          ['whatsapp', 'sent'],
        ],
      );
      // Completed: a further run sends nothing.
      const fourth = await run({ sendNotice: onlyD });
      assert.equal(fourth.sent, 0);
      assert.equal((await digest('d'))!.deliveries?.length, 4);
    } finally {
      tpl.status = realStatus;
    }
  });

  test('a no-contact chair is recorded skipped (no-contact) once; adding a contact lets the next run send', async () => {
    await run();
    await run();
    const d1 = (await digest('d'))!;
    assert.deepEqual(
      d1.deliveries?.map((x) => [x.channel, x.status, x.reason]),
      [
        ['email', 'skipped', 'no-contact'],
        ['whatsapp', 'skipped', 'no-contact'],
      ],
    );
    assert.equal(notices.filter((n) => n.clubId === 'd').length, 0);

    const d = (await repo.getClub(T, 'd'))!;
    await repo.putClub(T, {
      ...d,
      exco: { chair: { name: 'D Chair', email: 'chair@d.test' } },
    } as never);
    const summary = await run();
    assert.equal(summary.sent, 1);
    assert.equal(noticeFor('d').to.email, 'chair@d.test');
    const d2 = (await digest('d'))!;
    assert.ok(d2.notifiedAt);
    assert.deepEqual(
      d2.deliveries?.slice(-2).map((x) => [x.channel, x.status]),
      [
        ['email', 'sent'],
        ['whatsapp', 'sent'],
      ],
    );
  });

  test('gating: switch off, no medicoach sync, or no goLiveDate ⇒ the tenant is skipped', async () => {
    for (const over of [
      { scorecardConfirmations: { enabled: false } },
      { scorecardConfirmations: undefined },
      { features: {} },
      { integrations: {} },
    ]) {
      await putConfig(over);
      const summary = await run();
      assert.equal(summary.tenants, 0, JSON.stringify(over));
      assert.equal(summary.created, 0);
    }
    assert.deepEqual(await repo.listScorecardConfirmations(T), []);
    assert.equal(notices.length, 0);
  });

  test('matches before the goLiveDate are left out', async () => {
    await putConfig({ integrations: { medicoach: { goLiveDate: SUN } } });
    const summary = await run();
    assert.equal(summary.clubsProcessed, 0);
  });
});

describe('the public link', () => {
  test('GET serves the pinned view: scorecard embedded when available, else the headline result; sorted', async () => {
    await storeResult(S1, 'f3');
    await repo.putFixtureScorecard(T, {
      seriesId: S1,
      fixtureId: 'f1',
      medicoachMatchId: 'pma-f1',
      medicoachTournamentId: 'tour-9',
      schemaVersion: 1,
      fetchedAt: '2026-01-02T10:05:00.000Z',
      available: true,
      matchState: 'Umzinto won by 23 runs',
      innings: innings(),
    });
    await run();
    const res = await getLink(noticeFor('umzinto').token);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const view = (await res.json()) as View;
    assert.equal(view.clubName, 'Umzinto CC');
    assert.equal(view.weekKey, WEEK);
    assert.equal(view.weekLabel, sc.weekLabel(WEEK));
    assert.match(view.ref, /^SC-\d{4}-\d{4}$/);
    assert.deepEqual(view.branding, { name: 'KZN Dolphins', logoUrl: '', colors: {} });
    // MON (f3) before SAT (f1).
    assert.deepEqual(
      view.entries.map((e) => e.entryKey),
      [`${S1}#f3`, `${S1}#f1`],
    );
    const [f3, f1] = view.entries;
    assert.deepEqual(f1.scorecard, { matchState: 'Umzinto won by 23 runs', innings: innings() });
    assert.equal(f1.scorecardFetchedAt, '2026-01-02T10:05:00.000Z');
    assert.equal(f3.scorecard, undefined);
    assert.equal(f3.scorecardFetchedAt, undefined);
    assert.deepEqual(f3.result, {
      homeScore: '184/6 (20)',
      awayScore: '161/9 (20)',
      summary: 'Home won by 23 runs',
      winner: 'home',
    });
    assert.equal(f3.medicoachMatchUrl, 'https://medicoach.example/match/1');
    assert.equal(f1.status, 'pending');
    assert.equal(f1.homeTeamName, 'Umzinto 1sts');
    assert.equal(f1.fixtureDate, SAT);
    // Nothing server-only leaks.
    const raw = JSON.stringify(view);
    assert.doesNotMatch(raw, /memberId|deliveries|chair@|0821234567/);
  });

  test('a bad token is 404; an expired link 410; a rotated memberId 410', async () => {
    await run();
    assert.equal((await getLink('not-a-token')).status, 404);
    const token = noticeFor('umzinto').token;
    assert.equal((await getLink(token)).status, 200);

    // Revoke: the old token dies.
    await repo.rotateScorecardConfirmMemberId(T, WEEK, 'umzinto');
    assert.equal((await getLink(token)).status, 410);
    assert.equal((await answer(token, S1, 'f1', { action: 'confirm' })).status, 410);

    // Expired: a digest whose link window has closed.
    const expired: ScorecardConfirmation = {
      tenant: T,
      clubId: 'expired-club',
      clubName: 'Expired',
      weekKey: '2026-01-04',
      ref: 'SC-2026-0999',
      memberId: 'm-expired',
      linkExpiresAt: '2026-01-18T21:59:59.000Z',
      createdAt: '2026-01-05T05:00:00.000Z',
      entries: {},
    };
    await repo.createScorecardConfirmation(T, expired);
    const { captainsReportLinkSecret } = await import('../src/env.js');
    const { token: old } = sc.scorecardLink(T, expired, captainsReportLinkSecret(), 'http://x');
    assert.equal((await getLink(old)).status, 410);
  });

  test("CROSS-CONTEXT: a captain's-report token is not a scorecard link", async () => {
    await run();
    const { signReportLinkToken } = await import('../src/captains-reports.js');
    const { captainsReportLinkSecret } = await import('../src/env.js');
    const report = signReportLinkToken(
      { t: T, r: `${S1}~f1~umzinto`, m: (await digest('umzinto'))!.memberId, e: 4_000_000_000 },
      captainsReportLinkSecret(),
    );
    assert.equal((await getLink(report)).status, 404);
  });

  test('PUT confirm records the scorecard it was confirmed against; a second answer is 409 entry_closed', async () => {
    await repo.putFixtureScorecard(T, {
      seriesId: S1,
      fixtureId: 'f1',
      medicoachMatchId: 'pma-f1',
      medicoachTournamentId: 'tour-9',
      schemaVersion: 1,
      fetchedAt: '2026-01-02T10:05:00.000Z',
      available: true,
      innings: innings(),
    });
    await run();
    const token = noticeFor('umzinto').token;
    const ok = await answer(token, S1, 'f1', { action: 'confirm' });
    assert.equal(ok.status, 200);
    const view = (await ok.json()) as View;
    assert.equal(view.entries[0].status, 'confirmed');
    assert.ok(view.entries[0].submittedAt);
    const stored = (await digest('umzinto'))!.entries[`${S1}#f1`];
    assert.equal(stored.confirmedAgainstFetchedAt, '2026-01-02T10:05:00.000Z');
    assert.equal(stored.submittedVia, 'link');

    const again = await answer(token, S1, 'f1', { action: 'correction', feedback: 'oops' });
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { code?: string }).code, 'entry_closed');
    assert.equal((await digest('umzinto'))!.entries[`${S1}#f1`].status, 'confirmed');
    // Confirming never emails anyone.
    assert.equal(corrections.length, 0);
  });

  test('PUT confirm stores the ECHOED scorecard version, not the newer card on disk; that answer is later flagged stale', async () => {
    const card = (fetchedAt: string) =>
      repo.putFixtureScorecard(T, {
        seriesId: S1,
        fixtureId: 'f1',
        medicoachMatchId: 'pma-f1',
        medicoachTournamentId: 'tour-9',
        schemaVersion: 1,
        fetchedAt,
        available: true,
        innings: innings(),
      });
    const RENDERED = '2026-01-02T10:05:00.000Z';
    const NEWER = '2026-01-02T11:00:00.000Z';
    await card(RENDERED);
    await run();
    const token = noticeFor('umzinto').token;
    const view = (await (await getLink(token)).json()) as View;
    assert.equal(view.entries[0].scorecardFetchedAt, RENDERED);

    // A newer card lands while the chair is reading the old one.
    await card(NEWER);
    assert.equal(
      (await answer(token, S1, 'f1', { action: 'confirm', scorecardFetchedAt: 'yesterday' }))
        .status,
      400,
    );
    const ok = await answer(token, S1, 'f1', { action: 'confirm', scorecardFetchedAt: RENDERED });
    assert.equal(ok.status, 200);
    const stored = (await digest('umzinto'))!.entries[`${S1}#f1`];
    assert.equal(stored.confirmedAgainstFetchedAt, RENDERED);
    assert.ok(stored.submittedAt! > NEWER, 'submitted after the newer card arrived');

    // The newer card's stale check flags the answer: the chair saw the older card.
    assert.equal(await sc.flagStaleScorecardEntries(repo, T, S1, 'f1', NEWER), 1);
    assert.equal((await digest('umzinto'))!.entries[`${S1}#f1`].staleConfirmation, true);
  });

  test('PUT 404 for a match not in the digest; 400 for a bad body, missing or over-long feedback', async () => {
    await run();
    const token = noticeFor('umzinto').token;
    assert.equal((await answer(token, S1, 'nope', { action: 'confirm' })).status, 404);
    // f2 is a real fixture of the club, but its import result never entered the digest.
    assert.equal((await answer(token, S1, 'f2', { action: 'confirm' })).status, 404);
    assert.equal((await answer(token, S1, 'f1', { action: 'approve' })).status, 400);
    assert.equal((await answer(token, S1, 'f1', { action: 'correction' })).status, 400);
    assert.equal(
      (await answer(token, S1, 'f1', { action: 'correction', feedback: 'x'.repeat(2001) })).status,
      400,
    );
    assert.equal((await digest('umzinto'))!.entries[`${S1}#f1`].status, 'pending');
  });

  test('PUT correction stores the feedback and emails the PLATFORM OPERATORS only — never tenant admins', async () => {
    await run();
    const token = noticeFor('african-warriors').token;
    const feedback = 'Batter 3 scored 41, not 14.\nPlease fix the total.';
    const res = await answer(token, S1, 'f1', { action: 'correction', feedback });
    assert.equal(res.status, 200);
    const stored = (await digest('african-warriors'))!.entries[`${S1}#f1`];
    assert.equal(stored.status, 'correction');
    assert.equal(stored.feedback, feedback);

    assert.deepEqual(corrections.map((c) => c.to).sort(), [
      'ops1@platform.test',
      'ops2@platform.test',
    ]);
    assert.ok(corrections.every((c) => c.to !== 'admin@union.test'));
    const c = corrections[0];
    assert.equal(c.tenantName, 'KZN Dolphins');
    assert.equal(c.clubName, 'African Warriors');
    assert.equal(c.ref, (await digest('african-warriors'))!.ref);
    assert.equal(c.feedback, feedback);
    assert.match(c.fixtureLine, /^Umzinto 1sts v African Warriors \(Premier T20\), /);
    assert.match(c.consoleLink ?? '', /\/platform$/);

    // The email body carries the feedback verbatim (HTML-escaped).
    const { buildScorecardCorrectionEmail } = await import('../src/notify/email.js');
    const email = buildScorecardCorrectionEmail(c);
    assert.ok(email.text.includes(feedback));
    assert.match(email.subject, /African Warriors/);
  });

  test('a correction still succeeds when the operator email fails', async () => {
    await run();
    sc.setDefaultScorecardCorrectionSender(async () => {
      throw new Error('SES down');
    });
    try {
      const res = await answer(noticeFor('umzinto').token, S1, 'f1', {
        action: 'correction',
        feedback: 'wrong',
      });
      assert.equal(res.status, 200);
      assert.equal((await digest('umzinto'))!.entries[`${S1}#f1`].status, 'correction');
    } finally {
      sc.setDefaultScorecardCorrectionSender(async (n) => {
        corrections.push(n);
        return { messageId: 'm-1' };
      });
    }
  });
});

describe('medicoach sync hooks', () => {
  const page = (fixtures: unknown[]) => ({
    version: 1,
    tenant: T,
    nextCursor: 'c-next',
    hasMore: false,
    fixtures,
  });
  const fakeFetch = (body: unknown, cards: Record<string, unknown> = {}) =>
    (async (input: string | URL | Request) => {
      const url = String(input);
      const m = url.match(/\/matches\/([^/]+)\/scorecard\?/);
      if (m) {
        const card = cards[decodeURIComponent(m[1])];
        return new Response(JSON.stringify(card ?? { error: 'not found' }), {
          status: card ? 200 : 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

  test('a cleared result voids the entry in every digest that lists it', async () => {
    await run();
    const cleared = page([
      {
        ref: `smartclub:${T}:fixture:${S1}:f1`,
        syncStamp: '2026-01-03T10:00:00.000Z',
        schedule: {
          scheduledTime: `${SAT}T09:00:00+02:00`,
          timeTbc: false,
          dateTbc: false,
          venue: null,
          postponed: false,
          cancelled: false,
          changedAt: '2026-01-01T10:00:00.000Z',
        },
        teams: { homeRef: null, awayRef: null },
        result: null,
        resultClearedAt: '2026-01-03T10:00:00.000Z',
      },
    ]);
    const summary = await puller.runMedicoachSync(T, 'manual', {
      repo,
      url: 'http://medicoach.test',
      secret: 'stub-secret',
      fetch: fakeFetch(cleared),
      log: () => {},
    });
    assert.equal(summary.counts.resultsCleared, 1);
    assert.equal((await digest('umzinto'))!.entries[`${S1}#f1`].status, 'void');
    assert.equal((await digest('african-warriors'))!.entries[`${S1}#f1`].status, 'void');
    // A void entry is closed.
    const res = await answer(noticeFor('umzinto').token, S1, 'f1', { action: 'confirm' });
    assert.equal(res.status, 409);
  });

  test('a cleared result re-recorded later restores its VOID entries to pending; answered entries are untouched', async () => {
    await run();
    // The warriors chair answered before the clear.
    assert.equal(
      (await answer(noticeFor('african-warriors').token, S1, 'f1', { action: 'confirm' })).status,
      200,
    );
    const change = (over: Record<string, unknown>) => ({
      ref: `smartclub:${T}:fixture:${S1}:f1`,
      syncStamp: '2026-01-03T10:00:00.000Z',
      schedule: {
        scheduledTime: `${SAT}T09:00:00+02:00`,
        timeTbc: false,
        dateTbc: false,
        venue: null,
        postponed: false,
        cancelled: false,
        changedAt: '2026-01-01T10:00:00.000Z',
      },
      teams: { homeRef: null, awayRef: null },
      result: null,
      resultClearedAt: null,
      ...over,
    });
    const sync = (fixtures: unknown[]) =>
      puller.runMedicoachSync(T, 'manual', {
        repo,
        url: 'http://medicoach.test',
        secret: 'stub-secret',
        fetch: fakeFetch(page(fixtures)),
        onResultStored: async () => {},
        log: () => {},
      });
    await sync([change({ resultClearedAt: '2026-01-03T10:00:00.000Z' })]);
    assert.equal((await digest('umzinto'))!.entries[`${S1}#f1`].status, 'void');
    assert.equal((await digest('african-warriors'))!.entries[`${S1}#f1`].status, 'void');

    const summary = await sync([
      change({
        syncStamp: '2026-01-04T10:00:00.000Z',
        result: {
          homeScore: '190/5 (20)',
          awayScore: '161/9 (20)',
          summary: 'Home won by 29 runs',
          winner: 'home',
          method: 'normal',
          noResult: false,
          source: 'live',
          recordedAt: '2026-01-04T10:00:00.000Z',
          scoringSide: 'home',
          captainRef: null,
          medicoachMatchUrl: null,
          medicoachMatchId: 'pma-f1',
          medicoachTournamentId: 'tour-9',
        },
      }),
    ]);
    assert.equal(summary.counts.resultsStored, 1);
    const umz = (await digest('umzinto'))!.entries[`${S1}#f1`];
    const aw = (await digest('african-warriors'))!.entries[`${S1}#f1`];
    assert.equal(umz.status, 'pending');
    // Restored clean: the pre-clear answer is gone, so the chair answers the new result.
    assert.equal(aw.status, 'pending');
    assert.equal(aw.submittedAt, undefined);
    assert.equal(aw.confirmedAgainstFetchedAt, undefined);
    // The live link offers the match again.
    assert.equal(
      (await answer(noticeFor('umzinto').token, S1, 'f1', { action: 'confirm' })).status,
      200,
    );
    // A restore never touches an answered entry.
    assert.equal(await sc.restoreScorecardEntriesForFixture(repo, T, S1, 'f1'), 0);
    assert.equal((await digest('umzinto'))!.entries[`${S1}#f1`].status, 'confirmed');
  });

  test('a scorecard refetched after the chair answered flags the entry staleConfirmation', async () => {
    await run();
    const token = noticeFor('umzinto').token;
    assert.equal((await answer(token, S1, 'f1', { action: 'confirm' })).status, 200);
    // The warriors chair has not answered yet: its entry must NOT be flagged.
    const outcome = await fetchMod.fetchAndStoreScorecard(
      {
        repo,
        url: 'http://medicoach.test',
        secret: 'stub-secret',
        fetch: fakeFetch(null, {
          'pma-f1': {
            available: true,
            matchId: 'pma-f1',
            matchState: 'corrected',
            innings: innings(),
          },
        }),
        now: () => new Date(Date.now() + 60_000),
        log: () => {},
      },
      T,
      S1,
      'f1',
      'pma-f1',
      'tour-9',
    );
    assert.equal(outcome, 'stored');
    assert.equal((await digest('umzinto'))!.entries[`${S1}#f1`].staleConfirmation, true);
    assert.equal(
      (await digest('african-warriors'))!.entries[`${S1}#f1`].staleConfirmation,
      undefined,
    );
    const view = (await (await getLink(token)).json()) as View;
    assert.equal(view.entries[0].staleConfirmation, true);
  });
});

describe('operator console', () => {
  type PlatformList = {
    weekKey: string;
    weekLabel: string;
    tenants: import('../src/scorecard-confirmations.js').PlatformScorecardTenant[];
  };

  test('GET pairs both clubs of each fixture side by side (home first) with delivery status', async () => {
    await run();
    await answer(noticeFor('umzinto').token, S1, 'f1', { action: 'confirm' });
    await answer(noticeFor('african-warriors').token, S1, 'f1', {
      action: 'correction',
      feedback: 'wrong total',
    });
    const res = await app.request(`/platform/scorecard-confirmations?week=${WEEK}`, {
      headers: json(OPERATOR),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as PlatformList;
    assert.equal(body.weekKey, WEEK);
    assert.equal(body.weekLabel, sc.weekLabel(WEEK));
    assert.equal(body.tenants.length, 1);
    const t = body.tenants[0];
    assert.equal(t.tenant, T);
    assert.equal(t.tenantName, 'KZN Dolphins');
    assert.equal(t.enabled, true);
    const f1 = t.fixtures.find((f) => f.fixtureId === 'f1')!;
    assert.equal(f1.homeTeamName, 'Umzinto 1sts');
    assert.deepEqual(
      f1.sides.map((s) => [s.clubId, s.status, s.feedback ?? null]),
      [
        ['umzinto', 'confirmed', null],
        ['african-warriors', 'correction', 'wrong total'],
      ],
    );
    assert.ok(f1.sides[0].notifiedAt);
    assert.deepEqual(
      f1.sides[0].deliveries.map((d) => [d.channel, d.status]),
      [
        ['email', 'sent'],
        ['whatsapp', 'sent'],
      ],
    );
    const f7 = t.fixtures.find((f) => f.fixtureId === 'f7')!;
    assert.deepEqual(
      f7.sides.map((s) => [s.clubId, s.status, s.deliveries.length]),
      [
        ['c', 'pending', 0],
        ['d', 'pending', 2],
      ],
    );
    assert.ok(
      f7.sides[1].deliveries.every((x) => x.status === 'skipped' && x.reason === 'no-contact'),
    );
    const umz = t.records.find((r) => r.clubId === 'umzinto')!;
    assert.deepEqual(umz.counts, { pending: 0, confirmed: 1, correction: 0, void: 0 });
    // Never a provider message id or the link's memberId.
    assert.doesNotMatch(JSON.stringify(body), /messageId|memberId/);
  });

  test('GET defaults to the most recent completed week; rejects a non-Sunday; operators only', async () => {
    await run();
    const res = await app.request('/platform/scorecard-confirmations', { headers: json(OPERATOR) });
    assert.equal(((await res.json()) as PlatformList).weekKey, WEEK);
    assert.equal(
      (
        await app.request(`/platform/scorecard-confirmations?week=${MON}`, {
          headers: json(OPERATOR),
        })
      ).status,
      400,
    );
    assert.equal(
      (await app.request('/platform/scorecard-confirmations', { headers: json(ADMIN) })).status,
      403,
    );
  });

  test('POST run tops up late results (no re-send) and returns the summary', async () => {
    await run();
    await storeResult(S1, 'f3');
    const res = await app.request('/platform/scorecard-confirmations/run', {
      method: 'POST',
      headers: json(OPERATOR),
      body: JSON.stringify({ week: WEEK }),
    });
    assert.equal(res.status, 200);
    const summary = (await res.json()) as Record<string, number>;
    assert.equal(summary.tenants, 1);
    assert.equal(summary.clubsProcessed, 4);
    assert.equal(summary.created, 0);
    assert.equal(summary.toppedUp, 2);
    assert.equal(summary.sent, 0);
    assert.equal(notices.length, 2);
    assert.ok((await digest('umzinto'))!.entries[`${S1}#f3`]);
    const bad = await app.request('/platform/scorecard-confirmations/run', {
      method: 'POST',
      headers: json(OPERATOR),
      body: JSON.stringify({ week: MON }),
    });
    assert.equal(bad.status, 400);
  });

  test('the operator tenant write accepts scorecardConfirmations.enabled; the admin write strips it', async () => {
    const put = await app.request(`/platform/tenants/${T}`, {
      method: 'PUT',
      headers: json(OPERATOR),
      body: JSON.stringify({ scorecardConfirmations: { enabled: false } }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual((await repo.getTenantConfig(T))?.scorecardConfirmations, { enabled: false });
    const bad = await app.request(`/platform/tenants/${T}`, {
      method: 'PUT',
      headers: json(OPERATOR),
      body: JSON.stringify({ scorecardConfirmations: { enabled: 'yes' } }),
    });
    assert.equal(bad.status, 400);
    const admin = await app.request('/tenant/config', {
      method: 'PUT',
      headers: { ...json(ADMIN), 'x-tenant': T },
      body: JSON.stringify({ scorecardConfirmations: { enabled: true } }),
    });
    assert.equal(admin.status, 200);
    assert.deepEqual((await repo.getTenantConfig(T))?.scorecardConfirmations, { enabled: false });
  });
});

describe('erasure', () => {
  test('tenant erasure removes every digest, counter and send claim', async () => {
    await run();
    await repo.eraseTenantData(T);
    assert.deepEqual(await repo.listScorecardConfirmations(T), []);
  });
});
