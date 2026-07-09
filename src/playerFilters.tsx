/* ─── Shared player-list filters (admin cross-club register + club roster) ─── */

import { useMemo } from 'react';
import { Btn } from './atoms';
import { BOWLER_TYPES, GENDERS } from './data';

// Sentinel for the "No team" facet option — league keys are slugs derived from
// league names, so a literal collision with this value can't occur.
export const NO_TEAM = '__none__';

// Frozen: this object is the shared "no filters" baseline that hasActiveFilters
// compares against — an in-place mutation would silently corrupt every list.
export const emptyPlayerFilters = Object.freeze({
  q: '',
  club: 'all',
  status: 'all',
  team: 'all',
  role: 'all',
  bowler: 'all',
  gender: 'all',
  district: 'all',
});

export function hasActiveFilters(f) {
  return Object.keys(emptyPlayerFilters).some((k) => f[k] !== emptyPlayerFilters[k]);
}

// Mirrors playerRoleLabel: a pure batter is neither an all-rounder nor a WK and has no bowling.
function matchesRole(p, role) {
  if (role === 'wk') return !!p.isWk;
  if (role === 'all-rounder') return !!p.isAllRounder;
  if (role === 'batter') return !p.isAllRounder && !p.bowlerType && !p.isWk;
  if (role === 'bowler') return !!p.bowlerType;
  return true;
}

export function filterPlayers(players, f) {
  const needle = f.q.trim().toLowerCase();
  return players.filter((p) => {
    if (f.club !== 'all' && p.clubId !== f.club) return false;
    // Absent status ⇒ active (same rule as the status pills).
    if (f.status !== 'all' && (p.status || 'active') !== f.status) return false;
    if (f.team !== 'all' && (f.team === NO_TEAM ? !!p.team : p.team !== f.team)) return false;
    if (f.role !== 'all' && !matchesRole(p, f.role)) return false;
    if (f.bowler !== 'all' && p.bowlerType !== f.bowler) return false;
    if (f.gender !== 'all' && p.gender !== f.gender) return false;
    if (f.district !== 'all' && p.district !== f.district) return false;
    if (!needle) return true;
    const name = `${p.firstName || ''} ${p.lastName || ''}`.toLowerCase();
    const id = (p.idNumber || '').toLowerCase();
    return name.includes(needle) || id.includes(needle);
  });
}

/** "Showing X of Y players" — render only while filters are active. */
export function FilterResultCount({ shown, total }) {
  return (
    <div
      style={{
        marginTop: 12,
        fontSize: 11.5,
        color: 'var(--muted)',
        fontFamily: "'Montserrat',sans-serif",
      }}
    >
      Showing {shown} of {total} players
    </div>
  );
}

/**
 * Search box + facet selects for a player list. Data-derived facets (team,
 * district) come from `players`, which should be the club-scoped but
 * otherwise-unfiltered list so options never vanish as other facets narrow.
 * Pass `clubs` to render the club select (admin register only).
 */
export function PlayerFilterBar({ filters, onChange, players, teamLabel, clubs = null }) {
  const set = (key) => (e) => onChange({ ...filters, [key]: e.target.value });

  const teamOptions = useMemo(() => {
    const keys = new Set<string>(players.map((p) => p.team).filter(Boolean));
    // Keep the active selection listed even if the scoped data no longer has it
    // (e.g. the admin switched clubs), so the select never shows a blank value.
    if (filters.team !== 'all' && filters.team !== NO_TEAM) keys.add(filters.team);
    return [...keys]
      .map((key) => ({ key, label: teamLabel[key] || key }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  }, [players, teamLabel, filters.team]);

  const districtOptions = useMemo(() => {
    const vals = new Set<string>(players.map((p) => p.district).filter(Boolean));
    if (filters.district !== 'all') vals.add(filters.district);
    return [...vals].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [players, filters.district]);

  const sel = { maxWidth: 160 };

  return (
    <div className="filter-row">
      <input
        className="search-box"
        aria-label="Search players"
        placeholder="Search by player name or ID number…"
        value={filters.q}
        onChange={set('q')}
      />
      {clubs && (
        <select
          className="field-select"
          aria-label="Filter by club"
          value={filters.club}
          onChange={set('club')}
          style={{ maxWidth: 200 }}
        >
          <option value="all">All clubs</option>
          {clubs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name || c.slug}
            </option>
          ))}
        </select>
      )}
      <select
        className="field-select"
        aria-label="Filter by status"
        value={filters.status}
        onChange={set('status')}
        style={sel}
      >
        <option value="all">All statuses</option>
        <option value="active">Active</option>
        <option value="clearance-pending">Clearance pending</option>
        <option value="inactive">Inactive</option>
      </select>
      <select
        className="field-select"
        aria-label="Filter by team"
        value={filters.team}
        onChange={set('team')}
        style={sel}
      >
        <option value="all">All teams</option>
        <option value={NO_TEAM}>No team</option>
        {teamOptions.map((t) => (
          <option key={t.key} value={t.key}>
            {t.label}
          </option>
        ))}
      </select>
      <select
        className="field-select"
        aria-label="Filter by role"
        value={filters.role}
        onChange={set('role')}
        style={sel}
      >
        <option value="all">All roles</option>
        <option value="wk">Wicket-keeper</option>
        <option value="all-rounder">All-rounder</option>
        <option value="batter">Batter</option>
        <option value="bowler">Bowler</option>
      </select>
      <select
        className="field-select"
        aria-label="Filter by bowler type"
        value={filters.bowler}
        onChange={set('bowler')}
        style={sel}
      >
        <option value="all">All bowler types</option>
        {BOWLER_TYPES.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
      <select
        className="field-select"
        aria-label="Filter by gender"
        value={filters.gender}
        onChange={set('gender')}
        style={sel}
      >
        <option value="all">All genders</option>
        {GENDERS.map((g) => (
          <option key={g} value={g}>
            {g}
          </option>
        ))}
      </select>
      {(districtOptions.length >= 2 || filters.district !== 'all') && (
        <select
          className="field-select"
          aria-label="Filter by district"
          value={filters.district}
          onChange={set('district')}
          style={sel}
        >
          <option value="all">All districts</option>
          {districtOptions.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      )}
      {hasActiveFilters(filters) && (
        <Btn tone="outline" size="sm" onClick={() => onChange({ ...emptyPlayerFilters })}>
          Clear filters
        </Btn>
      )}
    </div>
  );
}
