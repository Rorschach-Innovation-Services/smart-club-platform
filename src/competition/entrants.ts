/**
 * Entrant registry — where a stage's teams come from.
 *
 * Three resolvers, deliberately. The platform has no results or ladder model, so a
 * resolver that reads standings could never actually resolve; rather than ship seven
 * resolvers of which five permanently answer "ask a human", everything
 * standings-dependent is `manual` carrying a {@link DerivationNote} that states the rule
 * (see ADR 0008). The note drives the prefill and the audit trail, and promotes to a real
 * resolver unchanged if results capture ever lands.
 *
 * Every resolver returns `resolved` or `awaiting` — never throws — because `awaiting` is a
 * normal, displayable state that the admin console renders as a confirmation step.
 */

import type { EntrantSpec, GroupPlan } from '../types';

/** One group of entrants, in seed order where that is meaningful. */
export interface ResolvedGroup {
  id: string;
  label: string;
  entrants: string[];
}

export type EntrantResolution =
  | { status: 'resolved'; groups: ResolvedGroup[] }
  | {
      status: 'awaiting';
      /** Why a human is needed, in the operator's own language. */
      reason: string;
      /** Best-guess groups for the admin to confirm or correct. May be empty. */
      prefill: ResolvedGroup[];
    };

export interface ResolveContext {
  /** Every side registered for the league — the pool `all-registered` draws on. */
  registered?: string[];
  /** Admin-confirmed groups, once they have been entered. */
  confirmed?: string[][];
  /** Seed order for `seeded-split` (e.g. last season's final log, strongest first). */
  seedOrder?: string[];
  /** Group labels from the stage spec, e.g. ["Top Six", "Bottom Six"]. */
  labels?: string[];
}

