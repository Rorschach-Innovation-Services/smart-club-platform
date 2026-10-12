/**
 * What an operator would have to hand-roll to undo a merge from the CLI's backup file (no
 * restore command ships): re-create each backed-up row that is gone, via repo.createPlayer.
 *   tsx test/dedup-e2e/restore.ts <backup.json> <groupId>
 * Reports dangling ID-document references (objects deleted by the merge) and VETAFFIL drift.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PlayerRegistration } from '../../src/types.js';

const [backupPath, groupId] = process.argv.slice(2);
const backup = JSON.parse(await readFile(backupPath, 'utf8')) as {
  tenant: string;
  groups: Array<{ id: string; rows: PlayerRegistration[] }>;
};
const repo = await import('../../src/repo.js');
const group = backup.groups.find((g) => g.id === groupId);
if (!group) throw new Error(`no group ${groupId} in backup`);
for (const row of group.rows) {
  const live = await repo.getPlayer(backup.tenant, row.clubId, row.naturalKey);
  if (live) {
    console.log(`live   ${row.naturalKey.slice(0, 12)} — left as is (fill NOT reverted)`);
    continue;
  }
  await repo.createPlayer(backup.tenant, row);
  const doc = row.idDocMeta?.objectKey;
  const file = doc ? path.join(process.env.LOCAL_UPLOADS_DIR!, doc.slice('local/'.length)) : null;
  console.log(
    `restored ${row.naturalKey.slice(0, 12)} at ${row.clubId}` +
      (doc ? ` — idDoc ${existsSync(file!) ? 'present' : 'DANGLING (object deleted)'}` : '') +
      (row.veteransClubId ? ` — veteransClubId ${row.veteransClubId} (VETAFFIL not rewritten)` : ''),
  );
}
