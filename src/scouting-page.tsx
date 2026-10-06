/* ─── Admin Scouting: talent ID across leagues and tournaments ─── */

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icon, Pill, KPI } from './atoms';
import type { ScoutMatch } from './scouting-matches';
import { PlayerPanel, WatchlistCard, WatchButton, useWatchlist, REC_TONE } from './scouting-player';
import type { Watchlist } from './scouting-player';
import { MatchDashboard } from './scouting-match';
import { TeamDetail } from './scouting-team';
import { ProTeamPage } from './pro-team-page';
import { QuadrantMap, type MapPt, type Tone } from './pro-charts';
import { SCOUTING_EVENTS } from './scouting-data';
import type { ScoutPlayer, ScoutingEvent, ScoutProfile } from './scouting-data';
import {
  LEADERS,
  leaderDef,
  leaderboard,
  eventIndices,
  MIN_BALLS_FACED,
  MIN_BALLS_BOWLED,
  oversOf,
  roleOf,
  contribution,
  teamName,
  hubLeaders,
} from './scouting';
import type { LeaderMetric, PlayerRole } from './scouting';

type Tab = 'overview' | 'matches' | 'leaders' | 'map' | 'teams' | 'shortlist' | 'players';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'],
  ['matches', 'Matches'],
  ['leaders', 'Leaderboards'],
  ['map', 'Performance map'],
  ['teams', 'Teams'],
  ['shortlist', 'Shortlist'],
  ['players', 'Player register'],
];

const fmtRange = (e: ScoutingEvent) => {
  const f = new Date(e.dates.from + 'T00:00:00');
  const t = new Date(e.dates.to + 'T00:00:00');
  const d = (x: Date, o: Intl.DateTimeFormatOptions) => x.toLocaleDateString('en-GB', o);
  if (e.dates.from === e.dates.to) return d(f, { day: 'numeric', month: 'short', year: 'numeric' });
  return `${d(f, { day: 'numeric', month: 'short' })} – ${d(t, { day: 'numeric', month: 'short', year: 'numeric' })}`;
};

function HubTag({ code }: { code: string }) {
  return <span className="sc-hub">{code}</span>;
}

/* ── Matches table (rows open the match dashboard) ── */

