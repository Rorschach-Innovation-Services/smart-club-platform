/**
 * Golden tests — every league structure described in the KZNCU and EMCU documents,
 * expressed in the model and checked against the union's own hand-built spreadsheets.
 *
 * The spreadsheets are a free test oracle: someone produced them by hand, and they state
 * their own fixture counts ("Total fixtures: 30 (10 per team)"). If the engine reproduces
 * those numbers for all thirteen structures with no special cases, the decomposition in
 * ADR 0008 is at the right altitude. That is what this file is for — it is a design proof
 * as much as a regression net.
 */
import { describe, it, expect } from 'vitest';
import {
  crossPoolQualifiersFor,
  feedsCrossPool,
  materialiseStage,
  previewFit,
  resolveDesignCalendarId,
  stagesOffCalendar,
} from './structure';
import {
  crossPoolRounds,
  knockoutShape,
  knockoutRounds,
  roundRobinRounds,
  seedOrder,
  slotRefLabel,
  slotSource,
} from './formats';
import { groupSizes, labelFor, resolveEntrants } from './entrants';
import type { CompetitionStructure, EntrantSpec, SeasonCalendar, StageSpec } from '../types';

/** The union's real 2026/27 calendar. */
const CAL: SeasonCalendar = {
  id: 'cal',
  label: '2026/27',
  blocks: [
    { id: 'b1', label: 'Block 1', start: '2026-09-13', end: '2026-12-13' },
    { id: 'b2', label: 'Block 2', start: '2027-01-18', end: '2027-03-28' },
  ],
  breaks: [{ label: 'the mid-season break', start: '2026-12-14', end: '2027-01-17' }],
};

const WEEKLY_B1 = { blockId: 'b1', cadence: { kind: 'weekly' as const } };
const WEEKLY_B2 = { blockId: 'b2', cadence: { kind: 'weekly' as const } };

/** A minimal valid stage, for tests that care only about its schedule. */
const STAGE: StageSpec = {
  id: 's',
  name: 'Stage',
  format: { kind: 'round-robin', legs: 1 },
  entrants: { kind: 'all-registered' },
  schedule: WEEKLY_B1,
};

/** Confirmed 2026/27 groupings, verbatim from the source documents. */
const PREMIER_MEN_TOP_SIX = [
  'Delta',
  'Hollywoodbets Crusaders',
  'Amanzimtoti',
  'UKZN',
  'Hillary Malvern',
  'Harlequins',
];
const PREMIER_MEN_BOTTOM_SIX = [
  'Chatsworth Sporting',
  'Chatsworth United',
  'African Warriors',
  'Rhythm DHSOB',
  'Southern Natal',
  'KCCD Mancosa',
];
const PREMIER_WOMEN_TOP_FOUR = [
  'Rhythm DHSOB',
  'Lindelani',
  'African Warriors',
  'Chatsworth Sporting',
];
const PREMIER_WOMEN_BOTTOM_FOUR = ['Delta', 'Chatsworth United', 'KCCD', 'KwaMashu'];

const team = (n: number, prefix = 't') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

/** Fixtures per team, for cross-checking the spreadsheets' "N per team" claims. */
function perTeam(entrants: string[], fixtures: { home: string; away: string }[]): number[] {
  return entrants.map((t) => fixtures.filter((f) => f.home === t || f.away === t).length);
}

const ready = (m: ReturnType<typeof materialiseStage>) => {
  if (m.status !== 'ready') throw new Error(`expected ready, got: ${m.summary}`);
  return m;
};

describe('KZNCU Premier Men · 50 Over Red Ball — split league with mid-season swap', () => {
  // Stage 1: Top Six and Bottom Six each play a DOUBLE round robin — 10 matches per team,
  // 30 fixtures per group. The spreadsheet's two tabs both say "Total fixtures: 30".
  const doubleRound: StageSpec = {
    id: 'double-round',
    name: 'Double round',
    format: { kind: 'round-robin', legs: 2 },
    entrants: { kind: 'manual', groups: { kind: 'sizes', sizes: [6, 6] } },
    schedule: WEEKLY_B1,
    groupLabels: ['Top Six', 'Bottom Six'],
  };

  const stage1 = ready(
    materialiseStage({
      stage: doubleRound,
      calendar: CAL,
      context: { confirmed: [PREMIER_MEN_TOP_SIX, PREMIER_MEN_BOTTOM_SIX] },
    }),
  );

  it('produces 30 fixtures per group — 10 per team, matching the spreadsheet', () => {
    expect(stage1.groups).toHaveLength(2);
    for (const g of stage1.groups) {
      expect(g.fixtures).toHaveLength(30);
      expect(perTeam(g.entrants, g.fixtures)).toEqual([10, 10, 10, 10, 10, 10]);
    }
    expect(stage1.totalFixtures).toBe(60);
  });

  it('keeps the operator’s group names', () => {
    expect(stage1.groups.map((g) => g.label)).toEqual(['Top Six', 'Bottom Six']);
  });

  it('runs both groups over the same 10 weekends, inside Block 1', () => {
    const [top, bottom] = stage1.groups;
    expect(top.plan.dates).toEqual(bottom.plan.dates);
    expect(top.plan.dates[0]).toBe('2026-09-13');
    expect(top.plan.dates[9]).toBe('2026-11-15'); // exactly the spreadsheet's round 10
    expect(stage1.fits).toBe(true);
  });

  it('plays the second leg as the reverse of the first', () => {
    const top = stage1.groups[0];
    const r1 = top.fixtures.filter((f) => f.round === 1);
    const r6 = top.fixtures.filter((f) => f.round === 6);
    expect(r6.map((f) => [f.home, f.away])).toEqual(r1.map((f) => [f.away, f.home]));
  });

  // Stage 2: the reconstituted Top Six and Bottom Six play ONE more round robin —
  // 5 matches per team — after the 6th of the Top Six swaps with the 1st of the Bottom Six.
  const finalRound: StageSpec = {
    id: 'final-round',
    name: 'Final round',
    format: { kind: 'round-robin', legs: 1 },
    entrants: {
      kind: 'manual',
      groups: { kind: 'sizes', sizes: [6, 6] },
      derivedFrom: {
        rule: 'swap',
        fromStage: 'double-round',
        detail: 'Top Six 6th ↔ Bottom Six 1st, carrying the outgoing position’s points',
        carryPoints: true,
      },
    },
    schedule: WEEKLY_B2,
    groupLabels: ['Top Six', 'Bottom Six'],
  };

  it('waits for a human before generating the post-swap final round', () => {
    const m = materialiseStage({ stage: finalRound, calendar: CAL });
    expect(m.status).toBe('awaiting-entrants');
    if (m.status !== 'awaiting-entrants') return;
    // The rule is quoted back verbatim — that sentence IS the admin's instruction.
    expect(m.reason).toContain('Top Six 6th ↔ Bottom Six 1st');
    expect(m.reason).toContain('points');
  });

  it('generates 15 fixtures per group once the swap is confirmed', () => {
    // 6th of the Top Six (Harlequins) swaps with 1st of the Bottom Six (Chatsworth Sporting).
    const newTop = [...PREMIER_MEN_TOP_SIX.slice(0, 5), 'Chatsworth Sporting'];
    const newBottom = ['Harlequins', ...PREMIER_MEN_BOTTOM_SIX.slice(1)];
    const m = ready(
      materialiseStage({
        stage: finalRound,
        calendar: CAL,
        context: { confirmed: [newTop, newBottom] },
      }),
    );
    for (const g of m.groups) {
      expect(g.fixtures).toHaveLength(15);
      expect(perTeam(g.entrants, g.fixtures)).toEqual([5, 5, 5, 5, 5, 5]);
    }
    // Block 2, after the break — never in December or early January.
    expect(m.groups[0].plan.dates[0]).toBe('2027-01-18');
    expect(m.fits).toBe(true);
  });
});

