/**
 * Validation for the operator-only `TenantConfig.fixtureReminders` key. Pure (no repo, no Hono
 * app) so the operator route and the tests share one rule set.
 */
import { HttpError } from './auth.js';
import type { FixtureReminderChannel, FixtureRemindersConfig } from './types.js';

export const FIXTURE_REMINDER_CHANNELS: readonly FixtureReminderChannel[] = ['email', 'whatsapp'];
export const LEAD_DAYS_MIN = 1;
export const LEAD_DAYS_MAX = 30;
export const LEAD_DAYS_MAX_ENTRIES = 4;

/**
 * 400 unless `v` is `{ enabled: boolean, leadDays: int[1..30] (≤4), channels: ('email'|'whatsapp')[] }`.
 * Returns the normalised value: leadDays deduped + sorted ascending, channels deduped in canonical
 * order. An enabled config must name at least one lead day and one channel — "on" with nothing to
 * send is a misconfiguration, not a valid state. Unknown keys are rejected.
 */
export function validateFixtureReminders(v: unknown): FixtureRemindersConfig {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new HttpError(400, 'fixtureReminders must be an object');
  }
  const raw = v as Record<string, unknown>;
  for (const k of Object.keys(raw)) {
    if (k !== 'enabled' && k !== 'leadDays' && k !== 'channels') {
      throw new HttpError(400, `fixtureReminders: unknown field "${k}"`);
    }
  }
  if (typeof raw.enabled !== 'boolean') {
    throw new HttpError(400, 'fixtureReminders.enabled must be a boolean');
  }
  if (!Array.isArray(raw.leadDays)) {
    throw new HttpError(400, 'fixtureReminders.leadDays must be an array');
  }
  for (const d of raw.leadDays) {
    if (!Number.isInteger(d) || (d as number) < LEAD_DAYS_MIN || (d as number) > LEAD_DAYS_MAX) {
      throw new HttpError(
        400,
        `fixtureReminders.leadDays entries must be whole numbers from ${LEAD_DAYS_MIN} to ${LEAD_DAYS_MAX}`,
      );
    }
  }
  const leadDays = [...new Set(raw.leadDays as number[])].sort((a, b) => a - b);
  if (leadDays.length > LEAD_DAYS_MAX_ENTRIES) {
    throw new HttpError(
      400,
      `fixtureReminders.leadDays may have at most ${LEAD_DAYS_MAX_ENTRIES} entries`,
    );
  }
  if (!Array.isArray(raw.channels)) {
    throw new HttpError(400, 'fixtureReminders.channels must be an array');
  }
  for (const ch of raw.channels) {
    if (!FIXTURE_REMINDER_CHANNELS.includes(ch as FixtureReminderChannel)) {
      throw new HttpError(
        400,
        `fixtureReminders.channels entries must be one of: ${FIXTURE_REMINDER_CHANNELS.join(', ')}`,
      );
    }
  }
  const channels = FIXTURE_REMINDER_CHANNELS.filter((c) => (raw.channels as unknown[]).includes(c));
  if (raw.enabled && leadDays.length === 0) {
    throw new HttpError(400, 'fixtureReminders.leadDays needs at least one entry when enabled');
  }
  if (raw.enabled && channels.length === 0) {
    throw new HttpError(400, 'fixtureReminders.channels needs at least one entry when enabled');
  }
  return { enabled: raw.enabled, leadDays, channels };
}
