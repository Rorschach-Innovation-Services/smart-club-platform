/**
 * Seed CLI — provision tenants.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/src/seed.ts [tenant ...]
 *   …                                                              [tenant ...] --demo
 *   …                                                              [tenant ...] --leagues-only [--force]
 *   …                                                              [tenant ...] --merge-leagues
 *
 * Default: writes only each tenant's config (branding + deadline) — the cohort is
 * BLANK so real unions input their own clubs/series. `--demo` additionally loads
 * the sample clubs + series (for set/demo accounts). Idempotent (upserts).
 *
 * `--leagues-only` is a MANUAL one-shot repair (not a post-deploy step): it backfills only
 * the league catalogue from the snapshot, leaving branding/deadline/adminCount untouched,
 * for a stage whose CONFIG predates the catalogue. It skips a populated catalogue, refuses
 * to silently refill an intentionally-emptied one (use `--force`), and errors loudly if a
 * tenant has no CONFIG row at all (run a full seed for that tenant first).
 *
 * `--merge-leagues` is the ADDITIVE propagation step for an already-populated tenant: it
 * appends only the snapshot leagues whose key is missing (preserving existing/custom leagues),
 * so a league newly added to the snapshot reaches a live stage without replacing its catalogue.
 * Idempotent and prod-safe (never clobbers). Use this — not `--leagues-only --force` — when the
 * catalogue is already populated.
 */
import {
  seedTenantConfig,
  seedDemoData,
  seedLeaguesOnly,
  mergeSnapshotLeagues,
  BRANDING,
  SEED_TENANTS,
} from './seed-core.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const demo = args.includes('--demo');
  const leaguesOnly = args.includes('--leagues-only');
  const mergeLeaguesFlag = args.includes('--merge-leagues');
  const force = args.includes('--force');
  if (force && !leaguesOnly) console.warn('--force has no effect without --leagues-only; ignoring');
  const requested = args.filter((a) => !a.startsWith('--'));
  const toSeed = requested.length ? requested : SEED_TENANTS;

  for (const t of toSeed) {
    if (!BRANDING[t]) {
      console.warn(`no branding for tenant "${t}", skipping`);
      continue;
    }
    if (mergeLeaguesFlag) {
      const r = await mergeSnapshotLeagues(t);
      switch (r.status) {
        case 'config-missing':
          console.error(`ERROR ${t}: no CONFIG row — run a full seed (\`seed.ts ${t}\`) first`);
          process.exitCode = 1;
          break;
        case 'up-to-date':
          console.log(`up to date ${t}: ${r.count} leagues (nothing to add)`);
          break;
        case 'merged':
          console.log(
            `merged ${t}: +${r.added.length} (${r.added.join(', ')}) → ${r.count} leagues`,
          );
          break;
        case 'raced':
          console.log(`${t}: concurrent config change — re-run (idempotent)`);
          break;
      }
      continue;
    }
    if (leaguesOnly) {
      const r = await seedLeaguesOnly(t, force);
      switch (r.status) {
        case 'config-missing':
          console.error(`ERROR ${t}: no CONFIG row — run a full seed (\`seed.ts ${t}\`) first`);
          process.exitCode = 1;
          break;
        case 'already-populated':
          console.log(`skipped ${t}: catalogue already populated (${r.count})`);
          break;
        case 'empty-skipped':
          console.log(
            `skipped ${t}: leagues present but empty — possibly intentional; re-run with --force to overwrite`,
          );
          break;
        case 'backfilled':
          console.log(`backfilled ${t}: ${r.count} leagues (config otherwise untouched)`);
          break;
      }
      continue;
    }
    const leagues = await seedTenantConfig(t);
    if (demo) {
      const { clubs, series } = await seedDemoData(t);
      console.log(
        `provisioned ${t} + demo data: ${clubs} clubs, ${series} series (${leagues} leagues)`,
      );
    } else {
      console.log(`provisioned ${t} (blank cohort, ${leagues} leagues)`);
    }
  }
  console.log('seed complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
