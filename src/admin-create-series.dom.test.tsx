/**
 * CreateSeriesForm — the flat create path, and the calendar mode ADR 0008 added beside it.
 *
 * Two independent defects put this feature in the backlog, and only one of them is about
 * structure: before season calendars existed, EVERY league scheduled straight through the
 * mid-season break, because the form knew only a start date and a weekly step. The tests
 * here pin both halves of the resulting contract:
 *
 *   - with no calendar configured the form behaves EXACTLY as it always did, so a tenant
 *     that never adopts ADR 0008 sees no change at all
 *   - with one selected, the calendar owns the dates, and a plan that overruns its block
 *     cannot be created — the failure it replaces was a silently short season
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateSeriesForm } from './admin';
import { renderWithProviders } from './test-utils';
import type { Club, League, SeasonCalendar } from './types';

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

const leagues = [
  { key: 'emcuD1', label: 'EMCU Division 1', group: 'EMCU', district: 'All districts' },
] as unknown as League[];

/** Eight affiliated clubs — a 28-fixture single round robin, seven rounds. */
const clubs = Array.from({ length: 8 }, (_, i) => ({
  id: `c${i + 1}`,
  name: `Club ${i + 1}`,
  leagues: ['emcuD1'],
  affiliation: 'complete',
  ground: { venue: `Ground ${i + 1}` },
})) as unknown as Club[];

const setup = ({
  withCalendar = true,
  onCreate = vi.fn().mockResolvedValue(undefined),
  onClose = vi.fn(),
  onBack,
}: {
  withCalendar?: boolean;
  onCreate?: ReturnType<typeof vi.fn>;
  onClose?: ReturnType<typeof vi.fn>;
  onBack?: ReturnType<typeof vi.fn>;
} = {}) => {
  const user = userEvent.setup();
  renderWithProviders(
    <CreateSeriesForm
      clubs={clubs}
      allLeagues={leagues as never[]}
      allCalendars={withCalendar ? [calendar] : []}
      onCreate={onCreate}
      onClose={onClose}
      onBack={onBack}
    />,
  );
  return { user, onCreate, onClose, onBack };
};

const pickLeague = async (user: ReturnType<typeof userEvent.setup>) =>
  user.selectOptions(screen.getByLabelText('League'), 'emcuD1');

const createBtn = () => screen.getByRole('button', { name: /create series/i });

// Cadence, First round, Time slots, Activate from and Format live behind a collapsed
// "Scheduling options" section — sane defaults up front, engine knobs on demand.
const expandScheduling = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'Scheduling options' }));

beforeEach(() => vi.clearAllMocks());

