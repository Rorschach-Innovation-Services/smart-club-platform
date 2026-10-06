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
});
