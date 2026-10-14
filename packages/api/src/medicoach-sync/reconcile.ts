/**
 * Awaiting-carry reconciliation (Match Centre Connection Console, ADR 0020, decision A2).
 *
 * The write path (`recordScheduleDiff`, `unmapped` push answers) only sees fixtures that are
 * EDITED. A tenant whose fixtures were bulk-imported and released and then left alone (the
 * EMCU shape) produces no write events, so "nothing awaiting" can never be inferred from the
 * absence of MCAWAIT# rows. This module asks medicoach directly: it walks every RELEASED,
 * sync-mapped series, sends all their fixture refs to
 * `POST /integrations/smartclub/import/check-refs` (≤500 per request, signed like sync v1), and
 * makes MCAWAIT# match the answer — rows for walked series are replaced by the refs medicoach
 * answered `unmapped` (deleted when none), rows for deleted series are dropped, rows for series
 * it did not walk (drafts, unmapped leagues) are left as the write path recorded them. Then it
 * stamps MCRECON#.
 *
 * Graceful degradation: with the sync secrets empty (dry run), a 404 (medicoach has not
 * deployed the endpoint yet) or any other failure, MCAWAIT# is left untouched and MCRECON# is
 * stamped `mcReachable: false` with the reason. Never throws for a medicoach failure.
 *
 * The cron runs it at most once a day per tenant after a successful run (`reconcileIfDue`,
 * `RECONCILE_INTERVAL_MS`), but retries after `RECONCILE_RETRY_MS` (1h) when the last stamp
 * says `mcReachable: false` — so a medicoach outage or a not-yet-deployed endpoint clears
 * within the hour once fixed. (Dry-run stamps are `mcReachable: false` too; a dry-run attempt
 * makes no request, so retrying it hourly is free.) The operator console can run it now
 * (POST /platform/tenants/:slug/medicoach/reconcile).
 *
 * Concurrency: the replace pass, the cleanup pass and the MCRECON# stamp are separate,
 * non-atomic writes, so two overlapping runs (cron + the console's "Check now") could
 * interleave and leave rows matching neither answer under a stamp that disagrees with them.
 * Each run therefore first takes a per-tenant lease (MCRECONLOCK#,
 * `{token, acquiredAt, expiresAt}`, `RECONCILE_LEASE_MS`) by conditional put — granted only when
 * no lease exists or the existing one has expired. A run that cannot take it returns `{ busy: true }` without touching rows or
 * stamp: the cron treats that as not due, the console route answers 409. The lease is released
 * in a `finally` by a delete conditioned on the holder's own random `token` (so a holder whose
 * lease expired and was taken over never deletes the new one); a crashed run's lease simply
 * expires.
 *
 * A run longer than the lease (many check-refs chunks, each up to the HTTP timeout) renews it
 * after every chunk (`renewMcReconcileLease`, conditioned on its own `token`). When a
 * renewal is refused the lease was lost — it expired and another run took it — so the run
 * aborts before writing any row or stamp and returns `{ busy: true, leaseLost: true }`: the same
 * "someone else is doing the work" outcome as a run that never got the lease (the cron reads it
 * as not due, the console route as 409). Because runs are serialised this way, and each stamps
 * the wall-clock time it started, sequential stamps' `lastReconcileAt` never move backwards.
 */
import {
  CHECK_REFS_MAX,
  CheckRefsResponseSchema,
  IMPORT_CHECK_REFS_PATH,
  signRequest,
} from '../medicoach-sync-contract.js';
import { fixtureSyncRef } from '../fixture-identity.js';
import type { McReconcileLease, McReconcileStamp, Series } from '../types.js';
import { neverExported, seriesMappedForSync, type ScheduleFixture } from './schedule.js';

type RepoModule = typeof import('../repo.js');

/** The cron reconciles a tenant when its last reconciliation is older than this (or absent). */
export const RECONCILE_INTERVAL_MS = 24 * 3600 * 1000;
/** …or older than this when the last attempt failed (`mcReachable: false`). */
export const RECONCILE_RETRY_MS = 3600 * 1000;
const HTTP_TIMEOUT_MS = 10_000;
/** How long a run's lease holds before another run may take it (a crash self-heals after this). */
export const RECONCILE_LEASE_MS = 5 * 60 * 1000;

