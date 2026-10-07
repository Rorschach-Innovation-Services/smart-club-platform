/**
 * Medicoach PLAYER sync (ADR 0018) end to end: a STUB medicoach on a free localhost port
 * answers `POST /integrations/smartclub/players` (verifying every signature with the contract
 * helper) while the REAL repo hooks, outbox, flush and Hono app run against an in-process
 * dynalite table.
 *
 *  - repo write hooks: nothing while the flag is off; one collapsed row per person; an older
 *    change never rewinds a newer one;
 *  - flush: the rebuilt desired state goes out signed; success / stale delete the row, but a
 *    change landing mid-flight survives; unmapped-team parks (and a parked row is not resent
 *    until retried); error / HTTP failure count attempts; needs-review becomes a review;
 *  - duplicate prevention: the same name + dob under two IDs holds BOTH; "distinct" pushes
 *    both and the pair is never flagged again;
 *  - erasure: club cleanup of a veterans club is a plain change (upsert with fewer teams),
 *    never an erase; POPIA erasure writes an erase tombstone and drops the person's review; a
 *    re-registration replaces the tombstone but the erase still goes out first; tenant
 *    erasure removes the outbox;
 *  - admin routes (status, reviews, resolve, retry), Sync now, the drain cap, the operator
 *    flag + coverage warnings, and the chair form's soft duplicate warning.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Club, PlayerRegistration, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4699;
const TABLE = 'SmartClubMedicoachPlayerSync';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const T = 'dolphins';
const SECRET = 'stub-shared-secret';
const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: email, email, memberships })).toString('base64');
const ADMIN = devAuth('admin@test', [{ tenantId: T, role: 'admin', clubIds: [] }]);
const REP_SOLO = devAuth('chair@solo.test', [{ tenantId: T, role: 'rep', clubIds: ['solo'] }]);
const OPERATOR = devAuth('operator@platform', [{ tenantId: '*', role: 'operator', clubIds: [] }]);
const headers = (auth = ADMIN) => ({
  'x-tenant': T,
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let players: typeof import('../src/medicoach-sync/players.js');
let contract: typeof import('../src/medicoach-sync-contract.js');

// ── Stub medicoach ──
interface Entry {
  ref: string;
  op: string;
  changedAt: string;
  teamRefs?: string[];
  firstName?: string;
  resolution?: unknown;
  [k: string]: unknown;
}
let stub: Server;
let stubUrl = '';
const pushes: Array<{ verified: boolean; players: Entry[] }> = [];
type Answer = { status: string; [k: string]: unknown };
let answer: (e: Entry) => Answer = () => ({ status: 'created' });
let httpFail: number | null = null;
/** Runs while a push is "in flight" (before the stub answers). */
let duringPush: (() => Promise<void>) | null = null;

