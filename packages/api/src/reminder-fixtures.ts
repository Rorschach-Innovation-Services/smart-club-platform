/**
 * The union's weekly "Summary Reminder Fixtures" workbook → a guarded fixture patch plan.
 *
 * Every week KZNCU (and EMCU) circulate a workbook finalising the coming weekend: venue
 * changes, time/date changes, postponements. This module turns that workbook into the same
 * `PatchManifest` the `patch-fixtures` CLI applies, so the operator console upload
 * (`POST /platform/tenants/:slug/fixture-amendments/preview|confirm`) and the CLI tail below
 * share one parser, one matcher and one planner:
 *
 *   1. Parser (`parseReminderGrids`) — a grid walk with running context. The sheets are
 *      human-formatted and their layouts churn (see the inline notes), so every sheet passes
 *      a structural sanity gate or is refused whole — never half-read.
 *   2. Matcher (`matchReminderRows`) — each row resolves to ONE fixture inside its own
 *      competition (mandatory scoping: the veterans sheets pair the same clubs as the senior
 *      ones on the same weekend). Per-row outcome; nothing here is fatal.
 *   3. Planner (`planReminderAmendments`) — `expect` guards from LIVE data, `set` from the
 *      sheet diff, then `planFixturePatches` in introduced-only gate mode, and a `planHash`
 *      over the COMPUTED plan (diffs, moves, gate verdict, skips, series versions).
 *
 * CLI (dry-run by default):
 *
 *   npx sst shell --stage prod -- npm --prefix packages/api run reminder-fixtures -- \
 *     --tenant dolphins --file "<reminder xlsx>" [--emit-manifest out.json] [--confirm]
 *
 *   # offline dry run against local exports (never writes):
 *   npx tsx src/reminder-fixtures.ts --tenant dolphins --file "<xlsx>" \
 *     --series-json SERIES.json --clubs-json CLUB.json --venues-json VENUE.json
 */
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildClubIndex } from './club-name-resolve.js';
import type { SheetGrid } from './emcu-fixture-map.js';
import { cellDate, cellText, cellTime } from './xlsx-cells.js';
import { resolveSheetTeam, sameTeam, sideOf } from './import-umpire-appointments.js';
import {
  canonicalJson,
  loadOffline,
  planFixturePatches,
  type DraftMove,
  type FixtureDiff,
  type PatchEntry,
  type PatchManifest,
  type PatchPlan,
  type PatchSet,
} from './patch-fixtures.js';
import {
  clashKey,
  formatClashForHumans,
  groundKey,
  JUNK_GROUND,
  venueAliasesFor,
  type Clash,
} from './venue-clash.js';
import type { Club, ScheduleChangeOrigin, Series, Venue } from './types.js';

// `./repo.js` and the medicoach writer are imported dynamically inside the CLI so the pure
// core and its unit tests load without TABLE_NAME.

// ─────────────────────────────── parser ───────────────────────────────

/** One fixture row off a reminder sheet, every text trimmed. */
export interface ReminderRow {
  /** Stable id `<sheet>:<row>` — the console's per-row skip toggles key on it. */
  rowId: string;
  sheet: string;
  /** 1-based worksheet row. */
  sheetRow: number;
  /** The competition heading the row sits under ("Veterans Premier"), or the sheet name. */
  competition: string;
  /** "A" for a "Group A:" section, when the sheet has one. */
  group?: string;
  home: string;
  away: string;
  /** ISO date from the block header (or a later restatement). */
  date: string;
  /** HH:MM — the row's own time cell, else the running block/restatement time. */
  time?: string;
  /** '' when the sheet leaves it blank (or writes TBC / the postponement marker there). */
  venue: string;
  /** The row says the match is postponed. */
  postponed?: true;
  /** The row says the match is cancelled / conceded — not supported by the upload. */
  cancelled?: true;
}

export interface SkippedSheetRow {
  sheet: string;
  sheetRow: number;
  text: string;
  reason: string;
}

export interface SheetReport {
  sheet: string;
  /** ok: rows parsed · empty: no fixture rows (e.g. a notes sheet) · refused: layout gate. */
  status: 'ok' | 'empty' | 'refused';
  reason?: string;
  fixtureRows: number;
  unrecognisedRows: number;
  /** 1-based column of the 'v' separator, when consistent. */
  vColumn?: number;
}

export interface ParsedReminderWorkbook {
  rows: ReminderRow[];
  /** Unrecognised non-blank rows of accepted sheets — info only, never fatal. */
  skippedRows: SkippedSheetRow[];
  sheets: SheetReport[];
}

/** Minimum share of a sheet's content rows that must read as fixtures (else refused). */
export const MIN_RECOGNISED_RATIO = 0.75;

const DAY_MS = 86_400_000;

// Cell readers live in xlsx-cells.ts (shared with the EMCU and umpire importers); re-exported
// here for the existing callers and tests.
export { cellDate, cellText, cellTime };

const isValueCell = (v: unknown) => cellDate(v) !== undefined || cellTime(v) !== undefined;

const V_RE = /^vs?\.?$/i;
const VENUE_LABEL_RE = /^venues?\s*:?$/i;
const VENUE_CHANGES_RE = /^venue\s+changes?\s*:?$/i;
const TIME_LABEL_RE = /^times?\s*:?$/i;
const GROUP_RE = /^group\s+([a-z0-9]+)\s*:?$/i;
const TITLE_RE = /^(summary\s+)?reminder\s+fixtures\b/i;
const FORMAT_RE = /^(t\s?20|t10|t\d{2}|one[\s-]day|\d+\s*overs?)\b/i;
const POSTPONED_RE = /postpon/i;
const CANCELLED_RE = /\b(cancel+ed|cancel|conceded|forfeit(ed)?|walk\s?over|w\/o)\b/i;
const VENUE_PLACEHOLDER_RE = /^(tbc|tba|tbd|-|—)$/i;

/** A heading row's text → competition label: "Veterans Premier: T20" → "Veterans Premier",
 * "EMCU Division 3 – Stream 1 – 2026/27 Fixtures" → "EMCU Division 3 – Stream 1". */
export function competitionLabel(text: string): string {
  return text
    .replace(/\s*[:–—-]\s*t\s?20\s*$/i, '')
    .replace(/\s*[–—-]\s*\d{4}\s*\/\s*\d{2,4}\s+fixtures\s*$/i, '')
    .replace(/\s+(reminder\s+)?fixtures\s*$/i, '')
    .replace(/\s*:\s*$/, '')
    .trim();
}

/** The competition a sheet stands for when it has no heading row: its name, cleaned. */
const sheetCompetition = (name: string) =>
  competitionLabel(name.replace(/\s*(summary\s+)?reminder\s+fixtures?\s*$/i, '')) || name.trim();

/** Every non-empty cell index of a row (cells are 1-based like exceljs; index 0 unused). */
const nonEmpty = (cells: unknown[]) =>
  cells
    .map((v, i) => ({ v, i }))
    .filter(({ v, i }) => i > 0 && (cellText(v) !== '' || isValueCell(v)));

