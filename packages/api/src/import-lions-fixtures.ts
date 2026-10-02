/**
 * Lions (CGL) 2026-27 fixture import — the converted league workbook (13 sheets, 1,513
 * fixtures) plus the map-transcribed T20 pools (lions-fixture-map.ts) → `s-lions-*` Series
 * rows on the `lions` tenant, as DRAFTS, reversibly.
 *
 *   npx tsx src/import-lions-fixtures.ts --parse-only [--questions-out <md>]   # no AWS at all
 *   npx sst shell --stage dev -- npx tsx src/import-lions-fixtures.ts           # dry-run
 *   … [--only <slug>[,…]]                                                       # dry-run limited to those series
 *   … --confirm                                                                 # write (backup first)
 *   … --revert [--all] [--confirm]                                              # delete imported series
 *
 * Inputs default to the prepared files under ~/Downloads/Lions (override with --file,
 * --sunday-grounds, --saturday-grounds, --affiliation). The grounds sheets + affiliation
 * form are read only in --parse-only, to build the WOULD-BE venue registry the provisional
 * clash scan runs against; a real run reads the tenant's registry (seeded by
 * bootstrap-lions-fixture-prereqs).
 *
 * PURPOSE-BUILT, NOT copy-and-trimmed from import-planb-fixtures.ts (plan amendment 5). Only
 * planb's pure, tenant-neutral cell helpers are reused (`isoDate`/`isoTime`, the
 * `WrittenFixture` shape). planb's `buildSeries` is deliberately NOT called: it resolves
 * names through planb's module-level dolphins NAME_ALIASES/NAME_REDIRECTS with no injection
 * point, so this file builds the same Series shape itself from names pre-resolved through
 * lions-import-map.ts. Nothing here touches a dolphins table.
 *
 * Venues are SHEET-AUTHORITATIVE (mirrors planb's --release mode): a venue that resolves to
 * the registry (via the explicit LIONS_VENUE_ALIASES — never the dolphins default) is
 * written locked with the registry's id/name; anything else is written as a venueOverride
 * (equal venueName) and listed. "TBC" venues are written venue-less (`venueStatus:
 * 'unresolved'`), excluded from the clash scan and listed for the admin.
 *
 * Fail-closed: a sheet missing or off its verified count, an unparseable row, a team name
 * that resolves to no club, a club the tenant doesn't have, a T20 table that fails its
 * round-robin asserts, an existing RELEASED series, or ANY unresolved venue clash aborts the
 * write. There is NO --allow-clashes flag (standing rule): the contingency is a partial
 * write with --only for clash-free series.
 */
import ExcelJS from 'exceljs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isoDate, isoTime, type WrittenFixture } from './import-planb-fixtures.js';
import { findClashes, type Clash } from './venue-clash.js';
import {
  LIONS_TENANT,
  LIONS_SERIES_PREFIX,
  LIONS_LEAGUES,
  LEAGUE_SHEETS,
  EXPECTED_LEAGUE_FIXTURES,
  LIONS_VENUES,
  LIONS_VENUE_ALIASES,
  T20_POOLS,
  T20_SOURCES,
  buildLionsVenueRegistry,
  canonicalVenue,
  cleanVenue,
  isMacrocommRow,
  isTbcVenue,
  lionsGroundKey,
  parseGroundsSheet,
  resolveTeam,
  sideTeamId,
  t20SideFor,
  verifyT20Pools,
  type LionsSeriesSpec,
  type LionsSheetSpec,
  type T20Pool,
  type RegistryReport,
} from './lions-fixture-map.js';
import { CLUB_MAP } from './lions-import-map.js';
import { parseAffiliationWorkbook } from './lions-affiliation-parse.js';
import type { Club, Series, Venue, VenueStatus } from './types.js';

type RepoModule = typeof import('./repo.js');
type SeriesParticipant = NonNullable<Series['participants']>[number];

const LIONS_DIR = join(homedir(), 'Downloads', 'Lions');
export const DEFAULT_PATHS = {
  file: join(LIONS_DIR, 'prepared', 'Final Fixtures 2026-2027.xlsx'),
  sundayGrounds: join(LIONS_DIR, 'prepared', 'Teams per division and Grounds - Sunday.xlsx'),
  saturdayGrounds: join(LIONS_DIR, 'Teams per Division and ground - Saturday .xlsx'),
  affiliation: join(LIONS_DIR, 'CGL Affiliation 2026_27 (Responses) (2).xlsx'),
};

/** Season window — a date outside it is a bad read (e.g. a SAST-shifted serial), not data. */
const SEASON_FROM = '2026-09-01';
const SEASON_TO = '2027-05-31';

/** Every slug this manifest produces — the default `--revert` scope. */
export const KNOWN_SLUGS = [...LEAGUE_SHEETS.map((s) => s.slug), ...T20_POOLS.map((p) => p.slug)];

// ───────────────────────── Flat-sheet parser ─────────────────────────

export interface LionsRawFixture {
  /** Sheet row number, or 0 for a map-transcribed T20 fixture. */
  row: number;
  round: number;
  date: string;
  time: string;
  home: string;
  away: string;
  /** Cleaned venue string, or null for TBC. */
  venue: string | null;
  /** Provenance for venueReason ("CGL 2026-27 fixtures workbook" / the T20 PDF name). */
  source: string;
}

export interface ParsedLeagueSheet {
  spec: LionsSheetSpec;
  fixtures: LionsRawFixture[];
  macrocomm: Array<{ row: number; label: string; date: string | null }>;
  errors: string[];
  warnings: string[];
}

function cellText(v: unknown): string {
  if (v == null || v instanceof Date) return '';
  if (typeof v === 'object' && 'richText' in (v as object))
    return (v as { richText: Array<{ text: string }> }).richText.map((r) => r.text).join('');
  if (typeof v === 'object' && 'result' in (v as object))
    return cellText((v as { result: unknown }).result);
  return String(v).replace(/\s+/g, ' ').trim();
}

const HEADER_PATTERNS = {
  date: /^date$/,
  time: /^time$/,
  home: /^home( team)?$/,
  away: /^away( team)?$/,
  venue: /^venue$/,
} as const;
type HeaderField = keyof typeof HEADER_PATTERNS;

