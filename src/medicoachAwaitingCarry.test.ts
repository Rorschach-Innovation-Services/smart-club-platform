import { describe, expect, it } from 'vitest';
import { awaitingCarryNotice } from './medicoachAwaitingCarry';

describe('awaitingCarryNotice', () => {
  it('names how many fixtures await a carry', () => {
    expect(awaitingCarryNotice({ medicoachAwaitingCarry: ['f9'] })).toBe(
      '1 fixture will need a Match Centre carry — see the connection console.',
    );
    expect(awaitingCarryNotice({ medicoachAwaitingCarry: ['f8', 'f9'] })).toMatch(/^2 fixtures /);
  });
  it('stays quiet when there are none or the tenant is not synced', () => {
    expect(awaitingCarryNotice({ medicoachAwaitingCarry: [] })).toBeNull();
    expect(awaitingCarryNotice({ id: 's1' })).toBeNull();
    expect(awaitingCarryNotice(undefined)).toBeNull();
  });
});
