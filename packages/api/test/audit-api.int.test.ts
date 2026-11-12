/**
 * Audit read API (docs/api/audit.md) through the REAL Hono app on an in-process dynalite:
 * club reps get 403, a union admin reads only their own tenant's tenant-visible entries,
 * operator-portal entries are visible through the platform routes only, cursor paging, the
 * actor and record-type filters, 400 on a bad cursor, and reads write nothing.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AuditDetail, AuditEntry, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4855; // unique
const TABLE = 'SmartClubAuditApiTest';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const A = 'tenanta';
const B = 'tenantb';
const devAuth = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const ADMIN_A = devAuth('sub-admin-a', 'a@test', [{ tenantId: A, role: 'admin', clubIds: [] }]);
const ADMIN_A2 = devAuth('sub-admin-a2', 'a2@test', [{ tenantId: A, role: 'admin', clubIds: [] }]);
const ADMIN_B = devAuth('sub-admin-b', 'b@test', [{ tenantId: B, role: 'admin', clubIds: [] }]);
const REP_A = devAuth('sub-rep-a', 'rep@test', [{ tenantId: A, role: 'club', clubIds: ['c1'] }]);
const OPERATOR = devAuth('sub-op', 'op@platform', [
  { tenantId: '*', role: 'operator', clubIds: [] },
]);

const call = (method: string, path: string, auth: string, tenant = A, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'x-tenant': tenant, 'x-dev-auth': auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

type Page = { items: AuditEntry[]; cursor?: string };

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');

const venue = (tenant: string, id: string, auth: string) =>
  call('PUT', `/venues/${id}`, auth, tenant, { id, name: `Ground ${id}` });

/** The newest headline of a tenant (what the request just wrote). */
const newest = async (tenant: string) => (await repo.listAuditFeed(tenant, { limit: 1 })).items[0];

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');
  for (const t of [A, B])
    await repo.putTenantConfig({
      tenant: t,
      branding: { name: t, title: t, logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [],
    } as unknown as TenantConfig);
});

after(() => stopDynalite(ddb));

describe('access', () => {
  test('club reps get 403 on every admin audit read', async () => {
    for (const p of ['/admin/audit', '/admin/audit/entity/venue/v1', '/admin/audit/entry/x/y'])
      assert.equal((await call('GET', p, REP_A)).status, 403, p);
  });

  test('a union admin cannot use the platform routes', async () => {
    assert.equal((await call('GET', `/platform/tenants/${A}/audit`, ADMIN_A)).status, 403);
    assert.equal((await call('GET', '/platform/audit', ADMIN_A)).status, 403);
  });
});

