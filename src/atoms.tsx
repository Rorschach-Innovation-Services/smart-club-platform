/* ─── Shared atom components ─── */

import { useState, useEffect, useRef, useId } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode, CSSProperties, ComponentType, ButtonHTMLAttributes } from 'react';
import { scoreCQI, cqiBand } from './cqiScore';
import type { Club } from './types';
import { GUIDE_URL, HelpLink } from './help/HelpDrawer';
import { useFocusTrap } from './useFocusTrap';
import { FIELD_GUIDES, type FieldGuideId } from './help/field-guides';

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
  Info: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 7.1v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="4.8" r="0.6" fill="currentColor" />
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
  Chart: () => (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M3 13.5V9M8 13.5V5M13 13.5V2.5"
        stroke="currentColor"
        strokeWidth="1.6"
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

/**
 * Single source of truth for a player's roster-status pill — shared by the admin cross-club
 * list, the club roster, and the player detail modal so a status is never rendered
 * inconsistently (or silently as "Active" when a new status is added). Absent ⇒ 'active'.
 */
export function playerStatusPill(status?: string) {
  if (status === 'clearance-pending')
    return (
      <Pill tone="gold" dot>
        Clearance pending
      </Pill>
    );
  // 'clearance-rejected' is legacy — reject no longer writes it; rows from before still render.
  if (status === 'clearance-rejected')
    return (
      <Pill tone="coral" dot>
        Clearance rejected
      </Pill>
    );
  if (status === 'inactive') return <Pill tone="muted">Inactive</Pill>;
  return (
    <Pill tone="teal" dot>
      Active
    </Pill>
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

interface BoundedNumberProps {
  value: number;
  onChange: (n: number) => void;
  /** Inclusive floor. Enforced on blur, never mid-keystroke. */
  min?: number;
  /** Inclusive ceiling, enforced the same way. */
  max?: number;
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Accessible name, for the cases where the visible caption is a separate node the
   * input isn't bound to — a table column header, or a `field-label` beside it. Prefer
   * `Field`, which binds a real label; use this where the layout has no room for one.
   */
  ariaLabel?: string;
}

/**
 * A number input with a floor that doesn't fight the person typing.
 *
 * `onChange={(e) => set(Math.max(2, +e.target.value || 2))}` looks harmless and makes
 * whole ranges unenterable: clear the box to retype and `+'' || 2` snaps it to 2, the
 * caret lands after the digit, and the next keystroke appends — so 16 becomes 26, and 10
 * to 19 cannot be entered at all. On a finishing position it is worse than friction:
 * 3 → clear → 5 silently yields 15, and a wrong cross-pool bracket follows.
 *
 * So: hold the raw text while it is being edited, publish upward only when the typed
 * value is genuinely in range, and clamp (or revert) on blur. Same remedy the sizes,
 * group-label and lat/lon fields already use, generalised so it stops being re-derived
 * one input at a time.
 */
export function BoundedNumber({
  value,
  onChange,
  min = 0,
  max,
  className = 'field-input',
  style,
  placeholder,
  disabled,
  ariaLabel,
}: BoundedNumberProps) {
  const [text, setText] = useState(String(value ?? ''));
  // Re-seed when the model changes from OUTSIDE — a template swap, a reset — but not
  // from our own keystrokes, which is what tracking the last published value separates.
  const [published, setPublished] = useState(value);
  if (value !== published) {
    setPublished(value);
    setText(String(value ?? ''));
  }

  const inRange = (n: number) => n >= min && (max === undefined || n <= max);

  return (
    <input
      type="number"
      className={className}
      style={style}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      min={min}
      max={max}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseInt(e.target.value, 10);
        if (Number.isFinite(n) && inRange(n)) {
          setPublished(n);
          onChange(n);
        }
      }}
      onBlur={(e) => {
        const n = parseInt(e.target.value, 10);
        // Unparseable or out of range on the way out: settle on the nearest legal value
        // rather than leaving the box saying something the model doesn't hold.
        const next = Number.isFinite(n)
          ? Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min, n))
          : value;
        setText(String(next));
        setPublished(next);
        if (next !== value) onChange(next);
      }}
    />
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

// CQI scoring moved to ./cqiScore (pure, React-free) so it can be imported outside the
// SPA (the export-cohort CLI). Re-exported here so every existing call site is unchanged.
export { scoreCQI, cqiBand };

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

/**
 * Close-on-Escape for a NESTED modal opened above another modal. A capture-phase
 * window listener fires before useEscapeClose's bubble-phase one and calls
 * stopImmediatePropagation, so Escape closes only this inner surface — the parent
 * modal's own useEscapeClose never sees the key. (Same technique as InfoDot.)
 */
export function useNestedEscapeClose(onClose: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onClose]);
}