function startStub(): Promise<void> {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const check = contract.verifySignature({
        secret: SECRET,
        method: req.method ?? 'GET',
        pathAndQuery: req.url ?? '',
        body: raw,
        timestampHeader: req.headers['x-sync-timestamp'] as string | undefined,
        signatureHeader: req.headers['x-sync-signature'] as string | undefined,
      });
      if (!check.ok) return void res.writeHead(401).end('{}');
      if (req.method === 'GET') {
        const page = { version: 1, tenant: T, nextCursor: '0', hasMore: false, fixtures: [] };
        return void res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(page));
      }
      const body = JSON.parse(raw) as { players?: Entry[]; changes?: unknown[] };
      if (req.url === contract.PLAYERS_PATH) {
        assert.ok(contract.PlayerPushRequestSchema.safeParse(body).success, 'request contract');
        pushes.push({ verified: check.ok, players: body.players! });
        if (duringPush) await duringPush();
        if (httpFail) return void res.writeHead(httpFail).end('{"error":"down"}');
        const results = body.players!.map((e) => ({ ref: e.ref, ...answer(e) }));
        return void res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ version: 1, results }));
      }
      return void res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ version: 1, results: [] }));
    });
  });
  return new Promise((resolve) =>
    stub.listen(0, '127.0.0.1', () => {
      stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

// ── Seed ──
const LEAGUES = [
  { key: 'premier', label: 'Premier', group: 'Senior', district: 'Test District' },
  {
    key: 'veterans-premier',
    label: 'Veterans Premier',
    group: 'Veterans',
    district: 'Test District',
  },
];
const config = (playerSync: boolean, extra: Partial<TenantConfig> = {}): TenantConfig =>
  ({
    tenant: T,
    branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    leagues: LEAGUES,
    features: { medicoachSync: true },
    integrations: { medicoach: { playerSync } },
    ...extra,
  }) as unknown as TenantConfig;

const mkClub = (id: string, name: string, leagues: string[]): Club =>
  ({
    id,
    name,
    district: 'Test District',
    sub: '',
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
    leagues,
    version: 1,
  }) as unknown as Club;

let seq = 0;
const mkPlayer = (over: Partial<PlayerRegistration> = {}): PlayerRegistration => {
  seq++;
  return {
    naturalKey: `nk-${String(seq).padStart(3, '0')}`,
    clubId: 'solo',
    firstName: 'Sipho',
    lastName: `Player${seq}`,
    dob: '1990-01-01',
    isMinor: false,
    status: 'active',
    team: 'premier',
    consentAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
    idType: 'sa-id',
    idNumber: `9001015${String(100000 + seq).slice(-6)}`,
    cell: '0821234567',
    registeredVia: 'portal',
    ...over,
  };
};

const ref = (nk: string) => `smartclub:${T}:player:${nk}`;
const team = (league: string, id: string) => `smartclub:${T}:team:${league}:${id}`;
const flush = (over: Partial<Parameters<typeof players.flushPlayerOutbox>[2]> = {}) =>
  players.flushPlayerOutbox(T, 'manual', { repo, url: stubUrl, secret: SECRET, ...over });
const rowOf = (nk: string) => repo.getPendingPlayerSync(T, nk);
const call = (method: string, url: string, body?: unknown, auth = ADMIN) =>
  app.request(url, {
    method,
    headers: headers(auth),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const later = (ms = 1000) => new Date(Date.now() + ms).toISOString();

async function clearPlayerSync(): Promise<void> {
  for (const r of await repo.listPendingPlayerSync(T))
    await repo.deletePendingPlayerSync(T, r.naturalKey);
  for (const r of await repo.listPlayerReviews(T)) await repo.deletePlayerReview(T, r.naturalKey);
  for (const c of await repo.listClubs(T))
    for (const p of await repo.listPlayers(T, c.id)) await repo.deletePlayer(T, p).catch(() => {});
  for (const r of await repo.listPendingPlayerSync(T))
    await repo.deletePendingPlayerSync(T, r.naturalKey);
}

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  repo = await import('../src/repo.js');
  ({ app } = await import('../src/index.js'));
  players = await import('../src/medicoach-sync/players.js');
  contract = await import('../src/medicoach-sync-contract.js');
  await startStub();
  process.env.MEDICOACH_SYNC_URL = stubUrl;
  process.env.MEDICOACH_SYNC_SECRET = SECRET;
  await repo.putTenantConfig(config(false));
  await repo.createClub(T, mkClub('solo', 'Solo CC', ['premier']));
  await repo.createClub(T, mkClub('other', 'Other CC', ['premier']));
  await repo.createClub(T, mkClub('vets', 'Vets CC', ['veterans-premier']));
});

after(async () => {
  delete process.env.MEDICOACH_SYNC_URL;
  delete process.env.MEDICOACH_SYNC_SECRET;
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  await stopDynalite(ddb);
});

beforeEach(() => {
  pushes.length = 0;
  answer = () => ({ status: 'created' });
  httpFail = null;
  duringPush = null;
});

describe('repo write hooks', () => {
  test('with the flag off a player write queues nothing', async () => {
    const p = mkPlayer();
    await repo.createPlayer(T, p);
    assert.equal((await repo.listPendingPlayerSync(T)).length, 0);
    await repo.putTenantConfig(config(true));
    await clearPlayerSync();
  });

  test('one row per person: repeated changes collapse, an older change never rewinds', async () => {
    const p = mkPlayer();
    await repo.createPlayer(T, p);
    const first = await rowOf(p.naturalKey);
    assert.ok(first);
    await new Promise((r) => setTimeout(r, 5));
    await repo.updatePlayer(T, 'solo', p.naturalKey, { cell: '0831112222' });
    const rows = (await repo.listPendingPlayerSync(T)).filter((r) => r.naturalKey === p.naturalKey);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].changedAt > first!.changedAt);
    await repo.putPendingPlayerSync(T, p.naturalKey, '2020-01-01T00:00:00.000Z');
    assert.equal((await rowOf(p.naturalKey))!.changedAt, rows[0].changedAt);
    // The row holds no personal data — key and timing only.
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      'attempts',
      'changedAt',
      'enqueuedAt',
      'naturalKey',
    ]);
    await clearPlayerSync();
  });
});

