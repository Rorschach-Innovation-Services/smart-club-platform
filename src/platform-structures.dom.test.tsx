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
import type { CompetitionStructure, League, SeasonCalendar, TenantConfig } from './types';
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

/**
 * A second calendar whose blocks share the LABELS of `calendar`'s but not their ids —
 * the shape that made "That playing block no longer exists on this calendar" so
 * misleading, because a block of that exact name is sitting in the picker below.
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

/** Two stages on two different blocks — enough to be split across calendars. */
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
        schedule: { blockId: 'b1', cadence: { kind: 'weekly' } },
      },
      {
        id: 's2',
        name: 'Final round',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'all-registered' },
        schedule: { blockId: 'b2', cadence: { kind: 'weekly' } },
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

/** The "Preview against" calendar picker. */
const previewPicker = () => screen.getByRole('combobox', { name: /preview against/i });
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

/* ─────────────────────────────────────────────────────────────────────────────
   The structure/calendar trap.

   Reported as "the league setup won't let me add teams to groups". It was not
   that at all: a structure that fits perfectly reports every stage as broken the
   moment the editor previews it against a calendar it doesn't belong to, and the
   blank pickers that result invite an edit that the server rejects for the whole
   tenant. Two triggers — switching "Preview against", and a structure with no
   `calendarId` opening on whichever calendar happens to be first.
   ───────────────────────────────────────────────────────────────────────────── */

describe('opening a structure that records no calendar', () => {
  it('opens on the calendar whose blocks the stages actually name', async () => {
    // `other` is first, so `calendars[0]` — the old fallback — is the wrong answer.
    // Every structure the seed CLI wrote is in exactly this shape.
    const { user } = setup([structure({ calendarId: undefined })], {
      calendars: [otherCalendar, calendar],
    });
    await openEditor(user);
    expect(previewPicker()).toHaveValue('cal');
    expect(screen.queryByText(/no longer exists|isn.t on/i)).toBeNull();
  });

  it('prefers the calendar its bound competition names', async () => {
    // Both calendars carry `b1` here, so coverage can't decide. The binding can —
    // and it is the one the server enforces on save.
    const shared: SeasonCalendar = { ...otherCalendar, blocks: [...calendar.blocks] };
    const { user } = setup([structure({ calendarId: undefined })], {
      calendars: [calendar, shared],
      leagues: [boundLeague('flat', 'other')],
    });
    await openEditor(user);
    expect(previewPicker()).toHaveValue('other');
  });

  it('picks nothing rather than guessing between indistinguishable calendars', async () => {
    // Two seeded seasons used to share block ids AND labels. Choosing by array order
    // renders a correct-LOOKING picker over the wrong season's dates.
    const twin: SeasonCalendar = { ...otherCalendar, id: 'twin', blocks: [...calendar.blocks] };
    const { user } = setup([structure({ calendarId: undefined })], {
      calendars: [calendar, twin],
    });
    await openEditor(user);
    expect(previewPicker()).toHaveValue('');
  });

  it('does not ask the question when the operator answered "No calendar"', async () => {
    // Resolution returning nothing and the operator CHOOSING nothing are both `''` and
    // mean opposite things. Conflating them put an error-styled box on a healthy
    // structure, asserting no calendar accounted for its blocks — directly above its own
    // detail line naming the one that does.
    const { user, save } = setup([structure()], { calendars: [calendar] });
    await openEditor(user);
    await user.selectOptions(previewPicker(), '');

    expect(screen.queryByText(/no one calendar accounts for/i)).toBeNull();
    expect(saveBtn()).toBeEnabled();
    await user.click(saveBtn());
    expect(save).toHaveBeenCalled();
  });

  it('turns that refusal into a question, instead of silent blank pickers', async () => {
    // Refusing to guess is only right if the operator can SEE the refusal. Gating the
    // off-calendar display on a selected calendar made "no calendar" indistinguishable
    // from "you haven't picked one": a scheduled stage rendered "Pick a playing block…"
    // over a real value, no banner, and Save enabled — the exact trap, restored.
    const twin: SeasonCalendar = { ...otherCalendar, id: 'twin', blocks: [...calendar.blocks] };
    const { user } = setup([structure({ calendarId: undefined })], {
      calendars: [calendar, twin],
    });
    await openEditor(user);

    expect(screen.getByText(/no one calendar accounts for/i)).toBeInTheDocument();
    // The stage's stored block is still on screen, named, and SELECTED — the picker does
    // not fall back to its placeholder over a stage that is in fact scheduled.
    const picker = blockPicker() as HTMLSelectElement;
    expect(picker).toHaveValue('b1');
    expect(picker.options[picker.selectedIndex].text).not.toMatch(/pick a playing block/i);
    // And it says the block is claimed by BOTH calendars rather than picking one.
    expect(screen.getAllByText(/Block 1 on 2026\/27 and test/i).length).toBeGreaterThan(0);
  });
});

