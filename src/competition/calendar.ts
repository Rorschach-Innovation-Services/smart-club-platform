/**
 * Season-calendar engine — turns "N rounds, this cadence, that block" into concrete
 * match dates that respect the union's real playing calendar.
 *
 * The problem this replaces: `generateRoundRobin` schedules from a single start date at
 * a hardcoded weekly step (or spreads evenly to an end date). Both KZNCU and EMCU run
 * TWO playing blocks with a mid-season break between them, and their divisions play
 * weekly, every two weeks, or Saturdays-only. A continuous weekly cadence puts matches
 * inside the December–January break for every league in the tenant.
 *
 * Everything here is pure and date-only. See ADR 0008 for the model.
 *
 * ── DATES ARE LOCAL WALL-CLOCK, NEVER UTC INSTANTS ──
 * A fixture happens on a date, in one place, in a region with no DST. Every date-only
 * string is therefore parsed with `dayjs.utc` and STRICTLY against 'YYYY-MM-DD', so
 * arithmetic is in whole days and can never drift by the host's offset. Never introduce
 * a local-time `dayjs()` into this module — `todayIso` is the single, deliberate
 * exception, because "what day is it here" is exactly a local-time question. Times
 * (`TimeSlot.start`) are likewise stored as wall-clock 'HH:MM' and never converted.
 */

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import type { Cadence, IsoDate, SeasonBlock, SeasonCalendar, TimeSlot, Weekday } from '../types';

dayjs.extend(utc);
dayjs.extend(customParseFormat);

// The persisted shapes live in src/types.ts (hand-ported from the backend, which owns
// them). Re-exported here so callers can take the engine and its vocabulary from one
// import; DatePlan and friends below are engine-only and are not persisted.
export type {
  Cadence,
  IsoDate,
  IsoTime,
  SeasonBlock,
  SeasonBreak,
  SeasonCalendar,
  TimeSlot,
  Weekday,
  SeriesSchedule,
} from '../types';

/** The one storage/parse format. Strict-matched, so '2026-02-31' and '13/09/2026' are invalid. */
const FMT = 'YYYY-MM-DD';

export const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/* ─── Season-calendar scheduling controls (ADR 0008) ───
   The cadence union is keyed by `kind`, but a Choice control speaks in labels, so these
   two map between them. Bi-weekly is the only parameterised option the UI exposes;
   `every-n-weeks` with other values stays reachable through the API for now. */
export const CADENCE_LABELS: Record<Cadence['kind'], string> = {
  weekly: 'Weekly',
  'every-n-weeks': 'Every 2 weeks',
  weekdays: 'Set days only',
  spread: 'Spread across block',
};

export function cadenceFromLabel(label: string): Cadence {
  switch (label) {
    case CADENCE_LABELS['every-n-weeks']:
      return { kind: 'every-n-weeks', n: 2 };
    case CADENCE_LABELS.weekdays:
      return { kind: 'weekdays', days: [6] }; // Saturday — the EMCU Division 5 default
    case CADENCE_LABELS.spread:
      return { kind: 'spread' };
    default:
      return { kind: 'weekly' };
  }
}

/** The T20 morning/afternoon slots the union's structure document specifies. */
export const T20_SLOTS: TimeSlot[] = [
  { label: 'Morning', start: '08:00' },
  { label: 'Afternoon', start: '13:30' },
];

/** Why a candidate date was passed over. */
export interface SkippedDate {
  date: IsoDate;
  reason: string;
}

/**
 * The outcome of planning. `fits === false` is a normal, displayable state — the
 * operator console shows it in the preview before anyone generates fixtures, which is
 * the whole point: a 12-team bi-weekly division needs 11 rounds and Block 1 fits 7.
 */
export interface DatePlan {
  /** One date per PLACED round, ascending. Shorter than `roundsRequested` if it overflows. */
  dates: IsoDate[];
  fits: boolean;
  roundsRequested: number;
  roundsPlaced: number;
  /** Candidates rejected for a break or an excluded date — shown as "moved past" in the UI. */
  skipped: SkippedDate[];
  /** One-line human summary for the preview rail. */
  summary: string;
}

export interface DatePlanRequest {
  calendar: SeasonCalendar;
  blockId: string;
  cadence: Cadence;
  rounds: number;
  /** Optional first-round date; clamped into the block. Absent ⇒ the block start. */
  startDate?: IsoDate;
}

