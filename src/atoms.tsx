/* ─── Shared atom components ─── */

import { useState, useEffect, useRef } from 'react';
import type { ReactNode, CSSProperties, ComponentType, ButtonHTMLAttributes } from 'react';
import { CQI_STRUCTURE } from './data';
import type { Club } from './types';

/* ─── Icons (inline, no external deps) ─── */
export const Icon = {
  Dashboard: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
  Clubs: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <circle cx="5.5" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11" cy="7" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M1 13c.5-2 2.5-3 4.5-3s4 1 4.5 3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M10 13c.3-1.5 1.5-2.3 3-2.3s2.6.8 3 2.3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
  Form: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="3" y="2" width="10" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M6 6h4M6 9h4M6 12h2.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
  Upload: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M8 10V3M5 6l3-3 3 3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 11v2a1 1 0 001 1h8a1 1 0 001-1v-2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
  Star: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M8 2l1.8 4.2 4.2.4-3.2 2.8 1 4.4L8 11.5 4.2 13.8l1-4.4L2 6.6l4.2-.4L8 2z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Check: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M3 8.5l3 3 7-7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Alert: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1.5L14.5 13H1.5L8 1.5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M8 6.5v3M8 11.3v.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  Doc: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M4 1.5h6L13 4.5V14a.5.5 0 01-.5.5h-8A.5.5 0 014 14V1.5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M10 1.5V5h3" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6 8h4M6 11h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  Plus: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  Arrow: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M3 8h10M9 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Bell: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M3 11h10l-1.5-2V6.5a3.5 3.5 0 10-7 0V9L3 11z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 13a1.5 1.5 0 003 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
  Download: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M8 3v7M5 8l3 3 3-3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M3 13h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  Money: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="4" width="13" height="8" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
  Field: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="3" width="13" height="10" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <ellipse cx="8" cy="8" rx="3.5" ry="2.2" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="8" cy="8" r="0.7" fill="currentColor" />
    </svg>
  ),
  Whistle: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <circle cx="6" cy="9" r="4" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M10 9h4.5l-1.5-2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="6" cy="9" r="1" fill="currentColor" />
    </svg>
  ),
  Live: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2" fill="currentColor" />
      <circle cx="8" cy="8" r="4.5" stroke="currentColor" strokeWidth="1.4" opacity="0.5" />
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.4" opacity="0.2" />
    </svg>
  ),
  Shield: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1.5L2.5 3.5V8c0 3.5 2.4 5.5 5.5 6.5 3.1-1 5.5-3 5.5-6.5V3.5L8 1.5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Eye: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
  Mail: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="3" width="13" height="10" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 4l6 5 6-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  X: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Clock: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  Users: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <circle cx="6" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M1.5 13.5c.4-2.2 2.3-3.4 4.5-3.4s4.1 1.2 4.5 3.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M11 4.2a2.2 2.2 0 010 4.2M12.5 13.5c-.2-1.6-1-2.7-2.2-3.3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
};

/* ─── Atoms ─── */

interface PillProps {
  tone?: string;
  children?: ReactNode;
  dot?: boolean;
}
export function Pill({ tone = 'muted', children, dot }: PillProps) {
  return (
    <span className={`pill pill-${tone}`}>
      {dot && <span className={`sdot ${tone}`} />}
      {children}
    </span>
  );
}

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: string;
  size?: string;
  icon?: ComponentType;
}
export function Btn({ tone = 'outline', size, icon: I, children, onClick, ...rest }: BtnProps) {
  const cls = `btn btn-${tone}${size === 'sm' ? ' btn-sm' : ''}`;
  return (
    <button className={cls} onClick={onClick} {...rest}>
      {I && <I />}
      {children}
    </button>
  );
}

