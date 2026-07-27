/**
 * Venue allocation (ADR 0008, phase 2) — deciding where each fixture is played.
 *
 * Deliberately separate from fixture generation: allocation consumes finished fixtures
 * and assigns a ground, identically for every league structure. It does not shape
 * fixtures, so nothing here knows about round-robin rotation or stages.
 *
 * ── THE ALGORITHM, AND WHY IT ISN'T A SOLVER ──
 * Greedy, most-constrained-first, over an ordered scoring function, with a fallback
 * chain. Not constraint programming. At roughly 600 fixtures per tenant, CP buys
 * optimality nobody asked for and costs the one property that actually matters here:
 * every placement carries a reason string an operator can argue with. A club secretary
 * phones about one fixture, not about an objective value.
 *
 * ── THE LEDGER IS TENANT-WIDE ──
 * The single biggest correctness requirement. Premier Men 50 Over and Premier Men T20
 * compete for the same grounds on the same Saturday, and a side must not be booked twice
 * in one day across two competitions. So the ledger spans every series in the tenant,
 * not just the one being allocated.
 *
 * ── NOTHING IS SILENTLY WRONG ──
 * An over-constrained fixture comes back `unresolved` with a reason. A confidently wrong
 * ground is worse than an admitted gap.
 */

import { haversineKm } from '../data';
import { weekdayOf } from './calendar';
import { isSlotRef } from './formats';
import type { GeneratedFixture } from './fixtures';
import type { IsoDate, Venue, VenueStatus, Weekday } from '../types';

/** The three factors the source document names, in the order they're applied by default. */
export type AllocationFactor = 'home-preference' | 'distance' | 'availability';

export const DEFAULT_FACTOR_ORDER: AllocationFactor[] = [
  'home-preference',
  'distance',
  'availability',
];

/**
 * Below this share of venues carrying coordinates, distance ranking is switched off.
 *
 * There is no geocoder in the platform (`src/geocode.ts` only formats addresses and
 * bounds-checks South Africa) and `ground.secondaryVenue` has no coordinates at all, so
 * a half-pinned registry is the normal state. Ranking by distance over mostly-missing
 * coordinates doesn't degrade gracefully — it produces confident nonsense, because a
 * venue with no coordinates scores as zero kilometres away.
 */
export const MIN_GEO_COVERAGE = 0.6;

/** A ground booked on a date. Capacity is per venue per day (`Venue.surfaces`). */
export interface Booking {
  venueId: string;
  date: IsoDate;
}

export interface Ledger {
  /** Matches already booked at this venue on this date. */
  venueLoad: (venueId: string, date: IsoDate) => number;
  /** True when this side already has a match that day, in ANY competition. */
  teamBusy: (teamId: string, date: IsoDate) => boolean;
  /** Record a placement so subsequent fixtures in the same run see it. */
  add: (venueId: string | undefined, date: IsoDate, teamIds: string[]) => void;
}

/** The minimal series shape the ledger reads — avoids importing the whole Series type. */
export interface LedgerSeries {
  id: string;
  fixtures?: Array<{ date?: string; home?: string; away?: string; venueId?: string }>;
}

/**
 * Build the tenant-wide booking ledger.
 *
 * `excludeSeriesIds` drops the series being re-allocated, so re-running allocation over
 * a series doesn't see its own previous placements as conflicts and refuse to move
 * anything.
 */
export function buildLedger(
  allSeries: LedgerSeries[],
  opts: { excludeSeriesIds?: string[] } = {},
): Ledger {
  const exclude = new Set(opts.excludeSeriesIds ?? []);
  const venueCounts = new Map<string, number>();
  const teamDays = new Set<string>();
  const vKey = (v: string, d: string) => `${v}|${d}`;
  const tKey = (t: string, d: string) => `${t}|${d}`;

  for (const s of allSeries ?? []) {
    if (exclude.has(s.id)) continue;
    for (const f of s.fixtures ?? []) {
      if (!f?.date) continue;
      if (f.venueId)
        venueCounts.set(
          vKey(f.venueId, f.date),
          (venueCounts.get(vKey(f.venueId, f.date)) ?? 0) + 1,
        );
      // A knockout placeholder is NOT a side. `win:f1` is series-scoped — every bracket
      // numbers its fixtures from f1 — so two competitions' finals both contain `win:f1`
      // and `win:f2`. Booking those into the team ledger makes the second competition's
      // final collide with the first and come back "unresolved: one of these sides
      // already has a match that day", for two teams that don't exist yet.
      if (f.home && !isSlotRef(f.home)) teamDays.add(tKey(f.home, f.date));
      if (f.away && !isSlotRef(f.away)) teamDays.add(tKey(f.away, f.date));
    }
  }

  return {
    venueLoad: (venueId, date) => venueCounts.get(vKey(venueId, date)) ?? 0,
    teamBusy: (teamId, date) => !isSlotRef(teamId) && teamDays.has(tKey(teamId, date)),
    add: (venueId, date, teamIds) => {
      if (venueId)
        venueCounts.set(vKey(venueId, date), (venueCounts.get(vKey(venueId, date)) ?? 0) + 1);
      for (const t of teamIds) if (t && !isSlotRef(t)) teamDays.add(tKey(t, date));
    },
  };
}

