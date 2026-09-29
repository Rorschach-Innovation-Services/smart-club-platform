import { describe, it, expect } from 'vitest';
import { playerExportRow, clubExportRow } from './exportXlsx';

// Stub label resolvers — the mapper only calls them; their real forms live in admin.tsx.
const team = (t: string | undefined) => (t ? `Team ${t}` : '');
const role = (p: { isWk?: boolean }) => (p.isWk ? 'WK' : 'Batter');

// The header row fillSheet emits is derived from the FIRST row's keys alone, so every
// export row must carry an identical, complete key set regardless of which fields are set.
const EXPECTED_KEYS = [
  'First name',
  'Last name',
  'Date of birth',
  'ID type',
  'ID number',
  'Gender',
  'Nationality',
  'Race',
  'Cell',
  'Email',
  'Guardian',
  'Club',
  'Team',
  'District',
  'Role',
  'Batting',
  'Bowling',
  'Veterans club',
  'Status',
  'Batting type',
  'Bowler type',
  'Wicketkeeper',
  'All-rounder',
  'Minor',
  'Postal address',
  'Postal code',
  'Previous club',
  'Registered on',
  'Registered via',
  'Registered by',
  'Consent date',
  'ID doc uploaded',
  'Clearance rejected on',
  'Clearance rejected reason',
];