describe('KZNCU Premier Men · T20 Pink Ball — seeded pools → cross-pool semis → final', () => {
  const pools: StageSpec = {
    id: 'pools',
    name: 'Group stage',
    format: { kind: 'round-robin', legs: 1 },
    entrants: { kind: 'seeded-split', groups: { kind: 'even', count: 2 }, method: 'snake' },
    schedule: WEEKLY_B1,
  };

  it('splits 12 seeded teams into two pools of six, 15 fixtures each', () => {
    const m = ready(
      materialiseStage({
        stage: pools,
        calendar: CAL,
        context: { seedOrder: [...PREMIER_MEN_TOP_SIX, ...PREMIER_MEN_BOTTOM_SIX] },
      }),
    );
    expect(m.groups.map((g) => g.entrants.length)).toEqual([6, 6]);
    for (const g of m.groups) expect(g.fixtures).toHaveLength(15);
  });

  it('snake-seeds so the top two seeds land in different pools', () => {
    const m = ready(
      materialiseStage({
        stage: pools,
        calendar: CAL,
        context: { seedOrder: [...PREMIER_MEN_TOP_SIX, ...PREMIER_MEN_BOTTOM_SIX] },
      }),
    );
    expect(m.groups[0].entrants[0]).toBe('Delta');
    expect(m.groups[1].entrants[0]).toBe('Hollywoodbets Crusaders');
  });

  it('pairs cross-pool semi-finals A1 v B2 and B1 v A2, then a final', () => {
    const semis: StageSpec = {
      id: 'semis',
      name: 'Cross-pool semi-finals',
      format: { kind: 'knockout', pairing: 'cross-pool' },
      entrants: { kind: 'manual' },
      schedule: WEEKLY_B2,
    };
    const m = ready(
      materialiseStage({
        stage: semis,
        calendar: CAL,
        // Pool finishing orders — only the top two of each qualify.
        crossPoolQualifiers: [
          ['A1', 'A2'],
          ['B1', 'B2'],
        ],
        context: { confirmed: [['A1', 'A2', 'B1', 'B2']] },
      }),
    );
    const fx = m.groups[0].fixtures;
    expect(fx).toHaveLength(3); // 2 semis + final
    expect([fx[0].home, fx[0].away]).toEqual(['A1', 'B2']);
    expect([fx[1].home, fx[1].away]).toEqual(['B1', 'A2']);
    // The final references the two semi winners rather than inventing teams.
    expect(slotSource(fx[2].home)).toEqual({ kind: 'winner', fixtureId: 'f1' });
    expect(slotSource(fx[2].away)).toEqual({ kind: 'winner', fixtureId: 'f2' });
  });

  // The qualifiers must be exactly the stage's entrants. Passing the POOLS' whole rosters
  // — the obvious wiring, and the one that shipped briefly — builds a bracket over the
  // first two clubs in each pool, who are sides this series does not contain: the clubs
  // that actually qualified would open the portal to a series with none of their fixtures
  // in it, and the admin drilldown would read "Unknown team v Unknown team".
  it('ignores qualifiers that name sides outside the stage entrants', () => {
    const m = ready(
      materialiseStage({
        stage: {
          id: 'semis',
          name: 'Cross-pool semi-finals',
          format: { kind: 'knockout', pairing: 'cross-pool' },
          entrants: { kind: 'manual' },
          schedule: WEEKLY_B2,
        },
        calendar: CAL,
        // Whole 6-team pools, not the four qualifiers.
        crossPoolQualifiers: [
          ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'],
          ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'],
        ],
        context: { confirmed: [['A1', 'A2', 'B1', 'B2']] },
      }),
    );
    const named = m.groups[0].fixtures.flatMap((f) => [f.home, f.away]).filter((t) => !!t);
    const outsiders = named.filter((t) => !t.startsWith('win:') && !t.startsWith('lose:'));
    // Falls back to a seeded bracket over the real entrants — wrong in PAIRING, never
    // wrong in personnel.
    expect(new Set(outsiders)).toEqual(new Set(['A1', 'A2', 'B1', 'B2']));
  });
});

describe('KZNCU Premier Women · 30 Over Pink Ball', () => {
  const stage: StageSpec = {
    id: 'first-double',
    name: 'First double round',
    format: { kind: 'round-robin', legs: 2 },
    entrants: { kind: 'manual', groups: { kind: 'sizes', sizes: [4, 4] } },
    schedule: WEEKLY_B1,
    groupLabels: ['Top Four', 'Bottom Four'],
  };

  // The spreadsheet's two 30-Over tabs each say "Total fixtures: 12" — 6 per team.
  it('produces 12 fixtures per group of four — 6 per team', () => {
    const m = ready(
      materialiseStage({
        stage,
        calendar: CAL,
        context: { confirmed: [PREMIER_WOMEN_TOP_FOUR, PREMIER_WOMEN_BOTTOM_FOUR] },
      }),
    );
    for (const g of m.groups) {
      expect(g.fixtures).toHaveLength(12);
      expect(perTeam(g.entrants, g.fixtures)).toEqual([6, 6, 6, 6]);
    }
    expect(m.groups[0].plan.dates[0]).toBe('2026-09-13');
  });

  it('reaches 12 matches per team across both double rounds', () => {
    // Second double round after the swap — same shape, so 6 + 6 = 12 per team.
    const second = ready(
      materialiseStage({
        stage: { ...stage, id: 'second-double', schedule: WEEKLY_B2 },
        calendar: CAL,
        context: { confirmed: [PREMIER_WOMEN_TOP_FOUR, PREMIER_WOMEN_BOTTOM_FOUR] },
      }),
    );
    expect(perTeam(second.groups[0].entrants, second.groups[0].fixtures)).toEqual([6, 6, 6, 6]);
  });
});

