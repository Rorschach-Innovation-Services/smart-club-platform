/**
 * A structure told as a story — one plain-English sentence per stage.
 *
 *   "Stage 1 · Round-robin stage · 12 sides seeded into 2 groups of 6 (snake) · everyone
 *    plays everyone once · weekly in Block 1, 13 Sep – 22 Nov 2026."
 *
 * Built from the same pure helpers the preview rail and the season console use
 * (`previewFitAll`, `derivedEntrantTotal`, `groupSizes`), so the sentence can never
 * disagree with the fit verdict next to it. Nothing here re-derives dates.
 *
 * `describeStage` — the shorter collapsed-row sentence — lives here too, so every
 * sentence about a stage comes from one module.
 */

import { describeCadence, findBlock, formatIsoDate } from './calendar';
import { describeEntrants, groupSizes } from './entrants';
import { describeFormat, knockoutShape } from './formats';
import { chainFeeder, derivedEntrantTotal, previewFitAll } from './structure';
import { stageTitle } from './stage-kinds';
import type { CompetitionStructure, GroupPlan, IsoDate, SeasonCalendar, StageSpec } from './types';

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

/** A stage's group plan, where its teams setting has one. */
function planOf(stage: StageSpec): GroupPlan | undefined {
  return stage.entrants.kind === 'all-registered' ? undefined : stage.entrants.groups;
}

/**
 * How many sides a stage takes, or undefined when nobody can know yet: a stage chosen by
 * the admin from an earlier stage's results, with no qualifier count and no group plan
 * (a knockout cup drawn from "the bottom stream minus its last side"). Guessing the full
 * team count there would describe — and date — a bracket nobody will play.
 */
function knownSizes(
  stage: StageSpec,
  stages: StageSpec[],
  groupCounts: Map<string, number>,
  teamCount: number,
): number[] | undefined {
  const total = derivedEntrantTotal(stage, stages, (id) => groupCounts.get(id));
  if (total !== undefined) return groupSizes(planOf(stage), total);
  const e = stage.entrants;
  if (e.kind === 'manual' && e.derivedFrom && !e.groups) return undefined;
  return groupSizes(planOf(stage), teamCount);
}

/** "2 groups of 6", "4 groups (5, 5, 5, 4)", "one group of 12". */
function groupsPhrase(sizes: number[]): string {
  if (sizes.length <= 1) return `one group of ${sizes[0] ?? 0}`;
  const same = sizes.every((s) => s === sizes[0]);
  return same
    ? `${sizes.length} groups of ${sizes[0]}`
    : `${sizes.length} groups (${sizes.join(', ')})`;
}

function sides(n: number): string {
  return `${n} side${n === 1 ? '' : 's'}`;
}

/** Who plays, as a clause. */
function entrantsPhrase(
  stage: StageSpec,
  stages: StageSpec[],
  sizes: number[] | undefined,
  teamCount: number,
): string {
  const e = stage.entrants;
  if (e.kind === 'all-registered') return `all ${sides(teamCount)} in one group`;
  if (e.kind === 'seeded-split') {
    const method = e.method === 'snake' ? 'snake' : 'top-down';
    return `${sides(teamCount)} seeded into ${groupsPhrase(sizes ?? [teamCount])} (${method})`;
  }
  const note = e.derivedFrom;
  const fromIndex = note ? stages.findIndex((s) => s.id === note.fromStage) : -1;
  const from = fromIndex >= 0 ? `Stage ${fromIndex + 1}` : 'an earlier stage';
  const q = note?.qualifiersPerGroup;
  if (note && Number.isInteger(q) && (q as number) > 0) return `top ${q} per group from ${from}`;
  const into = e.groups && sizes ? ` into ${groupsPhrase(sizes)}` : '';
  return note ? `chosen by the admin from ${from}${into}` : `chosen by the admin${into}`;
}

/** "semi-finals, then a final" — the rounds of a bracket of `n`, first to last. */
function bracketRounds(n: number): string[] {
  const { preliminaries, mainDraw } = knockoutShape(n);
  const names: string[] = [];
  if (preliminaries > 0)
    names.push(preliminaries === 1 ? 'a preliminary match' : 'a preliminary round');
  const main = Math.log2(Math.max(1, mainDraw));
  for (let i = 0; i < main; i++) {
    const fromEnd = main - 1 - i;
    names.push(
      fromEnd === 0
        ? 'a final'
        : fromEnd === 1
          ? 'semi-finals'
          : fromEnd === 2
            ? 'quarter-finals'
            : `a round of ${Math.pow(2, fromEnd + 1)}`,
    );
  }
  return names;
}

function joinThen(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')}, then ${parts[parts.length - 1]}`;
}

