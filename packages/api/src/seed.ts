/**
 * Seed CLI — populates tenants from ../seed-data via the shared seed-core logic.
 *
 *   sst shell --stage dev -- npx tsx packages/api/src/seed.ts [tenant ...]
 *
 * Idempotent (upserts). Player counts derive from registrations, so seeded clubs
 * show 0 players until people register (see docs/architecture/0005).
 */
import { seedTenant, BRANDING, SEED_TENANTS } from './seed-core.js';

async function main(): Promise<void> {
  const requested = process.argv.slice(2);
  const toSeed = requested.length ? requested : SEED_TENANTS;
  for (const t of toSeed) {
    if (!BRANDING[t]) {
      console.warn(`no branding for tenant "${t}", skipping`);
      continue;
    }
    const { clubs, series } = await seedTenant(t);
    console.log(`seeded ${t}: ${clubs} clubs, ${series} series`);
  }
  console.log('seed complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
