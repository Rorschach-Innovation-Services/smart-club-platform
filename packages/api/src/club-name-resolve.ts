/**
 * Club-name resolution shared by the fixture importers: a union spreadsheet's team name
 * ("Simplex B", "Silver Saints", "Illembe") → the tenant's club record and the series
 * participant (team) it plays as.
 *
 * Extracted from import-planb-fixtures.ts so the umpire-appointments importer and the
 * medicoach sync can resolve sheet names with the exact rules the fixture import used —
 * the same name must land on the same `teamId` everywhere, or fixtures stop matching.
 *
 * Ground aliasing is deliberately a SEPARATE namespace (venue-clash.ts): "Ilembe" is both
 * a club and a barred GROUND name, and the two must never be looked up in the same map.
 */
import type { Club, Series } from './types.js';
import { normaliseName } from './venue-clash.js';

export type SeriesParticipant = NonNullable<Series['participants']>[number];

/** Sheet names that collapse to different clubs than plain normalisation reaches. */
export const NAME_ALIASES: Record<string, string> = {
  chatsworthsporting: 'hollywoodbets-chatsworth-sporting',
  simplex: 'simplex-reservoir-hills-crimson',
  dut: 'durban-university-of-technology-dut',
  meadowridge: 'meadowridge-sporting-cricket-club',
  rhythmdhs: 'rhythm-dhsob-cricket-club',
  // Prod record "Parkgate Hambanathi CC" normalises to `parkgatehambanathi`; the
  // sheets' bare "Parkgate" (norm `parkgate`) can't reach it, so map it straight.
  parkgate: 'parkgate-hambanathi-cc',
};

/** Sheet TYPOS/variants that collapse to a DIFFERENT normal-form before the
 * byNorm/alias lookup runs. Kept separate from NAME_ALIASES (which maps straight to a
 * prod club id) so this module never hardcodes an unverifiable club id — the redirect
 * just corrects the spelling and lets the normal lookup do the rest. */
export const NAME_REDIRECTS: Record<string, string> = {
  chatsworthhunited: 'chatsworthunited', // "Chatsworthh United" (double h)
  umazi: 'umlazi', // "Umazi A" typo for "Umlazi A"
  ilemebe: 'ilembe', // "ilemebe" typo
  illembe: 'ilembe', // "Illembe" (REVISED file) — same club as "ilembe"/"iLembe"
  // REVISED file spells out sponsor/suburb-qualified Premier names the Dolphins file
  // gives short ("Harlequins", "Crusaders", "Rhythm DHS") — collapse onto the same form
  // so the Premier T20 pair-map matches across both files.
  harlequinsdbn: 'harlequins', // "Harlequins CC DBN 1st XI"
  hollywoodbetscrusaders: 'crusaders', // "Hollywoodbets Crusaders 1st XI"
  rhythmdhsob: 'rhythmdhs', // "RHYTHM DHSOB 1st XI"
  // Prod has exactly one saints-like club (Saints Cricket Club); the T20/veterans
  // sheets call it "Silver Saints". Confirmed against the prod club list on the
  // 16 Aug 2026 dry run — union to give the final nod before --confirm.
  silversaints: 'saints',
  simplexrhcc: 'simplex', // "Simplex RHCC" (REVISED) = Simplex Reservoir Hills CC
  // The sheets' "FAM" is prod's fam-kwamakhutha (ground "Harlequins", Cato Manor 1) —
  // surfaced by the 16 Aug venue-registry sync, after an earlier run had already
  // created a skeletal fam-cricket-club; the bootstrap script erases that duplicate.
  fam: 'famkwamakhutha',
};

/** Lowercase, strip punctuation, drop generic suffix/roster words (venue-clash.ts's
 * shared implementation — identical rules apply to clubs and grounds). */
export const normalise = normaliseName;

/** The plain club normal form (no typo redirects) — same as `normalise`. Kept under this
 * name for the umpire-appointments importer, which layers its own sheet redirects on it. */
export const normaliseClubName = normaliseName;

/** A sheet club name's lookup key: the shared normal form with known typos redirected. */
export function redirectedNormalise(name: string): string {
  const n = normalise(name);
  return NAME_REDIRECTS[n] ?? n;
}

export function buildClubIndex(clubs: Club[]): Map<string, Club> {
  const byNorm = new Map<string, Club>();
  for (const c of clubs) {
    byNorm.set(normalise(c.name), c);
    byNorm.set(normalise(c.id), c);
  }
  return byNorm;
}

export function resolveClub(
  name: string,
  clubs: Club[],
  byNorm: Map<string, Club>,
): Club | undefined {
  const n = redirectedNormalise(name);
  const aliased = NAME_ALIASES[n];
  // The alias names a prod club id; in a tenant without that club (another union, dev, a
  // renamed record such as "Chatsworth Sporting CC") fall back to the plain lookup, which
  // already ignores generic suffixes ("CC", "Cricket Club").
  const viaAlias = aliased ? clubs.find((c) => c.id === aliased) : undefined;
  return viaAlias ?? byNorm.get(n);
}

