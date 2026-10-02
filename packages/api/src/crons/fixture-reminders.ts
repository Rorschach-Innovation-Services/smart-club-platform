/**
 * FixtureReminders cron (sst.config.ts `FixtureReminders`, daily 05:00 UTC = 07:00 SAST).
 *
 * For every tenant whose operator switched `fixtureReminders.enabled` on, and for each configured
 * lead day, reminds each club chair of the club's fixtures on `tenantToday + leadDay`:
 *
 *   listTenants → skip unless enabled → listClubs + listSeries ONCE per tenant → per lead day,
 *   per club (unless `remindersOptIn === false`) → the club's fixtures on the target date, read
 *   THROUGH projectSeriesForClub (a withheld kick-off/ground never reaches a reminder, ADR 0011)
 *   → claim the `fixture-reminder:<targetDate>` marker → send → complete marker → comm log.
 *
 * Opt-in semantics: an ABSENT `remindersOptIn` counts as opted in. The flag was only ever set by
 * the chair onboarding modal, so CLI-imported clubs (Titans/Tuskers/seeded cohorts) would otherwise
 * silently never get a reminder; the operator's `enabled` is the master switch and these are
 * operational notices to club officials. Only an explicit `false` (the club-home toggle or the
 * onboarding modal) opts a club out.
 *
 * Dedupe: one marker per (club, match date) — the key carries the target date only, never the lead
 * day, so an operator changing `leadDays` mid-window can't remind the same match date twice, and a
 * retried/duplicate invocation replays the marker instead of re-sending. Markers ride the
 * claimInviteSend keyspace (72h TTL).
 *
 * WhatsApp goes out only when the tenant's channels include it, the `whatsappInvites` feature is on,
 * AND the `fixture_reminder` registry entry is "registered" — checked explicitly here rather than
 * relying on Meta rejecting a pending template, which would fail (and Sentry-report) the same send
 * across every tenant on every run until approval.
 *
 * Failures are isolated per tenant and per club (captured to Sentry, counted, and the run moves on).
 * NOTIFY_DRY_RUN is honoured by the senders themselves (synthetic message ids, logged, nothing sent);
 * markers and comm-log rows are still written so a dry run is observable end to end.
 *
 * Deliberately does NOT import index.ts: that would drag the whole Hono app and its top-level side
 * effects into this bundle. Shared logic lives in small modules (notify/contacts, series-projection,
 * teams, origins).
 */
import '../instrument.js'; // MUST be first — inits Sentry before any client is built
import { Sentry } from '../instrument.js';
import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import dayjsUtc from 'dayjs/plugin/utc.js';
import * as repoModule from '../repo.js';
import { chairContactOf } from '../notify/contacts.js';
import { sendFixtureReminder } from '../notify/index.js';
import { fixtureReminderDateLabel, type FixtureReminderLine } from '../notify/email.js';
import {
  WHATSAPP_TEMPLATES,
  type WhatsAppTemplateDefinition,
} from '../notify/whatsapp-templates.js';
import { isWithheld, projectSeriesForClub } from '../series-projection.js';
import { resolveTeam, teamIdsForClub } from '../teams.js';
import { hasFeature } from '../features.js';
import { canonicalWebOrigin } from '../origins.js';
import { TENANT_UTC_OFFSET_MINUTES } from '../tenant-time.js';
import type { Channel, Club, ClubCommEvent, Series, TenantConfig } from '../types.js';

dayjs.extend(dayjsUtc);

/** Who the comm-log rows name as the sender. */
export const FIXTURE_REMINDER_ACTOR = 'system:fixture-reminders';

type ReminderRepo = Pick<
  typeof repoModule,
  | 'listTenants'
  | 'listClubs'
  | 'listSeries'
  | 'claimInviteSend'
  | 'completeInviteSend'
  | 'releaseInviteClaim'
  | 'appendClubCommEvents'
>;

/** Injection seams so tests can drive the run with a fixed clock and observe the sends. */
export interface FixtureRemindersDeps {
  now: () => Date;
  repo: ReminderRepo;
  send: typeof sendFixtureReminder;
  /** The `fixture_reminder` template's registry status (the WhatsApp runtime gate). */
  whatsappTemplateStatus: WhatsAppTemplateDefinition['status'];
  /** The tenant's portal origin for the reminder link; null when it has none. */
  portalLinkFor: (tenant: string) => string | null;
  captureException: (err: unknown, tags: Record<string, string>) => void;
  log: (message: string, data?: Record<string, unknown>) => void;
}

