/**
 * Tests for scripts/resend-captains-report-notices.ts — re-addressing a weekend's pending
 * captain's reports to each side's captain (from the club's submitted-report history) and
 * resending. Runs against dynalite with the REAL repo, opener and Hono app (link routes);
 * only the outbound sender is captured. Dates follow the real clock (link tokens are
 * verified against `Date.now()`).
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaptainsReport, Series, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4741;
const TABLE = 'SmartClubReportResend';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

type Script = typeof import('../scripts/resend-captains-report-notices.js');
type Notice = import('../src/captains-reports.js').ReportNotice;
type NoticeResult = import('../src/captains-reports.js').NoticeResult;
let script: Script;
let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let reports: typeof import('../src/captains-reports.js');

const DAY = 24 * 3600 * 1000;
const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const MATCH_DATE = isoDay(-1);
const PAST_DATE = isoDay(-8);
const SERIES = 's-premier';
const LINK_BASE = 'https://resend.test';
const LIVE = { email: false, whatsapp: false };

const notices: Notice[] = [];
const logLines: string[] = [];
const allSent = (n: Notice): NoticeResult[] =>
  n.channels.map((channel, i) => ({
    channel,
    status: 'sent',
    messageId: `wamid.${n.reportId}.${channel}.${i}.${notices.length}`,
  }));
let respond: (n: Notice) => NoticeResult[] = allSent;

const club = (id: string, name: string, chair: { name: string; email?: string; cell?: string }) =>
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
    ground: { venue: 'Ground' },
    leagues: ['premier'],
  }) as never;

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

const fx = (id: string, date: string) => ({
  id,
  round: 1,
  date,
  time: '09:00',
  home: 'umzinto',
  away: 'african-warriors',
});

const baseReport = (
  fixtureId: string,
  clubId: 'umzinto' | 'african-warriors',
  over: Partial<CaptainsReport> = {},
): CaptainsReport => {
  const home = clubId === 'umzinto';
  const at = new Date(Date.now() - 2 * DAY).toISOString();
  return {
    id: reports.captainsReportId(SERIES, fixtureId, clubId),
    seriesId: SERIES,
    fixtureId,
    clubId,
    status: 'pending',
    source: 'auto',
    matchDate: MATCH_DATE,
    side: home ? 'home' : 'away',
    clubName: home ? 'Umzinto CC' : 'African Warriors',
    opponentName: home ? 'African Warriors' : 'Umzinto CC',
    competition: 'Premier T20',
    resultSummary: null,
    umpiresSnapshot: [],
    recipient: { kind: 'chair', memberId: `chair-${clubId}-${fixtureId}`, name: 'Chair' },
    captainName: '',
    umpires: [],
    general: '',
    linkExpiresAt: new Date(Date.now() + 5 * DAY).toISOString(),
    deliveries: [
      {
        channel: 'email',
        status: 'sent',
        at,
        messageId: 'm-old',
        purpose: 'opened',
        recipientKind: 'chair',
      },
    ],
    notifiedAt: at,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
};

async function seed() {
  await repo.putTenantConfig({
    tenant: 'dolphins',
    branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: { medicoachSync: true },
    integrations: { medicoach: { goLiveDate: isoDay(-30) } },
  } as unknown as TenantConfig);
  await repo.createClub(
    'dolphins',
    club('umzinto', 'Umzinto CC', {
      name: 'Uma Chair',
      email: 'chair@umzinto.test',
      cell: '0821234567',
    }),
  );
  await repo.createClub(
    'dolphins',
    club('african-warriors', 'African Warriors', { name: 'Awa Chair', email: 'chair@aw.test' }),
  );
  await repo.putSeries('dolphins', {
    id: SERIES,
    name: 'Premier T20',
    leagueKey: 'premier',
    startDate: PAST_DATE,
    teams: ['umzinto', 'african-warriors'],
    participants: [
      { teamId: 'umzinto', clubId: 'umzinto', name: 'Umzinto CC', venue: 'Oval' },
      {
        teamId: 'african-warriors',
        clubId: 'african-warriors',
        name: 'African Warriors',
        venue: 'Oval',
      },
    ],
    fixtures: [fx('f-now', MATCH_DATE), fx('f-past', PAST_DATE), fx('f-void', MATCH_DATE)],
    kind: 'series',
    approved: true,
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  } as unknown as Series);
  await repo.createPlayer('dolphins', {
    naturalKey: 'k-captain',
    clubId: 'umzinto',
    firstName: 'Sanele',
    lastName: 'Mthembu',
    email: 'captain@umzinto.test',
    cell: '0831234567',
    isMinor: false,
    status: 'active',
  } as never);
  // History: Umzinto's last submitted report names its captain; African Warriors has none.
  await repo.openCaptainsReportIfAbsent(
    'dolphins',
    baseReport('f-past', 'umzinto', {
      status: 'submitted',
      matchDate: PAST_DATE,
      captainName: 'Sanele Mthembu',
      ref: 'CR-2026-0001',
      submittedAt: new Date(Date.now() - 7 * DAY).toISOString(),
    }),
  );
}

const get = (clubId: string, fixtureId = 'f-now') =>
  repo.getCaptainsReport('dolphins', SERIES, fixtureId, clubId);
const openPending = (clubId: 'umzinto' | 'african-warriors', over: Partial<CaptainsReport> = {}) =>
  repo.openCaptainsReportIfAbsent('dolphins', baseReport('f-now', clubId, over));

const tokenOf = (n: Notice) => n.url.split('/r/')[1];
const linkGet = (token: string) => app.request(`/captains-report-link/${token}`);
const submitVia = (token: string) =>
  app.request(`/captains-report-link/${token}`, {
    method: 'PUT',
    headers: { 'x-tenant': 'dolphins', 'content-type': 'application/json' },
    body: JSON.stringify({
      captainName: 'Sanele Mthembu',
      declaration: true,
      general: 'Good game',
      umpires: ['A.Ngubane', 'S.Dlamini'].map((name) => ({
        name,
        ratings: { decisions: 4, pressure: 4, behaviour: 5, communication: 4, regulations: 2 },
        concerns: {},
        otherConcern: '',
        comments: 'Solid',
      })),
      submit: true,
    }),
  });
/** The token of the link the stored report's CURRENT recipient (or the chair) holds. */
const linkFor = async (r: CaptainsReport, memberId: string) => {
  const { captainsReportLinkSecret } = await import('../src/env.js');
  return reports.reportLink(
    'dolphins',
    { ...r, recipient: { ...r.recipient, memberId } },
    captainsReportLinkSecret(),
    LINK_BASE,
  ).token;
};

