/**
 * One tenant's sync run (ADR 0016) — the same sequence for the 15-minute cron and the admin
 * "Sync now":
 *
 *   1. flush the PENDINGSYNC# outbox to medicoach (Slice 4) — first, so a smart-club edit
 *      reaches medicoach before the pull compares schedules; a push failure never stops the
 *      pull (the rows stay queued with their attempt count);
 *   1b. flush the PENDINGPLAYERSYNC# player outbox (ADR 0019) when the tenant has the player
 *      sync on — same rules: a failure never stops the pull;
 *   2. pull and apply changes (`runMedicoachSync`) — throws on an HTTP/contract failure;
 *   3. retry captain's reports whose opening failed earlier (REPORTOPEN# markers) — always,
 *      even when the pull failed, since it needs nothing from medicoach;
 *   3b. open the reports of every fixture played today/yesterday, result or not
 *      (`openMatchDayReports`; both sides to the chair when there is no result) — after the
 *      retry, so a result pulled in this run keeps its captain recipient. Inside the 18:00
 *      window only; never fails the run; counted apart from the result tally (`matchDay`);
 *   4. send the one reminder for pending reports whose link expires within 2 days.
 *
 * Captain squad links (`preMatchSquadLinks`, default off — and only ever here, inside the
 * `medicoachSync`-gated run): right after the schedule outbox, schedule-changed squad requests
 * are voided (`voidChangedSquadRequests`) and the §8 squad outbox is flushed
 * (`flushSquadOutbox` — AFTER the schedule push, so a fixture's own create lands first); after
 * the report steps, SQUADOPEN# retries run and tomorrow's fixtures open their squad requests
 * (`openPreMatchSquadRequests`, 08:00 SAST squad window, deadline-bounded). None fails the run.
 *
 * Captain's report notices (steps 2–4) go out only from 18:00 SAST (REPORT_NOTICE_HOUR):
 * before that the REPORTOPEN# markers stay queued and reminders stay due. `deadlineMs` (set
 * by the cron and "Sync now" handlers) bounds the drain; leftovers wait for the next run.
 *
 * Last, after a pull that did not throw, `sweepScorecards` fetches the medicoach scorecards
 * recent results still lack (best-effort: a failure is a log line + Sentry, never the run's),
 * then — cron runs only — `reconcileIfDue` re-derives the awaiting-carry rows (MCAWAIT#) from
 * medicoach's check-refs at most once a day (ADR 0020; best-effort, never the run's failure).
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
  REPORT_NOTICE_HOUR,
  openMatchDayReports,
  reportNoticeWindowOpen,
  type MatchDayOpenSummary,
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
import { flushPlayerOutbox, playerFlushCap, type PlayerFlushSummary } from './players.js';
import { playerSyncEnabled } from './player-placement.js';
import { reconcileIfDue } from './reconcile.js';
import { flushScheduleOutbox, type FlushSummary } from './schedule.js';
import { sweepScorecards, type ScorecardSweepSummary } from './scorecard-fetch.js';
import { flushSquadOutbox, type SquadFlushSummary } from './squads.js';
import {
  openPreMatchSquadRequests,
  retryPendingSquadOpens,
  squadLinksEnabled,
  voidChangedSquadRequests,
  type SquadRequestDeps,
  type SquadOpenSummary,
  type SquadRetrySummary,
} from '../squad-requests.js';

export interface TenantSyncSummary extends SyncRunSummary {
  push?: FlushSummary;
  playerPush?: PlayerFlushSummary;
  reports?: ReportRetrySummary;
  reminders?: ReminderSummary;
  /** The match-day opener's counts — never part of `reportNotices`. */
  matchDay?: MatchDayOpenSummary;
  scorecards?: ScorecardSweepSummary;
  /** This run's captain's-report notice tally (pull + retry). */
  reportNotices?: { deferred: number; opened: number; notified: number; failed: number };
  /** Plain-language note for "Sync now" when reports were queued for 18:00. */
  reportsMessage?: string;
  /** Captain squad links: voids / self-heals / expiries, the §8 flush, retries and the opener. */
  squads?: {
    voided?: number;
    reopened?: number;
    expired?: number;
    push?: SquadFlushSummary;
    retry?: SquadRetrySummary;
    open?: SquadOpenSummary;
  };
}

