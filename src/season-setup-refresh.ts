/**
 * What "refresh the season setup" refetches. Shared by every Start a season entry point.
 *
 * A season's inputs are split across three reads, and a stale copy of any one of them
 * makes the console say something untrue about a league:
 *
 * - `qk.tenant()` — the public GET /tenant: the league catalogue (each league's operator-set
 *   `setup`) and the season calendars. Missing this one was the stale-setup bug: an
 *   operator's fresh setup still read as "not set up" until a full page reload.
 * - `qk.tenantConfig()` — the authenticated config: the structures a setup points at.
 * - `qk.seasonRuns()` — the seasons already started, for the duplicate-label check and
 *   each league's running season.
 */
import { qk } from './query';

/** The query keys a season-setup refresh invalidates. */
export function seasonSetupQueryKeys(): unknown[][] {
  return [qk.seasonRuns(), qk.tenantConfig(), qk.tenant()];
}

/** Invalidate (and so refetch, where observed) every season-setup query. */
export function refreshSeasonSetup(
  invalidate: (queryKey: unknown[]) => Promise<unknown> | void,
): Promise<unknown[]> {
  return Promise.all(seasonSetupQueryKeys().map((key) => invalidate(key)));
}