describe('flush', () => {
  test('pushes the rebuilt desired state, signed; created deletes the row', async () => {
    const p = mkPlayer({ email: ' Sipho@Example.COM ', guardianName: 'Thandi' });
    await repo.createPlayer(T, p);
    const sum = await flush();
    assert.equal(sum.status, 'ok');
    assert.equal(sum.counts.created, 1);
    assert.equal(pushes.length, 1);
    assert.ok(pushes[0].verified);
    const e = pushes[0].players[0];
    assert.equal(e.ref, ref(p.naturalKey));
    assert.equal(e.op, 'upsert');
    assert.deepEqual(e.teamRefs, [team('premier', 'solo')]);
    assert.equal(e.institutionRef, `smartclub:${T}:club:solo`);
    assert.equal(e.email, 'sipho@example.com');
    assert.equal(e.idNumber, undefined, 'never the raw ID number');
    assert.equal(await rowOf(p.naturalKey), null);
    const logs = await repo.listSyncLogs(T, 5);
    assert.equal(logs[0].kind, 'player-push');
    assert.equal(logs[0].playerPush?.created, 1);
    await clearPlayerSync();
  });

  test('a change that lands while the push is in flight is NOT deleted', async () => {
    const p = mkPlayer();
    await repo.createPlayer(T, p);
    const next = later();
    duringPush = () => repo.putPendingPlayerSync(T, p.naturalKey, next);
    await flush();
    assert.equal((await rowOf(p.naturalKey))?.changedAt, next);
    await clearPlayerSync();
  });

  test('stale is success: the row is deleted', async () => {
    const p = mkPlayer();
    await repo.createPlayer(T, p);
    answer = () => ({ status: 'stale' });
    const sum = await flush();
    assert.equal(sum.counts.stale, 1);
    assert.equal(await rowOf(p.naturalKey), null);
    await clearPlayerSync();
  });

  test('unmapped-team parks the row; a parked row is not resent until retried', async () => {
    const p = mkPlayer();
    await repo.createPlayer(T, p);
    answer = () => ({ status: 'unmapped-team', missingTeamRefs: [team('premier', 'solo')] });
    const first = await flush();
    assert.equal(first.counts.parked, 1);
    const row = await rowOf(p.naturalKey);
    assert.equal(row?.parked, true);
    assert.deepEqual(row?.missingTeamRefs, [team('premier', 'solo')]);

    const second = await flush();
    assert.equal(second.status, 'empty');
    assert.equal(pushes.length, 1, 'parked rows never resend PII every run');

    const status = (await (await call('GET', '/integrations/medicoach/status')).json()) as {
      players: { parked: number; missingTeamRefs: string[] };
    };
    assert.equal(status.players.parked, 1);
    assert.deepEqual(status.players.missingTeamRefs, [team('premier', 'solo')]);

    const retry = await call('POST', '/integrations/medicoach/players/retry', { scope: 'parked' });
    assert.deepEqual(await retry.json(), { requeued: 1 });
    answer = () => ({ status: 'linked' });
    const third = await flush();
    assert.equal(third.counts.linked, 1);
    assert.equal(await rowOf(p.naturalKey), null);
    await clearPlayerSync();
  });

  test('error and HTTP failures count attempts and keep the row', async () => {
    const p = mkPlayer();
    await repo.createPlayer(T, p);
    answer = () => ({ status: 'error', message: 'team locked' });
    await flush();
    assert.equal((await rowOf(p.naturalKey))?.attempts, 1);
    httpFail = 503;
    const sum = await flush();
    assert.equal(sum.counts.errors, 1);
    const row = await rowOf(p.naturalKey);
    assert.equal(row?.attempts, 2);
    assert.equal(row?.lastError, 'medicoach answered HTTP 503');
    await clearPlayerSync();
  });

  test('inactive person → remove; erase never comes from a rebuild', async () => {
    const p = mkPlayer({ status: 'inactive' });
    await repo.createPlayer(T, p);
    answer = () => ({ status: 'removed' });
    await flush();
    assert.deepEqual(pushes[0].players[0], {
      ref: ref(p.naturalKey),
      op: 'remove',
      changedAt: pushes[0].players[0].changedAt,
    });
    await clearPlayerSync();
  });

  test('the drain cap leaves the rest for the next run', async () => {
    for (let i = 0; i < 3; i++) await repo.createPlayer(T, mkPlayer({ lastName: `Cap${i}` }));
    const first = await flush({ maxRows: 2 });
    assert.equal(first.counts.sent, 2);
    assert.equal(first.deferred, 1);
    assert.equal((await repo.listPendingPlayerSync(T)).length, 1);
    const second = await flush({ maxRows: 2 });
    assert.equal(second.counts.sent, 1);
    await clearPlayerSync();
  });

  test('dry run (no secret): nothing sent, nothing written', async () => {
    const p = mkPlayer();
    await repo.createPlayer(T, p);
    const sum = await flush({ secret: '' });
    assert.equal(sum.status, 'dry-run');
    assert.equal(pushes.length, 0);
    assert.equal((await rowOf(p.naturalKey))?.attempts, 0);
    await clearPlayerSync();
  });
});

