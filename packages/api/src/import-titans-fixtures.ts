/**
 * Titans 2026-27 fixture import — the 36-sheet union workbook (1,398 fixtures) → 44 `s-titans-*`
 * Series rows on the `titans` tenant, as DRAFTS. Runbook: docs/runbooks/titans-fixtures-import.md.
 *
 *   npx tsx src/import-titans-fixtures.ts --parse-only [--report-out <path>]      # no AWS at all
 *   npx sst shell --stage <s> -- npx tsx src/import-titans-fixtures.ts …           # live tenant:
 *     (no mode flag)            import dry run   [--only <ids>] [--report-out <path>]
 *     --include-t20-ko          also build the T20 knockouts (tbd: sides — ONLY on a stage running
 *                               PR B, ADR 0018); [--ko-cutoff <YYYY-MM-DD>] (default --today)
 *     --confirm                 import: backup → write series → club sync → post-write re-scan
 *     --append-sides            plan the club sides the sheets need (dry run), --confirm writes
 *     --revert                  delete the manifest series (dry run), --confirm [--include-released]
 *     --restore-clubs <backup>  restore club structure fields from a backup (dry run), --confirm
 *   common: --file, --structure, --backup-dir, --today, --no-club-sync
 *
 * Parse every sheet, resolve every side to a live club side (titans-sides.ts), build the series
 * with stable fixture ids, and run the season-wide clash scan with release-gate semantics. The
 * `--structure` workbook (the August league-structure sheet) supplies club grounds in
 * --parse-only, so the release-gate preview can place TBC fixtures at the home club's ground.
 *
 * Fail-closed: a sheet off its measured count, an unparseable row, a side with no live team, a
 * stale HELD_BACK entry, a conflicting venue alias or any residual clash refuses the run. There
 * is NO --allow-clashes (standing rule). With `--only`, side/name blockers are scoped to the
 * series being written; HELD_BACK problems stay global.
 */
import ExcelJS from 'exceljs';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WrittenFixture } from './import-planb-fixtures.js';
import { carrySyncOwnedFields, reconcileFixtureIds } from './fixture-identity.js';
import {
  findClashes,
  groundKey,
  normaliseName,
  venueAliasesFor,
  JUNK_GROUND,
  DEFAULT_VENUE_ALIASES,
  type Clash,
} from './venue-clash.js';
import { hasFeature } from './features.js';
import { writeSeriesFromSnapshot } from './medicoach-sync/cli-write.js';
import { storedDraftDrift } from './import-lions-fixtures.js';
import { venueIdFor } from './lions-fixture-map.js';
import { isSlotRef, loserOf, slotSource, winnerOf } from '../../engine/src/formats.js';
import {
  AMBIGUOUS_VENUES,
  EXPECTED_TOTAL_FIXTURES,
  HELD_BACK,
  KO_RESOLVED,
  TITANS_GATE_ALIASES,
  TITANS_VENUE_SPELLINGS,
  canonicalVenueName,
  cleanVenue,
  isHeldBack,
  isTbcVenue,
  parseTitansWorkbook,
  seriesNameFor,
  leagueLabel,
  KNOWN_SERIES_IDS,
  T20_KO_SERIES_IDS,
  TITANS_LEAGUE_KEYS,
  TITANS_FIXTURE_SHEETS,
  TITANS_NEW_LEAGUES,
  TITANS_SERIES_PREFIX,
  TITANS_TENANT,
  TITANS_VENUE_ALIASES,
  VETERANS_KO_SERIES_IDS,
  TITANS_LEAGUE_OVERS,
  TITANS_OVERS_UNKNOWN,
  T20_HOST_LEAGUES,
  canonicalTeamName,
  provisionalSideId,
  resolveTeamClub,
  titansGroundKey,
  type HeldBackFixture,
  type KoResolvedFixture,
  type KoRow,
  type KoSlotProposal,
  type ParsedTitansSheet,
  type TimeSource,
  type TitansRawFixture,
} from './titans-fixture-map.js';
import { CLUB_MAP, parseStructureWorkbook, summarizeByClub } from './titans-import-map.js';
import type { Club, Series, TenantConfig, Venue } from './types.js';
import {
  planSides,
  sideKey,
  type ResolvedSide,
  type SideNeed,
  type SidePlan,
  type WomensPlacementRow,
} from './titans-sides.js';

type RepoModule = typeof import('./repo.js');

type SeriesParticipant = NonNullable<Series['participants']>[number];

export const DEFAULT_PATHS = {
  file: join(
    homedir(),
    'Downloads',
    '2026 Titans Club Cricket 2026-2027 Fixtures - 1st Half Final Final Draft.xlsx',
  ),
  structure: join(
    homedir(),
    'Downloads',
    'Titans Club Cricket 2026-2027 PROMOTION RELEGATION.xlsx',
  ),
};

// ───────────────────────── Series builder ─────────────────────────

export interface TitansFixture extends WrittenFixture {
  timeSource: TimeSource;
}

export interface BuiltTitansSeries {
  series: Series;
  /** Fixtures that would be written (held-back ones removed; ids stay reserved). */
  fixtures: TitansFixture[];
  /** Every parsed fixture, held-back included, index-aligned with `allFixtures`. */
  raw: TitansRawFixture[];
  allFixtures: TitansFixture[];
  junior: boolean;
  sheet: string;
}

export interface TitansBuildOutcome {
  built: BuiltTitansSeries[];
  /** Name-resolution sign-off: leagueKey::canonical → club. */
  resolutions: Map<
    string,
    { name: string; leagueKey: string; clubId: string; clubName: string; teamId: string }
  >;
  unresolvedNames: string[];
  /** The same, per series id — so `--only` can scope the blocker to the series it writes. */
  unresolvedBySeries: Map<string, string[]>;
  /** Stored fixtures the workbook no longer has, per series (fatal for that series). */
  removedBySeries: Map<string, string[]>;
  held: Array<{
    entry: HeldBackFixture;
    seriesId: string;
    /** Read AFTER stable ids are assigned. */
    fixtureId: string;
    raw: TitansRawFixture;
  }>;
  /** HELD_BACK entries that matched no parsed fixture, or more than one (fatal). */
  heldProblems: string[];
  tbc: Array<{
    seriesId: string;
    fixtureId: string;
    date: string;
    time: string;
    home: string;
    away: string;
  }>;
  /** Venues not in the registry: canonical name → fixture count (written as venueOverride). */
  registryMisses: Map<string, number>;
}

/** How a sheet side becomes a series participant on a real run (titans-sides.ts). Absent ⇒
 * the provisional parse-only ids. */
export interface BuildOptions {
  sideOf?: (leagueKey: string, name: string) => ResolvedSide | undefined;
  /** League label for series names (the tenant's own on a real run). */
  labelOf?: (key: string) => string;
  /** Registry lookup aliases (the tenant's own on a real run). */
  aliases?: Record<string, string>;
  /** The tenant's stored series by id — fixture ids are reconciled against them. */
  stored?: Map<string, Series>;
}

/**
 * Build every Series (planb/lions shape: participants snapshot, team-id home/away, `f<n>` ids,
 * dateMode 'reference', drafts). Fixture ids are STABLE: the kept fixtures are reconciled
 * against the stored series (fixture-identity.ts; `f1..fN` in row order on a first import),
 * then the held-back fixtures get the ids after the highest one the series has ever held, so
 * they never collide with a written fixture. Round = rank of the fixture's date among the
 * series' distinct dates. Pure.
 */
export function buildTitansSeries(
  sheets: ParsedTitansSheet[],
  venues: Venue[],
  heldBack: HeldBackFixture[] = HELD_BACK,
  opts: BuildOptions = {},
): TitansBuildOutcome {
  const keyOf = (n: string) => (opts.aliases ? groundKey(n, opts.aliases) : titansGroundKey(n));
  const registry = new Map<string, Venue>();
  for (const v of venues) registry.set(keyOf(v.name), v);
  const clubsById = new Map(CLUB_MAP.map((c) => [c.id, c]));
  const outcome: TitansBuildOutcome = {
    built: [],
    resolutions: new Map(),
    unresolvedNames: [],
    unresolvedBySeries: new Map(),
    removedBySeries: new Map(),
    held: [],
    heldProblems: [],
    tbc: [],
    registryMisses: new Map(),
  };
  const heldHits = new Map<HeldBackFixture, number>();

  for (const sheet of sheets) {
    for (const spec of sheet.spec.series) {
      const raw = sheet.fixtures.filter((f) => f.seriesId === spec.seriesId);
      const leagueKey = spec.leagueKey;
      const participants: SeriesParticipant[] = [];
      const teamIds: string[] = [];
      const unresolved = (u: string) => {
        if (!outcome.unresolvedNames.includes(u)) outcome.unresolvedNames.push(u);
        const list = outcome.unresolvedBySeries.get(spec.seriesId) ?? [];
        if (!list.includes(u)) list.push(u);
        outcome.unresolvedBySeries.set(spec.seriesId, list);
      };
      const side = (name: string): string => {
        const club = resolveTeamClub(name);
        if (!club) {
          unresolved(`${sheet.spec.sheet}: "${name}"`);
          return name;
        }
        const live = opts.sideOf ? opts.sideOf(leagueKey, name) : undefined;
        if (opts.sideOf && !live) {
          unresolved(`${sheet.spec.sheet}: "${name}" (${leagueKey}) has no side on the live club`);
          return name;
        }
        const teamId = live?.teamId ?? provisionalSideId(leagueKey, name);
        const key = `${leagueKey}::${name}`;
        if (!outcome.resolutions.has(key))
          outcome.resolutions.set(key, {
            name,
            leagueKey,
            clubId: club.id,
            clubName: clubsById.get(club.id)?.name ?? club.name,
            teamId,
          });
        if (!teamIds.includes(teamId)) {
          teamIds.push(teamId);
          participants.push({
            teamId,
            clubId: club.id,
            name: live?.name ?? name,
            ...(live?.venue ? { venue: live.venue } : {}),
          });
        }
        return teamId;
      };
      const dates = [...new Set(raw.map((f) => f.date))].sort();
      const all: TitansFixture[] = raw.map((f, i) => {
        const wf: TitansFixture = {
          id: `f${i + 1}`,
          round: dates.indexOf(f.date) + 1,
          date: f.date,
          time: f.time,
          timeSource: f.timeSource,
          home: side(f.home),
          away: side(f.away),
        };
        if (f.venue == null) {
          wf.venueStatus = 'unresolved';
          wf.venueReason = 'Titans 2026-27 fixtures workbook — venue TBC';
          return wf;
        }
        wf.venueReason = 'Titans 2026-27 fixtures workbook — exact venue';
        const v = registry.get(keyOf(f.venue));
        if (v) {
          wf.venueId = v.id;
          wf.venueName = v.name;
          wf.venueLocked = true;
        } else {
          wf.venueOverride = f.venue;
          wf.venueName = f.venue;
          outcome.registryMisses.set(f.venue, (outcome.registryMisses.get(f.venue) ?? 0) + 1);
        }
        return wf;
      });
      const kept: TitansFixture[] = [];
      const heldHere: Array<{ entry: HeldBackFixture; wf: TitansFixture; raw: TitansRawFixture }> =
        [];
      all.forEach((wf, i) => {
        const h = isHeldBack(raw[i], heldBack);
        if (h) {
          heldHits.set(h, (heldHits.get(h) ?? 0) + 1);
          heldHere.push({ entry: h, wf, raw: raw[i] });
        } else kept.push(wf);
      });
      // Stable ids: kept fixtures against the stored series, then held-back ones after.
      const storedSeries = opts.stored?.get(spec.seriesId);
      const r = stabiliseIds(kept, storedSeries);
      if (r.removed.length) outcome.removedBySeries.set(spec.seriesId, r.removed);
      const idNum = (id?: string) => Number(/^f(\d+)$/.exec(id ?? '')?.[1] ?? 0);
      let next = Math.max(
        0,
        ...kept.map((f) => idNum(f.id)),
        ...((storedSeries?.fixtures as WrittenFixture[] | undefined) ?? []).map((f) => idNum(f.id)),
      );
      for (const h of heldHere) {
        h.wf.id = `f${++next}`;
        outcome.held.push({
          entry: h.entry,
          seriesId: spec.seriesId,
          fixtureId: h.wf.id,
          raw: h.raw,
        });
      }
      kept.forEach((wf) => {
        const rf = raw[all.indexOf(wf)];
        if (rf.venue == null)
          outcome.tbc.push({
            seriesId: spec.seriesId,
            fixtureId: wf.id,
            date: wf.date,
            time: wf.time ?? '',
            home: rf.home,
            away: rf.away,
          });
      });
      const keptDates = kept.map((f) => f.date).sort();
      const series = {
        id: spec.seriesId,
        name: seriesNameFor(spec, opts.labelOf),
        leagueKey,
        startDate: keptDates[0],
        endDate: keptDates[keptDates.length - 1],
        dateMode: 'reference',
        teams: teamIds,
        participants,
        fixtures: kept,
        ...(sheet.spec.layout === 't20' ? { seriesType: 'T20' } : {}),
        // Sourced overs only (TITANS_LEAGUE_OVERS); unknown ones stay unset and are reported.
        ...(TITANS_LEAGUE_OVERS[leagueKey]
          ? { maxOvers: TITANS_LEAGUE_OVERS[leagueKey].maxOvers }
          : {}),
        kind: 'series',
        // Drafts on purpose: the admin approves + releases from the console.
        approved: false,
        released: false,
        releasedAt: null,
        version: 1,
      } as unknown as Series;
      outcome.built.push({
        series,
        fixtures: kept,
        raw,
        allFixtures: all,
        junior: sheet.spec.junior,
        sheet: sheet.spec.sheet,
      });
    }
  }
  for (const h of heldBack) {
    const n = heldHits.get(h) ?? 0;
    if (n !== 1)
      outcome.heldProblems.push(
        `HELD_BACK ${h.sheet} ${h.date} ${h.home} v ${h.away} @ ${h.venue} matched ${n} parsed fixture(s), expected exactly 1`,
      );
  }
  return outcome;
}

