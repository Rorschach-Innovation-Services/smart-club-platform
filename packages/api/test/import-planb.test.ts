/**
 * Unit tests for the Plan B fixture import's pure helpers — cell parsing (isoDate/
 * isoTime), the season-wide GroundLedger clash semantics, and assertDeleteSet's
 * subset-safety rail. Pure — no dynalite, no repo.js, nothing touches DynamoDB; the
 * module guards its own entry point (`import.meta.url === pathToFileURL(...)`), so
 * importing it here never runs main().
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { isoDate, isoTime, GroundLedger, assertDeleteSet, normalise, redirectedNormalise, pairKey } =
  await import('../src/import-planb-fixtures.js');

// Mirrors the module's own (unexported) constants — kept in sync by inspection, not
// import, since assertDeleteSet's contract is what's under test here.
const ID_PREFIX = 's-planb-';
const DELETE_SLUGS = [
  'premier-men-t20-top6',
  'premier-men-t20-bottom6',
  'premier-women-t20-top4',
  'premier-women-t20-bottom4',
];
const KEEP_SLUG = 'promotion-men-50ov-g1';

describe('isoDate / isoTime — Excel cell parsing', () => {
  test('a 1899-epoch Date (time-only cell) yields a time, and no date', () => {
    const cell = new Date(Date.UTC(1899, 11, 30, 13, 30));
    assert.equal(isoTime(cell), '13:30');
    assert.equal(isoDate(cell), null);
  });

  test('a modern Date (date cell) yields a date, and no time — even carrying a UTC time component', () => {
    // isoTime's guard is purely the year: any Date with getUTCFullYear() >= 1970 is
    // treated as a date cell, and isoTime returns null unconditionally — it never
    // inspects the hours/minutes on a modern Date. That's the actual implementation
    // behavior, not just the common case.
    const cell = new Date(Date.UTC(2026, 7, 16, 13, 30));
    assert.equal(isoDate(cell), '2026-08-16');
    assert.equal(isoTime(cell), null);
  });

  test('a fraction-of-day number rounds to the nearest minute', () => {
    assert.equal(isoTime(0.5625), '13:30'); // exact: 810/1440
    // 12:00:30 → 720.5 minutes; Math.round rounds the halfway case up to 721 → 12:01
    assert.equal(isoTime(720.5 / 1440), '12:01');
  });

  test('a {formula, result} cell unwraps to its result for both isoDate and isoTime', () => {
    const dateResult = new Date(Date.UTC(2026, 7, 16));
    assert.equal(isoDate({ formula: '=E2+7', result: dateResult }), '2026-08-16');
    assert.equal(isoTime({ formula: '=E2+7', result: 0.5625 }), '13:30');
  });
});

describe('GroundLedger — untimed-owns-the-whole-day clash semantics', () => {
  test('an untimed booking blocks a later timed check on the same ground/date', () => {
    const ledger = new GroundLedger();
    ledger.book('Chatsworth Oval', '2026-09-01', undefined, {
      seriesId: 's1',
      fixtureId: 'f1',
      date: '2026-09-01',
    });
    const clash = ledger.check('Chatsworth Oval', '2026-09-01', '10:00');
    assert.ok(clash, 'a timed fixture must clash with an untimed booking that day');
    assert.equal(clash.seriesId, 's1');
  });

  test('a timed booking blocks a later untimed check on the same ground/date', () => {
    const ledger = new GroundLedger();
    ledger.book('Chatsworth Oval', '2026-09-01', '10:00', {
      seriesId: 's1',
      fixtureId: 'f1',
      date: '2026-09-01',
      time: '10:00',
    });
    const clash = ledger.check('Chatsworth Oval', '2026-09-01', undefined);
    assert.ok(
      clash,
      'an untimed fixture owns the whole ground-day and must clash with any existing booking',
    );
  });

  test('two distinct times on the same ground/date do not clash', () => {
    const ledger = new GroundLedger();
    ledger.book('Chatsworth Oval', '2026-09-01', '10:00', {
      seriesId: 's1',
      fixtureId: 'f1',
      date: '2026-09-01',
      time: '10:00',
    });
    assert.equal(ledger.check('Chatsworth Oval', '2026-09-01', '11:00'), undefined);
  });

  test('the same date/time on two different grounds does not clash', () => {
    const ledger = new GroundLedger();
    ledger.book('Chatsworth Oval', '2026-09-01', '10:00', {
      seriesId: 's1',
      fixtureId: 'f1',
      date: '2026-09-01',
      time: '10:00',
    });
    assert.equal(ledger.check('Kingsmead Oval', '2026-09-01', '10:00'), undefined);
  });
});

describe('assertDeleteSet — subset safety rail', () => {
  test('the exact expected set is accepted', () => {
    const existingIds = [...DELETE_SLUGS, KEEP_SLUG].map((s) => `${ID_PREFIX}${s}`);
    const stale = assertDeleteSet(existingIds, new Set());
    assert.deepEqual([...stale].sort(), [...DELETE_SLUGS].sort());
  });

  test('a proper subset (post-prune re-run, or some already overwritten this run) is accepted', () => {
    const remaining = DELETE_SLUGS.slice(0, 2);
    const existingIds = [...remaining, KEEP_SLUG].map((s) => `${ID_PREFIX}${s}`);
    const stale = assertDeleteSet(existingIds, new Set());
    assert.deepEqual(stale.sort(), [...remaining].sort());
  });

  test('an empty set (all superseded series already pruned) is accepted', () => {
    const existingIds = [KEEP_SLUG].map((s) => `${ID_PREFIX}${s}`);
    const stale = assertDeleteSet(existingIds, new Set());
    assert.deepEqual(stale, []);
  });

  test('a stale slug outside the expected set throws', () => {
    const existingIds = [`${ID_PREFIX}some-unrelated-series`];
    assert.throws(() => assertDeleteSet(existingIds, new Set()));
  });

  test('a KEEP_LIST slug is never returned, even when present', () => {
    const existingIds = [`${ID_PREFIX}${KEEP_SLUG}`, `${ID_PREFIX}${DELETE_SLUGS[0]}`];
    const stale = assertDeleteSet(existingIds, new Set());
    assert.ok(!stale.includes(KEEP_SLUG));
    assert.deepEqual(stale, [DELETE_SLUGS[0]]);
  });
});

describe('normalise / redirectedNormalise / pairKey — cross-file name matching', () => {
  test('stopwords and team-suffix tokens are dropped', () => {
    assert.equal(normalise('Amanzimtoti CC 1st XI'), 'amanzimtoti');
    assert.equal(normalise('Tongaat Cricket Association'), 'tongaat');
  });

  test('distinguishing words survive — Sporting and United must not collide', () => {
    assert.notEqual(normalise('Chatsworth Sporting CC'), normalise('Chatsworth United'));
    assert.notEqual(normalise('Spartan Sporting'), normalise('Chatsworth Sporting'));
  });

  test('redirects collapse sheet typos and cross-file spellings to one canonical form', () => {
    assert.equal(
      redirectedNormalise('Chatsworthh United'),
      redirectedNormalise('Chatsworth United'),
    );
    assert.equal(redirectedNormalise('Illembe'), redirectedNormalise('ilembe'));
    assert.equal(redirectedNormalise('RHYTHM DHSOB 1st XI'), redirectedNormalise('Rhythm DHS'));
    assert.equal(
      redirectedNormalise('Hollywoodbets Crusaders 1st XI'),
      redirectedNormalise('Crusaders'),
    );
    assert.equal(
      redirectedNormalise('Harlequins CC DBN 1st XI'),
      redirectedNormalise('Harlequins'),
    );
  });

  test('pairKey is order-independent and redirect-aware — the cross-file venue-merge premise', () => {
    assert.equal(pairKey('UKZN', 'Delta'), pairKey('Delta', 'UKZN'));
    assert.equal(
      pairKey('Harlequins CC DBN 1st XI', 'Southern Natal CC 1st XI'),
      pairKey('Southern Natal', 'Harlequins'),
    );
    assert.notEqual(pairKey('UKZN', 'Delta'), pairKey('UKZN', 'Umzinto'));
  });
});

describe('GroundLedger — multi-surface capacity (registry-resolved grounds)', () => {
  const twoSurfaces = () => new GroundLedger(() => ({ key: 'v:chatsworth-oval', capacity: 2 }));

  test('a 2-surface ground hosts two same-slot fixtures and blocks the third', () => {
    const ledger = twoSurfaces();
    ledger.book('Chatsworth Oval', '2026-09-01', '13:00', {
      seriesId: 's1',
      fixtureId: 'f1',
      date: '2026-09-01',
      time: '13:00',
    });
    assert.equal(ledger.check('Chatsworth Oval', '2026-09-01', '13:00'), undefined);
    ledger.book('Chatsworth Oval', '2026-09-01', '13:00', {
      seriesId: 's2',
      fixtureId: 'f1',
      date: '2026-09-01',
      time: '13:00',
    });
    assert.ok(ledger.check('Chatsworth Oval', '2026-09-01', '13:00'));
  });

  test('resolver key unifies spelling variants onto one ledger row', () => {
    const ledger = new GroundLedger(() => ({ key: 'v:chatsworth-oval', capacity: 1 }));
    ledger.book('Chatsworth Cricket Oval', '2026-09-01', '13:00', {
      seriesId: 's1',
      fixtureId: 'f1',
      date: '2026-09-01',
      time: '13:00',
    });
    assert.ok(ledger.check('CHATSWORTH OVAL', '2026-09-01', '13:00'));
  });

  test('an untimed booking consumes one of two surfaces, not the whole ground', () => {
    const ledger = twoSurfaces();
    ledger.book('Chatsworth Oval', '2026-09-01', undefined, {
      seriesId: 's1',
      fixtureId: 'f1',
      date: '2026-09-01',
    });
    assert.equal(ledger.check('Chatsworth Oval', '2026-09-01', '13:00'), undefined);
  });
});
