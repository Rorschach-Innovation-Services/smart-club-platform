/**
 * ClearanceReminders cron (sst.config.ts `ClearanceReminders`, daily 05:00 UTC = 07:00 SAST).
 *
 * Nudges the SOURCE chair of every clearance that has sat pending too long, then sends the tenant's
 * admins one digest of what was nudged plus the stale clearances nobody can be nudged about:
 *
 *   listTenants → skip unless the `clearances` module is on → listAllClearances (pending only) →
 *   eligible when pending ≥ CLEARANCE_REMINDER_AFTER_DAYS (counted from `reopenedAt`, else
 *   `requestedAt` — a reopen restarts the clock) AND the latest SENT chair `clearance-reminder`
 *   comm-log row for it on the source club is none or ≥ CLEARANCE_REMINDER_EVERY_DAYS old →
 *   claim the `clearance-reminder:<id>:<today>` marker → send → complete marker → comm log.
 *   A send where every channel skipped or failed delivered nothing: its marker is released (so
 *   a same-day manual retry works) and its rows never start the cadence.
 *
 * Missed-run robust: eligibility reads the last reminder, not a modulo of the age, so a failed run
 * only delays a reminder by a day. The INVITE# day-claim (shared with the admin "Send reminder"
 * route) guards replay and concurrency: a manual reminder suppresses that day's cron send.
 *
 * Directory-source (chairless) clearances — the source club is not on the system — are never
 * claimed or sent; they go in the admin digest instead, since only the union office can resolve
 * them. They follow the same rule (pending ≥ 7 days AND last mention ≥ 7 days old); the mention is
 * a PII-free `clearance-reminder` comm-log row on the DESTINATION club, written only once the
 * digest has actually gone out. No eligible clearance in a tenant ⇒ no digest.
 *
 * A source club that IS on the system but has no usable chair contact for the run's channels is
 * handled the same way (digest-only, never claimed), its mention logged on the SOURCE club. Its
 * digest cadence reads only digest mentions, and the chair cadence only chair sends, so fixing
 * the chair's details gets the chair reminded on the next run.
 *
 * WhatsApp goes to the source chair only when the `whatsappInvites` feature is on AND the
 * `club_clearance_pending` registry entry is "registered". Admins get email only.
 *
 * Failures are isolated per tenant and per clearance (captured to Sentry, counted, the run moves
 * on). NOTIFY_DRY_RUN is honoured by the senders themselves; markers and comm-log rows are still
 * written so a dry run is observable end to end.
 *
 * Deliberately does NOT import index.ts (see crons/fixture-reminders.ts for why).
 */
import '../instrument.js'; // MUST be first — inits Sentry before any client is built
import { Sentry } from '../instrument.js';
import * as repoModule from '../repo.js';
import { chairContactOf } from '../notify/contacts.js';
import {
  hasUsableChairContact,
  sendClearanceNotice,
  sendClearanceReminderDigest,
} from '../notify/index.js';
import type { ClearanceReminderDigestLine } from '../notify/email.js';
import { listTenantAdminEmails } from '../notify/admin-emails.js';
import {
  WHATSAPP_TEMPLATES,
  type WhatsAppTemplateDefinition,
} from '../notify/whatsapp-templates.js';
import {
  clearanceReminderClaimKey,
  clearanceDigestMentionEvent,
  clearanceReminderCommEvents,
  lastClearanceReminderAt,
} from '../clearance-reminder.js';
import { hasFeature, hasModule } from '../features.js';
import { orgCopy } from '../branding.js';
import { tenantDate } from '../tenant-time.js';
import type { Channel, Club, PlayerClearance, TenantConfig } from '../types.js';

/** Who the comm-log rows name as the sender. */
export const CLEARANCE_REMINDER_ACTOR = 'system:clearance-reminders';
/** First reminder once a clearance has been pending this many tenant days. */
export const CLEARANCE_REMINDER_AFTER_DAYS = 7;
/** Then again whenever the last reminder is at least this many tenant days old. */
export const CLEARANCE_REMINDER_EVERY_DAYS = 7;

type ReminderRepo = Pick<
  typeof repoModule,
  | 'listTenants'
  | 'listAllClearances'
  | 'getClub'
  | 'claimInviteSend'
  | 'completeInviteSend'
  | 'releaseInviteClaim'
  | 'appendClubCommEvents'
  | 'listTenantUsers'
  | 'getUser'
>;

/** Injection seams so tests can drive the run with a fixed clock and observe the sends. */
export interface ClearanceRemindersDeps {
  now: () => Date;
  repo: ReminderRepo;
  send: typeof sendClearanceNotice;
  sendDigest: typeof sendClearanceReminderDigest;
  /** The `club_clearance_pending` template's registry status (the WhatsApp runtime gate). */
  whatsappTemplateStatus: WhatsAppTemplateDefinition['status'];
  captureException: (err: unknown, tags: Record<string, string>) => void;
  log: (message: string, data?: Record<string, unknown>) => void;
}

