/**
 * Audit middleware (src/audit-middleware.ts) through the REAL Hono app on an in-process
 * dynalite: flush rules, actors, the bulk "started" headline, no secrets in any stored row, and
 * fail-open. Contract: docs/api/audit.md. Run with tsx --test.
 */
import { test, before, after, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { AuditEntry } from '../src/types.js';

const DDB_PORT = 4851; // unique
const TABLE = 'SmartClubAuditMiddlewareTest';
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

const devAuth = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const ADMIN = devAuth('sub-admin', 'admin@test', [
  { tenantId: TENANT, role: 'admin', clubIds: [] },
]);
const REP = devAuth('sub-rep', 'rep@test', [
  { tenantId: TENANT, role: 'club', clubIds: ['home-club'] },
]);
const OPERATOR = devAuth('sub-op', 'op@platform', [
  { tenantId: '*', role: 'operator', clubIds: [] },
  { tenantId: TENANT, role: 'admin', clubIds: [] },
]);
const NO_EMAIL = devAuth('sub-noemail', '', [{ tenantId: TENANT, role: 'admin', clubIds: [] }]);

const call = async (method: string, path: string, body?: unknown, auth = ADMIN) =>
  app.request(path, {
    method,
    headers: { 'x-tenant': TENANT, 'x-dev-auth': auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let mw: typeof import('../src/audit-middleware.js');
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
  mw = await import('../src/audit-middleware.js');
  keys = await import('../src/keys.js');
  await repo.putClub(TENANT, { id: 'home-club', name: 'Home Club' } as never);
});

after(() => new Promise<void>((resolve) => ddbServer.close(() => resolve())));
afterEach(() => mw.setAuditWriterForTests(null));

async function json200(res: Response | Promise<Response>): Promise<unknown> {
  const r = await res;
  const text = await r.text();
  assert.equal(r.status, 200, text);
  return JSON.parse(text);
}

/**
 * Fail the next GetItem whose sort key `match` accepts (a 400 the SDK throws, as a throttled or
 * refused read would); every other request reaches dynalite. Returns the undo.
 */
function failNextGet(match: (sk: string) => boolean): () => void {
  type Listener = (req: IncomingMessage, res: ServerResponse) => void;
  const original = ddbServer.listeners('request')[0] as Listener;
  let armed = true;
  ddbServer.removeAllListeners('request');
  ddbServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (!armed || req.headers['x-amz-target'] !== 'DynamoDB_20120810.GetItem')
      return original(req, res);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const sk = (JSON.parse(raw.toString('utf8')) as { Key?: { sk?: { S?: string } } }).Key?.sk?.S;
      if (sk && match(sk)) {
        armed = false;
        res.writeHead(400, { 'content-type': 'application/x-amz-json-1.0' });
        res.end(
          JSON.stringify({
            __type: 'com.amazonaws.dynamodb.v20120810#ProvisionedThroughputExceededException',
            message: 'read refused by the test',
          }),
        );
        return;
      }
      const replay = Object.assign(Readable.from([raw]), {
        headers: req.headers,
        method: req.method,
        url: req.url,
      });
      original(replay as unknown as IncomingMessage, res);
    });
  });
  return () => {
    ddbServer.removeAllListeners('request');
    ddbServer.on('request', original);
  };
}

/** Every row of the tenant's current audit month partition. */
async function auditRows(tenant = TENANT): Promise<Record<string, unknown>[]> {
  const { DynamoDBDocumentClient, QueryCommand } = await import('@aws-sdk/lib-dynamodb');
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      endpoint: process.env.DYNAMO_ENDPOINT,
      region: 'localhost',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }),
  );
  const pk = keys.auditPartitionPk(tenant, keys.auditMonthOf(new Date().toISOString()));
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': pk },
    }),
  );
  return res.Items ?? [];
}

