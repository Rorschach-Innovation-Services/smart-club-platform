/**
 * SeasonSetupWizard — the guided "set up a season" flow (ADR 0008 phase 3).
 *
 * Covers the four load-bearing paths: a brand-new calendar with one league bound from a
 * template writing a single PUT; skipping every league writing only the calendar; picking
 * an EXISTING calendar upserting it rather than duplicating it; and a bound structure
 * naming a block position the draft calendar doesn't have being refused on its row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SeasonSetupWizard } from './platform-season-wizard';
import type {
  Competition,
  CompetitionStructure,
  League,
  SeasonCalendar,
  TenantConfig,
} from './types';
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
    // The template pick never prefills from a quick-start structure, even one cloned from
    // the same template.
    await user.click(screen.getByRole('radio', { name: /flat round robin/i }));
    await user.click(continueBtn());
    await user.click(screen.getByRole('button', { name: /create season/i }));

    const patch = save.mock.calls[0][0];
    expect(patch.structures).toHaveLength(2);
    const fresh = patch.structures.find((s: CompetitionStructure) => s.id !== 'struct-qs');
    expect(fresh.templateId).toBe('flat-round-robin');
    expect(patch.leagues[0].competitions[0].structureId).toBe(fresh.id);
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
    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'premier');
    await user.click(screen.getByRole('radio', { name: /use an existing structure/i }));
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

    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'premier');
    await user.click(screen.getByRole('radio', { name: /use an existing structure/i }));
    const picker = screen.getByRole('combobox', { name: /structure for premier men/i });
    await user.selectOptions(picker, 'struct-two-block');

    // The red line replaces the narrative, the fit verdict and any gold lines.
    expect(screen.getByText(OVERRUN_LINE)).toBeInTheDocument();
    expect(screen.queryByText(/⚠/)).toBeNull();
    expect(screen.queryByText(/has no stage playing in it/)).toBeNull();
    expect(screen.queryByText(/What Split league does/)).toBeNull();

    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'promo');
    const radios = screen.getAllByRole('radio', { name: /flat round robin/i });
    await user.click(radios[radios.length - 1]);
    await user.click(continueBtn());

    // Only the template pick is planned; the overrunning pick is named as left unchanged.
    expect(screen.getByRole('button', { name: /create season/i })).toHaveTextContent(
      'Create season · 1 competition',
    );
    expect(screen.getByText(/Premier Men \(its structure plays past/)).toBeInTheDocument();
  });

  it('refuses a cloned adoption of a quick-start structure that overruns the draft calendar', async () => {
    const quickStarted: CompetitionStructure = {
      ...twoBlockStructure,
      id: 'struct-qs',
      name: 'Split league',
      source: 'quick-start',
    };
    const { user, save } = setup({ structures: [quickStarted] });

    await fillSeasonLabel(user);
    await user.click(continueBtn());
    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'premier');
    await user.click(screen.getByRole('radio', { name: /use an existing structure/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: /structure for premier men/i }),
      'struct-qs',
    );

    expect(screen.getByText(OVERRUN_LINE)).toBeInTheDocument();
    expect(screen.queryByText(/gets its own copy/)).toBeNull();

    await user.click(continueBtn());
    const create = screen.getByRole('button', { name: /create season/i });
    expect(create).toHaveTextContent(/^Create season$/);
    await user.click(create);
    // Only the calendar is written — no clone, no competition.
    const patch = save.mock.calls[0][0];
    expect(patch.structures).toEqual([quickStarted]);
    expect(patch.leagues[0].competitions ?? []).toHaveLength(0);
  });

  it('an overrunning pick becomes committable once the calendar grows the block it needs', async () => {
    const { user, save } = setup({ structures: [twoBlockStructure] });

    await fillSeasonLabel(user);
    await user.click(continueBtn());
    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'premier');
    await user.click(screen.getByRole('radio', { name: /use an existing structure/i }));
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
    expect(create).toHaveTextContent('Create season · 1 competition');
    await user.click(create);
    expect(save.mock.calls[0][0].leagues[0].competitions[0].structureId).toBe('struct-two-block');
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

/* ─────────────────────────────────────────────────────────────────────────────
   Same as last season: a league's prior format streams are listed on step 2 without
   adding the league, unticked; a ticked row binds a NEW competition to the SAME
   structure on the draft calendar and writes no structure.
   ───────────────────────────────────────────────────────────────────────────── */

