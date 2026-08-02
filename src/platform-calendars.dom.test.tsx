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
import { CalendarsCard } from './platform-calendars';
import type { League, SeasonCalendar, TenantConfig } from './types';
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

    expect(screen.getByText(/ends before it starts/i)).toBeVisible();
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

    // The confirm dialog names the affected league before anything is deleted.
    expect(screen.getByText(/premier men/i)).toBeVisible();

    await user.click(screen.getByRole('button', { name: /yes, delete/i }));

    expect(save).toHaveBeenCalledTimes(1);
    const patch = save.mock.calls[0][0];
    expect(patch.calendars.map((c: SeasonCalendar) => c.id)).toEqual(['cal2']);
    // The competition on the SURVIVING calendar is untouched.
    expect(patch.leagues[0].competitions).toHaveLength(1);
    expect(patch.leagues[0].competitions[0]).toMatchObject({ id: 'c2', calendarId: 'cal2' });
  });

  it('surfaces a save rejection via toast and deletes nothing locally', async () => {
    // The series-scheduled guard: the server 409s rather than orphan a running series.
    const bound = cal({ id: 'cal1', label: 'Cal 1' });
    const save = vi
      .fn()
      .mockRejectedValue(new ApiError(409, 'A series already schedules against this calendar.'));
    const toast = vi.fn();
    const user = userEvent.setup();
    const config = { calendars: [bound] } as unknown as TenantConfig;
    vi.mocked(api.platformGetTenant).mockResolvedValue(config);

    render(<CalendarsCard slug="dolphins" config={config} save={save} toast={toast} />);

    await user.click(within(screen.getByRole('row', { name: /cal 1/i })).getByText(/delete/i));
    await user.click(screen.getByRole('button', { name: /yes, delete/i }));

    expect(toast).toHaveBeenCalledWith('A series already schedules against this calendar.', 'warn');
    // Nothing removed locally — the calendar's row is still there.
    expect(screen.getByRole('row', { name: /cal 1/i })).toBeInTheDocument();
  });
});