// ───────────────────────── Would-be registry ─────────────────────────

/** One registry row per canonical ground name (fixture venues + club grounds), one pitch each
 * (capacity unknown until the union answers); homeClubIds = the clubs hosting 2+ home
 * fixtures there in the workbook (veterans central-venue days excluded), plus the club whose
 * own ground it is. */
export function wouldBeRegistry(sheets: ParsedTitansSheet[], clubs: Club[]): Venue[] {
  const byKey = new Map<string, Venue>();
  const add = (rawName: string, clubId?: string) => {
    if (!usableGround(rawName)) return;
    const name = canonicalVenueName(rawName);
    const k = titansGroundKey(name);
    let v = byKey.get(k);
    if (!v) {
      v = { id: venueIdFor(name), name, homeClubIds: [], surfaces: 1 };
      byKey.set(k, v);
    }
    if (clubId && !v.homeClubIds!.includes(clubId)) v.homeClubIds!.push(clubId);
  };
  // A club hosting at least 2 home fixtures at a ground calls it home (plus its own club
  // ground). Veterans fixtures are left out: that league plays central venue days where the
  // "home" side is only the first-named team, not the ground's club.
  const hosted = new Map<string, number>();
  for (const s of sheets)
    for (const f of s.fixtures) {
      if (!f.venue) continue;
      add(f.venue);
      const clubId = resolveTeamClub(f.home)?.id;
      if (!clubId || s.spec.leagueKey === 'veterans-league') continue;
      const k = `${f.venue}\u0000${clubId}`;
      hosted.set(k, (hosted.get(k) ?? 0) + 1);
    }
  for (const [k, n] of hosted) {
    const [venue, clubId] = k.split('\u0000');
    if (n >= 2) add(venue, clubId);
  }
  for (const c of clubs)
    if (c.ground?.venue && !isTbcVenue(c.ground.venue)) add(c.ground.venue, c.id);
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A ground name that names a real ground: not TBC, not a junk placeholder ("N/A", "-",
 * "None" — venue-clash.ts's JUNK_GROUND), and not empty once normalised. */
export function usableGround(name: string | null | undefined): boolean {
  const t = (name ?? '').trim();
  return !!t && !isTbcVenue(t) && !JUNK_GROUND.test(t) && normaliseName(t) !== '';
}

/** CLUB_MAP as skeletal Club records, with `ground.venue` from the structure workbook when given
 * (what the August compliance import wrote to each club). */
export function clubsFromMap(groundByClub: Map<string, string> = new Map()): Club[] {
  return CLUB_MAP.map(
    (c) =>
      ({
        id: c.id,
        name: c.name,
        ground: groundByClub.has(c.id) ? { venue: groundByClub.get(c.id) } : {},
      }) as unknown as Club,
  );
}

// ───────────────────────── Clash scan ─────────────────────────

export type ClashTag = string;

export interface TaggedClash extends Clash {
  seriesId: string;
  seriesName: string;
  /** Time sources of the two fixtures, sorted: `sheet-vs-provisional` etc. */
  tag: ClashTag;
}

/** A stored series without the fixtures explicitly marked venue-TBC (`venueStatus:
 * 'unresolved'` and no ground). Unlike `withoutTbc` it keeps a legacy fixture that simply
 * carries no venue fields — the gate rightly books that one at the home club's ground. */
function withoutMarkedTbc(s: Series): Series {
  return {
    ...s,
    fixtures: ((s.fixtures as WrittenFixture[]) ?? []).filter(
      (f) => !(f.venueStatus === 'unresolved' && !f.venueOverride && !f.venueName),
    ),
  };
}

function withoutTbc(s: Series): Series {
  return {
    ...s,
    fixtures: (s.fixtures as WrittenFixture[]).filter((f) => f.venueOverride || f.venueName),
  };
}

/**
 * Season-wide clash scan with release-gate semantics (venue-clash.ts `findClashes`, the gate's
 * alias map, registry surfaces as capacity). Each series is checked against the tenant's other
 * series plus the built series before it, so every double-booking is reported exactly once.
 * TBC fixtures are excluded unless `includeTbc` (the release-gate preview: the gate places
 * them at the home club's ground). A fixture of another (stored) series tags as `existing`.
 */
export function scanTitansClashes(
  built: Series[],
  clubs: Club[],
  venues: Venue[],
  opts: {
    includeTbc?: boolean;
    existingOther?: Series[];
    aliases?: Record<string, string>;
  } = {},
): TaggedClash[] {
  const sourceOf = new Map<string, TimeSource>();
  for (const s of built)
    for (const f of s.fixtures as TitansFixture[]) sourceOf.set(`${s.id}/${f.id}`, f.timeSource);
  const subjects = opts.includeTbc ? built : built.map(withoutTbc);
  // The strict scan drops TBC fixtures on BOTH sides: a stored series outside this run (an
  // --only re-import) must not reintroduce its venue-less fixtures at the club ground.
  const others = opts.includeTbc
    ? (opts.existingOther ?? [])
    : (opts.existingOther ?? []).map(withoutMarkedTbc);
  const out: TaggedClash[] = [];
  for (let i = 0; i < subjects.length; i++) {
    const subject = subjects[i];
    for (const c of findClashes(
      subject,
      [...others, ...subjects.slice(0, i)],
      clubs,
      venues,
      opts.aliases ?? TITANS_GATE_ALIASES,
    )) {
      const a = sourceOf.get(`${subject.id}/${c.fixtureId}`) ?? 'existing';
      const b = sourceOf.get(`${c.with.seriesId}/${c.with.fixtureId}`) ?? 'existing';
      out.push({
        ...c,
        seriesId: String(subject.id),
        seriesName: subject.name,
        tag: [a, b].sort().join('-vs-'),
      });
    }
  }
  return out;
}

/** The built series with their held-back fixtures put back (the "before HELD_BACK" scan). */
function withHeldBack(built: BuiltTitansSeries[]): Series[] {
  return built.map((b) => ({ ...b.series, fixtures: b.allFixtures }) as unknown as Series);
}

// ───────────────────────── Knockouts + stable ids ─────────────────────────

export interface KoFixture extends TitansFixture {
  stage: string;
}

/**
 * The veterans playoff series (A4): one per division, `pos:<division>:<rank>` and `win:f1`
 * sides only (the prefixes the engine already resolves), real sheet dates and times, no
 * ground ("2ND PLACE HOME VENUE" is the home side's ground once known). Participants = the
 * division's, so the bracket's eventual teams are already series participants. T20 brackets
 * are NOT built here: they need PR B's `tbd:` slots. Pure.
 */
export function buildVeteransKnockouts(
  sheets: ParsedTitansSheet[],
  built: BuiltTitansSeries[],
  labelOf?: (key: string) => string,
): { series: Series[]; errors: string[] } {
  const out: Series[] = [];
  const errors: string[] = [];
  for (const sheet of sheets) {
    const koId = sheet.spec.koSeriesId;
    if (!koId || !VETERANS_KO_SERIES_IDS.includes(koId)) continue;
    const division = built.find((b) => b.series.id === sheet.spec.series[0].seriesId);
    if (!division) continue; // out of --only scope
    const rows = sheet.ko;
    const fixtures: KoFixture[] = [];
    rows.forEach((k, i) => {
      for (const p of [k.home, k.away])
        if (p.kind !== 'pos' && p.kind !== 'win')
          errors.push(`${koId} ${k.fixtureId}: "${p.raw}" → ${p.ref} is not a pos:/win: slot`);
      fixtures.push({
        id: k.fixtureId,
        round: i + 1,
        date: k.date,
        time: k.time,
        timeSource: k.timeSource,
        home: k.home.ref,
        away: k.away.ref,
        stage: i === rows.length - 1 ? 'Final' : 'Semi-final',
        venueStatus: 'unresolved',
        venueReason: `Titans 2026-27 fixtures workbook — "${k.rawVenue}"`,
      });
    });
    const dates = fixtures.map((f) => f.date).sort();
    const participants = division.series.participants ?? [];
    out.push({
      id: koId,
      name: `${seriesNameFor(sheet.spec.series[0], labelOf)} · Playoff`,
      leagueKey: sheet.spec.leagueKey,
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      dateMode: 'reference',
      teams: participants.map((p) => p.teamId),
      participants,
      fixtures,
      kind: 'series',
      approved: false,
      released: false,
      releasedAt: null,
      version: 1,
    } as unknown as Series);
  }
  return { series: out, errors };
}

/**
 * Stable fixture ids across re-imports (fixture-identity.ts): the incoming fixtures — held-back
 * ones INCLUDED, so their positions stay reserved on a first import — are matched to the stored
 * series' fixtures, whose sides read `slots[side] ?? side` so a knockout fixture whose team was
 * set in the console still matches its placeholder row. Mutates the incoming ids in place.
 */
export function stabiliseIds(
  incoming: TitansFixture[],
  stored: Series | undefined,
): { matched: number; added: string[]; removed: string[] } {
  type Slotted = WrittenFixture & { slots?: { home?: string; away?: string } };
  const byPlaceholder = (f: Slotted) => ({
    ...f,
    home: f.slots?.home ?? f.home,
    away: f.slots?.away ?? f.away,
  });
  const existing = ((stored?.fixtures as Slotted[] | undefined) ?? []).map(byPlaceholder);
  // An incoming knockout side the union already resolved (KO_RESOLVED) is matched by its
  // placeholder too, so the same row keeps its id whichever side got its team first.
  const keyed = (incoming as Slotted[]).map(byPlaceholder);
  const r = reconcileFixtureIds(existing, keyed);
  keyed.forEach((k, i) => {
    incoming[i].id = k.id;
    // reconcileFixtureIds carried the stored sync-owned fields onto the keyed copy.
    carrySyncOwnedFields(k, incoming[i]);
  });
  return {
    matched: r.matched,
    added: r.added,
    removed: r.removed.map((f) => `${f.id} ${f.date} ${f.home} v ${f.away}`),
  };
}

/**
 * Stable ids for a KNOCKOUT series, whose fixtures point at each other (`win:f3`). Plain
 * `stabiliseIds` would renumber an unmatched fixture (`f9` for sheet row f1) without touching
 * the `win:`/`lose:` refs that name it, leaving a dangling or WRONG link. So, round by round
 * (a link always points at an earlier round):
 *
 * - the round's refs are rewritten to the ids already settled (sheet id → final id),
 * - its fixtures are matched to the stored ones by `slots[side] ?? side` (risk R8),
 * - a matched fixture keeps the stored id (and its sync-owned fields); an unmatched one keeps
 *   its SHEET id when no stored fixture holds it, else gets max + 1 over every stored and
 *   sheet id (never a reused id),
 *
 * and finally every `win:`/`lose:` ref (sides and `slots`) is rewritten from the ORIGINAL
 * sheet ids, so nothing is mapped twice. Mutates `incoming`; returns the stored fixtures no
 * incoming row matched ("f3 2026-10-10 a v b") and the ids that changed.
 */
export function stabiliseKoIds(
  incoming: KoFixture[],
  stored: Series | undefined,
): { removed: string[]; renamed: Array<[string, string]> } {
  type Slotted = KoFixture & { slots?: { home?: string; away?: string } };
  const byPlaceholder = (f: Slotted) => ({
    ...f,
    home: f.slots?.home ?? f.home,
    away: f.slots?.away ?? f.away,
  });
  const idNum = (id?: string) => Number(/^f(\d+)$/.exec(id ?? '')?.[1] ?? 0);
  let pool = ((stored?.fixtures as Slotted[] | undefined) ?? []).map(byPlaceholder);
  const storedIds = new Set(pool.map((f) => f.id));
  const orig = new Map(
    (incoming as Slotted[]).map((f) => [
      f,
      { id: f.id, home: f.home, away: f.away, slots: f.slots ? { ...f.slots } : undefined },
    ]),
  );
  const map = new Map<string, string>();
  const used = new Set<string>();
  let next = Math.max(0, ...[...storedIds, ...incoming.map((f) => f.id)].map(idNum));
  const rewrite = (ref: string | undefined): string | undefined => {
    const src = ref ? slotSource(ref) : null;
    const to = src ? map.get(src.fixtureId) : undefined;
    if (!src || !to) return ref;
    return src.kind === 'winner' ? winnerOf(to) : loserOf(to);
  };
  const applyRefs = (f: Slotted) => {
    const o = orig.get(f)!;
    f.home = rewrite(o.home)!;
    f.away = rewrite(o.away)!;
    if (o.slots) {
      const slots: { home?: string; away?: string } = {};
      if (o.slots.home) slots.home = rewrite(o.slots.home);
      if (o.slots.away) slots.away = rewrite(o.slots.away);
      f.slots = slots;
    }
  };
  const rounds = [...new Set(incoming.map((f) => Number(f.round) || 0))].sort((a, b) => a - b);
  for (const round of rounds) {
    const group = (incoming as Slotted[]).filter((f) => (Number(f.round) || 0) === round);
    group.forEach(applyRefs);
    const keyed = group.map(byPlaceholder);
    reconcileFixtureIds(pool, keyed);
    group.forEach((f, i) => {
      const sheetId = orig.get(f)!.id;
      const k = keyed[i];
      let id: string;
      if (storedIds.has(k.id) && pool.some((x) => x.id === k.id)) {
        id = k.id;
        carrySyncOwnedFields(k, f);
        pool = pool.filter((x) => x.id !== k.id);
      } else if (!storedIds.has(sheetId) && !used.has(sheetId)) id = sheetId;
      else {
        do id = `f${++next}`;
        while (used.has(id) || storedIds.has(id));
      }
      used.add(id);
      map.set(sheetId, id);
      f.id = id;
    });
  }
  (incoming as Slotted[]).forEach(applyRefs);
  return {
    removed: pool.map((f) => `${f.id} ${f.date} ${f.home} v ${f.away}`),
    renamed: [...map].filter(([a, b]) => a !== b),
  };
}

// ───────────────────────── T20 knockouts (PR B) ─────────────────────────

/** A problem with one knockout series — `seriesId` scopes it to `--only`. */
export interface KoError {
  seriesId: string;
  message: string;
}

/** A knockout fixture left out of the write, and why (union report, risk R10). */
export interface KoSkip {
  koSeriesId: string;
  fixtureId: string;
  stage: string;
  date: string;
  home: string;
  away: string;
  reason: string;
}

export interface T20KnockoutOptions {
  /** KO fixtures dated BEFORE this (YYYY-MM-DD) are written only with both teams known. */
  cutoff: string;
  /** Union-confirmed teams (default: KO_RESOLVED). */
  resolved?: Record<string, Record<string, KoResolvedFixture>>;
  /** How a sheet team name becomes a live side (absent ⇒ the provisional parse-only ids). */
  sideOf?: (leagueKey: string, name: string) => ResolvedSide | undefined;
  labelOf?: (key: string) => string;
  /** The tenant's stored series by id: ids are reconciled and console-set teams carried. */
  stored?: Map<string, Series>;
}

/** The stage a knockout row plays: the sheet's Q/S tag, else a winners' final, else a play-off
 * (the men's Community Cup winner v Group E winner row, which nothing in the bracket feeds). */
export function koStage(k: Pick<KoRow, 'tag' | 'home' | 'away'>): { stage: string; round: number } {
  if (k.tag?.startsWith('Q')) return { stage: 'Quarter-final', round: 1 };
  if (k.tag?.startsWith('S')) return { stage: 'Semi-final', round: 2 };
  if (k.home.kind === 'win' && k.away.kind === 'win') return { stage: 'Final', round: 3 };
  return { stage: 'Play-off', round: 4 };
}

/**
 * The T20 knockout series (ADR 0018): one per T20 sheet, the parsed KO rows with their `pos:`,
 * `win:` and `tbd:` sides, real sheet dates and session times, no ground (the sheet's "WINNER
 * GA (Q1)" means the home side's ground once known: venueStatus unresolved). Participants =
 * the union of the sheet's group series, so every team that can reach the bracket is already
 * a participant ("Set team" picks from them first).
 *
 * Past dates (risk R10): a fixture dated before `cutoff` is written only when both sides are
 * real teams (KO_RESOLVED, a named team on the sheet, or a team already set in the console)
 * or it is already stored; otherwise it is SKIPPED and reported — never an empty bracket for a
 * date already played, and never a stored fixture silently dropped. A kept fixture fed
 * (`win:`) by a skipped one is an error: name its team in KO_RESOLVED or move the cutoff. A
 * side resolved from KO_RESOLVED keeps its placeholder in `slots[side]`, exactly as Set team
 * does. Ids are stable against the stored series (`slots[side] ?? side`, risk R8). Pure.
 */
export function buildT20Knockouts(
  sheets: ParsedTitansSheet[],
  built: BuiltTitansSeries[],
  opts: T20KnockoutOptions,
): {
  series: Series[];
  skipped: KoSkip[];
  errors: KoError[];
  resolvedSides: string[];
  /** Console Set-team sides kept on a re-import (carryConsoleSides). */
  carried: string[];
} {
  const resolved = opts.resolved ?? KO_RESOLVED;
  const out: Series[] = [];
  const skipped: KoSkip[] = [];
  const errors: KoError[] = [];
  const resolvedSides: string[] = [];
  const carried: string[] = [];
  for (const sheet of sheets) {
    const koId = sheet.spec.koSeriesId;
    if (!koId || !T20_KO_SERIES_IDS.includes(koId)) continue;
    const groups = sheet.spec.series.map((x) => built.find((b) => b.series.id === x.seriesId));
    if (groups.some((g) => !g)) continue; // out of --only scope
    const leagueKey = sheet.spec.leagueKey;
    const fail = (message: string) => errors.push({ seriesId: koId, message });
    const participants: SeriesParticipant[] = [];
    for (const g of groups)
      for (const p of g!.series.participants ?? [])
        if (!participants.some((x) => x.teamId === p.teamId)) participants.push(p);
    const teamOf = (name: string, where: string): string | null => {
      const canonical = canonicalTeamName(name);
      const club = resolveTeamClub(canonical);
      if (!club) {
        fail(`${where}: "${name}" is not a Titans club`);
        return null;
      }
      const live = opts.sideOf ? opts.sideOf(leagueKey, canonical) : undefined;
      if (opts.sideOf && !live) {
        fail(`${where}: "${name}" (${leagueKey}) has no side on the live club`);
        return null;
      }
      const teamId = live?.teamId ?? provisionalSideId(leagueKey, canonical);
      if (!participants.some((p) => p.teamId === teamId))
        participants.push({
          teamId,
          clubId: club.id,
          name: live?.name ?? canonical,
          ...(live?.venue ? { venue: live.venue } : {}),
        });
      return teamId;
    };
    const fixtures: KoFixture[] = [];
    const rowOf = new Map<KoFixture, KoRow>();
    for (const k of sheet.ko) {
      const { stage, round } = koStage(k);
      const res = resolved[koId]?.[k.fixtureId] ?? {};
      const where = `${koId} ${k.fixtureId}`;
      const sideFor = (p: KoSlotProposal, union: string | undefined) => {
        if (union) {
          const teamId = teamOf(union, where);
          if (teamId && p.kind !== 'team') resolvedSides.push(`${where}: ${p.ref} → ${union}`);
          return { value: teamId ?? p.ref, slot: p.kind === 'team' ? undefined : p.ref };
        }
        if (p.kind === 'team')
          return { value: teamOf(p.ref.slice('team:'.length), where) ?? p.ref };
        return { value: p.ref };
      };
      const home = sideFor(k.home, res.home);
      const away = sideFor(k.away, res.away);
      const slots = {
        ...(home.slot ? { home: home.slot } : {}),
        ...(away.slot ? { away: away.slot } : {}),
      };
      const f = {
        id: k.fixtureId,
        round,
        date: k.date,
        time: k.time,
        timeSource: k.timeSource,
        home: home.value,
        away: away.value,
        ...(Object.keys(slots).length ? { slots } : {}),
        stage,
        venueStatus: 'unresolved',
        venueReason: `Titans 2026-27 fixtures workbook — "${k.rawVenue}"`,
      } as KoFixture;
      fixtures.push(f);
      rowOf.set(f, k);
    }
    const dates = fixtures.map((f) => f.date).sort();
    const series = {
      id: koId,
      name: `${(opts.labelOf ?? leagueLabel)(leagueKey)} · Knockouts`,
      leagueKey,
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      dateMode: 'reference',
      teams: [] as string[],
      participants,
      fixtures,
      seriesType: 'T20',
      ...(TITANS_LEAGUE_OVERS[leagueKey]
        ? { maxOvers: TITANS_LEAGUE_OVERS[leagueKey].maxOvers }
        : {}),
      kind: 'series',
      approved: false,
      released: false,
      releasedAt: null,
      version: 1,
    } as unknown as Series;
    // Stable ids, then the console's Set-team sides, BEFORE the cutoff: a team set in the
    // console makes a past fixture known, and a stored fixture is never dropped.
    const stored = opts.stored?.get(koId);
    const st = stabiliseKoIds(fixtures, stored);
    for (const x of st.removed) fail(`${koId}: stored fixture ${x} is not in the workbook`);
    series.teams = participants.map((p) => p.teamId);
    carried.push(...carryConsoleSides(series, stored));
    const storedIds = new Set(((stored?.fixtures as KoFixture[]) ?? []).map((f) => f.id));
    const keep = fixtures.filter((f) => {
      const past = f.date < opts.cutoff && (isSlotRef(f.home) || isSlotRef(f.away));
      if (!past || storedIds.has(f.id)) return true;
      const k = rowOf.get(f)!;
      skipped.push({
        koSeriesId: koId,
        fixtureId: f.id,
        stage: f.stage,
        date: f.date,
        home: k.rawHome,
        away: k.rawAway,
        reason: `dated before the knockout cutoff ${opts.cutoff} and the union has not confirmed both teams (KO_RESOLVED)`,
      });
      return false;
    });
    const kept = new Set(keep.map((f) => f.id));
    for (const f of keep)
      for (const side of ['home', 'away'] as const) {
        const src = slotSource(f[side]);
        if (src && !kept.has(src.fixtureId))
          fail(
            `${koId} ${f.id} (${f.date}): its ${side} side is the ${src.kind} of ${src.fixtureId}, which is skipped — name the team in KO_RESOLVED or move --ko-cutoff`,
          );
      }
    if (!keep.length) continue;
    const keptDates = keep.map((f) => f.date).sort();
    out.push({
      ...series,
      fixtures: keep,
      startDate: keptDates[0],
      endDate: keptDates[keptDates.length - 1],
    } as Series);
  }
  return { series: out, skipped, errors, resolvedSides, carried };
}

/**
 * Keep the teams an admin already set in the console (Set team, ADR 0018) when a knockout is
 * re-imported: a stored fixture side whose `slots[side]` is the placeholder the sheet still
 * has keeps its team, its slot and its participant. A side the union resolved this run
 * (KO_RESOLVED) wins over the console. Run AFTER stabiliseIds. Mutates `built`; returns one
 * line per side carried.
 */
export function carryConsoleSides(built: Series, stored: Series | undefined): string[] {
  if (!stored) return [];
  type Slotted = WrittenFixture & { slots?: { home?: string; away?: string } };
  const byId = new Map(((stored.fixtures as Slotted[]) ?? []).map((f) => [f.id, f]));
  const participants = [...(built.participants ?? [])];
  const teams = [...(built.teams ?? [])];
  const notes: string[] = [];
  for (const f of built.fixtures as Slotted[]) {
    const s = byId.get(f.id);
    if (!s?.slots) continue;
    for (const side of ['home', 'away'] as const) {
      const placeholder = f[side];
      if (f.slots?.[side] || !isSlotRef(placeholder) || s.slots[side] !== placeholder) continue;
      const teamId = s[side];
      if (!teamId || isSlotRef(teamId)) continue;
      f[side] = teamId;
      f.slots = { ...(f.slots ?? {}), [side]: placeholder };
      if (!participants.some((p) => p.teamId === teamId)) {
        const p = stored.participants?.find((x) => x.teamId === teamId);
        if (p) participants.push(p);
      }
      if (!teams.includes(teamId)) teams.push(teamId);
      notes.push(
        `${built.id} ${f.id} ${side}: kept the console's team ${teamId} (placeholder ${placeholder})`,
      );
    }
  }
  built.participants = participants;
  built.teams = teams;
  return notes;
}

// ───────────────────────── Report helpers ─────────────────────────

export interface SharedGroundDay {
  date: string;
  ground: string;
  junior: string[];
  senior: string[];
}

/** Ground-days where a junior fixture on its provisional 08:30 and a senior fixture on its
 * provisional 13:00 share a ground. Not clashes (different start times), but the "junior game
 * is over by 13:00" assumption is the union's to confirm (risk R1). */
export function sharedGroundDays(built: BuiltTitansSeries[]): SharedGroundDay[] {
  const byDay = new Map<string, SharedGroundDay>();
  for (const b of built) {
    const names = new Map((b.series.participants ?? []).map((p) => [p.teamId, p.name]));
    for (const f of b.fixtures) {
      const ground = f.venueOverride || f.venueName;
      if (!ground || f.timeSource !== 'provisional') continue;
      const k = `${f.date}|${titansGroundKey(ground)}`;
      const e = byDay.get(k) ?? { date: f.date, ground, junior: [], senior: [] };
      const label = `${f.time} ${b.series.name}: ${names.get(f.home) ?? f.home} v ${names.get(f.away) ?? f.away}`;
      (b.junior ? e.junior : e.senior).push(label);
      byDay.set(k, e);
    }
  }
  return [...byDay.values()]
    .filter((e) => e.junior.length && e.senior.length)
    .sort((a, b) => a.date.localeCompare(b.date) || a.ground.localeCompare(b.ground));
}

/** Every OTHER ground-day where a fixture on a provisional time shares the ground with a
 * fixture at a different start time (e.g. a sheet-timed veterans game, a T20 session, or two
 * senior leagues on one complex) — the same "does the earlier game finish in time" question,
 * outside the junior-08:30/senior-13:00 pattern. */
export function otherProvisionalOverlapDays(
  built: BuiltTitansSeries[],
): Array<{ date: string; ground: string; entries: string[] }> {
  const junSen = new Set(
    sharedGroundDays(built).map((d) => `${d.date}|${titansGroundKey(d.ground)}`),
  );
  const byDay = new Map<
    string,
    {
      date: string;
      ground: string;
      items: Array<{ time: string; source: TimeSource; label: string }>;
    }
  >();
  for (const b of built) {
    const names = new Map((b.series.participants ?? []).map((p) => [p.teamId, p.name]));
    for (const f of b.fixtures) {
      const ground = f.venueOverride || f.venueName;
      if (!ground) continue;
      const k = `${f.date}|${titansGroundKey(ground)}`;
      const e = byDay.get(k) ?? { date: f.date, ground, items: [] };
      e.items.push({
        time: f.time ?? '',
        source: f.timeSource,
        label: `${f.time} (${f.timeSource}) ${b.series.name}: ${names.get(f.home) ?? f.home} v ${names.get(f.away) ?? f.away}`,
      });
      byDay.set(k, e);
    }
  }
  const out: Array<{ date: string; ground: string; entries: string[] }> = [];
  for (const [k, e] of byDay) {
    if (junSen.has(k)) continue;
    const times = new Set(e.items.map((i) => i.time));
    if (times.size > 1 && e.items.some((i) => i.source === 'provisional'))
      out.push({ date: e.date, ground: e.ground, entries: e.items.map((i) => i.label).sort() });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.ground.localeCompare(b.ground));
}

/** Raw venue spellings that resolved onto a different canonical ground name, with counts. */
export function aliasesApplied(
  sheets: ParsedTitansSheet[],
): Array<{ raw: string; canonical: string; count: number }> {
  const m = new Map<string, { raw: string; canonical: string; count: number }>();
  for (const s of sheets)
    for (const f of s.fixtures) {
      if (!f.venue) continue;
      const raw = cleanVenue(f.rawVenue);
      if (raw === f.venue) continue;
      const e = m.get(raw) ?? { raw, canonical: f.venue, count: 0 };
      e.count++;
      m.set(raw, e);
    }
  return [...m.values()].sort((a, b) => a.raw.localeCompare(b.raw));
}

/** DEFAULT_VENUE_ALIASES (dolphins) keys a titans spelling would hit — expected none. */
export function defaultAliasHits(sheets: ParsedTitansSheet[]): string[] {
  const hits = new Set<string>();
  for (const s of sheets)
    for (const f of s.fixtures)
      if (
        f.venue &&
        Object.prototype.hasOwnProperty.call(DEFAULT_VENUE_ALIASES, normaliseName(f.venue))
      )
        hits.add(f.venue);
  return [...hits];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function clashLine(c: TaggedClash): string {
  return `${c.date} ${c.time ?? ''} ${c.ground}: ${c.seriesName} R${c.round} ${c.home} v ${c.away} ⟷ ${c.with.seriesName ?? c.with.seriesId} R${c.with.round} ${c.with.home} v ${c.with.away} [${c.tag}]`;
}

function tagCounts(clashes: TaggedClash[]): string {
  const m = new Map<string, number>();
  for (const c of clashes) m.set(c.tag, (m.get(c.tag) ?? 0) + 1);
  return [...m].map(([t, n]) => `${t} ×${n}`).join(', ') || 'none';
}

function koLine(k: KoRow): string {
  const slot = (p: KoRow['home']) => `"${p.raw}" → ${p.ref}${p.note ? ` (${p.note})` : ''}`;
  return `${k.koSeriesId} ${k.fixtureId}${k.tag ? ` [${k.tag}]` : ''} row ${k.row}: ${k.date} ${k.time} (${k.timeSource}) ${slot(k.home)} v ${slot(k.away)} @ "${k.rawVenue}"`;
}

// ───────────────────────── Union report ─────────────────────────

export interface UnionReport {
  generatedAt: string;
  today: string;
  workbook: string;
  totals: {
    fixtures: number;
    expected: number;
    written: number;
    heldBack: number;
    byes: number;
    koRows: number;
  };
  sheets: Array<{
    sheet: string;
    series: Array<{ seriesId: string; name: string; parsed: number; expected: number }>;
    byes: number;
    koRows: number;
    banners: string[];
    splitRounds: number;
    timeSources: Record<string, number>;
  }>;
  provisionalTimes: Array<{
    seriesId: string;
    name: string;
    provisional: number;
    time: string;
    total: number;
  }>;
  sharedGroundDays: SharedGroundDay[];
  otherOverlapDays: Array<{ date: string; ground: string; entries: string[] }>;
  heldBack: Array<{
    sheet: string;
    seriesId: string;
    fixtureId: string;
    date: string;
    time: string;
    home: string;
    away: string;
    venue: string | null;
    reason: string;
  }>;
  ambiguousVenues: Array<{
    names: string[];
    question: string;
    inWorkbook: Array<{ name: string; fixtures: number }>;
  }>;
  venueAliasesApplied: Array<{ raw: string; canonical: string; count: number }>;
  venueSpellings: Array<{ name: string; aliases: string[]; note: string }>;
  knockouts: KoRow[];
  /** T20 knockout fixtures left out (`--include-t20-ko` runs only; risk R10). */
  knockoutsSkipped?: KoSkip[];
  splitRounds: Array<{ sheet: string; date: string; rows: number }>;
  tbcVenues: TitansBuildOutcome['tbc'];
  pastFixtures: Array<{
    seriesId: string;
    fixtureId: string;
    date: string;
    time: string;
    home: string;
    away: string;
    venue: string | null;
  }>;
  dateCorrections: string[];
  clashes: {
    beforeHeldBack: TaggedClash[];
    afterHeldBack: TaggedClash[];
    gatePreview: TaggedClash[] | null;
  };
  womensLeagueTeams: Array<{ name: string; clubId: string; clubName: string }>;
  /** Leagues whose match length no source states (left unset on the series). */
  oversUnknown: Array<{ leagueKey: string; label: string; why: string }>;
  /** Live run only: registry rows no workbook fixture or club ground uses (cleanup items). */
  registryCleanup?: Array<{ id: string; name: string; homeClubIds: string[] }>;
  /** Live run only: the per-club premier/promotion placement table (risk R6). */
  womensPlacement?: WomensPlacementRow[];
  todo: string[];
}

export function renderUnionMarkdown(r: UnionReport): string {
  const L: string[] = [];
  L.push('# Titans 2026-27 fixtures: questions for the union');
  L.push('');
  L.push(
    `Prepared ${r.generatedAt} from "${r.workbook.split('/').pop()}" (36 sheets, ${r.totals.fixtures} fixtures) before the fixtures are loaded onto the Smart Club platform. Nothing has been published.`,
  );
  L.push('');
  L.push('## 1. Start times we had to assume');
  L.push('');
  L.push(
    'Most sheets give no start time. Until you confirm, we have loaded **junior** fixtures (U9–U15 and the Women\'s Junior League) at **08:30** and **senior, women\'s and veterans** fixtures at **13:00**. T20 "AM" games are loaded at 09:00 and "PM" games at 13:30. Fixtures with a time on the sheet keep it.',
  );
  L.push('');
  L.push('| Competition | Fixtures with an assumed time | Assumed time | Total |');
  L.push('|---|---:|---|---:|');
  for (const p of r.provisionalTimes.filter((x) => x.provisional))
    L.push(`| ${p.name} | ${p.provisional} | ${p.time} | ${p.total} |`);
  L.push('');
  L.push('## 2. Junior morning games and senior afternoon games on the same ground');
  L.push('');
  L.push(
    `On **${r.sharedGroundDays.length}** ground-days a junior fixture (assumed 08:30) and a senior fixture (assumed 13:00) are at the same ground. We treat these as fine **only if the junior game is finished before 13:00**. Please confirm, or tell us which days need a different start time or ground.`,
  );
  L.push('');
  for (const d of r.sharedGroundDays) {
    L.push(`- **${d.ground}, ${longDate(d.date)}**`);
    for (const e of [...d.junior, ...d.senior]) L.push(`  - ${e}`);
  }
  L.push('');
  L.push(
    `Separately, on **${r.otherOverlapDays.length}** other ground-days a fixture with an assumed time shares the ground with a fixture at a different start time (a timed veterans or T20 game, or two senior competitions). The same question applies:`,
  );
  L.push('');
  for (const d of r.otherOverlapDays) {
    L.push(`- **${d.ground}, ${longDate(d.date)}**`);
    for (const e of d.entries) L.push(`  - ${e}`);
  }
  L.push('');
  L.push('## 3. Double-bookings we have held back');
  L.push('');
  if (!r.heldBack.length) L.push('None.');
  else {
    L.push(
      'These fixtures share a ground, date and start time with another fixture. We have **not loaded either fixture of each pair**. Please tell us which one moves (and where or when); we will add both once you reply.',
    );
    L.push('');
    L.push('| Competition | Date | Time | Fixture | Ground |');
    L.push('|---|---|---|---|---|');
    for (const h of r.heldBack)
      L.push(
        `| ${h.sheet} | ${longDate(h.date)} | ${h.time} | ${h.home} v ${h.away} | ${h.venue ?? 'TBC'} |`,
      );
  }
  L.push('');
  L.push('## 4. Ground names we were not sure about');
  L.push('');
  L.push(
    'We have kept each of these as a separate ground. Please tell us if any are the same field.',
  );
  L.push('');
  for (const a of r.ambiguousVenues) {
    const used =
      a.inWorkbook.map((u) => `${u.name} (${u.fixtures})`).join(', ') ||
      'not used in this workbook';
    L.push(`- ${a.question} — fixtures: ${used}`);
  }
  L.push('');
  L.push('## 5. Spellings we have treated as the same ground (please confirm)');
  L.push('');
  for (const a of r.venueAliasesApplied)
    L.push(`- "${a.raw}" read as **${a.canonical}** (${a.count} fixture(s))`);
  L.push('');
  L.push('## 6. Knockout fixtures');
  L.push('');
  L.push(
    'These are loaded later as placeholders that fill in as the groups finish. Please check how we have read each slot.',
  );
  L.push('');
  L.push('| Competition | Date | Time | Home slot | Away slot | Ground |');
  L.push('|---|---|---|---|---|---|');
  for (const k of r.knockouts)
    L.push(
      `| ${k.sheet}${k.tag ? ` (${k.tag})` : ''} | ${longDate(k.date)} | ${k.time} | ${k.rawHome} → \`${k.home.ref}\` | ${k.rawAway} → \`${k.away.ref}\` | ${k.rawVenue} |`,
    );
  L.push('');
  if (r.knockoutsSkipped?.length) {
    L.push(
      'These knockout fixtures are dated in the past and we do not know who played, so they are **not loaded**. Send us the teams (or the results) and we will load them:',
    );
    L.push('');
    for (const k of r.knockoutsSkipped)
      L.push(`- ${k.stage}, ${longDate(k.date)}: ${k.home} v ${k.away}`);
    L.push('');
  }
  L.push("## 7. Women's League Top 6 / Bottom 6 rounds");
  L.push('');
  L.push(
    'The sheet dates these rounds but names no fixtures yet, so nothing is loaded for them. Please send the fixtures once the split is known.',
  );
  L.push('');
  for (const s of r.splitRounds) L.push(`- ${longDate(s.date)}: ${s.rows} fixture row(s)`);
  L.push('');
  L.push('## 8. Fixtures with no ground yet (TBC)');
  L.push('');
  if (!r.tbcVenues.length) L.push('None.');
  else {
    L.push(
      "These are loaded without a ground. When a fixture is published without a ground, the platform places it at the home club's ground, so please send the ground for each.",
    );
    L.push('');
    for (const t of r.tbcVenues)
      L.push(`- ${t.seriesId}: ${longDate(t.date)} ${t.time} ${t.home} v ${t.away}`);
    const gate = r.clashes.gatePreview ?? [];
    if (gate.length) {
      L.push('');
      L.push(
        `At the home club's ground, **${gate.length}** of them would clash with another fixture at the same start time:`,
      );
      L.push('');
      for (const c of gate)
        L.push(
          `- ${c.ground}, ${longDate(c.date)} ${c.time ?? ''}: ${c.seriesName} ${c.home} v ${c.away} and ${c.with.seriesName ?? c.with.seriesId} ${c.with.home} v ${c.with.away}`,
        );
    }
  }
  L.push('');
  L.push(`## 9. Fixtures dated before ${longDate(r.today)}`);
  L.push('');
  L.push(
    `**${r.pastFixtures.length}** fixtures are dated in the past. They will be loaded as unreleased drafts; nothing is sent to clubs for them. Please send results if you want them recorded.`,
  );
  L.push('');
  for (const p of r.pastFixtures)
    L.push(
      `- ${p.seriesId}: ${longDate(p.date)} ${p.time} ${p.home} v ${p.away} @ ${p.venue ?? 'TBC'}`,
    );
  L.push('');
  if (r.womensPlacement?.length) {
    L.push("## 11. Women's League: which side plays?");
    L.push('');
    L.push(
      "Every WOMENS LEAGUE team is loaded into the Women's Premier League. Where a club has no matching premier side on record, please tell us which side plays (or whether it should move to the Promotion League).",
    );
    L.push('');
    L.push('| Club | Sheet side(s) | Premier on record | Promotion on record | Status |');
    L.push('|---|---|---|---|---|');
    for (const w of r.womensPlacement)
      L.push(
        `| ${w.clubName} | ${w.sheetSides.join(', ')} | ${w.premier} | ${w.promotion} | ${w.verdict === 'ok' ? 'ok' : 'needs a decision'} |`,
      );
    L.push('');
  }
  if (r.registryCleanup?.length) {
    L.push('## 12. Registry clean-up (for the admin, not the union)');
    L.push('');
    L.push(
      'These venue registry rows are used by no fixture and no club ground. They were left untouched — please review and delete or rename them in the console.',
    );
    L.push('');
    for (const v of r.registryCleanup)
      L.push(`- \`${v.id}\` "${v.name}" (home club: ${v.homeClubIds.join(', ') || 'none'})`);
    L.push('');
  }
  L.push('## 13. Match length (overs) we could not find');
  L.push('');
  L.push(
    "Your league entry form gives the overs for the 2nd–4th Leagues (45), the 5th League and the Women's League (35), and the T20s are 20 overs. For these competitions we found no number, so the platform shows none until you tell us:",
  );
  L.push('');
  for (const o of r.oversUnknown ?? []) L.push(`- **${o.label}**: ${o.why}. How many overs?`);
  L.push('');
  L.push('## 10. Dates we corrected');
  L.push('');
  if (!r.dateCorrections.length) L.push('None.');
  else for (const d of r.dateCorrections) L.push(`- ${d}`);
  L.push('');
  return L.join('\n');
}

// ───────────────────────── CLI ─────────────────────────

export interface Args {
  mode: 'import' | 'append-sides' | 'revert' | 'restore-clubs';
  /** --restore-clubs: the club backup / snapshot JSON to restore from. */
  restoreFrom: string;
  file: string;
  structure: string;
  parseOnly: boolean;
  confirm: boolean;
  only: string[];
  reportOut: string;
  today: string;
  noClubSync: boolean;
  /** --revert only: required to delete a RELEASED series. */
  includeReleased: boolean;
  /** Where JSON backups go (default: the working directory). */
  backupDir: string;
  /** Build (and with --confirm write) the T20 knockouts — tbd: sides, PR B stages only. */
  includeT20Ko: boolean;
  /** T20 KO fixtures dated before this need both teams known (default: --today). */
  koCutoff: string;
}

/** Every series id this importer may write (or --revert deletes). T20 knockouts are written
 * only with --include-t20-ko. */
export const WRITABLE_SERIES_IDS = [
  ...KNOWN_SERIES_IDS,
  ...VETERANS_KO_SERIES_IDS,
  ...T20_KO_SERIES_IDS,
];

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: 'import',
    restoreFrom: '',
    ...DEFAULT_PATHS,
    parseOnly: false,
    confirm: false,
    only: [],
    reportOut: '',
    today: new Date().toISOString().slice(0, 10),
    noClubSync: false,
    includeReleased: false,
    backupDir: process.cwd(),
    includeT20Ko: false,
    koCutoff: '',
  };
  const need = (i: number, flag: string) => {
    const v = argv[i];
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = need(++i, a);
    else if (a === '--structure') args.structure = need(++i, a);
    else if (a === '--report-out') args.reportOut = need(++i, a);
    else if (a === '--today') args.today = need(++i, a);
    else if (a === '--parse-only') args.parseOnly = true;
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--append-sides') args.mode = 'append-sides';
    else if (a === '--revert') args.mode = 'revert';
    else if (a === '--restore-clubs') {
      args.mode = 'restore-clubs';
      args.restoreFrom = need(++i, a);
    } else if (a === '--no-club-sync') args.noClubSync = true;
    else if (a === '--include-released') args.includeReleased = true;
    else if (a === '--backup-dir') args.backupDir = need(++i, a);
    else if (a === '--include-t20-ko') args.includeT20Ko = true;
    else if (a === '--ko-cutoff') args.koCutoff = need(++i, a);
    else if (a === '--only')
      args.only = need(++i, a)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else throw new Error(`unknown flag ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.today)) throw new Error('--today needs YYYY-MM-DD');
  if (args.parseOnly && (args.confirm || args.mode !== 'import'))
    throw new Error('--parse-only takes no --confirm, --append-sides, --revert or --restore-clubs');
  if (args.mode !== 'import' && args.reportOut) throw new Error('--report-out is an import flag');
  if (args.only.length && args.mode !== 'import' && args.mode !== 'append-sides')
    throw new Error('--only is an import / --append-sides flag');
  if (args.includeReleased && args.mode !== 'revert')
    throw new Error('--include-released is a --revert flag');
  if (args.includeT20Ko && args.mode !== 'import')
    throw new Error('--include-t20-ko is an import flag');
  if (args.koCutoff && !args.includeT20Ko)
    throw new Error('--ko-cutoff is an --include-t20-ko flag');
  if (args.koCutoff && !/^\d{4}-\d{2}-\d{2}$/.test(args.koCutoff))
    throw new Error('--ko-cutoff needs YYYY-MM-DD');
  args.koCutoff ||= args.today;
  for (const id of args.only) {
    if (!WRITABLE_SERIES_IDS.includes(id)) throw new Error(`--only: unknown series id "${id}"`);
    if (T20_KO_SERIES_IDS.includes(id) && !args.includeT20Ko)
      throw new Error(
        `--only: ${id} is a T20 knockout series — pass --include-t20-ko, and only on a stage already running PR B (tbd: sides; runbook)`,
      );
  }
  return args;
}

async function readWb(path: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb;
}

async function structureGrounds(path: string): Promise<Map<string, string> | null> {
  if (!existsSync(path)) return null;
  const summary = summarizeByClub(parseStructureWorkbook(await readWb(path)));
  const out = new Map<string, string>();
  for (const s of summary.values()) if (s.firstTeamVenue) out.set(s.club.id, s.firstTeamVenue);
  return out;
}

function printClashes(title: string, clashes: TaggedClash[]) {
  console.log(`\n── ${title}`);
  if (!clashes.length) {
    console.log('  ✓ no clashes');
    return;
  }
  console.log(`  ✗ ${clashes.length} clash(es) — ${tagCounts(clashes)}`);
  for (const c of clashes) console.log(`    ${clashLine(c)}`);
}

/**
 * T20 sides reuse the club's existing league ids (user decision): a men's T20 side is the side
 * of that exact sheet name in the senior men's league it plays in this workbook (premier first);
 * a women's T20 side is the club's women's premier side, else its promotion side.
 */
export function t20HostLeagues(
  sheets: ParsedTitansSheet[],
): (leagueKey: string, name: string) => string[] | null {
  const seen = new Map<string, Set<string>>();
  for (const s of sheets)
    for (const f of s.fixtures)
      for (const n of [f.home, f.away])
        seen.set(n, (seen.get(n) ?? new Set()).add(s.spec.leagueKey));
  return (leagueKey, name) => {
    const hosts = T20_HOST_LEAGUES[leagueKey];
    if (!hosts) return null;
    if (leagueKey !== 'mens-t20') return hosts;
    const inWorkbook = seen.get(canonicalTeamName(name)) ?? new Set();
    return hosts.filter((k) => inWorkbook.has(k));
  };
}

/** Series-level fields the importer owns that storedDraftDrift (fixture-level) does not compare. */
export function seriesFieldDrift(built: Series, stored: Series): string[] {
  const rec = (x: Series) => x as unknown as Record<string, unknown>;
  return (['maxOvers', 'seriesType', 'leagueKey', 'startDate', 'endDate'] as const)
    .filter((k) => (rec(stored)[k] ?? null) !== (rec(built)[k] ?? null))
    .map(
      (k) =>
        `${k} ${JSON.stringify(rec(stored)[k] ?? null)} → ${JSON.stringify(rec(built)[k] ?? null)}`,
    );
}

/**
 * The scan's alias map, and why it may not be the gate's yet. Once every titans alias is stored
 * on the tenant with the same value, the scan uses exactly what the API gate uses
 * (`venueAliasesFor(cfg)` — a tenant entry wins). A missing key or a conflicting value is fatal
 * for the run; until then the merged map is shown for information only. Pure.
 */
export function titansAliasState(cfg: Pick<TenantConfig, 'competitionDefaults'>): {
  missing: string[];
  conflicts: string[];
  aliases: Record<string, string>;
} {
  const storedAliases = cfg.competitionDefaults?.venueAliases ?? {};
  const missing = Object.keys(TITANS_VENUE_ALIASES).filter((k) => !(k in storedAliases));
  const conflicts = Object.entries(TITANS_VENUE_ALIASES)
    .filter(([k, v]) => k in storedAliases && storedAliases[k] !== v)
    .map(
      ([k, v]) => `"${k}" is mapped to "${storedAliases[k]}" on the tenant (titans map: "${v}")`,
    );
  const aliases =
    missing.length || conflicts.length
      ? { ...venueAliasesFor(cfg), ...TITANS_VENUE_ALIASES }
      : venueAliasesFor(cfg);
  return { missing, conflicts, aliases };
}

/**
 * The series whose sides and names a run must resolve: `--only` plus, for a knockout id, every
 * series of its sheet (a veterans playoff's division, a T20 bracket's groups — the knockout's
 * participants ARE theirs). null ⇒ every series. Writes are still exactly the `--only` ids.
 */
export function runScope(only: string[]): Set<string> | null {
  if (!only.length) return null;
  const scope = new Set(only);
  for (const sh of TITANS_FIXTURE_SHEETS)
    if (sh.koSeriesId && scope.has(sh.koSeriesId)) for (const x of sh.series) scope.add(x.seriesId);
  return scope;
}

/** The T20 knockout sides a run must resolve beyond the group fixtures: named teams on the
 * sheet's KO rows and union-confirmed teams (KO_RESOLVED), for the in-scope knockouts. */
export function koSideNeeds(
  sheets: ParsedTitansSheet[],
  scope: Set<string> | null,
  resolved: Record<string, Record<string, KoResolvedFixture>> = KO_RESOLVED,
): SideNeed[] {
  const out: SideNeed[] = [];
  for (const s of sheets) {
    const koId = s.spec.koSeriesId;
    if (!koId || !T20_KO_SERIES_IDS.includes(koId) || (scope && !scope.has(koId))) continue;
    const add = (name: string) =>
      out.push({ leagueKey: s.spec.leagueKey, name: canonicalTeamName(name) });
    for (const k of s.ko)
      for (const p of [k.home, k.away]) if (p.kind === 'team') add(p.ref.slice('team:'.length));
    for (const r of Object.values(resolved[koId] ?? {}))
      for (const n of [r.home, r.away]) if (n) add(n);
  }
  return out;
}

/** Every (league, sheet side) the in-scope series name — the input to the side plan. */
export function sideNeeds(
  sheets: ParsedTitansSheet[],
  scope: Set<string> | null = null,
): SideNeed[] {
  const seen = new Set<string>();
  const out: SideNeed[] = [];
  for (const s of sheets)
    for (const f of s.fixtures)
      for (const name of scope && !scope.has(f.seriesId) ? [] : [f.home, f.away]) {
        const k = sideKey(s.spec.leagueKey, name);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ leagueKey: s.spec.leagueKey, name });
      }
  return out;
}

/** Parse the workbook and print the per-sheet table; null (exit code set) on any problem. */
async function parseAndPrint(args: Args): Promise<{
  sheets: ParsedTitansSheet[];
  total: number;
  byes: number;
  koRows: number;
} | null> {
  const { sheets, errors } = parseTitansWorkbook(await readWb(args.file));
  console.log(`Titans fixtures workbook: ${args.file}`);
  console.log('\n── Per-sheet counts (parsed / expected)');
  let total = 0;
  let byes = 0;
  let koRows = 0;
  for (const s of sheets) {
    for (const spec of s.spec.series) {
      const n = s.fixtures.filter((f) => f.seriesId === spec.seriesId).length;
      total += n;
      console.log(
        `  ${n === spec.expected ? '✓' : '✗'} ${s.spec.sheet.padEnd(26)} → ${spec.seriesId.padEnd(40)} ${String(n).padStart(3)}/${spec.expected}`,
      );
    }
    byes += s.byes.length;
    koRows += s.ko.length;
    const extras = [
      s.byes.length ? `${s.byes.length} BYE` : '',
      s.ko.length ? `${s.ko.length} KO row(s)` : '',
      s.splitRounds.length ? `${s.splitRounds.length} Top6/Bottom6 row(s)` : '',
      s.banners.length ? `banners: ${s.banners.map((b) => `"${b.text}"`).join(', ')}` : '',
      s.timeRows.length
        ? `time row(s): ${s.timeRows.map((t) => `row ${t.row} ${t.time} → row ${t.appliedTo}`).join(', ')}`
        : '',
    ].filter(Boolean);
    if (extras.length) console.log(`      ${extras.join(' · ')}`);
    for (const d of s.dateCorrections) console.log(`      ⚠ date corrected: ${d}`);
    for (const i of s.sideInferences)
      console.log(`      ⚠ un-numbered "${i.from}" read as "${i.to}"`);
    for (const w of s.warnings) console.log(`      ⚠ ${w}`);
  }
  console.log(
    `  total: ${total} fixtures (expected ${EXPECTED_TOTAL_FIXTURES}), ${byes} BYE rows skipped, ${koRows} KO rows`,
  );
  console.log(`  un-numbered side inferences: ${sheets.flatMap((s) => s.sideInferences).length}`);
  if (errors.length) {
    console.error(`\n✗ Refusing to continue — ${errors.length} parse problem(s):`);
    for (const e of errors) console.error(`   ${e}`);
    process.exitCode = 1;
    return null;
  }
  return { sheets, total, byes, koRows };
}

function fixturesOnlyKeys(config: TenantConfig | null): Set<string> {
  return new Set([
    ...(config?.leagues ?? []).filter((l) => l.fixturesOnly).map((l) => l.key),
    ...TITANS_NEW_LEAGUES.filter((l) => l.fixturesOnly).map((l) => l.key),
  ]);
}

function printWomensTable(rows: WomensPlacementRow[]) {
  console.log(`\n── WOMENS LEAGUE placement (${rows.length} club(s)) → womens-premier-league`);
  for (const r of rows)
    console.log(
      `  ${r.verdict === 'ok' ? '✓' : '✗ DECISION'} ${r.clubName}: sheet ${r.sheetSides.join(', ')} | premier: ${r.premier} | promotion: ${r.promotion}`,
    );
}

function printSidePlan(plan: SidePlan, opts: { appendMode: boolean }) {
  const by = { roster: 0, bare: 0, seed: 0, append: 0 };
  for (const r of plan.resolve.values()) by[r.how]++;
  console.log(
    `\n── Side resolution: ${plan.resolve.size} side(s) — ${by.roster} roster, ${by.bare} bare club id` +
      (opts.appendMode ? `, ${by.seed} seeded (1→2), ${by.append} appended` : ''),
  );
  printWomensTable(plan.womens);
  if (opts.appendMode) {
    console.log(`\n── Club patches (${plan.patches.length})`);
    for (const p of plan.patches) {
      console.log(`  ${p.clubName} (${p.clubId}, v${p.version ?? '?'})`);
      for (const c of p.changes) console.log(`    ${c}`);
    }
  } else if (plan.needsAppend.length) {
    console.log(
      `\n── Sides the clubs do not have yet (${plan.needsAppend.length}) — run --append-sides`,
    );
    for (const n of plan.needsAppend) console.log(`    ${n}`);
  }
  for (const w of plan.warnings) console.log(`  ⚠ ${w}`);
}

/** `--append-sides`: plan (dry-run) or write the missing sides onto the live clubs. */
export async function runAppendSides(args: Args) {
  const parsed = await parseAndPrint(args);
  if (!parsed) return;
  const repo = await import('./repo.js');
  const config = await repo.getTenantConfig(TITANS_TENANT);
  if (!config) throw new Error(`no tenant config for "${TITANS_TENANT}"`);
  const clubs = await repo.listClubs(TITANS_TENANT);
  console.log(`\nTenant "${TITANS_TENANT}": ${clubs.length} club(s)`);
  const [storedSeries, seasonRuns] = await Promise.all([
    repo.listSeries(TITANS_TENANT),
    repo.listSeasonRuns(TITANS_TENANT),
  ]);
  const scope = runScope(args.only);
  if (scope) console.log(`── --only: sides of ${[...scope].join(', ')}`);
  const plan = planSides(sideNeeds(parsed.sheets, scope), clubs, {
    storedSeries,
    seasonRuns,
    hostLeagues: t20HostLeagues(parsed.sheets),
    allowAppend: true,
    fixturesOnlyKeys: fixturesOnlyKeys(config),
  });
  printSidePlan(plan, { appendMode: true });
  const fatal = [...plan.fatal];
  const configured = new Set((config.leagues ?? []).map((l) => l.key));
  const unconfigured = [
    ...new Set(plan.patches.flatMap((p) => p.leagues.filter((k) => !configured.has(k)))),
  ];
  if (unconfigured.length)
    fatal.push(
      `league key(s) not on the tenant: ${unconfigured.join(', ')} — run bootstrap-titans-fixture-prereqs --confirm first`,
    );
  // Every patch is validated up front, dry run included, with the same guard the rep PATCH
  // uses: one invalid club patch refuses the whole run (no partial append).
  const { validateClubPatch, resolveRequiredDocs, resolveDistricts } =
    await import('./catalogue.js');
  const { resolveVertical } = await import('./vertical.js');
  const requiredDocs = resolveRequiredDocs(config);
  const patchFor = (p: (typeof plan.patches)[number]): Partial<Club> => ({
    version: p.version,
    leagues: p.leagues,
    leagueTeams: p.leagueTeams,
    teamRosters: p.teamRosters,
    teams: p.teams,
    women: p.women,
    juniors: p.juniors,
  });
  const invalidFor = (p: (typeof plan.patches)[number], club: Club) =>
    validateClubPatch(
      patchFor(p),
      new Set([...configured, ...(club.leagues ?? [])]),
      new Set([
        ...requiredDocs.map((d) => d.key),
        ...Object.keys(club.docs ?? {}),
        ...Object.keys(club.docMeta ?? {}),
      ]),
      new Set([...resolveDistricts(config), ...(club.district ? [club.district] : [])]),
      requiredDocs,
      club.docMeta,
      resolveVertical(config).sport,
    );
  for (const p of plan.patches) {
    const invalid = invalidFor(p, clubs.find((c) => c.id === p.clubId)!);
    if (invalid) fatal.push(`${p.clubId}: club patch fails validateClubPatch — ${invalid}`);
  }
  if (fatal.length) {
    console.error(
      `\n✗ Refusing to ${args.confirm ? 'write' : 'pass the dry run'} — ${fatal.length} blocker(s):`,
    );
    for (const f of fatal) console.error(`   ${f}`);
    process.exitCode = 1;
    return;
  }
  if (!plan.patches.length) {
    console.log('\nNothing to append — every sheet side already exists.');
    return;
  }
  if (!args.confirm) {
    console.log(
      `\n[dry-run] ${plan.patches.length} club(s) would change. Re-run with --confirm to write.`,
    );
    return;
  }
  const backup = join(
    args.backupDir,
    `titans-append-sides-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  await writeFile(
    backup,
    JSON.stringify(
      clubs.filter((c) => plan.patches.some((p) => p.clubId === c.id)),
      null,
      2,
    ),
  );
  console.log(`\nBackup written: ${backup}`);
  let raced = 0;
  let done = 0;
  try {
    for (const p of plan.patches) {
      const fresh = await repo.getClub(TITANS_TENANT, p.clubId);
      if (!fresh || fresh.version !== p.version) {
        console.error(`✗ ${p.clubId} changed since the read — NOT written (re-run)`);
        raced++;
        continue;
      }
      const patch = patchFor(p);
      const invalid = invalidFor(p, fresh);
      if (invalid) {
        console.error(`✗ ${p.clubId}: ${invalid} — NOT written`);
        raced++;
        continue;
      }
      try {
        await repo.updateClub(
          TITANS_TENANT,
          p.clubId,
          patch,
          'import-titans-fixtures --append-sides',
          new Date().toISOString(),
        );
        console.log(`wrote ${p.clubId}`);
        done++;
      } catch (err) {
        if ((err as { name?: string }).name !== 'VersionConflictError') throw err;
        console.error(`✗ ${p.clubId} changed mid-write — NOT written (re-run)`);
        raced++;
      }
    }
  } catch (err) {
    console.error(
      `\n✗ ABORTED after ${done} of ${plan.patches.length} club(s) — RE-RUN REQUIRED (the dry run will list only what is still missing; --restore-clubs ${backup} undoes the written ones)`,
    );
    throw err;
  }
  if (raced) process.exitCode = 1;
  console.log(`Done. ${plan.patches.length - raced} club(s) written. Backup: ${backup}`);
}

/** DELETE /series parity: the series, its umpire appointments and its medicoach-sync state. */
async function deleteSeriesFully(repo: RepoModule, id: string) {
  await repo.deleteSeries(TITANS_TENANT, id);
  await repo.deleteFixtureOfficialsForSeries(TITANS_TENANT, id);
  await repo.deleteSeriesSyncState(TITANS_TENANT, id);
}

async function backupTitansSeries(series: Series[], dir: string, clubs?: Club[]): Promise<string> {
  if (clubs) {
    const cpath = join(
      dir,
      `titans-clubs-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    await writeFile(cpath, JSON.stringify(clubs, null, 2));
    console.log(`Club backup written: ${cpath} (${clubs.length} clubs)`);
  }
  const path = join(
    dir,
    `titans-fixtures-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  await writeFile(path, JSON.stringify(series, null, 2));
  console.log(`Backup written: ${path} (${series.length} series)`);
  return path;
}

/** The structure fields --restore-clubs puts back (compliance docs, contacts and the rest of
 * the club record are never touched). */
export const RESTORE_FIELDS = [
  'leagues',
  'leagueTeams',
  'teamRosters',
  'teams',
  'women',
  'juniors',
] as const;

/** Per club, the RESTORE_FIELDS that differ between a backup and the live record (only fields
 * the backup actually carries). Pure. */
export function planClubRestore(
  backup: Array<Partial<Club> & { id: string }>,
  current: Club[],
): Array<{
  clubId: string;
  name: string;
  fields: string[];
  patch: Partial<Club>;
  version: number | undefined;
}> {
  const byId = new Map(current.map((c) => [c.id, c]));
  const out: Array<{
    clubId: string;
    name: string;
    fields: string[];
    patch: Partial<Club>;
    version: number | undefined;
  }> = [];
  for (const snap of backup) {
    const cur = byId.get(snap.id);
    if (!cur) continue;
    const rec = (x: object) => x as Record<string, unknown>;
    const fields = RESTORE_FIELDS.filter(
      (k) =>
        k in snap && JSON.stringify(rec(cur)[k] ?? null) !== JSON.stringify(rec(snap)[k] ?? null),
    );
    if (!fields.length) continue;
    out.push({
      clubId: cur.id,
      name: cur.name,
      fields: [...fields],
      patch: Object.fromEntries(fields.map((k) => [k, rec(snap)[k]])) as Partial<Club>,
      version: cur.version,
    });
  }
  return out.sort((a, b) => a.clubId.localeCompare(b.clubId));
}

/** `--restore-clubs <backup.json>`: put a club backup's structure fields back, version-pinned
 * and validated up front (one invalid patch refuses the run). */
export async function runRestoreClubs(args: Args) {
  const repo = await import('./repo.js');
  const { readFile } = await import('node:fs/promises');
  const backup = JSON.parse(await readFile(args.restoreFrom, 'utf8')) as Array<
    Partial<Club> & { id: string }
  >;
  if (!Array.isArray(backup))
    throw new Error(`${args.restoreFrom}: expected a JSON array of clubs`);
  const config = await repo.getTenantConfig(TITANS_TENANT);
  if (!config) throw new Error(`no tenant config for "${TITANS_TENANT}"`);
  const clubs = await repo.listClubs(TITANS_TENANT);
  const plan = planClubRestore(backup, clubs);
  console.log(
    `Restore from ${args.restoreFrom}: ${backup.length} club(s) in the backup, ${plan.length} differ`,
  );
  const { validateClubPatch, resolveRequiredDocs, resolveDistricts } =
    await import('./catalogue.js');
  const { resolveVertical } = await import('./vertical.js');
  const requiredDocs = resolveRequiredDocs(config);
  const configured = new Set((config.leagues ?? []).map((l) => l.key));
  const fatal: string[] = [];
  for (const r of plan) {
    const cur = clubs.find((c) => c.id === r.clubId)!;
    for (const f of r.fields) {
      const rec = (x: object) => x as Record<string, unknown>;
      console.log(
        `  ${r.clubId} ${f}: ${JSON.stringify(rec(cur)[f] ?? null)} → ${JSON.stringify(rec(r.patch)[f] ?? null)}`,
      );
    }
    const invalid = validateClubPatch(
      { ...r.patch, version: r.version } as Partial<Club>,
      new Set([...configured, ...(cur.leagues ?? []), ...((r.patch.leagues as string[]) ?? [])]),
      new Set([
        ...requiredDocs.map((d) => d.key),
        ...Object.keys(cur.docs ?? {}),
        ...Object.keys(cur.docMeta ?? {}),
      ]),
      new Set([...resolveDistricts(config), ...(cur.district ? [cur.district] : [])]),
      requiredDocs,
      cur.docMeta,
      resolveVertical(config).sport,
    );
    if (invalid) fatal.push(`${r.clubId}: restore patch fails validateClubPatch — ${invalid}`);
  }
  if (fatal.length) {
    console.error(`\n✗ Refusing to restore — ${fatal.length} blocker(s):`);
    for (const f of fatal) console.error(`   ${f}`);
    process.exitCode = 1;
    return;
  }
  if (!plan.length) {
    console.log('Nothing to restore — every club already matches the backup.');
    return;
  }
  if (!args.confirm) {
    console.log(`\n[dry-run] ${plan.length} club(s) would be restored. Re-run with --confirm.`);
    return;
  }
  let done = 0;
  try {
    for (const r of plan) {
      try {
        await repo.updateClub(
          TITANS_TENANT,
          r.clubId,
          { ...r.patch, version: r.version },
          'import-titans-fixtures --restore-clubs',
          new Date().toISOString(),
        );
        done++;
        console.log(`restored ${r.clubId} (${r.fields.join(', ')})`);
      } catch (err) {
        if ((err as { name?: string }).name !== 'VersionConflictError') throw err;
        console.error(`✗ ${r.clubId} changed since the read — NOT restored (re-run)`);
        process.exitCode = 1;
      }
    }
  } catch (err) {
    console.error(`\n✗ ABORTED after ${done} of ${plan.length} club(s) — RE-RUN REQUIRED`);
    throw err;
  }
  console.log(`Done. ${done} club(s) restored.`);
}

export async function runRevert(args: Args) {
  const repo = await import('./repo.js');
  const all = await repo.listSeries(TITANS_TENANT);
  const mine = all.filter((s) => WRITABLE_SERIES_IDS.includes(String(s.id)));
  const extra = all.filter(
    (s) => String(s.id).startsWith(TITANS_SERIES_PREFIX) && !mine.includes(s),
  ).length;
  if (extra)
    console.log(`(${extra} other ${TITANS_SERIES_PREFIX}* series not in this manifest kept)`);
  if (!mine.length) {
    console.log('Nothing to revert.');
    return;
  }
  const released = mine.filter((s) => s.released);
  if (released.length && !args.includeReleased) {
    const list = released.map((s) => `   ${s.id} (${s.name})`).join('\n');
    const msg = `${released.length} RELEASED series in scope (deleting pulls them from club portals):\n${list}`;
    if (args.confirm) {
      console.error(
        `\n✗ Refusing to revert — ${msg}\nRecall them first, or pass --include-released.`,
      );
      process.exitCode = 1;
      return;
    }
    console.warn(`\n⚠ ${msg}\n--confirm will refuse unless --include-released is passed.`);
  }
  if (args.confirm) await backupTitansSeries(mine, args.backupDir);
  for (const s of mine) {
    const status = s.released ? 'RELEASED' : s.approved ? 'approved' : 'draft';
    console.log(
      `${args.confirm ? 'delete' : '[dry-run] would delete'}  ${s.id}  (${s.name} · ${status})`,
    );
    if (args.confirm) await deleteSeriesFully(repo, String(s.id));
  }
  console.log(
    args.confirm
      ? `Reverted ${mine.length} series. NOT reverted: bootstrap leagues/aliases/venues, --append-sides rosters, club-sync league keys/rosters and cup league keys (see the runbook; --restore-clubs puts club structure back).`
      : `Re-run with --confirm to delete these ${mine.length} series.`,
  );
}

export async function runImport(args: Args) {
  const parsed = await parseAndPrint(args);
  if (!parsed) return;
  const { sheets, total, byes, koRows } = parsed;

  // ── Context: the live tenant, or the would-be registry + CLUB_MAP (parse-only) ──
  let repo: RepoModule | null = null;
  let config: TenantConfig | null = null;
  let clubs: Club[];
  let venues: Venue[];
  let stored: Series[] = [];
  let aliases = TITANS_GATE_ALIASES;
  let labelOf = leagueLabel;
  let sidePlan: SidePlan | null = null;
  let wouldBeVenues = false;
  let missingAliasKeys: string[] = [];
  let aliasConflicts: string[] = [];
  let seasonRuns: Awaited<ReturnType<RepoModule['listSeasonRuns']>> = [];
  const scope = runScope(args.only);
  let grounds: Map<string, string> | null = null;
  if (args.parseOnly) {
    grounds = await structureGrounds(args.structure);
    clubs = clubsFromMap(grounds ?? new Map());
    venues = wouldBeRegistry(sheets, clubs);
    console.log(
      `\nWould-be venue registry: ${venues.length} ground(s), one pitch each` +
        (grounds
          ? `; club grounds from ${args.structure} (${grounds.size} club(s))`
          : `; ⚠ structure workbook not found (${args.structure}) — TBC fixtures cannot be placed at a club ground`),
    );
  } else {
    repo = await import('./repo.js');
    config = await repo.getTenantConfig(TITANS_TENANT);
    if (!config) throw new Error(`no tenant config for "${TITANS_TENANT}"`);
    [clubs, venues, stored, seasonRuns] = await Promise.all([
      repo.listClubs(TITANS_TENANT),
      repo.listVenues(TITANS_TENANT),
      repo.listSeries(TITANS_TENANT),
      repo.listSeasonRuns(TITANS_TENANT),
    ]);
    const cfg = config;
    labelOf = (k) => (cfg.leagues ?? []).find((l) => l.key === k)?.label ?? leagueLabel(k);
    // The scan must see what the API gate sees: venueAliasesFor(cfg). Until every titans alias
    // is stored with the same value (missing ⇒ fatal, conflicting ⇒ fatal) the dry run shows
    // the merged map for information only.
    ({ missing: missingAliasKeys, conflicts: aliasConflicts, aliases } = titansAliasState(cfg));
    const mine = stored.filter((s) => String(s.id).startsWith(TITANS_SERIES_PREFIX));
    console.log(
      `\nTenant "${TITANS_TENANT}": ${clubs.length} club(s), ${venues.length} registry venue(s), ${stored.length} series (${mine.length} ${TITANS_SERIES_PREFIX}*)`,
    );
    console.log(
      `medicoachSync feature: ${hasFeature(cfg, 'medicoachSync') ? 'ON — pause the sync cron before --confirm (R14)' : 'off'}`,
    );
    if (!venues.length) {
      venues = wouldBeRegistry(sheets, clubs);
      wouldBeVenues = true;
      console.warn(
        `  ⚠ venue registry is EMPTY — scanning against the would-be registry (${venues.length} grounds); run bootstrap-titans-fixture-prereqs --confirm before --confirm`,
      );
    }
    const needs = sideNeeds(sheets, scope);
    if (args.includeT20Ko)
      for (const n of koSideNeeds(sheets, scope))
        if (!needs.some((x) => sideKey(x.leagueKey, x.name) === sideKey(n.leagueKey, n.name)))
          needs.push(n);
    sidePlan = planSides(needs, clubs, {
      storedSeries: stored,
      seasonRuns,
      hostLeagues: t20HostLeagues(sheets),
      allowAppend: false,
      fixturesOnlyKeys: fixturesOnlyKeys(cfg),
    });
    printSidePlan(sidePlan, { appendMode: false });
  }

  // ── Build ──
  const plan = sidePlan;
  const storedById = new Map(stored.map((s) => [String(s.id), s]));
  // Build EVERY series (a playoff needs its division's participants); only the writes and the
  // side/name blockers are restricted to --only.
  const outcome = buildTitansSeries(
    sheets,
    venues,
    HELD_BACK,
    plan
      ? { sideOf: (k, n) => plan.resolve.get(sideKey(k, n)), labelOf, aliases, stored: storedById }
      : { stored: storedById },
  );
  const writes = (id: string) => !args.only.length || args.only.includes(id);
  const inScope = (id: string) => !scope || scope.has(id);
  const writeBuilt = outcome.built.filter((b) => writes(String(b.series.id)));
  if (args.only.length) console.log(`\n── --only: writing ${args.only.join(', ')}`);
  const vets = buildVeteransKnockouts(sheets, outcome.built, labelOf);
  const t20 = args.includeT20Ko
    ? buildT20Knockouts(sheets, outcome.built, {
        cutoff: args.koCutoff,
        labelOf,
        stored: storedById,
        ...(plan ? { sideOf: (k: string, n: string) => plan.resolve.get(sideKey(k, n)) } : {}),
      })
    : null;
  const koSeries = [...vets.series, ...(t20?.series ?? [])].filter((s) => writes(String(s.id)));
  console.log(`\n── Name resolution (${outcome.resolutions.size} league side(s))`);
  const byClub = new Map<string, Set<string>>();
  for (const r of outcome.resolutions.values())
    byClub.set(
      r.clubName,
      (byClub.get(r.clubName) ?? new Set()).add(`${r.name}${plan ? ` [${r.teamId}]` : ''}`),
    );
  for (const [club, names] of [...byClub].sort((a, b) => a[0].localeCompare(b[0])))
    console.log(`  ${club}: ${[...names].sort().join(', ')}`);
  const scopedUnresolved = [...outcome.unresolvedBySeries]
    .filter(([sid]) => inScope(sid))
    .flatMap(([, names]) => names);
  console.log(
    scopedUnresolved.length
      ? `  ✗ ${scopedUnresolved.length} unresolved name(s):\n    ${scopedUnresolved.join('\n    ')}`
      : `  ✓ unresolved names: 0${scope ? ' (in the --only scope; other series are not resolved)' : ''}`,
  );

  // ── Venues ──
  const applied = aliasesApplied(sheets);
  console.log(`\n── Venue spellings merged (misspellings only): ${applied.length}`);
  for (const a of applied) console.log(`    "${a.raw}" → ${a.canonical} ×${a.count}`);
  const defaultHits = defaultAliasHits(sheets);
  if (defaultHits.length)
    console.log(`  ⚠ dolphins default aliases would rewrite: ${defaultHits.join(', ')}`);
  if (outcome.registryMisses.size) {
    console.log(`  Registry misses (${outcome.registryMisses.size}) — written as venueOverride:`);
    for (const [n, c] of outcome.registryMisses) console.log(`    "${n}" ×${c}`);
  }
  const venueUse = new Map<string, number>();
  for (const s of sheets)
    for (const f of s.fixtures)
      if (f.venue) venueUse.set(f.venue, (venueUse.get(f.venue) ?? 0) + 1);
  const ambiguous = AMBIGUOUS_VENUES.map((a) => ({
    ...a,
    inWorkbook: a.names
      .filter((n) => venueUse.has(canonicalVenueName(n)))
      .map((n) => ({
        name: canonicalVenueName(n),
        fixtures: venueUse.get(canonicalVenueName(n))!,
      })),
  }));
  console.log(`\n── Ambiguous venues (kept separate, listed for the union): ${ambiguous.length}`);
  for (const a of ambiguous)
    console.log(
      `    ${a.names.join(' / ')} — in workbook: ${a.inWorkbook.map((u) => `${u.name} ×${u.fixtures}`).join(', ') || 'none'}`,
    );
  if (outcome.tbc.length) {
    console.log(
      `\n── TBC venues (${outcome.tbc.length}) — excluded from the strict scan, placed at the club ground in the gate preview`,
    );
    for (const t of outcome.tbc)
      console.log(`    ${t.seriesId} ${t.fixtureId}: ${t.date} ${t.time} ${t.home} v ${t.away}`);
  }

  // ── Held back ──
  console.log(`\n── Held back (${outcome.held.length}) — parsed, never written`);
  for (const h of outcome.held)
    console.log(
      `    ${h.seriesId} ${h.fixtureId}: ${h.raw.date} ${h.raw.time} (${h.raw.timeSource}) ${h.raw.home} v ${h.raw.away} @ ${h.raw.venue}`,
    );
  for (const p of outcome.heldProblems) console.log(`    ✗ ${p}`);

  // ── Knockouts ──
  const ko = sheets.flatMap((s) => s.ko);
  console.log(`\n── Knockout rows (${ko.length})`);
  const koSkipped = t20?.skipped ?? [];
  const isSkipped = (k: KoRow) =>
    koSkipped.some((x) => x.koSeriesId === k.koSeriesId && x.fixtureId === k.fixtureId);
  for (const k of ko) {
    const tag = !T20_KO_SERIES_IDS.includes(k.koSeriesId)
      ? '[written]        '
      : !t20
        ? '[--include-t20-ko]'
        : isSkipped(k)
          ? '[SKIPPED: past] '
          : '[written]        ';
    console.log(`    ${tag} ${koLine(k)}`);
  }
  for (const e of vets.errors) console.log(`    ✗ ${e}`);
  for (const e of t20?.errors ?? []) console.log(`    ✗ ${e.message}`);
  for (const r of t20?.resolvedSides ?? []) console.log(`    union-confirmed: ${r}`);
  console.log(
    `  knockout series built: ${koSeries.map((s) => s.id).join(', ') || 'none'}` +
      (t20
        ? `; T20 knockout cutoff ${args.koCutoff}: ${koSkipped.length} past fixture(s) skipped (teams unknown)`
        : `; T20 knockouts (${T20_KO_SERIES_IDS.join(', ')}) are NOT built — pass --include-t20-ko, only on a stage running PR B`),
  );
  for (const x of koSkipped)
    console.log(`    skipped ${x.koSeriesId} ${x.fixtureId} ${x.stage} ${x.date}: ${x.reason}`);
  const splitRounds = sheets.flatMap((s) =>
    [...new Set(s.splitRounds.map((x) => x.date))].map((date) => ({
      sheet: s.spec.sheet,
      date,
      rows: s.splitRounds.filter((x) => x.date === date).length,
    })),
  );
  console.log(
    `\n── Skipped split rounds (Women's League Top 6 / Bottom 6): ${splitRounds.length} date(s)`,
  );
  for (const s of splitRounds) console.log(`    ${s.sheet} ${s.date}: ${s.rows} row(s)`);

  // ── Stable ids: league series were reconciled in the build; playoffs here ──
  const idProblems: string[] = [];
  for (const b of writeBuilt)
    for (const x of outcome.removedBySeries.get(String(b.series.id)) ?? [])
      idProblems.push(`${b.series.id}: stored fixture ${x} is not in the workbook`);
  // T20 knockouts were reconciled (and console sides carried) in their build.
  for (const s of koSeries.filter((x) => !T20_KO_SERIES_IDS.includes(String(x.id)))) {
    const r = stabiliseIds(s.fixtures as TitansFixture[], storedById.get(String(s.id)));
    for (const x of r.removed)
      idProblems.push(`${s.id}: stored fixture ${x} is not in the workbook`);
  }
  for (const n of t20?.carried ?? []) console.log(`  ${n}`);
  const writeSet: Series[] = [...writeBuilt.map((b) => b.series), ...koSeries];
  const writeIds = new Set(writeSet.map((s) => String(s.id)));

  // ── Clash scan ──
  const existingOther = stored.filter((s) => !writeIds.has(String(s.id)));
  const scanOpts = { existingOther, aliases };
  const before = scanTitansClashes(
    [...withHeldBack(writeBuilt), ...koSeries],
    clubs,
    venues,
    scanOpts,
  );
  const after = scanTitansClashes(writeSet, clubs, venues, scanOpts);
  const canPreview = !args.parseOnly || grounds;
  const gatePreview = canPreview
    ? scanTitansClashes(writeSet, clubs, venues, { ...scanOpts, includeTbc: true })
    : null;
  const scanScope = args.parseOnly
    ? 'would-be registry, 1 pitch each'
    : `live tenant: ${existingOther.length} other series${wouldBeVenues ? ', WOULD-BE registry' : ''}`;
  printClashes(`CLASH SCAN before HELD_BACK (${scanScope}, TBC excluded)`, before);
  printClashes('CLASH SCAN after HELD_BACK (residual — the gate)', after);
  if (gatePreview)
    printClashes(
      'Release-gate preview after HELD_BACK — TBC fixtures at the home club ground (NON-blocking for drafts; give them a venue before release)',
      gatePreview,
    );

  // ── Shared ground-days / provisional times / past fixtures ──
  const shared = sharedGroundDays(outcome.built);
  console.log(
    `\n── Shared ground-days, junior 08:30 + senior 13:00 (both provisional): ${shared.length} — union report`,
  );
  const otherOverlap = otherProvisionalOverlapDays(outcome.built);
  console.log(
    `── Other ground-days where a provisional time shares the ground with a different start time: ${otherOverlap.length}`,
  );
  const provisionalTimes = outcome.built.map((b) => ({
    seriesId: String(b.series.id),
    name: b.series.name,
    provisional: b.fixtures.filter((f) => f.timeSource === 'provisional').length,
    time: b.junior ? '08:30' : '13:00',
    total: b.fixtures.length,
  }));
  const sourceTotals = new Map<string, number>();
  for (const b of outcome.built)
    for (const f of b.fixtures)
      sourceTotals.set(f.timeSource, (sourceTotals.get(f.timeSource) ?? 0) + 1);
  console.log(
    `── Time sources (written fixtures): ${[...sourceTotals].map(([s, n]) => `${s} ${n}`).join(', ')}`,
  );
  const pastFixtures = outcome.built.flatMap((b) => {
    const names = new Map((b.series.participants ?? []).map((p) => [p.teamId, p.name]));
    return b.fixtures
      .filter((f) => f.date < args.today)
      .map((f) => ({
        seriesId: String(b.series.id),
        fixtureId: f.id,
        date: f.date,
        time: f.time ?? '',
        home: names.get(f.home) ?? f.home,
        away: names.get(f.away) ?? f.away,
        venue: f.venueName ?? null,
      }));
  });
  console.log(`── Fixtures dated before ${args.today}: ${pastFixtures.length}`);

  // ── Women's League ──
  const womens = [...outcome.resolutions.values()]
    .filter((r) => r.leagueKey === 'womens-premier-league')
    .map((r) => ({ name: r.name, clubId: r.clubId, clubName: r.clubName }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!plan) {
    console.log(`\n── WOMENS LEAGUE teams (${womens.length}) → womens-premier-league`);
    for (const w of womens) console.log(`    ${w.name} → ${w.clubName}`);
  }
  const todo = plan
    ? []
    : [
        "Women's placement: check each WOMENS LEAGUE club's live premier/promotion women's roster before any write (risk R6) — run without --parse-only under sst shell.",
      ];
  for (const t of todo) console.log(`  TODO (later step): ${t}`);

  console.log(
    `\n── Overs: set for ${Object.keys(TITANS_LEAGUE_OVERS).join(', ')} (sourced); UNKNOWN (left unset, union report): ${TITANS_OVERS_UNKNOWN.map((o) => o.leagueKey).join(', ')}`,
  );

  // ── Series list ──
  console.log(`\n── Series (${writeSet.length}) as DRAFTS`);
  for (const s of writeSet) {
    const st = storedById.get(String(s.id));
    console.log(
      `    ${String(s.id).padEnd(40)} ${String((s.fixtures as unknown[]).length).padStart(3)} fixtures  "${s.name}"${st ? ` (replaces stored v${st.version}${st.released ? ' RELEASED' : st.approved ? ' approved' : ' draft'})` : ''}`,
    );
  }

  // Registry rows nothing in the workbook (or a club ground) uses — a cleanup item, never merged.
  const usedKeys = new Set<string>();
  for (const s of sheets)
    for (const f of s.fixtures) if (f.venue) usedKeys.add(groundKey(f.venue, aliases));
  for (const c of clubs) if (c.ground?.venue) usedKeys.add(groundKey(c.ground.venue, aliases));
  const registryCleanup = args.parseOnly
    ? []
    : venues
        .filter((v) => !usedKeys.has(groundKey(v.name, aliases)))
        .map((v) => ({ id: v.id, name: v.name, homeClubIds: v.homeClubIds ?? [] }));
  if (registryCleanup.length) {
    console.log(
      `\n── Registry rows no fixture or club ground uses (cleanup for the admin; left untouched):`,
    );
    for (const v of registryCleanup)
      console.log(`    ${v.id} "${v.name}" (home of ${v.homeClubIds.join(', ') || '—'})`);
  }

  const dateCorrections = sheets.flatMap((s) => s.dateCorrections);
  if (args.reportOut) {
    const report: UnionReport = {
      generatedAt: new Date().toISOString().slice(0, 10),
      today: args.today,
      workbook: args.file,
      totals: {
        fixtures: total,
        expected: EXPECTED_TOTAL_FIXTURES,
        written: outcome.built.reduce((n, b) => n + b.fixtures.length, 0),
        heldBack: outcome.held.length,
        byes,
        koRows,
      },
      sheets: sheets.map((s) => {
        const ts: Record<string, number> = {};
        for (const f of s.fixtures) ts[f.timeSource] = (ts[f.timeSource] ?? 0) + 1;
        return {
          sheet: s.spec.sheet,
          series: s.spec.series.map((x) => ({
            seriesId: x.seriesId,
            name: seriesNameFor(x, labelOf),
            parsed: s.fixtures.filter((f) => f.seriesId === x.seriesId).length,
            expected: x.expected,
          })),
          byes: s.byes.length,
          koRows: s.ko.length,
          banners: s.banners.map((b) => b.text),
          splitRounds: s.splitRounds.length,
          timeSources: ts,
        };
      }),
      provisionalTimes,
      sharedGroundDays: shared,
      otherOverlapDays: otherOverlap,
      heldBack: outcome.held.map((h) => ({
        sheet: h.entry.sheet,
        seriesId: h.seriesId,
        fixtureId: h.fixtureId,
        date: h.raw.date,
        time: h.raw.time,
        home: h.raw.home,
        away: h.raw.away,
        venue: h.raw.venue,
        reason: h.entry.reason,
      })),
      ambiguousVenues: ambiguous,
      venueAliasesApplied: applied,
      venueSpellings: TITANS_VENUE_SPELLINGS,
      knockouts: ko,
      ...(t20 ? { knockoutsSkipped: koSkipped } : {}),
      splitRounds,
      tbcVenues: outcome.tbc,
      pastFixtures,
      dateCorrections,
      clashes: { beforeHeldBack: before, afterHeldBack: after, gatePreview },
      womensLeagueTeams: womens,
      oversUnknown: TITANS_OVERS_UNKNOWN.map((o) => ({ ...o, label: labelOf(o.leagueKey) })),
      ...(plan ? { womensPlacement: plan.womens, registryCleanup } : {}),
      todo,
    };
    const base = args.reportOut.replace(/\.(md|json)$/i, '');
    await writeFile(`${base}.json`, JSON.stringify(report, null, 2));
    await writeFile(`${base}.md`, renderUnionMarkdown(report));
    console.log(`\nUnion report written: ${base}.md + ${base}.json`);
  }

  // ── Gate ──
  const fatal: string[] = [];
  for (const [sid, names] of outcome.unresolvedBySeries)
    if (inScope(sid)) for (const n of names) fatal.push(`unresolved side ${n}`);
  fatal.push(...outcome.heldProblems);
  fatal.push(...vets.errors);
  fatal.push(...koBlockers(t20?.errors ?? [], writes));
  fatal.push(...idProblems);
  if (after.length)
    fatal.push(
      `${after.length} residual venue clash(es) after HELD_BACK — no --allow-clashes exists`,
    );
  if (plan) {
    fatal.push(...plan.fatal);
    if (plan.needsAppend.length)
      fatal.push(
        `${plan.needsAppend.length} league side group(s) need --append-sides --confirm first`,
      );
    const configured = new Set((config!.leagues ?? []).map((l) => l.key));
    const missing = TITANS_LEAGUE_KEYS.filter((k) => !configured.has(k));
    if (missing.length)
      fatal.push(
        `league key(s) not on the tenant: ${missing.join(', ')} — run bootstrap-titans-fixture-prereqs --confirm`,
      );
    if (wouldBeVenues)
      fatal.push('venue registry is empty — run bootstrap-titans-fixture-prereqs --confirm');
    if (missingAliasKeys.length)
      fatal.push(
        `${missingAliasKeys.length} titans venue alias(es) not in the tenant config — run bootstrap-titans-fixture-prereqs --confirm`,
      );
    for (const c of aliasConflicts)
      fatal.push(`venue alias conflict: ${c} — resolve it in the console`);
    const misses = new Set(
      writeSet.flatMap((s) =>
        (s.fixtures as WrittenFixture[])
          .filter((f) => f.venueOverride)
          .map((f) => f.venueOverride!),
      ),
    );
    if (misses.size)
      fatal.push(
        `${misses.size} venue(s) not in the registry (${[...misses].slice(0, 5).join(', ')}${misses.size > 5 ? ', …' : ''}) — run bootstrap-titans-fixture-prereqs --confirm`,
      );
    // T20 sides reuse other leagues' ids: the cup keys MUST be fixtures-only, or the club sync
    // would write a roster of borrowed ids under them.
    for (const k of Object.keys(T20_HOST_LEAGUES)) {
      const l = (config!.leagues ?? []).find((x) => x.key === k);
      if (l && l.fixturesOnly !== true)
        fatal.push(
          `league "${k}" exists but is not fixtures-only — the club sync would write a roster of borrowed ids under it`,
        );
    }
    for (const s of writeSet) {
      const st = storedById.get(String(s.id));
      if (st?.released)
        fatal.push(
          `${s.id} is already RELEASED — refusing to overwrite (recall it first, or leave it out with --only)`,
        );
      else if (st?.approved)
        console.warn(`⚠ ${s.id} is an APPROVED draft — the import writes it back as unapproved`);
    }
  }
  if (fatal.length) {
    console.error(
      `\n✗ ${args.parseOnly ? 'Gate FAILED' : `Refusing to ${args.confirm ? 'write' : 'pass the dry run'}`} — ${fatal.length} blocker(s):`,
    );
    for (const f of fatal) console.error(`   ${f}`);
    process.exitCode = 1;
    // A dry run still previews the club sync so the operator sees every CONFLICT up front.
    if (!repo || args.confirm || args.noClubSync) return;
  }
  if (!repo) {
    console.log('\n[parse-only] gate clean — nothing touched AWS.');
    return;
  }

  // Drift vs stored drafts (replaced wholesale).
  for (const s of writeSet) {
    const st = storedById.get(String(s.id));
    if (!st || st.released) continue;
    const notes = [...storedDraftDrift(s, st), ...seriesFieldDrift(s, st)];
    if (notes.length) {
      console.warn(`\n⚠ ${s.id} differs from the stored draft and WILL BE REPLACED by --confirm:`);
      for (const n of notes) console.warn(`    · ${n}`);
    }
  }
  const nFixtures = writeSet.reduce((n, s) => n + (s.fixtures as unknown[]).length, 0);
  if (!args.confirm) {
    console.log(`\n${writeSet.length} draft series (${nFixtures} fixtures) would be written.`);
    if (!fatal.length) console.log('[dry-run] nothing written. Re-run with --confirm to import.');
    if (!args.noClubSync) {
      console.log(
        '\n── Club league sync (dry-run preview, includeDrafts; fixtures-only T20 cups add their league key only):',
      );
      const { syncClubLeaguesFromSeries } = await import('./sync-club-leagues-from-series.js');
      const res = await syncClubLeaguesFromSeries(TITANS_TENANT, {
        confirm: false,
        only: [...writeIds],
        includeDrafts: true,
        series: writeSet,
      });
      console.log(
        `  club sync preview: ${res.wouldPatch} club(s) would change, ${res.conflicts} CONFLICT(s), ${res.orphanSeries} orphan series`,
      );
    } else console.log('\n── --no-club-sync: club league sync AND T20 cup league keys skipped');
    return;
  }

  // ── Write ──
  const backupPath = await backupTitansSeries(
    stored.filter((s) => String(s.id).startsWith(TITANS_SERIES_PREFIX)),
    args.backupDir,
    clubs,
  );
  const { written, drifted } = await writeSeriesSet(repo, writeSet, storedById, backupPath);
  if (args.noClubSync)
    console.log('\n── --no-club-sync: club league sync AND T20 cup league keys skipped');
  else if (written.length) {
    console.log(
      '\n── Club league sync (includeDrafts; fixtures-only T20 cups add their league key only):',
    );
    const { syncClubLeaguesFromSeries } = await import('./sync-club-leagues-from-series.js');
    const res = await syncClubLeaguesFromSeries(TITANS_TENANT, {
      confirm: true,
      only: written,
      includeDrafts: true,
    });
    if (res.conflicts) console.warn(`⚠ ${res.conflicts} club-sync CONFLICT(s) — see above`);
    if (res.raced) {
      console.error(`✗ ${res.raced} club(s) changed mid-sync — re-run the import (idempotent)`);
      process.exitCode = 1;
    }
  }
  // Post-write verification against the stored tenant, release-gate semantics.
  const [afterSeries, afterClubs, afterVenues, afterConfig] = await Promise.all([
    repo.listSeries(TITANS_TENANT),
    repo.listClubs(TITANS_TENANT),
    repo.listVenues(TITANS_TENANT),
    repo.getTenantConfig(TITANS_TENANT),
  ]);
  const mineAfter = afterSeries.filter((s) => writeIds.has(String(s.id)));
  const post = scanTitansClashes(mineAfter, afterClubs, afterVenues, {
    existingOther: afterSeries.filter((s) => !writeIds.has(String(s.id))),
    aliases: venueAliasesFor(afterConfig),
  });
  printClashes('Post-write verification (stored tenant)', post);
  if (drifted.length || post.length) {
    process.exitCode = 1;
    console.error(
      `\n✗ ${drifted.length} series NOT written (changed since read — re-run)${post.length ? `; ${post.length} clash(es) in the stored tenant — inspect, or --revert --confirm` : ''}. Backup: ${backupPath}`,
    );
    return;
  }
  console.log(
    `\nDone. ${written.length} draft series written. Backup: ${backupPath}. Nothing is released — approve and release from the console (tick "Withhold start times").`,
  );
}

/**
 * Write the series one by one, each version-pinned to the copy this run read
 * (`writeSeriesFromSnapshot`): a series that moved since the read is NOT written ('drifted',
 * re-run); any other failure aborts with "ABORTED after N of M — RE-RUN REQUIRED" and rethrows
 * (a re-run replaces the written drafts in place and writes the rest).
 */
export async function writeSeriesSet(
  repo: Parameters<typeof writeSeriesFromSnapshot>[0],
  writeSet: Series[],
  storedById: Map<string, Series>,
  backupPath: string,
  log: { log: (l: string) => void; error: (l: string) => void } = console,
): Promise<{ written: string[]; drifted: string[] }> {
  const written: string[] = [];
  const drifted: string[] = [];
  try {
    for (const s of writeSet) {
      const st = storedById.get(String(s.id)) ?? null;
      const outcome = await writeSeriesFromSnapshot(repo, TITANS_TENANT, st, s, {
        error: (l) => log.error(l),
      });
      if (outcome === 'drifted') drifted.push(String(s.id));
      else {
        written.push(String(s.id));
        log.log(
          `wrote ${s.id} v${s.version} (${(s.fixtures as unknown[]).length} fixtures)${st ? ' (replaced draft)' : ''}`,
        );
      }
    }
  } catch (err) {
    log.error(
      `\n✗ ABORTED after ${written.length} of ${writeSet.length} series — RE-RUN REQUIRED: a re-run replaces the written drafts in place (stable ids) and writes the rest; the club sync has NOT run. Backup: ${backupPath}`,
    );
    throw err;
  }
  return { written, drifted };
}

/** The T20 knockout errors that block this run: only those of series it writes (--only). */
export function koBlockers(errors: KoError[], writes: (id: string) => boolean): string[] {
  return errors.filter((e) => writes(e.seriesId)).map((e) => e.message);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'append-sides') return runAppendSides(args);
  if (args.mode === 'revert') return runRevert(args);
  if (args.mode === 'restore-clubs') return runRestoreClubs(args);
  return runImport(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