describe('KZNCU Premier Women · T20 Pink Ball — two pools of four', () => {
  it('produces 6 fixtures per pool, matching the spreadsheet', () => {
    const m = ready(
      materialiseStage({
        stage: {
          id: 't20',
          name: 'T20 pools',
          format: { kind: 'round-robin', legs: 1 },
          entrants: { kind: 'seeded-split', groups: { kind: 'even', count: 2 }, method: 'blocks' },
          schedule: WEEKLY_B1,
        },
        calendar: CAL,
        context: { seedOrder: [...PREMIER_WOMEN_TOP_FOUR, ...PREMIER_WOMEN_BOTTOM_FOUR] },
      }),
    );
    for (const g of m.groups) expect(g.fixtures).toHaveLength(6);
    // 'blocks' keeps the confirmed Top Four together — the document's Option 2.
    expect(m.groups[0].entrants).toEqual(PREMIER_WOMEN_TOP_FOUR);
  });
});

describe('KZNCU Promotion Men · 50 Over — Top 10 / Bottom 10 streams', () => {
  const streams: StageSpec = {
    id: 'streams',
    name: 'Stream round robin',
    format: { kind: 'round-robin', legs: 1 },
    entrants: { kind: 'manual', groups: { kind: 'sizes', sizes: [10, 10] } },
    schedule: WEEKLY_B1,
    groupLabels: ['Top 10', 'Bottom 10'],
  };

  // "Single round only within each stream — 9 matches per team for a 10-team group."
  it('produces 45 fixtures per stream — 9 per team', () => {
    const m = ready(
      materialiseStage({
        stage: streams,
        calendar: CAL,
        context: { confirmed: [team(10, 'top'), team(10, 'bot')] },
      }),
    );
    for (const g of m.groups) {
      expect(g.fixtures).toHaveLength(45);
      expect(perTeam(g.entrants, g.fixtures)).toEqual(Array(10).fill(9));
    }
    expect(m.totalFixtures).toBe(90);
  });

  it('splits the reconstituted Top 10 into two groups of five, 4 matches per team', () => {
    const m = ready(
      materialiseStage({
        stage: {
          id: 'top-ten-split',
          name: 'Top 10 final stage',
          format: { kind: 'round-robin', legs: 1 },
          entrants: { kind: 'seeded-split', groups: { kind: 'even', count: 2 }, method: 'blocks' },
          schedule: WEEKLY_B2,
        },
        calendar: CAL,
        context: { seedOrder: team(10, 'top') },
      }),
    );
    expect(m.groups.map((g) => g.entrants.length)).toEqual([5, 5]);
    for (const g of m.groups) {
      expect(g.fixtures).toHaveLength(10);
      expect(perTeam(g.entrants, g.fixtures)).toEqual([4, 4, 4, 4, 4]);
    }
  });
});

describe('KZNCU Promotion Men · Hollywoodbets Kingsmead Cup — 9-team knockout', () => {
  // "The team finishing last in the Bottom 10 does not qualify, leaving 9 teams; one
  //  preliminary match reduces this to 8 for a straight knockout."
  const cup: StageSpec = {
    id: 'kingsmead',
    name: 'Kingsmead Cup',
    format: { kind: 'knockout', pairing: 'seeded' },
    entrants: { kind: 'manual' },
    schedule: WEEKLY_B2,
  };

  const m = ready(
    materialiseStage({ stage: cup, calendar: CAL, context: { confirmed: [team(9, 'seed')] } }),
  );
  const fx = m.groups[0].fixtures;

  it('derives one preliminary, then quarter-finals, semi-finals and a final', () => {
    expect(knockoutShape(9)).toMatchObject({ mainDraw: 8, preliminaries: 1, directEntries: 7 });
    expect(fx).toHaveLength(1 + 4 + 2 + 1);
    expect(fx.filter((f) => f.round === 1)).toHaveLength(1); // preliminary
    expect(fx.filter((f) => f.round === 2)).toHaveLength(4); // quarter-finals
    expect(fx.filter((f) => f.round === 3)).toHaveLength(2); // semi-finals
    expect(fx.filter((f) => f.round === 4)).toHaveLength(1); // final
  });

  it('plays the two lowest seeds in the preliminary — exactly the spreadsheet’s 8 v 9', () => {
    expect([fx[0].home, fx[0].away]).toEqual(['seed8', 'seed9']);
  });

  it('sends the preliminary winner to meet the top seed, and pairs 4v5, 3v6, 2v7', () => {
    const qf = fx.filter((f) => f.round === 2);
    // Top seed meets whoever survives the preliminary.
    expect([qf[0].home, slotSource(qf[0].away)]).toEqual([
      'seed1',
      { kind: 'winner', fixtureId: 'f1' },
    ]);
    // The remaining three quarter-finals are exactly the spreadsheet's. Compared as a
    // SET: which seeds meet is the rule, the order they're listed in is not — and the
    // standard bracket emits them in a different order to the hand-built sheet.
    const rest = qf.slice(1).map((f) => `${f.home} v ${f.away}`);
    expect(rest.sort()).toEqual(['seed2 v seed7', 'seed3 v seed6', 'seed4 v seed5']);
  });

  // The source spreadsheet pairs its semis QF1 v QF4, which would let seeds 1 and 2 meet
  // before the final. That sheet is flagged low-confidence; we use the standard bracket.
  it('keeps the top two seeds apart until the final', () => {
    const semis = fx.filter((f) => f.round === 3);
    expect(slotSource(semis[0].home)?.fixtureId).toBe('f2'); // QF1 (seed 1's side)
    expect(slotSource(semis[0].away)?.fixtureId).toBe('f3'); // QF2 — not seed 2's side
    expect(slotSource(semis[1].home)?.fixtureId).toBe('f4');
    expect(slotSource(semis[1].away)?.fixtureId).toBe('f5'); // QF4 (seed 2's side)
  });

  // Naming counts BACK from the final, so a preliminary round shifts every label if the
  // bracket shape is inferred from max(round) alone: this 9-team cup's play-in would be
  // announced as a "Round of 16" it doesn't have.
  it('names the play-in a preliminary, not a round of 16', () => {
    const final = fx.find((f) => f.round === 4)!;
    expect(slotRefLabel(final.home, fx)).toBe('Winner of Semi-final 1');
    const qf1 = fx.find((f) => f.round === 2)!;
    expect(slotRefLabel(qf1.away, fx)).toBe('Winner of Preliminary round');
  });
});

