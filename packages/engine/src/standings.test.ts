import { describe, it, expect } from 'vitest';
import { computeStandings, oversToBalls, parseScore } from './standings';

describe('parseScore', () => {
  it('reads the scorecard formats medicoach sends', () => {
    expect(parseScore('184/6 (20)')).toEqual({ runs: 184, wickets: 6, balls: 120 });
    expect(parseScore('121/4 (17.3)')).toEqual({ runs: 121, wickets: 4, balls: 105 });
    expect(parseScore('184-6 (19.4 ov)')).toEqual({ runs: 184, wickets: 6, balls: 118 });
    expect(parseScore('120 (18.2)')).toEqual({ runs: 120, wickets: null, balls: 110 });
    expect(parseScore('184/6')).toEqual({ runs: 184, wickets: 6, balls: null });
    expect(parseScore('120')).toEqual({ runs: 120, wickets: null, balls: null });
  });
  it('refuses what isn’t a score', () => {
    for (const bad of [null, undefined, '', 'DNB', '184/11 (20)', 'abc (20)'])
      expect(parseScore(bad as string)).toBeNull();
    // Impossible overs: the runs still count, the game just stays out of the run rate.
    expect(parseScore('184/6 (20.6)')).toEqual({ runs: 184, wickets: 6, balls: null });
    expect(oversToBalls('20.7')).toBeNull();
  });
});

const teams = ['A', 'B', 'C', 'D'].map((t) => ({ teamId: t, name: `Team ${t}` }));
const fx = (
  id: string,
  home: string,
  away: string,
  result: Record<string, unknown> | null,
  status?: string,
) => ({
  id,
  home,
  away,
  ...(status ? { status } : {}),
  result,
});

describe('computeStandings', () => {
  it('awards points, counts W/L/T/NR, ranks on points then net run rate', () => {
    const rows = computeStandings({
      teams,
      maxOvers: 20,
      fixtures: [
        fx('f1', 'A', 'B', { homeScore: '160/5 (20)', awayScore: '140/8 (20)', winner: 'home' }),
        fx('f2', 'C', 'D', { homeScore: '120/9 (20)', awayScore: '121/2 (15)', winner: 'away' }),
        fx('f3', 'A', 'C', {
          homeScore: '150/4 (20)',
          awayScore: '150/7 (20)',
          winner: 'tie',
          method: 'tie',
        }),
        fx('f4', 'B', 'D', {
          homeScore: '30/1 (5)',
          awayScore: null,
          noResult: true,
          winner: 'none',
        }),
        fx('f5', 'B', 'C', null), // not played yet
        fx(
          'f6',
          'D',
          'A',
          { homeScore: '200/3 (20)', awayScore: '99 (14.2)', winner: 'home' },
          'cancelled',
        ),
      ],
    });
    expect(
      rows.map((r) => [r.teamId, r.played, r.won, r.lost, r.tied, r.noResult, r.points]),
    ).toEqual([
      ['D', 2, 1, 0, 0, 1, 6],
      ['A', 2, 1, 0, 1, 0, 6],
      ['C', 2, 0, 1, 1, 0, 2],
      ['B', 2, 0, 1, 0, 1, 2],
    ]);
    // D: 121 off 15 overs v 120 off 20 → 8.067 − 6.000
    expect(rows[0].nrr).toBe(2.067);
    // A: (160+150)/40 − (140+150)/40 = 0.5
    expect(rows[1].nrr).toBe(0.5);
    expect(rows[0].form).toEqual(['W', 'N']);
  });

  it('charges a bowled-out side its full quota, and leaves games without overs out of the run rate', () => {
    const [a, b] = computeStandings({
      teams: teams.slice(0, 2),
      maxOvers: 20,
      fixtures: [
        fx('f1', 'A', 'B', { homeScore: '150/6 (20)', awayScore: '90/10 (12)', winner: 'home' }),
        fx('f2', 'B', 'A', { homeScore: '140', awayScore: '141/3', winner: 'away' }),
      ],
    });
    expect(a).toMatchObject({ teamId: 'A', won: 2, points: 8, ballsBowled: 120, runsAgainst: 90 });
    // 150/20 − 90/20 = 3.0 (the bowled-out side faced its full 20 overs, not 12)
    expect(a.nrr).toBe(3);
    expect(b.nrr).toBe(-3);
  });

  it('uses the competition’s points, skips knockout slots and forfeits from the run rate', () => {
    const rows = computeStandings({
      teams: teams.slice(0, 2),
      points: { win: 3, tie: 1, noResult: 1, loss: 0 },
      fixtures: [
        fx('f1', 'A', 'B', {
          homeScore: '1/0 (1)',
          awayScore: '0/0 (1)',
          winner: 'home',
          method: 'forfeit',
        }),
        fx('f2', 'win:f1', 'B', {
          homeScore: '100/1 (10)',
          awayScore: '99/9 (20)',
          winner: 'home',
        }),
      ],
    });
    expect(rows[0]).toMatchObject({ teamId: 'A', points: 3, nrr: null });
    expect(rows[1]).toMatchObject({ teamId: 'B', points: 0, played: 1 });
  });

  it('lists every team even before a ball is bowled, alphabetically', () => {
    expect(
      computeStandings({ teams: [...teams].reverse(), fixtures: [] }).map((r) => r.teamId),
    ).toEqual(['A', 'B', 'C', 'D']);
  });
});
