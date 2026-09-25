/**
 * Stage materialisation — the join between the three registries.
 *
 *   entrants  →  who is in each group        (entrants.ts)
 *   format    →  who plays whom, in rounds   (formats.ts)
 *   calendar  →  when each round is played   (calendar.ts)
 *
 * One stage-group materialises into one `Series` (ADR 0008): this module produces the
 * fixtures and the fit report for each group, and the caller wraps them in a Series. That
 * keeps the whole existing fixture-persistence, approval, release and broadcast path
 * untouched — a season run is orchestration above Series, not a replacement for it.
 *
 * Nothing here throws. An unresolvable stage or an overflowing block is a normal,
 * displayable state that the console shows before anyone generates anything.
 */

import { addDays, describeCadence, findBlock, planRoundDates, type DatePlan } from './calendar';
import {
  describeEntrants,
  groupSizes,
  resolveEntrants,
  type ResolveContext,
  type ResolvedGroup,
} from './entrants';
import {
  describeFormat,
  isPoolKnockout,
  poolPairings,
  roundCountForFormat,
  roundsForFormat,
} from './formats';
import { fixturesFromDates, type GeneratedFixture } from './fixtures';
import type {
  CompetitionStructure,
  GroupPlan,
  IsoDate,
  SeasonCalendar,
  SeasonRun,
  StageSpec,
} from '../types';

/** One group of a materialised stage: its teams, its dates and its fixtures. */
export interface MaterialisedGroup {
  id: string;
  label: string;
  entrants: string[];
  plan: DatePlan;
  fixtures: GeneratedFixture[];
}

export type StageMaterialisation =
  | {
      status: 'ready';
      stageId: string;
      groups: MaterialisedGroup[];
      /** True only when every group's rounds fit its block. */
      fits: boolean;
      totalFixtures: number;
      summary: string;
      /**
       * Set when a cross-pool or within-pool stage fell back to a seeded bracket.
       * Falling back is the right behaviour — the right personnel beats the right
       * pairing — but silently degrading leaves the console still naming a pool pairing
       * over a draw that isn't one, which is undiagnosable from the operator's side.
       * (Named for the pairing it first served; it covers both.)
       */
      crossPoolFallback?: string;
    }
  | {
      status: 'awaiting-entrants';
      stageId: string;
      reason: string;
      prefill: ResolvedGroup[];
      summary: string;
    };

export interface MaterialiseArgs {
  stage: StageSpec;
  calendar: SeasonCalendar;
  context?: ResolveContext;
  /**
   * Qualifiers per pool for a pool-driven knockout — the pools' finishing orders. Only
   * meaningful when the stage's format is `knockout` with `pairing: 'cross-pool'` or
   * `'within-pool'`. (Named for the pairing it first served; it feeds both.)
   */
  crossPoolQualifiers?: string[][];
  /**
   * A chained start: no round before this date. Set by `materialiseStructure` for a
   * stage with `startAfter: 'previous-stage'` (the day after its feeder's last round).
   * Applied as a floor on the block-anchored cadence, never as a new anchor — see
   * `DatePlanRequest.notBefore`.
   */
  notBefore?: IsoDate;
}

/**
 * Materialise one stage.
 *
 * Every group is dated INDEPENDENTLY against the same block. That is deliberate: the Top
 * Six and Bottom Six of a split league play the same rounds on the same weekends, so both
 * should start on the block's first playing date rather than one being pushed behind the
 * other. A chained stage (`notBefore`) moves every group behind its feeder together.
 */
