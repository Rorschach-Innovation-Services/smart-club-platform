/**
 * StructuresCard — the stage pipeline editor and its preview rail.
 *
 * The preview rail is the whole affordance of this screen: it is where an operator finds
 * out that 11 rounds every two weeks does not fit a 13-week block, BEFORE anyone presses
 * generate. Three of its arithmetic bugs shipped and were caught by review, all of the
 * same shape — a count re-derived by hand instead of asked of the real generator:
 *
 *   - `perGroup - 1` previewed a six-team single-match stage as five fixtures
 *   - the first group's count × the number of groups read 5,5,5,4 as 80, not 72
 *   - a group of 0 or 1 read "✓ Fits", because the TOTAL was comfortably non-zero
 *
 * Each has a test below. They assert on the rendered sentence an operator actually reads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StructuresCard } from './platform-structures';
import type { CompetitionStructure, SeasonCalendar, TenantConfig } from './types';
import * as api from './api';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, platformGetTenant: vi.fn() };
});

const calendar: SeasonCalendar = {
  id: 'cal',
  label: '2026/27',
  blocks: [
    { id: 'b1', label: 'Block 1', start: '2026-09-12', end: '2026-12-12' },
    { id: 'b2', label: 'Block 2', start: '2027-01-16', end: '2027-03-27' },
  ],
  breaks: [{ label: 'Festive break', start: '2026-12-13', end: '2027-01-15' }],
  excludeDates: [],
};

const structure = (over: Partial<CompetitionStructure> = {}): CompetitionStructure =>
  ({
    id: 'flat',
    name: 'Flat round robin',
    version: 1,
    calendarId: 'cal',
    stages: [
      {
        id: 's1',
        name: 'League',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'all-registered' },
        schedule: { blockId: 'b1', cadence: { kind: 'weekly' } },
      },
    ],
    ...over,
  }) as CompetitionStructure;

const setup = (structures: CompetitionStructure[] = [structure()]) => {
  const save = vi.fn().mockResolvedValue({});
  const toast = vi.fn();
  const user = userEvent.setup();
  const config = { structures, calendars: [calendar] } as unknown as TenantConfig;
  vi.mocked(api.platformGetTenant).mockResolvedValue(config);
  render(<StructuresCard slug="dolphins" config={config} save={save} toast={toast} />);
  return { user, save, toast };
};

const openEditor = async (user: ReturnType<typeof userEvent.setup>, name = /flat round robin/i) =>
  user.click(within(screen.getByRole('row', { name })).getByText(/edit/i));

/** The preview rail's "teams entered" box. */
const teamsBox = () => screen.getAllByRole('spinbutton')[0];
const preview = () => screen.getByText(/^Preview$/i).parentElement!;

beforeEach(() => vi.clearAllMocks());

describe('preview rail — fixture counts come from the real generator', () => {
  it('counts a single-match stage as one fixture, not entrants minus one', async () => {
    const { user } = setup([
      structure({
        stages: [
          {
            id: 's1',
            name: 'Final',
            format: { kind: 'single-match' },
            entrants: { kind: 'all-registered' },
            schedule: { blockId: 'b2', cadence: { kind: 'weekly' } },
          },
        ],
      } as Partial<CompetitionStructure>),
    ]);
    await openEditor(user);

    await user.clear(teamsBox());
    await user.type(teamsBox(), '6');

    // `perGroup - 1` said five. A single match is one match.
    expect(within(preview()).getByText(/1 fixture(?!s)/)).toBeVisible();
  });

  it('sums uneven groups per group, not first-group × count', async () => {
    const { user } = setup([
      structure({
        stages: [
          {
            id: 's1',
            name: 'Pools',
            format: { kind: 'round-robin', legs: 2 },
            entrants: {
              kind: 'seeded-split',
              method: 'blocks',
              groups: { kind: 'sizes', sizes: [5, 5, 5, 4] },
            },
            schedule: { blockId: 'b1', cadence: { kind: 'weekly' } },
          },
        ],
      } as Partial<CompetitionStructure>),
    ]);
    await openEditor(user);

    await user.clear(teamsBox());
    await user.type(teamsBox(), '19');

    // 20 + 20 + 20 + 12 = 72. Multiplying the first group out gives 80.
    // Both the stage row and the grand total say it, which is itself the point.
    expect(within(preview()).getAllByText(/72 fixtures/).length).toBeGreaterThan(0);
    expect(within(preview()).queryByText(/80 fixtures/)).toBeNull();
  });

  it('refuses to call a stage with a one-team group a fit', async () => {
    const { user } = setup([
      structure({
        stages: [
          {
            id: 's1',
            name: 'Pools',
            format: { kind: 'round-robin', legs: 1 },
            entrants: {
              kind: 'seeded-split',
              method: 'blocks',
              groups: { kind: 'sizes', sizes: [5, 5, 5, 4] },
            },
            schedule: { blockId: 'b1', cadence: { kind: 'weekly' } },
          },
        ],
      } as Partial<CompetitionStructure>),
    ]);
    await openEditor(user);

    // 12 teams reconciled against 5,5,5,4 leaves a group of nobody. The grand total is
    // comfortably non-zero, which is exactly why the old check said "✓ Fits".
    await user.clear(teamsBox());
    await user.type(teamsBox(), '12');

    expect(within(preview()).getByText(/a group needs at least two teams/i)).toBeVisible();
    expect(within(preview()).queryByText(/✓ Fits/)).toBeNull();
  });

  it('exempts a by-hand stage, which generates nothing by design', async () => {
    const { user } = setup([
      structure({
        stages: [
          {
            id: 's1',
            name: 'Cup',
            format: { kind: 'manual' },
            entrants: { kind: 'manual' },
            schedule: { blockId: 'b1', cadence: { kind: 'weekly' } },
          },
        ],
      } as Partial<CompetitionStructure>),
    ]);
    await openEditor(user);

    expect(within(preview()).getByText(/fixtures entered by hand/i)).toBeVisible();
    expect(within(preview()).getByText(/✓ Fits/)).toBeVisible();
  });

  it('labels a cross-pool round count as an upper bound', async () => {
    // Nothing in the structure says how many qualify, so the number is worst-case.
    // Unlabelled, an operator reads it as the real round count.
    const { user } = setup([
      structure({
        stages: [
          {
            id: 's1',
            name: 'Semis',
            format: { kind: 'knockout', pairing: 'cross-pool' },
            entrants: { kind: 'manual' },
            schedule: { blockId: 'b2', cadence: { kind: 'weekly' } },
          },
        ],
      } as Partial<CompetitionStructure>),
    ]);
    await openEditor(user);

    expect(within(preview()).getByText(/sized by how many qualify/i)).toBeVisible();
  });
});

