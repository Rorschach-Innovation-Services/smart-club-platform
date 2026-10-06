/* ─── Scouting → Pathways ───
 *
 * Developmental milestones: the bar a player has to clear at each stage of the pathway, from
 * age-group cricket to the franchises, who the benchmark players are at each stage, the
 * outliers well clear of their stage, the improvers season on season, and where the players
 * who went up stood below. Then the pyramid itself (schools and club leagues from the union's
 * results). The numbers and rules are in src/milestones.ts.
 */
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { KPI } from './atoms';
import {
  METRICS,
  benchmarkPlayers,
  climbers,
  formatsWithStages,
  improvers,
  isOutlier,
  metricOf,
  allLines,
  stageRatings,
  stageRows,
  stagesOf,
  type Disc,
  type Format,
  type Gender,
  type Line,
  type Move,
  type Rated,
} from './milestones';
import {
  Figure,
  MilestoneLadder,
  PercentileTrack,
  StageStrips,
  type LadderStage,
  type TrackLine,
} from './pathways-charts';
import { SCOUT_POOLS } from './pro-data';
import { shortTeam } from './pro-scorecards';
import { detectSquads } from './pro-team';
import { useProMatches } from './pro-library';
import { Dumbbell, PairBars, QuadrantMap, RankBars, type MapPt, type Tone } from './pro-charts';
import { ResultsScouting } from './results-scouting';
import { SCOUTING_EVENTS } from './scouting-data';

type Sub = 'milestones' | 'improvers' | 'pyramid';
const SUBS: [Sub, string][] = [
  ['milestones', 'Milestones'],
  ['improvers', 'Improvers'],
  ['pyramid', 'Pyramid & leagues'],
];

const r0 = (v: number) => Math.round(v).toString();

/** The measures behind a rating, in words, for tooltips and sub-lines. */
function numbers(l: Line, disc: Disc) {
  return METRICS[disc]
    .map((m) => {
      const v = m.value(l);
      return v === null ? null : `${m.short} ${m.fmt(v)}`;
    })
    .filter(Boolean)
    .join(' · ');
}