describe('playerExportRow', () => {
  it('emits the full, fixed key set even for a legacy row with every optional undefined', () => {
    // Only the required PlayerRegistration fields are present; everything else is undefined.
    const legacy = {
      naturalKey: 'nk1',
      clubId: 'warriors',
      firstName: 'Ada',
      lastName: 'Zulu',
      dob: '2001-05-02',
      isMinor: false,
      consentAt: '2026-01-01',
      createdAt: '2026-01-01',
    } as never;
    const row = playerExportRow(legacy, team, role);
    expect(Object.keys(row)).toEqual(EXPECTED_KEYS);
    // Unset optionals coerce to '' — never dropped, never undefined.
    expect(row['ID number']).toBe('');
    expect(row.Email).toBe('');
    expect(row.Race).toBe('');
  });

  it('shows a minor’s guardian but blanks it for a non-minor', () => {
    const base = {
      naturalKey: 'nk',
      clubId: 'c',
      firstName: 'Sam',
      lastName: 'M',
      dob: '2015-03-01',
      consentAt: '',
      createdAt: '',
      guardianName: 'Pat Guardian',
    };
    const minor = playerExportRow({ ...base, isMinor: true } as never, team, role);
    const adult = playerExportRow({ ...base, isMinor: false } as never, team, role);
    expect(minor.Guardian).toBe('Pat Guardian');
    expect(adult.Guardian).toBe('');
  });

  it('defaults an unset status to Active and labels known statuses', () => {
    const mk = (status?: string) =>
      playerExportRow(
        {
          naturalKey: 'nk',
          clubId: 'c',
          firstName: 'A',
          lastName: 'B',
          dob: '2000-01-01',
          isMinor: false,
          consentAt: '',
          createdAt: '',
          status,
        } as never,
        team,
        role,
      );
    expect(mk(undefined).Status).toBe('Active');
    expect(mk('clearance-pending').Status).toBe('Clearance pending');
    expect(mk('clearance-rejected').Status).toBe('Clearance rejected');
    expect(mk('inactive').Status).toBe('Inactive');
  });

  it('keeps every key present even when the injected resolvers return empty/placeholder', () => {
    // The resolver contract: whatever resolveTeam/resolveRole return, no key may drop —
    // otherwise fillSheet's first-row-derived header would lose a column for the whole sheet.
    const row = playerExportRow(
      {
        naturalKey: 'nk',
        clubId: 'c',
        firstName: 'A',
        lastName: 'B',
        dob: '2000-01-01',
        isMinor: false,
        consentAt: '',
        createdAt: '',
      } as never,
      () => '',
      () => '—',
    );
    expect(Object.keys(row)).toEqual(EXPECTED_KEYS);
    expect(row.Team).toBe('');
    expect(row.Role).toBe('—');
  });

  it('maps ID type codes and injected clubName/team to human labels', () => {
    const row = playerExportRow(
      {
        naturalKey: 'nk',
        clubId: 'c',
        firstName: 'A',
        lastName: 'B',
        dob: '2000-01-01',
        isMinor: false,
        consentAt: '',
        createdAt: '',
        idType: 'sa-id',
        team: 'premier',
        clubName: 'Warriors CC',
      } as never,
      team,
      role,
    );
    expect(row['ID type']).toBe('SA ID');
    expect(row.Team).toBe('Team premier');
    expect(row.Club).toBe('Warriors CC');
  });

  it('uses idDocMeta.uploadedAt when present and falls back to previousIdDocMeta, truncated to the date', () => {
    const base = {
      naturalKey: 'nk',
      clubId: 'c',
      firstName: 'A',
      lastName: 'B',
      dob: '2000-01-01',
      isMinor: false,
      consentAt: '',
      createdAt: '',
    };
    const own = playerExportRow(
      { ...base, idDocMeta: { uploadedAt: '2026-02-03T10:20:30.000Z' } } as never,
      team,
      role,
    );
    expect(own['ID doc uploaded']).toBe('2026-02-03');
    // idDocMeta absent — a cleared transfer-in carries the vetted doc on previousIdDocMeta.
    const inherited = playerExportRow(
      { ...base, previousIdDocMeta: { uploadedAt: '2025-11-15T08:00:00.000Z' } } as never,
      team,
      role,
    );
    expect(inherited['ID doc uploaded']).toBe('2025-11-15');
    // Neither present — blank, no throw.
    const neither = playerExportRow(base as never, team, role);
    expect(neither['ID doc uploaded']).toBe('');
  });

  it('exports legacy clearance-rejected fields only while status is clearance-rejected', () => {
    const base = {
      naturalKey: 'nk',
      clubId: 'c',
      firstName: 'A',
      lastName: 'B',
      dob: '2000-01-01',
      isMinor: false,
      consentAt: '',
      createdAt: '',
      clearanceRejectedAt: '2026-03-04T12:00:00.000Z',
      clearanceRejectedReason: 'Outstanding fees',
    };
    // Active row: the legacy fields are phantom data and must not surface.
    const active = playerExportRow({ ...base, status: 'active' } as never, team, role);
    expect(active['Clearance rejected on']).toBe('');
    expect(active['Clearance rejected reason']).toBe('');
    // clearance-rejected row: they are meaningful and populated.
    const rejected = playerExportRow(
      { ...base, status: 'clearance-rejected' } as never,
      team,
      role,
    );
    expect(rejected['Clearance rejected on']).toBe('2026-03-04');
    expect(rejected['Clearance rejected reason']).toBe('Outstanding fees');
  });

  it('labels registeredVia codes and passes an unknown value through raw', () => {
    const mk = (registeredVia?: string) =>
      playerExportRow(
        {
          naturalKey: 'nk',
          clubId: 'c',
          firstName: 'A',
          lastName: 'B',
          dob: '2000-01-01',
          isMinor: false,
          consentAt: '',
          createdAt: '',
          registeredVia,
        } as never,
        team,
        role,
      );
    expect(mk('link')['Registered via']).toBe('Registration link');
    expect(mk('portal')['Registered via']).toBe('Club portal');
    expect(mk('imported')['Registered via']).toBe('imported');
    expect(mk(undefined)['Registered via']).toBe('');
  });

  it('truncates full ISO createdAt/consentAt timestamps to the date part', () => {
    const row = playerExportRow(
      {
        naturalKey: 'nk',
        clubId: 'c',
        firstName: 'A',
        lastName: 'B',
        dob: '2000-01-01',
        isMinor: false,
        consentAt: '2026-04-05T09:30:00.000Z',
        createdAt: '2026-04-01T06:15:00.000Z',
      } as never,
      team,
      role,
    );
    expect(row['Registered on']).toBe('2026-04-01');
    expect(row['Consent date']).toBe('2026-04-05');
  });

  it('maps Minor/Wicketkeeper/All-rounder to Yes or blank (No for a non-minor)', () => {
    const base = {
      naturalKey: 'nk',
      clubId: 'c',
      firstName: 'A',
      lastName: 'B',
      dob: '2000-01-01',
      consentAt: '',
      createdAt: '',
    };
    const set = playerExportRow(
      { ...base, isMinor: true, isWk: true, isAllRounder: true } as never,
      team,
      role,
    );
    expect(set.Minor).toBe('Yes');
    expect(set.Wicketkeeper).toBe('Yes');
    expect(set['All-rounder']).toBe('Yes');
    const unset = playerExportRow(
      { ...base, isMinor: false, isWk: false, isAllRounder: false } as never,
      team,
      role,
    );
    expect(unset.Minor).toBe('No');
    expect(unset.Wicketkeeper).toBe('');
    expect(unset['All-rounder']).toBe('');
  });
});

