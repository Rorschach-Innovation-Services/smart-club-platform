/**
 * Integration tests for the IN-SEASON clash gate on PATCH /series and the admin-only
 * POST /series/:id/clash-check pre-check. A released series may be edited freely, but a
 * fixtures write that INTRODUCES a ground/date/time double-booking is refused (409 with a
 * structured `clashes` list + `code: 'venue_clash'`) — while an edit that merely leaves a
 * pre-existing residual clash in place still saves, so a clashing schedule stays fixable
 * one fixture at a time. Drafts are ungated (the release gate still applies at release).
 *
 * Same harness as release-clash-gate.int.test.ts / progressive-release.int.test.ts:
 * in-process dynalite + the REAL Hono app via app.request(); dev-auth bypass (LOCAL_AUTH=1),
 * an ADMIN and a REP scoped to 'home-club'.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Series } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4635; // distinct from api.int (4599) … clearance-reject-reopen (4633); next free even port
const TABLE = 'SmartClubInSeasonGateTest';
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

const series = (id: string, over: Partial<Series> = {}): Series =>
  ({
    id,
    name: `Series ${id}`,
    leagueKey: 'premier',
    startDate: '2026-09-27',
    teams: ['home-club', 'away-club'],
    participants: [
      { teamId: 'home-club', clubId: 'home-club', name: 'Home Club' },
      { teamId: 'away-club', clubId: 'away-club', name: 'Away Club' },
    ],
    fixtures: [],
    kind: 'series',
    approved: true,
    approvedAt: '2026-08-01T00:00:00.000Z',
    released: false,
    releasedAt: null,
    version: 1,
    ...over,
  }) as Series;

const fixture = (over: Partial<Fixture> & { id: string }): Fixture => ({
  round: 1,
  date: '2026-09-27',
  time: '09:00',
  home: 'home-club',
  away: 'away-club',
  ...over,
});

/** Store a series already released (bypassing the HTTP release gate) so the in-season gate
 * has a live subject to patch. */
const putReleased = (id: string, fixtures: Fixture[], over: Partial<Series> = {}) =>
  repo.putSeries(
    'dolphins',
    series(id, { released: true, releasedAt: '2026-09-01T00:00:00.000Z', fixtures, ...over }),
  );

const patch = (id: string, body: Record<string, unknown>) =>
  app.request(`/series/${id}`, {
    method: 'PATCH',
    headers: headers(ADMIN),
    body: JSON.stringify(body),
  });

const clashCheck = (id: string, candidates: unknown, auth = ADMIN) =>
  app.request(`/series/${id}/clash-check`, {
    method: 'POST',
    headers: headers(auth),
    body: JSON.stringify({ candidates }),
  });

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

