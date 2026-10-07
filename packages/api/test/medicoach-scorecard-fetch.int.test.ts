/**
 * Medicoach scorecards (FIXSCORECARD#) end to end against a STUB medicoach: a real HTTP
 * server that verifies every request's signature with the contract helper and serves both
 * `/changes` pages and per-match scorecards. The puller, the scorecard fetch and the sweep run
 * for real against an in-process dynalite table (real repo).
 *
 * Covers: a pulled result fetches + stores its scorecard (signed, tournamentId in the query);
 * the ids persist on the result; 404 → terminal stub; available:false stored (terminal);
 * a network/5xx failure is swallowed and the sweep retries it; the sweep skips terminal
 * rows, import results, cleared results, results missing an id, and old results; it
 * refetches when the result is newer than the card; a cleared result deletes the card;
 * import results never fetch; runTenantSync runs the sweep and survives its failure.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Series, StoredFixtureResult, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4699;
const TABLE = 'SmartClubMedicoachScorecardFetch';
dynaliteEnv(DDB_PORT, TABLE);

const SECRET = 'stub-shared-secret';
const T = 'dolphins';
const SERIES = 's-premier-g1';
const REF = (f: string) => `smartclub:${T}:fixture:${SERIES}:${f}`;
const NOW = new Date('2026-10-05T12:00:00.000Z');

let ddb: Server;
let repo: typeof import('../src/repo.js');
let puller: typeof import('../src/medicoach-sync/puller.js');
let scorecards: typeof import('../src/medicoach-sync/scorecard-fetch.js');
let runMod: typeof import('../src/medicoach-sync/run.js');
let contract: typeof import('../src/medicoach-sync-contract.js');

// ── Stub medicoach ──
let stub: Server;
let stubUrl = '';
const requests: Array<{ pathAndQuery: string; verified: boolean }> = [];
let pages: unknown[] = [];
/** matchId → [status, body]; a missing match answers 404. */
let cards: Record<string, [number, unknown]> = {};
/** Drop the connection for scorecard requests (a network failure). */
let dropScorecards = false;

