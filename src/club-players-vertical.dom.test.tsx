/**
 * ClubPlayersView under a sport vertical: a 'positions'-profile tenant (football) sees a
 * Position column/filter/detail row instead of the cricket role + bowler-type surfaces, and
 * the veterans module (off by default for football) hides the veterans affiliates card, its
 * query and the per-player veterans-club section. Cricket (no `sport`) is unchanged.
 *
 * The tenant payload is seeded into the real react-query cache (qk.tenant()), so the
 * component's own useVertical/useModule hooks resolve it — no hook mocking. Only the HTTP
 * client is mocked. A `.dom.` suite because `club.tsx` imports leaflet at module load.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders } from './test-utils';
import { qk } from './query';

vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return {
    ...actual,
    getTenant: vi.fn(async () => ({})),
    getVeteransAffiliates: vi.fn(async () => []),
    getClubDirectory: vi.fn(async () => []),
  };
});

import { ClubPlayersView } from './club';
import { getVeteransAffiliates } from './api';

const players = [
  {
    naturalKey: 'nk-1',
    firstName: 'Musa',
    lastName: 'Khoza',
    idNumber: 'ID-1',
    position: 'Striker',
    bowlerType: 'Fast',
    isAllRounder: true,
  },
  { naturalKey: 'nk-2', firstName: 'Lebo', lastName: 'Mokoena', idNumber: 'ID-2' },
];

function renderPlayers(tenant: Record<string, unknown>) {
  return renderWithProviders(
    <ClubPlayersView
      club={{ id: 'alpha', name: 'Alpha' } as never}
      players={players as never}
      clearances={{ incoming: [], outbound: [] } as never}
      leagues={[] as never}
      onGenerateLink={vi.fn()}
      onDeletePlayer={vi.fn()}
      toast={vi.fn()}
      veteransRequests={undefined}
      onAcceptVeteransRequest={undefined}
      onDeclineVeteransRequest={undefined}
      busyVeteransId={undefined}
    />,
    { seed: [[qk.tenant(), tenant]] },
  );
}

describe('ClubPlayersView — positions profile (football)', () => {
  beforeEach(() => {
    vi.mocked(getVeteransAffiliates).mockReset().mockResolvedValue([]);
  });

  it('shows Position instead of the cricket role/bowler-type surfaces', () => {
    const { getByRole, queryByRole, getAllByText, queryByText, getByLabelText, queryByLabelText } =
      renderPlayers({ sport: 'football' });
    expect(getByRole('columnheader', { name: 'Position' })).toBeTruthy();
    expect(queryByRole('columnheader', { name: 'Bowler type' })).toBeNull();
    expect(queryByText('All-rounders')).toBeNull();
    expect(queryByText('WK keepers')).toBeNull();
    // The position shows in the row (and its count in the stats strip).
    expect(getAllByText('Striker').length).toBeGreaterThan(0);
    expect(getByLabelText('Filter by position')).toBeTruthy();
    expect(queryByLabelText('Filter by role')).toBeNull();
    expect(queryByLabelText('Filter by bowler type')).toBeNull();
  });

  it('gates the veterans affiliates query and the detail modal veterans section', () => {
    const { getByText, queryByText } = renderPlayers({ sport: 'football' });
    expect(getVeteransAffiliates).not.toHaveBeenCalled();
    fireEvent.click(getByText('Musa Khoza'));
    expect(getByText('Playing profile')).toBeTruthy();
    expect(queryByText('Cricket profile')).toBeNull();
    expect(queryByText('Batting')).toBeNull();
    expect(queryByText('Veterans club')).toBeNull();
  });

  it('an explicit module.veterans=true brings the veterans section back', () => {
    const { getByText, getAllByText } = renderPlayers({
      sport: 'football',
      features: { 'module.veterans': true },
    });
    fireEvent.click(getByText('Musa Khoza'));
    expect(getAllByText('Veterans club').length).toBeGreaterThan(0);
  });
});

describe('ClubPlayersView — cricket (no sport) unchanged', () => {
  it('keeps the role/bowler-type column, cricket stats and filters', () => {
    const { getByRole, queryByRole, getByText, getByLabelText, queryByLabelText } = renderPlayers(
      {},
    );
    expect(getByRole('columnheader', { name: 'Role' })).toBeTruthy();
    expect(getByRole('columnheader', { name: 'Bowler type' })).toBeTruthy();
    expect(queryByRole('columnheader', { name: 'Position' })).toBeNull();
    expect(getByText('All-rounders')).toBeTruthy();
    expect(getByLabelText('Filter by role')).toBeTruthy();
    expect(queryByLabelText('Filter by position')).toBeNull();
  });
});