export function materialiseStage(args: MaterialiseArgs): StageMaterialisation {
  const { stage, calendar, context, crossPoolQualifiers, notBefore } = args;
  const resolution = resolveEntrants(stage.entrants, {
    ...context,
    labels: stage.groupLabels ?? context?.labels,
  });

  if (resolution.status === 'awaiting') {
    return {
      status: 'awaiting-entrants',
      stageId: stage.id,
      reason: resolution.reason,
      prefill: resolution.prefill,
      summary: `${stage.name} · awaiting entrants — ${resolution.reason}`,
    };
  }

  // The stage names a POSITION; resolve it against THIS calendar (the competition's
  // binding) into a concrete block id before planning dates — `planRoundDates` still works
  // by id because it also serves persisted, id-based `SeriesSchedule`s.
  const resolvedBlockId = findBlock(calendar, stage.schedule.blockIndex)?.id ?? '';
  const groups: MaterialisedGroup[] = resolution.groups.map((group) => {
    const rounds = roundsForFormat(stage.format, group.entrants, crossPoolQualifiers);
    const plan = planRoundDates({
      calendar,
      blockId: resolvedBlockId,
      cadence: stage.schedule.cadence,
      rounds: rounds.length,
      roundsPerDay: stage.schedule.roundsPerDay,
      notBefore,
    });
    return {
      id: group.id,
      label: group.label,
      entrants: group.entrants,
      plan,
      fixtures: fixturesFromDates(rounds, plan.dates, stage.schedule.slots, {
        roundsPerDay: stage.schedule.roundsPerDay,
      }),
    };
  });

  const totalFixtures = groups.reduce((n, g) => n + g.fixtures.length, 0);
  // A group too small to play anyone is not "ready", it is empty. Left as ready it
  // reaches the generate path, where its first date is `undefined` and gets written as
  // an empty startDate — which becomes an empty `gsi1sk`, which real DynamoDB rejects
  // (dynalite accepts it, so no test would catch it) mid-way through a sequential loop
  // that has already written the earlier groups.
  //
  // Judged on ENTRANTS, never on fixture count. `manual` is the documented escape hatch
  // and generates no fixtures by design (`roundsForFormat` returns []), so counting
  // fixtures would make every hand-entered stage permanently ungeneratable — but the
  // entrant rule itself applies to every format, because a group with nobody in it is
  // empty whatever the format. Counting fixtures also named the wrong group: a group of
  // one produces none either, and "Group A has no sides" about a group that has one is
  // worse than saying nothing.
  const tooSmall = groups.find((g) => g.entrants.length < 2);
  const fits = groups.every((g) => g.plan.fits) && !tooSmall;
  // Surface the FIRST failing group's summary — it names the block and the shortfall,
  // which is more actionable than a generic "something doesn't fit".
  const failing = groups.find((g) => !g.plan.fits);
  const summary = fits
    ? `${stage.name} · ${groups.length} group${groups.length === 1 ? '' : 's'} · ${totalFixtures} fixtures · ${groups[0]?.plan.summary ?? ''}`
    : failing
      ? `${stage.name} · ${failing.label}: ${failing.plan.summary}`
      : `${stage.name} · ${tooSmall!.label} has ${tooSmall!.entrants.length === 0 ? 'no sides' : 'one side'}, so it generates no fixtures`;

  // A pool-driven stage that fell back to a seeded bracket. Asked of the GENERATOR
  // (`poolPairings` returns null on refusal) rather than inferred by re-running both and
  // diffing: two pools of one qualifier produce the same bracket either way, so the diff
  // reported a fallback that never happened and told the operator to go fix positions
  // that were already right.
  //
  // The wording names the pairing actually configured, and says what shape it needs —
  // a within-group draw also refuses shapes that line up perfectly but would need a bye.
  const withinPool = stage.format.kind === 'knockout' && stage.format.pairing === 'within-pool';
  const fallbackNotice = withinPool
    ? 'Paired as a seeded bracket, not within-group — the qualifying pools don’t line up with this stage’s entrants, or can’t be drawn without a bye (it needs 2, 4, 8… pools, each sending the same 2, 4, 8… sides). Confirm the pool stage’s finishing positions.'
    : 'Paired as a seeded bracket, not cross-pool — the qualifying pools don’t line up with this stage’s entrants, or qualify unevenly. Confirm the pool stage’s finishing positions.';
  const crossPoolFallback =
    isPoolKnockout(stage.format) &&
    groups.length > 0 &&
    poolPairings(stage.format, groups[0].entrants, crossPoolQualifiers) === null
      ? fallbackNotice
      : undefined;

  return {
    status: 'ready',
    stageId: stage.id,
    groups,
    fits,
    totalFixtures,
    summary,
    ...(crossPoolFallback ? { crossPoolFallback } : {}),
  };
}

