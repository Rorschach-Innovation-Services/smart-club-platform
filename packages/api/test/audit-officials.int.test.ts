/**
 * Audit trail, officials (ADR 0023 task 8): field-level old → new values for umpire and scorer
 * add / edit / approve / merge / erase and fixture appointments, through the REAL Hono app on
 * an in-process dynalite. Contract: docs/api/audit.md. Run with tsx --test.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AuditChange, AuditDetail, AuditEntry, Series } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4861; // unique
const TABLE = 'SmartClubAuditOfficialsTest';
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

const devAuth = (sub: string, email: string) =>
  Buffer.from(
    JSON.stringify({
      sub,
      email,
      memberships: [{ tenantId: TENANT, role: 'admin', clubIds: [] }],
    }),
  ).toString('base64');
const ADMIN_A = devAuth('sub-admin-a', 'a@test');
const ADMIN_B = devAuth('sub-admin-b', 'b@test');

const call = (method: string, path: string, body?: unknown, auth = ADMIN_A) =>
  app.request(path, {
    method,
    headers: { 'x-tenant': TENANT, 'x-dev-auth': auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  assert.equal(r.status, status, text);
  return JSON.parse(text) as T;
}

type Page = { items: AuditEntry[]; cursor?: string };
type Entry = { entry: AuditEntry; detail: AuditDetail | null };

const history = (type: string, id: string) =>
  json<Page>(call('GET', `/admin/audit/entity/${type}/${encodeURIComponent(id)}`));
const entryOf = (e: Pick<AuditEntry, 'at' | 'id'>) =>
  json<Entry>(call('GET', `/admin/audit/entry/${encodeURIComponent(e.at)}/${e.id}`));
const changesOf = (d: AuditDetail | null, type: string, id: string): AuditChange[] =>
  d?.targets.find((t) => t.type === type && t.id === id)?.changes ?? [];
const change = (cs: AuditChange[], field: string) => cs.find((c) => c.field === field);

const participants = [
  { teamId: 'home-club', clubId: 'home-club', name: 'Home Club' },
  { teamId: 'away-club', clubId: 'away-club', name: 'Away Club' },
];
const series = (id: string, fixtureIds: string[]): Series =>
  ({
    id,
    name: `Series ${id}`,
    leagueKey: 'premier',
    startDate: '2099-01-01',
    teams: participants.map((p) => p.teamId),
    participants,
    fixtures: fixtureIds.map((f) => ({
      id: f,
      round: 1,
      date: '2099-01-04',
      time: '09:00',
      home: 'home-club',
      away: 'away-club',
    })),
    kind: 'series',
    approved: true,
    released: false,
    releasedAt: null,
    version: 1,
  }) as Series;

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let keys: typeof import('../src/keys.js');

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
  keys = await import('../src/keys.js');
  await repo.putTenantConfig({
    tenant: TENANT,
    branding: { name: 'KZN Dolphins', title: 'KZN Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
  } as unknown as import('../src/types.js').TenantConfig);
  for (const p of participants) await repo.putClub(TENANT, { id: p.clubId, name: p.name } as never);
});

after(() => new Promise<void>((resolve) => ddbServer.close(() => resolve())));

/** Every row of the tenant's current audit month partition (tests may read broadly). */
async function auditRows(): Promise<Record<string, unknown>[]> {
  const { DynamoDBDocumentClient, QueryCommand } = await import('@aws-sdk/lib-dynamodb');
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      endpoint: process.env.DYNAMO_ENDPOINT,
      region: 'localhost',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }),
  );
  const pk = keys.auditPartitionPk(TENANT, keys.auditMonthOf(new Date().toISOString()));
  const items: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': pk },
        ...(start ? { ExclusiveStartKey: start } : {}),
      }),
    );
    items.push(...(res.Items ?? []));
    start = res.LastEvaluatedKey;
  } while (start);
  return items;
}

