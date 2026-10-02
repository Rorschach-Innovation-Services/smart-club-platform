/**
 * Read-side projection of medicoach-owned results onto GET /series (ADR 0016).
 *
 * Results live in their own FIXRESULT# items; this joins them onto each fixture as a
 * RESPONSE-ONLY `result` (no captain/player data, ever), plus — for admins on a synced
 * tenant — a RESPONSE-ONLY `syncMapped: true` on fixtures medicoach owns the result of, so
 * the console can lock the manual "completed" status there. Both keys are stripped again
 * from any fixtures a client writes back (`stripResponseOnlyFixtureFields`), so a
 * whole-series PATCH can never persist a copy of the result into the series item.
 */
import { hasFeature } from '../features.js';
import { isExcludedLeagueKey } from '../medicoach-export-build.js';
import { isRecipeKnockoutSeries } from '../medicoach-bundle.js';
import { recipesForTenant } from '../medicoach-recipes/index.js';
import type { FixtureResultView, Series, StoredFixtureResult, TenantConfig } from '../types.js';

/** Fixture keys GET /series adds that are never stored on the series item. */
export const RESPONSE_ONLY_FIXTURE_KEYS = ['result', 'syncMapped'] as const;

/** The public view of a stored result: scores and the medicoach link, nothing personal. */
export function toResultView(r: StoredFixtureResult): FixtureResultView | null {
  if (r.cleared || !r.recordedAt) return null;
  return {
    homeScore: r.homeScore ?? null,
    awayScore: r.awayScore ?? null,
    summary: r.summary ?? null,
    winner: r.winner ?? null,
    method: r.method ?? null,
    noResult: r.noResult === true,
    source: r.resultSource ?? 'manual',
    recordedAt: r.recordedAt,
    medicoachMatchUrl: r.medicoachMatchUrl ?? null,
  };
}

/**
 * Whether medicoach owns this series' results: the tenant has the sync on and the series'
 * league is exported (not excluded by the tenant recipe, e.g. Promotion Women's, and not a
 * demo/seed league). Recipe knockouts are always mapped (their fixtures carry `syncRef`).
 */
export function seriesIsSyncMapped(
  tenant: string,
  series: Pick<Series, 'id'> & { leagueKey?: unknown },
  config: TenantConfig | null | undefined,
): boolean {
  if (!hasFeature(config, 'medicoachSync')) return false;
  if (isRecipeKnockoutSeries(series.id)) return true;
  const leagueKey = typeof series.leagueKey === 'string' ? series.leagueKey : '';
  if (!leagueKey || isExcludedLeagueKey(leagueKey)) return false;
  return !recipesForTenant(tenant).excludeLeagues?.[leagueKey];
}

/**
 * Join stored results onto the series' fixtures (new objects; inputs untouched). A fixture
 * with a live result reads as completed in every UI. `mapped`, when given, marks the
 * fixtures of the series it accepts with `syncMapped: true` (admin console only).
 */
export function joinFixtureResults(
  series: Series[],
  results: StoredFixtureResult[],
  mapped?: (s: Series) => boolean,
): Series[] {
  const byKey = new Map<string, FixtureResultView>();
  for (const r of results) {
    const view = toResultView(r);
    if (view) byKey.set(`${r.seriesId}#${r.fixtureId}`, view);
  }
  if (!byKey.size && !mapped) return series;
  return series.map((s) => {
    const isMapped = mapped?.(s) ?? false;
    let touched = false;
    const fixtures = ((s.fixtures as Array<Record<string, unknown>>) ?? []).map((f) => {
      const result = f && byKey.get(`${s.id}#${String(f.id)}`);
      if (!result && !isMapped) return f;
      touched = true;
      return { ...f, ...(result ? { result } : {}), ...(isMapped ? { syncMapped: true } : {}) };
    });
    return touched ? { ...s, fixtures } : s;
  });
}

/** Drop the response-only keys from fixtures a client sent back (PATCH/POST /series). */
export function stripResponseOnlyFixtureFields(fixtures: unknown): unknown {
  if (!Array.isArray(fixtures)) return fixtures;
  return fixtures.map((f) => {
    if (!f || typeof f !== 'object') return f;
    if (!RESPONSE_ONLY_FIXTURE_KEYS.some((k) => k in (f as object))) return f;
    const copy = { ...(f as Record<string, unknown>) };
    for (const k of RESPONSE_ONLY_FIXTURE_KEYS) delete copy[k];
    return copy;
  });
}
