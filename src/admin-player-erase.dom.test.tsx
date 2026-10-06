/**
 * PlayerDetailModal's union-admin "Erase player" danger zone (tenant-wide POPIA erasure).
 *
 * The erase is unrecoverable and reaches every club in the organisation, so the button stays
 * disabled until the admin types the player's full name exactly. The section only exists when
 * the caller passes `adminErase` (AdminPlayersView) — the club portal never does. These tests
 * assert what the admin sees and whether the handler fires, never internal state.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlayerDetailModal, erasureSummary } from './PlayerDetailModal';
import { renderWithProviders } from './test-utils';
import type { PlayerRegistration } from './types';

const player = {
  naturalKey: 'nk-1',
  clubId: 'berea',
  firstName: 'Sipho',
  lastName: 'Ndlovu',
  dob: '1990-01-01',
  isMinor: false,
  status: 'active',
  consentAt: '2026-05-01T00:00:00.000Z',
  createdAt: '2026-05-01T00:00:00.000Z',
} as PlayerRegistration;

const setup = (onErase?: () => Promise<unknown>) => {
  const user = userEvent.setup();
  renderWithProviders(
    <PlayerDetailModal
      player={player}
      clubId="berea"
      clubName="Berea CC"
      adminErase={onErase ? { onErase } : undefined}
      onClose={() => {}}
    />,
  );
  return { user };
};

const eraseButton = () => screen.getByRole('button', { name: /erase player everywhere/i });
const confirmInput = () => screen.getByLabelText(/to confirm/i);

describe('admin erase danger zone', () => {
  it('warns about the tenant-wide scope, Medicoach and no undo', () => {
    setup(vi.fn().mockResolvedValue(undefined));
    expect(screen.getByText(/every club in this organisation/i)).toBeInTheDocument();
    expect(screen.getByText(/already exported to Medicoach/i)).toBeInTheDocument();
    expect(screen.getByText(/no undo/i)).toBeInTheDocument();
  });

  it('keeps the button disabled until the full name is typed exactly', async () => {
    const onErase = vi.fn().mockResolvedValue(undefined);
    const { user } = setup(onErase);
    expect(eraseButton()).toBeDisabled();

    await user.type(confirmInput(), 'Sipho');
    expect(eraseButton()).toBeDisabled();

    await user.clear(confirmInput());
    await user.type(confirmInput(), 'sipho ndlovu');
    expect(eraseButton()).toBeDisabled();

    await user.clear(confirmInput());
    await user.type(confirmInput(), 'Sipho Ndlovu');
    expect(eraseButton()).toBeEnabled();
    expect(onErase).not.toHaveBeenCalled();
  });

  it('fires the handler once confirmed', async () => {
    const onErase = vi.fn().mockResolvedValue(undefined);
    const { user } = setup(onErase);
    await user.type(confirmInput(), 'Sipho Ndlovu');
    await user.click(eraseButton());
    expect(onErase).toHaveBeenCalledTimes(1);
  });

  it('a failed erase re-enables the button so the admin can retry', async () => {
    const onErase = vi.fn().mockRejectedValue(new Error('409'));
    const { user } = setup(onErase);
    await user.type(confirmInput(), 'Sipho Ndlovu');
    await user.click(eraseButton());
    expect(await screen.findByRole('button', { name: /erase player everywhere/i })).toBeEnabled();
  });

  it('renders no erase section without the prop (club portal)', () => {
    setup(undefined);
    expect(screen.queryByText(/erase player/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /erase/i })).not.toBeInTheDocument();
  });
});

describe('erasureSummary', () => {
  it('lists only the non-zero categories', () => {
    expect(
      erasureSummary({
        playerRows: 2,
        clearances: 1,
        registrationReviews: 0,
        veteransRequests: 0,
        documents: 3,
        certificates: 1,
        captainsReportsScrubbed: 0,
        reportOpenMarkers: 0,
      }),
    ).toBe('2 club registrations, 1 clearance, 3 documents, 1 certificate');
  });
});
