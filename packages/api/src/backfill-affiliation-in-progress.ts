/**
 * One-off backfill: promote stuck `not_started` clubs to `in_progress`.
 *
 * Before this change the backend never wrote `affiliation: 'in_progress'` — clubs went
 * straight `not_started` → `complete` on submit. A club that filled its affiliation form
 * but only saved a draft (or saved the standalone Exco step) kept `affiliation:
 * 'not_started'` with a fully-populated `exco`, so the admin console showed "Pending /
 * Awaiting submission" next to a filled form (looked "out of sync"). The PATCH/exco
 * handlers now set `in_progress` on first save, but EXISTING records won't gain it until
 * their next save — which for an abandoned draft may be never. This backfills them once.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/src/backfill-affiliation-in-progress.ts <tenant>            (dry-run)
 *   sst shell --stage <stage> -- npx tsx packages/api/src/backfill-affiliation-in-progress.ts <tenant> --confirm
 *
 * Additive + idempotent: only `not_started` clubs with real draft evidence
 * (`hasAffiliationDraft`) are touched; `complete` and already-`in_progress` clubs are
 * never modified, and a bare signup-only or admin-override-only club stays `not_started`.
 * Run AFTER the API deploy so new saves already persist `in_progress`.
 */
import * as repo from './repo.js';
import { hasAffiliationDraft } from './catalogue.js';

async function main(): Promise<void> {
  const [tenant, flag] = process.argv.slice(2);
  if (!tenant) {
    console.error('usage: backfill-affiliation-in-progress <tenant> [--confirm]');
    process.exit(1);
  }
  const confirm = flag === '--confirm';

  const config = await repo.getTenantConfig(tenant);
  if (!config) {
    console.error(`tenant "${tenant}" not found`);
    process.exit(1);
  }

  const clubs = await repo.listClubs(tenant);
  const candidates = clubs.filter((c) => c.affiliation === 'not_started' && hasAffiliationDraft(c));
  if (candidates.length === 0) {
    console.log(`no draft-in-progress not_started clubs for "${tenant}" — nothing to do.`);
    return;
  }

  let updated = 0;
  for (const candidate of candidates) {
    // Re-read inside the loop so the version below makes updateClub a true
    // compare-and-swap — a concurrent rep save must conflict (and be retried by a
    // re-run), never be clobbered by a stale write.
    const club = await repo.getClub(tenant, candidate.id);
    if (!club) continue;
    if (club.affiliation !== 'not_started' || !hasAffiliationDraft(club)) continue;

    if (!confirm) {
      console.log(`[dry-run] ${club.id} (${club.name}): not_started → in_progress`);
      updated++;
      continue;
    }

    try {
      await repo.updateClub(
        tenant,
        club.id,
        { affiliation: 'in_progress', version: club.version },
        'backfill-affiliation-in-progress',
        new Date().toISOString(),
      );
      console.log(`${club.id}: not_started → in_progress`);
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
    console.log(`dry-run complete: ${updated} club(s) would change. Re-run with --confirm.`);
  } else {
    console.log(`backfill complete: ${updated} of ${candidates.length} club(s) updated.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
