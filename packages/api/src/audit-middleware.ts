/**
 * Platform audit trail — the request middleware (the safety net; plan: audit-trail Phase 1).
 *
 * `auditMiddleware` (registered right after CORS) opens the request's audit scope around the
 * whole chain and, after the handler, writes at most ONE entry:
 *   - mutating method (or an audited GET) and status < 400 → `ok`;
 *   - mutating method (or an audited GET) and 5xx → `failed`;
 *   - anything a handler recorded (auditSet action/counts, auditTarget, auditMention) → written
 *     whatever the method/status (4xx ⇒ `failed`), e.g. a 409 thrown after a committed write;
 *   - a plain 4xx with nothing recorded → nothing; a `skip` route → only if recorded.
 *
 * `auditStartedMiddleware` (registered AFTER the auth prefix middleware, so the caller is
 * known) writes a "started" headline for `bulk` routes before the handler runs; the final entry
 * reuses the scope's id and instant, so it overwrites that headline row for row. A Lambda
 * timeout therefore still leaves who started what. A bulk request refused with 400, 401, 403
 * or 404 before the handler recorded anything deletes its started rows instead, so a plain
 * refusal leaves no entry on a bulk route either. Any other 4xx (409, 422, …) closes the
 * started entry as `failed`: it may follow a write the handler did not record.
 *
 * An erasing route (`erases` in the registry) is flushed after its scrub, so its own entry is
 * stripped of the erased type's labels and values first (audit.redactScopeFor).
 *
 * Fail-open: the change is already committed when the entry is written, so an audit failure
 * never changes the response — it goes to Sentry plus one PII-free `console.error` line. A
 * write the table refuses is retried once as a headline-only entry (audit.headlineOnly).
 */
import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import { Sentry } from './instrument.js';
import type { HonoEnv } from './auth.js';
import {
  buildEntry,
  currentAuditScope,
  headlineOnly,
  newAuditScope,
  redactScopeFor,
  runAudited,
  type AuditRowSet,
  type AuditScope,
} from './audit.js';
import {
  MUTATING_METHODS,
  auditPathParams,
  auditRouteSpec,
  isSkipped,
  type AuditRouteSpec,
  type AuditedRouteSpec,
} from './audit-routes.js';
import * as repo from './repo.js';
import { PLATFORM_TENANT, type AuditActor } from './types.js';

type Writer = (set: AuditRowSet) => Promise<void>;
let writer: Writer = (set) => repo.putAuditEntry(set);

/**
 * Replace the audit writer (tests only: forcing a write failure, or timing the flush). Pass
 * null to restore the repo writer.
 */
export function setAuditWriterForTests(w: Writer | null): void {
  writer = w ?? ((set) => repo.putAuditEntry(set));
}

interface RequestState {
  method: string;
  pattern?: string;
  spec?: AuditRouteSpec;
  requestId: string;
  /** The "started" rows, once written (or attempted): the final entry overwrites them. */
  started?: AuditRowSet;
}

const states = new WeakMap<AuditScope, RequestState>();

/** Statuses that drop a bulk request's started rows when the handler recorded nothing. */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404]);

/** The handler's route: the last matched non-middleware entry. */
function matchedPattern(c: Context<HonoEnv>): string | undefined {
  try {
    const routes = matchedRoutes(c);
    for (let i = routes.length - 1; i >= 0; i--)
      if (routes[i].method !== 'ALL') return routes[i].path;
  } catch {
    /* no match result (404) */
  }
  return undefined;
}

/** The signed-in caller, keyed on the Cognito sub. Undefined for a public request. */
function actorFromContext(c: Context<HonoEnv>, pattern?: string): AuditActor | undefined {
  const auth = c.get('auth');
  if (!auth?.sub) return undefined;
  const ra = c.get('requestAuth');
  const operator = auth.memberships.some(
    (m) => m.tenantId === PLATFORM_TENANT && m.role === 'operator',
  );
  const email = typeof auth.email === 'string' && auth.email.trim() ? auth.email.trim() : undefined;
  const role = ra?.membership.role ?? (operator ? 'operator' : undefined);
  return {
    kind: 'user',
    key: auth.sub,
    sub: auth.sub,
    ...(email ? { email } : {}),
    ...(role ? { role } : {}),
    ...(operator ? { operator: true } : {}),
    via: pattern?.startsWith('/platform/') ? 'platform' : 'console',
  };
}

/** Facts the registry gives before the handler runs: visibility, :slug tenant, default target. */
function applySpecDefaults(
  scope: AuditScope,
  spec: AuditedRouteSpec,
  params: Record<string, string>,
): void {
  if (spec.visibility) scope.visibility = spec.visibility;
  if (spec.tenant === 'param:slug' && params.slug) scope.tenant = params.slug;
  const redact = new Set(spec.redactParams ?? []);
  redact.add('token');
  const value = (p: string) => (redact.has(p) ? undefined : params[p]);
  const clubId = spec.club ? value(spec.club) : undefined;
  const op = spec.action.split('.').at(-1)!;
  if (spec.entity) {
    let id: string | undefined;
    if (spec.entity.id) id = spec.entity.id;
    else if (spec.entity.param === '@tenant')
      id = undefined; // filled once the tenant is known
    else if (spec.entity.param) {
      const parts = [spec.entity.param].flat().map(value);
      id = parts.every((x) => !!x) ? parts.join('#') : undefined;
    }
    if (id)
      scope.targets.push({
        type: spec.entity.type,
        id,
        op,
        ...(clubId ? { clubId } : {}),
        changes: [],
      });
  } else if (clubId) {
    scope.targets.push({ type: 'club', id: clubId, op, changes: [] });
  }
}

