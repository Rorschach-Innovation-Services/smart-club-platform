/**
 * The competitions table and one series' views (ADR 0018): grouping every series into one
 * row, the league table from joined results, the results matrix and home/away balance.
 */
import { describe, it, expect } from 'vitest';
import { planCompetition, type CompetitionSpec } from '../packages/engine/src/competition';
import {
  groupCompetitions,
  homeAwayBalance,
  resultsMatrix,
  seriesStandings,
  teamNames,
  type CmpSeries,
} from './competitions';

const team = (i: number) => ({ teamId: `t${i}`, clubId: `t${i}`, name: `Team ${i}` });
const plan = (over: Partial<CompetitionSpec> = {}) => {
  const p = planCompetition({
    id: 'c-cup',
    type: 'tournament',
    name: 'Cup',
    overs: 20,
    teams: [1, 2, 3, 4, 5, 6, 7, 8].map(team),
    format: { kind: 'groups-knockout', groups: 2, qualifiers: 2, legs: 1 },
    schedule: { startDate: '2026-10-10', everyDays: 7, times: ['10:00'] },
    ...over,
  });
  if ('problems' in p) throw new Error(p.problems.join());
  return p.series as unknown as CmpSeries[];
};
const plain = (over: Partial<CmpSeries>): CmpSeries => ({
  id: 's1',
  name: 'Series',
  fixtures: [],
  ...over,
});

describe('groupCompetitions — one row per league, tournament, season or schedule', () => {
  it('folds a tournament’s groups and knockout into one row, groups first', () => {
    const cup = plan();
    const [row] = groupCompetitions([cup[2], cup[1], cup[0]]);
    expect(row).toMatchObject({
      key: 'c:c-cup',
      kind: 'competition',
      name: 'Cup',
      typeLabel: 'Tournament',
      teams: 8,
      fixtures: 6 + 6 + 3,
      played: 0,
      firstDate: '2026-10-10',
      status: 'Draft',
    });
    expect(row.formatLabel).toBe('2 groups → knockout (top 2) · 20 overs');
    expect(row.series.map((s) => s.id)).toEqual(['c-cup-g1', 'c-cup-g2', 'c-cup-ko']);
  });

  it('labels seasons and loose series for what they are, and orders competitions first', () => {
    const rows = groupCompetitions(
      [
        plain({ id: 's-planb-premier', name: 'Plan B import' }),
        plain({ id: 's-hand', name: 'Hand-made cup' }),
        plain({ id: 's-run-a', name: 'Stage 1', seasonRunId: 'run-1' }),
        plain({ id: 's-run-b', name: 'Stage 2', seasonRunId: 'run-1' }),
        ...plan({ type: 'league', format: { kind: 'round-robin', legs: 1 }, id: 'c-lg' }),
      ],
      [{ id: 'run-1', leagueKey: 'premier', seasonLabel: '2026/27' }],
      (k) => (k === 'premier' ? 'Premier League' : k),
    );
    expect(rows.map((r) => [r.name, r.typeLabel, r.series.length])).toEqual([
      ['Cup', 'League', 1],
      ['Premier League · 2026/27', 'Season', 2],
      ['Hand-made cup', 'Stand-alone series', 1],
      ['Plan B import', 'Imported schedule', 1],
    ]);
  });

  it('says Released, Partly released or Approved only when every part agrees', () => {
    const cup = plan();
    const status = (flags: Array<[boolean, boolean]>) =>
      groupCompetitions(
        cup.map((s, i) => ({ ...s, approved: flags[i][0], released: flags[i][1] })),
      )[0].status;
    expect(
      status([
        [true, true],
        [true, true],
        [true, true],
      ]),
    ).toBe('Released');
    expect(
      status([
        [true, true],
        [true, false],
        [false, false],
      ]),
    ).toBe('Partly released');
    expect(
      status([
        [true, false],
        [true, false],
        [true, false],
      ]),
    ).toBe('Approved');
    expect(
      status([
        [true, false],
        [false, false],
        [true, false],
      ]),
    ).toBe('Draft');
  });
});

describe('one series’ views', () => {
  const s = plain({
    teams: ['a', 'b', 'c'],
    participants: [
      { teamId: 'a', name: 'Alpha' },
      { teamId: 'b', name: 'Bravo' },
      { teamId: 'c', name: 'Charlie' },
    ],
    maxOvers: 20,
    fixtures: [
      {
        id: 'f1',
        round: 1,
        date: '2026-10-10',
        home: 'a',
        away: 'b',
        result: { homeScore: '160/5 (20)', awayScore: '120/9 (20)', winner: 'home' },
      },
      {
        id: 'f2',
        round: 2,
        date: '2026-10-17',
        home: 'b',
        away: 'c',
        result: { noResult: true, winner: 'none' },
      },
      { id: 'f3', round: 3, date: '2026-10-24', home: 'c', away: 'a' },
      { id: 'f4', round: 3, date: '2026-10-24', home: 'a', away: 'c', status: 'cancelled' },
    ],
  });
  const names = teamNames(s, () => undefined);

  it('ranks the table on points then net run rate, by the default cricket points', () => {
    const rows = seriesStandings(s, names);
    expect(rows.map((r) => [r.name, r.played, r.won, r.noResult, r.points])).toEqual([
      ['Alpha', 1, 1, 0, 4],
      ['Bravo', 2, 0, 1, 2],
      ['Charlie', 1, 0, 1, 2],
    ]);
    expect(rows[0].nrr).toBeCloseTo(2, 3); // 8 rpo for, 6 against
  });

  it('uses the competition’s own points when it has them', () => {
    const custom = {
      ...s,
      competition: {
        ...plan()[0].competition!,
        points: { win: 2, tie: 1, noResult: 1, loss: 0 },
      },
    };
    expect(seriesStandings(custom, names)[0].points).toBe(2);
  });

  it('fills the results matrix home-row by away-column, with when it is scheduled otherwise', () => {
    const { ids, cells } = resultsMatrix(s, names);
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(cells.get('a|b')).toMatchObject({ label: '160/5 (20) v 120/9 (20)', outcome: 'won' });
    expect(cells.get('b|c')).toMatchObject({ label: 'No result', outcome: 'nr' });
    expect(cells.get('c|a')).toMatchObject({ label: 'R3 · 24 Oct', outcome: 'upcoming' });
    expect(cells.get('a|c')).toMatchObject({ label: 'Cancelled', outcome: 'off' });
    expect(cells.has('b|a')).toBe(false);
  });

  it('counts home and away games, leaving cancelled ones out', () => {
    expect(homeAwayBalance(s, names)).toEqual([
      { teamId: 'a', name: 'Alpha', home: 1, away: 1 },
      { teamId: 'b', name: 'Bravo', home: 1, away: 1 },
      { teamId: 'c', name: 'Charlie', home: 1, away: 1 },
    ]);
  });
});
