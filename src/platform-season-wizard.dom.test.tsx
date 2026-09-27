/**
 * SeasonSetupWizard — the guided "set up a season" flow (ADR 0008 phase 3).
 *
 * Covers the four load-bearing paths: a brand-new calendar with one league set up from a
 * template writing a single PUT (as `league.setup`, never `competitions`); skipping every
 * league writing only the calendar; picking an EXISTING calendar upserting it rather than
 * duplicating it; and a library structure naming a block position the draft calendar
 * doesn't have being refused on its row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SeasonSetupWizard } from './platform-season-wizard';
import type { CompetitionStructure, League, SeasonCalendar, TenantConfig } from './types';
import * as api from './api';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, platformGetTenant: vi.fn() };
});

const league = (over: Partial<League> = {}): League =>
  ({
    key: 'premier',
    label: 'Premier Men',
    group: 'Senior',
    district: 'All districts',
    ...over,
  }) as League;

const existingCalendar: SeasonCalendar = {
  id: 'cal-existing',
  label: '2026/27',
  blocks: [
    { id: 'b1', label: 'Block 1', start: '2026-09-12', end: '2026-12-12' },
    { id: 'b2', label: 'Block 2', start: '2027-01-16', end: '2027-03-27' },
  ],
  breaks: [],
  excludeDates: [],
};

/** Two stages, the second at block position 1 — used to force a fit warning against a
    freshly-created calendar, which defaults to a single block. */
const twoBlockStructure: CompetitionStructure = {
  id: 'struct-two-block',
  name: 'Split league',
  version: 1,
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
};

const setup = (config: Partial<TenantConfig> = {}) => {
  const full = {
    tenant: 'dolphins',
    leagues: [league()],
    calendars: [],
    structures: [],
    ...config,
  } as unknown as TenantConfig;
  const save = vi.fn().mockResolvedValue(full);
  const toast = vi.fn();
  const onDone = vi.fn();
  const onClose = vi.fn();
  const user = userEvent.setup();
  vi.mocked(api.platformGetTenant).mockResolvedValue(full);
  render(
    <SeasonSetupWizard
      slug="dolphins"
      config={full}
      save={save}
      toast={toast}
      onDone={onDone}
      onClose={onClose}
    />,
  );
  return { user, save, toast, onDone, onClose, config: full };
};

/** Fills the season label — the only field the default draft calendar is missing. */
async function fillSeasonLabel(user: ReturnType<typeof userEvent.setup>, label = '2026/27') {
  const input = screen.getByPlaceholderText('e.g. 2026/27');
  await user.clear(input);
  await user.type(input, label);
}

const continueBtn = () => screen.getByRole('button', { name: /^continue$/i });

/**
 * Adds a league to step 2 and answers "where its structure comes from" with `mode` —
 * nothing is preselected, so the row waits for this answer before offering templates.
 */
