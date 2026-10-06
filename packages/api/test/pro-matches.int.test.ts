/**
 * The platform match library, end to end through the real Hono app on in-process dynalite:
 * only the operator saves and deletes; union admins read (a page at a time, ball-by-ball
 * included); reps can't; the shape, key and size are checked; the same key replaces.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

const DDB_PORT = 4663; // next free odd port after 4661
const TABLE = 'SmartClubProMatchTest';
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.LOCAL_AUTH = '1';
process.env.USER_POOL_ID = 'test-pool';
process.env.AWS_REGION ??= 'localhost';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_MAX_ATTEMPTS = '1';

const devAuthAs = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const OPERATOR = devAuthAs('op-1', 'operator@platform', [
  { tenantId: '*', role: 'operator', clubIds: [] },
]);
const ADMIN = devAuthAs('admin-1', 'admin@union.test', [
  { tenantId: 'dolphins', role: 'admin', clubIds: [] },
]);
const REP = devAuthAs('rep-1', 'rep@club.test', [
  { tenantId: 'dolphins', role: 'rep', clubIds: ['alpha'] },
]);
const headers = (auth: string) => ({
  'x-dev-auth': auth,
  'x-tenant': 'dolphins',
  'content-type': 'application/json',
});

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];

// An invented match in the standard shape.
const match = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  v: 1,
  id: key,
  date: key.slice(0, 10),
  home: 'Highveld Hawks',
  away: 'Coastal Kestrels',
  gender: 'men',
  format: 'T20',
  event: 'T20',
  stage: 'Invented T20 Cup',
  overs: 20,
  venue: '',
  winner: null,
  result: '',
  season: '2025/26',
  resultKind: 'unknown',
  competition: 'Invented T20 Cup',
  sources: [{ kind: 'scorecard', name: 'card.csv' }],
  hasBalls: true,
  innings: [
    {
      bat: 'Highveld Hawks',
      fld: 'Coastal Kestrels',
      total: 6,
      wkts: 0,
      overs: '0.2',
      extras: 0,
      exb: { w: 0, nb: 0, b: 0, lb: 0 },
      batting: [{ n: 'Ann Hawk', pos: 1, r: 6, b: 2, f4: 0, f6: 1, out: 'not out' }],
      bowling: [{ n: 'Ben Kestrel', o: '0.2', m: 0, r: 6, w: 0, wd: 0, nb: 0, dots: 1 }],
      fow: [],
      perOver: [[1, 6, 0]],
      balls: [
        [1, 1, 'Ann Hawk', 'Ben Kestrel', 0, '', 0, 0, -1],
        [1, 2, 'Ann Hawk', 'Ben Kestrel', 6, '', 0, 0, -1],
      ],
    },
  ],
  ...over,
});

const post = (auth: string, body: unknown) =>
  app.request('/platform/pro/matches', {
    method: 'POST',
    headers: headers(auth),
    body: JSON.stringify(body),
  });

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
});

after(async () => {
  await new Promise<void>((resolve) => ddbServer.close(() => resolve()));
});

describe('platform match library', () => {
  test('only the operator saves; admins read it back whole, ball-by-ball included', async () => {
    assert.equal(
      (await post(ADMIN, { matches: [match('2025-10-12_hawks-v-kestrels_men')] })).status,
      403,
    );
    assert.equal(
      (await post(REP, { matches: [match('2025-10-12_hawks-v-kestrels_men')] })).status,
      403,
    );
    const ok = await post(OPERATOR, { matches: [match('2025-10-12_hawks-v-kestrels_men')] });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { saved: ['2025-10-12_hawks-v-kestrels_men'] });

    const read = await app.request('/admin/pro/matches', { headers: headers(ADMIN) });
    assert.equal(read.status, 200);
    const body = (await read.json()) as {
      matches: { key: string; innings: { balls: unknown[] }[] }[];
      next?: string;
    };
    assert.equal(body.matches.length, 1);
    assert.equal(body.matches[0].innings[0].balls.length, 2);
    assert.equal(body.next, undefined);
    assert.equal((await app.request('/admin/pro/matches', { headers: headers(REP) })).status, 403);
  });

  test('checks the key, the date, the teams, the format and the size', async () => {
    const bad = async (m: unknown, status = 400) =>
      assert.equal((await post(OPERATOR, { matches: [m] })).status, status);
    await bad(match('not a key'));
    await bad(match('2025-10-12_hawks-v-kestrels_men', { date: '2025-10-13' }));
    await bad(match('2025-10-12_hawks-v-kestrels_men', { away: '' }));
    await bad(match('2025-10-12_hawks-v-kestrels_men', { format: 'Hundred' }));
    await bad(match('2025-10-12_hawks-v-kestrels_men', { innings: [] }));
    await bad(match('2025-10-12_hawks-v-kestrels_men', { padding: 'x'.repeat(400_000) }), 413);
    assert.equal(
      (
        await post(OPERATOR, {
          matches: Array.from({ length: 26 }, () => match('2025-10-12_hawks-v-kestrels_men')),
        })
      ).status,
      400,
    );
    assert.equal((await post(OPERATOR, {})).status, 400);
  });

  test('the same key replaces; pages continue with a cursor; the operator deletes', async () => {
    await post(OPERATOR, {
      matches: [match('2025-10-12_hawks-v-kestrels_men', { result: 'Replaced' })],
    });
    const keys = Array.from(
      { length: 17 },
      (_, i) => `2025-11-${String(i + 1).padStart(2, '0')}_hawks-v-kestrels_men`,
    );
    assert.equal((await post(OPERATOR, { matches: keys.map((k) => match(k)) })).status, 200);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await app.request(`/admin/pro/matches${cursor ? `?cursor=${cursor}` : ''}`, {
        headers: headers(ADMIN),
      });
      const b = (await r.json()) as { matches: { key: string; result: string }[]; next?: string };
      seen.push(...b.matches.map((m) => m.key));
      if (b.matches.some((m) => m.key === '2025-10-12_hawks-v-kestrels_men'))
        assert.equal(
          b.matches.find((m) => m.key === '2025-10-12_hawks-v-kestrels_men')!.result,
          'Replaced',
        );
      cursor = b.next;
    } while (cursor);
    assert.equal(seen.length, 18);
    assert.equal(new Set(seen).size, 18);

    const sum = await app.request('/platform/pro/matches?summary=1', {
      headers: headers(OPERATOR),
    });
    const s = (await sum.json()) as {
      summaries: { key: string; hasBalls: boolean; json?: string }[];
    };
    assert.equal(s.summaries.length, 18);
    assert.equal(s.summaries[0].json, undefined);

    assert.equal(
      (
        await app.request('/platform/pro/matches/2025-10-12_hawks-v-kestrels_men', {
          method: 'DELETE',
          headers: headers(ADMIN),
        })
      ).status,
      403,
    );
    const del = await app.request('/platform/pro/matches/2025-10-12_hawks-v-kestrels_men', {
      method: 'DELETE',
      headers: headers(OPERATOR),
    });
    assert.equal(del.status, 200);
    const after1 = await app.request('/platform/pro/matches?summary=1', {
      headers: headers(OPERATOR),
    });
    assert.equal(((await after1.json()) as { summaries: unknown[] }).summaries.length, 17);
  });
});