export function PathwaysPage() {
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    setParams(next, { replace: true });
  };
  const sub = (get('pw') as Sub) || 'milestones';
  const pro = useProMatches();
  const { lines, proBySeason } = useMemo(
    () => allLines(SCOUTING_EVENTS, SCOUT_POOLS, pro.matches),
    [pro.matches],
  );
  // Franchises whose whole seasons are in the files; their opponents appear only in those games.
  const squads = useMemo(
    () => [...new Set(detectSquads(pro.matches).map((s) => shortTeam(s.name)))],
    [pro.matches],
  );
  const disc: Disc = get('disc') === 'bowl' ? 'bowl' : 'bat';
  const gender: Gender = get('mg') === 'women' ? 'women' : 'men';
  const formats = useMemo(() => formatsWithStages(lines, disc, gender), [lines, disc, gender]);
  const format: Format = (formats.includes(get('mf') as Format) ? get('mf') : formats[0]) as Format;
  const metric = metricOf(disc, get('mm') || METRICS[disc][0].key);

  return (
    <div className="pro pw">
      <div className="sc-tabs" role="tablist" aria-label="Pathways views">
        {SUBS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={sub === k}
            className={sub === k ? 'on' : ''}
            onClick={() => set({ pw: k === 'milestones' ? null : k })}
          >
            {label}
          </button>
        ))}
      </div>

      {sub === 'pyramid' ? (
        <ResultsScouting />
      ) : (
        <>
          <div className="ml-bar" role="group" aria-label="Milestone filters">
            <div className="ml-seg" role="tablist" aria-label="Discipline">
              {(['bat', 'bowl'] as Disc[]).map((d) => (
                <button
                  key={d}
                  type="button"
                  role="tab"
                  aria-selected={disc === d}
                  className={disc === d ? 'on' : ''}
                  onClick={() => set({ disc: d === 'bat' ? null : d, mm: null })}
                >
                  {d === 'bat' ? 'Batting' : 'Bowling'}
                </button>
              ))}
            </div>
            <div className="ml-seg" role="tablist" aria-label="Gender">
              {(['men', 'women'] as Gender[]).map((g) => (
                <button
                  key={g}
                  type="button"
                  role="tab"
                  aria-selected={gender === g}
                  className={gender === g ? 'on' : ''}
                  onClick={() => set({ mg: g === 'men' ? null : g, mf: null })}
                >
                  {g === 'men' ? 'Boys & men' : 'Girls & women'}
                </button>
              ))}
            </div>
            <div className="ml-seg" role="tablist" aria-label="Format">
              {formats.map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={format === f}
                  className={format === f ? 'on' : ''}
                  onClick={() => set({ mf: f })}
                >
                  {f}
                </button>
              ))}
            </div>
            {sub === 'milestones' && (
              <input
                className="field-input"
                type="search"
                placeholder="Place a player…"
                aria-label="Place a player"
                value={get('mq')}
                onChange={(e) => set({ mq: e.target.value || null })}
                style={{ maxWidth: 220 }}
              />
            )}
          </div>
          {!format ? (
            <div className="ss-empty">
              No stage has enough {gender === 'women' ? "girls' or women's" : "boys' or men's"}{' '}
              {disc === 'bat' ? 'batting' : 'bowling'} to draw yet.
            </div>
          ) : sub === 'milestones' ? (
            <Milestones
              lines={lines}
              disc={disc}
              gender={gender}
              format={format}
              metricKey={metric.key}
              pickMetric={(k) => set({ mm: k })}
              query={get('mq')}
            />
          ) : (
            <Improvers
              bySeason={proBySeason}
              squads={squads}
              disc={disc}
              gender={gender}
              format={format}
              team={get('mt') || 'all'}
              pickTeam={(t) => set({ mt: t === 'all' ? null : t })}
              picked={get('mp') || null}
              pick={(id) => set({ mp: id })}
            />
          )}
        </>
      )}
    </div>
  );
}

/* ── Milestones ── */

