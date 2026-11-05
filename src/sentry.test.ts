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
});