/**
 * Iteration ceiling for the day-by-day walks. Ten years of days — far beyond any real
 * season, but a hard stop so a malformed calendar (end before start, an all-day break)
 * can never hang the browser.
 */
const MAX_STEPS = 3660;

/** Strictly parse a date-only string; the result is invalid for anything malformed. */
function d(iso: string): dayjs.Dayjs {
  return dayjs.utc(iso, FMT, true);
}

/** True when `iso` is a well-formed, real calendar date. */
export function isValidIsoDate(iso: unknown): iso is IsoDate {
  return typeof iso === 'string' && d(iso).isValid();
}

/** `iso` shifted by whole days. Negative moves back. */
export function addDays(iso: IsoDate, days: number): IsoDate {
  return d(iso).add(days, 'day').format(FMT);
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return d(b).diff(d(a), 'day');
}

/** Day of week for a date-only string, UTC-anchored so it never shifts by host offset. */
export function weekdayOf(iso: IsoDate): Weekday {
  return d(iso).day() as Weekday;
}

/**
 * `2026-09-13` → `13 Sep 2026`, blank for a malformed date so the UI degrades quietly.
 *
 * dayjs formats month names from its own bundled English locale, which is stable across
 * environments. `Intl`/`toLocaleString` is deliberately NOT used: its short-month output
 * is ICU-version dependent (current ICU renders September as "Sept", older builds "Sep"),
 * so the same summary would read differently in the browser, in Node and in Lambda — and
 * these strings are compared by eye against union documents that write "13 Sep".
 *
 * Same output as `formatDayYear` in src/dates.ts (the app-wide display layer), kept
 * separate only because this one parses STRICTLY date-only: the engine should never be
 * handed a timestamp, and silently formatting one would hide a caller's mistake.
 */
export function formatIsoDate(iso: IsoDate): string {
  const parsed = d(iso);
  return parsed.isValid() ? parsed.format('D MMM YYYY') : '';
}

/** Inclusive range test. ISO date strings sort lexicographically, so this is exact. */
function withinRange(iso: IsoDate, start: IsoDate, end: IsoDate): boolean {
  return iso >= start && iso <= end;
}

/**
 * Why this date can't host a match, or `null` if it can. Breaks and excluded dates are
 * both inclusive; a break wins the message because it is the more useful explanation.
 */
export function blockedReason(calendar: SeasonCalendar, iso: IsoDate): string | null {
  for (const b of calendar.breaks ?? []) {
    if (withinRange(iso, b.start, b.end)) return b.label || 'mid-season break';
  }
  if ((calendar.excludeDates ?? []).includes(iso)) return 'excluded date';
  return null;
}

/**
 * Find a block by position; `undefined` when the index is out of range — a structure's
 * stage names a POSITION into whichever calendar the competition binds, and that
 * calendar can have fewer blocks than the position expects.
 */
export function findBlock(calendar: SeasonCalendar, blockIndex: number): SeasonBlock | undefined {
  return (calendar.blocks ?? [])[blockIndex];
}

/** Whole days in a block, inclusive of both ends. */
export function blockLengthDays(block: SeasonBlock): number {
  return daysBetween(block.start, block.end) + 1;
}

/**
 * `1 Sep 2026 → 30 Nov 2026` — first block's start to last block's end, the same span
 * CalendarsCard's table shows. A bare calendar label leaves no way to tell two
 * same-named seasons ("2026/27" vs "2026/27 (draft)") apart in a select — used by every
 * calendar/block picker (structures, competitions, admin create-series, the season wizard).
 */
export function calendarSpan(cal: SeasonCalendar): string {
  const usable = cal.blocks.filter((b) => isValidIsoDate(b.start) && isValidIsoDate(b.end));
  if (!usable.length) return 'no dates yet';
  const first = usable.reduce((a, b) => (b.start < a ? b.start : a), usable[0].start);
  const last = usable.reduce((a, b) => (b.end > a ? b.end : a), usable[0].end);
  return `${formatIsoDate(first)} → ${formatIsoDate(last)}`;
}

/** Human cadence label — shared by the preview rail and the series summary line. */
export function describeCadence(cadence: Cadence): string {
  switch (cadence.kind) {
    case 'weekly':
      return 'weekly';
    case 'every-n-weeks':
      return `every ${Math.max(1, Math.round(cadence.n))} weeks`;
    case 'weekdays': {
      const days = (cadence.days ?? []).map((day) => WEEKDAY_LABELS[day]).filter(Boolean);
      return days.length ? `${days.join(' / ')} only` : 'no days selected';
    }
    case 'spread':
      return 'spread across the block';
    default:
      return 'weekly';
  }
}

