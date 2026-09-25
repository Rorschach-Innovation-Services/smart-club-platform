/**
 * Per-field explainers for the season calendar, structure and release forms (ADR 0008,
 * ADR 0011). Each says what the field means, how the platform uses it, and gives one
 * concrete example. `convention` is the house rule for filling it in, where there is one.
 */

export interface FieldGuide {
  label: string;
  meaning: string;
  howUsed: string;
  example: string;
  convention?: string;
}

export type FieldGuideId =
  | 'block-dates'
  | 'breaks'
  | 'exclude-dates'
  | 'seed-order'
  | 'group-plan'
  | 'group-names'
  | 'derivation-rule'
  | 'qualifiers-per-group'
  | 'cadence'
  | 'start-after-previous'
  | 'time-slots'
  | 'activate-from'
  | 'position-column'
  | 'semi-final-pairing'
  | 'withhold'
  | 'venue-mode';

export const FIELD_GUIDES: Record<FieldGuideId, FieldGuide> = {
  'block-dates': {
    label: 'Block dates',
    meaning: 'The first and last date a match may be played in this block.',
    howUsed: 'Every stage in the block plans its rounds between these two dates, both included.',
    example: 'Block 1: 2026-09-13 to 2026-12-13.',
    convention: 'Dates are YYYY-MM-DD. A block that ends before it starts is refused.',
  },
  breaks: {
    label: 'Breaks',
    meaning: 'A stretch inside the season when nobody plays.',
    howUsed:
      'A round that lands in a break moves to the next free date. Rounds are pushed later, never dropped.',
    example: 'Mid-season break, 14 Dec 2026 – 17 Jan 2027.',
  },
  'exclude-dates': {
    label: 'Excluded dates',
    meaning: 'Single days that are out: public holidays, exam weekends, the union’s AGM.',
    howUsed: 'Same as a break, for one day. A round on that day moves to the next free date.',
    example: '24 Sep 2026 (Heritage Day).',
  },
  'seed-order': {
    label: 'Seeding order',
    meaning: 'The sides in order of strength, strongest first.',
    howUsed:
      'Snake puts seeds 1 and 2 in different groups (1→A, 2→B, 3→B, 4→A). Top-down puts the top half in group A.',
    example: 'Westville, Crusaders, Berea Rovers, Glenwood… as they finished last season.',
    convention: 'Order by last season’s final position.',
  },
  'group-plan': {
    label: 'Group plan',
    meaning: 'How many groups, and how big each one is.',
    howUsed:
      'Even groups split the sides as equally as possible; any extra side goes to the earlier groups. Exact sizes are used as typed.',
    example:
      '“2 groups” of 12 sides gives 6 + 6. Exact sizes “5, 5, 5, 4” is the only way to split 19 sides.',
  },
  'group-names': {
    label: 'Group names',
    meaning: 'What each group is called.',
    howUsed: 'Shown to clubs on fixtures and to the admin when confirming teams.',
    example: 'Top Six, Bottom Six.',
    convention: 'Comma-separated. Left blank, groups are called Group A, Group B and so on.',
  },
  'derivation-rule': {
    label: 'Rule',
    meaning: 'How this stage’s teams come from an earlier stage, in plain words.',
    howUsed:
      'Quoted back word for word to the admin when they confirm this stage’s teams. It is the whole instruction they get.',
    example: 'Top Six 6th ↔ Bottom Six 1st, carrying the outgoing position’s points.',
    convention: 'Write it the way the union says it.',
  },
  'qualifiers-per-group': {
    label: 'Qualifiers per group',
    meaning: 'How many sides from each group go through. Not which ones.',
    howUsed:
      'Sizes the next stage exactly and pre-fills the top sides of each group. The admin still types the finishing order.',
    example: '2 groups, top 2 each: 4 sides into the semi-finals.',
  },
  cadence: {
    label: 'Cadence',
    meaning: 'How often rounds are played inside the block.',
    howUsed:
      'Weekly, every N weeks, set days only (such as Saturdays only), or spread evenly across the block.',
    example: 'Every 2 weeks for EMCU Division 4.',
  },
  'start-after-previous': {
    label: 'Start after the previous stage',
    meaning: 'This stage waits for the previous stage in the same block to finish.',
    howUsed:
      'The first round goes on the next playing day after the previous stage’s last round, on the same weekday. Without it both stages start on the block’s first date and overlap.',
    example: 'Groups finish on 22 Nov 2026; the semi-finals follow on 29 Nov.',
  },
  'time-slots': {
    label: 'Time slots',
    meaning: 'Start times on a playing day.',
    howUsed:
      'Fixtures are stamped with the slots in turn. Two slots with two rounds per day gives double-headers: every side plays morning and afternoon.',
    example: '08:00 morning and 13:30 afternoon for a T20 day.',
  },
  'activate-from': {
    label: 'Show to clubs from',
    meaning: 'The date clubs start to see this stage’s fixtures.',
    howUsed: 'The fixtures exist now and can be released. Clubs see them only from this date.',
    example:
      'Junior fixtures made in September, shown to clubs from 18 Jan 2027 when Block 2 starts.',
  },
  'position-column': {
    label: 'Position',
    meaning: 'Where each side finished in its group. 1 is the group winner.',
    howUsed:
      'Sets who plays whom in the next stage: A1 v B2 for cross-group semi-finals, or the seeding for a knockout.',
    example: 'Group A: Westville 1, Crusaders 2, Glenwood 3.',
  },
  'semi-final-pairing': {
    label: 'Semi-final pairing',
    meaning: 'Whether the semi-finals are within each group or across groups.',
    howUsed:
      'Within-group is A1 v A2 and B1 v B2. Cross-group is A1 v B2 and B1 v A2. The choice is stored on this season only.',
    example: 'The structure says cross-group; this season the union asks for within-group.',
  },
  withhold: {
    label: 'Withhold',
    meaning: 'Release the dates now, but hide grounds or start times from clubs.',
    howUsed:
      'Clubs see “to be confirmed”. The clash check still checks the real ground. To change what is withheld, recall the series and release it again.',
    example:
      'Release Premier Men T20 on 1 Sep 2026 with venues withheld until grounds are settled.',
  },
  'venue-mode': {
    label: 'Venue',
    meaning:
      'Where this fixture is played: allocated, the home ground, the secondary ground, or another ground.',
    howUsed:
      'Allocated follows the allocator. “Other” locks the fixture to the ground you type, so allocation never moves it.',
    example: 'Other: Kingsmead, for a final the union has booked.',
  },
};
