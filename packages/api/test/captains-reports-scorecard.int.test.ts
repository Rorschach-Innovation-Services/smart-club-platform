/**
 * Scorecard confirmation inside the captain's report, end to end against an in-process
 * dynalite table (real repo) and the REAL Hono app (the `/r/` link routes and the club
 * portal routes):
 *
 *  - the answer is required to submit whenever an AVAILABLE scorecard is stored (400 with
 *    `code: 'scorecard_required'` + the context to reveal), and not for no card, an
 *    `available: false` stub, or an unlisted match;
 *  - a correction needs its text, and emails the platform OPERATORS (never tenant admins),
 *    best-effort;
 *  - the card version answered against is the client's echo CLAMPED by the server (an older
 *    echo is kept and marks the answer stale; a newer / future / missing one uses the stored
 *    card's `fetchedAt`);
 *  - drafts save partial answers and a cleared answer is REMOVED;
 *  - the link payload and the portal DETAIL route carry the scorecard context (the list never);
 *  - a newer card fetched later marks submitted answers stale (the scorecard sweep hook);
 *  - `available: false` is re-checked for 3 days before it turns terminal (404 at once);
 *  - player erasure scrubs the person's name from a correction's text and counts it.
 *
 * Replaced: the operator correction sender (captured) and medicoach's HTTP (a fake `fetch`).
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type {
  CaptainsReport,
  Series,
  StoredFixtureResult,
  StoredFixtureScorecard,
  TenantConfig,
  UserProfile,
} from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4707;
const TABLE = 'SmartClubCaptainsReportScorecard';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const T = 'dolphins';
const S = 's-premier';
const DAY = 24 * 3600 * 1000;
const MATCH_DATE = new Date(Date.now() - DAY).toISOString().slice(0, 10);

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let cr: typeof import('../src/captains-reports.js');
let fetchMod: typeof import('../src/medicoach-sync/scorecard-fetch.js');
let env: typeof import('../src/env.js');

const devAuth = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const REP = devAuth('rep', 'rep@umzinto.test', [
  { tenantId: T, role: 'rep', clubIds: ['umzinto'] },
]);
const portal = (auth = REP) => ({
  'content-type': 'application/json',
  'x-tenant': T,
  'x-dev-auth': auth,
});

type Correction = import('../src/captains-reports.js').ScorecardCorrectionNotice;
const corrections: Correction[] = [];
let failCorrections = false;

// ── Seed ──
const club = (id: string, name: string) =>
  ({
    id,
    name,
    district: 'd',
    sub: '',
    chair: `${name} Chair`,
    exco: { chair: { name: `${name} Chair`, email: `chair@${id}.test` } },
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
  }) as never;

const innings = () => [
  {
    battingTeamName: 'Umzinto CC',
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

const CARD_AT = '2026-10-04T16:00:00.000Z';
const card = (over: Partial<StoredFixtureScorecard> = {}): StoredFixtureScorecard => ({
  seriesId: S,
  fixtureId: 'f1',
  medicoachMatchId: 'pma-1',
  medicoachTournamentId: 'tour-9',
  schemaVersion: 1,
  fetchedAt: CARD_AT,
  available: true,
  matchState: 'Umzinto CC won by 23 runs',
  innings: innings(),
  ...over,
});

const storeResult = (over: Partial<StoredFixtureResult> = {}) =>
  repo.putFixtureResultIfNewer(T, {
    seriesId: S,
    fixtureId: 'f1',
    ref: `smartclub:${T}:fixture:${S}:f1`,
    orderAt: '2026-10-04T14:31:58.000Z',
    recordedAt: '2026-10-04T14:31:58.000Z',
    resultSource: 'live',
    homeScore: '184/6',
    awayScore: '161/9',
    summary: 'Umzinto CC won by 23 runs',
    winner: 'home',
    medicoachMatchUrl: 'https://medicoach.example/matches/pma-1',
    medicoachMatchId: 'pma-1',
    medicoachTournamentId: 'tour-9',
    storedAt: '2026-10-04T14:32:00.000Z',
    ...over,
  });

const reportFor = (
  clubId: 'umzinto' | 'african-warriors',
  over: Partial<CaptainsReport> = {},
): CaptainsReport => {
  const home = clubId === 'umzinto';
  return {
    id: `${S}~f1~${clubId}`,
    seriesId: S,
    fixtureId: 'f1',
    clubId,
    status: 'pending',
    source: 'auto',
    matchDate: MATCH_DATE,
    side: home ? 'home' : 'away',
    clubName: home ? 'Umzinto CC' : 'African Warriors',
    opponentName: home ? 'African Warriors' : 'Umzinto CC',
    competition: 'Premier T20',
    resultSummary: 'Umzinto CC won by 23 runs',
    umpiresSnapshot: [{ umpireId: 'u-ngubane', name: 'A.Ngubane' }],
    recipient: { kind: 'chair', memberId: `m-${clubId}`, name: 'Chair' },
    captainName: '',
    umpires: [],
    general: '',
    linkExpiresAt: new Date(Date.now() + 7 * DAY).toISOString(),
    createdAt: '2026-10-04T15:00:00.000Z',
    updatedAt: '2026-10-04T15:00:00.000Z',
    ...over,
  };
};

async function seed() {
  await repo.putTenantConfig({
    tenant: T,
    branding: { name: 'Dolphins Cricket', title: 'D', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: { medicoachSync: true },
  } as unknown as TenantConfig);
  await repo.createClub(T, club('umzinto', 'Umzinto CC'));
  await repo.createClub(T, club('african-warriors', 'African Warriors'));
  await repo.putSeries(T, {
    id: S,
    name: 'Premier T20',
    leagueKey: 'premier',
    startDate: MATCH_DATE,
    teams: ['umzinto', 'african-warriors'],
    participants: [
      { teamId: 'umzinto', clubId: 'umzinto', name: 'Umzinto CC', venue: 'Kingsmead' },
      {
        teamId: 'african-warriors',
        clubId: 'african-warriors',
        name: 'African Warriors',
        venue: 'Warriors Oval',
      },
    ],
    fixtures: [
      {
        id: 'f1',
        round: 1,
        date: MATCH_DATE,
        time: '09:00',
        home: 'umzinto',
        away: 'african-warriors',
      },
    ],
    kind: 'series',
    approved: true,
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  } as unknown as Series);
  await repo.createUmpire(T, {
    id: 'u-ngubane',
    displayName: 'A.Ngubane',
    aliases: ['angubane'],
    active: true,
  });
  const users: UserProfile[] = [
    {
      sub: 'op-1',
      email: 'Ops1@Platform.test',
      memberships: [{ tenantId: '*', role: 'operator', clubIds: [] }],
      onboardingSeen: {},
    },
    {
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
  await repo.openCaptainsReportIfAbsent(T, reportFor('umzinto'));
  await repo.openCaptainsReportIfAbsent(T, reportFor('african-warriors'));
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

// ── Requests ──
const getReport = (clubId: 'umzinto' | 'african-warriors') =>
  repo.getCaptainsReport(T, S, 'f1', clubId) as Promise<CaptainsReport>;

async function tokenFor(clubId: 'umzinto' | 'african-warriors') {
  const r = await getReport(clubId);
  return cr.reportLink(T, r, env.captainsReportLinkSecret(), 'http://x').token;
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

const linkPut = async (clubId: 'umzinto' | 'african-warriors', body: unknown) =>
  app.request(`/captains-report-link/${await tokenFor(clubId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const linkGet = async (clubId: 'umzinto' | 'african-warriors') =>
  app.request(`/captains-report-link/${await tokenFor(clubId)}`);
const portalPut = (body: unknown) =>
  app.request(`/club/captains-reports/${encodeURIComponent(`${S}~f1~umzinto`)}`, {
    method: 'PUT',
    headers: portal(),
    body: JSON.stringify(body),
  });

/** A fake medicoach answering every scorecard request with `[status, body]`. */
const medicoach = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const fetchDeps = (fetch: () => Promise<Response>, now: Date) => ({
  repo,
  url: 'http://medicoach.stub',
  secret: 'stub-secret',
  fetch: fetch as unknown as typeof globalThis.fetch,
  now: () => now,
  log: () => {},
});

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');
  cr = await import('../src/captains-reports.js');
  fetchMod = await import('../src/medicoach-sync/scorecard-fetch.js');
  env = await import('../src/env.js');
  cr.setDefaultScorecardCorrectionSender(async (n) => {
    if (failCorrections) throw new Error('ses down');
    corrections.push(n);
    return { messageId: 'm-1' };
  });
});

