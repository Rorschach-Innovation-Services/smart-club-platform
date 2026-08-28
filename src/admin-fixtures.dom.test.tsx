/**
 * FixtureTable — the admin's schedule editor.
 *
 * Everything here was verified by hand and by nothing else until now, and three defects
 * in one week came out of exactly these paths:
 *
 *   - clearing an allocated ground left `venueId` behind, so the booking ledger kept the
 *     old venue reserved for a match that had moved and never booked the new one
 *   - "Add fixture" asked for `nextRound` dates ANCHORED AT the last fixture, compounding
 *     the two, so round 4 landed three weeks late
 *   - the picker had no way to put an allocated fixture back on its home ground at all
 *
 * The venue tests assert on what is SAVED, not on which option is selected: the precedence
 * is override → allocated → home, and every one of these bugs was a fixture displaying one
 * ground while the data said another.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminFixtures, FixtureTable, SCHEDULE_COLS } from './admin';
import { renderWithProviders } from './test-utils';
import type { Club, SeasonCalendar, Series, TenantConfig } from './types';

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

const clubs = [
  {
    id: 'spartan',
    name: 'Spartan Sporting CC',
    ground: { venue: 'Spartan Park', suburb: 'Mount Edgecombe', secondaryVenue: 'Spartan Two' },
  },
  { id: 'tongaat', name: 'Tongaat CC', ground: { venue: 'Tongaat Oval', suburb: 'Tongaat' } },
  { id: 'ilembe', name: 'Ilembe CC', ground: { venue: 'KwaDukuza Stadium', suburb: 'KwaDukuza' } },
] as unknown as Club[];

const series = (over: Partial<Series> = {}): Series =>
  ({
    id: 's1',
    name: 'EMCU Division 2 · 2026/27',
    startDate: '2026-08-08',
    teams: ['spartan', 'tongaat', 'ilembe'],
    maxOvers: 50,
    seriesType: 'One-Day (40-50 overs)',
    released: false,
    approved: false,
    version: 1,
    fixtures: [
      { id: 'f1', round: 1, date: '2026-08-08', home: 'spartan', away: 'tongaat' },
      { id: 'f2', round: 2, date: '2026-08-15', home: 'ilembe', away: 'spartan' },
      { id: 'f3', round: 3, date: '2026-08-22', home: 'tongaat', away: 'ilembe' },
    ],
    ...over,
  }) as unknown as Series;

const setup = (s: Series = series()) => {
  const onUpdateSeries = vi.fn();
  const user = userEvent.setup();
  renderWithProviders(
    <FixtureTable
      series={s}
      clubs={clubs}
      allCalendars={[calendar]}
      onUpdateSeries={onUpdateSeries}
      onDeleteSeries={vi.fn()}
      onDuplicateSeries={vi.fn()}
      onSetReleased={vi.fn()}
      onAskRelease={vi.fn()}
      onAskRecall={vi.fn()}
      onAskReveal={vi.fn()}
      onApprove={vi.fn()}
      onUnapprove={vi.fn()}
      onAllocateVenues={vi.fn()}
      toast={vi.fn()}
    />,
  );
  return { user, onUpdateSeries };
};

/** Apply the updater `onUpdateSeries` was called with, and return the resulting fixtures. */
const resultingFixtures = (onUpdateSeries: ReturnType<typeof vi.fn>, from: Series) => {
  const updater = onUpdateSeries.mock.calls.at(-1)![1];
  return updater(from).fixtures as Array<Record<string, unknown>>;
};

const openEditor = async (user: ReturnType<typeof userEvent.setup>, rowText: RegExp) => {
  const row = screen.getByRole('row', { name: rowText });
  await user.click(within(row).getByTitle('Edit fixture'));
};

beforeEach(() => vi.clearAllMocks());

