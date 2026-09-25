/**
 * One-off backfill: copy the code-default ground-name aliases (`DEFAULT_VENUE_ALIASES`,
 * src/venue-clash.ts) into the dolphins tenant's `competitionDefaults.venueAliases` (ADR 0014).
 *
 * The clash gates already merge the tenant's aliases over the code default, so running this
 * changes no clash result. It moves the dolphins spellings into config, where an operator can
 * see and edit them, so a later change can empty the code default without losing them.
 * Do NOT empty the code default until this has run on dev AND prod.
 *
 * Only `dolphins`, only when the tenant has no `venueAliases` yet: an existing map, even an
 * empty one, is an operator's decision and is left alone. Everything else in
 * `competitionDefaults` is kept. Idempotent: a second run finds the aliases present and
 * writes nothing.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/backfill-venue-aliases.ts            (dry-run)
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/backfill-venue-aliases.ts --confirm  (writes)
 *
 * See docs/runbooks/configurable-league-structures.md §9.
 */
import { pathToFileURL } from 'node:url';
import * as repo from '../src/repo.js';
import { validateCompetitionDefaults } from '../src/config-validation.js';
import { DEFAULT_VENUE_ALIASES } from '../src/venue-clash.js';

export const BACKFILL_TENANT = 'dolphins';

export type BackfillOutcome = 'written' | 'would-write' | 'already-set' | 'no-tenant';

export interface BackfillResult {
  tenant: string;
  outcome: BackfillOutcome;
  /** How many aliases were (or would be) written. 0 unless written/would-write. */
  aliases: number;
}

export async function backfillVenueAliases(
  opts: { confirm: boolean; log?: (line: string) => void } = { confirm: false },
): Promise<BackfillResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const tenant = BACKFILL_TENANT;
  const config = await repo.getTenantConfig(tenant);
  if (!config) {
    log(`no tenant config for "${tenant}" — nothing to do`);
    return { tenant, outcome: 'no-tenant', aliases: 0 };
  }
  if (config.competitionDefaults?.venueAliases !== undefined) {
    const n = Object.keys(config.competitionDefaults.venueAliases).length;
    log(`${tenant} already has ${n} venue alias(es) in config — nothing to do`);
    return { tenant, outcome: 'already-set', aliases: 0 };
  }
  // The same shape guard both config PUTs run, so a backfilled map is one the routes accept.
  const { venueAliases } = validateCompetitionDefaults({
    venueAliases: { ...DEFAULT_VENUE_ALIASES },
  });
  const count = Object.keys(venueAliases ?? {}).length;
  if (!opts.confirm) {
    log(`[dry-run] ${tenant}: would write ${count} venue aliases. Re-run with --confirm.`);
    return { tenant, outcome: 'would-write', aliases: count };
  }
  // TenantConfig has no version guard (see repo.ts): re-read just before the write so the
  // window for clobbering a concurrent settings save is as small as the other backfills'.
  const fresh = (await repo.getTenantConfig(tenant)) ?? config;
  if (fresh.competitionDefaults?.venueAliases !== undefined) {
    log(`${tenant} gained venue aliases while this ran — nothing written`);
    return { tenant, outcome: 'already-set', aliases: 0 };
  }
  await repo.putTenantConfig({
    ...fresh,
    competitionDefaults: { ...(fresh.competitionDefaults ?? {}), venueAliases },
  });
  log(`${tenant}: wrote ${count} venue aliases`);
  return { tenant, outcome: 'written', aliases: count };
}

async function main(): Promise<void> {
  const flag = process.argv[2];
  if (flag && flag !== '--dry-run' && flag !== '--confirm') {
    console.error(`unknown flag "${flag}" — usage: backfill-venue-aliases [--dry-run|--confirm]`);
    process.exit(1);
  }
  await backfillVenueAliases({ confirm: flag === '--confirm' });
}

// Only run as a CLI — a test can import backfillVenueAliases directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