export interface FixtureRemindersSummary {
  /** Tenants with reminders enabled that the run processed (including ones that errored). */
  tenants: number;
  /** Club reminders where at least one channel was sent. */
  clubsNotified: number;
  /** Club reminders not sent: opted out, already reminded (marker replay), or no usable contact. */
  skipped: number;
  /** Per-tenant and per-club failures (each captured to Sentry). */
  errors: number;
  dryRun: boolean;
}

const defaultDeps = (): FixtureRemindersDeps => ({
  now: () => new Date(),
  repo: repoModule,
  send: sendFixtureReminder,
  // Widened from the `as const` literal so the comparison below is a real runtime check.
  whatsappTemplateStatus: WHATSAPP_TEMPLATES.fixtureReminder
    .status as WhatsAppTemplateDefinition['status'],
  portalLinkFor: canonicalWebOrigin,
  captureException: (err, tags) => Sentry.captureException(err, { tags }),
  log: (message, data) => console.log(JSON.stringify({ msg: message, ...data })),
});

/** The tenant's wall-clock date (SAST) at `now` — Lambda runs in UTC. */
export function tenantDate(now: Date): string {
  return dayjs(now).utcOffset(TENANT_UTC_OFFSET_MINUTES).format('YYYY-MM-DD');
}

/** `date` (YYYY-MM-DD) plus `days` calendar days. */
export function addDays(date: string, days: number): string {
  return dayjs.utc(date).add(days, 'day').format('YYYY-MM-DD');
}

/** The match dates a run at `now` reminds for, one per lead day (deduped, ascending). */
export function reminderTargetDates(now: Date, leadDays: number[]): string[] {
  const today = tenantDate(now);
  return [...new Set(leadDays)].sort((a, b) => a - b).map((d) => addDays(today, d));
}

/**
 * The channels a tenant's reminders actually go out on: its configured channels, with WhatsApp
 * kept only when the `whatsappInvites` feature is on (default on, like every other send) AND the
 * template is registered in Meta.
 */
export function reminderChannels(
  cfg: TenantConfig,
  whatsappTemplateStatus: WhatsAppTemplateDefinition['status'],
): Channel[] {
  const configured = cfg.fixtureReminders?.channels ?? [];
  return (['email', 'whatsapp'] as const).filter((ch) => {
    if (!configured.includes(ch)) return false;
    if (ch === 'whatsapp') {
      return hasFeature(cfg, 'whatsappInvites', true) && whatsappTemplateStatus === 'registered';
    }
    return true;
  });
}

interface FixtureLite {
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  venueName?: string;
  venueOverride?: string;
}

/**
 * The club's fixtures on `date` across its PROJECTED series (already released + activated, with
 * withheld fields stripped), as reminder lines. Time/venue appear only when the series reveals
 * them; projection already removed the keys, and the `isWithheld` checks keep a home-ground
 * fallback from re-introducing a withheld venue.
 */
export function clubFixturesOn(
  club: Club,
  projected: Series[],
  date: string,
  clubsById: Map<string, Club>,
): FixtureReminderLine[] {
  const lines: FixtureReminderLine[] = [];
  for (const s of projected) {
    const mine = new Set(teamIdsForClub(s, club.id));
    const hideTime = isWithheld(s, 'time');
    const hideVenue = isWithheld(s, 'venue');
    for (const f of (s.fixtures as FixtureLite[] | undefined) ?? []) {
      if (f.date !== date) continue;
      const isHome = f.home != null && mine.has(f.home);
      const isAway = f.away != null && mine.has(f.away);
      if (!isHome && !isAway) continue;
      const me = resolveTeam(s, (isHome ? f.home : f.away) ?? '', clubsById);
      const opp = resolveTeam(s, (isHome ? f.away : f.home) ?? '', clubsById);
      // Same precedence as the fixtures broadcast: a hand-set ground, then the allocated one,
      // then the home side's ground.
      const venue = hideVenue
        ? undefined
        : f.venueOverride?.trim() ||
          f.venueName ||
          (isHome ? me.venue || club.ground?.venue : opp.venue) ||
          undefined;
      lines.push({
        seriesName: String(s.name ?? 'Series'),
        sideName: me.name,
        opponentName: opp.name,
        isHome,
        ...(!hideTime && f.time ? { time: f.time } : {}),
        ...(venue ? { venue } : {}),
      });
    }
  }
  return lines.sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
}

/** Comm-log rows for one reminder send, one per channel result. */
function commEvents(
  results: Awaited<ReturnType<typeof sendFixtureReminder>>['results'],
  targetDate: string,
  at: string,
): ClubCommEvent[] {
  return results.map((r) => ({
    id: randomUUID(),
    channel: r.channel,
    ...(r.to ? { to: r.to } : {}),
    status: r.status,
    ...(r.messageId ? { messageId: r.messageId } : {}),
    ...(r.error ? { error: r.error } : {}),
    at,
    by: FIXTURE_REMINDER_ACTOR,
    idempotencyKey: `fixture-reminder-${targetDate}-${r.channel}`,
    kind: 'fixture-reminder',
  }));
}