/** Reserved teamId namespace for synthesised multi-team sides — mirrors
 * `clubTeamsForLeague`'s deterministic pattern (src/leagues.ts:93-94) so a club that
 * later gets a real roster in the admin console converges onto the SAME ids. */
export const TEAM_ID_PREFIX = 'tm_';

/** "Simplex A/B/C", "Rhythm DHS B/C", "Meadowridge A/B", "Umlazi A/B" — a trailing
 * A/B/C on a name miss means a multi-team club side, not a fresh club. */
export function stripLetterSuffix(name: string): { base: string; letter: string } | null {
  const m = name.trim().match(/^(.*\S)\s+([A-C])$/);
  return m ? { base: m[1], letter: m[2] } : null;
}

/** The synthesised team id for lettered side `letter` of `clubId` in `leagueKey`. */
export function letteredTeamId(clubId: string, leagueKey: string, letter: string): string {
  const index = letter.charCodeAt(0) - 'A'.charCodeAt(0);
  return `${TEAM_ID_PREFIX}${clubId}_${leagueKey}_${index}`;
}

/** Tracks, per league, which clubs appeared as a plain (unsuffixed) team and which
 * appeared as a lettered side — printed as a warning for any club in both sets (the
 * suffixed/unsuffixed mixing check runs per LEAGUE, not per section). */
export interface SuffixUsage {
  suffixed: Set<string>;
  unsuffixed: Set<string>;
}

/** One row of the name-resolution sign-off table: what the sheet called a team, and
 * what it resolved to. `teamId` is only shown separately from `clubId` when it's a
 * synthesised multi-team id — the operator reviews every alias/redirect outcome here
 * before `--confirm`. Keyed `leagueKey::rawName`, deduplicated across fixtures. */
export interface ResolutionEntry {
  raw: string;
  leagueKey: string;
  clubName: string;
  clubId: string;
  teamId: string;
}
export type ResolutionLog = Map<string, ResolutionEntry>;

export function recordResolution(
  log: ResolutionLog,
  leagueKey: string,
  raw: string,
  club: Club,
  teamId: string,
) {
  const key = `${leagueKey}::${raw}`;
  if (log.has(key)) return;
  log.set(key, { raw, leagueKey, clubName: club.name, clubId: club.id, teamId });
}

/**
 * A sheet team name → the series participant it plays as in `leagueKey`: a direct club
 * resolve (teamId = clubId), else a lettered multi-team side (`tm_<clubId>_<league>_<i>`).
 * Undefined when neither resolves. `usage`/`resolutions` collect the sign-off reporting.
 */
export function resolveParticipant(
  rawName: string,
  leagueKey: string,
  clubs: Club[],
  byNorm: Map<string, Club>,
  usage: SuffixUsage,
  resolutions: ResolutionLog,
): SeriesParticipant | undefined {
  const direct = resolveClub(rawName, clubs, byNorm);
  if (direct) {
    usage.unsuffixed.add(`${leagueKey}::${direct.id}`);
    recordResolution(resolutions, leagueKey, rawName, direct, direct.id);
    const g = direct.ground ?? {};
    return {
      teamId: direct.id,
      clubId: direct.id,
      name: direct.name,
      ...(g.venue ? { venue: g.venue } : {}),
      ...(Number.isFinite(g.lat) ? { lat: g.lat as number } : {}),
      ...(Number.isFinite(g.lon) ? { lon: g.lon as number } : {}),
    };
  }
  const suffix = stripLetterSuffix(rawName);
  if (!suffix) return undefined;
  const club = resolveClub(suffix.base, clubs, byNorm);
  if (!club) return undefined;
  usage.suffixed.add(`${leagueKey}::${club.id}`);
  const teamId = letteredTeamId(club.id, leagueKey, suffix.letter);
  recordResolution(resolutions, leagueKey, rawName, club, teamId);
  const g = club.ground ?? {};
  return {
    teamId,
    clubId: club.id,
    name: `${club.name} ${suffix.letter}`,
    ...(g.venue ? { venue: g.venue } : {}),
    ...(Number.isFinite(g.lat) ? { lat: g.lat as number } : {}),
    ...(Number.isFinite(g.lon) ? { lon: g.lon as number } : {}),
  };
}

/** A sheet team name → its canonical teamId for a league (resolveParticipant's id logic
 * without the logging side effects). */
export function resolveTeamId(
  name: string,
  leagueKey: string,
  clubs: Club[],
  byNorm: Map<string, Club>,
): string | undefined {
  const direct = resolveClub(name, clubs, byNorm);
  if (direct) return direct.id;
  const suffix = stripLetterSuffix(name);
  if (!suffix) return undefined;
  const club = resolveClub(suffix.base, clubs, byNorm);
  if (!club) return undefined;
  return letteredTeamId(club.id, leagueKey, suffix.letter);
}

export function reportSuffixMixing(usage: SuffixUsage): string[] {
  const notes: string[] = [];
  for (const key of usage.suffixed) {
    if (usage.unsuffixed.has(key)) {
      const [leagueKey, clubId] = key.split('::');
      notes.push(
        `${clubId} appears both as a plain team and a lettered side in league "${leagueKey}"`,
      );
    }
  }
  return notes;
}
