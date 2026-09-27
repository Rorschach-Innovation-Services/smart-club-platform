/**
 * Admin edit dialogs that save through a handler threaded from main.tsx.
 *
 * Both handlers used to swallow a failed save (`.catch(() => {})`), so the dialog saw a
 * resolved promise, toasted "updated" and closed while nothing had been written. They now
 * return the chain raw: a rejection keeps the dialog open (the handler's own error toast
 * has already said why) and only a resolved save toasts and closes.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminSettingsView, LeagueForm } from './admin';
import { renderWithProviders } from './test-utils';

const LEAGUE = { key: 'premier', label: 'Premier League', group: 'Seniors', district: 'All' };

describe('LeagueForm — editing a league', () => {
  const renderForm = (onUpdate: () => Promise<unknown>) => {
    const toast = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <LeagueForm
        league={LEAGUE}
        allLeagues={[LEAGUE]}
        onCreate={vi.fn()}
        onUpdate={onUpdate}
        onClose={onClose}
        toast={toast}
      />,
    );
    return { toast, onClose };
  };

  it('stays open and claims nothing when the save fails', async () => {
    const user = userEvent.setup();
    const { toast, onClose } = renderForm(vi.fn().mockRejectedValue(new Error('500')));
    const save = screen.getByRole('button', { name: /save/i });

    await user.click(save);

    expect(toast).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(save).toBeEnabled();
  });

  it('toasts and closes once the save lands', async () => {
    const user = userEvent.setup();
    const { toast, onClose } = renderForm(vi.fn().mockResolvedValue(undefined));

    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(toast).toHaveBeenCalledWith('Premier League · updated');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('AdminSettingsView — editing the submission deadline', () => {
  const renderView = (onUpdateDeadline: (iso: string) => Promise<unknown>) => {
    const toast = vi.fn();
    renderWithProviders(
      <AdminSettingsView
        orgName="Dolphins"
        submissionDeadline="2026-10-31"
        support="Cricket Services · office@example.org"
        onSaveOrg={vi.fn()}
        onUpdateDeadline={onUpdateDeadline}
        onUpdateSupport={vi.fn()}
        onManageTeam={vi.fn()}
        signupLink={null}
        onGenerateSignupLink={vi.fn()}
        onRevokeSignupLink={vi.fn()}
        toast={toast}
      />,
    );
    return { toast };
  };
  const saveBtn = () => screen.getByRole('button', { name: /save deadline/i });

  it('stays open, re-enables Save and claims nothing when the save fails', async () => {
    const user = userEvent.setup();
    let fail: (e: Error) => void = () => {};
    const onUpdateDeadline = vi.fn(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const { toast } = renderView(onUpdateDeadline);

    await user.click(screen.getByRole('button', { name: /change deadline/i }));
    await user.click(saveBtn());
    // Busy while the save is in flight — no double submit.
    expect(saveBtn()).toBeDisabled();

    fail(new Error('500'));
    await vi.waitFor(() => expect(saveBtn()).toBeEnabled());
    expect(onUpdateDeadline).toHaveBeenCalledWith('2026-10-31');
    expect(toast).not.toHaveBeenCalled();
  });

  it('toasts and closes once the save lands', async () => {
    const user = userEvent.setup();
    const { toast } = renderView(vi.fn().mockResolvedValue(undefined));

    await user.click(screen.getByRole('button', { name: /change deadline/i }));
    await user.click(saveBtn());

    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^Deadline updated · /));
    expect(screen.queryByRole('button', { name: /save deadline/i })).toBeNull();
  });
});