describe('tenant isolation and visibility', () => {
  test("an admin reads only their own tenant's entries", async () => {
    assert.equal((await venue(A, 'iso-a', ADMIN_A)).status, 200);
    const mine = await newest(A);
    assert.equal((await venue(B, 'iso-b', ADMIN_B)).status, 200);
    const theirs = await newest(B);

    const feed = await json<Page>(call('GET', '/admin/audit', ADMIN_A));
    assert.ok(feed.items.length > 0);
    assert.ok(feed.items.every((e) => e.tenant === A));
    assert.ok(feed.items.some((e) => e.id === mine.id));
    assert.ok(!feed.items.some((e) => e.id === theirs.id));

    // B's entry and B's record are not reachable from A, even by id.
    const entryPath = (e: AuditEntry) =>
      `/admin/audit/entry/${encodeURIComponent(e.at)}/${encodeURIComponent(e.id)}`;
    assert.equal((await call('GET', entryPath(theirs), ADMIN_A)).status, 404);
    const own = await json<{ entry: AuditEntry; detail: AuditDetail | null }>(
      call('GET', entryPath(mine), ADMIN_A),
    );
    assert.equal(own.entry.id, mine.id);
    assert.equal(own.entry.action, 'venue.save');
    assert.equal(
      (await json<Page>(call('GET', '/admin/audit/entity/venue/iso-b', ADMIN_A))).items.length,
      0,
    );
    assert.deepEqual(
      (await json<Page>(call('GET', '/admin/audit/entity/venue/iso-a', ADMIN_A))).items.map(
        (e) => e.id,
      ),
      [mine.id],
    );
  });

  test('operator-portal entries are hidden from tenant admins and visible to operators', async () => {
    const res = await call('POST', `/platform/tenants/${A}/setup-complete`, OPERATOR);
    assert.equal(res.status, 200);
    const op = await newest(A);
    assert.equal(op.action, 'tenant.setup-complete');
    assert.equal(op.visibility, 'operator');
    assert.equal(op.actor.via, 'platform');
    assert.equal(op.actor.operator, true);

    const adminFeed = await json<Page>(call('GET', '/admin/audit?limit=200', ADMIN_A));
    assert.ok(!adminFeed.items.some((e) => e.id === op.id));
    assert.ok(adminFeed.items.every((e) => e.visibility === 'tenant'));
    const adminEntity = await json<Page>(call('GET', `/admin/audit/entity/tenant/${A}`, ADMIN_A));
    assert.equal(adminEntity.items.length, 0);
    const opEntry = `/audit/entry/${encodeURIComponent(op.at)}/${op.id}`;
    assert.equal((await call('GET', `/admin${opEntry}`, ADMIN_A)).status, 404);

    const platformFeed = await json<Page>(
      call('GET', `/platform/tenants/${A}/audit?limit=200`, OPERATOR),
    );
    assert.ok(platformFeed.items.some((e) => e.id === op.id));
    assert.ok(
      platformFeed.items.some((e) => e.visibility === 'tenant'),
      'all visibilities',
    );
    const platformEntity = await json<Page>(
      call('GET', `/platform/tenants/${A}/audit/entity/tenant/${A}`, OPERATOR),
    );
    assert.deepEqual(
      platformEntity.items.map((e) => e.id),
      [op.id],
    );
    const viaPlatform = await json<{ entry: AuditEntry }>(
      call('GET', `/platform/tenants/${A}${opEntry}`, OPERATOR),
    );
    assert.equal(viaPlatform.entry.id, op.id);
  });

  test('platform-level entries (no tenant) are read through /platform/audit', async () => {
    const audit = await import('../src/audit.js');
    const scope = audit.newAuditScope({
      actor: { kind: 'user', key: 'sub-op', sub: 'sub-op', via: 'platform', operator: true },
      visibility: 'operator',
    });
    audit.runAudited(scope, () => audit.auditSet({ action: 'tenant.create' }));
    const set = audit.buildEntry(scope, { status: 201 });
    await repo.putAuditEntry(set);
    const page = await json<Page>(call('GET', '/platform/audit', OPERATOR));
    assert.ok(page.items.some((e) => e.id === set.entry.id && e.tenant === '*'));

    // Its detail is read through the platform entry route (operators only).
    const entryPath = `/platform/audit/entry/${encodeURIComponent(set.entry.at)}/${set.entry.id}`;
    const one = await json<{ entry: AuditEntry; detail: AuditDetail | null }>(
      call('GET', entryPath, OPERATOR),
    );
    assert.equal(one.entry.id, set.entry.id);
    assert.equal(one.entry.tenant, '*');
    assert.equal((await call('GET', entryPath, ADMIN_A)).status, 403);
    assert.equal(
      (
        await call(
          'GET',
          `/platform/audit/entry/${encodeURIComponent(set.entry.at)}/nope`,
          OPERATOR,
        )
      ).status,
      404,
    );
  });
});

describe('person filter by email', () => {
  test("an email resolves through the tenant's users to that member's entries", async () => {
    await repo.putUser({
      sub: 'sub-email-a',
      email: 'Person.A@Test',
      memberships: [{ tenantId: A, role: 'admin', clubIds: [] }],
      onboardingSeen: {},
    } as Parameters<typeof repo.putUser>[0]);
    const PERSON = devAuth('sub-email-a', 'person.a@test', [
      { tenantId: A, role: 'admin', clubIds: [] },
    ]);
    assert.equal((await venue(A, 'by-email-1', PERSON)).status, 200);
    assert.equal((await venue(A, 'by-email-2', PERSON)).status, 200);

    for (const q of ['person.a@test', 'PERSON.A@TEST']) {
      const feed = await json<Page>(
        call('GET', `/admin/audit?actor=${encodeURIComponent(q)}&limit=200`, ADMIN_A),
      );
      assert.equal(feed.items.length, 2, q);
      assert.ok(feed.items.every((e) => e.actor.key === 'sub-email-a'));
    }
    // The operator's per-tenant feed resolves the same way.
    const op = await json<Page>(
      call('GET', `/platform/tenants/${A}/audit?actor=person.a%40test&limit=200`, OPERATOR),
    );
    assert.equal(op.items.length, 2);
  });

  test("an email matching no current member filters the headlines by the actor's email", async () => {
    // No user row for this admin: like one since removed from the team.
    const GONE = devAuth('sub-gone', 'gone@test', [{ tenantId: A, role: 'admin', clubIds: [] }]);
    assert.equal((await venue(A, 'by-gone-1', GONE)).status, 200);
    assert.equal((await venue(A, 'by-gone-2', GONE)).status, 200);
    const feed = await json<Page>(call('GET', '/admin/audit?actor=Gone%40Test&limit=200', ADMIN_A));
    assert.equal(feed.items.length, 2);
    assert.ok(feed.items.every((e) => e.actor.key === 'sub-gone' && e.actor.email === 'gone@test'));
    const none = await json<Page>(
      call('GET', '/admin/audit?actor=nobody%40test&limit=200', ADMIN_A),
    );
    assert.equal(none.items.length, 0);
  });
});

