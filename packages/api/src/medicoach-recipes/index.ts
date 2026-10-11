/** Recipe registry: the checked-in recipes for tenants that have them. */
import { isVeteransLeague, isWomensLeague, JUNIOR_GROUP } from '../../../engine/src/leagues.js';
import { DOLPHINS_RECIPES } from './dolphins.js';
import type { TenantRecipes } from './types.js';

export type * from './types.js';

const REGISTRY: Record<string, TenantRecipes> = {
  dolphins: DOLPHINS_RECIPES,
};

/** A tenant's recipes, or an empty set (every league then maps from setup or fixtures). */
export function recipesForTenant(tenant: string): TenantRecipes {
  return REGISTRY[tenant] ?? { tenant, utcOffset: '+02:00', leagues: {} };
}

/**
 * The classifier LINT for fan-out categories: a recipe category that disagrees with the label
 * matchers (`isWomensLeague` / `isVeteransLeague`) or with the catalogue's junior group is
 * flagged. The matchers never DECIDE a category (an unclassified league never fans out); this
 * only catches a typo like a women's league classified `senior-open`. Labels come from the
 * catalogue, else the recipe. Returns one line per disagreement; empty ⇒ clean.
 */
export function lintLeagueCategories(
  recipes: Pick<TenantRecipes, 'leagues'>,
  catalogue: Array<{ key: string; label?: string; group?: string }>,
): string[] {
  const issues: string[] = [];
  for (const [key, l] of Object.entries(recipes.leagues ?? {})) {
    if (!l.category) continue;
    const cat = catalogue.find((c) => c.key === key);
    const label = cat?.label ?? l.label ?? key;
    const group = cat?.group ?? l.group;
    const womens = isWomensLeague({ label });
    const veterans = isVeteransLeague({ key, label });
    const junior = group === JUNIOR_GROUP;
    const expect = (cond: boolean, why: string) => {
      if (!cond) issues.push(`${key} (${label}): category ${l.category} ${why}`);
    };
    expect(
      womens === (l.category === 'womens'),
      womens ? 'but the label is women’s' : 'but the label is not women’s',
    );
    expect(
      veterans === (l.category === 'veterans'),
      veterans ? 'but the league is veterans' : 'but the league is not veterans',
    );
    expect(
      junior === (l.category === 'junior'),
      junior ? 'but the group is Juniors' : 'but the group is not Juniors',
    );
  }
  return issues;
}
