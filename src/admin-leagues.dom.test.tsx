/**
 * The admin Leagues page — the catalogue, plus where each league stands for its season.
 *
 * One status per league with one next step: the operator sets a league up, clubs affiliate
 * their sides, the admin starts the season, then works through it on Fixtures & Venues.
 * The admin never edits a setup here; a league that needs one gets a request to copy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminLeagues } from './admin';
import { renderWithProviders } from './test-utils';
import { currentSeasonLabel } from './data';
import type {
  Club,
  CompetitionStructure,
  League,
  SeasonCalendar,
  SeasonRun,
  StageSpec,
} from './types';

const structure = {
  id: 'st-1',
  name: 'Flat round robin',
  version: 1,
  overs: 20,
  stages: [
    {
      id: 'season',
      name: 'League season',
      format: { kind: 'round-robin', legs: 1 },
      entrants: { kind: 'all-registered' },
      schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
    } as StageSpec,
  ],
} as CompetitionStructure;

// Far enough ahead that "today" never ends it.
const calendar: SeasonCalendar = {
  id: 'cal-1',
  label: 'Current season',
  blocks: [{ id: 'b1', label: 'Block 1', start: '2026-01-10', end: '2099-03-27' }],
};

const lg = (key: string, label: string, setup = true): League =>
  ({
    key,
    label,
    group: 'Senior',
    district: 'All districts',
    ...(setup ? { setup: { structureId: 'st-1', calendarId: 'cal-1' } } : {}),
  }) as League;

const leagues = [
  lg('ready', 'Ready League'),
  lg('bare', 'Bare League', false),
  lg('thin', 'Thin League'),
  lg('live', 'Live League'),
];

const club = (id: string, keys: string[], affiliation = 'complete') =>
  ({ id, name: `Club ${id}`, leagues: keys, affiliation }) as unknown as Club;

const clubs = [
  club('a', ['ready', 'bare', 'live']),
  club('b', ['ready', 'bare', 'live']),
  club('c', ['thin']),
  club('d', ['thin'], 'in_progress'),
];

const liveRun = {
  id: 'run-live',
  leagueKey: 'live',
  seasonLabel: '2026/27',
  structureSnapshot: structure,
  calendarSnapshot: calendar,
  stages: [{ specId: 'season', status: 'ready', groups: [] }],
  version: 1,
} as unknown as SeasonRun;

const renderPage = (over: Record<string, unknown> = {}) => {
  const props = {
    allLeagues: leagues,
    clubs,
    onCreate: vi.fn(),
    onEdit: vi.fn(),
    onDeleteLeague: vi.fn(),
    toast: vi.fn(),
    structures: [structure],
    calendars: [calendar],
    seasonRuns: [liveRun],
    onCreateSeasonRun: vi.fn().mockResolvedValue(undefined),
    onRefreshSeasonSetup: vi.fn().mockResolvedValue(undefined),
    onOpenSeason: vi.fn(),
    onOpenClub: vi.fn(),
    ...over,
  };
  const user = userEvent.setup();
  renderWithProviders(<AdminLeagues {...props} />);
  return { user, props };
};

const rowOf = (label: string) => screen.getByRole('row', { name: new RegExp(`^${label}`) });

beforeEach(() => vi.clearAllMocks());

describe('the admin Leagues page — season readiness', () => {
  it('keeps the catalogue columns and adds one season status per league', () => {
    renderPage();
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.slice(0, 5)).toEqual([
      'League',
      'District',
      'Group',
      'Clubs registered',
      'Season',
    ]);

    expect(within(rowOf('Ready League')).getByText('Ready to start')).toBeVisible();
    expect(within(rowOf('Bare League')).getByText('Needs operator setup')).toBeVisible();
    expect(within(rowOf('Thin League')).getByText('Needs sides')).toBeVisible();
    expect(within(rowOf('Live League')).getByText('Season running')).toBeVisible();
    // Edit and Delete stay on every row.
    expect(within(rowOf('Bare League')).getByRole('button', { name: 'Edit' })).toBeVisible();
    expect(within(rowOf('Bare League')).getByRole('button', { name: 'Delete' })).toBeVisible();
  });

  it('summarises the statuses above the table', () => {
    renderPage();
    expect(screen.getByLabelText('Season readiness')).toHaveTextContent(
      '1 ready to start1 needs operator setup1 needs sides1 running',
    );
  });

  it('shows each league’s setup, sides and season facts', () => {
    renderPage();
    expect(rowOf('Ready League')).toHaveTextContent(
      /Flat round robin · 20 overs on Current season/,
    );
    expect(rowOf('Ready League')).toHaveTextContent(/2 registered, 2 affiliated/);
    expect(rowOf('Bare League')).toHaveTextContent(/Not set up/);
    expect(rowOf('Live League')).toHaveTextContent(/2026\/27 · Stage 1 of 1: entrants confirmed/);
  });

  it('gives a league without setup a copyable request for the operator, and no Start', async () => {
    const { user, props } = renderPage();
    // userEvent.setup() installs its own clipboard; watch that one.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    const row = rowOf('Bare League');

    const request =
      'Please set up Bare League for a season: it needs a structure and a season calendar.';
    expect(within(row).getByText(request)).toBeVisible();
    expect(within(row).queryByRole('button', { name: /start season/i })).toBeNull();

    await user.click(within(row).getByRole('button', { name: 'Copy request for Bare League' }));
    expect(writeText).toHaveBeenCalledWith(request);
    expect(props.toast).toHaveBeenCalledWith('Request copied — send it to your operator');
  });

  it('lists the clubs that are registered but not affiliated, each one a link to the club', async () => {
    const { user, props } = renderPage();
    const row = rowOf('Thin League');
    expect(row).toHaveTextContent(/2 registered, 1 affiliated/);
    await user.click(within(row).getByRole('button', { name: 'Club d' }));
    expect(props.onOpenClub).toHaveBeenCalledWith('d');
  });

  it('opens the running season on Fixtures & Venues', async () => {
    const { user, props } = renderPage();
    await user.click(screen.getByRole('button', { name: 'Open season — Live League' }));
    expect(props.onOpenSeason).toHaveBeenCalledWith('run-live');
  });

  it('starts a season from the row, with that league preselected', async () => {
    const { user, props } = renderPage({
      allLeagues: [lg('other', 'Other League'), ...leagues],
      clubs: clubs.map((c) =>
        ['a', 'b'].includes(c.id) ? { ...c, leagues: [...(c.leagues ?? []), 'other'] } : c,
      ),
    });
    await user.click(screen.getByRole('button', { name: 'Start season — Ready League' }));

    const dialog = screen.getByRole('dialog', { name: /^start a season$/i });
    expect(within(dialog).getByRole('combobox', { name: 'League' })).toHaveValue('ready');
    // Opening the modal refetches the season setup.
    expect(props.onRefreshSeasonSetup).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole('button', { name: /^start season$/i }));
    expect(props.onCreateSeasonRun).toHaveBeenCalledTimes(1);
    const body = props.onCreateSeasonRun.mock.calls[0][0];
    expect(Object.keys(body).sort()).toEqual(['id', 'leagueKey', 'seasonLabel', 'version']);
    expect(body).toMatchObject({
      leagueKey: 'ready',
      seasonLabel: currentSeasonLabel(),
      version: 1,
    });
    expect(screen.queryByRole('dialog', { name: /^start a season$/i })).toBeNull();
  });

  it('lists the leagues that cannot start in the modal, disabled, with their reason', async () => {
    const { user } = renderPage();
    await user.click(screen.getByRole('button', { name: /^start a season$/i }));
    const picker = within(screen.getByRole('dialog')).getByRole('combobox', { name: 'League' });
    expect(picker).toHaveValue('ready');
    expect(
      within(picker).getByRole('option', { name: 'Bare League — not set up by your operator' }),
    ).toBeDisabled();
    expect(
      within(picker).getByRole('option', {
        name: 'Thin League — needs sides — 2 registered, 1 affiliated',
      }),
    ).toBeDisabled();
  });

  it('waits for the season setup instead of guessing a status', () => {
    renderPage({ seasonSetupLoading: true });
    expect(screen.getByText(/Checking each league.s season setup/)).toBeVisible();
    expect(screen.queryByText('Needs operator setup')).toBeNull();
    expect(screen.queryByRole('button', { name: /start (a )?season/i })).toBeNull();
  });

  it('says so when the season setup could not be loaded, rather than show false statuses', () => {
    renderPage({ seasonSetupFailed: true });
    expect(screen.getByText(/Couldn.t load the season setup/)).toBeVisible();
    expect(screen.queryByText('Needs operator setup')).toBeNull();
    expect(screen.queryByRole('button', { name: /start (a )?season/i })).toBeNull();
  });

  it('offers no Start without a way to create the season', () => {
    renderPage({ onCreateSeasonRun: undefined });
    expect(within(rowOf('Ready League')).getByText('Ready to start')).toBeVisible();
    expect(screen.queryByRole('button', { name: /start (a )?season/i })).toBeNull();
  });
});
