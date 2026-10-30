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
    });
  });

  it('edits and deactivates through onPatch', async () => {
    const { user, onPatch } = setup();
    await user.click(within(rowOf('K.Pillay')).getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('group', { name: 'Edit K.Pillay' });
    const phone = within(form).getByLabelText('Phone');
    await user.clear(phone);
    await user.type(phone, '0830000000');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(onPatch).toHaveBeenCalledWith('sc-pillay', {
      displayName: 'K.Pillay',
      fullName: null,
      phone: '0830000000',
      email: null,
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
