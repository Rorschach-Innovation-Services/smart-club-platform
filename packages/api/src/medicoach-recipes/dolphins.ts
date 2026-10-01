/**
 * Dolphins (KZNCU) medicoach recipes: the five flagship leagues, per the medicoach
 * League handover (§9.3). The handover's sixth, Promotion Women's, is excluded until the
 * union creates it. See ./types.ts for what a recipe is and when it applies.
 *
 * Every `confirm` note is an open question for the union. The exporter prints them in
 * its summary and copies them into the bundle's `meta.confirmations`. Don't resolve them
 * here by guessing; change the recipe once the union answers.
 */
import type { CompetitionRecipe, RecipeLaterFixture, TenantRecipes } from './types.js';

const gp = (group: number, position: number) =>
  ({ kind: 'group-position', group, position }) as const;
const win = (of: string) => ({ kind: 'winner', of }) as const;

/** Two semis then a final between their winners. */
function semisAndFinal(
  sf1: [ReturnType<typeof gp>, ReturnType<typeof gp>],
  sf2: [ReturnType<typeof gp>, ReturnType<typeof gp>],
): RecipeLaterFixture[] {
  return [
    { slotId: 'sf1', stage: 'Semi-final', round: 1, home: sf1[0], away: sf1[1] },
    { slotId: 'sf2', stage: 'Semi-final', round: 1, home: sf2[0], away: sf2[1] },
    { slotId: 'final', stage: 'Final', round: 2, home: win('sf1'), away: win('sf2') },
  ];
}

/**
 * Top two per group, crossed: G1-1 v G2-2, G2-1 v G1-2, then the final. The handover said
 * "top 2 cross-pool semis" without the exact pairing. Confirmed by the union 1 Oct 2026:
 * crossed semis for Premier Women's T20 and Veterans Premier T20.
 */
function crossPoolTopTwo(name: string, sizes: number[]): CompetitionRecipe {
  return {
    name,
    format: {
      type: 'groups_knockout',
      rounds: 1,
      extraPhases: [],
      teamsPerGroup: Math.max(...sizes),
      advancePerGroup: 2,
    },
    cricketMatchFormat: 'T20',
    expectedGroupSizes: sizes,
    laterFixtures: semisAndFinal([gp(1, 1), gp(2, 2)], [gp(2, 1), gp(1, 2)]),
  };
}

export const DOLPHINS_RECIPES: TenantRecipes = {
  tenant: 'dolphins',
  province: 'KwaZulu-Natal',
  utcOffset: '+02:00',
  leagues: {
    premier: {
      competitions: {
        t20: {
          name: 'T20',
          format: {
            type: 'groups_knockout',
            rounds: 1,
            extraPhases: [],
            teamsPerGroup: 6,
            advancePerGroup: 2,
          },
          cricketMatchFormat: 'T20',
          expectedGroupSizes: [6, 6],
          // Verbatim from the handover: G1-1 v G2-1 and G1-2 v G2-2 (not A1 v B2).
          laterFixtures: semisAndFinal([gp(1, 1), gp(2, 1)], [gp(1, 2), gp(2, 2)]),
        },
        '50-over': {
          name: '50 Over',
          format: {
            type: 'league',
            rounds: 2,
            extraPhases: [{ type: 'league', rounds: 1, groupSeeding: 'carry' }],
            teamsPerGroup: 6,
          },
          cricketMatchFormat: 'ODI',
          expectedGroupSizes: [6, 6],
          swaps: [{ groupA: 1, positionA: 6, groupB: 2, positionB: 1, carryPoints: true }],
          positionRelegations: [{ group: 2, position: 6, targetLeagueKey: 'promotion' }],
        },
      },
    },
    promotion: {
      competitions: {
        t20: {
          name: 'T20',
          format: {
            type: 'groups_knockout',
            rounds: 1,
            extraPhases: [],
            teamsPerGroup: 5,
            advancePerGroup: 1,
          },
          cricketMatchFormat: 'T20',
          expectedGroupSizes: [5, 5, 5, 5],
          // Confirmed by the union 1 Oct 2026: winners semis pair G1vG2 and G3vG4.
          laterFixtures: semisAndFinal([gp(1, 1), gp(2, 1)], [gp(3, 1), gp(4, 1)]),
        },
        '30-over': {
          name: '30 Over',
          format: {
            type: 'league',
            rounds: 1,
            extraPhases: [{ type: 'league', rounds: 1, groupSeeding: 'subdivide', subGroups: 2 }],
            teamsPerGroup: 10,
          },
          cricketMatchFormat: 'T30',
          expectedGroupSizes: [10, 10],
          // Confirmed by the union 1 Oct 2026: the "Hollywoodbets Kingsmead Cup" is the NAME of
          // the Bottom-10 group's (Group 2's) subdivide stage, so this structural model stands.
          // medicoach auto-names the subdivide children "Group 2 A"/"Group 2 B"; showing the Cup
          // name would be a post-boundary rename in medicoach, which is NOT safe through today's
          // group-save paths (see medicoach docs/league-migration-guide.md §9.8).
        },
      },
    },
    premierWomen: {
      competitions: {
        t20: crossPoolTopTwo('T20', [4, 4]),
        '30-over': {
          name: '30 Over',
          format: { type: 'league', rounds: 2, extraPhases: [], teamsPerGroup: 4 },
          cricketMatchFormat: 'T30',
          expectedGroupSizes: [4, 4],
          // The union is still defining the Promotion Women's League (per 1 Oct 2026), so
          // there is no relegation target yet. Restore this once the league exists:
          // positionRelegations: [
          //   { group: 2, position: 4, targetLeagueKey: 'promotion-women-s-league' },
          // ],
        },
      },
    },
    // 'promotion-women-s-league': the union is still defining this league (per 1 Oct 2026).
    // When it exists, add its recipe here, restore the Premier Women relegation above and
    // drop it from `excludeLeagues` below.
    'veterans-premier': {
      label: 'Veterans Premier',
      group: 'Overarching Leagues',
      district: 'All districts',
      competitions: {
        t20: crossPoolTopTwo('T20', [6, 6]),
        '30-over': {
          name: '30 Over',
          format: { type: 'league', rounds: 1, extraPhases: [], teamsPerGroup: 12 },
          cricketMatchFormat: 'T30',
          expectedGroupSizes: [12],
        },
      },
    },
    'veterans-promotion': {
      label: 'Veterans Promotion',
      group: 'Overarching Leagues',
      district: 'All districts',
      competitions: {
        t20: {
          name: 'T20',
          format: {
            type: 'groups_knockout',
            rounds: 1,
            extraPhases: [],
            teamsPerGroup: 8,
            // No advancePerGroup: only G1 1st and G2 2nd go through, which no per-group count
            // expresses. The explicit final fixture below is the truth.
          },
          cricketMatchFormat: 'T20',
          expectedGroupSizes: [7, 8],
          // Confirmed by the union 1 Oct 2026: the final G1 1st v G2 2nd (uneven 7+8 groups) is
          // intended.
          laterFixtures: [
            { slotId: 'final', stage: 'Final', round: 1, home: gp(1, 1), away: gp(2, 2) },
          ],
        },
        '30-over': {
          name: '30 Over',
          format: { type: 'league', rounds: 1, extraPhases: [], teamsPerGroup: 15 },
          cricketMatchFormat: 'T30',
          expectedGroupSizes: [15],
        },
      },
    },
  },
  // The smart-club catalogue still carries this key, but the league does not exist yet.
  excludeLeagues: {
    'promotion-women-s-league': 'not yet created by the union',
  },
};