/** Every stage of a structure materialised in order, with per-stage context. */
export interface MaterialiseStructureArgs {
  structure: CompetitionStructure;
  calendar: SeasonCalendar;
  /** Per-stage resolve context, keyed by `StageSpec.id`. */
  contexts?: Record<string, ResolveContext>;
  /** Per-stage cross-pool qualifiers, keyed by `StageSpec.id`. */
  crossPoolQualifiers?: Record<string, string[][]>;
}

/**
 * Materialise a whole structure. Stages that cannot resolve yet come back
 * `awaiting-entrants` rather than blocking the ones that can — a split league's first
 * round generates on day one while its post-swap final round waits for standings.
 *
 * Walks the stages IN ORDER so a `startAfter: 'previous-stage'` stage can follow its
 * feeder (`chainFeeder`): its rounds keep the block's cadence anchor and skip every date
 * up to the feeder's last round. A feeder still awaiting entrants has no dates yet, so
 * its span is estimated — at the qualifier-exact size when its DerivationNote counts
 * qualifiers, else at its prefill's group sizes — so a chained semi-final doesn't claim
 * the weekends the pools will need. A feeder with nothing to estimate from (no prefill,
 * no count) contributes no floor, and the chained stage dates from the block start.
 */
export function materialiseStructure(args: MaterialiseStructureArgs): StageMaterialisation[] {
  const { calendar } = args;
  const stages = args.structure.stages;
  const lastDates = new Map<string, IsoDate | undefined>();
  const groupCounts = new Map<string, number>();

  return stages.map((stage) => {
    const notBefore = chainedFloor(stage, stages, lastDates);
    const m = materialiseStage({
      stage,
      calendar,
      context: args.contexts?.[stage.id],
      crossPoolQualifiers: args.crossPoolQualifiers?.[stage.id],
      notBefore,
    });
    if (m.status === 'ready') {
      groupCounts.set(stage.id, m.groups.length);
      lastDates.set(stage.id, lastPlannedDate(m.groups.map((g) => g.plan)));
    } else {
      groupCounts.set(stage.id, m.prefill.length);
      const total = derivedEntrantTotal(stage, stages, (id) => groupCounts.get(id));
      const sizes =
        total !== undefined
          ? groupSizes(groupPlanOf(stage), total)
          : m.prefill.map((g) => g.entrants.length);
      lastDates.set(stage.id, lastPlannedDate(planGroups(stage, calendar, sizes, notBefore)));
    }
    return m;
  });
}

/* ─── Sequential chaining (`startAfter: 'previous-stage'`) ───
   Shared by `materialiseStructure` (real entrants) and `previewFitAll` (hypothetical
   sizes), so the season console and the design-time preview can't disagree about where
   a chained stage lands. */

/**
 * The stage a `startAfter: 'previous-stage'` stage follows: the nearest EARLIER stage in
 * the same block. Undefined when the stage isn't chained or nothing earlier shares its
 * block — both mean "date from the block start", today's behaviour.
 */
export function chainFeeder(stage: StageSpec, stages: StageSpec[]): StageSpec | undefined {
  if (stage.schedule.startAfter !== 'previous-stage') return undefined;
  const index = stages.findIndex((s) => s.id === stage.id);
  for (let i = index - 1; i >= 0; i--) {
    if (stages[i].schedule.blockIndex === stage.schedule.blockIndex) return stages[i];
  }
  return undefined;
}

