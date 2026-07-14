// Write an exceljs buffer to a client-side .xlsx download. Append to the DOM
// before click() — required by older Firefox for programmatic downloads — and
// defer revocation so the download has started (revoking on the next synchronous
// line can cancel it in Firefox/Safari).
import type { Club, PlayerRegistration, PlayerStatus } from './types';

function downloadXlsx(buf: BlobPart, filename: string) {
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Populate a worksheet from an array of plain row objects (keys → column headers).
function fillSheet(ws: any, rows: Record<string, unknown>[], width: number) {
  if (rows && rows.length) {
    ws.columns = Object.keys(rows[0]).map((k) => ({ header: k, key: k, width }));
    ws.addRows(rows);
    ws.getRow(1).font = { bold: true };
  }
}

// Build a single-sheet .xlsx from row objects and trigger a download. exceljs is
// imported dynamically so it code-splits out of the main bundle (exports are
// rare, admin-only actions).
export async function exportRowsToXlsx(
  filename: string,
  sheetName: string,
  rows: Record<string, unknown>[],
) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  fillSheet(wb.addWorksheet(sheetName), rows, 18);
  downloadXlsx(await wb.xlsx.writeBuffer(), filename);
}

// Build a multi-sheet .xlsx and download it. `sheets` is an array of
// { name, rows } where rows is an array of plain row objects (keys → headers).
// Used by the affiliation-form export, where each section is its own sheet.
// Empty sheets are still added so the file structure is predictable.
export async function exportSheetsToXlsx(
  filename: string,
  sheets: { name: string; rows: Record<string, unknown>[] }[],
) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  sheets.forEach(({ name, rows }) => fillSheet(wb.addWorksheet(name), rows, 22));
  downloadXlsx(await wb.xlsx.writeBuffer(), filename);
}

// Map a club record to the export row shape shared by both admin exports. Mirrors
// the columns shown in the club directory table.
interface ClubExportHelpers {
  docCompletion: (c: Club) => number | string;
  overallProgress: (c: Club) => number | string;
  cqiBand: (score: number) => { label: string };
}
export function clubExportRow(
  c: Club,
  { docCompletion, overallProgress, cqiBand }: ClubExportHelpers,
) {
  return {
    Club: c.name,
    District: c.district || c.sub,
    Chairperson: c.chair,
    Affiliation: c.affiliation,
    'Docs %': docCompletion(c),
    'CQI Score': c.cqi,
    'CQI Band': cqiBand(c.cqi).label,
    'Overall %': overallProgress(c),
  };
}

// The admin players view injects clubName onto each row before export.
type ExportablePlayer = PlayerRegistration & { clubName?: string };

const ID_TYPE_LABEL: Record<string, string> = { 'sa-id': 'SA ID', passport: 'Passport' };
// Missing status ⇒ 'Active', mirroring playerStatusPill's default (atoms.tsx).
const STATUS_LABEL: Record<PlayerStatus, string> = {
  active: 'Active',
  'clearance-pending': 'Clearance pending',
  inactive: 'Inactive',
  'clearance-rejected': 'Clearance rejected',
};

/**
 * Map a player registration to the export row shape. Every key is ALWAYS present
 * (optionals coerced to '') because fillSheet derives its columns from the first row's
 * keys alone — a conditionally-omitted key would silently drop that column for the whole
 * sheet. resolveTeam/resolveRole are injected (their label maps live in admin.tsx).
 */
export function playerExportRow(
  p: ExportablePlayer,
  resolveTeam: (team: string | undefined) => string,
  resolveRole: (p: ExportablePlayer) => string,
) {
  return {
    'First name': p.firstName || '',
    'Last name': p.lastName || '',
    'Date of birth': p.dob || '',
    'ID type': p.idType ? ID_TYPE_LABEL[p.idType] || p.idType : '',
    'ID number': p.idNumber || '',
    Gender: p.gender || '',
    Nationality: p.nationality || '',
    Race: p.race || '',
    Cell: p.cell || '',
    Email: p.email || '',
    Guardian: p.isMinor ? p.guardianName || '' : '',
    Club: p.clubName || '',
    Team: resolveTeam(p.team) || '',
    District: p.district || '',
    Role: resolveRole(p) || '',
    Batting: p.battingHand || '',
    Bowling: p.bowlingHand || '',
    Status: p.status ? STATUS_LABEL[p.status] || p.status : 'Active',
  };
}
