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
