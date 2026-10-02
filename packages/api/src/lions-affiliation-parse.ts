/**
 * CGL (Lions) 2026/27 affiliation Google-Form export — pure ExcelJS parser, NO AWS imports.
 *
 * Mirrors titans-contacts-parse.ts: the pure "parser" half that import-lions-affiliation.ts
 * (and, in Phase 4, import-lions-contacts.ts) consume, testable against synthetic workbooks
 * with no real PII in the repo, runnable under plain `npx tsx` for `--parse-only`.
 *
 * The source is the "Form Responses 1" sheet: headers on row 1, one response per row.
 * Columns are located by HEADER TEXT, never by position — a re-export that reorders or adds
 * columns still parses, and a missing expected header FAILS CLOSED (throws, naming it).
 *
 * Club names resolve through lions-import-map.ts (exact alias match, never fuzzy). An
 * unknown name is reported as an unresolved row, never guessed. Duplicate submissions for
 * the same club (University of Johannesburg submitted twice) are deduped keeping the LATEST
 * timestamp, and every discard is reported.
 */
import type ExcelJS from 'exceljs';
import { cellString, collapseWhitespace } from './roster-normalize.js';
import { toE164 } from './notify/e164.js';
import {
  AFFILIATION_LEAGUE_KEYS,
  normalizeDistrict,
  resolveClubName,
  type ClubMapEntry,
  type LionsDistrict,
} from './lions-import-map.js';

export const AFFILIATION_SHEET = 'Form Responses 1';

// ───────────────────────── Header detection ─────────────────────────

export type AffiliationField =
  | 'timestamp'
  | 'submitterEmail'
  | 'clubName'
  | 'district'
  | 'chairName'
  | 'chairCell'
  | 'chairEmail'
  | 'secName'
  | 'secCell'
  | 'secEmail'
  | 'leagues'
  | 'saturdayDivisions'
  | 'sundayDivisions'
  | 'clubUnavailableDates'
  | 'amountDue'
  | 'facilityCount'
  | 'mainFacility'
  | 'additionalFacilities'
  | 'groundsmanName'
  | 'groundsmanCell'
  | 'turfFields'
  | 'astroFields'
  | 'ownership'
  | 'facilityUnavailableDates'
  | 'coachesLevel1'
  | 'coachesLevel2'
  | 'coachesLevel3'
  | 'playerCount'
  | 'playerDatabase'
  | 'signedBy'
  | 'signedDate';

/** Header normalisation: uppercase, whitespace collapsed (incl. embedded newlines), a
 *  trailing colon dropped ("SIGNED BY:"). */
export function normalizeHeader(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, ' ').trim().replace(/:$/, '').trim();
}

type HeaderMatcher = { exact: string } | { prefix: string };

/** Every field the importer reads. All are REQUIRED: a form export missing any one of them
 *  is not the workbook this parser was written against. */