const headlines = async (tenant = TENANT) =>
  (await auditRows(tenant)).filter((r) => (r.sk as string).startsWith('A#')) as unknown as Array<
    AuditEntry & { sk: string }
  >;

/** Headlines written by the request(s) inside `fn`. */
async function newHeadlines(fn: () => unknown, tenant = TENANT) {
  const before = new Set((await headlines(tenant)).map((h) => h.sk));
  await fn();
  return (await headlines(tenant)).filter((h) => !before.has(h.sk));
}

describe('flush rules', () => {
  test('a 2xx change writes exactly one ok entry naming the action, target and actor', async () => {
    let res!: Response;
    const added = await newHeadlines(async () => {
      res = await call('PUT', '/venues/v-ok', { id: 'v-ok', name: 'Kingsmead' });
    });
    assert.equal(res.status, 200);
    assert.equal(added.length, 1);
    const e = added[0];
    assert.equal(e.action, 'venue.save');
    assert.equal(e.outcome, 'ok');
    assert.equal(e.status, 200);
    assert.equal(e.tenant, TENANT);
    assert.equal(e.visibility, 'tenant');
    assert.deepEqual(e.route, { method: 'PUT', pattern: '/venues/:id' });
    assert.deepEqual(
      e.targets.map((t) => [t.type, t.id, t.op]),
      [['venue', 'v-ok', 'save']],
    );
    assert.equal(e.actor.key, 'sub-admin');
    assert.equal(e.actor.email, 'admin@test');
    assert.equal(e.actor.role, 'admin');
    assert.equal(e.actor.via, 'console');
    assert.equal(e.actor.operator, undefined);
    assert.ok(e.requestId);
    // The record's history finds it.
    const hist = await repo.listAuditForEntity(TENANT, 'venue', 'v-ok');
    assert.deepEqual(
      hist.items.map((x) => x.id),
      [e.id],
    );
  });

  test('a plain 4xx writes nothing', async () => {
    let res!: Response;
    const added = await newHeadlines(async () => {
      res = await call('PATCH', '/umpires/nobody', { displayName: 'X' });
    });
    assert.equal(res.status, 404);
    assert.equal(added.length, 0);
  });

  test('a forbidden request writes nothing', async () => {
    let res!: Response;
    const added = await newHeadlines(async () => {
      res = await call('PUT', '/venues/v-rep', { id: 'v-rep', name: 'X' }, REP);
    });
    assert.equal(res.status, 403);
    assert.equal(added.length, 0);
  });

  test('a skip route writes nothing', async () => {
    let res!: Response;
    const added = await newHeadlines(async () => {
      res = await call('PATCH', '/me', { onboardingSeen: { a: true } });
    });
    assert.equal(res.status, 200);
    assert.equal(added.length, 0);
  });

  test('an unaudited GET writes nothing', async () => {
    const added = await newHeadlines(() => call('GET', '/venues'));
    assert.equal(added.length, 0);
  });
});

describe('recorded writes and failures (a mini app on the same middleware)', () => {
  // The "recorded then refused" and 5xx paths are driven through a small app carrying the real
  // middleware and the real repo writer (no real route records and then refuses on demand).
  async function miniApp() {
    const { Hono } = await import('hono');
    const { auditMiddleware } = mw;
    const { auditTarget, auditSet } = await import('../src/audit.js');
    const mini = new Hono();
    mini.use('*', auditMiddleware);
    mini.post('/recorded-then-409', (c) => {
      auditSet({ tenant: TENANT });
      auditTarget({ type: 'umpire', id: 'u-merged', op: 'merge' });
      return c.json({ error: 'conflict' }, 409);
    });
    mini.post('/boom', () => {
      throw new Error('handler blew up');
    });
    return mini;
  }

  test('a 4xx after a handler-recorded write is written as failed', async () => {
    const mini = await miniApp();
    let res!: Response;
    const added = await newHeadlines(async () => {
      res = await mini.request('/recorded-then-409', { method: 'POST' });
    });
    assert.equal(res.status, 409);
    assert.equal(added.length, 1);
    assert.equal(added[0].outcome, 'failed');
    assert.equal(added[0].status, 409);
    assert.equal(added[0].action, 'unknown'); // not in the registry
    assert.deepEqual(
      added[0].targets.map((t) => t.id),
      ['u-merged'],
    );
  });

  test('a 5xx on a mutating route is written as failed', async () => {
    const mini = await miniApp();
    let res!: Response;
    const added = await newHeadlines(async () => {
      res = await mini.request('/boom', { method: 'POST' });
    }, '*');
    assert.equal(res.status, 500);
    assert.equal(added.length, 1);
    assert.equal(added[0].outcome, 'failed');
    assert.equal(added[0].status, 500);
    assert.equal(added[0].tenant, '*');
    assert.equal(added[0].actor.key, 'unattributed');
  });
});

