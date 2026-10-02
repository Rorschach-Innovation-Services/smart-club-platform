/**
 * Stable fixture identity across re-imports (medicoach sync, ADR 0016).
 *
 * A fixture's id is half of its sync ref (`smartclub:<t>:fixture:<seriesId>:<fixtureId>`),
 * the only id medicoach knows it by. The Plan-B importer used to mint ids `f1..fN` from
 * sheet row order on every run, so one inserted row shifted every later id and silently
 * re-pointed the synced refs at different matches. These helpers make a re-import keep
 * the ids it already wrote:
 *
 *   - an incoming row matches an existing fixture on date + unordered pair (the series is
 *     one league), with the kick-off time breaking ties when a pair meets twice that day;
 *   - a row still unmatched then matches a remaining fixture on the unordered pair alone
 *     (its date moved — on the sheet, or by a medicoach reschedule smart club applied): the
 *     same round first, then the nearest date, so a moved match keeps its id and its date
 *     change goes out as an ordinary schedule push instead of forking a new ref;
 *   - matched rows keep the existing id and its sync-owned fields;
 *   - new rows get ids above the highest id the series has EVER held (max + 1, …), so a
 *     removed fixture's id — and therefore its ref — is never reused for another match;
 *   - existing fixtures with no incoming row are reported, never silently dropped (the
 *     importer's admin-edit gate refuses to overwrite them without --discard-edits).
 *
 * Pure: no repo, no I/O — unit-tested directly.
 */

/** The fixture fields this module reads/carries. Everything else rides along untouched. */
export interface IdentityFixture {
  id?: string;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  /** The fixture's round, when the series numbers them (breaks a pair-only tie). */
  round?: number | string;
  /** Explicit sync ref (knockouts created from a recipe); absent ⇒ the derived ref. */
  syncRef?: string;
  /** Sync bookkeeping: when the schedule last changed (most-recent-wins, Slice 3/4). */
  schedule?: { changedAt?: string };
}

/**
 * Fixture fields owned by the sync, not by any sheet or admin form. A rewrite of the
 * series (an importer's putSeries, a CLI) must carry them over from the stored fixture,
 * or the next pull can no longer map/order the fixture.
 */
export const SYNC_OWNED_FIXTURE_FIELDS = ['syncRef', 'schedule'] as const;

/** Copy the sync-owned fields from `from` onto `to` (only those `from` actually has). */
export function carrySyncOwnedFields<T extends IdentityFixture>(from: IdentityFixture, to: T): T {
  if (from.syncRef !== undefined && to.syncRef === undefined) to.syncRef = from.syncRef;
  if (from.schedule !== undefined && to.schedule === undefined) to.schedule = from.schedule;
  return to;
}

/** The fixture's sync ref: its explicit `syncRef`, else the derived series/fixture ref. */
export function fixtureSyncRef(tenant: string, seriesId: string, f: IdentityFixture): string {
  return f.syncRef ?? `smartclub:${tenant}:fixture:${seriesId}:${f.id ?? ''}`;
}

const sidesKey = (f: IdentityFixture) =>
  [String(f.home ?? ''), String(f.away ?? '')].sort().join('|');
const pairKey = (f: IdentityFixture) => `${f.date ?? ''}|${sidesKey(f)}`;

/** Whole days between two YYYY-MM-DD dates; a missing/invalid date sorts last. */
function dayGap(a: string | undefined, b: string | undefined): number {
  const x = Date.parse(a ?? '');
  const y = Date.parse(b ?? '');
  return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) / 86_400_000 : Infinity;
}

/** Numeric part of an `f<N>` id, or 0 for any other shape. */
function idNumber(id: string | undefined): number {
  const m = /^f(\d+)$/.exec(id ?? '');
  return m ? Number(m[1]) : 0;
}

export interface IdReconciliation<T> {
  /** The incoming fixtures (same objects, same order) with stable ids assigned. */
  fixtures: T[];
  /** Incoming rows that matched an existing fixture (kept its id). */
  matched: number;
  /** Ids minted for incoming rows with no existing match. */
  added: string[];
  /** Existing fixtures with no incoming row — reported, never silently dropped. */
  removed: IdentityFixture[];
}

/**
 * Assign stable ids to `incoming` (mutated in place and returned) from the series'
 * `existing` fixtures. With no existing fixtures this is a no-op apart from filling any
 * missing ids, so a first import still writes `f1..fN`.
 */
export function reconcileFixtureIds<T extends IdentityFixture>(
  existing: IdentityFixture[],
  incoming: T[],
): IdReconciliation<T> {
  const pool = new Map<string, IdentityFixture[]>();
  for (const f of existing) {
    const k = pairKey(f);
    (pool.get(k) ?? pool.set(k, []).get(k)!).push(f);
  }
  // Keep each bucket in id order so an all-else-equal tie pairs first-with-first.
  for (const list of pool.values()) list.sort((a, b) => idNumber(a.id) - idNumber(b.id));

  const assigned = new Map<T, IdentityFixture>();
  // Pass 1: exact time within the date+pair bucket (a pair meeting twice in a day).
  for (const f of incoming) {
    const list = pool.get(pairKey(f));
    if (!list?.length) continue;
    const i = list.findIndex((e) => (e.time ?? '') === (f.time ?? ''));
    if (i >= 0) assigned.set(f, list.splice(i, 1)[0]);
  }
  // Pass 2: same date + pair, time changed — first remaining in id order.
  for (const f of incoming) {
    if (assigned.has(f)) continue;
    const list = pool.get(pairKey(f));
    if (list?.length) assigned.set(f, list.shift()!);
  }

  // Pass 3: the date moved. Among the fixtures still unmatched, the unordered pair alone;
  // when a pair meets more than once, the same round first, then the nearest date, then the
  // lowest id.
  const leftover = [...pool.values()].flat();
  for (const f of incoming) {
    if (assigned.has(f)) continue;
    const sides = sidesKey(f);
    let best = -1;
    let bestKey: [number, number, number] | undefined;
    leftover.forEach((e, i) => {
      if (sidesKey(e) !== sides) return;
      const sameRound = f.round !== undefined && String(e.round) === String(f.round) ? 0 : 1;
      const key: [number, number, number] = [sameRound, dayGap(e.date, f.date), idNumber(e.id)];
      if (
        !bestKey ||
        key[0] < bestKey[0] ||
        (key[0] === bestKey[0] &&
          (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))
      ) {
        best = i;
        bestKey = key;
      }
    });
    if (best >= 0) assigned.set(f, leftover.splice(best, 1)[0]);
  }

  let next = Math.max(0, ...existing.map((f) => idNumber(f.id)));
  const added: string[] = [];
  for (const f of incoming) {
    const prior = assigned.get(f);
    if (prior) {
      f.id = prior.id;
      carrySyncOwnedFields(prior, f);
    } else {
      f.id = `f${++next}`;
      added.push(f.id);
    }
  }
  const removed = leftover.sort((a, b) => idNumber(a.id) - idNumber(b.id));
  return {
    fixtures: incoming,
    matched: incoming.length - added.length,
    added: existing.length ? added : [],
    removed,
  };
}
