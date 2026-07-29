/**
 * One-off admin tool: open the registration-origin clearances that were never opened for
 * players who DECLARED an on-system previous club they were not rostered at.
 *
 * Until the fix in createSelfRegistration, that combination fell through to a plain active
 * registration: the clearance decision keyed off roster presence, so a club still digitising
 * its squad was indistinguishable from one the player never played for, and the transfer
 * registered as a fresh signing. This backfills the affected population to the shape the
 * fixed live path now produces:
 *
 *   1. the canonical + mirror clearance items (origin 'registration', NO fromClubDirectory —
 *      the source is a real on-system club, so it approves in its own portal);
 *   2. the destination row flipped active → 'clearance-pending', lastClub normalised to the
 *      source club's canonical name.
 *
 * Deliberately SOURCELESS — no placeholder roster row at the source club and no source
 * playerCount change, matching createPlayerWithSourcelessClearance. resolveClearance and
 * rejectClearance both branch on the source row's ACTUAL absence rather than on
 * fromClubDirectory, so these resolve correctly with no source row. (The older
 * backfill-registration-clearance.ts writes a placeholder because it predates that
 * tolerance; prefer this script for the declared-club case.)
 *
 * Enumerates the affected players itself — it does not take a player argument. A player is
 * affected when ALL of:
 *   - they self-registered (`registeredVia: 'link'`). Chair-entered roster rows (`'portal'`)
 *     take `lastClub` as free history text and no live path could ever open a clearance for
 *     them — sweeping those would invent transfers nobody declared;
 *   - they are ACTIVE;
 *   - their `lastClub` names an on-system club other than their own. NOTE this is a
 *     normalised NAME match, while the live rule keys on the `lastClubId` the form posted.
 *     `lastClubId` is not persisted on the row, so a name match is the only signal available
 *     after the fact. It is therefore slightly broader than the live rule: a player who typed
 *     an exact on-system club name into "Other" (no `lastClubId`) is swept here but would not
 *     be by the live path. That is deliberate — they declared that club either way;
 *   - they hold no clearance under their identity, as either source or destination;
 *   - they have no row at that source club (a rostered player is `open-clearance.ts`'s case).
 *
 * Dry-run by default; pass --confirm to write. Point at prod with:
 *   AWS_PROFILE=medicoach AWS_REGION=af-south-1 \
 *   TABLE_NAME=dolphins-smart-club-prod-DataTable-bbxuffsw \
 *   npx tsx packages/api/src/backfill-declared-club-clearance.ts <tenant> [--confirm]
 */
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import * as repo from './repo.js';
import { playerKey, clearanceKey, inboundClearanceKey, clearanceGsi1 } from './keys.js';
import { tableName } from './env.js';
import type { PlayerClearance, PlayerRegistration, Club } from './types.js';

const TABLE = tableName();
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/**
 * Rendered VERBATIM on the source club rep's pending card (club.tsx) — so it is written for
 * them, not for us. It has to answer "why am I being asked about someone I have no record of?"
 * and "what do I do?", in the same register as the live path's note. An internal changelog
 * line ("Backfilled: the declared previous club was on the system but had no roster
 * record…") tells the rep nothing they can act on.
 */
const note = (fromClubName: string) =>
  `${fromClubName} has no roster record of this player, and they registered elsewhere before ` +
  `transfers were being tracked — so this clearance is being opened now, after the fact. If ` +
  `they did play there, ${fromClubName} can approve it as usual. If they did not, the Union ` +
  `office can reallocate it to the club they actually left — declining is deliberately not an ` +
  `option, since it would permanently flag a legitimately registered player.`;

type Affected = { player: PlayerRegistration; from: Club; to: Club };