after(async () => {
  cr.setDefaultScorecardCorrectionSender(undefined);
  await stopDynalite(ddb);
});

beforeEach(async () => {
  await resetTable();
  await seed();
  corrections.length = 0;
  failCorrections = false;
});

describe('the required gate', () => {
  test('an available card makes the answer required: 400 scorecard_required with the context', async () => {
    await storeResult();
    await repo.putFixtureScorecard(T, card());
    const res = await linkPut('umzinto', complete());
    assert.equal(res.status, 400);
    const body = (await res.json()) as {
      error: string;
      code?: string;
      problems: string[];
      scorecardContext?: { scorecard?: { fetchedAt: string } };
    };
    assert.equal(body.code, 'scorecard_required');
    assert.equal(body.error, 'Confirm the scorecard or request a correction.');
    assert.deepEqual(body.problems, ['Confirm the scorecard or request a correction.']);
    assert.equal(body.scorecardContext?.scorecard?.fetchedAt, CARD_AT);
    assert.equal((await getReport('umzinto')).status, 'pending');

    // The portal path answers the same way.
    const viaPortal = await portalPut(complete());
    assert.equal(viaPortal.status, 400);
    assert.equal(((await viaPortal.json()) as { code?: string }).code, 'scorecard_required');

    const ok = await linkPut('umzinto', complete({ scorecard: { action: 'confirmed' } }));
    assert.equal(ok.status, 200);
    const saved = await getReport('umzinto');
    assert.equal(saved.status, 'submitted');
    assert.deepEqual(saved.scorecard, { action: 'confirmed', againstFetchedAt: CARD_AT });
  });

  test('no card, an available:false stub or an unlisted match: not required', async () => {
    assert.equal((await linkPut('umzinto', complete())).status, 200);

    await repo.putFixtureScorecard(T, card({ available: false, innings: undefined }));
    assert.equal((await linkPut('african-warriors', complete())).status, 200);
    assert.equal((await getReport('african-warriors')).scorecard, undefined);

    const unlisted = await app.request('/club/captains-reports/unlisted', {
      method: 'POST',
      headers: portal(),
      body: JSON.stringify({
        ...complete(),
        clubId: 'umzinto',
        opponentName: 'Friendly XI',
        matchDate: MATCH_DATE,
        umpires: [{ name: 'Club umpire', ratings: RATED.ratings }],
      }),
    });
    assert.equal(unlisted.status, 201);
  });

  test('a correction needs its text — required or not — and the text is capped', async () => {
    await repo.putFixtureScorecard(T, card());
    const blank = await linkPut(
      'umzinto',
      complete({ scorecard: { action: 'correction', feedback: '  ' } }),
    );
    assert.equal(blank.status, 400);
    const b = (await blank.json()) as { error: string; code?: string };
    assert.equal(b.error, 'Tell us what needs correcting.');
    assert.equal(b.code, undefined);
    const long = await linkPut(
      'umzinto',
      complete({ scorecard: { action: 'correction', feedback: 'x'.repeat(2001) } }),
    );
    assert.equal(long.status, 400);
    const bad = await linkPut('umzinto', complete({ scorecard: { action: 'approve' } }));
    assert.equal(bad.status, 400);
  });

  test('the context reuses a card already in hand — only the result is fetched', async () => {
    await storeResult();
    let cardReads = 0;
    const counting = {
      getFixtureScorecard: (...a: Parameters<typeof repo.getFixtureScorecard>) => {
        cardReads++;
        return repo.getFixtureScorecard(...a);
      },
      getFixtureResult: repo.getFixtureResult,
    };
    const r = await getReport('umzinto');
    const ctx = await cr.attachScorecardContext(counting, T, r, { card: card() });
    assert.equal(cardReads, 0);
    assert.equal(ctx.scorecard?.fetchedAt, CARD_AT);
    assert.equal(ctx.result?.summary, 'Umzinto CC won by 23 runs');
    // `null` is "fetched, none stored" — still no second read, and no card in the context.
    const none = await cr.attachScorecardContext(counting, T, r, { card: null });
    assert.equal(cardReads, 0);
    assert.equal(none.scorecard, undefined);
    // Without a preloaded card it reads one as before.
    await cr.attachScorecardContext(counting, T, r);
    assert.equal(cardReads, 1);
  });
});