describe('paging and filters', () => {
  test('a cursor walks the feed newest first without repeats', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await venue(A, `page-${i}`, ADMIN_A2)).status, 200);
    const seen: AuditEntry[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const q = `/admin/audit?actor=sub-admin-a2&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await json<Page>(call('GET', q, ADMIN_A));
      assert.ok(page.items.length <= 2);
      seen.push(...page.items);
      cursor = page.cursor;
      pages++;
    } while (cursor && pages < 10);
    assert.equal(seen.length, 5);
    assert.equal(new Set(seen.map((e) => e.id)).size, 5);
    const ats = seen.map((e) => e.at);
    assert.deepEqual(ats, [...ats].sort().reverse(), 'newest first');
    assert.ok(
      seen.every((e) => e.actor.key === 'sub-admin-a2'),
      'actor filter',
    );
  });

  test('the record-type filter keeps only entries touching that type', async () => {
    assert.equal(
      (await call('POST', '/clubs/c-type/notes', ADMIN_A, A, { text: 'x' })).status,
      404,
      'a refused note writes nothing',
    );
    const venues = await json<Page>(call('GET', '/admin/audit?type=venue&limit=200', ADMIN_A));
    assert.ok(venues.items.length >= 6);
    assert.ok(venues.items.every((e) => e.targets.some((t) => t.type === 'venue')));
    const none = await json<Page>(call('GET', '/admin/audit?type=scorer', ADMIN_A));
    assert.equal(none.items.length, 0);
  });

  test('a cursor the API did not issue, or a malformed bound, is 400', async () => {
    const bad = await call('GET', '/admin/audit?cursor=not-a-cursor', ADMIN_A);
    assert.equal(bad.status, 400);
    assert.equal(
      (await call('GET', '/admin/audit/entity/venue/x?cursor=%7Bbad', ADMIN_A)).status,
      400,
    );
    assert.equal((await call('GET', '/admin/audit?from=yesterday', ADMIN_A)).status, 400);
    assert.equal((await call('GET', '/admin/audit?limit=0', ADMIN_A)).status, 400);
  });

  test('a forged cursor month or key is 400, never a long walk or a DynamoDB error', async () => {
    const forge = (c: unknown) => Buffer.from(JSON.stringify(c)).toString('base64url');
    const month = new Date().toISOString().slice(0, 7);
    const t0 = Date.now();
    for (const c of [
      { m: '9999-12' }, // far future: would step ~95,000 month partitions
      { m: '2026-13' }, // not a month
      { m: '2020-01' }, // before the launch month
      { m: month, k: 'E#venue#x#2026' }, // outside the feed's A# range
    ])
      assert.equal(
        (await call('GET', `/admin/audit?cursor=${forge(c)}`, ADMIN_A)).status,
        400,
        JSON.stringify(c),
      );
    // The entity route: a key outside this record's E# prefix.
    for (const k of [`A#${month}`, 'E#venue#other#2026'])
      assert.equal(
        (
          await call(
            'GET',
            `/admin/audit/entity/venue/page-1?cursor=${forge({ m: month, k })}`,
            ADMIN_A,
          )
        ).status,
        400,
        k,
      );
    assert.ok(Date.now() - t0 < 5_000, 'refused without walking partitions');
  });

  test('reads write no audit entries', async () => {
    const before = (await repo.listAuditFeed(A, { limit: 200 })).items.length;
    await call('GET', '/admin/audit', ADMIN_A);
    await call('GET', '/admin/audit/entity/venue/page-1', ADMIN_A);
    await call('GET', `/platform/tenants/${A}/audit`, OPERATOR);
    assert.equal((await repo.listAuditFeed(A, { limit: 200 })).items.length, before);
  });
});

