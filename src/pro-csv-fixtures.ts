/**
 * Test fixtures: invented teams and players written in the exports' exact layouts (the
 * "Scorecard CSV" and the "Ball by Ball" CSV), for the scorecard reader and the importer.
 */

export const bat = (rows: [string, string, number, number, number, number, number][]) =>
  rows
    .map(
      ([n, how, r, b, f4, f6, dots]) =>
        `"${n}","${how}","${r}","${b}","${f4}","${f6}","${(b ? (r / b) * 100 : 0).toFixed(1)}","${dots}"`,
    )
    .join('\n');

export function card(opts: {
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

/** One delivery: [innings, over.ball (0-based over), outcome, batter, bowler, commentary?]. */
export type Ball = [number, string, string, string, string, string?];

/** A "Ball by Ball" export: header row, then one quoted row per delivery. */
export function ballByBall(opts: {
  id: string;
  competition: string;
  date: string;
  teams: [string, string];
  balls: Ball[];
}) {
  const head =
    'match_id,competition,date,innings_no,innings,batting_team,over_ball,outcome,runs,extra_type,wicket,bowler,batter,commentary';
  const rows = opts.balls.map(([inn, ob, outcome, batter, bowler, comm]) => {
    const runs = /^(\d+)/.exec(outcome)?.[1] ?? '0';
    const wicket = /W/.test(outcome) ? '1' : '0';
    const cells = [
      opts.id,
      opts.competition,
      opts.date,
      String(inn),
      inn === 1 ? '1st' : '2nd',
      opts.teams[inn % 2 === 1 ? 0 : 1],
      ob,
      outcome,
      runs,
      '',
      wicket,
      bowler,
      batter,
      comm ?? `${runs} run`,
    ];
    return cells.map((c) => `"${c}"`).join(',');
  });
  return [head, ...rows].join('\n');
}
