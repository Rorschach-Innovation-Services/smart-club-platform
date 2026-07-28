/**
 * groupSeriesBySeason — how a club portal reads a structured season.
 *
 * ADR 0008's load-bearing decision is that one stage-group materialises into one existing
 * `Series`. That keeps approval, release, the player broadcast and travel cost on the
 * tested path — and it fragments the club's view: a Top Six side is in three series for
 * what it calls one season. This is the layer that puts it back together, and the counting
 * rule is the part that has already been wrong once.
 *
 * A `.dom.` suite for a pure function: `club.tsx` imports leaflet, which reads `window`
 * at module load, so importing anything from it needs a DOM present.
 */
import { describe, it, expect } from 'vitest';
import { groupSeriesBySeason } from './club';

const s = (over: Record<string, unknown>) => ({ id: 'x', name: 'Series', ...over });

describe('groupSeriesBySeason', () => {
  it('leaves a standalone series exactly as it was', () => {
    // A tenant that never starts a structured season must see no change at all.
    const groups = groupSeriesBySeason([s({ id: 'a' }), s({ id: 'b' })]);

    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.heading === null)).toBe(true);
  });

  it('gathers one run’s stages into a single season', () => {
    const groups = groupSeriesBySeason([
      s({ id: 'a', seasonRunId: 'run-1', stageSpecId: 'pools' }),
      s({ id: 'b', seasonRunId: 'run-1', stageSpecId: 'semis' }),
      s({ id: 'c', seasonRunId: 'run-1', stageSpecId: 'final' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].seriesList).toHaveLength(3);
    expect(groups[0].heading).toBe('One season · 3 stages');
  });

  it('counts DISTINCT STAGES, not series', () => {
    // A club fielding two sides in one league lands in two groups of the SAME stage.
    // That is two series and one stage; "2 stages" is simply untrue.
    const groups = groupSeriesBySeason([
      s({ id: 'a', seasonRunId: 'run-1', stageSpecId: 'pools', groupId: 'g1' }),
      s({ id: 'b', seasonRunId: 'run-1', stageSpecId: 'pools', groupId: 'g2' }),
    ]);

    expect(groups[0].heading).toBe('One season · 1 stage');
  });

  it('says "1 stage", not "1 stages"', () => {
    const groups = groupSeriesBySeason([
      s({ id: 'a', seasonRunId: 'run-1', stageSpecId: 'pools', groupId: 'g1' }),
      s({ id: 'b', seasonRunId: 'run-1', stageSpecId: 'pools', groupId: 'g2' }),
    ]);
    expect(groups[0].heading).not.toMatch(/1 stages/);
  });

  it('gives a one-series season no heading — the card already says it', () => {
    const groups = groupSeriesBySeason([s({ id: 'a', seasonRunId: 'run-1', stageSpecId: 'l' })]);
    expect(groups[0].heading).toBeNull();
  });

  it('keeps two runs apart', () => {
    const groups = groupSeriesBySeason([
      s({ id: 'a', seasonRunId: 'run-1', stageSpecId: 'pools' }),
      s({ id: 'b', seasonRunId: 'run-2', stageSpecId: 'pools' }),
      s({ id: 'c', seasonRunId: 'run-1', stageSpecId: 'semis' }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.runId)).toEqual(['run-1', 'run-2']);
    expect(groups[0].seriesList.map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('preserves the order the API returned', () => {
    // The list arrives gsi1-sorted by start date; grouping must not reshuffle it, or the
    // final round can appear above the pool stage it follows.
    const groups = groupSeriesBySeason([
      s({ id: 'pool', seasonRunId: 'run-1', stageSpecId: 'pools' }),
      s({ id: 'solo' }),
      s({ id: 'semi', seasonRunId: 'run-1', stageSpecId: 'semis' }),
    ]);

    expect(groups.map((g) => g.key)).toEqual(['run:run-1', 'solo:solo']);
    expect(groups[0].seriesList.map((x) => x.id)).toEqual(['pool', 'semi']);
  });

  it('falls back to the series id when a stage id is missing', () => {
    // A legacy series back-filled into a run has no `stageSpecId`. Counting them all as
    // one stage would under-report; the id keeps them distinct.
    const groups = groupSeriesBySeason([
      s({ id: 'a', seasonRunId: 'run-1' }),
      s({ id: 'b', seasonRunId: 'run-1' }),
    ]);

    expect(groups[0].heading).toBe('One season · 2 stages');
  });

  it('tolerates an empty or missing list', () => {
    expect(groupSeriesBySeason([])).toEqual([]);
    expect(groupSeriesBySeason(undefined as never)).toEqual([]);
  });
});
