/* ─── Charts for the Pathways view ───
 *
 * Three pieces the professional-team charts don't have: a pyramid (one stacked bar per tier,
 * bottom to top), a heat grid (tier × age, club × age) and weekly stacked columns. Same rules
 * as pro-charts: drawn at the measured width, three hues at most (navy schools, sky clubs,
 * gold representative), grey for context, direct labels, hover detail in text.
 */
import { useState, type ReactNode } from 'react';
import { barPath, useWidth, type Tone } from './pro-charts';

export interface PyramidRow {
  key: string;
  label: string;
  sub?: string;
  /** Segments left to right, each with its own tone. */
  parts: { tone: Tone; value: number; label: string }[];
  /** Text at the bar's end. */
  text: string;
  /** Drawn hollow (e.g. the professional apex when it comes from elsewhere). */
  hollow?: boolean;
}

/** Tiers as stacked horizontal bars, the top of the pathway first. */
export function Pyramid({
  rows,
  onPick,
  active,
}: {
  rows: PyramidRow[];
  onPick?: (key: string) => void;
  active?: string | null;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const [box, W] = useWidth(640);
  const labelW = Math.min(190, Math.max(120, W * 0.28));
  const textW = 120;
  const rowH = 34;
  const H = rows.length * rowH + 8;
  const max = Math.max(1, ...rows.map((r) => r.parts.reduce((n, p) => n + p.value, 0)));
  const plotW = Math.max(40, W - labelW - textW - 8);
  return (
    <div className="pv-trend pw-pyramid" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="The pathway, tier by tier">
        {rows.map((r, i) => {
          const y = 4 + i * rowH;
          const total = r.parts.reduce((n, p) => n + p.value, 0);
          let x = labelW;
          const w = (total / max) * plotW;
          const on = active === r.key;
          return (
            <g
              key={r.key}
              className={`pw-pyr-row${onPick ? ' pick' : ''}${on ? ' on' : ''}`}
              onClick={() => onPick?.(r.key)}
              onMouseEnter={() => setHover(r.key)}
              onMouseLeave={() => setHover(null)}
            >
              <rect x={0} y={y} width={W} height={rowH - 2} fill="transparent" />
              <text
                className={`pv-label${on ? ' strong' : ''}`}
                x={labelW - 10}
                y={y + 14}
                textAnchor="end"
              >
                {r.label}
              </text>
              {r.sub && (
                <text className="pv-tick" x={labelW - 10} y={y + 27} textAnchor="end">
                  {r.sub}
                </text>
              )}
              {r.hollow ? (
                <rect
                  className="pw-pyr-hollow"
                  x={labelW}
                  y={y + 6}
                  width={Math.max(w, 6)}
                  height={rowH - 14}
                  rx={4}
                />
              ) : (
                r.parts
                  .filter((p) => p.value > 0)
                  .map((p, k, all) => {
                    const pw = (p.value / max) * plotW - (k < all.length - 1 ? 2 : 0);
                    const seg = (
                      <path
                        key={p.tone + k}
                        className={`pv-fill ${p.tone}`}
                        d={barPath(x, y + 6, Math.max(pw, 2), rowH - 14, 'right')}
                      />
                    );
                    x += (p.value / max) * plotW;
                    return seg;
                  })
              )}
              <text className="pv-label" x={labelW + Math.max(w, 6) + 8} y={y + 19}>
                {r.text}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="pv-bar-sub">
        {(() => {
          const r = rows.find((x) => x.key === hover);
          if (!r) return onPick ? 'Tap a tier to focus the page on it' : '';
          const parts = r.parts.filter((p) => p.value > 0).map((p) => `${p.label} ${p.value}`);
          return `${r.label}: ${parts.join(' · ') || r.text}`;
        })()}
      </div>
    </div>
  );
}

export interface HeatCell {
  value: number;
  /** Shown in the cell instead of the value. */
  text?: string;
  tip?: string;
}

/** Rows × columns, cell shade by value. */
export function HeatGrid({
  rows,
  cols,
  cell,
  max,
  onPick,
  rowLabel = '',
  empty = '·',
  label,
}: {
  rows: { key: string; label: string; sub?: string }[];
  cols: { key: string; label: string }[];
  cell: (row: string, col: string) => HeatCell | null;
  max: number;
  onPick?: (row: string) => void;
  rowLabel?: string;
  empty?: string;
  /** Accessible name of the grid. */
  label?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  return (
    <div className="pw-heat-wrap">
      <table className="pw-heat" aria-label={label ?? rowLabel ?? 'Heat grid'}>
        <thead>
          <tr>
            <th>{rowLabel}</th>
            {cols.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.key}
              className={onPick ? 'pick' : ''}
              onClick={() => onPick?.(r.key)}
              tabIndex={onPick ? 0 : undefined}
              onKeyDown={(e) => {
                if (onPick && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  onPick(r.key);
                }
              }}
            >
              <th scope="row">
                <span>{r.label}</span>
                {r.sub && <small>{r.sub}</small>}
              </th>
              {cols.map((c) => {
                const v = cell(r.key, c.key);
                if (!v || v.value <= 0)
                  return (
                    <td key={c.key} className="empty">
                      {empty}
                    </td>
                  );
                const a = 0.18 + 0.82 * Math.min(1, v.value / max);
                return (
                  <td
                    key={c.key}
                    onMouseEnter={() => setHover(v.tip ?? `${r.label} · ${c.label}: ${v.value}`)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <span className="pw-cell" style={{ opacity: a }} />
                    <b className={a > 0.55 ? 'light' : ''}>{v.text ?? v.value}</b>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pv-bar-sub">{hover ?? ''}</div>
    </div>
  );
}

export interface WeekSeries {
  key: string;
  label: string;
  tone: Tone;
}

/** Matches per week, stacked by series (three at most). */
export function WeekColumns({
  weeks,
  series,
  value,
  marks,
}: {
  weeks: string[];
  series: WeekSeries[];
  value: (week: string, series: string) => number;
  /** Optional captions under some weeks (e.g. "Dec" at the first week of a month). */
  marks?: (week: string) => string | null;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const [box, W] = useWidth(640);
  const H = 200;
  const pad = { l: 34, r: 8, t: 10, b: 28 };
  const totals = weeks.map((w) => series.reduce((n, s) => n + value(w, s.key), 0));
  const max = Math.max(4, ...totals);
  const slot = (W - pad.l - pad.r) / Math.max(1, weeks.length);
  const bw = Math.max(2, slot - Math.min(3, slot * 0.25));
  const sy = (v: number) => H - pad.b - (v / (max * 1.08)) * (H - pad.t - pad.b);
  const step = max <= 20 ? 5 : max <= 60 ? 10 : max <= 150 ? 25 : 50;
  return (
    <div className="pv-trend" ref={box}>
      <div className="pv-legend" aria-hidden="true">
        {series.map((s) => (
          <span key={s.key}>
            <i className={`pv-key ${s.tone}`} />
            {s.label}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Matches per week">
        {Array.from({ length: Math.floor(max / step) + 1 }, (_, k) => k * step).map((v) => (
          <g key={v}>
            <line className="pv-grid" x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} />
            <text className="pv-tick" x={pad.l - 6} y={sy(v) + 4} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {weeks.map((w, i) => {
          const x = pad.l + i * slot + (slot - bw) / 2;
          let top = 0;
          const tip = `Week of ${w}: ${series
            .map((s) => `${s.label} ${value(w, s.key)}`)
            .join(' · ')} · ${totals[i]} in all`;
          const mark = marks?.(w);
          return (
            <g key={w} onMouseEnter={() => setHover(tip)} onMouseLeave={() => setHover(null)}>
              <rect
                x={x - 1}
                y={pad.t}
                width={bw + 2}
                height={H - pad.t - pad.b}
                fill="transparent"
              />
              {series.map((s) => {
                const v = value(w, s.key);
                if (!v) return null;
                const y0 = sy(top);
                const y1 = sy(top + v);
                top += v;
                return (
                  <rect
                    key={s.key}
                    className={`pv-fill ${s.tone}`}
                    x={x}
                    y={y1}
                    width={bw}
                    height={Math.max(1, y0 - y1 - 1)}
                    rx={1.5}
                  />
                );
              })}
              {mark && (
                <text className="pv-tick" x={x + bw / 2} y={H - pad.b + 16} textAnchor="middle">
                  {mark}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="pv-bar-sub">{hover ?? 'Each column is a week'}</div>
    </div>
  );
}

/** A labelled figure with a caption underneath — every chart on the page sits in one. */
export function Figure({
  title,
  sub,
  children,
  aside,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">{title}</div>
          {sub && <div className="card-sub">{sub}</div>}
        </div>
        {aside}
      </div>
      <div className="card-body">{children}</div>
    </div>
  );
}

/* ── Milestones: the spread of a measure at each stage of the pathway ── */

export interface LadderStage {
  key: string;
  label: string;
  sub?: string;
  n: number;
  q: { p10: number; p25: number; p50: number; p75: number; p90: number };
  /** The top-10% mark (p90, or p10 where lower is better). */
  benchmark: number;
  /** A player to place on this stage's row. */
  marker?: { value: number; label: string };
}

/**
 * One row per stage, the top of the pathway first: 10th–90th percentile (line), the middle half
 * (box), the median (tick) and the top-10% mark (gold diamond, labelled).
 */
export function MilestoneLadder({
  stages,
  better,
  fmt,
  unit,
}: {
  stages: LadderStage[];
  better: 'high' | 'low';
  fmt: (v: number) => string;
  unit: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const [box, W] = useWidth(640);
  const labelW = Math.min(170, Math.max(110, W * 0.24));
  const pad = { r: 54, t: 18, b: 30 };
  const rowH = 54;
  const H = pad.t + stages.length * rowH + pad.b;
  const vals = stages.flatMap((s) => [s.q.p10, s.q.p90, s.benchmark, s.marker?.value ?? s.q.p50]);
  const lo0 = Math.min(...vals);
  const hi0 = Math.max(...vals);
  const span = hi0 - lo0 || 1;
  const lo = Math.max(0, lo0 - span * 0.06);
  const hi = hi0 + span * 0.06;
  const sx = (v: number) => labelW + ((v - lo) / (hi - lo)) * (W - labelW - pad.r);
  const ticks = (() => {
    const raw = (hi - lo) / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => (hi - lo) / s <= 6) ?? mag * 10;
    const out: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  })();
  return (
    <div className="pv-trend" ref={box}>
      <div className="pv-legend" aria-hidden="true">
        <span>
          <i className="pv-key squad" />
          Middle half of the stage
        </span>
        <span>
          <i className="pv-key context" />
          10th–90th percentile
        </span>
        <span>
          <i className="pv-key pool" />
          Top 10% mark — the benchmark
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${unit} at each stage`}>
        {ticks.map((v) => (
          <g key={v}>
            <line className="pv-grid" x1={sx(v)} x2={sx(v)} y1={pad.t - 6} y2={H - pad.b} />
            <text className="pv-tick" x={sx(v)} y={H - pad.b + 16} textAnchor="middle">
              {fmt(v)}
            </text>
          </g>
        ))}
        <text className="pv-axis" x={(labelW + W - pad.r) / 2} y={H - 2} textAnchor="middle">
          {unit}
          {better === 'low' ? ' (lower is better)' : ''}
        </text>
        {stages.map((s, i) => {
          const y = pad.t + i * rowH + rowH / 2;
          const below = stages[i + 1];
          const change = below ? ((s.q.p50 - below.q.p50) / (below.q.p50 || 1)) * 100 : null;
          const tip = `${s.label} · ${s.n} players · median ${fmt(s.q.p50)} · middle half ${fmt(s.q.p25)}–${fmt(s.q.p75)} · top 10% ${better === 'high' ? 'from' : 'at or under'} ${fmt(s.benchmark)}`;
          return (
            <g key={s.key} onMouseEnter={() => setHover(tip)} onMouseLeave={() => setHover(null)}>
              <rect x={0} y={y - rowH / 2} width={W} height={rowH} fill="transparent" />
              <text className="pv-label" x={labelW - 10} y={y - 2} textAnchor="end">
                {s.label}
              </text>
              <text className="pv-tick" x={labelW - 10} y={y + 12} textAnchor="end">
                {s.sub ?? `${s.n} players`}
              </text>
              <line className="ml-whisker" x1={sx(s.q.p10)} x2={sx(s.q.p90)} y1={y} y2={y} />
              <rect
                className="pv-fill squad"
                x={sx(s.q.p25)}
                y={y - 9}
                width={Math.max(2, sx(s.q.p75) - sx(s.q.p25))}
                height={18}
                rx={4}
              />
              <line
                className="ml-median"
                x1={sx(s.q.p50)}
                x2={sx(s.q.p50)}
                y1={y - 12}
                y2={y + 12}
              />
              <path className="ml-bench" d={`M${sx(s.benchmark)},${y - 8}l7,8l-7,8l-7,-8z`} />
              <text className="pv-label" x={sx(s.benchmark)} y={y - 13} textAnchor="middle">
                {fmt(s.benchmark)}
              </text>
              {s.marker && (
                <g>
                  <circle className="pv-dot risk" cx={sx(s.marker.value)} cy={y + 15} r={5} />
                  <text className="pv-tick" x={sx(s.marker.value) + 8} y={y + 19}>
                    {s.marker.label} {fmt(s.marker.value)}
                  </text>
                </g>
              )}
              {change !== null && (
                <text className="pv-tick" x={W - pad.r + 6} y={y + 4}>
                  {change >= 0 ? '+' : ''}
                  {Math.round(change)}%
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="pv-bar-sub">
        {hover ??
          'Right-hand figures: the median against the stage below · hover a stage for its numbers'}
      </div>
    </div>
  );
}

export interface StripRow {
  key: string;
  label: string;
  sub?: string;
  points: { id: string; label: string; value: number; outlier: boolean; tip: string }[];
}

/** Every player at each stage as a dot on their rating (100 = their stage's median). */
export function StageStrips({
  rows,
  onPick,
  labelTop = 3,
}: {
  rows: StripRow[];
  onPick?: (id: string) => void;
  /** Name this many outliers per row. */
  labelTop?: number;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const [box, W] = useWidth(640);
  const labelW = Math.min(150, Math.max(100, W * 0.2));
  const pad = { r: 16, t: 10, b: 30 };
  const rowH = 70;
  const H = pad.t + rows.length * rowH + pad.b;
  const lo = 40;
  const hi = 220;
  const sx = (v: number) =>
    labelW + ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (W - labelW - pad.r);
  return (
    <div className="pv-trend" ref={box}>
      <div className="pv-legend" aria-hidden="true">
        <span>
          <i className="pv-key pool" />
          Outlier — both measures 15%+ above the stage
        </span>
        <span>
          <i className="pv-key context" />
          Everyone else
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Ratings at each stage">
        {[50, 100, 150, 200].map((v) => (
          <g key={v}>
            <line
              className={v === 100 ? 'pv-ref' : 'pv-grid'}
              x1={sx(v)}
              x2={sx(v)}
              y1={pad.t}
              y2={H - pad.b}
            />
            <text className="pv-tick" x={sx(v)} y={H - pad.b + 16} textAnchor="middle">
              {v}
            </text>
          </g>
        ))}
        <text className="pv-axis" x={(labelW + W - pad.r) / 2} y={H - 2} textAnchor="middle">
          Rating within the stage (100 = the stage median)
        </text>
        {rows.map((r, i) => {
          const y0 = pad.t + i * rowH;
          const named = new Set(
            [...r.points]
              .filter((p) => p.outlier)
              .sort((a, b) => b.value - a.value)
              .slice(0, labelTop)
              .map((p) => p.id),
          );
          return (
            <g key={r.key}>
              <text className="pv-label" x={labelW - 10} y={y0 + rowH / 2} textAnchor="end">
                {r.label}
              </text>
              {r.sub && (
                <text className="pv-tick" x={labelW - 10} y={y0 + rowH / 2 + 14} textAnchor="end">
                  {r.sub}
                </text>
              )}
              {r.points.map((p, k) => {
                // A fixed spread inside the row, so dots at one rating don't sit on each other.
                const jitter = ((k * 37) % 23) / 22 - 0.5;
                const cy = y0 + rowH / 2 + jitter * (rowH - 26);
                const cx = sx(p.value);
                return (
                  <g
                    key={p.id}
                    className={onPick ? 'pw-pick' : ''}
                    onMouseEnter={() => setHover(p.tip)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => onPick?.(p.id)}
                  >
                    <circle cx={cx} cy={cy} r={9} fill="transparent" />
                    <circle
                      className={`pv-dot ${p.outlier ? 'pool' : 'context'}`}
                      cx={cx}
                      cy={cy}
                      r={p.outlier ? 5 : 3.5}
                    />
                    {named.has(p.id) && (
                      <text
                        className="pv-label"
                        x={Math.min(cx + 7, W - pad.r - 4)}
                        y={cy - 6}
                        textAnchor={cx > W - 120 ? 'end' : 'start'}
                      >
                        {p.label}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <div className="pv-bar-sub">
        {hover ?? 'Hover a dot for the player · beyond 220 is drawn at the edge'}
      </div>
    </div>
  );
}

export interface TrackLine {
  id: string;
  label: string;
  /** Percentile within each stage, keyed by the stage's column. */
  points: { col: string; pct: number; tip: string }[];
}

/** Percentile within each stage, stage by stage: where players who went up stood below. */
export function PercentileTrack({
  cols,
  lines,
}: {
  cols: { key: string; label: string }[];
  lines: TrackLine[];
}) {
  const [hover, setHover] = useState<string | null>(null);
  const [box, W] = useWidth(640);
  const H = 260;
  const pad = { l: 40, r: 120, t: 14, b: 34 };
  const step = (W - pad.l - pad.r) / Math.max(1, cols.length - 1);
  const sx = (col: string) => pad.l + cols.findIndex((c) => c.key === col) * step;
  const sy = (p: number) => pad.t + (1 - p / 100) * (H - pad.t - pad.b);
  return (
    <div className="pv-trend" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Standing at each stage">
        <rect
          className="ml-band"
          x={pad.l}
          y={sy(100)}
          width={W - pad.l - pad.r}
          height={sy(90) - sy(100)}
        />
        <text className="pv-tick" x={W - pad.r + 6} y={sy(95) + 4}>
          Top 10%
        </text>
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line
              className={v === 50 ? 'pv-ref' : 'pv-grid'}
              x1={pad.l}
              x2={W - pad.r}
              y1={sy(v)}
              y2={sy(v)}
            />
            <text className="pv-tick" x={pad.l - 6} y={sy(v) + 4} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {cols.map((c) => (
          <text
            key={c.key}
            className="pv-label"
            x={sx(c.key)}
            y={H - pad.b + 18}
            textAnchor="middle"
          >
            {c.label}
          </text>
        ))}
        {lines.map((l) => {
          const pts = l.points.filter((p) => cols.some((c) => c.key === p.col));
          const last = pts[pts.length - 1];
          const on = hover === l.id;
          return (
            <g key={l.id} onMouseEnter={() => setHover(l.id)} onMouseLeave={() => setHover(null)}>
              <path
                className={`pv-tline ${on ? 'squad' : 'context'}`}
                d={pts.map((p, k) => `${k ? 'L' : 'M'}${sx(p.col)},${sy(p.pct)}`).join('')}
              />
              {pts.map((p) => (
                <circle
                  key={p.col}
                  className={`pv-dot ${on ? 'squad' : 'context'}`}
                  cx={sx(p.col)}
                  cy={sy(p.pct)}
                  r={5}
                />
              ))}
              {last && (
                <text className="pv-label" x={sx(last.col) + 8} y={sy(last.pct) + 4}>
                  {l.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="pv-bar-sub">
        {(() => {
          const l = lines.find((x) => x.id === hover);
          return l
            ? `${l.label}: ${l.points.map((p) => p.tip).join(' → ')}`
            : 'Percentile within each stage (100 = best) · hover a line for the player';
        })()}
      </div>
    </div>
  );
}
