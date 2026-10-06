/* ─── Charts for the professional team and the scouting maps ───
 *
 * One small visual system (after the national scouting report): navy for our squad, gold for
 * scouted players, red for players at risk, grey for context. The three hues are validated
 * together for colour-blind separation; gold sits below 3:1 on white, so every gold mark
 * carries a direct label or a table beside it. Text never takes a series colour.
 * Bars ≤ 24px with a 4px rounded data end; lines 2px; dots ≥ 8px with a 2px white ring;
 * gridlines solid hairlines. Every chart has a hover tooltip and a legend when it has two or
 * more series.
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type Tone = 'squad' | 'pool' | 'risk' | 'context' | 'third';
export const TONE_LABEL: Record<Tone, string> = {
  squad: 'Squad',
  pool: 'Scouting',
  risk: 'At risk',
  context: 'Everyone else',
  third: 'Other',
};

/** A bar with a 4px rounded data end and a square baseline. */
function barPath(x: number, y: number, w: number, h: number, dir: 'right' | 'up' | 'left') {
  const r = Math.min(4, dir === 'up' ? w / 2 : h / 2, dir === 'up' ? h : w);
  if (w <= 0 || h <= 0) return '';
  if (dir === 'right')
    return `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${w - r}z`;
  if (dir === 'left')
    return `M${x + w},${y}h-${w - r}a${r},${r} 0 0 0 -${r},${r}v${h - 2 * r}a${r},${r} 0 0 0 ${r},${r}h${w - r}z`;
  return `M${x},${y + h}v-${h - r}a${r},${r} 0 0 1 ${r},-${r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - r}z`;
}

/**
 * Draw at the width the chart is given (not a fixed box stretched to fit), so text and marks
 * stay the same size on a phone and a wide monitor. Falls back to `fallback` where there's
 * no layout (tests, first paint).
 */
export function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const cw = el.clientWidth;
      if (cw > 0) setW(Math.max(280, Math.round(cw)));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceTicks(lo: number, hi: number, n = 5) {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n + 1) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

export function Legend({ items }: { items: { tone: Tone; label?: string }[] }) {
  if (items.length < 2) return null;
  return (
    <div className="pv-legend" aria-hidden="true">
      {items.map((i) => (
        <span key={`${i.tone}-${i.label ?? ''}`}>
          <i className={`pv-key ${i.tone}`} />
          {i.label ?? TONE_LABEL[i.tone]}
        </span>
      ))}
    </div>
  );
}

/* ── Quadrant map: index v index, 100 = average, bubble = volume ── */

export interface MapPt {
  id: string;
  label: string;
  /** Second line in the tooltip, e.g. club or role. */
  sub?: string;
  x: number;
  y: number;
  /** Volume (balls faced, overs) — sets the bubble size. */
  size: number;
  tone: Tone;
  /** Always name this point on the chart. */
  pin?: boolean;
  tip?: string[];
}

