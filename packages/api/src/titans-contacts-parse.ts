/**
 * Titans club-contact workbook — pure parsing + mapping helpers, NO AWS imports.
 *
 * Mirrors titans-import-map.ts / committee-parse.ts: this is the pure "manifest + parser"
 * that import-titans-contacts.ts reads and test/titans-contacts-parse.test.ts exercises
 * directly, so `--parse-only` runs under plain `npx tsx` (no `sst shell`, no AWS creds)
 * and every branch is testable against synthetic workbooks with no real PII in the repo.
 *
 * The source is the union's "CLUB CHAIRMANS CONTACT LIST" (one sheet, columns
 * NAME | SURNAME | DESIGNATION | Cellphone | E-mail). Club sections are rows where ONLY
 * the DESIGNATION cell carries text (an uppercase club name); the people beneath a section
 * belong to that club until the next section row.
 */
import type ExcelJS from 'exceljs';
import {
  cellString,
  collapseWhitespace,
  findHeaderRow,
  type HeaderFieldConfig,
} from './roster-normalize.js';

// ───────────────────────── Header detection ─────────────────────────

export type ContactField = 'name' | 'surname' | 'designation' | 'cell' | 'email';

const CONTACT_ALIASES: Record<ContactField, string[]> = {
  surname: ['surname', 'last name'],
  designation: ['designation', 'position', 'role', 'portfolio'],
  email: ['e-mail', 'email', 'email address', 'e mail'],
  cell: [
    'cellphone',
    'cell number',
    'cellphone number',
    'cell no',
    'cell',
    'phone number',
    'contact number',
    'phone',
    'contact',
    'mobile',
  ],
  // Bare "name" is claimed LAST (see CONTACT_FIELD_ORDER) so its loose alias can never
  // steal the surname/designation columns before their own exact aliases have run.
  name: ['name'],
};

const CONTACT_FIELD_ORDER: ContactField[] = ['surname', 'designation', 'email', 'cell', 'name'];

/** A real contact-list header carries NAME + SURNAME + DESIGNATION columns; cell/email
 *  are per-row optional, so they're not part of the header-shape check. */
const CONTACT_HEADER_CONFIG: HeaderFieldConfig<ContactField> = {
  fieldOrder: CONTACT_FIELD_ORDER,
  aliases: CONTACT_ALIASES,
  isHeader: (columns) =>
    columns.name !== undefined &&
    columns.surname !== undefined &&
    columns.designation !== undefined,
};

// ───────────────────────── Parsed shape ─────────────────────────

export interface ContactPerson {
  /** First-name cell, whitespace-collapsed. */
  name: string;
  /** Surname cell, whitespace-collapsed. */
  surname: string;
  /** `${name} ${surname}` collapsed — the display name used for the invite/exco entry. */
  fullName: string;
  /** Raw designation text (kept verbatim; mapDesignation classifies it). */
  designation: string;
  /** Cellphone cell, whitespace-collapsed (may be blank — one person has no cell). */
  cell: string;
  /** E-mail cell, trimmed + lowercased. */
  email: string;
  /** The club-section header this person appeared under (uppercase, as in the sheet). */
  section: string;
  /** Real sheet row number (for the report / operator cross-check). */
  rowNumber: number;
}

/** A row that is neither blank, a section header, nor a recognisable person — surfaced so
 *  the CLI can prove every non-blank row is accounted for (zero unexplained rows). */
export interface StrayRow {
  rowNumber: number;
  /** The non-empty cells joined for a readable one-line report (no PII beyond the sheet). */
  text: string;
}

export interface ParsedContacts {
  sheetName: string;
  /** Section headers in sheet order (the uppercase club names). */
  sections: string[];
  people: ContactPerson[];
  strayRows: StrayRow[];
}

/**
 * Parse the contact workbook. Locates the sheet + header row (case/space-insensitive on
 * the NAME/SURNAME/DESIGNATION headers), then walks the rows: a row with ONLY the
 * designation filled starts a new club section; a row with any of name/surname/email is a
 * person under the current section. FAILS CLOSED — throws (naming what's missing) when no
 * sheet has a resolvable header row, so a mis-converted or wrong workbook can never parse
 * to a confidently-empty result.
 */
export function parseContactsWorkbook(wb: ExcelJS.Workbook): ParsedContacts {
  // The source sheet is named "CLUB CONTACT LIST " (trailing space); an .xls→.xlsx
  // conversion may trim that, so match on the TRIMMED name. If the sheet was renamed
  // outright, fall back to whichever sheet actually carries a contact header row.
  const named = wb.worksheets.find((w) => w.name.trim().toUpperCase() === 'CLUB CONTACT LIST');
  const candidates = named ? [named] : wb.worksheets;

  for (const ws of candidates) {
    const parsed = tryParseSheet(ws);
    if (parsed) return parsed;
  }

  const available = wb.worksheets.map((w) => `"${w.name}"`).join(', ') || '(none)';
  throw new Error(
    'no worksheet with a NAME/SURNAME/DESIGNATION contact header found — ' +
      `checked ${named ? `the "CLUB CONTACT LIST" sheet` : `all sheets (${available})`}. ` +
      'Confirm the file is the club contact list, converted to .xlsx.',
  );
}

