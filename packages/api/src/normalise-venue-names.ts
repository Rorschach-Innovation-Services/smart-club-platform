/**
 * Normalise dolphins venue names to exact field numbers (union directive, 31 Aug 2026).
 *
 *   npx sst shell --stage prod -- npm --prefix packages/api run normalise-venue-names            # dry run
 *   npx sst shell --stage prod -- npm --prefix packages/api run normalise-venue-names -- --confirm
 *
 * WHY THIS EXISTS — the union requires every multi-field complex to be named by exact field
 * number. Three kinds of change, computed together and gated on a whole-tenant clash scan
 * before anything is written:
 *
 *   1. RENAME registry rows (keep ids): "Siripat Road Grounds" → "Siripat 1", etc. Every
 *      fixture pointing at the row by venueId gets the new venueName; a fixture that NAMES the
 *      old spelling without a venueId link is linked (venueId + venueName set).
 *   2. MERGE generic complex rows ("Cato Manor", "Harlequins", "Highbury grounds") into a
 *      numbered field, lowest free field first. Each fixture on the generic row is re-booked
 *      onto the first candidate field with no clash at its date+time (season-wide ledger,
 *      exactly like the import's clash pass); the generic row's homeClubIds are unioned onto
 *      the first candidate and the generic row is deleted.
 *   3. RENAME the ground names on club records (venue / secondaryVenue). Fixtures with NO
 *      explicit venue take the home club's ground name at display time, so renaming the club
 *      record automatically renames those implicit fixtures — no fixture write for them.
 *   4. CREATE reserved Commons 1 / Commons 2 registry rows for Premier Women.
 *
 * THE ONLY PERSISTED VENUE-ID REFERENCE is a fixture's `venueId` on a Series (same finding as
 * merge-duplicate-venues.ts): TenantConfig, season-run snapshots, club ground records and
 * series participants all reference venues by NAME, never by id. So the fixture rewrites here
 * are venueId/venueName edits; club-record renames are name edits.
 *
 * Dry-run by default; --confirm writes. Before any write it takes a JSON backup of every venue
 * row and every series/club it will modify (mirrors merge-duplicate-venues.ts). Any hard error
 * (registry drift, an unresolvable generic candidate, a fixture with no free field, or a NEW
 * clash the changes would introduce) aborts before a single write.
 */
import { writeFile } from 'node:fs/promises';
import {
  groundKey,
  normaliseName,
  registryResolver,
  GroundLedger,
  JUNK_GROUND,
} from './venue-clash.js';
import type { Club, Series, Venue } from './types.js';

const TENANT = 'dolphins';

/** A stored fixture — only the venue/scheduling fields matter; everything else is preserved. */
interface StoredFixture {
  id?: string;
  date?: string;
  time?: string;
  home?: string;
  status?: string;
  venueId?: string;
  venueName?: string;
  venueOverride?: string;
  [key: string]: unknown;
}

// ── Step 1: registry-row renames (id preserved) ──
interface Rename {
  id: string;
  oldName: string;
  newName: string;
}
const RENAMES: Rename[] = [
  { id: 'v-siripat-road-grounds', oldName: 'Siripat Road Grounds', newName: 'Siripat 1' },
  { id: 'v-siripat-grounds', oldName: 'Siripat Grounds', newName: 'Siripat 2' },
  { id: 'v-crusaders-sports-club', oldName: 'Crusaders Sports Club', newName: 'Crusaders 1' },
  { id: 'v-crusaders-2-field', oldName: 'Crusaders 2 Field', newName: 'Crusaders 2' },
  { id: 'v-danville', oldName: 'Danville', newName: 'Danville 1' },
  {
    id: 'v-van-riebek-park-harlequins-1',
    oldName: 'Van Riebek Park (Harlequins 1)',
    newName: 'Harlequins 1',
  },
  {
    id: 'v-van-riebek-park-harlequins-2',
    oldName: 'Van Riebek Park (Harlequins 2)',
    newName: 'Harlequins 2',
  },
];

