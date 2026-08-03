/**
 * Format registry — how fixtures are made within one group, given its entrants.
 *
 * Each format is a pure function `(entrants) => Pairing[][]` (rounds of pairs). Dating
 * happens afterwards in fixtures.ts, so a format knows nothing about calendars and a
 * calendar knows nothing about round-robin rotation.
 *
 * The registry is CLOSED on purpose (ADR 0008): four formats, parameterised, no
 * expression language. Every structure in the KZNCU and EMCU documents composes from
 * these. If a future requirement wants a conditional in configuration, that is the signal
 * to hardcode it rather than widen this.
 *
 * ── FORWARD SLOT REFERENCES ──
 * A knockout bracket's later rounds depend on results from earlier rounds in the SAME
 * stage, and the platform has no results model. Rather than emit only round one, the full
 * bracket is generated with later rounds referencing earlier fixtures by a reserved-prefix
 * pseudo-id (`win:f3`). This mirrors what the union's own spreadsheets do ("QF1 winner vs
 * QF2 winner"), round-trips through storage as a plain string, and stays disjoint from
 * both clubIds (`[a-z0-9-]+`) and the `tm_` team prefix — the same reserved-prefix idiom
 * the codebase already uses for team ids.
 */

import { roundRobinPairings, type Pairing } from './fixtures';
import type { FormatSpec } from '../types';

/**
 * The Series Type options offered wherever an admin picks a match format — the ad-hoc
 * CreateSeriesForm (admin.tsx) and a flat season's synthesized competition
 * (StartFlatSeasonForm, season-run.tsx). One list so the two forms can't drift apart.
 */
export const SERIES_TYPES = [
  'Twenty20 (16-25 overs)',
  'One-Day (40-50 overs)',
  'Multi-Day',
  'The Hundred',
] as const;

/** The overs a new series/season defaults to before the admin touches the field. */
export const DEFAULT_SERIES_OVERS = 20;

/** Reserved prefix for "the winner of fixture X", used before results exist. */
export const WINNER_PREFIX = 'win:';
/** Reserved prefix for "the loser of fixture X" — third-place playoffs. */
export const LOSER_PREFIX = 'lose:';

/** A forward reference to the winner of a fixture. */
export const winnerOf = (fixtureId: string): string => `${WINNER_PREFIX}${fixtureId}`;
/** A forward reference to the loser of a fixture. */
export const loserOf = (fixtureId: string): string => `${LOSER_PREFIX}${fixtureId}`;

/** True when an entrant id is a forward reference rather than a real team. */
export function isSlotRef(id: string): boolean {
  return typeof id === 'string' && (id.startsWith(WINNER_PREFIX) || id.startsWith(LOSER_PREFIX));
}

/** The fixture id a forward reference points at, or null if it isn't one. */
export function slotSource(id: string): { kind: 'winner' | 'loser'; fixtureId: string } | null {
  if (typeof id !== 'string') return null;
  if (id.startsWith(WINNER_PREFIX))
    return { kind: 'winner', fixtureId: id.slice(WINNER_PREFIX.length) };
  if (id.startsWith(LOSER_PREFIX))
    return { kind: 'loser', fixtureId: id.slice(LOSER_PREFIX.length) };
  return null;
}

/**
 * The conventional name for a knockout round counted back from the final: `Final`,
 * `Semi-final`, `Quarter-final`, then `Round of 16`, `Round of 32`, …
 */
export function knockoutRoundName(round: number, totalRounds: number): string {
  const fromEnd = totalRounds - round; // 0 = final, 1 = semi, 2 = quarter
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semi-final';
  if (fromEnd === 2) return 'Quarter-final';
  return `Round of ${Math.pow(2, fromEnd + 1)}`;
}

/** The minimal fixture shape slot-reference labelling needs. */
export interface SlotFixture {
  id: string;
  round: number;
  home?: string;
  away?: string;
}

/**
 * Work out which fixture is the final, and which (if any) is the third-place playoff,
 * from the fixture list alone.
 *
 * Read from the BRACKET GRAPH, not from round shape:
 *
 * - The **final** is the one fixture nothing else references. Every other fixture feeds a
 *   later one via a `win:`/`lose:` slot, so the sink is the final by construction —
 *   including when a third-place playoff is appended after it, which is what makes
 *   `max(round)` wrong (it would call the final a semi-final).
 * - The **third-place playoff** is the fixture whose entrants are `lose:` references.
 *   Nothing else in a knockout pairs two losers.
 *
 * An earlier version inferred the playoff from "two consecutive single-fixture rounds",
 * on the reasoning that a bracket never has two one-match rounds in a row. It does:
 * `bracketFromMatchOrder` carries an odd entrant through as a bye, so a 3-team knockout is
 * a one-match preliminary followed by a one-match final, and an odd pool count does the
 * same thing to a cross-pool draw. Both are configurable today, and both were labelled
 * backwards.
 *
 * `countOf` still identifies a play-in: a round whose fixture count doesn't match its
 * place in the bracket (`2^(finalRound - round)`) is a preliminary, not a "Round of 16".
 */
