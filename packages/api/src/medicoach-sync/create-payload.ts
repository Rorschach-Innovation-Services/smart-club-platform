/**
 * The wire `create` object of an `op: "create"` schedule push (contract §2, "Create/delete
 * ops", 2026-10-18): what medicoach needs to create a fixture smart club added to a series it
 * already carries.
 *
 * Derived the way the bundle export (medicoach-export-build.ts) derives the same fixture, but
 * for ONE series: the competition ref + stage + group come from the series' place in its
 * league (a season run's stage/group, or a Plan-B stream's sibling groups), the sides from the
 * bundle's own side resolver. `phase` is never sent (medicoach derives it). Anything the
 * export would skip or could not place unambiguously is a `refusal` — the caller then falls
 * back to the awaiting-carry path (MCAWAIT#), never a guess:
 *   - an undated fixture (the contract: never sent as a create until a date exists);
 *   - a `pos:`/`tbd:` side, or a side that is not one of the series' teams;
 *   - a recipe-knockout series, a series with no league, an excluded league;
 *   - a season-run series its run does not link, or a run with no structure;
 *   - a Plan-B series whose group label another series of the same stream shares.
 *
 * No DynamoDB of its own: reads go through `deps` (a point read of the run, and at most one
 * tenant series list + one season-run list per context, both GSI queries).
 */
import { isRecipeKnockoutSeries, refs, type BundleSlot } from '../medicoach-bundle.js';
import {
  compareGroupLabels,
  compareRunsNewestFirst,
  groupName,
  parseSeriesName,
  resolveFixtureSide,
  seasonRunStream,
  slugify,
} from '../medicoach-export-build.js';
import { isExcludedLeagueKey } from './player-placement.js';
import { recipesForTenant } from '../medicoach-recipes/index.js';
import { resolveVertical } from '../vertical.js';
import type {
  FixtureCreateSnapshot,
  SeasonRun,
  Series,
  SyncSlotSnapshot,
  TenantConfig,
} from '../types.js';

export interface CreatePayloadDeps {
  getSeasonRun(tenant: string, runId: string): Promise<SeasonRun | null>;
  listSeasonRuns(tenant: string): Promise<SeasonRun[]>;
  listSeries(tenant: string): Promise<Series[]>;
}

/** The fixture fields a create reads. */
export interface CreateFixture {
  id?: string;
  date?: string;
  home?: string;
  away?: string;
  round?: unknown;
  venueLat?: unknown;
  venueLon?: unknown;
  [key: string]: unknown;
}

/** Where one series sits in medicoach: shared by every create of the series. */
export interface SeriesCreateContext {
  tenant: string;
  seriesId: string;
  leagueKey: string;
  competitionRef: string;
  sport: string;
  stage: string;
  groupName?: string;
  /** The series' concrete side ids (participants, else the legacy club-id teams). */
  teamIds: Set<string>;
}

export type Refusal = { refusal: string };

/** The series' context, or why a create can't be derived for any of its fixtures. */
export async function seriesCreateContext(
  tenant: string,
  series: Series,
  config: TenantConfig | null | undefined,
  deps: CreatePayloadDeps,
): Promise<SeriesCreateContext | Refusal> {
  if (isRecipeKnockoutSeries(series.id))
    return { refusal: 'a recipe knockout series is carried by its recipe' };
  const participants = Array.isArray(series.participants)
    ? series.participants.map((p) => p.teamId)
    : [];
  const teamIds = new Set(
    (participants.length ? participants : (series.teams ?? [])).filter(Boolean),
  );
  const base = {
    tenant,
    seriesId: String(series.id),
    sport: resolveVertical(config).sport,
    teamIds,
  };
  const leagueOk = (key: string | undefined): key is string =>
    !!key &&
    !isExcludedLeagueKey(key) &&
    recipesForTenant(tenant).excludeLeagues?.[key] === undefined;

  const runId = typeof series.seasonRunId === 'string' ? series.seasonRunId : '';
  if (runId) {
    const run = await deps.getSeasonRun(tenant, runId);
    if (!run) return { refusal: `season run ${runId} not found` };
    if (!leagueOk(run.leagueKey)) return { refusal: `league ${run.leagueKey} is not carried` };
    const league = (config?.leagues ?? []).find((l) => l.key === run.leagueKey);
    const structure =
      run.structureSnapshot ??
      (league?.setup
        ? (config?.structures ?? []).find((st) => st.id === league.setup!.structureId)
        : undefined);
    if (!structure) return { refusal: `season run ${run.id} has no structure` };
    let place: { si: number; gi: number; specId: string } | null = null;
    run.stages.forEach((stageRun, si) =>
      stageRun.groups.forEach((g, gi) => {
        if (g.seriesId === series.id && !place) place = { si, gi, specId: stageRun.specId };
      }),
    );
    if (!place) return { refusal: `series is not linked from season run ${run.id}` };
    const { si, gi, specId } = place;
    // The run's stream: the export numbers only runs of the league that have series.
    const [runs, allSeries] = await Promise.all([
      deps.listSeasonRuns(tenant),
      deps.listSeries(tenant),
    ]);
    const withSeries = new Set(
      allSeries
        .filter((s) => !isRecipeKnockoutSeries(s.id) && typeof s.seasonRunId === 'string')
        .map((s) => s.seasonRunId as string),
    );
    withSeries.add(run.id);
    const ordered = runs
      .filter((r) => r.leagueKey === run.leagueKey && withSeries.has(r.id))
      .sort(compareRunsNewestFirst);
    const ri = ordered.findIndex((r) => r.id === run.id);
    if (ri < 0) return { refusal: `season run ${run.id} is not listed` };
    const spec = structure.stages.find((st) => st.id === specId);
    return {
      ...base,
      leagueKey: run.leagueKey,
      competitionRef: refs.competition(tenant, run.leagueKey, seasonRunStream(run, ri)),
      stage: spec?.name ?? specId,
      ...(si === 0 ? { groupName: groupName(gi + 1) } : {}),
    };
  }

  const leagueKey = typeof series.leagueKey === 'string' ? series.leagueKey : undefined;
  if (!leagueOk(leagueKey)) return { refusal: `league ${leagueKey ?? '(none)'} is not carried` };
  const { streamLabel, groupLabel } = parseSeriesName(series.name);
  const streamOf = (label: string | null) => (label ? slugify(label) || 'series' : 'series');
  const stream = streamOf(streamLabel);
  // The stream's groups as the export numbers them: every run-less series of the league and
  // stream (this one as written now), sorted by group label.
  const siblings = (await deps.listSeries(tenant)).filter(
    (s) =>
      s.id !== series.id &&
      !isRecipeKnockoutSeries(s.id) &&
      !s.seasonRunId &&
      s.leagueKey === leagueKey &&
      streamOf(parseSeriesName(s.name).streamLabel) === stream,
  );
  const labelOf = (s: Series) => parseSeriesName(s.name).groupLabel ?? '';
  const mine = groupLabel ?? '';
  if (siblings.some((s) => compareGroupLabels(labelOf(s), mine) === 0))
    return { refusal: `another series of stream ${stream} has the same group label` };
  const index = [...siblings, series]
    .sort((a, b) => compareGroupLabels(labelOf(a), labelOf(b)))
    .findIndex((s) => s.id === series.id);
  return {
    ...base,
    leagueKey,
    competitionRef: refs.competition(tenant, leagueKey, stream),
    stage: 'Group stage',
    groupName: groupName(index + 1),
  };
}

