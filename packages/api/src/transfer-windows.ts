/**
 * Per-tenant transfer windows (`TenantConfig.transferWindows`). Pure — no repo, no Hono app — so
 * the operator route, the registration core, the rep route, the CLI and the tests share one rule
 * set.
 *
 * Windows are inclusive tenant wall-clock DATE ranges (ADR 0008: dates are never converted), so
 * "is it open" compares YYYY-MM-DD strings against the tenant's calendar day (tenantDate), never
 * the UTC day — at 23:00 SAST on a window's last day it is still open; at 00:00 SAST the next day
 * it is closed, even though UTC is still on the earlier date.
 *
 * Absent OR empty ⇒ no restriction. Windows govern TRANSFERS only: a plain first registration is
 * never window-blocked.
 */
import { HttpError } from './auth.js';
import { tenantDate } from './tenant-time.js';
import type { TenantConfig, TransferWindow, TransferWindowStatus } from './types.js';

export { TRANSFER_WINDOW_REJECTOR } from './types.js';

export const TRANSFER_WINDOWS_MAX = 12;
export const TRANSFER_WINDOW_LABEL_MAX = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WINDOW_KEYS = new Set(['label', 'start', 'end']);

/** A strict YYYY-MM-DD that names a real calendar day (rejects 2026-02-30). */
export function isCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

/**
 * 400 unless `v` is an array of at most 12 `{label, start, end}` (label 1–60 chars once trimmed,
 * real YYYY-MM-DD dates, start ≤ end, no other keys). Returns the normalised list: labels
 * trimmed, sorted by start (then end). Overlaps are allowed — status math treats the union.
 */
export function validateTransferWindows(v: unknown): TransferWindow[] {
  if (!Array.isArray(v)) throw new HttpError(400, 'transferWindows must be an array');
  if (v.length > TRANSFER_WINDOWS_MAX) {
    throw new HttpError(400, `transferWindows may have at most ${TRANSFER_WINDOWS_MAX} entries`);
  }
  const out: TransferWindow[] = v.map((raw, i) => {
    const at = `transferWindows[${i}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HttpError(400, `${at} must be an object`);
    }
    for (const k of Object.keys(raw)) {
      if (!WINDOW_KEYS.has(k)) throw new HttpError(400, `${at}: unknown field "${k}"`);
    }
    const { label, start, end } = raw as Record<string, unknown>;
    const trimmed = typeof label === 'string' ? label.trim() : '';
    if (!trimmed || trimmed.length > TRANSFER_WINDOW_LABEL_MAX) {
      throw new HttpError(400, `${at}.label must be 1–${TRANSFER_WINDOW_LABEL_MAX} characters`);
    }
    if (!isCalendarDate(start)) throw new HttpError(400, `${at}.start must be a date (YYYY-MM-DD)`);
    if (!isCalendarDate(end)) throw new HttpError(400, `${at}.end must be a date (YYYY-MM-DD)`);
    if (start > end) throw new HttpError(400, `${at}: start must be on or before end`);
    return { label: trimmed, start, end };
  });
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

/** The tenant's calendar day (SAST) — the only "today" window math may use. */
export const tenantToday = (now?: Date): string => tenantDate(now);

/**
 * Open/closed on `today` (YYYY-MM-DD, tenant wall-clock), inclusive at both ends. No windows ⇒
 * open (unrestricted). `current` is the earliest-starting window containing today; `next` the
 * earliest window starting after today (absent when none is configured).
 */
export function transferWindowStatus(
  windows: TransferWindow[] | undefined,
  today: string,
): TransferWindowStatus {
  const list = [...(windows ?? [])].sort((a, b) => a.start.localeCompare(b.start));
  if (list.length === 0) return { open: true };
  const current = list.find((w) => w.start <= today && today <= w.end);
  const next = list.find((w) => w.start > today);
  return {
    open: !!current,
    ...(current ? { current } : {}),
    ...(next ? { next } : {}),
  };
}

/** The served status: only when windows are configured (absent ⇒ unrestricted). */
export function servedTransferWindowStatus(
  cfg: Pick<TenantConfig, 'transferWindows'> | null | undefined,
  today: string = tenantToday(),
): TransferWindowStatus | undefined {
  return cfg?.transferWindows?.length
    ? transferWindowStatus(cfg.transferWindows, today)
    : undefined;
}

/** The closed status when transfers are closed for this tenant on `today`, else null. */
export function closedTransferWindow(
  cfg: Pick<TenantConfig, 'transferWindows'> | null | undefined,
  today: string = tenantToday(),
): TransferWindowStatus | null {
  const status = servedTransferWindowStatus(cfg, today);
  return status && !status.open ? status : null;
}

/**
 * The first day of the closed stretch `today` sits in: the day after the latest window that
 * ended before today, or undefined when no window has ended yet (closed since forever). Keys
 * the auto-reject duplicate short-circuit — a resubmission in the same closed stretch reuses
 * the existing rejected record; one from an earlier stretch does not.
 */
export function closedPeriodStart(
  windows: TransferWindow[] | undefined,
  today: string,
): string | undefined {
  const ended = (windows ?? [])
    .filter((w) => w.end < today)
    .map((w) => w.end)
    .sort();
  if (ended.length === 0) return undefined;
  const d = new Date(`${ended[ended.length - 1]}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const describeWindow = (w: TransferWindow) => `${w.label} (${w.start} – ${w.end})`;

/** The auto-reject reason stored on the clearance (shown to both clubs and the union office). */
export function windowClosedRejectReason(next: TransferWindow | undefined): string {
  return next
    ? `Outside transfer window — next window: ${describeWindow(next)}`
    : 'Outside transfer window — no upcoming window configured';
}

/** The 409 message for an authenticated clearance request while transfers are closed. */
export function transfersClosedMessage(next: TransferWindow | undefined): string {
  return next
    ? `transfers are closed — next window: ${describeWindow(next)}`
    : 'transfers are closed — no upcoming transfer window is configured';
}
