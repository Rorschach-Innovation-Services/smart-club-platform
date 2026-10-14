/**
 * One-off cleanup: delete the orphaned rows of the retired Monday chair scorecard digest.
 *
 * The digest briefly existed on main (b75bdcf → 90d1f19) before scorecards moved into the
 * captain's report. Any stack that ran it — local / e2e stacks and any interim deploy — may
 * still hold its partition: `TENANT#<tenant>#SCORECONF`, carrying the weekly digests (club
 * names, member ids and the chairs' free-text correction feedback, which can name players), the
 * `SC-YYYY-NNNN` counters and the NOTIFY# send ledger. No code path reads, scrubs or erases that
 * partition any more, so it is personal data nothing can reach — delete it whole.
 *
 * Per tenant (every tenant in the registry, or just `--tenant=<id>`): one paged Query of the
 * partition (keys only), then — under `--confirm` — BatchWrite deletes of every row. Nothing
 * outside the partition is touched. Idempotent: a re-run finds nothing.
 *
 * Dry-run by default. Exit status (`main`): 1 for an unknown flag, 0 otherwise.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/cleanup-scorecard-confirmations.ts             (dry-run)
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/cleanup-scorecard-confirmations.ts --confirm   (deletes)
 *   … --tenant=<id>   (one tenant only)
 */
import { pathToFileURL } from 'node:url';
import * as repo from '../src/repo.js';
import { tableName } from '../src/env.js';

/**
 * The retired partition key, spelled out literally: its key helper
 * (`scorecardConfirmPartitionPk` in keys.ts) was deleted with the digest.
 */
export const scorecardConfirmPartitionPk = (tenant: string) => `TENANT#${tenant}#SCORECONF`;

/** The storage calls the cleanup makes — the real repo unless a test substitutes one. */
export type CleanupStore = Pick<typeof repo, 'listTenants' | 'queryAll' | 'batchDelete'>;

export interface TenantRows {
  tenant: string;
  rows: number;
}

export interface CleanupScorecardConfirmationsResult {
  tenantsScanned: number;
  /** Tenants holding at least one row. */
  tenants: TenantRows[];
  rowsFound: number;
  /** Rows deleted (0 on a dry-run). */
  rowsDeleted: number;
}

export async function cleanupScorecardConfirmations(
  opts: {
    confirm?: boolean;
    tenant?: string;
    log?: (line: string) => void;
    store?: CleanupStore;
  } = {},
): Promise<CleanupScorecardConfirmationsResult> {
  const log = opts.log ?? console.log;
  const store = opts.store ?? repo;
  const confirm = opts.confirm ?? false;
  const tenantIds = opts.tenant ? [opts.tenant] : (await store.listTenants()).map((c) => c.tenant);

  const result: CleanupScorecardConfirmationsResult = {
    tenantsScanned: tenantIds.length,
    tenants: [],
    rowsFound: 0,
    rowsDeleted: 0,
  };
  for (const tenant of tenantIds) {
    const items = await store.queryAll({
      TableName: tableName(),
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': scorecardConfirmPartitionPk(tenant) },
      ProjectionExpression: 'pk, sk',
    });
    if (!items.length) continue;
    const keys = items.map((i) => ({ pk: String(i.pk), sk: String(i.sk) }));
    result.tenants.push({ tenant, rows: keys.length });
    result.rowsFound += keys.length;
    if (confirm) {
      await store.batchDelete(keys);
      result.rowsDeleted += keys.length;
      log(`  ✓ ${tenant}: ${keys.length} row(s) deleted`);
    } else {
      log(`  ${tenant}: ${keys.length} row(s) would be deleted`);
    }
  }
  log(
    confirm
      ? `cleanup complete: ${result.rowsDeleted} row(s) deleted across ${result.tenants.length} tenant(s) (${result.tenantsScanned} scanned)`
      : `dry-run complete: ${result.rowsFound} row(s) across ${result.tenants.length} tenant(s) (${result.tenantsScanned} scanned). Re-run with --confirm.`,
  );
  return result;
}

/** The CLI, minus `process.exit`: returns the exit status (1 for an unknown flag). */
export async function main(
  args: string[],
  opts: { log?: (line: string) => void; error?: (line: string) => void; store?: CleanupStore } = {},
): Promise<number> {
  let confirm = false;
  let tenant: string | undefined;
  for (const arg of args) {
    if (arg === '--confirm') confirm = true;
    else if (arg === '--dry-run') confirm = false;
    else if (arg.startsWith('--tenant=') && arg.length > '--tenant='.length)
      tenant = arg.slice('--tenant='.length);
    else {
      (opts.error ?? console.error)(
        `unknown flag "${arg}" — usage: cleanup-scorecard-confirmations [--dry-run|--confirm] [--tenant=<id>]`,
      );
      return 1;
    }
  }
  await cleanupScorecardConfirmations({ confirm, tenant, log: opts.log, store: opts.store });
  return 0;
}

// Only run as a CLI — a test can import cleanupScorecardConfirmations / main directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((status) => process.exit(status))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
