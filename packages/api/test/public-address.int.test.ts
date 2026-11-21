/**
 * Public web address separate from the slug (ADR 0024), through the REAL Hono app on an
 * in-process dynalite:
 *   - PUT /platform/tenants/:slug/address: claim, change twice, reclaim an own old label and
 *     the own slug, every refusal (another client's slug / active label / retired label,
 *     vanity host, stale expectedCurrent, no-op, bad label)
 *   - resolution: GET /tenant by dev x-tenant and ?tenant= (404 retired/unknown, 400 nothing),
 *     requireTenantMembership on a retired label
 *   - tenant create blocked on a used or retired label; duplicate create still 409
 *   - erasure retires (never deletes) label records, and is safe to retry
 *   - a stale whole-config putTenantConfig after a change does not revive the old address
 *   - the address change is audited with old and new values
 *
 * Own file (not platform.int.test.ts) because it arms the wildcard platform and a vanity
 * WEB_ORIGIN_MAP entry at module load, which would change link origins across that suite.
 * Note: dynalite has no TransactWriteItems, so this exercises repo's sequential offline
 * fallback; the transactional branch needs the dev-stage pass in the plan.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AuditDetail, AuditEntry } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4907;
const TABLE = 'PublicAddressTest';
dynaliteEnv(DDB_PORT, TABLE);
process.env.WILDCARD_ENABLED = '1';
process.env.WILDCARD_WEB_SUFFIX = '.club.example.test';
process.env.WEB_ORIGIN_MAP = JSON.stringify({ vanityco: 'https://clubs.vanityco.test' });

const devAuthAs = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const OPERATOR = devAuthAs('op-1', 'operator@platform', [
  { tenantId: '*', role: 'operator', clubIds: [] },
]);
const WPC_ADMIN = devAuthAs('adm-wpc', 'admin@wpc', [
  { tenantId: 'wpcx', role: 'admin', clubIds: [] },
]);

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');

before(async () => {
  ddbServer = await startDynalite(DDB_PORT, TABLE);
  ({ app } = await import('../src/index.js'));
  repo = await import('../src/repo.js');
  for (const slug of ['wpcx', 'otherx', 'vanityco', 'erasex']) {
    const res = await createTenant(slug);
    assert.equal(res.status, 201, await res.clone().text());
  }
});

after(async () => {
  if (ddbServer) await stopDynalite(ddbServer);
});

const op = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'x-dev-auth': OPERATOR, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const createTenant = (slug: string) =>
  op('POST', '/platform/tenants', {
    slug,
    branding: { name: `Club ${slug}` },
    submissionDeadline: '2026-09-30',
  });

const setAddress = (slug: string, publicSlug: unknown, expectedCurrent: unknown) =>
  op('PUT', `/platform/tenants/${slug}/address`, { publicSlug, expectedCurrent });

type AddressBody = { publicSlug: string; publicSlugHistory: string[]; liveUrl: string | null };

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  assert.equal(r.status, status, text);
  return JSON.parse(text) as T;
}

/** GET /tenant as the SPA calls it in dev (x-tenant), or with only `?tenant=`. */
const tenantByHeader = (label: string) =>
  app.request('/tenant', { headers: { 'x-tenant': label } });
const tenantByQuery = (label: string) => app.request(`/tenant?tenant=${label}`);

const labelRecord = (label: string) => repo.getPublicLabelRecord(label);

