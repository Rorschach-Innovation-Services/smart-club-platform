/**
 * Fixture test for the manifest-free structure-sheet parser (self-serve onboarding B1) —
 * pins the barren-sub-header rule that `import-titans.test.ts` cannot exercise (it only
 * unit-tests the pure helpers; this needs a real exceljs workbook run through the shared
 * grid-scan with no SECTION_LEAGUE_MAP in the loop).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const { parseStructureSheet, parseStructureWorkbookAllSheets } =
  await import('../src/structure-parse.js');

/** Build a worksheet shaped like the Titans SENIORS sheet: a real section header, an
 * "overs" sub-header directly below it (same shape — a name cell + "VENUE" next to it —
 * but no manifest recognises it), then the section's actual team/venue data rows. */
function buildOversSubHeaderSheet(): ExcelJS.Worksheet {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('SENIORS');
  ws.addRow(['PREMIER LEAGUE DIVISION A', 'VENUE']);
  ws.addRow(['50 - OVERS', 'VENUE']); // barren sub-header, header-shaped, no data of its own
  ws.addRow(['TUKS 1', 'TUKS A']);
  ws.addRow(['PRETORIA 1', 'PRETORIA A']);
  return ws;
}

describe('parseStructureSheet — manifest-free grid-scan', () => {
  test('emits a section for every header-shaped row, including the barren sub-header', () => {
    const sections = parseStructureSheet(buildOversSubHeaderSheet());
    const headers = sections.map((s) => s.header);
    assert.deepEqual(headers, ['PREMIER LEAGUE DIVISION A', '50 - OVERS']);
  });

  test('the barren sub-header collects zero rows', () => {
    const sections = parseStructureSheet(buildOversSubHeaderSheet());
    const subHeader = sections.find((s) => s.header === '50 - OVERS')!;
    assert.deepEqual(subHeader.rows, []);
  });

  test('data rows after the sub-header still attach to the enclosing section, not the sub-header', () => {
    const sections = parseStructureSheet(buildOversSubHeaderSheet());
    const enclosing = sections.find((s) => s.header === 'PREMIER LEAGUE DIVISION A')!;
    assert.deepEqual(enclosing.rows, [
      { raw: 'TUKS 1', venue: 'TUKS A' },
      { raw: 'PRETORIA 1', venue: 'PRETORIA A' },
    ]);
  });

  test('a header row NOT immediately preceded by another header row starts a new live section', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('SENIORS');
    ws.addRow(['PREMIER LEAGUE DIVISION A', 'VENUE']);
    ws.addRow(['TUKS 1', 'TUKS A']);
    ws.addRow(['SECOND LEAGUE', 'VENUE']);
    ws.addRow(['BRITS 1', 'BRITS A']);
    const sections = parseStructureSheet(ws);
    assert.deepEqual(
      sections.map((s) => ({ header: s.header, rows: s.rows })),
      [
        { header: 'PREMIER LEAGUE DIVISION A', rows: [{ raw: 'TUKS 1', venue: 'TUKS A' }] },
        { header: 'SECOND LEAGUE', rows: [{ raw: 'BRITS 1', venue: 'BRITS A' }] },
      ],
    );
  });
});

describe('parseStructureWorkbookAllSheets', () => {
  test('scans every sheet with no name assumptions and counts sheets with sections', () => {
    const wb = new ExcelJS.Workbook();
    const withSections = wb.addWorksheet('Some Random Sheet Name');
    withSections.addRow(['PREMIER LEAGUE DIVISION A', 'VENUE']);
    withSections.addRow(['TUKS 1', 'TUKS A']);
    wb.addWorksheet('Instructions'); // no header-shaped rows at all

    const scan = parseStructureWorkbookAllSheets(wb);
    assert.equal(scan.sheetsScanned, 2);
    assert.equal(scan.sheetsWithSections, 1);
    assert.equal(scan.sections.length, 1);
    assert.equal(scan.sections[0].sheet, 'Some Random Sheet Name');
  });
});
