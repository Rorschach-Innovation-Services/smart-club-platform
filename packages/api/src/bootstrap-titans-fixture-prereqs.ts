/**
 * One-off prerequisites for the Titans 2026-27 fixture import (import-titans-fixtures.ts),
 * modelled on bootstrap-lions-fixture-prereqs.ts:
 *
 *   npx tsx src/bootstrap-titans-fixture-prereqs.ts --parse-only                      # no AWS
 *   npx sst shell --stage dev -- npm --prefix packages/api run bootstrap-titans-fixture-prereqs            # dry-run
 *   npx sst shell --stage dev -- npm --prefix packages/api run bootstrap-titans-fixture-prereqs -- --confirm
 *
 * Idempotent; existing leagues/venues/aliases are left untouched and reported:
 *   1. LEAGUES — adds TITANS_NEW_LEAGUES the config lacks (mens-t20 + womens-t20, fixtures-only
 *      cups, and womens-junior-league), filed under 'All districts'. Every OTHER league key the
 *      workbook uses must already exist: a missing one aborts (a competition is configured
 *      deliberately, never minted by a bootstrap).
 *   2. VENUE ALIASES — merges TITANS_VENUE_ALIASES (misspellings only) into
 *      `competitionDefaults.venueAliases`, so the API's release/in-season clash gates resolve
 *      ground spellings the way the importer's scan does. Missing keys only; a key mapped
 *      elsewhere is reported, never overwritten.
 *   3. VENUE REGISTRY — one row per canonical ground in the workbook (plus each club's own
 *      ground), `surfaces` 1 until the union answers the capacity question, `homeClubIds` = the
 *      clubs hosting 2+ home fixtures there (veterans central-venue days excluded) plus the club whose
 *      ground it is. An EXISTING row is matched the way the clash gate's registryResolver
 *      does (groundKey with the tenant aliases + the titans map) and reused as-is — id, name,
 *      pin, surfaces and homeClubIds untouched; a homeClubIds difference is reported only.
 *      Only unmatched grounds are created; never a duplicate of an existing venue.
 *
 * Fail-closed: a workbook that does not parse clean aborts before anything is read or written.
 */
import ExcelJS from 'exceljs';
import { pathToFileURL } from 'node:url';
import {
  TITANS_LEAGUE_KEYS,
  TITANS_NEW_LEAGUES,
  TITANS_TENANT,
  TITANS_GATE_ALIASES,
  TITANS_VENUE_ALIASES,
  parseTitansWorkbook,
} from './titans-fixture-map.js';
import { groundKey, venueAliasesFor } from './venue-clash.js';
import { DEFAULT_PATHS, clubsFromMap, wouldBeRegistry } from './import-titans-fixtures.js';
import { OVERARCHING_DISTRICT } from './catalogue.js';
import { validateCompetitionDefaults } from './config-validation.js';
import type { Club, League, TenantConfig, Venue } from './types.js';

interface Args {
  confirm: boolean;
  parseOnly: boolean;
  file: string;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { confirm: false, parseOnly: false, file: DEFAULT_PATHS.file };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') args.confirm = true;
    else if (a === '--parse-only') args.parseOnly = true;
    else if (a === '--file') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error('--file needs a value');
      args.file = v;
    } else throw new Error(`unknown flag ${a}`);
  }
  if (args.parseOnly && args.confirm)
    throw new Error('--parse-only and --confirm are mutually exclusive');
  return args;
}

/** New leagues the config lacks (union-wide), and workbook keys that are neither present nor
 * bootstrap-able (fatal). */
export function leaguePlan(config: Pick<TenantConfig, 'leagues'>): {
  add: League[];
  missing: string[];
} {
  const have = new Set((config.leagues ?? []).map((l) => l.key));
  const add = TITANS_NEW_LEAGUES.filter((l) => !have.has(l.key)).map((l) => ({
    key: l.key,
    label: l.label,
    group: l.group,
    district: OVERARCHING_DISTRICT,
    ...(l.fixturesOnly ? { fixturesOnly: true } : {}),
  }));
  const bootstrapped = new Set(TITANS_NEW_LEAGUES.map((l) => l.key));
  const missing = TITANS_LEAGUE_KEYS.filter((k) => !have.has(k) && !bootstrapped.has(k));
  return { add, missing };
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
  for (const [k, v] of Object.entries(TITANS_VENUE_ALIASES)) {
    if (!(k in existing)) add[k] = v;
    else if (existing[k] !== v)
      conflicts.push(`"${k}" is mapped to "${existing[k]}" (titans map says "${v}")`);
  }
  return { add, conflicts };
}

