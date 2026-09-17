/**
 * Unit tests for shift-fixture-dates.ts's pure core (planDateShift / computeShift).
 * No repo, no DynamoDB.
 *
 * Synthetic series: rounds 1..6 on weekly Saturdays with a GAP on 2026-11-28 (no round is
 * played that week), so the "next existing playing date" behaviour of the slot cascade is
 * observable and distinguishable from the flat +7 of the weeks cascade.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planDateShift, computeShift, buildPairMap } from '../src/shift-fixture-dates.js';
import type { Series } from '../src/types.js';

interface Fx {
  id: string;
  round: number;
  date: string;
  time?: string;
  venueOverride?: string;
}

// Weekly Saturdays with a gap on 2026-11-28 (nothing between R3 and R4).
const ROUND_DATES: Record<number, string> = {
  1: '2026-11-07',
  2: '2026-11-14',
  3: '2026-11-21',
  4: '2026-12-05',
  5: '2026-12-12',
  6: '2026-12-19',
};

function gapSeries(): Series {
  const fixtures: Fx[] = Object.entries(ROUND_DATES).map(([r, date]) => ({
    id: `f${r}`,
    round: Number(r),
    date,
    time: '10:00',
    venueOverride: `Ground ${r}`,
  }));
  return {
    id: 's-test',
    name: 'Test Series',
    startDate: '2026-11-07',
    teams: [],
    fixtures,
    released: true,
    releasedAt: '2026-10-01',
    version: 3,
  } as unknown as Series;
}

function dateByRound(series: Series): Record<number, string> {
  const out: Record<number, string> = {};
  for (const f of series.fixtures as Fx[]) out[f.round] = f.date;
  return out;
}

describe('buildPairMap', () => {
  test('equal-length lists pair positionally (Sat→Sat, Sun→Sun)', () => {
    const pm = buildPairMap(['2026-12-12', '2026-12-13'], ['2027-01-16', '2027-01-17']);
    assert.equal(pm.get('2026-12-12'), '2027-01-16');
    assert.equal(pm.get('2026-12-13'), '2027-01-17');
  });

  test('a single to-date applies the same day-offset to every from-date', () => {
    const pm = buildPairMap(['2026-12-12', '2026-12-13'], ['2027-01-16']);
    assert.equal(pm.get('2026-12-12'), '2027-01-16'); // +35 days
    assert.equal(pm.get('2026-12-13'), '2027-01-17'); // +35 days
  });

  test('a mismatched multi-to count is rejected', () => {
    assert.throws(() =>
      buildPairMap(['2026-12-12', '2026-12-13'], ['2027-01-16', '2027-01-17', '2027-01-18']),
    );
  });
});

describe('planDateShift — slot cascade (default)', () => {
  const plan = planDateShift(gapSeries(), {
    fromDates: ['2026-11-07'],
    toDates: ['2026-11-21'],
    cascade: 'slot',
  });
  const next = computeShift(gapSeries(), {
    fromDates: ['2026-11-07'],
    toDates: ['2026-11-21'],
    cascade: 'slot',
  }).next;
  const nd = dateByRound(next);

  test('moves the target round to the paired to-date', () => {
    assert.equal(nd[1], '2026-11-21');
  });

  test('preserves the gap pattern: R3 lands on the NEXT existing date (12-05), not the 11-28 gap', () => {
    assert.equal(nd[3], '2026-12-05');
    assert.equal(nd[4], '2026-12-12');
    assert.equal(nd[5], '2026-12-19');
  });

  test('the last displaced round gets old-last + 7 days', () => {
    assert.equal(nd[6], '2026-12-26'); // 2026-12-19 + 7
  });

  test('rounds before the moved date are untouched (only colliding rounds push)', () => {
    assert.equal(nd[2], '2026-11-14');
  });

  test('byRound lists every changed round, sorted, and excludes the unchanged R2', () => {
    assert.deepEqual(plan.byRound, [
      { round: 1, oldDate: '2026-11-07', newDate: '2026-11-21' },
      { round: 3, oldDate: '2026-11-21', newDate: '2026-12-05' },
      { round: 4, oldDate: '2026-12-05', newDate: '2026-12-12' },
      { round: 5, oldDate: '2026-12-12', newDate: '2026-12-19' },
      { round: 6, oldDate: '2026-12-19', newDate: '2026-12-26' },
    ]);
  });

  test('time and venue fields (and ids) are preserved on moved fixtures', () => {
    for (const f of next.fixtures as Fx[]) {
      assert.equal(f.time, '10:00');
      assert.equal(f.venueOverride, `Ground ${f.round}`);
      assert.equal(f.id, `f${f.round}`);
    }
  });
});

describe('planDateShift — weeks cascade', () => {
  const next = computeShift(gapSeries(), {
    fromDates: ['2026-11-07'],
    toDates: ['2026-11-21'],
    cascade: 'weeks',
  }).next;
  const nd = dateByRound(next);

  test('everything dated ≥ the earliest to-date shifts +7, filling the gap (R3 → 11-28)', () => {
    assert.equal(nd[1], '2026-11-21'); // the move itself
    assert.equal(nd[3], '2026-11-28'); // +7 — DIFFERS from slot (which gave 12-05)
    assert.equal(nd[4], '2026-12-12');
    assert.equal(nd[5], '2026-12-19');
    assert.equal(nd[6], '2026-12-26');
  });

  test('rounds before the earliest to-date are untouched', () => {
    assert.equal(nd[2], '2026-11-14');
  });
});

describe('planDateShift — none cascade', () => {
  const plan = planDateShift(gapSeries(), {
    fromDates: ['2026-11-07'],
    toDates: ['2026-11-21'],
    cascade: 'none',
  });
  const nd = dateByRound(
    computeShift(gapSeries(), {
      fromDates: ['2026-11-07'],
      toDates: ['2026-11-21'],
      cascade: 'none',
    }).next,
  );

  test('only the targeted round moves; later rounds are left where they are', () => {
    assert.equal(nd[1], '2026-11-21');
    assert.equal(nd[3], '2026-11-21'); // collision left as-is
    assert.equal(nd[4], '2026-12-05');
    assert.equal(nd[6], '2026-12-19');
    assert.deepEqual(plan.byRound, [{ round: 1, oldDate: '2026-11-07', newDate: '2026-11-21' }]);
  });
});

describe('planDateShift — paired weekend (Sat→Sat, Sun→Sun)', () => {
  const weekend: Series = {
    id: 's-weekend',
    name: 'Weekend Series',
    startDate: '2026-12-12',
    teams: [],
    fixtures: [
      { id: 'fa', round: 1, date: '2026-12-12', time: '09:00', venueOverride: 'Sat Ground' }, // Sat
      { id: 'fb', round: 2, date: '2026-12-13', time: '13:30', venueOverride: 'Sun Ground' }, // Sun
    ],
    released: true,
    releasedAt: '2026-10-01',
    version: 1,
  } as unknown as Series;

  const next = computeShift(weekend, {
    fromDates: ['2026-12-12', '2026-12-13'],
    toDates: ['2027-01-16', '2027-01-17'],
    cascade: 'none',
  }).next;
  const byId = new Map((next.fixtures as Fx[]).map((f) => [f.id, f]));

  test('the Saturday fixture maps to the Saturday to-date and the Sunday to the Sunday', () => {
    assert.equal(byId.get('fa')!.date, '2027-01-16');
    assert.equal(byId.get('fb')!.date, '2027-01-17');
  });

  test('times and venues survive the paired move', () => {
    assert.equal(byId.get('fa')!.time, '09:00');
    assert.equal(byId.get('fa')!.venueOverride, 'Sat Ground');
    assert.equal(byId.get('fb')!.time, '13:30');
    assert.equal(byId.get('fb')!.venueOverride, 'Sun Ground');
  });
});

describe('planDateShift — no matching from-date is a no-op', () => {
  test('a from-date that no fixture plays yields no moves', () => {
    const plan = planDateShift(gapSeries(), {
      fromDates: ['2026-10-31'],
      toDates: ['2026-11-01'],
      cascade: 'slot',
    });
    assert.equal(plan.moves.length, 0);
    assert.equal(plan.byRound.length, 0);
  });
});
