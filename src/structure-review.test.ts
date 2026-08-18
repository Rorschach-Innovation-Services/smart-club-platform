import { describe, it, expect } from 'vitest';
import { buildClubIndex } from './intake-match';
import {
  applyRowEdits,
  buildClubPlans,
  buildCommitPayload,
  buildTeamRows,
  clubHasExistingPlan,
  divisionWarning,
  draftKeyCollides,
  initialSectionAssignments,
  makeDraftLeague,
  resolveTeamClub,
  sectionsReady,
  stripTeamSuffix,
  suggestLeague,
  teamRowNeedsAttention,
  type SectionAssignment,
} from './structure-review';
import type { League, StructureSection } from './types';

const LEAGUES: League[] = [
  {
    key: 'premier-league',
    label: 'Premier League',
    group: 'Overarching Leagues',
    district: 'All districts',
  },
  {
    key: 'promotion-league',
    label: 'Promotion League',
    group: 'Overarching Leagues',
    district: 'All districts',
  },
  {
    key: 'womens-premier-league',
    label: "Women's Premier League",
    group: 'Overarching Leagues',
    district: 'All districts',
  },
];

const CLUBS = [
  { id: 'tuks', name: 'TUKS Cricket Club' },
  { id: 'phsob', name: 'PHSOB Cricket Club' },
];

describe('suggestLeague', () => {
  it('matches an exact normalised header', () => {
    expect(suggestLeague('Premier League', LEAGUES)).toBe('premier-league');
  });

  it('matches a header carrying extra division wording via containment', () => {
    expect(suggestLeague('PREMIER LEAGUE DIVISION A', LEAGUES)).toBe('premier-league');
  });

  it('returns null when nothing clears the bar', () => {
    expect(suggestLeague('Under 9 Friendlies', LEAGUES)).toBeNull();
  });

  it('returns null for a blank header', () => {
    expect(suggestLeague('   ', LEAGUES)).toBeNull();
  });
});

describe('initialSectionAssignments / sectionsReady', () => {
  const sections: StructureSection[] = [
    { sheet: 'SENIORS', header: 'Premier League', rows: [] },
    { sheet: 'SENIORS', header: 'Under 9 Friendlies', rows: [] },
  ];

  it('prefills a suggestion, unconfirmed, per section', () => {
    const a = initialSectionAssignments(sections, LEAGUES);
    expect(a[0]).toEqual({ leagueKey: 'premier-league', ignored: false, confirmed: false });
    expect(a[1]).toEqual({ leagueKey: null, ignored: false, confirmed: false });
  });

  it('is not ready while an unassigned, non-ignored section remains', () => {
    const a = initialSectionAssignments(sections, LEAGUES);
    expect(sectionsReady(a)).toBe(false);
    a[1].ignored = true;
    expect(sectionsReady(a)).toBe(true);
  });
});

describe('draft leagues', () => {
  it('makeDraftLeague slugifies the key and preserves group/district', () => {
    expect(makeDraftLeague('Veterans League', 'Overarching Leagues', 'All districts')).toEqual({
      key: 'veterans-league',
      label: 'Veterans League',
      group: 'Overarching Leagues',
      district: 'All districts',
    });
  });

  it('draftKeyCollides flags an existing key', () => {
    expect(draftKeyCollides('premier-league', LEAGUES)).toBe(true);
    expect(draftKeyCollides('veterans-league', LEAGUES)).toBe(false);
  });

  it('divisionWarning fires for a "Division A" of an existing league', () => {
    const hit = divisionWarning('Premier League Division A', LEAGUES);
    expect(hit?.key).toBe('premier-league');
  });

  it('divisionWarning fires for a trailing lone-letter side name', () => {
    const hit = divisionWarning('Promotion League B', LEAGUES);
    expect(hit?.key).toBe('promotion-league');
  });

  it('divisionWarning stays quiet for a genuinely new league name', () => {
    expect(divisionWarning('Colts League', LEAGUES)).toBeNull();
  });

  it('divisionWarning stays quiet when nothing was actually stripped', () => {
    // No "Division"/trailing-letter wording — a plain duplicate name is
    // draftKeyCollides' concern, not this one.
    expect(divisionWarning('Premier League', LEAGUES)).toBeNull();
  });
});

