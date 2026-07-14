/**
 * Tenant resolution + theming.
 *
 * The platform is multi-tenant: which union's branding the SPA shows is decided
 * by the host. Resolution is client-side: an explicit host→tenant map (custom domains
 * whose host label isn't the slug, e.g. `dolphinspipeline` → `dolphins`), else the
 * subdomain, else ?tenant= / VITE_DEFAULT_TENANT in dev (no subdomain locally).
 *
 * Theming is applied non-blocking onto a neutral default shipped in index.html. There
 * is no edge function, so first paint shows the neutral default until JS themes it —
 * never the *wrong* brand, but a brief neutral flash is expected. See docs/architecture/0002.
 */

import { LEGACY_TO_ROLE, fontStack } from './platform-theme';

// Host → tenant slug (JSON env, mirrors TENANT_HOST_MAP in sst.config.ts). Empty off-prod.
const HOST_TENANT_MAP = (() => {
  try {
    return JSON.parse(import.meta.env.VITE_TENANT_HOST_MAP ?? '{}');
  } catch (e) {
    // Malformed map → empty (safe: falls back to subdomain/default). Error so a prod
    // misconfiguration is debuggable instead of silently breaking the vanity host.
    console.error('VITE_TENANT_HOST_MAP is not valid JSON; ignoring it', e);
    return {};
  }
})();

/** Resolve the tenant slug: host map → subdomain → ?tenant= → build default → 'dolphins'. */
export function resolveTenantSlug() {
  const host = window.location.hostname.toLowerCase();
  if (HOST_TENANT_MAP[host]) return HOST_TENANT_MAP[host];
  const label = host.split('.')[0];
  // Mirrors resolveTenant() in packages/api/src/auth.ts, with two client-only guards the
  // backend doesn't need (it never sees a CloudFront/execute-api Host): a bare/cloudfront/
  // execute-api host here falls through to ?tenant=/VITE_DEFAULT_TENANT rather than mis-
  // reading the leftmost label. For mapped hosts both resolvers agree. A wildcard host
  // `<slug>.club.medicoach.co.za` resolves here via the leftmost label — the same path.
  const isBareHost = !label || label === 'localhost' || label === 'www' || /^\d+$/.test(label);
  if (!isBareHost && !host.includes('cloudfront.net') && !host.includes('execute-api')) {
    return label;
  }
  const qp = new URLSearchParams(window.location.search).get('tenant');
  return (qp || import.meta.env.VITE_DEFAULT_TENANT || 'dolphins').toLowerCase();
}

// slug → canonical vanity web origin (mirrors WEB_ORIGIN_MAP in the API). Empty off-prod.
const WEB_ORIGIN_MAP: Record<string, string> = (() => {
  try {
    return JSON.parse(import.meta.env.VITE_WEB_ORIGIN_MAP ?? '{}');
  } catch (e) {
    console.error('VITE_WEB_ORIGIN_MAP is not valid JSON; ignoring it', e);
    return {};
  }
})();

/**
 * D5 — keep every tenant on ONE origin. A tenant with its own vanity host is also
 * reachable on the shared wildcard host `<slug>.club.medicoach.co.za`, but sessions
 * (localStorage/Cognito tokens) don't cross origins, so we bounce the wildcard host to
 * the vanity host before the app boots. Scoped narrowly: fires ONLY when currently on
 * the wildcard host AND the tenant has a canonical vanity origin — never touches the
 * vanity host itself, the bare CloudFront host, or wildcard-only tenants. Call once at
 * startup (main.tsx) before rendering; returns true if it redirected.
 */
export function redirectToCanonicalOrigin(): boolean {
  const suffix = import.meta.env.VITE_WILDCARD_WEB_SUFFIX ?? '';
  const host = window.location.hostname.toLowerCase();
  if (!suffix || !host.endsWith(suffix)) return false;
  const canonical = WEB_ORIGIN_MAP[resolveTenantSlug()];
  if (!canonical || canonical === window.location.origin) return false;
  window.location.replace(
    canonical + window.location.pathname + window.location.search + window.location.hash,
  );
  return true;
}

/** Inject a tenant's color tokens + font + title + favicon onto the document. Missing tokens fall back to the default theme. */
export function applyTheme(
  branding?: {
    colors?: Record<string, string>;
    font?: { family?: string; url?: string };
    title?: string;
    faviconUrl?: string;
    logoUrl?: string;
  } | null,
) {
  if (!branding) return;
  const root = document.documentElement;
  // Values are set verbatim, so tokens can carry any CSS value — including
  // url(…) images (e.g. --hero-image), not just colors. Legacy value-named keys
  // (--green…) are rewritten to their semantic role token so --brand-primary stays
  // authoritative; the primitives alias the roles in index.html, so either shape renders.
  for (const [token, value] of Object.entries(branding.colors ?? {})) {
    root.style.setProperty(LEGACY_TO_ROLE[token] ?? token, value);
  }
  // Typeface: set the --brand-font role and, if the family needs a web font, inject its
  // stylesheet (same swap pattern as the favicon below). A web font fetches over the
  // network, so a brief FOUT before it loads is expected.
  if (branding.font?.family)
    root.style.setProperty('--brand-font', fontStack(branding.font.family));
  if (branding.font?.url) injectFontLink(branding.font.url);
  if (branding.title) document.title = branding.title;
  // Swap the neutral favicon shipped in index.html for the tenant's own.
  applyFavicon(branding);
}

/** Add (once) a tenant web-font stylesheet, keyed by href so re-themes don't duplicate it. */
function injectFontLink(href: string) {
  const existing = document.querySelector<HTMLLinkElement>('link[data-brand-font]');
  if (existing) {
    if (existing.href === href) return;
    existing.href = href;
    return;
  }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.dataset.brandFont = '';
  link.href = href;
  document.head.appendChild(link);
}

/** The favicon swap, factored out of applyTheme for readability. */
function applyFavicon(branding: { faviconUrl?: string; logoUrl?: string }) {
  const favicon = branding.faviconUrl ?? branding.logoUrl;
  if (favicon) {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) {
      // The static link declares type="image/svg+xml" for the bundled neutral icon;
      // the tenant asset may be any image type, so drop the now-wrong hint.
      link.removeAttribute('type');
      link.href = favicon;
    }
  }
}
