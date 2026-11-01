/**
 * Unit tests for the scorer-register import (parse + plan). Pure — no repo, no workbook file:
 * rows are built in-test with invented names/numbers (no real PII). ID numbers are synthetic
 * values constructed to pass/fail the SA Luhn check.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidSaId,
  normaliseIdNumber,
  normalisePhone,
  parseScorerRows,
  planScorerImport,
  titleCase,
} from '../src/import-scorers.js';
import type { Scorer } from '../src/types.js';
import type { Cell } from '../src/import-scorers.js';

/** Append the Luhn check digit to 12 digits. */
function withCheck(d12: string): string {
  for (let c = 0; c <= 9; c++) if (isValidSaId(d12 + c)) return d12 + c;
  throw new Error('unreachable');
}
const VALID = withCheck('900101500008');
const VALID_LEADING_ZERO = withCheck('050101500008');
const INVALID = VALID.slice(0, 12) + String((Number(VALID[12]) + 1) % 10);

const sheet = (data: Cell[][]): Cell[][] => [
  [null, null, null, null, 'Test Scorers Database', null, null],
  [],
  [
    'No ',
    'Name ',
    null,
    'ID Number ',
    'Contact Number',
    'Emergency contact number ',
    'Home address',
  ],
  ...data,
  [null, null, null, null, null, null, null],
  [],
];

describe('normalisers', () => {
  test('titleCase', () => {
    assert.equal(titleCase('  tESTY   mc-person '), 'Testy Mc-Person');
  });
  test('ID: numeric cell, spaces, lost leading zero, Luhn, passport', () => {
    assert.deepEqual(normaliseIdNumber(Number(VALID)), { value: VALID });
    assert.deepEqual(normaliseIdNumber(VALID.replace(/(\d{6})(\d{4})/, '$1 $2 ')), {
      value: VALID,
    });
    assert.deepEqual(normaliseIdNumber(Number(VALID_LEADING_ZERO)), { value: VALID_LEADING_ZERO });
    assert.equal(normaliseIdNumber(INVALID).flag, 'ID fails SA check digit');
    assert.deepEqual(normaliseIdNumber('ZZ 123456'), {
      value: 'ZZ123456',
      flag: 'ID is not an SA ID',
    });
    assert.deepEqual(normaliseIdNumber(null), {});
  });
  test('phones become +27', () => {
    assert.deepEqual(normalisePhone('071 000 0001'), { value: '+27710000001' });
    assert.deepEqual(normalisePhone(710000001), { value: '+27710000001' });
    assert.deepEqual(normalisePhone('+27 71 000 0001'), { value: '+27710000001' });
    assert.deepEqual(normalisePhone(''), {});
    assert.equal(normalisePhone('12345').flag, 'odd phone "12345"');
  });
});

describe('parseScorerRows', () => {
  const rows = parseScorerRows(
    sheet([
      [1, 'alpha', 'ONE', Number(VALID), '071 000 0001', '072 000 0009', '1 Test Road'],
      [2, 'beta', 'two', null, '071 000 0002', '072 000 0009', '1 test road '],
      [3, 'gamma', 'three', 'ZZ123456', '071 000 0003', null, null],
    ]),
    10,
  );
  test('skips nameless rows, normalises, omits missing values', () => {
    assert.equal(rows.length, 3);
    assert.equal(rows[0].displayName, 'Alpha One');
    assert.equal(rows[0].line, 13);
    assert.equal(rows[0].idNumber, VALID);
    assert.equal(rows[0].phone, '+27710000001');
    assert.equal(rows[1].idNumber, undefined);
    assert.equal(rows[2].emergencyPhone, undefined);
    assert.equal('address' in rows[2], false);
  });
  test('flags missing / non-SA IDs and shared emergency numbers / addresses', () => {
    assert.ok(rows[1].flags.includes('no ID'));
    assert.ok(rows[2].flags.includes('ID is not an SA ID'));
    assert.ok(rows[0].flags.includes('emergency no. shared with row 14'));
    assert.ok(rows[1].flags.includes('address shared with row 13'));
    assert.equal(
      rows[2].flags.some((f) => f.includes('shared')),
      false,
    );
  });
});

describe('planScorerImport', () => {
  const at = '2026-11-01T00:00:00.000Z';
  const rows = parseScorerRows(
    sheet([
      [1, 'alpha', 'one', Number(VALID), '071 000 0001', '072 000 0001', '1 Test Road'],
      [2, 'beta', 'two', null, '071 000 0002', null, null],
      [3, 'gamma', 'three', null, '071 000 0003', null, null],
    ]),
  );
  const existing: Scorer[] = [
    // Same name as row 1, with a phone already set to something else.
    { id: 's-alpha-one', displayName: 'ALPHA ONE', phone: '+27999999999', active: true },
    // Retired scorer whose id collides with row 2's stem.
    { id: 's-beta-two', displayName: 'Beta Two', active: false },
  ];

  test('fills blanks only, never overwrites, suffixes id collisions', () => {
    const plan = planScorerImport(rows, existing, at);
    assert.deepEqual(
      plan.map((p) => p.action),
      ['update', 'create', 'create'],
    );
    const [a, b] = plan;
    assert.equal(a.scorer.id, 's-alpha-one');
    assert.equal(a.scorer.phone, '+27999999999');
    assert.deepEqual(a.conflicts, ['phone']);
    assert.deepEqual(a.filled.sort(), ['address', 'emergencyPhone', 'fullName', 'idNumber']);
    assert.equal(b.scorer.id, 's-beta-two-2');
    assert.equal(b.scorer.fullName, 'Beta Two');
  });

  test('idempotent: re-planning against the result makes no writes', () => {
    const first = planScorerImport(rows, existing, at);
    const after = [
      ...existing.filter((e) => e.id !== 's-alpha-one'),
      ...first.map((p) => p.scorer),
    ];
    const again = planScorerImport(rows, after, at);
    assert.deepEqual(
      again.map((p) => p.action),
      ['noop', 'noop', 'noop'],
    );
  });
});
