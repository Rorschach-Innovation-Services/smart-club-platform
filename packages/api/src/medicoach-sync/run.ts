/**
 * One tenant's sync run (ADR 0016) — the same sequence for the 15-minute cron and the admin
 * "Sync now":
 *
 *   1. flush the PENDINGSYNC# outbox to medicoach (Slice 4) — first, so a smart-club edit
 *      reaches medicoach before the pull compares schedules; a push failure never stops the
 *      pull (the rows stay queued with their attempt count);
 *   2. pull and apply changes (`runMedicoachSync`) — throws on an HTTP/contract failure;
 *   3. retry captain's reports whose opening failed earlier (REPORTOPEN# markers) — always,
 *      even when the pull failed, since it needs nothing from medicoach;
 *   4. send the one reminder for pending reports whose link expires within 2 days.
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
import { hasFeature } from '../features.js';
import {
  MedicoachSyncError,
  runMedicoachSync,
  type PullerDeps,
  type SyncRunSummary,
} from './puller.js';
import { flushScheduleOutbox, type FlushSummary } from './schedule.js';

export interface TenantSyncSummary extends SyncRunSummary {
  push?: FlushSummary;
  reports?: ReportRetrySummary;
  reminders?: ReminderSummary;
}

export async function runTenantSync(
  tenant: string,
  trigger: 'cron' | 'manual',
  deps: PullerDeps,
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
  const retryReports = () =>
    retryPendingReportOpens(tenant, {
      repo,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.captainsReports ?? {}),
    });
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  // Best-effort: losing the health stamp must never mask the run's own outcome.
  const stamp = (patch: Parameters<typeof repo.putSyncHealth>[1]) =>
    repo
      .putSyncHealth(tenant, patch)
      .catch((e) => console.error(`[medicoach-sync] ${tenant}: health stamp failed`, e));
  let summary: SyncRunSummary;
  try {
    summary = await runMedicoachSync(tenant, trigger, deps);
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
  return { ...summary, ...(push ? { push } : {}), reports, ...(reminders ? { reminders } : {}) };
}
