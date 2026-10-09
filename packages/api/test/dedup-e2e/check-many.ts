/**
 * Consistency of a many:<n> table after an interrupted / re-run confirm:
 *   tsx test/dedup-e2e/check-many.ts <manifest.json> <deleted-nks.json>
 * Per pair: merged (slug gone, survivor carries the doc, object on disk, key recorded),
 * untouched, half-done (survivor filled, slug still live), or BROKEN (slug gone but not recorded,
 * or the survivor's doc object missing).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const [manifestPath, deletedPath] = process.argv.slice(2);
const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  pairs: Array<{ sha: string; slug: string; clubId: string; doc: string }>;
};
const deleted = new Set(
  existsSync(deletedPath)
    ? (JSON.parse(readFileSync(deletedPath, 'utf8')) as Array<{ naturalKey: string }>).map(
        (d) => d.naturalKey,
      )
    : [],
);
const repo = await import('../../src/repo.js');
const tally: Record<string, number> = {};
const broken: string[] = [];
for (const p of m.pairs) {
  const s = await repo.getPlayer('dolphins', p.clubId, p.sha);
  const slug = await repo.getPlayer('dolphins', p.clubId, p.slug);
  const docKey = s?.idDocMeta?.objectKey;
  const docOnDisk = docKey
    ? existsSync(path.join(process.env.LOCAL_UPLOADS_DIR!, docKey.slice('local/'.length)))
    : false;
  let state: string;
  if (!s) state = 'BROKEN:survivor-missing';
  else if (!slug && docKey && docOnDisk && deleted.has(p.slug) && s.lastClub) state = 'merged';
  else if (!slug && !deleted.has(p.slug)) state = 'BROKEN:deleted-not-recorded';
  else if (!slug && (!docKey || !docOnDisk)) state = 'BROKEN:doc-lost';
  else if (slug && docKey) state = 'half-done(filled, stale live)';
  else if (slug && !docKey) state = 'untouched';
  else state = 'other';
  tally[state] = (tally[state] ?? 0) + 1;
  if (state.startsWith('BROKEN')) broken.push(`${p.slug}: ${state}`);
}
console.log(JSON.stringify({ tally, broken: broken.slice(0, 10) }, null, 1));
