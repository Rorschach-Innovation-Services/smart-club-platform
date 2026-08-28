/**
 * Progressive fixture release (ADR 0011) — FAILURE-MODE + edge coverage complementing
 * progressive-release.int.test.ts. Same harness: in-process dynalite + the REAL Hono app
 * via app.request(). Auth uses the dev bypass (LOCAL_AUTH=1, x-dev-auth), an ADMIN and a
 * REP scoped to 'home-club' (a club CHAIR is just a rep scoped to that club — see the
 * `assertClubAccess`-only guard on POST /clubs/:id/send-fixtures).
 *
 * Everything here asserts on real HTTP responses and stored rows (repo reads) — no mocks.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import dayjs from 'dayjs';
import dayjsUtc from 'dayjs/plugin/utc.js';
import type { Series, Club } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4631; // distinct from api.int (4599) … progressive-release (4625); ≥4631 to
// dodge a concurrently-taken e2e port.
const TABLE = 'SmartClubProgressiveReleaseFailuresTest';
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

dayjs.extend(dayjsUtc);
// Mirror the handler's tenant-day logic (index.ts: TENANT_UTC_OFFSET_MINUTES = 120,
// tenantToday = dayjs().utcOffset(120).format('YYYY-MM-DD')). `tenantToday` is not exported,
// so it is replicated here rather than imported.
const TENANT_UTC_OFFSET_MINUTES = 120;
const tenantToday = () => dayjs().utcOffset(TENANT_UTC_OFFSET_MINUTES).format('YYYY-MM-DD');

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
// the tenant-wide release clash gate. A test that wants a clash overrides `fixtures`.
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
      {
        teamId: 'home-club',
        clubId: 'home-club',
        name: 'Home Club',
        venue: 'Home Oval',
        lat: -29.85,
        lon: 31.02,
      },
      {
        teamId: 'away-club',
        clubId: 'away-club',
        name: 'Away Club',
        venue: 'Away Oval',
        lat: -30.0,
        lon: 30.9,
      },
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
const repFixture = async (id: string) => {
  const list = (await (await getSeries(REP)).json()) as Series[];
  const s = find(list, id)!;
  return { s, f: s?.fixtures?.[0] as Record<string, unknown> | undefined };
};

describe('(1) authorization — a rep may not release or reveal', () => {
  test('rep PATCH {released,withheld} ⇒ 403; rep PATCH {reveal} ⇒ 403; store untouched', async () => {
    await repo.putSeries('dolphins', series('s1-auth'));
    assert.equal(
      (await patch('s1-auth', { released: true, withheld: { venue: true }, version: 1 }, REP))
        .status,
      403,
    );
    assert.equal((await patch('s1-auth', { reveal: ['venue'], version: 1 }, REP)).status, 403);
    // requireAdmin 403s before any write — the series is still an unreleased draft.
    const stored = await repo.getSeries('dolphins', 's1-auth');
    assert.equal(stored!.released, false);
    assert.equal(stored!.withheld, undefined);
    // (rep GET /season-runs/:id ⇒ 403 is already covered by progressive-release.int.test.ts
    // describe (b) "rep GET /season-runs is 403".)
  });
});

describe('(2) release requires approval — withheld is not stored on the 400', () => {
  test('unapproved release with withheld ⇒ 400, nothing withheld or released', async () => {
    await repo.putSeries('dolphins', series('s2-noappr', { approved: false, approvedAt: null }));
    const res = await patch('s2-noappr', {
      released: true,
      withheld: { venue: true },
      version: await ver('s2-noappr'),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /fixtures must be approved/);
    const stored = await repo.getSeries('dolphins', 's2-noappr');
    assert.equal(stored!.released, false, 'not released');
    assert.equal(stored!.withheld, undefined, 'withheld never persisted on the rejected release');
  });
});

describe('(3) approve + release + withheld in one PATCH', () => {
  test('the console re-approve-and-release click stores withheld', async () => {
    await repo.putSeries('dolphins', series('s3-oneshot', { approved: false, approvedAt: null }));
    const res = await patch('s3-oneshot', {
      approved: true,
      released: true,
      withheld: { venue: true },
      version: await ver('s3-oneshot'),
    });
    assert.equal(res.status, 200);
    const stored = await repo.getSeries('dolphins', 's3-oneshot');
    assert.equal(stored!.released, true);
    assert.equal(stored!.approved, true);
    assert.deepEqual(
      stored!.withheld,
      { venue: true },
      'withheld chosen on the same release patch',
    );
  });
});

describe('(4) activateFrom gate interacts with withholding', () => {
  test('future activateFrom hides from rep; moving it to today reveals it withheld', async () => {
    await repo.putSeries(
      'dolphins',
      series('s4-act', {
        released: true,
        releasedAt: '2026-08-10T00:00:00.000Z',
        withheld: { venue: true, time: true },
        activateFrom: '2999-01-01',
      }),
    );

    // Future activateFrom ⇒ rep omits the series entirely; admin sees it throughout.
    assert.equal(
      find((await (await getSeries(REP)).json()) as Series[], 's4-act'),
      undefined,
      'rep omits future',
    );
    assert.ok(
      find((await (await getSeries(ADMIN)).json()) as Series[], 's4-act'),
      'admin sees future',
    );

    // Move activation to today (computed with the handler's own tenant-day logic).
    const res = await patch('s4-act', {
      activateFrom: tenantToday(),
      version: await ver('s4-act'),
    });
    assert.equal(res.status, 200);

    const { s: repS, f: repF } = await repFixture('s4-act');
    assert.ok(repS, 'rep now sees the activated series');
    for (const k of VENUE_KEYS) assert.equal(k in repF!, false, `${k} withheld from rep`);
    assert.equal('time' in repF!, false, 'time withheld');
    assert.equal('slot' in repF!, false, 'slot withheld');
    assert.deepEqual(
      repS.withheld,
      { venue: true, time: true },
      'a non-withheld patch kept withheld',
    );

    const adminF = find((await (await getSeries(ADMIN)).json()) as Series[], 's4-act')!
      .fixtures[0] as Record<string, unknown>;
    assert.match(String(adminF.venueName), /^Ground /, 'admin keeps venue throughout');
    assert.equal(adminF.time, '09:00', 'admin keeps time throughout');
  });
});

describe('(5) create + duplicate never carry withholding', () => {
  test('POST /series drops client-sent withheld/revealedAt', async () => {
    // A draft body (released defaults false) that nonetheless smuggles withheld/revealedAt.
    const body = series('s5-post', {
      withheld: { venue: true },
      revealedAt: { venue: '2026-08-01T00:00:00.000Z' },
    } as Partial<Series>);
    const res = await app.request('/series', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 201);
    const created = (await res.json()) as Series;
    assert.equal(created.withheld, undefined, 'response has no withheld');
    assert.equal(created.revealedAt, undefined, 'response has no revealedAt');
    assert.equal(created.released, false, 'a create defaults to a draft');
    const stored = await repo.getSeries('dolphins', 's5-post');
    assert.equal(stored!.withheld, undefined, 'store has no withheld');
    assert.equal(stored!.revealedAt, undefined, 'store has no revealedAt');
  });

  test('POST /series/:id/duplicate of a withheld released series clones a clean draft', async () => {
    await repo.putSeries(
      'dolphins',
      series('s5-orig', {
        released: true,
        releasedAt: '2026-08-10T00:00:00.000Z',
        withheld: { venue: true, time: true },
        revealedAt: { venue: '2026-08-11T00:00:00.000Z' },
      } as Partial<Series>),
    );
    const res = await app.request('/series/s5-orig/duplicate', {
      method: 'POST',
      headers: headers(ADMIN),
    });
    assert.equal(res.status, 201);
    const copy = (await res.json()) as Series;
    assert.equal(copy.withheld, undefined, 'copy has no withheld');
    assert.equal(copy.revealedAt, undefined, 'copy has no revealedAt');
    assert.equal(copy.released, false, 'copy is a draft');
    assert.equal(copy.version, 1, 'copy version reset');
    const stored = await repo.getSeries('dolphins', copy.id);
    assert.equal(stored!.withheld, undefined);
    assert.equal(stored!.revealedAt, undefined);
  });
});

describe('(6) reveal both fields in one call', () => {
  test('reveal:[venue,time] drops withheld entirely and stamps both revealedAt', async () => {
    await repo.putSeries('dolphins', series('s6-both'));
    await patch('s6-both', {
      released: true,
      withheld: { venue: true, time: true },
      version: await ver('s6-both'),
    });
    const res = await patch('s6-both', {
      reveal: ['venue', 'time'],
      version: await ver('s6-both'),
    });
    assert.equal(res.status, 200);

    const stored = await repo.getSeries('dolphins', 's6-both');
    // The key is ABSENT, not an empty object.
    assert.equal('withheld' in stored!, false, 'withheld key removed entirely');
    assert.equal(stored!.withheld, undefined);
    assert.ok(stored!.revealedAt?.venue, 'revealedAt.venue stamped');
    assert.ok(stored!.revealedAt?.time, 'revealedAt.time stamped');

    // Rep now sees the full venue + time.
    const { f } = await repFixture('s6-both');
    assert.match(String(f!.venueName), /^Ground /, 'venue revealed to rep');
    assert.equal(f!.time, '09:00', 'time revealed to rep');
  });
});

describe('(7) recall then re-release without withheld', () => {
  test('re-release omitting withheld hides nothing and re-stamps no reveal', async () => {
    await repo.putSeries('dolphins', series('s7-recycle'));
    await patch('s7-recycle', {
      released: true,
      withheld: { venue: true },
      version: await ver('s7-recycle'),
    });
    // Recall clears withheld + revealedAt.
    await patch('s7-recycle', { released: false, version: await ver('s7-recycle') });
    const recalled = await repo.getSeries('dolphins', 's7-recycle');
    assert.equal(recalled!.withheld, undefined);
    assert.equal(recalled!.revealedAt, undefined);

    // Re-release WITHOUT a withheld key ⇒ nothing withheld.
    const res = await patch('s7-recycle', { released: true, version: await ver('s7-recycle') });
    assert.equal(res.status, 200);
    const stored = await repo.getSeries('dolphins', 's7-recycle');
    assert.equal(stored!.released, true);
    assert.equal(stored!.withheld, undefined, 'nothing withheld on the re-release');
    assert.equal(stored!.revealedAt, undefined, 'no reveal stamps');

    const { f } = await repFixture('s7-recycle');
    assert.match(String(f!.venueName), /^Ground /, 'rep sees full venue');
    assert.equal(f!.time, '09:00', 'rep sees full time');
  });
});

describe('(8) exactly which keys each withholding strips (rep projection)', () => {
  test('withheld.time strips fixture slot + schedule.slots, keeps calendar/block/cadence', async () => {
    await repo.putSeries(
      'dolphins',
      series('s8-time', {
        released: true,
        releasedAt: '2026-08-10T00:00:00.000Z',
        withheld: { time: true },
        schedule: {
          calendarId: 'cal-1',
          blockId: 'blk-1',
          cadence: 'weekly',
          slots: [{ label: 'AM', start: '09:00' }],
        },
      } as unknown as Partial<Series>),
    );
    const { s, f } = await repFixture('s8-time');
    assert.equal('time' in f!, false, 'fixture time stripped');
    assert.equal('slot' in f!, false, 'fixture slot stripped');
    // Venue keys are untouched when only time is withheld.
    assert.match(String(f!.venueName), /^Ground /, 'venue kept when only time withheld');
    const sched = s.schedule as unknown as Record<string, unknown>;
    assert.equal('slots' in sched, false, 'schedule.slots stripped');
    assert.equal(sched.calendarId, 'cal-1', 'calendarId kept');
    assert.equal(sched.blockId, 'blk-1', 'blockId kept');
    assert.equal(sched.cadence, 'weekly', 'cadence kept');
  });

  test('withheld.venue strips all eight fixture venue keys, keeps participants venue/lat/lon', async () => {
    await repo.putSeries(
      'dolphins',
      series('s8-venue', {
        released: true,
        releasedAt: '2026-08-10T00:00:00.000Z',
        withheld: { venue: true },
      }),
    );
    const { s, f } = await repFixture('s8-venue');
    for (const k of VENUE_KEYS) assert.equal(k in f!, false, `fixture ${k} stripped`);
    // Time keys untouched when only venue is withheld.
    assert.equal(f!.time, '09:00', 'time kept when only venue withheld');
    assert.equal(f!.slot, 'morning', 'slot kept when only venue withheld');
    // Participants' home-ground venue/lat/lon are deliberately NOT stripped — reps already
    // have them from GET /clubs (documented decision).
    const home = (s.participants as Array<Record<string, unknown>>).find(
      (p) => p.teamId === 'home-club',
    )!;
    assert.equal(home.venue, 'Home Oval', 'participant venue kept');
    assert.equal(home.lat, -29.85, 'participant lat kept');
    assert.equal(home.lon, 31.02, 'participant lon kept');
  });
});

describe('(9) malformed withheld on a release ⇒ 400 (never 500), nothing stored', () => {
  test('mixed valid+invalid key {venue,foo}, empty array, and null all 400', async () => {
    await repo.putSeries('dolphins', series('s9-a'));
    await repo.putSeries('dolphins', series('s9-b'));
    await repo.putSeries('dolphins', series('s9-c'));

    // A valid key alongside an unknown one is still rejected wholesale.
    const mixed = await patch('s9-a', {
      released: true,
      withheld: { venue: true, foo: true },
      version: await ver('s9-a'),
    });
    assert.equal(mixed.status, 400);

    // An array is not a { venue?, time? } object.
    assert.equal(
      (await patch('s9-b', { released: true, withheld: [], version: await ver('s9-b') })).status,
      400,
    );

    // `null` on a release: normaliseWithheld rejects it (400), NOT a 500 and NOT a silent
    // "nothing withheld".
    const nullRes = await patch('s9-c', {
      released: true,
      withheld: null,
      version: await ver('s9-c'),
    });
    assert.equal(nullRes.status, 400, 'withheld:null ⇒ 400, not 500');

    for (const id of ['s9-a', 's9-b', 's9-c']) {
      const stored = await repo.getSeries('dolphins', id);
      assert.equal(stored!.released, false, `${id} not released`);
      assert.equal(stored!.withheld, undefined, `${id} nothing withheld`);
    }
  });
});

describe('(10) reveal shape validation (never a 500)', () => {
  test('non-array ⇒ 400, empty array ⇒ 400, duplicate entry ⇒ 409 nothing withheld', async () => {
    await repo.putSeries('dolphins', series('s10-rev'));
    await patch('s10-rev', {
      released: true,
      withheld: { venue: true },
      version: await ver('s10-rev'),
    });

    // A bare string is not an array.
    assert.equal(
      (await patch('s10-rev', { reveal: 'venue', version: await ver('s10-rev') })).status,
      400,
    );
    // An empty array reveals nothing.
    assert.equal(
      (await patch('s10-rev', { reveal: [], version: await ver('s10-rev') })).status,
      400,
    );
    // Duplicate entries: the first deletes the withheld key, the second finds nothing left
    // to reveal ⇒ 409 (a DEFINED behaviour, not a 500). The reveal succeeded for `venue`.
    const dup = await patch('s10-rev', {
      reveal: ['venue', 'venue'],
      version: await ver('s10-rev'),
    });
    assert.equal(dup.status, 409);
    assert.match(((await dup.json()) as { error: string }).error, /nothing withheld for venue/);
  });
});

describe('(11) send-fixtures as a chair + observable schedule text', () => {
  const clubsById = () =>
    new Map([
      ['home-club', club('home-club')],
      ['away-club', club('away-club')],
    ]);

  test('a venue+time-withheld line reads "Venue TBC", no distance, no time', () => {
    const { text } = buildClubSchedule(
      club('home-club'),
      [series('s11-w', { released: true, withheld: { venue: true, time: true } })],
      clubsById(),
    );
    assert.match(text, /Venue TBC/, 'withheld venue shows TBC');
    assert.doesNotMatch(text, /Ground \d+/, 'the withheld ground name never leaks');
    assert.doesNotMatch(text, /km round-trip/, 'no round-trip distance when venue withheld');
    assert.doesNotMatch(text, /09:00/, 'no kick-off time when time withheld');
  });

  test('a non-withheld line carries the venue and the kick-off time', () => {
    const { text } = buildClubSchedule(
      club('home-club'),
      [series('s11-f', { released: true })],
      clubsById(),
    );
    assert.match(text, /Ground \d+/, 'venue shown when nothing withheld');
    assert.match(text, /09:00/, 'time shown when nothing withheld');
  });

  test('a chair (rep scoped to the club) can send-fixtures for a withheld released series', async () => {
    await repo.createClub('dolphins', club('home-club'));
    await repo.putSeries(
      'dolphins',
      series('s11-send', {
        released: true,
        releasedAt: '2026-08-10T00:00:00.000Z',
        withheld: { venue: true, time: true },
      }),
    );
    await repo.createPlayer('dolphins', {
      naturalKey: 'ChairReach',
      clubId: 'home-club',
      firstName: 'Chair',
      lastName: 'Reach',
      dob: '1990-01-01',
      isMinor: false,
      consentAt: '2026-05-01T00:00:00.000Z',
      createdAt: '2026-05-01T00:00:00.000Z',
      email: 'chair.reach@home.co.za',
      cell: '0768563602',
    } as Parameters<typeof repo.createPlayer>[1]);

    const res = await app.request('/clubs/home-club/send-fixtures', {
      method: 'POST',
      headers: headers(REP),
      body: JSON.stringify({ channels: ['email'], idempotencyKey: 'prf-send-1' }),
    });
    assert.equal(res.status, 201);
  });
});

describe('(12) version conflict on a withheld release', () => {
  test('stale version ⇒ 409 and withheld is not stored', async () => {
    await repo.putSeries('dolphins', series('s12-stale'));
    const stale = (await ver('s12-stale')) + 5; // a version the store has never held
    const res = await patch('s12-stale', {
      released: true,
      withheld: { venue: true },
      version: stale,
    });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /series changed; refetch/);
    const stored = await repo.getSeries('dolphins', 's12-stale');
    assert.equal(stored!.released, false, 'never released');
    assert.equal(stored!.withheld, undefined, 'withheld not stored on the conflict');
  });
});
