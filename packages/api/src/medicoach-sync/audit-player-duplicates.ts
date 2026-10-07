/**
 * Read-only audit before the medicoach player-sync backfill (ADR 0018): groups of smart-club
 * persons with the same normalised name + date of birth under DIFFERENT natural keys (a typo'd
 * ID, a passport later swapped for an SA ID). Each group would be held by the sync's
 * possible-duplicate guard; clean them up on smart club first (fix the ID, or confirm them
 * distinct from the admin page once they are reviews).
 *
 *   npx sst shell --stage dev -- npm --prefix packages/api run audit-player-duplicates -- \
 *     --tenant dolphins
 *
 * Writes nothing. Output masks names (initials), never prints a natural key, an ID number or
 * a full date of birth — only the birth year, club names and row statuses.
 */
import { pathToFileURL } from 'node:url';
import { maskName } from '../medicoach-export-build.js';
import { distinctPair } from './player-placement.js';
import { loadPlayerSyncSnapshot, type PlayerSyncSnapshot } from './players.js';

const USAGE = 'usage: audit-player-duplicates --tenant <t>';

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n${USAGE}`);
    this.name = 'UsageError';
  }
}

export function parseArgs(argv: string[]): { tenant: string } {
  let tenant: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--tenant') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new UsageError('--tenant needs a value');
      tenant = v;
    } else throw new UsageError(`unknown argument: ${flag}`);
  }
  if (!tenant) throw new UsageError('--tenant is required');
  return { tenant };
}

export interface DuplicateGroup {
  /** One entry per natural key: its rows' clubs and statuses (no key, no ID). */
  persons: Array<{
    maskedName: string;
    birthYear: string;
    rows: Array<{ club: string; status: string }>;
  }>;
  /** Every pair in the group was confirmed distinct by an admin. */
  allConfirmedDistinct: boolean;
}

/** Same name + dob, different natural key. Deterministic order (largest groups first). */
export function duplicateGroups(snap: PlayerSyncSnapshot): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  for (const nks of snap.byNameDob.values()) {
    if (nks.size < 2) continue;
    const keys = [...nks].sort();
    let allDistinct = true;
    for (let i = 0; i < keys.length; i++)
      for (let j = i + 1; j < keys.length; j++)
        if (!snap.distinct.has(distinctPair(keys[i], keys[j]).join('#'))) allDistinct = false;
    groups.push({
      allConfirmedDistinct: allDistinct,
      persons: keys.map((nk) => {
        const rows = (snap.rowsByNk.get(nk) ?? []).filter((r) => r.placeholder !== true);
        const first = rows[0];
        return {
          maskedName: maskName(first ? `${first.firstName} ${first.lastName}` : ''),
          birthYear: String(first?.dob ?? '').slice(0, 4),
          rows: rows.map((r) => ({
            club: snap.clubsById.get(r.clubId)?.name ?? r.clubId,
            status: r.status ?? 'active',
          })),
        };
      }),
    });
  }
  return groups.sort((a, b) => b.persons.length - a.persons.length);
}

async function main(): Promise<void> {
  const { tenant } = parseArgs(process.argv.slice(2));
  const repo = await import('../repo.js');
  const snap = await loadPlayerSyncSnapshot(repo, tenant);
  const groups = duplicateGroups(snap);
  const open = groups.filter((g) => !g.allConfirmedDistinct);
  console.log(`\nsame name + dob under different IDs — ${tenant} (read-only)`);
  console.log(`  persons scanned                ${snap.rowsByNk.size}`);
  console.log(`  groups                         ${groups.length}`);
  console.log(`  … already confirmed distinct   ${groups.length - open.length}`);
  open.forEach((g, i) => {
    console.log(`\n  group ${i + 1} (${g.persons.length} identities)`);
    for (const p of g.persons)
      console.log(
        `    ${p.maskedName} (${p.birthYear}) — ${p.rows.map((r) => `${r.club} [${r.status}]`).join(', ')}`,
      );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}
