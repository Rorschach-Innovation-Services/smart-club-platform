import { describe, it, expect } from 'vitest';
import {
  STRUCTURE_TEMPLATES,
  applyPlacement,
  blankStructure,
  defaultPlacement,
  templateBlockIndexForStage,
  findTemplate,
  instantiateTemplate,
  parseStructureJson,
  structureToJson,
} from './templates';
import { materialiseStage } from './structure';
import { describeStage } from './narrative';
import { T20_SLOTS } from './calendar';
import type { SeasonCalendar } from '../types';

const CAL: SeasonCalendar = {
  id: 'cal',
  label: '2026/27',
  blocks: [
    { id: 'b1', label: 'Block 1', start: '2026-09-13', end: '2026-12-13' },
    { id: 'b2', label: 'Block 2', start: '2027-01-18', end: '2027-03-28' },
  ],
  breaks: [{ label: 'the mid-season break', start: '2026-12-14', end: '2027-01-17' }],
};

const team = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);

describe('starter templates', () => {
  // Four shapes, with the pools shape shipped once per semi-final pairing — unions go
  // either way season to season, so neither should be a hand-edit of the other.
  it('ships the four shapes that cover every documented league', () => {
    expect(STRUCTURE_TEMPLATES.map((t) => t.id)).toEqual([
      'flat-round-robin',
      'split-league-swap',
      'pools-to-knockout',
      'pools-to-knockout-within',
      'stream-and-cup',
    ]);
  });

  // The count is what makes the preview exact ("4 entrants") instead of "up to N rounds".
  it('counts two qualifiers per pool on both pools-to-knockout variants', () => {
    for (const id of ['pools-to-knockout', 'pools-to-knockout-within']) {
      const finals = findTemplate(id)!.stages[1];
      expect(finals.entrants.kind, id).toBe('manual');
      if (finals.entrants.kind !== 'manual') continue;
      expect(finals.entrants.derivedFrom?.qualifiersPerGroup, id).toBe(2);
    }
    const within = findTemplate('pools-to-knockout-within')!.stages[1];
    expect(within.format).toEqual({ kind: 'knockout', pairing: 'within-pool' });
  });

  it('names real leagues so the choice is recognisable', () => {
    for (const t of STRUCTURE_TEMPLATES) {
      expect(t.whenToUse.length).toBeGreaterThan(20);
      expect(t.examples.length).toBeGreaterThan(5);
    }
  });

  // Templates can't know real block positions — every stage defaults to 0 and
  // `instantiateTemplate` remaps them once a real calendar is bound.
  it('defaults every stage to block position 0 until it is bound to a calendar', () => {
    for (const t of STRUCTURE_TEMPLATES) {
      for (const s of t.stages) expect(s.schedule.blockIndex).toBe(0);
    }
  });
});

