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
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StructuresCard } from './platform-structures';
import type { CompetitionStructure, League, SeasonCalendar, TenantConfig } from './types';
import * as api from './api';
import { ApiError } from './api';

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

/**
 * `blockIndex` is a bare position into whichever calendar the editor previews against —
 * a structure carries no calendar identity of its own (ADR 0008 Phase 1). Index 0/1 lands
 * on `calendar`'s two blocks, and on `otherCalendar`'s (also two blocks) alike.
 */
const structure = (over: Partial<CompetitionStructure> = {}): CompetitionStructure =>
  ({
    id: 'flat',
    name: 'Flat round robin',
    version: 1,
    stages: [
      {
        id: 's1',
        name: 'League',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'all-registered' },
        schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
      },
    ],
    ...over,
  }) as CompetitionStructure;

/**
 * A second calendar with the same LABELS as `calendar`'s blocks but a different id and
 * different dates — enough to prove the preview rail is reading the previewed calendar's
 * own blocks, not carrying over the first one's.
 */
const otherCalendar: SeasonCalendar = {
  id: 'other',
  label: 'test',
  blocks: [
    { id: 'x1', label: 'Block 1', start: '2026-09-27', end: '2026-11-01' },
    { id: 'x2', label: 'Block 2', start: '2026-11-08', end: '2026-12-06' },
  ],
  breaks: [],
  excludeDates: [],
};

/** One block only — switching the preview here strands any stage scheduled at position 1. */
const smallCalendar: SeasonCalendar = {
  id: 'small',
  label: 'One block only',
  blocks: [{ id: 'y1', label: 'Block 1', start: '2026-09-12', end: '2026-12-12' }],
  breaks: [],
  excludeDates: [],
};

const setup = (
  structures: CompetitionStructure[] = [structure()],
  opts: { calendars?: SeasonCalendar[]; leagues?: League[] } = {},
) => {
  const save = vi.fn().mockResolvedValue({});
  const toast = vi.fn();
  const user = userEvent.setup();
  const config = {
    structures,
    calendars: opts.calendars ?? [calendar],
    leagues: opts.leagues ?? [],
  } as unknown as TenantConfig;
  vi.mocked(api.platformGetTenant).mockResolvedValue(config);
  render(<StructuresCard slug="dolphins" config={config} save={save} toast={toast} />);
  return { user, save, toast };
};

/** Two stages on two different blocks — both in range on either fixture calendar. */
const twoStage = (): CompetitionStructure =>
  structure({
    id: 'split',
    name: 'Split league',
    stages: [
      {
        id: 's1',
        name: 'Double round',
        format: { kind: 'round-robin', legs: 2 },
        entrants: { kind: 'all-registered' },
        schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
      },
      {
        id: 's2',
        name: 'Final round',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'all-registered' },
        schedule: { blockIndex: 1, cadence: { kind: 'weekly' } },
      },
    ],
  } as Partial<CompetitionStructure>);

/** A league binding `structureId` to `calendarId`, as the competition editor writes it. */
const boundLeague = (structureId: string, calendarId: string): League =>
  ({
    key: 'premier',
    label: 'Premier Men',
    competitions: [{ id: 'c1', label: '50 Over', structureId, calendarId }],
  }) as unknown as League;

