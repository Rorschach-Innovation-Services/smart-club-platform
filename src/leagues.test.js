import { describe, it, expect } from 'vitest';
import {
  OVERARCHING_DISTRICT,
  slugifyLeagueKey,
  leagueOptionsForDistrict,
  labelByKey,
  optionsGroupedByGroup,
  findByKey,
  teamCounts,
} from './leagues';

const LEAGUES = [
  { key: 'premier', label: 'Premier League', group: 'Overarching', district: OVERARCHING_DISTRICT },
  {
    key: 'veterans',
    label: 'Veterans League',
    group: 'Overarching',
    district: OVERARCHING_DISTRICT,
  },
  {
    key: 'emcuD1',
    label: 'EMCU Division 1',
    group: 'EMCU Divisions',
    district: 'Ethekwini Metro Cricket Union',
  },
  {
    key: 'emcuD2',
    label: 'EMCU Division 2',
    group: 'EMCU Divisions',
    district: 'Ethekwini Metro Cricket Union',
  },
  {
    key: 'kcSat',
    label: 'KC Saturday',
    group: 'King Cetshwayo',
    district: 'Umkhanyakude Cricket District',
  },
];

describe('slugifyLeagueKey', () => {
  it('lowercases, trims and hyphenates', () => {
    expect(slugifyLeagueKey('  EMCU Division 1 ')).toBe('emcu-division-1');
    expect(slugifyLeagueKey("Premier Women's League")).toBe('premier-women-s-league');
  });
  it('collapses runs of non-alphanumerics and strips leading/trailing hyphens', () => {
    expect(slugifyLeagueKey('--A & B--')).toBe('a-b');
  });
  it('is empty for empty/garbage input', () => {
    expect(slugifyLeagueKey('')).toBe('');
    expect(slugifyLeagueKey('!!!')).toBe('');
  });
});

describe('leagueOptionsForDistrict', () => {
  it('returns overarching + the matching district, in that order', () => {
    const out = leagueOptionsForDistrict(LEAGUES, 'Ethekwini Metro Cricket Union');
    expect(out.map((l) => l.key)).toEqual(['premier', 'veterans', 'emcuD1', 'emcuD2']);
  });
  it('returns ONLY overarching for an unknown district (no fallback to a default)', () => {
    const out = leagueOptionsForDistrict(LEAGUES, 'Nowhere District');
    expect(out.map((l) => l.key)).toEqual(['premier', 'veterans']);
  });
  it('excludes other districts', () => {
    const out = leagueOptionsForDistrict(LEAGUES, 'Umkhanyakude Cricket District');
    expect(out.map((l) => l.key)).toEqual(['premier', 'veterans', 'kcSat']);
  });
  it('dedupes by key (overarching wins) and tolerates empty input', () => {
    const dup = [
      ...LEAGUES,
      { key: 'premier', label: 'dupe', group: 'x', district: 'Ethekwini Metro Cricket Union' },
    ];
    const out = leagueOptionsForDistrict(dup, 'Ethekwini Metro Cricket Union');
    expect(out.filter((l) => l.key === 'premier')).toHaveLength(1);
    expect(leagueOptionsForDistrict([], 'anything')).toEqual([]);
    expect(leagueOptionsForDistrict(undefined, 'anything')).toEqual([]);
  });
});

describe('labelByKey / findByKey / optionsGroupedByGroup', () => {
  it('maps keys to labels', () => {
    expect(labelByKey(LEAGUES).emcuD1).toBe('EMCU Division 1');
  });
  it('finds by key, undefined when missing (orphaned key)', () => {
    expect(findByKey(LEAGUES, 'veterans').label).toBe('Veterans League');
    expect(findByKey(LEAGUES, 'deleted-key')).toBeUndefined();
    expect(findByKey([], 'x')).toBeUndefined();
  });
  it('groups by the group label', () => {
    const groups = optionsGroupedByGroup(LEAGUES);
    expect(Object.keys(groups)).toEqual(['Overarching', 'EMCU Divisions', 'King Cetshwayo']);
    expect(groups['EMCU Divisions'].map((l) => l.key)).toEqual(['emcuD1', 'emcuD2']);
  });
});

describe('teamCounts', () => {
  const CATALOGUE = [
    ...LEAGUES,
    { key: 'u11', label: 'Under 11', group: 'Juniors', district: 'Ethekwini Metro Cricket Union' },
    { key: 'u13', label: 'Under 13', group: 'Juniors', district: 'Ugu Cricket District' },
  ];

  it('splits selected leagues into senior and junior by catalogue group', () => {
    expect(teamCounts(['premier', 'emcuD1', 'u11', 'u13'], CATALOGUE)).toEqual({
      senior: 2,
      junior: 2,
    });
  });

  it('counts a key whose league was deleted from the catalogue as senior', () => {
    // Total must always equal leagues entered, so dangling keys stay counted.
    expect(teamCounts(['premier', 'deleted-league'], CATALOGUE)).toEqual({ senior: 2, junior: 0 });
  });

  it('handles empty and missing inputs', () => {
    expect(teamCounts([], CATALOGUE)).toEqual({ senior: 0, junior: 0 });
    expect(teamCounts(undefined, CATALOGUE)).toEqual({ senior: 0, junior: 0 });
    expect(teamCounts(['u11'], undefined)).toEqual({ senior: 1, junior: 0 });
  });
});