/**
 * Candidate dates for a cadence, ascending, bounded by the block — BEFORE breaks and
 * excluded dates are applied. `spread` is handled separately (it needs the round count
 * up front to compute its step), so it is not produced here.
 */
function* candidateDates(block: SeasonBlock, from: IsoDate, cadence: Cadence): Generator<IsoDate> {
  if (cadence.kind === 'weekdays') {
    const days = new Set(cadence.days ?? []);
    if (days.size === 0) return;
    let cursor = d(from);
    for (let i = 0; i < MAX_STEPS; i++) {
      const iso = cursor.format(FMT);
      if (iso > block.end) return;
      if (days.has(cursor.day() as Weekday)) yield iso;
      cursor = cursor.add(1, 'day');
    }
    return;
  }
  // weekly / every-n-weeks — a fixed stride from the first date.
  const weeks = cadence.kind === 'every-n-weeks' ? Math.max(1, Math.round(cadence.n)) : 1;
  let cursor = d(from);
  for (let i = 0; i < MAX_STEPS; i++) {
    const iso = cursor.format(FMT);
    if (iso > block.end) return;
    yield iso;
    cursor = cursor.add(weeks, 'week');
  }
}

/**
 * Evenly-spaced dates across `[from, block.end]`, then nudged forward off any blocked
 * day. This is the pre-calendar `spread` behaviour (see `resolveSpread` in data.ts) with
 * break-awareness added.
 *
 * Monotonic by construction: each nudged date is pushed to at least the day after the
 * previous one, so two rounds can never stack on a single date — the same one-day floor
 * the original generator enforced.
 */
function spreadDates(
  calendar: SeasonCalendar,
  block: SeasonBlock,
  from: IsoDate,
  rounds: number,
  skipped: SkippedDate[],
): IsoDate[] {
  const span = daysBetween(from, block.end);
  const step = rounds > 1 ? span / (rounds - 1) : 0;
  const out: IsoDate[] = [];
  for (let r = 0; r < rounds; r++) {
    let candidate = addDays(from, Math.round(r * step));
    // Never before the previous round, and never on a blocked day.
    const floor = out.length ? addDays(out[out.length - 1], 1) : from;
    if (candidate < floor) candidate = floor;
    for (let i = 0; i < MAX_STEPS; i++) {
      const reason = blockedReason(calendar, candidate);
      if (!reason) break;
      skipped.push({ date: candidate, reason });
      candidate = addDays(candidate, 1);
    }
    if (candidate > block.end) break; // overflowed the block — report a partial plan
    out.push(candidate);
  }
  return out;
}

/**
 * Plan one date per round inside a block.
 *
 * A blocked candidate PUSHES the round later rather than dropping it — a mid-season
 * break pauses a league, it does not cancel rounds. When the block runs out before every
 * round is placed the plan comes back partial with `fits: false`; callers show that
 * rather than silently generating a short season.
 *
 * Resilient by design: an unknown block id, a reversed block, or an empty weekday list
 * all return an unfitting plan with an explanatory summary instead of throwing. The
 * operator can delete a block a stored series still references, and a preview must
 * survive that.
 */
