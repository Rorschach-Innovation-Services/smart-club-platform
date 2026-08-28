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

  it('closes only once the release has landed', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <ReleaseDialog
        seriesName="X · 2026/27"
        clubCount={9}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    await user.click(releaseBtn());
    expect(onConfirm).toHaveBeenCalledWith({});
    // The dialog owns closing — it calls onClose after the confirm promise resolves.
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ReleaseDialog — failure stays open (ADR 0011)', () => {
  const renderWith = (onConfirm: ReturnType<typeof vi.fn>, onClose = vi.fn()) => {
    const user = userEvent.setup();
    renderWithProviders(
      <ReleaseDialog
        seriesName="EMCU Division 2 · 2026/27"
        clubCount={12}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    return { user, onClose };
  };

  it('swaps the plain version-conflict boilerplate for the friendly refresh copy', async () => {
    // A genuine optimistic-concurrency race is server boilerplate, not admin-facing copy:
    // the dialog shows the app's friendly line, matching withToast's toast (item 1).
    const onConfirm = vi.fn().mockRejectedValue(new Error('series changed; refetch'));
    const { user, onClose } = renderWith(onConfirm);
    await user.click(releaseBtn());

    expect(await screen.findByText(/someone else just changed this — refreshing\./i)).toBeTruthy();
    expect(screen.queryByText(/series changed; refetch/i)).toBeNull();
    // A failed release must NOT close over the error.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays open and shows the clash message inline, keeping the withhold choices', async () => {
    // The clash gate returns a long, actionable message — shown verbatim inside the
    // dialog. The confirm button goes busy while the PATCH is in flight, and on failure
    // the dialog stays open with the admin's withhold choices intact for a retry.
    let reject!: (e: Error) => void;
    const pending = new Promise<void>((_res, rej) => {
      reject = rej;
    });
    const onConfirm = vi.fn().mockReturnValue(pending);
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

    await user.click(screen.getByRole('checkbox', { name: /withhold venues/i }));
    await user.click(releaseBtn());

    // In flight: the confirm button is busy and disabled.
    const busyBtn = screen.getByRole('button', { name: /releasing/i });
    expect(busyBtn).toBeDisabled();
    expect(onConfirm).toHaveBeenCalledWith({ venue: true });

    const clash =
      'Release blocked — 2 venue clash(es): Kingsmead double-booked on 12 Sep; Tongaat Oval double-booked on 19 Sep. Reallocate or move a fixture, then release again.';
    reject(new Error(clash));

    expect(await screen.findByText(clash)).toBeTruthy();
    // Still open, not closed.
    expect(onClose).not.toHaveBeenCalled();
    // Button back to its resting state and enabled; the withhold choice survived.
    expect(screen.getByRole('button', { name: /release to clubs/i })).not.toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /withhold venues/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('Cancel still closes while the dialog is showing an error', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('Release blocked — 1 venue clash(es)'));
    const { user, onClose } = renderWith(onConfirm);
    await user.click(releaseBtn());
    await screen.findByText(/release blocked/i);
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
