/**
 * Scouting → Pathways on the invented sample: the bar at each stage, outliers, benchmark
 * players, the players who went up, a player placed on the ladder, improvers season on season
 * with a player's detail, and the pyramid underneath.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('./scouting-data', async () => {
  const s = await vi.importActual<typeof import('./scouting-sample')>('./scouting-sample');
  return {
    SCOUTING_IS_SAMPLE: true,
    SCOUTING_EVENTS: [s.SAMPLE_TOURNAMENT, s.SAMPLE_CLUB_MATCH],
  };
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
vi.mock('./pathways-data', async () => {
  const p = await vi.importActual<typeof import('./pathways')>('./pathways');
  const s = await vi.importActual<typeof import('./pathways-sample')>('./pathways-sample');
  return { PATHWAYS_IS_SAMPLE: true, PATH_MATCHES: p.parseResults(s.SAMPLE_RESULTS_CSV) };
});

import { allLines, rateStage } from './milestones';
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

describe('Pathways → Milestones', () => {
  it('draws the bar at each stage, from the age group to the professional game', () => {
    renderPage();
    const ladder = screen.getByRole('img', { name: 'Strike rate at each stage' });
    for (const s of ['U13', 'Scouted club', 'Professional'])
      expect(within(ladder).getByText(s)).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Ratings at each stage' })).toBeTruthy();
    expect(screen.getByText('The benchmark players, stage by stage')).toBeTruthy();
    expect(screen.getAllByText(/top \d+ of \d+/i, { selector: '.pro-mini-title' })).toHaveLength(3);
    // The sample has club players who also played franchise cricket.
    expect(screen.getByRole('img', { name: 'Standing at each stage' })).toBeTruthy();
  });

  it('switches the measure, the discipline and the format', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('tab', { name: 'Runs per innings' }));
    expect(screen.getByRole('img', { name: 'Runs per innings at each stage' })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Bowling' }));
    expect(screen.getByRole('img', { name: 'Economy at each stage' })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'One-Day' }));
    const ladder = screen.getByRole('img', { name: 'Economy at each stage' });
    expect(within(ladder).getByText('Senior club')).toBeTruthy();
    expect(within(ladder).queryByText('Scouted club')).toBeNull();
  });

  it('places a searched player on the ladder', async () => {
    const user = userEvent.setup();
    const sample = await vi.importActual<typeof import('./scouting-sample')>('./scouting-sample');
    const pro = await vi.importActual<typeof import('./pro-sample')>('./pro-sample');
    const { lines } = allLines(
      [sample.SAMPLE_TOURNAMENT, sample.SAMPLE_CLUB_MATCH],
      [pro.SAMPLE_POOL],
      pro.SAMPLE_PRO_MATCHES,
    );
    const name = rateStage(lines, 'bat', 'men', 'T20', 'pro')[0].line.name;
    renderPage();
    await user.type(screen.getByLabelText('Place a player'), name);
    const ladder = screen.getByRole('img', { name: 'Strike rate at each stage' });
    expect(within(ladder).getByText(new RegExp(`^${name} \\d`))).toBeTruthy();
  });

  it('shows only franchise stages for girls and women, with no age-group bar invented', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('tab', { name: 'Girls & women' }));
    const ladder = screen.getByRole('img', { name: 'Strike rate at each stage' });
    expect(within(ladder).getByText('Professional')).toBeTruthy();
    expect(within(ladder).queryByText('U13')).toBeNull();
  });
});

describe('Pathways → Improvers', () => {
  it('compares seasons, lists risers and drops, and opens a player', async () => {
    const user = userEvent.setup();
    renderPage('&pw=improvers');
    expect(screen.getByText('Season on season')).toBeTruthy();
    expect(screen.getByText('The biggest improvers')).toBeTruthy();
    expect(screen.getByText('The biggest drops')).toBeTruthy();
    // Only the squads with whole seasons are offered.
    const teams = within(screen.getByLabelText('Franchise'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(teams).toEqual(['All franchises', 'Hawks']);
    const riser = screen.getByText('The biggest improvers').closest('.card')!;
    const first = riser.querySelector('.pv-bar-row')!;
    await user.click(first);
    expect(await screen.findByRole('button', { name: 'Close' })).toBeTruthy();
  });
});

describe('Pathways → Pyramid & leagues', () => {
  it('keeps the whole pyramid with schools and clubs', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('tab', { name: 'Pyramid & leagues' }));
    expect(screen.getByRole('img', { name: 'The pathway, tier by tier' })).toBeTruthy();
    expect(screen.getByLabelText('Site')).toBeTruthy();
  });
});