export function planRoundDates(req: DatePlanRequest): DatePlan {
  const { calendar, blockId, cadence, rounds } = req;
  const requested = Math.max(0, Math.floor(rounds) || 0);
  const empty = (summary: string): DatePlan => ({
    dates: [],
    fits: requested === 0,
    roundsRequested: requested,
    roundsPlaced: 0,
    skipped: [],
    summary,
  });

  if (requested === 0) return empty('No rounds to schedule');

  // `DatePlanRequest.blockId` is still a concrete id — this plans dates for a persisted
  // `SeriesSchedule` (id-based) as much as a design-time `StageSchedule` (index-based, via
  // the block a caller has already resolved with the exported `findBlock`), so the lookup
  // here stays by id rather than going through the index-based `findBlock`.
  const block = (calendar.blocks ?? []).find((b) => b.id === blockId);
  if (!block) return empty('That playing block no longer exists on this calendar');
  if (!isValidIsoDate(block.start) || !isValidIsoDate(block.end))
    return empty(`${block.label} has an invalid start or end date`);
  if (block.end < block.start) return empty(`${block.label} ends before it starts`);
  if (cadence.kind === 'weekdays' && !(cadence.days ?? []).length)
    return empty('Pick at least one day of the week');

  // Clamp the requested start into the block. Starting past the end is a real
  // configuration mistake, so it is named rather than silently clamped backwards.
  const requestedStart = isValidIsoDate(req.startDate) ? (req.startDate as IsoDate) : block.start;
  if (requestedStart > block.end)
    return empty(`That start date is after ${block.label} ends (${formatIsoDate(block.end)})`);
  const from = requestedStart < block.start ? block.start : requestedStart;

  const skipped: SkippedDate[] = [];
  let dates: IsoDate[];
  if (cadence.kind === 'spread') {
    dates = spreadDates(calendar, block, from, requested, skipped);
  } else {
    dates = [];
    for (const candidate of candidateDates(block, from, cadence)) {
      if (dates.length >= requested) break;
      const reason = blockedReason(calendar, candidate);
      if (reason) {
        skipped.push({ date: candidate, reason });
        continue;
      }
      dates.push(candidate);
    }
  }

  const placed = dates.length;
  const fits = placed >= requested;
  return {
    dates,
    fits,
    roundsRequested: requested,
    roundsPlaced: placed,
    skipped,
    summary: summarise({ block, cadence, dates, requested, placed, fits, skipped }),
  };
}

/**
 * The preview-rail sentence. Says what will happen when it fits, and what to do about it
 * when it doesn't — an operator seeing "4 rounds don't fit" should not have to work out why.
 */
function summarise(a: {
  block: SeasonBlock;
  cadence: Cadence;
  dates: IsoDate[];
  requested: number;
  placed: number;
  fits: boolean;
  skipped: SkippedDate[];
}): string {
  const { block, cadence, dates, requested, placed, fits, skipped } = a;
  const rounds = `${requested} round${requested === 1 ? '' : 's'}`;
  const cad = describeCadence(cadence);

  if (!fits) {
    const short = requested - placed;
    const capacity = placed
      ? `${block.label} fits ${placed} at this cadence`
      : `${block.label} fits none at this cadence`;
    return `${rounds} · ${cad} — ${capacity}; ${short} round${short === 1 ? " doesn't" : "s don't"} fit. Shorten the cadence, start earlier, or extend ${block.label}.`;
  }

  const span = `${formatIsoDate(dates[0])} → ${formatIsoDate(dates[dates.length - 1])}`;
  const spareWeeks = Math.floor(daysBetween(dates[dates.length - 1], block.end) / 7);
  const spare =
    spareWeeks >= 1
      ? ` · ${spareWeeks} week${spareWeeks === 1 ? '' : 's'} spare in ${block.label}`
      : ` · finishes inside ${block.label}`;
  const moved = skipped.length
    ? ` · ${skipped.length} date${skipped.length === 1 ? '' : 's'} moved past ${uniqueReasons(skipped)}`
    : '';
  return `${rounds} · ${cad} · ${span}${spare}${moved}`;
}

/** Distinct skip reasons, comma-joined — "the mid-season break, excluded date". */
function uniqueReasons(skipped: SkippedDate[]): string {
  return [...new Set(skipped.map((s) => s.reason))].join(', ');
}

/**
 * The slot for the i-th fixture within a round, cycling through the configured slots.
 * A round with three fixtures across morning/afternoon slots plays 1st and 3rd in the
 * morning, 2nd in the afternoon — a reasonable default that venue allocation
 * (`src/competition/venues.ts`, ADR 0008) refines with real ground availability.
 */
export function slotForIndex(
  slots: TimeSlot[] | undefined,
  indexInRound: number,
): TimeSlot | undefined {
  if (!Array.isArray(slots) || slots.length === 0) return undefined;
  return slots[indexInRound % slots.length];
}

/**
 * True when a released series should be visible yet. Junior leagues generate their
 * fixtures in advance but must not surface until the second half of the season, so a
 * series carries `activateFrom` and every read-side consumer gates on this. Absent or
 * malformed ⇒ visible, so nothing existing changes behaviour.
 */
export function isActivated(activateFrom: string | undefined, today: IsoDate): boolean {
  if (!isValidIsoDate(activateFrom)) return true;
  return today >= (activateFrom as IsoDate);
}

/**
 * Today as a date-only string. The ONE deliberate local-time read in this module —
 * "which day is it for this union right now" is a wall-clock question, and the region
 * has no DST, so the host's local day is the right answer.
 */
export function todayIso(now: Date = new Date()): IsoDate {
  return dayjs(now).format(FMT);
}
