/**
 * Team ↔ club resolution for the fixtures broadcast paths (mirrors the frontend
 * `teamIdsForClub` / `resolveTeam` in src/data.ts).
 *
 * A series participant is a *team*, not a club. For a single-team club the teamId
 * equals the clubId (legacy-compatible); a multi-team club uses `tm_…` ids plus a
 * self-contained `series.participants` snapshot. Reading that snapshot keeps a
 * released series resolving names/coords even after the club later edits its roster;
 * a series with no `participants` is a legacy one where every id is a clubId.
 *
 * PARITY: a behavioural twin lives in src/data.ts (used by the admin/club fixtures
 * UI). Keep the matching/fallback rules in sync. The return shape differs on purpose
 * (flat coords here for the schedule text; `{ ground: {...} }` there for fixtureCost),
 * as does the orphan/missing string ("TBA" here is player-facing; the UI uses the more
 * explicit "Removed club"/"Unknown team").
 */
import type { Club, Series } from './types.js';

type ParticipantsOnly = Pick<Series, 'participants'>;

/** The teamIds this club fields in a series. Legacy series ⇒ [clubId]. */
export function teamIdsForClub(series: ParticipantsOnly, clubId: string): string[] {
  const parts = series?.participants;
  if (Array.isArray(parts) && parts.length) {
    return parts.filter((p) => p && p.clubId === clubId).map((p) => p.teamId);
  }
  return [clubId];
}

export interface ResolvedTeam {
  teamId: string;
  clubId?: string;
  club?: Club;
  name: string;
  venue?: string;
  lat?: number;
  lon?: number;
}

/** Resolve a fixture id → club, display name, home venue and travel coords. */
export function resolveTeam(
  series: ParticipantsOnly,
  teamId: string,
  clubsById: Map<string, Club>,
): ResolvedTeam {
  const parts = series?.participants;
  if (Array.isArray(parts) && parts.length) {
    const p = parts.find((x) => x && x.teamId === teamId);
    if (p) {
      const club = clubsById.get(p.clubId);
      const lat = Number.isFinite(p.lat) ? p.lat : club?.ground?.lat;
      const lon = Number.isFinite(p.lon) ? p.lon : club?.ground?.lon;
      return {
        teamId,
        clubId: p.clubId,
        club,
        name: p.name || club?.name || 'TBA',
        venue: p.venue || club?.ground?.venue,
        lat,
        lon,
      };
    }
    return { teamId, name: 'TBA' };
  }
  const club = clubsById.get(teamId);
  return {
    teamId,
    clubId: teamId,
    club,
    name: club?.name ?? 'TBA',
    venue: club?.ground?.venue,
    lat: club?.ground?.lat,
    lon: club?.ground?.lon,
  };
}
