/**
 * Unit tests for the pure affiliation-patch validators in catalogue.ts — the only
 * server gate over the new exco/coach governance fields. No DynamoDB/Hono needed.
 *
 * Run with the API package's test runner (tsx --test), which resolves the NodeNext
 * ".js" import specifiers to their ".ts" sources.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateClubPatch, isValidSaId, COACH_EXPERIENCE } from '../src/catalogue.js';

const leagueKeys = new Set<string>(['premier']);
const docKeys = new Set<string>(['constitution', 'financials']);
const ok = (patch: Parameters<typeof validateClubPatch>[0]) =>
  validateClubPatch(patch, leagueKeys, docKeys);

describe('isValidSaId', () => {
  test('accepts a 13-digit ID with a real YYMMDD', () => {
    assert.equal(isValidSaId('9001015800086'), true);
  });
  test('rejects wrong length / non-digits / impossible date', () => {
    assert.equal(isValidSaId('123'), false);
    assert.equal(isValidSaId('90010158000ab'), false);
    assert.equal(isValidSaId('9013015800086'), false); // month 13
    assert.equal(isValidSaId('9001325800086'), false); // day 32
  });
});

describe('validateClubPatch · chair governance', () => {
  test('passes a valid chair ID + term dates', () => {
    assert.equal(
      ok({
        exco: {
          chair: { idNumber: '9001015800086', termStart: '2026-01-01', termEnd: '2029-01-01' },
        },
      }),
      null,
    );
  });
  test('rejects a malformed chair ID', () => {
    assert.match(String(ok({ exco: { chair: { idNumber: '123' } } })), /chair idNumber/);
  });
  test('rejects an unparseable term date', () => {
    assert.match(String(ok({ exco: { chair: { termEnd: 'not-a-date' } } })), /term end/);
  });
  test('ignores chair fields when absent', () => {
    assert.equal(ok({ exco: { chair: { name: 'Mo' } } }), null);
  });
});

describe('validateClubPatch · coach governance', () => {
  test('accepts every valid experience bucket', () => {
    for (const x of COACH_EXPERIENCE) {
      assert.equal(ok({ coaches: [{ name: 'C', yearsExperience: x }] }), null);
    }
  });
  test('rejects an out-of-enum experience bucket', () => {
    assert.match(
      String(ok({ coaches: [{ name: 'C', yearsExperience: '11+' }] })),
      /experience bucket/,
    );
  });
  test('rejects a malformed coach ID and a bad year', () => {
    assert.match(String(ok({ coaches: [{ idNumber: 'abc' }] })), /coach idNumber/);
    assert.match(String(ok({ coaches: [{ yearStarted: '19' }] })), /yearStarted/);
  });
});
