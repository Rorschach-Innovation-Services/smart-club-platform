/**
 * Titans medicoach recipes: fan-out classification only. Every league is a plain imported
 * series (import-titans-fixtures.ts), so formats come from the fixtures. Keys are the
 * fixture-sheet leagues (TITANS_LEAGUE_KEYS in titans-fixture-map.ts). See ./types.ts.
 *
 * Deliberately UNCLASSIFIED: `womens-junior-league`. It is a junior league, but its label
 * ("Women's Junior League") reads as women's to the lint, so `junior` would fail it and
 * `womens` would fan adult women onto a junior side. Unclassified never fans out, which is
 * exactly what `junior` would do.
 */
import type { TenantRecipes } from './types.js';

/** Fallback group for the age-group leagues, used only if the catalogue lacks the key. */
const junior = { group: 'Juniors', category: 'junior', competitions: {} } as const;

export const TITANS_RECIPES: TenantRecipes = {
  tenant: 'titans',
  province: 'Gauteng',
  utcOffset: '+02:00',
  leagues: {
    'premier-league': { category: 'senior-open', competitions: {} },
    'promotion-league': { category: 'senior-open', competitions: {} },
    'second-league': { category: 'senior-open', competitions: {} },
    'third-league': { category: 'senior-open', competitions: {} },
    'fourth-league': { category: 'senior-open', competitions: {} },
    'fifth-league': { category: 'senior-open', competitions: {} },
    'sixth-league': { category: 'senior-open', competitions: {} },
    'mens-t20': { category: 'senior-open', competitions: {} },
    'womens-t20': { category: 'womens', competitions: {} },
    'womens-premier-league': { category: 'womens', competitions: {} },
    'veterans-league': { category: 'veterans', competitions: {} },
    u9: { ...junior },
    u11: { ...junior },
    u13: { ...junior },
    u15: { ...junior },
  },
  placement: { fanOut: true },
};
