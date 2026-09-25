/**
 * Plain-English copy for every choice a structure stage offers (ADR 0008).
 *
 * One registry per control — format, teams, cadence — so the operator console's option
 * lists, the "(i)" explainers and the season narrative all quote the same sentences.
 * Source: public/guides/league-structures-tutorial.html, Parts One and Four.
 *
 * Vocabulary: a calendar date range is a BLOCK; a phase of play is a STAGE; teams split
 * into GROUPS (never "pools" in copy — `pairing: 'cross-pool'` is a stored value, not a
 * label).
 */

import type { Cadence, EntrantSpec, FormatSpec } from './types';

/** What a format choice means, in the words an operator would use out loud. */
export interface StageKindHelp {
  /** The option's name in the Format picker. Unique — the picker keys on it. */
  title: string;
  /** What the format does, in one or two sentences. */
  does: string;
  /** What the admin will have to type later, when the season runs. */
  youWillBeAsked: string;
  /** What comes out: rounds and fixtures. */
  produces: string;
  eg: string;
  /** When to pick this one over the others. */
  decideBy: string;
}

/** A plain choice with an example — teams and cadence options. */
export interface ChoiceHelp {
  title: string;
  does: string;
  eg: string;
  decideBy: string;
}

export type StageKindId =
  | 'round-robin-1'
  | 'round-robin-2'
  | 'round-robin-3'
  | 'knockout-seeded'
  | 'knockout-cross-pool'
  | 'knockout-within-pool'
  | 'single-match'
  | 'manual';

export const STAGE_KINDS: Record<StageKindId, StageKindHelp> = {
  'round-robin-1': {
    title: 'Single round robin',
    does: 'Every side in a group plays every other side once.',
    youWillBeAsked: 'Nothing extra. The rounds come from the number of sides in each group.',
    produces: '11 rounds for a group of 12, or 5 rounds for a group of 6.',
    eg: 'a league of 12 sides, each playing 11 matches.',
    decideBy: 'Pick this when each side should meet each other side exactly once.',
  },
  'round-robin-2': {
    title: 'Double round robin',
    does: 'Every side plays every other side twice, once at home and once away. The second leg mirrors the first.',
    youWillBeAsked: 'Nothing extra. The rounds come from the number of sides in each group.',
    produces: 'Twice the rounds of a single round robin: 10 rounds for a group of 6.',
    eg: 'a 12-side league split into a Top Six and a Bottom Six, 30 fixtures in each group.',
    decideBy: 'Pick this for a full home-and-away season.',
  },
  'round-robin-3': {
    title: 'Triple round robin',
    does: 'Every side plays every other side three times.',
    youWillBeAsked: 'Nothing extra. The rounds come from the number of sides in each group.',
    produces: 'Three times the rounds of a single round robin: 9 rounds for a group of 4.',
    eg: 'a group of 4 that needs more matches to separate the sides.',
    decideBy: 'Rare. Pick it only when two legs are not enough matches.',
  },
  'knockout-seeded': {
    title: 'Knockout — seeded',
    does: 'A standard bracket from the seeding order. Seeds 1 and 2 can only meet in the final.',
    youWillBeAsked: 'the seeding order of the sides that go through, best first.',
    produces:
      'Semi-finals and a final for 4 sides. A field that is not 2, 4, 8 or 16 gets a preliminary round among the lowest seeds.',
    eg: 'a 9-side cup: one preliminary match, then quarter-finals, semi-finals and a final.',
    decideBy: 'Pick this when sides go through on one ranked list, not group by group.',
  },
  'knockout-cross-pool': {
    title: 'Knockout — cross-group',
    does: 'Each group winner plays another group’s runner-up: A1 v B2 and B1 v A2. Sides from the same group cannot meet again straight away.',
    youWillBeAsked: 'the finishing order of each group in the previous stage.',
    produces: 'Two semi-finals and a final when two groups send two sides each.',
    eg: 'two groups of 6, the top two of each into cross-group semi-finals.',
    decideBy: 'Pick this when group winners should face a runner-up from the other group.',
  },
  'knockout-within-pool': {
    title: 'Knockout — within-group',
    does: 'Each group plays its own semi-final: A1 v A2 and B1 v B2. The two winners meet in the final.',
    youWillBeAsked: 'the finishing order of each group in the previous stage.',
    produces:
      'One semi-final per group, then a final. Needs 2, 4 or 8 groups each sending the same number of sides (2 or 4).',
    eg: 'a 10-side league in two groups of 5, the top two of each.',
    decideBy: 'Pick this when each group should produce its own finalist.',
  },
  'single-match': {
    title: 'Single match',
    does: 'One fixture between two sides.',
    youWillBeAsked: 'Nothing extra. It plays the first two sides on this stage’s team list.',
    produces: 'One fixture.',
    eg: 'a grand final, or a one-off playoff.',
    decideBy: 'Pick this for a final that stands on its own.',
  },
  manual: {
    title: 'Fixtures entered by hand',
    does: 'The platform makes no fixtures. The admin adds each match afterwards.',
    youWillBeAsked: 'every fixture, one at a time, after the stage is set up.',
    produces: 'No fixtures until the admin adds them.',
    eg: 'an invitational with no fixed pattern.',
    decideBy: 'Pick this only when no other format fits.',
  },
};