export const AFFILIATION_HEADERS: Record<AffiliationField, HeaderMatcher> = {
  timestamp: { exact: 'TIMESTAMP' },
  submitterEmail: { exact: 'EMAIL ADDRESS' },
  clubName: { exact: 'CLUB NAME' },
  district: { exact: 'MUNICIPAL DISTRICT' },
  chairName: { exact: 'CHAIRMAN NAME AND SURNAME' },
  chairCell: { exact: 'CHAIRMAN CELL NUMBER' },
  chairEmail: { exact: 'CHAIRMAN EMAIL ADDRESS' },
  secName: { exact: 'SECRETARY NAME AND SURNAME' },
  secCell: { exact: 'SECRETARY CELL NUMBER' },
  secEmail: { exact: 'SECRETARY EMAIL ADDRESS' },
  leagues: { exact: 'LEAGUES' },
  saturdayDivisions: { prefix: 'HOW MANY SATURDAY TEAMS' },
  sundayDivisions: { prefix: 'HOW MANY SUNDAY TEAMS' },
  clubUnavailableDates: { prefix: 'UNAVAILABLE DATES FOR THE CLUBS' },
  amountDue: { exact: 'TOTAL AMOUNT DUE TO CGL' },
  facilityCount: { exact: 'NUMBER OF FACILITIES AVAILABLE TO CLUB' },
  mainFacility: { prefix: 'NAME OF MAIN FACILITY' },
  additionalFacilities: { prefix: 'NAME OF ADDITIONAL FACILITY' },
  groundsmanName: { exact: 'HEAD GROUNDSMAN NAME' },
  groundsmanCell: { exact: 'HEAD GROUNDSMAN CONTACT NUMBER' },
  turfFields: { prefix: 'NUMBER OF TURF CRICKET FIELDS' },
  astroFields: { prefix: 'NUMBER OF ASTRO CRICKET FIELDS' },
  ownership: { exact: 'OWNERSHIP OF FACILITY' },
  facilityUnavailableDates: { prefix: 'UNAVAILABLE DATES FOR FACILITIES' },
  coachesLevel1: { prefix: 'TOTAL NUMBER OF COACHES AND LEVEL OF QUALIFICATION [LEVEL 1]' },
  coachesLevel2: { prefix: 'TOTAL NUMBER OF COACHES AND LEVEL OF QUALIFICATION [LEVEL 2]' },
  coachesLevel3: { prefix: 'TOTAL NUMBER OF COACHES AND LEVEL OF QUALIFICATION [LEVEL 3]' },
  playerCount: { exact: 'TOTAL NUMBER OF PLAYERS REGISTERED TO CLUB' },
  playerDatabase: { prefix: 'PLAYER DATABASE' },
  signedBy: { exact: 'SIGNED BY' },
  signedDate: { exact: 'DATE' },
};

/** Google Forms names an orphaned upload column "Column 52" etc.; some clubs' extra player-
 *  database uploads landed there. Optional — read for extra Drive links only. */
const EXTRA_UPLOAD_HEADER = /^COLUMN \d+$/;

function matches(m: HeaderMatcher, header: string): boolean {
  return 'exact' in m ? header === m.exact : header.startsWith(m.prefix);
}

export interface HeaderMap {
  columns: Record<AffiliationField, number>;
  /** 1-based column numbers of "Column NN" orphan-upload columns. */
  extraUploadColumns: number[];
}

/**
 * Locate every expected column on the header row. FAILS CLOSED: throws naming every
 * missing header, and on a header that matches more than one column (ambiguous).
 */
export function detectHeaders(headerCells: string[]): HeaderMap {
  const normalized = headerCells.map((h) => normalizeHeader(h));
  const columns = {} as Record<AffiliationField, number>;
  const missing: string[] = [];
  const ambiguous: string[] = [];
  for (const [field, m] of Object.entries(AFFILIATION_HEADERS) as Array<
    [AffiliationField, HeaderMatcher]
  >) {
    const hits = normalized.flatMap((h, i) => (matches(m, h) ? [i + 1] : []));
    const label = 'exact' in m ? `"${m.exact}"` : `"${m.prefix}…"`;
    if (hits.length === 0) missing.push(label);
    else if (hits.length > 1) ambiguous.push(`${label} (columns ${hits.join(', ')})`);
    else columns[field] = hits[0];
  }
  if (missing.length || ambiguous.length) {
    const parts: string[] = [];
    if (missing.length) parts.push(`missing header(s): ${missing.join(', ')}`);
    if (ambiguous.length) parts.push(`ambiguous header(s): ${ambiguous.join(', ')}`);
    throw new Error(
      `affiliation workbook header row is not the CGL 2026/27 form export — ${parts.join('; ')}`,
    );
  }
  const extraUploadColumns = normalized.flatMap((h, i) =>
    EXTRA_UPLOAD_HEADER.test(h) ? [i + 1] : [],
  );
  return { columns, extraUploadColumns };
}

// ───────────────────────── Cell normalisation ─────────────────────────

/** Bidi/zero-width marks a phone app pastes around numbers ("‪+27 82 …‬"). */
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

