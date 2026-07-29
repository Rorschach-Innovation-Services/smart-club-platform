/**
 * One-off: rewrite the `note` on the clearances opened by the 29 Jul 2026 declared-club
 * backfill so it reads for the SOURCE CLUB REP, who is the person it is rendered to.
 *
 * The original note was written for us, not them:
 *   "Backfilled: the declared previous club was on the system but had no roster record, so no
 *    clearance was opened at registration."
 * club.tsx renders `note` verbatim on the rep's pending card, so a Harlequins rep opening their
 * portal sees an internal changelog line explaining nothing they can act on — while being asked
 * to approve a transfer for someone they have no record of.
 *
 * Touches ONLY the `note` attribute, on BOTH the canonical and the mirror item, and only where
 * the note still matches the original text and the clearance is still `pending`. No status, no
 * roster, no counts. A clearance a club has already actioned is left alone — its note is part
 * of a resolved record.
 *
 * Dry-run by default; pass --confirm to write. Point at prod with:
 *   AWS_PROFILE=medicoach AWS_REGION=af-south-1 \
 *   TABLE_NAME=dolphins-smart-club-prod-DataTable-bbxuffsw \
 *   npx tsx packages/api/src/patch-backfill-clearance-notes.ts <tenant> [--confirm]
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import * as repo from './repo.js';
import { clearanceKey, inboundClearanceKey } from './keys.js';
import { tableName } from './env.js';
import type { PlayerClearance } from './types.js';

const TABLE = tableName();
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/** Exact text the backfill wrote — the match target, so this can only ever hit its own rows. */
const OLD_NOTE =
  'Backfilled: the declared previous club was on the system but had no roster record, ' +
  'so no clearance was opened at registration.';

/** Kept in sync with backfill-declared-club-clearance.ts's `note()`. */
const newNote = (fromClubName: string) =>
  `${fromClubName} has no roster record of this player, and they registered elsewhere before ` +
  `transfers were being tracked — so this clearance is being opened now, after the fact. If ` +
  `they did play there, ${fromClubName} can approve it as usual. If they did not, the Union ` +
  `office can reallocate it to the club they actually left — declining is deliberately not an ` +
  `option, since it would permanently flag a legitimately registered player.`;

async function main() {
  const [tenant] = process.argv.slice(2);
  const confirm = process.argv.includes('--confirm');
  if (!tenant || tenant.startsWith('-')) {
    throw new Error('usage: patch-backfill-clearance-notes <tenant> [--confirm]');
  }

  const clubs = await repo.listClubs(tenant);
  const targets: PlayerClearance[] = [];
  for (const club of clubs) {
    for (const c of await repo.listClearancesForSource(tenant, club.id)) {
      if (c.note === OLD_NOTE && c.status === 'pending') targets.push(c);
    }
  }

  console.log(
    `Clearances still carrying the original backfill note (pending only): ${targets.length}\n`,
  );
  for (const c of targets) {
    console.log(`  ${c.playerName}  ${c.fromClubName} → ${c.toClubName}`);
  }
  if (!targets.length) return;

  console.log(
    `\nNew note, e.g. for ${targets[0].fromClubName}:\n  "${newNote(targets[0].fromClubName)}"`,
  );

  if (!confirm) {
    console.log('\nDRY RUN — nothing written. Re-run with --confirm to rewrite these notes.');
    return;
  }

  let ok = 0;
  const failed: string[] = [];
  for (const c of targets) {
    const note = newNote(c.fromClubName);
    try {
      // Canonical and mirror both carry the note (clearanceItems spreads the whole object), and
      // the rep reads whichever their portal queries — so both must move together. Guarded on
      // the note still being the original, which also makes a re-run a no-op.
      for (const Key of [
        clearanceKey(tenant, c.fromClubId, c.id),
        inboundClearanceKey(tenant, c.toClubId, c.id),
      ]) {
        await ddb.send(
          new UpdateCommand({
            TableName: TABLE,
            Key,
            UpdateExpression: 'SET note = :new',
            ConditionExpression: 'attribute_exists(sk) AND note = :old',
            ExpressionAttributeValues: { ':new': note, ':old': OLD_NOTE },
          }),
        );
      }
      ok++;
      console.log(`  ✓ ${c.playerName}`);
    } catch (err: unknown) {
      failed.push(`${c.playerName}: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`  ✗ ${c.playerName}`);
    }
  }
  console.log(`\n✓ ${ok} note(s) rewritten, ${failed.length} failed.`);
  for (const f of failed) console.error(`  ${f}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
