import { describe, it, expect } from 'vitest';
import {
  leagueReadiness,
  leaguesReadiness,
  readinessCounts,
  readinessSummaryLine,
  readinessSummaryParts,
  runProgress,
  structureFormatLabel,
  type ReadinessClub,
  type ReadinessInput,
} from './league-readiness';
import type {
  CompetitionStructure,
  League,
  SeasonCalendar,
  SeasonRun,
  StageSpec,
} from '../packages/engine/src/types';

const TODAY = '2026-10-05';

const stage = (id: string, name: string): StageSpec =>
  ({
    id,
    name,
    format: { kind: 'round-robin', legs: 1 },
    entrants: { kind: 'all-registered' },
    schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
  }) as StageSpec;

const structure: CompetitionStructure = {
  id: 'st-1',
  name: 'Split league',
  version: 2,
  overs: 50,
  stages: [stage('s1', 'Double round'), stage('s2', 'Final round')],
};

const calendar: SeasonCalendar = {
  id: 'cal-1',
  label: '2026/27',
  blocks: [
    { id: 'b1', label: 'Block 1', start: '2026-09-12', end: '2026-12-12' },
    { id: 'b2', label: 'Block 2', start: '2027-01-16', end: '2027-03-27' },
  ],
};

const endedCalendar: SeasonCalendar = {
  id: 'cal-old',
  label: '2025/26',
  blocks: [{ id: 'b1', label: 'Block 1', start: '2025-09-13', end: '2026-03-28' }],
};

const premier: League = {
  key: 'premier',
  label: 'Premier League',
  group: 'Senior',
  district: 'All districts',
  setup: { structureId: 'st-1', calendarId: 'cal-1' },
};

const club = (id: string, over: Partial<ReadinessClub> = {}): ReadinessClub => ({
  id,
  name: `Club ${id}`,
  leagues: ['premier'],
  affiliation: 'complete',
  ...over,
});

const input = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  clubs: [club('a'), club('b'), club('c')],
  structures: [structure],
  calendars: [calendar, endedCalendar],
  runs: [],
  today: TODAY,
  ...over,
});

const seasonRun = (over: Partial<SeasonRun> = {}): SeasonRun => ({
  id: 'run-1',
  leagueKey: 'premier',
  seasonLabel: '2026/27',
  structureSnapshot: structure,
  calendarSnapshot: calendar,
  stages: [],
  version: 1,
  ...over,
});

