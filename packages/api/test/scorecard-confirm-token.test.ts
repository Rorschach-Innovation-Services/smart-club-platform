/**
 * Scorecard-confirmation link tokens and week helpers. The token is a bearer capability: it
 * must verify only with the right key, before expiry, and ONLY as a scorecard token — a
 * captain's-report token signed with the same secret must never verify here, nor the reverse.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  signScorecardLinkToken,
  verifyScorecardLinkToken,
  scorecardLinkExpiry,
  weekKeyFor,
  windowForWeekKey,
  lastCompletedWeekKey,
  weekLabel,
  isWeekKey,
  parseScorecardAnswer,
  ScorecardInputError,
} = await import('../src/scorecard-confirmations.js');
const { signReportLinkToken, verifyReportLinkToken } = await import('../src/captains-reports.js');
const { scrubReportTokens } = await import('../src/instrument.js');

const payload = { t: 'dolphins', w: '2026-10-11', c: 'umzinto', m: 'member-1', e: 2_000_000_000 };
const NOW = 1_000_000_000_000;

describe('scorecard link tokens', () => {
  test('verify with the same key, fail with another key or after expiry', () => {
    const token = signScorecardLinkToken(payload, 'k1');
    const ok = verifyScorecardLinkToken(token, 'k1', NOW);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.ok && ok.payload, payload);
    assert.deepEqual(verifyScorecardLinkToken(token, 'k2', NOW), { ok: false, reason: 'invalid' });
    assert.deepEqual(verifyScorecardLinkToken(token, 'k1', 2_000_000_001_000), {
      ok: false,
      reason: 'expired',
    });
    assert.equal(verifyScorecardLinkToken(`${token}.x`, 'k1', NOW).ok, false);
    assert.equal(verifyScorecardLinkToken('', 'k1', NOW).ok, false);
    assert.equal(verifyScorecardLinkToken('a'.repeat(700), 'k1', NOW).ok, false);
  });

  test('a tampered payload or signature is rejected', () => {
    const token = signScorecardLinkToken(payload, 'k1');
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, c: 'other-club' })).toString(
      'base64url',
    );
    assert.deepEqual(verifyScorecardLinkToken(`${forged}.${sig}`, 'k1', NOW), {
      ok: false,
      reason: 'invalid',
    });
    const flipped = sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA');
    assert.equal(verifyScorecardLinkToken(`${body}.${flipped}`, 'k1', NOW).ok, false);
  });

  test("CROSS-CONTEXT: a captain's-report token never verifies as a scorecard token", () => {
    // Same secret, and a payload that even carries every scorecard field.
    const report = signReportLinkToken(
      { t: 'dolphins', r: 's1~f1~umzinto', m: 'member-1', e: 2_000_000_000 },
      'k1',
    );
    assert.deepEqual(verifyScorecardLinkToken(report, 'k1', NOW), {
      ok: false,
      reason: 'invalid',
    });
    const lookalike = signReportLinkToken(
      { ...payload, r: 'x' } as unknown as Parameters<typeof signReportLinkToken>[0],
      'k1',
    );
    assert.equal(verifyScorecardLinkToken(lookalike, 'k1', NOW).ok, false);
  });

  test("CROSS-CONTEXT: a scorecard token never verifies as a captain's-report token", () => {
    const sc = signScorecardLinkToken(payload, 'k1');
    assert.deepEqual(verifyReportLinkToken(sc, 'k1', NOW), { ok: false, reason: 'invalid' });
  });

  test('the link expires at 23:59:59 SAST fourteen days after creation', () => {
    // 2026-10-12T05:00Z = Mon 07:00 SAST → expires Mon 26 Oct 23:59:59 SAST = 21:59:59Z.
    const exp = scorecardLinkExpiry(Date.parse('2026-10-12T05:00:00Z'));
    assert.equal(new Date(exp * 1000).toISOString(), '2026-10-26T21:59:59.000Z');
    // 23:30 UTC on the 11th is already the 12th in SAST.
    const late = scorecardLinkExpiry(Date.parse('2026-10-11T23:30:00Z'));
    assert.equal(new Date(late * 1000).toISOString(), '2026-10-26T21:59:59.000Z');
  });

  test('tokens on /sc/ and /scorecard-confirm-link/ paths are scrubbed for Sentry', () => {
    assert.equal(
      scrubReportTokens('https://x.test/sc/abc.def?x=1'),
      'https://x.test/sc/[token]?x=1',
    );
    assert.equal(
      scrubReportTokens('/scorecard-confirm-link/abc.def/fixtures/s1/f1'),
      '/scorecard-confirm-link/[token]/fixtures/s1/f1',
    );
  });
});

describe('weeks (Mon–Sun, keyed by the Sunday)', () => {
  test('weekKeyFor maps every day of the week to its Sunday', () => {
    assert.equal(weekKeyFor('2026-10-05'), '2026-10-11'); // Mon
    assert.equal(weekKeyFor('2026-10-08'), '2026-10-11'); // Thu
    assert.equal(weekKeyFor('2026-10-11'), '2026-10-11'); // Sun
    assert.equal(weekKeyFor('2026-10-12'), '2026-10-18'); // next Mon
  });

  test('month and year boundaries', () => {
    assert.equal(weekKeyFor('2026-09-29'), '2026-10-04');
    assert.deepEqual(windowForWeekKey('2026-10-04'), ['2026-09-28', '2026-10-04']);
    assert.equal(weekKeyFor('2025-12-29'), '2026-01-04');
    assert.deepEqual(windowForWeekKey('2026-01-04'), ['2025-12-29', '2026-01-04']);
    assert.equal(weekKeyFor('2024-02-29'), '2024-03-03'); // leap day
  });

  test('labels', () => {
    assert.equal(weekLabel('2026-10-11'), '5–11 Oct 2026');
    assert.equal(weekLabel('2026-10-04'), '28 Sep – 4 Oct 2026');
    assert.equal(weekLabel('2026-01-04'), '29 Dec 2025 – 4 Jan 2026');
  });

  test('the most recent COMPLETED week, in SAST', () => {
    // Monday 07:00 SAST → the week that ended yesterday.
    assert.equal(lastCompletedWeekKey(new Date('2026-10-12T05:00:00Z')), '2026-10-11');
    // Sunday 22:30 UTC is already Monday in SAST.
    assert.equal(lastCompletedWeekKey(new Date('2026-10-11T22:30:00Z')), '2026-10-11');
    // Sunday afternoon SAST: this week is still running.
    assert.equal(lastCompletedWeekKey(new Date('2026-10-11T12:00:00Z')), '2026-10-04');
  });

  test('isWeekKey accepts Sundays only', () => {
    assert.equal(isWeekKey('2026-10-11'), true);
    assert.equal(isWeekKey('2026-10-12'), false);
    assert.equal(isWeekKey('2026-02-30'), false);
    assert.equal(isWeekKey('11-10-2026'), false);
    assert.equal(isWeekKey(20261011), false);
  });
});

describe('answer parsing', () => {
  test('confirm, correction with feedback, and the 2,000-char cap', () => {
    assert.deepEqual(parseScorecardAnswer({ action: 'confirm' }), { action: 'confirm' });
    assert.deepEqual(parseScorecardAnswer({ action: 'correction', feedback: '  wrong total ' }), {
      action: 'correction',
      feedback: 'wrong total',
    });
    assert.throws(() => parseScorecardAnswer({ action: 'correction' }), ScorecardInputError);
    assert.throws(
      () => parseScorecardAnswer({ action: 'correction', feedback: '   ' }),
      ScorecardInputError,
    );
    assert.throws(
      () => parseScorecardAnswer({ action: 'correction', feedback: 'x'.repeat(2001) }),
      ScorecardInputError,
    );
    assert.equal(
      parseScorecardAnswer({ action: 'correction', feedback: 'x'.repeat(2000) }).feedback?.length,
      2000,
    );
    assert.throws(() => parseScorecardAnswer({ action: 'approve' }), ScorecardInputError);
    assert.throws(() => parseScorecardAnswer(null), ScorecardInputError);
  });
});
