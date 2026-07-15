import { describe, it, expect } from 'vitest';
import { OVERARCHING_DISTRICT } from './leagues';
import {
  leagueBreakdown,
  districtRows,
  clearanceCounts,
  affiliationRows,
  cqiBandRows,
  docComplianceRows,
  leagueTeamDirectory,
  chairContactOf,
  pct,
} from './insights';
import type { InsightsClub, League, ClearanceStatus } from './types';

const LEAGUES: League[] = [
  { key: 'premier', label: 'Premier League', group: 'Seniors', district: OVERARCHING_DISTRICT },
  { key: 'womens', label: "Women's League", group: 'Seniors', district: OVERARCHING_DISTRICT },
  { key: 'u13', label: 'Under 13', group: 'Juniors', district: 'North' },
];

const DISTRICTS = ['North', 'South'];

const club = (over: Partial<InsightsClub>): InsightsClub => ({
  id: 'c1',
  name: 'Club',
  district: 'North',
  affiliation: 'not_started',
  cqi: 0,
  docs: {},
  players: 0,
  leagues: [],
  ...over,
});

describe('leagueBreakdown', () => {
  it('counts clubs and multi-team entries per league', () => {
    const clubs = [
      club({ id: 'a', leagues: ['premier', 'u13'], leagueTeams: { premier: 3 } }),
      club({ id: 'b', leagues: ['premier'] }),
    ];
    const { rows, orphans } = leagueBreakdown(clubs, LEAGUES);
    const premier = rows.find((r) => r.key === 'premier')!;
    expect(premier.clubCount).toBe(2);
    expect(premier.teamCount).toBe(4); // 3 sides + 1 legacy default
    expect(rows.find((r) => r.key === 'u13')!.teamCount).toBe(1);
    expect(rows.find((r) => r.key === 'womens')!.clubCount).toBe(0);
    expect(orphans.keys).toEqual([]);
  });

  it('surfaces orphan keys with club and team counts so KPI totals reconcile', () => {
    const clubs = [
      club({ id: 'a', leagues: ['premier', 'gone'], leagueTeams: { gone: 2 } }),
      club({ id: 'b', leagues: ['gone', 'also-gone'] }),
    ];
    const { orphans } = leagueBreakdown(clubs, LEAGUES);
    expect(orphans.keys.sort()).toEqual(['also-gone', 'gone']);
    expect(orphans.clubCount).toBe(2); // distinct clubs, not references
    expect(orphans.teamCount).toBe(4); // 2 + 1 + 1
  });
});

describe('districtRows', () => {
  it('tallies clubs/teams per district and leagues available (incl. overarching)', () => {
    const clubs = [
      club({ id: 'a', district: 'North', leagues: ['premier', 'u13'], leagueTeams: { u13: 2 } }),
      club({ id: 'b', district: 'South', leagues: ['premier'] }),
    ];
    const rows = districtRows(clubs, LEAGUES, DISTRICTS);
    const north = rows.find((r) => r.name === 'North')!;
    expect(north.clubCount).toBe(1);
    expect(north.teamCount).toBe(3); // premier 1 + u13 2
    expect(north.leagueCount).toBe(3); // 2 overarching + 1 district-specific
    expect(rows.find((r) => r.name === 'South')!.leagueCount).toBe(2);
  });

  it('keeps empty districts and collects unknown districts under Other', () => {
    const clubs = [club({ id: 'a', district: 'Ghost Town', leagues: ['premier'] })];
    const rows = districtRows(clubs, LEAGUES, DISTRICTS);
    expect(rows.find((r) => r.name === 'South')!.clubCount).toBe(0);
    const other = rows.find((r) => r.other)!;
    expect(other.clubCount).toBe(1);
    expect(other.teamCount).toBe(1);
  });

  it('renders no Other row when every club has a known district', () => {
    const rows = districtRows([club({ district: 'North' })], LEAGUES, DISTRICTS);
    expect(rows.some((r) => r.other)).toBe(false);
  });
});

describe('clearanceCounts', () => {
  it('buckets on the hyphenated admin-override wire value', () => {
    const mk = (status: ClearanceStatus) => ({ status });
    const counts = clearanceCounts([
      mk('pending'),
      mk('pending'),
      mk('approved'),
      mk('admin-override'),
      mk('rejected'),
    ]);
    expect(counts).toEqual({ pending: 2, approved: 1, adminOverride: 1, rejected: 1 });
  });
});

describe('affiliationRows', () => {
  it('back-computes not-started so legacy/absent statuses still count', () => {
    const clubs = [
      club({ affiliation: 'complete' }),
      club({ affiliation: 'in_progress' }),
      club({ affiliation: undefined as unknown as InsightsClub['affiliation'] }),
    ];
    const rows = affiliationRows(clubs);
    expect(rows.map((r) => r.count)).toEqual([1, 1, 1]);
  });
});

describe('cqiBandRows / docComplianceRows', () => {
  it('bands scores with pending at zero and averages only submitters', () => {
    const clubs = [club({ cqi: 85 }), club({ cqi: 55 }), club({ cqi: 0 })];
    const { bands, submitted, avgCqi } = cqiBandRows(clubs);
    expect(bands.find((b) => b.key === 'A')!.count).toBe(1);
    expect(bands.find((b) => b.key === 'C')!.count).toBe(1);
    expect(bands.find((b) => b.key === 'P')!.count).toBe(1);
    expect(submitted.length).toBe(2);
    expect(avgCqi).toBe(70);
  });

  it('doc compliance tolerates clubs with no docs object', () => {
    const clubs = [
      club({ docs: { constitution: true } }),
      club({ docs: undefined as unknown as InsightsClub['docs'] }),
    ];
    const { docStats } = docComplianceRows(clubs);
    expect(docStats.find((d) => d.key === 'constitution')!.count).toBe(1);
    expect(docStats.every((d) => d.total === 2)).toBe(true);
  });
});

