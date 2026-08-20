/**
 * Tenant-NEUTRAL row normalization for imported player-roster spreadsheets — header
 * detection by fuzzy column-name matching (never by column index, since every club's
 * export uses a different column order/extra columns), cell coercion (exceljs richText/
 * formula/Date quirks), SA-ID cleanup, and race/gender/age-group normalization onto the
 * platform's canonical values.
 *
 * Pure and tenant-neutral on purpose — the Titans pack alone showed four distinct
 * roster templates (Adelaar/TUKS/Harlequins/Mamelodi/Soshanguve "Name·Surname·Gender·
 * Race·ID" family; Pretoria CC's "Player First Name·Player Surname·Nationality·ID
 * Number·Date of Birth·Race·Gender"; Brits' veterans-annotated variant; Adelaar's junior
 * tab, a mis-labelled private-academy export with no ID column at all) — so nothing here
 * may assume a fixed column layout. Exported so test/import-titans.test.ts can exercise
 * every branch without dynalite or a real workbook.
 */

// ───────────────────────── Cell coercion ─────────────────────────

/** exceljs cell value → plain trimmed string. Handles richText runs and {formula,result}
 * wrappers; a Date value returns '' (dates are handled by the dedicated dob helpers,
 * never stringified generically — an ISO-vs-locale mismatch would silently corrupt names
 * that happen to look date-like, which doesn't occur, but dob-typed cells routed through
 * here would). */
export function cellString(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return '';
  if (typeof v === 'object' && 'richText' in (v as object))
    return (v as { richText: Array<{ text: string }> }).richText.map((r) => r.text).join('');
  if (typeof v === 'object' && 'result' in (v as object))
    return cellString((v as { result: unknown }).result);
  return String(v).trim();
}

/** Collapse internal whitespace runs to one space and trim — names typed with double
 * spaces/tabs are common in these sheets. */
export function collapseWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/** exceljs cell value → ISO `YYYY-MM-DD`, or null. Handles a real Date cell, a
 * {formula,result} wrapper, an Excel date serial number, and a locale date STRING (some
 * rows in these sheets are typed as text instead of being date-formatted) — the string
 * path trusts JS's own Date parsing (assumes MM/DD/YYYY for slash-separated ambiguous
 * strings, its default), which is a known limitation documented in the runbook, not a
 * silent guess this module hides. */
export function cellDobIso(v: unknown): string | null {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  if (v && typeof v === 'object' && 'result' in (v as object))
    return cellDobIso((v as { result: unknown }).result);
  if (typeof v === 'number' && v > 0 && v < 60000) {
    const ms = Date.UTC(1899, 11, 30) + v * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return null;
}

// ───────────────────────── Header detection / column mapping ─────────────────────────

export type RosterField =
  | 'firstName'
  | 'lastName'
  | 'idNumber'
  | 'dob'
  | 'gender'
  | 'race'
  | 'ageGroup'
  | 'nationality'
  /** A single combined "Name & Surname" column (Centurion Kavaliers' template) — split
   * at the last whitespace run via splitFullName, never mapped alongside a separate
   * firstName/lastName pair. */
  | 'fullName';

/** Normalize a header cell for comparison: lowercase, strip a trailing parenthetical
 * remark ("ID number (Compulsory)" → "id number"), strip trailing dots ("D.O.B." →
 * "d.o.b"), collapse whitespace. A parenthetical with no closing bracket (seen verbatim
 * in the pack: "Age Group (U9, U11, U13 , u15") is left alone — callers fall back to a
 * startsWith/includes match for those. */
export function normalizeHeader(raw: string): string {
  let s = collapseWhitespace(raw).toLowerCase();
  s = s.replace(/\s*\([^)]*\)\s*$/, ''); // trailing "(...)" parenthetical, if closed
  s = s.replace(/\.+$/, ''); // trailing dot(s)
  return s.trim();
}

/** Alias lists, longest/most-specific first within each field so an exact match is
 * found before a looser fallback ever runs. `lastName`/`idNumber` are matched before
 * `firstName` at the caller level (FIELD_ORDER below) specifically so firstName's bare
 * "name" alias can never claim a "surname"/"id number" column first. */
const HEADER_ALIASES: Record<RosterField, string[]> = {
  lastName: ['player surname', 'surname', 'last name'],
  // "name & surname" / "name and surname" must be tried as fullName BEFORE firstName's
  // bare "name" alias gets a chance at it — see FIELD_ORDER.
  fullName: ['name & surname', 'name and surname', 'full name'],
  firstName: ['player first name', 'first name', 'name'],
  idNumber: ['id number', 'id no', 'idnumber', 'id'],
  dob: ['date of birth', 'dob', 'd.o.b'],
  ageGroup: ['age group'],
  gender: ['gender'],
  race: ['race'],
  nationality: ['nationality'],
};

