/**
 * Season-wide venue clash detection — shared by the fixture import script and the
 * release gate on PATCH /series (a series with unresolved ground/date/time clashes
 * must not reach club portals; ADR: releasing a known double-booking is publishing a
 * schedule the union will have to retract).
 *
 * Semantics mirror the frontend allocator's ledger (src/competition/venues.ts): per
 * ground-and-date, bookings count per slot with an untimed fixture owning every slot
 * that day; a slot is full when its load reaches the ground's surface capacity
 * (max(1, surfaces ?? 1)). Registry-resolved grounds share one ledger row by venue id,
 * so "Toti Oval" on one fixture and "Toti 1" on another contest the same field.
 */
import type { Club, Series, Venue } from './types.js';

/** Lowercase, strip punctuation, drop generic suffix/roster words. Keeps
 * distinguishing words ("sporting", "united") — Chatsworth Sporting must not collide
 * with Chatsworth United. '1st'/'2nd'/'xi' let "Amanzimtoti CC 1st XI" collapse onto
 * "Amanzimtoti". Used for both club and ground names. */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(
      (w) =>
        w && !['cricket', 'club', 'clube', 'cc', 'association', '1st', '2nd', 'xi'].includes(w),
    )
    .join('');
}

/** Ground-name variants that don't normalise onto the venue registry's own name —
 * union sheet spellings on one side, club-record spellings on the other. Values are
 * the normalised form of real dolphins registry venue names. */
export const VENUE_ALIASES: Record<string, string> = {
  acc1: 'toti1', // "ACC 1" (REVISED) = Amanzimtoti's Toti 1
  // Exact-field numbering (union, 31 Aug 2026): the registry rows and club records are now
  // named by exact field number ("Siripat 1", "Crusaders 1", "Danville 1", "Harlequins 1"…),
  // so every OLD spelling aliases FORWARD onto the numbered canonical form.
  siripatroadgrounds: 'siripat1', // was "Siripat Road Grounds"
  siripatgrounds: 'siripat2', // was "Siripat Grounds"
  crawfordnc: 'crawfordnorthcoast', // Railways
  laheepark: 'laheeparkoval', // PTCC's pinned "Lahee park cricket oval"
  tills: 'tillscrescentground', // Delta
  hammond: 'hammondoval', // UKZN's "Hammond Cricket Oval"
  danville: 'danville1', // was "Danville"
  vanriebekparkharlequins1: 'harlequins1', // was "Van Riebek Park (Harlequins 1)"
  vanriebekparkharlequins2: 'harlequins2', // was "Van Riebek Park (Harlequins 2)"
  crusaderssports: 'crusaders1', // was "Crusaders Sports Club"
  crusaders2field: 'crusaders2', // was "Crusaders 2 Field"
  catormanor: 'catomanor1', // typo generic "Cator Manor" → merged into Cato Manor 1
  catomanor: 'catomanor1', // generic "Cato Manor" → merged into Cato Manor 1
  harlequins: 'harlequins1', // generic "Harlequins" → merged into Harlequins 1
  highburygrounds: 'highbury1', // generic "Highbury grounds" → merged into Highbury 1
  foresthills: 'foresthillssports', // "Forest Hills CC" → "Forest Hills Sports Club"
  phoenixstonebridge: 'stonebridge', // East Coast / Phoenix / Parkgate
  penguinstreet: 'penguinstreetground', // Meadowridge's "PENGUIN STREET GROUND"
  // From the union's "facility updated" permitted-fields sheet (17 Aug 2026).
  dhubriroad: 'dhubriroadgrounds',
  hammondukzn: 'hammondoval', // "Hammond (UKZN)"
  laheepark1: 'laheeparkoval',
  penguinstreetchatsworth: 'penguinstreetground', // "Penguin Street (Chatsworth)"
  phoenixsydmore: 'sidmore', // East Coast's "Sidmore" = the facility list's "Phoenix Sydmore"
  totioval: 'toti1', // "Toti Oval"
  gledhowgrounds: 'gledhowground', // Ilembe's club-record spelling of Dawnheights' "Gledhow Cricket Ground" — one shared field (union, 31 Aug 2026)
  chatsworthpenguingrounds: 'penguinstreetground', // Saints' club-record "Chatsworth, Penguin Grounds" = the registry's "PENGUIN STREET GROUND" (KCCD's re-base) — one field, one ledger row
};

/** A ground name's ledger/registry lookup key: alias applied over the normal form. */
export function groundKey(name: string): string {
  const n = normaliseName(name);
  return VENUE_ALIASES[n] ?? n;
}

/** Club-record ground values that mean "no ground recorded", not a ground named that. */
export const JUNK_GROUND = /^(none|n\/?a|-|tbd|tbc)$/i;

export interface LedgerBooking {
  seriesId: string;
  fixtureId: string;
  date: string;
  time?: string;
  // Display identity of the fixture that owns the slot, resolved at book time so a hit can
  // name the other side without a second lookup. `hit.fixtureId` is `''` for id-less
  // fixtures and unresolvable for `win:f3` slot refs, so we carry names/round instead of
  // re-deriving them from the raw ref later.
  home?: string;
  away?: string;
  round?: number;
}