describe('pct', () => {
  it('formats one-decimal percentages without trailing zeros', () => {
    expect(pct(3, 8)).toBe('37.5%');
    expect(pct(5, 5)).toBe('100%');
    expect(pct(1, 3)).toBe('33.3%');
  });

  it('guards a zero total to 0%', () => {
    expect(pct(0, 0)).toBe('0%');
  });
});

describe('leagueTeamDirectory', () => {
  it('lists a single-team club as one row whose teamId is the clubId', () => {
    const clubs = [club({ id: 'glenwood', name: 'Glenwood', leagues: ['premier'] })];
    const rows = leagueTeamDirectory(clubs, 'premier');
    expect(rows).toHaveLength(1);
    expect(rows[0].teamId).toBe('glenwood');
    expect(rows[0].teamName).toBe('Glenwood');
    expect(rows[0].clubId).toBe('glenwood');
    expect(rows[0].clubName).toBe('Glenwood');
  });

  it('expands named rosters and pads short ones with deterministic default sides', () => {
    const clubs = [
      club({
        id: 'glenwood',
        name: 'Glenwood',
        leagues: ['premier'],
        leagueTeams: { premier: 3 },
        teamRosters: { premier: [{ id: 'tm_a', name: 'First XI' }] },
      }),
    ];
    const rows = leagueTeamDirectory(clubs, 'premier');
    expect(rows.map((r) => r.teamName)).toEqual(['First XI', 'Glenwood B', 'Glenwood C']);
    // Padded ids stay deterministic (clubTeamsForLeague's fixture-pool parity).
    expect(rows.map((r) => r.teamId)).toEqual([
      'tm_a',
      'tm_glenwood_premier_1',
      'tm_glenwood_premier_2',
    ]);
  });

  it('resolves the chair identically from the operator and admin wire shapes', () => {
    const contact = { name: 'Jane Chair', email: 'jane@club.org', cell: '083 555 0100' };
    const operator = club({
      id: 'op',
      name: 'Operator Club',
      leagues: ['premier'],
      chairContact: contact,
    });
    const admin = club({
      id: 'ad',
      name: 'Admin Club',
      leagues: ['premier'],
      exco: { chair: { ...contact, idNumber: '8001015009087' } },
    });
    const rows = leagueTeamDirectory([operator, admin], 'premier');
    const [adRow, opRow] = rows; // sorted by club name: Admin Club first
    for (const row of [adRow, opRow]) {
      expect(row.chairName).toBe('Jane Chair');
      expect(row.chairEmail).toBe('jane@club.org');
      expect(row.chairCell).toBe('083 555 0100');
    }
  });

  it('falls back to the flat club.chair for the name when contacts carry none', () => {
    const clubs = [club({ id: 'c', name: 'Club', leagues: ['premier'], chair: 'Sam Fallback' })];
    const rows = leagueTeamDirectory(clubs, 'premier');
    expect(rows[0].chairName).toBe('Sam Fallback');
    expect(rows[0].chairEmail).toBeUndefined();
    expect(rows[0].chairCell).toBeUndefined();
  });

  it('excludes clubs not entered in the league', () => {
    const clubs = [
      club({ id: 'in', name: 'In', leagues: ['premier'] }),
      club({ id: 'out', name: 'Out', leagues: ['u13'] }),
      club({ id: 'none', name: 'None', leagues: [] }),
    ];
    const rows = leagueTeamDirectory(clubs, 'premier');
    expect(rows.map((r) => r.clubId)).toEqual(['in']);
  });

  it('sorts by club name, then team name', () => {
    const clubs = [
      club({
        id: 'zebra',
        name: 'Zebra',
        leagues: ['premier'],
        leagueTeams: { premier: 2 },
        teamRosters: {
          premier: [
            { id: 'tm_z2', name: 'Zebra Second' },
            { id: 'tm_z1', name: 'Zebra First' },
          ],
        },
      }),
      club({ id: 'aardvark', name: 'Aardvark', leagues: ['premier'] }),
    ];
    const rows = leagueTeamDirectory(clubs, 'premier');
    expect(rows.map((r) => [r.clubName, r.teamName])).toEqual([
      ['Aardvark', 'Aardvark'],
      ['Zebra', 'Zebra First'],
      ['Zebra', 'Zebra Second'],
    ]);
  });
});

describe('chairContactOf', () => {
  it('prefers the operator chairContact over exco.chair', () => {
    const c = club({
      chair: 'Flat Name',
      chairContact: { name: 'Wire Name', email: 'wire@club.org' },
      exco: { chair: { name: 'Exco Name', email: 'exco@club.org', cell: '082 000 0000' } },
    });
    const contact = chairContactOf(c);
    expect(contact.name).toBe('Wire Name');
    expect(contact.email).toBe('wire@club.org');
    // Fields the wire shape omits still resolve from exco.chair.
    expect(contact.cell).toBe('082 000 0000');
  });

  it('ignores blank/non-string exco values and returns undefined fields', () => {
    const c = club({ exco: { chair: { name: '  ', email: 42 } } });
    expect(chairContactOf(c)).toEqual({ name: undefined, email: undefined, cell: undefined });
  });
});
