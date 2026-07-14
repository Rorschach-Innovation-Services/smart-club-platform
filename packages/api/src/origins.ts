/**
 * Origin trust + canonical-origin helpers, split into two DELIBERATELY separate duties
 * (previously one `originAllowed` served both, conflating them):
 *
 *  - originAllowed(origin)            → CORS. Broad: any trusted app origin may talk to
 *                                       the API cross-origin.
 *  - originAllowedForTenant(o, slug)  → LINK/anti-phishing. Strict: only origins that
 *                                       belong to THIS tenant may be embedded in an
 *                                       admin-triggered invite/registration link.
 *
 * Keeping them apart matters: CORS accepts `*.cloudfront.net` (bare-distribution
 * access) and the wildcard suffix, but a link must NOT — an admin could otherwise aim
 * a platform-branded invite at an attacker-controlled CloudFront clone of the login
 * page. See docs/architecture/0007.
 *
 * Envs (baked from infra/tenants.ts in sst.config.ts; parsed once at module load,
 * matching HOST_TENANT_MAP in auth.ts):
 *   ALLOWED_ORIGINS      comma-separated exact CORS origins (enumerated vanity hosts)
 *   WEB_ORIGIN_MAP       JSON slug → `https://<vanityWebHost>` (canonical per tenant)
 *   WILDCARD_ENABLED     '1' once the wildcard platform is armed
 *   WILDCARD_WEB_SUFFIX  e.g. `.club.medicoach.co.za`
 */

const ALLOWED_ORIGINS: string[] = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const WEB_ORIGIN_MAP: Record<string, string> = (() => {
  try {
    return JSON.parse(process.env.WEB_ORIGIN_MAP ?? '{}');
  } catch (e) {
    // Malformed → empty (safe: canonicalWebOrigin falls back to the wildcard host).
    console.warn('WEB_ORIGIN_MAP is not valid JSON; ignoring it', e);
    return {};
  }
})();

const WILDCARD_ENABLED = process.env.WILDCARD_ENABLED === '1';
const WILDCARD_WEB_SUFFIX = process.env.WILDCARD_WEB_SUFFIX ?? '';

/** A safe single DNS label (the resolved slug) — guards the wildcard-origin builder. */
const LABEL_RE = /^[a-z0-9-]+$/;

/** `https://<slug>.club.medicoach.co.za` when the wildcard platform is armed, else ''. */
function wildcardOrigin(slug: string): string {
  if (!WILDCARD_ENABLED || !WILDCARD_WEB_SUFFIX || !LABEL_RE.test(slug)) return '';
  return `https://${slug}${WILDCARD_WEB_SUFFIX}`;
}

/**
 * True if `origin` (scheme://host[:port]) is a trusted app origin for CORS: localhost
 * (dev), any *.cloudfront.net (bare-distribution access), an explicit ALLOWED_ORIGINS
 * entry (vanity domains), or — when armed — any `https://<label>.club.medicoach.co.za`
 * wildcard tenant host. Broad by design; link validation uses the stricter check below.
 */
export function originAllowed(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const { hostname, protocol } = url;
  if (hostname === 'localhost') return true;
  if (hostname.endsWith('.cloudfront.net')) return true;
  if (
    WILDCARD_ENABLED &&
    protocol === 'https:' &&
    WILDCARD_WEB_SUFFIX &&
    hostname.endsWith(WILDCARD_WEB_SUFFIX) &&
    // Exactly one label in front of the suffix (no `a.b.club.…`), and it's LDH.
    LABEL_RE.test(hostname.slice(0, -WILDCARD_WEB_SUFFIX.length))
  ) {
    return true;
  }
  return false;
}

/**
 * The canonical web origin for a tenant — its vanity host if it has one, else its
 * wildcard host. This is where the tenant's users sign in and where all outbound links
 * point (so links + sessions stay on ONE host per tenant, see D5). Returns null only in
 * the dormant pre-wildcard state for a tenant with no vanity host.
 */
export function canonicalWebOrigin(slug: string): string | null {
  return WEB_ORIGIN_MAP[slug] ?? (wildcardOrigin(slug) || null);
}

/**
 * The set of origins that belong to a tenant (for link validation): its canonical
 * origin, the `www.` variant of a vanity host, and its wildcard host. Excludes
 * cloudfront/localhost/other tenants on purpose.
 */
function tenantOrigins(slug: string): string[] {
  const out = new Set<string>();
  const vanity = WEB_ORIGIN_MAP[slug];
  if (vanity) {
    out.add(vanity);
    try {
      out.add(`https://www.${new URL(vanity).hostname}`);
    } catch {
      /* vanity is built from a valid host in sst.config — ignore if somehow not */
    }
  }
  const wildcard = wildcardOrigin(slug);
  if (wildcard) out.add(wildcard);
  return [...out];
}

/**
 * True if `origin` may be embedded in an invite/registration link for `slug`. STRICT:
 * only that tenant's own origins — never `*.cloudfront.net`, localhost, or another
 * tenant's host. An empty set (dormant pre-wildcard tenant with no vanity) rejects all.
 */
export function originAllowedForTenant(origin: string, slug: string): boolean {
  return tenantOrigins(slug).includes(origin);
}
