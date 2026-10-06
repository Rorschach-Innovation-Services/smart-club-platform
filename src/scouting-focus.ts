/**
 * A union's own scouting dashboard. When the tenant is a union with a franchise (the Lions),
 * Scouting shows only that union: its franchise's squads, its club players from the scouting
 * reports, its sides in the events, and its schools and clubs. Other tenants see everything.
 *
 * The focus applies to real data only — with the invented samples (a fresh clone, CI) nothing is
 * filtered, so the pages still have something to show. Read at render time: the tenant is set
 * when the app boots, after modules load.
 */
import { getActiveTenant } from './api';
import { POOLS_ARE_SAMPLE, SCOUT_POOLS } from './pro-data';
import type { ScoutPool } from './scout-pool';
import { eventFromPool } from './scouting-build';
import { SCOUTING_EVENTS, SCOUTING_IS_SAMPLE, type ScoutingEvent } from './scouting-data';

export interface Focus {
  tenant: string;
  /** How the dashboard names the union, e.g. "Lions". */
  label: string;
  /** The franchise's word in its squad names ("DP World Lions", "DP World Lions Women"). */
  franchise: string;
  /** The provincial unions whose club players and events count as ours. */
  unions: string[];
}

export const FOCUS_BY_TENANT: Record<string, Focus> = {
  lions: { tenant: 'lions', label: 'Lions', franchise: 'lions', unions: ['Gauteng'] },
};

export const focusFor = (tenant: string | null | undefined): Focus | null =>
  (tenant && FOCUS_BY_TENANT[tenant.toLowerCase()]) || null;

export const useFocus = (): Focus | null => focusFor(getActiveTenant());

export const inUnion = (focus: Focus | null, union: string | undefined) =>
  !focus || (!!union && focus.unions.some((u) => u.toLowerCase() === union.toLowerCase()));

/** A franchise team name is ours ("DP World Lions Women" for the Lions). */
export const isOurFranchise = (focus: Focus | null, team: string) =>
  !focus || team.toLowerCase().split(/\s+/).includes(focus.franchise);

/** Scouting pools, narrowed to the union's players. */
export function focusPools(focus: Focus | null, pools: ScoutPool[] = SCOUT_POOLS): ScoutPool[] {
  if (!focus || POOLS_ARE_SAMPLE) return pools;
  return pools
    .map((p) => ({ ...p, players: p.players.filter((x) => inUnion(focus, x.union)) }))
    .filter((p) => p.players.length > 0);
}

/**
 * The events Player scouting offers: the union's own events, plus its club players from each
 * scouting report as a report-style event (players, no matches).
 */
export function focusEvents(
  focus: Focus | null,
  events: ScoutingEvent[] = SCOUTING_EVENTS,
  pools: ScoutPool[] = SCOUT_POOLS,
): ScoutingEvent[] {
  if (!focus || SCOUTING_IS_SAMPLE) return events;
  // Scorecards keep both sides; the players listed are the union's own.
  const own = events
    .filter((e) => inUnion(focus, e.union))
    .map((e) => {
      if (!e.ourTeams) return e;
      const players = e.players.filter((p) => e.ourTeams!.includes(p.hub));
      return { ...e, players, totals: { ...e.totals, players: players.length } };
    });
  const reports = focusPools(focus, pools).map((pool) =>
    eventFromPool(pool, {
      id: `report-${pool.id}`,
      name: `${focus.label} club players — ${pool.name}`,
      ageGroup: 'Senior',
      source: pool.source,
      union: focus.unions[0],
    }),
  );
  // The club report first: it is the union's widest view of its players.
  return [...reports, ...own];
}