describe('entry and history reads', () => {
  test('an expired entry is 404 on the entry route and absent from the feed', async () => {
    const audit = await import('../src/audit.js');
    const scope = audit.newAuditScope({
      tenant: A,
      actor: { kind: 'user', key: 'sub-admin-a', sub: 'sub-admin-a', via: 'console' },
    });
    audit.runAudited(scope, () =>
      audit.auditTarget({ type: 'venue', id: 'v-expired', op: 'save' }),
    );
    const set = audit.buildEntry(scope, { status: 200, action: 'venue.save' });
    // TTL deletion lags: the rows are still there, but past their expiry.
    const past = Math.floor(Date.now() / 1000) - 60;
    await repo.putAuditEntry({ rows: set.rows.map((r) => ({ ...r, expiresAt: past })) });
    const path = `/admin/audit/entry/${encodeURIComponent(set.entry.at)}/${set.entry.id}`;
    assert.equal((await call('GET', path, ADMIN_A)).status, 404);
    const feed = await json<Page>(call('GET', '/admin/audit?limit=200', ADMIN_A));
    assert.ok(!feed.items.some((e) => e.id === set.entry.id));
    const hist = await json<Page>(call('GET', '/admin/audit/entity/venue/v-expired', ADMIN_A));
    assert.equal(hist.items.length, 0);
  });

  test('reads only ever return headlines, never detail or pointer rows', async () => {
    const audit = await import('../src/audit.js');
    const scope = audit.newAuditScope({
      tenant: A,
      actor: { kind: 'user', key: 'sub-admin-a', sub: 'sub-admin-a', via: 'console' },
    });
    audit.runAudited(scope, () =>
      audit.auditTarget({
        type: 'umpire',
        id: 'u-rows',
        op: 'update',
        changes: [{ field: 'displayName', from: 'A', to: 'B' }],
        mentions: [{ type: 'umpire', id: 'u-rows-dup', label: 'Dup' }],
      }),
    );
    const set = audit.buildEntry(scope, { status: 200, action: 'umpire.update' });
    await repo.putAuditEntry(set);
    assert.ok(set.rows.some((r) => r.sk.startsWith('D#')));
    assert.ok(set.rows.some((r) => r.sk.startsWith('E#')));
    assert.ok(set.rows.some((r) => r.sk.startsWith('U#')));

    const isHeadline = (e: AuditEntry) =>
      typeof e.action === 'string' &&
      !!e.actor &&
      Array.isArray(e.targets) &&
      !('changes' in e) &&
      !('mentions' in e) &&
      !('entryId' in e) &&
      !('sk' in e);
    const feed = await json<Page>(call('GET', '/admin/audit?limit=200', ADMIN_A));
    assert.ok(feed.items.length > 0 && feed.items.every(isHeadline));
    assert.equal(feed.items.filter((e) => e.id === set.entry.id).length, 1);
    const byActor = await json<Page>(call('GET', '/admin/audit?actor=sub-admin-a', ADMIN_A));
    assert.ok(byActor.items.every(isHeadline));
    const hist = await json<Page>(call('GET', '/admin/audit/entity/umpire/u-rows', ADMIN_A));
    assert.deepEqual(
      hist.items.map((e) => [e.id, isHeadline(e)]),
      [[set.entry.id, true]],
    );

    const one = await json<{ entry: AuditEntry; detail: AuditDetail | null }>(
      call(
        'GET',
        `/admin/audit/entry/${encodeURIComponent(set.entry.at)}/${set.entry.id}`,
        ADMIN_A,
      ),
    );
    assert.ok(isHeadline(one.entry));
    assert.equal(one.detail?.mentions[0].id, 'u-rows-dup');
    // The `:at` segment cannot be bent into another row family.
    for (const at of [`D#${set.entry.at}`, `E#umpire#u-rows#${set.entry.at}`, 'U#sub-admin-a'])
      assert.equal(
        (await call('GET', `/admin/audit/entry/${encodeURIComponent(at)}/${set.entry.id}`, ADMIN_A))
          .status,
        404,
        at,
      );
  });
});
