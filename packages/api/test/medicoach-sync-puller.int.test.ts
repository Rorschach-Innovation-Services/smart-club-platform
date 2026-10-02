/**
 * The medicoach sync puller (Task 2.1) end to end against a STUB medicoach: a real HTTP
 * server on localhost that verifies every request's signature with the contract helper
 * and answers with the shared contract examples. The puller runs for real against an
 * in-process dynalite table (real repo), and results are read back through the real
 * GET /series route.
 *
 * Covers: dry run with no secret, quiet run makes no writes, a result stored once (and the
 * onResultStored hook fired once), an older recordedAt ignored, a clear honoured only when
 * newer, unmapped refs counted without values, knockout slots filled, the full resync
 * idempotent, an HTTP failure leaves the cursor alone, and the admin "Sync now" route.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Series, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4663;
const TABLE = 'SmartClubMedicoachSyncPuller';
dynaliteEnv(DDB_PORT, TABLE);

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
const REP = devAuth('rep@test', [{ tenantId: 'dolphins', role: 'rep', clubIds: ['umzinto'] }]);
const headers = (auth: string) => ({
  'x-tenant': 'dolphins',
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let puller: typeof import('../src/medicoach-sync/puller.js');
let contract: typeof import('../src/medicoach-sync-contract.js');

// ── Stub medicoach ──
let stub: Server;
let stubUrl = '';
const requests: Array<{ pathAndQuery: string; verified: boolean }> = [];
/** Pages served in order; the last one repeats. */
let pages: unknown[] = [];
let failWith: number | null = null;

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
    if (failWith) {
      res.writeHead(failWith).end('{"error":"boom"}');
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

const quiet = (cursor: string) => ({
  version: 1,
  tenant: 'dolphins',
  nextCursor: cursor,
  hasMore: false,
  fixtures: [],
});

// ── Fixtures in smart club that the example refs point at ──
const series = (id: string, leagueKey: string, fixtures: unknown[], teams: string[] = []): Series =>
  ({
    id,
    name: `${leagueKey} · T20 · ${id}`,
    leagueKey,
    startDate: '2026-10-04',
    teams,
    participants: teams.map((t) => ({ teamId: t, clubId: t, name: t, venue: 'Kingsmead Oval' })),
    fixtures,
    kind: 'series',
    approved: true,
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  }) as unknown as Series;

const fx = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  round: 1,
  date: '2026-10-04',
  time: '09:00',
  home: 'umzinto',
  away: 'african-warriors',
  ...over,
});

async function seed(features: Record<string, boolean> = { medicoachSync: true }) {
  await repo.putTenantConfig({
    tenant: 'dolphins',
    branding: { name: 'D', title: 'D', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features,
  } as unknown as TenantConfig);
  await repo.putSeries(
    'dolphins',
    series(
      's-planb-premier-men-t20-g1',
      'premier',
      [fx('f1'), fx('f2'), fx('f3', { venueName: 'Kingsmead Oval' })],
      ['umzinto', 'african-warriors'],
    ),
  );
  await repo.putSeries(
    'dolphins',
    series('s-planb-premier-men-t20-g2', 'premier', [
      fx('f1', { home: 'a', away: 'b', venueName: 'Hammond Field' }),
    ]),
  );
  await repo.putSeries(
    'dolphins',
    series('s-planb-promotion-men-t20-g2', 'promotion', [
      fx('f7', { time: '13:30', home: 'c', away: 'd', venueName: 'Siripat 2' }),
    ]),
  );
  await repo.putSeries(
    'dolphins',
    series('s-planb-veterans-premier-t20-1', 'veterans-premier', [
      fx('f2', { home: 'v1', away: 'v2' }),
    ]),
  );
  await repo.putSeries(
    'dolphins',
    series(
      's-mc-ko-premier-t20',
      'premier',
      [
        {
          id: 'f1',
          round: 1,
          date: '2026-11-22',
          dateTbc: true,
          home: 'pos:s-planb-premier-men-t20-1:1',
          away: 'pos:s-planb-premier-men-t20-2:1',
          syncRef: 'smartclub:dolphins:fixture:recipe:premier:t20:sf1',
        },
      ],
      ['crusaders', 'harlequins', 'umzinto'],
    ),
  );
}

/** Repo with a write counter: every put/update/delete call is counted, then delegated. */
function countingRepo() {
  const writes: string[] = [];
  const wrapped = new Proxy(repo, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v === 'function' && /^(put|update|delete)/.test(String(prop)))
        return (...args: unknown[]) => {
          writes.push(String(prop));
          return (v as (...a: unknown[]) => unknown)(...args);
        };
      return v;
    },
  });
  return { repo: wrapped, writes };
}