let backupDir = '';
const args = (
  over: Partial<import('../scripts/resend-captains-report-notices.js').ResendArgs> = {},
) => ({
  stage: 'test',
  tenant: 'dolphins',
  dates: [MATCH_DATE],
  allowChairFallback: false,
  confirm: false,
  backupDir,
  ...over,
});
const run = (over: Parameters<typeof args>[0] = {}, r: typeof repo = repo) =>
  script.runResend(args(over), r, reports, LINK_BASE, LIVE, (l) => logLines.push(l));

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');
  reports = await import('../src/captains-reports.js');
  script = await import('../scripts/resend-captains-report-notices.js');
  reports.setDefaultReportNoticeSender(async (n) => {
    notices.push(n);
    return respond(n);
  });
});
after(async () => {
  reports.setDefaultReportNoticeSender(undefined);
  await stopDynalite(ddb);
});
beforeEach(async () => {
  await resetTable();
  await seed();
  notices.length = 0;
  logLines.length = 0;
  respond = allSent;
  backupDir = await mkdtemp(join(tmpdir(), 'resend-'));
});

describe('parseResendArgs', () => {
  test('parses every flag; --stage and --dates are required; unknown flags throw', () => {
    assert.deepEqual(
      script.parseResendArgs([
        '--stage=prod',
        '--dates=2026-10-17,2026-10-18',
        '--series=a,b',
        '--only=x',
        '--allow-chair-fallback',
        '--backup-dir=/tmp/x',
        '--link-base=https://x.test',
        '--confirm',
      ]),
      {
        stage: 'prod',
        tenant: 'dolphins',
        dates: ['2026-10-17', '2026-10-18'],
        seriesIds: ['a', 'b'],
        only: ['x'],
        allowChairFallback: true,
        backupDir: '/tmp/x',
        linkBase: 'https://x.test',
        confirm: true,
      },
    );
    assert.throws(() => script.parseResendArgs(['--dates=2026-10-17']), /--stage/);
    assert.throws(() => script.parseResendArgs(['--stage=prod']), /--dates/);
    assert.throws(() => script.parseResendArgs(['--stage=p', '--dates=17-10']), /YYYY-MM-DD/);
    assert.throws(() => script.parseResendArgs(['--stage=p', '--dates=2026-10-17', '--x']));
  });
});

