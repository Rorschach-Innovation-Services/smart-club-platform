/**
 * Pure helpers over the dynamic, tenant-scoped league catalogue (TenantConfig.leagues).
 *
 * Replaces the old static catalogue in data.jsx. Every consumer passes the fetched
 * `allLeagues` array in; these helpers reproduce the shapes the affiliation form and
 * series form expect. A league is `{ key, label, group, district, note? }`; `key` is
 * the immutable matching token stored in `club.leagues`.
 */

/** Sentinel district for overarching leagues shown in every district's picker. */
export const OVERARCHING_DISTRICT = 'All districts';

/** Derive a stable, URL-safe key from a league name (new admin-created leagues only). */
export function slugifyLeagueKey(label: string) {
  return String(label || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Leagues offered to a club in `district`: the overarching leagues plus that district's
 * own, deduped by key (overarching wins). Unlike the old static helper there is NO
 * fallback to a default district — an unknown/blank district yields just the overarching
 * set, which is the correct behaviour for a fresh tenant.
 */
export function leagueOptionsForDistrict(allLeagues: any[], district: string): any[] {
  const list = Array.isArray(allLeagues) ? allLeagues : [];
  const overarching = list.filter((l) => l.district === OVERARCHING_DISTRICT);
  const districtSpecific = list.filter(
    (l) => l.district === district && l.district !== OVERARCHING_DISTRICT,
  );
  const seen = new Set<string>();
  const out: any[] = [];
  for (const l of [...overarching, ...districtSpecific]) {
    if (seen.has(l.key)) continue;
    seen.add(l.key);
    out.push(l);
  }
  return out;
}

/** key -> label map (replaces the static LEAGUE_LABEL_BY_KEY). */
export function labelByKey(allLeagues: any[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const l of allLeagues || []) map[l.key] = l.label;
  return map;
}

/** Group leagues by their `group` label, for optgroup-style rendering. */
export function optionsGroupedByGroup(allLeagues: any[]): Record<string, any[]> {
  const groups: Record<string, any[]> = {};
  for (const l of allLeagues || []) (groups[l.group] = groups[l.group] || []).push(l);
  return groups;
}

/** Find a single league by key (returns undefined if it was deleted). */
export function findByKey(allLeagues: any[], key: string) {
  return (allLeagues || []).find((l) => l.key === key);
}

/** The catalogue `group` whose leagues count as junior teams. */
export const JUNIOR_GROUP = 'Juniors';

/**
 * Senior/junior team counts derived from a club's selected league keys — each
 * league entered fields one side. Keys whose league was deleted from the
 * catalogue count as senior so the total always equals leagues entered.
 */
export function teamCounts(leagueKeys: any[], allLeagues: any[]) {
  const keys = Array.isArray(leagueKeys) ? leagueKeys : [];
  let junior = 0;
  for (const k of keys) {
    if (findByKey(allLeagues, k)?.group === JUNIOR_GROUP) junior++;
  }
  return { senior: keys.length - junior, junior };
}