async function addLeague(
  user: ReturnType<typeof userEvent.setup>,
  key: string,
  mode: RegExp = /start from a template/i,
) {
  await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), key);
  const cards = screen.getAllByRole('radio', { name: mode });
  await user.click(cards[cards.length - 1]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SeasonSetupWizard', () => {
  it('creates a new calendar and binds one league from a template in a single PUT', async () => {
    const { user, save } = setup();

    await fillSeasonLabel(user);
    await user.click(continueBtn());

    // Step 2 is opt-IN: leagues are untouched until explicitly added — and an added row
    // preselects nothing (see the nothing-preselected test below).
    await addLeague(user, 'premier');
    await user.click(screen.getByRole('radio', { name: /flat round robin/i }));
    await user.click(continueBtn());

    // Step 3: review shows the new structure (named after the TEMPLATE — structures are
    // durable blueprints, not per-league stampings) and a fit verdict, then commit.
    expect(screen.getByText(/new structure \(Flat round robin\)/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /create season/i }));

    expect(save).toHaveBeenCalledTimes(1);
    const patch = save.mock.calls[0][0];
    expect(patch.calendars).toHaveLength(1);
    expect(patch.calendars[0].label).toBe('2026/27');
    expect(patch.structures).toHaveLength(1);
    expect(patch.structures[0].name).toBe('Flat round robin');
    expect(patch.leagues[0].setup).toEqual({
      structureId: patch.structures[0].id,
      calendarId: patch.calendars[0].id,
    });
    // The deprecated competitions layer is never written.
    expect(patch.leagues[0]).not.toHaveProperty('competitions');

    // Terminal Done summary.
    expect(await screen.findByText(/is created/i)).toBeInTheDocument();
    expect(screen.getByText(/Premier Men/)).toBeInTheDocument();
  });

  it('a retry after a PUT that landed unacknowledged re-sends no duplicate structure or calendar', async () => {
    const { user, save, config } = setup();
    // First PUT lands server-side but the response is lost.
    save.mockRejectedValueOnce(new Error('network'));

    await fillSeasonLabel(user);
    await user.click(continueBtn());
    await addLeague(user, 'premier');
    await user.click(screen.getByRole('radio', { name: /flat round robin/i }));
    await user.click(continueBtn());
    await user.click(screen.getByRole('button', { name: /create season/i }));

    expect(save).toHaveBeenCalledTimes(1);
    const landed = save.mock.calls[0][0];
    // The refetch on retry now sees what the first PUT wrote.
    vi.mocked(api.platformGetTenant).mockResolvedValue({
      ...config,
      calendars: landed.calendars,
      structures: landed.structures,
      leagues: landed.leagues,
    } as TenantConfig);

    await user.click(screen.getByRole('button', { name: /create season/i }));

    expect(save).toHaveBeenCalledTimes(2);
    const retry = save.mock.calls[1][0];
    expect(retry.structures.map((s: CompetitionStructure) => s.id)).toEqual(
      landed.structures.map((s: CompetitionStructure) => s.id),
    );
    expect(retry.calendars.map((c: SeasonCalendar) => c.id)).toEqual(
      landed.calendars.map((c: SeasonCalendar) => c.id),
    );
    expect(await screen.findByText(/is created/i)).toBeInTheDocument();
  });

  it('adding no league writes only the calendar', async () => {
    const { user, save } = setup();

    await fillSeasonLabel(user);
    await user.click(continueBtn());
    // No league added — the step is opt-in, so Continue is always allowed.
    await user.click(continueBtn());
    // The untouched majority collapses to a count line on review.
    expect(screen.getByText(/1 other league keeps its current setup/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /create season/i }));

    expect(save).toHaveBeenCalledTimes(1);
    const patch = save.mock.calls[0][0];
    expect(patch.calendars).toHaveLength(1);
    expect(patch.structures).toEqual([]);
    expect(patch.leagues[0]).not.toHaveProperty('setup');
    expect(await screen.findByText(/no leagues were set up/i)).toBeInTheDocument();
  });

  it('picking an existing calendar upserts it instead of duplicating it', async () => {
    const { user, save } = setup({ calendars: [existingCalendar] });

    await user.click(screen.getByRole('radio', { name: /use an existing calendar/i }));
    // The existing calendar prefills the embedded form — its label is already valid.
    expect(screen.getByDisplayValue('2026/27')).toBeInTheDocument();
    await user.click(continueBtn());
    await user.click(continueBtn()); // add no league
    await user.click(screen.getByRole('button', { name: /create season/i }));

    const patch = save.mock.calls[0][0];
    expect(patch.calendars).toHaveLength(1);
    expect(patch.calendars[0].id).toBe('cal-existing');
    expect(await screen.findByText(/is updated/i)).toBeInTheDocument();
  });

  it('never reuses a quick-start structure: picking its template mints a fresh one', async () => {
    const quickStarted: CompetitionStructure = {
      id: 'struct-qs',
      name: 'Premier Men quick start',
      version: 1,
      templateId: 'flat-round-robin',
      source: 'quick-start',
      stages: [twoBlockStructure.stages[0]],
    };
    const { user, save } = setup({ structures: [quickStarted] });

    await fillSeasonLabel(user);
    await user.click(continueBtn());
    await addLeague(user, 'premier');
    // The template pick never prefills from a quick-start structure, even one cloned from
    // the same template.
    await user.click(screen.getByRole('radio', { name: /flat round robin/i }));
    await user.click(continueBtn());
    await user.click(screen.getByRole('button', { name: /create season/i }));

    const patch = save.mock.calls[0][0];
    expect(patch.structures).toHaveLength(2);
    const fresh = patch.structures.find((s: CompetitionStructure) => s.id !== 'struct-qs');
    expect(fresh.templateId).toBe('flat-round-robin');
    expect(patch.leagues[0].setup.structureId).toBe(fresh.id);
  });

  it('lists operator structures first, then quick-start and migrated ones grouped', async () => {
    const quickStarted: CompetitionStructure = {
      ...twoBlockStructure,
      id: 'struct-qs',
      name: 'Quick-started league',
      source: 'quick-start',
    };
    const migrated: CompetitionStructure = {
      ...twoBlockStructure,
      id: 'struct-mig',
      name: 'Migrated flat season',
      source: 'migration',
    };
    const { user } = setup({ structures: [twoBlockStructure, quickStarted, migrated] });

    await fillSeasonLabel(user);
    await user.click(continueBtn());
    await addLeague(user, 'premier', /use an existing structure/i);
    const select = screen.getByRole('combobox', { name: /structure for premier men/i });
    const names = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(names).toEqual([
      'Structure…',
      'Split league',
      'Quick-started league',
      'Migrated flat season',
    ]);
    const groups = Array.from(select.querySelectorAll('optgroup')).map((g) => g.label);
    expect(groups).toEqual(['Created by admin quick start', 'Migrated flat seasons']);
    // The operator's own structure is ungrouped, ahead of both groups.
    expect(select.querySelector('optgroup option[value="struct-two-block"]')).toBeNull();
  });

  it('two leagues picking the same template share ONE structure', async () => {
    const { user, save } = setup({
      leagues: [league(), league({ key: 'promo', label: 'Promotion Men' })],
    });

    await fillSeasonLabel(user);
    await user.click(continueBtn());

    await addLeague(user, 'premier');
    await user.click(screen.getByRole('radio', { name: /flat round robin/i }));
    await addLeague(user, 'promo');
    await user.click(screen.getAllByRole('radio', { name: /flat round robin/i })[1]);
    await user.click(continueBtn());
    await user.click(screen.getByRole('button', { name: /create season/i }));

    const patch = save.mock.calls[0][0];
    // Structures are durable blueprints — the template is minted once and both leagues
    // are set up on the same instance.
    expect(patch.structures).toHaveLength(1);
    expect(patch.leagues[0].setup.structureId).toBe(patch.structures[0].id);
    expect(patch.leagues[1].setup.structureId).toBe(patch.structures[0].id);
  });

  it('re-derives a held template structure’s later stage when the calendar grows a block after Back', async () => {
    // `instantiateTemplate` maps a template's later stages onto the calendar's SECOND
    // block at pick time — but the structure it mints is held in wizard state and never
    // re-instantiated. Going Back to step 0 and growing the calendar from one block to two
    // used to leave the split template's second stage stranded at block position 0, still
    // playing stage one's block, even though a real second block now exists. The fix
    // re-derives every held NEW template structure's block positions on the way past step
    // 0 — this pins that the later stage actually moves.
    const { user, save } = setup();

    await fillSeasonLabel(user);
    await user.click(continueBtn());

    await addLeague(user, 'premier');
    await user.click(screen.getByRole('radio', { name: /split league with mid-season swap/i }));

    // Step 0 unmounts on navigation, so returning to it resets the embedded calendar
    // form — refilling the label is what a real operator would do too.
    await user.click(screen.getByRole('button', { name: /^back$/i }));
    await fillSeasonLabel(user);
    await user.click(screen.getByRole('button', { name: /add block/i }));
    await user.click(continueBtn());
    await user.click(continueBtn());
    await user.click(screen.getByRole('button', { name: /create season/i }));

    const patch = save.mock.calls[0][0];
    expect(patch.structures).toHaveLength(1);
    expect(patch.structures[0].stages[0].schedule.blockIndex).toBe(0);
    expect(patch.structures[0].stages[1].schedule.blockIndex).toBe(1);
  });

  it('keeps an explicit "plays in" choice when the operator goes Back to step 0', async () => {
    const { user, save } = setup({
      calendars: [existingCalendar],
      leagues: [league(), league({ key: 'promo', label: 'Promotion Men' })],
    });

    await user.click(screen.getByRole('radio', { name: /use an existing calendar/i }));
    await user.click(continueBtn());
    await addLeague(user, 'premier');
    await user.click(screen.getByRole('radio', { name: /split league with mid-season swap/i }));
    await addLeague(user, 'promo');
    await user.click(
      screen.getAllByRole('radio', { name: /split league with mid-season swap/i })[1],
    );

    // One set of controls for the shared instance, not one per league — prefilled with
    // the default rule (stage 2 after the break, in Block 2).
    const stage2 = () =>
      screen.getByRole('combobox', {
        name: /split league with mid-season swap: stage 2 plays in/i,
      });
    expect(screen.getAllByRole('combobox', { name: /stage 2 plays in/i })).toHaveLength(1);
    expect(stage2()).toHaveValue('1');

    // The operator keeps the final round in Block 1, then goes back and forward again.
    await user.selectOptions(stage2(), '0');
    await user.click(screen.getByRole('button', { name: /^back$/i }));
    await user.click(continueBtn());
    expect(stage2()).toHaveValue('0');

    await user.click(continueBtn());
    await user.click(screen.getByRole('button', { name: /create season/i }));

    const patch = save.mock.calls[0][0];
    expect(patch.structures).toHaveLength(1);
    const [first, second] = patch.structures[0].stages;
    expect(first.schedule.blockIndex).toBe(0);
    expect(second.schedule.blockIndex).toBe(0);
    // Sharing a block with the stage before it, the final round is chained after it.
    expect(second.schedule.startAfter).toBe('previous-stage');
  });

  it('offers no "plays in" choice on a one-block calendar', async () => {
    const { user } = setup();
    await fillSeasonLabel(user);
    await user.click(continueBtn());
    await addLeague(user, 'premier');
    await user.click(screen.getByRole('radio', { name: /split league with mid-season swap/i }));
    expect(screen.queryByRole('combobox', { name: /plays in/i })).toBeNull();
  });

  const OVERRUN_LINE =
    'Split league plays in Block 2 but this calendar has only 1 block — extend the calendar or choose differently';

  it('refuses an existing structure that plays past the draft calendar’s last block', async () => {
    const { user } = setup({
      structures: [twoBlockStructure],
      leagues: [league(), league({ key: 'promo', label: 'Promotion Men' })],
    });

    // A freshly-created calendar defaults to one block, but `twoBlockStructure`'s second
    // stage names block position 1 — the server would 400 the binding.
    await fillSeasonLabel(user);
    await user.click(continueBtn());

    await addLeague(user, 'premier', /use an existing structure/i);
    const picker = screen.getByRole('combobox', { name: /structure for premier men/i });
    await user.selectOptions(picker, 'struct-two-block');

    // The red line replaces the narrative, the fit verdict and any gold lines.
    expect(screen.getByText(OVERRUN_LINE)).toBeInTheDocument();
    expect(screen.queryByText(/⚠/)).toBeNull();
    expect(screen.queryByText(/has no stage playing in it/)).toBeNull();
    expect(screen.queryByText(/What Split league does/)).toBeNull();

    await addLeague(user, 'promo');
    const radios = screen.getAllByRole('radio', { name: /flat round robin/i });
    await user.click(radios[radios.length - 1]);
    // The overrunning pick blocks Continue and says which league and what to do.
    expect(continueBtn()).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Premier Men's structure plays in a block .* doesn't have — pick another structure or remove it\./,
    );
  });

  it('refuses a cloned adoption of a quick-start structure that overruns the draft calendar', async () => {
    const quickStarted: CompetitionStructure = {
      ...twoBlockStructure,
      id: 'struct-qs',
      name: 'Split league',
      source: 'quick-start',
    };
    const { user } = setup({ structures: [quickStarted] });

    await fillSeasonLabel(user);
    await user.click(continueBtn());
    await addLeague(user, 'premier', /use an existing structure/i);
    await user.selectOptions(
      screen.getByRole('combobox', { name: /structure for premier men/i }),
      'struct-qs',
    );

    expect(screen.getByText(OVERRUN_LINE)).toBeInTheDocument();
    expect(screen.queryByText(/gets its own copy/)).toBeNull();

    // No clone is offered and the step cannot be left with the pick in place.
    expect(continueBtn()).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Premier Men's structure plays in a block/);
  });

  it('an overrunning pick becomes committable once the calendar grows the block it needs', async () => {
    const { user, save } = setup({ structures: [twoBlockStructure] });

    await fillSeasonLabel(user);
    await user.click(continueBtn());
    await addLeague(user, 'premier', /use an existing structure/i);
    await user.selectOptions(
      screen.getByRole('combobox', { name: /structure for premier men/i }),
      'struct-two-block',
    );
    expect(screen.getByText(OVERRUN_LINE)).toBeInTheDocument();

    // Back to step 0 (its form remounts, so the label is refilled), add Block 2, return.
    await user.click(screen.getByRole('button', { name: /^back$/i }));
    await fillSeasonLabel(user);
    await user.click(screen.getByRole('button', { name: /add block/i }));
    await user.click(continueBtn());

    expect(screen.queryByText(/plays in Block 2 but this calendar has only/)).toBeNull();
    expect(screen.getByText(/What Split league does/)).toBeInTheDocument();
    await user.click(continueBtn());
    const create = screen.getByRole('button', { name: /create season/i });
    expect(create).toHaveTextContent('Create season · 1 league');
    await user.click(create);
    expect(save.mock.calls[0][0].leagues[0].setup).toEqual({
      structureId: 'struct-two-block',
      calendarId: save.mock.calls[0][0].calendars[0].id,
    });
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   The fit verdict sizes each stage the way it will really play.

   It used to preview every stage at a flat 12 teams: a two-pool round robin read as 11
   rounds instead of 5, so a pools structure warned "⚠" against a block it fits with room
   to spare. Now each stage is split into its own groups, a qualifier-counted knockout is
   sized exactly (2 pools × top 2 ⇒ 4 sides, 2 rounds), and a chained stage's rounds are
   counted after its feeder's.
   ───────────────────────────────────────────────────────────────────────────── */

describe('SeasonSetupWizard — fit verdict uses real group sizes', () => {
  /** Pools of 6 (5 rounds) then a chained within-group bracket of 4 (2 rounds): 7 weeks. */
  const poolsStructure: CompetitionStructure = {
    id: 'struct-pools',
    name: 'Pools to knockout',
    version: 1,
    stages: [
      {
        id: 'pools',
        name: 'Pool stage',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'seeded-split', method: 'blocks', groups: { kind: 'even', count: 2 } },
        schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
      },
      {
        id: 'finals',
        name: 'Semi-finals & final',
        format: { kind: 'knockout', pairing: 'within-pool' },
        entrants: {
          kind: 'manual',
          derivedFrom: {
            rule: 'from-standings',
            fromStage: 'pools',
            detail: 'Top two from each pool',
            qualifiersPerGroup: 2,
          },
        },
        schedule: { blockIndex: 0, cadence: { kind: 'weekly' }, startAfter: 'previous-stage' },
      },
    ],
  };

  /** One block of `end`'s worth of Saturdays from 12 Sep 2026. */
  const shortCalendar = (end: string): SeasonCalendar => ({
    id: 'cal-short',
    label: 'Short season',
    blocks: [{ id: 'b1', label: 'Block 1', start: '2026-09-12', end }],
    breaks: [],
    excludeDates: [],
  });

  async function pickPoolsStructure(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('radio', { name: /use an existing calendar/i }));
    await user.click(continueBtn());
    await addLeague(user, 'premier', /use an existing structure/i);
    await user.selectOptions(
      screen.getByRole('combobox', { name: /structure for premier men/i }),
      'struct-pools',
    );
  }

  it('fits a seven-Saturday block — pools of 6, then 4 qualifiers', async () => {
    // A flat 12 would be 11 rounds of pools alone, and warn.
    const { user } = setup({
      calendars: [shortCalendar('2026-10-24')],
      structures: [poolsStructure],
    });
    await pickPoolsStructure(user);

    expect(await screen.findByText(/✓ Fits the calendar/)).toBeInTheDocument();
    expect(screen.queryByText(/⚠/)).toBeNull();
  });

  it('warns on six Saturdays — the chained semis need the week after the pools', async () => {
    // Each stage fits six weeks on its own; only the combined 5 + 2 overruns.
    const { user } = setup({
      calendars: [shortCalendar('2026-10-17')],
      structures: [poolsStructure],
    });
    await pickPoolsStructure(user);

    expect(await screen.findByText(/⚠/)).toBeInTheDocument();
    expect(screen.queryByText(/✓ Fits the calendar/)).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   The explained wizard: an intro on step 0, template cards with the structure told as
   a story under the pick, "Adjust stages" editing the shared instance in place, the
   narrative on review, and what happens next on the done screen.
   ───────────────────────────────────────────────────────────────────────────── */

describe('SeasonSetupWizard — explained', () => {
  async function toLeagueStep(user: ReturnType<typeof userEvent.setup>) {
    await fillSeasonLabel(user);
    await user.click(continueBtn());
    await addLeague(user, 'premier');
  }

  it('opens with how a season fits together', () => {
    setup();
    expect(screen.getByText('How a season is set up')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: /how a season is put together/i })).toBeVisible();
    expect(screen.getByText(/three steps/i)).toBeVisible();
  });

  it('offers the templates as cards and tells the picked one as a story', async () => {
    const { user } = setup();
    await toLeagueStep(user);

    const split = screen.getByRole('radio', { name: /split league with mid-season swap/i });
    expect(split).not.toBeChecked();
    await user.click(split);
    expect(split).toBeChecked();

    // One sentence per stage, at an assumed 12 sides (nobody has registered yet).
    expect(screen.getByText(/^Stage 1 · Round-robin stage · chosen by the admin/)).toBeVisible();
    expect(screen.getByText(/^Stage 2 · Round-robin stage/)).toBeVisible();
    expect(screen.getByText('(assuming 12 sides)')).toBeVisible();
  });

  it('“Adjust stages” edits the instance in place, and the edit is what gets saved', async () => {
    const { user, save } = setup();
    await toLeagueStep(user);
    await user.click(screen.getByRole('radio', { name: /flat round robin/i }));

    const adjust = screen.getByRole('button', { name: /adjust stages/i });
    expect(adjust).toHaveAttribute('aria-expanded', 'false');
    await user.click(adjust);
    expect(screen.getByRole('region', { name: 'Who plays whom?' })).toBeVisible();

    await user.click(screen.getByRole('radio', { name: /^Double round robin/ }));
    // The narrative above follows the edit.
    expect(screen.getByText(/everyone plays everyone twice, home and away/)).toBeVisible();

    await user.click(continueBtn());
    await user.click(screen.getByRole('button', { name: /create season/i }));

    const patch = save.mock.calls[0][0];
    expect(patch.structures).toHaveLength(1);
    expect(patch.structures[0].stages[0].format).toEqual({ kind: 'round-robin', legs: 2 });
  });

  it('says so when an adjusted instance is shared with another league', async () => {
    const { user, save } = setup({
      leagues: [league(), league({ key: 'promo', label: 'Promotion Men' })],
    });
    await toLeagueStep(user);
    await user.click(screen.getByRole('radio', { name: /flat round robin/i }));
    await addLeague(user, 'promo');
    await user.click(screen.getAllByRole('radio', { name: /flat round robin/i })[1]);

    await user.click(screen.getAllByRole('button', { name: /adjust stages/i })[0]);
    expect(screen.getByText(/Promotion Men uses this structure too/)).toBeVisible();
    await user.click(screen.getByRole('radio', { name: /^Triple round robin/ }));

    await user.click(continueBtn());
    await user.click(screen.getByRole('button', { name: /create season/i }));
    const patch = save.mock.calls[0][0];
    // One shared instance, carrying the edit, bound by both leagues.
    expect(patch.structures).toHaveLength(1);
    expect(patch.structures[0].stages[0].format).toEqual({ kind: 'round-robin', legs: 3 });
    expect(patch.leagues[1].setup.structureId).toBe(patch.structures[0].id);
  });

  it('reviews each league as a story, then shows what happens next', async () => {
    const { user } = setup();
    await toLeagueStep(user);
    await user.click(screen.getByRole('radio', { name: /flat round robin/i }));
    await user.click(continueBtn());

    expect(screen.getByText(/^Stage 1 · Round-robin stage · all 12 sides/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /create season/i }));

    expect(await screen.findByText('What happens next')).toBeVisible();
    for (const step of [
      'Start the season',
      'Confirm entrants',
      'Generate fixtures',
      'Approve and release',
    ])
      expect(screen.getByText(step)).toBeVisible();
    expect(screen.getByText(/Fixtures & Venues → Start a season/)).toBeVisible();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Nothing preselected, and no format questions: an added league's row waits for the
   operator to say where its structure comes from, and never asks for a label, overs or
   ball type (those live on the structure now).
   ───────────────────────────────────────────────────────────────────────────── */

describe('SeasonSetupWizard — league rows', () => {
  it('preselects nothing and asks no match-format questions', async () => {
    const { user } = setup({ structures: [twoBlockStructure] });
    await fillSeasonLabel(user);
    await user.click(continueBtn());
    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'premier');

    const modes = screen.getByRole('radiogroup', {
      name: /where premier men's structure comes from/i,
    });
    for (const card of within(modes).getAllByRole('radio')) expect(card).not.toBeChecked();
    // No template cards until the mode is chosen.
    expect(screen.queryByRole('radio', { name: /flat round robin/i })).toBeNull();

    await user.click(within(modes).getByRole('radio', { name: /start from a template/i }));
    await user.click(screen.getByRole('radio', { name: /flat round robin/i }));
    expect(screen.queryByPlaceholderText(/competition label/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/^overs$/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/ball type/i)).toBeNull();
  });

  it('an added league must get a structure before Continue', async () => {
    const { user } = setup();
    await fillSeasonLabel(user);
    await user.click(continueBtn());
    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'premier');

    expect(continueBtn()).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Premier Men has no structure yet — pick a template or an existing structure, or remove it.',
    );

    await user.click(screen.getByRole('radio', { name: /start from a template/i }));
    await user.click(screen.getByRole('radio', { name: /flat round robin/i }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(continueBtn()).toBeEnabled();
  });

  it('a calendar with no leagues added still saves on its own', async () => {
    const { user, save } = setup();
    await fillSeasonLabel(user);
    await user.click(continueBtn());
    expect(continueBtn()).toBeEnabled();
    await user.click(continueBtn());
    await user.click(screen.getByRole('button', { name: /create season/i }));
    expect(save.mock.calls[0][0].leagues[0]).not.toHaveProperty('setup');
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Run again: a league whose setup names another calendar is offered on step 2 without
   adding it, unticked; a ticked row re-points `setup.calendarId` at the draft calendar and
   keeps the SAME structure (no structure is written).
   ───────────────────────────────────────────────────────────────────────────── */

describe('SeasonSetupWizard — run again', () => {
  const lastSeason: SeasonCalendar = {
    id: 'cal-prev',
    label: '2025/26',
    blocks: [
      { id: 'p1', label: 'Block 1', start: '2025-09-13', end: '2025-12-13' },
      { id: 'p2', label: 'Block 2', start: '2026-01-17', end: '2026-03-28' },
    ],
    breaks: [],
    excludeDates: [],
  };
  /** One stage in block position 0 — leaves a two-block calendar's Block 2 empty. */
  const oneBlockStructure: CompetitionStructure = {
    id: 'struct-flat',
    name: 'Flat league',
    version: 1,
    stages: [twoBlockStructure.stages[0]],
  };
  const onLastSeason = (structureId = 'struct-two-block') => ({
    structureId,
    calendarId: 'cal-prev',
  });

  /** Onto the existing two-block 2026/27 calendar, then step 2. */
  async function toStep2OnExisting(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('radio', { name: /use an existing calendar/i }));
    await user.click(continueBtn());
  }
  const createBtn = () => screen.getByRole('button', { name: /create season/i });

  it('lists the current setup unticked, naming the draft calendar and its structure', async () => {
    const { user } = setup({
      calendars: [existingCalendar, lastSeason],
      structures: [twoBlockStructure],
      leagues: [league({ setup: onLastSeason() })],
    });
    await toStep2OnExisting(user);

    expect(
      screen.getByText('Premier Men — Run again on 2026/27: Split league'),
    ).toBeInTheDocument();
    expect(screen.getByText('Currently on 2025/26')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /premier men/i })).not.toBeChecked();
    // Listed without being added — and so not offered in "Add a league" either.
    expect(screen.queryByRole('combobox', { name: /add a league/i })).toBeNull();
  });

  it('offers nothing for a league already set up on the draft calendar, or not set up', async () => {
    const { user } = setup({
      calendars: [existingCalendar, lastSeason],
      structures: [twoBlockStructure],
      leagues: [
        league({ setup: { structureId: 'struct-two-block', calendarId: 'cal-existing' } }),
        league({ key: 'promo', label: 'Promotion Men' }),
      ],
    });
    await toStep2OnExisting(user);

    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByText('Already set up on 2026/27')).toBeInTheDocument();
    expect(screen.getByText('Premier Men — Split league')).toBeInTheDocument();
  });

  it('a ticked row re-points the setup at the draft calendar, same structure, nothing else', async () => {
    const legacy = [{ id: 'c1', label: 'Old', structureId: 'struct-two-block', calendarId: 'x' }];
    const { user, save } = setup({
      calendars: [existingCalendar, lastSeason],
      structures: [twoBlockStructure],
      leagues: [league({ setup: onLastSeason(), competitions: legacy } as Partial<League>)],
    });
    await toStep2OnExisting(user);

    await user.click(screen.getByRole('checkbox', { name: /premier men/i }));
    // Ticked, the row tells the structure as a story with its fit.
    expect(screen.getByText('What Split league does')).toBeInTheDocument();
    await user.click(continueBtn());

    expect(screen.getByText(/run again \(Split league\)/)).toBeInTheDocument();
    // The review names what the change replaces.
    expect(screen.getByTestId('replaces-line')).toHaveTextContent(
      'Replaces the current setup: Split league · 2025/26',
    );
    expect(createBtn()).toHaveTextContent('Create season · 1 league');
    await user.click(createBtn());

    const patch = save.mock.calls[0][0];
    // Run again writes no structure.
    expect(patch.structures).toEqual([twoBlockStructure]);
    expect(patch.leagues[0].setup).toEqual({
      structureId: 'struct-two-block',
      calendarId: 'cal-existing',
    });
    // The deprecated competitions are passed through byte-unchanged.
    expect(patch.leagues[0].competitions).toEqual(legacy);
    expect(await screen.findByText(/is updated/i)).toBeInTheDocument();
  });

  it('an unticked row writes nothing', async () => {
    const { user, save } = setup({
      calendars: [existingCalendar, lastSeason],
      structures: [twoBlockStructure],
      leagues: [league({ setup: onLastSeason() })],
    });
    await toStep2OnExisting(user);
    await user.click(continueBtn());
    expect(createBtn()).toHaveTextContent(/^Create season$/);
    await user.click(createBtn());

    expect(save.mock.calls[0][0].leagues[0].setup).toEqual(onLastSeason());
  });

  it('"Select all" ticks every row and "Clear" unticks them', async () => {
    const { user } = setup({
      calendars: [existingCalendar, lastSeason],
      structures: [twoBlockStructure],
      leagues: [
        league({ setup: onLastSeason() }),
        league({ key: 'promo', label: 'Promotion Men', setup: onLastSeason() }),
      ],
    });
    await toStep2OnExisting(user);

    await user.click(screen.getByRole('button', { name: 'Select all 2' }));
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeChecked();
    await user.click(continueBtn());
    expect(createBtn()).toHaveTextContent('Create season · 2 leagues');
    await user.click(screen.getByRole('button', { name: /^back$/i }));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
  });

  it('"Choose differently" hides the row and opens the chooser; review shows the replaces-line', async () => {
    const { user, save } = setup({
      calendars: [existingCalendar, lastSeason],
      structures: [twoBlockStructure],
      leagues: [league({ setup: onLastSeason() })],
    });
    await toStep2OnExisting(user);

    await user.click(screen.getByRole('button', { name: /choose differently for premier men/i }));
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByText('Currently set up: Split league · 2025/26')).toBeInTheDocument();

    // Removing it from the chooser brings the row back.
    await user.click(screen.getByRole('button', { name: /^remove$/i }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /choose differently for premier men/i }));
    await user.click(screen.getByRole('radio', { name: /start from a template/i }));
    await user.click(screen.getByRole('radio', { name: /flat round robin/i }));
    await user.click(continueBtn());
    expect(screen.getByTestId('replaces-line')).toHaveTextContent(
      'Replaces the current setup: Split league · 2025/26',
    );
    await user.click(createBtn());
    const patch = save.mock.calls[0][0];
    const minted = patch.structures.find((s: CompetitionStructure) => s.id !== 'struct-two-block');
    expect(patch.leagues[0].setup).toEqual({
      structureId: minted.id,
      calendarId: 'cal-existing',
    });
  });

  it('refuses a row whose structure plays past the calendar’s last block', async () => {
    const { user } = setup({
      calendars: [lastSeason],
      structures: [twoBlockStructure],
      leagues: [league({ setup: onLastSeason() })],
    });
    // A new calendar starts with one block; the split league plays in Block 2.
    await fillSeasonLabel(user);
    await user.click(continueBtn());

    const line =
      'Split league plays in Block 2 but this calendar has only 1 block — extend the calendar or choose differently';
    expect(screen.getByText(line)).toBeInTheDocument();
    const box = screen.getByRole('checkbox', { name: /premier men/i });
    expect(box).toBeDisabled();
    // The disabled checkbox names its reason for assistive tech.
    expect(box).toHaveAccessibleDescription(line);
    expect(screen.queryByRole('button', { name: /select all/i })).toBeNull();
  });

  it('warns in gold about a block the structure leaves empty, and still creates', async () => {
    const { user, save } = setup({
      calendars: [existingCalendar, lastSeason],
      structures: [oneBlockStructure],
      leagues: [league({ setup: onLastSeason('struct-flat') })],
    });
    await toStep2OnExisting(user);
    await user.click(screen.getByRole('checkbox', { name: /premier men/i }));
    expect(screen.getByText(/^Block 2 \(.+\) has no stage playing in it$/)).toBeInTheDocument();

    await user.click(continueBtn());
    expect(screen.getByText(/^Block 2 \(.+\) has no stage playing in it$/)).toBeInTheDocument();
    expect(createBtn()).toBeEnabled();
    await user.click(createBtn());
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('adopting a quick-start structure clones it for the adopting league', async () => {
    const quickStarted: CompetitionStructure = {
      ...oneBlockStructure,
      id: 'struct-qs',
      name: 'Premier Men · Flat round robin',
      templateId: 'flat-round-robin',
      source: 'quick-start',
    };
    const { user, save } = setup({
      calendars: [existingCalendar, lastSeason],
      structures: [quickStarted],
      leagues: [league(), league({ key: 'promo', label: 'Promotion Men' })],
    });
    await toStep2OnExisting(user);

    for (const [key, name] of [
      ['premier', /structure for premier men/i],
      ['promo', /structure for promotion men/i],
    ] as const) {
      await addLeague(user, key, /use an existing structure/i);
      const select = screen.getByRole('combobox', { name });
      expect(
        select.querySelector('optgroup[label="Created by admin quick start"] option'),
      ).toHaveTextContent('Premier Men · Flat round robin');
      await user.selectOptions(select, 'struct-qs');
    }
    expect(screen.getByText(/Promotion Men gets its own copy/)).toBeInTheDocument();
    await user.click(continueBtn());
    expect(screen.getAllByText(/own copy of Premier Men · Flat round robin/)).toHaveLength(2);
    await user.click(createBtn());

    const patch = save.mock.calls[0][0];
    // The original is untouched; each adopting league gets its OWN operator copy.
    expect(patch.structures).toHaveLength(3);
    expect(patch.structures[0]).toEqual(quickStarted);
    const clones = patch.structures.slice(1) as CompetitionStructure[];
    expect(clones.map((c) => c.name)).toEqual([
      'Premier Men · Flat round robin',
      'Promotion Men · Premier Men · Flat round robin',
    ]);
    for (const c of clones) {
      expect(c.id).not.toBe('struct-qs');
      expect(c.source).toBeUndefined();
      expect(c.templateId).toBeUndefined();
      expect(c.stages).toEqual(quickStarted.stages);
    }
    expect(patch.leagues[0].setup.structureId).toBe(clones[0].id);
    expect(patch.leagues[1].setup.structureId).toBe(clones[1].id);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Choices the wizard accepted must either be applied or refused out loud — never
   dropped silently, and never lost to a stray click or Escape.
   ───────────────────────────────────────────────────────────────────────────── */

describe('SeasonSetupWizard — nothing accepted is silently dropped', () => {
  const lastSeason: SeasonCalendar = {
    id: 'cal-prev',
    label: '2025/26',
    blocks: [
      { id: 'p1', label: 'Block 1', start: '2025-09-13', end: '2025-12-13' },
      { id: 'p2', label: 'Block 2', start: '2026-01-17', end: '2026-03-28' },
    ],
    breaks: [],
    excludeDates: [],
  };

  it('a backdrop click never closes it, and Escape asks before discarding typed input', async () => {
    const { user, onClose } = setup();
    await fillSeasonLabel(user);

    await user.click(document.querySelector('.task-modal-backdrop') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(screen.getByText('Discard your changes?')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByText('Discard your changes?')).toBeNull();
    expect(screen.getByPlaceholderText('e.g. 2026/27')).toHaveValue('2026/27');

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes at once on Escape when nothing has been entered', async () => {
    const { user, onClose } = setup();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('Discard your changes?')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('refuses a customised template instance left in a block the calendar no longer has', async () => {
    const { user } = setup();
    await fillSeasonLabel(user);
    await user.click(screen.getByRole('button', { name: /add block/i }));
    await user.click(continueBtn());
    await addLeague(user, 'premier');
    await user.click(screen.getByRole('radio', { name: /split league with mid-season swap/i }));
    // Any "Adjust stages" edit makes the stages the operator's own: leaving step 0 no
    // longer re-derives them, so the final round stays in Block 2.
    await user.click(screen.getByRole('button', { name: /adjust stages/i }));
    await user.click(screen.getAllByRole('radio', { name: /^Triple round robin/ })[0]);

    // Back to step 0: its form remounts with the default single block.
    await user.click(screen.getByRole('button', { name: /^back$/i }));
    await fillSeasonLabel(user);
    await user.click(continueBtn());

    expect(continueBtn()).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Premier Men's structure plays in a block 2026/27 doesn't have — pick another structure or remove it.",
    );
  });

  it('a ticked "Run again" row that no longer fits blocks Continue until it is unticked', async () => {
    const { user } = setup({
      calendars: [lastSeason],
      structures: [twoBlockStructure],
      leagues: [league({ setup: { structureId: 'struct-two-block', calendarId: 'cal-prev' } })],
    });
    await fillSeasonLabel(user);
    await user.click(screen.getByRole('button', { name: /add block/i }));
    await user.click(continueBtn());
    await user.click(screen.getByRole('checkbox', { name: /premier men/i }));

    // Shrink the calendar back to one block.
    await user.click(screen.getByRole('button', { name: /^back$/i }));
    await fillSeasonLabel(user);
    await user.click(continueBtn());

    expect(continueBtn()).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Premier Men was ticked to run again but its structure plays in a block 2026/27 doesn't have — untick it or change the calendar.",
    );
    const box = screen.getByRole('checkbox', { name: /premier men/i });
    expect(box).toBeChecked();
    expect(box).toBeEnabled();

    await user.click(box);
    expect(box).not.toBeChecked();
    expect(box).toBeDisabled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(continueBtn()).toBeEnabled();
  });

  it('writes nothing when a planned league was deleted in another session', async () => {
    const { user, save, config } = setup({
      leagues: [league(), league({ key: 'promo', label: 'Promotion Men' })],
    });
    await fillSeasonLabel(user);
    await user.click(continueBtn());
    await addLeague(user, 'premier');
    await user.click(screen.getByRole('radio', { name: /flat round robin/i }));
    await addLeague(user, 'promo');
    await user.click(screen.getAllByRole('radio', { name: /flat round robin/i })[1]);
    await user.click(continueBtn());

    // The refetch at commit no longer has Promotion Men.
    vi.mocked(api.platformGetTenant).mockResolvedValue({
      ...config,
      leagues: [league()],
    } as TenantConfig);
    await user.click(screen.getByRole('button', { name: /create season/i }));

    expect(
      await screen.findByText(
        'Promotion Men was deleted in another session — nothing was saved. Close and start again.',
      ),
    ).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByText(/is created/i)).toBeNull();
  });
});
