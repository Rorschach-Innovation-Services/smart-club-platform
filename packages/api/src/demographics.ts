/**
 * Anonymised cohort demographics for the Season Insights dashboards — pure
 * aggregation (no AWS imports, unit-testable), same style as ./teams.ts.
 *
 * Input rows are the POPIA-minimised projection repo.listPlayerDemographics
 * returns (clubId/dob/gender/race/team only); output is histogram buckets — no
 * player rows ever leave the API through this module.
 *
 * STATUS RULE: every player row is counted regardless of `status`. Nothing
 * writes an 'inactive' status today, and a clearance-pending player is still a
 * registered person the union reports on — this is deliberate, and pinned by a
 * test so a future status can't silently shrink the histograms.
 */
import type { PlayerRegistration } from './types.js';

/** The minimal projection the histograms need (lenient: legacy rows may miss any). */
export type DemographicPlayer = Partial<
  Pick<PlayerRegistration, 'clubId' | 'dob' | 'gender' | 'race' | 'team'>
>;

export interface DemographicBucket {
  label: string;
  count: number;
}

export interface DemographicsSummary {
  totalPlayers: number;
  ageGroups: DemographicBucket[];
  gender: DemographicBucket[];
  race: DemographicBucket[];
}

// KEEP IN SYNC with src/data.ts GENDERS / RACES — the registration forms offer
// exactly these values, and the buckets must render in the same canonical order
// (same keep-in-sync convention as the dobFromSaId parity twin). Values outside
// the lists (legacy/free-text rows) are kept leniently and appended after.
const GENDERS = ['Male', 'Female', 'Non-binary'];
const RACES = ['African', 'Indian', 'Coloured', 'White', 'Other'];

/** Bucket for rows with a blank/missing gender or race value. Always last. */
const UNSPECIFIED = 'Unspecified';

/**
 * Age bands aligned with the Juniors league group and the 18-minor threshold
 * (computeIsMinor, index.ts). 'Unknown' (missing/invalid/future dob) is appended
 * only when non-empty; the five real bands are always present so charts keep a
 * stable scale.
 */
const AGE_BANDS: Array<{ label: string; min: number; max: number }> = [
  { label: 'Under 13', min: 0, max: 12 },
  { label: '13–17', min: 13, max: 17 },
  { label: '18–34', min: 18, max: 34 },
  { label: '35–49', min: 35, max: 49 },
  { label: '50+', min: 50, max: Infinity },
];
const UNKNOWN_AGE = 'Unknown';

/**
 * Whole-year age from an ISO `YYYY-MM-DD` dob. Null on a missing, unparseable
 * or future date — callers bucket those as Unknown rather than guessing.
 * UTC accessors on both sides: bare `YYYY-MM-DD` strings parse as UTC midnight,
 * so mixing in local-time getters would flip ages across timezone boundaries.
 */
export function ageFromDob(dob: string | undefined, now: Date = new Date()): number | null {
  if (!dob) return null;
  // Enforce the ISO premise: `new Date('05/05/1990')` would parse in LOCAL time and
  // flip ages at band edges across timezones. Non-ISO legacy values bucket as Unknown.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return null;
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  const months = now.getUTCMonth() - born.getUTCMonth();
  if (months < 0 || (months === 0 && now.getUTCDate() < born.getUTCDate())) age--;
  return age < 0 ? null : age;
}

/**
 * Histogram over one categorical field: canonical labels first (always present,
 * even at zero, so both consoles chart a stable category set), then lenient
 * stored extras alphabetically, then Unspecified (blank/missing) when non-empty.
 */
