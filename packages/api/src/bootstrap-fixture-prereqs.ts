/**
 * One-off prerequisites for the 2026/27 fixture amendment import (see
 * import-planb-fixtures.ts and docs/runbooks/planb-fixtures-import.md):
 *
 *   npx sst shell --stage prod -- npm --prefix packages/api run bootstrap-fixture-prereqs            # dry-run
 *   npx sst shell --stage prod -- npm --prefix packages/api run bootstrap-fixture-prereqs -- --confirm
 *
 * Adds the two veterans league entries the import fails closed on, and creates club
 * records for the two Promotion Women Group B clubs the 16 Aug 2026 dry run showed do
 * not exist on the dolphins tenant. Idempotent: existing leagues/clubs are left
 * untouched and reported, so re-running after a partial write is safe.
 *
 * The club records are deliberately skeletal — the names satisfy the import's
 * normalise() matching ("Parkgate" → parkgate, "FAM" → fam), while district, chair and
 * ground are placeholders the admin corrects in the console once the union supplies
 * details. League group/district are copied from an existing league entry so the new
 * ones file under the same console grouping.
 */
import * as repo from './repo.js';
import { clubIdFromName } from './club-id.js';
import { normalise } from './import-planb-fixtures.js';
import type { Club, League, Venue } from './types.js';

const TENANT = 'dolphins';

const NEW_LEAGUES: Array<Pick<League, 'key' | 'label'>> = [
  { key: 'veterans-premier', label: 'Veterans Premier' },
  { key: 'veterans-promotion', label: 'Veterans Promotion' },
];

/** Names chosen so the fixture sheets' "Parkgate" and "FAM" resolve via normalise();
 * rename freely in the console — resolution also matches on the club id. */
const NEW_CLUBS = ['Parkgate Cricket Club', 'FAM Cricket Club'];
const NEW_CLUB_LEAGUES = ['promotion-women-s-league'];

