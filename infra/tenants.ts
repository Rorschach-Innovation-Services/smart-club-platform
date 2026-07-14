/**
 * Tenant domain registry — the single data source sst.config.ts derives its prod
 * domains, host→tenant map, CORS origins, and web→API map from.
 *
 * Loaded by sst.config.ts via `await import('./infra/tenants')` (SST forbids
 * top-level imports in the config). The helpers below are pure so they can be
 * unit-tested (see src/apiBase.test.ts, packages/api/test/origins.test.ts).
 *
 * ── Two ways a tenant gets a domain ──
 *
 * 1. WILDCARD (default, zero per-tenant work). Every tenant is reachable at
 *    `https://<slug>.club.medicoach.co.za` the moment it's created in the portal —
 *    no cert, no DNS, no deploy. This rides ONE wildcard alias (WILDCARD_WEB_ALIAS)
 *    on the shared CloudFront distribution and ONE shared API host (SHARED_API_HOST),
 *    where the API resolves the tenant from the request's Origin header rather than
 *    its own Host. Armed by setting SHARED_API_CERT_ARN (see the rollout runbook,
 *    docs/runbooks/wildcard-domain-rollout.md).
 *
 * 2. VANITY (optional upsell — a client's own hostname, e.g. dolphinspipeline…).
 *    Still a code + deploy step, but now needs only ONE cert reissue (web), because
 *    a vanity tenant can share SHARED_API_HOST (leave `apiHost` unset) instead of
 *    getting its own API host + af-south-1 cert. Sequence (HARD GATE):
 *      a. Reissue the WEB cert (us-east-1) with the new webHost (+ www) added as
 *         SANs — it must still cover EVERY existing host or live tenants break. Use
 *         `npm --prefix packages/api run request-cert -- --region us-east-1
 *         --replace <WEB_CERT_ARN> --add <webHost> [--add www.<webHost>]` (requests a
 *         superset so a SAN is never dropped). Only reissue the API cert if the client
 *         insists on their OWN apiHost (legacy).
 *      b. Validate (client adds the ACM CNAMEs), then swap WEB_CERT_ARN below.
 *      c. `aws cloudfront list-distributions` — check for a CNAMEAlreadyExists clash
 *         (sst diff won't catch it; the deploy fails mid-flight).
 *      d. Add the VANITY entry (enabled:true) and `npx sst deploy --stage prod`.
 *      e. Client creates the CNAMEs (webHost/www → CloudFront domain; apiHost, if any,
 *         → API GW regional domain — targets in the deploy output / DNS sheet).
 *    See docs/guides/onboarding-a-tenant.md.
 *
 * ── Deliberate non-goal ──
 * Never rename `app.name 'dolphins-smart-club'` in sst.config.ts to something
 * platform-neutral: the app name keys ALL Pulumi/CloudFormation state, so a
 * rename recreates every resource (table, pool, buckets, distributions).
 */

// ── Wildcard platform (scheme 1) ──
// Web: <slug>.club.medicoach.co.za, served by WILDCARD_WEB_ALIAS on the shared
// distribution. API: the ONE shared host below (tenant resolved from Origin — see
// packages/api/src/auth.ts resolveTenant). `club` sits under medicoach.co.za, whose
// DNS is external cPanel: a single `*.club` + `api.club` CNAME pair covers every
// tenant forever (or delegate the club.medicoach.co.za subzone to Route53 — see the
// rollout runbook if cPanel can't host the wildcard).
export const WILDCARD_WEB_SUFFIX = '.club.medicoach.co.za';
export const WILDCARD_WEB_ALIAS = '*.club.medicoach.co.za';
export const SHARED_API_HOST = 'api.club.medicoach.co.za';

// ── Prod ACM certs ──
// Web cert MUST be us-east-1 (CloudFront); API certs MUST be af-south-1 (HTTP API
// custom domains are regional — a us-east-1 cert can't attach). NOTE: these ARNs are
// specific to AWS account 433453514361 — re-issue per account if this stack is ever
// deployed elsewhere. Each cert's SANs must cover every host it fronts.
//
// WEB_CERT_ARN fronts the primary vanity webHost (+ www), every extra vanity host,
// AND (once armed) WILDCARD_WEB_ALIAS. SHARED_API_CERT_ARN is a single-name cert for
// SHARED_API_HOST; setting it (non-empty) ARMS the wildcard platform (adds the wildcard
// alias + shared API domain on the next prod deploy). PREREQUISITE: WEB_CERT_ARN must
// ALREADY be reissued to cover WILDCARD_WEB_ALIAS before you arm, or the deploy adds an
// alias the viewer cert doesn't cover and CloudFront serves cert errors — the rollout
// runbook sequences the web-cert reissue (step 1) before arming (step 2). Leave '' to
// keep the wildcard scheme dormant. (Note: outbound-link validation is per-tenant strict
// whenever a tenant has a canonical origin — that D5 hardening applies in prod
// regardless of arming, since WEB_ORIGIN_MAP is baked for every prod build.)
export const WEB_CERT_ARN =
  'arn:aws:acm:us-east-1:433453514361:certificate/5c749bdd-1687-4ecc-a3b7-f4e35aaab487';
