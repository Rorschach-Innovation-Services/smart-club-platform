/**
 * mergeDistricts — the pure add-only merge behind the set-tenant-districts CLI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDistricts } from '../src/set-tenant-districts.js';

test('appends new districts after the existing ones, trimmed', () => {
  const r = mergeDistricts(['Johannesburg'], [' Sedibeng ', 'Mogale City', 'West Rand']);
  assert.deepEqual(r.next, ['Johannesburg', 'Sedibeng', 'Mogale City', 'West Rand']);
  assert.deepEqual(r.added, ['Sedibeng', 'Mogale City', 'West Rand']);
  assert.deepEqual(r.skipped, []);
});

test('never removes, and skips names already listed (idempotent re-run)', () => {
  const r = mergeDistricts(['Johannesburg', 'Sedibeng'], ['Sedibeng', 'Johannesburg']);
  assert.deepEqual(r.next, ['Johannesburg', 'Sedibeng']);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.skipped, ['Sedibeng', 'Johannesburg']);
});

test('a name repeated in one call is added once', () => {
  assert.deepEqual(mergeDistricts([], ['West Rand', 'West Rand']).next, ['West Rand']);
});

test('rejects what the operator route rejects', () => {
  assert.throws(() => mergeDistricts([], ['  ']), /needs a name/);
  assert.throws(() => mergeDistricts([], ['x'.repeat(81)]), /80 characters/);
  assert.throws(() => mergeDistricts([], ['All districts']), /reserved/);
});
