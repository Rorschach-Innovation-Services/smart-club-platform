/**
 * Fixtures & Venues hub — finding and managing the week's fixtures (This week, All fixtures,
 * Results, Venues) in front of the unchanged Seasons & series editor. Results come in on the
 * fixtures (GET /series joins them). Every write goes through the same handlers the editor
 * uses; the failure paths — a ground clash, a stale page, a fixture medicoach already holds, a
 * result medicoach changed — keep the dialog open with the reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminFixtures } from './admin';
import { ApiError } from './api';
import { renderWithProviders } from './test-utils';
import type { Club, Series, TenantConfig } from './types';

const clubs = [
  { id: 'spartan', name: 'Spartan Sporting CC', ground: { venue: 'Spartan Park' } },
  { id: 'tongaat', name: 'Tongaat CC', ground: { venue: 'Tongaat Oval' } },
  { id: 'ilembe', name: 'Ilembe CC', ground: { venue: 'KwaDukuza Stadium' } },
] as unknown as Club[];

const result = (over: Record<string, unknown> = {}) => ({
  homeScore: '204/5 (50)',
  awayScore: '191/8 (50)',
  summary: 'Spartan Sporting CC won by 13 runs',
  winner: 'home',
  noResult: false,
  source: 'live',
  recordedAt: '2026-10-03T15:30:00.000Z',
  medicoachMatchUrl: 'https://live.medicoach.co.za/match/x',
  play: null,
  confirmation: null,
  changedSinceConfirmed: false,
  ...over,
});

const series = (over: Partial<Series> = {}): Series =>
  ({
    id: 's1',
    name: 'EMCU Division 2',
    startDate: '2026-09-26',
    teams: ['spartan', 'tongaat', 'ilembe'],
    maxOvers: 50,
    released: true,
    approved: true,
    version: 1,
    fixtures: [
      {
        id: 'f1',
        round: 1,
        date: '2026-10-03',
        time: '10:00',
        home: 'spartan',
        away: 'tongaat',
        officials: { umpires: [{ umpireId: 'u1', name: 'Sipho Mkhize' }] },
        result: result({
          confirmation: { confirmedAt: '2026-10-04T08:00:00.000Z', confirmedBy: 'office@dolphins' },
        }),
      },
      // Played, no result from medicoach yet.
      { id: 'f2', round: 1, date: '2026-10-03', time: '13:00', home: 'ilembe', away: 'spartan' },
      // Played, result in with ground time and balls, not confirmed yet.
      {
        id: 'f4',
        round: 1,
        date: '2026-10-03',
        time: '13:00',
        home: 'tongaat',
        away: 'ilembe',
        result: result({
          homeScore: '150/9 (50)',
          awayScore: '151/2 (31.4)',
          summary: 'Ilembe CC won by 8 wickets',
          winner: 'away',
          recordedAt: '2026-10-03T16:00:00.000Z',
          play: {
            startedAt: '2026-10-03T11:02:00.000Z',
            endedAt: '2026-10-03T16:40:00.000Z',
            legalBalls: 490,
            deliveries: 512,
          },
        }),
      },
      { id: 'f3', round: 2, date: '2026-10-10', time: '10:00', home: 'tongaat', away: 'ilembe' },
    ],
    ...over,
  }) as unknown as Series;

function renderHub(all: Series[] = [series()], over: Record<string, unknown> = {}) {
  const handlers = {
    onUpdateSeries: vi.fn().mockResolvedValue(undefined),
    onSaveOfficials: vi.fn().mockResolvedValue(undefined),
    onSaveScorers: vi.fn().mockResolvedValue(undefined),
    onCreateScorer: vi.fn(async (displayName: string) => ({
      id: 's-new',
      displayName,
      active: true,
    })),
    onConfirmResult: vi.fn().mockResolvedValue({}),
    onUnconfirmResult: vi.fn().mockResolvedValue({}),
    toast: vi.fn(),
    ...over,
  };
  renderWithProviders(
    <AdminFixtures
      defaultTab="week"
      clubs={clubs}
      allSeries={all}
      onUpdateSeries={handlers.onUpdateSeries}
      onDeleteSeries={vi.fn()}
      onDuplicateSeries={vi.fn()}
      onSetReleased={vi.fn()}
      onReveal={vi.fn()}
      onSetApproved={vi.fn()}
      toast={handlers.toast}
      allVenues={[{ id: 'v-kings', name: 'Kingsmead', suburb: 'Stamford Hill' }]}
      allSeasonRuns={[]}
      allLeagues={[]}
      tenantConfig={{ structures: [], calendars: [] } as unknown as TenantConfig}
      onSaveVenue={vi.fn()}
      onDeleteVenue={vi.fn()}
      onAllocateVenues={vi.fn()}
      onCreateSeasonRun={vi.fn()}
      onPatchSeasonRun={vi.fn()}
      onDeleteSeasonRun={vi.fn()}
      onGenerateStageSeries={vi.fn()}
      umpires={[
        { id: 'u1', displayName: 'Sipho Mkhize', aliases: [], active: true },
        { id: 'u2', displayName: 'Riaan Botes', aliases: [], active: true },
      ]}
      onSaveOfficials={handlers.onSaveOfficials}
      scorers={[{ id: 's1', displayName: 'Lindiwe Khoza', active: true }]}
      onSaveScorers={handlers.onSaveScorers}
      onCreateScorer={handlers.onCreateScorer}
      onConfirmResult={handlers.onConfirmResult}
      onUnconfirmResult={handlers.onUnconfirmResult}
    />,
  );
  return handlers;
}

/** Run the updater a dialog handed onUpdateSeries against the stored series. */
const applied = (fn: ReturnType<typeof vi.fn>, call = 0) =>
  (fn.mock.calls[call][1] as (s: Series) => Series & { confirmRemoveSynced?: boolean })(series());
