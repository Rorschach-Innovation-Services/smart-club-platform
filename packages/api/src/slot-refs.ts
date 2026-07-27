/**
 * Knockout forward references — the server-side half.
 *
 * A knockout bracket's later rounds reference earlier fixtures by a reserved-prefix
 * pseudo-id (`win:f3`) because the winner isn't known when fixtures are generated, and
 * the platform has no results model. See ADR 0008 and src/competition/formats.ts.
 *
 * PARITY: a behavioural twin lives in src/competition/formats.ts (used by the admin and
 * club fixture views). Keep the prefixes and the label wording in sync — a club reading
 * "Winner of Semi-final 1" in the portal must see the same words in its emailed schedule.
 * The frontend is the primary implementation; this exists because the API package cannot
 * import from `src/`.
 */

/** Reserved prefix for "the winner of fixture X". */
export const WINNER_PREFIX = 'win:';
/** Reserved prefix for "the loser of fixture X" — third-place playoffs. */
export const LOSER_PREFIX = 'lose:';

/** The fixture a forward reference points at, or null if it isn't one. */
export function slotSource(id: unknown): { kind: 'winner' | 'loser'; fixtureId: string } | null {
  if (typeof id !== 'string') return null;
  if (id.startsWith(WINNER_PREFIX))
    return { kind: 'winner', fixtureId: id.slice(WINNER_PREFIX.length) };
  if (id.startsWith(LOSER_PREFIX))
    return { kind: 'loser', fixtureId: id.slice(LOSER_PREFIX.length) };
  return null;
}

/** The conventional name for a knockout round counted back from the final. */
export function knockoutRoundName(round: number, totalRounds: number): string {
  const fromEnd = totalRounds - round;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semi-final';
  if (fromEnd === 2) return 'Quarter-final';
  return `Round of ${Math.pow(2, fromEnd + 1)}`;
}

interface SlotFixture {
  id?: string;
  round?: number;
  home?: string;
  away?: string;
}

/**
 * Which fixture is the final, and which is the third-place playoff, read from the bracket
 * GRAPH rather than from round shape.
 *
 * The final is the fixture nothing else references (every other one feeds a later match);
 * the playoff is the fixture whose two entrants are both `lose:` refs. `max(round)` is
 * wrong because the playoff is appended after the final, and "two consecutive
 * single-fixture rounds ⇒ playoff" is wrong because a bye produces exactly that shape (a
 * 3-team knockout, or an odd pool count in a cross-pool draw).
 *
 * PARITY: mirrors `bracketShape` in src/competition/formats.ts.
 */
function bracketShape(list: SlotFixture[]): {
  firstRound: number;
  finalRound: number;
  thirdPlaceRound: number | null;
  countOf: (round: number) => number;
} {
  const counts = new Map<number, number>();
  const referenced = new Set<string>();
  for (const f of list) {
    if (!f) continue;
    counts.set(f.round ?? 0, (counts.get(f.round ?? 0) ?? 0) + 1);
    for (const slot of [f.home, f.away]) {
      const src = slotSource(slot);
      if (src) referenced.add(src.fixtureId);
    }
  }
  const countOf = (r: number) => counts.get(r) ?? 0;
  const rounds = [...counts.keys()].sort((a, b) => a - b);
  if (!rounds.length) return { firstRound: 0, finalRound: 0, thirdPlaceRound: null, countOf };

  const isPlayoff = (f: SlotFixture) =>
    slotSource(f.home)?.kind === 'loser' && slotSource(f.away)?.kind === 'loser';
  const playoff = list.find((f) => f && isPlayoff(f));
  const sinks = list.filter((f) => f && !referenced.has(f.id ?? '') && f !== playoff);
  const finalRound = sinks.length
    ? Math.max(...sinks.map((f) => f.round ?? 0))
    : rounds[rounds.length - 1]!;

  return {
    firstRound: rounds[0]!,
    finalRound,
    thirdPlaceRound: playoff ? (playoff.round ?? 0) : null,
    countOf,
  };
}

/**
 * A human label for a forward reference — "Winner of Semi-final 1", or `null` when the
 * id is an ordinary team. Without this a broadcast schedule reads "TBA vs TBA" for every
 * fixture past the first knockout round.
 */
export function slotRefLabel(id: unknown, fixtures: unknown[] = []): string | null {
  const src = slotSource(id);
  if (!src) return null;
  const verb = src.kind === 'winner' ? 'Winner' : 'Loser';
  const list = (Array.isArray(fixtures) ? fixtures : []) as SlotFixture[];
  const target = list.find((f) => f && f.id === src.fixtureId);
  if (!target) return verb;

  const round = target.round ?? 0;
  const shape = bracketShape(list);
  const inRound = list.filter((f) => f?.round === target.round);
  let name: string;
  if (round === shape.thirdPlaceRound) {
    name = 'Third-place playoff';
  } else if (
    // Only the FIRST round can be a play-in. Bounded that way because a bye makes the
    // count test fire on every round of a bracket carrying one, which turned a 3-pool
    // final into "Winner of Preliminary round vs Winner of Preliminary round 3".
    round === shape.firstRound &&
    round < shape.finalRound &&
    shape.countOf(round) !== Math.pow(2, shape.finalRound - round)
  ) {
    name = 'Preliminary round';
  } else {
    name = knockoutRoundName(round, shape.finalRound);
  }
  const idx = inRound.length > 1 ? ` ${inRound.findIndex((f) => f.id === target.id) + 1}` : '';
  return `${verb} of ${name}${idx}`;
}