/** The "Sync now" note when notices are being held for the 18:00 SAST window. */
export const REPORTS_QUEUED_MESSAGE = `Captain's reports queued — sent from ${REPORT_NOTICE_HOUR}:00`;

export interface TenantSyncDeps extends PullerDeps {
  /** Overrides for the ops digest (tests); default to `opsDigestCell()` and the Meta sender. */
  opsDigestCell?: () => string | null;
  sendOpsDigest?: (input: CaptainsReportOpsDigestWhatsAppInput) => Promise<unknown>;
  /** Overrides for the squad-link steps (tests): sender, template status, link secret/base. */
  squadLinks?: Omit<SquadRequestDeps, 'repo'>;
}

interface DigestCounts {
  resultsPulled: number;
  opened: number;
  notified: number;
  failed: number;
  /** The match-day opener's own counts (opened / notices sent / failed). */
  matchDay?: { opened: number; notified: number; failed: number };
  /** Player-sync items waiting on an admin (ADR 0019) — ride along, never trigger a digest. */
  playerReviews?: number;
  playersParked?: number;
  /** Captain squad links opened / notices sent / failed this run. */
  squads?: { opened: number; notified: number; failed: number };
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
  const md = c.matchDay ?? { opened: 0, notified: 0, failed: 0 };
  const sq = c.squads ?? { opened: 0, notified: 0, failed: 0 };
  // A quiet run sends nothing.
  if (
    c.opened +
      c.notified +
      c.failed +
      md.opened +
      md.notified +
      md.failed +
      sq.opened +
      sq.notified +
      sq.failed ===
    0
  )
    return;
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
      (md.opened + md.notified + md.failed
        ? `; match day: ${md.opened} reports opened, ${md.notified} notices sent, ${md.failed} failed`
        : '') +
      (sq.opened + sq.notified + sq.failed
        ? `; squads: ${sq.opened} requests opened, ${sq.notified} notices sent, ${sq.failed} failed`
        : '') +
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
        // "Sync now" runs behind the 30 s gateway limit: a first slice; the cron drains the rest.
        maxRows: playerFlushCap(trigger),
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
  const squads: NonNullable<TenantSyncSummary['squads']> = {};
  const squadDeps: SquadRequestDeps = {
    repo,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.squadLinks ?? {}),
    ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
  };
  try {
    // Squad requests whose fixture was cancelled / moved: void (+ queue the §8 void) BEFORE
    // the squad flush so the void goes out in this same run.
    const swept = await voidChangedSquadRequests(tenant, squadDeps);
    squads.voided = swept.voided;
    squads.reopened = swept.reopened;
    squads.expired = swept.expired;
    squads.push = await flushSquadOutbox(tenant, {
      repo,
      url: deps.url,
      secret: deps.secret,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    });
  } catch (err) {
    console.error(
      `[medicoach-sync] ${tenant}: squad outbox failed — ${err instanceof Error ? err.message : 'error'}`,
    );
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
      ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
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
  let matchDay: MatchDayOpenSummary | undefined;
  try {
    // Without the run's onOpenOutcome tally: match-day counts live under `matchDay` only.
    matchDay = await openMatchDayReports(tenant, config, {
      repo,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.captainsReports ?? {}),
      ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
    });
  } catch (err) {
    // A match-day failure never fails the sync run; the next run (and the lookback) resumes.
    console.error(
      `[medicoach-sync] ${tenant}: match-day report open failed — ${err instanceof Error ? err.message : 'error'}`,
    );
  }
  try {
    squads.retry = await retryPendingSquadOpens(tenant, squadDeps);
    squads.open = await openPreMatchSquadRequests(tenant, config, squadDeps);
  } catch (err) {
    // Never fails the sync run; markers / the next evening run resume.
    console.error(
      `[medicoach-sync] ${tenant}: squad link open failed — ${err instanceof Error ? err.message : 'error'}`,
    );
  }
  await sendOpsDigest(
    tenant,
    config,
    {
      ...(squads.open
        ? {
            squads: {
              opened: squads.open.opened,
              notified: squads.open.notified,
              failed: squads.open.failed,
            },
          }
        : {}),
      resultsPulled: summary.counts.resultsStored,
      opened: opened.size,
      notified: noticeCount('sent'),
      failed: noticeCount('failed'),
      ...(matchDay
        ? {
            matchDay: {
              opened: matchDay.opened,
              notified: matchDay.notified,
              failed: matchDay.failed,
            },
          }
        : {}),
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
      ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
    });
  } catch (err) {
    // A reminder failure never fails the sync run; the next run tries again.
    console.error(
      `[medicoach-sync] ${tenant}: report reminders failed — ${err instanceof Error ? err.message : 'error'}`,
    );
  }
  let scorecards: ScorecardSweepSummary | undefined;
  try {
    scorecards = await sweepScorecards(
      {
        repo,
        url: deps.url,
        secret: deps.secret,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      },
      tenant,
    );
  } catch (err) {
    // A scorecard sweep failure never fails the sync run; the next run sweeps again.
    console.warn(
      `[medicoach-sync] ${tenant}: scorecard sweep failed — ${err instanceof Error ? err.message : 'error'}`,
    );
    await import('../instrument.js')
      .then(({ Sentry }) =>
        Sentry.captureException(err, { tags: { job: 'scorecard-sweep', tenant } }),
      )
      .catch(() => {});
  }
  try {
    // Awaiting-carry ground truth (ADR 0020): at most once a day per tenant, cron only —
    // "Sync now" runs behind the 30 s gateway limit and has its own operator button.
    if (trigger === 'cron')
      await reconcileIfDue(tenant, {
        repo,
        url: deps.url,
        secret: deps.secret,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      });
  } catch (err) {
    // A repo failure reading series/rows: never fails the sync run; the next run tries again.
    console.warn(
      `[medicoach-sync] ${tenant}: awaiting-carry reconciliation failed — ${err instanceof Error ? err.message : 'error'}`,
    );
    await import('../instrument.js')
      .then(({ Sentry }) => Sentry.captureException(err, { tags: { job: 'mc-reconcile', tenant } }))
      .catch(() => {});
  }
  const reportNotices = {
    // The retry lists EVERY queued marker — including ones the pull just deferred — so its
    // count alone is the whole queue; adding the puller's would double-count the new ones.
    deferred: reports.deferred,
    opened: opened.size,
    notified: noticeCount('sent'),
    failed: noticeCount('failed'),
  };
  if (reportNotices.deferred + reportNotices.opened + reportNotices.notified + reportNotices.failed)
    console.log(
      `[captains-report] ${tenant}: deferred=${reportNotices.deferred} opened=${reportNotices.opened} notified=${reportNotices.notified} failed=${reportNotices.failed}`,
    );
  const queued =
    reportNotices.deferred > 0 && !reportNoticeWindowOpen((deps.now ?? (() => new Date()))());
  return {
    ...summary,
    reportNotices,
    ...(queued ? { reportsMessage: REPORTS_QUEUED_MESSAGE } : {}),
    ...(push ? { push } : {}),
    ...(playerPush ? { playerPush } : {}),
    reports,
    ...(reminders ? { reminders } : {}),
    ...(matchDay ? { matchDay } : {}),
    ...(scorecards ? { scorecards } : {}),
    // Only when the feature is on or the outbox/void sweep did something: summaries of
    // tenants without squad links keep their shape.
    ...(squadLinksEnabled(config) ||
    squads.voided ||
    squads.reopened ||
    squads.expired ||
    squads.push?.pending
      ? { squads }
      : {}),
  };
}