/**
 * Another reconciliation for the tenant holds the lease: no row or stamp was written. Without
 * `leaseLost` the run never got the lease (nothing was read either); with it, the run held the
 * lease, lost it mid-way (expired and taken over between chunks) and aborted before any write.
 */
export interface ReconcileBusy {
  busy: true;
  leaseLost?: true;
}

/** A run's outcome: the MCRECON# stamp it wrote, or `busy` when another run holds the lease. */
export type ReconcileResult = McReconcileStamp | ReconcileBusy;

export const isReconcileBusy = (r: ReconcileResult): r is ReconcileBusy =>
  'busy' in r && r.busy === true;

export interface ReconcileDeps {
  repo: Pick<
    RepoModule,
    | 'getTenantConfig'
    | 'getSeasonRun'
    | 'listSeries'
    | 'listMcAwait'
    | 'upsertMcAwait'
    | 'deleteMcAwait'
    | 'getMcReconcile'
    | 'putMcReconcile'
    | 'acquireMcReconcileLease'
    | 'renewMcReconcileLease'
    | 'releaseMcReconcileLease'
  >;
  url: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
}

/** Ask medicoach which of `refs` it has mapped; throws with a plain reason on any failure. */
async function checkRefs(
  tenant: string,
  refs: string[],
  deps: ReconcileDeps,
): Promise<{ mapped: string[]; unmapped: string[] }> {
  const doFetch = deps.fetch ?? fetch;
  const body = JSON.stringify({ tenant, refs });
  let res: Response;
  try {
    res = await doFetch(`${deps.url}${IMPORT_CHECK_REFS_PATH}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...signRequest({
          secret: deps.secret,
          method: 'POST',
          pathAndQuery: IMPORT_CHECK_REFS_PATH,
          body,
        }),
      },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`medicoach unreachable: ${err instanceof Error ? err.name : 'request failed'}`);
  }
  if (res.status === 404) throw new Error('medicoach has no check-refs endpoint yet (HTTP 404)');
  if (!res.ok) throw new Error(`medicoach answered HTTP ${res.status}`);
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error('medicoach answered with a body that is not JSON');
  }
  const ok = CheckRefsResponseSchema.safeParse(parsed);
  if (!ok.success) throw new Error('medicoach check-refs response failed the import v1 contract');
  return ok.data;
}

/**
 * Reconcile one tenant's MCAWAIT# rows against medicoach now (see the module comment) and
 * return the MCRECON# stamp written — or `{ busy: true }`, touching nothing, while another run
 * holds the tenant's lease. Throws only for a smart-club repo failure.
 */
export async function reconcileAwaitingCarry(
  tenant: string,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const { repo } = deps;
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now?.() ?? new Date();
  const lease = await repo.acquireMcReconcileLease(tenant, { now, leaseMs: RECONCILE_LEASE_MS });
  if (!lease) {
    log(`[medicoach-reconcile] ${tenant}: skipped — another reconciliation is running`);
    return { busy: true };
  }
  try {
    return await reconcileLeased(tenant, deps, lease, now.toISOString(), log);
  } finally {
    // Best effort: a failed release only delays the next run until the lease expires.
    try {
      await repo.releaseMcReconcileLease(tenant, lease);
    } catch (err) {
      log(
        `[medicoach-reconcile] ${tenant}: lease release failed (expires on its own) — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** The reconciliation proper, run only while holding the tenant's lease. */
async function reconcileLeased(
  tenant: string,
  deps: ReconcileDeps,
  lease: McReconcileLease,
  nowIso: string,
  log: (line: string) => void,
): Promise<ReconcileResult> {
  const { repo } = deps;
  const unreachable = async (reason: string) => {
    const stamp: McReconcileStamp = { lastReconcileAt: nowIso, mcReachable: false, reason };
    await repo.putMcReconcile(tenant, stamp);
    log(`[medicoach-reconcile] ${tenant}: not reconciled — ${reason}`);
    return stamp;
  };
  if (!deps.url || !deps.secret)
    return unreachable(
      `dry run (${!deps.url ? 'MedicoachSyncUrl' : 'MedicoachSyncSecret'} unset) — no request made`,
    );

  const config = await repo.getTenantConfig(tenant);
  const allSeries = await repo.listSeries(tenant);
  /** Every ref of a released, sync-mapped series, and the series it belongs to. */
  const seriesOfRef = new Map<string, Series>();
  const walked = new Map<string, Series>();
  for (const s of allSeries) {
    if (!s.released || !Array.isArray(s.fixtures)) continue;
    if (!(await seriesMappedForSync(repo, tenant, s, config))) continue;
    walked.set(String(s.id), s);
    for (const f of s.fixtures as ScheduleFixture[]) {
      // A `pos:`/`tbd:` side was never exported (ADR 0018): nothing for medicoach to have yet.
      if (!f?.id || neverExported(f)) continue;
      seriesOfRef.set(fixtureSyncRef(tenant, String(s.id), f), s);
    }
  }

  const refs = [...seriesOfRef.keys()];
  const unmapped = new Set<string>();
  /** Extend the lease after a chunk; false when it was lost (the run must not write). */
  const stillHeld = () =>
    repo.renewMcReconcileLease(tenant, lease, {
      now: deps.now?.() ?? new Date(),
      leaseMs: RECONCILE_LEASE_MS,
    });
  let failure: string | null = null;
  // At least one request even with no refs: it is also the reachability probe.
  for (let i = 0; i === 0 || i < refs.length; i += CHECK_REFS_MAX) {
    try {
      const answer = await checkRefs(tenant, refs.slice(i, i + CHECK_REFS_MAX), deps);
      for (const r of answer.unmapped) if (seriesOfRef.has(r)) unmapped.add(r);
    } catch (err) {
      failure = err instanceof Error ? err.message : 'check-refs failed';
    }
    // Renewed after every chunk, failed ones included: a run that lost its lease writes
    // nothing — neither rows nor a failure stamp.
    if (!(await stillHeld())) {
      log(`[medicoach-reconcile] ${tenant}: aborted — the lease expired and another run took it`);
      return { busy: true, leaseLost: true };
    }
    if (failure !== null) return unreachable(failure);
  }

  const bySeries = new Map<string, string[]>();
  for (const r of unmapped) {
    const id = String(seriesOfRef.get(r)!.id);
    bySeries.set(id, [...(bySeries.get(id) ?? []), r]);
  }
  for (const [seriesId, seriesRefs] of bySeries) {
    const s = walked.get(seriesId)!;
    await repo.upsertMcAwait(
      tenant,
      {
        seriesId,
        ...(s.name ? { seriesName: String(s.name) } : {}),
        ...(typeof s.leagueKey === 'string' && s.leagueKey ? { leagueKey: s.leagueKey } : {}),
        refs: seriesRefs,
      },
      { now: nowIso, replace: true },
    );
  }
  const existingIds = new Set(allSeries.map((s) => String(s.id)));
  for (const row of await repo.listMcAwait(tenant)) {
    const fullyMapped = walked.has(row.seriesId) && !bySeries.has(row.seriesId);
    if (fullyMapped || !existingIds.has(row.seriesId))
      await repo.deleteMcAwait(tenant, row.seriesId);
  }

  const stamp: McReconcileStamp = {
    lastReconcileAt: nowIso,
    checkedRefs: refs.length,
    unmappedTotal: unmapped.size,
    mcReachable: true,
  };
  await repo.putMcReconcile(tenant, stamp);
  log(
    `[medicoach-reconcile] ${tenant}: checked ${refs.length} ref(s), ${unmapped.size} awaiting carry ` +
      `in ${bySeries.size} series`,
  );
  return stamp;
}

/**
 * The cron's entry: reconcile only when the tenant's MCRECON# is absent or older than
 * `RECONCILE_INTERVAL_MS` — or older than `RECONCILE_RETRY_MS` when that stamp records a
 * failed attempt (`mcReachable: false`). Returns the new stamp, or null when not due —
 * including when another run holds (or took over) the lease (that run is doing the work).
 */
export async function reconcileIfDue(
  tenant: string,
  deps: ReconcileDeps,
): Promise<McReconcileStamp | null> {
  const last = await deps.repo.getMcReconcile(tenant);
  const now = (deps.now?.() ?? new Date()).getTime();
  const lastAt = last ? Date.parse(last.lastReconcileAt) : NaN;
  const dueAfter = last?.mcReachable === false ? RECONCILE_RETRY_MS : RECONCILE_INTERVAL_MS;
  if (Number.isFinite(lastAt) && now - lastAt < dueAfter) return null;
  const result = await reconcileAwaitingCarry(tenant, deps);
  return isReconcileBusy(result) ? null : result;
}
