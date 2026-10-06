/**
 * Apply a reviewed list of per-fixture patches (time / home side / venue) from a JSON
 * manifest, then move any DRAFT fixture that would share a ground with a released fixture on
 * the manifest's dates — DRY-RUN by default:
 *
 *   npx sst shell --stage prod -- npm --prefix packages/api run patch-fixtures -- \
 *     --tenant dolphins --manifest fixture-patches/dolphins-2026-10-10.json      # dry run
 *   … append --confirm to write
 *
 *   # offline dry run against a local export (raw DynamoDB Query output or decoded arrays):
 *   npx tsx src/patch-fixtures.ts --tenant dolphins --manifest fixture-patches/… \
 *     --series-json prod-SERIES.json --clubs-json prod-CLUB.json --venues-json prod-VENUE.json
 *
 * Why this exists: the union's weekly reminder sheet is the authority for a weekend's
 * fixtures, and the admin fixture editor moves one fixture at a time behind the in-season
 * clash gate — a slot swap (two fixtures trading 09:00/13:30) or a venue move onto a ground
 * an unreleased draft implicitly holds is refused there. This CLI applies the whole set at
 * once and re-runs the gate over the whole modified tenant.
 *
 * Every manifest entry carries an `expect` compare-and-set guard (home, away, date, time,
 * effective venue = venueOverride || venueName). Any mismatch with the live data aborts the
 * whole run. Released fixtures are only ever changed by a manifest entry; draft movers get the
 * first ground of the importer's candidate chain (`buildCandidateGrounds`) that is free ALL
 * DAY on that date. No free candidate ⇒ hard error, nothing written. There is no
 * allow-clashes bypass, by design.
 *
 * Gate (the pattern of shift-fixture-dates): `findClashes` / `clashKey` over every tenant
 * series before vs after — refuse if any clash key is introduced, or if any clash on the
 * manifest dates involves a released fixture. Pre-existing draft-vs-draft clashes are
 * reported only.
 *
 * --confirm: backs up the touched series (as read) to
 * packages/api/patch-fixtures-backup-<tenant>-<ts>.json, then writes each through
 * `writeSeriesFromSnapshot` (version-checked, medicoach schedule diff). A series where a
 * fixture's home/away side changes is written in TWO passes: `recordScheduleDiff` skips a
 * fixture whose pairing changed in the same write, so pass 1 writes only the side changes,
 * the series is re-read and verified, and pass 2 writes every remaining change on top —
 * otherwise medicoach never learns that fixture's new time/venue.
 */
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import {
  findClashes,
  clashKey,
  formatClashForHumans,
  groundKey,
  registryResolver,
  GroundLedger,
  JUNK_GROUND,
  DEFAULT_VENUE_ALIASES,
  venueAliasesFor,
  isClashExempt,
  type Clash,
} from './venue-clash.js';
import {
  buildCandidateGrounds,
  buildPermittedByClub,
  buildVenueIndex,
  type CandidateGround,
} from './resolve-venue-clashes.js';
import type { Club, Series, Venue } from './types.js';

// `./repo.js` (and its AWS SDK deps) and the medicoach writer are imported dynamically inside
// `main()` so the pure core (planFixturePatches) and its unit test load without TABLE_NAME.

// ─────────────────────────────── manifest ───────────────────────────────

export interface PatchExpect {
  home: string;
  away: string;
  date: string;
  time: string;
  /** Effective venue: venueOverride.trim() || venueName — compared trimmed, case-insensitive. */
  venue: string;
}

export interface PatchSet {
  /** New home side ref (a participants teamId, or a clubId on a legacy series). */
  home?: string;
  /** New kick-off, HH:MM. */
  time?: string;
  /** Registry venue id to bind the fixture to. */
  venueId?: string;
  /** Mark the date a placeholder (the fixture leaves every clash ledger; date is kept).
   * Only `true`, and only on a DRAFT series (released !== true). */
  dateTbc?: true;
}

export interface PatchEntry {
  seriesId: string;
  fixtureId: string;
  expect: PatchExpect;
  set: PatchSet;
}

export interface PatchManifest {
  tenant?: string;
  /** venueReason written on a section-A venue bind. */
  venueReason?: string;
  entries: PatchEntry[];
  relocateDraftClashes?: {
    dates: string[];
    /** Completes the mover's venueReason: "Moved: <ground> taken by <takenBy>". */
    takenBy?: string;
  };
}

// ─────────────────────────────── plan shape ───────────────────────────────

