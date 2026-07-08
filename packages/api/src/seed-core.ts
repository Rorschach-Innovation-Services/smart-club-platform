/**
 * Reusable tenant-seeding logic (no top-level execution), shared by the seed CLI
 * (seed.ts) and the local dev server (local/server.ts). Tenants are provisioned
 * BLANK (config only); sample clubs/series are opt-in demo data.
 *
 * BRANDING below is DEV/DEMO SEED DATA ONLY: the DynamoDB CONFIG rows are the
 * tenant registry's source of truth (created/edited via the operator portal's
 * /platform routes). The default seed path therefore create-if-absent's a config
 * and never overwrites a live row — `--force` is the explicit escape hatch.
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
// The full token family the app CSS keys off (mirrors the dolphins values that
// lived in index.html:13-67 before the neutral-default sweep). Legacy alias
// tokens (--navy/--teal/--gold/--coral) are NOT seeded — index.html routes them
// through this family, so overriding only the family keeps the aliases coherent.
const COLORS = {
  '--green': '#0E3529',
  '--green-mid': '#215F47',
  '--green-bright': '#4B8A6C',
  '--green-pale': '#E8F0EB',
  '--cream': '#E7DDC6',
  '--gold-warm': '#B89B4A',
};

export const BRANDING: Record<string, TenantConfig['branding']> = {
  dolphins: {
    name: 'Hollywoodbets Dolphins',
    title: 'Dolphins Pipeline',
    logoUrl: '/dolphins-pipeline-logo.png',
    // Kingsmead hero imagery is dolphins branding, not app chrome — the app CSS
    // reads var(--hero-image) with a neutral gradient default.
    colors: { ...COLORS, '--hero-image': "url('/venues/kingsmead-stadium.jpg')" },
    copy: {
      welcome: 'Welcome to Dolphins Pipeline',
      eyebrow: 'Dolphins Cricket Services · 2026 / 27 Season',
      office: 'Dolphins office',
      admin: 'Administrator · Dolphins',
      support: 'Cricket Services · support@dolphinscricket.co.za',
      footer: 'Powered by Medicoach',
      orgShort: 'Dolphins',
      cohortName: 'Dolphins Pipeline cohort',
      heroTitle: 'From your club to the Dolphins.',
      heroBlurb:
        'Affiliated clubs join the Hollywoodbets Dolphins ecosystem — fixtures, talent ID, clinical data and franchise readiness, all in one place.',
      crumbRoot: 'Dolphins',
    },
  },
  lions: {
    name: 'DP World Lions',
    title: 'Lions Smart Club',
    logoUrl: '/lions-logo.svg',
    // No --hero-image: lions falls back to the neutral gradient default.
    colors: COLORS,
    copy: {
      welcome: 'Welcome — choose your profile',
      eyebrow: 'KZNCU & EMCU · 2026 / 27 Season',
      office: 'Lions office',
      admin: 'Administrator · Lions',
      support: 'Cricket Services · support@lionscricket.co.za',
      footer: 'Powered by Medicoach',
      orgShort: 'Lions',
      cohortName: 'Lions cohort',
      heroTitle: 'From your club to the Lions.',
      heroBlurb:
        'Affiliated clubs join the DP World Lions ecosystem — fixtures, talent ID, clinical data and franchise readiness, all in one place.',
      crumbRoot: 'Lions',
    },
  },
};

export const SEED_TENANTS = Object.keys(BRANDING);

function loadSnapshot(tenant: string): Snapshot {
  const path = new URL(`../seed-data/${tenant}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
}

/** Branding input for buildTenantConfig — only `name` is required; the rest defaults. */
export interface TenantBrandingInput {
  name: string;
  title?: string;
  logoUrl?: string;
  faviconUrl?: string;
  colors?: Record<string, string>;
  copy?: Record<string, string>;
}

/**
 * Build a complete TenantConfig from minimal branding input — the ONE builder the
 * seed path and POST /platform/tenants share, so a portal-created tenant and a
 * seeded one have identical shape. Defaults: title ← name, neutral COLORS family
 * (caller tokens win), 'Powered by Medicoach' footer, empty cohort/catalogue.
 */
export function buildTenantConfig(
  slug: string,
  branding: TenantBrandingInput,
  submissionDeadline: string,
  features?: Record<string, boolean>,
  leagues: League[] = [],
): TenantConfig {
  const name = branding.name.trim();
  return {
    tenant: slug,
    branding: {
      name,
      title: branding.title?.trim() || name,
      logoUrl: branding.logoUrl ?? '',
      ...(branding.faviconUrl ? { faviconUrl: branding.faviconUrl } : {}),
      colors: { ...COLORS, ...(branding.colors ?? {}) },
      copy: { footer: 'Powered by Medicoach', ...(branding.copy ?? {}) },
    },
    submissionDeadline,
    knownClubs: [],
    leagues,
    ...(features ? { features } : {}),
  };
}

/** Outcome of a config seed: what the write actually did. */
export type SeedConfigResult =
  | { status: 'created'; leagues: number }
  | { status: 'exists'; leagues: number }
  | { status: 'overwritten'; leagues: number };

/**
 * Provision a tenant: write its config (branding + deadline + league catalogue).
 * The COHORT (clubs/series) starts BLANK — real unions onboard their own. But the
 * league catalogue is real, union-specific REFERENCE data, so it's provisioned here
 * (from the tenant's snapshot) and ships in production; tenants without a defined
 * catalogue (snapshot `leagues: []`) start empty for the admin to build. `knownClubs`
 * is empty (no hardcoded onboarding suggestions).
 *
 * Default is CREATE-IF-ABSENT ('exists' when the row is already there): CONFIG rows
 * are the registry source of truth and may carry portal/admin edits (branding,
 * adminCount, clubSignupLink) a re-seed must never clobber. `force` restores the
 * old whole-item overwrite for a deliberate reset.
 */
export async function seedTenantConfig(
  tenant: string,
  opts: { force?: boolean } = {},
): Promise<SeedConfigResult> {
  const branding = BRANDING[tenant];
  if (!branding) throw new Error(`no branding for tenant "${tenant}"`);
  const snap = loadSnapshot(tenant);
  const leagues = snap.leagues ?? [];
  const config = buildTenantConfig(tenant, branding, snap.submissionDeadline, undefined, leagues);
  if (opts.force) {
    await repo.putTenantConfig(config);
    return { status: 'overwritten', leagues: leagues.length };
  }
  try {
    await repo.createTenantConfig(config);
    return { status: 'created', leagues: leagues.length };
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return { status: 'exists', leagues: leagues.length };
    }
    throw err;
  }
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