describe('reviews', () => {
  test('needs-review → review row; link to a candidate rides on the next push', async () => {
    const p = mkPlayer();
    await repo.createPlayer(T, p);
    answer = () => ({
      status: 'needs-review',
      message: 'name+dob match at a different institution',
      candidates: [
        { playerId: 'pl_1', name: 'Sipho X', dob: '1990-01-01', institutionName: 'Umzinto CC' },
      ],
    });
    const sum = await flush();
    assert.equal(sum.counts.needsReview, 1);
    assert.equal(await rowOf(p.naturalKey), null);

    const list = (await (
      await call('GET', '/integrations/medicoach/player-reviews')
    ).json()) as Array<{
      naturalKey: string;
      reason: string;
      candidates: Array<Record<string, unknown>>;
    }>;
    assert.equal(list.length, 1);
    assert.equal(list[0].reason, 'medicoach-needs-review');
    assert.equal(list[0].candidates[0].playerId, 'pl_1');

    const url = `/integrations/medicoach/player-reviews/${p.naturalKey}/resolve`;
    assert.equal(
      (await call('POST', url, { action: 'link', medicoachPlayerId: 'pl_other' })).status,
      400,
    );
    assert.equal(
      (await call('POST', url, { action: 'create', acknowledgedCandidates: [] })).status,
      400,
    );
    assert.equal((await call('POST', url, { action: 'distinct' })).status, 400);
    const ok = await call('POST', url, { action: 'link', medicoachPlayerId: 'pl_1' });
    assert.equal(ok.status, 200);
    assert.equal(await repo.getPlayerReview(T, p.naturalKey), null);

    answer = () => ({ status: 'linked' });
    await flush();
    assert.deepEqual(pushes.at(-1)!.players[0].resolution, { action: 'link', playerId: 'pl_1' });
    assert.equal(await rowOf(p.naturalKey), null);
    await clearPlayerSync();
  });

  test('dismiss drops the review and the queued change', async () => {
    const p = mkPlayer();
    await repo.createPlayer(T, p);
    answer = () => ({ status: 'needs-review', candidates: [] });
    await flush();
    await repo.putPendingPlayerSync(T, p.naturalKey, later());
    const res = await call(
      'POST',
      `/integrations/medicoach/player-reviews/${p.naturalKey}/resolve`,
      {
        action: 'dismiss',
      },
    );
    assert.equal(res.status, 200);
    assert.equal(await repo.getPlayerReview(T, p.naturalKey), null);
    assert.equal(await rowOf(p.naturalKey), null);
    await clearPlayerSync();
  });
});

