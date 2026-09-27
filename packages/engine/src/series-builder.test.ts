import { describe, it, expect } from 'vitest';
import { buildStageSeries, type BuildStageSeriesArgs } from './series-builder';
import type { TeamParticipant } from './leagues';
import type { StageSpec } from './types';

const STAGE: StageSpec = {
  id: 'pools',
  name: 'Pool stage',
  format: { kind: 'round-robin', legs: 1 },
  entrants: { kind: 'seeded-split', groups: { kind: 'even', count: 2 }, method: 'snake' },
  schedule: {
    blockIndex: 0,
    cadence: { kind: 'weekly' },
    slots: [
      { label: 'Morning', start: '08:00' },
      { label: 'Afternoon', start: '13:30' },
    ],
    roundsPerDay: 2,
    activateFrom: '2027-01-18',
  },
};

// Registration order, not group order — the snapshot keeps it. `westville` has no ground
// on record; `umhlanga` is registered but sits in the other group.
const LEAGUE_TEAMS: TeamParticipant[] = [
  {
    teamId: 'pinetown',
    clubId: 'pinetown',
    name: 'Pinetown CC',
    venue: 'Pinetown Sports Club',
    lat: -29.8156,
    lon: 30.8586,
  },
  { teamId: 'westville', clubId: 'westville', name: 'Westville CC' },
  {
    teamId: 'tm_glen_a',
    clubId: 'glenwood',
    name: 'Glenwood A',
    venue: 'Glenwood Park',
    lat: -29.8703,
    lon: 30.9932,
  },
  {
    teamId: 'umhlanga',
    clubId: 'umhlanga',
    name: 'Umhlanga CC',
    venue: 'Umhlanga Sports Field',
    lat: -29.7264,
    lon: 31.0856,
  },
];

const args = (overrides: Partial<BuildStageSeriesArgs> = {}): BuildStageSeriesArgs => ({
  run: { id: 'run-1', leagueKey: 'premier-men', calendarSnapshot: { id: 'cal-2026' } },
  stage: STAGE,
  blockId: 'cal-2026-block-1',
  group: {
    groupId: 'g1',
    groupLabel: 'Group A',
    entrants: ['tm_glen_a', 'westville', 'pinetown'],
    fixtures: [{ id: 'f1', round: 1, home: 'tm_glen_a', away: 'pinetown', date: '2026-09-13' }],
    startDate: '2026-09-13',
    league: { label: 'Premier Men' },
    format: { structureName: 'T20 (Pink Ball)', overs: 20 },
  },
  multi: true,
  leagueTeams: LEAGUE_TEAMS,
  ...overrides,
});

describe('buildStageSeries', () => {
  it('builds one group of a two-group stage with slots, roundsPerDay and activateFrom', () => {
    expect(buildStageSeries(args())).toMatchSnapshot();
  });

  it('a regenerate rebuilds the same row: same id, fresh unreleased draft, same schedule', () => {
    const first = buildStageSeries(args());
    const again = buildStageSeries(args());
    expect(again).toEqual(first);
    expect(again.id).toBe('s-run-1-pools-g1');
    expect(again.released).toBe(false);
    expect(again.releasedAt).toBeNull();
    expect(again.version).toBe(1);
  });

  it('omits the optional keys, the group label and the format fallbacks when absent', () => {
    const s = buildStageSeries(
      args({
        stage: { ...STAGE, schedule: { blockIndex: 0, cadence: { kind: 'weekly' }, slots: [] } },
        group: { ...args().group, league: undefined, format: undefined },
        multi: false,
      }),
    );
    expect(s.name).toBe('premier-men · Pool stage');
    expect(s.schedule).toEqual({
      calendarId: 'cal-2026',
      blockId: 'cal-2026-block-1',
      cadence: { kind: 'weekly' },
    });
    expect('activateFrom' in s).toBe(false);
    expect(s.maxOvers).toBe(50);
    expect(s.seriesType).toBe('Pool stage');
  });

  it('names the series type after the setup structure, else the stage', () => {
    expect(buildStageSeries(args()).seriesType).toBe('T20 (Pink Ball)');
    const unnamed = { ...args().group, format: { overs: 20 } };
    expect(buildStageSeries(args({ group: unnamed })).seriesType).toBe('Pool stage');
  });

  it('takes the structure’s overs, else 50', () => {
    expect(buildStageSeries(args()).maxOvers).toBe(20);
    const noOvers = { ...args().group, format: { structureName: 'One-off cup' } };
    expect(buildStageSeries(args({ group: noOvers })).maxOvers).toBe(50);
    // The retired tenant default no longer reaches a `format`-built series.
    expect(buildStageSeries(args({ group: noOvers, defaultOvers: 40 })).maxOvers).toBe(50);
  });

  it('still honours the deprecated competition pick when no format is given (until WS6)', () => {
    const legacy = {
      ...args().group,
      format: undefined,
      competition: { label: '40 Over' },
    };
    const s = buildStageSeries(args({ group: legacy, defaultOvers: 40 }));
    expect(s.seriesType).toBe('40 Over');
    expect(s.maxOvers).toBe(40);
  });
});
