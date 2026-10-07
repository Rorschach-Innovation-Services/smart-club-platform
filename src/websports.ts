/**
 * WebSports ball by ball (the Match Centre's commentary feed, as exported to a sheet): one row
 * per delivery, read into the scouting match shape so a WebSports game opens in the match
 * dashboard like any other — scorecards, worm, runs per over, shot zones. Pure.
 *
 * Columns used: Competition, League, GameID, Date ("8 Jan 2026"), Venue, Match ("A vs B"),
 * Innings, BattingTeam, BowlingTeam, Over ("0.1"), OverNo, Bowler, Batter, Code (WebSports'
 * ball code: 0, 4, W, WB, 1WB, 4NB, 1LB …), RunsOffBall (the change in the team total, extras
 * included), Extra (Wide / No ball / Bye / Leg bye), Wicket (0/1), Description.
 *
 * - Runs off the bat: the ball's runs, less any wide, bye or leg-bye runs; on a no-ball, the
 *   number in the code ("4NB" = 4 off the bat).
 * - How out comes from the description: "Caught by X …", "Bowled", "LBW", "Run Out by X",
 *   "Stumped by X", "Hit Wicket". The feed names the striker, so a non-striker run out is
 *   recorded against the striker.
 * - Shot zones come from "… in the square leg area": WebSports uses six areas, mapped onto
 *   six of the scouting wheel's eight zones (point and mid-wicket stay empty).
 * - The feed can differ from the official scorecard by penalty or bonus runs; totals here are
 *   the feed's.
 */
import { csvRows } from './pathways';
import type { ScoutBatRow, ScoutBowlRow, ScoutInnings, ScoutMatch } from './scouting-matches';

/** WebSports area → scouting zone (third man, point, cover, mid-off, mid-on, mid-wicket, square leg, fine leg). */
const AREA_ZONE: Record<string, number> = {
  'third man': 0,
  'cover drive': 2,
  'off drive': 3,
  'on drive': 4,
  'square leg': 6,
  'fine leg': 7,
};

const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  sept: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

export function isoDate(s: string): string {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(t);
  if (!m) return '';
  const mo = MONTHS[m[2].toLowerCase()] ?? MONTHS[m[2].toLowerCase().slice(0, 3)];
  return mo ? `${m[3]}-${mo}-${m[1].padStart(2, '0')}` : '';
}

/** "… in the square leg area" / "… to the cover drive area" → a zone, or -1. */
export function zoneOf(description: string): number {
  const m = /(?:in|to) the\s+(?:in the\s+)*([a-z ]+?) area/i.exec(description);
  return m ? (AREA_ZONE[m[1].trim().toLowerCase()] ?? -1) : -1;
}