interface BlockContext {
  date?: string;
  time?: string;
  /** Column of "Venue:", "Venue Changes:" and a per-row "Time:" in the current block. */
  venueCol?: number;
  venueChangesCol?: number;
  timeCol?: number;
}

/**
 * Walk one sheet. Row kinds, in the order they are tested:
 *   - block header: a "Venue:" cell — sets date (calendar cell), time (time cell, or a
 *     "Time:" label meaning each row carries its own), and the venue column(s);
 *   - fixture row: a lone 'v' cell — home is the nearest text left of it, away the nearest
 *     text right of it, venue the block's venue column ("Venue Changes:" wins when filled);
 *   - restatement: no text, just a time (and maybe a date) — updates the running context;
 *   - group header ("Group A:"), heading (one distinct text, merged cells repeat it): the
 *     workbook title and format lines ("T20 – One Round League") are ignored, anything else
 *     names the competition for the rows below and resets the block context.
 * Anything else non-blank is unrecognised.
 */
function parseSheet(grid: SheetGrid): {
  rows: ReminderRow[];
  unrecognised: SkippedSheetRow[];
  vCols: Set<number>;
} {
  const rows: ReminderRow[] = [];
  const unrecognised: SkippedSheetRow[] = [];
  const vCols = new Set<number>();
  let competition = '';
  let group: string | undefined;
  let ctx: BlockContext = {};
  const skip = (row: number, cells: unknown[], reason: string) =>
    unrecognised.push({
      sheet: grid.name,
      sheetRow: row,
      text: nonEmpty(cells)
        .map(({ v }) => cellText(v) || String(cellDate(v) ?? cellTime(v) ?? ''))
        .join(' | ')
        .slice(0, 200),
      reason,
    });

  for (const { row, cells } of grid.rows) {
    const filled = nonEmpty(cells);
    if (!filled.length) continue;
    const texts = filled.map(({ v, i }) => ({ i, t: isValueCell(v) ? '' : cellText(v) }));

    // Block header.
    const venueLabel = texts.find(({ t }) => VENUE_LABEL_RE.test(t));
    if (venueLabel) {
      const date = filled.map(({ v }) => cellDate(v)).find(Boolean);
      const time = filled.map(({ v }) => cellTime(v)).find(Boolean);
      const timeLabel = texts.find(({ t }) => TIME_LABEL_RE.test(t));
      ctx = {
        date: date ?? ctx.date,
        time: time ?? (timeLabel ? undefined : ctx.time),
        venueCol: venueLabel.i,
        venueChangesCol: texts.find(({ t }) => VENUE_CHANGES_RE.test(t))?.i,
        timeCol: timeLabel?.i,
      };
      if (!ctx.date) skip(row, cells, 'block header without a date');
      continue;
    }

    // Fixture row.
    const vIdx = texts.find(({ t }) => V_RE.test(t))?.i;
    if (vIdx !== undefined) {
      const textAt = (i: number) => (isValueCell(cells[i]) ? '' : cellText(cells[i]));
      let homeIdx: number | undefined;
      for (let i = vIdx - 1; i >= 1; i--)
        if (textAt(i)) {
          homeIdx = i;
          break;
        }
      const awayLimit =
        ctx.venueCol !== undefined && ctx.venueCol > vIdx ? ctx.venueCol : cells.length;
      let awayIdx: number | undefined;
      for (let i = vIdx + 1; i < awayLimit; i++)
        if (textAt(i)) {
          awayIdx = i;
          break;
        }
      if (homeIdx === undefined || awayIdx === undefined) {
        skip(row, cells, "a 'v' row without both teams");
        continue;
      }
      if (!ctx.date || ctx.venueCol === undefined) {
        skip(row, cells, 'fixture row before any dated "Venue:" block header');
        continue;
      }
      vCols.add(vIdx);
      const home = textAt(homeIdx);
      const away = textAt(awayIdx);
      const changed = ctx.venueChangesCol !== undefined ? textAt(ctx.venueChangesCol) : '';
      let venue = changed || textAt(ctx.venueCol);
      // Every other text cell of the row (a note column, the venue itself) may carry a marker.
      const others = texts
        .filter(({ i, t }) => t && i !== homeIdx && i !== awayIdx && i !== vIdx)
        .map(({ t }) => t);
      const postponed = others.some((t) => POSTPONED_RE.test(t));
      const cancelled = !postponed && others.some((t) => CANCELLED_RE.test(t));
      if (POSTPONED_RE.test(venue) || CANCELLED_RE.test(venue) || VENUE_PLACEHOLDER_RE.test(venue))
        venue = '';
      const ownTime =
        ctx.timeCol !== undefined
          ? cellTime(cells[ctx.timeCol])
          : filled
              .filter(({ i }) => i > homeIdx! && i < awayLimit)
              .map(({ v }) => cellTime(v))
              .find(Boolean);
      const time = ownTime ?? ctx.time;
      rows.push({
        rowId: `${grid.name}:${row}`,
        sheet: grid.name,
        sheetRow: row,
        competition: competition || sheetCompetition(grid.name),
        ...(group ? { group } : {}),
        home,
        away,
        date: ctx.date,
        ...(time ? { time } : {}),
        venue,
        ...(postponed ? { postponed: true as const } : {}),
        ...(cancelled ? { cancelled: true as const } : {}),
      });
      continue;
    }

    // Restatement: only time/date values (plus at most an empty-ish label).
    const anyText = texts.some(({ t }) => t);
    const rowTime = filled.map(({ v }) => cellTime(v)).find(Boolean);
    const rowDate = filled.map(({ v }) => cellDate(v)).find(Boolean);
    if (!anyText && (rowTime || rowDate)) {
      if (rowTime) ctx.time = rowTime;
      if (rowDate) ctx.date = rowDate;
      continue;
    }

    const distinct = [...new Set(texts.map(({ t }) => t).filter(Boolean))];
    if (distinct.length === 1 && !rowTime && !rowDate) {
      const text = distinct[0];
      const g = text.match(GROUP_RE);
      if (g) {
        group = g[1].toUpperCase();
        continue;
      }
      if (TITLE_RE.test(text) || FORMAT_RE.test(text)) continue;
      competition = competitionLabel(text);
      group = undefined;
      ctx = {};
      continue;
    }
    skip(row, cells, 'unrecognised row');
  }
  return { rows, unrecognised, vCols };
}

/**
 * Parse every sheet, each behind the structural sanity gate: the 'v' separator sits in ONE
 * column across the sheet, and at least MIN_RECOGNISED_RATIO of its content rows read as
 * fixtures. A sheet failing either is refused whole ("layout not recognised") rather than
 * half-read — misreading a column would amend real fixtures with the wrong values.
 */
