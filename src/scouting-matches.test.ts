import { describe, it, expect } from 'vitest';
import { SAMPLE_TOURNAMENT } from './scouting-sample';
import {
  bowlerOf,
  fielderOf,
  playerLog,
  vsTeams,
  partnerships,
  phaseSplit,
  worm,
  performanceLine,
  isOut,
} from './scouting';

const ev = SAMPLE_TOURNAMENT;
const recorded = ev.matches.filter((m) => m.innings);

describe('match scorecards', () => {
  it('has 12 recorded group matches and 3 summary-only play-offs', () => {
    expect(recorded).toHaveLength(12);
    expect(ev.matches.filter((m) => !m.innings).map((m) => m.stage)).toEqual([
      'Final',
      '5th-place play-off',
      '3rd-place play-off',
    ]);
  });

  it('every innings reconciles: overs and extras add up, batting + extras = total', () => {
    const gaps: string[] = [];
    recorded.forEach((m) =>
      m.innings!.forEach((inn) => {
        expect(worm(inn).at(-1)?.total).toBe(inn.total);
        expect(inn.exb.w + inn.exb.nb + inn.exb.b + inn.exb.lb).toBe(inn.extras);
        const bat = inn.batting.reduce((n, r) => n + r.r, 0);
        if (bat + inn.extras !== inn.total)
          gaps.push(`${inn.bat} ${inn.total}: ${inn.total - bat - inn.extras}`);
      }),
    );
    // The one known gap in the source: CEN's 83 v NTH has 4 runs no batter is credited
    // with (the over-by-over runs agree with 83). The scorecard UI flags it.
    expect(gaps).toEqual(['CEN 83: 4']);
  });

  it('partnerships and phases add back up to the innings total', () => {
    recorded.forEach((m) =>
      m.innings!.forEach((inn) => {
        const parts = partnerships(inn).reduce((n, p) => n + p.runs, 0);
        const phases = phaseSplit(inn, m.overs).reduce((n, p) => n + p.runs, 0);
        expect(phases).toBe(inn.total);
        expect(parts).toBeLessThanOrEqual(inn.total);
      }),
    );
  });
});

describe('fielding credit', () => {
  it('reads catches, stumpings, caught-and-bowled and named run-outs', () => {
    expect(fielderOf('c Karabo Botes b Tumelo Tshabalala')).toEqual({
      names: ['Karabo Botes'],
      kind: 'ct',
    });
    expect(fielderOf('c & b Connor Engelbrecht')).toEqual({
      names: ['Connor Engelbrecht'],
      kind: 'ct',
    });
    expect(fielderOf('st Connor Fraser b X')?.kind).toBe('st');
    expect(fielderOf('run out (Zane Jacobs)')).toEqual({
      names: ['Zane Jacobs'],
      kind: 'ro',
    });
    expect(fielderOf('run out (Vusi Botes+Ruben Rossouw)')?.names).toEqual([
      'Vusi Botes',
      'Ruben Rossouw',
    ]);
    expect(fielderOf('run out')).toBeNull();
    expect(fielderOf('b Nathan Govindsamy')).toBeNull();
    expect(fielderOf('c ? b X')).toBeNull();
  });
});

describe('bowler credit', () => {
  it('names the bowler for bowled, lbw, caught, stumped and caught-and-bowled', () => {
    expect(bowlerOf('b Nathan Govindsamy')).toBe('Nathan Govindsamy');
    expect(bowlerOf('lbw b Fezile Nel')).toBe('Fezile Nel');
    expect(bowlerOf('c Karabo Botes b Tumelo Tshabalala')).toBe('Tumelo Tshabalala');
    expect(bowlerOf('st Luca Hadebe b Aphiwe Nel-Shaw')).toBe('Aphiwe Nel-Shaw');
    expect(bowlerOf('c & b Connor Engelbrecht')).toBe('Connor Engelbrecht');
    expect(bowlerOf('run out (Zane Jacobs)')).toBeNull();
    expect(bowlerOf('not out')).toBeNull();
  });
  it("matches each bowler's wickets in every scorecard (one known source gap)", () => {
    const gaps: string[] = [];
    recorded.forEach((m) =>
      m.innings!.forEach((inn) =>
        inn.bowling.forEach((b) => {
          const credited = inn.batting.filter((r) => isOut(r) && bowlerOf(r.out) === b.n).length;
          if (credited !== b.w) gaps.push(`${b.n} ${b.w}/${credited}`);
        }),
      ),
    );
    // Source: Botes's figures show 3 wickets but only 2 dismissals name him (the bowler
    // panel notes the gap).
    expect(gaps).toEqual(['Vusi Botes 3/2']);
  });
});

describe('player logs', () => {
  it("builds a player's match log and record against each team", () => {
    const log = playerLog(ev, 'Gareth Ochse', 'NTH');
    expect(log.map((l) => l.opp)).toEqual(['STH', 'CST', 'CEN', 'EST']);
    expect(log.reduce((n, l) => n + (l.bat?.r ?? 0), 0)).toBe(121); // 136 less the Final's 15
    const v = vsTeams(log);
    expect(v.find((t) => t.opp === 'CEN')).toMatchObject({ runs: 76, balls: 47, outs: 1 });
    expect(performanceLine(log[1])).toBe('36* (39)');
  });

  it('never credits more than the season register', () => {
    ev.players.forEach((p) => {
      const log = playerLog(ev, p.name, p.hub);
      const runs = log.reduce((n, l) => n + (l.bat?.r ?? 0), 0);
      const wkts = log.reduce((n, l) => n + (l.bowl?.w ?? 0), 0);
      expect(runs).toBeLessThanOrEqual(p.runs ?? 0);
      expect(wkts).toBeLessThanOrEqual(p.wkts ?? 0);
    });
  });

  it('treats not-out as not out', () => {
    expect(isOut({ n: 'x', pos: 1, r: 5, b: 3, f4: 0, f6: 0, out: 'not out' })).toBe(false);
    expect(isOut({ n: 'x', pos: 1, r: 5, b: 3, f4: 0, f6: 0, out: 'b Y' })).toBe(true);
  });
});
