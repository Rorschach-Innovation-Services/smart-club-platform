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
 * The file is validated strictly first (array of { tenant, naturalKey, clubIds }); any malformed
 * entry refuses the whole file before anything is read or written. Refuses a key that still has
 * a live PLAYER# row at any club (it is not deleted). --confirm requires the tenant's player sync
 * to be ON (otherwise recordPlayerSyncErase would queue nothing); the dry run works either way.
 * Each queued key is stamped `tombstonedAt` in the file, so a re-run after the sync worker has
 * drained the queue does not queue it again. Output masks keys exactly as
 * resolve-duplicate-players does (legacy slugs hashed first).
 *
 * EXIT CODES: 0 success (incl. nothing to do) · 1 fatal error · 2 usage/validation error,
 * nothing applied (incl. unknown tenant, sync off on --confirm) · 4 completed, but one or more
 * keys were refused (still live).
 */
import { access, constants } from 'node:fs/promises';
import { open, rename, chmod } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { playerSyncEnabled } from './medicoach-sync/player-placement.js';
import {
  EXIT,
  HelpRequested,
  ValidationError,
  assertTenantExists,
  exitCodeFor,
  maskKey,
  readJsonInput,
  validateDeletedEntries,
  type DeletedNk,
} from './resolve-duplicate-players.js';

type RepoModule = typeof import('./repo.js');

const USAGE = [
  'usage: tombstone-deleted-players --tenant <t> --deleted <deleted-nks.json> [--confirm]',
  '  dry run by default (works with the player sync off); --confirm needs the sync on.',
  '  exit codes:  0 done (incl. nothing to do) · 1 fatal error · 2 usage/validation error, nothing',
  '               applied · 4 completed, but one or more keys were refused (still live).',
].join('\n');

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
    if (flag === '--help' || flag === '-h') throw new HelpRequested(USAGE);
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

const cut = maskKey;

export interface TombstoneReport {
  queued: string[];
  wouldQueue: string[];
  alreadyQueued: string[];
  /** Stamped `tombstonedAt` in the file by an earlier --confirm (not queued again). */
  alreadyTombstoned: string[];
  refusedLive: string[];
  otherTenant: number;
  syncOn: boolean;
}

type TombstoneRepo = Pick<
  RepoModule,
  'getTenantConfig' | 'listClubs' | 'listPlayers' | 'getPendingPlayerSync' | 'recordPlayerSyncErase'
>;

const SYNC_FLAGS = 'features.medicoachSync + integrations.medicoach.playerSync';

export class SyncOffError extends Error {
  constructor(tenant: string) {
    super(
      `the player sync is OFF for ${tenant} (${SYNC_FLAGS} must both be on) — a tombstone would ` +
        'queue nothing. Keep deleted-nks.json until the sync is on, then re-run with --confirm.',
    );
    this.name = 'SyncOffError';
  }
}

export async function tombstoneDeleted(
  repo: TombstoneRepo,
  tenant: string,
  rawEntries: unknown,
  opts: { confirm: boolean; log?: (line: string) => void; at?: string; file?: string },
): Promise<TombstoneReport> {
  const log = opts.log ?? console.log;
  // Validate everything before any read or write: a malformed entry never reaches the table.
  const entries: DeletedNk[] = validateDeletedEntries(rawEntries, opts.file ?? 'deleted-nks');
  await assertTenantExists(repo, tenant);
  const syncOn = playerSyncEnabled(await repo.getTenantConfig(tenant));
  if (!syncOn) {
    if (opts.confirm) throw new SyncOffError(tenant);
    log(
      `  note: the player sync is OFF for ${tenant} (${SYNC_FLAGS}) — dry run only; ` +
        'keep deleted-nks.json until it is on.',
    );
  }
  const report: TombstoneReport = {
    queued: [],
    wouldQueue: [],
    alreadyQueued: [],
    alreadyTombstoned: [],
    refusedLive: [],
    otherTenant: 0,
    syncOn,
  };
  // Every live natural key, one roster query per club (no per-key point-gets).
  const live = new Set<string>();
  for (const club of await repo.listClubs(tenant))
    for (const p of await repo.listPlayers(tenant, club.id)) live.add(p.naturalKey);

  const keys = new Map<string, DeletedNk>();
  for (const e of entries) {
    if (e.tenant !== tenant) {
      report.otherTenant++;
      continue;
    }
    keys.set(e.naturalKey, e);
  }
  const at = opts.at ?? new Date().toISOString();
  for (const nk of [...keys.keys()].sort()) {
    if (live.has(nk)) {
      report.refusedLive.push(nk);
      log(`  ✗ ${cut(nk)} still has a live PLAYER# row — refused`);
      continue;
    }
    const stamped = keys.get(nk)!.tombstonedAt;
    if (stamped) {
      report.alreadyTombstoned.push(nk);
      log(`  = ${cut(nk)} already tombstoned at ${stamped}`);
      continue;
    }
    const pending = syncOn ? await repo.getPendingPlayerSync(tenant, nk) : null;
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

/** Stamp `tombstonedAt` on the keys just queued (or found queued), durably. */
export async function stampTombstoned(
  file: string,
  raw: unknown,
  tenant: string,
  keys: string[],
  at: string,
): Promise<void> {
  if (!keys.length) return;
  const entries = validateDeletedEntries(raw, file);
  for (const e of entries)
    if (e.tenant === tenant && keys.includes(e.naturalKey) && !e.tombstonedAt) e.tombstonedAt = at;
  const tmp = `${file}.tmp-${process.pid}`;
  const fh = await open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(JSON.stringify(entries, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = await readJsonInput(args.deleted);
  validateDeletedEntries(raw, args.deleted); // before importing the repo or touching anything
  if (args.confirm) {
    // The stamp must be writable before any tombstone is queued.
    try {
      await access(args.deleted, constants.W_OK);
    } catch (err) {
      throw new ValidationError(
        `cannot write ${args.deleted} (${(err as { code?: string }).code ?? err}) — nothing was queued`,
      );
    }
  }
  const repo = await import('./repo.js');
  console.log(
    `\ntombstone-deleted-players — ${args.tenant} (${args.confirm ? 'CONFIRM' : 'dry run'})`,
  );
  const at = new Date().toISOString();
  let r: TombstoneReport;
  try {
    r = await tombstoneDeleted(repo, args.tenant, raw, {
      confirm: args.confirm,
      file: args.deleted,
      at,
    });
  } catch (err) {
    if (err instanceof SyncOffError) throw new ValidationError(err.message);
    throw err;
  }
  if (args.confirm)
    await stampTombstoned(args.deleted, raw, args.tenant, [...r.queued, ...r.alreadyQueued], at);
  console.log(
    `\n${args.confirm ? `queued ${r.queued.length}` : `would queue ${r.wouldQueue.length}`}, ` +
      `already queued ${r.alreadyQueued.length}, already tombstoned ${r.alreadyTombstoned.length}, ` +
      `refused (live) ${r.refusedLive.length}` +
      (r.otherTenant ? `, ignored ${r.otherTenant} entr(ies) of another tenant` : ''),
  );
  if (!args.confirm) console.log('[dry-run] nothing written. Re-run with --confirm to queue.');
  if (r.refusedLive.length) {
    console.log('\nRESULT: partial — live keys were refused (exit 4).');
    process.exitCode = EXIT.partial;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    if (err instanceof HelpRequested) {
      console.log(err.usage);
      process.exit(EXIT.ok);
    }
    console.error(err instanceof Error ? err.message : err);
    process.exit(err instanceof UsageError ? EXIT.usage : exitCodeFor(err));
  });
}
