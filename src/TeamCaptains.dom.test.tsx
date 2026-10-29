/**
 * The "Team captain" card: one picker per side AND per competition the side plays in (a club's
 * men's, women's and veterans sides can share one team id, so a single picker would bleed one
 * captain across them). Only the HTTP client and the feature flag are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return {
    ...actual,
    getTeamCaptain: vi.fn(),
    getCaptainCandidates: vi.fn(),
    putTeamCaptain: vi.fn(),
  };
});
vi.mock('./branding', async (importActual) => ({
  ...(await importActual<typeof import('./branding')>()),
  useFeature: () => true,
}));

import * as api from './api';
import { TeamCaptainsCard } from './TeamCaptains';
import { renderWithProviders } from './test-utils';

const club = { id: 'rhythm', name: 'Rhythm CC', leagues: ['premier'] };
const SET_AT = '2026-10-29T08:00:00.000Z';

beforeEach(() => {
  vi.mocked(api.getTeamCaptain).mockResolvedValue({
    teamId: 'rhythm',
    competitions: [
      {
        scope: 'league:premier',
        name: 'Premier League',
        captain: { candidateId: 'c1', name: 'Mens Cap', setBy: 'rep', setAt: SET_AT },
      },
      { scope: 'league:vets-premier', name: 'Veterans Premier', captain: null },
    ],
  });
  vi.mocked(api.getCaptainCandidates).mockResolvedValue({
    candidates: [
      { id: 'c1', name: 'Mens Cap' },
      { id: 'c2', name: 'Old Timer', affiliate: true },
    ],
  });
  vi.mocked(api.putTeamCaptain).mockReset();
});

describe('Team captain card', () => {
  it('renders one picker per competition, each with its own captain', async () => {
    renderWithProviders(<TeamCaptainsCard club={club} />);
    const mens = await screen.findByLabelText('Team captain — Rhythm CC — Premier League');
    const vets = screen.getByLabelText('Team captain — Rhythm CC — Veterans Premier');
    await waitFor(() => expect((mens as HTMLSelectElement).value).toBe('c1'));
    expect((vets as HTMLSelectElement).value).toBe('');
  });

  it('saving one competition sends its scope and leaves the other untouched', async () => {
    vi.mocked(api.putTeamCaptain).mockResolvedValue({
      teamId: 'rhythm',
      scope: 'league:vets-premier',
      name: 'Veterans Premier',
      captain: {
        candidateId: 'c2',
        name: 'Old Timer',
        affiliate: true,
        setBy: 'rep',
        setAt: SET_AT,
      },
    });
    renderWithProviders(<TeamCaptainsCard club={club} />);
    const vets = (await screen.findByLabelText(
      'Team captain — Rhythm CC — Veterans Premier',
    )) as HTMLSelectElement;
    await waitFor(() => expect(vets.disabled).toBe(false));
    await userEvent.selectOptions(vets, 'c2');
    expect(api.putTeamCaptain).toHaveBeenCalledWith(
      'rhythm',
      'rhythm',
      'league:vets-premier',
      'c2',
    );
    await waitFor(() => expect(vets.value).toBe('c2'));
    expect(
      (screen.getByLabelText('Team captain — Rhythm CC — Premier League') as HTMLSelectElement)
        .value,
    ).toBe('c1');
  });

  it('a side in no released competition explains why there is no picker', async () => {
    vi.mocked(api.getTeamCaptain).mockResolvedValue({ teamId: 'rhythm', competitions: [] });
    renderWithProviders(<TeamCaptainsCard club={club} />);
    expect(await screen.findByText(/not in a released competition yet/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