function bracketShape(fixtures: SlotFixture[]): {
  firstRound: number;
  finalRound: number;
  thirdPlaceRound: number | null;
  countOf: (round: number) => number;
} {
  const counts = new Map<number, number>();
  const referenced = new Set<string>();
  for (const f of fixtures) {
    if (!f) continue;
    counts.set(f.round, (counts.get(f.round) ?? 0) + 1);
    for (const slot of [f.home, f.away]) {
      const src = slotSource(slot ?? '');
      if (src) referenced.add(src.fixtureId);
    }
  }
  const countOf = (r: number) => counts.get(r) ?? 0;
  const rounds = [...counts.keys()].sort((a, b) => a - b);
  if (!rounds.length) return { firstRound: 0, finalRound: 0, thirdPlaceRound: null, countOf };

  const isPlayoff = (f: SlotFixture) =>
    slotSource(f.home ?? '')?.kind === 'loser' && slotSource(f.away ?? '')?.kind === 'loser';
  const playoff = fixtures.find((f) => f && isPlayoff(f));
  // Among the fixtures nothing feeds from, the final is the one that isn't the playoff.
  const sinks = fixtures.filter((f) => f && !referenced.has(f.id) && f !== playoff);
  const finalRound = sinks.length
    ? Math.max(...sinks.map((f) => f.round))
    : // No graph to read (a flat list with no slot refs at all) — fall back to the last
      // round, which is right for every bracket that has no playoff.
      rounds[rounds.length - 1];

  return {
    firstRound: rounds[0],
    finalRound,
    thirdPlaceRound: playoff ? playoff.round : null,
    countOf,
  };
}

/**
 * A human label for a forward reference — "Winner of Semi-final 1".
 *
 * Without this, a knockout's later rounds reach the UI as raw `win:f3` ids, and every
 * display path resolves them through `resolveTeam`, which finds no matching participant
 * and renders "Unknown team". A whole bracket beyond round one reads as
 * "Unknown team vs Unknown team".
 *
 * Falls back to the fixture's round number when the bracket shape can't be inferred, and
 * to a bare "Winner"/"Loser" when the referenced fixture is missing entirely — every
 * branch is more use than "Unknown team".
 */
export function slotRefLabel(id: string, fixtures: SlotFixture[] = []): string | null {
  const src = slotSource(id);
  if (!src) return null;
  const verb = src.kind === 'winner' ? 'Winner' : 'Loser';
  const target = fixtures.find((f) => f && f.id === src.fixtureId);
  if (!target) return verb;

  const shape = bracketShape(fixtures);
  const inRound = fixtures.filter((f) => f?.round === target.round);
  let name: string;
  if (target.round === shape.thirdPlaceRound) {
    name = 'Third-place playoff';
  } else if (
    // Only the FIRST round can be a play-in — 9 entrants give one preliminary before a
    // round of 8, not a round of 16.
    //
    // Bounded to the first round because a bye makes the count test fire on every round
    // of a bracket that carries one: a 3-pool cross-pool draw would have read "Winner of
    // Preliminary round vs Winner of Preliminary round 3" — two different rounds,
    // indistinguishable labels — on a published schedule and in the player broadcast.
    target.round === shape.firstRound &&
    target.round < shape.finalRound &&
    shape.countOf(target.round) !== Math.pow(2, shape.finalRound - target.round)
  ) {
    name = 'Preliminary round';
  } else {
    name = knockoutRoundName(target.round, shape.finalRound);
  }
  // Only number the match when its round has more than one — "Semi-final 1" is useful,
  // "Final 1" is not.
  const idx = inRound.length > 1 ? ` ${inRound.findIndex((f) => f.id === target.id) + 1}` : '';
  return `${verb} of ${name}${idx}`;
}

/**
 * Round-robin over `legs` passes.
 *
 * `mirrored` (the default, and what both unions do) plays a whole leg then repeats it
 * with home and away swapped — round 6 of a six-team double round is round 1 reversed.
 * `interleaved` plays each round immediately followed by its reverse, which some leagues
 * prefer because it keeps the return fixture close to the original.
 */