describe('stripTeamSuffix / resolveTeamClub', () => {
  it('strips a trailing team number', () => {
    expect(stripTeamSuffix('TUKS 1')).toBe('TUKS');
  });

  it('strips VETERANS then its own trailing number', () => {
    expect(stripTeamSuffix('PHSOB VETERANS 1')).toBe('PHSOB');
  });

  it('strips a trailing single-letter side', () => {
    expect(stripTeamSuffix('ADELAAR B')).toBe('ADELAAR');
  });

  it('strips a stray CC suffix', () => {
    expect(stripTeamSuffix('CENTURION KAVALIERS CC 2')).toBe('CENTURION KAVALIERS');
  });

  it('resolveTeamClub matches via the shared tiered matcher', () => {
    const index = buildClubIndex(CLUBS);
    const hit = resolveTeamClub('TUKS 1', index);
    expect(hit.club?.id).toBe('tuks');
    expect(hit.confidence).toBeGreaterThan(0);
  });

  it('resolveTeamClub returns null for an unresolvable label', () => {
    const index = buildClubIndex(CLUBS);
    const hit = resolveTeamClub('Riverside 1', index);
    expect(hit.club).toBeNull();
  });
});

describe('buildTeamRows', () => {
  const sections: StructureSection[] = [
    {
      sheet: 'SENIORS',
      header: 'Premier League',
      rows: [
        { raw: 'TUKS 1', venue: 'Buks Oval' },
        { raw: 'PHSOB 1', venue: 'PHSOB Oval' },
      ],
    },
    {
      sheet: 'SENIORS',
      header: 'Under 9 Friendlies',
      rows: [{ raw: 'TUKS 1', venue: 'Buks Oval' }],
    },
  ];

  it('only flattens rows from non-ignored, league-assigned sections', () => {
    const assignments: SectionAssignment[] = [
      { leagueKey: 'premier-league', ignored: false, confirmed: true },
      { leagueKey: null, ignored: false, confirmed: false },
    ];
    const index = buildClubIndex(CLUBS);
    const rows = buildTeamRows(sections, assignments, index);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sectionIndex === 0)).toBe(true);
    expect(rows[0].clubId).toBe('tuks');
  });

  it('skips an ignored section even when it has a league key', () => {
    const assignments: SectionAssignment[] = [
      { leagueKey: 'premier-league', ignored: true, confirmed: true },
      { leagueKey: null, ignored: false, confirmed: false },
    ];
    const index = buildClubIndex(CLUBS);
    expect(buildTeamRows(sections, assignments, index)).toHaveLength(0);
  });
});

describe('applyRowEdits / teamRowNeedsAttention', () => {
  it('a manual club pick overrides the auto-resolved one at confidence 1', () => {
    const index = buildClubIndex(CLUBS);
    const rows = buildTeamRows(
      [{ sheet: 'S', header: 'Premier League', rows: [{ raw: 'Riverside 1' }] }],
      [{ leagueKey: 'premier-league', ignored: false, confirmed: true }],
      index,
    );
    expect(rows[0].clubId).toBeNull();
    const edited = applyRowEdits(rows, { [rows[0].id]: 'phsob' }, new Set());
    expect(edited[0]).toMatchObject({ clubId: 'phsob', clubConfidence: 1 });
  });

  it('excluding a row is independent of its club resolution', () => {
    const index = buildClubIndex(CLUBS);
    const rows = buildTeamRows(
      [{ sheet: 'S', header: 'Premier League', rows: [{ raw: 'TUKS 1' }] }],
      [{ leagueKey: 'premier-league', ignored: false, confirmed: true }],
      index,
    );
    const edited = applyRowEdits(rows, {}, new Set([rows[0].id]));
    expect(edited[0].excluded).toBe(true);
    expect(teamRowNeedsAttention(edited[0])).toBe(true);
  });

  it('an exact (confidence 1) matched, included row needs no attention', () => {
    const index = buildClubIndex(CLUBS);
    const rows = buildTeamRows(
      [{ sheet: 'S', header: 'Premier League', rows: [{ raw: 'TUKS Cricket Club' }] }],
      [{ leagueKey: 'premier-league', ignored: false, confirmed: true }],
      index,
    );
    expect(teamRowNeedsAttention(rows[0])).toBe(false);
  });
});