describe('PUT /platform/tenants/:slug/address — claim and change', () => {
  test('claim: the new label serves the tenant, the slug is retired', async () => {
    const body = await json<AddressBody>(setAddress('wpcx', 'cobrasx', 'wpcx'));
    assert.deepEqual(body, {
      publicSlug: 'cobrasx',
      publicSlugHistory: ['wpcx'],
      liveUrl: 'https://cobrasx.club.example.test',
    });
    const served = await json<{ tenant: string }>(tenantByHeader('cobrasx'));
    assert.equal(served.tenant, 'wpcx', 'the payload carries the internal ID');
    assert.equal((await tenantByHeader('wpcx')).status, 404, 'the old address stops resolving');
    assert.equal((await labelRecord('wpcx'))?.status, 'retired');
    assert.equal((await labelRecord('cobrasx'))?.status, 'active');
  });

  test('GET /platform/tenants/:slug and the listing carry the address fields', async () => {
    const one = await json<AddressBody & { tenant: string }>(op('GET', '/platform/tenants/wpcx'));
    assert.equal(one.tenant, 'wpcx');
    assert.equal(one.publicSlug, 'cobrasx');
    assert.deepEqual(one.publicSlugHistory, ['wpcx']);
    assert.equal(one.liveUrl, 'https://cobrasx.club.example.test');
    const rows = await json<Array<AddressBody & { tenant: string }>>(
      op('GET', '/platform/tenants'),
    );
    const row = rows.find((r) => r.tenant === 'wpcx')!;
    assert.equal(row.publicSlug, 'cobrasx');
    assert.deepEqual(row.publicSlugHistory, ['wpcx']);
    assert.equal(row.liveUrl, 'https://cobrasx.club.example.test');
    // An un-renamed tenant: label = slug, no history.
    const other = rows.find((r) => r.tenant === 'otherx')!;
    assert.equal(other.publicSlug, 'otherx');
    assert.deepEqual(other.publicSlugHistory, []);
    assert.equal(other.liveUrl, 'https://otherx.club.example.test');
  });

  test('change twice: each previous label is retired, history grows oldest first', async () => {
    const body = await json<AddressBody>(setAddress('wpcx', 'capesx', 'cobrasx'));
    assert.deepEqual(body.publicSlugHistory, ['wpcx', 'cobrasx']);
    assert.equal((await tenantByHeader('cobrasx')).status, 404);
    assert.equal((await tenantByHeader('wpcx')).status, 404);
    assert.equal((await json<{ tenant: string }>(tenantByHeader('capesx'))).tenant, 'wpcx');
  });

  test('reclaim an own old label, then the own slug', async () => {
    const back = await json<AddressBody>(setAddress('wpcx', 'cobrasx', 'capesx'));
    assert.equal(back.publicSlug, 'cobrasx');
    assert.deepEqual(back.publicSlugHistory, ['wpcx', 'capesx']);
    assert.equal((await json<{ tenant: string }>(tenantByHeader('cobrasx'))).tenant, 'wpcx');
    assert.equal((await tenantByHeader('capesx')).status, 404);

    const home = await json<AddressBody>(setAddress('wpcx', 'wpcx', 'cobrasx'));
    assert.deepEqual(home, {
      publicSlug: 'wpcx',
      publicSlugHistory: ['capesx', 'cobrasx'],
      liveUrl: 'https://wpcx.club.example.test',
    });
    assert.equal((await json<{ tenant: string }>(tenantByHeader('wpcx'))).tenant, 'wpcx');
    assert.equal((await tenantByHeader('cobrasx')).status, 404);
    // Move off again so later tests have a renamed tenant (wpcx → cobrasx; slug retired).
    await json<AddressBody>(setAddress('wpcx', 'cobrasx', 'wpcx'));
  });
});

