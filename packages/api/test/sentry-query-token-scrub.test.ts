/**
 * The Sentry scrubber redacts `t=` link tokens (club signup, player /register, official
 * signup) wherever an event carries the query: the url, a bare query_string, Sentry's pair
 * form, and breadcrumbs. Run with tsx --test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubEvent, scrubReportTokens } from '../src/instrument.js';

const TOKEN = '3f2a9c1e-1111-4222-8333-944455556666';

test('redacts ?t= and &t= in URLs, keeping other params', () => {
  assert.equal(
    scrubReportTokens(`https://api.example/official-signup?t=${TOKEN}`),
    'https://api.example/official-signup?t=[token]',
  );
  assert.equal(
    scrubReportTokens(`/register/club-a?x=1&t=${TOKEN}&y=2`),
    '/register/club-a?x=1&t=[token]&y=2',
  );
  assert.equal(scrubReportTokens('/club-signup?at=keep'), '/club-signup?at=keep');
});

test('redacts the request url, a string query_string, the pair form and breadcrumbs', () => {
  const event = {
    request: {
      url: `https://api.example/club-signup?t=${TOKEN}`,
      query_string: `t=${TOKEN}`,
    },
    extra: {
      pairs: [
        ['t', TOKEN],
        ['page', '2'],
      ],
    },
    breadcrumbs: [{ data: { url: `/official-signup?t=${TOKEN}` } }],
  };
  const out = JSON.stringify(scrubEvent(event));
  assert.ok(!out.includes(TOKEN), out);
  assert.ok(out.includes('"page","2"'), 'other pairs kept');
});

test('path tokens are still redacted', () => {
  assert.equal(
    scrubReportTokens(`/captains-report-link/${TOKEN}`),
    '/captains-report-link/[token]',
  );
});
