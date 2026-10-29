/**
 * The CSA premier pipeline as a captain experiences it, end to end against dynalite with the
 * REAL puller, scorecard fetch/sweep, report opener, retry and `/captains-report-link` routes —
 * fed with REAL medicoach payloads captured from a scrape → ingest run
 * (`test/data/csa-e2e/`: the `/changes` page, the full card of match caa6716e and the
 * corrected card of match 2f6d9c46). All three parse the v1 contract verbatim (pinned below);
 * the only adaptation is ids/refs/instants onto the seeded fixtures.
 *
 *  1. Monday 04:45: the premier result notifies at once, the promotion one waits for 18:00;
 *     the captured card is stored and served to the link with every innings detail, and the
 *     confirm answer is accepted against it.
 *  2. A correction (recordedAt bumped + corrected card) is refetched by the sweep and flags
 *     the submitted answer stale; nobody is notified again.
 *  3. Result-only Monday: `available: false` → card-less report + notice; a later sweep
 *     attaches the card.
 *  4. Old fixtures: the EXACT `too-old` rule, what it does NOT cover (a freshly pulled result
 *     for an old match still notifies — the go-live date is the guard), and what the backfill
 *     script does with such a fixture.
 *  5. Abandoned (`source: manual`, no result): opens + notifies card-less with "Abandoned".
 *
 * Every instant is fixed (Sat 24 / Mon 26 Oct 2026) and passed as `now`; link tokens for the
 * answer flow are minted with a far-future expiry so the wall clock never matters.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaptainsReport, League, Series, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4791;
const TABLE = 'SmartClubCaptainsReportCsaChain';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const SECRET = 'stub-shared-secret';
const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'data/csa-e2e');
const load = (name: string) => JSON.parse(readFileSync(path.join(DATA, name), 'utf8'));
const CAPTURED_CHANGES = load('changes.json');
const CARD_CAA = load('scorecard-caa6716e.json');
const CARD_2F6D_CORRECTED = load('scorecard-2f6d9c46-corrected.json');
const MATCH_CAA = 'caa6716e-80ab-479a-a502-8420e8942682';
const MATCH_2F6D = '2f6d9c46-5b53-451c-b82c-df9e5862c484';

const T = 'dolphins';
const SAT = '2026-10-24';
const MON = '2026-10-26';
const OLD = '2026-10-04';
const HOUR = 3600 * 1000;
/** `day` at hh:mm SAST, as a UTC instant. */
const at = (day: string, h: number, m = 0) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) - 2 * HOUR + (h * 60 + m) * 60_000);

const PREMIER = 's-planb-premier-men-t20-g1';
const PROMO = 's-promotion-run-g1';
const fixtureRef = (s: string, f: string) => `smartclub:${T}:fixture:${s}:${f}`;
const PREMIER_REF = fixtureRef(PREMIER, 'f3');
const PROMO_REF = fixtureRef(PROMO, 'f7');
const OLD_REF = fixtureRef(PREMIER, 'f9');

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let puller: typeof import('../src/medicoach-sync/puller.js');
let scorecards: typeof import('../src/medicoach-sync/scorecard-fetch.js');
let contract: typeof import('../src/medicoach-sync-contract.js');
let reports: typeof import('../src/captains-reports.js');
let env: typeof import('../src/env.js');

