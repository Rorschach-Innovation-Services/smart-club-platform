/**
 * Tuskers (KZNICU) medicoach recipes: fan-out classification only. The 2026/27 fixtures are
 * plain imported series (import-tuskers-fixtures.ts), so formats come from the fixtures.
 * `premier-league` carries both the Prem T20 and Prem 50-over series. See ./types.ts.
 *
 * Player sync stays OFF for tuskers (weak identity data); this recipe ships so the categories
 * are decided before it is switched on.
 */
import type { TenantRecipes } from './types.js';

export const TUSKERS_RECIPES: TenantRecipes = {
  tenant: 'tuskers',
  province: 'KwaZulu-Natal',
  utcOffset: '+02:00',
  leagues: {
    'premier-league': { category: 'senior-open', competitions: {} },
    'veterans-league': { category: 'veterans', competitions: {} },
  },
  placement: { fanOut: true },
};
