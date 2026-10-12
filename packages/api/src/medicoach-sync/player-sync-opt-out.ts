/**
 * Opt a person out of the medicoach player sync (ADR 0019), or back in.
 *
 *   npx sst shell --stage prod -- npm --prefix packages/api run player-sync-opt-out -- \
 *     --tenant dolphins --player <natural-key prefix, 8+ chars> \
 *     [--reason medicoach-account-deleted|other] [--note "<text>"] [--remove] [--confirm]
 *
 * For a person who deleted their Match Centre account — a data-subject request the sync must
 * not undo: the flush drops their queued changes and never sends them anything but an erase.
 * Their club registration in smart club is untouched. `--remove` opts them back in and
 * re-queues them.
 *
 * Dry run (default) prints who the prefix matched — masked name, birth year, clubs — and what
 * would change. The prefix must match exactly one person. Output never prints a full natural
 * key (PERSONAL DATA: hashed SA ID numbers, or legacy keys that embed a name).
 */
import { pathToFileURL } from 'node:url';
import { maskName } from '../medicoach-export-build.js';
import { maskKey } from '../resolve-duplicate-players.js';
import type { PlayerRegistration, PlayerSyncOptOut } from '../types.js';
import { loadPlayerSyncSnapshot } from './players.js';

type RepoModule = typeof import('../repo.js');

const USAGE =
  'usage: player-sync-opt-out --tenant <t> --player <natural-key prefix> ' +
  '[--reason medicoach-account-deleted|other] [--note <text>] [--remove] [--confirm]';

/** Short prefixes risk matching the wrong person; 8 hex chars is ~4 billion keys. */
export const MIN_PREFIX = 8;

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n${USAGE}`);
    this.name = 'UsageError';
  }
}

export interface OptOutArgs {
  tenant: string;
  player: string;
  reason: PlayerSyncOptOut['reason'];
  note?: string;
  remove: boolean;
  confirm: boolean;
}

export function parseArgs(argv: string[]): OptOutArgs {
  const out: Partial<OptOutArgs> = { reason: 'medicoach-account-deleted', remove: false, confirm: false };
  const value = (flag: string, v: string | undefined): string => {
    if (!v || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--tenant') out.tenant = value(flag, argv[++i]);
    else if (flag === '--player') out.player = value(flag, argv[++i]);
    else if (flag === '--reason') {
      const v = value(flag, argv[++i]);
      if (v !== 'medicoach-account-deleted' && v !== 'other')
        throw new UsageError('--reason must be medicoach-account-deleted or other');
      out.reason = v;
    } else if (flag === '--note') out.note = value(flag, argv[++i]);
    else if (flag === '--remove') out.remove = true;
    else if (flag === '--confirm') out.confirm = true;
    else throw new UsageError(`unknown argument: ${flag}`);
  }
  if (!out.tenant) throw new UsageError('--tenant is required');
  if (!out.player) throw new UsageError('--player is required');
  if (out.player.length < MIN_PREFIX)
    throw new UsageError(`--player needs at least ${MIN_PREFIX} characters of the key`);
  return out as OptOutArgs;
}

/** The one natural key the prefix names, or a plain error (counts only, never keys). */
export function matchPerson(keys: Iterable<string>, prefix: string): string {
  const hits = [...keys].filter((nk) => nk.startsWith(prefix));
  if (hits.length === 1) return hits[0];
  throw new Error(
    hits.length === 0
      ? 'no player in this tenant has a natural key starting with that prefix'
      : `${hits.length} players match that prefix — give more characters`,
  );
}

/** What the terminal shows about the person: masked, enough to recognise them. */
export function describePerson(
  rows: PlayerRegistration[],
  clubName: (clubId: string) => string,
): string[] {
  const newest = [...rows].sort((a, b) =>
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
  )[0];
  const year = String(newest?.dob ?? '').slice(0, 4) || '????';
  return [
    `  ${maskName(`${newest?.firstName ?? ''} ${newest?.lastName ?? ''}`)}  b.${year}`,
    ...rows.map((r) => `  - ${clubName(r.clubId)} (${r.status ?? 'active'})`),
  ];
}

export async function run(
  args: OptOutArgs,
  repo: RepoModule,
  log: (line: string) => void = console.log,
  now: () => Date = () => new Date(),
): Promise<void> {
  const { tenant } = args;
  const config = await repo.getTenantConfig(tenant);
  if (!config) throw new Error(`tenant ${tenant} not found`);
  const snap = await loadPlayerSyncSnapshot(repo, tenant, { config });
  const nk = matchPerson(snap.rowsByNk.keys(), args.player);
  const rows = snap.rowsByNk.get(nk) ?? [];
  const current = await repo.getPlayerSyncOptOut(tenant, nk);
  const pending = await repo.getPendingPlayerSync(tenant, nk);
  const review = await repo.getPlayerReview(tenant, nk);

  log(`${args.confirm ? 'CONFIRM' : 'DRY RUN'} — tenant ${tenant}, player ${maskKey(nk)}`);
  for (const line of describePerson(rows, (id) => snap.clubsById.get(id)?.name ?? id)) log(line);
  log(
    current
      ? `  opted out: yes (${current.reason}, ${current.at} by ${current.by})`
      : '  opted out: no',
  );

  if (!args.remove) {
    if (current) {
      log('Nothing to do: already opted out.');
      return;
    }
    // An erase (or the erase owed before a re-registration) still goes out: it only removes data.
    const dropRow = !!pending && pending.op !== 'erase' && pending.eraseFirst !== true;
    log(
      `Would opt out${dropRow ? ', drop their queued change' : ''}` +
        `${review ? ', delete their held review' : ''}.`,
    );
    if (!args.confirm) {
      log('Dry run: nothing written. Re-run with --confirm.');
      return;
    }
    await repo.putPlayerSyncOptOut(tenant, {
      naturalKey: nk,
      reason: args.reason,
      ...(args.note ? { note: args.note } : {}),
      by: process.env.USER || 'cli',
      at: now().toISOString(),
    });
    if (dropRow) await repo.deletePendingPlayerSync(tenant, nk);
    if (review) await repo.deletePlayerReview(tenant, nk);
    log('✓ opted out: the player sync will not send this person to medicoach.');
    return;
  }

  if (!current) {
    log('Nothing to do: not opted out.');
    return;
  }
  log('Would opt back in and re-queue the person for the next sync.');
  if (!args.confirm) {
    log('Dry run: nothing written. Re-run with --confirm.');
    return;
  }
  await repo.deletePlayerSyncOptOut(tenant, nk);
  const queued = await repo.recordPlayerSyncChange(tenant, nk, { config });
  log(
    `✓ opted back in${queued ? '; queued for the next sync' : ' (the player sync is off — nothing queued)'}.`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repo: RepoModule = await import('../repo.js');
  await run(args, repo);
}

// Only run as a CLI; tests import parseArgs/matchPerson/run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}