export function roundRobinRounds(
  entrants: string[],
  legs: 1 | 2 | 3 = 1,
  legOrder: 'mirrored' | 'interleaved' = 'mirrored',
): Pairing[][] {
  const base = roundRobinPairings(entrants);
  if (base.length === 0 || legs <= 1) return base;

  const reversed = (rounds: Pairing[][]): Pairing[][] =>
    rounds.map((r) => r.map(([h, a]) => [a, h] as Pairing));

  if (legOrder === 'interleaved') {
    const out: Pairing[][] = [];
    for (let i = 0; i < base.length; i++) {
      for (let leg = 0; leg < legs; leg++) {
        out.push(leg % 2 === 0 ? base[i] : base[i].map(([h, a]) => [a, h] as Pairing));
      }
    }
    return out;
  }

  const out: Pairing[][] = [];
  for (let leg = 0; leg < legs; leg++) {
    out.push(...(leg % 2 === 0 ? base : reversed(base)));
  }
  return out;
}

/** Largest power of two ≤ n (the main-draw size a knockout trims down to). */
function largestPowerOfTwoAtMost(n: number): number {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

/**
 * How a knockout field of `n` resolves into a bracket.
 *
 * The union's Kingsmead Cup is the worked example: 9 qualifiers, one preliminary between
 * the two lowest seeds, leaving 8 for a clean quarter-final round. Generalised: trim to
 * the largest power of two at or below `n` by playing `n - mainDraw` preliminaries among
 * the lowest `2 * (n - mainDraw)` seeds.
 */
export function knockoutShape(n: number): {
  mainDraw: number;
  preliminaries: number;
  /** Seeds entering the main draw directly (the top ones). */
  directEntries: number;
  rounds: number;
} {
  if (n < 2) return { mainDraw: 0, preliminaries: 0, directEntries: 0, rounds: 0 };
  const mainDraw = largestPowerOfTwoAtMost(n);
  const preliminaries = n - mainDraw;
  return {
    mainDraw,
    preliminaries,
    directEntries: n - preliminaries * 2,
    rounds: Math.log2(mainDraw) + (preliminaries > 0 ? 1 : 0),
  };
}

/**
 * Standard seeded bracket order for a power-of-two draw: the sequence of seed indices
 * (0-based) such that adjacent pairs are the first-round matches, seeds 1 and 2 can only
 * meet in the final, and every round preserves that property.
 *
 * For 8: `[0,7,3,4,1,6,2,5]` → 1v8, 4v5, 2v7, 3v6. Seeds 1 and 2 sit in opposite halves,
 * so the four matches are the same SET the union's spreadsheet lists but in a different
 * order — the sheet's own semi-final pairing would have put 1 and 2 in the same half.
 */
export function seedOrder(size: number): number[] {
  let order = [0, 1];
  while (order.length < size) {
    const n = order.length * 2;
    const next: number[] = [];
    for (const s of order) {
      next.push(s, n - 1 - s);
    }
    order = next;
  }
  return order;
}

/**
 * A knockout bracket over `entrants` in seed order (strongest first).
 *
 * Later rounds reference earlier fixtures via `win:`/`lose:` pseudo-ids — see the module
 * header. Fixture ids here must match the ids `fixturesFromDates` assigns, which number
 * sequentially from `f1` across the whole stage, so the references resolve.
 *
 * NOTE ON THE SOURCE SPREADSHEET: the union's Kingsmead Cup template pairs its semi-finals
 * QF1 v QF4 and QF2 v QF3, which would let the top two seeds meet in a semi. That sheet is
 * flagged low-confidence in the source document ("Seeds below are placeholders"). This
 * generates the standard bracket instead — same quarter-final pairings, correct semis.
 */
export function knockoutRounds(
  entrants: string[],
  opts: { thirdPlace?: boolean } = {},
): Pairing[][] {
  const n = entrants.length;
  if (n < 2) return [];
  const { mainDraw, preliminaries } = knockoutShape(n);

  const rounds: Pairing[][] = [];
  // Sequential fixture numbering must mirror fixturesFromDates so `win:fN` resolves.
  let nextId = 1;
  const idFor = () => 'f' + nextId++;

  // Preliminary round: the lowest 2*preliminaries seeds pair off, best v worst.
  let mainDrawEntrants: string[];
  if (preliminaries > 0) {
    const direct = entrants.slice(0, n - preliminaries * 2);
    const playIn = entrants.slice(n - preliminaries * 2);
    const prelimPairs: Pairing[] = [];
    const prelimWinners: string[] = [];
    for (let i = 0; i < preliminaries; i++) {
      const home = playIn[i];
      const away = playIn[playIn.length - 1 - i];
      const id = idFor();
      prelimPairs.push([home, away]);
      prelimWinners.push(winnerOf(id));
    }
    rounds.push(prelimPairs);
    mainDrawEntrants = [...direct, ...prelimWinners];
  } else {
    mainDrawEntrants = [...entrants];
  }

  // Main draw: standard seeded bracket, then winners forward until one remains.
  const order = seedOrder(mainDraw);
  let current: string[] = order.map((i) => mainDrawEntrants[i]);
  let lastRoundIds: string[] = [];

  while (current.length > 1) {
    const pairs: Pairing[] = [];
    const ids: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const id = idFor();
      pairs.push([current[i], current[i + 1]]);
      ids.push(id);
    }
    rounds.push(pairs);
    lastRoundIds = ids;
    current = ids.map(winnerOf);
  }

  // Third place: the two losing semi-finalists. `lastRoundIds` is the final at this
  // point, so the semis are the round before it.
  if (opts.thirdPlace && rounds.length >= 2) {
    const semiIds = semiFinalIds(rounds, lastRoundIds);
    if (semiIds.length === 2) rounds.push([[loserOf(semiIds[0]), loserOf(semiIds[1])]]);
  }
  return rounds;
}

