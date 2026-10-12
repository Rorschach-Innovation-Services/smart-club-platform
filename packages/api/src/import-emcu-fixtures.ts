/**
 * EMCU 2026-27 fixture import — `Complete EMCU Fixtures 2026-2027 Season.xlsx` (8 sheets, 11
 * competitions, 620 fixtures) → eleven `s-emcu-*` DRAFT series on the `dolphins` tenant,
 * replacing the five stale EMCU season-run drafts (and their three runs), reversibly.
 *
 *   npx tsx src/import-emcu-fixtures.ts --parse-only [--report-out <md>]        # no AWS
 *   npx tsx src/import-emcu-fixtures.ts --parse-only --report-out <md> \
 *     --series-json prod-SERIES.json --clubs-json prod-CLUB.json --venues-json prod-VENUE.json
 *   npx tsx src/import-emcu-fixtures.ts --series-json … --clubs-json … --venues-json …  # offline dry run
 *   npx sst shell --stage prod -- npm --prefix packages/api run import-emcu-fixtures       # dry run
 *   … -- --confirm [--only <slug>[,…]] [--no-club-sync]                                 # write
 *   … -- --revert [--confirm]                                 # delete the s-emcu-* series
 *   … -- --restore-stale <backup.json> [--confirm]            # re-put the 5 stale series + 3 runs
 *
 * PURPOSE-BUILT on the Lions doctrine (import-lions-fixtures.ts), not copy-and-trimmed from
 * planb: only planb's pure cell helpers (`isoDate`/`isoTime`, via emcu-fixture-map.ts) and the
 * `WrittenFixture` shape are reused. Team strings resolve through the explicit EMCU_TEAM_MAP,
 * cross-checked against the shared dolphins resolver (club-name-resolve.ts `resolveParticipant`)
 * — any disagreement is fatal.
 *
 * Venues are SHEET-AUTHORITATIVE: a ground that resolves to the registry (tenant aliases, with
 * EMCU_VENUE_ALIASES filling gaps) is written locked; anything else as a venueOverride.
 *
 * Clash + relocation pass (plan §C), run BEFORE anything is deleted or written, on a ledger of
 * every remaining tenant fixture (any lifecycle; the 5 stale drafts EXCLUDED) plus the 620:
 *   - an EMCU fixture that shares a slot with any non-EMCU fixture YIELDS;
 *   - two EMCU fixtures in one slot that share a club ("double listing": the club is at the
 *     same ground twice at once) → the later by (seriesId, fixtureId) is written dateTbc;
 *   - otherwise two EMCU fixtures → chooseFixtureToMove picks the mover;
 *   - a mover takes the first `buildCandidateGrounds` ground free ALL DAY on its date, else it
 *     is written dateTbc (drafts only; the release gate exempts TBC dates).
 * Processing order is (date, time, ground, seriesId, fixture number) — deterministic. The
 * result is then re-checked with `findClashes` (release-gate semantics); any remaining clash
 * aborts with nothing changed. There is NO --allow-clashes flag (standing rule).
 *
 * --confirm order: backup → delete the 5 stale drafts (+ officials + sync state, as DELETE
 * /series does) and the 3 runs → write the 11 drafts via writeSeriesFromSnapshot (refusing a
 * RELEASED s-emcu-*) → sync-club-leagues-from-series --include-drafts → re-scan the stored
 * tenant with findClashes.
 */
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WrittenFixture } from './import-planb-fixtures.js';
import {
  findClashes,
  groundKey,
  GroundLedger,
  isClashExempt,
  JUNK_GROUND,
  registryResolver,
  venueAliasesFor,
  type Clash,
} from './venue-clash.js';
import {
  buildCandidateGrounds,
  buildPermittedByClub,
  buildVenueIndex,
  chooseFixtureToMove,
  type CandidateGround,
} from './resolve-venue-clashes.js';
import {
  buildClubIndex,
  resolveParticipant,
  type ResolutionLog,
  type SuffixUsage,
} from './club-name-resolve.js';
import { writeSeriesFromSnapshot } from './medicoach-sync/cli-write.js';
import { loadOffline } from './patch-fixtures.js';
import {
  DEFAULT_WORKBOOK,
  EMCU_DISTRICT,
  EMCU_LEAGUE_KEYS,
  EMCU_NEW_CLUBS,
  EMCU_NEW_VENUES,
  EMCU_SERIES,
  EMCU_SERIES_PREFIX,
  EMCU_SOURCE,
  EMCU_STALE_RUN_IDS,
  EMCU_STALE_SERIES_IDS,
  EMCU_TENANT,
  EMCU_VENUE_ALIASES,
  EMCU_VENUE_ALIAS_PAIRS,
  EXPECTED_TOTAL,
  KNOWN_SLUGS,
  emcuAliases,
  emcuSide,
  newClubRecord,
  parseEmcuWorkbook,
  premierReserveWarnings,
  seriesIdFor,
  verifyTeamMap,
  type EmcuRawFixture,
  type EmcuSeriesSpec,
  type ParsedEmcuWorkbook,
  type SheetGrid,
} from './emcu-fixture-map.js';
import type { Club, SeasonRun, Series, Venue, VenueStatus } from './types.js';

type RepoModule = typeof import('./repo.js');
type SeriesParticipant = NonNullable<Series['participants']>[number];

/** A written fixture; `dateTbc` marks a placeholder date (clash-exempt, venue kept). */
export type EmcuFixture = WrittenFixture & { dateTbc?: boolean };

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

// ───────────────────────── Workbook → grids ─────────────────────────

export async function readWorkbookGrids(path: string): Promise<SheetGrid[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb.worksheets.map((ws) => {
    const rows: SheetGrid['rows'] = [];
    const cols = Math.max(ws.columnCount, 7);
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells: unknown[] = [];
      for (let c = 1; c <= cols; c++) cells[c] = row.getCell(c).value;
      rows.push({ row: r, cells });
    }
    return { name: ws.name, rows };
  });
}

// ───────────────────────── Series builder ─────────────────────────

export interface BuildContext {
  clubs: Club[];
  venues: Venue[];
  aliases: Record<string, string>;
}

export interface BuiltEmcuSeries {
  spec: EmcuSeriesSpec;
  series: Series;
  raw: EmcuRawFixture[];
}

export interface ResolutionRow {
  raw: string;
  leagueKey: string;
  clubId: string;
  clubName: string;
  teamId: string;
}

export interface BuildOutcome {
  built: BuiltEmcuSeries[];
  resolutions: ResolutionRow[];
  /** Map club ids the context holds no record for (fatal on a tenant run). */
  missingClubs: string[];
  /** The shared resolver lands a string on a different team than EMCU_TEAM_MAP (fatal). */
  resolverMismatches: string[];
  locked: number;
  /** Registry misses: sheet venue → fixture count (written as venueOverride). */
  registryMisses: Map<string, number>;
}

function deriveStatus(venue: Venue | undefined, homeClubId: string, awayClubId: string) {
  const ids = venue?.homeClubIds ?? [];
  if (ids.includes(homeClubId)) return 'home' as VenueStatus;
  if (ids.includes(awayClubId)) return 'alternative' as VenueStatus;
  return 'neutral' as VenueStatus;
}

/**
 * Build the Series (planb's shape: participants snapshot, team-id home/away, `f<n>` ids in
 * sheet order, dateMode 'reference', drafts). Pure — the caller decides what is fatal.
 */
