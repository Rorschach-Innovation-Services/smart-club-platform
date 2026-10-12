/**
 * Drift guard for the committed chair roster template (public/roster-template.xlsx, linked
 * from the club portal's spreadsheet upload). Parses the REAL committed file with the same
 * header detection the upload route uses (roster-normalize.ts findHeaderRow, via
 * parseRosterSheet), so renaming a column in the template — or tightening an alias in
 * roster-normalize — fails here instead of silently breaking every chair's upload.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { findHeaderRow, cellString } from '../src/roster-normalize.js';
import { parseRosterSheet } from '../src/roster-parse.js';

const TEMPLATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../public/roster-template.xlsx',
);

/** A Luhn-valid RSA ID for the given ISO dob (same construction as roster-intake.int.test). */
function validSaId(dobIso: string): string {
  const [y, m, d] = dobIso.split('-');
  const twelve = `${y.slice(2)}${m}${d}000008`;
  let sum = 0;
  let alt = true;
  for (let i = twelve.length - 1; i >= 0; i--) {
    let digit = twelve.charCodeAt(i) - 48;
    if (alt) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alt = !alt;
  }
  return twelve + String((10 - (sum % 10)) % 10);
}

async function loadTemplate(): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  return wb;
}

const headerCells = (ws: ExcelJS.Worksheet): string[] => {
  const vals: string[] = [];
  for (let c = 1; c <= ws.columnCount; c++) vals.push(cellString(ws.getRow(1).getCell(c).value));
  return vals;
};

test('every template column resolves to its roster field', async () => {
  const wb = await loadTemplate();
  const ws = wb.getWorksheet('Players');
  assert.ok(ws, 'template has a Players sheet');
  const cells = headerCells(ws);
  assert.deepEqual(cells, [
    'Player First Name',
    'Player Surname',
    'ID Number',
    'Date of Birth',
    'Gender',
    'Race',
    'Age Group',
  ]);
  const header = findHeaderRow([cells]);
  assert.ok(header, 'the header row is recognised');
  assert.equal(header.rowIndex, 0);
  assert.deepEqual(header.columns, {
    firstName: 0,
    lastName: 1,
    idNumber: 2,
    dob: 3,
    gender: 4,
    race: 5,
    ageGroup: 6,
  });
  // Every column is claimed by exactly one field — none silently ignored.
  assert.equal(Object.keys(header.columns).length, cells.length);
});

test('the template ships with no data rows (an example row would be imported as a player)', async () => {
  const wb = await loadTemplate();
  const result = parseRosterSheet(wb.getWorksheet('Players')!, 'club', '2026-10-02T00:00:00Z', {
    allowMissingId: false,
    allowBlankAgeGroup: true,
    juniorLeagueKeys: new Set(['u11']),
  });
  assert.ok(result);
  assert.equal(result.totalDataRows, 0);
  assert.equal(result.hasIdColumn, true);
});

test('the instructions sheet is never mistaken for a roster', async () => {
  const wb = await loadTemplate();
  const others = wb.worksheets.filter((w) => w.name !== 'Players');
  assert.ok(others.length > 0, 'template carries an instructions sheet');
  for (const w of others) {
    const parsed = parseRosterSheet(w, 'club', '2026-10-02T00:00:00Z', {
      allowMissingId: false,
      juniorLeagueKeys: new Set(['u11']),
    });
    assert.equal(parsed, null, `sheet "${w.name}" has no roster header`);
  }
});

test('a filled-in template parses seniors (blank age group) and juniors alike', async () => {
  const wb = await loadTemplate();
  const ws = wb.getWorksheet('Players')!;
  ws.addRow(['Senior', 'Player', validSaId('1990-01-01'), '', 'Male', 'African', '']);
  ws.addRow(['Junior', 'Player', validSaId('2015-05-05'), '', 'Female', 'Coloured', 'U11']);
  const result = parseRosterSheet(ws, 'club', '2026-10-02T00:00:00Z', {
    allowMissingId: false,
    allowBlankAgeGroup: true,
    juniorLeagueKeys: new Set(['u11']),
  });
  assert.ok(result);
  assert.deepEqual(result.exceptions, []);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].player.team, undefined, 'blank age group = senior, team-less');
  assert.equal(result.rows[0].player.dob, '1990-01-01');
  assert.equal(result.rows[1].player.team, 'u11');
  // Without the opt-in, a blank band on a sheet with an Age Group column stays an exception
  // (operator intake / CLI behaviour is unchanged).
  const strict = parseRosterSheet(ws, 'club', '2026-10-02T00:00:00Z', {
    allowMissingId: false,
    juniorLeagueKeys: new Set(['u11']),
  });
  assert.equal(strict!.exceptions[0]?.reason, 'unmapped-age-group');
});
