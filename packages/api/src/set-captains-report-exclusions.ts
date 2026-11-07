/**
 * Add series-name prefixes to a tenant's captain's-report exclusions
 * (TenantConfig.captainsReportsExcludedSeriesPrefixes).
 *
 *   npx sst shell --stage <stage> -- npm --prefix packages/api run set-captains-report-exclusions -- \
 *     dolphins "EMCU"
 *   … --confirm
 *
 * Any series whose name starts with a listed prefix (trimmed, case-insensitive — see
 * seriesExcludedFromCaptainsReports in captains-reports.ts) is left out of every automatic
 * captain's-report open, notice, reminder and squad link. There is no UI for this yet.
 *
 * Intended first use: `dolphins "EMCU"`. Every EMCU series name starts with "EMCU", so this
 * stops the captain's-report ("rate the umpires") notices to EMCU clubs. Queued REPORTOPEN# /
 * SQUADOPEN# markers for excluded series are dropped by the existing retry/open code once the
 * config is set.
 *
 * ADD-ONLY: prefixes already listed (compared case-insensitively) are kept and skipped, and
 * nothing is ever removed. Prefixes pass the same rules the operator route applies: trimmed,
 * non-blank, ≤200 chars, ≤20 in total. Idempotent.
 */
import { pathToFileURL } from 'node:url';

const MAX_PREFIXES = 20;
const MAX_PREFIX_LENGTH = 200;

/** Current list + additions, trimmed and de-duplicated (case-insensitive), existing order kept. Throws on a bad prefix or over the cap. */
export function mergeExcludedPrefixes(
  current: string[],
  additions: string[],
): { next: string[]; added: string[]; skipped: string[] } {
  const next = [...current];
  const added: string[] = [];
  const skipped: string[] = [];
  for (const raw of additions) {
    const p = raw.trim();
    if (!p) throw new Error('every prefix must be non-blank');
    if (p.length > MAX_PREFIX_LENGTH)
      throw new Error(`"${p}": prefixes must be ${MAX_PREFIX_LENGTH} characters or fewer`);
    const lower = p.toLowerCase();
    if (next.some((e) => e.trim().toLowerCase() === lower)) {
      skipped.push(p);
      continue;
    }
    next.push(p);
    added.push(p);
  }
  if (next.length > MAX_PREFIXES)
    throw new Error(
      `at most ${MAX_PREFIXES} excluded prefixes allowed (would have ${next.length})`,
    );
  return { next, added, skipped };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const [tenant, ...prefixes] = args.filter((a) => !a.startsWith('--'));
  if (!tenant || prefixes.length === 0)
    throw new Error(
      'usage: set-captains-report-exclusions <tenant> "<prefix>" ["<prefix>" …] [--confirm]',
    );

  const repo = await import('./repo.js');
  const cfg = await repo.getTenantConfig(tenant);
  if (!cfg) throw new Error(`tenant "${tenant}" has no config — has it been created?`);

  const current = cfg.captainsReportsExcludedSeriesPrefixes ?? [];
  const { next, added, skipped } = mergeExcludedPrefixes(current, prefixes);

  console.log(`\n── ${tenant}: captain's-report excluded series prefixes`);
  console.log(`   current: ${current.map((p) => `"${p}"`).join(', ') || '(none)'}`);
  console.log(`   next:    ${next.map((p) => `"${p}"`).join(', ')}`);
  for (const p of added) console.log(`   + ${p}`);
  for (const p of skipped) console.log(`   = ${p} (already listed)`);

  if (added.length === 0) {
    console.log('\n(identical — no-op)');
    return;
  }
  if (!confirm) {
    console.log('\nDry run — re-run with --confirm to write.');
    return;
  }
  await repo.putTenantConfig({ ...cfg, captainsReportsExcludedSeriesPrefixes: next });
  const after = await repo.getTenantConfig(tenant);
  console.log(
    `\n✓ wrote ${next.length} prefix(es) to ${tenant}; read back: ${JSON.stringify(after?.captainsReportsExcludedSeriesPrefixes)}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