/** The day after the chained feeder's last round, or undefined when unchained. */
function chainedFloor(
  stage: StageSpec,
  stages: StageSpec[],
  lastDates: Map<string, IsoDate | undefined>,
): IsoDate | undefined {
  const feeder = chainFeeder(stage, stages);
  const last = feeder ? lastDates.get(feeder.id) : undefined;
  return last ? addDays(last, 1) : undefined;
}

/** The latest date across a stage's group plans — groups of one stage run in parallel. */
function lastPlannedDate(plans: DatePlan[]): IsoDate | undefined {
  let last: IsoDate | undefined;
  for (const p of plans) {
    const d = p.dates[p.dates.length - 1];
    if (d && (!last || d > last)) last = d;
  }
  return last;
}

/** A stage's group plan, where its entrant kind has one. */
function groupPlanOf(stage: StageSpec): GroupPlan | undefined {
  return stage.entrants.kind === 'all-registered' ? undefined : stage.entrants.groups;
}

/** Date every group of a stage at hypothetical sizes — the preview twin of materialising. */
function planGroups(
  stage: StageSpec,
  calendar: SeasonCalendar,
  sizes: number[],
  notBefore: IsoDate | undefined,
): DatePlan[] {
  const blockId = findBlock(calendar, stage.schedule.blockIndex)?.id ?? '';
  return sizes.map((size) =>
    planRoundDates({
      calendar,
      blockId,
      cadence: stage.schedule.cadence,
      rounds: previewRounds(stage, size),
      roundsPerDay: stage.schedule.roundsPerDay,
      notBefore,
    }),
  );
}

/**
 * How many sides a stage takes in total when its DerivationNote counts qualifiers:
 * `qualifiersPerGroup × the source stage's group count` — 2 pools, top two each ⇒ 4.
 * Undefined when there's no count, the note's `fromStage` doesn't resolve, or the source
 * stage's group count isn't known yet.
 *
 * Resolves `fromStage` strictly (no adjacent-stage fallback, unlike
 * `crossPoolSourceStage`): an exact number built on a guessed source would be precisely
 * the confident-but-wrong preview the count exists to replace.
 */
export function derivedEntrantTotal(
  stage: StageSpec,
  stages: StageSpec[],
  groupCountOf: (stageId: string) => number | undefined,
): number | undefined {
  const note = stage.entrants.kind === 'manual' ? stage.entrants.derivedFrom : undefined;
  const q = note?.qualifiersPerGroup;
  if (!note || !Number.isInteger(q) || (q as number) <= 0) return undefined;
  const source = stages.find((s) => s.id === note.fromStage);
  const groups = source ? groupCountOf(source.id) : undefined;
  return groups ? groups * (q as number) : undefined;
}

/** One stage's design-time fit, from `previewFitAll`. */
export interface StageFitPreview {
  stageId: string;
  /** The group sizes planned — as given, or derived from a qualifier count. */
  sizes: number[];
  /** True when `sizes` came from `qualifiersPerGroup` rather than the caller. */
  derived: boolean;
  /** One plan per group, dated after the chained feeder where there is one. */
  plans: DatePlan[];
  /** Every group fits. A stage with no known size has no plans and reports true. */
  fits: boolean;
  /** The chained floor this stage was planned against, if any. */
  notBefore?: IsoDate;
}

/**
 * Does the whole structure fit, stage by stage, in one sequential walk?
 *
 * `previewFit` answers for one stage in isolation, which is wrong twice over for a
 * chained stage: it starts at the block start (overlapping its feeder), and it can't see
 * the combined length that actually has to fit. This is the one walk both the structure
 * editor's preview rail and the season wizard use.
 *
 * `sizesPerStage` maps a stage id to its group sizes. A stage absent from it gets the
 * qualifier-exact size when its DerivationNote counts qualifiers and the source stage's
 * group count is known (10 teams in 2 pools of 5, top two each ⇒ one group of 4);
 * otherwise it has no size, no plans, and no floor to hand a stage chained after it.
 */
