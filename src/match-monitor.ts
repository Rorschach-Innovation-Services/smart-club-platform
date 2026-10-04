/**
 * Match-day monitor (Medicoach sync): what each of the day's games is doing, from the live
 * scoring in medicoach, and what needs the union office's attention.
 *
 * Pure: takes the `/integrations/medicoach/live` rows plus "now" and the admin's thresholds,
 * and returns the phase, timings and flags each row shows. Every clock time is South African
 * (SAST, UTC+2 all year — no daylight saving), formatted without the host's zone so the
 * console reads the same everywhere.
 */
import type { LiveGap, MonitorMatch, MonitorPlayer } from './api';

export interface MonitorThresholds {
  /** Minutes after the scheduled start before a start counts as late. */
  lateStartMin: number;
  /** Minutes between two balls (same innings) before the gap counts as a delay. */
  ballGapMin: number;
  /** Minutes without any scoring input, while a game is live, before the scorer looks quiet. */
  quietMin: number;
  /** Minutes an innings break may run before it is flagged. */
  breakMin: number;
  /** Undos in one match before the scorer's corrections are flagged. */
  undoMax: number;
}

export const DEFAULT_THRESHOLDS: MonitorThresholds = {
  lateStartMin: 15,
  ballGapMin: 4,
  quietMin: 10,
  breakMin: 30,
  undoMax: 5,
};

export type MonitorPhase =
  | 'upcoming' // before its start, nothing scored yet
  | 'awaiting' // its start has passed, no ball yet
  | 'live'
  | 'break' // between innings
  | 'done'
  | 'abandoned'
  | 'off'; // postponed / cancelled in smart club

export type FlagKey =
  | 'unregistered'
  | 'no-scoring'
  | 'not-started'
  | 'quiet'
  | 'late'
  | 'delay'
  | 'undo'
  | 'added'
  | 'long-break';

/** The flag types in the order the action board ranks them (most urgent first). */
export const FLAG_TYPES: Array<{ key: FlagKey; name: string }> = [
  { key: 'unregistered', name: 'Not registered' },
  { key: 'no-scoring', name: 'No live scoring' },
  { key: 'not-started', name: 'Not started' },
  { key: 'quiet', name: 'Scorer silent' },
  { key: 'late', name: 'Late start' },
  { key: 'delay', name: 'Ball delays' },
  { key: 'undo', name: 'Undo used' },
  { key: 'added', name: 'Players added' },
  { key: 'long-break', name: 'Long innings break' },
];
const FLAG_RANK = new Map(FLAG_TYPES.map((f, i) => [f.key, i]));

export interface MonitorFlag {
  key: FlagKey;
  label: string;
  /** `alert` needs action now (unregistered player, game should be on, scorer silent). */
  tone: 'alert' | 'warn';
  /** One line per player / gap behind the flag. */
  detail?: string[];
  /** When the condition began (ISO), for "open for 20 min". */
  since?: string | null;
  /**
   * Changes when the flag gets worse (another player, more undos, a longer silence band), so a
   * flag the office marked as seen comes back when there is something new in it.
   */
  signature: string;
}

export interface InningsBreak {
  from: string;
  /** null while the break is still running. */
  to: string | null;
  minutes: number;
}

export interface MonitorRow {
  match: MonitorMatch;
  phase: MonitorPhase;
  /** Minutes the first ball came after the scheduled start (negative = early). */
  lateMin: number | null;
  /** Minutes since the last scoring input (any phase with input). */
  sinceInputMin: number | null;
  /** Unexplained gaps between balls at or over the threshold, longest first. */
  delays: LiveGap[];
  /** Long gaps the scorer recorded as drinks or an interruption (shown, never flagged). */
  breaks: LiveGap[];
  inningsBreak: InningsBreak | null;
  /** First ball to the end (or to now while running). */
  durationMin: number | null;
  /** Undos so far; null when the scoring app doesn't report them. */
  undoCount: number | null;
  /** Players the scorer added with "add player" during the match. */
  playersAdded: number;
  /** Players the rosters can't vouch for (unregistered, other club, inactive). */
  ineligible: number;
  flags: MonitorFlag[];
}

