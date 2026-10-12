/**
 * Deep links carried by clearance notices (emails, the WhatsApp v2 template, the reminder cron's
 * digest). Each audience gets its own URL so a chair never lands on an admin route (and vice
 * versa); the frontend reads `?clearance=<id>` to surface that clearance.
 *
 * Pure: the caller resolves the ORIGIN. Anonymous paths (the public register route, transfer-window
 * auto-reject) and the cron must pass `canonicalWebOrigin(slug)` only — never a request Origin
 * header, which `originAllowed` accepts for any `*.cloudfront.net` host and would let an anonymous
 * caller plant an attacker-controlled link in a legitimately branded email. A null origin means
 * "no link": every notice then renders exactly as it did before links existed.
 */

/** A club chair's link: the clearance in their own club portal. */
export function clearanceChairLink(
  origin: string | null | undefined,
  clubId: string,
  clearanceId: string,
): string | undefined {
  if (!origin) return undefined;
  return `${origin}/club/${encodeURIComponent(clubId)}/clearances?clearance=${encodeURIComponent(clearanceId)}`;
}

/** A union admin's link: the clearance in the admin console. */
export function clearanceAdminLink(
  origin: string | null | undefined,
  clearanceId: string,
): string | undefined {
  if (!origin) return undefined;
  return `${origin}/admin/clearances?clearance=${encodeURIComponent(clearanceId)}`;
}

/** The admin console's clearances list (for notices that cover several clearances). */
export function clearancesAdminListLink(origin: string | null | undefined): string | undefined {
  if (!origin) return undefined;
  return `${origin}/admin/clearances`;
}
