/**
 * One-off admin tool: reconcile FALSE "off-system previous club" alerts.
 *
 * The register flow raises an off-system-alert whenever a player picked no on-system club
 * from the dropdown but typed a free-text ("Other") previous club. Historically it never
 * checked whether that typed name actually names a club ON the system — so a real club typed
 * by hand (e.g. "West CC" typed instead of picked) was misfiled as off-system. The register
 * handler now suppresses that at write time; this script cleans up the rows written before
 * the fix.
 *
 * For each OPEN off-system-alert whose `typedPreviousClub` EXACTLY matches (trim+lowercase)
 * a club on the system, it flips the review to resolved/'acknowledged' via the same
 * version-guarded path the admin "Mark reviewed" action uses — NOT a hard delete, so the
 * audit trail (that the alert existed and was reconciled) is preserved. It opens no
 * clearance and touches no player row.
 *
 * Dry-run by default; prints per match: player, typed club, the matched on-system club
 * (name + id), and the review's createdAt — so you can SKIP any match that looks like a
 * genuinely-off-system club that only later collided with a same-named club that joined
 * afterwards. Skip specific reviews by passing their ids to `--exclude=<id,id,…>` (the
 * ids are printed in the dry run). Pass --confirm to write. Point at prod with:
 *   AWS_PROFILE=medicoach AWS_REGION=af-south-1 \
 *   TABLE_NAME=dolphins-smart-club-prod-DataTable-bbxuffsw \
 *   npx tsx packages/api/src/reconcile-off-system-reviews.ts <tenant> [--confirm] [--exclude=<id,…>]
 */
import * as repo from './repo.js';

const RESOLVED_BY = 'reconcile-script';

async function main() {
  const argv = process.argv.slice(2);
  const [tenant] = argv.filter((a) => !a.startsWith('--'));
  const confirm = argv.includes('--confirm');
  const excludeArg = argv.find((a) => a.startsWith('--exclude='));
  const excluded = new Set(
    (excludeArg?.slice('--exclude='.length) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (!tenant) {
    throw new Error(
      'usage: reconcile-off-system-reviews <tenant> [--confirm] [--exclude=<id,id,…>]',
    );
  }

  const clubs = await repo.listClubs(tenant);
  const byName = new Map(clubs.map((c) => [c.name.trim().toLowerCase(), c]));

  const reviews = await repo.listAllReviews(tenant);
  const matches = reviews.flatMap((r) => {
    if (r.kind !== 'off-system-alert' || r.status !== 'open' || !r.typedPreviousClub) return [];
    if (excluded.has(r.id)) return [];
    const club = byName.get(r.typedPreviousClub.trim().toLowerCase());
    return club ? [{ r, club }] : [];
  });

  if (matches.length === 0) {
    console.log(`No open off-system alerts name an on-system club in tenant "${tenant}".`);
    return;
  }

  console.log(
    `Reconcile off-system alerts that name an on-system club (tenant "${tenant}"):\n` +
      `  ${matches.length} open alert(s) match — will be resolved as 'acknowledged'.\n`,
  );
  for (const { r, club } of matches) {
    console.log(
      `  • ${r.playerName} · typed "${r.typedPreviousClub}" → on-system club ` +
        `"${club.name}" (${club.id}) · registered into ${r.destClubName} · raised ${r.createdAt}` +
        `\n    review id: ${r.id}`,
    );
  }

  if (!confirm) {
    console.log(
      '\nDRY RUN — nothing written. Re-run with --confirm to resolve these alerts' +
        ' (or --exclude=<id,…> to skip specific reviews).',
    );
    return;
  }

  const at = new Date().toISOString();
  let ok = 0;
  for (const { r } of matches) {
    try {
      await repo.resolveReview(tenant, r.destClubId, r.id, {
        resolution: 'acknowledged',
        at,
        by: RESOLVED_BY,
      });
      ok += 1;
      console.log(`  ✓ resolved ${r.playerName} (${r.id})`);
    } catch (err) {
      console.error(
        `  ✗ FAILED ${r.playerName} (${r.id}): ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  console.log(`\n✓ Resolved ${ok}/${matches.length} alert(s).`);
  // Non-zero exit on partial failure so a wrapping runbook/CI step can detect it without
  // scraping stdout.
  if (ok < matches.length) process.exit(1);
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