/** Locate the `Date|Time|Home Team|Away Team|Venue` header in the first 10 rows → columns. */
export function locateHeader(
  ws: ExcelJS.Worksheet,
): { row: number; cols: Record<HeaderField, number> } | null {
  const last = Math.min(ws.rowCount, 10);
  for (let r = 1; r <= last; r++) {
    const row = ws.getRow(r);
    const cols: Partial<Record<HeaderField, number>> = {};
    for (let c = 1; c <= Math.max(ws.columnCount, 5); c++) {
      const t = cellText(row.getCell(c).value).toLowerCase();
      for (const [field, re] of Object.entries(HEADER_PATTERNS) as Array<[HeaderField, RegExp]>)
        if (re.test(t) && cols[field] === undefined) cols[field] = c;
    }
    if (Object.keys(HEADER_PATTERNS).every((k) => cols[k as HeaderField] !== undefined))
      return { row: r, cols: cols as Record<HeaderField, number> };
  }
  return null;
}

/**
 * Parse one league sheet. Header-driven, UTC reads only (planb's isoDate/isoTime read the
 * UTC components of exceljs's Date cells), fail-closed: every non-blank row below the header
 * must be either a complete fixture or a "Macrocomm Round N" placeholder (skipped, counted).
 * Count, Macrocomm-row count, start time, weekday and season window are all asserted.
 */
export function parseLeagueSheet(ws: ExcelJS.Worksheet, spec: LionsSheetSpec): ParsedLeagueSheet {
  const out: ParsedLeagueSheet = { spec, fixtures: [], macrocomm: [], errors: [], warnings: [] };
  const header = locateHeader(ws);
  if (!header) {
    out.errors.push(
      `${spec.sheet}: no "Date | Time | Home Team | Away Team | Venue" header in the first 10 rows`,
    );
    return out;
  }
  const { cols } = header;
  const used = new Set(Object.values(cols));
  const seen = new Set<string>();
  for (let r = header.row + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const raw = {
      date: row.getCell(cols.date).value,
      time: row.getCell(cols.time).value,
      home: cellText(row.getCell(cols.home).value),
      away: cellText(row.getCell(cols.away).value),
      venue: cellText(row.getCell(cols.venue).value),
    };
    const dateStr = isoDate(raw.date);
    const timeStr = isoTime(raw.time);
    const blank = !dateStr && !timeStr && !raw.home && !raw.away && !raw.venue;
    for (let c = 1; c <= ws.columnCount; c++)
      if (!used.has(c) && cellText(row.getCell(c).value))
        out.warnings.push(`${spec.sheet} row ${r}: stray value in column ${c} ignored`);
    if (blank) continue;
    if (isMacrocommRow(raw.home, raw.away, raw.venue)) {
      out.macrocomm.push({ row: r, label: raw.home, date: dateStr });
      continue;
    }
    const where = `${spec.sheet} row ${r}`;
    const problems: string[] = [];
    if (!(raw.date instanceof Date) || !dateStr) problems.push('no date cell');
    if (!timeStr) problems.push('no time cell');
    if (!raw.home) problems.push('blank Home Team');
    if (!raw.away) problems.push('blank Away Team');
    if (!raw.venue) problems.push('blank Venue (TBC rows must say TBC)');
    if (problems.length) {
      out.errors.push(
        `${where}: ${problems.join(', ')} — "${raw.home}" v "${raw.away}" @ "${raw.venue}"`,
      );
      continue;
    }
    if (timeStr !== spec.expectedTime)
      out.errors.push(
        `${where}: start time ${timeStr}, every ${spec.sheet} fixture starts ${spec.expectedTime}`,
      );
    if (dateStr! < SEASON_FROM || dateStr! > SEASON_TO)
      out.errors.push(`${where}: date ${dateStr} outside the ${SEASON_FROM}..${SEASON_TO} season`);
    if (new Date(`${dateStr}T00:00:00Z`).getUTCDay() !== spec.weekday)
      out.errors.push(
        `${where}: ${dateStr} is not a ${spec.weekday === 0 ? 'Sunday' : 'Saturday'}`,
      );
    if (raw.home.toLowerCase() === raw.away.toLowerCase())
      out.errors.push(`${where}: "${raw.home}" plays itself`);
    const dup = `${dateStr}|${raw.home.toLowerCase()}|${raw.away.toLowerCase()}`;
    if (seen.has(dup))
      out.errors.push(`${where}: duplicate fixture ${raw.home} v ${raw.away} on ${dateStr}`);
    seen.add(dup);
    out.fixtures.push({
      row: r,
      round: 0,
      date: dateStr!,
      time: timeStr!,
      home: raw.home,
      away: raw.away,
      venue: isTbcVenue(raw.venue) ? null : cleanVenue(raw.venue),
      source: 'CGL 2026-27 fixtures workbook',
    });
  }
  // Round = rank of the fixture's date among the sheet's distinct dates.
  const dates = [...new Set(out.fixtures.map((f) => f.date))].sort();
  for (const f of out.fixtures) f.round = dates.indexOf(f.date) + 1;
  if (out.fixtures.length !== spec.expected)
    out.errors.push(
      `${spec.sheet}: ${out.fixtures.length} fixtures parsed, expected ${spec.expected}`,
    );
  if (out.macrocomm.length !== spec.macrocommRows)
    out.errors.push(
      `${spec.sheet}: ${out.macrocomm.length} Macrocomm placeholder row(s), expected ${spec.macrocommRows}`,
    );
  return out;
}

export function parseLeagueWorkbook(wb: ExcelJS.Workbook): {
  sheets: ParsedLeagueSheet[];
  errors: string[];
} {
  const sheets: ParsedLeagueSheet[] = [];
  const errors: string[] = [];
  for (const spec of LEAGUE_SHEETS) {
    const ws = wb.worksheets.find((w) => w.name.trim() === spec.sheet);
    if (!ws) {
      errors.push(
        `sheet "${spec.sheet}" not found (have: ${wb.worksheets.map((w) => `"${w.name}"`).join(', ')})`,
      );
      continue;
    }
    const parsed = parseLeagueSheet(ws, spec);
    errors.push(...parsed.errors);
    sheets.push(parsed);
  }
  const total = sheets.reduce((n, s) => n + s.fixtures.length, 0);
  if (!errors.length && total !== EXPECTED_LEAGUE_FIXTURES)
    errors.push(`${total} league fixtures parsed, expected ${EXPECTED_LEAGUE_FIXTURES}`);
  return { sheets, errors };
}

