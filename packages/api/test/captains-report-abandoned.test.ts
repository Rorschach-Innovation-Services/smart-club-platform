/**
 * `isAbandonedResult`: the one predicate that keeps captain's report notices away from an
 * abandoned match. It keys on `method` alone, so both shapes medicoach sends for an abandoned
 * match are caught, while a no-result or forfeit match still gets its notices.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { isAbandonedResult: judge } = await import('../src/captains-reports.js');

/** A whole result shape (winner, noResult, …), as the wire and the store carry it. */
type ResultLike = { method?: string | null; cleared?: boolean; [k: string]: unknown };
const isAbandonedResult = (r: ResultLike | null | undefined) => judge(r);

describe('isAbandonedResult', () => {
  test('both wire shapes of an abandoned match count', () => {
    // Host-recorded or CSA-scraped "abandoned".
    assert.equal(isAbandonedResult({ method: 'abandoned', winner: 'none', noResult: true }), true);
    // The scorer's "abandoned, points shared".
    assert.equal(isAbandonedResult({ method: 'abandoned', winner: 'tie', noResult: false }), true);
  });

  test('case and surrounding whitespace do not matter', () => {
    assert.equal(isAbandonedResult({ method: 'Abandoned' }), true);
    assert.equal(isAbandonedResult({ method: '  ABANDONED \n' }), true);
  });

  test('a cleared result is not abandoned', () => {
    assert.equal(isAbandonedResult({ method: 'abandoned', cleared: true }), false);
  });

  test('no result at all is not abandoned', () => {
    assert.equal(isAbandonedResult(null), false);
    assert.equal(isAbandonedResult(undefined), false);
    assert.equal(isAbandonedResult({}), false);
    assert.equal(isAbandonedResult({ method: null }), false);
    assert.equal(isAbandonedResult({ method: '' }), false);
  });

  test('no-result, forfeit and played results still get notices', () => {
    assert.equal(isAbandonedResult({ method: 'no-result', winner: 'none', noResult: true }), false);
    assert.equal(isAbandonedResult({ method: 'forfeit', winner: 'home' }), false);
    assert.equal(isAbandonedResult({ method: 'runs', winner: 'away' }), false);
    assert.equal(isAbandonedResult({ method: 'abandoned-tie' }), false);
  });
});
