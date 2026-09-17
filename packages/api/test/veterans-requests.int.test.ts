/**
 * Integration tests for veterans squad-selection requests (ADR 0013) — the finder, request
 * create/accept/decline/withdraw, admin override, erasure, and the comm log. Boots an in-process
 * dynalite, seeds the dolphins config (which carries a `veterans` league), creates clubs + a
 * RELEASED veterans series so the finder gate opens, and drives the REAL Hono app.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';

const DDB_PORT = 4637; // next free even port after in-season-clash-gate (4635)
const TABLE = 'SmartClubTest';
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.LOCAL_AUTH = '1';
process.env.STAGE = 'local';
process.env.USER_POOL_ID = 'test-pool';
process.env.AWS_REGION ??= 'localhost';
process.env.UPLOADS_BUCKET = 'test-uploads';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_MAX_ATTEMPTS = '1';

const devAuth = (memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email: 'rep@test', memberships })).toString('base64');
const ADMIN = devAuth([{ tenantId: 'dolphins', role: 'admin', clubIds: [] }]);
const REP_VETS = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['vets'] }]);
const REP_PRI = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['pri'] }]);
const REP_THIRD = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['third'] }]);

const headers = (auth: string) => ({
  'x-tenant': 'dolphins',
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let playerNaturalKey: (typeof import('../src/player-identity.js'))['playerNaturalKey'];

const mkClub = (id: string, name: string) => ({
  id,
  name,
  district: 'Test District',
  sub: `sub-${id}`,
  chair: 'Chair',
  affiliation: 'not_started' as const,
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
});

const mkPlayer = (clubId: string, idNumber: string, first: string, last: string, extra = {}) => {
  const naturalKey = playerNaturalKey({
    idNumber,
    idType: 'passport',
    nationality: 'South African',
  });
  return {
    naturalKey,
    clubId,
    firstName: first,
    lastName: last,
    dob: '1980-05-05',
    idType: 'passport' as const,
    idNumber,
    nationality: 'South African',
    isMinor: false,
    consentAt: '2026-06-01T00:00:00.000Z',
    createdAt: '2026-06-01T00:00:00.000Z',
    status: 'active' as const,
    version: 0,
    ...extra,
  };
};

before(async () => {
  const dynalite = (await import('dynalite')).default as (opts?: unknown) => Server;
  ddbServer = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => ddbServer.listen(DDB_PORT, resolve));

  const { DynamoDBClient, CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  const admin = new DynamoDBClient({
    endpoint: process.env.DYNAMO_ENDPOINT,
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  await admin.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi1pk', AttributeType: 'S' },
        { AttributeName: 'gsi1sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );

  const seed = await import('../src/seed-core.js');
  await seed.seedTenantConfig('dolphins');
  ({ app } = await import('../src/index.js'));
  repo = await import('../src/repo.js');
  ({ playerNaturalKey } = await import('../src/player-identity.js'));

  // Clubs: vets (the requesting veterans club), pri/pri2 (primary clubs), third (NOT fixtured in
  // veterans), other (an unrelated affiliation target).
  for (const [id, name] of [
    ['vets', 'Vets United CC'],
    ['pri', 'Glenwood CC'],
    ['pri2', 'Northlands CC'],
    ['third', 'Unfixtured CC'],
    ['other', 'Other Vets CC'],
  ] as const) {
    await repo.createClub('dolphins', mkClub(id, name));
  }

  // A RELEASED veterans series with vets + pri + pri2 as participants → the finder gate opens for
  // those clubs (but NOT for `third`).
  await repo.putSeries('dolphins', {
    id: 's-vets-1',
    name: 'Veterans League · Round 1',
    leagueKey: 'veterans',
    startDate: '2026-06-01',
    teams: ['vets', 'pri', 'pri2'],
    participants: [
      { teamId: 'vets', clubId: 'vets', name: 'Vets United CC' },
      { teamId: 'pri', clubId: 'pri', name: 'Glenwood CC' },
      { teamId: 'pri2', clubId: 'pri2', name: 'Northlands CC' },
    ],
    fixtures: [],
    approved: true,
    approvedAt: '2026-05-01T00:00:00.000Z',
    released: true,
    releasedAt: '2026-05-15T00:00:00.000Z',
    version: 1,
  } as never);

  // Players at the primary clubs. Distinct idNumbers → distinct natural keys.
  await repo.createPlayer(
    'dolphins',
    mkPlayer('pri', 'FIND0001', 'Thabo', 'Nkosi', { team: 'premier' }),
  );
  await repo.createPlayer('dolphins', mkPlayer('pri', 'ACCE0002', 'Sipho', 'Dlamini'));
  await repo.createPlayer(
    'dolphins',
    mkPlayer('pri', 'INAC0003', 'Ina', 'Ctive', { status: 'inactive' }),
  );
  await repo.createPlayer(
    'dolphins',
    mkPlayer('pri', 'AFFI0004', 'Al', 'Ready', {
      veteransClub: 'Other Vets CC',
      veteransClubId: 'other',
    }),
  );
  await repo.createPlayer(
    'dolphins',
    mkPlayer('pri', 'VETT0005', 'Vic', 'Vet', { team: 'veterans' }),
  );
  await repo.createPlayer('dolphins', mkPlayer('pri2', 'DIAC0006', 'André', 'Böthá'));
  // The vets club's OWN player (must never surface in its own finder).
  await repo.createPlayer('dolphins', mkPlayer('vets', 'OWNP0007', 'Thabo', 'Owner'));
});

after(() => {
  ddbServer?.close();
});

const finder = (q: string, auth = REP_VETS, club = 'vets') =>
  app.request(`/clubs/${club}/veterans-candidates?q=${encodeURIComponent(q)}`, {
    headers: headers(auth),
  });

describe('finder gate + validation', () => {
  test('403 when the club is not fixtured in a released veterans series', async () => {
    const res = await finder('Thabo', REP_THIRD, 'third');
    assert.equal(res.status, 403);
  });

  test('400 when the query is under 3 characters', async () => {
    const res = await finder('ab');
    assert.equal(res.status, 400);
  });

  test('200 for a fixtured club with a valid query', async () => {
    const res = await finder('Thabo');
    assert.equal(res.status, 200);
  });
});

describe('finder projection is PII-minimised', () => {
  test('the ProjectionExpression never carries idNumber/dob/cell/email', () => {
    const proj = repo.PLAYER_FINDER_PROJECTION;
    for (const banned of ['idNumber', 'dob', 'cell', 'email', 'naturalKey', 'idDocMeta']) {
      assert.ok(!proj.includes(banned), `projection must not include ${banned}: ${proj}`);
    }
    for (const needed of ['firstName', 'lastName', 'veteransClubId', 'team', 'clubId']) {
      assert.ok(proj.includes(needed), `projection should include ${needed}`);
    }
  });

  test('a finder row carries only the public candidate fields (no PII leaks)', async () => {
    const res = await finder('Thabo Nkosi');
    const body = (await res.json()) as { candidates: Record<string, unknown>[] };
    const mine = body.candidates.find((c) => c.playerName === 'Thabo Nkosi');
    assert.ok(mine, 'Thabo Nkosi should match');
    assert.deepEqual(Object.keys(mine!).sort(), [
      'candidateId',
      'playerName',
      'primaryClubId',
      'primaryClubName',
    ]);
  });
});

describe('finder exclusions + candidate handle', () => {
  test('excludes own club, non-active, already-affiliated, and veterans-team rows', async () => {
    const res = await finder('a'); // will 400; use a real query instead
    assert.equal(res.status, 400);

    // Broad-ish surname searches (each ≥3 chars) to probe each excluded row.
    const names = await (async () => {
      const collect = async (q: string) => {
        const r = await finder(q);
        const b = (await r.json()) as { candidates: { playerName: string }[] };
        return b.candidates.map((c) => c.playerName);
      };
      return {
        owner: await collect('Owner'), // vets' own player
        inactive: await collect('Ctive'),
        affiliated: await collect('Ready'),
        vetTeam: await collect('Vic Vet'),
        active: await collect('Sipho'),
      };
    })();
    assert.deepEqual(names.owner, [], 'own-club player excluded');
    assert.deepEqual(names.inactive, [], 'inactive row excluded');
    assert.deepEqual(names.affiliated, [], 'already-affiliated row excluded');
    assert.deepEqual(names.vetTeam, [], 'veterans-team row excluded');
    assert.deepEqual(names.active, ['Sipho Dlamini'], 'eligible active player surfaces');
  });

  test('candidateId is an opaque HMAC — not the natural key and not a plain sha256', async () => {
    const res = await finder('Sipho');
    const body = (await res.json()) as {
      candidates: { candidateId: string; primaryClubId: string }[];
    };
    const cand = body.candidates[0];
    const nk = playerNaturalKey({
      idNumber: 'ACCE0002',
      idType: 'passport',
      nationality: 'South African',
    });
    const plainSha = createHash('sha256').update(`dolphins|pri|${nk}`).digest('hex');
    assert.notEqual(cand.candidateId, nk);
    assert.notEqual(cand.candidateId, plainSha);
    assert.match(cand.candidateId, /^[0-9a-f]{64}$/);
  });

  test('diacritics-insensitive match on first/last and last/first', async () => {
    for (const q of ['andre botha', 'BOTHA Andre', 'André']) {
      const r = await finder(q);
      const b = (await r.json()) as { candidates: { playerName: string }[] };
      assert.ok(
        b.candidates.some((c) => c.playerName === 'André Böthá'),
        `query "${q}" should match André Böthá`,
      );
    }
  });

  test('caps at 20 with truncated=true', async () => {
    // Seed 21 same-surname players at pri2 so a single query overflows the cap.
    for (let i = 0; i < 21; i++) {
      await repo.createPlayer(
        'dolphins',
        mkPlayer('pri2', `CAP${String(i).padStart(4, '0')}`, `Capper${i}`, 'Capsurname'),
      );
    }
    const res = await finder('Capsurname');
    const body = (await res.json()) as { candidates: unknown[]; truncated: boolean };
    assert.equal(body.candidates.length, 20);
    assert.equal(body.truncated, true);
  });
});

/** Pull a fresh candidateId for a given primary-club player from the finder. */
const candidateIdFor = async (q: string, playerName: string): Promise<string> => {
  const r = await finder(q);
  const b = (await r.json()) as { candidates: { candidateId: string; playerName: string }[] };
  const c = b.candidates.find((x) => x.playerName === playerName);
  assert.ok(c, `finder should surface ${playerName}`);
  return c!.candidateId;
};

