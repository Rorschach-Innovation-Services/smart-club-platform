import { describe, it, expect } from 'vitest';
import { howOut, isoDate, parseWebSports, zoneOf } from './websports';

const HEAD =
  'Competition,League,GameID,Date,Venue,Match,Innings,BattingTeam,BowlingTeam,Over,OverNo,BallInOver,BallSeq,Bowler,Batter,Code,RunsOffBall,Extra,Wicket,Description,TeamScore,TeamRuns,TeamWkts,BowlerFigures,EventID';

// An invented game in WebSports' layout: Hawks 1st XI bat first, Kestrels 1st XI chase.
type Ball = [
  inn: number,
  over: number,
  ball: number,
  bowler: string,
  batter: string,
  code: string,
  runs: number,
  extra: string,
  wicket: 0 | 1,
  desc: string,
];
const B = (inn: 1 | 2): Ball[] =>
  inn === 1
    ? [
        [1, 0, 1, 'B Kestrel', 'A Hawk', '0', 0, '', 0, 'Dot ball'],
        [1, 0, 2, 'B Kestrel', 'A Hawk', '4', 4, '', 0, 'Four runs in the cover drive area'],
        [1, 0, 3, 'B Kestrel', 'A Hawk', 'WB', 1, 'Wide', 0, 'Wide'],
        [
          1,
          0,
          3,
          'B Kestrel',
          'A Hawk',
          '4NB',
          5,
          'No ball',
          0,
          'No ball, four runs in the square leg area',
        ],
        [1, 0, 4, 'B Kestrel', 'A Hawk', '1LB', 1, 'Leg bye', 0, 'Leg bye'],
        [
          1,
          0,
          5,
          'B Kestrel',
          'C Hawk',
          'W',
          0,
          '',
          1,
          'Caught by D Kestrel in the third man area',
        ],
        [1, 0, 6, 'B Kestrel', 'E Hawk', '6', 6, '', 0, 'Six runs to the on drive area'],
        [
          1,
          1,
          1,
          'D Kestrel',
          'E Hawk',
          'W',
          1,
          '',
          1,
          'Run Out by B Kestrel (1 run to the cover drive area)',
        ],
        [1, 1, 2, 'D Kestrel', 'A Hawk', 'W', 0, '', 1, 'Bowled'],
      ]
    : [
        [2, 0, 1, 'A Hawk', 'B Kestrel', '1', 1, '', 0, '1 run to the fine leg area'],
        [2, 0, 2, 'A Hawk', 'D Kestrel', 'W', 0, '', 1, 'LBW'],
        [2, 0, 3, 'A Hawk', 'F Kestrel', '2', 2, '', 0, '2 runs to the off drive area'],
      ];
const row = (b: Ball) => {
  const [inn, over, ball, bowler, batter, code, runs, extra, wicket, desc] = b;
  const bat = inn === 1 ? 'Hawks 1st XI' : 'Kestrels 1st XI';
  const fld = inn === 1 ? 'Kestrels 1st XI' : 'Hawks 1st XI';
  return [
    'Invented Festival',
    'Invented Festival U19',
    '9001',
    '8 Jan 2026',
    'Hawks Oval',
    'Hawks 1st XI vs Kestrels 1st XI',
    inn,
    bat,
    fld,
    `${over}.${ball}`,
    over,
    ball,
    1,
    bowler,
    batter,
    code,
    runs,
    extra,
    wicket,
    `"${desc}"`,
    '',
    '',
    '',
    '',
    '',
  ].join(',');
};
const CSV = [HEAD, ...B(1).map(row), ...B(2).map(row)].join('\n');

describe('reading a WebSports ball', () => {
  it('reads dates, shot areas and dismissals', () => {
    expect(isoDate('8 Jan 2026')).toBe('2026-01-08');
    expect(isoDate('10 Sept 2026')).toBe('2026-09-10');
    expect(zoneOf('Four runs in the cover drive area')).toBe(2);
    expect(zoneOf('1 run to the fine leg area')).toBe(7);
    expect(zoneOf('Dot ball')).toBe(-1);
    expect(howOut('Caught by D Kestrel in the third man area', 'B Kestrel').out).toBe(
      'c D Kestrel b B Kestrel',
    );
    expect(howOut('Caught by B Kestrel', 'B Kestrel').out).toBe('c & b B Kestrel');
    expect(howOut('Caught in the off drive area', 'B Kestrel').out).toBe('c ? b B Kestrel');
    expect(howOut('Run Out by B Kestrel (1 run to the cover drive area)', 'D Kestrel')).toEqual({
      out: 'run out (B Kestrel)',
      bowlerWicket: false,
    });
    expect(howOut('Stumped by G Kestrel', 'B Kestrel').out).toBe('st G Kestrel b B Kestrel');
    expect(howOut('LBW', 'B Kestrel').out).toBe('lbw b B Kestrel');
  });
});

describe('a WebSports game', () => {
  const [g] = parseWebSports(CSV);
  const [hawks, kestrels] = g.innings!;

  it('builds the match: date, sides, result from the totals', () => {
    expect(g).toMatchObject({
      id: 'ws-9001',
      date: '2026-01-08',
      home: 'Hawks 1st XI',
      away: 'Kestrels 1st XI',
      competition: 'Invented Festival',
      stage: 'Invented Festival U19',
      venue: 'Hawks Oval',
    });
    expect([hawks.total, hawks.wkts, kestrels.total, kestrels.wkts]).toEqual([18, 3, 3, 1]);
    expect(g.winner).toBe('Hawks 1st XI');
    expect(g.result).toBe('Hawks 1st XI won by 15 runs');
  });

  it('splits bat runs from extras and charges the bowler correctly', () => {
    const a = hawks.batting.find((b) => b.n === 'A Hawk')!;
    // 4 + 4 (off the no-ball); the wide isn't faced, the no-ball and leg bye are.
    expect(a).toMatchObject({ r: 8, b: 5, f4: 2, out: 'b D Kestrel' });
    expect(hawks.exb).toEqual({ w: 1, nb: 1, b: 0, lb: 1 });
    const bk = hawks.bowling.find((b) => b.n === 'B Kestrel')!;
    // 4 + wide 1 + no-ball 5 + 6 = 16; the leg bye isn't the bowler's. Seven deliveries, two
    // of them illegal: five legal balls.
    expect(bk).toMatchObject({ r: 16, w: 1, wd: 1, nb: 1, o: '0.5' });
  });

  it('credits a run out to nobody, records the fall of wickets and shot zones', () => {
    expect(hawks.batting.find((b) => b.n === 'E Hawk')!.out).toBe('run out (B Kestrel)');
    expect(hawks.bowling.find((b) => b.n === 'D Kestrel')!.w).toBe(1);
    expect(hawks.fow.map((f) => f.batter)).toEqual(['C Hawk', 'E Hawk', 'A Hawk']);
    expect(hawks.perOver).toEqual([
      [1, 17, 1],
      [2, 1, 2],
    ]);
    // The run-out ball's single was hit to the cover drive area too.
    const zones = hawks.balls!.filter((b) => b[4] > 0).map((b) => b[8]);
    expect(zones).toEqual([2, 6, 4, 2]);
  });

  it('keeps only the games asked for', () => {
    expect(parseWebSports(CSV, (m) => m.teams.includes('Somebody else'))).toEqual([]);
    expect(parseWebSports(CSV, (m) => m.teams.includes('Hawks 1st XI'))).toHaveLength(1);
  });
});
