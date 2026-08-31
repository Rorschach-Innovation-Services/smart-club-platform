/**
 * Merge duplicate venue-registry rows — collapse two spellings of one physical ground
 * into a single row and repoint every fixture that referenced the loser.
 *
 *   npx sst shell --stage prod -- npm --prefix packages/api run merge-duplicate-venues            # dry run
 *   npx sst shell --stage prod -- npm --prefix packages/api run merge-duplicate-venues -- --confirm
 *
 * WHY THIS EXISTS — the venue registry (ADR 0008 phase 2) grew duplicate rows for one
 * ground under two spellings (a club record's spelling beside the union's, e.g.
 * "CHATSWORTH OVAL" vs "Chatsworth Cricket Oval"). `groundKey()` from venue-clash.ts
 * already collapses each pair to one ledger/registry key via VENUE_ALIASES, so the two
 * rows contend for the same field — but they remain two separate registry items, two
 * homeClubIds lists, two pins. This script picks a survivor per duplicate group, folds
 * the loser's data into it, repoints every fixture that pointed at the loser, and deletes
 * the loser. It also removes junk rows named "None"/"N/A"/… that carry no real ground.
 *
 * GENERIC — it groups ALL registry rows by groundKey and acts on every group with more
 * than one row, so it is not hard-coded to today's five pairs. Idempotent: once a group
 * is collapsed there is only one row for that key, so a re-run is a no-op. Dry-run by
 * default; --confirm writes. Before any write it takes a JSON backup of every venue row
 * and every series it will modify (mirrors backupExistingSeries in import-planb-fixtures.ts).
 *
 * THE ONLY PERSISTED VENUE-ID REFERENCE is a fixture's `venueId` on a Series (verified by
 * grep over packages/api/src and src/ on 31 Aug 2026): TenantConfig, SeasonRun structure/
 * calendar snapshots, club ground records and Series participants all reference venues by
 * NAME, never by id. So repointing = rewriting fixtures' venueId/venueName. Any fixture
 * that names a loser by `venueName`/`venueOverride` WITHOUT a matching `venueId` link is
 * listed as an unhandled reference site rather than silently skipped.
 */
import { writeFile } from 'node:fs/promises';
import { groundKey, normaliseName, JUNK_GROUND } from './venue-clash.js';
import type { Series, Venue } from './types.js';

const TENANT = 'dolphins';

/** A stored fixture — only the venue fields matter here; everything else is preserved. */
interface StoredFixture {
  id?: string;
  venueId?: string;
  venueName?: string;
  venueOverride?: string;
  [key: string]: unknown;
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** The Durban city-centre placeholder several club records were seeded with (Saints, PTCC,
 * Ilembe, Lindelani all carry it verbatim). It is not a real pin, so it must neither count
 * as one when choosing a survivor nor be copied onto a survivor as a "fill". */
const PLACEHOLDER_PIN = { lat: -29.861825, lon: 31.009909 };

function hasPin(v: Venue): boolean {
  if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) return false;
  return !(v.lat === PLACEHOLDER_PIN.lat && v.lon === PLACEHOLDER_PIN.lon);
}

/** normaliseName equals the group key ⇒ this spelling is the canonical registry form
 * (it did not have to pass through VENUE_ALIASES to reach the key). */
function isCanonical(v: Venue, key: string): boolean {
  return normaliseName(v.name) === key;
}

/** Count each venue id's references across every fixture of every series. */
function fixtureCounts(allSeries: Series[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of allSeries) {
    for (const f of (s.fixtures as StoredFixture[]) ?? []) {
      if (f.venueId) counts.set(f.venueId, (counts.get(f.venueId) ?? 0) + 1);
    }
  }
  return counts;
}

interface Ranked {
  venue: Venue;
  count: number;
  canonical: boolean;
  pin: boolean;
}

/** Deterministic survivor order (coordinator directive, 31 Aug 2026):
 *   1. MORE fixtures (fewest released-series rewrites)
 *   2. canonical spelling (normalised name == group key, no alias)
 *   3. a real pin (finite lat AND lon)
 *   4. lexically smaller id
 * Returns the sorted candidates (survivor first). */