async function findAffected(tenant: string): Promise<Affected[]> {
  const clubs = await repo.listClubs(tenant);
  const byName = new Map<string, Club>();
  for (const c of clubs) {
    const key = c.name.trim().toLowerCase();
    // A one-off script writing to prod asserts its own invariants rather than inheriting the
    // API's name-uniqueness checks — repo.createClub is called directly by seeds and scripts,
    // which bypass them. Silently keeping the last-iterated club would misroute a clearance.
    const clash = byName.get(key);
    if (clash) throw new Error(`two clubs normalise to "${key}": ${clash.id} and ${c.id}`);
    byName.set(key, c);
  }
  // naturalKey → the clubs holding ANY row for that person, and every clearance's subject.
  const rosters = new Map<string, Set<string>>();
  const cleared = new Set<string>();
  const players: Array<{ player: PlayerRegistration; club: Club }> = [];
  for (const club of clubs) {
    for (const p of await repo.listPlayers(tenant, club.id)) {
      players.push({ player: p, club });
      const at = rosters.get(p.naturalKey) ?? new Set<string>();
      at.add(club.id);
      rosters.set(p.naturalKey, at);
    }
    // BOTH directions. Sweeping canonicals alone would miss every DIRECTORY-sourced clearance:
    // its canonical lives under the directory slug, a partition with no club META item, so it
    // is not reachable from listClubs. Missing one would re-open an already-settled transfer
    // and flip a legitimately active player back to pending. The destination mirror always
    // sits under a real club, so the two sweeps together see every clearance in the tenant.
    for (const c of await repo.listClearancesForSource(tenant, club.id)) {
      cleared.add(c.playerNaturalKey);
    }
    for (const c of await repo.listInboundForDest(tenant, club.id)) {
      cleared.add(c.playerNaturalKey);
    }
  }

  const affected: Affected[] = [];
  for (const { player, club: to } of players) {
    // Chair-entered rows never declared anything — see the header note.
    if (player.registeredVia !== 'link') continue;
    const last = (player.lastClub ?? '').trim();
    if ((player.status ?? 'active') !== 'active' || !last || last === '—') continue;
    const from = byName.get(last.toLowerCase());
    if (!from || from.id === player.clubId) continue; // off-system name, or re-registration
    if (cleared.has(player.naturalKey)) continue; // already has a clearance, either direction
    if (rosters.get(player.naturalKey)?.has(from.id)) continue; // rostered at source: not this case
    affected.push({ player, from, to });
  }
  // One person, one clearance. `cleared` is computed once up front and never updated as rows
  // are accepted, so a person holding two affected rows (two active `link` registrations at
  // different clubs, each naming a third club) would be swept twice — landing them
  // clearance-pending at two clubs with two independently resolvable clearances. That is
  // exactly the double-active sequence createSelfRegistration's mid-transfer check exists to
  // prevent, and the pre-fix code could produce the two active rows that make it reachable
  // (plain createPlayer guards only `attribute_not_exists` at its own club). Refuse rather than
  // pick one, same as the club-name collision above: it needs a human.
  const bySubject = new Map<string, Affected>();
  for (const a of affected) {
    const prior = bySubject.get(a.player.naturalKey);
    if (prior) {
      throw new Error(
        `${a.player.firstName} ${a.player.lastName} is affected at TWO clubs ` +
          `(${prior.to.id} → ${prior.from.id}, and ${a.to.id} → ${a.from.id}) — ` +
          `resolve the duplicate registration by hand before backfilling`,
      );
    }
    bySubject.set(a.player.naturalKey, a);
  }

  affected.sort((a, b) => (a.player.createdAt ?? '').localeCompare(b.player.createdAt ?? ''));
  return affected;
}