/** File a real self-registration through the public link (mints the role's link first). */
async function signup(role: 'umpire' | 'scorer', body: Record<string, unknown>): Promise<void> {
  const link = await json<{ url: string }>(call('POST', `/admin/official-signup-link/${role}`));
  const token = new URL(link.url).searchParams.get('t')!;
  const res = await app.request(`/official-signup?t=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ consent: true, ...body }),
  });
  assert.equal(res.status, 200, await res.text());
}

type RequestListener = (req: import('node:http').IncomingMessage, res: unknown) => void;

/**
 * Run `before` just ahead of the next DynamoDB call of `op` (e.g. 'DeleteItem') that reaches
 * the in-process dynalite, then let that call through — a deterministic race.
 */
function interceptNext(op: string, beforeOp: () => Promise<void>): () => void {
  const original = ddbServer.listeners('request')[0] as RequestListener;
  let armed = true;
  ddbServer.removeAllListeners('request');
  ddbServer.on('request', (req: import('node:http').IncomingMessage, res: unknown) => {
    if (armed && req.headers['x-amz-target'] === `DynamoDB_20120810.${op}`) {
      armed = false;
      // No pause(): with no 'data' listener yet the body simply buffers until dynalite reads it.
      void beforeOp().then(() => original(req, res));
    } else original(req, res);
  });
  return () => {
    ddbServer.removeAllListeners('request');
    ddbServer.on('request', original);
  };
}

/** The single entry of `history` with this action (fails on none or several). */
function only(page: Page, action: string): AuditEntry {
  const hits = page.items.filter((e) => e.action === action);
  assert.equal(hits.length, 1, `${action}: ${JSON.stringify(page.items.map((e) => e.action))}`);
  return hits[0];
}

describe('umpire edit (the Dende → Jooma incident)', () => {
  test('create by A, edit by B: the edit names B and shows old and new names and aliases', async () => {
    const created = await json<{ id: string; aliases: string[] }>(
      call('POST', '/umpires', { displayName: 'A.Dende' }, ADMIN_A),
      201,
    );
    assert.equal(created.id, 'u-a-dende');
    const edited = await json<{ aliases: string[] }>(
      call(
        'PATCH',
        '/umpires/u-a-dende',
        { displayName: 'M.Jooma', fullName: 'Muhammad Jooma' },
        ADMIN_B,
      ),
    );

    const page = await history('umpire', 'u-a-dende');
    assert.equal(page.items.length, 2);
    assert.deepEqual(
      page.items.map((e) => e.action),
      ['umpire.update', 'umpire.create'],
    );

    const create = only(page, 'umpire.create');
    assert.equal(create.actor.sub, 'sub-admin-a');
    const createHead = create.targets.find((t) => t.id === 'u-a-dende')!;
    assert.equal(createHead.op, 'create');
    assert.equal(createHead.label, 'A.Dende');
    const createDetail = await entryOf(create);
    const cc = changesOf(createDetail.detail, 'umpire', 'u-a-dende');
    assert.deepEqual(change(cc, 'displayName'), { field: 'displayName', to: 'A.Dende' });
    assert.deepEqual(change(cc, 'active'), { field: 'active', to: true });

    const update = only(page, 'umpire.update');
    assert.equal(update.actor.sub, 'sub-admin-b');
    assert.equal(update.actor.email, 'b@test');
    assert.equal(update.outcome, 'ok');
    const head = update.targets.find((t) => t.type === 'umpire' && t.id === 'u-a-dende')!;
    assert.equal(head.op, 'update');
    assert.equal(head.label, 'M.Jooma');
    assert.equal(head.changeCount, 3);

    const { detail } = await entryOf(update);
    const changes = changesOf(detail, 'umpire', 'u-a-dende');
    assert.deepEqual(change(changes, 'displayName'), {
      field: 'displayName',
      from: 'A.Dende',
      to: 'M.Jooma',
    });
    assert.deepEqual(change(changes, 'fullName'), { field: 'fullName', to: 'Muhammad Jooma' });
    assert.deepEqual(change(changes, 'aliases'), {
      field: 'aliases',
      from: created.aliases,
      to: edited.aliases,
    });
    assert.notDeepEqual(created.aliases, edited.aliases);
  });

  test('a PATCH that changes nothing is still recorded, with zero changes', async () => {
    await json(call('POST', '/umpires', { displayName: 'N.Change' }), 201);
    await json(call('PATCH', '/umpires/u-n-change', { displayName: 'N.Change' }, ADMIN_B));
    const update = only(await history('umpire', 'u-n-change'), 'umpire.update');
    assert.equal(update.actor.sub, 'sub-admin-b');
    const head = update.targets.find((t) => t.id === 'u-n-change')!;
    assert.equal(head.changeCount, 0);
    assert.deepEqual(changesOf((await entryOf(update)).detail, 'umpire', 'u-n-change'), []);
  });
});

describe('scorer masking', () => {
  test('idNumber, address and emergencyPhone are listed as changed, never stored', async () => {
    const secrets = ['8001015009087', '7702025008088', '12 Secret Lane', '99 Hidden Road'];
    const phones = ['+27825550001', '+27825550002'];
    const created = await json<{ id: string }>(
      call('POST', '/scorers', {
        displayName: 'K.Mask',
        idNumber: secrets[0],
        address: secrets[2],
        emergencyPhone: phones[0],
      }),
      201,
    );
    await json(
      call('PATCH', `/scorers/${created.id}`, {
        idNumber: secrets[1],
        address: secrets[3],
        emergencyPhone: phones[1],
        phone: '+27825550003',
      }),
    );
    const page = await history('scorer', created.id);
    for (const action of ['scorer.create', 'scorer.update']) {
      const changes = changesOf((await entryOf(only(page, action))).detail, 'scorer', created.id);
      for (const field of ['idNumber', 'address', 'emergencyPhone'])
        assert.deepEqual(change(changes, field), { field, masked: true }, `${action} ${field}`);
    }
    const update = changesOf(
      (await entryOf(only(page, 'scorer.update'))).detail,
      'scorer',
      created.id,
    );
    assert.deepEqual(change(update, 'phone'), { field: 'phone', to: '+27825550003' });

    const stored = JSON.stringify(await auditRows());
    for (const v of [...secrets, ...phones]) assert.ok(!stored.includes(v), `leaked ${v}`);
  });
});

describe('merge', () => {
  test('names both records, appears in both histories, carries the repointed count', async () => {
    await json(call('POST', '/umpires', { displayName: 'R.Keep' }), 201);
    const dup = await json<{ aliases: string[] }>(
      call('POST', '/umpires', { displayName: 'R.Dupe', fullName: 'Rex Dupe' }),
      201,
    );
    await repo.putSeries(TENANT, series('s-mg', ['f1']));
    await repo.putFixtureOfficials(TENANT, 's-mg', 'f1', {
      umpires: [{ umpireId: 'u-r-dupe', name: 'R.Dupe' }],
    });
    const res = await json<{ target: { aliases: string[] } }>(
      call('POST', '/umpires/u-r-dupe/merge', { targetId: 'u-r-keep' }),
    );

    const keepPage = await history('umpire', 'u-r-keep');
    const dupePage = await history('umpire', 'u-r-dupe');
    const merge = only(keepPage, 'umpire.merge');
    assert.equal(only(dupePage, 'umpire.merge').id, merge.id);
    assert.equal(merge.outcome, 'ok');
    assert.deepEqual(merge.counts, { repointed: 1 });
    const keep = merge.targets.find((t) => t.id === 'u-r-keep')!;
    const source = merge.targets.find((t) => t.id === 'u-r-dupe')!;
    assert.equal(keep.op, 'merge');
    assert.equal(keep.label, 'R.Keep');
    assert.equal(source.op, 'merge-source');
    assert.equal(source.label, 'R.Dupe');

    const { detail } = await entryOf(merge);
    assert.deepEqual(detail!.mentions.map((m) => [m.id, m.label]).sort(), [
      ['u-r-dupe', 'R.Dupe'],
      ['u-r-keep', 'R.Keep'],
    ]);
    const gained = change(changesOf(detail, 'umpire', 'u-r-keep'), 'aliases')!;
    assert.deepEqual(gained.to, res.target.aliases);
    for (const a of dup.aliases) assert.ok((gained.to as string[]).includes(a));
    const retired = changesOf(detail, 'umpire', 'u-r-dupe');
    assert.deepEqual(change(retired, 'active'), { field: 'active', from: true, to: false });
    assert.deepEqual(change(retired, 'mergedInto'), {
      field: 'mergedInto',
      to: 'u-r-keep',
      ref: { type: 'umpire', id: 'u-r-keep' },
    });
  });
});

describe('fixture officials', () => {
  test('an appointment shows in the appointed umpire and scorer histories', async () => {
    await json(call('POST', '/umpires', { displayName: 'F.Appoint' }), 201);
    await json(call('POST', '/umpires', { displayName: 'F.Other' }), 201);
    const scorer = await json<{ id: string }>(
      call('POST', '/scorers', { displayName: 'F.Scorer' }),
      201,
    );
    await repo.putSeries(TENANT, series('s-fo', ['f1']));
    await json(
      call('PUT', '/series/s-fo/fixtures/f1/officials', {
        umpires: [{ umpireId: 'u-f-appoint' }],
        scorers: [{ scorerId: scorer.id }],
      }),
    );
    // Swap the umpire: one removed, one added.
    await json(
      call('PUT', '/series/s-fo/fixtures/f1/officials', { umpires: [{ umpireId: 'u-f-other' }] }),
    );

    const appointedPage = await history('umpire', 'u-f-appoint');
    const sets = appointedPage.items.filter((e) => e.action === 'fixture-officials.set');
    assert.equal(sets.length, 2);
    const [second, first] = sets; // newest first
    const head = first.targets.find((t) => t.type === 'fixture-officials')!;
    assert.equal(head.id, 's-fo#f1');
    assert.equal(head.changeCount, 2);
    assert.deepEqual(changesOf((await entryOf(first)).detail, 'fixture-officials', 's-fo#f1'), [
      { field: 'umpires', to: 'F.Appoint', ref: { type: 'umpire', id: 'u-f-appoint' } },
      { field: 'scorer', to: 'F.Scorer', ref: { type: 'scorer', id: scorer.id } },
    ]);
    assert.deepEqual(changesOf((await entryOf(second)).detail, 'fixture-officials', 's-fo#f1'), [
      { field: 'umpires', from: 'F.Appoint', ref: { type: 'umpire', id: 'u-f-appoint' } },
      { field: 'umpires', to: 'F.Other', ref: { type: 'umpire', id: 'u-f-other' } },
    ]);
    assert.equal(
      only(await history('scorer', scorer.id), 'fixture-officials.set').id,
      first.id,
      'the scorer history holds the first appointment only',
    );
    assert.ok((await history('fixture-officials', 's-fo#f1')).items.length >= 2);
  });
});

describe('self-registration review', () => {
  test('approve records pending → active', async () => {
    await repo.createUmpire(TENANT, {
      id: 'u-p-approve',
      displayName: 'P.Approve',
      aliases: ['papprove'],
      active: false,
      pending: true,
      source: 'self-registration',
      submittedAt: '2026-11-01T08:00:00.000Z',
      consentAt: '2026-11-01T08:00:00.000Z',
    });
    await json(
      call('POST', '/umpires/u-p-approve/approve', { submittedAt: '2026-11-01T08:00:00.000Z' }),
    );
    const approve = only(await history('umpire', 'u-p-approve'), 'umpire.approve');
    const head = approve.targets.find((t) => t.id === 'u-p-approve')!;
    assert.equal(head.op, 'approve');
    assert.equal(head.label, 'P.Approve');
    assert.deepEqual(changesOf((await entryOf(approve)).detail, 'umpire', 'u-p-approve'), [
      { field: 'active', from: false, to: true },
      { field: 'pending', from: true },
    ]);
  });

  test('a pending merge fills the survivor, deletes the submission and names both', async () => {
    const target = await json<{ id: string }>(
      call('POST', '/scorers', { displayName: 'P.Target' }),
      201,
    );
    await repo.createScorer(TENANT, {
      id: 's-p-pending',
      displayName: 'P.Pending',
      phone: '+27825550099',
      idNumber: '9001015009081',
      active: false,
      pending: true,
      source: 'self-registration',
      submittedAt: '2026-11-02T08:00:00.000Z',
      consentAt: '2026-11-02T08:00:00.000Z',
    });
    await json(
      call('POST', '/scorers/s-p-pending/merge', {
        targetId: target.id,
        submittedAt: '2026-11-02T08:00:00.000Z',
      }),
    );
    const merge = only(await history('scorer', target.id), 'scorer.merge');
    assert.equal(only(await history('scorer', 's-p-pending'), 'scorer.merge').id, merge.id);
    assert.deepEqual(merge.counts, { repointed: 0 });
    assert.equal(merge.targets.find((t) => t.id === target.id)!.op, 'merge');
    const source = merge.targets.find((t) => t.id === 's-p-pending')!;
    assert.equal(source.op, 'delete');
    // The submission is gone, so this entry (flushed after the source's scrub) never names it.
    assert.equal(source.label, undefined);
    const { detail } = await entryOf(merge);
    assert.deepEqual(detail!.mentions.map((m) => m.id).sort(), ['s-p-pending', target.id].sort());
    assert.equal(detail!.mentions.find((m) => m.id === 's-p-pending')!.label, undefined);
    assert.ok(!JSON.stringify(await auditRows()).includes('P.Pending'));
    const filled = changesOf(detail, 'scorer', target.id);
    assert.deepEqual(change(filled, 'phone'), { field: 'phone', to: '+27825550099' });
    assert.deepEqual(change(filled, 'idNumber'), { field: 'idNumber', masked: true });
    assert.ok(!JSON.stringify(await auditRows()).includes('9001015009081'));
  });

  test('pending signup → edit → merge → erase the survivor: no row keeps the applicant', async () => {
    const target = await json<{ id: string }>(
      call('POST', '/umpires', { displayName: 'T.Survivor' }),
      201,
    );
    await signup('umpire', {
      firstNames: 'Zebedee',
      surname: 'Pendlebury',
      phone: '082 555 0101',
      email: 'zebedee@example.org',
    });
    const pending = (await repo.listUmpires(TENANT)).find(
      (u) => u.pending && u.fullName === 'Zebedee Pendlebury',
    )!;
    assert.ok(pending, 'the signup filed a pending record');
    await json(call('PATCH', `/umpires/${pending.id}`, { email: 'zeb.p@example.org' }));
    const fresh = (await repo.getUmpire(TENANT, pending.id))!;
    await json(
      call('POST', `/umpires/${pending.id}/merge`, {
        targetId: target.id,
        submittedAt: fresh.submittedAt,
      }),
    );
    const names = [
      pending.displayName,
      'Zebedee Pendlebury',
      'Zebedee',
      'Pendlebury',
      pending.phone!,
      '082 555 0101',
      'zebedee@example.org',
      'zeb.p@example.org',
      ...pending.aliases,
    ];
    const res = await call('DELETE', `/umpires/${target.id}`);
    assert.equal(res.status, 200, await res.text());
    const stored = JSON.stringify(await auditRows());
    for (const n of names) assert.ok(!stored.includes(n), `still holds ${n}`);
    // The applicant's entries remain (who/when), stripped.
    const actions = (await history('umpire', pending.id)).items.map((e) => e.action);
    for (const a of ['official.signup', 'umpire.update', 'umpire.merge'])
      assert.ok(actions.includes(a), `${a} in ${JSON.stringify(actions)}`);
  });

  test('a resubmission between the target write and the source delete: 409, failed entry, source scrubbed', async () => {
    const target = await json<{ id: string }>(
      call('POST', '/scorers', { displayName: 'R.Racetarget', fullName: 'Rae Racetarget' }),
      201,
    );
    await signup('scorer', {
      firstNames: 'Rhoda',
      surname: 'Racer',
      phone: '082 555 0202',
      email: 'rhoda@example.org',
    });
    const pending = (await repo.listScorers(TENANT)).find(
      (s) => s.pending && s.fullName === 'Rhoda Racer',
    )!;
    assert.ok(pending, 'the signup filed a pending record');
    assert.ok(JSON.stringify(await auditRows()).includes('Rhoda Racer'), 'signup recorded');

    const restore = interceptNext('DeleteItem', async () => {
      await repo.putScorer(TENANT, { ...pending, submittedAt: '2099-01-01T00:00:00.000Z' });
    });
    let res: Response;
    try {
      res = await call('POST', `/scorers/${pending.id}/merge`, {
        targetId: target.id,
        submittedAt: pending.submittedAt,
      });
    } finally {
      restore();
    }
    assert.equal(res.status, 409, await res.clone().text());
    assert.equal(((await res.json()) as { code: string }).code, 'registration_changed');
    assert.equal((await repo.getScorer(TENANT, target.id))!.phone, pending.phone, 'target written');

    const merge = only(await history('scorer', target.id), 'scorer.merge');
    assert.equal(merge.outcome, 'failed');
    assert.equal(merge.status, 409);
    const source = merge.targets.find((t) => t.id === pending.id);
    assert.equal(source?.label, undefined);
    const { detail } = await entryOf(merge);
    assert.equal(detail!.mentions.find((m) => m.id === pending.id)?.label, undefined);
    // The submission's own entries were scrubbed before the delete was attempted.
    assert.ok(!JSON.stringify(await auditRows()).includes('Rhoda Racer'));
    const signupEntry = only(await history('scorer', pending.id), 'official.signup');
    for (const c of changesOf((await entryOf(signupEntry)).detail, 'scorer', pending.id)) {
      assert.equal(c.from, undefined);
      assert.equal(c.to, undefined);
    }
  });
});

describe('erase', () => {
  test('after DELETE no audit row holds the erased names; the entries remain', async () => {
    const created = await json<{ id: string; aliases: string[] }>(
      call('POST', '/umpires', {
        displayName: 'Q.Xylo',
        phone: '+27825550777',
        email: 'qxylo@example.org',
      }),
      201,
    );
    const id = created.id;
    const edited = await json<{ aliases: string[] }>(
      call('PATCH', `/umpires/${id}`, { displayName: 'V.Wombat', fullName: 'Vernon Wombat' }),
    );
    await repo.putSeries(TENANT, series('s-er', ['f1']));
    await json(call('PUT', '/series/s-er/fixtures/f1/officials', { umpires: [{ umpireId: id }] }));
    const dupe = await json<{ aliases: string[] }>(
      call('POST', '/umpires', { displayName: 'Q.Survivor' }),
      201,
    );
    await json(call('POST', `/umpires/u-q-survivor/merge`, { targetId: id }));

    const names = [
      'Q.Survivor', // the merged duplicate is in the erase set
      ...dupe.aliases,
      'Q.Xylo',
      'V.Wombat',
      'Vernon Wombat',
      '+27825550777',
      'qxylo@example.org',
      ...created.aliases,
      ...edited.aliases,
    ];
    assert.ok(JSON.stringify(await auditRows()).includes('V.Wombat'), 'recorded before erase');

    const res = await call('DELETE', `/umpires/${id}`, undefined, ADMIN_B);
    assert.equal(res.status, 200, await res.text());

    const stored = JSON.stringify(await auditRows());
    for (const n of names) assert.ok(!stored.includes(n), `still holds ${n}`);

    const page = await history('umpire', id);
    const actions = page.items.map((e) => e.action);
    for (const a of [
      'umpire.create',
      'umpire.update',
      'fixture-officials.set',
      'umpire.merge',
      'umpire.delete',
    ])
      assert.ok(actions.includes(a), `${a} in ${JSON.stringify(actions)}`);
    for (const e of page.items) {
      assert.ok(e.actor.sub, 'who survives');
      assert.ok(e.at, 'when survives');
    }
    const del = only(page, 'umpire.delete');
    assert.equal(del.actor.sub, 'sub-admin-b');
    assert.equal(del.outcome, 'ok');
    const head = del.targets.find((t) => t.id === id)!;
    assert.equal(head.op, 'erase');
    assert.equal(head.label, undefined);
    assert.equal(head.scrubbed, true, "the erasing request's own entry reads as removed");
    assert.equal(del.counts?.records, 2, 'the erase set includes the merged duplicate');
    assert.equal(del.counts?.vacated, 1);
    for (const k of ['renamed', 'ledger', 'reports'])
      assert.equal(typeof del.counts?.[k], 'number', k);
    const update = only(page, 'umpire.update');
    for (const c of changesOf((await entryOf(update)).detail, 'umpire', id)) {
      assert.equal(c.from, undefined);
      assert.equal(c.to, undefined);
    }
  });
});
