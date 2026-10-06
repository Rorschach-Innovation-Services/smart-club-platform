/**
 * Integration tests for fixture postponement negotiation (ADR 0015) — open / counter / accept
 * (auto-apply through applySeriesPatch) / decline / withdraw / admin override + acknowledge, the
 * accept-path atomicity rules (baseline `fixture_changed`, clash + team-busy refusal keeps the
 * request open, idempotent accept, version-race retry that re-reads and re-checks), mirror
 * consistency and the TTL. Boots an in-process dynalite behind a tiny HTTP proxy — the proxy lets a
 * test interleave a concurrent series write at the exact moment the accept path patches, which is
 * the only deterministic way to drive the retry path through the real app.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';

const DDB_PORT = 4679; // dynalite (next free odd port after chair-roster's 4677)
const PROXY_PORT = 4680; // the interleaving proxy the app talks to
const TABLE = 'SmartClubTest';
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${PROXY_PORT}`;
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
const REP_HOME = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['home'] }]);
const REP_AWAY = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['away'] }]);
const REP_THIRD = devAuth([{ tenantId: 'dolphins', role: 'rep', clubIds: ['third'] }]);

const headers = (auth: string) => ({
  'x-tenant': 'dolphins',
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

// Dates relative to the tenant's today (UTC+2) so "future" checks hold whenever the suite runs.
const DAY = 24 * 60 * 60 * 1000;
const d = (n: number) =>
  new Date(Date.now() + 2 * 60 * 60 * 1000 + n * DAY).toISOString().slice(0, 10);

const SERIES_PK = 'TENANT#dolphins#SERIES#s-main';

let ddbServer: Server;
let proxy: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let raw: import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
let GetCommand: typeof import('@aws-sdk/lib-dynamodb').GetCommand;
let PutCommand: typeof import('@aws-sdk/lib-dynamodb').PutCommand;

/** One-shot hook: runs right BEFORE the next conditional Put of the s-main series reaches dynalite. */
let interleave: null | (() => Promise<void>) = null;

const mkClub = (id: string, name: string, ground: string) => ({
  id,
  name,
  district: 'Test District',
  sub: `sub-${id}`,
  chair: 'Chair',
  exco: { chair: { name: `${name} Chair`, email: `chair@${id}.test`, cell: '0821234567' } },
  affiliation: 'not_started' as const,
  cqi: 0,
  docs: {},
  players: 0,
  teams: 0,
  women: 0,
  juniors: 0,
  color: '#123456',
  ground: { venue: ground },
  leagues: [],
  version: 1,
});

const participants = [
  { teamId: 'home', clubId: 'home', name: 'Glenwood CC' },
  { teamId: 'away', clubId: 'away', name: 'Northlands CC' },
  { teamId: 'third', clubId: 'third', name: 'Third CC' },
  { teamId: 'fourth', clubId: 'fourth', name: 'Fourth CC' },
];

const fx = (id: string, date: string, extra: Record<string, unknown> = {}) => ({
  id,
  round: 1,
  date,
  time: '10:00',
  home: 'home',
  away: 'away',
  ...extra,
});

const mkSeries = (id: string, fixtures: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  name: `Series ${id}`,
  startDate: d(1),
  teams: ['home', 'away', 'third', 'fourth'],
  participants,
  fixtures,
  approved: true,
  approvedAt: '2026-05-01T00:00:00.000Z',
  released: true,
  releasedAt: '2026-05-15T00:00:00.000Z',
  version: 1,
  ...extra,
});

