/**
 * Correct a player's stored first/last name across every club row in a tenant, plus the
 * denormalised `playerName` on that player's clearances. Name changes never change the natural
 * key (it hashes the ID number), so rows are found by key, not by name.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/fix-player-name.ts \
 *     --tenant=dolphins --id-number=<idNumber> --first=<First> --last=<Last>   (dry run)
 *   … --confirm                                                               (writes)
 *   (--nk=<naturalKey> may replace --id-number; exactly one of the two)
 *
 * Order: resolve the natural key → point-get it at every club (O(clubs), no scan) → if nothing
 * and --id-number was given, fall back to each club's roster matched on idNumber (legacy rows
 * keyed by a name slug) → the tenant's clearances (gsi1 query) matched on those rows' keys.
 * Player rows are written via repo.updatePlayer (OCC + the medicoach player-sync outbox);
 * clearances via repo.updateClearancePlayerName (canonical only).
 *
 * Report-only (never written): the VETAFFIL mirror's playerName, and issued clearance
 * certificates (signed artifacts).
 *
 * Re-runnable: rows / clearances already carrying the new name are skipped.
 *
 * Exit status: 1 for a bad/unknown flag or no player rows found; else 0.
 */
import { pathToFileURL } from 'node:url';
import { normalizeId, playerNaturalKey } from '../src/player-identity.js';
import { playerSyncEnabled } from '../src/medicoach-sync/player-placement.js';
import type { PlayerRegistration } from '../src/types.js';

const USAGE =
  'usage: fix-player-name --tenant=<id> (--id-number=<idNumber> | --nk=<naturalKey>) ' +
  '--first=<First> --last=<Last> [--confirm]';

export interface FixPlayerNameArgs {
  tenant: string;
  idNumber?: string;
  nk?: string;
  first: string;
  last: string;
  confirm: boolean;
}

/** Parse the CLI flags; throws (message = the reason) on anything bad or unknown. Pure. */
export function parseFixPlayerNameArgs(argv: string[]): FixPlayerNameArgs {
  const out: Partial<FixPlayerNameArgs> & { confirm: boolean } = { confirm: false };
  for (const arg of argv) {
    const [flag, ...rest] = arg.split('=');
    const value = rest.join('=').trim();
    if (arg === '--confirm') out.confirm = true;
    else if (arg === '--dry-run') out.confirm = false;
    else if (flag === '--tenant' && value) out.tenant = value;
    else if (flag === '--id-number' && value) out.idNumber = value;
    else if (flag === '--nk' && value) out.nk = value;
    else if (flag === '--first' && value) out.first = value;
    else if (flag === '--last' && value) out.last = value;
    else throw new Error(`unknown or empty flag "${arg}"`);
  }
  if (!out.tenant) throw new Error('--tenant is required');
  if (!out.idNumber === !out.nk) throw new Error('exactly one of --id-number or --nk is required');
  if (!out.first) throw new Error('--first is required');
  if (!out.last) throw new Error('--last is required');
  if (/^\d+$/.test(out.last)) throw new Error('--last is all digits (pasted the ID number?)');
  return out as FixPlayerNameArgs;
}

/** First 8 chars of a natural key — never log it in full. */
export const shortKey = (nk: string) => `${nk.slice(0, 8)}…`;

type RepoModule = typeof import('../src/repo.js');

export interface FixPlayerNameDeps {
  repo: RepoModule;
  log?: (line: string) => void;
}

export interface PlayerHit {
  clubId: string;
  clubName: string;
  row: PlayerRegistration;
}

/** Every club row for this person: hash-key point-gets, then the legacy idNumber fallback. */
export async function findPlayerRows(
  repo: RepoModule,
  tenant: string,
  nk: string,
  idNumber?: string,
): Promise<PlayerHit[]> {
  const clubs = await repo.listClubs(tenant);
  const byKey = await Promise.all(
    clubs.map(async (c) => {
      const row = await repo.getPlayer(tenant, c.id, nk);
      return row ? { clubId: c.id, clubName: c.name, row } : null;
    }),
  );
  const hits = byKey.filter((h): h is PlayerHit => !!h);
  if (hits.length || !idNumber) return hits;
  const want = normalizeId(idNumber);
  const rosters = await Promise.all(
    clubs.map(async (c) =>
      (await repo.listPlayers(tenant, c.id))
        .filter((p) => normalizeId(p.idNumber) === want)
        .map((row) => ({ clubId: c.id, clubName: c.name, row })),
    ),
  );
  return rosters.flat();
}