/** Tenant-dependent facts, once auth has run: the `auth` tenant and an `@tenant` target. */
function applyTenantDefaults(c: Context<HonoEnv>, scope: AuditScope, spec?: AuditedRouteSpec) {
  if (!scope.tenant && (spec?.tenant ?? 'auth') === 'auth') {
    const t = c.get('requestAuth')?.tenant;
    if (t) scope.tenant = t;
  }
  if (spec?.entity?.param === '@tenant' && scope.tenant) {
    const type = spec.entity.type;
    if (!scope.targets.some((t) => t.type === type && t.id === scope.tenant))
      scope.targets.unshift({
        type,
        id: scope.tenant,
        op: spec.action.split('.').at(-1)!,
        changes: [],
      });
  }
}

function logFailure(
  err: unknown,
  scope: AuditScope,
  st: RequestState | undefined,
  action?: string,
  msg = 'audit-write-failed',
) {
  try {
    Sentry.captureException(err);
    console.error(
      JSON.stringify({
        msg,
        actor: scope.actor?.key ?? 'unattributed',
        at: scope.at,
        method: st?.method,
        pattern: st?.pattern,
        action: action ?? scope.action ?? 'unknown',
        error: (err as Error)?.name ?? 'Error',
      }),
    );
  } catch {
    /* never let logging break the response */
  }
}

/** Global middleware: opens the scope, flushes one entry afterwards. Register after CORS. */
export const auditMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  let scope: AuditScope;
  let st: RequestState;
  try {
    const method = c.req.method;
    const pattern = matchedPattern(c);
    const spec = pattern ? auditRouteSpec(method, pattern) : undefined;
    const env = c.env as { requestContext?: { requestId?: string } } | undefined;
    st = {
      method,
      ...(pattern ? { pattern } : {}),
      ...(spec ? { spec } : {}),
      requestId: env?.requestContext?.requestId ?? randomUUID(),
    };
    scope = newAuditScope();
    if (spec && !isSkipped(spec) && pattern)
      applySpecDefaults(scope, spec, auditPathParams(pattern, c.req.path));
    states.set(scope, st);
  } catch (err) {
    Sentry.captureException(err);
    await next();
    return;
  }

  await runAudited(scope, () => next());

  try {
    await flush(c, scope, st);
  } catch (err) {
    logFailure(err, scope, st);
  }
};

async function flush(c: Context<HonoEnv>, scope: AuditScope, st: RequestState): Promise<void> {
  const status = c.res?.status ?? 500;
  const { spec, pattern, method } = st;
  const audited = spec && !isSkipped(spec) ? spec : undefined;
  const mutating = MUTATING_METHODS.has(method);
  // A GET is audited only when the registry lists it (a link copy).
  const auditedRequest = (mutating && !(spec && isSkipped(spec))) || (!mutating && !!audited);

  // A bulk request refused before the handler recorded anything (bad input, not signed in,
  // forbidden, not found): no entry, so drop the started rows rather than close them as
  // `failed`. Any other 4xx (a 409 …) may follow a partial write, so it closes as `failed`.
  if (st.started && !scope.recorded && REFUSAL_STATUSES.has(status)) {
    await repo.deleteAuditRows(st.started.rows);
    return;
  }

  let write: boolean;
  if (scope.recorded || st.started) write = true;
  else if (!auditedRequest) write = false;
  else write = status < 400 || status >= 500;
  if (!write) return;

  if (mutating && pattern && !spec)
    Sentry.captureMessage(`audit: unregistered route ${method} ${pattern}`, 'warning');

  if (!scope.pinned) {
    scope.actor ??= actorFromContext(c, pattern);
    applyTenantDefaults(c, scope, audited);
  }
  if (audited?.erases)
    redactScopeFor(scope, audited.erases, { blankIds: audited.erases === 'player' });
  const set = buildEntry(scope, {
    status,
    requestId: st.requestId,
    ...(pattern ? { route: { method, pattern } } : {}),
    action: audited?.action ?? 'unknown',
  });
  await writeOrHeadline(set, scope, st);
}

/**
 * Write an entry; if the table refuses it (e.g. a key over the size limit), retry once with the
 * headline alone, so who/when/what survives. Never throws.
 */
async function writeOrHeadline(set: AuditRowSet, scope: AuditScope, st: RequestState) {
  try {
    await writer(set);
    return;
  } catch (err) {
    if (set.rows.length <= 1) {
      logFailure(err, scope, st, set.entry.action);
      return;
    }
    try {
      await writer(headlineOnly(set));
      logFailure(err, scope, st, set.entry.action, 'audit-write-degraded');
    } catch (err2) {
      logFailure(err2, scope, st, set.entry.action);
    }
  }
}

/**
 * The "started" headline for `bulk` routes. Registered after the auth prefix middleware, so
 * `auth` / `requestAuth` are set; routes registered before it (public, /me) never reach it.
 */
export const auditStartedMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const scope = currentAuditScope();
  const st = scope && states.get(scope);
  const spec = st?.spec;
  if (scope && st && spec && !isSkipped(spec) && spec.bulk && !st.started) {
    try {
      scope.actor ??= actorFromContext(c, st.pattern);
      applyTenantDefaults(c, scope, spec);
      if (spec.erases) redactScopeFor(scope, spec.erases, { blankIds: spec.erases === 'player' });
      const set = buildEntry(scope, {
        status: 0,
        outcome: 'started',
        requestId: st.requestId,
        ...(st.pattern ? { route: { method: st.method, pattern: st.pattern } } : {}),
        action: spec.action,
      });
      // From here the tenant and actor are fixed: the final entry must land on these rows.
      st.started = set;
      scope.pinned = true;
      await writeOrHeadline(set, scope, st);
    } catch (err) {
      logFailure(err, scope, st, spec.action);
    }
  }
  await next();
};
