/**
 * One-off prerequisites for the Lions (CGL) 2026-27 fixture import (import-lions-fixtures.ts),
 * modelled on bootstrap-fixture-prereqs.ts:
 *
 *   npx tsx src/bootstrap-lions-fixture-prereqs.ts --parse-only                       # no AWS
 *   npx sst shell --stage dev -- npm --prefix packages/api run bootstrap-lions-fixture-prereqs            # dry-run
 *   npx sst shell --stage dev -- npm --prefix packages/api run bootstrap-lions-fixture-prereqs -- --confirm
 *
 * Idempotent; existing leagues/venues/aliases are left untouched and reported:
 *   1. LEAGUES — adds every LIONS_LEAGUES key the tenant config lacks (13 sheet leagues +
 *      hwb-premier-t20 + ladies-premier-t20; the T20 cups are `fixturesOnly`), all filed under
 *      'All districts'.
 *   2. VENUE ALIASES — merges LIONS_VENUE_ALIASES into `competitionDefaults.venueAliases`, so
 *      the API's release/in-season clash gates (venueAliasesFor) resolve ground spellings the
 *      same way the importer's clash scan does. Missing keys only; an existing key mapped
 *      elsewhere is reported, never overwritten.
 *   3. VENUE REGISTRY — every ground on the Saturday + Sunday "Teams per division and
 *      grounds" sheets (the Sunday sheet's untitled Presidents A block and missing Sunday 5
 *      block are tolerated by design — the registry needs club → grounds only), canonicalised
 *      and de-duplicated through LIONS_VENUE_ALIASES, with the listing clubs as homeClubIds;
 *      merged with the affiliation form's facility answers that match a canonical ground.
 *      Unmatched affiliation lines (free text, addresses, ambiguous "Marks Park") are
 *      reported, never registered. `surfaces` = KNOWN_GROUND_CAPACITIES (EMPTY until CGL
 *      answers the capacity question list) else 1. An existing registry row (matched by
 *      lions ground key) keeps its name/pin; missing homeClubIds are unioned in, and its
 *      surfaces is raised to a KNOWN_GROUND_CAPACITIES value when one exists.
 *
 * Fail-closed: a grounds-sheet club name that resolves to no CLUB_MAP club aborts.
 */
import ExcelJS from 'exceljs';
import { pathToFileURL } from 'node:url';
import {
  LIONS_TENANT,
  LIONS_LEAGUES,
  LIONS_VENUE_ALIASES,
  KNOWN_GROUND_CAPACITIES,
  buildLionsVenueRegistry,
  canonicalVenue,
  lionsGroundKey,
  parseGroundsSheet,
} from './lions-fixture-map.js';
import { parseAffiliationWorkbook } from './lions-affiliation-parse.js';
import { DEFAULT_PATHS } from './import-lions-fixtures.js';
import { OVERARCHING_DISTRICT } from './catalogue.js';
import { validateCompetitionDefaults } from './config-validation.js';
import type { League, TenantConfig, Venue } from './types.js';

interface Args {
  confirm: boolean;
  parseOnly: boolean;
  sundayGrounds: string;
  saturdayGrounds: string;
  affiliation: string;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    confirm: false,
    parseOnly: false,
    sundayGrounds: DEFAULT_PATHS.sundayGrounds,
    saturdayGrounds: DEFAULT_PATHS.saturdayGrounds,
    affiliation: DEFAULT_PATHS.affiliation,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--confirm') args.confirm = true;
    else if (a === '--parse-only') args.parseOnly = true;
    else if (a === '--sunday-grounds') args.sundayGrounds = val();
    else if (a === '--saturday-grounds') args.saturdayGrounds = val();
    else if (a === '--affiliation') args.affiliation = val();
    else throw new Error(`unknown flag ${a}`);
  }
  if (args.parseOnly && args.confirm)
    throw new Error('--parse-only and --confirm are mutually exclusive');
  return args;
}

