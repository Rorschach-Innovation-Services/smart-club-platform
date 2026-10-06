/**
 * The chair's spreadsheet roster upload: parse → review (conflict column) → chunked commit with
 * resume-on-failure → summary. Only `./api` is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from './test-utils';

vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return { ...actual, parseClubRoster: vi.fn(), commitClubRoster: vi.fn() };
});

import { ClubRosterUpload, chunk } from './club-register';
import { parseClubRoster, commitClubRoster } from './api';
import { qk } from './query';

const club = { id: 'alpha', name: 'Alpha CC', district: 'North' };
const leagues = [{ key: 'north-u13', label: 'North U13', district: 'North' }];
const seed: Array<[readonly unknown[], unknown]> = [[qk.tenant(), {}]];

function row(n: number, over: Record<string, unknown> = {}) {
  return {
    rowNumber: n,
    firstName: `First${n}`,
    lastName: `Last${n}`,
    dob: '1995-01-01',
    idNumber: `ID${n}`,
    missingId: false,
    ...over,
  };
}

function parseResponse(rows: ReturnType<typeof row>[], extra: Record<string, unknown> = {}) {
  return {
    parseable: true as const,
    sheets: [
      {
        name: 'Seniors',
        skipped: false,
        hasIdColumn: true,
        totalDataRows: rows.length + 1,
        rows,
        exceptions: [
          {
            rowNumber: 99,
            sheet: 'Seniors',
            reason: 'bad-id-checksum' as const,
            maskedId: '90*********08',
          },
        ],
        unknownGenderRaw: [],
        unknownRaceRaw: [],
      },
    ],
    dobOnlyCount: 0,
    juniorLeagueKeys: ['north-u13'],
    ageGroupRaws: [],
    ...extra,
  };
}

const okChunk = (items: Array<{ rowNumber: number; sheet?: string }>) => ({
  results: items.map((it, index) => ({
    index,
    rowNumber: it.rowNumber,
    sheet: it.sheet,
    outcome: 'created' as const,
  })),
  summary: {
    created: items.length,
    'clearance-opened': 0,
    'clearance-already-open': 0,
    'skipped-duplicate': 0,
    error: 0,
  },
  playerCount: items.length,
});

function renderUpload() {
  const props = { toast: vi.fn(), onDone: vi.fn(), onCancel: vi.fn() };
  const r = renderWithProviders(<ClubRosterUpload club={club} leagues={leagues} {...props} />, {
    seed,
  });
  return { ...r, ...props };
}

async function upload(r: ReturnType<typeof renderUpload>) {
  const file = new File(['x'], 'roster.xlsx');
  fireEvent.change(r.getByLabelText('Roster workbook'), { target: { files: [file] } });
  fireEvent.click(r.getByRole('button', { name: 'Read workbook' }));
  await r.findByText(/player rows? found/);
  return file;
}

describe('chunk', () => {
  it('splits into fixed-size chunks', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 50)).toEqual([]);
  });
});

describe('ClubRosterUpload', () => {
  beforeEach(() => {
    vi.mocked(parseClubRoster).mockReset();
    vi.mocked(commitClubRoster).mockReset();
  });

  it('rejects a non-xlsx file before any upload', () => {
    const r = renderUpload();
    fireEvent.change(r.getByLabelText('Roster workbook'), {
      target: { files: [new File(['x'], 'roster.xls')] },
    });
    expect(r.getByRole('alert')).toHaveTextContent(/\.xlsx/);
    expect(r.getByRole('button', { name: 'Read workbook' })).toBeDisabled();
  });

  it('says what each row will do and excludes rows already on the roster', async () => {
    vi.mocked(parseClubRoster).mockResolvedValue(
      parseResponse([
        row(2, { team: 'north-u13' }),
        row(3, { conflict: { type: 'in-club-duplicate' } }),
        row(4, {
          conflict: { type: 'cross-club', clubId: 'beta', clubName: 'Beta CC', status: 'active' },
        }),
        row(5, {
          conflict: {
            type: 'cross-club',
            clubId: 'gamma',
            clubName: 'Gamma CC',
            status: 'clearance-pending',
          },
        }),
      ]) as never,
    );
    const r = renderUpload();
    const file = await upload(r);
    expect(parseClubRoster).toHaveBeenCalledWith('alpha', file, {});
    expect(r.getByText(/4 player rows found · 1 row can’t be registered/)).toBeInTheDocument();
    expect(r.getByText(/1 ID number fails its check digit/)).toBeInTheDocument();
    // …and each rejected row is listed so the chair can find it in the sheet.
    const rejected = within(r.getByRole('table', { name: 'Rows that can’t be registered' }));
    expect(rejected.getByText('Seniors · row 99')).toBeInTheDocument();
    expect(rejected.getByText('90*********08')).toBeInTheDocument();
    expect(rejected.getByText('ID number fails its check digit')).toBeInTheDocument();
    expect(r.getByText('New registration')).toBeInTheDocument();
    expect(r.getByText('Already on your roster')).toBeInTheDocument();
    expect(r.getByText('Will open a clearance from Beta CC')).toBeInTheDocument();
    expect(r.getByText('Transfer already in progress (Gamma CC)')).toBeInTheDocument();
    expect(r.getByLabelText('Include First3 Last3')).not.toBeChecked();
    expect(r.getByText('North U13')).toBeInTheDocument();
    expect(r.getByRole('button', { name: 'Register 3 players' })).toBeEnabled();
    fireEvent.click(r.getByLabelText('Include First2 Last2'));
    expect(r.getByRole('button', { name: 'Register 2 players' })).toBeEnabled();
  });

  it('commits in chunks of 50 and summarises the outcome', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => row(i + 2));
    vi.mocked(parseClubRoster).mockResolvedValue(parseResponse(rows) as never);
    vi.mocked(commitClubRoster).mockImplementation(async (_id, items) => okChunk(items));
    const r = renderUpload();
    await upload(r);
    fireEvent.click(r.getByRole('button', { name: 'Register 120 players' }));
    expect(await r.findByText('Upload complete')).toBeInTheDocument();
    const sizes = vi.mocked(commitClubRoster).mock.calls.map((c) => c[1].length);
    expect(sizes).toEqual([50, 50, 20]);
    expect(vi.mocked(commitClubRoster).mock.calls[0][1][0]).toEqual({
      rowNumber: 2,
      sheet: 'Seniors',
      firstName: 'First2',
      lastName: 'Last2',
      dob: '1995-01-01',
      idNumber: 'ID2',
    });
    expect(r.getByText('120 registered, 0 clearances opened')).toBeInTheDocument();
    expect(r.toast).toHaveBeenCalledWith('120 registered, 0 clearances opened', 'ok');
    fireEvent.click(r.getByRole('button', { name: 'Done' }));
    expect(r.onDone).toHaveBeenCalled();
  });

  it('pauses on a failed chunk and resumes from it on retry', async () => {
    const rows = Array.from({ length: 70 }, (_, i) => row(i + 2));
    vi.mocked(parseClubRoster).mockResolvedValue(parseResponse(rows) as never);
    vi.mocked(commitClubRoster)
      .mockImplementationOnce(async (_id, items) => okChunk(items))
      .mockRejectedValueOnce(new Error('Network down'))
      .mockImplementation(async (_id, items) => okChunk(items));
    const r = renderUpload();
    await upload(r);
    fireEvent.click(r.getByRole('button', { name: 'Register 70 players' }));
    expect(await r.findByRole('alert')).toHaveTextContent(
      'Network down — 50 rows saved so far. Retry to send the rest.',
    );
    fireEvent.click(r.getByRole('button', { name: 'Retry the rest' }));
    expect(await r.findByText('Upload complete')).toBeInTheDocument();
    const calls = vi.mocked(commitClubRoster).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[2][1]).toEqual(calls[1][1]);
    expect(calls[2][1]).toHaveLength(20);
    expect(r.getByText('70 registered, 0 clearances opened')).toBeInTheDocument();
  });

  it('lets the chair map an unrecognised age group and re-parse with it', async () => {
    vi.mocked(parseClubRoster).mockResolvedValue(
      parseResponse([row(2)], {
        ageGroupRaws: [{ raw: 'Under Thirteen', leagueKey: null }],
      }) as never,
    );
    const r = renderUpload();
    const file = await upload(r);
    fireEvent.change(r.getByLabelText('Team for age group Under Thirteen'), {
      target: { value: 'north-u13' },
    });
    fireEvent.click(r.getByRole('button', { name: 'Apply and read again' }));
    await waitFor(() => expect(parseClubRoster).toHaveBeenCalledTimes(2));
    expect(vi.mocked(parseClubRoster).mock.calls[1]).toEqual([
      'alpha',
      file,
      { 'Under Thirteen': 'north-u13' },
    ]);
  });
});