describe('leagueReadiness — status', () => {
  it('is ready with a setup that resolves, current dates and two or more affiliated sides', () => {
    const r = leagueReadiness(premier, input());
    expect(r.status).toBe('ready');
    expect(r.canStart).toBe(true);
    expect(r.setupProblems).toEqual([]);
    expect(r.setup).toEqual({
      structureLabel: 'Split league · 50 overs',
      structureVersion: 2,
      calendarLabel: '2026/27',
      start: '2026-09-12',
      end: '2027-03-27',
    });
    expect(r.reason).toBe('ready to start');
    expect(r.operatorRequest).toBeUndefined();
  });

  it('needs operator setup when the league has none, with a request naming the league', () => {
    const r = leagueReadiness({ ...premier, setup: undefined }, input());
    expect(r.status).toBe('needs-setup');
    expect(r.canStart).toBe(false);
    expect(r.setupProblems).toEqual(['no-setup']);
    expect(r.setup).toBeNull();
    expect(r.nextStep).toMatch(/Ask your operator to set this league up/);
    expect(r.operatorRequest).toBe(
      'Please set up Premier League for a season: it needs a structure and a season calendar.',
    );
  });

  it('needs operator setup when the structure is gone', () => {
    const r = leagueReadiness(premier, input({ structures: [] }));
    expect(r.status).toBe('needs-setup');
    expect(r.setupProblems).toEqual(['structure-missing']);
    expect(r.setup?.structureLabel).toBeUndefined();
    expect(r.setup?.calendarLabel).toBe('2026/27');
    expect(r.reason).toBe('structure missing — ask your operator');
    expect(r.operatorRequest).toBe(
      'Please fix the season setup for Premier League: its structure no longer exists, so it needs a new one.',
    );
  });

  it('needs operator setup when the calendar is gone', () => {
    const r = leagueReadiness(premier, input({ calendars: [] }));
    expect(r.setupProblems).toEqual(['calendar-missing']);
    expect(r.reason).toBe('season calendar missing — ask your operator');
  });

  it('names both when the structure and the calendar are gone', () => {
    const r = leagueReadiness(premier, input({ structures: [], calendars: [] }));
    expect(r.setupProblems).toEqual(['structure-missing', 'calendar-missing']);
    expect(r.operatorRequest).toBe(
      'Please fix the season setup for Premier League: its structure and season calendar no longer exist, so it needs a new one.',
    );
  });

  it('needs operator setup when the setup’s season dates have ended', () => {
    const ended = { ...premier, setup: { structureId: 'st-1', calendarId: 'cal-old' } };
    const r = leagueReadiness(ended, input());
    expect(r.status).toBe('needs-setup');
    expect(r.setupProblems).toEqual(['calendar-ended']);
    expect(r.calendarEnded).toEqual({ label: '2025/26', end: '2026-03-28' });
    expect(r.nextStep).toBe('Ask your operator to renew this league’s season dates.');
    expect(r.operatorRequest).toBe(
      'Please renew the season dates for Premier League: its calendar 2025/26 ended on 28 Mar 2026.',
    );
  });

  it('treats a calendar ending today as current, and one ending yesterday as ended', () => {
    const endsOn = (end: string): SeasonCalendar => ({
      ...endedCalendar,
      blocks: [{ id: 'b1', label: 'Block 1', start: '2026-01-01', end }],
    });
    const lg = { ...premier, setup: { structureId: 'st-1', calendarId: 'cal-old' } };
    expect(leagueReadiness(lg, input({ calendars: [endsOn(TODAY)] })).calendarEnded).toBeNull();
    expect(
      leagueReadiness(lg, input({ calendars: [endsOn('2026-10-04')] })).calendarEnded,
    ).not.toBeNull();
  });

  it('needs sides with fewer than two affiliated sides, listing the clubs to chase', () => {
    const r = leagueReadiness(
      premier,
      input({
        clubs: [
          club('a'),
          club('b', { affiliation: 'in_progress' }),
          club('c', { affiliation: 'not_started' }),
          // Registered for another league only: not counted at all.
          club('d', { leagues: ['other'] }),
        ],
      }),
    );
    expect(r.status).toBe('needs-sides');
    expect(r.canStart).toBe(false);
    expect(r.sides).toEqual({
      registered: 3,
      affiliated: 1,
      unaffiliatedClubs: [
        { id: 'b', name: 'Club b', sides: 1 },
        { id: 'c', name: 'Club c', sides: 1 },
      ],
    });
    expect(r.reason).toBe('needs sides — 3 registered, 1 affiliated');
    expect(r.nextStep).toMatch(/Chase the clubs below/);
  });

  it('puts setup before sides: a league with neither needs the operator first', () => {
    const r = leagueReadiness({ ...premier, setup: undefined }, input({ clubs: [] }));
    expect(r.status).toBe('needs-setup');
    expect(r.sides.registered).toBe(0);
  });
});

describe('leagueReadiness — counting sides', () => {
  it('counts each side of a multi-team club, from leagueTeams', () => {
    const r = leagueReadiness(
      premier,
      input({
        clubs: [
          // One affiliated club fielding two sides is enough to start on its own.
          club('a', { leagueTeams: { premier: 2 } }),
          club('b', { affiliation: 'in_progress', leagueTeams: { premier: 3 } }),
        ],
      }),
    );
    expect(r.sides.registered).toBe(5);
    expect(r.sides.affiliated).toBe(2);
    expect(r.sides.unaffiliatedClubs).toEqual([{ id: 'b', name: 'Club b', sides: 3 }]);
    expect(r.status).toBe('ready');
  });

  it('honours a caller-supplied affiliation predicate', () => {
    const r = leagueReadiness(premier, input({ isAffiliated: (c) => c.id === 'a' }));
    expect(r.sides.affiliated).toBe(1);
    expect(r.status).toBe('needs-sides');
  });
});

describe('leagueReadiness — seasons', () => {
  it('is running while a season for the league has dates left, whatever else is wrong', () => {
    const r = leagueReadiness(
      { ...premier, setup: undefined },
      input({ runs: [seasonRun()], clubs: [] }),
    );
    expect(r.status).toBe('running');
    expect(r.run).toMatchObject({ id: 'run-1', seasonLabel: '2026/27', running: true });
    expect(r.reason).toBe('season 2026/27 running');
    expect(r.nextStep).toBe('Open the season to carry on — Stage 1 of 2: waiting for entrants.');
    // Running does not make it startable: the setup is still missing.
    expect(r.canStart).toBe(false);
  });

  it('can still start another season while one is running', () => {
    const r = leagueReadiness(premier, input({ runs: [seasonRun()] }));
    expect(r.status).toBe('running');
    expect(r.canStart).toBe(true);
  });

  it('shows a past season as the last one and falls through to the other statuses', () => {
    const past = seasonRun({ id: 'old', seasonLabel: '2025/26', calendarSnapshot: endedCalendar });
    const r = leagueReadiness(premier, input({ runs: [past] }));
    expect(r.status).toBe('ready');
    expect(r.run).toMatchObject({ id: 'old', running: false });
  });

  it('prefers the running season over a newer past one, and ignores other leagues’ runs', () => {
    const running = seasonRun({ id: 'now', createdAt: '2026-08-01T00:00:00Z' });
    const pastNewer = seasonRun({
      id: 'past',
      seasonLabel: 'Winter',
      calendarSnapshot: endedCalendar,
      createdAt: '2026-09-01T00:00:00Z',
    });
    const otherLeague = seasonRun({ id: 'other', leagueKey: 'second' });
    const r = leagueReadiness(premier, input({ runs: [pastNewer, otherLeague, running] }));
    expect(r.run?.id).toBe('now');
  });
});