const createRequest = (body: Record<string, unknown>, auth = REP_VETS, club = 'vets') =>
  app.request(`/clubs/${club}/veterans-requests`, {
    method: 'POST',
    headers: headers(auth),
    body: JSON.stringify(body),
  });

describe('create request', () => {
  test('201 with the public shape; mirror lacks the natural key; 409 duplicate', async () => {
    const candidateId = await candidateIdFor('Sipho', 'Sipho Dlamini');
    const res = await createRequest({ primaryClubId: 'pri', candidateId, note: 'strong batter' });
    assert.equal(res.status, 201);
    const created = (await res.json()) as Record<string, unknown>;
    assert.equal(created.status, 'pending');
    assert.equal(created.primaryClubId, 'pri');
    assert.equal(created.veteransClubId, 'vets');
    assert.ok(!('playerNaturalKey' in created), 'response must not carry the natural key');

    // The mirror stored under the veterans club must NOT carry the natural key.
    const mirror = await repo.getOutboundVeteransRequest('dolphins', 'vets', created.id as string);
    assert.ok(mirror, 'mirror row exists');
    assert.equal(mirror!.playerNaturalKey, undefined, 'mirror omits the natural key');
    // The canonical DOES carry it (accept needs it).
    const canonical = await repo.getVeteransRequest('dolphins', 'pri', created.id as string);
    assert.ok(canonical!.playerNaturalKey, 'canonical carries the natural key');

    // A second request for the same player is a 409.
    const dup = await createRequest({ primaryClubId: 'pri', candidateId });
    assert.equal(dup.status, 409);

    // GET returns { inbound, outbound }: the primary club sees it inbound; the vets club outbound.
    const priList = (await (
      await app.request('/clubs/pri/veterans-requests', { headers: headers(REP_PRI) })
    ).json()) as { inbound: Array<Record<string, unknown>>; outbound: unknown[] };
    assert.ok(priList.inbound.some((x) => x.id === created.id));
    assert.ok(
      !priList.inbound.some((x) => 'playerNaturalKey' in x),
      'inbound omits the natural key',
    );
    const vetsList = (await (
      await app.request('/clubs/vets/veterans-requests', { headers: headers(REP_VETS) })
    ).json()) as { inbound: unknown[]; outbound: Array<Record<string, unknown>> };
    assert.ok(vetsList.outbound.some((x) => x.id === created.id));
  });

  test('403 when the requesting club is not fixtured in a released veterans series', async () => {
    // `third` is not a participant — even with a valid candidateId it must 403 on the gate.
    const candidateId = await candidateIdFor('Sipho', 'Sipho Dlamini');
    const res = await createRequest({ primaryClubId: 'pri', candidateId }, REP_THIRD, 'third');
    assert.equal(res.status, 403);
  });
});

