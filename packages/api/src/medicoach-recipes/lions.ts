/**
 * Lions (CGL) medicoach recipes: fan-out classification only. Every league is a plain
 * imported series (import-lions-fixtures.ts), so formats come from the fixtures. Keys are
 * the 15 in LIONS_LEAGUES (lions-fixture-map.ts). See ./types.ts.
 */
import type { TenantRecipes } from './types.js';

export const LIONS_RECIPES: TenantRecipes = {
  tenant: 'lions',
  province: 'Gauteng',
  utcOffset: '+02:00',
  leagues: {
    'premier-a': { category: 'senior-open', competitions: {} },
    'premier-b': { category: 'senior-open', competitions: {} },
    'presidents-a': { category: 'senior-open', competitions: {} },
    'presidents-b': { category: 'senior-open', competitions: {} },
    'sunday-1': { category: 'senior-open', competitions: {} },
    'sunday-2': { category: 'senior-open', competitions: {} },
    'sunday-3': { category: 'senior-open', competitions: {} },
    'sunday-4': { category: 'senior-open', competitions: {} },
    'sunday-5': { category: 'senior-open', competitions: {} },
    'saturday-1': { category: 'senior-open', competitions: {} },
    'saturday-2': { category: 'senior-open', competitions: {} },
    'saturday-3': { category: 'senior-open', competitions: {} },
    'hwb-premier-t20': { category: 'senior-open', competitions: {} },
    'vets-sa-1': { category: 'veterans', competitions: {} },
    'ladies-premier-t20': { category: 'womens', competitions: {} },
  },
  placement: { fanOut: true },
};
