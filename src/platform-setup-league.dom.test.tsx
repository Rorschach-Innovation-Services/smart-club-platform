/**
 * SetupLeagueDialog — one league's one setup (structure + calendar).
 *
 * The trap it exists to close: the old binding modal defaulted the structure and the
 * calendar to the library's first entries, and a hurried Save bound a league to the wrong
 * season. Both choices start EMPTY here and Save waits for both.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetupLeagueDialog } from './platform-setup-league';
import type { CompetitionStructure, League, SeasonCalendar, TenantConfig } from './types';
import * as api from './api';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, platformGetTenant: vi.fn() };
});

const calendar = (id: string, label: string, blocks = 2): SeasonCalendar => ({
  id,
  label,
  blocks: [
    { id: `${id}-b1`, label: 'Block 1', start: '2026-09-12', end: '2026-12-12' },
    { id: `${id}-b2`, label: 'Block 2', start: '2027-01-16', end: '2027-03-27' },
  ].slice(0, blocks),
  breaks: [],
  excludeDates: [],
});

const stage = (id: string, blockIndex: number) => ({
  id,
  name: `Stage ${id}`,
  format: { kind: 'round-robin', legs: 1 },
  entrants: { kind: 'all-registered' },
  schedule: { blockIndex, cadence: { kind: 'weekly' } },
});

const flat = {
  id: 'flat',
  name: 'Flat league',
  version: 1,
  stages: [stage('s1', 0)],
} as unknown as CompetitionStructure;
const split = {
  id: 'split',
  name: 'Split league',
  version: 1,
  stages: [stage('s1', 0), stage('s2', 1)],
} as unknown as CompetitionStructure;

const premier = (over: Partial<League> = {}): League =>
  ({ key: 'premier', label: 'Premier Men', group: 'Senior', district: 'All', ...over }) as League;

const setup = (config: Partial<TenantConfig>, lg: League = premier()) => {
  const full = {
    tenant: 'dolphins',
    leagues: [lg],
    calendars: [calendar('cal', '2026/27')],
    structures: [flat],
    ...config,
  } as unknown as TenantConfig;
  vi.mocked(api.platformGetTenant).mockResolvedValue(full);
  const save = vi.fn().mockResolvedValue(full);
  const toast = vi.fn();
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <SetupLeagueDialog
      slug="dolphins"
      config={full}
      league={lg}
      save={save}
      toast={toast}
      onClose={onClose}
    />,
  );
  return { user, save, toast, onClose };
};

const saveBtn = () => screen.getByRole('button', { name: /save setup/i });
const calendarPicker = () => screen.getByRole('combobox', { name: 'Season calendar' });
const useExisting = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('radio', { name: /use an existing structure/i }));
const structurePicker = () => screen.getByRole('combobox', { name: /structure for premier men/i });

beforeEach(() => vi.clearAllMocks());

describe('SetupLeagueDialog — nothing preselected', () => {
  it('starts with no structure and no calendar, and Save waits for both', async () => {
    const { user } = setup({});

    for (const card of within(
      screen.getByRole('radiogroup', { name: /where premier men's structure comes from/i }),
    ).getAllByRole('radio'))
      expect(card).not.toBeChecked();
    expect(calendarPicker()).toHaveValue('');
    expect(saveBtn()).toBeDisabled();

    await useExisting(user);
    expect(structurePicker()).toHaveValue('');
    await user.selectOptions(structurePicker(), 'flat');
    expect(saveBtn()).toBeDisabled();

    await user.selectOptions(calendarPicker(), 'cal');
    expect(saveBtn()).toBeEnabled();
    expect(screen.getByText('✓ Fits the calendar')).toBeInTheDocument();
  });

  it('writes only league.setup, rebuilt from a fresh read', async () => {
    const { user, save, onClose } = setup({});
    await useExisting(user);
    await user.selectOptions(structurePicker(), 'flat');
    await user.selectOptions(calendarPicker(), 'cal');
    await user.click(saveBtn());

    expect(api.platformGetTenant).toHaveBeenCalledWith('dolphins');
    const patch = save.mock.calls[0][0];
    expect(patch).not.toHaveProperty('structures');
    expect(patch.leagues[0].setup).toEqual({ structureId: 'flat', calendarId: 'cal' });
    expect(patch.leagues[0]).not.toHaveProperty('competitions');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('SetupLeagueDialog — structures', () => {
  it('mints a template instance, with "plays in" choices on a two-block calendar', async () => {
    const { user, save } = setup({ structures: [] });
    await user.click(screen.getByRole('radio', { name: /start from a template/i }));
    await user.click(screen.getByRole('radio', { name: /split league with mid-season swap/i }));
    await user.selectOptions(calendarPicker(), 'cal');

    const stage2 = screen.getByRole('combobox', { name: 'Stage 2 plays in' });
    expect(stage2).toHaveValue('1');
    await user.selectOptions(stage2, '0');
    await user.click(saveBtn());

    const patch = save.mock.calls[0][0];
    expect(patch.structures).toHaveLength(1);
    const minted = patch.structures[0];
    expect(minted.stages[1].schedule.blockIndex).toBe(0);
    expect(patch.leagues[0].setup).toEqual({ structureId: minted.id, calendarId: 'cal' });
  });

  it('lists quick-start and migrated structures in their own groups, and clones on adopt', async () => {
    const qs = { ...flat, id: 'qs', name: 'Quick-started', source: 'quick-start' };
    const mig = { ...flat, id: 'mig', name: 'Migrated', source: 'migration' };
    const { user, save } = setup({ structures: [flat, qs, mig] as CompetitionStructure[] });
    await useExisting(user);

    const picker = structurePicker();
    const quick = within(picker).getByRole('group', { name: 'Created by admin quick start' });
    expect(within(quick).getByRole('option', { name: 'Quick-started' })).toBeInTheDocument();
    const migrated = within(picker).getByRole('group', { name: 'Migrated flat seasons' });
    expect(within(migrated).getByRole('option', { name: 'Migrated' })).toBeInTheDocument();
    expect(within(picker).getByRole('option', { name: 'Flat league' }).parentElement).toBe(picker);

    await user.selectOptions(picker, 'qs');
    await user.selectOptions(calendarPicker(), 'cal');
    await user.click(saveBtn());
    const patch = save.mock.calls[0][0];
    const clone = patch.structures[patch.structures.length - 1];
    expect(clone.name).toBe('Premier Men · Quick-started');
    expect(clone).not.toHaveProperty('source');
    expect(patch.leagues[0].setup.structureId).toBe(clone.id);
  });

  it('blocks Save on a structure that plays past the calendar, with the red line', async () => {
    const { user, save } = setup({
      structures: [split],
      calendars: [calendar('one', 'One block', 1)],
    });
    await useExisting(user);
    await user.selectOptions(structurePicker(), 'split');
    await user.selectOptions(calendarPicker(), 'one');

    expect(
      screen.getByText(
        'Split league plays in Block 2 but this calendar has only 1 block — extend the calendar or choose differently',
      ),
    ).toBeVisible();
    expect(saveBtn()).toBeDisabled();
    await user.click(saveBtn());
    expect(save).not.toHaveBeenCalled();
  });

  it('warns about a block the structure leaves empty and still saves', async () => {
    const { user, save } = setup({});
    await useExisting(user);
    await user.selectOptions(structurePicker(), 'flat');
    await user.selectOptions(calendarPicker(), 'cal');

    expect(screen.getByText(/^Block 2 \(.*\) has no stage playing in it$/)).toBeVisible();
    await user.click(saveBtn());
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('SetupLeagueDialog — changing a setup', () => {
  const current = { structureId: 'flat', calendarId: 'old' };
  const calendars = [calendar('cal', '2026/27'), calendar('old', '2025/26')];

  it('names what a different choice replaces', async () => {
    const { user } = setup({ calendars }, premier({ setup: current }));

    expect(screen.getByRole('dialog', { name: 'Change setup · Premier Men' })).toBeInTheDocument();
    expect(screen.getByText('Flat league · 2025/26', { selector: 'strong' })).toBeInTheDocument();
    await useExisting(user);
    await user.selectOptions(structurePicker(), 'flat');
    await user.selectOptions(calendarPicker(), 'cal');

    expect(screen.getByTestId('replaces-line')).toHaveTextContent(
      'Replaces the current setup: Flat league · 2025/26',
    );
    expect(saveBtn()).toBeEnabled();
  });

  it('keeps Save disabled when the choice is the setup the league already has', async () => {
    const { user } = setup({ calendars }, premier({ setup: current }));
    await useExisting(user);
    await user.selectOptions(structurePicker(), 'flat');
    await user.selectOptions(calendarPicker(), 'old');

    expect(screen.queryByTestId('replaces-line')).toBeNull();
    expect(screen.getByText('This is already Premier Men’s setup.')).toBeInTheDocument();
    expect(saveBtn()).toBeDisabled();
  });
});

describe('SetupLeagueDialog — closing', () => {
  it('a backdrop click never closes it, and Escape asks before discarding a choice', async () => {
    const { user, onClose } = setup({});
    await useExisting(user);

    await user.click(document.querySelector('.task-modal-backdrop') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(screen.getByText('Discard your changes?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('radio', { name: /use an existing structure/i })).toBeChecked();
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes at once when nothing has been chosen', async () => {
    const { user, onClose } = setup({});
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