/** Run one reminder pass. Exported for tests (inject `now` and the seams in `overrides`). */
export async function runFixtureReminders(
  overrides: Partial<FixtureRemindersDeps> = {},
): Promise<FixtureRemindersSummary> {
  const deps: FixtureRemindersDeps = { ...defaultDeps(), ...overrides };
  const { repo } = deps;
  const summary: FixtureRemindersSummary = {
    tenants: 0,
    clubsNotified: 0,
    skipped: 0,
    errors: 0,
    dryRun: process.env.NOTIFY_DRY_RUN === '1',
  };
  const now = deps.now();
  const today = tenantDate(now);

  // A failure HERE (the registry read) fails the whole run on purpose: there is nothing to isolate.
  const tenants = await repo.listTenants();
  for (const cfg of tenants) {
    const settings = cfg.fixtureReminders;
    if (!settings?.enabled) continue;
    summary.tenants++;
    const tenant = cfg.tenant;
    try {
      const channels = reminderChannels(cfg, deps.whatsappTemplateStatus);
      if (channels.length === 0) {
        deps.log('fixture-reminders: no usable channel', {
          tenant,
          configured: settings.channels,
          whatsappTemplateStatus: deps.whatsappTemplateStatus,
        });
        continue;
      }
      const targetDates = reminderTargetDates(now, settings.leadDays ?? []);
      if (targetDates.length === 0) continue;

      const [clubs, allSeries] = await Promise.all([
        repo.listClubs(tenant),
        repo.listSeries(tenant),
      ]);
      const projected = allSeries
        .map((s) => projectSeriesForClub(s, today))
        .filter((s): s is Series => s !== null);
      if (projected.length === 0) continue;
      const clubsById = new Map(clubs.map((cl) => [cl.id, cl]));
      const portalLink = deps.portalLinkFor(tenant) ?? undefined;

      for (const targetDate of targetDates) {
        const dateLabel = fixtureReminderDateLabel(targetDate);
        for (const club of clubs) {
          let claimed = false;
          let sent = false;
          const key = `fixture-reminder:${targetDate}`;
          try {
            const fixtures = clubFixturesOn(club, projected, targetDate, clubsById);
            if (fixtures.length === 0) continue;
            if (club.remindersOptIn === false) {
              summary.skipped++;
              continue;
            }
            const replay = await repo.claimInviteSend(
              tenant,
              club.id,
              key,
              channels,
              'fixture-reminder',
            );
            if (replay) {
              summary.skipped++;
              continue;
            }
            claimed = true;
            const { results } = await deps.send({
              chair: chairContactOf(club),
              clubName: club.name,
              dateLabel,
              fixtures,
              ...(portalLink ? { portalLink } : {}),
              channels,
            });
            sent = true;
            if (results.some((r) => r.status === 'sent')) summary.clubsNotified++;
            else summary.skipped++;
            await repo.completeInviteSend(tenant, club.id, key, results);
            await repo.appendClubCommEvents(
              tenant,
              club.id,
              commEvents(results, targetDate, deps.now().toISOString()),
            );
          } catch (err) {
            summary.errors++;
            deps.captureException(err, { tenant, clubId: club.id, cron: 'fixture-reminders' });
            console.error(
              `fixture-reminders: club ${tenant}/${club.id} failed for ${targetDate}`,
              err,
            );
            // Nothing went out yet: free the key so tomorrow's run (or a retry) can try again.
            // Once a send happened the marker stays, so a bookkeeping fault never double-sends.
            if (claimed && !sent) {
              await repo.releaseInviteClaim(tenant, club.id, key).catch((releaseErr) => {
                console.error(
                  `fixture-reminders: could not release ${key} for ${tenant}/${club.id}`,
                  releaseErr,
                );
              });
            }
          }
        }
      }
    } catch (err) {
      summary.errors++;
      deps.captureException(err, { tenant, cron: 'fixture-reminders' });
      console.error(`fixture-reminders: tenant ${tenant} failed`, err);
    }
  }

  deps.log('fixture-reminders: run complete', { ...summary, today });
  return summary;
}

// wrapHandler flushes queued Sentry events before the Lambda returns and captures anything that
// escapes the run (e.g. the tenant-registry read).
export const handler = Sentry.wrapHandler(async () => runFixtureReminders());
