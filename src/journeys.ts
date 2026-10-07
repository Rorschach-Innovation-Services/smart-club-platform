/**
 * Player journeys: one record per player, season by season, across every setting a player
 * appears in — school, club, representative weeks, the franchise. Pure; no React.
 *
 * It answers two questions the results export can't, because that export has teams and no
 * players:
 *   1. Performance and participation by age bracket — balls faced and bowled, averages, medians,
 *      how often an innings is a bust or a boom — with a benchmark for each bracket and the
 *      outliers against it.
 *   2. The route to the professional game — where each player started (school, club), how many
 *      games they have played in each setting, when they came into the data and when they left
 *      it, and where the gaps in the pipeline are.
 *
 * A player's rating is always against their own bracket, format and gender (never raw numbers
 * across brackets: a U13 average and a franchise average are different things). A bracket's
 * benchmark is the top tenth of qualifying players. The data only goes back to when the union
 * started recording, so a player is "seen from" a season, not "born into" the system.
 */
import type { ProFormat } from './pro-scorecards';

export type Gender = 'men' | 'women';
export type Format = ProFormat;
export type Setting = 'school' | 'club' | 'rep' | 'pro';

export const BRACKETS = ['U9', 'U11', 'U13', 'U15', 'U17', 'U19', 'Senior', 'Pro'] as const;
export type Bracket = (typeof BRACKETS)[number];
export const rungOf = (b: Bracket) => BRACKETS.indexOf(b);

export const SETTINGS: Setting[] = ['school', 'club', 'rep', 'pro'];
export const SETTING_LABEL: Record<Setting, string> = {
  school: 'School',
  club: 'Club',
  rep: 'Representative',
  pro: 'Franchise',
};

/** One innings: runs, balls faced, and whether the player was out. */
export interface Innings {
  r: number;
  b: number;
  out: boolean;
}
/** One bowling spell: balls bowled, runs conceded, wickets. */
export interface Spell {
  b: number;
  r: number;
  w: number;
}

/** A player's season in one team, one format. */
export interface SeasonRow {
  season: number;
  setting: Setting;
  /** The school, club or franchise. */
  team: string;
  /** The team's own label — "U15 A", "1st XI", "Premier League". */
  level: string;
  bracket: Bracket;
  format: Format;
  games: number;
  bat: Innings[];
  bowl: Spell[];
}

export interface JourneyPlayer {
  id: string;
  name: string;
  gender: Gender;
  rows: SeasonRow[];
}

/* ─── Counting ─── */

export interface Tally {
  games: number;
  inns: number;
  outs: number;
  runs: number;
  balls: number;
  hs: number;
  scores: number[];
  bBalls: number;
  bRuns: number;
  wkts: number;
  spells: number;
}

export function tally(rows: SeasonRow[]): Tally {
  const t: Tally = {
    games: 0,
    inns: 0,
    outs: 0,
    runs: 0,
    balls: 0,
    hs: 0,
    scores: [],
    bBalls: 0,
    bRuns: 0,
    wkts: 0,
    spells: 0,
  };
  for (const r of rows) {
    t.games += r.games;
    for (const i of r.bat) {
      t.inns++;
      t.runs += i.r;
      t.balls += i.b;
      if (i.out) t.outs++;
      t.hs = Math.max(t.hs, i.r);
      t.scores.push(i.r);
    }
    for (const s of r.bowl) {
      t.spells++;
      t.bBalls += s.b;
      t.bRuns += s.r;
      t.wkts += s.w;
    }
  }
  return t;
}

export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
export const median = (xs: number[]) =>
  quantile(
    [...xs].sort((a, b) => a - b),
    0.5,
  );

/** Runs per dismissal (null until the player has been out). */
export const average = (t: Tally) => (t.outs ? t.runs / t.outs : null);
export const strikeRate = (t: Tally) => (t.balls ? (t.runs / t.balls) * 100 : null);
export const medianScore = (t: Tally) => median(t.scores);
export const economy = (t: Tally) => (t.bBalls ? (t.bRuns / t.bBalls) * 6 : null);
export const ballsPerWicket = (t: Tally) => (t.wkts ? t.bBalls / t.wkts : null);

/**
 * "Bust" and "boom" scores by bracket: an innings under the first number is a bust, one at or
 * over the second a boom. They grow with the age group because the games get longer.
 */
