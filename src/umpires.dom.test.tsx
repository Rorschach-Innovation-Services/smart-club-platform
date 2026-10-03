/**
 * Umpire allocation UI — the fixture table's Umpires cell (1–2 slot type-ahead picker,
 * inline "add umpire", the double-booking warning) and the admin Umpires page.
 * Rendered for real through the app's providers; only the API callbacks are stubs.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-utils';
import { AdminUmpiresView, UmpireCell, doubleBookingIndex, mergeErrorMessage } from './umpires';
import { ApiError } from './api';
import type { CaptainsReport, Club, Series, Umpire } from './types';

const ump = (id: string, displayName: string, over: Partial<Umpire> = {}): Umpire => ({
  id,
  displayName,
  aliases: [displayName.toLowerCase().replace(/[^a-z0-9]/g, '')],
  active: true,
  ...over,
});

const UMPIRES = [
  ump('u-a-ngubane', 'A.Ngubane', { phone: '0820000001' }),
  ump('u-b-tyali', 'B.Tyali'),
  ump('u-s-gasa', 'S.Gasa'),
  ump('u-old', 'Old Name', { active: false, mergedInto: 'u-s-gasa', aliases: [] }),
];

const clubs = [
  { id: 'home', name: 'Home CC', ground: { venue: 'Kingsmead Oval' } },
  { id: 'away', name: 'Away CC', ground: { venue: 'Toti Oval 1' } },
] as unknown as Club[];

const seriesOf = (id: string, fixtures: Array<Record<string, unknown>>): Series =>
  ({
    id,
    name: `Series ${id}`,
    startDate: '2026-10-04',
    teams: ['home', 'away'],
    fixtures,
    released: false,
    releasedAt: null,
    version: 1,
  }) as unknown as Series;

const S1 = seriesOf('s1', [
  { id: 'f1', date: '2026-10-04', time: '09:00', home: 'home', away: 'away' },
]);
// Same morning, a different ground, already has S.Gasa.
const S2 = seriesOf('s2', [
  {
    id: 'f1',
    date: '2026-10-04',
    time: '10:00',
    home: 'away',
    away: 'home',
    officials: { umpires: [{ umpireId: 'u-s-gasa', name: 'S.Gasa' }] },
  },
]);

function renderCell(extra: Partial<Parameters<typeof UmpireCell>[0]> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onCreate = vi.fn(async (displayName: string) => ump('u-new', displayName));
  const user = userEvent.setup();
  renderWithProviders(
    <UmpireCell
      series={S1}
      fixture={S1.fixtures[0] as { id: string }}
      allSeries={[S1, S2]}
      clubs={clubs}
      umpires={UMPIRES}
      onSave={onSave}
      onCreate={onCreate}
      {...extra}
    />,
  );
  return { onSave, onCreate, user };
}

describe('UmpireCell', () => {
  it('appoints two umpires through the type-ahead and saves their ids in order', async () => {
    const { onSave, user } = renderCell();
    await user.click(screen.getByRole('button', { name: 'Assign umpires' }));
    await user.type(screen.getByLabelText('Umpire 1'), 'ngu');
    await user.click(screen.getByRole('option', { name: /A\.Ngubane/ }));
    await user.type(screen.getByLabelText('Umpire 2'), 'ty');
    // The first slot's umpire is never offered again.
    expect(screen.queryByRole('option', { name: /A\.Ngubane/ })).toBeNull();
    await user.click(screen.getByRole('option', { name: /B\.Tyali/ }));
    // Only two slots, ever.
    expect(screen.queryByLabelText('Umpire 3')).toBeNull();
    await user.click(screen.getByRole('button', { name: /save umpires/i }));
    expect(onSave).toHaveBeenCalledWith('s1', 'f1', ['u-a-ngubane', 'u-b-tyali']);
  });

  it('works from the keyboard: arrows move through the suggestions, Enter picks, Escape closes', async () => {
    const { onSave, user } = renderCell();
    await user.click(screen.getByRole('button', { name: 'Assign umpires' }));
    const input = screen.getByLabelText('Umpire 1');
    await user.type(input, 'a');
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(input).toHaveFocus();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByRole('button', { name: /^Remove A\.Ngubane/ })).toBeInTheDocument();
    const second = screen.getByLabelText('Umpire 2');
    await user.type(second, 'ty');
    await user.keyboard('{Escape}');
    expect(second).toHaveValue('');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: /save umpires/i }));
    expect(onSave).toHaveBeenCalledWith('s1', 'f1', ['u-a-ngubane']);
  });

  it('never offers an inactive (merged) umpire', async () => {
    const { user } = renderCell();
    await user.click(screen.getByRole('button', { name: 'Assign umpires' }));
    await user.type(screen.getByLabelText('Umpire 1'), 'old');
    expect(screen.queryByRole('option', { name: /Old Name/ })).toBeNull();
  });

  it('adds a new umpire inline and selects them', async () => {
    const { onCreate, onSave, user } = renderCell();
    await user.click(screen.getByRole('button', { name: 'Assign umpires' }));
    await user.type(screen.getByLabelText('Umpire 1'), 'K.Ntuli');
    await user.click(screen.getByRole('button', { name: /add “K\.Ntuli” as a new umpire/i }));
    expect(onCreate).toHaveBeenCalledWith('K.Ntuli');
    await user.click(screen.getByRole('button', { name: /save umpires/i }));
    expect(onSave).toHaveBeenCalledWith('s1', 'f1', ['u-new']);
  });

  it('warns, without blocking, when the pick is at another ground at an overlapping time', async () => {
    const { onSave, user } = renderCell();
    await user.click(screen.getByRole('button', { name: 'Assign umpires' }));
    await user.type(screen.getByLabelText('Umpire 1'), 'gasa');
    await user.click(screen.getByRole('option', { name: /S\.Gasa/ }));
    const warning = screen.getByRole('status');
    expect(warning.textContent).toMatch(/S\.Gasa is also at Toti Oval 1 at 10:00 \(Series s2\)/);
    await user.click(screen.getByRole('button', { name: /save umpires/i }));
    expect(onSave).toHaveBeenCalledWith('s1', 'f1', ['u-s-gasa']);
  });

  it('is read-only without onSave and shows the saved warning', () => {
    renderWithProviders(
      <UmpireCell
        series={S1}
        fixture={{
          id: 'f1',
          officials: { umpires: [{ umpireId: 'u-s-gasa', name: 'S.Gasa' }] },
        }}
        allSeries={[S1, S2]}
        clubs={clubs}
        umpires={UMPIRES}
        warnings={['S.Gasa is also at Toti Oval 1']}
      />,
    );
    expect(screen.getByText(/S\.Gasa/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Assign umpires' })).toBeNull();
    expect(screen.getByRole('img', { name: /possible double booking/i })).toBeTruthy();
  });
});

describe('doubleBookingIndex', () => {
  it('flags both fixtures of an overlap, and nothing for the same ground twice a day', () => {
    const a = seriesOf('a', [
      {
        id: 'f1',
        date: '2026-10-04',
        time: '09:00',
        home: 'home',
        away: 'away',
        officials: { umpires: [{ umpireId: 'u-s-gasa', name: 'S.Gasa' }] },
      },
      // Same ground (home's) that afternoon — the normal double-header — and clear of S2's
      // 10:00 game at Toti by its four-hour slot (10:00 + 4h = 14:00).
      {
        id: 'f2',
        date: '2026-10-04',
        time: '14:00',
        home: 'home',
        away: 'away',
        officials: { umpires: [{ umpireId: 'u-s-gasa', name: 'S.Gasa' }] },
      },
    ]);
    expect(doubleBookingIndex([a], clubs, (id) => id).size).toBe(0);
    const idx = doubleBookingIndex([a, S2], clubs, (id) => id);
    expect([...idx.keys()].sort()).toEqual(['a#f1', 's2#f1']);
  });
});

describe('AdminUmpiresView', () => {
  const setup = (reports: CaptainsReport[] = []) => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const onPatch = vi.fn().mockResolvedValue(undefined);
    const onMerge = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithProviders(
      <AdminUmpiresView
        umpires={UMPIRES}
        allSeries={[S2]}
        onCreate={onCreate}
        onPatch={onPatch}
        onMerge={onMerge}
        reports={reports}
      />,
    );
    return { onCreate, onPatch, onMerge, user };
  };
  const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

  it('lists active umpires with contacts and appointment counts; no ratings yet', async () => {
    setup();
    expect(within(rowOf('A.Ngubane')).getByText('0820000001')).toBeTruthy();
    expect(within(rowOf('S.Gasa')).getByText('1')).toBeTruthy();
    expect(screen.getAllByText(/no ratings yet/i).length).toBe(3);
    expect(screen.queryByText('Old Name')).toBeNull();
  });

  it('averages submitted captain’s reports per umpire, merged entries under their target', () => {
    const rated = (umpireId: string, score: number) => ({
      umpireId,
      name: umpireId,
      ratings: {
        decisions: score,
        pressure: score,
        behaviour: score,
        communication: score,
        regulations: score,
      },
      concerns: {},
      otherConcern: '',
      comments: '',
    });
    const report = (status: CaptainsReport['status'], umpires: ReturnType<typeof rated>[]) =>
      ({ id: `r-${Math.random()}`, status, umpires }) as unknown as CaptainsReport;
    setup([
      report('submitted', [rated('u-a-ngubane', 4)]),
      report('submitted', [rated('u-a-ngubane', 2)]),
      // Rated under the old id before the merge → counts for S.Gasa.
      report('submitted', [rated('u-old', 5)]),
      report('pending', [rated('u-b-tyali', 1)]),
    ]);
    const ngubane = rowOf('A.Ngubane');
    expect(within(ngubane).getByText('3.0')).toBeTruthy();
    expect(within(ngubane).getByText(/2 reports/)).toBeTruthy();
    expect(within(ngubane).getByText('1 low')).toBeTruthy();
    expect(within(rowOf('S.Gasa')).getByText('5.0')).toBeTruthy();
    expect(within(rowOf('B.Tyali')).getByText(/no ratings yet/i)).toBeTruthy();
  });

  it('searches, and shows merged entries under Inactive', async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText('Search umpires'), 'tya');
    expect(screen.getByText('B.Tyali')).toBeTruthy();
    expect(screen.queryByText('A.Ngubane')).toBeNull();
    await user.clear(screen.getByLabelText('Search umpires'));
    await user.click(screen.getByRole('button', { name: /inactive/i }));
    expect(within(rowOf('Old Name')).getByText(/merged into S\.Gasa/i)).toBeTruthy();
  });

  it('adds, edits, deactivates and merges', async () => {
    const { onCreate, onPatch, onMerge, user } = setup();
    await user.click(screen.getByRole('button', { name: /add umpire/i }));
    const form = screen.getByRole('group', { name: 'New umpire' });
    await user.type(within(form).getByLabelText('Sheet name'), 'K.Ntuli');
    await user.type(within(form).getByLabelText('Phone'), '0830000000');
    await user.click(within(form).getByRole('button', { name: /add umpire/i }));
    expect(onCreate).toHaveBeenCalledWith({
      displayName: 'K.Ntuli',
      fullName: null,
      phone: '0830000000',
      email: null,
    });

    await user.click(within(rowOf('B.Tyali')).getByRole('button', { name: 'Deactivate' }));
    expect(onPatch).toHaveBeenCalledWith('u-b-tyali', { active: false });

    await user.click(within(rowOf('B.Tyali')).getByRole('button', { name: 'Edit' }));
    const edit = screen.getByRole('group', { name: 'Edit B.Tyali' });
    await user.type(within(edit).getByLabelText('Full name'), 'Bongani Tyali');
    await user.click(within(edit).getByRole('button', { name: 'Save' }));
    expect(onPatch).toHaveBeenCalledWith('u-b-tyali', {
      displayName: 'B.Tyali',
      fullName: 'Bongani Tyali',
      phone: null,
      email: null,
    });

    await user.click(within(rowOf('A.Ngubane')).getByRole('button', { name: /merge/i }));
    await user.selectOptions(screen.getByLabelText('Merge A.Ngubane into'), 'u-s-gasa');
    await user.click(screen.getByRole('button', { name: 'Merge' }));
    expect(onMerge).toHaveBeenCalledWith('u-a-ngubane', 'u-s-gasa');
  });
});

describe('Upload appointments and merge refusals', () => {
  it('the Umpires page offers Upload appointments', async () => {
    const onUpload = vi.fn();
    renderWithProviders(
      <AdminUmpiresView
        umpires={UMPIRES}
        allSeries={[S2]}
        onCreate={vi.fn()}
        onPatch={vi.fn()}
        onMerge={vi.fn()}
        onUpload={onUpload}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Upload appointments' }));
    expect(onUpload).toHaveBeenCalled();
  });

  it('a merge refused because the umpire is already merged says where it went', () => {
    const err = new ApiError(
      409,
      'Sipho Gasa is already merged into S.Gasa',
      'umpire_already_merged',
      {
        mergedInto: 'u-s-gasa',
        mergedIntoName: 'S.Gasa',
      },
    );
    expect(mergeErrorMessage(err)).toBe('Already merged into S.Gasa');
    expect(mergeErrorMessage(new ApiError(409, 'other', 'something_else'))).toBeNull();
  });
});
