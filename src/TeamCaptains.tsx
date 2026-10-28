/* ─── Team captain designation (pre-match squad links) ───
 *
 * The squad link goes to a team's DESIGNATED captain first (then its last known captain, then
 * the chair). One picker per side the club fields: the club itself for a single-side league,
 * each named `tm_` side for a league with several. Backed by the club's roster plus its veterans affiliates; a change
 * saves at once (GET/PUT /clubs/:id/teams/:teamId/captain). Shown in the admin club detail and
 * the club portal's player roster.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card } from './atoms';
import { useFeature } from './branding';
import { ApiError, getCaptainCandidates, getTeamCaptain, putTeamCaptain } from './api';
import { qk } from './query';

interface ClubTeamsShape {
  id: string;
  name: string;
  leagues?: string[];
  leagueTeams?: Record<string, number>;
  teamRosters?: Record<string, unknown>;
}

/** Every side the club fields, de-duplicated: `{ id, name }`. */
export function clubTeams(club: ClubTeamsShape): Array<{ id: string; name: string }> {
  const out = new Map<string, string>();
  for (const k of club.leagues ?? []) {
    const roster = club.teamRosters?.[k];
    const named = Array.isArray(roster)
      ? (roster as Array<{ id?: unknown; name?: unknown }>).filter(
          (t): t is { id: string; name: string } =>
            typeof t?.id === 'string' && typeof t?.name === 'string',
        )
      : [];
    if ((Number(club.leagueTeams?.[k]) || 1) >= 2 && named.length)
      for (const t of named) out.set(t.id, t.name);
    else out.set(club.id, club.name);
  }
  if (!out.size) out.set(club.id, club.name);
  return [...out].map(([id, name]) => ({ id, name }));
}

function TeamCaptainRow({ clubId, team }: { clubId: string; team: { id: string; name: string } }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const key = qk.teamCaptain(clubId, team.id);
  const query = useQuery({ queryKey: key, queryFn: () => getTeamCaptain(clubId, team.id) });
  const candidates = useQuery({
    queryKey: qk.captainCandidates(clubId, team.id),
    queryFn: () => getCaptainCandidates(clubId, team.id),
  });
  const save = useMutation({
    mutationFn: (candidateId: string | null) => putTeamCaptain(clubId, team.id, candidateId),
    onSuccess: (res) => {
      setError(null);
      qc.setQueryData(key, res);
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'Could not save the captain'),
  });
  const list = candidates.data?.candidates ?? [];
  const current = query.data?.captain?.candidateId ?? '';
  const listed = list.some((p) => p.id === current);
  const label = (p: { name: string; affiliate?: true }) =>
    p.affiliate ? `${p.name} (affiliate)` : p.name;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <label style={{ minWidth: 160, fontWeight: 600 }} htmlFor={`cap-${team.id}`}>
        {team.name}
      </label>
      <select
        id={`cap-${team.id}`}
        className="field-select"
        aria-label={`Team captain — ${team.name}`}
        value={current}
        disabled={query.isLoading || candidates.isLoading || save.isPending}
        onChange={(e) => save.mutate(e.target.value || null)}
      >
        <option value="">No captain set</option>
        {current && !listed && (
          <option value={current}>
            {query.data?.captain
              ? label(query.data.captain) || 'Current captain'
              : 'Current captain'}
          </option>
        )}
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {label(p)}
          </option>
        ))}
      </select>
      {error && (
        <span className="rp-validation" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** "Team captain" per side: who the pre-match squad link goes to first. Candidates are the
 *  club's active players plus its veterans affiliates, served under opaque ids (never an ID
 *  number). */
export function TeamCaptainsCard({ club }: { club: ClubTeamsShape }) {
  // Shown for every medicoach-sync tenant (not gated on preMatchSquadLinks), so
  // captains can be designated BEFORE the squad-link feature is switched on.
  const on = useFeature('medicoachSync');
  if (!on) return null;
  return (
    <Card
      title="Team captain"
      sub="The day before each match, the squad selection link goes to this player first (then the chair)."
    >
      <div className="stack" style={{ gap: 10 }}>
        {clubTeams(club).map((t) => (
          <TeamCaptainRow key={t.id} clubId={club.id} team={t} />
        ))}
      </div>
    </Card>
  );
}
