/**
 * Medicoach player placement + sync intent (ADR 0019). Pure: no DynamoDB, no env, no clock —
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
 * Fan-out (only when the tenant recipe sets `placement.fanOut`), returned SEPARATELY as
 * `fanOutTeamRefs` (disjoint from `teamRefs`) because medicoach treats it as ADD-ONLY:
 *   - a man aged ≥ seniorMinAge (15) at `evalDate` → every side of the player's club in every
 *     `senior-open`-classified league;
 *   - a woman aged ≥ womensMinAge (15) → every side in the club's `womens` leagues;
 *   - a man aged ≥ veteransMinAge (40) → every side in the club's `veterans` leagues;
 *   - missing/unrecognised gender or dob → rules 1–4 only, flagged `placementDataGap`.
 * Only leagues the recipe classifies EXPLICITLY fan out; `junior`, unclassified,
 * fixtures-only and excluded leagues never do. `evalDate` comes in on the context so this
 * module stays clockless (the exporter and the sync each pass their own run date).
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
import {
  PLACEMENT_DEFAULTS,
  type LeagueCategory,
  type TenantRecipes,
} from '../medicoach-recipes/types.js';

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
  /** Fan-out settings; absent (or `fanOut: false`) ⇒ the legacy rules only, byte-identical. */
  fanOut?: FanOutContext;
}

/** What the fan-out rules read: resolved thresholds, the explicit categories, the run date. */
export interface FanOutContext {
  /** `YYYY-MM-DD`, the civil date ages are computed at (one per run, both builders). */
  evalDate: string;
  /** leagueKey → category, from the tenant recipe. Unlisted ⇒ never fans out. */
  categories: Map<string, LeagueCategory>;
  seniorMinAge: number;
  womensMinAge: number;
  veteransMinAge: number;
}

/**
 * The fan-out context for a run, or undefined when the tenant has fan-out off (the legacy rules
 * then run untouched). Categories are read only for leagues the recipe names.
 */
export function fanOutContext(
  recipes: Pick<TenantRecipes, 'leagues' | 'placement'>,
  evalDate: string,
): FanOutContext | undefined {
  const p = recipes.placement;
  if (!p?.fanOut) return undefined;
  const categories = new Map<string, LeagueCategory>();
  for (const [key, l] of Object.entries(recipes.leagues ?? {}))
    if (l.category) categories.set(key, l.category);
  return {
    evalDate,
    categories,
    seniorMinAge: p.seniorMinAge ?? PLACEMENT_DEFAULTS.seniorMinAge,
    womensMinAge: p.womensMinAge ?? PLACEMENT_DEFAULTS.womensMinAge,
    veteransMinAge: p.veteransMinAge ?? PLACEMENT_DEFAULTS.veteransMinAge,
  };
}

/**
 * The tenant's civil date (`YYYY-MM-DD`) at `instant`, for a fixed `±HH:MM` offset (recipes'
 * `utcOffset`; SAST has no DST). Callers pass the instant: this module never reads the clock.
 */
export function civilDateAt(instant: Date, utcOffset: string): string {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(utcOffset);
  const mins = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(instant.getTime() + mins * 60_000).toISOString().slice(0, 10);
}

/** Whole years from `dob` to `on` (both `YYYY-MM-DD`), or null when dob is not a date. */
export function ageOn(dob: unknown, on: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dob ?? '').trim());
  const o = /^(\d{4})-(\d{2})-(\d{2})/.exec(on);
  if (!d || !o) return null;
  let age = Number(o[1]) - Number(d[1]);
  if (`${o[2]}-${o[3]}` < `${d[2]}-${d[3]}`) age--;
  return age >= 0 ? age : null;
}

/** `male` / `female` from the free-text registration field, else null (a data gap). */
export function genderOf(g: unknown): 'male' | 'female' | null {
  const v = String(g ?? '')
    .trim()
    .toLowerCase();
  if (v === 'male' || v === 'm') return 'male';
  if (v === 'female' || v === 'f') return 'female';
  return null;
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
  /**
   * Fan-out sides (disjoint from `teamRefs`, ADD-ONLY in medicoach). Always `[]` when the
   * tenant has fan-out off.
   */
  fanOutTeamRefs: string[];
  /** Fan-out is on but the row lacks a usable gender or dob: legacy placement only. */
  placementDataGap?: true;
}

/**
 * The teams one player ROW belongs on. Exactly the exporter's rules (see the module doc): the
 * bundle and the sync share this function so the two paths cannot drift.
 */
