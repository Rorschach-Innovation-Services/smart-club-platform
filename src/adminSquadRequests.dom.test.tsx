/**
 * The union office's squad-request table: a request the sweep settled as `expired` (still
 * pending after match day) reads as Expired, not as a raw reason string.
 */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { AdminSquadRequestsTable } from './AdminSquadRequests';
import { renderWithProviders } from './test-utils';
import type { SquadRequestView } from './types';

const request = (over: Partial<SquadRequestView> = {}): SquadRequestView => ({
  id: 's1~f1~ukzn',
  seriesId: 's1',
  fixtureId: 'f1',
  teamId: 'ukzn',
  clubId: 'ukzn',
  status: 'pending',
  fixtureRef: 'smartclub:dolphins:fixture:s1:f1',
  matchDate: '2026-10-28',
  side: 'home',
  clubName: 'UKZN',
  teamName: 'UKZN',
  opponentName: 'Crusaders',
  competition: 'Premier League',
  recipient: { kind: 'captain', name: 'Ayanda Mkhize' },
  linkExpiresAt: '2026-10-28T21:59:59.000Z',
  modified: 'm1',
  createdAt: '2026-10-27T16:00:00.000Z',
  updatedAt: '2026-10-27T16:00:00.000Z',
  ...over,
});

describe('void reasons', () => {
  it('an expired request reads as Expired; other reasons in plain words', () => {
    renderWithProviders(
      <AdminSquadRequestsTable
        requests={[
          request({ status: 'void', voidReason: 'expired' }),
          request({
            id: 's1~f2~ukzn',
            fixtureId: 'f2',
            status: 'void',
            voidReason: 'fixture changed',
          }),
        ]}
      />,
    );
    expect(screen.getByText('Expired — never submitted')).toBeInTheDocument();
    expect(screen.getByText('Fixture changed')).toBeInTheDocument();
    expect(screen.queryByText('expired')).toBeNull();
  });
});