describe('clubHasExistingPlan', () => {
  it('is true when leagues carry data', () => {
    expect(clubHasExistingPlan({ leagues: ['premier-league'] })).toBe(true);
  });
  it('is true when leagueTeams carry data even without leagues', () => {
    expect(clubHasExistingPlan({ leagueTeams: { 'premier-league': 1 } })).toBe(true);
  });
  it('is false for a virgin club', () => {
    expect(clubHasExistingPlan({})).toBe(false);
  });
});

describe('buildClubPlans', () => {
  it('aggregates counts, named sides and a first-team venue per club', () => {
    const index = buildClubIndex(CLUBS);
    const sections: StructureSection[] = [
      {
        sheet: 'SENIORS',
        header: 'Premier League',
        rows: [
          { raw: 'TUKS 1', venue: 'Buks Oval' },
          { raw: 'TUKS 2', venue: 'Loftus Nets' },
        ],
      },
    ];
    const assignments: SectionAssignment[] = [
      { leagueKey: 'premier-league', ignored: false, confirmed: true },
    ];
    const rows = buildTeamRows(sections, assignments, index);
    const plans = buildClubPlans(rows, assignments);
    expect(plans.tuks).toEqual({
      leagues: ['premier-league'],
      leagueTeams: { 'premier-league': 2 },
      teamRosters: {
        'premier-league': [
          { name: 'TUKS 1', venue: 'Buks Oval' },
          { name: 'TUKS 2', venue: 'Loftus Nets' },
        ],
      },
      firstTeamVenue: 'Buks Oval',
    });
  });

  it('falls back to the first row venue when no "…1"/unnumbered side has one', () => {
    const index = buildClubIndex(CLUBS);
    const sections: StructureSection[] = [
      {
        sheet: 'SENIORS',
        header: 'Premier League',
        rows: [{ raw: 'TUKS 1' }, { raw: 'TUKS 2', venue: 'Loftus Nets' }],
      },
    ];
    const assignments: SectionAssignment[] = [
      { leagueKey: 'premier-league', ignored: false, confirmed: true },
    ];
    const rows = buildTeamRows(sections, assignments, index);
    const plans = buildClubPlans(rows, assignments);
    expect(plans.tuks.firstTeamVenue).toBe('Loftus Nets');
  });

  it('excludes excluded and unmatched rows from every club plan', () => {
    const index = buildClubIndex(CLUBS);
    const sections: StructureSection[] = [
      {
        sheet: 'SENIORS',
        header: 'Premier League',
        rows: [{ raw: 'TUKS 1' }, { raw: 'Riverside 1' }],
      },
    ];
    const assignments: SectionAssignment[] = [
      { leagueKey: 'premier-league', ignored: false, confirmed: true },
    ];
    const rows = buildTeamRows(sections, assignments, index);
    const edited = applyRowEdits(rows, {}, new Set([rows[0].id]));
    const plans = buildClubPlans(edited, assignments);
    expect(plans.tuks).toBeUndefined();
    expect(Object.keys(plans)).toHaveLength(0);
  });
});

describe('buildCommitPayload', () => {
  it('omits newLeagues entirely when there are no drafts', () => {
    const payload = buildCommitPayload(
      { tuks: { leagues: ['premier-league'], leagueTeams: {}, teamRosters: {} } },
      {},
      [],
    );
    expect(payload).toEqual({
      clubs: [
        { clubId: 'tuks', plan: { leagues: ['premier-league'], leagueTeams: {}, teamRosters: {} } },
      ],
    });
    expect('newLeagues' in payload).toBe(false);
  });

  it('sends confirmed draft leagues as newLeagues', () => {
    const draft = makeDraftLeague('Veterans League', 'Overarching Leagues', 'All districts');
    const payload = buildCommitPayload({}, {}, [draft]);
    expect(payload.newLeagues).toEqual([draft]);
    expect(payload.clubs).toEqual([]);
  });

  it('sets overwrite:true only for clubs opted in', () => {
    const plans = {
      tuks: { leagues: [], leagueTeams: {}, teamRosters: {} },
      phsob: { leagues: [], leagueTeams: {}, teamRosters: {} },
    };
    const payload = buildCommitPayload(plans, { tuks: true }, []);
    const tuks = payload.clubs.find((c) => c.clubId === 'tuks')!;
    const phsob = payload.clubs.find((c) => c.clubId === 'phsob')!;
    expect(tuks.overwrite).toBe(true);
    expect(phsob.overwrite).toBeUndefined();
  });
});