export const BANDS: Record<Bracket, [number, number]> = {
  U9: [5, 15],
  U11: [8, 20],
  U13: [10, 25],
  U15: [10, 30],
  U17: [10, 30],
  U19: [10, 30],
  Senior: [10, 30],
  Pro: [10, 30],
};

export interface BoomBust {
  bust: number;
  steady: number;
  boom: number;
  n: number;
}
/** Share of innings (0–1) that were busts, steady, and booms. */
export function boomBust(rows: SeasonRow[], bracket: Bracket): BoomBust {
  const [lo, hi] = BANDS[bracket];
  let bust = 0;
  let boom = 0;
  let n = 0;
  for (const r of rows)
    for (const i of r.bat) {
      n++;
      if (i.r < lo) bust++;
      else if (i.r >= hi) boom++;
    }
  return n
    ? { bust: bust / n, steady: (n - bust - boom) / n, boom: boom / n, n }
    : { bust: 0, steady: 0, boom: 0, n: 0 };
}

/* ─── Bracket benchmarks and outliers ─── */

/** The smallest sample at which a player is rated: below it they're listed, not ranked. */
export const MIN_BAT = { inns: 5, balls: 60, outs: 3 };
export const MIN_BOWL = { balls: 48, spells: 4 };

export type Disc = 'bat' | 'bowl';

/** What one player did in one bracket, one format. */
export interface BracketLine {
  player: JourneyPlayer;
  bracket: Bracket;
  format: Format;
  rows: SeasonRow[];
  t: Tally;
  seasons: number[];
  /** Games in each setting inside this bracket. */
  settings: Partial<Record<Setting, number>>;
  /** Rated against the bracket (0–100, 50 = typical), null when the sample is too small. */
  batPct: number | null;
  bowlPct: number | null;
  batOutlier: boolean;
  bowlOutlier: boolean;
}

export interface Spread {
  n: number;
  mean: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  /** The top-10% mark: p90 where more is better, p10 where less is better. */
  benchmark: number;
}

function spreadOf(values: number[], better: 'high' | 'low'): Spread | null {
  if (values.length < 3) return null;
  const v = [...values].sort((a, b) => a - b);
  const q = (x: number) => quantile(v, x) as number;
  return {
    n: v.length,
    mean: v.reduce((a, b) => a + b, 0) / v.length,
    p10: q(0.1),
    p25: q(0.25),
    p50: q(0.5),
    p75: q(0.75),
    p90: q(0.9),
    benchmark: better === 'high' ? q(0.9) : q(0.1),
  };
}

/** Percentile of `x` among `all` (0–100), counting ties as half. */
function percentile(x: number, all: number[], better: 'high' | 'low'): number {
  let below = 0;
  for (const a of all) {
    if (a === x) below += 0.5;
    else if (better === 'high' ? a < x : a > x) below += 1;
  }
  return Math.round((below / all.length) * 100);
}

const batOk = (t: Tally) =>
  t.inns >= MIN_BAT.inns && t.balls >= MIN_BAT.balls && t.outs >= MIN_BAT.outs;
const bowlOk = (t: Tally) => t.bBalls >= MIN_BOWL.balls && t.spells >= MIN_BOWL.spells;

export interface BracketBoard {
  bracket: Bracket;
  format: Format;
  gender: Gender;
  lines: BracketLine[];
  /** Batting average, of rated batters. */
  bat: Spread | null;
  /** Economy, of rated bowlers. */
  bowl: Spread | null;
  /** Participation per player per season: median balls faced / bowled. */
  ballsFaced: number | null;
  ballsBowled: number | null;
  boom: BoomBust;
}

/**
 * Every player's line in a bracket and format, rated against each other. A batting outlier is in
 * the top tenth on average AND scores faster than the middle; a bowling outlier is in the top
 * tenth on economy AND takes wickets faster than the middle. One measure alone isn't enough: a
 * slow, safe average or a cheap spell with no wickets isn't what a selector is looking for.
 */