describe('previewing against a calendar the structure does not live on', () => {
  it('names the calendar the block belongs to, instead of saying it no longer exists', async () => {
    // The recording's exact sequence. Both calendars have a block LABELLED "Block 1",
    // so "no longer exists" is not merely unhelpful — one of that name is on screen.
    const { user } = setup([structure()], { calendars: [calendar, otherCalendar] });
    await openEditor(user);
    await user.selectOptions(previewPicker(), 'other');
    expect(screen.getAllByText(/Block 1 on 2026\/27/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/plays on a different calendar/i)).toBeInTheDocument();
  });

  it('shows the stored block in the picker rather than an empty placeholder', async () => {
    // The blank picker is what makes an operator "fix" a stage that was never broken.
    const { user } = setup([structure()], { calendars: [calendar, otherCalendar] });
    await openEditor(user);
    await user.selectOptions(previewPicker(), 'other');
    expect(blockPicker()).toHaveValue('b1');
  });

  it('still allows saving — nothing was edited, and the server accepts it', async () => {
    // Deliberately not blocked: `validateStructures` never checks blockIds, so
    // refusing here would be stricter than the API and would strand an operator
    // renaming a structure while a control labelled "Preview" points elsewhere.
    const { user, save } = setup([structure()], { calendars: [calendar, otherCalendar] });
    await openEditor(user);
    await user.selectOptions(previewPicker(), 'other');
    expect(saveBtn()).toBeEnabled();
    await user.click(saveBtn());
    expect(save).toHaveBeenCalled();
  });

  it('refuses to save a structure left split across two calendars', async () => {
    // The corrupting act, and the one the recording was a click away from: switch the
    // preview, then "fix" the blank picker on ONE stage and leave the other. The
    // result is a structure no calendar can run — and if it is bound, a save that
    // 400s the entire tenant PUT.
    const { user, save } = setup([twoStage()], { calendars: [calendar, otherCalendar] });
    await openEditor(user, /split league/i);
    await user.selectOptions(previewPicker(), 'other');
    await user.selectOptions(blockPicker(), 'x1');
    expect(screen.getByText(/split across calendars/i)).toBeInTheDocument();
    expect(saveBtn()).toBeDisabled();
    await user.click(saveBtn());
    expect(save).not.toHaveBeenCalled();
  });

  it('does not block a structure that ARRIVED split, only one split in this session', async () => {
    // Pre-existing damage is a warning, not a save gate. Blocking on arrival would stop
    // an operator renaming the structure or fixing a cadence until they had first edited
    // a stage they never came here to touch — the same over-blocking this module
    // explicitly rejects for stored blocks generally.
    const alreadySplit = {
      ...twoStage(),
      stages: [
        { ...twoStage().stages[0] }, // b1 — on `calendar`
        {
          ...twoStage().stages[1],
          schedule: { blockId: 'x2', cadence: { kind: 'weekly' } },
        }, // on `other`
      ],
    } as CompetitionStructure;
    const { user, save } = setup([alreadySplit], { calendars: [calendar, otherCalendar] });
    await openEditor(user, /split league/i);

    expect(screen.queryByText(/split across calendars/i)).toBeNull();
    expect(saveBtn()).toBeEnabled();
    await user.click(saveBtn());
    expect(save).toHaveBeenCalled();
  });

  it('mirrors the server when a bound competition is on another calendar', async () => {
    // `validateCompetitions` rejects this outright, discarding the whole edit and
    // naming a calendar the operator was never shown. Say it here, in their words.
    const { user, save } = setup([structure({ calendarId: 'cal' })], {
      calendars: [calendar, otherCalendar],
      leagues: [boundLeague('flat', 'other')],
    });
    await openEditor(user);
    expect(screen.getByText(/the calendar 50 Over \(Premier Men\) uses/i)).toBeInTheDocument();
    expect(saveBtn()).toBeDisabled();
    await user.click(saveBtn());
    expect(save).not.toHaveBeenCalled();
  });
});

describe('moving a structure to another calendar', () => {
  it('offers a name-matched remap when nothing is bound to it', async () => {
    const { user } = setup([structure()], { calendars: [calendar, otherCalendar] });
    await openEditor(user);
    await user.selectOptions(previewPicker(), 'other');
    await user.click(screen.getByRole('button', { name: /move to test/i }));
    // Remapped onto the same-named block, and the complaint clears.
    expect(blockPicker()).toHaveValue('x1');
    expect(screen.queryByText(/plays on a different calendar/i)).toBeNull();
    expect(saveBtn()).toBeEnabled();
  });

  it('refuses to offer it for a bound structure, and says what must change first', async () => {
    // A remap here produces a save the server rejects — offering the button would
    // be a trap dressed as a fix.
    const { user } = setup([structure()], {
      calendars: [calendar, otherCalendar],
      leagues: [boundLeague('flat', 'cal')],
    });
    await openEditor(user);
    await user.selectOptions(previewPicker(), 'other');
    expect(screen.queryByRole('button', { name: /move to test/i })).toBeNull();
    expect(screen.getByText(/can.t be moved here while/i)).toBeInTheDocument();
  });
});

describe('the structures list — the mismatch is visible before opening', () => {
  it('names the calendar the bound competitions run on', async () => {
    setup([structure()], { calendars: [calendar], leagues: [boundLeague('flat', 'cal')] });
    const row = screen.getByRole('row', { name: /flat round robin/i });
    expect(within(row).getByText('2026/27')).toBeInTheDocument();
  });

  it('flags a structure whose blocks are not on its bound calendar', async () => {
    setup([structure()], {
      calendars: [calendar, otherCalendar],
      leagues: [boundLeague('flat', 'other')],
    });
    const row = screen.getByRole('row', { name: /flat round robin/i });
    expect(within(row).getByText(/block mismatch/i)).toBeInTheDocument();
  });

  it('leaves a well-formed structure unflagged', async () => {
    setup([structure()], { calendars: [calendar], leagues: [boundLeague('flat', 'cal')] });
    const row = screen.getByRole('row', { name: /flat round robin/i });
    expect(within(row).queryByText(/block mismatch/i)).toBeNull();
  });
});
