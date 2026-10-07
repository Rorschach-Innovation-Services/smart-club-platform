/**
 * FixtureAmendmentsPage — the operator's reminder-sheet upload, driven through the browser-visible
 * flow with the api layer mocked: pick a workbook → preview (diffs, warnings, refused sheets,
 * existing clashes) → untick a row / opt into draft relocation (each re-previews and holds
 * Confirm until the new plan is back) → confirm, including the 409 `plan_changed` and introduced
 * clash-gate refusals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './query';
import { FixtureAmendmentsPage } from './platform-fixture-amendments';
import * as api from './api';
import { ApiError } from './api';
import type { TenantConfig } from './types';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    platformGetTenant: vi.fn(),
    platformFixtureAmendmentsPreview: vi.fn(),
    platformFixtureAmendmentsConfirm: vi.fn(),
  };
});

const config = { tenant: 'kzn', branding: { name: 'KZN Union' } } as unknown as TenantConfig;

const changeRow = (over: Partial<api.AmendmentPreviewRow> = {}): api.AmendmentPreviewRow => ({
  rowId: 'Premier Men:7',
  sheetRow: 7,
  competition: 'Premier Men',
  sheet: { home: 'Ilembe', away: 'Crusaders', date: '2026-10-10', time: '13:00', venue: 'Gledhow' },
  outcome: 'matched-change',
  warnings: [],
  skipped: false,
  seriesId: 's-pm',
  seriesName: 'Premier Men T20',
  fixtureId: 'f1',
  fixture: {
    home: 'Ilembe CC',
    away: 'Crusaders CC',
    date: '2026-10-10',
    time: '10:00',
    venue: 'Ilembe Oval',
    status: 'scheduled',
    released: true,
  },
  changes: [
    { field: 'venue', before: 'Ilembe Oval', after: 'Gledhow' },
    { field: 'time', before: '10:00', after: '13:00' },
  ],
  ...over,
});

function makePreview(over: Partial<api.AmendmentPreview> = {}): api.AmendmentPreview {
  return {
    planHash: 'hash-1',
    sheets: [
      {
        sheet: 'Premier Men',
        status: 'ok',
        fixtureRows: 6,
        unrecognisedRows: 0,
        competitions: [{ competition: 'Premier Men', seriesIds: ['s-pm'] }],
        alreadyCorrect: 2,
        rows: [
          changeRow(),
          changeRow({
            rowId: 'Premier Men:8',
            sheetRow: 8,
            sheet: { home: 'Dawn', away: 'Kloof', date: '2026-10-10', venue: '' },
            fixtureId: 'f2',
            fixture: undefined,
            changes: [{ field: 'status', before: 'scheduled', after: 'postponed' }],
          }),
          {
            rowId: 'Premier Men:9',
            sheetRow: 9,
            competition: 'Premier Men',
            sheet: { home: 'Nobody', away: 'Ghosts', date: '2026-10-10', venue: 'Kingsmead' },
            outcome: 'unmatched',
            reason: 'no fixture of this pairing within 7 days',
            warnings: [],
            skipped: false,
          },
          {
            rowId: 'Premier Men:10',
            sheetRow: 10,
            competition: 'Premier Men',
            sheet: { home: 'Ilembe', away: 'Dawn', date: '2026-10-11', venue: 'Mystery Park' },
            outcome: 'venue-unknown',
            warnings: [],
            skipped: false,
          },
          {
            rowId: 'Premier Men:11',
            sheetRow: 11,
            competition: 'Premier Men',
            sheet: { home: 'Kloof', away: 'Crusaders', date: '2026-10-11', venue: 'Kloof' },
            outcome: 'blocked',
            reason: 'the fixture already has a result',
            warnings: [],
            skipped: false,
          },
        ],
      },
      {
        sheet: 'Promotion Women',
        status: 'refused',
        reason: 'the v column moves between rows',
        fixtureRows: 0,
        unrecognisedRows: 9,
        competitions: [],
        alreadyCorrect: 0,
        rows: [],
      },
    ],
    skippedRows: [],
    counts: {
      'matched-change': 2,
      'matched-no-change': 2,
      unmatched: 1,
      ambiguous: 0,
      'venue-unknown': 1,
      blocked: 1,
      'competition-unknown': 0,
      applicable: 2,
      applied: 2,
    },
    moves: [],
    gate: {
      ok: true,
      errors: [],
      introduced: [],
      preExisting: [
        {
          date: '2026-10-10',
          time: '13:00',
          ground: 'Crawford NC',
          fixture: 'Railways v Kloof',
          with: 'Premier Women: Dawn v Ilembe',
        },
      ],
    },
    touchedSeries: [{ id: 's-pm', name: 'Premier Men T20', version: 4 }],
    officials: [{ seriesId: 's-pm', fixtureId: 'f1', umpires: ['J Smith', 'K Naidoo'] }],
    ...over,
  };
}

const okResult: api.AmendmentConfirmResult = {
  backupKey: '_backups/fixture-amendments/kzn/x.json',
  fixturesAmended: 2,
  draftMoves: 0,
  series: [
    {
      seriesId: 's-pm',
      seriesName: 'Premier Men T20',
      status: 'written',
      version: 5,
      fixtureIds: ['f1', 'f2'],
    },
  ],
  splitSlotRisks: [],
  medicoachSync: true,
  clubsNotified: false,
};

function renderPage() {
  const toast = vi.fn();
  queryClient.clear();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/platform/tenants/kzn/fixture-amendments']}>
        <Routes>
          <Route
            path="/platform/tenants/:slug/fixture-amendments"
            element={<FixtureAmendmentsPage toast={toast} />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { toast };
}

const workbook = () =>
  new File(['PK'], '10 & 11 October 2026 - KZNCU Summary Reminder Fixtures.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

async function upload(file = workbook()) {
  const input = screen.getByLabelText(/reminder fixtures workbook/i) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByRole('table', { name: /changes on premier men/i });
  return file;
}

const applyBtn = () => screen.getByRole('button', { name: /^apply \d+ changes?$/i });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.platformGetTenant).mockResolvedValue(config);
});

describe('FixtureAmendmentsPage', () => {
  it('previews diffs, warnings, refused sheets and existing clashes without blocking', async () => {
    vi.mocked(api.platformFixtureAmendmentsPreview).mockResolvedValue(makePreview());
    renderPage();
    const file = await upload();

    expect(api.platformFixtureAmendmentsPreview).toHaveBeenCalledWith('kzn', file, {
      skipRowIds: [],
      relocateDraftClashes: false,
    });
    const changes = screen.getByRole('table', { name: /changes on premier men/i });
    expect(within(changes).getByText('Venue: Ilembe Oval → Gledhow')).toBeInTheDocument();
    expect(within(changes).getByText('Time: 10:00 → 13:00')).toBeInTheDocument();
    expect(within(changes).getByText('Status: scheduled → postponed')).toBeInTheDocument();

    const notApplied = screen.getByRole('table', { name: /rows not applied on premier men/i });
    expect(within(notApplied).getByText('Not matched')).toBeInTheDocument();
    expect(within(notApplied).getByText(/no fixture of this pairing/i)).toBeInTheDocument();
    expect(
      within(notApplied).getByText(/“Mystery Park” is not in the venue list/),
    ).toBeInTheDocument();
    expect(within(notApplied).getByText('Blocked')).toBeInTheDocument();
    expect(within(notApplied).getByText(/already has a result/i)).toBeInTheDocument();

    expect(screen.getByText('Already correct: 2')).toBeInTheDocument();
    expect(screen.getByText(/the v column moves between rows/i)).toBeInTheDocument();
    expect(screen.getByText(/1 clash already on these dates/i)).toBeInTheDocument();
    // Officials on touched fixtures are listed BEFORE confirming, not only in the result.
    const officials = screen.getByRole('region', { name: /umpire appointments affected/i });
    expect(
      within(officials).getByText(/Ilembe CC v Crusaders CC: J Smith, K Naidoo/),
    ).toBeVisible();
    // Existing clashes are reported, never blocking.
    expect(screen.queryByText(/blocked — these amendments/i)).not.toBeInTheDocument();
    expect(applyBtn()).toBeEnabled();
  });

  it('unticking a row re-previews, holds Confirm until the new plan is back, then confirms it', async () => {
    const user = userEvent.setup();
    vi.mocked(api.platformFixtureAmendmentsPreview).mockResolvedValueOnce(makePreview());
    renderPage();
    const file = await upload();

    let release!: (p: api.AmendmentPreview) => void;
    vi.mocked(api.platformFixtureAmendmentsPreview).mockReturnValueOnce(
      new Promise((r) => (release = r)),
    );
    await user.click(screen.getByRole('checkbox', { name: /apply row 7: ilembe v crusaders/i }));
    expect(api.platformFixtureAmendmentsPreview).toHaveBeenLastCalledWith('kzn', file, {
      skipRowIds: ['Premier Men:7'],
      relocateDraftClashes: false,
    });
    expect(applyBtn()).toBeDisabled();
    expect(screen.getByText(/updating the preview/i)).toBeInTheDocument();

    const skipped = makePreview({ planHash: 'hash-2' });
    skipped.sheets[0].rows[0] = { ...skipped.sheets[0].rows[0], skipped: true };
    skipped.counts = { ...skipped.counts, applied: 1 };
    release(skipped);
    await waitFor(() => expect(applyBtn()).toBeEnabled());
    expect(applyBtn()).toHaveTextContent('Apply 1 change');
    expect(screen.getByText('Left as it is')).toBeInTheDocument();

    vi.mocked(api.platformFixtureAmendmentsConfirm).mockResolvedValue({
      ...okResult,
      fixturesAmended: 1,
    });
    await user.click(applyBtn());
    expect(api.platformFixtureAmendmentsConfirm).toHaveBeenCalledWith(
      'kzn',
      file,
      { skipRowIds: ['Premier Men:7'], relocateDraftClashes: false },
      'hash-2',
    );
    expect(await screen.findByText(/amended 1 fixture/i)).toBeInTheDocument();
  });

  it('confirms and summarises: per-series result, officials, not-notified and medicoach notes', async () => {
    const user = userEvent.setup();
    vi.mocked(api.platformFixtureAmendmentsPreview).mockResolvedValue(makePreview());
    vi.mocked(api.platformFixtureAmendmentsConfirm).mockResolvedValue(okResult);
    const { toast } = renderPage();
    await upload();
    await user.click(applyBtn());

    expect(await screen.findByText(/amended 2 fixtures/i)).toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith('Amended 2 fixtures');
    const written = screen.getByRole('table', { name: /competitions written/i });
    expect(within(written).getByText('Premier Men T20')).toBeInTheDocument();
    expect(within(written).getByText('Written')).toBeInTheDocument();
    expect(screen.getByText(/clubs have not been notified/i)).toBeInTheDocument();
    expect(screen.getByText(/15-minute sync/i)).toHaveTextContent(/sync now/i);
    expect(screen.getByText(/Ilembe CC v Crusaders CC: J Smith, K Naidoo/)).toBeInTheDocument();
    // The preview is gone once applied.
    expect(
      screen.queryByRole('table', { name: /changes on premier men/i }),
    ).not.toBeInTheDocument();
  });

  it('escalates a split slot swap as an urgent double-booking risk', async () => {
    const user = userEvent.setup();
    vi.mocked(api.platformFixtureAmendmentsPreview).mockResolvedValue(makePreview());
    vi.mocked(api.platformFixtureAmendmentsConfirm).mockResolvedValue({
      ...okResult,
      series: [
        ...okResult.series,
        { seriesId: 's-pw', seriesName: 'Premier Women', status: 'drifted', fixtureIds: ['g1'] },
      ],
      splitSlotRisks: [
        {
          written: { seriesId: 's-pm', fixtureId: 'f1' },
          stranded: { seriesId: 's-pw', fixtureId: 'g1' },
          ground: 'Gledhow',
          date: '2026-10-10',
          time: '13:00',
        },
      ],
    });
    renderPage();
    await upload();
    await user.click(applyBtn());

    const alert = await screen.findByText(/urgent — live double-booking risk/i);
    expect(alert.closest('[role="alert"]')).toHaveTextContent(
      /upload the sheet again immediately/i,
    );
    expect(screen.getByText('Not written')).toBeInTheDocument();
  });

  it('on 409 plan_changed shows the fresh preview, toasts, and confirms against the new hash', async () => {
    const user = userEvent.setup();
    vi.mocked(api.platformFixtureAmendmentsPreview).mockResolvedValue(makePreview());
    const fresh = makePreview({ planHash: 'hash-fresh' });
    fresh.sheets[0].rows[0] = {
      ...fresh.sheets[0].rows[0],
      changes: [{ field: 'venue', before: 'Ilembe Oval', after: 'Crawford NC' }],
    };
    vi.mocked(api.platformFixtureAmendmentsConfirm)
      .mockRejectedValueOnce(
        new ApiError(
          409,
          'The fixtures changed since your preview. Check the updated preview, then confirm again.',
          'plan_changed',
          { preview: fresh },
        ),
      )
      .mockResolvedValueOnce(okResult);
    const { toast } = renderPage();
    const file = await upload();
    await user.click(applyBtn());

    expect(await screen.findByText('Venue: Ilembe Oval → Crawford NC')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/changed since your preview/i);
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/changed since your preview/i),
      'warn',
    );

    await user.click(applyBtn());
    expect(api.platformFixtureAmendmentsConfirm).toHaveBeenLastCalledWith(
      'kzn',
      file,
      { skipRowIds: [], relocateDraftClashes: false },
      'hash-fresh',
    );
    expect(await screen.findByText(/amended 2 fixtures/i)).toBeInTheDocument();
  });

  it('an introduced clash blocks Confirm and is shown prominently', async () => {
    vi.mocked(api.platformFixtureAmendmentsPreview).mockResolvedValue(
      makePreview({
        gate: {
          ok: false,
          errors: ['introduced clash'],
          introduced: [
            {
              date: '2026-10-10',
              time: '13:00',
              ground: 'Gledhow',
              fixture: 'Ilembe CC v Crusaders CC',
              with: 'Premier Women: Dawn v Kloof',
            },
          ],
          preExisting: [],
        },
      }),
    );
    renderPage();
    await upload();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/blocked — these amendments would introduce 1 venue clash/i);
    expect(alert).toHaveTextContent(/Gledhow: Ilembe CC v Crusaders CC and Premier Women/);
    expect(applyBtn()).toBeDisabled();
  });

  it('relocation is opt-in: turning it on re-previews and lists every planned move', async () => {
    const user = userEvent.setup();
    vi.mocked(api.platformFixtureAmendmentsPreview)
      .mockResolvedValueOnce(makePreview())
      .mockResolvedValueOnce(
        makePreview({
          planHash: 'hash-reloc',
          moves: [
            {
              seriesId: 's-draft',
              seriesName: 'Reserve League',
              fixtureId: 'd1',
              date: '2026-10-10',
              home: 'Kloof 2nds',
              away: 'Dawn 2nds',
              from: 'Gledhow',
              to: 'Kloof Oval',
              takenBy: ['Premier Men T20: Ilembe CC v Crusaders CC'],
              registryMiss: false,
            },
          ],
        }),
      );
    renderPage();
    const file = await upload();
    const toggle = screen.getByRole('checkbox', { name: /move clashing draft fixtures/i });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByRole('table', { name: /draft fixtures that will move/i })).toBeNull();

    await user.click(toggle);
    expect(api.platformFixtureAmendmentsPreview).toHaveBeenLastCalledWith('kzn', file, {
      skipRowIds: [],
      relocateDraftClashes: true,
    });
    const moves = await screen.findByRole('table', { name: /draft fixtures that will move/i });
    expect(within(moves).getByText('Kloof 2nds v Dawn 2nds')).toBeInTheDocument();
    expect(within(moves).getByText('Kloof Oval')).toBeInTheDocument();
    expect(
      within(moves).getByText(/Premier Men T20: Ilembe CC v Crusaders CC/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/every draft fixture of this client on the sheet/i),
    ).toBeInTheDocument();
    // No per-move untick: the only control is the all-or-nothing switch.
    expect(within(moves).queryByRole('checkbox')).toBeNull();
    await waitFor(() => expect(applyBtn()).toBeEnabled());
  });

  it('refuses a non-xlsx file before any request goes out', async () => {
    renderPage();
    const input = screen.getByLabelText(/reminder fixtures workbook/i) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'fixtures.xls')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/excel \.xlsx/i);
    expect(api.platformFixtureAmendmentsPreview).not.toHaveBeenCalled();
  });
});
