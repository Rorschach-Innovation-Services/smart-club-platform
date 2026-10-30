/**
 * OfficialNotices cron (sst.config.ts `OfficialNotices`, every 5 minutes).
 *
 * Drains the NOTIFY#officials ledger-as-queue. The two appointment routes (manual PUT
 * `/series/:id/fixtures/:fixtureId/officials` and `POST /umpires/appointments/confirm`) only
 * ENQUEUE a `queued` row per (fixture, role, official); this run sends them:
 *
 *   listTenants → listQueuedOfficialsNotify (one partition Query; tenants with none cost one read)
 *   → per row: re-read the fixture's CURRENT officials (drop the row when the official is no
 *   longer on it — a raced or stale enqueue) → leave the row queued while the fixture has no
 *   date (it sends once the date lands) → send via sendOfficialAppointedNotice → `completed` on
 *   any `sent`.
 *
 * When nothing was sent:
 *   - every channel `skipped` (no usable email/cell on the official's umpire or scorer registry entry): the row stays
 *     queued WITHOUT counting an attempt, so it sends on the first run after the contacts are
 *     backfilled (a 5-minute cadence would otherwise exhaust it within the hour);
 *   - any channel `failed` (a provider fault): `attempts` is bumped; at ATTEMPT_CAP the row is
 *     marked `exhausted` and captured to Sentry, and the cron stops retrying it.
 *
 * Officials get the REAL kick-off time and ground, even when the series withholds them from clubs:
 * ADR 0011 is a club-facing gate, and an umpire must know where and when to turn up.
 *
 * WhatsApp goes out only when the `whatsappInvites` feature is on AND an appointment template is
 * "registered" (same gate as `reminderChannels` in fixture-reminders.ts). The template is
 * `official_appointed_v2` (carries the contact line) once ITS registry entry is "registered",
 * else v1 — flipping the registry status + redeploy is the switch (no runtime Meta probe).
 * Email always goes out. NOTIFY_DRY_RUN is honoured by the senders themselves.
 *
 * Venue: explicit fixture venue, else the home side's ground (playingVenue, venue-clash.ts —
 * NOT reminder-fixtures.ts, which pulls ExcelJS). Contact line: officialsContactLineFor —
 * the tenant's line for umpires/referees, the Medicoach default for scorers.
 *
 * Deliberately does NOT import index.ts (it would drag the whole Hono app into this bundle).
 */
import '../instrument.js'; // MUST be first — inits Sentry before any client is built
import { Sentry } from '../instrument.js';
import * as repoModule from '../repo.js';
import type { OfficialsNotifyRow } from '../repo.js';
import { sendOfficialAppointedNotice } from '../notify/index.js';
import { fixtureReminderDateLabel } from '../notify/email.js';
import {
  WHATSAPP_TEMPLATES,
  type WhatsAppTemplateDefinition,
} from '../notify/whatsapp-templates.js';
import { resolveTeam } from '../teams.js';
import { hasFeature } from '../features.js';
import { orgCopy } from '../branding.js';
import { playingVenue } from '../venue-clash.js';
import { officialsContactLineFor } from '../officials-contact.js';
import type { Channel, Club, Scorer, Series, TenantConfig, Umpire } from '../types.js';

/** Failed sends before a row is marked `exhausted` (≈50 minutes of 5-minute retries). */
export const ATTEMPT_CAP = 10;

type NoticeRepo = Pick<
  typeof repoModule,
  | 'listTenants'
  | 'listQueuedOfficialsNotify'
  | 'getFixtureOfficials'
  | 'getSeries'
  | 'listClubs'
  | 'listUmpires'
  | 'listScorers'
  | 'completeOfficialsNotify'
  | 'bumpOfficialsNotifyAttempt'
  | 'deleteOfficialsNotify'
>;

/** Injection seams so tests can drive the run and observe the sends. */
export interface OfficialNoticesDeps {
  repo: NoticeRepo;
  send: typeof sendOfficialAppointedNotice;
  /** Registry statuses of `official_appointed` (v1) and `official_appointed_v2`: the WhatsApp
   * runtime gate (either registered) and the template choice (v2 when registered). */
  officialTemplate: OfficialTemplateStatus;
  attemptCap: number;
  captureException: (err: unknown, tags: Record<string, string>) => void;
  log: (message: string, data?: Record<string, unknown>) => void;
}

