import { describe, expect, it } from 'vitest';
import { scrubReportTokens } from './sentry';

describe('scrubReportTokens', () => {
  it('scrubs captain report and document-request link tokens', () => {
    expect(scrubReportTokens('https://x.test/r/abc.def')).toBe('https://x.test/r/[token]');
    expect(scrubReportTokens('https://x.test/d/abc.def?x=1')).toBe('https://x.test/d/[token]?x=1');
    expect(scrubReportTokens('/doc-request-link/abc.def/upload-url')).toBe(
      '/doc-request-link/[token]/upload-url',
    );
  });

  it('leaves other paths alone', () => {
    expect(scrubReportTokens('/admin/doc-requests')).toBe('/admin/doc-requests');
  });

  it('scrubs t= query tokens wherever they sit, and keeps other params', () => {
    expect(scrubReportTokens('https://x.test/officials/register?t=abc-123')).toBe(
      'https://x.test/officials/register?t=[token]',
    );
    expect(scrubReportTokens('https://api.test/official-signup?t=abc-123')).toBe(
      'https://api.test/official-signup?t=[token]',
    );
    expect(scrubReportTokens('/register/berea?x=1&t=abc-123&y=2')).toBe(
      '/register/berea?x=1&t=[token]&y=2',
    );
    expect(scrubReportTokens('/signup?t=abc#frag')).toBe('/signup?t=[token]#frag');
    // A bare query string inside the JSON-serialised event, and Sentry's pair form.
    expect(scrubReportTokens('{"query_string":"t=abc-123&x=1"}')).toBe(
      '{"query_string":"t=[token]&x=1"}',
    );
    expect(scrubReportTokens('[["t","abc-123"],["x","1"]]')).toBe('[["t","[token]"],["x","1"]]');
    expect(scrubReportTokens('/admin/fixtures?tab=series&at=5&series=abc')).toBe(
      '/admin/fixtures?tab=series&at=5&series=abc',
    );
  });

  it('scrubs squad-link tokens for parity with the API', () => {
    expect(scrubReportTokens('https://x.test/sq/abc.def')).toBe('https://x.test/sq/[token]');
    expect(scrubReportTokens('/squad-link/abc.def/submit')).toBe('/squad-link/[token]/submit');
  });

  it('applies through the JSON form used for events', () => {
    const event = {
      request: { url: 'https://x.test/officials/register?t=secret' },
      message: 'GET /official-signup?t=secret',
    };
    expect(JSON.parse(scrubReportTokens(JSON.stringify(event)))).toEqual({
      request: { url: 'https://x.test/officials/register?t=[token]' },
      message: 'GET /official-signup?t=[token]',
    });
  });
});
