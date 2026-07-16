/**
 * One-off admin tool: retroactively open the REGISTRATION-origin clearance a player
 * would have received had the transfer-clearance flow existed when they registered.
 * The player is already rostered (active) at the DESTINATION club; their previous
 * club is on the system but never had them on its roster. Writes, atomically:
 *
 *   1. a MINIMAL placeholder player row at the previous (source) club, status
 *      'clearance-pending' — required so resolveClearance/rejectClearance (which
 *      read and then delete the source row) work unchanged. Deliberately carries
 *      no contact details (the fixtures broadcast fans out to every roster row)
 *      and no idDocMeta (rejection's POPIA S3 purge would delete the live docs);
 *   2. the canonical + mirror clearance items (origin 'registration', so approval
 *      ACTIVATES the existing destination row instead of trying to create one);
 *   3. the destination row flipped active → 'clearance-pending', with lastClub set
 *      to the source club's display name (what the real flow writes at registration);
 *   4. source club playerCount +1 (approval and rejection both decrement it).
 *
 * The source club then approves in its portal — or the union admin overrides.
 * NEVER REJECT a backfilled clearance: it flags a legitimately active player
 * 'clearance-rejected' with no reactivation endpoint.
 *
 * Dry-run by default; pass --confirm to write. Point at prod with:
 *   AWS_PROFILE=medicoach AWS_REGION=af-south-1 \
 *   TABLE_NAME=dolphins-smart-club-prod-DataTable-bbxuffsw \
 *   npx tsx packages/api/src/backfill-registration-clearance.ts <tenant> <fromClubId> <toClubId> <idNumber> --confirm
 */
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import * as repo from './repo.js';
import { clubKey, playerKey, clearanceKey, inboundClearanceKey, clearanceGsi1 } from './keys.js';
import { tableName } from './env.js';
import type { PlayerClearance, PlayerRegistration } from './types.js';

const TABLE = tableName();
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const normalizeId = (s: string) => s.trim().toUpperCase();

async function main() {
  const [tenant, fromClubId, toClubId, idNumber] = process.argv.slice(2);
  const confirm = process.argv.includes('--confirm');
  if (!tenant || !fromClubId || !toClubId || !idNumber) {
    throw new Error(
      'usage: backfill-registration-clearance <tenant> <fromClubId> <toClubId> <idNumber> [--confirm]',
    );
  }
  if (fromClubId === toClubId) throw new Error('fromClubId and toClubId must differ');

  const fromClub = await repo.getClub(tenant, fromClubId);
  if (!fromClub) throw new Error(`source club not found: ${fromClubId}`);
  const toClub = await repo.getClub(tenant, toClubId);
  if (!toClub) throw new Error(`destination club not found: ${toClubId}`);

  const roster = await repo.listPlayers(tenant, toClubId);
  const wanted = normalizeId(idNumber);
  const player = roster.find((p) => normalizeId(p.idNumber ?? '') === wanted);
  if (!player) throw new Error(`no player with ID ${idNumber} at ${toClub.name} (${toClubId})`);
  if ((player.status ?? 'active') !== 'active') {
    throw new Error(
      `${player.firstName} ${player.lastName} is not active at ${toClub.name} ` +
        `(status: ${player.status}) — refusing to open a clearance`,
    );
  }
  if (await repo.getPlayer(tenant, fromClubId, player.naturalKey)) {
    throw new Error(
      `${player.firstName} ${player.lastName} already has a row at ${fromClub.name} ` +
        `(${fromClubId}) — use open-clearance.ts for a normally-rostered player`,
    );
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
    note: 'Backfilled: player registered before the transfer-clearance flow existed',
    origin: 'registration',
    feesCleared: false,
    misconductCleared: false,
    status: 'pending',
    clubApprovedAt: null,
    adminOverrideAt: null,
    version: 0,
  };

  // Minimal on purpose: no contact details (send-fixtures fans out to every roster
  // row) and no idDocMeta (rejection's S3 purge would delete the live documents).
  const placeholder: PlayerRegistration = {
    naturalKey: player.naturalKey,
    clubId: fromClubId,
    firstName: player.firstName,
    lastName: player.lastName,
    dob: player.dob,
    isMinor: player.isMinor,
    consentAt: player.consentAt,
    createdAt: player.createdAt,
    idNumber: player.idNumber,
    team: player.team,
    status: 'clearance-pending',
    version: 0,
  };

  console.log(
    `Backfill registration-origin clearance: ${clearance.playerName} (ID ${clearance.idNumber})\n` +
      `  ${fromClub.name} (${fromClubId})  →  ${toClub.name} (${toClubId})\n` +
      `  raw status at ${toClub.name}: ${JSON.stringify(player.status)} → 'clearance-pending'\n` +
      `  naturalKey: ${player.naturalKey}\n` +
      `  lastClub: ${JSON.stringify(player.lastClub)} → ${JSON.stringify(fromClub.name)}\n` +
      `  placeholder row at ${fromClub.name} (clearance-pending), playerCount +1\n` +
      `  clearance id: ${clearance.id} (approved by ${fromClub.name} or admin override)`,
  );

  if (!confirm) {
    console.log('\nDRY RUN — nothing written. Re-run with --confirm to open the clearance.');
    return;
  }

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE,
            Item: { ...playerKey(tenant, fromClubId, player.naturalKey), ...placeholder },
            ConditionExpression: 'attribute_not_exists(sk)',
          },
        },
        {
          Put: {
            TableName: TABLE,
            Item: {
              ...clearanceKey(tenant, fromClubId, clearance.id),
              ...clearanceGsi1(tenant, clearance.requestedAt),
              ...clearance,
            },
            ConditionExpression: 'attribute_not_exists(sk)',
          },
        },
        {
          Put: {
            TableName: TABLE,
            Item: { ...inboundClearanceKey(tenant, toClubId, clearance.id), ...clearance },
          },
        },
        {
          Update: {
            TableName: TABLE,
            Key: playerKey(tenant, toClubId, player.naturalKey),
            UpdateExpression: 'SET #s = :pending, lastClub = :fromName ADD version :one',
            // Tolerate legacy rows with no status attribute (absent ⇒ active); the
            // guard doubles as the dedup/race check against a concurrent clearance.
            ConditionExpression:
              'attribute_exists(sk) AND (attribute_not_exists(#s) OR #s = :active)',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':pending': 'clearance-pending',
              ':active': 'active',
              ':fromName': fromClub.name,
              ':one': 1,
            },
          },
        },
        {
          Update: {
            TableName: TABLE,
            Key: clubKey(tenant, fromClubId),
            UpdateExpression: 'ADD playerCount :one',
            ConditionExpression: 'attribute_exists(pk)',
            ExpressionAttributeValues: { ':one': 1 },
          },
        },
      ],
    }),
  );

  console.log(
    '\n✓ Clearance opened. The previous club approves it in the portal (or the union admin\n' +
      '  overrides) to return the player to active at the current club.\n' +
      '  ⚠ Do NOT reject this clearance: rejection flags a legitimately active player as\n' +
      "  'clearance-rejected' and there is no reactivation endpoint.",
  );
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
