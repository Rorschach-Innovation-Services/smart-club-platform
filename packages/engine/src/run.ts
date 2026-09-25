/**
 * Pure season-run helpers: how a running season's stages read once the run's own
 * decisions (pairing overrides, confirmed groups) are laid over its structure snapshot.
 * Shared by the admin console's Seasons panel; no React, no I/O.
 */
import type { ResolveContext } from './entrants';
import { materialiseStructure, poolQualifiersFor, type StageMaterialisation } from './structure';
import type { SeasonRun, StageRun, StageSpec } from './types';

/**
 * The confirmed groups of the stage a standings-dependent stage draws from.
 *
 * `undefined` when the rule names no source, the source hasn't been confirmed yet, or the
 * stage isn't standings-dependent at all — in which case the prefill falls back to the
 * registered list, which is the best that can honestly be offered.
 */
export function derivedFromGroups(stage: StageSpec, run: SeasonRun): string[][] | undefined {
  const from = stage.entrants.kind === 'manual' ? stage.entrants.derivedFrom?.fromStage : undefined;
  if (!from) return undefined;
  const groups = run.stages.find((s) => s.specId === from)?.groups ?? [];
  return groups.length ? groups.map((g) => g.entrants) : undefined;
}

/**
 * The stage as THIS season plays it: the structure's spec with the run's
 * `pairingOverride` laid over a knockout's pairing. The union decides within- or
 * cross-group semis at qualifier confirmation, so the snapshot's pairing is only the
 * default — every place that materialises, derives qualifiers or asks for positions has
 * to read the overlaid spec, or the console would show one bracket and generate another.
 */
export function effectiveStage(stage: StageSpec, stageRun: StageRun | undefined): StageSpec {
  const override = stageRun?.pairingOverride;
  if (!override || stage.format.kind !== 'knockout' || stage.format.pairing === override)
    return stage;
  return { ...stage, format: { ...stage.format, pairing: override } };
}

/**
 * Materialise a whole run the way the console shows it: effective stages (overrides
 * applied), each stage's confirmed groups and pool qualifiers, and the sequential walk
 * that dates a `startAfter` stage behind its feeder. Pure over its inputs so the rebase
 * flow can re-run it against a freshly fetched run between regenerations, rather than
 * against whatever this render's props happened to hold.
 */
export function materialiseRun(
  run: SeasonRun,
  participants: Array<{ teamId: string }>,
): { stages: StageSpec[]; materialisations: StageMaterialisation[] } {
  const stages = run.structureSnapshot.stages.map((s) =>
    effectiveStage(
      s,
      run.stages.find((x) => x.specId === s.id),
    ),
  );
  const contexts: Record<string, ResolveContext> = {};
  const crossPoolQualifiers: Record<string, string[][]> = {};
  for (const stage of stages) {
    const stageRun = run.stages.find((s) => s.specId === stage.id);
    contexts[stage.id] = {
      registered: participants.map((p) => p.teamId),
      seedOrder: participants.map((p) => p.teamId),
      confirmed: stageRun?.groups.length ? stageRun.groups.map((g) => g.entrants) : undefined,
      /*
       * The groups of the stage this one's rule DRAWS FROM — the whole point of
       * recording `fromStage`. A swap moves one side between two groups, so the
       * suggestion has to start from where those groups actually ended up. Without
       * it the prefill blocks the registered list into the right SIZES and calls
       * that a proposal, which for a swap proposes relegating the entire top group.
       */
      priorGroups: derivedFromGroups(stage, run),
    };
    const qualifiers = poolQualifiersFor(stage, stages, run);
    if (qualifiers) crossPoolQualifiers[stage.id] = qualifiers;
  }
  const materialisations = materialiseStructure({
    structure: { ...run.structureSnapshot, stages },
    calendar: run.calendarSnapshot,
    contexts,
    crossPoolQualifiers,
  });
  return { stages, materialisations };
}