const fx = (s: Series, id: string) =>
  (s.fixtures as Array<Record<string, unknown>>).find((f) => f.id === id);

beforeEach(() => {
  // Monday 5 October 2026, 10:00 SAST — results day for the weekend just played.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T08:00:00Z'));
  window.history.replaceState(null, '', '/admin/fixtures');
});
afterEach(() => vi.useRealTimers());

describe('This week', () => {
  it('opens on the weekend just played, with the weekly checks and the results on the fixtures', () => {
    renderHub();
    expect(screen.getByRole('tab', { name: 'This week', selected: true })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /results/i }).textContent).toMatch(/1$/);
    expect(screen.getByText('Last week')).toBeTruthy();
    const checks = screen.getByRole('group', { name: 'Weekly checks' });
    // 3 played: one confirmed, one result to confirm, one missing.
    expect(within(checks).getByRole('button', { name: /results confirmed\s*1\/3/i })).toBeTruthy();
    expect(within(checks).getByRole('button', { name: /umpires appointed\s*0\/3/i })).toBeTruthy();
    expect(within(checks).getByRole('button', { name: /scorers appointed/i })).toBeTruthy();
    const day = screen.getByRole('region', { name: 'Saturday 3 October' });
    expect(within(day).getByText('Spartan Sporting CC won by 13 runs')).toBeTruthy();
    expect(within(day).getByText(/confirmed by office/i)).toBeTruthy();
    expect(
      within(day)
        .getAllByRole('link', { name: /scorecard/i })[0]
        .getAttribute('href'),
    ).toBe('https://live.medicoach.co.za/match/x');
    expect(document.querySelector('.fix-table')).toBeNull();
  });

  it('a check narrows the week to the games that need it', async () => {
    const user = userEvent.setup();
    renderHub();
    await user.click(screen.getByRole('button', { name: /results confirmed/i }));
    const day = screen.getByRole('region', { name: 'Saturday 3 October' });
    // The missing result and the one to confirm — not the confirmed one.
    expect(
      within(day)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringMatching(/Ilembe CC.*Spartan/),
      expect.stringMatching(/Tongaat CC.*Ilembe/),
    ]);
    await user.click(screen.getByRole('button', { name: /show the whole week/i }));
    expect(
      within(screen.getByRole('region', { name: 'Saturday 3 October' })).getAllByRole('listitem'),
    ).toHaveLength(3);
  });

  it('adds a fixture to the series through the same series write', async () => {
    const user = userEvent.setup();
    const h = renderHub();
    await user.click(screen.getByRole('button', { name: /add fixture/i }));
    const dlg = screen.getByRole('dialog', { name: /add a fixture/i });
    expect(within(dlg).getByRole('button', { name: /^add fixture$/i })).toBeDisabled();
    await user.type(within(dlg).getByLabelText('Date'), '2026-10-17');
    await user.selectOptions(within(dlg).getByLabelText('Home (host)'), 'ilembe');
    await user.selectOptions(within(dlg).getByLabelText('Away (visitors)'), 'tongaat');
    await user.click(within(dlg).getByRole('button', { name: /^add fixture$/i }));
    const next = applied(h.onUpdateSeries);
    const added = (next.fixtures as Array<Record<string, unknown>>).at(-1)!;
    expect(added).toMatchObject({
      date: '2026-10-17',
      home: 'ilembe',
      away: 'tongaat',
      round: 3,
      status: 'scheduled',
    });
    expect(added.id).toMatch(/^f\d+$/);
    expect(next.fixtures).toHaveLength(5);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('refuses a team playing itself before anything is sent', async () => {
    const user = userEvent.setup();
    const h = renderHub();
    await user.click(screen.getByRole('button', { name: /add fixture/i }));
    const dlg = screen.getByRole('dialog', { name: /add a fixture/i });
    await user.type(within(dlg).getByLabelText('Date'), '2026-10-17');
    await user.selectOptions(within(dlg).getByLabelText('Home (host)'), 'ilembe');
    await user.selectOptions(within(dlg).getByLabelText('Away (visitors)'), 'ilembe');
    expect(within(dlg).getByText('A team cannot play itself.')).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: /^add fixture$/i })).toBeDisabled();
    expect(h.onUpdateSeries).not.toHaveBeenCalled();
  });

  it('edits time and ground; a registered ground is locked so allocation never moves it', async () => {
    const user = userEvent.setup();
    const h = renderHub();
    const day = screen.getByRole('region', { name: 'Saturday 3 October' });
    await user.click(within(day).getByRole('button', { name: /edit ilembe cc v spartan/i }));
    const dlg = screen.getByRole('dialog', { name: /edit fixture/i });
    const time = within(dlg).getByLabelText('Start time');
    await user.clear(time);
    await user.type(time, '14:30');
    await user.click(within(dlg).getByLabelText('A registered ground'));
    await user.selectOptions(within(dlg).getByLabelText('Registered ground'), 'v-kings');
    await user.click(within(dlg).getByRole('button', { name: /save fixture/i }));
    expect(fx(applied(h.onUpdateSeries), 'f2')).toMatchObject({
      time: '14:30',
      venueId: 'v-kings',
      venueName: 'Kingsmead',
      venueLocked: true,
    });
  });

  it('a ground clash keeps the dialog open with the reason', async () => {
    const user = userEvent.setup();
    renderHub([series()], {
      onUpdateSeries: vi.fn().mockRejectedValue(
        new ApiError(409, 'Change blocked', 'venue_clash', {
          clashes: [{ venue: 'Kingsmead', date: '2026-10-03', message: 'already hosts Club X' }],
        }),
      ),
    });
    const day = screen.getByRole('region', { name: 'Saturday 3 October' });
    await user.click(within(day).getByRole('button', { name: /edit ilembe cc v spartan/i }));
    const dlg = screen.getByRole('dialog', { name: /edit fixture/i });
    await user.click(within(dlg).getByRole('button', { name: /save fixture/i }));
    expect(within(dlg).getByRole('alert').textContent).toMatch(
      /double-book a ground.*Kingsmead · 2026-10-03/s,
    );
    expect(within(dlg).getByRole('button', { name: /save fixture/i })).toBeEnabled();
  });

  it('removing a fixture medicoach holds is refused; Mark cancelled is the way', async () => {
    const user = userEvent.setup();
    const update = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(
          409,
          'This fixture is already in medicoach … Mark it cancelled instead',
          'synced_fixture_removed',
        ),
      )
      .mockResolvedValue(undefined);
    renderHub([series()], { onUpdateSeries: update });
    const day = screen.getByRole('region', { name: 'Saturday 3 October' });
    await user.click(within(day).getByRole('button', { name: /remove ilembe cc v spartan/i }));
    const dlg = screen.getByRole('dialog', { name: /remove this fixture/i });
    await user.click(within(dlg).getByRole('button', { name: /^remove fixture$/i }));
    expect(within(dlg).getByRole('alert').textContent).toMatch(/already in medicoach/);
    expect(within(dlg).getByRole('button', { name: /remove here only/i })).toBeTruthy();
    expect((applied(update, 0).fixtures as unknown[]).length).toBe(3);
    await user.click(within(dlg).getByRole('button', { name: /mark cancelled/i }));
    expect(fx(applied(update, 1), 'f2')?.status).toBe('cancelled');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"Remove here only" sends the explicit confirmation', async () => {
    const user = userEvent.setup();
    const update = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, 'already in medicoach', 'synced_fixture_removed'))
      .mockResolvedValue(undefined);
    renderHub([series()], { onUpdateSeries: update });
    const day = screen.getByRole('region', { name: 'Saturday 3 October' });
    await user.click(within(day).getByRole('button', { name: /remove ilembe cc v spartan/i }));
    const dlg = screen.getByRole('dialog', { name: /remove this fixture/i });
    await user.click(within(dlg).getByRole('button', { name: /^remove fixture$/i }));
    await user.click(within(dlg).getByRole('button', { name: /remove here only/i }));
    const sent = applied(update, 1);
    expect(sent.confirmRemoveSynced).toBe(true);
    expect(fx(sent, 'f2')).toBeUndefined();
  });

  it('appoints umpires and scorers (adding a new scorer on the way)', async () => {
    const user = userEvent.setup();
    const h = renderHub();
    const day = screen.getByRole('region', { name: 'Saturday 3 October' });
    await user.click(
      within(day).getByRole('button', { name: /umpires for spartan sporting cc v tongaat/i }),
    );
    let dlg = screen.getByRole('dialog', { name: /appoint umpires/i });
    await user.type(within(dlg).getByRole('combobox', { name: 'Umpire 2' }), 'riaan');
    await user.click(within(dlg).getByRole('option', { name: /riaan botes/i }));
    await user.click(within(dlg).getByRole('button', { name: /save umpires/i }));
    expect(h.onSaveOfficials).toHaveBeenCalledWith('s1', 'f1', ['u1', 'u2']);

    await user.click(
      within(day).getByRole('button', { name: /scorers for spartan sporting cc v tongaat/i }),
    );
    dlg = screen.getByRole('dialog', { name: /appoint scorers/i });
    await user.type(within(dlg).getByRole('combobox', { name: 'Scorer' }), 'lind');
    await user.click(within(dlg).getByRole('option', { name: /lindiwe khoza/i }));
    await user.type(within(dlg).getByRole('combobox', { name: 'Backup scorer' }), 'Thandeka M');
    await user.click(
      within(dlg).getByRole('button', { name: /add “thandeka m” as a new scorer/i }),
    );
    await user.click(within(dlg).getByRole('button', { name: /save scorers/i }));
    expect(h.onCreateScorer).toHaveBeenCalledWith('Thandeka M');
    expect(h.onSaveScorers).toHaveBeenCalledWith('s1', 'f1', ['s1', 's-new']);
  });

  it('a failed officials save stays open with the reason', async () => {
    const user = userEvent.setup();
    renderHub([series()], {
      onSaveScorers: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    });
    const day = screen.getByRole('region', { name: 'Saturday 3 October' });
    await user.click(within(day).getByRole('button', { name: /scorers for ilembe cc v spartan/i }));
    const dlg = screen.getByRole('dialog', { name: /appoint scorers/i });
    await user.click(within(dlg).getByRole('button', { name: /save scorers/i }));
    expect(within(dlg).getByRole('alert').textContent).toMatch(/check your connection/i);
  });
});