describe('the venue picker', () => {
  const allocated = () =>
    series({
      fixtures: [
        {
          id: 'f1',
          round: 1,
          date: '2026-08-08',
          home: 'spartan',
          away: 'tongaat',
          venueId: 'v-kingsmead',
          venueName: 'Kingsmead Stadium',
          venueLat: -29.8493,
          venueLon: 31.0294,
        },
      ],
    } as Partial<Series>);

  it('opens on the allocated ground, matching what the row displays', async () => {
    const { user } = setup(allocated());
    await openEditor(user, /kingsmead/i);

    const picker = screen.getByRole('combobox', { name: 'Venue' }) as HTMLSelectElement;
    expect(picker.options[picker.selectedIndex].text).toMatch(/allocated · kingsmead/i);
  });

  it('clears EVERY denormalised field when moved back to the home ground', async () => {
    // `venueId` is the one that matters most: buildLedger counts a ground as booked from
    // it and travelPerTeam measures distance to it. A stale id keeps the old venue
    // reserved against a match that has moved, and never books the one it moved to.
    const s = allocated();
    const { user, onUpdateSeries } = setup(s);
    await openEditor(user, /kingsmead/i);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Venue' }), 'primary');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const [f] = resultingFixtures(onUpdateSeries, s);
    expect(f.venueId).toBeUndefined();
    expect(f.venueName).toBe('');
    expect(f.venueLat).toBeUndefined();
    expect(f.venueLon).toBeUndefined();
    expect(f.venueOverride).toBe('');
  });

  it('clears the allocation when moved to the club’s secondary ground', async () => {
    const s = allocated();
    const { user, onUpdateSeries } = setup(s);
    await openEditor(user, /kingsmead/i);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Venue' }), 'secondary');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const [f] = resultingFixtures(onUpdateSeries, s);
    expect(f.venueOverride).toBe('Spartan Two');
    expect(f.venueId).toBeUndefined();
    expect(f.venueName).toBe('');
  });

  it('restores the allocation when the admin changes their mind', async () => {
    // The option is built from the STORED fixture, so it keeps reading "Allocated ·
    // Kingsmead" after a detour through Primary. Selecting it has to put the ground
    // back — otherwise it offers a venue it doesn't save and the match reverts to home.
    const s = allocated();
    const { user, onUpdateSeries } = setup(s);
    await openEditor(user, /kingsmead/i);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Venue' }), 'primary');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Venue' }), 'allocated');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const [f] = resultingFixtures(onUpdateSeries, s);
    expect(f.venueName).toBe('Kingsmead Stadium');
    expect(f.venueId).toBe('v-kingsmead');
    expect(f.venueLat).toBe(-29.8493);
    expect(f.venueOverride).toBe('');
  });

  it('offers no allocated option on a fixture that was never allocated', async () => {
    const { user } = setup();
    await openEditor(user, /spartan park/i);

    expect(screen.queryByRole('option', { name: /^allocated/i })).toBeNull();
  });

  it('saves a hand-typed ground as the override', async () => {
    const s = series();
    const { user, onUpdateSeries } = setup(s);
    await openEditor(user, /spartan park/i);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Venue' }), 'custom');
    await user.type(screen.getByLabelText(/custom venue/i), 'Kingsmead');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(resultingFixtures(onUpdateSeries, s)[0].venueOverride).toBe('Kingsmead');
  });

  it('drops a secondary-ground pick when the home club changes', async () => {
    // The secondary is the PREVIOUS club's ground; carrying it over would host a match
    // at a ground belonging to a club that is no longer playing at home.
    const s = series();
    const { user, onUpdateSeries } = setup(s);
    await openEditor(user, /spartan park/i);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Venue' }), 'secondary');
    await user.selectOptions(screen.getByLabelText(/home \(host\)/i), 'ilembe');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const [f] = resultingFixtures(onUpdateSeries, s);
    expect(f.home).toBe('ilembe');
    expect(f.venueOverride).toBe('');
  });
});

