/** Recipe registry: the checked-in recipes for tenants that have them. */
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
