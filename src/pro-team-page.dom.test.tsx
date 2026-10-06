/**
 * Scouting → Professional team, on the invented sample (the real scorecards are confidential
 * and git-ignored): the views render, tracking a scouted player carries through to Selection,
 * and the squad and the scouting pool are never drawn on one scale.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('./pro-data', async () => {
  const s = await vi.importActual<typeof import('./pro-sample')>('./pro-sample');
  return { PRO_IS_SAMPLE: true, PRO_MATCHES: s.SAMPLE_PRO_MATCHES, SCOUT_POOLS: [s.SAMPLE_POOL] };
});
vi.mock('./scouting-data', () => ({ SCOUTING_EVENTS: [] }));

import { ProTeamPage } from './pro-team-page';

const renderPage = (q = '') =>
  render(
    <MemoryRouter initialEntries={[`/admin/scouting?view=pro${q}`]}>
      <ProTeamPage />
    </MemoryRouter>,
  );

beforeEach(() => localStorage.clear());

describe('Professional team', () => {
  it('opens on selection for the men’s squad in T20, with the sample flagged', () => {
    renderPage();
    expect(screen.getByRole('tab', { name: /Highveld Hawks/, selected: true })).toBeTruthy();
    expect((screen.getByLabelText('Format') as HTMLSelectElement).value).toBe('T20');
    expect(screen.getByText(/Sample data · invented names/)).toBeTruthy();
    expect(screen.getByRole('region', { name: /Promote · in form/ })).toBeTruthy();
    expect(screen.getByRole('region', { name: /At risk/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Last 5 index against Season index/ })).toBeTruthy();
  });

  it('says plainly that the files have no ball-by-ball', () => {
    renderPage();
    expect(screen.getByText(/No ball-by-ball in these files/)).toBeTruthy();
  });

  it('switches to the women’s squad and keeps the views working', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('tab', { name: /Highveld Hawks Women/ }));
    expect(screen.getByRole('tab', { name: /Highveld Hawks Women/, selected: true })).toBeTruthy();
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

  it('opens a match scorecard from the list', async () => {
    const user = userEvent.setup();
    renderPage('&ptab=matches');
    const table = screen.getByRole('table', { name: 'Matches' });
    await user.click(within(table).getAllByRole('row')[1]);
    expect(document.querySelector('.pro-scorecards .pro-inn')).toBeTruthy();
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
});