export interface OfficialNoticesSummary {
  /** Tenants that had at least one queued row. */
  tenants: number;
  /** Rows where at least one channel was sent (now `completed`). */
  sent: number;
  /** Rows left queued: no date yet, or no usable contact. */
  deferred: number;
  /** Rows dropped because the official is no longer on the fixture (or it is gone). */
  stale: number;
  /** Rows whose send failed (attempt counted). */
  failed: number;
  /** Rows marked `exhausted` this run. */
  exhausted: number;
  /** Unexpected per-row / per-tenant faults (each captured to Sentry). */
  errors: number;
  dryRun: boolean;
}

export interface OfficialTemplateStatus {
  v1Status: WhatsAppTemplateDefinition['status'];
  v2Status: WhatsAppTemplateDefinition['status'];
}

const defaultDeps = (): OfficialNoticesDeps => ({
  repo: repoModule,
  send: sendOfficialAppointedNotice,
  // Widened from the `as const` literals so the comparisons below are real runtime checks.
  officialTemplate: {
    v1Status: WHATSAPP_TEMPLATES.officialAppointed.status as WhatsAppTemplateDefinition['status'],
    v2Status: WHATSAPP_TEMPLATES.officialAppointedV2.status as WhatsAppTemplateDefinition['status'],
  },
  attemptCap: ATTEMPT_CAP,
  captureException: (err, tags) => Sentry.captureException(err, { tags }),
  log: (message, data) => console.log(JSON.stringify({ msg: message, ...data })),
});

/** The WhatsApp template to send: v2 once registered, else v1. */
export function officialWhatsAppTemplate(t: OfficialTemplateStatus): 'v1' | 'v2' {
  return t.v2Status === 'registered' ? 'v2' : 'v1';
}

/** Email always; WhatsApp only with the feature on and an appointment template registered. */
export function officialNoticeChannels(
  cfg: TenantConfig,
  officialTemplate: OfficialTemplateStatus,
): Channel[] {
  const channels: Channel[] = ['email'];
  const registered =
    officialTemplate.v1Status === 'registered' || officialTemplate.v2Status === 'registered';
  if (hasFeature(cfg, 'whatsappInvites', true) && registered) {
    channels.push('whatsapp');
  }
  return channels;
}

interface FixtureLite {
  id?: string;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  venueName?: string;
  venueOverride?: string;
}