describe('knockout round naming', () => {
  const label = (entrants: number, opts?: { thirdPlace?: boolean }) => {
    const teams = Array.from({ length: entrants }, (_, i) => `seed${i + 1}`);
    const rounds = knockoutRounds(teams, opts);
    // Flatten to the {id, round} shape slotRefLabel reads, numbering ids exactly as
    // fixturesFromDates does so `win:fN` resolves.
    let n = 0;
    const fx = rounds.flatMap((pairs, r) =>
      pairs.map(([home, away]) => ({ id: `f${++n}`, round: r + 1, home, away })),
    );
    return { fx, of: (id: string) => slotRefLabel(id, fx) };
  };

  it('names the final the FINAL when a third-place playoff follows it', () => {
    // The playoff is appended as an extra round, so counting back from max(round)
    // demotes the final to a semi-final and the semis to quarters.
    const { fx, of } = label(4, { thirdPlace: true });
    const final = fx.find((f) => f.round === 2)!;
    expect(of(final.home)).toBe('Winner of Semi-final 1');
    expect(of(final.away)).toBe('Winner of Semi-final 2');
    const playoff = fx.find((f) => f.round === 3)!;
    expect(of(playoff.home)).toBe('Loser of Semi-final 1');
  });

  it('names rounds correctly with no playoff and no preliminary', () => {
    const { fx, of } = label(8);
    expect(of(fx.find((f) => f.round === 3)!.home)).toBe('Winner of Semi-final 1');
    expect(of(fx.find((f) => f.round === 2)!.home)).toBe('Winner of Quarter-final 1');
  });

  it('reaches back past the quarters for a bigger draw', () => {
    const { fx, of } = label(16);
    expect(of(fx.find((f) => f.round === 2)!.home)).toBe('Winner of Round of 16 1');
  });

  // The final is the fixture nothing else references, and the playoff is the one pairing
  // two `lose:` refs — read from the bracket GRAPH. An earlier version inferred the
  // playoff from "two consecutive single-fixture rounds", which a BYE produces: these
  // three shapes each have one, and each was named backwards.
  it('names a 3-team bracket (bye) as preliminary → final, not final → playoff', () => {
    const { fx, of } = label(3);
    expect(fx.map((f) => f.round)).toEqual([1, 2]); // one fixture in each round
    expect(of(fx[1].away)).toBe('Winner of Preliminary round');
  });

  it('handles an odd pool count in a cross-pool draw', () => {
    let n = 0;
    const fx = crossPoolRounds([['a1'], ['b1'], ['c1']]).flatMap((pairs, r) =>
      pairs.map(([home, away]) => ({ id: `f${++n}`, round: r + 1, home, away })),
    );
    // f1 is the play-in between two pool winners; f2 is the final against the third.
    expect(slotRefLabel(fx[1].home, fx)).toBe('Winner of Preliminary round');
  });

  it('still finds the final when the list carries no slot refs at all', () => {
    // A flat first round with nothing to reference — fall back to the last round rather
    // than throwing or reporting round 0.
    const fx = [
      { id: 'f1', round: 1, home: 'a', away: 'b' },
      { id: 'f2', round: 1, home: 'c', away: 'd' },
    ];
    expect(slotRefLabel('win:f1', fx)).toBe('Winner of Final 1');
  });
});

describe('KZNCU Promotion Men · T20 Pink Ball — four pools', () => {
  it('produces 10 fixtures per pool of five', () => {
    const m = ready(
      materialiseStage({
        stage: {
          id: 't20-pools',
          name: 'T20 pools',
          format: { kind: 'round-robin', legs: 1 },
          entrants: { kind: 'seeded-split', groups: { kind: 'even', count: 4 }, method: 'snake' },
          schedule: WEEKLY_B1,
        },
        calendar: CAL,
        context: { seedOrder: team(20) },
      }),
    );
    expect(m.groups.map((g) => g.entrants.length)).toEqual([5, 5, 5, 5]);
    for (const g of m.groups) expect(g.fixtures).toHaveLength(10);
  });

  // The source document lists 3 pools of 5 and 1 of 4 for 19 teams, and flags the
  // discrepancy. Explicit sizes are the only honest way to express that.
  it('expresses the document’s 19-team 5+5+5+4 split without rounding it away', () => {
    const m = ready(
      materialiseStage({
        stage: {
          id: 't20-19',
          name: 'T20 pools (19 teams)',
          format: { kind: 'round-robin', legs: 1 },
          entrants: {
            kind: 'seeded-split',
            groups: { kind: 'sizes', sizes: [5, 5, 5, 4] },
            method: 'blocks',
          },
          schedule: WEEKLY_B1,
        },
        calendar: CAL,
        context: { seedOrder: team(19) },
      }),
    );
    expect(m.groups.map((g) => g.entrants.length)).toEqual([5, 5, 5, 4]);
    expect(m.groups.map((g) => g.fixtures.length)).toEqual([10, 10, 10, 6]);
  });
});

describe('EMCU divisions — same structure, different cadence', () => {
  const flat = (id: string, schedule: StageSpec['schedule']): StageSpec => ({
    id,
    name: id,
    format: { kind: 'round-robin', legs: 1 },
    entrants: { kind: 'all-registered' },
    schedule,
  });

  it('Division 1 / 2 — weekly', () => {
    const m = ready(
      materialiseStage({
        stage: flat('div1', WEEKLY_B1),
        calendar: CAL,
        context: { registered: team(8) },
      }),
    );
    expect(m.groups[0].fixtures).toHaveLength(28);
    expect(m.groups[0].plan.dates.slice(0, 2)).toEqual(['2026-09-13', '2026-09-20']);
  });

  it('Division 3 Stream 2 / Division 4 — every two weeks', () => {
    const m = ready(
      materialiseStage({
        stage: flat('div4', { blockId: 'b1', cadence: { kind: 'every-n-weeks', n: 2 } }),
        calendar: CAL,
        context: { registered: team(8) },
      }),
    );
    expect(m.groups[0].plan.dates.slice(0, 2)).toEqual(['2026-09-13', '2026-09-27']);
  });

  it('Division 5 — Saturdays only', () => {
    const m = ready(
      materialiseStage({
        stage: flat('div5', { blockId: 'b1', cadence: { kind: 'weekdays', days: [6] } }),
        calendar: CAL,
        context: { registered: team(6) },
      }),
    );
    expect(m.groups[0].plan.dates[0]).toBe('2026-09-19'); // first Saturday in the block
  });

  // A 12-team bi-weekly division needs 11 rounds over 20 weeks; Block 1 is 13.
  it('catches a bi-weekly division that overflows its block', () => {
    const m = materialiseStage({
      stage: flat('div4-big', { blockId: 'b1', cadence: { kind: 'every-n-weeks', n: 2 } }),
      calendar: CAL,
      context: { registered: team(12) },
    });
    expect(m.status).toBe('ready');
    if (m.status !== 'ready') return;
    expect(m.fits).toBe(false);
    expect(m.summary).toContain("don't fit");
  });
});

describe('Junior leagues — generated up front, activated in the second half', () => {
  it('schedules U11/U13 in Block 2 with a delayed activation date', () => {
    const stage: StageSpec = {
      id: 'u13',
      name: 'Under 13',
      format: { kind: 'round-robin', legs: 1 },
      entrants: { kind: 'all-registered' },
      schedule: { ...WEEKLY_B2, activateFrom: '2027-01-18' },
    };
    const m = ready(materialiseStage({ stage, calendar: CAL, context: { registered: team(6) } }));
    expect(m.groups[0].plan.dates[0]).toBe('2027-01-18');
    expect(m.groups[0].fixtures.every((f) => f.date >= '2027-01-18')).toBe(true);
  });
});

