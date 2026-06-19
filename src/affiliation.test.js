import { describe, it, expect } from 'vitest';
import { affiliationSubmitted } from './data';

// Minimal club factory — only the fields this gate helper reads.
function club({ affiliation = 'not_started' } = {}) {
  return { affiliation };
}

describe('affiliationSubmitted', () => {
  it('is the form fact — true only when affiliation is complete', () => {
    expect(affiliationSubmitted(club({ affiliation: 'complete' }))).toBe(true);
    expect(affiliationSubmitted(club({ affiliation: 'in_progress' }))).toBe(false);
    expect(affiliationSubmitted(club({ affiliation: 'not_started' }))).toBe(false);
  });
});
