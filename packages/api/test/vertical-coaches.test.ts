/**
 * Coach body/level validation in validateClubPatch is per sport vertical — and only for
 * non-cricket sports: cricket coach records were never validated, so checking them now
 * would 400 existing clubs that hold off-catalogue values on their next save.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateClubPatch } from '../src/catalogue.js';
import type { Sport } from '../src/vertical.js';

const check = (coach: Record<string, unknown>, sport?: Sport) =>
  validateClubPatch(
    { coaches: [coach] },
    new Set(),
    new Set(),
    new Set(),
    undefined,
    undefined,
    sport,
  );

describe('validateClubPatch · coach body/level by vertical', () => {
  test('football accepts its own vocabulary', () => {
    for (const body of ['None', 'CAF', 'UEFA', 'SAFA'])
      for (const level of ['None', 'A', 'B', 'C', 'D'])
        assert.equal(check({ name: 'X', body, level }, 'football'), null, `${body}/${level}`);
  });

  test('football rejects cricket (or unknown) bodies and levels', () => {
    assert.match(check({ name: 'X', body: 'CSA', level: 'A' }, 'football') ?? '', /coaching body/);
    assert.match(
      check({ name: 'X', body: 'CAF', level: 'Level 2' }, 'football') ?? '',
      /coaching level/,
    );
  });

  test('football tolerates a coach with no body/level yet', () => {
    assert.equal(check({ name: 'X' }, 'football'), null);
  });

  test('cricket (and no sport) never validates body/level — no retro-400s', () => {
    for (const sport of ['cricket', undefined] as const) {
      assert.equal(check({ name: 'X', body: 'Legacy Body', level: 'Level 9' }, sport), null);
      assert.equal(check({ name: 'X', body: 'CAF', level: 'A' }, sport), null);
    }
  });
});