/** How a ground name maps into the ledger: the identity bookings share, and how many
 * parallel fixtures it hosts per slot. */
export interface GroundSlot {
  key: string;
  capacity: number;
}

export class GroundLedger {
  private byGroundDate = new Map<string, LedgerBooking[]>();
  constructor(
    private resolve: (ground: string) => GroundSlot = (g) => ({
      key: normaliseName(g),
      capacity: 1,
    }),
  ) {}
  private slotKey(ground: string, date: string): { k: string; capacity: number } {
    const { key, capacity } = this.resolve(ground);
    return { k: `${key}|${date}`, capacity };
  }
  check(ground: string, date: string, time: string | undefined): LedgerBooking | undefined {
    const { k, capacity } = this.slotKey(ground, date);
    const entries = this.byGroundDate.get(k);
    if (!entries || entries.length === 0) return undefined;
    // Mirror venueLoad: a timed slot is loaded by same-time bookings plus untimed ones
    // (which own the whole day); an untimed fixture is loaded by everything that day.
    const relevant = time ? entries.filter((e) => !e.time || e.time === time) : entries;
    if (relevant.length < capacity) return undefined;
    return relevant[0];
  }
  book(ground: string, date: string, time: string | undefined, booking: LedgerBooking) {
    const { k } = this.slotKey(ground, date);
    const list = this.byGroundDate.get(k) ?? [];
    list.push({ ...booking, time });
    this.byGroundDate.set(k, list);
  }
}

interface StoredFixture {
  id?: string;
  round?: number;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  status?: string;
  venueOverride?: string;
  venueName?: string;
}

/** A fixture's effective ground: explicit venue fields, else the home side's club
 * ground via the series participants snapshot (legacy series: `home` IS a clubId). */
function effectiveGround(
  s: Series,
  f: StoredFixture,
  clubsById: Map<string, Club>,
): string | undefined {
  const explicit = f.venueOverride || f.venueName;
  if (explicit) return explicit;
  if (!f.home) return undefined;
  const participants = s.participants;
  const homeClubId = participants ? participants.find((p) => p.teamId === f.home)?.clubId : f.home;
  const own = homeClubId ? clubsById.get(homeClubId)?.ground?.venue?.trim() : undefined;
  return own && !JUNK_GROUND.test(own) ? own : undefined;
}

/** Registry-aware ledger resolver: registry grounds share a row by venue id and book
 * against their surface count; unknown names stay strict at one surface. */
export function registryResolver(venues: Venue[]): (ground: string) => GroundSlot {
  const byNorm = new Map<string, Venue>();
  for (const v of venues) byNorm.set(groundKey(v.name), v);
  return (ground) => {
    const venue = byNorm.get(groundKey(ground));
    return venue
      ? { key: `v:${venue.id}`, capacity: Math.max(1, Number(venue.surfaces) || 1) }
      : { key: `g:${groundKey(ground)}`, capacity: 1 };
  };
}

/**
 * A single ground/date/time double-booking the subject series would carry: which subject
 * fixture, at which effective ground, and the other fixture (series + side names + round)
 * that already holds the slot. The subject-side `home`/`away`/`round` let the server render
 * a human line ("R1 A v B: …"); the `with` side is what the fixture editor points the admin
 * at. Serialised straight into the 409 body and the pre-check response.
 */
export interface Clash {
  fixtureId: string; // subject fixture id ('' for an id-less fixture)
  round?: number;
  ground: string; // effective ground name as booked
  date: string;
  time?: string;
  home?: string; // subject-side display names
  away?: string;
  with: {
    seriesId: string;
    seriesName?: string;
    fixtureId: string;
    round?: number;
    home?: string;
    away?: string;
  };
}

/** A fixture side's DISPLAY name: participants snapshot (team name), else the club name
 * (legacy series where the ref IS a clubId), else the raw ref — a `win:f3` slot placeholder
 * has neither, so it shows as-is rather than fabricating a name. */
function resolveSide(
  s: Series,
  ref: string | undefined,
  clubsById: Map<string, Club>,
): string | undefined {
  if (!ref) return undefined;
  const p = s.participants?.find((x) => x.teamId === ref);
  if (p) return p.name;
  return clubsById.get(ref)?.name ?? ref;
}

/**
 * Ground/date/time clashes the subject series carries: each subject fixture is checked
 * against every other series' fixtures (any lifecycle — a clash with a draft is still a
 * double-booking the season carries) and against the subject's own earlier fixtures.
 * Cancelled fixtures don't book; fixtures with no determinable ground can't clash. Returns
 * structured `Clash` records (empty when clean); `findReleaseClashes` and `formatClash`
 * project them back to the legacy prose the release gate has always emitted.
 */
