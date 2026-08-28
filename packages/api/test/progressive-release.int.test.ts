/**
 * Integration tests for progressive fixture release (ADR 0011): the role-projected
 * `GET /series`, the release/reveal/recall PATCH semantics, the admin-only
 * `GET /season-runs`, and `buildClubSchedule`/send-fixtures honouring withheld fields.
 *
 * Same harness as release-clash-gate.int.test.ts: in-process dynalite + the REAL Hono app
 * via app.request(). Auth uses the dev bypass (LOCAL_AUTH=1, x-dev-auth), an ADMIN and a
 * REP scoped to 'home-club'.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Series, Club } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4625; // distinct from api.int (4599), release-clash-gate (4611), season-venues (4607), etc.
const TABLE = 'SmartClubProgressiveReleaseTest';
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

const VENUE_KEYS = [
  'venueId',
  'venueName',
  'venueLat',
  'venueLon',
  'venueStatus',
  'venueReason',
  'venueLocked',
  'venueOverride',
];

/** One fully-allocated home fixture (venue + time), so withholding has something to strip. */
const fixture = (over: Record<string, unknown> = {}) => ({
  id: 'f1',
  round: 1,
  date: '2026-09-27',
  time: '09:00',
  slot: 'morning',
  home: 'home-club',
  away: 'away-club',
  venueId: 'v-kings',
  venueName: 'Kingsmead Stadium',
  venueLat: -29.85,
  venueLon: 31.02,
  venueStatus: 'home',
  ...over,
});

// Each series gets a UNIQUE date + ground by default so two unrelated series never trip
// the tenant-wide release clash gate (same ground/day, or the same side twice in a day).
// A test that wants a clash overrides `fixtures` explicitly.
let seq = 0;
const series = (id: string, over: Partial<Series> = {}): Series => {
  seq += 1;
  const day = String(seq).padStart(2, '0');
  return {
    id,
    name: `Series ${id}`,
    leagueKey: 'premier',
    startDate: `2026-10-${day}`,
    teams: ['home-club', 'away-club'],
    participants: [
      { teamId: 'home-club', clubId: 'home-club', name: 'Home Club', lat: -29.85, lon: 31.02 },
      { teamId: 'away-club', clubId: 'away-club', name: 'Away Club', lat: -30.0, lon: 30.9 },
    ],
    fixtures: [
      fixture({ date: `2026-10-${day}`, venueName: `Ground ${seq}`, venueId: `v-${seq}` }),
    ],
    kind: 'series',
    approved: true,
    approvedAt: '2026-08-01T00:00:00.000Z',
    released: false,
    releasedAt: null,
    version: 1,
    ...over,
  } as Series;
};

const club = (id: string): Club =>
  ({
    id,
    name: `${id} CC`,
    district: 'Test',
    sub: '',
    chair: 'Chair',
    affiliation: 'not_started',
    cqi: 0,
    docs: {},
    players: 0,
    teams: 1,
    women: 0,
    juniors: 0,
    color: '#0E7C6B',
    ground: { venue: `${id} Oval`, lat: -29.85, lon: 31.02 },
    leagues: [],
    version: 1,
  }) as Club;

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let buildClubSchedule: (typeof import('../src/index.js'))['buildClubSchedule'];
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

  const mod = await import('../src/index.js');
  app = mod.app;
  buildClubSchedule = mod.buildClubSchedule;
  repo = await import('../src/repo.js');
});

after(() => new Promise<void>((resolve) => ddbServer.close(() => resolve())));

const getSeries = (auth: string) => app.request('/series', { headers: headers(auth) });
const patch = (id: string, body: unknown, auth = ADMIN) =>
  app.request(`/series/${id}`, {
    method: 'PATCH',
    headers: headers(auth),
    body: JSON.stringify(body),
  });
const ver = async (id: string) => Number((await repo.getSeries('dolphins', id))!.version);
const find = (list: Series[], id: string) => list.find((s) => s.id === id);