before(async () => {
  const dynalite = (await import('dynalite')).default as (opts?: unknown) => Server;
  ddbServer = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => ddbServer.listen(DDB_PORT, resolve));

  // The proxy forwards every request to dynalite untouched, but fires the armed `interleave`
  // hook first when it sees the accept path's version-conditioned Put of the s-main series.
  proxy = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      if (interleave && req.headers['x-amz-target'] === 'DynamoDB_20120810.PutItem') {
        const parsed = JSON.parse(body.toString()) as {
          Item?: { pk?: { S?: string } };
          ConditionExpression?: string;
        };
        if (parsed.Item?.pk?.S === SERIES_PK && parsed.ConditionExpression?.includes('version')) {
          const hook = interleave;
          interleave = null;
          await hook();
        }
      }
      const fwd = http.request(
        {
          host: 'localhost',
          port: DDB_PORT,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (r) => {
          res.writeHead(r.statusCode ?? 500, r.headers);
          r.pipe(res);
        },
      );
      fwd.end(body);
    });
  });
  await new Promise<void>((resolve) => proxy.listen(PROXY_PORT, resolve));

  const { DynamoDBClient, CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  const lib = await import('@aws-sdk/lib-dynamodb');
  ({ GetCommand, PutCommand } = lib);
  const direct = new DynamoDBClient({
    endpoint: `http://localhost:${DDB_PORT}`,
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  raw = lib.DynamoDBDocumentClient.from(direct, {
    marshallOptions: { removeUndefinedValues: true },
  });
  await direct.send(
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

  for (const [id, name, ground] of [
    ['home', 'Glenwood CC', 'Glenwood Oval'],
    ['away', 'Northlands CC', 'Northlands Park'],
    ['third', 'Third CC', 'Third Field'],
    ['fourth', 'Fourth CC', 'Fourth Field'],
  ] as const) {
    await repo.createClub('dolphins', mkClub(id, name, ground) as never);
  }

  // The fixtures under test — home v away throughout, one per scenario, on distinct dates so a
  // move never collides with a sibling unless a test arranges it.
  await repo.putSeries(
    'dolphins',
    mkSeries('s-main', [
      fx('f1', d(14)),
      fx('f2', d(15)),
      fx('f3', d(16)),
      fx('f4', d(17)),
      fx('f5', d(18)),
      fx('f6', d(19)),
      fx('f7', d(20)),
      fx('f8', d(21)),
      fx('f9', d(22), { home: 'third', away: 'fourth' }),
      fx('f10', d(23)),
      fx('f11', d(24)),
      fx('f12', d(-3)),
      fx('f13', d(25), { status: 'cancelled' }),
      fx('f14', d(26), { home: 'third', away: 'fourth' }),
    ]) as never,
  );
  // Another released series: a ground booking at the home club's ground (o2) and a day the away
  // side already plays (o1).
  await repo.putSeries(
    'dolphins',
    mkSeries('s-other', [
      fx('o1', d(67), { home: 'away', away: 'fourth' }),
      fx('o2', d(65), { home: 'third', away: 'fourth', venueOverride: 'Glenwood Oval' }),
    ]) as never,
  );
  // A released series withholding kick-off times, and an unreleased draft.
  await repo.putSeries(
    'dolphins',
    mkSeries('s-wt', [fx('w1', d(30))], { withheld: { time: true } }) as never,
  );
  await repo.putSeries(
    'dolphins',
    mkSeries('s-draft', [fx('x1', d(31))], {
      released: false,
      releasedAt: null,
      approved: false,
    }) as never,
  );
});

after(() => {
  proxy?.close();
  ddbServer?.close();
});

const call = (path: string, auth: string, body?: unknown, method = 'POST') =>
  app.request(path, {
    method,
    headers: headers(auth),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

type Req = import('../src/types.js').PostponementRequest;

async function open(fixtureId: string, proposedDate: string, extra: Record<string, unknown> = {}) {
  const res = await call('/clubs/home/postponements', REP_HOME, {
    seriesId: 's-main',
    fixtureId,
    proposedDate,
    ...extra,
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as Req;
}

const fixtureOf = async (seriesId: string, fixtureId: string) => {
  const s = await repo.getSeries('dolphins', seriesId);
  return (s!.fixtures as Array<Record<string, unknown>>).find((f) => f.id === fixtureId)!;
};

/** Canonical and mirror rows are identical after every transition (one transaction). */
async function assertMirrorConsistent(r: Pick<Req, 'id' | 'opposingClubId' | 'requestingClubId'>) {
  const canonical = await repo.getPostponement('dolphins', r.opposingClubId, r.id);
  const mirror = await repo.getOutboundPostponement('dolphins', r.requestingClubId, r.id);
  assert.ok(canonical && mirror);
  assert.deepEqual(mirror, canonical);
  return canonical!;
}

test('open: validation, participation, derived opposing club, one open request per fixture', async () => {
  // Not a participant.
  let res = await call('/clubs/third/postponements', REP_THIRD, {
    seriesId: 's-main',
    fixtureId: 'f1',
    proposedDate: d(61),
  });
  assert.equal(res.status, 403);
  // A rep cannot act for another club.
  res = await call('/clubs/away/postponements', REP_HOME, {
    seriesId: 's-main',
    fixtureId: 'f1',
    proposedDate: d(61),
  });
  assert.equal(res.status, 403);
  // Draft series 404s like a missing one.
  res = await call('/clubs/home/postponements', REP_HOME, {
    seriesId: 's-draft',
    fixtureId: 'x1',
    proposedDate: d(61),
  });
  assert.equal(res.status, 404);
  // Bad / past dates.
  for (const proposedDate of ['2026-02-31', 'tomorrow', d(0), d(-1)]) {
    res = await call('/clubs/home/postponements', REP_HOME, {
      seriesId: 's-main',
      fixtureId: 'f1',
      proposedDate,
    });
    assert.equal(res.status, 400, proposedDate);
  }
  // Past fixture / cancelled fixture.
  res = await call('/clubs/home/postponements', REP_HOME, {
    seriesId: 's-main',
    fixtureId: 'f12',
    proposedDate: d(61),
  });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, 'fixture_past');
  res = await call('/clubs/home/postponements', REP_HOME, {
    seriesId: 's-main',
    fixtureId: 'f13',
    proposedDate: d(61),
  });
  assert.equal(((await res.json()) as { code: string }).code, 'fixture_cancelled');

  // A time on a series that withholds times is refused; a date-only proposal is fine and the
  // club-facing request carries no time snapshot.
  res = await call('/clubs/home/postponements', REP_HOME, {
    seriesId: 's-wt',
    fixtureId: 'w1',
    proposedDate: d(61),
    proposedTime: '14:00',
  });
  assert.equal(res.status, 400);
  res = await call('/clubs/home/postponements', REP_HOME, {
    seriesId: 's-wt',
    fixtureId: 'w1',
    proposedDate: d(61),
  });
  assert.equal(res.status, 201);
  const wt = (await res.json()) as Req;
  assert.equal(wt.originalTime, undefined);

  // Happy open: opposing club derived from the fixture, body cannot steer it.
  const r = await open('f1', d(61), { opposingClubId: 'third', proposedTime: '13:00' });
  assert.equal(r.requestingClubId, 'home');
  assert.equal(r.opposingClubId, 'away');
  assert.equal(r.originalDate, d(14));
  assert.equal(r.originalTime, '10:00');
  assert.equal(r.awaiting, 'opposing');
  assert.equal(r.status, 'open');
  assert.deepEqual(
    r.proposals.map((p) => [p.by, p.date, p.time]),
    [['requesting', d(61), '13:00']],
  );
  await assertMirrorConsistent(r);

  // A second open request for the same fixture — from EITHER club — is refused.
  for (const [club, auth] of [
    ['home', REP_HOME],
    ['away', REP_AWAY],
  ] as const) {
    res = await call(`/clubs/${club}/postponements`, auth, {
      seriesId: 's-main',
      fixtureId: 'f1',
      proposedDate: d(62),
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, 'postponement_exists');
  }

  // The opposing chair was emailed (dry-run) and the comm log records it.
  const awayLog = (await repo.getClub('dolphins', 'away'))!.commLog ?? [];
  assert.ok(awayLog.some((e) => e.kind === 'postponement-request' && e.to === 'chair@away.test'));
});

test('accept applies through applySeriesPatch: status postponed, originalDate, postponementId', async () => {
  const listed = (await (
    await call('/clubs/away/postponements', REP_AWAY, undefined, 'GET')
  ).json()) as {
    inbound: Req[];
    outbound: Req[];
  };
  const r = listed.inbound.find((x) => x.fixtureId === 'f1')!;
  assert.ok(r);
  // The requesting side cannot accept its own proposal.
  let res = await call(`/clubs/home/postponements/${r.id}/accept`, REP_HOME, {});
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, 'not_your_turn');
  // Stale version is refused before the fixture moves.
  res = await call(`/clubs/away/postponements/${r.id}/accept`, REP_AWAY, { version: 99 });
  assert.equal(((await res.json()) as { code: string }).code, 'version_conflict');
  assert.equal((await fixtureOf('s-main', 'f1')).date, d(14));

  const before = (await repo.getSeries('dolphins', 's-main'))!.version;
  res = await call(`/clubs/away/postponements/${r.id}/accept`, REP_AWAY, { version: r.version });
  assert.equal(res.status, 200, await res.clone().text());
  const accepted = (await res.json()) as Req;
  assert.equal(accepted.status, 'applied');
  assert.equal(accepted.awaiting, 'none');
  assert.equal(accepted.resolvedVia, 'portal');

  const f1 = await fixtureOf('s-main', 'f1');
  assert.equal(f1.date, d(61));
  assert.equal(f1.time, '13:00');
  assert.equal(f1.status, 'postponed');
  assert.equal(f1.originalDate, d(14));
  assert.equal(f1.postponementId, r.id);
  assert.equal((await repo.getSeries('dolphins', 's-main'))!.version, before + 1);

  const stored = await assertMirrorConsistent(r);
  // TTL: 90 days past resolution, epoch seconds.
  assert.equal(
    stored.expiresAt,
    Math.floor(Date.parse(stored.resolvedAt!) / 1000) + 90 * 24 * 60 * 60,
  );
  // Both chairs heard about it.
  for (const club of ['home', 'away']) {
    const log = (await repo.getClub('dolphins', club))!.commLog ?? [];
    assert.ok(
      log.some((e) => e.kind === 'postponement-agreed'),
      club,
    );
  }
  // A second accept on the now-terminal request is refused.
  res = await call(`/clubs/away/postponements/${r.id}/accept`, REP_AWAY, {});
  assert.equal(((await res.json()) as { code: string }).code, 'postponement_closed');
});

test('admin may override an applied request; originalDate keeps the first schedule; chairs acknowledge', async () => {
  const all = (await (
    await call('/admin/postponements?status=applied', ADMIN, undefined, 'GET')
  ).json()) as Req[];
  const r = all.find((x) => x.fixtureId === 'f1')!;
  assert.ok(r);
  // Reps cannot reach the admin routes.
  assert.equal((await call('/admin/postponements', REP_HOME, undefined, 'GET')).status, 403);
  assert.equal(
    (await call(`/admin/postponements/${r.id}/override`, REP_HOME, { date: d(62) })).status,
    403,
  );
  // Acknowledge is only for admin rulings.
  let res = await call(`/clubs/home/postponements/${r.id}/acknowledge`, REP_HOME, {});
  assert.equal(((await res.json()) as { code: string }).code, 'postponement_closed');

  res = await call(`/admin/postponements/${r.id}/override`, ADMIN, {
    date: d(62),
    time: '12:00',
    venueName: 'Kings Park',
    note: 'Union ruling',
  });
  assert.equal(res.status, 200, await res.clone().text());
  const ruled = (await res.json()) as Req;
  assert.equal(ruled.status, 'admin-final');
  assert.equal(ruled.resolvedVia, 'admin');
  assert.deepEqual(ruled.acknowledgements, {});
  const last = ruled.proposals[ruled.proposals.length - 1];
  assert.equal(last.by, 'admin');
  assert.equal(last.venueName, 'Kings Park');

  const f1 = await fixtureOf('s-main', 'f1');
  assert.equal(f1.date, d(62));
  assert.equal(f1.time, '12:00');
  assert.equal(f1.venueOverride, 'Kings Park');
  assert.equal(f1.originalDate, d(14), 'only-if-absent: still the first schedule');
  await assertMirrorConsistent(r);

  for (const [club, auth] of [
    ['home', REP_HOME],
    ['away', REP_AWAY],
  ] as const) {
    res = await call(`/clubs/${club}/postponements/${r.id}/acknowledge`, auth, {});
    assert.equal(res.status, 200);
  }
  // Idempotent per club.
  res = await call(`/clubs/home/postponements/${r.id}/acknowledge`, REP_HOME, {});
  assert.equal(res.status, 200);
  const acked = await assertMirrorConsistent(r);
  assert.deepEqual(Object.keys(acked.acknowledgements ?? {}).sort(), ['away', 'home']);
  for (const club of ['home', 'away']) {
    const log = (await repo.getClub('dolphins', club))!.commLog ?? [];
    assert.ok(
      log.some((e) => e.kind === 'postponement-admin-final'),
      club,
    );
  }
});

test('counter: turn enforcement, version conflict, decline by the opposing side only', async () => {
  const r = await open('f2', d(63));
  // Requesting side cannot counter while the opposing side is awaited.
  let res = await call(`/clubs/home/postponements/${r.id}/counter`, REP_HOME, {
    proposedDate: d(64),
  });
  assert.equal(((await res.json()) as { code: string }).code, 'not_your_turn');
  res = await call(`/clubs/away/postponements/${r.id}/counter`, REP_AWAY, {
    proposedDate: d(64),
    proposedTime: '11:30',
    note: 'Ground booked',
    version: r.version,
  });
  assert.equal(res.status, 200, await res.clone().text());
  const countered = (await res.json()) as Req;
  assert.equal(countered.awaiting, 'requesting');
  assert.equal(countered.proposals.length, 2);
  assert.equal(countered.proposals[1].by, 'opposing');
  await assertMirrorConsistent(r);
  // Now the opposing side has to wait.
  res = await call(`/clubs/away/postponements/${r.id}/counter`, REP_AWAY, { proposedDate: d(66) });
  assert.equal(((await res.json()) as { code: string }).code, 'not_your_turn');
  // Stale version from the requesting side.
  res = await call(`/clubs/home/postponements/${r.id}/counter`, REP_HOME, {
    proposedDate: d(66),
    version: r.version,
  });
  assert.equal(((await res.json()) as { code: string }).code, 'version_conflict');
  const homeLog = (await repo.getClub('dolphins', 'home'))!.commLog ?? [];
  assert.ok(homeLog.some((e) => e.kind === 'postponement-counter'));

  // Only the opposing club may decline; the requesting club withdraws instead.
  res = await call(`/clubs/home/postponements/${r.id}/decline`, REP_HOME, {});
  assert.equal(res.status, 403);
  res = await call(`/clubs/away/postponements/${r.id}/decline`, REP_AWAY, {
    declineReason: 'No other date works',
  });
  assert.equal(res.status, 200);
  const declined = await assertMirrorConsistent(r);
  assert.equal(declined.status, 'declined');
  assert.equal(declined.declineReason, 'No other date works');
  assert.ok(declined.expiresAt);
  assert.equal((await fixtureOf('s-main', 'f2')).date, d(15), 'a decline never moves the fixture');
});

test('accept refused on a ground clash: 409 venue_clash, request stays open; admin override is clash-gated', async () => {
  const r = await open('f3', d(65), { proposedTime: '10:00' });
  let res = await call(`/clubs/away/postponements/${r.id}/accept`, REP_AWAY, {});
  assert.equal(res.status, 409);
  const body = (await res.json()) as {
    code: string;
    clashes: Array<{ date: string; ground?: string; with?: { seriesId: string } }>;
  };
  assert.equal(body.code, 'venue_clash');
  assert.equal(body.clashes.length, 1);
  assert.equal(body.clashes[0].with?.seriesId, 's-other');
  const still = await assertMirrorConsistent(r);
  assert.equal(still.status, 'open');
  assert.equal(still.awaiting, 'opposing');
  assert.equal((await fixtureOf('s-main', 'f3')).date, d(16));

  // The admin override goes through the standard gate — the same clash surfaces in full.
  res = await call(`/admin/postponements/${r.id}/override`, ADMIN, { date: d(65), time: '10:00' });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, 'venue_clash');
  res = await call(`/admin/postponements/${r.id}/override`, ADMIN, { date: d(66) });
  assert.equal(res.status, 200);
  const f3 = await fixtureOf('s-main', 'f3');
  assert.equal(f3.date, d(66));
  assert.equal(f3.time, '10:00', 'no time in the ruling keeps the kick-off');
  assert.equal(f3.status, 'postponed');
  assert.equal(f3.originalDate, d(16));
});

test('accept refused when a side is already busy that day (team-busy), request stays open', async () => {
  const r = await open('f4', d(67));
  const res = await call(`/clubs/away/postponements/${r.id}/accept`, REP_AWAY, {});
  assert.equal(res.status, 409);
  const body = (await res.json()) as {
    code: string;
    clashes: unknown[];
    teamBusy: Array<{ side: string; with?: { seriesId: string } }>;
  };
  assert.equal(body.code, 'venue_clash');
  assert.deepEqual(body.clashes, []);
  assert.deepEqual(
    body.teamBusy.map((t) => [t.side, t.with?.seriesId]),
    [['away', 's-other']],
  );
  assert.equal((await assertMirrorConsistent(r)).status, 'open');
  assert.equal((await fixtureOf('s-main', 'f4')).date, d(17));
});

test('accept refused with fixture_changed when an admin edit moved the fixture after the request opened', async () => {
  const r = await open('f5', d(68));
  const series = (await repo.getSeries('dolphins', 's-main'))!;
  const fixtures = (series.fixtures as Array<Record<string, unknown>>).map((f) =>
    f.id === 'f5' ? { ...f, date: d(69) } : f,
  );
  const patched = await call(
    '/series/s-main',
    ADMIN,
    { fixtures, version: series.version },
    'PATCH',
  );
  assert.equal(patched.status, 200, await patched.clone().text());
  const res = await call(`/clubs/away/postponements/${r.id}/accept`, REP_AWAY, {});
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, 'fixture_changed');
  assert.equal((await assertMirrorConsistent(r)).status, 'open');
  assert.equal((await fixtureOf('s-main', 'f5')).date, d(69));
});

test('idempotent accept: a fixture already carrying the move is terminalized without re-patching', async () => {
  const r = await open('f6', d(70));
  // Simulate "the series patch landed but the terminalize failed".
  const series = (await repo.getSeries('dolphins', 's-main'))!;
  const fixtures = (series.fixtures as Array<Record<string, unknown>>).map((f) =>
    f.id === 'f6'
      ? { ...f, date: d(70), status: 'postponed', originalDate: d(19), postponementId: r.id }
      : f,
  );
  await repo.updateSeries('dolphins', 's-main', { fixtures, version: series.version });
  const version = (await repo.getSeries('dolphins', 's-main'))!.version;
  const res = await call(`/clubs/away/postponements/${r.id}/accept`, REP_AWAY, {});
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(((await res.json()) as Req).status, 'applied');
  assert.equal((await repo.getSeries('dolphins', 's-main'))!.version, version, 'no second patch');
  await assertMirrorConsistent(r);
});

test('withdraw: requesting side only; the counterpart is told', async () => {
  const r = await open('f7', d(71));
  let res = await call(`/clubs/away/postponements/${r.id}/withdraw`, REP_AWAY, {});
  assert.equal(res.status, 403);
  res = await call(`/clubs/home/postponements/${r.id}/withdraw`, REP_HOME, {});
  assert.equal(res.status, 200);
  assert.equal((await assertMirrorConsistent(r)).status, 'withdrawn');
  const awayLog = (await repo.getClub('dolphins', 'away'))!.commLog ?? [];
  assert.ok(awayLog.some((e) => e.kind === 'postponement-withdrawn'));
  // Withdrawn requests cannot be ruled on; a new request for the fixture may open.
  res = await call(`/admin/postponements/${r.id}/override`, ADMIN, { date: d(72) });
  assert.equal(((await res.json()) as { code: string }).code, 'postponement_closed');
  await open('f7', d(73));
});

/** Bump the stored s-main version with an unrelated concurrent edit (direct to dynalite). */
async function concurrentSeriesEdit(mutate: (fixtures: Array<Record<string, unknown>>) => void) {
  const got = await raw.send(
    new GetCommand({ TableName: TABLE, Key: { pk: SERIES_PK, sk: 'META' } }),
  );
  const item = got.Item as Record<string, unknown> & {
    fixtures: Array<Record<string, unknown>>;
    version: number;
  };
  mutate(item.fixtures);
  item.version += 1;
  await raw.send(new PutCommand({ TableName: TABLE, Item: item }));
}

test('version race: accept re-reads the series and re-patches without clobbering the concurrent edit', async () => {
  const r = await open('f8', d(74));
  interleave = () =>
    concurrentSeriesEdit((fixtures) => {
      const f9 = fixtures.find((f) => f.id === 'f9')!;
      f9.time = '15:30';
    });
  const res = await call(`/clubs/away/postponements/${r.id}/accept`, REP_AWAY, {});
  assert.equal(interleave, null, 'the concurrent edit fired');
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await fixtureOf('s-main', 'f8')).date, d(74));
  assert.equal((await fixtureOf('s-main', 'f9')).time, '15:30', 'the concurrent edit survives');
  assert.equal((await assertMirrorConsistent(r)).status, 'applied');
});

test('version race: the retry re-runs the team-busy check against the re-read series', async () => {
  const r = await open('f10', d(75));
  // The concurrent edit moves another home-v-away fixture onto the proposed day.
  interleave = () =>
    concurrentSeriesEdit((fixtures) => {
      fixtures.find((f) => f.id === 'f11')!.date = d(75);
    });
  const res = await call(`/clubs/away/postponements/${r.id}/accept`, REP_AWAY, {});
  assert.equal(res.status, 409);
  const body = (await res.json()) as { code: string; teamBusy: Array<{ side: string }> };
  assert.equal(body.code, 'venue_clash');
  assert.deepEqual(body.teamBusy.map((t) => t.side).sort(), ['away', 'home']);
  assert.equal((await fixtureOf('s-main', 'f10')).date, d(23), 'no stale patch was sent');
  assert.equal((await assertMirrorConsistent(r)).status, 'open');
});

test('admin list: one row per request, newest first, status filter validated', async () => {
  const res = await call('/admin/postponements', ADMIN, undefined, 'GET');
  const all = (await res.json()) as Req[];
  assert.equal(new Set(all.map((r) => r.id)).size, all.length, 'mirrors are not listed');
  const sorted = [...all].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  assert.deepEqual(
    all.map((r) => r.id),
    sorted.map((r) => r.id),
  );
  assert.equal(
    (await call('/admin/postponements?status=bogus', ADMIN, undefined, 'GET')).status,
    400,
  );
  const open = (await (
    await call('/admin/postponements?status=open', ADMIN, undefined, 'GET')
  ).json()) as Req[];
  assert.ok(open.length > 0 && open.every((r) => r.status === 'open'));
});

test('a club only sees its own requests; withheld times never leave in club-facing bodies', async () => {
  const third = (await (
    await call('/clubs/third/postponements', REP_THIRD, undefined, 'GET')
  ).json()) as {
    inbound: Req[];
    outbound: Req[];
  };
  assert.deepEqual(third, { inbound: [], outbound: [] });
  // A rep cannot read another club's requests.
  assert.equal((await call('/clubs/away/postponements', REP_HOME, undefined, 'GET')).status, 403);
  // The s-wt request (time withheld) carries no time anywhere in the club view.
  const home = (await (
    await call('/clubs/home/postponements', REP_HOME, undefined, 'GET')
  ).json()) as {
    outbound: Req[];
  };
  const wt = home.outbound.find((r) => r.seriesId === 's-wt')!;
  assert.equal(wt.originalTime, undefined);
  assert.ok(wt.proposals.every((p) => p.time === undefined));
});

test('club erasure removes both rows of every postponement it is party to', async () => {
  const listed = await repo.listPostponementsForClub('dolphins', 'home');
  assert.ok(listed.outbound.length > 0);
  const sample = listed.outbound[0];
  await repo.eraseClubData('dolphins', (await repo.getClub('dolphins', 'home'))!);
  assert.equal(await repo.getOutboundPostponement('dolphins', 'home', sample.id), null);
  assert.equal(await repo.getPostponement('dolphins', sample.opposingClubId, sample.id), null);
});