describe('the lock indicator', () => {
  it('marks a hand-set ground so nobody expects allocation to move it', () => {
    setup(
      series({
        fixtures: [
          {
            id: 'f1',
            round: 1,
            date: '2026-08-08',
            home: 'spartan',
            away: 'tongaat',
            venueOverride: 'Kingsmead',
          },
        ],
      } as Partial<Series>),
    );

    expect(screen.getByTitle(/allocation won’t move it|allocation won't move it/i)).toBeVisible();
  });

  it('leaves an allocated fixture unlocked, because allocation may move it again', () => {
    setup(
      series({
        fixtures: [
          {
            id: 'f1',
            round: 1,
            date: '2026-08-08',
            home: 'spartan',
            away: 'tongaat',
            venueName: 'Kingsmead',
          },
        ],
      } as Partial<Series>),
    );

    expect(screen.queryByTitle(/allocation won’t move it|allocation won't move it/i)).toBeNull();
  });
});

describe('adding a fixture', () => {
  it('steps one week on from the last fixture on a legacy series', async () => {
    // Asking for `nextRound` dates ANCHORED AT the last fixture compounds the two:
    // round 4 from 22 Aug landed on 12 Sep instead of 29 Aug.
    const s = series();
    const { user, onUpdateSeries } = setup(s);
    await user.click(screen.getByRole('button', { name: /add fixture/i }));

    const added = resultingFixtures(onUpdateSeries, s).at(-1)!;
    expect(added.round).toBe(4);
    expect(added.date).toBe('2026-08-29');
  });

  it('dates through the calendar when the series is bound to one', async () => {
    const s = series({
      schedule: { calendarId: 'cal', blockId: 'b1', cadence: { kind: 'weekly' } },
    } as Partial<Series>);
    const { user, onUpdateSeries } = setup(s);
    await user.click(screen.getByRole('button', { name: /add fixture/i }));

    // Block 1 opens 12 Sep; round 4 weekly is 3 Oct. The legacy step would have said
    // 29 Aug, which is outside the playing block entirely.
    const added = resultingFixtures(onUpdateSeries, s).at(-1)!;
    expect(added.date).toBe('2026-10-03');
  });

  it('never proposes a side against itself', async () => {
    const s = series({ teams: ['spartan', 'tongaat'] } as Partial<Series>);
    const { user, onUpdateSeries } = setup(s);
    await user.click(screen.getByRole('button', { name: /add fixture/i }));

    const added = resultingFixtures(onUpdateSeries, s).at(-1)!;
    expect(added.home).not.toBe(added.away);
  });

  it('starts at round 1 on an empty series', async () => {
    const s = series({ fixtures: [] } as Partial<Series>);
    const { user, onUpdateSeries } = setup(s);
    await user.click(screen.getByRole('button', { name: /add fixture/i }));

    const added = resultingFixtures(onUpdateSeries, s).at(-1)!;
    expect(added.round).toBe(1);
    expect(added.date).toBe('2026-08-08');
  });
});

describe('a knockout side that is still a forward reference', () => {
  const bracket = () =>
    series({
      teams: ['spartan', 'tongaat', 'ilembe'],
      fixtures: [
        { id: 'f1', round: 1, date: '2026-09-12', home: 'spartan', away: 'tongaat' },
        { id: 'f2', round: 2, date: '2026-09-19', home: 'win:f1', away: 'ilembe' },
      ],
    } as Partial<Series>);

  it('shows the reference read-only instead of a blank club picker', async () => {
    // A `win:f1` side has no entry in `teams`, so a select renders blank and any touch
    // silently replaces the bracket link the rest of the round depends on.
    const { user } = setup(bracket());
    const row = screen.getAllByRole('row').find((r) => /winner/i.test(r.textContent ?? ''))!;
    await user.click(within(row).getByTitle('Edit fixture'));

    const home = screen.getByLabelText(/home \(host\)/i);
    expect(home).toBeDisabled();
    expect((home as HTMLInputElement).value).toMatch(/winner/i);
  });

  it('leaves the reference intact when the fixture is saved', async () => {
    const s = bracket();
    const { user, onUpdateSeries } = setup(s);
    const row = screen.getAllByRole('row').find((r) => /winner/i.test(r.textContent ?? ''))!;
    await user.click(within(row).getByTitle('Edit fixture'));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(resultingFixtures(onUpdateSeries, s)[1].home).toBe('win:f1');
  });
});

describe('a tenant with no series still gets the season machinery', () => {
  // Generating a season stage is what CREATES the first series. Gating the whole page on
  // allSeries.length hid the only way in — the exact tenant state after clear-cohort or a
  // fresh onboarding — so the panels must render regardless of series count.
  const tenantConfig: Partial<TenantConfig> = { structures: [], calendars: [] };

  const renderPage = (over: Record<string, unknown> = {}) =>
    renderWithProviders(
      <AdminFixtures
        clubs={clubs}
        allSeries={[]}
        onSubmitSeries={vi.fn().mockResolvedValue(undefined)}
        onUpdateSeries={vi.fn()}
        onDeleteSeries={vi.fn()}
        onDuplicateSeries={vi.fn()}
        onSetReleased={vi.fn()}
        onSetApproved={vi.fn()}
        toast={vi.fn()}
        allVenues={[]}
        allSeasonRuns={[]}
        allLeagues={[]}
        tenantConfig={tenantConfig as TenantConfig}
        onSaveVenue={vi.fn()}
        onDeleteVenue={vi.fn()}
        onAllocateVenues={vi.fn()}
        onCreateSeasonRun={vi.fn()}
        onPatchSeasonRun={vi.fn()}
        onDeleteSeasonRun={vi.fn()}
        onGenerateStageSeries={vi.fn()}
        {...over}
      />,
    );

  it('renders the venues registry, the Start-a-season flow and the scoped series empty state', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /venues/i })).toBeTruthy();
    expect(screen.getByText(/no season running/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /start a season/i })).toBeTruthy();
    expect(screen.getByText(/no series yet/i)).toBeTruthy();
  });

  it('holds the space while the season setup is loading instead of offering Start', () => {
    // An unloaded runs list rendered as "No season running" offers a Start CTA whose
    // duplicate guard is checking a list that never arrived.
    renderPage({ seasonSetupLoading: true });
    expect(screen.queryByRole('button', { name: /start a season/i })).toBeNull();
    expect(screen.getByText(/loading the season setup/i)).toBeTruthy();
  });

  it('reports a failed season-setup fetch rather than rendering it as an empty season list', () => {
    renderPage({ structuresFailed: true });
    expect(screen.queryByRole('button', { name: /start a season/i })).toBeNull();
    expect(screen.getByText(/couldn.t load the season setup/i)).toBeTruthy();
  });
});

