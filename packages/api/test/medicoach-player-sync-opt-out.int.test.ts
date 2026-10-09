/**
 * Player-sync opt-out (ADR 0019): a person who deleted their Match Centre account is never sent
 * to medicoach again — except an erase, which only removes data. Real repo + flush + Hono app
 * against an in-process dynalite table; a stub medicoach verifies every signature.
 *
 *  - flush: an opted-out person's queued upsert is dropped unsent (with any held review), while
 *    everyone else still goes out; an erase tombstone and the erase owed before a
 *    re-registration still go out;
 *  - erasure deletes the opt-out marker (it names the person);
 *  - the admin status page reports the opted-out count (a count only);
 *  - the operator CLI: dry run writes nothing; --confirm writes the marker and drops the
 *    queued change + review; prefix rules; --remove opts back in and re-queues.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Club, PlayerRegistration, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4715;
const TABLE = 'SmartClubPlayerSyncOptOut';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const T = 'dolphins';
const SECRET = 'stub-shared-secret';
const ADMIN = Buffer.from(
  JSON.stringify({
    sub: 'admin@test',
    email: 'admin@test',
    memberships: [{ tenantId: T, role: 'admin', clubIds: [] }],
  }),
).toString('base64');

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let players: typeof import('../src/medicoach-sync/players.js');
let contract: typeof import('../src/medicoach-sync-contract.js');
let cli: typeof import('../src/medicoach-sync/player-sync-opt-out.js');

// ── Stub medicoach: records every player push, answers each entry by its op ──
interface Entry {
  ref: string;
  op: string;
  [k: string]: unknown;
}
let stub: Server;
let stubUrl = '';
const pushes: Entry[][] = [];

function startStub(): Promise<void> {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const check = contract.verifySignature({
        secret: SECRET,
        method: req.method ?? 'GET',
        pathAndQuery: req.url ?? '',
        body: raw,
        timestampHeader: req.headers['x-sync-timestamp'] as string | undefined,
        signatureHeader: req.headers['x-sync-signature'] as string | undefined,
      });
      if (!check.ok) return void res.writeHead(401).end('{}');
      if (req.url !== contract.PLAYERS_PATH)
        return void res.writeHead(404).end('{}');
      const body = JSON.parse(raw) as { players: Entry[] };
      pushes.push(body.players);
      const results = body.players.map((e) => ({
        ref: e.ref,
        status: e.op === 'erase' ? 'erased' : 'created',
      }));
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ version: 1, results }));
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
const config = (): TenantConfig =>
  ({
    tenant: T,
    branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    leagues: [{ key: 'premier', label: 'Premier', group: 'Senior', district: 'Test District' }],
    features: { medicoachSync: true },
    integrations: { medicoach: { playerSync: true } },
  }) as unknown as TenantConfig;

const mkClub = (id: string, name: string): Club =>
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
    leagues: ['premier'],
    version: 1,
  }) as unknown as Club;

let seq = 0;
/** Natural keys look like the real hashed ones so the CLI's prefix rules apply. */
const mkPlayer = (over: Partial<PlayerRegistration> = {}): PlayerRegistration => {
  seq++;
  return {
    naturalKey: `${String(seq).padStart(8, 'a')}${'0'.repeat(56)}`,
    clubId: 'solo',
    firstName: 'Sipho',
    lastName: `Player${seq}`,
    dob: '2014-03-01',
    isMinor: true,
    status: 'active',
    team: 'premier',
    consentAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
    idType: 'sa-id',
    idNumber: `1403015${String(100000 + seq).slice(-6)}`,
    cell: '0821234567',
    registeredVia: 'portal',
    ...over,
  };
};

const ref = (nk: string) => `smartclub:${T}:player:${nk}`;
const flush = () =>
  players.flushPlayerOutbox(T, 'manual', { repo, url: stubUrl, secret: SECRET });
const sentRefs = () => pushes.flat().map((e) => `${e.op}:${e.ref}`);
const optOut = (nk: string) =>
  repo.putPlayerSyncOptOut(T, {
    naturalKey: nk,
    reason: 'medicoach-account-deleted',
    by: 'test',
    at: '2026-10-09T00:00:00.000Z',
  });
const review = (nk: string) =>
  repo.putPlayerReview(T, {
    naturalKey: nk,
    reason: 'medicoach-needs-review',
    detectedAt: new Date().toISOString(),
    playerName: 'Sipho Held',
    dob: '2014-03-01',
    clubName: 'Solo CC',
    candidates: [],
  });

