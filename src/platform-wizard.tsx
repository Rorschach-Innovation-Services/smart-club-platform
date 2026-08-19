/**
 * Shared primitives for the operator-console intake/review wizards (bulk doc intake,
 * and the roster/structure/reps wizards it's the template for).
 *
 * Split out of platform-intake.tsx: everything here has (or will shortly have) a
 * second consumer. Extraction is mechanical — no markup/behavior change for the
 * existing doc-intake caller — so platform-intake.dom.test.tsx keeps passing
 * unchanged as the regression gate.
 *
 * Also carries the two guidance primitives every wizard step leans on so a
 * non-engineer operator never needs this document to understand a screen:
 * `InfoTip` (a small inline "what does this mean" popover) and `StepIntro` (a short,
 * always-visible overview block at the top of a step).
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import * as api from './api';
import { ApiError } from './api';
import { Btn, Icon, Pill, useEscapeClose } from './atoms';
import type { Club } from './types';

export const ERR: CSSProperties = { color: 'var(--coral, #C0392B)', fontSize: 12, marginTop: 6 };
export const HINT: CSSProperties = { fontSize: 11.5, color: 'var(--muted-2)', margin: '8px 0 0' };

/** "1.4 MB" / "812 KB" — no shared formatter exists for arbitrary byte counts. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/* ─── Create-club modal ───
 * Generalized out of the doc-intake wizard's row-specific version: any wizard that
 * hits an unmatched club mid-review can offer the same immediate-create escape
 * hatch. `initialName` replaces the old row-derived guess (callers compute their own
 * best guess — a folder segment, a workbook cell, whatever their row shape carries);
 * `eyebrow` replaces the hardcoded "Bulk intake · New club" so each wizard can name
 * itself. Everything else — including the hint copy — is unchanged, so the existing
 * doc-intake caller renders byte-for-byte identically. */
