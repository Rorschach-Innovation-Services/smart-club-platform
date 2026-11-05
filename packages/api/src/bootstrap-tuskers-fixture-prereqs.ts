/**
 * One-off prerequisites for the Tuskers (KZNICU) 2026-27 fixture import
 * (import-tuskers-fixtures.ts), modelled on bootstrap-titans-fixture-prereqs.ts:
 *
 *   npx tsx src/bootstrap-tuskers-fixture-prereqs.ts --parse-only                  # no AWS
 *   npx sst shell --stage dev -- npx tsx src/bootstrap-tuskers-fixture-prereqs.ts  # dry-run
 *   … --confirm                                                                     # apply
 *   … --map-club <clubMapId>=<tenantClubId>                                         # e.g. prod Lancashire
 *
 * Idempotent; existing clubs/leagues/venues/aliases are left untouched and reported:
 *   1. CLUBS — creates the three veterans-only clubs (Midlands, Zingari, Cosmos Cricket Club)
 *      when absent, the import-tuskers-compliance create pattern: the tenant's resolved
 *      uMgungundlovu district (`resolveTuskersDistrict`), doc-key seeds from the active
 *      catalogue, `leagues: []`, no chair / contacts (no PII). Every other club the sheets name
 *      must already exist (the compliance import created them) — a missing one aborts.
 *   2. LEAGUES — `premier-league` and `veterans-league` must exist; a missing key aborts (a
 *      competition is configured deliberately in the console, never minted here).
 *   3. VENUE ALIASES — merges TUSKERS_VENUE_ALIASES into `competitionDefaults.venueAliases`
 *      (missing keys only; a key mapped to a different ground is a blocker, never overwritten).
 *   4. VENUE REGISTRY — one `v-*` row per ground the sheets use (8 home grounds + PMB Oval +
 *      Eston), surfaces 1, homeClubIds from the 50-overs header. An existing row is matched
 *      the way the clash gate's registryResolver does (titans `registryDiff`) and reused as-is.
 *
 * Fail-closed: workbooks that do not parse clean abort before anything is read or written.
 */
import { pathToFileURL } from 'node:url';
import {
  NEW_VETS_CLUBS,
  TUSKERS_LEAGUE_KEYS,
  TUSKERS_TEAMS,
  TUSKERS_TENANT,
  TUSKERS_VENUE_ALIASES,
} from './tuskers-fixture-map.js';
import { CLUB_MAP, parseMapClubArgs, resolveTuskersDistrict } from './tuskers-import-map.js';
import {
  DEFAULT_PATHS,
  parseFiles,
  tenantClubId,
  wouldBeRegistry,
} from './import-tuskers-fixtures.js';
import { groundKey, venueAliasesFor } from './venue-clash.js';
import { validateCompetitionDefaults } from './config-validation.js';
import { deriveTeamPlanCounts } from './team-plan.js';
import type { Club, RequiredDoc, TenantConfig, Venue } from './types.js';
import type { TuskersWorkbook } from './tuskers-fixture-map.js';

interface Args {
  confirm: boolean;
  parseOnly: boolean;
  files: Record<TuskersWorkbook, string>;
  mapClub: string[];
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { confirm: false, parseOnly: false, files: { ...DEFAULT_PATHS }, mapClub: [] };
  const need = (i: number, flag: string) => {
    const v = argv[i];
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') args.confirm = true;
    else if (a === '--parse-only') args.parseOnly = true;
    else if (a === '--file-mens') args.files.mens = need(++i, a);
    else if (a === '--file-vets') args.files.vets = need(++i, a);
    else if (a === '--map-club') args.mapClub.push(need(++i, a));
    else throw new Error(`unknown flag ${a}`);
  }
  if (args.parseOnly && args.confirm)
    throw new Error('--parse-only and --confirm are mutually exclusive');
  return args;
}

/** Club records the bootstrap would create, and existing-club ids the sheets need but the
 * tenant lacks (fatal: the compliance import owns those). */
export function clubPlan(
  existingIds: Set<string>,
  mapping: Map<string, string> = new Map(),
): { create: Array<{ id: string; name: string }>; missing: string[] } {
  const create = NEW_VETS_CLUBS.filter((c) => !existingIds.has(c.id));
  const missing = TUSKERS_TEAMS.filter((t) => !t.created)
    .map((t) => tenantClubId(t.id, mapping))
    .filter((id) => !existingIds.has(id));
  return { create, missing };
}

