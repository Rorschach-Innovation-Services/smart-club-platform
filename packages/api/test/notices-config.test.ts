/**
 * The operator-only notice keys' validators (notices-config.ts): the officials contact line and
 * the scorecard-correction recipients, plus the per-role contact-line resolution.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OFFICIALS_CONTACT_LINE,
  officialsContactLineFor,
  validateOfficialsContactLine,
  validateScorecardCorrectionRecipients,
} from '../src/notices-config.js';

const status = (fn: () => unknown): number | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { status?: number }).status;
  }
};

describe('validateOfficialsContactLine', () => {
  test('trims; empty is allowed (falls back to the default)', () => {
    assert.equal(
      validateOfficialsContactLine('  Titans umpire - 083 709 2976 '),
      'Titans umpire - 083 709 2976',
    );
    assert.equal(validateOfficialsContactLine('   '), '');
  });

  test('120 characters is the limit (after trimming); non-strings are rejected', () => {
    assert.equal(validateOfficialsContactLine(` ${'x'.repeat(120)} `).length, 120);
    assert.equal(
      status(() => validateOfficialsContactLine('x'.repeat(121))),
      400,
    );
    assert.equal(
      status(() => validateOfficialsContactLine(null)),
      400,
    );
    assert.equal(
      status(() => validateOfficialsContactLine(5)),
      400,
    );
  });
});

describe('validateScorecardCorrectionRecipients', () => {
  test('lower-cases, trims, dedupes in first-seen order, drops blanks', () => {
    assert.deepEqual(
      validateScorecardCorrectionRecipients([
        ' Jooma@Dolphins.co.za',
        '',
        'kershen@x.co',
        'jooma@dolphins.co.za',
      ]),
      ['jooma@dolphins.co.za', 'kershen@x.co'],
    );
    assert.deepEqual(validateScorecardCorrectionRecipients([]), []);
  });

  test('rejects non-arrays, non-strings and malformed addresses', () => {
    for (const bad of ['a@b.co', null, {}, [1], ['nope'], ['a@b'], ['a b@c.co']]) {
      assert.equal(
        status(() => validateScorecardCorrectionRecipients(bad)),
        400,
        JSON.stringify(bad),
      );
    }
  });

  test('at most 10 distinct addresses (duplicates do not count)', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `r${i}@x.co`);
    assert.equal(validateScorecardCorrectionRecipients([...ten, 'R0@x.co']).length, 10);
    assert.equal(
      status(() => validateScorecardCorrectionRecipients([...ten, 'r10@x.co'])),
      400,
    );
  });
});

describe('officialsContactLineFor', () => {
  test('umpires/referees get the tenant line, else the default; scorers always the default', () => {
    assert.equal(DEFAULT_OFFICIALS_CONTACT_LINE, 'Medicoach - 066 344 6443');
    const cfg = { officialsContactLine: 'Titans umpire - 083 709 2976' };
    assert.equal(officialsContactLineFor(cfg, 'umpire'), 'Titans umpire - 083 709 2976');
    assert.equal(officialsContactLineFor(cfg, 'referee'), 'Titans umpire - 083 709 2976');
    assert.equal(officialsContactLineFor(cfg, 'scorer'), DEFAULT_OFFICIALS_CONTACT_LINE);
    assert.equal(officialsContactLineFor({}, 'umpire'), DEFAULT_OFFICIALS_CONTACT_LINE);
    assert.equal(
      officialsContactLineFor({ officialsContactLine: '  ' }, 'referee'),
      DEFAULT_OFFICIALS_CONTACT_LINE,
    );
  });
});
