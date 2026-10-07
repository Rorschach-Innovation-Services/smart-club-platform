/**
 * One tenant's sync run (ADR 0016) — the same sequence for the 15-minute cron and the admin
 * "Sync now":
 *
 *   1. flush the PENDINGSYNC# outbox to medicoach (Slice 4) — first, so a smart-club edit
 *      reaches medicoach before the pull compares schedules; a push failure never stops the
 *      pull (the rows stay queued with their attempt count);
 *   1b. flush the PENDINGPLAYERSYNC# player outbox (ADR 0018) when the tenant has the player
 *      sync on — same rules: a failure never stops the pull;
 *   2. pull and apply changes (`runMedicoachSync`) — throws on an HTTP/contract failure;
 *   3. retry captain's reports whose opening failed earlier (REPORTOPEN# markers) — always,
 *      even when the pull failed, since it needs nothing from medicoach;
 *   4. send the one reminder for pending reports whose link expires within 2 days.
 *
 * After step 3, a run with captain's-report activity (reports opened, notices sent or failed)
 * sends ONE ops-digest WhatsApp to the union-admin cell (`OpsDigestCell`); a quiet run sends
 * nothing. The digest is best-effort and outside the report retry: it never fails the run.
 *
 * Every real (non-dry) run also stamps SYNCHEALTH#: the last successful pull, or the last
 * failure and its technical text — a quiet run writes no SYNCLOG#, so this is how the admin
 * page knows when the sync last worked.
 */
import {
  retryPendingReportOpens,
  sendReportReminders,
  type ReminderSummary,
  type ReportRetrySummary,
} from '../captains-reports.js';
import { orgCopy } from '../branding.js';
import { opsDigestCell } from '../env.js';
import { hasFeature } from '../features.js';
import { toE164 } from '../notify/e164.js';
import type { CaptainsReportOpsDigestWhatsAppInput } from '../notify/whatsapp.js';
import type { TenantConfig } from '../types.js';
import {
  MedicoachSyncError,
  runMedicoachSync,
  type PullerDeps,
  type SyncRunSummary,
} from './puller.js';
import { flushPlayerOutbox, type PlayerFlushSummary } from './players.js';
import { playerSyncEnabled } from './player-placement.js';
import { flushScheduleOutbox, type FlushSummary } from './schedule.js';

export interface TenantSyncSummary extends SyncRunSummary {
  push?: FlushSummary;
  playerPush?: PlayerFlushSummary;
  reports?: ReportRetrySummary;
  reminders?: ReminderSummary;
}

export interface TenantSyncDeps extends PullerDeps {
  /** Overrides for the ops digest (tests); default to `opsDigestCell()` and the Meta sender. */
  opsDigestCell?: () => string | null;
  sendOpsDigest?: (input: CaptainsReportOpsDigestWhatsAppInput) => Promise<unknown>;
}

interface DigestCounts {
  resultsPulled: number;
  opened: number;
  notified: number;
  failed: number;
  /** Player-sync items waiting on an admin (ADR 0018) — ride along, never trigger a digest. */
  playerReviews?: number;
  playersParked?: number;
}

/**
 * Send the run's ops digest, if the run had report activity and a cell is configured. Never
 * throws: a template-pending skip is a log line; any other failure is a log line + Sentry.
 * Logs counts only — never the cell.
 */
async function sendOpsDigest(
  tenant: string,
  config: TenantConfig,
  c: DigestCounts,
  deps: TenantSyncDeps,
): Promise<void> {
  if (c.opened + c.notified + c.failed === 0) return; // a quiet run sends nothing
  let wa: typeof import('../notify/whatsapp.js') | undefined;
  try {
    const cell = (deps.opsDigestCell ?? opsDigestCell)();
    if (!cell) return; // feature off
    const to = toE164(cell);
    if (!to) {
      console.warn(`[ops-digest] ${tenant}: OpsDigestCell is not a valid cell number — skipped`);
      return;
    }
    wa = await import('../notify/whatsapp.js');
    const playerBits = [
      c.playerReviews ? `${c.playerReviews} players to review` : '',
      c.playersParked ? `${c.playersParked} players waiting for a team` : '',
    ].filter(Boolean);
    const summary =
      `${orgCopy(config).name}: ${c.resultsPulled} new results, ${c.opened} reports opened, ` +
      `${c.notified} notices sent, ${c.failed} failed` +
      (playerBits.length ? `; ${playerBits.join(', ')}` : '');
    await (deps.sendOpsDigest ?? wa.sendCaptainsReportOpsDigestWhatsApp)({
      to,
      recipientName: 'Union admin',
      summary,
    });
  } catch (err) {
    if (wa && err instanceof wa.WhatsAppTemplatePendingError) {
      console.warn(`[ops-digest] ${tenant}: template not approved yet — skipped`);
      return;
    }
    console.warn(
      `[ops-digest] ${tenant}: send failed — ${err instanceof Error ? err.message : 'error'}`,
    );
    await import('../instrument.js')
      .then(({ Sentry }) => Sentry.captureException(err, { tags: { job: 'ops-digest', tenant } }))
      .catch(() => {});
  }
}

