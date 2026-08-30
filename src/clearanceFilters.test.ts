/**
 * filterClearances — the free-text needle behind the admin clearances search box.
 *
 * It runs across EVERY status (search combines with the status pills, it does not replace
 * them) and must match the fields an admin would actually type: the player, either club,
 * the team's DISPLAY label (not its slug), the acting/requesting admins, and the id.
 */
import { describe, it, expect } from 'vitest';
import { filterClearances } from './clearanceFilters';
import type { PlayerClearance } from './types';

const teamLabel = { premier: 'Premier League' };

const base: PlayerClearance = {
  id: 'clr-1',
  playerNaturalKey: 'sipho|0101015800088',
  playerName: 'Sipho Ndlovu',
  idNumber: '0101015800088',
  team: 'premier',
  fromClubId: 'berea',
  toClubId: 'ukzn',
  fromClubName: 'Berea CC',
  toClubName: 'UKZN CC',
  requestedAt: '2026-07-01T09:00:00.000Z',
  feesCleared: false,
  misconductCleared: false,
  status: 'pending',
  version: 1,
};

const other: PlayerClearance = {
  ...base,
  id: 'clr-2',
  playerNaturalKey: 'thabo|9202025900011',
  playerName: 'Thabo Mokoena',
  idNumber: '9202025900011',
  fromClubName: 'Glenwood CC',
  toClubName: 'Durban CC',
  status: 'rejected',
  rejectedBy: 'union@dolphins.test',
};

const list = [base, other];

describe('filterClearances', () => {
  it('returns the list untouched for an empty or whitespace query', () => {
    expect(filterClearances(list, '', teamLabel)).toBe(list);
    expect(filterClearances(list, '   ', teamLabel)).toBe(list);
  });

  it('matches on player name, case-insensitively', () => {
    expect(filterClearances(list, 'sipho', teamLabel)).toEqual([base]);
    expect(filterClearances(list, 'MOKOENA', teamLabel)).toEqual([other]);
  });

  it('matches on an ID-number substring', () => {
    expect(filterClearances(list, '01015800', teamLabel)).toEqual([base]);
  });

  it('matches on either club name', () => {
    expect(filterClearances(list, 'berea', teamLabel)).toEqual([base]);
    expect(filterClearances(list, 'durban', teamLabel)).toEqual([other]);
  });

  it('matches on the team display label, not just the raw slug', () => {
    // The admin sees "Premier League", so searching that must find the row whose team is
    // the `premier` slug.
    expect(filterClearances(list, 'premier league', teamLabel)).toEqual(list);
  });

  it('falls back to the raw team key when no label is registered', () => {
    const noLabel = [{ ...base, team: 'div-b' }];
    expect(filterClearances(noLabel, 'div-b', {})).toEqual(noLabel);
  });

  it('matches on the acting/requesting admins and on the id', () => {
    expect(filterClearances(list, 'union@dolphins.test', teamLabel)).toEqual([other]);
    expect(filterClearances(list, 'clr-2', teamLabel)).toEqual([other]);
    expect(
      filterClearances([{ ...base, overriddenBy: 'admin@dolphins.test' }], 'admin@', teamLabel),
    ).toHaveLength(1);
    expect(
      filterClearances([{ ...base, requestedBy: 'rep@berea.test' }], 'rep@berea', teamLabel),
    ).toHaveLength(1);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterClearances(list, 'nonesuch', teamLabel)).toEqual([]);
  });
});