/** Attempt to parse one worksheet; returns null when it has no contact header row. */
function tryParseSheet(ws: ExcelJS.Worksheet): ParsedContacts | null {
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  ws.eachRow((row, rowNumber) => {
    const vals: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) vals.push(cellString(row.getCell(c).value));
    rows.push(vals);
    rowNumbers.push(rowNumber);
  });

  const header = findHeaderRow(rows, 15, CONTACT_HEADER_CONFIG);
  if (!header) return null;

  const {
    name: nameCol,
    surname: surCol,
    designation: desigCol,
    cell: cellCol,
    email: emailCol,
  } = header.columns;

  const sections: string[] = [];
  const people: ContactPerson[] = [];
  const strayRows: StrayRow[] = [];
  let currentSection: string | null = null;

  const at = (cols: string[], col?: number): string =>
    col === undefined ? '' : collapseWhitespace(cols[col] ?? '');

  for (let i = header.rowIndex + 1; i < rows.length; i++) {
    const cols = rows[i];
    const rowNumber = rowNumbers[i];
    const name = at(cols, nameCol);
    const surname = at(cols, surCol);
    const designation = at(cols, desigCol);
    const cell = at(cols, cellCol);
    const email = at(cols, emailCol).toLowerCase();

    const hasPerson = !!(name || surname || email);

    if (!hasPerson && !designation && !cell) continue; // fully blank spacer row

    // Section header: ONLY the designation cell carries text.
    if (designation && !hasPerson && !cell) {
      currentSection = designation;
      sections.push(currentSection);
      continue;
    }

    if (hasPerson) {
      people.push({
        name,
        surname,
        fullName: collapseWhitespace(`${name} ${surname}`),
        designation,
        cell,
        email,
        section: currentSection ?? '',
        rowNumber,
      });
      continue;
    }

    // Neither blank, section, nor person (e.g. a stray cell-only row) — never silently
    // dropped; reported so the caller's row accounting stays honest.
    strayRows.push({
      rowNumber,
      text: [name, surname, designation, cell, email].filter(Boolean).join(' | '),
    });
  }

  return { sheetName: ws.name, sections, people, strayRows };
}

// ───────────────────────── Designation → role mapping ─────────────────────────

export type ExcoKey = 'chair' | 'vc' | 'tre' | 'sec';

export interface DesignationMapping {
  /** The single exco slot this designation claims, if any (first match on a split wins). */
  excoKey?: ExcoKey;
  /** True when the designation names a coaching role (also invited, never an exco slot). */
  coach?: boolean;
  /** True when nothing recognisable was found — the person is still invited, but flagged. */
  unmapped?: boolean;
  /** Recognised roles present in the text beyond the chosen exco slot (report-only). */
  extraRoles?: string[];
}

const VICE_RE = /vice|deputy/i;
// The typo "Chariman" (Eersterust) is covered by `chari` matching cha+[ir]{2}, and kept
// explicit besides. Vice is tested BEFORE chair below because "Vice Chairman" contains
// "Chairman".
const CHAIR_RE = /cha[ir]{2}(man|person|lady)?|chariman/i;
const TREASURER_RE = /treasurer/i;
const SECRETARY_RE = /secretar/i;
const COACH_RE = /coach|director of cricket/i;
const ADMIN_RE = /admin|manager/i;

/** The exco slot a single designation SEGMENT claims (vice before chair — see CHAIR_RE). */
function excoKeyOf(segment: string): ExcoKey | undefined {
  if (VICE_RE.test(segment)) return 'vc';
  if (CHAIR_RE.test(segment)) return 'chair';
  if (TREASURER_RE.test(segment)) return 'tre';
  if (SECRETARY_RE.test(segment)) return 'sec';
  return undefined;
}

const EXCO_LABEL: Record<ExcoKey, string> = {
  chair: 'chair',
  vc: 'vice-chair',
  tre: 'treasurer',
  sec: 'secretary',
};

/**
 * Classify a raw designation. The exco slot is decided by splitting on comma/slash and
 * taking the FIRST segment that names an exco role (so "Chairman, 1st Men, Pta 3" → chair,
 * "IVCC Director of Cricket, … Head Coach" → coach). A designation that names several roles
 * in one breath ("Vice Chairman and Treasurer") claims ONE slot (vc) — one person, one
 * slot — and the others are reported via `extraRoles`, never silently written to a second
 * slot. Everything is invited regardless of mapping; `--data-only` (a CLI concern) is what
 * suppresses the invite, not this mapper.
 */