async function open(tenant: string, { player, from, to }: Affected): Promise<void> {
  const clearance: PlayerClearance = {
    id: randomUUID(),
    playerNaturalKey: player.naturalKey,
    playerName: `${player.firstName} ${player.lastName}`,
    idNumber: player.idNumber,
    team: player.team,
    fromClubId: from.id,
    toClubId: to.id,
    fromClubName: from.name,
    toClubName: to.name,
    requestedAt: new Date().toISOString(),
    origin: 'registration',
    note: note(from.name),
    feesCleared: false,
    misconductCleared: false,
    status: 'pending',
    clubApprovedAt: null,
    adminOverrideAt: null,
    version: 0,
  };

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE,
            Item: {
              ...clearanceKey(tenant, from.id, clearance.id),
              ...clearanceGsi1(tenant, clearance.requestedAt),
              ...clearance,
            },
            ConditionExpression: 'attribute_not_exists(sk)',
          },
        },
        {
          Put: {
            TableName: TABLE,
            Item: { ...inboundClearanceKey(tenant, to.id, clearance.id), ...clearance },
          },
        },
        {
          Update: {
            TableName: TABLE,
            Key: playerKey(tenant, to.id, player.naturalKey),
            UpdateExpression: 'SET #s = :pending, lastClub = :fromName ADD version :one',
            // Tolerate legacy rows with no status attribute (absent ⇒ active); the guard
            // doubles as the race check against a clearance opened since enumeration.
            ConditionExpression:
              'attribute_exists(sk) AND (attribute_not_exists(#s) OR #s = :active)',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':pending': 'clearance-pending',
              ':active': 'active',
              ':fromName': from.name,
              ':one': 1,
            },
          },
        },
      ],
    }),
  );
}

async function main() {
  const [tenant] = process.argv.slice(2);
  const confirm = process.argv.includes('--confirm');
  // A flag in the tenant slot would enumerate nothing and exit 0 — a prod script reporting
  // clean success for a command that did nothing.
  if (!tenant || tenant.startsWith('-')) {
    throw new Error('usage: backfill-declared-club-clearance <tenant> [--confirm]');
  }

  const affected = await findAffected(tenant);
  console.log(
    `Affected players (active, declared an on-system club they aren't rostered at, no clearance): ${affected.length}\n`,
  );
  for (const a of affected) {
    console.log(
      `  ${(a.player.createdAt ?? '').slice(0, 19)}  ${a.player.firstName} ${a.player.lastName}` +
        `\n      ${a.from.name} (${a.from.id})  →  ${a.to.name} (${a.to.id})`,
    );
  }
  if (!affected.length) return;

  if (!confirm) {
    console.log('\nDRY RUN — nothing written. Re-run with --confirm to open these clearances.');
    console.log(
      'Each becomes: destination row active → clearance-pending, canonical + mirror clearance,\n' +
        'no placeholder row at the source club, source playerCount unchanged.',
    );
    return;
  }

  // Re-enumerate under --confirm and refuse if the population moved: the operator approved a
  // specific list they read from the dry run, and a registration landing in between would
  // otherwise be swept in unreviewed.
  const now = await findAffected(tenant);
  const key = (a: Affected) => `${a.player.naturalKey}:${a.from.id}:${a.to.id}`;
  const before = affected.map(key).sort().join('|');
  if (now.map(key).sort().join('|') !== before) {
    throw new Error(
      `the affected population changed between enumeration and --confirm ` +
        `(${affected.length} → ${now.length}) — re-run the dry run and review it again`,
    );
  }

  // One transaction per player, isolated: a single conflicting row must not abandon the rest.
  let ok = 0;
  const failed: string[] = [];
  for (const a of affected) {
    const who = `${a.player.firstName} ${a.player.lastName} (${a.from.name} → ${a.to.name})`;
    try {
      await open(tenant, a);
      ok++;
      console.log(`  ✓ ${who}`);
    } catch (err: unknown) {
      // TransactionCanceledException carries the actionable detail in CancellationReasons, not
      // in .message — and this is the only place an operator learns why a prod write failed.
      // Indices track the TransactItems order: [0] clearance id replay, [1] mirror,
      // [2] player row gone or no longer active.
      const reasons = (err as { CancellationReasons?: Array<{ Code?: string }> })
        .CancellationReasons;
      const detail = reasons
        ? reasons.map((r, i) => `[${i}] ${r?.Code ?? 'None'}`).join(' ')
        : err instanceof Error
          ? err.message
          : String(err);
      failed.push(`${who}: ${detail}`);
      console.error(`  ✗ ${who} — ${detail}`);
    }
  }
  console.log(`\n✓ ${ok} clearance(s) opened, ${failed.length} failed.`);
  for (const f of failed) console.error(`  ${f}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
