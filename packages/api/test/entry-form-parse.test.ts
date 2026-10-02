/**
 * entry-form-parse.ts — the club league-entry form grid reader. In-memory ExcelJS
 * fixture reproducing the 2026-27 template's row shape (title/club-detail block,
 * SENIORS + JUNIORS tables, footer note). No fs, no AWS. Contact cells are filled with
 * placeholder text only to prove they are never read into the result.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const { parseEntryFormSheet, parseEntryFormWorkbook } = await import('../src/entry-form-parse.js');

type Row = [string, string, string | number, string | number, string, string, string, string];
const blank: Row = ['', '', '', '', '', '', '', ''];
const header: Row = [
  'League ',
  '',
  '2025/26 no. of Teams',
  '2026/27 no. of Teams',
  '',
  'Name of Home Venue',
  '',
  'Contact',
];

function buildWorkbook(sheetName = 'Sheet1', overrides: Row[] = []): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  const rows: Row[] = [
    blank,
    ['Club League Entries', '', '', '', '', '', '', 'x'],
    ['Name of Club', ':', 'Example Cricket Club', '', '', '', '', ''],
    ['Contact numbers', ':', 'PLACEHOLDER', '', '', '', '', ''],
    blank,
    ['SENIORS', '', '', '', '', '', '', ''],
    blank,
    header,
    ['Premier League', '', '1', '0', '', '', '', ''],
    ['Promotion League', '', 0, 1, '', 'Example Oval', '', 'PLACEHOLDER CONTACT'],
    ['Reserve League', '', '1', '1', '', 'Example Oval, B Field', '', ''],
    ['3rd League (45 Overs)', '', '', '', '', '', '', ''],
    ["Womens' League (35 Overs)", '', '0', '1', '', 'Example Oval', '', ''],
    ...overrides,
    blank,
    ['JUNIORS', '', '', '', '', '', '', ''],
    header,
    ['Under 9', '', '1', '2', '', 'Under 9A - Field A, Under 9B - Field B', '', ''],
    ['Under 11', '', '', '2', '', 'Example Oval', '', ''],
    ['Junior Girls', '', '', '', '', '', '', ''],
    blank,
    ['**NB- Please complete the above information and return', '', '', '', '', '', '', ''],
  ];
  for (const r of rows) ws.addRow(r);
  return wb;
}

describe('parseEntryFormSheet', () => {
  test('reads every SENIORS and JUNIORS row with counts, venue and section', () => {
    const { rows, clubName } = parseEntryFormWorkbook(buildWorkbook());
    assert.equal(clubName, 'Example Cricket Club');
    assert.deepEqual(
      rows.map((r) => [r.section, r.label, r.prevCount, r.count]),
      [
        ['SENIORS', 'Premier League', 1, 0],
        ['SENIORS', 'Promotion League', 0, 1],
        ['SENIORS', 'Reserve League', 1, 1],
        ['SENIORS', '3rd League (45 Overs)', 0, 0],
        ['SENIORS', "Womens' League (35 Overs)", 0, 1],
        ['JUNIORS', 'Under 9', 1, 2],
        ['JUNIORS', 'Under 11', 0, 2],
        ['JUNIORS', 'Junior Girls', 0, 0],
      ],
    );
    assert.equal(rows.find((r) => r.label === 'Promotion League')?.venue, 'Example Oval');
    assert.equal(
      rows.find((r) => r.label === 'Under 9')?.venue,
      'Under 9A - Field A, Under 9B - Field B',
    );
  });

  test('numeric and text count cells read the same; blanks are 0', () => {
    const { rows } = parseEntryFormWorkbook(buildWorkbook());
    const promo = rows.find((r) => r.label === 'Promotion League')!; // numeric cells
    const reserve = rows.find((r) => r.label === 'Reserve League')!; // text cells
    assert.equal(promo.count, 1);
    assert.equal(reserve.count, 1);
    assert.equal(rows.find((r) => r.label === '3rd League (45 Overs)')!.count, 0);
  });

  test('a non-numeric requested count reads as 0 but carries countRaw for the caller', () => {
    const { rows } = parseEntryFormWorkbook(
      buildWorkbook('Sheet1', [['Veterans ', '', '', '2 teams', '', '', '', '']]),
    );
    const vets = rows.find((r) => r.label === 'Veterans')!;
    assert.equal(vets.count, 0);
    assert.equal(vets.countRaw, '2 teams');
    assert.equal(rows.find((r) => r.label === 'Promotion League')!.countRaw, undefined);
  });

  test('the footer note and club-detail block never become league rows', () => {
    const { rows } = parseEntryFormWorkbook(buildWorkbook());
    assert.ok(!rows.some((r) => r.label.startsWith('**NB')));
    assert.ok(!rows.some((r) => /Name of Club|Contact/.test(r.label)));
  });

  test('contact cells are never read into the result', () => {
    const { rows } = parseEntryFormWorkbook(buildWorkbook());
    assert.doesNotMatch(JSON.stringify(rows), /PLACEHOLDER/);
  });

  test('rows carry their real sheet row numbers', () => {
    const wb = buildWorkbook();
    const { rows } = parseEntryFormSheet(wb.worksheets[0]);
    const premier = rows.find((r) => r.label === 'Premier League')!;
    assert.equal(wb.worksheets[0].getRow(premier.rowNumber).getCell(1).value, 'Premier League');
  });

  test('a workbook without Sheet1 throws (never guesses at another template)', () => {
    assert.throws(() => parseEntryFormWorkbook(buildWorkbook('Entries')), /"Sheet1" not found/);
  });
});
