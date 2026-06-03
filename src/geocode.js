/* ─── Nominatim address helpers ─── */
// Pure functions for turning a Nominatim result into form-ready values.
// Kept separate from club.jsx (which pulls in Leaflet + CSS) so they stay
// trivially unit-testable in a plain node environment.

// Compose a short, human "street, suburb, city" address from Nominatim's
// addressdetails. display_name alone is a 9-segment string that looks broken in
// the form field (and re-geocodes poorly). Falls back to the first few
// display_name segments, then '' when nothing usable resolves — callers must
// treat '' as "no address" rather than writing a placeholder into the field.
export function shortAddress(r) {
  const a = r?.address || {};
  // Only emit a street when there's a road — a bare house number ("12") is noise.
  const street = a.road ? [a.house_number, a.road].filter(Boolean).join(' ') : '';
  const suburb = a.suburb || a.neighbourhood || a.city_district || a.village;
  const city = a.city || a.town || a.municipality;
  const parts = [street, suburb, city].filter(Boolean);
  if (parts.length) return parts.join(', ');
  if (!r?.display_name) return '';
  return r.display_name
    .split(',')
    .slice(0, 3)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');
}

// The suburb-equivalent locality, used for travel-cost grouping. undefined when
// none of the candidate fields are present.
export function suburbOf(r) {
  const a = r?.address || {};
  return a.suburb || a.neighbourhood || a.city_district || a.village || undefined;
}
