/**
 * Umpire allocation UI — the fixture table's Umpires cell (1–2 slot type-ahead picker,
 * inline "add umpire", the double-booking warning) and the admin Umpires page.
 * Rendered for real through the app's providers; only the API callbacks are stubs.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-utils';
import {
  AdminUmpiresView,
  UmpireCell,
  doubleBookingIndex,
  mergeErrorMessage,
  noticeBadge,
  noContactHint,
} from './umpires';
import { ApiError } from './api';
import type { CaptainsReport, Club, Scorer, Series, Umpire } from './types';

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

const SCORERS: Scorer[] = [
  { id: 'sc-dlamini', displayName: 'T.Dlamini', email: 't@example.org', active: true },
  { id: 'sc-pillay', displayName: 'R.Pillay', phone: '0820000002', active: true },
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

  it('appoints a scorer and a backup through the second line and saves their ids in order', async () => {
    const onSaveScorers = vi.fn().mockResolvedValue(undefined);
    const { onSave, user } = renderCell({ scorers: SCORERS, onSaveScorers });
    await user.click(screen.getByRole('button', { name: 'Assign scorers' }));
    // One picker at a time.
    expect(screen.queryByRole('button', { name: 'Assign umpires' })).toBeNull();
    await user.type(screen.getByLabelText('Scorer'), 'dla');
    await user.click(screen.getByRole('option', { name: /T\.Dlamini/ }));
    await user.type(screen.getByLabelText('Backup scorer'), 'pil');
    await user.click(screen.getByRole('option', { name: /R\.Pillay/ }));
    await user.click(screen.getByRole('button', { name: /save scorers/i }));
    expect(onSaveScorers).toHaveBeenCalledWith('s1', 'f1', ['sc-dlamini', 'sc-pillay']);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows saved scorers read-only without onSaveScorers', () => {
    renderWithProviders(
      <UmpireCell
        series={S1}
        fixture={{
          id: 'f1',
          officials: { umpires: [], scorers: [{ scorerId: 'sc-gone', name: 'Saved Name' }] },
        }}
        allSeries={[S1]}
        clubs={clubs}
        umpires={UMPIRES}
      />,
    );
    expect(screen.getByText(/Scorers:\s*Saved Name/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Assign scorers' })).toBeNull();
  });

  it('asks for optional contacts before adding a new scorer, and passes them through', async () => {
    const onSaveScorers = vi.fn().mockResolvedValue(undefined);
    const onCreateScorer = vi.fn(
      async (displayName: string, contacts?: { phone?: string; email?: string }) =>
        ({ id: 'sc-new', displayName, active: true, ...contacts }) as Scorer,
    );
    const { user } = renderCell({ scorers: SCORERS, onSaveScorers, onCreateScorer });
    await user.click(screen.getByRole('button', { name: 'Assign scorers' }));
    await user.type(screen.getByLabelText('Scorer'), 'P.Naidoo');
    await user.click(screen.getByRole('button', { name: /add “P\.Naidoo” as a new scorer/i }));
    expect(onCreateScorer).not.toHaveBeenCalled();
    const form = screen.getByRole('group', { name: 'New scorer contacts' });
    await user.type(within(form).getByLabelText('Email (optional)'), 'p@example.org');
    await user.click(within(form).getByRole('button', { name: 'Add scorer' }));
    expect(onCreateScorer).toHaveBeenCalledWith('P.Naidoo', { email: 'p@example.org' });
    await user.click(screen.getByRole('button', { name: /save scorers/i }));
    expect(onSaveScorers).toHaveBeenCalledWith('s1', 'f1', ['sc-new']);
  });

  it('points a contactless scorer at the Scorers page, not the Umpires page', () => {
    expect(noContactHint('scorer')).toMatch(/Add contacts on the Scorers page/);
    expect(noContactHint('scorer')).not.toMatch(/Umpires page/);
    expect(noContactHint('umpire')).toMatch(/Add contacts on the Umpires page/);
  });

  it('shows the scorer hint when an assigned scorer has no contacts', async () => {
    const { user } = renderCell({
      scorers: [{ id: 'sc-bare', displayName: 'Z.Bare', active: true }],
      onSaveScorers: vi.fn().mockResolvedValue(undefined),
      fixture: {
        id: 'f1',
        officials: { umpires: [], scorers: [{ scorerId: 'sc-bare', name: 'Z.Bare' }] },
      },
    });
    await user.click(screen.getByRole('button', { name: 'Assign scorers' }));
    expect(screen.getByText(/Add contacts on the Scorers page/)).toBeTruthy();
    expect(screen.queryByText(/Umpires page/)).toBeNull();
  });

  it('has no scorer line without a register or saved scorers', () => {
    renderCell();
    expect(screen.queryByText(/Scorers:/)).toBeNull();
  });

  it('shows the notice badge next to an assigned scorer', async () => {
    const loadNotifyStatus = vi.fn().mockResolvedValue({
      rows: [
        // The same id as an umpire row would not match: role is part of the key.
        { fixtureId: 'f1', role: 'umpire', umpireId: 'sc-dlamini', status: 'queued', attempts: 0 },
        {
          fixtureId: 'f1',
          role: 'scorer',
          umpireId: 'sc-dlamini',
          status: 'completed',
          attempts: 1,
          completedAt: '2026-10-12T08:00:00Z',
        },
      ],
    });
    const user = userEvent.setup();
    renderWithProviders(
      <UmpireCell
        series={S1}
        fixture={{
          id: 'f1',
          officials: { umpires: [], scorers: [{ scorerId: 'sc-dlamini', name: 'T.Dlamini' }] },
        }}
        allSeries={[S1]}
        clubs={clubs}
        umpires={UMPIRES}
        scorers={SCORERS}
        onSaveScorers={vi.fn().mockResolvedValue(undefined)}
        loadNotifyStatus={loadNotifyStatus}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Assign scorers' }));
    expect(loadNotifyStatus).toHaveBeenCalledWith('s1');
    expect(await screen.findByText('Notified ✓')).toBeTruthy();
    expect(screen.queryByText(/Notice queued|Waiting for contact details/)).toBeNull();
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

describe('appointment notice badges and the no-contact hint', () => {
  it('an expired notice reads "Not sent (match played)" whether still queued or completed', () => {
    const contactless = { phone: '', email: '' };
    expect(noticeBadge({ status: 'queued', reason: 'expired' })?.label).toBe(
      'Not sent (match played)',
    );
    // Even for someone with no contacts: the match is played, so no "waiting" badge.
    expect(noticeBadge({ status: 'queued', reason: 'expired' }, contactless)?.label).toBe(
      'Not sent (match played)',
    );
    expect(noticeBadge({ status: 'completed', reason: 'expired' })?.label).toBe(
      'Not sent (match played)',
    );
    expect(noticeBadge({ status: 'queued' })?.label).toBe('Notice queued');
  });

  it('maps ledger rows to badges; a backfilled row shows none', () => {
    expect(noticeBadge(undefined)).toBeNull();
    expect(noticeBadge({ status: 'queued' })).toEqual({ label: 'Notice queued' });
    expect(noticeBadge({ status: 'queued' }, { phone: '0821234567' })).toEqual({
      label: 'Notice queued',
    });
    expect(noticeBadge({ status: 'queued' }, { email: ' ', phone: '' })?.label).toBe(
      'Waiting for contact details',
    );
    expect(noticeBadge({ status: 'exhausted', attempts: 5 })).toEqual({
      label: 'Couldn’t reach',
      title: '5 delivery attempts failed — check their email and cell on the Umpires page',
    });
    expect(noticeBadge({ status: 'completed', completedAt: '2026-10-12T08:00:00Z' })).toEqual({
      label: 'Notified ✓',
      title: '2026-10-12T08:00:00Z',
    });
    expect(noticeBadge({ status: 'completed', reason: 'backfill' })).toBeNull();
  });

  it('shows the badge next to an assigned umpire and hints when they have no contacts', async () => {
    const loadNotifyStatus = vi.fn().mockResolvedValue({
      rows: [
        {
          fixtureId: 'f1',
          role: 'umpire',
          umpireId: 'u-a-ngubane',
          status: 'completed',
          attempts: 1,
          completedAt: '2026-10-12T08:00:00Z',
        },
        { fixtureId: 'f1', role: 'umpire', umpireId: 'u-b-tyali', status: 'queued', attempts: 0 },
      ],
    });
    const user = userEvent.setup();
    renderWithProviders(
      <UmpireCell
        series={S1}
        fixture={{
          id: 'f1',
          officials: {
            umpires: [
              { umpireId: 'u-a-ngubane', name: 'A.Ngubane' },
              { umpireId: 'u-b-tyali', name: 'B.Tyali' },
            ],
          },
        }}
        allSeries={[S1, S2]}
        clubs={clubs}
        umpires={UMPIRES}
        onSave={vi.fn().mockResolvedValue(undefined)}
        loadNotifyStatus={loadNotifyStatus}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Assign umpires' }));
    expect(loadNotifyStatus).toHaveBeenCalledWith('s1');
    expect(await screen.findByText('Notified ✓')).toBeTruthy();
    // B.Tyali's notice is queued but there is nowhere to send it.
    expect(screen.getByText('Waiting for contact details')).toBeTruthy();
    expect(screen.queryByText('Notice queued')).toBeNull();
    // A.Ngubane has a cell; B.Tyali has nothing on file.
    expect(screen.getAllByText(/No email or cell on file/)).toHaveLength(1);
    // Saving stays allowed.
    expect(
      (screen.getByRole('button', { name: /save umpires/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('a failed status load shows no badge and no error', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <UmpireCell
        series={S1}
        fixture={{
          id: 'f1',
          officials: { umpires: [{ umpireId: 'u-a-ngubane', name: 'A.Ngubane' }] },
        }}
        allSeries={[S1, S2]}
        clubs={clubs}
        umpires={UMPIRES}
        onSave={vi.fn().mockResolvedValue(undefined)}
        loadNotifyStatus={vi.fn().mockRejectedValue(new Error('boom'))}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Assign umpires' }));
    await Promise.resolve();
    expect(screen.queryByText(/Notified|Notice queued|Couldn’t reach/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

/* ─── Erased stubs, the Pending queue, Delete and the registration link ─── */