/** Where a side plays and roughly where that is — supplied by the caller from participants. */
export interface TeamHome {
  venueId?: string;
  lat?: number;
  lon?: number;
}

export interface AllocateArgs {
  fixtures: GeneratedFixture[];
  venues: Venue[];
  /** Resolve a teamId to its home ground and coordinates. */
  teamHome: (teamId: string) => TeamHome | undefined;
  ledger: Ledger;
  /** Operator-ordered factors; first is weighted highest. */
  factorOrder?: AllocationFactor[];
}

export interface AllocatedFixture extends GeneratedFixture {
  venueId?: string;
  /**
   * Ground name and coordinates, DENORMALISED onto the fixture — the same defensive
   * snapshotting `series.participants` uses for team identity. Two reasons: the club
   * portal never fetches the venue registry (it is admin-only), and a published schedule
   * must keep reading correctly after a ground is deleted from the registry.
   */
  venueName?: string;
  venueLat?: number;
  venueLon?: number;
  venueStatus: VenueStatus;
  /** Why THIS ground. The thing an operator can argue with. */
  venueReason: string;
  venueLocked?: boolean;
  /**
   * A ground typed by hand in the fixture editor, by NAME rather than by registry id.
   * It predates the venue registry and is what the admin console actually writes, so
   * `isLocked` honours it — otherwise "hand-picked venues are kept" would be a promise
   * nothing in the app can satisfy.
   */
  venueOverride?: string;
}

/**
 * A fixture allocation must not move.
 *
 * `venueLocked` is the explicit flag; `venueOverride` is the one an admin can actually
 * set today (EditFixtureRow writes it). Without the second clause, re-allocating books a
 * different ground in the ledger, leaves the override showing a third name on screen,
 * and drives travel cost off the allocated ground — three answers to one question.
 */
export function isLocked(f: Pick<AllocatedFixture, 'venueLocked' | 'venueOverride'>): boolean {
  return !!f.venueLocked || !!f.venueOverride?.trim();
}

export interface AllocationReport {
  fixtures: AllocatedFixture[];
  unresolved: number;
  /** Share of venues carrying coordinates, 0–1. */
  geoCoverage: number;
  /** True when distance ranking was applied; false ⇒ coverage too low. */
  distanceUsed: boolean;
  warnings: string[];
}

/** True when the ground is closed on this date for a window or a weekday rule. */
export function venueUnavailableReason(venue: Venue, date: IsoDate): string | null {
  for (const w of venue.unavailable ?? []) {
    if (date >= w.start && date <= w.end) return w.reason || 'unavailable';
  }
  if ((venue.unavailableWeekdays ?? []).includes(weekdayOf(date) as Weekday))
    return 'not available on that day of the week';
  return null;
}

/** Share of venues with usable coordinates. 1 when there are no venues (nothing to rank). */
export function geoCoverage(venues: Venue[]): number {
  if (!venues.length) return 1;
  const pinned = venues.filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lon)).length;
  return pinned / venues.length;
}

interface Candidate {
  venue: Venue;
  isHome: boolean;
  isAwayHome: boolean;
  km: number | null;
}

/**
 * Allocate venues to a series' fixtures.
 *
 * Processing order is MOST-CONSTRAINED-FIRST: a fixture with two viable grounds is placed
 * before one with ten, because the flexible fixture can still find somewhere afterwards
 * and the tight one can't. Greedy in date order would strand exactly the fixtures that
 * had the least room.
 *
 * Locked fixtures keep their venue and are written into the ledger first, so a manual
 * override is never quietly displaced by a subsequent re-allocation — the classic way
 * hand-placed work gets lost.
 */
