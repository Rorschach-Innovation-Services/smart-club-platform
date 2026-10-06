/* ─── Scouting → Professional team ───
 *
 * The franchise's own squads (men and women) from their scorecards: who to promote, who is at
 * risk, the squad and team pictures, and call-ups from the scouting pools — players the
 * scouting system already rates, which the professional staff can track and call up.
 */
import { Fragment, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icon, Pill } from './atoms';
import { PRO_IS_SAMPLE, PRO_MATCHES, SCOUT_POOLS } from './pro-data';
import {
  PRO_FORMATS,
  oversToBalls,
  seasonOf,
  shortTeam,
  type ProFormat,
  type ProMatch,
} from './pro-scorecards';
import {
  baselines,
  detectSquads,
  filterMatches,
  isUs,
  orderContribution,
  seasonsOf,
  squadPlayers,
  teamComparisons,
  teamSummary,
  wicketsByPhase,
  RECENT,
  batSplits,
  bowlSplits,
  scoreBands,
  wicketBands,
  type Baseline,
  type ProFilter,
  type ProPlayer,
  type ProRole,
  type SignalKind,
  type Squad,
} from './pro-team';
import {
  BallUseBars,
  FormColumns,
  IndexMeter,
  PairBars,
  QuadrantMap,
  RankBars,
  ResultStrip,
  ShareRows,
  Spark,
  Tile,
  shortName,
  type MapPt,
  type Tone,
} from './pro-charts';
import { SCOUTING_EVENTS } from './scouting-data';
import type { ScoutPlayer } from './scouting-data';
import { useWatchlist, watchKey } from './scouting-player';
import type { PoolPlayer, PoolRole } from './scout-pool';
import { DISMISSAL_KINDS } from './scouting';

type ProTab = 'selection' | 'squad' | 'form' | 'team' | 'callups' | 'matches';
const PRO_TABS: [ProTab, string][] = [
  ['selection', 'Selection'],
  ['squad', 'Squad'],
  ['form', 'Form'],
  ['team', 'Team'],
  ['callups', 'Call-ups'],
  ['matches', 'Matches'],
];

const r0 = (v: number | null | undefined) =>
  v === null || v === undefined ? '–' : Math.round(v).toString();
const r1 = (v: number | null | undefined) =>
  v === null || v === undefined ? '–' : (Math.round(v * 10) / 10).toFixed(1);
const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });
const overs = (balls: number) => `${Math.floor(balls / 6)}${balls % 6 ? `.${balls % 6}` : ''}`;

/* ── Tracking (per browser, like the scouting watchlist) ── */

