/**
 * ReleaseDialog — where the admin publishes a series to clubs and chooses whether to
 * withhold venues and/or start times (ADR 0011).
 *
 * The load-bearing behaviours: the confirmed mask carries TRUE KEYS ONLY (an unticked
 * field is omitted, never `false`), and the copy tells the truth — nothing is emailed
 * or WhatsApped on release.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReleaseDialog } from './ReleaseDialog';
import { renderWithProviders } from './test-utils';

const setup = () => {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const user = userEvent.setup();
  renderWithProviders(
    <ReleaseDialog
      seriesName="EMCU Division 2 · 2026/27"
      clubCount={12}
      onConfirm={onConfirm}
      onClose={onClose}
    />,
  );
  return { user, onConfirm, onClose };
};

const releaseBtn = () => screen.getByRole('button', { name: /release to clubs/i });

describe('ReleaseDialog', () => {
  it('is an accessible dialog', () => {
    setup();
    expect(screen.getByRole('dialog', { name: /release .*to clubs/i })).toBeTruthy();
  });

  it('tells the truth about notifications — nothing is emailed or WhatsApped', () => {
    setup();
    expect(screen.getByText(/no email or whatsapp is sent/i)).toBeTruthy();
    expect(screen.queryByText(/notifications sent/i)).toBeNull();
  });

  it('confirms with an empty mask when nothing is withheld', async () => {
    const { user, onConfirm } = setup();
    await user.click(releaseBtn());
    expect(onConfirm).toHaveBeenCalledWith({});
  });

  it('withholds both fields when both boxes are ticked (true keys only)', async () => {
    const { user, onConfirm } = setup();
    await user.click(screen.getByRole('checkbox', { name: /withhold venues/i }));
    await user.click(screen.getByRole('checkbox', { name: /withhold start times/i }));
    await user.click(releaseBtn());
    expect(onConfirm).toHaveBeenCalledWith({ venue: true, time: true });
  });

  it('withholds venue only', async () => {
    const { user, onConfirm } = setup();
    await user.click(screen.getByRole('checkbox', { name: /withhold venues/i }));
    await user.click(releaseBtn());
    expect(onConfirm).toHaveBeenCalledWith({ venue: true });
  });

  it('closes on Escape', async () => {
    const { user, onClose } = setup();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