export function parseReminderGrids(grids: SheetGrid[]): ParsedReminderWorkbook {
  const out: ParsedReminderWorkbook = { rows: [], skippedRows: [], sheets: [] };
  for (const grid of grids) {
    const { rows, unrecognised, vCols } = parseSheet(grid);
    const report: SheetReport = {
      sheet: grid.name,
      status: 'ok',
      fixtureRows: rows.length,
      unrecognisedRows: unrecognised.length,
      ...(vCols.size === 1 ? { vColumn: [...vCols][0] } : {}),
    };
    if (!rows.length) {
      report.status = 'empty';
      if (unrecognised.length) report.reason = 'no fixture rows recognised';
    } else if (vCols.size > 1) {
      report.status = 'refused';
      report.reason = `layout not recognised: the 'v' column varies (columns ${[...vCols]
        .sort((a, b) => a - b)
        .join(', ')})`;
    } else if (rows.length / (rows.length + unrecognised.length) < MIN_RECOGNISED_RATIO) {
      report.status = 'refused';
      report.reason = `layout not recognised: only ${rows.length} of ${rows.length + unrecognised.length} content rows read as fixtures`;
    }
    out.sheets.push(report);
    if (report.status === 'ok') {
      out.rows.push(...rows);
      out.skippedRows.push(...unrecognised);
    } else if (report.status === 'empty') {
      out.skippedRows.push(...unrecognised);
    }
  }
  return out;
}

/** exceljs workbook → grids (1-based cells, merged cells repeat their master's value). */
export function workbookGrids(wb: ExcelJS.Workbook): SheetGrid[] {
  return wb.worksheets.map((ws) => {
    const rows: SheetGrid['rows'] = [];
    const cols = Math.max(ws.columnCount, 6);
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells: unknown[] = [];
      for (let c = 1; c <= cols; c++) cells[c] = row.getCell(c).value;
      rows.push({ row: r, cells });
    }
    return { name: ws.name, rows };
  });
}

export async function parseReminderWorkbook(
  input: ExcelJS.Workbook | Buffer | Uint8Array,
): Promise<ParsedReminderWorkbook> {
  let wb: ExcelJS.Workbook;
  if (input instanceof ExcelJS.Workbook) wb = input;
  else {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(input as unknown as ArrayBuffer);
  }
  return parseReminderGrids(workbookGrids(wb));
}

// ─────────────────────────────── matcher ───────────────────────────────

/**
 * matched-change: one fixture, the sheet differs (applicable) · matched-no-change: already
 * as the sheet says · unmatched: no fixture of this pair on/near the date · ambiguous: more
 * than one candidate, or two sheet rows on one fixture (neither applies) · venue-unknown: the
 * sheet names a ground that is not in the registry · blocked: the fixture is played /
 * cancelled, or the row asks for something the upload never does · competition-unknown: the
 * row's competition maps to no series (never matched tenant-wide).
 */
export type RowOutcome =
  | 'matched-change'
  | 'matched-no-change'
  | 'unmatched'
  | 'ambiguous'
  | 'venue-unknown'
  | 'blocked'
  | 'competition-unknown';

export interface RowChange {
  field: 'date' | 'time' | 'venue' | 'status';
  before: string;
  after: string;
}

export interface RowMatch {
  row: ReminderRow;
  outcome: RowOutcome;
  reason?: string;
  warnings: string[];
  seriesId?: string;
  seriesName?: string;
  fixtureId?: string;
  /** The live fixture, for display (side NAMES, effective venue). */
  fixture?: {
    home: string;
    away: string;
    date: string;
    time: string;
    venue: string;
    status: string;
    released: boolean;
  };
  changes?: RowChange[];
  /** The patch entry this row contributes (matched-change only). */
  entry?: PatchEntry;
}

export interface CompetitionScope {
  sheet: string;
  competition: string;
  seriesIds: string[];
}

export interface MatchReminderResult {
  matches: RowMatch[];
  competitions: CompetitionScope[];
}

export interface MatchReminderOptions {
  /** `seriesId#fixtureId` of fixtures with a stored result (FIXRESULT#). */
  playedRefs?: Set<string>;
  /** Fallback window for a date amendment, in days either side of the sheet date. */
  windowDays?: number;
}

/** Words a competition label and a league name differ by without meaning a different
 * competition ("Premier Men" = "Premier League", "Premier Women" = "Premier Women's League"). */
const COMPETITION_STOP = new Set([
  'league',
  'leagues',
  'men',
  'mens',
  't20',
  'fixtures',
  'fixture',
  'reminder',
  'the',
  'of',
  'and',
]);

/** A competition label / series-name prefix as a sorted token set. */
export function competitionKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/\b\d{4}\s*\/\s*\d{2,4}\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !COMPETITION_STOP.has(w))
    .map((w) => (w === 'womens' ? 'women' : w))
    .sort()
    .join(' ');
}

/**
 * The series a competition label scopes to: those whose name, cut at its " · " segments,
 * has a leading run of segments with the same token set ("Premier Men" ↔ "Premier League ·
 * T20 · Group 2"; "EMCU Division 3 – Stream 1" ↔ "EMCU Division 3 · Stream 1 · …"; never
 * "Veterans Premier" ↔ "Premier League").
 */
export function seriesForCompetition(label: string, series: Series[]): Series[] {
  const want = competitionKey(label);
  if (!want) return [];
  return series.filter((s) => {
    const parts = String(s.name ?? '')
      .split('·')
      .map((p) => p.trim());
    for (let k = 1; k <= parts.length; k++)
      if (competitionKey(parts.slice(0, k).join(' ')) === want) return true;
    return false;
  });
}

interface LiveFixture {
  id: string;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  status?: string;
  originalDate?: string;
  venueId?: string;
  venueName?: string;
  venueOverride?: string;
  result?: unknown;
  [key: string]: unknown;
}

const PLAYED_STATUSES = new Set(['completed', 'abandoned', 'played', 'no-result']);

const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);

/** What patch-fixtures' guard compares: venueOverride || venueName, trimmed. */
const explicitVenue = (f: LiveFixture) =>
  (f.venueOverride ?? '').trim() || (f.venueName ?? '').trim();

/** The ground the fixture plays at for display/compare: explicit, else the home side's. */
function playingVenue(s: Series, f: LiveFixture, clubsById: Map<string, Club>): string {
  const explicit = explicitVenue(f);
  if (explicit) return explicit;
  const p = (s.participants ?? []).find((x) => x.teamId === f.home);
  if (p?.venue?.trim() && !JUNK_GROUND.test(p.venue.trim())) return p.venue.trim();
  const clubId = p?.clubId ?? f.home;
  const own = clubId ? clubsById.get(clubId)?.ground?.venue?.trim() : undefined;
  return own && !JUNK_GROUND.test(own) ? own : '';
}

const sideName = (s: Series, ref: string | undefined, clubsById: Map<string, Club>) =>
  !ref
    ? ''
    : ((s.participants ?? []).find((p) => p.teamId === ref)?.name ??
      clubsById.get(ref)?.name ??
      ref);

/**
 * Match each parsed row to one fixture of its OWN competition and work out the change. Pure;
 * every problem is a per-row outcome, never a throw. Two rows resolving to one fixture are
 * both `ambiguous` (one is wrong, the sheet must say which).
 */
