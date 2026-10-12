/**
 * EMCU club codes — the committed table (also read by MediCoach's create-emcu-scorers script)
 * must cover every EMCU club id with a unique `[a-z0-9]{3,8}` code.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CLUB_CODE_RE, loadClubCodes, validateClubCodes } from '../src/emcu-club-codes.js';
import { EMCU_TEAM_MAP } from '../src/emcu-fixture-map.js';

const emcuClubIds = [...new Set(Object.values(EMCU_TEAM_MAP).map((e) => e.clubId))];

describe('committed EMCU club-code table', () => {
  test('covers every EMCU club id with a unique, well-formed code', async () => {
    const codes = await loadClubCodes();
    assert.deepEqual(validateClubCodes(codes, emcuClubIds), []);
    for (const id of emcuClubIds) assert.match(codes[id]!, CLUB_CODE_RE);
  });

  test('lettered sides share their club code (codes are per club id)', async () => {
    const codes = await loadClubCodes();
    assert.equal(codes['simplex-reservoir-hills-crimson'], 'simplex');
    assert.equal(emcuClubIds.filter((id) => id === 'simplex-reservoir-hills-crimson').length, 1);
  });
});

describe('validateClubCodes', () => {
  test('flags a duplicate code, a bad format and a missing club', () => {
    const problems = validateClubCodes({ a: 'abc', b: 'abc', c: 'AB', d: 'toolongcode' }, [
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    assert.ok(problems.some((p) => /code "abc" is used by a, b/.test(p)));
    assert.ok(problems.some((p) => /^c: code "AB"/.test(p)));
    assert.ok(problems.some((p) => /^d: code "toolongcode"/.test(p)));
    assert.ok(problems.includes('e: no club code'));
  });

  test('extra ids are allowed; a non-object table is rejected', () => {
    assert.deepEqual(validateClubCodes({ a: 'abc', extra: 'xyz' }, ['a']), []);
    assert.equal(validateClubCodes(['abc'], ['a']).length, 1);
  });
});