/** The import-tuskers-compliance `buildClub` shape, minus the chair (no PII for these clubs). */
export function buildVetsClub(
  club: { id: string; name: string },
  activeDocs: RequiredDoc[],
  district: string,
): Club {
  const { teams, women, juniors } = deriveTeamPlanCounts({});
  const docs: Record<string, boolean> = {};
  for (const d of activeDocs) docs[d.key] = false;
  return {
    id: club.id,
    name: club.name,
    district,
    sub: '',
    chair: '',
    affiliation: 'not_started',
    cqi: 0,
    docs,
    players: 0,
    teams,
    women,
    juniors,
    color: '#4B8A6C',
    ground: {},
    leagues: [],
    version: 1,
  } as Club;
}

/** Aliases to merge (missing keys only); a key mapped elsewhere is a conflict. */
export function aliasMerge(config: Pick<TenantConfig, 'competitionDefaults'>): {
  add: Record<string, string>;
  conflicts: string[];
} {
  const existing = config.competitionDefaults?.venueAliases ?? {};
  const add: Record<string, string> = {};
  const conflicts: string[] = [];
  for (const [k, v] of Object.entries(TUSKERS_VENUE_ALIASES)) {
    if (!(k in existing)) add[k] = v;
    else if (existing[k] !== v)
      conflicts.push(`"${k}" is mapped to "${existing[k]}" (tuskers map says "${v}")`);
  }
  return { add, conflicts };
}

/**
 * The registry diff (titans `registryDiff` semantics): a wanted ground MATCHES an existing row
 * the way the clash gate's `registryResolver` does — `groundKey(name, aliases)` — and the
 * existing row is reused untouched. Only unmatched grounds are created; a new id colliding
 * with an existing one is a problem, never an overwrite.
 */