export function QuadrantMap({
  points,
  xLabel,
  yLabel,
  quadrants,
  sizeLabel,
  onPick,
  height = 360,
  refX = 100,
  refY = 100,
  diagonal,
  toneLabels,
}: {
  points: MapPt[];
  xLabel: string;
  yLabel: string;
  /** Top-right, top-left, bottom-right, bottom-left. */
  quadrants?: [string, string, string, string];
  sizeLabel?: string;
  onPick?: (id: string) => void;
  height?: number;
  refX?: number;
  refY?: number;
  /** Draw y = x (e.g. recent form v season: above the line = improving). */
  diagonal?: boolean;
  /** Legend wording per colour, e.g. { squad: 'Lions', pool: 'Your watchlist' }. */
  toneLabels?: Partial<Record<Tone, string>>;
}) {
  const [hover, setHover] = useState<MapPt | null>(null);
  const [box, W] = useWidth(640);
  // Keep a sensible shape: taller on wide screens, never a letterbox.
  const H = Math.round(Math.max(height * 0.85, Math.min(height * 1.35, W * 0.55)));
  const pad = { l: 48, r: 18, t: 22, b: 44 };
  const valid = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const xs = valid.map((p) => p.x).concat(refX);
  const ys = valid.map((p) => p.y).concat(refY);
  // Keep the axes honest but readable. With a squad-sized set, show everyone; with a big
  // pool, clip the far tails (pinned to the edge, dashed, named with a ›) so one outlier
  // doesn't squash the field.
  const clip = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
    const big = s.length > 60;
    const lo = Math.min(big ? q(0.02) : s[0], refX, refY);
    const hi = Math.max(big ? q(0.98) : s[s.length - 1], refX, refY);
    const padV = (hi - lo) * 0.06 + 4;
    return [lo - padV, hi + padV];
  };
  let [x0, x1] = clip(xs);
  let [y0, y1] = clip(ys);
  if (diagonal) {
    x0 = y0 = Math.min(x0, y0);
    x1 = y1 = Math.max(x1, y1);
  }
  const sx = (v: number) =>
    pad.l + ((Math.min(Math.max(v, x0), x1) - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const sy = (v: number) =>
    H - pad.b - ((Math.min(Math.max(v, y0), y1) - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const maxSize = Math.max(1, ...valid.map((p) => p.size));
  const rad = (s: number) => 4 + 10 * Math.sqrt(Math.max(0, s) / maxSize);
  const order: Tone[] = ['context', 'third', 'squad', 'pool', 'risk'];
  const drawn = [...valid].sort(
    (a, b) => order.indexOf(a.tone) - order.indexOf(b.tone) || b.size - a.size,
  );

  // Labels: pinned points first, then the biggest non-context bubbles, skipping collisions.
  const labels = useMemo(() => {
    // The corner labels are taken space too.
    const placed: { x: number; y: number; w: number }[] = (quadrants ?? []).map((q, i) => {
      const w = q.length * 6 + 8;
      const right = i === 0 || i === 2;
      return { x: right ? W - pad.r - w : pad.l, y: i < 2 ? pad.t + 12 : H - pad.b - 10, w };
    });
    const out = new Map<string, { x: number; y: number; anchor: 'start' | 'end' }>();
    const cands = [...valid]
      .filter((p) => p.tone !== 'context' || p.pin)
      .sort((a, b) => Number(!!b.pin) - Number(!!a.pin) || b.size - a.size);
    for (const p of cands) {
      const text = shortName(p.label);
      const w = text.length * 6.1;
      const cx = sx(p.x);
      const cy = sy(p.y);
      const r = rad(p.size);
      for (const [dx, anchor] of [
        [r + 4, 'start'],
        [-r - 4, 'end'],
      ] as const) {
        const x = anchor === 'start' ? cx + dx : cx + dx - w;
        const y = cy - 2;
        if (x < pad.l || x + w > W - pad.r || y < pad.t + 6) continue;
        if (placed.some((b) => x < b.x + b.w && x + w > b.x && Math.abs(y - b.y) < 12)) continue;
        // Don't write over someone else's bubble.
        const hitsDot = valid.some((o) => {
          if (o.id === p.id) return false;
          const ox = sx(o.x);
          const oy = sy(o.y);
          const orad = rad(o.size);
          return ox + orad > x && ox - orad < x + w && oy + orad > y - 9 && oy - orad < y + 3;
        });
        if (hitsDot) continue;
        placed.push({ x, y, w });
        out.set(p.id, { x: cx + dx, y: cy + 3, anchor });
        break;
      }
      if (out.size >= 14 && !p.pin) break;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valid, x0, x1, y0, y1]);

  const tones = [...new Set(valid.map((p) => p.tone))].sort(
    (a, b) => order.indexOf(b) - order.indexOf(a),
  );
  const qx = sx(refX);
  const qy = sy(refY);
  return (
    <div className="pv-map" ref={box}>
      <Legend items={tones.map((t) => ({ tone: t, label: toneLabels?.[t] }))} />
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${yLabel} against ${xLabel}`}>
        {niceTicks(x0, x1).map((v) => (
          <g key={`x${v}`}>
            <line className="pv-grid" x1={sx(v)} x2={sx(v)} y1={pad.t} y2={H - pad.b} />
            <text className="pv-tick" x={sx(v)} y={H - pad.b + 16} textAnchor="middle">
              {Math.round(v)}
            </text>
          </g>
        ))}
        {niceTicks(y0, y1).map((v) => (
          <g key={`y${v}`}>
            <line className="pv-grid" x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} />
            <text className="pv-tick" x={pad.l - 8} y={sy(v) + 4} textAnchor="end">
              {Math.round(v)}
            </text>
          </g>
        ))}
        {quadrants && (
          <rect
            className="pv-quad-good"
            x={qx}
            y={pad.t}
            width={W - pad.r - qx}
            height={qy - pad.t}
          />
        )}
        {diagonal ? (
          <line className="pv-ref" x1={sx(x0)} y1={sy(y0)} x2={sx(x1)} y2={sy(y1)} />
        ) : null}
        <line className="pv-ref" x1={qx} x2={qx} y1={pad.t} y2={H - pad.b} />
        <line className="pv-ref" x1={pad.l} x2={W - pad.r} y1={qy} y2={qy} />
        <text className="pv-axis" x={(pad.l + W - pad.r) / 2} y={H - 8} textAnchor="middle">
          {xLabel}
        </text>
        <text
          className="pv-axis"
          transform={`translate(13 ${(pad.t + H - pad.b) / 2}) rotate(-90)`}
          textAnchor="middle"
        >
          {yLabel}
        </text>
        {drawn.map((p) => {
          const cx = sx(p.x);
          const cy = sy(p.y);
          const clipped = p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1;
          const l = labels.get(p.id);
          return (
            <g
              key={p.id}
              className={`pv-pt${onPick ? ' click' : ''}`}
              onMouseEnter={() => setHover(p)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onPick?.(p.id)}
            >
              <circle cx={cx} cy={cy} r={Math.max(12, rad(p.size) + 3)} fill="transparent" />
              <circle
                className={`pv-dot ${p.tone}${clipped ? ' clipped' : ''}`}
                cx={cx}
                cy={cy}
                r={rad(p.size)}
              />
              {l && (
                <text className="pv-label" x={l.x} y={l.y} textAnchor={l.anchor}>
                  {shortName(p.label)}
                  {clipped ? ' ›' : ''}
                </text>
              )}
            </g>
          );
        })}
        {quadrants &&
          (
            [
              [W - pad.r - 6, pad.t + 14, 'end', quadrants[0]],
              [pad.l + 6, pad.t + 14, 'start', quadrants[1]],
              [W - pad.r - 6, H - pad.b - 8, 'end', quadrants[2]],
              [pad.l + 6, H - pad.b - 8, 'start', quadrants[3]],
            ] as const
          ).map(([x, y, anchor, text]) => {
            const w = text.length * 6 + 8;
            return (
              <g key={text} className="pv-quad-g" aria-hidden="true">
                <rect
                  className="pv-quad-bg"
                  x={anchor === 'end' ? x - w + 4 : x - 4}
                  y={y - 11}
                  width={w}
                  height={15}
                  rx={4}
                />
                <text className="pv-quad" x={x} y={y} textAnchor={anchor}>
                  {text}
                </text>
              </g>
            );
          })}
      </svg>
      {sizeLabel && (
        <div className="pv-note">Bubble size: {sizeLabel} · 100 = average on both axes</div>
      )}
      {hover && (
        <div
          className="pv-tip"
          style={{ left: `${(sx(hover.x) / W) * 100}%`, top: `${(sy(hover.y) / H) * 100}%` }}
        >
          <strong>{hover.label}</strong>
          {hover.sub && <span>{hover.sub}</span>}
          <span>
            {xLabel.split(' (')[0]}: {Math.round(hover.x)}
          </span>
          <span>
            {yLabel.split(' (')[0]}: {Math.round(hover.y)}
          </span>
          {hover.tip?.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Pieter Rademeyer" → "P Rademeyer" (the report's chart labels). */
export function shortName(n: string) {
  const parts = n.trim().split(/\s+/);
  if (parts.length < 2) return n;
  // Keep particles with the surname: "van der Dussen", "Du Plessis", "Lion-cachet".
  const i = parts.findIndex((p, k) => k > 0 && /^(van|der|de|du|le|la|von)$/i.test(p));
  const sur = i > 0 ? parts.slice(i).join(' ') : parts[parts.length - 1];
  return `${parts[0][0]} ${sur}`;
}

/* ── Horizontal bars (ranked), optional reference line ── */

export interface BarRow {
  id: string;
  label: string;
  value: number;
  tone?: Tone;
  /** Shown at the bar tip instead of the number. */
  text?: string;
  sub?: string;
}

export function RankBars({
  rows,
  max,
  refValue,
  refLabel,
  onPick,
  unit,
}: {
  rows: BarRow[];
  max?: number;
  refValue?: number;
  refLabel?: string;
  onPick?: (id: string) => void;
  unit?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const top = max ?? Math.max(1, ...rows.map((r) => r.value), refValue ?? 0);
  const [box, W] = useWidth(520);
  const rowH = 26;
  const labW = Math.round(Math.min(280, Math.max(140, W * 0.32)));
  const valW = Math.round(Math.min(160, Math.max(80, W * 0.18)));
  const maxChars = Math.floor((labW - 12) / 6.4);
  const plotW = W - labW - valW;
  const H = rows.length * rowH + (refValue !== undefined ? 18 : 6);
  const sx = (v: number) => (Math.max(0, v) / top) * plotW;
  const tones = [...new Set(rows.map((r) => r.tone ?? 'squad'))];
  return (
    <div className="pv-bars" ref={box}>
      <Legend items={tones.map((t) => ({ tone: t }))} />
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Ranked bars">
        {rows.map((r, i) => {
          const y = i * rowH + 4;
          return (
            <g
              key={r.id}
              className={`pv-bar-row${onPick ? ' click' : ''}${hover === r.id ? ' hover' : ''}`}
              onMouseEnter={() => setHover(r.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onPick?.(r.id)}
            >
              <rect x={0} y={y - 2} width={W} height={rowH} fill="transparent" />
              <text className="pv-bar-label" x={labW - 10} y={y + 13} textAnchor="end">
                {r.label.length > maxChars ? `${r.label.slice(0, maxChars - 1)}…` : r.label}
              </text>
              <path
                className={`pv-fill ${r.tone ?? 'squad'}`}
                d={barPath(labW, y + 2, sx(r.value), 16, 'right')}
              />
              <text className="pv-bar-val" x={labW + sx(r.value) + 6} y={y + 14}>
                {r.text ?? `${Math.round(r.value)}${unit ?? ''}`}
              </text>
            </g>
          );
        })}
        {refValue !== undefined && (
          <>
            <line
              className="pv-ref"
              x1={labW + sx(refValue)}
              x2={labW + sx(refValue)}
              y1={0}
              y2={H - 14}
            />
            <text className="pv-tick" x={labW + sx(refValue)} y={H - 3} textAnchor="middle">
              {refLabel ?? 'average'}
            </text>
          </>
        )}
      </svg>
      {hover && rows.find((r) => r.id === hover)?.sub && (
        <div className="pv-bar-sub">{rows.find((r) => r.id === hover)!.sub}</div>
      )}
    </div>
  );
}

/* ── Index meter: one value around 100, diverging (navy above, red below) ── */

export function IndexMeter({
  value,
  small,
}: {
  value: number | null | undefined;
  small?: boolean;
}) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return <span className="pv-idx none">–</span>;
  const v = Math.round(value);
  // Centred on 100; 50 and 150 are the ends (beyond is pinned to the end).
  const clamp = Math.max(50, Math.min(150, v));
  const left = clamp < 100 ? ((clamp - 50) / 100) * 100 : 50;
  const width = (Math.abs(clamp - 100) / 100) * 100;
  return (
    <span className={`pv-idx${small ? ' small' : ''}`} title={`Index ${v} (100 = average)`}>
      <span className="pv-idx-track">
        <span className="pv-idx-mid" />
        <span
          className={`pv-idx-fill ${v >= 100 ? 'up' : 'down'}`}
          style={{ left: `${left}%`, width: `${width}%` }}
        />
      </span>
      <b>{v}</b>
    </span>
  );
}

/* ── How the balls were used: stacked, one sequential hue (dots → sixes) ── */

export interface BallUse {
  id: string;
  label: string;
  balls: number;
  dots: number | null;
  fours: number;
  sixes: number;
  runs: number;
}

export function BallUseBars({ rows, onPick }: { rows: BallUse[]; onPick?: (id: string) => void }) {
  const [hover, setHover] = useState<BallUse | null>(null);
  const max = Math.max(1, ...rows.map((r) => r.balls));
  const keys = [
    ['dot', 'Dot'],
    ['run', 'Ran 1–3'],
    ['four', '4'],
    ['six', '6'],
  ] as const;
  return (
    <div className="pv-balls">
      <div className="pv-legend seq" aria-hidden="true">
        {keys.map(([k, l]) => (
          <span key={k}>
            <i className={`pv-key ${k}`} />
            {l}
          </span>
        ))}
        <span className="pv-legend-note">· share of balls faced</span>
      </div>
      {rows.map((r) => {
        const dots = r.dots ?? 0;
        const run = Math.max(0, r.balls - dots - r.fours - r.sixes);
        const seg = [
          ['dot', r.dots === null ? 0 : dots],
          ['run', r.dots === null ? r.balls - r.fours - r.sixes : run],
          ['four', r.fours],
          ['six', r.sixes],
        ] as const;
        return (
          <div
            key={r.id}
            className={`pv-ball-row${onPick ? ' click' : ''}`}
            onMouseEnter={() => setHover(r)}
            onMouseLeave={() => setHover(null)}
            onClick={() => onPick?.(r.id)}
          >
            <span className="pv-ball-name">{r.label}</span>
            <span className="pv-ball-track" style={{ width: `${(r.balls / max) * 100}%` }}>
              {seg.map(([k, n]) =>
                n > 0 ? <span key={k} className={`pv-seg ${k}`} style={{ flexGrow: n }} /> : null,
              )}
            </span>
            <span className="pv-ball-val">
              {r.runs} <small>({r.balls})</small>
            </span>
          </div>
        );
      })}
      {hover && (
        <div className="pv-bar-sub">
          {hover.label}: {hover.balls} balls
          {hover.dots !== null
            ? ` · ${hover.dots} dots (${Math.round((hover.dots / Math.max(1, hover.balls)) * 100)}%)`
            : ' · dots not recorded'}
          {` · ${hover.fours} fours · ${hover.sixes} sixes`}
        </div>
      )}
    </div>
  );
}

/* ── Form columns: innings by innings, with the average line and a rolling line ── */

export interface FormPoint {
  key: string;
  value: number;
  /** Shown on the cap for notable values, e.g. "84*". */
  text?: string;
  tip: string;
  /** Faded (not out / did not bowl), etc. */
  faint?: boolean;
  /** Mark below the axis (W for a dismissal, etc.). */
  flag?: string;
  /** Above its own average (when points mix formats with different averages). */
  good?: boolean;
}

export function FormColumns({
  points,
  average,
  averageLabel,
  rolling = 3,
  height = 150,
  valueLabel,
}: {
  points: FormPoint[];
  average?: number;
  averageLabel?: string;
  rolling?: number;
  height?: number;
  valueLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [box, W] = useWidth(640);
  if (!points.length) return <div className="pv-empty">No innings in this selection.</div>;
  const H = height;
  const pad = { l: 34, r: 10, t: 14, b: 22 };
  const max = Math.max(1, average ?? 0, ...points.map((p) => p.value)) * 1.08;
  const band = (W - pad.l - pad.r) / points.length;
  const bw = Math.min(24, band * 0.7);
  const sy = (v: number) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const roll = points.map((_, i) => {
    const s = points.slice(Math.max(0, i - rolling + 1), i + 1);
    return s.reduce((n, p) => n + p.value, 0) / s.length;
  });
  const line = roll
    .map((v, i) => `${i ? 'L' : 'M'}${pad.l + band * i + band / 2},${sy(v)}`)
    .join('');
  const notable = new Set(
    [...points.map((p, i) => [p.value, i] as const)]
      .sort((a, b) => b[0] - a[0])
      .slice(0, 3)
      .map(([, i]) => i),
  );
  return (
    <div className="pv-form" ref={box}>
      <div className="pv-legend" aria-hidden="true">
        <span>
          <i className="pv-key squad" />
          {valueLabel}
        </span>
        <span>
          <i className="pv-key line" />
          {rolling}-innings rolling
        </span>
        {average !== undefined && (
          <span>
            <i className="pv-key ref" />
            {averageLabel ?? 'average'}
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${valueLabel} innings by innings`}>
        {niceTicks(0, max, 4).map((v) => (
          <g key={v}>
            <line className="pv-grid" x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} />
            <text className="pv-tick" x={pad.l - 6} y={sy(v) + 4} textAnchor="end">
              {Math.round(v)}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          const x = pad.l + band * i + (band - bw) / 2;
          const above = p.good ?? (average === undefined || p.value >= average);
          return (
            <g key={p.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect
                x={pad.l + band * i}
                y={pad.t}
                width={band}
                height={H - pad.t - pad.b}
                fill="transparent"
              />
              <path
                className={`pv-fill ${above ? 'squad' : 'context'}${p.faint ? ' faint' : ''}${hover === i ? ' hover' : ''}`}
                d={barPath(x, sy(p.value), bw, H - pad.b - sy(p.value), 'up')}
              />
              {(notable.has(i) || hover === i) && p.value > 0 && (
                <text className="pv-cap" x={x + bw / 2} y={sy(p.value) - 4} textAnchor="middle">
                  {p.text ?? Math.round(p.value)}
                </text>
              )}
              {p.flag && (
                <text className="pv-flag" x={x + bw / 2} y={H - 6} textAnchor="middle">
                  {p.flag}
                </text>
              )}
            </g>
          );
        })}
        {average !== undefined && (
          <line className="pv-ref" x1={pad.l} x2={W - pad.r} y1={sy(average)} y2={sy(average)} />
        )}
        <path className="pv-line" d={line} />
      </svg>
      {hover !== null && <div className="pv-bar-sub">{points[hover].tip}</div>}
    </div>
  );
}

/* ── Us v them: paired horizontal bars per category ── */

export function PairBars({
  rows,
  ours = 'Us',
  theirs = 'Opponents',
  fmt = (v: number) => (Math.round(v * 10) / 10).toString(),
  shared = false,
}: {
  rows: { label: string; ours: number; theirs: number }[];
  ours?: string;
  theirs?: string;
  fmt?: (v: number) => string;
  /** One scale for every row (same unit, e.g. partnerships); otherwise each row scales alone. */
  shared?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const all = Math.max(1e-9, ...rows.flatMap((r) => [r.ours, r.theirs]));
  const maxOf = (r: { ours: number; theirs: number }) =>
    shared ? all : Math.max(1e-9, r.ours, r.theirs) * 1.15;
  return (
    <div className="pv-pairs">
      <Legend
        items={[
          { tone: 'squad', label: ours },
          { tone: 'context', label: theirs },
        ]}
      />
      {rows.map((r, i) => (
        <div
          key={r.label}
          className="pv-pair"
          onMouseEnter={() => setHover(i)}
          onMouseLeave={() => setHover(null)}
        >
          <span className="pv-pair-label">{r.label}</span>
          <span className="pv-pair-bars">
            <span className="pv-pair-line">
              <span
                className="pv-pair-fill squad"
                style={{ width: `${(r.ours / maxOf(r)) * 100}%` }}
              />
              <b>{fmt(r.ours)}</b>
            </span>
            <span className="pv-pair-line">
              <span
                className="pv-pair-fill context"
                style={{ width: `${(r.theirs / maxOf(r)) * 100}%` }}
              />
              <b>{fmt(r.theirs)}</b>
            </span>
          </span>
        </div>
      ))}
      {hover !== null && (
        <div className="pv-bar-sub">
          {rows[hover].label}: {ours} {fmt(rows[hover].ours)} · {theirs} {fmt(rows[hover].theirs)}
        </div>
      )}
    </div>
  );
}

/* ── Share bars: one 100% bar per side, labelled segments ── */

export function ShareRows({
  rows,
  keys,
}: {
  rows: { label: string; parts: number[] }[];
  /** Segment names, darkest last (one sequential hue). */
  keys: string[];
}) {
  const [hover, setHover] = useState<string | null>(null);
  return (
    <div className="pv-share">
      <div className="pv-legend seq" aria-hidden="true">
        {keys.map((k, i) => (
          <span key={k}>
            <i className={`pv-key s${i}`} />
            {k}
          </span>
        ))}
      </div>
      {rows.map((r) => {
        const tot = r.parts.reduce((a, b) => a + b, 0) || 1;
        return (
          <div key={r.label} className="pv-share-row">
            <span className="pv-share-label">{r.label}</span>
            <span className="pv-share-track">
              {r.parts.map((p, i) =>
                p > 0 ? (
                  <span
                    key={i}
                    className={`pv-seg s${i}`}
                    style={{ flexGrow: p }}
                    onMouseEnter={() =>
                      setHover(`${r.label}: ${keys[i]} ${p} (${Math.round((p / tot) * 100)}%)`)
                    }
                    onMouseLeave={() => setHover(null)}
                  >
                    {p / tot >= 0.12 ? `${Math.round((p / tot) * 100)}%` : ''}
                  </span>
                ) : null,
              )}
            </span>
          </div>
        );
      })}
      {hover && <div className="pv-bar-sub">{hover}</div>}
    </div>
  );
}

/* ── Results strip: W/L/D chips in date order ── */

export function ResultStrip({
  results,
}: {
  results: { key: string; outcome: 'W' | 'L' | 'D' | 'T' | 'NR'; tip: string }[];
}) {
  const [hover, setHover] = useState<string | null>(null);
  return (
    <div className="pv-results">
      <div className="pv-results-row">
        {results.map((r) => (
          <span
            key={r.key}
            className={`pv-res ${r.outcome}`}
            onMouseEnter={() => setHover(r.tip)}
            onMouseLeave={() => setHover(null)}
            title={r.tip}
          >
            {r.outcome === 'NR' ? '–' : r.outcome}
          </span>
        ))}
      </div>
      <div className="pv-bar-sub">
        {hover ?? 'Oldest on the left · hover a result for the match'}
      </div>
    </div>
  );
}

/* ── Stat tile ── */

export function Tile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'good' | 'bad';
}) {
  return (
    <div className={`pv-tile${tone ? ` ${tone}` : ''}`}>
      <div className="pv-tile-label">{label}</div>
      <div className="pv-tile-value">{value}</div>
      {sub && <div className="pv-tile-sub">{sub}</div>}
    </div>
  );
}

/* ── Mini form spark (last N innings) ── */

export function Spark({
  values,
  average,
  max,
}: {
  values: number[];
  average?: number;
  max?: number;
}) {
  const W = 120;
  const H = 30;
  if (!values.length)
    return <svg viewBox={`0 0 ${W} ${H}`} className="pv-spark" aria-hidden="true" />;
  const top = Math.max(1, max ?? 0, average ?? 0, ...values);
  const band = W / values.length;
  const bw = Math.min(10, band * 0.7);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="pv-spark" aria-hidden="true">
      {values.map((v, i) => {
        const h = Math.max(1.5, (v / top) * (H - 2));
        return (
          <path
            key={i}
            className={`pv-fill ${average === undefined || v >= average ? 'squad' : 'context'}`}
            d={barPath(band * i + (band - bw) / 2, H - h, bw, h, 'up')}
          />
        );
      })}
      {average !== undefined && (
        <line
          className="pv-ref"
          x1={0}
          x2={W}
          y1={H - (average / top) * (H - 2)}
          y2={H - (average / top) * (H - 2)}
        />
      )}
    </svg>
  );
}

/* ── Trend lines: a few series over seasons (categorical x), direct end labels ── */

export interface TrendSeries {
  key: string;
  label: string;
  tone: Tone;
  values: (number | null)[];
}

export function TrendLines({
  categories,
  series,
  fmt = (v: number) => (Math.round(v * 10) / 10).toString(),
  height = 170,
  refValue,
  refLabel,
  notes,
  domain,
}: {
  categories: string[];
  series: TrendSeries[];
  fmt?: (v: number) => string;
  height?: number;
  refValue?: number;
  refLabel?: string;
  /** Per category, e.g. "8 games" — shown under the axis label. */
  notes?: string[];
  /** Fixed axis range, e.g. [0, 100] for a percentage. */
  domain?: [number, number];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [box, W] = useWidth(520);
  const H = height;
  const pad = { l: 40, r: 70, t: 14, b: notes ? 34 : 22 };
  const vals = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (!vals.length || categories.length === 0)
    return <div className="pv-empty">Not enough seasons yet.</div>;
  let lo = Math.min(...vals, refValue ?? Infinity);
  let hi = Math.max(...vals, refValue ?? -Infinity);
  if (domain) {
    lo = Math.min(domain[0], lo);
    hi = Math.max(domain[1], hi);
  } else {
    // Never zoom so far in that a small wobble looks like a swing: the axis spans at least
    // a quarter of the values' size.
    const mid = (lo + hi) / 2;
    const minSpan = Math.max(Math.abs(mid) * 0.25, 1);
    if (hi - lo < minSpan) {
      lo = mid - minSpan / 2;
      hi = mid + minSpan / 2;
    }
    const span = hi - lo;
    lo -= span * 0.12;
    hi += span * 0.12;
    if (lo < 0 && Math.min(...vals) >= 0) lo = 0;
  }
  const band = (W - pad.l - pad.r) / Math.max(1, categories.length - 1 || 1);
  const sx = (i: number) => (categories.length === 1 ? (pad.l + W - pad.r) / 2 : pad.l + band * i);
  const sy = (v: number) => H - pad.b - ((v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  // End labels: nudge apart when two series finish close together.
  const ends = series
    .map((s) => {
      const i = s.values
        .map((v, k) => (v === null ? -1 : k))
        .filter((k) => k >= 0)
        .pop();
      return i === undefined ? null : { s, i, y: sy(s.values[i]!) };
    })
    .filter((e): e is { s: TrendSeries; i: number; y: number } => !!e)
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++)
    if (ends[k].y - ends[k - 1].y < 12) ends[k].y = ends[k - 1].y + 12;
  return (
    <div className="pv-trend" ref={box}>
      <Legend items={series.map((s) => ({ tone: s.tone, label: s.label }))} />
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${series.map((s) => s.label).join(' and ')} by season`}
      >
        {niceTicks(lo, hi, 4).map((v) => (
          <g key={v}>
            <line className="pv-grid" x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} />
            <text className="pv-tick" x={pad.l - 6} y={sy(v) + 4} textAnchor="end">
              {fmt(v)}
            </text>
          </g>
        ))}
        {refValue !== undefined && (
          <>
            <line
              className="pv-ref"
              x1={pad.l}
              x2={W - pad.r}
              y1={sy(refValue)}
              y2={sy(refValue)}
            />
            <text className="pv-tick" x={W - pad.r + 4} y={sy(refValue) + 4}>
              {refLabel ?? fmt(refValue)}
            </text>
          </>
        )}
        {categories.map((c, i) => (
          <g key={c} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <rect
              x={sx(i) - band / 2}
              y={pad.t}
              width={Math.max(band, 40)}
              height={H - pad.t - pad.b}
              fill="transparent"
            />
            {hover === i && (
              <line className="pv-ref" x1={sx(i)} x2={sx(i)} y1={pad.t} y2={H - pad.b} />
            )}
            <text className="pv-tick" x={sx(i)} y={H - pad.b + 14} textAnchor="middle">
              {c}
            </text>
            {notes?.[i] && (
              <text className="pv-tick faint" x={sx(i)} y={H - pad.b + 26} textAnchor="middle">
                {notes[i]}
              </text>
            )}
          </g>
        ))}
        {series.map((s) => {
          const pts = s.values.map((v, i) => (v === null ? null : ([sx(i), sy(v)] as const)));
          const d = pts.reduce(
            (acc, p, i) => (p ? `${acc}${acc && pts[i - 1] ? 'L' : 'M'}${p[0]},${p[1]}` : acc),
            '',
          );
          return (
            <g key={s.key}>
              <path className={`pv-tline ${s.tone}`} d={d} />
              {pts.map((p, i) =>
                p ? (
                  <circle key={i} className={`pv-dot ${s.tone}`} cx={p[0]} cy={p[1]} r={4.5} />
                ) : null,
              )}
            </g>
          );
        })}
        {ends.map((e) => (
          <text key={e.s.key} className="pv-label" x={sx(e.i) + 9} y={e.y + 4}>
            {fmt(e.s.values[e.i]!)}
          </text>
        ))}
      </svg>
      <div className="pv-bar-sub">
        {hover !== null
          ? `${categories[hover]}: ${series.map((s) => `${s.label} ${s.values[hover] === null ? '–' : fmt(s.values[hover]!)}`).join(' · ')}${notes?.[hover] ? ` · ${notes[hover]}` : ''}`
          : 'Hover a season for the numbers'}
      </div>
    </div>
  );
}

/* ── Dumbbell: one row per player, season A → season B ── */

export interface DumbbellRow {
  id: string;
  label: string;
  from: number;
  to: number;
  sub?: string;
  /** Colour of the end dot and line; by default navy when it rose, red when it fell. */
  tone?: Tone;
  /** Short tag after the numbers, e.g. a selection signal. */
  tag?: string;
}

export function Dumbbell({
  rows,
  fromLabel,
  toLabel,
  onPick,
  refValue = 100,
  legend,
  empty,
  hint,
}: {
  rows: DumbbellRow[];
  fromLabel: string;
  toLabel: string;
  onPick?: (id: string) => void;
  refValue?: number;
  /** Replace the default up/down legend when rows carry their own tones. */
  legend?: { tone: Tone; label: string }[];
  empty?: string;
  hint?: string;
}) {
  const [hover, setHover] = useState<DumbbellRow | null>(null);
  const [box, W] = useWidth(560);
  if (!rows.length)
    return <div className="pv-empty">{empty ?? 'Nobody qualified in both seasons.'}</div>;
  const rowH = 26;
  const labW = Math.round(Math.min(240, Math.max(130, W * 0.26)));
  const valW = 120;
  const H = rows.length * rowH + 26;
  const all = rows.flatMap((r) => [r.from, r.to]).concat(refValue);
  const lo = Math.min(...all) - 8;
  const hi = Math.max(...all) + 8;
  const sx = (v: number) => labW + ((v - lo) / (hi - lo)) * (W - labW - valW);
  return (
    <div className="pv-dumbbell" ref={box}>
      {legend ? (
        <Legend items={[{ tone: 'context', label: fromLabel }, ...legend]} />
      ) : (
        <div className="pv-legend" aria-hidden="true">
          <span>
            <i className="pv-key context" />
            {fromLabel}
          </span>
          <span>
            <i className="pv-key squad" />
            {toLabel}, up
          </span>
          <span>
            <i className="pv-key risk" />
            {toLabel}, down
          </span>
        </div>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Index change from ${fromLabel} to ${toLabel}`}
      >
        <line className="pv-ref" x1={sx(refValue)} x2={sx(refValue)} y1={0} y2={H - 18} />
        <text className="pv-tick" x={sx(refValue)} y={H - 4} textAnchor="middle">
          {refValue} = average
        </text>
        {rows.map((r, i) => {
          const y = i * rowH + 12;
          const up = r.to >= r.from;
          const tone = r.tone ?? (up ? 'squad' : 'risk');
          const dir = r.to >= r.from ? 1 : -1;
          const x2 = sx(r.to) - dir * 5;
          return (
            <g
              key={r.id}
              className={`pv-bar-row${onPick ? ' click' : ''}`}
              onMouseEnter={() => setHover(r)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onPick?.(r.id)}
            >
              <rect x={0} y={y - 11} width={W} height={rowH} fill="transparent" />
              <text className="pv-bar-label" x={labW - 10} y={y + 4} textAnchor="end">
                {r.label.length > 20 ? `${r.label.slice(0, 19)}…` : r.label}
              </text>
              {Math.abs(sx(r.to) - sx(r.from)) > 6 && (
                <line className={`pv-dline ${tone}`} x1={sx(r.from)} x2={x2} y1={y} y2={y} />
              )}
              <circle className="pv-dot context" cx={sx(r.from)} cy={y} r={4.5} />
              <circle className={`pv-dot ${tone}`} cx={sx(r.to)} cy={y} r={5.5} />
              <text className="pv-bar-val" x={W - valW + 8} y={y + 4}>
                {Math.round(r.from)} → {Math.round(r.to)}{' '}
                <tspan className={up ? 'pv-up' : 'pv-down'}>
                  ({up ? '+' : ''}
                  {Math.round(r.to - r.from)})
                </tspan>
                {r.tag ? <tspan className="pv-tag"> {r.tag}</tspan> : null}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="pv-bar-sub">
        {hover?.sub ??
          hint ??
          'Hover a player for the numbers behind each season · tap for their deep dive'}
      </div>
    </div>
  );
}