describe('a tenant with no calendar configured sees the original form', () => {
  it('offers no calendar controls at all', async () => {
    const { user } = setup({ withCalendar: false });
    await pickLeague(user);

    expect(screen.queryByLabelText('Dates')).toBeNull();
    expect(screen.queryByLabelText('Playing block')).toBeNull();
  });

  it('still requires a start date, exactly as before', async () => {
    const { user, onCreate } = setup({ withCalendar: false });
    await pickLeague(user);

    await user.click(createBtn());
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe('the calendar owns the dates once one is picked', () => {
  const choose = async (user: ReturnType<typeof userEvent.setup>, blockId = 'b1') => {
    await pickLeague(user);
    await user.selectOptions(screen.getByLabelText('Dates'), 'cal');
    await user.selectOptions(screen.getByLabelText('Playing block'), blockId);
  };

  it('does not ask for a start date — the block already answers that', async () => {
    const { user } = setup();
    await choose(user);

    expect(screen.getByText(/^Ready$/)).toBeVisible();
    expect(screen.getByText(/weekly in Block 1 · 12 Sep 2026/)).toBeVisible();
    expect(createBtn()).toBeEnabled();
  });

  it('generates inside the block, stepping over the break', async () => {
    const { user, onCreate } = setup();
    await choose(user);
    await user.click(createBtn());

    const created = onCreate.mock.calls[0][0];
    const dates = created.fixtures.map((f: { date: string }) => f.date).sort();
    expect(dates[0] >= '2026-09-12').toBe(true);
    expect(dates.at(-1)! <= '2026-12-12').toBe(true);
    // Nothing may land inside the festive break.
    expect(dates.some((d: string) => d >= '2026-12-13' && d <= '2027-01-15')).toBe(false);
  });

  it('records the binding so a regenerate reproduces the same schedule', async () => {
    // Without `schedule` on the series, regenerate falls back to the legacy weekly step
    // and quietly walks a whole league into the break — the exact defect calendars exist
    // to prevent.
    const { user, onCreate } = setup();
    await choose(user);
    await user.click(createBtn());

    expect(onCreate.mock.calls[0][0].schedule).toMatchObject({
      calendarId: 'cal',
      blockId: 'b1',
      cadence: { kind: 'weekly' },
    });
  });

  it('refuses a cadence that overruns its block', async () => {
    // The EMCU Division 4 case: seven rounds every two weeks needs 14 weeks and Block 2
    // is 10. The old form would have created it and generated a short season.
    const { user, onCreate } = setup();
    await choose(user, 'b2');
    await expandScheduling(user);
    await user.click(screen.getByRole('button', { name: /every 2 weeks/i }));

    expect(screen.getByText(/does not fit/i)).toBeVisible();
    expect(createBtn()).toBeDisabled();
    await user.click(createBtn());
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('says how much does not fit and what to do about it', async () => {
    const { user } = setup();
    await choose(user, 'b2');
    await expandScheduling(user);
    await user.click(screen.getByRole('button', { name: /every 2 weeks/i }));

    // An operator can act on "Block 2 fits 6; 1 round doesn't fit"; not on "invalid".
    // It appears twice on purpose — in the preview banner and again by the Create button,
    // which is the last thing read before clicking.
    expect(screen.getAllByText(/Block 2 fits \d+ at this cadence/).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Shorten the cadence, start earlier, or extend Block 2/).length,
    ).toBeGreaterThan(0);
  });
});

describe('a calendar with a single playing block', () => {
  const oneBlockCalendar: SeasonCalendar = {
    id: 'cal-one',
    label: '2026/27',
    blocks: [{ id: 'only', label: 'Full season', start: '2026-09-12', end: '2027-03-27' }],
    breaks: [],
    excludeDates: [],
  };

  it('hides the Playing block select — there is no real choice to make', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateSeriesForm
        clubs={clubs}
        allLeagues={leagues as never[]}
        allCalendars={[oneBlockCalendar]}
        onCreate={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />,
    );
    await pickLeague(user);
    await user.selectOptions(screen.getByLabelText('Dates'), 'cal-one');

    expect(screen.queryByLabelText('Playing block')).toBeNull();
    // It still plans against the calendar's only block.
    expect(screen.getByText(/^Ready$/)).toBeVisible();
    expect(screen.getAllByText(/Full season/).length).toBeGreaterThan(0);
  });
});

describe('the Scheduling options section starts collapsed', () => {
  it('hides Cadence, First round, Time slots, Activate from and Format until expanded', async () => {
    const { user } = setup();
    await pickLeague(user);
    await user.selectOptions(screen.getByLabelText('Dates'), 'cal');

    expect(screen.queryByLabelText('Activate from')).toBeNull();
    expect(screen.queryByText('Cadence')).toBeNull();
    expect(screen.queryByText('Format')).toBeNull();

    await expandScheduling(user);

    expect(screen.getByLabelText('Activate from')).toBeInTheDocument();
    expect(screen.getByText('Cadence')).toBeInTheDocument();
    expect(screen.getByText('Format')).toBeInTheDocument();
  });
});

describe('delayed activation for junior leagues', () => {
  it('carries the activation date onto the created series', async () => {
    // Juniors generate now and stay hidden until the third week of January. This reuses
    // the existing released/releasedAt gate rather than adding a second visibility flag.
    const { user, onCreate } = setup();
    await pickLeague(user);
    await user.selectOptions(screen.getByLabelText('Dates'), 'cal');
    await user.selectOptions(screen.getByLabelText('Playing block'), 'b2');
    await expandScheduling(user);

    await user.type(screen.getByLabelText('Activate from'), '2027-01-16');
    await user.click(createBtn());

    expect(onCreate.mock.calls[0][0].activateFrom).toBe('2027-01-16');
  });
});

describe('picking a league', () => {
  it('selects every registered side and names the series after the league', async () => {
    const { user, onCreate } = setup();
    await pickLeague(user);
    await user.selectOptions(screen.getByLabelText('Dates'), 'cal');
    await user.click(createBtn());

    const created = onCreate.mock.calls[0][0];
    expect(created.teams).toHaveLength(8);
    expect(created.name).toMatch(/EMCU Division 1/);
  });

  it('snapshots the participants so a later roster edit cannot orphan the series', async () => {
    const { user, onCreate } = setup();
    await pickLeague(user);
    await user.selectOptions(screen.getByLabelText('Dates'), 'cal');
    await user.click(createBtn());

    const created = onCreate.mock.calls[0][0];
    expect(created.participants).toHaveLength(8);
    expect(created.participants[0]).toMatchObject({ teamId: expect.any(String), name: 'Club 1' });
  });
});

describe('the optional Back button (embedded in the "Generate fixtures" launcher)', () => {
  it('is absent when no onBack is supplied — the standalone/legacy use', () => {
    setup();
    expect(screen.queryByRole('button', { name: /^back$/i })).toBeNull();
  });

  it('renders and fires onBack when supplied, on a pristine form', async () => {
    const onBack = vi.fn();
    const { user } = setup({ onBack });

    await user.click(screen.getByRole('button', { name: /^back$/i }));
    expect(onBack).toHaveBeenCalled();
  });
});

describe('Back discards an edited form only with confirmation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a pristine form returns to the picker without confirming', async () => {
    const onBack = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { user } = setup({ onBack });

    await user.click(screen.getByRole('button', { name: /^back$/i }));

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onBack).toHaveBeenCalled();
  });

  it('an edited form asks to confirm; cancelling keeps the form mounted', async () => {
    const onBack = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { user } = setup({ onBack });

    await pickLeague(user); // a user-driven edit
    await user.click(screen.getByRole('button', { name: /^back$/i }));

    expect(window.confirm).toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    expect(screen.getByLabelText('League')).toHaveValue('emcuD1');
  });

  it('an edited form proceeds once the admin confirms', async () => {
    const onBack = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { user } = setup({ onBack });

    await pickLeague(user);
    await user.click(screen.getByRole('button', { name: /^back$/i }));

    expect(onBack).toHaveBeenCalled();
  });
});

describe('a failed create keeps the modal open with inputs intact', () => {
  it('re-enables Create and never closes on rejection', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('network down'));
    const onClose = vi.fn();
    const { user } = setup({ onCreate, onClose });

    await pickLeague(user);
    await user.selectOptions(screen.getByLabelText('Dates'), 'cal');
    await user.click(createBtn());

    await waitFor(() => expect(createBtn()).toBeEnabled());
    expect(onClose).not.toHaveBeenCalled();
    // The admin's picks are still there to retry with, not discarded on failure.
    expect(screen.getByLabelText('League')).toHaveValue('emcuD1');
    expect(screen.getByLabelText('Dates')).toHaveValue('cal');
  });
});