export function previewFitAll(
  structure: CompetitionStructure,
  calendar: SeasonCalendar,
  sizesPerStage: Record<string, number[]>,
): StageFitPreview[] {
  const stages = structure.stages;
  const lastDates = new Map<string, IsoDate | undefined>();
  const sizesOf = new Map<string, number[]>();

  return stages.map((stage) => {
    const given = sizesPerStage[stage.id];
    let sizes: number[] = [];
    let derived = false;
    if (given?.length) {
      sizes = given;
    } else {
      const total = derivedEntrantTotal(stage, stages, (id) => sizesOf.get(id)?.length);
      if (total !== undefined) {
        sizes = groupSizes(groupPlanOf(stage), total);
        derived = true;
      }
    }
    sizesOf.set(stage.id, sizes);

    const notBefore = chainedFloor(stage, stages, lastDates);
    const plans = planGroups(stage, calendar, sizes, notBefore);
    lastDates.set(stage.id, lastPlannedDate(plans));
    return {
      stageId: stage.id,
      sizes,
      derived,
      plans,
      fits: plans.every((p) => p.fits),
      ...(notBefore ? { notBefore } : {}),
    };
  });
}

/**
 * A stage as one plain-English sentence — the primary artefact of the operator console's
 * collapsed stage row. An operator should be able to read a whole structure without
 * expanding anything, so this has to carry the real meaning, not a type name.
 *
 * "2 groups of 6 · plays every team twice, home and away · weekly, Block 1"
 */
export function describeStage(stage: StageSpec, calendar?: SeasonCalendar): string {
  const block = calendar ? findBlock(calendar, stage.schedule.blockIndex) : undefined;
  const where = block
    ? `${describeCadence(stage.schedule.cadence)}, ${block.label}`
    : describeCadence(stage.schedule.cadence);
  const doubleHeader = stage.schedule.roundsPerDay === 2 ? ', double-headers' : '';
  return `${describeEntrants(stage.entrants)} · ${describeFormat(stage.format)} · ${where}${doubleHeader}`;
}

/**
 * Rounds each group of a stage would need, without resolving anything — used by the
 * operator console's preview rail, which must say "11 rounds × every 2 weeks doesn't fit
 * Block 1" while the structure is still being designed and has no teams in it at all.
 */
export function previewRounds(stage: StageSpec, entrantsPerGroup: number): number {
  return roundCountForFormat(stage.format, entrantsPerGroup);
}

/**
 * Does this stage fit its block, for a hypothetical group size? The design-time twin of
 * `materialiseStage`'s fit check.
 */
export function previewFit(
  stage: StageSpec,
  calendar: SeasonCalendar,
  entrantsPerGroup: number,
): DatePlan {
  return planRoundDates({
    calendar,
    blockId: findBlock(calendar, stage.schedule.blockIndex)?.id ?? '',
    cadence: stage.schedule.cadence,
    rounds: previewRounds(stage, entrantsPerGroup),
    roundsPerDay: stage.schedule.roundsPerDay,
  });
}

/* ─── Pool-knockout wiring (cross-pool and within-pool) ───
   These decide who plays whom in every pool-driven knockout, and they are pure
   functions over SeasonRun/StageSpec with no React in them. They live here rather than in
   the panel that calls them because this is where the golden tests can reach them —
   successive review rounds found real defects in exactly this logic, each of which a
   three-line test would have caught. */

