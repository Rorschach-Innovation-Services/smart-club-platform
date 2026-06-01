/**
 * Server-side copy of the (frozen, v1) cricket catalogue, used to validate
 * affiliation input. These mirror the shared defaults in the frontend's
 * data.jsx; per-tenant catalogue overrides are a phase-2 feature
 * (see docs/architecture/0005), so duplicating the frozen keys here is acceptable.
 */

export const VALID_DISTRICTS = new Set([
  'Ethekwini Metro Cricket Union',
  'Umkhanyakude Cricket District',
  'Ugu Cricket District',
  'KCCD',
  'Illembe Cricket District',
]);

export const VALID_LEAGUE_KEYS = new Set([
  // Cross-district / overarching
  'premier',
  'promotion',
  'premierWomen',
  'veterans',
  // EMCU
  'emcuD1',
  'emcuD2',
  'emcuD3_s1',
  'emcuD3_s2',
  'emcuD4_s1',
  'emcuD4_s2',
  'emcuD5_s1',
  'emcuD5_s2',
  'emcuU11',
  'emcuU13',
  // King Cetshwayo
  'kcSat',
  'kcD1',
  'kcWebber',
  // Southern Natal / Umzinto / Ugu juniors
  'snT20',
  'sn30',
  'snAutumn100',
  'umzT20',
  'umz100',
  'umzLeague30',
  'uguU11',
  'uguU13',
  'uguU15',
  // Ilembe
  'ilembeA30',
  'ilembeBT20',
]);

/** CQI representation answer keys that must sum to ~100%. */
const REP_KEYS = ['pctBA', 'pctIN', 'pctCO', 'pctWH'] as const;

/**
 * Validate an affiliation/CQI patch. Throws a message string on failure
 * (callers map to HTTP 400). Only checks fields present in the patch.
 */
export function validateClubPatch(patch: {
  district?: string;
  leagues?: string[];
  cqiAnswers?: Record<string, unknown>;
}): string | null {
  if (patch.district && !VALID_DISTRICTS.has(patch.district)) {
    return `unknown district: ${patch.district}`;
  }
  if (patch.leagues) {
    const bad = patch.leagues.filter((k) => !VALID_LEAGUE_KEYS.has(k));
    if (bad.length) return `unknown league keys: ${bad.join(', ')}`;
  }
  if (patch.cqiAnswers && REP_KEYS.some((k) => k in patch.cqiAnswers!)) {
    const total = REP_KEYS.reduce((s, k) => s + (Number(patch.cqiAnswers![k]) || 0), 0);
    if (Math.abs(total - 100) > 0.5) {
      return `representation percentages must sum to 100 (got ${total})`;
    }
  }
  return null;
}