describe('the correction email', () => {
  test('a submitted correction emails every operator — never a tenant admin', async () => {
    await storeResult();
    await repo.putFixtureScorecard(T, card());
    const res = await portalPut(
      complete({ scorecard: { action: 'correction', feedback: 'Extras should be 7' } }),
    );
    assert.equal(res.status, 200);
    const saved = await getReport('umzinto');
    assert.match(saved.ref ?? '', /^CR-\d{4}-\d{4}$/);
    assert.deepEqual(saved.scorecard, {
      action: 'correction',
      feedback: 'Extras should be 7',
      againstFetchedAt: CARD_AT,
    });
    assert.deepEqual(corrections.map((c) => c.to).sort(), [
      'ops1@platform.test',
      'ops2@platform.test',
    ]);
    const [n] = corrections;
    assert.equal(n.ref, saved.ref);
    assert.equal(n.clubName, 'Umzinto CC');
    assert.equal(n.tenantName, 'Dolphins Cricket');
    assert.equal(n.feedback, 'Extras should be 7');
    assert.match(
      n.fixtureLine,
      /^Umzinto CC v African Warriors \(Premier T20\), \w{3} \d{1,2} \w{3} \d{4}$/,
    );
  });

  test('a confirmation or a draft emails nobody; a failing sender never fails the submit', async () => {
    await repo.putFixtureScorecard(T, card());
    const draft = await linkPut('african-warriors', {
      ...complete({ submit: false }),
      scorecard: { action: 'correction', feedback: 'Draft only' },
    });
    assert.equal(draft.status, 200);
    assert.equal(
      (await linkPut('african-warriors', complete({ scorecard: { action: 'confirmed' } }))).status,
      200,
    );
    assert.equal(corrections.length, 0);

    failCorrections = true;
    const res = await linkPut(
      'umzinto',
      complete({ scorecard: { action: 'correction', feedback: 'Wrong total' } }),
    );
    assert.equal(res.status, 200);
    assert.equal((await getReport('umzinto')).status, 'submitted');
  });
});

