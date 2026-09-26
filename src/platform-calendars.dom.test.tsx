/**
 * CalendarsCard — the union's real playing calendar.
 *
 * The bug that motivated most of this file: the break rows were keyed on the LABEL being
 * edited, so every keystroke changed the key, React unmounted the row and mounted a fresh
 * input, and focus fell to <body>. The mid-season break's name was untypeable — one
 * character per click. A browser pass using `fill()` (which sets the whole value at once)
 * misses it completely, so these type character by character.
 *
 * The validation tests cover the other quiet failure: a break that swallows a whole block
 * makes it unschedulable, and generation just silently finds no dates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarsCard, FORMAT_LIKE_LABEL } from './platform-calendars';
import { HelpProvider } from './help/HelpDrawer';
import type { CompetitionStructure, League, SeasonCalendar, TenantConfig } from './types';
import * as api from './api';
import { ApiError } from './api';

// The ONLY mock here, and it is a real system boundary: the card refetches the tenant
// before every write so two operators editing different calendars can't erase each other.
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, platformGetTenant: vi.fn() };
});

const cal = (over: Partial<SeasonCalendar> = {}): SeasonCalendar => ({
  id: 'cal2627',
  label: '2026/27',
  blocks: [{ id: 'b1', label: 'Block 1', start: '2026-09-12', end: '2026-12-12' }],
  breaks: [],
  excludeDates: [],
  ...over,
});

const setup = (calendars: SeasonCalendar[] = []) => {
  const save = vi.fn().mockResolvedValue({});
  const toast = vi.fn();
  const user = userEvent.setup();
  vi.mocked(api.platformGetTenant).mockResolvedValue({ calendars } as unknown as TenantConfig);
  render(
    <CalendarsCard
      slug="dolphins"
      config={{ calendars } as unknown as TenantConfig}
      save={save}
      toast={toast}
    />,
  );
  return { user, save, toast };
};

const openNew = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /create your first calendar/i }));
};

/** `YYYY-MM-DD` for local "now" — matches `todayIso`, which deliberately reads local time
 * rather than UTC (see its own doc comment), so this must too or the two disagree near
 * midnight in timezones ahead of UTC. */
