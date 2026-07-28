/**
 * Integration tests for the ADR 0008 write paths: /venues and /season-runs.
 *
 * These two routes carry the season's structural truth — a malformed venue silently
 * breaks allocation, and a season run's snapshots are frozen for the life of the season,
 * so a bad one is unfixable without deleting the run. Both are validated on the way in,
 * and both live on key shapes the erasure sweep has to reach explicitly (VENUE# sits
 * under `pk TENANT#<t>`, ABOVE the `TENANT#<t>#…` prefix sweep). All three are pinned
 * here.
 *
 * Same harness as api.int.test.ts: in-process dynalite + the REAL Hono app via
 * `app.request()`. Auth uses the dev bypass (LOCAL_AUTH=1, x-dev-auth).
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { CompetitionStructure, SeasonCalendar, SeasonRun, Venue } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4607; // distinct from api.int (4599), platform.int (4601), logo-offline (4603), backfill-team (4605)
const TABLE = 'SmartClubSeasonVenueTest';
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
const ADMIN2 = devAuth('other@test', [{ tenantId: 'dolphins', role: 'admin', clubIds: [] }]);
const REP = devAuth('rep@test', [{ tenantId: 'dolphins', role: 'rep', clubIds: ['testers'] }]);

const headers = (auth: string) => ({
  'x-tenant': 'dolphins',
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

/** A minimal venue that passes every guard — tests mutate one field at a time from here. */
const venue = (over: Partial<Venue> = {}): Venue => ({
  id: 'kingsmead',
  name: 'Kingsmead',
  lat: -29.85,
  lon: 31.03,
  ...over,
});

const CALENDAR: SeasonCalendar = {
  id: 'cal-2627',
  label: '2026/27',
  blocks: [{ id: 'b1', label: 'Block 1', start: '2026-09-13', end: '2026-12-13' }],
};

const STRUCTURE: CompetitionStructure = {
  id: 'st-flat',
  name: 'Flat round robin',
  version: 1,
  stages: [
    {
      id: 'stage-1',
      name: 'League',
      format: { kind: 'round-robin', legs: 1 },
      entrants: { kind: 'all-registered' },
      schedule: { blockId: 'b1', cadence: { kind: 'weekly' } },
    },
  ],
};

const run = (over: Partial<SeasonRun> = {}): SeasonRun =>
  ({
    id: 'sr-1',
    leagueKey: 'premier-men',
    competitionId: 'comp-1',
    seasonLabel: '2026/27',
    structureSnapshot: STRUCTURE,
    calendarSnapshot: CALENDAR,
    stages: [],
    version: 1,
    ...over,
  }) as SeasonRun;

// Resolved in before().
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

  const seed = await import('../src/seed-core.js');
  await seed.seedTenantConfig('dolphins');
  ({ app } = await import('../src/index.js'));
  repo = await import('../src/repo.js');
});

after(() => {
  ddbServer?.close();
});

describe('PUT /venues/:id', () => {
  test('admin creates a venue; it comes back on the list', async () => {
    const res = await app.request('/venues/kingsmead', {
      method: 'PUT',
      headers: headers(ADMIN),
      body: JSON.stringify(venue()),
    });
    assert.equal(res.status, 200);

    const list = await app.request('/venues', { headers: headers(ADMIN) });
    const venues = (await list.json()) as Venue[];
    assert.ok(
      venues.some((v) => v.id === 'kingsmead' && v.name === 'Kingsmead'),
      'the created venue should be listed',
    );
  });

  test('the PATH owns the id — a crafted body id cannot write to another key', async () => {
    const res = await app.request('/venues/chatsworth', {
      method: 'PUT',
      headers: headers(ADMIN),
      body: JSON.stringify(venue({ id: 'kingsmead', name: 'Chatsworth Oval' })),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Venue).id, 'chatsworth');
    // Kingsmead must be untouched — the body id was ignored, not honoured.
    assert.equal((await repo.getVenue('dolphins', 'kingsmead'))?.name, 'Kingsmead');
  });

  test('a club rep cannot write a venue (403) but can read the list', async () => {
    const write = await app.request('/venues/kingsmead', {
      method: 'PUT',
      headers: headers(REP),
      body: JSON.stringify(venue({ name: 'Rep Renamed It' })),
    });
    assert.equal(write.status, 403);
    assert.equal((await repo.getVenue('dolphins', 'kingsmead'))?.name, 'Kingsmead');

    const read = await app.request('/venues', { headers: headers(REP) });
    assert.equal(read.status, 200);
  });

  test('an unauthenticated request is rejected — /venues needs the bare-path middleware too', async () => {
    // Hono's `/venues/*` does NOT match `/venues`; both registrations are required, and
    // without the bare one every request would arrive with no requestAuth at all.
    const res = await app.request('/venues', { headers: { 'x-tenant': 'dolphins' } });
    assert.equal(res.status, 401);
  });

  test('name is trimmed on the way in', async () => {
    await app.request('/venues/trimmed', {
      method: 'PUT',
      headers: headers(ADMIN),
      body: JSON.stringify(venue({ id: 'trimmed', name: '  Spaced Oval  ' })),
    });
    assert.equal((await repo.getVenue('dolphins', 'trimmed'))?.name, 'Spaced Oval');
  });
});

