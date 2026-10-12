/* ─── Shared clearance-list filter (admin cross-cohort clearances view) ─── */

import type { PlayerClearance } from './types';

/**
 * Free-text filter over a clearance list, applied across EVERY status so the search
 * combines with (rather than replaces) the All/Pending/Resolved/Rejected pills. An empty
 * query returns the list untouched. Matches the trimmed, lowercased needle against the
 * player, the two clubs, the team's display label, the acting/requesting admins, and the id.
 */
export function filterClearances<T extends PlayerClearance>(
  list: T[],
  q: string,
  teamLabel: Record<string, string>,
): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return list;
  return list.filter((r) => {
    const team = r.team ? (teamLabel[r.team] ?? r.team) : '';
    const hay = [
      r.playerName,
      r.idNumber,
      r.fromClubName,
      r.toClubName,
      team,
      r.rejectedBy,
      r.overriddenBy,
      r.requestedBy,
      r.id,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(needle);
  });
}

/**
 * The clearance id a notification deep link points at (`?clearance=<id>`), or null when the
 * URL carries none. Clearance emails link the admin to `/admin/clearances?clearance=<id>` and
 * each chair to `/club/<clubId>/clearances?clearance=<id>`; both pages read it on mount.
 */
export function readClearanceLinkId(search: string): string | null {
  const id = new URLSearchParams(search).get('clearance')?.trim();
  return id || null;
}

/**
 * Whether a deep-linked clearance id is missing from the loaded list — the "resolved long ago
 * or erased" case the pages surface as a one-line notice instead of a silent no-op. False when
 * there is no link id, so callers can gate the notice on this alone.
 */
export function clearanceLinkMissing(
  linkId: string | null,
  list: ReadonlyArray<{ id: string }>,
): boolean {
  return !!linkId && !list.some((r) => r.id === linkId);
}
