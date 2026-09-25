/**
 * Pure geo helpers shared by the venue engine and the web app's travel costing.
 */

/** Anything carrying (possibly missing) coordinates — a club ground, a venue, a team. */
export interface MaybeLatLon {
  lat?: number | null;
  lon?: number | null;
}

/** Haversine great-circle distance between two lat/lon coords (km). */
export function haversineKm(
  a: MaybeLatLon | null | undefined,
  b: MaybeLatLon | null | undefined,
): number {
  // Guarded on the COORDINATES, not on the objects. `{}` is truthy, and a pending
  // knockout side resolves to `ground: {}` (resolveTeam's slot-ref branch), as does a
  // club with no ground on record — so an object check let NaN through and every
  // bracket's later rounds rendered "NaN km" and "R NaN". A missing coordinate means
  // "unknown distance", and zero is the only honest number to add to a total.
  const finite = (p: MaybeLatLon | null | undefined): p is { lat: number; lon: number } =>
    !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon);
  if (!finite(a) || !finite(b)) return 0;
  const R = 6371;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