export interface ClearanceRemindersSummary {
  /** Tenants with the clearances module on that the run processed (including ones that errored). */
  tenants: number;
  /** Clearances whose source chair was sent a reminder on at least one channel. */
  reminded: number;
  /** Eligible clearances not delivered: already reminded today (marker replay), or every
   *  channel skipped/failed. */
  skipped: number;
  /** Eligible clearances whose source club is not on the system (digest only). */
  chairless: number;
  /** Eligible clearances whose source club has no usable chair contact (digest only). */
  noContact: number;
  /** Admin digest emails sent. */
  digests: number;
  /** Per-tenant and per-clearance failures (each captured to Sentry). */
  errors: number;
  dryRun: boolean;
}

const defaultDeps = (): ClearanceRemindersDeps => ({
  now: () => new Date(),
  repo: repoModule,
  send: sendClearanceNotice,
  sendDigest: sendClearanceReminderDigest,
  // Widened from the `as const` literal so the comparison below is a real runtime check.
  whatsappTemplateStatus: WHATSAPP_TEMPLATES.clearancePending
    .status as WhatsAppTemplateDefinition['status'],
  captureException: (err, tags) => Sentry.captureException(err, { tags }),
  log: (message, data) => console.log(JSON.stringify({ msg: message, ...data })),
});

/** Whole calendar days from tenant date `from` to tenant date `to` (both YYYY-MM-DD). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Tenant days the clearance has been pending at tenant date `today` (a reopen restarts the clock). */
export function daysPending(clearance: PlayerClearance, today: string): number {
  const since = clearance.reopenedAt ?? clearance.requestedAt;
  return daysBetween(tenantDate(new Date(since)), today);
}

/**
 * Whether a pending clearance is due a reminder at tenant date `today`: pending long enough and
 * not reminded within the cadence. `lastRemindedAt` is the latest reminder comm-log instant.
 */
export function isReminderDue(
  clearance: PlayerClearance,
  today: string,
  lastRemindedAt: string | null,
): boolean {
  if (clearance.status !== 'pending') return false;
  if (daysPending(clearance, today) < CLEARANCE_REMINDER_AFTER_DAYS) return false;
  if (!lastRemindedAt) return true;
  return daysBetween(tenantDate(new Date(lastRemindedAt)), today) >= CLEARANCE_REMINDER_EVERY_DAYS;
}

/** The source chair's channels: email, plus WhatsApp when the feature is on and the template live. */
export function reminderChannels(
  cfg: TenantConfig,
  whatsappTemplateStatus: WhatsAppTemplateDefinition['status'],
): Channel[] {
  return hasFeature(cfg, 'whatsappInvites', true) && whatsappTemplateStatus === 'registered'
    ? ['email', 'whatsapp']
    : ['email'];
}

const digestLine = (c: PlayerClearance, today: string): ClearanceReminderDigestLine => ({
  playerName: c.playerName,
  fromClubName: c.fromClubName,
  toClubName: c.toClubName,
  daysPending: daysPending(c, today),
});