describe('duplicate prevention (smart club side)', () => {
  test('same name + dob under two IDs holds BOTH; distinct pushes both and never re-flags', async () => {
    const a = mkPlayer({ firstName: 'Thabo', lastName: 'Nkosi', dob: '2004-04-04' });
    const b = mkPlayer({
      firstName: 'thabo',
      lastName: 'NKOSI',
      dob: '2004-04-04',
      clubId: 'other',
    });
    await repo.createPlayer(T, a);
    await repo.createPlayer(T, b);
    const sum = await flush();
    assert.equal(sum.counts.possibleDuplicates, 2);
    assert.equal(pushes.length, 0, 'neither is pushed');
    const reviewA = await repo.getPlayerReview(T, a.naturalKey);
    assert.equal(reviewA?.reason, 'smartclub-possible-duplicate');
    assert.equal(reviewA?.candidates[0].institutionName, 'Other CC');
    assert.ok(await repo.getPlayerReview(T, b.naturalKey));

    const list = (await (
      await call('GET', '/integrations/medicoach/player-reviews')
    ).json()) as Array<{
      candidates: Array<Record<string, unknown>>;
    }>;
    for (const r of list)
      for (const c of r.candidates)
        assert.equal(c.naturalKey, undefined, 'natural keys stay server-side');

    const res = await call(
      'POST',
      `/integrations/medicoach/player-reviews/${a.naturalKey}/resolve`,
      {
        action: 'distinct',
      },
    );
    assert.equal(res.status, 200);
    assert.equal(await repo.getPlayerReview(T, a.naturalKey), null);
    assert.equal(
      await repo.getPlayerReview(T, b.naturalKey),
      null,
      "the other side's review settles too",
    );
    const pushed = await flush();
    assert.equal(pushed.counts.created, 2);
    assert.deepEqual(
      pushes[0].players.map((e) => e.ref).sort(),
      [ref(a.naturalKey), ref(b.naturalKey)].sort(),
    );

    // A later change to either is never flagged again for that pair.
    await repo.updatePlayer(T, 'solo', a.naturalKey, { cell: '0839998888' });
    const again = await flush();
    assert.equal(again.counts.possibleDuplicates, 0);
    assert.equal(again.counts.created, 1);
    await clearPlayerSync();
  });
});

describe('review resolutions survive the guard', () => {
  test('a name+dob twin appearing after a link resolution never discards it', async () => {
    const a = mkPlayer({ firstName: 'Lindo', lastName: 'Zulu', dob: '2003-03-03' });
    await repo.createPlayer(T, a);
    await repo.putPendingPlayerSync(T, a.naturalKey, later(), {
      resolution: { action: 'link', playerId: 'pl_7' },
    });
    await repo.createPlayer(
      T,
      mkPlayer({ firstName: 'Lindo', lastName: 'Zulu', dob: '2003-03-03', clubId: 'other' }),
    );
    answer = () => ({ status: 'linked' });
    await flush();
    const sentA = pushes.flatMap((p) => p.players).find((e) => e.ref === ref(a.naturalKey));
    assert.deepEqual(sentA?.resolution, { action: 'link', playerId: 'pl_7' });
    assert.equal(await repo.getPlayerReview(T, a.naturalKey), null);
    await clearPlayerSync();
  });
});

describe('projected roster reads', () => {
  test('the name+dob index read carries no ID number or contact details', async () => {
    const p = mkPlayer({ email: 'x@y.test' });
    await repo.createPlayer(T, p);
    const rows = await repo.listPlayerNameDobRows(T, 'solo');
    const mine = rows.find((r) => r.naturalKey === p.naturalKey)!;
    assert.deepEqual(Object.keys(mine).sort(), ['dob', 'firstName', 'lastName', 'naturalKey']);
    await clearPlayerSync();
  });
});

