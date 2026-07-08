/**
 * Tenant vanity-domain registry — the single data source sst.config.ts derives
 * its prod domains, host→tenant map, CORS origins, and web→API map from.
 *
 * Loaded by sst.config.ts via `await import('./infra/tenants')` (SST forbids
 * top-level imports in the config). The helpers below are pure so they can be
 * unit-tested (see src/apiBase.test.ts).
 *
 * ── Onboarding a new client (HARD GATE — sequence matters) ──
 * 1. Re-issue BOTH ACM certs with the new client's hosts added as SANs. ACM
 *    cannot append SANs to an existing cert: you request a NEW cert, and it must
 *    still cover ALL existing hosts (web cert: every enabled webHost + www
 *    variant; API cert: every enabled apiHost) or CloudFront/API GW serve cert
 *    errors for the tenants already live.
 * 2. Wait for the new certs to validate (DNS validation records at the client's
 *    DNS provider), then swap WEB_CERT_ARN / API_CERT_ARN below.
 * 3. Check `aws cloudfront list-distributions` for CNAMEAlreadyExists conflicts
 *    in the shared medicoach account — `sst diff` will NOT catch an alias
 *    already claimed by another distribution; the deploy fails mid-flight.
 * 4. Add the client's VANITY entry (enabled: true) and deploy.
 * 5. Client creates their CNAMEs (webHost/www → CloudFront domain, apiHost →
 *    API GW regional domain — targets in the deploy output / DNS sheet).
 * See docs/guides/onboarding-a-tenant.md for the full runbook.
 *
 * ── Deliberate non-goal ──
 * Never rename `app.name 'dolphins-smart-club'` in sst.config.ts to something
 * platform-neutral: the app name keys ALL Pulumi/CloudFormation state, so a
 * rename recreates every resource (table, pool, buckets, distributions).
 */

// ── Prod ACM certs ──
// Web cert MUST be us-east-1 (CloudFront); API cert MUST be af-south-1 (HTTP API
// custom domains are regional — a us-east-1 cert can't attach). Both cover www.
// NOTE: these ARNs are specific to AWS account 433453514361 — re-issue per
// account if this stack is ever deployed elsewhere. Each cert's SANs must cover
// every host it fronts (web cert: apex + www; API cert: api.<…>) or
// CloudFront/API GW serve cert errors. See docs/guides/onboarding-a-tenant.md.
export const WEB_CERT_ARN =
  'arn:aws:acm:us-east-1:433453514361:certificate/5c749bdd-1687-4ecc-a3b7-f4e35aaab487';
export const API_CERT_ARN =
  'arn:aws:acm:af-south-1:433453514361:certificate/f485b435-3bef-42f0-a27f-3b798e98c8eb';

export interface VanityDomain {
  /** Tenant slug (matches the DynamoDB CONFIG row / resolveTenant()). */
  slug: string;
  /** The client's vanity web host (SPA), e.g. dolphinspipeline.medicoach.co.za. */
  webHost: string;
  /** Whether a www. alias of webHost is also served (cert must cover it). */
  www: boolean;
  /** The tenant's dedicated API host — the API resolves tenant from ITS OWN Host. */
  apiHost: string;
  /** Disabled entries are ignored everywhere (kept for staged onboarding). */
  enabled: boolean;
}

export const VANITY: VanityDomain[] = [
  // First enabled entry is the PRIMARY: it takes SST's built-in `domain:` slot on
  // both the StaticSite and the ApiGatewayV2; later entries ride as aliases /
  // raw API GW domain mappings.
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
 * apiHost. Mirrored to the API (TENANT_HOST_MAP) and the SPA
 * (VITE_TENANT_HOST_MAP); consulted by resolveTenant()/resolveTenantSlug()
 * before the leftmost-label fallback.
 */
export function hostTenantMap(vanity: VanityDomain[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const v of enabledOnly(vanity)) {
    map[v.webHost] = v.slug;
    if (v.www) map[`www.${v.webHost}`] = v.slug;
    map[v.apiHost] = v.slug;
  }
  return map;
}

/**
 * Trusted CORS origins (https:// webHost + www variants) for enabled entries.
 * Enumerated — no suffix matching: originAllowed() also anti-phishing-validates
 * invite/reg-link URLs server-side, so a loose match would widen that gate.
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
 * Web host (and www variant) → API origin (`https://<apiHost>`), for enabled
 * entries. Baked into the SPA as VITE_API_HOST_MAP so apiBase() picks the
 * tenant's own API host at runtime — the API resolves tenant from its Host.
 */
export function apiHostMap(vanity: VanityDomain[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const v of enabledOnly(vanity)) {
    map[v.webHost] = `https://${v.apiHost}`;
    if (v.www) map[`www.${v.webHost}`] = `https://${v.apiHost}`;
  }
  return map;
}
