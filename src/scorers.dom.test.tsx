/**
 * Admin Scorers page — the register, add/edit/deactivate, appointment counts from the
 * officials joined onto GET /series, and the merge flow.
 * Rendered for real through the app's providers; only the API callbacks are stubs.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-utils';
import { AdminScorersView, scorerUpcomingAppointments } from './scorers';
import { ApiError } from './api';
import type { Club, Scorer, Series } from './types';

const SCORERS: Scorer[] = [
  { id: 'sc-naidoo', displayName: 'L.Naidoo', fullName: 'Lionel Naidoo', active: true },
  { id: 'sc-pillay', displayName: 'K.Pillay', phone: '0820000002', active: true },
  { id: 'sc-dup', displayName: 'Lionel N', active: true },
  { id: 'sc-old', displayName: 'Old Scorer', active: false, mergedInto: 'sc-naidoo' },
];

const clubs = [
  { id: 'home', name: 'Home CC', ground: { venue: 'Kingsmead Oval' } },
  { id: 'away', name: 'Away CC' },
] as unknown as Club[];

const SERIES = [
  {
    id: 's1',
    name: 'Series s1',
    teams: ['home', 'away'],
    fixtures: [
      {
        id: 'f1',
        date: '2099-10-04',
        time: '09:00',
        home: 'home',
        away: 'away',
        officials: {
          umpires: [],
          scorers: [
            { scorerId: 'sc-naidoo', name: 'L.Naidoo' },
            { scorerId: 'sc-pillay', name: 'K.Pillay' },
          ],
        },
      },
      {
        id: 'f2',
        date: '2000-01-01',
        home: 'away',
        away: 'home',
        officials: { umpires: [], scorers: [{ scorerId: 'sc-naidoo', name: 'L.Naidoo' }] },
      },
    ],
  },
] as unknown as Series[];

function setup(over: Partial<Parameters<typeof AdminScorersView>[0]> = {}) {
  const props = {
    scorers: SCORERS,
    allSeries: SERIES,
    clubs,
    onCreate: vi.fn().mockResolvedValue(undefined),
    onPatch: vi.fn().mockResolvedValue(undefined),
    onMerge: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
  renderWithProviders(<AdminScorersView {...props} />);
  return { ...props, user: userEvent.setup() };
}

const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

describe('AdminScorersView', () => {
  it('renders the register and the tiles', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Scorers' })).toBeTruthy();
    expect(screen.getByText('L.Naidoo')).toBeTruthy();
    expect(screen.getByText('Lionel Naidoo')).toBeTruthy();
    // Active filter by default: the merged entry is hidden.
    expect(screen.queryByText('Old Scorer')).toBeNull();
    const tile = (l: string) =>
      [...document.querySelectorAll('.players-stat')]
        .find((t) => t.querySelector('.players-stat-l')?.textContent === l)!
        .querySelector('.players-stat-n')!.textContent;
    expect(tile('Active')).toBe('3');
    expect(tile('Inactive / merged')).toBe('1');
    expect(tile('Appointments')).toBe('3');
  });

  it('derives appointment counts and upcoming fixtures from officials.scorers', () => {
    setup();
    const cell = within(rowOf('L.Naidoo')).getByText('2');
    expect(cell.getAttribute('title')).toMatch(/2099-10-04 09:00 · Home CC v Away CC · Kingsmead/);
    expect(cell.getAttribute('title')).not.toMatch(/2000-01-01/);
    expect(within(rowOf('K.Pillay')).getByText('1')).toBeTruthy();
    expect(within(rowOf('Lionel N')).getByText('0')).toBeTruthy();
    const up = scorerUpcomingAppointments(SERIES, clubs, '2026-10-30');
    expect(up.get('sc-naidoo')).toHaveLength(1);
  });

  it('adds a scorer with a trimmed body', async () => {
    const { user, onCreate } = setup();
    await user.click(screen.getByRole('button', { name: /add scorer/i }));
    const form = screen.getByRole('group', { name: 'New scorer' });
    await user.type(within(form).getByLabelText('Name'), '  T.Dlamini ');
    await user.type(within(form).getByLabelText('Email'), ' t@example.org ');
    await user.click(within(form).getByRole('button', { name: 'Add scorer' }));
    expect(onCreate).toHaveBeenCalledWith({
      displayName: 'T.Dlamini',
      fullName: null,
      phone: null,
      email: 't@example.org',
      idNumber: null,
      emergencyPhone: null,
      address: null,
    });
  });

  it('edits and deactivates through onPatch', async () => {
    const { user, onPatch } = setup();
    await user.click(within(rowOf('K.Pillay')).getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('group', { name: 'Edit K.Pillay' });
    const phone = within(form).getByLabelText('Phone');
    await user.clear(phone);
    await user.type(phone, '0830000000');
    await user.type(within(form).getByLabelText('ID number'), ' X123 ');
    await user.type(within(form).getByLabelText('Emergency contact'), '0820000000');
    await user.type(within(form).getByLabelText('Home address'), '1 Test Rd');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(onPatch).toHaveBeenCalledWith('sc-pillay', {
      displayName: 'K.Pillay',
      fullName: null,
      phone: '0830000000',
      email: null,
      idNumber: 'X123',
      emergencyPhone: '0820000000',
      address: '1 Test Rd',
    });
    await user.click(within(rowOf('L.Naidoo')).getByRole('button', { name: 'Deactivate' }));
    expect(onPatch).toHaveBeenCalledWith('sc-naidoo', { active: false });
  });

  it('searches by name', async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText('Search scorers'), 'lionel');
    expect(screen.getByText('L.Naidoo')).toBeTruthy();
    expect(screen.getByText('Lionel N')).toBeTruthy();
    expect(screen.queryByText('K.Pillay')).toBeNull();
  });

  it('merges a duplicate into an active scorer', async () => {
    const { user, onMerge } = setup();
    await user.click(within(rowOf('Lionel N')).getByRole('button', { name: 'Merge…' }));
    const select = screen.getByLabelText('Merge Lionel N into');
    // Only other active scorers are targets.
    expect(within(select).queryByText('Old Scorer')).toBeNull();
    expect(within(select).queryByText('Lionel N')).toBeNull();
    await user.selectOptions(select, 'sc-naidoo');
    await user.click(screen.getByRole('button', { name: 'Merge' }));
    expect(onMerge).toHaveBeenCalledWith('sc-dup', 'sc-naidoo');
  });

  it('shows a merged entry under Inactive without merge or reactivate actions', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /^Inactive/ }));
    const row = rowOf('Old Scorer');
    expect(within(row).getByText('Merged into L.Naidoo')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Reactivate' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Merge…' })).toBeNull();
  });

  it('shows the empty state', () => {
    setup({ scorers: [] });
    expect(screen.getByText(/No scorers yet/)).toBeTruthy();
  });
});

/* ─── Erased stubs, the Pending queue, Delete and the registration link ─── */