describe('venue validation', () => {
  const rejects = async (over: Partial<Venue> | Record<string, unknown>, why: string) => {
    const res = await app.request('/venues/vtest', {
      method: 'PUT',
      headers: headers(ADMIN),
      body: JSON.stringify({ ...venue({ id: 'vtest' }), ...over }),
    });
    assert.equal(res.status, 400, `expected 400 for ${why}, got ${res.status}`);
    assert.equal(await repo.getVenue('dolphins', 'vtest'), null, `${why} must not persist`);
  };

  test('a blank name is rejected', () => rejects({ name: '   ' }, 'blank name'));
  test('an over-long name is rejected', () => rejects({ name: 'x'.repeat(121) }, '121-char name'));

  test('non-numeric coordinates are rejected', () =>
    rejects({ lat: '-29.85' as unknown as number }, 'string latitude'));
  test('NaN coordinates are rejected', () => rejects({ lon: Number.NaN }, 'NaN longitude'));
  test('out-of-range latitude is rejected', () => rejects({ lat: 91 }, 'lat 91'));
  test('out-of-range longitude is rejected', () => rejects({ lon: -181 }, 'lon -181'));

  test('a venue that hosts zero matches a day is rejected', () =>
    rejects({ surfaces: 0 }, 'surfaces 0'));
  test('a fractional surface count is rejected', () => rejects({ surfaces: 1.5 }, 'surfaces 1.5'));

  test('an unavailable window without a reason is rejected', () =>
    rejects(
      { unavailable: [{ start: '2026-10-01', end: '2026-10-07', reason: ' ' }] },
      'reasonless window',
    ));
  test('an unavailable window with a malformed date is rejected', () =>
    rejects(
      { unavailable: [{ start: '01/10/2026', end: '2026-10-07', reason: 'Maintenance' }] },
      'non-ISO start',
    ));
  test('an unavailable window that ends before it starts is rejected', () =>
    rejects(
      { unavailable: [{ start: '2026-10-07', end: '2026-10-01', reason: 'Maintenance' }] },
      'inverted window',
    ));
  test('an unavailable weekday outside 0-6 is rejected', () =>
    rejects({ unavailableWeekdays: [7] as never }, 'weekday 7'));

  test('coordinates stay OPTIONAL — a venue with no pin still saves', async () => {
    // There is no geocoder; a half-pinned registry is the normal state, and refusing
    // unpinned venues would make the whole registry unusable.
    const res = await app.request('/venues/unpinned', {
      method: 'PUT',
      headers: headers(ADMIN),
      body: JSON.stringify({ id: 'unpinned', name: 'Unpinned Ground' }),
    });
    assert.equal(res.status, 200);
  });
});

describe('DELETE /venues/:id', () => {
  test('admin deletes; a rep cannot', async () => {
    await app.request('/venues/doomed', {
      method: 'PUT',
      headers: headers(ADMIN),
      body: JSON.stringify(venue({ id: 'doomed', name: 'Doomed Oval' })),
    });

    const repTry = await app.request('/venues/doomed', { method: 'DELETE', headers: headers(REP) });
    assert.equal(repTry.status, 403);
    assert.ok(await repo.getVenue('dolphins', 'doomed'), 'rep delete must not land');

    const res = await app.request('/venues/doomed', { method: 'DELETE', headers: headers(ADMIN) });
    assert.equal(res.status, 200);
    assert.equal(await repo.getVenue('dolphins', 'doomed'), null);
  });
});

