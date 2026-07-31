/**
 * Starter structure templates.
 *
 * Four blueprints cover all thirteen structures in the KZNCU and EMCU documents. An
 * operator clones one and tunes the parameters, or builds from scratch — a template is a
 * starting point, never a constraint (ADR 0008). `templateId` survives on the clone as
 * provenance only; nothing reads it back to constrain editing.
 *
 * Templates carry NO block ids, because blocks belong to a calendar the template has
 * never seen. `instantiateTemplate` maps them on: the opening stage takes the first
 * block, anything after it takes the second where one exists — which is exactly the
 * "group phase before the break, deciders after it" shape both unions use.
 */

import type { CompetitionStructure, SeasonCalendar, StageSpec } from '../types';

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
        schedule: { blockId: '', cadence: { kind: 'weekly' } },
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
        schedule: { blockId: '', cadence: { kind: 'weekly' } },
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
        schedule: { blockId: '', cadence: { kind: 'weekly' } },
        groupLabels: ['Top group', 'Bottom group'],
        outcome: { champion: [1], relegated: [-1] },
      },
    ],
  },
  {
    id: 'pools-to-knockout',
    name: 'Seeded pools → cross-pool semis → final',
    whenToUse:
      'Seeded pools play a round robin, then the top finishers cross over into a knockout.',
    examples: 'Every T20 Pink Ball competition — Premier Men, Premier Women, Promotion Men',
    stages: [
      {
        id: 'pools',
        name: 'Pool stage',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'seeded-split', groups: { kind: 'even', count: 2 }, method: 'snake' },
        schedule: { blockId: '', cadence: { kind: 'weekly' } },
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
            detail: 'Top two from each pool, paired across pools',
          },
        },
        schedule: { blockId: '', cadence: { kind: 'weekly' } },
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
        schedule: { blockId: '', cadence: { kind: 'weekly' } },
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
        schedule: { blockId: '', cadence: { kind: 'weekly' } },
        outcome: { champion: [1] },
      },
    ],
  },
];

export function findTemplate(id: string): StructureTemplate | undefined {
  return STRUCTURE_TEMPLATES.find((t) => t.id === id);
}

/**
 * Clone a template into an editable structure bound to a real calendar.
 *
 * Stage 0 opens in the first block; later stages go to the second if the calendar has
 * one, else stay in the first. That matches how both unions actually run a season — group
 * phase before the mid-season break, deciders after it — and an operator who wants
 * otherwise just changes the dropdown.
 */
export function instantiateTemplate(
  template: StructureTemplate,
  calendar: SeasonCalendar | undefined,
  name?: string,
): CompetitionStructure {
  const first = calendar?.blocks?.[0]?.id ?? '';
  const second = calendar?.blocks?.[1]?.id ?? first;
  return {
    id: newStructureId(),
    name: name?.trim() || template.name,
    version: 1,
    templateId: template.id,
    // The blockIds just came from this calendar, so record it. Leaving it off meant a
    // brand-new structure was born in the shape the editor can't resolve — the same
    // state every seeded structure was in, and the one that produces blank block pickers.
    ...(calendar ? { calendarId: calendar.id } : {}),
    stages: template.stages.map((stage, i) => ({
      ...stage,
      schedule: { ...stage.schedule, blockId: i === 0 ? first : second },
    })),
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
    // As in `instantiateTemplate`: `blankStage` takes its blockId from this calendar, so
    // the structure records which one that was.
    ...(calendar ? { calendarId: calendar.id } : {}),
    stages: [blankStage(calendar, 'League season')],
  };
}

/** A new stage, defaulted to the simplest thing that generates something sensible. */
export function blankStage(calendar: SeasonCalendar | undefined, name = 'New stage'): StageSpec {
  return {
    id: newStructureId('stg'),
    name,
    format: { kind: 'round-robin', legs: 1 },
    entrants: { kind: 'all-registered' },
    schedule: { blockId: calendar?.blocks?.[0]?.id ?? '', cadence: { kind: 'weekly' } },
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
  }
  return {
    ok: true,
    structure: {
      id: newStructureId(),
      name: candidate.name.trim(),
      version: 1,
      templateId: candidate.templateId,
      // Carried, because `structureToJson` EXPORTS it — rebuilding the object without it
      // meant an export→import round trip manufactured a structure with real block ids
      // and no record of which calendar they belong to, which is exactly the shape that
      // makes the editor open on the wrong calendar with every block picker blank.
      // An id from a foreign tenant is harmless: `resolveDesignCalendarId` only honours
      // one that exists here, and saving overwrites it with the resolved value. Still
      // type-checked, because every other field here is and a non-string would otherwise
      // ride untouched into the tenant config — `validateStructures` never inspects it.
      calendarId: typeof candidate.calendarId === 'string' ? candidate.calendarId : undefined,
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
