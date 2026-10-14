/**
 * AdminClearances under transfer windows: the server-computed open/closed banner, the
 * "Auto-rejected — window closed" badge on clearances the system rejected outside a window, and
 * the 'not-registered' outcome wording (the player was never put on the destination roster).
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminClearances } from './admin';
import { renderWithProviders } from './test-utils';
import type { TransferWindowStatus } from './types';

const clubs = [
  { id: 'berea', name: 'Berea CC' },
  { id: 'ukzn', name: 'UKZN CC' },
];

const clearance = (over: Record<string, unknown> = {}) => ({
  id: 'clr-1',
  status: 'pending',
  playerName: 'Sipho Ndlovu',
  idNumber: '0101015800088',
  team: 'premier',
  requestedAt: '2026-07-01T09:00:00.000Z',
  fromClubId: 'berea',
  fromClubName: 'Berea CC',
  toClubId: 'ukzn',
  toClubName: 'UKZN CC',
  origin: 'registration',
  predictedRejectCase: 'B',
  ...over,
});

const autoRejected = (over: Record<string, unknown> = {}) =>
  clearance({
    status: 'rejected',
    rejectedAt: '2026-10-06T09:00:00.000Z',
    rejectedBy: 'system:transfer-window',
    rejectReason: 'Outside transfer window — next window: Winter (2026-11-01 – 2026-11-30)',
    rejectOutcome: 'not-registered',
    ...over,
  });

const setup = (
  clearances: Array<Record<string, unknown>>,
  transferWindowStatus?: TransferWindowStatus,
) => {
  const noop = vi.fn().mockResolvedValue('ok');
  const onReopen = vi.fn().mockResolvedValue('ok');
  const user = userEvent.setup();
  renderWithProviders(
    <AdminClearances
      clearances={clearances as never[]}
      leagues={[]}
      clubs={clubs as never[]}
      onOverride={noop}
      onReject={noop}
      onReassign={noop}
      onReopen={onReopen}
      onRevokeCertificate={noop}
      transferWindowStatus={transferWindowStatus}
      busyId={undefined}
      busyAction={undefined}
    />,
  );
  return { user, onReopen };
};

const winter = { label: 'Winter', start: '2026-11-01', end: '2026-11-30' };
const card = () => screen.getByText(/sipho/i).closest('.clr-card') as HTMLElement;

describe('transfer-window banner', () => {
  it('says nothing when the tenant has no windows (status absent)', () => {
    setup([]);
    expect(screen.queryByText(/transfers (open|closed)/i)).toBeNull();
  });

  it('shows the current window while transfers are open', () => {
    setup([], { open: true, current: winter });
    expect(screen.getByText(/transfers open/i)).toHaveTextContent(
      'Transfers open — Winter until 30 Nov 2026',
    );
  });

  it('names the next window while transfers are closed', () => {
    setup([], { open: false, next: winter });
    const banner = screen.getByText(/transfers closed/i);
    expect(banner).toHaveTextContent('Transfers closed — next window: Winter from 1 Nov 2026');
    expect(banner).toHaveTextContent(/registrations naming another club are auto-rejected/);
  });

  it('says when no window is coming', () => {
    setup([], { open: false });
    expect(screen.getByText(/transfers closed/i)).toHaveTextContent(
      'Transfers closed — no upcoming window',
    );
  });
});

describe('auto-rejected clearances', () => {
  it('carry the window-closed badge and the not-registered outcome instead of the rejector id', () => {
    setup([autoRejected()]);
    expect(within(card()).getByText('Auto-rejected — window closed')).toBeInTheDocument();
    expect(within(card()).getByText('Not registered at UKZN CC')).toBeInTheDocument();
    expect(within(card()).queryByText(/system:transfer-window/)).toBeNull();
  });

  it('an admin reject keeps the plain Rejected pill', () => {
    setup([autoRejected({ rejectedBy: 'admin@union.test', rejectOutcome: 'source-reactivated' })]);
    expect(within(card()).getByText(/Rejected · admin@union.test/)).toBeInTheDocument();
    expect(within(card()).queryByText('Auto-rejected — window closed')).toBeNull();
  });

  it('reopen copy says the player goes onto the roster as clearance pending', async () => {
    const { user } = setup([autoRejected()]);
    await user.click(within(card()).getByRole('button', { name: 'Reopen' }));
    expect(screen.getByText(/placed on UKZN CC's roster as clearance pending/)).toBeInTheDocument();
  });
});