describe('the "Generate fixtures" launcher — one entry point, routed by league', () => {
  // A minimal bound competition so `premier` is season-capable; `friendlies` has none, so
  // it stays on the flat path. Both leagues share the same registered clubs.
  const structure = {
    id: 'struct-1',
    name: 'Straight round robin',
    version: 1,
    stages: [
      {
        id: 'only-stage',
        name: 'League',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'all-registered' },
        schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
      },
    ],
  } as unknown as import('./types').CompetitionStructure;

  const seasonCalendar = {
    id: 'cal-1',
    label: '2026/27',
    blocks: [{ id: 'b1', label: 'Block 1', start: '2026-09-12', end: '2026-12-12' }],
    breaks: [],
    excludeDates: [],
  } as unknown as SeasonCalendar;

  const leagues = [
    {
      key: 'premier',
      label: 'Premier League',
      group: 'Senior',
      district: 'All districts',
      competitions: [{ id: 'c1', label: '50 Over', structureId: 'struct-1', calendarId: 'cal-1' }],
    },
    { key: 'friendlies', label: 'Friendlies', group: 'Senior', district: 'All districts' },
  ] as unknown as import('./types').League[];

  const registeredClubs = [
    { id: 'c1', name: 'Club 1', affiliation: 'complete', leagues: ['premier', 'friendlies'] },
    { id: 'c2', name: 'Club 2', affiliation: 'complete', leagues: ['premier', 'friendlies'] },
  ] as unknown as Club[];

  // `onSubmitSeries` is the real POST handler — CreateSeriesForm now renders IN-MODAL via
  // a render prop, not a level up in main.tsx, so what belongs to THIS boundary is the
  // routing decision (which league gets the season form vs the embedded series form) and
  // the wiring of that embedded form (prefilled + locked league, hint text). A full
  // submit-through test would duplicate admin-create-series.dom.test.tsx, so it's skipped
  // here.
  const renderPage = (onSubmitSeries = vi.fn().mockResolvedValue(undefined)) => ({
    onSubmitSeries,
    ...renderWithProviders(
      <AdminFixtures
        clubs={registeredClubs}
        allSeries={[]}
        onSubmitSeries={onSubmitSeries}
        onUpdateSeries={vi.fn()}
        onDeleteSeries={vi.fn()}
        onDuplicateSeries={vi.fn()}
        onSetReleased={vi.fn()}
        onSetApproved={vi.fn()}
        toast={vi.fn()}
        allVenues={[]}
        allSeasonRuns={[]}
        allLeagues={leagues}
        tenantConfig={{ structures: [structure], calendars: [seasonCalendar] } as TenantConfig}
        onSaveVenue={vi.fn()}
        onDeleteVenue={vi.fn()}
        onAllocateVenues={vi.fn()}
        onCreateSeasonRun={vi.fn().mockResolvedValue(undefined)}
        onPatchSeasonRun={vi.fn()}
        onDeleteSeasonRun={vi.fn()}
        onGenerateStageSeries={vi.fn()}
      />,
    ),
  });

  // Two buttons open the same launcher with no series yet (the header action and the
  // empty-state CTA) — either proves the wiring, so the first one found is enough.
  const openLauncher = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getAllByRole('button', { name: /generate fixtures/i })[0]);

  const launcher = () => screen.getByRole('dialog', { name: /generate fixtures/i });
  const continueBtn = () => within(launcher()).getByRole('button', { name: /continue/i });

  it('routes a season-capable league straight to the season form, in the same modal', async () => {
    const user = userEvent.setup();
    const { onSubmitSeries } = renderPage();
    await openLauncher(user);

    await user.selectOptions(within(launcher()).getByRole('combobox'), 'premier');
    await user.click(continueBtn());

    expect(screen.getByRole('dialog', { name: /start.*season/i })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: /^generate fixtures$/i })).toBeNull();
    expect(onSubmitSeries).not.toHaveBeenCalled();
  });

  it('routes a flat league to the flat-season dialog, not the embedded series form', async () => {
    const user = userEvent.setup();
    renderPage();
    await openLauncher(user);

    await user.selectOptions(within(launcher()).getByRole('combobox'), 'friendlies');
    await user.click(continueBtn());

    // Same launcher, routed to the flat-season step — not the embedded series form, and
    // the "Generate fixtures" picker is gone.
    const flatDialog = screen.getByRole('dialog', { name: /start.*flat season/i });
    expect(flatDialog).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: /^generate fixtures$/i })).toBeNull();
    expect(screen.queryByRole('dialog', { name: /create.*series/i })).toBeNull();

    // The operator-hint box names the league and explains why it gets a flat season.
    expect(within(flatDialog).getByText(/Friendlies has no competition bound to it/)).toBeTruthy();

    // Back returns to the picker rather than closing the whole launcher.
    await user.click(within(flatDialog).getByRole('button', { name: /^back$/i }));
    expect(screen.getByRole('dialog', { name: /^generate fixtures$/i })).toBeTruthy();
  });

  it('opens the embedded series form with no prefill and a free league select for ad-hoc', async () => {
    const user = userEvent.setup();
    renderPage();
    await openLauncher(user);

    await user.selectOptions(
      within(launcher()).getByRole('combobox'),
      within(launcher()).getByRole('option', { name: /one-off series/i }),
    );
    await user.click(continueBtn());

    const seriesDialog = screen.getByRole('dialog', { name: /create.*series/i });
    // Ad-hoc keeps the free select, unset — no league, no hint box.
    expect(within(seriesDialog).getByLabelText('League')).toHaveValue('');
  });

  it('groups the league select into structured and flat optgroups', async () => {
    // `leagues` above has one season-capable league ('premier') and one flat league
    // ('friendlies'), so both optgroups should render.
    const user = userEvent.setup();
    renderPage();
    await openLauncher(user);

    const select = within(launcher()).getByRole('combobox');
    const groups = Array.from(select.querySelectorAll('optgroup')).map((g) =>
      g.getAttribute('label'),
    );
    expect(groups).toEqual([
      'Structured seasons — set up by your platform operator',
      'Flat seasons — one flat round robin until a competition is bound',
    ]);
  });
});

