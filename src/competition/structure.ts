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

import { describeCadence, findBlock, planRoundDates, type DatePlan } from './calendar';
import {
  describeEntrants,
  resolveEntrants,
  type ResolveContext,
  type ResolvedGroup,
} from './entrants';
import { crossPoolPairings, describeFormat, roundCountForFormat, roundsForFormat } from './formats';
import { fixturesFromDates, type GeneratedFixture } from './fixtures';
import type { CompetitionStructure, SeasonCalendar, SeasonRun, StageSpec } from '../types';

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
       * Set when a cross-pool stage fell back to a seeded bracket. Falling back is the
       * right behaviour — the right personnel beats the right pairing — but silently
       * degrading leaves the console still saying "cross-pool" over a draw that isn't,
       * which is undiagnosable from the operator's side.
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
   * Qualifiers per pool for a cross-pool knockout — the pools' finishing orders. Only
   * meaningful when the stage's format is `knockout` with `pairing: 'cross-pool'`.
   */
  crossPoolQualifiers?: string[][];
}

/**
 * Materialise one stage.
 *
 * Every group is dated INDEPENDENTLY against the same block. That is deliberate: the Top
 * Six and Bottom Six of a split league play the same rounds on the same weekends, so both
 * should start on the block's first playing date rather than one being pushed behind the
 * other.
 */
