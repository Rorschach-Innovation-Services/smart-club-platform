/* ─── Charts for the player journeys (Pathways → Players, Route to professional) ───
 *
 * Plain SVG/HTML on the platform's chart tokens: navy = the player/pathway, gold = outlier or
 * representative, red = leak or bust, sky = club, grey = context. Each chart is width-measured,
 * has a hover caption and an aria label.
 */
import { useState } from 'react';
import type { Spread, Setting, Journey, Bracket } from './journeys';
import { BANDS, SETTING_LABEL, SETTINGS, rungOf } from './journeys';
import { useWidth } from './pro-charts';

const FILL: Record<Setting, string> = {
  school: 'var(--viz-squad)',
  club: 'var(--viz-third)',
  rep: 'var(--viz-pool)',
  pro: 'var(--viz-s5)',
};

function ticks(lo: number, hi: number, n = 4) {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n + 1) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

/* ── The bar at each age bracket ── */

export interface LadderPoint {
  id: string;
  label: string;
  value: number;
  outlier: boolean;
  tip: string;
}
export interface LadderCol {
  key: string;
  label: string;
  sub?: string;
  spread: Spread | null;
  points: LadderPoint[];
}

/**
 * One column per age bracket, the bottom of the pathway on the left: the 10th–90th percentile
 * (line), the middle half (box), the median (tick), the top-10% mark (gold diamond) and every
 * player as a dot (outliers gold). A picked player's route across the brackets is joined up.
 */
