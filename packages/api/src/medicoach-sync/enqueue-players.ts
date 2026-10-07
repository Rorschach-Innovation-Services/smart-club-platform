/**
 * Backfill the medicoach player sync (ADR 0018): queue every person who belongs on a medicoach
 * team, so the cron pushes them (≈500 per 15-minute run).
 *
 *   npx sst shell --stage dev -- npm --prefix packages/api run enqueue-players -- \
 *     --tenant dolphins [--confirm]
 *
 * Dry run (default): counts by intent — upsert (eligible), not eligible (inactive /
 * placeholder-only / waiting on a clearance), possible duplicates (held for review) — and,
 * when MedicoachSyncUrl/MedicoachSyncSecret are set, asks medicoach what it WOULD do
 * (`dryRun: true`, writes nothing there): predicted created / linked / updated / unchanged /
 * needs-review / unmapped-team, plus which fields an `updated` would change (field names and
 * counts only). Go-live gate: plausible `created` (mostly newly registered players) and no
 * surprise spike of `updated` diffs.
 *
 * `--confirm` (player sync must be on for the tenant) queues every eligible person. Players
 * the bundle already carried resolve by ref and come back `unchanged`/`updated`. Re-run it
 * after any import CLI that wrote players outside the API.
 *
 * Output is counts only: no names, natural keys or refs (PERSONAL DATA).
 */
import { pathToFileURL } from 'node:url';
import { PLAYER_PUSH_MAX } from '../medicoach-sync-contract.js';
import { medicoachSyncSecret, medicoachSyncUrl } from '../env.js';
import { playerSyncEnabled } from './player-placement.js';
import {
  buildPlayerEntry,
  intentOf,
  loadPlayerSyncSnapshot,
  possibleDuplicates,
  postPlayerBatch,
  type PlayerSyncSnapshot,
} from './players.js';

type RepoModule = typeof import('../repo.js');

const USAGE = 'usage: enqueue-players --tenant <t> [--confirm]';

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n${USAGE}`);
    this.name = 'UsageError';
  }
}

export function parseArgs(argv: string[]): { tenant: string; confirm: boolean } {
  let tenant: string | undefined;
  let confirm = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--tenant') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new UsageError('--tenant needs a value');
      tenant = v;
    } else if (flag === '--confirm') confirm = true;
    else throw new UsageError(`unknown argument: ${flag}`);
  }
  if (!tenant) throw new UsageError('--tenant is required');
  return { tenant, confirm };
}

export interface BackfillPlan {
  /** Natural keys to queue (upsert intent, no unresolved possible duplicate). */
  eligible: string[];
  counts: { persons: number; upsert: number; notEligible: number; possibleDuplicates: number };
}

/** Who the backfill queues, from one snapshot of the tenant. */
export function planBackfill(snap: PlayerSyncSnapshot): BackfillPlan {
  const eligible: string[] = [];
  const counts = { persons: 0, upsert: 0, notEligible: 0, possibleDuplicates: 0 };
  for (const nk of [...snap.rowsByNk.keys()].sort()) {
    counts.persons++;
    const intent = intentOf(snap, nk);
    if (intent.op !== 'upsert') {
      counts.notEligible++;
      continue;
    }
    counts.upsert++;
    // Still queued: the flush holds it as a review, which is where an admin decides.
    if (possibleDuplicates(snap, nk, intent.primary).length) counts.possibleDuplicates++;
    eligible.push(nk);
  }
  return { eligible, counts };
}

async function main(): Promise<void> {
  const { tenant, confirm } = parseArgs(process.argv.slice(2));
  const repo: RepoModule = await import('../repo.js');
  const config = await repo.getTenantConfig(tenant);
  if (!config) throw new Error(`tenant ${tenant} not found`);
  const enabled = playerSyncEnabled(config);
  const snap = await loadPlayerSyncSnapshot(repo, tenant, { config });
  const plan = planBackfill(snap);
  const line = (label: string, v: unknown) => console.log(`  ${label.padEnd(36)} ${v}`);
  console.log(`\nmedicoach player sync backfill — ${tenant}${confirm ? '' : ' (dry run)'}`);
  line('player sync enabled', enabled ? 'yes' : 'NO');
  line('persons (natural keys)', plan.counts.persons);
  line('upsert (eligible)', plan.counts.upsert);
  line('… possible duplicates (held for review)', plan.counts.possibleDuplicates);
  line('not eligible (inactive / pending / none)', plan.counts.notEligible);

  if (!confirm) {
    const url = medicoachSyncUrl();
    const secret = medicoachSyncSecret();
    if (!url || !secret) {
      console.log('\n  MedicoachSyncUrl/Secret unset: no medicoach prediction (dry run only).');
      return;
    }
    const at = new Date().toISOString();
    const dups = new Set(
      plan.eligible.filter((nk) => {
        const i = intentOf(snap, nk);
        return i.op === 'upsert' && possibleDuplicates(snap, nk, i.primary).length > 0;
      }),
    );
    const entries = plan.eligible
      .filter((nk) => !dups.has(nk))
      .map((nk) => buildPlayerEntry(tenant, { naturalKey: nk, changedAt: at }, intentOf(snap, nk)));
    const statuses: Record<string, number> = {};
    const fields: Record<string, number> = {};
    let failedBatches = 0;
    for (let i = 0; i < entries.length; i += PLAYER_PUSH_MAX) {
      try {
        // eslint-disable-next-line no-await-in-loop -- one batch at a time, like the flush
        const res = await postPlayerBatch(
          tenant,
          entries.slice(i, i + PLAYER_PUSH_MAX),
          {
            url,
            secret,
          },
          { dryRun: true },
        );
        for (const r of res.results) {
          statuses[r.status] = (statuses[r.status] ?? 0) + 1;
          for (const d of r.fieldDiffs ?? []) fields[d.field] = (fields[d.field] ?? 0) + 1;
        }
      } catch (err) {
        failedBatches++;
        console.error(`  ! batch failed — ${err instanceof Error ? err.message : 'error'}`);
      }
    }
    console.log('\nmedicoach prediction (dryRun: nothing written)');
    for (const [k, v] of Object.entries(statuses).sort()) line(k, v);
    if (Object.keys(fields).length) {
      console.log('\n`updated` would change (field: players)');
      for (const [k, v] of Object.entries(fields).sort()) line(k, v);
    }
    if (failedBatches) line('failed batches', failedBatches);
    console.log('\n  dry run: nothing queued. Pass --confirm to queue the eligible players.');
    return;
  }
  if (!enabled)
    throw new Error(
      'the player sync is off for this tenant (features.medicoachSync + ' +
        'integrations.medicoach.playerSync): nothing queued',
    );
  const queued = await repo.recordPlayerSyncChange(tenant, plan.eligible, { config });
  line('queued', queued);
  console.log(
    '  The 15-minute cron pushes them, about 500 per run ("Sync now" sends a first 100).',
  );
}

// Only run as a CLI; tests import parseArgs/planBackfill.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}
