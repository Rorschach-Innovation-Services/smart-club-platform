/**
 * Medicoach player placement + sync intent (ADR 0018). Pure: no DynamoDB, no env, no clock —
 * the bundle exporter (medicoach-export-build.ts) and the player sync (players.ts) both call
 * it, so the team a player lands on in the one-off bundle and in the ongoing sync can never
 * diverge.
 *
 * Deliberately imports nothing that reaches repo.ts (repo resolves the table at import time).
 *
 * Placement rules (unchanged from the bundle's 2026-10-02 rules):
 *   1. the registered league's single side of the player's club;
 *   2. else, with no registered league, the club's ONLY affiliation (non fixtures-only) league;
 *   3. plus the veterans club's single side in every veterans league;
 *   4. a player still without a team: every side of the club in that league when it has
 *      several, else the club's league-less squad team.
 *
 * Sync intent is decided per PERSON (every row of the natural key across the tenant), never
 * per row — see {@link syncIntent}.
 */
import { clubTeamsForLeague, isVeteransLeague } from '../../../engine/src/leagues.js';
import { refs } from '../medicoach-bundle.js';
import type {
  Club,
  PlayerClearance,
  PlayerRegistration,
  Series,
  SeasonRun,
  TenantConfig,
} from '../types.js';
import type { TenantRecipes } from '../medicoach-recipes/types.js';

/* ─────────────────────────── Placement ─────────────────────────── */

export interface PlacementLeague {
  key: string;
  label?: string;
  fixturesOnly?: boolean;
}

/** What the placement rules read about the tenant (built once, used for every player). */
export interface PlacementContext {
  /** The leagues medicoach has (the bundle's exported leagues). */
  leagues: PlacementLeague[];
  clubsById: Map<string, Pick<Club, 'id' | 'leagues'>>;
  /** Team refs of `clubId`'s sides in `leagueKey`, in bundle order. */
  sidesOf(clubId: string, leagueKey: string): string[];
  /** The ref of the club's league-less squad team. */
  squadRef(clubId: string): string;
}

export type PlacementKind = 'singleSide' | 'veteransOnly' | 'allSidesOfAmbiguous' | 'clubSquad';
export type ClubSquadReason =
  | 'noRegisteredLeague'
  | 'multipleCandidateLeagues'
  | 'leagueNotExported'
  | 'noSideInLeague';

export interface Placement {
  /** Desired team refs, in the bundle's order (main side first, then veterans sides). */
  teamRefs: string[];
  placement: PlacementKind;
  clubSquadReason?: ClubSquadReason;
  /** How many times a league offered several sides (the exporter's `ambiguousSide`). */
  ambiguousSides: number;
  /** A veterans side was added. */
  veteransResolved: boolean;
}

/**
 * The teams one player ROW belongs on. Exactly the exporter's rules (see the module doc): the
 * bundle and the sync share this function so the two paths cannot drift.
 */
export function desiredTeamRefs(
  player: Pick<PlayerRegistration, 'clubId' | 'team' | 'veteransClubId'>,
  ctx: PlacementContext,
): Placement {
  const leagueKeys = new Set(ctx.leagues.map((l) => l.key));
  const affiliationLeagues = ctx.leagues.filter((l) => !l.fixturesOnly);
  const veteransLeagueKeys = ctx.leagues
    .filter((l) => isVeteransLeague({ key: l.key, label: l.label }))
    .map((l) => l.key);
  const teamRefs: string[] = [];
  let ambiguousSides = 0;

  // Main club side: the registered league, else the club's only affiliation league.
  let leagueKey = player.team && leagueKeys.has(player.team) ? player.team : undefined;
  let candidateCount = 0;
  if (!player.team) {
    const club = ctx.clubsById.get(player.clubId);
    const candidates = (club?.leagues ?? []).filter((k) =>
      affiliationLeagues.some((l) => l.key === k),
    );
    candidateCount = candidates.length;
    if (candidates.length === 1) leagueKey = candidates[0];
  }
  const sides = leagueKey ? ctx.sidesOf(player.clubId, leagueKey) : [];
  if (sides.length === 1) teamRefs.push(sides[0]);
  else if (sides.length > 1) ambiguousSides++;

  // Veterans second club.
  let veteransResolved = false;
  if (player.veteransClubId) {
    for (const k of veteransLeagueKeys) {
      const vs = ctx.sidesOf(player.veteransClubId, k);
      if (vs.length === 1 && !teamRefs.includes(vs[0])) {
        teamRefs.push(vs[0]);
        veteransResolved = true;
      } else if (vs.length > 1) ambiguousSides++;
    }
  }

  // Fallback placement, ONLY for a player the rules above left without any team.
  let placement: PlacementKind;
  let clubSquadReason: ClubSquadReason | undefined;
  if (sides.length === 1) placement = 'singleSide';
  else if (teamRefs.length) placement = 'veteransOnly';
  else if (sides.length > 1) {
    teamRefs.push(...sides);
    placement = 'allSidesOfAmbiguous';
  } else {
    teamRefs.push(ctx.squadRef(player.clubId));
    placement = 'clubSquad';
    if (player.team && !leagueKey) clubSquadReason = 'leagueNotExported';
    else if (leagueKey) clubSquadReason = 'noSideInLeague';
    else if (candidateCount > 1) clubSquadReason = 'multipleCandidateLeagues';
    else clubSquadReason = 'noRegisteredLeague';
  }
  return {
    teamRefs,
    placement,
    ...(clubSquadReason ? { clubSquadReason } : {}),
    ambiguousSides,
    veteransResolved,
  };
}