/**
 * Recover the two semi-final fixture ids. The final's participants are `win:<semiId>`
 * references, so read them straight off rather than re-deriving the numbering.
 */
function semiFinalIds(rounds: Pairing[][], finalIds: string[]): string[] {
  void finalIds;
  const final = rounds[rounds.length - 1];
  if (!final || final.length !== 1) return [];
  return final[0].map((ref) => slotSource(ref)?.fixtureId).filter((x): x is string => !!x);
}

/**
 * Cross-pool knockout: pool qualifiers paired so no two teams from the same pool meet
 * before they have to. With two pools taking their top two that is A1 v B2 and B1 v A2;
 * with four pools taking winners only it is A v B and C v D.
 *
 * `qualifiers[i]` is pool i's list, best-placed first.
 */
export function crossPoolRounds(
  qualifiers: string[][],
  opts: { thirdPlace?: boolean } = {},
): Pairing[][] {
  const pools = qualifiers.filter((q) => q.length > 0);
  if (pools.length < 2) return [];

  const perPool = Math.min(...pools.map((p) => p.length));
  const seeded: string[] = [];
  if (perPool >= 2) {
    // Two pools × top two: A1 v B2, B1 v A2. Build the seed list so the standard
    // bracket produces exactly that pairing.
    for (let i = 0; i < pools.length; i++) {
      seeded.push(pools[i][0]);
      seeded.push(pools[(i + 1) % pools.length][1]);
    }
  } else {
    // Winners only: adjacent pools meet — A v B, C v D.
    for (const p of pools) seeded.push(p[0]);
  }

  // EVERY qualifier must make the bracket. The two branches above take a fixed shape —
  // one per pool, or exactly two per pool — so uneven qualification silently loses
  // people: "top one from each pool plus the best runner-up" is a routine rule and falls
  // into the winners-only branch, dropping the runner-up entirely. A club left out of the
  // bracket still appears in the series' team list, so it would open the portal to a
  // season with none of its own fixtures. Refuse rather than emit a lossy draw; the
  // caller falls back to a seeded bracket over the full field.
  if (new Set(seeded).size !== pools.flat().length) return [];

  // Pair adjacent entries directly rather than through seedOrder: the list above is
  // already in match order, and re-seeding it would undo the cross-pool intent.
  return bracketFromMatchOrder(seeded, opts);
}

/** Build a knockout from a list already in first-round match order (pairs are adjacent). */
export function bracketFromMatchOrder(
  matchOrder: string[],
  opts: { thirdPlace?: boolean } = {},
): Pairing[][] {
  if (matchOrder.length < 2) return [];
  const rounds: Pairing[][] = [];
  let nextId = 1;
  let current = [...matchOrder];
  let lastIds: string[] = [];

  while (current.length > 1) {
    const pairs: Pairing[] = [];
    const ids: string[] = [];
    for (let i = 0; i + 1 < current.length; i += 2) {
      const id = 'f' + nextId++;
      pairs.push([current[i], current[i + 1]]);
      ids.push(id);
    }
    // An odd entrant gets a bye into the next round.
    const carried = current.length % 2 === 1 ? [current[current.length - 1]] : [];
    rounds.push(pairs);
    lastIds = ids;
    current = [...ids.map(winnerOf), ...carried];
  }

  if (opts.thirdPlace && rounds.length >= 2) {
    const semis = semiFinalIds(rounds, lastIds);
    if (semis.length === 2) rounds.push([[loserOf(semis[0]), loserOf(semis[1])]]);
  }
  return rounds;
}