describe('accept', () => {
  test('writes veteransClubId + a VETAFFIL record; playerCount unchanged; second accept 409', async () => {
    // A fresh eligible player + request.
    await repo.createPlayer('dolphins', mkPlayer('pri', 'ACPT1001', 'Mandla', 'Zulu'));
    const before = (await repo.getClub('dolphins', 'pri'))!.playerCount;
    const candidateId = await candidateIdFor('Mandla Zulu', 'Mandla Zulu');
    const created = (await (await createRequest({ primaryClubId: 'pri', candidateId })).json()) as {
      id: string;
    };

    const acc = await app.request(`/clubs/pri/veterans-requests/${created.id}/accept`, {
      method: 'POST',
      headers: headers(REP_PRI),
      body: '{}',
    });
    assert.equal(acc.status, 200);
    const resolved = (await acc.json()) as Record<string, unknown>;
    assert.equal(resolved.status, 'accepted');
    assert.equal(resolved.resolvedVia, 'portal');

    // Player row now points at the veterans club.
    const nk = playerNaturalKey({
      idNumber: 'ACPT1001',
      idType: 'passport',
      nationality: 'South African',
    });
    const player = await repo.getPlayer('dolphins', 'pri', nk);
    assert.equal(player!.veteransClubId, 'vets');

    // A VETAFFIL record exists under the veterans club.
    const affiliates = await repo.listVeteransAffiliations('dolphins', 'vets');
    assert.ok(affiliates.some((a) => a.naturalKey === nk && a.primaryClubId === 'pri'));

    // playerCount is unchanged (an affiliation is not a second roster row).
    assert.equal((await repo.getClub('dolphins', 'pri'))!.playerCount, before);

    // A second accept is a 409 (already resolved).
    const again = await app.request(`/clubs/pri/veterans-requests/${created.id}/accept`, {
      method: 'POST',
      headers: headers(REP_PRI),
      body: '{}',
    });
    assert.equal(again.status, 409);
  });

  test('409 when the player is already affiliated to a different club', async () => {
    await repo.createPlayer('dolphins', mkPlayer('pri', 'ACPT1002', 'Bongani', 'Khumalo'));
    const candidateId = await candidateIdFor('Bongani Khumalo', 'Bongani Khumalo');
    const created = (await (await createRequest({ primaryClubId: 'pri', candidateId })).json()) as {
      id: string;
    };
    const nk = playerNaturalKey({
      idNumber: 'ACPT1002',
      idType: 'passport',
      nationality: 'South African',
    });
    // Race: the player becomes affiliated elsewhere after the request was opened.
    await repo.setPlayerVeteransClub(
      'dolphins',
      'pri',
      nk,
      { id: 'other', name: 'Other Vets CC' },
      'admin',
    );
    const acc = await app.request(`/clubs/pri/veterans-requests/${created.id}/accept`, {
      method: 'POST',
      headers: headers(REP_PRI),
      body: '{}',
    });
    assert.equal(acc.status, 409);
  });

  test('409 when the player is mid-transfer (not active)', async () => {
    await repo.createPlayer('dolphins', mkPlayer('pri', 'ACPT1003', 'Lwazi', 'Mthembu'));
    const candidateId = await candidateIdFor('Lwazi Mthembu', 'Lwazi Mthembu');
    const created = (await (await createRequest({ primaryClubId: 'pri', candidateId })).json()) as {
      id: string;
    };
    const nk = playerNaturalKey({
      idNumber: 'ACPT1003',
      idType: 'passport',
      nationality: 'South African',
    });
    await repo.updatePlayer('dolphins', 'pri', nk, { status: 'clearance-pending' });
    const acc = await app.request(`/clubs/pri/veterans-requests/${created.id}/accept`, {
      method: 'POST',
      headers: headers(REP_PRI),
      body: '{}',
    });
    assert.equal(acc.status, 409);
  });

  test('409 when the player row has been deleted', async () => {
    await repo.createPlayer('dolphins', mkPlayer('pri', 'ACPT1004', 'Kagiso', 'Molefe'));
    const candidateId = await candidateIdFor('Kagiso Molefe', 'Kagiso Molefe');
    const created = (await (await createRequest({ primaryClubId: 'pri', candidateId })).json()) as {
      id: string;
    };
    const nk = playerNaturalKey({
      idNumber: 'ACPT1004',
      idType: 'passport',
      nationality: 'South African',
    });
    const player = await repo.getPlayer('dolphins', 'pri', nk);
    await repo.deletePlayer('dolphins', player!);
    const acc = await app.request(`/clubs/pri/veterans-requests/${created.id}/accept`, {
      method: 'POST',
      headers: headers(REP_PRI),
      body: '{}',
    });
    assert.equal(acc.status, 409);
  });

  test('409 on a stale version', async () => {
    await repo.createPlayer('dolphins', mkPlayer('pri', 'ACPT1005', 'Tumi', 'Sithole'));
    const candidateId = await candidateIdFor('Tumi Sithole', 'Tumi Sithole');
    const created = (await (await createRequest({ primaryClubId: 'pri', candidateId })).json()) as {
      id: string;
    };
    const acc = await app.request(`/clubs/pri/veterans-requests/${created.id}/accept`, {
      method: 'POST',
      headers: headers(REP_PRI),
      body: JSON.stringify({ version: 99 }),
    });
    assert.equal(acc.status, 409);
  });

  // TOCTOU compensation (Fix 2): accept writes the affiliation BEFORE resolveVeteransRequest's OCC
  // guard. If the request is resolved out from under it, accept must not leave a dangling affiliation.
  test('a decline before accept 409s and leaves no affiliation (no VETAFFIL# lingers)', async () => {
    await repo.createPlayer('dolphins', mkPlayer('pri', 'TOCT1006', 'Zola', 'Mbeki'));
    const candidateId = await candidateIdFor('Zola Mbeki', 'Zola Mbeki');
    const created = (await (await createRequest({ primaryClubId: 'pri', candidateId })).json()) as {
      id: string;
    };
    const nk = playerNaturalKey({
      idNumber: 'TOCT1006',
      idType: 'passport',
      nationality: 'South African',
    });

    // The player's club declines first — the request is no longer pending.
    const dec = await app.request(`/clubs/pri/veterans-requests/${created.id}/decline`, {
      method: 'POST',
      headers: headers(REP_PRI),
      body: '{}',
    });
    assert.equal(dec.status, 200);

    // The accept now 409s and must NOT leave the player affiliated.
    const acc = await app.request(`/clubs/pri/veterans-requests/${created.id}/accept`, {
      method: 'POST',
      headers: headers(REP_PRI),
      body: '{}',
    });
    assert.equal(acc.status, 409);

    const player = await repo.getPlayer('dolphins', 'pri', nk);
    assert.equal(
      player!.veteransClubId,
      undefined,
      'player is not affiliated after the failed accept',
    );
    const affiliates = await repo.listVeteransAffiliations('dolphins', 'vets');
    assert.ok(
      !affiliates.some((a) => a.naturalKey === nk),
      'no VETAFFIL# record lingers for the declined player',
    );
  });

  // The negative branch of the compensation: a version-only OCC conflict while the request is STILL
  // pending must keep the affiliation (a retry can complete the accept) — accept must not over-clear.
  test('a version-only conflict on a still-pending request keeps the affiliation', async () => {
    await repo.createPlayer('dolphins', mkPlayer('pri', 'TOCT1007', 'Ayanda', 'Dube'));
    const candidateId = await candidateIdFor('Ayanda Dube', 'Ayanda Dube');
    const created = (await (await createRequest({ primaryClubId: 'pri', candidateId })).json()) as {
      id: string;
    };
    const nk = playerNaturalKey({
      idNumber: 'TOCT1007',
      idType: 'passport',
      nationality: 'South African',
    });

    // A STALE expectedVersion fails resolve's OCC. The affiliation was written, but the request is
    // still pending, so compensation must NOT undo it.
    await assert.rejects(
      repo.acceptVeteransRequest('dolphins', 'pri', created.id, {
        at: new Date().toISOString(),
        by: 'rep@test',
        via: 'portal',
        expectedVersion: 99,
      }),
      (e: unknown) => e instanceof repo.VersionConflictError,
    );

    const canonical = await repo.getVeteransRequest('dolphins', 'pri', created.id);
    assert.equal(canonical!.status, 'pending', 'request stays pending after the version conflict');
    const player = await repo.getPlayer('dolphins', 'pri', nk);
    assert.equal(
      player!.veteransClubId,
      'vets',
      'affiliation persists — not over-cleared while the request is still pending',
    );
  });
});

