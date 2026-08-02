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
    await user.click(screen.getByRole('button', { name: /flat round robin/i }));
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

  it('two leagues picking the same template share ONE structure', async () => {
    const { user, save } = setup({
      leagues: [league(), league({ key: 'promo', label: 'Promotion Men' })],
    });

    await fillSeasonLabel(user);
    await user.click(continueBtn());

    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'premier');
    await user.click(screen.getByRole('button', { name: /flat round robin/i }));
    await user.selectOptions(screen.getByRole('combobox', { name: /add a league/i }), 'promo');
    await user.click(screen.getAllByRole('button', { name: /flat round robin/i })[1]);
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
    await user.click(screen.getByRole('button', { name: /split league with mid-season swap/i }));

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