/** The T20 pools as builder inputs (venue strings cleaned, TBC → null). */
export function t20Inputs(pools: T20Pool[] = T20_POOLS): SeriesInput[] {
  return pools.map((pool) => ({
    spec: pool,
    pool,
    fixtures: pool.fixtures.map((f) => ({
      row: 0,
      round: f.round,
      date: f.date,
      time: f.time,
      home: f.home,
      away: f.away,
      venue: isTbcVenue(f.venue) ? null : cleanVenue(f.venue!),
      source: `CGL T20 PDF "${T20_SOURCES[f.source].file}"`,
    })),
  }));
}

// ───────────────────────── Series builder ─────────────────────────

export interface SeriesInput {
  spec: LionsSeriesSpec;
  /** Set for a T20 pool (drives the HWB two-division side ids). */
  pool?: T20Pool;
  fixtures: LionsRawFixture[];
}

export interface BuildContext {
  /** The clubs fixtures may reference — the tenant's records, or CLUB_MAP in --parse-only. */
  clubs: Club[];
  /** The venue registry (tenant's, or the would-be registry in --parse-only). */
  venues: Venue[];
  leagueLabel: (key: string) => string;
}

export interface ResolutionRow {
  raw: string;
  leagueKey: string;
  clubId: string;
  clubName: string;
  teamId: string;
}

export interface BuiltLionsSeries {
  series: Series;
  fixtures: WrittenFixture[];
  raw: LionsRawFixture[];
}

export interface BuildOutcome {
  built: BuiltLionsSeries[];
  /** Name-resolution sign-off table, keyed `leagueKey::raw::teamId`. */
  resolutions: Map<string, ResolutionRow>;
  /** Raw names that resolve to no club (fatal). */
  unresolvedNames: string[];
  /** Resolved club ids the BuildContext has no record for (fatal on a real run). */
  missingClubs: string[];
  /** A club fielding both a plain and a numbered side in one league (fatal). */
  mixing: string[];
  /** Fixture counts per venue outcome. */
  locked: number;
  /** Registry misses: cleaned venue string → { canonical name if any, fixture count }. */
  registryMisses: Map<string, { canonical: string | null; count: number }>;
  /** TBC fixtures (written venue-less, scan-excluded). */
  tbc: Array<{
    seriesId: string;
    fixtureId: string;
    date: string;
    time: string;
    home: string;
    away: string;
  }>;
}

function deriveStatus(
  venue: Venue | undefined,
  homeClubId: string,
  awayClubId: string,
): VenueStatus {
  const ids = venue?.homeClubIds ?? [];
  if (ids.includes(homeClubId)) return 'home';
  if (ids.includes(awayClubId)) return 'alternative';
  return 'neutral';
}

/**
 * Build every Series (same shape as planb's buildSeries output: participants snapshot,
 * team-id home/away, `f<n>` ids, dateMode 'reference', drafts) with venues applied
 * sheet-authoritatively. Pure — the caller decides what is fatal from the outcome.
 */
export function buildAllSeries(inputs: SeriesInput[], ctx: BuildContext): BuildOutcome {
  const clubsById = new Map(ctx.clubs.map((c) => [c.id, c]));
  const registry = new Map<string, Venue>();
  for (const v of ctx.venues) registry.set(lionsGroundKey(v.name), v);
  const outcome: BuildOutcome = {
    built: [],
    resolutions: new Map(),
    unresolvedNames: [],
    missingClubs: [],
    mixing: [],
    locked: 0,
    registryMisses: new Map(),
    tbc: [],
  };
  const plain = new Set<string>();
  const sided = new Set<string>();

  for (const input of inputs) {
    const { spec } = input;
    const leagueKey = spec.leagueKey;
    const participants: SeriesParticipant[] = [];
    const teamIds: string[] = [];
    const resolveSide = (raw: string): SeriesParticipant | null => {
      const t = resolveTeam(raw, leagueKey);
      if (!t) {
        if (!outcome.unresolvedNames.includes(`${spec.slug}: "${raw}"`))
          outcome.unresolvedNames.push(`${spec.slug}: "${raw}"`);
        return null;
      }
      let { teamId, sideLabel } = t;
      if (input.pool && teamId === t.club.id) {
        const side = t20SideFor(input.pool, t.club.id);
        if (side) {
          teamId = sideTeamId(t.club.id, leagueKey, side.index);
          sideLabel = side.label;
        }
      }
      (teamId === t.club.id ? plain : sided).add(`${leagueKey}::${t.club.id}`);
      const club = clubsById.get(t.club.id);
      if (!club && !outcome.missingClubs.includes(t.club.id)) outcome.missingClubs.push(t.club.id);
      const clubName = club?.name ?? t.club.name;
      // Keyed by teamId too: one HWB spelling ("UJ") names a DIFFERENT side per division.
      const key = `${leagueKey}::${raw}::${teamId}`;
      if (!outcome.resolutions.has(key))
        outcome.resolutions.set(key, { raw, leagueKey, clubId: t.club.id, clubName, teamId });
      const g = club?.ground ?? {};
      const p: SeriesParticipant = {
        teamId,
        clubId: t.club.id,
        name: sideLabel ? `${clubName} ${sideLabel}` : clubName,
        ...(g.venue ? { venue: g.venue } : {}),
        ...(Number.isFinite(g.lat) ? { lat: g.lat as number } : {}),
        ...(Number.isFinite(g.lon) ? { lon: g.lon as number } : {}),
      };
      if (!teamIds.includes(teamId)) {
        teamIds.push(teamId);
        participants.push(p);
      }
      return p;
    };

    const seriesId = `${LIONS_SERIES_PREFIX}${spec.slug}`;
    const fixtures: WrittenFixture[] = input.fixtures.map((f, i) => {
      const home = resolveSide(f.home);
      const away = resolveSide(f.away);
      const wf: WrittenFixture = {
        id: `f${i + 1}`,
        round: f.round,
        date: f.date,
        time: f.time,
        home: home?.teamId ?? f.home,
        away: away?.teamId ?? f.away,
      };
      if (f.venue == null) {
        wf.venueStatus = 'unresolved';
        wf.venueReason = `${f.source} — venue TBC`;
        outcome.tbc.push({
          seriesId,
          fixtureId: wf.id,
          date: f.date,
          time: f.time,
          home: f.home,
          away: f.away,
        });
        return wf;
      }
      const venue = registry.get(lionsGroundKey(f.venue));
      wf.venueReason = `${f.source} — exact venue`;
      wf.venueStatus = deriveStatus(venue, home?.clubId ?? '', away?.clubId ?? '');
      if (venue) {
        wf.venueId = venue.id;
        wf.venueName = venue.name;
        if (Number.isFinite(venue.lat)) wf.venueLat = venue.lat;
        if (Number.isFinite(venue.lon)) wf.venueLon = venue.lon;
        wf.venueLocked = true;
        outcome.locked++;
      } else {
        // Registry miss: the canonical spelling where the map knows the ground, else the
        // sheet's own (cleaned). venueName EQUALS venueOverride — planb's setVenue rule.
        const canon = canonicalVenue(f.venue)?.name ?? null;
        const name = canon ?? f.venue;
        wf.venueOverride = name;
        wf.venueName = name;
        const miss = outcome.registryMisses.get(f.venue) ?? { canonical: canon, count: 0 };
        miss.count++;
        outcome.registryMisses.set(f.venue, miss);
      }
      return wf;
    });

    const dates = fixtures.map((f) => f.date).sort();
    const series: Series = {
      id: seriesId,
      name: `${ctx.leagueLabel(leagueKey)} · ${spec.label}`,
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
      // Drafts on purpose: the admin approves + releases from the console.
      approved: false,
      released: false,
      releasedAt: null,
      version: 1,
    } as Series;
    outcome.built.push({ series, fixtures, raw: input.fixtures });
  }
  for (const k of sided)
    if (plain.has(k)) {
      const [leagueKey, clubId] = k.split('::');
      outcome.mixing.push(
        `${clubId} appears both as a plain team and a numbered side in "${leagueKey}"`,
      );
    }
  return outcome;
}

