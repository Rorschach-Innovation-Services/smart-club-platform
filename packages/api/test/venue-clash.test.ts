/**
 * Unit tests for venue-clash.ts's ground-name keying (groundKey / VENUE_ALIASES).
 * Pure — no repo, no DynamoDB.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { groundKey } from '../src/venue-clash.js';

describe('groundKey — Gledhow shared-ground alias (union, 31 Aug 2026)', () => {
  test('Ilembe\'s "Gledhow Cricket Grounds" (trailing space) keys onto Dawnheights\' "Gledhow Cricket Ground"', () => {
    assert.equal(groundKey('Gledhow Cricket Grounds '), groundKey('Gledhow Cricket Ground'));
  });

  test('an unrelated ground name is unaffected by the alias', () => {
    assert.notEqual(groundKey('Kingsmead Oval'), groundKey('Gledhow Cricket Ground'));
  });
});

describe('groundKey — Penguin shared-ground alias (union, 31 Aug 2026)', () => {
  test('Saints\' "Chatsworth, Penguin Grounds" keys onto the registry\'s "PENGUIN STREET GROUND"', () => {
    assert.equal(groundKey('Chatsworth, Penguin Grounds'), groundKey('PENGUIN STREET GROUND'));
  });
});

describe('groundKey — exact field numbering (union, 31 Aug 2026)', () => {
  test('old venue spellings key onto the new numbered field names', () => {
    assert.equal(groundKey('Siripat Road Grounds'), groundKey('Siripat 1'));
    assert.equal(groundKey('Siripat Grounds'), groundKey('Siripat 2'));
    assert.equal(groundKey('Crusaders Sports Club'), groundKey('Crusaders 1'));
    assert.equal(groundKey('Crusaders 2 Field'), groundKey('Crusaders 2'));
    assert.equal(groundKey('Danville'), groundKey('Danville 1'));
    assert.equal(groundKey('Van Riebek Park (Harlequins 1)'), groundKey('Harlequins 1'));
    assert.equal(groundKey('Van Riebek Park (Harlequins 2)'), groundKey('Harlequins 2'));
  });

  test('generic complex names key onto their lowest numbered field', () => {
    assert.equal(groundKey('Cato Manor'), groundKey('Cato Manor 1'));
    assert.equal(groundKey('Cator Manor'), groundKey('Cato Manor 1')); // typo spelling
    assert.equal(groundKey('Harlequins'), groundKey('Harlequins 1'));
    assert.equal(groundKey('Highbury grounds'), groundKey('Highbury 1'));
  });

  test('distinct numbered fields still key apart', () => {
    assert.notEqual(groundKey('Siripat 1'), groundKey('Siripat 2'));
    assert.notEqual(groundKey('Harlequins 1'), groundKey('Harlequins 2'));
    assert.notEqual(groundKey('Cato Manor 1'), groundKey('Cato Manor 2'));
  });
});
