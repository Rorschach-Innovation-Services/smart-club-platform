/**
 * AdminClearances "Send reminder": the union office nudges a pending clearance's source-club chair.
 * Offered only on pending clearances whose source club is on the system (an off-system directory
 * source has no chair to remind — the API would 422), and only when the console wires a handler.
 * The server enforces once-per-day; the console just shows the busy label while the send runs.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminClearances } from './admin';
import { renderWithProviders } from './test-utils';

const clubs = [
  { id: 'berea', name: 'Berea CC' },
  { id: 'ukzn', name: 'UKZN CC' },
];

const request = (over: Record<string, unknown> = {}) => ({
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
  origin: 'transfer',
  predictedRejectCase: 'A',
  ...over,
});

const setup = (
  clearances: Array<Record<string, unknown>>,
  opts: { busyId?: string; busyAction?: string; withRemind?: boolean } = {},
) => {
  const onRemind = vi.fn().mockResolvedValue('ok');
  const noop = vi.fn().mockResolvedValue('ok');
  const user = userEvent.setup();
  renderWithProviders(
    <AdminClearances
      clearances={clearances as never[]}
      leagues={[]}
      clubs={clubs as never[]}
      onOverride={noop}
      onReject={noop}
      onReassign={noop}
      onReopen={noop}
      onRemind={opts.withRemind === false ? undefined : onRemind}
      onRevokeCertificate={noop}
      busyId={opts.busyId}
      busyAction={opts.busyAction}
    />,
  );
  return { user, onRemind };
};

const card = () => screen.getByText(/sipho/i).closest('.clr-card') as HTMLElement;

describe('Send reminder', () => {
  it('sends a reminder for a pending clearance with an on-system source', async () => {
    const { user, onRemind } = setup([request()]);
    await user.click(within(card()).getByRole('button', { name: /send reminder/i }));
    expect(onRemind).toHaveBeenCalledTimes(1);
    expect(onRemind).toHaveBeenCalledWith(expect.objectContaining({ id: 'clr-1' }));
  });

  it('shows the busy label and is disabled while the reminder is sending', () => {
    setup([request()], { busyId: 'clr-1', busyAction: 'remind' });
    const btn = within(card()).getByRole('button', { name: /sending…/i });
    expect(btn).toBeDisabled();
  });

  it('is not offered on a resolved clearance', () => {
    setup([request({ status: 'approved', clubApprovedAt: '2026-07-02T09:00:00.000Z' })]);
    expect(within(card()).queryByRole('button', { name: /send reminder/i })).toBeNull();
  });

  it('is not offered when the source club is not on the system', () => {
    setup([
      request({
        fromClubId: 'oldtown',
        fromClubName: 'Old Town CC',
        fromClubDirectory: true,
        predictedRejectCase: 'D',
      }),
    ]);
    expect(within(card()).queryByRole('button', { name: /send reminder/i })).toBeNull();
  });

  it('is not offered when no handler is wired', () => {
    setup([request()], { withRemind: false });
    expect(within(card()).queryByRole('button', { name: /send reminder/i })).toBeNull();
  });
});
