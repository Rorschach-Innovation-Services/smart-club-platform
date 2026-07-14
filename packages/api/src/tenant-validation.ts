/**
 * Tenant-slug validation for platform tenant creation. The slug becomes the
 * DynamoDB partition prefix, the leftmost-label host fallback, and — since the
 * wildcard platform — a LIVE hostname `<slug>.club.medicoach.co.za`. So it must be a
 * valid DNS label (LDH: no trailing hyphen — `demo-.club.…` is not resolvable) and
 * must never shadow a platform-reserved name (or the PLATFORM_TENANT sentinel '*').
 */

/**
 * Lowercase DNS-label shape: leading letter, a-z 0-9 hyphen in the middle, and a
 * trailing alphanumeric (no trailing hyphen), 2–32 chars total.
 */
export const TENANT_SLUG_RE = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;

/** Names a tenant may never claim ('*' is the PLATFORM_TENANT sentinel). */
export const RESERVED_TENANT_SLUGS = ['www', 'api', 'platform', 'admin', '*'] as const;

/**
 * Validate a candidate tenant slug. Returns null when valid, else a
 * human-readable reason (callers map it to HTTP 400).
 */
export function validateTenantSlug(slug: string): string | null {
  if (!TENANT_SLUG_RE.test(slug)) {
    return 'slug must be 2–32 chars: a lowercase letter, then lowercase letters, digits or hyphens, ending in a letter or digit (it becomes the club’s web address)';
  }
  if ((RESERVED_TENANT_SLUGS as readonly string[]).includes(slug)) {
    return `slug "${slug}" is reserved`;
  }
  return null;
}