describe('the season viewer — every schedule on screen, downloads inside it', () => {
  // Two competitions with distinct statuses (Draft vs Released) and distinct rows, so the
  // summary, the tab swap and the status badges all have something to assert on.
  const div2 = () => series();
  const premier = () =>
    series({
      id: 's2',
      name: 'EMCU Premier · 2026/27',
      released: true,
      approved: true,
      fixtures: [{ id: 'g1', round: 1, date: '2026-09-05', home: 'ilembe', away: 'tongaat' }],
    } as Partial<Series>);

  const renderPage = (allSeries = [div2(), premier()]) =>
    renderWithProviders(
      <AdminFixtures
        clubs={clubs}
        allSeries={allSeries}
        onSubmitSeries={vi.fn().mockResolvedValue(undefined)}
        onUpdateSeries={vi.fn()}
        onDeleteSeries={vi.fn()}
        onDuplicateSeries={vi.fn()}
        onSetReleased={vi.fn()}
        onSetApproved={vi.fn()}
        toast={vi.fn()}
        allVenues={[]}
        allSeasonRuns={[]}
        allLeagues={[]}
        tenantConfig={{ structures: [], calendars: [] } as unknown as TenantConfig}
        onSaveVenue={vi.fn()}
        onDeleteVenue={vi.fn()}
        onAllocateVenues={vi.fn()}
        onCreateSeasonRun={vi.fn()}
        onPatchSeasonRun={vi.fn()}
        onDeleteSeasonRun={vi.fn()}
        onGenerateStageSeries={vi.fn()}
      />,
    );

  const openViewer = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: /view season/i }));
    return screen.getByRole('dialog', { name: /season summary/i });
  };

  it('swaps the export buttons for a single "View season" entry point', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /view season/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /export schedule/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /export season/i })).toBeNull();
  });

  it('opens a summary listing every competition with its fixture count and status', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openViewer(user);
    // Scope to the summary table — the competition names also appear in the tab pills.
    const summary = within(dialog).getAllByRole('table')[0];

    expect(within(summary).getByText('EMCU Division 2 · 2026/27')).toBeTruthy();
    expect(within(summary).getByText('EMCU Premier · 2026/27')).toBeTruthy();
    expect(within(summary).getByText('Draft')).toBeTruthy();
    expect(within(summary).getByText('Released')).toBeTruthy();
    // The active series' three fixtures show in the summary (Fixtures column).
    expect(within(summary).getAllByText('3').length).toBeGreaterThan(0);
    expect(within(summary).getByText('1')).toBeTruthy();
  });

  it('defaults to the active series and swaps rows when another tab is picked', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openViewer(user);

    // Default tab = active series (Division 2): its first fixture is Spartan v Tongaat at
    // Spartan Park, with '—' for distance/travel (the test clubs have no geo).
    const schedule = () => within(dialog).getAllByRole('table')[1];
    SCHEDULE_COLS.forEach((col) => {
      expect(within(schedule()).getAllByText(col).length).toBeGreaterThan(0);
    });
    const homeRow = within(schedule())
      .getAllByRole('row')
      .find((r) => /spartan sporting cc/i.test(r.textContent ?? ''))!;
    expect(homeRow).toBeTruthy();
    expect(within(homeRow).getByText('Spartan Park')).toBeTruthy();
    expect(within(homeRow).getByText('Tongaat CC')).toBeTruthy();
    expect(within(homeRow).getAllByText('—').length).toBe(2);

    // Switch to the Premier tab — Ilembe v Tongaat replaces the Division 2 rows.
    await user.click(within(dialog).getByRole('button', { name: /emcu premier/i }));
    expect(
      within(schedule())
        .getAllByRole('row')
        .some((r) => /ilembe cc/i.test(r.textContent ?? '')),
    ).toBe(true);
    expect(
      within(schedule())
        .getAllByRole('row')
        .some((r) => /spartan sporting cc/i.test(r.textContent ?? '')),
    ).toBe(false);
  });

  it('keeps both spreadsheet downloads inside the viewer', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openViewer(user);
    expect(within(dialog).getByRole('button', { name: /download season/i })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /download schedule/i })).toBeTruthy();
  });

  it('closes on Escape, backdrop click and the close button', async () => {
    const user = userEvent.setup();

    renderPage();
    await openViewer(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: /season summary/i })).toBeNull();

    const closeVia = await openViewer(user);
    await user.click(within(closeVia).getByRole('button', { name: /^close$/i }));
    expect(screen.queryByRole('dialog', { name: /season summary/i })).toBeNull();

    const dialog = await openViewer(user);
    // The backdrop is the dialog's parent; clicking it (not the panel) closes.
    await user.click(dialog.parentElement as HTMLElement);
    expect(screen.queryByRole('dialog', { name: /season summary/i })).toBeNull();
  });

  it('shows an empty state when there are no series at all', async () => {
    const user = userEvent.setup();
    renderPage([]);
    const dialog = await openViewer(user);
    expect(within(dialog).getByText(/no series yet/i)).toBeTruthy();
  });

  it('tells the admin when the picked series has no fixtures', async () => {
    const user = userEvent.setup();
    renderPage([series({ fixtures: [] } as Partial<Series>)]);
    const dialog = await openViewer(user);
    expect(within(dialog).getByText(/no fixtures in this series yet/i)).toBeTruthy();
  });
});