export function findClashes(
  subject: Series,
  allSeries: Series[],
  clubs: Club[],
  venues: Venue[],
): Clash[] {
  const clubsById = new Map(clubs.map((c) => [c.id, c]));
  const seriesById = new Map<string, Series>(allSeries.map((s) => [String(s.id), s]));
  // The subject may be an in-flight edit that isn't the stored copy in `allSeries`; index it
  // last so a self-clash (or a stale stored twin) resolves its name/sides off the edit.
  seriesById.set(String(subject.id), subject);
  const ledger = new GroundLedger(registryResolver(venues));
  for (const s of allSeries) {
    if (String(s.id) === String(subject.id)) continue;
    for (const f of (s.fixtures as StoredFixture[]) ?? []) {
      if (!f.date || f.status === 'cancelled') continue;
      const ground = effectiveGround(s, f, clubsById);
      if (!ground) continue;
      ledger.book(ground, f.date, f.time, {
        seriesId: String(s.id),
        fixtureId: f.id ?? '',
        date: f.date,
        time: f.time,
        home: resolveSide(s, f.home, clubsById),
        away: resolveSide(s, f.away, clubsById),
        round: f.round,
      });
    }
  }
  const clashes: Clash[] = [];
  for (const f of (subject.fixtures as StoredFixture[]) ?? []) {
    if (!f.date || f.status === 'cancelled') continue;
    const ground = effectiveGround(subject, f, clubsById);
    if (!ground) continue;
    const hit = ledger.check(ground, f.date, f.time);
    if (hit) {
      clashes.push({
        fixtureId: f.id ?? '',
        round: f.round,
        ground,
        date: f.date,
        time: f.time,
        home: resolveSide(subject, f.home, clubsById),
        away: resolveSide(subject, f.away, clubsById),
        with: {
          seriesId: hit.seriesId,
          seriesName: seriesById.get(hit.seriesId)?.name,
          fixtureId: hit.fixtureId,
          round: hit.round,
          home: hit.home,
          away: hit.away,
        },
      });
    }
    ledger.book(ground, f.date, f.time, {
      seriesId: String(subject.id),
      fixtureId: f.id ?? '',
      date: f.date,
      time: f.time,
      home: resolveSide(subject, f.home, clubsById),
      away: resolveSide(subject, f.away, clubsById),
      round: f.round,
    });
  }
  return clashes;
}

/** The legacy release-gate line, byte-for-byte: existing tests and the release toast read
 * it. Kept as a projection of `Clash` so `findReleaseClashes` stays a thin wrapper. */
export function formatClash(c: Clash): string {
  return `${c.fixtureId || '?'}: ${c.ground} on ${c.date}${c.time ? ' ' + c.time : ''} (also ${c.with.seriesId}/${c.with.fixtureId})`;
}

/** Reader-friendly one-liner for the in-season message and the fixture-editor panel: names
 * both sides and rounds instead of ids. */
export function formatClashForHumans(c: Clash): string {
  const time = c.time ? ' ' + c.time : '';
  return `R${c.round ?? '?'} ${c.home ?? '?'} v ${c.away ?? '?'}: ${c.ground} on ${c.date}${time} is already booked by ${c.with.seriesName ?? c.with.seriesId} R${c.with.round ?? '?'} · ${c.with.home ?? '?'} v ${c.with.away ?? '?'}`;
}

/** Identity of a clash as the PAIR-on-that-ground, deliberately WITHOUT date/time: moving a
 * residual-clashing fixture's kick-off (09:00 → 13:00) against the same untimed partner is
 * not a NEW double-booking, so the in-season gate's subset test must not count it as one
 * (ADR 0011 addendum). Ground is normalised so "Toti Oval" and "Toti 1" share a key.
 *
 * `fixtureId` is safe as a key component even though `f.id ?? ''` allows an empty string:
 * every fixture producer assigns a non-empty id — the client generator (`fixturesFromDates`
 * in src/competition/fixtures.ts, `id: 'f' + fixtureId++`), the union importer
 * (import-planb-fixtures.ts, `id: \`f${i + 1}\``) and the seeder (seed-cohort.ts, which
 * emits generator fixtures). So id-less fixtures collapsing to one key is not a real state
 * for first-party data; the `?? ''` is only a type-level fallback for the optional field.
 * Boundary of that guarantee: POST/PATCH /series do not enforce a fixture `id` on write, so
 * a scripted client COULD store id-less fixtures and collapse their keys. Not defended here;
 * requiring `id` on fixture writes is the follow-up if that ever matters. */
export function clashKey(c: Clash): string {
  return `${c.fixtureId}|${groundKey(c.ground)}|${c.with.seriesId}/${c.with.fixtureId}`;
}

/** Back-compat wrapper: the release gate's original prose-line signature, now a projection
 * of `findClashes`. Existing callers and tests are untouched. */
export function findReleaseClashes(
  subject: Series,
  allSeries: Series[],
  clubs: Club[],
  venues: Venue[],
): string[] {
  return findClashes(subject, allSeries, clubs, venues).map(formatClash);
}
