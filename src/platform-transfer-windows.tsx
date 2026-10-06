/**
 * Operator console: per-tenant transfer windows (`TenantConfig.transferWindows`).
 *
 * Inclusive date ranges in which clubs may open clearances. Outside every window a rep's request
 * is refused and a public registration that names another club is recorded as an auto-rejected
 * clearance the union office can reopen. No windows ⇒ no restriction. Same shape as
 * ClearanceCertificateCard: local draft, dirty tracking, the WHOLE list saved in one write.
 * `PUT /platform/tenants/:slug` re-validates (≤12, label 1–60, real dates, start ≤ end) and
 * stores the list sorted by start.
 *
 * Kept in its own file, following the FixtureRemindersCard pattern, so platform.tsx does not grow.
 */
import { useState, type CSSProperties } from 'react';
import { Btn, Card } from './atoms';
import { ApiError } from './api';
import type { TenantConfig, TransferWindow } from './types';

type Toast = (m: string, t?: string) => void;

const ERR: CSSProperties = { color: 'var(--coral, #C0392B)', fontSize: 12, marginTop: 6 };
const HINT: CSSProperties = { fontSize: 11.5, color: 'var(--muted-2)', margin: '8px 0 0' };

export const TRANSFER_WINDOWS_MAX = 12;
export const TRANSFER_WINDOW_LABEL_MAX = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isCalendarDate = (v: string) => {
  if (!DATE_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
};

/**
 * Trim + validate + sort the draft rows — the client mirror of the server's
 * validateTransferWindows. Returns the list to save, or the first error.
 */
export function normaliseTransferWindows(
  rows: TransferWindow[],
): { windows: TransferWindow[] } | { error: string } {
  if (rows.length > TRANSFER_WINDOWS_MAX) {
    return { error: `At most ${TRANSFER_WINDOWS_MAX} windows` };
  }
  const windows: TransferWindow[] = [];
  for (const [i, r] of rows.entries()) {
    const n = i + 1;
    const label = r.label.trim();
    if (!label || label.length > TRANSFER_WINDOW_LABEL_MAX) {
      return {
        error: `Window ${n}: give it a name (up to ${TRANSFER_WINDOW_LABEL_MAX} characters)`,
      };
    }
    if (!isCalendarDate(r.start) || !isCalendarDate(r.end)) {
      return { error: `Window ${n}: pick a start and an end date` };
    }
    if (r.start > r.end) return { error: `Window ${n}: the start must be on or before the end` };
    windows.push({ label, start: r.start, end: r.end });
  }
  windows.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  return { windows };
}

export function TransferWindowCard({
  config,
  save,
  toast,
}: {
  config: TenantConfig;
  save: (p: Partial<TenantConfig>) => Promise<TenantConfig>;
  toast: Toast;
}) {
  const initial = config.transferWindows ?? [];
  const [rows, setRows] = useState<TransferWindow[]>(initial);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const dirty = JSON.stringify(rows) !== JSON.stringify(initial);

  const update = (i: number, patch: Partial<TransferWindow>) =>
    setRows((cur) => cur.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  async function saveIt() {
    setErr('');
    const parsed = normaliseTransferWindows(rows);
    if ('error' in parsed) {
      setErr(parsed.error);
      return;
    }
    setBusy(true);
    try {
      await save({ transferWindows: parsed.windows });
      setRows(parsed.windows);
      toast('Transfer windows saved');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save — try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Transfer windows"
      sub="Dates on which clubs may open clearances. Outside every window, rep requests are refused and public registrations naming another club are recorded as auto-rejected (the union office can reopen them). No windows means transfers are always open."
    >
      {rows.length === 0 && (
        <p style={{ ...HINT, marginTop: 0, marginBottom: 12 }}>
          No windows — transfers are open all year.
        </p>
      )}
      {rows.map((r, i) => (
        <div
          key={i}
          role="group"
          aria-label={`Window ${i + 1}`}
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(160px, 2fr) 1fr 1fr auto',
            gap: 8,
            alignItems: 'end',
            marginBottom: 8,
          }}
        >
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="field-input"
              value={r.label}
              maxLength={TRANSFER_WINDOW_LABEL_MAX}
              placeholder="e.g. Pre-season"
              onChange={(e) => update(i, { label: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Opens</span>
            <input
              className="field-input"
              type="date"
              value={r.start}
              onChange={(e) => update(i, { start: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Closes</span>
            <input
              className="field-input"
              type="date"
              value={r.end}
              onChange={(e) => update(i, { end: e.target.value })}
            />
          </label>
          <Btn
            tone="outline"
            size="sm"
            onClick={() => setRows((cur) => cur.filter((_, k) => k !== i))}
          >
            Remove
          </Btn>
        </div>
      ))}
      <p style={{ ...HINT, marginBottom: 12 }}>
        Both dates are included, in South African time. Up to {TRANSFER_WINDOWS_MAX} windows.
      </p>
      {err && <div style={{ ...ERR, marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <Btn
          tone="outline"
          size="sm"
          disabled={rows.length >= TRANSFER_WINDOWS_MAX}
          onClick={() => setRows((cur) => [...cur, { label: '', start: '', end: '' }])}
        >
          Add window
        </Btn>
        <Btn tone="teal" size="sm" onClick={saveIt} disabled={!dirty || busy}>
          {busy ? 'Saving…' : 'Save transfer windows'}
        </Btn>
      </div>
    </Card>
  );
}