describe('the card version answered against (server-clamped echo)', () => {
  const submitWithEcho = (echo?: string) =>
    linkPut(
      'umzinto',
      complete({
        scorecard: {
          action: 'confirmed',
          ...(echo ? { againstFetchedAt: echo } : {}),
          stale: true,
        },
      }),
    );

  test('an older echo is kept and the answer is stale at once', async () => {
    await repo.putFixtureScorecard(T, card());
    const older = '2026-10-04T15:00:00.000Z';
    assert.equal((await submitWithEcho(older)).status, 200);
    assert.deepEqual((await getReport('umzinto')).scorecard, {
      action: 'confirmed',
      againstFetchedAt: older,
      stale: true,
    });
  });

  test('a future echo is forged: the stored card is used, and a client "stale" never sticks', async () => {
    await repo.putFixtureScorecard(T, card());
    assert.equal((await submitWithEcho(new Date(Date.now() + DAY).toISOString())).status, 200);
    assert.deepEqual((await getReport('umzinto')).scorecard, {
      action: 'confirmed',
      againstFetchedAt: CARD_AT,
    });
  });

  test('an echo newer than the stored card, or none at all: the stored card', async () => {
    await repo.putFixtureScorecard(T, card());
    assert.equal((await submitWithEcho('2026-10-04T17:00:00.000Z')).status, 200);
    assert.equal((await getReport('umzinto')).scorecard?.againstFetchedAt, CARD_AT);
    assert.equal(
      (await linkPut('african-warriors', complete({ scorecard: { action: 'confirmed' } }))).status,
      200,
    );
    assert.deepEqual((await getReport('african-warriors')).scorecard, {
      action: 'confirmed',
      againstFetchedAt: CARD_AT,
    });
  });
});

describe('drafts', () => {
  test('save partial answers without the submission stamps; a cleared answer is REMOVED', async () => {
    await repo.putFixtureScorecard(T, card());
    const draft = complete({
      submit: false,
      scorecard: { action: 'correction', againstFetchedAt: CARD_AT, stale: true },
    });
    assert.equal((await portalPut(draft)).status, 200);
    assert.deepEqual((await getReport('umzinto')).scorecard, { action: 'correction' });

    // The same draft with the answer cleared (no `scorecard` key at all).
    assert.equal((await portalPut(complete({ submit: false }))).status, 200);
    const after = await getReport('umzinto');
    assert.equal(after.status, 'pending');
    assert.equal('scorecard' in after, false);
  });
});

