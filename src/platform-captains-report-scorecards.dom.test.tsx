/**
 * CaptainsReportScorecardsPage — the operator console for scorecard answers in captains
 * reports, with the api layer mocked: per-tenant sections, each fixture's home and away answers
 * paired home-first, correction text on demand, the stale ⚠, the days selector and status
 * chips (each re-queries the server), the truncated notice and the empty state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './query';
import { CaptainsReportScorecardsPage } from './platform-captains-report-scorecards';
import * as api from './api';
import type { ScorecardConsolePayload, ScorecardConsoleRow } from './types';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, listPlatformCaptainsReportScorecards: vi.fn() };
});
const list = vi.mocked(api.listPlatformCaptainsReportScorecards);

const row = (over: Partial<ScorecardConsoleRow> = {}): ScorecardConsoleRow => ({
  seriesId: 's-1',
  fixtureId: 'f1',
  matchDate: '2026-10-04',
  competition: 'Premier T20',
  homeTeamName: 'Umzinto CC',
  awayTeamName: 'African Warriors',
  home: {
    reportId: 's-1~f1~umzinto',
    reportRef: 'CR-2026-0001',
    clubId: 'umzinto',
    clubName: 'Umzinto CC',
    reportStatus: 'submitted',
    scorecardStatus: 'confirmed',
    submittedAt: '2026-10-05T09:00:00.000Z',
  },
  away: {
    reportId: 's-1~f1~aw',
    reportRef: 'CR-2026-0002',
    clubId: 'aw',
    clubName: 'African Warriors',
    reportStatus: 'submitted',
    scorecardStatus: 'correction',
    feedback: 'C Bowler took 3 wickets, not 2.',
    submittedAt: '2026-10-05T10:00:00.000Z',
  },
  ...over,
});

const payload = (over: Partial<ScorecardConsolePayload> = {}): ScorecardConsolePayload => ({
  days: 14,
  status: 'all',
  since: '2026-09-24',
  total: 2,
  truncated: false,
  tenants: [
    {
      tenant: 'dolphins',
      tenantName: 'Dolphins Cricket',
      rows: [
        row(),
        row({
          fixtureId: 'f2',
          homeTeamName: 'Kloof CC',
          awayTeamName: 'Railways CC',
          home: {
            reportId: 's-1~f2~kloof',
            reportRef: 'CR-2026-0003',
            clubId: 'kloof',
            clubName: 'Kloof CC',
            reportStatus: 'submitted',
            scorecardStatus: 'stale',
            answeredAction: 'confirmed',
          },
          away: undefined,
        }),
      ],
    },
  ],
  ...over,
});

function renderPage() {
  queryClient.clear();
  render(
    <QueryClientProvider client={queryClient}>
      <CaptainsReportScorecardsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  list.mockReset();
});

describe('CaptainsReportScorecardsPage', () => {
  it('pairs both sides of each fixture home-first under its tenant', async () => {
    list.mockResolvedValue(payload());
    renderPage();
    const section = await screen.findByRole('region', {
      name: 'Dolphins Cricket scorecard answers',
    });
    expect(list).toHaveBeenCalledWith(14, 'all');
    const f1 = within(section).getByTestId('scc-fixture-dolphins-s-1-f1');
    expect(f1).toHaveTextContent('Umzinto CC vs African Warriors');
    const home = within(f1).getByTestId('scc-side-umzinto');
    const away = within(f1).getByTestId('scc-side-aw');
    expect(home).toHaveTextContent('Home');
    expect(home).toHaveTextContent('Confirmed');
    expect(home).toHaveTextContent('CR-2026-0001');
    expect(away).toHaveTextContent('Away');
    expect(away).toHaveTextContent('Correction requested');
    // Home renders before away.
    expect(home.compareDocumentPosition(away) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A fixture with one report says so for the missing side.
    expect(within(section).getByTestId('scc-fixture-dolphins-s-1-f2')).toHaveTextContent(
      'Away: no report',
    );
  });

  it('opens and hides correction feedback on demand', async () => {
    list.mockResolvedValue(payload());
    renderPage();
    const btn = await screen.findByRole('button', { name: 'Show African Warriors feedback' });
    expect(screen.queryByText('C Bowler took 3 wickets, not 2.')).toBeNull();
    await userEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('African Warriors feedback')).toHaveTextContent(
      'C Bowler took 3 wickets, not 2.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Hide African Warriors feedback' }));
    expect(screen.queryByText('C Bowler took 3 wickets, not 2.')).toBeNull();
  });

  it('marks a stale answer with an accessible ⚠ naming the answer it overrode', async () => {
    list.mockResolvedValue(payload());
    renderPage();
    const stale = await screen.findByRole('img', { name: /answered against an older scorecard/i });
    expect(stale).toHaveAccessibleName(expect.stringContaining('the answer was: confirmed'));
    expect(screen.getByTestId('scc-side-kloof')).toHaveTextContent('Stale');
  });

  it('re-queries on the days selector and the status chips', async () => {
    list.mockResolvedValue(payload());
    renderPage();
    await screen.findByTestId('scc-fixture-dolphins-s-1-f1');
    await userEvent.selectOptions(screen.getByLabelText('Days'), '30');
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(30, 'all'));
    const chips = screen.getByRole('group', { name: 'Scorecard status' });
    const correction = within(chips).getByRole('button', { name: 'Correction requested' });
    await userEvent.click(correction);
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(30, 'correction'));
    expect(correction).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(chips).getByRole('button', { name: 'Not asked' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(30, 'not-asked'));
  });

  it('says when rows were cut, and shows an empty state when nothing matches', async () => {
    list.mockResolvedValueOnce(payload({ total: 640, truncated: true }));
    renderPage();
    expect(await screen.findByRole('status')).toHaveTextContent('Showing the newest 2 of 640');

    list.mockResolvedValue(payload({ tenants: [], total: 0, status: 'stale' }));
    await userEvent.click(screen.getByRole('button', { name: 'Stale' }));
    expect(await screen.findByText('No matches')).toBeInTheDocument();
    expect(screen.getByText(/No match has a side with this status/)).toBeInTheDocument();
  });
});