/** A stored fixture — only the fields this tool reads or writes are typed. */
interface StoredFixture {
  id?: string;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  status?: string;
  dateTbc?: boolean;
  venueId?: string;
  venueName?: string;
  venueOverride?: string;
  venueStatus?: string;
  venueReason?: string;
  venueLat?: number;
  venueLon?: number;
  venueLocked?: boolean;
  [key: string]: unknown;
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface FixtureDiff {
  seriesId: string;
  fixtureId: string;
  kind: 'patch' | 'move';
  changes: FieldChange[];
}

export interface DraftMove {
  seriesId: string;
  fixtureId: string;
  date: string;
  home?: string;
  away?: string;
  /** The ground it was on (explicit or the home club's implicit ground). */
  from: string;
  to: string;
  label: string;
  /** The released fixtures it shared `from` with. */
  blockedBy: string[];
  /** Candidates skipped because already taken that day: "<ground> [label] ← <series/fixture>". */
  tried: string[];
  /** The destination is not a registry ground (written as a free-text override). */
  registryMiss: boolean;
}

export interface PatchGate {
  /** Unique clashes in the would-be tenant, by clashKey. */
  totalAfter: number;
  introduced: Clash[];
  /** Clashes on the manifest dates where either side is a released fixture. */
  weekendReleased: Clash[];
  /** Clashes on the manifest dates between two drafts — reported, not fatal. */
  weekendDraftOnly: Clash[];
}

export interface PatchPlan {
  /** Every tenant series, with modified copies in place of the touched ones. */
  next: Series[];
  touchedSeriesIds: string[];
  diffs: FixtureDiff[];
  moves: DraftMove[];
  gate?: PatchGate;
  /** Non-empty ⇒ nothing may be written. */
  errors: string[];
}

// ─────────────────────────────── helpers ───────────────────────────────

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const effectiveVenueText = (f: StoredFixture): string =>
  (f.venueOverride ?? '').trim() || (f.venueName ?? '').trim();

/** What the clash ledgers book for a fixture (mirrors venue-clash.ts effectiveGround). */
function effectiveGround(
  s: Series,
  f: StoredFixture,
  clubsById: Map<string, Club>,
): string | undefined {
  const explicit = f.venueOverride || f.venueName;
  if (explicit) return explicit;
  const homeClubId = sideClubId(s, f.home);
  const own = homeClubId ? clubsById.get(homeClubId)?.ground?.venue?.trim() : undefined;
  return own && !JUNK_GROUND.test(own) ? own : undefined;
}

/** A side ref → its club id: the participants snapshot, else (legacy) the ref IS the club. */
function sideClubId(s: Series, ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return s.participants ? s.participants.find((p) => p.teamId === ref)?.clubId : ref;
}

/** JSON with sorted keys and undefined dropped — the equality a DynamoDB round-trip keeps. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val as Record<string, unknown>)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]]),
        )
      : val,
  );
}

function diffFixture(before: StoredFixture, after: StoredFixture): FieldChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const out: FieldChange[] = [];
  for (const k of keys) {
    if (canonicalJson(before[k]) !== canonicalJson(after[k]))
      out.push({ field: k, before: before[k], after: after[k] });
  }
  return out;
}

/** Bind a fixture to a registry ground (mirrors setVenue in resolve-venue-clashes.ts). */
function bindVenue(f: StoredFixture, venue: Venue, status: string, reason: string) {
  f.venueStatus = status;
  f.venueReason = reason;
  f.venueId = venue.id;
  f.venueName = venue.name;
  f.venueLat = Number.isFinite(venue.lat) ? venue.lat : undefined;
  f.venueLon = Number.isFinite(venue.lon) ? venue.lon : undefined;
  f.venueOverride = undefined;
  f.venueLocked = true;
}

/** setVenue's registry-miss branch: a free-text override with an equal venueName, no lock. */
function setFreeTextVenue(f: StoredFixture, ground: string, status: string, reason: string) {
  f.venueStatus = status;
  f.venueReason = reason;
  f.venueId = undefined;
  f.venueLat = undefined;
  f.venueLon = undefined;
  f.venueLocked = undefined;
  f.venueOverride = ground;
  f.venueName = ground;
}

interface Booking {
  seriesId: string;
  fixtureId: string;
  released: boolean;
  ground: string;
  date: string;
  time?: string;
  s: Series;
  f: StoredFixture;
}

function buildBookings(all: Series[], clubsById: Map<string, Club>): Booking[] {
  const out: Booking[] = [];
  for (const s of all) {
    for (const f of (s.fixtures as StoredFixture[]) ?? []) {
      if (!f.date || isClashExempt(f)) continue;
      const ground = effectiveGround(s, f, clubsById);
      if (!ground) continue;
      out.push({
        seriesId: String(s.id),
        fixtureId: f.id ?? '',
        released: s.released === true,
        ground,
        date: f.date,
        time: f.time,
        s,
        f,
      });
    }
  }
  return out;
}

/** Two bookings contest the same slot: same ledger ground + date, and either is untimed or
 * the times match (GroundLedger semantics). */
function overlaps(
  a: Booking,
  b: Booking,
  resolve: (g: string) => { key: string; capacity: number },
): boolean {
  if (a.date !== b.date) return false;
  if (resolve(a.ground).key !== resolve(b.ground).key) return false;
  return !a.time || !b.time || a.time === b.time;
}

/**
 * Draft fixtures on `dates` whose slot is over capacity with a released fixture in it.
 * Direct pairwise check (not via findClashes, whose `with` names only the FIRST booking a
 * slot holds and so can hide a released partner behind another draft).
 */
function draftReleasedConflicts(
  bookings: Booking[],
  dates: Set<string>,
  resolve: (g: string) => { key: string; capacity: number },
): Array<{ draft: Booking; released: Booking[] }> {
  const out: Array<{ draft: Booking; released: Booking[] }> = [];
  for (const d of bookings) {
    if (d.released || !dates.has(d.date)) continue;
    const others = bookings.filter((o) => o !== d && overlaps(d, o, resolve));
    if (others.length < resolve(d.ground).capacity) continue;
    const rel = others.filter((o) => o.released);
    if (rel.length) out.push({ draft: d, released: rel });
  }
  return out.sort(
    (a, b) =>
      a.draft.date.localeCompare(b.draft.date) ||
      a.draft.seriesId.localeCompare(b.draft.seriesId) ||
      a.draft.fixtureId.localeCompare(b.draft.fixtureId, undefined, { numeric: true }),
  );
}

/** Every season-wide clash once (by clashKey), with the series it was found as subject of. */
function uniqueClashes(
  all: Series[],
  clubs: Club[],
  venues: Venue[],
  aliases: Record<string, string>,
): Array<{ clash: Clash; subjectSeriesId: string }> {
  const seen = new Set<string>();
  const out: Array<{ clash: Clash; subjectSeriesId: string }> = [];
  for (const s of all)
    for (const c of findClashes(s, all, clubs, venues, aliases)) {
      const k = clashKey(c, aliases);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ clash: c, subjectSeriesId: String(s.id) });
    }
  return out;
}