export function registryDiff(
  wanted: Venue[],
  existing: Venue[],
  aliases: Record<string, string>,
): {
  create: Venue[];
  matched: Array<{ wanted: Venue; existing: Venue; homeMissing: string[]; homeExtra: string[] }>;
  unused: Venue[];
  problems: string[];
} {
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
  const matched: Array<{
    wanted: Venue;
    existing: Venue;
    homeMissing: string[];
    homeExtra: string[];
  }> = [];
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
  const mapping = parseMapClubArgs(
    args.mapClub,
    CLUB_MAP.map((c) => c.id),
  );
  const { errors } = await parseFiles(args.files);
  if (errors.length) {
    console.error(`✗ workbooks do not parse clean (${errors.length} problem(s)) — refusing:`);
    for (const e of errors) console.error(`   ${e}`);
    process.exitCode = 1;
    return;
  }
  console.log('Tuskers fixture workbooks parse clean.');
  const wanted = wouldBeRegistry(mapping);
  console.log(`\nWould-be registry: ${wanted.length} ground(s), surfaces 1 each`);
  for (const v of wanted)
    console.log(
      `  ${v.name.padEnd(20)} ${v.id.padEnd(24)} home of ${v.homeClubIds?.join(', ') || '—'}`,
    );
  if (args.parseOnly) {
    console.log(`\nNew vets clubs: ${NEW_VETS_CLUBS.map((c) => c.id).join(', ')}`);
    console.log(`Aliases in the map: ${Object.keys(TUSKERS_VENUE_ALIASES).length}`);
    console.log('\n[parse-only] nothing touched AWS.');
    return;
  }

  const repo = await import('./repo.js');
  const { activeRequiredDocs, resolveDistricts } = await import('./catalogue.js');
  const config = await repo.getTenantConfig(TUSKERS_TENANT);
  if (!config) throw new Error(`no tenant config for "${TUSKERS_TENANT}"`);
  const [clubs, existingVenues] = await Promise.all([
    repo.listClubs(TUSKERS_TENANT),
    repo.listVenues(TUSKERS_TENANT),
  ]);
  console.log(
    `\nTenant "${TUSKERS_TENANT}": ${clubs.length} club(s), ${existingVenues.length} registry venue(s)`,
  );
  const fatal: string[] = [];

  // ── Clubs ──
  const plan = clubPlan(new Set(clubs.map((c) => c.id)), mapping);
  const districtResult = resolveTuskersDistrict(resolveDistricts(config));
  console.log('\n── Clubs');
  for (const c of NEW_VETS_CLUBS)
    if (!plan.create.some((x) => x.id === c.id)) console.log(`  club ${c.id} — exists, untouched`);
  for (const c of plan.create)
    console.log(
      `  ${args.confirm ? 'create' : '[dry-run] would create'} club ${c.id} ("${c.name}", leagues [], no contacts)`,
    );
  for (const m of plan.missing)
    fatal.push(
      `club "${m}" is not on the tenant — run import-tuskers-compliance first (or --map-club)`,
    );
  if (plan.create.length && districtResult.kind === 'error')
    fatal.push(`district: ${districtResult.message}`);

  // ── Leagues ──
  const have = new Set((config.leagues ?? []).map((l) => l.key));
  console.log('\n── Leagues');
  for (const k of TUSKERS_LEAGUE_KEYS) {
    if (have.has(k)) console.log(`  league ${k} — exists`);
    else
      fatal.push(
        `league key "${k}" is not configured — create it deliberately in the console first`,
      );
  }

  // ── Aliases ──
  const { add: addAliases, conflicts } = aliasMerge(config);
  const nAliases = Object.keys(addAliases).length;
  console.log(`\n── Venue aliases: ${nAliases} to add${args.confirm ? '' : ' [dry-run]'}`);
  for (const [k, v] of Object.entries(addAliases)) console.log(`    ${k} → ${v}`);
  for (const c of conflicts) fatal.push(`venue alias conflict: ${c}`);

  // ── Registry ──
  const aliases = { ...venueAliasesFor(config), ...TUSKERS_VENUE_ALIASES };
  const { create, matched, unused, problems } = registryDiff(wanted, existingVenues, aliases);
  console.log(
    `\n── Venue registry: ${matched.length} matched (row untouched) · ${create.length} to create · ${unused.length} existing not in the workbooks`,
  );
  for (const m of matched)
    console.log(
      `  match "${m.wanted.name}" → ${m.existing.id}` +
        (m.homeMissing.length || m.homeExtra.length
          ? ` — homeClubIds differ (not changed): missing [${m.homeMissing.join(', ')}], extra [${m.homeExtra.join(', ')}]`
          : ''),
    );
  for (const v of create)
    console.log(
      `  ${args.confirm ? 'create' : '[dry-run] would create'} "${v.name}" (${v.id}, home of ${v.homeClubIds?.join(', ') || '—'})`,
    );
  for (const p of problems) fatal.push(p);

  if (fatal.length) {
    console.error(`\n✗ Refusing — ${fatal.length} blocker(s):`);
    for (const f of fatal) console.error(`   ${f}`);
    process.exitCode = 1;
    return;
  }
  if (!plan.create.length && !nAliases && !create.length) {
    console.log('\nNothing to do — all prerequisites already in place.');
    return;
  }
  if (!args.confirm) {
    console.log('\n[dry-run] nothing written. Re-run with --confirm to apply.');
    return;
  }

  if (plan.create.length && districtResult.kind === 'ok') {
    const activeDocs = activeRequiredDocs(config);
    for (const c of plan.create) {
      try {
        await repo.createClub(
          TUSKERS_TENANT,
          buildVetsClub(c, activeDocs, districtResult.district),
        );
        console.log(`created club ${c.id}`);
      } catch (err) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
        console.log(`club ${c.id} appeared concurrently — left as is`);
      }
    }
  }
  if (nAliases) {
    // TenantConfig has no version guard — re-read just before writing (console save parity).
    const fresh = await repo.getTenantConfig(TUSKERS_TENANT);
    if (!fresh) throw new Error(`tenant config for "${TUSKERS_TENANT}" vanished mid-run`);
    const { add: freshAdd, conflicts: freshConflicts } = aliasMerge(fresh);
    if (freshConflicts.length)
      throw new Error(
        `venue alias conflict(s) appeared since the read — re-run: ${freshConflicts.join('; ')}`,
      );
    const competitionDefaults = validateCompetitionDefaults({
      ...(fresh.competitionDefaults ?? {}),
      venueAliases: { ...(fresh.competitionDefaults?.venueAliases ?? {}), ...freshAdd },
    });
    await repo.putTenantConfig({ ...fresh, competitionDefaults });
    console.log(`wrote tenant config (+${Object.keys(freshAdd).length} venue alias(es))`);
  }
  for (const v of create) {
    await repo.putVenue(TUSKERS_TENANT, v);
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