interface CardProps {
  title?: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
}
export function Card({ title, sub, action, children, style }: CardProps) {
  return (
    <div className="card" style={style}>
      {(title || action) && (
        <div className="card-head">
          <div>
            {title && <div className="card-title">{title}</div>}
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          {action && <div>{action}</div>}
        </div>
      )}
      <div className="card-body">{children}</div>
    </div>
  );
}

// Centered empty-state card — shared by admin pages that can render with no data
// (blank cohort: clubs, fixtures, affiliations, docs, CQI). Uses the .club-fix-empty
// design-system classes so every empty surface looks identical.
interface EmptyStateProps {
  icon?: ComponentType;
  title?: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
}
export function EmptyState({ icon: I, title, sub, action }: EmptyStateProps) {
  return (
    <div className="club-fix-empty">
      {I && (
        <div className="club-fix-empty-icon">
          <I />
        </div>
      )}
      <div className="club-fix-empty-title">{title}</div>
      {sub && <div className="club-fix-empty-sub">{sub}</div>}
      {action}
    </div>
  );
}

interface KPIProps {
  label?: ReactNode;
  num?: ReactNode;
  sub?: ReactNode;
  tone?: string;
}
export function KPI({ label, num, sub, tone = '' }: KPIProps) {
  return (
    <div className={`kpi ${tone}`}>
      <div className="kpi-l">{label}</div>
      <div className="kpi-n">{num}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

interface ProgressBarProps {
  value: number;
  tone?: string;
}
export function ProgressBar({ value, tone }: ProgressBarProps) {
  return (
    <div className="pbar">
      <div
        className={`pbar-fill ${tone || ''}`}
        style={{ width: Math.min(100, Math.max(0, value)) + '%' }}
      />
    </div>
  );
}

interface ProgChipProps {
  value: number;
  tone?: string;
}
export function ProgChip({ value, tone = 'teal' }: ProgChipProps) {
  return (
    <div className="prog-chip">
      <div className="prog-chip-bar">
        <div
          className="prog-chip-fill"
          style={{ width: value + '%', background: `var(--${tone})` }}
        />
      </div>
      <div className="prog-chip-num">{value}%</div>
    </div>
  );
}

interface ClubAvatarProps {
  club: Pick<Club, 'name' | 'color'>;
  size?: number;
}
export function ClubAvatar({ club, size = 30 }: ClubAvatarProps) {
  const initials = club.name
    .split(/\s+/)
    .filter((w) => /^[A-Z]/.test(w))
    .slice(0, 2)
    .map((w) => w[0])
    .join('');
  return (
    <div
      className="club-avatar"
      style={{ background: club.color, width: size, height: size, fontSize: size * 0.34 }}
    >
      {initials}
    </div>
  );
}

interface ClubNameCellProps {
  club: Pick<Club, 'name' | 'color' | 'sub'>;
}
export function ClubNameCell({ club }: ClubNameCellProps) {
  return (
    <div className="club-name-cell">
      <ClubAvatar club={club} />
      <div>
        <div className="club-name">{club.name}</div>
        <div className="club-district">{club.sub}</div>
      </div>
    </div>
  );
}

/* yes/no segmented — conditional colours + icons in active state */
interface YNProps {
  value?: boolean | null;
  onChange: (v: boolean) => void;
}
export function YN({ value, onChange }: YNProps) {
  return (
    <div className="seg">
      <button
        className={`seg-btn ${value === true ? 'on yes' : ''}`}
        onClick={() => onChange(true)}
      >
        {value === true && <Icon.Check />}
        <span>Yes</span>
      </button>
      <button
        className={`seg-btn ${value === false ? 'on no' : ''}`}
        onClick={() => onChange(false)}
      >
        {value === false && <Icon.X />}
        <span>No</span>
      </button>
    </div>
  );
}

/* Uncapped count input — CQI Representation demographics (no per-race limit).
   Emits a clean non-negative integer, or '' when the field is empty, matching the
   integer contract the rest of the CQI state/scoring already expects. */
interface CountInputProps {
  value?: number | string;
  onChange: (v: number | '') => void;
  min?: number;
  label?: string;
}
export function CountInput({ value, onChange, min = 0, label }: CountInputProps) {
  return (
    <input
      className="num-input"
      type="number"
      inputMode="numeric"
      min={min}
      aria-label={label}
      value={value ?? ''}
      onChange={(e) =>
        onChange(e.target.value === '' ? '' : Math.max(min, parseInt(e.target.value, 10) || 0))
      }
    />
  );
}

/* legacy stepper (kept for direct callers) */
interface NumStepProps {
  value?: number | string;
  onChange: (v: number | '') => void;
  min?: number;
  max?: number;
}
export function NumStep({ value, onChange, min = 0, max = 99 }: NumStepProps) {
  return (
    <input
      className="num-input"
      type="number"
      min={min}
      max={max}
      value={value ?? ''}
      onChange={(e) =>
        onChange(
          e.target.value === '' ? '' : Math.max(min, Math.min(max, parseInt(e.target.value) || 0)),
        )
      }
    />
  );
}

/* Choice — segmented control for arbitrary string options (used by CQI subscription cycle) */
interface ChoiceProps {
  value?: string;
  onChange: (v: string) => void;
  options: string[];
}
export function Choice({ value, onChange, options }: ChoiceProps) {
  return (
    <div className="seg">
      {options.map((opt) => (
        <button
          key={opt}
          className={`seg-btn ${value === opt ? 'on yes' : ''}`}
          onClick={() => onChange(opt)}
        >
          {value === opt && <Icon.Check />}
          <span>{opt}</span>
        </button>
      ))}
    </div>
  );
}

/* Rating — 1–5 Likert segmented control (used by CQI mandate/objectives questions) */
interface RatingProps {
  value?: number | string;
  onChange: (n: number) => void;
}
export function Rating({ value, onChange }: RatingProps) {
  const current = parseInt(String(value)) || 0;
  return (
    <div className="seg">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          className={`seg-btn ${current === n ? 'on yes' : ''}`}
          onClick={() => onChange(n)}
        >
          <span>{n}</span>
        </button>
      ))}
    </div>
  );
}