// ─────────────────────────────── pure core ───────────────────────────────

/**
 * Plan the manifest against the tenant's series. Pure: inputs are never mutated. Section A
 * applies each entry (after its guard passes); section B relocates draft movers; the gate
 * runs over the whole would-be tenant. Any problem lands in `errors`.
 */
export function planFixturePatches(
  series: Series[],
  clubs: Club[],
  venues: Venue[],
  manifest: PatchManifest,
  aliases: Record<string, string> = DEFAULT_VENUE_ALIASES,
): PatchPlan {
  const errors: string[] = [];
  const clubsById = new Map(clubs.map((c) => [c.id, c]));
  const venuesById = new Map(venues.map((v) => [v.id, v]));
  const originalById = new Map(series.map((s) => [String(s.id), s]));
  const working = new Map<string, Series>();
  const getWorking = (id: string): Series => {
    let w = working.get(id);
    if (!w) working.set(id, (w = structuredClone(originalById.get(id)!)));
    return w;
  };
  const findFixture = (s: Series, fixtureId: string): StoredFixture | undefined =>
    ((s.fixtures as StoredFixture[]) ?? []).find((f) => f.id === fixtureId);
  const venueReason = manifest.venueReason ?? 'Fixture patch';
  const touchedFixtures = new Map<string, 'patch' | 'move'>();

  // ── Section A: guarded patches. ──
  const entries = manifest.entries ?? [];
  const seenEntries = new Set<string>();
  for (const e of entries) {
    const ref = `${e.seriesId}/${e.fixtureId}`;
    if (seenEntries.has(ref)) {
      errors.push(`${ref}: listed more than once in the manifest`);
      continue;
    }
    seenEntries.add(ref);
    const orig = originalById.get(e.seriesId);
    if (!orig) {
      errors.push(`${ref}: series not found`);
      continue;
    }
    const of = findFixture(orig, e.fixtureId);
    if (!of) {
      errors.push(`${ref}: fixture not found`);
      continue;
    }
    // Guard.
    const x = e.expect;
    if (!x) {
      errors.push(`${ref}: entry has no expect guard`);
      continue;
    }
    const mism: string[] = [];
    if ((of.home ?? '') !== x.home) mism.push(`home "${of.home ?? ''}" ≠ expected "${x.home}"`);
    if ((of.away ?? '') !== x.away) mism.push(`away "${of.away ?? ''}" ≠ expected "${x.away}"`);
    if ((of.date ?? '') !== x.date) mism.push(`date "${of.date ?? ''}" ≠ expected "${x.date}"`);
    if ((of.time ?? '') !== x.time) mism.push(`time "${of.time ?? ''}" ≠ expected "${x.time}"`);
    if (effectiveVenueText(of).toLowerCase() !== (x.venue ?? '').trim().toLowerCase())
      mism.push(`venue "${effectiveVenueText(of)}" ≠ expected "${x.venue}"`);
    if (mism.length) {
      errors.push(`${ref}: guard mismatch — ${mism.join('; ')}`);
      continue;
    }
    const set = e.set ?? {};
    const unknownKeys = Object.keys(set).filter(
      (k) => !['home', 'time', 'venueId', 'dateTbc'].includes(k),
    );
    if (unknownKeys.length) {
      errors.push(`${ref}: unsupported set field(s) ${unknownKeys.join(', ')}`);
      continue;
    }
    if (
      set.home === undefined &&
      set.time === undefined &&
      set.venueId === undefined &&
      set.dateTbc === undefined
    ) {
      errors.push(`${ref}: entry sets nothing`);
      continue;
    }
    if (set.dateTbc !== undefined) {
      if (set.dateTbc !== true) {
        errors.push(`${ref}: set.dateTbc must be true`);
        continue;
      }
      if (orig.released === true) {
        errors.push(
          `${ref}: set.dateTbc is only allowed on a draft series — ${e.seriesId} is released`,
        );
        continue;
      }
    }
    if (set.time !== undefined && !TIME_RE.test(set.time)) {
      errors.push(`${ref}: set.time "${set.time}" is not HH:MM`);
      continue;
    }
    if (set.home !== undefined) {
      const known = orig.participants
        ? orig.participants.some((p) => p.teamId === set.home)
        : clubsById.has(set.home);
      if (!known) {
        errors.push(`${ref}: set.home "${set.home}" is not a side of this series`);
        continue;
      }
      if (set.home === of.away) {
        errors.push(`${ref}: set.home "${set.home}" is the away side`);
        continue;
      }
    }
    const venue = set.venueId !== undefined ? venuesById.get(set.venueId) : undefined;
    if (set.venueId !== undefined && !venue) {
      errors.push(`${ref}: venueId "${set.venueId}" not in the registry`);
      continue;
    }
    const s = getWorking(e.seriesId);
    const f = findFixture(s, e.fixtureId)!;
    if (set.home !== undefined) f.home = set.home;
    if (set.time !== undefined) f.time = set.time;
    // A TBC date is clash-exempt (isClashExempt), so mover detection and the gate below
    // no longer see this fixture. Its date value is left as it was.
    if (set.dateTbc === true) f.dateTbc = true;
    if (venue) {
      const homeClubId = sideClubId(s, f.home);
      const status =
        homeClubId && (venue.homeClubIds ?? []).includes(homeClubId) ? 'home' : 'neutral';
      bindVenue(f, venue, status, venueReason);
    }
    touchedFixtures.set(ref, 'patch');
  }

  const assemble = (): Series[] => series.map((s) => working.get(String(s.id)) ?? s);
  const finish = (moves: DraftMove[], gate?: PatchGate): PatchPlan => {
    const next = assemble();
    const diffs: FixtureDiff[] = [];
    for (const [ref, kind] of touchedFixtures) {
      const [seriesId, fixtureId] = [
        ref.slice(0, ref.lastIndexOf('/')),
        ref.slice(ref.lastIndexOf('/') + 1),
      ];
      const before = findFixture(originalById.get(seriesId)!, fixtureId)!;
      const after = findFixture(working.get(seriesId)!, fixtureId)!;
      const changes = diffFixture(before, after);
      if (changes.length) diffs.push({ seriesId, fixtureId, kind, changes });
    }
    const touchedSeriesIds = [...new Set(diffs.map((d) => d.seriesId))];
    return { next, touchedSeriesIds, diffs, moves, gate, errors };
  };

  if (errors.length) return finish([]);

  // ── Section B: relocate draft fixtures that share a slot with a released fixture. ──
  const moves: DraftMove[] = [];
  const dates = new Set(manifest.relocateDraftClashes?.dates ?? []);
  const resolve = registryResolver(venues, aliases);
  if (dates.size) {
    const takenBy = manifest.relocateDraftClashes?.takenBy ?? 'a released fixture';
    const byNorm = buildVenueIndex(venues, aliases);
    const permittedByClub = buildPermittedByClub(byNorm);
    const moved = new Set<string>();
    // Each pass relocates every detected mover, then re-scans: moving one draft can reveal
    // another (or a fresh conflict on its new ground — which the all-day check prevents).
    for (let pass = 0; pass < 50; pass++) {
      const conflicts = draftReleasedConflicts(
        buildBookings(assemble(), clubsById),
        dates,
        resolve,
      );
      if (!conflicts.length) break;
      let progressed = false;
      for (const { draft, released } of conflicts) {
        const ref = `${draft.seriesId}/${draft.fixtureId}`;
        if (moved.has(ref)) {
          errors.push(
            `${ref} conflicts with a released fixture again after being moved — cannot resolve`,
          );
          break;
        }
        // Fresh ledger each mover: every current booking except the mover itself, so grounds
        // taken by earlier movers this run are already booked.
        const bookings = buildBookings(assemble(), clubsById);
        const ledger = new GroundLedger(resolve);
        for (const b of bookings) {
          if (b.seriesId === draft.seriesId && b.fixtureId === draft.fixtureId) continue;
          ledger.book(b.ground, b.date, b.time, {
            seriesId: b.seriesId,
            fixtureId: b.fixtureId,
            date: b.date,
            time: b.time,
          });
        }
        const s = getWorking(draft.seriesId);
        const f = findFixture(s, draft.fixtureId)!;
        const contested = draft.ground;
        const candidates: CandidateGround[] = buildCandidateGrounds({
          homeClubId: sideClubId(s, f.home),
          awayClubId: sideClubId(s, f.away),
          contested,
          clubsById,
          byNorm,
          permittedByClub,
          aliases,
        });
        const tried: string[] = [];
        let target: CandidateGround | undefined;
        for (const c of candidates) {
          // The draft is untimed (or treated as such): it needs the ground ALL day.
          const hit = ledger.check(c.ground, draft.date, undefined);
          if (!hit) {
            target = c;
            break;
          }
          tried.push(`${c.ground} [${c.label}] ← ${hit.seriesId}/${hit.fixtureId}`);
        }
        const blockedBy = released.map((r) => `${r.seriesId}/${r.fixtureId}`);
        if (!target) {
          errors.push(
            `no free all-day ground for draft ${ref} on ${draft.date} (on ${contested}, blocked by ${blockedBy.join(', ')}); ` +
              `candidates tried: ${tried.length ? tried.join('; ') : '(none available)'}`,
          );
          continue;
        }
        const reason = `Moved: ${contested} taken by ${takenBy}`;
        const row = byNorm.get(groundKey(target.ground, aliases));
        if (row) bindVenue(f, row, 'alternative', reason);
        else setFreeTextVenue(f, target.ground, 'alternative', reason);
        moved.add(ref);
        touchedFixtures.set(ref, 'move');
        moves.push({
          seriesId: draft.seriesId,
          fixtureId: draft.fixtureId,
          date: draft.date,
          home: f.home,
          away: f.away,
          from: contested,
          to: row ? row.name : target.ground,
          label: target.label,
          blockedBy,
          tried,
          registryMiss: !row,
        });
        progressed = true;
      }
      // A mover with no free ground is fatal; stop relocating but still run the gate below so
      // the dry run shows every clash the unresolved movers leave.
      if (errors.length) break;
      if (!progressed) break;
    }
  }

  // Released fixtures change only through a manifest entry.
  for (const [ref, kind] of touchedFixtures) {
    const seriesId = ref.slice(0, ref.lastIndexOf('/'));
    if (kind === 'move' && originalById.get(seriesId)?.released === true)
      errors.push(`${ref}: a released fixture was relocated — refusing`);
  }

  // ── Gate over the whole would-be tenant. ──
  const next = assemble();
  const before = new Set(
    uniqueClashes(series, clubs, venues, aliases).map((u) => clashKey(u.clash, aliases)),
  );
  const after = uniqueClashes(next, clubs, venues, aliases);
  const releasedIds = new Set(next.filter((s) => s.released === true).map((s) => String(s.id)));
  const introduced = after
    .filter((u) => !before.has(clashKey(u.clash, aliases)))
    .map((u) => u.clash);
  const gateDates = dates.size ? dates : new Set(entries.map((e) => e.expect?.date));
  const onDates = after.filter((u) => gateDates.has(u.clash.date));
  const involvesReleased = (u: { clash: Clash; subjectSeriesId: string }) =>
    releasedIds.has(u.subjectSeriesId) || releasedIds.has(u.clash.with.seriesId);
  const weekendReleased = onDates.filter(involvesReleased).map((u) => u.clash);
  const weekendDraftOnly = onDates.filter((u) => !involvesReleased(u)).map((u) => u.clash);
  if (introduced.length)
    errors.push(`gate: the change would introduce ${introduced.length} new venue clash(es)`);
  if (weekendReleased.length)
    errors.push(
      `gate: ${weekendReleased.length} clash(es) on the manifest dates involve a released fixture`,
    );
  // Belt and braces: findClashes names only the first booking of a slot, so re-check directly.
  if (dates.size) {
    const residual = draftReleasedConflicts(buildBookings(next, clubsById), dates, resolve);
    for (const r of residual)
      errors.push(
        `gate: draft ${r.draft.seriesId}/${r.draft.fixtureId} still shares ${r.draft.ground} with ${r.released
          .map((x) => `${x.seriesId}/${x.fixtureId}`)
          .join(', ')}`,
      );
  }
  return finish(moves, {
    totalAfter: after.length,
    introduced,
    weekendReleased,
    weekendDraftOnly,
  });
}