// ───────────────────────── Clash scan ─────────────────────────

export interface ScanClash extends Clash {
  seriesId: string;
  seriesName: string;
}

/** A copy of the series without its venue-less (TBC) fixtures — they are scan-excluded. */
function withoutTbc(s: Series): Series {
  return {
    ...s,
    fixtures: (s.fixtures as WrittenFixture[]).filter((f) => f.venueOverride || f.venueName),
  };
}

/**
 * Season-wide clash scan with release-gate semantics (venue-clash.ts `findClashes`, lions
 * alias map, registry surfaces as capacity, default 1). Each built series is checked against
 * the tenant's other series plus the built series before it, so every double-booking is
 * reported exactly once. TBC fixtures are excluded unless `includeTbc` (the release-gate
 * preview, where the gate falls back to the home club's ground).
 */
export function scanClashes(
  built: Series[],
  existingOther: Series[],
  clubs: Club[],
  venues: Venue[],
  opts: { includeTbc?: boolean } = {},
): ScanClash[] {
  const subjects = opts.includeTbc ? built : built.map(withoutTbc);
  const out: ScanClash[] = [];
  for (let i = 0; i < subjects.length; i++) {
    const subject = subjects[i];
    const others = [...existingOther, ...subjects.slice(0, i)];
    for (const c of findClashes(subject, others, clubs, venues, LIONS_VENUE_ALIASES))
      out.push({ ...c, seriesId: String(subject.id), seriesName: subject.name });
  }
  return out;
}

export interface SlotGroup {
  date: string;
  time: string;
  groundKey: string;
  ground: string;
  capacity: number;
  fixtures: Array<{
    seriesId: string;
    seriesName: string;
    fixtureId: string;
    round: number;
    home: string;
    away: string;
  }>;
}

/** Built fixtures grouped by ground/date/time — the slots whose load exceeds the ground's
 * capacity are exactly the double-bookings (all lions fixtures are timed). */