/** League keys the bundle never exports (`seed-*`, `demo`). */
export function isExcludedLeagueKey(key: string): boolean {
  return key === 'demo' || key.startsWith('seed-');
}

/**
 * The sync's {@link PlacementContext}, built the way `buildBundle` builds its teams: every
 * in-scope league (catalogue minus `seed-*`/`demo`/recipe exclusions, plus leagueKeys only
 * series carry), sides from `clubTeamsForLeague` for each non-demo club registered in the
 * league, plus series participants not already covered. Team refs are the bundle's refs.
 */
export function buildPlacementContext(input: {
  tenant: string;
  config: Pick<TenantConfig, 'leagues'> | null;
  clubs: Club[];
  series: Series[];
  seasonRuns: SeasonRun[];
  recipes: Pick<TenantRecipes, 'excludeLeagues' | 'leagues'>;
}): PlacementContext {
  const { tenant, config, recipes } = input;
  const catalogue = config?.leagues ?? [];
  const inScope = (key: string) =>
    !!key && !isExcludedLeagueKey(key) && recipes.excludeLeagues?.[key] === undefined;
  const leagues = new Map<string, PlacementLeague>();
  const addLeague = (key: string) => {
    if (!inScope(key) || leagues.has(key)) return;
    const cat = catalogue.find((l) => l.key === key);
    const label = cat?.label ?? recipes.leagues?.[key]?.label ?? key;
    leagues.set(key, { key, label, ...(cat?.fixturesOnly ? { fixturesOnly: true } : {}) });
  };
  for (const l of catalogue) addLeague(l.key);
  const runsById = new Map(input.seasonRuns.map((r) => [r.id, r]));
  const leagueOfSeries = (s: Series) => {
    const run = s.seasonRunId ? runsById.get(s.seasonRunId) : undefined;
    return run?.leagueKey ?? (typeof s.leagueKey === 'string' ? s.leagueKey : undefined);
  };
  for (const s of input.series) {
    const k = leagueOfSeries(s);
    if (k) addLeague(k);
  }

  const clubsById = new Map<string, Club>();
  for (const c of input.clubs) if (!c.demo) clubsById.set(c.id, c);
  // `${clubId}|${leagueKey}` → team refs, and the team ids already placed per league.
  const sides = new Map<string, string[]>();
  const seen = new Map<string, Set<string>>();
  const add = (leagueKey: string, clubId: string, teamId: string) => {
    const ids = seen.get(leagueKey) ?? new Set<string>();
    seen.set(leagueKey, ids);
    if (ids.has(teamId)) return;
    ids.add(teamId);
    const k = `${clubId}|${leagueKey}`;
    sides.set(k, [...(sides.get(k) ?? []), refs.team(tenant, leagueKey, teamId)]);
  };
  for (const key of leagues.keys()) {
    for (const club of clubsById.values()) {
      if (!Array.isArray(club.leagues) || !club.leagues.includes(key)) continue;
      for (const p of clubTeamsForLeague(club, key)) add(key, club.id, p.teamId);
    }
  }
  for (const s of input.series) {
    if (String(s.id).startsWith('s-mc-ko-')) continue; // recipe knockouts: no new teams
    const key = leagueOfSeries(s);
    if (!key || !leagues.has(key)) continue;
    const participants = Array.isArray(s.participants)
      ? s.participants
      : (s.teams ?? []).map((id) => ({ teamId: id, clubId: id }));
    for (const p of participants) if (p?.teamId && p.clubId) add(key, p.clubId, p.teamId);
  }
  return {
    leagues: [...leagues.values()],
    clubsById,
    sidesOf: (clubId, leagueKey) => sides.get(`${clubId}|${leagueKey}`) ?? [],
    squadRef: (clubId) => refs.squadTeam(tenant, clubId),
  };
}