/**
 * A bundle slot as a create can carry it: winner/loser only (contract §2 `Slot`). The bundle's
 * `group-position` slot (recipe knockouts) has no create form — null, so the create is refused
 * (→ awaiting carry), never cast through.
 */
export function createSlotOf(slot: BundleSlot): SyncSlotSnapshot | null {
  return slot.kind === 'winner' || slot.kind === 'loser'
    ? { kind: slot.kind, ofFixtureRef: slot.ofFixtureRef }
    : null;
}

/** One fixture's `create`, from its series' context. */
export function fixtureCreateFrom(
  ctx: SeriesCreateContext,
  f: CreateFixture,
): FixtureCreateSnapshot | Refusal {
  if (f.id == null || String(f.id).trim() === '') return { refusal: 'fixture has no id' };
  // Contract: undated fixtures are never sent as creates; the create goes once a date exists.
  if (!f.date || !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return { refusal: 'undated' };
  const sideCtx = {
    tenant: ctx.tenant,
    seriesId: ctx.seriesId,
    resolveTeam: (id: string) =>
      ctx.teamIds.has(id) ? { ref: refs.team(ctx.tenant, ctx.leagueKey, id) } : null,
  };
  const sideOf = (id: string | undefined) => {
    const side = resolveFixtureSide(id, sideCtx);
    if (side?.ref) return { ref: side.ref };
    const slot = side?.slot ? createSlotOf(side.slot) : null;
    return slot ? { slot } : null;
  };
  const home = sideOf(f.home);
  const away = sideOf(f.away);
  if (!home || !away) return { refusal: 'a side is not a team of the series or a fixture slot' };
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const round = Number.isInteger(f.round) && (f.round as number) >= 1 ? (f.round as number) : 1;
  return {
    competitionRef: ctx.competitionRef,
    sport: ctx.sport,
    ...(home.ref ? { homeTeamRef: home.ref } : { homeSlot: home.slot }),
    ...(away.ref ? { awayTeamRef: away.ref } : { awaySlot: away.slot }),
    stage: ctx.stage,
    ...(ctx.groupName ? { groupName: ctx.groupName } : {}),
    round,
    ...(num(f.venueLat) !== undefined ? { venueLat: num(f.venueLat) } : {}),
    ...(num(f.venueLon) !== undefined ? { venueLon: num(f.venueLon) } : {}),
  };
}

/** The wire `create` for one fixture of `series`, or why there is none (→ awaiting carry). */
export async function buildFixtureCreate(
  tenant: string,
  series: Series,
  fixture: CreateFixture,
  config: TenantConfig | null | undefined,
  deps: CreatePayloadDeps,
): Promise<FixtureCreateSnapshot | Refusal> {
  const ctx = await seriesCreateContext(tenant, series, config, deps);
  return 'refusal' in ctx ? ctx : fixtureCreateFrom(ctx, fixture);
}

export const isRefusal = (v: object): v is Refusal => 'refusal' in v;
