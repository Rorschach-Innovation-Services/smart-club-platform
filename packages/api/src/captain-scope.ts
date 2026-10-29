/**
 * The competition scope of a club team's captain rows (TEAMCAPTAIN# / TEAMLASTCAPT#).
 *
 * A club's men's, women's and veterans sides can share ONE teamId across competitions (only
 * some sides get `tm_<club>_<league>_<n>` ids), so a row keyed per (club, team) alone bleeds:
 * the veterans captain would receive the women's squad link. Both row types are therefore
 * keyed per (club, team, scope).
 *
 * The scope is the series' tenant league key — `league:<leagueKey>` — taken from
 * `series.leagueKey`, else its season run's `leagueKey`. League keys are the stable
 * `config.leagues[].key` values (season runs are per league, one per season), so a
 * designation survives into next season and Premier / Veterans Premier / Premier Women's are
 * distinct. A series with neither falls back to `series:<seriesId>` (deterministic, but
 * per-series: such a designation does not carry over to another series).
 */
import type { Series } from '../../engine/src/types.js';

type ScopeRepo = Pick<typeof import('./repo.js'), 'getSeasonRun'>;

const LEAGUE = 'league:';
const SERIES = 'series:';

/** The scope of a series (one season-run read when the series carries no leagueKey). */
export async function captainScopeOfSeries(
  repo: ScopeRepo,
  tenant: string,
  series: Pick<Series, 'id' | 'seasonRunId'> & { leagueKey?: unknown },
): Promise<string> {
  let key = typeof series.leagueKey === 'string' && series.leagueKey ? series.leagueKey : '';
  if (!key && series.seasonRunId) {
    const run = await repo.getSeasonRun(tenant, series.seasonRunId);
    key = run?.leagueKey ?? '';
  }
  return key ? `${LEAGUE}${key}` : `${SERIES}${String(series.id)}`;
}

/** The league key inside a `league:` scope (undefined for a series-fallback scope). */
export function leagueKeyOfScope(scope: string): string | undefined {
  return scope.startsWith(LEAGUE) ? scope.slice(LEAGUE.length) : undefined;
}

/** True for a well-formed scope string (what the admin PUT accepts before membership checks). */
export function isCaptainScope(scope: unknown): scope is string {
  return (
    typeof scope === 'string' &&
    !scope.includes('#') &&
    ((scope.startsWith(LEAGUE) && scope.length > LEAGUE.length) ||
      (scope.startsWith(SERIES) && scope.length > SERIES.length))
  );
}
