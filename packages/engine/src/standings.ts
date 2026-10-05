/**
 * League tables from results (ADR 0018). Pure: no repo, no clock.
 *
 * Results reach smart club from medicoach as display strings ("184/6 (20)") with a winner;
 * this ranks a series' teams from them: points by outcome, then net run rate, then wins.
 *
 *   Win / tie / no result / loss  → the competition's points (cricket default 4 / 2 / 2 / 0).
 *   Net run rate                  → runs scored per over faced minus runs conceded per over
 *                                   bowled, over every game with both innings' runs and overs.
 *                                   A side bowled out is charged its FULL overs quota (the
 *                                   standard rule), so it needs the series' overs. Games with
 *                                   no overs on the scorecard, no-results and forfeits don't
 *                                   count towards it.
 * Fixtures with an unresolved side (a knockout slot such as `win:f3`) are ignored.
 */
import { isSlotRef } from './formats.js';

export interface PointsRules {
  win: number;
  tie: number;
  noResult: number;
  loss: number;
}

/** Common South African club cricket points. */
export const DEFAULT_CRICKET_POINTS: PointsRules = { win: 4, tie: 2, noResult: 2, loss: 0 };

export interface ParsedScore {
  runs: number;
  /** null when the score didn't say. 10 ⇒ all out. */
  wickets: number | null;
  /** Balls faced, from the overs in brackets; null when the score didn't say. */
  balls: number | null;
}

/** "17.3" → 105 (six-ball overs). Null for anything that isn't overs. */
export function oversToBalls(overs: string | number, ballsPerOver = 6): number | null {
  const m = /^(\d{1,3})(?:\.(\d))?$/.exec(String(overs).trim());
  if (!m) return null;
  const part = Number(m[2] ?? 0);
  if (part >= ballsPerOver) return null;
  return Number(m[1]) * ballsPerOver + part;
}

/**
 * A medicoach display score: "184/6 (20)", "184-6 (19.4 ov)", "120 (18.2)", "184/6", "120".
 * Null when there is no run total to read.
 */
export function parseScore(score: string | null | undefined, ballsPerOver = 6): ParsedScore | null {
  if (typeof score !== 'string') return null;
  const m =
    /^\s*(\d{1,4})\s*(?:[/-]\s*(\d{1,2}))?\s*(?:\(\s*(\d{1,3}(?:\.\d)?)\s*(?:ov(?:ers?)?)?\s*\))?\s*$/i.exec(
      score,
    );
  if (!m) return null;
  const wickets = m[2] !== undefined ? Number(m[2]) : null;
  if (wickets !== null && wickets > 10) return null;
  return {
    runs: Number(m[1]),
    wickets,
    balls: m[3] !== undefined ? oversToBalls(m[3], ballsPerOver) : null,
  };
}

export interface StandingsResult {
  homeScore?: string | null;
  awayScore?: string | null;
  winner?: 'home' | 'away' | 'tie' | 'none' | null;
  method?: string | null;
  noResult?: boolean;
}

export interface StandingsFixture {
  id: string;
  home?: string;
  away?: string;
  status?: string;
  result?: StandingsResult | null;
}

export interface StandingsTeam {
  teamId: string;
  name: string;
}

export type FormLetter = 'W' | 'L' | 'T' | 'N';

export interface StandingRow {
  teamId: string;
  name: string;
  played: number;
  won: number;
  lost: number;
  tied: number;
  noResult: number;
  points: number;
  runsFor: number;
  ballsFaced: number;
  runsAgainst: number;
  ballsBowled: number;
  /** Net run rate to 3 decimals; null until a game with both innings' overs is in. */
  nrr: number | null;
  /** Last five outcomes, oldest first. */
  form: FormLetter[];
}

export interface StandingsInput {
  teams: StandingsTeam[];
  /** In playing order (round, then date) — the form guide reads it in this order. */
  fixtures: StandingsFixture[];
  points?: PointsRules;
  /** Overs per side: an all-out innings is charged the full quota. */
  maxOvers?: number;
  ballsPerOver?: number;
}

