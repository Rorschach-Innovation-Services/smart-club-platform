/**
 * AdminTeamAccessView — who can get into a union, and with what scope.
 *
 * The consequential failure here is a LOCKOUT: demote or remove the only administrator
 * and the tenant has nobody who can invite one back. The API guards that atomically
 * (`writeUserWithAdminDelta` carries `adminCount > 1` on the decrement, so the whole
 * transaction is rejected), which means these tests are about the console telling the
 * truth BEFORE the request — a 409 toast after the fact is a bad way to learn it.
 *
 * The other half is scope. A rep sees only their clubs, so "which clubs" is an access
 * decision, and a rep with no clubs can see nothing at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminTeamAccessView } from './admin';
import { renderWithProviders } from './test-utils';

const clubs = [
  { id: 'berea', name: 'Berea CC' },
  { id: 'ukzn', name: 'UKZN CC' },
];

const user = (over: Record<string, unknown> = {}) => ({
  sub: 'u1',
  email: 'admin@union.co.za',
  role: 'admin',
  clubIds: [],
  status: 'active',
  invitedAt: '2026-06-01T09:00:00.000Z',
  ...over,
});

const setup = (users: Array<Record<string, unknown>>, currentUserEmail = 'me@union.co.za') => {
  const onPatchUser = vi.fn().mockResolvedValue(undefined);
  const onRemoveUser = vi.fn().mockResolvedValue(undefined);
  const onResend = vi.fn().mockResolvedValue({ results: [{ channel: 'email', status: 'sent' }] });
  const u = userEvent.setup();
  renderWithProviders(
    <AdminTeamAccessView
      users={users as never[]}
      clubs={clubs as never[]}
      currentUserEmail={currentUserEmail}
      onInvite={vi.fn()}
      onPatchUser={onPatchUser}
      onRemoveUser={onRemoveUser}
      onResend={onResend}
      onChangeEmail={vi.fn()}
      toast={vi.fn()}
    />,
  );
  return { user: u, onPatchUser, onRemoveUser, onResend };
};

const rowFor = (email: string) => screen.getByRole('row', { name: new RegExp(email, 'i') });
const dialog = () => document.querySelector('.task-modal') as HTMLElement;

beforeEach(() => vi.clearAllMocks());

describe('the last administrator cannot be locked out', () => {
  it('disables Remove on the only admin, and says why', () => {
    setup([user()]);

    const remove = within(rowFor('admin@union.co.za')).getByRole('button', { name: /remove/i });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute('title', "Can't remove the only administrator");
  });

  it('allows Remove once a second admin exists', () => {
    setup([user(), user({ sub: 'u2', email: 'second@union.co.za' })]);

    for (const email of ['admin@union.co.za', 'second@union.co.za'])
      expect(within(rowFor(email)).getByRole('button', { name: /remove/i })).toBeEnabled();
  });

  it('refuses to demote the only admin to a club rep', async () => {
    // The modal already SAYS they can't be demoted. The control has to agree with it —
    // otherwise the admin picks "Club rep", saves, and learns from a 409.
    const { user: u } = setup([user()]);
    await u.click(
      within(rowFor('admin@union.co.za')).getByRole('button', { name: /change role/i }),
    );

    expect(
      within(dialog()).getByText(/only administrator — they can’t be demoted|can't be demoted/i),
    ).toBeVisible();
    expect(within(dialog()).getByRole('option', { name: /club rep/i })).toBeDisabled();
  });

  it('lets an admin be demoted once another admin exists', async () => {
    const { user: u, onPatchUser } = setup([
      user(),
      user({ sub: 'u2', email: 'second@union.co.za' }),
    ]);
    await u.click(
      within(rowFor('admin@union.co.za')).getByRole('button', { name: /change role/i }),
    );

    const role = within(dialog()).getByRole('combobox');
    expect(within(dialog()).getByRole('option', { name: /club rep/i })).toBeEnabled();
    await u.selectOptions(role, 'rep');
    await u.click(within(dialog()).getByRole('checkbox', { name: /berea/i }));
    await u.click(within(dialog()).getByRole('button', { name: /save changes/i }));

    expect(onPatchUser).toHaveBeenCalledWith('u1', { role: 'rep', clubIds: ['berea'] });
  });
});

describe('a rep must be scoped to at least one club', () => {
  it('will not save a rep with no clubs selected', async () => {
    const { user: u, onPatchUser } = setup([
      user(),
      user({ sub: 'u2', email: 'rep@club.co.za', role: 'rep', clubIds: ['berea'] }),
    ]);
    await u.click(within(rowFor('rep@club.co.za')).getByRole('button', { name: /edit clubs/i }));

    // Deselect the only club — a rep scoped to nothing can see nothing.
    await u.click(within(dialog()).getByRole('checkbox', { name: /berea/i }));
    expect(within(dialog()).getByRole('button', { name: /save changes/i })).toBeDisabled();
    expect(onPatchUser).not.toHaveBeenCalled();
  });

  it('saves a widened scope', async () => {
    const { user: u, onPatchUser } = setup([
      user(),
      user({ sub: 'u2', email: 'rep@club.co.za', role: 'rep', clubIds: ['berea'] }),
    ]);
    await u.click(within(rowFor('rep@club.co.za')).getByRole('button', { name: /edit clubs/i }));
    await u.click(within(dialog()).getByRole('checkbox', { name: /ukzn/i }));
    await u.click(within(dialog()).getByRole('button', { name: /save changes/i }));

    expect(onPatchUser).toHaveBeenCalledWith('u2', { clubIds: ['berea', 'ukzn'] });
  });

  it('sends an empty scope when a rep is promoted to admin', async () => {
    // An admin sees the whole union; leaving stale clubIds behind would be a lie in the
    // record even though nothing reads them for an admin.
    const { user: u, onPatchUser } = setup([
      user(),
      user({ sub: 'u2', email: 'rep@club.co.za', role: 'rep', clubIds: ['berea'] }),
    ]);
    await u.click(within(rowFor('rep@club.co.za')).getByRole('button', { name: /change role/i }));
    await u.selectOptions(within(dialog()).getByRole('combobox'), 'admin');
    await u.click(within(dialog()).getByRole('button', { name: /save changes/i }));

    expect(onPatchUser).toHaveBeenCalledWith('u2', { role: 'admin', clubIds: [] });
  });

  it('offers no rep option when the union has no clubs yet', async () => {
    const onPatchUser = vi.fn();
    const u = userEvent.setup();
    renderWithProviders(
      <AdminTeamAccessView
        users={[user()] as never[]}
        clubs={[] as never[]}
        currentUserEmail="me@union.co.za"
        onInvite={vi.fn()}
        onPatchUser={onPatchUser}
        onRemoveUser={vi.fn()}
        onResend={vi.fn()}
        onChangeEmail={vi.fn()}
        toast={vi.fn()}
      />,
    );
    await u.click(
      within(rowFor('admin@union.co.za')).getByRole('button', { name: /change role/i }),
    );

    expect(within(dialog()).getByRole('option', { name: /club rep/i })).toBeDisabled();
  });
});

describe('removing access', () => {
  it('asks before signing someone out', async () => {
    const { user: u, onRemoveUser } = setup([
      user(),
      user({ sub: 'u2', email: 'second@union.co.za' }),
    ]);
    await u.click(within(rowFor('second@union.co.za')).getByRole('button', { name: /remove/i }));

    expect(screen.getByText(/will lose access to this union/i)).toBeVisible();
    expect(onRemoveUser).not.toHaveBeenCalled();

    await u.click(screen.getByRole('button', { name: /remove access/i }));
    expect(onRemoveUser).toHaveBeenCalledWith('u2');
  });

  it('does nothing when the confirmation is cancelled', async () => {
    const { user: u, onRemoveUser } = setup([
      user(),
      user({ sub: 'u2', email: 'second@union.co.za' }),
    ]);
    await u.click(within(rowFor('second@union.co.za')).getByRole('button', { name: /remove/i }));
    await u.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onRemoveUser).not.toHaveBeenCalled();
  });
});

describe('an invite that has not been taken up', () => {
  it('offers a resend only while the invite is pending', () => {
    setup([
      user({ sub: 'u2', email: 'pending@union.co.za', status: 'pending' }),
      user({ sub: 'u3', email: 'active@union.co.za', status: 'active' }),
    ]);

    expect(
      within(rowFor('pending@union.co.za')).getByRole('button', { name: /resend/i }),
    ).toBeVisible();
    expect(
      within(rowFor('active@union.co.za')).queryByRole('button', { name: /resend/i }),
    ).toBeNull();
  });

  it('offers to correct the address only while it is pending', () => {
    // A typo'd invite is unreachable, and the person it was meant for never appears.
    setup([
      user({ sub: 'u2', email: 'typo@union.co.za', status: 'pending' }),
      user({ sub: 'u3', email: 'active@union.co.za', status: 'active' }),
    ]);

    expect(screen.getByLabelText(/correct email for typo@union.co.za/i)).toBeVisible();
    expect(screen.queryByLabelText(/correct email for active@union.co.za/i)).toBeNull();
  });
});
