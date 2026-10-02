/**
 * Union office "Captain's reports" page: status chips (late is the server-derived flag), the
 * low-ratings filter, and the read-only report view.
 */
import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-utils';
import { AdminCaptainsReportsView } from './AdminCaptainsReports';
import type { CaptainsReport } from './types';

const ratings = (n: number) => ({
  decisions: n,
  pressure: n,
  behaviour: n,
  communication: n,
  regulations: n,
});

const report = (over: Partial<CaptainsReport>): CaptainsReport => ({
  id: `s1~f1~${over.clubId ?? 'umzinto'}`,
  seriesId: 's1',
  fixtureId: 'f1',
  clubId: 'umzinto',
  status: 'pending',
  source: 'auto',
  matchDate: '2026-10-04',
  deadline: '2026-10-07T16:00:00.000Z',
  side: 'home',
  clubName: 'Umzinto CC',
  opponentName: 'African Warriors',
  competition: 'Premier T20',
  umpiresSnapshot: [{ umpireId: 'u-ngubane', name: 'A.Ngubane' }],
  recipient: { kind: 'captain', name: 'S. Mthembu' },
  captainName: '',
  umpires: [],
  general: '',
  createdAt: '2026-10-04T15:00:00.000Z',
  updatedAt: '2026-10-04T15:00:00.000Z',
  late: false,
  ...over,
});

const REPORTS = [
  report({
    clubId: 'umzinto',
    status: 'submitted',
    ref: 'CR-2026-0001',
    captainName: 'S. Mthembu',
    submittedAt: '2026-10-05T10:00:00.000Z',
    umpires: [
      {
        umpireId: 'u-ngubane',
        name: 'A.Ngubane',
        ratings: { ...ratings(4), decisions: 2 },
        concerns: { lbw: true },
        otherConcern: '',
        comments: 'Missed two LBWs',
      },
    ],
  }),
  report({
    clubId: 'african-warriors',
    side: 'away',
    clubName: 'African Warriors',
    opponentName: 'Umzinto CC',
    recipient: { kind: 'chair', name: 'Awa Chair' },
    late: true,
  }),
  report({
    clubId: 'c',
    clubName: 'C CC',
    status: 'void',
    recipient: { kind: 'chair', name: 'C' },
  }),
];

describe('AdminCaptainsReportsView', () => {
  it('filters by status chip, late and low ratings', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminCaptainsReportsView reports={REPORTS} />);
    const rows = () => screen.getAllByRole('row').slice(1);
    expect(rows()).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: /^Late/ }));
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]).getByText('Chair')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^All/ }));
    await user.click(screen.getByRole('button', { name: /low ratings/i }));
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]).getByText('CR-2026-0001')).toBeTruthy();
  });

  it('opens a submitted report read-only', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminCaptainsReportsView reports={REPORTS} />);
    await user.click(screen.getByRole('button', { name: 'View' }));
    expect(screen.getByText(/Umpire 1: A\.Ngubane/)).toBeTruthy();
    expect(screen.getByText('Missed two LBWs')).toBeTruthy();
    expect(screen.getByText(/Areas of concern: LBW decisions/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit report' })).toBeNull();
  });
});