describe('erasure', () => {
  test('erasing a VETERANS club is a plain change: upsert with fewer teams, never erase', async () => {
    const p = mkPlayer({ veteransClubId: 'vets', veteransClub: 'Vets CC' });
    await repo.createPlayer(T, p);
    await flush();
    assert.deepEqual(pushes[0].players[0].teamRefs, [
      team('premier', 'solo'),
      team('veterans-premier', 'vets'),
    ]);
    await repo.putVeteransAffiliation(T, {
      naturalKey: p.naturalKey,
      playerName: 'Sipho',
      veteransClubId: 'vets',
      primaryClubId: 'solo',
      primaryClubName: 'Solo CC',
      createdAt: '2026-05-01T00:00:00.000Z',
      source: 'admin',
    });
    await repo.eraseClubData(T, (await repo.getClub(T, 'vets'))!);
    const row = await rowOf(p.naturalKey);
    assert.ok(row);
    assert.equal(row.op, undefined, 'never a tombstone');
    answer = () => ({ status: 'updated' });
    await flush();
    const e = pushes.at(-1)!.players[0];
    assert.equal(e.op, 'upsert');
    assert.deepEqual(e.teamRefs, [team('premier', 'solo')]);
    assert.equal(e.veteransInstitutionRef, undefined);
    await repo.createClub(T, mkClub('vets', 'Vets CC', ['veterans-premier']));
    await clearPlayerSync();
  });

  test('POPIA erasure: erase tombstone + review dropped; a re-registration still erases first', async () => {
    const p = mkPlayer();
    await repo.createPlayer(T, p);
    await repo.putPlayerReview(T, {
      naturalKey: p.naturalKey,
      reason: 'medicoach-needs-review',
      detectedAt: new Date().toISOString(),
      playerName: 'Sipho',
      dob: '1990-01-01',
      clubName: 'Solo CC',
      candidates: [{ playerId: 'pl_9', name: 'Sipho', dob: null, institutionName: null }],
    });
    await repo.erasePlayerData(T, p.naturalKey, { by: 'admin@test' });
    assert.equal((await rowOf(p.naturalKey))?.op, 'erase');
    assert.equal(await repo.getPlayerReview(T, p.naturalKey), null);

    // Re-registered before the erase went out: the tombstone is replaced, the erase is owed.
    await new Promise((r) => setTimeout(r, 5));
    await repo.createPlayer(T, { ...p, createdAt: new Date().toISOString() });
    const row = await rowOf(p.naturalKey);
    assert.equal(row?.op, undefined);
    assert.equal(row?.eraseFirst, true);

    answer = (e) => ({ status: e.op === 'erase' ? 'erased' : 'created' });
    await flush();
    assert.equal(pushes.at(-1)!.players[0].op, 'erase');
    assert.ok(await rowOf(p.naturalKey), 'kept for the upsert');
    await flush();
    assert.equal(pushes.at(-1)!.players[0].op, 'upsert');
    assert.equal(await rowOf(p.naturalKey), null);
    await clearPlayerSync();
  });

  test('a tombstone that flushes alone pushes erase and is deleted', async () => {
    const p = mkPlayer();
    await repo.createPlayer(T, p);
    await repo.erasePlayerData(T, p.naturalKey, { by: 'admin@test' });
    answer = () => ({ status: 'erased' });
    const sum = await flush();
    assert.equal(sum.counts.erased, 1);
    assert.deepEqual(Object.keys(pushes[0].players[0]).sort(), ['changedAt', 'op', 'ref']);
    assert.equal(await rowOf(p.naturalKey), null);
  });

  test('tenant erasure removes the player outbox', async () => {
    const t2 = 'erasable';
    await repo.putTenantConfig({ ...config(true), tenant: t2 } as TenantConfig);
    await repo.createClub(t2, mkClub('solo', 'Solo CC', ['premier']));
    await repo.createPlayer(t2, mkPlayer());
    assert.equal((await repo.listPendingPlayerSync(t2)).length, 1);
    await repo.eraseTenantData(t2);
    assert.equal((await repo.listPendingPlayerSync(t2)).length, 0);
  });
});

