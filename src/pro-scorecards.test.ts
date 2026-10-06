import { describe, it, expect } from 'vitest';
import {
  csvRows,
  normaliseHowOut,
  parseScorecard,
  parseScorecards,
  seasonOf,
  shortTeam,
} from './pro-scorecards';

// Invented teams and players, in the export's exact layout.
const bat = (rows: [string, string, number, number, number, number, number][]) =>
  rows
    .map(
      ([n, how, r, b, f4, f6, dots]) =>
        `"${n}","${how}","${r}","${b}","${f4}","${f6}","${(b ? (r / b) * 100 : 0).toFixed(1)}","${dots}"`,
    )
    .join('\n');

function card(opts: {
  date: string;
  home: string;
  away: string;
  innings: {
    bat: string;
    label: string;
    total: number;
    extras: [string, number];
    batting: string;
    bowling: string;
    overs: string;
    fow: string;
  }[];
}) {
  const parts = [
    `"MATCH INFO","Date:","${opts.date}"`,
    `"${opts.home}"`,
    `"vs"`,
    `"${opts.away}"`,
    '',
  ];
  for (const i of opts.innings) {
    const fld = i.bat.toLowerCase() === opts.home.toLowerCase() ? opts.away : opts.home;
    parts.push(
      `"${i.bat}","${i.label}"`,
      `"BATTING STATS",""`,
      `"Batter","How Out","R","B","4s","6s","SR","Dots"`,
      i.batting,
      `"TOTAL","","${i.total}","0","0","0","","0"`,
      `"Extras","${i.extras[0]}","${i.extras[1]}"`,
      '',
      `"${fld}",""`,
      `"BOWLING STATS",""`,
      `"Bowler","O","M","R","W","ECON","Dots","WD","NB"`,
      i.bowling,
      `"Total:","${i.overs}","0","0","0","0","0","0","0"`,
      '',
      '',
      `"FALL OF WICKETS"`,
      `"Batter","Score","Over"`,
      i.fow,
      '',
      '',
    );
  }
  return parts.join('\n');
}

const T20 = card({
  date: '2025-10-12',
  home: 'Acme Hawks',
  away: 'Bayside Gulls',
  innings: [
    {
      bat: 'Bayside Gulls',
      label: '2nd innings',
      total: 150,
      extras: ['4w, 1nb, 0b, 2lb, 0p', 7],
      batting: bat([
        ['Gus One', '(c) Ann Hawk, (b) Ben Hawk', 60, 40, 6, 2, 12],
        ['Gus Two', '(lbw) Ben Hawk', 40, 30, 3, 1, 10],
        ['Gus Three', '(run out) Cal Hawk, Ann Hawk', 30, 25, 2, 0, 9],
        ['Gus Four', 'not out', 13, 25, 1, 0, 14],
      ]),
      bowling: `"Ben Hawk","4","0","30","2","7.5","10","1","0"\n"Cal Hawk","4","0","40","0","10.0","8","3","1"`,
      overs: '20',
      fow: `"Gus One","70/1","8.2"\n"Gus Two","120/2","14.0"\n"Gus Three","140/3","18.4"`,
    },
    {
      bat: 'ACME HAWKS',
      label: '1st innings',
      total: 151,
      extras: ['2w, 0nb, 0b, 0lb, 0p', 2],
      batting: bat([
        ['Ann Hawk', '(st) Gus Four, (b) Gus Two', 80, 50, 8, 3, 15],
        ['Ben Hawk', '(c & b) Gus One', 20, 18, 2, 0, 6],
        ['Cal Hawk', 'not out', 49, 30, 4, 2, 8],
      ]),
      bowling: `"Gus One","3.4","0","50","1","13.6","5","2","0"`,
      overs: '18.4',
      fow: `"Ann Hawk","90/1","11.3"\n"Ben Hawk","110/2","13.1"`,
    },
  ],
});