function bucketize(values: Array<string | undefined>, canonical: string[]): DemographicBucket[] {
  const counts = new Map<string, number>();
  let unspecified = 0;
  for (const raw of values) {
    const v = (raw ?? '').trim();
    if (!v) {
      unspecified++;
      continue;
    }
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const buckets = canonical.map((label) => ({ label, count: counts.get(label) ?? 0 }));
  const extras = [...counts.keys()]
    .filter((label) => !canonical.includes(label))
    .sort((a, b) => a.localeCompare(b));
  for (const label of extras) buckets.push({ label, count: counts.get(label)! });
  if (unspecified > 0) buckets.push({ label: UNSPECIFIED, count: unspecified });
  return buckets;
}

/** Aggregate one cohort of player rows into the three histograms. */
export function summarizeDemographics(
  players: DemographicPlayer[],
  now: Date = new Date(),
): DemographicsSummary {
  const bands = AGE_BANDS.map((b) => ({ label: b.label, count: 0 }));
  let unknownAge = 0;
  for (const p of players) {
    const age = ageFromDob(p.dob, now);
    if (age === null) {
      unknownAge++;
      continue;
    }
    bands[AGE_BANDS.findIndex((b) => age >= b.min && age <= b.max)].count++;
  }
  return {
    // Status-agnostic on purpose — see the module docblock.
    totalPlayers: players.length,
    ageGroups: unknownAge > 0 ? [...bands, { label: UNKNOWN_AGE, count: unknownAge }] : bands,
    gender: bucketize(
      players.map((p) => p.gender),
      GENDERS,
    ),
    race: bucketize(
      players.map((p) => p.race),
      RACES,
    ),
  };
}

/**
 * Split a cohort's demographics per league. `player.team` is a required,
 * catalogue-validated league key on both registration paths, so the split is
 * exact for modern rows; legacy/ambiguous rows land in `unattributed`.
 *
 * Attribution ladder — deterministic, never guessing:
 *   1. `team` set and a known catalogue key → that league (the normal case).
 *   2. `team` set but ORPHANED (league since deleted from the catalogue) →
 *      unattributed, even at a single-league club. The player declared their
 *      league; silently reassigning them to the club's current league would be
 *      a guess (this step short-circuits before the club fallback below).
 *   3. No `team` at all: if the owning club entered EXACTLY one league (and
 *      that key is still in the catalogue — same orphan rule as step 2) → that
 *      league. A sound heuristic covering most legacy rows — note, not a hard
 *      guarantee: `team` was validated against the tenant catalogue, not
 *      `club.leagues`, and a legacy player may predate a league switch.
 *      Otherwise (multi-league club, no club, orphaned club league) →
 *      unattributed.
 *
 * `'unattributed'` is NEVER a key inside `perLeague` — it is the separate
 * return field, collision-proof against a real league named "Unattributed".
 *
 * Known quirk to accept: transfers carry the registration-time `team` to the
 * destination club unchanged (index.ts createPlayerWithClearance /
 * resolveClearance paths), so `perLeague` can hold players for a league whose
 * drill-down directory shows zero entered clubs. Intended, not a bug — the
 * demographics card reflects declared player leagues, the directory reflects
 * club entries.
 */
export function demographicsByLeague(
  players: DemographicPlayer[],
  clubs: Array<{ id: string; leagues?: string[] }>,
  leagueKeys: string[],
  now: Date = new Date(),
): { perLeague: Record<string, DemographicsSummary>; unattributed: DemographicsSummary } {
  const known = new Set(leagueKeys);
  const clubById = new Map(clubs.map((c) => [c.id, c]));
  const groups = new Map<string, DemographicPlayer[]>();
  const orphans: DemographicPlayer[] = [];

  for (const p of players) {
    let league: string | null = null;
    if (p.team) {
      // Ladder steps 1 + 2: a declared league wins or orphans — never falls through.
      league = known.has(p.team) ? p.team : null;
    } else {
      // Ladder step 3: single-league club fallback.
      const clubLeagues = clubById.get(p.clubId ?? '')?.leagues ?? [];
      if (clubLeagues.length === 1 && known.has(clubLeagues[0])) league = clubLeagues[0];
    }
    if (league === null) orphans.push(p);
    else {
      const group = groups.get(league);
      if (group) group.push(p);
      else groups.set(league, [p]);
    }
  }

  // Only leagues with attributed players get a key — consumers treat an absent
  // key as the empty state, and the payload stays lean for big catalogues.
  const perLeague: Record<string, DemographicsSummary> = {};
  for (const [key, group] of groups) perLeague[key] = summarizeDemographics(group, now);
  return { perLeague, unattributed: summarizeDemographics(orphans, now) };
}