export function buildEmcuSeries(
  parsed: Pick<ParsedEmcuWorkbook, 'fixtures'>,
  ctx: BuildContext,
  only: string[] = [],
): BuildOutcome {
  const clubsById = new Map(ctx.clubs.map((c) => [c.id, c]));
  const byNorm = buildClubIndex(ctx.clubs);
  const venueIndex = buildVenueIndex(ctx.venues, ctx.aliases);
  const usage: SuffixUsage = { suffixed: new Set(), unsuffixed: new Set() };
  const log: ResolutionLog = new Map();
  const outcome: BuildOutcome = {
    built: [],
    resolutions: [],
    missingClubs: [],
    resolverMismatches: [],
    locked: 0,
    registryMisses: new Map(),
  };
  const seenRes = new Set<string>();
  for (const spec of EMCU_SERIES) {
    if (only.length && !only.includes(spec.slug)) continue;
    const raw = parsed.fixtures.filter((f) => f.slug === spec.slug);
    const { leagueKey } = spec;
    const participants: SeriesParticipant[] = [];
    const teamIds: string[] = [];
    const side = (name: string): SeriesParticipant => {
      const s = emcuSide(name, leagueKey);
      if (!s) throw new Error(`unknown team "${name}" survived the parse`);
      const club = clubsById.get(s.clubId);
      if (!club && !outcome.missingClubs.includes(s.clubId)) outcome.missingClubs.push(s.clubId);
      let p: SeriesParticipant | undefined;
      if (club) {
        p = resolveParticipant(name, leagueKey, ctx.clubs, byNorm, usage, log);
        if (!p || p.teamId !== s.teamId || p.clubId !== s.clubId) {
          const msg = `"${name}" (${leagueKey}): map says ${s.teamId}, shared resolver says ${p?.teamId ?? 'nothing'}`;
          if (!outcome.resolverMismatches.includes(msg)) outcome.resolverMismatches.push(msg);
          p = undefined;
        }
      }
      if (!p) {
        const base = club?.name ?? EMCU_NEW_CLUBS.find((c) => c.id === s.clubId)?.name ?? s.clubId;
        p = { teamId: s.teamId, clubId: s.clubId, name: s.letter ? `${base} ${s.letter}` : base };
      }
      const key = `${leagueKey}::${name}`;
      if (!seenRes.has(key)) {
        seenRes.add(key);
        outcome.resolutions.push({
          raw: name,
          leagueKey,
          clubId: s.clubId,
          clubName: club?.name ?? p.name,
          teamId: s.teamId,
        });
      }
      if (!teamIds.includes(p.teamId)) {
        teamIds.push(p.teamId);
        participants.push(p);
      }
      return p;
    };
    const fixtures: EmcuFixture[] = raw.map((f, i) => {
      const home = side(f.home);
      const away = side(f.away);
      const wf: EmcuFixture = {
        id: `f${i + 1}`,
        round: f.round,
        date: f.date,
        time: f.time,
        home: home.teamId,
        away: away.teamId,
        venueReason: `${EMCU_SOURCE} — exact venue`,
      };
      const venue = venueIndex.get(groundKey(f.venue, ctx.aliases));
      wf.venueStatus = deriveStatus(venue, home.clubId, away.clubId);
      if (venue) {
        wf.venueId = venue.id;
        wf.venueName = venue.name;
        if (Number.isFinite(venue.lat)) wf.venueLat = venue.lat;
        if (Number.isFinite(venue.lon)) wf.venueLon = venue.lon;
        wf.venueLocked = true;
        outcome.locked++;
      } else {
        wf.venueOverride = f.venue;
        wf.venueName = f.venue;
        outcome.registryMisses.set(f.venue, (outcome.registryMisses.get(f.venue) ?? 0) + 1);
      }
      return wf;
    });
    const dates = fixtures.map((f) => f.date).sort();
    const series = {
      id: seriesIdFor(spec.slug),
      name: spec.name,
      leagueKey,
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      dateMode: 'reference',
      teams: teamIds,
      participants,
      fixtures,
      maxOvers: spec.maxOvers,
      seriesType: spec.seriesType,
      kind: 'series',
      // Drafts on purpose: the admin approves and releases from the console.
      approved: false,
      approvedAt: null,
      released: false,
      releasedAt: null,
      version: 1,
    } as Series;
    outcome.built.push({ spec, series, raw });
  }
  return outcome;
}

// ───────────────────────── Relocation pass (plan §C) ─────────────────────────

interface Booking {
  s: Series;
  f: EmcuFixture;
  emcu: boolean;
  seriesId: string;
  fixtureId: string;
  ground: string;
  gk: string;
  date: string;
  time?: string;
}

export interface Relocation {
  seriesId: string;
  seriesName: string;
  fixtureId: string;
  round: number;
  date: string;
  time?: string;
  home: string;
  away: string;
  from: string;
  to: string;
  label: string;
  registryMiss: boolean;
  /** 'yields' = an EMCU fixture gave way to a non-EMCU booking; 'internal' = EMCU v EMCU. */
  cause: 'yields' | 'internal';
  /** The booking that keeps the slot, human-readable. */
  blockedBy: string;
  /** chooseFixtureToMove's reason (internal clashes only). */
  decision?: string;
  tried: string[];
}

export interface DateTbcEntry {
  seriesId: string;
  seriesName: string;
  fixtureId: string;
  round: number;
  date: string;
  time?: string;
  home: string;
  away: string;
  ground: string;
  kind: 'team-clash' | 'no-candidate';
  why: string;
}

export interface RelocationOutcome {
  moves: Relocation[];
  dateTbc: DateTbcEntry[];
  errors: string[];
}

const fixtureNumber = (id: string) => Number(id.match(/\d+/)?.[0] ?? 0);
const cmpRef = (a: { seriesId: string; fixtureId: string }, b: typeof a) =>
  a.seriesId.localeCompare(b.seriesId) || fixtureNumber(a.fixtureId) - fixtureNumber(b.fixtureId);
const bookingOrder = (a: Booking, b: Booking) =>
  a.date.localeCompare(b.date) ||
  (a.time ?? '').localeCompare(b.time ?? '') ||
  a.gk.localeCompare(b.gk) ||
  cmpRef(a, b);

/**
 * Relocate EMCU fixtures off every double-booked slot (plan §C). MUTATES the built series'
 * fixtures (venue fields / dateTbc). `others` = every tenant series that stays (the stale
 * drafts and any s-emcu-* being replaced already removed by the caller).
 */
