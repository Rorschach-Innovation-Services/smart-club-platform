/**
 * Tenant-neutral league-structure spreadsheet parsing — moved out of
 * titans-import-map.ts (self-serve onboarding, ADR 0009 follow-up) so a future operator
 * structure-intake route can scan an unknown workbook without any Titans-specific
 * manifest. `titans-import-map.ts` keeps SECTION_LEAGUE_MAP/CLUB_MAP and enriches the
 * bare sections this module returns with a leagueKey + resolved club per row; this
 * module knows nothing about either.
 */
import type ExcelJS from 'exceljs';

/** exceljs cell value → plain trimmed string. Handles richText runs and {formula,result}
 * wrappers; a Date value returns ''. */
export function cellText(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return '';
  if (typeof v === 'object' && 'richText' in (v as object))
    return (v as { richText: Array<{ text: string }> }).richText.map((r) => r.text).join('');
  if (typeof v === 'object' && 'result' in (v as object))
    return String((v as { result: unknown }).result ?? '');
  return String(v).trim();
}

export interface RawStructureTeamRow {
  /** Raw team-name cell text, e.g. "TUKS 1". */
  raw: string;
  /** Venue cell text (may be blank). */
  venue: string;
}

export interface RawStructureSection {
  /** Raw header text, e.g. "PREMIER LEAGUE DIVISION A". */
  header: string;
  /** Sheet name this section came from. */
  sheet: string;
  rows: RawStructureTeamRow[];
}

/**
 * Grid-scan a SENIORS/JUNIORS-shaped sheet: header rows declare up to 6 (name, VENUE)
 * column pairs side by side; every row after that is data until a fresh header row is
 * hit or the sheet ends. This single scan handles every section on both sheets (SENIORS'
 * 5-, 4- and 1-column-pair blocks; JUNIORS' 6-, 5- and 4-column-pair blocks) with no
 * per-block special-casing, because a header row is identified structurally (a "VENUE"
 * cell in the next column), not by position.
 *
 * MANIFEST-FREE: every header-shaped row is emitted as its own section — this module has
 * no list of "real" section names to check a header against (that's Titans-specific,
 * applied by the caller). The one structural rule it DOES know: the SENIORS sheet
 * repeats the header shape one row directly below every real header for an "overs"
 * sub-header ("50 - OVERS" | "VENUE" | …) that carries no team data of its own — a
 * header-shaped row immediately following ANOTHER header-shaped row is exactly that
 * sub-header pattern, never a second genuine section (a real section is always preceded
 * by its predecessor's data rows, or is the sheet's first header). Such a row still gets
 * a section object (so an operator-facing caller can show/Ignore it), but it never
 * becomes the live destination for data rows — by construction it can only ever collect
 * zero rows, and the data that follows it keeps attaching to the enclosing section.
 */
export function parseStructureSheet(ws: ExcelJS.Worksheet): RawStructureSection[] {
  const sections: RawStructureSection[] = [];
  /** Live sections, one per (nameCol, venueCol) pair, cleared whenever a new (non-sub-
   * header) header row is scanned — so a data row after the last real section for a pair
   * is never mis-read as belonging to a stale one. */
  let live: Array<{ nameCol: number; venueCol: number; section: RawStructureSection }> = [];
  let previousRowWasHeader = false;

  ws.eachRow((row) => {
    const cols: string[] = [''];
    for (let c = 1; c <= ws.columnCount; c++) cols[c] = cellText(row.getCell(c).value);

    const headerPairs: number[] = [];
    for (let c = 1; c < cols.length; c++) {
      if (cols[c] && cols[c + 1]?.toUpperCase() === 'VENUE') headerPairs.push(c);
    }
    if (headerPairs.length > 0) {
      const isSubHeader = previousRowWasHeader;
      const next: typeof live = [];
      for (const c of headerPairs) {
        const header = cols[c];
        const section: RawStructureSection = { header, sheet: ws.name, rows: [] };
        sections.push(section);
        next.push({ nameCol: c, venueCol: c + 1, section });
      }
      // A barren sub-header never displaces `live` — the enclosing section (still `live`
      // from before) keeps receiving the data rows that follow.
      if (!isSubHeader) live = next;
      previousRowWasHeader = true;
      return;
    }
    previousRowWasHeader = false;

    if (live.length === 0) return;
    for (const { nameCol, venueCol, section } of live) {
      const raw = cols[nameCol];
      if (!raw) continue;
      // A stray punctuation-only artifact (e.g. a lone "`" left in an otherwise blank
      // row) is not a team — skip rather than report as an unresolved token.
      if (/^[`'".,\-–—]+$/.test(raw)) continue;
      section.rows.push({ raw, venue: cols[venueCol] ?? '' });
    }
  });

  return sections;
}

export interface StructureWorkbookScan {
  sections: RawStructureSection[];
  sheetsScanned: number;
  sheetsWithSections: number;
}

/** Scan EVERY sheet in the workbook — no sheet-name assumptions, unlike the Titans CLI's
 * fixed "SENIORS"/"JUNIORS" pair. The operator's structure-intake wizard doesn't know a
 * new client's sheet names ahead of time. */
export function parseStructureWorkbookAllSheets(wb: ExcelJS.Workbook): StructureWorkbookScan {
  let sheetsWithSections = 0;
  const sections: RawStructureSection[] = [];
  for (const ws of wb.worksheets) {
    const found = parseStructureSheet(ws);
    if (found.length > 0) sheetsWithSections++;
    sections.push(...found);
  }
  return { sections, sheetsScanned: wb.worksheets.length, sheetsWithSections };
}
