/**
 * Progressive fixture release (ADR 0011): the read-side projection that turns a stored
 * series into what a CLUB user may see, plus the shared shape helpers the PATCH route
 * needs. Pure — no repo, no Hono, no clock: the caller passes `today` and the storage
 * layer owns the write. Kept separate from index.ts so both the API and the unit tests
 * exercise the exact same rules.
 *
 * The store always holds the REAL venue/time data — withholding is a projection applied
 * when reading as a club, never a mutation of the series. That is what lets the release
 * clash gate keep seeing real venues while clubs see "to be confirmed".
 */
import { HttpError } from './auth.js';
import type { Series, WithheldField } from './types.js';

/** The only two fields an admin may withhold at release. */
export const WITHHELD_FIELDS: readonly WithheldField[] = ['venue', 'time'];

/**
 * Fixture keys carrying venue identity/allocation. All eight are stripped together when
 * `withheld.venue` — leaving any one behind (e.g. `venueLat`) would let the client
 * reconstruct the ground or quote a distance to it.
 */
export const VENUE_FIXTURE_KEYS = [
  'venueId',
  'venueName',
  'venueLat',
  'venueLon',
  'venueStatus',
  'venueReason',
  'venueLocked',
  'venueOverride',
] as const;

/** Fixture keys carrying kick-off time. Stripped together when `withheld.time`. */
export const TIME_FIXTURE_KEYS = ['time', 'slot'] as const;

/**
 * Validate + normalise the `withheld` object off a release PATCH. Only `true` keys are
 * kept (storage never carries a `false`); an object that withholds nothing collapses to
 * `undefined` so the key stays absent. Throws 400 on any shape that isn't
 * `{ venue?: boolean, time?: boolean }` — an unknown key, a non-boolean value, or a
 * non-object — so a malformed release can never write a half-withheld series.
 */
export function normaliseWithheld(input: unknown): { venue?: true; time?: true } | undefined {
  const bad = () => new HttpError(400, 'withheld must be { venue?: boolean, time?: boolean }');
  if (input === undefined) return undefined;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw bad();
  const out: { venue?: true; time?: true } = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key !== 'venue' && key !== 'time') throw bad();
    if (typeof value !== 'boolean') throw bad();
    if (value) out[key] = true;
  }
  return Object.keys(out).length ? out : undefined;
}

/** True when the series withholds `field` from clubs. Absent `withheld` ⇒ nothing hidden. */
export function isWithheld(series: Series, field: WithheldField): boolean {
  return series.withheld?.[field] === true;
}

/**
 * Project a stored series into the club-facing view, or `null` when the club should not
 * see it at all. Never mutates its input — every stripped object is cloned first.
 *
 *  - unreleased ⇒ `null` (closes the draft leak: reps used to receive every draft)
 *  - released but `activateFrom` is in the future ⇒ `null` (server now mirrors the
 *    portal / send-fixtures read gate instead of trusting the client to hide it)
 *  - always strips `approved`/`approvedAt` (an admin sign-off state, not a club concern)
 *  - `withheld.time` ⇒ each fixture loses `time`/`slot`, the series loses `schedule.slots`
 *    (stage kick-off times)
 *  - `withheld.venue` ⇒ each fixture loses all eight venue keys
 *  - always keeps `withheld`/`revealedAt` so the client renders "to be confirmed"
 *    explicitly rather than inferring it from missing fields
 */
export function projectSeriesForClub(series: Series, today: string): Series | null {
  if (!series.released) return null;
  if (series.activateFrom && series.activateFrom > today) return null;

  const out: Series = { ...series };
  delete out.approved;
  delete out.approvedAt;

  const hideVenue = isWithheld(series, 'venue');
  const hideTime = isWithheld(series, 'time');

  if (hideVenue || hideTime) {
    const fixtures = Array.isArray(series.fixtures) ? series.fixtures : [];
    out.fixtures = fixtures.map((f) => {
      const fx = { ...(f as Record<string, unknown>) };
      if (hideVenue) for (const k of VENUE_FIXTURE_KEYS) delete fx[k];
      if (hideTime) for (const k of TIME_FIXTURE_KEYS) delete fx[k];
      return fx;
    });
  }

  if (hideTime && series.schedule) {
    const schedule = { ...series.schedule };
    delete schedule.slots;
    out.schedule = schedule;
  }

  return out;
}
