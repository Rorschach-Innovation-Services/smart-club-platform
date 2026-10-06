/* ─── Professional team → Exits: who stopped playing, and where they are now ───
 *
 * Built on pro-exits.ts. The Smart Club register and clearances are read here (admin only); if
 * they can't be loaded the page still works from the scorecards and scouting data, and says so.
 */
import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import * as api from './api';
import { qk } from './query';
import { PRO_MATCHES, SCOUT_POOLS } from './pro-data';
import { SCOUTING_EVENTS } from './scouting-data';
import { ACTIVE_DAYS, FADING_DAYS, exitReport, type ExitRow, type SightingKind } from './pro-exits';
import type { Squad } from './pro-team';
import { Tile } from './pro-charts';

const fmtDay = (d?: string) =>
  d
    ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : '';
const KIND_LABEL: Record<SightingKind, string> = {
  franchise: 'Another franchise',
  club: 'Club cricket',
  scouting: 'Scouting competition',
  register: 'Smart Club register',
  clearance: 'Clearance',
};
const STATUS_LABEL = {
  active: 'In the squad',
  fading: 'Not seen 6–12 months',
  exited: 'Gone 12+ months',
} as const;

type Filter = 'gone' | 'fading' | 'exited' | 'all';

export function ExitsView({
  squad,
  openPlayer,
}: {
  squad: Squad;
  openPlayer: (name: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('gone');
  const [q, setQ] = useState('');
  // The platform's own register and clearances (club cricket): where a player is registered now.
  const clubsQ = useQuery({ queryKey: qk.clubs(), queryFn: api.getClubs, retry: false });
  const clubs = clubsQ.data ?? [];
  const playersQ = useQueries({
    queries: clubs.map((c) => ({
      queryKey: qk.players(c.id),
      queryFn: () => api.getPlayers(c.id),
      retry: false,
    })),
  });
  const clearQ = useQuery({
    queryKey: qk.allClearances(),
    queryFn: api.getAllClearances,
    retry: false,
  });
  const register = useMemo(
    () =>
      playersQ.flatMap((r, i) =>
        (r.data ?? []).map((p) => ({
          name: `${p.firstName} ${p.lastName}`,
          club: clubs[i]?.name ?? '',
          since: p.createdAt?.slice(0, 10),
        })),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playersQ.map((r) => r.dataUpdatedAt).join(), clubs],
  );
  const clearances = useMemo(
    () =>
      (clearQ.data ?? []).map((c) => ({
        name: c.playerName,
        from: c.fromClubName,
        to: c.toClubName,
        date: c.requestedAt?.slice(0, 10) ?? '',
        status: String(c.status),
      })),
    [clearQ.data],
  );
  const registerFailed = clubsQ.isError || playersQ.some((r) => r.isError);
  const report = useMemo(
    () =>
      exitReport(squad, PRO_MATCHES, {
        pools: SCOUT_POOLS,
        events: SCOUTING_EVENTS,
        register,
        clearances,
      }),
    [squad, register, clearances],
  );
  const { rows, flow, seasons, asOf } = report;
  const gone = rows.filter((r) => r.status !== 'active');
  const counts = {
    active: rows.filter((r) => r.status === 'active').length,
    fading: rows.filter((r) => r.status === 'fading').length,
    exited: rows.filter((r) => r.status === 'exited').length,
    playing: gone.filter((r) => r.whereNow === 'still-playing').length,
    trace: gone.filter((r) => r.whereNow === 'no-trace').length,
  };
  const needle = q.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      (filter === 'all' || (filter === 'gone' && r.status !== 'active') || r.status === filter) &&
      (!needle || r.name.toLowerCase().includes(needle)),
  );
  const maxUp = Math.max(1, ...flow.map((f) => f.retained + f.arrived));
  const maxDown = Math.max(1, ...flow.map((f) => f.left));
  const maxGames = Math.max(1, ...rows.flatMap((r) => Object.values(r.seasons)));

  return (
    <>
      <div className="pro-note">
        <span>
          Measured from the newest game in the files ({fmtDay(asOf)}): in the squad = played in the
          last 6 months, not seen = 6–12 months, gone = longer. "Where now" looks for the same name
          in other franchises' scorecards, the scouting pools and competitions, and Smart Club's
          register and clearances — names match exactly, so check the source.
          {registerFailed
            ? ' The Smart Club register couldn’t be loaded, so it isn’t included.'
            : ''}
        </span>
      </div>

      <div className="pv-tiles">
        <Tile
          label="Players used"
          value={rows.length}
          sub={`${seasons.length} seasons in the files`}
        />
        <Tile
          label="In the squad"
          value={counts.active}
          sub={`played since ${fmtDay(shift(asOf, -ACTIVE_DAYS))}`}
          tone="good"
        />
        <Tile label="Not seen 6–12 months" value={counts.fading} sub="fading out" />
        <Tile
          label="Gone 12+ months"
          value={counts.exited}
          sub="exited the squad"
          tone={counts.exited ? 'bad' : undefined}
        />
        <Tile
          label="Of those gone"
          value={`${counts.playing} playing`}
          sub={`${counts.trace} with no trace since`}
        />
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Squad flow, season by season</div>
            <div className="card-sub">
              Above the line: players kept from last season and new faces · below: who played last
              season but not this one
            </div>
          </div>
        </div>
        <div className="card-body">
          <div className="pv-legend" aria-hidden="true">
            <span>
              <i className="pv-key squad" />
              Kept
            </span>
            <span>
              <i className="pv-key third" />
              New
            </span>
            <span>
              <i className="pv-key risk" />
              Left
            </span>
          </div>
          <div className="pro-flow" role="table" aria-label="Squad flow">
            {flow.map((f) => (
              <div
                key={f.season}
                className={`pro-flow-col${f.partial ? ' partial' : ''}`}
                role="row"
              >
                <div className="pro-flow-up" role="cell">
                  <span className="pro-flow-n">{f.retained + f.arrived}</span>
                  {f.arrived > 0 && (
                    <i
                      className="third"
                      style={{ height: `${(f.arrived / maxUp) * 100}%` }}
                      title={`${f.arrived} new`}
                    >
                      {f.arrived ? f.arrived : ''}
                    </i>
                  )}
                  {f.retained > 0 && (
                    <i
                      className="squad"
                      style={{ height: `${(f.retained / maxUp) * 100}%` }}
                      title={`${f.retained} kept`}
                    >
                      {f.retained ? f.retained : ''}
                    </i>
                  )}
                </div>
                <div className="pro-flow-axis" role="cell">
                  <strong>{f.season}</strong>
                  <small>
                    {f.games} game{f.games === 1 ? '' : 's'}
                    {f.partial ? ' · under way' : ''}
                    {f.season === flow[0].season ? ' · first in the files' : ''}
                  </small>
                </div>
                <div className="pro-flow-down" role="cell">
                  {f.left > 0 && (
                    <i
                      className="risk"
                      style={{ height: `${(f.left / maxDown) * 100}%` }}
                      title={`${f.left} left`}
                    >
                      {f.left ? f.left : ''}
                    </i>
                  )}
                </div>
              </div>
            ))}
          </div>
          {flow.some((f) => f.partial) && (
            <p className="pv-note">
              The newest season has only just started, so "left" there mostly means "not picked
              yet".
            </p>
          )}
        </div>
      </div>

      <div className="sc-two">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Moved on — still playing</div>
              <div className="card-sub">Out of the squad but seen since, with where</div>
            </div>
          </div>
          <div className="card-body pro-where">
            {gone.filter((r) => r.whereNow === 'still-playing').length === 0 ? (
              <div className="pv-empty">Nobody out of the squad has been seen elsewhere yet.</div>
            ) : (
              gone
                .filter((r) => r.whereNow === 'still-playing')
                .map((r) => <WhereCard key={r.name} r={r} onOpen={openPlayer} />)
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">No trace since</div>
              <div className="card-sub">
                Out of the squad and not seen anywhere the platform can see — possibly stopped
              </div>
            </div>
          </div>
          <div className="card-body pro-where">
            {gone.filter((r) => r.whereNow === 'no-trace').length === 0 ? (
              <div className="pv-empty">Everyone who left has been seen since.</div>
            ) : (
              gone
                .filter((r) => r.whereNow === 'no-trace')
                .map((r) => <WhereCard key={r.name} r={r} onOpen={openPlayer} />)
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Careers in the squad</div>
            <div className="card-sub">
              Games per season (darker = more) · last game and where they are now
            </div>
          </div>
          <div className="pro-season-bar">
            <input
              type="search"
              className="field-select sc-select"
              placeholder="Search a player…"
              aria-label="Search exits"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className="pro-seg small" role="tablist" aria-label="Show">
              {(
                [
                  ['gone', 'Out of the squad'],
                  ['exited', 'Gone 12+ months'],
                  ['fading', 'Not seen 6–12'],
                  ['all', 'Everyone'],
                ] as [Filter, string][]
              ).map(([k, l]) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={filter === k}
                  className={filter === k ? 'on' : ''}
                  onClick={() => setFilter(k)}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="tbl-w">
          <table className="tbl pro-tbl pro-careers" aria-label="Careers in the squad">
            <thead>
              <tr>
                <th>Player</th>
                {seasons.map((s) => (
                  <th key={s}>{s}</th>
                ))}
                <th>Last game</th>
                <th>Status</th>
                <th>Where now</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.name}>
                  <td>
                    <strong>{r.name}</strong>
                    <div className="ump-sub">
                      {r.games} games · {r.lastFormat}
                    </div>
                  </td>
                  {seasons.map((s) => {
                    const g = r.seasons[s] ?? 0;
                    return (
                      <td key={s} className="pro-cell">
                        {g ? (
                          <span
                            className="pro-heat"
                            style={{ opacity: 0.25 + 0.75 * (g / maxGames) }}
                            title={`${g} games in ${s}`}
                          >
                            {g}
                          </span>
                        ) : (
                          <span className="pro-heat empty">·</span>
                        )}
                      </td>
                    );
                  })}
                  <td>
                    {fmtDay(r.last)}
                    <div className="ump-sub">{r.daysSince} days before the newest game</div>
                  </td>
                  <td>
                    <span
                      className={`pro-sig ${r.status === 'active' ? 'promote' : r.status === 'exited' ? 'drop' : 'watch'}`}
                    >
                      {STATUS_LABEL[r.status]}
                    </span>
                  </td>
                  <td className="ump-sub">
                    {r.whereNow === 'in-squad'
                      ? '—'
                      : r.sightings[0]
                        ? `${KIND_LABEL[r.sightings[0].kind]}: ${r.sightings[0].where}${r.sightings[0].date ? ` (${fmtDay(r.sightings[0].date)})` : ''}`
                        : 'No trace since'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="pv-note">
          {shown.length} of {rows.length} players · statuses use the last {ACTIVE_DAYS} /{' '}
          {FADING_DAYS} days of the data.
        </p>
      </div>
    </>
  );
}

function WhereCard({ r, onOpen }: { r: ExitRow; onOpen: (name: string) => void }) {
  return (
    <div className={`pro-where-card ${r.whereNow}`}>
      <div className="pro-where-top">
        <button type="button" className="pro-name" onClick={() => onOpen(r.name)}>
          {r.name}
        </button>
        <span className={`pro-sig ${r.status === 'exited' ? 'drop' : 'watch'}`}>
          {STATUS_LABEL[r.status]}
        </span>
      </div>
      <div className="ump-sub">
        {r.games} games for the squad · last {fmtDay(r.last)} ({r.lastFormat})
      </div>
      {r.sightings.length > 0 ? (
        <ul className="pro-sightings">
          {r.sightings.slice(0, 3).map((s, i) => (
            <li key={i} className={s.kind}>
              <b>{KIND_LABEL[s.kind]}</b> {s.where}
              {s.date ? ` · ${fmtDay(s.date)}` : ''} <small>({s.detail})</small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pro-sightings-none">Not seen since {fmtDay(r.last)}.</p>
      )}
    </div>
  );
}

function shift(date: string, d: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
}