export function relocateEmcu(
  built: Series[],
  others: Series[],
  clubs: Club[],
  venues: Venue[],
  aliases: Record<string, string>,
): RelocationOutcome {
  const out: RelocationOutcome = { moves: [], dateTbc: [], errors: [] };
  const clubsById = new Map(clubs.map((c) => [c.id, c]));
  const resolve = registryResolver(venues, aliases);
  const byNorm = buildVenueIndex(venues, aliases);
  const permittedByClub = buildPermittedByClub(byNorm);

  const sideClub = (s: Series, ref: string | undefined) =>
    ref ? (s.participants ? s.participants.find((p) => p.teamId === ref)?.clubId : ref) : undefined;
  const sideName = (s: Series, ref: string | undefined) =>
    s.participants?.find((p) => p.teamId === ref)?.name ??
    (ref ? (clubsById.get(ref)?.name ?? ref) : '?');
  const effGround = (s: Series, f: EmcuFixture): string | undefined => {
    const explicit = f.venueOverride || f.venueName;
    if (explicit) return explicit;
    const own = clubsById.get(sideClub(s, f.home) ?? '')?.ground?.venue?.trim();
    return own && !JUNK_GROUND.test(own) ? own : undefined;
  };
  const bookingOf = (s: Series, f: EmcuFixture, emcu: boolean): Booking | undefined => {
    if (!f.date || isClashExempt(f)) return undefined;
    const ground = effGround(s, f);
    if (!ground) return undefined;
    return {
      s,
      f,
      emcu,
      seriesId: String(s.id),
      fixtureId: String(f.id ?? ''),
      ground,
      gk: resolve(ground).key,
      date: f.date,
      time: f.time,
    };
  };
  const bookingsOf = (list: Series[], emcu: boolean): Booking[] =>
    list
      .flatMap((s) => ((s.fixtures as EmcuFixture[]) ?? []).map((f) => bookingOf(s, f, emcu)))
      .filter((b): b is Booking => !!b)
      .sort(bookingOrder);
  const describe = (b: Booking) =>
    `${b.s.name} R${b.f.round ?? '?'} ${sideName(b.s, b.f.home)} v ${sideName(b.s, b.f.away)}` +
    (b.emcu ? '' : b.s.released === true ? ' (released)' : ' (unreleased)');
  const tbc = (b: Booking, kind: DateTbcEntry['kind'], why: string) => {
    b.f.dateTbc = true;
    out.dateTbc.push({
      seriesId: b.seriesId,
      seriesName: b.s.name,
      fixtureId: b.fixtureId,
      round: Number(b.f.round),
      date: b.date,
      time: b.time,
      home: sideName(b.s, b.f.home),
      away: sideName(b.s, b.f.away),
      ground: b.ground,
      kind,
      why,
    });
  };
  const atHome = (b: Booking) => {
    const g = clubsById.get(sideClub(b.s, b.f.home) ?? '')?.ground?.venue?.trim();
    return !!g && !JUNK_GROUND.test(g) && groundKey(g, aliases) === groundKey(b.ground, aliases);
  };

  // (a) The same team twice in one series at one date+time — later fixture goes TBC.
  for (const s of built) {
    const seen = new Map<string, EmcuFixture>();
    const fx = [...((s.fixtures as EmcuFixture[]) ?? [])].sort(
      (a, b) => fixtureNumber(a.id) - fixtureNumber(b.id),
    );
    for (const f of fx) {
      if (!f.date || isClashExempt(f)) continue;
      for (const t of [f.home, f.away]) {
        const k = `${t}|${f.date}|${f.time ?? ''}`;
        const first = seen.get(k);
        if (first && first !== f) {
          const b = bookingOf(s, f, true);
          const why = `${sideName(s, t)} is also fixtured in ${s.name} ${first.id} at the same time`;
          if (b) tbc(b, 'team-clash', why);
          else f.dateTbc = true;
          break;
        }
        seen.set(k, f);
      }
    }
  }

  // (b) Ground clashes, first conflict in processing order, until clean.
  const moved = new Set<string>();
  const limit = built.reduce((n, s) => n + ((s.fixtures as unknown[])?.length ?? 0), 0) + 1;
  for (let iter = 0; iter < limit; iter++) {
    const otherBk = bookingsOf(others, false);
    const emcuBk = bookingsOf(built, true);
    const ledger = new GroundLedger(resolve);
    const bookIt = (b: Booking) =>
      ledger.book(b.ground, b.date, b.time, {
        seriesId: b.seriesId,
        fixtureId: b.fixtureId,
        date: b.date,
        time: b.time,
      });
    for (const o of otherBk) bookIt(o);
    let conflict: { e: Booking; other: Booking } | undefined;
    for (const e of emcuBk) {
      const hit = ledger.check(e.ground, e.date, e.time);
      if (hit) {
        const other = [...otherBk, ...emcuBk].find(
          (b) => b.seriesId === hit.seriesId && b.fixtureId === hit.fixtureId,
        );
        if (!other) {
          out.errors.push(`ledger hit ${hit.seriesId}/${hit.fixtureId} has no booking`);
          return out;
        }
        conflict = { e, other };
        break;
      }
      bookIt(e);
    }
    if (!conflict) break;
    const { e, other } = conflict;

    let mover: Booking;
    let keeper: Booking;
    let cause: Relocation['cause'];
    let decision: string | undefined;
    if (!other.emcu) {
      mover = e;
      keeper = other;
      cause = 'yields';
    } else {
      const clubsOf = (b: Booking) =>
        [sideClub(b.s, b.f.home), sideClub(b.s, b.f.away)].filter(Boolean) as string[];
      const shared = clubsOf(e).filter((c) => clubsOf(other).includes(c));
      if (shared.length) {
        // Double listing: one club at one ground twice at once. The later by
        // (seriesId, fixtureId) is written date-TBC (user decision, 6 Oct 2026).
        const [first, second] = cmpRef(e, other) <= 0 ? [e, other] : [other, e];
        tbc(
          second,
          'team-clash',
          `${shared.map((c) => clubsById.get(c)?.name ?? c).join(', ')} also listed at ${first.ground} ${first.date} ${first.time ?? ''} in ${describe(first)}`,
        );
        continue;
      }
      const part = (b: Booking) => ({
        seriesId: b.seriesId,
        seriesSlug: b.seriesId.startsWith(EMCU_SERIES_PREFIX)
          ? b.seriesId.slice(EMCU_SERIES_PREFIX.length)
          : b.seriesId,
        fixtureId: b.fixtureId,
        atHomeGround: atHome(b),
      });
      const d = chooseFixtureToMove(part(other), part(e));
      const moveIsE = d.move.seriesId === e.seriesId && d.move.fixtureId === e.fixtureId;
      mover = moveIsE ? e : other;
      keeper = moveIsE ? other : e;
      cause = 'internal';
      decision = d.reason;
    }
    const ref = `${mover.seriesId}/${mover.fixtureId}`;
    if (moved.has(ref)) {
      out.errors.push(`${ref} clashes again after being moved — cannot resolve`);
      return out;
    }
    const ledgerEx = new GroundLedger(resolve);
    for (const b of [...otherBk, ...emcuBk]) {
      if (b === mover) continue;
      ledgerEx.book(b.ground, b.date, b.time, {
        seriesId: b.seriesId,
        fixtureId: b.fixtureId,
        date: b.date,
        time: b.time,
      });
    }
    const candidates: CandidateGround[] = buildCandidateGrounds({
      homeClubId: sideClub(mover.s, mover.f.home),
      awayClubId: sideClub(mover.s, mover.f.away),
      contested: mover.ground,
      clubsById,
      byNorm,
      permittedByClub,
      aliases,
    });
    const tried: string[] = [];
    let target: CandidateGround | undefined;
    for (const c of candidates) {
      // All-slot-free: the mover needs the ground for the whole day.
      const hit = ledgerEx.check(c.ground, mover.date, undefined);
      if (!hit) {
        target = c;
        break;
      }
      tried.push(`${c.ground} [${c.label}] ← ${hit.seriesId}/${hit.fixtureId}`);
    }
    moved.add(ref);
    if (!target) {
      tbc(
        mover,
        'no-candidate',
        `${mover.ground} taken by ${describe(keeper)}; no candidate ground free all day` +
          (tried.length ? ` (tried: ${tried.join('; ')})` : ' (no candidates)'),
      );
      continue;
    }
    const row = byNorm.get(groundKey(target.ground, aliases));
    const f = mover.f;
    f.venueStatus = 'alternative';
    f.venueReason = `Moved: ${mover.ground} taken by ${describe(keeper)}`;
    if (row) {
      f.venueId = row.id;
      f.venueName = row.name;
      f.venueLat = Number.isFinite(row.lat) ? row.lat : undefined;
      f.venueLon = Number.isFinite(row.lon) ? row.lon : undefined;
      f.venueOverride = undefined;
      f.venueLocked = true;
    } else {
      f.venueId = undefined;
      f.venueLat = undefined;
      f.venueLon = undefined;
      f.venueLocked = undefined;
      f.venueOverride = target.ground;
      f.venueName = target.ground;
    }
    for (const k of Object.keys(f) as Array<keyof EmcuFixture>) if (f[k] === undefined) delete f[k];
    out.moves.push({
      seriesId: mover.seriesId,
      seriesName: mover.s.name,
      fixtureId: mover.fixtureId,
      round: Number(f.round),
      date: mover.date,
      time: mover.time,
      home: sideName(mover.s, f.home),
      away: sideName(mover.s, f.away),
      from: mover.ground,
      to: row ? row.name : target.ground,
      label: target.label,
      registryMiss: !row,
      cause,
      blockedBy: describe(keeper),
      decision,
      tried,
    });
  }
  return out;
}

