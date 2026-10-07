/**
 * Group-position placeholders (`pos:<groupSeriesId>:<rank>`): the knockout slots the
 * medicoach recipe semis/finals are seeded from ("Group 1 1st v Group 2 2nd").
 */
import { describe, it, expect } from 'vitest';
import {
  groupPositionLabel,
  groupPositionOf,
  groupPositionSource,
  isSlotRef,
  slotRefLabel,
  slotSource,
} from './formats';

describe('group-position slot refs', () => {
  it('round-trips the series id and rank', () => {
    const id = groupPositionOf('s-planb-premier-men-t20-1', 2);
    expect(id).toBe('pos:s-planb-premier-men-t20-1:2');
    expect(groupPositionSource(id)).toEqual({ seriesId: 's-planb-premier-men-t20-1', rank: 2 });
  });

  it('is a slot ref, but not a win/lose bracket source', () => {
    expect(isSlotRef('pos:s-planb-premier-women-t20-g1:1')).toBe(true);
    expect(slotSource('pos:s-planb-premier-women-t20-g1:1')).toBeNull();
    expect(isSlotRef('crusaders')).toBe(false);
  });

  it('renders "Group N – 1st" from the series id', () => {
    expect(groupPositionLabel('pos:s-planb-premier-men-t20-1:1')).toBe('Group 1 – 1st');
    expect(groupPositionLabel('pos:s-planb-premier-women-t20-g2:2')).toBe('Group 2 – 2nd');
    expect(groupPositionLabel('pos:s-planb-promotion-men-t20-g4:3')).toBe('Group 4 – 3rd');
    expect(groupPositionLabel('pos:custom:11')).toBe('custom – 11th');
    expect(slotRefLabel('pos:s-planb-veterans-premier-t20-2:1')).toBe('Group 2 – 1st');
  });

  it('reads letter groups and division suffixes (titans series ids)', () => {
    expect(groupPositionLabel('pos:s-titans-mens-t20-g-a:1')).toBe('Group A – 1st');
    expect(groupPositionLabel('pos:s-titans-womens-t20-g-c:2')).toBe('Group C – 2nd');
    expect(groupPositionLabel('pos:s-titans-veterans-league-a:2')).toBe('Veterans A – 2nd');
    expect(groupPositionLabel('pos:s-titans-veterans-league-b:1')).toBe('Veterans B – 1st');
    expect(groupPositionLabel('pos:s-titans-u9-platinum-a:3')).toBe('U9 Platinum A – 3rd');
    // A single-division id with no suffix stays as-is; numeric groups keep winning.
    expect(groupPositionLabel('pos:s-titans-second-league:1')).toBe('s-titans-second-league – 1st');
    expect(groupPositionLabel('pos:s-x-premier-a-2:1')).toBe('Group 2 – 1st');
  });

  it('keeps the win: labels working beside it', () => {
    const fx = [
      { id: 'f1', round: 1, home: 'pos:s-a-1:1', away: 'pos:s-a-2:2' },
      { id: 'f2', round: 1, home: 'pos:s-a-2:1', away: 'pos:s-a-1:2' },
      { id: 'f3', round: 2, home: 'win:f1', away: 'win:f2' },
    ];
    expect(slotRefLabel('win:f1', fx)).toBe('Winner of Semi-final 1');
    expect(slotRefLabel('win:f2', fx)).toBe('Winner of Semi-final 2');
  });
});