/** Leagues the config lacks, as League entries (union-wide, console-grouped). */
export function leaguesToAdd(config: Pick<TenantConfig, 'leagues'>): League[] {
  const have = new Set((config.leagues ?? []).map((l) => l.key));
  return LIONS_LEAGUES.filter((l) => !have.has(l.key)).map((l) => ({
    key: l.key,
    label: l.label,
    group: l.group,
    district: OVERARCHING_DISTRICT,
    ...(l.fixturesOnly ? { fixturesOnly: true } : {}),
  }));
}

/** Aliases to merge into competitionDefaults.venueAliases: missing keys only; a key already
 * mapped to a different ground is a conflict (reported, left alone). */
export function aliasMerge(config: Pick<TenantConfig, 'competitionDefaults'>): {
  add: Record<string, string>;
  conflicts: string[];
} {
  const existing = config.competitionDefaults?.venueAliases ?? {};
  const add: Record<string, string> = {};
  const conflicts: string[] = [];
  for (const [k, v] of Object.entries(LIONS_VENUE_ALIASES)) {
    if (!(k in existing)) add[k] = v;
    else if (existing[k] !== v)
      conflicts.push(`"${k}" is mapped to "${existing[k]}" (lions map says "${v}")`);
  }
  return { add, conflicts };
}

/** The registry diff against what the tenant already holds. */
export function registryDiff(
  wanted: Venue[],
  existing: Venue[],
): { create: Venue[]; update: Array<{ venue: Venue; changes: string[] }>; untouched: number } {
  const byKey = new Map<string, Venue>();
  for (const v of existing) byKey.set(lionsGroundKey(v.name), v);
  const create: Venue[] = [];
  const update: Array<{ venue: Venue; changes: string[] }> = [];
  let untouched = 0;
  for (const w of wanted) {
    const cur = byKey.get(lionsGroundKey(w.name));
    if (!cur) {
      create.push(w);
      continue;
    }
    const changes: string[] = [];
    const next: Venue = { ...cur };
    const missing = (w.homeClubIds ?? []).filter((id) => !(cur.homeClubIds ?? []).includes(id));
    if (missing.length) {
      next.homeClubIds = [...(cur.homeClubIds ?? []), ...missing];
      changes.push(`+homeClubIds ${missing.join(', ')}`);
    }
    const canon = canonicalVenue(cur.name)?.name ?? cur.name;
    const known = KNOWN_GROUND_CAPACITIES[canon];
    if (Number.isFinite(known) && known >= 1 && Number(cur.surfaces ?? 1) !== known) {
      next.surfaces = known;
      changes.push(`surfaces ${cur.surfaces ?? 1} → ${known} (CGL-confirmed)`);
    }
    if (changes.length) update.push({ venue: next, changes });
    else untouched++;
  }
  return { create, update, untouched };
}

