/**
 * Read-only: a club's office bearers (chair first) and its PLAYER# roster. Writes nothing and
 * imports no notify module.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/club-contacts-report.ts \
 *     --stage=<stage> [--tenant=dolphins] --club="Amanzimtoti" [--find="Dillon Bryan"]
 *
 * `--club` is a case-insensitive name substring; more than one match lists the candidates and
 * exits 1. The roster is one Query of the club partition (repo.listPlayers).
 *
 * Exit status: 1 for a bad flag, a stage mismatch, or no / ambiguous club; else 0.
 */
import { pathToFileURL } from 'node:url';
import { sstStage } from './backfill-captains-report-notices.js';

const USAGE =
  'usage: club-contacts-report --stage=<stage> [--tenant=<id>] --club=<name substring> ' +
  '[--find=<player name>]';

export interface ClubContactsArgs {
  stage: string;
  tenant: string;
  club: string;
  find: string;
}

/** Parse the CLI flags; throws (message = the reason) on anything bad or unknown. Pure. */
export function parseClubContactsArgs(argv: string[]): ClubContactsArgs {
  const out: Partial<ClubContactsArgs> & { tenant: string; find: string } = {
    tenant: 'dolphins',
    find: 'Dillon Bryan',
  };
  for (const arg of argv) {
    const [flag, ...rest] = arg.split('=');
    const value = rest.join('=').trim();
    if (flag === '--stage' && value) out.stage = value;
    else if (flag === '--tenant' && value) out.tenant = value;
    else if (flag === '--club' && value) out.club = value;
    else if (flag === '--find' && value) out.find = value;
    else throw new Error(`unknown or empty flag "${arg}"`);
  }
  if (!out.stage) throw new Error('--stage is required');
  if (!out.club) throw new Error('--club is required');
  return out as ClubContactsArgs;
}

type RepoModule = typeof import('../src/repo.js');

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const yn = (v: unknown) => (typeof v === 'string' && v.trim() ? 'yes' : 'NO');

export async function runClubContacts(
  args: ClubContactsArgs,
  repo: RepoModule,
  log: (l: string) => void = console.log,
): Promise<number> {
  const { chairContactOf } = await import('../src/club-contacts.js');
  const clubs = await repo.listClubs(args.tenant);
  const needle = norm(args.club);
  const hits = clubs.filter((c) => norm(c.name ?? '').includes(needle));
  if (hits.length !== 1) {
    log(`${hits.length} club(s) match "${args.club}" in tenant ${args.tenant}`);
    for (const c of hits) log(`  ${c.id}  ${c.name}`);
    return 1;
  }
  const club = hits[0];
  log(`club: ${club.name} [${club.id}] district=${club.district ?? '-'}`);

  const chair = chairContactOf(club);
  log(
    `chair (notice recipient): ${chair.name || '(no name)'} email=${chair.email || '(none)'} cell=${chair.cell || '(none)'}`,
  );
  log(`legacy club.chair: ${club.chair || '(unset)'}`);
  const exco = (club.exco ?? {}) as Record<string, unknown>;
  const roles = Object.keys(exco).sort((a, b) =>
    a === 'chair' ? -1 : b === 'chair' ? 1 : a.localeCompare(b),
  );
  log('office bearers (exco):');
  if (!roles.length) log('  (none)');
  for (const role of roles) {
    const v = exco[role];
    if (!v || typeof v !== 'object') continue;
    const p = v as { name?: string; email?: string; cell?: string };
    log(
      `  ${role}: ${p.name || '(no name)'} email=${p.email || '(none)'} cell=${p.cell || '(none)'}`,
    );
  }

  const players = await repo.listPlayers(args.tenant, club.id);
  const sorted = [...players].sort((a, b) =>
    `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`),
  );
  log(`roster (${players.length} PLAYER# rows):`);
  const target = norm(args.find);
  let found = false;
  for (const p of sorted) {
    const name = `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim();
    const match = norm(name) === target;
    if (match) found = true;
    log(
      `  ${match ? '>> ' : ''}${name}  status=${p.status ?? 'active'} email=${yn(p.email)} ` +
        `cell=${yn(p.cell)}${p.isMinor ? ' MINOR' : ''}${p.team ? ` team=${p.team}` : ''}`,
    );
  }
  log(`"${args.find}" on roster: ${found ? 'YES' : 'NO'}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let args: ClubContactsArgs;
  try {
    args = parseClubContactsArgs(argv);
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : err}\n${USAGE}`);
    return 1;
  }
  const actual = sstStage();
  if (actual !== args.stage) {
    console.error(`REFUSED: --stage=${args.stage} but sst shell stage is ${actual ?? '(none)'}`);
    return 1;
  }
  return runClubContacts(args, await import('../src/repo.js'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((status) => process.exit(status))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
