import { describe, it, expect } from 'vitest';
import { playerExportRow } from './exportXlsx';

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
  'Status',
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
});