export function matchReminderRows(
  rows: ReminderRow[],
  series: Series[],
  clubs: Club[],
  venues: Venue[],
  aliases: Record<string, string>,
  opts: MatchReminderOptions = {},
): MatchReminderResult {
  const windowDays = opts.windowDays ?? 7;
  const byNorm = buildClubIndex(clubs);
  const clubsById = new Map(clubs.map((c) => [c.id, c]));
  const venueByKey = new Map<string, Venue>();
  for (const v of venues) venueByKey.set(groundKey(v.name, aliases), v);

  const scopeCache = new Map<string, Series[]>();
  const competitions: CompetitionScope[] = [];
  const scopeFor = (row: ReminderRow) => {
    const k = `${row.sheet}\u0000${row.competition}`;
    let scoped = scopeCache.get(k);
    if (!scoped) {
      scoped = seriesForCompetition(row.competition, series);
      scopeCache.set(k, scoped);
      competitions.push({
        sheet: row.sheet,
        competition: row.competition,
        seriesIds: scoped.map((s) => String(s.id)),
      });
    }
    return scoped;
  };

  const matches: RowMatch[] = rows.map((row): RowMatch => {
    const warnings: string[] = [];
    const scoped = scopeFor(row);
    if (!scoped.length)
      return {
        row,
        outcome: 'competition-unknown',
        reason: `no series matches the competition "${row.competition}" — this section is not applied`,
        warnings,
      };
    const home = resolveSheetTeam(row.home, clubs, byNorm);
    const away = resolveSheetTeam(row.away, clubs, byNorm);
    if (!home || !away) {
      const missing = [!home && row.home, !away && row.away].filter(Boolean).join(', ');
      return { row, outcome: 'unmatched', reason: `no club for: ${missing}`, warnings };
    }
    const orient = (s: Series, f: LiveFixture): 'same' | 'reversed' | undefined => {
      const h = sideOf(s, f.home);
      const a = sideOf(s, f.away);
      if (sameTeam(home, h) && sameTeam(away, a)) return 'same';
      if (sameTeam(home, a) && sameTeam(away, h)) return 'reversed';
      return undefined;
    };
    const pair = scoped.flatMap((s) =>
      ((s.fixtures ?? []) as LiveFixture[])
        .map((f) => ({ s, f, o: orient(s, f) }))
        .filter((c): c is { s: Series; f: LiveFixture; o: 'same' | 'reversed' } => !!c.o),
    );
    let candidates = pair.filter(({ f }) => f.date === row.date);
    if (candidates.length > 1 && row.time) {
      const byTime = candidates.filter(({ f }) => f.time === row.time);
      if (byTime.length) candidates = byTime;
    }
    let dateMoved = false;
    if (!candidates.length) {
      candidates = pair.filter(
        ({ f }) => f.date && Math.abs(dayDiff(f.date, row.date)) <= windowDays,
      );
      // Same tie-break as the exact-date path before calling it ambiguous.
      if (candidates.length > 1 && row.time) {
        const byTime = candidates.filter(({ f }) => f.time === row.time);
        if (byTime.length) candidates = byTime;
      }
      dateMoved = candidates.length > 0;
    }
    if (!candidates.length) {
      const elsewhere = [...new Set(pair.map(({ f }) => f.date ?? '?'))].sort();
      return {
        row,
        outcome: 'unmatched',
        reason: elsewhere.length
          ? `no fixture for this pair within ${windowDays} days of ${row.date} (it plays on ${elsewhere.slice(0, 4).join(', ')})`
          : `no fixture for this pair in ${row.competition}`,
        warnings,
      };
    }
    if (candidates.length > 1)
      return {
        row,
        outcome: 'ambiguous',
        reason: `${candidates.length} fixtures fit: ${candidates
          .map(({ s, f }) => `${s.id}/${f.id} ${f.date ?? ''} ${f.time ?? ''}`.trim())
          .join(', ')}`,
        warnings,
      };

    const { s, f, o } = candidates[0];
    if (o === 'reversed')
      warnings.push('the sheet lists the sides the other way round — home/away NOT changed');
    const current = playingVenue(s, f, clubsById);
    const base: RowMatch = {
      row,
      outcome: 'matched-no-change',
      warnings,
      seriesId: String(s.id),
      seriesName: String(s.name ?? s.id),
      fixtureId: f.id,
      fixture: {
        home: sideName(s, f.home, clubsById),
        away: sideName(s, f.away, clubsById),
        date: f.date ?? '',
        time: f.time ?? '',
        venue: current,
        status: f.status ?? 'scheduled',
        released: s.released === true,
      },
    };

    const status = f.status ?? 'scheduled';
    const played =
      PLAYED_STATUSES.has(status) ||
      (f.result !== undefined && f.result !== null) ||
      opts.playedRefs?.has(`${s.id}#${f.id}`) === true;
    if (played)
      return { ...base, outcome: 'blocked', reason: 'the fixture has been played — not changed' };
    if (status === 'cancelled')
      return { ...base, outcome: 'blocked', reason: 'the fixture is cancelled — not changed' };
    if (row.cancelled)
      return {
        ...base,
        outcome: 'blocked',
        reason: 'the sheet marks it cancelled — cancel it in the admin console',
      };
    // Postponed with no new date: the `dateTbc` shape (the patch engine's `set.postponed`
    // alone), or an older status-only flip that never recorded the date it left.
    const undatedPostponement = status === 'postponed' && (f.dateTbc === true || !f.originalDate);

    const set: PatchSet = {};
    const changes: RowChange[] = [];
    if (row.postponed) {
      // A fixture already moved off this weekend (rescheduled, or re-dated) that the sheet
      // lists as postponed under its OLD date: the sheet is restating the postponement, never
      // asking to move it back. At most a status flip — never a backwards set.date.
      const alreadyMoved =
        dateMoved && !!f.date && (row.date === f.originalDate || dayDiff(row.date, f.date) < 0);
      if (dateMoved && !alreadyMoved) {
        set.date = row.date;
        set.postponed = true;
        changes.push({ field: 'date', before: f.date ?? '', after: row.date });
        if (status !== 'postponed')
          changes.push({ field: 'status', before: status, after: 'postponed' });
      } else if (alreadyMoved) {
        if (status !== 'postponed')
          return {
            ...base,
            reason: `listed as postponed on ${row.date}, but it already plays on ${f.date} — not changed`,
          };
      } else if (status !== 'postponed') {
        // Postponed with no new date: time/venue on the row are moot.
        set.postponed = true;
        changes.push({ field: 'status', before: status, after: 'postponed' });
      }
    } else {
      if (dateMoved) {
        set.date = row.date;
        changes.push({ field: 'date', before: f.date ?? '', after: row.date });
        if (undatedPostponement) {
          // Re-dating an undated postponement makes it a rescheduled one (books its slot).
          set.postponed = true;
          warnings.push(`postponed from ${f.date} — now rescheduled to ${row.date}`);
        }
      } else if (undatedPostponement)
        return {
          ...base,
          outcome: 'blocked',
          reason:
            'the fixture is postponed without a new date but the sheet lists it on its original date — reinstate it in the admin console',
        };
      if (row.time && row.time !== (f.time ?? '')) {
        set.time = row.time;
        changes.push({ field: 'time', before: f.time ?? '', after: row.time });
      }
      if (row.venue) {
        const sheetKey = groundKey(row.venue, aliases);
        const registry = venueByKey.get(sheetKey);
        // Compared on the EFFECTIVE ground (venueOverride || venueName, else the home side's —
        // the rule PatchExpect.venue guards on), never venueId: a stale venueId under a
        // differing override is a change, not a no-op.
        const same = current !== '' && groundKey(current, aliases) === sheetKey;
        if (!same) {
          if (!registry)
            return {
              ...base,
              outcome: 'venue-unknown',
              reason: `"${row.venue}" is not a ground in the venue list — row not applied`,
            };
          set.venueId = registry.id;
          changes.push({ field: 'venue', before: current, after: registry.name });
        }
      }
    }
    if (!changes.length) return base;
    return {
      ...base,
      outcome: 'matched-change',
      changes,
      entry: {
        seriesId: String(s.id),
        fixtureId: f.id,
        expect: {
          home: f.home ?? '',
          away: f.away ?? '',
          date: f.date ?? '',
          time: f.time ?? '',
          venue: explicitVenue(f),
        },
        set,
      },
    };
  });

  // Two rows on one fixture. Asking for the SAME change (or none) is a benign repeat: the first
  // row stands, the rest become no-ops with a note. Conflicting rows: neither applies.
  const byRef = new Map<string, RowMatch[]>();
  for (const m of matches)
    if (m.fixtureId !== undefined) {
      const k = `${m.seriesId}#${m.fixtureId}`;
      byRef.set(k, [...(byRef.get(k) ?? []), m]);
    }
  const changeSet = (m: RowMatch) =>
    m.outcome === 'matched-change' || m.outcome === 'matched-no-change'
      ? canonicalJson(m.entry?.set ?? {})
      : undefined;
  for (const group of byRef.values()) {
    if (group.length < 2) continue;
    const first = changeSet(group[0]);
    if (first !== undefined && group.every((m) => changeSet(m) === first)) {
      for (const m of group.slice(1)) {
        m.outcome = 'matched-no-change';
        m.reason = `duplicate of ${group[0].row.rowId} (same change) — applied once there`;
        delete m.entry;
        delete m.changes;
      }
      continue;
    }
    for (const m of group) {
      m.outcome = 'ambiguous';
      m.reason = `${group.length} sheet rows map to ${m.seriesId}/${m.fixtureId} (${group
        .map((g) => g.row.rowId)
        .join(', ')}) — none applied`;
      delete m.entry;
    }
  }
  return { matches, competitions };
}