export function desiredTeamRefs(
  player: Pick<PlayerRegistration, 'clubId' | 'team' | 'veteransClubId'> &
    Partial<Pick<PlayerRegistration, 'gender' | 'dob'>>,
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
  const fan = fanOutRefs(player, ctx, teamRefs);
  return {
    teamRefs,
    placement,
    ...(clubSquadReason ? { clubSquadReason } : {}),
    ambiguousSides,
    veteransResolved,
    fanOutTeamRefs: fan.refs,
    ...(fan.dataGap ? { placementDataGap: true as const } : {}),
  };
}

/**
 * The fan-out sides of one row (see the module doc), excluding anything already in `teamRefs`.
 * A club's sides in a league are what `sidesOf` knows: its registered leagues AND the series it
 * plays in (a season carry can mint series only, under existing league keys).
 */
function fanOutRefs(
  player: Pick<PlayerRegistration, 'clubId'> & Partial<Pick<PlayerRegistration, 'gender' | 'dob'>>,
  ctx: PlacementContext,
  teamRefs: string[],
): { refs: string[]; dataGap: boolean } {
  const f = ctx.fanOut;
  if (!f) return { refs: [], dataGap: false };
  const gender = genderOf(player.gender);
  const age = ageOn(player.dob, f.evalDate);
  if (!gender || age === null) return { refs: [], dataGap: true };
  const wanted = (c: LeagueCategory): boolean =>
    gender === 'male'
      ? (c === 'senior-open' && age >= f.seniorMinAge) ||
        (c === 'veterans' && age >= f.veteransMinAge)
      : c === 'womens' && age >= f.womensMinAge;
  const out: string[] = [];
  for (const l of ctx.leagues) {
    if (l.fixturesOnly) continue;
    const c = f.categories.get(l.key);
    if (!c || !wanted(c)) continue;
    for (const t of ctx.sidesOf(player.clubId, l.key))
      if (!teamRefs.includes(t) && !out.includes(t)) out.push(t);
  }
  return { refs: out, dataGap: false };
}

/**
 * Leagues in the placement context the recipe leaves unclassified while fan-out is on: they
 * never fan out. Reported (count + keys) by the exporter summary and the enqueue dry run so a
 * new league that SHOULD fan out is noticed, not silently skipped.
 */
export function unclassifiedLeagueKeys(ctx: PlacementContext): string[] {
  if (!ctx.fanOut) return [];
  return ctx.leagues.filter((l) => !ctx.fanOut!.categories.has(l.key)).map((l) => l.key);
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
  recipes: Pick<TenantRecipes, 'excludeLeagues' | 'leagues' | 'placement'>;
  /** The run's civil date (`YYYY-MM-DD`) for fan-out ages; required only when fan-out is on. */
  evalDate?: string;
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
  const fanOut = input.evalDate ? fanOutContext(recipes, input.evalDate) : undefined;
  if (recipes.placement?.fanOut && !fanOut)
    throw new Error('fan-out placement needs an evalDate (the run date)');
  return {
    leagues: [...leagues.values()],
    clubsById,
    sidesOf: (clubId, leagueKey) => sides.get(`${clubId}|${leagueKey}`) ?? [],
    squadRef: (clubId) => refs.squadTeam(tenant, clubId),
    ...(fanOut ? { fanOut } : {}),
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
      /**
       * Union of fan-out sides over every eligible row, minus `teamRefs`. Present ONLY when the
       * tenant has fan-out on (absent ⇒ the wire entry is byte-identical to pre-fan-out).
       */
      fanOutTeamRefs?: string[];
      /** Eligible rows that missed fan-out for a missing gender/dob (fan-out on only). */
      placementDataGaps?: number;
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
  const fanOut: string[] = [];
  let gaps = 0;
  for (const r of ordered) {
    const placed = desiredTeamRefs(r, ctx);
    for (const t of placed.teamRefs) if (!teamRefs.includes(t)) teamRefs.push(t);
    for (const t of placed.fanOutTeamRefs) if (!fanOut.includes(t)) fanOut.push(t);
    if (placed.placementDataGap) gaps++;
  }
  return {
    op: 'upsert',
    primary,
    teamRefs,
    ...(ctx.fanOut
      ? {
          fanOutTeamRefs: fanOut.filter((t) => !teamRefs.includes(t)),
          ...(gaps ? { placementDataGaps: gaps } : {}),
        }
      : {}),
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