describe('progressive release — withhold at release, reveal later (ADR 0011)', () => {
  const renderPage = (
    s: Series,
    spies: { onSetReleased?: ReturnType<typeof vi.fn>; onReveal?: ReturnType<typeof vi.fn> } = {},
  ) => {
    const onSetReleased = spies.onSetReleased ?? vi.fn();
    const onReveal = spies.onReveal ?? vi.fn();
    renderWithProviders(
      <AdminFixtures
        clubs={clubs}
        allSeries={[s]}
        onSubmitSeries={vi.fn().mockResolvedValue(undefined)}
        onUpdateSeries={vi.fn()}
        onDeleteSeries={vi.fn()}
        onDuplicateSeries={vi.fn()}
        onSetReleased={onSetReleased}
        onReveal={onReveal}
        onSetApproved={vi.fn()}
        toast={vi.fn()}
        allVenues={[]}
        allSeasonRuns={[]}
        allLeagues={[]}
        tenantConfig={{ structures: [], calendars: [] } as unknown as TenantConfig}
        onSaveVenue={vi.fn()}
        onDeleteVenue={vi.fn()}
        onAllocateVenues={vi.fn()}
        onCreateSeasonRun={vi.fn()}
        onPatchSeasonRun={vi.fn()}
        onDeleteSeasonRun={vi.fn()}
        onGenerateStageSeries={vi.fn()}
      />,
    );
    return { onSetReleased, onReveal };
  };

  it('withholds start times chosen in the release dialog', async () => {
    const user = userEvent.setup();
    const { onSetReleased } = renderPage(series({ approved: true } as Partial<Series>));

    // Header CTA opens the ReleaseDialog (not an immediate release).
    await user.click(screen.getAllByRole('button', { name: /release to clubs/i })[0]);
    const dialog = screen.getByRole('dialog', { name: /release .*to clubs/i });
    expect(onSetReleased).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('checkbox', { name: /withhold start times/i }));
    await user.click(within(dialog).getByRole('button', { name: /release to clubs/i }));

    expect(onSetReleased).toHaveBeenCalledWith('s1', true, { time: true });
  });

  it('shows a withheld badge and reveals venues through the confirm modal', async () => {
    const user = userEvent.setup();
    const { onReveal } = renderPage(
      series({ approved: true, released: true, withheld: { venue: true } } as Partial<Series>),
    );

    // The series card carries the withheld badge.
    expect(screen.getAllByText(/venues withheld/i).length).toBeGreaterThan(0);

    // Header CTA → confirm modal → dispatch reveal(['venue']).
    await user.click(screen.getAllByRole('button', { name: /reveal venues/i })[0]);
    const confirmBox = screen
      .getByText(/reveal venues to all clubs\?/i)
      .closest('.fix-confirm-box') as HTMLElement;
    await user.click(within(confirmBox).getByRole('button', { name: /^reveal venues$/i }));

    expect(onReveal).toHaveBeenCalledWith('s1', ['venue']);
  });

  it('never claims WhatsApp notifications are sent on release', () => {
    renderPage(series({ approved: true, released: true } as Partial<Series>));
    expect(screen.queryByText(/whatsapp notifications sent/i)).toBeNull();
  });
});