describe('preview rail — calendar fit', () => {
  it('flags a cadence that overruns its block before anything is generated', async () => {
    // The EMCU Division 4 problem: 11 rounds every two weeks is 22 weeks, and Block 1
    // is 13. Generation would silently produce a short season.
    const { user } = setup([
      structure({
        stages: [
          {
            id: 's1',
            name: 'League',
            format: { kind: 'round-robin', legs: 1 },
            entrants: { kind: 'all-registered' },
            schedule: { blockId: 'b1', cadence: { kind: 'every-n-weeks', n: 2 } },
          },
        ],
      } as Partial<CompetitionStructure>),
    ]);
    await openEditor(user);

    await user.clear(teamsBox());
    await user.type(teamsBox(), '12');

    expect(within(preview()).getByText(/don’t fit their block|doesn’t fit/i)).toBeVisible();
  });

  it('says fit cannot be checked with no calendar selected', async () => {
    const { user } = setup([structure({ calendarId: undefined })]);
    await openEditor(user);

    await user.selectOptions(screen.getByRole('combobox', { name: /preview against/i }), '');

    expect(within(preview()).getByText(/fit can't be checked until one is/i)).toBeVisible();
  });
});

describe('structure editor — the design-time calendar', () => {
  it('persists the calendar the blocks were authored against', async () => {
    const { user, save } = setup([structure({ calendarId: undefined })]);
    await openEditor(user);

    await user.selectOptions(screen.getByRole('combobox', { name: /preview against/i }), 'cal');
    await user.click(screen.getByRole('button', { name: /save structure/i }));

    expect(save.mock.calls[0][0].structures[0]).toMatchObject({ calendarId: 'cal' });
  });

  it('CLEARS the calendar when the operator picks "No calendar"', async () => {
    // A bare `...(calendarId ? {calendarId} : {})` keeps the value already on the draft,
    // so the picker could set but never unset.
    const { user, save } = setup([structure({ calendarId: 'cal' })]);
    await openEditor(user);

    await user.selectOptions(screen.getByRole('combobox', { name: /preview against/i }), '');
    await user.click(screen.getByRole('button', { name: /save structure/i }));

    expect(save.mock.calls[0][0].structures[0]).not.toHaveProperty('calendarId');
  });

  it('mints a new version on every edit, so running seasons are untouched', async () => {
    const { user, save } = setup([structure({ version: 3 })]);
    await openEditor(user);
    await user.click(screen.getByRole('button', { name: /save structure/i }));

    expect(save.mock.calls[0][0].structures[0].version).toBe(4);
  });
});

describe('structure editor — validation', () => {
  it('refuses a structure with no name', async () => {
    const { user, save } = setup([structure({ name: '' })]);
    await openEditor(user, /untitled|edit/i);

    await user.click(screen.getByRole('button', { name: /save structure/i }));
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a stage that draws from a stage after it', async () => {
    const { user, save } = setup([
      structure({
        stages: [
          {
            id: 's1',
            name: 'First',
            format: { kind: 'round-robin', legs: 1 },
            entrants: {
              kind: 'manual',
              derivedFrom: { rule: 'swap', fromStage: 's2', detail: 'Swap' },
            },
            schedule: { blockId: 'b1', cadence: { kind: 'weekly' } },
          },
          {
            id: 's2',
            name: 'Second',
            format: { kind: 'round-robin', legs: 1 },
            entrants: { kind: 'all-registered' },
            schedule: { blockId: 'b2', cadence: { kind: 'weekly' } },
          },
        ],
      } as Partial<CompetitionStructure>),
    ]);
    await openEditor(user);

    expect(screen.getByText(/draws from a stage that doesn't come before it/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /save structure/i }));
    expect(save).not.toHaveBeenCalled();
  });
});
