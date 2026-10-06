/**
 * One-off prerequisites for the EMCU 2026-27 fixture import (import-emcu-fixtures.ts),
 * modelled on bootstrap-lions-fixture-prereqs.ts:
 *
 *   npx tsx src/bootstrap-emcu-fixture-prereqs.ts --parse-only                                # no AWS
 *   npx sst shell --stage prod -- npm --prefix packages/api run bootstrap-emcu-prereqs            # dry run
 *   npx sst shell --stage prod -- npm --prefix packages/api run bootstrap-emcu-prereqs -- --confirm
 *
 * Idempotent; anything already present is left untouched and reported:
 *   1. CLUBS — EMCU_NEW_CLUBS (Dolphins Deaf Cricket Team, Umlazi CC (MUT)) as skeletal records
 *      in the "Ethekwini Metro Cricket Union" district, no ground, no leagues (the importer's
 *      club-league sync fills those). Created with a not-exists condition, never overwritten.
 *   2. VENUES — EMCU_NEW_VENUES (Lutherfield, Dokkies Primary School) with the clubs that host
 *      there in the workbook as homeClubIds. A ground the registry already holds (matched by
 *      alias-aware ground key) keeps its name/pin and only gains missing homeClubIds.
 *   3. VENUE ALIASES — EMCU_VENUE_ALIASES merged into the TENANT's
 *      `competitionDefaults.venueAliases` (not the engine defaults), so the API's release and
 *      in-season clash gates resolve the workbook's ground spellings exactly as the importer
 *      did. Missing keys only; a key mapped elsewhere is reported, never overwritten.
 */
import { pathToFileURL } from 'node:url';
import {
  EMCU_DISTRICT,
  EMCU_NEW_CLUBS,
  EMCU_NEW_VENUES,
  EMCU_TENANT,
  EMCU_VENUE_ALIASES,
  emcuAliases,
  newClubRecord,
} from './emcu-fixture-map.js';
import { groundKey, venueAliasesFor } from './venue-clash.js';
import { validateCompetitionDefaults } from './config-validation.js';
import type { Club, TenantConfig, Venue } from './types.js';

interface Args {
  confirm: boolean;
  parseOnly: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { confirm: false, parseOnly: false };
  for (const a of argv) {
    if (a === '--confirm') args.confirm = true;
    else if (a === '--parse-only') args.parseOnly = true;
    else throw new Error(`unknown flag ${a}`);
  }
  if (args.parseOnly && args.confirm)
    throw new Error('--parse-only and --confirm are mutually exclusive');
  return args;
}

/** Aliases to merge: missing keys only; a key already mapped elsewhere is a conflict. */
export function aliasMerge(config: Pick<TenantConfig, 'competitionDefaults'>): {
  add: Record<string, string>;
  conflicts: string[];
} {
  const existing = config.competitionDefaults?.venueAliases ?? {};
  const add: Record<string, string> = {};
  const conflicts: string[] = [];
  for (const [k, v] of Object.entries(EMCU_VENUE_ALIASES)) {
    if (!(k in existing)) add[k] = v;
    else if (existing[k] !== v)
      conflicts.push(`"${k}" is mapped to "${existing[k]}" (EMCU map says "${v}")`);
  }
  return { add, conflicts };
}

/** New clubs the tenant lacks (by id). */
export function clubsToCreate(existing: Pick<Club, 'id'>[]): Club[] {
  const have = new Set(existing.map((c) => c.id));
  return EMCU_NEW_CLUBS.filter((c) => !have.has(c.id)).map(newClubRecord);
}