function Milestones({
  lines,
  disc,
  gender,
  format,
  metricKey,
  pickMetric,
  query,
}: {
  lines: Line[];
  disc: Disc;
  gender: Gender;
  format: Format;
  metricKey: string;
  pickMetric: (k: string) => void;
  query: string;
}) {
  const metric = metricOf(disc, metricKey);
  const stages = useMemo(
    () => stagesOf(lines, disc, gender, format),
    [lines, disc, gender, format],
  );
  const rows = useMemo(
    () => stageRows(lines, disc, metric.key, gender, format),
    [lines, disc, metric.key, gender, format],
  );
  const rated = useMemo(
    () => stageRatings(lines, disc, gender, format),
    [lines, disc, gender, format],
  );
  const bench = useMemo(
    () => benchmarkPlayers(lines, disc, gender, format),
    [lines, disc, gender, format],
  );
  const climbs = useMemo(() => climbers(lines, disc, gender), [lines, disc, gender]);
  const needle = query.trim().toLowerCase();
  const found = needle ? rated.filter((r) => r.line.name.toLowerCase().includes(needle)) : [];
  const outliers = rated.filter((r) => isOutlier(r, disc));
  const top = rows[rows.length - 1];

  const ladder: LadderStage[] = [...rows].reverse().map((r) => {
    const hit = found.find((f) => f.line.stage.key === r.stage.key);
    const v = hit ? metric.value(hit.line) : null;
    return {
      key: r.stage.key,
      label: r.stage.label,
      sub: `${r.q.n} players`,
      n: r.q.n,
      q: r.q,
      benchmark: r.benchmark,
      marker: hit && v !== null ? { value: v, label: hit.line.name } : undefined,
    };
  });
  const byStage = (key: string) => rated.filter((r) => r.line.stage.key === key);
  const trackCols = [
    ...new Map(climbs.flatMap((c) => c.steps.map((s) => [s.stage.key, s.stage] as const))).values(),
  ]
    .sort((a, b) => a.rung - b.rung)
    .map((s) => ({ key: s.key, label: s.label }));
  const track: TrackLine[] = climbs.map((c) => {
    const per = new Map<string, { pct: number[]; tips: string[] }>();
    for (const s of c.steps) {
      const e = per.get(s.stage.key) ?? { pct: [], tips: [] };
      e.pct.push(s.rated.pct);
      e.tips.push(
        `${s.stage.label} ${s.rated.line.format} ${s.rated.pct}th percentile (${s.team})`,
      );
      per.set(s.stage.key, e);
    }
    return {
      id: c.id,
      label: c.name,
      points: [...per.entries()].map(([col, e]) => ({
        col,
        pct: Math.round(e.pct.reduce((a, b) => a + b, 0) / e.pct.length),
        tip: e.tips.join(', '),
      })),
    };
  });

  return (
    <>
      <p className="ml-note">
        No dates of birth are in the sources, so a stage is a level of cricket:{' '}
        {stages.map((s) => `${s.label} (${s.source})`).join(' · ')}. Raw numbers change with the
        opposition, so read standing within a stage — that is what carries upward.
      </p>
      <div className="kpi-strip sc-kpis">
        <KPI
          label="Stages"
          num={stages.length}
          sub={`${format} · ${gender === 'men' ? 'boys & men' : 'girls & women'}`}
        />
        <KPI label="Players rated" num={rated.length} sub="with a fair sample" />
        <KPI label="Outliers" num={outliers.length} sub="both measures 15%+ above their stage" />
        <KPI
          label={`${metric.short} — top 10% at ${top?.stage.label ?? '—'}`}
          num={top ? metric.fmt(top.benchmark) : '—'}
          sub={top ? `median ${metric.fmt(top.q.p50)}` : undefined}
        />
      </div>

      <Figure
        title="The bar at each stage"
        sub={`${metric.label}, ${format}: the middle half, the 10th–90th percentile, the median and the top-10% mark at every stage · search to place a player`}
        aside={
          <div className="sc-chips" role="tablist" aria-label="Measure">
            {METRICS[disc].map((m) => (
              <button
                key={m.key}
                type="button"
                role="tab"
                aria-selected={metric.key === m.key}
                className={`sc-chip ${metric.key === m.key ? 'on' : ''}`}
                onClick={() => pickMetric(m.key)}
              >
                {m.label}
              </button>
            ))}
          </div>
        }
      >
        {ladder.length ? (
          <MilestoneLadder
            stages={ladder}
            better={metric.better}
            fmt={metric.fmt}
            unit={metric.label}
          />
        ) : (
          <div className="ss-empty">No stage has enough players with this measure.</div>
        )}
        {needle && !found.length && (
          <div className="pv-bar-sub">No rated player matches “{query}” in this format.</div>
        )}
      </Figure>

      <Figure
        title="Outliers at every stage"
        sub="Every rated player, against their own stage (100 = the stage median) · gold = both measures 15%+ above it · the strongest named"
      >
        <StageStrips
          rows={[...stages].reverse().map((s) => {
            const rs = byStage(s.key);
            return {
              key: s.key,
              label: s.label,
              sub: `${rs.filter((r) => isOutlier(r, disc)).length} of ${rs.length}`,
              points: rs.map((r) => ({
                id: `${s.key}:${r.line.id}`,
                label: r.line.name,
                value: r.rating,
                outlier: isOutlier(r, disc),
                tip: `${r.line.name} (${r.line.team}) · ${s.label} · rating ${r0(r.rating)}, ${r.pct}th percentile · ${numbers(r.line, disc)}`,
              })),
            };
          })}
        />
      </Figure>

      <Figure
        title="The benchmark players, stage by stage"
        sub="The top 10% of each stage on the overall rating — what the best look like at that level"
      >
        <div className="ml-stages">
          {[...bench].reverse().map((b) => (
            <div key={b.stage.key}>
              <div className="pro-mini-title">
                {b.stage.label} · top {b.players.length} of {b.of}
              </div>
              <RankBars
                rows={b.players.map((r) => ({
                  id: r.line.id,
                  label: r.line.name,
                  value: r.rating,
                  text: r0(r.rating),
                  tone: 'squad' as Tone,
                  sub: `${r.line.team} · ${numbers(r.line, disc)}`,
                }))}
                refValue={100}
                refLabel="stage median"
              />
            </div>
          ))}
        </div>
      </Figure>

      <Figure
        title="Where the players who went up stood below"
        sub="Players found at two stages (same name), by percentile within each stage · the gold band is the top 10%"
      >
        {track.length ? (
          <>
            <PercentileTrack cols={trackCols} lines={track} />
            <div className="pv-bar-sub">
              Matched by name, so check each one. Below the step, these players sat between the{' '}
              {Math.min(...track.map((t) => t.points[0]?.pct ?? 100))}th and{' '}
              {Math.max(...track.map((t) => t.points[0]?.pct ?? 0))}th percentile of their stage.
            </div>
          </>
        ) : (
          <div className="ss-empty">
            No player is in the files at two stages yet. Age-group players are not matched to senior
            names (a shared name is almost always a different person).
          </div>
        )}
      </Figure>
    </>
  );
}