describe('admin + operator surface', () => {
  test('Sync now flushes the player outbox after the schedule outbox', async () => {
    const p = mkPlayer();
    await repo.createPlayer(T, p);
    const res = await call('POST', '/integrations/medicoach/sync-now');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { playerPush?: { counts: { created: number } } };
    assert.equal(body.playerPush?.counts.created, 1);
    assert.equal(await rowOf(p.naturalKey), null);
    await clearPlayerSync();
  });

  test('status counts pending, stuck and reviews (no natural keys)', async () => {
    const p = mkPlayer();
    await repo.createPlayer(T, p);
    for (let i = 0; i < 5; i++)
      await repo.markPendingPlayerSyncFailed(
        T,
        p.naturalKey,
        (await rowOf(p.naturalKey))!.changedAt,
        'medicoach answered HTTP 500',
        new Date().toISOString(),
      );
    const status = (await (await call('GET', '/integrations/medicoach/status')).json()) as {
      players: Record<string, unknown>;
    };
    assert.equal(status.players.enabled, true);
    assert.equal(status.players.pending, 1);
    assert.equal(status.players.stuck, 1);
    assert.equal(status.players.reviews, 0);
    assert.ok(!JSON.stringify(status).includes(p.naturalKey));
    const retry = await call('POST', '/integrations/medicoach/players/retry', { scope: 'stuck' });
    assert.deepEqual(await retry.json(), { requeued: 1 });
    assert.equal((await rowOf(p.naturalKey))?.attempts, 0);
    await clearPlayerSync();
  });

  test('operator: playerSync needs medicoachSync; switching it on warns about team coverage', async () => {
    const put = (body: unknown) =>
      app.request(`/platform/tenants/${T}`, {
        method: 'PUT',
        headers: { 'x-dev-auth': OPERATOR, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    await repo.putTenantConfig(config(false));
    const refused = await put({
      features: { medicoachSync: false },
      integrations: { medicoach: { playerSync: true } },
    });
    assert.equal(refused.status, 400);
    const bad = await put({ integrations: { medicoach: { playerSync: 'yes' } } });
    assert.equal(bad.status, 400);
    await repo.createPlayer(T, mkPlayer());
    const on = await put({ integrations: { medicoach: { playerSync: true } } });
    assert.equal(on.status, 200);
    const body = (await on.json()) as TenantConfig & { warnings?: string[] };
    assert.equal(body.integrations?.medicoach?.playerSync, true);
    assert.ok(body.warnings?.some((w) => w.includes('No medicoach bundle export')));
    // A goLiveDate-only save keeps the player sync on.
    const keep = await put({ integrations: { medicoach: { goLiveDate: '2026-10-01' } } });
    const kept = (await keep.json()) as TenantConfig;
    assert.deepEqual(kept.integrations?.medicoach, { goLiveDate: '2026-10-01', playerSync: true });
    // An empty integrations object or a null medicoach block keeps it on too.
    for (const integrations of [{}, { medicoach: null }]) {
      const r = await put({ integrations });
      assert.equal(r.status, 200);
      assert.equal(((await r.json()) as TenantConfig).integrations?.medicoach?.playerSync, true);
    }
    // Only an explicit false switches it off.
    const off = await put({ integrations: { medicoach: { playerSync: false } } });
    assert.equal(((await off.json()) as TenantConfig).integrations?.medicoach?.playerSync, false);
    await repo.putTenantConfig(config(true));
    await clearPlayerSync();
  });

  test('chair add-player warns about a possible existing registration elsewhere', async () => {
    await repo.createPlayer(
      T,
      mkPlayer({ clubId: 'other', firstName: 'Lwazi', lastName: 'Dube', dob: '1995-04-04' }),
    );
    const res = await app.request('/clubs/solo/players', {
      method: 'POST',
      headers: headers(REP_SOLO),
      body: JSON.stringify({
        firstName: 'Lwazi',
        lastName: 'Dube',
        idNumber: validSaId('1995-04-04', 7),
        race: 'African',
        gender: 'Male',
        nationality: 'South African',
        cell: '0821234567',
        team: 'premier',
        district: 'Test District',
      }),
    });
    assert.equal(res.status, 201, await res.clone().text());
    const body = (await res.json()) as { possibleExistingAt?: string[] };
    assert.deepEqual(body.possibleExistingAt, ['Other CC']);
    await clearPlayerSync();
  });
});

// ── Luhn-valid RSA ids (chair-register.test.ts's helper) ──
function validSaId(dobIso: string, n = 0): string {
  const [y, m, d] = dobIso.split('-');
  const twelve = `${y.slice(2)}${m}${d}${String(n).padStart(4, '0')}08`;
  let sum = 0;
  let alt = true;
  for (let i = twelve.length - 1; i >= 0; i--) {
    let digit = twelve.charCodeAt(i) - 48;
    if (alt) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alt = !alt;
  }
  return twelve + String((10 - (sum % 10)) % 10);
}