/** The dismissal in the scouting convention ("c X b Y", "b Y", "lbw b Y", "run out (X)", "st X b Y"). */
export function howOut(
  description: string,
  bowler: string,
): { out: string; bowlerWicket: boolean } {
  const d = description.trim();
  const by = /\bby\s+([^()]+?)(?:\s+in the|\s+\(|$)/i.exec(d)?.[1]?.trim();
  if (/^caught/i.test(d)) {
    if (by && by === bowler) return { out: `c & b ${bowler}`, bowlerWicket: true };
    return { out: `c ${by ?? '?'} b ${bowler}`, bowlerWicket: true };
  }
  if (/^bowled/i.test(d)) return { out: `b ${bowler}`, bowlerWicket: true };
  if (/^lbw/i.test(d)) return { out: `lbw b ${bowler}`, bowlerWicket: true };
  if (/^stumped/i.test(d))
    return { out: `st ${by ?? ''} b ${bowler}`.replace('  ', ' '), bowlerWicket: true };
  if (/^hit wicket/i.test(d)) return { out: `hit wicket b ${bowler}`, bowlerWicket: true };
  if (/^run out/i.test(d)) return { out: by ? `run out (${by})` : 'run out', bowlerWicket: false };
  if (/retired/i.test(d)) return { out: 'retired not out', bowlerWicket: false };
  return { out: 'out', bowlerWicket: false };
}

const EXTRA: Record<string, string> = { wide: 'wd', 'no ball': 'nb', bye: 'b', 'leg bye': 'lb' };

export interface WebSportsGame extends ScoutMatch {
  competition: string;
  league: string;
}

interface Ball {
  over: number;
  ball: number;
  batter: string;
  bowler: string;
  bat: number;
  extra: string;
  extraRuns: number;
  wicket: boolean;
  description: string;
}

function innings(bat: string, fld: string, balls: Ball[]): ScoutInnings {
  const batting = new Map<string, ScoutBatRow>();
  const bowling = new Map<
    string,
    ScoutBowlRow & { legal: number; overRuns: Map<number, number> }
  >();
  const fow: ScoutInnings['fow'] = [];
  const perOver = new Map<number, [number, number]>();
  const tuples: NonNullable<ScoutInnings['balls']> = [];
  const exb = { w: 0, nb: 0, b: 0, lb: 0 };
  let total = 0;
  let wkts = 0;
  let legal = 0;
  for (const d of balls) {
    const b =
      batting.get(d.batter) ??
      (batting.set(d.batter, {
        n: d.batter,
        pos: batting.size + 1,
        r: 0,
        b: 0,
        f4: 0,
        f6: 0,
        out: 'not out',
        dots: 0,
      }),
      batting.get(d.batter)!);
    const w =
      bowling.get(d.bowler) ??
      (bowling.set(d.bowler, {
        n: d.bowler,
        o: '0',
        m: 0,
        r: 0,
        w: 0,
        wd: 0,
        nb: 0,
        dots: 0,
        legal: 0,
        overRuns: new Map(),
      }),
      bowling.get(d.bowler)!);
    const runs = d.bat + d.extraRuns;
    total += runs;
    const isLegal = d.extra !== 'wd' && d.extra !== 'nb';
    b.r += d.bat;
    if (d.extra !== 'wd') b.b++;
    if (d.extra !== 'wd' && d.bat === 0) b.dots = (b.dots ?? 0) + 1;
    if (d.bat === 4) b.f4++;
    if (d.bat === 6) b.f6++;
    const charged = d.bat + (d.extra === 'wd' || d.extra === 'nb' ? d.extraRuns : 0);
    w.r += charged;
    w.overRuns.set(d.over, (w.overRuns.get(d.over) ?? 0) + charged);
    if (d.extra === 'wd') w.wd += d.extraRuns;
    if (d.extra === 'nb') w.nb += 1;
    if (isLegal) {
      w.legal++;
      legal++;
      if (charged === 0) w.dots++;
    }
    if (d.extra === 'wd') exb.w += d.extraRuns;
    else if (d.extra === 'nb') exb.nb += d.extraRuns;
    else if (d.extra === 'b') exb.b += d.extraRuns;
    else if (d.extra === 'lb') exb.lb += d.extraRuns;
    const po = perOver.get(d.over + 1) ?? [0, 0];
    po[0] += runs;
    let wk = 0;
    if (d.wicket) {
      const h = howOut(d.description, d.bowler);
      if (h.out !== 'retired not out') {
        b.out = h.out;
        wkts++;
        wk = 1;
        po[1]++;
        if (h.bowlerWicket) w.w++;
        fow.push({ wkt: wkts, score: total, batter: d.batter, over: `${d.over}.${d.ball}` });
      } else b.out = h.out;
    }
    perOver.set(d.over + 1, po);
    tuples.push([
      d.over + 1,
      d.ball,
      d.batter,
      d.bowler,
      d.bat,
      d.extra,
      d.extraRuns,
      wk,
      d.bat > 0 ? zoneOf(d.description) : -1,
    ]);
  }
  const ov = (n: number) => `${Math.floor(n / 6)}${n % 6 ? `.${n % 6}` : ''}`;
  return {
    bat,
    fld,
    total,
    wkts,
    overs: ov(legal),
    extras: exb.w + exb.nb + exb.b + exb.lb,
    exb,
    batting: [...batting.values()],
    bowling: [...bowling.values()].map(({ legal: l, overRuns, ...r }) => ({
      ...r,
      o: ov(l),
      m: [...overRuns.values()].filter((x) => x === 0).length,
    })),
    fow,
    perOver: [...perOver.entries()].sort((a, b) => a[0] - b[0]).map(([o, [r, w]]) => [o, r, w]),
    balls: tuples,
  };
}

/**
 * Read a WebSports ball-by-ball export. `keep` picks games before they are built (e.g. only the
 * games a union's sides played in).
 */
export function parseWebSports(
  text: string,
  keep: (game: { competition: string; league: string; teams: string[] }) => boolean = () => true,
): WebSportsGame[] {
  const rows = csvRows(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim());
  const ix = (k: string) => head.indexOf(k);
  const c = {
    comp: ix('Competition'),
    league: ix('League'),
    game: ix('GameID'),
    date: ix('Date'),
    venue: ix('Venue'),
    match: ix('Match'),
    inn: ix('Innings'),
    bat: ix('BattingTeam'),
    fld: ix('BowlingTeam'),
    overNo: ix('OverNo'),
    ball: ix('BallInOver'),
    bowler: ix('Bowler'),
    batter: ix('Batter'),
    code: ix('Code'),
    runs: ix('RunsOffBall'),
    extra: ix('Extra'),
    wicket: ix('Wicket'),
    desc: ix('Description'),
  };
  if (c.game < 0 || c.batter < 0 || c.bowler < 0 || c.code < 0) return [];
  const games = new Map<string, string[][]>();
  for (const r of rows.slice(1)) {
    const id = r[c.game];
    if (!id) continue;
    games.set(id, [...(games.get(id) ?? []), r]);
  }
  const out: WebSportsGame[] = [];
  for (const [id, rs] of games) {
    const first = rs[0];
    const teams = (first[c.match] ?? '')
      .split(/\s+vs\s+/i)
      .map((s) => s.trim())
      .filter(Boolean);
    const meta = { competition: first[c.comp] ?? '', league: first[c.league] ?? '', teams };
    if (!keep(meta)) continue;
    const byInn = new Map<number, { bat: string; fld: string; balls: Ball[] }>();
    for (const r of rs) {
      const n = Number(r[c.inn]) || 1;
      const code = (r[c.code] ?? '').toUpperCase();
      const total = Number(r[c.runs]) || 0;
      const extra = EXTRA[(r[c.extra] ?? '').trim().toLowerCase()] ?? '';
      let bat = total;
      let extraRuns = 0;
      if (extra === 'nb') {
        bat = Number(/^(\d+)NB$/.exec(code)?.[1] ?? 0);
        extraRuns = total - bat;
      } else if (extra) {
        bat = 0;
        extraRuns = total;
      }
      const g = byInn.get(n) ?? { bat: r[c.bat], fld: r[c.fld], balls: [] };
      g.balls.push({
        over: Number(r[c.overNo]) || 0,
        ball: Number(r[c.ball]) || 0,
        batter: (r[c.batter] ?? '').trim(),
        bowler: (r[c.bowler] ?? '').trim(),
        bat,
        extra,
        extraRuns,
        wicket: r[c.wicket] === '1' || /^W$|^\d*W$/.test(code),
        description: r[c.desc] ?? '',
      });
      byInn.set(n, g);
    }
    const inns = [...byInn.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, g]) => innings(g.bat, g.fld, g.balls));
    const maxOver = Math.max(0, ...inns.flatMap((i) => i.perOver.map(([o]) => o)));
    const overs = maxOver <= 10 ? 10 : maxOver <= 20 ? 20 : maxOver <= 35 ? 35 : 50;
    let winner: string | null = null;
    let result = '';
    if (inns.length === 2) {
      const [a, b] = inns;
      if (b.total > a.total) {
        winner = b.bat;
        result = `${b.bat} won by ${10 - b.wkts} wickets`;
      } else if (a.total > b.total) {
        winner = a.bat;
        result = `${a.bat} won by ${a.total - b.total} runs`;
      } else result = 'Tied';
    }
    out.push({
      id: `ws-${id}`,
      date: isoDate(first[c.date] ?? ''),
      event: overs <= 10 ? 'T10' : overs <= 20 ? 'T20' : `${overs}-Over`,
      stage: meta.league,
      overs,
      venue: first[c.venue] ?? '',
      home: teams[0] ?? inns[0]?.bat ?? '',
      away: teams[1] ?? inns[1]?.bat ?? '',
      winner,
      result,
      innings: inns,
      competition: meta.competition,
      league: meta.league,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