/* ── Improvers ── */

function Improvers({
  bySeason,
  squads,
  disc,
  gender,
  format,
  team,
  pickTeam,
  picked,
  pick,
}: {
  bySeason: Line[];
  /** The franchises with whole seasons in the files; others are their opponents. */
  squads: string[];
  disc: Disc;
  gender: Gender;
  format: Format;
  team: string;
  pickTeam: (t: string) => void;
  picked: string | null;
  pick: (id: string | null) => void;
}) {
  const all = useMemo(
    () =>
      improvers(bySeason, disc, gender, format).filter(
        (m) => !squads.length || squads.includes(m.team),
      ),
    [bySeason, disc, gender, format, squads],
  );
  const teams = [...new Set(all.map((m) => m.team))].sort();
  const moves = team === 'all' ? all : all.filter((m) => m.team === team);
  const up = moves.filter((m) => m.delta >= 15);
  const down = moves.filter((m) => m.delta <= -15);
  const sel = moves.find((m) => m.id === picked) ?? null;
  const risers = [...moves].sort((a, b) => b.delta - a.delta).slice(0, 12);
  const pinned = new Set(risers.slice(0, 6).map((m) => m.id));
  const points: MapPt[] = moves.map((m) => ({
    id: m.id,
    label: m.name,
    sub: `${m.team} · ${m.from} → ${m.to}`,
    x: Math.round(m.before.rating),
    y: Math.round(m.after.rating),
    size: m.after.line.balls + m.after.line.bBalls,
    tone: m.delta >= 15 ? 'pool' : m.delta <= -15 ? 'risk' : 'context',
    pin: pinned.has(m.id) || m.id === picked,
    tip: [
      `${m.from}: ${r0(m.before.rating)} (${m.before.pct}th percentile)`,
      `${m.to}: ${r0(m.after.rating)} (${m.after.pct}th percentile)`,
      `${m.delta >= 0 ? '+' : ''}${m.delta}`,
    ],
  }));
  const dumb = (ms: Move[]) =>
    ms.map((m) => ({
      id: m.id,
      label: m.name,
      from: Math.round(m.before.rating),
      to: Math.round(m.after.rating),
      sub: `${m.team} · ${m.from} → ${m.to}`,
      tag: `${m.delta >= 0 ? '+' : ''}${m.delta}`,
    }));
  if (!all.length)
    return (
      <div className="ss-empty">
        No franchise players have two qualifying seasons of {format}{' '}
        {disc === 'bat' ? 'batting' : 'bowling'} in the files.
      </div>
    );
  return (
    <>
      <div className="ml-bar">
        <label className="field-label" htmlFor="ml-team">
          Franchise
        </label>
        <select
          id="ml-team"
          className="field-select sc-select"
          value={team}
          onChange={(e) => pickTeam(e.target.value)}
        >
          <option value="all">All franchises</option>
          {teams.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="kpi-strip sc-kpis">
        <KPI
          label="Players with two seasons"
          num={moves.length}
          sub={`${format} · rated each season`}
        />
        <KPI label="Improved by 15+" num={up.length} sub="rating points, season on season" />
        <KPI label="Fell by 15+" num={down.length} />
        <KPI
          label="Biggest rise"
          num={risers[0] ? `+${risers[0].delta}` : '—'}
          sub={risers[0] ? `${risers[0].name} · ${risers[0].team}` : undefined}
        />
      </div>
      <Figure
        title="Season on season"
        sub="Each player's rating last season (across) against this season (up), both against that season's franchise average (100) · above the diagonal = improved · gold = up 15+, red = down 15+ · squad players only (opponents appear only in their games against them)"
      >
        <QuadrantMap
          points={points}
          xLabel="Rating in the earlier season"
          yLabel="Rating in the latest season"
          diagonal
          quadrants={[
            'Above average both seasons',
            'Risen above the average',
            'Dropped below the average',
            'Below average both seasons',
          ]}
          sizeLabel="balls"
          toneLabels={{ pool: 'Improved 15+', risk: 'Fell 15+', context: 'Within 15' }}
          onPick={(id) => pick(id)}
        />
      </Figure>
      {sel && (
        <Figure
          title={sel.name}
          sub={`${sel.team} · ${format} · ${sel.from} → ${sel.to} · rating ${r0(sel.before.rating)} → ${r0(sel.after.rating)}`}
          aside={
            <button type="button" className="pro-link" onClick={() => pick(null)}>
              Close
            </button>
          }
        >
          <PairBars
            rows={METRICS[disc]
              .map((m) => {
                const a = m.value(sel.after.line);
                const b = m.value(sel.before.line);
                return a === null || b === null ? null : { label: m.label, ours: a, theirs: b };
              })
              .filter((x): x is { label: string; ours: number; theirs: number } => !!x)}
            ours={sel.to}
            theirs={sel.from}
            fmt={(v) => (v >= 10 ? Math.round(v).toString() : v.toFixed(2))}
          />
          <div className="pv-bar-sub">
            {sel.from}: {numbers(sel.before.line, disc)} (
            {disc === 'bat' ? sel.before.line.balls : sel.before.line.bBalls} balls) · {sel.to}:{' '}
            {numbers(sel.after.line, disc)} (
            {disc === 'bat' ? sel.after.line.balls : sel.after.line.bBalls} balls)
            {METRICS[disc].some((m) => m.better === 'low') ? ' · economy: lower is better' : ''}
          </div>
        </Figure>
      )}
      <div className="pw-grid-2">
        <Figure
          title="The biggest improvers"
          sub="Rating last season → this season · tap for the detail"
        >
          <Dumbbell
            rows={dumb(risers.filter((m) => m.delta > 0))}
            fromLabel="Earlier season"
            toLabel="Latest season"
            onPick={(id) => pick(id)}
            empty="Nobody improved in this selection."
            hint="Hover a player for both seasons · tap for the detail"
          />
        </Figure>
        <Figure title="The biggest drops" sub="Worth a conversation before selection">
          <Dumbbell
            rows={dumb(
              [...moves]
                .sort((a, b) => a.delta - b.delta)
                .slice(0, 8)
                .filter((m) => m.delta < 0),
            )}
            fromLabel="Earlier season"
            toLabel="Latest season"
            onPick={(id) => pick(id)}
            empty="Nobody dropped in this selection."
            hint="Hover a player for both seasons · tap for the detail"
          />
        </Figure>
      </div>
    </>
  );
}

export type { Rated };