/** The player sync's admin backlog for the ops digest; empty when off or unreadable. */
async function playerAttention(
  tenant: string,
  config: TenantConfig,
  repo: TenantSyncDeps['repo'],
): Promise<Pick<DigestCounts, 'playerReviews' | 'playersParked'>> {
  if (!playerSyncEnabled(config)) return {};
  try {
    const [reviews, rows] = await Promise.all([
      repo.listPlayerReviews(tenant),
      repo.listPendingPlayerSync(tenant),
    ]);
    return { playerReviews: reviews.length, playersParked: rows.filter((r) => r.parked).length };
  } catch {
    return {};
  }
}

export async function runTenantSync(
  tenant: string,
  trigger: 'cron' | 'manual',
  deps: TenantSyncDeps,
): Promise<TenantSyncSummary> {
  const { repo } = deps;
  const config = await repo.getTenantConfig(tenant);
  if (!config || !hasFeature(config, 'medicoachSync'))
    return runMedicoachSync(tenant, trigger, deps); // the puller's own 'disabled' summary

  let push: FlushSummary | undefined;
  try {
    push = await flushScheduleOutbox(tenant, trigger, {
      repo,
      url: deps.url,
      secret: deps.secret,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    });
  } catch (err) {
    // A repo failure listing/updating the outbox: report it, still pull.
    console.error(
      `[medicoach-sync] ${tenant}: outbox flush failed — ${err instanceof Error ? err.message : 'error'}`,
    );
  }
  let playerPush: PlayerFlushSummary | undefined;
  if (playerSyncEnabled(config)) {
    try {
      playerPush = await flushPlayerOutbox(tenant, trigger, {
        repo,
        url: deps.url,
        secret: deps.secret,
        config,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      });
    } catch (err) {
      // A repo failure reading the tenant or the outbox: report it (no player data), still pull.
      console.error(
        `[medicoach-sync] ${tenant}: player outbox flush failed — ${err instanceof Error ? err.message : 'error'}`,
      );
    }
  }
  // Report activity across the pull's report openings and the retries, for the ops digest.
  // Keyed by report id: a notice that fails in the pull and is retried in the same run counts
  // once, by its last outcome.
  const opened = new Set<string>();
  const notice = new Map<string, 'sent' | 'failed'>();
  const captainsReports: NonNullable<PullerDeps['captainsReports']> = {
    ...(deps.captainsReports ?? {}),
    onOpenOutcome: (o) => {
      for (const id of o.opened) opened.add(id);
      for (const id of o.notified) notice.set(id, 'sent');
      for (const id of o.failed) notice.set(id, 'failed');
      deps.captainsReports?.onOpenOutcome?.(o);
    },
  };
  const noticeCount = (v: 'sent' | 'failed') => [...notice.values()].filter((x) => x === v).length;
  const retryReports = () =>
    retryPendingReportOpens(tenant, {
      repo,
      ...(deps.now ? { now: deps.now } : {}),
      ...captainsReports,
    });
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  // Best-effort: losing the health stamp must never mask the run's own outcome.
  const stamp = (patch: Parameters<typeof repo.putSyncHealth>[1]) =>
    repo
      .putSyncHealth(tenant, patch)
      .catch((e) => console.error(`[medicoach-sync] ${tenant}: health stamp failed`, e));
  let summary: SyncRunSummary;
  try {
    summary = await runMedicoachSync(tenant, trigger, { ...deps, captainsReports });
  } catch (err) {
    const at = now();
    await stamp({
      lastAttemptAt: at,
      lastErrorAt: at,
      lastError: err instanceof MedicoachSyncError ? err.message : 'internal error',
    });
    await retryReports().catch((e) =>
      console.error(`[medicoach-sync] ${tenant}: report retry failed`, e),
    );
    throw err;
  }
  if (summary.status === 'ok') {
    const at = now();
    await stamp({ lastAttemptAt: at, lastSuccessAt: at });
  }
  const reports = await retryReports();
  await sendOpsDigest(
    tenant,
    config,
    {
      resultsPulled: summary.counts.resultsStored,
      opened: opened.size,
      notified: noticeCount('sent'),
      failed: noticeCount('failed'),
      ...(await playerAttention(tenant, config, repo)),
    },
    deps,
  );
  let reminders: ReminderSummary | undefined;
  try {
    reminders = await sendReportReminders(tenant, {
      repo,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.captainsReports ?? {}),
    });
  } catch (err) {
    // A reminder failure never fails the sync run; the next run tries again.
    console.error(
      `[medicoach-sync] ${tenant}: report reminders failed — ${err instanceof Error ? err.message : 'error'}`,
    );
  }
  return {
    ...summary,
    ...(push ? { push } : {}),
    ...(playerPush ? { playerPush } : {}),
    reports,
    ...(reminders ? { reminders } : {}),
  };
}
