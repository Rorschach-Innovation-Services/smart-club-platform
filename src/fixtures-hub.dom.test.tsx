/**
 * Fixtures & Venues hub — the tabs the union office finds things with (This week, All
 * fixtures, Results, Venues) in front of the unchanged Seasons & series editor. Results come
 * in on the fixtures (GET /series joins them); nothing here edits a fixture, "Edit" opens it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminFixtures } from './admin';
import { renderWithProviders } from './test-utils';
import type { Club, Series, TenantConfig } from './types';

const clubs = [
  { id: 'spartan', name: 'Spartan Sporting CC', ground: { venue: 'Spartan Park' } },
  { id: 'tongaat', name: 'Tongaat CC', ground: { venue: 'Tongaat Oval' } },
  { id: 'ilembe', name: 'Ilembe CC', ground: { venue: 'KwaDukuza Stadium' } },
] as unknown as Club[];

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
        result: {
          homeScore: '204/5 (50)',
          awayScore: '191/8 (50)',
          summary: 'Spartan Sporting CC won by 13 runs',
          winner: 'home',
          noResult: false,
          source: 'live',
          recordedAt: '2026-10-03T15:30:00.000Z',
          medicoachMatchUrl: 'https://live.medicoach.co.za/match/x',
        },
      },
      { id: 'f2', round: 1, date: '2026-10-03', time: '13:00', home: 'ilembe', away: 'spartan' },
      { id: 'f3', round: 2, date: '2026-10-10', time: '10:00', home: 'tongaat', away: 'ilembe' },
    ],
    ...over,
  }) as unknown as Series;

function renderHub(all: Series[] = [series()]) {
  return renderWithProviders(
    <AdminFixtures
      defaultTab="week"
      clubs={clubs}
      allSeries={all}
      onUpdateSeries={vi.fn().mockResolvedValue(undefined)}
      onDeleteSeries={vi.fn()}
      onDuplicateSeries={vi.fn()}
      onSetReleased={vi.fn()}
      onReveal={vi.fn()}
      onSetApproved={vi.fn()}
      toast={vi.fn()}
      allVenues={[]}
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
    />,
  );
}

beforeEach(() => {
  // Monday 5 October 2026, 10:00 SAST — results day for the weekend just played.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T08:00:00Z'));
  window.history.replaceState(null, '', '/admin/fixtures');
});
afterEach(() => vi.useRealTimers());

describe('Fixtures & Venues hub', () => {
  it('opens on the weekend just played, with the weekly checks and the results on the fixtures', () => {
    renderHub();
    expect(screen.getByRole('tab', { name: 'This week', selected: true })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /results/i }).textContent).toMatch(/1$/);
    expect(screen.getByText('Last week')).toBeTruthy();
    const checks = screen.getByRole('group', { name: 'Weekly checks' });
    expect(within(checks).getByRole('button', { name: /results confirmed\s*1\/2/i })).toBeTruthy();
    expect(within(checks).getByRole('button', { name: /umpires appointed\s*0\/2/i })).toBeTruthy();
    const day = screen.getByRole('region', { name: 'Saturday 3 October' });
    expect(within(day).getByText('Spartan Sporting CC won by 13 runs')).toBeTruthy();
    expect(within(day).getByText('204/5 (50)')).toBeTruthy();
    expect(
      within(day)
        .getByRole('link', { name: /scorecard/i })
        .getAttribute('href'),
    ).toBe('https://live.medicoach.co.za/match/x');
    // The editor is a tab away, not on the page.
    expect(document.querySelector('.fix-table')).toBeNull();
  });

  it('a check narrows the week to the games that need it', async () => {
    const user = userEvent.setup();
    renderHub();
    await user.click(screen.getByRole('button', { name: /results confirmed/i }));
    const day = screen.getByRole('region', { name: 'Saturday 3 October' });
    expect(within(day).getAllByRole('listitem')).toHaveLength(1);
    expect(within(day).getByText('Ilembe CC')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /show the whole week/i }));
    expect(
      within(screen.getByRole('region', { name: 'Saturday 3 October' })).getAllByRole('listitem'),
    ).toHaveLength(2);
  });

  it('All fixtures finds any fixture across every series by a word', async () => {
    const user = userEvent.setup();
    renderHub([series(), series({ id: 's2', name: 'Premier League', fixtures: [] })]);
    await user.click(screen.getByRole('tab', { name: 'All fixtures' }));
    const table = screen.getByRole('table', { name: 'Fixtures' });
    expect(within(table).getAllByRole('row')).toHaveLength(4); // header + 3
    await user.type(screen.getByRole('searchbox', { name: /search fixtures/i }), 'ilembe r2');
    expect(
      within(screen.getByRole('table', { name: 'Fixtures' })).getAllByRole('row'),
    ).toHaveLength(2);
    expect(screen.getByText(/1 of 3 fixtures/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(screen.getByText(/3 of 3 fixtures/)).toBeTruthy();
  });

  it('Results lists played games still missing a result first, then results by day', async () => {
    const user = userEvent.setup();
    renderHub();
    await user.click(screen.getByRole('tab', { name: /results/i }));
    const missing = screen.getByRole('region', { name: /without a result/i });
    expect(within(missing).getByText('Ilembe CC')).toBeTruthy();
    const day = screen.getByRole('region', { name: 'Saturday 3 October' });
    expect(within(day).getByText('Spartan Sporting CC won by 13 runs')).toBeTruthy();
    expect(within(day).getByText('Live scored')).toBeTruthy();
  });

  it('Edit opens the fixture’s series in Seasons & series, where the editor lives', async () => {
    const user = userEvent.setup();
    renderHub([series({ id: 's0', name: 'Other series', fixtures: [] }), series()]);
    const day = screen.getByRole('region', { name: 'Saturday 3 October' });
    await user.click(within(day).getByRole('button', { name: /edit ilembe cc v spartan/i }));
    expect(screen.getByRole('tab', { name: 'Seasons & series', selected: true })).toBeTruthy();
    expect(document.querySelector('.series-card.active')?.textContent).toMatch(/EMCU Division 2/);
    expect(document.querySelector('.fix-release-bar')).toBeTruthy();
    expect(window.location.search).toBe('?tab=series');
  });

  it('Venues shows what is on at each ground, above the ground list', async () => {
    const user = userEvent.setup();
    renderHub();
    await user.click(screen.getByRole('tab', { name: 'Venues' }));
    expect(screen.getByRole('heading', { name: /what's on at each ground/i })).toBeTruthy();
    expect(screen.getByText('Tongaat Oval')).toBeTruthy(); // this week's game (f3)
    expect(screen.getByRole('heading', { name: /venues/i })).toBeTruthy();
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
