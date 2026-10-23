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
 * Absent OR empty ⇒ no restriction. Windows gate ALL player registration (ADR 0017, revised
 * 2026-10-23): while closed, no new active registration and no transfer completion on any path —
 * public link, chair forms, operator intake, admin clearance completion, import CLIs. Queue
 * management (reject, reassign, reopen → pending) stays allowed. Exempt by design: the veterans
 * second-club affiliation and the remediation CLIs (resolve-duplicate-players, fix-player-name).
 */
import { HttpError } from './auth.js';
import { tenantDate } from './tenant-time.js';
import type { TenantConfig, TransferWindow, TransferWindowStatus } from './types.js';

export { TRANSFER_WINDOW_REJECTOR } from './types.js';

// KEEP IN SYNC with the operator console's client mirror in src/platform-transfer-windows.tsx
// (these limits + isCalendarDate + the validation rules in normaliseTransferWindows).
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

const describeWindow = (w: TransferWindow) => `${w.label} (${w.start} – ${w.end})`;

/** The 409 message whenever a registration (new or transfer) is refused while windows are closed. */
export function registrationClosedMessage(next: TransferWindow | undefined): string {
  return next
    ? `player registration is closed — next window: ${describeWindow(next)}`
    : 'player registration is closed — no upcoming registration window is configured';
}

/** The structured closed refusal: one 409 shape for every path, so clients can render it. */
export class RegistrationClosedError extends HttpError {
  constructor(public nextWindow: TransferWindow | undefined) {
    super(409, registrationClosedMessage(nextWindow), {
      transferWindow: { closed: true, ...(nextWindow ? { nextWindow } : {}) },
    });
    this.name = 'RegistrationClosedError';
  }
}

/** No-op when the tenant has no windows or one is open today; throws RegistrationClosedError. */
export function assertRegistrationOpen(
  cfg: Pick<TenantConfig, 'transferWindows'> | null | undefined,
  today: string = tenantToday(),
): void {
  const closed = closedTransferWindow(cfg, today);
  if (closed) throw new RegistrationClosedError(closed.next);
}

/**
 * The import/ops CLIs' refusal text when registration is closed for `cfg` today, else null. There
 * is no override flag: the fix is to adjust the windows, so the operator does it deliberately.
 */
export function cliRegistrationClosedRefusal(
  cfg: Pick<TenantConfig, 'transferWindows'> | null | undefined,
  today: string = tenantToday(),
): string | null {
  const closed = closedTransferWindow(cfg, today);
  return closed
    ? `${registrationClosedMessage(closed.next)} — adjust the tenant's transfer windows in the platform console`
    : null;
}

/**
 * The write-CLI guard: under --confirm a closed tenant throws (before any write); a dry run still
 * runs and only warns, so the operator sees the refusal coming.
 */
export function enforceCliRegistrationWindow(
  cfg: Pick<TenantConfig, 'transferWindows'> | null | undefined,
  confirm: boolean,
  warn: (message: string) => void = console.warn,
  today: string = tenantToday(),
): void {
  const refusal = cliRegistrationClosedRefusal(cfg, today);
  if (!refusal) return;
  if (confirm) throw new Error(refusal);
  warn(`⚠ ${refusal} — --confirm will refuse.`);
}