describe('dry run', () => {
  test('mutates nothing, sends nothing, writes a backup of the selected items', async () => {
    await openPending('umzinto');
    const before = await repo.listCaptainsReports('dolphins');
    assert.equal(await run(), 0);
    assert.deepEqual(await repo.listCaptainsReports('dolphins'), before);
    assert.equal(notices.length, 0);
    const files = await readdir(backupDir);
    assert.equal(files.length, 1);
    const saved = JSON.parse(await readFile(join(backupDir, files[0]), 'utf8'));
    assert.deepEqual(
      saved.reports.map((r: CaptainsReport) => r.id),
      [reports.captainsReportId(SERIES, 'f-now', 'umzinto')],
    );
    const text = logLines.join('\n');
    assert.match(text, /source report: CR-2026-0001/);
    assert.match(text, /PLAN → captain Sanele Mthembu/);
  });
});

describe('--confirm', () => {
  test('re-addresses to the captain and sends; chair link kept, forwards untouched', async () => {
    await openPending('umzinto', { forwardCount: 1, reminderSentAt: new Date().toISOString() });
    const old = (await get('umzinto'))!;
    assert.equal(await run({ confirm: true }), 0);

    const after = (await get('umzinto'))!;
    assert.equal(after.recipient.kind, 'captain');
    assert.equal(after.recipient.name, 'Sanele Mthembu');
    assert.notEqual(after.recipient.memberId, old.recipient.memberId);
    assert.equal(after.chairMemberId, old.recipient.memberId);
    assert.equal(after.forwardCount, 1);
    assert.equal(after.reminderSentAt, undefined);
    assert.equal(after.captainName, 'Sanele Mthembu');
    assert.deepEqual(after.recipientContact, {
      email: 'captain@umzinto.test',
      cell: '0831234567',
    });
    const fresh = after.deliveries!.slice(old.deliveries!.length);
    assert.ok(fresh.length > 0 && fresh.every((d) => d.status === 'sent'));
    assert.ok(fresh.every((d) => d.recipientKind === 'captain'));

    assert.equal(notices.length, 1);
    assert.equal(notices[0].to.email, 'captain@umzinto.test');
    assert.equal(notices[0].ccEmail, 'chair@umzinto.test');
    assert.equal((await linkGet(tokenOf(notices[0]))).status, 200);
    // The chair's original link still submits.
    const chairToken = await linkFor(after, old.recipient.memberId);
    assert.equal((await submitVia(chairToken)).status, 200);
    assert.equal((await get('umzinto'))!.status, 'submitted');
  });

  test('a second run skips (sent to the captain) and sends nothing more', async () => {
    await openPending('umzinto');
    assert.equal(await run({ confirm: true }), 0);
    const once = (await get('umzinto'))!;
    notices.length = 0;
    logLines.length = 0;
    assert.equal(await run({ confirm: true }), 0);
    assert.equal(notices.length, 0);
    assert.deepEqual(await get('umzinto'), once);
    assert.match(logLines.join('\n'), /already sent to captain/);
  });

  test('a re-run after an all-channel failure re-notifies with a fresh link', async () => {
    await openPending('umzinto');
    const old = (await get('umzinto'))!;
    respond = (n) => n.channels.map((channel) => ({ channel, status: 'failed' as const }));
    assert.equal(await run({ confirm: true }), 1);
    const failed = (await get('umzinto'))!;
    assert.equal(failed.recipient.kind, 'captain');
    const firstToken = tokenOf(notices[0]);

    respond = allSent;
    notices.length = 0;
    assert.equal(await run({ confirm: true }), 0);
    assert.equal(notices.length, 1);
    const after = (await get('umzinto'))!;
    assert.notEqual(after.recipient.memberId, failed.recipient.memberId);
    // The chair link survives both re-addresses; the first captain link is dead.
    assert.equal(after.chairMemberId, old.recipient.memberId);
    assert.equal((await linkGet(firstToken)).status, 410);
    assert.equal((await linkGet(tokenOf(notices[0]))).status, 200);
    assert.equal((await submitVia(await linkFor(after, old.recipient.memberId))).status, 200);
  });

  test('an expired stored link is refreshed', async () => {
    await openPending('umzinto', { linkExpiresAt: new Date(Date.now() - DAY).toISOString() });
    assert.equal(await run({ confirm: true }), 0);
    const after = (await get('umzinto'))!;
    assert.ok(Date.parse(after.linkExpiresAt!) > Date.now() + 2 * DAY);
    assert.equal((await linkGet(tokenOf(notices[0]))).status, 200);
  });

  test('submitted and void reports are never touched', async () => {
    await openPending('umzinto', { status: 'submitted', submittedAt: new Date().toISOString() });
    await repo.openCaptainsReportIfAbsent(
      'dolphins',
      baseReport('f-void', 'umzinto', { status: 'void' }),
    );
    const before = await repo.listCaptainsReports('dolphins');
    assert.equal(await run({ confirm: true }), 0);
    assert.deepEqual(await repo.listCaptainsReports('dolphins'), before);
    assert.equal(notices.length, 0);
  });

  test('no captain: skipped without --allow-chair-fallback, fresh chair notice with it', async () => {
    await openPending('african-warriors');
    const old = (await get('african-warriors'))!;
    assert.equal(await run({ confirm: true }), 0);
    assert.deepEqual(await get('african-warriors'), old);
    assert.equal(notices.length, 0);
    assert.match(logLines.join('\n'), /no-history\): UNRESOLVED/);

    assert.equal(await run({ confirm: true, allowChairFallback: true }), 0);
    const after = (await get('african-warriors'))!;
    assert.equal(after.recipient.kind, 'chair');
    assert.notEqual(after.recipient.memberId, old.recipient.memberId);
    assert.equal(after.recipientContact, undefined);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].to.email, 'chair@aw.test');
    assert.equal(notices[0].recipientKind, 'chair');

    // Same day again: the chair was already reached today.
    notices.length = 0;
    assert.equal(await run({ confirm: true, allowChairFallback: true }), 0);
    assert.equal(notices.length, 0);
  });

  test('a report that changes mid-run is a reported conflict: exit 1, nothing sent', async () => {
    await openPending('umzinto');
    const old = (await get('umzinto'))!;
    const racing = {
      ...repo,
      readdressCaptainsReport: async (...a: Parameters<typeof repo.readdressCaptainsReport>) => {
        assert.equal((await submitVia(await linkFor(old, old.recipient.memberId))).status, 200);
        return repo.readdressCaptainsReport(...a);
      },
    } as typeof repo;
    assert.equal(await run({ confirm: true }, racing), 1);
    assert.equal(notices.length, 0);
    const after = (await get('umzinto'))!;
    assert.equal(after.status, 'submitted');
    assert.equal(after.recipient.memberId, old.recipient.memberId);
    assert.match(logLines.join('\n'), /CONFLICT/);
  });

  test('--confirm is refused in notify dry-run or with a local link base', async () => {
    await openPending('umzinto');
    assert.equal(
      await script.runResend(
        args({ confirm: true }),
        repo,
        reports,
        'http://localhost:5173',
        LIVE,
        (l) => logLines.push(l),
      ),
      1,
    );
    assert.equal(
      await script.runResend(
        args({ confirm: true }),
        repo,
        reports,
        LINK_BASE,
        { email: true, whatsapp: false },
        (l) => logLines.push(l),
      ),
      1,
    );
    assert.equal(notices.length, 0);
  });
});