export function slotGroups(built: BuiltLionsSeries[], venues: Venue[]): SlotGroup[] {
  const cap = new Map<string, number>();
  for (const v of venues) cap.set(lionsGroundKey(v.name), Math.max(1, Number(v.surfaces) || 1));
  const groups = new Map<string, SlotGroup>();
  for (const { series, fixtures } of built) {
    const names = new Map((series.participants ?? []).map((p) => [p.teamId, p.name]));
    for (const f of fixtures) {
      const ground = f.venueOverride || f.venueName;
      if (!ground) continue;
      const gk = lionsGroundKey(ground);
      const k = `${f.date}|${f.time ?? ''}|${gk}`;
      let g = groups.get(k);
      if (!g) {
        g = {
          date: f.date,
          time: f.time ?? '',
          groundKey: gk,
          ground,
          capacity: cap.get(gk) ?? 1,
          fixtures: [],
        };
        groups.set(k, g);
      }
      g.fixtures.push({
        seriesId: String(series.id),
        seriesName: series.name,
        fixtureId: f.id,
        round: f.round,
        home: names.get(f.home) ?? f.home,
        away: names.get(f.away) ?? f.away,
      });
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.time.localeCompare(b.time) ||
      a.ground.localeCompare(b.ground),
  );
}

/** Ground-days shared by DIFFERENT competitions at DIFFERENT start times (e.g. a 09:00 T20
 * then a 13:00 league game) — the ledger treats distinct times as non-overlapping, so these
 * are not clashes, but CGL should confirm the earlier game finishes in time. */
export function crossCompetitionSameDay(
  built: BuiltLionsSeries[],
): Array<{ date: string; ground: string; entries: string[] }> {
  const byDay = new Map<
    string,
    { date: string; ground: string; items: Array<{ league: string; time: string; label: string }> }
  >();
  for (const { series, fixtures } of built) {
    const names = new Map((series.participants ?? []).map((p) => [p.teamId, p.name]));
    for (const f of fixtures) {
      const ground = f.venueOverride || f.venueName;
      if (!ground) continue;
      const k = `${f.date}|${lionsGroundKey(ground)}`;
      const e = byDay.get(k) ?? { date: f.date, ground, items: [] };
      e.items.push({
        league: String(series.leagueKey),
        time: f.time ?? '',
        label: `${f.time} ${series.name}: ${names.get(f.home) ?? f.home} v ${names.get(f.away) ?? f.away}`,
      });
      byDay.set(k, e);
    }
  }
  const out: Array<{ date: string; ground: string; entries: string[] }> = [];
  for (const e of byDay.values()) {
    const leagues = new Set(e.items.map((i) => i.league));
    const times = new Set(e.items.map((i) => i.time));
    if (leagues.size > 1 && times.size > 1)
      out.push({ date: e.date, ground: e.ground, entries: e.items.map((i) => i.label).sort() });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.ground.localeCompare(b.ground));
}

// ───────────────────────── CGL question list (markdown) ─────────────────────────

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function renderQuestionsMarkdown(args: {
  built: BuiltLionsSeries[];
  outcome: BuildOutcome;
  clashes: ScanClash[];
  groups: SlotGroup[];
  venues: Venue[];
  registryReport: RegistryReport | null;
  generatedAt: string;
}): string {
  const { built, outcome, clashes, groups, venues } = args;
  const over = groups.filter((g) => g.fixtures.length > g.capacity);
  const totalFixtures = built.reduce((n, b) => n + b.fixtures.length, 0);
  const scanned = totalFixtures - outcome.tbc.length;
  const byGround = new Map<string, SlotGroup[]>();
  for (const g of over) byGround.set(g.ground, [...(byGround.get(g.ground) ?? []), g]);
  const usage = new Map<string, number>();
  for (const g of groups) usage.set(g.ground, (usage.get(g.ground) ?? 0) + g.fixtures.length);
  const L: string[] = [];
  L.push('# CGL 2026-27 fixtures: ground capacity and double-booking questions');
  L.push('');
  L.push(
    `Prepared ${args.generatedAt} from the 2026-27 fixtures workbook (13 league sheets) and the Hollywoodbets Premier / Ladies Premier T20 PDFs, before the fixtures are loaded onto the Smart Club platform.`,
  );
  L.push('');
  L.push(
    'The platform will not publish a fixture list in which one ground hosts more matches at the same time than it has pitches. Until we hear otherwise we assume **every ground has one pitch**. Your answers below decide which fixtures can be published as they stand.',
  );
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push(
    `- Fixtures checked: **${scanned}** (${outcome.tbc.length} more have no ground yet and are listed in section 3).`,
  );
  L.push(
    `- Same ground, same day, same start time: **${over.length}** case(s) at **${byGround.size}** ground(s) (${clashes.length} double-booking(s) in total).`,
  );
  L.push(
    `- Venue names we could not match to the grounds lists: **${outcome.registryMisses.size}** (section 4).`,
  );
  L.push('');
  L.push('## 1. How many matches can each ground host at the same time?');
  L.push('');
  if (!byGround.size) {
    L.push(
      'No ground is double-booked, so no capacity answers are needed to publish. Section 6 lists every ground in case you want to record pitch counts anyway.',
    );
  } else {
    L.push(
      'For each ground below, please tell us **how many matches it can host simultaneously** (the number of separate pitches/ovals that can be in use at once). If the answer is 2 or more, the double-bookings in section 2 at that ground are fine and need no change.',
    );
    L.push('');
    L.push(
      '| Ground | Dates with more than one match at the same time | Simultaneous matches possible? |',
    );
    L.push('|---|---|---|');
    for (const [ground, gs] of [...byGround].sort((a, b) => a[0].localeCompare(b[0])))
      L.push(
        `| ${ground} | ${gs.map((g) => `${longDate(g.date)} ${g.time} (${g.fixtures.length})`).join('; ')} | |`,
      );
  }
  L.push('');
  L.push('## 2. Double-bookings: which fixture moves?');
  L.push('');
  if (!over.length) L.push('None found.');
  else {
    L.push(
      'If the ground in question has only one pitch, please tell us **which fixture moves, and to which ground**.',
    );
    L.push('');
    let n = 0;
    for (const g of over) {
      n++;
      L.push(
        `**${n}. ${g.ground}, ${longDate(g.date)} at ${g.time}** (${g.fixtures.length} matches, ${g.capacity} pitch assumed)`,
      );
      L.push('');
      for (const f of g.fixtures)
        L.push(`- ${f.seriesName}, round ${f.round}: ${f.home} v ${f.away}`);
      L.push('');
      L.push('Which fixture moves, and where to? ______');
      L.push('');
    }
  }
  L.push('## 3. Fixtures with no ground yet (TBC)');
  L.push('');
  if (!outcome.tbc.length) L.push('None.');
  else {
    L.push(
      'These will be loaded without a ground and left off the clash check. Please send the ground for each when it is known.',
    );
    L.push('');
    L.push('| Competition | Date | Time | Fixture | Ground? |');
    L.push('|---|---|---|---|---|');
    const nameOf = new Map(built.map((b) => [String(b.series.id), b.series.name]));
    for (const t of outcome.tbc)
      L.push(
        `| ${nameOf.get(t.seriesId) ?? t.seriesId} | ${longDate(t.date)} | ${t.time} | ${t.home} v ${t.away} | |`,
      );
  }
  L.push('');
  L.push('## 4. Venue names we could not match to a ground on the grounds lists');
  L.push('');
  if (!outcome.registryMisses.size) L.push('None.');
  else {
    L.push(
      'These names appear in the fixtures but not on the Saturday/Sunday "Teams per division and grounds" lists or the affiliation forms. They will be shown exactly as written. Please confirm each is a real, separate ground (and its address if possible), or tell us which listed ground it is.',
    );
    L.push('');
    L.push('| Venue as written | Fixtures | Which ground is this? |');
    L.push('|---|---:|---|');
    for (const [name, m] of [...outcome.registryMisses].sort((a, b) => a[0].localeCompare(b[0])))
      L.push(`| ${name} | ${m.count} | |`);
  }
  L.push('');
  L.push('## 5. Ground names we have treated as the same ground (please confirm)');
  L.push('');
  L.push(
    'Different documents spell some grounds differently. We merged the following because the fixtures use one name where the grounds lists or affiliation forms use another. If any of these are actually different grounds, please tell us.',
  );
  L.push('');
  for (const v of LIONS_VENUES.filter((x) => x.inferred)) L.push(`- **${v.name}**: ${v.inferred}`);
  L.push('');
  const shared = crossCompetitionSameDay(built);
  L.push('## 6. Grounds shared on one day by different competitions at different start times');
  L.push('');
  if (!shared.length) L.push('None.');
  else {
    L.push(
      'These are not treated as clashes because the start times differ. Please confirm the earlier match will finish before the later one starts.',
    );
    L.push('');
    for (const s of shared) {
      L.push(`- **${s.ground}, ${longDate(s.date)}**`);
      for (const e of s.entries) L.push(`  - ${e}`);
    }
  }
  L.push('');
  L.push('## 7. All grounds in use (for pitch counts)');
  L.push('');
  L.push('| Ground | Fixtures scheduled | Pitches (if more than 1) |');
  L.push('|---|---:|---|');
  for (const [g, n] of [...usage].sort((a, b) => a[0].localeCompare(b[0])))
    L.push(`| ${g} | ${n} | |`);
  L.push('');
  void venues;
  return L.join('\n');
}

// ───────────────────────── CLI ─────────────────────────

export interface Args {
  mode: 'import' | 'revert';
  file: string;
  sundayGrounds: string;
  saturdayGrounds: string;
  affiliation: string;
  parseOnly: boolean;
  confirm: boolean;
  all: boolean;
  only: string[];
  questionsOut: string;
  noClubSync: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: 'import',
    ...DEFAULT_PATHS,
    parseOnly: false,
    confirm: false,
    all: false,
    only: [],
    questionsOut: '',
    noClubSync: false,
  };
  const need = (i: number, flag: string) => {
    const v = argv[i];
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = need(++i, a);
    else if (a === '--sunday-grounds') args.sundayGrounds = need(++i, a);
    else if (a === '--saturday-grounds') args.saturdayGrounds = need(++i, a);
    else if (a === '--affiliation') args.affiliation = need(++i, a);
    else if (a === '--questions-out') args.questionsOut = need(++i, a);
    else if (a === '--parse-only') args.parseOnly = true;
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--revert') args.mode = 'revert';
    else if (a === '--all') args.all = true;
    else if (a === '--no-club-sync') args.noClubSync = true;
    else if (a === '--only')
      args.only = need(++i, a)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else throw new Error(`unknown flag ${a}`);
  }
  if (args.mode === 'revert' && (args.parseOnly || args.only.length || args.questionsOut))
    throw new Error('--revert takes only --all and --confirm');
  if (args.all && args.mode !== 'revert') throw new Error('--all is a --revert flag');
  if (args.parseOnly && args.confirm)
    throw new Error('--parse-only and --confirm are mutually exclusive');
  for (const slug of args.only)
    if (!KNOWN_SLUGS.includes(slug))
      throw new Error(`--only: unknown series slug "${slug}" (known: ${KNOWN_SLUGS.join(', ')})`);
  return args;
}