/** Who plays whom, as a clause. `n` is the knockout's field, when known. */
function formatPhrase(stage: StageSpec, n: number | undefined): string {
  const f = stage.format;
  switch (f.kind) {
    case 'round-robin':
      return f.legs === 3
        ? 'everyone plays everyone three times'
        : f.legs === 2
          ? 'everyone plays everyone twice, home and away'
          : 'everyone plays everyone once';
    case 'knockout': {
      const playoff = f.thirdPlace ? ', plus a third-place playoff' : '';
      if (n === undefined || n < 2) {
        const how =
          f.pairing === 'within-pool'
            ? 'a knockout paired within each group'
            : f.pairing === 'cross-pool'
              ? 'a knockout paired across groups'
              : 'a seeded knockout';
        return `${how}, size set by the admin${playoff}`;
      }
      const rounds = bracketRounds(n);
      if (f.pairing === 'within-pool' || f.pairing === 'cross-pool') {
        const suffix =
          f.pairing === 'within-pool'
            ? ' within each group'
            : n === 4
              ? ' across groups (A1 v B2, B1 v A2)'
              : ' across groups';
        rounds[0] = `${rounds[0]}${suffix}`;
        return `${joinThen(rounds)}${playoff}`;
      }
      return `a seeded knockout: ${joinThen(rounds)}${playoff}`;
    }
    case 'single-match':
      return 'one match';
    case 'manual':
      return 'fixtures entered by hand';
    default:
      return 'everyone plays everyone once';
  }
}

/** "13 Sep – 22 Nov 2026", "13 Dec 2026 – 17 Jan 2027", or one date. */
function dateRange(first: IsoDate, last: IsoDate): string {
  if (first === last) return formatIsoDate(first);
  const a = formatIsoDate(first);
  const b = formatIsoDate(last);
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  return `${sameYear ? a.replace(/ \d{4}$/, '') : a} – ${b}`;
}

/** "Block 1", with the calendar's own name alongside when it says something else. */
function blockName(stage: StageSpec, calendar: SeasonCalendar | undefined): string {
  const i = stage.schedule.blockIndex;
  const name = `Block ${i + 1}`;
  if (!calendar) return name;
  const block = findBlock(calendar, i);
  if (!block) return `${name} (not on this calendar)`;
  const label = block.label?.trim();
  return label && label !== name ? `${name} (${label})` : name;
}

/**
 * The whole structure, one sentence per stage, previewed at `teamCount` sides.
 *
 * With no calendar the sentences name the block but carry no dates. With one, dates come
 * from `previewFitAll` — the same sequential walk the preview rail and the season wizard
 * use — and a stage that overruns its block says by how many rounds.
 */
export function describeStructure(
  structure: CompetitionStructure,
  calendar: SeasonCalendar | undefined,
  teamCount: number,
): string[] {
  const stages = structure.stages ?? [];
  const groupCounts = new Map<string, number>();
  const sizesPerStage: Record<string, number[]> = {};
  const sized = stages.map((stage) => {
    const sizes = knownSizes(stage, stages, groupCounts, teamCount);
    if (sizes) {
      groupCounts.set(stage.id, sizes.length);
      sizesPerStage[stage.id] = sizes;
    }
    return sizes;
  });
  const fits = calendar ? previewFitAll(structure, calendar, sizesPerStage) : null;

  return stages.map((stage, i) => {
    const sizes = sized[i];
    const parts = [
      `Stage ${i + 1}`,
      stageTitle(stage.format),
      entrantsPhrase(stage, stages, sizes, teamCount),
      formatPhrase(stage, sizes?.[0]),
    ];

    // When: after a feeder, or from the block's start at the cadence.
    const block = blockName(stage, calendar);
    const cadence = describeCadence(stage.schedule.cadence);
    const feeder = chainFeeder(stage, stages);
    const feederNo = feeder ? stages.findIndex((s) => s.id === feeder.id) + 1 : 0;
    let when = feeder
      ? stage.schedule.cadence.kind === 'weekly'
        ? `starts the week after Stage ${feederNo}, in ${block}`
        : `starts after Stage ${feederNo} finishes, ${cadence} in ${block}`
      : `${cadence} in ${block}`;
    if (stage.schedule.roundsPerDay === 2) when += ', two rounds a day';

    const fit = fits?.[i];
    let tail = '';
    if (fit && fit.plans.length) {
      if (!fit.fits) {
        const over = Math.max(...fit.plans.map((p) => p.roundsRequested - p.roundsPlaced));
        tail = ` · does not fit the block (${over} round${over === 1 ? '' : 's'} over)`;
      } else {
        const dates = fit.plans.flatMap((p) => p.dates).sort();
        if (dates.length) when += `, ${dateRange(dates[0], dates[dates.length - 1])}`;
      }
    }
    parts.push(when);
    const activate = stage.schedule.activateFrom
      ? ` · clubs see it from ${formatIsoDate(stage.schedule.activateFrom)}`
      : '';
    return `${parts.join(' · ')}${tail}${activate}.`;
  });
}