describe('design-time preview — before any team exists', () => {
  it('answers "does this fit?" from a hypothetical group size', () => {
    const stage: StageSpec = {
      id: 'x',
      name: 'x',
      format: { kind: 'round-robin', legs: 2 },
      entrants: { kind: 'all-registered' },
      schedule: WEEKLY_B1,
    };
    expect(previewFit(stage, CAL, 6).fits).toBe(true); // 10 rounds
    expect(previewFit(stage, CAL, 12).fits).toBe(false); // 22 rounds — Block 1 has 13
  });
});

describe('cross-pool wiring', () => {
  const POOLS: StageSpec = {
    id: 'pools',
    name: 'Pools',
    format: { kind: 'round-robin', legs: 1 },
    entrants: { kind: 'seeded-split', method: 'snake', groups: { kind: 'even', count: 2 } },
    schedule: WEEKLY_B1,
  };
  const SEMIS: StageSpec = {
    id: 'semis',
    name: 'Semi-finals',
    format: { kind: 'knockout', pairing: 'cross-pool' },
    entrants: { kind: 'manual' },
    schedule: WEEKLY_B2,
  };
  const run = (poolGroups: string[][], knockoutEntrants: string[]) =>
    ({
      id: 'r',
      leagueKey: 'l',
      competitionId: 'c',
      seasonLabel: '2026/27',
      structureSnapshot: { id: 's', name: 's', version: 1, stages: [POOLS, SEMIS] },
      calendarSnapshot: CAL,
      version: 1,
      stages: [
        {
          specId: 'pools',
          status: 'generated' as const,
          groups: poolGroups.map((entrants, i) => ({
            id: `g${i + 1}`,
            label: `P${i + 1}`,
            entrants,
          })),
        },
        {
          specId: 'semis',
          status: 'ready' as const,
          groups: [{ id: 'g1', label: 'Semis', entrants: knockoutEntrants }],
        },
      ],
    }) as never;

  it('asks for finishing positions only on a stage that feeds a cross-pool draw', () => {
    expect(feedsCrossPool(POOLS, [POOLS, SEMIS])).toBe(true);
    expect(feedsCrossPool(SEMIS, [POOLS, SEMIS])).toBe(false);
    // A pool stage followed by an ordinary round robin needs no ranking.
    expect(
      feedsCrossPool(POOLS, [POOLS, { ...SEMIS, format: { kind: 'round-robin', legs: 1 } }]),
    ).toBe(false);
  });

  it('takes WHO from the knockout stage and WHICH POOL, in order, from the one before', () => {
    const q = crossPoolQualifiersFor(
      SEMIS,
      POOLS,
      run(
        [
          ['a1', 'a2', 'a3'],
          ['b1', 'b2', 'b3'],
        ],
        ['a1', 'a2', 'b1', 'b2'],
      ),
    );
    // Pool order preserved, non-qualifiers filtered out.
    expect(q).toEqual([
      ['a1', 'a2'],
      ['b1', 'b2'],
    ]);
  });

  it('falls back when a qualifier played in no pool', () => {
    // The admin added a side that never played the pool stage — the draw would silently
    // drop it, so refuse and let the seeded bracket take the whole field.
    const q = crossPoolQualifiersFor(
      SEMIS,
      POOLS,
      run(
        [
          ['a1', 'a2'],
          ['b1', 'b2'],
        ],
        ['a1', 'b1', 'stranger'],
      ),
    );
    expect(q).toBeUndefined();
  });

  it('falls back before the knockout stage is confirmed', () => {
    expect(
      crossPoolQualifiersFor(
        SEMIS,
        POOLS,
        run(
          [
            ['a1', 'a2'],
            ['b1', 'b2'],
          ],
          [],
        ),
      ),
    ).toBeUndefined();
  });

  // `crossPoolRounds` takes a fixed shape — one per pool, or exactly two per pool — so an
  // uneven qualification rule ("winners plus the best runner-up") loses people. A club
  // left out of the bracket still appears in the series' team list, so it would open the
  // portal to a season with none of its own fixtures.
  it('emits no bracket rather than a lossy one when qualification is uneven', () => {
    expect(crossPoolRounds([['A1', 'A2'], ['B1'], ['C1']])).toEqual([]);
    expect(
      crossPoolRounds([
        ['A1', 'A2', 'A3'],
        ['B1', 'B2', 'B3'],
      ]),
    ).toEqual([]);
    // The shapes it CAN express are unaffected.
    expect(
      crossPoolRounds([
        ['A1', 'A2'],
        ['B1', 'B2'],
      ]).flat(),
    ).toHaveLength(3);
    expect(crossPoolRounds([['A1'], ['B1'], ['C1'], ['D1']]).flat()).toHaveLength(3);
  });

  // …and the REFUSAL must reach a seeded bracket, not an empty stage. Asserting only
  // that `crossPoolRounds` returns [] let a version ship where `roundsForFormat` handed
  // the empty result straight through: the stage generated ZERO fixtures, reported
  // `fits: true`, and offered a green "Generate 0 fixtures" button.
  const semisOver = (qualifiers: string[][], entrants: string[]) =>
    materialiseStage({
      stage: {
        id: 'semis',
        name: 'Semis',
        format: { kind: 'knockout', pairing: 'cross-pool' },
        entrants: { kind: 'manual' },
        schedule: WEEKLY_B2,
      },
      calendar: CAL,
      crossPoolQualifiers: qualifiers,
      context: { confirmed: [entrants] },
    });

  it('falls back to a seeded bracket — never an empty stage — and says it did', () => {
    // "Top two from A and B, plus the winner of C" — a routine qualification rule.
    const m = ready(
      semisOver([['a1', 'a2'], ['b1', 'b2'], ['c1']], ['a1', 'a2', 'b1', 'b2', 'c1']),
    );
    expect(m.totalFixtures).toBeGreaterThan(0);
    expect(m.crossPoolFallback).toBeTruthy();
    // Everyone who qualified is in it.
    const named = new Set(
      m.groups[0].fixtures.flatMap((f) => [f.home, f.away]).filter((t) => !t.startsWith('win:')),
    );
    expect(named).toEqual(new Set(['a1', 'a2', 'b1', 'b2', 'c1']));
  });

  it('does not cry fallback on the simplest cross-pool structure there is', () => {
    // Two pools, one qualifier each, straight final. The cross-pool bracket and the
    // seeded one are identical here — inferring the branch by diffing them reported a
    // fallback that never happened and sent the operator to fix correct positions.
    const m = ready(semisOver([['a1'], ['b1']], ['a1', 'b1']));
    expect(m.crossPoolFallback).toBeUndefined();
    expect(m.groups[0].fixtures.map((f) => [f.home, f.away])).toEqual([['a1', 'b1']]);
  });
});

