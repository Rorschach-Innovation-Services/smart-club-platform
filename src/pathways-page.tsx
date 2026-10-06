/* ─── Scouting → Pathways ───
 *
 * The amateur and school system as one pyramid, from a union's results export, laid out the
 * way Player scouting is — Overview · Matches · Leaderboards · Performance map · Teams ·
 * Shortlist — with sides and institutions where that page has players. Everything is a graph
 * behind one filter bar; the drill-downs live in the URL and the shortlist in the browser.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { KPI, Pill } from './atoms';
import {
  AGES,
  FORMAT_LABEL,
  TIER,
  TIERS,
  calendar,
  competitionSummaries,
  coverage,
  filterMatches,
  ladder,
  ladderSort,
  marginBands,
  pipeline,
  pyramid,
  sideName,
  venues,
  type CompetitionSummary,
  type Format,
  type Gender,
  type LadderRow,
  type PathFilter,
  type PathMatch,
  type PipelineRow,
  type Site,
  type Tier,
} from './pathways';
import { PATHWAYS_IS_SAMPLE, PATH_MATCHES } from './pathways-data';
import { Figure, HeatGrid, Pyramid, WeekColumns, type PyramidRow } from './pathways-charts';
import { useProMatches } from './pro-library';
import { QuadrantMap, RankBars, Tile, type MapPt, type Tone } from './pro-charts';

type PwTab = 'overview' | 'matches' | 'leaders' | 'map' | 'teams' | 'shortlist';
const TABS: [PwTab, string][] = [
  ['overview', 'Overview'],
  ['matches', 'Matches'],
  ['leaders', 'Leaderboards'],
  ['map', 'Performance map'],
  ['teams', 'Teams'],
  ['shortlist', 'Shortlist'],
];

const siteTone = (site: Site): Tone => (site === 'school' ? 'squad' : 'third');
const tierTone = (tier: Tier, site: Site): Tone =>
  tier === 'representative' ? 'pool' : siteTone(site);
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`);
const signed = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + v.toFixed(d);
const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
const MONTH = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

/* ── Shortlist: institutions to follow, per browser (like the scouting watchlist) ── */

