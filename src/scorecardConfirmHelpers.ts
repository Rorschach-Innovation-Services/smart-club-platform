/**
 * Pure helpers for the scorecard the captain's report shows (ScorecardView.tsx): scorecard text
 * lines and the correction-feedback rule. No React, no I/O.
 */
import type { InningsScorecard } from './types';

/** A correction request is capped at this many characters (the API's SCORECARD_FEEDBACK_MAX). */
export const FEEDBACK_MAX = 2000;

/** "UKZN CC — 156/7 (20.0)" */
export function inningsHeading(
  inn: Pick<InningsScorecard, 'battingTeamName' | 'totalRuns' | 'wickets' | 'overs'>,
) {
  return `${inn.battingTeamName} — ${inn.totalRuns}/${inn.wickets} (${inn.overs})`;
}

/** "Extras 12 (b 1, lb 2, w 6, nb 2, pen 1)" — zero parts left out; "Extras 0" when none. */
export function extrasLine(e: InningsScorecard['extras']): string {
  const parts = (
    [
      ['b', e.byes],
      ['lb', e.legByes],
      ['w', e.wides],
      ['nb', e.noBalls],
      ['pen', e.penalties],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`);
  return parts.length ? `Extras ${e.total} (${parts.join(', ')})` : `Extras ${e.total}`;
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