/** A cell → trimmed, whitespace-collapsed text with invisible marks removed. */
export function text(v: unknown): string {
  return collapseWhitespace(cellString(v).replace(INVISIBLE, ''));
}

/** Multi-line text cell → its non-empty lines, each collapsed (facility names + addresses). */
function lines(v: unknown): string[] {
  return cellString(v)
    .replace(INVISIBLE, '')
    .split(/\r?\n/)
    .map((l) => collapseWhitespace(l))
    .filter(Boolean);
}

/** Free-text "nothing here" answers the form collected. */
const EMPTY_ANSWER = /^(none|n\/a|na|nil|0|tbc|tbd|-|n\/a - see above|refer to .*)$/i;

function dateOf(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (v && typeof v === 'object' && 'result' in (v as object))
    return dateOf((v as { result: unknown }).result);
  const s = text(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

export interface NormalizedCell {
  /** The raw cell text (invisible marks stripped, whitespace collapsed). */
  raw: string;
  /** South African local form "0XXXXXXXXX" when parseable, else '' (see warning). */
  cell: string;
  /** E.164 digits (no +) via notify/e164.ts — the form the WhatsApp sender uses. */
  e164: string | null;
  /** Further numbers in the same cell ("0695937065/0798698464"), normalised the same way. */
  extra: string[];
  /** True for a parseable ZA number that is not a mobile (subscriber part not 06/07/08). */
  landline: boolean;
  /** Set when the cell had text but no usable number. */
  warning?: string;
}

/** One number → ZA local "0XXXXXXXXX", or null. Accepts +27/27 prefixes, punctuation,
 *  brackets, and a 9-digit number whose leading 0 a spreadsheet dropped. */
function localZa(raw: string): string | null {
  const digits = raw.replace(/\D+/g, '');
  if (digits.length === 11 && digits.startsWith('27')) return `0${digits.slice(2)}`;
  if (digits.length === 10 && digits.startsWith('0')) return digits;
  if (digits.length === 9 && !digits.startsWith('0')) return `0${digits}`;
  return null;
}

/**
 * Phone normalisation, same convention as the Titans contacts import: the stored `cell` is
 * a plain ZA number the senders pass through `toE164` at send time. Unlike the Titans sheet
 * (already clean local numbers) the form's free-text cells carry +27 prefixes, brackets,
 * dashes, bidi marks and occasionally two numbers, so they are canonicalised to the local
 * "0XXXXXXXXX" form here; an unusable value becomes '' with a warning (never guessed).
 */
export function normalizeCell(v: unknown): NormalizedCell {
  const raw = typeof v === 'number' ? String(v) : text(v);
  if (!raw || EMPTY_ANSWER.test(raw))
    return { raw, cell: '', e164: null, extra: [], landline: false };
  const parts = raw
    .split(/\s*(?:\/|,|;|\bor\b|&)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const normalized = parts.map(localZa);
  const [first, ...rest] = normalized;
  const extra = rest.filter((n): n is string => n !== null);
  if (!first) {
    return {
      raw,
      cell: '',
      e164: null,
      extra,
      landline: false,
      warning: `unusable number "${raw}"`,
    };
  }
  const lead = first[1];
  return {
    raw,
    cell: first,
    e164: toE164(first),
    extra,
    landline: lead !== '6' && lead !== '7' && lead !== '8',
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Trim + lowercase; '' (with a warning) when no plausible address is present. A cell with
 * several addresses ("a@x.com / b@y.com") uses the FIRST and reports the rest — one slot
 * holds one email.
 */
export function normalizeEmail(v: unknown): { email: string; extra: string[]; warning?: string } {
  const raw = text(v).toLowerCase();
  if (!raw || EMPTY_ANSWER.test(raw)) return { email: '', extra: [] };
  const parts = raw.split(/[\s/,;]+/).filter(Boolean);
  if (!parts.every((p) => EMAIL_RE.test(p)))
    return { email: '', extra: [], warning: `invalid email "${raw}"` };
  const [email, ...extra] = parts;
  return extra.length
    ? { email, extra, warning: `${parts.length} emails in one cell — first used ("${email}")` }
    : { email, extra };
}

/** A count cell: whole number, or a number word ("Two", "ONE"); null otherwise (raw kept). */
export function countOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  const s = text(v).toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  const words: Record<string, number> = {
    none: 0,
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
  };
  return words[s] ?? null;
}

// ───────────────────────── League / division tokens ─────────────────────────

/**
 * A division checkbox cell ("SA 1, SA 2, MENS VETERANS") → recognised tokens + leftover
 * free text. Google Forms joins checked boxes with ", "; an "Other" answer is free text.
 * Recognised tokens are the AFFILIATION_LEAGUE_KEYS keys; "None"/"N/A"/0 mean nothing.
 */
export function parseDivisions(v: unknown): { tokens: string[]; unrecognised: string[] } {
  const raw = typeof v === 'number' ? String(v) : text(v);
  const tokens: string[] = [];
  const unrecognised: string[] = [];
  for (const piece of raw.split(',')) {
    const t = piece.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!t || EMPTY_ANSWER.test(t)) continue;
    if (t in AFFILIATION_LEAGUE_KEYS) {
      if (!tokens.includes(t)) tokens.push(t);
    } else unrecognised.push(piece.trim());
  }
  return { tokens, unrecognised };
}

// ───────────────────────── Parsed shape ─────────────────────────

export interface AffiliationContact {
  name: string;
  cell: NormalizedCell;
  email: string;
}

export interface AffiliationRecord {
  /** Real sheet row number (for the report / operator cross-check). */
  rowNumber: number;
  timestamp: Date;
  /** CLUB NAME exactly as typed (whitespace-collapsed). */
  rawClubName: string;
  /** The CLUB_MAP club it resolved to. */
  club: ClubMapEntry;
  rawDistrict: string;
  district: LionsDistrict;
  submitterEmail: string;
  chairman: AffiliationContact;
  secretary: AffiliationContact;
  /** LEAGUES answer ("Saturday teams, Sunday teams"). */
  leaguesEntered: string;
  saturday: { tokens: string[]; unrecognised: string[] };
  sunday: { tokens: string[]; unrecognised: string[] };
  /** Number of Saturday/Sunday division entries ticked (the form's "how many teams"). */
  saturdayTeamCount: number;
  sundayTeamCount: number;
  clubUnavailableDates: string;
  facilities: {
    countRaw: string;
    count: number | null;
    /** Main facility, first line (the ground's name) + the rest (address/details). */
    mainName: string;
    mainDetails: string;
    /** Additional facility lines, '' / "None" answers dropped. */
    additional: string[];
    groundsmanName: string;
    groundsmanCell: NormalizedCell;
    turfRaw: string;
    turf: number | null;
    astroRaw: string;
    astro: number | null;
    ownership: string;
    unavailableDates: string;
  };
  coaches: { level1: string; level2: string; level3: string };
  /** TOTAL NUMBER OF PLAYERS REGISTERED TO CLUB, as typed ("98 Seniors. 120 Juniors"). */
  playerCountRaw: string;
  /** The PLAYER DATABASE Drive link ('' when none was uploaded). */
  playerDatabaseUrl: string;
  /** Further Drive links from orphaned "Column NN" upload columns. */
  extraDatabaseUrls: string[];
  signedBy: string;
  /** DATE, as an ISO date (YYYY-MM-DD), or '' when blank/unparseable. */
  signedDate: string;
  /** Per-row data-quality warnings (bad phone/email, unrecognised division text). */
  warnings: string[];
}

/** A non-blank row the parser could not turn into a record — every one fails the import. */
export interface RejectedRow {
  rowNumber: number;
  rawClubName: string;
  reason: string;
}

export interface DuplicateDiscard {
  clubId: string;
  kept: { rowNumber: number; timestamp: string; rawClubName: string };
  discarded: Array<{ rowNumber: number; timestamp: string; rawClubName: string }>;
}

export interface ParsedAffiliation {
  sheetName: string;
  /** Total non-blank response rows read (before dedupe). */
  responseCount: number;
  /** One record per club (latest submission wins), in sheet order of the kept rows. */
  records: AffiliationRecord[];
  duplicates: DuplicateDiscard[];
  rejected: RejectedRow[];
}

function contactOf(
  row: ExcelJS.Row,
  cols: Record<AffiliationField, number>,
  name: AffiliationField,
  cell: AffiliationField,
  email: AffiliationField,
  role: string,
  warnings: string[],
): AffiliationContact {
  const c = normalizeCell(row.getCell(cols[cell]).value);
  if (c.warning) warnings.push(`${role} cell: ${c.warning}`);
  const e = normalizeEmail(row.getCell(cols[email]).value);
  if (e.warning) warnings.push(`${role} email: ${e.warning}`);
  return { name: text(row.getCell(cols[name]).value), cell: c, email: e.email };
}

function driveLinks(v: unknown): string[] {
  return text(v)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

function isoDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : '';
}

/**
 * Parse the affiliation workbook. Throws when the "Form Responses 1" sheet is absent or its
 * header row is not the expected form (fail closed). Rows that cannot become a record
 * (unknown club name, unrecognised district, missing timestamp) are returned in `rejected`
 * — the CLI refuses to continue while any exist.
 */
export function parseAffiliationWorkbook(wb: ExcelJS.Workbook): ParsedAffiliation {
  const ws = wb.worksheets.find((w) => w.name.trim() === AFFILIATION_SHEET);
  if (!ws) {
    const available = wb.worksheets.map((w) => `"${w.name}"`).join(', ') || '(none)';
    throw new Error(
      `no "${AFFILIATION_SHEET}" sheet — found ${available}. Is this the CGL affiliation export?`,
    );
  }
  const headerRow = ws.getRow(1);
  const headerCells: string[] = [];
  for (let c = 1; c <= ws.columnCount; c++)
    headerCells.push(cellString(headerRow.getCell(c).value));
  const { columns: cols, extraUploadColumns } = detectHeaders(headerCells);

  const all: AffiliationRecord[] = [];
  const rejected: RejectedRow[] = [];
  let responseCount = 0;

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    let any = false;
    for (let c = 1; c <= ws.columnCount; c++) if (text(row.getCell(c).value)) any = true;
    if (!any) return;
    responseCount++;

    const rawClubName = text(row.getCell(cols.clubName).value);
    const reject = (reason: string) => rejected.push({ rowNumber, rawClubName, reason });

    const timestamp = dateOf(row.getCell(cols.timestamp).value);
    if (!timestamp) return reject('no parseable Timestamp');
    if (!rawClubName) return reject('blank CLUB NAME');
    const club = resolveClubName(rawClubName);
    if (!club) return reject(`club name not in lions-import-map CLUB_MAP aliases`);
    const rawDistrict = text(row.getCell(cols.district).value);
    const district = normalizeDistrict(rawDistrict);
    if (!district) return reject(`unrecognised MUNICIPAL DISTRICT "${rawDistrict}"`);

    const warnings: string[] = [];
    const chairman = contactOf(
      row,
      cols,
      'chairName',
      'chairCell',
      'chairEmail',
      'chairman',
      warnings,
    );
    const secretary = contactOf(row, cols, 'secName', 'secCell', 'secEmail', 'secretary', warnings);
    const saturday = parseDivisions(row.getCell(cols.saturdayDivisions).value);
    const sunday = parseDivisions(row.getCell(cols.sundayDivisions).value);
    for (const u of saturday.unrecognised) warnings.push(`Saturday division free text: "${u}"`);
    for (const u of sunday.unrecognised) warnings.push(`Sunday division free text: "${u}"`);

    const mainLines = lines(row.getCell(cols.mainFacility).value).filter(
      (l) => !EMPTY_ANSWER.test(l),
    );
    const additional = lines(row.getCell(cols.additionalFacilities).value).filter(
      (l) => !EMPTY_ANSWER.test(l) && !/^\d+$/.test(l),
    );
    const groundsmanCell = normalizeCell(row.getCell(cols.groundsmanCell).value);
    const turfCell = row.getCell(cols.turfFields).value;
    const astroCell = row.getCell(cols.astroFields).value;
    const countCell = row.getCell(cols.facilityCount).value;

    const extraDatabaseUrls = extraUploadColumns.flatMap((c) => driveLinks(row.getCell(c).value));
    const signedDate = isoDate(dateOf(row.getCell(cols.signedDate).value));

    all.push({
      rowNumber,
      timestamp,
      rawClubName,
      club,
      rawDistrict,
      district,
      submitterEmail: normalizeEmail(row.getCell(cols.submitterEmail).value).email,
      chairman,
      secretary,
      leaguesEntered: text(row.getCell(cols.leagues).value),
      saturday,
      sunday,
      saturdayTeamCount: saturday.tokens.length,
      sundayTeamCount: sunday.tokens.length,
      clubUnavailableDates: text(row.getCell(cols.clubUnavailableDates).value),
      facilities: {
        countRaw: text(countCell),
        count: countOf(countCell),
        mainName: mainLines[0] ?? '',
        mainDetails: mainLines.slice(1).join(', '),
        additional,
        groundsmanName: EMPTY_ANSWER.test(text(row.getCell(cols.groundsmanName).value))
          ? ''
          : text(row.getCell(cols.groundsmanName).value),
        groundsmanCell,
        turfRaw: text(turfCell),
        turf: countOf(turfCell),
        astroRaw: text(astroCell),
        astro: countOf(astroCell),
        ownership: text(row.getCell(cols.ownership).value),
        unavailableDates: text(row.getCell(cols.facilityUnavailableDates).value),
      },
      coaches: {
        level1: text(row.getCell(cols.coachesLevel1).value),
        level2: text(row.getCell(cols.coachesLevel2).value),
        level3: text(row.getCell(cols.coachesLevel3).value),
      },
      playerCountRaw: text(row.getCell(cols.playerCount).value),
      playerDatabaseUrl: driveLinks(row.getCell(cols.playerDatabase).value)[0] ?? '',
      extraDatabaseUrls,
      signedBy: text(row.getCell(cols.signedBy).value),
      signedDate,
      warnings,
    });
  });

  const { records, duplicates } = dedupeLatest(all);
  return { sheetName: ws.name, responseCount, records, duplicates, rejected };
}

/**
 * One record per club id: the LATEST timestamp wins (a club re-submitting the form is
 * correcting it). Every discarded submission is reported. Output keeps sheet order.
 */
export function dedupeLatest(all: AffiliationRecord[]): {
  records: AffiliationRecord[];
  duplicates: DuplicateDiscard[];
} {
  const byClub = new Map<string, AffiliationRecord[]>();
  for (const r of all) byClub.set(r.club.id, [...(byClub.get(r.club.id) ?? []), r]);
  const keep = new Set<AffiliationRecord>();
  const duplicates: DuplicateDiscard[] = [];
  const brief = (r: AffiliationRecord) => ({
    rowNumber: r.rowNumber,
    timestamp: r.timestamp.toISOString(),
    rawClubName: r.rawClubName,
  });
  for (const [clubId, rows] of byClub) {
    const sorted = [...rows].sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime() || b.rowNumber - a.rowNumber,
    );
    keep.add(sorted[0]);
    if (sorted.length > 1)
      duplicates.push({ clubId, kept: brief(sorted[0]), discarded: sorted.slice(1).map(brief) });
  }
  return { records: all.filter((r) => keep.has(r)), duplicates };
}

/** The league keys a record's ticked divisions map to (Saturday then Sunday, de-duplicated). */
export function leagueKeysOf(record: AffiliationRecord): string[] {
  const keys: string[] = [];
  for (const t of [...record.saturday.tokens, ...record.sunday.tokens]) {
    const k = AFFILIATION_LEAGUE_KEYS[t];
    if (k && !keys.includes(k)) keys.push(k);
  }
  return keys;
}