/** One flag on the action board: the flag, its game, and a stable id for "seen". */
export interface BoardFlag {
  id: string;
  row: MonitorRow;
  flag: MonitorFlag;
}

/** Every flag of the day, most urgent first: alerts, then by type, then longest open. */
export function boardFlags(rows: MonitorRow[]): BoardFlag[] {
  return rows
    .flatMap((row) => row.flags.map((flag) => ({ id: `${row.match.ref}|${flag.key}`, row, flag })))
    .sort(
      (a, b) =>
        (a.flag.tone === 'alert' ? 0 : 1) - (b.flag.tone === 'alert' ? 0 : 1) ||
        FLAG_RANK.get(a.flag.key)! - FLAG_RANK.get(b.flag.key)! ||
        (a.flag.since ?? '~').localeCompare(b.flag.since ?? '~'),
    );
}

const MIN = 60_000;
const SAST_OFFSET_MS = 2 * 60 * MIN;

const ms = (iso: string | null | undefined) => {
  const v = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(v) ? v : null;
};
const minutesBetween = (a: number, b: number) => Math.round((b - a) / MIN);

/** The fixture's start as an instant: its date and time read as SAST; null when time TBC. */
export function scheduledStartMs(m: Pick<MonitorMatch, 'date' | 'time'>): number | null {
  if (!m.date || !m.time || !/^\d{1,2}:\d{2}$/.test(m.time)) return null;
  const [h, mm] = m.time.split(':').map(Number);
  const day = Date.parse(`${m.date}T00:00:00Z`);
  return Number.isFinite(day) ? day + (h * 60 + mm) * MIN - SAST_OFFSET_MS : null;
}