describe('instantiateTemplate', () => {
  it('opens in the first block and moves later stages after the break', () => {
    const st = instantiateTemplate(findTemplate('split-league-swap')!, CAL);
    expect(st.stages[0].schedule.blockIndex).toBe(0);
    expect(st.stages[1].schedule.blockIndex).toBe(1);
  });

  it('keeps everything in one block when the calendar has only one', () => {
    const single: SeasonCalendar = { ...CAL, blocks: [CAL.blocks[0]] };
    const st = instantiateTemplate(findTemplate('split-league-swap')!, single);
    expect(st.stages.map((s) => s.schedule.blockIndex)).toEqual([0, 0]);
  });

  it('records provenance and mints a fresh id each time', () => {
    const a = instantiateTemplate(findTemplate('flat-round-robin')!, CAL);
    const b = instantiateTemplate(findTemplate('flat-round-robin')!, CAL);
    expect(a.templateId).toBe('flat-round-robin');
    expect(a.id).not.toBe(b.id);
    expect(a.version).toBe(1);
  });

  it('accepts an operator-supplied name', () => {
    const st = instantiateTemplate(findTemplate('flat-round-robin')!, CAL, 'EMCU Divisions');
    expect(st.name).toBe('EMCU Divisions');
  });

  // The real test of a template: does it generate anything?
  it('every template produces a workable first stage out of the box', () => {
    for (const t of STRUCTURE_TEMPLATES) {
      const st = instantiateTemplate(t, CAL);
      const m = materialiseStage({
        stage: st.stages[0],
        calendar: CAL,
        context: { registered: team(8), seedOrder: team(8), confirmed: [team(4), team(4)] },
      });
      expect(m.status, `${t.id} stage 1`).toBe('ready');
      if (m.status !== 'ready') continue;
      expect(m.totalFixtures, `${t.id} fixtures`).toBeGreaterThan(0);
      expect(m.fits, `${t.id} fits`).toBe(true);
    }
  });

  it('every template’s later stages wait for a human, as designed', () => {
    for (const t of STRUCTURE_TEMPLATES.filter((x) => x.stages.length > 1)) {
      const st = instantiateTemplate(t, CAL);
      const m = materialiseStage({ stage: st.stages[1], calendar: CAL });
      expect(m.status, `${t.id} stage 2`).toBe('awaiting-entrants');
    }
  });

  it('describes each stage as a readable sentence', () => {
    const st = instantiateTemplate(findTemplate('split-league-swap')!, CAL);
    expect(describeStage(st.stages[0], CAL)).toBe(
      'Entered by an administrator · plays every team twice, home and away · weekly, Block 1',
    );
    expect(describeStage(st.stages[1], CAL)).toContain('swaps with first in the bottom group');
    expect(describeStage(st.stages[1], CAL)).toContain('Block 2');
  });

  describe('explicit placement', () => {
    it('lets an explicit placement win over the default rule', () => {
      const st = instantiateTemplate(findTemplate('split-league-swap')!, CAL, undefined, [0, 0]);
      expect(st.stages.map((s) => s.schedule.blockIndex)).toEqual([0, 0]);
    });

    it('defaults to the old rule: first stage in block 1, the rest in block 2 when it exists', () => {
      for (const t of STRUCTURE_TEMPLATES) {
        const single: SeasonCalendar = { ...CAL, blocks: [CAL.blocks[0]] };
        expect(defaultPlacement(t, 2), t.id).toEqual(
          t.stages.map((_, i) => templateBlockIndexForStage(i, CAL)),
        );
        expect(defaultPlacement(t, 1), t.id).toEqual(
          t.stages.map((_, i) => templateBlockIndexForStage(i, single)),
        );
        expect(
          instantiateTemplate(t, CAL).stages.map((s) => s.schedule.blockIndex),
          t.id,
        ).toEqual(defaultPlacement(t, 2));
      }
    });

    it('chains a stage only when it shares a block with the stage before it', () => {
      const t = findTemplate('pools-to-knockout-within')!;
      const sameBlock = instantiateTemplate(t, CAL, undefined, [0, 0]);
      expect(sameBlock.stages[0].schedule.startAfter).toBeUndefined();
      expect(sameBlock.stages[1].schedule.startAfter).toBe('previous-stage');

      const split = instantiateTemplate(t, CAL, undefined, [0, 1]);
      expect('startAfter' in split.stages[1].schedule).toBe(false);
    });

    it('re-chains when a placement is applied to stages placed differently before', () => {
      const t = findTemplate('split-league-swap')!;
      const chained = instantiateTemplate(t, CAL, undefined, [0, 0]);
      const moved = applyPlacement(chained.stages, [0, 1]);
      expect(moved.map((s) => s.schedule.blockIndex)).toEqual([0, 1]);
      expect('startAfter' in moved[1].schedule).toBe(false);
      const back = applyPlacement(moved, [1, 1]);
      expect(back[1].schedule.startAfter).toBe('previous-stage');
      // Everything else on the schedule survives.
      expect(back[1].schedule.cadence).toEqual({ kind: 'weekly' });
    });
  });

  // Every T20 Pink Ball competition plays a morning and an afternoon match per day, so
  // the starter template carries T20_SLOTS on both its stages out of the box.
  it('carries the T20 morning/afternoon slots on both stages of pools-to-knockout', () => {
    const st = instantiateTemplate(findTemplate('pools-to-knockout')!, CAL);
    expect(st.stages[0].schedule.slots).toEqual(T20_SLOTS);
    expect(st.stages[1].schedule.slots).toEqual(T20_SLOTS);
  });
});

