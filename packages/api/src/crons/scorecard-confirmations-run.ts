/**
 * ScorecardConfirmations cron (sst.config.ts `ScorecardConfirmations`, Mondays 05:00 UTC =
 * 07:00 SAST) — and, through `runScorecardConfirmations`, the operator's on-demand re-run
 * (POST /platform/scorecard-confirmations/run).
 *
 * For every tenant with `scorecardConfirmations.enabled === true`, `features.medicoachSync` and
 * a medicoach `goLiveDate`, over the previous Mon–Sun week (SAST; `weekKey` = that Sunday):
 *
 *   listClubs + listSeries + listFixtureResults ONCE per tenant → per club, its fixtures in
 *   the window (home OR away, read THROUGH projectSeriesForClub so a withheld ground never
 *   reaches the digest), on/after goLiveDate, that have a stored, uncleared, NON-import
 *   result → an existing digest is TOPPED UP with the missing entries (no re-send); otherwise
 *   a new digest is created (SC-YYYY-NNNN) → unless the club opted out
 *   (`remindersOptIn === false`), claim the `NOTIFY#SCORECONF#<weekKey>#<clubId>` ledger row →
 *   email + WhatsApp → record the deliveries → comm log. The claim is COMPLETED only when at
 *   least one channel delivered; a send that reached nobody (every channel failed or was
 *   skipped — no address, template not yet approved, dry run) releases it, so a later run
 *   sends once the gap is fixed. A chair with no email AND no cell is recorded as skipped
 *   (`no-contact`) without a claim. A repeat of the latest recorded outcome is not recorded
 *   again, so re-runs that keep reaching nobody never grow `deliveries`.
 *
 * The claim gates the SEND only, never entry reconciliation: a re-run tops up entries of an
 * already-notified digest silently, and the chair's existing link shows them.
 *
 * Failures are isolated per tenant and per club (captured to Sentry, counted, the run moves
 * on). NOTIFY_DRY_RUN is honoured by the senders (a `dry-run-` id is recorded as not sent).
 *
 * This module is the reusable core (no Lambda handler, no Sentry wrapper at load) so the API can
 * import it for the operator route; `scorecard-confirmations.ts` is the cron's entry point.
 * Deliberately does NOT import index.ts (the whole Hono app). Logs carry ids and counts only.
 */
import { Sentry } from '../instrument.js';
import { randomUUID } from 'node:crypto';
import * as repoModule from '../repo.js';
import { orgCopy } from '../branding.js';
import { hasContact, type NoticeResult } from '../captains-reports.js';
import { chairContactOf } from '../notify/contacts.js';
import { captainsReportLinkBase, captainsReportLinkSecret } from '../env.js';
import { hasFeature } from '../features.js';
import {
  defaultScorecardNoticeSender,
  lastCompletedWeekKey,
  repeatsLatestScorecardDeliveries,
  scorecardDeliveryOf,
  scorecardEntryKey,
  scorecardExpiresText,
  scorecardLink,
  scorecardLinkExpiry,
  weekLabel,
  windowForWeekKey,
  type ScorecardNotice,
} from '../scorecard-confirmations.js';
import { isWithheld, projectSeriesForClub } from '../series-projection.js';
import { resolveTeam, teamIdsForClub } from '../teams.js';
import { tenantDate } from '../tenant-time.js';
import type {
  Club,
  ClubCommEvent,
  ScorecardConfirmation,
  ScorecardConfirmEntry,
  Series,
  StoredFixtureResult,
  TenantConfig,
} from '../types.js';

/** Who the comm-log rows name as the sender. */
export const SCORECARD_CONFIRM_ACTOR = 'system:scorecard-confirmations';

type ScorecardRepo = Pick<
  typeof repoModule,
  | 'listTenants'
  | 'listClubs'
  | 'listSeries'
  | 'listFixtureResults'
  | 'getScorecardConfirmation'
  | 'createScorecardConfirmation'
  | 'topUpScorecardConfirmEntries'
  | 'nextScorecardConfirmRef'
  | 'claimScorecardConfirmNotify'
  | 'completeScorecardConfirmNotify'
  | 'releaseScorecardConfirmNotify'
  | 'recordScorecardConfirmDeliveries'
  | 'appendClubCommEvents'
>;

