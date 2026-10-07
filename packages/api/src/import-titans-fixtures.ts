/**
 * Titans 2026-27 fixture import — the 36-sheet union workbook (1,398 fixtures) → `s-titans-*`
 * Series rows on the `titans` tenant, as DRAFTS.
 *
 *   npx tsx src/import-titans-fixtures.ts --parse-only [--report-out <path>]   # no AWS at all
 *
 * STEP A0 (the gate) implements --parse-only only: parse every sheet, resolve every team name
 * to a CLUB_MAP club, build the series in memory with provisional side ids, and run the
 * season-wide clash scan against the WOULD-BE venue registry (canonical ground names, one
 * pitch each, the misspellings-only alias table). The tenant dry-run, `--confirm`, `--only`
 * and `--revert` arrive with the write path (A3); until then any other mode refuses to run.
 *
 * The optional `--structure` workbook (the August league-structure sheet) supplies each club's
 * `ground.venue` exactly as the compliance import wrote it, so the release-gate preview can
 * place TBC-venue fixtures at the home club's ground the way the API gate does.
 *
 * Fail-closed: a sheet off its measured count, an unparseable row, a team name that resolves to
 * no club, a stale HELD_BACK entry or any residual clash fails the gate. There is NO
 * --allow-clashes (standing rule).
 */
