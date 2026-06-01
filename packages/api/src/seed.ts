/**
 * Seed CLI — provision tenants.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/src/seed.ts [tenant ...]
 *   …                                                              [tenant ...] --demo
 *
 * Default: writes only each tenant's config (branding + deadline) — the cohort is
 * BLANK so real unions input their own clubs/series. `--demo` additionally loads
 * the sample clubs + series (for set/demo accounts). Idempotent (upserts).
 */
import { seedTenantConfig, seedDemoData, BRANDING, SEED_TENANTS } from './seed-core.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const demo = args.includes('--demo');
  const requested = args.filter((a) => !a.startsWith('--'));
  const toSeed = requested.length ? requested : SEED_TENANTS;

  for (const t of toSeed) {
    if (!BRANDING[t]) {
      console.warn(`no branding for tenant "${t}", skipping`);
      continue;
    }
    await seedTenantConfig(t);
    if (demo) {
      const { clubs, series } = await seedDemoData(t);
      console.log(`provisioned ${t} + demo data: ${clubs} clubs, ${series} series`);
    } else {
      console.log(`provisioned ${t} (blank cohort)`);
    }
  }
  console.log('seed complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