describe('create routes name the record they created', () => {
  /** The one new entry `fn` wrote in `tenant`, and the created id's history there. */
  async function created(
    fn: () => Promise<Response>,
    tenant: string,
    type: string,
    idOf: (body: Record<string, unknown>) => string,
  ) {
    let res!: Response;
    const added = await newHeadlines(async () => {
      res = await fn();
    }, tenant);
    assert.ok(res.status === 200 || res.status === 201, await res.clone().text());
    const id = idOf((await res.json()) as Record<string, unknown>);
    assert.ok(id, 'the response names the created id');
    assert.equal(added.length, 1);
    const target = added[0].targets.find((t) => t.type === type && t.id === id);
    assert.ok(target, `${type} ${id} is a target of ${JSON.stringify(added[0].targets)}`);
    assert.equal(target.op, 'create');
    const hist = await repo.listAuditForEntity(tenant, type, id);
    assert.deepEqual(
      hist.items.map((x) => x.id),
      [added[0].id],
    );
    return added[0];
  }

  test('POST /umpires', async () => {
    const e = await created(
      () => call('POST', '/umpires', { displayName: 'Created Ump' }),
      TENANT,
      'umpire',
      (b) => b.id as string,
    );
    assert.equal(e.action, 'umpire.create');
  });

  test('POST /series', async () => {
    const e = await created(
      () =>
        call('POST', '/series', {
          id: 's-audit-create',
          name: 'Audit Series',
          leagueKey: 'premier',
          startDate: '2026-12-01',
          teams: [],
          participants: [],
          fixtures: [],
          kind: 'series',
          version: 1,
        }),
      TENANT,
      'series',
      (b) => b.id as string,
    );
    assert.equal(e.action, 'series.create');
  });

  test('POST /admin/users', async () => {
    const e = await created(
      () => call('POST', '/admin/users', { email: 'created-user@audit.test', role: 'admin' }),
      TENANT,
      'user',
      (b) => b.sub as string,
    );
    assert.equal(e.action, 'user.invite');
  });

  test("POST /platform/tenants lands in the new client's own partition, operator-only", async () => {
    const slug = 'auditnewclient';
    const e = await created(
      () =>
        call(
          'POST',
          '/platform/tenants',
          { slug, branding: { name: 'Audit New Client' }, submissionDeadline: '2027-03-01' },
          OPERATOR,
        ),
      slug,
      'tenant',
      () => slug,
    );
    assert.equal(e.action, 'tenant.create');
    assert.equal(e.tenant, slug);
    assert.equal(e.visibility, 'operator');
    assert.equal(e.actor.key, 'sub-op');
  });
});