// ───────────────────────── Verification scan ─────────────────────────

export interface ScanClash extends Clash {
  seriesId: string;
  seriesName: string;
}

/**
 * Every clash an EMCU series carries under release-gate semantics (`findClashes` against
 * every other series, any lifecycle), each pair reported once.
 */
export function verifyClashes(
  built: Series[],
  others: Series[],
  clubs: Club[],
  venues: Venue[],
  aliases: Record<string, string>,
): ScanClash[] {
  const out: ScanClash[] = [];
  const seen = new Set<string>();
  for (const s of built) {
    const rest = [...others, ...built.filter((b) => b !== s)];
    for (const c of findClashes(s, rest, clubs, venues, aliases)) {
      const pair = [`${s.id}/${c.fixtureId}`, `${c.with.seriesId}/${c.with.fixtureId}`]
        .sort()
        .join('|');
      if (seen.has(pair)) continue;
      seen.add(pair);
      out.push({ ...c, seriesId: String(s.id), seriesName: s.name });
    }
  }
  return out;
}

// ───────────────────────── Stored-draft drift (lions pattern) ─────────────────────────

const DRIFT_FIELDS = [
  'round',
  'date',
  'time',
  'home',
  'away',
  'venueId',
  'venueName',
  'venueOverride',
  'venueStatus',
  'venueLocked',
  'dateTbc',
] as const;

/** How a stored s-emcu-* draft differs from what this run would write over it. PURE. */
export function storedDraftDrift(built: Series, stored: Series): string[] {
  const notes: string[] = [];
  if (stored.name !== built.name) notes.push(`name "${stored.name}" → "${built.name}"`);
  const storedFx = new Map(
    ((stored.fixtures as EmcuFixture[] | undefined) ?? []).map((f) => [String(f.id), f]),
  );
  const builtFx = (built.fixtures as EmcuFixture[] | undefined) ?? [];
  const changed: string[] = [];
  for (const f of builtFx) {
    const s = storedFx.get(String(f.id));
    if (!s) continue;
    const rec = (x: EmcuFixture) => x as unknown as Record<string, unknown>;
    const fields = DRIFT_FIELDS.filter((k) => (rec(s)[k] ?? null) !== (rec(f)[k] ?? null));
    if (fields.length) changed.push(`${String(f.id)} (${fields.join(', ')})`);
  }
  if (changed.length)
    notes.push(
      `${changed.length} fixture(s) differ: ${changed.slice(0, 5).join('; ')}${changed.length > 5 ? '; …' : ''}`,
    );
  if (builtFx.length !== storedFx.size)
    notes.push(`${storedFx.size} stored fixture(s) → ${builtFx.length}`);
  return notes;
}

// ───────────────────────── Union report (markdown) ─────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export interface ReportInput {
  generatedAt: string;
  parsed: ParsedEmcuWorkbook;
  outcome: BuildOutcome | null;
  relocation: RelocationOutcome | null;
  premierReserve: string[];
}

export function renderUnionReport(r: ReportInput): string {
  const L: string[] = [];
  const nameOf = (slug: string) => EMCU_SERIES.find((s) => s.slug === slug)?.name ?? slug;
  L.push('# EMCU 2026-27 fixtures: import report');
  L.push('');
  L.push(
    `Prepared ${r.generatedAt} from "Complete EMCU Fixtures 2026-2027 Season.xlsx" before the fixtures are loaded onto the Smart Club platform as drafts.`,
  );
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push('| Competition | Fixtures |');
  L.push('|---|---:|');
  for (const s of EMCU_SERIES)
    L.push(`| ${s.name} | ${r.parsed.fixtures.filter((f) => f.slug === s.slug).length} |`);
  L.push(`| **Total** | **${r.parsed.fixtures.length}** |`);
  L.push('');
  const rel = r.relocation;
  if (!rel) {
    L.push(
      '_The clash check was not run (no tenant data supplied), so sections 1 to 3 are empty._',
    );
    L.push('');
  }
  const teamClashes = rel?.dateTbc.filter((d) => d.kind === 'team-clash') ?? [];
  const noCandidate = rel?.dateTbc.filter((d) => d.kind === 'no-candidate') ?? [];
  L.push('## 1. Double listings: a club at one ground twice at the same time (date to be set)');
  L.push('');
  if (!teamClashes.length) L.push('None.');
  else {
    L.push(
      'The workbook lists these clubs twice at one ground at the same time. The first listing is kept as sheeted; the fixture below is loaded with its **date to be confirmed**. Please send a new date.',
    );
    L.push('');
    L.push('| Competition | Round | Sheet date | Fixture | Ground | Why |');
    L.push('|---|---:|---|---|---|---|');
    for (const d of teamClashes)
      L.push(
        `| ${d.seriesName} | ${d.round} | ${longDate(d.date)} ${d.time ?? ''} | ${d.home} v ${d.away} | ${d.ground} | ${d.why} |`,
      );
  }
  L.push('');
  L.push('## 2. Fixtures moved to another ground');
  L.push('');
  if (!rel?.moves.length) L.push('None.');
  else {
    L.push(
      "These grounds are already booked at that time (by a KZNCU fixture already published, or by another EMCU fixture). Each EMCU fixture below was moved to the first ground on its clubs' facility lists that is free all day. Please confirm, or tell us where it should go.",
    );
    L.push('');
    L.push('| Competition | Round | Date | Fixture | Sheet ground | Moved to | Ground taken by |');
    L.push('|---|---:|---|---|---|---|---|');
    for (const m of rel.moves)
      L.push(
        `| ${m.seriesName} | ${m.round} | ${longDate(m.date)} ${m.time ?? ''} | ${m.home} v ${m.away} | ${m.from} | ${m.to} | ${m.blockedBy} |`,
      );
  }
  L.push('');
  L.push('## 3. Fixtures with no free ground (date to be set)');
  L.push('');
  if (!noCandidate.length) L.push('None.');
  else {
    L.push('| Competition | Round | Sheet date | Fixture | Sheet ground | Why |');
    L.push('|---|---:|---|---|---|---|');
    for (const d of noCandidate)
      L.push(
        `| ${d.seriesName} | ${d.round} | ${longDate(d.date)} ${d.time ?? ''} | ${d.home} v ${d.away} | ${d.ground} | ${d.why} |`,
      );
  }
  L.push('');
  L.push('## 4. Notes on the sheet');
  L.push('');
  if (!r.parsed.roundNotes.length) L.push('None.');
  for (const n of r.parsed.roundNotes)
    L.push(
      `- **${nameOf(n.slug)}, Round ${n.round} (${longDate(n.date)})**: "${n.note}". Loaded as sheeted; please send the new date and we will move the round.`,
    );
  for (const w of r.parsed.warnings) L.push(`- ${w}`);
  L.push('');
  L.push('## 5. Ground names not on the venue list');
  L.push('');
  const misses = r.outcome ? [...r.outcome.registryMisses] : [];
  if (!r.outcome) L.push('_Not checked (no tenant data supplied)._');
  else if (!misses.length) L.push('None.');
  else {
    L.push(
      'These are shown exactly as written and are not yet linked to a registered ground. Please confirm each is a real, separate ground.',
    );
    L.push('');
    L.push('| Ground as written | Fixtures |');
    L.push('|---|---:|');
    for (const [name, n] of misses.sort((a, b) => a[0].localeCompare(b[0])))
      L.push(`| ${name} | ${n} |`);
  }
  L.push('');
  L.push('## 6. Division 1 Premier Reserve facility rule');
  L.push('');
  L.push(
    'The Division 1 sheet says Premier Reserve matches use only a listed Premier facility of one of the two teams. Fixtures that break that rule (warning only, nothing was changed):',
  );
  L.push('');
  if (!r.premierReserve.length) L.push('None.');
  for (const w of r.premierReserve) L.push(`- ${w}`);
  L.push('');
  L.push('## 7. Ground spellings treated as the same ground (please confirm)');
  L.push('');
  for (const [a, b] of EMCU_VENUE_ALIAS_PAIRS) L.push(`- "${a}" = **${b}**`);
  L.push('');
  return L.join('\n');
}

