import { describe, it, expect } from 'vitest';
import {
  NEVER_EDITED_CHANGED_AT,
  formatChangedAt,
  isNeverEditedChangedAt,
} from './medicoachChangedAt';

describe('formatChangedAt', () => {
  it('renders the never-edited sentinel as "never edited"', () => {
    expect(formatChangedAt(NEVER_EDITED_CHANGED_AT)).toBe('never edited');
  });

  it('treats any pre-2000 epoch-adjacent value as never edited', () => {
    expect(formatChangedAt('1970-01-01T00:00:00.000Z')).toBe('never edited');
    expect(isNeverEditedChangedAt('1999-12-31T23:59:59.999Z')).toBe(true);
  });

  it('formats a real date in SAST', () => {
    expect(formatChangedAt('2026-10-03T07:00:00.000Z')).toBe('3 Oct, 09:00');
    expect(isNeverEditedChangedAt('2026-10-03T07:00:00.000Z')).toBe(false);
  });

  it('shows a dash when there is no value', () => {
    expect(formatChangedAt(undefined)).toBe('—');
  });
});
