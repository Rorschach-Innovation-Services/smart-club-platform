/**
 * Rollout backfill for official appointment notices: claim every EXISTING appointment's
 * (fixture, role, official) pairs in the NOTIFY#officials ledger as `completed` (reason
 * `backfill`), so the OfficialNotices cron's first run sends nothing for appointments made
 * before the feature shipped (the 0-sends cutover convention).
 *
 * MUST run per stage before the cron deploys (or in the same deploy window) — otherwise every
 * current official is notified on the first appointment change they are part of… and any
 * row queued meanwhile is left alone: the claim is a conditional put, so an existing row
 * (queued, completed or exhausted) is never overwritten.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/src/backfill-official-notify.ts            (dry-run, every tenant)
 *   sst shell --stage <stage> -- npx tsx packages/api/src/backfill-official-notify.ts --confirm
 *   … --tenant <slug>   limit to one tenant
 *
 * Idempotent: a re-run claims nothing new ("0 claimed").
 */
import { pathToFileURL } from 'node:url';
import type * as repoModule from './repo.js';
import { officialPairs } from './import-umpire-appointments.js';

type BackfillRepo = Pick<
  typeof repoModule,
  'listTenants' | 'listFixtureOfficials' | 'listOfficialsNotify' | 'queueOfficialsNotify'
>;

export interface BackfillSummary {
  tenants: number;
  pairs: number;
  /** Pairs already in the ledger (any status) — left untouched. */
  existing: number;
  /** Pairs claimed `completed`/`backfill` (or that would be, on a dry run). */
  claimed: number;
}

export async function backfillOfficialNotify(
  repo: BackfillRepo,
  opts: { confirm: boolean; tenant?: string; log?: (line: string) => void },
): Promise<BackfillSummary> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const summary: BackfillSummary = { tenants: 0, pairs: 0, existing: 0, claimed: 0 };
  const tenants = (await repo.listTenants())
    .map((t) => t.tenant)
    .filter((t) => !opts.tenant || t === opts.tenant);
  for (const tenant of tenants) {
    const officials = await repo.listFixtureOfficials(tenant);
    if (!officials.length) continue;
    summary.tenants++;
    const ledger = new Set(
      (await repo.listOfficialsNotify(tenant)).map(
        (r) => `${r.seriesId}#${r.fixtureId}#${r.role}#${r.umpireId}`,
      ),
    );
    let claimed = 0;
    for (const o of officials) {
      for (const p of officialPairs(o)) {
        summary.pairs++;
        if (ledger.has(`${o.seriesId}#${o.fixtureId}#${p.role}#${p.umpireId}`)) {
          summary.existing++;
          continue;
        }
        if (opts.confirm) {
          const wrote = await repo.queueOfficialsNotify(
            tenant,
            { seriesId: o.seriesId, fixtureId: o.fixtureId, ...p },
            { status: 'completed', reason: 'backfill' },
          );
          if (!wrote) {
            summary.existing++;
            continue;
          }
        }
        claimed++;
      }
    }
    summary.claimed += claimed;
    log(
      `${opts.confirm ? '' : '[dry-run] '}${tenant}: ${officials.length} appointment(s), ${claimed} pair(s) ${opts.confirm ? 'claimed' : 'to claim'}`,
    );
  }
  log(
    `${opts.confirm ? 'backfill complete' : 'dry-run complete'}: ${summary.claimed} pair(s) ${opts.confirm ? 'claimed' : 'would be claimed'}, ${summary.existing} already in the ledger, across ${summary.tenants} tenant(s).${opts.confirm ? '' : ' Re-run with --confirm.'}`,
  );
  return summary;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const confirm = argv.includes('--confirm');
  const ti = argv.indexOf('--tenant');
  const tenant = ti >= 0 ? argv[ti + 1] : undefined;
  if (ti >= 0 && !tenant) {
    console.error('usage: backfill-official-notify [--tenant <slug>] [--confirm]');
    process.exit(1);
  }
  const repo = await import('./repo.js');
  await backfillOfficialNotify(repo, { confirm, ...(tenant ? { tenant } : {}) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
