import { describe, it, expect } from 'vitest';
import {
  OVERARCHING_DISTRICT,
  slugifyLeagueKey,
  leagueOptionsForDistrict,
  labelByKey,
  optionsGroupedByGroup,
  findByKey,
  teamCounts,
  isWomensLeague,
  teamLetter,
  defaultTeamName,
  clubTeamsForLeague,
  leagueParticipants,
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

describe('isWomensLeague', () => {
  const L = (label: string, group = 'Overarching') => ({ key: 'k', label, group });
  it('matches women / womens / women’s / ladies labels (case-insensitive)', () => {
    expect(isWomensLeague(L('Premier Women’s League'))).toBe(true); // curly apostrophe
    expect(isWomensLeague(L("Promotion Women's League"))).toBe(true); // straight apostrophe
    expect(isWomensLeague(L('womens t20'))).toBe(true);
    expect(isWomensLeague(L('Ladies Cup'))).toBe(true);
  });
  it('does NOT match plain leagues or "girls" (junior girls stay junior)', () => {
    expect(isWomensLeague(L('Premier League'))).toBe(false);
    expect(isWomensLeague(L('Under 15 Girls', 'Juniors'))).toBe(false);
    expect(isWomensLeague(null)).toBe(false);
    expect(isWomensLeague({ label: undefined })).toBe(false);
  });
});

describe('teamCounts', () => {
  const CATALOGUE = [
    ...LEAGUES,
    {
      key: 'premierWomen',
      label: 'Premier Women’s League',
      group: 'Overarching',
      district: OVERARCHING_DISTRICT,
    },
    {
      key: 'promotion-women-s-league',
      label: 'Promotion Women’s League',
      group: 'Overarching',
      district: OVERARCHING_DISTRICT,
    },
    { key: 'u11', label: 'Under 11', group: 'Juniors', district: 'Ethekwini Metro Cricket Union' },
    { key: 'u13', label: 'Under 13', group: 'Juniors', district: 'Ugu Cricket District' },
    // A junior-group league whose label reads "Girls" — must stay junior, not women.
    { key: 'u15g', label: 'Under 15 Girls', group: 'Juniors', district: 'Ugu Cricket District' },
  ];

  it('splits selected leagues into senior, women and junior', () => {
    expect(
      teamCounts(['premier', 'premierWomen', 'promotion-women-s-league', 'u11'], CATALOGUE),
    ).toEqual({ senior: 1, women: 2, junior: 1 });
  });

  it('splits selected leagues into senior and junior by catalogue group', () => {
    expect(teamCounts(['premier', 'emcuD1', 'u11', 'u13'], CATALOGUE)).toEqual({
      senior: 2,
      women: 0,
      junior: 2,
    });
  });

  it('keeps a junior-group "girls" league as junior, not women (precedence)', () => {
    expect(teamCounts(['premierWomen', 'u15g'], CATALOGUE)).toEqual({
      senior: 0,
      women: 1,
      junior: 1,
    });
  });

  it('counts a key whose league was deleted from the catalogue as senior', () => {
    // Total must always equal leagues entered, so dangling keys stay counted.
    expect(teamCounts(['premier', 'deleted-league'], CATALOGUE)).toEqual({
      senior: 2,
      women: 0,
      junior: 0,
    });
  });

  it('handles empty and missing inputs', () => {
    expect(teamCounts([], CATALOGUE)).toEqual({ senior: 0, women: 0, junior: 0 });
    expect(teamCounts(undefined, CATALOGUE)).toEqual({ senior: 0, women: 0, junior: 0 });
    expect(teamCounts(['u11'], undefined)).toEqual({ senior: 1, women: 0, junior: 0 });
  });

  it('sums per-league team counts when a leagueTeams map is given', () => {
    expect(
      teamCounts(['premier', 'premierWomen', 'u11'], CATALOGUE, {
        premier: 2,
        premierWomen: 3,
        u11: 2,
      }),
    ).toEqual({
      senior: 2, // premier(2)
      women: 3, // premierWomen(3)
      junior: 2, // u11(2)
    });
  });

  it('defaults a league absent from the map (or with a bad value) to 1 side', () => {
    // No map ⇒ 1 each (legacy clubs); partial map ⇒ only listed keys multiplied.
    expect(teamCounts(['premier', 'emcuD1'], CATALOGUE, { premier: 2 })).toEqual({
      senior: 3,
      women: 0,
      junior: 0,
    });
    expect(teamCounts(['premier'], CATALOGUE, { premier: 0 })).toEqual({
      senior: 1,
      women: 0,
      junior: 0,
    });
    expect(teamCounts(['premier'], CATALOGUE, {})).toEqual({ senior: 1, women: 0, junior: 0 });
  });
});

describe('teamLetter / defaultTeamName', () => {
  it('maps indices to spreadsheet-style letters', () => {
    expect([0, 1, 25, 26, 27].map(teamLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB']);
  });
  it('builds a default side name from the club name', () => {
    expect(defaultTeamName('Glenwood', 0)).toBe('Glenwood A');
    expect(defaultTeamName('Glenwood', 1)).toBe('Glenwood B');
    expect(defaultTeamName('', 0)).toBe('Team A');
  });
});

describe('clubTeamsForLeague', () => {
  const club = {
    id: 'glenwood',
    name: 'Glenwood',
    leagues: ['premier'],
    ground: { venue: 'Glenwood Oval', lat: -29.85, lon: 31.02 },
  };

  it('treats a single-team club as one team whose teamId is the clubId', () => {
    const teams = clubTeamsForLeague(club as any, 'premier');
    expect(teams).toEqual([
      {
        teamId: 'glenwood',
        clubId: 'glenwood',
        name: 'Glenwood',
        venue: 'Glenwood Oval',
        lat: -29.85,
        lon: 31.02,
      },
    ]);
  });

  it('expands a ≥2-team league into its named roster sides', () => {
    const c = {
      ...club,
      leagueTeams: { premier: 2 },
      teamRosters: {
        premier: [
          { id: 'tm_a', name: 'Glenwood A', venue: 'Oval' },
          { id: 'tm_b', name: 'Glenwood B' },
        ],
      },
    };
    const teams = clubTeamsForLeague(c as any, 'premier');
    expect(teams.map((t) => [t.teamId, t.name, t.venue])).toEqual([
      ['tm_a', 'Glenwood A', 'Oval'],
      ['tm_b', 'Glenwood B', 'Glenwood Oval'], // falls back to the club venue
    ]);
    expect(teams.every((t) => t.clubId === 'glenwood')).toBe(true);
  });

  it('pads with auto-named sides when the count exceeds the stored roster', () => {
    const c = {
      ...club,
      leagueTeams: { premier: 3 },
      teamRosters: { premier: [{ id: 'tm_a', name: 'First XI' }] },
    };
    const teams = clubTeamsForLeague(c as any, 'premier');
    expect(teams).toHaveLength(3);
    expect(teams[0].name).toBe('First XI');
    expect(teams[1].name).toBe('Glenwood B');
    expect(teams[2].name).toBe('Glenwood C');
    // Padded ids MUST be deterministic (tm_<club>_<league>_<index>) — a fresh
    // makeTeamId() here would desync series creation. Assert the exact value, and
    // that a second call yields the same ids, so a regression can't slip through.
    expect(teams[1].teamId).toBe('tm_glenwood_premier_1');
    expect(teams[2].teamId).toBe('tm_glenwood_premier_2');
    expect(clubTeamsForLeague(c as any, 'premier').map((t) => t.teamId)).toEqual(
      teams.map((t) => t.teamId),
    );
  });
});

describe('leagueParticipants', () => {
  const clubs = [
    {
      id: 'glenwood',
      name: 'Glenwood',
      leagues: ['premier', 't20'],
      leagueTeams: { premier: 2 },
      teamRosters: {
        premier: [
          { id: 'tm_a', name: 'Glenwood A' },
          { id: 'tm_b', name: 'Glenwood B' },
        ],
      },
      ground: { venue: 'Glenwood Oval' },
    },
    { id: 'berea', name: 'Berea', leagues: ['premier'], ground: { venue: 'Berea Park' } },
    { id: 'ukzn', name: 'UKZN', leagues: ['t20'], ground: {} },
  ];

  it('draws only the clubs registered for the league, expanded into sides', () => {
    expect(leagueParticipants(clubs as any, 'premier').map((p) => p.teamId)).toEqual([
      'tm_a',
      'tm_b',
      'berea',
    ]);
  });

  it('carries the club through on each side', () => {
    const [first] = leagueParticipants(clubs as any, 'premier');
    expect(first.club.id).toBe('glenwood');
  });

  it('drops sides listed in excludeTeamIds', () => {
    expect(leagueParticipants(clubs as any, 'premier', ['tm_b']).map((p) => p.teamId)).toEqual([
      'tm_a',
      'berea',
    ]);
  });

  it('excludes one side of a club without excluding the other', () => {
    // A club may enter its A side in the T20 and hold the B side back, so the filter
    // has to be on teamId, not clubId.
    const left = leagueParticipants(clubs as any, 'premier', ['tm_a']);
    expect(left.map((p) => p.teamId)).toEqual(['tm_b', 'berea']);
  });

  it('ignores exclusions that name a side in another league', () => {
    expect(leagueParticipants(clubs as any, 'premier', ['ukzn']).map((p) => p.teamId)).toEqual([
      'tm_a',
      'tm_b',
      'berea',
    ]);
  });

  it('defaults to no exclusions and tolerates a missing club list', () => {
    expect(leagueParticipants(clubs as any, 't20').map((p) => p.teamId)).toEqual([
      'glenwood',
      'ukzn',
    ]);
    expect(leagueParticipants(undefined as any, 'premier')).toEqual([]);
  });
});
