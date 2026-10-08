/**
 * Dispose of the medicoach refs of natural keys that resolve-duplicate-players deleted
 * (dolphins duplicate-remediation, Phase 5.4).
 *
 *   npx sst shell --stage prod -- npm --prefix packages/api run tombstone-deleted-players -- \
 *     --tenant dolphins --deleted ~/audits/dolphins-dups/deleted-nks.json            # dry run
 *   … -- --tenant dolphins --deleted ~/audits/dolphins-dups/deleted-nks.json --confirm
 *
 * WHY — the Phase-1 deletes ran while the player sync was off, so they queued nothing, and the
 * backfill (enqueue-players) only walks LIVE keys: a deleted key's medicoach ref row would stay
 * forever and block that athlete's future POPIA erasure. For each deleted key this queues the
 * same `erase` tombstone the erasure path does (recordPlayerSyncErase — the sync-on branch:
 * putPlayerSyncTombstone, plus dropping the key's sync review / distinct markers). Medicoach's
 * erase with other refs still on the athlete deletes only that ref and never anonymises.
 *
 * NEVER erasePlayerData: its name/email/cell scrub would hit the surviving duplicate.
 *
 * Refuses a key that still has a live PLAYER# row at any club (it is not deleted). Requires the
 * tenant's player sync to be ON (otherwise recordPlayerSyncErase would queue nothing). Dry-run
 * by default. Output masks keys to 8 characters.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { playerSyncEnabled } from './medicoach-sync/player-placement.js';
import type { DeletedNk } from './resolve-duplicate-players.js';

type RepoModule = typeof import('./repo.js');

const USAGE =
  'usage: tombstone-deleted-players --tenant <t> --deleted <deleted-nks.json> [--confirm]';

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n${USAGE}`);
    this.name = 'UsageError';
  }
}

export function parseArgs(argv: string[]): { tenant: string; deleted: string; confirm: boolean } {
  let tenant: string | undefined;
  let deleted: string | undefined;
  let confirm = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--tenant' || flag === '--deleted') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      if (flag === '--tenant') tenant = v;
      else deleted = v;
    } else if (flag === '--confirm') confirm = true;
    else throw new UsageError(`unknown argument: ${flag}`);
  }
  if (!tenant) throw new UsageError('--tenant is required');
  if (!deleted) throw new UsageError('--deleted is required');
  return { tenant, deleted, confirm };
}

const cut = (nk: string) => `${nk.slice(0, 8)}…`;

export interface TombstoneReport {
  queued: string[];
  wouldQueue: string[];
  alreadyQueued: string[];
  refusedLive: string[];
  otherTenant: number;
}

type TombstoneRepo = Pick<
  RepoModule,
  'getTenantConfig' | 'listClubs' | 'listPlayers' | 'getPendingPlayerSync' | 'recordPlayerSyncErase'
>;

export class SyncOffError extends Error {
  constructor(tenant: string) {
    super(
      `the player sync is OFF for ${tenant} — a tombstone would queue nothing. Enable it first.`,
    );
    this.name = 'SyncOffError';
  }
}

export async function tombstoneDeleted(
  repo: TombstoneRepo,
  tenant: string,
  entries: DeletedNk[],
  opts: { confirm: boolean; log?: (line: string) => void; at?: string },
): Promise<TombstoneReport> {
  const log = opts.log ?? console.log;
  if (!playerSyncEnabled(await repo.getTenantConfig(tenant))) throw new SyncOffError(tenant);
  const report: TombstoneReport = {
    queued: [],
    wouldQueue: [],
    alreadyQueued: [],
    refusedLive: [],
    otherTenant: 0,
  };
  // Every live natural key, one roster query per club (no per-key point-gets).
  const live = new Set<string>();
  for (const club of await repo.listClubs(tenant))
    for (const p of await repo.listPlayers(tenant, club.id)) live.add(p.naturalKey);

  const keys = new Set<string>();
  for (const e of entries) {
    if (e.tenant !== tenant) {
      report.otherTenant++;
      continue;
    }
    keys.add(e.naturalKey);
  }
  const at = opts.at ?? new Date().toISOString();
  for (const nk of [...keys].sort()) {
    if (live.has(nk)) {
      report.refusedLive.push(nk);
      log(`  ✗ ${cut(nk)} still has a live PLAYER# row — refused`);
      continue;
    }
    const pending = await repo.getPendingPlayerSync(tenant, nk);
    if (pending?.op === 'erase') {
      report.alreadyQueued.push(nk);
      log(`  = ${cut(nk)} erase already queued`);
      continue;
    }
    if (!opts.confirm) {
      report.wouldQueue.push(nk);
      log(`  · ${cut(nk)} would queue an erase tombstone`);
      continue;
    }
    await repo.recordPlayerSyncErase(tenant, nk, at);
    report.queued.push(nk);
    log(`  ✓ ${cut(nk)} erase tombstone queued`);
  }
  return report;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const entries = JSON.parse(await readFile(args.deleted, 'utf8')) as DeletedNk[];
  if (!Array.isArray(entries)) throw new Error(`${args.deleted} is not a deleted-nks array`);
  const repo = await import('./repo.js');
  console.log(
    `\ntombstone-deleted-players — ${args.tenant} (${args.confirm ? 'CONFIRM' : 'dry run'})`,
  );
  const r = await tombstoneDeleted(repo, args.tenant, entries, { confirm: args.confirm });
  console.log(
    `\n${args.confirm ? `queued ${r.queued.length}` : `would queue ${r.wouldQueue.length}`}, ` +
      `already queued ${r.alreadyQueued.length}, refused (live) ${r.refusedLive.length}` +
      (r.otherTenant ? `, ignored ${r.otherTenant} entr(ies) of another tenant` : ''),
  );
  if (!args.confirm) console.log('[dry-run] nothing written. Re-run with --confirm to queue.');
  if (r.refusedLive.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}
