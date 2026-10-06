/**
 * Umpire allocation — the shapes and pure rules shared by the API and the admin console.
 *
 * Appointments are stored per fixture in their own item (never inside the Series item), so
 * an officials write never contends with a whole-series PATCH. Everything here is pure: no
 * repo, no clock, no DOM.
 */

/** A fixture has at most two on-field umpires. */
export const MAX_UMPIRES_PER_FIXTURE = 2;

/**
 * How long a fixture occupies an umpire when it has no end time. A T20 match plus the
 * changeover runs about four hours, so a 09:00 game frees its umpires by 13:00 and the
 * union's usual 09:00 + 13:30 double-header at one ground never overlaps itself.
 */
export const DEFAULT_SLOT_MINUTES = 4 * 60;

/** A registry entry. `aliases` are stored normalised (see `normaliseUmpireAlias`). */
export interface Umpire {
  id: string;
  /** How the union writes the name on the sheet, e.g. "A.Ngubane". */
  displayName: string;
  fullName?: string;
  aliases: string[];
  phone?: string;
  email?: string;
  active: boolean;
  /** Set when this entry was merged into another; the target id. */
  mergedInto?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** What a club member may see of the registry: no contact details. */
export type UmpirePublic = Pick<Umpire, 'id' | 'displayName'>;

/** One appointed official, with the display name denormalised at write time. */
export interface OfficialRef {
  umpireId: string;
  name: string;
}

/** The appointments for one fixture. */
export interface FixtureOfficials {
  umpires: OfficialRef[];
  referee?: OfficialRef;
  updatedAt?: string;
  updatedBy?: string;
}

/** The stored item: the appointments plus the fixture they belong to. */
export interface FixtureOfficialsRecord extends FixtureOfficials {
  seriesId: string;
  fixtureId: string;
}

/**
 * The form an alias is stored and compared in: lowercase, accents dropped, and every dot,
 * space and other punctuation removed. "A.Ngubane", "A. Ngubane" and "a ngubane" are all
 * `angubane`.
 */
export function normaliseUmpireAlias(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** The full alias set for an entry: its display name, full name and any extra aliases. */
export function umpireAliasSet(
  u: Pick<Umpire, 'displayName' | 'fullName'> & { aliases?: string[] },
): string[] {
  const out = new Set<string>();
  for (const raw of [u.displayName, u.fullName, ...(u.aliases ?? [])]) {
    if (typeof raw !== 'string') continue;
    const n = normaliseUmpireAlias(raw);
    if (n) out.add(n);
  }
  return [...out];
}

/** One umpire's appearance on one fixture, as the double-booking check sees it. */
export interface UmpireBooking {
  umpireId: string;
  seriesId: string;
  fixtureId: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** HH:MM start; absent when the fixture has no set time. */
  time?: string;
  /** HH:MM end, when known; otherwise the start plus `slotMinutes`. */
  endTime?: string;
  /** The ground name as displayed. Absent ⇒ unknown, which never warns. */
  venue?: string;
}

/** Two bookings of the same umpire that can't both happen. */
export interface UmpireDoubleBooking {
  umpireId: string;
  date: string;
  a: UmpireBooking;
  b: UmpireBooking;
}

const toMinutes = (hhmm: string | undefined): number | null => {
  const m = hhmm?.match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const venueKey = (v: string | undefined): string =>
  (v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Every pair of bookings where one umpire is at two DIFFERENT grounds on the same date with
 * overlapping times. The same ground twice in a day (09:00 then 13:30) is the normal T20
 * double-header and never counts, and neither does a booking whose ground is unknown. A
 * fixture with no start time could be at any hour, so it overlaps everything that day.
 *
 * This is a warning, never a gate: the admin may know the times are about to change.
 */
export function findUmpireDoubleBookings(
  bookings: UmpireBooking[],
  slotMinutes: number = DEFAULT_SLOT_MINUTES,
): UmpireDoubleBooking[] {
  const groups = new Map<string, UmpireBooking[]>();
  for (const b of bookings) {
    if (!b.umpireId || !b.date) continue;
    const key = `${b.umpireId}|${b.date}`;
    const list = groups.get(key);
    if (list) list.push(b);
    else groups.set(key, [b]);
  }
  const out: UmpireDoubleBooking[] = [];
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.seriesId === b.seriesId && a.fixtureId === b.fixtureId) continue;
        const va = venueKey(a.venue);
        const vb = venueKey(b.venue);
        if (!va || !vb || va === vb) continue;
        if (!windowsOverlap(a, b, slotMinutes)) continue;
        out.push({ umpireId: a.umpireId, date: a.date, a, b });
      }
    }
  }
  return out;
}

function windowsOverlap(a: UmpireBooking, b: UmpireBooking, slotMinutes: number): boolean {
  const sa = toMinutes(a.time);
  const sb = toMinutes(b.time);
  if (sa === null || sb === null) return true;
  const ea = toMinutes(a.endTime) ?? sa + slotMinutes;
  const eb = toMinutes(b.endTime) ?? sb + slotMinutes;
  return sa < eb && sb < ea;
}