describe('blankStructure', () => {
  it('starts with one workable stage in the first block', () => {
    const st = blankStructure(CAL);
    expect(st.stages).toHaveLength(1);
    expect(st.stages[0].schedule.blockIndex).toBe(0);
    expect(st.templateId).toBeUndefined();
  });

  it('survives a tenant with no calendar configured yet', () => {
    const st = blankStructure(undefined);
    expect(st.stages[0].schedule.blockIndex).toBe(0);
  });
});

describe('JSON import / export', () => {
  it('round-trips a structure', () => {
    const original = instantiateTemplate(findTemplate('pools-to-knockout')!, CAL);
    const parsed = parseStructureJson(structureToJson(original));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.structure.name).toBe(original.name);
    expect(parsed.structure.stages).toEqual(original.stages);
  });

  // Importing the same JSON twice must give two structures, not a silent overwrite.
  it('mints a fresh id on every import', () => {
    const json = structureToJson(instantiateTemplate(findTemplate('flat-round-robin')!, CAL));
    const a = parseStructureJson(json);
    const b = parseStructureJson(json);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.structure.id).not.toBe(b.structure.id);
  });

  it('drops the tenant-local id on export', () => {
    const json = structureToJson(instantiateTemplate(findTemplate('flat-round-robin')!, CAL));
    expect(JSON.parse(json).id).toBeUndefined();
  });

  // A structure carries no calendar identity of its own (ADR 0008 Phase 1) — stages name
  // a block POSITION, and the Competition binding supplies the calendar at generation
  // time. Export/import round-trips the stages as-is; there is no calendarId to lose.
  it('rejects a legacy export that still carries concrete blockId references', () => {
    const legacy = {
      name: 'Old export',
      stages: [
        {
          id: 's1',
          name: 'Stage',
          format: { kind: 'round-robin', legs: 1 },
          entrants: { kind: 'all-registered' },
          schedule: { blockId: 'b1', cadence: { kind: 'weekly' } },
        },
      ],
    };
    expect(parseStructureJson(JSON.stringify(legacy))).toEqual({
      ok: false,
      error: 'this structure JSON uses the old blockId format — regenerate it with blockIndex',
    });
  });

  it('explains what is wrong rather than throwing', () => {
    expect(parseStructureJson('not json')).toEqual({ ok: false, error: 'That isn’t valid JSON.' });
    expect(parseStructureJson('[]')).toMatchObject({ ok: false });
    expect(parseStructureJson('{"stages":[]}')).toMatchObject({
      ok: false,
      error: 'The structure needs a name.',
    });
    expect(parseStructureJson('{"name":"X","stages":[]}')).toMatchObject({
      ok: false,
      error: 'The structure needs at least one stage.',
    });
    expect(parseStructureJson('{"name":"X","stages":[{"id":"a","name":"A"}]}')).toMatchObject({
      ok: false,
      error: 'Stage "A" has no format.',
    });
  });

  // A missing or string `blockIndex` used to round-trip to NaN in the block picker and
  // only die as a server 400 — this is the local catch for that.
  it('rejects a stage with no blockIndex', () => {
    const stage = {
      id: 's1',
      name: 'Stage',
      format: { kind: 'round-robin', legs: 1 },
      entrants: { kind: 'all-registered' },
      schedule: { cadence: { kind: 'weekly' } },
    };
    expect(parseStructureJson(JSON.stringify({ name: 'X', stages: [stage] }))).toMatchObject({
      ok: false,
      error: 'Stage "Stage" has no valid playing block.',
    });
  });

  it('rejects a stage whose blockIndex is not a non-negative integer', () => {
    const base = {
      id: 's1',
      name: 'Stage',
      format: { kind: 'round-robin', legs: 1 },
      entrants: { kind: 'all-registered' },
    };
    for (const blockIndex of ['0', -1, 1.5, null]) {
      const stage = { ...base, schedule: { blockIndex, cadence: { kind: 'weekly' } } };
      expect(parseStructureJson(JSON.stringify({ name: 'X', stages: [stage] }))).toMatchObject({
        ok: false,
        error: 'Stage "Stage" has no valid playing block.',
      });
    }
  });
});
