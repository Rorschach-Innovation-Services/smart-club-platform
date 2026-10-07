/**
 * The one way a bulk series CLI writes a series it rewrote in memory (ADR 0016).
 *
 * A CLI reads the tenant's series, works on its copy for a while (seconds to minutes, plus an
 * operator reading a dry run), then writes. Anything that changed the series in between — an
 * admin edit, the medicoach puller applying a reschedule — would be silently overwritten by
 * a plain put, and the schedule diff would be computed against the wrong baseline. So:
 *
 *   - the write is conditional on the version the CLI READ when it built its working copy;
 *     on drift that series is skipped with a clear "re-run" message (the others still go);
 *   - the medicoach schedule diff is original-read → written, the change this CLI made.
 */
import type { ScheduleChangeOrigin, Series } from '../types.js';
import { recordScheduleDiff } from './schedule.js';

type RepoModule = typeof import('../repo.js');

export type CliWriteOutcome = 'written' | 'drifted';

/**
 * Write `next` over `original` (the series as the CLI read it; null/undefined ⇒ a new series
 * that must not exist yet). Sets `next.version` to original + 1. Returns 'drifted' (nothing
 * written, an error printed) when the stored series moved on since the read.
 */
export async function writeSeriesFromSnapshot(
  repo: Pick<
    RepoModule,
    'getTenantConfig' | 'putPendingSync' | 'getSeasonRun' | 'putSyncLog' | 'putSeriesIfVersion'
  >,
  tenant: string,
  original: Series | null | undefined,
  next: Series,
  opts: { error?: (line: string) => void; origin?: ScheduleChangeOrigin } = {},
): Promise<CliWriteOutcome> {
  const expected = original ? original.version : null;
  next.version = original ? (Number(original.version) || 1) + 1 : (next.version ?? 1);
  // Stamp + queue every mapped fixture whose schedule THIS run changed (Slice 4).
  const scheduleSync = await recordScheduleDiff(repo, tenant, original, next, opts.origin ?? 'cli');
  try {
    await repo.putSeriesIfVersion(tenant, next, expected);
  } catch (err) {
    // By name, not instanceof: a static import of repo.js would make every CLI that imports
    // this module need TABLE_NAME at load time (the importers' tests load them offline).
    if ((err as { name?: string }).name !== 'VersionConflictError') throw err;
    (opts.error ?? ((l: string) => console.error(l)))(
      `✗ series ${next.id} changed since this run read it` +
        (original ? ` (read at v${original.version ?? '?'})` : ' (it now exists)') +
        ' — NOT written. Re-run the command to work from the current series.',
    );
    return 'drifted';
  }
  await scheduleSync.enqueue();
  return 'written';
}
