/**
 * Integration tests for the release clash gate on PATCH /series: a series carrying a
 * ground/date/time double-booking (against ANY other series, draft or released, or
 * within itself) must not release — releasing publishes the schedule to clubs. Also
 * pins the escape routes: recalls are never blocked, and fixing the venue (or the
 * clash being at a multi-surface registry ground) unblocks release.
 *
 * Same harness as season-venues.int.test.ts: in-process dynalite + the REAL Hono app
 * via app.request(). Auth uses the dev bypass (LOCAL_AUTH=1, x-dev-auth).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Series, Venue } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4611; // distinct from api.int (4599), platform.int (4601), logo-offline (4603), tutorial-offline (4604), backfill-team (4605), season-venues (4607), migrate-block-index (4609)
const TABLE = 'SmartClubReleaseGateTest';
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
const headers = {
  'x-tenant': 'dolphins',
  'x-dev-auth': ADMIN,
  'content-type': 'application/json',
};

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

const patchRelease = (id: string, version: number, extra: Record<string, unknown> = {}) =>
  app.request(`/series/${id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ released: true, version, ...extra }),
  });

describe('release clash gate', () => {
  test('a clash with another DRAFT series blocks release with the clash in the message', async () => {
    // Two draft series, one fixture each: same explicit ground, same date, same time.
    await repo.putSeries(
      'dolphins',
      series('s-gate-a', {
        fixtures: [
          {
            id: 'f1',
            round: 1,
            date: '2026-09-27',
            time: '09:00',
            home: 'home-club',
            away: 'away-club',
            venueName: 'Chatsworth Oval',
          },
        ],
      }),
    );
    await repo.putSeries(
      'dolphins',
      series('s-gate-b', {
        fixtures: [
          {
            id: 'f1',
            round: 1,
            date: '2026-09-27',
            time: '09:00',
            home: 'away-club',
            away: 'home-club',
            venueName: 'CHATSWORTH OVAL',
          },
        ],
      }),
    );

    const res = await patchRelease('s-gate-a', 1);
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error?: string; message?: string };
    const msg = String(body.error ?? body.message ?? JSON.stringify(body));
    assert.match(msg, /Release blocked/);
    assert.match(msg, /Chatsworth Oval/i);

    const after = await repo.getSeries('dolphins', 's-gate-a');
    assert.equal(after?.released, false, 'the release must not have gone through');
  });

  test('fixing the venue unblocks release; the other series then clashes-free too', async () => {
    const cur = await repo.getSeries('dolphins', 's-gate-a');
    await repo.updateSeries('dolphins', 's-gate-a', {
      fixtures: [
        {
          id: 'f1',
          round: 1,
          date: '2026-09-27',
          time: '09:00',
          home: 'home-club',
          away: 'away-club',
          venueName: 'Toti 1',
        },
      ],
      version: cur!.version,
    });
    const fresh = await repo.getSeries('dolphins', 's-gate-a');
    // Editing fixtures on a draft recalls approval server-side — re-approve in the patch.
    const res = await patchRelease('s-gate-a', Number(fresh!.version), { approved: true });
    assert.equal(res.status, 200);
    const released = await repo.getSeries('dolphins', 's-gate-a');
    assert.equal(released?.released, true);
  });

  test('same slot at a 2-surface registry ground is NOT a clash', async () => {
    await repo.putVenue('dolphins', {
      id: 'v-two-fields',
      name: 'Two Fields Park',
      surfaces: 2,
    } as Venue);
    await repo.putSeries(
      'dolphins',
      series('s-gate-c', {
        fixtures: [
          {
            id: 'f1',
            round: 1,
            date: '2026-10-04',
            time: '09:00',
            home: 'home-club',
            away: 'away-club',
            venueName: 'Two Fields Park',
          },
        ],
      }),
    );
    await repo.putSeries(
      'dolphins',
      series('s-gate-d', {
        fixtures: [
          {
            id: 'f1',
            round: 1,
            date: '2026-10-04',
            time: '09:00',
            home: 'away-club',
            away: 'home-club',
            venueName: 'Two Fields Park',
          },
        ],
      }),
    );
    const res = await patchRelease('s-gate-d', 1);
    assert.equal(res.status, 200);
  });

  test('an INTERNAL double-booking blocks release', async () => {
    await repo.putSeries(
      'dolphins',
      series('s-gate-e', {
        fixtures: [
          {
            id: 'f1',
            round: 1,
            date: '2026-10-11',
            time: '09:00',
            home: 'home-club',
            away: 'away-club',
            venueName: 'Danville',
          },
          {
            id: 'f2',
            round: 1,
            date: '2026-10-11',
            time: '09:00',
            home: 'away-club',
            away: 'home-club',
            venueName: 'Danville',
          },
        ],
      }),
    );
    const res = await patchRelease('s-gate-e', 1);
    assert.equal(res.status, 409);
  });

  test('an untimed fixture owns its ground-day — a timed fixture there cannot release', async () => {
    await repo.putSeries(
      'dolphins',
      series('s-gate-f', {
        fixtures: [
          {
            id: 'f1',
            round: 1,
            date: '2026-10-18',
            home: 'home-club',
            away: 'away-club',
            venueName: 'Kuswag',
          },
        ],
      }),
    );
    await repo.putSeries(
      'dolphins',
      series('s-gate-g', {
        fixtures: [
          {
            id: 'f1',
            round: 1,
            date: '2026-10-18',
            time: '13:00',
            home: 'away-club',
            away: 'home-club',
            venueName: 'Kuswag',
          },
        ],
      }),
    );
    const res = await patchRelease('s-gate-g', 1);
    assert.equal(res.status, 409);
  });

  test('recall (released: false) is never blocked, even while the clash exists', async () => {
    // s-gate-a is released; give it back a clash by releasing... no — recall it while
    // s-gate-e (clashing internally) exists elsewhere: recalls skip the gate entirely.
    const cur = await repo.getSeries('dolphins', 's-gate-a');
    const res = await app.request('/series/s-gate-a', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ released: false, version: cur!.version }),
    });
    assert.equal(res.status, 200);
    const after = await repo.getSeries('dolphins', 's-gate-a');
    assert.equal(after?.released, false);
  });

  test('cancelled fixtures do not book the ground', async () => {
    await repo.putSeries(
      'dolphins',
      series('s-gate-h', {
        fixtures: [
          {
            id: 'f1',
            round: 1,
            date: '2026-10-25',
            time: '09:00',
            home: 'home-club',
            away: 'away-club',
            venueName: 'Northcroft',
            status: 'cancelled',
          },
        ],
      }),
    );
    await repo.putSeries(
      'dolphins',
      series('s-gate-i', {
        fixtures: [
          {
            id: 'f1',
            round: 1,
            date: '2026-10-25',
            time: '09:00',
            home: 'away-club',
            away: 'home-club',
            venueName: 'Northcroft',
          },
        ],
      }),
    );
    const res = await patchRelease('s-gate-i', 1);
    assert.equal(res.status, 200);
  });
});