function rankGroup(group: Venue[], counts: Map<string, number>, key: string): Ranked[] {
  return group
    .map((venue) => ({
      venue,
      count: counts.get(venue.id) ?? 0,
      canonical: isCanonical(venue, key),
      pin: hasPin(venue),
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        Number(b.canonical) - Number(a.canonical) ||
        Number(b.pin) - Number(a.pin) ||
        String(a.venue.id).localeCompare(String(b.venue.id)),
    );
}

/** The first rule that separates the survivor from the runner-up — printed as the reason. */
function decidingReason(survivor: Ranked, runnerUp: Ranked): string {
  if (survivor.count !== runnerUp.count)
    return `more fixtures (${survivor.count} vs ${runnerUp.count})`;
  if (survivor.canonical !== runnerUp.canonical)
    return 'canonical spelling (normalised name == group key)';
  if (survivor.pin !== runnerUp.pin) return 'has a real pin';
  return 'lexically smaller id';
}

interface Merge {
  survivor: Venue;
  losers: Venue[];
  key: string;
  reason: string;
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const repo = await import('./repo.js');

  const [venues, allSeries] = await Promise.all([repo.listVenues(TENANT), repo.listSeries(TENANT)]);
  const counts = fixtureCounts(allSeries);

  const hardErrors: string[] = [];

  // ── Junk rows (name is "None"/"N/A"/"-"/"TBD"/"TBC") ──
  // A junk row that no fixture references is deleted; one that IS referenced is a hard
  // error (deleting it would orphan those fixtures' venueId) — reported, never deleted.
  const junkRows = venues.filter((v) => JUNK_GROUND.test(v.name.trim()));
  const junkToDelete: Venue[] = [];
  for (const j of junkRows) {
    const refs = (counts.get(j.id) ?? 0) > 0;
    if (refs) {
      const where: string[] = [];
      for (const s of allSeries) {
        const n = ((s.fixtures as StoredFixture[]) ?? []).filter((f) => f.venueId === j.id).length;
        if (n) where.push(`${s.id}×${n}`);
      }
      hardErrors.push(
        `junk row "${j.name}" (${j.id}) is referenced by fixtures — resolve before deleting: ${where.join(', ')}`,
      );
    } else {
      junkToDelete.push(j);
    }
  }
  const junkIds = new Set(junkRows.map((v) => v.id));

  // ── Duplicate groups: all non-junk rows grouped by groundKey ──
  const groups = new Map<string, Venue[]>();
  for (const v of venues) {
    if (junkIds.has(v.id)) continue;
    const key = groundKey(v.name);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(v);
  }

  const merges: Merge[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const ranked = rankGroup(group, counts, key);
    const survivor = ranked[0].venue;
    const reason = decidingReason(ranked[0], ranked[1]);
    merges.push({ survivor, losers: ranked.slice(1).map((r) => r.venue), key, reason });
  }

  // Nothing to do?
  if (!merges.length && !junkToDelete.length && !hardErrors.length) {
    console.log('No duplicate venue groups and no junk rows — registry is clean.');
    return;
  }

  // ── Plan the merges (compute survivor field fills + fixture repoints) ──
  const survivorWrites = new Map<string, Venue>(); // id → mutated survivor
  const loserDeletes: Venue[] = [];
  const seriesEdits = new Map<string, { series: Series; count: number }>();
  const nameOnlyRefs: string[] = []; // loser referenced by name without a venueId link
  const IDENTITY_FIELDS = new Set(['id', 'name', 'lat', 'lon', 'homeClubIds']);

  for (const m of merges) {
    // Mutate a shallow copy so the backup (taken from `venues`) keeps the pre-merge row.
    const survivor: Venue = survivorWrites.get(m.survivor.id) ?? { ...m.survivor };
    const fills: string[] = [];

    for (const loser of m.losers) {
      // homeClubIds: union, survivor order first.
      const merged = [...(survivor.homeClubIds ?? [])];
      for (const c of loser.homeClubIds ?? []) if (!merged.includes(c)) merged.push(c);
      if (merged.length !== (survivor.homeClubIds ?? []).length) {
        const added = merged.filter((c) => !(survivor.homeClubIds ?? []).includes(c));
        survivor.homeClubIds = merged;
        fills.push(`homeClubIds += [${added.join(', ')}] (from ${loser.id})`);
      }

      // Pin (lat+lon as a pair): only when the survivor lacks a finite pin.
      if (!hasPin(survivor) && hasPin(loser)) {
        survivor.lat = loser.lat;
        survivor.lon = loser.lon;
        fills.push(`lat/lon ← ${loser.lat},${loser.lon} (from ${loser.id})`);
      }

      // Every other scalar/array field: fill only where the survivor's is missing/empty.
      for (const k of Object.keys(loser) as (keyof Venue)[]) {
        if (IDENTITY_FIELDS.has(k as string)) continue;
        if (isEmpty(survivor[k]) && !isEmpty(loser[k])) {
          (survivor as unknown as Record<string, unknown>)[k as string] = loser[k];
          fills.push(`${String(k)} ← ${JSON.stringify(loser[k])} (from ${loser.id})`);
        }
      }

      loserDeletes.push(loser);
    }

    survivorWrites.set(survivor.id, survivor);

    // Repoint fixtures: venueId === loser.id → survivor id/name. Also catch name-only refs.
    const loserIds = new Set(m.losers.map((l) => l.id));
    const loserNames = new Set(m.losers.map((l) => l.name));
    for (const s of allSeries) {
      let n = 0;
      for (const f of (s.fixtures as StoredFixture[]) ?? []) {
        if (f.venueId && loserIds.has(f.venueId)) {
          f.venueId = survivor.id;
          f.venueName = survivor.name;
          n++;
        } else if (
          (f.venueName && loserNames.has(f.venueName)) ||
          (f.venueOverride && loserNames.has(f.venueOverride))
        ) {
          nameOnlyRefs.push(
            `${s.id}/${f.id ?? '?'}: names "${f.venueOverride || f.venueName}" (no venueId link to the loser row)`,
          );
        }
      }
      if (n) {
        const prev = seriesEdits.get(String(s.id))?.count ?? 0;
        seriesEdits.set(String(s.id), { series: s, count: prev + n });
      }
    }

    // ── Print the group plan ──
    console.log(`\n■ ${m.key}`);
    console.log(`  keep ${survivor.name} (${survivor.id}) — ${m.reason}`);
    for (const loser of m.losers)
      console.log(`  ← merge ${loser.name} (${loser.id}, ${counts.get(loser.id) ?? 0} fixtures)`);
    if (fills.length) for (const f of fills) console.log(`    fill: ${f}`);
    else console.log('    fill: (survivor already carries every field)');
  }

  // ── Fixture repoint summary ──
  if (seriesEdits.size) {
    console.log('\nFixtures to repoint:');
    for (const { series, count } of seriesEdits.values())
      console.log(
        `  ${series.id} (${series.released ? 'RELEASED' : 'draft'}): ${count} fixture(s)`,
      );
  } else {
    console.log('\nFixtures to repoint: none.');
  }

  // ── Junk rows ──
  if (junkToDelete.length) {
    console.log('\nJunk rows to delete:');
    for (const j of junkToDelete) console.log(`  ${j.name} (${j.id})`);
  }

  // ── Unhandled reference sites ──
  // The only persisted venue-id reference is a fixture's venueId (handled above). Name-only
  // references to a loser row are listed so they are never silently dropped.
  if (nameOnlyRefs.length) {
    console.log(
      '\nUnhandled reference sites (loser named without a venueId link — NOT rewritten):',
    );
    for (const r of nameOnlyRefs) console.log(`  ${r}`);
  } else {
    console.log('\nUnhandled reference sites: none.');
  }

  // ── Hard errors abort before any write ──
  if (hardErrors.length) {
    console.error('\nHARD ERRORS — nothing written:');
    for (const e of hardErrors) console.error(`  ✗ ${e}`);
    process.exitCode = 1;
    return;
  }

  if (!confirm) {
    console.log('\n[dry-run] nothing written. Re-run with --confirm to apply.');
    return;
  }

  // ── Backup: every venue row (pre-merge) + every series to be modified (pre-edit copies
  // are gone once we mutated in place, so back up the mutated series is wrong — capture
  // from the original allSeries objects, which we mutated; store the current form so a
  // restore re-applies the intended state, alongside the pristine venue rows). To keep a
  // true pre-write snapshot of series, re-read them fresh. ──
  const editedIds = new Set(seriesEdits.keys());
  const freshSeries = await Promise.all([...editedIds].map((id) => repo.getSeries(TENANT, id)));
  const backup = {
    tenant: TENANT,
    at: new Date().toISOString(),
    venues, // pristine — mutations were made on shallow copies
    series: freshSeries.filter(Boolean),
  };
  const backupPath = `./venue-merge-backup-${TENANT}-${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')}.json`;
  await writeFile(backupPath, JSON.stringify(backup, null, 2));
  console.log(
    `\nBackup written: ${backupPath} (${venues.length} venues, ${backup.series.length} series)`,
  );

  // Series first, so a survivor/loser write can never race ahead of the fixtures pointing
  // at it. Version bump mirrors import-planb-fixtures' write loop.
  for (const { series, count } of seriesEdits.values()) {
    series.version = (Number(series.version) || 1) + 1;
    await repo.putSeries(TENANT, series);
    console.log(`wrote ${series.id} v${series.version} (${count} fixture(s) repointed)`);
  }
  for (const survivor of survivorWrites.values()) {
    await repo.putVenue(TENANT, survivor);
    console.log(`updated survivor venue ${survivor.id}`);
  }
  for (const loser of loserDeletes) {
    await repo.deleteVenue(TENANT, loser.id);
    console.log(`deleted loser venue ${loser.id}`);
  }
  for (const j of junkToDelete) {
    await repo.deleteVenue(TENANT, j.id);
    console.log(`deleted junk venue ${j.id}`);
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
