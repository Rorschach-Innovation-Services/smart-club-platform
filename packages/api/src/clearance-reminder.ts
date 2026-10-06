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
 * The comm-log row recording that a clearance nobody could be nudged about was carried in the
 * admin reminder digest on tenant day `date`: on the DESTINATION club for a chairless clearance
 * (source club off the system), on the SOURCE club when it exists but has no usable chair
 * contact. One PII-free summary row
 * (admins are not named); it shares the reminder key prefix so {@link lastClearanceReminderAt}
 * drives the digest cadence exactly as it drives chair reminders.
 */
export function clearanceDigestMentionEvent(
  clearance: Pick<PlayerClearance, 'id'>,
  date: string,
  at: string,
  by: string,
): ClubCommEvent {
  return {
    id: randomUUID(),
    channel: 'email',
    status: 'sent',
    at,
    by,
    idempotencyKey: `${clearanceReminderKeyPrefix(clearance.id)}${date}-digest`,
    kind: 'clearance-reminder',
  };
}

/** Whether a `clearance-reminder` comm-log row is an admin-digest mention (not a chair send). */
const isDigestMention = (e: ClubCommEvent): boolean => e.idempotencyKey.endsWith('-digest');

/**
 * When the clearance was last reminded: the latest `clearance-reminder` comm-log row for it in
 * `commLog` — the source club's (chair reminders, plus digest mentions for a source club with no
 * usable chair contact) or, for a chairless clearance, the destination club's (digest mentions)
 * — or null when never.
 *
 * Only rows with status `sent` count: a skipped (no contact) or failed channel delivered nothing,
 * so it must not start the cadence. Digest mentions are written as `sent`, and only once the
 * digest actually went out. `only` narrows to chair sends (`chair`) or digest mentions
 * (`digest`) — the chair cadence ignores digest mentions so a chair contact fixed the day after
 * a digest is reminded straight away.
 */
export function lastClearanceReminderAt(
  commLog: ClubCommEvent[] | undefined,
  clearanceId: string,
  only?: 'chair' | 'digest',
): string | null {
  const prefix = clearanceReminderKeyPrefix(clearanceId);
  let latest: string | null = null;
  for (const e of commLog ?? []) {
    if (e.kind !== 'clearance-reminder' || !e.idempotencyKey?.startsWith(prefix)) continue;
    if (e.status !== 'sent') continue;
    if (only && (only === 'digest') !== isDigestMention(e)) continue;
    if (!latest || e.at > latest) latest = e.at;
  }
  return latest;
}
