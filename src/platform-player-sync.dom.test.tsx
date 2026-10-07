/**
 * PlayerSyncCard: the operator's switch for the medicoach player sync (ADR 0019). It writes
 * `integrations.medicoach.playerSync` (keeping the rest of the medicoach block), needs the
 * fixture sync on, and shows the team-coverage warnings the API answers when it is switched on.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlayerSyncCard } from './platform-player-sync';
import type { TenantConfig } from './types';

function setup(config: Partial<TenantConfig>, response: Record<string, unknown> = {}) {
  const save = vi.fn().mockResolvedValue(response);
  const toast = vi.fn();
  const user = userEvent.setup();
  render(
    <PlayerSyncCard
      config={{ tenant: 'acme', ...config } as TenantConfig}
      save={save}
      toast={toast}
    />,
  );
  return { user, save, toast };
}

const box = () => screen.getByRole('checkbox', { name: /push players to medicoach/i });
const saveBtn = () => screen.getByRole('button', { name: /save player sync/i });

describe('PlayerSyncCard', () => {
  it('is locked until the medicoach fixture sync is on', () => {
    setup({ features: {} });
    expect(box()).toBeDisabled();
    expect(screen.getByRole('note')).toHaveTextContent(/switch on the medicoach sync/i);
    expect(saveBtn()).toBeDisabled();
  });

  it('switching on keeps goLiveDate and shows the coverage warnings', async () => {
    const { user, save, toast } = setup(
      {
        features: { medicoachSync: true },
        integrations: { medicoach: { goLiveDate: '2026-10-01' } },
      },
      { warnings: ['3 of 40 team(s) are in leagues the last medicoach export did not cover'] },
    );
    await user.click(box());
    await user.click(saveBtn());
    expect(save).toHaveBeenCalledWith({
      integrations: { medicoach: { goLiveDate: '2026-10-01', playerSync: true } },
    });
    expect(toast).toHaveBeenCalledWith('Player sync switched on');
    expect(await screen.findByRole('alert')).toHaveTextContent('3 of 40 team(s)');
  });

  it('switching off sends an explicit false', async () => {
    const { user, save } = setup({
      features: { medicoachSync: true },
      integrations: { medicoach: { playerSync: true } },
    });
    expect(box()).toBeChecked();
    await user.click(box());
    await user.click(saveBtn());
    expect(save).toHaveBeenCalledWith({ integrations: { medicoach: { playerSync: false } } });
  });

  it('shows the server error', async () => {
    const { ApiError } = await import('./api');
    const { user, save } = setup({ features: { medicoachSync: true } });
    save.mockRejectedValueOnce(
      new ApiError(400, 'the medicoach player sync needs the medicoach sync'),
    );
    await user.click(box());
    await user.click(saveBtn());
    expect(await screen.findByText(/needs the medicoach sync/)).toBeInTheDocument();
  });
});
