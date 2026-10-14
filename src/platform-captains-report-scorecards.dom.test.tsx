/**
 * CaptainsReportScorecardsPage — the operator console for scorecard answers in captains
 * reports, with the api layer mocked: per-tenant sections, each fixture's home and away answers
 * paired home-first, correction text on demand, the stale ⚠, the days selector and status
 * chips (each re-queries the server, and show per-status counts), the client picker (a server
 * param), the club / competition / search filters (client-side), "Clear filters", the
 * truncated notice and the empty states.
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
  counts: { all: 2, pending: 0, confirmed: 1, correction: 1, stale: 1, 'not-asked': 0 },
  tenantOptions: [
    { tenant: 'dolphins', tenantName: 'Dolphins Cricket' },
    { tenant: 'titans', tenantName: 'Titans Cricket' },
  ],
  tenants: [
    {
      tenant: 'dolphins',
      tenantName: 'Dolphins Cricket',
      rows: [
        row(),
        row({
          fixtureId: 'f2',
          competition: 'Promotion League',
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
    expect(list).toHaveBeenCalledWith(14, 'all', undefined);
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
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(30, 'all', undefined));
    const chips = screen.getByRole('group', { name: 'Scorecard status' });
    const correction = within(chips).getByRole('button', { name: /^Correction requested/ });
    await userEvent.click(correction);
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(30, 'correction', undefined));
    expect(correction).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(chips).getByRole('button', { name: /^Not asked/ }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(30, 'not-asked', undefined));
  });

  it('says when rows were cut, and shows an empty state when nothing matches', async () => {
    list.mockResolvedValueOnce(payload({ total: 640, truncated: true }));
    renderPage();
    expect(await screen.findByRole('status')).toHaveTextContent('Showing the newest 2 of 640');

    list.mockResolvedValue(payload({ tenants: [], total: 0, status: 'stale' }));
    await userEvent.click(screen.getByRole('button', { name: /^Stale/ }));
    expect(await screen.findByText('No matches')).toBeInTheDocument();
    expect(screen.getByText(/No match has a side with this status/)).toBeInTheDocument();
  });

  it('shows each status’s count on its chip, whichever chip is active', async () => {
    list.mockResolvedValue(payload());
    renderPage();
    const chips = await screen.findByRole('group', { name: 'Scorecard status' });
    await screen.findByTestId('scc-fixture-dolphins-s-1-f1');
    expect(within(chips).getByRole('button', { name: /^All/ })).toHaveTextContent('All·2');
    expect(within(chips).getByRole('button', { name: /^Correction requested/ })).toHaveTextContent(
      'Correction requested·1',
    );
    expect(within(chips).getByRole('button', { name: /^Awaiting answer/ })).toHaveTextContent(
      'Awaiting answer·0',
    );
    // The counts come from the server, before its status filter: they stay put on a switch.
    list.mockResolvedValue(payload({ status: 'stale', total: 1 }));
    await userEvent.click(within(chips).getByRole('button', { name: /^Stale/ }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(14, 'stale', undefined));
    expect(within(chips).getByRole('button', { name: /^All/ })).toHaveTextContent('All·2');
  });

  it('renders a side that closed without an answer as "Not asked", counted on its chip', async () => {
    list.mockResolvedValue(
      payload({
        status: 'not-asked',
        total: 1,
        counts: { all: 3, pending: 0, confirmed: 1, correction: 1, stale: 1, 'not-asked': 1 },
        tenants: [
          {
            tenant: 'dolphins',
            tenantName: 'Dolphins Cricket',
            rows: [
              row({
                fixtureId: 'f3',
                homeTeamName: 'Kloof CC',
                awayTeamName: 'Umzinto CC',
                home: {
                  reportId: 's-1~f3~kloof',
                  reportRef: 'CR-2026-0005',
                  clubId: 'kloof',
                  clubName: 'Kloof CC',
                  reportStatus: 'submitted',
                  scorecardStatus: 'not-asked',
                  submittedAt: '2026-10-05T09:00:00.000Z',
                },
                away: undefined,
              }),
            ],
          },
        ],
      }),
    );
    renderPage();
    const side = await screen.findByTestId('scc-side-kloof');
    expect(within(side).getByText('Not asked')).toHaveClass('pill-muted');
    expect(side).toHaveTextContent('CR-2026-0005');
    const chips = screen.getByRole('group', { name: 'Scorecard status' });
    expect(within(chips).getByRole('button', { name: /^Not asked/ })).toHaveTextContent(
      'Not asked·1',
    );
  });

  it('the client picker re-queries for one tenant and lists every tenant', async () => {
    list.mockResolvedValue(payload());
    renderPage();
    await screen.findByTestId('scc-fixture-dolphins-s-1-f1');
    const picker = screen.getByRole('combobox', { name: 'Client' });
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All clients', 'Dolphins Cricket', 'Titans Cricket']);
    await userEvent.selectOptions(picker, 'titans');
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(14, 'all', 'titans'));
  });

  it('club, competition and search narrow the loaded rows in the browser', async () => {
    list.mockResolvedValue(payload());
    renderPage();
    await screen.findByTestId('scc-fixture-dolphins-s-1-f1');
    const calls = list.mock.calls.length;
    const shown = () =>
      screen.queryAllByTestId(/^scc-fixture-/).map((el) => el.getAttribute('data-testid'));

    const club = screen.getByRole('combobox', { name: 'Club' });
    expect(
      within(club)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All clubs', 'African Warriors', 'Kloof CC', 'Railways CC', 'Umzinto CC']);
    await userEvent.selectOptions(club, 'Kloof CC');
    expect(shown()).toEqual(['scc-fixture-dolphins-s-1-f2']);
    expect(screen.getByText('1 of 2 matches fit these filters.')).toBeInTheDocument();
    await userEvent.selectOptions(club, '');

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Competition' }),
      'Premier T20',
    );
    expect(shown()).toEqual(['scc-fixture-dolphins-s-1-f1']);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Competition' }), '');

    const search = screen.getByRole('searchbox', { name: 'Search matches' });
    await userEvent.type(search, 'umzinto cc vs');
    expect(shown()).toEqual(['scc-fixture-dolphins-s-1-f1']);
    await userEvent.clear(search);
    await userEvent.type(search, 'CR-2026-0003');
    expect(shown()).toEqual(['scc-fixture-dolphins-s-1-f2']);
    // Filters compose: Kloof's row is not a Premier T20 match.
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Competition' }),
      'Premier T20',
    );
    expect(shown()).toEqual([]);
    expect(screen.getByText('No matches fit these filters')).toBeInTheDocument();
    // None of it went to the server.
    expect(list.mock.calls.length).toBe(calls);
  });

  it('"Clear filters" resets status, client, club, competition and search — not the window', async () => {
    list.mockResolvedValue(payload());
    renderPage();
    await screen.findByTestId('scc-fixture-dolphins-s-1-f1');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Days'), '30');
    await userEvent.click(screen.getByRole('button', { name: /^Confirmed/ }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Client' }), 'dolphins');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Club' }), 'Umzinto CC');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search matches' }), 'umzinto');
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(30, 'confirmed', 'dolphins'));

    await userEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]);
    // Back on the unscoped, all-status query (30 days, cached from earlier): both rows again.
    await waitFor(() =>
      expect(screen.queryAllByTestId(/^scc-fixture-/).map((el) => el.dataset.testid)).toEqual([
        'scc-fixture-dolphins-s-1-f1',
        'scc-fixture-dolphins-s-1-f2',
      ]),
    );
    expect(screen.getByRole('combobox', { name: 'Client' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Club' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Competition' })).toHaveValue('');
    expect(screen.getByRole('searchbox', { name: 'Search matches' })).toHaveValue('');
    expect(screen.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Days')).toHaveValue('30');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });
});