export type EntrantKindId =
  | 'all-registered'
  | 'seeded-split-snake'
  | 'seeded-split-blocks'
  | 'manual';

export const ENTRANT_KINDS: Record<EntrantKindId, ChoiceHelp> = {
  'all-registered': {
    title: 'Every registered side',
    does: 'Every side entered in the league plays, all in one group. This option cannot be split into groups.',
    eg: '12 registered sides, one group of 12.',
    decideBy: 'Pick this for a flat league where everyone plays everyone.',
  },
  'seeded-split-snake': {
    title: 'Seeded into groups (snake)',
    does: 'Sides are dealt into groups by seed, back and forth: 1→A, 2→B, 3→B, 4→A. Seeds 1 and 2 always land in different groups.',
    eg: '12 sides into two evenly matched groups of 6.',
    decideBy: 'Pick this when every group should be equally strong.',
  },
  'seeded-split-blocks': {
    title: 'Seeded into groups (top-down)',
    does: 'Sides fill one group at a time in seed order, so the top half goes into group A.',
    eg: 'seeds 1–6 in a Top Six, seeds 7–12 in a Bottom Six.',
    decideBy: 'Pick this when the groups are tiers, strongest sides together.',
  },
  manual: {
    title: 'Chosen by the admin',
    does: 'The admin types which sides play in each group when the stage opens. Use it whenever the answer depends on results.',
    eg: 'the top two of each group going through to the semi-finals.',
    decideBy: 'Pick this when the teams come from an earlier stage’s finishing order.',
  },
};

export type CadenceKindId = Cadence['kind'];

export const CADENCE_KINDS: Record<CadenceKindId, ChoiceHelp> = {
  weekly: {
    title: 'Weekly',
    does: 'One round each week, on the weekday the block starts.',
    eg: 'a block starting Sunday 13 Sep 2026 plays every Sunday.',
    decideBy: 'The usual choice.',
  },
  'every-n-weeks': {
    title: 'Every N weeks',
    does: 'One round every few weeks. You set the gap.',
    eg: 'every 2 weeks, for a league that plays fortnightly.',
    decideBy: 'Pick this for a league that plays fortnightly or less often.',
  },
  weekdays: {
    title: 'Set days only',
    does: 'Rounds go only on the weekdays you tick, one round per day.',
    eg: 'Saturdays only, for a league that never plays midweek.',
    decideBy: 'Pick this when the league plays on fixed days of the week.',
  },
  spread: {
    title: 'Spread across the block',
    does: 'Rounds are spaced evenly from the block’s first date to its last.',
    eg: 'six rounds over a 12-week block, about one every two weeks.',
    decideBy: 'Pick this when the rounds should fill the block, however long it is.',
  },
};

/** The registry key for a stage's format. */
export function stageKindFor(format: FormatSpec): StageKindId {
  switch (format?.kind) {
    case 'round-robin':
      return format.legs === 3
        ? 'round-robin-3'
        : format.legs === 2
          ? 'round-robin-2'
          : 'round-robin-1';
    case 'knockout':
      return format.pairing === 'cross-pool'
        ? 'knockout-cross-pool'
        : format.pairing === 'within-pool'
          ? 'knockout-within-pool'
          : 'knockout-seeded';
    case 'single-match':
      return 'single-match';
    case 'manual':
      return 'manual';
    default:
      return 'round-robin-1';
  }
}

/** The registry key for a stage's teams setting. */
export function entrantKindFor(entrants: EntrantSpec): EntrantKindId {
  switch (entrants?.kind) {
    case 'seeded-split':
      return entrants.method === 'snake' ? 'seeded-split-snake' : 'seeded-split-blocks';
    case 'manual':
      return 'manual';
    default:
      return 'all-registered';
  }
}

/**
 * What a stage is called by its kind: "Round-robin stage", "Knockout stage", "Final",
 * "Hand-entered stage". A stage is never called a block — blocks are calendar dates.
 */
export function stageTitle(format: FormatSpec): string {
  switch (format?.kind) {
    case 'knockout':
      return 'Knockout stage';
    case 'single-match':
      return 'Final';
    case 'manual':
      return 'Hand-entered stage';
    default:
      return 'Round-robin stage';
  }
}
