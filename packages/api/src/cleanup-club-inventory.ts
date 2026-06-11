/**
 * One-off cleanup after the Club Inventory document was dropped from the
 * 2026/27 requirements (removed from REQUIRED_DOCS). Clubs that uploaded one
 * keep an unreachable `docs.clubInventory` / `docMeta.clubInventory` entry and
 * the PDF stays in the uploads bucket — orphaned PII (POPIA data-minimisation,
 * see docs/guides/popia-compliance.md). This deletes the S3 object and strips
 * both keys from each affected club record.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/src/cleanup-club-inventory.ts <tenant>            (dry-run)
 *   sst shell --stage <stage> -- npx tsx packages/api/src/cleanup-club-inventory.ts <tenant> --confirm
 *
 * Idempotent. Run a day or two AFTER the frontend deploy — a stale SPA tab
 * opened pre-deploy can still upload to the key (the doc routes accept any key).
 */
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import * as repo from './repo.js';
import { uploadsBucket } from './env.js';

const DOC_KEY = 'clubInventory';

/** Local-dev uploads have no real S3 object behind them — never call S3 for these. */
const isS3Key = (key: string) => !key.startsWith('local/');

async function main(): Promise<void> {
  const [tenant, flag] = process.argv.slice(2);
  if (!tenant) {
    console.error('usage: cleanup-club-inventory <tenant> [--confirm]');
    process.exit(1);
  }
  const confirm = flag === '--confirm';
  const bucket = uploadsBucket();

  const config = await repo.getTenantConfig(tenant);
  if (!config) {
    console.error(`tenant "${tenant}" not found`);
    process.exit(1);
  }

  const clubs = await repo.listClubs(tenant);
  const affected = clubs.filter((c) => DOC_KEY in (c.docs ?? {}) || DOC_KEY in (c.docMeta ?? {}));
  if (affected.length === 0) {
    console.log(`no ${DOC_KEY} records found for "${tenant}" — nothing to do.`);
    return;
  }

  const s3 = new S3Client({});
  let updated = 0;
  for (const stale of affected) {
    // Re-read inside the loop so the strip is computed against the live record
    // and the version below makes updateClub a true compare-and-swap — a rep's
    // concurrent upload must conflict (and be retried), never be clobbered.
    const club = await repo.getClub(tenant, stale.id);
    if (!club) continue;
    const docMeta = club.docMeta ?? {};
    if (!(DOC_KEY in (club.docs ?? {})) && !(DOC_KEY in docMeta)) continue;
    const meta = docMeta[DOC_KEY] as { objectKey?: string } | undefined;
    const objectKey = meta?.objectKey && isS3Key(meta.objectKey) ? meta.objectKey : undefined;

    if (!confirm) {
      console.log(
        `[dry-run] ${club.id} (${club.name}): would strip ${DOC_KEY}` +
          (objectKey ? ` and delete s3://${bucket}/${objectKey}` : ' (no S3 object to delete)'),
      );
      updated++;
      continue;
    }

    // Delete the PDF first so a failed record write leaves a re-runnable state
    // (stale key, no object) rather than a record pointing at nothing.
    if (objectKey) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
        console.log(`${club.id}: deleted s3 object ${objectKey}`);
      } catch (err) {
        console.warn(`${club.id}: failed to delete ${objectKey} — skipping record`, err);
        continue;
      }
    }

    const { [DOC_KEY]: _drop, ...docs } = club.docs ?? {};
    const { [DOC_KEY]: _dropMeta, ...restMeta } = docMeta;
    try {
      // updateClub shallow-merges: the patched docs/docMeta replace the stored
      // values wholesale, which is exactly how the stripped keys come off.
      await repo.updateClub(
        tenant,
        club.id,
        { docs, docMeta: restMeta, version: club.version },
        'cleanup-club-inventory',
        new Date().toISOString(),
      );
      console.log(`${club.id}: stripped ${DOC_KEY} from docs/docMeta`);
      updated++;
    } catch (err) {
      if (err instanceof repo.VersionConflictError) {
        console.warn(`${club.id}: concurrent write detected — skipped, re-run to pick it up`);
        continue;
      }
      throw err;
    }
  }

  if (!confirm) {
    console.log(`dry-run complete: ${updated} club(s) affected. Re-run with --confirm.`);
  } else {
    console.log(`cleanup complete: ${updated} of ${affected.length} club(s) updated.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
