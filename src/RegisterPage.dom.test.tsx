/**
 * RegisterPage (public `/register/:clubId?t=…`) under a sport vertical. A cricket tenant
 * keeps the batting/bowling playing profile and the Registration history section; a football
 * ('positions'-profile) tenant gets one Position select, no Registration history (its default
 * modules switch clearances/veterans off) and no cricket wording anywhere. Until GET /tenant
 * settles the page stays on its loading card, so a football tenant never flashes the cricket
 * fallback.
 *
 * The tenant payload is seeded into the real react-query cache (qk.tenant()) so the page's own
 * useVertical/useModule hooks resolve it; only the HTTP client is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderWithProviders } from './test-utils';
import { qk } from './query';

vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return {
    ...actual,
    getTenant: vi.fn(async () => ({})),
    getRegistration: vi.fn(),
  };
});

import { RegisterPage } from './RegisterPage';
import { getRegistration, getTenant } from './api';

const registration = {
  clubName: 'Alpha',
  leagues: [],
  districts: ['North'],
  clubs: [{ id: 'beta', name: 'Beta' }],
};

function renderRegister(seed?: Array<[readonly unknown[], unknown]>) {
  return renderWithProviders(
    <MemoryRouter initialEntries={['/register/alpha?t=tok']}>
      <Routes>
        <Route path="/register/:clubId" element={<RegisterPage />} />
      </Routes>
    </MemoryRouter>,
    { seed },
  );
}

describe('RegisterPage — sport vertical', () => {
  beforeEach(() => {
    vi.mocked(getRegistration)
      .mockReset()
      .mockResolvedValue(registration as never);
    vi.mocked(getTenant)
      .mockReset()
      .mockResolvedValue({} as never);
  });

  it('cricket tenant: batting/bowling profile, Registration history and the veterans question', async () => {
    renderRegister([[qk.tenant(), {}]]);
    expect(await screen.findByText('Batting hand')).toBeTruthy();
    expect(screen.getByText('Bowler type')).toBeTruthy();
    expect(screen.getByText('Registration history')).toBeTruthy();
    expect(screen.getByText('Are you playing veterans cricket for another club?')).toBeTruthy();
    expect(screen.queryByText('Position')).toBeNull();
  });

  it('football tenant: Position select, no Registration history, no cricket wording', async () => {
    const { container } = renderRegister([[qk.tenant(), { sport: 'football' }]]);
    expect(await screen.findByText('Position')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Goalkeeper' })).toBeTruthy();
    expect(screen.queryByText('Batting hand')).toBeNull();
    expect(screen.queryByText('Wicket-keeper')).toBeNull();
    expect(screen.queryByText('Registration history')).toBeNull();
    expect(container.textContent).not.toMatch(/cricket/i);
    // The POPIA declaration names a "player", not a "cricketer".
    expect(screen.getByText(/for my services as a player/)).toBeTruthy();
  });

  it('stays on the loading card until GET /tenant settles (no cricket flash)', async () => {
    vi.mocked(getTenant)
      .mockReset()
      .mockImplementation(() => new Promise(() => {}));
    renderRegister();
    // Let the registration lookup resolve: the page would otherwise be 'ready'.
    await vi.waitFor(() => expect(getRegistration).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByText('Checking your registration link…')).toBeTruthy();
    expect(screen.queryByText('Batting hand')).toBeNull();
  });
});