/** CLUB_MAP as skeletal Club records — the --parse-only stand-in for the tenant's clubs. */
function clubsFromMap(): Club[] {
  return CLUB_MAP.map((c) => ({ id: c.id, name: c.name, ground: {} }) as unknown as Club);
}

async function readWb(path: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb;
}

function printResolutions(outcome: BuildOutcome, leagueLabel: (k: string) => string) {
  console.log(`\n── Name resolution sign-off (${outcome.resolutions.size} name(s))`);
  const byLeague = new Map<string, ResolutionRow[]>();
  for (const r of outcome.resolutions.values())
    byLeague.set(r.leagueKey, [...(byLeague.get(r.leagueKey) ?? []), r]);
  for (const l of LIONS_LEAGUES) {
    const rowsFor = byLeague.get(l.key);
    if (!rowsFor) continue;
    console.log(`  [${leagueLabel(l.key)}]`);
    for (const r of rowsFor.sort((a, b) => a.raw.localeCompare(b.raw)))
      console.log(
        `    "${r.raw}" → ${r.clubName} (${r.clubId})${r.teamId !== r.clubId ? ` [${r.teamId}]` : ''}`,
      );
  }
}

function printClashes(title: string, clashes: ScanClash[]) {
  console.log(`\n── ${title}`);
  if (!clashes.length) {
    console.log('  ✓ no clashes');
    return;
  }
  const grounds = new Map<string, number>();
  for (const c of clashes) grounds.set(c.ground, (grounds.get(c.ground) ?? 0) + 1);
  console.log(
    `  ✗ ${clashes.length} clash(es) at ${grounds.size} ground(s): ${[...grounds].map(([g, n]) => `${g} ×${n}`).join(', ')}`,
  );
  for (const c of clashes)
    console.log(
      `    ${c.date} ${c.time ?? ''} ${c.ground}: ${c.seriesName} R${c.round} ${c.home} v ${c.away} ⟷ ${c.with.seriesName ?? c.with.seriesId} R${c.with.round} ${c.with.home} v ${c.with.away}`,
    );
}