describe('payloads', () => {
  test('the link carries the scorecard, the live result and the medicoach link', async () => {
    await storeResult();
    await repo.putFixtureScorecard(T, card());
    const body = (await (await linkGet('umzinto')).json()) as Record<string, unknown>;
    assert.deepEqual(body.scorecard, {
      matchState: 'Umzinto CC won by 23 runs',
      innings: innings(),
      fetchedAt: CARD_AT,
    });
    assert.deepEqual(body.result, {
      homeScore: '184/6',
      awayScore: '161/9',
      summary: 'Umzinto CC won by 23 runs',
      winner: 'home',
    });
    assert.equal(body.medicoachMatchUrl, 'https://medicoach.example/matches/pma-1');
  });

  test('no available card ⇒ no scorecard; a non-http link is dropped; a cleared result shows none', async () => {
    await storeResult({ medicoachMatchUrl: 'javascript:alert(1)' });
    await repo.putFixtureScorecard(T, card({ available: false, innings: undefined }));
    let body = (await (await linkGet('umzinto')).json()) as Record<string, unknown>;
    assert.equal(body.scorecard, undefined);
    assert.ok(body.result);
    assert.equal(body.medicoachMatchUrl, undefined);

    await storeResult({
      cleared: true,
      clearedAt: '2026-10-04T18:00:00.000Z',
      orderAt: '2026-10-04T18:00:00.000Z',
    });
    body = (await (await linkGet('umzinto')).json()) as Record<string, unknown>;
    assert.equal(body.result, undefined);
  });

  test('the portal DETAIL route carries the context; the list never does', async () => {
    await storeResult();
    await repo.putFixtureScorecard(T, card());
    const detail = (await (
      await app.request(`/club/captains-reports/${encodeURIComponent(`${S}~f1~umzinto`)}`, {
        headers: portal(),
      })
    ).json()) as {
      id: string;
      scorecardContext?: { scorecard?: { fetchedAt: string }; medicoachMatchUrl?: string };
    };
    assert.equal(detail.id, `${S}~f1~umzinto`);
    assert.equal(detail.scorecardContext?.scorecard?.fetchedAt, CARD_AT);
    assert.equal(
      detail.scorecardContext?.medicoachMatchUrl,
      'https://medicoach.example/matches/pma-1',
    );

    const list = (await (
      await app.request('/club/captains-reports?clubId=umzinto', { headers: portal() })
    ).json()) as Array<Record<string, unknown>>;
    assert.equal(list.length, 1);
    assert.equal('scorecardContext' in list[0], false);
  });
});

describe('a newer card marks submitted answers stale (scorecard fetch hook)', () => {
  test('answered + submitted ⇒ stale; unanswered or still pending ⇒ untouched', async () => {
    await repo.putFixtureScorecard(T, card());
    assert.equal(
      (await linkPut('umzinto', complete({ scorecard: { action: 'confirmed' } }))).status,
      200,
    );
    // The other side drafts an answer but has not submitted.
    await linkPut('african-warriors', {
      ...complete({ submit: false }),
      scorecard: { action: 'confirmed' },
    });

    const later = new Date('2026-10-05T09:00:00.000Z');
    const outcome = await fetchMod.fetchAndStoreScorecard(
      fetchDeps(medicoach(200, { available: true, matchId: 'pma-1', innings: innings() }), later),
      T,
      S,
      'f1',
      'pma-1',
      'tour-9',
    );
    assert.equal(outcome, 'stored');
    assert.deepEqual((await getReport('umzinto')).scorecard, {
      action: 'confirmed',
      againstFetchedAt: CARD_AT,
      stale: true,
    });
    assert.equal((await getReport('african-warriors')).scorecard?.stale, undefined);
  });

  test('a report submitted without an answer is never flagged; the same card twice flags nothing', async () => {
    assert.equal((await linkPut('umzinto', complete())).status, 200); // no card yet → no answer
    assert.equal(await repo.flagStaleCaptainsReportScorecards(T, S, 'f1', CARD_AT), 0);
    assert.equal('scorecard' in (await getReport('umzinto')), false);

    await repo.putFixtureScorecard(T, card());
    assert.equal(
      (await linkPut('african-warriors', complete({ scorecard: { action: 'confirmed' } }))).status,
      200,
    );
    assert.equal(await repo.flagStaleCaptainsReportScorecards(T, S, 'f1', CARD_AT), 0);
    assert.equal(
      await repo.flagStaleCaptainsReportScorecards(T, S, 'f1', '2026-10-05T00:00:00.000Z'),
      1,
    );
    // Already stale: not counted again.
    assert.equal(
      await repo.flagStaleCaptainsReportScorecards(T, S, 'f1', '2026-10-06T00:00:00.000Z'),
      0,
    );
  });
});