/**
 * Apply a format to one group's entrants. `crossPoolQualifiers` is only meaningful for a
 * cross-pool knockout, where the "group" is really the set of qualifying pools.
 */
/** The pools name the same set of sides as the stage's entrants — no more, no fewer. */
function coversExactly(pools: string[][], entrants: string[]): boolean {
  const flat = pools.flat();
  if (flat.length !== entrants.length) return false;
  const want = new Set(entrants);
  return flat.length === new Set(flat).size && flat.every((t) => want.has(t));
}

/**
 * The cross-pool bracket for a stage, or `null` when one can't honestly be built.
 *
 * Separated out so callers can TELL whether the cross-pool path ran, rather than
 * inferring it by re-running both generators and diffing — which can't distinguish
 * "fell back" from "the two agree", and warned falsely on the simplest structure there
 * is (two pools, one qualifier each, straight final).
 *
 * Returns null when the pools don't name exactly this stage's entrants, or when
 * `crossPoolRounds` refuses a shape it can't express without dropping somebody.
 */
export function crossPoolPairings(
  format: FormatSpec,
  entrants: string[],
  qualifiers?: string[][],
): Pairing[][] | null {
  if (format.kind !== 'knockout' || format.pairing !== 'cross-pool') return null;
  if (!qualifiers?.length || !coversExactly(qualifiers, entrants)) return null;
  const rounds = crossPoolRounds(qualifiers, { thirdPlace: format.thirdPlace });
  return rounds.length ? rounds : null;
}

export function roundsForFormat(
  format: FormatSpec,
  entrants: string[],
  crossPoolQualifiers?: string[][],
): Pairing[][] {
  switch (format.kind) {
    case 'round-robin':
      return roundRobinRounds(entrants, format.legs, format.legOrder);
    case 'knockout':
      // ALWAYS a bracket. `crossPoolPairings` returns null whenever a cross-pool draw
      // can't be built honestly — the pools don't name exactly these entrants, or the
      // shape would drop a qualifier — and the seeded bracket over the full field takes
      // over: wrong in pairing, never wrong in personnel, and never empty. Returning the
      // refusal verbatim gave a stage that generated ZERO fixtures and still called
      // itself ready to generate.
      return (
        crossPoolPairings(format, entrants, crossPoolQualifiers) ??
        knockoutRounds(entrants, { thirdPlace: format.thirdPlace })
      );
    case 'single-match':
      return entrants.length >= 2 ? [[[entrants[0], entrants[1]]]] : [];
    case 'manual':
      return [];
    default:
      return [];
  }
}

/**
 * How a format reads in a sentence — the second clause of a collapsed stage row.
 * Written to complete "each group …", so it starts with a verb where it can.
 */
export function describeFormat(format: FormatSpec): string {
  switch (format.kind) {
    case 'round-robin':
      if (format.legs === 1) return 'plays every team once';
      if (format.legs === 2) return 'plays every team twice, home and away';
      return `plays every team ${format.legs} times`;
    case 'knockout':
      return format.pairing === 'cross-pool'
        ? `cross-pool knockout${format.thirdPlace ? ' with a third-place playoff' : ''}`
        : `seeded knockout${format.thirdPlace ? ' with a third-place playoff' : ''}`;
    case 'single-match':
      return 'a single match';
    case 'manual':
      return 'fixtures entered by hand';
    default:
      return 'plays every team once';
  }
}

/** How many rounds a format produces for a given entrant count — drives calendar fit. */
export function roundCountForFormat(format: FormatSpec, entrantCount: number): number {
  switch (format.kind) {
    case 'round-robin': {
      if (entrantCount < 2) return 0;
      const perLeg = entrantCount % 2 === 0 ? entrantCount - 1 : entrantCount;
      return perLeg * format.legs;
    }
    case 'knockout': {
      const shape = knockoutShape(entrantCount);
      return shape.rounds + (format.thirdPlace ? 1 : 0);
    }
    case 'single-match':
      return entrantCount >= 2 ? 1 : 0;
    case 'manual':
      return 0;
    default:
      return 0;
  }
}