/* Money — currency input with prefix and value formatting */
interface MoneyInputProps {
  value?: number | string;
  onChange: (v: number | '') => void;
  currency?: string;
  suffix?: string;
}
export function MoneyInput({
  value,
  onChange,
  currency = 'R',
  suffix = '/ member',
}: MoneyInputProps) {
  return (
    <div className="money-input">
      <span className="money-currency">{currency}</span>
      <input
        type="number"
        min="0"
        step="any"
        className="money-field"
        placeholder="0"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? '' : parseFloat(e.target.value) || 0)}
      />
      <span className="money-suffix">{suffix}</span>
    </div>
  );
}

/* slider input — used in CQI for capped quantities (teams, coaches, fields, %) */
interface NumSliderProps {
  value?: number | string;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
}
export function NumSlider({ value, onChange, min = 0, max = 10, suffix }: NumSliderProps) {
  const v =
    value === '' || value == null ? 0 : Math.max(min, Math.min(max, parseInt(String(value)) || 0));
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  return (
    <div className="num-slider" style={{ '--pct': pct + '%' } as CSSProperties}>
      <input
        type="range"
        min={min}
        max={max}
        value={v}
        onChange={(e) => onChange(parseInt(e.target.value))}
        className="num-slider-input"
        aria-label={`Value between ${min} and ${max}`}
      />
      <div className="num-slider-val">
        <span className="num-slider-num">
          {v}
          {suffix || ''}
        </span>
        <span className="num-slider-max">
          / {max}
          {suffix || ''}
        </span>
      </div>
    </div>
  );
}

