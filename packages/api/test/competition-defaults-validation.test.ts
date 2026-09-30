/**
 * validateCompetitionDefaults — the shape guard both config PUTs run on
 * `TenantConfig.competitionDefaults` (ADR 0014). Only `venueAliases` and `travel` survive
 * (config-only); the format fields reverted to built-ins.
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
  test('accepts the surviving fields and returns them normalised', () => {
    const out = validateCompetitionDefaults({
      travel: { costPerKm: 5.2, carsPerAwayTrip: 0 },
      venueAliases: { 'Riverside Bowl': ' riversideoval ' },
    });
    assert.deepEqual(out, {
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

  test('the retired matchFormats/matchDays/timeSlots are neither validated nor kept', () => {
    // Values the old guard refused are no longer a 400 — the fields revert to built-ins,
    // so an old console sending them saves cleanly and they are simply not stored.
    const out = validateCompetitionDefaults({
      matchFormats: [{ label: '  ', overs: 0 }],
      matchDays: [7, 7],
      timeSlots: [{ label: '', start: '8am' }],
      travel: { costPerKm: 4.5, carsPerAwayTrip: 3 },
    });
    assert.deepEqual(out, { travel: { costPerKm: 4.5, carsPerAwayTrip: 3 } });
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
