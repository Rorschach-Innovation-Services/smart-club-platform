/**
 * One-off, POST-BURN-IN cleanup: strip the inert leftovers of the retired competition
 * layer from every tenant config. Run it only once prod has run the one-setup-per-league
 * build long enough that rolling back to a build that reads `competitions[]` is off the
 * table — after this, an old build would see every league as unbound.
 *
 * Per tenant, per league:
 *   - `competitions` is removed (the setup migration left it beside `setup`);
 *   - `note` is removed (display-only, retired with the catalogue's note input).
 * Per tenant, per structure, per stage spec:
 *   - `ladder` and `outcome` are removed (stored but never read).
 *
 * GUARD: a league that still has competitions but NO `setup` has not been migrated.
 * Stripping it would lose its only binding, so the whole tenant is left untouched, the
 * league is reported, and the run exits 1 — run migrate-league-setups first.
 *
 * Nothing else changes: structure versions are not bumped (the removed fields were never
 * read, so no season's behaviour changes), and season runs are not touched. The config is
 * not re-validated: the strip only removes fields no validator reads, so it cannot turn a
 * config the operator route accepts into one it refuses.
 *
 * Per tenant, under `--confirm`: the config is RE-READ, planned, a full pre-image backup
 * is written, then one whole-item put. A tenant whose backup or write fails is skipped
 * whole and reported — never partially written. Idempotent: a re-run finds nothing to do.
 *
 * Exit status (`main`): 1 for an unknown flag; 1 (dry-run AND --confirm) when any tenant
 * was skipped or any unmigrated league was found; 0 otherwise.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/cleanup-competitions.ts             (dry-run)
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/cleanup-competitions.ts --dry-run   (explicit dry-run)
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/cleanup-competitions.ts --confirm   (writes)
 *   … --confirm --backup-dir=<dir>   (backups elsewhere; default packages/api/)
 *
 * Backups: `packages/api/competitions-cleanup-backup-<tenant>-<ISO>.json` — the tenant's
 * full config exactly as read before the put (gitignored by `packages/api/*-backup-*.json`).
 * RESTORE: the file is a complete TenantConfig; put it back whole, e.g.
 *   sst shell --stage <stage> -- npx tsx -e "import('./packages/api/src/repo.ts').then(async r => r.putTenantConfig(JSON.parse(require('fs').readFileSync('<file>','utf8'))))"
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as repo from '../src/repo.js';
import type { CompetitionStructure, League, TenantConfig } from '../src/types.js';

/** packages/api — where backups land unless `--backup-dir` says otherwise. */
const DEFAULT_BACKUP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What one tenant's cleanup removes (or would remove). */
export interface TenantCleanup {
  tenant: string;
  /** Leagues whose `competitions` is removed. */
  competitions: string[];
  /** Leagues whose `note` is removed. */
  notes: string[];
  /** `<structureId>/<stageId>` for every stage spec losing `ladder` and/or `outcome`. */
  stages: string[];
}

export interface UnmigratedLeague {
  tenant: string;
  leagueKey: string;
  /** How many competitions it still carries. */
  competitions: number;
}

export interface CleanupSkip {
  tenant: string;
  reason: string;
}

export interface CleanupCompetitionsResult {
  tenantsScanned: number;
  /** Tenants planned (dry-run) or written (--confirm). */
  tenantsCleaned: number;
  competitionsStripped: number;
  notesStripped: number;
  stagesStripped: number;
  cleanups: TenantCleanup[];
  /** Leagues with competitions and no setup — their tenant is left untouched. */
  unmigrated: UnmigratedLeague[];
  skipped: CleanupSkip[];
  /** Backup files written under --confirm. */
  backups: string[];
}

/** The storage calls the cleanup makes — the real repo unless a test substitutes one. */
export type CleanupStore = Pick<typeof repo, 'listTenants' | 'getTenantConfig' | 'putTenantConfig'>;

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A stored league may still carry the retired `note`, which the type no longer declares. */
type StoredLeague = League & { note?: unknown };
type StoredStage = CompetitionStructure['stages'][number] & { ladder?: unknown; outcome?: unknown };

/**
 * Plan one tenant in memory. Never writes. `undefined` when there is nothing to strip and
 * nothing unmigrated.
 */
function planTenant(
  config: TenantConfig,
): { next: TenantConfig; cleanup: TenantCleanup; unmigrated: UnmigratedLeague[] } | undefined {
  const tenant = config.tenant;
  const cleanup: TenantCleanup = { tenant, competitions: [], notes: [], stages: [] };
  const unmigrated: UnmigratedLeague[] = [];

  const leagues = (config.leagues ?? []).map((stored) => {
    const lg = stored as StoredLeague;
    if ((lg.competitions?.length ?? 0) > 0 && lg.setup === undefined)
      unmigrated.push({ tenant, leagueKey: lg.key, competitions: lg.competitions!.length });
    if (lg.competitions === undefined && lg.note === undefined) return stored;
    const { competitions, note, ...rest } = lg;
    if (competitions !== undefined) cleanup.competitions.push(lg.key);
    if (note !== undefined) cleanup.notes.push(lg.key);
    return rest as League;
  });

  const structures = config.structures?.map((st) => {
    const stages = st.stages.map((stored) => {
      const stage = stored as StoredStage;
      if (stage.ladder === undefined && stage.outcome === undefined) return stored;
      const { ladder: _ladder, outcome: _outcome, ...rest } = stage;
      void _ladder;
      void _outcome;
      cleanup.stages.push(`${st.id}/${stage.id}`);
      return rest;
    });
    return stages.some((s, i) => s !== st.stages[i]) ? { ...st, stages } : st;
  });

  const work = cleanup.competitions.length + cleanup.notes.length + cleanup.stages.length;
  if (work === 0 && unmigrated.length === 0) return undefined;
  const next: TenantConfig = {
    ...config,
    leagues,
    ...(structures ? { structures } : {}),
  };
  return { next, cleanup, unmigrated };
}