describe('SeasonSetupWizard — same as last season', () => {
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
  const twoSeasonsAgo: SeasonCalendar = {
    ...lastSeason,
    id: 'cal-older',
    label: '2024/25',
    blocks: [
      { id: 'o1', label: 'Block 1', start: '2024-09-14', end: '2024-12-14' },
      { id: 'o2', label: 'Block 2', start: '2025-01-18', end: '2025-03-29' },
    ],
  };
  /** One stage in block position 0 — leaves a two-block calendar's Block 2 empty. */
  const oneBlockStructure: CompetitionStructure = {
    id: 'struct-flat',
    name: 'Flat league',
    version: 1,
    stages: [twoBlockStructure.stages[0]],
  };
  const fiftyOver: Competition = {
    id: 'comp-50',
    label: '50 Over (Red Ball)',
    structureId: 'struct-two-block',
    calendarId: 'cal-prev',
    matchFormat: { overs: 50, ballType: 'Red' },
  };
  const t20: Competition = {
    id: 'comp-t20',
    label: 'T20 (Pink Ball)',
    structureId: 'struct-two-block',
    calendarId: 'cal-prev',
    matchFormat: { overs: 20, ballType: 'Pink', label: 'T20' },
  };

  /** Onto the existing two-block 2026/27 calendar, then step 2. */
  async function toStep2OnExisting(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('radio', { name: /use an existing calendar/i }));
    await user.click(continueBtn());
  }
  const createBtn = () => screen.getByRole('button', { name: /create season/i });

  it('lists the prior competition unticked, naming its structure and old calendar', async () => {
    const { user } = setup({
      calendars: [existingCalendar, lastSeason],
      structures: [twoBlockStructure],
      leagues: [league({ competitions: [fiftyOver] })],
    });
    await toStep2OnExisting(user);

    expect(
      screen.getByText('Premier Men — Same as last season: Split league (2025/26)'),
    ).toBeInTheDocument();
    expect(screen.getByText('50 Over (Red Ball) · 50 overs · Red ball')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /50 Over/ })).not.toBeChecked();
    // Listed without being added — and so not offered in "Add a league" either.
    expect(screen.queryByRole('combobox', { name: /add a league/i })).toBeNull();
  });

  it('keeps the competition from the most recent calendar when a stream ran twice', async () => {
    const { user } = setup({
      calendars: [existingCalendar, twoSeasonsAgo, lastSeason],
      structures: [twoBlockStructure],
      leagues: [
        league({
          competitions: [
            { ...fiftyOver, id: 'comp-50-new' },
            { ...fiftyOver, id: 'comp-50-old', calendarId: 'cal-older' },
          ],
        }),
      ],
    });
    await toStep2OnExisting(user);

    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByText(/Same as last season: Split league \(2025\/26\)/)).toBeInTheDocument();
  });

  it('a ticked row commits a new competition on the same structure, matchFormat carried', async () => {
    const { user, save } = setup({
      calendars: [existingCalendar, lastSeason],
      structures: [twoBlockStructure],
      leagues: [league({ competitions: [fiftyOver] })],
    });
    await toStep2OnExisting(user);

    await user.click(screen.getByRole('checkbox', { name: /50 Over/ }));
    // Ticked, the row tells the structure as a story with its fit.
    expect(screen.getByText('What Split league does')).toBeInTheDocument();
    // (Its double round of 12 overruns Block 1 — a warning, never a block on the tick.)
    expect(screen.getByText(/^⚠ /)).toBeInTheDocument();
    await user.click(continueBtn());

    expect(screen.getByText(/same as last season \(Split league\)/)).toBeInTheDocument();
    expect(createBtn()).toHaveTextContent('Create season · 1 competition');
    await user.click(createBtn());

    const patch = save.mock.calls[0][0];
    // Reuse writes no structure.
    expect(patch.structures).toEqual([twoBlockStructure]);
    const comps = patch.leagues[0].competitions as Competition[];
    expect(comps).toHaveLength(2);
    expect(comps[0]).toEqual(fiftyOver);
    expect(comps[1].id).not.toBe('comp-50');
    expect(comps[1]).toEqual({
      id: comps[1].id,
      label: '50 Over (Red Ball)',
      structureId: 'struct-two-block',
      calendarId: 'cal-existing',
      matchFormat: { overs: 50, ballType: 'Red' },
    });
    expect(await screen.findByText(/is updated/i)).toBeInTheDocument();
  });

  it('an unticked row writes nothing', async () => {
    const { user, save } = setup({
      calendars: [existingCalendar, lastSeason],
      structures: [twoBlockStructure],
      leagues: [league({ competitions: [fiftyOver] })],
    });
    await toStep2OnExisting(user);
    await user.click(continueBtn());
    expect(createBtn()).toHaveTextContent(/^Create season$/);
    await user.click(createBtn());

    const patch = save.mock.calls[0][0];
    expect(patch.structures).toEqual([twoBlockStructure]);
    expect(patch.leagues[0].competitions).toEqual([fiftyOver]);
  });

  it('two streams on one structure tick independently and BOTH land on commit', async () => {
    // The old per-league guard skipped a league already bound on the draft calendar, so
    // the second stream (or both, given the friendly below) silently vanished.
    const friendly: Competition = {
      id: 'comp-friendly',
      label: 'Friendly',
      structureId: 'struct-two-block',
      calendarId: 'cal-existing',
    };
    const { user, save } = setup({
      calendars: [existingCalendar, lastSeason],
      structures: [twoBlockStructure],
      leagues: [league({ competitions: [fiftyOver, t20, friendly] })],
    });
    await toStep2OnExisting(user);

    const fifty = screen.getByRole('checkbox', { name: /50 Over/ });
    const pink = screen.getByRole('checkbox', { name: /T20/ });
    await user.click(pink);
    expect(pink).toBeChecked();
    expect(fifty).not.toBeChecked();
    await user.click(fifty);
    await user.click(continueBtn());
    expect(createBtn()).toHaveTextContent('Create season · 2 competitions');
    await user.click(createBtn());

    const comps = save.mock.calls[0][0].leagues[0].competitions as Competition[];
    const added = comps.slice(3);
    expect(added.map((c) => c.label).sort()).toEqual(['50 Over (Red Ball)', 'T20 (Pink Ball)']);
    for (const c of added) {
      expect(c.structureId).toBe('struct-two-block');
      expect(c.calendarId).toBe('cal-existing');
    }
    expect(added.find((c) => c.label === 'T20 (Pink Ball)')?.matchFormat).toEqual(t20.matchFormat);
    // The done screen names each competition.
    expect(await screen.findByText('50 Over (Red Ball)')).toBeInTheDocument();
    expect(screen.getByText('T20 (Pink Ball)')).toBeInTheDocument();
  });

  it('drops only an IDENTICAL binding another session already wrote', async () => {
    const { user, save, config } = setup({
      calendars: [existingCalendar, lastSeason],
      structures: [twoBlockStructure],
      leagues: [league({ competitions: [fiftyOver, t20] })],
    });
    // Between opening the wizard and creating, another tab renewed the T20 stream.
    const renewedT20: Competition = { ...t20, id: 'comp-t20-renewed', calendarId: 'cal-existing' };
    vi.mocked(api.platformGetTenant).mockResolvedValue({
      ...config,
      leagues: [league({ competitions: [fiftyOver, t20, renewedT20] })],
    });
    await toStep2OnExisting(user);
    await user.click(screen.getByRole('button', { name: /select all 2/i }));
    await user.click(continueBtn());
    await user.click(createBtn());

    const comps = save.mock.calls[0][0].leagues[0].competitions as Competition[];
    expect(comps).toHaveLength(4);
    expect(comps.filter((c) => c.label === 'T20 (Pink Ball)')).toHaveLength(2);
    expect(comps[3]).toMatchObject({ label: '50 Over (Red Ball)', calendarId: 'cal-existing' });
  });

  it('"Select all" ticks every row and "Clear" unticks them', async () => {
    const { user } = setup({
      calendars: [existingCalendar, lastSeason],
      structures: [twoBlockStructure],
      leagues: [league({ competitions: [fiftyOver, t20] })],
    });
    await toStep2OnExisting(user);

    await user.click(screen.getByRole('button', { name: 'Select all 2' }));
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
  });

  it('"Choose differently" hides the league\'s rows and opens the chooser', async () => {
    const { user } = setup({
      calendars: [existingCalendar, lastSeason],
      structures: [twoBlockStructure],
      leagues: [league({ competitions: [fiftyOver, t20] })],
    });
    await toStep2OnExisting(user);

    await user.click(
      screen.getAllByRole('button', { name: /choose differently for premier men/i })[0],
    );
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByText(/Same as last season:/)).toBeNull();
    expect(screen.getByRole('radio', { name: /flat round robin/i })).toBeInTheDocument();

    // Removing it from the chooser brings the rows back.
    await user.click(screen.getByRole('button', { name: /^remove$/i }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  it('refuses a row whose structure plays past the calendar’s last block', async () => {
    const { user } = setup({
      calendars: [lastSeason],
      structures: [twoBlockStructure],
      leagues: [league({ competitions: [fiftyOver] })],
    });
    // A new calendar starts with one block; the split league plays in Block 2.
    await fillSeasonLabel(user);
    await user.click(continueBtn());

    expect(
      screen.getByText(
        'Split league plays in Block 2 but this calendar has only 1 block — extend the calendar or choose differently',
      ),
    ).toBeInTheDocument();
    const box = screen.getByRole('checkbox', { name: /50 Over/ });
    expect(box).toBeDisabled();
    // The disabled checkbox names its reason for assistive tech.
    expect(box).toHaveAccessibleDescription(
      'Split league plays in Block 2 but this calendar has only 1 block — extend the calendar or choose differently',
    );
    expect(screen.queryByRole('button', { name: /select all/i })).toBeNull();
  });

  it('warns in gold about a block the structure leaves empty, and still creates', async () => {
    const { user, save } = setup({
      calendars: [existingCalendar, lastSeason],
      structures: [oneBlockStructure],
      leagues: [
        league({
          competitions: [{ ...fiftyOver, structureId: 'struct-flat', matchFormat: undefined }],
        }),
      ],
    });
    await toStep2OnExisting(user);
    await user.click(screen.getByRole('checkbox', { name: /50 Over/ }));
    expect(screen.getByText(/^Block 2 \(.+\) has no stage playing in it$/)).toBeInTheDocument();

    await user.click(continueBtn());
    expect(screen.getByText(/^Block 2 \(.+\) has no stage playing in it$/)).toBeInTheDocument();
    expect(createBtn()).toBeEnabled();
    await user.click(createBtn());
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('counts reuse ticks and chooser picks on the Create button', async () => {
    const { user } = setup({
      calendars: [existingCalendar, lastSeason],
      structures: [twoBlockStructure],
      leagues: [
        league({ competitions: [fiftyOver] }),
        league({ key: 'promo', label: 'Promotion Men' }),
      ],
    });
    await toStep2OnExisting(user);
    await user.click(screen.getByRole('checkbox', { name: /50 Over/ }));
    // Only the league with nothing reusable is offered in the chooser.
    const add = screen.getByRole('combobox', { name: /add a league/i });
    expect(Array.from(add.querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      'Add a league…',
      'Promotion Men',
    ]);
    await user.selectOptions(add, 'promo');
    await user.click(screen.getByRole('radio', { name: /flat round robin/i }));
    await user.click(continueBtn());

    expect(createBtn()).toHaveTextContent('Create season · 2 competitions');
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
      leagues: [
        // Bound to a quick-start structure: never a reuse row (ADR 0014).
        league({
          competitions: [{ ...fiftyOver, structureId: 'struct-qs', matchFormat: undefined }],
        }),
        league({ key: 'promo', label: 'Promotion Men' }),
      ],
    });
    await toStep2OnExisting(user);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);

    for (const [key, name] of [
      ['premier', /structure for premier men/i],
      ['promo', /structure for promotion men/i],
    ] as const) {
      await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), key);
      const radios = screen.getAllByRole('radio', { name: /use an existing structure/i });
      await user.click(radios[radios.length - 1]);
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
    expect(new Set(clones.map((c) => c.id)).size).toBe(2);
    for (const c of clones) {
      expect(c.id).not.toBe('struct-qs');
      expect(c.source).toBeUndefined();
      // No templateId either: a league-named clone must never become resolveTemplate's
      // prefill for a future template pick.
      expect(c.templateId).toBeUndefined();
      expect(c.stages).toEqual(quickStarted.stages);
    }
    const promoComps = patch.leagues[1].competitions as Competition[];
    expect(promoComps).toHaveLength(1);
    expect(promoComps[0].structureId).toBe(clones[1].id);
    expect(patch.leagues[0].competitions[1].structureId).toBe(clones[0].id);
  });
});