function startStub(): Promise<void> {
  stub = createServer((req, res) => {
    const pathAndQuery = req.url ?? '';
    const check = contract.verifySignature({
      secret: SECRET,
      method: req.method ?? 'GET',
      pathAndQuery,
      body: '',
      timestampHeader: req.headers['x-sync-timestamp'] as string | undefined,
      signatureHeader: req.headers['x-sync-signature'] as string | undefined,
    });
    requests.push({ pathAndQuery, verified: check.ok });
    if (!check.ok) {
      res.writeHead(401).end('{"error":"bad signature"}');
      return;
    }
    const m = pathAndQuery.match(/^\/integrations\/smartclub\/matches\/([^/]+)\/scorecard\?/);
    if (m) {
      if (dropScorecards) {
        req.socket.destroy();
        return;
      }
      const [status, body] = cards[decodeURIComponent(m[1])] ?? [404, { error: 'not found' }];
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      return;
    }
    const body = pages.length > 1 ? pages.shift() : pages[0];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  return new Promise((resolve) =>
    stub.listen(0, '127.0.0.1', () => {
      stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

const scorecardRequests = () => requests.filter((r) => r.pathAndQuery.includes('/matches/'));

const innings = () => [
  {
    battingTeamName: 'Umzinto',
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
const available = (matchId: string): [number, unknown] => [
  200,
  { available: true, matchId, matchState: 'Umzinto won by 23 runs', innings: innings() },
];

// ── Changes pages ──
const result = (over: Record<string, unknown> = {}) => ({
  homeScore: '184/6 (20)',
  awayScore: '161/9 (20)',
  summary: 'Umzinto won by 23 runs',
  winner: 'home',
  method: 'normal',
  noResult: false,
  source: 'live',
  recordedAt: '2026-10-04T14:31:58.000Z',
  scoringSide: 'home',
  captainRef: null,
  medicoachMatchUrl: null,
  medicoachMatchId: 'pma-1',
  medicoachTournamentId: 'tour-9',
  ...over,
});
const change = (
  fixtureId: string,
  r: Record<string, unknown> | null,
  resultClearedAt: string | null = null,
) => ({
  ref: REF(fixtureId),
  syncStamp: '2026-10-04T14:32:10.123Z',
  schedule: {
    scheduledTime: '2026-10-04T09:00:00+02:00',
    timeTbc: false,
    dateTbc: false,
    venue: null,
    postponed: false,
    cancelled: false,
    changedAt: '2026-09-20T10:00:00.000Z',
  },
  teams: { homeRef: null, awayRef: null },
  result: r,
  resultClearedAt,
});
const page = (cursor: string, fixtures: unknown[]) => ({
  version: 1,
  tenant: T,
  nextCursor: cursor,
  hasMore: false,
  fixtures,
});

async function seed() {
  await repo.putTenantConfig({
    tenant: T,
    branding: { name: 'D', title: 'D', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: { medicoachSync: true },
  } as unknown as TenantConfig);
  const fx = (id: string) => ({
    id,
    round: 1,
    date: '2026-10-04',
    time: '09:00',
    home: 'umzinto',
    away: 'warriors',
  });
  await repo.putSeries(T, {
    id: SERIES,
    name: 'premier · T20',
    leagueKey: 'premier',
    startDate: '2026-10-04',
    teams: ['umzinto', 'warriors'],
    participants: [],
    fixtures: Array.from({ length: 12 }, (_, i) => fx(`f${i + 1}`)),
    kind: 'series',
    approved: true,
    released: true,
    version: 1,
  } as unknown as Series);
}

const logs: string[] = [];
const deps = (over: Record<string, unknown> = {}) => ({
  repo,
  url: stubUrl,
  secret: SECRET,
  now: () => NOW,
  log: (l: string) => logs.push(l),
  onResultStored: async () => {},
  ...over,
});
const pull = (over: Record<string, unknown> = {}) =>
  puller.runMedicoachSync(T, 'manual', deps(over));
const sweep = () => scorecards.sweepScorecards(deps(), T);

/** A stored result straight into the table (as an earlier pull would have left it). */
const storeResult = (fixtureId: string, over: Partial<StoredFixtureResult> = {}) =>
  repo.putFixtureResultIfNewer(T, {
    seriesId: SERIES,
    fixtureId,
    ref: REF(fixtureId),
    orderAt: '2026-10-04T14:31:58.000Z',
    recordedAt: '2026-10-04T14:31:58.000Z',
    resultSource: 'live',
    medicoachMatchId: `pma-${fixtureId}`,
    medicoachTournamentId: 'tour-9',
    storedAt: '2026-10-04T14:32:00.000Z',
    ...over,
  });

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
  puller = await import('../src/medicoach-sync/puller.js');
  scorecards = await import('../src/medicoach-sync/scorecard-fetch.js');
  runMod = await import('../src/medicoach-sync/run.js');
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
  requests.length = 0;
  logs.length = 0;
  pages = [];
  cards = {};
  dropScorecards = false;
});

describe('medicoach scorecard fetch', () => {
  test('a pulled result persists both ids and fetches + stores its scorecard (signed)', async () => {
    cards = { 'pma-1': available('pma-1') };
    pages = [page('c1', [change('f1', result())])];
    const summary = await pull();
    assert.equal(summary.counts.resultsStored, 1);

    const stored = await repo.getFixtureResult(T, SERIES, 'f1');
    assert.equal(stored?.medicoachMatchId, 'pma-1');
    assert.equal(stored?.medicoachTournamentId, 'tour-9');

    const sc = scorecardRequests();
    assert.equal(sc.length, 1);
    assert.equal(sc[0].verified, true);
    assert.equal(
      sc[0].pathAndQuery,
      '/integrations/smartclub/matches/pma-1/scorecard?tournamentId=tour-9',
    );

    const card = await repo.getFixtureScorecard(T, SERIES, 'f1');
    assert.deepEqual(card, {
      seriesId: SERIES,
      fixtureId: 'f1',
      medicoachMatchId: 'pma-1',
      medicoachTournamentId: 'tour-9',
      schemaVersion: 1,
      fetchedAt: NOW.toISOString(),
      available: true,
      matchState: 'Umzinto won by 23 runs',
      innings: innings(),
    });
    // No player name is ever logged.
    assert.doesNotMatch(logs.join('\n'), /Batter|Bowler/);
  });

  test('a result without both ids fetches nothing: no request, no row', async () => {
    pages = [
      page('c1', [
        change('f1', result({ medicoachMatchId: undefined, medicoachTournamentId: undefined })),
        change('f2', result({ medicoachTournamentId: undefined })),
        change('f3', result({ medicoachMatchId: '' })),
      ]),
    ];
    assert.equal((await pull()).counts.resultsStored, 3);
    assert.equal(scorecardRequests().length, 0);
    assert.deepEqual(await repo.listFixtureScorecards(T), []);
    const f3 = await repo.getFixtureResult(T, SERIES, 'f3');
    assert.equal('medicoachMatchId' in f3!, false, 'an empty id is not stored');
    // …and the sweep does not chase them either.
    assert.deepEqual(await sweep(), { candidates: 0, fetched: 0, failed: 0 });
  });

  test('404 stores a terminal stub; available:false is stored terminal too', async () => {
    cards = { 'pma-2': [200, { available: false, matchId: 'pma-2', matchState: 'Manual result' }] };
    pages = [
      page('c1', [
        change('f1', result({ medicoachMatchId: 'pma-gone' })),
        change('f2', result({ medicoachMatchId: 'pma-2', source: 'manual' })),
      ]),
    ];
    await pull();
    const gone = await repo.getFixtureScorecard(T, SERIES, 'f1');
    assert.equal(gone?.available, false);
    assert.equal(gone?.terminal, true);
    assert.equal(gone?.innings, undefined);
    const manual = await repo.getFixtureScorecard(T, SERIES, 'f2');
    assert.equal(manual?.available, false);
    assert.equal(manual?.terminal, true);
    assert.equal(manual?.matchState, 'Manual result');

    // Terminal rows are never re-asked by the sweep.
    requests.length = 0;
    assert.equal((await sweep()).candidates, 0);
    assert.equal(scorecardRequests().length, 0);
  });

  test('a later 404 or available:false never destroys an available card (kept; lastCheckedAt moves)', async () => {
    cards = { 'pma-1': available('pma-1') };
    pages = [page('c1', [change('f1', result())])];
    await pull();
    const before = (await repo.getFixtureScorecard(T, SERIES, 'f1'))!;
    assert.equal(before.available, true);

    const later = new Date(NOW.getTime() + 3_600_000);
    const fetchAgain = (matchId = 'pma-1') =>
      scorecards.fetchAndStoreScorecard(
        deps({ now: () => later }),
        T,
        SERIES,
        'f1',
        matchId,
        'tour-9',
      );
    cards = {}; // medicoach now answers 404
    assert.equal(await fetchAgain(), 'not-found');
    const kept = (await repo.getFixtureScorecard(T, SERIES, 'f1'))!;
    assert.deepEqual(kept, { ...before, lastCheckedAt: later.toISOString() });

    cards = { 'pma-1': [200, { available: false, matchId: 'pma-1' }] };
    assert.equal(await fetchAgain(), 'unavailable');
    assert.equal((await repo.getFixtureScorecard(T, SERIES, 'f1'))?.available, true);
    assert.deepEqual((await repo.getFixtureScorecard(T, SERIES, 'f1'))?.innings, innings());

    // A card for ANOTHER match is not this match's card: the stub replaces it.
    assert.equal(await fetchAgain('pma-other'), 'not-found');
    const stub = await repo.getFixtureScorecard(T, SERIES, 'f1');
    assert.equal(stub?.available, false);
    assert.equal(stub?.terminal, true);
  });

  test('inline scorecard fetches are capped at 10 per page; the sweep picks up the rest', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `f${i + 1}`);
    cards = Object.fromEntries(ids.map((f) => [`pma-${f}`, available(`pma-${f}`)]));
    pages = [
      page(
        'c1',
        ids.map((f) => change(f, result({ medicoachMatchId: `pma-${f}` }))),
      ),
    ];
    assert.equal((await pull()).counts.resultsStored, 12);
    assert.equal(scorecardRequests().length, 10);
    assert.equal((await repo.listFixtureScorecards(T)).length, 10);
    assert.deepEqual(await sweep(), { candidates: 2, fetched: 2, failed: 0 });
  });

  test('inline scorecard fetches stop after 3 failures in a row', async () => {
    dropScorecards = true;
    const ids = ['f1', 'f2', 'f3', 'f4', 'f5'];
    pages = [
      page(
        'c1',
        ids.map((f) => change(f, result({ medicoachMatchId: `pma-${f}` }))),
      ),
    ];
    assert.equal((await pull()).counts.resultsStored, 5);
    assert.equal(scorecardRequests().length, 3);
  });

  test('a network failure or 5xx is swallowed (result still stored) and the sweep retries', async () => {
    dropScorecards = true;
    pages = [page('c1', [change('f1', result())])];
    const summary = await pull();
    assert.equal(summary.status, 'ok');
    assert.equal(summary.counts.resultsStored, 1);
    assert.equal(await repo.getFixtureScorecard(T, SERIES, 'f1'), null);
    assert.match(logs.join('\n'), /scorecard for s-premier-g1\/f1: fetch failed/);

    dropScorecards = false;
    cards = { 'pma-1': [503, { error: 'busy' }] };
    assert.deepEqual(await sweep(), { candidates: 1, fetched: 0, failed: 1 });
    assert.equal(await repo.getFixtureScorecard(T, SERIES, 'f1'), null);
    assert.match(logs.join('\n'), /HTTP 503 — will retry/);

    cards = { 'pma-1': available('pma-1') };
    assert.deepEqual(await sweep(), { candidates: 1, fetched: 1, failed: 0 });
    assert.equal((await repo.getFixtureScorecard(T, SERIES, 'f1'))?.available, true);
    // Done: nothing left to sweep.
    assert.equal((await sweep()).candidates, 0);
  });

  test('a sweep gives up after 3 failures in a row (medicoach down)', async () => {
    for (const f of ['f1', 'f2', 'f3', 'f4', 'f5']) await storeResult(f);
    dropScorecards = true;
    assert.deepEqual(await sweep(), { candidates: 5, fetched: 0, failed: 3 });
    assert.equal(scorecardRequests().length, 3);
  });

  test('a body that fails the schema (or names another match) is not stored', async () => {
    cards = { 'pma-1': [200, { available: true, matchId: 'pma-other' }] };
    pages = [page('c1', [change('f1', result())])];
    await pull();
    assert.equal(await repo.getFixtureScorecard(T, SERIES, 'f1'), null);
    cards = { 'pma-1': [200, { available: 'yes', matchId: 'pma-1' }] };
    assert.equal((await sweep()).failed, 1);
    assert.equal(await repo.getFixtureScorecard(T, SERIES, 'f1'), null);
  });

  test('import results never fetch, in the pull or the sweep', async () => {
    cards = { 'pma-1': available('pma-1') };
    pages = [page('c1', [change('f1', result({ source: 'import' }))])];
    assert.equal((await pull()).counts.resultsStored, 1);
    assert.equal(scorecardRequests().length, 0);
    assert.equal((await sweep()).candidates, 0);
    assert.deepEqual(await repo.listFixtureScorecards(T), []);
  });

  test('the sweep skips cleared, import, id-less and old results; fetches the rest', async () => {
    await storeResult('f1'); // due: no card
    await storeResult('f2', { resultSource: 'import' });
    await storeResult('f3', {
      cleared: true,
      clearedAt: '2026-10-04T15:00:00.000Z',
      orderAt: '2026-10-04T15:00:00.000Z',
    });
    await storeResult('f4', { medicoachTournamentId: undefined });
    await storeResult('f5', {
      recordedAt: '2026-09-01T10:00:00.000Z',
      orderAt: '2026-09-01T10:00:00.000Z',
    }); // older than the 14-day window
    cards = Object.fromEntries(
      ['f1', 'f2', 'f3', 'f4', 'f5'].map((f) => [`pma-${f}`, available(`pma-${f}`)]),
    );
    assert.deepEqual(await sweep(), { candidates: 1, fetched: 1, failed: 0 });
    assert.deepEqual(
      scorecardRequests().map((r) => r.pathAndQuery),
      ['/integrations/smartclub/matches/pma-f1/scorecard?tournamentId=tour-9'],
    );
  });

  test('the sweep refetches a non-terminal card older than its result, and a changed match', async () => {
    await storeResult('f1', {
      recordedAt: '2026-10-05T10:00:00.000Z',
      orderAt: '2026-10-05T10:00:00.000Z',
    });
    await storeResult('f2', { medicoachMatchId: 'pma-new' });
    const card = {
      seriesId: SERIES,
      medicoachTournamentId: 'tour-9',
      schemaVersion: 1 as const,
      available: true,
    };
    // f1: fetched before the (corrected) result was recorded → stale.
    await repo.putFixtureScorecard(T, {
      ...card,
      fixtureId: 'f1',
      medicoachMatchId: 'pma-f1',
      fetchedAt: '2026-10-05T09:00:00.000Z',
    });
    // f2: terminal, but for the match the result no longer points at.
    await repo.putFixtureScorecard(T, {
      ...card,
      fixtureId: 'f2',
      medicoachMatchId: 'pma-old',
      fetchedAt: '2026-10-05T11:00:00.000Z',
      available: false,
      terminal: true,
    });
    cards = { 'pma-f1': available('pma-f1'), 'pma-new': available('pma-new') };
    assert.deepEqual(await sweep(), { candidates: 2, fetched: 2, failed: 0 });
    assert.equal((await repo.getFixtureScorecard(T, SERIES, 'f1'))?.fetchedAt, NOW.toISOString());
    const f2 = await repo.getFixtureScorecard(T, SERIES, 'f2');
    assert.equal(f2?.medicoachMatchId, 'pma-new');
    assert.equal(f2?.terminal, undefined);

    // A fresh card (fetched after the result) is left alone.
    requests.length = 0;
    assert.equal((await sweep()).candidates, 0);
    assert.equal(scorecardRequests().length, 0);
  });

  test('a cleared result deletes its scorecard', async () => {
    cards = { 'pma-1': available('pma-1') };
    pages = [page('c1', [change('f1', result())])];
    await pull();
    assert.ok(await repo.getFixtureScorecard(T, SERIES, 'f1'));
    pages = [page('c2', [change('f1', null, '2026-10-04T16:00:00.000Z')])];
    assert.equal((await pull()).counts.resultsCleared, 1);
    assert.equal(await repo.getFixtureScorecard(T, SERIES, 'f1'), null);
  });

  test('a dry run (no secret) never fetches a scorecard', async () => {
    await storeResult('f1');
    const summary = await scorecards.sweepScorecards(deps({ secret: '' }), T);
    assert.deepEqual(summary, { candidates: 0, fetched: 0, failed: 0 });
    assert.equal(
      await scorecards.fetchAndStoreScorecard(
        deps({ secret: '' }),
        T,
        SERIES,
        'f1',
        'pma-f1',
        'tour-9',
      ),
      'skipped',
    );
    assert.equal(requests.length, 0);
  });

  test('runTenantSync sweeps after the pull and survives a sweep failure', async () => {
    await storeResult('f2'); // left without a card by an earlier failed fetch
    cards = { 'pma-f2': available('pma-f2') };
    pages = [page('c1', [])];
    const summary = await runMod.runTenantSync(T, 'cron', deps());
    assert.equal(summary.status, 'ok');
    assert.deepEqual(summary.scorecards, { candidates: 1, fetched: 1, failed: 0 });
    assert.equal((await repo.getFixtureScorecard(T, SERIES, 'f2'))?.available, true);

    // A repo failure inside the sweep is isolated: the run still completes.
    const broken = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === 'listFixtureScorecards')
          return async () => {
            throw new Error('ddb down');
          };
        return Reflect.get(target, prop, receiver);
      },
    });
    const again = await runMod.runTenantSync(T, 'cron', deps({ repo: broken }));
    assert.equal(again.status, 'ok');
    assert.equal(again.scorecards, undefined);
  });
});

describe('scorecard erasure', () => {
  test('deleting a series sync state drops that series’ scorecards only', async () => {
    const base = {
      fixtureId: 'f1',
      medicoachMatchId: 'm',
      medicoachTournamentId: 't',
      schemaVersion: 1 as const,
      fetchedAt: NOW.toISOString(),
      available: false,
    };
    await repo.putFixtureScorecard(T, { ...base, seriesId: SERIES });
    await repo.putFixtureScorecard(T, { ...base, seriesId: 'other-series' });
    await repo.deleteSeriesSyncState(T, SERIES);
    assert.deepEqual(
      (await repo.listFixtureScorecards(T)).map((c) => c.seriesId),
      ['other-series'],
    );
  });
});