// ── Step 2: generic complex rows merged into a numbered field, lowest free first ──
interface GenericMerge {
  genericId: string;
  oldName: string;
  /** Candidate field names in preference order (resolved to registry rows AFTER renames). */
  candidates: string[];
}
const GENERICS: GenericMerge[] = [
  {
    genericId: 'v-cato-manor',
    oldName: 'Cato Manor',
    candidates: ['Cato Manor 1', 'Cato Manor 2', 'Cato Manor 4', 'Cato Manor 5'],
  },
  {
    genericId: 'v-cator-manor',
    oldName: 'Cator Manor',
    candidates: ['Cato Manor 1', 'Cato Manor 2', 'Cato Manor 4', 'Cato Manor 5'],
  },
  {
    genericId: 'v-harlequins',
    oldName: 'Harlequins',
    candidates: ['Harlequins 1', 'Harlequins 2'],
  },
  {
    genericId: 'v-highbury-grounds',
    oldName: 'Highbury grounds',
    candidates: ['Highbury 1', 'Highbury 2', 'Highbury 3'],
  },
];

// ── Step 3: club-record ground renames (venue / secondaryVenue) ──
interface ClubGroundEdit {
  clubId: string;
  field: 'venue' | 'secondaryVenue';
  oldName: string;
  newName: string;
}
const CLUB_EDITS: ClubGroundEdit[] = [
  { clubId: 'crusaders', field: 'venue', oldName: 'Crusaders Sports Club', newName: 'Crusaders 1' },
  {
    clubId: 'crusaders',
    field: 'secondaryVenue',
    oldName: 'Crusaders 2 Field',
    newName: 'Crusaders 2',
  },
  {
    clubId: 'rhythm-dhsob-cricket-club',
    field: 'venue',
    oldName: 'Danville',
    newName: 'Danville 1',
  },
  {
    clubId: 'rhythm-dhsob-cricket-club',
    field: 'secondaryVenue',
    oldName: '',
    newName: 'Danville 2',
  },
  {
    clubId: 'simplex-reservoir-hills-crimson',
    field: 'venue',
    oldName: 'Siripat Road Grounds',
    newName: 'Siripat 1',
  },
  {
    clubId: 'durban-university-of-technology-dut',
    field: 'venue',
    oldName: 'Siripat Grounds',
    newName: 'Siripat 2',
  },
  {
    clubId: 'umlazi-cricket-club',
    field: 'secondaryVenue',
    oldName: 'Siripat grounds',
    newName: 'Siripat 2',
  },
  {
    clubId: 'harlequins-cricket-club',
    field: 'venue',
    oldName: 'Van Riebek Park (Harlequins 1)',
    newName: 'Harlequins 1',
  },
  {
    clubId: 'harlequins-cricket-club',
    field: 'secondaryVenue',
    oldName: 'Van Riebek Park (Harlequins 2)',
    newName: 'Harlequins 2',
  },
  {
    clubId: 'chesterville-cricket-clube',
    field: 'venue',
    oldName: 'Cato Manor',
    newName: 'Cato Manor 1',
  },
  { clubId: 'fam-kwamakhutha', field: 'venue', oldName: 'Harlequins', newName: 'Harlequins 1' },
  {
    clubId: 'lamontville-cc',
    field: 'secondaryVenue',
    oldName: 'Cator Manor',
    newName: 'Cato Manor 1',
  },
  {
    clubId: 'merebank-cricket-club',
    field: 'secondaryVenue',
    oldName: 'Highbury grounds',
    newName: 'Highbury 1',
  },
];

// ── Step 4: reserved Commons rows for Premier Women ──
const COMMONS_NAMES = ['Commons 1', 'Commons 2'];
const COMMONS_NOTE = 'Reserved for Premier Women (union, 31 Aug 2026)';
const PREMIER_WOMEN_SERIES_PREFIX = 's-planb-premier-women-';

/** Mint a venue id the way bootstrap-fixture-prereqs does: v-<name kebab-cased>. */
function venueIdFromName(name: string): string {
  return `v-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')}`;
}

/** Trimmed, case-insensitive equality — club/registry records carry trailing spaces and odd case. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * A fixture's effective ground: explicit venue fields, else the home side's club ground via the
 * series participants snapshot (legacy series: `home` IS a clubId). Mirrors effectiveGround in
 * venue-clash.ts (not exported there).
 */