describe('a confirmed grouping wins over a derived one', () => {
  // "Edit entrants" is offered on every ready stage. Reading `confirmed` only in the
  // `manual` resolver made that button a silent no-op on the two commonest stage types:
  // the PATCH succeeded, the modal closed, and the derived grouping came straight back.
  it('overrides all-registered', () => {
    const r = resolveEntrants(
      { kind: 'all-registered' },
      { registered: ['a', 'b', 'c', 'd'], confirmed: [['a', 'b']] },
    );
    expect(r.status).toBe('resolved');
    if (r.status !== 'resolved') return;
    expect(r.groups.map((g) => g.entrants)).toEqual([['a', 'b']]);
  });

  it('overrides seeded-split, including a pure reorder', () => {
    const r = resolveEntrants(
      { kind: 'seeded-split', method: 'blocks', groups: { kind: 'even', count: 2 } },
      {
        seedOrder: ['a', 'b', 'c', 'd'],
        confirmed: [
          ['b', 'a'],
          ['d', 'c'],
        ],
      },
    );
    if (r.status !== 'resolved') throw new Error('expected resolved');
    // Order matters — it is the finishing order a cross-pool draw reads.
    expect(r.groups.map((g) => g.entrants)).toEqual([
      ['b', 'a'],
      ['d', 'c'],
    ]);
  });

  it('still derives when nothing has been confirmed', () => {
    const r = resolveEntrants(
      { kind: 'all-registered' },
      { registered: ['a', 'b'], confirmed: [] },
    );
    if (r.status !== 'resolved') throw new Error('expected resolved');
    expect(r.groups[0].entrants).toEqual(['a', 'b']);
  });
});

describe('readiness is judged on entrants, never on fixture count', () => {
  // `roundsForFormat({kind:'manual'})` returns [] BY DESIGN — it is the ADR's escape
  // hatch. Judging on fixture count made every hand-entered stage permanently
  // ungeneratable, with a summary that stated something false about the data. Judging on
  // entrants is right for every format, manual included.
  it('leaves a manual stage ready with sides and no generated fixtures', () => {
    const m = materialiseStage({
      stage: {
        id: 'hand',
        name: 'Hand-entered',
        format: { kind: 'manual' },
        entrants: { kind: 'all-registered' },
        schedule: WEEKLY_B1,
      },
      calendar: CAL,
      context: { registered: team(4) },
    });
    expect(m.status).toBe('ready');
    if (m.status !== 'ready') return;
    expect(m.groups[0].fixtures).toHaveLength(0);
    expect(m.fits).toBe(true);
  });

  // …but an empty group is empty whatever the format. Exempting `manual` from the check
  // ENTIRELY (rather than from the fixture-count reasoning) let it through to a series
  // with no dates, which is the empty-gsi1sk trap one test below.
  it('still catches an empty group in a manual stage', () => {
    const m = materialiseStage({
      stage: {
        id: 'hand2',
        name: 'Hand-entered',
        format: { kind: 'manual' },
        entrants: { kind: 'manual' },
        schedule: WEEKLY_B1,
        groupLabels: ['Group A', 'Group B'],
      },
      calendar: CAL,
      context: { confirmed: [team(2), []] },
    });
    if (m.status !== 'ready') throw new Error('expected ready');
    expect(m.fits).toBe(false);
    expect(m.summary).toContain('Group B');
  });
});

describe('a group with no sides is not "ready to generate"', () => {
  // An empty group produces zero rounds, and zero rounds "fit" any block — so without
  // this the stage shows Generate, and the resulting series carries an empty startDate,
  // which becomes an empty gsi1sk that real DynamoDB rejects part-way through the loop.
  it('reports the stage as not fitting, and names the empty group', () => {
    const m = materialiseStage({
      stage: {
        id: 'split',
        name: 'Split',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'manual' },
        schedule: WEEKLY_B1,
        groupLabels: ['Top Six', 'Bottom Six'],
      },
      calendar: CAL,
      context: { confirmed: [team(6), []] }, // second group confirmed with nobody in it
    });
    expect(m.status).toBe('ready');
    if (m.status !== 'ready') return;
    expect(m.groups[1].fixtures).toHaveLength(0);
    expect(m.fits).toBe(false);
    expect(m.summary).toContain('Bottom Six');
    expect(m.summary).toContain('no sides');
  });

  // Judged on ENTRANTS, so the group named is the one actually at fault. Judged on
  // fixture count it named whichever group came first — including a group of one, which
  // also generates nothing, so the message said "has no sides" about a group with a side.
  it('names the group that is actually empty, not the first with no fixtures', () => {
    const m = materialiseStage({
      stage: {
        id: 'split4',
        name: 'Split',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'seeded-split', method: 'blocks', groups: { kind: 'even', count: 4 } },
        schedule: WEEKLY_B1,
      },
      calendar: CAL,
      context: { registered: team(3) }, // A:1 B:1 C:1 D:0
    });
    if (m.status !== 'ready') throw new Error('expected ready');
    expect(m.fits).toBe(false);
    // Group A has one side, so it is the first offender and gets named — with the RIGHT
    // reason for its own state.
    expect(m.summary).toContain('Group A');
    expect(m.summary).toContain('one side');
  });
});