describe('in-season clash gate — PATCH /series/:id', () => {
  test('stale version wins over the clash gate: plain "series changed; refetch", no code', async () => {
    await putReleased('sv-a', [fixture({ id: 'f1', venueName: 'SV Ground' })]);
    await putReleased('sv-b', [
      fixture({ id: 'f1', home: 'away-club', away: 'home-club', venueName: 'SV Elsewhere' }),
    ]);
    // Patch would move B onto A's ground (a clash) but the version is stale — the concurrency
    // 409 must win, so the admin refetches rather than seeing a venue-clash error.
    const res = await patch('sv-b', {
      version: 999,
      fixtures: [
        fixture({ id: 'f1', home: 'away-club', away: 'home-club', venueName: 'SV Ground' }),
      ],
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error?: string; code?: string };
    assert.equal(body.error, 'series changed; refetch');
    assert.equal(body.code, undefined);
  });

  test('a released edit that double-books another released series is refused (409, structured)', async () => {
    await putReleased('cl-a', [fixture({ id: 'f1', venueName: 'Kingsmead' })]);
    await putReleased('cl-b', [
      fixture({ id: 'f1', home: 'away-club', away: 'home-club', venueName: 'Sahara Park' }),
    ]);
    const before = await repo.getSeries('dolphins', 'cl-b');
    const res = await patch('cl-b', {
      version: before!.version,
      fixtures: [
        fixture({ id: 'f1', home: 'away-club', away: 'home-club', venueName: 'Kingsmead' }),
      ],
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as {
      error: string;
      code: string;
      clashes: Array<{
        fixtureId: string;
        ground: string;
        date: string;
        time?: string;
        with: { seriesId: string; seriesName?: string; home?: string; away?: string };
      }>;
    };
    assert.match(body.error, /^Change blocked/);
    assert.equal(body.code, 'venue_clash');
    assert.equal(body.clashes.length, 1);
    const c = body.clashes[0];
    assert.equal(c.fixtureId, 'f1');
    assert.match(c.ground, /Kingsmead/);
    assert.equal(c.date, '2026-09-27');
    assert.equal(c.time, '09:00');
    assert.equal(c.with.seriesId, 'cl-a');
    assert.equal(c.with.seriesName, 'Series cl-a');
    assert.equal(c.with.home, 'Home Club');
    assert.equal(c.with.away, 'Away Club');
    // The store is untouched: venue and version unchanged.
    const after = await repo.getSeries('dolphins', 'cl-b');
    assert.equal((after!.fixtures[0] as { venueName?: string }).venueName, 'Sahara Park');
    assert.equal(after!.version, before!.version);
  });

  test('the same clashing edit on a DRAFT series saves (no gate on drafts)', async () => {
    await putReleased('dr-a', [fixture({ id: 'f1', venueName: 'Chatsworth Oval' })]);
    await repo.putSeries(
      'dolphins',
      series('dr-b', {
        released: false,
        releasedAt: null,
        fixtures: [
          fixture({ id: 'f1', home: 'away-club', away: 'home-club', venueName: 'Somewhere Else' }),
        ],
      }),
    );
    const before = await repo.getSeries('dolphins', 'dr-b');
    const res = await patch('dr-b', {
      version: before!.version,
      fixtures: [
        fixture({ id: 'f1', home: 'away-club', away: 'home-club', venueName: 'Chatsworth Oval' }),
      ],
    });
    assert.equal(res.status, 200);
  });

  test('a released edit to a free ground saves; releasedAt/withheld untouched', async () => {
    await putReleased('free-b', [fixture({ id: 'f1', venueName: 'Old Ground' })], {
      withheld: { venue: true },
    });
    const before = await repo.getSeries('dolphins', 'free-b');
    const res = await patch('free-b', {
      version: before!.version,
      fixtures: [fixture({ id: 'f1', venueName: 'Brand New Free Ground' })],
    });
    assert.equal(res.status, 200);
    const after = await repo.getSeries('dolphins', 'free-b');
    assert.equal((after!.fixtures[0] as { venueName?: string }).venueName, 'Brand New Free Ground');
    assert.equal(after!.releasedAt, '2026-09-01T00:00:00.000Z');
    assert.deepEqual(after!.withheld, { venue: true });
  });

  test('a residual self-clash stays fixable: fix / leave-residual / move-time / add-clash', async () => {
    // f1 is UNTIMED (owns the ground-day); f2 at 09:00 on the same ground/day clashes with it.
    // f3 sits on a clean ground. This residual clash is stored, released — the gate must let
    // the admin work on it fixture by fixture.
    const residual = () => [
      fixture({ id: 'f1', time: undefined, venueName: 'Residual Ground' }),
      fixture({ id: 'f2', home: 'away-club', away: 'home-club', venueName: 'Residual Ground' }),
      fixture({ id: 'f3', venueName: 'Residual Clean' }),
    ];

    // (a) fixing the clash (move f2 off the shared ground) saves.
    await putReleased('res-a', residual());
    let cur = await repo.getSeries('dolphins', 'res-a');
    let res = await patch('res-a', {
      version: cur!.version,
      fixtures: [
        fixture({ id: 'f1', time: undefined, venueName: 'Residual Ground' }),
        fixture({ id: 'f2', home: 'away-club', away: 'home-club', venueName: 'Residual Fixed' }),
        fixture({ id: 'f3', venueName: 'Residual Clean' }),
      ],
    });
    assert.equal(res.status, 200, 'fixing a residual clash saves');

    // (b) editing an UNRELATED fixture that leaves the residual clash in place saves.
    await putReleased('res-b', residual());
    cur = await repo.getSeries('dolphins', 'res-b');
    res = await patch('res-b', {
      version: cur!.version,
      fixtures: [
        fixture({ id: 'f1', time: undefined, venueName: 'Residual Ground' }),
        fixture({ id: 'f2', home: 'away-club', away: 'home-club', venueName: 'Residual Ground' }),
        fixture({ id: 'f3', venueName: 'Residual Clean Moved' }),
      ],
    });
    assert.equal(res.status, 200, 'leaving a residual clash untouched saves');

    // (c) moving ONLY the kick-off of the residual-clashing fixture against the same untimed
    // partner is not a new double-booking (pair-identity clashKey ignores date/time).
    await putReleased('res-c', residual());
    cur = await repo.getSeries('dolphins', 'res-c');
    res = await patch('res-c', {
      version: cur!.version,
      fixtures: [
        fixture({ id: 'f1', time: undefined, venueName: 'Residual Ground' }),
        fixture({
          id: 'f2',
          time: '13:00',
          home: 'away-club',
          away: 'home-club',
          venueName: 'Residual Ground',
        }),
        fixture({ id: 'f3', venueName: 'Residual Clean' }),
      ],
    });
    assert.equal(res.status, 200, 'moving the kick-off vs the same partner is not a new clash');

    // (d) an edit that adds a NEW clash (move f3 onto the residual ground) is refused, and
    // lists ONLY the introduced clash — not the pre-existing residual one.
    await putReleased('res-d', residual());
    cur = await repo.getSeries('dolphins', 'res-d');
    res = await patch('res-d', {
      version: cur!.version,
      fixtures: [
        fixture({ id: 'f1', time: undefined, venueName: 'Residual Ground' }),
        fixture({ id: 'f2', home: 'away-club', away: 'home-club', venueName: 'Residual Ground' }),
        fixture({ id: 'f3', venueName: 'Residual Ground' }),
      ],
    });
    assert.equal(res.status, 409, 'adding a new clash is refused');
    const body = (await res.json()) as { code: string; clashes: Array<{ fixtureId: string }> };
    assert.equal(body.code, 'venue_clash');
    assert.equal(body.clashes.length, 1, 'only the introduced clash is listed');
    assert.equal(body.clashes[0].fixtureId, 'f3');
  });

  test('a regenerate-shaped PATCH (all-new fixture ids) on a residual-clash series is refused', async () => {
    await putReleased('regen-a', [
      fixture({ id: 'f1', time: undefined, venueName: 'Regen Ground' }),
      fixture({ id: 'f2', home: 'away-club', away: 'home-club', venueName: 'Regen Ground' }),
    ]);
    const cur = await repo.getSeries('dolphins', 'regen-a');
    // New ids ⇒ none of the resulting clash keys can be in `before` (keyed by fixture id),
    // so the residual clash is re-introduced under fresh ids and refused.
    const res = await patch('regen-a', {
      version: cur!.version,
      fixtures: [
        fixture({ id: 'r1', time: undefined, venueName: 'Regen Ground' }),
        fixture({ id: 'r2', home: 'away-club', away: 'home-club', venueName: 'Regen Ground' }),
      ],
    });
    assert.equal(res.status, 409);
  });

  test('withheld venues: the gate reads REAL venues; a clean edit keeps venues hidden from reps', async () => {
    await putReleased('wh-a', [fixture({ id: 'f1', venueName: 'Withheld Kingsmead' })]);
    await putReleased('wh-b', [fixture({ id: 'f1', venueName: 'Withheld Own' })], {
      withheld: { venue: true },
    });

    // Clashing edit is refused even though venues are withheld from clubs (store holds real data).
    let cur = await repo.getSeries('dolphins', 'wh-b');
    let res = await patch('wh-b', {
      version: cur!.version,
      fixtures: [fixture({ id: 'f1', venueName: 'Withheld Kingsmead' })],
    });
    assert.equal(res.status, 409);

    // Non-clashing edit saves and the rep still sees no venue keys.
    cur = await repo.getSeries('dolphins', 'wh-b');
    res = await patch('wh-b', {
      version: cur!.version,
      fixtures: [fixture({ id: 'f1', venueName: 'Withheld New Own' })],
    });
    assert.equal(res.status, 200);

    const repList = await app.request('/series', { headers: headers(REP) });
    assert.equal(repList.status, 200);
    const list = (await repList.json()) as Array<{
      id: string;
      fixtures: Array<Record<string, unknown>>;
    }>;
    const seen = list.find((s) => s.id === 'wh-b');
    assert.ok(seen, 'rep sees the released series');
    assert.equal(seen!.fixtures[0].venueName, undefined, 'rep sees no venueName (withheld)');
  });

  test('recall (released:false) with a clashing fixtures array is never gated', async () => {
    await putReleased('rc-a', [fixture({ id: 'f1', venueName: 'Recall Ground' })]);
    await putReleased('rc-b', [
      fixture({ id: 'f1', home: 'away-club', away: 'home-club', venueName: 'Recall Other' }),
    ]);
    const cur = await repo.getSeries('dolphins', 'rc-b');
    const res = await patch('rc-b', {
      version: cur!.version,
      released: false,
      fixtures: [
        fixture({ id: 'f1', home: 'away-club', away: 'home-club', venueName: 'Recall Ground' }),
      ],
    });
    assert.equal(res.status, 200);
  });
});

describe('POST /series/:id/clash-check', () => {
  test('admin gets results aligned to candidates (one clashing, one clean)', async () => {
    await putReleased('cc-a', [fixture({ id: 'f1', venueName: 'CC Kingsmead' })]);
    await putReleased('cc-s', [fixture({ id: 'sf1', venueName: 'CC Home Ground' })]);
    const res = await clashCheck('cc-s', [
      fixture({ id: 'sf1', venueName: 'CC Kingsmead' }), // clashes with cc-a
      fixture({ id: 'sf1', venueName: 'CC Free Ground' }), // clean
    ]);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      results: Array<{ clashes: unknown[]; introduced: unknown[] }>;
    };
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0].introduced.length, 1);
    assert.equal(body.results[1].introduced.length, 0);
    assert.equal(body.results[1].clashes.length, 0);
  });

  test('on a residual-clash series a candidate that keeps the residual has it in clashes, not introduced', async () => {
    await putReleased('cc-res', [
      fixture({ id: 'f1', time: undefined, venueName: 'CCRes Ground' }),
      fixture({ id: 'f2', home: 'away-club', away: 'home-club', venueName: 'CCRes Ground' }),
    ]);
    // Candidate = f2 unchanged: it still clashes with the untimed f1, but that clash is
    // pre-existing (in `before`), so it is reported but NOT flagged as introduced.
    const res = await clashCheck('cc-res', [
      fixture({ id: 'f2', home: 'away-club', away: 'home-club', venueName: 'CCRes Ground' }),
    ]);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      results: Array<{ clashes: unknown[]; introduced: unknown[] }>;
    };
    assert.equal(body.results[0].clashes.length, 1);
    assert.equal(body.results[0].introduced.length, 0);
  });

  test('a rep is forbidden (403)', async () => {
    await putReleased('cc-rep', [fixture({ id: 'f1', venueName: 'CCRep Ground' })]);
    const res = await clashCheck('cc-rep', [fixture({ id: 'f1', venueName: 'CCRep Ground' })], REP);
    assert.equal(res.status, 403);
  });

  test('malformed body → 400', async () => {
    await putReleased('cc-bad', [fixture({ id: 'f1', venueName: 'CCBad Ground' })]);
    assert.equal((await clashCheck('cc-bad', [])).status, 400, 'empty array');
    assert.equal((await clashCheck('cc-bad', 'nope')).status, 400, 'not an array');
    assert.equal(
      (await clashCheck('cc-bad', [{ noId: true }])).status,
      400,
      'candidate has no string id',
    );
    assert.equal(
      (
        await clashCheck(
          'cc-bad',
          new Array(21).fill(0).map((_, i) => ({ id: `f${i}` })),
        )
      ).status,
      400,
      'more than 20 candidates',
    );
  });

  test('a non-string field the ledger reads → 400 naming the field (not a 500)', async () => {
    await putReleased('cc-type', [fixture({ id: 'f1', venueName: 'CCType Ground' })]);
    // `venueOverride: 123` used to reach `normaliseName(123)` and 500; it must now 400 with
    // a message that names the offending field.
    const res = await clashCheck('cc-type', [{ id: 'f1', date: '2026-09-27', venueOverride: 123 }]);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string; message?: string };
    assert.match(JSON.stringify(body), /venueOverride/);
  });

  test('a null string field is tolerated → 200', async () => {
    await putReleased('cc-null', [fixture({ id: 'f1', venueName: 'CCNull Ground' })]);
    // `null` (like omitted) is accepted for the optional text fields — only a wrong TYPE 400s.
    const res = await clashCheck('cc-null', [
      {
        id: 'f1',
        round: 1,
        date: '2026-09-27',
        time: null,
        home: 'home-club',
        away: 'away-club',
        venueName: 'CCNull Ground',
      },
    ]);
    assert.equal(res.status, 200);
  });

  test('unknown series → 404', async () => {
    const res = await clashCheck('cc-missing', [fixture({ id: 'f1', venueName: 'X' })]);
    assert.equal(res.status, 404);
  });
});
