/**
 * One-off admin tool: open a request-origin inter-club clearance for a player who is
 * already rostered at the source club — the same effect as a destination club using
 * "Request a player" in the portal. Reuses the tested `repo.createClearance`, so it writes
 * the canonical + mirror clearance items and flips the source player to 'clearance-pending'
 * atomically. The source club then approves in the portal to complete the move.
 *
 * Transfer windows apply: when the tenant has windows configured and none is open today, the
 * tool refuses under --confirm (no override flag — adjust the tenant's windows in the platform
 * console); a dry run only warns.
 *
 * Dry-run by default; pass --confirm to write. Point at prod with:
 *   AWS_PROFILE=medicoach AWS_REGION=af-south-1 \
 *   TABLE_NAME=dolphins-smart-club-prod-DataTable-bbxuffsw \
 *   npx tsx packages/api/src/open-clearance.ts <tenant> <fromClubId> <toClubId> <idNumber> --confirm
 */
import { randomUUID } from 'node:crypto';
import * as repo from './repo.js';
import { enforceCliRegistrationWindow } from './transfer-windows.js';
import type { PlayerClearance } from './types.js';

const normalizeId = (s: string) => s.trim().toUpperCase();

async function main() {
  const [tenant, fromClubId, toClubId, idNumber] = process.argv.slice(2);
  const confirm = process.argv.includes('--confirm');
  if (!tenant || !fromClubId || !toClubId || !idNumber) {
    throw new Error(
      'usage: open-clearance <tenant> <fromClubId> <toClubId> <idNumber> [--confirm]',
    );
  }
  if (fromClubId === toClubId) throw new Error('fromClubId and toClubId must differ');

  enforceCliRegistrationWindow(await repo.getTenantConfig(tenant), confirm);

  const fromClub = await repo.getClub(tenant, fromClubId);
  if (!fromClub) throw new Error(`source club not found: ${fromClubId}`);
  const toClub = await repo.getClub(tenant, toClubId);
  if (!toClub) throw new Error(`destination club not found: ${toClubId}`);

  const roster = await repo.listPlayers(tenant, fromClubId);
  const wanted = normalizeId(idNumber);
  const player = roster.find((p) => normalizeId(p.idNumber ?? '') === wanted);
  if (!player) throw new Error(`no player with ID ${idNumber} at ${fromClub.name} (${fromClubId})`);
  if (player.status === 'clearance-pending') {
    throw new Error(`${player.firstName} ${player.lastName} is already clearance-pending`);
  }

  const clearance: PlayerClearance = {
    id: randomUUID(),
    playerNaturalKey: player.naturalKey,
    playerName: `${player.firstName} ${player.lastName}`,
    idNumber: player.idNumber,
    team: player.team,
    fromClubId,
    toClubId,
    fromClubName: fromClub.name,
    toClubName: toClub.name,
    requestedAt: new Date().toISOString(),
    feesCleared: false,
    misconductCleared: false,
    status: 'pending',
    clubApprovedAt: null,
    adminOverrideAt: null,
    version: 0,
  };

  console.log(
    `Open clearance: ${clearance.playerName} (ID ${clearance.idNumber})\n` +
      `  ${fromClub.name} (${fromClubId})  →  ${toClub.name} (${toClubId})\n` +
      `  current source status: ${player.status ?? 'active'} → will become 'clearance-pending'\n` +
      `  clearance id: ${clearance.id}, origin: request (approved by ${fromClub.name})`,
  );

  if (!confirm) {
    console.log('\nDRY RUN — nothing written. Re-run with --confirm to open the clearance.');
    return;
  }

  await repo.createClearance(tenant, clearance);
  console.log(
    '\n✓ Clearance opened. The source club approves it in the portal to complete the move.',
  );
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
