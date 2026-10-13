import { describe, it, expect } from 'vitest';
import {
  addDays,
  buildFixtureIndex,
  filterRows,
  groundUsage,
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
    // Played with a result the office hasn't confirmed yet.
    expect(row('s1:f1')).toMatchObject({ state: 'result', issues: ['unconfirmed'] });
    expect(row('s1:f2')).toMatchObject({
      state: 'awaiting-result',
      issues: ['awaiting-result', 'one-umpire'],
    });
    expect(row('s1:f3').issues).toEqual(['venue-clash', 'no-umpires', 'no-scorer']);
    expect(row('s1:f4').issues).toEqual(['venue-clash', 'no-scorer', 'time-tbc']);
    expect(row('s1:f5')).toMatchObject({ state: 'postponed', issues: [] });
    expect(row('s2:w1').issues).toEqual(['no-umpires', 'no-scorer', 'draft']);
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
      'Date,Time,Series,Round,Home,Away,Ground,Umpires,Scorers,Status,Home score,Away score,Result,Confirmed by',
    );
    expect(csv[1]).toBe(
      '2026-10-03,10:00,Division 1,1,UKZN CC,Clares CC,Howard College Oval,A Ump / B Ump,,result,186/7 (49.1),181/5 (50),UKZN CC won by 3 wickets,',
    );
  });

  it('tracks scorers, and whether each result is confirmed — and still the one confirmed', () => {
    const withState = buildFixtureIndex(
      [
        {
          id: 's9',
          name: 'Div 9',
          released: true,
          fixtures: [
            {
              id: 'a',
              date: '2026-10-03',
              time: '10:00',
              home: 'ukzn',
              away: 'clares',
              officials: {
                umpires: [
                  { umpireId: 'u1', name: 'A Ump' },
                  { umpireId: 'u2', name: 'B Ump' },
                ],
                scorers: [{ scorerId: 's1', name: 'Futhi D' }],
              },
              result: {
                homeScore: '1',
                awayScore: '0',
                confirmation: { confirmedAt: '2026-10-04T08:00:00Z', confirmedBy: 'office@x' },
                changedSinceConfirmed: false,
              },
            },
            {
              id: 'b',
              date: '2026-10-03',
              time: '13:00',
              home: 'umlazi',
              away: 'ukzn',
              officials: {
                umpires: [
                  { umpireId: 'u1', name: 'A Ump' },
                  { umpireId: 'u2', name: 'B Ump' },
                ],
              },
              result: {
                homeScore: '2',
                awayScore: '1',
                confirmation: null,
                changedSinceConfirmed: true,
              },
            },
            {
              id: 'c',
              date: '2026-10-10',
              time: '10:00',
              home: 'clares',
              away: 'umlazi',
              officials: { umpires: [], scorers: [{ scorerId: 's1', name: 'Futhi D' }] },
            },
          ],
        },
      ],
      clubs,
      venues,
      TODAY,
    );
    const by = (id: string) => withState.find((r) => r.fixtureId === id)!;
    expect(by('a')).toMatchObject({
      issues: [],
      scorers: ['Futhi D'],
      scorerIds: ['s1'],
      umpireIds: ['u1', 'u2'],
    });
    expect(by('b').issues).toEqual(['result-changed']);
    expect(by('c').issues).toEqual(['no-umpires']);
    expect(weekChecks(withState.filter((r) => inWeek(r, '2026-09-28')))).toMatchObject({
      played: 2,
      resultsIn: 2,
      confirmed: 1,
      toConfirm: 1,
      scorersShort: 0,
    });
    expect(filterRows(withState, { q: 'futhi' }).map((r) => r.fixtureId)).toEqual(['a', 'c']);
    expect(filterRows(withState, { issue: 'result-changed' }).map((r) => r.fixtureId)).toEqual([
      'b',
    ]);
  });
});

describe('ground usage', () => {
  const play = (start: string, mins: number, legalBalls: number) => ({
    startedAt: `${start}T08:00:00.000Z`,
    endedAt: new Date(Date.parse(`${start}T08:00:00.000Z`) + mins * 60_000).toISOString(),
    legalBalls,
    deliveries: legalBalls + 10,
  });
  const g = (
    id: string,
    date: string,
    venue: string,
    p?: ReturnType<typeof play> | null,
    status?: string,
  ) => ({
    id,
    date,
    time: '10:00',
    home: 'ukzn',
    away: 'clares',
    venueOverride: venue,
    ...(status ? { status } : {}),
    ...(p !== undefined ? { result: { homeScore: '1', awayScore: '0', play: p } } : {}),
  });
  const rowsOf = (fixtures: unknown[]) =>
    buildFixtureIndex([{ id: 'u', name: 'U', released: true, fixtures }], clubs, venues, TODAY);

  it('sums time on the ground and balls bowled, and reads the week’s load', () => {
    const usage = groundUsage(
      rowsOf([
        g('a', '2026-09-30', 'Busy Oval', play('2026-09-30', 200, 240)),
        g('b', '2026-10-01', 'Busy Oval', play('2026-10-01', 210, 240)),
        g('c', '2026-10-03', 'Busy Oval', play('2026-10-03', 400, 300)),
        g('d', '2026-10-03', 'Quiet Park', null), // result without scorecard timings
        g('e', '2026-09-01', 'Old Field', play('2026-09-01', 180, 230)),
        g('f', '2026-10-10', 'Quiet Park'), // upcoming
        g('x', '2026-10-03', 'Gone Ground', play('2026-10-03', 180, 230), 'cancelled'),
      ]),
      TODAY,
      2,
    );
    expect(usage.map((u) => [u.venue, u.load])).toEqual([
      ['Busy Oval', 'heavy'],
      ['Quiet Park', 'normal'],
      ['Old Field', 'rested'],
    ]);
    const busy = usage[0];
    expect(busy).toMatchObject({
      played: 3,
      withPlay: 3,
      minutes: 810,
      legalBalls: 780,
      weekGames: 3,
    });
    expect(busy.weekly).toEqual([
      { monday: '2026-09-28', games: 3, balls: 780 },
      { monday: '2026-10-05', games: 0, balls: 0 },
    ]);
    expect(usage[1]).toMatchObject({ played: 1, withPlay: 0, legalBalls: 0, upcoming: 1 });
  });
});
