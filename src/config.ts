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
  // reading the leftmost label. For mapped hosts both resolvers agree.
  const isBareHost = !label || label === 'localhost' || label === 'www' || /^\d+$/.test(label);
  if (!isBareHost && !host.includes('cloudfront.net') && !host.includes('execute-api')) {
    return label;
  }
  const qp = new URLSearchParams(window.location.search).get('tenant');
  return (qp || import.meta.env.VITE_DEFAULT_TENANT || 'dolphins').toLowerCase();
}

/** Inject a tenant's color tokens + title + favicon onto the document. Missing tokens fall back to the default theme. */
export function applyTheme(
  branding?: {
    colors?: Record<string, string>;
    title?: string;
    faviconUrl?: string;
    logoUrl?: string;
  } | null,
) {
  if (!branding) return;
  const root = document.documentElement;
  // Values are set verbatim, so tokens can carry any CSS value — including
  // url(…) images (e.g. --hero-image), not just colors.
  for (const [token, value] of Object.entries(branding.colors ?? {})) {
    root.style.setProperty(token, value);
  }
  if (branding.title) document.title = branding.title;
  // Swap the neutral favicon shipped in index.html for the tenant's own.
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