export function allocateVenues(args: AllocateArgs): AllocationReport {
  const { fixtures, venues, teamHome, ledger } = args;
  const order = args.factorOrder?.length ? args.factorOrder : DEFAULT_FACTOR_ORDER;
  const warnings: string[] = [];
  const coverage = geoCoverage(venues);
  const distanceUsed = coverage >= MIN_GEO_COVERAGE;
  if (!distanceUsed && venues.length > 0) {
    warnings.push(
      `Only ${Math.round(coverage * 100)}% of venues have a pinned location, so travel distance was ignored. Pin the rest to rank grounds by travel.`,
    );
  }

  // Weight by position: the first factor dominates, so reordering them genuinely changes
  // the outcome rather than nudging it.
  const weightOf = (f: AllocationFactor) => {
    const i = order.indexOf(f);
    return i === -1 ? 0 : Math.pow(10, order.length - i);
  };
  const byId = new Map(venues.map((v) => [v.id, v]));

  const out: AllocatedFixture[] = fixtures.map((f) => ({
    ...(f as AllocatedFixture),
    venueStatus: (f as AllocatedFixture).venueStatus ?? 'unresolved',
    venueReason: (f as AllocatedFixture).venueReason ?? '',
  }));

  // A hand-typed override names a ground rather than identifying one, so match it back
  // to the registry — otherwise the ledger can't know that ground is taken, and the
  // allocator would happily send another fixture to it the same day.
  //
  // The override WINS over `venueId`. The realistic sequence is allocate → hand-correct
  // one fixture → re-allocate, and the fixture editor writes `venueOverride` without
  // touching the allocated `venueId`, so falling back to `venueId` first would book the
  // superseded ground and leave the one the admin actually chose looking free.
  const byName = new Map(venues.map((v) => [v.name.trim().toLowerCase(), v]));
  const overrideVenue = (f: AllocatedFixture): Venue | undefined =>
    byName.get((f.venueOverride ?? '').trim().toLowerCase());

  // Locked placements claim their slots before anything else competes for them.
  for (const f of out) {
    if (!isLocked(f)) continue;
    const chosen = overrideVenue(f);
    const unmatchedOverride = !chosen && !!f.venueOverride?.trim();
    if (chosen) {
      // Bring the denormalised fields into line with the override, so travel cost, the
      // fairness reports and the club portal all describe the ground being played on
      // rather than the one allocation last picked.
      f.venueId = chosen.id;
      f.venueName = chosen.name;
      f.venueLat = Number.isFinite(chosen.lat) ? chosen.lat : undefined;
      f.venueLon = Number.isFinite(chosen.lon) ? chosen.lon : undefined;
      // Same three-way reading as the allocated path — an override that happens to name
      // the home ground is still a home fixture, and the H/A balance report counts it.
      const homeGround = teamHome(f.home)?.venueId;
      const awayGround = teamHome(f.away)?.venueId;
      f.venueStatus =
        chosen.id === homeGround ? 'home' : chosen.id === awayGround ? 'alternative' : 'neutral';
      f.venueReason = 'Set by hand';
    } else if (f.venueOverride?.trim()) {
      // An off-site ground the registry has never heard of — the fixture editor's "Other"
      // box takes free text, and a miss is the normal case. Clear the SUPERSEDED
      // allocation rather than leaving it: otherwise the row shows the typed name while
      // travel cost is computed against the ground allocation last picked, and the ledger
      // books that ground too. Cost then falls back to the home-ground measure, which is
      // at least self-consistent.
      f.venueId = undefined;
      f.venueName = undefined;
      f.venueLat = undefined;
      f.venueLon = undefined;
      f.venueStatus = 'neutral';
      f.venueReason = 'Set by hand — not in the venue registry';
    }
    // A team is booked that day whether or not its ground could be resolved: the match
    // is happening somewhere, so the side is unavailable for a second one. An UNMATCHED
    // override books no ground — the fixture is off-site, and holding a registry slot it
    // isn't using would strand another fixture for nothing.
    ledger.add(unmatchedOverride ? undefined : (chosen?.id ?? f.venueId), f.date, [f.home, f.away]);
  }

  const candidatesFor = (f: AllocatedFixture): Candidate[] => {
    const home = teamHome(f.home);
    const away = teamHome(f.away);
    const usable = venues.filter((v) => !venueUnavailableReason(v, f.date));
    return usable.map((v) => {
      const pinned = Number.isFinite(v.lat) && Number.isFinite(v.lon);
      const legs =
        distanceUsed && pinned
          ? [home, away]
              .filter((t) => t && Number.isFinite(t.lat) && Number.isFinite(t.lon))
              .map((t) => haversineKm({ lat: t!.lat, lon: t!.lon }, { lat: v.lat, lon: v.lon }))
          : [];
      return {
        venue: v,
        isHome: !!home?.venueId && home.venueId === v.id,
        isAwayHome: !!away?.venueId && away.venueId === v.id,
        // Combined travel for BOTH sides — the document's wording, and it stops a
        // "neutral" ground being chosen that happens to sit on one club's doorstep.
        km: legs.length ? legs.reduce((a, b) => a + b, 0) : null,
      };
    });
  };

  const isFree = (c: Candidate, f: AllocatedFixture) =>
    ledger.venueLoad(c.venue.id, f.date) < Math.max(1, c.venue.surfaces ?? 1);

  // Most-constrained-first: fewest currently-free candidates goes first. Locked fixtures
  // are already placed and drop out.
  const pending = out.filter((f) => !isLocked(f));
  // Counted ONCE per fixture rather than inside the comparator: the ledger doesn't change
  // during the sort (locked placements were added above), so the counts are constant, and
  // recomputing them per comparison costs an O(n log n × venues) pile of haversines.
  const freeCount = new Map<AllocatedFixture, number>();
  for (const f of pending) freeCount.set(f, candidatesFor(f).filter((c) => isFree(c, f)).length);
  const ranked = [...pending].sort((a, b) => {
    const na = freeCount.get(a)!;
    const nb = freeCount.get(b)!;
    if (na !== nb) return na - nb;
    return a.date.localeCompare(b.date);
  });

  let unresolved = 0;
  for (const f of ranked) {
    // A side already committed that day — in ANY competition — can't play here.
    const clash = [f.home, f.away].find((t) => ledger.teamBusy(t, f.date));
    if (clash) {
      f.venueId = undefined;
      f.venueName = undefined;
      f.venueLat = undefined;
      f.venueLon = undefined;
      f.venueStatus = 'unresolved';
      f.venueReason = 'One of these sides already has a match that day';
      unresolved++;
      continue;
    }

    const free = candidatesFor(f).filter((c) => isFree(c, f));
    if (free.length === 0) {
      const anyCandidate = candidatesFor(f).length > 0;
      f.venueId = undefined;
      f.venueName = undefined;
      f.venueLat = undefined;
      f.venueLon = undefined;
      f.venueStatus = 'unresolved';
      f.venueReason = venues.length
        ? anyCandidate
          ? 'Every available ground is already booked that day'
          : 'No ground is available on that date'
        : 'No venues have been added yet';
      unresolved++;
      continue;
    }

    const score = (c: Candidate) => {
      let s = 0;
      if (c.isHome) s += weightOf('home-preference') * 2;
      else if (c.isAwayHome) s += weightOf('home-preference');
      // Nearer is better, so distance contributes negatively and is normalised into a
      // bounded range — otherwise one far-flung ground could swamp the ordering.
      //
      // An UNPINNED venue (km === null) takes the MAXIMUM penalty rather than being
      // exempt. Exempting it is the pathology this module's header describes: a ground
      // with no coordinates would score as though it were zero kilometres away and
      // systematically beat a pinned ground a kilometre down the road. The coverage gate
      // only switches distance off entirely below the threshold; between there and 100%
      // the unpinned minority still has to be ranked, and "unknown" must rank worst.
      if (distanceUsed) s -= weightOf('distance') * (c.km !== null ? Math.min(c.km / 200, 1) : 1);
      // Prefer a quieter ground, all else equal.
      s -= weightOf('availability') * ledger.venueLoad(c.venue.id, f.date);
      return s;
    };

    const best = free.reduce((a, b) => (score(b) > score(a) ? b : a));
    const homeGround = teamHome(f.home)?.venueId;
    const status: VenueStatus = best.isHome ? 'home' : best.isAwayHome ? 'alternative' : 'neutral';

    // The reason has to say what an operator would want to know: why not the home ground?
    let reason: string;
    if (best.isHome) {
      reason = 'Home ground';
    } else if (!homeGround) {
      reason = `${byId.get(best.venue.id)?.name ?? 'Ground'} — the home side has no ground on record`;
    } else {
      const hg = byId.get(homeGround);
      const why = hg
        ? (venueUnavailableReason(hg, f.date) ?? 'already booked that day')
        : 'not in the venue list';
      reason = best.isAwayHome
        ? `Home ground ${why} — moved to the away side's ground`
        : `Home ground ${why} — moved to a neutral ground${best.km !== null ? ` (${Math.round(best.km)} km combined travel)` : ''}`;
    }

    f.venueId = best.venue.id;
    f.venueName = best.venue.name;
    f.venueLat = Number.isFinite(best.venue.lat) ? best.venue.lat : undefined;
    f.venueLon = Number.isFinite(best.venue.lon) ? best.venue.lon : undefined;
    f.venueStatus = status;
    f.venueReason = reason;
    ledger.add(best.venue.id, f.date, [f.home, f.away]);
  }

  if (unresolved > 0) {
    warnings.push(
      `${unresolved} fixture${unresolved === 1 ? '' : 's'} could not be placed — see the reason on each row.`,
    );
  }

  return { fixtures: out, unresolved, geoCoverage: coverage, distanceUsed, warnings };
}