describe('decline / withdraw set a TTL', () => {
  test('decline (primary club) sets status + expiresAt', async () => {
    await repo.createPlayer('dolphins', mkPlayer('pri', 'DECL2001', 'Naledi', 'Mokoena'));
    const candidateId = await candidateIdFor('Naledi Mokoena', 'Naledi Mokoena');
    const created = (await (await createRequest({ primaryClubId: 'pri', candidateId })).json()) as {
      id: string;
    };
    const res = await app.request(`/clubs/pri/veterans-requests/${created.id}/decline`, {
      method: 'POST',
      headers: headers(REP_PRI),
      body: JSON.stringify({ reason: 'over age' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, 'declined');
    assert.equal(body.declineReason, 'over age');
    assert.equal(typeof body.expiresAt, 'number');
    assert.ok((body.expiresAt as number) > Math.floor(Date.now() / 1000));
  });

  test('withdraw (veterans club) sets status + expiresAt via the mirror', async () => {
    await repo.createPlayer('dolphins', mkPlayer('pri', 'WDRW2002', 'Sanele', 'Ngcobo'));
    const candidateId = await candidateIdFor('Sanele Ngcobo', 'Sanele Ngcobo');
    const created = (await (await createRequest({ primaryClubId: 'pri', candidateId })).json()) as {
      id: string;
    };
    const res = await app.request(`/clubs/vets/veterans-requests/${created.id}/withdraw`, {
      method: 'POST',
      headers: headers(REP_VETS),
      body: '{}',
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, 'withdrawn');
    assert.equal(typeof body.expiresAt, 'number');
    // Both rows carry the terminal status.
    const mirror = await repo.getOutboundVeteransRequest('dolphins', 'vets', created.id);
    assert.equal(mirror!.status, 'withdrawn');
  });
});

describe('admin override', () => {
  test('admin accept resolves with resolvedVia=admin', async () => {
    await repo.createPlayer('dolphins', mkPlayer('pri', 'ADMN3001', 'Ayanda', 'Zwane'));
    const candidateId = await candidateIdFor('Ayanda Zwane', 'Ayanda Zwane');
    const created = (await (await createRequest({ primaryClubId: 'pri', candidateId })).json()) as {
      id: string;
    };
    const list = await app.request('/admin/veterans-requests', { headers: headers(ADMIN) });
    assert.equal(list.status, 200);
    const rows = (await list.json()) as Array<Record<string, unknown>>;
    assert.ok(rows.some((r) => r.id === created.id));
    assert.ok(!rows.some((r) => 'playerNaturalKey' in r), 'admin list omits the natural key');

    const res = await app.request(`/admin/veterans-requests/${created.id}/accept`, {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ primaryClubId: 'pri' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, 'accepted');
    assert.equal(body.resolvedVia, 'admin');
  });
});

describe('comm log', () => {
  test('opening records a veterans-request row on the primary club; accept records one on the vets club', async () => {
    await repo.createPlayer('dolphins', mkPlayer('pri', 'COMM4001', 'Kabelo', 'Maree'));
    const candidateId = await candidateIdFor('Kabelo Maree', 'Kabelo Maree');
    const created = (await (await createRequest({ primaryClubId: 'pri', candidateId })).json()) as {
      id: string;
    };
    const priLog = (await repo.getClub('dolphins', 'pri'))!.commLog ?? [];
    assert.ok(
      priLog.some((e) => e.kind === 'veterans-request' && e.idempotencyKey.includes(created.id)),
      'primary club has a veterans-request comm event',
    );

    await app.request(`/clubs/pri/veterans-requests/${created.id}/accept`, {
      method: 'POST',
      headers: headers(REP_PRI),
      body: '{}',
    });
    const vetsLog = (await repo.getClub('dolphins', 'vets'))!.commLog ?? [];
    assert.ok(
      vetsLog.some(
        (e) => e.kind === 'veterans-request-accepted' && e.idempotencyKey.includes(created.id),
      ),
      'veterans club has a veterans-request-accepted comm event',
    );
  });
});

describe('erasure enumerates both directions', () => {
  test('erasing a veterans club deletes the mirror AND the counterpart canonical', async () => {
    for (const [id, name] of [
      ['evets', 'Erase Vets CC'],
      ['epri', 'Erase Primary CC'],
    ] as const) {
      await repo.createClub('dolphins', mkClub(id, name));
    }
    await repo.putSeries('dolphins', {
      id: 's-vets-erase',
      name: 'Veterans · Erase',
      leagueKey: 'veterans',
      startDate: '2026-06-02',
      teams: ['evets', 'epri'],
      participants: [
        { teamId: 'evets', clubId: 'evets', name: 'Erase Vets CC' },
        { teamId: 'epri', clubId: 'epri', name: 'Erase Primary CC' },
      ],
      fixtures: [],
      approved: true,
      approvedAt: '2026-05-01T00:00:00.000Z',
      released: true,
      releasedAt: '2026-05-15T00:00:00.000Z',
      version: 1,
    } as never);
    await repo.createPlayer('dolphins', mkPlayer('epri', 'ERAS5001', 'Erase', 'Me'));
    const REP_EVETS = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['evets'] }]);
    const candidateId = await candidateIdFor2('Erase Me', 'Erase Me', REP_EVETS, 'evets');
    const created = (await (
      await createRequest({ primaryClubId: 'epri', candidateId }, REP_EVETS, 'evets')
    ).json()) as { id: string };

    // Sanity: both rows exist.
    assert.ok(await repo.getVeteransRequest('dolphins', 'epri', created.id));
    assert.ok(await repo.getOutboundVeteransRequest('dolphins', 'evets', created.id));

    // Erase the VETERANS club → its mirror AND the counterpart canonical under epri go.
    const evetsClub = (await repo.getClub('dolphins', 'evets'))!;
    await repo.eraseClubData('dolphins', evetsClub);
    assert.equal(await repo.getOutboundVeteransRequest('dolphins', 'evets', created.id), null);
    assert.equal(await repo.getVeteransRequest('dolphins', 'epri', created.id), null);
  });

  test('erasing the primary club deletes the canonical AND the counterpart mirror', async () => {
    for (const [id, name] of [
      ['epri2', 'Erase Primary Two CC'],
      ['evets2', 'Erase Vets Two CC'],
    ] as const) {
      await repo.createClub('dolphins', mkClub(id, name));
    }
    // Write both rows directly (no finder gate needed to exercise erasure).
    const request = {
      id: 'req-erase-primary',
      playerNaturalKey: 'nk-erase',
      candidateId: 'cand-erase',
      playerName: 'Erased Primary',
      primaryClubId: 'epri2',
      primaryClubName: 'Erase Primary Two CC',
      veteransClubId: 'evets2',
      veteransClubName: 'Erase Vets Two CC',
      requestedAt: '2026-06-03T00:00:00.000Z',
      status: 'pending' as const,
      version: 0,
    };
    await repo.createVeteransRequest('dolphins', request);
    assert.ok(await repo.getVeteransRequest('dolphins', 'epri2', request.id));
    assert.ok(await repo.getOutboundVeteransRequest('dolphins', 'evets2', request.id));

    const epri2Club = (await repo.getClub('dolphins', 'epri2'))!;
    await repo.eraseClubData('dolphins', epri2Club);
    assert.equal(await repo.getVeteransRequest('dolphins', 'epri2', request.id), null);
    assert.equal(await repo.getOutboundVeteransRequest('dolphins', 'evets2', request.id), null);
  });
});

// A finder helper scoped to an arbitrary requesting club/auth (for the erasure test's evets club).
async function candidateIdFor2(
  q: string,
  playerName: string,
  auth: string,
  club: string,
): Promise<string> {
  const r = await app.request(`/clubs/${club}/veterans-candidates?q=${encodeURIComponent(q)}`, {
    headers: headers(auth),
  });
  const b = (await r.json()) as { candidates: { candidateId: string; playerName: string }[] };
  const c = b.candidates.find((x) => x.playerName === playerName);
  assert.ok(c, `finder should surface ${playerName}`);
  return c!.candidateId;
}