describe('format and entrant primitives', () => {
  it('seedOrder builds the standard bracket', () => {
    expect(seedOrder(2)).toEqual([0, 1]);
    expect(seedOrder(4)).toEqual([0, 3, 1, 2]);
    expect(seedOrder(8)).toEqual([0, 7, 3, 4, 1, 6, 2, 5]);
  });

  it('knockoutShape trims any field to a power of two', () => {
    expect(knockoutShape(8)).toMatchObject({ mainDraw: 8, preliminaries: 0 });
    expect(knockoutShape(9)).toMatchObject({ mainDraw: 8, preliminaries: 1 });
    expect(knockoutShape(12)).toMatchObject({ mainDraw: 8, preliminaries: 4 });
    expect(knockoutShape(1)).toMatchObject({ mainDraw: 0, preliminaries: 0 });
  });

  it('a power-of-two field needs no preliminary', () => {
    const rounds = knockoutRounds(team(8, 'seed'));
    expect(rounds.map((r) => r.length)).toEqual([4, 2, 1]);
    expect(rounds[0][0]).toEqual(['seed1', 'seed8']);
  });

  it('interleaved legs put the return fixture straight after the original', () => {
    const mirrored = roundRobinRounds(['a', 'b', 'c', 'd'], 2, 'mirrored');
    const interleaved = roundRobinRounds(['a', 'b', 'c', 'd'], 2, 'interleaved');
    expect(mirrored).toHaveLength(6);
    expect(interleaved).toHaveLength(6);
    expect(interleaved[1]).toEqual(mirrored[0].map(([h, a]) => [a, h]));
  });

  it('groupSizes spreads a remainder across the earlier groups', () => {
    expect(groupSizes({ kind: 'even', count: 4 }, 19)).toEqual([5, 5, 5, 4]);
    expect(groupSizes({ kind: 'even', count: 2 }, 12)).toEqual([6, 6]);
    expect(groupSizes({ kind: 'sizes', sizes: [10, 10] }, 20)).toEqual([10, 10]);
  });

  it('an odd split point is expressible and keeps every team', () => {
    // The documents ask for a warning on "Top 6 / Bottom 5"; the model must at least
    // represent it without silently dropping the odd team.
    const r = resolveEntrants(
      { kind: 'seeded-split', groups: { kind: 'sizes', sizes: [6, 5] }, method: 'blocks' },
      { seedOrder: team(11) },
    );
    expect(r.status).toBe('resolved');
    if (r.status !== 'resolved') return;
    expect(r.groups.map((g) => g.entrants.length)).toEqual([6, 5]);
    expect(r.groups.flatMap((g) => g.entrants)).toHaveLength(11);
  });

  // Review finding: explicit sizes go stale the moment a club affiliates, and the two
  // distributions disagreed about the leftover — blocks overfilled the last group while
  // snake silently DELETED the remainder, so a side never played a match.
  it('never drops an entrant when explicit sizes are stale', () => {
    for (const method of ['blocks', 'snake'] as const) {
      const r = resolveEntrants(
        { kind: 'seeded-split', groups: { kind: 'sizes', sizes: [6, 6] }, method },
        { seedOrder: team(13) },
      );
      expect(r.status, method).toBe('resolved');
      if (r.status !== 'resolved') continue;
      const placed = r.groups.flatMap((g) => g.entrants);
      expect(placed, method).toHaveLength(13);
      expect(new Set(placed).size, method).toBe(13);
    }
  });

  it('reconciles a short size list onto the last group, visibly', () => {
    expect(groupSizes({ kind: 'sizes', sizes: [6, 6] }, 13)).toEqual([6, 7]);
    expect(groupSizes({ kind: 'sizes', sizes: [10, 10] }, 18)).toEqual([10, 8]);
  });

  // Persistable operator config must never crash the admin's season view.
  it('survives a group plan with no usable sizes', () => {
    expect(groupSizes({ kind: 'sizes', sizes: [] }, 12)).toEqual([12]);
    expect(groupSizes({ kind: 'sizes', sizes: [-1, 0] }, 12)).toEqual([12]);
    for (const method of ['blocks', 'snake'] as const) {
      const r = resolveEntrants(
        { kind: 'seeded-split', groups: { kind: 'sizes', sizes: [-1, 0] }, method },
        { seedOrder: team(12) },
      );
      expect(r.status, method).toBe('resolved');
      if (r.status !== 'resolved') continue;
      expect(
        r.groups.flatMap((g) => g.entrants),
        method,
      ).toHaveLength(12);
    }
  });

  it('an odd group carries a bye rather than dropping a team', () => {
    const m = ready(
      materialiseStage({
        stage: {
          id: 'odd',
          name: 'Odd',
          format: { kind: 'round-robin', legs: 1 },
          entrants: { kind: 'all-registered' },
          schedule: WEEKLY_B1,
        },
        calendar: CAL,
        context: { registered: team(5) },
      }),
    );
    expect(m.groups[0].fixtures).toHaveLength(10); // C(5,2)
    expect(perTeam(m.groups[0].entrants, m.groups[0].fixtures)).toEqual([4, 4, 4, 4, 4]);
  });

  it('refuses to generate a league of one', () => {
    const m = materialiseStage({
      stage: {
        id: 'solo',
        name: 'Solo',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'all-registered' },
        schedule: WEEKLY_B1,
      },
      calendar: CAL,
      context: { registered: ['only'] },
    });
    expect(m.status).toBe('awaiting-entrants');
  });
});

