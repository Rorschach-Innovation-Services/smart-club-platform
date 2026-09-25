/**
 * The write side of "Generate fixtures" for one stage of a season run (ADR 0014).
 *
 * `POST /season-runs/:id/stages/:specId/generate` calls this to decide WHAT to write; the
 * route owns HOW (the series gates and the run's optimistic concurrency). Pure over its
 * inputs, and built only from the functions the console already runs — `materialiseRun`
 * for the stage (pairing overrides, confirmed groups, pool qualifiers, chaining floors) and
 * `buildStageSeries` for each group — so the server generates exactly what the Seasons
 * panel previews.
 */
import { findBlock } from './calendar';
import type { TeamParticipant } from './leagues';
import { materialiseRun } from './run';
import { buildStageSeries } from './series-builder';
import type { Competition, League, SeasonRun, Series, StageRun, StageSpec } from './types';

export interface StageGenerationArgs {
  run: SeasonRun;
  specId: string;
  /**
   * The sides the stage draws from: `leagueParticipants` for the run's league with the
   * competition's `excludeTeamIds` applied — the same list the console materialises over.
   */
  participants: ReadonlyArray<{ teamId: string }>;
  /**
   * Every side registered for the league (no exclusions) — the pool the series'
   * `participants` snapshot is filtered from, as the console's generate always did.
   */
  leagueTeams: readonly TeamParticipant[];
  league?: Pick<League, 'label'>;
  competition?: Pick<Competition, 'label' | 'matchFormat'>;
  /** Overs when the competition's match format names none — see `buildStageSeries`. */
  defaultOvers?: number;
}

/** One group as generated: what the run's StageRun records against it. */
export interface GeneratedGroup {
  groupId: string;
  groupLabel: string;
  entrants: string[];
  seriesId: string;
}

export type StageGeneration =
  | { status: 'unknown-stage' }
  | { status: 'awaiting-entrants'; reason: string }
  /** The stage's `blockIndex` names no block on the run's calendar snapshot. */
  | { status: 'no-block'; message: string }
  /** Some group's rounds overrun its block (or a group is empty) — nothing dateable. */
  | { status: 'does-not-fit'; summary: string }
  | {
      status: 'ready';
      /** The stage spec from the run's snapshot. */
      stage: StageSpec;
      /** One series per group, in group order, built by `buildStageSeries`. */
      series: Series[];
      groups: GeneratedGroup[];
      /**
       * Things the admin should know about a generate that still succeeded — today only a
       * pool pairing that could not be drawn and fell back to a seeded bracket.
       */
      warnings?: string[];
    };

/**
 * Materialise ONE stage of `run` and build the series each of its groups persists as.
 * Never throws for a normal "can't generate yet" state — that is a status the caller maps
 * to a response.
 */
export function generateStage({
  run,
  specId,
  participants,
  leagueTeams,
  league,
  competition,
  defaultOvers,
}: StageGenerationArgs): StageGeneration {
  const index = run.structureSnapshot.stages.findIndex((s) => s.id === specId);
  if (index < 0) return { status: 'unknown-stage' };
  // The snapshot spec, not the effective one: `buildStageSeries` reads only id, name and
  // schedule, which a pairing override never changes — and it is what the console passes.
  const stage = run.structureSnapshot.stages[index];
  const materialised = materialiseRun(run, [...participants]);
  const m = materialised.materialisations[index];
  if (m.status !== 'ready') return { status: 'awaiting-entrants', reason: m.reason };
  if (!m.fits) return { status: 'does-not-fit', summary: m.summary };
  // The stage names a POSITION into the run's bound calendar, not a block id.
  const block = findBlock(run.calendarSnapshot, stage.schedule.blockIndex);
  if (!block)
    return {
      status: 'no-block',
      message: `${stage.name} points at a playing block that no longer exists on this calendar`,
    };
  const multi = m.groups.length > 1;
  const series = m.groups.map((g) =>
    buildStageSeries({
      run,
      stage,
      blockId: block.id,
      group: {
        groupId: g.id,
        groupLabel: g.label,
        entrants: g.entrants,
        fixtures: g.fixtures,
        // A `manual` stage plans no rounds by design, so it has no first date — fall back
        // to the block it plays in rather than a blank `startDate` (a gsi1 sort key).
        startDate: g.plan.dates[0] ?? block.start,
        league,
        competition,
      },
      multi,
      leagueTeams,
      defaultOvers,
    }),
  );
  // Named for the pairing THIS season plays (the run's override laid over the spec).
  const played = materialised.stages[index].format;
  const warnings = m.crossPoolFallback
    ? [
        `Paired as a seeded bracket, not ${played.kind === 'knockout' && played.pairing === 'within-pool' ? 'within-group' : 'cross-group'}; fix the confirmed positions and regenerate`,
      ]
    : undefined;
  return {
    status: 'ready',
    stage,
    series,
    ...(warnings ? { warnings } : {}),
    groups: m.groups.map((g, i) => ({
      groupId: g.id,
      groupLabel: g.label,
      entrants: g.entrants,
      seriesId: series[i].id,
    })),
  };
}

/**
 * The run's `stages` after `specId` was generated: every snapshot stage keeps (or gains)
 * its StageRun; the generated one is `generated`, records each group's `seriesId`, and
 * drops `staleSchedule` — regenerating IS the catch-up a rebase's marker asks for.
 *
 * A `seeded-split` or `all-registered` stage is ready on sight, so it can be generated with
 * no confirmed groups stored; its groups are then seeded from what was generated, so the
 * back-pointers (and with them the released-schedule prompt and staleness) exist.
 */
export function stagesAfterGenerate(
  run: SeasonRun,
  specId: string,
  generated: readonly GeneratedGroup[],
): StageRun[] {
  return run.structureSnapshot.stages.map((sp) => {
    const cur: StageRun = run.stages.find((x) => x.specId === sp.id) ?? {
      specId: sp.id,
      status: 'awaiting-entrants',
      groups: [],
    };
    if (sp.id !== specId) return cur;
    const base: StageRun['groups'] = cur.groups.length
      ? cur.groups
      : generated.map((g) => ({ id: g.groupId, label: g.groupLabel, entrants: g.entrants }));
    const { staleSchedule: _stale, ...rest } = cur;
    return {
      ...rest,
      status: 'generated',
      groups: base.map((g) => ({
        ...g,
        seriesId: generated.find((c) => c.groupId === g.id)?.seriesId ?? g.seriesId,
      })),
    };
  });
}