async function runImport(args: Args) {
  // ── Parse (no AWS) ──
  const { sheets, errors } = parseLeagueWorkbook(await readWb(args.file));
  console.log(`League workbook: ${args.file}`);
  for (const s of sheets) {
    const tbc = s.fixtures.filter((f) => f.venue == null).length;
    const mark = s.fixtures.length === s.spec.expected ? '✓' : '✗';
    console.log(
      `  ${mark} ${s.spec.sheet.padEnd(13)} → ${LIONS_SERIES_PREFIX}${s.spec.slug}: ${s.fixtures.length}/${s.spec.expected} fixtures` +
        (s.macrocomm.length ? `, ${s.macrocomm.length} Macrocomm placeholder row(s) skipped` : '') +
        (tbc ? `, ${tbc} TBC venue(s)` : ''),
    );
    for (const w of s.warnings) console.log(`      ⚠ ${w}`);
  }
  const leagueTotal = sheets.reduce((n, s) => n + s.fixtures.length, 0);
  console.log(`  total league fixtures: ${leagueTotal} (expected ${EXPECTED_LEAGUE_FIXTURES})`);

  const t20Problems = verifyT20Pools();
  console.log(`\nT20 transcription (${T20_POOLS.length} pools, pool rounds only):`);
  for (const p of T20_POOLS)
    console.log(
      `  ${LIONS_SERIES_PREFIX}${p.slug}: ${p.fixtures.length}/${p.expected} fixtures, ${p.teams.length} teams`,
    );
  console.log(
    t20Problems.length
      ? `  ✗ ${t20Problems.length} verification problem(s):`
      : '  ✓ counts per PDF, one game per team per slot, complete round-robins — all verified',
  );
  for (const p of t20Problems) console.log(`    ${p}`);

  if (errors.length || t20Problems.length) {
    console.error(
      `\n✗ Refusing to continue — ${errors.length + t20Problems.length} parse problem(s):`,
    );
    for (const e of errors) console.error(`   ${e}`);
    process.exitCode = 1;
    return;
  }

  let inputs: SeriesInput[] = [
    ...sheets.map((s) => ({ spec: s.spec, fixtures: s.fixtures })),
    ...t20Inputs(),
  ];
  if (args.only.length) {
    inputs = inputs.filter((i) => args.only.includes(i.spec.slug));
    console.log(`\n── --only: restricted to ${inputs.length} series: ${args.only.join(', ')}`);
  }

  // ── Context: tenant (real run) or the would-be registry + CLUB_MAP (parse-only) ──
  let repo: RepoModule | null = null;
  let clubs: Club[];
  let venues: Venue[];
  let existingSeries: Series[] = [];
  let configuredLeagues = new Set<string>();
  let registryReport: RegistryReport | null = null;
  let leagueLabel = (k: string) => LIONS_LEAGUES.find((l) => l.key === k)?.label ?? k;
  if (args.parseOnly) {
    clubs = clubsFromMap();
    const grounds = [
      ...parseGroundsSheet(await readWb(args.sundayGrounds), 'Sunday'),
      ...parseGroundsSheet(await readWb(args.saturdayGrounds), 'Saturday'),
    ];
    const aff = parseAffiliationWorkbook(await readWb(args.affiliation));
    const reg = buildLionsVenueRegistry(grounds, aff.records);
    venues = reg.venues;
    registryReport = reg.report;
    console.log(
      `\nWould-be venue registry (grounds sheets + affiliation): ${venues.length} ground(s); ` +
        `${reg.report.affiliationMatched.length} affiliation facility line(s) matched, ${reg.report.affiliationUnmatched.length} not registered` +
        (reg.report.unresolvedClubs.length
          ? `; ✗ ${reg.report.unresolvedClubs.length} grounds-sheet club name(s) unresolved`
          : ''),
    );
    for (const u of reg.report.unresolvedClubs)
      console.log(`    ✗ ${u.sheetLabel} "${u.block}" row ${u.row}: "${u.rawClub}"`);
  } else {
    repo = await import('./repo.js');
    const [tenantClubs, config, tenantVenues, series] = await Promise.all([
      repo.listClubs(LIONS_TENANT),
      repo.getTenantConfig(LIONS_TENANT),
      repo.listVenues(LIONS_TENANT),
      repo.listSeries(LIONS_TENANT),
    ]);
    if (!config)
      throw new Error(`no tenant config for "${LIONS_TENANT}" — create the tenant first`);
    clubs = tenantClubs;
    venues = tenantVenues;
    existingSeries = series;
    configuredLeagues = new Set((config.leagues ?? []).map((l) => l.key));
    leagueLabel = (k: string) =>
      (config.leagues ?? []).find((l) => l.key === k)?.label ??
      LIONS_LEAGUES.find((l) => l.key === k)?.label ??
      k;
    console.log(
      `\nTenant "${LIONS_TENANT}": ${clubs.length} club(s), ${venues.length} registry venue(s), ${existingSeries.length} existing series`,
    );
    if (!venues.length)
      console.warn(
        '  ⚠ venue registry is EMPTY — run bootstrap-lions-fixture-prereqs first (every venue would be an override)',
      );
  }

  // ── Build ──
  const outcome = buildAllSeries(inputs, { clubs, venues, leagueLabel });
  printResolutions(outcome, leagueLabel);

  const totalFixtures = outcome.built.reduce((n, b) => n + b.fixtures.length, 0);
  const missCount = [...outcome.registryMisses.values()].reduce((n, m) => n + m.count, 0);
  console.log(
    `\n── Venues: ${totalFixtures} fixtures → ${outcome.locked} registry-locked, ${missCount} venueOverride (registry miss), ${outcome.tbc.length} TBC (venue-less)`,
  );
  if (outcome.registryMisses.size) {
    console.log(
      `  Registry misses (${outcome.registryMisses.size} venue string(s)) — written as venueOverride, not locked:`,
    );
    for (const [name, m] of [...outcome.registryMisses].sort((a, b) => a[0].localeCompare(b[0])))
      console.log(
        `    "${name}" ×${m.count}${m.canonical && m.canonical !== name ? ` (canonical "${m.canonical}")` : ''}`,
      );
  }
  if (outcome.tbc.length) {
    console.log(`  TBC fixtures (${outcome.tbc.length}) — no venue, excluded from the clash scan:`);
    for (const t of outcome.tbc)
      console.log(`    ${t.seriesId} ${t.fixtureId}: ${t.date} ${t.time} ${t.home} v ${t.away}`);
  }

  // ── Clash scan ──
  const builtSeries = outcome.built.map((b) => b.series);
  const builtIds = new Set(builtSeries.map((s) => String(s.id)));
  const existingOther = existingSeries.filter((s) => !builtIds.has(String(s.id)));
  const clashes = scanClashes(builtSeries, existingOther, clubs, venues);
  printClashes(
    `Season-wide venue clash scan (${args.parseOnly ? 'PROVISIONAL — would-be registry, ' : ''}capacity = registry surfaces, default 1; TBC excluded)`,
    clashes,
  );
  if (!args.parseOnly) {
    // Release-gate preview: the API's gate gives a venue-less fixture its home club's ground.
    const key = (c: ScanClash) =>
      `${c.seriesId}/${c.fixtureId}|${c.with.seriesId}/${c.with.fixtureId}`;
    const strict = new Set(clashes.map(key));
    const gateOnly = scanClashes(builtSeries, existingOther, clubs, venues, {
      includeTbc: true,
    }).filter((c) => !strict.has(key(c)));
    if (gateOnly.length)
      printClashes(
        'Release-gate preview — TBC fixtures the release gate will place at the home club ground (NON-blocking here; give them a venue before release)',
        gateOnly,
      );
  }

  if (args.questionsOut) {
    const md = renderQuestionsMarkdown({
      built: outcome.built,
      outcome,
      clashes,
      groups: slotGroups(outcome.built, venues),
      venues,
      registryReport,
      generatedAt: new Date().toISOString().slice(0, 10),
    });
    await writeFile(args.questionsOut, md);
    console.log(`\nCGL question list written: ${args.questionsOut}`);
  }

  // ── Gates ──
  const fatal: string[] = [];
  for (const n of outcome.unresolvedNames) fatal.push(`unresolved team name ${n}`);
  for (const m of outcome.mixing) fatal.push(m);
  if (!args.parseOnly)
    for (const c of outcome.missingClubs)
      fatal.push(`club "${c}" is not on the tenant — run import-lions-affiliation first`);
  if (registryReport?.unresolvedClubs.length)
    fatal.push(`${registryReport.unresolvedClubs.length} grounds-sheet club name(s) unresolved`);
  if (clashes.length)
    fatal.push(
      `${clashes.length} unresolved venue clash(es) — no --allow-clashes exists; resolve with CGL, or write clash-free series with --only`,
    );
  const missingLeagues = [...new Set(inputs.map((i) => i.spec.leagueKey))].filter(
    (k) => !configuredLeagues.has(k),
  );
  if (!args.parseOnly && missingLeagues.length) {
    const msg = `league key(s) not configured on the tenant: ${missingLeagues.join(', ')} — run bootstrap-lions-fixture-prereqs`;
    if (args.confirm) fatal.push(msg);
    else console.warn(`\n⚠ ${msg}`);
  }
  if (!args.parseOnly && args.confirm && !venues.length)
    fatal.push('venue registry is empty — run bootstrap-lions-fixture-prereqs --confirm first');
  const released = existingSeries.filter((s) => builtIds.has(String(s.id)) && s.released);
  for (const s of released)
    fatal.push(
      `${s.id} is already RELEASED — refusing to overwrite (recall it first, or leave it out with --only)`,
    );

  if (fatal.length) {
    console.error(
      `\n✗ Refusing to ${args.parseOnly ? 'pass parse-only' : 'write'} — ${fatal.length} blocker(s):`,
    );
    for (const f of fatal) console.error(`   ${f}`);
    process.exitCode = 1;
    return;
  }
  if (args.parseOnly) {
    console.log(
      '\n[parse-only] clean — nothing touched AWS. Re-run under `sst shell` without --parse-only for the tenant dry-run.',
    );
    return;
  }

  console.log(
    `\n${builtSeries.length} series to write (${totalFixtures} fixtures), all as DRAFTS unless already approved.`,
  );
  if (!args.confirm) {
    console.log('[dry-run] nothing written. Re-run with --confirm to import.');
    if (!args.noClubSync) {
      console.log('\n── Club league sync (dry-run preview):');
      const { syncClubLeaguesFromSeries } = await import('./sync-club-leagues-from-series.js');
      await syncClubLeaguesFromSeries(LIONS_TENANT, {
        confirm: false,
        only: [...builtIds],
        includeDrafts: true,
        series: builtSeries,
      });
    }
    return;
  }

  const backupPath = await backupLionsSeries(repo!);
  for (const s of builtSeries) {
    const existing = existingSeries.find((e) => e.id === s.id);
    if (existing) {
      s.approved = existing.approved ?? false;
      s.approvedAt = existing.approvedAt ?? null;
      s.version = (Number(existing.version) || 1) + 1;
    }
    await repo!.putSeries(LIONS_TENANT, s);
    console.log(
      `wrote ${s.id}  v${s.version}  (${(s.fixtures as unknown[]).length} fixtures)${existing ? ' (overwrote draft)' : ''}`,
    );
  }
  if (!args.noClubSync) {
    // Patch each participating club's `leagues` (+ multi-side rosters) from the series just
    // written — the dolphins Insights "0 clubs" bug. The sync is tenant-parameterised.
    console.log('\n── Club league sync:');
    const { syncClubLeaguesFromSeries } = await import('./sync-club-leagues-from-series.js');
    await syncClubLeaguesFromSeries(LIONS_TENANT, {
      confirm: true,
      only: [...builtIds],
      includeDrafts: true,
    });
  }
  console.log(
    `Done. Backup: ${backupPath}. Brand-new series are DRAFTS — approve and release from the admin console.`,
  );
}