describe('available:false is re-checked for 3 days', () => {
  test('a stub stays open (re-checked hourly), keeps its first-seen time, then turns terminal', async () => {
    await storeResult();
    const t0 = new Date('2026-10-04T15:00:00.000Z');
    const unavailable = medicoach(200, {
      available: false,
      matchId: 'pma-1',
      matchState: 'Scoring',
    });
    const fetchAt = (at: Date) =>
      fetchMod.fetchAndStoreScorecard(fetchDeps(unavailable, at), T, S, 'f1', 'pma-1', 'tour-9');

    assert.equal(await fetchAt(t0), 'unavailable');
    let stub = (await repo.getFixtureScorecard(T, S, 'f1'))!;
    assert.equal(stub.available, false);
    assert.equal(stub.terminal, undefined);
    assert.equal(stub.fetchedAt, t0.toISOString());

    const result = (await repo.getFixtureResult(T, S, 'f1'))!;
    const due = (msAfter: number) =>
      fetchMod.needsScorecardFetch(result, stub, t0.getTime() + msAfter);
    assert.equal(due(30 * 60_000), false, 'not again within the hour');
    assert.equal(due(fetchMod.SCORECARD_UNAVAILABLE_RECHECK_MS), true);

    const day2 = new Date(t0.getTime() + 2 * DAY);
    assert.equal(await fetchAt(day2), 'unavailable');
    stub = (await repo.getFixtureScorecard(T, S, 'f1'))!;
    assert.equal(stub.terminal, undefined);
    assert.equal(stub.fetchedAt, t0.toISOString(), 'the window keeps its start');
    assert.equal(stub.lastCheckedAt, day2.toISOString());
    assert.equal(
      fetchMod.needsScorecardFetch(result, stub, day2.getTime() + 10 * 60_000),
      false,
      'the re-check interval runs from the last check',
    );

    const day3 = new Date(t0.getTime() + 3 * DAY);
    assert.equal(await fetchAt(day3), 'unavailable');
    stub = (await repo.getFixtureScorecard(T, S, 'f1'))!;
    assert.equal(stub.terminal, true);
    assert.equal(fetchMod.needsScorecardFetch(result, stub, day3.getTime() + DAY), false);
  });

  test('a card published inside the window replaces the stub; a 404 is terminal at once', async () => {
    await storeResult();
    const t0 = new Date('2026-10-04T15:00:00.000Z');
    await fetchMod.fetchAndStoreScorecard(
      fetchDeps(medicoach(200, { available: false, matchId: 'pma-1' }), t0),
      T,
      S,
      'f1',
      'pma-1',
      'tour-9',
    );
    const later = new Date(t0.getTime() + 5 * 3600_000);
    assert.equal(
      await fetchMod.fetchAndStoreScorecard(
        fetchDeps(medicoach(200, { available: true, matchId: 'pma-1', innings: innings() }), later),
        T,
        S,
        'f1',
        'pma-1',
        'tour-9',
      ),
      'stored',
    );
    assert.equal((await repo.getFixtureScorecard(T, S, 'f1'))?.available, true);

    await fetchMod.fetchAndStoreScorecard(
      fetchDeps(medicoach(404, { error: 'not found' }), t0),
      T,
      S,
      'f1',
      'pma-gone',
      'tour-9',
    );
    const gone = await repo.getFixtureScorecard(T, S, 'f1');
    assert.equal(gone?.terminal, true);
  });
});

