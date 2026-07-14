/**
 * Authentication + tenant authorization for the Hono API.
 *
 * - JWT is verified in-app (aws-jwt-verify) rather than by an API Gateway
 *   authorizer, so public routes (/tenant, /register) and protected routes share
 *   one $default route.
 * - The request's tenant is resolved from the host (locked to custom domains in
 *   prod) or an explicit `x-tenant` header for dev. The caller's membership for
 *   that tenant is selected from the token's `memberships` claim; if there is no
 *   matching membership, access is denied. This is the tenant-isolation boundary.
 *
 * See docs/architecture/0002 and 0003.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { Sentry } from './instrument.js';
import { PLATFORM_TENANT } from './types.js';
import type { Membership, Role } from './types.js';

export interface AuthContext {
  sub: string;
  email: string;
  memberships: Membership[];
}

export interface RequestAuth {
  tenant: string;
  membership: Membership;
  sub: string;
  email: string;
}

export type HonoEnv = {
  Variables: {
    auth?: AuthContext;
    requestAuth?: RequestAuth;
  };
};

// Lazily created so the local dev stack (LOCAL_AUTH=1, no USER_POOL_ID) can
// import this module without constructing a Cognito verifier.
let _verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;
function getVerifier() {
  if (!_verifier) {
    _verifier = CognitoJwtVerifier.create({
      userPoolId: process.env.USER_POOL_ID!,
      tokenUse: 'id',
      clientId: process.env.USER_POOL_CLIENT_ID!,
    });
  }
  return _verifier;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Custom-domain host → tenant slug (JSON env, set in sst.config.ts). Custom domains
// don't follow the leftmost-label convention — the API lives at `api.<…>` and a union's
// vanity host can differ from its slug (e.g. `dolphinspipeline` → `dolphins`) — so map
// them explicitly. Parsed once at module load (matches repo.ts reading TABLE_NAME).
const HOST_TENANT_MAP: Record<string, string> = (() => {
  try {
    return JSON.parse(process.env.TENANT_HOST_MAP ?? '{}');
  } catch (e) {
    // Malformed map → empty (safe: falls back to leftmost-label). Warn so a prod
    // misconfiguration is debuggable instead of silently breaking the vanity host.
    console.warn('TENANT_HOST_MAP is not valid JSON; ignoring it', e);
    return {};
  }
})();

// Wildcard platform (scheme 1): the ONE shared API host every wildcard tenant calls,
// and the web suffix its Origin carries. WILDCARD_ENABLED gates the Origin branch so
// the resolver behaves exactly as before until the wildcard is armed. See origins.ts.
const SHARED_API_HOST = (process.env.SHARED_API_HOST ?? '').toLowerCase();
const WILDCARD_WEB_SUFFIX = (process.env.WILDCARD_WEB_SUFFIX ?? '').toLowerCase();
const WILDCARD_ENABLED = process.env.WILDCARD_ENABLED === '1';
/** A safe single DNS label. */
const LABEL_RE = /^[a-z0-9-]+$/;

/**
 * Derive the tenant from a browser Origin when the request hits the SHARED_API_HOST
 * (where the Host is `api.club.…` for everyone, so it can't identify the tenant). A
 * vanity web origin sharing the shared API resolves via the host map; a wildcard web
 * origin resolves to its single leftmost label. Anything else (missing/foreign Origin,
 * a multi-label `a.b.club.…`) returns null — the shared host NEVER falls through to
 * leftmost-label (that would yield the reserved slug 'api'). Origin is spoofable by
 * non-browser clients, but that only lets a caller SELECT a tenant they already hold a
 * membership in (the JWT `memberships` claim is the isolation boundary) — see auth
 * docs / docs/architecture/0007.
 */
function tenantFromOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (HOST_TENANT_MAP[host]) return HOST_TENANT_MAP[host];
  if (WILDCARD_WEB_SUFFIX && host.endsWith(WILDCARD_WEB_SUFFIX)) {
    const label = host.slice(0, -WILDCARD_WEB_SUFFIX.length);
    if (LABEL_RE.test(label)) return label;
  }
  return null;
}

/**
 * Resolve the tenant slug for a request. Prod order: an explicit host→tenant map entry
 * (vanity web + api hosts) → the shared API host's Origin-derived tenant → the leftmost
 * label of the Host (e.g. `dolphins.example.com` → `dolphins`). Dev: an explicit
 * `x-tenant` header. Returns null if it can't be determined (callers decide whether
 * that's fatal).
 */