function printTenant(label: string, c: TenantCleanup, log: (line: string) => void): void {
  log(`${label}:`);
  if (c.competitions.length) log(`  competitions: ${c.competitions.join(', ')}`);
  if (c.notes.length) log(`  note: ${c.notes.join(', ')}`);
  if (c.stages.length) log(`  ladder/outcome: ${c.stages.join(', ')}`);
}

const isoStamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

export async function cleanupCompetitions(
  opts: {
    confirm?: boolean;
    log?: (line: string) => void;
    store?: CleanupStore;
    backupDir?: string;
  } = {},
): Promise<CleanupCompetitionsResult> {
  const confirm = opts.confirm ?? false;
  const log = opts.log ?? console.log;
  const store = opts.store ?? repo;
  const backupDir = opts.backupDir ?? DEFAULT_BACKUP_DIR;

  const tenants = await store.listTenants();
  const result: CleanupCompetitionsResult = {
    tenantsScanned: tenants.length,
    tenantsCleaned: 0,
    competitionsStripped: 0,
    notesStripped: 0,
    stagesStripped: 0,
    cleanups: [],
    unmigrated: [],
    skipped: [],
    backups: [],
  };
  const count = (c: TenantCleanup): void => {
    result.cleanups.push(c);
    result.tenantsCleaned++;
    result.competitionsStripped += c.competitions.length;
    result.notesStripped += c.notes.length;
    result.stagesStripped += c.stages.length;
  };

  for (const listed of tenants) {
    const tenant = listed.tenant;
    try {
      // Under --confirm, plan against the config as it is right before the put: a settings
      // save since the tenant list was read must not be overwritten by an older copy.
      const config = confirm ? await store.getTenantConfig(tenant) : listed;
      if (!config) {
        result.skipped.push({
          tenant,
          reason: 'tenant disappeared during the cleanup — nothing written',
        });
        continue;
      }
      const planned = planTenant(config);
      if (!planned) continue;
      const { next, cleanup, unmigrated } = planned;
      if (unmigrated.length > 0) {
        result.unmigrated.push(...unmigrated);
        for (const u of unmigrated)
          log(
            `  ! ${tenant} · ${u.leagueKey}: ${u.competitions} competition(s) and no setup — tenant left untouched; run migrate-league-setups first`,
          );
        continue;
      }

      printTenant(`${confirm ? '' : '[dry-run] '}${tenant}`, cleanup, log);
      if (!confirm) {
        count(cleanup);
        continue;
      }

      let backupPath: string;
      try {
        await mkdir(backupDir, { recursive: true });
        backupPath = join(backupDir, `competitions-cleanup-backup-${tenant}-${isoStamp()}.json`);
        await writeFile(backupPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
      } catch (err) {
        result.skipped.push({
          tenant,
          reason: `backup failed — nothing written: ${reasonOf(err)}`,
        });
        continue;
      }
      result.backups.push(backupPath);
      try {
        await store.putTenantConfig(next);
      } catch (err) {
        result.skipped.push({ tenant, reason: `config write failed: ${reasonOf(err)}` });
        continue;
      }
      log(`  backup: ${backupPath}`);
      count(cleanup);
    } catch (err) {
      result.skipped.push({ tenant, reason: `could not be read: ${reasonOf(err)}` });
    }
  }

  for (const s of result.skipped) log(`  ✗ skipped: ${s.tenant} — ${s.reason}`);
  if (result.unmigrated.length > 0)
    log(
      `STOP: ${result.unmigrated.length} unmigrated league(s) found — run migrate-league-setups, then re-run this cleanup`,
    );
  const totals = `${result.competitionsStripped} competitions, ${result.notesStripped} notes, ${result.stagesStripped} stage ladder/outcome`;
  log(
    confirm
      ? `cleanup complete: ${result.tenantsCleaned} tenant(s) cleaned — ${totals} removed`
      : `dry-run complete: ${result.tenantsCleaned} tenant(s) would be cleaned — ${totals} to remove. Re-run with --confirm.`,
  );
  return result;
}

/**
 * The CLI, minus `process.exit`: returns the exit status. 1 for an unknown flag; 1 (in
 * either mode) when any tenant was skipped or any unmigrated league was found; 0 otherwise.
 */
export async function main(
  args: string[],
  opts: {
    log?: (line: string) => void;
    error?: (line: string) => void;
    store?: CleanupStore;
  } = {},
): Promise<number> {
  let confirm = false;
  let backupDir: string | undefined;
  for (const arg of args) {
    if (arg === '--confirm') confirm = true;
    else if (arg === '--dry-run') confirm = false;
    else if (arg.startsWith('--backup-dir=') && arg.length > '--backup-dir='.length)
      backupDir = arg.slice('--backup-dir='.length);
    else {
      (opts.error ?? console.error)(
        `unknown flag "${arg}" — usage: cleanup-competitions [--dry-run|--confirm] [--backup-dir=<dir>]`,
      );
      return 1;
    }
  }
  const result = await cleanupCompetitions({
    confirm,
    log: opts.log,
    store: opts.store,
    backupDir,
  });
  return result.skipped.length > 0 || result.unmigrated.length > 0 ? 1 : 0;
}

// Only run as a CLI — a test can import cleanupCompetitions / main directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((status) => process.exit(status))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