describe('PUT /platform/tenants/:slug/address — refusals', () => {
  test("another client's internal ID → 409", async () => {
    const res = await setAddress('wpcx', 'otherx', 'cobrasx');
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; code: string };
    assert.equal(body.code, 'label-is-tenant');
    assert.equal((await json<{ tenant: string }>(tenantByHeader('otherx'))).tenant, 'otherx');
  });

  test("another client's active label → 409; its retired label → 409", async () => {
    await json<AddressBody>(setAddress('otherx', 'brandb', 'otherx'));
    const active = await setAddress('wpcx', 'brandb', 'cobrasx');
    assert.equal(active.status, 409);
    assert.equal(((await active.json()) as { code: string }).code, 'label-active');

    await json<AddressBody>(setAddress('otherx', 'brandb2', 'brandb'));
    for (const label of ['brandb', 'otherx']) {
      const retired = await setAddress('wpcx', label, 'cobrasx');
      assert.equal(retired.status, 409, label);
      assert.equal(((await retired.json()) as { code: string }).code, 'label-retired', label);
    }
    // Nothing moved: wpcx is still on cobrasx, otherx's retired labels still unknown.
    const wpc = await json<AddressBody>(op('GET', '/platform/tenants/wpcx'));
    assert.equal(wpc.publicSlug, 'cobrasx');
    assert.equal((await tenantByHeader('brandb')).status, 404);
  });

  test('a vanity-host tenant → 409 (its address is set in infra)', async () => {
    const res = await setAddress('vanityco', 'vanitynew', 'vanityco');
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /infra\/tenants\.ts/);
    assert.equal(await labelRecord('vanitynew'), null);
  });

  test('a stale expectedCurrent → 409, nothing written', async () => {
    const res = await setAddress('wpcx', 'freshx', 'wpcx');
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, 'stale');
    assert.equal(await labelRecord('freshx'), null);
  });

  test('a no-op change → 400', async () => {
    const res = await setAddress('wpcx', 'cobrasx', 'cobrasx');
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, 'unchanged');
  });

  test('an invalid or reserved label, or a missing expectedCurrent → 400', async () => {
    for (const label of ['Bad Label', '-x', 'a', 'api', 'x'.repeat(33)])
      assert.equal((await setAddress('wpcx', label, 'cobrasx')).status, 400, label);
    assert.equal((await setAddress('wpcx', 'goodx', undefined)).status, 400);
    assert.equal((await setAddress('wpcx', undefined, 'cobrasx')).status, 400);
  });

  test('an unknown tenant → 404', async () => {
    assert.equal((await setAddress('ghostx', 'ghostlabel', 'ghostx')).status, 404);
  });
});

describe('label resolution on the request paths', () => {
  test('GET /tenant: ?tenant= goes through the lookup; nothing presented → 400', async () => {
    assert.equal((await json<{ tenant: string }>(tenantByQuery('cobrasx'))).tenant, 'wpcx');
    assert.equal((await tenantByQuery('wpcx')).status, 404, 'retired own slug');
    assert.equal((await tenantByQuery('neverclaimed')).status, 404, 'unknown label');
    assert.equal((await app.request('/tenant')).status, 400);
  });

  test('a member presenting the retired label is refused; the new label works', async () => {
    const as = (label: string) =>
      app.request('/tenant/config', { headers: { 'x-tenant': label, 'x-dev-auth': WPC_ADMIN } });
    assert.equal((await as('wpcx')).status, 404);
    assert.equal((await as('cobrasx')).status, 200);
  });
});

describe('tenant creation vs public labels', () => {
  test('a duplicate slug is still 409', async () => {
    assert.equal((await createTenant('otherx')).status, 409);
  });

  test('a label in use or retired cannot become a new tenant ID', async () => {
    for (const label of ['brandb2', 'brandb', 'cobrasx', 'capesx']) {
      const res = await createTenant(label);
      assert.equal(res.status, 409, label);
      assert.match(((await res.json()) as { error: string }).error, /web address/, label);
      assert.equal(await repo.getTenantConfig(label), null, label);
    }
  });
});

describe('erasure leaves tombstones', () => {
  test('erase retires every label (never deletes), and a retry after a partial erase is safe', async () => {
    await json<AddressBody>(setAddress('erasex', 'erasebrand', 'erasex'));
    // Simulate a partial erase that removed CONFIG but not the address record.
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
    const raw = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        endpoint: process.env.DYNAMO_ENDPOINT,
        region: 'localhost',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      }),
    );
    await raw.send(
      new DeleteCommand({ TableName: TABLE, Key: { pk: 'TENANT#erasex', sk: 'CONFIG' } }),
    );
    await repo.eraseTenantData('erasex');
    await repo.eraseTenantData('erasex'); // a second retry is a no-op, not an error
    assert.equal(await repo.getTenantPublicAddress('erasex'), null, 'address record deleted');
    for (const label of ['erasex', 'erasebrand']) {
      const rec = await labelRecord(label);
      assert.equal(rec?.status, 'retired', label);
      assert.equal(rec?.tenant, 'erasex', label);
      assert.equal((await tenantByHeader(label)).status, 404, label);
      assert.equal((await createTenant(label)).status, 409, `${label} is never reissued`);
    }
  });
});

