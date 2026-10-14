/**
 * The public registration page's failure copy: a 409 keeps the collapsed duplicate wording (plus
 * a next step), specific 4xx answers pass through, and anything else names the step that failed
 * instead of surfacing a bare "internal error".
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { registrationErrorMessage } from './RegisterPage';

describe('registrationErrorMessage', () => {
  it('a 409 keeps the collapsed duplicate wording and adds a next step', () => {
    const msg = registrationErrorMessage(new ApiError(409, 'already registered'), 'submit');
    expect(msg).toMatch(
      /^This person is already registered, or a transfer is already in progress\./,
    );
    expect(msg).toMatch(/Contact your club or the union office if you think this is wrong\./);
  });

  it('a specific 4xx answer is shown as sent', () => {
    expect(registrationErrorMessage(new ApiError(429, 'too many uploads'), 'upload')).toBe(
      'too many uploads',
    );
    expect(registrationErrorMessage(new ApiError(400, 'gender is required'), 'submit')).toBe(
      'gender is required',
    );
  });

  it('a 5xx / network failure names the step that failed', () => {
    expect(registrationErrorMessage(new ApiError(500, 'internal error'), 'upload')).toBe(
      "We couldn't upload your ID document — please try again.",
    );
    expect(registrationErrorMessage(new TypeError('Failed to fetch'), 'upload')).toBe(
      "We couldn't upload your ID document — please try again.",
    );
    expect(registrationErrorMessage(new ApiError(500, 'internal error'), 'submit')).toBe(
      'Something went wrong submitting your registration — please try again.',
    );
  });

  it('a failed storage PUT reads as an upload failure even when it is a 4xx', () => {
    expect(registrationErrorMessage(new ApiError(403, 'upload failed'), 'upload')).toBe(
      "We couldn't upload your ID document — please try again.",
    );
  });
});