describe('runProgress', () => {
  it('reads each stage: waiting, entrants confirmed, generated, released', () => {
    const run = seasonRun({
      structureSnapshot: {
        ...structure,
        stages: [stage('s1', 'One'), stage('s2', 'Two'), stage('s3', 'Three'), stage('s4', 'Four')],
      },
      stages: [
        {
          specId: 's1',
          status: 'generated',
          groups: [{ id: 'g1', label: 'A', entrants: [], seriesId: 'x1' }],
        },
        {
          specId: 's2',
          status: 'generated',
          groups: [{ id: 'g1', label: 'A', entrants: [], seriesId: 'x2' }],
        },
        { specId: 's3', status: 'ready', groups: [{ id: 'g1', label: 'A', entrants: [] }] },
      ],
    });
    const p = runProgress(
      run,
      [
        { id: 'x1', released: true },
        { id: 'x2', released: false },
      ],
      TODAY,
    );
    expect(p.stages.map((s) => s.step)).toEqual([
      'released',
      'generated',
      'entrants-confirmed',
      'awaiting-entrants',
    ]);
    expect(p.stages[2].line).toBe('Stage 3 · Three: entrants confirmed');
    expect(p.progress).toBe('Stage 2 of 4: fixtures generated');
  });

  it('only calls a stage released once every group’s series is out', () => {
    const run = seasonRun({
      structureSnapshot: { ...structure, stages: [stage('s1', 'Pools')] },
      stages: [
        {
          specId: 's1',
          status: 'generated',
          groups: [
            { id: 'g1', label: 'A', entrants: [], seriesId: 'x1' },
            { id: 'g2', label: 'B', entrants: [], seriesId: 'x2' },
          ],
        },
      ],
    });
    const half = runProgress(run, [{ id: 'x1', released: true }], TODAY);
    expect(half.stages[0].step).toBe('generated');
    const all = runProgress(
      run,
      [
        { id: 'x1', released: true },
        { id: 'x2', released: true },
      ],
      TODAY,
    );
    expect(all.progress).toBe('Released');
  });

  it('says every stage is released for a multi-stage season that is done', () => {
    const run = seasonRun({
      stages: ['s1', 's2'].map((id) => ({
        specId: id,
        status: 'generated' as const,
        groups: [{ id: 'g1', label: 'A', entrants: [], seriesId: id }],
      })),
    });
    const p = runProgress(
      run,
      [
        { id: 's1', released: true },
        { id: 's2', released: true },
      ],
      TODAY,
    );
    expect(p.progress).toBe('All 2 stages released');
  });
});

describe('summary helpers', () => {
  it('counts every status and words the strip, leaving zeros out', () => {
    const list = leaguesReadiness(
      [
        premier,
        { ...premier, key: 'p2', label: 'P2' },
        { ...premier, key: 'bare', label: 'Bare', setup: undefined },
        { ...premier, key: 'bare2', label: 'Bare 2', setup: undefined },
        { ...premier, key: 'empty', label: 'Empty' },
      ],
      input({
        clubs: [
          club('a', { leagues: ['premier', 'p2'] }),
          club('b', { leagues: ['premier', 'p2'] }),
        ],
        runs: [seasonRun({ leagueKey: 'p2' })],
      }),
    );
    const counts = readinessCounts(list);
    expect(counts).toEqual({ ready: 1, 'needs-setup': 2, 'needs-sides': 1, running: 1 });
    expect(readinessSummaryLine(counts)).toBe(
      '1 ready to start · 2 need operator setup · 1 needs sides · 1 running',
    );
    expect(
      readinessSummaryParts({ ready: 0, 'needs-setup': 1, 'needs-sides': 0, running: 0 }),
    ).toEqual([{ status: 'needs-setup', count: 1, text: 'needs operator setup' }]);
  });

  it('formats a structure with and without overs', () => {
    expect(structureFormatLabel({ name: 'T20', overs: 20 })).toBe('T20 · 20 overs');
    expect(structureFormatLabel({ name: 'Flat' })).toBe('Flat');
  });
});
