/**
 * A union's own dashboard (the Lions): events, pools and franchises narrowed to the union — and
 * the event builders behind it. Invented names throughout.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ScoutPool } from './scout-pool';
import type { ScoutingEvent } from './scouting-data';

// Real data in play (not the samples), so the focus applies.
vi.mock('./pro-data', () => ({ POOLS_ARE_SAMPLE: false, SCOUT_POOLS: [] }));
vi.mock('./scouting-data', () => ({ SCOUTING_IS_SAMPLE: false, SCOUTING_EVENTS: [] }));

import { eventFromMatches, eventFromPool, teamCodes } from './scouting-build';
import { focusEvents, focusFor, focusPools, inUnion, isOurFranchise } from './scouting-focus';
import { parseWebSports } from './websports';

const POOL: ScoutPool = {
  id: 'pool',
  name: 'Invented report',
  gender: 'men',
  format: 'T20',
  source: 'invented',
  date: '2026-10-01',
  players: [
    {
      name: 'Ann Hawk',
      club: 'Riverside',
      union: 'Gauteng',
      role: 'Batter',
      games: 4,
      bat: { inns: 4, runs: 160, balls: 100, sr: 160, avg: 40, hs: '70', fours: 12, sixes: 6 },
      lists: [],
    },
    {
      name: 'Bea Hawk',
      club: 'Old Summit',
      union: 'Gauteng',
      role: 'Bowler',
      games: 4,
      bowl: { overs: '14', runs: 90, wkts: 9, econ: 6.4, best: '4/12' },
      fielding: 2,
      lists: [],
    },
    {
      name: 'Cal Kestrel',
      club: 'Coastal',
      union: 'Western Province',
      role: 'Batter',
      games: 3,
      bat: { runs: 90, balls: 80, sr: 112 },
      lists: [],
    },
  ],
};

const LIONS = focusFor('lions')!;

describe('the focus', () => {
  it('belongs to the Lions tenant only', () => {
    expect(LIONS).toMatchObject({ label: 'Lions', franchise: 'lions', unions: ['Gauteng'] });
    expect(focusFor('LIONS')).toBe(LIONS);
    expect(focusFor('dolphins')).toBeNull();
    expect(focusFor(null)).toBeNull();
  });

  it('knows its union and its franchise', () => {
    expect(inUnion(LIONS, 'Gauteng')).toBe(true);
    expect(inUnion(LIONS, 'gauteng')).toBe(true);
    expect(inUnion(LIONS, 'Northerns')).toBe(false);
    expect(inUnion(LIONS, undefined)).toBe(false);
    expect(inUnion(null, 'Northerns')).toBe(true);
    expect(isOurFranchise(LIONS, 'DP World Lions')).toBe(true);
    expect(isOurFranchise(LIONS, 'DP World Lions Women')).toBe(true);
    expect(isOurFranchise(LIONS, 'Momentum Multiply Titans')).toBe(false);
    // A word, not a substring: "Scallions" is not the Lions.
    expect(isOurFranchise(LIONS, 'Scallions XI')).toBe(false);
  });

  it('narrows pools to the union, and offers its club players as a report', () => {
    expect(focusPools(LIONS, [POOL])[0].players.map((p) => p.name)).toEqual([
      'Ann Hawk',
      'Bea Hawk',
    ]);
    expect(focusPools(null, [POOL])[0].players).toHaveLength(3);
    const events = focusEvents(LIONS, [], [POOL]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'report',
      name: 'Lions club players — Invented report',
      union: 'Gauteng',
    });
    expect(events[0].players.map((p) => p.name)).toEqual(['Ann Hawk', 'Bea Hawk']);
  });

  it("keeps only the union's events, listing its own sides' players", () => {
    const ours = {
      id: 'a',
      union: 'Gauteng',
      ourTeams: ['HAW'],
      players: [
        { name: 'X', hub: 'HAW' },
        { name: 'Y', hub: 'KES' },
      ],
    } as unknown as ScoutingEvent;
    const theirs = { id: 'b', union: 'Western Province', players: [] } as unknown as ScoutingEvent;
    const out = focusEvents(LIONS, [ours, theirs], []);
    expect(out.map((e) => e.id)).toEqual(['a']);
    expect(out[0].players.map((p) => p.name)).toEqual(['X']);
    expect(focusEvents(null, [ours, theirs], [])).toHaveLength(2);
  });
});

describe('building events', () => {
  it('gives teams short, unique codes', () => {
    expect([
      ...teamCodes([
        'Riverside',
        'Old Summit',
        'Hawks 1st XI',
        'Hawks U15 A',
        'Riverbend',
      ]).values(),
    ]).toEqual(['RIV', 'OS', 'HAW1', 'HAW15', 'RIV2']);
  });

  it('turns a report into players and clubs, with no matches', () => {
    const ev = eventFromPool(
      POOL,
      { id: 'r', name: 'R', ageGroup: 'Senior', source: 's', union: 'Gauteng' },
      (p) => p.union === 'Gauteng',
    );
    expect(ev.kind).toBe('report');
    expect(ev.matches).toEqual([]);
    expect(ev.teams.map((t) => t.name)).toEqual(['Riverside', 'Old Summit']);
    const bea = ev.players.find((p) => p.name === 'Bea Hawk')!;
    expect(bea).toMatchObject({
      hub: 'OS',
      ballsBowled: 84,
      wkts: 9,
      econ: 6.4,
      best: '4/12',
      ct: 2,
      runs: null,
    });
    expect(ev.totals).toMatchObject({
      players: 2,
      hubs: 2,
      runs: 160,
      wickets: 9,
      legalBalls: 100,
    });
  });

  it('turns scorecards into players, teams, totals and fixtures, marking our sides', () => {
    const csv = [
      'Competition,League,GameID,Date,Venue,Match,Innings,BattingTeam,BowlingTeam,Over,OverNo,BallInOver,BallSeq,Bowler,Batter,Code,RunsOffBall,Extra,Wicket,Description',
      'F,F U19,1,8 Jan 2026,Oval,Hawks 1st XI vs Kestrels 1st XI,1,Hawks 1st XI,Kestrels 1st XI,0.1,0,1,1,B Kestrel,A Hawk,4,4,,0,Four runs in the cover drive area',
      'F,F U19,1,8 Jan 2026,Oval,Hawks 1st XI vs Kestrels 1st XI,1,Hawks 1st XI,Kestrels 1st XI,0.2,0,2,2,B Kestrel,A Hawk,W,0,,1,Caught by C Kestrel in the third man area',
      'F,F U19,1,8 Jan 2026,Oval,Hawks 1st XI vs Kestrels 1st XI,2,Kestrels 1st XI,Hawks 1st XI,0.1,0,1,1,D Hawk,C Kestrel,1,1,,0,1 run to the fine leg area',
    ].join('\n');
    const ev = eventFromMatches(
      {
        id: 'e',
        name: 'E',
        ageGroup: 'U19',
        source: 's',
        union: 'Gauteng',
        ourTeams: ['Hawks 1st XI'],
      },
      parseWebSports(csv),
    );
    expect(ev.teams.map((t) => [t.code, t.name])).toEqual([
      ['HAW1', 'Hawks 1st XI'],
      ['KES1', 'Kestrels 1st XI'],
    ]);
    expect(ev.ourTeams).toEqual(['HAW1']);
    expect(ev.matches[0]).toMatchObject({ home: 'HAW1', away: 'KES1', winner: 'HAW1' });
    expect(ev.matches[0].innings![0].bat).toBe('HAW1');
    const a = ev.players.find((p) => p.name === 'A Hawk')!;
    expect(a).toMatchObject({ hub: 'HAW1', runs: 4, balls: 2, hs: '4', avg: 4, sr: 200, fours: 1 });
    const c = ev.players.find((p) => p.name === 'C Kestrel')!;
    expect(c).toMatchObject({ hub: 'KES1', ct: 1, runs: 1 });
    expect(ev.players.find((p) => p.name === 'B Kestrel')).toMatchObject({ wkts: 1, best: '1/4' });
    expect(ev.totals).toMatchObject({ matches: 1, hubs: 2, runs: 5, wickets: 1 });
    expect(ev.fixtures[0]).toMatchObject({ battingFirst: 'HAW1', chasing: 'KES1' });
    expect(ev.teams[0]).toMatchObject({ played: 1, won: 1, runsScored: 4 });
  });
});
