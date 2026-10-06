/* ─── Scouting → Pathways ───
 *
 * The amateur and school system as one pyramid, from a union's results export: where it is
 * dense and where it thins out, which competitions are competitive enough to show real
 * ability, which clubs and schools carry players all the way up, and how strong each side is.
 * Everything is a graph behind one filter bar; the drill-downs live in the URL.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Pill } from './atoms';
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

type PwTab = 'pyramid' | 'competitions' | 'feeders' | 'calendar' | 'results';
const TABS: [PwTab, string][] = [
  ['pyramid', 'Pyramid'],
  ['competitions', 'Competitions'],
  ['feeders', 'Feeders'],
  ['calendar', 'Calendar'],
  ['results', 'Results'],
];

const siteTone = (site: Site): Tone => (site === 'school' ? 'squad' : 'third');
const tierTone = (tier: Tier, site: Site): Tone =>
  tier === 'representative' ? 'pool' : siteTone(site);
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`);
const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
const MONTH = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
const monthKey = (d: string) => d.slice(0, 7);

/** The main hub of the pathway (schools v clubs) and the representative level on top. */
const WEEK_SERIES = [
  { key: 'school', label: 'Schools', tone: 'squad' as Tone },
  { key: 'club', label: 'Clubs', tone: 'third' as Tone },
  { key: 'rep', label: 'Representative', tone: 'pool' as Tone },
];
const weekSeriesOf = (m: PathMatch) =>
  m.tier === 'representative' ? 'rep' : m.site === 'school' ? 'school' : 'club';

export function PathwaysPage() {
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    next.set('view', 'pathways');
    Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    setParams(next, { replace: true });
  };
  const tab = (get('pwtab') as PwTab) || 'pyramid';
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
  // The competition charts compare competitions, so they ignore the competition filter; the
  // drill-down below them is what it selects.
  const acrossComps = useMemo(
    () => filterMatches(all, { ...filter, competition: 'all' }),
    [all, params], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const club = get('club') || null;
  const comp = get('comp') || null;
  const pro = useProMatches();

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

      <div className="pw-tabs" role="tablist" aria-label="Pathways views">
        {TABS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => set({ pwtab: k === 'pyramid' ? null : k })}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'pyramid' && (
        <PyramidView
          ms={ms}
          proCount={pro.matches.length}
          proSource={pro.source}
          activeTier={filter.tier === 'all' ? null : (filter.tier as Tier)}
          pickTier={(t) => set({ tier: filter.tier === t ? null : t })}
        />
      )}
      {tab === 'competitions' && (
        <CompetitionsView
          ms={acrossComps}
          summaries={competitionSummaries(acrossComps)}
          selected={comp}
          pick={(c) => set({ comp: c })}
        />
      )}
      {tab === 'feeders' && <FeedersView ms={ms} club={club} pick={(c) => set({ club: c })} />}
      {tab === 'calendar' && <CalendarView ms={ms} />}
      {tab === 'results' && <ResultsView ms={ms} />}
    </div>
  );
}

/* ── Pyramid ── */

function PyramidView({
  ms,
  proCount,
  proSource,
  activeTier,
  pickTier,
}: {
  ms: PathMatch[];
  proCount: number;
  proSource: string;
  activeTier: Tier | null;
  pickTier: (t: Tier) => void;
}) {
  const tiers = useMemo(() => pyramid(ms), [ms]);
  const cov = useMemo(() => coverage(ms), [ms]);
  const decidedN = ms.filter((m) => m.result.winner !== null).length;
  const abandoned = ms.filter(
    (m) => m.result.kind === 'abandoned' || m.result.kind === 'no-result',
  ).length;
  const clubs = new Set(ms.flatMap((m) => m.sides.map((s) => s.clubKey))).size;
  const comps = new Set(ms.map((m) => m.competition)).size;
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
  const womenByTier = tiers
    .filter((t) => t.tier !== 'other')
    .sort((a, b) => TIER[b.tier].rung - TIER[a.tier].rung)
    .map((t) => ({
      id: t.tier,
      label: TIER[t.tier].label,
      value: t.matches ? Math.round((t.women / t.matches) * 100) : 0,
      tone: 'squad' as Tone,
      sub: `${t.women} of ${t.matches}`,
    }));
  const formatsByTier = tiers.filter((t) => t.tier !== 'other');
  const formatCols = (Object.keys(FORMAT_LABEL) as Format[]).filter((f) =>
    formatsByTier.some((t) => (t.formats[f] ?? 0) > 0),
  );
  return (
    <>
      <div className="pv-tiles">
        <Tile label="Matches" value={ms.length.toLocaleString()} sub="in this selection" />
        <Tile
          label="Decided"
          value={pct(ms.length ? Math.round((decidedN / ms.length) * 100) : null)}
          sub={`${abandoned} abandoned or no result`}
          tone={ms.length && decidedN / ms.length >= 0.7 ? 'good' : 'bad'}
        />
        <Tile label="Clubs & schools" value={clubs} sub={`${comps} competitions`} />
        <Tile
          label="Sides"
          value={new Set(ms.flatMap((m) => m.sides.map((s) => s.side))).size}
          sub="teams named in results"
        />
      </div>
      <Figure
        title="The pathway"
        sub="Matches at every tier, bottom to top · navy schools, sky clubs, gold representative · the franchise sits above it"
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
        title="Girls and women across the pathway"
        sub="Share of each tier's matches that are girls' or women's cricket"
      >
        <RankBars rows={womenByTier} max={100} unit="%" />
      </Figure>
    </>
  );
}

