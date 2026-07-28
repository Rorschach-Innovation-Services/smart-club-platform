/**
 * Shared date display and arithmetic, on dayjs.
 *
 * Every date the app renders goes through here. Two reasons it is one module rather than
 * a `toLocaleDateString` at each call site:
 *
 * ── ONE SET OF MONTH NAMES ──
 * `Intl` short-month output is ICU-version dependent, and the app was calling it with two
 * different locales: `en-ZA` rendered "21 Jun" while `en-GB` rendered "13 Sept", in the
 * same console, sometimes in adjacent cards. dayjs formats from its own bundled English
 * locale, so the output is identical everywhere and across browser, Node and Lambda.
 *
 * ── DATE-ONLY AND INSTANTS ARE DIFFERENT THINGS ──
 * The distinction the old code blurred, and the one that actually causes bugs:
 *
 *   A DATE-ONLY value (`2026-09-13`) is a calendar day — a fixture date, a deadline, a
 *   meeting. It has no time and no zone. `new Date('2026-09-13')` parses it at UTC
 *   midnight and then renders it in the host's local zone, so west of Greenwich it
 *   displays as the 12th. Those go through {@link formatDay} and friends, which parse
 *   strictly as UTC and format from UTC — the day can never shift.
 *
 *   An INSTANT (`2026-06-04T12:34:56Z`) is a moment — released-at, uploaded-at, a comm-log
 *   entry. Rendering it in local time is correct and wanted. Those go through
 *   {@link formatStamp} and friends.
 *
 * Picking the wrong one is now a visible choice at the call site rather than an accident.
 */

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import customParseFormat from 'dayjs/plugin/customParseFormat';

dayjs.extend(utc);
dayjs.extend(customParseFormat);

const DATE_FMT = 'YYYY-MM-DD';

/**
 * Strictly parse a date-only string as UTC. Invalid input (including a full timestamp,
 * an empty string, or `2026-02-31`) yields an invalid dayjs the formatters check for.
 */
function dateOnly(iso: string | undefined | null) {
  return dayjs.utc(iso ?? '', DATE_FMT, true);
}

/**
 * Parse leniently, accepting either a date-only string or a full timestamp.
 *
 * Some stored fields are inconsistent — `termEnd` and `agm.meetingDate` are written by
 * different forms and can be either shape — so display helpers that face them accept
 * both. A date-only value is still anchored to UTC so it cannot shift a day.
 */
function anyDate(iso: string | undefined | null) {
  if (!iso) return dayjs.utc('');
  const strict = dateOnly(iso);
  return strict.isValid() ? strict : dayjs.utc(iso);
}

/* ─── Date-only display ─── */

/** `2026-09-13` → `13 Sep`. */
export function formatDay(iso?: string): string {
  const d = anyDate(iso);
  return d.isValid() ? d.format('D MMM') : '';
}

/** `2026-09-13` → `13 Sep 2026`. */
export function formatDayYear(iso?: string): string {
  const d = anyDate(iso);
  return d.isValid() ? d.format('D MMM YYYY') : '';
}

/** `2026-06-21` → `21 June 2026`. */
export function formatDayLong(iso?: string): string {
  const d = anyDate(iso);
  return d.isValid() ? d.format('D MMMM YYYY') : '';
}

/** `2026-06-21` → `21 June`. */
export function formatDayMid(iso?: string): string {
  const d = anyDate(iso);
  return d.isValid() ? d.format('D MMMM') : '';
}

/** `2026-09-13` → `Sun 13 Sep`. */
export function formatWeekdayDay(iso?: string): string {
  const d = anyDate(iso);
  return d.isValid() ? d.format('ddd D MMM') : '';
}

/** `2026-09-13` → `Sun 13 Sep 2026`. Used by the schedule export, where the year matters. */
export function formatWeekdayDayYear(iso?: string): string {
  const d = anyDate(iso);
  return d.isValid() ? d.format('ddd D MMM YYYY') : '';
}

/** `2026-09-13` → `Sunday, 13 September 2026`. */
export function formatWeekdayLong(iso?: string): string {
  const d = anyDate(iso);
  return d.isValid() ? d.format('dddd, D MMMM YYYY') : '';
}

/** `2026-09-13` → `Sunday`. */
export function formatWeekdayName(iso?: string): string {
  const d = anyDate(iso);
  return d.isValid() ? d.format('dddd') : '';
}

/* ─── Instant display (local time, deliberately) ─── */

/** A timestamp as a local calendar day: `4 Jun 2026`. */
export function formatStampDay(iso?: string): string {
  if (!iso) return '';
  const d = dayjs(iso);
  return d.isValid() ? d.format('D MMM YYYY') : '';
}

/** A timestamp with its local wall-clock time: `4 Jun 2026, 14:32`. */
export function formatStamp(iso?: string): string {
  if (!iso) return '';
  const d = dayjs(iso);
  return d.isValid() ? d.format('D MMM YYYY, HH:mm') : '';
}

/* ─── Arithmetic ─── */

/**
 * Whole days from today until `iso`, floored at 0. A date-only deadline is compared
 * against today's LOCAL calendar day, which is what "3 days left" means to a user.
 */
export function daysUntilDate(iso?: string, now: Date = new Date()): number {
  const target = anyDate(iso);
  if (!target.isValid()) return 0;
  const today = dayjs.utc(dayjs(now).format(DATE_FMT), DATE_FMT, true);
  return Math.max(0, target.startOf('day').diff(today, 'day'));
}

/** Whole days since an instant, floored at 0. `null` for missing/invalid input. */
export function daysSince(iso?: string, now: number = Date.now()): number | null {
  if (!iso) return null;
  const then = dayjs(iso);
  if (!then.isValid()) return null;
  return Math.max(0, dayjs(now).diff(then, 'day'));
}

/**
 * Compact "time ago" for an instant: `just now` / `2h ago` / `3d ago`.
 * `now` is injectable so output is deterministic under test.
 */
export function timeAgo(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const then = dayjs(iso);
  if (!then.isValid()) return '';
  const secs = Math.max(0, dayjs(now).diff(then, 'second'));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Today as a local date-only string — the app's "what day is it" answer. */
export function todayDate(now: Date = new Date()): string {
  return dayjs(now).format(DATE_FMT);
}

/**
 * True when `iso` is a real calendar day.
 *
 * Strict parsing is the point: `new Date('2027-02-31')` rolls over to 3 March, so code
 * that trusted it had to re-read the month and day afterwards to notice. This just says no.
 */
export function isRealDate(iso?: string): boolean {
  return dateOnly(iso).isValid();
}

/** Whole years from a date-only birthday to today. `null` for missing/invalid input. */
export function wholeYearsSince(iso?: string, now: Date = new Date()): number | null {
  const born = dateOnly(iso);
  if (!born.isValid()) return null;
  return dayjs.utc(dayjs(now).format(DATE_FMT), DATE_FMT, true).diff(born, 'year');
}

/**
 * Whole months until a term-end date, and whether it has already passed.
 *
 * Accepts either a date-only value or a full timestamp, because `termEnd` is written by
 * two different forms. `null` for missing/invalid input.
 */
export function monthsUntil(
  iso?: string,
  now: Date = new Date(),
): { months: number; expired: boolean } | null {
  const end = anyDate(iso);
  if (!end.isValid()) return null;
  const today = dayjs.utc(dayjs(now).format(DATE_FMT), DATE_FMT, true);
  if (!end.isAfter(today)) return { months: 0, expired: true };
  return { months: Math.max(0, end.diff(today, 'month')), expired: false };
}