describe('(a) GET /series role projection', () => {
  test('rep sees only released + activated series; admin sees all with full fields', async () => {
    await repo.putSeries('dolphins', series('s-a-draft', { released: false }));
    await repo.putSeries(
      'dolphins',
      series('s-a-live', { released: true, releasedAt: '2026-08-10T00:00:00.000Z' }),
    );
    await repo.putSeries(
      'dolphins',
      series('s-a-future', {
        released: true,
        releasedAt: '2026-08-10T00:00:00.000Z',
        activateFrom: '2999-01-01',
      }),
    );

    const repList = (await (await getSeries(REP)).json()) as Series[];
    assert.equal(find(repList, 's-a-draft'), undefined, 'draft hidden from rep');
    assert.equal(find(repList, 's-a-future'), undefined, 'future-activate hidden from rep');
    const live = find(repList, 's-a-live')!;
    assert.ok(live, 'released+activated series visible to rep');
    assert.equal('approved' in live, false, 'approval state stripped for rep');
    assert.match(
      String((live.fixtures[0] as Record<string, unknown>).venueName),
      /^Ground /,
      'venue visible to rep when nothing withheld',
    );

    const adminList = (await (await getSeries(ADMIN)).json()) as Series[];
    assert.ok(find(adminList, 's-a-draft'), 'admin sees drafts');
    assert.ok(find(adminList, 's-a-future'), 'admin sees future-activate');
    assert.equal(find(adminList, 's-a-live')!.approved, true, 'admin keeps approval state');
  });
});

