/**
 * Idempotent branding backfill — bring existing tenant CONFIG rows up to the
 * current seed branding (full color-token family incl. --hero-image, the new
 * copy slots, faviconUrl) WITHOUT re-seeding. Required alongside the deploy
 * that neutralizes index.html's dolphins defaults: live rows carry only the
 * legacy 6-token palette, so without this patch prod would paint neutral.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/src/backfill-branding.ts [tenant ...] [--dry-run] [--set-logo <url>]
 *
 * Merge-patch semantics (never a whole-item Put, never a fresh item):
 *   • colors  — existing map + seed family, seed winning; tokens the seed
 *               doesn't define (legacy --navy/--teal/…) are left untouched.
 *   • copy    — ONLY the new slots (orgShort, cohortName, heroTitle, heroBlurb,
 *               crumbRoot) are SET; admin-edited slots (e.g. copy.support) and
 *               everything else on the row (adminCount, clubSignupLink,
 *               leagues, deadline) are physically outside the UpdateExpression.
 *   • faviconUrl — set only when the seed branding defines one.
 *   • logoUrl — only via an explicit `--set-logo <url>` (single tenant only).
 *
 * Also ensures each CONFIG row carries the PLATFORM#TENANTS gsi1 attrs (the
 * operator portal's tenant-registry index) — rows written before the registry
 * existed aren't enumerable by repo.listTenants() until this runs. Idempotent
 * (same values every run).
 *
 * Re-running is a no-op once rows match ("up to date"). --dry-run prints the
 * per-tenant diff and writes nothing.
 */
import * as repo from './repo.js';
import { BRANDING, SEED_TENANTS } from './seed-core.js';

/** The copy slots this backfill owns. Pre-existing slots are never touched. */
const NEW_COPY_SLOTS = ['orgShort', 'cohortName', 'heroTitle', 'heroBlurb', 'crumbRoot'] as const;

interface CliArgs {
  tenants: string[];
  dryRun: boolean;
  setLogo?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const tenants: string[] = [];
  let dryRun = false;
  let setLogo: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--set-logo') {
      setLogo = argv[++i];
      if (!setLogo || setLogo.startsWith('--')) {
        console.error('--set-logo requires a URL argument');
        process.exit(1);
      }
    } else if (arg.startsWith('--')) {
      console.error(`unknown flag ${arg}`);
      console.error('usage: backfill-branding [tenant ...] [--dry-run] [--set-logo <url>]');
      process.exit(1);
    } else {
      tenants.push(arg);
    }
  }
  if (setLogo && tenants.length !== 1) {
    console.error('--set-logo targets exactly one tenant — name it explicitly');
    process.exit(1);
  }
  return { tenants: tenants.length > 0 ? tenants : [...SEED_TENANTS], dryRun, setLogo };
}

/** Build the merge patch for one tenant; returns null when the row is already current. */
function buildPatch(
  existing: { colors: Record<string, string>; copy: Record<string, string> },
  seed: (typeof BRANDING)[string],
  setLogo: string | undefined,
  currentLogo: string,
  currentFavicon: string | undefined,
): { patch: repo.BrandingMergePatch; diff: string[] } | null {
  const diff: string[] = [];
  const patch: repo.BrandingMergePatch = {};

  const mergedColors = { ...existing.colors, ...seed.colors };
  const colorChanges = Object.entries(seed.colors).filter(
    ([token, value]) => existing.colors[token] !== value,
  );
  if (colorChanges.length > 0) {
    patch.colors = mergedColors;
    for (const [token, value] of colorChanges) {
      diff.push(`colors ${token}: ${existing.colors[token] ?? '(absent)'} → ${value}`);
    }
  }

  const copySlots: Record<string, string> = {};
  for (const slot of NEW_COPY_SLOTS) {
    const value = seed.copy[slot];
    if (value && existing.copy[slot] !== value) {
      copySlots[slot] = value;
      diff.push(`copy.${slot}: ${existing.copy[slot] ?? '(absent)'} → ${value}`);
    }
  }
  if (Object.keys(copySlots).length > 0) patch.copySlots = copySlots;

  if (seed.faviconUrl && currentFavicon !== seed.faviconUrl) {
    patch.faviconUrl = seed.faviconUrl;
    diff.push(`faviconUrl: ${currentFavicon ?? '(absent)'} → ${seed.faviconUrl}`);
  }

  if (setLogo && currentLogo !== setLogo) {
    patch.logoUrl = setLogo;
    diff.push(`logoUrl: ${currentLogo} → ${setLogo}`);
  }

  return diff.length > 0 ? { patch, diff } : null;
}

async function main(): Promise<void> {
  const { tenants, dryRun, setLogo } = parseArgs(process.argv.slice(2));
  let failures = 0;

  for (const tenant of tenants) {
    const seed = BRANDING[tenant];
    if (!seed) {
      console.error(`${tenant}: no seed branding (known: ${SEED_TENANTS.join(', ')}) — skipped`);
      failures++;
      continue;
    }
    // One tenant failing (missing row, DDB error) must not abort the rest of the
    // backfill — record it, keep going, and exit non-zero at the end.
    try {
      const config = await repo.getTenantConfig(tenant);
      if (!config) {
        console.error(`${tenant}: CONFIG row not found — seed the tenant first; skipped`);
        failures++;
        continue;
      }
      // Registry index: pre-registry CONFIG rows lack the PLATFORM#TENANTS gsi1
      // attrs, so listTenants() can't see them. SET is idempotent (same values).
      if (dryRun) {
        console.log(`[dry-run] ${tenant}: would ensure the platform registry index (gsi1)`);
      } else {
        await repo.ensureTenantConfigGsi(tenant);
        console.log(`${tenant}: platform registry index ensured.`);
      }
      const existing = {
        colors: config.branding?.colors ?? {},
        copy: (config.branding?.copy ?? {}) as Record<string, string>,
      };
      const result = buildPatch(
        existing,
        seed,
        setLogo,
        config.branding?.logoUrl ?? '',
        config.branding?.faviconUrl,
      );
      if (!result) {
        console.log(`${tenant}: up to date — nothing to do.`);
        continue;
      }
      const prefix = dryRun ? '[dry-run] ' : '';
      for (const line of result.diff) console.log(`${prefix}${tenant}: ${line}`);
      if (dryRun) continue;
      await repo.mergeBrandingPatch(tenant, result.patch);
      console.log(`${tenant}: patched (${result.diff.length} change(s)).`);
    } catch (err) {
      console.error(`${tenant}: backfill failed —`, err);
      failures++;
    }
  }

  if (dryRun) console.log('dry-run complete — re-run without --dry-run to apply.');
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