/** Run one reminder pass. Exported for tests (inject `now` and the seams in `overrides`). */
export async function runClearanceReminders(
  overrides: Partial<ClearanceRemindersDeps> = {},
): Promise<ClearanceRemindersSummary> {
  const deps: ClearanceRemindersDeps = { ...defaultDeps(), ...overrides };
  const { repo } = deps;
  const summary: ClearanceRemindersSummary = {
    tenants: 0,
    reminded: 0,
    skipped: 0,
    chairless: 0,
    noContact: 0,
    digests: 0,
    errors: 0,
    dryRun: process.env.NOTIFY_DRY_RUN === '1',
  };
  const today = tenantDate(deps.now());

  // A failure HERE (the registry read) fails the whole run on purpose: there is nothing to isolate.
  const tenants = await repo.listTenants();
  for (const cfg of tenants) {
    if (!hasModule(cfg, 'clearances')) continue;
    summary.tenants++;
    const tenant = cfg.tenant;
    try {
      const pending = (await repo.listAllClearances(tenant)).filter(
        (c) => c.status === 'pending' && daysPending(c, today) >= CLEARANCE_REMINDER_AFTER_DAYS,
      );
      if (pending.length === 0) continue;
      const channels = reminderChannels(cfg, deps.whatsappTemplateStatus);
      const clubs = new Map<string, Club | null>();
      const clubOf = async (id: string): Promise<Club | null> => {
        if (!clubs.has(id)) clubs.set(id, await repo.getClub(tenant, id));
        return clubs.get(id) ?? null;
      };
      const nudged: ClearanceReminderDigestLine[] = [];
      const chairless: ClearanceReminderDigestLine[] = [];
      const noContact: ClearanceReminderDigestLine[] = [];
      /** Digest-only clearances in this digest, with the club their mention is logged on. */
      const digestMentions: Array<{ clearance: PlayerClearance; clubId: string }> = [];

      for (const clearance of pending) {
        let claimed = false;
        let sent = false;
        const key = clearanceReminderClaimKey(clearance.id, today);
        try {
          const fromClub = await clubOf(clearance.fromClubId);
          if (!fromClub) {
            // Off-system source: no chair to nudge, so no claim either. The digest carries it on
            // the same missed-run-robust cadence as a chair reminder, keyed off the last digest
            // mention recorded on the DESTINATION club (the only on-system club it has).
            const toClub = await clubOf(clearance.toClubId);
            const lastMention = lastClearanceReminderAt(toClub?.commLog, clearance.id);
            if (!isReminderDue(clearance, today, lastMention)) continue;
            summary.chairless++;
            chairless.push(digestLine(clearance, today));
            if (toClub) digestMentions.push({ clearance, clubId: toClub.id });
            continue;
          }
          const chair = chairContactOf(fromClub);
          if (!hasUsableChairContact(chair, channels)) {
            // On-system club, but nobody to send to: claiming + sending would only write
            // skipped rows and hide the clearance from both digest lists. Digest it instead,
            // on its own mention cadence (logged on the source club).
            const lastMention = lastClearanceReminderAt(fromClub.commLog, clearance.id, 'digest');
            if (!isReminderDue(clearance, today, lastMention)) continue;
            summary.noContact++;
            noContact.push(digestLine(clearance, today));
            digestMentions.push({ clearance, clubId: fromClub.id });
            continue;
          }
          if (
            !isReminderDue(
              clearance,
              today,
              lastClearanceReminderAt(fromClub.commLog, clearance.id, 'chair'),
            )
          ) {
            continue;
          }
          const replay = await repo.claimInviteSend(
            tenant,
            fromClub.id,
            key,
            channels,
            'clearance-reminder',
          );
          if (replay) {
            summary.skipped++;
            continue;
          }
          claimed = true;
          const { results } = await deps.send({
            chair,
            fromClubName: fromClub.name,
            playerName: clearance.playerName,
            toClubName: clearance.toClubName,
            channels,
          });
          sent = true;
          if (results.some((r) => r.status === 'sent')) {
            summary.reminded++;
            nudged.push(digestLine(clearance, today));
            await repo.completeInviteSend(tenant, fromClub.id, key, results);
          } else {
            // Nothing delivered: free the day's key so a manual retry (or tomorrow) can send.
            summary.skipped++;
            await repo.releaseInviteClaim(tenant, fromClub.id, key);
          }
          await repo.appendClubCommEvents(
            tenant,
            fromClub.id,
            clearanceReminderCommEvents(
              clearance,
              results,
              today,
              deps.now().toISOString(),
              CLEARANCE_REMINDER_ACTOR,
            ),
          );
        } catch (err) {
          summary.errors++;
          deps.captureException(err, {
            tenant,
            clearanceId: clearance.id,
            cron: 'clearance-reminders',
          });
          console.error(`clearance-reminders: clearance ${tenant}/${clearance.id} failed`, err);
          // Nothing went out yet: free the key so tomorrow's run (or a manual send) can try again.
          // Once a send happened the marker stays, so a bookkeeping fault never double-sends.
          if (claimed && !sent) {
            await repo.releaseInviteClaim(tenant, clearance.fromClubId, key).catch((releaseErr) => {
              console.error(
                `clearance-reminders: could not release ${key} for ${tenant}/${clearance.fromClubId}`,
                releaseErr,
              );
            });
          }
        }
      }

      if (nudged.length + chairless.length + noContact.length === 0) continue;
      const admins = await listTenantAdminEmails(repo, tenant);
      if (admins.length === 0) continue;
      const { results } = await deps.sendDigest({
        to: admins,
        orgName: orgCopy(cfg).name,
        nudged,
        chairless,
        noContact,
      });
      const sentCount = results.filter((r) => r.status === 'sent').length;
      summary.digests += sentCount;
      // Only a digest that actually went out counts as a mention; otherwise tomorrow retries.
      if (sentCount > 0) {
        const mentionAt = deps.now().toISOString();
        for (const { clearance, clubId } of digestMentions) {
          await repo
            .appendClubCommEvents(tenant, clubId, [
              clearanceDigestMentionEvent(clearance, today, mentionAt, CLEARANCE_REMINDER_ACTOR),
            ])
            .catch((err: unknown) => {
              summary.errors++;
              deps.captureException(err, {
                tenant,
                clearanceId: clearance.id,
                cron: 'clearance-reminders',
              });
              console.error(
                `clearance-reminders: could not log digest mention ${tenant}/${clearance.id}`,
                err,
              );
            });
        }
      }
    } catch (err) {
      summary.errors++;
      deps.captureException(err, { tenant, cron: 'clearance-reminders' });
      console.error(`clearance-reminders: tenant ${tenant} failed`, err);
    }
  }

  deps.log('clearance-reminders: run complete', { ...summary, today });
  return summary;
}

// wrapHandler flushes queued Sentry events before the Lambda returns and captures anything that
// escapes the run (e.g. the tenant-registry read).
export const handler = Sentry.wrapHandler(async () => runClearanceReminders());