export const API_CERT_ARN =
  'arn:aws:acm:af-south-1:433453514361:certificate/f485b435-3bef-42f0-a27f-3b798e98c8eb';
export const SHARED_API_CERT_ARN = '';

// CloudFront distribution domain (e.g. dxxxx.cloudfront.net). The distribution is
// never replaced (account CloudFront quota is maxed at 20/20), so this is stable —
// kept as a constant to avoid ordering the StaticSite before the API Lambda in
// sst.config.ts. Filled during the wildcard rollout from
// `aws cloudfront list-distributions --profile medicoach`. Baked into the API as
// WEB_CNAME_TARGET so the operator DNS sheet shows the real web CNAME target instead
// of a placeholder. Empty → the DNS sheet shows a "look it up" hint.
export const WEB_CNAME_TARGET = '';

export interface VanityDomain {
  /** Tenant slug (matches the DynamoDB CONFIG row / resolveTenant()). */
  slug: string;
  /** The client's vanity web host (SPA), e.g. dolphinspipeline.medicoach.co.za. */
  webHost: string;
  /** Whether a www. alias of webHost is also served (cert must cover it). */
  www: boolean;
  /**
   * The tenant's OWN API host — the API resolves tenant from ITS OWN Host header.
   * OPTIONAL: leave unset so the vanity web host talks to SHARED_API_HOST instead
   * (tenant resolved from Origin), which avoids an af-south-1 cert reissue. Only set
   * it for a client that insists on a dedicated API hostname (legacy).
   */
  apiHost?: string;
  /** Disabled entries are ignored everywhere (kept for staged onboarding). */
  enabled: boolean;
}

export const VANITY: VanityDomain[] = [
  // First enabled entry is the PRIMARY: it takes SST's built-in `domain:` slot on
  // both the StaticSite and the ApiGatewayV2; later entries ride as aliases /
  // raw API GW domain mappings. The PRIMARY must keep an explicit apiHost (it feeds
  // SST's ApiGatewayV2 `domain:` slot and api.url → VITE_API_URL fallback).
  {
    slug: 'dolphins',
    webHost: 'dolphinspipeline.medicoach.co.za',
    www: true,
    apiHost: 'api.dolphinspipeline.medicoach.co.za',
    enabled: true,
  },
];

const enabledOnly = (vanity: VanityDomain[]) => vanity.filter((v) => v.enabled);

/**
 * Host → tenant slug, for enabled entries: webHost, www.webHost (when www), and
 * apiHost (when the tenant has its own). Mirrored to the API (TENANT_HOST_MAP) and
 * the SPA (VITE_TENANT_HOST_MAP); consulted by resolveTenant()/resolveTenantSlug()
 * before the leftmost-label / Origin fallbacks.
 */
export function hostTenantMap(vanity: VanityDomain[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const v of enabledOnly(vanity)) {
    map[v.webHost] = v.slug;
    if (v.www) map[`www.${v.webHost}`] = v.slug;
    if (v.apiHost) map[v.apiHost] = v.slug;
  }
  return map;
}

/**
 * Slug → canonical web origin (`https://<webHost>`) for enabled vanity entries.
 * Baked into the API (WEB_ORIGIN_MAP) and SPA (VITE_WEB_ORIGIN_MAP): canonicalWebOrigin()
 * uses it to build invite/registration links and the D5 canonical-origin redirect, so a
 * vanity tenant's links + sessions stay on its own host rather than the wildcard host.
 */
export function webOriginMap(vanity: VanityDomain[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const v of enabledOnly(vanity)) {
    map[v.slug] = `https://${v.webHost}`;
  }
  return map;
}

/**
 * Trusted CORS origins (https:// webHost + www variants) for enabled entries.
 * The wildcard suffix (`*.club.medicoach.co.za`) is NOT enumerated here — it's
 * matched by regex in packages/api/src/origins.ts. Link/anti-phishing validation
 * uses the stricter originAllowedForTenant() (canonical origin only), so a loose
 * CORS match doesn't widen that gate.
 */
export function allowedOrigins(vanity: VanityDomain[]): string[] {
  const origins: string[] = [];
  for (const v of enabledOnly(vanity)) {
    origins.push(`https://${v.webHost}`);
    if (v.www) origins.push(`https://www.${v.webHost}`);
  }
  return origins;
}

/**
 * Web host (and www variant) → API origin, for enabled entries. Baked into the SPA
 * as VITE_API_HOST_MAP so apiBase() picks the right API host at runtime: a tenant's
 * own apiHost when it has one, else SHARED_API_HOST (the API resolves the tenant from
 * the Origin header on the shared host).
 */
export function apiHostMap(vanity: VanityDomain[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const v of enabledOnly(vanity)) {
    const apiOrigin = v.apiHost ? `https://${v.apiHost}` : `https://${SHARED_API_HOST}`;
    map[v.webHost] = apiOrigin;
    if (v.www) map[`www.${v.webHost}`] = apiOrigin;
  }
  return map;
}