describe('address state survives whole-config writes', () => {
  test('a stale whole-config putTenantConfig after a change does not revive the old address', async () => {
    const stale = await repo.getTenantConfig('wpcx');
    assert.ok(stale);
    await json<AddressBody>(setAddress('wpcx', 'stormersx', 'cobrasx'));
    await repo.putTenantConfig(stale);
    assert.equal((await tenantByHeader('cobrasx')).status, 404);
    assert.equal((await json<{ tenant: string }>(tenantByHeader('stormersx'))).tenant, 'wpcx');
    const view = await json<AddressBody>(op('GET', '/platform/tenants/wpcx'));
    assert.equal(view.publicSlug, 'stormersx');
    assert.equal(view.liveUrl, 'https://stormersx.club.example.test');
  });

  test('an operator PUT echoing the GET row cannot write the address fields onto CONFIG', async () => {
    const row = await json<Record<string, unknown>>(op('GET', '/platform/tenants/wpcx'));
    await json(op('PUT', '/platform/tenants/wpcx', { ...row, publicSlug: 'hijackx' }));
    const stored = (await repo.getTenantConfig('wpcx')) as Record<string, unknown> | null;
    assert.equal(stored?.publicSlug, undefined);
    assert.equal(stored?.publicSlugHistory, undefined);
    assert.equal((await tenantByHeader('hijackx')).status, 404);
  });
});

describe('audit', () => {
  test('the address change is recorded with old and new values', async () => {
    await json<AddressBody>(setAddress('wpcx', 'sharksx', 'stormersx'));
    const feed = await repo.listAuditFeed('wpcx', { limit: 5 });
    const entry = feed.items.find((e: AuditEntry) => e.action === 'tenant.address.update');
    assert.ok(entry, 'an entry was written');
    assert.equal(entry.visibility, 'operator');
    const full = await repo.getAuditEntry('wpcx', entry.at, entry.id);
    const target = (full?.detail as AuditDetail).targets.find(
      (t) => t.type === 'tenant' && t.id === 'wpcx',
    );
    assert.deepEqual(target?.changes, [{ field: 'publicSlug', from: 'stormersx', to: 'sharksx' }]);
  });
});

describe('route-built links follow the address change (label cache)', () => {
  const LINK_ADMIN = devAuthAs('adm-link', 'admin@linkx', [
    { tenantId: 'linkx', role: 'admin', clubIds: [] },
  ]);
  const asAdmin = (label: string, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        'x-tenant': label,
        'x-dev-auth': LINK_ADMIN,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test('after PUT …/address a built link uses the new host; the retired host is refused', async () => {
    assert.equal((await createTenant('linkx')).status, 201);
    // Prime this container's label cache with the OLD label: minting the signup link builds
    // its URL from publicLabelFor('linkx'), which caches "linkx".
    const minted = await json<{ url: string }>(
      asAdmin('linkx', 'POST', '/admin/official-signup-link/umpire'),
    );
    assert.equal(new URL(minted.url).host, 'linkx.club.example.test');

    await json<AddressBody>(setAddress('linkx', 'linknewx', 'linkx'));

    // Without clearPublicAddressCache on the change, both of these would still see "linkx".
    const after = await json<{ url: string }>(
      asAdmin('linknewx', 'GET', '/admin/official-signup-link/umpire'),
    );
    assert.equal(new URL(after.url).host, 'linknewx.club.example.test');

    const res = await asAdmin('linknewx', 'POST', '/admin/users', {
      email: 'new.rep@linkx.test',
      role: 'admin',
      link: 'https://linkx.club.example.test/',
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'link host not allowed');
  });
});