// ─────────────────────────────── planner ───────────────────────────────

export interface PlanReminderInput {
  parsed: ParsedReminderWorkbook;
  series: Series[];
  clubs: Club[];
  venues: Venue[];
  aliases: Record<string, string>;
  playedRefs?: Set<string>;
  /** Row ids (`sheet:row`) the operator unticked. */
  skipRowIds?: string[];
  /** All-or-nothing: move draft fixtures off grounds a released fixture now holds. */
  relocateDraftClashes?: boolean;
  /** Recorded as the fixture's venueReason on a venue change. */
  venueReason?: string;
  /** strict = the patch-fixtures CLI rule; the upload uses `introduced` (the default here). */
  gateMode?: 'strict' | 'introduced';
}

export interface GateVerdict {
  ok: boolean;
  /** clashKeys the plan would introduce (always blocking). */
  introduced: string[];
  /** Every plan error (introduced clashes, relocation failures, guard problems). */
  errors: string[];
}

export interface ReminderPlan {
  /** The parser's per-sheet reports and unrecognised rows, carried for the preview. */
  sheets: SheetReport[];
  skippedRows: SkippedSheetRow[];
  /** The alias map the plan resolved grounds through (clash keys in the preview). */
  aliases: Record<string, string>;
  match: MatchReminderResult;
  manifest: PatchManifest;
  plan: PatchPlan;
  skipRowIds: string[];
  /** Applicable rows the operator left ticked. */
  appliedRowIds: string[];
  touchedSeriesVersions: Record<string, number>;
  gateVerdict: GateVerdict;
  planHash: string;
}

/** Every distinct date the sheet's rows name. */
const sheetDates = (rows: ReminderRow[]) => [...new Set(rows.map((r) => r.date))].sort();

/**
 * Parse result → match → guarded manifest → `planFixturePatches` (introduced-only gate by
 * default) → hash. The hash covers the COMPUTED plan — what would be written (diffs + draft
 * moves), the gate verdict, the skip set and the version of every touched series — so
 * confirm refuses whenever anything that would be written differs from what was previewed,
 * including a relocation that now lands elsewhere because of an untouched series.
 */
export function planReminderAmendments(input: PlanReminderInput): ReminderPlan {
  const skip = new Set(input.skipRowIds ?? []);
  const match = matchReminderRows(
    input.parsed.rows,
    input.series,
    input.clubs,
    input.venues,
    input.aliases,
    { playedRefs: input.playedRefs },
  );
  const applicable = match.matches.filter((m) => m.outcome === 'matched-change' && m.entry);
  const applied = applicable.filter((m) => !skip.has(m.row.rowId));
  const entries = applied.map((m) => m.entry!);
  const dates = sheetDates(input.parsed.rows);
  const relocateDates = [
    ...new Set([...dates, ...entries.map((e) => e.set.date).filter((d): d is string => !!d)]),
  ].sort();
  const manifest: PatchManifest = {
    venueReason: input.venueReason ?? 'Union reminder fixtures',
    entries,
    ...(input.relocateDraftClashes
      ? { relocateDraftClashes: { dates: relocateDates, takenBy: 'a released fixture' } }
      : {}),
  };
  const plan = planFixturePatches(
    input.series,
    input.clubs,
    input.venues,
    manifest,
    input.aliases,
    { gateMode: input.gateMode ?? 'introduced', reportDates: dates },
  );
  const byId = new Map(input.series.map((s) => [String(s.id), s]));
  const touchedSeriesVersions: Record<string, number> = {};
  for (const id of [...plan.touchedSeriesIds].sort())
    touchedSeriesVersions[id] = Number(byId.get(id)?.version ?? 0);
  const introduced = (plan.gate?.introduced ?? []).map((c) => clashKey(c, input.aliases)).sort();
  const gateVerdict: GateVerdict = {
    ok: plan.errors.length === 0,
    introduced,
    errors: [...plan.errors],
  };
  const skipRowIds = [...skip].sort();
  const planHash = reminderPlanHash({
    diffs: plan.diffs,
    moves: plan.moves,
    gateVerdict,
    skipRowIds,
    touchedSeriesVersions,
  });
  return {
    sheets: input.parsed.sheets,
    skippedRows: input.parsed.skippedRows,
    aliases: input.aliases,
    match,
    manifest,
    plan,
    skipRowIds,
    appliedRowIds: applied.map((m) => m.row.rowId),
    touchedSeriesVersions,
    gateVerdict,
    planHash,
  };
}

export function reminderPlanHash(v: {
  diffs: FixtureDiff[];
  moves: DraftMove[];
  gateVerdict: GateVerdict;
  skipRowIds: string[];
  touchedSeriesVersions: Record<string, number>;
}): string {
  return createHash('sha256').update(canonicalJson(v)).digest('hex');
}

// ─────────────────────────────── preview DTO ───────────────────────────────

