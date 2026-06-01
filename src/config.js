/**
 * Tenant resolution + theming.
 *
 * The platform is multi-tenant: which union's branding the SPA shows is decided
 * by the host. In prod a CloudFront Function resolves host → branding at the edge
 * (no flash); this module is the client-side baseline that also works in dev,
 * where there's no subdomain — it falls back to ?tenant= or VITE_DEFAULT_TENANT.
 *
 * Theming is applied non-blocking onto a neutral default shipped in index.html,
 * so first paint never shows the wrong brand. See docs/architecture/0002.
 */
import { setActiveTenant, getTenant } from './api.js';

/** Resolve the tenant slug: subdomain → ?tenant= → build default → 'dolphins'. */
export function resolveTenantSlug() {
  const host = window.location.hostname;
  const label = host.split('.')[0];
  const isBareHost = !label || label === 'localhost' || label === 'www' || /^\d+$/.test(label);
  if (!isBareHost && !host.includes('cloudfront.net') && !host.includes('execute-api')) {
    return label.toLowerCase();
  }
  const qp = new URLSearchParams(window.location.search).get('tenant');
  return (qp || import.meta.env.VITE_DEFAULT_TENANT || 'dolphins').toLowerCase();
}

/** Inject a tenant's color tokens + title onto :root. Missing tokens fall back to the default theme. */
export function applyTheme(branding) {
  if (!branding) return;
  const root = document.documentElement;
  for (const [token, value] of Object.entries(branding.colors ?? {})) {
    root.style.setProperty(token, value);
  }
  if (branding.title) document.title = branding.title;
}

/** Resolve the slug, register it with the API client, and fetch + apply branding. */
export async function bootstrapTenant() {
  const slug = resolveTenantSlug();
  setActiveTenant(slug);
  try {
    const config = await getTenant();
    applyTheme(config.branding);
    return config;
  } catch {
    // No backend yet / unknown tenant: keep the neutral default theme.
    return { tenant: slug, branding: null, submissionDeadline: null };
  }
}