export function resolveTenant(c: Context): string | null {
  // The x-tenant header is a DEV convenience only (no custom domains locally).
  // In prod the host is the authorization boundary, so the header is ignored —
  // otherwise any caller could target any tenant they hold a membership in.
  if (process.env.STAGE !== 'prod') {
    const explicit = c.req.header('x-tenant');
    if (explicit) return explicit.toLowerCase();
  }
  const host = (c.req.header('host') ?? '').split(':')[0].toLowerCase();
  // Explicit custom-domain mapping wins (covers per-tenant API hosts + vanity web hosts).
  if (HOST_TENANT_MAP[host]) return HOST_TENANT_MAP[host];
  // Shared API host: resolve from Origin, and never fall through to leftmost-label.
  if (WILDCARD_ENABLED && SHARED_API_HOST && host === SHARED_API_HOST) {
    return tenantFromOrigin(c.req.header('origin'));
  }
  const label = host.split('.')[0];
  // Ignore non-tenant hosts (raw execute-api/localhost) so the API-Gateway
  // default domain can't be used to bypass host-based tenant inference.
  if (!label || label === 'localhost' || host.includes('execute-api')) return null;
  return label;
}

/** Parse + verify the bearer token and attach the decoded auth context. */
export const authenticate: MiddlewareHandler<HonoEnv> = async (c, next) => {
  // LOCAL-DEV ONLY: when LOCAL_AUTH=1 (offline stack, never set in AWS), trust an
  // `x-dev-auth` header carrying base64(JSON {sub,email,memberships}) instead of a
  // real Cognito JWT — Cognito passwordless OTP can't run offline. Strictly gated.
  if (process.env.LOCAL_AUTH === '1') {
    const raw = c.req.header('x-dev-auth');
    if (!raw) throw new HttpError(401, 'missing x-dev-auth (local dev)');
    try {
      const dev = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      c.set('auth', {
        sub: dev.sub ?? 'dev',
        email: dev.email ?? 'dev@local',
        // Fail closed on a malformed identity rather than passing a non-array shape on.
        memberships: Array.isArray(dev.memberships) ? dev.memberships : [],
      });
    } catch {
      throw new HttpError(401, 'invalid x-dev-auth');
    }
    await next();
    return;
  }

  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new HttpError(401, 'missing bearer token');
  let payload: Record<string, unknown>;
  try {
    payload = (await getVerifier().verify(token)) as unknown as Record<string, unknown>;
  } catch {
    throw new HttpError(401, 'invalid token');
  }
  let memberships: Membership[] = [];
  try {
    memberships = JSON.parse((payload.memberships as string) ?? '[]');
  } catch {
    memberships = [];
  }
  c.set('auth', {
    sub: payload.sub as string,
    email: (payload.email as string) ?? '',
    memberships,
  });
  await next();
};

/**
 * Require an authenticated caller with a membership in the request's tenant.
 * Attaches `requestAuth` (tenant + that membership). Use after `authenticate`.
 */
export const requireTenantMembership: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const auth = c.get('auth');
  if (!auth) throw new HttpError(401, 'unauthenticated');
  const tenant = resolveTenant(c);
  if (!tenant) throw new HttpError(400, 'tenant could not be resolved');
  const membership = auth.memberships.find((m) => m.tenantId === tenant);
  if (!membership) throw new HttpError(403, 'no membership for this tenant');
  c.set('requestAuth', {
    tenant,
    membership,
    sub: auth.sub,
    email: auth.email,
  });
  // Fingerprint every error from here on with who/where, for per-club triage.
  // No-op when Sentry isn't initialised (no DSN). wrapHandler gives each Lambda
  // invocation its own isolation scope, so this doesn't leak across requests.
  Sentry.setUser({ id: auth.sub });
  Sentry.setTag('tenant', tenant);
  Sentry.setTag('role', membership.role);
  await next();
};

/** Require the caller to be an admin of the request's tenant. */
export const requireAdmin: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const ra = c.get('requestAuth');
  if (!ra || ra.membership.role !== 'admin') throw new HttpError(403, 'admin only');
  await next();
};

/**
 * Require the caller to hold the PLATFORM membership `{tenantId: '*', role: 'operator'}`.
 * Tenant-independent (no host resolution): the /platform/* portal manages every tenant,
 * so it never runs through requireTenantMembership. Use after `authenticate`.
 */
export const requirePlatformOperator: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const auth = c.get('auth');
  if (!auth) throw new HttpError(401, 'unauthenticated');
  const membership = auth.memberships.find(
    (m) => m.tenantId === PLATFORM_TENANT && m.role === 'operator',
  );
  if (!membership) throw new HttpError(403, 'platform operator only');
  // Same triage fingerprinting requireTenantMembership applies (no tenant tag —
  // platform routes are tenant-independent).
  Sentry.setUser({ id: auth.sub });
  Sentry.setTag('role', membership.role);
  await next();
};

/** Assert a rep may act on a given club (admins may act on any club in tenant). */
export function assertClubAccess(ra: RequestAuth, clubId: string): void {
  if (ra.membership.role === 'admin') return;
  if (!ra.membership.clubIds.includes(clubId)) {
    throw new HttpError(403, 'not authorized for this club');
  }
}

export type { Role };