export function boardFor(
  players: JourneyPlayer[],
  bracket: Bracket,
  format: Format,
  gender: Gender,
): BracketBoard {
  const lines: BracketLine[] = [];
  for (const p of players) {
    if (p.gender !== gender) continue;
    const rows = p.rows.filter((r) => r.bracket === bracket && r.format === format);
    if (!rows.length) continue;
    const settings: Partial<Record<Setting, number>> = {};
    for (const r of rows) settings[r.setting] = (settings[r.setting] ?? 0) + r.games;
    lines.push({
      player: p,
      bracket,
      format,
      rows,
      t: tally(rows),
      seasons: [...new Set(rows.map((r) => r.season))].sort(),
      settings,
      batPct: null,
      bowlPct: null,
      batOutlier: false,
      bowlOutlier: false,
    });
  }
  const batters = lines.filter((l) => batOk(l.t));
  const bowlers = lines.filter((l) => bowlOk(l.t) && l.t.wkts > 0);
  const avgs = batters.map((l) => average(l.t) as number);
  const srs = batters.map((l) => strikeRate(l.t) as number);
  const ecos = bowlers.map((l) => economy(l.t) as number);
  const bpws = bowlers.map((l) => ballsPerWicket(l.t) as number);
  const bat = spreadOf(avgs, 'high');
  const bowl = spreadOf(ecos, 'low');
  const medSr = median(srs);
  const medBpw = median(bpws);
  for (const l of batters) {
    l.batPct = percentile(average(l.t) as number, avgs, 'high');
    l.batOutlier =
      !!bat &&
      (average(l.t) as number) >= bat.benchmark &&
      (strikeRate(l.t) as number) >= (medSr ?? 0);
  }
  for (const l of bowlers) {
    l.bowlPct = percentile(economy(l.t) as number, ecos, 'low');
    l.bowlOutlier =
      !!bowl &&
      (economy(l.t) as number) <= bowl.benchmark &&
      (ballsPerWicket(l.t) as number) <= (medBpw ?? Infinity);
  }
  // Participation: per player per season in the bracket.
  const faced: number[] = [];
  const bowled: number[] = [];
  for (const l of lines)
    for (const s of l.seasons) {
      const t = tally(l.rows.filter((r) => r.season === s));
      if (t.balls) faced.push(t.balls);
      if (t.bBalls) bowled.push(t.bBalls);
    }
  return {
    bracket,
    format,
    gender,
    lines,
    bat,
    bowl,
    ballsFaced: median(faced),
    ballsBowled: median(bowled),
    boom: boomBust(
      lines.flatMap((l) => l.rows),
      bracket,
    ),
  };
}

/** The formats a gender is recorded in, most-played first. */
export function formatsOf(players: JourneyPlayer[], gender: Gender): Format[] {
  const c = new Map<Format, number>();
  for (const p of players)
    if (p.gender === gender)
      for (const r of p.rows) c.set(r.format, (c.get(r.format) ?? 0) + r.games);
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
}

/** All the brackets for a format, bottom of the pathway first; empty brackets are dropped. */
export function boards(players: JourneyPlayer[], format: Format, gender: Gender): BracketBoard[] {
  return BRACKETS.map((b) => boardFor(players, b, format, gender)).filter((b) => b.lines.length);
}

/* ─── Progress up the ladder ─── */

export interface Climb {
  player: JourneyPlayer;
  from: BracketLine;
  to: BracketLine;
  /** Percentile points gained from one bracket to the next they were rated in. */
  gain: number;
  disc: Disc;
}

/**
 * Players who rose against their peers: rated in two brackets (in order), and 30+ percentile
 * points higher in the later one. Their rating is relative each time — going from the middle of
 * U15 to the top tenth of U17 is a real improvement, whatever the raw averages say.
 */
export function improversAcross(bs: BracketBoard[], disc: Disc, minGain = 30): Climb[] {
  const byPlayer = new Map<string, BracketLine[]>();
  for (const b of bs)
    for (const l of b.lines) {
      const pct = disc === 'bat' ? l.batPct : l.bowlPct;
      if (pct === null) continue;
      byPlayer.set(l.player.id, [...(byPlayer.get(l.player.id) ?? []), l]);
    }
  const out: Climb[] = [];
  for (const ls of byPlayer.values()) {
    const sorted = [...ls].sort((a, b) => rungOf(a.bracket) - rungOf(b.bracket));
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const pa = (disc === 'bat' ? a.batPct : a.bowlPct) as number;
      const pb = (disc === 'bat' ? b.batPct : b.bowlPct) as number;
      if (pb - pa >= minGain) out.push({ player: a.player, from: a, to: b, gain: pb - pa, disc });
    }
  }
  return out.sort((a, b) => b.gain - a.gain);
}