// The token is the capability: a hand-signed (extended) link outlives the STORED expiry,
// which only stops notices. Access, submit and the shown "Link expires" follow the token.
describe('link expiry follows the token, not the stored report expiry', () => {
  const signed = async (r: CaptainsReport, e: number) => {
    const { captainsReportLinkSecret } = await import('../src/env.js');
    return reports.signReportLinkToken(
      { t: 'dolphins', r: r.id, m: r.recipient.memberId, e },
      captainsReportLinkSecret(),
    );
  };

  test('an extended token opens and submits a report whose stored expiry has passed', async () => {
    const storedExpiry = new Date(Date.now() - DAY).toISOString();
    await openPending('umzinto', { linkExpiresAt: storedExpiry });
    const r = (await get('umzinto'))!;
    const e = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    const token = await signed(r, e);
    const opened = await linkGet(token);
    assert.equal(opened.status, 200);
    const body = (await opened.json()) as { report: { linkExpiresAt?: string } };
    assert.equal(body.report.linkExpiresAt, new Date(e * 1000).toISOString());
    assert.notEqual(body.report.linkExpiresAt, storedExpiry);
    const submitted = await submitVia(token);
    assert.equal(submitted.status, 200);
    assert.equal((await get('umzinto'))!.status, 'submitted');
  });

  test('a genuinely expired token still refuses (410), even with a future stored expiry', async () => {
    await openPending('umzinto', {
      linkExpiresAt: new Date(Date.now() + 5 * DAY).toISOString(),
    });
    const r = (await get('umzinto'))!;
    const token = await signed(r, Math.floor(Date.now() / 1000) - 60);
    assert.equal((await linkGet(token)).status, 410);
    assert.equal((await submitVia(token)).status, 410);
    assert.equal((await get('umzinto'))!.status, 'pending');
  });

  test('a normal link (token e == stored) shows the stored expiry exactly as before', async () => {
    await openPending('umzinto');
    const r = (await get('umzinto'))!;
    const res = await linkGet(await linkFor(r, r.recipient.memberId));
    const body = (await res.json()) as { report: { linkExpiresAt?: string } };
    assert.equal(body.report.linkExpiresAt, r.linkExpiresAt);
  });
});