const localToday = () => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(
    n.getDate(),
  ).padStart(2, '0')}`;
};

/** The two `type="date"` boxes on the first block row, in document order. */
const dateBoxes = () =>
  [...document.querySelectorAll<HTMLInputElement>('input[type="date"]')].slice(0, 2);

beforeEach(() => vi.clearAllMocks());

describe('CalendarsCard — typing a break label', () => {
  it('takes a whole label without losing focus between characters', async () => {
    const { user } = setup([]);
    await openNew(user);
    await user.click(screen.getByRole('button', { name: /add break/i }));

    const row = screen.getByPlaceholderText('Mid-season break');
    await user.clear(row);
    await user.type(row, 'Festive break');

    // Against the keyed-on-label version this reads "F" — every later keystroke lands
    // on <body> because the input it was aimed at no longer exists.
    expect(screen.getByPlaceholderText('Mid-season break')).toHaveValue('Festive break');
    expect(screen.getByPlaceholderText('Mid-season break')).toHaveFocus();
  });

  it('keeps two breaks independent while one is edited', async () => {
    const { user } = setup([]);
    await openNew(user);
    await user.click(screen.getByRole('button', { name: /add break/i }));
    await user.click(screen.getByRole('button', { name: /add break/i }));

    const rows = screen.getAllByPlaceholderText('Mid-season break');
    await user.clear(rows[0]);
    await user.type(rows[0], 'Festive');

    expect(screen.getAllByPlaceholderText('Mid-season break')[0]).toHaveValue('Festive');
    expect(screen.getAllByPlaceholderText('Mid-season break')[1]).toHaveValue('Mid-season break');
  });

  it('removes the right break when two share a label', async () => {
    // Keying by index is only safe because removal rebuilds the list; prove it.
    const { user } = setup([]);
    await openNew(user);
    await user.click(screen.getByRole('button', { name: /add break/i }));
    await user.click(screen.getByRole('button', { name: /add break/i }));

    const rows = screen.getAllByPlaceholderText('Mid-season break');
    await user.clear(rows[0]);
    await user.type(rows[0], 'First');
    await user.clear(screen.getAllByPlaceholderText('Mid-season break')[1]);
    await user.type(screen.getAllByPlaceholderText('Mid-season break')[1], 'Second');

    // Remove the FIRST — the survivor must be "Second", not "First".
    const removeButtons = screen.getAllByRole('button', { name: /^remove$/i });
    await user.click(removeButtons[removeButtons.length - 2]);

    const left = screen.getAllByPlaceholderText('Mid-season break');
    expect(left).toHaveLength(1);
    expect(left[0]).toHaveValue('Second');
  });
});

describe('CalendarsCard — validation before anything is generated', () => {
  it('refuses a calendar with no label', async () => {
    const { user, save } = setup([]);
    await openNew(user);

    expect(screen.getByText(/give the calendar a label/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /^create calendar$|^save/i }));
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a block that ends before it starts', async () => {
    const { user, save } = setup([]);
    await openNew(user);

    await user.type(screen.getByPlaceholderText('e.g. 2026/27'), '2026/27');
    // The first block now defaults to real dates (today → +8 weeks), so both boxes need
    // clearing first — typing into a pre-filled date input appends to it rather than
    // replacing it.
    const [start, end] = dateBoxes();
    await user.clear(start);
    await user.type(start, '2026-12-12');
    await user.clear(end);
    await user.type(end, '2026-09-12');

    // The error names the block; the block-dates field guide states the same rule in
    // general terms, so match the error's own wording.
    expect(screen.getByText(/block 1 ends before it starts/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /^create calendar$|^save/i }));
    expect(save).not.toHaveBeenCalled();
  });

  it('defaults the first block of a new calendar to today through eight weeks out', async () => {
    const { user } = setup([]);
    await openNew(user);

    const [start, end] = dateBoxes();
    expect(start).toHaveValue(localToday());
    // 8 weeks = 56 days. Comparing the label rather than reimplementing date math here —
    // the point under test is that it's non-blank and after `start`, not the exact
    // calendar arithmetic (that's `addDays`'s own test).
    expect(end.value > start.value).toBe(true);
  });

  it('chains a newly added block off the one before it, not off today again', async () => {
    const { user } = setup([]);
    await openNew(user);

    await user.click(screen.getByRole('button', { name: /add block/i }));

    const boxes = [...document.querySelectorAll<HTMLInputElement>('input[type="date"]')];
    // Row 0 is the first block (today → +8 weeks); row 1 is the new second block.
    const firstEnd = boxes[1].value;
    const secondStart = boxes[2].value;
    // Day after the first block's end, not another `today`.
    expect(secondStart > firstEnd).toBe(true);
    expect(secondStart).not.toBe(localToday());
  });

  it('refuses a break that swallows a whole block', async () => {
    // The nastiest calendar mistake: generation finds no dates and says nothing.
    const { user, save } = setup([
      cal({ breaks: [{ label: 'Festive break', start: '2026-09-01', end: '2026-12-31' }] }),
    ]);

    await user.click(within(screen.getByRole('row', { name: /2026\/27/i })).getByText(/edit/i));

    expect(
      screen.getByText(/covers the whole of Block 1 — no match could be scheduled/i),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: /^save/i }));
    expect(save).not.toHaveBeenCalled();
  });
});

describe('CalendarsCard — concurrent edits', () => {
  it('rebuilds against the SERVER list, not this tab’s cache', async () => {
    // Two operators, one array. Writing the whole thing from a stale cache erases the
    // other's calendar; the card refetches first so the other survives.
    const mine = cal({ id: 'mine', label: 'Mine' });
    const theirs = cal({ id: 'theirs', label: 'Theirs' });
    const save = vi.fn().mockResolvedValue({});
    const user = userEvent.setup();
    // This tab loaded before "Theirs" existed…
    vi.mocked(api.platformGetTenant).mockResolvedValue({
      calendars: [mine, theirs],
    } as unknown as TenantConfig);

    render(
      <CalendarsCard
        slug="dolphins"
        config={{ calendars: [mine] } as unknown as TenantConfig}
        save={save}
        toast={vi.fn()}
      />,
    );

    await user.click(within(screen.getByRole('row', { name: /mine/i })).getByText(/edit/i));
    await user.clear(screen.getByPlaceholderText('e.g. 2026/27'));
    await user.type(screen.getByPlaceholderText('e.g. 2026/27'), 'Mine v2');
    await user.click(screen.getByRole('button', { name: /save/i }));

    const written = save.mock.calls[0][0].calendars as SeasonCalendar[];
    expect(written.map((c) => c.id).sort()).toEqual(['mine', 'theirs']);
    expect(written.find((c) => c.id === 'mine')!.label).toBe('Mine v2');
  });

  it('refuses to resurrect a calendar deleted in another session', async () => {
    const mine = cal({ id: 'mine', label: 'Mine' });
    const save = vi.fn().mockResolvedValue({});
    const toast = vi.fn();
    const user = userEvent.setup();
    // Gone from the server between load and save.
    vi.mocked(api.platformGetTenant).mockResolvedValue({
      calendars: [],
    } as unknown as TenantConfig);

    render(
      <CalendarsCard
        slug="dolphins"
        config={{ calendars: [mine] } as unknown as TenantConfig}
        save={save}
        toast={toast}
      />,
    );

    await user.click(within(screen.getByRole('row', { name: /mine/i })).getByText(/edit/i));
    await user.clear(screen.getByPlaceholderText('e.g. 2026/27'));
    await user.type(screen.getByPlaceholderText('e.g. 2026/27'), 'Mine v2');
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(save).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/deleted in another session/i),
      'warn',
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Deleting a calendar bound by a league's competition (CalendarsCard's `onDelete`,
   platform-calendars.tsx ~:619). A competition pointing at a deleted calendar would fail
   the server's cross-check, so the binding is stripped in the SAME PUT — but only the
   binding that actually points at the deleted calendar, not every competition the league
   runs.
   ───────────────────────────────────────────────────────────────────────────── */

describe('CalendarsCard — deleting a bound calendar cascades to its competition', () => {
  const leagueWith = (bound: string, elsewhere: string): League =>
    ({
      key: 'premier',
      label: 'Premier Men',
      group: 'Senior',
      district: 'All districts',
      competitions: [
        { id: 'c1', label: '50 Over', structureId: 's1', calendarId: bound },
        { id: 'c2', label: 'T20', structureId: 's2', calendarId: elsewhere },
      ],
    }) as unknown as League;

  it('strips only the competition bound to the deleted calendar, in one save', async () => {
    const bound = cal({ id: 'cal1', label: 'Cal 1' });
    const other = cal({ id: 'cal2', label: 'Cal 2' });
    const league = leagueWith('cal1', 'cal2');
    const save = vi.fn().mockResolvedValue({});
    const toast = vi.fn();
    const user = userEvent.setup();
    const config = { calendars: [bound, other], leagues: [league] } as unknown as TenantConfig;
    vi.mocked(api.platformGetTenant).mockResolvedValue(config);

    render(<CalendarsCard slug="dolphins" config={config} save={save} toast={toast} />);

    await user.click(within(screen.getByRole('row', { name: /cal 1/i })).getByText(/delete/i));

    // The confirm dialog names the affected league before anything is deleted. Scoped to
    // the box: the card's own bindings lines name the league too.
    const box = document.querySelector<HTMLElement>('.fix-confirm-box')!;
    expect(within(box).getByText(/premier men/i)).toBeVisible();

    await user.click(screen.getByRole('button', { name: /yes, delete/i }));

    expect(save).toHaveBeenCalledTimes(1);
    const patch = save.mock.calls[0][0];
    expect(patch.calendars.map((c: SeasonCalendar) => c.id)).toEqual(['cal2']);
    // The competition on the SURVIVING calendar is untouched.
    expect(patch.leagues[0].competitions).toHaveLength(1);
    expect(patch.leagues[0].competitions[0]).toMatchObject({ id: 'c2', calendarId: 'cal2' });
  });

  it('shows a refused delete inside the confirm box, which stays open, and deletes nothing', async () => {
    // The series-scheduled guard: the server 409s rather than orphan a running series.
    const bound = cal({ id: 'cal1', label: 'Cal 1' });
    const save = vi
      .fn()
      .mockRejectedValue(
        new ApiError(
          409,
          '1 series is scheduled against "Cal 1" — reschedule it before deleting the calendar',
        ),
      );
    const toast = vi.fn();
    const user = userEvent.setup();
    const config = { calendars: [bound] } as unknown as TenantConfig;
    vi.mocked(api.platformGetTenant).mockResolvedValue(config);

    render(<CalendarsCard slug="dolphins" config={config} save={save} toast={toast} />);

    await user.click(within(screen.getByRole('row', { name: /cal 1/i })).getByText(/delete/i));
    await user.click(screen.getByRole('button', { name: /yes, delete/i }));

    // Inline, where the operator is looking — not a toast that vanishes.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '1 series is scheduled against "Cal 1" — reschedule it before deleting the calendar',
    );
    expect(toast).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /yes, delete/i })).toBeInTheDocument();
    // Cancel clears it: reopening the box starts clean.
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    await user.click(within(screen.getByRole('row', { name: /cal 1/i })).getByText(/delete/i));
    expect(screen.queryByRole('alert')).toBeNull();
    // Nothing removed locally — the calendar's row is still there.
    expect(screen.getByRole('row', { name: /cal 1/i })).toBeInTheDocument();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Explainers under the form: a field guide under each list, and a collapsed worked
   example an operator can open to see what a finished calendar looks like.
   ───────────────────────────────────────────────────────────────────────────── */

describe('CalendarForm — field guides and the worked example', () => {
  it('explains blocks, breaks and excluded dates under their lists', async () => {
    const { user } = setup([]);
    await openNew(user);

    expect(
      screen.getByText('The first and last date a match may be played in this block.'),
    ).toBeVisible();
    expect(screen.getByText('A stretch inside the season when nobody plays.')).toBeVisible();
    expect(screen.getByText(/Single days that are out: public holidays/)).toBeVisible();
  });

  it('opens and closes a read-only example calendar', async () => {
    const { user } = setup([]);
    await openNew(user);

    const toggle = screen.getByRole('button', { name: /see a worked example/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/ten-round league would otherwise schedule/i)).toBeNull();

    await user.click(toggle);
    expect(screen.getByText(/ten-round league would otherwise schedule/i)).toBeVisible();
    expect(screen.getByText('13 Sep – 13 Dec 2026')).toBeVisible();
    expect(screen.getByText('24 Sep 2026 (Heritage Day)')).toBeVisible();

    await user.click(screen.getByRole('button', { name: /hide the worked example/i }));
    expect(screen.queryByText(/ten-round league would otherwise schedule/i)).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Blocks are time, not formats. Operators have modelled "T20" and "30 Over" as two
   overlapping blocks of one calendar; the form now says what that should be instead
   (two competitions on the league) without ever refusing the save.
   ───────────────────────────────────────────────────────────────────────────── */

const renderWithHelp = (config: TenantConfig) => {
  const save = vi.fn().mockResolvedValue({});
  const user = userEvent.setup();
  vi.mocked(api.platformGetTenant).mockResolvedValue(config);
  render(
    <HelpProvider>
      <CalendarsCard slug="dolphins" config={config} save={save} toast={vi.fn()} />
    </HelpProvider>,
  );
  return { user, save };
};

const editRow = async (user: ReturnType<typeof userEvent.setup>, name: RegExp) =>
  user.click(within(screen.getByRole('row', { name })).getByText(/edit/i));

const HINT_TEXT = /this looks like a match format/i;

describe('CalendarForm — blocks are time, not formats', () => {
  it('explains an overlap as two competitions and links to the difference', async () => {
    const overlapping = cal({
      blocks: [
        { id: 'b1', label: 'Block 1', start: '2026-09-12', end: '2026-12-12' },
        { id: 'b2', label: 'Block 2', start: '2026-11-01', end: '2027-02-01' },
      ],
    });
    const { user } = renderWithHelp({ calendars: [overlapping] } as unknown as TenantConfig);
    await editRow(user, /2026\/27/i);

    expect(
      screen.getByText(
        /Block 1 and Block 2 overlap\. Blocks are stretches of time — two formats running side by side are two competitions on the league, not two blocks\./,
      ),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: /what's the difference\?/i }));
    expect(screen.getByRole('dialog', { name: 'Blocks and competitions' })).toBeVisible();
  });

  it('hints under blocks named after a format, and not under blocks named after time', async () => {
    const formatBlocks = cal({
      blocks: [
        { id: 'b1', label: 'T20', start: '2026-09-12', end: '2026-10-12' },
        { id: 'b2', label: '30 Over', start: '2026-10-13', end: '2026-11-12' },
        { id: 'b3', label: 'First half', start: '2026-11-13', end: '2026-12-12' },
        { id: 'b4', label: 'Block 1', start: '2027-01-13', end: '2027-02-12' },
      ],
    });
    const { user } = renderWithHelp({ calendars: [formatBlocks] } as unknown as TenantConfig);
    await editRow(user, /2026\/27/i);

    // One hint per format-named block, none for the two time-named ones.
    expect(screen.getAllByText(HINT_TEXT)).toHaveLength(2);
  });

  it('matches formats on word boundaries only', () => {
    for (const label of ['T20', '30 Over', '50 overs', 'Pink Ball', 'T10 Bash'])
      expect(FORMAT_LIKE_LABEL.test(label)).toBe(true);
    for (const label of ['First half', 'Block 1', 'Crossover', 'Handover', '2026/27'])
      expect(FORMAT_LIKE_LABEL.test(label)).toBe(false);
  });

  it('hints under a calendar label named after a format, and still saves', async () => {
    const { user, save } = renderWithHelp({
      calendars: [cal({ label: 'T20 Cup' })],
    } as unknown as TenantConfig);
    await editRow(user, /t20 cup/i);

    expect(screen.getByText(HINT_TEXT)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /^save/i }));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('never blocks saving a calendar whose block is named after a format', async () => {
    const { user, save } = renderWithHelp({
      calendars: [
        cal({ blocks: [{ id: 'b1', label: 'T20', start: '2026-09-12', end: '2026-12-12' }] }),
      ],
    } as unknown as TenantConfig);
    await editRow(user, /2026\/27/i);

    expect(screen.getByText(HINT_TEXT)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /^save/i }));
    expect(save).toHaveBeenCalledTimes(1);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Who uses each calendar, and which of its blocks nobody plays in. Aggregated across
   every competition on the calendar: T20 in Block 1 and 50 Over in Block 2 is two
   competitions sharing one calendar, and covers it.
   ───────────────────────────────────────────────────────────────────────────── */

describe('CalendarsCard — competitions on each calendar', () => {
  const twoBlocks = cal({
    blocks: [
      { id: 'b1', label: 'Block 1', start: '2026-09-12', end: '2026-12-12' },
      { id: 'b2', label: 'Block 2', start: '2027-01-16', end: '2027-03-27' },
    ],
  });

  const structureIn = (id: string, name: string, version: number, blockIndex: number) =>
    ({
      id,
      name,
      version,
      stages: [
        {
          id: `${id}-s1`,
          name: 'League',
          format: { kind: 'round-robin', legs: 1 },
          entrants: { kind: 'all-registered' },
          schedule: { blockIndex, cadence: { kind: 'weekly' } },
        },
      ],
    }) as unknown as CompetitionStructure;

  const leagueWith = (
    competitions: Array<{ id: string; label: string; structureId: string; calendarId: string }>,
  ) =>
    ({
      key: 'premier',
      label: 'Premier Men',
      group: 'Senior',
      district: 'All districts',
      competitions,
    }) as unknown as League;

  const renderCard = (config: Partial<TenantConfig>) =>
    render(
      <CalendarsCard
        slug="dolphins"
        config={config as unknown as TenantConfig}
        save={vi.fn()}
        toast={vi.fn()}
      />,
    );

  it('lists each competition with its structure name and version', () => {
    renderCard({
      calendars: [twoBlocks],
      structures: [structureIn('s1', 'Pools and knockout', 3, 0)],
      leagues: [
        leagueWith([
          { id: 'c1', label: 'T20', structureId: 's1', calendarId: 'cal2627' },
          { id: 'c2', label: '50 Over', structureId: 'gone', calendarId: 'cal2627' },
        ]),
      ],
    });

    expect(screen.getByText('Premier Men — T20 (Pools and knockout v3)')).toBeVisible();
    expect(screen.getByText('Premier Men — 50 Over (structure missing)')).toBeVisible();
  });

  it('says so when no competition uses the calendar, and raises no coverage warning', () => {
    renderCard({ calendars: [twoBlocks], structures: [], leagues: [] });

    expect(screen.getByText('No competitions on this calendar yet.')).toBeVisible();
    expect(screen.queryByText(/no competition on this calendar uses it/i)).toBeNull();
  });

  it('warns about a block no competition on the calendar plays in', () => {
    renderCard({
      calendars: [twoBlocks],
      structures: [structureIn('s1', 'Flat league', 1, 0)],
      leagues: [leagueWith([{ id: 'c1', label: 'T20', structureId: 's1', calendarId: 'cal2627' }])],
    });

    const lines = screen.getAllByText(/no competition on this calendar uses it/i);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent(/Block 2/);
  });

  it('raises nothing when the competitions cover every block between them', () => {
    renderCard({
      calendars: [twoBlocks],
      structures: [structureIn('s1', 'Flat league', 1, 0), structureIn('s2', 'Knockout', 1, 1)],
      leagues: [
        leagueWith([
          { id: 'c1', label: 'T20', structureId: 's1', calendarId: 'cal2627' },
          { id: 'c2', label: '50 Over', structureId: 's2', calendarId: 'cal2627' },
        ]),
      ],
    });

    expect(screen.queryByText(/no competition on this calendar uses it/i)).toBeNull();
  });
});
