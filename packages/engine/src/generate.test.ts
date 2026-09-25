import { describe, it, expect } from 'vitest';
import { generateStage, stagesAfterGenerate } from './generate';
import { materialiseRun } from './run';
import type { TeamParticipant } from './leagues';
import type { SeasonRun, StageSpec } from './types';

const POOLS: StageSpec = {
  id: 'pools',
  name: 'Pool stage',
  format: { kind: 'round-robin', legs: 1 },
  entrants: { kind: 'seeded-split', groups: { kind: 'even', count: 2 }, method: 'snake' },
  schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
};
const FINALS: StageSpec = {
  id: 'finals',
  name: 'Finals',
  format: { kind: 'round-robin', legs: 1 },
  entrants: { kind: 'manual' },
  schedule: { blockIndex: 1, cadence: { kind: 'weekly' } },
};

const TEAMS: TeamParticipant[] = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
  teamId: id,
  clubId: id,
  name: `Club ${id.toUpperCase()}`,
  venue: `${id.toUpperCase()} Oval`,
}));

const RUN: SeasonRun = {
  id: 'run-1',
  leagueKey: 'premier',
  competitionId: 'cmp-1',
  seasonLabel: '2026/27',
  structureSnapshot: { id: 'st-1', name: 'Pools then finals', version: 1, stages: [POOLS, FINALS] },
  calendarSnapshot: {
    id: 'cal-1',
    label: '2026/27',
    blocks: [
      { id: 'b1', label: 'Block 1', start: '2026-09-12', end: '2026-12-12' },
      { id: 'b2', label: 'Block 2', start: '2027-01-09', end: '2027-03-27' },
    ],
  },
  stages: [
    { specId: 'pools', status: 'ready', groups: [], staleSchedule: true },
    { specId: 'finals', status: 'awaiting-entrants', groups: [] },
  ],
  version: 3,
};

const args = (run: SeasonRun, specId: string) => ({
  run,
  specId,
  participants: TEAMS,
  leagueTeams: TEAMS,
  league: { label: 'Premier Men' },
  competition: { label: '50 Over', matchFormat: { overs: 50 } },
});

describe('generateStage', () => {
  it('builds one series per group from the same materialisation the console previews', () => {
    const out = generateStage(args(RUN, 'pools'));
    if (out.status !== 'ready') throw new Error(out.status);
    const m = materialiseRun(RUN, TEAMS).materialisations[0];
    if (m.status !== 'ready') throw new Error('expected ready');
    expect(out.series.map((s) => s.id)).toEqual(['s-run-1-pools-g1', 's-run-1-pools-g2']);
    expect(out.series.map((s) => s.fixtures)).toEqual(m.groups.map((g) => g.fixtures));
    expect(out.series[0].name).toBe('Premier Men · Pool stage · Group A');
    expect(out.series[0].released).toBe(false);
    expect(out.series[0].schedule?.blockId).toBe('b1');
    expect(out.series[0].startDate).toBe(m.groups[0].plan.dates[0]);
    expect(out.groups.map((g) => g.seriesId)).toEqual(out.series.map((s) => s.id));
  });

  it('is deterministic — the same inputs build byte-identical series', () => {
    expect(generateStage(args(RUN, 'pools'))).toEqual(generateStage(args(RUN, 'pools')));
  });

  it('honours the competition exclusions in who is drawn, not in the snapshot pool', () => {
    const out = generateStage({ ...args(RUN, 'pools'), participants: TEAMS.slice(0, 4) });
    if (out.status !== 'ready') throw new Error(out.status);
    expect(out.series.flatMap((s) => s.teams).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reports an unconfirmed manual stage as awaiting entrants', () => {
    expect(generateStage(args(RUN, 'finals')).status).toBe('awaiting-entrants');
  });

  it('uses confirmed groups when the run has them', () => {
    const run: SeasonRun = {
      ...RUN,
      stages: [
        RUN.stages[0],
        {
          specId: 'finals',
          status: 'ready',
          groups: [{ id: 'g1', label: 'Final', entrants: ['a', 'f'] }],
        },
      ],
    };
    const out = generateStage(args(run, 'finals'));
    if (out.status !== 'ready') throw new Error(out.status);
    expect(out.series).toHaveLength(1);
    expect(out.series[0].teams).toEqual(['a', 'f']);
    expect(out.series[0].name).toBe('Premier Men · Finals');
    expect(out.series[0].schedule?.blockId).toBe('b2');
  });

  it('reports an unknown stage', () => {
    expect(generateStage(args(RUN, 'nope')).status).toBe('unknown-stage');
  });
});

describe('stagesAfterGenerate', () => {
  it('marks the stage generated, seeds its groups with series ids and clears staleSchedule', () => {
    const out = generateStage(args(RUN, 'pools'));
    if (out.status !== 'ready') throw new Error(out.status);
    const stages = stagesAfterGenerate(RUN, 'pools', out.groups);
    expect(stages[0].status).toBe('generated');
    expect(stages[0].staleSchedule).toBeUndefined();
    expect(stages[0].groups.map((g) => [g.id, g.seriesId])).toEqual([
      ['g1', 's-run-1-pools-g1'],
      ['g2', 's-run-1-pools-g2'],
    ]);
    // Other stages untouched.
    expect(stages[1]).toEqual(RUN.stages[1]);
  });

  it('keeps confirmed groups (and their audit) and only fills in the series ids', () => {
    const run: SeasonRun = {
      ...RUN,
      stages: [
        {
          specId: 'pools',
          status: 'ready',
          groups: [
            { id: 'g1', label: 'Top', entrants: ['a', 'b', 'c'] },
            { id: 'g2', label: 'Bottom', entrants: ['d', 'e', 'f'] },
          ],
          audit: [{ at: 't', by: 'x', prefill: [], accepted: true }],
        },
      ],
    };
    const stages = stagesAfterGenerate(run, 'pools', [
      { groupId: 'g1', groupLabel: 'Top', entrants: ['a', 'b', 'c'], seriesId: 's1' },
      { groupId: 'g2', groupLabel: 'Bottom', entrants: ['d', 'e', 'f'], seriesId: 's2' },
    ]);
    expect(stages[0].groups.map((g) => [g.label, g.seriesId])).toEqual([
      ['Top', 's1'],
      ['Bottom', 's2'],
    ]);
    expect(stages[0].audit).toHaveLength(1);
    // A snapshot stage with no StageRun gains one.
    expect(stages[1]).toEqual({ specId: 'finals', status: 'awaiting-entrants', groups: [] });
  });
});