/**
 * Matching/claiming order. `fullName` MUST be resolved before `lastName` — "Name  &
 * Surname" would otherwise fall to lastName's loose `includes('surname')` tier-3
 * fallback (a real substring of that header) and get claimed as a lastName-only column,
 * leaving firstName unresolvable and the header row rejected. `lastName`/`idNumber` are
 * still resolved before `firstName` so its generic "name" alias never steals a more
 * specific column once fullName is out of the running.
 */
const FIELD_ORDER: RosterField[] = [
  'fullName',
  'lastName',
  'idNumber',
  'firstName',
  'dob',
  'ageGroup',
  'gender',
  'race',
  'nationality',
];

export type HeaderMap = Partial<Record<RosterField, number>>;

/**
 * A matcher table for `findHeaderRow`: which fields to look for, in claiming order, what
 * aliases identify each, and what minimum shape counts as "this is a header row". Lets a
 * future committee extractor (name/surname/role/email/cell) reuse the same scan/claim
 * mechanics with its own field set, rather than roster's shape being baked into the loop.
 */
export interface HeaderFieldConfig<F extends string> {
  fieldOrder: F[];
  aliases: Record<F, string[]>;
  isHeader: (columns: Partial<Record<F, number>>) => boolean;
}

const ROSTER_HEADER_CONFIG: HeaderFieldConfig<RosterField> = {
  fieldOrder: FIELD_ORDER,
  aliases: HEADER_ALIASES,
  // A real header row always carries either a first+last name pair, or (Centurion
  // Kavaliers' template) a single combined "Name & Surname" column.
  isHeader: (columns) =>
    columns.fullName !== undefined ||
    (columns.firstName !== undefined && columns.lastName !== undefined),
};

/**
 * Locate the header row (fuzzy match on 'name'+'surname' or 'player first name') within
 * the first `maxScanRows` rows, and build a field→column map. Never matches by column
 * INDEX — every real template in the pack uses a different column order and extra
 * columns (row numbers, veterans-team annotations, school/parent-email columns), so an
 * index-based mapping would silently misread half the clubs.
 *
 * Returns `null` if no row in range looks like a header (per `fieldConfig.isHeader`) —
 * the caller reports the file as unparseable rather than guessing a header row and
 * misreading every field beneath it. `fieldConfig` defaults to the roster field set.
 */
export function findHeaderRow<F extends string = RosterField>(
  rows: string[][],
  maxScanRows = 10,
  fieldConfig: HeaderFieldConfig<F> = ROSTER_HEADER_CONFIG as unknown as HeaderFieldConfig<F>,
): { rowIndex: number; columns: Partial<Record<F, number>> } | null {
  for (let r = 0; r < Math.min(rows.length, maxScanRows); r++) {
    const normalized = rows[r].map((c) => normalizeHeader(c));
    const available = new Map<number, string>();
    normalized.forEach((text, i) => {
      if (text) available.set(i, text);
    });
    const columns: Partial<Record<F, number>> = {};
    for (const field of fieldConfig.fieldOrder) {
      const col = matchColumn(available, fieldConfig.aliases[field]);
      if (col !== undefined) {
        columns[field] = col;
        available.delete(col);
      }
    }
    if (fieldConfig.isHeader(columns)) return { rowIndex: r, columns };
  }
  return null;
}

/** Split a combined "Name & Surname" cell at its LAST whitespace run: everything after
 * is the surname, everything before is the first name(s) — the common convention for a
 * single-column full name, and the only reversible rule when the club may have compound
 * first names ("Van Schalkwyk Luke" would split wrong under a first-token rule but
 * correctly under this one only when the surname itself is single-word; documented as a
 * known limitation, not silently "fixed" further — there is no reliable way to tell a
 * compound surname from a compound first name without a name-parts dictionary). */
export function splitFullName(raw: string): { firstName: string; lastName: string } {
  const s = collapseWhitespace(raw);
  const idx = s.lastIndexOf(' ');
  if (idx === -1) return { firstName: s, lastName: '' };
  return { firstName: s.slice(0, idx).trim(), lastName: s.slice(idx + 1).trim() };
}

/** exact → startsWith → includes, in that order, against the available (unclaimed)
 * columns. Each tier is tried across all aliases before falling to the next, so an
 * exact match on a LATER alias always wins over a fuzzy match on an earlier one. */
function matchColumn(available: Map<number, string>, aliases: string[]): number | undefined {
  for (const alias of aliases) {
    for (const [col, text] of available) if (text === alias) return col;
  }
  for (const alias of aliases) {
    for (const [col, text] of available) if (text.startsWith(alias)) return col;
  }
  for (const alias of aliases) {
    for (const [col, text] of available) if (text.includes(alias)) return col;
  }
  return undefined;
}