/* ─────────────────────────── Sync intent (per person) ─────────────────────────── */

/** The player sync is on: `features.medicoachSync` AND `integrations.medicoach.playerSync`. */
export function playerSyncEnabled(
  config: Pick<TenantConfig, 'features' | 'integrations'> | null | undefined,
): boolean {
  return (
    config?.features?.medicoachSync === true && config?.integrations?.medicoach?.playerSync === true
  );
}

export type SyncIntent =
  | {
      op: 'upsert';
      /** The row whose details (and club) medicoach gets: active first, then the newest. */
      primary: PlayerRegistration;
      /** Union of desired teams over every eligible row (main + veterans), primary's first. */
      teamRefs: string[];
      /** The primary row's veterans club, when it has one. */
      veteransClubId?: string;
      eligibleRows: number;
    }
  | { op: 'remove'; reason: 'no-rows' | 'no-eligible-row' };

type ClearanceLike = Pick<PlayerClearance, 'fromClubId' | 'toClubId' | 'status'>;

/**
 * Whether one row puts the person on teams. Placeholders never do. A `clearance-pending` row
 * counts ONLY as the SOURCE of a pending clearance (the player is still at that club until the
 * move is approved); the destination row of a pending clearance waits for the approval.
 * `inactive` and legacy `clearance-rejected` rows never count.
 */
export function rowIsEligible(row: PlayerRegistration, pending: ClearanceLike[]): boolean {
  if (row.placeholder === true) return false;
  const status = row.status ?? 'active';
  if (status === 'active') return true;
  if (status === 'clearance-pending')
    return pending.some((c) => c.status === 'pending' && c.fromClubId === row.clubId);
  return false;
}

/**
 * The person's desired state, from EVERY row of their natural key across the tenant
 * (`rows`) and the clearances naming them (`clearances`, any status):
 *
 * | rows                                                    | intent                         |
 * |---------------------------------------------------------|--------------------------------|
 * | ≥1 active (or status-absent) non-placeholder row        | upsert, union of desired teams |
 * | only a pending clearance's destination + its source     | upsert with the SOURCE's teams |
 * | a rejected clearance (source reactivated)               | upsert with source teams       |
 * | all inactive / clearance-rejected / placeholder / none  | remove                         |
 *
 * Erasure is never an intent: only `erasePlayerData` writes an `erase` tombstone.
 */
export function syncIntent(
  rows: PlayerRegistration[],
  clearances: ClearanceLike[],
  ctx: PlacementContext,
): SyncIntent {
  if (!rows.length) return { op: 'remove', reason: 'no-rows' };
  const pending = clearances.filter((c) => c.status === 'pending');
  const eligible = rows.filter((r) => rowIsEligible(r, pending));
  if (!eligible.length) return { op: 'remove', reason: 'no-eligible-row' };
  const rank = (r: PlayerRegistration) => ((r.status ?? 'active') === 'active' ? 1 : 0);
  const primary = [...eligible].sort(
    (a, b) =>
      rank(b) - rank(a) ||
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) ||
      a.clubId.localeCompare(b.clubId),
  )[0];
  const ordered = [primary, ...eligible.filter((r) => r !== primary)];
  const teamRefs: string[] = [];
  for (const r of ordered)
    for (const t of desiredTeamRefs(r, ctx).teamRefs) if (!teamRefs.includes(t)) teamRefs.push(t);
  return {
    op: 'upsert',
    primary,
    teamRefs,
    ...(primary.veteransClubId ? { veteransClubId: primary.veteransClubId } : {}),
    eligibleRows: eligible.length,
  };
}

/* ─────────────────────────── Same-person guard ─────────────────────────── */

/**
 * The name + dob key the possible-duplicate guard and the registration-time warning match on:
 * lower-cased, accents stripped, punctuation dropped, whitespace collapsed. Empty when either
 * part is missing (no match is ever made on a blank).
 */
export function nameDobKey(
  p: Partial<Pick<PlayerRegistration, 'firstName' | 'lastName' | 'dob'>>,
): string {
  const norm = (s: unknown) =>
    String(s ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const name = norm(`${p.firstName ?? ''} ${p.lastName ?? ''}`);
  const dob = String(p.dob ?? '').trim();
  return name && dob ? `${name}|${dob}` : '';
}

/** The PLAYERDISTINCT# pair key: the two natural keys in sorted order. */
export function distinctPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