describe('(b) release / reveal / recall PATCH', () => {
  test('release with withheld:{venue,time} strips fields for rep, keeps them for admin', async () => {
    await repo.putSeries('dolphins', series('s-b-rel'));
    const res = await patch('s-b-rel', {
      released: true,
      withheld: { venue: true, time: true },
      version: await ver('s-b-rel'),
    });
    assert.equal(res.status, 200);

    const repList = (await (await getSeries(REP)).json()) as Series[];
    const repS = find(repList, 's-b-rel')!;
    const repF = repS.fixtures[0] as Record<string, unknown>;
    for (const k of VENUE_KEYS) assert.equal(k in repF, false, `${k} withheld from rep`);
    assert.equal('time' in repF, false);
    assert.equal('slot' in repF, false);
    assert.deepEqual(repS.withheld, { venue: true, time: true }, 'withheld echoed to rep');

    const adminList = (await (await getSeries(ADMIN)).json()) as Series[];
    const adminF = find(adminList, 's-b-rel')!.fixtures[0] as Record<string, unknown>;
    assert.match(String(adminF.venueName), /^Ground /, 'admin keeps venue');
    assert.equal(adminF.time, '09:00', 'admin keeps time');
  });

  test('reveal one field clears its withheld key, stamps revealedAt, never bumps releasedAt', async () => {
    await repo.putSeries('dolphins', series('s-b-reveal'));
    await patch('s-b-reveal', {
      released: true,
      withheld: { venue: true, time: true },
      version: await ver('s-b-reveal'),
    });
    const beforeReveal = await repo.getSeries('dolphins', 's-b-reveal');
    const releasedAt = beforeReveal!.releasedAt;

    const res = await patch('s-b-reveal', {
      reveal: ['venue'],
      version: await ver('s-b-reveal'),
    });
    assert.equal(res.status, 200);
    const after = await repo.getSeries('dolphins', 's-b-reveal');
    assert.deepEqual(after!.withheld, { time: true }, 'venue key removed, time still hidden');
    assert.ok(after!.revealedAt?.venue, 'revealedAt.venue stamped');
    assert.equal(after!.revealedAt?.time, undefined);
    assert.equal(after!.releasedAt, releasedAt, 'releasedAt unchanged by reveal');

    // Revealing an already-revealed field ⇒ 409 nothing withheld.
    const again = await patch('s-b-reveal', {
      reveal: ['venue'],
      version: await ver('s-b-reveal'),
    });
    assert.equal(again.status, 409);
  });

  test('reveal validation: bad entry 400, reveal+released 400, reveal on draft 409', async () => {
    await repo.putSeries('dolphins', series('s-b-badreveal'));
    await patch('s-b-badreveal', {
      released: true,
      withheld: { venue: true },
      version: await ver('s-b-badreveal'),
    });
    assert.equal(
      (await patch('s-b-badreveal', { reveal: ['bogus'], version: await ver('s-b-badreveal') }))
        .status,
      400,
    );
    assert.equal(
      (
        await patch('s-b-badreveal', {
          reveal: ['venue'],
          released: true,
          version: await ver('s-b-badreveal'),
        })
      ).status,
      400,
    );

    await repo.putSeries('dolphins', series('s-b-draft', { released: false }));
    assert.equal(
      (await patch('s-b-draft', { reveal: ['venue'], version: await ver('s-b-draft') })).status,
      409,
    );
  });

  test('release with a malformed withheld ⇒ 400', async () => {
    await repo.putSeries('dolphins', series('s-b-badw'));
    assert.equal(
      (
        await patch('s-b-badw', {
          released: true,
          withheld: { foo: true },
          version: await ver('s-b-badw'),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await patch('s-b-badw', {
          released: true,
          withheld: 'venues',
          version: await ver('s-b-badw'),
        })
      ).status,
      400,
    );
    assert.equal((await repo.getSeries('dolphins', 's-b-badw'))!.released, false);
  });

  test('whole-object PATCH of an already-released series keeps withheld unchanged', async () => {
    await repo.putSeries('dolphins', series('s-b-whole'));
    await patch('s-b-whole', {
      released: true,
      withheld: { venue: true },
      version: await ver('s-b-whole'),
    });

    // The stale-tab pattern: admin re-PATCHes the WHOLE object (released:true, withheld
    // present) with an edited fixture. Withholding must not change — it is chosen at
    // release, and an in-season edit must never silently reveal a field.
    const adminList = (await (await getSeries(ADMIN)).json()) as Series[];
    const whole = find(adminList, 's-b-whole')!;
    const res = await patch('s-b-whole', {
      ...whole,
      fixtures: [
        fixture({
          time: '10:30',
          date: '2026-11-05',
          venueName: 'Whole Ground',
          venueId: 'v-whole',
        }),
      ],
      version: await ver('s-b-whole'),
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await repo.getSeries('dolphins', 's-b-whole'))!.withheld, { venue: true });

    // Even an explicit {released:true, withheld:{time:true}} on an already-released series
    // does NOT re-choose withholding — only the false→true transition may.
    await patch('s-b-whole', {
      released: true,
      withheld: { time: true },
      version: await ver('s-b-whole'),
    });
    assert.deepEqual((await repo.getSeries('dolphins', 's-b-whole'))!.withheld, { venue: true });

    // Recall clears both fields.
    await patch('s-b-whole', { released: false, version: await ver('s-b-whole') });
    const recalled = await repo.getSeries('dolphins', 's-b-whole');
    assert.equal(recalled!.withheld, undefined);
    assert.equal(recalled!.revealedAt, undefined);
  });

  test('the clash gate still blocks a withheld release whose REAL venue clashes', async () => {
    await repo.putSeries(
      'dolphins',
      series('s-b-clash-a', {
        released: true,
        releasedAt: '2026-08-10T00:00:00.000Z',
        fixtures: [fixture({ venueName: 'Clash Oval' })],
      }),
    );
    await repo.putSeries(
      'dolphins',
      series('s-b-clash-b', { fixtures: [fixture({ venueName: 'Clash Oval' })] }),
    );
    const res = await patch('s-b-clash-b', {
      released: true,
      withheld: { venue: true },
      version: await ver('s-b-clash-b'),
    });
    assert.equal(res.status, 409, 'withholding does not hide the clash from the gate');
  });

  test('reveal with a stale version ⇒ 409 "series changed; refetch"', async () => {
    await repo.putSeries('dolphins', series('s-b-stale'));
    await patch('s-b-stale', {
      released: true,
      withheld: { venue: true, time: true },
      version: await ver('s-b-stale'),
    });
    const stale = await ver('s-b-stale');
    // Bump the stored version out from under the stale tab (a concurrent reveal).
    await patch('s-b-stale', { reveal: ['venue'], version: stale });
    // The stale tab now reveals with the version it last saw ⇒ optimistic-concurrency 409.
    const res = await patch('s-b-stale', { reveal: ['time'], version: stale });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /series changed; refetch/);
  });

  test('a reveal patch ignores sibling keys (name, fixtures, approved)', async () => {
    await repo.putSeries('dolphins', series('s-b-extra'));
    await patch('s-b-extra', {
      released: true,
      withheld: { venue: true, time: true },
      version: await ver('s-b-extra'),
    });
    const before = await repo.getSeries('dolphins', 's-b-extra');

    // Sibling keys ride along on the reveal patch — they must be ignored, not persisted.
    const res = await patch('s-b-extra', {
      reveal: ['venue'],
      name: 'HIJACKED',
      fixtures: [],
      approved: false,
      version: await ver('s-b-extra'),
    });
    assert.equal(res.status, 200);

    const after = await repo.getSeries('dolphins', 's-b-extra');
    // The reveal itself applied…
    assert.deepEqual(after!.withheld, { time: true }, 'venue revealed, time still hidden');
    assert.ok(after!.revealedAt?.venue, 'revealedAt.venue stamped');
    // …but every sibling key that rode along was ignored.
    assert.equal(after!.name, before!.name, 'name unchanged');
    assert.equal(after!.approved, before!.approved, 'approved unchanged');
    assert.deepEqual(after!.fixtures, before!.fixtures, 'fixtures unchanged');
  });

  test('rep GET /season-runs is 403 (admin-only)', async () => {
    assert.equal((await app.request('/season-runs', { headers: headers(REP) })).status, 403);
    assert.equal((await app.request('/season-runs', { headers: headers(ADMIN) })).status, 200);
    // The single-run read is admin-only too — the frozen structureSnapshot embeds each
    // stage's schedule.slots (kick-off times a series may withhold, ADR 0011). requireAdmin
    // 403s the rep before the lookup; admin passes auth and 404s on a non-existent run.
    assert.equal((await app.request('/season-runs/nope', { headers: headers(REP) })).status, 403);
    assert.equal((await app.request('/season-runs/nope', { headers: headers(ADMIN) })).status, 404);
  });
});

describe('(c) buildClubSchedule + send-fixtures honour withheld', () => {
  const clubsById = () =>
    new Map([
      ['home-club', club('home-club')],
      ['away-club', club('away-club')],
    ]);

  test('withheld.venue ⇒ "Venue TBC", no km round-trip', () => {
    const { text } = buildClubSchedule(
      club('home-club'),
      [series('s-c-v', { released: true, withheld: { venue: true } })],
      clubsById(),
    );
    assert.match(text, /Venue TBC/);
    assert.doesNotMatch(text, /Ground \d+/, 'the withheld ground name never leaks');
    assert.doesNotMatch(text, /km round-trip/);
  });

  test('withheld.time ⇒ no kick-off time printed; venue + distance still shown', () => {
    const { text } = buildClubSchedule(
      club('home-club'),
      [series('s-c-t', { released: true, withheld: { time: true } })],
      clubsById(),
    );
    assert.doesNotMatch(text, /09:00/);
    assert.match(text, /Ground \d+/, 'venue still shown when only the time is withheld');
  });

  test('rep send-fixtures still 201s for a withheld released series', async () => {
    await repo.createClub('dolphins', club('home-club'));
    await repo.putSeries(
      'dolphins',
      series('s-c-send', {
        released: true,
        releasedAt: '2026-08-10T00:00:00.000Z',
        withheld: { venue: true, time: true },
      }),
    );
    await repo.createPlayer('dolphins', {
      naturalKey: 'Reachable',
      clubId: 'home-club',
      firstName: 'Reachable',
      lastName: 'Player',
      dob: '1995-01-01',
      isMinor: false,
      consentAt: '2026-05-01T00:00:00.000Z',
      createdAt: '2026-05-01T00:00:00.000Z',
      email: 'reach@home.co.za',
      cell: '0768563601',
    } as Parameters<typeof repo.createPlayer>[1]);

    const res = await app.request('/clubs/home-club/send-fixtures', {
      method: 'POST',
      headers: headers(REP),
      body: JSON.stringify({ channels: ['email'], idempotencyKey: 'pr-send-1' }),
    });
    assert.equal(res.status, 201);
  });
});
