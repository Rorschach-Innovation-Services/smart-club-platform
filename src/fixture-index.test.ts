import { describe, it, expect } from 'vitest';
import {
  addDays,
  buildFixtureIndex,
  filterRows,
  inWeek,
  resultLines,
  toCsv,
  weekChecks,
  weekStart,
  type IndexSeries,
} from './fixture-index';

const TODAY = '2026-10-05'; // a Monday

const clubs = [
  { id: 'ukzn', name: 'UKZN CC', ground: { venue: 'Howard College Oval' } },
  { id: 'clares', name: 'Clares CC', ground: { venue: 'Clares Park' } },
  { id: 'umlazi', name: 'Umlazi CC', ground: { venue: 'Umlazi Comtech' } },
];
const venues = [
  { id: 'v-hco', name: 'Howard College Oval', surfaces: 1 },
  { id: 'v-kings', name: 'Kingsmead', surfaces: 2 },
];
const umps = (...names: string[]) => ({ umpires: names.map((name) => ({ name })) });

const d1: IndexSeries = {
  id: 's1',
  name: 'Division 1',
  leagueKey: 'premier',
  maxOvers: 50,
  released: true,
  fixtures: [
    {
      id: 'f1',
      round: 1,
      date: '2026-10-03',
      time: '10:00',
      home: 'ukzn',
      away: 'clares',
      officials: umps('A Ump', 'B Ump'),
      result: {
        homeScore: '186/7 (49.1)',
        awayScore: '181/5 (50)',
        summary: 'UKZN CC won by 3 wickets',
        winner: 'home',
      },
    },
    // Played, no result yet, one umpire.
    {
      id: 'f2',
      round: 1,
      date: '2026-10-03',
      time: '13:00',
      home: 'umlazi',
      away: 'ukzn',
      officials: umps('C Ump'),
    },
    // This weekend: same ground as f4 on the same day → double-booked (1 pitch).
    { id: 'f3', round: 2, date: '2026-10-10', time: '10:00', home: 'ukzn', away: 'umlazi' },
    {
      id: 'f4',
      round: 2,
      date: '2026-10-10',
      home: 'clares',
      away: 'ukzn',
      venueId: 'v-hco',
      officials: umps('A Ump', 'B Ump'),
    },
    { id: 'f5', round: 2, date: '2026-10-10', home: 'umlazi', away: 'clares', status: 'postponed' },
  ],
};
const draft: IndexSeries = {
  id: 's2',
  name: 'Women T20',
  released: false,
  participants: [
    { teamId: 'tm_ukzn_w', clubId: 'ukzn', name: 'UKZN Women' },
    { teamId: 'win:sf1', clubId: '', name: '' },
  ],
  fixtures: [
    {
      id: 'w1',
      date: '2026-10-11',
      time: '09:00',
      home: 'tm_ukzn_w',
      away: 'win:sf1',
      venueOverride: 'Kingsmead',
    },
  ],
};

const rows = buildFixtureIndex([d1, draft], clubs, venues, TODAY);
const row = (k: string) => rows.find((r) => r.key === k)!;

describe('fixture index', () => {
  it('flattens every series, sorted by date and time, with names and grounds resolved', () => {
    expect(rows.map((r) => r.key)).toEqual(['s1:f1', 's1:f2', 's1:f3', 's1:f4', 's1:f5', 's2:w1']);
    expect(row('s1:f1')).toMatchObject({
      home: 'UKZN CC',
      away: 'Clares CC',
      venue: 'Howard College Oval',
    });
    expect(row('s1:f4').venue).toBe('Howard College Oval'); // the allocated ground
    expect(row('s2:w1')).toMatchObject({
      home: 'UKZN Women',
      away: 'To be decided',
      homeClubId: 'ukzn',
      venue: 'Kingsmead',
    });
  });

  it('reads where each fixture stands and what the weekly checks flag', () => {
    expect(row('s1:f1')).toMatchObject({ state: 'result', issues: [] });
    expect(row('s1:f2')).toMatchObject({
      state: 'awaiting-result',
      issues: ['awaiting-result', 'one-umpire'],
    });
    expect(row('s1:f3').issues).toEqual(['venue-clash', 'no-umpires']);
    expect(row('s1:f4').issues).toEqual(['venue-clash', 'time-tbc']);
    expect(row('s1:f5')).toMatchObject({ state: 'postponed', issues: [] });
    expect(row('s2:w1').issues).toEqual(['no-umpires', 'draft']);
    expect(resultLines(row('s1:f1'))).toEqual({
      home: '186/7 (49.1)',
      away: '181/5 (50)',
      summary: 'UKZN CC won by 3 wickets',
      winner: 'home',
    });
    expect(resultLines(row('s1:f2'))).toBeNull();
  });

  it('works in Monday-to-Sunday weeks', () => {
    expect(weekStart('2026-10-05')).toBe('2026-10-05');
    expect(weekStart('2026-10-11')).toBe('2026-10-05');
    expect(weekStart('2026-10-03')).toBe('2026-09-28');
    expect(addDays('2026-10-05', -7)).toBe('2026-09-28');
    expect(rows.filter((r) => inWeek(r, '2026-09-28')).map((r) => r.fixtureId)).toEqual([
      'f1',
      'f2',
    ]);
    expect(weekChecks(rows.filter((r) => inWeek(r, '2026-09-28')))).toMatchObject({
      games: 2,
      played: 2,
      resultsIn: 1,
      awaitingResult: 1,
      umpiresShort: 1,
    });
    expect(weekChecks(rows.filter((r) => inWeek(r, '2026-10-05')))).toMatchObject({
      games: 4,
      clashes: 2,
      incomplete: 1,
      postponed: 1,
      drafts: 1,
    });
  });

  it('finds fixtures by any word of a team, ground, series, umpire or round', () => {
    const keys = (f: Parameters<typeof filterRows>[1]) =>
      filterRows(rows, f).map((r) => r.fixtureId);
    expect(keys({ q: 'umlazi howard' })).toEqual(['f3']);
    expect(keys({ q: 'b ump' })).toEqual(['f1', 'f4']);
    expect(keys({ q: 'round 1' })).toEqual(['f1', 'f2']);
    expect(keys({ q: 'r2 umlazi' })).toEqual(['f3', 'f5']);
    expect(keys({ q: 'won by 3' })).toEqual(['f1']);
    expect(keys({ clubId: 'clares' })).toEqual(['f1', 'f4', 'f5']);
    expect(keys({ venue: 'kingsmead' })).toEqual(['w1']);
    expect(keys({ state: 'played' })).toEqual(['f1', 'f2']);
    expect(keys({ state: 'off' })).toEqual(['f5']);
    expect(keys({ issue: 'venue-clash' })).toEqual(['f3', 'f4']);
    expect(keys({ issue: 'any', seriesId: 's2' })).toEqual(['w1']);
    expect(keys({ from: '2026-10-10', to: '2026-10-10' })).toEqual(['f3', 'f4', 'f5']);
  });

  it('exports the list as CSV, quoting where needed', () => {
    const csv = toCsv([row('s1:f1')]).split('\n');
    expect(csv[0]).toBe(
      'Date,Time,Series,Round,Home,Away,Ground,Umpires,Status,Home score,Away score,Result',
    );
    expect(csv[1]).toBe(
      '2026-10-03,10:00,Division 1,1,UKZN CC,Clares CC,Howard College Oval,A Ump / B Ump,result,186/7 (49.1),181/5 (50),UKZN CC won by 3 wickets',
    );
  });
});