/** A clash as the preview shows it (never the whole series). */
export interface ClashView {
  date: string;
  time?: string;
  ground: string;
  fixture: string;
  with: string;
}

const clashView = (c: Clash): ClashView => ({
  date: c.date,
  ...(c.time ? { time: c.time } : {}),
  ground: c.ground,
  fixture: `${c.home ?? '?'} v ${c.away ?? '?'}${c.round !== undefined ? ` (R${c.round})` : ''}`,
  with: `${c.with.seriesName ?? c.with.seriesId}: ${c.with.home ?? '?'} v ${c.with.away ?? '?'}`,
});

export interface PreviewRow {
  rowId: string;
  sheetRow: number;
  competition: string;
  group?: string;
  sheet: { home: string; away: string; date: string; time?: string; venue: string };
  outcome: RowOutcome;
  reason?: string;
  warnings: string[];
  skipped: boolean;
  seriesId?: string;
  seriesName?: string;
  fixtureId?: string;
  fixture?: RowMatch['fixture'];
  changes?: RowChange[];
}

export interface ReminderPreview {
  planHash: string;
  sheets: Array<
    SheetReport & {
      competitions: Array<{ competition: string; seriesIds: string[] }>;
      rows: PreviewRow[];
      /** matched-no-change rows, collapsed. */
      alreadyCorrect: number;
    }
  >;
  skippedRows: SkippedSheetRow[];
  counts: Record<RowOutcome, number> & { applicable: number; applied: number };
  moves: Array<{
    seriesId: string;
    seriesName: string;
    fixtureId: string;
    date: string;
    home: string;
    away: string;
    from: string;
    to: string;
    takenBy: string[];
    registryMiss: boolean;
  }>;
  gate: {
    ok: boolean;
    errors: string[];
    introduced: ClashView[];
    /** Pre-existing clashes on the sheet dates — reported, not blocking. */
    preExisting: ClashView[];
  };
  touchedSeries: Array<{ id: string; name: string; version: number }>;
  /** Filled by the route: umpire appointments on fixtures the plan touches. */
  officials?: Array<{ seriesId: string; fixtureId: string; umpires: string[]; referee?: string }>;
}

/** The slim, serialisable view of a plan — NEVER `plan.next` (the whole tenant). */
export function reminderPreview(
  rp: ReminderPlan,
  series: Series[],
  clubs: Club[] = [],
): ReminderPreview {
  const clubsById = new Map(clubs.map((c) => [c.id, c]));
  const aliases = rp.aliases;
  const introducedKeys = new Set(rp.gateVerdict.introduced);
  const skip = new Set(rp.skipRowIds);
  const seriesName = new Map(series.map((s) => [String(s.id), String(s.name ?? s.id)]));
  const counts = {
    'matched-change': 0,
    'matched-no-change': 0,
    unmatched: 0,
    ambiguous: 0,
    'venue-unknown': 0,
    blocked: 0,
    'competition-unknown': 0,
    applicable: 0,
    applied: rp.appliedRowIds.length,
  };
  for (const m of rp.match.matches) counts[m.outcome]++;
  counts.applicable = counts['matched-change'];
  const fixtureLabel = new Map<string, { home: string; away: string }>();
  for (const s of series)
    for (const f of (s.fixtures ?? []) as LiveFixture[])
      fixtureLabel.set(`${s.id}/${f.id}`, {
        home: sideName(s, f.home, clubsById),
        away: sideName(s, f.away, clubsById),
      });
  const gate = rp.plan.gate;
  return {
    planHash: rp.planHash,
    sheets: rp.sheets.map((rep) => {
      const ms = rp.match.matches.filter((m) => m.row.sheet === rep.sheet);
      return {
        ...rep,
        competitions: rp.match.competitions
          .filter((c) => c.sheet === rep.sheet)
          .map(({ competition, seriesIds }) => ({ competition, seriesIds })),
        // A no-change row WITH a reason (a benign duplicate, an already-moved postponement)
        // is listed so the note is seen; plain already-correct rows are only counted.
        alreadyCorrect: ms.filter((m) => m.outcome === 'matched-no-change' && !m.reason).length,
        rows: ms
          .filter((m) => m.outcome !== 'matched-no-change' || m.reason)
          .map((m) => ({
            rowId: m.row.rowId,
            sheetRow: m.row.sheetRow,
            competition: m.row.competition,
            ...(m.row.group ? { group: m.row.group } : {}),
            sheet: {
              home: m.row.home,
              away: m.row.away,
              date: m.row.date,
              ...(m.row.time ? { time: m.row.time } : {}),
              venue: m.row.venue,
            },
            outcome: m.outcome,
            ...(m.reason ? { reason: m.reason } : {}),
            warnings: m.warnings,
            skipped: m.outcome === 'matched-change' && skip.has(m.row.rowId),
            ...(m.seriesId ? { seriesId: m.seriesId, seriesName: m.seriesName } : {}),
            ...(m.fixtureId ? { fixtureId: m.fixtureId } : {}),
            ...(m.fixture ? { fixture: m.fixture } : {}),
            ...(m.changes ? { changes: m.changes } : {}),
          })),
      };
    }),
    skippedRows: rp.skippedRows,
    counts,
    moves: rp.plan.moves.map((m) => ({
      seriesId: m.seriesId,
      seriesName: seriesName.get(m.seriesId) ?? m.seriesId,
      fixtureId: m.fixtureId,
      date: m.date,
      home: fixtureLabel.get(`${m.seriesId}/${m.fixtureId}`)?.home ?? m.home ?? '',
      away: fixtureLabel.get(`${m.seriesId}/${m.fixtureId}`)?.away ?? m.away ?? '',
      from: m.from,
      to: m.to,
      takenBy: m.blockedBy.map((ref) => {
        const l = fixtureLabel.get(ref);
        const sid = ref.slice(0, ref.lastIndexOf('/'));
        return l ? `${seriesName.get(sid) ?? sid}: ${l.home} v ${l.away}` : ref;
      }),
      registryMiss: m.registryMiss,
    })),
    gate: {
      ok: rp.gateVerdict.ok,
      errors: rp.gateVerdict.errors,
      introduced: (gate?.introduced ?? []).map(clashView),
      // The gate's weekend lists are the AFTER state; drop what the plan itself introduces.
      preExisting: [...(gate?.weekendReleased ?? []), ...(gate?.weekendDraftOnly ?? [])]
        .filter((c) => !introducedKeys.has(clashKey(c, aliases)))
        .map(clashView),
    },
    touchedSeries: Object.entries(rp.touchedSeriesVersions).map(([id, version]) => ({
      id,
      name: seriesName.get(id) ?? id,
      version,
    })),
  };
}

// ─────────────────────────────── write ───────────────────────────────

type RepoModule = typeof import('./repo.js');
export type ReminderWriteRepo = Pick<
  RepoModule,
  'getTenantConfig' | 'putPendingSync' | 'getSeasonRun' | 'putSyncLog' | 'putSeriesIfVersion'
>;

export interface SeriesWriteResult {
  seriesId: string;
  seriesName: string;
  status: 'written' | 'drifted';
  /** The version written (written only). */
  version?: number;
  fixtureIds: string[];
}

