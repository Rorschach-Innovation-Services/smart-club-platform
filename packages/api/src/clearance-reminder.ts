/**
 * Shared bookkeeping for pending-clearance reminders, used by both the admin "Send reminder" route
 * (index.ts) and the ClearanceReminders cron (crons/clearance-reminders.ts). Kept free of the Hono
 * app so the cron bundle never imports index.ts.
 *
 * Dedupe: one INVITE#-keyspace marker per (clearance, tenant day) under the SOURCE club, kind
 * `clearance-reminder`. The route and the cron claim the SAME key, so a manual send suppresses that
 * day's cron send (and vice versa), race-safely across admin tabs.
 */
import { randomUUID } from 'node:crypto';
import type { ClubCommEvent, PlayerClearance, SendResult } from './types.js';

/** The INVITE# idempotency key for a clearance's reminder on tenant day `date` (YYYY-MM-DD). */
export function clearanceReminderClaimKey(clearanceId: string, date: string): string {
  return `clearance-reminder:${clearanceId}:${date}`;
}

/** Comm-log idempotency-key prefix of every reminder row for a clearance. */
export function clearanceReminderKeyPrefix(clearanceId: string): string {
  return `clearance-${clearanceId}-reminder-`;
}

/** Comm-log rows (source club) for one reminder send, one per channel result. */
export function clearanceReminderCommEvents(
  clearance: Pick<PlayerClearance, 'id'>,
  results: SendResult[],
  date: string,
  at: string,
  by: string,
): ClubCommEvent[] {
  return results.map((r) => ({
    id: randomUUID(),
    channel: r.channel,
    ...(r.to ? { to: r.to } : {}),
    status: r.status,
    ...(r.messageId ? { messageId: r.messageId } : {}),
    ...(r.error ? { error: r.error } : {}),
    at,
    by,
    idempotencyKey: `${clearanceReminderKeyPrefix(clearance.id)}${date}-${r.channel}`,
    kind: 'clearance-reminder',
  }));
}

/**
 * When the clearance's source chair was last reminded (latest `clearance-reminder` comm-log row on
 * the source club), or null when never.
 */
export function lastClearanceReminderAt(
  commLog: ClubCommEvent[] | undefined,
  clearanceId: string,
): string | null {
  const prefix = clearanceReminderKeyPrefix(clearanceId);
  let latest: string | null = null;
  for (const e of commLog ?? []) {
    if (e.kind !== 'clearance-reminder' || !e.idempotencyKey?.startsWith(prefix)) continue;
    if (!latest || e.at > latest) latest = e.at;
  }
  return latest;
}