// ─────────────────────────────── two-pass write helpers ───────────────────────────────

/** `original` with ONLY the home/away side changes `planned` makes, or undefined when no
 * fixture's pairing changes (a single write is then safe). */
export function teamOnlySnapshot(original: Series, planned: Series): Series | undefined {
  const plannedById = new Map(
    ((planned.fixtures as StoredFixture[]) ?? []).map((f) => [f.id, f] as const),
  );
  let changed = false;
  const snap = structuredClone(original);
  snap.fixtures = ((snap.fixtures as StoredFixture[]) ?? []).map((f) => {
    const p = plannedById.get(f.id);
    if (!p || (p.home === f.home && p.away === f.away)) return f;
    changed = true;
    return { ...f, home: p.home, away: p.away };
  }) as Series['fixtures'];
  return changed ? snap : undefined;
}

/** Every field change `planned` makes relative to `original`, applied fixture-by-fixture
 * on top of `base` (the series as re-read after pass 1). Fields `planned` leaves alone keep
 * `base`'s value (e.g. a pass-1 schedule stamp). */
export function applyRemainingChanges(base: Series, original: Series, planned: Series): Series {
  const origById = new Map(
    ((original.fixtures as StoredFixture[]) ?? []).map((f) => [f.id, f] as const),
  );
  const planById = new Map(
    ((planned.fixtures as StoredFixture[]) ?? []).map((f) => [f.id, f] as const),
  );
  const out = structuredClone(base);
  out.fixtures = ((out.fixtures as StoredFixture[]) ?? []).map((f) => {
    const o = origById.get(f.id);
    const p = planById.get(f.id);
    if (!o || !p) return f;
    const nf: StoredFixture = { ...f };
    for (const { field, after } of diffFixture(o, p)) nf[field] = after;
    return nf;
  }) as Series['fixtures'];
  return out;
}