/* ─── Reports ─── */

export interface HomeAwayRow {
  teamId: string;
  home: number;
  away: number;
  neutral: number;
}

/**
 * Home/away balance per side.
 *
 * Our round-robin alternates home and away by round, which is fair-ish but not balanced —
 * and venue allocation then overrides some of it anyway. ADR 0008 chose to report the
 * imbalance rather than promise an optimiser, so an operator can see 6H/4A and fix it by
 * hand. Counted from where the match is ACTUALLY played, not from the home/away column.
 */
export function homeAwayBalance(
  fixtures: AllocatedFixture[],
  teamHome: (t: string) => TeamHome | undefined,
): HomeAwayRow[] {
  const rows = new Map<string, HomeAwayRow>();
  const row = (t: string) => {
    if (!rows.has(t)) rows.set(t, { teamId: t, home: 0, away: 0, neutral: 0 });
    return rows.get(t)!;
  };
  for (const f of fixtures) {
    for (const t of [f.home, f.away]) {
      // A knockout placeholder isn't a side — it would otherwise get its own row,
      // reported to an operator as a club with a lopsided home/away split.
      if (!t || isSlotRef(t)) continue;
      const ground = teamHome(t)?.venueId;
      const r = row(t);
      if (f.venueId && ground && f.venueId === ground) r.home++;
      else if (f.venueId) r.away++;
      else r.neutral++;
    }
  }
  return [...rows.values()];
}

