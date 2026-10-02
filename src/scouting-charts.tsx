/* ─── Scouting charts: wagon wheel and the team-view graphs ─── */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { ZONES, zoneRuns } from './scouting';
import type { Shot } from './scouting';

/* ── Wagon wheel ──
 * Same orientation as the club match review: fine leg / third man at the top, straight
 * down the ground at the bottom, viewed from above with the batter facing down the page —
 * a right-hander's off side on the left, a left-hander's on the right. Zones are recorded
 * per ball by Medicoach Live; individual shots are fanned evenly inside their zone (the
 * source records the zone, not the exact angle). */

const RAY_LEN: Record<number, number> = { 1: 0.34, 2: 0.5, 3: 0.64, 4: 0.97, 5: 0.97, 6: 1.08 };

export function WagonWheel({
  shots,
  title,
  sub,
  empty,
}: {
  shots: Shot[];
  title?: ReactNode;
  sub?: ReactNode;
  empty?: ReactNode;
}) {
  const [hand, setHand] = useState<'R' | 'L'>('R');
  const S = 340;
  const c = S / 2;
  const R = 118;
  const hx = hand === 'L' ? 1 : -1;
  const pt = (a: number, r: number): [number, number] => {
    const t = (a * Math.PI) / 180;
    return [c + hx * r * Math.sin(t), c - r * Math.cos(t)];
  };
  const zones = zoneRuns(shots);
  const total = zones.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...zones);
  const top = zones.indexOf(Math.max(...zones));
  const counts = { low: 0, four: 0, six: 0 };
  shots.forEach((s) => (s.runs >= 6 ? counts.six++ : s.runs >= 4 ? counts.four++ : counts.low++));

  // Fan the shots of each zone evenly across its 45° (boundaries drawn last, on top).
  const rays = ZONES.flatMap((_, i) => {
    const list = shots.filter((s) => s.zone === i).sort((a, b) => a.runs - b.runs);
    return list.map((s, k) => ({ s, a: i * 45 + ((k + 1) * 45) / (list.length + 1) }));
  }).sort((a, b) => a.s.runs - b.s.runs);

  if (!shots.length)
    return (
      <div className="ww ww-empty">
        {title && <div className="ww-title">{title}</div>}
        <div className="ww-empty-body">
          {empty ??
            'No shot zones recorded — wagon wheels need a Medicoach Live ball-by-ball export.'}
        </div>
      </div>
    );

  return (
    <div className="ww">
      <div className="ww-head">
        <div>
          {title && <div className="ww-title">{title}</div>}
          {sub && <div className="ww-sub">{sub}</div>}
        </div>
        <div className="ww-hand" role="group" aria-label="Batter's hand">
          {(['R', 'L'] as const).map((h) => (
            <button
              key={h}
              type="button"
              aria-pressed={hand === h}
              className={hand === h ? 'on' : ''}
              onClick={() => setHand(h)}
            >
              {h}HB
            </button>
          ))}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${S} ${S}`}
        className="ww-svg"
        role="img"
        aria-label={`Wagon wheel: ${total} runs; most through ${ZONES[top].f.toLowerCase()}`}
      >
        <circle className="ww-field" cx={c} cy={c} r={R + 10} />
        <circle className="ww-ring" cx={c} cy={c} r={R * 0.42} />
        {zones.map((v, i) => {
          const a1 = i * 45;
          const [x1, y1] = pt(a1, R);
          const [x2, y2] = pt(a1 + 45, R);
          const sweep = hand === 'L' ? 1 : 0;
          return (
            <path
              key={i}
              className="ww-zone"
              d={`M${c},${c} L${x1},${y1} A${R},${R} 0 0 ${sweep} ${x2},${y2} Z`}
              style={{ fillOpacity: v ? 0.1 + 0.4 * (v / max) : 0 }}
            >
              <title>
                {ZONES[i].f}: {v} runs
              </title>
            </path>
          );
        })}
        {rays.map(({ s, a }, k) => {
          const [x, y] = pt(a, R * (RAY_LEN[s.runs] ?? 0.6));
          const cls = s.runs >= 6 ? 'six' : s.runs >= 4 ? 'four' : 'low';
          return (
            <line key={k} className={`ww-ray ${cls}`} x1={c} y1={c} x2={x} y2={y}>
              <title>
                {s.batter}: {s.runs} through {ZONES[s.zone].f.toLowerCase()} (off {s.bowler})
              </title>
            </line>
          );
        })}
        <rect className="ww-pitch" x={c - 4} y={c - 14} width={8} height={28} rx={2} />
        {zones.map((v, i) => {
          if (!v) return null;
          const [lx, ly] = pt(i * 45 + 22.5, R * 0.8);
          return (
            <text key={`v${i}`} className="ww-val" x={lx} y={ly + 5} textAnchor="middle">
              {v}
            </text>
          );
        })}
        {ZONES.map((z, i) => {
          const [nx, ny] = pt(i * 45 + 22.5, R + 26);
          return (
            <text
              key={`n${i}`}
              className="ww-name"
              x={nx}
              y={ny - (z.s.length - 1) * 5}
              textAnchor="middle"
            >
              {z.s.map((part, k) => (
                <tspan key={k} x={nx} dy={k ? 11 : 0}>
                  {part}
                </tspan>
              ))}
            </text>
          );
        })}
      </svg>
      <div className="ww-legend">
        <span>
          <i className="ww-key low" />
          1–3 ({counts.low})
        </span>
        <span>
          <i className="ww-key four" />
          Four ({counts.four})
        </span>
        <span>
          <i className="ww-key six" />
          Six ({counts.six})
        </span>
      </div>
      <div className="ww-foot">
        <strong>{total}</strong> runs from {shots.length} scoring shots · most through{' '}
        <strong>{ZONES[top].f.toLowerCase()}</strong> (
        {Math.round((zones[top] / Math.max(1, total)) * 100)}
        %)
      </div>
    </div>
  );
}

/* ── Form strip ── */

export function FormStrip({
  items,
}: {
  items: { key: string; won: boolean | null; label: string; sub: string; onClick: () => void }[];
}) {
  return (
    <div className="tf-form">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          className={`tf-chip ${it.won == null ? 'nr' : it.won ? 'w' : 'l'}`}
          onClick={it.onClick}
          title={it.sub}
        >
          <strong>{it.won == null ? '–' : it.won ? 'W' : 'L'}</strong>
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ── Innings shapes: cumulative runs per over, one line per innings ── */

export function InningsShapes({
  series,
}: {
  series: { key: string; label: string; won: boolean | null; points: [number, number][] }[];
}) {
  const [hover, setHover] = useState<string | null>(null);
  const W = 560;
  const H = 240;
  const pad = { l: 38, r: 70, t: 12, b: 30 };
  const maxO = Math.max(1, ...series.flatMap((s) => s.points.map(([o]) => o)));
  const maxR =
    Math.ceil(Math.max(20, ...series.flatMap((s) => s.points.map(([, r]) => r))) / 25) * 25;
  const sx = (o: number) => pad.l + (o / maxO) * (W - pad.l - pad.r);
  const sy = (r: number) => H - pad.b - (r / maxR) * (H - pad.t - pad.b);
  const yt = [0, Math.round(maxR / 2), maxR];
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="tf-svg"
      role="img"
      aria-label="Runs by over, each innings"
    >
      {yt.map((v) => (
        <g key={v}>
          <line className="sc-grid" x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} />
          <text className="sc-tick" x={pad.l - 6} y={sy(v) + 4} textAnchor="end">
            {v}
          </text>
        </g>
      ))}
      {[0, Math.round(maxO / 2), maxO].map((o) => (
        <text key={o} className="sc-tick" x={sx(o)} y={H - pad.b + 16} textAnchor="middle">
          {o}
        </text>
      ))}
      <text className="sc-axis" x={(pad.l + W - pad.r) / 2} y={H - 3} textAnchor="middle">
        Overs
      </text>
      {series.map((s) => {
        const pts: [number, number][] = [[0, 0], ...s.points];
        const last = pts[pts.length - 1];
        const dim = hover && hover !== s.key;
        return (
          <g
            key={s.key}
            className={`tf-line ${s.won == null ? 'nr' : s.won ? 'w' : 'l'} ${dim ? 'dim' : ''}`}
            onMouseEnter={() => setHover(s.key)}
            onMouseLeave={() => setHover(null)}
          >
            <polyline fill="none" points={pts.map(([o, r]) => `${sx(o)},${sy(r)}`).join(' ')} />
            <polyline
              className="tf-hit"
              fill="none"
              points={pts.map(([o, r]) => `${sx(o)},${sy(r)}`).join(' ')}
            />
            <text className="tf-end" x={sx(last[0]) + 6} y={sy(last[1]) + 4}>
              {s.label} {last[1]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ── Horizontal bars (one value per row) ── */

export function HBars({
  rows,
  format = String,
  tone = 'green',
}: {
  rows: { key: string; label: ReactNode; value: number; note?: ReactNode }[];
  format?: (v: number) => string;
  tone?: 'green' | 'ink';
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="tf-hbars">
      {rows.map((r) => (
        <div key={r.key} className="tf-hbar">
          <span className="tf-hbar-l">{r.label}</span>
          <span className="sc-bar-track">
            <span
              className={`sc-bar-fill ${tone === 'ink' ? 'muted-ink' : ''}`}
              style={{ width: `${(r.value / max) * 100}%` }}
            />
          </span>
          <span className="tf-hbar-v">
            {format(r.value)}
            {r.note && <em>{r.note}</em>}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Paired bars: two measures per row on one shared scale (e.g. scored v conceded) ── */

export function PairBars({
  rows,
  a,
  b,
  format = String,
}: {
  rows: { key: string; label: ReactNode; a: number | null; b: number | null }[];
  a: string;
  b: string;
  format?: (v: number) => string;
}) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.a ?? 0, r.b ?? 0]));
  return (
    <div className="tf-pairs">
      <div className="tf-legend">
        <span>
          <i className="mx-key i1" />
          {a}
        </span>
        <span>
          <i className="mx-key i2" />
          {b}
        </span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="tf-pair">
          <span className="tf-hbar-l">{r.label}</span>
          <div className="tf-pair-bars">
            {(['a', 'b'] as const).map((k) => (
              <div key={k} className="tf-pair-row">
                <span className="sc-bar-track">
                  <span
                    className={`sc-bar-fill ${k === 'a' ? 'i1' : 'i2'}`}
                    style={{ width: `${((r[k] ?? 0) / max) * 100}%` }}
                  />
                </span>
                <span className="tf-hbar-v">{r[k] == null ? '–' : format(r[k]!)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Stacked share bar (runs by source) ── */

export function ShareBar({
  label,
  parts,
}: {
  label: ReactNode;
  parts: { k: string; v: number; cls: string }[];
}) {
  const total = parts.reduce((n, p) => n + p.v, 0) || 1;
  return (
    <div className="tf-share">
      <div className="tf-share-l">{label}</div>
      <div className="mx-dist" role="img" aria-label={parts.map((p) => `${p.k} ${p.v}`).join(', ')}>
        {parts
          .filter((p) => p.v > 0)
          .map((p) => (
            <span key={p.k} className={p.cls} style={{ flex: p.v }} title={`${p.k}: ${p.v}`} />
          ))}
      </div>
      <div className="mx-dist-legend">
        {parts.map((p) => (
          <span key={p.k}>
            <i className={`mx-key ${p.cls}`} />
            {p.k} <strong>{p.v}</strong> <em>{Math.round((p.v / total) * 100)}%</em>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Column chart (e.g. runs by batting position, stand by wicket) ── */

export function Columns({
  cols,
  format = String,
  caption,
}: {
  cols: { key: string; label: string; value: number; title?: string }[];
  format?: (v: number) => string;
  caption?: string;
}) {
  const max = Math.max(1, ...cols.map((c) => c.value));
  return (
    <div className="tf-cols-wrap">
      <div className="tf-cols">
        {cols.map((c) => (
          <div key={c.key} className="tf-col" title={c.title}>
            <span className="tf-col-v">{c.value ? format(c.value) : ''}</span>
            <span className="tf-col-bar" style={{ height: `${(c.value / max) * 100}%` }} />
            <span className="tf-col-l">{c.label}</span>
          </div>
        ))}
      </div>
      {caption && <div className="tf-caption">{caption}</div>}
    </div>
  );
}