async function reset(): Promise<void> {
  for (const c of await repo.listClubs(T))
    for (const p of await repo.listPlayers(T, c.id)) await repo.deletePlayer(T, p).catch(() => {});
  for (const r of await repo.listPendingPlayerSync(T))
    await repo.deletePendingPlayerSync(T, r.naturalKey);
  for (const r of await repo.listPlayerReviews(T)) await repo.deletePlayerReview(T, r.naturalKey);
  for (const nk of await repo.listPlayerSyncOptOuts(T)) await repo.deletePlayerSyncOptOut(T, nk);
  pushes.length = 0;
}

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  repo = await import('../src/repo.js');
  ({ app } = await import('../src/index.js'));
  players = await import('../src/medicoach-sync/players.js');
  contract = await import('../src/medicoach-sync-contract.js');
  cli = await import('../src/medicoach-sync/player-sync-opt-out.js');
  await startStub();
  process.env.MEDICOACH_SYNC_URL = stubUrl;
  process.env.MEDICOACH_SYNC_SECRET = SECRET;
  await repo.putTenantConfig(config());
  await repo.createClub(T, mkClub('solo', 'Solo CC'));
});

after(async () => {
  delete process.env.MEDICOACH_SYNC_URL;
  delete process.env.MEDICOACH_SYNC_SECRET;
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  await stopDynalite(ddb);
});

beforeEach(reset);

describe('flush', () => {
  test("an opted-out person's queued upsert is dropped unsent, with their review; others still go", async () => {
    const out = mkPlayer();
    const kept = mkPlayer();
    await repo.createPlayer(T, out);
    await repo.createPlayer(T, kept);
    await optOut(out.naturalKey);
    await review(out.naturalKey);

    const summary = await flush();

    assert.deepEqual(sentRefs(), [`upsert:${ref(kept.naturalKey)}`]);
    assert.equal(summary.counts.optedOut, 1);
    assert.equal(await repo.getPendingPlayerSync(T, out.naturalKey), null, 'queued change dropped');
    assert.equal(await repo.getPlayerReview(T, out.naturalKey), null, 'review dropped');
    assert.ok(await repo.getPlayerSyncOptOut(T, out.naturalKey), 'the marker itself stays');

    // A later change to the person is dropped too: never sent.
    await repo.recordPlayerSyncChange(T, out.naturalKey);
    pushes.length = 0;
    await flush();
    assert.deepEqual(sentRefs(), []);
  });

  test('an erase tombstone for an opted-out person still goes out', async () => {
    const p = mkPlayer();
    await optOut(p.naturalKey);
    await repo.putPlayerSyncTombstone(T, p.naturalKey, new Date().toISOString());

    await flush();

    assert.deepEqual(sentRefs(), [`erase:${ref(p.naturalKey)}`]);
    assert.equal(await repo.getPendingPlayerSync(T, p.naturalKey), null);
  });

  test('the erase owed before a re-registration goes out; the upsert after it is dropped', async () => {
    const p = mkPlayer();
    await repo.putPlayerSyncTombstone(T, p.naturalKey, '2026-10-01T00:00:00.000Z');
    await repo.createPlayer(T, p); // re-registration: the row keeps the owed erase
    assert.equal((await repo.getPendingPlayerSync(T, p.naturalKey))?.eraseFirst, true);
    await optOut(p.naturalKey);

    await flush();
    assert.deepEqual(sentRefs(), [`erase:${ref(p.naturalKey)}`], 'the owed erase only');

    pushes.length = 0;
    const second = await flush();
    assert.deepEqual(sentRefs(), [], 'the upsert never goes out');
    assert.equal(second.counts.optedOut, 1);
    assert.equal(await repo.getPendingPlayerSync(T, p.naturalKey), null);
  });
});

describe('erasure', () => {
  test("erasePlayerData deletes the person's opt-out marker and sends the erase", async () => {
    const p = mkPlayer();
    await repo.createPlayer(T, p);
    await optOut(p.naturalKey);

    await repo.erasePlayerData(T, p.naturalKey, { by: 'admin@test' });

    assert.equal(await repo.getPlayerSyncOptOut(T, p.naturalKey), null);
    await flush();
    assert.deepEqual(sentRefs(), [`erase:${ref(p.naturalKey)}`]);
  });
});

