/**
 * Unit tests for the club-signup pure helpers:
 *
 * - normalizeZaCell (src/api.js): the client copy of the shared ZA cell rule —
 *   every accepted variant must land on the canonical 0XXXXXXXXX form (what
 *   waNumber/toE164 expect) and everything else must be null, never a partial
 *   normalization the server could disagree with.
 * - signupDoneCta (src/ClubSignupPage.jsx): which CTA the done view offers a
 *   signed-in visitor — admin console, the freshly registered club, or the
 *   plain sign-in fallback.
 */
import { describe, it, expect } from 'vitest';
import { normalizeZaCell } from './api';
import { signupDoneCta } from './ClubSignupPage';

describe('normalizeZaCell', () => {
  it.each([
    ['083 555 0001', '0835550001'],
    ['27835550001', '0835550001'],
    ['+27 83-555-0001', '0835550001'],
    ['(083) 555 0001', '0835550001'],
  ])('normalizes %s → %s', (raw, expected) => {
    expect(normalizeZaCell(raw)).toBe(expected);
  });

  it.each([
    ['12345'], // too short
    ['abc'], // not a number
    ['0935550001'], // 09x is outside the [6-8] mobile superset
    ['08355500012'], // too long
    [''], // empty
  ])('rejects %s', (raw) => {
    expect(normalizeZaCell(raw)).toBeNull();
  });
});

describe('signupDoneCta', () => {
  const clubId = 'kingsmead-cc';

  it('admin membership → admin console CTA', () => {
    expect(signupDoneCta({ role: 'admin', clubIds: [] }, clubId)).toBe('admin');
  });

  it('rep whose clubIds include the new club → club CTA', () => {
    expect(signupDoneCta({ role: 'rep', clubIds: ['other-cc', clubId] }, clubId)).toBe('club');
  });

  it('rep without the new club (refresh not landed) → sign-in fallback', () => {
    expect(signupDoneCta({ role: 'rep', clubIds: ['other-cc'] }, clubId)).toBeNull();
  });

  it('no membership (signed out / wrong tenant) → sign-in fallback', () => {
    expect(signupDoneCta(null, clubId)).toBeNull();
  });
});