export function mapDesignation(raw: string): DesignationMapping {
  const clean = collapseWhitespace(raw);
  const segments = clean
    .split(/[,/]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const segs = segments.length ? segments : [clean];

  let excoKey: ExcoKey | undefined;
  for (const seg of segs) {
    const k = excoKeyOf(seg);
    if (k) {
      excoKey = k;
      break;
    }
  }

  const coach = COACH_RE.test(clean);

  // Report-only: which recognised roles appear anywhere in the text. A bare "chair" only
  // counts when "vice" is absent (a "Vice Chairman" is one role, not chair + vice).
  const present: string[] = [];
  if (VICE_RE.test(clean)) present.push('vice-chair');
  if (CHAIR_RE.test(clean) && !VICE_RE.test(clean)) present.push('chair');
  if (TREASURER_RE.test(clean)) present.push('treasurer');
  if (SECRETARY_RE.test(clean)) present.push('secretary');
  const primaryLabel = excoKey ? EXCO_LABEL[excoKey] : undefined;
  const extraRoles = present.filter((r) => r !== primaryLabel);

  const mapping: DesignationMapping = {};
  if (excoKey) mapping.excoKey = excoKey;
  if (coach) mapping.coach = true;
  if (!excoKey && !coach && !ADMIN_RE.test(clean)) mapping.unmapped = true;
  if (extraRoles.length) mapping.extraRoles = extraRoles;
  return mapping;
}

// ───────────────────────── Club-section → system-club resolution ─────────────────────────

export interface LiveClub {
  id: string;
  name: string;
}

export interface ResolvedClubs {
  /** Section header → the system club it resolved to. */
  matched: Array<{ section: string; clubId: string; clubName: string }>;
  /** Section headers that matched no system club (fail-closed: never fuzzy-guessed). */
  unmatchedSections: string[];
  /** System clubs with no section in the sheet (informational — e.g. Queenswood). */
  clubsWithoutSection: LiveClub[];
}

/**
 * Normalise a club name / section header to a comparison token: uppercase, drop any
 * parenthetical ("DACC (Differently Abled Cricket Club)" → "DACC"), collapse punctuation
 * to spaces, then strip a trailing "CRICKET CLUB" / "CRICKET" / "CC" qualifier. Applied to
 * BOTH sides so "PRETORIA" (section) and "Pretoria Cricket Club" (system) meet in the middle.
 */
export function normalizeClubName(raw: string): string {
  let s = raw.toUpperCase().replace(/\([^)]*\)/g, ' ');
  s = s.replace(/[^A-Z0-9]+/g, ' ').trim();
  s = s
    .replace(/\s+CRICKET\s+CLUB$/, '')
    .replace(/\s+CRICKET$/, '')
    .replace(/\s+CC$/, '');
  return s.trim();
}

/**
 * Section-name aliases applied AFTER normalizeClubName, for sections that don't reduce to
 * their system club by normalization alone (from the verified source-data facts). Keys and
 * values are both normalized tokens. Identity entries are kept explicit as documentation of
 * a deliberately-resolved section.
 */
const SECTION_ALIASES: Record<string, string> = {
  'CBC OLD BOYS': 'CBCOB',
  'DIFFERENTLY ABLED': 'DACC',
  'HARLEQUINS SENIORS': 'HARLEQUINS',
  'IRENE VILLAGERS': 'IRENE VILLAGERS',
  POLICE: 'POLICE',
  PRETORIA: 'PRETORIA',
};

/**
 * Resolve each club section against the LIVE club list — normalize both sides, apply the
 * alias table, then EXACT-match. Never fuzzy-guesses: no exact match ⇒ the section is
 * reported unmatched (a hard blocker for --confirm unless explicitly skipped). Returns the
 * matched pairs, the unmatched sections, and the system clubs that had no section at all.
 */
export function resolveClubs(sections: string[], liveClubs: LiveClub[]): ResolvedClubs {
  const clubByToken = new Map<string, LiveClub>();
  for (const c of liveClubs) clubByToken.set(normalizeClubName(c.name), c);

  const matched: ResolvedClubs['matched'] = [];
  const unmatchedSections: string[] = [];
  const matchedClubIds = new Set<string>();

  for (const section of sections) {
    const normalized = normalizeClubName(section);
    const token = SECTION_ALIASES[normalized] ?? normalized;
    const club = clubByToken.get(token);
    if (club) {
      matched.push({ section, clubId: club.id, clubName: club.name });
      matchedClubIds.add(club.id);
    } else {
      unmatchedSections.push(section);
    }
  }

  const clubsWithoutSection = liveClubs.filter((c) => !matchedClubIds.has(c.id));
  return { matched, unmatchedSections, clubsWithoutSection };
}