// ───────────────────────── SA-ID cleanup ─────────────────────────

export type IdCleanResult =
  /** A clean 13-digit ID as typed. */
  | { kind: 'valid'; idNumber: string }
  /** A 12-digit cell (leading zero lost to numeric storage), left-padded and accepted
   * ONLY because the padded 13-digit form validates as a real date via dobFromSaId. */
  | { kind: 'padded'; idNumber: string }
  /** Not a usable ID: wrong digit count even after cleanup, or a padded/as-typed form
   * that fails the dobFromSaId date check. */
  | { kind: 'invalid'; cleaned: string }
  /** The cell holds a DATE (Date object, or a string that reads as one), not an ID
   * number — Excel-mangled and unrecoverable as an ID; the run may still use it as a
   * DOB-only identity under --allow-missing-id. */
  | { kind: 'date-mangled'; isoDate: string | null }
  /**
   * 13 digits, a real calendar date (dobFromSaId passes), but the Luhn check digit
   * (the 13th digit) doesn't match — the dominant error mode in hand-typed member
   * databases is a transposed pair of digits, which this catches but a date-plausibility
   * check alone cannot. NOT treated as usable: a wrong checksum means a wrong
   * naturalKey, silently breaking future dedup/transfers, so this is never promoted to
   * 'valid'/'padded' — callers route it to the exception report as a distinct reason
   * ('bad-id-checksum') for an operator to review, never a hard abort (real registers do
   * contain checksum typos).
   */
  | { kind: 'bad-checksum'; idNumber: string };

/**
 * Standard Luhn/mod10 checksum over the full digit string (RSA ID's 13th digit is a
 * Luhn check digit over the preceding 12) — starting from the rightmost digit (the
 * check digit itself, never doubled), doubling every second digit moving left and
 * subtracting 9 from any doubled result over 9, valid iff the total digit sum is a
 * multiple of 10.
 */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** True for a value that reads as a calendar date rather than digits — a spelled-out
 * month name, or a short numeric date with slash/dash separators (e.g. "02/03/1981",
 * "05 April 2018"). Checked BEFORE digit-extraction so a float-cell ID (which contains
 * no separators) is never misread as a date, and so a genuine date isn't corrupted by
 * having its separators stripped and digits concatenated into a fake 13-digit number. */
function looksLikeDateString(s: string): boolean {
  if (/[a-z]{3,}/i.test(s)) return true; // a month name
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(s)) return true; // DD/MM/YYYY-shaped
  if (/^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(s)) return true; // YYYY/MM/DD-shaped (seen in TUKS' junior sheet)
  return false;
}

/**
 * Clean and classify one ID-number cell. Order matters:
 * 1. A real Date cell is date-mangled outright.
 * 2. A date-SHAPED string (checked before any digit-stripping) is also date-mangled —
 *    stripping its separators first would concatenate its digits into a fake ID number.
 * 3. Otherwise: strip all whitespace (IDs are sometimes grouped, "810331 5166 08 6"),
 *    strip a trailing ".0" (a float-formatted numeric cell's artifact — stripped as its
 *    own step so the trailing zero of ".0" is never mistaken for a real ID digit), then
 *    strip any other stray punctuation (a leading '*'/'#' has been seen in the pack).
 * 4. 13 digits → validate via dobFromSaId; 12 digits → left-pad with one leading zero
 *    (a numeric-stored cell that lost its leading zero) and validate the padded form.
 *    Either length is accepted ONLY when dobFromSaId confirms a real calendar date —
 *    a well-formed-looking but bogus ID must never pass silently.
 * 5. A date-plausible 13-digit ID that fails the Luhn check digit (see luhnValid) is
 *    NEVER promoted to 'valid'/'padded' — it comes back as 'bad-checksum' so the caller
 *    can route it to the exception report rather than build a naturalKey off a likely
 *    transposed-digit typo.
 */
export function cleanIdCell(
  raw: unknown,
  dobFromSaId: (id: string) => string | null,
): IdCleanResult {
  if (raw instanceof Date) {
    const iso = Number.isNaN(raw.getTime()) ? null : raw.toISOString().slice(0, 10);
    return { kind: 'date-mangled', isoDate: iso };
  }
  const asString = cellString(raw) || (typeof raw === 'number' ? String(raw) : '');
  const trimmed = asString.trim();
  if (!trimmed) return { kind: 'invalid', cleaned: '' };
  if (looksLikeDateString(trimmed)) return { kind: 'date-mangled', isoDate: cellDobIso(raw) };

  let s = trimmed.replace(/\s+/g, '');
  if (s.endsWith('.0')) s = s.slice(0, -2);
  s = s.replace(/[^\d]/g, '');

  if (s.length === 13) {
    if (!dobFromSaId(s)) return { kind: 'invalid', cleaned: s };
    return luhnValid(s) ? { kind: 'valid', idNumber: s } : { kind: 'bad-checksum', idNumber: s };
  }
  if (s.length === 12) {
    const padded = `0${s}`;
    if (!dobFromSaId(padded)) return { kind: 'invalid', cleaned: s };
    return luhnValid(padded)
      ? { kind: 'padded', idNumber: padded }
      : { kind: 'bad-checksum', idNumber: padded };
  }
  return { kind: 'invalid', cleaned: s };
}