describe('playerExportRow · player profile', () => {
  const base = {
    naturalKey: 'nk',
    clubId: 'c',
    firstName: 'A',
    lastName: 'B',
    dob: '2000-01-01',
    isMinor: false,
    consentAt: '',
    createdAt: '',
    position: 'Striker',
    battingHand: 'Right',
    isWk: true,
  } as never;

  it('keeps the historical cricket key order when the profile is cricket (explicit or default)', () => {
    expect(Object.keys(playerExportRow(base, team, role, { playerProfile: 'cricket' }))).toEqual(
      EXPECTED_KEYS,
    );
    expect(Object.keys(playerExportRow(base, team, role))).toEqual(EXPECTED_KEYS);
  });

  it('positions profile swaps the cricket columns for a single Position column', () => {
    const row = playerExportRow(base, team, role, { playerProfile: 'positions' });
    const cricketOnly = [
      'Role',
      'Batting',
      'Bowling',
      'Batting type',
      'Bowler type',
      'Wicketkeeper',
      'All-rounder',
    ];
    expect(Object.keys(row)).toEqual([
      ...EXPECTED_KEYS.slice(0, EXPECTED_KEYS.indexOf('Role')),
      'Position',
      ...EXPECTED_KEYS.slice(EXPECTED_KEYS.indexOf('Role')).filter((k) => !cricketOnly.includes(k)),
    ]);
    expect(row.Position).toBe('Striker');
  });

  it('positions profile blanks an unset position rather than dropping the column', () => {
    const row = playerExportRow({ ...(base as object), position: undefined } as never, team, role, {
      playerProfile: 'positions',
    });
    expect(row.Position).toBe('');
  });
});

describe('clubExportRow · sport-vertical modules', () => {
  const c = {
    name: 'Northern',
    district: 'North',
    chair: 'Jo Soap',
    affiliation: 'complete',
    cqi: 70,
  } as unknown as Parameters<typeof clubExportRow>[0];
  const helpers = {
    docCompletion: () => 50,
    overallProgress: () => 80,
    cqiBand: () => ({ label: 'B' }),
  };

  it('defaults to every column, in the historical order (cricket unchanged)', () => {
    expect(Object.keys(clubExportRow(c, helpers))).toEqual([
      'Club',
      'District',
      'Chairperson',
      'Affiliation',
      'Docs %',
      'CQI Score',
      'CQI Band',
      'Overall %',
    ]);
  });

  it('relabels the chair column and drops disabled-module columns', () => {
    const row = clubExportRow(c, {
      ...helpers,
      chairLabel: 'Principal',
      modules: { cqi: false, compliance: false },
    });
    expect(row).toEqual({
      Club: 'Northern',
      District: 'North',
      Principal: 'Jo Soap',
      Affiliation: 'complete',
      'Overall %': 80,
    });
  });
});
