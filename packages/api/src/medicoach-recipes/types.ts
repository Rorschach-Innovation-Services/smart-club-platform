/**
 * Per-tenant medicoach recipes: the competition formats a tenant's leagues run, where
 * smart club has no structure to read them from.
 *
 * Why this exists: the Dolphins flagship leagues were loaded as Plan-B series (plain
 * fixture lists from the union's spreadsheets), not generated from a `League.setup`
 * structure. One leagueKey carries several format streams (`premier` = "T20 · Group 1/2"
 * + "50 Over · Top 6/Bottom 6"), and the later phases (semis, finals, the mid-season
 * swap round) were never generated as fixtures. So the format has to be declared, and a
 * recipe is that declaration, keyed by leagueKey + stream.
 *
 * Format precedence in the exporter: a league's real `setup` wins, then a recipe, then
 * inference from the fixtures (flat `league`, rounds from pair meeting counts).
 *
 * Groups are named by 1-based position ("Group 1", "Group 2", …) in the order the
 * exporter sorts a stream's series (Top before Bottom, then natural order). Those names
 * are join keys in medicoach: swaps, relegations and group-position slots match on them.
 */
import type { BundleFormat, CricketMatchFormat } from '../medicoach-bundle.js';

/** One side of a recipe-generated later-phase fixture. `group` is 1-based. */
export type RecipeSlot =
  | { kind: 'group-position'; group: number; position: number }
  | { kind: 'winner' | 'loser'; of: string };

/**
 * A fixture smart club never generated (a semi-final, a final). Exported with slot
 * sources and a placeholder date (the season end), so medicoach renders the bracket and
 * an admin sets the real date there.
 */
export interface RecipeLaterFixture {
  /** Stable id within the competition, used in the fixture ref: `sf1`, `final`. */
  slotId: string;
  stage: string;
  round: number;
  home: RecipeSlot;
  away: RecipeSlot;
}

export interface CompetitionRecipe {
  name: string;
  format: BundleFormat;
  cricketMatchFormat?: CricketMatchFormat;
  /** Expected group sizes, in group order. A mismatch against the series is a warning. */
  expectedGroupSizes?: number[];
  laterFixtures?: RecipeLaterFixture[];
  /** Phase-boundary swaps (groups 1-based). */
  swaps?: Array<{
    groupA: number;
    positionA: number;
    groupB: number;
    positionB: number;
    carryPoints: boolean;
  }>;
  /** Position relegations into another league (groups 1-based). */
  positionRelegations?: Array<{ group: number; position: number; targetLeagueKey: string }>;
  /** An open question for the union, printed in the export summary. */
  confirm?: string;
}

export interface LeagueRecipe {
  /** Label/group/district for a league that exists only as series leagueKeys. */
  label?: string;
  group?: string;
  district?: string;
  /** Keyed by stream key (`t20`, `50-over`, `30-over`). */
  competitions: Record<string, CompetitionRecipe>;
  confirm?: string;
}

export interface TenantRecipes {
  tenant: string;
  host?: { name: string; slugHint: string };
  /** Applied to every institution. */
  province?: string;
  /** Offset for the tenant's wall-clock fixture times, e.g. `+02:00` (SAST, no DST). */
  utcOffset: string;
  leagues: Record<string, LeagueRecipe>;
  /**
   * League keys kept out of the bundle entirely (no league, teams, competitions or
   * fixtures), keyed by leagueKey with the reason. Unlike the seed and demo exclusions these
   * are not listed in `meta.excludedLeagues`; the exporter prints one warning per key it
   * meets: `league <key> excluded by recipe: <reason>`.
   */
  excludeLeagues?: Record<string, string>;
}