/**
 * The one modal shell. Every console dialog renders through it so they share the
 * `.task-modal*` look and the same accessibility behaviour:
 * - `role="dialog"` + `aria-modal`, named by the visible title (or `labelledBy`, when the
 *   caller renders its own heading) — without a role a dialog is an ordinary div to
 *   assistive tech: nothing announces it opened and nothing scopes the reading order;
 * - Escape closes;
 * - Tab and Shift+Tab cycle inside the dialog (`useFocusTrap`, shared with the help drawer);
 * - focus moves into the dialog on open (unless a child already took it, e.g. `autoFocus`)
 *   and returns to whatever had it when the dialog closes;
 * - a click on the backdrop closes, unless `dismissable={false}` (a form that must not lose
 *   its input to a stray click).
 *
 * Portalled to document.body so the fixed backdrop centres on the viewport, not on the
 * residual transform the fadeUp animation leaves on `.main > *`. The help drawer's
 * backdrop sits above it (z-index 1100 vs 900), so help opens over any modal.
 */
export function Modal({
  eyebrow,
  title,
  onClose,
  maxWidth,
  children,
  footer,
  labelledBy,
  dismissable = true,
  closeLabel = 'Close',
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  onClose: () => void;
  /** Caps the dialog's width in px; absent ⇒ the stylesheet's full width. */
  maxWidth?: number;
  children?: ReactNode;
  /** Pinned below the scrolling body — for actions that must stay in view. */
  footer?: ReactNode;
  /** Id of an element that names the dialog, in place of the built-in title. */
  labelledBy?: string;
  /** False ⇒ a backdrop click does not close. Escape and the close button still do. */
  dismissable?: boolean;
  /** Tooltip on the close button. */
  closeLabel?: string;
}) {
  useEscapeClose(onClose);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);
  // Read during the first render, before any child's autoFocus runs, so it is the element
  // that opened the dialog rather than something inside it.
  const restoreTo = useRef<Element | null>(
    typeof document !== 'undefined' ? document.activeElement : null,
  );
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
    const opener = restoreTo.current;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  const style: CSSProperties = {};
  if (maxWidth) style.maxWidth = maxWidth;
  if (footer) style.gridTemplateRows = 'auto 1fr auto';
  return createPortal(
    <div
      className="task-modal-backdrop"
      onClick={(e) => dismissable && e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        className="task-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? titleId}
        tabIndex={-1}
        style={style}
      >
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            {eyebrow && <div className="task-modal-head-eyebrow">{eyebrow}</div>}
            <div className="task-modal-head-title" id={titleId}>
              {title}
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title={closeLabel}>
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">{children}</div>
        {footer && <div className="task-modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Horizontal-scroll wrapper with an edge fade + "scroll for more" affordance, shown only
 * while columns are off-screen. Wrap a `<table>` INSIDE its `.tbl-w` so wide tables — the
 * compliance docs tracker, the season viewer's 11-column schedule — scroll with a visible
 * hint instead of squashing or clipping silently. The fade is a mask on the scroller
 * content (uniform over the dark thead); the hint is tied to `has-right`, so it only
 * appears while there is more to the right and vanishes at the end.
 */
export function ScrollX({
  children,
  hint = 'Scroll for more',
  label,
}: {
  children: ReactNode;
  hint?: string;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const update = () => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 0);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };
  useEffect(() => {
    update();
    // jsdom has no ResizeObserver (vitest.setup stubs only matchMedia/scrollIntoView) and
    // the SeasonViewer tests mount this transitively — construct it only when it exists,
    // degrading to scroll-events-only rather than crashing on mount.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Re-measure on every render: content width can change without a scroll event or a
  // resize of the scroller box (e.g. a different table rendered inside), which would
  // otherwise leave has-left/has-right stale. The plain-boolean setState calls bail
  // when the value is unchanged, so this cannot loop.
  useEffect(update);
  return (
    <div className={`scroll-x${canLeft ? ' has-left' : ''}${canRight ? ' has-right' : ''}`}>
      {canRight && (
        <span className="scroll-x-hint" aria-hidden="true">
          {hint} →
        </span>
      )}
      <div
        className="scroll-x-inner"
        ref={ref}
        onScroll={update}
        tabIndex={0}
        role="region"
        aria-label={label ?? hint}
      >
        {children}
      </div>
    </div>
  );
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
/**
 * A labelled form field.
 *
 * The visible label used to be a plain `<div className="field-label">` sitting BESIDE the
 * input, which associates them for a sighted user and for nobody else: a screen reader
 * announces "edit text, blank", and no test can ask for the box by its name either. This
 * renders the same markup with the label bound to the control, so the caption becomes the
 * control's accessible name.
 *
 * The id is generated, so callers never invent one:
 *
 *   <Field label="Latitude" required>
 *     {(id) => <input id={id} className="field-input" … />}
 *   </Field>
 */
export function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
        {required && <span className="req">*</span>}
      </label>
      {children(id)}
    </div>
  );
}

/**
 * A small "(i)" help affordance. Click to open a popover that explains a field
 * and — when `options` is passed — every value it offers, one line each.
 *
 * Portaled to <body>, not absolutely positioned. Every place it's used sits
 * inside an overflow-clipping ancestor (the stage-row card, the task-modal body,
 * the grounds table), and an absolute child would be cut off — z-index does
 * nothing against overflow clipping. So we anchor to the trigger's
 * getBoundingClientRect() and render position:fixed, flipping above when there's
 * no room below.
 *
 * Escape closes the popover without closing a parent modal: `useEscapeClose`
 * listens on window in the bubble phase, so a capture-phase listener here fires
 * first and calls stopImmediatePropagation — the modal never sees the key.
 */
// Module-level single-open latch, shared by every InfoDot (and InfoTip, which is the
// same component): opening one closes any other. Each instance clears the latch only
// while it still holds it, so the next dot never calls a closed or unmounted one.
let closeActiveInfoDot: (() => void) | null = null;

export function InfoDot({
  title,
  label,
  options,
  children,
  align = 'start',
}: {
  /** Shown as the popover's heading, and the button's name when `label` is unset. */
  title?: string;
  /** The button's accessible name, with no popover heading (the InfoTip usage). */
  label?: string;
  options?: Array<{ label: string; desc: ReactNode; eg?: ReactNode }>;
  children?: ReactNode;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    flipY: boolean;
    maxHeight: number;
  } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();
  const closeSelfRef = useRef<(() => void) | null>(null);

  const place = () => {
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    const W = 280;
    const margin = 8;
    let left = align === 'end' ? b.right - W : b.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - W - margin));
    // Open on whichever side has more room; a tall option list then caps to the
    // available height and scrolls inside itself rather than running off-screen.
    const spaceBelow = window.innerHeight - b.bottom - margin;
    const spaceAbove = b.top - margin;
    const flipY = spaceBelow < 240 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(140, (flipY ? spaceAbove : spaceBelow) - 6);
    setPos({ top: flipY ? b.top - 6 : b.bottom + 6, left, flipY, maxHeight });
  };

  // Listeners live only while open — closed dots hold none, so a screen full of
  // them doesn't each keep a window listener alive.
  useEffect(() => {
    if (!open) return;
    place();
    const onDown = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        setOpen(false);
      }
    };
    const onReflow = () => place();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
    // place() reads live layout each open; deps intentionally just [open].
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Release the latch whenever this dot closes by any route (outside click, Escape,
  // blur) or unmounts — but only while this dot still holds it.
  useEffect(() => {
    if (open) return;
    if (closeActiveInfoDot === closeSelfRef.current) closeActiveInfoDot = null;
  }, [open]);
  useEffect(
    () => () => {
      if (closeActiveInfoDot === closeSelfRef.current) closeActiveInfoDot = null;
    },
    [],
  );

  const toggle = (e: React.MouseEvent) => {
    // The dot often sits inside a <label>; stop the click reaching it, or opening
    // help would also toggle the label's checkbox/radio.
    e.preventDefault();
    e.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    if (closeActiveInfoDot) closeActiveInfoDot();
    const close = () => setOpen(false);
    closeSelfRef.current = close;
    closeActiveInfoDot = close;
    setOpen(true);
  };

  // Keyboard users tabbing away close the popover. Only when focus lands on another
  // element: a click on the popover's own text blurs to <body>, and the outside-click
  // listener already handles real outside clicks.
  const onBlur = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (!next) return;
    if (btnRef.current?.contains(next) || popRef.current?.contains(next)) return;
    setOpen(false);
  };

  return (
    <span className="info-wrap" onBlur={onBlur}>
      <button
        ref={btnRef}
        type="button"
        className="info-dot"
        aria-label={label ?? title ?? 'What this means'}
        aria-expanded={open}
        aria-describedby={open ? popId : undefined}
        onClick={toggle}
      >
        <Icon.Info />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            id={popId}
            className="info-pop"
            role="tooltip"
            style={{
              top: pos.top,
              left: pos.left,
              maxHeight: pos.maxHeight,
              transform: pos.flipY ? 'translateY(-100%)' : undefined,
            }}
          >
            {title && <div className="info-pop-t">{title}</div>}
            {children}
            {options && (
              <dl>
                {options.map((o) => (
                  <div key={o.label}>
                    <dt>{o.label}</dt>
                    <dd>
                      {o.desc}
                      {o.eg && <span className="info-pop-eg">e.g. {o.eg}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}

/* ─── Explainer components (season setup) ─── */

export interface OptionCard<T extends string> {
  value: T;
  title: string;
  /** One line: what choosing this does. */
  desc: string;
  /** A concrete example, shown as "e.g. …". */
  eg?: string;
  disabled?: boolean;
  /** Why this option can't be picked right now. Shown on the card. */
  disabledReason?: string;
}

/**
 * A radio group drawn as cards: each card is a <label> around a real radio input, so
 * clicking anywhere on the card selects it and arrow keys move the selection exactly as
 * native radios do. The input is visually hidden but stays focusable; the card shows the
 * focus ring.
 */
export function OptionCards<T extends string>({
  name,
  value,
  onChange,
  options,
  columns = 2,
  compact,
  label,
}: {
  name: string;
  value: T | null | undefined;
  onChange: (value: T) => void;
  options: OptionCard<T>[];
  columns?: number;
  /** Tighter cards with no example line. */
  compact?: boolean;
  /** Accessible name for the group. */
  label?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`opt-cards${compact ? ' compact' : ''}`}
      style={{ '--opt-cols': columns } as CSSProperties}
    >
      {options.map((o) => {
        const selected = o.value === value;
        const cls = ['opt-card', selected && 'is-selected', o.disabled && 'is-disabled']
          .filter(Boolean)
          .join(' ');
        return (
          <label key={o.value} className={cls}>
            <input
              type="radio"
              className="opt-card-input"
              name={name}
              value={o.value}
              checked={selected}
              disabled={o.disabled}
              onChange={() => onChange(o.value)}
            />
            <span className="opt-card-title">{o.title}</span>
            <span className="opt-card-desc">{o.desc}</span>
            {o.eg && !compact && <span className="opt-card-eg">e.g. {o.eg}</span>}
            {o.disabled && o.disabledReason && (
              <span className="opt-card-reason">{o.disabledReason}</span>
            )}
          </label>
        );
      })}
    </div>
  );
}

const HSW_PIPELINE = ['Competition', 'Season', 'Stage', 'Group', 'Fixtures'];

const HSW_IDEAS: Array<{ title: string; text: string }> = [
  {
    title: 'A league is not a competition',
    text: 'A league holds one or more competitions, each a format stream with its own shape and dates, so the same clubs can play a T20 in groups and a 50-over league in two halves.',
  },
  {
    title: 'A competition is a pipeline of stages',
    text: 'Each stage is one phase of play and answers three questions: who plays, who plays whom, and when.',
  },
  {
    title: 'One group becomes one series',
    text: 'When a stage generates, each group becomes an ordinary series, so approving, releasing and broadcasts work exactly as they always have.',
  },
  {
    title: 'Standings are typed by a human, on purpose',
    text: 'The platform records no results, so a stage that depends on finishing order stops, quotes its rule and waits for the administrator to type the positions.',
  },
];

/** The four ideas behind season setup, from Part One of the league structures guide. */
export function HowSeasonsWork({ compact }: { compact?: boolean }) {
  const strip = (
    <ol className="hsw-pipeline" aria-label="How a season is put together">
      {HSW_PIPELINE.map((n) => (
        <li key={n} className="hsw-node">
          {n}
        </li>
      ))}
    </ol>
  );
  if (compact) {
    return (
      <section className="hsw compact">
        {strip}
        <p className="hsw-summary">
          A competition is a pipeline of stages; each stage plays in one block, and each of its
          groups becomes one series of fixtures. <HelpLink topic="blocks-vs-stages" />
        </p>
      </section>
    );
  }
  return (
    <section className="hsw">
      {strip}
      <div className="hsw-ideas">
        {HSW_IDEAS.map((idea) => (
          <div key={idea.title} className="hsw-idea">
            <h4>{idea.title}</h4>
            <p>{idea.text}</p>
          </div>
        ))}
      </div>
      <p className="hsw-summary">
        The operator builds the shape once. The administrator runs the season through it every year.{' '}
        <a className="help-link" href={GUIDE_URL} target="_blank" rel="noopener noreferrer">
          Open the full guide
        </a>
      </p>
    </section>
  );
}

export interface StatusStep {
  label: string;
  state: 'done' | 'current' | 'todo';
  hint?: string;
}

const STATUS_WORD: Record<StatusStep['state'], string> = {
  done: 'done',
  current: 'current',
  todo: 'not started',
};

/** Where something is in its lifecycle: dots joined by a line, the current one ringed. */
export function StatusTimeline({ steps }: { steps: StatusStep[] }) {
  const summary = steps.map((s) => `${s.label}: ${STATUS_WORD[s.state]}`).join(', ');
  return (
    <ol className="status-tl" aria-label={summary}>
      {steps.map((s) => (
        <li
          key={s.label}
          className={`status-tl-step is-${s.state}`}
          aria-current={s.state === 'current' ? 'step' : undefined}
        >
          <span className="status-tl-dot" aria-hidden="true" />
          <span className="status-tl-label">{s.label}</span>
          {s.state === 'current' && s.hint && <span className="status-tl-hint">{s.hint}</span>}
        </li>
      ))}
    </ol>
  );
}

/** A numbered "what happens next" strip. Wraps onto several lines on phones. */
export function NextSteps({ steps }: { steps: Array<{ title: string; desc: string }> }) {
  return (
    <ol className="next-steps">
      {steps.map((s, i) => (
        <li key={s.title} className="next-steps-step">
          <span className="next-steps-num" aria-hidden="true">
            {i + 1}
          </span>
          <span className="next-steps-text">
            <span className="next-steps-title">{s.title}</span>
            <span className="next-steps-desc">{s.desc}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The explainer for one form field, placed under the field. */
export function FieldGuide({ id }: { id: FieldGuideId }) {
  const g = (FIELD_GUIDES as Record<string, (typeof FIELD_GUIDES)[FieldGuideId] | undefined>)[id];
  if (!g) return null;
  return (
    <div className="field-guide">
      <p>{g.meaning}</p>
      <p>
        <span className="field-guide-k">Used for:</span> {g.howUsed}
      </p>
      <p className="field-guide-eg">e.g. {g.example}</p>
      {g.convention && <span className="field-guide-conv">{g.convention}</span>}
    </div>
  );
}

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
    BoundedNumber,
    Field,
    InfoDot,
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
