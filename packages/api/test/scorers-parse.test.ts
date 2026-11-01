/**
 * Unit tests for the scorer register's PII fields (idNumber, emergencyPhone, address) in
 * parseScorerInput / applyScorerInput. Pure — no repo. Synthetic values only.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyScorerInput, parseScorerInput } from '../src/scorers.js';

describe('scorer PII fields', () => {
  test('parses, trims and clears idNumber / emergencyPhone / address', () => {
    const input = parseScorerInput(
      {
        displayName: 'Test Person',
        idNumber: ' 0001010000000 ',
        emergencyPhone: '+27820000000',
        address: ' 1 Test Road ',
      },
      'create',
    );
    assert.equal(input.idNumber, '0001010000000');
    assert.equal(input.emergencyPhone, '+27820000000');
    assert.equal(input.address, '1 Test Road');
    const cleared = parseScorerInput(
      { idNumber: null, emergencyPhone: '', address: undefined },
      'patch',
    );
    assert.deepEqual(cleared, { idNumber: null, emergencyPhone: null });
  });

  test('enforces max lengths and string type', () => {
    assert.throws(
      () => parseScorerInput({ idNumber: 'x'.repeat(21) }, 'patch'),
      /idNumber is too long/,
    );
    assert.throws(
      () => parseScorerInput({ emergencyPhone: '1'.repeat(31) }, 'patch'),
      /emergencyPhone is too long/,
    );
    assert.throws(
      () => parseScorerInput({ address: 'a'.repeat(201) }, 'patch'),
      /address is too long/,
    );
    assert.throws(() => parseScorerInput({ idNumber: 123 }, 'patch'), /idNumber must be a string/);
    assert.doesNotThrow(() => parseScorerInput({ address: 'a'.repeat(200) }, 'patch'));
  });

  test('applyScorerInput sets and deletes the new fields', () => {
    const at = '2026-11-01T00:00:00.000Z';
    const s = applyScorerInput(
      undefined,
      { displayName: 'A B', idNumber: 'X1', emergencyPhone: '+27820000001', address: 'Somewhere' },
      's-a-b',
      at,
    );
    assert.equal(s.idNumber, 'X1');
    assert.equal(s.address, 'Somewhere');
    const next = applyScorerInput(s, { address: null, idNumber: 'X2' }, s.id, at);
    assert.equal(next.address, undefined);
    assert.equal('address' in next, false);
    assert.equal(next.idNumber, 'X2');
    assert.equal(next.emergencyPhone, '+27820000001');
  });
});
