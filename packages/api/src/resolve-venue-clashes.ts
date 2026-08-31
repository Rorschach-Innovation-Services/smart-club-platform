/**
 * Resolve residual ground/date/time clashes across the whole dolphins tenant by moving
 * ONE fixture per clash to a clash-free ground.
 *
 *   npx sst shell --stage prod -- npm --prefix packages/api run resolve-venue-clashes            # dry run
 *   npx sst shell --stage prod -- npm --prefix packages/api run resolve-venue-clashes -- --confirm
 *
 * WHY THIS EXISTS — after the plan-B import and the venue-name normalisation there can
 * still be a handful of double-bookings the union's own directives never covered (two
 * series that happen to land the same field on the same Sunday, a promotion game sharing
 * a ground with a premier one, the two Gledhow 50-over groups). This CLI finds every such
 * clash across the tenant, decides deterministically WHICH of the two fixtures should give
 * way, and re-books it onto the first clash-free ground in the same candidate chain the
 * importer uses. It refuses to write unless a fresh whole-tenant scan of the post-change
 * state shows ZERO clashes.
 *
 * Clash detection mirrors the scan in normalise-venue-names Step 5 exactly: every fixture
 * of every series (any lifecycle, skipping status 'cancelled') is booked into one
 * registry-resolved ledger; a fixture's effective ground is venueOverride || venueName ||
 * the home club's ground via the series participants snapshot.
 *
 * Dry-run by default; --confirm first writes a JSON backup of every touched series, then
 * writes each with version + 1. Any hard error (a fixture with no free candidate ground, or
 * a fixture that clashes again after already being moved this run) aborts before a single
 * write.
 */
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { groundKey, registryResolver, GroundLedger, JUNK_GROUND } from './venue-clash.js';
import type { Series, Venue } from './types.js';

const TENANT = 'dolphins';

/**
 * Grounds the union has ruled unusable — a mirror of BAD_CONDITION_GROUNDS in
 * src/import-planb-fixtures.ts (kept as a local copy on purpose: that module runs a heavy
 * spreadsheet import on load, so it is never imported here). Stored as groundKey() normal
 * forms; never offered as a move destination. Keep in sync with the importer's list.
 */
const BAD_CONDITION_GROUNDS = new Set(
  [
    'Asherville',
    'Badulla Drive',
    'Bayview (Bluff)',
    'Chatsworth 1111',
    'Chatsworth 306',
    'Chatsworth 3B',
    'Highbury Field',
    'John Dory',
    'Lt King Park',
    'Phoenix Blackhaven',
    'Phoenix Rainham',
    'Phoenix Sterngrove',
    'Phoenix Tynebridge',
    'Verulam Recreation Ground',
    'Kloof CC',
    '129 dukuza street Lindelani/ Tennis court',
  ].map((n) => groundKey(n)),
);

/** A stored fixture — only the venue/scheduling fields matter; everything else is preserved. */
interface StoredFixture {
  id?: string;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  status?: string;
  venueId?: string;
  venueName?: string;
  venueOverride?: string;
  venueStatus?: string;
  venueReason?: string;
  venueLat?: number;
  venueLon?: number;
  venueLocked?: boolean;
  [key: string]: unknown;
}

// ────────────────────────── which fixture moves (pure, unit-tested) ──────────────────────────

/** One side of a clashing pair — just what the mover-selection chooser needs. */
export interface ClashParticipant {
  seriesId: string;
  /** The series slug (id minus the s-planb- prefix), for the 'promotion'/'premier' + group tests. */
  seriesSlug: string;
  fixtureId: string;
  /** The fixture's effective ground IS its own home club's ground (implicit or explicit). */
  atHomeGround: boolean;
}

export interface MoveDecision {
  move: ClashParticipant;
  keep: ClashParticipant;
  reason: string;
}

/** Trailing group/series number: `…-g2` → 2, `…-2` → 2; `…-top10` (no `-` before the digits) → none. */
function groupNumber(slug: string): number | undefined {
  const m = slug.match(/-g?(\d+)$/);
  return m ? Number(m[1]) : undefined;
}

