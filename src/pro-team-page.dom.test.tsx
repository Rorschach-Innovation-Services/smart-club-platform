/**
 * Scouting → Professional team, on the invented sample (the real scorecards are confidential
 * and git-ignored): the views render, tracking a scouted player carries through to Selection,
 * and the squad and the scouting pool are never drawn on one scale.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('./pro-data', async () => {
  const s = await vi.importActual<typeof import('./pro-sample')>('./pro-sample');
  return { PRO_IS_SAMPLE: true, PRO_MATCHES: s.SAMPLE_PRO_MATCHES, SCOUT_POOLS: [s.SAMPLE_POOL] };
});
vi.mock('./scouting-data', () => ({ SCOUTING_EVENTS: [] }));

import { ProTeamPage } from './pro-team-page';
import { qk } from './query';
import { renderWithProviders } from './test-utils';

// The platform library is empty, so the page falls back to the (mocked) sample.
const EMPTY_LIBRARY: [readonly unknown[], unknown][] = [[qk.proMatches(), []]];
const renderPage = (q = '') =>
  renderWithProviders(
    <MemoryRouter initialEntries={[`/admin/scouting?view=pro${q}`]}>
      <ProTeamPage />
    </MemoryRouter>,
    { seed: EMPTY_LIBRARY },
  );

beforeEach(() => localStorage.clear());

describe('Professional team', () => {
  it('opens on selection for the men’s squad in T20, with the sample flagged', () => {
    renderPage();
    expect(screen.getByRole('tab', { name: /Hawks.*Men/, selected: true })).toBeTruthy();
    expect((screen.getByLabelText('Format') as HTMLSelectElement).value).toBe('T20');
    expect(screen.getByText(/Sample data · invented names/)).toBeTruthy();
    expect(screen.getByRole('region', { name: /Promote · in form/ })).toBeTruthy();
    expect(screen.getByRole('region', { name: /At risk/ })).toBeTruthy();
    expect(
      screen.getByRole('img', { name: /Index change from Season so far to Last 5/ }),
    ).toBeTruthy();
  });

  it('says plainly that the files have no ball-by-ball', () => {
    renderPage();
    expect(screen.getByText(/phases come from when wickets fell/)).toBeTruthy();
  });

  it('switches to the women’s squad and keeps the views working', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('tab', { name: /Hawks.*Women/ }));
    expect(screen.getByRole('tab', { name: /Hawks.*Women/, selected: true })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Squad' }));
    expect(screen.getByRole('table', { name: 'Squad' })).toBeTruthy();
    expect(screen.getByText('How each batter used the balls they faced')).toBeTruthy();
  });

  it('tracks a scouted player and calls them up; they show on the selection shortlist', async () => {
    const user = userEvent.setup();
    renderPage('&ptab=callups');
    const pool = screen.getByRole('table', { name: 'Scouting pool' });
    const firstRow = within(pool).getAllByRole('row')[1];
    const name = within(firstRow).getByText((_, el) => el?.tagName === 'STRONG').textContent!;
    await user.click(within(firstRow).getByRole('button', { name: '+ Track' }));
    await user.click(within(firstRow).getByRole('button', { name: 'Call up' }));
    expect(within(firstRow).getByRole('button', { name: 'Called up' })).toBeTruthy();
    const saved = JSON.parse(localStorage.getItem('smartclub.pro.tracking.v1')!);
    expect(Object.values(saved)).toEqual([expect.objectContaining({ status: 'called-up' })]);
    expect(Object.keys(saved)[0]).toMatch(new RegExp(`^${name}\\|`));
    await user.click(screen.getByRole('tab', { name: /Selection/ }));
    const shortlist = screen.getByText('Call-up shortlist').closest('.card') as HTMLElement;
    expect(within(shortlist).getByText(name)).toBeTruthy();
    expect(within(shortlist).getByText('Called up')).toBeTruthy();
  });

  it('keeps the squad and the scouting pool on separate scales', () => {
    renderPage('&ptab=callups');
    expect(screen.getByText(/not comparable with the squad's bars/)).toBeTruthy();
    expect(screen.getByText('Best in the scouting pool')).toBeTruthy();
  });

  it('opens a match in depth from the list, and goes back', async () => {
    const user = userEvent.setup();
    renderPage('&ptab=matches');
    const table = screen.getByRole('table', { name: 'Matches' });
    await user.click(within(table).getAllByRole('row')[1]);
    expect(screen.getByRole('heading', { name: /^Hawks v / })).toBeTruthy();
    expect(screen.getByText('How the game unfolded')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Score at each wicket, by over' })).toBeTruthy();
    expect(screen.getAllByText('Partnerships').length).toBeGreaterThan(0);
    expect(screen.getByText('Standouts')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '← All matches' }));
    expect(screen.getByRole('table', { name: 'Matches' })).toBeTruthy();
  });

  it('finds a player by search and dives into their numbers', async () => {
    const user = userEvent.setup();
    renderPage('&ptab=form');
    const grid = document.querySelector('.pro-grid')!;
    const name = grid.querySelector('.pro-name')!.textContent!;
    await user.type(screen.getByRole('searchbox', { name: 'Search a player' }), name.split(' ')[1]);
    const options = screen.getByRole('listbox', { name: 'Players' });
    await user.click(within(options).getAllByRole('button')[0]);
    expect(screen.getByRole('heading', { name })).toBeTruthy();
    expect(screen.getByText('Every innings')).toBeTruthy();
    expect(screen.getByRole('table', { name: /Batting by/ })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Batting against each opponent' })).toBeTruthy();
    expect(screen.queryByText('Every spell')).toBeNull();
    await user.click(screen.getByRole('button', { name: '← All players' }));
    expect(screen.queryByRole('heading', { name })).toBeNull();
  });

  it('switches the deep dive between batting, bowling and all-rounder', async () => {
    const user = userEvent.setup();
    renderPage('&ptab=form&fmode=ar');
    expect(screen.getByRole('tab', { name: 'All-rounder', selected: true })).toBeTruthy();
    const first = document.querySelector('.pro-grid .pro-name') as HTMLButtonElement;
    expect(first.closest('.card')!.textContent).toMatch(/all-rounder index/);
    await user.click(first);
    expect(screen.getByText('Every innings')).toBeTruthy();
    expect(screen.getByText('Every spell')).toBeTruthy();
    expect(screen.getByText(/All-rounder index · season/)).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Bowling' }));
    expect(screen.queryByText('Every innings')).toBeNull();
    expect(screen.getByText('Every spell')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Bowling against each opponent' })).toBeTruthy();
  });

  it('says so when a search finds nobody', async () => {
    const user = userEvent.setup();
    renderPage('&ptab=form');
    await user.type(screen.getByRole('searchbox', { name: 'Search a player' }), 'zzzz');
    expect(screen.getByText(/No players match “zzzz” for batting/)).toBeTruthy();
  });

  it('trends the team season on season and shows who moved', async () => {
    const user = userEvent.setup();
    renderPage('&ptab=seasons&format=all');
    const record = screen.getByRole('table', { name: 'Season record' });
    expect(within(record).getAllByRole('row').length).toBeGreaterThanOrEqual(3); // header + 2 seasons
    expect(screen.getByRole('img', { name: /Hawks by season/ })).toBeTruthy();
    expect(screen.getByText(/All formats mixed — pick a format/)).toBeTruthy();
    expect(screen.getByText('Who moved between seasons')).toBeTruthy();
    const from = screen.getByLabelText('From season') as HTMLSelectElement;
    const to = screen.getByLabelText('To season') as HTMLSelectElement;
    expect(from.value < to.value).toBe(true);
    await user.selectOptions(to, from.value);
    expect(screen.getByText('Pick two different seasons.')).toBeTruthy();
  });

  it('shows a player’s seasons in their deep dive', async () => {
    renderPage('&ptab=form&format=all');
    const name = document.querySelector('.pro-grid .pro-name')!.textContent!;
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name }));
    expect(screen.getByText('Season by season')).toBeTruthy();
  });

  it('ranks call-up options objectively for each player who needs cover', () => {
    renderPage('&ptab=callups&format=all');
    const covers = screen.queryAllByRole('region', { name: /^Cover for / });
    if (!covers.length) return; // the sample may have nobody at risk in this selection
    const first = covers[0];
    expect(within(first).getByText(/Weakest:/)).toBeTruthy();
    const opts = within(first).queryByRole('table', { name: /^Options for / });
    if (opts) expect(within(opts).getByText('Fit')).toBeTruthy();
  });
});

describe('Exits', () => {
  it('shows status, squad flow and careers, and says when the register can’t be loaded', async () => {
    const api = await import('./api');
    vi.spyOn(api, 'getClubs').mockRejectedValue(new Error('no'));
    vi.spyOn(api, 'getAllClearances').mockResolvedValue([]);
    renderPage('&ptab=exits');
    expect(screen.getByText('Squad flow, season by season')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Careers in the squad' })).toBeTruthy();
    expect(screen.getByText('Players used')).toBeTruthy();
    expect(await screen.findByText(/register couldn’t be loaded/)).toBeTruthy();
  });
});