const hookCalls: Array<{ fixtureId: string; first: boolean; source: string }> = [];
const run = (over: Partial<import('../src/medicoach-sync/puller.js').PullerDeps> = {}) =>
  puller.runMedicoachSync('dolphins', 'manual', {
    repo,
    url: stubUrl,
    secret: SECRET,
    log: () => {},
    onResultStored: async (e) => {
      hookCalls.push({
        fixtureId: `${e.seriesId}/${e.fixtureId}`,
        first: e.first,
        source: e.result.source,
      });
    },
    ...over,
  });

const getSeries = async (auth = ADMIN) => {
  const res = await app.request('/series', { headers: headers(auth) });
  assert.equal(res.status, 200);
  return (await res.json()) as Array<Series & { fixtures: Array<Record<string, unknown>> }>;
};
const fixtureOf = (all: Series[], seriesId: string, fixtureId: string) =>
  (all.find((s) => s.id === seriesId)?.fixtures as Array<Record<string, unknown>>).find(
    (f) => f.id === fixtureId,
  )!;

/** Wipe every item so each test starts from the seed. */
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
  requests.length = 0;
  hookCalls.length = 0;
  pages = [];
  failWith = null;
});

describe('medicoach sync puller', () => {
  test('dry run when the secret is empty: no HTTP request, no writes', async () => {
    const { repo: counted, writes } = countingRepo();
    const lines: string[] = [];
    const summary = await puller.runMedicoachSync('dolphins', 'cron', {
      repo: counted,
      url: stubUrl,
      secret: '',
      log: (l) => lines.push(l),
    });
    assert.equal(summary.status, 'dry-run');
    assert.equal(summary.wouldRequest, '/integrations/smartclub/changes?tenant=dolphins&limit=200');
    assert.equal(requests.length, 0);
    assert.deepEqual(writes, []);
    assert.match(
      lines.join('\n'),
      /would GET http:\/\/127\.0\.0\.1:\d+\/integrations\/smartclub\/changes/,
    );
    assert.match(lines.join('\n'), /MedicoachSyncSecret unset/);
  });

  test('a tenant without the feature is skipped untouched', async () => {
    await seed({});
    const summary = await run();
    assert.equal(summary.status, 'disabled');
    assert.equal(requests.length, 0);
  });

  test('quiet run (cursor unchanged, no fixtures): signed request, zero writes', async () => {
    await repo.putSyncCursor('dolphins', 'c-41');
    pages = [quiet('c-41')];
    const { repo: counted, writes } = countingRepo();
    const summary = await run({ repo: counted });
    assert.equal(summary.status, 'ok');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].verified, true);
    assert.equal(
      requests[0].pathAndQuery,
      '/integrations/smartclub/changes?tenant=dolphins&since=c-41&limit=200',
    );
    assert.deepEqual(writes, []);
    assert.deepEqual(await repo.listSyncLogs('dolphins'), []);
  });

  test('a live result is stored once, joined into GET /series as completed, hook fired once', async () => {
    pages = [example('changes-live-result')];
    const first = await run();
    assert.equal(first.counts.resultsStored, 1);
    assert.deepEqual(hookCalls, [
      { fixtureId: 's-planb-premier-men-t20-g1/f3', first: true, source: 'live' },
    ]);
    assert.equal(await repo.getSyncCursor('dolphins'), '2026-10-04T14:32:10.123Z');

    const all = await getSeries();
    const f3 = fixtureOf(all, 's-planb-premier-men-t20-g1', 'f3');
    assert.deepEqual(f3.result, {
      homeScore: '184/6 (20)',
      awayScore: '161/9 (20)',
      summary: 'Umzinto won by 23 runs',
      winner: 'home',
      method: 'normal',
      noResult: false,
      source: 'live',
      recordedAt: '2026-10-04T14:31:58.000Z',
      medicoachMatchUrl: 'https://live.medicoach.co.za/match/example',
    });
    assert.equal(f3.syncMapped, true);
    assert.equal(fixtureOf(all, 's-planb-premier-men-t20-g1', 'f1').result, undefined);
    // No player ref ever leaves the API, admin or rep.
    assert.doesNotMatch(JSON.stringify(all), /:player:/);
    assert.doesNotMatch(JSON.stringify(await getSeries(REP)), /:player:/);
    // …but it is kept on the stored item for Slice 2.3.
    const stored = await repo.getFixtureResult('dolphins', 's-planb-premier-men-t20-g1', 'f3');
    assert.match(String(stored?.captainRef), /^smartclub:dolphins:player:/);

    // The same page again (a replay) changes nothing and never re-fires the hook.
    pages = [example('changes-live-result')];
    const again = await run();
    assert.equal(again.counts.resultsStored, 0);
    assert.equal(again.counts.resultsStale, 1);
    assert.equal(hookCalls.length, 1);
  });

  test('an older recordedAt is ignored', async () => {
    pages = [example('changes-live-result')];
    await run();
    const older = example('changes-live-result');
    older.nextCursor = '2026-10-04T15:00:00.000Z';
    older.fixtures[0].result.recordedAt = '2026-10-04T12:00:00.000Z';
    older.fixtures[0].result.homeScore = '99/9 (20)';
    pages = [older];
    const summary = await run();
    assert.equal(summary.counts.resultsStale, 1);
    const f3 = fixtureOf(await getSeries(), 's-planb-premier-men-t20-g1', 'f3');
    assert.equal((f3.result as { homeScore: string }).homeScore, '184/6 (20)');
    assert.equal(hookCalls.length, 1);
  });

  test('a clear is honoured only when newer than the stored result; hasMore pages are followed', async () => {
    // g2:f1 already has a result recorded BEFORE the clear (07:00 < 07:58) → cleared.
    await repo.putFixtureResultIfNewer('dolphins', {
      seriesId: 's-planb-premier-men-t20-g2',
      fixtureId: 'f1',
      ref: 'smartclub:dolphins:fixture:s-planb-premier-men-t20-g2:f1',
      orderAt: '2026-10-05T07:00:00.000Z',
      recordedAt: '2026-10-05T07:00:00.000Z',
      homeScore: '1',
      awayScore: '2',
      storedAt: '2026-10-05T07:00:01.000Z',
    });
    pages = [example('changes-manual-and-cleared'), quiet('2026-10-05T08:00:00.000Z')];
    const summary = await run();
    assert.equal(summary.pages, 2, 'followed hasMore to the next page');
    assert.equal(
      requests[1].pathAndQuery,
      '/integrations/smartclub/changes?tenant=dolphins&since=2026-10-05T08%3A00%3A00.000Z&limit=200',
    );
    assert.equal(summary.counts.resultsCleared, 1);
    assert.equal(summary.counts.resultsStored, 1, 'the manual result on promotion g2:f7');
    const all = await getSeries();
    assert.equal(fixtureOf(all, 's-planb-premier-men-t20-g2', 'f1').result, undefined);
    assert.equal(
      (fixtureOf(all, 's-planb-promotion-men-t20-g2', 'f7').result as { source: string }).source,
      'manual',
    );

    // A result recorded AFTER the clear instant survives a (late) clear.
    await repo.putFixtureResultIfNewer('dolphins', {
      seriesId: 's-planb-premier-men-t20-g2',
      fixtureId: 'f1',
      ref: 'smartclub:dolphins:fixture:s-planb-premier-men-t20-g2:f1',
      orderAt: '2026-10-05T09:00:00.000Z',
      recordedAt: '2026-10-05T09:00:00.000Z',
      homeScore: '150',
      awayScore: '120',
      storedAt: '2026-10-05T09:00:01.000Z',
    });
    pages = [{ ...example('changes-manual-and-cleared'), hasMore: false }];
    const late = await run();
    assert.equal(late.counts.resultsCleared, 0);
    const kept = fixtureOf(await getSeries(), 's-planb-premier-men-t20-g2', 'f1');
    assert.equal((kept.result as { homeScore: string }).homeScore, '150');
  });

  test('unmapped refs are counted and logged without their values', async () => {
    const page = example('changes-live-result');
    page.fixtures[0].ref = 'smartclub:dolphins:fixture:s-planb-gone:f9';
    pages = [page];
    const summary = await run();
    assert.equal(summary.counts.unmapped, 1);
    assert.equal(summary.counts.resultsStored, 0);
    const [row] = await repo.listSyncLogs('dolphins');
    assert.equal(row.counts.unmapped, 1);
    assert.equal(row.outcome, 'ok');
    const raw = JSON.stringify(row);
    assert.doesNotMatch(raw, /s-planb-gone/);
    assert.doesNotMatch(raw, /:player:/);
  });

  test('knockout teams fill the slot fixture; schedule differences are only recorded', async () => {
    pages = [example('changes-knockout-reschedule')];
    const summary = await run();
    assert.equal(summary.counts.slotsFilled, 2);
    assert.equal(summary.counts.scheduleDiffers, 2);
    const ko = (await repo.getSeries('dolphins', 's-mc-ko-premier-t20'))!;
    const f1 = (ko.fixtures as Array<Record<string, unknown>>)[0];
    assert.equal(f1.home, 'crusaders');
    assert.equal(f1.away, 'harlequins');
    assert.deepEqual(f1.slots, {
      home: 'pos:s-planb-premier-men-t20-1:1',
      away: 'pos:s-planb-premier-men-t20-2:1',
    });
    assert.equal(ko.version, 2, 'one version-checked write');
    // The schedule itself is untouched (Slice 3 applies schedule changes).
    assert.equal(f1.date, '2026-11-22');
    assert.equal(f1.dateTbc, true);
    const vets = (await repo.getSeries('dolphins', 's-planb-veterans-premier-t20-1'))!;
    assert.equal((vets.fixtures as Array<Record<string, unknown>>)[0].status, undefined);
    const [row] = await repo.listSyncLogs('dolphins');
    assert.deepEqual(row.scheduleDiffersRefs?.sort(), [
      'smartclub:dolphins:fixture:recipe:premier:t20:sf1',
      'smartclub:dolphins:fixture:s-planb-veterans-premier-t20-1:f2',
    ]);
  });

  test('a team ref outside the series is never written into a slot', async () => {
    const page = example('changes-knockout-reschedule');
    page.fixtures[0].teams.homeRef = 'smartclub:dolphins:team:promotion:crusaders'; // wrong league
    page.fixtures[0].teams.awayRef = 'smartclub:dolphins:team:premier:not-in-series';
    pages = [page];
    const summary = await run();
    assert.equal(summary.counts.slotsFilled, 0);
    const ko = (await repo.getSeries('dolphins', 's-mc-ko-premier-t20'))!;
    assert.equal(
      (ko.fixtures as Array<Record<string, unknown>>)[0].home,
      'pos:s-planb-premier-men-t20-1:1',
    );
  });

  test('a full resync (no cursor) after everything changes nothing', async () => {
    const everything = {
      version: 1,
      tenant: 'dolphins',
      nextCursor: 'c-all',
      hasMore: false,
      fixtures: [
        ...example('changes-live-result').fixtures,
        ...example('changes-manual-and-cleared').fixtures,
        ...example('changes-knockout-reschedule').fixtures,
      ],
    };
    pages = [everything];
    await run();
    const snapshot = async () => ({
      results: (await repo.listFixtureResults('dolphins')).map(({ storedAt: _s, ...r }) => r),
      versions: (await repo.listSeries('dolphins')).map((s) => `${s.id}@${s.version}`).sort(),
    });
    const before = await snapshot();
    const hooksBefore = hookCalls.length;

    await repo.putSyncCursor('dolphins', '0'); // "since=0": a full resync
    pages = [everything];
    const { repo: counted, writes } = countingRepo();
    const summary = await run({ repo: counted });
    assert.equal(
      requests.at(-1)!.pathAndQuery,
      '/integrations/smartclub/changes?tenant=dolphins&limit=200',
    );
    assert.equal(
      summary.counts.resultsStored + summary.counts.resultsCleared + summary.counts.slotsFilled,
      0,
    );
    assert.deepEqual(await snapshot(), before);
    assert.equal(hookCalls.length, hooksBefore);
    // Only the cursor (it moved from '0') and the schedule-differs audit row are written.
    assert.deepEqual(writes.sort(), [
      'putFixtureResultIfNewer',
      'putFixtureResultIfNewer',
      'putFixtureResultIfNewer',
      'putSyncCursor',
      'putSyncLog',
    ]);
  });

  test('medicoach failing leaves the cursor alone and records an error row', async () => {
    await repo.putSyncCursor('dolphins', 'c-7');
    failWith = 503;
    await assert.rejects(
      run(),
      (err: Error) => err.name === 'MedicoachSyncError' && /HTTP 503/.test(err.message),
    );
    assert.equal(await repo.getSyncCursor('dolphins'), 'c-7');
    const [row] = await repo.listSyncLogs('dolphins');
    assert.equal(row.outcome, 'error');
    assert.equal(row.error, 'medicoach answered HTTP 503');
  });

  test('a response outside the contract is rejected without echoing values', async () => {
    const page = example('changes-live-result');
    page.fixtures[0].result.recordedAt = 'yesterday';
    pages = [page];
    await assert.rejects(run(), /failed the v1 contract at fixtures\.0\.result\.recordedAt/);
    assert.deepEqual(await repo.listFixtureResults('dolphins'), []);
  });
});