export function BracketLadder({
  cols,
  better,
  unit,
  fmt,
  selected,
  onPick,
}: {
  cols: LadderCol[];
  better: 'high' | 'low';
  unit: string;
  fmt: (v: number) => string;
  selected?: string | null;
  onPick?: (id: string) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const [box, W] = useWidth(720);
  const pad = { l: 46, r: 12, t: 14, b: 44 };
  const H = 340;
  const refs = cols.flatMap((c) =>
    c.spread ? [c.spread.p10, c.spread.p90, c.spread.benchmark] : [],
  );
  const vals = cols.flatMap((c) => c.points.map((p) => p.value));
  const top = Math.max(1, ...refs) * 1.35;
  const hi = Math.max(top, Math.min(Math.max(...vals, 0), top * 1.4));
  const lo = better === 'low' ? Math.max(0, Math.min(...vals, ...refs) * 0.7) : 0;
  const sy = (v: number) =>
    pad.t + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const cw = (W - pad.l - pad.r) / Math.max(1, cols.length);
  const cx = (i: number) => pad.l + cw * (i + 0.5);
  const trail = selected
    ? cols.flatMap((c, i) => {
        const p = c.points.find((x) => x.id === selected);
        return p ? [{ x: cx(i), y: sy(p.value), tip: p.tip }] : [];
      })
    : [];
  return (
    <div className="pv-trend" ref={box}>
      <div className="pv-legend" aria-hidden="true">
        <span>
          <i className="pv-key pool" />
          Outlier · top 10% and ahead of the middle on the second measure
        </span>
        <span>
          <i className="pv-key context" />
          Player
        </span>
        <span>
          <i className="pv-key line" />
          Median
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${unit} at each age bracket`}>
        {ticks(lo, hi).map((v) => (
          <g key={v}>
            <line className="pv-grid" x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} />
            <text className="pv-tick" x={pad.l - 6} y={sy(v) + 3} textAnchor="end">
              {fmt(v)}
            </text>
          </g>
        ))}
        {cols.map((c, i) => {
          const s = c.spread;
          return (
            <g key={c.key}>
              <text className="pv-label" x={cx(i)} y={H - pad.b + 16} textAnchor="middle">
                {c.label}
              </text>
              {c.sub && (
                <text className="pv-tick" x={cx(i)} y={H - pad.b + 29} textAnchor="middle">
                  {c.sub}
                </text>
              )}
              {s && (
                <g aria-hidden="true">
                  <line
                    className="ml-whisker"
                    x1={cx(i)}
                    x2={cx(i)}
                    y1={sy(s.p90)}
                    y2={sy(s.p10)}
                  />
                  <rect
                    x={cx(i) - cw * 0.17}
                    width={cw * 0.34}
                    y={Math.min(sy(s.p75), sy(s.p25))}
                    height={Math.abs(sy(s.p25) - sy(s.p75))}
                    rx={4}
                    fill="var(--viz-s1)"
                    opacity={0.55}
                  />
                  <line
                    className="ml-median"
                    x1={cx(i) - cw * 0.17}
                    x2={cx(i) + cw * 0.17}
                    y1={sy(s.p50)}
                    y2={sy(s.p50)}
                  />
                  <path
                    className="ml-bench"
                    d={`M${cx(i) + cw * 0.2},${sy(s.benchmark) - 6} l6,6 l-6,6 l-6,-6 z`}
                  />
                </g>
              )}
              {c.points.map((p, k) => {
                const jitter = (((k * 53 + i * 17) % 29) / 28 - 0.5) * cw * 0.7;
                const x = cx(i) + jitter;
                const y = sy(p.value);
                const on = selected === p.id;
                return (
                  <g
                    key={p.id}
                    className={onPick ? 'pw-pick' : ''}
                    onMouseEnter={() => setHover(p.tip)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => onPick?.(p.id)}
                  >
                    <circle cx={x} cy={y} r={9} fill="transparent" />
                    <circle
                      className={`pv-dot ${p.outlier ? 'pool' : 'context'}`}
                      cx={x}
                      cy={y}
                      r={on ? 7 : p.outlier ? 5 : 3.2}
                      style={on ? { stroke: 'var(--ink)', strokeWidth: 2.5 } : undefined}
                    />
                  </g>
                );
              })}
            </g>
          );
        })}
        {trail.length > 1 && (
          <polyline
            points={trail.map((t) => `${t.x},${t.y}`).join(' ')}
            fill="none"
            stroke="var(--ink)"
            strokeWidth={2}
            strokeDasharray="5 3"
            pointerEvents="none"
          />
        )}
        <text
          className="pv-axis"
          x={12}
          y={H / 2}
          textAnchor="middle"
          transform={`rotate(-90 12 ${H / 2})`}
        >
          {unit}
        </text>
      </svg>
      <div className="pv-bar-sub">
        {hover ??
          `Box = middle half, line = 10th–90th percentile, diamond = top-10% mark (${better === 'high' ? 'higher' : 'lower'} is better) · hover a dot, click to follow a player up the ladder`}
      </div>
    </div>
  );
}

/* ── Participation: balls faced and bowled ── */

export interface ParticipationRow {
  key: string;
  label: string;
  faced: number | null;
  bowled: number | null;
  players: number;
}

/** Median balls faced and bowled per player per season, at each bracket. */
export function ParticipationBars({ rows }: { rows: ParticipationRow[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const [box, W] = useWidth(720);
  const pad = { l: 44, r: 8, t: 10, b: 34 };
  const H = 240;
  const hi = Math.max(10, ...rows.flatMap((r) => [r.faced ?? 0, r.bowled ?? 0])) * 1.1;
  const sy = (v: number) => pad.t + (1 - v / hi) * (H - pad.t - pad.b);
  const cw = (W - pad.l - pad.r) / Math.max(1, rows.length);
  return (
    <div className="pv-trend" ref={box}>
      <div className="pv-legend" aria-hidden="true">
        <span>
          <i className="pv-key squad" />
          Balls faced
        </span>
        <span>
          <i className="pv-key third" />
          Balls bowled
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Balls faced and bowled per player per season"
      >
        {ticks(0, hi).map((v) => (
          <g key={v}>
            <line className="pv-grid" x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} />
            <text className="pv-tick" x={pad.l - 6} y={sy(v) + 3} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x0 = pad.l + cw * i + cw * 0.14;
          const bw = cw * 0.3;
          return (
            <g
              key={r.key}
              onMouseEnter={() =>
                setHover(
                  `${r.label}: ${r.players} players · median ${r.faced ?? '–'} balls faced and ${r.bowled ?? '–'} bowled per player each season`,
                )
              }
              onMouseLeave={() => setHover(null)}
            >
              <rect
                x={pad.l + cw * i}
                y={pad.t}
                width={cw}
                height={H - pad.t - pad.b}
                fill="transparent"
              />
              {r.faced !== null && (
                <rect
                  className="pv-fill squad"
                  x={x0}
                  width={bw}
                  y={sy(r.faced)}
                  height={sy(0) - sy(r.faced)}
                  rx={3}
                />
              )}
              {r.bowled !== null && (
                <rect
                  className="pv-fill third"
                  x={x0 + bw + 3}
                  width={bw}
                  y={sy(r.bowled)}
                  height={sy(0) - sy(r.bowled)}
                  rx={3}
                />
              )}
              <text
                className="pv-label"
                x={pad.l + cw * (i + 0.5)}
                y={H - pad.b + 16}
                textAnchor="middle"
              >
                {r.label}
              </text>
              <text
                className="pv-tick"
                x={pad.l + cw * (i + 0.5)}
                y={H - pad.b + 28}
                textAnchor="middle"
              >
                {r.players} players
              </text>
            </g>
          );
        })}
      </svg>
      <div className="pv-bar-sub">{hover ?? 'Hover a bracket for the numbers'}</div>
    </div>
  );
}

/* ── Boom and bust ── */

export interface BoomRow {
  key: string;
  label: string;
  bracket: Bracket;
  bust: number;
  steady: number;
  boom: number;
  n: number;
}

/** The share of innings that were busts, steady scores and booms, at each bracket. */
export function BoomBustBars({ rows }: { rows: BoomRow[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const [box, W] = useWidth(640);
  const labelW = 76;
  const rowH = 30;
  const H = rows.length * rowH + 8;
  const sx = (v: number) => labelW + v * (W - labelW - 44);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <div className="pv-trend" ref={box}>
      <div className="pv-legend" aria-hidden="true">
        <span>
          <i className="pv-key risk" />
          Bust
        </span>
        <span>
          <i className="pv-key context" />
          Steady
        </span>
        <span>
          <i className="pv-key pool" />
          Boom
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Share of innings that were busts, steady and booms"
      >
        {rows.map((r, i) => {
          const y = 4 + i * rowH;
          const [lo, hi] = BANDS[r.bracket];
          return (
            <g
              key={r.key}
              onMouseEnter={() =>
                setHover(
                  `${r.label}: ${r.n} innings — ${pct(r.bust)} under ${lo}, ${pct(r.steady)} between ${lo} and ${hi - 1}, ${pct(r.boom)} of ${hi}+`,
                )
              }
              onMouseLeave={() => setHover(null)}
            >
              <text className="pv-label" x={labelW - 8} y={y + rowH / 2 + 2} textAnchor="end">
                {r.label}
              </text>
              <rect
                className="pv-fill risk"
                x={sx(0)}
                y={y + 4}
                width={sx(r.bust) - sx(0)}
                height={rowH - 10}
                rx={3}
              />
              <rect
                className="pv-fill context"
                x={sx(r.bust) + 2}
                y={y + 4}
                width={Math.max(0, sx(r.bust + r.steady) - sx(r.bust) - 2)}
                height={rowH - 10}
                rx={3}
              />
              <rect
                className="pv-fill pool"
                x={sx(r.bust + r.steady) + 2}
                y={y + 4}
                width={Math.max(0, sx(1) - sx(r.bust + r.steady) - 2)}
                height={rowH - 10}
                rx={3}
              />
              <text
                className="pv-cap"
                x={sx(r.bust) - 5}
                y={y + rowH / 2 + 2}
                textAnchor="end"
                fill="#fff"
                style={{ fill: '#fff' }}
              >
                {r.bust > 0.12 ? pct(r.bust) : ''}
              </text>
              <text className="pv-cap" x={sx(1) + 5} y={y + rowH / 2 + 2}>
                {pct(r.boom)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="pv-bar-sub">
        {hover ??
          'Bust and boom lines grow with the age group (shown on hover) · figure at the right = share of booms'}
      </div>
    </div>
  );
}

/* ── One player's innings, in order ── */

export interface InningsCol {
  season: number;
  label: string;
  runs: number;
  balls: number;
  out: boolean;
  band: 'bust' | 'steady' | 'boom';
  tip: string;
}

/** Every innings a player has had, oldest first, coloured bust / steady / boom, with season breaks. */
export function InningsColumns({ cols }: { cols: InningsCol[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const [box, W] = useWidth(640);
  const pad = { l: 34, r: 8, t: 8, b: 30 };
  const H = 170;
  const hi = Math.max(20, ...cols.map((c) => c.runs)) * 1.1;
  const sy = (v: number) => pad.t + (1 - v / hi) * (H - pad.t - pad.b);
  const bw = Math.max(2, Math.min(14, (W - pad.l - pad.r) / Math.max(1, cols.length) - 1));
  const step = (W - pad.l - pad.r) / Math.max(1, cols.length);
  const starts = cols.flatMap((c, i) =>
    i === 0 || cols[i - 1].season !== c.season ? [{ i, c }] : [],
  );
  const tone = { bust: 'risk', steady: 'context', boom: 'pool' } as const;
  return (
    <div className="pv-trend" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Every innings, in order">
        {ticks(0, hi, 3).map((v) => (
          <g key={v}>
            <line className="pv-grid" x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} />
            <text className="pv-tick" x={pad.l - 6} y={sy(v) + 3} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {cols.map((c, i) => (
          <rect
            key={i}
            className={`pv-fill ${tone[c.band]}`}
            x={pad.l + step * i + (step - bw) / 2}
            width={bw}
            y={sy(c.runs)}
            height={Math.max(1.5, sy(0) - sy(c.runs))}
            rx={1.5}
            onMouseEnter={() => setHover(c.tip)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
        {starts.map(({ i, c }) => (
          <g key={c.season}>
            <line
              className="pv-ref"
              x1={pad.l + step * i}
              x2={pad.l + step * i}
              y1={pad.t}
              y2={H - pad.b}
            />
            <text className="pv-tick" x={pad.l + step * i + 3} y={H - pad.b + 14}>
              {c.season}
            </text>
          </g>
        ))}
      </svg>
      <div className="pv-bar-sub">
        {hover ?? 'One bar per innings · red bust, grey steady, gold boom'}
      </div>
    </div>
  );
}

/* ── Where players are in the system ── */

export interface FlowRow {
  season: number;
  active: number;
  entered: number;
  left: number;
}

/** Players recorded each season, with those who appeared for the first time and those last seen. */
export function FlowBars({ rows }: { rows: FlowRow[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const [box, W] = useWidth(640);
  const pad = { l: 44, r: 8, t: 12, b: 28 };
  const H = 260;
  const maxA = Math.max(1, ...rows.map((r) => r.active)) * 1.1;
  const maxM = Math.max(1, ...rows.flatMap((r) => [r.entered, r.left])) * 1.2;
  // Top: players recorded (columns). Bottom: entered (up, navy) and left (down, red) around a line.
  const topH = (H - pad.t - pad.b) * 0.58;
  const midY = pad.t + topH + 14 + ((H - pad.t - pad.b) * 0.42 - 14) / 2;
  const half = ((H - pad.t - pad.b) * 0.42 - 14) / 2;
  const cw = (W - pad.l - pad.r) / Math.max(1, rows.length);
  return (
    <div className="pv-trend" ref={box}>
      <div className="pv-legend" aria-hidden="true">
        <span>
          <i className="pv-key third" />
          Players recorded
        </span>
        <span>
          <i className="pv-key squad" />
          First seen this season
        </span>
        <span>
          <i className="pv-key risk" />
          Last seen this season
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Players recorded, first seen and last seen, by season"
      >
        {rows.map((r, i) => {
          const x = pad.l + cw * i + cw * 0.18;
          const w = cw * 0.64;
          const th = (r.active / maxA) * topH;
          return (
            <g
              key={r.season}
              onMouseEnter={() =>
                setHover(
                  `${r.season}: ${r.active} players recorded · ${r.entered} first seen · ${r.left} last seen`,
                )
              }
              onMouseLeave={() => setHover(null)}
            >
              <rect
                x={pad.l + cw * i}
                y={pad.t}
                width={cw}
                height={H - pad.t - pad.b}
                fill="transparent"
              />
              <rect
                className="pv-fill third"
                x={x}
                width={w}
                y={pad.t + topH - th}
                height={th}
                rx={3}
              />
              <text className="pv-cap" x={x + w / 2} y={pad.t + topH - th - 4} textAnchor="middle">
                {r.active}
              </text>
              <rect
                className="pv-fill squad"
                x={x}
                width={w}
                y={midY - (r.entered / maxM) * half}
                height={(r.entered / maxM) * half}
                rx={2}
              />
              <rect
                className="pv-fill risk"
                x={x}
                width={w}
                y={midY}
                height={(r.left / maxM) * half}
                rx={2}
              />
              <text className="pv-label" x={pad.l + cw * (i + 0.5)} y={H - 8} textAnchor="middle">
                {r.season}
              </text>
            </g>
          );
        })}
        <line className="pv-ref" x1={pad.l} x2={W - pad.r} y1={midY} y2={midY} />
        <text className="pv-tick" x={pad.l - 6} y={midY - half + 8} textAnchor="end">
          in
        </text>
        <text className="pv-tick" x={pad.l - 6} y={midY + half} textAnchor="end">
          out
        </text>
      </svg>
      <div className="pv-bar-sub">
        {hover ?? 'The first season is everyone already in the data, so it shows no “first seen”'}
      </div>
    </div>
  );
}

export interface FunnelBar {
  key: string;
  label: string;
  ever: number;
  onward: number;
  leftHere: number;
  joinedHere: number;
  share: number | null;
  /** Flagged as a leak: the lowest onward share. */
  leak?: boolean;
}

/** The pipeline bracket by bracket: players seen, and how many went on to the next bracket. */
export function FunnelBars({ rows }: { rows: FunnelBar[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const [box, W] = useWidth(640);
  const labelW = 68;
  const rowH = 36;
  const H = rows.length * rowH + 6;
  const max = Math.max(1, ...rows.map((r) => r.ever));
  const sx = (v: number) => labelW + (v / max) * (W - labelW - 150);
  return (
    <div className="pv-trend" ref={box}>
      <div className="pv-legend" aria-hidden="true">
        <span>
          <i className="pv-key third" />
          Players seen at this bracket
        </span>
        <span>
          <i className="pv-key squad" />
          Also seen at the next bracket up
        </span>
        <span>
          <i className="pv-key risk" />
          Leak: the largest drop-off
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Players at each bracket and how many moved up"
      >
        {rows.map((r, i) => {
          const y = 3 + i * rowH;
          return (
            <g
              key={r.key}
              onMouseEnter={() =>
                setHover(
                  `${r.label}: ${r.ever} players seen · ${r.onward} also seen one bracket up · ${r.leftHere} last seen here · ${r.joinedHere} first seen here after the data began`,
                )
              }
              onMouseLeave={() => setHover(null)}
            >
              <text className="pv-label" x={labelW - 8} y={y + rowH / 2 + 2} textAnchor="end">
                {r.label}
              </text>
              <rect
                className="pv-fill third"
                x={sx(0)}
                y={y + 4}
                width={sx(r.ever) - sx(0)}
                height={14}
                rx={3}
              />
              <rect
                className="pv-fill squad"
                x={sx(0)}
                y={y + 4}
                width={sx(r.onward) - sx(0)}
                height={14}
                rx={3}
              />
              <text className="pv-cap" x={sx(r.ever) + 6} y={y + 15}>
                {r.ever}
              </text>
              <text className="pv-tick" x={sx(0)} y={y + 31}>
                {r.leftHere ? `${r.leftHere} last seen here` : ''}
                {r.leftHere && r.joinedHere ? ' · ' : ''}
                {r.joinedHere ? `${r.joinedHere} joined here` : ''}
              </text>
              {r.share !== null && (
                <text
                  className="pv-cap"
                  x={W - 6}
                  y={y + 15}
                  textAnchor="end"
                  style={{ fill: r.leak ? 'var(--viz-risk)' : 'var(--ink)' }}
                >
                  {Math.round(r.share * 100)}% move up{r.leak ? ' ▼' : ''}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="pv-bar-sub">
        {hover ??
          '“Move up” counts only players with time to have moved; those still in the bracket are left out'}
      </div>
    </div>
  );
}

export interface MixRow {
  key: string;
  label: string;
  games: Record<Setting, number>;
  total: number;
}

/** Where the games are played at each bracket: school, club, representative, franchise. */
export function SettingMixBars({ rows }: { rows: MixRow[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const [box, W] = useWidth(640);
  const labelW = 68;
  const rowH = 28;
  const H = rows.length * rowH + 6;
  const sx = (v: number) => labelW + v * (W - labelW - 8);
  return (
    <div className="pv-trend" ref={box}>
      <div className="pv-legend" aria-hidden="true">
        {SETTINGS.map((s) => (
          <span key={s}>
            <i className="pv-key" style={{ background: FILL[s] }} />
            {SETTING_LABEL[s]}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Games by setting at each bracket">
        {rows.map((r, i) => {
          const y = 3 + i * rowH;
          let acc = 0;
          return (
            <g
              key={r.key}
              onMouseEnter={() =>
                setHover(
                  `${r.label}: ${r.total.toLocaleString()} player-games — ${SETTINGS.filter(
                    (s) => r.games[s],
                  )
                    .map(
                      (s) =>
                        `${SETTING_LABEL[s].toLowerCase()} ${Math.round((r.games[s] / r.total) * 100)}%`,
                    )
                    .join(', ')}`,
                )
              }
              onMouseLeave={() => setHover(null)}
            >
              <text className="pv-label" x={labelW - 8} y={y + rowH / 2 + 2} textAnchor="end">
                {r.label}
              </text>
              {SETTINGS.map((s) => {
                const share = r.games[s] / r.total;
                const x = sx(acc);
                acc += share;
                return share ? (
                  <rect
                    key={s}
                    x={x + 1}
                    y={y + 4}
                    width={Math.max(0, sx(acc) - x - 2)}
                    height={rowH - 10}
                    rx={3}
                    fill={FILL[s]}
                  />
                ) : null;
              })}
            </g>
          );
        })}
      </svg>
      <div className="pv-bar-sub">{hover ?? 'Share of all player-games at the bracket'}</div>
    </div>
  );
}

/* ── A player's route, season by season (HTML table: it is also the accessible version) ── */

/**
 * Seasons across, settings down: each cell is the games played in that setting that season, with
 * the team on hover. The row above gives the age bracket that season, so a player's climb, and
 * any gap, reads at a glance.
 */
export function JourneyStrip({
  j,
  seasons,
  compact,
}: {
  j: Journey;
  seasons: number[];
  compact?: boolean;
}) {
  const rows = j.player.rows;
  const used = SETTINGS.filter((s) => rows.some((r) => r.setting === s));
  const maxG = Math.max(1, ...rows.map((r) => r.games));
  return (
    <div className={`jn-strip-wrap ${compact ? 'compact' : ''}`}>
      <table className="jn-strip" aria-label={`${j.player.name}: games by season and setting`}>
        <thead>
          <tr>
            <th scope="col" />
            {seasons.map((s) => (
              <th key={s} scope="col" className={s < j.first || s > j.last ? 'out' : ''}>
                {compact ? String(s).slice(2) : s}
              </th>
            ))}
          </tr>
          <tr className="jn-brk">
            <th scope="row">Age group</th>
            {seasons.map((s) => {
              const here = rows.filter((r) => r.season === s);
              const best = here.reduce<Bracket | null>(
                (acc, r) => (acc === null || rungOf(r.bracket) > rungOf(acc) ? r.bracket : acc),
                null,
              );
              return <td key={s}>{best ?? ''}</td>;
            })}
          </tr>
        </thead>
        <tbody>
          {used.map((st) => (
            <tr key={st}>
              <th scope="row">
                <i className="pv-key" style={{ background: FILL[st] }} />
                {SETTING_LABEL[st]}
              </th>
              {seasons.map((s) => {
                const here = rows.filter((r) => r.season === s && r.setting === st);
                const g = here.reduce((a, r) => a + r.games, 0);
                const team = [...new Set(here.map((r) => `${r.team} (${r.level})`))].join(', ');
                return (
                  <td
                    key={s}
                    className={g ? 'on' : ''}
                    title={g ? `${s} · ${team} · ${g} games` : `${s} · no games`}
                  >
                    {g ? (
                      <span style={{ background: FILL[st], opacity: 0.35 + 0.65 * (g / maxG) }}>
                        <b>{g}</b>
                      </span>
                    ) : (
                      ''
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