/** The "Show dates from" calendar picker. */
const previewPicker = () => screen.getByRole('combobox', { name: /show dates from/i });
/** A stage's playing-block picker. */
const blockPicker = () => screen.getAllByRole('combobox', { name: /playing block/i })[0];
const saveBtn = () => screen.getByRole('button', { name: /save structure/i });

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
            schedule: { blockIndex: 1, cadence: { kind: 'weekly' } },
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
            schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
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
            schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
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
            schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
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
            schedule: { blockIndex: 1, cadence: { kind: 'weekly' } },
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
            schedule: { blockIndex: 0, cadence: { kind: 'every-n-weeks', n: 2 } },
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
    // With only one calendar on the tenant, the editor auto-resolves it — deliberately
    // clear the picker to reach the "no calendar" state.
    const { user } = setup([structure()]);
    await openEditor(user);

    await user.selectOptions(screen.getByRole('combobox', { name: /show dates from/i }), '');

    expect(within(preview()).getByText(/fit can't be checked until one is/i)).toBeVisible();
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
            schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
          },
          {
            id: 's2',
            name: 'Second',
            format: { kind: 'round-robin', legs: 1 },
            entrants: { kind: 'all-registered' },
            schedule: { blockIndex: 1, cadence: { kind: 'weekly' } },
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

/* ─────────────────────────────────────────────────────────────────────────────
   StageRow — Time slots control.

   Turning it on writes the T20 morning/afternoon defaults onto the stage's schedule;
   turning it off removes the `slots` key entirely (not `[]`) — the planner and server
   both treat an absent key as "no slots", so an empty array would be a different,
   invalid state, not merely an empty one.
   ───────────────────────────────────────────────────────────────────────────── */

describe('StageRow — Time slots', () => {
  const timeSlotsChoice = () =>
    screen.getByText('Time slots').parentElement!.querySelector('.seg') as HTMLElement;

  it('turning it ON populates two rows prefilled with the T20 defaults, and saves them', async () => {
    const { user, save } = setup([structure()]);
    await openEditor(user);

    await user.click(
      within(timeSlotsChoice()).getByRole('button', { name: 'Morning & afternoon starts' }),
    );

    const labels = screen.getAllByPlaceholderText('Morning') as HTMLInputElement[];
    expect(labels).toHaveLength(2);
    expect(labels[0]).toHaveValue('Morning');
    expect(labels[1]).toHaveValue('Afternoon');
    const times = screen.getAllByDisplayValue('08:00');
    expect(times).toHaveLength(1);
    expect(screen.getAllByDisplayValue('13:30')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /save structure/i }));

    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0][0].structures[0];
    expect(saved.stages[0].schedule.slots).toEqual([
      { label: 'Morning', start: '08:00' },
      { label: 'Afternoon', start: '13:30' },
    ]);
    expect('roundsPerDay' in saved.stages[0].schedule).toBe(false);
  });

  it('editing a row’s label and time round-trips into the saved structure', async () => {
    const { user, save } = setup([structure()]);
    await openEditor(user);

    await user.click(
      within(timeSlotsChoice()).getByRole('button', { name: 'Morning & afternoon starts' }),
    );

    const labels = screen.getAllByPlaceholderText('Morning') as HTMLInputElement[];
    await user.clear(labels[0]);
    await user.type(labels[0], 'Early');
    const morningTime = screen.getByDisplayValue('08:00') as HTMLInputElement;
    fireEvent.change(morningTime, { target: { value: '09:00' } });

    await user.click(screen.getByRole('button', { name: /save structure/i }));

    const saved = save.mock.calls[0][0].structures[0];
    expect(saved.stages[0].schedule.slots).toEqual([
      { label: 'Early', start: '09:00' },
      { label: 'Afternoon', start: '13:30' },
    ]);
  });

  it('turning it OFF removes the slots key entirely, not an empty array', async () => {
    const { user, save } = setup([
      structure({
        stages: [
          {
            id: 's1',
            name: 'League',
            format: { kind: 'round-robin', legs: 1 },
            entrants: { kind: 'all-registered' },
            schedule: {
              blockIndex: 0,
              cadence: { kind: 'weekly' },
              slots: [
                { label: 'Morning', start: '08:00' },
                { label: 'Afternoon', start: '13:30' },
              ],
            },
          },
        ],
      } as Partial<CompetitionStructure>),
    ]);
    await openEditor(user);

    await user.click(within(timeSlotsChoice()).getByRole('button', { name: 'No set times' }));
    await user.click(screen.getByRole('button', { name: /save structure/i }));

    const saved = save.mock.calls[0][0].structures[0];
    expect('slots' in saved.stages[0].schedule).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Which calendar the editor previews against.

   A structure carries no calendar identity of its own any more (Phase 1 deleted
   `CompetitionStructure.calendarId`), so there is nothing stored to reopen against:
   only the tenant's own single calendar, or a bound competition's calendar, can say
   which one to preview. `resolvePreviewCalendarId` in platform-structures.tsx is the
   pure function behind this; these pin what the editor actually renders from it.
   ───────────────────────────────────────────────────────────────────────────── */

describe('resolving which calendar to preview against', () => {
  it('auto-selects the tenant’s only calendar', async () => {
    const { user } = setup([structure()], { calendars: [calendar] });
    await openEditor(user);
    expect(previewPicker()).toHaveValue('cal');
  });

  it('auto-selects the calendar a bound competition names, when there is more than one', async () => {
    const { user } = setup([structure()], {
      calendars: [calendar, otherCalendar],
      leagues: [boundLeague('flat', 'other')],
    });
    await openEditor(user);
    expect(previewPicker()).toHaveValue('other');
  });

  it('resolves nothing when there are several calendars and no binding to prefer', async () => {
    const { user } = setup([structure()], { calendars: [calendar, otherCalendar] });
    await openEditor(user);
    expect(previewPicker()).toHaveValue('');
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   The refusal banner — simplified to two branches now that a `blockIndex` has no
   cross-calendar identity to remap by: either the editor can't tell which calendar to
   preview against ("pick one"), or it can and some stage's position doesn't exist on
   it ("bound elsewhere" when a competition names a different calendar, else "pick each
   stage's block by hand"). There is no more "Move to X" remap — that depended on the
   old id-based blockId matching same-named blocks across calendars, which the index
   model deliberately has no equivalent of.
   ───────────────────────────────────────────────────────────────────────────── */

describe('the refusal banner — nothing resolved', () => {
  it('asks the operator to pick a calendar, naming each stage’s stranded position', async () => {
    const { user } = setup([structure()], { calendars: [calendar, otherCalendar] });
    await openEditor(user);

    // The sentence wraps a `<strong>Show dates from</strong>` — Testing Library's default
    // text matcher only concatenates a node's own direct text children, so the assertion
    // stays on either side of that boundary rather than spanning it. "Show dates from"
    // also names the field label and the combobox, hence getAllByText over getByText.
    expect(screen.getByText(/pick a calendar under/i)).toBeInTheDocument();
    expect(screen.getAllByText(/show dates from/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/League.*position 1/i)).toBeInTheDocument();
  });

  it('does not block saving while the question is still open', async () => {
    const { user, save } = setup([structure()], { calendars: [calendar, otherCalendar] });
    await openEditor(user);
    expect(saveBtn()).toBeEnabled();
    await user.click(saveBtn());
    expect(save).toHaveBeenCalled();
  });
});

describe('the refusal banner — a resolved calendar can’t place every stage', () => {
  /** Out of range for every fixture calendar here (both have two blocks, indices 0/1). */
  const strandedStage = structure({
    stages: [
      {
        id: 's1',
        name: 'League',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'all-registered' },
        schedule: { blockIndex: 5, cadence: { kind: 'weekly' } },
      },
    ],
  } as Partial<CompetitionStructure>);

  it('names the bound competition and offers a way out, when this structure is bound', async () => {
    const { user } = setup([strandedStage], {
      calendars: [calendar, otherCalendar],
      leagues: [boundLeague('flat', 'other')],
    });
    await openEditor(user);

    expect(previewPicker()).toHaveValue('other');
    expect(screen.getByText(/plays a\s*block position/i)).toBeInTheDocument();
    // Named both in the "Used by" column and the banner's own explanation.
    expect(screen.getAllByText(/50 Over \(Premier Men\)/i).length).toBeGreaterThan(0);
  });

  it('tells the operator to pick each stage’s block by hand, when nothing binds it', async () => {
    const { user } = setup([strandedStage], { calendars: [calendar] });
    await openEditor(user);

    expect(previewPicker()).toHaveValue('cal');
    expect(screen.getByText(/pick each stage.s block by hand/i)).toBeInTheDocument();
  });

  it('keeps the stage’s own position selectable, rather than falling back to a placeholder', async () => {
    const { user } = setup([strandedStage], { calendars: [calendar] });
    await openEditor(user);

    const picker = blockPicker() as HTMLSelectElement;
    expect(picker).toHaveValue('5');
    expect(picker.options[picker.selectedIndex].text).toMatch(
      /sixth block.*this calendar has fewer blocks/i,
    );
  });
});

describe('the playing-block picker — ordinal labels', () => {
  it('shows each block’s ordinal position, label and dates once a calendar is chosen', async () => {
    const { user } = setup([structure()], { calendars: [calendar] });
    await openEditor(user);

    const picker = blockPicker() as HTMLSelectElement;
    const texts = [...picker.options].map((o) => o.text);
    expect(texts).toContain('First block — Block 1 · 12 Sep 2026 → 12 Dec 2026');
    expect(texts).toContain('Second block — Block 2 · 16 Jan 2027 → 27 Mar 2027');
  });

  it('falls back to a plain ordinal with no calendar to read dates from', async () => {
    // Two calendars and no binding — resolution can't pick one (see "resolving which
    // calendar to preview against"), so the picker has nothing to read block dates off.
    const { user } = setup([structure()], { calendars: [calendar, otherCalendar] });
    await openEditor(user);
    expect(previewPicker()).toHaveValue('');

    const picker = blockPicker() as HTMLSelectElement;
    expect(picker.options[picker.selectedIndex].text).toBe('First block');
  });
});

describe('a structure left split across calendars in this session', () => {
  /** Both stages at position 1 — out of range on `smallCalendar` (one block), uniformly. */
  const bothOffSmall = (): CompetitionStructure =>
    structure({
      id: 'split',
      name: 'Split league',
      stages: [
        {
          id: 's1',
          name: 'Double round',
          format: { kind: 'round-robin', legs: 2 },
          entrants: { kind: 'all-registered' },
          schedule: { blockIndex: 1, cadence: { kind: 'weekly' } },
        },
        {
          id: 's2',
          name: 'Final round',
          format: { kind: 'round-robin', legs: 1 },
          entrants: { kind: 'all-registered' },
          schedule: { blockIndex: 1, cadence: { kind: 'weekly' } },
        },
      ],
    } as Partial<CompetitionStructure>);

  it('refuses to save when the operator half-fixes a uniformly-stranded structure', async () => {
    // Both stages start off `smallCalendar`, consistently — not a split, just entirely
    // pointed elsewhere. Repicking ONLY the first stage's block onto `smallCalendar`
    // (its one available option) leaves the second stranded — a split created by THIS
    // edit, which no calendar can run.
    const { user, save } = setup([bothOffSmall()], { calendars: [calendar, smallCalendar] });
    await openEditor(user, /split league/i);
    await user.selectOptions(previewPicker(), 'small');
    expect(screen.queryByText(/split across calendars/i)).toBeNull(); // uniform, not split

    await user.selectOptions(blockPicker(), '0');

    expect(screen.getByText(/split across calendars/i)).toBeInTheDocument();
    expect(saveBtn()).toBeDisabled();
    await user.click(saveBtn());
    expect(save).not.toHaveBeenCalled();
  });

  it('does not block a structure that ARRIVED split, only one split in this session', async () => {
    // `twoStage` already has one stage in range on `smallCalendar` and one out of it —
    // split from the moment the preview lands there, with no edit at all. Pre-existing
    // damage is a warning, not a save gate: blocking on arrival would stop an operator
    // renaming the structure or fixing a cadence until they had first edited a stage
    // they never came here to touch.
    const { user, save } = setup([twoStage()], { calendars: [calendar, smallCalendar] });
    await openEditor(user, /split league/i);
    await user.selectOptions(previewPicker(), 'small');

    expect(screen.queryByText(/split across calendars/i)).toBeNull();
    expect(saveBtn()).toBeEnabled();
    await user.click(saveBtn());
    expect(save).toHaveBeenCalled();
  });
});

describe('the structures list — the mismatch is visible before opening', () => {
  it('names the calendar the bound competitions run on', async () => {
    setup([structure()], { calendars: [calendar], leagues: [boundLeague('flat', 'cal')] });
    const row = screen.getByRole('row', { name: /flat round robin/i });
    expect(within(row).getByText('2026/27')).toBeInTheDocument();
  });

  it('flags a structure whose blocks are not on its bound calendar', async () => {
    const stranded = structure({
      stages: [
        {
          id: 's1',
          name: 'League',
          format: { kind: 'round-robin', legs: 1 },
          entrants: { kind: 'all-registered' },
          // Out of range for `otherCalendar` (two blocks, indices 0/1) — the bound one.
          schedule: { blockIndex: 5, cadence: { kind: 'weekly' } },
        },
      ],
    } as Partial<CompetitionStructure>);
    setup([stranded], {
      calendars: [calendar, otherCalendar],
      leagues: [boundLeague('flat', 'other')],
    });
    const row = screen.getByRole('row', { name: /flat round robin/i });
    // Highest position used is 5 (0-based), so the structure needs 6 blocks; the bound
    // calendar (`otherCalendar`) only has 2.
    expect(within(row).getByText(/needs 6 blocks, calendar has 2/i)).toBeInTheDocument();
  });

  it('leaves a well-formed structure unflagged', async () => {
    setup([structure()], { calendars: [calendar], leagues: [boundLeague('flat', 'cal')] });
    const row = screen.getByRole('row', { name: /flat round robin/i });
    expect(within(row).queryByText(/needs \d+ blocks/i)).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Deleting a structure bound by a league's competition (StructuresCard's `onDelete`,
   platform-structures.tsx ~:1553). The server 409s a delete while any league still binds
   the structure, so the binding is stripped in the SAME PUT — but only the competition
   pointing at the deleted structure, not every competition the league runs.
   ───────────────────────────────────────────────────────────────────────────── */

describe('StructuresCard — deleting a bound structure cascades to its competition', () => {
  const leagueWith = (bound: string, elsewhere: string): League =>
    ({
      key: 'premier',
      label: 'Premier Men',
      group: 'Senior',
      district: 'All districts',
      competitions: [
        { id: 'c1', label: '50 Over', structureId: bound, calendarId: 'cal' },
        { id: 'c2', label: 'T20', structureId: elsewhere, calendarId: 'cal' },
      ],
    }) as unknown as League;

  it('strips only the competition bound to the deleted structure, in one save', async () => {
    const bound = structure({ id: 'flat-one', name: 'Flat one' });
    const other = structure({ id: 'flat-two', name: 'Flat two' });
    const league = leagueWith('flat-one', 'flat-two');
    const save = vi.fn().mockResolvedValue({});
    const toast = vi.fn();
    const user = userEvent.setup();
    const config = {
      structures: [bound, other],
      calendars: [calendar],
      leagues: [league],
    } as unknown as TenantConfig;
    vi.mocked(api.platformGetTenant).mockResolvedValue(config);

    render(<StructuresCard slug="dolphins" config={config} save={save} toast={toast} />);

    await user.click(within(screen.getByRole('row', { name: /flat one/i })).getByText(/delete/i));

    // The confirm dialog names the affected league before anything is deleted. Scoped to
    // the dialog itself — the "Used by" column also names Premier Men on both rows.
    const confirmBox = document.querySelector('.fix-confirm-box') as HTMLElement;
    expect(within(confirmBox).getByText(/premier men/i)).toBeVisible();

    await user.click(screen.getByRole('button', { name: /yes, delete/i }));

    expect(save).toHaveBeenCalledTimes(1);
    const patch = save.mock.calls[0][0];
    expect(patch.structures.map((s: CompetitionStructure) => s.id)).toEqual(['flat-two']);
    // The competition on the SURVIVING structure is untouched.
    expect(patch.leagues[0].competitions).toHaveLength(1);
    expect(patch.leagues[0].competitions[0]).toMatchObject({ id: 'c2', structureId: 'flat-two' });
  });

  it('surfaces a save rejection via toast and deletes nothing locally', async () => {
    // A running season keeps its own snapshot, but the server still 409s while a league
    // is bound to the structure — the version-drift guard.
    const bound = structure({ id: 'flat-one', name: 'Flat one' });
    const save = vi
      .fn()
      .mockRejectedValue(new ApiError(409, 'A league is still bound to this structure.'));
    const toast = vi.fn();
    const user = userEvent.setup();
    const config = { structures: [bound], calendars: [calendar] } as unknown as TenantConfig;
    vi.mocked(api.platformGetTenant).mockResolvedValue(config);

    render(<StructuresCard slug="dolphins" config={config} save={save} toast={toast} />);

    await user.click(within(screen.getByRole('row', { name: /flat one/i })).getByText(/delete/i));
    await user.click(screen.getByRole('button', { name: /yes, delete/i }));

    expect(toast).toHaveBeenCalledWith('A league is still bound to this structure.', 'warn');
    // Nothing removed locally — the structure's row is still there.
    expect(screen.getByRole('row', { name: /flat one/i })).toBeInTheDocument();
  });
});
