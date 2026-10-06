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
