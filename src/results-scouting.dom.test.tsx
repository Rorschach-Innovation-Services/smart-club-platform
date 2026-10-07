/**
 * Scouting → Pathways on the invented sample, laid out like Player scouting: Overview (pyramid,
 * competitions), a competition's ladder, Leaderboards, the Performance map, Teams with a club
 * card, the Shortlist, Matches, and the filter bar narrowing all of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('./pathways-data', async () => {
  const p = await vi.importActual<typeof import('./pathways')>('./pathways');
  const s = await vi.importActual<typeof import('./pathways-sample')>('./pathways-sample');
  return { PATHWAYS_IS_SAMPLE: true, PATH_MATCHES: p.parseResults(s.SAMPLE_RESULTS_CSV) };
});
vi.mock('./pro-data', async () => {
  const s = await vi.importActual<typeof import('./pro-sample')>('./pro-sample');
  return {
    PRO_IS_SAMPLE: true,
    POOLS_ARE_SAMPLE: true,
    PRO_MATCHES: s.SAMPLE_PRO_MATCHES,
    SCOUT_POOLS: [s.SAMPLE_POOL],
  };
});

import { ResultsScouting as PathwaysPage } from './results-scouting';
import { qk } from './query';
import { renderWithProviders } from './test-utils';

const renderPage = (q = '') =>
  renderWithProviders(
    <MemoryRouter initialEntries={[`/admin/scouting?view=pathways${q}`]}>
      <PathwaysPage />
    </MemoryRouter>,
    { seed: [[qk.proMatches(), []]] },
  );

const count = () => Number(screen.getByText(/of \d+ matches/).querySelector('b')!.textContent);

beforeEach(() => localStorage.clear());

describe('Pathways', () => {
  it('opens on the overview with the sample flagged, every tier drawn and the competitions listed', () => {
    renderPage();
    expect(screen.getByText(/sample data, invented names/)).toBeTruthy();
    const pyramid = screen.getByRole('img', { name: 'The pathway, tier by tier' });
    for (const t of [
      'Professional',
      'Representative',
      'Premier league',
      'Presidents leagues',
      'High schools',
      'Primary schools',
    ])
      expect(within(pyramid).getByText(t)).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Matches by tier and age' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Formats by tier' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Matches per week' })).toBeTruthy();
    const comps = screen.getByRole('table', { name: 'Competitions' });
    expect(within(comps).getByText('Sunday One 25/26')).toBeTruthy();
  });

  it('the filter bar narrows every view and the count says so', async () => {
    const user = userEvent.setup();
    renderPage();
    const before = count();
    await user.selectOptions(screen.getByLabelText('Site'), 'school');
    const after = count();
    expect(after).toBeLessThan(before);
    await user.selectOptions(screen.getByLabelText('Gender'), 'women');
    const women = count();
    expect(women).toBeLessThan(after);
    expect(women).toBeGreaterThan(0);
  });

  it('a competition opens its ladder, strength map and how games are won', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      within(screen.getByRole('table', { name: 'Competitions' })).getByText('Sunday One 25/26'),
    );
    const ladder = await screen.findByRole('table', { name: 'Sunday One 25/26 ladder' });
    expect(within(ladder).getAllByRole('row')).toHaveLength(9); // header + 8 sides
    expect(within(ladder).getByText('Riverside CC SU1')).toBeTruthy();
    expect(screen.getByText('Batting v bowling strength')).toBeTruthy();
    expect(screen.getByText('Close finishes')).toBeTruthy();
    // Shortlisting from the ladder is remembered.
    await user.click(within(ladder).getAllByRole('button', { name: '☆ Shortlist' })[0]);
    expect(screen.getByRole('tab', { name: 'Shortlist (1)' })).toBeTruthy();
  });

  it('leaderboards rank sides on each measure, clubs and schools too', async () => {
    const user = userEvent.setup();
    renderPage('&pwtab=leaders');
    expect(screen.getByRole('tab', { name: 'Win %', selected: true })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Net run rate' }));
    expect(screen.getByRole('tab', { name: 'Net run rate', selected: true })).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Rank'), 'club');
    expect(screen.getByText(/highest first/)).toBeTruthy();
  });

  it('the performance map shows sides and competitions', () => {
    renderPage('&pwtab=map');
    expect(screen.getByText('Batting v bowling strength')).toBeTruthy();
    expect(screen.getByText('Where results are earned')).toBeTruthy();
    expect(screen.getByText('Competitiveness, competition by competition')).toBeTruthy();
  });

  it('teams: the ladder grid opens a club card, and the shortlist keeps it', async () => {
    const user = userEvent.setup();
    renderPage('&pwtab=teams');
    const grid = screen.getByRole('table', { name: 'Club or school' });
    await user.click(within(grid).getByText('Riverside').closest('tr')!);
    expect(await screen.findByRole('table', { name: 'Riverside sides' })).toBeTruthy();
    expect(screen.getByText('Win rate by age rung')).toBeTruthy();
    expect(screen.getByText('Juniors v seniors')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '☆ Shortlist' }));
    await user.click(screen.getByRole('tab', { name: 'Shortlist (1)' }));
    expect(screen.getByText('Shortlisted clubs and schools')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Riverside' })).toBeTruthy();
    expect(screen.getByText('Where to be')).toBeTruthy();
  });

  it('matches list the selection and a team search narrows it', async () => {
    const user = userEvent.setup();
    renderPage('&pwtab=matches');
    const table = screen.getByRole('table', { name: 'Results' });
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(50);
    await user.type(screen.getByLabelText('Team or club'), 'Northgate');
    expect(
      within(screen.getByRole('table', { name: 'Results' })).getAllByRole('row').length,
    ).toBeLessThan(40);
  });
});

describe('Schools', () => {
  it('locks the page to school cricket: no site filter, school competitions only', async () => {
    const { ResultsScouting } = await import('./results-scouting');
    renderWithProviders(
      <MemoryRouter initialEntries={['/admin/scouting?view=schools']}>
        <ResultsScouting site="school" />
      </MemoryRouter>,
      { seed: [[qk.proMatches(), []]] },
    );
    expect(screen.queryByLabelText('Site')).toBeNull();
    const comps = within(screen.getByRole('table', { name: 'Competitions' }))
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.querySelector('strong')!.textContent);
    expect(comps.length).toBeGreaterThan(0);
    expect(comps.some((c) => /Sunday|Saturday|Pres|Premier|Club/.test(c!))).toBe(false);
  });
});
