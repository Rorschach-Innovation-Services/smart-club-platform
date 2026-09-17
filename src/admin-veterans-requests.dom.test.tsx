/**
 * AdminVeteransRequests — the union office's oversight of veterans squad selection (ADR 0013).
 *
 * A veterans club found a player tenant-wide and asked the player's OWN club to confirm them for
 * veterans cricket. Clubs resolve these in their portal; the admin may accept or decline as an
 * override (recorded server-side as `resolvedVia: 'admin'`). The handlers resolve to a tri-state
 * ('ok' | 'conflict' | 'failed'); the confirm dialog closes unless the outcome is 'failed'. These
 * tests assert what the admin SEES and what payload each action sends — never internal state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminVeteransRequests } from './admin';
import { renderWithProviders } from './test-utils';

const leagues = [
  { key: 'veterans-premier', label: 'Veterans Premier', group: 'V', district: 'All districts' },
];

const request = (over: Record<string, unknown> = {}) => ({
  id: 'vr-1',
  candidateId: 'handle-abc',
  playerName: 'Sipho Ndlovu',
  primaryClubId: 'berea',
  primaryClubName: 'Berea CC',
  veteransClubId: 'ukzn',
  veteransClubName: 'UKZN CC',
  leagueKey: 'veterans-premier',
  requestedAt: '2026-07-01T09:00:00.000Z',
  requestedBy: 'coach@ukzn.test',
  status: 'pending',
  version: 3,
  ...over,
});

const setup = (
  requests: Array<Record<string, unknown>>,
  busyId?: string,
  busyAction?: 'accept' | 'decline',
) => {
  const onAccept = vi.fn().mockResolvedValue('ok');
  const onDecline = vi.fn().mockResolvedValue('ok');
  const user = userEvent.setup();
  renderWithProviders(
    <AdminVeteransRequests
      requests={requests as never[]}
      leagues={leagues as never[]}
      onAccept={onAccept}
      onDecline={onDecline}
      busyId={busyId}
      busyAction={busyAction}
    />,
  );
  return { user, onAccept, onDecline };
};

const row = (name: RegExp = /sipho/i) =>
  screen.getByText(name).closest('tr') as HTMLElement;

beforeEach(() => vi.clearAllMocks());

describe('the pending list', () => {
  it('shows a pending request with both clubs, the league and who asked', () => {
    setup([request()]);
    const r = row();
    expect(within(r).getByText('Berea CC', { exact: false })).toBeInTheDocument();
    expect(within(r).getByText('UKZN CC', { exact: false })).toBeInTheDocument();
    expect(within(r).getByText('Veterans Premier')).toBeInTheDocument();
    expect(within(r).getByText('coach@ukzn.test')).toBeInTheDocument();
    expect(within(r).getByText('Pending')).toBeInTheDocument();
    expect(within(r).getByRole('button', { name: /accept/i })).toBeInTheDocument();
    expect(within(r).getByRole('button', { name: /decline/i })).toBeInTheDocument();
  });

  it('defaults to the Pending filter, hiding resolved requests', () => {
    setup([
      request(),
      request({ id: 'vr-2', playerName: 'Themba Zulu', status: 'accepted' }),
    ]);
    expect(screen.getByText('Sipho Ndlovu')).toBeInTheDocument();
    expect(screen.queryByText('Themba Zulu')).not.toBeInTheDocument();
  });

  it('shows an empty-state when nothing matches the filter', () => {
    setup([request({ status: 'accepted' })]);
    expect(screen.getByText(/no veterans requests match this filter/i)).toBeInTheDocument();
  });
});

describe('accept override', () => {
  it('confirms, then accepts with the primaryClubId and version for OCC', async () => {
    const { user, onAccept } = setup([request()]);
    await user.click(within(row()).getByRole('button', { name: /accept/i }));
    // Confirm dialog appears; the row button did not fire the mutation yet.
    expect(onAccept).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /accept request/i }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept.mock.calls[0][0]).toMatchObject({
      id: 'vr-1',
      primaryClubId: 'berea',
      version: 3,
    });
    // Dialog closes on the 'ok' outcome.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /accept request/i })).not.toBeInTheDocument(),
    );
  });
});

describe('decline override', () => {
  it('captures an optional reason and passes it through', async () => {
    const { user, onDecline } = setup([request()]);
    await user.click(within(row()).getByRole('button', { name: /decline/i }));
    await user.type(screen.getByPlaceholderText(/shared with the veterans club/i), 'Not eligible');
    await user.click(screen.getByRole('button', { name: /decline request/i }));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onDecline.mock.calls[0][0]).toMatchObject({ id: 'vr-1', primaryClubId: 'berea' });
    expect(onDecline.mock.calls[0][1]).toBe('Not eligible');
  });

  it('declines with an empty reason when none is typed', async () => {
    const { user, onDecline } = setup([request()]);
    await user.click(within(row()).getByRole('button', { name: /decline/i }));
    await user.click(screen.getByRole('button', { name: /decline request/i }));
    expect(onDecline.mock.calls[0][1]).toBe('');
  });
});

describe('resolved rows', () => {
  it('labels a union override and shows no action buttons', async () => {
    const { user } = setup([
      request({
        status: 'accepted',
        resolvedVia: 'admin',
        resolvedBy: 'union@office.test',
        resolvedAt: '2026-07-02T10:00:00.000Z',
      }),
    ]);
    // Switch to the Accepted filter to reveal it.
    await user.click(screen.getByRole('button', { name: /^accepted/i }));
    const r = row();
    expect(within(r).getByText('Accepted')).toBeInTheDocument();
    expect(within(r).getByText('Union override')).toBeInTheDocument();
    expect(within(r).getByText('union@office.test', { exact: false })).toBeInTheDocument();
    expect(within(r).queryByRole('button', { name: /accept|decline/i })).not.toBeInTheDocument();
  });
});

describe('busy state', () => {
  it('labels the in-flight action and disables the row buttons', () => {
    setup([request()], 'vr-1', 'accept');
    const r = row();
    expect(within(r).getByRole('button', { name: /accepting…/i })).toBeDisabled();
    expect(within(r).getByRole('button', { name: /decline/i })).toBeDisabled();
  });
});
