// Write an exceljs buffer to a client-side .xlsx download. Append to the DOM
// before click() — required by older Firefox for programmatic downloads — and
// defer revocation so the download has started (revoking on the next synchronous
// line can cancel it in Firefox/Safari).
function downloadXlsx(buf, filename) {
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
function fillSheet(ws, rows, width) {
  if (rows && rows.length) {
    ws.columns = Object.keys(rows[0]).map((k) => ({ header: k, key: k, width }));
    ws.addRows(rows);
    ws.getRow(1).font = { bold: true };
  }
}

// Build a single-sheet .xlsx from row objects and trigger a download. exceljs is
// imported dynamically so it code-splits out of the main bundle (exports are
// rare, admin-only actions).
export async function exportRowsToXlsx(filename, sheetName, rows) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  fillSheet(wb.addWorksheet(sheetName), rows, 18);
  downloadXlsx(await wb.xlsx.writeBuffer(), filename);
}

// Build a multi-sheet .xlsx and download it. `sheets` is an array of
// { name, rows } where rows is an array of plain row objects (keys → headers).
// Used by the affiliation-form export, where each section is its own sheet.
// Empty sheets are still added so the file structure is predictable.
export async function exportSheetsToXlsx(filename, sheets) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  sheets.forEach(({ name, rows }) => fillSheet(wb.addWorksheet(name), rows, 22));
  downloadXlsx(await wb.xlsx.writeBuffer(), filename);
}

// Map a club record to the export row shape shared by both admin exports. Mirrors
// the columns shown in the club directory table.
export function clubExportRow(c, { docCompletion, overallProgress, cqiBand }) {
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
