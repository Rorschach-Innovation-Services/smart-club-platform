/**
 * Admin "Upload appointments": the weekly sheet → server preview (the CLI's own parser and
 * matcher) → confirm. Rendered for real; only the HTTP client is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return {
    ...actual,
    previewUmpireAppointments: vi.fn(),
    confirmUmpireAppointments: vi.fn(),
  };
});

import * as api from './api';
import { ApiError } from './api';
import { UmpireAppointmentsUpload } from './UmpireAppointmentsUpload';
import { renderWithProviders } from './test-utils';

const preview = (over: Partial<api.AppointmentPreview> = {}): api.AppointmentPreview => ({
  sheet: 'T20 Runner',
  problems: [],
  summary: {
    rows: 4,
    matched: 3,
    notMatched: 1,
    new: 1,
    changed: 0,
    unchanged: 1,
    skipped: 1,
    toCreate: 0,
    doubleBookings: 0,
  },
  rows: [
    {
      sheetRow: 3,
      section: 'Premier league T20',
      date: '2026-10-09',
      time: '09:00',
      home: 'Clares',
      away: 'Chatsworth',
      venue: 'Crusaders Park',
      umpires: ['B.Tyali'],
      seriesId: 's1',
      seriesName: 'Premier T20',
      fixtureId: 'f2',
      fixture: { date: '2026-10-09', time: '09:00' },
      action: 'new',
      appointed: ['B.Tyali'],
      differences: [],
      tieBroken: false,
    },
    {
      sheetRow: 4,
      section: 'Premier league T20',
      date: '2026-10-09',
      time: '10:30',
      home: 'UKZN',
      away: 'Crusaders',
      venue: 'Kingsmead Oval',
      umpires: ['A.Ngubane', 'N.Newcomer'],
      seriesId: 's1',
      seriesName: 'Premier T20',
      fixtureId: 'f3',
      fixture: { date: '2026-10-09', time: '10:00' },
      action: 'skipped',
      skipReason: 'unknown umpire: N.Newcomer',
      differences: [
        { field: 'time', sheet: '10:30', fixture: '10:00' },
        { field: 'venue', sheet: 'Kingsmead Oval', fixture: 'Howard College Oval' },
      ],
      tieBroken: false,
    },
    {
      sheetRow: 5,
      section: 'Premier league T20',
      date: '2026-10-16',
      time: '09:00',
      home: 'Crusaders',
      away: 'Clares',
      venue: 'Crusaders Park',
      umpires: ['O.Panday'],
      seriesId: 's1',
      seriesName: 'Premier T20',
      fixtureId: 'f4',
      fixture: { date: '2026-10-16', time: '09:00' },
      action: 'unchanged',
      appointed: ['O.Panday'],
      differences: [],
      tieBroken: false,
    },
  ],
  unmatched: [
    {
      sheetRow: 6,
      section: 'Premier league T20',
      date: '2026-10-16',
      home: 'Nonexistent CC',
      away: 'Clares',
      venue: '',
      umpires: ['Z.Nobody'],
      kind: 'unknown-team',
      reason: 'no club for: Nonexistent CC',
    },
  ],
  unknownUmpires: ['N.Newcomer'],
  toCreate: [],
  doubleBookings: [],
  planHash: 'hash-1',
  ...over,
});

const xlsx = (name = 'runner.xlsx', size = 1000) =>
  new File([new Uint8Array(size)], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

function renderUpload() {
  const onDone = vi.fn();
  const onBack = vi.fn();
  renderWithProviders(<UmpireAppointmentsUpload onBack={onBack} onDone={onDone} />);
  return { onDone, onBack };
}

const choose = async (file: File) =>
  userEvent.upload(screen.getByLabelText(/Appointments workbook/), file, { applyAccept: false });

beforeEach(() => vi.clearAllMocks());

describe('Upload appointments', () => {
  it('refuses anything but an .xlsx up to 2 MB, before uploading', async () => {
    renderUpload();
    await choose(new File(['a,b'], 'runner.csv', { type: 'text/csv' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/\.xlsx/);
    await choose(xlsx('big.xlsx', 2 * 1024 * 1024 + 1));
    expect(screen.getByRole('alert')).toHaveTextContent(/2 MB/);
    expect(api.previewUmpireAppointments).not.toHaveBeenCalled();
  });

  it('previews matched rows, venue/time differences, unknown umpires and unmatched rows', async () => {
    vi.mocked(api.previewUmpireAppointments).mockResolvedValue(preview());
    renderUpload();
    await choose(xlsx());
    expect(api.previewUmpireAppointments).toHaveBeenCalledWith(expect.any(File), false);

    const diffs = await screen.findByRole('table', { name: 'Venue and time differences' });
    expect(within(diffs).getByRole('row', { name: /Time.*10:30.*10:00/ })).toBeInTheDocument();
    expect(
      within(diffs).getByRole('row', { name: /Venue.*Kingsmead Oval.*Howard/ }),
    ).toBeInTheDocument();

    const matched = screen.getByRole('table', { name: 'Matched rows' });
    expect(within(matched).getByRole('row', { name: /Row 4/ })).toHaveTextContent(
      /unknown umpire: N\.Newcomer/,
    );
    const unmatched = screen.getByRole('table', { name: 'Rows not matched' });
    expect(within(unmatched).getByRole('row', { name: /Row 6/ })).toHaveTextContent(/Unknown team/);

    expect(screen.getByText('N.Newcomer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Write 1 appointment/ })).toBeEnabled();
  });

  it('"create these umpires" re-plans with them', async () => {
    vi.mocked(api.previewUmpireAppointments)
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce(
        preview({
          toCreate: [{ id: 'u-n-newcomer', displayName: 'N.Newcomer' }],
          summary: { ...preview().summary, new: 2, skipped: 0, toCreate: 1 },
          planHash: 'hash-2',
        }),
      );
    renderUpload();
    await choose(xlsx());
    await userEvent.click(await screen.findByRole('checkbox', { name: /Create these umpires/ }));
    expect(api.previewUmpireAppointments).toHaveBeenLastCalledWith(expect.any(File), true);
    expect(
      await screen.findByRole('button', { name: /Write 2 appointments and add 1 umpire/ }),
    ).toBeEnabled();
  });

  it('confirm writes with the previewed plan; a changed plan is shown again to confirm', async () => {
    vi.mocked(api.previewUmpireAppointments).mockResolvedValue(preview());
    vi.mocked(api.confirmUmpireAppointments)
      .mockRejectedValueOnce(
        new ApiError(409, 'Appointments or umpires changed since your preview.', 'plan_changed', {
          preview: preview({ planHash: 'hash-3' }),
        }),
      )
      .mockResolvedValueOnce({ written: 1, created: 0 });
    const { onDone } = renderUpload();
    await choose(xlsx());
    await userEvent.click(await screen.findByRole('button', { name: /Write 1 appointment/ }));
    expect(api.confirmUmpireAppointments).toHaveBeenCalledWith(expect.any(File), false, 'hash-1');
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed since your preview/);

    await userEvent.click(screen.getByRole('button', { name: /Write 1 appointment/ }));
    expect(api.confirmUmpireAppointments).toHaveBeenLastCalledWith(
      expect.any(File),
      false,
      'hash-3',
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/Wrote 1 appointment/);
    expect(onDone).toHaveBeenCalled();
  });

  it('shows the server reason when the sheet cannot be read', async () => {
    vi.mocked(api.previewUmpireAppointments).mockRejectedValue(
      new ApiError(
        400,
        'The sheet has section(s) this union isn\'t set up for: "U9".',
        'unknown_sections',
      ),
    );
    renderUpload();
    await choose(xlsx());
    expect(await screen.findByRole('alert')).toHaveTextContent(/isn't set up for: "U9"/);
  });
});