/** The same players, keeping only their school games (and dropping anyone with none). */
export function schoolOnly(players: JourneyPlayer[]): JourneyPlayer[] {
  return players.flatMap((p) => {
    const rows = p.rows.filter((r) => r.setting === 'school');
    return rows.length ? [{ ...p, rows }] : [];
  });
}

/** The teams a line was played for, in the order first seen: "Northgate Prep, Hillcrest College". */
export const teamsOf = (rows: SeasonRow[]) => [
  ...new Set([...rows].sort((a, b) => a.season - b.season).map((r) => r.team)),
];

/* ─── Journeys: who is where, who came in, who left ─── */

export type Status = 'active' | 'new' | 'exited';

export interface Journey {
  player: JourneyPlayer;
  first: number;
  last: number;
  /** Seasons in the data with no games between the first and the last. */
  gaps: number[];
  /** The first school the player was seen at, if any; and the first team of any kind. */
  school: string | null;
  firstTeam: string;
  firstBracket: Bracket;
  /** The highest bracket reached, and the last one played. */
  highest: Bracket;
  current: Bracket;
  reachedPro: boolean;
  /** Order in which the player first appeared in school, club and the franchise: ['school','club','pro']. */
  route: Setting[];
  games: Record<Setting, number>;
  /** Players in the data in the latest season are active, a first appearance then is new. */
  status: Status;
  /** Seasons from first appearing to first franchise game. */
  yearsToPro: number | null;
}

export const seasonsOf = (players: JourneyPlayer[]) => {
  const s = new Set<number>();
  for (const p of players) for (const r of p.rows) s.add(r.season);
  return [...s].sort((a, b) => a - b);
};

export function journeyOf(p: JourneyPlayer, latest: number): Journey {
  const rows = [...p.rows].sort(
    (a, b) => a.season - b.season || rungOf(a.bracket) - rungOf(b.bracket),
  );
  const seasons = [...new Set(rows.map((r) => r.season))];
  const first = seasons[0];
  const last = seasons[seasons.length - 1];
  const gaps: number[] = [];
  for (let s = first + 1; s < last; s++) if (!seasons.includes(s)) gaps.push(s);
  const route: Setting[] = [];
  const games: Record<Setting, number> = { school: 0, club: 0, rep: 0, pro: 0 };
  for (const r of rows) {
    // Representative weeks run alongside school and club; they're counted, not a step on the route.
    if (r.setting !== 'rep' && !route.includes(r.setting)) route.push(r.setting);
    games[r.setting] += r.games;
  }
  const byRung = [...rows].sort((a, b) => rungOf(a.bracket) - rungOf(b.bracket));
  const firstPro = rows.find((r) => r.setting === 'pro');
  return {
    player: p,
    first,
    last,
    gaps,
    school: rows.find((r) => r.setting === 'school')?.team ?? null,
    firstTeam: rows[0].team,
    firstBracket: rows[0].bracket,
    highest: byRung[byRung.length - 1].bracket,
    current: rows[rows.length - 1].bracket,
    reachedPro: !!firstPro,
    route,
    games,
    status: last < latest ? 'exited' : first === latest ? 'new' : 'active',
    yearsToPro: firstPro ? firstPro.season - first : null,
  };
}

export const journeys = (players: JourneyPlayer[]): Journey[] => {
  const latest = Math.max(...seasonsOf(players));
  return players.map((p) => journeyOf(p, latest));
};

export interface FlowSeason {
  season: number;
  active: number;
  entered: number;
  /** Players whose last season in the data was this one (not the latest). */
  left: number;
  bySetting: Record<Setting, number>;
}

/** Who was playing each season, who appeared for the first time, and who was last seen. */
export function flowBySeason(js: Journey[], seasons: number[]): FlowSeason[] {
  const latest = seasons[seasons.length - 1];
  return seasons.map((season) => {
    const bySetting: Record<Setting, number> = { school: 0, club: 0, rep: 0, pro: 0 };
    let active = 0;
    let entered = 0;
    let left = 0;
    for (const j of js) {
      const here = j.player.rows.filter((r) => r.season === season);
      if (here.length) {
        active++;
        for (const s of new Set(here.map((r) => r.setting))) bySetting[s]++;
      }
      // The first season in the data is not an "entry": everyone was already there.
      if (j.first === season && season !== seasons[0]) entered++;
      if (j.last === season && season !== latest) left++;
    }
    return { season, active, entered, left, bySetting };
  });
}

