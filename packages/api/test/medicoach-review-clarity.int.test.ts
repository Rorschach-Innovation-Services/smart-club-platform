/**
 * Held-player review clarity (ADR 0019 follow-up). Real repo + flush + Hono app against an
 * in-process dynalite table; a stub medicoach verifies every signature.
 *
 *  - GET /player-reviews adds read-time detail per side (last 4 of the ID, SA checksum,
 *    registered date, legacy key, same-ID-ignoring-spaces, differing fields) and still never
 *    returns a candidate's natural key or a full ID number;
 *  - GET /player-opt-outs lists who is opted out (name, club, reason, note, by, at);
 *  - registration compacts a spaced ID before storing and hashing it;
 *  - the link-player-sync CLI: dry run writes nothing; --confirm sends a link resolution,
 *    clears the review only after medicoach accepted; a failed send keeps both.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Club, PlayerRegistration, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4793;
const TABLE = 'SmartClubReviewClarity';
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
const CHAIR = Buffer.from(
  JSON.stringify({
    sub: 'chair@test',
    email: 'chair@test',
    memberships: [{ tenantId: T, role: 'chair', clubIds: ['newlands'] }],
  }),
).toString('base64');

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let players: typeof import('../src/medicoach-sync/players.js');
let contract: typeof import('../src/medicoach-sync-contract.js');
let cli: typeof import('../src/medicoach-sync/link-player-sync.js');
let identity: typeof import('../src/player-identity.js');
let reg: typeof import('../src/register-player.js');
let luhnValid: (d: string) => boolean;

interface Entry {
  ref: string;
  op: string;
  resolution?: unknown;
  [k: string]: unknown;
}
let stub: Server;
let stubUrl = '';
const pushes: Entry[][] = [];
let answer: (e: Entry) => Record<string, unknown> = () => ({ status: 'created' });
let failAll = false;

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
      if (failAll) return void res.writeHead(503).end('{}');
      const body = JSON.parse(raw) as { players: Entry[] };
      pushes.push(body.players);
      const results = body.players.map((e) => ({ ref: e.ref, ...answer(e) }));
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

/** A 13-digit SA ID for this dob that passes (or, with `bad`, fails) the Luhn check. */
function saId(yymmdd: string, serial: string, bad = false): string {
  const base = `${yymmdd}${serial}`; // 12 digits
  for (let d = 0; d < 10; d++) {
    const id = `${base}${d}`;
    if (luhnValid(id) !== bad) return id;
  }
  throw new Error('unreachable');
}

let seq = 0;
const hexKey = () => `${String(++seq).padStart(8, 'b')}${'0'.repeat(56)}`;
const mkPlayer = (over: Partial<PlayerRegistration> = {}): PlayerRegistration => ({
  naturalKey: hexKey(),
  clubId: 'newlands',
  firstName: 'Akhiel',
  lastName: 'Sinath',
  dob: '2000-04-11',
  isMinor: false,
  status: 'active',
  team: 'premier',
  consentAt: '2026-05-01T00:00:00.000Z',
  createdAt: '2026-05-01T00:00:00.000Z',
  idType: 'sa-id',
  cell: '0821234567',
  registeredVia: 'portal',
  ...over,
});

const flush = () => players.flushPlayerOutbox(T, 'manual', { repo, url: stubUrl, secret: SECRET });
const get = (path: string, auth = ADMIN) =>
  app.request(path, { headers: { 'x-tenant': T, 'x-dev-auth': auth } });

type Card = {
  playerName: string;
  subject: { idLast4: string | null; idValid: boolean | null; legacyKey: boolean };
  candidates: Array<{
    naturalKey?: string;
    idLast4?: string | null;
    idValid?: boolean | null;
    registeredAt?: string | null;
    legacyKey?: boolean;
    sameIdIgnoringSpaces?: boolean;
    diff?: string[];
  }>;
};

