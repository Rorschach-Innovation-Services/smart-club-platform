/**
 * One-off: issue transfer certificates for clearances resolved before certificates existed.
 *
 * Targets every approved / admin-override clearance in ONE tenant that has a real approval
 * timestamp and no certificate yet. Skipped, with the reason printed:
 *   - an override where the admin declined a certificate (certificateDeclined);
 *   - a clearance whose player is no longer at the destination club — the disposal flow is
 *     "override, then DELETE the player", so a missing destination row most likely means the
 *     transfer never happened, and a certificate must not say it did;
 *   - IMPORTED/BACKFILLED clearances (opened by backfill-registration-clearance.ts or
 *     backfill-declared-club-clearance.ts, recognised by their note) — unless
 *     --include-imported, which issues them with "Recorded from historical records · no digital
 *     approval on file" copy instead of an approval record.
 * Organic approvals from before `clubApprovedBy` was recorded get "Approving official not
 * recorded · <date>" — the issuer derives that from the clearance itself.
 *
 * Idempotent (issueCertificate returns an existing certificate), so a re-run only fills gaps.
 * Dry-run by default; pass --apply to write. The signer and QR origin are NOT SST-linked, so
 * set them explicitly (values from the stage's API Lambda env):
 *   AWS_PROFILE=medicoach AWS_REGION=af-south-1 \
 *   TABLE_NAME=<Data table> UPLOADS_BUCKET=<Uploads bucket> \
 *   CERT_SIGNING_KEY_ARN=<CertSigningKey arn> VERIFY_BASE_URL=<https://platform host> \
 *   npx tsx packages/api/src/backfill-clearance-certificates.ts <tenant> [--apply] [--include-imported]
 */
import { pathToFileURL } from 'node:url';
import * as repo from './repo.js';
import { issueCertificate, isCertifiable } from './certificates/issue.js';
import type { PlayerClearance } from './types.js';

/** Notes written by the two clearance backfills (kept in sync with those scripts). */
export function isImportedClearance(c: Pick<PlayerClearance, 'note'>): boolean {
  const note = c.note ?? '';
  return (
    note.startsWith('Backfilled:') ||
    note.includes('registered elsewhere before transfers were being tracked')
  );
}

type Plan = { clearance: PlayerClearance; historical: boolean };
type Skip = { clearance: PlayerClearance; reason: string };

async function classify(tenant: string, includeImported: boolean) {
  const plan: Plan[] = [];
  const skipped: Skip[] = [];
  let alreadyIssued = 0;
  for (const c of await repo.listAllClearances(tenant)) {
    if (!isCertifiable(c)) continue;
    if (c.certificateMeta) {
      alreadyIssued++;
      continue;
    }
    const approvedAt = c.status === 'admin-override' ? c.adminOverrideAt : c.clubApprovedAt;
    if (!approvedAt) {
      skipped.push({ clearance: c, reason: 'no approval timestamp on record' });
      continue;
    }
    if (c.certificateDeclined) {
      skipped.push({ clearance: c, reason: 'override declined a certificate' });
      continue;
    }
    const imported = isImportedClearance(c);
    if (imported && !includeImported) {
      skipped.push({ clearance: c, reason: 'imported/backfilled (use --include-imported)' });
      continue;
    }
    if (!(await repo.getPlayer(tenant, c.toClubId, c.playerNaturalKey))) {
      skipped.push({ clearance: c, reason: 'player no longer at destination (likely disposal)' });
      continue;
    }
    plan.push({ clearance: c, historical: imported });
  }
  return { plan, skipped, alreadyIssued };
}

const describe = (c: PlayerClearance) =>
  `${c.playerName} · ${c.fromClubName} → ${c.toClubName} · ${c.status} · ${c.id}`;

async function main() {
  const args = process.argv.slice(2);
  const tenant = args.find((a) => !a.startsWith('-'));
  const apply = args.includes('--apply');
  const includeImported = args.includes('--include-imported');
  if (!tenant) {
    throw new Error(
      'usage: backfill-clearance-certificates <tenant> [--apply] [--include-imported]',
    );
  }
  if (!(await repo.getTenantConfig(tenant))) throw new Error(`tenant not found: ${tenant}`);

  const { plan, skipped, alreadyIssued } = await classify(tenant, includeImported);
  console.log(`Tenant ${tenant}: ${alreadyIssued} already certified`);
  console.log(`\nTo issue (${plan.length}):`);
  for (const p of plan) {
    const copy = p.historical
      ? 'historical copy'
      : p.clearance.status === 'admin-override'
        ? 'union override'
        : p.clearance.clubApprovedBy
          ? `approved by ${p.clearance.clubApprovedBy}`
          : 'approving official not recorded';
    console.log(`  ${describe(p.clearance)}  [${copy}]`);
  }
  console.log(`\nSkipped (${skipped.length}):`);
  for (const s of skipped) console.log(`  ${describe(s.clearance)}  — ${s.reason}`);

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to issue.');
    return;
  }

  let issued = 0;
  let existing = 0;
  const failed: Array<{ clearance: PlayerClearance; err: unknown }> = [];
  for (const p of plan) {
    try {
      const { meta, created } = await issueCertificate(
        tenant,
        p.clearance.fromClubId,
        p.clearance.id,
        { historical: p.historical },
      );
      if (created) issued++;
      else existing++;
      console.log(`  ✓ ${meta.serial}  ${describe(p.clearance)}`);
    } catch (err) {
      failed.push({ clearance: p.clearance, err });
      console.error(`  ✗ ${describe(p.clearance)}:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`\nIssued ${issued}, already present ${existing}, failed ${failed.length}.`);
  if (failed.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
