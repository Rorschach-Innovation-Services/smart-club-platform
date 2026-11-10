/**
 * Official erase (DELETE /umpires/:id, /scorers/:id + erase-preview) through the REAL Hono app
 * on an in-process dynalite. Contract: docs/api/officials.md. Run with tsx --test.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { CaptainsReport, Series } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4823; // unique
const TABLE = 'SmartClubOfficialEraseTest';
const TENANT = 'dolphins';
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
process.env.NOTIFY_DRY_RUN = '1';

const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
const ADMIN = devAuth('admin@test', [{ tenantId: TENANT, role: 'admin', clubIds: [] }]);
const REP = devAuth('rep@test', [{ tenantId: TENANT, role: 'club', clubIds: ['home-club'] }]);

const call = (method: string, path: string, body?: unknown, auth = ADMIN) =>
  app.request(path, {
    method,
    headers: { 'x-tenant': TENANT, 'x-dev-auth': auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const participants = [
  { teamId: 'home-club', clubId: 'home-club', name: 'Home Club' },
  { teamId: 'away-club', clubId: 'away-club', name: 'Away Club' },
];

const PAST = '2020-01-05';
const FUTURE = '2099-01-04';
let TODAY = '';

const series = (id: string, fixtures: unknown[]): Series =>
  ({
    id,
    name: `Series ${id}`,
    leagueKey: 'premier',
    startDate: '2020-01-01',
    teams: participants.map((p) => p.teamId),
    participants,
    fixtures,
    kind: 'series',
    approved: true,
    released: false,
    releasedAt: null,
    version: 1,
  }) as Series;

const fx = (id: string, date: string | undefined, extra: Record<string, unknown> = {}) => ({
  id,
  round: 1,
  ...(date ? { date } : {}),
  time: '09:00',
  home: 'home-club',
  away: 'away-club',
  ...extra,
});

type U = import('../src/types.js').Umpire;
type S = import('../src/types.js').Scorer;
const umpire = (id: string, extra: Partial<U> = {}): U => ({
  id,
  displayName: id,
  fullName: `Full ${id}`,
  aliases: [id.replace(/-/g, '')],
  phone: '+27820000001',
  email: `${id}@example.org`,
  active: true,
  ...extra,
});
const scorer = (id: string, extra: Partial<S> = {}): S => ({
  id,
  displayName: id,
  fullName: `Full ${id}`,
  phone: '+27820000002',
  email: `${id}@example.org`,
  idNumber: '8001015009087',
  emergencyPhone: '+27820000003',
  address: '1 Road',
  active: true,
  ...extra,
});

const report = (
  seriesId: string,
  fixtureId: string,
  clubId: string,
  over: Partial<CaptainsReport>,
): CaptainsReport =>
  ({
    id: `${seriesId}~${fixtureId}~${clubId}`,
    seriesId,
    fixtureId,
    clubId,
    status: 'submitted',
    umpiresSnapshot: [],
    umpires: [],
    captainName: 'Cap',
    general: '',
    declaration: true,
    createdAt: '2020-01-05T10:00:00Z',
    ...over,
  }) as unknown as CaptainsReport;

const card = (umpireId: string | undefined, name: string, extra: Record<string, unknown> = {}) => ({
  ...(umpireId ? { umpireId } : {}),
  name,
  ratings: { decisions: 4 },
  concerns: {},
  otherConcern: '',
  comments: '',
  ...extra,
});

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let erase: typeof import('../src/official-erase.js');

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
  erase = await import('../src/official-erase.js');
  TODAY = (await import('../src/tenant-time.js')).tenantDate();
  for (const p of participants) await repo.putClub(TENANT, { id: p.clubId, name: p.name } as never);
});

after(() => new Promise<void>((resolve) => ddbServer.close(() => resolve())));

const officials = (seriesId: string, fixtureId: string) =>
  repo.getFixtureOfficials(TENANT, seriesId, fixtureId);

describe('umpire erase', () => {
  test('vacates not-yet-played fixtures, renames played ones, handles referee; ledger + reports', async () => {
    const id = 'u-x-erase';
    await repo.putUmpire(TENANT, umpire(id));
    await repo.putUmpire(TENANT, umpire('u-other'));
    await repo.putSeries(
      TENANT,
      series('s-er', [
        fx('past', PAST),
        fx('future', FUTURE),
        fx('today', TODAY),
        fx('undated', undefined),
        fx('tbc', PAST, { dateTbc: true }),
        fx('ref-past', PAST),
        fx('ref-future', FUTURE),
      ]),
    );
    const ref = { umpireId: id, name: id };
    const other = { umpireId: 'u-other', name: 'u-other' };
    await repo.putFixtureOfficials(TENANT, 's-er', 'past', { umpires: [ref, other] });
    await repo.putFixtureOfficials(TENANT, 's-er', 'future', { umpires: [ref, other] });
    await repo.putFixtureOfficials(TENANT, 's-er', 'today', { umpires: [ref] });
    await repo.putFixtureOfficials(TENANT, 's-er', 'undated', { umpires: [ref] });
    await repo.putFixtureOfficials(TENANT, 's-er', 'tbc', { umpires: [ref] });
    await repo.putFixtureOfficials(TENANT, 's-er', 'ref-past', { umpires: [other], referee: ref });
    await repo.putFixtureOfficials(TENANT, 's-er', 'ref-future', {
      umpires: [other],
      referee: ref,
      scorers: [{ scorerId: 'sc-keep', name: 'Keep' }],
    });
    // Ledger: past completed (kept), past queued (deleted), future completed (deleted).
    await repo.queueOfficialsNotify(
      TENANT,
      { seriesId: 's-er', fixtureId: 'past', role: 'umpire', umpireId: id },
      { status: 'completed', reason: 'backfill' },
    );
    await repo.queueOfficialsNotify(TENANT, {
      seriesId: 's-er',
      fixtureId: 'ref-past',
      role: 'referee',
      umpireId: id,
    });
    await repo.queueOfficialsNotify(
      TENANT,
      { seriesId: 's-er', fixtureId: 'future', role: 'umpire', umpireId: id },
      { status: 'completed', reason: 'backfill' },
    );
    await repo.queueOfficialsNotify(TENANT, {
      seriesId: 's-er',
      fixtureId: 'future',
      role: 'umpire',
      umpireId: 'u-other',
    });
    // Reports: a submitted one on a played fixture (all three name fields), a pending one on a
    // dateTbc (not-yet-played) fixture.
    await repo.createCaptainsReport(
      TENANT,
      report('s-er', 'past', 'home-club', {
        umpiresSnapshot: [ref, other],
        umpires: [
          card(id, id),
          card(id, id, {
            attributed: { action: 'linked', by: 'a', at: 'x', freeTextName: 'Typed Name' },
          }),
        ] as never,
      }),
    );
    await repo.createCaptainsReport(
      TENANT,
      report('s-er', 'tbc', 'home-club', {
        status: 'pending',
        umpiresSnapshot: [other, ref],
        umpires: [card('u-other', 'u-other'), card(id, id)] as never,
      }),
    );

    const preview = await call('GET', `/umpires/${id}/erase-preview`);
    assert.equal(preview.status, 200);
    const pv = (await preview.json()) as import('../src/official-erase.js').ErasePreview;
    assert.deepEqual(pv.counts, { today: 1, upcoming: 4, played: 2 });
    assert.deepEqual(pv.vacated.map((v) => v.fixtureId).sort(), [
      'future',
      'ref-future',
      'tbc',
      'today',
      'undated',
    ]);
    assert.equal(pv.vacated.find((v) => v.fixtureId === 'future')?.label, 'Home Club v Away Club');

    const res = await call('DELETE', `/umpires/${id}`);
    assert.equal(res.status, 200, await res.clone().text());
    const out = (await res.json()) as import('../src/official-erase.js').EraseResult;
    assert.deepEqual(out.erased, [id]);
    assert.equal(out.hardDeleted, false);
    assert.equal(out.vacated.length, 5);

    const stub = (await repo.getUmpire(TENANT, id))!;
    assert.equal(stub.displayName, 'Removed umpire');
    assert.deepEqual(stub.aliases, []);
    assert.equal(stub.active, false);
    assert.ok(stub.erasedAt);
    assert.equal(stub.erasedBy, 'admin@test');
    for (const k of ['fullName', 'phone', 'email'] as const) assert.equal(stub[k], undefined);

    assert.deepEqual((await officials('s-er', 'past'))!.umpires, [
      { umpireId: id, name: 'Removed umpire' },
      other,
    ]);
    assert.deepEqual((await officials('s-er', 'future'))!.umpires, [other]);
    for (const f of ['today', 'undated', 'tbc'])
      assert.equal(await officials('s-er', f), null, `${f}: item deleted once empty`);
    assert.deepEqual((await officials('s-er', 'ref-past'))!.referee, {
      umpireId: id,
      name: 'Removed umpire',
    });
    const rf = (await officials('s-er', 'ref-future'))!;
    assert.equal(rf.referee, undefined);
    assert.deepEqual(rf.scorers, [{ scorerId: 'sc-keep', name: 'Keep' }], 'other fields survive');

    const ledger = (await repo.listOfficialsNotify(TENANT)).filter((r) => r.seriesId === 's-er');
    assert.deepEqual(ledger.map((r) => `${r.fixtureId}/${r.umpireId}/${r.status}`).sort(), [
      `future/u-other/queued`,
      `past/${id}/completed`,
    ]);

    const sub = (await repo.getCaptainsReport(TENANT, 's-er', 'past', 'home-club'))!;
    assert.equal(sub.umpiresSnapshot[0].name, 'Removed umpire');
    assert.equal(sub.umpiresSnapshot[1].name, 'u-other');
    assert.equal(sub.umpires[0].name, 'Removed umpire');
    assert.equal(sub.umpires[1].attributed?.freeTextName, 'Removed umpire');
    assert.equal(sub.umpires[0].ratings.decisions, 4, 'ratings stay keyed to the id');
    assert.equal(sub.umpires[0].umpireId, id);
    const pend = (await repo.getCaptainsReport(TENANT, 's-er', 'tbc', 'home-club'))!;
    assert.deepEqual(pend.umpiresSnapshot, [other]);
    assert.deepEqual(
      pend.umpires.map((u) => u.umpireId),
      ['u-other'],
    );

    // Admin list keeps the stub, flagged; the club list hides it.
    const list = (await (await call('GET', '/umpires')).json()) as Array<{
      id: string;
      erased?: true;
    }>;
    assert.equal(list.find((u) => u.id === id)?.erased, true);
    const clubList = (await (await call('GET', '/umpires', undefined, REP)).json()) as Array<{
      id: string;
    }>;
    assert.ok(!clubList.some((u) => u.id === id));

    const logs = (await repo.listOfficialEraseLogs(TENANT)).filter((l) => l.officialId === id);
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0].counts, { records: 1, vacated: 5, renamed: 2, ledger: 2, reports: 2 });
    assert.ok(!JSON.stringify(logs[0]).includes('example.org'), 'audit is PII-free');
  });

  test('merged-source cascade wipes the duplicates; ratings still resolve via the chain', async () => {
    await repo.putUmpire(TENANT, umpire('u-root'));
    await repo.putUmpire(TENANT, umpire('u-dup1', { active: false, mergedInto: 'u-root' }));
    await repo.putUmpire(TENANT, umpire('u-dup2', { active: false, mergedInto: 'u-dup1' }));
    await repo.putUmpire(TENANT, umpire('u-unrelated'));
    await repo.putSeries(TENANT, series('s-cas', [fx('p', PAST)]));
    await repo.createCaptainsReport(
      TENANT,
      report('s-cas', 'p', 'home-club', { umpires: [card('u-dup2', 'u-dup2')] as never }),
    );
    const res = await call('DELETE', '/umpires/u-root');
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { erased: string[] }).erased.sort(), [
      'u-dup1',
      'u-dup2',
      'u-root',
    ]);
    const list = (await (await call('GET', '/umpires')).json()) as U[];
    const byId = new Map(list.map((u) => [u.id, u]));
    for (const x of ['u-root', 'u-dup1', 'u-dup2']) {
      const u = byId.get(x)!;
      assert.equal(u.displayName, 'Removed umpire');
      assert.equal(u.phone, undefined);
      assert.equal(u.email, undefined);
      assert.equal(u.fullName, undefined);
    }
    assert.equal(byId.get('u-unrelated')!.phone, '+27820000001');
    // The rating on the duplicate's id resolves through mergedInto to the (stub) root.
    let cur = 'u-dup2';
    while (byId.get(cur)?.mergedInto) cur = byId.get(cur)!.mergedInto!;
    assert.equal(cur, 'u-root');
    const r = (await repo.getCaptainsReport(TENANT, 's-cas', 'p', 'home-club'))!;
    assert.equal(r.umpires[0].name, 'Removed umpire');
    assert.equal(r.umpires[0].ratings.decisions, 4);
  });

  test('a failure mid-walk leaves a state that DELETE re-run completes', async () => {
    const id = 'u-crash';
    await repo.putUmpire(TENANT, umpire(id));
    await repo.putSeries(
      TENANT,
      series('s-crash', [fx('a', FUTURE), fx('b', FUTURE), fx('c', PAST)]),
    );
    for (const f of ['a', 'b', 'c'])
      await repo.putFixtureOfficials(TENANT, 's-crash', f, {
        umpires: [{ umpireId: id, name: id }],
      });
    await repo.queueOfficialsNotify(TENANT, {
      seriesId: 's-crash',
      fixtureId: 'a',
      role: 'umpire',
      umpireId: id,
    });
    await repo.createCaptainsReport(
      TENANT,
      report('s-crash', 'c', 'home-club', {
        umpiresSnapshot: [{ umpireId: id, name: id }],
        umpires: [card(id, id)] as never,
      }),
    );
    let puts = 0;
    const flaky = {
      ...repo,
      putFixtureOfficials: async (...args: Parameters<typeof repo.putFixtureOfficials>) => {
        if (++puts === 2) throw new Error('injected');
        return repo.putFixtureOfficials(...args);
      },
    };
    await assert.rejects(
      erase.eraseOfficial(flaky, TENANT, 'umpire', id, 'admin@test', TODAY),
      /injected/,
    );
    assert.equal((await repo.getUmpire(TENANT, id))!.phone, undefined, 'PII gone before the walk');
    assert.equal(
      (await repo.getCaptainsReport(TENANT, 's-crash', 'c', 'home-club'))!.umpires[0].name,
      id,
      'reports come after the fixtures, so the crash left this one for the re-run',
    );
    const res = await call('DELETE', `/umpires/${id}`);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(await officials('s-crash', 'a'), null);
    assert.equal(await officials('s-crash', 'b'), null);
    assert.equal((await officials('s-crash', 'c'))!.umpires[0].name, 'Removed umpire');
    assert.equal(
      (await repo.listOfficialsNotify(TENANT)).filter((r) => r.seriesId === 's-crash').length,
      0,
    );
    const stub = (await repo.getUmpire(TENANT, id))!;
    assert.equal(stub.displayName, 'Removed umpire');
    const rep = (await repo.getCaptainsReport(TENANT, 's-crash', 'c', 'home-club'))!;
    assert.equal(rep.umpires[0].name, 'Removed umpire');
    assert.equal(rep.umpiresSnapshot[0].name, 'Removed umpire');
  });

  test('a report opened while the fixtures are being rewritten is still scrubbed', async () => {
    const id = 'u-opening';
    await repo.putUmpire(TENANT, umpire(id));
    await repo.putSeries(TENANT, series('s-open', [fx('p', PAST)]));
    await repo.putFixtureOfficials(TENANT, 's-open', 'p', {
      umpires: [{ umpireId: id, name: id }],
    });
    const opening = {
      ...repo,
      putFixtureOfficials: async (...args: Parameters<typeof repo.putFixtureOfficials>) => {
        // A result lands mid-erase and opens a report from the (still real-name) officials row.
        await repo.createCaptainsReport(
          TENANT,
          report('s-open', 'p', 'away-club', {
            status: 'pending',
            umpiresSnapshot: [{ umpireId: id, name: id }],
            umpires: [card(id, id)] as never,
          }),
        );
        return repo.putFixtureOfficials(...args);
      },
    };
    await erase.eraseOfficial(opening, TENANT, 'umpire', id, 'admin@test', TODAY);
    const r = (await repo.getCaptainsReport(TENANT, 's-open', 'p', 'away-club'))!;
    assert.equal(r.umpiresSnapshot[0].name, 'Removed umpire');
    assert.equal(r.umpires[0].name, 'Removed umpire');
  });

  test('a pending report drops a substitute card naming the erased id; submitted keeps it', async () => {
    const id = 'u-sub';
    await repo.putUmpire(TENANT, umpire(id));
    await repo.putSeries(TENANT, series('s-sub', [fx('p', PAST)]));
    const appointed = { umpireId: 'u-other', name: 'u-other' };
    for (const [club, status] of [
      ['home-club', 'pending'],
      ['away-club', 'submitted'],
    ] as const)
      await repo.createCaptainsReport(
        TENANT,
        report('s-sub', 'p', club, {
          status,
          umpiresSnapshot: [appointed],
          umpires: [card('u-other', 'u-other'), card(id, id, { substitute: true })] as never,
        }),
      );
    await call('DELETE', `/umpires/${id}`);
    const pend = (await repo.getCaptainsReport(TENANT, 's-sub', 'p', 'home-club'))!;
    assert.deepEqual(
      pend.umpires.map((u) => u.umpireId),
      ['u-other'],
    );
    assert.deepEqual(pend.umpiresSnapshot, [appointed]);
    const sub = (await repo.getCaptainsReport(TENANT, 's-sub', 'p', 'away-club'))!;
    assert.equal(sub.umpires[1].umpireId, id);
    assert.equal(sub.umpires[1].name, 'Removed umpire');
  });

  test('GET /series shows the placeholder on a played fixture after erase', async () => {
    const list = (await (await call('GET', '/series')).json()) as Array<{
      id: string;
      fixtures: Array<{
        id: string;
        officials?: { umpires: Array<{ umpireId: string; name: string }> };
      }>;
    }>;
    const past = list.find((x) => x.id === 's-er')!.fixtures.find((f) => f.id === 'past')!;
    const mine = past.officials!.umpires.find((u) => u.umpireId === 'u-x-erase')!;
    assert.equal(mine.name, 'Removed umpire');
  });

  test('the attribute route refuses erased and pending ids', async () => {
    await repo.putUmpire(TENANT, umpire('u-attr-pending', { active: false, pending: true }));
    await repo.putSeries(TENANT, series('s-attr', [fx('p', PAST)]));
    await repo.createCaptainsReport(
      TENANT,
      report('s-attr', 'p', 'home-club', {
        umpires: [card(undefined, 'Free Text')] as never,
        recipient: { memberId: 'm-1', name: 'Cap' },
      } as never),
    );
    for (const umpireId of ['u-x-erase', 'u-attr-pending']) {
      const res = await call('POST', '/captains-reports/s-attr~p~home-club/umpires/0/attribute', {
        umpireId,
      });
      assert.equal(res.status, 400, umpireId);
    }
    const ok = await call('POST', '/captains-reports/s-attr~p~home-club/umpires/0/attribute', {
      umpireId: 'u-other',
    });
    assert.equal(ok.status, 200, await ok.clone().text());
  });

  test('an officials row without umpires does not break an umpire erase', async () => {
    await repo.putUmpire(TENANT, umpire('u-norow'));
    await repo.putSeries(TENANT, series('s-norow', [fx('p', PAST)]));
    // A legacy row with no `umpires` attribute at all (written directly: the repo always sets it).
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, PutCommand } = await import('@aws-sdk/lib-dynamodb');
    const { fixtureOfficialsKey } = await import('../src/keys.js');
    const doc = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        endpoint: process.env.DYNAMO_ENDPOINT,
        region: 'localhost',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      }),
    );
    await doc.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          ...fixtureOfficialsKey(TENANT, 's-norow', 'p'),
          seriesId: 's-norow',
          fixtureId: 'p',
          referee: { umpireId: 'u-norow', name: 'u-norow' },
        },
      }),
    );
    const res = await call('DELETE', '/umpires/u-norow');
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual((await officials('s-norow', 'p'))!.referee, {
      umpireId: 'u-norow',
      name: 'Removed umpire',
    });
  });

  test('reject skips the walk: no series, officials, ledger or report reads', async () => {
    await repo.putUmpire(TENANT, umpire('u-reject', { active: false, pending: true }));
    const touched: string[] = [];
    const spy = new Proxy(repo, {
      get(target, prop: string) {
        if (
          [
            'listSeries',
            'listClubs',
            'listFixtureOfficials',
            'listOfficialsNotify',
            'listCaptainsReports',
          ].includes(prop)
        )
          touched.push(prop);
        return (target as Record<string, unknown>)[prop];
      },
    }) as typeof repo;
    const out = await erase.eraseOfficial(spy, TENANT, 'umpire', 'u-reject', 'admin@test', TODAY);
    assert.equal(out.hardDeleted, true);
    assert.deepEqual(touched, []);
    assert.equal(await repo.getUmpire(TENANT, 'u-reject'), null);
    assert.ok((await repo.listOfficialEraseLogs(TENANT)).some((l) => l.id === out.auditId));
  });

  test('a draft save racing the erase is not lost', async () => {
    const id = 'u-race';
    await repo.putUmpire(TENANT, umpire(id));
    await repo.putSeries(TENANT, series('s-race', [fx('p', PAST)]));
    await repo.createCaptainsReport(
      TENANT,
      report('s-race', 'p', 'home-club', {
        status: 'pending',
        umpiresSnapshot: [{ umpireId: id, name: id }],
        umpires: [card(id, id)] as never,
      }),
    );
    // The draft lands between the erase's report listing and its scrub write.
    const racing = {
      ...repo,
      scrubCaptainsReportUmpires: async (
        ...args: Parameters<typeof repo.scrubCaptainsReportUmpires>
      ) => {
        await repo.saveCaptainsReportDraft(TENANT, args[1], {
          captainName: 'Draft Captain',
          umpires: [
            card(undefined, 'Free Text'),
            card(id, id, { comments: 'late draft' }),
          ] as never,
          general: 'typed while the office erased',
          declaration: false,
        });
        return repo.scrubCaptainsReportUmpires(...args);
      },
    };
    await erase.eraseOfficial(racing, TENANT, 'umpire', id, 'admin@test', TODAY);
    const r = (await repo.getCaptainsReport(TENANT, 's-race', 'p', 'home-club'))!;
    assert.equal(r.captainName, 'Draft Captain');
    assert.equal(r.general, 'typed while the office erased');
    assert.equal(r.umpires[0].name, 'Free Text');
    assert.equal(r.umpires[1].name, 'Removed umpire');
    assert.equal(r.umpires[1].comments, 'late draft');
    assert.equal(r.umpiresSnapshot[0].name, 'Removed umpire');
  });

  test('re-running DELETE on an erased stub is idempotent', async () => {
    const first = (await repo.getUmpire(TENANT, 'u-x-erase'))!;
    const res = await call('DELETE', '/umpires/u-x-erase');
    assert.equal(res.status, 200);
    const again = (await repo.getUmpire(TENANT, 'u-x-erase'))!;
    assert.equal(again.erasedAt, first.erasedAt, 'first erase stamp kept');
  });

  test('a pending registration with no references is hard-deleted', async () => {
    await repo.putUmpire(TENANT, umpire('u-pend', { active: false, pending: true }));
    const res = await call('DELETE', '/umpires/u-pend');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { erased: ['u-pend'], hardDeleted: true, vacated: [] });
    assert.equal(await repo.getUmpire(TENANT, 'u-pend'), null);
  });

  test('404 unknown; non-admin 403', async () => {
    assert.equal((await call('DELETE', '/umpires/u-nobody')).status, 404);
    assert.equal((await call('GET', '/umpires/u-nobody/erase-preview')).status, 404);
    assert.equal((await call('DELETE', '/umpires/u-other', undefined, REP)).status, 403);
    assert.equal((await call('GET', '/umpires/u-other/erase-preview', undefined, REP)).status, 403);
    assert.equal((await call('DELETE', '/scorers/sc-any', undefined, REP)).status, 403);
  });
});

describe('scorer erase', () => {
  test('stubs the scorer, vacates future fixtures, renames past ones, clears ledger', async () => {
    const id = 'sc-erase';
    await repo.putScorer(TENANT, scorer(id));
    await repo.putSeries(TENANT, series('s-sc', [fx('past', PAST), fx('future', FUTURE)]));
    const ump = { umpireId: 'u-other', name: 'u-other' };
    await repo.putFixtureOfficials(TENANT, 's-sc', 'past', {
      umpires: [],
      scorers: [{ scorerId: id, name: id }],
    });
    await repo.putFixtureOfficials(TENANT, 's-sc', 'future', {
      umpires: [ump],
      scorers: [{ scorerId: id, name: id }],
    });
    await repo.queueOfficialsNotify(TENANT, {
      seriesId: 's-sc',
      fixtureId: 'future',
      role: 'scorer',
      umpireId: id,
    });
    // An umpire row with the same id string is NOT the scorer's.
    await repo.queueOfficialsNotify(TENANT, {
      seriesId: 's-sc',
      fixtureId: 'future',
      role: 'umpire',
      umpireId: id,
    });
    const res = await call('DELETE', `/scorers/${id}`);
    assert.equal(res.status, 200, await res.clone().text());
    const stub = (await repo.getScorer(TENANT, id))!;
    assert.equal(stub.displayName, 'Removed scorer');
    for (const k of [
      'fullName',
      'phone',
      'email',
      'idNumber',
      'emergencyPhone',
      'address',
    ] as const)
      assert.equal(stub[k], undefined, k);
    assert.deepEqual((await officials('s-sc', 'past'))!.scorers, [
      { scorerId: id, name: 'Removed scorer' },
    ]);
    const fut = (await officials('s-sc', 'future'))!;
    assert.deepEqual(fut.scorers, []);
    assert.deepEqual(fut.umpires, [ump]);
    const ledger = (await repo.listOfficialsNotify(TENANT)).filter((r) => r.seriesId === 's-sc');
    assert.deepEqual(
      ledger.map((r) => r.role),
      ['umpire'],
    );
    const list = (await (await call('GET', '/scorers')).json()) as Array<{
      id: string;
      erased?: true;
    }>;
    assert.equal(list.find((x) => x.id === id)?.erased, true);
  });

  test('erase-preview counts for a scorer', async () => {
    await repo.putScorer(TENANT, scorer('sc-prev'));
    await repo.putSeries(TENANT, series('s-scp', [fx('a', TODAY), fx('b', FUTURE)]));
    for (const f of ['a', 'b'])
      await repo.putFixtureOfficials(TENANT, 's-scp', f, {
        umpires: [],
        scorers: [{ scorerId: 'sc-prev', name: 'x' }],
      });
    const pv = (await (await call('GET', '/scorers/sc-prev/erase-preview')).json()) as {
      counts: unknown;
    };
    assert.deepEqual(pv.counts, { today: 1, upcoming: 1, played: 0 });
  });
});

describe('tenant erasure', () => {
  test('removes OFFICIALERASE# audit rows', async () => {
    assert.ok((await repo.listOfficialEraseLogs(TENANT)).length > 0);
    await repo.eraseTenantData(TENANT);
    assert.equal((await repo.listOfficialEraseLogs(TENANT)).length, 0);
  });
});