/** Run one drain pass. Exported for tests (inject the seams in `overrides`). */
export async function runOfficialNotices(
  overrides: Partial<OfficialNoticesDeps> = {},
): Promise<OfficialNoticesSummary> {
  const deps: OfficialNoticesDeps = { ...defaultDeps(), ...overrides };
  const { repo } = deps;
  const summary: OfficialNoticesSummary = {
    tenants: 0,
    sent: 0,
    deferred: 0,
    stale: 0,
    failed: 0,
    exhausted: 0,
    errors: 0,
    dryRun: process.env.NOTIFY_DRY_RUN === '1',
  };

  // A failure HERE (the registry read) fails the whole run on purpose: there is nothing to isolate.
  const tenants = await repo.listTenants();
  for (const cfg of tenants) {
    const tenant = cfg.tenant;
    try {
      const queued = await repo.listQueuedOfficialsNotify(tenant);
      if (queued.length === 0) continue;
      summary.tenants++;
      const channels = officialNoticeChannels(cfg, deps.officialTemplate);
      const whatsappTemplate = officialWhatsAppTemplate(deps.officialTemplate);
      const orgName = orgCopy(cfg).name;
      // Loaded once per tenant, only when there is work.
      const [clubs, umpires, scorers] = await Promise.all([
        repo.listClubs(tenant),
        repo.listUmpires(tenant),
        repo.listScorers(tenant),
      ]);
      const clubsById = new Map<string, Club>(clubs.map((cl) => [cl.id, cl]));
      const umpiresById = new Map<string, Umpire>(umpires.map((u) => [u.id, u]));
      const scorersById = new Map<string, Scorer>(scorers.map((x) => [x.id, x]));
      const seriesCache = new Map<string, Series | null>();
      const seriesOf = async (id: string) => {
        if (!seriesCache.has(id)) seriesCache.set(id, await repo.getSeries(tenant, id));
        return seriesCache.get(id)!;
      };

      async function drainRow(row: OfficialsNotifyRow): Promise<void> {
        const current = await repo.getFixtureOfficials(tenant, row.seriesId, row.fixtureId);
        // Inline rather than import-umpire-appointments' officialPairs: that module pulls
        // ExcelJS into this bundle.
        const stillOn =
          row.role === 'referee'
            ? current?.referee?.umpireId === row.umpireId
            : row.role === 'scorer'
              ? (current?.scorers ?? []).some((x) => x.scorerId === row.umpireId)
              : (current?.umpires ?? []).some((u) => u.umpireId === row.umpireId);
        const series = stillOn ? await seriesOf(row.seriesId) : null;
        const fixture = series
          ? ((series.fixtures as FixtureLite[] | undefined) ?? []).find(
              (f) => f.id === row.fixtureId,
            )
          : undefined;
        if (!stillOn || !series || !fixture) {
          await repo.deleteOfficialsNotify(tenant, row);
          summary.stale++;
          return;
        }
        if (!fixture.date) {
          summary.deferred++;
          return;
        }
        // `umpireId` is the registry id for the role: scorer rows resolve against the scorers.
        const person: Umpire | Scorer | undefined =
          row.role === 'scorer' ? scorersById.get(row.umpireId) : umpiresById.get(row.umpireId);
        const home = resolveTeam(series, fixture.home ?? '', clubsById);
        const away = resolveTeam(series, fixture.away ?? '', clubsById);
        // Real time/venue even when withheld from clubs (ADR 0011 is club-facing only). No
        // explicit venue ⇒ the home side's ground (junk placeholders ignored), else "venue TBC".
        const venue = playingVenue(series, fixture, clubsById) || undefined;
        // Umpires stand in pairs: name the other one so they can coordinate.
        const co =
          row.role === 'umpire'
            ? (current?.umpires ?? []).find((u) => u.umpireId !== row.umpireId)
            : undefined;
        const coReg = co ? umpiresById.get(co.umpireId) : undefined;
        const coOfficialName = co
          ? coReg?.fullName || coReg?.displayName || co.name || undefined
          : undefined;
        const { results } = await deps.send({
          official: {
            name: person?.fullName || person?.displayName || '',
            ...(person?.email ? { email: person.email } : {}),
            ...(person?.phone ? { phone: person.phone } : {}),
          },
          roleLabel: row.role,
          orgName,
          seriesName: String(series.name ?? 'Series'),
          fixtureLabel: `${home.name} v ${away.name}`,
          dateLabel: fixtureReminderDateLabel(fixture.date),
          ...(fixture.time ? { time: fixture.time } : {}),
          ...(venue ? { venue } : {}),
          ...(coOfficialName ? { coOfficialName } : {}),
          contactLine: officialsContactLineFor(cfg, row.role),
          whatsappTemplate,
          channels,
        });
        if (results.some((r) => r.status === 'sent')) {
          await repo.completeOfficialsNotify(tenant, row, results);
          summary.sent++;
          return;
        }
        if (!results.some((r) => r.status === 'failed')) {
          // No usable contact: wait for the registry to be backfilled, no attempt counted.
          summary.deferred++;
          return;
        }
        const lastError = results
          .filter((r) => r.status === 'failed')
          .map((r) => `${r.channel}: ${r.error ?? 'failed'}`)
          .join('; ');
        const attempts = await repo.bumpOfficialsNotifyAttempt(
          tenant,
          row,
          deps.attemptCap,
          lastError,
        );
        summary.failed++;
        if (attempts !== null && attempts >= deps.attemptCap) {
          summary.exhausted++;
          deps.captureException(
            new Error(
              `official appointment notice exhausted after ${attempts} attempts: ${lastError}`,
            ),
            {
              tenant,
              seriesId: row.seriesId,
              fixtureId: row.fixtureId,
              cron: 'official-notices',
            },
          );
        }
      }

      for (const row of queued) {
        try {
          await drainRow(row);
        } catch (err) {
          summary.errors++;
          deps.captureException(err, {
            tenant,
            seriesId: row.seriesId,
            fixtureId: row.fixtureId,
            cron: 'official-notices',
          });
          console.error(
            `official-notices: row ${tenant}/${row.seriesId}/${row.fixtureId}/${row.role}/${row.umpireId} failed`,
            err,
          );
        }
      }
    } catch (err) {
      summary.errors++;
      deps.captureException(err, { tenant, cron: 'official-notices' });
      console.error(`official-notices: tenant ${tenant} failed`, err);
    }
  }

  deps.log('official-notices: run complete', { ...summary });
  return summary;
}

// wrapHandler flushes queued Sentry events before the Lambda returns and captures anything that
// escapes the run (e.g. the tenant-registry read).
export const handler = Sentry.wrapHandler(async () => runOfficialNotices());