/* ── Competitions ── */

function CompetitionsView({
  ms,
  summaries,
  selected,
  pick,
}: {
  ms: PathMatch[];
  summaries: CompetitionSummary[];
  selected: string | null;
  pick: (c: string | null) => void;
}) {
  const withSignal = summaries.filter(
    (c) => c.closePct !== null && c.dominance !== null && c.matches >= 8,
  );
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const refX = med(withSignal.map((c) => c.closePct ?? 0));
  const refY = med(withSignal.map((c) => 100 - (c.dominance ?? 0)));
  const points: MapPt[] = withSignal.map((c) => ({
    id: c.competition,
    label: sideName(c.competition),
    sub: `${TIER[c.tier].label} · ${c.matches} matches`,
    x: c.closePct ?? 0,
    y: 100 - (c.dominance ?? 0),
    size: c.matches,
    tone: tierTone(c.tier, c.site),
    pin: selected === c.competition,
    tip: [
      `${c.closePct}% of decided games close`,
      `top side ${c.dominance} points above the median`,
      `${c.abandonedPct}% abandoned`,
    ],
  }));
  const sel = summaries.find((c) => c.competition === selected) ?? null;
  const selMs = useMemo(
    () => (sel ? ms.filter((m) => m.competition === sel.competition) : []),
    [ms, sel],
  );
  return (
    <>
      <Figure
        title="Where results are earned"
        sub="Each dot is a competition · right = more close finishes, up = more even ladder · the top-right is where a result says the most about a side"
      >
        {points.length < 2 ? (
          <div className="ss-empty">
            Fewer than two competitions with enough decided games here.
          </div>
        ) : (
          <QuadrantMap
            points={points}
            xLabel="Close finishes (% of decided games)"
            yLabel="Even ladder (100 − top side's lead over the median)"
            refX={refX}
            refY={refY}
            quadrants={[
              'Tight and even',
              'Even, but games run away',
              'Tight, one side on top',
              'One-sided',
            ]}
            sizeLabel="matches"
            onPick={(id) => pick(id)}
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
            onPick={(id) => pick(id)}
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
            onPick={(id) => pick(id)}
          />
        </div>
      </Figure>
      <Figure
        title={sel ? sel.competition : 'One competition in depth'}
        sub={
          sel
            ? `${TIER[sel.tier].label} · ${sel.ages.join(', ')} · ${sel.formats.map((f) => FORMAT_LABEL[f]).join(', ')} · ${fmtDay(sel.from)} – ${fmtDay(sel.to)}`
            : 'Pick a competition from the filter bar, a dot above, or a bar'
        }
        aside={
          sel ? (
            <button type="button" className="pro-link" onClick={() => pick(null)}>
              Clear
            </button>
          ) : undefined
        }
      >
        {sel ? <CompetitionDetail c={sel} ms={selMs} /> : null}
      </Figure>
    </>
  );
}

function CompetitionDetail({ c, ms }: { c: CompetitionSummary; ms: PathMatch[] }) {
  const rows = useMemo(() => ladder(ms).sort(ladderSort), [ms]);
  const bands = useMemo(() => marginBands(ms), [ms]);
  const rated = rows.filter((r) => r.played >= 2 && r.rrFor !== null && r.rrAgainst !== null);
  const avgFor = rated.length ? rated.reduce((n, r) => n + (r.rrFor ?? 0), 0) / rated.length : 0;
  const avgAg = rated.length ? rated.reduce((n, r) => n + (r.rrAgainst ?? 0), 0) / rated.length : 0;
  const points: MapPt[] = rated.map((r) => ({
    id: r.key,
    label: r.label,
    sub: `${r.played} played · ${pct(r.winPct)} won`,
    x: avgFor ? Math.round(((r.rrFor ?? 0) / avgFor) * 100) : 100,
    y: r.rrAgainst ? Math.round((avgAg / r.rrAgainst) * 100) : 100,
    size: r.played,
    tone: (r.winPct ?? 0) >= 60 ? 'squad' : 'context',
    tip: [`scores ${r.rrFor?.toFixed(1)} an over`, `concedes ${r.rrAgainst?.toFixed(1)} an over`],
  }));
  return (
    <>
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
              Overs weren't recorded for enough games to rate the sides.
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
              toneLabels={{ squad: 'Winning 60%+', context: 'The rest' }}
              shortLabels={false}
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
      <div className="tbl-w">
        <table className="tbl pw-ladder" aria-label={`${c.competition} ladder`}>
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
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key}>
                <td className="num">{i + 1}</td>
                <td>
                  <strong>{r.label}</strong>
                  <div className="ml-sub">{r.club}</div>
                </td>
                <td className="num">{r.played}</td>
                <td className="num">{r.won}</td>
                <td className="num">{r.lost}</td>
                <td className="num">{r.tied}</td>
                <td className="num">{r.nr}</td>
                <td className="num">{pct(r.winPct)}</td>
                <td className="num">
                  {r.nrr === null ? '—' : (r.nrr > 0 ? '+' : '') + r.nrr.toFixed(2)}
                </td>
                <td className="num">{r.avgFor ?? '—'}</td>
                <td>
                  <MiniStrip r={r} n={5} />
                </td>
                <td className="hide-narrow">{r.biggestWin ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
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

/* ── Feeders ── */

function FeedersView({
  ms,
  club,
  pick,
}: {
  ms: PathMatch[];
  club: string | null;
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
      tone: siteTone(p.site),
      pin: club === p.clubKey,
    }));
  const sel =
    rows.find((p) => p.clubKey === club) ?? pipeline(ms).find((p) => p.clubKey === club) ?? null;
  const breadth4 = rows.filter((p) => p.breadth >= 4).length;
  return (
    <>
      <div className="pv-tiles">
        <Tile label="Clubs & schools" value={rows.length} sub="with 3+ matches" />
        <Tile label="Fielding 4+ age rungs" value={breadth4} sub="the ladder in one place" />
        <Tile
          label="Rungs per institution"
          value={
            rows.length ? (rows.reduce((n, p) => n + p.breadth, 0) / rows.length).toFixed(1) : '—'
          }
          sub="average"
        />
        <Tile
          label="Reach the top tiers"
          value={rows.filter((p) => TIER[p.topTier].rung >= TIER.presidents.rung).length}
          sub="Presidents, Premier or representative"
        />
      </div>
      <Figure
        title="Who fields the ladder"
        sub="Games played by each club or school at each age rung · the widest ladders first · tap a row for the institution"
      >
        <HeatGrid
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
            toneLabels={{ squad: 'Schools', third: 'Clubs' }}
            shortLabels={false}
          />
        )}
      </Figure>
      {sel && <ClubCard p={sel} ms={ms} close={() => pick(null)} />}
    </>
  );
}

