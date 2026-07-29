/**
 * The canonical club-id slug rule.
 *
 * Lives in its own module because three unrelated callers must agree on it exactly:
 * the club builder, the public signup's collision pre-check ("Kingsmead-CC" and
 * "Kingsmead CC" are different names but the same id), and the seed CLI — which
 * cannot import index.ts without pulling in the whole Hono app.
 */

/** Canonical club id from a name: lowercase, non-alphanumerics collapsed to hyphens. */
export function clubIdFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