async function backupLionsSeries(repo: RepoModule): Promise<string> {
  const all = await repo.listSeries(LIONS_TENANT);
  const mine = all.filter((s) => String(s.id).startsWith(LIONS_SERIES_PREFIX));
  const path = `./lions-fixtures-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(path, JSON.stringify(mine, null, 2));
  console.log(`Backup written: ${path} (${mine.length} series)`);
  return path;
}

async function runRevert(args: Args) {
  const repo = await import('./repo.js');
  const all = await repo.listSeries(LIONS_TENANT);
  const mine = all.filter((s) => {
    const id = String(s.id);
    if (!id.startsWith(LIONS_SERIES_PREFIX)) return false;
    return args.all || KNOWN_SLUGS.includes(id.slice(LIONS_SERIES_PREFIX.length));
  });
  if (!mine.length) {
    console.log('Nothing to revert.');
    return;
  }
  if (!args.all) {
    const extra = all.filter(
      (s) => String(s.id).startsWith(LIONS_SERIES_PREFIX) && !mine.includes(s),
    ).length;
    if (extra)
      console.log(
        `(${extra} other ${LIONS_SERIES_PREFIX}* series not in this manifest kept — pass --all to include them)`,
      );
  }
  if (args.confirm) await backupLionsSeries(repo);
  for (const s of mine) {
    const status = s.released ? 'RELEASED' : s.approved ? 'approved' : 'draft';
    console.log(
      `${args.confirm ? 'delete' : '[dry-run] would delete'}  ${s.id}  (${s.name} · ${status})`,
    );
    if (s.released)
      console.warn(`  ⚠ ${s.id} is RELEASED — deleting removes it from club portals immediately.`);
    if (args.confirm) await repo.deleteSeries(LIONS_TENANT, String(s.id));
  }
  console.log(
    args.confirm
      ? `Reverted ${mine.length} series.`
      : `Re-run with --confirm to delete these ${mine.length} series.`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'revert') return runRevert(args);
  return runImport(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
