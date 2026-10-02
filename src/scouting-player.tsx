/* ─── Scouting: player panel (tabbed) and the selectors' watch list ─── */

import { useState } from 'react';
import { Icon, Pill, useEscapeClose } from './atoms';
import type { ScoutPlayer, ScoutingEvent } from './scouting-data';
import type { ScoutMatch } from './scouting-matches';
import {
  oversOf,
  ballsPerWicket,
  roleOf,
  profileFor,
  teamName,
  playerLog,
  vsTeams,
  isOut,
  ballsFromOvers,
  performanceLine,
} from './scouting';

export const REC_TONE: Record<string, string> = {
  'Priority selection': 'teal',
  'Extended squad': 'gold',
  Monitor: 'muted',
};

/* ── Watch list (per browser for now; name|hub keys survive across events) ── */

const WATCH_KEY = 'scouting-watchlist';
export const watchKey = (p: Pick<ScoutPlayer, 'name' | 'hub'>) => `${p.name}|${p.hub}`;

function readWatch(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export interface Watchlist {
  keys: string[];
  has: (p: Pick<ScoutPlayer, 'name' | 'hub'>) => boolean;
  toggle: (p: Pick<ScoutPlayer, 'name' | 'hub'>) => void;
}

export function useWatchlist(): Watchlist {
  const [keys, setKeys] = useState<string[]>(readWatch);
  return {
    keys,
    has: (p) => keys.includes(watchKey(p)),
    toggle: (p) => {
      const k = watchKey(p);
      const next = keys.includes(k) ? keys.filter((x) => x !== k) : [...keys, k];
      setKeys(next);
      try {
        localStorage.setItem(WATCH_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable — the list still works for this visit */
      }
    },
  };
}

export function WatchButton({
  player,
  watch,
  compact,
}: {
  player: Pick<ScoutPlayer, 'name' | 'hub'>;
  watch: Watchlist;
  compact?: boolean;
}) {
  const on = watch.has(player);
  return (
    <button
      type="button"
      className={`sc-watch ${on ? 'on' : ''} ${compact ? 'compact' : ''}`}
      aria-pressed={on}
      title={on ? 'Remove from watch list' : 'Add to watch list'}
      onClick={(e) => {
        e.stopPropagation();
        watch.toggle(player);
      }}
    >
      <Icon.Eye />
      {!compact && <span>{on ? 'Watching' : 'Watch'}</span>}
    </button>
  );
}

const fmtShort = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** The selectors' watch list with each player's latest results pulled from scorecards. */
export function WatchlistCard({
  event,
  watch,
  openPlayer,
  openMatch,
}: {
  event: ScoutingEvent;
  watch: Watchlist;
  openPlayer: (p: ScoutPlayer) => void;
  openMatch: (m: ScoutMatch) => void;
}) {
  const watched = watch.keys
    .map((k) => event.players.find((p) => watchKey(p) === k))
    .filter(Boolean) as ScoutPlayer[];
  return (
    <div className="card sc-watchlist">
      <div className="card-head">
        <div>
          <div className="card-title">Watch list</div>
          <div className="card-sub">
            Results update automatically as each match's scorecard comes in · {watched.length}{' '}
            player{watched.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>
      {watched.length ? (
        <div className="sc-wl">
          {watched.map((p) => {
            const log = playerLog(event, p.name, p.hub);
            const latest = [...log].reverse().slice(0, 3);
            return (
              <div key={watchKey(p)} className="sc-wl-row">
                <div className="sc-wl-head">
                  <button type="button" className="sc-wl-name" onClick={() => openPlayer(p)}>
                    {p.name} <span className="sc-hub">{p.hub}</span>
                  </button>
                  <span className="sc-wl-season">
                    {p.runs ?? 0} runs · {p.wkts ?? 0} wkts · {p.m} matches
                  </span>
                  <WatchButton player={p} watch={watch} compact />
                </div>
                {latest.length ? (
                  <div className="sc-wl-games">
                    {latest.map((l) => (
                      <button
                        key={l.match.id}
                        type="button"
                        className="sc-wl-game"
                        onClick={() => openMatch(l.match)}
                      >
                        <span>
                          {fmtShort(l.match.date)} · v {l.opp}
                        </span>
                        <strong>{performanceLine(l)}</strong>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="sc-wl-none">No scorecard appearances yet.</div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="ss-empty">
          <Icon.Eye /> Tap <strong>Watch</strong> on any player to track their results here.
        </div>
      )}
    </div>
  );
}

/* ── Player panel ── */

type PTab = 'overview' | 'batting' | 'bowling' | 'fielding' | 'teams';

export function PlayerPanel({
  event,
  player,
  watch,
  onClose,
  openMatch,
}: {
  event: ScoutingEvent;
  player: ScoutPlayer;
  watch: Watchlist;
  onClose: () => void;
  openMatch: (m: ScoutMatch) => void;
}) {
  useEscapeClose(onClose);
  const [tab, setTab] = useState<PTab>('overview');
  const profiles = profileFor(event, player.name);
  const log = playerLog(event, player.name, player.hub);
  const teams = vsTeams(log);
  const bpw = ballsPerWicket(player);
  const batLog = log.filter((l) => l.bat);
  const bowlLog = log.filter((l) => l.bowl);
  const fieldLog = log.filter((l) => l.ct || l.st || l.ro);
  const stat = (label: string, value: string | number | null | undefined) => (
    <div className="sc-stat">
      <span>{label}</span>
      <strong>{value ?? '–'}</strong>
    </div>
  );
  const MatchCell = ({ m, opp }: { m: ScoutMatch; opp: string }) => (
    <button type="button" className="sc-link" onClick={() => openMatch(m)}>
      {fmtShort(m.date)} · {m.event} v {opp}
    </button>
  );

  return (
    <div className="sc-panel-scrim" onClick={onClose}>
      <aside
        className="sc-panel"
        role="dialog"
        aria-modal="true"
        aria-label={player.name}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sc-panel-head">
          <div>
            <div className="sc-panel-eyebrow">
              {teamName(event, player.hub)} · {roleOf(player).replace('squad', 'squad player')}
            </div>
            <div className="sc-panel-name">{player.name}</div>
          </div>
          <div className="sc-panel-actions">
            <WatchButton player={player} watch={watch} />
            <button type="button" className="sc-panel-close" onClick={onClose} aria-label="Close">
              <Icon.X />
            </button>
          </div>
        </div>

        <div className="sc-ptabs" role="tablist" aria-label="Player statistics">
          {(
            [
              ['overview', 'Overview'],
              ['batting', 'Batting'],
              ['bowling', 'Bowling'],
              ['fielding', 'Fielding'],
              ['teams', 'v Teams'],
            ] as [PTab, string][]
          ).map(([k, l]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              className={tab === k ? 'on' : ''}
              onClick={() => setTab(k)}
            >
              {l}
            </button>
          ))}
        </div>

        {tab === 'overview' && (
          <>
            {profiles.map((p) => (
              <div key={p.kind} className="sc-panel-profile">
                <div className="sc-short-top">
                  <span>
                    Shortlisted {p.kind} · #{p.rank}
                  </span>
                  <Pill tone={REC_TONE[p.recommendation] ?? 'muted'}>{p.recommendation}</Pill>
                </div>
                <div className="sc-index">
                  <span className="sc-bar-track">
                    <span className="sc-bar-fill" style={{ width: `${p.index}%` }} />
                  </span>
                  <strong>{p.index.toFixed(1)}</strong>
                </div>
                <div className="sc-short-role">{p.role}</div>
                <p className="sc-panel-next">
                  <strong>Next step:</strong> {p.nextStep}
                </p>
              </div>
            ))}
            <div className="sc-stats">
              {stat('Matches', player.m)}
              {stat('Runs', player.runs)}
              {stat('Wickets', player.wkts)}
              {stat('Strike rate', player.sr)}
              {stat('Economy', player.econ?.toFixed(2))}
              {stat('Catches', player.ct)}
            </div>
            <div className="sc-panel-sec">Match by match</div>
            {log.length ? (
              <div className="sc-mlog">
                {[...log].reverse().map((l) => (
                  <button
                    key={l.match.id}
                    type="button"
                    className="sc-mlog-row"
                    onClick={() => openMatch(l.match)}
                  >
                    <span>
                      {fmtShort(l.match.date)} · {l.match.event} v {l.opp}
                    </span>
                    <strong>{performanceLine(l)}</strong>
                  </button>
                ))}
              </div>
            ) : (
              <div className="sc-wl-none">No scorecard appearances recorded.</div>
            )}
          </>
        )}

        {tab === 'batting' && (
          <>
            <div className="sc-stats">
              {stat('Runs', player.runs)}
              {stat('Balls', player.balls)}
              {stat('High score', player.hs)}
              {stat('Average', player.avg?.toFixed(2))}
              {stat('Strike rate', player.sr)}
              {stat('4s / 6s', player.fours == null ? null : `${player.fours} / ${player.sixes}`)}
            </div>
            <div className="sc-panel-sec">Innings</div>
            {batLog.length ? (
              <div className="sc-scroll">
                <table className="sc-tbl compact">
                  <thead>
                    <tr>
                      <th>Match</th>
                      <th className="num">Pos</th>
                      <th className="num">R</th>
                      <th className="num">B</th>
                      <th className="num">4s/6s</th>
                      <th className="num">SR</th>
                      <th>How out</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batLog.map((l) => (
                      <tr key={l.match.id}>
                        <td>
                          <MatchCell m={l.match} opp={l.opp} />
                        </td>
                        <td className="num">{l.bat!.pos}</td>
                        <td className="num">
                          <strong>
                            {l.bat!.r}
                            {isOut(l.bat!) ? '' : '*'}
                          </strong>
                        </td>
                        <td className="num">{l.bat!.b}</td>
                        <td className="num">
                          {l.bat!.f4}/{l.bat!.f6}
                        </td>
                        <td className="num">
                          {l.bat!.b ? ((l.bat!.r / l.bat!.b) * 100).toFixed(0) : '–'}
                        </td>
                        <td className="sc-how">{l.bat!.out}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="sc-wl-none">Did not bat in a recorded scorecard.</div>
            )}
          </>
        )}

        {tab === 'bowling' && (
          <>
            <div className="sc-stats">
              {stat('Overs', oversOf(player.ballsBowled))}
              {stat('Wickets', player.wkts)}
              {stat('Economy', player.econ?.toFixed(2))}
              {stat('Best', player.best)}
              {stat('Balls / wkt', bpw ? bpw.toFixed(1) : null)}
              {stat('Runs conceded', player.runsConceded)}
            </div>
            <div className="sc-panel-sec">Spells</div>
            {bowlLog.length ? (
              <div className="sc-scroll">
                <table className="sc-tbl compact">
                  <thead>
                    <tr>
                      <th>Match</th>
                      <th className="num">O</th>
                      <th className="num">M</th>
                      <th className="num">R</th>
                      <th className="num">W</th>
                      <th className="num">Econ</th>
                      <th className="num">Dots</th>
                      <th className="num">Wd/Nb</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bowlLog.map((l) => {
                      const b = l.bowl!;
                      const balls = ballsFromOvers(b.o);
                      return (
                        <tr key={l.match.id}>
                          <td>
                            <MatchCell m={l.match} opp={l.opp} />
                          </td>
                          <td className="num">{b.o}</td>
                          <td className="num">{b.m}</td>
                          <td className="num">{b.r}</td>
                          <td className="num">
                            <strong>{b.w}</strong>
                          </td>
                          <td className="num">{balls ? ((b.r * 6) / balls).toFixed(2) : '–'}</td>
                          <td className="num">{b.dots}</td>
                          <td className="num">
                            {b.wd}/{b.nb}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="sc-wl-none">Did not bowl in a recorded scorecard.</div>
            )}
          </>
        )}

        {tab === 'fielding' && (
          <>
            <div className="sc-stats">
              {stat('Catches', player.ct)}
              {stat('Stumpings', player.st)}
              {stat('Run-outs', player.ro)}
            </div>
            <div className="sc-panel-sec">Dismissals by match</div>
            {fieldLog.length ? (
              <div className="sc-mlog">
                {fieldLog.map((l) => (
                  <button
                    key={l.match.id}
                    type="button"
                    className="sc-mlog-row"
                    onClick={() => openMatch(l.match)}
                  >
                    <span>
                      {fmtShort(l.match.date)} · {l.match.event} v {l.opp}
                    </span>
                    <strong>
                      {[l.ct && `${l.ct} ct`, l.st && `${l.st} st`, l.ro && `${l.ro} run-out`]
                        .filter(Boolean)
                        .join(' · ')}
                    </strong>
                  </button>
                ))}
              </div>
            ) : (
              <div className="sc-wl-none">No dismissals credited in recorded scorecards.</div>
            )}
            <p className="sc-note">
              Run-outs are credited per match only where the scorer named the fielder; the totals
              above come from the season register.
            </p>
          </>
        )}

        {tab === 'teams' && (
          <>
            <div className="sc-panel-sec">Record against each team</div>
            {teams.length ? (
              <div className="sc-scroll">
                <table className="sc-tbl compact">
                  <thead>
                    <tr>
                      <th>Opponent</th>
                      <th className="num">M</th>
                      <th className="num">Runs</th>
                      <th className="num">Avg</th>
                      <th className="num">SR</th>
                      <th className="num">Wkts</th>
                      <th className="num">Econ</th>
                      <th className="num">Dis.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teams.map((t) => (
                      <tr key={t.opp}>
                        <td>
                          <strong>{teamName(event, t.opp)}</strong>
                        </td>
                        <td className="num">{t.m}</td>
                        <td className="num">{t.inns ? t.runs : '–'}</td>
                        <td className="num">
                          {t.inns ? (t.outs ? (t.runs / t.outs).toFixed(1) : `${t.runs}*`) : '–'}
                        </td>
                        <td className="num">
                          {t.balls ? ((t.runs / t.balls) * 100).toFixed(0) : '–'}
                        </td>
                        <td className="num">{t.bb ? t.wkts : '–'}</td>
                        <td className="num">{t.bb ? ((t.conc * 6) / t.bb).toFixed(2) : '–'}</td>
                        <td className="num">{t.ct || '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="sc-wl-none">No scorecard appearances recorded.</div>
            )}
            <p className="sc-note">
              From recorded scorecards (group stage); play-offs not included.
            </p>
          </>
        )}
      </aside>
    </div>
  );
}
