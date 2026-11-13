/**
 * Audit trail Phase 3 (ADR 0023), first group: field-level old → new values for team & access,
 * tenant settings, clubs and club documents, through the REAL Hono app on an in-process
 * dynalite. Contract: docs/api/audit.md. Run with tsx --test.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AuditChange, AuditDetail, AuditEntry, Club } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4863; // unique
const TABLE = 'SmartClubAuditPhase3AdminTest';
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
const admin = (sub: string, email: string) =>
  devAuth(sub, email, [{ tenantId: TENANT, role: 'admin', clubIds: [] }]);
const ADMIN_A = admin('sub-admin-a', 'a@test');
const ADMIN_B = admin('sub-admin-b', 'b@test');
const OPERATOR = devAuth('sub-op', 'op@platform', [
  { tenantId: '*', role: 'operator', clubIds: [] },
]);

const call = (method: string, path: string, body?: unknown, auth = ADMIN_A) =>
  app.request(path, {
    method,
    headers: { 'x-tenant': TENANT, 'x-dev-auth': auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const platformCall = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'x-dev-auth': OPERATOR, 'content-type': 'application/json' },
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

/** A record's history as a union admin sees it. */
const history = (type: string, id: string) =>
  json<Page>(call('GET', `/admin/audit/entity/${type}/${encodeURIComponent(id)}?limit=200`));
const entryOf = (e: Pick<AuditEntry, 'at' | 'id'>) =>
  json<Entry>(call('GET', `/admin/audit/entry/${encodeURIComponent(e.at)}/${e.id}`));
/** The same, as an operator sees it (every visibility). */
const opHistory = (type: string, id: string) =>
  json<Page>(
    platformCall(
      'GET',
      `/platform/tenants/${TENANT}/audit/entity/${type}/${encodeURIComponent(id)}?limit=200`,
    ),
  );
const opEntryOf = (e: Pick<AuditEntry, 'at' | 'id'>) =>
  json<Entry>(
    platformCall(
      'GET',
      `/platform/tenants/${TENANT}/audit/entry/${encodeURIComponent(e.at)}/${e.id}`,
    ),
  );
const changesOf = (d: AuditDetail | null, type: string, id: string): AuditChange[] =>
  d?.targets.find((t) => t.type === type && t.id === id)?.changes ?? [];
const change = (cs: AuditChange[], field: string) => cs.find((c) => c.field === field);

/** The newest entry of `page` with this action. */
function latest(page: Page, action: string): AuditEntry {
  const hit = page.items.find((e) => e.action === action);
  assert.ok(hit, `${action} in ${JSON.stringify(page.items.map((e) => e.action))}`);
  return hit;
}

const exco = (tag: string) => ({
  chair: { name: `Chair ${tag}`, cell: '0820000001', email: `chair.${tag}@example.org` },
  sec: { name: `Sec ${tag}`, cell: '0820000002', email: `sec.${tag}@example.org` },
  tre: { name: `Tre ${tag}`, cell: '0820000003', email: `tre.${tag}@example.org` },
});
const club = (id: string, name: string, extra: Partial<Club> = {}): Club =>
  ({
    id,
    name,
    district: 'North',
    sub: '',
    chair: `Chair ${id}`,
    affiliation: 'in_progress',
    cqi: 0,
    docs: { constitution: false, safeguarding: false },
    players: 0,
    teams: 0,
    women: 0,
    juniors: 0,
    color: '#123456',
    ground: {},
    leagues: [],
    exco: exco(id),
    version: 1,
    ...extra,
  }) as Club;

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let keys: typeof import('../src/keys.js');

