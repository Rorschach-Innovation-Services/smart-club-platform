/**
 * Audit route registry coverage: every mutating route registered on the app has a registry
 * decision (audited or an explicit skip), and every registry key still names a route. Walks
 * `app.routes` — a guarded route appears once per handler (e.g. `requireAdmin` + the handler),
 * and `app.use` registers as method ALL, so both are de-duplicated / ignored.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TABLE_NAME ??= 'AuditCoverageTest';
process.env.LOCAL_AUTH = '1';
process.env.STAGE = 'local';
process.env.AWS_REGION ??= 'localhost';

const { app } = await import('../src/index.js');
const { AUDIT_ENTITY_TYPES, AUDIT_ROUTES, MUTATING_METHODS, auditPathParams, isSkipped } =
  await import('../src/audit-routes.js');

const routeKeys = new Set(
  app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`),
);

test('every mutating route has a registry decision', () => {
  const missing = [...routeKeys].filter(
    (k) => MUTATING_METHODS.has(k.split(' ')[0]) && !(k in AUDIT_ROUTES),
  );
  assert.deepEqual(missing, [], `add these to src/audit-routes.ts: ${missing.join(', ')}`);
});

test('every registry key matches a registered route', () => {
  const stale = Object.keys(AUDIT_ROUTES).filter((k) => !routeKeys.has(k));
  assert.deepEqual(stale, [], `stale registry keys: ${stale.join(', ')}`);
});

test('only audited GETs are registered (never a skipped GET)', () => {
  for (const [k, spec] of Object.entries(AUDIT_ROUTES)) {
    if (k.startsWith('GET ')) assert.ok(!isSkipped(spec), `${k}: list a GET only when audited`);
  }
});

test('specs are well-formed: dotted actions, known entity types, params on the pattern', () => {
  const types = new Set<string>(AUDIT_ENTITY_TYPES);
  for (const [k, spec] of Object.entries(AUDIT_ROUTES)) {
    if (isSkipped(spec)) {
      assert.ok(spec.skip.trim().length > 0, `${k}: skip needs a reason`);
      continue;
    }
    assert.match(spec.action, /^[a-z][a-z-]*(\.[a-z][a-z-]*)+$/, `${k}: action "${spec.action}"`);
    const pattern = k.slice(k.indexOf(' ') + 1);
    const params = new Set(
      pattern
        .split('/')
        .filter((s) => s.startsWith(':'))
        .map((s) => s.slice(1)),
    );
    if (spec.entity) {
      assert.ok(types.has(spec.entity.type), `${k}: unknown entity type ${spec.entity.type}`);
      for (const p of [spec.entity.param ?? []].flat())
        if (p !== '@tenant') assert.ok(params.has(p), `${k}: entity param :${p} not in pattern`);
      for (const p of [spec.entity.param ?? []].flat())
        assert.ok(!spec.redactParams?.includes(p), `${k}: entity uses redacted param :${p}`);
    }
    if (spec.club) assert.ok(params.has(spec.club), `${k}: club param :${spec.club}`);
    if (params.has('token'))
      assert.ok(spec.redactParams?.includes('token'), `${k}: a :token param must be redacted`);
    if (pattern.startsWith('/platform/')) {
      assert.equal(spec.visibility, 'operator', `${k}: platform routes are operator-only`);
      if (params.has('slug')) assert.equal(spec.tenant, 'param:slug', `${k}: tenant from :slug`);
    }
  }
});

test('the decisions the plan names explicitly', () => {
  const skip = (k: string) => {
    const s = AUDIT_ROUTES[k];
    assert.ok(s && isSkipped(s), `${k} should be skipped`);
  };
  skip('POST /integrations/whatsapp/status');
  skip('PATCH /me');
  skip('POST /admin/export-log');
  skip('PUT /local-uploads/local/*');
  for (const k of Object.keys(AUDIT_ROUTES))
    if (/(upload-url|view-url|presign|\/parse|preview|clash-check|clash-hints)$/.test(k)) skip(k);

  const bulk = (k: string) => {
    const s = AUDIT_ROUTES[k];
    assert.ok(s && !isSkipped(s) && s.bulk, `${k} should be bulk`);
  };
  for (const k of [
    'DELETE /clubs/:id',
    'DELETE /admin/players/:nk',
    'DELETE /umpires/:id',
    'DELETE /scorers/:id',
    'POST /umpires/:id/merge',
    'POST /scorers/:id/merge',
    'POST /clubs/:id/roster/commit',
    'POST /clubs/:id/players/batch',
    'POST /umpires/appointments/confirm',
    'POST /platform/tenants/:slug/fixture-amendments/confirm',
    'POST /platform/tenants/:slug/doc-intake/commit',
    'POST /platform/tenants/:slug/roster-intake/commit',
    'POST /platform/tenants/:slug/structure-intake/commit',
    'POST /season-runs/:id/rebase',
    'POST /competitions/:id/regenerate',
    'POST /platform/tenants/:slug/medicoach/reconcile',
  ])
    bulk(k);

  const erase = AUDIT_ROUTES['DELETE /admin/players/:nk'];
  assert.ok(!isSkipped(erase) && erase.redactParams?.includes('nk'));
  for (const k of ['GET /captains-reports/:id/link', 'GET /admin/squad-requests/:id/link']) {
    const s = AUDIT_ROUTES[k];
    assert.ok(s && !isSkipped(s) && s.action === 'link.copy', k);
  }
});

test('auditPathParams reads params off the pattern', () => {
  assert.deepEqual(auditPathParams('/clubs/:id/players/:nk', '/clubs/c1/players/abc'), {
    id: 'c1',
    nk: 'abc',
  });
  assert.deepEqual(auditPathParams('/series/:id', '/series/s%231'), { id: 's#1' });
  assert.deepEqual(auditPathParams('/local-uploads/local/*', '/local-uploads/local/a/b'), {});
});