/** Run the correction (dry run prints only). Returns the exit status. */
export async function runFixPlayerName(
  args: FixPlayerNameArgs,
  deps: FixPlayerNameDeps,
): Promise<number> {
  const { repo } = deps;
  const log = deps.log ?? ((l: string) => console.log(l));
  const { tenant, first: firstName, last: lastName } = args;
  const fullName = `${firstName} ${lastName}`;
  const nk = args.nk ?? playerNaturalKey({ idType: 'sa-id', idNumber: args.idNumber });
  log(
    `${args.confirm ? 'CONFIRM' : 'DRY RUN'} tenant=${tenant} nk=${shortKey(nk)} → "${fullName}"`,
  );

  const hits = await findPlayerRows(repo, tenant, nk, args.idNumber);
  if (!hits.length) {
    log(`player NOT FOUND: no row in "${tenant}" for nk=${shortKey(nk)}`);
    return 1;
  }

  const keys = new Set(hits.map((h) => h.row.naturalKey));
  const toFix: PlayerHit[] = [];
  log(`player rows (${hits.length}):`);
  for (const h of hits) {
    const old = `${h.row.firstName} ${h.row.lastName}`;
    const done = h.row.firstName === firstName && h.row.lastName === lastName;
    const legacy = h.row.naturalKey !== nk ? ` [legacy key ${shortKey(h.row.naturalKey)}]` : '';
    log(
      `  ${h.clubName} (${h.clubId}) status=${h.row.status ?? '-'}${legacy}: ` +
        (done ? `"${old}" already correct (skipped)` : `"${old}" → "${fullName}"`),
    );
    if (!done) toFix.push(h);
    if (h.row.veteransClubId) {
      log(
        `    note: veterans affiliation at ${h.row.veteransClubId} — the VETAFFIL mirror's ` +
          'playerName is NOT touched',
      );
    }
  }

  const clearances = (await repo.listAllClearances(tenant)).filter((c) =>
    keys.has(c.playerNaturalKey),
  );
  const clrToFix = clearances.filter((c) => c.playerName !== fullName);
  log(`clearances (${clearances.length}):`);
  for (const c of clearances) {
    log(
      `  ${c.id} ${c.fromClubId}→${c.toClubId} status=${c.status}: ` +
        (c.playerName === fullName
          ? `"${c.playerName}" already correct (skipped)`
          : `"${c.playerName}" → "${fullName}"`),
    );
    if (c.certificateMeta) {
      log('    note: issued certificate is a signed artifact — left untouched');
    }
  }

  if (!args.confirm) {
    log('DRY RUN done: nothing written. Re-run with --confirm to apply.');
    return 0;
  }

  for (const h of toFix) {
    await repo.updatePlayer(tenant, h.clubId, h.row.naturalKey, { firstName, lastName });
    log(`  updated player row at ${h.clubId}`);
  }
  for (const c of clrToFix) {
    await repo.updateClearancePlayerName(tenant, c.fromClubId, c.id, fullName);
    log(`  updated clearance ${c.id}`);
  }
  if (toFix.length) {
    log(
      playerSyncEnabled(await repo.getTenantConfig(tenant))
        ? 'medicoach sync: queued — the cron pushes the corrected name within ~15 min'
        : 'player sync off for tenant: medicoach untouched',
    );
  }
  log(`done: ${toFix.length} player row(s), ${clrToFix.length} clearance(s) updated`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let args: FixPlayerNameArgs;
  try {
    args = parseFixPlayerNameArgs(argv);
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : err}\n${USAGE}`);
    return 1;
  }
  const repo = await import('../src/repo.js');
  return runFixPlayerName(args, { repo });
}

// Only run as a CLI — a test imports the helpers / runFixPlayerName directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((status) => process.exit(status))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
