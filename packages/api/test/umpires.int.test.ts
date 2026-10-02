/**
 * Integration tests for umpire allocation: the tenant umpire registry (GET/POST/PATCH
 * /umpires, POST /umpires/:id/merge) and per-fixture appointments
 * (PUT /series/:id/fixtures/:fixtureId/officials, joined into GET /series).
 *
 * Appointments are their own FIXOFFICIALS# items — writing them must leave the series
 * version and approval untouched — and club reps see them only on their own fixtures, and
 * only once the venue is visible to them.
 *
 * Same harness as in-season-clash-gate.int.test.ts: in-process dynalite + the REAL Hono app
 * via app.request(); dev-auth bypass (LOCAL_AUTH=1), an ADMIN and a REP scoped to 'home-club'.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Series } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4661; // next free even port after 4659
const TABLE = 'SmartClubUmpiresTest';
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

const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
const ADMIN = devAuth('admin@test', [{ tenantId: 'dolphins', role: 'admin', clubIds: [] }]);
const REP = devAuth('rep@test', [{ tenantId: 'dolphins', role: 'rep', clubIds: ['home-club'] }]);
const headers = (auth: string) => ({
  'x-tenant': 'dolphins',
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

type Fixture = Record<string, unknown> & { id: string };
type Officials = { umpires: Array<{ umpireId: string; name: string }>; updatedBy?: string };

const series = (id: string, over: Partial<Series> = {}): Series =>
  ({
    id,
    name: `Series ${id}`,
    leagueKey: 'premier',
    startDate: '2026-10-04',
    teams: ['home-club', 'away-club', 'other-club'],
    participants: [
      { teamId: 'home-club', clubId: 'home-club', name: 'Home Club' },
      { teamId: 'away-club', clubId: 'away-club', name: 'Away Club' },
      { teamId: 'other-club', clubId: 'other-club', name: 'Other Club' },
    ],
    fixtures: [
      {
        id: 'f1',
        round: 1,
        date: '2026-10-04',
        time: '09:00',
        home: 'home-club',
        away: 'away-club',
      },
      {
        id: 'f2',
        round: 1,
        date: '2026-10-04',
        time: '09:00',
        home: 'away-club',
        away: 'other-club',
      },
    ],
    kind: 'series',
    approved: true,
    approvedAt: '2026-09-01T00:00:00.000Z',
    released: false,
    releasedAt: null,
    version: 3,
    ...over,
  }) as Series;

const call = (method: string, path: string, body?: unknown, auth = ADMIN) =>
  app.request(path, {
    method,
    headers: headers(auth),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const createUmpire = async (body: Record<string, unknown>) => {
  const res = await call('POST', '/umpires', body);
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as { id: string; aliases: string[] };
};

const seriesFromGet = async (id: string, auth = ADMIN) => {
  const res = await call('GET', '/series', undefined, auth);
  assert.equal(res.status, 200);
  return ((await res.json()) as Series[]).find((s) => s.id === id);
};

const fixtureOf = (s: Series | undefined, fid: string) =>
  (s?.fixtures as Fixture[] | undefined)?.find((f) => f.id === fid);

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');

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

  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');
});

after(() => new Promise<void>((resolve) => ddbServer.close(() => resolve())));

describe('umpire registry', () => {
  test('admin creates an umpire with normalised aliases; a second entry for the same name is 409', async () => {
    const u = await createUmpire({ displayName: ' A.Ngubane ', phone: '0820000001' });
    assert.equal(u.id, 'u-a-ngubane');
    assert.deepEqual(u.aliases, ['angubane']);
    const dup = await call('POST', '/umpires', { displayName: 'A. Ngubane' });
    assert.equal(dup.status, 409);
    const body = (await dup.json()) as { code: string; umpireId: string };
    assert.equal(body.code, 'umpire_alias_taken');
    assert.equal(body.umpireId, 'u-a-ngubane');
  });

  test('a club rep sees names only — never contacts — and cannot write', async () => {
    await createUmpire({ displayName: 'B.Tyali', phone: '0820000002', email: 'bt@example.org' });
    const asAdmin = (await (await call('GET', '/umpires')).json()) as Array<
      Record<string, unknown>
    >;
    assert.equal(asAdmin.find((u) => u.displayName === 'B.Tyali')?.phone, '0820000002');

    const repRes = await call('GET', '/umpires', undefined, REP);
    assert.equal(repRes.status, 200);
    const asRep = (await repRes.json()) as Array<Record<string, unknown>>;
    const bt = asRep.find((u) => u.displayName === 'B.Tyali');
    assert.deepEqual(Object.keys(bt!).sort(), ['displayName', 'id']);
    assert.ok(asRep.every((u) => !('phone' in u) && !('email' in u) && !('aliases' in u)));

    assert.equal((await call('POST', '/umpires', { displayName: 'X.Y' }, REP)).status, 403);
    assert.equal((await call('PATCH', '/umpires/u-b-tyali', { phone: '1' }, REP)).status, 403);
    assert.equal(
      (await call('POST', '/umpires/u-b-tyali/merge', { targetId: 'u-a-ngubane' }, REP)).status,
      403,
    );
  });

  test('PATCH edits contacts, keeps the old spelling as an alias on rename, and deactivates', async () => {
    await createUmpire({ displayName: 'C.Patch' });
    const res = await call('PATCH', '/umpires/u-c-patch', {
      displayName: 'C. Patchett',
      email: 'cp@example.org',
    });
    assert.equal(res.status, 200);
    const u = (await res.json()) as { displayName: string; aliases: string[]; email: string };
    assert.equal(u.displayName, 'C. Patchett');
    assert.equal(u.email, 'cp@example.org');
    assert.ok(u.aliases.includes('cpatch') && u.aliases.includes('cpatchett'));

    const off = await call('PATCH', '/umpires/u-c-patch', { active: false });
    assert.equal(((await off.json()) as { active: boolean }).active, false);
    // Inactive umpires drop out of the rep listing.
    const asRep = (await (await call('GET', '/umpires', undefined, REP)).json()) as Array<{
      id: string;
    }>;
    assert.ok(!asRep.some((x) => x.id === 'u-c-patch'));
  });

  test('bad input is a 400', async () => {
    assert.equal((await call('POST', '/umpires', {})).status, 400);
    assert.equal((await call('POST', '/umpires', { displayName: '...' })).status, 400);
    assert.equal(
      (await call('POST', '/umpires', { displayName: 'D.Mail', email: 'nope' })).status,
      400,
    );
    assert.equal((await call('PATCH', '/umpires/missing', { phone: '1' })).status, 404);
  });
});

describe('fixture officials', () => {
  test('more than two umpires is a 400, and so is an unknown umpire', async () => {
    await repo.putSeries('dolphins', series('s-over'));
    await createUmpire({ displayName: 'E.One' });
    await createUmpire({ displayName: 'E.Two' });
    await createUmpire({ displayName: 'E.Three' });
    const three = await call('PUT', '/series/s-over/fixtures/f1/officials', {
      umpires: [{ umpireId: 'u-e-one' }, { umpireId: 'u-e-two' }, { umpireId: 'u-e-three' }],
    });
    assert.equal(three.status, 400);
    assert.match(((await three.json()) as { error: string }).error, /at most 2/);
    const unknown = await call('PUT', '/series/s-over/fixtures/f1/officials', {
      umpires: [{ umpireId: 'u-nobody' }],
    });
    assert.equal(unknown.status, 400);
    const dup = await call('PUT', '/series/s-over/fixtures/f1/officials', {
      umpires: ['u-e-one', 'u-e-one'],
    });
    assert.equal(dup.status, 400);
    assert.equal(
      (await call('PUT', '/series/s-over/fixtures/nope/officials', { umpires: [] })).status,
      404,
    );
    assert.equal(
      (await call('PUT', '/series/s-missing/fixtures/f1/officials', { umpires: [] })).status,
      404,
    );
    assert.equal(
      (await call('PUT', '/series/s-over/fixtures/f1/officials', { umpires: ['u-e-one'] }, REP))
        .status,
      403,
    );
  });

  test('writing officials leaves the series version, approval and fixtures untouched', async () => {
    await repo.putSeries('dolphins', series('s-ver'));
    await createUmpire({ displayName: 'F.Ver' });
    const before = await repo.getSeries('dolphins', 's-ver');
    const res = await call('PUT', '/series/s-ver/fixtures/f1/officials', {
      umpires: [{ umpireId: 'u-f-ver' }],
    });
    assert.equal(res.status, 200);
    const after = await repo.getSeries('dolphins', 's-ver');
    assert.equal(after!.version, before!.version);
    assert.equal(after!.approved, true);
    assert.deepEqual(after!.fixtures, before!.fixtures);

    const s = await seriesFromGet('s-ver');
    const officials = fixtureOf(s, 'f1')?.officials as Officials;
    assert.deepEqual(officials.umpires, [{ umpireId: 'u-f-ver', name: 'F.Ver' }]);
    assert.equal(officials.updatedBy, 'admin@test');
    assert.equal(fixtureOf(s, 'f2')?.officials, undefined);
  });

  test('a whole-series PATCH echoing the officials join never stores it in the series', async () => {
    const s = await seriesFromGet('s-ver');
    assert.ok(fixtureOf(s, 'f1')?.officials);
    const res = await call('PATCH', '/series/s-ver', { ...s, version: s!.version });
    assert.equal(res.status, 200, await res.clone().text());
    const stored = await repo.getSeries('dolphins', 's-ver');
    assert.ok((stored!.fixtures as Fixture[]).every((f) => !('officials' in f)));
    // …and the appointment itself is still there.
    assert.ok(fixtureOf(await seriesFromGet('s-ver'), 'f1')?.officials);
  });

  test('an empty appointment clears the fixture', async () => {
    const res = await call('PUT', '/series/s-ver/fixtures/f1/officials', { umpires: [] });
    assert.equal(res.status, 200);
    assert.equal(fixtureOf(await seriesFromGet('s-ver'), 'f1')?.officials, undefined);
  });

  test('a club rep sees umpires on its own fixtures only, and only once the venue is shown', async () => {
    await createUmpire({ displayName: 'G.Rep' });
    await repo.putSeries(
      'dolphins',
      series('s-open', { released: true, releasedAt: '2026-09-01T00:00:00.000Z' }),
    );
    await repo.putSeries(
      'dolphins',
      series('s-hidden', {
        released: true,
        releasedAt: '2026-09-01T00:00:00.000Z',
        withheld: { venue: true },
      }),
    );
    for (const sid of ['s-open', 's-hidden'])
      for (const fid of ['f1', 'f2']) {
        const r = await call('PUT', `/series/${sid}/fixtures/${fid}/officials`, {
          umpires: ['u-g-rep'],
        });
        assert.equal(r.status, 200);
      }

    const open = await seriesFromGet('s-open', REP);
    const own = fixtureOf(open, 'f1')?.officials as Officials;
    assert.deepEqual(own.umpires, [{ umpireId: 'u-g-rep', name: 'G.Rep' }]);
    // No audit fields for a club.
    assert.equal(own.updatedBy, undefined);
    // f2 is Away v Other — not the rep's club.
    assert.equal(fixtureOf(open, 'f2')?.officials, undefined);

    const hidden = await seriesFromGet('s-hidden', REP);
    assert.equal(fixtureOf(hidden, 'f1')?.officials, undefined);
    // Admins always see them.
    assert.ok(fixtureOf(await seriesFromGet('s-hidden'), 'f1')?.officials);
  });

  test('deleting a series removes its appointments', async () => {
    await repo.putSeries('dolphins', series('s-del'));
    await createUmpire({ displayName: 'H.Del' });
    await call('PUT', '/series/s-del/fixtures/f1/officials', { umpires: ['u-h-del'] });
    assert.ok(await repo.getFixtureOfficials('dolphins', 's-del', 'f1'));
    assert.equal((await call('DELETE', '/series/s-del')).status, 200);
    assert.equal(await repo.getFixtureOfficials('dolphins', 's-del', 'f1'), null);
  });
});

describe('merge', () => {
  test('re-points every appointment, moves aliases and retires the source', async () => {
    await repo.putSeries('dolphins', series('s-merge'));
    await createUmpire({ displayName: 'S.Gasa' });
    await createUmpire({ displayName: 'Sipho Gasa' });
    await createUmpire({ displayName: 'J.Kok' });
    // f1: the duplicate alongside the real entry — the merge must not appoint one person twice.
    await call('PUT', '/series/s-merge/fixtures/f1/officials', {
      umpires: ['u-sipho-gasa', 'u-s-gasa'],
    });
    await call('PUT', '/series/s-merge/fixtures/f2/officials', {
      umpires: ['u-j-kok', 'u-sipho-gasa'],
    });

    const res = await call('POST', '/umpires/u-sipho-gasa/merge', { targetId: 'u-s-gasa' });
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as {
      repointed: number;
      target: { aliases: string[] };
      source: { active: boolean; mergedInto: string; aliases: string[] };
    };
    assert.equal(body.repointed, 2);
    assert.ok(body.target.aliases.includes('siphogasa'));
    assert.equal(body.source.active, false);
    assert.equal(body.source.mergedInto, 'u-s-gasa');
    assert.deepEqual(body.source.aliases, []);

    const f1 = await repo.getFixtureOfficials('dolphins', 's-merge', 'f1');
    assert.deepEqual(
      f1!.umpires.map((u) => u.umpireId),
      ['u-s-gasa'],
    );
    const f2 = await repo.getFixtureOfficials('dolphins', 's-merge', 'f2');
    assert.deepEqual(
      f2!.umpires.map((u) => u.umpireId),
      ['u-j-kok', 'u-s-gasa'],
    );

    // Re-running finds nothing to re-point.
    const again = await call('POST', '/umpires/u-sipho-gasa/merge', { targetId: 'u-s-gasa' });
    assert.equal(((await again.json()) as { repointed: number }).repointed, 0);
    // A merged entry can't come back.
    assert.equal((await call('PATCH', '/umpires/u-sipho-gasa', { active: true })).status, 409);
    assert.equal(
      (await call('POST', '/umpires/u-s-gasa/merge', { targetId: 'u-s-gasa' })).status,
      400,
    );
  });
});