/** Injection seams so tests (and the operator route) can drive a run. */
export interface ScorecardConfirmationsDeps {
  now: () => Date;
  repo: ScorecardRepo;
  sendNotice: (n: ScorecardNotice) => Promise<NoticeResult[]>;
  linkSecret: () => string;
  linkBase: () => string;
  captureException: (err: unknown, tags: Record<string, string>) => void;
  log: (message: string, data?: Record<string, unknown>) => void;
}

export interface ScorecardConfirmationsOptions {
  /** The week to process (a Sunday YYYY-MM-DD); default the most recent completed week. */
  week?: string;
}

export interface ScorecardConfirmationsSummary {
  weekKey: string;
  /** Gated tenants the run processed (including ones that errored). */
  tenants: number;
  /** Clubs with at least one qualifying match in the week. */
  clubsProcessed: number;
  /** Digests created this run. */
  created: number;
  /** Existing digests that gained entries this run. */
  toppedUp: number;
  /** Digests whose notice reached the chair on at least one channel. */
  sent: number;
  /** Digests not sent: opted out, no contact, already sent, expired, or nothing delivered. */
  skipped: number;
  /** Per-tenant and per-club failures (each captured to Sentry). */
  errors: number;
  dryRun: boolean;
}

const defaultDeps = (): ScorecardConfirmationsDeps => ({
  now: () => new Date(),
  repo: repoModule,
  sendNotice: defaultScorecardNoticeSender,
  linkSecret: captainsReportLinkSecret,
  linkBase: captainsReportLinkBase,
  captureException: (err, tags) => Sentry.captureException(err, { tags }),
  log: (message, data) => console.log(JSON.stringify({ msg: message, ...data })),
});

/** Whether a tenant takes part: the operator switch, the medicoach sync and a go-live date. */
export function scorecardConfirmationsEnabled(cfg: TenantConfig): boolean {
  return (
    cfg.scorecardConfirmations?.enabled === true &&
    hasFeature(cfg, 'medicoachSync') &&
    !!cfg.integrations?.medicoach?.goLiveDate
  );
}

interface FixtureLite {
  id?: string;
  date?: string;
  home?: string;
  away?: string;
  venueName?: string;
  venueOverride?: string;
}

/**
 * A club's qualifying entries for the week: its fixtures (home or away) across the PROJECTED
 * series dated inside `[from, to]` and on/after `goLive`, with a stored result in `results`
 * (already filtered to uncleared, non-import). Keyed `<seriesId>#<fixtureId>`.
 */
export function clubScorecardEntries(
  club: Club,
  projected: Series[],
  results: Map<string, StoredFixtureResult>,
  window: { from: string; to: string; goLive: string },
  clubsById: Map<string, Club>,
): Record<string, ScorecardConfirmEntry> {
  const out: Record<string, ScorecardConfirmEntry> = {};
  for (const s of projected) {
    const mine = new Set(teamIdsForClub(s, club.id));
    const hideVenue = isWithheld(s, 'venue');
    for (const f of (s.fixtures as FixtureLite[] | undefined) ?? []) {
      if (!f?.id || !f.date) continue;
      if (f.date < window.from || f.date > window.to || f.date < window.goLive) continue;
      const isHome = f.home != null && mine.has(f.home);
      const isAway = f.away != null && mine.has(f.away);
      if (!isHome && !isAway) continue;
      const k = scorecardEntryKey(s.id, f.id);
      if (!results.has(k)) continue;
      const home = resolveTeam(s, f.home ?? '', clubsById);
      const away = resolveTeam(s, f.away ?? '', clubsById);
      const venue = hideVenue
        ? undefined
        : f.venueOverride?.trim() || f.venueName || home.venue || undefined;
      out[k] = {
        seriesId: s.id,
        fixtureId: f.id,
        homeTeamName: home.name,
        awayTeamName: away.name,
        fixtureDate: f.date,
        ...(s.name ? { competition: String(s.name) } : {}),
        ...(venue ? { venue } : {}),
        side: isHome ? 'home' : 'away',
        status: 'pending',
      };
    }
  }
  return out;
}

/** Comm-log rows for one digest send, one per channel result (no addresses). */
function commEvents(results: NoticeResult[], weekKey: string, at: string): ClubCommEvent[] {
  return results.map((r) => ({
    id: randomUUID(),
    channel: r.channel,
    status: r.status,
    ...(r.messageId ? { messageId: r.messageId } : {}),
    ...(r.reason || r.error ? { error: r.reason ?? r.error } : {}),
    at,
    by: SCORECARD_CONFIRM_ACTOR,
    idempotencyKey: `scorecard-confirm-${weekKey}-${r.channel}`,
    kind: 'scorecard-confirm',
  }));
}

