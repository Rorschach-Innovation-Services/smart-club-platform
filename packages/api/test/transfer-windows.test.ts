/**
 * Transfer windows: the operator validator and the open/closed status math (pure).
 * Run with the API package's test runner (tsx --test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTransferWindows,
  transferWindowStatus,
  tenantToday,
  closedTransferWindow,
  closedPeriodStart,
  windowClosedRejectReason,
  transfersClosedMessage,
} from '../src/transfer-windows.js';
import { HttpError } from '../src/auth.js';

const w = (label: string, start: string, end: string) => ({ label, start, end });

const rejects400 = (v: unknown, pattern: RegExp) =>
  assert.throws(
    () => validateTransferWindows(v),
    (err: unknown) => err instanceof HttpError && err.status === 400 && pattern.test(err.message),
  );

describe('validateTransferWindows', () => {
  test('trims labels and sorts by start then end', () => {
    assert.deepEqual(
      validateTransferWindows([
        w('  Mid-season ', '2027-01-05', '2027-01-20'),
        w('Pre-season', '2026-08-01', '2026-09-30'),
        w('Short', '2026-08-01', '2026-08-10'),
      ]),
      [
        w('Short', '2026-08-01', '2026-08-10'),
        w('Pre-season', '2026-08-01', '2026-09-30'),
        w('Mid-season', '2027-01-05', '2027-01-20'),
      ],
    );
  });

  test('an empty list is valid (no restriction)', () => {
    assert.deepEqual(validateTransferWindows([]), []);
  });

  test('accepts a single-day window (start === end)', () => {
    assert.deepEqual(validateTransferWindows([w('Day', '2026-10-06', '2026-10-06')]), [
      w('Day', '2026-10-06', '2026-10-06'),
    ]);
  });

  test('rejects a non-array and more than 12 windows', () => {
    rejects400({}, /must be an array/);
    rejects400(
      Array.from({ length: 13 }, (_, i) =>
        w(`W${i}`, `2026-01-${String(i + 1).padStart(2, '0')}`, '2026-12-31'),
      ),
      /at most 12/,
    );
  });

  test('rejects blank, whitespace-only and over-long labels', () => {
    rejects400([w('', '2026-01-01', '2026-01-02')], /label/);
    rejects400([w('   ', '2026-01-01', '2026-01-02')], /label/);
    rejects400([w('x'.repeat(61), '2026-01-01', '2026-01-02')], /label/);
    assert.equal(
      validateTransferWindows([w('x'.repeat(60), '2026-01-01', '2026-01-02')]).length,
      1,
    );
  });

  test('rejects malformed and impossible dates', () => {
    rejects400([w('A', '2026-1-01', '2026-01-02')], /start/);
    rejects400([w('A', '2026-01-01T00:00:00Z', '2026-01-02')], /start/);
    rejects400([w('A', '2026-02-30', '2026-03-02')], /start/);
    rejects400([w('A', '2026-01-01', '2026-13-01')], /end/);
    rejects400([{ label: 'A', start: '2026-01-01', end: 20260102 }], /end/);
  });

  test('rejects start after end', () => {
    rejects400([w('A', '2026-02-02', '2026-02-01')], /on or before/);
  });

  test('rejects unknown keys and non-object entries', () => {
    rejects400([{ ...w('A', '2026-01-01', '2026-01-02'), open: true }], /unknown field "open"/);
    rejects400(['2026-01-01'], /must be an object/);
    rejects400([null], /must be an object/);
  });
});

describe('transferWindowStatus', () => {
  const windows = [
    w('Pre-season', '2026-08-01', '2026-09-30'),
    w('Mid', '2027-01-05', '2027-01-20'),
  ];

  test('no windows ⇒ open', () => {
    assert.deepEqual(transferWindowStatus(undefined, '2026-10-06'), { open: true });
    assert.deepEqual(transferWindowStatus([], '2026-10-06'), { open: true });
  });

  test('inclusive at both ends', () => {
    assert.equal(transferWindowStatus(windows, '2026-08-01').open, true);
    assert.equal(transferWindowStatus(windows, '2026-09-30').open, true);
    assert.equal(transferWindowStatus(windows, '2026-07-31').open, false);
    assert.equal(transferWindowStatus(windows, '2026-10-01').open, false);
  });

  test('open carries the current window; closed carries the next one', () => {
    assert.deepEqual(transferWindowStatus(windows, '2026-09-01'), {
      open: true,
      current: windows[0],
      next: windows[1],
    });
    assert.deepEqual(transferWindowStatus(windows, '2026-10-06'), {
      open: false,
      next: windows[1],
    });
    assert.deepEqual(transferWindowStatus(windows, '2027-02-01'), { open: false });
  });

  test('unsorted input is handled', () => {
    assert.deepEqual(transferWindowStatus([windows[1], windows[0]], '2026-07-01').next, windows[0]);
  });
});

describe('SAST day boundary (UTC+2)', () => {
  // The window's last day is 2026-09-30 in SAST, i.e. until 2026-09-30T21:59:59Z.
  const windows = [w('Pre-season', '2026-08-01', '2026-09-30')];
  const cfg = { transferWindows: windows };

  test('21:59 UTC on the last day is still inside (23:59 SAST)', () => {
    const now = new Date('2026-09-30T21:59:00Z');
    assert.equal(tenantToday(now), '2026-09-30');
    assert.equal(closedTransferWindow(cfg, tenantToday(now)), null);
  });

  test('22:00 UTC is already the next SAST day — closed, though UTC still says the 30th', () => {
    const now = new Date('2026-09-30T22:00:00Z');
    assert.equal(now.toISOString().slice(0, 10), '2026-09-30');
    assert.equal(tenantToday(now), '2026-10-01');
    assert.equal(closedTransferWindow(cfg, tenantToday(now))?.open, false);
  });

  test('a window opens at 22:00 UTC the evening before its start date', () => {
    assert.equal(tenantToday(new Date('2026-07-31T21:59:00Z')), '2026-07-31');
    assert.equal(
      closedTransferWindow(cfg, tenantToday(new Date('2026-07-31T21:59:00Z')))?.open,
      false,
    );
    assert.equal(tenantToday(new Date('2026-07-31T22:00:00Z')), '2026-08-01');
    assert.equal(closedTransferWindow(cfg, tenantToday(new Date('2026-07-31T22:00:00Z'))), null);
  });
});

describe('closedTransferWindow / closedPeriodStart / messages', () => {
  test('no config, absent or empty windows ⇒ never closed', () => {
    assert.equal(closedTransferWindow(null, '2026-10-06'), null);
    assert.equal(closedTransferWindow({}, '2026-10-06'), null);
    assert.equal(closedTransferWindow({ transferWindows: [] }, '2026-10-06'), null);
  });

  test('the closed stretch starts the day after the latest ended window', () => {
    const windows = [w('A', '2026-01-01', '2026-01-31'), w('B', '2026-06-01', '2026-06-30')];
    assert.equal(closedPeriodStart(windows, '2026-10-06'), '2026-07-01');
    assert.equal(closedPeriodStart(windows, '2026-03-01'), '2026-02-01');
    assert.equal(closedPeriodStart(windows, '2025-12-01'), undefined);
    // Month/year rollover.
    assert.equal(
      closedPeriodStart([w('Y', '2026-12-01', '2026-12-31')], '2027-01-10'),
      '2027-01-01',
    );
  });

  test('reasons name the next window, or say none is configured', () => {
    const next = w('Mid', '2027-01-05', '2027-01-20');
    assert.equal(
      windowClosedRejectReason(next),
      'Outside transfer window — next window: Mid (2027-01-05 – 2027-01-20)',
    );
    assert.equal(
      windowClosedRejectReason(undefined),
      'Outside transfer window — no upcoming window configured',
    );
    assert.match(transfersClosedMessage(next), /^transfers are closed — next window: Mid/);
    assert.match(transfersClosedMessage(undefined), /no upcoming transfer window/);
  });
});
