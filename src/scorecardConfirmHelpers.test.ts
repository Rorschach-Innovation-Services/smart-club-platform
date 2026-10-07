/**
 * The scorecard's text lines and the correction-feedback rule.
 */
import { describe, it, expect } from 'vitest';
import {
  FEEDBACK_MAX,
  extrasDetail,
  extrasLine,
  fallOfWicketsLine,
  feedbackProblem,
  fmtRate,
  headlineScore,
  inningsHeading,
  inningsHint,
  isOwnTeam,
  ownInningsFlags,
  totalDetail,
} from './scorecardConfirmHelpers';

describe('scorecard lines', () => {
  it('heads an innings with the total, wickets and overs', () => {
    expect(
      inningsHeading({ battingTeamName: 'UKZN CC', totalRuns: 156, wickets: 7, overs: '20.0' }),
    ).toBe('UKZN CC — 156/7 (20 ov)');
    expect(
      inningsHeading({ battingTeamName: 'UKZN CC', totalRuns: 98, wickets: 10, overs: '18.3' }),
    ).toBe('UKZN CC — 98/10 (18.3 ov)');
  });

  it('hints at the top scorer and the best bowling', () => {
    const batter = (order: number, name: string, runs: number, balls: number, howOut: string) => ({
      order,
      name,
      runs,
      ballsFaced: balls,
      fours: 0,
      sixes: 0,
      strikeRate: 0,
      howOut,
    });
    const bowler = (order: number, name: string, wickets: number, runs: number) => ({
      order,
      name,
      overs: '4.0',
      maidens: 0,
      runsConceded: runs,
      wickets,
      economy: 0,
      wides: 0,
      noBalls: 0,
    });
    expect(
      inningsHint({
        batters: [
          batter(1, 'K. Pillay', 30, 20, 'b Khumalo'),
          batter(2, 'S. Naidoo', 64, 41, 'not out'),
          batter(3, 'A. Slow', 64, 60, 'run out'),
        ],
        bowlers: [bowler(1, 'T. Khumalo', 2, 31), bowler(2, 'M. Dlamini', 2, 24)],
      }),
    ).toBe('Top score S. Naidoo 64* (41) · Best bowling M. Dlamini 2/24');
    expect(inningsHint({ batters: [], bowlers: [] })).toBe('');
  });

  it('describes the total and the extras parts', () => {
    expect(totalDetail({ wickets: 6, overs: '20.0' })).toBe('6 wkts, 20 ov');
    expect(totalDetail({ wickets: 1, overs: '12.4' })).toBe('1 wkt, 12.4 ov');
    expect(totalDetail({ wickets: 10, overs: '17.2' })).toBe('all out, 17.2 ov');
    expect(
      extrasDetail({ byes: 0, legByes: 2, wides: 0, noBalls: 1, penalties: 0, total: 3 }),
    ).toBe('lb 2, nb 1');
  });

  it('lists only the extras that happened', () => {
    expect(extrasLine({ byes: 1, legByes: 0, wides: 6, noBalls: 2, penalties: 0, total: 9 })).toBe(
      'Extras 9 (b 1, w 6, nb 2)',
    );
    expect(extrasLine({ byes: 0, legByes: 0, wides: 0, noBalls: 0, penalties: 0, total: 0 })).toBe(
      'Extras 0',
    );
  });

  it('writes the fall of wickets in wicket order', () => {
    expect(
      fallOfWicketsLine([
        { wicket: 2, runs: 40, overs: '5.1', batterName: 'K. Pillay' },
        { wicket: 1, runs: 23, overs: '2.6', batterName: 'S. Naidoo' },
      ]),
    ).toBe('1-23 (S. Naidoo, 2.6), 2-40 (K. Pillay, 5.1)');
    expect(fallOfWicketsLine([])).toBe('');
  });

  it('rounds rates to two decimals and dashes a missing one', () => {
    expect(fmtRate(133.3333)).toBe('133.33');
    expect(fmtRate(Number.NaN)).toBe('—');
  });

  it('reads the headline score, or nothing when there is none', () => {
    const teams = { homeTeamName: 'UKZN CC', awayTeamName: 'Crusaders CC' };
    expect(headlineScore({ ...teams, result: { homeScore: '150/6', awayScore: null } })).toBe(
      'UKZN CC 150/6 · Crusaders CC —',
    );
    expect(headlineScore({ ...teams, result: { homeScore: null, awayScore: null } })).toBeNull();
    expect(headlineScore(teams)).toBeNull();
  });
});

describe('feedbackProblem', () => {
  it('requires text once trimmed and caps the length', () => {
    expect(feedbackProblem('   ')).toMatch(/what needs correcting/);
    expect(feedbackProblem('x'.repeat(FEEDBACK_MAX))).toBeNull();
    expect(feedbackProblem('x'.repeat(FEEDBACK_MAX + 1))).toMatch(/2000 characters/);
  });
});

describe('own innings matching', () => {
  it('matches the same name, ignoring case and spacing', () => {
    expect(isOwnTeam('  clares   cc ', 'Clares CC')).toBe(true);
  });

  it('strips the "CC" / "Cricket Club" suffix on either side', () => {
    expect(isOwnTeam('Clares', 'Clares CC')).toBe(true);
    expect(isOwnTeam('Clares CC', 'Clares Cricket Club')).toBe(true);
  });

  it('accepts a team named for the club ("Clares 2nd XI")', () => {
    expect(isOwnTeam('Clares 2nd XI', 'Clares CC')).toBe(true);
  });

  it('matches nothing else: another club, a mere letter prefix, a blank club', () => {
    expect(isOwnTeam('Chatsworth', 'Clares CC')).toBe(false);
    expect(isOwnTeam('Claresholm', 'Clares CC')).toBe(false);
    expect(isOwnTeam('Clares', '  ')).toBe(false);
  });

  it('flags every innings the club batted, none when it batted in none', () => {
    expect(ownInningsFlags(['Chatsworth', 'Clares', 'Chatsworth', 'Clares'], 'Clares CC')).toEqual([
      false,
      true,
      false,
      true,
    ]);
    expect(ownInningsFlags(['Chatsworth', 'Umzinto'], 'Clares CC')).toEqual([false, false]);
  });

  it('a derby of two sides named for the club keeps only the exact name, else none', () => {
    expect(ownInningsFlags(['Clares 2nd XI', 'Clares'], 'Clares CC')).toEqual([false, true]);
    expect(ownInningsFlags(['Clares 2nd XI', 'Clares 3rd XI'], 'Clares CC')).toEqual([
      false,
      false,
    ]);
  });
});