// ─────────────────────────────── offline loading ───────────────────────────────

/** Raw DynamoDB Query output ({Items:[marshalled]}) or a plain decoded array → plain objects. */
export function decodeItems(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  const items = (raw as { Items?: unknown[] })?.Items;
  if (!Array.isArray(items))
    throw new Error('expected a JSON array or DynamoDB Query output {Items:[…]}');
  return items.map((it) => unmarshall(it as Parameters<typeof unmarshall>[0]));
}

const STORAGE_KEYS = ['pk', 'sk', 'gsi1pk', 'gsi1sk'];
function stripStorageKeys<T>(o: Record<string, unknown>): T {
  const c = { ...o };
  for (const k of STORAGE_KEYS) delete c[k];
  return c as T;
}

export function loadOffline(paths: { series: string; clubs: string; venues: string }) {
  const read = (p: string) => decodeItems(JSON.parse(readFileSync(p, 'utf8')));
  const series = read(paths.series)
    .filter((i) => i.sk === undefined || i.sk === 'META')
    .map((i) => stripStorageKeys<Series>(i));
  const clubs = read(paths.clubs)
    .filter((i) => i.sk === undefined || i.sk === 'META')
    .map((i) => stripStorageKeys<Club>(i));
  const venues = read(paths.venues).map((i) => {
    const id = (i.id as string | undefined) ?? String(i.sk ?? '').replace(/^VENUE#/, '');
    return stripStorageKeys<Venue>({ ...i, id });
  });
  return { series, clubs, venues };
}

// ─────────────────────────────── CLI ───────────────────────────────

interface CliArgs {
  tenant: string;
  manifest: string;
  confirm: boolean;
  seriesJson?: string;
  clubsJson?: string;
  venuesJson?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { tenant: '', manifest: '', confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') args.confirm = true;
    else if (a === '--tenant') args.tenant = argv[++i] ?? '';
    else if (a === '--manifest') args.manifest = argv[++i] ?? '';
    else if (a === '--series-json') args.seriesJson = argv[++i];
    else if (a === '--clubs-json') args.clubsJson = argv[++i];
    else if (a === '--venues-json') args.venuesJson = argv[++i];
    else throw new Error(`unknown flag ${a}`);
  }
  if (!args.tenant) throw new Error('--tenant <slug> is required');
  if (!args.manifest) throw new Error('--manifest <path> is required');
  const offline = [args.seriesJson, args.clubsJson, args.venuesJson].filter(Boolean).length;
  if (offline !== 0 && offline !== 3)
    throw new Error('offline mode needs all three of --series-json, --clubs-json, --venues-json');
  if (offline && args.confirm)
    throw new Error('offline mode (local JSON export) never writes — drop --confirm');
  return args;
}

const show = (v: unknown): string => (v === undefined ? '∅' : JSON.stringify(v));

export async function runPatchFixtures(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const { tenant } = args;
  const offline = Boolean(args.seriesJson);
  const manifest = JSON.parse(readFileSync(args.manifest, 'utf8')) as PatchManifest;
  if (manifest.tenant && manifest.tenant !== tenant)
    throw new Error(`manifest is for tenant "${manifest.tenant}", not "${tenant}"`);

  let series: Series[];
  let clubs: Club[];
  let venues: Venue[];
  let aliases: Record<string, string>;
  let repo: typeof import('./repo.js') | undefined;
  if (offline) {
    ({ series, clubs, venues } = loadOffline({
      series: args.seriesJson!,
      clubs: args.clubsJson!,
      venues: args.venuesJson!,
    }));
    // No tenant config in an export: the code-default alias map.
    aliases = venueAliasesFor(undefined);
  } else {
    repo = await import('./repo.js');
    aliases = venueAliasesFor(await repo.getTenantConfig(tenant));
    [series, clubs, venues] = await Promise.all([
      repo.listSeries(tenant),
      repo.listClubs(tenant),
      repo.listVenues(tenant),
    ]);
  }

  console.log(
    `patch-fixtures (${tenant}) — ${args.manifest} — ${offline ? 'OFFLINE ' : ''}${args.confirm ? 'CONFIRM (write)' : 'DRY-RUN'}\n` +
      `${series.length} series, ${clubs.length} clubs, ${venues.length} venues; ${manifest.entries?.length ?? 0} manifest entries\n`,
  );

  const plan = planFixturePatches(series, clubs, venues, manifest, aliases);
  const seriesName = new Map(series.map((s) => [String(s.id), s.name]));

  const patches = plan.diffs.filter((d) => d.kind === 'patch');
  console.log(`■ Section A — ${patches.length} patch(es)`);
  for (const d of patches) {
    console.log(`  ${d.seriesId}/${d.fixtureId}  (${seriesName.get(d.seriesId) ?? ''})`);
    for (const c of d.changes) console.log(`     ${c.field}: ${show(c.before)} → ${show(c.after)}`);
  }

  console.log(`\n■ Section B — ${plan.moves.length} draft move(s)`);
  for (const m of plan.moves) {
    console.log(
      `  ${m.date} ${m.seriesId}/${m.fixtureId} (${m.home ?? '?'} v ${m.away ?? '?'}): ${m.from} → ${m.to} [${m.label}]` +
        `${m.registryMiss ? ' ⚠ not in registry' : ''}`,
    );
    console.log(`     blocked by released ${m.blockedBy.join(', ')}`);
    for (const t of m.tried) console.log(`     skipped ${t}`);
  }

  if (plan.gate) {
    const g = plan.gate;
    console.log(
      `\n■ Gate — ${g.totalAfter} clash(es) in the resulting tenant, ${g.introduced.length} NEWLY introduced, ` +
        `${g.weekendReleased.length} on the manifest dates involving a released fixture`,
    );
    for (const c of g.introduced) console.log(`   NEW  ${formatClashForHumans(c)}`);
    for (const c of g.weekendReleased) console.log(`   RELEASED  ${formatClashForHumans(c)}`);
    for (const c of g.weekendDraftOnly)
      console.log(`   pre-existing draft-vs-draft (not fatal)  ${formatClashForHumans(c)}`);
  }

  // Umpire appointments on touched fixtures, so they can be checked against the new slots.
  const touchedRefs = new Set(plan.diffs.map((d) => `${d.seriesId}#${d.fixtureId}`));
  if (repo) {
    const officials = (await repo.listFixtureOfficials(tenant)).filter((o) =>
      touchedRefs.has(`${o.seriesId}#${o.fixtureId}`),
    );
    console.log(`\n■ FIXOFFICIALS on touched fixtures — ${officials.length}`);
    for (const o of officials) console.log(`  ${o.seriesId}/${o.fixtureId}  ${JSON.stringify(o)}`);
  } else {
    console.log(
      '\n■ FIXOFFICIALS on touched fixtures — skipped (offline export has no officials rows)',
    );
  }

  if (plan.errors.length) {
    console.error('\nHARD ERRORS — nothing written:');
    for (const e of plan.errors) console.error(`  ✗ ${e}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `\n${patches.length} patch(es) + ${plan.moves.length} draft move(s) across ${plan.touchedSeriesIds.length} series.`,
  );
  if (!args.confirm || !repo) {
    console.log('[dry-run] nothing written. Re-run with --confirm to apply.');
    return;
  }

  // ── Write. ──
  const { writeSeriesFromSnapshot } = await import('./medicoach-sync/cli-write.js');
  const originalById = new Map(series.map((s) => [String(s.id), s]));
  const nextById = new Map(plan.next.map((s) => [String(s.id), s]));

  const backup = {
    tenant,
    at: new Date().toISOString(),
    manifest: args.manifest,
    series: plan.touchedSeriesIds.map((id) => originalById.get(id)!),
  };
  const backupPath = fileURLToPath(
    new URL(
      `../patch-fixtures-backup-${tenant}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      import.meta.url,
    ),
  );
  await writeFile(backupPath, JSON.stringify(backup, null, 2));
  console.log(`Backup written: ${backupPath} (${backup.series.length} series)`);

  let failed = 0;
  for (const id of plan.touchedSeriesIds) {
    const original = originalById.get(id)!;
    const planned = structuredClone(nextById.get(id)!);
    const teamOnly = teamOnlySnapshot(original, planned);
    if (!teamOnly) {
      if ((await writeSeriesFromSnapshot(repo, tenant, original, planned)) === 'drifted') failed++;
      else console.log(`wrote ${id} v${planned.version}`);
      continue;
    }
    // Pass 1: side changes only.
    if ((await writeSeriesFromSnapshot(repo, tenant, original, teamOnly)) === 'drifted') {
      failed++;
      continue;
    }
    console.log(`wrote ${id} v${teamOnly.version} (pass 1: home/away only)`);
    const reread = await repo.getSeries(tenant, id);
    if (
      !reread ||
      reread.version !== teamOnly.version ||
      canonicalJson(reread.fixtures) !== canonicalJson(teamOnly.fixtures)
    ) {
      console.error(
        `✗ ${id}: re-read after pass 1 does not match what pass 1 wrote — pass 2 NOT written. ` +
          `Inspect the series (backup: ${backupPath}) before re-running.`,
      );
      failed++;
      continue;
    }
    // Pass 2: every remaining change on top of the re-read series.
    const pass2 = applyRemainingChanges(reread, original, planned);
    if ((await writeSeriesFromSnapshot(repo, tenant, reread, pass2)) === 'drifted') {
      failed++;
      continue;
    }
    console.log(`wrote ${id} v${pass2.version} (pass 2: remaining changes)`);
  }
  if (failed) {
    process.exitCode = 1;
    console.error(`\n${failed} series NOT (fully) written — see above.`);
  }
  console.log('Done.');
}

// Run only as a script, not when imported by the test.
if (process.argv[1] && /patch-fixtures\.(ts|js)$/.test(process.argv[1])) {
  runPatchFixtures(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