async function reset(): Promise<void> {
  for (const c of await repo.listClubs(T))
    for (const p of await repo.listPlayers(T, c.id)) await repo.deletePlayer(T, p).catch(() => {});
  for (const r of await repo.listPendingPlayerSync(T))
    await repo.deletePendingPlayerSync(T, r.naturalKey);
  for (const r of await repo.listPlayerReviews(T)) await repo.deletePlayerReview(T, r.naturalKey);
  for (const nk of await repo.listPlayerSyncOptOuts(T)) await repo.deletePlayerSyncOptOut(T, nk);
  pushes.length = 0;
  answer = () => ({ status: 'created' });
  failAll = false;
}

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  repo = await import('../src/repo.js');
  ({ app } = await import('../src/index.js'));
  players = await import('../src/medicoach-sync/players.js');
  contract = await import('../src/medicoach-sync-contract.js');
  cli = await import('../src/medicoach-sync/link-player-sync.js');
  identity = await import('../src/player-identity.js');
  reg = await import('../src/register-player.js');
  ({ luhnValid } = await import('../src/roster-normalize.js'));
  await startStub();
  process.env.MEDICOACH_SYNC_URL = stubUrl;
  process.env.MEDICOACH_SYNC_SECRET = SECRET;
  await repo.putTenantConfig(config());
  await repo.createClub(T, mkClub('newlands', 'Newlands CC'));
  await repo.createClub(T, mkClub('simplex', 'Simplex CC'));
});

after(async () => {
  delete process.env.MEDICOACH_SYNC_URL;
  delete process.env.MEDICOACH_SYNC_SECRET;
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  await stopDynalite(ddb);
});

beforeEach(reset);

describe('GET /player-reviews detail', () => {
  test('a checksum typo pair: last 4, validity, registered date, differing fields', async () => {
    const good = saId('000411', '512308');
    const typo = saId('000411', '512380', true);
    const a = mkPlayer({ idNumber: good, createdAt: '2026-02-01T00:00:00.000Z' });
    const b = mkPlayer({ idNumber: typo, createdAt: '2026-03-01T00:00:00.000Z' });
    await repo.createPlayer(T, a);
    await repo.createPlayer(T, b);
    await flush(); // the guard holds both as possible duplicates

    const res = await get('/integrations/medicoach/player-reviews');
    assert.equal(res.status, 200);
    const cards = (await res.json()) as Card[];
    assert.equal(cards.length, 2);
    const raw = JSON.stringify(cards);
    for (const c of cards) for (const x of c.candidates) assert.equal(x.naturalKey, undefined);
    assert.ok(!raw.includes(good) && !raw.includes(typo), 'no full ID number');

    const byLast4 = new Map(cards.map((c) => [c.subject.idLast4, c]));
    const goodCard = byLast4.get(good.slice(-4))!;
    assert.equal(goodCard.subject.idValid, true);
    assert.equal(goodCard.subject.legacyKey, false);
    const cand = goodCard.candidates[0];
    assert.equal(cand.idLast4, typo.slice(-4));
    assert.equal(cand.idValid, false);
    assert.equal(cand.registeredAt, '2026-03-01T00:00:00.000Z');
    assert.equal(cand.sameIdIgnoringSpaces, false);
    assert.deepEqual(cand.diff, ['id']);
  });

  test('a legacy-key row with the identical ID is flagged legacy + same ID', async () => {
    const id = saId('000411', '512308');
    const sha = mkPlayer({ idNumber: id });
    const legacy = mkPlayer({ naturalKey: 'akhiel-sinath-akhiel@example.com', idNumber: id });
    await repo.createPlayer(T, sha);
    await repo.createPlayer(T, legacy);
    await flush();

    const cards = (await (await get('/integrations/medicoach/player-reviews')).json()) as Card[];
    const shaCard = cards.find((c) => !c.subject.legacyKey)!;
    assert.equal(shaCard.candidates[0].legacyKey, true);
    assert.equal(shaCard.candidates[0].sameIdIgnoringSpaces, true);
    assert.deepEqual(shaCard.candidates[0].diff, []);
  });

  test('a spaced passport at another club: same ID ignoring spaces, club + id differ', async () => {
    const a = mkPlayer({ idType: 'passport', nationality: 'India', idNumber: 'S0556434' });
    const b = mkPlayer({
      clubId: 'simplex',
      idType: 'passport',
      nationality: 'India',
      idNumber: 'S 0556434',
    });
    await repo.createPlayer(T, a);
    await repo.createPlayer(T, b);
    await flush();

    const cards = (await (await get('/integrations/medicoach/player-reviews')).json()) as Card[];
    const c = cards[0].candidates[0];
    assert.equal(c.idValid, null, 'no checksum for passports');
    assert.equal(c.sameIdIgnoringSpaces, true);
    assert.deepEqual(c.diff, ['club', 'id-spacing'], 'spacing alone is not an ID difference');
  });

  test('a medicoach review keeps its candidates as they are', async () => {
    const p = mkPlayer({ idNumber: saId('000411', '512308') });
    await repo.createPlayer(T, p);
    await repo.putPlayerReview(T, {
      naturalKey: p.naturalKey,
      reason: 'medicoach-needs-review',
      detectedAt: new Date().toISOString(),
      playerName: 'Akhiel Sinath',
      dob: '2000-04-11',
      clubName: 'Newlands CC',
      candidates: [{ playerId: 'pl_1', name: 'Akhiel Sinath', dob: null, institutionName: 'X' }],
    });
    const cards = (await (await get('/integrations/medicoach/player-reviews')).json()) as Card[];
    assert.deepEqual(cards[0].candidates[0], {
      playerId: 'pl_1',
      name: 'Akhiel Sinath',
      dob: null,
      institutionName: 'X',
    });
    assert.equal(cards[0].subject.idValid, true);
  });
});