describe('target labels', () => {
  /** The label of the `type`/`id` target on the one entry `fn` wrote. */
  async function labelOf(fn: () => Promise<Response>, type: string, id: string) {
    let res!: Response;
    const added = await newHeadlines(async () => {
      res = await fn();
    });
    assert.ok(res.status < 300, await res.clone().text());
    assert.equal(added.length, 1);
    return added[0].targets.find((t) => t.type === type && t.id === id)?.label;
  }

  test('venues, series, users and competitions are named by what the handler already holds', async () => {
    assert.equal(
      await labelOf(
        () => call('PUT', '/venues/v-label', { id: 'v-label', name: ' Chatsworth Oval ' }),
        'venue',
        'v-label',
      ),
      'Chatsworth Oval',
    );
    assert.equal(
      await labelOf(
        () =>
          call('POST', '/series', {
            id: 's-label',
            name: 'Label Series',
            leagueKey: 'premier',
            startDate: '2026-12-01',
            teams: [],
            participants: [],
            fixtures: [],
            kind: 'series',
            version: 1,
          }),
        'series',
        's-label',
      ),
      'Label Series',
    );
    const invite = await newHeadlines(() =>
      call('POST', '/admin/users', { email: 'Labelled@Audit.Test', role: 'admin' }),
    );
    const sub = invite[0].targets.find((t) => t.type === 'user')!.id;
    assert.equal(invite[0].targets[0].label, 'labelled@audit.test');
    assert.equal(
      await labelOf(() => call('PATCH', `/admin/users/${sub}`, { role: 'admin' }), 'user', sub),
      'labelled@audit.test',
    );
  });

  test('a club edit is named by the club, and deleting the club leaves no club name in any row', async () => {
    await repo.putClub(TENANT, { id: 'label-club', name: 'Labelled Club', version: 1 } as never);
    assert.equal(
      await labelOf(
        () => call('PATCH', '/clubs/label-club', { name: 'Labelled Club Renamed' }),
        'club',
        'label-club',
      ),
      'Labelled Club Renamed',
    );
    const res = await call('DELETE', '/clubs/label-club');
    assert.equal(res.status, 200, await res.clone().text());
    const rows = JSON.stringify(await auditRows());
    assert.ok(!rows.includes('Labelled Club'), 'no audit row names the deleted club');
  });
});

describe('actors', () => {
  test('a club rep is keyed on sub with role club', async () => {
    let res!: Response;
    const added = await newHeadlines(async () => {
      res = await call('POST', '/clubs/home-club/reg-link', {}, REP);
    });
    assert.equal(res.status, 200);
    assert.equal(added.length, 1);
    assert.equal(added[0].actor.key, 'sub-rep');
    assert.equal(added[0].actor.role, 'club');
    assert.equal(added[0].action, 'link.mint');
    assert.deepEqual(
      added[0].targets.map((t) => [t.type, t.id]),
      [['club', 'home-club']],
    );
    const mine = await repo.listAuditForActor(TENANT, 'sub-rep');
    assert.ok(mine.items.some((x) => x.id === added[0].id));
  });

  test('an operator acting inside a tenant is flagged and keeps the tenant role', async () => {
    const added = await newHeadlines(() =>
      call('PUT', '/venues/v-op', { id: 'v-op', name: 'Op Ground' }, OPERATOR),
    );
    assert.equal(added.length, 1);
    const a = added[0].actor;
    assert.equal(a.key, 'sub-op');
    assert.equal(a.operator, true);
    assert.equal(a.role, 'admin');
    assert.equal(a.email, 'op@platform');
    assert.equal(added[0].visibility, 'tenant');
  });

  test('an empty email is never stored', async () => {
    const added = await newHeadlines(() =>
      call('PUT', '/venues/v-ne', { id: 'v-ne', name: 'No Email' }, NO_EMAIL),
    );
    assert.equal(added.length, 1);
    assert.equal(added[0].actor.key, 'sub-noemail');
    assert.ok(!('email' in added[0].actor));
  });
});

