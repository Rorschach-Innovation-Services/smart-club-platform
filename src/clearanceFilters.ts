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