// ── Stub medicoach: `/changes` → `page`; `/matches/:id/scorecard` → `cards[id]` ──
let stub: Server;
let stubUrl = '';
let page: unknown = null;
let cards: Record<string, { status: number; body: unknown }> = {};
const scorecardHits: string[] = [];
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
    const m = /\/integrations\/smartclub\/matches\/([^/?]+)\/scorecard/.exec(req.url ?? '');
    if (m) {
      scorecardHits.push(m[1]!);
      const card = cards[m[1]!] ?? { status: 404, body: { error: 'not found' } };
      res.writeHead(card.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(card.body));
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

// ── Captured `/changes` entries, adapted onto the seeded fixtures ──
type Change = import('../src/medicoach-sync-contract.js').FixtureChange;
const captured = (suffix: string): Change => {
  const c = (CAPTURED_CHANGES.fixtures as Change[]).find((f) => f.ref.endsWith(`:${suffix}`));
  assert.ok(c, `captured change ${suffix}`);
  return structuredClone(c);
};
/** A captured entry re-addressed to a seeded fixture (ref, team refs, schedule, recordedAt). */
const adapt = (
  suffix: string,
  ref: string,
  date: string,
  recordedAt: string,
  homeTeam: string,
  awayTeam: string,
): Change => {
  const c = captured(suffix);
  const [, , , seriesId] = ref.split(':');
  c.ref = ref;
  c.syncStamp = recordedAt;
  c.teams = {
    homeRef: `smartclub:${T}:team:${seriesId}:${homeTeam}`,
    awayRef: `smartclub:${T}:team:${seriesId}:${awayTeam}`,
  } as Change['teams'];
  c.schedule = { ...c.schedule, scheduledTime: `${date}T10:00:00+02:00` };
  if (c.result) c.result.recordedAt = recordedAt;
  return c;
};
const changesPage = (...fixtures: Change[]) => ({
  version: 1,
  tenant: T,
  nextCursor: '2026-10-26T03:00:00.000Z',
  hasMore: false,
  fixtures,
});
const card = (body: unknown) => ({ status: 200, body });

// ── Seed ──
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
    startDate: OLD,
    teams,
    participants: teams.map((t) => ({ teamId: t, clubId: t, name: t, venue: 'Oval' })),
    fixtures,
    kind: 'series',
    approved: true,
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  }) as unknown as Series;

