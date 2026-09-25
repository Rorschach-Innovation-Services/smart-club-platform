/**
 * SeasonSetupWizard — the guided "set up a season" flow (ADR 0008 phase 3).
 *
 * Covers the four load-bearing paths: a brand-new calendar with one league bound from a
 * template writing a single PUT; skipping every league writing only the calendar; picking
 * an EXISTING calendar upserting it rather than duplicating it; and the live fit verdict
 * turning into a warning when a bound structure names a block position the draft calendar
 * doesn't have.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SeasonSetupWizard', () => {
  it('creates a new calendar and binds one league from a template in a single PUT', async () => {
    const { user, save } = setup();

    await fillSeasonLabel(user);
    await user.click(continueBtn());

    // Step 2 is opt-IN: leagues are untouched until explicitly added. Adding one opens
    // its row already on "Start from a template".
    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'premier');
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
    expect(patch.leagues[0].competitions).toHaveLength(1);
    expect(patch.leagues[0].competitions[0]).toMatchObject({
      label: 'Flat round robin',
      structureId: patch.structures[0].id,
      calendarId: patch.calendars[0].id,
    });

    // Terminal Done summary.
    expect(await screen.findByText(/is created/i)).toBeInTheDocument();
    expect(screen.getByText(/Premier Men/)).toBeInTheDocument();
  });

  it('adding no league writes only the calendar', async () => {
    const { user, save } = setup();

    await fillSeasonLabel(user);
    await user.click(continueBtn());
    // No league added — the step is opt-in, so Continue is always allowed.
    await user.click(continueBtn());
    // The untouched majority collapses to a count line on review.
    expect(screen.getByText(/1 league keeps the flat series flow/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /create season/i }));

    expect(save).toHaveBeenCalledTimes(1);
    const patch = save.mock.calls[0][0];
    expect(patch.calendars).toHaveLength(1);
    expect(patch.structures).toEqual([]);
    expect(patch.leagues[0].competitions ?? []).toHaveLength(0);
    expect(await screen.findByText(/no leagues were bound/i)).toBeInTheDocument();
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
    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'premier');
    // No operator structure exists, so "Use an existing structure" is not offered.
    expect(screen.getByRole('radio', { name: /use an existing structure/i })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: /flat round robin/i }));
    await user.click(continueBtn());
    await user.click(screen.getByRole('button', { name: /create season/i }));

    const patch = save.mock.calls[0][0];
    expect(patch.structures).toHaveLength(2);
    const fresh = patch.structures.find((s: CompetitionStructure) => s.id !== 'struct-qs');
    expect(fresh.templateId).toBe('flat-round-robin');
    expect(patch.leagues[0].competitions[0].structureId).toBe(fresh.id);
  });

  it('lists only operator structures under "Use an existing structure"', async () => {
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
    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'premier');
    await user.click(screen.getByRole('radio', { name: /use an existing structure/i }));
    const select = screen.getByRole('combobox', { name: /structure for premier men/i });
    const names = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(names).toContain('Split league');
    expect(names).not.toContain('Quick-started league');
    expect(names).not.toContain('Migrated flat season');
  });

  it('two leagues picking the same template share ONE structure', async () => {
    const { user, save } = setup({
      leagues: [league(), league({ key: 'promo', label: 'Promotion Men' })],
    });

    await fillSeasonLabel(user);
    await user.click(continueBtn());

    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'premier');
    await user.click(screen.getByRole('radio', { name: /flat round robin/i }));
    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'promo');
    await user.click(screen.getAllByRole('radio', { name: /flat round robin/i })[1]);
    await user.click(continueBtn());
    await user.click(screen.getByRole('button', { name: /create season/i }));

    const patch = save.mock.calls[0][0];
    // Structures are durable blueprints — the template is minted once and both leagues
    // bind competitions to the same instance.
    expect(patch.structures).toHaveLength(1);
    expect(patch.leagues[0].competitions[0].structureId).toBe(patch.structures[0].id);
    expect(patch.leagues[1].competitions[0].structureId).toBe(patch.structures[0].id);
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

    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'premier');
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
    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'premier');
    await user.click(screen.getByRole('radio', { name: /split league with mid-season swap/i }));
    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'promo');
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
    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'premier');
    await user.click(screen.getByRole('radio', { name: /split league with mid-season swap/i }));
    expect(screen.queryByRole('combobox', { name: /plays in/i })).toBeNull();
  });

  it('shows a fit warning when a bound structure names a block the draft calendar lacks', async () => {
    const { user } = setup({ structures: [twoBlockStructure] });

    // A freshly-created calendar defaults to one block, but `twoBlockStructure`'s second
    // stage names block position 1 — it cannot fit.
    await fillSeasonLabel(user);
    await user.click(continueBtn());

    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'premier');
    await user.click(screen.getByRole('radio', { name: /use an existing structure/i }));
    const picker = screen.getByRole('combobox', { name: /structure for premier men/i });
    await user.selectOptions(picker, 'struct-two-block');

    expect(await screen.findByText(/⚠/)).toBeInTheDocument();
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
    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'premier');
    await user.click(screen.getByRole('radio', { name: /use an existing structure/i }));
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
    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'premier');
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
    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'promo');
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
    expect(patch.leagues[1].competitions[0].structureId).toBe(patch.structures[0].id);
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