/** First run of digits in a fixture id: `f40` → 40. */
function fixtureNumber(id: string): number | undefined {
  const m = id.match(/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/**
 * Decide which of two clashing fixtures gives way, deterministically:
 *   1. If exactly one is at its OWN home ground, the one NOT at home moves.
 *   2. Else if the pair is from different series and one slug contains 'promotion' and the
 *      other 'premier', the Promotion one moves.
 *   3. Else if the two carry different group/series numbers (`-g2` vs `-g1`, `-2` vs `-1`),
 *      the higher-numbered moves.
 *   4. Else the later fixture id moves (f37 vs f40 → f40).
 */
export function chooseFixtureToMove(a: ClashParticipant, b: ClashParticipant): MoveDecision {
  const decide = (
    move: ClashParticipant,
    keep: ClashParticipant,
    reason: string,
  ): MoveDecision => ({ move, keep, reason });

  // Rule 1 — home ground wins.
  if (a.atHomeGround !== b.atHomeGround) {
    const move = a.atHomeGround ? b : a;
    const keep = a.atHomeGround ? a : b;
    return decide(
      move,
      keep,
      `${move.seriesId}/${move.fixtureId} is not at its home ground; ${keep.seriesId}/${keep.fixtureId} is`,
    );
  }

  // Rule 2 — Promotion yields to Premier (different series only).
  const isProm = (p: ClashParticipant) => p.seriesSlug.includes('promotion');
  const isPrem = (p: ClashParticipant) => p.seriesSlug.includes('premier');
  if (a.seriesId !== b.seriesId && ((isProm(a) && isPrem(b)) || (isProm(b) && isPrem(a)))) {
    const move = isProm(a) ? a : b;
    const keep = isProm(a) ? b : a;
    return decide(move, keep, 'Promotion yields to Premier');
  }

  // Rule 3 — higher-numbered group/series moves.
  const ga = groupNumber(a.seriesSlug);
  const gb = groupNumber(b.seriesSlug);
  if (ga !== undefined && gb !== undefined && ga !== gb) {
    const move = ga > gb ? a : b;
    const keep = ga > gb ? b : a;
    return decide(move, keep, `higher-numbered group (g${Math.max(ga, gb)}) moves`);
  }

  // Rule 4 — later fixture id moves.
  const fa = fixtureNumber(a.fixtureId);
  const fb = fixtureNumber(b.fixtureId);
  if (fa !== undefined && fb !== undefined && fa !== fb) {
    const move = fa > fb ? a : b;
    const keep = fa > fb ? b : a;
    return decide(move, keep, `later fixture id (${move.fixtureId}) moves`);
  }
  // Deterministic tie-break when the numbers are equal/absent.
  const cmp = `${a.seriesId}/${a.fixtureId}`.localeCompare(`${b.seriesId}/${b.fixtureId}`);
  const move = cmp >= 0 ? a : b;
  const keep = cmp >= 0 ? b : a;
  return decide(move, keep, `later fixture id (${move.fixtureId}) moves`);
}

// ─────────────────────────────── venue writing (mirrors the importer) ───────────────────────────────

/** Registry index keyed by groundKey — matches registryResolver's keying (import-planb buildVenueIndex). */
function buildVenueIndex(venues: Venue[]): Map<string, Venue> {
  const byNorm = new Map<string, Venue>();
  for (const v of venues) byNorm.set(groundKey(v.name), v);
  return byNorm;
}

function resolveVenue(name: string, byNorm: Map<string, Venue>): Venue | undefined {
  return byNorm.get(groundKey(name));
}

/**
 * Mirror of setVenue in import-planb-fixtures.ts: a registry match sets
 * venueId/venueName/coords and LOCKS the fixture; a miss falls back to venueOverride plus
 * an EQUAL venueName with no id/coords/lock.
 */
function setVenue(
  f: StoredFixture,
  groundName: string,
  status: string,
  reason: string,
  byNorm: Map<string, Venue>,
  registryMiss: Set<string>,
) {
  const venue = resolveVenue(groundName, byNorm);
  f.venueStatus = status;
  f.venueReason = reason;
  if (venue) {
    f.venueId = venue.id;
    f.venueName = venue.name;
    f.venueLat = Number.isFinite(venue.lat) ? venue.lat : undefined;
    f.venueLon = Number.isFinite(venue.lon) ? venue.lon : undefined;
    f.venueOverride = undefined;
    f.venueLocked = true;
  } else {
    f.venueId = undefined;
    f.venueLat = undefined;
    f.venueLon = undefined;
    f.venueLocked = undefined;
    f.venueOverride = groundName;
    f.venueName = groundName;
    registryMiss.add(groundName);
  }
}

// ─────────────────────────────────────────── main ───────────────────────────────────────────

async function main() {
  const confirm = process.argv.includes('--confirm');
  const repo = await import('./repo.js');

  const [venues, allSeries, clubs] = await Promise.all([
    repo.listVenues(TENANT),
    repo.listSeries(TENANT),
    repo.listClubs(TENANT),
  ]);

  const clubsById = new Map(clubs.map((c) => [c.id, c]));
  const byNorm = buildVenueIndex(venues);
  const registryMiss = new Set<string>();
  const hardErrors: string[] = [];

  // The union's permitted-fields list lives on the registry as homeClubIds — every venue a
  // club may use when its first choice is taken. Sorted by name so numbered fields go 1→2→3
  // (mirrors the importer's permittedByClub).
  const permittedByClub = new Map<string, Venue[]>();
  for (const v of new Set(byNorm.values())) {
    for (const cid of v.homeClubIds ?? []) {
      const list = permittedByClub.get(cid) ?? [];
      list.push(v);
      permittedByClub.set(cid, list);
    }
  }
  for (const list of permittedByClub.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const seriesSlug = (id: string): string =>
    id.startsWith('s-planb-') ? id.slice('s-planb-'.length) : id;

  const homeClubIdOf = (s: Series, f: StoredFixture): string | undefined =>
    s.participants ? s.participants.find((p) => p.teamId === f.home)?.clubId : f.home;
  const awayClubIdOf = (s: Series, f: StoredFixture): string | undefined =>
    s.participants ? s.participants.find((p) => p.teamId === f.away)?.clubId : f.away;

  /** A fixture's effective ground: explicit venue fields, else the home club's ground. */
  const effectiveGround = (s: Series, f: StoredFixture): string | undefined => {
    const explicit = f.venueOverride || f.venueName;
    if (explicit) return explicit;
    const homeClubId = homeClubIdOf(s, f);
    const own = homeClubId ? clubsById.get(homeClubId)?.ground?.venue?.trim() : undefined;
    return own && !JUNK_GROUND.test(own) ? own : undefined;
  };

  const atHomeGround = (s: Series, f: StoredFixture, ground: string): boolean => {
    const homeClubId = homeClubIdOf(s, f);
    const homeGround = homeClubId ? clubsById.get(homeClubId)?.ground?.venue?.trim() : undefined;
    if (!homeGround || JUNK_GROUND.test(homeGround)) return false;
    return groundKey(ground) === groundKey(homeGround);
  };

  interface Booking {
    gid: string;
    seriesId: string;
    fixtureId: string;
    ground: string;
    date: string;
    time?: string;
    s: Series;
    f: StoredFixture;
    seriesSlug: string;
    atHome: boolean;
    homeClubId?: string;
    awayClubId?: string;
  }

  /** Snapshot every fixture's CURRENT booking (reflects moves already applied in-memory). */
  const buildBookings = (): Booking[] => {
    const out: Booking[] = [];
    for (const s of allSeries) {
      for (const f of (s.fixtures as StoredFixture[]) ?? []) {
        if (!f.date || f.status === 'cancelled') continue;
        const ground = effectiveGround(s, f);
        if (!ground) continue;
        out.push({
          gid: `${s.id}/${f.id ?? '?'}`,
          seriesId: String(s.id),
          fixtureId: f.id ?? '',
          ground,
          date: f.date,
          time: f.time,
          s,
          f,
          seriesSlug: seriesSlug(String(s.id)),
          atHome: atHomeGround(s, f, ground),
          homeClubId: homeClubIdOf(s, f),
          awayClubId: awayClubIdOf(s, f),
        });
      }
    }
    return out;
  };

  const sortBookings = (bookings: Booking[]): Booking[] =>
    [...bookings].sort((a, b) => a.date.localeCompare(b.date) || a.gid.localeCompare(b.gid));

  /** Count of distinct clash signatures (identity-keyed, naming-independent) — Step-5 style. */
  const countClashes = (bookings: Booking[]): number => {
    const ledger = new GroundLedger(registryResolver(venues));
    const sigs = new Set<string>();
    for (const b of sortBookings(bookings)) {
      const hit = ledger.check(b.ground, b.date, b.time);
      if (hit) {
        const other = `${hit.seriesId}/${hit.fixtureId}`;
        sigs.add(`${[b.gid, other].sort().join('|')}@${b.date}${b.time ? ' ' + b.time : ''}`);
      }
      ledger.book(b.ground, b.date, b.time, {
        seriesId: b.seriesId,
        fixtureId: b.fixtureId,
        date: b.date,
        time: b.time,
      });
    }
    return sigs.size;
  };

  /** The first clash in (date, gid) order: the triggering booking `b` and the earlier `a`. */
  const firstClash = (bookings: Booking[]): { a: Booking; b: Booking } | undefined => {
    const sorted = sortBookings(bookings);
    const ledger = new GroundLedger(registryResolver(venues));
    for (const b of sorted) {
      const hit = ledger.check(b.ground, b.date, b.time);
      if (hit) {
        const a = sorted.find(
          (x) => x.seriesId === hit.seriesId && x.fixtureId === hit.fixtureId && x.date === b.date,
        );
        if (a) return { a, b };
      }
      ledger.book(b.ground, b.date, b.time, {
        seriesId: b.seriesId,
        fixtureId: b.fixtureId,
        date: b.date,
        time: b.time,
      });
    }
    return undefined;
  };

  /** A ledger of every booking EXCEPT one fixture — used to test candidate grounds for it. */
  const ledgerExcluding = (bookings: Booking[], excludeGid: string): GroundLedger => {
    const ledger = new GroundLedger(registryResolver(venues));
    for (const b of bookings) {
      if (b.gid === excludeGid) continue;
      ledger.book(b.ground, b.date, b.time, {
        seriesId: b.seriesId,
        fixtureId: b.fixtureId,
        date: b.date,
        time: b.time,
      });
    }
    return ledger;
  };

  /**
   * The candidate move destinations for a fixture, first-free-wins order (same order and
   * labels as the importer's runClashPass):
   *   1. away side's allocated ground (away club's record ground)
   *   2. home club's secondaryVenue
   *   3. away club's secondaryVenue
   *   4. registry venues whose homeClubIds include the home club (union facility list)
   *   5. registry venues whose homeClubIds include the away club (union facility list)
   * Skips: the contested ground, junk names, red-listed grounds, and any registry row whose
   * note starts with 'Bad condition'. Deduped by ledger key.
   */
  const buildCandidates = (
    homeClubId: string | undefined,
    awayClubId: string | undefined,
    contested: string,
  ): Array<{ ground: string; label: string }> => {
    const out: Array<{ ground: string; label: string }> = [];
    const seen = new Set<string>();
    const add = (g: string | undefined, label: string) => {
      if (!g) return;
      const t = g.trim();
      if (!t || JUNK_GROUND.test(t)) return;
      if (groundKey(t) === groundKey(contested)) return;
      if (seen.has(groundKey(t))) return;
      if (BAD_CONDITION_GROUNDS.has(groundKey(t))) return;
      const row = byNorm.get(groundKey(t));
      if (row?.note && /^Bad condition/i.test(row.note)) return;
      seen.add(groundKey(t));
      out.push({ ground: t, label });
    };
    const addPermitted = (clubId: string | undefined, label: string) => {
      for (const v of clubId ? (permittedByClub.get(clubId) ?? []) : []) {
        if (JUNK_GROUND.test(v.name.trim())) continue;
        add(v.name, label);
      }
    };
    add(
      awayClubId ? clubsById.get(awayClubId)?.ground?.venue?.trim() : undefined,
      "away side's allocated ground",
    );
    add(
      homeClubId ? clubsById.get(homeClubId)?.ground?.secondaryVenue?.trim() : undefined,
      "home club's secondary ground",
    );
    add(
      awayClubId ? clubsById.get(awayClubId)?.ground?.secondaryVenue?.trim() : undefined,
      "away club's secondary ground",
    );
    addPermitted(homeClubId, "home club's permitted field (union facility list)");
    addPermitted(awayClubId, "away club's permitted field (union facility list)");
    return out;
  };

  // ── Resolve: move one fixture per detected clash until the tenant scan is clean. ──
  console.log('■ Resolving ground/date/time clashes across the whole tenant');
  const preClashes = countClashes(buildBookings());
  const movedGids = new Set<string>();
  const movesBySeries = new Map<string, number>();
  const dirtySeriesIds = new Set<string>();
  const blocks: string[] = [];

  const sideDesc = (bk: Booking): string =>
    `${bk.seriesId}/${bk.fixtureId} (home ${bk.f.home ?? '?'} v ${bk.f.away ?? '?'}, ${
      bk.atHome ? 'at home' : 'not at home'
    })`;

  const totalFixtures = buildBookings().length;
  for (let iter = 0; iter <= totalFixtures; iter++) {
    const bookings = buildBookings();
    const clash = firstClash(bookings);
    if (!clash) break;
    const { a, b } = clash;
    const decision = chooseFixtureToMove(
      {
        seriesId: a.seriesId,
        seriesSlug: a.seriesSlug,
        fixtureId: a.fixtureId,
        atHomeGround: a.atHome,
      },
      {
        seriesId: b.seriesId,
        seriesSlug: b.seriesSlug,
        fixtureId: b.fixtureId,
        atHomeGround: b.atHome,
      },
    );
    const mover =
      decision.move.seriesId === a.seriesId && decision.move.fixtureId === a.fixtureId ? a : b;
    const contested = mover.ground;
    const when = `${mover.date}${mover.time ? ' ' + mover.time : ''}`;

    if (movedGids.has(mover.gid)) {
      hardErrors.push(
        `${mover.gid} clashes again after already being moved this run (on ${contested} ${when}) — cannot resolve`,
      );
      break;
    }

    const candidates = buildCandidates(mover.homeClubId, mover.awayClubId, contested);
    const ledger = ledgerExcluding(bookings, mover.gid);
    let target: { ground: string; label: string } | undefined;
    const tried: string[] = [];
    for (const c of candidates) {
      const hit = ledger.check(c.ground, mover.date, mover.time);
      if (!hit) {
        target = c;
        break;
      }
      tried.push(`${c.ground} [${c.label}] ← ${hit.seriesId}/${hit.fixtureId}`);
    }
    if (!target) {
      hardErrors.push(
        `no free ground for ${mover.gid} (clash on ${contested} ${when} with ${
          mover.gid === a.gid ? b.gid : a.gid
        }); candidates tried: ${tried.length ? tried.join('; ') : '(none available)'}`,
      );
      break;
    }

    setVenue(
      mover.f,
      target.ground,
      'alternative',
      `Moved to avoid ground clash — ${target.label}`,
      byNorm,
      registryMiss,
    );
    movedGids.add(mover.gid);
    movesBySeries.set(mover.seriesId, (movesBySeries.get(mover.seriesId) ?? 0) + 1);
    dirtySeriesIds.add(mover.seriesId);
    blocks.push(
      `${mover.date} ${mover.time ?? '(no time)'} ${contested}: ${sideDesc(a)} vs ${sideDesc(b)} ` +
        `→ moving ${mover.seriesId}/${mover.fixtureId} (${decision.reason}) → ${target.ground} [${target.label}]`,
    );
  }

  for (const block of blocks) console.log(`  ${block}`);
  if (!blocks.length) console.log('  no clashes found — nothing to move');

  // ── Clash gate: post-change scan must be clean. ──
  const postClashes = countClashes(buildBookings());
  console.log(`\n■ pre-existing clashes: ${preClashes}, post-change clashes: ${postClashes}`);
  if (postClashes !== 0) {
    hardErrors.push(`post-change scan still has ${postClashes} clash(es) — refusing to write`);
  }

  // ── Hard errors abort before any write. ──
  if (hardErrors.length) {
    console.error('\nHARD ERRORS — nothing written:');
    for (const e of hardErrors) console.error(`  ✗ ${e}`);
    process.exitCode = 1;
    return;
  }

  // ── Summary. ──
  console.log('\nPlanned writes:');
  for (const id of dirtySeriesIds) {
    const s = allSeries.find((x) => String(x.id) === id)!;
    console.log(
      `  ${id} (released: ${s.released ? 'yes' : 'no'}) — ${movesBySeries.get(id)} move(s)`,
    );
  }
  if (registryMiss.size)
    console.log(
      `  ⚠ ${registryMiss.size} move destination(s) not in the registry: ${[...registryMiss].join(', ')}`,
    );
  console.log(`  ${dirtySeriesIds.size} series, ${movedGids.size} fixture(s) moved`);

  if (!confirm) {
    console.log('\n[dry-run] nothing written. Re-run with --confirm to apply.');
    return;
  }

  // ── Backup every touched series (fresh copies) before writing. ──
  const freshSeries = await Promise.all(
    [...dirtySeriesIds].map((id) => repo.getSeries(TENANT, id)),
  );
  const backup = {
    tenant: TENANT,
    at: new Date().toISOString(),
    series: freshSeries.filter(Boolean),
  };
  const backupPath = `./venue-clash-resolve-backup-${TENANT}-${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')}.json`;
  await writeFile(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nBackup written: ${backupPath} (${backup.series.length} series)`);

  for (const id of dirtySeriesIds) {
    const s = allSeries.find((x) => String(x.id) === id)!;
    s.version = (Number(s.version) || 1) + 1;
    await repo.putSeries(TENANT, s);
    console.log(`wrote series ${s.id} v${s.version}`);
  }
  console.log('Done.');
}

// Guard the entry point so importing this module (e.g. from a test file, to reach the
// pure chooser) never runs main() as a side effect of module load.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
