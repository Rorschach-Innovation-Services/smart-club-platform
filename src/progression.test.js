import { describe, it, expect } from 'vitest';
import { affiliationSubmitted, journeyUnlocked } from './data.jsx';

// Minimal club factory — only the fields these gate helpers read.
function club({ affiliation = 'not_started', paid = false, progressionMode } = {}) {
  return { affiliation, paid, progressionMode };
}

describe('affiliationSubmitted', () => {
  it('is the form fact — true only when affiliation is complete, never payment', () => {
    expect(affiliationSubmitted(club({ affiliation: 'complete', paid: false }))).toBe(true);
    expect(affiliationSubmitted(club({ affiliation: 'complete', paid: true }))).toBe(true);
    expect(affiliationSubmitted(club({ affiliation: 'in_progress' }))).toBe(false);
    expect(affiliationSubmitted(club({ affiliation: 'not_started' }))).toBe(false);
  });

  it('ignores paid entirely — a paid-but-unsubmitted club is not submitted', () => {
    expect(affiliationSubmitted(club({ affiliation: 'not_started', paid: true }))).toBe(false);
  });
});

describe('journeyUnlocked', () => {
  it('submission mode (default) unlocks on submission alone', () => {
    // Default mode (field absent) behaves as submission.
    expect(journeyUnlocked(club({ affiliation: 'complete' }))).toBe(true);
    expect(journeyUnlocked(club({ affiliation: 'complete', progressionMode: 'submission' }))).toBe(
      true,
    );
    expect(journeyUnlocked(club({ affiliation: 'in_progress' }))).toBe(false);
  });

  it('submission mode does not require payment', () => {
    expect(journeyUnlocked(club({ affiliation: 'complete', paid: false }))).toBe(true);
  });

  it('payment mode requires BOTH submission and paid', () => {
    const mode = 'payment';
    // submitted but unpaid → still locked
    expect(
      journeyUnlocked(club({ affiliation: 'complete', paid: false, progressionMode: mode })),
    ).toBe(false);
    // submitted and paid → unlocked
    expect(
      journeyUnlocked(club({ affiliation: 'complete', paid: true, progressionMode: mode })),
    ).toBe(true);
  });

  it('payment mode never unlocks an unaffiliated club, even if paid', () => {
    // The togglePaid route has no affiliation guard; the AND-gate closes the hole.
    expect(
      journeyUnlocked(club({ affiliation: 'not_started', paid: true, progressionMode: 'payment' })),
    ).toBe(false);
  });

  it('an unknown progressionMode falls back to submission semantics', () => {
    // `?? 'submission'` only covers null/undefined; any other string is treated as
    // non-payment, so the gate stays submission-driven rather than silently locking.
    expect(journeyUnlocked(club({ affiliation: 'complete', progressionMode: 'legacy' }))).toBe(
      true,
    );
  });
});