describe('Results', () => {
  it('lists missing results, then results to check and confirm, then the confirmed ones', async () => {
    const user = userEvent.setup();
    renderHub();
    await user.click(screen.getByRole('tab', { name: /results/i }));
    expect(
      within(screen.getByRole('region', { name: /without a result/i })).getByText('Ilembe CC'),
    ).toBeTruthy();
    const toConfirm = screen.getByRole('region', { name: /results to confirm/i });
    expect(within(toConfirm).getByText('Ilembe CC won by 8 wickets')).toBeTruthy();
    expect(within(toConfirm).getByText(/5 h 38 on the ground · 490 balls/)).toBeTruthy();
    const confirmed = screen.getByRole('region', { name: /confirmed results/i });
    expect(within(confirmed).queryByText('Spartan Sporting CC won by 13 runs')).toBeNull();
    await user.click(within(confirmed).getByRole('button', { name: /show/i }));
    expect(within(confirmed).getByText('Spartan Sporting CC won by 13 runs')).toBeTruthy();
  });

  it('confirms the result the admin is looking at', async () => {
    const user = userEvent.setup();
    const h = renderHub();
    await user.click(screen.getByRole('tab', { name: /results/i }));
    await user.click(
      screen.getByRole('button', { name: /confirm the result of tongaat cc v ilembe cc/i }),
    );
    expect(h.onConfirmResult).toHaveBeenCalledWith('s1', 'f4', '2026-10-03T16:00:00.000Z');
    expect(h.toast).toHaveBeenCalledWith('Result confirmed');
  });

  it('a result medicoach changed meanwhile is not confirmed: the admin is told to check it', async () => {
    const user = userEvent.setup();
    renderHub([series()], {
      onConfirmResult: vi
        .fn()
        .mockRejectedValue(new ApiError(409, 'newer result', 'result_changed')),
    });
    await user.click(screen.getByRole('tab', { name: /results/i }));
    await user.click(
      screen.getByRole('button', { name: /confirm the result of tongaat cc v ilembe cc/i }),
    );
    expect(screen.getByRole('alert').textContent).toMatch(/newer result.*check it, then confirm/i);
  });

  it('a result changed after confirming is flagged and asks to confirm again', async () => {
    const user = userEvent.setup();
    const s = series();
    (s.fixtures as Array<Record<string, unknown>>)[2].result = result({
      recordedAt: '2026-10-03T18:00:00.000Z',
      changedSinceConfirmed: true,
    });
    renderHub([s]);
    await user.click(screen.getByRole('tab', { name: /results/i }));
    expect(screen.getByText(/changed this result after it was confirmed/i)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /confirm the result of tongaat cc v ilembe cc/i })
        .textContent,
    ).toBe('Confirm again');
  });

  it('withdraws a confirmation', async () => {
    const user = userEvent.setup();
    const h = renderHub();
    const day = screen.getByRole('region', { name: 'Saturday 3 October' });
    await user.click(
      within(day).getByRole('button', { name: /withdraw confirmation of spartan/i }),
    );
    expect(h.onUnconfirmResult).toHaveBeenCalledWith('s1', 'f1');
  });
});

