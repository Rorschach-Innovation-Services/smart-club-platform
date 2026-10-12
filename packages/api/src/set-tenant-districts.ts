/**
 * Add districts to a tenant's district list (TenantConfig.districts).
 *
 *   npx sst shell --stage <stage> -- npm --prefix packages/api run set-tenant-districts -- \
 *     lions "Sedibeng" "Mogale City" "West Rand"
 *   … --confirm
 *
 * The operator portal's Districts card is the normal way to do this. This script is the
 * fallback for standing a tenant up ahead of a bulk import (the Lions affiliation import
 * aborts unless each CGL district matches exactly one configured district).
 *
 * ADD-ONLY: names already listed are kept and skipped, and nothing is ever removed, so the
 * operator route's "district still referenced" guard can't be bypassed from here. Names
 * pass the same rules the operator route applies (validateDistricts in index.ts): trimmed,
 * non-blank, ≤80 chars, not the reserved overarching name, no duplicates. Idempotent.
 */
import { pathToFileURL } from 'node:url';
import { OVERARCHING_DISTRICT, resolveDistricts } from './catalogue.js';

/** Current list + additions, trimmed and de-duplicated, existing order kept. Throws on a bad name. */
export function mergeDistricts(
  current: string[],
  additions: string[],
): { next: string[]; added: string[]; skipped: string[] } {
  const next = [...current];
  const added: string[] = [];
  const skipped: string[] = [];
  for (const raw of additions) {
    const d = raw.trim();
    if (!d) throw new Error('every district needs a name');
    if (d.length > 80) throw new Error(`"${d}": district names must be 80 characters or fewer`);
    if (d === OVERARCHING_DISTRICT)
      throw new Error(`"${OVERARCHING_DISTRICT}" is reserved for overarching leagues`);
    if (next.includes(d)) {
      skipped.push(d);
      continue;
    }
    next.push(d);
    added.push(d);
  }
  return { next, added, skipped };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const [tenant, ...names] = args.filter((a) => !a.startsWith('--'));
  if (!tenant || names.length === 0)
    throw new Error(
      'usage: set-tenant-districts <tenant> "<district>" ["<district>" …] [--confirm]',
    );

  const repo = await import('./repo.js');
  const cfg = await repo.getTenantConfig(tenant);
  if (!cfg) throw new Error(`tenant "${tenant}" has no config — has it been created?`);

  const explicit = cfg.districts !== undefined;
  const current = resolveDistricts(cfg);
  const { next, added, skipped } = mergeDistricts(current, names);

  console.log(
    `\n── ${tenant}: ${explicit ? 'explicit district list' : 'no explicit list (resolving to shared defaults)'}`,
  );
  console.log(`   current: ${current.map((d) => `"${d}"`).join(', ') || '(none)'}`);
  console.log(`   next:    ${next.map((d) => `"${d}"`).join(', ')}`);
  for (const d of added) console.log(`   + ${d}`);
  for (const d of skipped) console.log(`   = ${d} (already listed)`);

  // A legacy tenant on the shared defaults has no explicit list; the first write
  // materialises one, exactly like the portal card's first save.
  if (added.length === 0 && explicit) {
    console.log('\n(identical — no-op)');
    return;
  }
  if (!confirm) {
    console.log('\nDry run — re-run with --confirm to write.');
    return;
  }
  await repo.putTenantConfig({ ...cfg, districts: next });
  const after = await repo.getTenantConfig(tenant);
  console.log(
    `\n✓ wrote ${next.length} district(s) to ${tenant}; read back: ${JSON.stringify(after?.districts)}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
