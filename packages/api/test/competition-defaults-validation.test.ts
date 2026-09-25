/**
 * validateCompetitionDefaults — the shape guard both config PUTs run on
 * `TenantConfig.competitionDefaults` (ADR 0014).
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateCompetitionDefaults } from '../src/config-validation.js';
import { HttpError } from '../src/auth.js';

const rejects = (value: unknown, message: RegExp) =>
  assert.throws(
    () => validateCompetitionDefaults(value),
    (err: unknown) => err instanceof HttpError && err.status === 400 && message.test(err.message),
  );

describe('validateCompetitionDefaults', () => {
  test('accepts a full object and returns it trimmed, with absent fields left absent', () => {
    const out = validateCompetitionDefaults({
      matchFormats: [
        { label: ' 50 Over (Red Ball) ', overs: 50, ballType: ' Red ' },
        { label: 'Multi-Day' },
      ],
      matchDays: [0, 6],
      timeSlots: [{ label: ' Morning ', start: '08:00' }],
      travel: { costPerKm: 5.2, carsPerAwayTrip: 0 },
      venueAliases: { 'Riverside Bowl': ' riversideoval ' },
    });
    assert.deepEqual(out, {
      matchFormats: [
        { label: '50 Over (Red Ball)', overs: 50, ballType: 'Red' },
        { label: 'Multi-Day' },
      ],
      matchDays: [0, 6],
      timeSlots: [{ label: 'Morning', start: '08:00' }],
      travel: { costPerKm: 5.2, carsPerAwayTrip: 0 },
      venueAliases: { riversidebowl: 'riversideoval' },
    });
    assert.deepEqual(validateCompetitionDefaults({}), {});
  });

  test('rejects a non-object', () => {
    rejects(null, /must be an object/);
    rejects([], /must be an object/);
    rejects('x', /must be an object/);
  });

  test('match formats: label non-blank and ≤60, overs a whole number 1–200, ball type ≤30', () => {
    rejects({ matchFormats: {} }, /must be an array/);
    rejects({ matchFormats: [{ label: '  ' }] }, /needs a label/);
    rejects({ matchFormats: [{ label: 'x'.repeat(61) }] }, /60 characters/);
    rejects({ matchFormats: [{ label: 'T20', overs: 0 }] }, /between 1 and 200/);
    rejects({ matchFormats: [{ label: 'T20', overs: 201 }] }, /between 1 and 200/);
    rejects({ matchFormats: [{ label: 'T20', overs: 20.5 }] }, /between 1 and 200/);
    rejects({ matchFormats: [{ label: 'T20', ballType: 'x'.repeat(31) }] }, /30 characters/);
    rejects({ matchFormats: [{ label: 'T20', ballType: 3 }] }, /ball type must be text/);
  });

  test('match days: weekdays 0–6, no repeats', () => {
    rejects({ matchDays: [7] }, /0 \(Sunday\) to 6/);
    rejects({ matchDays: [-1] }, /0 \(Sunday\) to 6/);
    rejects({ matchDays: [6, 6] }, /must not repeat/);
    rejects({ matchDays: 6 }, /must be an array/);
  });

  test('time slots: the same HH:MM rule as a stage’s slots', () => {
    rejects({ timeSlots: [{ label: 'Morning', start: '8am' }] }, /HH:MM/);
    rejects({ timeSlots: [{ label: '', start: '08:00' }] }, /needs a label/);
  });

  test('travel: both numbers present and 0 or more', () => {
    rejects({ travel: { costPerKm: -1, carsPerAwayTrip: 3 } }, /0 or more/);
    rejects({ travel: { costPerKm: 4.5 } }, /0 or more/);
    rejects({ travel: null }, /0 or more/);
  });

  test('venue aliases: non-blank string keys and values, at most 500', () => {
    rejects({ venueAliases: [] }, /must be an object/);
    rejects({ venueAliases: { a: '' } }, /needs a ground name/);
    rejects({ venueAliases: { a: 3 } }, /needs a ground name/);
    rejects({ venueAliases: { ' ': 'b' } }, /needs a ground name/);
    // "CC" is a generic word the normaliser drops, so it could never be looked up.
    rejects({ venueAliases: { CC: 'b' } }, /needs a ground name/);
    const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`g${i}`, 'x']));
    rejects({ venueAliases: many }, /no more than 500/);
  });
});