describe('All fixtures, Venues and the editor', () => {
  it('All fixtures finds any fixture across every series by a word', async () => {
    const user = userEvent.setup();
    renderHub([series(), series({ id: 's2', name: 'Premier League', fixtures: [] })]);
    await user.click(screen.getByRole('tab', { name: 'All fixtures' }));
    expect(
      within(screen.getByRole('table', { name: 'Fixtures' })).getAllByRole('row'),
    ).toHaveLength(5);
    await user.type(screen.getByRole('searchbox', { name: /search fixtures/i }), 'ilembe r2');
    expect(
      within(screen.getByRole('table', { name: 'Fixtures' })).getAllByRole('row'),
    ).toHaveLength(2);
    expect(screen.getByText(/1 of 4 fixtures/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(screen.getByText(/4 of 4 fixtures/)).toBeTruthy();
  });

  it('Venues shows ground use from the scorecards and what is on at each ground', async () => {
    const user = userEvent.setup();
    renderHub();
    await user.click(screen.getByRole('tab', { name: 'Venues' }));
    const usage = screen.getByRole('table', { name: 'Ground use' });
    const tongaat = within(usage).getByText('Tongaat Oval').closest('tr')!;
    expect(tongaat.textContent).toMatch(/5 h 38/);
    expect(tongaat.textContent).toMatch(/490/);
    expect(screen.getByText(/1 of 2 played games came with ground time and balls/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /what's on at each ground/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /venues/i })).toBeTruthy();
  });

  it('"Series ↗" opens the fixture’s series in Seasons & series, where the editor lives', async () => {
    const user = userEvent.setup();
    renderHub([series({ id: 's0', name: 'Other series', fixtures: [] }), series()]);
    const day = screen.getByRole('region', { name: 'Saturday 3 October' });
    await user.click(within(day).getAllByRole('button', { name: /open emcu division 2/i })[0]);
    expect(screen.getByRole('tab', { name: 'Seasons & series', selected: true })).toBeTruthy();
    expect(document.querySelector('.series-card.active')?.textContent).toMatch(/EMCU Division 2/);
    expect(document.querySelector('.fix-release-bar')).toBeTruthy();
    expect(window.location.search).toBe('?tab=series');
  });

  it('?series= still deep-links straight to that series', () => {
    window.history.replaceState(null, '', '/admin/fixtures?series=s1');
    renderHub([series({ id: 's0', name: 'Other series', fixtures: [] }), series()]);
    expect(screen.getByRole('tab', { name: 'Seasons & series', selected: true })).toBeTruthy();
    expect(document.querySelector('.series-card.active')?.textContent).toMatch(/EMCU Division 2/);
  });

  it('with no series yet it stays one setup page, without tabs', () => {
    renderHub([]);
    expect(screen.queryByRole('tablist', { name: 'Fixtures and venues' })).toBeNull();
    expect(screen.getByText('No series yet')).toBeTruthy();
  });
});