describe('bulk routes', () => {
  test('a started headline is written first and replaced by the final entry', async () => {
    await repo.putUmpire(TENANT, {
      id: 'u-bulk',
      displayName: 'Bulk Ump',
      fullName: 'Bulk Umpire',
      aliases: ['bulkump'],
      active: true,
    } as never);
    const writes: Array<{ id: string; outcome: string }> = [];
    mw.setAuditWriterForTests(async (set) => {
      writes.push({ id: set.entry.id, outcome: set.entry.outcome });
      // Between the started row and the final entry, the started row is what is stored.
      if (set.entry.outcome !== 'started') {
        const now = (await headlines()).filter((h) => h.id === set.entry.id);
        assert.deepEqual(
          now.map((h) => h.outcome),
          ['started'],
        );
      }
      await repo.putAuditEntry(set);
    });
    let res!: Response;
    const added = await newHeadlines(async () => {
      res = await call('DELETE', '/umpires/u-bulk');
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(writes.length, 2);
    assert.equal(writes[0].outcome, 'started');
    assert.equal(writes[1].outcome, 'ok');
    assert.equal(writes[0].id, writes[1].id);
    assert.equal(added.length, 1);
    assert.equal(added[0].outcome, 'ok');
    assert.equal(added[0].action, 'umpire.delete');
    assert.equal(added[0].actor.key, 'sub-admin');
  });

  test('a bulk route refused with nothing recorded leaves no entry (its started rows go)', async () => {
    const started: string[] = [];
    mw.setAuditWriterForTests(async (set) => {
      if (set.entry.outcome === 'started') started.push(set.entry.id);
      await repo.putAuditEntry(set);
    });
    const rowsBefore = (await auditRows()).length;
    let res!: Response;
    const added = await newHeadlines(async () => {
      res = await call('DELETE', '/umpires/u-missing');
    });
    assert.equal(res.status, 404);
    assert.equal(started.length, 1, 'the started row was written');
    assert.equal(added.length, 0);
    assert.equal((await auditRows()).length, rowsBefore, 'no pointer row is left behind');
  });

  test("a rep's refused bulk request leaves no entry", async () => {
    let res!: Response;
    const added = await newHeadlines(async () => {
      res = await call('DELETE', '/umpires/u-bulk-rep', undefined, REP);
    });
    assert.equal(res.status, 403);
    assert.equal(added.length, 0);
  });

  test('a failing started write still runs the handler and the final entry is written', async () => {
    await repo.putUmpire(TENANT, {
      id: 'u-startfail',
      displayName: 'Start Fail',
      fullName: 'Start Fail',
      aliases: ['startfail'],
      active: true,
    } as never);
    mw.setAuditWriterForTests(async (set) => {
      if (set.entry.outcome === 'started') throw new Error('table unavailable');
      await repo.putAuditEntry(set);
    });
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(' '));
    let res!: Response;
    let added: Awaited<ReturnType<typeof headlines>> = [];
    try {
      added = await newHeadlines(async () => {
        res = await call('DELETE', '/umpires/u-startfail');
      });
    } finally {
      console.error = orig;
    }
    assert.equal(res.status, 200, await res.clone().text());
    assert.ok(errors.some((l) => l.includes('audit-write-failed')));
    assert.equal(added.length, 1);
    assert.equal(added[0].outcome, 'ok');
    assert.equal(added[0].action, 'umpire.delete');
  });

  test('a /platform bulk route writes its started row in the :slug tenant, operator-only', async () => {
    const started: AuditEntry[] = [];
    mw.setAuditWriterForTests(async (set) => {
      if (set.entry.outcome === 'started') started.push(set.entry);
      await repo.putAuditEntry(set);
    });
    let res!: Response;
    const added = await newHeadlines(async () => {
      res = await call(
        'POST',
        `/platform/tenants/${TENANT}/fixture-amendments/confirm`,
        {},
        OPERATOR,
      );
    });
    assert.ok(res.status >= 400 && res.status < 500, `refused, got ${res.status}`);
    assert.equal(started.length, 1);
    assert.equal(started[0].tenant, TENANT);
    assert.equal(started[0].visibility, 'operator');
    assert.equal(started[0].action, 'fixture-amendments.confirm');
    assert.equal(started[0].actor.key, 'sub-op');
    assert.equal(started[0].actor.via, 'platform');
    // Refused before the handler recorded anything: the started row is gone again.
    assert.equal(added.length, 0);
  });
});

describe('pinning, erasure redaction and long ids (a mini app on the same middleware)', () => {
  async function miniApp() {
    const { Hono } = await import('hono');
    const { auditMiddleware, auditStartedMiddleware } = mw;
    const { auditTarget, auditSet, auditMention } = await import('../src/audit.js');
    const mini = new Hono();
    mini.use('*', auditMiddleware);
    // Registered patterns, so the registry specs (bulk, erases) apply.
    mini.delete('/scorers/:id', auditStartedMiddleware, (c) => {
      // After the started row: a handler naming another tenant/actor must not move the entry.
      auditSet({
        tenant: 'elsewhere',
        actor: { kind: 'user', key: 'sub-late', via: 'console' },
      });
      return c.json({ ok: true });
    });
    mini.delete('/umpires/:id', (c) => {
      auditSet({ tenant: TENANT });
      auditTarget({
        type: 'umpire',
        id: c.req.param('id'),
        label: 'Secret Umpire Name',
        op: 'delete',
        changes: [{ field: 'displayName', from: 'Secret Umpire Name' }],
      });
      auditMention({ type: 'umpire', id: 'u-other-dup', label: 'Other Secret Name' });
      return c.json({ ok: true });
    });
    // A bulk route whose handler records nothing and answers with ?status=… (e.g. a write
    // then a 409 the handler never marked as recorded).
    mini.post('/umpires/appointments/confirm', auditStartedMiddleware, (c) =>
      c.json({ error: 'refused' }, Number(c.req.query('status')) as 400),
    );
    mini.delete('/admin/players/:nk', (c) => {
      auditSet({ tenant: TENANT });
      auditTarget({ type: 'player', id: 'NK-SECRET-777', label: 'Player Secret', op: 'erase' });
      return c.json({ ok: true });
    });
    return mini;
  }

  test('auditSet cannot move an entry once its started row is written', async () => {
    const mini = await miniApp();
    const beforeElsewhere = (await headlines('elsewhere')).length;
    let res!: Response;
    const added = await newHeadlines(async () => {
      res = await mini.request('/scorers/s-pin', { method: 'DELETE' });
    }, '*');
    assert.equal(res.status, 200);
    assert.equal(added.length, 1, 'the final entry overwrote the started row in place');
    assert.equal(added[0].outcome, 'ok');
    assert.equal(added[0].actor.key, 'unattributed');
    assert.equal((await headlines('elsewhere')).length, beforeElsewhere);
  });

  test('a bulk request ending 409 with nothing recorded closes its started entry as failed', async () => {
    const mini = await miniApp();
    let res!: Response;
    const added = await newHeadlines(async () => {
      res = await mini.request('/umpires/appointments/confirm?status=409', { method: 'POST' });
    }, '*');
    assert.equal(res.status, 409);
    assert.equal(added.length, 1, 'a possibly half-applied bulk request stays visible');
    assert.equal(added[0].outcome, 'failed');
    assert.equal(added[0].status, 409);
    assert.equal(added[0].action, 'umpire.appointments.confirm');
  });

  for (const status of [400, 401, 403, 404])
    test(`a bulk request refused with ${status} and nothing recorded leaves no row`, async () => {
      const mini = await miniApp();
      const rowsBefore = (await auditRows('*')).length;
      let res!: Response;
      const added = await newHeadlines(async () => {
        res = await mini.request(`/umpires/appointments/confirm?status=${status}`, {
          method: 'POST',
        });
      }, '*');
      assert.equal(res.status, status);
      assert.equal(added.length, 0);
      assert.equal((await auditRows('*')).length, rowsBefore, 'started rows deleted');
    });

  test("an erasing route's own entry stores no label, value or mention of the erased type", async () => {
    const mini = await miniApp();
    const added = await newHeadlines(async () => {
      const res = await mini.request('/umpires/u-erased', { method: 'DELETE' });
      assert.equal(res.status, 200);
    });
    assert.equal(added.length, 1);
    const dump = JSON.stringify(await auditRows());
    assert.ok(!dump.includes('Secret Umpire Name'), 'target label / change value stored');
    assert.ok(!dump.includes('Other Secret Name'), 'mention label stored');
    // The official's id (a name slug) stays, like the register stub.
    assert.deepEqual(
      added[0].targets.map((t) => [t.type, t.id]),
      [['umpire', 'u-erased']],
    );
  });

  test("a player erasure's own entry blanks the natural key and gives it no pointer", async () => {
    const mini = await miniApp();
    const added = await newHeadlines(async () => {
      const res = await mini.request('/admin/players/NK-SECRET-777', { method: 'DELETE' });
      assert.equal(res.status, 200);
    });
    assert.equal(added.length, 1);
    const dump = JSON.stringify(await auditRows());
    assert.ok(!dump.includes('NK-SECRET-777'), 'natural key stored');
    assert.ok(!dump.includes('Player Secret'), 'label stored');
    assert.deepEqual(
      added[0].targets.map((t) => [t.type, t.id]),
      [['player', '']],
    );
  });

  test('an id near the sort-key limit is hashed in pointer keys and the history still finds it', async () => {
    const longId = `v-${'x'.repeat(1000)}`;
    let res!: Response;
    const added = await newHeadlines(async () => {
      res = await call('PUT', `/venues/${longId}`, { name: 'Long Ground' });
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(added.length, 1);
    assert.equal(added[0].targets[0].id, longId, 'the row body keeps the full id');
    assert.ok((await auditRows()).every((r) => Buffer.byteLength(r.sk as string) < 1024));
    const hist = await repo.listAuditForEntity(TENANT, 'venue', longId);
    assert.deepEqual(
      hist.items.map((x) => x.id),
      [added[0].id],
    );
  });

  test('a write the table refuses is retried once as a headline-only entry', async () => {
    let calls = 0;
    mw.setAuditWriterForTests(async (set) => {
      calls++;
      if (calls === 1) throw new Error('ValidationException: key too large');
      await repo.putAuditEntry(set);
    });
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(' '));
    let res!: Response;
    let added: Awaited<ReturnType<typeof headlines>> = [];
    try {
      added = await newHeadlines(async () => {
        res = await call('PUT', '/venues/v-degraded', { name: 'Degraded Ground' });
      });
    } finally {
      console.error = orig;
    }
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
    assert.equal(added.length, 1);
    assert.equal(added[0].action, 'venue.save');
    assert.equal(added[0].actor.key, 'sub-admin');
    assert.deepEqual(added[0].targets, []);
    assert.equal(added[0].truncated?.rows, 1);
    assert.ok(errors.some((l) => l.includes('audit-write-degraded')));
    // Headline only: no pointer row names the record.
    assert.equal((await repo.listAuditForEntity(TENANT, 'venue', 'v-degraded')).items.length, 0);
  });
});

describe('secrets and failures', () => {
  test('no token, query string or raw path is stored in any audit row', async () => {
    const res = await call('POST', '/clubs/home-club/reg-link?t=QUERYSECRET42', {});
    assert.equal(res.status, 200);
    const { playerRegLink } = (await res.json()) as { playerRegLink: { token: string } };
    const del = await call('DELETE', '/admin/players/NATURALKEYSECRET99');
    // Nothing to erase: a 404 with nothing recorded, so the started rows are dropped again.
    assert.equal(del.status, 404);
    const dump = JSON.stringify(await auditRows());
    assert.ok(!dump.includes(playerRegLink.token), 'token stored');
    assert.ok(!dump.includes('QUERYSECRET42'), 'query string stored');
    assert.ok(!dump.includes('/clubs/home-club/reg-link'), 'raw path stored');
    assert.ok(!dump.includes('NATURALKEYSECRET99'), 'redacted param stored');
  });

  test('an audit write failure still returns the handler response', async () => {
    mw.setAuditWriterForTests(async () => {
      throw new Error('table unavailable');
    });
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(' '));
    try {
      const res = await call('PUT', '/venues/v-fail', { id: 'v-fail', name: 'Fail Ground' });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { id: string }).id, 'v-fail');
    } finally {
      console.error = orig;
    }
    const line = errors.find((l) => l.includes('audit-write-failed'));
    assert.ok(line, 'one skeleton line is logged');
    const parsed = JSON.parse(line!);
    assert.equal(parsed.actor, 'sub-admin');
    assert.equal(parsed.pattern, '/venues/:id');
    assert.equal(parsed.action, 'venue.save');
    assert.ok(!line!.includes('Fail Ground'));
  });

  test('a failed before-read on PUT /venues/:id records the update with no diff; the save answers as normal', async () => {
    await json200(call('PUT', '/venues/v-before', { id: 'v-before', name: 'Old Ground' }));
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(' '));
    const restore = failNextGet((sk) => sk === 'VENUE#v-before');
    let res!: Response;
    let added: Awaited<ReturnType<typeof headlines>> = [];
    try {
      added = await newHeadlines(async () => {
        res = await call('PUT', '/venues/v-before', { id: 'v-before', name: 'New Ground' });
      });
    } finally {
      restore();
      console.error = orig;
    }
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(((await res.json()) as { name: string }).name, 'New Ground');
    assert.equal(added.length, 1);
    assert.equal(added[0].action, 'venue.save');
    assert.deepEqual(
      added[0].targets.map((t) => [t.type, t.id, t.op, t.changeCount]),
      [['venue', 'v-before', 'save', 0]],
      'an unknown "before" is not a create: no diff',
    );
    assert.ok(
      errors.some((l) => l.startsWith('audit: a read for the record failed')),
      errors.join('\n'),
    );
  });

  test('an async audit helper that rejects still returns the handler response', async () => {
    const { Hono } = await import('hono');
    const audit = await import('../src/audit.js');
    const mini = new Hono();
    mini.use('*', mw.auditMiddleware as never);
    mini.post('/async-helper', async (c) => {
      audit.auditSet({ tenant: TENANT, action: 'test.async-helper' });
      await audit.safeAudit(async () => {
        await new Promise((r) => setTimeout(r, 1));
        audit.auditTarget({ type: 'venue', id: 'v-async', op: 'save' });
        throw new RangeError('helper failed after an await');
      });
      return c.json({ ok: true }, 201);
    });
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(' '));
    let res!: Response;
    let added: Awaited<ReturnType<typeof headlines>> = [];
    try {
      added = await newHeadlines(async () => {
        res = await mini.request('/async-helper', { method: 'POST' });
      });
    } finally {
      console.error = orig;
    }
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(
      errors.filter((l) => l.startsWith('audit:')),
      ['audit: recording failed (RangeError)'],
    );
    // The entry still flushes with what was recorded before the failure.
    assert.equal(added.length, 1);
    assert.equal(added[0].action, 'test.async-helper');
    assert.deepEqual(
      added[0].targets.map((t) => t.id),
      ['v-async'],
    );
  });

  test('cost: a plain change request makes exactly one audit write of a few rows', async () => {
    const sizes: number[] = [];
    mw.setAuditWriterForTests(async (set) => {
      sizes.push(set.rows.length);
      await repo.putAuditEntry(set);
    });
    for (let i = 0; i < 5; i++)
      await call('PUT', `/venues/v-cost-${i}`, { id: `v-cost-${i}`, name: 'Cost' });
    // Headline + detail (the venue's field values, Phase 3) + entity pointer + actor pointer,
    // one write per request.
    assert.deepEqual(sizes, [4, 4, 4, 4, 4]);
  });
});