describe('admin status', () => {
  test('reports the opted-out count, never who', async () => {
    const a = mkPlayer();
    const b = mkPlayer();
    await optOut(a.naturalKey);
    await optOut(b.naturalKey);

    const res = await app.request('/integrations/medicoach/status', {
      headers: { 'x-tenant': T, 'x-dev-auth': ADMIN },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { players: { optedOut: number } };
    assert.equal(body.players.optedOut, 2);
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes(a.naturalKey) && !raw.includes(b.naturalKey), 'no natural keys');
  });
});

describe('operator CLI', () => {
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const args = (over: Partial<import('../src/medicoach-sync/player-sync-opt-out.js').OptOutArgs>) =>
    ({
      tenant: T,
      player: '',
      reason: 'medicoach-account-deleted',
      remove: false,
      confirm: false,
      ...over,
    }) as import('../src/medicoach-sync/player-sync-opt-out.js').OptOutArgs;
  beforeEach(() => {
    lines.length = 0;
  });

  test('dry run writes nothing and prints the person masked', async () => {
    const p = mkPlayer({ firstName: 'Thandiwe', lastName: 'Mokoena' });
    await repo.createPlayer(T, p);

    await cli.run(args({ player: p.naturalKey.slice(0, 10) }), repo, log);

    assert.equal(await repo.getPlayerSyncOptOut(T, p.naturalKey), null);
    assert.ok(await repo.getPendingPlayerSync(T, p.naturalKey), 'queued change untouched');
    const out = lines.join('\n');
    assert.match(out, /DRY RUN/);
    assert.match(out, /T\*+ M\*+ {2}b\.2014/);
    assert.match(out, /Solo CC \(active\)/);
    assert.ok(!out.includes('Thandiwe') && !out.includes('Mokoena'), 'name masked');
    assert.ok(!out.includes(p.naturalKey), 'full key never printed');
  });

  test('--confirm opts out, drops the queued change and the review', async () => {
    const p = mkPlayer();
    await repo.createPlayer(T, p);
    await review(p.naturalKey);

    await cli.run(args({ player: p.naturalKey.slice(0, 8), confirm: true, note: 'MC self-delete' }), repo, log);

    const marker = await repo.getPlayerSyncOptOut(T, p.naturalKey);
    assert.equal(marker?.reason, 'medicoach-account-deleted');
    assert.equal(marker?.note, 'MC self-delete');
    assert.equal(await repo.getPendingPlayerSync(T, p.naturalKey), null);
    assert.equal(await repo.getPlayerReview(T, p.naturalKey), null);
    await flush();
    assert.deepEqual(sentRefs(), []);
  });

  test('--confirm keeps a queued erase (it still has to go out)', async () => {
    const p = mkPlayer();
    await repo.createPlayer(T, p);
    await repo.putPlayerSyncTombstone(T, p.naturalKey, new Date(Date.now() + 1000).toISOString());

    await cli.run(args({ player: p.naturalKey.slice(0, 8), confirm: true }), repo, log);

    assert.equal((await repo.getPendingPlayerSync(T, p.naturalKey))?.op, 'erase');
  });

  test('an already opted-out person is left alone', async () => {
    const p = mkPlayer();
    await repo.createPlayer(T, p);
    await optOut(p.naturalKey);

    await cli.run(args({ player: p.naturalKey.slice(0, 8), confirm: true }), repo, log);

    assert.match(lines.join('\n'), /already opted out/);
    assert.equal((await repo.getPlayerSyncOptOut(T, p.naturalKey))?.by, 'test', 'not rewritten');
  });

  test('--remove opts back in and re-queues the person', async () => {
    const p = mkPlayer();
    await repo.createPlayer(T, p);
    await optOut(p.naturalKey);
    await repo.deletePendingPlayerSync(T, p.naturalKey);

    await cli.run(args({ player: p.naturalKey.slice(0, 8), remove: true, confirm: true }), repo, log);

    assert.equal(await repo.getPlayerSyncOptOut(T, p.naturalKey), null);
    assert.ok(await repo.getPendingPlayerSync(T, p.naturalKey), 're-queued');
    await flush();
    assert.deepEqual(sentRefs(), [`upsert:${ref(p.naturalKey)}`]);
  });

  test('the prefix must name exactly one person', async () => {
    const a = mkPlayer({ naturalKey: `abcdef01${'1'.repeat(56)}` });
    const b = mkPlayer({ naturalKey: `abcdef01${'2'.repeat(56)}` });
    await repo.createPlayer(T, a);
    await repo.createPlayer(T, b);

    await assert.rejects(cli.run(args({ player: 'abcdef01' }), repo, log), /2 players match/);
    await assert.rejects(cli.run(args({ player: 'ffffffff' }), repo, log), /no player/);
    assert.throws(
      () => cli.parseArgs(['--tenant', T, '--player', 'abcdef0']),
      /at least 8 characters/,
    );
    assert.throws(
      () => cli.parseArgs(['--tenant', T, '--player', 'abcdef01', '--reason', 'whim']),
      /--reason must be/,
    );
  });
});