const ERASED_AND_PENDING: Umpire[] = [
  ...UMPIRES,
  // An erased duplicate that had been merged into B.Tyali: hidden, but its ratings roll up.
  {
    ...ump('u-gone-dup', 'Removed umpire', { aliases: [] }),
    active: false,
    mergedInto: 'u-b-tyali',
    erasedAt: '2026-11-01T10:00:00Z',
    erased: true,
  } as Umpire,
  {
    ...ump('u-gone', 'Removed umpire', { aliases: [] }),
    active: false,
    erasedAt: '2026-11-01T10:00:00Z',
    erased: true,
  } as Umpire,
  {
    ...ump('u-k-ndlovu', 'K.Ndlovu', { aliases: [] }),
    fullName: 'Khaya Ndlovu',
    phone: '0821112222',
    active: false,
    pending: true,
    source: 'self-registration',
    submittedAt: '2026-11-08T09:30:00Z',
    resubmissions: 2,
    possibleMatches: [
      { id: 'u-a-ngubane', displayName: 'A.Ngubane', reason: 'phone' },
      { id: 'u-s-gasa', displayName: 'S.Gasa', reason: 'surname-initial' },
    ],
  } as Umpire,
];

describe('AdminUmpiresView — erase, pending and the registration link', () => {
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
  const setupFull = (over: Partial<Parameters<typeof AdminUmpiresView>[0]> = {}) => {
    const props = {
      umpires: ERASED_AND_PENDING,
      allSeries: [S2],
      onCreate: vi.fn().mockResolvedValue(undefined),
      onPatch: vi.fn().mockResolvedValue(undefined),
      onMerge: vi.fn().mockResolvedValue(undefined),
      onApprove: vi.fn().mockResolvedValue(undefined),
      onMergePending: vi.fn().mockResolvedValue({
        target: { displayName: 'A.Ngubane', phone: '0821112222' },
        previous: { phone: '0820000001', email: null },
        repointed: 0,
      }),
      onErase: vi
        .fn()
        .mockResolvedValue({ erased: ['u-b-tyali'], hardDeleted: false, vacated: [] }),
      loadErasePreview: vi.fn().mockResolvedValue({
        vacated: [
          { seriesId: 's1', fixtureId: 'f1', date: '2026-11-15', label: 'Home CC v Away CC' },
          { seriesId: 's1', fixtureId: 'f2', date: '2026-11-10', label: 'Away CC v Home CC' },
        ],
        counts: { today: 1, upcoming: 4, played: 12 },
      }),
      signupLink: {
        load: vi.fn().mockResolvedValue({ url: null }),
        create: vi.fn().mockResolvedValue({
          url: 'https://app.example/officials/register?t=tok1',
          createdAt: '2026-11-10T08:00:00Z',
        }),
        revoke: vi.fn().mockResolvedValue({ ok: true }),
      },
      ...over,
    };
    const user = userEvent.setup();
    renderWithProviders(<AdminUmpiresView {...props} />);
    return { ...props, user };
  };
  const tab = (name: RegExp) => screen.getByRole('button', { name });
  const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

  it('hides erased stubs from every tab, count and merge target', async () => {
    const { user } = setupFull();
    expect(tab(/^Active/).textContent).toBe('Active3');
    expect(tab(/^Pending/).textContent).toBe('Pending1');
    expect(tab(/^Inactive/).textContent).toBe('Inactive1');
    expect(tab(/^All/).textContent).toBe('All5');
    for (const t of [/^Active/, /^Pending/, /^Inactive/, /^All/]) {
      await user.click(tab(t));
      expect(screen.queryByText('Removed umpire')).toBeNull();
    }
    await user.click(tab(/^Active/));
    await user.click(within(rowOf('A.Ngubane')).getByRole('button', { name: 'Merge…' }));
    const select = screen.getByLabelText('Merge A.Ngubane into');
    expect(within(select).queryByText('Removed umpire')).toBeNull();
    expect(within(select).queryByText('K.Ndlovu')).toBeNull();
  });

  it('rolls ratings up through an erased merge chain', () => {
    setupFull({
      reports: [
        { id: 'r1', status: 'submitted', umpires: [rated('u-gone-dup', 5)] },
      ] as unknown as CaptainsReport[],
    });
    expect(within(rowOf('B.Tyali')).getByText('5.0')).toBeTruthy();
  });

  it('lists a pending registration with its details and candidates, never under Inactive', async () => {
    const { user } = setupFull();
    await user.click(tab(/^Inactive/));
    expect(screen.queryByText('K.Ndlovu')).toBeNull();
    await user.click(tab(/^Pending/));
    const row = rowOf('K.Ndlovu');
    expect(within(row).getByText('Khaya Ndlovu')).toBeTruthy();
    expect(within(row).getByText('0821112222')).toBeTruthy();
    expect(within(row).getByText(/^Submitted /)).toBeTruthy();
    expect(within(row).getByText('Resubmitted 2×')).toBeTruthy();
    const matches = within(row).getByRole('list', { name: 'Possible matches for K.Ndlovu' });
    expect(within(matches).getByText('(same phone)')).toBeTruthy();
    expect(within(matches).getByText('(same surname and initial)')).toBeTruthy();
    expect(within(row).getByText('Pending')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Reactivate' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeTruthy();
    // Merge into…: candidates first, nothing preselected.
    await user.click(within(row).getByRole('button', { name: 'Merge into…' }));
    const select = screen.getByLabelText('Merge K.Ndlovu into') as HTMLSelectElement;
    expect(select.value).toBe('');
    const groups = [...select.querySelectorAll('optgroup')].map((g) => g.label);
    expect(groups).toEqual(['Possible matches', 'Everyone else']);
    expect(select.querySelectorAll('optgroup')[1].textContent).toContain('B.Tyali');
    expect(screen.getByTestId('pending-merge-confirm')).toHaveProperty('disabled', true);
  });

  it('approves, and on a name clash points the admin to Merge', async () => {
    const { user, onApprove } = setupFull();
    await user.click(tab(/^Pending/));
    await user.click(within(rowOf('K.Ndlovu')).getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledWith('u-k-ndlovu', '2026-11-08T09:30:00Z');
    expect(screen.getByRole('status').textContent).toMatch(/K\.Ndlovu approved/);

    vi.mocked(onApprove!).mockRejectedValueOnce(
      new ApiError(409, 'alias taken', 'umpire_alias_taken', {
        umpireId: 'u-a-ngubane',
        displayName: 'A.Ngubane',
      }),
    );
    await user.click(within(rowOf('K.Ndlovu')).getByRole('button', { name: 'Approve' }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/“A\.Ngubane” is already on the register/);
    expect(alert.textContent).toMatch(/Merge into…/);
  });

  it('asks for an explicit choice per conflicting contact before merging, then says what changed', async () => {
    const { user, onMergePending } = setupFull();
    vi.mocked(onMergePending!).mockRejectedValueOnce(
      new ApiError(409, 'choose which contact details to keep', 'contact_choice_required', {
        conflicts: [{ field: 'phone', source: '0821112222', target: '0820000001' }],
      }),
    );
    await user.click(tab(/^Pending/));
    await user.click(within(rowOf('K.Ndlovu')).getByRole('button', { name: 'Merge into…' }));
    await user.selectOptions(screen.getByLabelText('Merge K.Ndlovu into'), 'u-a-ngubane');
    await user.click(screen.getByTestId('pending-merge-confirm'));
    expect(onMergePending).toHaveBeenLastCalledWith(
      'u-k-ndlovu',
      'u-a-ngubane',
      '2026-11-08T09:30:00Z',
      undefined,
    );

    const dialog = within(screen.getByTestId('contact-choice-dialog'));
    const phone = within(dialog.getByRole('group', { name: 'Phone' }));
    expect(phone.getByText('0820000001')).toBeTruthy();
    expect(phone.getByText('0821112222')).toBeTruthy();
    expect(phone.getAllByRole('radio').every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    const confirm = screen.getByTestId('contact-choice-confirm');
    expect(confirm).toHaveProperty('disabled', true);
    await user.click(phone.getByLabelText(/Use submitted/));
    expect(confirm).toHaveProperty('disabled', false);
    await user.click(confirm);
    expect(onMergePending).toHaveBeenLastCalledWith(
      'u-k-ndlovu',
      'u-a-ngubane',
      '2026-11-08T09:30:00Z',
      {
        phone: 'source',
      },
    );
    expect(screen.getByRole('status').textContent).toMatch(
      /Merged into A\.Ngubane\. Phone replaced: was 0820000001, now 0821112222\./,
    );
  });

  it('rejects a pending registration behind a confirm', async () => {
    const { user, onErase } = setupFull();
    await user.click(tab(/^Pending/));
    await user.click(within(rowOf('K.Ndlovu')).getByRole('button', { name: 'Reject' }));
    expect(onErase).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('pending-reject-confirm'));
    expect(onErase).toHaveBeenCalledWith('u-k-ndlovu');
  });

  it('Delete states the consequences from the preview and needs the typed name', async () => {
    const { user, onErase, loadErasePreview } = setupFull();
    await user.click(within(rowOf('B.Tyali')).getByRole('button', { name: 'Delete' }));
    expect(loadErasePreview).toHaveBeenCalledWith('u-b-tyali');
    const summary = await screen.findByTestId('official-delete-summary');
    expect(summary.textContent).toBe(
      'Their personal details will be permanently erased. They will be removed from 4 upcoming fixtures and 1 today. 12 past appointments and their ratings are kept under “Removed umpire”.',
    );
    const fixtures = screen.getByRole('list', { name: 'Fixtures losing this official' });
    expect(within(fixtures).getAllByRole('listitem')).toHaveLength(2);
    expect(within(fixtures).getByText(/Home CC v Away CC · 15 Nov 2026/)).toBeTruthy();
    expect(screen.getByText('This cannot be undone.')).toBeTruthy();
    const confirm = screen.getByTestId('official-delete-confirm');
    expect(confirm).toHaveProperty('disabled', true);
    await user.type(screen.getByLabelText('Type B.Tyali to confirm'), 'B.Tyal');
    expect(confirm).toHaveProperty('disabled', true);
    await user.type(screen.getByLabelText('Type B.Tyali to confirm'), 'i');
    expect(confirm).toHaveProperty('disabled', false);
    await user.click(confirm);
    expect(onErase).toHaveBeenCalledWith('u-b-tyali');
    expect(screen.getByRole('status').textContent).toMatch(/B\.Tyali deleted/);
  });

  it('offers Delete on merged and inactive rows too', async () => {
    const { user } = setupFull();
    await user.click(tab(/^Inactive/));
    expect(within(rowOf('Old Name')).getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('the registration link modal creates, replaces (with a warning) and turns off the link', async () => {
    const { user, signupLink } = setupFull();
    await user.click(screen.getByRole('button', { name: 'Registration link' }));
    expect((await screen.findByTestId('signup-link-state')).textContent).toMatch(
      /No registration link yet/,
    );
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(signupLink.create).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('Link to share') as HTMLInputElement).value).toBe(
      'https://app.example/officials/register?t=tok1',
    );
    expect(screen.getByTestId('signup-link-state').textContent).toMatch(
      /Link active since 10 Nov 2026/,
    );
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Replace link' }));
    expect(screen.getByText(/The current link stops working straight away/)).toBeTruthy();
    await user.click(screen.getByTestId('signup-link-confirm'));
    expect(signupLink.create).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/The previous link no longer works/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Turn off link' }));
    await user.click(screen.getByTestId('signup-link-confirm'));
    expect(signupLink.revoke).toHaveBeenCalled();
    expect(screen.getByTestId('signup-link-state').textContent).toMatch(/No registration link yet/);
  });

  it('shows an existing link with its created date', async () => {
    const { user } = setupFull({
      signupLink: {
        load: vi.fn().mockResolvedValue({
          url: 'https://app.example/officials/register?t=old',
          createdAt: '2026-10-01T08:00:00Z',
        }),
        create: vi.fn(),
        revoke: vi.fn(),
      },
    });
    await user.click(screen.getByRole('button', { name: 'Registration link' }));
    expect((await screen.findByTestId('signup-link-state')).textContent).toMatch(
      /Link active since 1 Oct 2026/,
    );
  });
});

describe('AdminUmpiresView — stale registrations, merge refusals and the delete preview', () => {
  const PENDING = ERASED_AND_PENDING;
  const base = {
    umpires: PENDING,
    allSeries: [S2],
    onCreate: vi.fn(),
    onPatch: vi.fn(),
    onMerge: vi.fn(),
  };
  const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
  const openPending = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: /^Pending/ }));
  const startMerge = async (user: ReturnType<typeof userEvent.setup>) => {
    await openPending(user);
    await user.click(within(rowOf('K.Ndlovu')).getByRole('button', { name: 'Merge into…' }));
    await user.selectOptions(screen.getByLabelText('Merge K.Ndlovu into'), 'u-a-ngubane');
    await user.click(screen.getByTestId('pending-merge-confirm'));
  };
  const changed = () => new ApiError(409, 'registration changed', 'registration_changed', {});

  it('Approve on a registration the applicant changed says so and keeps it pending', async () => {
    const onApprove = vi.fn().mockRejectedValue(changed());
    const user = userEvent.setup();
    renderWithProviders(<AdminUmpiresView {...base} onApprove={onApprove} />);
    await openPending(user);
    await user.click(within(rowOf('K.Ndlovu')).getByRole('button', { name: 'Approve' }));
    expect(screen.getByRole('alert').textContent).toBe(
      'This registration was updated by the applicant while you were reviewing it. Check the details again before approving.',
    );
    expect(within(rowOf('K.Ndlovu')).getByText('Pending')).toBeTruthy();
  });

  it('Merge on a changed registration closes the picker and the contact dialog', async () => {
    const onMergePending = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(409, 'choose', 'contact_choice_required', {
          conflicts: [{ field: 'phone', source: '0821112222', target: '0820000001' }],
        }),
      )
      .mockRejectedValueOnce(changed());
    const user = userEvent.setup();
    renderWithProviders(<AdminUmpiresView {...base} onMergePending={onMergePending} />);
    await startMerge(user);
    await user.click(screen.getByLabelText(/Use submitted/));
    await user.click(screen.getByTestId('contact-choice-confirm'));
    expect(screen.queryByTestId('contact-choice-dialog')).toBeNull();
    expect(screen.queryByTestId('pending-merge-target')).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/updated by the applicant/);
  });

  it('a sheet-name clash on merge names the existing umpire', async () => {
    const onMergePending = vi.fn().mockRejectedValue(
      new ApiError(409, 'alias taken', 'umpire_alias_taken', {
        umpireId: 'u-s-gasa',
        displayName: 'S.Gasa',
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AdminUmpiresView {...base} onMergePending={onMergePending} />);
    await startMerge(user);
    expect(screen.getByRole('alert').textContent).toMatch(/already used by “S\.Gasa”/);
  });

  it('an empty conflicts list opens no dialog, and a repeat ask after a choice does not loop', async () => {
    const ask = (conflicts: unknown[]) =>
      new ApiError(409, 'choose', 'contact_choice_required', { conflicts });
    const onMergePending = vi
      .fn()
      .mockRejectedValueOnce(ask([]))
      .mockRejectedValueOnce(
        ask([{ field: 'email', source: 'a@example.org', target: 'b@example.org' }]),
      )
      .mockRejectedValueOnce(
        ask([{ field: 'email', source: 'a@example.org', target: 'b@example.org' }]),
      );
    const user = userEvent.setup();
    renderWithProviders(<AdminUmpiresView {...base} onMergePending={onMergePending} />);
    await startMerge(user);
    expect(screen.queryByTestId('contact-choice-dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/could not be matched up/);

    await user.click(screen.getByTestId('pending-merge-confirm'));
    await user.click(screen.getByLabelText(/Keep current/));
    await user.click(screen.getByTestId('contact-choice-confirm'));
    expect(onMergePending).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId('contact-choice-dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/could not be matched up/);
  });

  it('Delete loads the preview once across re-renders; a failed load keeps Delete disabled until Retry', async () => {
    const preview = {
      vacated: [],
      counts: { today: 0, upcoming: 0, played: 1 },
    };
    const first = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(preview);
    const user = userEvent.setup();
    const props = { ...base, onErase: vi.fn().mockResolvedValue({}) };
    const { rerender } = renderWithProviders(
      <AdminUmpiresView {...props} loadErasePreview={(id) => first(id)} />,
    );
    await user.click(within(rowOf('B.Tyali')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/Could not check their appointments/)).toBeTruthy();
    // A new handler identity on every parent render must not refetch.
    rerender(<AdminUmpiresView {...props} loadErasePreview={(id) => first(id)} />);
    rerender(<AdminUmpiresView {...props} loadErasePreview={(id) => first(id)} />);
    expect(first).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('official-delete-confirm')).toHaveProperty('disabled', true);

    await user.click(screen.getByTestId('official-delete-retry'));
    expect(await screen.findByTestId('official-delete-summary')).toBeTruthy();
    expect(first).toHaveBeenCalledTimes(2);
    await user.type(screen.getByTestId('official-delete-typed'), 'B.Tyali');
    expect(screen.getByTestId('official-delete-confirm')).toHaveProperty('disabled', false);
  });

  it('the Pending tab explains Approve and Merge instead of the merge footnote', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminUmpiresView {...base} />);
    expect(screen.getByText(/Merging moves every appointment/)).toBeTruthy();
    await openPending(user);
    expect(screen.queryByText(/Merging moves every appointment/)).toBeNull();
    expect(
      screen.getByText(/Approve adds the person to the register\. Merge into… adds their details/),
    ).toBeTruthy();
  });
});