export function CreateClubModal({
  slug,
  initialName,
  districts,
  eyebrow,
  onClose,
  onCreated,
}: {
  slug: string;
  initialName: string;
  districts: string[];
  eyebrow: string;
  onClose: () => void;
  onCreated: (club: Club) => void;
}) {
  useEscapeClose(onClose);
  const titleId = useId();
  const [name, setName] = useState(initialName);
  const [district, setDistrict] = useState(districts[0] ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setErr('');
    if (!name.trim()) {
      setErr('Name is required');
      return;
    }
    if (!district) {
      setErr('District is required');
      return;
    }
    setBusy(true);
    try {
      const club = await api.platformCreateClub(slug, { name: name.trim(), district });
      onCreated(club);
    } catch (e) {
      // The backend's collision guard 409s with the exact conflict — surface it verbatim.
      setErr(e instanceof ApiError ? e.message : 'Could not create the club — try again');
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">{eyebrow}</div>
            <div className="task-modal-head-title" id={titleId}>
              Create <em>{name || 'club'}</em>
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          <p style={HINT}>
            A shell club — no chair or Cognito account yet, just a record to attach data to. The
            chair signs up normally later. Any row that matches this name re-matches to it
            automatically once it's created. This creates the club immediately — clubs can't be
            deleted from the operator console yet.
          </p>
          <div className="field-label" style={{ marginTop: 12 }}>
            Name <span className="req">*</span>
          </div>
          <input
            className="field-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
          <div className="field-label" style={{ marginTop: 12 }}>
            District <span className="req">*</span>
          </div>
          <select
            className="field-select"
            value={district}
            onChange={(e) => setDistrict(e.target.value)}
          >
            {districts.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          {err && <div style={{ ...ERR, marginTop: 12 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <Btn tone="teal" size="sm" onClick={submit} disabled={busy}>
              {busy ? 'Creating…' : 'Create club'}
            </Btn>
            <Btn tone="outline" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Btn>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── Row selection ───
 * The "select rows, act on them in bulk" state every review table needs. Takes the
 * CURRENTLY VISIBLE row ids (post-filter) so "select all" and the header checkbox's
 * indeterminate-vs-checked state are always scoped to what the operator can see —
 * a hidden row never gets silently swept into a bulk action.
 */
export function useRowSelection(visibleIds: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = useCallback((id: string, on: boolean) => {
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const toggleAll = useCallback(
    (on: boolean) => setSelected(on ? new Set(visibleIds) : new Set()),
    [visibleIds],
  );
  const clear = useCallback(() => setSelected(new Set()), []);
  return { selected, toggle, allSelected, toggleAll, clear };
}

/* ─── Review counters ─── */
export interface ReviewCounter {
  label: string;
  count: number;
  tone?: string;
}
/** The small "N ready / N need attention / N excluded" pill row every review screen
 *  opens with — one place so every wizard's summary strip agrees on shape. */
export function ReviewCounters({ counters }: { counters: ReviewCounter[] }) {
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
      {counters.map((c) => (
        <Pill key={c.label} tone={c.tone ?? 'muted'}>
          {c.count} {c.label}
        </Pill>
      ))}
    </div>
  );
}

/* ─── Bulk action bar (shell) ─── */
/** Renders nothing while nothing is selected; otherwise the "N selected" strip
 *  wrapping whatever bulk controls the caller passes as children (club/doc pickers,
 *  include/exclude — wizard-specific, so they stay with the caller). */
export function BulkActionBar({ count, children }: { count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        flexWrap: 'wrap',
        alignItems: 'center',
        padding: '8px 10px',
        background: 'var(--paper)',
        borderRadius: 8,
        marginBottom: 12,
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 700 }}>{count} selected</span>
      {children}
    </div>
  );
}

/* ─── Guidance primitives ───
 * Every wizard step opens with a StepIntro and every consequential option carries an
 * InfoTip — the whole point of the self-serve suite is that a non-engineer operator
 * never needs an engineer (or the plan document) to understand a screen.
 */

/** A short, muted, always-visible overview block at the top of a wizard step or page:
 *  what this step does, what the operator decides here, what Continue/Commit does.
 *  No dismiss — it's meant to stay put, not be read once and cleared. */
export function StepIntro({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--paper)',
        border: '1px solid var(--line2)',
        borderRadius: 8,
        padding: '12px 14px',
        marginBottom: 16,
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>
        {title}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>{children}</div>
    </div>
  );
}

// Module-level single-open latch: opening one InfoTip closes any other, same rule
// InfoDot (atoms.tsx) uses for its own popovers.
let closeActiveInfoTip: (() => void) | null = null;

/**
 * A small "ⓘ" icon-button beside a field/option/column header. Click or focus opens
 * an accessible popover — `aria-describedby` on the button ties it to the popover's
 * content, Escape closes it without closing a parent modal (capture-phase listener,
 * mirroring InfoDot), and it closes on an outside click or when focus leaves both the
 * button and the popover.
 *
 * Portaled to <body> and fixed-positioned (reusing the .info-dot/.info-pop styles
 * InfoDot already established) so it isn't clipped by a table's or modal's overflow.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; flipY: boolean } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();
  // Identity of the close-fn this instance registered as the module-level latch, so we
  // only ever clear the latch when WE still hold it (never another tip that opened after).
  const closeSelfRef = useRef<(() => void) | null>(null);

  const place = useCallback(() => {
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    const W = 260;
    const margin = 8;
    const left = Math.max(margin, Math.min(b.left, window.innerWidth - W - margin));
    const spaceBelow = window.innerHeight - b.bottom - margin;
    const flipY = spaceBelow < 120 && b.top > spaceBelow;
    setPos({ top: flipY ? b.top - 6 : b.bottom + 6, left, flipY });
  }, []);

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
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  // Release the module-level single-open latch whenever this tip closes — by outside
  // click, Escape, or blur (all of which flip `open` to false without going through
  // `toggle`) — or unmounts. Without this, the latch keeps pointing at a closed (or
  // unmounted) tip's setter, and the next tip to open calls a stale no-op instead of a
  // live one.
  useEffect(() => {
    if (open) return;
    if (closeActiveInfoTip === closeSelfRef.current) closeActiveInfoTip = null;
  }, [open]);
  useEffect(
    () => () => {
      if (closeActiveInfoTip === closeSelfRef.current) closeActiveInfoTip = null;
    },
    [],
  );

  function toggle(e: React.MouseEvent) {
    // InfoTip often sits beside a checkbox/radio label; stop the click reaching it.
    e.preventDefault();
    e.stopPropagation();
    if (open) {
      setOpen(false);
      if (closeActiveInfoTip === closeSelfRef.current) closeActiveInfoTip = null;
      return;
    }
    if (closeActiveInfoTip) closeActiveInfoTip();
    const close = () => setOpen(false);
    closeSelfRef.current = close;
    closeActiveInfoTip = close;
    setOpen(true);
  }

  function onBlur(e: React.FocusEvent) {
    const next = e.relatedTarget as Node | null;
    if (next && (btnRef.current?.contains(next) || popRef.current?.contains(next))) return;
    setOpen(false);
  }

  return (
    <span className="info-wrap" onBlur={onBlur}>
      <button
        ref={btnRef}
        type="button"
        className="info-dot"
        aria-label={label}
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
            role="tooltip"
            className="info-pop"
            style={{
              top: pos.top,
              left: pos.left,
              transform: pos.flipY ? 'translateY(-100%)' : undefined,
            }}
          >
            {children}
          </div>,
          document.body,
        )}
    </span>
  );
}