/**
 * A written fixture now sits on a slot a fixture of a DRIFTED (unwritten) series was meant to
 * vacate — e.g. one half of a cross-series slot swap. That slot is double-booked until the
 * sheet is re-uploaded; it is a live risk, not a "apply the rest later".
 */
export interface SplitSlotRisk {
  written: { seriesId: string; fixtureId: string };
  stranded: { seriesId: string; fixtureId: string };
  ground: string;
  date: string;
  time?: string;
}

export interface ReminderWriteResult {
  results: SeriesWriteResult[];
  splitSlotRisks: SplitSlotRisk[];
}

interface SlotFixture {
  id?: string;
  date?: string;
  time?: string;
  home?: string;
  venueName?: string;
  venueOverride?: string;
  [key: string]: unknown;
}

function slotOf(
  s: Series,
  f: SlotFixture,
  clubsById: Map<string, Club>,
  aliases: Record<string, string>,
) {
  const ground = playingVenue(s, f as LiveFixture, clubsById);
  return ground && f.date
    ? { key: groundKey(ground, aliases), ground, date: f.date, time: f.time }
    : undefined;
}

/**
 * Write every touched series through `writeSeriesFromSnapshot` (version-checked against the
 * series as read, medicoach schedule diff + outbox). No pairing ever changes here, so one
 * pass per series is safe. A drifted series is skipped (others still go); any written move
 * onto a slot a stranded fixture still holds is flagged in `splitSlotRisks`.
 */
export async function writeReminderPlan(
  repo: ReminderWriteRepo,
  tenant: string,
  original: Series[],
  rp: ReminderPlan,
  clubs: Club[],
  aliases: Record<string, string>,
  opts: { origin?: ScheduleChangeOrigin; error?: (line: string) => void } = {},
): Promise<ReminderWriteResult> {
  const { writeSeriesFromSnapshot } = await import('./medicoach-sync/cli-write.js');
  const originalById = new Map(original.map((s) => [String(s.id), s]));
  const nextById = new Map(rp.plan.next.map((s) => [String(s.id), s]));
  const results: SeriesWriteResult[] = [];
  for (const id of rp.plan.touchedSeriesIds) {
    const before = originalById.get(id)!;
    const planned = structuredClone(nextById.get(id)!);
    const outcome = await writeSeriesFromSnapshot(repo, tenant, before, planned, {
      origin: opts.origin ?? 'operator-upload',
      error: opts.error,
    });
    results.push({
      seriesId: id,
      seriesName: String(before.name ?? id),
      status: outcome,
      ...(outcome === 'written' ? { version: Number(planned.version) } : {}),
      fixtureIds: rp.plan.diffs.filter((d) => d.seriesId === id).map((d) => d.fixtureId),
    });
  }

  const drifted = new Set(results.filter((r) => r.status === 'drifted').map((r) => r.seriesId));
  const splitSlotRisks: SplitSlotRisk[] = [];
  if (drifted.size) {
    const clubsById = new Map(clubs.map((c) => [c.id, c]));
    const find = (s: Series | undefined, fid: string) =>
      ((s?.fixtures ?? []) as SlotFixture[]).find((f) => f.id === fid);
    const stranded = rp.plan.diffs
      .filter((d) => drifted.has(d.seriesId))
      .map((d) => {
        const s = originalById.get(d.seriesId)!;
        return { d, slot: slotOf(s, find(s, d.fixtureId) ?? {}, clubsById, aliases) };
      });
    for (const w of rp.plan.diffs.filter((d) => !drifted.has(d.seriesId))) {
      const s = nextById.get(w.seriesId)!;
      const after = slotOf(s, find(s, w.fixtureId) ?? {}, clubsById, aliases);
      if (!after) continue;
      for (const { d, slot } of stranded) {
        if (!slot || slot.key !== after.key || slot.date !== after.date) continue;
        if (slot.time && after.time && slot.time !== after.time) continue;
        splitSlotRisks.push({
          written: { seriesId: w.seriesId, fixtureId: w.fixtureId },
          stranded: { seriesId: d.seriesId, fixtureId: d.fixtureId },
          ground: after.ground,
          date: after.date,
          ...(after.time ? { time: after.time } : {}),
        });
      }
    }
  }
  return { results, splitSlotRisks };
}

// ─────────────────────────────── CLI ───────────────────────────────

export interface ReminderCliArgs {
  tenant: string;
  file: string;
  confirm: boolean;
  emitManifest?: string;
  relocate: boolean;
  gate: 'strict' | 'introduced';
  skip: string[];
  seriesJson?: string;
  clubsJson?: string;
  venuesJson?: string;
}

export function parseReminderArgs(argv: string[]): ReminderCliArgs {
  const args: ReminderCliArgs = {
    tenant: '',
    file: '',
    confirm: false,
    relocate: false,
    gate: 'strict',
    skip: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') args.confirm = true;
    else if (a === '--relocate-draft-clashes') args.relocate = true;
    else if (a === '--tenant') args.tenant = argv[++i] ?? '';
    else if (a === '--file') args.file = argv[++i] ?? '';
    else if (a === '--emit-manifest') args.emitManifest = argv[++i];
    else if (a === '--skip') args.skip.push(argv[++i] ?? '');
    else if (a === '--gate') {
      const g = argv[++i];
      if (g !== 'strict' && g !== 'introduced')
        throw new Error('--gate must be "strict" or "introduced"');
      args.gate = g;
    } else if (a === '--series-json') args.seriesJson = argv[++i];
    else if (a === '--clubs-json') args.clubsJson = argv[++i];
    else if (a === '--venues-json') args.venuesJson = argv[++i];
    else throw new Error(`unknown flag ${a}`);
  }
  if (!args.tenant) throw new Error('--tenant <slug> is required');
  if (!args.file) throw new Error('--file <reminder xlsx> is required');
  const offline = [args.seriesJson, args.clubsJson, args.venuesJson].filter(Boolean).length;
  if (offline !== 0 && offline !== 3)
    throw new Error('offline mode needs all three of --series-json, --clubs-json, --venues-json');
  if (offline && args.confirm)
    throw new Error('offline mode (local JSON export) never writes — drop --confirm');
  return args;
}

const fmtRow = (m: RowMatch) =>
  `${m.row.rowId}  ${m.row.home} v ${m.row.away}  ${m.row.date}${m.row.time ? ' ' + m.row.time : ''}  @ ${m.row.venue || '—'}`;

/**
 * Dry run (default): parse, match, plan and print. --emit-manifest writes the patch
 * manifest `patch-fixtures` applies unchanged. --confirm writes like the operator upload
 * (version-checked, medicoach outbox) after a local backup of the touched series. The gate
 * defaults to the CLI's strict whole-weekend rule; `--gate introduced` is the upload's rule.
 */
