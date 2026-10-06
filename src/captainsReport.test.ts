import { describe, expect, it } from 'vitest';
import { cleanLinkToken } from './CaptainsReport';

describe('cleanLinkToken (broken Meta button prefix, 3-4 Oct 2026)', () => {
  const tok = 'eyJ0IjoiZG9scGhpbnMifQ.abc_def-123';
  it('strips a literal {{1}} prefix', () => {
    expect(cleanLinkToken(`{{1}}${tok}`)).toBe(tok);
  });
  it('strips a percent-encoded %7B%7B1%7D%7D prefix', () => {
    expect(cleanLinkToken(`%7B%7B1%7D%7D${tok}`)).toBe(tok);
  });
  it('leaves a clean token untouched', () => {
    expect(cleanLinkToken(tok)).toBe(tok);
  });
  it('survives malformed percent sequences', () => {
    expect(cleanLinkToken('%zzjunk')).toBe('%zzjunk');
  });
});
