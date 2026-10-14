/**
 * Captain's-report link tokens and their redaction: the token is a bearer capability, so it
 * must verify only with the right key and before expiry, and must never survive into a
 * Sentry event or breadcrumb.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { signReportLinkToken, verifyReportLinkToken, parseCaptainsReportId, captainsReportId } =
  await import('../src/captains-reports.js');
const { scrubReportTokens, scrubEvent } = await import('../src/instrument.js');

const payload = { t: 'dolphins', r: 's1~f1~club', m: 'member-1', e: 2_000_000_000 };

describe('report link tokens', () => {
  test('verify with the same key, fail with another or after expiry', () => {
    const token = signReportLinkToken(payload, 'k1');
    const ok = verifyReportLinkToken(token, 'k1', 1_000_000_000_000);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.ok && ok.payload, payload);
    assert.deepEqual(verifyReportLinkToken(token, 'k2', 1_000_000_000_000), {
      ok: false,
      reason: 'invalid',
    });
    assert.deepEqual(verifyReportLinkToken(token, 'k1', 2_000_000_001_000), {
      ok: false,
      reason: 'expired',
    });
    assert.equal(verifyReportLinkToken(`${token}.x`, 'k1', 0).ok, false);
    assert.equal(verifyReportLinkToken('', 'k1', 0).ok, false);
  });

  test('report ids round-trip and reject junk', () => {
    const id = captainsReportId('s-planb-premier-men-t20-g1', 'f3', 'umzinto');
    assert.deepEqual(parseCaptainsReportId(id), {
      seriesId: 's-planb-premier-men-t20-g1',
      fixtureId: 'f3',
      clubId: 'umzinto',
    });
    assert.equal(parseCaptainsReportId('a~b'), null);
    assert.equal(parseCaptainsReportId('a~b~c/../d'), null);
  });
});

describe('Sentry redaction', () => {
  test('tokens in link/page paths become [token]', () => {
    assert.equal(
      scrubReportTokens('https://x.test/captains-report-link/abc.def?x=1'),
      'https://x.test/captains-report-link/[token]?x=1',
    );
    assert.equal(scrubReportTokens('/r/abc.def'), '/r/[token]');
    assert.equal(
      scrubReportTokens('https://web.test/r/abc.def?x=1'),
      'https://web.test/r/[token]?x=1',
    );
    assert.equal(scrubReportTokens('/series/abc'), '/series/abc');
  });

  test('an event is scrubbed everywhere it carries the URL', () => {
    const event = {
      request: { url: 'https://api.test/captains-report-link/SECRET.SIG' },
      transaction: 'GET /captains-report-link/SECRET.SIG',
      tags: { api_path: '/captains-report-link/SECRET.SIG' },
      breadcrumbs: [{ data: { url: 'https://web.test/r/SECRET.SIG' } }],
    };
    const out = JSON.stringify(scrubEvent(event));
    assert.ok(!out.includes('SECRET'));
  });
});
