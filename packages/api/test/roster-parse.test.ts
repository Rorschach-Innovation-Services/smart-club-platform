/**
 * Fixture test for the tenant-neutral roster-sheet parser (self-serve onboarding, E2E
 * round 2) — pins the "Name"/"Surname" template variant where the surname column is
 * blank and the full name is typed into the "Name" cell (Adelaar's senior sheet:
 * "Stephan Pretorius" + a blank Surname). Before this fix that row parsed as
 * firstName="Stephan Pretorius", lastName="" and the roster-intake commit validator
 * (correctly) rejected it, 400ing the WHOLE club batch ("item 0: firstName and lastName
 * are required") — see roster-intake.int.test.ts for the commit-side validator coverage.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const { parseRosterSheet } = await import('../src/roster-parse.js');
const { DEFAULT_JUNIOR_LEAGUE_KEYS } = await import('../src/roster-normalize.js');

// ── Luhn-valid RSA id generation, matching dobFromSaId's own algorithm (mirrors the
// helper in roster-intake.int.test.ts) ──
function luhnCheckDigit(twelve: string): string {
  let sum = 0;
  let alt = true;
  for (let i = twelve.length - 1; i >= 0; i--) {
    let d = twelve.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return String((10 - (sum % 10)) % 10);
}
function validSaId(dobIso: string): string {
  const [y, m, d] = dobIso.split('-');
  const twelve = `${y.slice(2)}${m}${d}000008`;
  return twelve + luhnCheckDigit(twelve);
}

function buildSheet(rows: string[][]): ExcelJS.Worksheet {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Seniors');
  ws.addRow(['Name', 'Surname', 'ID Number', 'Gender', 'Race']);
  for (const r of rows) ws.addRow(r);
  return ws;
}

const OPTS = { allowMissingId: false, juniorLeagueKeys: DEFAULT_JUNIOR_LEAGUE_KEYS };

describe('parseRosterSheet — blank-surname full-name split', () => {
  test('splits the last word into lastName when the surname cell is blank', () => {
    const id = validSaId('1990-04-12');
    const ws = buildSheet([['Stephan Pretorius', '', id, 'Male', 'African']]);
    const result = parseRosterSheet(ws, 'club-1', '2026-08-18T00:00:00.000Z', OPTS)!;
    assert.equal(result.exceptions.length, 0);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].player.firstName, 'Stephan');
    assert.equal(result.rows[0].player.lastName, 'Pretorius');
  });

  test('keeps a multi-word first name intact, splitting only the last word', () => {
    const id = validSaId('1985-11-02');
    const ws = buildSheet([['Xavier Zinzan Sanna', '', id, 'Male', 'African']]);
    const result = parseRosterSheet(ws, 'club-1', '2026-08-18T00:00:00.000Z', OPTS)!;
    assert.equal(result.exceptions.length, 0);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].player.firstName, 'Xavier Zinzan');
    assert.equal(result.rows[0].player.lastName, 'Sanna');
  });

  test('a single-word name with a blank surname becomes a missing-surname exception, never a half-named row', () => {
    const id = validSaId('1992-01-20');
    const ws = buildSheet([['Stephan', '', id, 'Male', 'African']]);
    const result = parseRosterSheet(ws, 'club-1', '2026-08-18T00:00:00.000Z', OPTS)!;
    assert.equal(result.rows.length, 0);
    assert.equal(result.exceptions.length, 1);
    assert.equal(result.exceptions[0].reason, 'missing-surname');
    assert.equal(result.totalDataRows, 1); // counted as a data row, just excepted
  });

  test('a row with a populated surname column is completely untouched by the split', () => {
    const id = validSaId('1998-03-14');
    const ws = buildSheet([['Stephan', 'Pretorius', id, 'Male', 'African']]);
    const result = parseRosterSheet(ws, 'club-1', '2026-08-18T00:00:00.000Z', OPTS)!;
    assert.equal(result.exceptions.length, 0);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].player.firstName, 'Stephan');
    assert.equal(result.rows[0].player.lastName, 'Pretorius');
  });

  test('a multi-word first name with a populated surname is also untouched (no split attempted)', () => {
    const id = validSaId('1993-06-06');
    const ws = buildSheet([['Xavier Zinzan', 'Sanna', id, 'Male', 'African']]);
    const result = parseRosterSheet(ws, 'club-1', '2026-08-18T00:00:00.000Z', OPTS)!;
    assert.equal(result.exceptions.length, 0);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].player.firstName, 'Xavier Zinzan');
    assert.equal(result.rows[0].player.lastName, 'Sanna');
  });
});
