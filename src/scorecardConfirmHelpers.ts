/**
 * Pure helpers for the scorecard the captain's report shows (ScorecardView.tsx): scorecard text
 * lines and the correction-feedback rule. No React, no I/O.
 */
import type { InningsScorecard } from './types';

/** A correction request is capped at this many characters (the API's SCORECARD_FEEDBACK_MAX). */
export const FEEDBACK_MAX = 2000;

/** "20 ov" for a completed "20.0", "18.3 ov" otherwise. */
export function fmtOvers(overs: string): string {
  return `${overs.replace(/\.0$/, '')} ov`;
}

/** "UKZN CC — 156/7 (20 ov)" */
export function inningsHeading(
  inn: Pick<InningsScorecard, 'battingTeamName' | 'totalRuns' | 'wickets' | 'overs'>,
) {
  return `${inn.battingTeamName} — ${inn.totalRuns}/${inn.wickets} (${fmtOvers(inn.overs)})`;
}

/**
 * The innings' one-line hint under its summary: the top scorer (most runs, then fewest balls;
 * `*` when not out) and the best bowling (most wickets, then fewest runs). Either half is left
 * out when there is no one to name; empty when neither is.
 */
export function inningsHint(inn: Pick<InningsScorecard, 'batters' | 'bowlers'>): string {
  const bat = [...byOrder(inn.batters)].sort(
    (a, b) => b.runs - a.runs || a.ballsFaced - b.ballsFaced,
  )[0];
  const bowl = [...byOrder(inn.bowlers)].sort(
    (a, b) => b.wickets - a.wickets || a.runsConceded - b.runsConceded,
  )[0];
  const parts: string[] = [];
  if (bat)
    parts.push(
      `Top score ${bat.name} ${bat.runs}${/^not out$/i.test(bat.howOut.trim()) ? '*' : ''} (${bat.ballsFaced})`,
    );
  if (bowl) parts.push(`Best bowling ${bowl.name} ${bowl.wickets}/${bowl.runsConceded}`);
  return parts.join(' · ');
}

/** "b 1, lb 2, w 6, nb 2, pen 1" — zero parts left out; empty when there were none. */
export function extrasDetail(e: InningsScorecard['extras']): string {
  return (
    [
      ['b', e.byes],
      ['lb', e.legByes],
      ['w', e.wides],
      ['nb', e.noBalls],
      ['pen', e.penalties],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
}

/** "Extras 12 (b 1, lb 2, w 6, nb 2, pen 1)" — zero parts left out; "Extras 0" when none. */
export function extrasLine(e: InningsScorecard['extras']): string {
  const detail = extrasDetail(e);
  return detail ? `Extras ${e.total} (${detail})` : `Extras ${e.total}`;
}

/** "6 wkts, 20 ov" — "all out" at ten wickets, "1 wkt" for one. */
export function totalDetail(inn: Pick<InningsScorecard, 'wickets' | 'overs'>): string {
  const w = inn.wickets >= 10 ? 'all out' : `${inn.wickets} ${inn.wickets === 1 ? 'wkt' : 'wkts'}`;
  return `${w}, ${fmtOvers(inn.overs)}`;
}

/** "1-23 (S. Naidoo, 2.6), 2-40 (K. Pillay, 5.1)" — empty when no wicket fell. */
export function fallOfWicketsLine(fow: InningsScorecard['fallOfWickets']): string {
  return [...fow]
    .sort((a, b) => a.wicket - b.wicket)
    .map((w) => `${w.wicket}-${w.runs} (${w.batterName}, ${w.overs})`)
    .join(', ');
}

/** A strike rate or economy to two decimals; "—" when it can't be computed (no balls faced). */
export function fmtRate(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '—';
}

/** Batters in batting order, bowlers in bowling order (the wire is already ordered; be sure). */
export const byOrder = <T extends { order: number }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => a.order - b.order);

/**
 * Why a correction can't be sent yet, or null when it can. Same rule as the API: required
 * (non-blank once trimmed) and at most FEEDBACK_MAX characters.
 */
export function feedbackProblem(text: string): string | null {
  if (!text.trim()) return 'Tell us what needs correcting.';
  if (text.length > FEEDBACK_MAX) return `Keep it to ${FEEDBACK_MAX} characters or fewer.`;
  return null;
}

/** Club / team name reduced for matching: lowercase, no punctuation, no "CC"/"Cricket Club". */
function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(cricket club|cc)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether a scorecard team name is the club's own side: "Clares", "Clares CC" and
 * "Clares 2nd XI" all match the club "Clares CC" (suffixes stripped, then equal or a
 * word-boundary prefix). A blank club name matches nothing.
 */
export function isOwnTeam(teamName: string, clubName: string): boolean {
  const club = normName(clubName);
  if (!club) return false;
  const team = normName(teamName);
  return team === club || team.startsWith(`${club} `);
}

/**
 * Per innings, whether the club batted in it. When the loose match claims more than one
 * distinct batting side (a derby — "Clares" vs "Clares 2nd XI"), only an exact (normalized)
 * name keeps the mark; still ambiguous → nothing is marked.
 */
export function ownInningsFlags(battingTeamNames: string[], clubName: string): boolean[] {
  const loose = battingTeamNames.map((n) => isOwnTeam(n, clubName));
  const sides = new Set(battingTeamNames.filter((_, i) => loose[i]).map(normName));
  if (sides.size <= 1) return loose;
  const club = normName(clubName);
  const exact = battingTeamNames.map((n) => normName(n) === club);
  return exact.some(Boolean) ? exact : battingTeamNames.map(() => false);
}

/** "UKZN CC 156/7 · Crusaders CC 149/9" — a missing score reads "—". */
export function headlineScore(entry: {
  homeTeamName: string;
  awayTeamName: string;
  result?: { homeScore: string | null; awayScore: string | null };
}): string | null {
  const r = entry.result;
  if (!r || (r.homeScore == null && r.awayScore == null)) return null;
  return `${entry.homeTeamName} ${r.homeScore ?? '—'} · ${entry.awayTeamName} ${r.awayScore ?? '—'}`;
}