/** "14:05" in SAST. */
export function sastClock(iso: string | number | null | undefined): string {
  const v = typeof iso === 'number' ? iso : ms(iso);
  if (v === null) return '—';
  const d = new Date(v + SAST_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** Today's date in SAST, YYYY-MM-DD. */
export function sastToday(nowMs: number = Date.now()): string {
  return new Date(nowMs + SAST_OFFSET_MS).toISOString().slice(0, 10);
}

/** "1 h 05 min", "12 min", "45 s". */
export function fmtDuration(minutes: number | null, seconds?: number): string {
  if (seconds !== undefined && seconds < 60) return `${Math.round(seconds)} s`;
  if (minutes === null) return '—';
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export function monitorRow(
  match: MonitorMatch,
  nowMs: number,
  t: MonitorThresholds = DEFAULT_THRESHOLDS,
): MonitorRow {
  const live = match.live;
  const start = scheduledStartMs(match);
  const first = ms(live?.startedAt);
  const ended = ms(live?.endedAt);
  const lastInput = ms(live?.lastInputAt);
  const flags: MonitorFlag[] = [];

  let phase: MonitorPhase;
  if (match.fixtureStatus === 'postponed' || match.fixtureStatus === 'cancelled') phase = 'off';
  else if (live?.status === 'abandoned') phase = 'abandoned';
  else if (live?.status === 'completed') phase = 'done';
  else if (live?.status === 'innings_break') phase = 'break';
  else if (live?.status === 'in_progress') phase = 'live';
  else if (start !== null && nowMs >= start) phase = 'awaiting';
  else phase = 'upcoming';

  const lateMin = first !== null && start !== null ? minutesBetween(start, first) : null;
  if (lateMin !== null && lateMin >= t.lateStartMin)
    flags.push({
      key: 'late',
      label: `Started ${fmtDuration(lateMin)} late`,
      tone: 'warn',
      since: live!.startedAt,
      signature: 'late',
    });

  if (phase === 'awaiting' && start !== null) {
    const over = minutesBetween(start, nowMs);
    if (over >= t.lateStartMin)
      flags.push(
        live
          ? {
              key: 'not-started',
              label: `Not started · ${fmtDuration(over)} past start`,
              tone: 'alert',
              since: new Date(start).toISOString(),
              signature: 'not-started',
            }
          : {
              key: 'no-scoring',
              label: `No live scoring · ${fmtDuration(over)} past start`,
              tone: 'alert',
              since: new Date(start).toISOString(),
              signature: 'no-scoring',
            },
      );
  }

  const sinceInputMin = lastInput !== null ? minutesBetween(lastInput, nowMs) : null;
  if (phase === 'live' && sinceInputMin !== null && sinceInputMin >= t.quietMin)
    flags.push({
      key: 'quiet',
      label: `No input for ${fmtDuration(sinceInputMin)}`,
      tone: 'alert',
      since: live!.lastInputAt,
      // A fresh silence (after the scorer came back) is a new flag.
      signature: `quiet:${live!.lastInputAt}`,
    });

  const long = (live?.longGaps ?? [])
    .filter((g) => g.gapSec >= t.ballGapMin * 60)
    .sort((a, b) => b.gapSec - a.gapSec);
  const delays = long.filter((g) => !g.reason);
  const breaks = long.filter((g) => g.reason);
  if (delays.length)
    flags.push({
      key: 'delay',
      label: `${delays.length} delay${delays.length === 1 ? '' : 's'} between balls · longest ${fmtDuration(delays[0].gapSec / 60)}`,
      tone: 'warn',
      detail: delays.map(
        (g) =>
          `Innings ${g.innings}, before ball ${g.over}: ${fmtDuration(g.gapSec / 60)} (${sastClock(Date.parse(g.at) - g.gapSec * 1000)}–${sastClock(g.at)})`,
      ),
      since: [...delays].sort((a, b) => b.at.localeCompare(a.at))[0].at,
      signature: `delay:${delays.length}`,
    });

  // The break between the first two innings: the first's end to the second's first ball.
  let inningsBreak: InningsBreak | null = null;
  const [i1, i2] = live?.innings ?? [];
  const i1End = ms(i1?.endedAt);
  if (i1End !== null) {
    const i2Start = ms(i2?.startedAt);
    if (i2Start !== null)
      inningsBreak = {
        from: i1!.endedAt!,
        to: i2!.startedAt,
        minutes: minutesBetween(i1End, i2Start),
      };
    else if (phase === 'break')
      inningsBreak = { from: i1!.endedAt!, to: null, minutes: minutesBetween(i1End, nowMs) };
  }
  if (inningsBreak && inningsBreak.minutes >= t.breakMin)
    flags.push({
      key: 'long-break',
      label: `Innings break ${fmtDuration(inningsBreak.minutes)}${inningsBreak.to ? '' : ' and counting'}`,
      tone: 'warn',
      since: inningsBreak.from,
      signature: 'long-break',
    });

  // ── Players: anyone the roster can't vouch for, and anyone added during the match ──
  const players = live?.players ?? [];
  const side = (p: MonitorPlayer) => (p.side === 'home' ? match.home : match.away);
  const why: Partial<Record<MonitorPlayer['check'], (p: MonitorPlayer) => string>> = {
    unregistered: (p) => `not registered with ${side(p)}`,
    'other-club': (p) => `registered with ${p.otherClub ?? 'another club'}, not ${side(p)}`,
    'not-active': (p) => `registration at ${side(p)} is inactive or awaiting a clearance`,
  };
  const ineligible = players.filter((p) => why[p.check]);
  if (ineligible.length)
    flags.push({
      key: 'unregistered',
      label:
        ineligible.length === 1
          ? `${ineligible[0].name} is not registered to play`
          : `${ineligible.length} players not registered to play`,
      tone: 'alert',
      detail: ineligible.map(
        (p) =>
          `${p.name} — ${why[p.check]!(p)}${p.addedDuringMatch ? ` · added during the match${p.addedAt ? ` at ${sastClock(p.addedAt)}` : ''}` : ''}`,
      ),
      since:
        ineligible
          .map((p) => p.addedAt)
          .filter((x): x is string => !!x)
          .sort()[0] ??
        live?.startedAt ??
        null,
      signature: `unregistered:${ineligible
        .map((p) => p.name)
        .sort()
        .join('|')}`,
    });
  const added = players.filter((p) => p.addedDuringMatch);
  if (added.length)
    flags.push({
      key: 'added',
      label: `${added.length} player${added.length === 1 ? '' : 's'} added during the match`,
      tone: 'warn',
      detail: added.map(
        (p) =>
          `${p.name} (${side(p)})${p.addedAt ? ` at ${sastClock(p.addedAt)}` : ''} — ${
            p.check === 'registered' || p.check === 'name-match'
              ? 'registered'
              : p.check === 'unchecked'
                ? 'not checked'
                : 'NOT registered'
          }`,
      ),
      since:
        added
          .map((p) => p.addedAt)
          .filter((x): x is string => !!x)
          .sort()[0] ?? null,
      signature: `added:${added.length}`,
    });

  const undoCount = live?.undoCount ?? null;
  if (undoCount !== null && undoCount >= t.undoMax)
    flags.push({
      key: 'undo',
      label: `Undo used ${undoCount} times`,
      tone: 'warn',
      since: null,
      // Comes back each time the count climbs another threshold's worth.
      signature: `undo:${Math.floor(undoCount / t.undoMax)}`,
    });

  const durationMin =
    first === null
      ? null
      : minutesBetween(
          first,
          ended ?? (phase === 'live' || phase === 'break' ? nowMs : (lastInput ?? first)),
        );

  flags.sort(
    (a, b) =>
      (a.tone === 'alert' ? 0 : 1) - (b.tone === 'alert' ? 0 : 1) ||
      FLAG_RANK.get(a.key)! - FLAG_RANK.get(b.key)!,
  );
  return {
    match,
    phase,
    lateMin,
    sinceInputMin,
    delays,
    breaks,
    inningsBreak,
    durationMin,
    undoCount,
    playersAdded: added.length,
    ineligible: ineligible.length,
    flags,
  };
}

/** "84/3 (12.4)" for the innings now batting (or the last one), plus the earlier innings. */
export function scoreLines(match: MonitorMatch): { current: string | null; earlier: string[] } {
  const inns = match.live?.innings ?? [];
  if (!inns.length) return { current: null, earlier: [] };
  const name = (side: 'home' | 'away' | null) =>
    side === 'home' ? match.home : side === 'away' ? match.away : 'Batting side';
  const line = (i: (typeof inns)[number]) =>
    `${name(i.battingSide)} ${i.runs}/${i.wickets} (${i.overs})`;
  return { current: line(inns[inns.length - 1]), earlier: inns.slice(0, -1).map(line) };
}

const PHASE_ORDER: Record<MonitorPhase, number> = {
  awaiting: 0,
  live: 1,
  break: 2,
  upcoming: 3,
  done: 4,
  abandoned: 5,
  off: 6,
};

/** Flagged first (alerts before warnings), then live → upcoming → finished, then start time. */
export function sortRows(rows: MonitorRow[]): MonitorRow[] {
  const weight = (r: MonitorRow) =>
    r.flags.some((f) => f.tone === 'alert') ? 0 : r.flags.length ? 1 : 2;
  return [...rows].sort(
    (a, b) =>
      weight(a) - weight(b) ||
      PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] ||
      (scheduledStartMs(a.match) ?? Infinity) - (scheduledStartMs(b.match) ?? Infinity) ||
      a.match.home.localeCompare(b.match.home),
  );
}

export interface MonitorTotals {
  matches: number;
  live: number;
  done: number;
  late: number;
  delayed: number;
  attention: number;
  unregistered: number;
}

export function totals(rows: MonitorRow[]): MonitorTotals {
  return {
    matches: rows.filter((r) => r.phase !== 'off').length,
    live: rows.filter((r) => r.phase === 'live' || r.phase === 'break').length,
    done: rows.filter((r) => r.phase === 'done' || r.phase === 'abandoned').length,
    late: rows.filter((r) =>
      r.flags.some((f) => f.key === 'late' || f.key === 'not-started' || f.key === 'no-scoring'),
    ).length,
    delayed: rows.filter((r) => r.delays.length > 0).length,
    attention: rows.filter((r) => r.flags.some((f) => f.tone === 'alert')).length,
    unregistered: rows.reduce((n, r) => n + r.ineligible, 0),
  };
}
