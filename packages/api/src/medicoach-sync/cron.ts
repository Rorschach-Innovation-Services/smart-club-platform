/**
 * Cron entry point for the medicoach sync (ADR 0016): one `sst.aws.Cron` at
 * `rate(15 minutes)`, all day. For every tenant with `features.medicoachSync`, one after
 * another: flush the schedule outbox, pull, retry pending captain's reports (`runTenantSync`).
 * A failing tenant never stops the others.
 *
 * With the `MedicoachSyncUrl`/`MedicoachSyncSecret` secrets empty every run is a dry run
 * (it logs the request it would make). That is the planned first prod weekend.
 */
import '../instrument.js'; // MUST be first — inits Sentry before any client is built
import { Sentry } from '../instrument.js';
import * as repo from '../repo.js';
import { hasFeature } from '../features.js';
import { medicoachSyncSecret, medicoachSyncUrl } from '../env.js';
import type { SyncRunSummary } from './puller.js';
import { runTenantSync } from './run.js';

/** Run the puller for every sync-enabled tenant. Exported for tests and local runs. */
export async function runAllTenants(): Promise<SyncRunSummary[]> {
  const tenants = (await repo.listTenants()).filter((t) => hasFeature(t, 'medicoachSync'));
  const url = medicoachSyncUrl();
  const secret = medicoachSyncSecret();
  const out: SyncRunSummary[] = [];
  const failures: string[] = [];
  for (const t of tenants) {
    try {
      const summary = await runTenantSync(t.tenant, 'cron', { repo, url, secret });
      out.push(summary);
      console.log(
        `[medicoach-sync] ${t.tenant}: ${summary.status} pages=${summary.pages} fixtures=${summary.fixtures} ${JSON.stringify(summary.counts)}`,
      );
    } catch (err) {
      failures.push(t.tenant);
      console.error(
        `[medicoach-sync] ${t.tenant}: failed — ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      Sentry.captureException(err, { tags: { tenant: t.tenant, job: 'medicoach-sync' } });
    }
  }
  if (failures.length)
    throw new Error(
      `medicoach sync failed for ${failures.length} tenant(s): ${failures.join(', ')}`,
    );
  return out;
}

export const handler = Sentry.wrapHandler(async () => {
  await runAllTenants();
});