export interface TravelRow {
  teamId: string;
  km: number;
  trips: number;
}

/**
 * Kilometres each side travels across a fixture list — one-way to the ground, summed.
 *
 * Minimising TOTAL travel can systematically dump the burden on one club, so the fairness
 * question is per-club, not aggregate. Sides or venues without pinned coordinates
 * contribute zero, which is why the geo-coverage figure is reported alongside.
 */
export function travelPerTeam(
  fixtures: AllocatedFixture[],
  venues: Venue[],
  teamHome: (t: string) => TeamHome | undefined,
): TravelRow[] {
  const byId = new Map(venues.map((v) => [v.id, v]));
  const rows = new Map<string, TravelRow>();
  const row = (t: string) => {
    if (!rows.has(t)) rows.set(t, { teamId: t, km: 0, trips: 0 });
    return rows.get(t)!;
  };
  for (const f of fixtures) {
    const venue = f.venueId ? byId.get(f.venueId) : undefined;
    if (!venue || !Number.isFinite(venue.lat) || !Number.isFinite(venue.lon)) continue;
    for (const t of [f.home, f.away]) {
      if (!t || isSlotRef(t)) continue; // a placeholder has no ground to travel from
      const home = teamHome(t);
      if (!home || !Number.isFinite(home.lat) || !Number.isFinite(home.lon)) continue;
      const km = haversineKm({ lat: home.lat, lon: home.lon }, { lat: venue.lat, lon: venue.lon });
      const r = row(t);
      r.km += km;
      if (km > 0) r.trips++;
    }
  }
  return [...rows.values()];
}
