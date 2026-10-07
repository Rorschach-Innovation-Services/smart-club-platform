/**
 * The chair scorecard page's text lines and rules, and the operator console's week stepping.
 */
import { describe, it, expect } from 'vitest';
import {
  FEEDBACK_MAX,
  extrasLine,
  fallOfWicketsLine,
  feedbackProblem,
  fmtRate,
  headlineScore,
  inningsHeading,
  isWeekKey,
  lastCompletedWeekKey,
  ownSide,
  shiftWeek,
} from './scorecardConfirmHelpers';

describe('scorecard lines', () => {
  it('heads an innings with the total, wickets and overs', () => {
    expect(
      inningsHeading({ battingTeamName: 'UKZN CC', totalRuns: 156, wickets: 7, overs: '20.0' }),
    ).toBe('UKZN CC — 156/7 (20.0)');
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

describe('ownSide', () => {
  it("finds the chair's club by name, ignoring CC and team suffixes", () => {
    expect(ownSide({ homeTeamName: 'UKZN', awayTeamName: 'Crusaders CC' }, 'UKZN CC')).toBe('home');
    expect(
      ownSide({ homeTeamName: 'Berea Rovers CC', awayTeamName: 'UKZN CC 2nd XI' }, 'UKZN CC'),
    ).toBe('away');
  });
  it('gives up when neither or both sides match', () => {
    expect(ownSide({ homeTeamName: 'A CC', awayTeamName: 'B CC' }, 'UKZN CC')).toBeNull();
    expect(
      ownSide({ homeTeamName: 'UKZN 1st XI', awayTeamName: 'UKZN 2nd XI' }, 'UKZN'),
    ).toBeNull();
  });
});

describe('weeks', () => {
  it('accepts only real Sundays', () => {
    expect(isWeekKey('2026-10-04')).toBe(true);
    expect(isWeekKey('2026-10-05')).toBe(false);
    expect(isWeekKey('2026-02-30')).toBe(false);
  });

  it('steps a week at a time across month ends', () => {
    expect(shiftWeek('2026-10-04', -1)).toBe('2026-09-27');
    expect(shiftWeek('2026-09-27', 1)).toBe('2026-10-04');
  });

  it('picks the last completed Mon–Sun week in SAST', () => {
    // Wednesday 7 Oct → the week that ended Sunday 4 Oct.
    expect(lastCompletedWeekKey(new Date('2026-10-07T10:00:00Z'))).toBe('2026-10-04');
    // Monday 5 Oct 06:00 SAST (04:00 UTC) → that Sunday's week just ended.
    expect(lastCompletedWeekKey(new Date('2026-10-05T04:00:00Z'))).toBe('2026-10-04');
    // Sunday 4 Oct (still running) → the week before.
    expect(lastCompletedWeekKey(new Date('2026-10-04T12:00:00Z'))).toBe('2026-09-27');
    // Sunday 23:30 UTC is already Monday in SAST.
    expect(lastCompletedWeekKey(new Date('2026-10-04T23:30:00Z'))).toBe('2026-10-04');
  });
});
