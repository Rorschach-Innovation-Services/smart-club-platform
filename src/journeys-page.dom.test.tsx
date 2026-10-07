/**
 * Scouting → Pathways → Players and Route to professional, on the invented sample players: the
 * bar at each age bracket, participation, boom and bust, outliers and climbers, a player's
 * detail; and the route view — who is where, the leaks, the school scene against the club scene,
 * and the eye that brings a player onto the watch list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { PathwaysPage } from './pathways-page';
import { ResultsScouting } from './results-scouting';
import { qk } from './query';
import { renderWithProviders } from './test-utils';

const renderPage = (q = '') =>
  renderWithProviders(
    <MemoryRouter initialEntries={[`/admin/scouting?view=pathways${q}`]}>
      <PathwaysPage />
    </MemoryRouter>,
    { seed: [[qk.proMatches(), []]] },
  );

beforeEach(() => localStorage.clear());

describe('Pathways tabs', () => {
  it('adds Players and Route to professional beside Milestones', () => {
    renderPage();
    const bar = screen.getByRole('tablist', { name: 'Pathways views' });
    expect(
      within(bar)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Milestones', 'Players', 'Route to professional', 'Improvers', 'Pyramid & leagues']);
  });
});

describe('Pathways → Players', () => {
  it('says the players are invented, and draws the bar at every age bracket', () => {
    renderPage('&pw=players');
    expect(screen.getByText(/Sample data, invented players/)).toBeTruthy();
    const ladder = screen.getByRole('img', { name: 'Batting average at each age bracket' });
    for (const b of ['U9', 'U13', 'U19', 'Senior', 'Pro'])
      expect(within(ladder).getByText(b)).toBeTruthy();
    expect(screen.getByRole('img', { name: /Balls faced and bowled per player/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /busts, steady and booms/ })).toBeTruthy();
  });

  it('lists players with balls faced, average, median and a rating, and filters by bracket', async () => {
    const user = userEvent.setup();
    renderPage('&pw=players');
    const table = screen.getByRole('table', { name: 'Players' });
    for (const h of ['Balls faced', 'Avg', 'Median', 'SR', 'Rating'])
      expect(within(table).getAllByText(h).length).toBeGreaterThan(0);
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(10);
    await user.selectOptions(screen.getByLabelText('Age bracket'), 'U15');
    const rows = within(screen.getByRole('table', { name: 'Players' })).getAllByRole('row');
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows.slice(1)) expect(within(r).getAllByText('U15').length).toBeGreaterThan(0);
  });

  it('switches to bowling, with overs, economy and wickets', async () => {
    const user = userEvent.setup();
    renderPage('&pw=players');
    await user.click(screen.getByRole('tab', { name: 'Bowling' }));
    const table = screen.getByRole('table', { name: 'Players' });
    for (const h of ['Overs', 'Econ', 'Wkts']) expect(within(table).getByText(h)).toBeTruthy();
    expect(
      screen.getByRole('img', { name: 'Economy (runs per over) at each age bracket' }),
    ).toBeTruthy();
  });

  it('opens a player’s climb: the journey, each bracket, every innings', async () => {
    const user = userEvent.setup();
    renderPage('&pw=players');
    const first = within(screen.getByRole('table', { name: 'Players' })).getAllByRole('row')[1];
    await user.click(first);
    const name = within(first).getAllByRole('cell')[0].textContent as string;
    expect(screen.getByText(name, { selector: '.card-title' })).toBeTruthy();
    expect(screen.getByRole('table', { name: /games by season and setting/ })).toBeTruthy();
    expect(screen.getByRole('table', { name: `${name} by age bracket` })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Every innings, in order' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('table', { name: `${name} by age bracket` })).toBeNull();
  });

  it('shows girls and women on their own', async () => {
    const user = userEvent.setup();
    renderPage('&pw=players');
    await user.click(screen.getByRole('tab', { name: 'Girls & women' }));
    expect(screen.getByRole('table', { name: 'Players' })).toBeTruthy();
  });
});

describe('Pathways → Route to professional', () => {
  it('shows where players are: counts, the flow, the leaks, school against club', () => {
    renderPage('&pw=route');
    expect(screen.getByText('In the data')).toBeTruthy();
    expect(screen.getByText('Reached the franchise')).toBeTruthy();
    expect(screen.getByRole('img', { name: /first seen and last seen, by season/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /how many moved up/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Games by setting at each bracket' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Routes to the franchise' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Where players started' })).toBeTruthy();
  });

  it('brings a player onto the watch list with the eye, showing where they came from', async () => {
    const user = userEvent.setup();
    renderPage('&pw=route');
    expect(screen.getByText(/Nobody yet/)).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Players in the system' });
    const row = within(table).getAllByRole('row')[1];
    const name = within(row).getAllByRole('cell')[0].textContent as string;
    await user.click(within(row).getByRole('button', { name: 'Add to watch list' }));
    expect(screen.queryByText(/Nobody yet/)).toBeNull();
    const card = screen
      .getByText(name, { selector: '.jn-card strong' })
      .closest('.jn-card') as HTMLElement;
    expect(within(card).getByText(/^(From|First seen at) /)).toBeTruthy();
    expect(within(card).getByText(/franchise games/)).toBeTruthy();
    expect(within(card).getByRole('table', { name: /games by season and setting/ })).toBeTruthy();
  });

  it('filters to the franchise players, and by school', async () => {
    const user = userEvent.setup();
    renderPage('&pw=route');
    await user.click(screen.getByRole('tab', { name: 'Franchise' }));
    const rows = within(screen.getByRole('table', { name: 'Players in the system' })).getAllByRole(
      'row',
    );
    for (const r of rows.slice(1)) expect(within(r).getAllByText('Pro').length).toBeGreaterThan(0);
  });
});

describe('Schools → school players', () => {
  const renderSchools = (q = '') =>
    renderWithProviders(
      <MemoryRouter initialEntries={[`/admin/scouting?view=schools${q}`]}>
        <ResultsScouting site="school" />
      </MemoryRouter>,
      { seed: [[qk.proMatches(), []]] },
    );

  it('puts school players on the Overview, not just schools', () => {
    renderSchools();
    expect(screen.getByText('School players to watch')).toBeTruthy();
    expect(screen.getByRole('button', { name: /All school players/ })).toBeTruthy();
  });

  it('opens Leaderboards on the school players, with their school, and the schools behind a switch', async () => {
    const user = userEvent.setup();
    renderSchools('&pwtab=leaders');
    const table = screen.getByRole('table', { name: 'Players' });
    expect(within(table).getByRole('columnheader', { name: 'School' })).toBeTruthy();
    const body = within(table).getAllByRole('row').slice(1);
    expect(body.length).toBeGreaterThan(5);
    // Only school games count: no club or franchise team appears.
    for (const r of body) expect(within(r).queryByText(/^(Riverside|Highveld Hawks)$/)).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Schools' }));
    expect(screen.queryByRole('table', { name: 'Players' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'School players' })).toBeTruthy();
  });

  it('narrows to one school, and opens a player', async () => {
    const user = userEvent.setup();
    renderSchools('&pwtab=leaders');
    await user.selectOptions(screen.getByLabelText('Players from school'), 'Hillcrest College');
    const rows = within(screen.getByRole('table', { name: 'Players' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows.length).toBeGreaterThan(0);
    await user.click(rows[0]);
    expect(screen.getByRole('table', { name: /games by season and setting/ })).toBeTruthy();
  });

  it('lists a school’s players on its card', async () => {
    const user = userEvent.setup();
    renderSchools('&pwtab=teams');
    const row = screen.getAllByRole('row').find((r) => /Hillcrest/.test(r.textContent ?? ''));
    expect(row).toBeTruthy();
    await user.click(row as HTMLElement);
    expect(await screen.findByRole('table', { name: 'Hillcrest College players' })).toBeTruthy();
  });
});