const TRACK_KEY = 'smartclub.pathways.shortlist.v1';
function readTracked(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(TRACK_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
export interface Tracked {
  keys: string[];
  has: (clubKey: string) => boolean;
  toggle: (clubKey: string) => void;
}
export function useTracked(): Tracked {
  const [keys, setKeys] = useState<string[]>(readTracked);
  return {
    keys,
    has: (k) => keys.includes(k),
    toggle: (k) => {
      const next = keys.includes(k) ? keys.filter((x) => x !== k) : [...keys, k];
      setKeys(next);
      try {
        localStorage.setItem(TRACK_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable — the list still works for this visit */
      }
    },
  };
}

function TrackButton({ clubKey, tracked }: { clubKey: string; tracked: Tracked }) {
  const on = tracked.has(clubKey);
  return (
    <button
      type="button"
      className={`pw-track${on ? ' on' : ''}`}
      aria-pressed={on}
      onClick={(e) => {
        e.stopPropagation();
        tracked.toggle(clubKey);
      }}
    >
      {on ? '★ Shortlisted' : '☆ Shortlist'}
    </button>
  );
}

/** A row of results, compact enough for a table cell; the detail is in the title. */
function MiniStrip({ r, n }: { r: LadderRow; n: number }) {
  return (
    <span className="pw-strip" aria-label={`Last ${n} results`}>
      {r.results.slice(-n).map((x) => (
        <span
          key={x.key}
          className={`pv-res ${x.outcome === 'NR' ? 'D' : x.outcome}`}
          title={x.tip}
        >
          {x.outcome === 'NR' ? '–' : x.outcome}
        </span>
      ))}
    </span>
  );
}

const WEEK_SERIES = [
  { key: 'school', label: 'Schools', tone: 'squad' as Tone },
  { key: 'club', label: 'Clubs', tone: 'third' as Tone },
  { key: 'rep', label: 'Representative', tone: 'pool' as Tone },
];
const weekSeriesOf = (m: PathMatch) =>
  m.tier === 'representative' ? 'rep' : m.site === 'school' ? 'school' : 'club';

/* ── The page ── */

export function PathwaysPage() {
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    next.set('view', 'pathways');
    Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    setParams(next, { replace: true });
  };
  const tab = (get('pwtab') as PwTab) || 'overview';
  const filter: PathFilter = {
    site: (get('site') as Site) || 'all',
    gender: (get('gender') as Gender) || 'all',
    tier: (get('tier') as Tier) || 'all',
    age: get('age') || 'all',
    format: (get('fmt') as Format) || 'all',
    practice: get('practice') === '1',
    from: get('from') || undefined,
    to: get('to') || undefined,
    competition: get('comp') || 'all',
    team: get('q') || undefined,
  };
  const all = PATH_MATCHES;
  const ms = useMemo(() => filterMatches(all, filter), [all, params]); // eslint-disable-line react-hooks/exhaustive-deps
  // Charts that compare competitions ignore the competition filter; it picks the drill-down.
  const acrossComps = useMemo(
    () => filterMatches(all, { ...filter, competition: 'all' }),
    [all, params], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const club = get('club') || null;
  const comp = get('comp') || null;
  const pro = useProMatches();
  const tracked = useTracked();
  const openClub = (k: string | null) => set({ club: k, pwtab: 'teams' });

  const ages = useMemo(() => AGES.filter((a) => all.some((m) => m.age === a)), [all]);
  const formats = useMemo(
    () => (Object.keys(FORMAT_LABEL) as Format[]).filter((f) => all.some((m) => m.format === f)),
    [all],
  );
  const competitions = useMemo(() => competitionSummaries(all), [all]);
  const span = useMemo(
    () => (all.length ? { from: all[0].date, to: all[all.length - 1].date } : null),
    [all],
  );

  if (!all.length) return <div className="ss-empty">No results exports yet.</div>;

  return (
    <div className="pro pw">
      <div className="pw-filters" role="group" aria-label="Filters">
        <label>
          Site
          <select
            className="field-select"
            value={filter.site}
            onChange={(e) => set({ site: e.target.value === 'all' ? null : e.target.value })}
          >
            <option value="all">Schools and clubs</option>
            <option value="school">Schools</option>
            <option value="club">Clubs</option>
          </select>
        </label>
        <label>
          Gender
          <select
            className="field-select"
            value={filter.gender}
            onChange={(e) => set({ gender: e.target.value === 'all' ? null : e.target.value })}
          >
            <option value="all">Everyone</option>
            <option value="men">Boys &amp; men</option>
            <option value="women">Girls &amp; women</option>
          </select>
        </label>
        <label>
          Tier
          <select
            className="field-select"
            value={filter.tier}
            onChange={(e) => set({ tier: e.target.value === 'all' ? null : e.target.value })}
          >
            <option value="all">Whole pathway</option>
            {[...TIERS]
              .filter((t) => all.some((m) => m.tier === t.key))
              .reverse()
              .map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
          </select>
        </label>
        <label>
          Age
          <select
            className="field-select"
            value={filter.age}
            onChange={(e) => set({ age: e.target.value === 'all' ? null : e.target.value })}
          >
            <option value="all">All ages</option>
            {ages.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label>
          Format
          <select
            className="field-select"
            value={filter.format}
            onChange={(e) => set({ fmt: e.target.value === 'all' ? null : e.target.value })}
          >
            <option value="all">All formats</option>
            {formats.map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABEL[f]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Competition
          <select
            className="field-select"
            value={filter.competition}
            onChange={(e) => set({ comp: e.target.value === 'all' ? null : e.target.value })}
          >
            <option value="all">All competitions</option>
            {competitions.map((c) => (
              <option key={c.competition} value={c.competition}>
                {c.competition}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            className="field-input"
            type="date"
            value={filter.from ?? ''}
            min={span?.from}
            max={span?.to}
            onChange={(e) => set({ from: e.target.value || null })}
          />
        </label>
        <label>
          To
          <input
            className="field-input"
            type="date"
            value={filter.to ?? ''}
            min={span?.from}
            max={span?.to}
            onChange={(e) => set({ to: e.target.value || null })}
          />
        </label>
        <label>
          Team or club
          <input
            className="field-input"
            type="search"
            placeholder="Search…"
            value={filter.team ?? ''}
            onChange={(e) => set({ q: e.target.value || null })}
          />
        </label>
        <label className="pw-check">
          <input
            type="checkbox"
            checked={!!filter.practice}
            onChange={(e) => set({ practice: e.target.checked ? '1' : null })}
          />
          Include practice games
        </label>
        <span className="pw-count">
          <b>{ms.length.toLocaleString()}</b> of {all.length.toLocaleString()} matches
          {PATHWAYS_IS_SAMPLE ? ' · sample data, invented names' : ''}
        </span>
      </div>

      <div className="sc-tabs" role="tablist" aria-label="Pathways views">
        {TABS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={tab === k ? 'on' : ''}
            onClick={() => set({ pwtab: k === 'overview' ? null : k })}
          >
            {label}
            {k === 'shortlist' && tracked.keys.length ? ` (${tracked.keys.length})` : ''}
          </button>
        ))}
      </div>

      {tab === 'overview' &&
        (comp ? (
          <CompetitionOverview
            comp={comp}
            summaries={competitions}
            ms={ms}
            tracked={tracked}
            openClub={openClub}
            clear={() => set({ comp: null })}
          />
        ) : (
          <OverviewView
            ms={ms}
            summaries={competitionSummaries(ms)}
            proCount={pro.matches.length}
            proSource={pro.source}
            activeTier={filter.tier === 'all' ? null : (filter.tier as Tier)}
            pickTier={(t) => set({ tier: filter.tier === t ? null : t })}
            pickComp={(c) => set({ comp: c })}
          />
        ))}
      {tab === 'matches' && <MatchesView ms={ms} />}
      {tab === 'leaders' && <LeaderboardsView ms={ms} tracked={tracked} openClub={openClub} />}
      {tab === 'map' && (
        <PerformanceMapView
          ms={ms}
          acrossComps={acrossComps}
          summaries={competitionSummaries(acrossComps)}
          tracked={tracked}
          openClub={openClub}
          pickComp={(c) => set({ comp: c, pwtab: null })}
        />
      )}
      {tab === 'teams' && (
        <TeamsView ms={ms} club={club} tracked={tracked} pick={(k) => set({ club: k })} />
      )}
      {tab === 'shortlist' && <ShortlistView ms={all} tracked={tracked} openClub={openClub} />}
    </div>
  );
}

/* ── Overview ── */

function OverviewView({
  ms,
  summaries,
  proCount,
  proSource,
  activeTier,
  pickTier,
  pickComp,
}: {
  ms: PathMatch[];
  summaries: CompetitionSummary[];
  proCount: number;
  proSource: string;
  activeTier: Tier | null;
  pickTier: (t: Tier) => void;
  pickComp: (c: string) => void;
}) {
  const tiers = useMemo(() => pyramid(ms), [ms]);
  const cov = useMemo(() => coverage(ms), [ms]);
  const weeks = useMemo(() => calendar(ms), [ms]);
  const byWeek = useMemo(() => {
    const map = new Map<string, Record<string, number>>();
    for (const m of ms) {
      const w = weeks.find((x) => x.week <= m.date && m.date < addDays(x.week, 7))?.week;
      if (!w) continue;
      const row = map.get(w) ?? {};
      const k = weekSeriesOf(m);
      row[k] = (row[k] ?? 0) + 1;
      map.set(w, row);
    }
    return map;
  }, [ms, weeks]);
  const decidedN = ms.filter((m) => m.result.winner !== null).length;
  const abandoned = ms.filter(
    (m) => m.result.kind === 'abandoned' || m.result.kind === 'no-result',
  ).length;
  const clubs = new Set(ms.flatMap((m) => m.sides.map((s) => s.clubKey))).size;
  const rows: PyramidRow[] = [
    {
      key: 'professional',
      label: 'Professional',
      sub: 'Franchise cricket',
      parts: [{ tone: 'pool', value: proCount, label: 'Matches' }],
      text: proCount
        ? `${proCount} matches · ${proSource === 'library' ? 'match library' : proSource}`
        : 'No franchise matches yet',
      hollow: true,
    },
    ...[...tiers]
      .filter((t) => t.tier !== 'other')
      .sort((a, b) => TIER[b.tier].rung - TIER[a.tier].rung)
      .map((t) => ({
        key: t.tier,
        label: TIER[t.tier].label,
        sub: TIER[t.tier].blurb,
        parts:
          t.tier === 'representative'
            ? [{ tone: 'pool' as Tone, value: t.matches, label: 'Representative' }]
            : [
                {
                  tone: 'squad' as Tone,
                  value: t.competitions
                    .filter((c) => c.site === 'school')
                    .reduce((n, c) => n + c.matches, 0),
                  label: 'Schools',
                },
                {
                  tone: 'third' as Tone,
                  value: t.competitions
                    .filter((c) => c.site === 'club')
                    .reduce((n, c) => n + c.matches, 0),
                  label: 'Clubs',
                },
              ],
        text: `${t.matches} · ${t.teams} sides · ${t.competitions.length} comp${t.competitions.length === 1 ? '' : 's'}`,
      })),
  ];
  const formatsByTier = tiers.filter((t) => t.tier !== 'other');
  const formatCols = (Object.keys(FORMAT_LABEL) as Format[]).filter((f) =>
    formatsByTier.some((t) => (t.formats[f] ?? 0) > 0),
  );
  let lastMonth = '';
  return (
    <>
      <div className="kpi-strip sc-kpis">
        <KPI
          label="Matches"
          num={ms.length.toLocaleString()}
          sub={`${summaries.length} competitions`}
        />
        <KPI
          label="Decided"
          num={pct(ms.length ? Math.round((decidedN / ms.length) * 100) : null)}
          sub={`${abandoned} abandoned or no result`}
        />
        <KPI
          label="Clubs & schools"
          num={clubs}
          sub={`${new Set(ms.flatMap((m) => m.sides.map((s) => s.side))).size} sides`}
        />
        <KPI
          label="Girls & women"
          num={pct(
            ms.length
              ? Math.round((ms.filter((m) => m.gender === 'women').length / ms.length) * 100)
              : null,
          )}
          sub="share of matches"
        />
      </div>
      <Figure
        title="The pathway"
        sub="Matches at every tier, bottom to top · navy schools, sky clubs, gold representative · the franchise sits above it · tap a tier to focus the page on it"
      >
        <Pyramid
          rows={rows}
          onPick={(k) => k !== 'professional' && pickTier(k as Tier)}
          active={activeTier}
        />
      </Figure>
      <div className="pw-grid-2">
        <Figure
          title="Where the pathway is dense, and where it thins"
          sub="Matches by tier and age group · a pale or empty cell is a step with little cricket in it"
        >
          <HeatGrid
            label="Matches by tier and age"
            rowLabel="Tier"
            rows={cov.tiers.map((t) => ({ key: t, label: TIER[t].label }))}
            cols={cov.ages.map((a) => ({ key: a, label: a }))}
            cell={(t, a) => {
              const v = cov.cell(t as Tier, a);
              return v ? { value: v } : null;
            }}
            max={cov.max}
          />
        </Figure>
        <Figure
          title="Formats by tier"
          sub="The professional game is T20, 50-over and time cricket: where does the pathway play them?"
        >
          <HeatGrid
            label="Formats by tier"
            rowLabel="Tier"
            rows={[...formatsByTier]
              .sort((a, b) => TIER[b.tier].rung - TIER[a.tier].rung)
              .map((t) => ({ key: t.tier, label: TIER[t.tier].label }))}
            cols={formatCols.map((f) => ({ key: f, label: FORMAT_LABEL[f] }))}
            cell={(t, f) => {
              const v = formatsByTier.find((x) => x.tier === t)?.formats[f as Format] ?? 0;
              return v ? { value: v } : null;
            }}
            max={Math.max(
              1,
              ...formatsByTier.flatMap((t) => Object.values(t.formats).map((v) => v ?? 0)),
            )}
          />
        </Figure>
      </div>
      <Figure
        title="When the pathway plays"
        sub="Matches per week · schools, clubs and representative cricket · where they overlap, a scout has to choose"
      >
        <WeekColumns
          weeks={weeks.map((w) => w.week)}
          series={WEEK_SERIES}
          value={(w, s) => byWeek.get(w)?.[s] ?? 0}
          marks={(w) => {
            const mo = MONTH(w);
            if (mo === lastMonth) return null;
            lastMonth = mo;
            return mo;
          }}
        />
      </Figure>
      <Figure
        title="Competition by competition"
        sub="What each competition gives a scout · tap one for its ladder and strength map"
      >
        <div className="tbl-w">
          <table className="tbl sc-tbl pw-ladder" aria-label="Competitions">
            <thead>
              <tr>
                <th>Competition</th>
                <th>Tier</th>
                <th className="hide-narrow">Ages</th>
                <th className="num">Matches</th>
                <th className="num">Sides</th>
                <th className="num">Close</th>
                <th className="num">Abandoned</th>
                <th className="num hide-narrow">Bat 1st wins</th>
                <th className="num hide-narrow">Avg 1st inns</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((c) => (
                <tr key={c.competition} className="pick" onClick={() => pickComp(c.competition)}>
                  <td>
                    <strong>{c.competition}</strong>
                  </td>
                  <td>
                    <Pill
                      tone={
                        c.tier === 'representative' ? 'gold' : c.site === 'school' ? 'navy' : 'teal'
                      }
                    >
                      {TIER[c.tier].label}
                    </Pill>
                  </td>
                  <td className="hide-narrow">{c.ages.join(', ')}</td>
                  <td className="num">{c.matches}</td>
                  <td className="num">{c.teams}</td>
                  <td className="num">{pct(c.closePct)}</td>
                  <td className="num">{pct(c.abandonedPct)}</td>
                  <td className="num hide-narrow">{pct(c.batFirstWinPct)}</td>
                  <td className="num hide-narrow">{c.avgFirstInnings ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Figure>
    </>
  );
}

/** The Overview with one competition chosen: its ladder, strength map and how games are won. */
function CompetitionOverview({
  comp,
  summaries,
  ms,
  tracked,
  openClub,
  clear,
}: {
  comp: string;
  summaries: CompetitionSummary[];
  ms: PathMatch[];
  tracked: Tracked;
  openClub: (k: string) => void;
  clear: () => void;
}) {
  const c = summaries.find((x) => x.competition === comp);
  const rows = useMemo(() => ladder(ms).sort(ladderSort), [ms]);
  const bands = useMemo(() => marginBands(ms), [ms]);
  const rated = rows.filter((r) => r.played >= 2 && r.rrFor !== null && r.rrAgainst !== null);
  const avgFor = rated.length ? rated.reduce((n, r) => n + (r.rrFor ?? 0), 0) / rated.length : 0;
  const avgAg = rated.length ? rated.reduce((n, r) => n + (r.rrAgainst ?? 0), 0) / rated.length : 0;
  const points: MapPt[] = rated.map((r) => ({
    id: r.clubKey,
    label: r.label,
    sub: `${r.played} played · ${pct(r.winPct)} won`,
    x: avgFor ? Math.round(((r.rrFor ?? 0) / avgFor) * 100) : 100,
    y: r.rrAgainst ? Math.round((avgAg / r.rrAgainst) * 100) : 100,
    size: r.played,
    tone: tracked.has(r.clubKey) ? 'pool' : (r.winPct ?? 0) >= 60 ? 'squad' : 'context',
    pin: tracked.has(r.clubKey),
    tip: [`scores ${r.rrFor?.toFixed(1)} an over`, `concedes ${r.rrAgainst?.toFixed(1)} an over`],
  }));
  if (!c) return <div className="ss-empty">That competition isn’t in the files.</div>;
  return (
    <Figure
      title={c.competition}
      sub={`${TIER[c.tier].label} · ${c.ages.join(', ')} · ${c.formats.map((f) => FORMAT_LABEL[f]).join(', ')} · ${fmtDay(c.from)} – ${fmtDay(c.to)}`}
      aside={
        <button type="button" className="pro-link" onClick={clear}>
          All competitions
        </button>
      }
    >
      <div className="pv-tiles">
        <Tile label="Matches" value={c.matches} sub={`${c.completed} decided`} />
        <Tile label="Close finishes" value={pct(c.closePct)} sub="≤10 runs or ≤2 wickets" />
        <Tile
          label="Batting first wins"
          value={pct(c.batFirstWinPct)}
          sub={c.avgFirstInnings !== null ? `avg first innings ${c.avgFirstInnings}` : undefined}
        />
        <Tile
          label="Abandoned"
          value={pct(c.abandonedPct)}
          tone={c.abandonedPct > 25 ? 'bad' : 'good'}
        />
      </div>
      <div className="pw-grid-2">
        <div>
          <div className="pro-mini-title">Batting v bowling strength</div>
          {points.length < 3 ? (
            <div className="ss-empty">
              Overs weren’t recorded for enough games to rate the sides.
            </div>
          ) : (
            <QuadrantMap
              points={points}
              xLabel="Scoring rate v the competition (100 = average)"
              yLabel="Runs conceded v the competition (100 = average, higher = tighter)"
              quadrants={[
                'Strong both ways',
                'Bowling carries them',
                'Batting carries them',
                'Struggling',
              ]}
              sizeLabel="games"
              height={320}
              toneLabels={{ squad: 'Winning 60%+', context: 'The rest', pool: 'Shortlisted' }}
              shortLabels={false}
              onPick={(id) => openClub(id)}
            />
          )}
        </div>
        <div>
          <div className="pro-mini-title">How games are won</div>
          <RankBars
            rows={[
              ...bands.runs.map((b) => ({
                id: `r${b.label}`,
                label: `By ${b.label} runs`,
                value: b.n,
                tone: 'squad' as Tone,
              })),
              ...bands.wickets.map((b) => ({
                id: `w${b.label}`,
                label: `By ${b.label} wickets`,
                value: b.n,
                tone: 'third' as Tone,
              })),
              { id: 'tie', label: 'Tied', value: bands.ties, tone: 'pool' as Tone },
            ]}
          />
        </div>
      </div>
      <div className="pro-mini-title">Ladder</div>
      <LadderTable
        rows={rows}
        label={`${c.competition} ladder`}
        tracked={tracked}
        openClub={openClub}
      />
    </Figure>
  );
}

function LadderTable({
  rows,
  label,
  tracked,
  openClub,
}: {
  rows: LadderRow[];
  label: string;
  tracked: Tracked;
  openClub: (k: string) => void;
}) {
  return (
    <div className="tbl-w">
      <table className="tbl pw-ladder" aria-label={label}>
        <thead>
          <tr>
            <th>#</th>
            <th>Side</th>
            <th className="num">P</th>
            <th className="num">W</th>
            <th className="num">L</th>
            <th className="num">T</th>
            <th className="num">NR</th>
            <th className="num">Win %</th>
            <th className="num">NRR</th>
            <th className="num">Avg</th>
            <th>Last 5</th>
            <th className="hide-narrow">Biggest win</th>
            <th aria-label="Shortlist" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key}>
              <td className="num">{i + 1}</td>
              <td>
                <button type="button" className="pro-link" onClick={() => openClub(r.clubKey)}>
                  <strong>{r.label}</strong>
                </button>
                <div className="ml-sub">{r.club}</div>
              </td>
              <td className="num">{r.played}</td>
              <td className="num">{r.won}</td>
              <td className="num">{r.lost}</td>
              <td className="num">{r.tied}</td>
              <td className="num">{r.nr}</td>
              <td className="num">{pct(r.winPct)}</td>
              <td className="num">{signed(r.nrr)}</td>
              <td className="num">{r.avgFor ?? '—'}</td>
              <td>
                <MiniStrip r={r} n={5} />
              </td>
              <td className="hide-narrow">{r.biggestWin ?? '—'}</td>
              <td>
                <TrackButton clubKey={r.clubKey} tracked={tracked} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Matches ── */

function MatchesView({ ms }: { ms: PathMatch[] }) {
  const [limit, setLimit] = useState(120);
  const rows = useMemo(() => [...ms].sort((a, b) => b.date.localeCompare(a.date)), [ms]);
  const score = (m: PathMatch, i: 0 | 1) => {
    const s = m.sides[i];
    if (s.runs === null) return '—';
    return s.innings.map((x) => `${x.runs}/${x.wkts}`).join(' & ');
  };
  return (
    <Figure title="Results" sub={`${rows.length.toLocaleString()} matches, newest first`}>
      <div className="tbl-w">
        <table className="tbl pw-results" aria-label="Results">
          <thead>
            <tr>
              <th>Date</th>
              <th>Competition</th>
              <th>Match</th>
              <th>Result</th>
              <th className="hide-narrow">Venue</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((m) => (
              <tr key={m.id}>
                <td className="pw-score">{m.date}</td>
                <td>
                  {m.competition}
                  {m.division && <div className="ml-sub">{m.division}</div>}
                  <div className="ml-sub">
                    {TIER[m.tier].label} · {m.age} · {FORMAT_LABEL[m.format]}
                  </div>
                </td>
                <td>
                  <div>
                    {m.sides[0].side} <span className="pw-score">{score(m, 0)}</span>
                  </div>
                  <div>
                    {m.sides[1].side} <span className="pw-score">{score(m, 1)}</span>
                  </div>
                </td>
                <td>{m.result.text || (m.status === 'ongoing' ? 'In progress' : '—')}</td>
                <td className="hide-narrow">{m.venue || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > limit && (
        <button
          type="button"
          className="btn btn-outline btn-sm pw-more"
          onClick={() => setLimit((n) => n + 200)}
        >
          Show {Math.min(200, rows.length - limit)} more
        </button>
      )}
    </Figure>
  );
}

/* ── Leaderboards ── */

type LeaderKey = 'winPct' | 'nrr' | 'rrFor' | 'rrAgainst' | 'avgFor' | 'closeWins';
const LEADERS: {
  key: LeaderKey;
  label: string;
  unit: string;
  low?: boolean;
  fmt: (r: LadderRow) => number | null;
}[] = [
  { key: 'winPct', label: 'Win %', unit: '%', fmt: (r) => r.winPct },
  { key: 'nrr', label: 'Net run rate', unit: '', fmt: (r) => r.nrr },
  { key: 'rrFor', label: 'Runs per over', unit: '', fmt: (r) => r.rrFor },
  {
    key: 'rrAgainst',
    label: 'Runs conceded per over',
    unit: '',
    low: true,
    fmt: (r) => r.rrAgainst,
  },
  { key: 'avgFor', label: 'Average score', unit: '', fmt: (r) => r.avgFor },
  {
    key: 'closeWins',
    label: 'Close games won',
    unit: '%',
    fmt: (r) => {
      const close = r.results.filter((x) =>
        /won by (?:[1-9]|10) Runs?\b|won by [12] Wickets?\b|Tie/i.test(x.tip),
      );
      return close.length >= 2
        ? Math.round((close.filter((x) => x.outcome === 'W').length / close.length) * 100)
        : null;
    },
  },
];

function LeaderboardsView({
  ms,
  tracked,
  openClub,
}: {
  ms: PathMatch[];
  tracked: Tracked;
  openClub: (k: string) => void;
}) {
  const [metric, setMetric] = useState<LeaderKey>('winPct');
  const [scope, setScope] = useState<'side' | 'club'>('side');
  const [min, setMin] = useState(4);
  const def = LEADERS.find((l) => l.key === metric) ?? LEADERS[0];
  const rows = useMemo(() => ladder(ms, scope), [ms, scope]);
  const siteOf = useMemo(() => {
    const map = new Map<string, Site>();
    ms.forEach((m) => m.sides.forEach((s) => map.set(s.clubKey, m.site)));
    return map;
  }, [ms]);
  const ranked = rows
    .filter((r) => r.played >= min)
    .map((r) => ({ r, v: def.fmt(r) }))
    .filter((x): x is { r: LadderRow; v: number } => x.v !== null && Number.isFinite(x.v))
    .sort((a, b) => (def.low ? a.v - b.v : b.v - a.v))
    .slice(0, 15);
  const fmt = (v: number) =>
    def.unit === '%'
      ? `${Math.round(v)}%`
      : metric === 'nrr'
        ? signed(v)
        : metric === 'avgFor'
          ? Math.round(v).toString()
          : v.toFixed(2);
  const minNrr = Math.min(0, ...ranked.map((x) => x.v));
  return (
    <div className="card">
      <div className="card-body">
        <div className="pw-lead">
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
            value={scope}
            onChange={(e) => setScope(e.target.value as 'side' | 'club')}
            aria-label="Rank"
          >
            <option value="side">Sides</option>
            <option value="club">Clubs & schools</option>
          </select>
          <select
            className="field-select sc-select"
            value={min}
            onChange={(e) => setMin(Number(e.target.value))}
            aria-label="Minimum games"
          >
            {[2, 4, 6, 10].map((n) => (
              <option key={n} value={n}>
                {n}+ games
              </option>
            ))}
          </select>
        </div>
        {!ranked.length ? (
          <div className="ss-empty">
            Nobody has {min}+ games with this measure in the selection.
          </div>
        ) : (
          <RankBars
            rows={ranked.map(({ r, v }) => ({
              id: r.clubKey,
              label: r.label,
              value: metric === 'nrr' ? v - minNrr : v,
              text: fmt(v),
              tone: tracked.has(r.clubKey)
                ? ('pool' as Tone)
                : siteTone(siteOf.get(r.clubKey) ?? 'club'),
              sub: `${r.played} played · ${pct(r.winPct)} won${scope === 'side' ? ` · ${r.club}` : ''}`,
            }))}
            max={metric === 'winPct' || metric === 'closeWins' ? 100 : undefined}
            onPick={(id) => openClub(id)}
          />
        )}
        <div className="pv-bar-sub">
          Navy schools · sky clubs · gold shortlisted · {def.low ? 'lowest first' : 'highest first'}{' '}
          · tap a bar for the institution
        </div>
      </div>
    </div>
  );
}

/* ── Performance map ── */

function PerformanceMapView({
  ms,
  acrossComps,
  summaries,
  tracked,
  openClub,
  pickComp,
}: {
  ms: PathMatch[];
  acrossComps: PathMatch[];
  summaries: CompetitionSummary[];
  tracked: Tracked;
  openClub: (k: string) => void;
  pickComp: (c: string) => void;
}) {
  const [scope, setScope] = useState<'side' | 'club'>('side');
  const rows = useMemo(() => ladder(ms, scope), [ms, scope]);
  const siteOf = useMemo(() => {
    const map = new Map<string, Site>();
    ms.forEach((m) => m.sides.forEach((s) => map.set(s.clubKey, m.site)));
    return map;
  }, [ms]);
  const rated = rows.filter((r) => r.played >= 3 && r.rrFor !== null && r.rrAgainst !== null);
  const avgFor = rated.length ? rated.reduce((n, r) => n + (r.rrFor ?? 0), 0) / rated.length : 0;
  const avgAg = rated.length ? rated.reduce((n, r) => n + (r.rrAgainst ?? 0), 0) / rated.length : 0;
  const sides: MapPt[] = rated.map((r) => ({
    id: r.clubKey,
    label: r.label,
    sub: `${r.played} played · ${pct(r.winPct)} won`,
    x: avgFor ? Math.round(((r.rrFor ?? 0) / avgFor) * 100) : 100,
    y: r.rrAgainst ? Math.round((avgAg / r.rrAgainst) * 100) : 100,
    size: r.played,
    tone: tracked.has(r.clubKey) ? 'pool' : siteTone(siteOf.get(r.clubKey) ?? 'club'),
    pin: tracked.has(r.clubKey),
    tip: [`scores ${r.rrFor?.toFixed(1)} an over`, `concedes ${r.rrAgainst?.toFixed(1)} an over`],
  }));
  const withSignal = summaries.filter(
    (c) => c.closePct !== null && c.dominance !== null && c.matches >= 8,
  );
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const comps: MapPt[] = withSignal.map((c) => ({
    id: c.competition,
    label: sideName(c.competition),
    sub: `${TIER[c.tier].label} · ${c.matches} matches`,
    x: c.closePct ?? 0,
    y: 100 - (c.dominance ?? 0),
    size: c.matches,
    tone: tierTone(c.tier, c.site),
    tip: [
      `${c.closePct}% of decided games close`,
      `top side ${c.dominance} points above the median`,
      `${c.abandonedPct}% abandoned`,
    ],
  }));
  return (
    <>
      <Figure
        title="Batting v bowling strength"
        sub="Every side with 3+ games and overs recorded, against the selection's average (100) · bubble = games · gold = shortlisted · tap for the institution"
        aside={
          <select
            className="field-select sc-select"
            value={scope}
            onChange={(e) => setScope(e.target.value as 'side' | 'club')}
            aria-label="Map"
          >
            <option value="side">Sides</option>
            <option value="club">Clubs & schools</option>
          </select>
        }
      >
        {sides.length < 3 ? (
          <div className="ss-empty">
            Overs weren’t recorded for enough games to rate the sides here.
          </div>
        ) : (
          <QuadrantMap
            points={sides}
            xLabel="Scoring rate (100 = selection average)"
            yLabel="Runs conceded (100 = average, higher = tighter)"
            quadrants={[
              'Strong both ways',
              'Bowling carries them',
              'Batting carries them',
              'Struggling',
            ]}
            sizeLabel="games"
            height={400}
            toneLabels={{ squad: 'Schools', third: 'Clubs', pool: 'Shortlisted' }}
            shortLabels={false}
            onPick={(id) => openClub(id)}
          />
        )}
      </Figure>
      <Figure
        title="Where results are earned"
        sub="Each dot is a competition · right = more close finishes, up = more even ladder · the top-right is where a result says the most about a side · tap for its ladder"
      >
        {comps.length < 2 ? (
          <div className="ss-empty">
            Fewer than two competitions with enough decided games here.
          </div>
        ) : (
          <QuadrantMap
            points={comps}
            xLabel="Close finishes (% of decided games)"
            yLabel="Even ladder (100 − top side's lead over the median)"
            refX={med(withSignal.map((c) => c.closePct ?? 0))}
            refY={med(withSignal.map((c) => 100 - (c.dominance ?? 0)))}
            quadrants={[
              'Tight and even',
              'Even, but games run away',
              'Tight, one side on top',
              'One-sided',
            ]}
            sizeLabel="matches"
            onPick={(id) => pickComp(id)}
            toneLabels={{ squad: 'Schools', third: 'Clubs', pool: 'Representative' }}
            shortLabels={false}
          />
        )}
      </Figure>
      <Figure
        title="Competitiveness, competition by competition"
        sub="Close finishes and abandonments · a league that loses a third of its games to the weather gives a scout a third less to go on"
      >
        <div className="pw-grid-2">
          <RankBars
            rows={summaries
              .filter((c) => c.closePct !== null && c.matches >= 8)
              .sort((a, b) => (b.closePct ?? 0) - (a.closePct ?? 0))
              .slice(0, 14)
              .map((c) => ({
                id: c.competition,
                label: c.competition,
                value: c.closePct ?? 0,
                tone: tierTone(c.tier, c.site),
                sub: `${c.matches} matches`,
              }))}
            max={Math.max(30, ...summaries.map((c) => c.closePct ?? 0))}
            unit="% close"
            onPick={(id) => pickComp(id)}
          />
          <RankBars
            rows={summaries
              .filter((c) => c.matches >= 8)
              .sort((a, b) => b.abandonedPct - a.abandonedPct)
              .slice(0, 14)
              .map((c) => ({
                id: c.competition,
                label: c.competition,
                value: c.abandonedPct,
                tone: 'risk' as Tone,
                sub: `${c.abandoned} of ${c.matches}`,
              }))}
            max={Math.max(30, ...summaries.map((c) => c.abandonedPct))}
            unit="% abandoned"
            onPick={(id) => pickComp(id)}
          />
        </div>
        <div className="pv-bar-sub">
          {acrossComps.length.toLocaleString()} matches across competitions in this selection
        </div>
      </Figure>
    </>
  );
}

/* ── Teams ── */

function TeamsView({
  ms,
  club,
  tracked,
  pick,
}: {
  ms: PathMatch[];
  club: string | null;
  tracked: Tracked;
  pick: (c: string | null) => void;
}) {
  const rows = useMemo(() => pipeline(ms).filter((p) => p.matches >= 3), [ms]);
  const ages = AGES.filter((a) => ms.some((m) => m.age === a));
  const top = rows.slice(0, 28);
  const maxCell = Math.max(1, ...top.flatMap((p) => p.rungs.map((r) => r.played)));
  const juniors = (p: PipelineRow) =>
    p.rungs.filter((r) => AGES.indexOf(r.age) <= AGES.indexOf('U13'));
  const seniors = (p: PipelineRow) =>
    p.rungs.filter((r) => AGES.indexOf(r.age) > AGES.indexOf('U13'));
  const winOf = (rs: PipelineRow['rungs']) => {
    const played = rs.reduce((n, r) => n + r.played, 0);
    return played >= 5 ? Math.round((rs.reduce((n, r) => n + r.won, 0) / played) * 100) : null;
  };
  const points: MapPt[] = rows
    .map((p) => ({ p, jr: winOf(juniors(p)), sr: winOf(seniors(p)) }))
    .filter((x): x is { p: PipelineRow; jr: number; sr: number } => x.jr !== null && x.sr !== null)
    .map(({ p, jr, sr }) => ({
      id: p.clubKey,
      label: p.club,
      sub: `${p.breadth} rungs · ${p.matches} matches`,
      x: jr,
      y: sr,
      size: p.matches,
      tone: tracked.has(p.clubKey) ? 'pool' : siteTone(p.site),
      pin: tracked.has(p.clubKey),
    }));
  const sel = pipeline(ms).find((p) => p.clubKey === club) ?? null;
  const breadth4 = rows.filter((p) => p.breadth >= 4).length;
  return (
    <>
      {sel && <ClubCard p={sel} ms={ms} tracked={tracked} close={() => pick(null)} />}
      <div className="kpi-strip sc-kpis">
        <KPI label="Clubs & schools" num={rows.length} sub="with 3+ matches" />
        <KPI label="Fielding 4+ age rungs" num={breadth4} sub="the ladder in one place" />
        <KPI
          label="Rungs per institution"
          num={
            rows.length ? (rows.reduce((n, p) => n + p.breadth, 0) / rows.length).toFixed(1) : '—'
          }
          sub="average"
        />
        <KPI
          label="Reach the top tiers"
          num={rows.filter((p) => TIER[p.topTier].rung >= TIER.presidents.rung).length}
          sub="Presidents, Premier or representative"
        />
      </div>
      <Figure
        title="Who fields the ladder"
        sub="Games played by each club or school at each age rung · the widest ladders first · tap a row for the institution"
      >
        <HeatGrid
          label="Club or school"
          rowLabel="Club or school"
          rows={top.map((p) => ({
            key: p.clubKey,
            label: p.club,
            sub: `${p.site === 'school' ? 'School' : 'Club'} · ${TIER[p.topTier].label}`,
          }))}
          cols={ages.map((a) => ({ key: a, label: a }))}
          cell={(k, a) => {
            const r = top.find((p) => p.clubKey === k)?.rungs.find((x) => x.age === a);
            return r
              ? {
                  value: r.played,
                  text: String(r.sides),
                  tip: `${top.find((p) => p.clubKey === k)?.club} ${a}: ${r.sides} side${r.sides === 1 ? '' : 's'} · ${r.played} played · ${pct(r.winPct)} won`,
                }
              : null;
          }}
          max={maxCell}
          onPick={(k) => pick(k)}
        />
        <div className="pv-bar-sub">
          The number is how many sides; the shade is how much cricket.
        </div>
      </Figure>
      <Figure
        title="Juniors v seniors"
        sub="Win rate up to U13 against win rate from U14 and the senior sides · strong juniors with weak seniors is where talent leaks out of the pathway"
      >
        {points.length < 3 ? (
          <div className="ss-empty">
            Not enough institutions with 5+ games at both ends of the ladder.
          </div>
        ) : (
          <QuadrantMap
            points={points}
            xLabel="Junior win % (U9–U13)"
            yLabel="Senior win % (U14 and up)"
            refX={50}
            refY={50}
            quadrants={[
              'Strong all the way up',
              'Strong seniors, thin juniors',
              'Strong juniors — watch the step up',
              'Developing',
            ]}
            sizeLabel="matches"
            onPick={(id) => pick(id)}
            toneLabels={{ squad: 'Schools', third: 'Clubs', pool: 'Shortlisted' }}
            shortLabels={false}
          />
        )}
      </Figure>
    </>
  );
}

function ClubCard({
  p,
  ms,
  tracked,
  close,
}: {
  p: PipelineRow;
  ms: PathMatch[];
  tracked: Tracked;
  close: () => void;
}) {
  const mine = useMemo(
    () => ms.filter((m) => m.sides.some((s) => s.clubKey === p.clubKey)),
    [ms, p],
  );
  const sides = useMemo(
    () =>
      ladder(mine)
        .filter((r) => r.clubKey === p.clubKey)
        .sort((a, b) => b.played - a.played),
    [mine, p],
  );
  const whole = useMemo(() => ladder(mine, 'club').find((r) => r.key === p.clubKey), [mine, p]);
  const rungBars = p.rungs
    .filter((r) => r.played >= 2)
    .map((r) => ({
      id: r.age,
      label: r.age,
      value: r.winPct ?? 0,
      tone: (r.winPct ?? 0) >= 50 ? ('squad' as Tone) : ('context' as Tone),
      sub: `${r.played} played · ${r.sides} side${r.sides === 1 ? '' : 's'}`,
    }));
  return (
    <Figure
      title={
        <span className="pw-club-head">
          <h3>{p.club}</h3>
          <Pill tone={p.site === 'school' ? 'navy' : 'teal'}>
            {p.site === 'school' ? 'School' : 'Club'}
          </Pill>
          {p.tiers.map((t) => (
            <Pill key={t} tone="muted">
              {TIER[t].label}
            </Pill>
          ))}
          <TrackButton clubKey={p.clubKey} tracked={tracked} />
        </span>
      }
      sub="Grouped by name — a side with an unusual name may be listed under its own entry"
      aside={
        <button type="button" className="pro-link" onClick={close}>
          Close
        </button>
      }
    >
      <div className="pv-tiles">
        <Tile label="Matches" value={p.matches} sub={`${p.rungs.length} age rungs`} />
        <Tile label="Won" value={pct(p.winPct)} tone={(p.winPct ?? 0) >= 50 ? 'good' : 'bad'} />
        <Tile label="Net run rate" value={signed(whole?.nrr)} sub="where overs were recorded" />
        <Tile label="Highest tier" value={TIER[p.topTier].label} />
      </div>
      <div className="pw-grid-2">
        <div>
          <div className="pro-mini-title">Win rate by age rung</div>
          <RankBars rows={rungBars} max={100} unit="%" refValue={50} refLabel="even" />
        </div>
        <div>
          <div className="pro-mini-title">Season so far</div>
          {whole && <MiniStrip r={whole} n={30} />}
          <div className="pv-bar-sub">
            Formats: {[...new Set(mine.map((m) => FORMAT_LABEL[m.format]))].join(', ')}
          </div>
        </div>
      </div>
      <div className="pro-mini-title">Sides</div>
      <div className="tbl-w">
        <table className="tbl pw-ladder" aria-label={`${p.club} sides`}>
          <thead>
            <tr>
              <th>Side</th>
              <th>Competition</th>
              <th className="num">P</th>
              <th className="num">W</th>
              <th className="num">L</th>
              <th className="num">Win %</th>
              <th>Last 5</th>
            </tr>
          </thead>
          <tbody>
            {sides.map((r) => (
              <tr key={r.key}>
                <td>
                  <strong>{r.label}</strong>
                </td>
                <td>{[...new Set(r.results.map((x) => x.competition))].join(', ')}</td>
                <td className="num">{r.played}</td>
                <td className="num">{r.won}</td>
                <td className="num">{r.lost}</td>
                <td className="num">{pct(r.winPct)}</td>
                <td>
                  <MiniStrip r={r} n={5} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Figure>
  );
}

/* ── Shortlist ── */

function ShortlistView({
  ms,
  tracked,
  openClub,
}: {
  ms: PathMatch[];
  tracked: Tracked;
  openClub: (k: string) => void;
}) {
  const rows = useMemo(() => pipeline(ms), [ms]);
  const byClub = useMemo(() => ladder(ms, 'club'), [ms]);
  const list = tracked.keys
    .map((k) => ({ p: rows.find((p) => p.clubKey === k), r: byClub.find((r) => r.key === k) }))
    .filter((x): x is { p: PipelineRow; r: LadderRow | undefined } => !!x.p);
  const vs = useMemo(() => venues(ms).slice(0, 10), [ms]);
  if (!list.length)
    return (
      <div className="card">
        <div className="card-body">
          <div className="ss-empty">
            Nothing shortlisted yet. Shortlist a club or school from a ladder, a leaderboard or its
            card, and it stays here (on this browser) with its season so far.
          </div>
        </div>
      </div>
    );
  return (
    <>
      <Figure
        title="Shortlisted clubs and schools"
        sub="Followed across the whole season, whatever the filters · gold on every map"
      >
        <div className="pw-cards">
          {list.map(({ p, r }) => (
            <div key={p.clubKey} className="pw-card">
              <h4>
                <button type="button" className="pro-link" onClick={() => openClub(p.clubKey)}>
                  {p.club}
                </button>
              </h4>
              <div className="pw-card-sub">
                {p.site === 'school' ? 'School' : 'Club'} · {TIER[p.topTier].label} · {p.breadth}{' '}
                age rung{p.breadth === 1 ? '' : 's'}
              </div>
              <div className="pw-card-stats">
                <span>
                  <b>{p.matches}</b>matches
                </span>
                <span>
                  <b>{pct(p.winPct)}</b>won
                </span>
                <span>
                  <b>{signed(r?.nrr)}</b>net run rate
                </span>
              </div>
              {r && <MiniStrip r={r} n={15} />}
              <div className="pv-bar-sub">
                {p.rungs.map((x) => `${x.age} ${pct(x.winPct)}`).join(' · ')}
              </div>
              <div style={{ marginTop: 8 }}>
                <TrackButton clubKey={p.clubKey} tracked={tracked} />
              </div>
            </div>
          ))}
        </div>
      </Figure>
      <Figure
        title="Where to be"
        sub="Grounds hosting the most cricket in the current selection · gold where representative cricket is played"
      >
        {vs.length ? (
          <RankBars
            rows={vs.map((v) => ({
              id: v.venue,
              label: v.venue,
              value: v.matches,
              tone: v.top === 'representative' ? ('pool' as Tone) : ('squad' as Tone),
              sub: TIER[v.top].label,
            }))}
            unit="matches"
          />
        ) : (
          <div className="ss-empty">No venues recorded.</div>
        )}
      </Figure>
    </>
  );
}