function modalDistrict(clubs: Club[]): string {
  const counts = new Map<string, number>();
  for (const c of clubs) counts.set(c.district, (counts.get(c.district) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

async function main() {
  const confirm = process.argv.includes('--confirm');

  const [config, clubs] = await Promise.all([repo.getTenantConfig(TENANT), repo.listClubs(TENANT)]);
  if (!config) throw new Error(`no tenant config for "${TENANT}"`);

  // ── Leagues ──
  const have = new Set((config.leagues ?? []).map((l) => l.key));
  // Template for group/district: the existing veterans league if present, else premier.
  const template =
    (config.leagues ?? []).find((l) => l.key === 'veterans') ??
    (config.leagues ?? []).find((l) => l.key === 'premier');
  const leaguesToAdd = NEW_LEAGUES.filter((l) => !have.has(l.key)).map((l) => ({
    ...l,
    group: template?.group ?? '',
    district: template?.district ?? '',
  }));
  for (const l of NEW_LEAGUES) {
    if (have.has(l.key)) console.log(`league ${l.key} — already exists, untouched`);
  }
  for (const l of leaguesToAdd) {
    console.log(
      `${confirm ? 'add' : '[dry-run] would add'} league ${l.key} ("${l.label}", group "${l.group}", district "${l.district}")`,
    );
  }

  // ── Clubs ──
  const byNorm = new Map(clubs.map((c) => [normalise(c.name), c]));
  const district = modalDistrict(clubs);
  const clubsToAdd: Club[] = [];
  for (const name of NEW_CLUBS) {
    const existing = byNorm.get(normalise(name));
    if (existing) {
      console.log(
        `club "${name}" — already resolves to ${existing.name} (${existing.id}), untouched`,
      );
      continue;
    }
    const id = clubIdFromName(name);
    clubsToAdd.push({
      id,
      name,
      district,
      sub: '',
      chair: '',
      affiliation: 'not_started',
      cqi: 0,
      docs: {},
      players: 0,
      teams: 1,
      women: 1,
      juniors: 0,
      color: '#0E7C6B',
      ground: {},
      leagues: NEW_CLUB_LEAGUES,
      version: 1,
    } as Club);
    console.log(
      `${confirm ? 'create' : '[dry-run] would create'} club "${name}" (${id}) — district "${district}" is a PLACEHOLDER; fix district/chair/ground in the console once the union confirms details`,
    );
  }

  // ── Venue registry sync (the prod registry was empty on the 16 Aug dry runs) ──
  // Mirrors the console's "Sync from club records" (venuesFromClubGrounds,
  // src/venues-card.tsx:441): one venue per distinct ground NAME, primary grounds with
  // the affiliation pin, secondaries without coordinates, ground-sharing clubs merged
  // into homeClubIds, surfaces 1. Existing registry names are never touched, so this
  // composes with a console sync run before or after it.
  const existingVenues = await repo.listVenues(TENANT);
  const byName = new Map(existingVenues.map((v) => [v.name.trim().toLowerCase(), v]));
  const venuesToAdd = new Map<string, Venue>();
  const addGround = (name: string | undefined, clubId: string, extras: Partial<Venue>) => {
    const trimmed = name?.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (byName.has(key)) return; // registry already knows it — console owns it
    const pending = venuesToAdd.get(key);
    if (pending) {
      if (!pending.homeClubIds?.includes(clubId))
        pending.homeClubIds = [...(pending.homeClubIds ?? []), clubId];
      return;
    }
    venuesToAdd.set(key, {
      id: `v-${trimmed
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')}`,
      name: trimmed,
      homeClubIds: [clubId],
      surfaces: 1,
      ...extras,
    } as Venue);
  };
  for (const c of clubs) {
    const g = c.ground ?? {};
    addGround(g.venue, c.id, {
      address: g.address,
      suburb: g.suburb,
      ...(Number.isFinite(g.lat) && Number.isFinite(g.lon) ? { lat: g.lat, lon: g.lon } : {}),
    });
    addGround(g.secondaryVenue, c.id, { address: g.secondaryAddress });
  }
  console.log(
    `\nVenue registry: ${existingVenues.length} existing · ${venuesToAdd.size} to create from club grounds`,
  );
  for (const v of venuesToAdd.values()) {
    const pinned = Number.isFinite(v.lat) && Number.isFinite(v.lon) ? 'pinned' : 'no pin';
    console.log(
      `${confirm ? 'create' : '[dry-run] would create'} venue "${v.name}" (${v.id} · ${pinned} · home of ${v.homeClubIds?.join(', ')})`,
    );
  }

  if (!leaguesToAdd.length && !clubsToAdd.length && !venuesToAdd.size) {
    console.log('Nothing to do — all prerequisites already in place.');
    return;
  }
  if (!confirm) {
    console.log('[dry-run] nothing written. Re-run with --confirm to apply.');
    return;
  }

  if (leaguesToAdd.length) {
    // TenantConfig has no version guard (see repo.ts) — same read-modify-write the
    // console's Settings save does. Re-read just before writing to keep the window small.
    const fresh = await repo.getTenantConfig(TENANT);
    if (!fresh) throw new Error(`tenant config for "${TENANT}" vanished mid-run`);
    const freshHave = new Set((fresh.leagues ?? []).map((l) => l.key));
    const still = leaguesToAdd.filter((l) => !freshHave.has(l.key));
    await repo.putTenantConfig({ ...fresh, leagues: [...(fresh.leagues ?? []), ...still] });
    console.log(`wrote tenant config (+${still.length} league(s))`);
  }
  for (const club of clubsToAdd) {
    await repo.putClub(TENANT, club);
    console.log(`wrote club ${club.id}`);
  }
  for (const v of venuesToAdd.values()) {
    await repo.putVenue(TENANT, v);
    console.log(`wrote venue ${v.id}`);
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
