/**
 * Tenant-neutral committee-list spreadsheet parsing (self-serve onboarding, ADR 0009
 * follow-up, plan 1.3). Reuses roster-normalize.ts's generic `findHeaderRow` with its own
 * field set — a committee export has a completely different header shape from a roster
 * (name/surname, role/position/portfolio, email, cell/phone/contact), so it gets its own
 * matcher table rather than reusing ROSTER_HEADER_CONFIG.
 *
 * The extractor is deliberately speculative: it produces CANDIDATES, not a committed
 * record. A row only becomes a candidate when its role text or email gives some signal
 * (`scoreCandidate` below) — everything else is silently skipped rather than surfaced as
 * noise. `POST .../committee-extract` NEVER invites on its own; the reps page always shows
 * these prefilled into an editable form for operator confirmation.
 */
import type ExcelJS from 'exceljs';
import {
  cellString,
  collapseWhitespace,
  findHeaderRow,
  type HeaderFieldConfig,
} from './roster-normalize.js';

/** Anchored + TLD-required, mirroring the EMAIL_RE used elsewhere in the API (index.ts) —
 *  kept as its own copy since this module is tenant-neutral and import-free of index.ts. */
const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;

/** Legacy BIFF (Excel 97-2003 .xls / .doc / .ppt — the OLE2 Compound File Binary Format)
 *  magic bytes. exceljs's `xlsx.load` only understands the OOXML zip format, so a real
 *  .xls workbook fails there with a generic parse error that reads as "corrupted" even
 *  though the file is perfectly fine — it's just the wrong (older) Excel format. Checking
 *  for this signature BEFORE handing the bytes to exceljs lets the committee-extract route
 *  give operators an accurate, actionable reason instead of blaming the file. */
const BIFF_MAGIC = [0xd0, 0xcf, 0x11, 0xe0] as const;

export function isLegacyXlsBuffer(bytes: Buffer): boolean {
  return BIFF_MAGIC.every((byte, i) => bytes[i] === byte);
}

export type CommitteeField = 'fullName' | 'surname' | 'role' | 'email' | 'cell';

const COMMITTEE_ALIASES: Record<CommitteeField, string[]> = {
  // Tried first: a combined "Name & Surname" column must claim itself before a bare
  // "Name" alias could otherwise be read as first-name-only.
  fullName: ['name & surname', 'name and surname', 'full name', 'name'],
  surname: ['surname', 'last name'],
  role: ['role', 'position', 'portfolio'],
  email: ['email', 'e-mail', 'email address'],
  cell: [
    'cell',
    'cell number',
    'cell no',
    'phone',
    'phone number',
    'contact',
    'contact number',
    'mobile',
  ],
};

const COMMITTEE_FIELD_ORDER: CommitteeField[] = ['fullName', 'surname', 'role', 'email', 'cell'];

/** A real committee header always carries a name column (full-name or a name+surname
 *  pair — surname is optional) AND a role/position column; email/cell are optional per
 *  row, so they're never part of the header shape check. */
const COMMITTEE_HEADER_CONFIG: HeaderFieldConfig<CommitteeField> = {
  fieldOrder: COMMITTEE_FIELD_ORDER,
  aliases: COMMITTEE_ALIASES,
  isHeader: (columns) => columns.fullName !== undefined && columns.role !== undefined,
};

export interface CommitteeCandidate {
  name: string;
  role: string;
  email?: string;
  cell?: string;
  confidence: 'high' | 'medium' | 'low';
  sheet: string;
  rowNumber: number;
}

/**
 * Scoring tiers: `/chair/i` (and NOT `/vice|deputy/i`) is high confidence — a plain
 * "Chairperson"/"Chair" row is almost always the club's chair. `/vice|deputy/i` is
 * medium. Any other officer row that carries a screened, well-formed email is low
 * confidence (a name only, or a role with no recognisable signal, is not a candidate at
 * all — silently skipped rather than surfaced as noise).
 */
function scoreCandidate(role: string, hasEmail: boolean): 'high' | 'medium' | 'low' | null {
  if (/vice|deputy/i.test(role)) return 'medium';
  if (/chair/i.test(role)) return 'high';
  if (hasEmail) return 'low';
  return null;
}

/** Parse one worksheet's committee rows into scored candidates. Never throws on a
 *  headerless sheet — returns an empty array, same as parseRosterSheet returning null
 *  for a sheet the caller should just skip. */
export function parseCommitteeSheet(ws: ExcelJS.Worksheet): CommitteeCandidate[] {
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  ws.eachRow((row, rowNumber) => {
    const vals: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) vals.push(cellString(row.getCell(c).value));
    rows.push(vals);
    rowNumbers.push(rowNumber);
  });
  const header = findHeaderRow(rows, 10, COMMITTEE_HEADER_CONFIG);
  if (!header) return [];
  const headerRealRowNumber = rowNumbers[header.rowIndex];

  const candidates: CommitteeCandidate[] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRealRowNumber) return; // header row and anything at/above it
    const cellAt = (col?: number): string =>
      col === undefined ? '' : collapseWhitespace(cellString(row.getCell(col + 1).value));

    const fullName = cellAt(header.columns.fullName);
    const surname = cellAt(header.columns.surname);
    const name = collapseWhitespace(surname ? `${fullName} ${surname}` : fullName);
    if (!name) return; // blank row — not a candidate, not an error

    const role = cellAt(header.columns.role);
    const rawEmail = cellAt(header.columns.email);
    const email = rawEmail && EMAIL_RE.test(rawEmail) ? rawEmail : undefined;
    const cell = cellAt(header.columns.cell);

    const confidence = scoreCandidate(role, !!email);
    if (!confidence) return; // no role/email signal at all — silently skipped

    candidates.push({
      name,
      role: role || 'Committee member',
      ...(email ? { email } : {}),
      ...(cell ? { cell } : {}),
      confidence,
      sheet: ws.name,
      rowNumber,
    });
  });
  return candidates;
}

/** Scan every sheet — a committee list may land on any tab, same manifest-free spirit as
 *  parseStructureWorkbookAllSheets. */
export function parseCommitteeWorkbookAllSheets(wb: ExcelJS.Workbook): CommitteeCandidate[] {
  return wb.worksheets.flatMap((ws) => parseCommitteeSheet(ws));
}