// ───────────────────────── Write / revert / restore (repo) ─────────────────────────

export interface EmcuBackup {
  kind: 'emcu-fixtures-backup';
  tenant: string;
  at: string;
  /** s-emcu-* series as they were before this run. */
  emcuSeries: Series[];
  /** The stale season-run drafts and their runs this run deletes. */
  staleSeries: Series[];
  staleRuns: SeasonRun[];
}

async function writeBackup(dir: string, b: EmcuBackup, log: (l: string) => void) {
  const path = join(dir, `emcu-fixtures-backup-${b.at.replace(/[:.]/g, '-')}.json`);
  await writeFile(path, JSON.stringify(b, null, 2));
  log(
    `Backup written: ${path} (${b.emcuSeries.length} s-emcu-* series, ${b.staleSeries.length} stale series, ${b.staleRuns.length} runs)`,
  );
  return path;
}

/** DELETE /series parity: the series, its umpire appointments and its medicoach-sync state. */
async function deleteSeriesFully(repo: RepoModule, tenant: string, id: string) {
  await repo.deleteSeries(tenant, id);
  await repo.deleteFixtureOfficialsForSeries(tenant, id);
  await repo.deleteSeriesSyncState(tenant, id);
}

export interface WriteOptions {
  backupDir?: string;
  clubSync?: boolean;
  log?: (line: string) => void;
}

export interface WriteResult {
  backupPath: string;
  written: string[];
  drifted: string[];
  postWriteClashes: ScanClash[];
}

/**
 * The `--confirm` write, steps (1)+(3)+(4)+(5) of plan §B.2 plus the post-write re-scan. The
 * caller has already run the clash/relocation pass (step 2) on the same reads. Re-checks
 * the released refusal against fresh reads first: nothing is touched if any target is
 * released.
 */
export async function executeEmcuWrite(
  repo: RepoModule,
  tenant: string,
  built: Series[],
  opts: WriteOptions = {},
): Promise<WriteResult> {
  const log = opts.log ?? console.log;
  const fresh = await repo.listSeries(tenant);
  const byId = new Map(fresh.map((s) => [String(s.id), s]));
  const released = built.filter((b) => byId.get(String(b.id))?.released === true);
  if (released.length)
    throw new Error(
      `refusing to write — RELEASED: ${released.map((s) => s.id).join(', ')} (recall first, or leave out with --only)`,
    );
  const stale = EMCU_STALE_SERIES_IDS.map((id) => byId.get(id)).filter(Boolean) as Series[];
  const staleReleased = stale.filter((s) => s.released === true);
  if (staleReleased.length)
    throw new Error(
      `refusing to delete RELEASED stale series: ${staleReleased.map((s) => s.id).join(', ')}`,
    );
  const staleRuns = (
    await Promise.all(EMCU_STALE_RUN_IDS.map((id) => repo.getSeasonRun(tenant, id)))
  ).filter(Boolean) as SeasonRun[];
  const backupPath = await writeBackup(
    opts.backupDir ?? PACKAGE_DIR,
    {
      kind: 'emcu-fixtures-backup',
      tenant,
      at: new Date().toISOString(),
      emcuSeries: fresh.filter((s) => String(s.id).startsWith(EMCU_SERIES_PREFIX)),
      staleSeries: stale,
      staleRuns,
    },
    log,
  );
  for (const s of stale) {
    await deleteSeriesFully(repo, tenant, String(s.id));
    log(`deleted stale series ${s.id} (${s.name})`);
  }
  for (const r of staleRuns) {
    await repo.deleteSeasonRun(tenant, r.id);
    log(`deleted stale season run ${r.id}`);
  }
  const written: string[] = [];
  const drifted: string[] = [];
  for (const s of built) {
    const existing = byId.get(String(s.id)) ?? null;
    const outcome = await writeSeriesFromSnapshot(repo, tenant, existing, s, { error: log });
    if (outcome === 'drifted') drifted.push(String(s.id));
    else {
      written.push(String(s.id));
      log(
        `wrote ${s.id} v${s.version} (${(s.fixtures as unknown[]).length} fixtures)${existing ? ' (replaced draft)' : ''}`,
      );
    }
  }
  if (opts.clubSync !== false && written.length) {
    log('\n── Club league sync (sync-club-leagues-from-series --include-drafts):');
    const { syncClubLeaguesFromSeries } = await import('./sync-club-leagues-from-series.js');
    await syncClubLeaguesFromSeries(tenant, {
      confirm: true,
      only: written,
      includeDrafts: true,
      log,
    });
  }
  // Post-write verification: the stored tenant, release-gate semantics.
  const [after, clubs, venues, config] = await Promise.all([
    repo.listSeries(tenant),
    repo.listClubs(tenant),
    repo.listVenues(tenant),
    repo.getTenantConfig(tenant),
  ]);
  const mine = after.filter((s) => String(s.id).startsWith(EMCU_SERIES_PREFIX));
  const rest = after.filter((s) => !String(s.id).startsWith(EMCU_SERIES_PREFIX));
  const postWriteClashes = verifyClashes(mine, rest, clubs, venues, venueAliasesFor(config));
  return { backupPath, written, drifted, postWriteClashes };
}

