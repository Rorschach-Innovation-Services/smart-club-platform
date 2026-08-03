/**
 * Fixture generation — pairings and the two ways of dating them.
 *
 * Split deliberately in two halves that used to be one loop in `generateRoundRobin`:
 *
 *   WHO plays WHOM   → `roundRobinPairings` (circle method, pure, no dates)
 *   WHEN they play   → a list of round dates, from either the legacy start-date stepping
 *                      or the season calendar (`planRoundDates`)
 *
 * Separating them is what lets one league schedule weekly inside Block 1 while another
 * plays Saturdays-only, without either knowing anything about round-robin rotation.
 *
 * `generateRoundRobin` in src/data.ts is now a thin wrapper over these, and must stay
 * behaviour-identical — its create/regenerate parity test in src/data.test.ts is the gate.
 */

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { slotForIndex } from './calendar';
import type { IsoDate, IsoTime, TimeSlot } from '../types';

dayjs.extend(utc);

const FMT = 'YYYY-MM-DD';
const DAY_MS = 86400000;

/** A pairing before it has a date: `[homeTeamId, awayTeamId]`. */
export type Pairing = [string, string];

export interface GeneratedFixture {
  id: string;
  round: number;
  date: IsoDate;
  home: string;
  away: string;
  /** Wall-clock start, when the schedule defines time slots. */
  time?: IsoTime;
  /** The slot's human label, e.g. "Morning" — shown beside the time. */
  slot?: string;
}

/**
 * Round-robin pairings by the circle method: team 0 is fixed, the rest rotate one place
 * per round, and each round pairs from both ends inwards. An odd roster is padded with a
 * bye, which simply yields fewer pairings in the rounds that carry it.
 *
 * Home/away alternates by round (`round % 2`), which is a crude but fair-enough balance —
 * ADR 0008 notes that a real home/away optimiser is deferred, with a per-team balance
 * report instead. Note this differs from the unions' hand-built spreadsheets, which use
 * the raw circle method with no alternation; the PAIRINGS match exactly, the home/away
 * side of even rounds does not.
 */
export function roundRobinPairings(teamIds: (string | null)[]): Pairing[][] {
  if (!Array.isArray(teamIds) || teamIds.length < 2) return [];
  const teams = [...teamIds];
  if (teams.length % 2 === 1) teams.push(null); // bye
  const n = teams.length;
  const rounds: Pairing[][] = [];

  for (let r = 0; r < n - 1; r++) {
    const pairs: Pairing[] = [];
    for (let i = 0; i < n / 2; i++) {
      const home = teams[i];
      const away = teams[n - 1 - i];
      if (!home || !away) continue; // the bye sits this one out
      const swap = r % 2 === 1;
      pairs.push(swap ? [away, home] : [home, away]);
    }
    rounds.push(pairs);
    // Rotate, keeping teams[0] fixed.
    const fixed = teams[0];
    const rest = teams.slice(1);
    rest.unshift(rest.pop() as string | null);
    teams.splice(0, teams.length, fixed, ...rest);
  }
  return rounds;
}

/** How many rounds a roster of this size produces (odd rosters carry a bye). */
export function roundsForTeamCount(teamCount: number): number {
  if (teamCount < 2) return 0;
  return teamCount % 2 === 0 ? teamCount - 1 : teamCount;
}

/**
 * The pre-calendar date stepping, preserved exactly: one round per week, or — when an end
 * date drives the schedule — rounds spread evenly so the last lands on the end date. The
 * one-day floor stops rounds stacking on a single date when the window is too short for
 * the round count.
 *
 * Kept for series created before season calendars existed, so regenerating one reproduces
 * the dates it already has.
 */
export function legacyRoundDates(
  rounds: number,
  startDateISO: string,
  options: { endDateISO?: string; spread?: boolean } = {},
): IsoDate[] {
  if (rounds <= 0) return [];
  const start = dayjs.utc(startDateISO);
  // The pre-dayjs version threw a RangeError from `toISOString()` here. Keeping a loud
  // failure matters more than the exact error type: without it every fixture is dated
  // the string "Invalid Date", `POST /series` stores them (it does no fixture
  // validation), and the club portal renders a blank date. A crash at the point of the
  // mistake is recoverable; a persisted one is not.
  //
  // Parsing stays LENIENT (no strict format) so the legacy path keeps accepting the
  // date shapes it always has — the strict-parse guarantee in ADR 0008 covers the
  // calendar engine, which is the path that decides real fixture dates.
  // `!startDateISO` is checked separately because `dayjs.utc(undefined)` returns NOW,
  // not an invalid date — so `isValid()` alone would let a missing start date through
  // and silently date every round from today, which is the persisted-bad-data outcome
  // this guard exists to prevent.
  if (!startDateISO || !start.isValid()) {
    throw new RangeError(`generateRoundRobin: invalid start date ${JSON.stringify(startDateISO)}`);
  }
  const { endDateISO, spread } = options;
  const end = spread && endDateISO ? dayjs.utc(endDateISO) : null;
  const rawStep = end && rounds > 1 ? (end.valueOf() - start.valueOf()) / (rounds - 1) : 7 * DAY_MS;
  const step = Math.max(rawStep, DAY_MS);
  const out: IsoDate[] = [];
  for (let r = 0; r < rounds; r++) out.push(start.add(r * step, 'millisecond').format(FMT));
  return out;
}

/**
 * Attach dates (and slots, if any) to pairings.
 *
 * Rounds with no date are dropped rather than guessed at: an over-constrained calendar
 * returns a short date list, and emitting a dateless fixture would put an "Invalid Date"
 * in front of a club. Callers gate on `DatePlan.fits` before getting here.
 */
export function fixturesFromDates(
  rounds: Pairing[][],
  dates: IsoDate[],
  slots?: TimeSlot[],
  opts: { roundsPerDay?: number } = {},
): GeneratedFixture[] {
  // A double-header round shares ONE slot across every fixture in it (the whole round is
  // the AM or PM sitting), matching `dates` now carrying a date twice in a row for its
  // AM/PM pair. Anything else keeps the original per-fixture-index cycling within a round.
  const byRound = Array.isArray(slots) && slots.length > 0 && opts.roundsPerDay === 2;
  const out: GeneratedFixture[] = [];
  let fixtureId = 1;
  for (let r = 0; r < rounds.length && r < dates.length; r++) {
    const roundSlot = byRound ? (slots as TimeSlot[])[r % (slots as TimeSlot[]).length] : undefined;
    rounds[r].forEach(([home, away], i) => {
      const slot = byRound ? roundSlot : slotForIndex(slots, i);
      out.push({
        id: 'f' + fixtureId++,
        round: r + 1,
        date: dates[r],
        home,
        away,
        ...(slot ? { time: slot.start, slot: slot.label } : {}),
      });
    });
  }
  return out;
}

/**
 * Round-robin fixtures dated from a season calendar plan — the calendar-aware sibling of
 * `generateRoundRobin`. Pass `plan.dates` from `planRoundDates`.
 */
export function fixturesFromPlan(
  teamIds: (string | null)[],
  dates: IsoDate[],
  slots?: TimeSlot[],
  opts: { roundsPerDay?: number } = {},
): GeneratedFixture[] {
  return fixturesFromDates(roundRobinPairings(teamIds), dates, slots, opts);
}
