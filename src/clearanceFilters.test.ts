/**
 * filterClearances — the free-text needle behind the admin clearances search box.
 *
 * It runs across EVERY status (search combines with the status pills, it does not replace
 * them) and must match the fields an admin would actually type: the player, either club,
 * the team's DISPLAY label (not its slug), the acting/requesting admins, and the id.
 */
import { describe, it, expect } from 'vitest';
import { filterClearances, readClearanceLinkId, clearanceLinkMissing } from './clearanceFilters';
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

describe('readClearanceLinkId — the ?clearance= deep link from a notification', () => {
  it('returns the id when the link carries one', () => {
    expect(readClearanceLinkId('?clearance=clr-42')).toBe('clr-42');
    expect(readClearanceLinkId('?tab=x&clearance=clr-42')).toBe('clr-42');
  });

  it('decodes and trims the id', () => {
    expect(readClearanceLinkId('?clearance=%20clr%2F42%20')).toBe('clr/42');
  });

  it('returns null when there is no link id', () => {
    expect(readClearanceLinkId('')).toBeNull();
    expect(readClearanceLinkId('?series=s1')).toBeNull();
    expect(readClearanceLinkId('?clearance=')).toBeNull();
    expect(readClearanceLinkId('?clearance=%20%20')).toBeNull();
  });
});

describe('clearanceLinkMissing — the "no clearance matches this link" notice gate', () => {
  const rows = [{ id: 'clr-1' }, { id: 'clr-2' }];

  it('is false when the linked clearance is in the list', () => {
    expect(clearanceLinkMissing('clr-2', rows)).toBe(false);
  });

  it('is true when the linked clearance is gone (resolved long ago or erased)', () => {
    expect(clearanceLinkMissing('clr-9', rows)).toBe(true);
    expect(clearanceLinkMissing('clr-9', [])).toBe(true);
  });

  it('matches the id exactly, not as a substring', () => {
    expect(clearanceLinkMissing('clr', rows)).toBe(true);
  });

  it('is false when there is no link id at all', () => {
    expect(clearanceLinkMissing(null, [])).toBe(false);
  });
});