export async function runReminderFixtures(argv: string[]): Promise<void> {
  const args = parseReminderArgs(argv);
  const { tenant } = args;
  const offline = Boolean(args.seriesJson);
  const parsed = await parseReminderWorkbook(readFileSync(args.file));

  let series: Series[];
  let clubs: Club[];
  let venues: Venue[];
  let aliases: Record<string, string>;
  let playedRefs: Set<string> | undefined;
  let repo: typeof import('./repo.js') | undefined;
  if (offline) {
    ({ series, clubs, venues } = loadOffline({
      series: args.seriesJson!,
      clubs: args.clubsJson!,
      venues: args.venuesJson!,
    }));
    aliases = venueAliasesFor(undefined);
  } else {
    repo = await import('./repo.js');
    aliases = venueAliasesFor(await repo.getTenantConfig(tenant));
    let results: Awaited<ReturnType<typeof repo.listFixtureResults>>;
    [series, clubs, venues, results] = await Promise.all([
      repo.listSeries(tenant),
      repo.listClubs(tenant),
      repo.listVenues(tenant),
      repo.listFixtureResults(tenant),
    ]);
    playedRefs = new Set(
      results.filter((r) => !r.cleared).map((r) => `${r.seriesId}#${r.fixtureId}`),
    );
  }

  console.log(
    `reminder-fixtures (${tenant}) — ${args.file} — ${offline ? 'OFFLINE ' : ''}${args.confirm ? 'CONFIRM (write)' : 'DRY-RUN'}, gate ${args.gate}\n` +
      `${series.length} series, ${clubs.length} clubs, ${venues.length} venues; ${parsed.rows.length} sheet rows\n`,
  );
  for (const sh of parsed.sheets)
    console.log(
      `  sheet "${sh.sheet}": ${sh.status}${sh.reason ? ` — ${sh.reason}` : ''} (${sh.fixtureRows} fixture rows, ${sh.unrecognisedRows} unrecognised)`,
    );
  for (const r of parsed.skippedRows)
    console.log(`  unrecognised ${r.sheet}:${r.sheetRow} — ${r.reason}: ${r.text}`);

  const rp = planReminderAmendments({
    parsed,
    series,
    clubs,
    venues,
    aliases,
    playedRefs,
    skipRowIds: args.skip,
    relocateDraftClashes: args.relocate,
    gateMode: args.gate,
  });

  console.log('\n■ Competitions');
  for (const c of rp.match.competitions)
    console.log(
      `  ${c.sheet} / ${c.competition} → ${c.seriesIds.length ? c.seriesIds.join(', ') : 'NO SERIES (refused)'}`,
    );
  const order: RowOutcome[] = [
    'matched-change',
    'matched-no-change',
    'unmatched',
    'ambiguous',
    'venue-unknown',
    'blocked',
    'competition-unknown',
  ];
  for (const outcome of order) {
    const ms = rp.match.matches.filter((m) => m.outcome === outcome);
    console.log(`\n■ ${outcome} — ${ms.length}`);
    for (const m of ms) {
      const skipped = rp.skipRowIds.includes(m.row.rowId) ? ' [SKIPPED]' : '';
      console.log(
        `  ${fmtRow(m)}${m.fixtureId ? `  → ${m.seriesId}/${m.fixtureId}` : ''}${skipped}`,
      );
      for (const c of m.changes ?? [])
        console.log(`     ${c.field}: ${c.before || '∅'} → ${c.after || '∅'}`);
      if (m.reason) console.log(`     ${m.reason}`);
      for (const w of m.warnings) console.log(`     ⚠ ${w}`);
    }
  }
  console.log(`\n■ Draft moves — ${rp.plan.moves.length}`);
  for (const m of rp.plan.moves)
    console.log(
      `  ${m.date} ${m.seriesId}/${m.fixtureId}: ${m.from} → ${m.to} (taken by ${m.blockedBy.join(', ')})`,
    );
  const g = rp.plan.gate;
  if (g) {
    console.log(
      `\n■ Gate — ${g.introduced.length} introduced, ${g.weekendReleased.length + g.weekendDraftOnly.length} clash(es) on the sheet dates after the plan`,
    );
    for (const c of g.introduced) console.log(`   NEW  ${formatClashForHumans(c)}`);
    const introducedKeys = new Set(rp.gateVerdict.introduced);
    for (const c of [...g.weekendReleased, ...g.weekendDraftOnly])
      if (!introducedKeys.has(clashKey(c, aliases)))
        console.log(`   pre-existing  ${formatClashForHumans(c)}`);
  }
  if (repo) {
    const touched = new Set(rp.plan.diffs.map((d) => `${d.seriesId}#${d.fixtureId}`));
    const officials = (await repo.listFixtureOfficials(tenant)).filter((o) =>
      touched.has(`${o.seriesId}#${o.fixtureId}`),
    );
    console.log(`\n■ FIXOFFICIALS on touched fixtures — ${officials.length}`);
    for (const o of officials) console.log(`  ${o.seriesId}/${o.fixtureId}  ${JSON.stringify(o)}`);
  }

  if (args.emitManifest) {
    await writeFile(args.emitManifest, JSON.stringify({ tenant, ...rp.manifest }, null, 2) + '\n');
    console.log(`\nManifest written: ${args.emitManifest} (${rp.manifest.entries.length} entries)`);
  }

  console.log(`\nplanHash ${rp.planHash}`);
  if (rp.plan.errors.length) {
    console.error('\nHARD ERRORS — nothing written:');
    for (const e of rp.plan.errors) console.error(`  ✗ ${e}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `${rp.plan.diffs.length} fixture change(s) across ${rp.plan.touchedSeriesIds.length} series.`,
  );
  if (!args.confirm || !repo) {
    console.log('[dry-run] nothing written. Re-run with --confirm to apply.');
    return;
  }
  if (!rp.plan.diffs.length) {
    console.log('Nothing to write.');
    return;
  }

  const byId = new Map(series.map((s) => [String(s.id), s]));
  const backupPath = fileURLToPath(
    new URL(
      `../reminder-fixtures-backup-${tenant}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      import.meta.url,
    ),
  );
  await writeFile(
    backupPath,
    JSON.stringify(
      {
        tenant,
        at: new Date().toISOString(),
        file: args.file,
        planHash: rp.planHash,
        series: rp.plan.touchedSeriesIds.map((id) => byId.get(id)!),
      },
      null,
      2,
    ),
  );
  console.log(`Backup written: ${backupPath}`);
  const out = await writeReminderPlan(repo, tenant, series, rp, clubs, aliases, { origin: 'cli' });
  for (const r of out.results)
    console.log(
      `  ${r.status === 'written' ? 'wrote' : '✗ DRIFTED'} ${r.seriesId}${r.version ? ` v${r.version}` : ''}`,
    );
  for (const k of out.splitSlotRisks)
    console.error(
      `  ✗ DOUBLE-BOOKING RISK: ${k.written.seriesId}/${k.written.fixtureId} now holds ${k.ground} ${k.date}${k.time ? ' ' + k.time : ''}, ` +
        `which unwritten ${k.stranded.seriesId}/${k.stranded.fixtureId} still occupies — re-run NOW`,
    );
  if (out.results.some((r) => r.status === 'drifted')) process.exitCode = 1;
  console.log('Done.');
}

// Run only as a script, not when imported by the tests or the API.
if (process.argv[1] && /reminder-fixtures\.(ts|js)$/.test(process.argv[1])) {
  runReminderFixtures(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