type TrackStatus = 'tracked' | 'called-up';
const TRACK_KEY = 'smartclub.pro.tracking.v1';
function readTrack(): Record<string, { status: TrackStatus; at: string }> {
  try {
    return JSON.parse(localStorage.getItem(TRACK_KEY) || '{}') ?? {};
  } catch {
    return {};
  }
}
function useTracking() {
  const [map, setMap] = useState(readTrack);
  const save = (next: typeof map) => {
    setMap(next);
    try {
      localStorage.setItem(TRACK_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable — kept for this visit */
    }
  };
  return {
    map,
    status: (key: string) => map[key]?.status ?? null,
    set: (key: string, status: TrackStatus | null) => {
      const next = { ...map };
      if (status) next[key] = { status, at: new Date().toISOString() };
      else delete next[key];
      save(next);
    },
  };
}
type Tracking = ReturnType<typeof useTracking>;

/* ── Candidates: the scouting pools plus senior players on the scouting watchlist ── */

interface Candidate {
  key: string;
  name: string;
  club: string;
  union: string;
  role: PoolRole;
  source: string;
  batIdx: number | null;
  bowlIdx: number | null;
  impact: number | null;
  lists: string[];
  note?: string;
  line: string;
  watched?: boolean;
}

const roleIndex = (c: Pick<Candidate, 'role' | 'batIdx' | 'bowlIdx'>) =>
  c.role === 'Bowler'
    ? c.bowlIdx
    : c.role === 'All-rounder'
      ? c.batIdx && c.bowlIdx
        ? Math.sqrt(c.batIdx * c.bowlIdx)
        : (c.batIdx ?? c.bowlIdx)
      : c.batIdx;

function poolCandidates(gender: Squad['gender']): Candidate[] {
  return SCOUT_POOLS.filter((p) => p.gender === gender).flatMap((pool) =>
    pool.players.map((p: PoolPlayer) => ({
      key: `${p.name}|${p.club}`,
      name: p.name,
      club: p.club,
      union: p.union,
      role: p.role,
      source: pool.name,
      batIdx: p.bat?.batIdx ?? null,
      bowlIdx: p.bowl?.bowlIdx ?? null,
      impact: p.impact ?? null,
      lists: p.lists,
      note: p.note,
      line: [
        p.bat ? `${p.bat.runs} runs (${p.bat.balls}b) · SR ${Math.round(p.bat.sr)}` : '',
        p.bowl ? `${p.bowl.wkts}/${p.bowl.runs} in ${p.bowl.overs} ov · econ ${p.bowl.econ}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    })),
  );
}

/** Senior scouting-event players on the watchlist, rated against their own event. */
function watchedCandidates(keys: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const ev of SCOUTING_EVENTS) {
    if (/^u\s?\d+/i.test(ev.ageGroup)) continue;
    const ps = ev.players;
    const tot = (f: (p: ScoutPlayer) => number | null) => ps.reduce((n, p) => n + (f(p) ?? 0), 0);
    const evSR =
      (tot((p) => p.runs) /
        Math.max(
          1,
          tot((p) => p.balls),
        )) *
      100;
    const evRPM = tot((p) => p.runs) / Math.max(1, ps.filter((p) => (p.balls ?? 0) > 0).length);
    const evEcon =
      (tot((p) => p.runsConceded) /
        Math.max(
          1,
          tot((p) => p.ballsBowled),
        )) *
      6;
    const evBPW =
      tot((p) => p.ballsBowled) /
      Math.max(
        1,
        tot((p) => p.wkts),
      );
    for (const p of ps) {
      if (!keys.includes(watchKey(p))) continue;
      const bat =
        p.balls && p.runs !== null
          ? Math.sqrt((p.runs / Math.max(1, p.m) / evRPM) * (((p.runs / p.balls) * 100) / evSR)) *
            100
          : null;
      const bowl =
        p.ballsBowled && p.runsConceded !== null
          ? Math.sqrt(
              (evEcon / Math.max(0.1, (p.runsConceded / p.ballsBowled) * 6)) *
                ((((p.wkts ?? 0) + 0.5) / p.ballsBowled) * evBPW),
            ) * 100
          : null;
      const role: PoolRole = bat && bowl ? 'All-rounder' : bowl ? 'Bowler' : 'Batter';
      out.push({
        key: `${p.name}|${p.hub}`,
        name: p.name,
        club: p.hub,
        union: '',
        role,
        source: ev.name,
        batIdx: bat,
        bowlIdx: bowl,
        impact: null,
        lists: ['Scouting watchlist'],
        line: [
          p.runs !== null ? `${p.runs} runs (${p.balls}b)` : '',
          p.wkts ? `${p.wkts} wkts · econ ${r1(p.econ)}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
        watched: true,
      });
    }
  }
  return out;
}

/* ── The page ── */

export function ProTeamPage() {
  const [params, setParams] = useSearchParams();
  const squads = useMemo(() => detectSquads(PRO_MATCHES), []);
  const gender = (params.get('squad') as Squad['gender']) || squads[0]?.gender || 'men';
  const squad = squads.find((s) => s.gender === gender) ?? squads[0];
  const tab = (params.get('ptab') as ProTab) || 'selection';
  // Default to T20 where the squad plays it: rates only compare within a format.
  const format =
    (params.get('format') as ProFormat | 'all') ||
    (squad?.matches.some((m) => m.format === 'T20') ? 'T20' : 'all');
  const season = params.get('season') || 'all';
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    setParams(next, { replace: true });
  };
  const filter: ProFilter = { format, season };
  const [open, setOpen] = useState<string | null>(null);
  const tracking = useTracking();
  const watch = useWatchlist();

  const players = useMemo(
    () => (squad ? squadPlayers(squad, filter, PRO_MATCHES) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [squad, format, season],
  );
  const ms = useMemo(() => (squad ? filterMatches(squad, filter) : []), [squad, format, season]); // eslint-disable-line react-hooks/exhaustive-deps
  const candidates = useMemo(
    () => (squad ? [...watchedCandidates(watch.keys), ...poolCandidates(squad.gender)] : []),
    [squad, watch.keys],
  );

  if (!squad) return <div className="ss-empty">No professional-team scorecards yet.</div>;
  const openPlayer = players.find((p) => p.name === open) ?? null;
  const seasons = seasonsOf(squad.matches);

  return (
    <div className="pro">
      <div className="pro-bar">
        <div className="pro-seg" role="tablist" aria-label="Squad">
          {squads.map((s) => (
            <button
              key={s.gender}
              role="tab"
              aria-selected={s.gender === squad.gender}
              className={s.gender === squad.gender ? 'on' : ''}
              onClick={() => set({ squad: s.gender, fplayer: '' })}
            >
              {s.name}
              <small>{s.gender === 'men' ? 'Men' : 'Women'}</small>
            </button>
          ))}
        </div>
        <div className="pro-filters">
          <select
            className="field-select sc-select"
            value={format}
            aria-label="Format"
            onChange={(e) => set({ format: e.target.value })}
          >
            <option value="all">All formats</option>
            {PRO_FORMATS.filter((f) => squad.matches.some((m) => m.format === f)).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <select
            className="field-select sc-select"
            value={season}
            aria-label="Season"
            onChange={(e) => set({ season: e.target.value })}
          >
            <option value="all">All seasons</option>
            {seasons.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="pro-note">
        {PRO_IS_SAMPLE && <Pill tone="muted">Sample data · invented names</Pill>}
        <span>
          {ms.length} matches · from scorecards (batting, bowling, fall of wickets). No ball-by-ball
          in these files, so phases come from when wickets fell; every rating is 100 = the average
          of everyone in those games, per format.
        </span>
      </div>

      <div className="sc-tabs" role="tablist" aria-label="Professional team views">
        {PRO_TABS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={tab === k ? 'on' : ''}
            onClick={() => set({ ptab: k })}
          >
            {label}
            {k === 'callups' && Object.keys(tracking.map).length > 0 && (
              <span className="pro-count">{Object.keys(tracking.map).length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="sc-body">
        {tab === 'selection' && (
          <SelectionView
            squad={squad}
            ms={ms}
            players={players}
            candidates={candidates}
            tracking={tracking}
            openPlayer={setOpen}
            goCallups={() => set({ ptab: 'callups' })}
          />
        )}
        {tab === 'squad' && <SquadView players={players} format={format} openPlayer={setOpen} />}
        {tab === 'form' && (
          <FormView
            squad={squad}
            players={players}
            format={format}
            mode={(params.get('fmode') as FormMode) || 'bat'}
            focus={params.get('fplayer') || null}
            onChange={set}
          />
        )}
        {tab === 'team' && <TeamView squad={squad} ms={ms} format={format} />}
        {tab === 'callups' && (
          <CallupsView
            squad={squad}
            players={players}
            candidates={candidates}
            tracking={tracking}
          />
        )}
        {tab === 'matches' && <MatchesView squad={squad} ms={ms} />}
      </div>

      {openPlayer && (
        <ProPlayerPanel
          player={openPlayer}
          squad={squad}
          format={format}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

/* ── Selection ── */

const SIGNAL_TONE: Record<SignalKind, Tone> = {
  promote: 'squad',
  drop: 'risk',
  watch: 'context',
  hold: 'context',
};

const primaryIdx = (p: ProPlayer, which: 'idx' | 'recent') => {
  const src = which === 'idx' ? p.idx : p.recent;
  if (p.role === 'Bowler') return src.bowl?.idx ?? null;
  if (p.role === 'All-rounder') return Math.max(src.bat?.idx ?? 0, src.bowl?.idx ?? 0) || null;
  return src.bat?.idx ?? null;
};

function lastValues(p: ProPlayer, n = 8) {
  if (p.role === 'Bowler') return p.bowl.lines.slice(-n).map((l) => l.w);
  return p.bat.lines.slice(-n).map((l) => l.r);
}

function SelectionView({
  squad,
  ms,
  players,
  candidates,
  tracking,
  openPlayer,
  goCallups,
}: {
  squad: Squad;
  ms: ProMatch[];
  players: ProPlayer[];
  candidates: Candidate[];
  tracking: Tracking;
  openPlayer: (n: string) => void;
  goCallups: () => void;
}) {
  const sum = teamSummary(squad, ms);
  const comp = teamComparisons(squad, ms);
  const mixed = new Set(ms.map((m) => m.format)).size > 1;
  const lanes: { kind: SignalKind[]; title: string; sub: string; cls: string }[] = [
    {
      kind: ['promote'],
      title: 'Promote · in form',
      sub: 'Last five well above average, season holds up',
      cls: 'up',
    },
    {
      kind: ['watch'],
      title: 'Watch',
      sub: 'A dip, a hot streak or too few games to say',
      cls: 'mid',
    },
    {
      kind: ['drop'],
      title: 'At risk',
      sub: 'Last five and season both below average',
      cls: 'down',
    },
  ];
  const pts: MapPt[] = players
    .map((p) => ({ p, s: primaryIdx(p, 'idx'), r: primaryIdx(p, 'recent') }))
    .filter((x) => x.s !== null && x.r !== null && (x.p.qualifies.bat || x.p.qualifies.bowl))
    .map(({ p, s, r }) => ({
      id: p.name,
      label: p.name,
      sub: `${p.role} · ${p.signal.label}`,
      x: s!,
      y: r!,
      size: p.matches,
      tone: SIGNAL_TONE[p.signal.kind],
      pin: p.signal.kind === 'promote' || p.signal.kind === 'drop',
      tip: p.signal.reasons.slice(0, 1),
    }));
  const shortlist = candidates.filter((c) => tracking.status(c.key));
  return (
    <>
      <div className="pv-tiles">
        <Tile
          label="Played"
          value={sum.played}
          sub={`${sum.won} won · ${sum.lost} lost${sum.drawn ? ` · ${sum.drawn} drawn` : ''}${sum.noResult ? ` · ${sum.noResult} no result` : ''}`}
        />
        <Tile
          label="Win rate (decided)"
          value={
            sum.won + sum.lost ? `${Math.round((sum.won / (sum.won + sum.lost)) * 100)}%` : '–'
          }
          tone={sum.won >= sum.lost ? 'good' : 'bad'}
        />
        <Tile
          label="Run rate"
          value={r1(comp.runRate.ours)}
          sub={
            mixed ? 'mixed formats — pick one to compare' : `conceding ${r1(comp.runRate.theirs)}`
          }
          tone={mixed ? undefined : comp.runRate.ours >= comp.runRate.theirs ? 'good' : 'bad'}
        />
        <Tile
          label="Players used"
          value={players.length}
          sub={`${players.filter((p) => p.signal.kind === 'promote').length} to promote · ${players.filter((p) => p.signal.kind === 'drop').length} at risk`}
        />
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Form v season — who is moving</div>
            <div className="card-sub">
              Each player on their main discipline. Across: the season so far · up: the last{' '}
              {RECENT} innings or spells. Above the diagonal = improving.
            </div>
          </div>
        </div>
        <div className="card-body">
          <QuadrantMap
            points={pts}
            xLabel="Season index (100 = average)"
            yLabel={`Last ${RECENT} index`}
            quadrants={['In form and proven', 'Hot streak', 'Dip in form', 'Struggling']}
            toneLabels={{ squad: 'Promote', risk: 'At risk', context: 'Hold or watch' }}
            sizeLabel="matches played"
            diagonal
            onPick={openPlayer}
          />
        </div>
      </div>

      <div className="pro-lanes">
        {lanes.map((lane) => {
          const ps = players.filter((p) => lane.kind.includes(p.signal.kind));
          return (
            <section key={lane.title} className={`pro-lane ${lane.cls}`} aria-label={lane.title}>
              <header>
                <h3>
                  {lane.title} <span>{ps.length}</span>
                </h3>
                <p>{lane.sub}</p>
              </header>
              {ps.length === 0 && (
                <div className="pro-lane-empty">Nobody here in this selection.</div>
              )}
              {ps.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className="pro-card"
                  onClick={() => openPlayer(p.name)}
                >
                  <div className="pro-card-top">
                    <strong>{p.name}</strong>
                    <span className={`pro-sig ${p.signal.kind}`}>{p.signal.label}</span>
                  </div>
                  <div className="pro-card-sub">
                    {p.role} · {p.matches} of {p.squadMatches} games
                  </div>
                  <div className="pro-card-mid">
                    <Spark values={lastValues(p)} />
                    <div className="pro-card-idx">
                      <span>Season</span>
                      <IndexMeter value={primaryIdx(p, 'idx')} small />
                      <span>Last {RECENT}</span>
                      <IndexMeter value={primaryIdx(p, 'recent')} small />
                    </div>
                  </div>
                  <ul className="pro-reasons">
                    {p.signal.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  {p.signal.kind === 'drop' && (
                    <span
                      className="pro-link"
                      onClick={(e) => {
                        e.stopPropagation();
                        goCallups();
                      }}
                    >
                      Find a replacement →
                    </span>
                  )}
                </button>
              ))}
            </section>
          );
        })}
      </div>

      <div className="sc-two">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Holding their place</div>
              <div className="card-sub">Around average for their role — no change needed</div>
            </div>
          </div>
          <div className="card-body pro-chips">
            {players
              .filter((p) => p.signal.kind === 'hold')
              .map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className="pro-chip"
                  onClick={() => openPlayer(p.name)}
                >
                  {p.name} <IndexMeter value={primaryIdx(p, 'idx')} small />
                </button>
              ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Call-up shortlist</div>
              <div className="card-sub">Players you're tracking from scouting</div>
            </div>
            <button type="button" className="pro-link" onClick={goCallups}>
              Open call-ups →
            </button>
          </div>
          <div className="card-body">
            {shortlist.length === 0 ? (
              <div className="pro-lane-empty">
                Track players under Call-ups and they'll appear here.
              </div>
            ) : (
              <ul className="pro-short">
                {shortlist.map((c) => (
                  <li key={c.key}>
                    <span>
                      <strong>{c.name}</strong>{' '}
                      <small>
                        {c.club} · {c.role}
                      </small>
                    </span>
                    <span
                      className={`pro-sig ${tracking.status(c.key) === 'called-up' ? 'promote' : 'watch'}`}
                    >
                      {tracking.status(c.key) === 'called-up' ? 'Called up' : 'Tracking'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Squad ── */

function SquadView({
  players,
  format,
  openPlayer,
}: {
  players: ProPlayer[];
  format: ProFormat | 'all';
  openPlayer: (n: string) => void;
}) {
  const [sort, setSort] = useState<'matches' | 'bat' | 'bowl'>('matches');
  const batPts: MapPt[] = players
    .filter((p) => p.qualifies.bat && p.idx.bat)
    .map((p) => ({
      id: p.name,
      label: p.name,
      sub: `${p.bat.runs} runs · ${p.bat.balls} balls · SR ${r0(p.bat.sr)}`,
      x: p.idx.bat!.srIdx,
      y: p.idx.bat!.rpiIdx,
      size: p.bat.balls,
      tone: p.signal.kind === 'drop' ? 'risk' : 'squad',
      pin: true,
      tip: [`Batting index ${r0(p.idx.bat!.idx)}`],
    }));
  const bowlPts: MapPt[] = players
    .filter((p) => p.qualifies.bowl && p.idx.bowl)
    .map((p) => ({
      id: p.name,
      label: p.name,
      sub: `${p.bowl.wkts} wkts · ${overs(p.bowl.balls)} ov · econ ${r1(p.bowl.econ)}`,
      x: p.idx.bowl!.econIdx,
      y: p.idx.bowl!.wktIdx,
      size: p.bowl.balls,
      tone: p.signal.kind === 'drop' ? 'risk' : 'squad',
      pin: true,
      tip: [`Bowling index ${r0(p.idx.bowl!.idx)}`],
    }));
  const sorted = [...players].sort((a, b) =>
    sort === 'bat'
      ? (b.idx.bat?.idx ?? 0) - (a.idx.bat?.idx ?? 0)
      : sort === 'bowl'
        ? (b.idx.bowl?.idx ?? 0) - (a.idx.bowl?.idx ?? 0)
        : b.matches - a.matches,
  );
  const ballRows = players
    .filter((p) => p.bat.balls >= 20)
    .sort((a, b) => (a.bat.avgPos ?? 99) - (b.bat.avgPos ?? 99))
    .map((p) => ({
      id: p.name,
      label: shortName(p.name),
      balls: p.bat.balls,
      dots: p.bat.dotBalls === p.bat.balls ? p.bat.dots : null,
      fours: p.bat.f4,
      sixes: p.bat.f6,
      runs: p.bat.runs,
    }));
  return (
    <>
      <div className="sc-two">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Batters: how fast, how many</div>
              <div className="card-sub">
                {batPts.length} batters with a qualifying sample
                {format === 'all' ? ' · each format against its own average' : ''}
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
              onPick={openPlayer}
            />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Bowlers: control v wickets</div>
              <div className="card-sub">
                {bowlPts.length} bowlers with a qualifying sample · right = cheaper
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
              onPick={openPlayer}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">How each batter used the balls they faced</div>
            <div className="card-sub">
              Top order first · dots, balls they ran, fours and sixes
              {ballRows.some((r) => r.dots === null)
                ? ' · grey-free bars: dots not recorded in older exports'
                : ''}
            </div>
          </div>
        </div>
        <div className="card-body">
          <BallUseBars rows={ballRows} onPick={openPlayer} />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">The squad in numbers</div>
            <div className="card-sub">
              Indices: 100 = the average of everyone in those games · tap a row for the player
            </div>
          </div>
          <div className="pro-seg small" role="tablist" aria-label="Sort">
            {(
              [
                ['matches', 'Games'],
                ['bat', 'Batting'],
                ['bowl', 'Bowling'],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                role="tab"
                aria-selected={sort === k}
                className={sort === k ? 'on' : ''}
                onClick={() => setSort(k)}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="tbl-w">
          <table className="tbl pro-tbl" aria-label="Squad">
            <thead>
              <tr>
                <th>Player</th>
                <th>M</th>
                <th>Runs</th>
                <th>Avg</th>
                <th>SR</th>
                <th>Bat index</th>
                <th>Wkts</th>
                <th>Econ</th>
                <th>Bowl index</th>
                <th>Ct/St/RO</th>
                <th>Signal</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <tr key={p.name} className="click" onClick={() => openPlayer(p.name)}>
                  <td>
                    <strong>{p.name}</strong>
                    <div className="ump-sub">{p.role}</div>
                  </td>
                  <td>{p.matches}</td>
                  <td>{p.bat.inns ? p.bat.runs : '–'}</td>
                  <td>{r1(p.bat.avg)}</td>
                  <td>{r0(p.bat.sr)}</td>
                  <td>
                    {p.qualifies.bat ? (
                      <IndexMeter value={p.idx.bat?.idx} small />
                    ) : (
                      <span className="pv-idx none">small sample</span>
                    )}
                  </td>
                  <td>{p.bowl.inns ? p.bowl.wkts : '–'}</td>
                  <td>{r1(p.bowl.econ)}</td>
                  <td>
                    {p.qualifies.bowl ? (
                      <IndexMeter value={p.idx.bowl?.idx} small />
                    ) : p.bowl.inns ? (
                      <span className="pv-idx none">small sample</span>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td>
                    {p.field.ct}/{p.field.st}/{p.field.ro}
                  </td>
                  <td>
                    <span className={`pro-sig ${p.signal.kind}`}>{p.signal.label}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ── Form ── */

type FormMode = 'bat' | 'bowl' | 'ar';
const FORM_MODES: [FormMode, string][] = [
  ['bat', 'Batting'],
  ['bowl', 'Bowling'],
  ['ar', 'All-rounder'],
];

/** Who shows in each mode: enough innings, spells, or both. */
const inMode = (p: ProPlayer, m: FormMode) =>
  m === 'bat'
    ? p.bat.inns >= 3
    : m === 'bowl'
      ? p.bowl.inns >= 3
      : p.bat.inns >= 3 && p.bowl.inns >= 3;

const arIndex = (p: ProPlayer, w: 'idx' | 'recent') => {
  const s = p[w];
  return s.bat && s.bowl ? Math.sqrt(s.bat.idx * s.bowl.idx) : null;
};

function batPoints(p: ProPlayer, bases: Record<ProFormat, Baseline | null>, last?: number) {
  return (last ? p.bat.lines.slice(-last) : p.bat.lines).map((l, i) => ({
    key: `${l.matchId}-${l.innsNo}-${i}`,
    value: l.r,
    text: `${l.r}${l.isOut ? '' : '*'}`,
    tip: `${fmtDay(l.date)} ${l.format} v ${l.opp}: ${l.r}${l.isOut ? '' : '*'} off ${l.b} at #${l.pos}${l.cameIn.over ? `, in at ${l.cameIn.score}/${l.cameIn.wkts} (${l.cameIn.over} ov)` : ''}${l.kind ? ` · ${l.kind.toLowerCase()}` : ''}`,
    faint: !l.isOut,
    good: l.r >= (bases[l.format]?.rpi ?? 0),
  }));
}

function bowlPoints(p: ProPlayer, bases: Record<ProFormat, Baseline | null>, last?: number) {
  return (last ? p.bowl.lines.slice(-last) : p.bowl.lines).map((l, i) => ({
    key: `${l.matchId}-${i}`,
    value: l.w,
    text: `${l.w}/${l.r}`,
    tip: `${fmtDay(l.date)} ${l.format} v ${l.opp}: ${l.w}/${l.r} in ${overs(l.balls)} ov · econ ${r1((l.r / l.balls) * 6)} · ${l.dots} dots`,
    good: (l.r / l.balls) * 6 <= (bases[l.format]?.econ ?? 99) || l.w >= 2,
  }));
}

function FormView({
  squad,
  players,
  format,
  mode,
  focus,
  onChange,
}: {
  squad: Squad;
  players: ProPlayer[];
  format: ProFormat | 'all';
  mode: FormMode;
  focus: string | null;
  onChange: (patch: Record<string, string>) => void;
}) {
  const [q, setQ] = useState('');
  const [suggest, setSuggest] = useState(false);
  // Averages from this squad's gender only: a women's T20 is rated against women's T20.
  const bases = useMemo(
    () => baselines(PRO_MATCHES.filter((m) => m.gender === squad.gender)),
    [squad.gender],
  );
  const needle = q.trim().toLowerCase();
  const matches = needle ? players.filter((p) => p.name.toLowerCase().includes(needle)) : [];
  const pick = (name: string) => {
    setQ('');
    setSuggest(false);
    onChange({ fplayer: name });
  };
  const focused = focus ? players.find((p) => p.name === focus) : undefined;
  const list = players
    .filter((p) => inMode(p, mode) && (!needle || p.name.toLowerCase().includes(needle)))
    .sort((a, b) =>
      mode === 'ar' ? (arIndex(b, 'idx') ?? 0) - (arIndex(a, 'idx') ?? 0) : b.matches - a.matches,
    )
    .slice(0, needle ? 40 : 12);

  return (
    <>
      <div className="pro-form-bar">
        <div
          className="pro-search"
          role="combobox"
          aria-expanded={suggest && matches.length > 0}
          aria-haspopup="listbox"
        >
          <svg
            viewBox="0 0 16 16"
            width="16"
            height="16"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" />
          </svg>
          <input
            type="search"
            placeholder="Search a player…"
            aria-label="Search a player"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSuggest(true);
            }}
            onFocus={() => setSuggest(true)}
            onBlur={() => setTimeout(() => setSuggest(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches[0]) pick(matches[0].name);
              if (e.key === 'Escape') setSuggest(false);
            }}
          />
          {suggest && matches.length > 0 && (
            <ul className="pro-suggest" role="listbox" aria-label="Players">
              {matches.slice(0, 8).map((p) => (
                <li key={p.name} role="option" aria-selected={false}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(p.name)}
                  >
                    <strong>{p.name}</strong>
                    <small>
                      {p.role} · {p.matches} game{p.matches === 1 ? '' : 's'}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="pro-seg small" role="tablist" aria-label="Discipline">
          {FORM_MODES.map(([k, l]) => (
            <button
              key={k}
              role="tab"
              aria-selected={mode === k}
              className={mode === k ? 'on' : ''}
              onClick={() => onChange({ fmode: k })}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {focused ? (
        <PlayerDeepDive
          player={focused}
          squad={squad}
          mode={mode}
          format={format}
          bases={bases}
          onBack={() => onChange({ fplayer: '' })}
        />
      ) : (
        <>
          <div className="sc-board-note pro-form-note">
            {mode === 'ar'
              ? 'Players who bat and bowl, best all-rounder index first · runs above, wickets below, innings by innings'
              : `Innings by innings, oldest first · navy = above the ${format === 'all' ? 'format' : format} average, grey = below · the line is the 3-innings rolling average`}
            {' · '}search or tap a name to dive deeper
          </div>
          {list.length === 0 ? (
            <div className="ss-empty">
              {needle
                ? `No players match “${q}” for ${FORM_MODES.find((m) => m[0] === mode)![1].toLowerCase()} in this selection.`
                : 'Nobody with three innings or spells in this selection.'}
            </div>
          ) : (
            <div className="pro-grid">
              {list.map((p) => (
                <div key={p.name} className="card pro-form-card">
                  <div className="card-head">
                    <div>
                      <button
                        type="button"
                        className="card-title pro-name"
                        onClick={() => pick(p.name)}
                      >
                        {p.name}
                      </button>
                      <div className="card-sub">
                        {mode === 'bat'
                          ? `${p.bat.runs} runs · avg ${r1(p.bat.avg)} · SR ${r0(p.bat.sr)}`
                          : mode === 'bowl'
                            ? `${p.bowl.wkts} wkts · econ ${r1(p.bowl.econ)} · SR ${r1(p.bowl.sr)}`
                            : `${p.bat.runs} runs · ${p.bowl.wkts} wkts · all-rounder index ${r0(arIndex(p, 'idx'))}`}
                      </div>
                    </div>
                    <span className={`pro-sig ${p.signal.kind}`}>{p.signal.label}</span>
                  </div>
                  <div className="card-body">
                    {mode !== 'bowl' && (
                      <FormColumns
                        points={batPoints(p, bases, 16)}
                        average={format !== 'all' ? (bases[format]?.rpi ?? undefined) : undefined}
                        averageLabel={`${format} average`}
                        valueLabel="Runs"
                        height={mode === 'ar' ? 100 : 130}
                      />
                    )}
                    {mode !== 'bat' && (
                      <FormColumns
                        points={bowlPoints(p, bases, 16)}
                        valueLabel="Wickets"
                        height={mode === 'ar' ? 90 : 130}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {!needle && players.filter((p) => inMode(p, mode)).length > list.length && (
            <p className="pv-note">Showing the 12 most-used — search to find anyone else.</p>
          )}
        </>
      )}
    </>
  );
}

/* ── The deep dive ── */

function PlayerDeepDive({
  player: p,
  squad,
  mode,
  format,
  bases,
  onBack,
}: {
  player: ProPlayer;
  squad: Squad;
  mode: FormMode;
  format: ProFormat | 'all';
  bases: Record<ProFormat, Baseline | null>;
  onBack: () => void;
}) {
  const showBat = mode !== 'bowl' && p.bat.inns > 0;
  const showBowl = mode !== 'bat' && p.bowl.inns > 0;
  // Split by format when every format is in view; otherwise by season.
  const byFormat = format === 'all' && p.formats.length > 1;
  const splitKey = byFormat
    ? (l: { format: string }) => l.format
    : (l: { date: string }) => seasonOf(l.date);
  const splitLabel = byFormat ? 'Format' : 'Season';
  const batBy = showBat ? batSplits(p.bat.lines, splitKey) : [];
  const batOpp = showBat
    ? batSplits(p.bat.lines, (l) => l.opp).sort((a, b) => b.runs - a.runs)
    : [];
  const bowlBy = showBowl ? bowlSplits(p.bowl.lines, splitKey) : [];
  const bowlOpp = showBowl
    ? bowlSplits(p.bowl.lines, (l) => l.opp).sort(
        (a, b) => b.wkts - a.wkts || (a.econ ?? 99) - (b.econ ?? 99),
      )
    : [];
  const positions = showBat
    ? batSplits(p.bat.lines, (l) => String(l.pos)).sort((a, b) => Number(a.key) - Number(b.key))
    : [];
  const entry = p.bat.lines.filter((l) => l.pos >= 3);
  const econAvg = format !== 'all' ? bases[format]?.econ : undefined;
  const nothing =
    (mode === 'bat' && !p.bat.inns) ||
    (mode === 'bowl' && !p.bowl.inns) ||
    (mode === 'ar' && (!p.bat.inns || !p.bowl.inns));

  return (
    <div className="pro-dive" aria-label={`${p.name} deep dive`}>
      <button type="button" className="pro-link" onClick={onBack}>
        ← All players
      </button>
      <div className="card pro-dive-head">
        <div className="card-head">
          <div>
            <div className="sc-panel-eyebrow">
              {squad.name} · {p.role} · {p.formats.join(', ')} · {p.matches} of {p.squadMatches}{' '}
              games
            </div>
            <h2 className="pro-dive-name">{p.name}</h2>
          </div>
          <span className={`pro-sig ${p.signal.kind}`}>{p.signal.label}</span>
        </div>
        <div className="card-body">
          <ul className="pro-reasons">
            {p.signal.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <div className="pro-idx-row">
            {mode !== 'bowl' && p.idx.bat && (
              <div>
                <span>Batting index · season / last {RECENT}</span>
                <span className="pro-peer">
                  <IndexMeter value={p.idx.bat.idx} />{' '}
                  <IndexMeter value={p.recent.bat?.idx} small />
                </span>
                <small>
                  runs per innings {r0(p.idx.bat.rpiIdx)} · strike rate {r0(p.idx.bat.srIdx)}
                </small>
              </div>
            )}
            {mode !== 'bat' && p.idx.bowl && (
              <div>
                <span>Bowling index · season / last {RECENT}</span>
                <span className="pro-peer">
                  <IndexMeter value={p.idx.bowl.idx} />{' '}
                  <IndexMeter value={p.recent.bowl?.idx} small />
                </span>
                <small>
                  economy {r0(p.idx.bowl.econIdx)} · wicket rate {r0(p.idx.bowl.wktIdx)}
                </small>
              </div>
            )}
            {mode === 'ar' && arIndex(p, 'idx') !== null && (
              <div>
                <span>All-rounder index · season / last {RECENT}</span>
                <span className="pro-peer">
                  <IndexMeter value={arIndex(p, 'idx')} />{' '}
                  <IndexMeter value={arIndex(p, 'recent')} small />
                </span>
                <small>√(batting × bowling) · 100 = average</small>
              </div>
            )}
          </div>
        </div>
      </div>

      {nothing && (
        <div className="ss-empty">
          {p.name} has no{' '}
          {mode === 'bat' ? 'batting' : mode === 'bowl' ? 'bowling' : 'batting and bowling both'} in
          this selection.
        </div>
      )}

      <div className="pv-tiles">
        {showBat && (
          <>
            <Tile
              label="Runs"
              value={p.bat.runs}
              sub={`${p.bat.inns} innings · ${p.bat.notOuts} not out`}
            />
            <Tile
              label="Average"
              value={r1(p.bat.avg)}
              sub={`HS ${p.bat.hs} · ${p.bat.fifties} × 50 · ${p.bat.hundreds} × 100`}
            />
            <Tile
              label="Strike rate"
              value={r0(p.bat.sr)}
              sub={`boundaries ${r0(p.bat.boundaryPct)}% of runs`}
            />
            {p.bat.dotPct !== null && (
              <Tile label="Dots faced" value={`${r0(p.bat.dotPct)}%`} sub="of balls faced" />
            )}
          </>
        )}
        {showBowl && (
          <>
            <Tile
              label="Wickets"
              value={p.bowl.wkts}
              sub={`${overs(p.bowl.balls)} overs · best ${p.bowl.best}`}
            />
            <Tile
              label="Economy"
              value={r1(p.bowl.econ)}
              sub={`average ${r1(p.bowl.avg)} · SR ${r1(p.bowl.sr)}`}
            />
            <Tile
              label="Dots bowled"
              value={`${r0(p.bowl.dotPct)}%`}
              sub={`${p.bowl.wd} wides · ${p.bowl.nb} no-balls`}
            />
          </>
        )}
        <Tile
          label="Fielding"
          value={p.field.ct + p.field.st + p.field.ro}
          sub={`${p.field.ct} ct · ${p.field.st} st · ${p.field.ro} ro`}
        />
      </div>

      {showBat && (
        <>
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Every innings</div>
                <div className="card-sub">
                  Oldest first · faded = not out · hover a bar for the match, position and where
                  they came in
                </div>
              </div>
            </div>
            <div className="card-body">
              <FormColumns
                points={batPoints(p, bases)}
                average={format !== 'all' ? (bases[format]?.rpi ?? undefined) : undefined}
                averageLabel={`${format} average`}
                valueLabel="Runs"
                height={170}
              />
            </div>
          </div>
          <div className="sc-two">
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Scores</div>
                  <div className="card-sub">How often each size of score comes</div>
                </div>
              </div>
              <div className="card-body">
                <RankBars
                  rows={scoreBands(p.bat.lines).map((b) => ({
                    id: b.label,
                    label: b.label,
                    value: b.n,
                    text: `${b.n}`,
                  }))}
                />
              </div>
            </div>
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Where they bat</div>
                  <div className="card-sub">
                    Average by position (innings in brackets)
                    {entry.length >= 3
                      ? ` · usually in at about ${Math.round(entry.reduce((n, l) => n + l.cameIn.score, 0) / entry.length)} for ${Math.round(entry.reduce((n, l) => n + l.cameIn.wkts, 0) / entry.length)}`
                      : ''}
                  </div>
                </div>
              </div>
              <div className="card-body">
                <RankBars
                  rows={positions.map((s) => ({
                    id: s.key,
                    label: `#${s.key} (${s.inns})`,
                    value: s.avg ?? s.runs,
                    text: `${r1(s.avg ?? s.runs)} · SR ${r0(s.sr)}`,
                  }))}
                />
              </div>
            </div>
          </div>
          <div className="sc-two">
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">How they use the strike</div>
                  <div className="card-sub">Every ball faced · and how they get out</div>
                </div>
              </div>
              <div className="card-body">
                <BallUseBars
                  rows={[
                    {
                      id: p.name,
                      label: 'Balls faced',
                      balls: p.bat.balls,
                      dots: p.bat.dotBalls === p.bat.balls ? p.bat.dots : null,
                      fours: p.bat.f4,
                      sixes: p.bat.f6,
                      runs: p.bat.runs,
                    },
                  ]}
                />
                <div className="pro-mini-title">How out</div>
                <ShareRows
                  keys={DISMISSAL_KINDS.slice()}
                  rows={[
                    {
                      label: `${p.bat.outs} dismissals`,
                      parts: DISMISSAL_KINDS.map((k) => p.bat.dismissals[k]),
                    },
                  ]}
                />
              </div>
            </div>
            <SplitTable
              title={`Batting by ${splitLabel.toLowerCase()}`}
              head={[splitLabel, 'Inns', 'Runs', 'Avg', 'SR', 'HS', '50+']}
              rows={batBy.map((s) => [s.key, s.inns, s.runs, r1(s.avg), r0(s.sr), s.hs, s.fifties])}
            />
          </div>
          <SplitTable
            title="Batting against each opponent"
            head={['Opponent', 'Inns', 'Runs', 'Avg', 'SR', 'HS', 'Boundary %']}
            rows={batOpp.map((s) => [
              s.key,
              s.inns,
              s.runs,
              r1(s.avg),
              r0(s.sr),
              s.hs,
              `${r0(s.boundaryPct)}%`,
            ])}
          />
        </>
      )}

      {showBowl && (
        <>
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Every spell</div>
                <div className="card-sub">
                  Wickets per spell, oldest first · navy = cheaper than the format average or 2+
                  wickets
                </div>
              </div>
            </div>
            <div className="card-body">
              <FormColumns points={bowlPoints(p, bases)} valueLabel="Wickets" height={150} />
              <FormColumns
                points={p.bowl.lines.map((l, i) => {
                  const e = (l.r / l.balls) * 6;
                  return {
                    key: `e-${l.matchId}-${i}`,
                    value: Math.round(e * 10) / 10,
                    text: r1(e),
                    tip: `${fmtDay(l.date)} v ${l.opp}: ${overs(l.balls)} ov for ${l.r} · econ ${r1(e)}`,
                    good: e <= (bases[l.format]?.econ ?? 99),
                  };
                })}
                average={econAvg ?? undefined}
                averageLabel={`${format} average (lower is better)`}
                valueLabel="Economy"
                height={130}
              />
            </div>
          </div>
          <div className="sc-two">
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Wickets per spell</div>
                  <div className="card-sub">How often they take none, one, two or more</div>
                </div>
              </div>
              <div className="card-body">
                <RankBars
                  rows={wicketBands(p.bowl.lines).map((b) => ({
                    id: b.label,
                    label: `${b.label} wkt${b.label === '1' ? '' : 's'}`,
                    value: b.n,
                    text: `${b.n}`,
                  }))}
                />
              </div>
            </div>
            <SplitTable
              title={`Bowling by ${splitLabel.toLowerCase()}`}
              head={[splitLabel, 'Spells', 'Overs', 'Wkts', 'Econ', 'Avg', 'Dot %', 'Best']}
              rows={bowlBy.map((s) => [
                s.key,
                s.spells,
                overs(s.balls),
                s.wkts,
                r1(s.econ),
                r1(s.avg),
                `${r0(s.dotPct)}%`,
                s.best,
              ])}
            />
          </div>
          <SplitTable
            title="Bowling against each opponent"
            head={['Opponent', 'Spells', 'Overs', 'Wkts', 'Econ', 'Avg', 'Best']}
            rows={bowlOpp.map((s) => [
              s.key,
              s.spells,
              overs(s.balls),
              s.wkts,
              r1(s.econ),
              r1(s.avg),
              s.best,
            ])}
          />
        </>
      )}
    </div>
  );
}

function SplitTable({
  title,
  head,
  rows,
}: {
  title: string;
  head: string[];
  rows: (string | number)[][];
}) {
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">{title}</div>
        </div>
      </div>
      <div className="tbl-w">
        <table className="tbl pro-tbl" aria-label={title}>
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r[0])}>
                {r.map((c, i) => (
                  <td key={i}>{i === 0 ? <strong>{c}</strong> : c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Team ── */

function TeamView({
  squad,
  ms,
  format,
}: {
  squad: Squad;
  ms: ProMatch[];
  format: ProFormat | 'all';
}) {
  const sum = teamSummary(squad, ms);
  const c = teamComparisons(squad, ms);
  const order = orderContribution(squad, ms);
  const fmts =
    format === 'all' ? PRO_FORMATS.filter((f) => ms.some((m) => m.format === f)) : [format];
  const kinds = DISMISSAL_KINDS;
  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Results</div>
            <div className="card-sub">
              {sum.won} won · {sum.lost} lost · {sum.drawn} drawn
              {sum.noResult
                ? ` · ${sum.noResult} where the scorecard doesn't settle it (rain)`
                : ''}
            </div>
          </div>
        </div>
        <div className="card-body">
          <ResultStrip
            results={sum.results.map((r) => ({
              key: r.match.id,
              outcome: r.outcome,
              tip: `${fmtDay(r.match.date)} · ${r.match.format} v ${r.opp}: ${r.our} v ${r.their} — ${r.match.result}`,
            }))}
          />
        </div>
      </div>

      <div className="sc-two">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Us v opponents</div>
              <div className="card-sub">Per innings across the selection</div>
            </div>
          </div>
          <div className="card-body">
            <PairBars
              rows={[
                {
                  label: 'Runs per innings',
                  ours: c.runsPerInns.ours,
                  theirs: c.runsPerInns.theirs,
                },
                { label: 'Run rate', ours: c.runRate.ours, theirs: c.runRate.theirs },
                {
                  label: 'Score at the 3rd wicket',
                  ours: c.scoreAt3rdWicket.ours ?? 0,
                  theirs: c.scoreAt3rdWicket.theirs ?? 0,
                },
                { label: 'Dot balls bowled %', ours: c.dotPct.ours, theirs: c.dotPct.theirs },
                {
                  label: 'Wides + no-balls per 10 ov',
                  ours: c.widesNoBallsPer10.ours,
                  theirs: c.widesNoBallsPer10.theirs,
                },
              ]}
            />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Partnerships by wicket</div>
              <div className="card-sub">Average stand for each wicket</div>
            </div>
          </div>
          <div className="card-body">
            <PairBars
              rows={c.partnerships.ours.map((p, i) => ({
                label: `${p.wkt}${['st', 'nd', 'rd'][p.wkt - 1] ?? 'th'} wicket`,
                ours: p.avg,
                theirs: c.partnerships.theirs[i].avg,
              }))}
              fmt={(v) => Math.round(v).toString()}
              shared
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">When wickets fall</div>
            <div className="card-sub">
              Wickets per innings in each phase, from the fall of wickets · ours lost v theirs
              (taken by us)
            </div>
          </div>
        </div>
        <div className="card-body pro-phase-grid">
          {fmts.map((f) => {
            const rows = wicketsByPhase(squad, ms, f);
            return (
              <div key={f}>
                <div className="pro-mini-title">{f}</div>
                <PairBars
                  rows={rows.map((r) => ({
                    label: r.phase,
                    ours: r.lostPerInns,
                    theirs: r.takenPerInns,
                  }))}
                  ours="Our wickets lost"
                  theirs="Their wickets lost"
                  fmt={(v) => v.toFixed(1)}
                  shared
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="sc-two">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Where the runs come from</div>
              <div className="card-sub">Share of runs: boundaries, running, extras</div>
            </div>
          </div>
          <div className="card-body">
            <ShareRows
              keys={['Extras', 'Running', 'Boundaries']}
              rows={[
                {
                  label: shortTeam(squad.name),
                  parts: [
                    c.runSources.ours.extras,
                    c.runSources.ours.running,
                    c.runSources.ours.boundaries,
                  ],
                },
                {
                  label: 'Opponents',
                  parts: [
                    c.runSources.theirs.extras,
                    c.runSources.theirs.running,
                    c.runSources.theirs.boundaries,
                  ],
                },
              ]}
            />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">How the wickets fall</div>
              <div className="card-sub">
                Our batters' dismissals v the wickets our bowlers and fielders take
              </div>
            </div>
          </div>
          <div className="card-body">
            <ShareRows
              keys={kinds.slice()}
              rows={[
                { label: 'How we get out', parts: kinds.map((k) => c.dismissalsSuffered[k]) },
                { label: 'How we take them', parts: kinds.map((k) => c.dismissalsTaken[k]) },
              ]}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">The batting order</div>
            <div className="card-sub">Average by position, with who batted there most</div>
          </div>
        </div>
        <div className="card-body">
          <RankBars
            rows={order
              .filter((o) => o.inns)
              .map((o) => ({
                id: String(o.pos),
                label: `#${o.pos} · ${o.regulars.map((r) => shortName(r.n)).join(', ')}`,
                value: o.avg,
                text: `${r1(o.avg)} · SR ${r0(o.sr)}`,
                sub: `#${o.pos}: ${o.inns} innings — ${o.regulars.map((r) => `${r.n} (${r.k})`).join(', ')}`,
              }))}
          />
        </div>
      </div>
    </>
  );
}

/* ── Call-ups ── */

const ROLE_FOR: Record<ProRole, PoolRole[]> = {
  Batter: ['Batter', 'Wicketkeeper', 'All-rounder'],
  Wicketkeeper: ['Wicketkeeper', 'Batter'],
  Bowler: ['Bowler', 'All-rounder'],
  'All-rounder': ['All-rounder', 'Bowler', 'Batter'],
};

function CallupsView({
  squad,
  players,
  candidates,
  tracking,
}: {
  squad: Squad;
  players: ProPlayer[];
  candidates: Candidate[];
  tracking: Tracking;
}) {
  const [role, setRole] = useState<PoolRole | ''>('');
  const [union, setUnion] = useState('');
  const [pick, setPick] = useState<Candidate | null>(null);
  const needs = players
    .filter(
      (p) =>
        p.signal.kind === 'drop' || (p.signal.kind === 'watch' && p.signal.label === 'Dip in form'),
    )
    .sort(
      (a, b) =>
        Number(b.signal.kind === 'drop') - Number(a.signal.kind === 'drop') ||
        (primaryIdx(a, 'idx') ?? 0) - (primaryIdx(b, 'idx') ?? 0),
    );
  const ranked = candidates
    .filter((c) => (!role || c.role === role) && (!union || c.union === union))
    .map((c) => ({ c, idx: roleIndex(c) }))
    .filter((x) => x.idx !== null)
    .sort(
      (a, b) =>
        Number(!!tracking.status(b.c.key)) - Number(!!tracking.status(a.c.key)) ||
        Number(!!b.c.watched) - Number(!!a.c.watched) ||
        b.idx! - a.idx!,
    );
  const unions = [...new Set(candidates.map((c) => c.union).filter(Boolean))].sort();
  const pools = [...new Set(candidates.map((c) => c.source))];
  if (!candidates.length)
    return (
      <div className="ss-empty">
        No {squad.gender === 'women' ? "women's" : "men's"} scouting pool yet. When a scouting
        report or league for this squad is loaded — or you watch senior players in Player scouting —
        candidates appear here.
      </div>
    );
  // Same scale, different leagues: squad players' pro index beside candidates' own-league index.
  const squadByRole = players.filter(
    (p) =>
      (role ? ROLE_FOR[p.role].includes(role) || p.role === role : true) &&
      primaryIdx(p, 'idx') !== null &&
      (p.qualifies.bat || p.qualifies.bowl),
  );
  // Two panels, never one axis: a club index and a professional index are each against their
  // own league, so bars side by side on one scale would read as "better than".
  const poolRows = ranked.slice(0, 10).map(({ c, idx }) => ({
    id: `c:${c.key}`,
    label: c.name,
    value: idx!,
    tone: 'pool' as Tone,
    sub: `${c.name} · ${c.club}${c.union ? `, ${c.union}` : ''} · ${c.role} · ${c.line}`,
  }));
  const squadRows = squadByRole
    .sort((a, b) => primaryIdx(b, 'idx')! - primaryIdx(a, 'idx')!)
    .slice(0, 10)
    .map((p) => ({
      id: `s:${p.name}`,
      label: p.name,
      value: primaryIdx(p, 'idx')!,
      tone: (p.signal.kind === 'drop' ? 'risk' : 'squad') as Tone,
      sub: `${p.name} · ${p.role} · ${p.signal.label} · ${p.signal.reasons[0] ?? ''}`,
    }));
  return (
    <>
      {needs.length > 0 && (
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Where the squad needs cover</div>
              <div className="card-sub">
                Players at risk or in a dip, with the best-rated scouting options for their role
              </div>
            </div>
          </div>
          <div className="card-body pro-needs">
            {needs.map((p) => {
              const opts = candidates
                .filter((c) => ROLE_FOR[p.role].includes(c.role))
                .map((c) => ({ c, idx: roleIndex(c) }))
                .filter((x) => x.idx !== null)
                .sort(
                  (a, b) =>
                    Number(!!tracking.status(b.c.key)) - Number(!!tracking.status(a.c.key)) ||
                    b.idx! - a.idx!,
                )
                .slice(0, 3);
              return (
                <div key={p.name} className="pro-need">
                  <div className="pro-need-who">
                    <span className={`pro-sig ${p.signal.kind}`}>{p.signal.label}</span>
                    <strong>{p.name}</strong>
                    <small>
                      {p.role} · season index {r0(primaryIdx(p, 'idx'))}
                    </small>
                  </div>
                  <div className="pro-need-opts">
                    {opts.map(({ c, idx }) => (
                      <button
                        key={c.key}
                        type="button"
                        className="pro-opt"
                        onClick={() => setPick(c)}
                      >
                        <strong>{c.name}</strong>
                        <small>
                          {c.club} · {c.role} · index {Math.round(idx!)}
                        </small>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="sc-filters">
        <div className="sc-board-note">
          From {pools.join(' · ')}. Indices are against each player's own league — not adjusted for
          league strength, so treat them as a shortlist to watch.
        </div>
        <select
          className="field-select sc-select"
          value={role}
          aria-label="Role"
          onChange={(e) => setRole(e.target.value as PoolRole | '')}
        >
          <option value="">All roles</option>
          {(['Batter', 'Bowler', 'All-rounder', 'Wicketkeeper'] as PoolRole[]).map((r) => (
            <option key={r} value={r}>
              {r}s
            </option>
          ))}
        </select>
        {unions.length > 1 && (
          <select
            className="field-select sc-select"
            value={union}
            aria-label="Union"
            onChange={(e) => setUnion(e.target.value)}
          >
            <option value="">All unions</option>
            {unions.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="sc-two">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">The squad{role ? ` · ${role.toLowerCase()}s` : ''}</div>
              <div className="card-sub">
                Role index against the professional average (red: at risk)
              </div>
            </div>
          </div>
          <div className="card-body">
            <RankBars rows={squadRows} refValue={100} refLabel="pro average" />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Best in the scouting pool</div>
              <div className="card-sub">
                Role index against their own league's average · not comparable with the squad's bars
              </div>
            </div>
          </div>
          <div className="card-body">
            <RankBars
              rows={poolRows}
              refValue={100}
              refLabel="their league average"
              onPick={(id) => setPick(candidates.find((c) => `c:${c.key}` === id) ?? null)}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Scouting pool</div>
            <div className="card-sub">
              {ranked.length} players · tracked and watched first, then by index
            </div>
          </div>
        </div>
        <div className="tbl-w">
          <table className="tbl pro-tbl" aria-label="Scouting pool">
            <thead>
              <tr>
                <th>Player</th>
                <th>Role</th>
                <th>Index</th>
                <th>Numbers</th>
                <th>Lists</th>
                <th aria-label="Tracking" />
              </tr>
            </thead>
            <tbody>
              {ranked.slice(0, 60).map(({ c, idx }) => {
                const st = tracking.status(c.key);
                return (
                  <tr key={c.key} className="click" onClick={() => setPick(c)}>
                    <td>
                      <strong>{c.name}</strong>
                      <div className="ump-sub">
                        {c.club}
                        {c.union ? ` · ${c.union}` : ''}
                      </div>
                    </td>
                    <td>{c.role}</td>
                    <td>
                      <IndexMeter value={idx} small />
                    </td>
                    <td className="ump-sub">{c.line}</td>
                    <td className="pro-lists">
                      {c.lists.slice(0, 2).map((l) => (
                        <span key={l}>{l}</span>
                      ))}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <TrackButtons cKey={c.key} status={st} tracking={tracking} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {pick && (
        <CandidatePanel
          c={pick}
          candidates={candidates}
          players={players}
          tracking={tracking}
          onClose={() => setPick(null)}
        />
      )}
    </>
  );
}

function TrackButtons({
  cKey,
  status,
  tracking,
}: {
  cKey: string;
  status: TrackStatus | null;
  tracking: Tracking;
}) {
  return (
    <span className="pro-track">
      <button
        type="button"
        className={`pro-tbtn${status ? ' on' : ''}`}
        onClick={() => tracking.set(cKey, status ? null : 'tracked')}
        aria-pressed={!!status}
      >
        {status ? '✓ Tracking' : '+ Track'}
      </button>
      {status && (
        <button
          type="button"
          className={`pro-tbtn call${status === 'called-up' ? ' on' : ''}`}
          onClick={() => tracking.set(cKey, status === 'called-up' ? 'tracked' : 'called-up')}
          aria-pressed={status === 'called-up'}
        >
          {status === 'called-up' ? 'Called up' : 'Call up'}
        </button>
      )}
    </span>
  );
}

function CandidatePanel({
  c,
  candidates,
  players,
  tracking,
  onClose,
}: {
  c: Candidate;
  candidates: Candidate[];
  players: ProPlayer[];
  tracking: Tracking;
  onClose: () => void;
}) {
  const idx = roleIndex(c);
  const sameRole = candidates
    .filter((x) => x.role === c.role && x.source === c.source && roleIndex(x) !== null)
    .sort((a, b) => roleIndex(b)! - roleIndex(a)!);
  const rank = sameRole.findIndex((x) => x.key === c.key) + 1;
  const peers = players
    .filter(
      (p) =>
        ROLE_FOR[p.role].includes(c.role) &&
        primaryIdx(p, 'idx') !== null &&
        (p.qualifies.bat || p.qualifies.bowl),
    )
    .sort((a, b) => primaryIdx(b, 'idx')! - primaryIdx(a, 'idx')!);
  return (
    <div className="sc-panel-scrim" onClick={onClose}>
      <aside
        className="sc-panel"
        role="dialog"
        aria-modal="true"
        aria-label={c.name}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sc-panel-head">
          <div>
            <div className="sc-panel-eyebrow">
              {c.club}
              {c.union ? ` · ${c.union}` : ''} · {c.role}
            </div>
            <div className="sc-panel-name">{c.name}</div>
          </div>
          <div className="sc-panel-actions">
            <TrackButtons cKey={c.key} status={tracking.status(c.key)} tracking={tracking} />
            <button type="button" className="sc-panel-close" onClick={onClose} aria-label="Close">
              <Icon.X />
            </button>
          </div>
        </div>
        <div className="pro-panel-body">
          <div className="pv-tiles">
            <Tile
              label="Role index"
              value={r0(idx)}
              sub="own league, 100 = average"
              tone={(idx ?? 0) >= 100 ? 'good' : undefined}
            />
            {c.batIdx !== null && <Tile label="Batting index" value={r0(c.batIdx)} />}
            {c.bowlIdx !== null && <Tile label="Bowling index" value={r0(c.bowlIdx)} />}
            {c.impact !== null && (
              <Tile label="Impact" value={c.impact} sub="per game, report scale" />
            )}
          </div>
          <p className="pro-line">{c.line}</p>
          {c.note && <blockquote className="pro-quote">{c.note}</blockquote>}
          {c.lists.length > 0 && (
            <div className="pro-lists wrap">
              {c.lists.map((l) => (
                <span key={l}>{l}</span>
              ))}
            </div>
          )}
          <div className="pro-mini-title">In the pool</div>
          <p className="pro-line">
            {rank ? `#${rank} of ${sameRole.length} ${c.role.toLowerCase()}s` : 'Not ranked'} in{' '}
            {c.source}
            {rank && sameRole.length >= 5
              ? ` — top ${Math.max(1, Math.round((rank / sameRole.length) * 100))}%`
              : ''}
            .
          </p>
          <div className="pro-mini-title">Squad {c.role.toLowerCase()}s they'd compete with</div>
          <ul className="pro-short">
            {peers.slice(0, 6).map((p) => (
              <li key={p.name}>
                <span>
                  <strong>{p.name}</strong> <small>{p.role}</small>
                </span>
                <span className="pro-peer">
                  <IndexMeter value={primaryIdx(p, 'idx')} small />
                  <span className={`pro-sig ${p.signal.kind}`}>{p.signal.label}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="pv-note">
            Source: {c.source}. Indices compare a player with their own league; a club index of 150
            is not a professional 150. Track to follow their games, then call up to mark them for a
            look.
          </p>
        </div>
      </aside>
    </div>
  );
}

/* ── Matches ── */

function MatchesView({ squad, ms }: { squad: Squad; ms: ProMatch[] }) {
  const sum = teamSummary(squad, ms);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Matches</div>
          <div className="card-sub">Newest first · tap for the scorecard</div>
        </div>
      </div>
      <div className="tbl-w">
        <table className="tbl pro-tbl" aria-label="Matches">
          <thead>
            <tr>
              <th>Date</th>
              <th>Format</th>
              <th>Opponent</th>
              <th>{shortTeam(squad.name)}</th>
              <th>Opponent</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {[...sum.results].reverse().map((r) => (
              <Fragment key={r.match.id}>
                <tr
                  className="click"
                  onClick={() => setOpen(open === r.match.id ? null : r.match.id)}
                >
                  <td>{fmtDay(r.match.date)}</td>
                  <td>{r.match.format}</td>
                  <td>{r.opp}</td>
                  <td>{r.our}</td>
                  <td>{r.their}</td>
                  <td>
                    <span className={`pv-res ${r.outcome}`}>
                      {r.outcome === 'NR' ? '–' : r.outcome}
                    </span>{' '}
                    <span className="ump-sub">{r.match.result}</span>
                  </td>
                </tr>
                {open === r.match.id && (
                  <tr className="pro-scorecard-row">
                    <td colSpan={6}>
                      <Scorecard squad={squad} m={r.match} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Scorecard({ squad, m }: { squad: Squad; m: ProMatch }) {
  return (
    <div className="pro-scorecards">
      {(m.innings ?? []).map((inn, i) => (
        <div key={i} className={`pro-inn${isUs(squad, inn.bat) ? ' us' : ''}`}>
          <div className="pro-inn-head">
            <strong>{shortTeam(inn.bat)}</strong> {inn.total}/{inn.wkts} ({inn.overs} ov) · extras{' '}
            {inn.extras}
          </div>
          <table className="pro-mini-tbl">
            <tbody>
              {inn.batting.map((b) => (
                <tr key={b.n}>
                  <td>{b.n}</td>
                  <td className="ump-sub">{b.out}</td>
                  <td>
                    {b.r} ({b.b})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="pro-mini-tbl">
            <tbody>
              {inn.bowling.map((b) => (
                <tr key={b.n}>
                  <td>{b.n}</td>
                  <td>
                    {b.o}-{b.m}-{b.r}-{b.w}
                  </td>
                  <td className="ump-sub">econ {r1((b.r / Math.max(1, oversToBalls(b.o))) * 6)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/* ── Player panel ── */

function ProPlayerPanel({
  player: p,
  squad,
  format,
  onClose,
}: {
  player: ProPlayer;
  squad: Squad;
  format: ProFormat | 'all';
  onClose: () => void;
}) {
  const bases = useMemo(
    () => baselines(PRO_MATCHES.filter((m) => m.gender === squad.gender)),
    [squad.gender],
  );
  const kinds = DISMISSAL_KINDS;
  const entry = p.bat.lines.filter((l) => l.pos >= 3);
  return (
    <div className="sc-panel-scrim" onClick={onClose}>
      <aside
        className="sc-panel"
        role="dialog"
        aria-modal="true"
        aria-label={p.name}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sc-panel-head">
          <div>
            <div className="sc-panel-eyebrow">
              {squad.name} · {p.role} · {p.formats.join(', ')}
            </div>
            <div className="sc-panel-name">{p.name}</div>
          </div>
          <div className="sc-panel-actions">
            <span className={`pro-sig ${p.signal.kind}`}>{p.signal.label}</span>
            <button type="button" className="sc-panel-close" onClick={onClose} aria-label="Close">
              <Icon.X />
            </button>
          </div>
        </div>
        <div className="pro-panel-body">
          <ul className="pro-reasons">
            {p.signal.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <div className="pv-tiles">
            <Tile label="Games" value={p.matches} sub={`of ${p.squadMatches}`} />
            {p.bat.inns > 0 && (
              <Tile
                label="Runs"
                value={p.bat.runs}
                sub={`avg ${r1(p.bat.avg)} · SR ${r0(p.bat.sr)}`}
              />
            )}
            {p.bowl.inns > 0 && (
              <Tile
                label="Wickets"
                value={p.bowl.wkts}
                sub={`econ ${r1(p.bowl.econ)} · best ${p.bowl.best}`}
              />
            )}
            <Tile
              label="Fielding"
              value={p.field.ct + p.field.st + p.field.ro}
              sub={`${p.field.ct} ct · ${p.field.st} st · ${p.field.ro} ro`}
            />
          </div>
          <div className="pro-idx-row">
            {p.idx.bat && (
              <div>
                <span>Batting index</span>
                <IndexMeter value={p.idx.bat.idx} />
                <small>
                  runs/inns {r0(p.idx.bat.rpiIdx)} · SR {r0(p.idx.bat.srIdx)}
                </small>
              </div>
            )}
            {p.idx.bowl && (
              <div>
                <span>Bowling index</span>
                <IndexMeter value={p.idx.bowl.idx} />
                <small>
                  economy {r0(p.idx.bowl.econIdx)} · wickets {r0(p.idx.bowl.wktIdx)}
                </small>
              </div>
            )}
          </div>

          {p.bat.inns > 0 && (
            <>
              <div className="pro-mini-title">Batting, innings by innings</div>
              <FormColumns
                points={p.bat.lines.map((l, i) => ({
                  key: `${l.matchId}-${i}`,
                  value: l.r,
                  text: `${l.r}${l.isOut ? '' : '*'}`,
                  tip: `${fmtDay(l.date)} ${l.format} v ${l.opp}: ${l.r}${l.isOut ? '' : '*'} off ${l.b} at #${l.pos}${l.cameIn.over ? `, in at ${l.cameIn.score}/${l.cameIn.wkts} (${l.cameIn.over} ov)` : ''}${l.kind ? ` · ${l.kind.toLowerCase()}` : ''}`,
                  faint: !l.isOut,
                }))}
                average={format !== 'all' ? bases[format]?.rpi : undefined}
                averageLabel={`${format} average`}
                valueLabel="Runs"
              />
              <BallUseBars
                rows={[
                  {
                    id: p.name,
                    label: 'Balls faced',
                    balls: p.bat.balls,
                    dots: p.bat.dotBalls === p.bat.balls ? p.bat.dots : null,
                    fours: p.bat.f4,
                    sixes: p.bat.f6,
                    runs: p.bat.runs,
                  },
                ]}
              />
              <div className="pro-mini-title">How out</div>
              <ShareRows
                keys={kinds.slice()}
                rows={[
                  {
                    label: `${p.bat.outs} dismissals`,
                    parts: kinds.map((k) => p.bat.dismissals[k]),
                  },
                ]}
              />
              {entry.length >= 3 && (
                <p className="pro-line">
                  Usually comes in at about{' '}
                  {Math.round(entry.reduce((n, l) => n + l.cameIn.score, 0) / entry.length)} for{' '}
                  {Math.round(entry.reduce((n, l) => n + l.cameIn.wkts, 0) / entry.length)}, batting{' '}
                  {r1(p.bat.avgPos)} · {p.bat.fifties} fift{p.bat.fifties === 1 ? 'y' : 'ies'},{' '}
                  {p.bat.hundreds} hundred{p.bat.hundreds === 1 ? '' : 's'} · HS {p.bat.hs}
                </p>
              )}
            </>
          )}
          {p.bowl.inns > 0 && (
            <>
              <div className="pro-mini-title">Bowling, spell by spell</div>
              <FormColumns
                points={p.bowl.lines.map((l, i) => ({
                  key: `${l.matchId}-${i}`,
                  value: l.w,
                  text: `${l.w}/${l.r}`,
                  tip: `${fmtDay(l.date)} ${l.format} v ${l.opp}: ${l.w}/${l.r} in ${overs(l.balls)} ov · econ ${r1((l.r / l.balls) * 6)} · ${l.dots} dots`,
                }))}
                valueLabel="Wickets"
              />
              <p className="pro-line">
                {overs(p.bowl.balls)} overs · {p.bowl.maidens} maidens · dot balls{' '}
                {r0(p.bowl.dotPct)}% · {p.bowl.wd} wides, {p.bowl.nb} no-balls · {p.bowl.hauls} big
                hauls
              </p>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
