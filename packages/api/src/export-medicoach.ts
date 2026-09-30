/**
 * Export a tenant's leagues, clubs and people as a MedicoachBundle v1 JSON file for the
 * medicoach bundle importer. See medicoach-bundle.ts for the contract and
 * medicoach-export-build.ts for the mapping.
 *
 *   npx sst shell --stage dev -- npm --prefix packages/api run export-medicoach -- \
 *     --tenant dolphins --out /tmp/dolphins-bundle-dev.json
 *   … [--leagues premier,promotion] [--include-inactive-players] [--confirm]
 *
 * Read-only, apart from one thing: with `--confirm` it records an `EXPORT#` audit item
 * (ExportLogEntry kind 'medicoach-export': per-entity counts, destination "medicoach", no
 * PII) after the file is written. Without `--confirm` nothing is written to DynamoDB, so
 * use a plain run for rehearsal and `--confirm` for the export you actually hand over.
 *
 * The bundle holds PII (names, emails, cells, dates of birth). It is written with mode
 * 0600. Keep it local and in-region, never commit it, and delete it after the import
 * reconciles. Console output carries counts, ids and masked samples only.
 *
 * The bundle is validated against MedicoachBundleSchema (ref uniqueness, ref resolution,
 * counts) before it is written. An invalid bundle is not written and the run exits 1.
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MedicoachBundleSchema } from './medicoach-bundle.js';
import {
  buildBundle,
  maskCell,
  maskEmail,
  maskName,
  type ExportSummary,
} from './medicoach-export-build.js';
import { recipesForTenant } from './medicoach-recipes/index.js';
import * as repo from './repo.js';
import type { PlayerRegistration, VeteransAffiliation } from './types.js';

interface Args {
  tenant: string;
  out: string;
  leagues?: string[];
  includeInactivePlayers: boolean;
  confirm: boolean;
}

const USAGE =
  'usage: export-medicoach --tenant <t> --out <file> [--leagues k1,k2] [--include-inactive-players] [--confirm]';

export function parseArgs(argv: string[]): Args {
  let tenant: string | undefined;
  let out: string | undefined;
  let leagues: string[] | undefined;
  let includeInactivePlayers = false;
  let confirm = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
      return v;
    };
    if (flag === '--tenant') tenant = value();
    else if (flag === '--out') out = value();
    else if (flag === '--leagues')
      leagues = value()
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
    else if (flag === '--include-inactive-players') includeInactivePlayers = true;
    else if (flag === '--confirm') confirm = true;
    else throw new Error(`unknown argument: ${flag}\n${USAGE}`);
  }
  if (!tenant) throw new Error(`--tenant is required\n${USAGE}`);
  if (!out) throw new Error(`--out is required\n${USAGE}`);
  return { tenant, out, leagues, includeInactivePlayers, confirm };
}

/** Run `fn` over `items` at most `limit` at a time. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function printSummary(summary: ExportSummary, counts: Record<string, number>): void {
  const line = (label: string, v: unknown) => console.log(`  ${label.padEnd(30)} ${v}`);
  console.log('\nCounts (bundle.counts)');
  for (const [k, v] of Object.entries(counts)) line(k, v);

  console.log('\nLeagues');
  line('exported', summary.leagues.exported.join(', ') || '—');
  line('excluded (seed-*/demo/filter)', summary.leagues.excluded.join(', ') || '—');
  line('synthesised from series', summary.leagues.synthesised.join(', ') || '—');
  line('without competitions', summary.leagues.withoutCompetitions.join(', ') || '—');

  if (summary.competitions.length) {
    console.log('\nCompetitions');
    for (const c of summary.competitions)
      console.log(
        `  ${`${c.league} / ${c.stream}`.padEnd(40)} ${c.type.padEnd(16)} ${c.formatSource.padEnd(9)} groups ${String(c.groups).padStart(2)}  fixtures ${String(c.fixtures).padStart(4)}${c.placeholders ? ` (${c.placeholders} placeholder)` : ''}`,
      );
  }

  const f = summary.fixtures;
  console.log('\nFixtures');
  line('read from series', f.read);
  line('exported (incl. placeholders)', f.exported);
  line('placeholder (recipe) fixtures', f.placeholders);
  line('cancelled → skipped', f.cancelledSkipped);
  line('postponed → scheduled + note', f.postponed);
  line('completed in smart club', f.completedInSource);
  line('undated → skipped', f.undatedSkipped);
  line('unresolved side → skipped', f.unresolvedSideSkipped);
  line('orphaned slot → skipped', f.orphanSlotSkipped);
  line('series with no league', f.seriesUnmatched.length ? f.seriesUnmatched.join(', ') : 0);

  const p = summary.players;
  console.log('\nPlayers');
  line('rows read', p.rowsRead);
  line('exported (deduped)', p.exported);
  line(
    'excluded by status',
    Object.keys(p.excludedByStatus).length ? JSON.stringify(p.excludedByStatus) : 0,
  );
  line('placeholder rows skipped', p.placeholdersSkipped);
  line('duplicate rows merged', p.duplicateRowsMerged);
  line('with a team', p.withTeam);
  line('without a team', p.noTeam);
  line('ambiguous multi-side club', p.ambiguousSide);

  const v = summary.veterans;
  console.log('\nVeterans roster coverage');
  line('players with a veterans club', v.playersWithVeteransClub);
  line('… with a veterans team ref', v.resolvedVeteransTeam);
  line('VETAFFIL records', v.affiliationsListed);
  line('… matched to exported players', v.affiliationsMatched);
  line('… unmatched', v.affiliationsUnmatched);

  const s = summary.staff;
  console.log('\nStaff');
  line('entries read (exco + coaches)', s.entriesRead);
  line('persons (deduped)', s.persons);
  line('assignments', s.assignments);
  line('skipped (no name/contact)', s.skippedNoIdentity);
  line('email shared, names differ', s.sharedEmailDifferentNames);

  const i = summary.institutions;
  console.log('\nInstitutions');
  line('exported', i.exported);
  line('synthesised from series', i.synthesised);
  line('demo clubs skipped', i.demoSkipped);

  if (summary.confirmations.length) {
    console.log('\nNeeds confirmation with the union');
    for (const c of summary.confirmations) console.log(`  • ${c}`);
  }
  if (summary.warnings.length) {
    console.log(`\nWarnings (${summary.warnings.length})`);
    for (const w of summary.warnings) console.log(`  ! ${w}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { tenant } = args;

  const [config, clubs, series, seasonRuns] = await Promise.all([
    repo.getTenantConfig(tenant),
    repo.listClubs(tenant),
    repo.listSeries(tenant),
    repo.listSeasonRuns(tenant),
  ]);
  if (!config) throw new Error(`tenant "${tenant}" has no CONFIG item`);

  const perClub = await mapLimit(clubs, 8, async (c) => ({
    id: c.id,
    players: await repo.listPlayers(tenant, c.id),
    affiliations: await repo.listVeteransAffiliations(tenant, c.id),
  }));
  const playersByClub = new Map<string, PlayerRegistration[]>();
  const veteransAffiliationsByClub = new Map<string, VeteransAffiliation[]>();
  for (const r of perClub) {
    playersByClub.set(r.id, r.players);
    if (r.affiliations.length) veteransAffiliationsByClub.set(r.id, r.affiliations);
  }

  const { bundle, summary } = buildBundle({
    tenant,
    config,
    clubs,
    playersByClub,
    veteransAffiliationsByClub,
    series,
    seasonRuns,
    recipes: recipesForTenant(tenant),
    options: { leagues: args.leagues, includeInactivePlayers: args.includeInactivePlayers },
  });

  console.log(`export-medicoach — tenant "${tenant}"${args.confirm ? ' (--confirm)' : ''}`);
  printSummary(summary, bundle.counts);

  if (!bundle.leagues.length)
    console.log(
      `\nNo leagues exported: ${summary.leagues.excluded.length} catalogue/series league keys were excluded (seed-*, demo${args.leagues ? ', --leagues filter' : ''}) and no other league had a calendar or fixtures to date a season. The bundle still carries institutions and people.`,
    );
  else if (!bundle.counts.fixtures)
    console.log(
      `\nNo fixtures exported: none of the ${bundle.leagues.length} exported leagues has Plan-B or season-run series in this stage (fixtures read: ${summary.fixtures.read}; excluded league keys: ${summary.leagues.excluded.length}). Leagues are exported with their team lists and no competitions.`,
    );

  // Masked sample, so an operator can eyeball the people mapping without seeing PII.
  const sample = bundle.people.staff.slice(0, 3);
  if (sample.length) {
    console.log('\nStaff sample (masked)');
    for (const s of sample)
      console.log(
        `  ${maskName(s.name).padEnd(24)} ${maskEmail(s.email).padEnd(20)} ${maskCell(s.cell).padEnd(8)} ${s.assignments.map((a) => a.kind).join(', ')}`,
      );
  }

  const parsed = MedicoachBundleSchema.safeParse(bundle);
  if (!parsed.success) {
    console.error(
      `\n✗ bundle failed validation (${parsed.error.issues.length} issues); nothing written`,
    );
    for (const issue of parsed.error.issues.slice(0, 50)) console.error(`  - ${issue.message}`);
    process.exit(1);
  }

  const outPath = path.resolve(args.out);
  await writeFile(outPath, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  console.log(`\n✓ bundle valid → ${outPath} (contains PII: keep local, delete after import)`);

  if (args.confirm) {
    const at = new Date().toISOString();
    await repo.putExportLog(tenant, {
      id: randomUUID(),
      kind: 'medicoach-export',
      by: 'cli:export-medicoach',
      at,
      rowCount: bundle.counts.players + bundle.counts.staff,
      scope: args.leagues?.length ? 'filtered' : 'all',
      destination: 'medicoach',
      counts: bundle.counts,
      leagues: bundle.leagues.map((l) => l.key),
    });
    console.log(`✓ audit entry EXPORT#${at} written (destination medicoach)`);
  } else {
    console.log('  (dry run: no audit entry written; pass --confirm for the export you hand over)');
  }
}

// Only run as a CLI; tests import parseArgs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