async function readWb(path: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ── Would-be registry (pure) ──
  const grounds = [
    ...parseGroundsSheet(await readWb(args.sundayGrounds), 'Sunday'),
    ...parseGroundsSheet(await readWb(args.saturdayGrounds), 'Saturday'),
  ];
  const blocks = [...new Set(grounds.map((g) => `${g.sheetLabel}: ${g.block}`))];
  console.log(
    `Grounds sheets: ${grounds.length} club row(s) in ${blocks.length} block(s): ${blocks.join(' · ')}`,
  );
  const aff = parseAffiliationWorkbook(await readWb(args.affiliation));
  const { venues: wanted, report } = buildLionsVenueRegistry(grounds, aff.records);
  if (report.unresolvedClubs.length) {
    console.error(
      `\n✗ ${report.unresolvedClubs.length} grounds-sheet club name(s) resolve to no club — refusing to continue:`,
    );
    for (const u of report.unresolvedClubs)
      console.error(`   ${u.sheetLabel} "${u.block}" row ${u.row}: "${u.rawClub}"`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nWould-be registry: ${wanted.length} ground(s)`);
  for (const v of wanted)
    console.log(
      `  ${v.name.padEnd(26)} ${v.id.padEnd(30)} surfaces ${v.surfaces}  home of ${v.homeClubIds?.join(', ')}`,
    );
  if (report.groundsNotCanonical.length)
    console.log(
      `  ⚠ grounds-sheet names with no LIONS_VENUES entry (registered as written): ${report.groundsNotCanonical.join(', ')}`,
    );
  console.log(
    `\nAffiliation facility answers: ${report.affiliationMatched.length} matched a ground, ${report.affiliationUnmatched.length} NOT registered (no unambiguous ground):`,
  );
  for (const u of report.affiliationUnmatched) console.log(`  ${u.clubId}: "${u.line}"`);
  console.log(
    `\nCapacity overrides (KNOWN_GROUND_CAPACITIES): ${Object.keys(KNOWN_GROUND_CAPACITIES).length || 'none yet — every ground defaults to 1'}`,
  );

  if (args.parseOnly) {
    console.log('\n[parse-only] nothing touched AWS.');
    return;
  }

  const repo = await import('./repo.js');
  const config = await repo.getTenantConfig(LIONS_TENANT);
  if (!config) throw new Error(`no tenant config for "${LIONS_TENANT}" — create the tenant first`);
  const existingVenues = await repo.listVenues(LIONS_TENANT);

  // ── Leagues ──
  const addLeagues = leaguesToAdd(config);
  for (const l of LIONS_LEAGUES)
    if (!addLeagues.some((a) => a.key === l.key))
      console.log(`league ${l.key} — already exists, untouched`);
  for (const l of addLeagues)
    console.log(
      `${args.confirm ? 'add' : '[dry-run] would add'} league ${l.key} ("${l.label}", group "${l.group}"${l.fixturesOnly ? ', fixtures-only' : ''})`,
    );

  // ── Aliases ──
  const { add: addAliases, conflicts } = aliasMerge(config);
  const nAliases = Object.keys(addAliases).length;
  console.log(
    `\nVenue aliases: ${nAliases} to ${args.confirm ? 'add' : 'add [dry-run]'}, ${Object.keys(LIONS_VENUE_ALIASES).length - nAliases - conflicts.length} already present`,
  );
  for (const c of conflicts) console.log(`  ⚠ alias conflict left alone: ${c}`);

  // ── Registry ──
  const { create, update, untouched } = registryDiff(wanted, existingVenues);
  console.log(
    `\nVenue registry: ${existingVenues.length} existing · ${create.length} to create · ${update.length} to update · ${untouched} untouched`,
  );
  for (const v of create)
    console.log(
      `${args.confirm ? 'create' : '[dry-run] would create'} venue "${v.name}" (${v.id}, surfaces ${v.surfaces})`,
    );
  for (const u of update)
    console.log(
      `${args.confirm ? 'update' : '[dry-run] would update'} venue "${u.venue.name}": ${u.changes.join('; ')}`,
    );

  if (!addLeagues.length && !nAliases && !create.length && !update.length) {
    console.log('\nNothing to do — all prerequisites already in place.');
    return;
  }
  if (!args.confirm) {
    console.log('\n[dry-run] nothing written. Re-run with --confirm to apply.');
    return;
  }

  if (addLeagues.length || nAliases) {
    // TenantConfig has no version guard — re-read just before writing (same as the console save).
    const fresh = await repo.getTenantConfig(LIONS_TENANT);
    if (!fresh) throw new Error(`tenant config for "${LIONS_TENANT}" vanished mid-run`);
    const leagues = [...(fresh.leagues ?? []), ...leaguesToAdd(fresh)];
    const freshAliases = aliasMerge(fresh).add;
    const competitionDefaults = validateCompetitionDefaults({
      ...(fresh.competitionDefaults ?? {}),
      venueAliases: { ...(fresh.competitionDefaults?.venueAliases ?? {}), ...freshAliases },
    });
    await repo.putTenantConfig({ ...fresh, leagues, competitionDefaults });
    console.log(
      `wrote tenant config (+${leaguesToAdd(fresh).length} league(s), +${Object.keys(freshAliases).length} venue alias(es))`,
    );
  }
  for (const v of create) {
    await repo.putVenue(LIONS_TENANT, v);
    console.log(`wrote venue ${v.id}`);
  }
  for (const u of update) {
    await repo.putVenue(LIONS_TENANT, u.venue);
    console.log(`updated venue ${u.venue.id}`);
  }
  console.log('Done.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
