/**
 * Pure helpers for the chair scorecard confirmation page (`/sc/<token>`, ScorecardConfirm.tsx)
 * and the operator console (platform-scorecard-confirmations.tsx): scorecard text lines,
 * status labels, the correction-feedback rule and the Sunday week arithmetic. No React, no I/O.
 */
import type { InningsScorecard, ScorecardConfirmEntry, ScorecardConfirmEntryStatus } from './types';

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

export const STATUS_LABEL: Record<ScorecardConfirmEntryStatus, string> = {
  pending: 'Awaiting answer',
  confirmed: 'Confirmed',
  correction: 'Correction requested',
  void: 'Result withdrawn',
};

/** Pill tone per status (index.html .pill-*): done = teal, needs attention = coral. */
export const STATUS_TONE: Record<ScorecardConfirmEntryStatus, string> = {
  pending: 'navy',
  confirmed: 'teal',
  correction: 'coral',
  void: 'muted',
};

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
 * Which side of the match the chair's club is, from the names alone (the digest carries team
 * names, not ids): a team named for the club ("UKZN CC", "UKZN 2nd XI") matches "UKZN CC".
 * null when neither or both sides match — the page then just shows the fixture as listed.
 */
export function ownSide(
  entry: Pick<ScorecardConfirmEntry, 'homeTeamName' | 'awayTeamName'>,
  clubName: string,
): 'home' | 'away' | null {
  const club = normName(clubName);
  if (!club) return null;
  const matches = (team: string) => {
    const t = normName(team);
    return t === club || t.startsWith(`${club} `);
  };
  const home = matches(entry.homeTeamName);
  const away = matches(entry.awayTeamName);
  if (home === away) return null;
  return home ? 'home' : 'away';
}

/** "UKZN CC 156/7 · Crusaders CC 149/9" — a missing score reads "—". */
export function headlineScore(
  entry: Pick<ScorecardConfirmEntry, 'homeTeamName' | 'awayTeamName' | 'result'>,
): string | null {
  const r = entry.result;
  if (!r || (r.homeScore == null && r.awayScore == null)) return null;
  return `${entry.homeTeamName} ${r.homeScore ?? '—'} · ${entry.awayTeamName} ${r.awayScore ?? '—'}`;
}

/* ─── Weeks (operator console) ─── */

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const SAST_OFFSET_MS = 120 * 60_000;
const DAY_MS = 24 * 3600_000;

/** A real YYYY-MM-DD that falls on a Sunday — the only week keys the API accepts. */
export function isWeekKey(v: string): boolean {
  if (!WEEK_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && d.getUTCDay() === 0;
}

/** The Sunday `weeks` weeks before (negative) or after (positive) `weekKey`. */
export function shiftWeek(weekKey: string, weeks: number): string {
  return new Date(Date.parse(`${weekKey}T00:00:00Z`) + weeks * 7 * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The most recent COMPLETED Mon–Sun week at `now`, SAST — mirrors the API's
 * lastCompletedWeekKey: on a Monday the week that ended yesterday; on a Sunday, the week
 * that ended a week ago (today's is still running).
 */
export function lastCompletedWeekKey(now: Date = new Date()): string {
  const sast = new Date(now.getTime() + SAST_OFFSET_MS);
  const day = sast.toISOString().slice(0, 10);
  const closingSunday = shiftDays(day, (7 - sast.getUTCDay()) % 7);
  return shiftWeek(closingSunday, -1);
}

function shiftDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
