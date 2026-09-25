/**
 * Starter structure templates.
 *
 * Four shapes cover all thirteen structures in the KZNCU and EMCU documents; the groups
 * shape ships twice, once per semi-final pairing, and a one-off tournament covers the cup
 * or festival outside the league season (it replaced the retired create-series form, ADR
 * 0014), so there are six blueprints. An
 * operator clones one and tunes the parameters, or builds from scratch — a template is a
 * starting point, never a constraint (ADR 0008). `templateId` survives on the clone as
 * provenance only; nothing reads it back to constrain editing.
 *
 * Templates carry NO block ids, because blocks belong to a calendar the template has
 * never seen. `instantiateTemplate` maps them on: the opening stage takes the first
 * block, anything after it takes the second where one exists — which is exactly the
 * "group phase before the break, deciders after it" shape both unions use.
 */

import type { CompetitionStructure, SeasonCalendar, StageSpec } from './types';
import { T20_SLOTS } from './calendar';

export interface StructureTemplate {
  id: string;
  name: string;
  /** One line in the picker: when an operator should reach for this. */
  whenToUse: string;
  /** Real leagues this shape came from, so the choice is recognisable. */
  examples: string;
  stages: StageSpec[];
}

/** Stable id for a cloned structure or a new stage. */
export function newStructureId(prefix = 'st'): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}`;
}

export const STRUCTURE_TEMPLATES: StructureTemplate[] = [
  {
    id: 'flat-round-robin',
    name: 'Flat round robin',
    whenToUse: 'Every registered side in one group, playing each other once.',
    examples: 'EMCU Division 1 & 2, Promotion Women',
    stages: [
      {
        id: 'season',
        name: 'League season',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'all-registered' },
        schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
        outcome: { champion: [1] },
      },
    ],
  },
  {
    id: 'split-league-swap',
    name: 'Split league with mid-season swap',
    whenToUse:
      'Two groups play their own double round, then the bottom of the top group swaps with the top of the bottom group before a final round.',
    examples: 'KZNCU Premier Men 50 Over, Premier Women 30 Over',
    stages: [
      {
        id: 'double-round',
        name: 'Double round',
        format: { kind: 'round-robin', legs: 2 },
        entrants: { kind: 'manual', groups: { kind: 'even', count: 2 } },
        schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
        groupLabels: ['Top group', 'Bottom group'],
      },
      {
        id: 'final-round',
        name: 'Final round',
        format: { kind: 'round-robin', legs: 1 },
        entrants: {
          kind: 'manual',
          groups: { kind: 'even', count: 2 },
          derivedFrom: {
            rule: 'swap',
            fromStage: 'double-round',
            detail:
              'Last in the top group swaps with first in the bottom group, carrying the outgoing position’s points',
            carryPoints: true,
          },
        },
        schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
        groupLabels: ['Top group', 'Bottom group'],
        outcome: { champion: [1], relegated: [-1] },
      },
    ],
  },
  {
    id: 'pools-to-knockout',
    name: 'Seeded groups → cross-group semis → final',
    whenToUse:
      'Seeded groups play a round robin, then the top finishers cross over into a knockout.',
    examples: 'Every T20 Pink Ball competition — Premier Men, Premier Women, Promotion Men',
    stages: [
      {
        id: 'pools',
        name: 'Group stage',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'seeded-split', groups: { kind: 'even', count: 2 }, method: 'snake' },
        // Every T20 Pink Ball competition plays a morning and an afternoon match per day.
        schedule: { blockIndex: 0, cadence: { kind: 'weekly' }, slots: T20_SLOTS },
      },
      {
        id: 'finals',
        name: 'Semi-finals & final',
        format: { kind: 'knockout', pairing: 'cross-pool' },
        entrants: {
          kind: 'manual',
          derivedFrom: {
            rule: 'from-standings',
            fromStage: 'pools',
            detail: 'Top two from each group, paired across groups',
            qualifiersPerGroup: 2,
          },
        },
        schedule: { blockIndex: 0, cadence: { kind: 'weekly' }, slots: T20_SLOTS },
        outcome: { champion: [1] },
      },
    ],
  },
  {
    // The same shape with the other semi-final pairing. Unions go either way season to
    // season (EMCU Division 1 30 Over), so both are one click from the picker rather than
    // one being a hand-edit of the other.
    id: 'pools-to-knockout-within',
    name: 'Seeded groups → within-group semis → final',
    whenToUse:
      'Seeded groups play a round robin, then each group’s top two play their own semi-final and the winners meet in the final.',
    examples: 'EMCU Division 1 30 Over — ten teams in two groups of five',
    stages: [
      {
        id: 'pools',
        name: 'Group stage',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'seeded-split', groups: { kind: 'even', count: 2 }, method: 'snake' },
        schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
      },
      {
        id: 'finals',
        name: 'Semi-finals & final',
        format: { kind: 'knockout', pairing: 'within-pool' },
        entrants: {
          kind: 'manual',
          derivedFrom: {
            rule: 'from-standings',
            fromStage: 'pools',
            detail:
              'Top two from each group; each group plays its own semi-final (A1 v A2, B1 v B2)',
            qualifiersPerGroup: 2,
          },
        },
        schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
        outcome: { champion: [1] },
      },
    ],
  },
  {
    id: 'stream-and-cup',
    name: 'Stream + knockout cup',
    whenToUse:
      'Two streams play a round robin; the lower stream then contests a straight knockout cup.',
    examples: 'KZNCU Promotion Men — 50 Over streams and the Hollywoodbets Kingsmead Cup',
    stages: [
      {
        id: 'streams',
        name: 'Stream round robin',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'manual', groups: { kind: 'even', count: 2 } },
        schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
        groupLabels: ['Top stream', 'Bottom stream'],
      },
      {
        id: 'cup',
        name: 'Knockout cup',
        format: { kind: 'knockout', pairing: 'seeded' },
        entrants: {
          kind: 'manual',
          derivedFrom: {
            rule: 'carry-forward',
            fromStage: 'streams',
            detail: 'The bottom stream minus its last-placed side, seeded by finishing position',
          },
        },
        schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
        outcome: { champion: [1] },
      },
    ],
  },
  {
    // The one-off event that used to go through the retired create-series form. Sides are
    // picked by the admin on Confirm entrants; the seeded knockout takes their order as
    // the seed line, and `spread` places the rounds evenly across whatever dates the
    // admin gives it (a weekend, a fortnight).
    id: 'one-off-tournament',
    name: 'One-off tournament',
    whenToUse:
      'A cup or festival outside the league season: pick the sides, get a seeded knockout.',
    examples: 'A club’s invitation weekend, a mid-season cup day',
    stages: [
      {
        id: 'tournament',
        name: 'Tournament',
        format: { kind: 'knockout', pairing: 'seeded' },
        entrants: { kind: 'manual' },
        schedule: { blockIndex: 0, cadence: { kind: 'spread' } },
      },
    ],
  },
];

export function findTemplate(id: string): StructureTemplate | undefined {
  return STRUCTURE_TEMPLATES.find((t) => t.id === id);
}

/**
 * The block position a template's Nth stage lands on for a given calendar: stage 0 opens
 * in the first block; every later stage goes to the second if the calendar has one, else
 * stays in the first. That matches how both unions actually run a season — group phase
 * before the mid-season break, deciders after it — and an operator who wants otherwise
 * just changes the dropdown.
 *
 * The same rule as `defaultPlacement`, per stage. Kept for callers that place one stage
 * at a time; `defaultPlacement` is what `instantiateTemplate` and the season wizard use,
 * and an operator's explicit "plays in" choice overrides both.
 */
export function templateBlockIndexForStage(
  i: number,
  calendar: SeasonCalendar | undefined,
): number {
  // Positions, not ids — a structure names no calendar of its own, so this is just "first
  // block" / "second block" wherever the bound calendar turns out to be. `calendar` still
  // decides whether a second block actually exists to distinguish stage 0 from the rest.
  const second = (calendar?.blocks?.length ?? 0) > 1 ? 1 : 0;
  return i === 0 ? 0 : second;
}

/**
 * The block each of a template's stages plays in when the operator hasn't said: the
 * `templateBlockIndexForStage` rule over a calendar of `blockCount` blocks. It is the
 * PREFILL for the "plays in" choice, never a decision made on the operator's behalf.
 */
export function defaultPlacement(template: StructureTemplate, blockCount: number): number[] {
  const second = blockCount > 1 ? 1 : 0;
  return template.stages.map((_, i) => (i === 0 ? 0 : second));
}

/**
 * Put each stage in its block and keep chaining consistent with the result: a stage in
 * the same block as the stage before it gets `startAfter: 'previous-stage'` (otherwise
 * both would date from the block start and overlap); any other stage has the key removed,
 * because validation rejects a chained stage with no earlier stage in its block.
 *
 * Only `blockIndex` and `startAfter` change — every other schedule field is kept.
 */
export function applyPlacement(stages: StageSpec[], placement: number[]): StageSpec[] {
  return stages.map((stage, i) => {
    const blockIndex = placement[i] ?? stage.schedule.blockIndex;
    const prev = i > 0 ? (placement[i - 1] ?? stages[i - 1].schedule.blockIndex) : undefined;
    const { startAfter: _startAfter, ...rest } = stage.schedule;
    void _startAfter;
    return {
      ...stage,
      schedule: {
        ...rest,
        blockIndex,
        ...(i > 0 && blockIndex === prev ? { startAfter: 'previous-stage' as const } : {}),
      },
    };
  });
}

/**
 * Clone a template into an editable structure bound to a real calendar.
 *
 * `placement` (one block position per stage) is the operator's explicit choice and wins
 * when given; without it the stages take `defaultPlacement`. Either way stages sharing a
 * block with the stage before them are chained (`applyPlacement`).
 */
export function instantiateTemplate(
  template: StructureTemplate,
  calendar: SeasonCalendar | undefined,
  name?: string,
  placement?: number[],
): CompetitionStructure {
  const defaults = defaultPlacement(template, calendar?.blocks?.length ?? 0);
  const blocks = template.stages.map((_, i) => placement?.[i] ?? defaults[i]);
  const copies = template.stages.map((stage) => ({
    ...stage,
    schedule: {
      ...stage.schedule,
      // Fresh copies, and only when the template has slots at all — never an explicit
      // `slots: undefined` key (the whole branch omits the key to mean "no set times").
      ...(stage.schedule.slots ? { slots: stage.schedule.slots.map((s) => ({ ...s })) } : {}),
    },
  }));
  return {
    id: newStructureId(),
    name: name?.trim() || template.name,
    version: 1,
    templateId: template.id,
    stages: applyPlacement(copies, blocks),
  };
}

/** An empty structure with one stage — the "build from scratch" starting point. */
export function blankStructure(
  calendar: SeasonCalendar | undefined,
  name = 'New structure',
): CompetitionStructure {
  return {
    id: newStructureId(),
    name,
    version: 1,
    stages: [blankStage(calendar, 'League season')],
  };
}

/**
 * A new stage, defaulted to the simplest thing that generates something sensible.
 *
 * `calendar` is accepted (not read) to keep this call-compatible with `blankStructure`'s
 * stage-0 case and `instantiateTemplate`'s per-stage mapping, both of which pass whatever
 * calendar is in scope — a fresh stage always opens at block position 0 regardless.
 */
export function blankStage(_calendar: SeasonCalendar | undefined, name = 'New stage'): StageSpec {
  return {
    id: newStructureId('stg'),
    name,
    format: { kind: 'round-robin', legs: 1 },
    entrants: { kind: 'all-registered' },
    schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
  };
}

/**
 * Parse a pasted/imported structure.
 *
 * This is the escape hatch that seeds twenty structures without twenty rounds of
 * clicking, and moves one between tenants. It is deliberately forgiving about the id (a
 * fresh one is minted, so importing the same JSON twice gives two structures rather than
 * a silent overwrite) and strict about everything the engine relies on — the server
 * re-validates regardless, but a local error is a better experience than a round-trip 400.
 */
export function parseStructureJson(
  text: string,
): { ok: true; structure: CompetitionStructure } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That isn’t valid JSON.' };
  }
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Expected a JSON object.' };
  const candidate = raw as Partial<CompetitionStructure>;
  if (!candidate.name?.trim()) return { ok: false, error: 'The structure needs a name.' };
  if (!Array.isArray(candidate.stages) || candidate.stages.length === 0)
    return { ok: false, error: 'The structure needs at least one stage.' };
  for (const stage of candidate.stages) {
    if (!stage?.id || !stage?.name)
      return { ok: false, error: 'Every stage needs an id and name.' };
    if (!stage.format?.kind) return { ok: false, error: `Stage "${stage.name}" has no format.` };
    if (!stage.entrants?.kind)
      return { ok: false, error: `Stage "${stage.name}" has no entrant rule.` };
    if (!stage.schedule?.cadence?.kind)
      return { ok: false, error: `Stage "${stage.name}" has no cadence.` };
    // A structure exported before the ordinal-ref change carries `blockId` — a calendar
    // identity this format no longer has room for. Rejected rather than silently
    // coerced: guessing a position from a foreign id would place the stage somewhere the
    // operator never chose. Checked before the `blockIndex` presence check below, since a
    // legacy export has no `blockIndex` at all and deserves the more specific message.
    if ('blockId' in (stage.schedule as unknown as Record<string, unknown>))
      return {
        ok: false,
        error: 'this structure JSON uses the old blockId format — regenerate it with blockIndex',
      };
    // A missing or non-numeric `blockIndex` round-trips to NaN in the block picker and
    // only dies as a server 400 — caught here instead, before it is ever rendered.
    if (!Number.isInteger(stage.schedule.blockIndex) || stage.schedule.blockIndex < 0)
      return { ok: false, error: `Stage "${stage.name}" has no valid playing block.` };
  }
  return {
    ok: true,
    structure: {
      id: newStructureId(),
      name: candidate.name.trim(),
      version: 1,
      templateId: candidate.templateId,
      stages: candidate.stages,
    },
  };
}

/** Serialise for export — drops the tenant-local id so an import can mint a fresh one. */
export function structureToJson(structure: CompetitionStructure): string {
  const { id: _id, ...rest } = structure;
  void _id;
  return JSON.stringify(rest, null, 2);
}
