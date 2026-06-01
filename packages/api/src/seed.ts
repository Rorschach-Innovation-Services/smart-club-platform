/**
 * Seed script — populates tenants from the snapshots in ./seed-data.
 *
 * Run under `sst shell` so the table name resolves:
 *   sst shell --stage dev -- npx tsx packages/api/src/seed.ts
 *
 * Idempotent: tenant config, clubs, and series are upserted. Player counts are
 * derived from registrations, so seeded clubs show 0 players until people register
 * (see docs/architecture/0005 and the plan). Branding lives here, not in the SPA.
 */
import { readFileSync } from 'node:fs';
import * as repo from './repo.js';
import type { Club, Series, TenantConfig } from './types.js';

interface Snapshot {
  submissionDeadline: string;
  knownClubs: unknown[];
  clubs: Club[];
  series: Series[];
}

// Shared color palette (Dolphins and Lions use the same green theme today).
const COLORS = {
  '--navy': '#1B2A4A',
  '--navy-light': '#2E4070',
  '--teal': '#1D9E75',
  '--green': '#1D9E75',
  '--gold': '#C8A84B',
  '--coral': '#D85A30',
};

const BRANDING: Record<string, TenantConfig['branding']> = {
  dolphins: {
    name: 'Hollywoodbets Dolphins',
    title: 'Dolphins Pipeline',
    logoUrl: '/dolphins-pipeline-logo.png',
    colors: COLORS,
    copy: {
      welcome: 'Welcome to Dolphins Pipeline',
      eyebrow: 'Dolphins Cricket Services · 2026 / 27 Season',
      office: 'Dolphins office',
      admin: 'Administrator · Dolphins',
      support: 'Cricket Services · support@dolphinscricket.co.za',
      footer: 'Powered by Medicoach',
    },
  },
  lions: {
    name: 'DP World Lions',
    title: 'Lions Smart Club',
    logoUrl: '/lions-logo.svg',
    colors: COLORS,
    copy: {
      welcome: 'Welcome — choose your profile',
      eyebrow: 'KZNCU & EMCU · 2026 / 27 Season',
      office: 'Lions office',
      admin: 'Administrator · Lions',
      support: 'Cricket Services · support@lionscricket.co.za',
      footer: 'Powered by Medicoach',
    },
  },
};

function loadSnapshot(tenant: string): Snapshot {
  const path = new URL(`../seed-data/${tenant}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
}

async function seedTenant(tenant: string): Promise<void> {
  const snap = loadSnapshot(tenant);
  const config: TenantConfig = {
    tenant,
    branding: BRANDING[tenant],
    submissionDeadline: snap.submissionDeadline,
    knownClubs: snap.knownClubs,
  };
  await repo.putTenantConfig(config);

  for (const club of snap.clubs) {
    await repo.putClub(tenant, { ...club, version: 1 });
  }
  for (const series of snap.series) {
    await repo.putSeries(tenant, { ...series, version: 1 });
  }
  console.log(
    `seeded ${tenant}: ${snap.clubs.length} clubs, ${snap.series.length} series, deadline ${snap.submissionDeadline}`,
  );
}

async function main(): Promise<void> {
  const tenants = process.argv.slice(2);
  const toSeed = tenants.length ? tenants : ['dolphins', 'lions'];
  for (const t of toSeed) {
    if (!BRANDING[t]) {
      console.warn(`no branding for tenant "${t}", skipping`);
      continue;
    }
    await seedTenant(t);
  }
  console.log('seed complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