before(async () => {
  const dynalite = (await import('dynalite')).default as (opts?: unknown) => Server;
  ddbServer = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => ddbServer.listen(DDB_PORT, resolve));
  const { DynamoDBClient, CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  const ddbAdmin = new DynamoDBClient({
    endpoint: process.env.DYNAMO_ENDPOINT,
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  await ddbAdmin.send(
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
    branding: {
      name: 'KZN Dolphins',
      title: 'KZN Dolphins',
      logoUrl: '',
      colors: {},
      copy: { support: 'Old Office · old@union.org' },
    },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    districts: ['North', 'South'],
  } as unknown as import('../src/types.js').TenantConfig);
  await repo.putClub(TENANT, club('club-a', 'Alpha CC'));
  await repo.putClub(TENANT, club('club-b', 'Beta CC'));
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

describe('team & access', () => {
  let sub: string;

  test('invite: the new member, role and club scope; the club history shows the grant', async () => {
    const res = await json<{ sub: string }>(
      call('POST', '/admin/users', {
        email: 'Rep.One@Example.org',
        role: 'rep',
        clubIds: ['club-a'],
      }),
      201,
    );
    sub = res.sub;
    const invite = latest(await history('user', sub), 'user.invite');
    assert.equal(invite.actor.sub, 'sub-admin-a');
    const head = invite.targets.find((t) => t.type === 'user' && t.id === sub)!;
    assert.equal(head.op, 'create');
    assert.equal(head.label, 'rep.one@example.org');
    assert.deepEqual(changesOf((await entryOf(invite)).detail, 'user', sub), [
      { field: 'email', to: 'rep.one@example.org' },
      { field: 'role', to: 'rep' },
      { field: 'clubIds', to: 'Alpha CC', ref: { type: 'club', id: 'club-a' } },
    ]);
    assert.equal(latest(await history('club', 'club-a'), 'user.invite').id, invite.id);
  });

  test('edit by another admin: who, and the club scope before → after', async () => {
    await json(call('PATCH', `/admin/users/${sub}`, { clubIds: ['club-b'] }, ADMIN_B));
    const update = latest(await history('user', sub), 'user.update');
    assert.equal(update.actor.sub, 'sub-admin-b');
    assert.equal(update.actor.email, 'b@test');
    const head = update.targets.find((t) => t.id === sub)!;
    assert.equal(head.label, 'rep.one@example.org');
    assert.equal(head.changeCount, 2);
    assert.deepEqual(changesOf((await entryOf(update)).detail, 'user', sub), [
      { field: 'clubIds', from: 'Alpha CC', ref: { type: 'club', id: 'club-a' } },
      { field: 'clubIds', to: 'Beta CC', ref: { type: 'club', id: 'club-b' } },
    ]);
    // Both clubs' histories show the access change.
    assert.equal(latest(await history('club', 'club-a'), 'user.update').id, update.id);
    assert.equal(latest(await history('club', 'club-b'), 'user.update').id, update.id);
  });

  test('a save that changes nothing is recorded with zero changes', async () => {
    await json(call('PATCH', `/admin/users/${sub}`, { role: 'rep', clubIds: ['club-b'] }));
    const update = latest(await history('user', sub), 'user.update');
    assert.equal(update.actor.sub, 'sub-admin-a');
    assert.equal(update.targets.find((t) => t.id === sub)!.changeCount, 0);
    assert.deepEqual(changesOf((await entryOf(update)).detail, 'user', sub), []);
  });

  test('email correction: old → new address', async () => {
    await json(call('PATCH', `/admin/users/${sub}/email`, { email: 'rep.uno@example.org' }));
    const fix = latest(await history('user', sub), 'user.email-change');
    assert.equal(fix.targets.find((t) => t.id === sub)!.label, 'rep.uno@example.org');
    assert.deepEqual(changesOf((await entryOf(fix)).detail, 'user', sub), [
      { field: 'email', from: 'rep.one@example.org', to: 'rep.uno@example.org' },
    ]);
  });

  test('removal: the role and clubs the member had', async () => {
    await json(call('DELETE', `/admin/users/${sub}`));
    const del = latest(await history('user', sub), 'user.delete');
    assert.deepEqual(changesOf((await entryOf(del)).detail, 'user', sub), [
      { field: 'role', from: 'rep' },
      { field: 'clubIds', from: 'Beta CC', ref: { type: 'club', id: 'club-b' } },
    ]);
  });

  test('operator rep invite: same shape, operator-only', async () => {
    const res = await json<{ sub: string }>(
      platformCall('POST', `/platform/tenants/${TENANT}/reps`, {
        email: 'rep.two@example.org',
        clubIds: ['club-a'],
      }),
      201,
    );
    const invite = latest(await opHistory('user', res.sub), 'user.invite-rep');
    assert.equal(invite.visibility, 'operator');
    assert.equal(invite.actor.sub, 'sub-op');
    assert.deepEqual(changesOf((await opEntryOf(invite)).detail, 'user', res.sub), [
      { field: 'email', to: 'rep.two@example.org' },
      { field: 'role', to: 'rep' },
      { field: 'clubIds', to: 'Alpha CC', ref: { type: 'club', id: 'club-a' } },
    ]);
  });

  test('operator admin grant over a pending rep: role rep → admin, clubs dropped', async () => {
    const res = await json<{ sub: string }>(
      platformCall('POST', `/platform/tenants/${TENANT}/admins`, { email: 'rep.two@example.org' }),
      201,
    );
    const grant = latest(await opHistory('user', res.sub), 'user.invite-admin');
    assert.deepEqual(changesOf((await opEntryOf(grant)).detail, 'user', res.sub), [
      { field: 'role', from: 'rep', to: 'admin' },
      { field: 'clubIds', from: 'Alpha CC', ref: { type: 'club', id: 'club-a' } },
    ]);
  });
});

describe('tenant settings', () => {
  test('a tenant admin save: who, and the changed fields old → new', async () => {
    await json(
      call(
        'PUT',
        '/tenant/config',
        {
          submissionDeadline: '2027-01-31',
          branding: {
            name: 'KZN Dolphins Cricket',
            title: 'KZN Dolphins',
            logoUrl: '',
            colors: {},
            copy: { support: 'Old Office · old@union.org' },
          },
        },
        ADMIN_B,
      ),
    );
    const save = latest(await history('tenant-config', TENANT), 'tenant-config.update');
    assert.equal(save.actor.sub, 'sub-admin-b');
    assert.equal(save.visibility, 'tenant');
    assert.deepEqual(changesOf((await entryOf(save)).detail, 'tenant-config', TENANT), [
      { field: 'branding.name', from: 'KZN Dolphins', to: 'KZN Dolphins Cricket' },
      { field: 'submissionDeadline', from: '2026-12-01', to: '2027-01-31' },
    ]);
  });

  test('a save that changes nothing records zero changes', async () => {
    await json(call('PUT', '/tenant/config', { submissionDeadline: '2027-01-31' }));
    const save = latest(await history('tenant-config', TENANT), 'tenant-config.update');
    assert.equal(save.actor.sub, 'sub-admin-a');
    assert.equal(save.targets.find((t) => t.type === 'tenant-config')!.changeCount, 0);
  });

  test('operator-only fields stay out of tenant admins’ view; recipients are masked', async () => {
    const recipient = 'hidden.recipient@example.org';
    await json(
      platformCall('PUT', `/platform/tenants/${TENANT}`, {
        officialsContactLine: 'Dolphins umpires 031 000 0000',
        scorecardCorrectionRecipients: [recipient],
        features: { captainsReports: false },
      }),
    );
    // The operator sees the entry with its values (recipients masked).
    const op = latest(await opHistory('tenant-config', TENANT), 'tenant.update');
    assert.equal(op.visibility, 'operator');
    const changes = changesOf((await opEntryOf(op)).detail, 'tenant-config', TENANT);
    assert.deepEqual(change(changes, 'officialsContactLine'), {
      field: 'officialsContactLine',
      to: 'Dolphins umpires 031 000 0000',
    });
    assert.deepEqual(change(changes, 'features.captainsReports'), {
      field: 'features.captainsReports',
      to: false,
    });
    assert.deepEqual(change(changes, 'scorecardCorrectionRecipients'), {
      field: 'scorecardCorrectionRecipients',
      masked: true,
    });
    assert.ok(!JSON.stringify(await auditRows()).includes(recipient), 'recipient stored');

    // A tenant admin sees neither the entry nor any operator-only field.
    const page = await history('tenant-config', TENANT);
    assert.ok(!page.items.some((e) => e.id === op.id), 'operator entry in tenant history');
    const feed = await json<Page>(call('GET', '/admin/audit?limit=200'));
    assert.ok(!feed.items.some((e) => e.id === op.id), 'operator entry in tenant feed');
    const denied = await call('GET', `/admin/audit/entry/${encodeURIComponent(op.at)}/${op.id}`);
    assert.equal(denied.status, 404);
    const admitted = new Set(['branding', 'submissionDeadline', 'leagues', 'competitionDefaults']);
    for (const e of page.items) {
      for (const c of changesOf((await entryOf(e)).detail, 'tenant-config', TENANT)) {
        assert.ok(
          admitted.has(c.field.split('.')[0]) || c.field === 'support',
          `${c.field} in a tenant-visible entry`,
        );
      }
    }
  });

  test('support contact: old → new', async () => {
    await json(call('PUT', '/tenant/support', { name: 'New Office', email: 'new@union.org' }));
    const save = latest(await history('tenant-config', TENANT), 'tenant-config.support.update');
    assert.deepEqual(changesOf((await entryOf(save)).detail, 'tenant-config', TENANT), [
      { field: 'support', from: 'Old Office · old@union.org', to: 'New Office · new@union.org' },
    ]);
  });

  test('setup complete / reopen: operator-only, who and when', async () => {
    await json(platformCall('POST', `/platform/tenants/${TENANT}/setup-complete`));
    await json(platformCall('DELETE', `/platform/tenants/${TENANT}/setup-complete`));
    const page = await opHistory('tenant', TENANT);
    const done = latest(page, 'tenant.setup-complete');
    assert.equal(done.visibility, 'operator');
    const set = changesOf((await opEntryOf(done)).detail, 'tenant', TENANT);
    assert.equal(change(set, 'setupCompletedBy')?.to, 'op@platform');
    assert.equal(typeof change(set, 'setupCompletedAt')?.to, 'string');
    const reopen = latest(page, 'tenant.setup-reopen');
    const cleared = changesOf((await opEntryOf(reopen)).detail, 'tenant', TENANT);
    assert.equal(change(cleared, 'setupCompletedBy')?.from, 'op@platform');
    assert.equal(change(cleared, 'setupCompletedBy')?.to, undefined);
    assert.equal((await history('tenant', TENANT)).items.length, 0, 'hidden from tenant admins');
  });
});

describe('clubs', () => {
  test('edit: who, name and venue old → new; the ground address masked', async () => {
    const address = '17 Hidden Ground Road';
    await json(
      call(
        'PATCH',
        '/clubs/club-a',
        { name: 'Alpha Cricket Club', ground: { venue: 'New Oval', address } },
        ADMIN_B,
      ),
    );
    const edit = latest(await history('club', 'club-a'), 'club.update');
    assert.equal(edit.actor.sub, 'sub-admin-b');
    const head = edit.targets.find((t) => t.type === 'club' && t.id === 'club-a')!;
    assert.equal(head.label, 'Alpha Cricket Club');
    const changes = changesOf((await entryOf(edit)).detail, 'club', 'club-a');
    assert.deepEqual(change(changes, 'name'), {
      field: 'name',
      from: 'Alpha CC',
      to: 'Alpha Cricket Club',
    });
    assert.deepEqual(change(changes, 'ground.venue'), { field: 'ground.venue', to: 'New Oval' });
    assert.deepEqual(change(changes, 'ground.address'), { field: 'ground.address', masked: true });
    // The rename's comm-log note is free text: changed, no value.
    assert.deepEqual(change(changes, 'notes'), { field: 'notes', masked: true });
    assert.ok(!JSON.stringify(await auditRows()).includes(address), 'address stored');
  });

  test('a save that changes nothing records zero changes', async () => {
    await json(call('PATCH', '/clubs/club-a', { name: 'Alpha Cricket Club' }));
    const edit = latest(await history('club', 'club-a'), 'club.update');
    assert.equal(edit.actor.sub, 'sub-admin-a');
    assert.equal(edit.targets.find((t) => t.id === 'club-a')!.changeCount, 0);
  });

  test('committee: which office changed, never who — names, contacts and ID number masked', async () => {
    const idNumber = '8001015009087';
    await json(
      call('POST', '/clubs/club-a/exco', {
        sec: { name: 'Sipho Secretary', cell: '0821112222', email: 'sipho@example.org' },
        chair: { idNumber, termStart: '2026-01-01' },
      }),
    );
    const save = latest(await history('club', 'club-a'), 'club.exco.update');
    const changes = changesOf((await entryOf(save)).detail, 'club', 'club-a');
    for (const f of ['exco.sec.name', 'exco.sec.cell', 'exco.sec.email', 'exco.chair.idNumber'])
      assert.deepEqual(change(changes, f), { field: f, masked: true }, f);
    // Term dates are not personal details: kept with their value.
    assert.deepEqual(change(changes, 'exco.chair.termStart'), {
      field: 'exco.chair.termStart',
      to: '2026-01-01',
    });
    const stored = JSON.stringify(await auditRows());
    for (const v of [idNumber, 'Sipho Secretary', '0821112222', 'sipho@example.org', 'Sec club-a'])
      assert.ok(!stored.includes(v), `stored: ${v}`);
  });

  test('note: recorded as a note added, text never stored', async () => {
    const text = 'Spoke to the chair about the overdue fees';
    await json(call('POST', '/clubs/club-a/notes', { text }));
    const note = latest(await history('club', 'club-a'), 'club.note.add');
    assert.equal(note.targets.find((t) => t.id === 'club-a')!.label, 'Alpha Cricket Club');
    assert.deepEqual(changesOf((await entryOf(note)).detail, 'club', 'club-a'), [
      { field: 'note', masked: true },
    ]);
    assert.ok(!JSON.stringify(await auditRows()).includes(text), 'note text stored');
  });

  test('operator club create: the new club and its fields', async () => {
    const created = await json<{ id: string }>(
      platformCall('POST', `/platform/tenants/${TENANT}/clubs`, {
        name: 'Gamma CC',
        district: 'South',
      }),
      201,
    );
    const create = latest(await opHistory('club', created.id), 'club.create');
    assert.equal(create.actor.sub, 'sub-op');
    const changes = changesOf((await opEntryOf(create)).detail, 'club', created.id);
    assert.deepEqual(change(changes, 'name'), { field: 'name', to: 'Gamma CC' });
    assert.deepEqual(change(changes, 'district'), { field: 'district', to: 'South' });
    assert.deepEqual(change(changes, 'affiliation'), { field: 'affiliation', to: 'not_started' });
    assert.equal(change(changes, 'cqi'), undefined, 'unset values are left out of a create');
  });
});

describe('club documents', () => {
  const key1 = 'local/dolphins/club-b/constitution-11111111.pdf';

  test('upload: status and size old → new; the object key masked', async () => {
    await json(
      call(
        'PATCH',
        '/clubs/club-b/docs/constitution',
        { objectKey: key1, size: 2048, contentType: 'application/pdf' },
        ADMIN_B,
      ),
    );
    const up = latest(await history('club', 'club-b'), 'club.doc.update');
    assert.equal(up.actor.sub, 'sub-admin-b');
    const changes = changesOf((await entryOf(up)).detail, 'club', 'club-b');
    assert.deepEqual(change(changes, 'docs.constitution'), {
      field: 'docs.constitution',
      from: false,
      to: true,
    });
    assert.deepEqual(change(changes, 'docMeta.constitution.size'), {
      field: 'docMeta.constitution.size',
      to: 2048,
    });
    assert.deepEqual(change(changes, 'docMeta.constitution.objectKey'), {
      field: 'docMeta.constitution.objectKey',
      masked: true,
    });
    assert.ok(!JSON.stringify(await auditRows()).includes('constitution-11111111'), 'key stored');
  });

  test('remove the file: status true → false, key masked', async () => {
    await json(call('DELETE', '/clubs/club-b/docs/constitution/file', { objectKey: key1 }));
    const del = latest(await history('club', 'club-b'), 'club.doc.delete-file');
    const changes = changesOf((await entryOf(del)).detail, 'club', 'club-b');
    assert.deepEqual(change(changes, 'docs.constitution'), {
      field: 'docs.constitution',
      from: true,
      to: false,
    });
    assert.deepEqual(change(changes, 'docMeta.constitution.objectKey'), {
      field: 'docMeta.constitution.objectKey',
      masked: true,
    });
    assert.ok(!JSON.stringify(await auditRows()).includes('constitution-11111111'), 'key stored');
  });

  test('re-recording a multi-file upload already on record changes nothing', async () => {
    const body = {
      objectKey: 'local/dolphins/club-b/safeguarding-22222222.pdf',
      size: 4096,
      contentType: 'application/pdf',
    };
    await json(call('PATCH', '/clubs/club-b/docs/safeguarding', body));
    const first = latest(await history('club', 'club-b'), 'club.doc.update');
    const firstChanges = changesOf((await entryOf(first)).detail, 'club', 'club-b');
    assert.deepEqual(change(firstChanges, 'docMeta.safeguarding.fileCount'), {
      field: 'docMeta.safeguarding.fileCount',
      to: 1,
    });
    assert.deepEqual(change(firstChanges, 'docMeta.safeguarding.files'), {
      field: 'docMeta.safeguarding.files',
      masked: true,
    });
    await json(call('PATCH', '/clubs/club-b/docs/safeguarding', body));
    const again = latest(await history('club', 'club-b'), 'club.doc.update');
    assert.notEqual(again.id, first.id);
    assert.equal(again.targets.find((t) => t.id === 'club-b')!.changeCount, 0);
    assert.ok(!JSON.stringify(await auditRows()).includes('safeguarding-22222222'));
  });
});

describe('club delete', () => {
  test('after DELETE no audit row holds the club name, contacts or committee names', async () => {
    await repo.putClub(TENANT, club('club-z', 'Zulu Zebras CC'));
    await json(
      call('PATCH', '/clubs/club-z', {
        ground: { venue: 'Zebra Park' },
      }),
    );
    await json(
      call('POST', '/clubs/club-z/exco', {
        tre: { name: 'Thandeka Treasurer', cell: '0829998888', email: 'thandeka@example.org' },
      }),
    );
    await json(
      call('POST', '/admin/users', { email: 'zrep@example.org', role: 'rep', clubIds: ['club-z'] }),
      201,
    );
    const pii = [
      'Zulu Zebras CC',
      'Zebra Park',
      'Chair club-z',
      'Sec club-z',
      'Tre club-z',
      'chair.club-z@example.org',
      'Thandeka Treasurer',
      'thandeka@example.org',
      '0829998888',
    ];
    const before = JSON.stringify(await auditRows());
    // Committee members are never recorded (their changes are masked), so only the club's own
    // name and ground precede the delete.
    for (const v of ['Zulu Zebras CC', 'Zebra Park'])
      assert.ok(before.includes(v), `recorded before the delete: ${v}`);

    const res = await call('DELETE', '/clubs/club-z', undefined, ADMIN_B);
    assert.equal(res.status, 200, await res.text());

    const stored = JSON.stringify(await auditRows());
    for (const v of pii) assert.ok(!stored.includes(v), `still holds ${v}`);

    const page = await history('club', 'club-z');
    const del = latest(page, 'club.delete');
    assert.equal(del.actor.sub, 'sub-admin-b');
    const head = del.targets.find((t) => t.type === 'club' && t.id === 'club-z')!;
    assert.equal(head.label, undefined);
    assert.equal(head.scrubbed, true);
    assert.equal(del.counts?.users, 1);
    assert.equal(typeof del.counts?.players, 'number');
    assert.equal((await entryOf(del)).detail, null, 'the erasing entry holds no values');
    for (const a of ['club.update', 'club.exco.update', 'user.invite'])
      assert.ok(
        page.items.some((e) => e.action === a),
        `${a} kept (who/when) in ${JSON.stringify(page.items.map((e) => e.action))}`,
      );
  });
});

describe('committee members are never stored (review C1)', () => {
  /** True when any stored audit row of the tenant holds `v`. */
  const stored = async (v: string) => JSON.stringify(await auditRows()).includes(v);
  const person = (tag: string) => ({
    name: `Person ${tag}`,
    cell: `0827${tag.padStart(6, '0')}`,
    email: `person.${tag}@example.org`,
  });

  test('removing an office bearer (role sent as null) stores none of their details', async () => {
    await repo.putClub(TENANT, club('club-x', 'Xenon CC'));
    const vc = person('111001');
    await json(call('POST', '/clubs/club-x/exco', { vc }));
    await json(call('POST', '/clubs/club-x/exco', { vc: null }));
    const removal = latest(await history('club', 'club-x'), 'club.exco.update');
    const changes = changesOf((await entryOf(removal)).detail, 'club', 'club-x');
    // The entry says the vice chair changed — no value either side.
    for (const f of ['exco.vc.name', 'exco.vc.cell', 'exco.vc.email'])
      assert.deepEqual(change(changes, f), { field: f, masked: true }, f);
    for (const v of [vc.name, vc.cell, vc.email]) assert.ok(!(await stored(v)), `stored: ${v}`);
  });

  test('replacing a required office bearer stores neither person', async () => {
    const next = person('111002');
    await json(call('POST', '/clubs/club-x/exco', { chair: next }));
    const save = latest(await history('club', 'club-x'), 'club.exco.update');
    assert.deepEqual(
      change(changesOf((await entryOf(save)).detail, 'club', 'club-x'), 'exco.chair.name'),
      { field: 'exco.chair.name', masked: true },
    );
    for (const v of [next.name, next.cell, next.email, 'Chair club-x', 'chair.club-x@example.org'])
      assert.ok(!(await stored(v)), `stored: ${v}`);
  });

  test('a club PATCH carrying the committee and chair stores no names or contacts', async () => {
    const p = person('111003');
    await json(call('PATCH', '/clubs/club-x', { chair: p.name, exco: { chair: p } }));
    const edit = latest(await history('club', 'club-x'), 'club.update');
    const changes = changesOf((await entryOf(edit)).detail, 'club', 'club-x');
    assert.deepEqual(change(changes, 'chair'), { field: 'chair', masked: true });
    for (const v of [p.name, p.cell, p.email]) assert.ok(!(await stored(v)), `stored: ${v}`);
  });

  test('a club created through the signup link stores the chair’s name and cell nowhere', async () => {
    const { clubSignupLink } = await json<{ clubSignupLink: { token: string } }>(
      call('POST', '/admin/club-signup-link'),
    );
    const rep = { repName: 'Signup Sibusiso Chair', repCell: '0829988776' };
    const res = await app.request(`/club-signup?t=${clubSignupLink.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clubName: 'Signup Sharks CC',
        district: 'North',
        repEmail: 'signup.chair@example.org',
        ...rep,
      }),
    });
    const created = await json<{ clubId: string }>(res, 201);
    const create = latest(await opHistory('club', created.clubId), 'club.signup');
    const changes = changesOf((await opEntryOf(create)).detail, 'club', created.clubId);
    assert.deepEqual(change(changes, 'name'), { field: 'name', to: 'Signup Sharks CC' });
    assert.deepEqual(change(changes, 'chair'), { field: 'chair', masked: true });
    assert.deepEqual(change(changes, 'exco.chair.name'), {
      field: 'exco.chair.name',
      masked: true,
    });
    assert.ok(
      !JSON.stringify(changes).includes('signup.chair@example.org'),
      'the chair email is no club value',
    );
    for (const v of Object.values(rep)) assert.ok(!(await stored(v)), `stored: ${v}`);
  });
});

describe('nested club values (review I2)', () => {
  const LEAGUE = 'aud-league';

  test('structure intake: operator-only, team names per league, never reaches tenant reads', async () => {
    const res = await json<{ clubs: Array<{ clubId: string; status: string }> }>(
      platformCall('POST', `/platform/tenants/${TENANT}/structure-intake/commit`, {
        newLeagues: [{ key: LEAGUE, label: 'Audit League', district: 'North' }],
        clubs: [
          {
            clubId: 'club-b',
            plan: {
              leagues: [LEAGUE],
              leagueTeams: { [LEAGUE]: 2 },
              teamRosters: {
                [LEAGUE]: [{ name: 'Beta A', venue: 'Beta Side Oval' }, { name: 'Beta B' }],
              },
            },
          },
        ],
      }),
    );
    assert.ok(JSON.stringify(res).includes('club-b'), JSON.stringify(res));
    const intake = latest(await opHistory('club', 'club-b'), 'structure-intake.commit');
    assert.equal(intake.visibility, 'operator');
    const changes = changesOf((await opEntryOf(intake)).detail, 'club', 'club-b');
    assert.deepEqual(change(changes, `teamRosters.${LEAGUE}`), {
      field: `teamRosters.${LEAGUE}`,
      to: ['Beta A', 'Beta B'],
    });
    assert.deepEqual(change(changes, `leagueTeams.${LEAGUE}`), {
      field: `leagueTeams.${LEAGUE}`,
      to: 2,
    });
    assert.ok(!JSON.stringify(changes).includes('Beta Side Oval'), 'a side’s venue is no value');
    await assertHiddenFromTenantAdmins(intake, 'club', 'club-b');
  });

  test('a named side’s address never reaches a stored row; the names do', async () => {
    const address = '99 SIDE SECRET LANE';
    await json(
      call('PATCH', '/clubs/club-a', {
        leagues: [LEAGUE],
        leagueTeams: { [LEAGUE]: 2 },
        teamRosters: {
          [LEAGUE]: [
            { id: 'tm_alpha_1', name: 'Alpha Firsts', venue: 'Alpha Side', address, lat: -29.1 },
            { id: 'tm_alpha_2', name: 'Alpha Seconds' },
          ],
        },
      }),
    );
    const edit = latest(await history('club', 'club-a'), 'club.update');
    const changes = changesOf((await entryOf(edit)).detail, 'club', 'club-a');
    assert.deepEqual(change(changes, `teamRosters.${LEAGUE}`), {
      field: `teamRosters.${LEAGUE}`,
      to: ['Alpha Firsts', 'Alpha Seconds'],
    });
    const rows = JSON.stringify(await auditRows());
    assert.ok(!rows.includes(address), 'address stored');
    assert.ok(!rows.includes('Alpha Side"') && !rows.includes('-29.1'), 'side venue/pin stored');
  });

  test('an unknown ground field is recorded as changed, never with its value', async () => {
    const gate = 'GATE-CODE-4471';
    await json(call('PATCH', '/clubs/club-a', { ground: { venue: 'New Oval', gateCode: gate } }));
    const edit = latest(await history('club', 'club-a'), 'club.update');
    assert.deepEqual(
      change(changesOf((await entryOf(edit)).detail, 'club', 'club-a'), 'ground.gateCode'),
      { field: 'ground.gateCode', masked: true },
    );
    assert.ok(!JSON.stringify(await auditRows()).includes(gate), 'unknown ground value stored');
  });
});

/**
 * An operator-only entry is invisible to the tenant's admins: not in the feed, not in the
 * record's history, and its entry reads 404.
 */
async function assertHiddenFromTenantAdmins(e: AuditEntry, type: string, id: string) {
  const feed = await json<Page>(call('GET', '/admin/audit?limit=200'));
  assert.ok(!feed.items.some((x) => x.id === e.id), `${e.action} in the tenant feed`);
  const page = await history(type, id);
  assert.ok(!page.items.some((x) => x.id === e.id), `${e.action} in the ${type} history`);
  const denied = await call('GET', `/admin/audit/entry/${encodeURIComponent(e.at)}/${e.id}`);
  assert.equal(denied.status, 404, `${e.action} entry readable by a tenant admin`);
}

describe('operator-only entries from the tenant admin side (review I3)', () => {
  test('the operator admin grant is not visible through /admin/audit*', async () => {
    const res = await json<{ sub: string }>(
      platformCall('POST', `/platform/tenants/${TENANT}/admins`, {
        email: 'grant.only@example.org',
      }),
      201,
    );
    const grant = latest(await opHistory('user', res.sub), 'user.invite-admin');
    assert.equal(grant.visibility, 'operator');
    await assertHiddenFromTenantAdmins(grant, 'user', res.sub);
  });
});
