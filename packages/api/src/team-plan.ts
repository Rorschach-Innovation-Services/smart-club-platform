/**
 * Team-plan counter rollup — extracted from the Titans compliance CLI's `buildClub` so
 * a future structure-intake commit derives the SAME `teams`/`women`/`juniors` counts a
 * club carries, never a hand-recomputed copy that could disagree with `leagueTeams`.
 *
 * ACCEPTED v1 NAMING CONVENTIONS (documented here, not enforced elsewhere): a league key
 * counts toward `women` iff it starts with "womens-" (e.g. "womens-premier-league"), and
 * toward `juniors` iff it matches /^u\d+$/ (e.g. "u9", "u13") — the conventions the
 * Titans league keys already follow. A tenant whose league keys don't follow either
 * pattern (e.g. a women's league not prefixed "womens-") simply isn't counted in that
 * bucket; a known v1 limitation, not silently "fixed" by guessing at other spellings.
 */
export interface TeamPlanCounts {
  /** Total sides across every league in the plan — at least 1 even for an empty plan
   * (the sane single-team default for a club with no team data yet). */
  teams: number;
  women: number;
  juniors: number;
}

export function deriveTeamPlanCounts(leagueTeams: Record<string, number>): TeamPlanCounts {
  const sumWhere = (predicate: (key: string) => boolean) =>
    Object.entries(leagueTeams)
      .filter(([k]) => predicate(k))
      .reduce((total, [, n]) => total + n, 0);
  const teams = Object.values(leagueTeams).reduce((total, n) => total + n, 0) || 1;
  return {
    teams,
    women: sumWhere((k) => k.startsWith('womens-')),
    juniors: sumWhere((k) => /^u\d+$/.test(k)),
  };
}