export function materialiseStage(args: MaterialiseArgs): StageMaterialisation {
  const { stage, calendar, context, crossPoolQualifiers } = args;
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

  const groups: MaterialisedGroup[] = resolution.groups.map((group) => {
    const rounds = roundsForFormat(stage.format, group.entrants, crossPoolQualifiers);
    const plan = planRoundDates({
      calendar,
      blockId: stage.schedule.blockId,
      cadence: stage.schedule.cadence,
      rounds: rounds.length,
    });
    return {
      id: group.id,
      label: group.label,
      entrants: group.entrants,
      plan,
      fixtures: fixturesFromDates(rounds, plan.dates, stage.schedule.slots),
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

  // A cross-pool stage that fell back to a seeded bracket. Asked of the GENERATOR
  // (`crossPoolPairings` returns null on refusal) rather than inferred by re-running both
  // and diffing: two pools of one qualifier produce the same bracket either way, so the
  // diff reported a fallback that never happened and told the operator to go fix
  // positions that were already right.
  const crossPoolFallback =
    stage.format.kind === 'knockout' &&
    stage.format.pairing === 'cross-pool' &&
    groups.length > 0 &&
    crossPoolPairings(stage.format, groups[0].entrants, crossPoolQualifiers) === null
      ? 'Paired as a seeded bracket, not cross-pool — the qualifying pools don’t line up with this stage’s entrants. Confirm the pool stage’s finishing positions.'
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
 */
export function materialiseStructure(args: MaterialiseStructureArgs): StageMaterialisation[] {
  return args.structure.stages.map((stage) =>
    materialiseStage({
      stage,
      calendar: args.calendar,
      context: args.contexts?.[stage.id],
      crossPoolQualifiers: args.crossPoolQualifiers?.[stage.id],
    }),
  );
}

/**
 * A stage as one plain-English sentence — the primary artefact of the operator console's
 * collapsed stage row. An operator should be able to read a whole structure without
 * expanding anything, so this has to carry the real meaning, not a type name.
 *
 * "2 groups of 6 · plays every team twice, home and away · weekly, Block 1"
 */
export function describeStage(stage: StageSpec, calendar?: SeasonCalendar): string {
  const block = calendar ? findBlock(calendar, stage.schedule.blockId) : undefined;
  const where = block
    ? `${describeCadence(stage.schedule.cadence)}, ${block.label}`
    : describeCadence(stage.schedule.cadence);
  return `${describeEntrants(stage.entrants)} · ${describeFormat(stage.format)} · ${where}`;
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
    blockId: stage.schedule.blockId,
    cadence: stage.schedule.cadence,
    rounds: previewRounds(stage, entrantsPerGroup),
  });
}

/* ─── Design-time calendar resolution ───
   Which calendar a structure should be EDITED against. Structures and calendars are
   authored independently and a structure names only block IDs, so getting this wrong
   makes every block picker fall back to its placeholder and the preview rail report a
   perfectly good structure as broken. */

/**
 * Stages whose stored `blockId` names nothing on `calendar`.
 *
 * An EMPTY blockId is deliberately not reported: that is a stage nobody has scheduled
 * yet, it has its own "needs a playing block" error, and folding the two together would
 * tell an operator their data had gone missing when they simply hadn't entered it.
 */
export function stagesOffCalendar(stages: StageSpec[], calendar: SeasonCalendar): StageSpec[] {
  return stages.filter((s) => !!s.schedule.blockId && !findBlock(calendar, s.schedule.blockId));
}

/**
 * The calendar to open a structure's editor against.
 *
 * Ordered by how much the answer is actually KNOWN rather than guessed:
 *
 *   1. `structure.calendarId` — recorded authorial intent. Inference never overrides it;
 *      when it is explicitly wrong the editor says so rather than silently retargeting.
 *   2. The calendar named by the competitions that BIND this structure. This beats
 *      block-coverage because it is what the server enforces — `validateCompetitions`
 *      rejects a save whose blocks aren't on the bound calendar, so editing against
 *      anything else is editing against a calendar with no authority over the outcome.
 *   3. Block-id coverage — the one calendar that has every block this structure names.
 *   4. Nothing.
 *
 * Step 4 returns `''` (No calendar) rather than `calendars[0]`, and that is the whole
 * point of this function. Tenants seeded before block ids were namespaced carry the same
 * ids AND labels (`block-1`/`First half`, …) on every calendar, so two seasons there are
 * indistinguishable by coverage. Picking one by array order renders a correct-LOOKING
 * picker over the wrong season's dates — invisibly wrong, and worse than saying nothing.
 *
 * `''` is NOT "the operator hasn't chosen": the editor must render it as a question, with
 * each stage's stored block still visible and named. Gating the off-calendar display on a
 * selected calendar turns this answer back into the blank-picker trap it exists to avoid.
 */
export function resolveDesignCalendarId(
  structure: CompetitionStructure,
  calendars: SeasonCalendar[],
  /** Calendars named by competitions bound to this structure. Order is irrelevant. */
  boundCalendarIds: readonly string[] = [],
): string {
  const exists = (id: string | undefined) => !!id && calendars.some((c) => c.id === id);

  if (exists(structure.calendarId)) return structure.calendarId!;

  // Deduped: one structure is routinely bound by several leagues' competitions, and on
  // dev all three name the SAME calendar — counting the bindings rather than the distinct
  // calendars would read that as ambiguous and fall through for no reason.
  const bound = [...new Set(boundCalendarIds.filter(exists))];
  if (bound.length === 1) return bound[0];

  const wanted = [...new Set(structure.stages.map((s) => s.schedule.blockId).filter(Boolean))];
  if (wanted.length) {
    const covering = calendars.filter((c) => wanted.every((b) => !!findBlock(c, b)));
    // Exactly one, or the ambiguity described above. Narrow by the bindings first — if
    // several calendars cover and the bindings name some of them, those win.
    if (covering.length === 1) return covering[0].id;
    const boundCovering = covering.filter((c) => bound.includes(c.id));
    if (boundCovering.length === 1) return boundCovering[0].id;
  }

  return '';
}

/* ─── Cross-pool wiring ───
   These two decide who plays whom in every cross-pool knockout, and they are pure
   functions over SeasonRun/StageSpec with no React in them. They live here rather than in
   the panel that calls them because this is where the golden tests can reach them —
   successive review rounds found real defects in exactly this logic, each of which a
   three-line test would have caught. */

/** True when the stage immediately after this one draws a cross-pool bracket from it. */
export function feedsCrossPool(stage: StageSpec, stages: StageSpec[]): boolean {
  const next = stages[stages.findIndex((s) => s.id === stage.id) + 1];
  return next?.format.kind === 'knockout' && next.format.pairing === 'cross-pool';
}

/**
 * The qualifying pools a cross-pool knockout draws from: WHO qualified comes from this
 * stage's own confirmed entrants, WHICH POOL and in what order comes from the stage
 * before it.
 *
 * Both halves are load-bearing. Passing the prior stage's whole rosters instead produces
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
 * the inputs don't yet support a real cross-pool draw, rather than guessing.
 */
export function crossPoolQualifiersFor(
  stage: StageSpec,
  priorStage: StageSpec | undefined,
  run: SeasonRun,
): string[][] | undefined {
  if (stage.format.kind !== 'knockout' || stage.format.pairing !== 'cross-pool') return undefined;
  if (!priorStage) return undefined;

  const pools = run.stages.find((s) => s.specId === priorStage.id)?.groups ?? [];
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