/** The registry diff for EMCU_NEW_VENUES against what the tenant holds. */
export function venueDiff(
  existing: Venue[],
  aliases: Record<string, string>,
): { create: Venue[]; update: Array<{ venue: Venue; added: string[] }>; untouched: string[] } {
  const byKey = new Map(existing.map((v) => [groundKey(v.name, aliases), v]));
  const create: Venue[] = [];
  const update: Array<{ venue: Venue; added: string[] }> = [];
  const untouched: string[] = [];
  for (const w of EMCU_NEW_VENUES) {
    const cur = byKey.get(groundKey(w.name, aliases));
    if (!cur) {
      create.push({ ...w, homeClubIds: [...(w.homeClubIds ?? [])] });
      continue;
    }
    const added = (w.homeClubIds ?? []).filter((id) => !(cur.homeClubIds ?? []).includes(id));
    if (added.length)
      update.push({
        venue: { ...cur, homeClubIds: [...(cur.homeClubIds ?? []), ...added] },
        added,
      });
    else untouched.push(cur.name);
  }
  return { create, update, untouched };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`EMCU prerequisites for tenant "${EMCU_TENANT}"`);
  console.log(
    `  clubs:   ${EMCU_NEW_CLUBS.map((c) => `${c.name} (${c.id})`).join(', ')} — district "${EMCU_DISTRICT}"`,
  );
  for (const v of EMCU_NEW_VENUES)
    console.log(`  venue:   ${v.name} (${v.id}) — home of ${v.homeClubIds?.join(', ')}`);
  console.log(`  aliases: ${Object.keys(EMCU_VENUE_ALIASES).length} (EMCU_VENUE_ALIASES)`);
  if (args.parseOnly) {
    console.log('\n[parse-only] nothing touched AWS.');
    return;
  }

  const repo = await import('./repo.js');
  const config = await repo.getTenantConfig(EMCU_TENANT);
  if (!config) throw new Error(`no tenant config for "${EMCU_TENANT}"`);
  const [clubs, venues] = await Promise.all([
    repo.listClubs(EMCU_TENANT),
    repo.listVenues(EMCU_TENANT),
  ]);
  if (config.districts?.length && !config.districts.includes(EMCU_DISTRICT))
    throw new Error(`tenant districts do not include "${EMCU_DISTRICT}" — refusing`);
  const aliases = emcuAliases(venueAliasesFor(config));

  // ── Clubs ──
  const newClubs = clubsToCreate(clubs);
  for (const c of EMCU_NEW_CLUBS)
    if (!newClubs.some((n) => n.id === c.id))
      console.log(`club ${c.id} — already exists, untouched`);
  for (const c of newClubs)
    console.log(`${args.confirm ? 'create' : '[dry-run] would create'} club "${c.name}" (${c.id})`);

  // ── Venues ──
  const { create, update, untouched } = venueDiff(venues, aliases);
  for (const n of untouched) console.log(`venue "${n}" — already present, untouched`);
  for (const v of create)
    console.log(
      `${args.confirm ? 'create' : '[dry-run] would create'} venue "${v.name}" (${v.id}, home of ${v.homeClubIds?.join(', ')})`,
    );
  for (const u of update)
    console.log(
      `${args.confirm ? 'update' : '[dry-run] would update'} venue "${u.venue.name}": +homeClubIds ${u.added.join(', ')}`,
    );

  // ── Aliases ──
  const { add, conflicts } = aliasMerge(config);
  const nAdd = Object.keys(add).length;
  console.log(
    `\nVenue aliases: ${nAdd} to ${args.confirm ? 'add' : 'add [dry-run]'} (${Object.keys(add).join(', ') || 'none'}), ${Object.keys(EMCU_VENUE_ALIASES).length - nAdd - conflicts.length} already present`,
  );
  for (const c of conflicts) console.log(`  ⚠ alias conflict left alone: ${c}`);
  // Every alias must land on a real registry ground (after this run's creates).
  const registryKeys = new Set([...venues, ...create].map((v) => groundKey(v.name, {})));
  for (const [k, target] of Object.entries(EMCU_VENUE_ALIASES))
    if (!registryKeys.has(target))
      console.log(`  ⚠ alias ${k} → ${target}: no registry venue has that name`);

  if (!newClubs.length && !create.length && !update.length && !nAdd) {
    console.log('\nNothing to do — all prerequisites already in place.');
    return;
  }
  if (!args.confirm) {
    console.log('\n[dry-run] nothing written. Re-run with --confirm to apply.');
    return;
  }
  for (const c of newClubs) {
    await repo.createClub(EMCU_TENANT, c);
    console.log(`wrote club ${c.id}`);
  }
  for (const v of create) {
    await repo.putVenue(EMCU_TENANT, v);
    console.log(`wrote venue ${v.id}`);
  }
  for (const u of update) {
    await repo.putVenue(EMCU_TENANT, u.venue);
    console.log(`updated venue ${u.venue.id}`);
  }
  if (nAdd) {
    // TenantConfig has no version guard — re-read just before writing (same as the console save).
    const fresh = await repo.getTenantConfig(EMCU_TENANT);
    if (!fresh) throw new Error(`tenant config for "${EMCU_TENANT}" vanished mid-run`);
    const freshAdd = aliasMerge(fresh).add;
    const competitionDefaults = validateCompetitionDefaults({
      ...(fresh.competitionDefaults ?? {}),
      venueAliases: { ...(fresh.competitionDefaults?.venueAliases ?? {}), ...freshAdd },
    });
    await repo.putTenantConfig({ ...fresh, competitionDefaults });
    console.log(`wrote tenant config (+${Object.keys(freshAdd).length} venue alias(es))`);
  }
  console.log('Done.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