describe('POST /integrations/medicoach/sync-now', () => {
  const syncNow = (auth: string) =>
    app.request('/integrations/medicoach/sync-now', { method: 'POST', headers: headers(auth) });

  test('admin: runs the puller for the caller tenant (dry run here: no secrets in env)', async () => {
    const res = await syncNow(ADMIN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; tenant: string; trigger: string };
    assert.deepEqual([body.status, body.tenant, body.trigger], ['dry-run', 'dolphins', 'manual']);
    assert.equal(requests.length, 0);
  });

  test('rep: forbidden', async () => {
    const res = await syncNow(REP);
    assert.equal(res.status, 403);
  });

  test('tenant without the sync: 409', async () => {
    await seed({});
    const res = await syncNow(ADMIN);
    assert.equal(res.status, 409);
  });
});

describe('response-only fixture keys never persist', () => {
  test('a whole-series PATCH echoing result/syncMapped stores neither', async () => {
    pages = [example('changes-live-result')];
    await run();
    const all = await getSeries();
    const s = all.find((x) => x.id === 's-planb-premier-men-t20-g1')!;
    const res = await app.request(`/series/${s.id}`, {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ fixtures: s.fixtures, version: s.version }),
    });
    assert.equal(res.status, 200);
    const stored = (await repo.getSeries('dolphins', s.id))!;
    for (const f of stored.fixtures as Array<Record<string, unknown>>) {
      assert.equal('result' in f, false);
      assert.equal('syncMapped' in f, false);
    }
  });
});