/** `--revert`: delete every s-emcu-* manifest series; refuses (nothing deleted) on a released one. */
export async function revertEmcu(
  repo: RepoModule,
  tenant: string,
  opts: { confirm: boolean; backupDir?: string; log?: (l: string) => void },
): Promise<{ deleted: string[]; refused: string[] }> {
  const log = opts.log ?? console.log;
  const all = await repo.listSeries(tenant);
  const mine = all.filter((s) => KNOWN_SLUGS.map(seriesIdFor).includes(String(s.id)));
  const refused = mine.filter((s) => s.released === true).map((s) => String(s.id));
  if (!mine.length) {
    log('Nothing to revert.');
    return { deleted: [], refused: [] };
  }
  if (refused.length) {
    log(
      `✗ Refusing to revert — RELEASED series in scope (deleting pulls them from club portals): ${refused.join(', ')}. Recall them in the console first. Nothing deleted.`,
    );
    return { deleted: [], refused };
  }
  if (opts.confirm)
    await writeBackup(
      opts.backupDir ?? PACKAGE_DIR,
      {
        kind: 'emcu-fixtures-backup',
        tenant,
        at: new Date().toISOString(),
        emcuSeries: mine,
        staleSeries: [],
        staleRuns: [],
      },
      log,
    );
  const deleted: string[] = [];
  for (const s of mine) {
    log(`${opts.confirm ? 'delete' : '[dry-run] would delete'}  ${s.id}  (${s.name})`);
    if (opts.confirm) {
      await deleteSeriesFully(repo, tenant, String(s.id));
      deleted.push(String(s.id));
    }
  }
  log(
    opts.confirm
      ? `Reverted ${deleted.length} series.`
      : `Re-run with --confirm to delete these ${mine.length} series.`,
  );
  return { deleted, refused };
}

/**
 * `--restore-stale <backup>`: re-put the stale series + runs from an import backup. Refuses
 * while any s-emcu-* series exists (the two sets would double-book every EMCU fixture);
 * revert first. Items already present are left alone.
 */
export async function restoreStale(
  repo: RepoModule,
  tenant: string,
  backup: EmcuBackup,
  opts: { confirm: boolean; log?: (l: string) => void },
): Promise<{ restoredSeries: string[]; restoredRuns: string[]; refused?: string }> {
  const log = opts.log ?? console.log;
  if (backup.kind !== 'emcu-fixtures-backup' || backup.tenant !== tenant)
    throw new Error(`not an EMCU fixtures backup for tenant "${tenant}"`);
  if (!backup.staleSeries.length && !backup.staleRuns.length)
    throw new Error('backup holds no stale series or runs (a --revert backup?)');
  const all = await repo.listSeries(tenant);
  const emcu = all.filter((s) => String(s.id).startsWith(EMCU_SERIES_PREFIX));
  if (emcu.length) {
    const refused = `${emcu.length} s-emcu-* series still exist (${emcu.map((s) => s.id).join(', ')}) — run --revert --confirm first`;
    log(`✗ Refusing to restore: ${refused}`);
    return { restoredSeries: [], restoredRuns: [], refused };
  }
  const have = new Set(all.map((s) => String(s.id)));
  const restoredSeries: string[] = [];
  const restoredRuns: string[] = [];
  for (const s of backup.staleSeries) {
    if (have.has(String(s.id))) {
      log(`series ${s.id} already present — left alone`);
      continue;
    }
    log(`${opts.confirm ? 'restore' : '[dry-run] would restore'} series ${s.id} (${s.name})`);
    if (opts.confirm) {
      await repo.putSeriesIfVersion(tenant, s, null);
      restoredSeries.push(String(s.id));
    }
  }
  for (const r of backup.staleRuns) {
    if (await repo.getSeasonRun(tenant, r.id)) {
      log(`season run ${r.id} already present — left alone`);
      continue;
    }
    log(`${opts.confirm ? 'restore' : '[dry-run] would restore'} season run ${r.id}`);
    if (opts.confirm) {
      await repo.putSeasonRun(tenant, r);
      restoredRuns.push(r.id);
    }
  }
  return { restoredSeries, restoredRuns };
}

// ───────────────────────── CLI ─────────────────────────

export interface Args {
  mode: 'import' | 'revert' | 'restore';
  tenant: string;
  file: string;
  parseOnly: boolean;
  reportOut: string;
  only: string[];
  confirm: boolean;
  noClubSync: boolean;
  restoreFrom: string;
  seriesJson?: string;
  clubsJson?: string;
  venuesJson?: string;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: 'import',
    tenant: EMCU_TENANT,
    file: DEFAULT_WORKBOOK,
    parseOnly: false,
    reportOut: '',
    only: [],
    confirm: false,
    noClubSync: false,
    restoreFrom: '',
  };
  const need = (i: number, flag: string) => {
    const v = argv[i];
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant') args.tenant = need(++i, a);
    else if (a === '--file') args.file = need(++i, a);
    else if (a === '--parse-only') args.parseOnly = true;
    else if (a === '--report-out') args.reportOut = need(++i, a);
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--no-club-sync') args.noClubSync = true;
    else if (a === '--revert') args.mode = 'revert';
    else if (a === '--restore-stale') {
      args.mode = 'restore';
      args.restoreFrom = need(++i, a);
    } else if (a === '--series-json') args.seriesJson = need(++i, a);
    else if (a === '--clubs-json') args.clubsJson = need(++i, a);
    else if (a === '--venues-json') args.venuesJson = need(++i, a);
    else if (a === '--only')
      args.only = need(++i, a)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else throw new Error(`unknown flag ${a}`);
  }
  if (args.tenant !== EMCU_TENANT)
    throw new Error(`the EMCU map is for tenant "${EMCU_TENANT}", not "${args.tenant}"`);
  const offline = [args.seriesJson, args.clubsJson, args.venuesJson].filter(Boolean).length;
  if (offline !== 0 && offline !== 3)
    throw new Error('offline mode needs all three of --series-json, --clubs-json, --venues-json');
  if (offline && args.confirm)
    throw new Error('offline mode (local JSON export) never writes — drop --confirm');
  if (args.mode !== 'import') {
    if (args.parseOnly || args.only.length || args.reportOut || args.noClubSync || offline)
      throw new Error(
        `${args.mode === 'revert' ? '--revert' : '--restore-stale'} takes only --confirm`,
      );
  }
  if (args.parseOnly && args.confirm)
    throw new Error('--parse-only and --confirm are mutually exclusive');
  for (const slug of args.only)
    if (!KNOWN_SLUGS.includes(slug))
      throw new Error(`--only: unknown series slug "${slug}" (known: ${KNOWN_SLUGS.join(', ')})`);
  return args;
}

/** The would-be bootstrap applied to an offline export (new clubs + venues; EMCU aliases). */
export function applyBootstrapOverlay(
  clubs: Club[],
  venues: Venue[],
  aliases: Record<string, string>,
): { clubs: Club[]; venues: Venue[]; addedClubs: string[]; addedVenues: string[] } {
  const haveClub = new Set(clubs.map((c) => c.id));
  const addClubs = EMCU_NEW_CLUBS.filter((c) => !haveClub.has(c.id)).map(newClubRecord);
  const haveVenue = new Set(venues.map((v) => groundKey(v.name, aliases)));
  const addVenues = EMCU_NEW_VENUES.filter((v) => !haveVenue.has(groundKey(v.name, aliases)));
  return {
    clubs: [...clubs, ...addClubs],
    venues: [...venues, ...addVenues],
    addedClubs: addClubs.map((c) => c.id),
    addedVenues: addVenues.map((v) => v.name),
  };
}

function printClashes(title: string, clashes: ScanClash[]) {
  console.log(`\n── ${title}`);
  if (!clashes.length) {
    console.log('  ✓ no clashes');
    return;
  }
  console.log(`  ✗ ${clashes.length} clash(es):`);
  for (const c of clashes)
    console.log(
      `    ${c.date} ${c.time ?? ''} ${c.ground}: ${c.seriesName} R${c.round} ${c.home} v ${c.away} ⟷ ${c.with.seriesName ?? c.with.seriesId} R${c.with.round} ${c.with.home} v ${c.with.away}`,
    );
}

