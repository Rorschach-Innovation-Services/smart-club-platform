import { describe, it, expect } from 'vitest';
import { describeStructure } from './narrative';
import { STRUCTURE_TEMPLATES, instantiateTemplate } from './templates';
import {
  CADENCE_KINDS,
  ENTRANT_KINDS,
  STAGE_KINDS,
  entrantKindFor,
  stageKindFor,
  stageTitle,
} from './stage-kinds';
import type {
  Cadence,
  CompetitionStructure,
  EntrantSpec,
  FormatSpec,
  SeasonCalendar,
} from './types';

const TWO_BLOCKS: SeasonCalendar = {
  id: 'cal',
  label: '2026/27',
  blocks: [
    { id: 'b1', label: 'Block 1', start: '2026-09-13', end: '2026-12-13' },
    { id: 'b2', label: 'Block 2', start: '2027-01-18', end: '2027-03-28' },
  ],
  breaks: [{ label: 'the mid-season break', start: '2026-12-14', end: '2027-01-17' }],
};
const ONE_BLOCK: SeasonCalendar = { ...TWO_BLOCKS, blocks: [TWO_BLOCKS.blocks[0]], breaks: [] };

describe('describeStructure', () => {
  for (const t of STRUCTURE_TEMPLATES) {
    it(`tells the ${t.id} template on a one-block calendar`, () => {
      const st = instantiateTemplate(t, ONE_BLOCK);
      expect(describeStructure(st, ONE_BLOCK, 12)).toMatchSnapshot();
    });
    it(`tells the ${t.id} template on a two-block calendar`, () => {
      const st = instantiateTemplate(t, TWO_BLOCKS);
      expect(describeStructure(st, TWO_BLOCKS, 12)).toMatchSnapshot();
    });
  }

  it('reads the pools template the way the plan describes it', () => {
    const st = instantiateTemplate(
      STRUCTURE_TEMPLATES.find((t) => t.id === 'pools-to-knockout-within')!,
      ONE_BLOCK,
    );
    const [first, second] = describeStructure(st, ONE_BLOCK, 12);
    expect(first).toBe(
      'Stage 1 · Round-robin stage · 12 sides seeded into 2 groups of 6 (snake) · everyone plays everyone once · weekly in Block 1, 13 Sep – 11 Oct 2026.',
    );
    expect(second).toMatch(
      /^Stage 2 · Knockout stage · top 2 per group from Stage 1 · semi-finals within each group, then a final · starts the week after Stage 1, in Block 1, /,
    );
  });

  it('reads the one-off tournament as a hand-picked seeded knockout spread over its dates', () => {
    const st = instantiateTemplate(
      STRUCTURE_TEMPLATES.find((t) => t.id === 'one-off-tournament')!,
      ONE_BLOCK,
    );
    expect(describeStructure(st, ONE_BLOCK, 8)).toEqual([
      'Stage 1 · Knockout stage · chosen by the admin · a seeded knockout: quarter-finals, semi-finals, then a final · spread across the block in Block 1, 13 Sep – 13 Dec 2026.',
    ]);
  });

  it('omits dates when there is no calendar', () => {
    const st = instantiateTemplate(STRUCTURE_TEMPLATES[0], undefined);
    expect(describeStructure(st, undefined, 12)).toEqual([
      'Stage 1 · Round-robin stage · all 12 sides in one group · everyone plays everyone once · weekly in Block 1.',
    ]);
  });

  it('says by how many rounds a stage overruns its block', () => {
    const tiny: SeasonCalendar = {
      ...ONE_BLOCK,
      blocks: [{ id: 'b1', label: 'Block 1', start: '2026-09-13', end: '2026-10-11' }],
    };
    const st: CompetitionStructure = instantiateTemplate(STRUCTURE_TEMPLATES[0], tiny);
    // 12 sides → 11 rounds; five Sundays fit.
    expect(describeStructure(st, tiny, 12)[0]).toMatch(
      /· does not fit the block \(6 rounds over\)\.$/,
    );
  });
});

describe('help registries cover every choice', () => {
  // Built by hand from the unions in src/types.ts: a new kind or pairing added there must
  // be added here AND given copy, or this fails.
  const formats: FormatSpec[] = [
    { kind: 'round-robin', legs: 1 },
    { kind: 'round-robin', legs: 2 },
    { kind: 'round-robin', legs: 3 },
    { kind: 'knockout', pairing: 'seeded' },
    { kind: 'knockout', pairing: 'cross-pool' },
    { kind: 'knockout', pairing: 'within-pool' },
    { kind: 'single-match' },
    { kind: 'manual' },
  ];
  const entrants: EntrantSpec[] = [
    { kind: 'all-registered' },
    { kind: 'seeded-split', groups: { kind: 'even', count: 2 }, method: 'snake' },
    { kind: 'seeded-split', groups: { kind: 'even', count: 2 }, method: 'blocks' },
    { kind: 'manual' },
  ];
  const cadences: Cadence[] = [
    { kind: 'weekly' },
    { kind: 'every-n-weeks', n: 2 },
    { kind: 'weekdays', days: [6] },
    { kind: 'spread' },
  ];

  it('gives every format its own entry and a stage title', () => {
    const keys = formats.map(stageKindFor);
    expect(new Set(keys).size).toBe(formats.length);
    for (const key of keys) {
      const help = STAGE_KINDS[key];
      expect(help, key).toBeDefined();
      for (const field of ['title', 'does', 'youWillBeAsked', 'produces', 'eg', 'decideBy'])
        expect((help as unknown as Record<string, string>)[field], `${key}.${field}`).toBeTruthy();
    }
    expect(Object.keys(STAGE_KINDS).sort()).toEqual([...keys].sort());
    expect(new Set(Object.values(STAGE_KINDS).map((h) => h.title)).size).toBe(formats.length);
    expect(formats.map(stageTitle)).toEqual([
      'Round-robin stage',
      'Round-robin stage',
      'Round-robin stage',
      'Knockout stage',
      'Knockout stage',
      'Knockout stage',
      'Final',
      'Hand-entered stage',
    ]);
  });

  it('gives every teams setting its own entry', () => {
    const keys = entrants.map(entrantKindFor);
    expect(new Set(keys).size).toBe(entrants.length);
    for (const key of keys) expect(ENTRANT_KINDS[key]?.does, key).toBeTruthy();
    expect(Object.keys(ENTRANT_KINDS).sort()).toEqual([...keys].sort());
  });

  it('gives every cadence its own entry', () => {
    for (const c of cadences) expect(CADENCE_KINDS[c.kind]?.does, c.kind).toBeTruthy();
    expect(Object.keys(CADENCE_KINDS).sort()).toEqual(cadences.map((c) => c.kind).sort());
  });

  it('never calls a group a pool in its copy', () => {
    // Values only — the keys mirror stored `pairing` values such as 'cross-pool'.
    const copy = JSON.stringify(
      [STAGE_KINDS, ENTRANT_KINDS, CADENCE_KINDS].flatMap((r) => Object.values(r)),
    );
    expect(copy).not.toMatch(/\bpools?\b/i);
  });
});