type Outcome = 'home' | 'away' | 'tie' | 'nr' | null;

function outcomeOf(r: StandingsResult): Outcome {
  const method = (r.method ?? '').toLowerCase();
  if (r.noResult || method === 'no-result' || method === 'abandoned' || r.winner === 'none')
    return 'nr';
  if (r.winner === 'tie' || method === 'tie') return 'tie';
  if (r.winner === 'home' || r.winner === 'away') return r.winner;
  return null;
}

export function computeStandings(input: StandingsInput): StandingRow[] {
  const pts = input.points ?? DEFAULT_CRICKET_POINTS;
  const bpo = input.ballsPerOver ?? 6;
  const quota = input.maxOvers && input.maxOvers > 0 ? input.maxOvers * bpo : null;
  const rows = new Map<string, StandingRow>();
  for (const t of input.teams)
    rows.set(t.teamId, {
      teamId: t.teamId,
      name: t.name,
      played: 0,
      won: 0,
      lost: 0,
      tied: 0,
      noResult: 0,
      points: 0,
      runsFor: 0,
      ballsFaced: 0,
      runsAgainst: 0,
      ballsBowled: 0,
      nrr: null,
      form: [],
    });
  const nrrGames = new Map<string, number>();

  for (const f of input.fixtures) {
    if (!f.result || !f.home || !f.away || isSlotRef(f.home) || isSlotRef(f.away)) continue;
    if (f.status === 'cancelled') continue;
    const home = rows.get(f.home);
    const away = rows.get(f.away);
    if (!home || !away) continue;
    const outcome = outcomeOf(f.result);
    if (!outcome) continue;
    home.played++;
    away.played++;
    const mark = (row: StandingRow, letter: FormLetter, add: number) => {
      row.points += add;
      row.form.push(letter);
      if (letter === 'W') row.won++;
      else if (letter === 'L') row.lost++;
      else if (letter === 'T') row.tied++;
      else row.noResult++;
    };
    if (outcome === 'nr') {
      mark(home, 'N', pts.noResult);
      mark(away, 'N', pts.noResult);
      continue;
    }
    if (outcome === 'tie') {
      mark(home, 'T', pts.tie);
      mark(away, 'T', pts.tie);
    } else {
      const [w, l] = outcome === 'home' ? [home, away] : [away, home];
      mark(w, 'W', pts.win);
      mark(l, 'L', pts.loss);
    }
    // Net run rate: only when both innings give runs AND overs (or an all-out with a quota).
    if ((f.result.method ?? '').toLowerCase() === 'forfeit') continue;
    const h = parseScore(f.result.homeScore, bpo);
    const a = parseScore(f.result.awayScore, bpo);
    const faced = (s: ParsedScore | null) =>
      !s ? null : s.wickets === 10 && quota ? quota : s.balls;
    const hb = faced(h);
    const ab = faced(a);
    if (!h || !a || !hb || !ab) continue;
    home.runsFor += h.runs;
    home.ballsFaced += hb;
    home.runsAgainst += a.runs;
    home.ballsBowled += ab;
    away.runsFor += a.runs;
    away.ballsFaced += ab;
    away.runsAgainst += h.runs;
    away.ballsBowled += hb;
    nrrGames.set(home.teamId, (nrrGames.get(home.teamId) ?? 0) + 1);
    nrrGames.set(away.teamId, (nrrGames.get(away.teamId) ?? 0) + 1);
  }

  for (const r of rows.values()) {
    if (nrrGames.get(r.teamId) && r.ballsFaced && r.ballsBowled)
      r.nrr =
        Math.round(
          ((r.runsFor / r.ballsFaced) * bpo - (r.runsAgainst / r.ballsBowled) * bpo) * 1000,
        ) / 1000;
    r.form = r.form.slice(-5);
  }
  return [...rows.values()].sort(
    (x, y) =>
      y.points - x.points ||
      (y.nrr ?? -Infinity) - (x.nrr ?? -Infinity) ||
      y.won - x.won ||
      x.name.localeCompare(y.name),
  );
}