/** 0→'A', 1→'B', … — the fallback group label. */
function groupLetter(i: number): string {
  let n = Math.max(0, i | 0);
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function labelFor(labels: string[] | undefined, i: number): string {
  return labels?.[i]?.trim() || `Group ${groupLetter(i)}`;
}

function makeGroup(i: number, labels: string[] | undefined, entrants: string[]): ResolvedGroup {
  return { id: `g${i + 1}`, label: labelFor(labels, i), entrants };
}

/**
 * Concrete group sizes for `total` entrants.
 *
 * Explicit sizes win as given — that is the only way to say "three pools of five and one
 * of four", which is exactly the shape the Promotion Men T20 needs for 19 teams. An
 * `even` plan spreads the remainder across the earlier groups rather than dumping it in
 * the last, so 19 into 4 becomes 5+5+5+4, not 4+4+4+7.
 */
export function groupSizes(plan: GroupPlan | undefined, total: number): number[] {
  const n = Math.max(0, Math.floor(total) || 0);
  if (!plan) return [n];

  let sizes: number[];
  if (plan.kind === 'sizes') {
    sizes = (plan.sizes ?? []).filter((s) => Number.isFinite(s) && s > 0).map((s) => Math.floor(s));
    // An all-invalid list would otherwise yield [], and an empty size list makes
    // `intoSnake` index past the end of its accumulator. One group is the honest
    // fallback: nobody is dropped and the operator sees a group that's obviously wrong.
    if (sizes.length === 0) sizes = [n];
  } else {
    const count = Math.max(1, Math.floor(plan.count) || 1);
    const base = Math.floor(n / count);
    const remainder = n % count;
    sizes = Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
  }

  // The sizes MUST account for every entrant. Explicit sizes are operator-authored and
  // routinely go stale — a league configured [6, 6] gains a thirteenth club — and the two
  // distributions disagree about the leftover: `intoBlocks` quietly overfills the last
  // group while `intoSnake` DELETES the remainder, so a side simply never plays. Reconcile
  // on the last group so both distribute everyone and the miscount is visible as an
  // oversized group rather than a missing team.
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (sum !== n) sizes[sizes.length - 1] = Math.max(0, sizes[sizes.length - 1] + (n - sum));
  return sizes;
}

/** Split a list into consecutive blocks of the given sizes. Extras go to the last group. */
function intoBlocks(list: string[], sizes: number[]): string[][] {
  const out: string[][] = [];
  let i = 0;
  for (let g = 0; g < sizes.length; g++) {
    const take = g === sizes.length - 1 ? list.length - i : sizes[g];
    out.push(list.slice(i, i + Math.max(0, take)));
    i += Math.max(0, take);
  }
  return out;
}

/**
 * Snake ("serpentine") distribution: seeds 1..n dealt across groups left-to-right then
 * right-to-left, so no group collects a run of top seeds. The fair way to seed pools when
 * the split is meant to balance strength rather than separate a top tier from a bottom one.
 */
function intoSnake(list: string[], sizes: number[]): string[][] {
  const out: string[][] = sizes.map(() => []);
  let dir = 1;
  let g = 0;
  for (const item of list) {
    // Skip groups that are already full (uneven sizes) without breaking the snake.
    let guard = 0;
    while (out[g].length >= sizes[g] && guard++ <= sizes.length * 2) {
      g += dir;
      if (g >= sizes.length) {
        g = sizes.length - 1;
        dir = -1;
      } else if (g < 0) {
        g = 0;
        dir = 1;
      }
    }
    if (out[g].length >= sizes[g]) break; // every group full — remaining entrants drop
    out[g].push(item);
    g += dir;
    if (g >= sizes.length) {
      g = sizes.length - 1;
      dir = -1;
    } else if (g < 0) {
      g = 0;
      dir = 1;
    }
  }
  return out;
}

/**
 * Resolve a stage's entrants.
 *
 * `all-registered` and `seeded-split` resolve immediately when their inputs are present.
 * `manual` resolves only once an admin has confirmed groups; until then it comes back
 * `awaiting` with whatever prefill can honestly be offered — the previous stage's entrant
 * order, or the seed order — plus the DerivationNote's own sentence as the reason.
 */
export function resolveEntrants(spec: EntrantSpec, ctx: ResolveContext = {}): EntrantResolution {
  const labels = ctx.labels;

  // A CONFIRMED grouping wins for every resolver, not just `manual`.
  //
  // `all-registered` and `seeded-split` derive a grouping, but the admin can still edit
  // it — the season card offers "Edit entrants" on any ready stage, and the cross-pool
  // Position column is shown on exactly these. Reading `confirmed` only in the `manual`
  // branch made that button a silent no-op: the admin dropped a club to "Not playing",
  // the PATCH succeeded, the modal closed, and the derived grouping came straight back
  // with the club still in it. The confirmation is a human decision about this season;
  // the derivation is a default. The decision wins.
  const confirmed = ctx.confirmed;
  const hasConfirmed =
    Array.isArray(confirmed) && confirmed.length > 0 && confirmed.some((g) => g.length > 0);
  if (hasConfirmed) {
    return {
      status: 'resolved',
      groups: confirmed.map((entrants, i) => makeGroup(i, labels, entrants)),
    };
  }

  if (spec.kind === 'all-registered') {
    const registered = ctx.registered ?? [];
    if (registered.length < 2) {
      return {
        status: 'awaiting',
        reason: 'At least two registered sides are needed before fixtures can be generated.',
        prefill: registered.length ? [makeGroup(0, labels, registered)] : [],
      };
    }
    return { status: 'resolved', groups: [makeGroup(0, labels, registered)] };
  }

  if (spec.kind === 'seeded-split') {
    const seeds = ctx.seedOrder ?? ctx.registered ?? [];
    if (seeds.length < 2) {
      return {
        status: 'awaiting',
        reason: 'Set the seeding order before this stage can be split into groups.',
        prefill: [],
      };
    }
    const sizes = groupSizes(spec.groups, seeds.length);
    const split = spec.method === 'snake' ? intoSnake(seeds, sizes) : intoBlocks(seeds, sizes);
    return {
      status: 'resolved',
      groups: split.map((entrants, i) => makeGroup(i, labels, entrants)),
    };
  }

  // manual — the normal path for a standings-dependent stage, and for a brand-new client
  // that has no prior-season log to seed from. (A confirmed grouping was already handled
  // above, for every resolver.)
  const note = spec.derivedFrom;
  const pool = ctx.seedOrder ?? ctx.registered ?? [];
  const sizes = groupSizes(spec.groups, pool.length);
  const prefill = pool.length
    ? intoBlocks(pool, sizes).map((entrants, i) => makeGroup(i, labels, entrants))
    : [];
  return {
    status: 'awaiting',
    reason: note
      ? note.detail
      : 'Confirm which teams play in this stage before generating fixtures.',
    prefill,
  };
}

/**
 * A one-line explanation of where a stage's teams come from, for the stage list and the
 * confirmation screen. Reads as a sentence an operator would say out loud.
 */
export function describeEntrants(spec: EntrantSpec): string {
  switch (spec.kind) {
    case 'all-registered':
      return 'Every side registered for the league';
    case 'seeded-split': {
      const plan = spec.groups;
      const shape = plan.kind === 'sizes' ? plan.sizes.join(' + ') : `${plan.count} even groups`;
      return `Seeded into ${shape} (${spec.method === 'snake' ? 'snake' : 'top-down blocks'})`;
    }
    case 'manual':
      return spec.derivedFrom?.detail ?? 'Entered by an administrator';
    default:
      return 'Entered by an administrator';
  }
}