describe('a standings-dependent stage prefills from the stage it draws from', () => {
  /*
   * The KZNCU swap: 6 teams split 3/3, then ONE side goes down and one comes up. The
   * suggestion has to start from where stage 1 actually ended, not from the registered
   * list — whose order is alphabetical and means nothing at this point in the season.
   *
   * With the registered list as the pool, a Top Six of [harlequins, ilembe, ukzn] gets a
   * stage-2 suggestion of [chatsworth, clares, crusaders]: the exact inverse, and an
   * admin who accepts it relegates the whole top group. This only looked correct in
   * testing because the sample clubs happened to be alphabetical in the first season.
   */
  const REGISTERED = ['chatsworth', 'clares', 'crusaders', 'harlequins', 'ilembe', 'ukzn'];
  const SWAP: EntrantSpec = {
    kind: 'manual',
    groups: { kind: 'sizes', sizes: [3, 3] },
    derivedFrom: {
      rule: 'swap',
      fromStage: 'double-round',
      detail: 'Top Six 3rd ↔ Bottom Six 1st',
      carryPoints: true,
    },
  };
  const PRIOR = [
    ['harlequins', 'ilembe', 'ukzn'],
    ['chatsworth', 'clares', 'crusaders'],
  ];

  it('carries the prior stage forward instead of re-blocking the alphabet', () => {
    const r = resolveEntrants(SWAP, {
      registered: REGISTERED,
      seedOrder: REGISTERED,
      priorGroups: PRIOR,
      labels: ['Top Six', 'Bottom Six'],
    });
    expect(r.status).toBe('awaiting');
    if (r.status !== 'awaiting') return;
    expect(r.prefill.map((g) => g.entrants)).toEqual(PRIOR);
  });

  it('drops a side that has withdrawn since the previous stage', () => {
    const r = resolveEntrants(SWAP, {
      registered: REGISTERED.filter((t) => t !== 'ukzn'),
      priorGroups: PRIOR,
      labels: ['Top Six', 'Bottom Six'],
    });
    if (r.status !== 'awaiting') throw new Error('expected awaiting');
    expect(r.prefill.flatMap((g) => g.entrants)).not.toContain('ukzn');
  });

  it('appends a side registered since, rather than silently losing it', () => {
    const r = resolveEntrants(SWAP, {
      registered: [...REGISTERED, 'newcomer'],
      priorGroups: PRIOR,
      labels: ['Top Six', 'Bottom Six'],
    });
    if (r.status !== 'awaiting') throw new Error('expected awaiting');
    expect(r.prefill.flatMap((g) => g.entrants)).toContain('newcomer');
  });

  it('falls back to the registered list when the prior stage is unconfirmed', () => {
    const r = resolveEntrants(SWAP, {
      registered: REGISTERED,
      seedOrder: REGISTERED,
      labels: ['Top Six', 'Bottom Six'],
    });
    if (r.status !== 'awaiting') throw new Error('expected awaiting');
    expect(r.prefill[0].entrants).toEqual(['chatsworth', 'clares', 'crusaders']);
  });

  it('ignores prior groups when the stage names no source stage', () => {
    // A plain `manual` stage — a new client with no prior-season log — has nothing to
    // carry forward, so the registered list is genuinely the best available guess.
    const r = resolveEntrants(
      { kind: 'manual', groups: { kind: 'sizes', sizes: [3, 3] } },
      { registered: REGISTERED, priorGroups: PRIOR, labels: ['A', 'B'] },
    );
    if (r.status !== 'awaiting') throw new Error('expected awaiting');
    expect(r.prefill[0].entrants).toEqual(['chatsworth', 'clares', 'crusaders']);
  });

  it('gives a knockout its qualifiers in pool order, not alphabetical order', () => {
    // One group, so the pools flatten — but they flatten in CONFIRMED order, which is
    // what a cross-pool bracket reads to pair A1 against B2.
    const r = resolveEntrants(
      {
        kind: 'manual',
        derivedFrom: { rule: 'from-standings', fromStage: 'pools', detail: 'Top two per pool' },
      },
      { registered: REGISTERED, priorGroups: PRIOR },
    );
    if (r.status !== 'awaiting') throw new Error('expected awaiting');
    expect(r.prefill[0].entrants).toEqual([...PRIOR[0], ...PRIOR[1]]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Design-time calendar resolution.

   A structure names block IDs and nothing else, so "which calendar does this
   belong to" is a real question with a wrong answer that looks right. These pin
   the order the answer is derived in, and — more importantly — pin that an
   ambiguous answer is refused rather than guessed.
   ───────────────────────────────────────────────────────────────────────────── */

describe('which calendar a structure should be edited against', () => {
  const CAL_A: SeasonCalendar = {
    id: 'cal-a',
    label: '2026/27 season',
    blocks: [
      { id: 'a1', label: 'First half', start: '2026-08-01', end: '2026-12-19' },
      { id: 'a2', label: 'Second half', start: '2027-01-16', end: '2027-05-29' },
    ],
  };
  const CAL_B: SeasonCalendar = {
    id: 'cal-b',
    label: 'Premier League - 2026/27',
    blocks: [
      { id: 'b1x', label: 'Block 1', start: '2026-09-27', end: '2026-11-01' },
      { id: 'b2x', label: 'Block 2', start: '2026-11-08', end: '2026-12-06' },
    ],
  };
  /** Two seeded seasons: identical block ids AND labels, different dates. */
  const TWIN_1: SeasonCalendar = {
    id: 'cal-2026-27',
    label: '2026/27 season',
    blocks: [{ id: 'block-1', label: 'First half', start: '2026-08-01', end: '2026-12-19' }],
  };
  const TWIN_2: SeasonCalendar = {
    id: 'cal-2027-28',
    label: '2027/28 season',
    blocks: [{ id: 'block-1', label: 'First half', start: '2027-08-01', end: '2027-12-19' }],
  };

  const structure = (over: Partial<CompetitionStructure> = {}): CompetitionStructure => ({
    id: 'st',
    name: 'Split league',
    version: 1,
    stages: [
      { ...STAGE, id: 's1', name: 'Double round', schedule: { ...WEEKLY_B1, blockId: 'a1' } },
    ],
    ...over,
  });

  it('honours the calendar the structure records, without second-guessing it', () => {
    expect(resolveDesignCalendarId(structure({ calendarId: 'cal-b' }), [CAL_A, CAL_B])).toBe(
      'cal-b',
    );
  });

  it('falls through when the recorded calendar has since been deleted', () => {
    // Not an error and not a guess: coverage answers it, because only one calendar
    // actually has the block this structure names.
    expect(resolveDesignCalendarId(structure({ calendarId: 'gone' }), [CAL_A, CAL_B])).toBe(
      'cal-a',
    );
  });

  it('opens on the calendar whose blocks the stages name, not whichever is first', () => {
    // The reported bug: every seeded structure has no calendarId, and calendars[0]
    // was a different season whose block ids match nothing here.
    expect(resolveDesignCalendarId(structure(), [CAL_B, CAL_A])).toBe('cal-a');
  });

  it('prefers the calendar the bound competition names, which is the one the server enforces', () => {
    // Coverage would say cal-a; the binding says cal-b. `validateCompetitions` only
    // accepts blocks on the BOUND calendar, so editing anywhere else is editing
    // against a calendar with no authority over the save.
    expect(resolveDesignCalendarId(structure(), [CAL_A, CAL_B], ['cal-b'])).toBe('cal-b');
  });

  it('is not confused by one structure bound through several leagues', () => {
    // Dev binds one structure through three leagues, all naming the same calendar.
    // Counting bindings rather than distinct calendars would read that as ambiguous.
    expect(resolveDesignCalendarId(structure(), [CAL_A, CAL_B], ['cal-b', 'cal-b', 'cal-b'])).toBe(
      'cal-b',
    );
  });

  it('picks NOTHING when two calendars are indistinguishable, rather than guessing', () => {
    // seed-cohort used to mint `block-1`/`First half` for every season, so two
    // calendars covered equally. Choosing by array order renders a correct-LOOKING
    // picker over the wrong season's dates — invisibly wrong, and strictly worse
    // than a blank one the operator can see is unanswered.
    const twin = structure({
      stages: [{ ...STAGE, id: 's1', schedule: { ...WEEKLY_B1, blockId: 'block-1' } }],
    });
    expect(resolveDesignCalendarId(twin, [TWIN_1, TWIN_2])).toBe('');
  });

  it('breaks that tie when a binding names one of them', () => {
    const twin = structure({
      stages: [{ ...STAGE, id: 's1', schedule: { ...WEEKLY_B1, blockId: 'block-1' } }],
    });
    expect(resolveDesignCalendarId(twin, [TWIN_1, TWIN_2], ['cal-2027-28'])).toBe('cal-2027-28');
  });

  it('returns nothing when there are no calendars at all', () => {
    expect(resolveDesignCalendarId(structure(), [])).toBe('');
  });
});

describe('stages whose block is not on a given calendar', () => {
  const CAL_A: SeasonCalendar = {
    id: 'cal-a',
    label: '2026/27',
    blocks: [{ id: 'a1', label: 'First half', start: '2026-08-01', end: '2026-12-19' }],
  };

  it('names a stage holding a block from somewhere else', () => {
    const off = stagesOffCalendar(
      [{ ...STAGE, id: 's1', name: 'Double round', schedule: { ...WEEKLY_B1, blockId: 'other' } }],
      CAL_A,
    );
    expect(off.map((s) => s.name)).toEqual(['Double round']);
  });

  it('ignores a stage nobody has scheduled yet', () => {
    // An EMPTY blockId is a different mistake with its own "needs a playing block"
    // error. Folding the two together would tell an operator their data had gone
    // missing when they simply hadn't entered it.
    expect(
      stagesOffCalendar([{ ...STAGE, id: 's1', schedule: { ...WEEKLY_B1, blockId: '' } }], CAL_A),
    ).toEqual([]);
  });
});

describe('the one spelling of a group label', () => {
  it('falls back to Group A, Group B when the operator named nothing', () => {
    expect(labelFor(undefined, 0)).toBe('Group A');
    expect(labelFor(undefined, 1)).toBe('Group B');
  });

  it('uses a named label where there is one', () => {
    expect(labelFor(['Top Six', 'Bottom Six'], 1)).toBe('Bottom Six');
  });

  it('treats a blank label as unnamed rather than rendering an empty group', () => {
    expect(labelFor(['   '], 0)).toBe('Group A');
  });

  it('keeps going past Z', () => {
    // The confirm form used to spell this `String.fromCharCode(65 + i)`, which emits
    // "Group [" here. Two spellings of one fallback is how the save path drifted to
    // a third ("Group 1").
    expect(labelFor(undefined, 26)).toBe('Group AA');
  });
});
