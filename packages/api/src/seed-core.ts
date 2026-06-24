/**
 * Reusable tenant-seeding logic (no top-level execution), shared by the seed CLI
 * (seed.ts) and the local dev server (local/server.ts). Tenants are provisioned
 * BLANK (config only); sample clubs/series are opt-in demo data. Branding lives here.
 */
import { readFileSync } from 'node:fs';
import * as repo from './repo.js';
import type { Club, Series, TenantConfig, League } from './types.js';

interface Snapshot {
  submissionDeadline: string;
  knownClubs: unknown[];
  clubs: Club[];
  series: Series[];
  leagues?: League[];
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

export const BRANDING: Record<string, TenantConfig['branding']> = {
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

export const SEED_TENANTS = Object.keys(BRANDING);

function loadSnapshot(tenant: string): Snapshot {
  const path = new URL(`../seed-data/${tenant}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
}

/**
 * Provision a tenant: write its config (branding + deadline + league catalogue).
 * The COHORT (clubs/series) starts BLANK — real unions onboard their own. But the
 * league catalogue is real, union-specific REFERENCE data, so it's provisioned here
 * (from the tenant's snapshot) and ships in production; tenants without a defined
 * catalogue (snapshot `leagues: []`) start empty for the admin to build. `knownClubs`
 * is empty (no hardcoded onboarding suggestions). Returns the # of leagues seeded.
 */
export async function seedTenantConfig(tenant: string): Promise<number> {
  const branding = BRANDING[tenant];
  if (!branding) throw new Error(`no branding for tenant "${tenant}"`);
  const snap = loadSnapshot(tenant);
  const leagues = snap.leagues ?? [];
  const config: TenantConfig = {
    tenant,
    branding,
    submissionDeadline: snap.submissionDeadline,
    knownClubs: [],
    leagues,
  };
  await repo.putTenantConfig(config);
  return leagues.length;
}

/**
 * Outcome of a leagues-only backfill, kept tri-state on purpose: a single boolean would
 * conflate "already populated" (healthy) with "no CONFIG row" (broken tenant) and give the
 * operator a false all-clear. The CLI maps each case to distinct output / exit code.
 */
export type LeaguesBackfillResult =
  | { status: 'config-missing' }
  | { status: 'already-populated'; count: number }
  | { status: 'empty-skipped'; count: number }
  | { status: 'backfilled'; count: number };

/**
 * Repair ONLY a tenant's league catalogue from its snapshot, without touching branding,
 * deadline, knownClubs, or adminCount — a manual one-shot repair for a stage whose CONFIG
 * predates the catalogue (NOT an automatic post-deploy step). Reads first to decide policy:
 *
 *   • no CONFIG row     → 'config-missing' (caller surfaces a loud error; run full seed)
 *   • leagues non-empty → 'already-populated' (idempotent no-op)
 *   • leagues `[]`      → 'empty-skipped' unless `force` — an empty catalogue is a valid
 *                         admin choice (PUT /tenant/config accepts it), so we don't silently
 *                         refill it; `force` overrides for a deliberate repair
 *   • leagues absent    → 'backfilled' (the "never seeded" case)
 *
 * The write itself is race-guarded (see repo.backfillLeagues) so a concurrent admin save
 * between our read and write can't be clobbered.
 */
export async function seedLeaguesOnly(
  tenant: string,
  force = false,
): Promise<LeaguesBackfillResult> {
  const current = await repo.getTenantConfig(tenant);
  if (!current) return { status: 'config-missing' };
  const existing = current.leagues;
  if (Array.isArray(existing) && existing.length > 0)
    return { status: 'already-populated', count: existing.length };
  if (Array.isArray(existing) && existing.length === 0 && !force)
    return { status: 'empty-skipped', count: 0 };
  const snapLeagues = loadSnapshot(tenant).leagues ?? [];
  const written = await repo.backfillLeagues(tenant, snapLeagues, force);
  if (written) return { status: 'backfilled', count: snapLeagues.length };
  // Guard fired between our read and our write — a concurrent admin save (or a deleted
  // CONFIG) changed the row. Don't report a backfill that didn't happen: re-read and tell
  // the truth. Non-force ⇒ the catalogue became non-empty; force ⇒ the only way the guard
  // (attribute_exists(pk)) fails is the row vanished.
  const after = await repo.getTenantConfig(tenant);
  if (!after) return { status: 'config-missing' };
  return { status: 'already-populated', count: after.leagues?.length ?? 0 };
}

export type LeaguesMergeResult =
  | { status: 'config-missing' }
  | { status: 'up-to-date'; count: number }
  | { status: 'merged'; added: string[]; count: number }
  | { status: 'raced' };

/**
 * Additively merge a tenant's snapshot leagues into its existing catalogue: append only the
 * snapshot leagues whose `key` isn't already present (in snapshot order), preserving every
 * existing/custom league and order. Idempotent — re-running once the keys are present is a
 * no-op ('up-to-date'). Safe for prod: it never replaces, reorders, or drops a league. The
 * write is race-guarded (see repo.mergeLeagues) on the catalogue size the caller read, so a
 * concurrent admin save returns 'raced' (operator re-runs — still idempotent) rather than
 * clobbering. Unlike seedLeaguesOnly's --force this is the additive propagation path for a
 * stage whose CONFIG predates a newly-seeded league.
 */
export async function mergeSnapshotLeagues(tenant: string): Promise<LeaguesMergeResult> {
  const current = await repo.getTenantConfig(tenant);
  if (!current) return { status: 'config-missing' };
  const existing = current.leagues ?? [];
  const have = new Set(existing.map((l) => l.key));
  const toAdd = (loadSnapshot(tenant).leagues ?? []).filter((l) => !have.has(l.key));
  if (toAdd.length === 0) return { status: 'up-to-date', count: existing.length };
  const merged = [...existing, ...toAdd];
  const written = await repo.mergeLeagues(tenant, merged, existing.length);
  if (written) return { status: 'merged', added: toAdd.map((l) => l.key), count: merged.length };
  return { status: 'raced' };
}

/**
 * Opt-in demo COHORT data: load the snapshot's sample clubs + series into a tenant
 * (for local dev / set demo accounts). Provisioning (config, incl. leagues) must run
 * first. Leagues are NOT demo data — they're provisioned in seedTenantConfig.
 */
export async function seedDemoData(tenant: string): Promise<{ clubs: number; series: number }> {
  const snap = loadSnapshot(tenant);
  for (const club of snap.clubs) {
    // Flag snapshot clubs as demo so illustrative-only UI (e.g. the seeded
    // communication-log events) shows for them but not for real onboarded clubs.
    await repo.putClub(tenant, { ...club, demo: true, version: 1 });
  }
  for (const series of snap.series) {
    await repo.putSeries(tenant, { ...series, version: 1 });
  }
  return { clubs: snap.clubs.length, series: snap.series.length };
}