const fx = (id: string, home: string, away: string, date: string) => ({
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

async function seed(goLiveDate = '2026-09-01') {
  await repo.putTenantConfig({
    tenant: T,
    branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: { medicoachSync: true },
    integrations: { medicoach: { goLiveDate } },
    leagues: [PREMIER_LEAGUE, PROMO_LEAGUE],
  } as unknown as TenantConfig);
  for (const id of ['umzinto', 'african-warriors', 'c', 'd']) await repo.createClub(T, club(id));
  await repo.putSeries(
    T,
    series(
      PREMIER,
      ['umzinto', 'african-warriors'],
      [fx('f3', 'umzinto', 'african-warriors', SAT), fx('f9', 'umzinto', 'african-warriors', OLD)],
      { leagueKey: 'premier' },
    ),
  );
  await repo.putSeasonRun(T, {
    id: 'run-promo',
    leagueKey: 'promotion',
    seasonLabel: '2026/27',
    stages: [],
    structureSnapshot: {},
    calendarSnapshot: {},
    version: 1,
  } as never);
  await repo.putSeries(
    T,
    series(PROMO, ['c', 'd'], [fx('f7', 'c', 'd', SAT)], {
      seasonRunId: 'run-promo',
    }),
  );
  await repo.createUmpire(T, {
    id: 'u-ngubane',
    displayName: 'A.Ngubane',
    aliases: ['angubane'],
    active: true,
  });
  await repo.putFixtureOfficials(T, PREMIER, 'f3', {
    umpires: [{ umpireId: 'u-ngubane', name: 'A.Ngubane' }],
  } as never);
}

// ── Capturing sender ──
type Notice = import('../src/captains-reports.js').ReportNotice;
const notices: Array<Notice & { at: string }> = [];
let clock = at(MON, 4, 45);
const sendNotice = async (n: Notice) => {
  notices.push({ ...n, at: clock.toISOString() });
  return n.channels.map((channel) => ({ channel, status: 'sent' as const }));
};
const seriesOfNotices = () => [...new Set(notices.map((n) => n.reportId.split('~')[0]))].sort();

const pull = (now: Date) => {
  clock = now;
  return puller.runMedicoachSync(T, 'cron', {
    repo,
    url: stubUrl,
    secret: SECRET,
    now: () => now,
    log: () => {},
    captainsReports: { log: () => {}, sendNotice },
  });
};
const sweep = (now: Date) =>
  scorecards.sweepScorecards(
    { repo, url: stubUrl, secret: SECRET, now: () => now, log: () => {} },
    T,
  );
const reportDeps = (now: Date) => {
  clock = now;
  return { repo, now: () => now, log: () => {}, sendNotice };
};

const reportOf = (seriesId: string, fixtureId: string, clubId: string) =>
  repo.getCaptainsReport(T, seriesId, fixtureId, clubId) as Promise<CaptainsReport>;

/** A link token for the report's CURRENT recipient, valid far beyond the wall clock. */
async function tokenFor(seriesId: string, fixtureId: string, clubId: string) {
  const r = await reportOf(seriesId, fixtureId, clubId);
  return reports.signReportLinkToken(
    { t: T, r: r.id, m: r.recipient.memberId, e: Math.floor(Date.parse('2099-01-01') / 1000) },
    env.captainsReportLinkSecret(),
  );
}
const RATED = {
  umpireId: 'u-ngubane',
  name: 'A.Ngubane',
  ratings: { decisions: 4, pressure: 4, behaviour: 4, communication: 4, regulations: 4 },
  concerns: {},
  otherConcern: '',
  comments: '',
};
const complete = (over: Record<string, unknown> = {}) => ({
  captainName: 'S. Mthembu',
  umpires: [RATED],
  general: '',
  declaration: true,
  submit: true,
  ...over,
});
const linkGet = async (s: string, f: string, c: string) =>
  app.request(`/captains-report-link/${await tokenFor(s, f, c)}`);
const linkPut = async (s: string, f: string, c: string, body: unknown) =>
  app.request(`/captains-report-link/${await tokenFor(s, f, c)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

type LinkPayload = {
  report: { resultSummary: string | null };
  scorecard?: {
    matchState?: string;
    fetchedAt: string;
    innings: Array<{
      battingTeamName: string;
      totalRuns: number;
      batters: unknown[];
      bowlers: unknown[];
      fallOfWickets: unknown[];
      extras: { total: number };
    }>;
  };
  result?: { homeScore: string | null; awayScore: string | null; summary?: string };
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
  scorecards = await import('../src/medicoach-sync/scorecard-fetch.js');
  contract = await import('../src/medicoach-sync-contract.js');
  reports = await import('../src/captains-reports.js');
  env = await import('../src/env.js');
  reports.setReportNoticeWindowOverride(undefined); // the real clock rule; every call passes `now`
  await startStub();
});

after(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
  await stopDynalite(ddb);
});

beforeEach(async () => {
  await resetTable();
  notices.length = 0;
  scorecardHits.length = 0;
  page = null;
  cards = {};
});

describe('the captured payloads', () => {
  test('parse the v1 contract verbatim (no massaging)', () => {
    const changes = contract.ChangesResponseSchema.safeParse(CAPTURED_CHANGES);
    assert.ok(changes.success, JSON.stringify(!changes.success && changes.error.issues));
    for (const body of [CARD_CAA, CARD_2F6D_CORRECTED]) {
      const parsed = contract.ScorecardResponseSchema.safeParse(body);
      assert.ok(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues));
      assert.equal(parsed.data.available, true);
      for (const inn of parsed.data.innings ?? [])
        assert.ok(contract.InningsScorecardWireSchema.safeParse(inn).success);
    }
  });
});

describe('1. the Monday 04:30 chain', () => {
  test('premier notifies at 04:45 with its full card; promotion waits for 18:00', async () => {
    await seed();
    const recordedAt = at(MON, 4, 30).toISOString();
    page = changesPage(
      adapt('e2e-csa-f-happy', PREMIER_REF, SAT, recordedAt, 'umzinto', 'african-warriors'),
      adapt('e2e-csa-f-dh-0900', PROMO_REF, SAT, recordedAt, 'c', 'd'),
    );
    cards = { [MATCH_CAA]: card(CARD_CAA), [MATCH_2F6D]: card(CARD_2F6D_CORRECTED) };

    const s = await pull(at(MON, 4, 45));
    assert.equal(s.counts.resultsStored, 2);
    assert.equal(s.reportsDeferred, 1, 'the promotion result is queued for 18:00');
    assert.deepEqual(seriesOfNotices(), [PREMIER]);
    assert.equal(notices.length, 2, 'both premier sides');
    for (const n of notices) {
      assert.equal(n.at, at(MON, 4, 45).toISOString());
      assert.equal(n.recipientKind, 'chair', 'captured captainRef is null → the chair');
    }
    assert.deepEqual(
      (await repo.listReportOpenMarkers(T)).map((m) => m.ref),
      [PROMO_REF],
    );

    // The puller fetched the premier card inline (FIXSCORECARD#) — the promotion one too.
    const stored = await repo.getFixtureScorecard(T, PREMIER, 'f3');
    assert.equal(stored?.available, true);
    assert.equal(stored?.medicoachMatchId, MATCH_CAA);
    // The sweep in the same run has nothing left to do.
    assert.deepEqual(await sweep(at(MON, 4, 46)), { candidates: 0, fetched: 0, failed: 0 });

    // The captain's link carries the whole captured innings.
    const view = (await (await linkGet(PREMIER, 'f3', 'umzinto')).json()) as LinkPayload;
    assert.equal(view.report.resultSummary, 'UKZN 1st XI won by 60 runs');
    assert.equal(view.scorecard?.matchState, CARD_CAA.matchState);
    assert.deepEqual(view.scorecard?.innings, CARD_CAA.innings);
    const first = view.scorecard!.innings[0]!;
    assert.equal(first.battingTeamName, 'UKZN 1st XI');
    assert.equal(first.totalRuns, 160);
    assert.equal(first.batters.length, 5);
    assert.ok(first.bowlers.length > 0);
    assert.equal(first.fallOfWickets.length, 3);
    assert.equal(first.extras.total, 17);
    assert.deepEqual(view.result, {
      homeScore: '160/3 (20)',
      awayScore: '100 all out (17.1)',
      summary: 'UKZN 1st XI won by 60 runs',
      winner: 'home',
    });

    // The answer is required against that card, then accepted.
    const refused = await linkPut(PREMIER, 'f3', 'umzinto', complete());
    assert.equal(refused.status, 400);
    assert.equal(((await refused.json()) as { code?: string }).code, 'scorecard_required');
    const ok = await linkPut(
      PREMIER,
      'f3',
      'umzinto',
      complete({ scorecard: { action: 'confirmed' } }),
    );
    assert.equal(ok.status, 200, await ok.clone().text());
    const saved = await reportOf(PREMIER, 'f3', 'umzinto');
    assert.equal(saved.status, 'submitted');
    assert.deepEqual(saved.scorecard, { action: 'confirmed', againstFetchedAt: stored!.fetchedAt });

    // 18:00: the promotion marker drains.
    notices.length = 0;
    const evening = await reports.retryPendingReportOpens(T, reportDeps(at(MON, 18)));
    assert.equal(evening.done, 1);
    assert.deepEqual(seriesOfNotices(), [PROMO]);
  });
});

describe('2. correction propagation', () => {
  test('a bumped recordedAt + corrected card is refetched and stales the submitted answer', async () => {
    await seed();
    // The captured 2f6d card is the CORRECTED one; the pre-correction card is derived from it
    // (one batter one run short) — the only synthetic data in this file.
    const before = structuredClone(CARD_2F6D_CORRECTED);
    before.innings[0].batters[0].runs -= 1;
    before.innings[0].totalRuns -= 1;
    const first = adapt(
      'e2e-csa-f-dh-0900',
      PREMIER_REF,
      SAT,
      at(MON, 4, 30).toISOString(),
      'umzinto',
      'african-warriors',
    );
    page = changesPage(first);
    cards = { [MATCH_2F6D]: card(before) };
    await pull(at(MON, 4, 45));
    const v1 = await repo.getFixtureScorecard(T, PREMIER, 'f3');
    assert.equal(v1?.innings?.[0]?.totalRuns, CARD_2F6D_CORRECTED.innings[0].totalRuns - 1);
    const ok = await linkPut(
      PREMIER,
      'f3',
      'umzinto',
      complete({ scorecard: { action: 'confirmed' } }),
    );
    assert.equal(ok.status, 200);
    notices.length = 0;

    // medicoach re-confirms the corrected card: same match, recordedAt bumped. Its scorecard
    // endpoint blips during the pull, so the sweep (needsScorecardFetch) does the refetch.
    const corrected = structuredClone(first);
    corrected.result!.recordedAt = at(MON, 9).toISOString();
    corrected.syncStamp = corrected.result!.recordedAt;
    page = changesPage(corrected);
    cards = { [MATCH_2F6D]: { status: 503, body: { error: 'down' } } };
    const s = await pull(at(MON, 9, 15));
    assert.equal(s.counts.resultsStored, 1);
    assert.equal(notices.length, 0, 'a correction notifies nobody');
    assert.equal(
      (await repo.getFixtureScorecard(T, PREMIER, 'f3'))?.fetchedAt,
      v1!.fetchedAt,
      'the failed fetch kept the old card',
    );
    const result = await repo.getFixtureResult(T, PREMIER, 'f3');
    assert.equal(
      scorecards.needsScorecardFetch(result!, v1!, at(MON, 9, 30).getTime()),
      true,
      'recordedAt newer than the card ⇒ refetch',
    );
    assert.equal((await reportOf(PREMIER, 'f3', 'umzinto')).scorecard?.stale, undefined);

    cards = { [MATCH_2F6D]: card(CARD_2F6D_CORRECTED) };
    assert.deepEqual(await sweep(at(MON, 9, 30)), { candidates: 1, fetched: 1, failed: 0 });
    const v2 = await repo.getFixtureScorecard(T, PREMIER, 'f3');
    assert.deepEqual(v2?.innings, CARD_2F6D_CORRECTED.innings);
    assert.equal(v2?.fetchedAt, at(MON, 9, 30).toISOString());
    const answered = await reportOf(PREMIER, 'f3', 'umzinto');
    assert.equal(answered.scorecard?.stale, true, 'the submitted answer is flagged stale');
    assert.equal(answered.scorecard?.againstFetchedAt, v1!.fetchedAt);
    // The other (pending) side now sees the corrected card.
    const other = (await (await linkGet(PREMIER, 'f3', 'african-warriors')).json()) as LinkPayload;
    assert.equal(other.scorecard?.fetchedAt, v2!.fetchedAt);
    assert.equal(notices.length, 0);
  });
});

describe('3. result-only Monday', () => {
  test('available:false opens + notifies card-less; a later sweep attaches the card', async () => {
    await seed();
    page = changesPage(
      adapt(
        'e2e-csa-f-happy',
        PREMIER_REF,
        SAT,
        at(MON, 4, 30).toISOString(),
        'umzinto',
        'african-warriors',
      ),
    );
    cards = { [MATCH_CAA]: card({ available: false, matchId: MATCH_CAA }) };
    await pull(at(MON, 4, 45));
    assert.equal(notices.length, 2);
    assert.ok(notices.every((n) => n.at === at(MON, 4, 45).toISOString()));
    const stub = await repo.getFixtureScorecard(T, PREMIER, 'f3');
    assert.equal(stub?.available, false);
    assert.equal(stub?.terminal, undefined, 'available:false is re-checked, not terminal');
    const cardless = (await (await linkGet(PREMIER, 'f3', 'umzinto')).json()) as LinkPayload;
    assert.equal(cardless.scorecard, undefined);
    assert.equal(cardless.result?.summary, 'UKZN 1st XI won by 60 runs');
    assert.equal(cardless.report.resultSummary, 'UKZN 1st XI won by 60 runs');

    // Inside the 1h re-check interval the sweep leaves it; after it, the card is fetched.
    cards = { [MATCH_CAA]: card(CARD_CAA) };
    assert.equal((await sweep(at(MON, 5, 30))).candidates, 0);
    assert.deepEqual(await sweep(at(MON, 5, 45)), { candidates: 1, fetched: 1, failed: 0 });
    const withCard = (await (await linkGet(PREMIER, 'f3', 'umzinto')).json()) as LinkPayload;
    assert.deepEqual(withCard.scorecard?.innings, CARD_CAA.innings);
    assert.equal(notices.length, 2, 'the card arriving notifies nobody');
  });
});

describe('4. old fixtures', () => {
  test('the too-old rule: 23:59:59 SAST on max(match + 7 days, result received + 3 days)', () => {
    const { reportLinkExpiry, LINK_VALID_DAYS, RESULT_GRACE_DAYS } = reports;
    assert.deepEqual([LINK_VALID_DAYS, RESULT_GRACE_DAYS], [7, 3]);
    const sec = (iso: string) => Date.parse(iso) / 1000;
    // Match rule alone: 4 Oct → 11 Oct 23:59:59 SAST.
    assert.equal(reportLinkExpiry(OLD), sec('2026-10-11T21:59:59Z'));
    // Received on the SAST day 26 Oct → 29 Oct 23:59:59 SAST wins over the match rule.
    assert.equal(reportLinkExpiry(OLD, at(MON, 4, 45).getTime()), sec('2026-10-29T21:59:59Z'));
    // Received at 00:30 SAST on 27 Oct (22:30Z on the 26th) counts as the 27th.
    assert.equal(
      reportLinkExpiry(OLD, Date.parse('2026-10-26T22:30:00Z')),
      sec('2026-10-30T21:59:59Z'),
    );
    // Received just after the match: the match rule wins.
    assert.equal(reportLinkExpiry(OLD, at(OLD, 18).getTime()), sec('2026-10-11T21:59:59Z'));
  });

  test('a FRESH pull of an old match is NOT too-old: it opens and notifies', async () => {
    // receivedAt = now on the puller path, so expiry ≥ today + 3 days > now, always.
    await seed();
    page = changesPage(
      adapt(
        'e2e-csa-f-happy',
        OLD_REF,
        OLD,
        at(MON, 4, 30).toISOString(),
        'umzinto',
        'african-warriors',
      ),
    );
    cards = { [MATCH_CAA]: card(CARD_CAA) };
    await pull(at(MON, 4, 45));
    assert.equal(notices.length, 2, 'KNOWN: the too-old rule does not stop this');
    assert.deepEqual(notices.map((n) => n.to.email).sort(), [
      'chair@african-warriors.test',
      'chair@umzinto.test',
    ]);
    assert.equal(
      (await reportOf(PREMIER, 'f9', 'umzinto')).linkExpiresAt,
      new Date(Date.parse('2026-10-29T21:59:59Z')).toISOString(),
    );
  });

  test('the go-live date is the guard: a match before it opens nothing', async () => {
    await seed('2026-10-20');
    page = changesPage(
      adapt(
        'e2e-csa-f-happy',
        OLD_REF,
        OLD,
        at(MON, 4, 30).toISOString(),
        'umzinto',
        'african-warriors',
      ),
    );
    cards = { [MATCH_CAA]: card(CARD_CAA) };
    const s = await pull(at(MON, 4, 45));
    assert.equal(s.counts.resultsStored, 1, 'the result (and standings) still land');
    assert.equal(notices.length, 0);
    assert.deepEqual(await repo.listCaptainsReportsForFixture(T, PREMIER, 'f9'), []);
    assert.deepEqual(await repo.listReportOpenMarkers(T), [], 'skipped ⇒ marker dropped');
    assert.equal((await repo.getFixtureScorecard(T, PREMIER, 'f9'))?.available, true);
  });

  test('too-old fires only on a retry whose marker is from long ago', async () => {
    await seed();
    const recordedAt = at(OLD, 18).toISOString();
    await repo.putFixtureResultIfNewer(T, {
      seriesId: PREMIER,
      fixtureId: 'f9',
      ref: OLD_REF,
      orderAt: recordedAt,
      recordedAt,
      summary: 'Home won',
      resultSource: 'live',
      storedAt: recordedAt,
    } as never);
    await repo.putReportOpenMarker(T, {
      ref: OLD_REF,
      seriesId: PREMIER,
      fixtureId: 'f9',
      recordedAt,
      createdAt: recordedAt, // first arrived 4 Oct ⇒ expiry 11 Oct 23:59:59 SAST
      attempts: 0,
    });
    const r = await reports.retryPendingReportOpens(T, reportDeps(at(MON, 4, 45)));
    assert.deepEqual([r.done, r.failed], [1, 0]);
    assert.equal(notices.length, 0);
    assert.deepEqual(await repo.listCaptainsReportsForFixture(T, PREMIER, 'f9'), []);
  });

  test('the backfill script: a deferred-league fixture with a stored result is left alone; without one it notifies the CHAIR (no recipient override)', async () => {
    await seed();
    const { runBackfill } = await import('../scripts/backfill-captains-report-notices.js');
    const deps = {
      repo,
      reports,
      dryRun: { email: false, whatsapp: false },
      linkBase: 'https://platform.test',
      log: () => {},
      now: () => at(MON, 9),
      sendNotice,
    };
    const args = {
      tenant: T,
      dates: [OLD],
      seriesIds: [PREMIER],
      confirm: true,
      backupDir: mkdtempSync(path.join(tmpdir(), 'csa-chain-')),
    };
    // No result stored: past its Monday-noon fallback, the card-less report opens to the chair.
    assert.equal(await runBackfill(args, deps), 0);
    assert.deepEqual(notices.map((n) => [n.recipientKind, n.to.email]).sort(), [
      ['chair', 'chair@african-warriors.test'],
      ['chair', 'chair@umzinto.test'],
    ]);
    // With a stored result the deferred league leaves it to the result path: nothing opens.
    await resetTable();
    await seed();
    notices.length = 0;
    const recordedAt = at(OLD, 18).toISOString();
    await repo.putFixtureResultIfNewer(T, {
      seriesId: PREMIER,
      fixtureId: 'f9',
      ref: OLD_REF,
      orderAt: recordedAt,
      recordedAt,
      summary: 'Home won',
      resultSource: 'live',
      storedAt: recordedAt,
    } as never);
    assert.equal(await runBackfill(args, deps), 0);
    assert.equal(notices.length, 0);
  });
});

describe('5. abandoned', () => {
  test('source manual, no result: opens + notifies card-less, the result line is "Abandoned"', async () => {
    await seed();
    page = changesPage(
      adapt(
        'e2e-csa-f-abandoned',
        PREMIER_REF,
        SAT,
        at(MON, 4, 30).toISOString(),
        'umzinto',
        'african-warriors',
      ),
    );
    const s = await pull(at(MON, 4, 45));
    assert.equal(s.counts.resultsStored, 1);
    assert.equal(notices.length, 2, 'manual is not report-suppressed');
    assert.deepEqual(seriesOfNotices(), [PREMIER]);
    assert.deepEqual(scorecardHits, [], 'no medicoach ids ⇒ no scorecard request');
    assert.equal(await repo.getFixtureScorecard(T, PREMIER, 'f3'), null);
    const view = (await (await linkGet(PREMIER, 'f3', 'umzinto')).json()) as LinkPayload;
    assert.equal(view.report.resultSummary, 'Abandoned');
    assert.equal(view.scorecard, undefined);
    assert.deepEqual(view.result, {
      homeScore: null,
      awayScore: null,
      summary: 'Abandoned',
      winner: 'none',
    });
    // An abandoned match has no card to explain: no scorecard-absent note.
    assert.equal((view as { scorecardAbsentNote?: unknown }).scorecardAbsentNote, undefined);
    // Card-less ⇒ no scorecard answer is required.
    const ok = await linkPut(PREMIER, 'f3', 'umzinto', complete());
    assert.equal(ok.status, 200);
  });
});