/**
 * The stage a stage's entrants actually derive from: `entrants.derivedFrom.fromStage`
 * when the stage names one AND it resolves to a real stage in `stages`, otherwise the
 * stage immediately before it.
 *
 * The fallback is what keeps this backward-compatible: every structure saved before
 * `derivedFrom.fromStage` existed (or one where it names a stage since deleted) still
 * resolves exactly the way `feedsPoolKnockout`/`poolQualifiersFor` always assumed —
 * cross-pool draws from the adjacent earlier stage. A real KZNCU structure needs the
 * named case: its knockout derives from a pool stage TWO stages back, past an
 * intermediate stage adjacency alone would point at wrongly.
 */
export function crossPoolSourceStage(stage: StageSpec, stages: StageSpec[]): StageSpec | undefined {
  const index = stages.findIndex((s) => s.id === stage.id);
  const named =
    stage.entrants.kind === 'manual' ? stage.entrants.derivedFrom?.fromStage : undefined;
  const resolved = named ? stages.find((s) => s.id === named) : undefined;
  if (resolved) return resolved;
  return index > 0 ? stages[index - 1] : undefined;
}

/**
 * True when some later stage draws a pool-driven bracket (cross-pool or within-pool)
 * from this one — i.e. this stage's finishing ORDER matters, so the confirm form asks for
 * positions.
 */
export function feedsPoolKnockout(stage: StageSpec, stages: StageSpec[]): boolean {
  return stages.some(
    (later) => isPoolKnockout(later.format) && crossPoolSourceStage(later, stages)?.id === stage.id,
  );
}

/**
 * The qualifying pools a pool-driven knockout draws from: WHO qualified comes from this
 * stage's own confirmed entrants, WHICH POOL and in what order comes from the stage it
 * derives from (`crossPoolSourceStage` — named via `derivedFrom.fromStage`, or the
 * adjacent earlier stage when that's absent or unresolvable).
 *
 * Both halves are load-bearing. Passing the source stage's whole rosters instead produces
 * a bracket over `pools[i][0]` and `pools[i][1]` — the first two clubs in each pool —
 * which are sides the knockout series does not contain: the clubs that actually qualified
 * would see a series with no fixtures of theirs in it, and the drilldown would read
 * "Unknown team v Unknown team".
 *
 * Pool ORDER is finishing order, supplied by the admin through the confirm form's
 * Position column (`ranked`). The platform has no results model, so a stage that depends
 * on standings is `manual` and a human types the ranking — the same honesty ADR 0008
 * applies to `swap` and `from-standings`.
 *
 * Returns undefined (⇒ a seeded bracket over the entrants, the old behaviour) whenever
 * the inputs don't yet support a real pool-driven draw, rather than guessing.
 *
 * Reads `stage.format` as given — a caller honouring a run-time `pairingOverride` passes
 * the stage with the override already applied.
 */
export function poolQualifiersFor(
  stage: StageSpec,
  stages: StageSpec[],
  run: SeasonRun,
): string[][] | undefined {
  if (!isPoolKnockout(stage.format)) return undefined;
  const sourceStage = crossPoolSourceStage(stage, stages);
  if (!sourceStage) return undefined;

  const pools = run.stages.find((s) => s.specId === sourceStage.id)?.groups ?? [];
  if (pools.length < 2) return undefined;

  // Who went through — this stage's own confirmed entrants, nobody else.
  const qualified = new Set(
    (run.stages.find((s) => s.specId === stage.id)?.groups ?? []).flatMap((g) => g.entrants),
  );
  if (qualified.size < 2) return undefined;

  // Each pool keeps its confirmed ORDER, filtered to the sides that went through.
  const perPool = pools
    .map((p) => p.entrants.filter((t) => qualified.has(t)))
    .filter((p) => p.length > 0);
  // Every qualifier has to be traceable to a pool. If one isn't (the admin added a side
  // that never played the pool stage), the bracket would silently drop it — fall back
  // rather than emit a draw missing a team.
  if (perPool.flat().length !== qualified.size) return undefined;
  return perPool.length >= 2 ? perPool : undefined;
}
