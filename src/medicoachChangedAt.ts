/**
 * Mirrors `NEVER_EDITED_CHANGED_AT` in packages/api/src/medicoach-sync/schedule.ts — keep in
 * sync. Smart club sends that sentinel for a fixture never edited since import, and medicoach
 * echoes it back, so a 1970 `changedAt` is "never edited", not a real date (campaign F-004).
 */
export const NEVER_EDITED_CHANGED_AT = '1970-01-01T00:00:00.001Z';

const YEAR_2000_MS = Date.UTC(2000, 0, 1);

/** True for the sentinel or any epoch-adjacent (pre-2000) value — none is a real edit time. */
export function isNeverEditedChangedAt(iso?: string | null): boolean {
  if (!iso) return false;
  if (iso === NEVER_EDITED_CHANGED_AT) return true;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms < YEAR_2000_MS;
}

/** A schedule/sync `changedAt` for display: "never edited" for the sentinel, else SAST date-time. */
export function formatChangedAt(iso?: string | null): string {
  if (!iso) return '—';
  if (isNeverEditedChangedAt(iso)) return 'never edited';
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Johannesburg',
  });
}