function ClubCard({ p, ms, close }: { p: PipelineRow; ms: PathMatch[]; close: () => void }) {
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
        <Tile
          label="Net run rate"
          value={
            whole?.nrr === null || whole?.nrr === undefined
              ? '—'
              : (whole.nrr > 0 ? '+' : '') + whole.nrr.toFixed(2)
          }
          sub="where overs were recorded"
        />
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

/* ── Calendar ── */

function CalendarView({ ms }: { ms: PathMatch[] }) {
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
  const months = [...new Set(ms.map((m) => monthKey(m.date)))].sort();
  const tiersActive = [...TIERS]
    .filter((t) => t.key !== 'other' && ms.some((m) => m.tier === t.key))
    .reverse();
  const monthCell = new Map<string, number>();
  for (const m of ms)
    monthCell.set(
      `${m.tier}|${monthKey(m.date)}`,
      (monthCell.get(`${m.tier}|${monthKey(m.date)}`) ?? 0) + 1,
    );
  const vs = useMemo(() => venues(ms).slice(0, 14), [ms]);
  let lastMonth = '';
  return (
    <>
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
      <div className="pw-grid-2">
        <Figure title="Tiers by month" sub="When each level is in season">
          <HeatGrid
            label="Tiers by month"
            rowLabel="Tier"
            rows={tiersActive.map((t) => ({ key: t.key, label: t.label }))}
            cols={months.map((m) => ({ key: m, label: MONTH(`${m}-01`) }))}
            cell={(t, m) => {
              const v = monthCell.get(`${t}|${m}`) ?? 0;
              return v ? { value: v } : null;
            }}
            max={Math.max(1, ...monthCell.values())}
          />
        </Figure>
        <Figure
          title="Where to be"
          sub="Grounds by matches hosted · gold where representative cricket is played"
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
            <div className="ss-empty">No venues recorded in this selection.</div>
          )}
        </Figure>
      </div>
    </>
  );
}

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

/* ── Results ── */

function ResultsView({ ms }: { ms: PathMatch[] }) {
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