describe('release fires exactly one success toast', () => {
  const renderPage = (s: Series) => {
    const toast = vi.fn();
    const onSetReleased = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <AdminFixtures
        clubs={clubs}
        allSeries={[s]}
        onSubmitSeries={vi.fn().mockResolvedValue(undefined)}
        onUpdateSeries={vi.fn()}
        onDeleteSeries={vi.fn()}
        onDuplicateSeries={vi.fn()}
        onSetReleased={onSetReleased}
        onReveal={vi.fn()}
        onSetApproved={vi.fn()}
        toast={toast}
        allVenues={[]}
        allSeasonRuns={[]}
        allLeagues={[]}
        tenantConfig={{ structures: [], calendars: [] } as unknown as TenantConfig}
        onSaveVenue={vi.fn()}
        onDeleteVenue={vi.fn()}
        onAllocateVenues={vi.fn()}
        onCreateSeasonRun={vi.fn()}
        onPatchSeasonRun={vi.fn()}
        onDeleteSeasonRun={vi.fn()}
        onGenerateStageSeries={vi.fn()}
      />,
    );
    return { toast, onSetReleased };
  };

  it('toasts once, after the PATCH resolves, and not from the release bar too', async () => {
    const user = userEvent.setup();
    const { toast, onSetReleased } = renderPage(series({ approved: true } as Partial<Series>));

    // Header CTA opens the dialog; the dialog's own "Release to clubs" fires the release.
    await user.click(screen.getAllByRole('button', { name: /release to clubs/i })[0]);
    const dialog = screen.getByRole('dialog', { name: /release .*to clubs/i });
    await user.click(within(dialog).getByRole('button', { name: /release to clubs/i }));

    expect(onSetReleased).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/·\s*released to \d+ clubs/i));
  });
});