describe('reading the export', () => {
  it('reads quoted fields with commas and doubled quotes', () => {
    expect(csvRows('"a, b","c ""d""",e\r\n"x"')).toEqual([['a, b', 'c "d"', 'e'], ['x']]);
  });

  it('turns every dismissal format into the scouting convention', () => {
    expect(normaliseHowOut('(c) Ann Hawk, (b) Ben Hawk')).toBe('c Ann Hawk b Ben Hawk');
    expect(normaliseHowOut('(b) Ben Hawk')).toBe('b Ben Hawk');
    expect(normaliseHowOut('(lbw) Ben Hawk')).toBe('lbw b Ben Hawk');
    expect(normaliseHowOut('(c & b) Gus One')).toBe('c & b Gus One');
    expect(normaliseHowOut('(st) Gus Four, (b) Gus Two')).toBe('st Gus Four b Gus Two');
    expect(normaliseHowOut('(run out) Cal Hawk, Ann Hawk')).toBe('run out (Cal Hawk+Ann Hawk)');
    expect(normaliseHowOut('(run out) Cal Hawk')).toBe('run out (Cal Hawk)');
    expect(normaliseHowOut('hit wicket (b) Ben Hawk')).toBe('hit wicket b Ben Hawk');
    expect(normaliseHowOut('Retired Out ')).toBe('retired out');
    expect(normaliseHowOut('Retired Not Out')).toBe('retired not out');
    expect(normaliseHowOut('not out')).toBe('not out');
  });

  it('keeps the innings in the order batted, whatever the "innings" label says', () => {
    const m = parseScorecard(T20, 'x')!;
    expect(m.innings!.map((i) => i.bat)).toEqual(['Bayside Gulls', 'Acme Hawks']);
    const [a, b] = m.innings!;
    expect(a).toMatchObject({
      total: 150,
      wkts: 3,
      overs: '20',
      extras: 7,
      exb: { w: 4, nb: 1, b: 0, lb: 2 },
    });
    expect(a.fld).toBe('Acme Hawks');
    expect(a.batting[0]).toMatchObject({
      n: 'Gus One',
      pos: 1,
      r: 60,
      b: 40,
      f4: 6,
      f6: 2,
      dots: 12,
    });
    expect(a.fow[2]).toEqual({ wkt: 3, score: 140, batter: 'Gus Three', over: '18.4' });
    expect(b.bowling[0]).toMatchObject({ n: 'Gus One', o: '3.4', r: 50, w: 1, wd: 2 });
  });

  it('works out format, season and the result from the totals', () => {
    const m = parseScorecard(T20, 'x')!;
    expect(m).toMatchObject({
      format: 'T20',
      gender: 'men',
      season: '2025/26',
      winner: 'Acme Hawks',
      resultKind: 'wickets',
    });
    expect(m.result).toBe('Hawks won by 8 wickets');
    expect(seasonOf('2026-03-01')).toBe('2025/26');
    expect(seasonOf('2026-08-01')).toBe('2026/27');
    expect(shortTeam('WSB Western Province Women')).toBe('Western Province');
    expect(shortTeam('DP World Lions')).toBe('Lions');
  });

  it('leaves a chase cut short by weather unresolved instead of guessing', () => {
    const short = T20.replace('"ACME HAWKS"', '"Acme Hawks"')
      .replace('"TOTAL","","151"', '"TOTAL","","120"')
      .replace(`"Total:","18.4"`, `"Total:","12.0"`);
    const m = parseScorecard(short, 'y')!;
    expect(m.resultKind).toBe('unknown');
    expect(m.winner).toBeNull();
  });

  it('reads a multi-day game and its result (fourth innings bowled out)', () => {
    const inn = (bt: string, total: number, overs: string, wk: number) => ({
      bat: bt,
      label: '1st innings',
      total,
      extras: ['0w, 0nb, 0b, 0lb, 0p', 0] as [string, number],
      batting: bat([
        [`${bt} Opener`, wk >= 10 ? '(b) Someone' : 'not out', total, 300, 20, 1, 200],
      ]),
      bowling: `"Someone","${overs}","5","${total}","${wk}","3.0","200","0","0"`,
      overs,
      fow: Array.from(
        { length: wk },
        (_, k) => `"P${k}","${(k + 1) * 10}/${k + 1}","${k * 5 + 1}.0"`,
      ).join('\n'),
    });
    const md = card({
      date: '2024-11-19',
      home: 'Acme Hawks',
      away: 'Bayside Gulls',
      innings: [
        inn('Acme Hawks', 307, '91.5', 10),
        inn('Bayside Gulls', 193, '69', 10),
        inn('Acme Hawks', 167, '61.5', 10),
        inn('Bayside Gulls', 163, '47.4', 10),
      ],
    });
    const m = parseScorecard(md, 'md')!;
    expect(m.format).toBe('Multi-day');
    expect(m.winner).toBe('Acme Hawks');
    expect(m.result).toBe('Hawks won by 118 runs');
  });

  it('drops a match exported twice', () => {
    const ms = parseScorecards([
      { name: 'a.csv', text: T20 },
      { name: 'a (1).csv', text: T20 },
      { name: 'notes.csv', text: '"hello"' },
    ]);
    expect(ms).toHaveLength(1);
  });
});
