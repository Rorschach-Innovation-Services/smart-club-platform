/**
 * Tenant-neutral league-ENTRY-FORM parsing — the club-side counterpart of
 * structure-parse.ts. Where the union's structure workbook says which sides the union
 * ACCEPTED into which division, a club's "Club League Entries" form says how many sides
 * the club REQUESTS per league. This module only reads the grid; it knows nothing about
 * any tenant's league keys (titans-import-map.ts's ENTRY_LEAGUE_MAP applies those, and
 * the caller fails closed on an unknown label).
 *
 * Form shape (2026-27 template, `Sheet1`): a "SENIORS" marker row, then a header row
 * ("League " | … | "2025/26 no. of Teams" | "2026/27 no. of Teams" | … | "Name of Home
 * Venue"), then one row per league until a blank row; the same again under "JUNIORS".
 * Data columns: A label, C previous-season count, D requested count, F home venue (the
 * contact cell in H is never read — it carries personal contact details).
 *
 * The union circulates the form as BIFF `.xls`, which ExcelJS cannot open — callers
 * read an `.xlsx` Save-As copy (see docs/runbooks/titans-compliance-import.md).
 */
import type ExcelJS from 'exceljs';
import { cellText } from './structure-parse.js';

export type EntryFormSection = 'SENIORS' | 'JUNIORS';

export interface EntryFormRow {
  section: EntryFormSection;
  /** Raw label cell, trimmed ("2nd League (45 Overs)"). */
  label: string;
  /** ExcelJS row number — locates the source row in reports. */
  rowNumber: number;
  /** 2025/26 count; blank/non-numeric → 0. */
  prevCount: number;
  /** 2026/27 requested count; blank/non-numeric → 0. */
  count: number;
  /** The raw requested-count cell when it was non-blank but NOT a whole number — the
   * count above is then 0, and callers should surface this rather than trust the 0. */
  countRaw?: string;
  /** Home venue cell (may be blank). */
  venue: string;
}

export interface EntryFormParse {
  /** "Name of Club" value, when the form carries one (display/cross-check only). */
  clubName?: string;
  rows: EntryFormRow[];
}

const COL = { label: 1, prevCount: 3, count: 4, venue: 6 } as const;

/** Whole-number count, or null when the cell is non-blank but not a whole number. Blank
 * → 0. Accepts a numeric cell (`2`) and a text cell (`"2"`, as the SheetJS Save-As
 * conversion produces). */
function parseCount(raw: string): number | null {
  const s = raw.trim();
  if (!s) return 0;
  if (!/^\d+(\.0+)?$/.test(s)) return null;
  return Number(s);
}

/**
 * Scan one entry-form sheet. A section starts at a "SENIORS"/"JUNIORS" marker row; its
 * table starts at the header row that follows ("League" in A); table rows run until the
 * first blank label cell. Anything outside a table (title, club details, the footer
 * "NB" note) is ignored — except "Name of Club", returned as `clubName`.
 */
export function parseEntryFormSheet(ws: ExcelJS.Worksheet): EntryFormParse {
  const rows: EntryFormRow[] = [];
  let clubName: string | undefined;
  let section: EntryFormSection | null = null;
  let inTable = false;

  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const label = cellText(row.getCell(COL.label).value).trim();
    const upper = label.toUpperCase();

    if (upper === 'NAME OF CLUB') {
      const name = cellText(row.getCell(3).value).trim();
      if (name) clubName = name;
      return;
    }
    if (upper === 'SENIORS' || upper === 'JUNIORS') {
      section = upper;
      inTable = false;
      return;
    }
    if (!section) return;
    if (!inTable) {
      // The header row: "League" in A and a "no. of Teams" heading in D.
      if (/^LEAGUE\b/.test(upper) && /NO\.? OF TEAMS/i.test(cellText(row.getCell(COL.count).value)))
        inTable = true;
      return;
    }
    if (!label) {
      // First blank label row closes the table (and the section).
      inTable = false;
      section = null;
      return;
    }
    const countText = cellText(row.getCell(COL.count).value);
    const count = parseCount(countText);
    const prevCount = parseCount(cellText(row.getCell(COL.prevCount).value));
    rows.push({
      section,
      label,
      rowNumber,
      prevCount: prevCount ?? 0,
      count: count ?? 0,
      ...(count === null ? { countRaw: countText.trim() } : {}),
      venue: cellText(row.getCell(COL.venue).value).trim(),
    });
  });

  return { clubName, rows };
}

/** Parse the entry form in a workbook — the `Sheet1` sheet of the 2026-27 template.
 * Throws if it is missing (a different template must be looked at, never guessed at). */
export function parseEntryFormWorkbook(wb: ExcelJS.Workbook): EntryFormParse {
  const ws = wb.worksheets.find((w) => w.name.trim() === 'Sheet1');
  if (!ws) {
    throw new Error(
      `sheet "Sheet1" not found in the entry form (sheets: ${wb.worksheets.map((w) => w.name).join(', ')})`,
    );
  }
  return parseEntryFormSheet(ws);
}