/* CountUp — animates smoothly between previous + new target, with a setTimeout fallback so the value lands even if rAF is throttled (background tabs, headless contexts). */
interface CountUpProps {
  to: number | string;
  duration?: number;
  decimals?: number;
  suffix?: string;
}
export function CountUp({ to, duration = 900, decimals = 0, suffix = '' }: CountUpProps) {
  const target = Number(to) || 0;
  const [val, setVal] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef<number | null>(null);
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (fallbackRef.current !== null) clearTimeout(fallbackRef.current);
    const from = fromRef.current;
    if (from === target) {
      setVal(target);
      return;
    }
    const start = performance.now();
    const animate = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = from + (target - from) * eased;
      fromRef.current = v;
      setVal(v);
      if (t < 1) rafRef.current = requestAnimationFrame(animate);
      else {
        fromRef.current = target;
        setVal(target);
      }
    };
    rafRef.current = requestAnimationFrame(animate);
    // Safety net — guarantees the value lands at target even when rAF is throttled
    fallbackRef.current = setTimeout(() => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      fromRef.current = target;
      setVal(target);
    }, duration + 80);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (fallbackRef.current !== null) clearTimeout(fallbackRef.current);
    };
  }, [target, duration]);
  if (decimals === 0)
    return (
      <>
        {Math.round(val)}
        {suffix}
      </>
    );
  return (
    <>
      {val.toFixed(decimals)}
      {suffix}
    </>
  );
}

/* statusFor — picks "good"/"warn"/"danger" tone based on a percentage value */
export function statusFor(value: number, goodAt = 70, warnAt = 40) {
  if (value >= goodAt) return 'good';
  if (value >= warnAt) return 'warn';
  return 'danger';
}

/* Affiliation status helpers */
export function affPill(status: string) {
  if (status === 'complete') return <Pill tone="teal">Affiliated</Pill>;
  if (status === 'in_progress') return <Pill tone="gold">In progress</Pill>;
  return <Pill tone="muted">Not started</Pill>;
}

export function cqiBand(score: number) {
  if (score === 0) return { tone: 'muted', label: 'Pending' };
  if (score >= 80) return { tone: 'teal', label: 'A · ' + score.toFixed(1) };
  if (score >= 65) return { tone: 'navy', label: 'B · ' + score.toFixed(1) };
  if (score >= 50) return { tone: 'gold', label: 'C · ' + score.toFixed(1) };
  return { tone: 'coral', label: 'D · ' + score.toFixed(1) };
}

/* CQI live scoring — mirrors the spreadsheet weighting model.
   Each question contributes its `pts` value, scaled by yes/no or by num/max.
   Section total = sum of pts (which roughly equals the section weight),
   we then proportion to the section weight and total to 100. */
export function scoreCQI(answers: Record<string, any>) {
  let totalScore = 0;
  const byCat: Record<string, { earned: number; possible: number }> = {};
  for (const cat of CQI_STRUCTURE) {
    let earned = 0,
      possible = 0;
    // Representation 'count' questions score on each race's SHARE of the category
    // total (head-count ÷ total counted), so the diversity weighting is preserved
    // even though the input is now a raw count rather than a percentage.
    const countTotal = cat.questions
      .filter((q) => q.kind === 'count')
      .reduce((s, q) => s + (parseFloat(answers[q.key]) || 0), 0);
    for (const q of cat.questions) {
      possible += q.pts;
      const v = answers[q.key];
      if (q.kind === 'yn') {
        if (v === true) earned += q.pts;
      } else if (q.kind === 'num') {
        const max = q.max || 10;
        const num = Math.max(0, Math.min(max, parseFloat(v) || 0));
        earned += (num / max) * q.pts;
      } else if (q.kind === 'count') {
        // Representation: each race earns points in proportion to its share of the
        // club's counted players. Black African is weighted 1.5× per the spreadsheet.
        const share = countTotal > 0 ? (parseFloat(v) || 0) / countTotal : 0;
        const weight = q.key === 'pctBA' ? 1.5 : 1.0;
        earned += Math.min(q.pts, share * q.pts * weight);
      } else if (q.kind === 'rating') {
        // 1–5 Likert: proportional credit (rating ÷ 5).
        const num = Math.max(0, Math.min(5, parseFloat(v) || 0));
        earned += (num / 5) * q.pts;
      } else if (q.kind === 'choice') {
        // Any option selected = full points
        if (v) earned += q.pts;
      } else if (q.kind === 'money') {
        // A positive amount = full points (presence of structure matters)
        const num = parseFloat(v) || 0;
        if (num > 0) earned += q.pts;
      }
    }
    const sectionScore = possible > 0 ? (earned / possible) * cat.weight : 0;
    byCat[cat.key] = { earned: sectionScore, possible: cat.weight };
    totalScore += sectionScore;
  }
  return { total: Math.round(totalScore * 10) / 10, byCat };
}