// ───────────────────────── Race / gender / age-group normalization ─────────────────────────

/**
 * Mirror of the GENDERS/RACES canonical lists in demographics.ts — NOT exported there
 * (module-private consts), so duplicated here rather than modifying that file (out of
 * scope for this import). KEEP IN SYNC if the canonical lists ever change.
 */
const CANONICAL_GENDERS = ['Male', 'Female', 'Non-binary'];
const CANONICAL_RACES = ['African', 'Indian', 'Coloured', 'White', 'Other'];

/** Source-specific synonym → canonical value, applied before the canonical-set check.
 * "Black" appears throughout the Titans pack (Mamelodi, Soshanguve, …) where the
 * platform's canonical set uses "African" — mapped deliberately, not left to fall
 * through as an "unknown race" every time. */
const RACE_SYNONYMS: Record<string, string> = {
  black: 'African',
  // Pretoria CC's export uses "Asian" for an ethnicity outside the four specific SA
  // categories — placed in the catch-all bucket that exists for exactly this case,
  // rather than guessing it means "Indian".
  asian: 'Other',
};

export interface NormalizeResult<T> {
  value: T | undefined;
  /** The as-typed cell text, present only when normalization failed to recognise it —
   * callers roll these into the per-club "unknown race/gender" report. */
  unknownRaw?: string;
}

/** Single-letter abbreviations seen throughout the pack (Police, TUT: "M"/"F" instead
 * of "Male"/"Female"). */
const GENDER_SYNONYMS: Record<string, string> = { m: 'Male', f: 'Female' };

export function normalizeGender(raw: string): NormalizeResult<string> {
  const s = collapseWhitespace(raw);
  if (!s) return { value: undefined };
  const synonym = GENDER_SYNONYMS[s.toLowerCase()];
  if (synonym) return { value: synonym };
  const hit = CANONICAL_GENDERS.find((g) => g.toLowerCase() === s.toLowerCase());
  if (hit) return { value: hit };
  return { value: undefined, unknownRaw: s };
}

export function normalizeRace(raw: string): NormalizeResult<string> {
  const s = collapseWhitespace(raw);
  if (!s) return { value: undefined };
  const synonym = RACE_SYNONYMS[s.toLowerCase()];
  if (synonym) return { value: synonym };
  const hit = CANONICAL_RACES.find((r) => r.toLowerCase() === s.toLowerCase());
  if (hit) return { value: hit };
  return { value: undefined, unknownRaw: s };
}

/** The Titans pack's fixed junior bands — the default `allowedKeys` for CLI callers that
 * have no per-tenant league list to derive from. */
export const DEFAULT_JUNIOR_LEAGUE_KEYS = new Set(['u9', 'u11', 'u13', 'u15']);

/**
 * Age-group cell → a league key, gated on `allowedKeys` (the tenant's actual junior
 * league keys — un-hardcoded so a self-serve tenant's own band set applies, not Titans'
 * fixed u9-u15). Tolerates every form seen in the pack: "U9", "U/11", "U 13", "Under
 * 9"/"Under 15" (Harlequins' junior sheet spells it out), a bare number with no prefix at
 * all ("13", "9" — Mamelodi/Atteridgeville's junior sheets), and DACC's "0/9"/"0/11" (a
 * mis-typed leading '0' for 'U'). A combined/ambiguous cell ("13&15", "13 & 15" —
 * Mamelodi again, apparently a player entered in two age groups) does NOT match — there
 * is no single correct league key to return, so it is reported as unknown rather than
 * guessed at; same for anything outside `allowedKeys` (e.g. a "51" that's almost
 * certainly a transposed "15" typo, or a real band the tenant simply doesn't run).
 */
export function ageGroupToLeagueKey(
  raw: string,
  allowedKeys: Set<string> = DEFAULT_JUNIOR_LEAGUE_KEYS,
): NormalizeResult<string> {
  const s = collapseWhitespace(raw).toUpperCase();
  if (!s) return { value: undefined };
  const m = s.match(/^(?:UNDER\s*|U\s*\/?\s*|0\s*\/?\s*)?(\d{1,2})$/);
  if (m) {
    const key = `u${m[1]}`;
    if (allowedKeys.has(key)) return { value: key };
  }
  return { value: undefined, unknownRaw: s };
}
