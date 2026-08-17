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
  siripat1: 'siripatroadgrounds', // two fields at one complex, two registry rows —
  siripat2: 'siripatgrounds', // matching how the REVISED file allocates them
  crawfordnc: 'crawfordnorthcoast', // Railways
  laheepark: 'laheeparkoval', // PTCC's pinned "Lahee park cricket oval"
  tills: 'tillscrescentground', // Delta
  hammond: 'hammondoval', // UKZN's "Hammond Cricket Oval"
  danville1: 'danville', // Rhythm DHSOB
  harlequins1: 'vanriebekparkharlequins1', // "Van Riebek Park (Harlequins 1)"
  crusaders1: 'crusaderssports', // "Crusaders Sports Club"
  foresthills: 'foresthillssports', // "Forest Hills CC" → "Forest Hills Sports Club"
  phoenixstonebridge: 'stonebridge', // East Coast / Phoenix / Parkgate
  penguinstreet: 'penguinstreetground', // Meadowridge's "PENGUIN STREET GROUND"
  // From the union's "facility updated" permitted-fields sheet (17 Aug 2026).
  crusaders2: 'crusaders2field',
  dhubriroad: 'dhubriroadgrounds',
  hammondukzn: 'hammondoval', // "Hammond (UKZN)"
  harlequins2: 'vanriebekparkharlequins2',
  laheepark1: 'laheeparkoval',
  penguinstreetchatsworth: 'penguinstreetground', // "Penguin Street (Chatsworth)"
  phoenixsydmore: 'sidmore', // East Coast's "Sidmore" = the facility list's "Phoenix Sydmore"
  totioval: 'toti1', // "Toti Oval"
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
  date?: string;
  time?: string;
  home?: string;
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
 * Ground/date/time clashes that RELEASING the subject series would publish: each
 * subject fixture is checked against every other series' fixtures (any lifecycle — a
 * clash with a draft is still a double-booking the season carries) and against the
 * subject's own earlier fixtures. Cancelled fixtures don't book; fixtures with no
 * determinable ground can't clash. Returns human-readable lines, empty when clean.
 */
export function findReleaseClashes(
  subject: Series,
  allSeries: Series[],
  clubs: Club[],
  venues: Venue[],
): string[] {
  const clubsById = new Map(clubs.map((c) => [c.id, c]));
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
      });
    }
  }
  const clashes: string[] = [];
  for (const f of (subject.fixtures as StoredFixture[]) ?? []) {
    if (!f.date || f.status === 'cancelled') continue;
    const ground = effectiveGround(subject, f, clubsById);
    if (!ground) continue;
    const hit = ledger.check(ground, f.date, f.time);
    if (hit) {
      clashes.push(
        `${f.id ?? '?'}: ${ground} on ${f.date}${f.time ? ' ' + f.time : ''} (also ${hit.seriesId}/${hit.fixtureId})`,
      );
    }
    ledger.book(ground, f.date, f.time, {
      seriesId: String(subject.id),
      fixtureId: f.id ?? '',
      date: f.date,
      time: f.time,
    });
  }
  return clashes;
}