/* Simulated toast */
/* Close-on-Escape hook for modals/overlays. */
export function useEscapeClose(onClose: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);
}

interface ToastAction {
  label: ReactNode;
  onClick?: () => void;
}
export function useToast(): [(m: string, t?: string, act?: ToastAction | null) => void, ReactNode] {
  const [msg, setMsg] = useState<string | null>(null);
  const [tone, setTone] = useState<string>('ok');
  // Optional inline action (e.g. an Undo button) carried by a toast.
  const [action, setAction] = useState<ToastAction | null>(null);
  // Single timer ref so a new toast clears any pending dismissal — otherwise the
  // previous toast's timeout could clear a fresh message early, or leave a stale
  // action button rendered on an unrelated message.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function clear() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setMsg(null);
    setAction(null);
  }
  function show(m: string, t: string = 'ok', act: ToastAction | null = null) {
    if (timer.current) clearTimeout(timer.current);
    setMsg(m);
    setTone(t);
    setAction(act);
    // Give action toasts longer so there's time to click (e.g. Undo).
    timer.current = setTimeout(clear, act ? 6000 : 2400);
  }
  const node = msg ? (
    // role=status + aria-live so the message — and any Undo action — is announced
    // to screen-reader / keyboard users before the toast auto-dismisses.
    <div
      role="status"
      aria-live="polite"
      className={`toast show ${tone}`}
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        zIndex: 999,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        fontFamily: "'Montserrat',sans-serif",
        fontSize: 12,
        fontWeight: 500,
        padding: '10px 18px',
        borderRadius: 8,
        background: tone === 'ok' ? 'var(--teal)' : tone === 'warn' ? 'var(--gold)' : 'var(--ink)',
        color: tone === 'warn' ? 'var(--ink)' : '#fff',
      }}
    >
      <span>{msg}</span>
      {action && (
        <button
          type="button"
          // Clear THIS toast first, then run the handler — which may itself raise a
          // new toast (e.g. Undo → reciprocal Undo). React batches both state
          // updates in this handler, so the new toast wins cleanly.
          onClick={() => {
            clear();
            if (action.onClick) action.onClick();
          }}
          style={{
            background: 'transparent',
            border: 'none',
            padding: '2px 4px',
            margin: 0,
            cursor: 'pointer',
            font: 'inherit',
            fontWeight: 700,
            color: 'inherit',
            textDecoration: 'underline',
            textUnderlineOffset: 2,
            opacity: 0.95,
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  ) : null;
  return [show, node];
}

// Expose atoms on window for the legacy inline prototype; guarded so importing
// this module in a non-browser context (tests, SSR) doesn't throw.
if (typeof window !== 'undefined')
  Object.assign(window, {
    Icon,
    Pill,
    Btn,
    Card,
    KPI,
    ProgressBar,
    ProgChip,
    ClubAvatar,
    ClubNameCell,
    YN,
    NumStep,
    NumSlider,
    Choice,
    MoneyInput,
    CountUp,
    statusFor,
    affPill,
    cqiBand,
    scoreCQI,
    useToast,
    useEscapeClose,
  });