function MatchesTable({
  event,
  openMatch,
}: {
  event: ScoutingEvent;
  openMatch: (m: ScoutMatch) => void;
}) {
  const score = (m: ScoutMatch, i: number) => {
    const s = (m.innings ?? m.summary ?? [])[i];
    return s ? `${s.bat} ${s.total}/${s.wkts} (${s.overs})` : i === 0 ? m.home : m.away;
  };
  return (
    <div className="sc-scroll">
      <table className="sc-tbl">
        <thead>
          <tr>
            <th>Date</th>
            <th>Event</th>
            <th>Stage</th>
            <th className="num">Ovs</th>
            <th>Batting first</th>
            <th>Chasing</th>
            <th>Result</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {event.matches.map((m) => (
            <tr key={m.id} className="clickable" onClick={() => openMatch(m)}>
              <td className="nowrap">
                {new Date(m.date + 'T00:00:00').toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                })}
              </td>
              <td>{m.event}</td>
              <td>{m.stage}</td>
              <td className="num">{m.overs}</td>
              <td className="nowrap">{score(m, 0)}</td>
              <td className="nowrap">{score(m, 1)}</td>
              <td className="nowrap">
                <strong>{m.result}</strong>
              </td>
              <td className="nowrap sc-open">
                {m.innings ? 'Dashboard' : 'Summary'} <Icon.Arrow />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Overview ── */

function Overview({
  event,
  openPlayer,
  openMatch,
}: {
  event: ScoutingEvent;
  openPlayer: (p: ScoutPlayer) => void;
  openMatch: (m: ScoutMatch) => void;
}) {
  const t = event.totals;
  const topRuns = leaderboard(event.players, 'runs', '', 1)[0];
  const topWk = leaderboard(event.players, 'wkts', '', 1)[0];
  const topSr = leaderboard(event.players, 'sr', '', 1)[0];
  const topEcon = leaderboard(event.players, 'econ', '', 1)[0];
  // Tournaments carry a league table; a one-off match review doesn't.
  const standings = event.teams
    .filter((t) => t.fiftyOver)
    .sort((a, b) => a.fiftyOver!.pos - b.fiftyOver!.pos);
  const callouts = [
    { label: 'Leading run-scorer', r: topRuns, v: `${topRuns?.value} runs` },
    { label: 'Leading wicket-taker', r: topWk, v: `${topWk?.value} wickets` },
    { label: 'Fastest scorer', r: topSr, v: `SR ${topSr?.value.toFixed(1)}` },
    { label: 'Most economical', r: topEcon, v: `${topEcon?.value.toFixed(2)} rpo` },
  ].filter((c) => c.r);

  return (
    <>
      <div className="kpi-strip sc-kpis">
        <KPI label="Matches" num={t.matches} sub={event.competitions.join(' · ')} />
        <KPI label="Players" num={t.players} sub={`${t.hubs} teams`} />
        <KPI
          label="Runs"
          num={t.runs.toLocaleString('en-GB')}
          sub={`${t.runRate.toFixed(2)} per over`}
        />
        <KPI label="Wickets" num={t.wickets} sub={`${t.dotPct}% dot balls`} />
        <KPI
          label="Extras"
          num={t.extras}
          sub={`${Math.round((t.extras / t.runs) * 100)}% of all runs`}
          tone="warn"
        />
      </div>

      <div className="sc-callouts">
        {callouts.map((c) => (
          <button
            key={c.label}
            type="button"
            className="sc-callout"
            onClick={() => openPlayer(c.r!.player)}
          >
            <span className="sc-callout-l">{c.label}</span>
            <span className="sc-callout-name">{c.r!.player.name}</span>
            <span className="sc-callout-v">
              {c.v} · <HubTag code={c.r!.player.hub} />
            </span>
          </button>
        ))}
      </div>

      {standings.length > 0 && (
        <div className="sc-two">
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">50-Over standings</div>
                <div className="card-sub">Round robin · net run rate</div>
              </div>
            </div>
            <div className="sc-scroll">
              <table className="sc-tbl">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Team</th>
                    <th className="num">P</th>
                    <th className="num">W</th>
                    <th className="num">L</th>
                    <th className="num">Pts</th>
                    <th className="num">NRR</th>
                    <th>T20</th>
                  </tr>
                </thead>
                <tbody>
                  {standings.map((tm) => (
                    <tr key={tm.code}>
                      <td>{tm.fiftyOver!.pos}</td>
                      <td>
                        <strong>{tm.name}</strong> <HubTag code={tm.code} />
                      </td>
                      <td className="num">{tm.fiftyOver!.p}</td>
                      <td className="num">{tm.fiftyOver!.w}</td>
                      <td className="num">{tm.fiftyOver!.l}</td>
                      <td className="num">
                        <strong>{tm.fiftyOver!.pts}</strong>
                      </td>
                      <td className="num">{tm.fiftyOver!.nrr}</td>
                      <td>{tm.t20Placing}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="sc-foot">
              Champions:{' '}
              {event.champions.map((c, i) => (
                <span key={c.competition}>
                  {i > 0 && ' · '}
                  {c.competition} — <strong>{teamName(event, c.team)}</strong>
                </span>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">The two competitions</div>
                <div className="card-sub">Side by side</div>
              </div>
            </div>
            <div className="sc-scroll">
              <table className="sc-tbl">
                <thead>
                  <tr>
                    <th>Measure</th>
                    {event.byCompetition.map((c) => (
                      <th key={c.label} className="num">
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['Matches', (c) => c.matches],
                      ['Players used', (c) => c.players],
                      ['Runs', (c) => c.runs.toLocaleString('en-GB')],
                      ['Wickets', (c) => c.wickets],
                      ['Run rate', (c) => c.runRate.toFixed(2)],
                      ['Dot balls', (c) => `${c.dotPct}%`],
                      ['Extras (% of runs)', (c) => `${c.extrasPct}%`],
                    ] as [string, (c: ScoutingEvent['byCompetition'][number]) => string | number][]
                  ).map(([label, get]) => (
                    <tr key={label}>
                      <td>{label}</td>
                      {event.byCompetition.map((c) => (
                        <td key={c.label} className="num">
                          {get(c)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Results</div>
            <div className="card-sub">
              {event.matches.length} fixtures · {event.venue} · tap a match for its dashboard
            </div>
          </div>
        </div>
        <MatchesTable event={event} openMatch={openMatch} />
      </div>
    </>
  );
}

/* ── Leaderboards (one-hue horizontal bars, direct value labels) ── */

function Leaderboards({
  event,
  shortlisted,
  openPlayer,
}: {
  event: ScoutingEvent;
  shortlisted: Set<string>;
  openPlayer: (p: ScoutPlayer) => void;
}) {
  const [metric, setMetric] = useState<LeaderMetric>('runs');
  const [hub, setHub] = useState('');
  const def = leaderDef(metric);
  const rows = leaderboard(event.players, metric, hub, 15);
  // Bars share one scale from the largest value shown (for economy the best is shortest).
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;

  return (
    <div className="card">
      <div className="sc-filters">
        <div className="sc-chips" role="tablist" aria-label="Leaderboard">
          {LEADERS.map((l) => (
            <button
              key={l.key}
              type="button"
              role="tab"
              aria-selected={metric === l.key}
              className={`sc-chip ${metric === l.key ? 'on' : ''}`}
              onClick={() => setMetric(l.key)}
            >
              {l.label}
            </button>
          ))}
        </div>
        <select
          className="field-select sc-select"
          value={hub}
          onChange={(e) => setHub(e.target.value)}
        >
          <option value="">All teams</option>
          {event.teams.map((t) => (
            <option key={t.code} value={t.code}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div className="sc-board-note">
        {def.note}
        {shortlisted.size > 0 && (
          <>
            {' '}
            · <Icon.Star /> on the scouting shortlist
          </>
        )}
      </div>
      {rows.length ? (
        <ol className="sc-bars">
          {rows.map((r, i) => (
            <li key={r.player.name}>
              <button
                type="button"
                className="sc-bar-row"
                onClick={() => openPlayer(r.player)}
                title={`${r.player.name} (${teamName(event, r.player.hub)}) — ${def.label}: ${def.format(r.value)}`}
              >
                <span className="sc-bar-rank">{i + 1}</span>
                <span className="sc-bar-name">
                  {r.player.name}
                  {shortlisted.has(r.player.name) && (
                    <span className="sc-star" aria-label="Shortlisted">
                      <Icon.Star />
                    </span>
                  )}
                  <HubTag code={r.player.hub} />
                </span>
                <span className="sc-bar-track">
                  <span className="sc-bar-fill" style={{ width: `${(r.value / max) * 100}%` }} />
                </span>
                <span className="sc-bar-val">{def.format(r.value)}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <div className="ss-empty">No qualifying players for this team.</div>
      )}
    </div>
  );
}

/* ── Performance map (index quadrants, after the national scouting report) ── */

function PerformanceMap({
  event,
  watch,
  openPlayer,
}: {
  event: ScoutingEvent;
  watch: Watchlist;
  openPlayer: (p: ScoutPlayer) => void;
}) {
  const [hub, setHub] = useState('');
  const rows = useMemo(() => eventIndices(event.players), [event]);
  const byId = new Map(rows.map((r) => [`${r.player.name}|${r.player.hub}`, r.player]));
  const pick = (id: string) => {
    const p = byId.get(id);
    if (p) openPlayer(p);
  };
  // Three colours at most on a map: the highlighted team, the watchlist, everyone else.
  const tone = (p: ScoutPlayer): Tone =>
    watch.has(p) ? 'pool' : hub ? (p.hub === hub ? 'squad' : 'context') : 'squad';
  const label = (p: ScoutPlayer) => `${p.name}`;
  const pinned = (p: ScoutPlayer, rank: number) => watch.has(p) || (hub ? p.hub === hub : rank < 8);
  const bats = rows.filter((r) => r.qualifiesBat && r.bat).sort((a, b) => b.bat!.idx - a.bat!.idx);
  const bowls = rows
    .filter((r) => r.qualifiesBowl && r.bowl)
    .sort((a, b) => b.bowl!.idx - a.bowl!.idx);
  const ars = rows
    .filter((r) => r.qualifiesBat && r.qualifiesBowl && r.bat && r.bowl)
    .sort((a, b) => Math.sqrt(b.bat!.idx * b.bowl!.idx) - Math.sqrt(a.bat!.idx * a.bowl!.idx));
  const sub = (p: ScoutPlayer) => `${teamName(event, p.hub)}`;
  const legend = {
    squad: hub ? teamName(event, hub) : 'Players',
    context: 'Other teams',
    pool: 'Your watchlist',
  };
  const batPts: MapPt[] = bats.map((r, i) => ({
    id: `${r.player.name}|${r.player.hub}`,
    label: label(r.player),
    sub: sub(r.player),
    x: r.bat!.srIdx,
    y: r.bat!.rpiIdx,
    size: r.player.balls ?? 0,
    tone: tone(r.player),
    pin: pinned(r.player, i),
    tip: [
      `${r.player.runs} runs off ${r.player.balls} · SR ${r.player.sr?.toFixed(0)}`,
      `Batting index ${Math.round(r.bat!.idx)}`,
    ],
  }));
  const bowlPts: MapPt[] = bowls.map((r, i) => ({
    id: `${r.player.name}|${r.player.hub}`,
    label: label(r.player),
    sub: sub(r.player),
    x: r.bowl!.econIdx,
    y: r.bowl!.wktIdx,
    size: r.player.ballsBowled ?? 0,
    tone: tone(r.player),
    pin: pinned(r.player, i),
    tip: [
      `${r.player.wkts ?? 0} wkts in ${oversOf(r.player.ballsBowled)} ov · econ ${r.player.econ?.toFixed(1)}`,
      `Bowling index ${Math.round(r.bowl!.idx)}`,
    ],
  }));
  const arPts: MapPt[] = ars.map((r, i) => ({
    id: `${r.player.name}|${r.player.hub}`,
    label: label(r.player),
    sub: sub(r.player),
    x: r.bat!.idx,
    y: r.bowl!.idx,
    size: (r.player.balls ?? 0) + (r.player.ballsBowled ?? 0),
    tone: tone(r.player),
    pin: pinned(r.player, i),
    tip: [`All-rounder index ${Math.round(Math.sqrt(r.bat!.idx * r.bowl!.idx))}`],
  }));

  return (
    <>
      <div className="sc-filters">
        <div className="sc-board-note">
          Every axis is an index: 100 = this competition's average · top-right is better on both ·
          bubble size = balls · gold = your watchlist · tap a bubble for the player
        </div>
        <select
          className="field-select sc-select"
          value={hub}
          onChange={(e) => setHub(e.target.value)}
          aria-label="Highlight a team"
        >
          <option value="">All teams</option>
          {event.teams.map((t) => (
            <option key={t.code} value={t.code}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div className="sc-two">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Batters: how fast, how many</div>
              <div className="card-sub">
                {batPts.length} batters with {MIN_BALLS_FACED}+ balls faced
              </div>
            </div>
          </div>
          <div className="card-body">
            <QuadrantMap
              points={batPts}
              xLabel="Strike-rate index"
              yLabel="Runs-per-innings index"
              quadrants={['Fast and heavy', 'Heavy, slower', 'Quick cameos', 'Below on both']}
              sizeLabel="balls faced"
              onPick={pick}
              toneLabels={legend}
            />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Bowlers: control v wickets</div>
              <div className="card-sub">
                {bowlPts.length} bowlers with {MIN_BALLS_BOWLED / 6}+ overs · right = cheaper
              </div>
            </div>
          </div>
          <div className="card-body">
            <QuadrantMap
              points={bowlPts}
              xLabel="Economy index (higher = cheaper)"
              yLabel="Wicket-rate index"
              quadrants={[
                'Better on both',
                'Wicket-takers, expensive',
                'Tight, few wickets',
                'Below on both',
              ]}
              sizeLabel="balls bowled"
              onPick={pick}
              toneLabels={legend}
            />
          </div>
        </div>
      </div>
      {arPts.length >= 3 && (
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">All-rounders: batting v bowling</div>
              <div className="card-sub">{arPts.length} players qualifying with bat and ball</div>
            </div>
          </div>
          <div className="card-body">
            <QuadrantMap
              points={arPts}
              xLabel="Batting index"
              yLabel="Bowling index"
              quadrants={['Better on both', 'Bowling first', 'Batting first', 'Below on both']}
              sizeLabel="balls faced + bowled"
              onPick={pick}
              toneLabels={legend}
            />
          </div>
        </div>
      )}
    </>
  );
}

/* ── Teams ── */

function Teams({ event, openTeam }: { event: ScoutingEvent; openTeam: (code: string) => void }) {
  const maxRate = Math.max(...event.teams.flatMap((t) => [t.runRate, t.concededRate]));
  const teams = [...event.teams].sort(
    (a, b) => (a.fiftyOver?.pos ?? 99) - (b.fiftyOver?.pos ?? 99) || b.won - a.won,
  );
  return (
    <div className="sc-teams">
      {teams.map((t) => {
        const lead = hubLeaders(event, t.code);
        return (
          <button
            key={t.code}
            type="button"
            className="card sc-team sc-team-btn"
            onClick={() => openTeam(t.code)}
          >
            <div className="sc-team-head">
              <div>
                <div className="sc-team-name">
                  {t.name} <HubTag code={t.code} />
                </div>
                <div className="sc-team-sub">{t.placing}</div>
              </div>
              <div className="sc-team-wl">
                <strong>
                  {t.won}–{t.lost}
                </strong>
                <span>W–L</span>
              </div>
            </div>
            <div className="sc-rates">
              {(
                [
                  ['Scored', t.runRate, `${t.runsScored} runs`],
                  ['Conceded', t.concededRate, `${t.runsConceded} runs`],
                ] as [string, number, string][]
              ).map(([label, rate, sub]) => (
                <div key={label} className="sc-rate">
                  <span className="sc-rate-l">{label}</span>
                  <span className="sc-bar-track">
                    <span
                      className={`sc-bar-fill ${label === 'Conceded' ? 'muted' : ''}`}
                      style={{ width: `${(rate / maxRate) * 100}%` }}
                    />
                  </span>
                  <span className="sc-rate-v">
                    {rate.toFixed(2)} <em>rpo · {sub}</em>
                  </span>
                </div>
              ))}
            </div>
            <div className="sc-team-stats">
              <div>
                <span>Wickets</span>
                <strong>{t.wickets}</strong>
              </div>
              <div>
                <span>Extras / 10 ov</span>
                <strong>{t.discipline.extrasPer10}</strong>
              </div>
              <div>
                <span>Squad</span>
                <strong>{lead.squad}</strong>
              </div>
            </div>
            <div className="sc-team-leaders">
              {lead.topBat && (
                <div>
                  <span>Top bat</span> {lead.topBat.player.name} · {lead.topBat.value}
                </div>
              )}
              {lead.topBowl && (
                <div>
                  <span>Top ball</span> {lead.topBowl.player.name} · {lead.topBowl.value} wkts
                </div>
              )}
            </div>
            <span className="sc-team-toggle">
              View team <Icon.Arrow />
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ── Shortlist ── */

function Shortlist({
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
  const byName = (n: string) => event.players.find((p) => p.name === n);
  const groups: [string, ScoutProfile[]][] = [
    ['Batters', event.profiles.filter((p) => p.kind === 'batter')],
    ['Bowlers', event.profiles.filter((p) => p.kind === 'bowler')],
  ];
  if (!event.profiles.length)
    return (
      <>
        <WatchlistCard event={event} watch={watch} openPlayer={openPlayer} openMatch={openMatch} />
        <div className="card">
          <div className="ss-empty">
            No scouting shortlist has been published for {event.name} yet — use the watch list to
            track players.
          </div>
        </div>
      </>
    );
  return (
    <>
      <WatchlistCard event={event} watch={watch} openPlayer={openPlayer} openMatch={openMatch} />
      <div className="sc-board-note">
        Scout index (0–100) and recommendations from the group-stage scouting report. Add any player
        to the watch list to track their results.
      </div>
      <div className="sc-two">
        {groups.map(([title, list]) => (
          <div key={title} className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Top 5 {title.toLowerCase()}</div>
                <div className="card-sub">Ranked by scout index</div>
              </div>
            </div>
            <div className="sc-short">
              {list.map((p) => {
                const pl = byName(p.name);
                return (
                  <div
                    key={p.name}
                    role="button"
                    tabIndex={0}
                    className="sc-short-row"
                    onClick={() => pl && openPlayer(pl)}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && pl) {
                        e.preventDefault();
                        openPlayer(pl);
                      }
                    }}
                  >
                    <div className="sc-short-top">
                      <span className="sc-short-name">
                        {p.name} <HubTag code={p.hub} />
                      </span>
                      <span className="sc-short-actions">
                        <Pill tone={REC_TONE[p.recommendation] ?? 'muted'}>{p.recommendation}</Pill>
                        <WatchButton player={{ name: p.name, hub: p.hub }} watch={watch} />
                      </span>
                    </div>
                    <div className="sc-short-role">{p.role}</div>
                    <div className="sc-index">
                      <span className="sc-bar-track">
                        <span className="sc-bar-fill" style={{ width: `${p.index}%` }} />
                      </span>
                      <strong>{p.index.toFixed(1)}</strong>
                    </div>
                    <div className="sc-short-next">{p.nextStep}</div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ── Player register ── */

type SortKey = 'contribution' | 'runs' | 'wkts' | 'sr' | 'econ' | 'name';
const ROLES: [PlayerRole | '', string][] = [
  ['', 'All roles'],
  ['batter', 'Batters'],
  ['bowler', 'Bowlers'],
  ['all-rounder', 'All-rounders'],
];

function Register({
  event,
  shortlisted,
  watch,
  openPlayer,
}: {
  event: ScoutingEvent;
  shortlisted: Set<string>;
  watch: Watchlist;
  openPlayer: (p: ScoutPlayer) => void;
}) {
  const [q, setQ] = useState('');
  const [watchOnly, setWatchOnly] = useState(false);
  const [hub, setHub] = useState('');
  const [role, setRole] = useState<PlayerRole | ''>('');
  const [sort, setSort] = useState<SortKey>('contribution');
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const val = (p: ScoutPlayer) =>
      sort === 'contribution'
        ? contribution(p)
        : sort === 'econ'
          ? -(p.econ ?? 99)
          : sort === 'name'
            ? 0
            : ((p[sort] as number | null) ?? -1);
    return event.players
      .filter(
        (p) =>
          (!needle || p.name.toLowerCase().includes(needle)) &&
          (!hub || p.hub === hub) &&
          (!role || roleOf(p) === role) &&
          (!watchOnly || watch.has(p)),
      )
      .sort((a, b) =>
        sort === 'name'
          ? a.name.localeCompare(b.name)
          : val(b) - val(a) || a.name.localeCompare(b.name),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, q, hub, role, sort, watchOnly, watch.keys]);

  const th = (key: SortKey, label: string, num = true) => (
    <th className={num ? 'num' : ''}>
      <button
        type="button"
        className={`sc-sort ${sort === key ? 'on' : ''}`}
        onClick={() => setSort(key)}
        aria-pressed={sort === key}
      >
        {label}
      </button>
    </th>
  );

  return (
    <div className="card">
      <div className="sc-filters">
        <input
          className="field-input sc-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search players"
          aria-label="Search players"
        />
        <select
          className="field-select sc-select"
          value={hub}
          onChange={(e) => setHub(e.target.value)}
        >
          <option value="">All teams</option>
          {event.teams.map((t) => (
            <option key={t.code} value={t.code}>
              {t.name}
            </option>
          ))}
        </select>
        <select
          className="field-select sc-select"
          value={role}
          onChange={(e) => setRole(e.target.value as PlayerRole | '')}
        >
          {ROLES.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <label className="rp-check sc-watch-filter">
          <input
            type="checkbox"
            checked={watchOnly}
            onChange={(e) => setWatchOnly(e.target.checked)}
          />
          Watch list only
        </label>
      </div>
      <div className="sc-board-note">
        {rows.length} of {event.players.length} players · sorted by{' '}
        {sort === 'contribution' ? 'runs + 20 per wicket' : sort}
      </div>
      <div className="sc-scroll">
        <table className="sc-tbl sc-register">
          <thead>
            <tr>
              {th('name', 'Player', false)}
              <th>Team</th>
              <th className="num">M</th>
              {th('runs', 'Runs')}
              <th className="num">Avg</th>
              {th('sr', 'SR')}
              <th className="num">Overs</th>
              {th('wkts', 'Wkts')}
              {th('econ', 'Econ')}
              <th className="num">Best</th>
              <th className="num">Ct/St/RO</th>
              <th className="num">Watch</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.name} className="clickable" onClick={() => openPlayer(p)}>
                <td>
                  <strong>{p.name}</strong>
                  {shortlisted.has(p.name) && (
                    <span className="sc-star" aria-label="Shortlisted">
                      <Icon.Star />
                    </span>
                  )}
                </td>
                <td>
                  <HubTag code={p.hub} />
                </td>
                <td className="num">{p.m}</td>
                <td className="num">{p.runs ?? '–'}</td>
                <td className="num">{p.avg?.toFixed(2) ?? '–'}</td>
                <td className="num">{p.sr ?? '–'}</td>
                <td className="num">{oversOf(p.ballsBowled)}</td>
                <td className="num">{p.wkts ?? '–'}</td>
                <td className="num">{p.econ?.toFixed(2) ?? '–'}</td>
                <td className="num">{p.best ?? '–'}</td>
                <td className="num">{p.ct == null ? '–' : `${p.ct}/${p.st}/${p.ro}`}</td>
                <td className="num">
                  <WatchButton player={p} watch={watch} compact />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Page ── */

export function AdminScoutingPage({ orgName }: { orgName: string }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [player, setPlayer] = useState<ScoutPlayer | null>(null);
  const watch = useWatchlist();

  // Competition and drill-downs live in the URL (?event=…&team=RHO / &match=<id>) so they
  // can be shared and the browser's Back button returns to the list.
  const [params, setParams] = useSearchParams();
  const eventId = params.get('event') ?? SCOUTING_EVENTS[0]?.id ?? '';
  const event = SCOUTING_EVENTS.find((e) => e.id === eventId);
  const shortlisted = useMemo(() => new Set((event?.profiles ?? []).map((p) => p.name)), [event]);
  const teamCode = params.get('team');
  const matchId = params.get('match');
  const match = matchId ? event?.matches.find((m) => m.id === matchId) : undefined;
  const openTeam = (code: string) => {
    setParams({ event: eventId, team: code });
    window.scrollTo({ top: 0 });
  };
  const openMatch = (m: ScoutMatch) => {
    setPlayer(null);
    setParams({ event: eventId, match: m.id });
    window.scrollTo({ top: 0 });
  };
  const back = () => window.history.back();
  // Player scouting (competitions) or the professional team built on it (?view=pro).
  const view = params.get('view') === 'pro' ? 'pro' : 'scouting';
  const pickView = (v: 'pro' | 'scouting') => setParams(v === 'pro' ? { view: 'pro' } : {});

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">{orgName} · Talent identification</div>
          <h1 className="ph-title">
            {view === 'pro' ? (
              <>
                Professional <em>Team</em>
              </>
            ) : (
              <>
                Player <em>Scouting</em>
              </>
            )}
          </h1>
          <p className="ph-desc">
            {view === 'pro'
              ? 'The franchise squads from their scorecards — who to promote, who is at risk, the squad and team pictures, and call-ups from the scouting pools.'
              : 'Performance across leagues and tournaments — leaderboards, performance maps, team profiles and the selection shortlist.'}
          </p>
        </div>
        {view === 'scouting' && (
          <div className="ph-actions sc-event">
            <label className="field-label" htmlFor="sc-event">
              Competition
            </label>
            <select
              id="sc-event"
              className="field-select sc-select"
              value={eventId}
              onChange={(e) => {
                setParams({ event: e.target.value });
                setTab('overview');
              }}
            >
              {SCOUTING_EVENTS.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="pro-switch" role="tablist" aria-label="Scouting area">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'scouting'}
          className={view === 'scouting' ? 'on' : ''}
          onClick={() => pickView('scouting')}
        >
          Player scouting
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'pro'}
          className={view === 'pro' ? 'on' : ''}
          onClick={() => pickView('pro')}
        >
          Professional team
        </button>
      </div>

      {view === 'pro' ? (
        <ProTeamPage />
      ) : !event ? (
        <div className="ss-empty">No scouting data yet.</div>
      ) : (
        <>
          <div className="sc-eventbar">
            <span>
              <Icon.Field /> {event.venue} · {fmtRange(event)}
            </span>
            <span>{event.source}</span>
            <Pill tone="muted">Confidential · selection use</Pill>
          </div>

          {match ? (
            <MatchDashboard
              event={event}
              match={match}
              watch={watch}
              onBack={back}
              openPlayer={setPlayer}
            />
          ) : teamCode ? (
            <TeamDetail
              event={event}
              code={teamCode}
              watch={watch}
              onBack={back}
              openPlayer={setPlayer}
              openMatch={openMatch}
            />
          ) : (
            <>
              <div className="sc-tabs" role="tablist" aria-label="Scouting views">
                {TABS.map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={tab === k}
                    className={tab === k ? 'on' : ''}
                    onClick={() => setTab(k)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="sc-body">
                {tab === 'overview' && (
                  <Overview event={event} openPlayer={setPlayer} openMatch={openMatch} />
                )}
                {tab === 'matches' && (
                  <div className="card">
                    <div className="card-head">
                      <div>
                        <div className="card-title">Fixtures & results</div>
                        <div className="card-sub">
                          Tap a match to open its dashboard — match flow, batting, bowling and
                          standouts
                        </div>
                      </div>
                    </div>
                    <MatchesTable event={event} openMatch={openMatch} />
                  </div>
                )}
                {tab === 'leaders' && (
                  <Leaderboards event={event} shortlisted={shortlisted} openPlayer={setPlayer} />
                )}
                {tab === 'map' && (
                  <PerformanceMap event={event} watch={watch} openPlayer={setPlayer} />
                )}
                {tab === 'teams' && <Teams event={event} openTeam={openTeam} />}
                {tab === 'shortlist' && (
                  <Shortlist
                    event={event}
                    watch={watch}
                    openPlayer={setPlayer}
                    openMatch={openMatch}
                  />
                )}
                {tab === 'players' && (
                  <Register
                    event={event}
                    shortlisted={shortlisted}
                    watch={watch}
                    openPlayer={setPlayer}
                  />
                )}
              </div>
            </>
          )}

          {player && (
            <PlayerPanel
              event={event}
              player={player}
              watch={watch}
              onClose={() => setPlayer(null)}
              openMatch={openMatch}
            />
          )}
        </>
      )}
    </div>
  );
}
