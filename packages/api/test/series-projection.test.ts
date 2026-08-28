/**
 * Unit tests for the pure progressive-release helpers (ADR 0011). No dynalite, no Hono —
 * `series-projection.ts` reads a series and `today` and returns a projected copy, so it is
 * tested directly. Pins the two properties the API relies on: the projection NEVER mutates
 * its input (the stored series must keep its real venues/times for the clash gate), and
 * `normaliseWithheld` collapses an empty object to `undefined` so storage stays clean.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseWithheld, projectSeriesForClub, isWithheld } from '../src/series-projection.js';
import type { Series } from '../src/types.js';

const series = (over: Partial<Series> = {}): Series =>
  ({
    id: 's1',
    name: 'Series 1',
    startDate: '2026-09-27',
    teams: ['home-club', 'away-club'],
    fixtures: [
      {
        id: 'f1',
        round: 1,
        date: '2026-09-27',
        time: '09:00',
        slot: 'morning',
        home: 'home-club',
        away: 'away-club',
        venueId: 'v1',
        venueName: 'Kingsmead Stadium',
        venueLat: -29.85,
        venueLon: 31.02,
        venueStatus: 'home',
      },
    ],
    approved: true,
    approvedAt: '2026-08-01T00:00:00.000Z',
    released: true,
    releasedAt: '2026-08-10T00:00:00.000Z',
    version: 1,
    ...over,
  }) as Series;

describe('normaliseWithheld', () => {
  test('keeps only the true keys', () => {
    assert.deepEqual(normaliseWithheld({ venue: true, time: false }), { venue: true });
    assert.deepEqual(normaliseWithheld({ venue: true, time: true }), {
      venue: true,
      time: true,
    });
  });

  test('an empty object, an all-false object, and undefined all collapse to undefined', () => {
    assert.equal(normaliseWithheld({}), undefined);
    assert.equal(normaliseWithheld({ venue: false, time: false }), undefined);
    assert.equal(normaliseWithheld(undefined), undefined);
  });

  test('rejects bad shapes with a 400', () => {
    for (const bad of ['venues', 42, null, [], { foo: true }, { venue: 'yes' }]) {
      assert.throws(
        () => normaliseWithheld(bad),
        (e: unknown) => (e as { status?: number }).status === 400,
      );
    }
  });
});

describe('isWithheld', () => {
  test('reads the flag; absent withheld ⇒ false', () => {
    assert.equal(isWithheld(series({ withheld: { venue: true } }), 'venue'), true);
    assert.equal(isWithheld(series({ withheld: { venue: true } }), 'time'), false);
    assert.equal(isWithheld(series(), 'venue'), false);
  });
});

describe('projectSeriesForClub', () => {
  const today = '2026-08-20';

  test('unreleased ⇒ null', () => {
    assert.equal(projectSeriesForClub(series({ released: false }), today), null);
  });

  test('released but future activateFrom ⇒ null', () => {
    assert.equal(projectSeriesForClub(series({ activateFrom: '2026-09-01' }), today), null);
  });

  test('released + activated: strips approval, keeps everything else when nothing withheld', () => {
    const out = projectSeriesForClub(series(), today)!;
    assert.ok(out);
    assert.equal('approved' in out, false);
    assert.equal('approvedAt' in out, false);
    const f = (out.fixtures as Record<string, unknown>[])[0];
    assert.equal(f.venueName, 'Kingsmead Stadium');
    assert.equal(f.time, '09:00');
    assert.equal(out.withheld, undefined);
  });

  test('withheld.venue strips all eight venue keys, keeps time + withheld flag', () => {
    const out = projectSeriesForClub(series({ withheld: { venue: true } }), today)!;
    const f = (out.fixtures as Record<string, unknown>[])[0];
    for (const k of [
      'venueId',
      'venueName',
      'venueLat',
      'venueLon',
      'venueStatus',
      'venueReason',
      'venueLocked',
      'venueOverride',
    ])
      assert.equal(k in f, false, `${k} must be stripped`);
    assert.equal(f.time, '09:00', 'time survives a venue-only withhold');
    assert.deepEqual(out.withheld, { venue: true });
  });

  test('withheld.time strips fixture time/slot and schedule.slots, keeps venue', () => {
    const out = projectSeriesForClub(
      series({
        withheld: { time: true },
        schedule: {
          calendarId: 'cal1',
          blockId: 'b1',
          cadence: { kind: 'weekly' },
          slots: [{ label: 'AM', start: '09:00' }],
        } as Series['schedule'],
      }),
      today,
    )!;
    const f = (out.fixtures as Record<string, unknown>[])[0];
    assert.equal('time' in f, false);
    assert.equal('slot' in f, false);
    assert.equal(f.venueName, 'Kingsmead Stadium', 'venue survives a time-only withhold');
    assert.equal(out.schedule?.slots, undefined);
  });

  test('never mutates its input — the stored series keeps its real data', () => {
    const input = series({
      withheld: { venue: true, time: true },
      schedule: {
        calendarId: 'cal1',
        blockId: 'b1',
        cadence: { kind: 'weekly' },
        slots: [{ label: 'AM', start: '09:00' }],
      } as Series['schedule'],
    });
    const snapshot = JSON.parse(JSON.stringify(input));
    projectSeriesForClub(input, today);
    assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot);
  });

  test('a legacy series with no withheld is returned intact (minus approval)', () => {
    const input = series({ approved: undefined, approvedAt: undefined });
    const out = projectSeriesForClub(input, today)!;
    const f = (out.fixtures as Record<string, unknown>[])[0];
    assert.equal(f.venueName, 'Kingsmead Stadium');
    assert.equal(f.time, '09:00');
  });
});
