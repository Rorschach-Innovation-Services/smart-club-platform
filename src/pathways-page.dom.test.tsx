/**
 * Scouting → Pathways on the invented sample: the pyramid, the competition drill-down, the
 * feeders grid and a club card, the calendar, results, and the filter bar narrowing all of it.
 */
import { describe, it, expect, vi } from 'vitest';
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
  return { PRO_IS_SAMPLE: true, PRO_MATCHES: s.SAMPLE_PRO_MATCHES, SCOUT_POOLS: [s.SAMPLE_POOL] };
});

import { PathwaysPage } from './pathways-page';
import { qk } from './query';
import { renderWithProviders } from './test-utils';

const renderPage = (q = '') =>
  renderWithProviders(
    <MemoryRouter initialEntries={[`/admin/scouting?view=pathways${q}`]}>
      <PathwaysPage />
    </MemoryRouter>,
    { seed: [[qk.proMatches(), []]] },
  );

describe('Pathways', () => {
  it('opens on the pyramid with the sample flagged and every tier drawn', () => {
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
    expect(screen.getByText('Girls and women across the pathway')).toBeTruthy();
  });

  it('the filter bar narrows every view and the count says so', async () => {
    const user = userEvent.setup();
    renderPage();
    const before = Number(screen.getByText(/of \d+ matches/).querySelector('b')!.textContent);
    await user.selectOptions(screen.getByLabelText('Site'), 'school');
    const after = Number(screen.getByText(/of \d+ matches/).querySelector('b')!.textContent);
    expect(after).toBeLessThan(before);
    await user.selectOptions(screen.getByLabelText('Gender'), 'women');
    const women = Number(screen.getByText(/of \d+ matches/).querySelector('b')!.textContent);
    expect(women).toBeLessThan(after);
    expect(women).toBeGreaterThan(0);
  });

  it('competitions: the signal map, then one competition with its ladder and strength map', async () => {
    const user = userEvent.setup();
    renderPage('&pwtab=competitions');
    expect(screen.getByText('Where results are earned')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Competition'), 'Sunday One 25/26');
    const ladder = await screen.findByRole('table', { name: 'Sunday One 25/26 ladder' });
    const rows = within(ladder).getAllByRole('row');
    expect(rows.length).toBe(9); // header + 8 sides
    expect(within(ladder).getByText('Riverside CC SU1')).toBeTruthy();
    expect(screen.getByText('Batting v bowling strength')).toBeTruthy();
    expect(screen.getByText('Close finishes')).toBeTruthy();
  });

  it('feeders: the ladder grid opens a club with its rungs and sides', async () => {
    const user = userEvent.setup();
    renderPage('&pwtab=feeders');
    const grid = screen.getByRole('table', { name: 'Club or school' });
    const row = within(grid).getByText('Riverside').closest('tr')!;
    await user.click(row);
    expect(await screen.findByRole('table', { name: 'Riverside sides' })).toBeTruthy();
    expect(screen.getByText('Win rate by age rung')).toBeTruthy();
    expect(screen.getByText('Highest tier')).toBeTruthy();
    expect(screen.getByText('Juniors v seniors')).toBeTruthy();
  });

  it('calendar and results render from the same selection', async () => {
    const user = userEvent.setup();
    renderPage('&pwtab=calendar');
    expect(screen.getByRole('img', { name: 'Matches per week' })).toBeTruthy();
    expect(screen.getByText('Where to be')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Results' }));
    const table = screen.getByRole('table', { name: 'Results' });
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(50);
    await user.type(screen.getByLabelText('Team or club'), 'Northgate');
    expect(
      within(screen.getByRole('table', { name: 'Results' })).getAllByRole('row').length,
    ).toBeLessThan(40);
  });
});
