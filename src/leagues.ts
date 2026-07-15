/**
 * Pure helpers over the dynamic, tenant-scoped league catalogue (TenantConfig.leagues).
 *
 * Replaces the old static catalogue in data.jsx. Every consumer passes the fetched
 * `allLeagues` array in; these helpers reproduce the shapes the affiliation form and
 * series form expect. A league is `{ key, label, group, district, note? }`; `key` is
 * the immutable matching token stored in `club.leagues`.
 */

import { TEAM_ID_PREFIX } from './types';
import type { ClubGround, ClubTeam } from './types';

/** Sentinel district for overarching leagues shown in every district's picker. */
export const OVERARCHING_DISTRICT = 'All districts';

/**
 * A stable id for a named side. Reserved `tm_` prefix keeps the teamId namespace
 * disjoint from bare clubId slugs, so `resolveTeam`'s legacy fallback is always safe.
 */
export function makeTeamId(): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return TEAM_ID_PREFIX + rand;
}

/** 0→'A', 1→'B', … 25→'Z', 26→'AA' — spreadsheet-style column letters. */
export function teamLetter(i: number): string {
  let n = Math.max(0, i | 0);
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Default name for the i-th side, e.g. ("Glenwood", 1) → "Glenwood B". */
export function defaultTeamName(clubName: string, i: number): string {
  return `${(clubName || 'Team').trim()} ${teamLetter(i)}`;
}

/** A team as it enters the fixtures pool (one row per side). */
export interface TeamParticipant {
  teamId: string;
  clubId: string;
  name: string;
  venue?: string;
  lat?: number;
  lon?: number;
}

/**
 * The minimal club shape team expansion needs — a pick of Club, deliberately loose so
 * both the full admin Club and the operator-wire InsightsClub (whose roster entries
 * carry id/name only, and which has no ground) satisfy it.
 */
export interface ClubSidesSource {
  id: string;
  name: string;
  /** Sides per league key; absent map/key counts as 1. */
  leagueTeams?: Record<string, number>;
  /** Named sides per league; venue/coords absent on the operator projection. */
  teamRosters?: Record<
    string,
    Array<Pick<ClubTeam, 'id' | 'name'> & Partial<Pick<ClubTeam, 'venue' | 'lat' | 'lon'>>>
  >;
  ground?: ClubGround;
}

/**
 * Expand a club into its sides for one league. A league with count ≥ 2 yields the
 * named roster (padded with defaults if short); otherwise a single participant whose
 * `teamId === clubId` (the club is its own team — legacy-compatible).
 *
 * This is a PURE projection: it must return the SAME ids for the same club every call
 * so independent callers (e.g. a series form's bulk-select vs its per-chip render)
 * agree on which teamId is which. A padded side therefore gets a DETERMINISTIC id
 * derived from (club, league, index) — never a random `makeTeamId()`, which would
 * desync those callers for a legacy club that has a count but no stored roster yet.
 */
export function clubTeamsForLeague(club: ClubSidesSource, leagueKey: string): TeamParticipant[] {
  const count = Math.max(1, Number(club.leagueTeams?.[leagueKey]) || 1);
  const ground = club.ground || {};
  if (count >= 2) {
    const roster = Array.isArray(club.teamRosters?.[leagueKey])
      ? (club.teamRosters![leagueKey] as ClubTeam[])
      : [];
    const out: TeamParticipant[] = [];
    for (let i = 0; i < count; i++) {
      const t = roster[i];
      out.push({
        teamId: t?.id || `${TEAM_ID_PREFIX}${club.id}_${leagueKey}_${i}`,
        clubId: club.id,
        name: t?.name?.trim() || defaultTeamName(club.name, i),
        venue: t?.venue?.trim() || ground.venue,
        lat: Number.isFinite(t?.lat) ? t!.lat : ground.lat,
        lon: Number.isFinite(t?.lon) ? t!.lon : ground.lon,
      });
    }
    return out;
  }
  return [
    {
      teamId: club.id,
      clubId: club.id,
      name: club.name,
      venue: ground.venue,
      lat: ground.lat,
      lon: ground.lon,
    },
  ];
}

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
 * Matches a women's league by its LABEL. Women's leagues seed with
 * `group: "Overarching Leagues"` (same as premier/promotion), so — unlike juniors, which
 * have their own group — the label is the only available signal. Deliberately excludes
 * "girls": junior girls are a distinct CQI category (`juniorG`) and stay junior via the
 * junior-group check in `teamCounts`, which runs first.
 */
const WOMENS_LABEL_RE = /\b(women(?:['’]?s)?|ladies)\b/i;

/** True when a catalogue league is a women's league (matched on label). */
export function isWomensLeague(league: any): boolean {
  return !!league && WOMENS_LABEL_RE.test(String(league.label || ''));
}

/**
 * Senior/women/junior team counts derived from a club's selected league keys. A club may
 * field more than one side in a league: `leagueTeams` maps a league key to its team
 * count; a key absent from the map (or no map at all — legacy clubs) counts as 1, so
 * the total always equals at least the number of leagues entered.
 *
 * Precedence is junior-group → women-label → senior: a league in the `Juniors` group is
 * junior even if its label reads "Girls", matching the CQI model's junior/women split.
 * Keys whose league was deleted from the catalogue fall through to senior.
 */
export function teamCounts(
  leagueKeys: any[],
  allLeagues: any[],
  leagueTeams?: Record<string, number>,
) {
  const keys = Array.isArray(leagueKeys) ? leagueKeys : [];
  let senior = 0;
  let women = 0;
  let junior = 0;
  for (const k of keys) {
    const n = Math.max(1, Number(leagueTeams?.[k]) || 1);
    const lg = findByKey(allLeagues, k);
    if (lg?.group === JUNIOR_GROUP) junior += n;
    else if (isWomensLeague(lg)) women += n;
    else senior += n;
  }
  return { senior, women, junior };
}