function effectiveGround(
  s: Series,
  f: StoredFixture,
  clubsById: Map<string, Club>,
): string | undefined {
  const explicit = f.venueOverride || f.venueName;
  if (explicit) return explicit;
  if (!f.home) return undefined;
  const participants = s.participants;
  const homeClubId = participants ? participants.find((p) => p.teamId === f.home)?.clubId : f.home;
  const own = homeClubId ? clubsById.get(homeClubId)?.ground?.venue?.trim() : undefined;
  return own && !JUNK_GROUND.test(own) ? own : undefined;
}

/** Does a fixture reference this generic row — by venueId, or by name with no venueId link? */
function refsGeneric(f: StoredFixture, genericId: string, genericName: string): boolean {
  if (f.venueId) return f.venueId === genericId;
  const nm = f.venueOverride || f.venueName;
  return !!nm && normaliseName(nm) === normaliseName(genericName);
}

/**
 * A whole-tenant clash scan. Books every fixture of every series into one ledger in a
 * deterministic (date, id) order and records each collision as a naming-INDEPENDENT signature:
 * the unordered pair of the two fixtures' global ids plus date/time. Because the signature keys
 * on fixture identity (never on the ground name, which the renames/merges change), the pre- and
 * post-change scans can be compared to tell a NEW clash from a pre-existing one.
 */
function scanClashes(
  allSeries: Series[],
  clubs: Club[],
  venues: Venue[],
): { signatures: Set<string>; lines: string[] } {
  const clubsById = new Map(clubs.map((c) => [c.id, c]));
  const ledger = new GroundLedger(registryResolver(venues));
  const bookings: Array<{
    gid: string;
    ground: string;
    date: string;
    time?: string;
    seriesId: string;
    fixtureId: string;
  }> = [];
  for (const s of allSeries) {
    for (const f of (s.fixtures as StoredFixture[]) ?? []) {
      if (!f.date || f.status === 'cancelled') continue;
      const ground = effectiveGround(s, f, clubsById);
      if (!ground) continue;
      bookings.push({
        gid: `${s.id}/${f.id ?? '?'}`,
        ground,
        date: f.date,
        time: f.time,
        seriesId: String(s.id),
        fixtureId: f.id ?? '',
      });
    }
  }
  bookings.sort((a, b) => a.date.localeCompare(b.date) || a.gid.localeCompare(b.gid));
  const signatures = new Set<string>();
  const lines: string[] = [];
  for (const b of bookings) {
    const hit = ledger.check(b.ground, b.date, b.time);
    if (hit) {
      const other = `${hit.seriesId}/${hit.fixtureId}`;
      const sig = `${[b.gid, other].sort().join('|')}@${b.date}${b.time ? ' ' + b.time : ''}`;
      if (!signatures.has(sig)) {
        signatures.add(sig);
        lines.push(
          `${b.ground} on ${b.date}${b.time ? ' ' + b.time : ''}: ${b.gid} clashes ${other}`,
        );
      }
    }
    ledger.book(b.ground, b.date, b.time, {
      seriesId: b.seriesId,
      fixtureId: b.fixtureId,
      date: b.date,
      time: b.time,
    });
  }
  return { signatures, lines };
}