describe('GET /player-opt-outs', () => {
  test('lists each opted-out person; admins only', async () => {
    const p = mkPlayer({ firstName: 'Sophie', lastName: 'Groves', clubId: 'simplex' });
    await repo.createPlayer(T, p);
    await repo.putPlayerSyncOptOut(T, {
      naturalKey: p.naturalKey,
      reason: 'medicoach-account-deleted',
      note: 'deleted own MC account',
      by: 'carlton',
      at: '2026-10-09T00:00:00.000Z',
    });

    const res = await get('/integrations/medicoach/player-opt-outs');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [
      {
        name: 'Sophie Groves',
        club: 'Simplex CC',
        reason: 'medicoach-account-deleted',
        note: 'deleted own MC account',
        by: 'carlton',
        at: '2026-10-09T00:00:00.000Z',
      },
    ]);
    assert.equal((await get('/integrations/medicoach/player-opt-outs', CHAIR)).status, 403);
  });
});

describe('registration compacts a spaced ID', () => {
  test('stores and hashes the ID without spaces or dashes', async () => {
    const res = await reg.registerPlayerForClub(
      T,
      mkClub('newlands', 'Newlands CC'),
      {
        firstName: 'Suhel',
        lastName: 'Patel',
        idType: 'passport',
        nationality: 'India',
        dob: '1995-05-05',
        idNumber: ' S 055-6434 ',
      },
      { registeredVia: 'portal', tenantConfig: config(), notifyClearanceOpened: async () => {} },
    );
    assert.equal(res.outcome, 'created');
    const player = (res as { player: PlayerRegistration }).player;
    assert.equal(player.idNumber, 'S0556434');
    assert.equal(
      player.naturalKey,
      identity.playerNaturalKey({ idType: 'passport', nationality: 'India', idNumber: 'S0556434' }),
    );
  });
});

describe('registration refuses a re-key of an ID stored with spaces', () => {
  for (const typed of ['S 0556434', 'S0556434']) {
    test(`re-registering "${typed}" over a stored "S 0556434" row is refused`, async () => {
      const spacedKey = identity.playerNaturalKey({
        idType: 'passport',
        nationality: 'India',
        idNumber: 'S 0556434',
      });
      const stored = mkPlayer({
        naturalKey: spacedKey,
        firstName: 'Suhel',
        lastName: 'Patel',
        idType: 'passport',
        nationality: 'India',
        dob: '1995-05-05',
        idNumber: 'S 0556434',
      });
      await repo.createPlayer(T, stored);
      const res = await reg.registerPlayerForClub(
        T,
        mkClub('simplex', 'Simplex CC'),
        {
          firstName: 'Suhel',
          lastName: 'Patel',
          idType: 'passport',
          nationality: 'India',
          dob: '1995-05-05',
          idNumber: typed,
        },
        { registeredVia: 'portal', tenantConfig: config(), notifyClearanceOpened: async () => {} },
      );
      assert.equal(res.outcome, 'existing-registration-under-legacy-key');
      const all = [
        ...(await repo.listPlayers(T, 'newlands')),
        ...(await repo.listPlayers(T, 'simplex')),
      ];
      assert.equal(all.length, 1, 'no new row');
      assert.equal(all[0].naturalKey, spacedKey);
    });
  }
});