describe('POST /season-runs', () => {
  test('admin starts a season; version, createdAt and createdBy are stamped server-side', async () => {
    const res = await app.request('/season-runs', {
      method: 'POST',
      headers: headers(ADMIN),
      // A client-supplied version/createdBy must not be trusted — the server owns both.
      body: JSON.stringify({ ...run(), version: 99, createdBy: 'someone-else@test' }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as SeasonRun;
    assert.equal(body.version, 1);
    assert.equal(body.createdBy, 'admin@test');
    assert.ok(body.createdAt, 'createdAt should be stamped');
    assert.deepEqual(body.stages, []);
  });

  test('a duplicate id is a 409, not a silent overwrite of a live season', async () => {
    const res = await app.request('/season-runs', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify(run({ seasonLabel: 'clobber attempt' })),
    });
    assert.equal(res.status, 409);
    const still = await repo.getSeasonRun('dolphins', 'sr-1');
    assert.equal(still?.seasonLabel, '2026/27');
  });

  test('a club rep cannot start a season', async () => {
    const res = await app.request('/season-runs', {
      method: 'POST',
      headers: headers(REP),
      body: JSON.stringify(run({ id: 'sr-rep' })),
    });
    assert.equal(res.status, 403);
  });

  test('missing snapshots are rejected — they are the whole point of a run', async () => {
    for (const [field, body] of [
      ['structure', { ...run({ id: 'sr-x' }), structureSnapshot: undefined }],
      ['calendar', { ...run({ id: 'sr-x' }), calendarSnapshot: undefined }],
    ] as const) {
      const res = await app.request('/season-runs', {
        method: 'POST',
        headers: headers(ADMIN),
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `a run with no ${field} snapshot should 400`);
    }
  });

  test('a MALFORMED snapshot is rejected by the same guard the operator path uses', async () => {
    // The snapshot is frozen for the season and drives every fixture, so trusting a
    // client-supplied one would bake the damage in permanently.
    const forwardRef: CompetitionStructure = {
      ...STRUCTURE,
      stages: [
        {
          ...STRUCTURE.stages[0]!,
          // Derives from a stage that does not come before it — a cycle or a stage
          // waiting on results that will never arrive.
          entrants: {
            kind: 'manual',
            derivedFrom: { rule: 'from-standings', fromStage: 'stage-later', detail: 'top 6' },
          },
        },
      ],
    };
    const res = await app.request('/season-runs', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify(run({ id: 'sr-bad', structureSnapshot: forwardRef })),
    });
    assert.equal(res.status, 400);
    assert.equal(await repo.getSeasonRun('dolphins', 'sr-bad'), null);
  });

  test('a snapshot calendar with an inverted block is rejected', async () => {
    const res = await app.request('/season-runs', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify(
        run({
          id: 'sr-cal',
          calendarSnapshot: {
            ...CALENDAR,
            blocks: [{ id: 'b1', label: 'Block 1', start: '2026-12-13', end: '2026-09-13' }],
          },
        }),
      ),
    });
    assert.equal(res.status, 400);
  });
});

describe('PATCH /season-runs/:id', () => {
  test('snapshots are STRIPPED, not rejected — a whole-object round trip still works', async () => {
    const res = await app.request('/season-runs/sr-1', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        ...run(),
        // The obvious client implementation sends the whole run back, including a
        // tampered structure. It must neither 400 nor take.
        structureSnapshot: { ...STRUCTURE, name: 'Rewritten mid-season' },
        stages: [{ specId: 'stage-1', status: 'ready', groups: [] }],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as SeasonRun;
    assert.equal(body.structureSnapshot.name, 'Flat round robin');
    assert.equal(body.stages[0]?.status, 'ready');
    assert.equal(body.version, 2);
  });

  test('audit actor and time are stamped SERVER-side — a client-supplied `by` is worthless', async () => {
    const current = await repo.getSeasonRun('dolphins', 'sr-1');
    const res = await app.request('/season-runs/sr-1', {
      method: 'PATCH',
      headers: headers(ADMIN2),
      body: JSON.stringify({
        version: current!.version,
        stages: [
          {
            specId: 'stage-1',
            status: 'generated',
            groups: [],
            audit: [
              {
                at: '1999-01-01T00:00:00.000Z',
                by: 'chairman@rival-club', // relegation decisions ride on this field
                prefill: [['a', 'b']],
                accepted: true,
              },
            ],
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const entry = ((await res.json()) as SeasonRun).stages[0]!.audit![0]!;
    assert.equal(entry.by, 'other@test');
    assert.notEqual(entry.at, '1999-01-01T00:00:00.000Z');
    // What the client alone knows — what was proposed, and whether the human took it —
    // is kept.
    assert.deepEqual(entry.prefill, [['a', 'b']]);
    assert.equal(entry.accepted, true);
  });

  test('EARLIER audit entries keep their original actor and time', async () => {
    // The client resubmits the whole accumulated array (stages is a whole-array
    // replace), so a naive "stamp everything you were sent" rewrites the history: after
    // two confirmations the trail reads as one person at one instant. That is exactly
    // the record relegation and the points carry ride on.
    const first = (
      (await (
        await app.request('/season-runs/sr-1', { headers: headers(ADMIN) })
      ).json()) as SeasonRun
    ).stages[0]!.audit![0]!;
    assert.equal(first.by, 'other@test', 'precondition: entry 1 was stamped by ADMIN2');

    const current = await repo.getSeasonRun('dolphins', 'sr-1');
    const res = await app.request('/season-runs/sr-1', {
      method: 'PATCH',
      headers: headers(ADMIN), // a DIFFERENT admin confirms the next stage
      body: JSON.stringify({
        version: current!.version,
        stages: [
          {
            specId: 'stage-1',
            status: 'generated',
            groups: [],
            // …echoing the stored entry back, exactly as the client does.
            audit: [first, { at: '', by: '', prefill: [['c']], accepted: false }],
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const audit = ((await res.json()) as SeasonRun).stages[0]!.audit!;
    assert.equal(audit.length, 2);
    assert.equal(audit[0]!.by, 'other@test', 'entry 1 must keep its original actor');
    assert.equal(audit[0]!.at, first.at, 'entry 1 must keep its original time');
    assert.equal(audit[1]!.by, 'admin@test', 'entry 2 is stamped with the caller');
    assert.deepEqual(audit[1]!.prefill, [['c']]);
  });

  test('a client cannot truncate or rewrite the stored history', async () => {
    const current = await repo.getSeasonRun('dolphins', 'sr-1');
    const res = await app.request('/season-runs/sr-1', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        version: current!.version,
        // Both entries dropped, and the survivor's actor forged.
        stages: [
          {
            specId: 'stage-1',
            status: 'generated',
            groups: [],
            audit: [
              { at: '2020-01-01T00:00:00.000Z', by: 'nobody@evil', prefill: [], accepted: true },
            ],
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const audit = ((await res.json()) as SeasonRun).stages[0]!.audit!;
    assert.equal(audit.length, 2, 'the stored prefix always wins');
    assert.equal(audit[0]!.by, 'other@test');
    assert.equal(audit[1]!.by, 'admin@test');
  });

  test('a non-array audit is normalised rather than stored raw', async () => {
    // Stored raw, the NEXT patch reads `prior.length` off a string — its character count
    // — silently dropping the genuine entry and spreading the old value into characters.
    const current = await repo.getSeasonRun('dolphins', 'sr-1');
    const res = await app.request('/season-runs/sr-1', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        version: current!.version,
        stages: [
          { specId: 'stage-1', status: 'ready', groups: [] },
          { specId: 'stage-new', status: 'ready', groups: [], audit: 'not an array' },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const stages = ((await res.json()) as SeasonRun).stages;
    assert.deepEqual(stages[1]!.audit, [], 'a junk audit becomes an empty array');
    assert.equal(stages[0]!.audit!.length, 2, 'and the real trail is untouched');
  });

  test('PATCH re-applies the create-time guards', async () => {
    const current = await repo.getSeasonRun('dolphins', 'sr-1');
    const bad = async (patch: unknown, why: string) => {
      const res = await app.request('/season-runs/sr-1', {
        method: 'PATCH',
        headers: headers(ADMIN),
        body: JSON.stringify({ version: current!.version, ...(patch as object) }),
      });
      assert.equal(res.status, 400, `expected 400 for ${why}`);
    };
    await bad({ stages: 'nope' }, 'a non-array stages');
    await bad(
      { stages: Array.from({ length: 21 }, (_, i) => ({ specId: `s${i}`, groups: [] })) },
      '21 stages',
    );
    // seasonLabel is the gsi1 sort key — blank writes an empty gsi1sk, which real
    // DynamoDB rejects and which would drop the run out of the listing.
    await bad({ seasonLabel: '  ' }, 'a blank season label');
  });

  test('a stale version is a 409, never a silent last-write-wins over a relegation', async () => {
    const res = await app.request('/season-runs/sr-1', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ version: 1, stages: [] }),
    });
    assert.equal(res.status, 409);
  });

  test('an unknown run is a 404', async () => {
    const res = await app.request('/season-runs/nope', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({ stages: [] }),
    });
    assert.equal(res.status, 404);
  });
});

describe('DELETE /season-runs/:id', () => {
  test('deleting a run leaves the series its stages produced alone', async () => {
    // Those are real, possibly-released fixtures clubs and players have already seen.
    await repo.putSeasonRun('dolphins', run({ id: 'sr-del' }));
    await repo.putSeries('dolphins', {
      id: 's-from-run',
      name: 'Stage 1 · Top Six',
      leagueKey: 'premier-men',
      seasonRunId: 'sr-del',
      participants: [],
      fixtures: [],
      version: 1,
    } as never);

    const res = await app.request('/season-runs/sr-del', {
      method: 'DELETE',
      headers: headers(ADMIN),
    });
    assert.equal(res.status, 200);
    assert.equal(await repo.getSeasonRun('dolphins', 'sr-del'), null);
    assert.ok(
      await repo.getSeries('dolphins', 's-from-run'),
      'the series must survive its run being deleted',
    );
  });
});

describe('POST /series guards the gsi1 sort key', () => {
  // `startDate` IS `gsi1sk`. DynamoDB rejects an empty string for a key attribute, but
  // dynalite accepts it — so the only place this can be caught is the route, and a
  // client that sent one would 500 part-way through a multi-group generate having
  // already written the earlier series. A `manual` stage plans no rounds, so it is the
  // realistic source of a blank one.
  const series = (over: Record<string, unknown> = {}) => ({
    id: 's-guard',
    name: 'Guard test',
    leagueKey: 'premier-men',
    startDate: '2026-09-13',
    participants: [],
    fixtures: [],
    ...over,
  });

  test('a blank start date is a 400, not a 500 half-way through', async () => {
    for (const [why, bad] of [
      ['empty string', ''],
      ['whitespace', '   '],
      ['missing', undefined],
      ['non-string', 12345],
    ] as const) {
      const res = await app.request('/series', {
        method: 'POST',
        headers: headers(ADMIN),
        body: JSON.stringify(series({ startDate: bad })),
      });
      assert.equal(res.status, 400, `expected 400 for a ${why} start date`);
    }
    assert.equal(await repo.getSeries('dolphins', 's-guard'), null, 'nothing should persist');
  });

  test('a real start date still creates', async () => {
    const res = await app.request('/series', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify(series()),
    });
    assert.equal(res.status, 201);
    assert.equal((await repo.getSeries('dolphins', 's-guard'))?.startDate, '2026-09-13');
  });

  // `putSeries` is an unconditional Put and this body is always built fresh with
  // `released: false`, `releasedAt: null`, `version: 1`. Season-run generation derives
  // deterministic ids, so a client working from a stale series cache can take the create
  // branch for a series that already exists — silently recalling a schedule clubs and
  // players have been sent, and resetting the concurrency counter that guards every
  // subsequent write.
  test('a POST can never overwrite an existing series', async () => {
    await repo.updateSeries('dolphins', 's-guard', {
      released: true,
      releasedAt: '2026-08-01T00:00:00.000Z',
      version: 1,
    });

    const res = await app.request('/series', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify(series({ name: 'Clobber attempt' })),
    });
    assert.equal(res.status, 409);

    const after = await repo.getSeries('dolphins', 's-guard');
    assert.equal(after?.released, true, 'the release must survive');
    assert.equal(after?.releasedAt, '2026-08-01T00:00:00.000Z');
    assert.equal(after?.name, 'Guard test', 'and the POSTed body must not have landed');
    assert.ok((after?.version ?? 0) > 1, 'the version must not reset to 1');
  });
});

describe('erasure reaches venues and season runs', () => {
  // VENUE# rows sit at pk `TENANT#<t>` — ABOVE the `TENANT#<t>#…` prefix sweep — so they
  // only go if the sweep enumerates them explicitly. Miss them and a deleted tenant's
  // ground list (with club associations) survives in the table.
  const T = 'erasevenues';

  test('eraseTenantData removes both', async () => {
    await repo.putVenue(T, venue({ id: 'v1', name: 'Ground One' }));
    await repo.putSeasonRun(T, run({ id: 'sr-e' }));
    assert.equal((await repo.listVenues(T)).length, 1);
    assert.equal((await repo.listSeasonRuns(T)).length, 1);

    await repo.eraseTenantData(T);

    assert.deepEqual(await repo.listVenues(T), [], 'venues must not survive erasure');
    assert.deepEqual(await repo.listSeasonRuns(T), [], 'season runs must not survive erasure');
  });

  test('clearCohort removes season runs but leaves the ground list', async () => {
    // Venues are setup data, not cohort data: wiping demo clubs should not force the
    // union office to retype every ground.
    const C = 'cohortvenues';
    await repo.putVenue(C, venue({ id: 'v1', name: 'Ground One' }));
    await repo.putSeasonRun(C, run({ id: 'sr-c' }));

    await repo.clearCohort(C);

    assert.equal((await repo.listSeasonRuns(C)).length, 0, 'season runs are cohort data');
    assert.equal((await repo.listVenues(C)).length, 1, 'venues are setup data');
  });
});