/** Count implicit home fixtures for a club (no explicit venue ⇒ they follow the club ground name). */
function implicitHomeCount(clubId: string, allSeries: Series[]): number {
  let n = 0;
  for (const s of allSeries) {
    for (const f of (s.fixtures as StoredFixture[]) ?? []) {
      if (!f.date || f.status === 'cancelled') continue;
      if (f.venueOverride || f.venueName) continue; // explicit venue — doesn't follow the club record
      if (!f.home) continue;
      const homeClubId = s.participants
        ? s.participants.find((p) => p.teamId === f.home)?.clubId
        : f.home;
      if (homeClubId === clubId) n++;
    }
  }
  return n;
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const repo = await import('./repo.js');

  const [venues, allSeries, clubs] = await Promise.all([
    repo.listVenues(TENANT),
    repo.listSeries(TENANT),
    repo.listClubs(TENANT),
  ]);

  const hardErrors: string[] = [];

  // ── Baseline clash scan (ORIGINAL state) — computed first, before any in-memory mutation. ──
  const pre = scanClashes(allSeries, clubs, venues);

  // Working copies of the registry (renames + homeClubIds unions land on these).
  const vById = new Map<string, Venue>(
    venues.map((v) => [v.id, { ...v, homeClubIds: [...(v.homeClubIds ?? [])] }]),
  );
  const dirtyVenueIds = new Set<string>();
  const dirtySeriesIds = new Set<string>();

  // ────────────────────────────────────────────────────────────────────────────────
  // Identify every generic-row fixture FIRST (by venueId or by NAME via normaliseName —
  // alias-free, so "Harlequins" is never confused with the renamed "Harlequins 1" row).
  // The rename-link step below skips these so it can never poach a generic fixture that the
  // merge step is about to distribute across numbered fields.
  // ────────────────────────────────────────────────────────────────────────────────
  interface MoveItem {
    genericId: string;
    s: Series;
    f: StoredFixture;
  }
  const toMove: MoveItem[] = [];
  const toMoveGids = new Set<string>();
  for (const g of GENERICS) {
    for (const s of allSeries) {
      for (const f of (s.fixtures as StoredFixture[]) ?? []) {
        if (refsGeneric(f, g.genericId, g.oldName)) {
          toMove.push({ genericId: g.genericId, s, f });
          toMoveGids.add(`${s.id}/${f.id ?? '?'}`);
        }
      }
    }
  }

  // ── Step 1: rename registry rows + repoint/link fixtures ──
  console.log('■ Step 1 — registry-row renames');
  for (const r of RENAMES) {
    const row = vById.get(r.id);
    if (!row) {
      hardErrors.push(`rename: registry row ${r.id} not found (expected "${r.oldName}")`);
      continue;
    }
    const isOld = normaliseName(row.name) === normaliseName(r.oldName);
    const isNew = normaliseName(row.name) === normaliseName(r.newName);
    if (isNew) {
      console.log(`  ${r.id} already "${r.newName}" — skipping rename (idempotent)`);
    } else if (isOld) {
      row.name = r.newName;
      dirtyVenueIds.add(r.id);
      console.log(`  ${r.id}: "${r.oldName}" → "${r.newName}"`);
    } else {
      hardErrors.push(
        `rename: registry row ${r.id} name "${row.name}" is neither the expected old "${r.oldName}" nor new "${r.newName}" — registry may have drifted`,
      );
      continue;
    }
    // Repoint fixtures pointing at the row by id; link fixtures naming the old spelling
    // (by groundKey) that carry no venueId — but never a fixture the generic merge owns.
    const oldKey = groundKey(r.oldName);
    let repointed = 0;
    let linked = 0;
    for (const s of allSeries) {
      let touched = false;
      for (const f of (s.fixtures as StoredFixture[]) ?? []) {
        if (f.venueId === r.id) {
          if (f.venueName !== r.newName) {
            f.venueName = r.newName;
            repointed++;
            touched = true;
          }
        } else if (!f.venueId && !toMoveGids.has(`${s.id}/${f.id ?? '?'}`)) {
          const nm = f.venueOverride || f.venueName;
          if (nm && groundKey(nm) === oldKey) {
            f.venueId = r.id;
            f.venueName = r.newName;
            linked++;
            touched = true;
          }
        }
      }
      if (touched) dirtySeriesIds.add(String(s.id));
    }
    if (repointed || linked)
      console.log(`    fixtures: ${repointed} repointed, ${linked} name-linked`);
  }

  // ── Step 2: merge generic rows into numbered fields (lowest free first) ──
  console.log('\n■ Step 2 — generic complex rows → numbered fields');
  const genericDeleteIds = new Set<string>();
  // Registry the allocator resolves against: post-rename, minus the generic rows being deleted.
  const buildAllocVenues = () => [...vById.values()].filter((v) => !genericDeleteIds.has(v.id));

  interface GenericPlan {
    genericId: string;
    candRows: Venue[];
  }
  const genericPlans = new Map<string, GenericPlan>();
  for (const g of GENERICS) {
    const row = vById.get(g.genericId);
    if (!row) {
      console.log(`  ${g.genericId} ("${g.oldName}") not found — already merged, skipping`);
      continue;
    }
    if (normaliseName(row.name) !== normaliseName(g.oldName)) {
      hardErrors.push(
        `generic merge: row ${g.genericId} name "${row.name}" ≠ expected "${g.oldName}" — registry may have drifted`,
      );
      continue;
    }
    // Resolve candidates to registry rows by groundKey, AFTER renames (Harlequins 1/2 are the
    // renamed Van Riebek rows). Candidate rows must exist to hold a venueId; the FIRST is where
    // the generic row's homeClubIds land.
    genericDeleteIds.add(g.genericId);
    const alloc = buildAllocVenues();
    const candRows: Venue[] = [];
    const missing: string[] = [];
    for (const name of g.candidates) {
      const match = alloc.find((v) => groundKey(v.name) === groundKey(name));
      if (match) candRows.push(match);
      else missing.push(name);
    }
    if (missing.length)
      console.log(`  ⚠ ${g.genericId}: no registry row for candidate(s) ${missing.join(', ')}`);
    if (!candRows.length) {
      hardErrors.push(
        `generic merge: ${g.genericId} ("${g.oldName}") has no resolvable candidate field — cannot merge`,
      );
      continue;
    }
    genericPlans.set(g.genericId, { genericId: g.genericId, candRows });
    // Union the generic row's homeClubIds onto the FIRST candidate.
    const first = candRows[0];
    const before = first.homeClubIds ?? [];
    const merged = [...before];
    for (const c of row.homeClubIds ?? []) if (!merged.includes(c)) merged.push(c);
    if (merged.length !== before.length) {
      first.homeClubIds = merged;
      dirtyVenueIds.add(first.id);
    }
    console.log(
      `  ${g.genericId} ("${g.oldName}") → merge into "${first.name}" (${first.id}); homeClubIds ${
        merged.length !== before.length
          ? `+= [${merged.filter((c) => !before.includes(c)).join(', ')}]`
          : '(no new clubs)'
      }; candidates: ${candRows.map((c) => c.name).join(' → ')}`,
    );
  }

  // Allocate the generic fixtures across candidate fields, lowest free first. One season-wide
  // ledger seeded with EVERY other fixture (post-rename effective grounds), then generic fixtures
  // booked in date order so earlier bookings inform later ones (exactly like the import pass).
  const postClubsForAlloc = clubs; // club-record renames don't change fixture-to-field allocation
  // (an implicit fixture's ground key is unchanged by a rename that maps onto the same field).
  const allocClubsById = new Map(postClubsForAlloc.map((c) => [c.id, c]));
  const allocLedger = new GroundLedger(registryResolver(buildAllocVenues()));
  for (const s of allSeries) {
    for (const f of (s.fixtures as StoredFixture[]) ?? []) {
      if (!f.date || f.status === 'cancelled') continue;
      if (toMoveGids.has(`${s.id}/${f.id ?? '?'}`)) continue; // moved fixtures are booked below
      const ground = effectiveGround(s, f, allocClubsById);
      if (!ground) continue;
      allocLedger.book(ground, f.date, f.time, {
        seriesId: String(s.id),
        fixtureId: f.id ?? '',
        date: f.date,
        time: f.time,
      });
    }
  }
  const movesInDateOrder = [...toMove].sort(
    (a, b) =>
      (a.f.date ?? '').localeCompare(b.f.date ?? '') ||
      `${a.s.id}/${a.f.id ?? '?'}`.localeCompare(`${b.s.id}/${b.f.id ?? '?'}`),
  );
  let bookedCount = 0;
  for (const item of movesInDateOrder) {
    const plan = genericPlans.get(item.genericId);
    if (!plan) continue; // its generic row was skipped/hard-errored above
    const { f, s } = item;
    const gid = `${s.id}/${f.id ?? '?'}`;
    let chosen: Venue | undefined;
    const blocks: string[] = [];
    if (!f.date) {
      // No date ⇒ nothing to clash on; book onto the first candidate deterministically.
      chosen = plan.candRows[0];
    } else {
      for (const cr of plan.candRows) {
        const hit = allocLedger.check(cr.name, f.date, f.time);
        if (!hit) {
          chosen = cr;
          break;
        }
        blocks.push(`${cr.name}←${hit.seriesId}/${hit.fixtureId}`);
      }
    }
    if (!chosen) {
      hardErrors.push(
        `generic merge: ${gid} on ${f.date}${f.time ? ' ' + f.time : ''} has no free field ` +
          `(tried ${plan.candRows.map((c) => c.name).join(', ')}; blocked: ${blocks.join('; ')})`,
      );
      continue;
    }
    f.venueId = chosen.id;
    f.venueName = chosen.name;
    dirtySeriesIds.add(String(s.id));
    bookedCount++;
    if (f.date)
      allocLedger.book(chosen.name, f.date, f.time, {
        seriesId: String(s.id),
        fixtureId: f.id ?? '',
        date: f.date,
        time: f.time,
      });
    console.log(
      `    booked ${gid} → "${chosen.name}" on ${f.date ?? '(no date)'}${f.time ? ' ' + f.time : ''}`,
    );
  }
  console.log(
    `  ${bookedCount}/${toMove.length} generic fixture(s) re-booked onto numbered fields`,
  );

  // ── Step 3: club-record ground renames ──
  console.log('\n■ Step 3 — club-record ground renames');
  const clubsById = new Map(clubs.map((c) => [c.id, c]));
  const clubWrites = new Map<string, Club>();
  const editsByClub = new Map<string, ClubGroundEdit[]>();
  for (const e of CLUB_EDITS)
    (editsByClub.get(e.clubId) ?? editsByClub.set(e.clubId, []).get(e.clubId)!).push(e);
  for (const [clubId, edits] of editsByClub) {
    const club = clubsById.get(clubId);
    if (!club) {
      hardErrors.push(`club rename: club ${clubId} not found`);
      continue;
    }
    const next = clubWrites.get(clubId) ?? { ...club, ground: { ...(club.ground ?? {}) } };
    let changed = false;
    for (const e of edits) {
      const current = (next.ground?.[e.field] ?? '') as string;
      if (sameName(current, e.newName)) {
        console.log(`  ${clubId}.${e.field} already "${e.newName}" — skipping (idempotent)`);
        continue;
      }
      if (!sameName(current, e.oldName)) {
        hardErrors.push(
          `club rename: ${clubId}.${e.field} is "${current}", expected old "${e.oldName}" (→ "${e.newName}") — record may have drifted`,
        );
        continue;
      }
      next.ground = { ...(next.ground ?? {}), [e.field]: e.newName };
      changed = true;
      console.log(`  ${clubId}.${e.field}: "${e.oldName || '(empty)'}" → "${e.newName}"`);
    }
    if (changed) {
      clubWrites.set(clubId, next);
      // A primary-venue rename also renames the club's implicit (venue-less) home fixtures at
      // display time — no fixture write is needed for them.
      if (edits.some((e) => e.field === 'venue')) {
        const n = implicitHomeCount(clubId, allSeries);
        console.log(`    ${n} implicit fixtures follow the club record (no fixture write)`);
      }
    }
  }
  for (const c of clubWrites.values()) c.version = (Number(c.version) || 0) + 1;

  // ── Step 4: reserved Commons rows ──
  console.log('\n■ Step 4 — reserved Commons rows (Premier Women)');
  const premierWomenClubIds = new Set<string>();
  for (const s of allSeries) {
    if (!String(s.id).startsWith(PREMIER_WOMEN_SERIES_PREFIX)) continue;
    for (const p of s.participants ?? []) if (p.clubId) premierWomenClubIds.add(p.clubId);
  }
  const homeClubIds = [...premierWomenClubIds].sort();
  const commonsToCreate: Venue[] = [];
  for (const name of COMMONS_NAMES) {
    const key = groundKey(name);
    const exists = [...vById.values()].some(
      (v) => !genericDeleteIds.has(v.id) && groundKey(v.name) === key,
    );
    if (exists) {
      console.log(`  "${name}" already in the registry — skipping (idempotent)`);
      continue;
    }
    const v: Venue = {
      id: venueIdFromName(name),
      name,
      homeClubIds,
      surfaces: 1,
      note: COMMONS_NOTE,
    };
    commonsToCreate.push(v);
    console.log(
      `  create "${name}" (${v.id}) — reserved; home of ${homeClubIds.length} Premier Women club(s)`,
    );
  }

  // ── Step 5: final whole-tenant clash gate ──
  console.log('\n■ Step 5 — clash gate');
  const postVenues = [...vById.values()]
    .filter((v) => !genericDeleteIds.has(v.id))
    .concat(commonsToCreate);
  const postClubs = clubs.map((c) => clubWrites.get(c.id) ?? c);
  const post = scanClashes(allSeries, postClubs, postVenues);
  const newClashes = [...post.signatures].filter((sig) => !pre.signatures.has(sig));
  const preExistingStill = [...post.signatures].filter((sig) => pre.signatures.has(sig));
  if (post.lines.length) {
    console.log('  post-change clashes:');
    for (const l of post.lines) console.log(`    ${l}`);
  } else {
    console.log('  post-change clashes: none');
  }
  console.log(
    `  pre-existing clashes: ${preExistingStill.length} (unchanged), new clashes: ${newClashes.length}`,
  );
  if (newClashes.length) {
    for (const sig of newClashes) hardErrors.push(`NEW clash introduced by the changes: ${sig}`);
  }

  // ── Hard errors abort before any write ──
  if (hardErrors.length) {
    console.error('\nHARD ERRORS — nothing written:');
    for (const e of hardErrors) console.error(`  ✗ ${e}`);
    process.exitCode = 1;
    return;
  }

  // ── Summary ──
  console.log('\nPlanned writes:');
  console.log(
    `  venues updated: ${dirtyVenueIds.size} · generic rows deleted: ${genericDeleteIds.size} · commons created: ${commonsToCreate.length}`,
  );
  console.log(`  series repointed: ${dirtySeriesIds.size} · clubs renamed: ${clubWrites.size}`);

  if (!confirm) {
    console.log('\n[dry-run] nothing written. Re-run with --confirm to apply.');
    return;
  }

  // ── Backup: pristine venue rows + fresh copies of every series/club to be modified ──
  const freshSeries = await Promise.all(
    [...dirtySeriesIds].map((id) => repo.getSeries(TENANT, id)),
  );
  const freshClubs = await Promise.all(
    [...clubWrites.keys()].map((id) => repo.getClub(TENANT, id)),
  );
  const backup = {
    tenant: TENANT,
    at: new Date().toISOString(),
    venues, // pristine — mutations were made on shallow copies
    series: freshSeries.filter(Boolean),
    clubs: freshClubs.filter(Boolean),
  };
  const backupPath = `./venue-normalise-backup-${TENANT}-${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')}.json`;
  await writeFile(backupPath, JSON.stringify(backup, null, 2));
  console.log(
    `\nBackup written: ${backupPath} (${venues.length} venues, ${backup.series.length} series, ${backup.clubs.length} clubs)`,
  );

  // Series first (so a venue rename/delete never races ahead of the fixtures pointing at it).
  for (const id of dirtySeriesIds) {
    const s = allSeries.find((x) => String(x.id) === id)!;
    s.version = (Number(s.version) || 1) + 1;
    await repo.putSeries(TENANT, s);
    console.log(`wrote series ${s.id} v${s.version}`);
  }
  for (const id of dirtyVenueIds) {
    await repo.putVenue(TENANT, vById.get(id)!);
    console.log(`updated venue ${id}`);
  }
  for (const v of commonsToCreate) {
    await repo.putVenue(TENANT, v);
    console.log(`created venue ${v.id}`);
  }
  for (const id of genericDeleteIds) {
    await repo.deleteVenue(TENANT, id);
    console.log(`deleted generic venue ${id}`);
  }
  for (const c of clubWrites.values()) {
    await repo.putClub(TENANT, c);
    console.log(`updated club ${c.id} v${c.version}`);
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