describe('link-player-sync CLI', () => {
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const deps = () => ({ url: stubUrl, secret: SECRET, log });
  const MC = '3f2b8c1e-9a4d-4e7b-8c21-5d6e7f8a9b0c';
  const OTHER_MC = '11111111-2222-4333-8444-555555555555';
  const linkArgs = (nk: string, confirm: boolean, mcPlayer = MC) => ({
    tenant: T,
    nk: nk.slice(0, 10),
    mcPlayer,
    confirm,
  });
  beforeEach(() => {
    lines.length = 0;
  });

  async function heldSurvivor() {
    const a = mkPlayer({ idNumber: saId('000411', '512308') });
    const b = mkPlayer({ idNumber: saId('000411', '512380', true) });
    await repo.createPlayer(T, a);
    await repo.createPlayer(T, b);
    await flush(); // both held
    assert.ok(await repo.getPlayerReview(T, a.naturalKey));
    pushes.length = 0;
    return a;
  }

  test('dry run writes nothing', async () => {
    const a = await heldSurvivor();
    const out = await cli.run(
      { tenant: T, nk: a.naturalKey.slice(0, 10), mcPlayer: MC, confirm: false },
      repo,
      deps(),
    );
    assert.equal(out.outcome, 'dry-run');
    assert.equal(await repo.getPendingPlayerSync(T, a.naturalKey), null);
    assert.ok(await repo.getPlayerReview(T, a.naturalKey));
    assert.equal(pushes.length, 0);
    const out2 = lines.join('\n');
    assert.ok(!out2.includes(a.naturalKey), 'full key never printed');
    assert.ok(out2.includes(MC), 'full medicoach id printed');
    assert.match(out2, /sync intent: upsert · pending erase: no/);
  });

  test('refuses when the sync intent is not upsert (dry run shows it)', async () => {
    const p = mkPlayer({ idNumber: saId('000411', '512308'), status: 'inactive' });
    await repo.createPlayer(T, p);
    const dry = await cli.run(linkArgs(p.naturalKey, false), repo, deps());
    assert.equal(dry.outcome, 'refused');
    assert.match(lines.join('\n'), /sync intent: remove/);
    const out = await cli.run(linkArgs(p.naturalKey, true), repo, deps());
    assert.equal(out.outcome, 'refused');
    assert.equal((await repo.getPendingPlayerSync(T, p.naturalKey))?.resolution, undefined);
    assert.equal(pushes.length, 0);
  });

  test('refuses on a pending erase tombstone; dry run shows it', async () => {
    const a = await heldSurvivor();
    await repo.putPlayerSyncTombstone(T, a.naturalKey, new Date().toISOString());
    const dry = await cli.run(linkArgs(a.naturalKey, false), repo, deps());
    assert.equal(dry.outcome, 'refused');
    assert.match(lines.join('\n'), /pending erase: erase \(tombstone\)/);
    const out = await cli.run(linkArgs(a.naturalKey, true), repo, deps());
    assert.equal(out.outcome, 'refused');
    const row = await repo.getPendingPlayerSync(T, a.naturalKey);
    assert.equal(row?.op, 'erase', 'tombstone untouched');
    assert.equal(row?.resolution, undefined);
    assert.equal(pushes.length, 0);
  });

  test('refuses when an erase is owed first', async () => {
    const a = await heldSurvivor();
    await repo.putPlayerSyncTombstone(T, a.naturalKey, '2026-01-01T00:00:00.000Z');
    await repo.putPendingPlayerSync(T, a.naturalKey, new Date().toISOString()); // re-registered
    assert.equal((await repo.getPendingPlayerSync(T, a.naturalKey))?.eraseFirst, true);
    const out = await cli.run(linkArgs(a.naturalKey, true), repo, deps());
    assert.equal(out.outcome, 'refused');
    assert.match(lines.join('\n'), /pending erase: erase owed first/);
    assert.equal(pushes.length, 0);
  });

  test('warns when --mc-player is not a candidate on the held review', async () => {
    const p = mkPlayer({ idNumber: saId('000411', '512308') });
    await repo.createPlayer(T, p);
    const review = {
      naturalKey: p.naturalKey,
      reason: 'medicoach-needs-review' as const,
      detectedAt: new Date().toISOString(),
      playerName: 'Akhiel Sinath',
      dob: '2000-04-11',
      clubName: 'Newlands CC',
      candidates: [{ playerId: MC, name: 'Akhiel Sinath', dob: null, institutionName: 'X' }],
    };
    await repo.putPlayerReview(T, review);
    await cli.run(linkArgs(p.naturalKey, false), repo, deps());
    assert.match(lines.join('\n'), /matches a medicoach candidate on the held review: yes/);
    lines.length = 0;
    await cli.run(linkArgs(p.naturalKey, false, OTHER_MC), repo, deps());
    assert.match(lines.join('\n'), /WARNING: not one of the 1 medicoach candidate/);
  });

  test('medicoach creating instead of linking is reported as such; the review is kept', async () => {
    const a = await heldSurvivor();
    answer = () => ({ status: 'created', playerId: OTHER_MC });
    const out = await cli.run(linkArgs(a.naturalKey, true), repo, deps());
    assert.equal(out.outcome, 'unexpected');
    assert.match(lines.join('\n'), /did not report a link for this person \(created 1, linked 0/);
    assert.ok(await repo.getPlayerReview(T, a.naturalKey), 'review kept');
  });

  test('--confirm sends a link resolution past the guard and clears the review', async () => {
    const a = await heldSurvivor();
    answer = () => ({ status: 'linked', playerId: MC });
    const out = await cli.run(
      { tenant: T, nk: a.naturalKey.slice(0, 10), mcPlayer: MC, confirm: true },
      repo,
      deps(),
    );
    assert.equal(out.outcome, 'linked');
    assert.equal(pushes.flat().length, 1);
    assert.deepEqual(pushes[0][0].resolution, { action: 'link', playerId: MC });
    assert.equal(await repo.getPendingPlayerSync(T, a.naturalKey), null);
    assert.equal(await repo.getPlayerReview(T, a.naturalKey), null);
    assert.match(lines.join('\n'), /linked/);
  });

  test('a failed send keeps the queued link and the review', async () => {
    const a = await heldSurvivor();
    failAll = true;
    const out = await cli.run(
      { tenant: T, nk: a.naturalKey.slice(0, 10), mcPlayer: MC, confirm: true },
      repo,
      deps(),
    );
    assert.equal(out.outcome, 'queued');
    const row = await repo.getPendingPlayerSync(T, a.naturalKey);
    assert.deepEqual(row?.resolution, { action: 'link', playerId: MC });
    assert.ok(await repo.getPlayerReview(T, a.naturalKey), 'review kept');
  });

  test('argument rules', () => {
    assert.throws(() => cli.parseArgs(['--tenant', T, '--nk', 'abcdef01']), /--mc-player/);
    assert.throws(
      () => cli.parseArgs(['--tenant', T, '--nk', 'abc', '--mc-player', 'x']),
      /at least 8/,
    );
    assert.throws(
      () => cli.parseArgs(['--tenant', T, '--nk', 'abcdef01', '--mc-player', 'pl_1']),
      /UUID/,
    );
    assert.deepEqual(
      cli.parseArgs(['--tenant', T, '--nk', 'abcdef01', '--mc-player', MC, '--confirm']),
      { tenant: T, nk: 'abcdef01', mcPlayer: MC, confirm: true },
    );
  });
});