import ExcelJS from 'exceljs';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WrittenFixture } from './import-planb-fixtures.js';
import { reconcileFixtureIds } from './fixture-identity.js';
import {
  findClashes,
  groundKey,
  normaliseName,
  venueAliasesFor,
  DEFAULT_VENUE_ALIASES,
  type Clash,
} from './venue-clash.js';
import { hasFeature } from './features.js';
import { writeSeriesFromSnapshot } from './medicoach-sync/cli-write.js';
import { storedDraftDrift } from './import-lions-fixtures.js';
import { venueIdFor } from './lions-fixture-map.js';
import {
  AMBIGUOUS_VENUES,
  EXPECTED_TOTAL_FIXTURES,
  HELD_BACK,
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
  TITANS_NEW_LEAGUES,
  TITANS_SERIES_PREFIX,
  TITANS_TENANT,
  TITANS_VENUE_ALIASES,
  VETERANS_KO_SERIES_IDS,
  T20_HOST_LEAGUES,
  canonicalTeamName,
  provisionalSideId,
  resolveTeamClub,
  titansGroundKey,
  type HeldBackFixture,
  type KoRow,
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
  held: Array<{
    entry: HeldBackFixture;
    seriesId: string;
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
  /** Registry lookup aliases (the tenant's merged under the titans map on a real run). */
  aliases?: Record<string, string>;
}

/**
 * Build every Series (planb/lions shape: participants snapshot, team-id home/away, `f<n>` ids,
 * dateMode 'reference', drafts). Ids are assigned over ALL parsed fixtures of a series in row
 * order BEFORE held-back fixtures are removed, so adding one back later keeps every id stable.
 * Round = rank of the fixture's date among the series' distinct dates. Pure.
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
      const side = (name: string): string => {
        const club = resolveTeamClub(name);
        if (!club) {
          const u = `${sheet.spec.sheet}: "${name}"`;
          if (!outcome.unresolvedNames.includes(u)) outcome.unresolvedNames.push(u);
          return name;
        }
        const live = opts.sideOf ? opts.sideOf(leagueKey, name) : undefined;
        if (opts.sideOf && !live) {
          const u = `${sheet.spec.sheet}: "${name}" (${leagueKey}) has no side on the live club`;
          if (!outcome.unresolvedNames.includes(u)) outcome.unresolvedNames.push(u);
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
      all.forEach((wf, i) => {
        const h = isHeldBack(raw[i], heldBack);
        if (h) {
          heldHits.set(h, (heldHits.get(h) ?? 0) + 1);
          outcome.held.push({ entry: h, seriesId: spec.seriesId, fixtureId: wf.id, raw: raw[i] });
          return;
        }
        kept.push(wf);
        if (raw[i].venue == null)
          outcome.tbc.push({
            seriesId: spec.seriesId,
            fixtureId: wf.id,
            date: wf.date,
            time: wf.time ?? '',
            home: raw[i].home,
            away: raw[i].away,
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
        ...(sheet.spec.layout === 't20' ? { seriesType: 'T20', maxOvers: 20 } : {}),
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
  const out: TaggedClash[] = [];
  for (let i = 0; i < subjects.length; i++) {
    const subject = subjects[i];
    for (const c of findClashes(
      subject,
      [...(opts.existingOther ?? []), ...subjects.slice(0, i)],
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
  const existing = ((stored?.fixtures as Slotted[] | undefined) ?? []).map((f) => ({
    ...f,
    home: f.slots?.home ?? f.home,
    away: f.slots?.away ?? f.away,
  }));
  const r = reconcileFixtureIds(existing, incoming);
  return {
    matched: r.matched,
    added: r.added,
    removed: r.removed.map((f) => `${f.id} ${f.date} ${f.home} v ${f.away}`),
  };
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
  L.push('## 10. Dates we corrected');
  L.push('');
  if (!r.dateCorrections.length) L.push('None.');
  else for (const d of r.dateCorrections) L.push(`- ${d}`);
  L.push('');
  return L.join('\n');
}

// ───────────────────────── CLI ─────────────────────────

export interface Args {
  mode: 'import' | 'append-sides' | 'revert';
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
}

/** Every series id this importer may write (or --revert deletes). */
export const WRITABLE_SERIES_IDS = [...KNOWN_SERIES_IDS, ...VETERANS_KO_SERIES_IDS];

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: 'import',
    ...DEFAULT_PATHS,
    parseOnly: false,
    confirm: false,
    only: [],
    reportOut: '',
    today: new Date().toISOString().slice(0, 10),
    noClubSync: false,
    includeReleased: false,
    backupDir: process.cwd(),
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
    else if (a === '--no-club-sync') args.noClubSync = true;
    else if (a === '--include-released') args.includeReleased = true;
    else if (a === '--backup-dir') args.backupDir = need(++i, a);
    else if (a === '--only')
      args.only = need(++i, a)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else throw new Error(`unknown flag ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.today)) throw new Error('--today needs YYYY-MM-DD');
  if (args.parseOnly && (args.confirm || args.mode !== 'import'))
    throw new Error('--parse-only takes no --confirm, --append-sides or --revert');
  if (args.mode !== 'import' && (args.only.length || args.reportOut))
    throw new Error('--only and --report-out are import flags');
  if (args.includeReleased && args.mode !== 'revert')
    throw new Error('--include-released is a --revert flag');
  for (const id of args.only)
    if (!WRITABLE_SERIES_IDS.includes(id))
      throw new Error(
        `--only: unknown series id "${id}"${T20_KO_SERIES_IDS.includes(id) ? ' (T20 knockouts wait for PR B)' : ''}`,
      );
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

/** Clubs a set of cup (T20) series needs the cup league key added for — `club.leagues` only:
 * a cup side is an existing league side, so no roster and no leagueTeams entry (which would
 * duplicate ids and double-count the club's teams). */
export function cupLeaguePatches(
  clubs: Club[],
  series: Series[],
  cupKeys: Set<string>,
): Array<{ clubId: string; add: string[] }> {
  const want = new Map<string, Set<string>>();
  for (const s of series) {
    const key = String(s.leagueKey);
    if (!cupKeys.has(key)) continue;
    for (const p of s.participants ?? [])
      want.set(p.clubId, (want.get(p.clubId) ?? new Set()).add(key));
  }
  const out: Array<{ clubId: string; add: string[] }> = [];
  for (const [clubId, keys] of want) {
    const club = clubs.find((c) => c.id === clubId);
    if (!club) continue;
    const add = [...keys].filter((k) => !(club.leagues ?? []).includes(k));
    if (add.length) out.push({ clubId, add });
  }
  return out.sort((a, b) => a.clubId.localeCompare(b.clubId));
}

/** Every (league, sheet side) the written series name — the input to the side plan. */
export function sideNeeds(sheets: ParsedTitansSheet[]): SideNeed[] {
  const seen = new Set<string>();
  const out: SideNeed[] = [];
  for (const s of sheets)
    for (const f of s.fixtures)
      for (const name of [f.home, f.away]) {
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
async function runAppendSides(args: Args) {
  const parsed = await parseAndPrint(args);
  if (!parsed) return;
  const repo = await import('./repo.js');
  const config = await repo.getTenantConfig(TITANS_TENANT);
  if (!config) throw new Error(`no tenant config for "${TITANS_TENANT}"`);
  const clubs = await repo.listClubs(TITANS_TENANT);
  console.log(`\nTenant "${TITANS_TENANT}": ${clubs.length} club(s)`);
  const plan = planSides(sideNeeds(parsed.sheets), clubs, {
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
  const { validateClubPatch, resolveRequiredDocs, resolveDistricts } =
    await import('./catalogue.js');
  const { resolveVertical } = await import('./vertical.js');
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
  for (const p of plan.patches) {
    const fresh = await repo.getClub(TITANS_TENANT, p.clubId);
    if (!fresh || fresh.version !== p.version) {
      console.error(`✗ ${p.clubId} changed since the read — NOT written (re-run)`);
      raced++;
      continue;
    }
    const patch: Partial<Club> = {
      version: p.version,
      leagues: p.leagues,
      leagueTeams: p.leagueTeams,
      teamRosters: p.teamRosters,
      teams: p.teams,
      women: p.women,
      juniors: p.juniors,
    };
    const requiredDocs = resolveRequiredDocs(config);
    const invalid = validateClubPatch(
      patch,
      new Set([...configured, ...(fresh.leagues ?? [])]),
      new Set([
        ...requiredDocs.map((d) => d.key),
        ...Object.keys(fresh.docs ?? {}),
        ...Object.keys(fresh.docMeta ?? {}),
      ]),
      new Set([...resolveDistricts(config), ...(fresh.district ? [fresh.district] : [])]),
      requiredDocs,
      fresh.docMeta,
      resolveVertical(config).sport,
    );
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
    } catch (err) {
      if ((err as { name?: string }).name !== 'VersionConflictError') throw err;
      console.error(`✗ ${p.clubId} changed mid-write — NOT written (re-run)`);
      raced++;
    }
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

async function runRevert(args: Args) {
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
      ? `Reverted ${mine.length} series. Club records are NOT reverted (restore them from the snapshot if needed).`
      : `Re-run with --confirm to delete these ${mine.length} series.`,
  );
}

async function runImport(args: Args) {
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
    [clubs, venues, stored] = await Promise.all([
      repo.listClubs(TITANS_TENANT),
      repo.listVenues(TITANS_TENANT),
      repo.listSeries(TITANS_TENANT),
    ]);
    const cfg = config;
    labelOf = (k) => (cfg.leagues ?? []).find((l) => l.key === k)?.label ?? leagueLabel(k);
    aliases = { ...venueAliasesFor(cfg), ...TITANS_VENUE_ALIASES };
    const storedAliases = cfg.competitionDefaults?.venueAliases ?? {};
    missingAliasKeys = Object.keys(TITANS_VENUE_ALIASES).filter((k) => !(k in storedAliases));
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
    sidePlan = planSides(sideNeeds(sheets), clubs, {
      hostLeagues: t20HostLeagues(sheets),
      allowAppend: false,
      fixturesOnlyKeys: fixturesOnlyKeys(cfg),
    });
    printSidePlan(sidePlan, { appendMode: false });
  }

  // ── Build ──
  const plan = sidePlan;
  const outcome = buildTitansSeries(
    sheets,
    venues,
    HELD_BACK,
    plan ? { sideOf: (k, n) => plan.resolve.get(sideKey(k, n)), labelOf, aliases } : {},
  );
  if (args.only.length) {
    outcome.built = outcome.built.filter((b) => args.only.includes(String(b.series.id)));
    console.log(`\n── --only: restricted to ${args.only.join(', ')}`);
  }
  const vets = buildVeteransKnockouts(sheets, outcome.built, labelOf);
  const koSeries = vets.series.filter((s) => !args.only.length || args.only.includes(String(s.id)));
  console.log(`\n── Name resolution (${outcome.resolutions.size} league side(s))`);
  const byClub = new Map<string, Set<string>>();
  for (const r of outcome.resolutions.values())
    byClub.set(
      r.clubName,
      (byClub.get(r.clubName) ?? new Set()).add(`${r.name}${plan ? ` [${r.teamId}]` : ''}`),
    );
  for (const [club, names] of [...byClub].sort((a, b) => a[0].localeCompare(b[0])))
    console.log(`  ${club}: ${[...names].sort().join(', ')}`);
  console.log(
    outcome.unresolvedNames.length
      ? `  ✗ ${outcome.unresolvedNames.length} unresolved name(s):\n    ${outcome.unresolvedNames.join('\n    ')}`
      : '  ✓ unresolved names: 0',
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
  for (const k of ko)
    console.log(
      `    ${T20_KO_SERIES_IDS.includes(k.koSeriesId) ? '[pending PR B] ' : '[written]      '}${koLine(k)}`,
    );
  for (const e of vets.errors) console.log(`    ✗ ${e}`);
  console.log(
    `  veterans playoff series built: ${koSeries.map((s) => s.id).join(', ') || 'none'}; T20 knockouts (${T20_KO_SERIES_IDS.join(', ')}) are NOT written — they need PR B's tbd: slots`,
  );
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

  // ── Stable ids against the stored series ──
  const storedById = new Map(stored.map((s) => [String(s.id), s]));
  const idProblems: string[] = [];
  for (const b of outcome.built) {
    const r = stabiliseIds(b.allFixtures, storedById.get(String(b.series.id)));
    for (const x of r.removed)
      idProblems.push(`${b.series.id}: stored fixture ${x} is not in the workbook`);
  }
  for (const s of koSeries) {
    const r = stabiliseIds(s.fixtures as TitansFixture[], storedById.get(String(s.id)));
    for (const x of r.removed)
      idProblems.push(`${s.id}: stored fixture ${x} is not in the workbook`);
  }
  const writeSet: Series[] = [...outcome.built.map((b) => b.series), ...koSeries];
  const writeIds = new Set(writeSet.map((s) => String(s.id)));
  const cupKeys = new Set(Object.keys(T20_HOST_LEAGUES));

  // ── Clash scan ──
  const existingOther = stored.filter((s) => !writeIds.has(String(s.id)));
  const scanOpts = { existingOther, aliases };
  const before = scanTitansClashes(
    [...withHeldBack(outcome.built), ...koSeries],
    clubs,
    venues,
    scanOpts,
  );
  const after = scanTitansClashes(writeSet, clubs, venues, scanOpts);
  const canPreview = !args.parseOnly || grounds;
  const gatePreview = canPreview
    ? scanTitansClashes(writeSet, clubs, venues, { ...scanOpts, includeTbc: true })
    : null;
  const scope = args.parseOnly
    ? 'would-be registry, 1 pitch each'
    : `live tenant: ${existingOther.length} other series${wouldBeVenues ? ', WOULD-BE registry' : ''}`;
  printClashes(`CLASH SCAN before HELD_BACK (${scope}, TBC excluded)`, before);
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
      splitRounds,
      tbcVenues: outcome.tbc,
      pastFixtures,
      dateCorrections,
      clashes: { beforeHeldBack: before, afterHeldBack: after, gatePreview },
      womensLeagueTeams: womens,
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
  for (const n of outcome.unresolvedNames) fatal.push(`unresolved side ${n}`);
  fatal.push(...outcome.heldProblems);
  fatal.push(...vets.errors);
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
    if (outcome.registryMisses.size)
      fatal.push(
        `${outcome.registryMisses.size} venue(s) not in the registry — run bootstrap-titans-fixture-prereqs --confirm`,
      );
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
    const notes = storedDraftDrift(s, st);
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
      console.log('\n── Club league sync (dry-run preview, includeDrafts):');
      const { syncClubLeaguesFromSeries } = await import('./sync-club-leagues-from-series.js');
      const syncSet = writeSet.filter((s) => !cupKeys.has(String(s.leagueKey)));
      const res = await syncClubLeaguesFromSeries(TITANS_TENANT, {
        confirm: false,
        only: syncSet.map((s) => String(s.id)),
        includeDrafts: true,
        series: syncSet,
      });
      console.log(
        `  club sync preview: ${res.wouldPatch} club(s) would change, ${res.conflicts} CONFLICT(s), ${res.orphanSeries} orphan series`,
      );
      const cup = cupLeaguePatches(clubs, writeSet, cupKeys);
      console.log(
        `\n── Cup league keys (T20 series reuse league side ids; only club.leagues gains the key): ${cup.length} club(s)`,
      );
      for (const c of cup) console.log(`  [dry-run] ${c.clubId}: +[${c.add.join(', ')}]`);
    }
    return;
  }

  // ── Write ──
  const backupPath = await backupTitansSeries(
    stored.filter((s) => String(s.id).startsWith(TITANS_SERIES_PREFIX)),
    args.backupDir,
    clubs,
  );
  const written: string[] = [];
  const drifted: string[] = [];
  for (const s of writeSet) {
    const st = storedById.get(String(s.id)) ?? null;
    const outcome2 = await writeSeriesFromSnapshot(repo, TITANS_TENANT, st, s, {
      error: (l) => console.error(l),
    });
    if (outcome2 === 'drifted') drifted.push(String(s.id));
    else {
      written.push(String(s.id));
      console.log(
        `wrote ${s.id} v${s.version} (${(s.fixtures as unknown[]).length} fixtures)${st ? ' (replaced draft)' : ''}`,
      );
    }
  }
  if (!args.noClubSync && written.length) {
    console.log('\n── Club league sync (includeDrafts):');
    const { syncClubLeaguesFromSeries } = await import('./sync-club-leagues-from-series.js');
    const res = await syncClubLeaguesFromSeries(TITANS_TENANT, {
      confirm: true,
      only: written.filter(
        (id) => !cupKeys.has(String(writeSet.find((s) => s.id === id)?.leagueKey)),
      ),
      includeDrafts: true,
    });
    if (res.conflicts) console.warn(`⚠ ${res.conflicts} club-sync CONFLICT(s) — see above`);
    // T20 cups: add the league key only (fresh read, version-pinned) — never a roster.
    const freshClubs = await repo.listClubs(TITANS_TENANT);
    const cup = cupLeaguePatches(
      freshClubs,
      writeSet.filter((s) => written.includes(String(s.id))),
      cupKeys,
    );
    console.log(`\n── Cup league keys: ${cup.length} club(s)`);
    for (const c of cup) {
      const club = freshClubs.find((x) => x.id === c.clubId)!;
      try {
        await repo.updateClub(
          TITANS_TENANT,
          c.clubId,
          { version: club.version, leagues: [...(club.leagues ?? []), ...c.add] },
          'import-titans-fixtures (cup league keys)',
          new Date().toISOString(),
        );
        console.log(`  ${c.clubId}: +[${c.add.join(', ')}]`);
      } catch (err) {
        if ((err as { name?: string }).name !== 'VersionConflictError') throw err;
        console.error(`  ✗ ${c.clubId} changed mid-run — cup key NOT added (re-run)`);
        process.exitCode = 1;
      }
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'append-sides') return runAppendSides(args);
  if (args.mode === 'revert') return runRevert(args);
  return runImport(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
