/**
 * Slot-ref label parity for a within-pool bracket (A1 v A2, B1 v B2 → final).
 *
 * The browser's within-pool generator flattens the pools and hands them to the same
 * adjacent-pairing bracket builder every knockout uses, so the fixtures are ordinary
 * round-major ones with `win:`/`lose:` refs. The emailed schedule labels them through
 * slot-refs.ts; this pins that the wording matches the portal's ("Winner of Semi-final
 * 1") with no server change. PARITY: src/competition/formats.ts `slotRefLabel`.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { slotRefLabel } from '../src/slot-refs.js';
import { resolveTeam } from '../src/teams.js';
import type { Club, Series } from '../src/types.js';

// Round-major, as bracketFromMatchOrder emits for [A1, A2, B1, B2].
const semis = [
  { id: 'f1', round: 1, home: 'a1', away: 'a2' },
  { id: 'f2', round: 1, home: 'b1', away: 'b2' },
];
const final = { id: 'f3', round: 2, home: 'win:f1', away: 'win:f2' };
const playoff = { id: 'f4', round: 3, home: 'lose:f1', away: 'lose:f2' };

describe('within-pool 2×2 bracket labels', () => {
  test('the final reads Winner of Semi-final 1 v Winner of Semi-final 2', () => {
    const fixtures = [...semis, final];
    assert.equal(slotRefLabel('win:f1', fixtures), 'Winner of Semi-final 1');
    assert.equal(slotRefLabel('win:f2', fixtures), 'Winner of Semi-final 2');
  });

  test('with a third-place playoff, the final still names the semis and the playoff names their losers', () => {
    // The playoff is appended AFTER the final (round 3) — max(round) is not the final.
    const fixtures = [...semis, final, playoff];
    assert.equal(slotRefLabel('win:f1', fixtures), 'Winner of Semi-final 1');
    assert.equal(slotRefLabel('win:f2', fixtures), 'Winner of Semi-final 2');
    assert.equal(slotRefLabel('lose:f1', fixtures), 'Loser of Semi-final 1');
    assert.equal(slotRefLabel('lose:f2', fixtures), 'Loser of Semi-final 2');
  });

  test('the broadcast resolver renders the same label for a final slot', () => {
    const series = {
      id: 's-ko',
      participants: [],
      fixtures: [...semis, final],
    } as unknown as Series;
    assert.equal(
      resolveTeam(series, 'win:f2', new Map<string, Club>()).name,
      'Winner of Semi-final 2',
    );
  });
});