describe('player erasure', () => {
  const FEEDBACK = 'XOLANI  zulu was caught, not bowled. Xolani Zuluness is fine.';
  async function seedCorrection() {
    await repo.createPlayer(T, {
      naturalKey: 'nk-xolani',
      clubId: 'umzinto',
      firstName: 'Xolani',
      lastName: 'Zulu',
      email: 'xolani@umzinto.test',
      cell: '0839876543',
      isMinor: false,
    } as never);
    await repo.putFixtureScorecard(T, card());
    assert.equal(
      (
        await linkPut(
          'umzinto',
          complete({ scorecard: { action: 'correction', feedback: FEEDBACK } }),
        )
      ).status,
      200,
    );
  }

  type Send = (cmd: unknown, ...rest: unknown[]) => Promise<unknown>;
  /** Route every DynamoDB command through `intercept`; `undefined` passes the command through. */
  async function withSend<R>(
    intercept: (
      cmd: { input: Record<string, unknown>; kind: string },
      original: Send,
    ) => Promise<unknown> | undefined,
    fn: () => Promise<R>,
  ): Promise<R> {
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
    const proto = DynamoDBDocumentClient.prototype as unknown as { send: Send };
    const original = proto.send;
    proto.send = function (this: unknown, cmd: unknown, ...rest: unknown[]) {
      const c = cmd as { input: Record<string, unknown>; constructor: { name: string } };
      const bound: Send = (x, ...r) => original.call(this, x, ...r);
      return intercept({ input: c.input, kind: c.constructor.name }, bound) ?? bound(cmd, ...rest);
    };
    try {
      return await fn();
    } finally {
      proto.send = original;
    }
  }
  const isFeedbackScrub = (c: { input: Record<string, unknown>; kind: string }) =>
    c.kind === 'UpdateCommand' &&
    String(c.input.ConditionExpression ?? '').includes('scorecard.feedback = :old');

  test('a feedback that keeps changing → contention error with NOTHING deleted', async () => {
    await seedCorrection();
    const ccf = () =>
      Promise.reject(
        Object.assign(new Error('The conditional request failed'), {
          name: 'ConditionalCheckFailedException',
        }),
      );
    await withSend(
      (c) => (isFeedbackScrub(c) ? ccf() : undefined),
      () =>
        assert.rejects(repo.erasePlayerData(T, 'nk-xolani', { by: 'admin@union.test' }), {
          name: 'ScorecardScrubContentionError',
          code: 'SCORECARD_SCRUB_CONTENTION',
          target: 'feedback',
        }),
    );
    assert.ok(await repo.getPlayer(T, 'umzinto', 'nk-xolani'), 'PLAYER# row kept');
    assert.equal((await getReport('umzinto')).scorecard?.feedback, FEEDBACK, 'feedback intact');
    assert.equal((await repo.listPlayerEraseLogs(T)).length, 0, 'no audit row');
  });

  test('a draft save that removed the scorecard mid-scrub (missing path) settles', async () => {
    await seedCorrection();
    let raced = false;
    const counts = await withSend(
      (c, original) => {
        if (!isFeedbackScrub(c) || raced) return undefined;
        raced = true;
        return (async () => {
          // The concurrent save lands first: `scorecard` is gone, so the nested SET has no parent.
          const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
          await original(
            new UpdateCommand({
              TableName: TABLE,
              Key: c.input.Key as Record<string, unknown>,
              UpdateExpression: 'REMOVE scorecard',
            }),
          );
          throw Object.assign(
            new Error('The document path provided in the update expression is invalid for update'),
            { name: 'ValidationException' },
          );
        })();
      },
      () => repo.erasePlayerData(T, 'nk-xolani', { by: 'admin@union.test' }),
    );
    assert.ok(raced, 'the race was exercised');
    assert.ok(counts);
    assert.equal(counts.reportScorecardFeedbackScrubbed, 0, 'nothing left to scrub');
    assert.equal(counts.playerRows, 1, 'erasure completed');
    assert.equal((await getReport('umzinto')).scorecard, undefined);
    assert.equal(await repo.getPlayer(T, 'umzinto', 'nk-xolani'), null);
  });

  test("scrubs the person's name from a correction's text and counts it", async () => {
    await seedCorrection();
    const counts = await repo.erasePlayerData(T, 'nk-xolani', { by: 'admin@union.test' });
    assert.ok(counts);
    assert.equal(counts.reportScorecardFeedbackScrubbed, 1);
    assert.equal(counts.captainsReportsScrubbed, 1);
    const feedback = (await getReport('umzinto')).scorecard?.feedback ?? '';
    assert.doesNotMatch(feedback, /xolani\s+zulu\b/i);
    assert.match(feedback, /^\[removed\] was caught/);
    assert.match(feedback, /Xolani Zuluness is fine/, 'whole words only');
    assert.equal((await getReport('umzinto')).scorecard?.action, 'correction');
    const [log] = await repo.listPlayerEraseLogs(T);
    assert.equal(log.counts.reportScorecardFeedbackScrubbed, 1);
  });
});