describe('the venue-reason marker in the fixture table', () => {
  const moved = (over: Record<string, unknown>) =>
    series({
      fixtures: [
        {
          id: 'f1',
          round: 1,
          date: '2026-08-08',
          home: 'spartan',
          away: 'tongaat',
          venueOverride: 'Kingsmead',
          venueStatus: 'neutral',
          ...over,
        },
      ],
    } as Partial<Series>);

  it('shows a "moved" pill with the full reason as its tooltip', () => {
    const reason = 'Moved to avoid ground clash — Kingsmead Stadium';
    setup(moved({ venueReason: reason }));
    const pill = screen.getByText('moved');
    expect(pill).toHaveAttribute('title', reason);
  });

  it('labels a union directive as "directive"', () => {
    const reason = 'Union directive — Kloof CC unavailable';
    setup(moved({ venueReason: reason }));
    expect(screen.getByText('directive')).toHaveAttribute('title', reason);
  });

  it('labels a groundless home club as "no ground"', () => {
    const reason = "home club has no ground — played at opponent's venue";
    setup(moved({ venueReason: reason }));
    expect(screen.getByText('no ground')).toHaveAttribute('title', reason);
  });

  it('shows no pill for a routine allocated/Union-T20 ground', () => {
    const reason = 'Union T20 schedule — exact venue';
    setup(moved({ venueReason: reason }));
    // The reason still reads in the suburb line, but no compact pill (no titled marker).
    expect(screen.queryByTitle(reason)).toBeNull();
    expect(screen.queryByText('moved')).toBeNull();
    expect(screen.queryByText('directive')).toBeNull();
  });

  it('shows no pill when the fixture is on its home ground', () => {
    const reason = 'Moved to avoid ground clash — Kingsmead Stadium';
    setup(moved({ venueStatus: 'home', venueReason: reason }));
    expect(screen.queryByText('moved')).toBeNull();
  });
});
