/**
 * Unit test for the BIFF (legacy .xls) magic-byte detector (self-serve onboarding, E2E
 * round 3) — pins that a real Excel 97-2003 workbook (a buffer starting with the OLE2
 * Compound File Binary signature D0 CF 11 E0) is recognised BEFORE exceljs ever sees it,
 * so committee-extract can give an accurate reason instead of the generic "corrupted"
 * message. See test/reps.int.test.ts for the route-level assertion.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isLegacyXlsBuffer } from '../src/committee-parse.js';

describe('isLegacyXlsBuffer', () => {
  test('true for a buffer starting with the BIFF/OLE2 magic bytes', () => {
    const buf = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    assert.equal(isLegacyXlsBuffer(buf), true);
  });

  test('false for a genuinely unreadable/random buffer', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    assert.equal(isLegacyXlsBuffer(buf), false);
  });

  test('false for an OOXML zip (xlsx) buffer', () => {
    const buf = Buffer.from('PK\x03\x04rest-of-a-real-xlsx-zip');
    assert.equal(isLegacyXlsBuffer(buf), false);
  });

  test('false for a buffer shorter than the magic', () => {
    const buf = Buffer.from([0xd0, 0xcf]);
    assert.equal(isLegacyXlsBuffer(buf), false);
  });
});