async function runImport(args: Args) {
  const offline = Boolean(args.seriesJson);
  // ── Parse (no AWS) ──
  const parsed = parseEmcuWorkbook(await readWorkbookGrids(args.file));
  console.log(`EMCU workbook: ${args.file}`);
  for (const s of EMCU_SERIES) {
    const n = parsed.fixtures.filter((f) => f.slug === s.slug).length;
    console.log(
      `  ${n === s.expected ? '✓' : '✗'} ${s.sheet.padEnd(18)} ${s.section.padEnd(7)} → ${seriesIdFor(s.slug).padEnd(22)} ${String(n).padStart(3)}/${s.expected}  "${s.name}"`,
    );
  }
  console.log(`  total: ${parsed.fixtures.length} (expected ${EXPECTED_TOTAL})`);
  for (const w of parsed.warnings) console.log(`  ⚠ ${w}`);
  for (const n of parsed.roundNotes)
    console.log(`  ✎ note on ${n.sheet} row ${n.row} (Round ${n.round}, ${n.date}): "${n.note}"`);
  const mapProblems = verifyTeamMap();
  if (parsed.errors.length || mapProblems.length) {
    console.error(
      `\n✗ Refusing to continue — ${parsed.errors.length + mapProblems.length} parse problem(s):`,
    );
    for (const e of [...parsed.errors, ...mapProblems]) console.error(`   ${e}`);
    process.exitCode = 1;
    return;
  }

  // ── Context ──
  let repo: RepoModule | null = null;
  let clubs: Club[] = [];
  let venues: Venue[] = [];
  let series: Series[] = [];
  let aliases: Record<string, string> = emcuAliases(venueAliasesFor(undefined));
  let configuredLeagues: Set<string> | null = null;
  let missingAliasKeys: string[] = [];
  let configDistricts: string[] | null = null;
  const haveTenantData = offline || !args.parseOnly;
  if (offline) {
    ({ series, clubs, venues } = loadOffline({
      series: args.seriesJson!,
      clubs: args.clubsJson!,
      venues: args.venuesJson!,
    }));
    const overlay = applyBootstrapOverlay(clubs, venues, aliases);
    clubs = overlay.clubs;
    venues = overlay.venues;
    console.log(
      `\nOFFLINE export: ${series.length} series, ${clubs.length - overlay.addedClubs.length} clubs, ${venues.length - overlay.addedVenues.length} venues (code-default aliases + EMCU aliases).` +
        `\n  would-be bootstrap overlay applied: +${overlay.addedClubs.length} club(s) [${overlay.addedClubs.join(', ')}], +${overlay.addedVenues.length} venue(s) [${overlay.addedVenues.join(', ')}]`,
    );
  } else if (!args.parseOnly) {
    repo = await import('./repo.js');
    const config = await repo.getTenantConfig(args.tenant);
    if (!config) throw new Error(`no tenant config for "${args.tenant}"`);
    [clubs, venues, series] = await Promise.all([
      repo.listClubs(args.tenant),
      repo.listVenues(args.tenant),
      repo.listSeries(args.tenant),
    ]);
    const tenantAliases = venueAliasesFor(config);
    aliases = emcuAliases(tenantAliases);
    configuredLeagues = new Set((config.leagues ?? []).map((l) => l.key));
    const stored = config.competitionDefaults?.venueAliases ?? {};
    missingAliasKeys = Object.keys(EMCU_VENUE_ALIASES).filter((k) => !(k in stored));
    configDistricts = config.districts ?? null;
    console.log(
      `\nTenant "${args.tenant}": ${clubs.length} clubs, ${venues.length} registry venues, ${series.length} series`,
    );
  } else {
    console.log(
      '\n[parse-only] no tenant data supplied (--series-json/--clubs-json/--venues-json) — name resolution uses the map only; the clash/relocation pass is skipped.',
    );
  }

  // ── Build ──
  // Without tenant data the map alone names the clubs (no resolver cross-check, no venues).
  const ctx: BuildContext = haveTenantData
    ? { clubs, venues, aliases }
    : { clubs: [], venues: [], aliases };
  const outcome = buildEmcuSeries(parsed, ctx, args.only);
  if (args.only.length)
    console.log(
      `\n── --only: restricted to ${outcome.built.length} series: ${args.only.join(', ')}`,
    );

  console.log(`\n── Name resolution (${outcome.resolutions.length} league/team pairs)`);
  for (const key of EMCU_LEAGUE_KEYS) {
    const rows = outcome.resolutions.filter((r) => r.leagueKey === key);
    if (!rows.length) continue;
    console.log(`  [${key}]`);
    for (const r of rows.sort((a, b) => a.raw.localeCompare(b.raw)))
      console.log(
        `    "${r.raw}" → ${r.clubName} (${r.clubId})${r.teamId !== r.clubId ? ` [${r.teamId}]` : ''}`,
      );
  }

  const builtSeries = outcome.built.map((b) => b.series);
  const builtIds = new Set(builtSeries.map((s) => String(s.id)));
  const total = builtSeries.reduce((n, s) => n + (s.fixtures as unknown[]).length, 0);
  let relocation: RelocationOutcome | null = null;
  let verify: ScanClash[] = [];
  let premier: string[] = [];
  const staleFound = series.filter((s) => EMCU_STALE_SERIES_IDS.includes(String(s.id)));
  if (haveTenantData) {
    const missCount = [...outcome.registryMisses.values()].reduce((n, m) => n + m, 0);
    console.log(
      `\n── Venues: ${total} fixtures → ${outcome.locked} registry-locked, ${missCount} venueOverride (registry miss)`,
    );
    for (const [name, n] of [...outcome.registryMisses].sort((a, b) => a[0].localeCompare(b[0])))
      console.log(`    miss "${name}" ×${n}`);

    // ── Stale cleanup plan ──
    console.log(
      `\n── Stale EMCU season-run drafts (deleted only after a clean scan, under --confirm):`,
    );
    for (const id of EMCU_STALE_SERIES_IDS) {
      const s = staleFound.find((x) => String(x.id) === id);
      console.log(
        s
          ? `  ${s.released ? '✗ RELEASED' : 'draft'}  ${id}  "${s.name}" (${(s.fixtures as unknown[]).length} fixtures) — excluded from the clash ledger`
          : `  absent  ${id}`,
      );
    }
    console.log(`  season runs: ${EMCU_STALE_RUN_IDS.join(', ')} (deleted after the series)`);

    // ── Clash + relocation pass ──
    const others = series.filter(
      (s) => !EMCU_STALE_SERIES_IDS.includes(String(s.id)) && !builtIds.has(String(s.id)),
    );
    relocation = relocateEmcu(builtSeries, others, clubs, venues, aliases);
    const teamClashes = relocation.dateTbc.filter((d) => d.kind === 'team-clash');
    const noCand = relocation.dateTbc.filter((d) => d.kind === 'no-candidate');
    console.log(
      `\n── Relocation pass (ledger: ${others.length} remaining series + ${builtSeries.length} EMCU; stale drafts excluded)`,
    );
    console.log(`  Team clashes → dateTbc: ${teamClashes.length}`);
    for (const d of teamClashes)
      console.log(
        `    ${d.date} ${d.time ?? ''} ${d.seriesId}/${d.fixtureId} R${d.round} ${d.home} v ${d.away} @ ${d.ground} — ${d.why}`,
      );
    const yields = relocation.moves.filter((m) => m.cause === 'yields');
    const internal = relocation.moves.filter((m) => m.cause === 'internal');
    console.log(
      `  Relocations: ${relocation.moves.length} (${yields.length} yield to non-EMCU, ${internal.length} EMCU-internal)`,
    );
    for (const m of relocation.moves) {
      console.log(
        `    ${m.date} ${m.time ?? ''} ${m.seriesId}/${m.fixtureId} R${m.round} ${m.home} v ${m.away}: ${m.from} → ${m.to} [${m.label}]${m.registryMiss ? ' ⚠ not in registry' : ''}`,
      );
      console.log(
        `       ${m.cause === 'yields' ? 'yields to' : 'internal; keeps'} ${m.blockedBy}${m.decision ? ` — ${m.decision}` : ''}`,
      );
      for (const t of m.tried) console.log(`       skipped ${t}`);
    }
    console.log(`  No free candidate → dateTbc: ${noCand.length}`);
    for (const d of noCand)
      console.log(
        `    ${d.date} ${d.time ?? ''} ${d.seriesId}/${d.fixtureId} R${d.round} ${d.home} v ${d.away} @ ${d.ground} — ${d.why}`,
      );
    for (const e of relocation.errors) console.log(`  ✗ ${e}`);

    verify = verifyClashes(builtSeries, others, clubs, venues, aliases);
    printClashes(
      'Verification scan (findClashes, release-gate semantics, after relocation)',
      verify,
    );
    premier = premierReserveWarnings(parsed.fixtures, clubs, venues, aliases);
    console.log(`\n── Div 1 Premier Reserve facility check (warn-only): ${premier.length}`);
    for (const w of premier) console.log(`    ⚠ ${w}`);
  }

  if (args.reportOut) {
    await writeFile(
      args.reportOut,
      renderUnionReport({
        generatedAt: new Date().toISOString().slice(0, 10),
        parsed,
        outcome: haveTenantData ? outcome : null,
        relocation,
        premierReserve: premier,
      }),
    );
    console.log(`\nUnion report written: ${args.reportOut}`);
  }

  // ── Gates ──
  const fatal: string[] = [];
  for (const m of outcome.resolverMismatches) fatal.push(`resolver mismatch: ${m}`);
  if (haveTenantData)
    for (const c of outcome.missingClubs)
      fatal.push(`club "${c}" is not on the tenant — run bootstrap-emcu-prereqs --confirm first`);
  if (relocation) for (const e of relocation.errors) fatal.push(`relocation: ${e}`);
  if (verify.length)
    fatal.push(
      `${verify.length} unresolved venue clash(es) after relocation — no --allow-clashes exists`,
    );
  for (const s of staleFound.filter((x) => x.released === true))
    fatal.push(`stale series ${s.id} is RELEASED — refusing to replace it`);
  const releasedTargets = series.filter((s) => builtIds.has(String(s.id)) && s.released === true);
  for (const s of releasedTargets)
    fatal.push(`${s.id} is already RELEASED — refusing to overwrite (recall it first, or --only)`);
  if (configuredLeagues) {
    const missing = EMCU_LEAGUE_KEYS.filter((k) => !configuredLeagues!.has(k));
    if (missing.length)
      fatal.push(`league key(s) not configured on the tenant: ${missing.join(', ')}`);
  }
  if (configDistricts && configDistricts.length && !configDistricts.includes(EMCU_DISTRICT))
    console.warn(`\n⚠ tenant districts do not list "${EMCU_DISTRICT}"`);
  if (repo && missingAliasKeys.length) {
    const msg = `${missingAliasKeys.length} EMCU venue alias(es) not in the tenant config (${missingAliasKeys.join(', ')}) — run bootstrap-emcu-prereqs --confirm`;
    if (args.confirm) fatal.push(msg);
    else console.warn(`\n⚠ ${msg}`);
  }
  if (repo && args.confirm) {
    const results = (await repo.listFixtureResults(args.tenant)).filter(
      (r) => EMCU_STALE_SERIES_IDS.includes(r.seriesId) && r.cleared !== true,
    );
    if (results.length)
      fatal.push(
        `${results.length} result(s) recorded against the stale series (${[...new Set(results.map((r) => r.seriesId))].join(', ')}) — refusing to delete them`,
      );
  }

  // Drift vs stored drafts (they are replaced wholesale).
  for (const s of builtSeries) {
    const stored = series.find((e) => String(e.id) === String(s.id));
    if (!stored || stored.released) continue;
    const notes = storedDraftDrift(s, stored);
    if (notes.length) {
      console.warn(`\n⚠ ${s.id} differs from the stored draft and WILL BE REPLACED by --confirm:`);
      for (const n of notes) console.warn(`    · ${n}`);
    }
  }

  if (fatal.length) {
    console.error(
      `\n✗ Refusing to ${args.parseOnly ? 'pass parse-only' : 'write'} — ${fatal.length} blocker(s):`,
    );
    for (const f of fatal) console.error(`   ${f}`);
    process.exitCode = 1;
    return;
  }
  if (args.parseOnly) {
    console.log('\n[parse-only] clean — nothing touched AWS.');
    return;
  }
  const tbcCount = relocation?.dateTbc.length ?? 0;
  console.log(
    `\n${builtSeries.length} draft series to write (${total} fixtures; ${relocation?.moves.length ?? 0} relocated, ${tbcCount} date-TBC); ${staleFound.length} stale series + their runs to delete first.`,
  );
  if (!args.confirm || !repo) {
    console.log(
      offline
        ? '[dry-run, OFFLINE] nothing written. Run under `sst shell` (no JSON flags) for the tenant dry run.'
        : '[dry-run] nothing written. Re-run with --confirm to import.',
    );
    if (repo && !args.noClubSync) {
      console.log('\n── Club league sync (dry-run preview):');
      const { syncClubLeaguesFromSeries } = await import('./sync-club-leagues-from-series.js');
      await syncClubLeaguesFromSeries(args.tenant, {
        confirm: false,
        only: [...builtIds],
        includeDrafts: true,
        series: builtSeries,
      });
    }
    return;
  }
  const res = await executeEmcuWrite(repo, args.tenant, builtSeries, {
    clubSync: !args.noClubSync,
  });
  printClashes('Post-write verification (stored tenant, findClashes)', res.postWriteClashes);
  if (res.drifted.length || res.postWriteClashes.length) {
    process.exitCode = 1;
    console.error(
      `\n✗ ${res.drifted.length} series NOT written (changed since read — re-run)` +
        `${res.postWriteClashes.length ? `; ${res.postWriteClashes.length} clash(es) in the stored tenant — inspect, or --revert --confirm` : ''}. Backup: ${res.backupPath}`,
    );
    return;
  }
  console.log(
    `\nDone. ${res.written.length} draft series written. Backup: ${res.backupPath}. Approve and release from the admin console.`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'import') return runImport(args);
  const repo = await import('./repo.js');
  if (args.mode === 'revert') {
    const r = await revertEmcu(repo, args.tenant, { confirm: args.confirm });
    if (r.refused.length) process.exitCode = 1;
    return;
  }
  const backup = JSON.parse(readFileSync(args.restoreFrom, 'utf8')) as EmcuBackup;
  const r = await restoreStale(repo, args.tenant, backup, { confirm: args.confirm });
  if (r.refused) process.exitCode = 1;
  else if (!args.confirm) console.log('Re-run with --confirm to restore.');
  else
    console.log(
      `Restored ${r.restoredSeries.length} series and ${r.restoredRuns.length} season run(s).`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
