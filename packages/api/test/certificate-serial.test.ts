/**
 * Certificate serials: format, charset, entropy spread, the retype-tolerant normaliser, and the
 * public ID mask.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  crockfordEncode,
  maskIdNumber,
  newSerial,
  normaliseSerial,
  SERIAL_PREFIX,
} from '../src/certificates/serial.js';

const FORMAT =
  /^SC-TRF-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;

describe('newSerial', () => {
  test('is SC-TRF- plus four groups of five Crockford characters (no I, L, O, U)', () => {
    for (let i = 0; i < 200; i++) {
      const s = newSerial();
      assert.match(s, FORMAT);
      assert.ok(!/[ILOU]/.test(s.slice(SERIAL_PREFIX.length)));
    }
  });

  test('never mints a body that could be mistaken for the prefix when retyped', () => {
    for (let i = 0; i < 2000; i++) {
      const s = newSerial();
      assert.equal(normaliseSerial(s.replace(/-/g, '')), s);
    }
  });

  test('does not repeat across many draws', () => {
    const seen = new Set(Array.from({ length: 5000 }, () => newSerial()));
    assert.equal(seen.size, 5000);
  });
});

describe('crockfordEncode', () => {
  test('encodes the top bits big-endian', () => {
    assert.equal(crockfordEncode(new Uint8Array([0, 0]), 3), '000');
    assert.equal(crockfordEncode(new Uint8Array([0xff, 0xff]), 3), 'ZZZ');
    // 0b00001_00010_… → '1', '2'
    assert.equal(crockfordEncode(new Uint8Array([0b00001000, 0b10000000]), 2), '12');
  });

  test('refuses to read past the input', () => {
    assert.throws(() => crockfordEncode(new Uint8Array([1]), 4));
  });
});

describe('normaliseSerial', () => {
  const s = 'SC-TRF-ABCDE-FGH1K-MN0QR-STVWX';

  test('round-trips a canonical serial', () => {
    assert.equal(normaliseSerial(s), s);
  });

  test('accepts lowercase, no hyphens, spaces, and a missing prefix', () => {
    assert.equal(normaliseSerial(s.toLowerCase()), s);
    assert.equal(normaliseSerial('SCTRFABCDEFGH1KMN0QRSTVWX'), s);
    assert.equal(normaliseSerial('abcde fgh1k mn0qr stvwx'), s);
    assert.equal(normaliseSerial('ABCDEFGH1KMN0QRSTVWX'), s);
  });

  test('maps Crockford aliases O→0 and I/L→1', () => {
    assert.equal(normaliseSerial('SC-TRF-ABCDE-FGHIK-MNOQR-STVWX'), s);
    assert.equal(normaliseSerial('SC-TRF-ABCDE-FGHLK-MNoQR-STVWX'), s);
  });

  test('rejects wrong length, U, and junk', () => {
    assert.equal(normaliseSerial('SC-TRF-ABCDE-FGH1K-MN0QR-STVW'), null);
    assert.equal(normaliseSerial('SC-TRF-ABCDE-FGH1K-MN0QR-STVWXY'), null);
    assert.equal(normaliseSerial('SC-TRF-ABCDE-FGH1K-MN0QR-STVWU'), null);
    assert.equal(normaliseSerial('../../etc/passwd'), null);
    assert.equal(normaliseSerial(''), null);
  });
});

describe('maskIdNumber', () => {
  test('keeps the first 2 and last 3 characters', () => {
    assert.equal(maskIdNumber('9001015009087'), '90********087');
    assert.equal(maskIdNumber('A1234567'), 'A1***567');
  });

  test('fully masks short values and blanks empty ones', () => {
    assert.equal(maskIdNumber('12345'), '*****');
    assert.equal(maskIdNumber(''), '');
    assert.equal(maskIdNumber(undefined), '');
  });
});
