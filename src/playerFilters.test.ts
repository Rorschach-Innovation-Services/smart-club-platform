import { describe, it, expect } from 'vitest';
import { emptyPlayerFilters, hasActiveFilters, filterPlayers, NO_TEAM } from './playerFilters';

// Minimal player shapes — filterPlayers only reads the fields each predicate needs.
const wk = {
  firstName: 'Sipho',
  lastName: 'Mbeki',
  idNumber: 'PP100001',
  clubId: 'warriors',
  team: 'premier',
  gender: 'Male',
  district: 'Ethekwini Metro Cricket Union',
  isWk: true,
};
const allRounder = {
  firstName: 'Anele',
  lastName: 'Zulu',
  idNumber: 'PP100002',
  clubId: 'warriors',
  team: 'premier',
  gender: 'Male',
  district: 'Ethekwini Metro Cricket Union',
  isAllRounder: true,
  bowlerType: 'Fast',
};
const bowler = {
  firstName: 'Thandi',
  lastName: 'Ngcobo',
  idNumber: 'PP100003',
  clubId: 'berea',
  team: 'premierWomen',
  gender: 'Female',
  district: 'Ugu Cricket District',
  bowlerType: 'Finger Spin',
  status: 'clearance-pending',
};
const batter = {
  firstName: 'Kyle',
  lastName: 'Naidoo',
  idNumber: 'PP100004',
  clubId: 'berea',
  gender: 'Male',
  district: 'KCCD',
  // no team, no bowlerType, no flags — a pure batter with no team assigned
};
const ALL = [wk, allRounder, bowler, batter];

const f = (overrides = {}) => ({ ...emptyPlayerFilters, ...overrides });

describe('hasActiveFilters', () => {
  it('is false for the empty baseline', () => {
    expect(hasActiveFilters(emptyPlayerFilters)).toBe(false);
    expect(hasActiveFilters(f())).toBe(false);
  });

  it('is true when any single facet or the search changes', () => {
    for (const key of Object.keys(emptyPlayerFilters)) {
      expect(hasActiveFilters(f({ [key]: 'x' }))).toBe(true);
    }
  });

  it('the baseline is frozen against accidental mutation', () => {
    expect(Object.isFrozen(emptyPlayerFilters)).toBe(true);
  });
});

describe('filterPlayers — search', () => {
  it('matches on full name, case-insensitively and across first/last', () => {
    expect(filterPlayers(ALL, f({ q: 'sipho mb' }))).toEqual([wk]);
    expect(filterPlayers(ALL, f({ q: 'ZULU' }))).toEqual([allRounder]);
  });

  it('matches on partial ID number', () => {
    expect(filterPlayers(ALL, f({ q: 'pp1000' }))).toEqual(ALL);
    expect(filterPlayers(ALL, f({ q: '0003' }))).toEqual([bowler]);
  });

  it('ignores surrounding whitespace and returns everything for a blank query', () => {
    expect(filterPlayers(ALL, f({ q: '   ' }))).toEqual(ALL);
  });

  it('tolerates players with missing name/id fields', () => {
    const ghost = { clubId: 'berea' };
    expect(filterPlayers([ghost], f({ q: 'anything' }))).toEqual([]);
    expect(filterPlayers([ghost], f())).toEqual([ghost]);
  });
});

describe('filterPlayers — status', () => {
  it('treats a missing status as active (same rule as the status pills)', () => {
    expect(filterPlayers(ALL, f({ status: 'active' }))).toEqual([wk, allRounder, batter]);
  });

  it('matches an explicit status exactly', () => {
    expect(filterPlayers(ALL, f({ status: 'clearance-pending' }))).toEqual([bowler]);
    expect(filterPlayers(ALL, f({ status: 'inactive' }))).toEqual([]);
  });
});

describe('filterPlayers — club and team', () => {
  it('filters by clubId', () => {
    expect(filterPlayers(ALL, f({ club: 'berea' }))).toEqual([bowler, batter]);
  });

  it('filters by exact team key', () => {
    expect(filterPlayers(ALL, f({ team: 'premier' }))).toEqual([wk, allRounder]);
  });

  it('NO_TEAM matches only players without a team', () => {
    expect(filterPlayers(ALL, f({ team: NO_TEAM }))).toEqual([batter]);
  });
});

describe('filterPlayers — role and bowler type', () => {
  it('wk / all-rounder match on their flags', () => {
    expect(filterPlayers(ALL, f({ role: 'wk' }))).toEqual([wk]);
    expect(filterPlayers(ALL, f({ role: 'all-rounder' }))).toEqual([allRounder]);
  });

  it('batter means no bowling, not an all-rounder, not a WK (mirrors playerRoleLabel)', () => {
    expect(filterPlayers(ALL, f({ role: 'batter' }))).toEqual([batter]);
  });

  it('bowler matches anyone with a bowlerType, including all-rounders', () => {
    expect(filterPlayers(ALL, f({ role: 'bowler' }))).toEqual([allRounder, bowler]);
  });

  it('bowler type is an exact match and combines with role', () => {
    expect(filterPlayers(ALL, f({ bowler: 'Fast' }))).toEqual([allRounder]);
    expect(filterPlayers(ALL, f({ role: 'bowler', bowler: 'Finger Spin' }))).toEqual([bowler]);
  });
});

describe('filterPlayers — combined facets', () => {
  it('ANDs every active facet together', () => {
    expect(
      filterPlayers(ALL, f({ club: 'warriors', gender: 'Male', role: 'all-rounder' })),
    ).toEqual([allRounder]);
    expect(filterPlayers(ALL, f({ gender: 'Female', district: 'KCCD' }))).toEqual([]);
  });

  it('search stacks on top of facets', () => {
    expect(filterPlayers(ALL, f({ club: 'berea', q: 'naidoo' }))).toEqual([batter]);
    expect(filterPlayers(ALL, f({ club: 'berea', q: 'zulu' }))).toEqual([]);
  });
});