const WITH_STUBS = [
  ...SCORERS,
  {
    id: 'sc-gone',
    displayName: 'Removed scorer',
    active: false,
    erased: true,
    erasedAt: '2026-11-01T10:00:00Z',
  },
  {
    id: 'sc-gone-dup',
    displayName: 'Removed scorer',
    active: false,
    mergedInto: 'sc-gone',
    erased: true,
    erasedAt: '2026-11-01T10:00:00Z',
  },
  {
    id: 'sc-p-new',
    displayName: 'Priya Govender',
    fullName: 'Priya Govender',
    phone: '0831112222',
    email: 'priya@example.org',
    emergencyPhone: '0839998888',
    active: false,
    pending: true,
    submittedAt: '2026-11-08T09:30:00Z',
    possibleMatches: [{ id: 'sc-pillay', displayName: 'K.Pillay', reason: 'name' }],
  },
] as Array<Scorer & { erased?: true }>;

describe('AdminScorersView — erase, pending and the registration link', () => {
  const setupFull = (over: Partial<Parameters<typeof AdminScorersView>[0]> = {}) =>
    setup({
      scorers: WITH_STUBS,
      onApprove: vi.fn().mockResolvedValue(undefined),
      onMergePending: vi.fn().mockResolvedValue({
        target: { displayName: 'K.Pillay', phone: '0820000002', email: 'priya@example.org' },
        previous: { phone: '0820000002', email: null },
        repointed: 0,
      }),
      onErase: vi
        .fn()
        .mockResolvedValue({ erased: ['sc-pillay'], hardDeleted: false, vacated: [] }),
      loadErasePreview: vi.fn().mockResolvedValue({
        vacated: [
          { seriesId: 's1', fixtureId: 'f1', date: '2099-10-04', label: 'Home CC v Away CC' },
        ],
        counts: { today: 0, upcoming: 1, played: 1 },
      }),
      signupLink: {
        load: vi.fn().mockResolvedValue({ url: null }),
        create: vi.fn().mockResolvedValue({
          url: 'https://app.example/officials/register?t=s1',
          createdAt: '2026-11-10T08:00:00Z',
        }),
        revoke: vi.fn().mockResolvedValue({ ok: true }),
      },
      ...over,
    });
  const tab = (name: RegExp) => screen.getByRole('button', { name });

  it('hides erased stubs from tabs, tiles and merge targets', async () => {
    const { user } = setupFull();
    expect(tab(/^Pending/).textContent).toBe('Pending1');
    expect(tab(/^Inactive/).textContent).toBe('Inactive1');
    expect(tab(/^All/).textContent).toBe('All5');
    const tile = (l: string) =>
      [...document.querySelectorAll('.players-stat')]
        .find((t) => t.querySelector('.players-stat-l')?.textContent === l)!
        .querySelector('.players-stat-n')!.textContent;
    expect(tile('Inactive / merged')).toBe('1');
    await user.click(tab(/^All/));
    expect(screen.queryByText('Removed scorer')).toBeNull();
    await user.click(within(rowOf('Lionel N')).getByRole('button', { name: 'Merge…' }));
    const select = screen.getByLabelText('Merge Lionel N into');
    expect(within(select).queryByText('Removed scorer')).toBeNull();
    expect(within(select).queryByText('Priya Govender')).toBeNull();
  });

  it('shows a pending registration with its candidates, without Reactivate or Delete', async () => {
    const { user } = setupFull();
    await user.click(tab(/^Inactive/));
    expect(screen.queryByText('Priya Govender')).toBeNull();
    await user.click(tab(/^Pending/));
    const row = screen.getByTestId('pending-row');
    expect(within(row).getByText('0831112222')).toBeTruthy();
    expect(within(row).getByText('Emergency: 0839998888')).toBeTruthy();
    expect(within(row).queryByText(/Resubmitted/)).toBeNull();
    const list = within(row).getByRole('list', { name: 'Possible matches for Priya Govender' });
    expect(within(list).getByText('(same name)')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Reactivate' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Delete' })).toBeNull();
    for (const b of ['Approve', 'Merge into…', 'Edit', 'Reject'])
      expect(within(row).getByRole('button', { name: b })).toBeTruthy();
  });

  it('a name clash on Approve names the existing scorer and points to Merge', async () => {
    const onApprove = vi.fn().mockRejectedValue(
      new ApiError(409, 'taken', 'scorer_name_taken', {
        scorerId: 'sc-naidoo',
        displayName: 'L.Naidoo',
      }),
    );
    const { user } = setupFull({ onApprove });
    await user.click(tab(/^Pending/));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledWith('sc-p-new', '2026-11-08T09:30:00Z');
    expect(screen.getByRole('alert').textContent).toMatch(
      /“L\.Naidoo” is already on the register.*Merge into…/,
    );
  });

  it('the contact-choice dialog needs a choice for every conflicting field', async () => {
    const onMergePending = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(409, 'choose', 'contact_choice_required', {
          conflicts: [
            { field: 'phone', source: '0831112222', target: '0820000002' },
            { field: 'email', source: 'priya@example.org', target: 'office@example.org' },
          ],
        }),
      )
      .mockResolvedValueOnce({
        target: { displayName: 'K.Pillay', phone: '0820000002', email: 'priya@example.org' },
        previous: { phone: '0820000002', email: 'office@example.org' },
        repointed: 0,
      });
    const { user } = setupFull({ onMergePending });
    await user.click(tab(/^Pending/));
    await user.click(screen.getByRole('button', { name: 'Merge into…' }));
    await user.selectOptions(screen.getByLabelText('Merge Priya Govender into'), 'sc-pillay');
    await user.click(screen.getByTestId('pending-merge-confirm'));
    const dialog = within(screen.getByTestId('contact-choice-dialog'));
    const confirm = screen.getByTestId('contact-choice-confirm');
    await user.click(
      within(dialog.getByRole('group', { name: 'Phone' })).getByLabelText(/Keep current/),
    );
    expect(confirm).toHaveProperty('disabled', true);
    await user.click(
      within(dialog.getByRole('group', { name: 'Email' })).getByLabelText(/Use submitted/),
    );
    expect(confirm).toHaveProperty('disabled', false);
    await user.click(confirm);
    expect(onMergePending).toHaveBeenLastCalledWith(
      'sc-p-new',
      'sc-pillay',
      '2026-11-08T09:30:00Z',
      {
        phone: 'target',
        email: 'source',
      },
    );
    expect(screen.getByRole('status').textContent).toMatch(
      /Email replaced: was office@example\.org, now priya@example\.org\./,
    );
  });

  it('Delete shows the preview counts and gates on the typed name', async () => {
    const { user, onErase } = setupFull();
    await user.click(within(rowOf('K.Pillay')).getByRole('button', { name: 'Delete' }));
    expect((await screen.findByTestId('official-delete-summary')).textContent).toBe(
      'Their personal details will be permanently erased. They will be removed from 1 upcoming fixture. 1 past appointment is kept under “Removed scorer”.',
    );
    const confirm = screen.getByTestId('official-delete-confirm');
    expect(confirm).toHaveProperty('disabled', true);
    await user.type(screen.getByTestId('official-delete-typed'), 'K.Pillay');
    await user.click(confirm);
    expect(onErase).toHaveBeenCalledWith('sc-pillay');
  });

  it('the registration link button opens the modal and creates a scorer link', async () => {
    const { user, signupLink } = setupFull();
    await user.click(screen.getByRole('button', { name: 'Registration link' }));
    await user.click(await screen.findByRole('button', { name: 'Create link' }));
    expect(signupLink!.create).toHaveBeenCalled();
    expect((screen.getByLabelText('Link to share') as HTMLInputElement).value).toMatch(/t=s1$/);
  });
});