export interface VenueMatch {
  wanted: Venue;
  existing: Venue;
  /** Derived homeClubIds the stored row lacks / stored ones the workbook does not derive —
   * reported only; an existing row is never rewritten. */
  homeMissing: string[];
  homeExtra: string[];
}

/**
 * The registry diff against what the tenant already holds. A wanted ground MATCHES an existing
 * row the way the clash gate's `registryResolver` does — `groundKey(name, aliases)` with the
 * tenant's aliases merged under the titans map — and the existing row (its id, name, pin,
 * surfaces, homeClubIds) is reused untouched. Only unmatched grounds are created, and a new
 * id that collides with an existing one is a problem, never an overwrite.
 */
export function registryDiff(
  wanted: Venue[],
  existing: Venue[],
  aliases: Record<string, string> = TITANS_GATE_ALIASES,
): { create: Venue[]; matched: VenueMatch[]; unused: Venue[]; problems: string[] } {
  const byKey = new Map<string, Venue>();
  const problems: string[] = [];
  for (const v of existing) {
    const k = groundKey(v.name, aliases);
    const prior = byKey.get(k);
    if (prior)
      problems.push(
        `existing venues "${prior.name}" (${prior.id}) and "${v.name}" (${v.id}) share ground key "${k}"`,
      );
    else byKey.set(k, v);
  }
  const ids = new Set(existing.map((v) => v.id));
  const create: Venue[] = [];
  const matched: VenueMatch[] = [];
  const used = new Set<string>();
  for (const w of wanted) {
    const cur = byKey.get(groundKey(w.name, aliases));
    if (!cur) {
      if (ids.has(w.id))
        problems.push(`new venue id ${w.id} ("${w.name}") already exists on another venue`);
      create.push(w);
      continue;
    }
    used.add(cur.id);
    const have = cur.homeClubIds ?? [];
    const want = w.homeClubIds ?? [];
    matched.push({
      wanted: w,
      existing: cur,
      homeMissing: want.filter((id) => !have.includes(id)),
      homeExtra: have.filter((id) => !want.includes(id)),
    });
  }
  return { create, matched, unused: existing.filter((v) => !used.has(v.id)), problems };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(args.file);
  const { sheets, errors } = parseTitansWorkbook(wb);
  if (errors.length) {
    console.error(`✗ workbook does not parse clean (${errors.length} problem(s)) — refusing:`);
    for (const e of errors) console.error(`   ${e}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Titans fixtures workbook: ${args.file} — parses clean`);

  let clubs: Club[] = clubsFromMap();
  let repo: typeof import('./repo.js') | null = null;
  let config: TenantConfig | null = null;
  let existingVenues: Venue[] = [];
  if (!args.parseOnly) {
    repo = await import('./repo.js');
    config = await repo.getTenantConfig(TITANS_TENANT);
    if (!config) throw new Error(`no tenant config for "${TITANS_TENANT}"`);
    [clubs, existingVenues] = await Promise.all([
      repo.listClubs(TITANS_TENANT),
      repo.listVenues(TITANS_TENANT),
    ]);
    console.log(
      `Tenant "${TITANS_TENANT}": ${clubs.length} club(s), ${existingVenues.length} registry venue(s)`,
    );
  }
  const wanted = wouldBeRegistry(sheets, clubs);
  console.log(`\nWould-be registry: ${wanted.length} ground(s), surfaces 1 each`);
  for (const v of wanted)
    console.log(
      `  ${v.name.padEnd(36)} ${v.id.padEnd(40)} home of ${v.homeClubIds?.join(', ') || '—'}`,
    );
  if (args.parseOnly) {
    console.log(`\nAliases in the map: ${Object.keys(TITANS_VENUE_ALIASES).length}`);
    console.log('\n[parse-only] nothing touched AWS.');
    return;
  }

  // ── Leagues ──
  const { add: addLeagues, missing } = leaguePlan(config!);
  console.log('\n── Leagues');
  for (const k of TITANS_LEAGUE_KEYS)
    if (!addLeagues.some((a) => a.key === k) && !missing.includes(k))
      console.log(`  league ${k} — exists, untouched`);
  for (const l of addLeagues)
    console.log(
      `  ${args.confirm ? 'add' : '[dry-run] would add'} league ${l.key} ("${l.label}", group "${l.group}", ${l.district}${l.fixturesOnly ? ', fixtures-only' : ''})`,
    );
  if (missing.length) {
    console.error(
      `\n✗ league key(s) the workbook needs are not on the tenant and are not bootstrap-able: ${missing.join(', ')} — configure them deliberately first`,
    );
    process.exitCode = 1;
    return;
  }

  // ── Aliases ──
  const { add: addAliases, conflicts } = aliasMerge(config!);
  const nAliases = Object.keys(addAliases).length;
  console.log(
    `\n── Venue aliases: ${nAliases} to ${args.confirm ? 'add' : 'add [dry-run]'}, ${Object.keys(TITANS_VENUE_ALIASES).length - nAliases - conflicts.length} already present`,
  );
  for (const [k, v] of Object.entries(addAliases)) console.log(`    ${k} → ${v}`);
  for (const c of conflicts) console.log(`  ⚠ alias conflict left alone: ${c}`);

  // ── Registry ──
  const aliases = { ...venueAliasesFor(config), ...TITANS_VENUE_ALIASES };
  const { create, matched, unused, problems } = registryDiff(wanted, existingVenues, aliases);
  console.log(
    `\n── Venue registry: ${existingVenues.length} existing · ${matched.length} matched (id reused, row untouched) · ${create.length} to create · ${unused.length} existing not in the workbook`,
  );
  for (const m of matched)
    console.log(
      `  match "${m.wanted.name}" → existing ${m.existing.id} "${m.existing.name}"` +
        (m.homeMissing.length || m.homeExtra.length
          ? ` — homeClubIds differ (not changed): derived-but-absent [${m.homeMissing.join(', ')}], stored-not-derived [${m.homeExtra.join(', ')}]`
          : ''),
    );
  for (const v of create)
    console.log(
      `  ${args.confirm ? 'create' : '[dry-run] would create'} "${v.name}" (${v.id}, surfaces ${v.surfaces}, home of ${v.homeClubIds?.join(', ') || '—'})`,
    );
  for (const v of unused)
    console.log(
      `  existing ${v.id} "${v.name}" (home of ${v.homeClubIds?.join(', ') || '—'}) — no workbook fixture uses it; untouched`,
    );
  if (problems.length) {
    console.error(`\n✗ ${problems.length} registry problem(s) — refusing:`);
    for (const p of problems) console.error(`   ${p}`);
    process.exitCode = 1;
    return;
  }

  if (!addLeagues.length && !nAliases && !create.length) {
    console.log('\nNothing to do — all prerequisites already in place.');
    return;
  }
  if (!args.confirm) {
    console.log('\n[dry-run] nothing written. Re-run with --confirm to apply.');
    return;
  }
  if (addLeagues.length || nAliases) {
    // TenantConfig has no version guard — re-read just before writing (same as the console save).
    const fresh = await repo!.getTenantConfig(TITANS_TENANT);
    if (!fresh) throw new Error(`tenant config for "${TITANS_TENANT}" vanished mid-run`);
    const leagues = [...(fresh.leagues ?? []), ...leaguePlan(fresh).add];
    const freshAliases = aliasMerge(fresh).add;
    const competitionDefaults = validateCompetitionDefaults({
      ...(fresh.competitionDefaults ?? {}),
      venueAliases: { ...(fresh.competitionDefaults?.venueAliases ?? {}), ...freshAliases },
    });
    await repo!.putTenantConfig({ ...fresh, leagues, competitionDefaults });
    console.log(
      `wrote tenant config (+${leaguePlan(fresh).add.length} league(s), +${Object.keys(freshAliases).length} venue alias(es))`,
    );
  }
  for (const v of create) {
    await repo!.putVenue(TITANS_TENANT, v);
    console.log(`wrote venue ${v.id}`);
  }
  console.log('Done.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
