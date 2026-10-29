/* ─── Team captain designation (pre-match squad links) ───
 *
 * The squad link goes to a team's DESIGNATED captain first (then its last known captain, then
 * the chair). One picker per side the club fields AND per competition that side plays in: the
 * club itself for a single-side league, each named `tm_` side for a league with several — and
 * because a club's men's, women's and veterans sides can share one team id, each competition
 * gets its own captain. Backed by the club's roster plus its veterans affiliates; a change
 * saves at once (GET/PUT /clubs/:id/teams/:teamId/captain). Shown in the admin club detail and
 * the club portal's player roster.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card } from './atoms';
import { useFeature } from './branding';
import { ApiError, getCaptainCandidates, getTeamCaptain, putTeamCaptain } from './api';
import { qk } from './query';
import type { TeamCaptainCompetition, TeamCaptainResponse } from './types';

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

type Candidate = { id: string; name: string; affiliate?: true };

const candidateLabel = (p: { name: string; affiliate?: true }) =>
  p.affiliate ? `${p.name} (affiliate)` : p.name;

function CompetitionCaptainPicker({
  clubId,
  team,
  competition,
  candidates,
  candidatesLoading,
}: {
  clubId: string;
  team: { id: string; name: string };
  competition: TeamCaptainCompetition;
  candidates: Candidate[];
  candidatesLoading: boolean;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const key = qk.teamCaptain(clubId, team.id);
  const save = useMutation({
    mutationFn: (candidateId: string | null) =>
      putTeamCaptain(clubId, team.id, competition.scope, candidateId),
    onSuccess: (res) => {
      setError(null);
      qc.setQueryData<TeamCaptainResponse>(key, (prev) =>
        prev
          ? {
              ...prev,
              competitions: prev.competitions.map((c) =>
                c.scope === res.scope ? { ...c, captain: res.captain } : c,
              ),
            }
          : prev,
      );
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'Could not save the captain'),
  });
  const current = competition.captain?.candidateId ?? '';
  const listed = candidates.some((p) => p.id === current);
  const id = `cap-${team.id}-${competition.scope}`;
  const title = `${team.name} — ${competition.name}`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <label style={{ minWidth: 160, fontWeight: 600 }} htmlFor={id}>
        {title}
      </label>
      <select
        id={id}
        className="field-select"
        aria-label={`Team captain — ${title}`}
        value={current}
        disabled={candidatesLoading || save.isPending}
        onChange={(e) => save.mutate(e.target.value || null)}
      >
        <option value="">No captain set</option>
        {current && !listed && (
          <option value={current}>
            {(competition.captain && candidateLabel(competition.captain)) || 'Current captain'}
          </option>
        )}
        {candidates.map((p) => (
          <option key={p.id} value={p.id}>
            {candidateLabel(p)}
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

function TeamCaptainRow({ clubId, team }: { clubId: string; team: { id: string; name: string } }) {
  const query = useQuery({
    queryKey: qk.teamCaptain(clubId, team.id),
    queryFn: () => getTeamCaptain(clubId, team.id),
  });
  // Candidates are deliberately TEAM-wide, not per competition: the club's roster (plus the
  // veterans affiliation expansion server-side) may captain any of the team's sides, so one
  // list serves every competition picker below; only the designation row is per competition.
  const candidates = useQuery({
    queryKey: qk.captainCandidates(clubId, team.id),
    queryFn: () => getCaptainCandidates(clubId, team.id),
  });
  if (query.isLoading) return <div style={{ color: 'var(--muted)' }}>{team.name}: loading…</div>;
  const competitions = query.data?.competitions ?? [];
  if (!competitions.length)
    return (
      <div style={{ color: 'var(--muted)' }}>
        {team.name}: not in a released competition yet — a captain can be set once its fixtures are
        released.
      </div>
    );
  return (
    <>
      {competitions.map((c) => (
        <CompetitionCaptainPicker
          key={c.scope}
          clubId={clubId}
          team={team}
          competition={c}
          candidates={candidates.data?.candidates ?? []}
          candidatesLoading={candidates.isLoading}
        />
      ))}
    </>
  );
}

/** "Team captain" per side and competition: who the pre-match squad link goes to first. Candidates are the
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
