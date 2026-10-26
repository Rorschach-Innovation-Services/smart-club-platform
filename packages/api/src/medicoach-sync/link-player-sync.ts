/**
 * Attach a smart-club person to an EXISTING medicoach player (ADR 0019), then send them now.
 *
 *   npx sst shell --stage prod -- npm --prefix packages/api run link-player-sync -- \
 *     --tenant dolphins --nk <natural-key prefix, 8+ chars> --mc-player <medicoach player id> \
 *     [--confirm]
 *
 * For duplicate cleanup: before a stale registration is deleted (which erases its medicoach
 * ref), the survivor's key is linked to the medicoach athlete the stale key already points at,
 * so the athlete keeps a ref and its match history survives the erase. The admin page's Link
 * refuses possible-duplicate reviews (it only answers medicoach's own candidates) — hence a CLI.
 *
 * Confirm queues the change with a `link` resolution (the duplicate guard never overrides a
 * resolution) and flushes that one person. Their PLAYERREVIEW row is deleted only once the
 * send succeeded; a failed or dry-run send leaves the row queued for the 15-minute sync.
 *
 * Dry run (default) prints who the prefix matched (masked) and what would happen. Output never
 * prints a full natural key.
 */
import { pathToFileURL } from 'node:url';
import { medicoachSyncSecret, medicoachSyncUrl } from '../env.js';
import { maskKey } from '../resolve-duplicate-players.js';
import { describePerson, matchPerson, MIN_PREFIX } from './player-sync-opt-out.js';
import { flushPlayerOutbox, loadPlayerSyncSnapshot } from './players.js';

type RepoModule = typeof import('../repo.js');

const USAGE =
  'usage: link-player-sync --tenant <t> --nk <natural-key prefix> --mc-player <id> [--confirm]';

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n${USAGE}`);
    this.name = 'UsageError';
  }
}

export interface LinkArgs {
  tenant: string;
  nk: string;
  mcPlayer: string;
  confirm: boolean;
}

export function parseArgs(argv: string[]): LinkArgs {
  const out: Partial<LinkArgs> = { confirm: false };
  const value = (flag: string, v: string | undefined): string => {
    if (!v || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--tenant') out.tenant = value(flag, argv[++i]);
    else if (flag === '--nk') out.nk = value(flag, argv[++i]);
    else if (flag === '--mc-player') out.mcPlayer = value(flag, argv[++i]);
    else if (flag === '--confirm') out.confirm = true;
    else throw new UsageError(`unknown argument: ${flag}`);
  }
  if (!out.tenant) throw new UsageError('--tenant is required');
  if (!out.nk) throw new UsageError('--nk is required');
  if (!out.mcPlayer) throw new UsageError('--mc-player is required');
  if (out.nk.length < MIN_PREFIX)
    throw new UsageError(`--nk needs at least ${MIN_PREFIX} characters of the key`);
  return out as LinkArgs;
}

export type LinkOutcome = 'dry-run' | 'linked' | 'queued' | 'review' | 'refused';

export interface LinkDeps {
  url?: string;
  secret?: string;
  log?: (line: string) => void;
  now?: () => Date;
}

export async function run(args: LinkArgs, repo: RepoModule, deps: LinkDeps = {}) {
  const log = deps.log ?? console.log;
  const now = deps.now ?? (() => new Date());
  const { tenant } = args;
  const config = await repo.getTenantConfig(tenant);
  if (!config) throw new Error(`tenant ${tenant} not found`);
  const snap = await loadPlayerSyncSnapshot(repo, tenant, { config });
  const nk = matchPerson(snap.rowsByNk.keys(), args.nk);
  const rows = snap.rowsByNk.get(nk) ?? [];
  const optOut = await repo.getPlayerSyncOptOut(tenant, nk);
  const pending = await repo.getPendingPlayerSync(tenant, nk);
  const review = await repo.getPlayerReview(tenant, nk);

  log(`${args.confirm ? 'CONFIRM' : 'DRY RUN'} — tenant ${tenant}, player ${maskKey(nk)}`);
  for (const line of describePerson(rows, (id) => snap.clubsById.get(id)?.name ?? id)) log(line);
  log(`  medicoach player: ${args.mcPlayer}`);
  log(`  queued change: ${pending ? 'yes' : 'no'} · held review: ${review ? review.reason : 'no'}`);

  if (optOut) {
    log('Refused: this person is opted out of the player sync — nothing is sent to medicoach.');
    return { outcome: 'refused' as LinkOutcome };
  }
  log('Would link this person to that medicoach player and send them now.');
  if (!args.confirm) {
    log('Dry run: nothing written. Re-run with --confirm.');
    return { outcome: 'dry-run' as LinkOutcome };
  }

  await repo.putPendingPlayerSync(tenant, nk, now().toISOString(), {
    resolution: { action: 'link', playerId: args.mcPlayer },
  });
  const summary = await flushPlayerOutbox(tenant, 'cli', {
    repo,
    url: deps.url ?? medicoachSyncUrl(),
    secret: deps.secret ?? medicoachSyncSecret(),
    config,
    only: [nk],
    log,
    now,
  });
  const stillPending = await repo.getPendingPlayerSync(tenant, nk);
  const after = await repo.getPlayerReview(tenant, nk);
  // A review written by THIS flush (medicoach wants another decision) is newer than the one
  // we started with — keep it. The original review is cleared only on a successful send.
  const newReview = !!after && after.detectedAt !== review?.detectedAt;
  let outcome: LinkOutcome;
  if (stillPending) outcome = 'queued';
  else if (newReview) outcome = 'review';
  else {
    if (after) await repo.deletePlayerReview(tenant, nk);
    outcome = 'linked';
  }
  const c = summary.counts;
  log(
    `  flush: ${summary.status} — sent ${c.sent}, linked ${c.linked}, needs review ${c.needsReview}, errors ${c.errors}`,
  );
  log(
    outcome === 'linked'
      ? '✓ linked: medicoach accepted the link; the held review was cleared.'
      : outcome === 'review'
        ? '! medicoach needs another decision — see the review on the admin page.'
        : '! not sent yet (dry run or medicoach unreachable): left queued for the next sync; the review is kept.',
  );
  return { outcome, summary };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repo: RepoModule = await import('../repo.js');
  await run(args, repo);
}

// Only run as a CLI; tests import parseArgs/run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}
