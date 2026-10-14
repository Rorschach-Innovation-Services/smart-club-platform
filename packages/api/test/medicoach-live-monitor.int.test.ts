/**
 * Match monitor (Medicoach sync): GET /integrations/medicoach/live joins one SAST day's
 * fixtures (released series only) to medicoach's live-scoring state, end to end against a
 * STUB medicoach and the REAL Hono app on in-process dynalite:
 *
 * - the request is signed and names the tenant and day; the stub refuses an unsigned one;
 * - each fixture carries its live match (or null), names resolved from the series/clubs;
 * - drafts and other days are left out; live matches for unknown refs are only counted;
 * - medicoach failing (HTTP error, off-contract body) still answers with the fixtures and a
 *   plain-language reason; with the sync unconfigured it is a dry run;
 * - admin only, feature-gated, and a bad date is a 400.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Series, TenantConfig } from '../src/types.js';
import type { MatchMonitorResponse } from '../src/medicoach-sync/live.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4691; // next free odd port after medicoach-sync-ux (4689)
const TABLE = 'SmartClubMedicoachLive';
dynaliteEnv(DDB_PORT, TABLE);

const T = 'dolphins';
const SECRET = 'stub-live-secret';
const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
const ADMIN = devAuth('admin@test', [{ tenantId: T, role: 'admin', clubIds: [] }]);
const REP = devAuth('rep@test', [{ tenantId: T, role: 'rep', clubIds: ['a'] }]);
const headers = (auth = ADMIN) => ({ 'x-tenant': T, 'x-dev-auth': auth });

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let contract: typeof import('../src/medicoach-sync-contract.js');
let live: typeof import('../src/medicoach-sync/live.js');

// ── Stub medicoach ──
let stub: Server;
let stubUrl = '';
let body: unknown = null;
let httpFail: number | null = null;
const seen: string[] = [];

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
    if (!check.ok) return void res.writeHead(401).end('{}');
    seen.push(req.url ?? '');
    if (httpFail) return void res.writeHead(httpFail).end('{}');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  return new Promise((resolve) =>
    stub.listen(0, '127.0.0.1', () => {
      stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

const DAY = '2026-10-04';
const REF = (s: string, f: string) => `smartclub:${T}:fixture:${s}:${f}`;

const series = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    name: `Series ${id}`,
    leagueKey: 'premier',
    startDate: DAY,
    teams: ['a', 'b', 'c', 'd'],
    participants: [
      { teamId: 'a', clubId: 'a', name: 'Crusaders', venue: 'Kingsmead Oval' },
      { teamId: 'b', clubId: 'b', name: 'Umzinto' },
    ],
    fixtures: [
      { id: 'f1', date: DAY, time: '09:00', home: 'a', away: 'b' },
      { id: 'f2', date: DAY, time: '13:30', home: 'c', away: 'd', venueOverride: 'Lahee Park' },
      { id: 'f3', date: '2026-10-05', time: '09:00', home: 'a', away: 'c' },
      { id: 'f4', date: DAY, home: 'b', away: 'd', status: 'postponed' },
    ],
    kind: 'series',
    released: true,
    version: 1,
    ...over,
  }) as unknown as Series;

const liveMatch = (ref: string, over: Record<string, unknown> = {}) => ({
  ref,
  status: 'in_progress',
  startedAt: '2026-10-04T07:21:40.000Z',
  endedAt: null,
  lastInputAt: '2026-10-04T08:41:12.000Z',
  oversPerSide: 20,
  innings: [
    {
      number: 1,
      battingSide: 'home',
      runs: 84,
      wickets: 3,
      overs: '12.4',
      startedAt: '2026-10-04T07:21:40.000Z',
      endedAt: null,
    },
  ],
  deliveries: 80,
  medianGapSec: 36,
  longGaps: [
    { innings: 1, over: '9.1', at: '2026-10-04T08:20:00.000Z', gapSec: 300, reason: null },
  ],
  undoCount: 3,
  players: [],
  medicoachMatchUrl: 'https://live.medicoach.co.za/match/x',
  ...over,
});

const get = (q: string, auth = ADMIN) =>
  app.request(`/integrations/medicoach/live${q}`, { headers: headers(auth) });

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  ({ app } = await import('../src/index.js'));
  repo = await import('../src/repo.js');
  contract = await import('../src/medicoach-sync-contract.js');
  live = await import('../src/medicoach-sync/live.js');
  await startStub();
  await repo.putTenantConfig({
    tenant: T,
    branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: { medicoachSync: true },
  } as unknown as TenantConfig);
  for (const [id, name] of [
    ['a', 'Crusaders CC'],
    ['b', 'Umzinto CC'],
    ['c', 'Harlequins CC'],
    ['d', 'Pirates CC'],
  ])
    await repo.createClub(T, {
      id,
      name,
      district: 'D',
      sub: `sub-${id}`,
      chair: 'Chair',
      affiliation: 'not_started',
      cqi: 0,
      docs: {},
      players: 0,
      teams: 0,
      women: 0,
      juniors: 0,
      color: '#123456',
      ground: {},
      leagues: [],
      version: 1,
    } as never);
  const reg = (
    clubId: string,
    naturalKey: string,
    firstName: string,
    lastName: string,
    status?: string,
  ) =>
    repo.createPlayer(T, {
      naturalKey,
      clubId,
      firstName,
      lastName,
      dob: '1995-01-01',
      isMinor: false,
      consentAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      ...(status ? { status } : {}),
    } as never);
  await reg('a', 'nk-a1', 'Ann', 'Active');
  await reg('a', 'nk-a2', 'Ian', 'Inactive', 'inactive');
  await reg('c', 'nk-c1', 'Carl', 'Elsewhere');
  await reg('b', 'nk-b1', 'Bea', 'Bee');
  await repo.putSeries(T, series('s1'));
  await repo.putSeries(T, series('s-draft', { released: false }));
});

after(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
  await stopDynalite(ddb);
});

beforeEach(() => {
  live.resetLiveCaches();
  process.env.MEDICOACH_SYNC_URL = stubUrl;
  process.env.MEDICOACH_SYNC_SECRET = SECRET;
  httpFail = null;
  seen.length = 0;
  body = {
    version: 1,
    tenant: T,
    date: DAY,
    generatedAt: '2026-10-04T08:42:00.000Z',
    matches: [liveMatch(REF('s1', 'f1')), liveMatch(REF('s-elsewhere', 'f9'))],
  };
});

describe('match monitor', () => {
  test("joins the day's released fixtures to their signed-for live state", async () => {
    const res = await get(`?date=${DAY}`);
    assert.equal(res.status, 200);
    const r = (await res.json()) as MatchMonitorResponse;
    assert.deepEqual(seen, [`/integrations/smartclub/live?tenant=${T}&date=${DAY}`]);
    assert.equal(r.reachable, true);
    assert.equal(r.dryRun, false);
    // Other days and the draft series are left out; the postponed fixture stays (as such).
    assert.deepEqual(
      r.matches.map((m) => [m.fixtureId, m.home, m.away, m.venue, m.time, m.fixtureStatus]),
      [
        ['f1', 'Crusaders', 'Umzinto', 'Kingsmead Oval', '09:00', 'scheduled'],
        ['f2', 'Harlequins CC', 'Pirates CC', 'Lahee Park', '13:30', 'scheduled'],
        ['f4', 'Umzinto', 'Pirates CC', undefined, undefined, 'postponed'],
      ],
    );
    const f1 = r.matches[0].live!;
    assert.equal(f1.innings[0].overs, '12.4');
    assert.equal(f1.longGaps[0].gapSec, 300);
    assert.equal(r.matches[1].live, null);
    assert.equal(r.unmatched, 1);
  });

  test('checks every player against the rosters and never sends a player ref to the page', async () => {
    const P = (key: string) => `smartclub:${T}:player:${key}`;
    body = {
      version: 1,
      tenant: T,
      date: DAY,
      generatedAt: '2026-10-04T08:42:00.000Z',
      matches: [
        liveMatch(REF('s1', 'f1'), {
          undoCount: 7,
          players: [
            {
              side: 'home',
              name: 'Ann Active',
              ref: P('nk-a1'),
              addedDuringMatch: false,
              addedAt: null,
            },
            {
              side: 'home',
              name: 'Carl Elsewhere',
              ref: P('nk-c1'),
              addedDuringMatch: false,
              addedAt: null,
            },
            {
              side: 'home',
              name: 'Ian Inactive',
              ref: P('nk-a2'),
              addedDuringMatch: false,
              addedAt: null,
            },
            { side: 'away', name: 'BEA  bee', ref: null, addedDuringMatch: false, addedAt: null },
            {
              side: 'away',
              name: 'Nobody Known',
              ref: null,
              addedDuringMatch: true,
              addedAt: '2026-10-04T08:10:00.000Z',
            },
            {
              side: 'away',
              name: 'Ghost Ref',
              ref: P('nk-none'),
              addedDuringMatch: false,
              addedAt: null,
            },
          ],
        }),
      ],
    };
    const res = await get(`?date=${DAY}`);
    const raw = await res.text();
    assert.doesNotMatch(raw, /:player:/, 'no player ref reaches the page');
    const r = JSON.parse(raw) as MatchMonitorResponse;
    const live = r.matches[0].live!;
    assert.equal(live.undoCount, 7);
    assert.deepEqual(
      live.players.map((p) => [p.name, p.check, p.otherClub ?? null, p.addedDuringMatch]),
      [
        ['Ann Active', 'registered', null, false],
        ['Carl Elsewhere', 'other-club', 'Harlequins CC', false],
        ['Ian Inactive', 'not-active', null, false],
        ['BEA  bee', 'name-match', null, false],
        ['Nobody Known', 'unregistered', null, true],
        ['Ghost Ref', 'unregistered', null, false],
      ],
    );
  });

  test('medicoach failing still lists the fixtures, with the reason in plain language', async () => {
    httpFail = 401;
    let r = (await (await get(`?date=${DAY}`)).json()) as MatchMonitorResponse;
    assert.equal(r.reachable, false);
    assert.equal(r.matches.length, 3);
    assert.ok(r.matches.every((m) => m.live === null));
    assert.match(r.error!, /credentials/);
    assert.doesNotMatch(r.error!, /15 minutes/);

    httpFail = null;
    body = { version: 1, tenant: T, date: DAY, generatedAt: 'yesterday', matches: [] };
    r = (await (await get(`?date=${DAY}`)).json()) as MatchMonitorResponse;
    assert.equal(r.reachable, false);
    assert.match(r.technical!, /contract at generatedAt/);
  });

  test('one malformed match is dropped and counted; the rest of the day still shows', async () => {
    body = {
      version: 1,
      tenant: T,
      date: DAY,
      generatedAt: '2026-10-04T08:42:00.000Z',
      matches: [liveMatch(REF('s1', 'f1')), liveMatch(REF('s1', 'f2'), { deliveries: -1 })],
    };
    const r = (await (await get(`?date=${DAY}`)).json()) as MatchMonitorResponse;
    assert.equal(r.reachable, true);
    assert.equal(r.parseFailures, 1);
    assert.ok(r.matches.find((m) => m.fixtureId === 'f1')!.live);
    assert.equal(r.matches.find((m) => m.fixtureId === 'f2')!.live, null);
  });

  test('a repeat poll within the cache window reuses the answer', async () => {
    await get(`?date=${DAY}`);
    const r = (await (await get(`?date=${DAY}`)).json()) as MatchMonitorResponse;
    assert.equal(seen.length, 1);
    assert.equal(r.reachable, true);
    live.resetLiveCaches();
    await get(`?date=${DAY}`);
    assert.equal(seen.length, 2);
  });

  /** One live f1 for `tenant` (a slug no route test uses, so the roster cache can't leak). */
  const dayFor = (tenant: string, players: unknown[]) => [
    {
      ref: `smartclub:${tenant}:fixture:s1:f1`,
      seriesId: 's1',
      seriesName: 'S',
      fixtureId: 'f1',
      home: 'Crusaders',
      away: 'Umzinto',
      homeClubId: 'a',
      awayClubId: 'b',
      date: DAY,
      fixtureStatus: 'scheduled' as const,
      live: contract.LiveMatchSchema.parse(
        liveMatch(`smartclub:${tenant}:fixture:s1:f1`, { players }),
      ),
    },
  ];
  const CLUBS = [
    { id: 'a', name: 'Crusaders CC' },
    { id: 'b', name: 'Umzinto CC' },
    { id: 'c', name: 'Harlequins CC' },
  ];
  const ghost = (tenant: string) => ({
    side: 'home',
    name: 'Ghost',
    ref: `smartclub:${tenant}:player:nk-none`,
    addedDuringMatch: false,
    addedAt: null,
  });

  test('rosters are read once per cache window, even for an unregistered ref', async () => {
    const TT = 'roster-window';
    const reads: string[] = [];
    let clock = Date.parse('2026-10-04T08:00:00.000Z');
    const deps = {
      clubs: CLUBS,
      now: () => new Date(clock),
      listPlayers: async (_t: string, clubId: string) => {
        reads.push(clubId);
        return [];
      },
    };
    const day = dayFor(TT, [ghost(TT)]);
    await live.checkPlayers(TT, day, deps);
    assert.deepEqual(reads.sort(), ['a', 'b', 'c']);
    clock += live.ROSTER_TTL_MS - 1;
    await live.checkPlayers(TT, day, deps);
    assert.equal(reads.length, 3);
    // Past the window (on the injected clock, no sleeping) every roster is read again.
    clock += 1;
    await live.checkPlayers(TT, day, deps);
    assert.equal(reads.length, 6);
  });

  test('a failed roster read is not cached: the next call retries it', async () => {
    const TT = 'roster-evict';
    const reads: string[] = [];
    let fail = true;
    const deps = {
      clubs: CLUBS,
      listPlayers: async (_t: string, clubId: string) => {
        reads.push(clubId);
        if (fail) throw new Error('dynamo unavailable');
        return [];
      },
    };
    const day = dayFor(TT, [
      { side: 'away', name: 'Nobody', ref: null, addedDuringMatch: false, addedAt: null },
    ]);
    const first = await live.checkPlayers(TT, day, deps);
    assert.equal(first[0].live!.players[0].check, 'unchecked');
    assert.deepEqual(reads, ['b']);
    fail = false;
    const second = await live.checkPlayers(TT, day, deps);
    assert.deepEqual(reads, ['b', 'b'], 'the rejected read was evicted, not re-awaited');
    assert.equal(second[0].live!.players[0].check, 'unregistered');
  });

  test('a failed roster read degrades its players to unchecked; the day still answers', async () => {
    const P = (key: string) => `smartclub:${T}:player:${key}`;
    body = {
      version: 1,
      tenant: T,
      date: DAY,
      generatedAt: '2026-10-04T08:42:00.000Z',
      matches: [
        liveMatch(REF('s1', 'f1'), {
          players: [
            {
              side: 'home',
              name: 'Ann Active',
              ref: P('nk-a1'),
              addedDuringMatch: false,
              addedAt: null,
            },
            {
              side: 'away',
              name: 'Bea Bee',
              ref: P('nk-b1'),
              addedDuringMatch: false,
              addedAt: null,
            },
          ],
        }),
      ],
    };
    const r = await live.buildMatchMonitor(
      T,
      DAY,
      { series: [series('s1')], clubs: CLUBS.concat({ id: 'd', name: 'Pirates CC' }) },
      {
        url: stubUrl,
        secret: SECRET,
        listPlayers: async (t, clubId) => {
          if (clubId === 'a') throw new Error('dynamo unavailable');
          return repo.listPlayers(t, clubId);
        },
      },
    );
    assert.equal(r.reachable, true);
    assert.equal(r.matches.length, 3);
    assert.deepEqual(
      r.matches[0].live!.players.map((p) => [p.name, p.check]),
      [
        ['Ann Active', 'unchecked'],
        ['Bea Bee', 'registered'],
      ],
    );
  });

  test('an unreachable or dry-run answer is never cached; the next poll asks again', async () => {
    httpFail = 500;
    let r = (await (await get(`?date=${DAY}`)).json()) as MatchMonitorResponse;
    assert.equal(r.reachable, false);
    httpFail = null;
    r = (await (await get(`?date=${DAY}`)).json()) as MatchMonitorResponse;
    assert.equal(seen.length, 2, 'the failure was not reused within the cache window');
    assert.equal(r.reachable, true);

    live.resetLiveCaches();
    seen.length = 0;
    process.env.MEDICOACH_SYNC_SECRET = '';
    r = (await (await get(`?date=${DAY}`)).json()) as MatchMonitorResponse;
    assert.equal(r.dryRun, true);
    process.env.MEDICOACH_SYNC_SECRET = SECRET;
    r = (await (await get(`?date=${DAY}`)).json()) as MatchMonitorResponse;
    assert.equal(r.dryRun, false);
    assert.equal(r.reachable, true);
    assert.equal(seen.length, 1);
  });

  test('an answer for a different day is refused like an unreachable one, and not cached', async () => {
    body = { ...(body as object), date: '2026-10-05' };
    let r = (await (await get(`?date=${DAY}`)).json()) as MatchMonitorResponse;
    assert.equal(r.reachable, false);
    assert.match(r.technical!, /different date/);
    assert.ok(r.matches.every((m) => m.live === null));
    body = { ...(body as object), date: DAY };
    r = (await (await get(`?date=${DAY}`)).json()) as MatchMonitorResponse;
    assert.equal(r.reachable, true);
    assert.equal(seen.length, 2);
  });

  test('each real fetch stamps the live facet of SYNCHEALTH#: ok, failing since, links', async () => {
    const health = () => repo.getSyncHealth(T);
    const poll = async () => {
      live.resetLiveCaches();
      return (await (await get(`?date=${DAY}`)).json()) as MatchMonitorResponse;
    };
    // A good answer whose live match has a link: reachable, links configured.
    let r = await poll();
    assert.equal(r.reachable, true);
    let h = (await health())!;
    assert.equal(h.liveLastOkAt, r.generatedAt);
    assert.equal(h.liveLinksUnconfigured, false);
    assert.equal(h.liveLinksCheckedAt, r.generatedAt);

    // A live match without a link flags the links as unconfigured.
    body = {
      ...(body as object),
      matches: [liveMatch(REF('s1', 'f1'), { medicoachMatchUrl: null })],
    };
    r = await poll();
    h = (await health())!;
    assert.equal(h.liveLastOkAt, r.generatedAt);
    assert.equal(h.liveLinksUnconfigured, true);
    assert.equal(h.liveLinksCheckedAt, r.generatedAt);
    const flaggedAt = r.generatedAt;

    // A day with no live match (not started) leaves the links signal and its time as they were.
    body = {
      ...(body as object),
      matches: [liveMatch(REF('s1', 'f1'), { status: 'not_started', medicoachMatchUrl: null })],
    };
    await poll();
    h = (await health())!;
    assert.equal(h.liveLinksUnconfigured, true);
    assert.equal(h.liveLinksCheckedAt, flaggedAt);

    // Links restored: a live match with a link clears the flag as today's observation.
    body = { ...(body as object), matches: [liveMatch(REF('s1', 'f1'))] };
    r = await poll();
    h = (await health())!;
    assert.equal(h.liveLinksUnconfigured, false);
    assert.equal(h.liveLinksCheckedAt, r.generatedAt);

    // Failures: failingSince is the FIRST failure of the run; lastError is technical text.
    httpFail = 502;
    const first = await poll();
    assert.equal(first.reachable, false);
    await new Promise((res) => setTimeout(res, 5));
    const second = await poll();
    h = (await health())!;
    assert.equal(h.liveLastErrorAt, second.generatedAt);
    assert.equal(h.liveFailingSince, first.generatedAt);
    assert.equal(h.liveLastError, 'medicoach answered HTTP 502');
    // The sync's own facet is never touched by the monitor.
    assert.equal(h.lastErrorAt, undefined);

    // Recovery, then a new failure starts a new run.
    httpFail = null;
    await poll();
    await new Promise((res) => setTimeout(res, 5));
    httpFail = 502;
    const again = await poll();
    assert.equal((await health())!.liveFailingSince, again.generatedAt);
  });

  test('a dry run records nothing in the live facet', async () => {
    const before = await repo.getSyncHealth(T);
    process.env.MEDICOACH_SYNC_SECRET = '';
    await get(`?date=${DAY}`);
    assert.deepEqual(await repo.getSyncHealth(T), before);
  });

  test('with the sync unconfigured it is a dry run with no request made', async () => {
    process.env.MEDICOACH_SYNC_SECRET = '';
    const r = (await (await get(`?date=${DAY}`)).json()) as MatchMonitorResponse;
    assert.equal(r.dryRun, true);
    assert.equal(seen.length, 0);
    assert.equal(r.matches.length, 3);
  });

  test('admin only, feature-gated, and the date is validated', async () => {
    assert.equal((await get(`?date=${DAY}`, REP)).status, 403);
    assert.equal((await get('?date=04/10/2026')).status, 400);
    assert.equal((await get('?date=2026-02-31x')).status, 400);
    const cfg = await repo.getTenantConfig(T);
    await repo.putTenantConfig({ ...cfg!, features: {} } as TenantConfig);
    try {
      assert.equal((await get(`?date=${DAY}`)).status, 409);
    } finally {
      await repo.putTenantConfig(cfg!);
    }
  });
});