export interface FunnelRow {
  bracket: Bracket;
  /** Players ever seen in this bracket. */
  ever: number;
  /** Of them, how many were also seen in the next bracket up. */
  onward: number;
  /** Of them, whose highest bracket was this one and who are no longer in the data. */
  leftHere: number;
  /** Of them, who first appeared in the data at this bracket (joined late). */
  joinedHere: number;
  /** Only meaningful where the data is long enough for players to have moved on. */
  share: number | null;
}

/**
 * The pipeline bracket by bracket. `share` is the proportion of players seen in a bracket who
 * were later seen in the next one; a drop-off is a gap. Players still in the bracket in the
 * latest season haven't had the chance to move on, so they're left out of the share.
 */
export function funnel(js: Journey[], gender: Gender, firstSeason: number): FunnelRow[] {
  const mine = js.filter((j) => j.player.gender === gender);
  return BRACKETS.map((b, i) => {
    const inB = mine.filter((j) => j.player.rows.some((r) => r.bracket === b));
    const next = BRACKETS[i + 1];
    const onward = next
      ? inB.filter((j) => j.player.rows.some((r) => r.bracket === next)).length
      : 0;
    const settled = inB.filter((j) => j.status === 'exited' || rungOf(j.current) > i);
    const leftHere = inB.filter((j) => j.status === 'exited' && rungOf(j.highest) === i).length;
    const joinedHere = inB.filter((j) => j.firstBracket === b && j.first > firstSeason).length;
    return {
      bracket: b,
      ever: inB.length,
      onward,
      leftHere,
      joinedHere,
      share:
        next && settled.length >= 5
          ? settled.filter((j) => rungOf(j.highest) > i).length / settled.length
          : null,
    };
  }).filter((r) => r.ever);
}

export interface RouteRow {
  route: string;
  steps: Setting[];
  n: number;
  /** Median seasons from first appearing to the first franchise game. */
  yearsToPro: number | null;
  /** Median games before the first franchise game. */
  gamesBefore: number | null;
}

/** The routes players who reached the franchise took (the order they first appeared in each setting). */
export function routesToPro(js: Journey[]): RouteRow[] {
  const groups = new Map<string, Journey[]>();
  for (const j of js.filter((x) => x.reachedPro)) {
    const key = j.route.join('>');
    groups.set(key, [...(groups.get(key) ?? []), j]);
  }
  return [...groups.entries()]
    .map(([route, g]) => ({
      route,
      steps: g[0].route,
      n: g.length,
      yearsToPro: median(g.map((j) => j.yearsToPro).filter((v): v is number => v !== null)),
      gamesBefore: median(
        g.map((j) => {
          const firstPro = Math.min(
            ...j.player.rows.filter((r) => r.setting === 'pro').map((r) => r.season),
          );
          return j.player.rows
            .filter((r) => r.setting !== 'pro' && r.season <= firstPro)
            .reduce((a, r) => a + r.games, 0);
        }),
      ),
    }))
    .sort((a, b) => b.n - a.n);
}

export interface OriginRow {
  team: string;
  /** Players first seen at this school. */
  players: number;
  inClub: number;
  reachedPro: number;
}

/** Where players started: each school, how many went on to club cricket and to the franchise. */
export function schoolOrigins(js: Journey[]): OriginRow[] {
  const m = new Map<string, OriginRow>();
  for (const j of js) {
    if (!j.school) continue;
    const r = m.get(j.school) ?? { team: j.school, players: 0, inClub: 0, reachedPro: 0 };
    r.players++;
    if (j.games.club > 0) r.inClub++;
    if (j.reachedPro) r.reachedPro++;
    m.set(j.school, r);
  }
  return [...m.values()].sort((a, b) => b.reachedPro - a.reachedPro || b.players - a.players);
}

/** Games by setting inside each bracket — school against club against representative. */
export function settingMix(js: Journey[], gender: Gender) {
  return BRACKETS.map((b) => {
    const g: Record<Setting, number> = { school: 0, club: 0, rep: 0, pro: 0 };
    for (const j of js)
      if (j.player.gender === gender)
        for (const r of j.player.rows) if (r.bracket === b) g[r.setting] += r.games;
    return { bracket: b, games: g, total: g.school + g.club + g.rep + g.pro };
  }).filter((r) => r.total);
}