/** Run one pass (cron or operator). Inject `now` and the seams in `overrides` for tests. */
export async function runScorecardConfirmations(
  overrides: Partial<ScorecardConfirmationsDeps> = {},
  opts: ScorecardConfirmationsOptions = {},
): Promise<ScorecardConfirmationsSummary> {
  const deps: ScorecardConfirmationsDeps = { ...defaultDeps(), ...overrides };
  const { repo } = deps;
  const now = deps.now();
  const weekKey = opts.week ?? lastCompletedWeekKey(now);
  const [from, to] = windowForWeekKey(weekKey);
  const label = weekLabel(weekKey);
  const today = tenantDate(now);
  const summary: ScorecardConfirmationsSummary = {
    weekKey,
    tenants: 0,
    clubsProcessed: 0,
    created: 0,
    toppedUp: 0,
    sent: 0,
    skipped: 0,
    errors: 0,
    dryRun: process.env.NOTIFY_DRY_RUN === '1',
  };

  // A failure HERE (the registry read) fails the whole run on purpose: nothing to isolate.
  const tenants = await repo.listTenants();
  for (const cfg of tenants) {
    if (!scorecardConfirmationsEnabled(cfg)) continue;
    summary.tenants++;
    const tenant = cfg.tenant;
    try {
      const goLive = cfg.integrations!.medicoach!.goLiveDate!;
      const [clubs, allSeries, allResults] = await Promise.all([
        repo.listClubs(tenant),
        repo.listSeries(tenant),
        repo.listFixtureResults(tenant),
      ]);
      const results = new Map(
        allResults
          .filter((r) => !r.cleared && r.recordedAt && r.resultSource !== 'import')
          .map((r) => [scorecardEntryKey(r.seriesId, r.fixtureId), r]),
      );
      if (results.size === 0) continue;
      const projected = allSeries
        .map((s) => projectSeriesForClub(s, today))
        .filter((s): s is Series => s !== null);
      const clubsById = new Map(clubs.map((cl) => [cl.id, cl]));
      const channels: Array<'email' | 'whatsapp'> = hasFeature(cfg, 'whatsappInvites', true)
        ? ['email', 'whatsapp']
        : ['email'];
      const orgName = orgCopy(cfg).name;

      for (const club of clubs) {
        // The claim's startedAt once this run holds it: releases are conditioned on it.
        let claimedAt: string | null = null;
        let sent = false;
        try {
          const entries = clubScorecardEntries(
            club,
            projected,
            results,
            { from, to, goLive },
            clubsById,
          );
          const count = Object.keys(entries).length;
          if (count === 0) continue;
          summary.clubsProcessed++;

          let record = await repo.getScorecardConfirmation(tenant, weekKey, club.id);
          if (record) {
            const added = await repo.topUpScorecardConfirmEntries(
              tenant,
              weekKey,
              club.id,
              entries,
            );
            if (added.length) summary.toppedUp++;
          } else {
            const createdAt = deps.now();
            const fresh: ScorecardConfirmation = {
              tenant,
              clubId: club.id,
              clubName: club.name,
              weekKey,
              // Drawn BEFORE the conditional create: a run that loses the create race has
              // burned a number, so gaps in SC-YYYY-NNNN are expected and accepted.
              ref: await repo.nextScorecardConfirmRef(tenant, weekKey.slice(0, 4)),
              memberId: randomUUID(),
              linkExpiresAt: new Date(
                scorecardLinkExpiry(createdAt.getTime()) * 1000,
              ).toISOString(),
              createdAt: createdAt.toISOString(),
              entries,
            };
            if (await repo.createScorecardConfirmation(tenant, fresh)) {
              summary.created++;
              record = fresh;
            } else {
              // A concurrent run created it first: top it up like any existing digest.
              const added = await repo.topUpScorecardConfirmEntries(
                tenant,
                weekKey,
                club.id,
                entries,
              );
              if (added.length) summary.toppedUp++;
              record = await repo.getScorecardConfirmation(tenant, weekKey, club.id);
              if (!record) continue;
            }
          }

          // ── The send (gated: opt-out, contact, link still live, the ledger claim) ──
          const chair = chairContactOf(club);
          if (club.remindersOptIn === false) {
            summary.skipped++;
            continue;
          }
          if (!hasContact(chair)) {
            // Recorded so the console says why ("no contact on file"), never claimed: once a
            // chair's details are added, the next run sends. Only while nobody was notified,
            // and not again when the latest recorded outcome already says so.
            const current =
              (await repo.getScorecardConfirmation(tenant, weekKey, club.id)) ?? record;
            if (!current.notifiedAt) {
              const at = deps.now().toISOString();
              const deliveries = channels.map((channel) =>
                scorecardDeliveryOf({ channel, status: 'skipped', reason: 'no-contact' }, at),
              );
              if (!repeatsLatestScorecardDeliveries(current.deliveries, deliveries))
                await repo.recordScorecardConfirmDeliveries(tenant, weekKey, club.id, deliveries);
            }
            summary.skipped++;
            continue;
          }
          if (Date.parse(record.linkExpiresAt) <= deps.now().getTime()) {
            summary.skipped++;
            continue;
          }
          // Everything that can throw before a send is resolved before the claim.
          const { token, url } = scorecardLink(tenant, record, deps.linkSecret(), deps.linkBase());
          claimedAt = await repo.claimScorecardConfirmNotify(tenant, weekKey, club.id);
          if (!claimedAt) {
            summary.skipped++;
            continue;
          }
          const current = (await repo.getScorecardConfirmation(tenant, weekKey, club.id)) ?? record;
          const matchCount = Object.values(current.entries).filter(
            (e) => e.status !== 'void',
          ).length;
          let outcome: NoticeResult[];
          try {
            outcome = await deps.sendNotice({
              tenant,
              weekKey,
              clubId: club.id,
              to: chair,
              clubName: record.clubName,
              orgName,
              weekLabel: label,
              matchCount,
              expiresText: scorecardExpiresText(record),
              token,
              url,
              channels,
            });
          } catch (err) {
            outcome = channels.map((channel) => ({
              channel,
              status: 'failed' as const,
              reason: 'send-failed' as const,
              error: err instanceof Error ? err.message : 'send failed',
            }));
          }
          const at = deps.now().toISOString();
          const deliveries = outcome.map((r) => scorecardDeliveryOf(r, at));
          const delivered = deliveries.some((d) => d.status === 'sent');
          // Something reached the chair: from here the claim must never be released.
          sent = delivered;
          // A send that reached nobody again, exactly as last time, is not recorded twice.
          const repeat =
            !delivered && repeatsLatestScorecardDeliveries(current.deliveries, deliveries);
          if (!repeat)
            await repo.recordScorecardConfirmDeliveries(
              tenant,
              weekKey,
              club.id,
              deliveries,
              delivered ? { notifiedAt: at } : {},
            );
          if (!delivered) {
            // Reached nobody (failed or skipped on every channel): free the claim so the next
            // run (or the operator) sends once the cause is fixed.
            await repo.releaseScorecardConfirmNotify(tenant, weekKey, club.id, claimedAt);
          } else {
            await repo.completeScorecardConfirmNotify(
              tenant,
              weekKey,
              club.id,
              outcome.map(({ channel, status, reason }) => ({
                channel,
                status,
                ...(reason ? { error: reason } : {}),
              })),
            );
          }
          if (delivered) summary.sent++;
          else summary.skipped++;
          if (!repeat)
            await repo.appendClubCommEvents(tenant, club.id, commEvents(outcome, weekKey, at));
        } catch (err) {
          summary.errors++;
          deps.captureException(err, {
            tenant,
            clubId: club.id,
            cron: 'scorecard-confirmations',
          });
          console.error(
            `scorecard-confirmations: club ${tenant}/${club.id} failed for ${weekKey} — ${
              err instanceof Error ? err.name : 'error'
            }`,
          );
          // Nothing reached the chair: free the claim so a retry can send. Once a channel
          // delivered the claim stays, so a bookkeeping fault never double-sends.
          if (claimedAt && !sent) {
            await repo
              .releaseScorecardConfirmNotify(tenant, weekKey, club.id, claimedAt)
              .catch(() => {
                console.error(
                  `scorecard-confirmations: could not release the claim for ${tenant}/${club.id}`,
                );
              });
          }
        }
      }
    } catch (err) {
      summary.errors++;
      deps.captureException(err, { tenant, cron: 'scorecard-confirmations' });
      console.error(
        `scorecard-confirmations: tenant ${tenant} failed — ${err instanceof Error ? err.name : 'error'}`,
      );
    }
  }

  deps.log('scorecard-confirmations: run complete', { ...summary, today });
  return summary;
}
