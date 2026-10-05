/**
 * Fixtures & Venues → Leagues & tournaments (ADR 0018): the competitions table, Create
 * league / tournament (preview first, randomise, save as a draft), one competition's views,
 * and the failure paths — a refused draw, a name already taken, the server unreachable, a
 * knockout with nothing to fill — which keep the admin where they were with the reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { planCompetition, type CompetitionSpec } from '../packages/engine/src/competition';
import * as api from './api';
import { ApiError } from './api';
import { CompetitionsPanel } from './CompetitionsPanel';
import type { CmpSeries } from './competitions';
import { renderWithProviders } from './test-utils';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    previewCompetition: vi.fn(),
    createCompetition: vi.fn(),
    regenerateCompetition: vi.fn(),
    patchCompetition: vi.fn(),
    deleteCompetition: vi.fn(),
    advanceCompetition: vi.fn(),
  };
});
const mocked = vi.mocked(api);

const clubs = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((name) => ({
  id: name.toLowerCase(),
  name: `${name} CC`,
  leagues: ['premier'],
  ground: { venue: `${name} Oval` },
}));
const leagues = [{ key: 'premier', label: 'Premier League' }];

const planned = (over: Partial<CompetitionSpec> = {}) => {
  const p = planCompetition({
    id: 'c-sunday',
    type: 'league',
    name: 'Sunday T20',
    overs: 20,
    teams: clubs.map((c) => ({ teamId: c.id, clubId: c.id, name: c.name })),
    format: { kind: 'round-robin', legs: 1 },
    schedule: { startDate: '2026-10-18', everyDays: 7, times: ['10:00'] },
    ...over,
  });
  if ('problems' in p) throw new Error(p.problems.join());
  return p;
};
const preview = (over: Partial<CompetitionSpec> = {}) => {
  const p = planned(over);
  return {
    id: p.series[0].competition.id,
    series: p.series as never,
    summary: p.summary,
    warnings: p.warnings,
    clashes: [] as string[],
  };
};

const setup = (allSeries: CmpSeries[] = [], over: Record<string, unknown> = {}) => {
  const props = {
    allSeries,
    clubs,
    leagues,
    runs: [],
    activeId: allSeries[0]?.id,
    onSelectSeries: vi.fn(),
    renderFixtures: vi.fn(() => <div data-testid="editor">fixture editor</div>),
    onChanged: vi.fn(),
    toast: vi.fn(),
    ...over,
  };
  renderWithProviders(<CompetitionsPanel {...props} />);
  return props;
};

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/admin/fixtures?tab=series');
});

describe('the competitions table', () => {
  it('lists one row per competition and opens it on its fixtures, keeping ?series= in step', async () => {
    const user = userEvent.setup();
    const league = planned().series[0] as unknown as CmpSeries;
    const p = setup([league]);
    const table = screen.getByRole('table', { name: 'Leagues and tournaments' });
    const row = within(table).getByRole('button', { name: 'Sunday T20' }).closest('tr')!;
    expect(row.textContent).toMatch(/League.*Round robin · 20 overs.*4.*6.*0 played.*Draft/);

    await user.click(within(table).getByRole('button', { name: 'Sunday T20' }));
    expect(screen.getByRole('heading', { name: 'Sunday T20' })).toBeTruthy();
    expect(screen.getByTestId('editor')).toBeTruthy();
    expect(p.renderFixtures).toHaveBeenCalled();
    expect(window.location.search).toBe('?tab=series&series=c-sunday');

    await user.click(screen.getByRole('button', { name: /all leagues & tournaments/i }));
    expect(screen.getByRole('table', { name: 'Leagues and tournaments' })).toBeTruthy();
    expect(window.location.search).toBe('?tab=series');
  });

  it('shows the league catalogue beside the competitions, not as a separate page', async () => {
    const user = userEvent.setup();
    setup([], { catalogue: <div>the catalogue</div> });
    expect(screen.getByText(/no leagues or tournaments yet/i)).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: /league catalogue/i }));
    expect(screen.getByText('the catalogue')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '+ Create league' })).toBeNull();
  });
});

describe('Create league — preview first, then save as a draft', () => {
  const fillIn = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: '+ Create league' }));
    const dialog = screen.getByRole('dialog', { name: /create a league/i });
    await user.type(within(dialog).getByLabelText('Name'), 'Sunday T20');
    await user.click(within(dialog).getByRole('button', { name: 'All' }));
    const date = within(dialog).getByLabelText('First round');
    await user.clear(date);
    await user.type(date, '2026-10-18');
    return dialog;
  };

  it('sends the spec, shows the draw, and creates it only after a preview', async () => {
    const user = userEvent.setup();
    mocked.previewCompetition.mockResolvedValue(preview());
    mocked.createCompetition.mockResolvedValue(preview());
    const p = setup();
    const dialog = await fillIn(user);

    const create = within(dialog).getByRole('button', { name: 'Create league (draft)' });
    expect(create).toHaveProperty('disabled', true);

    await user.click(within(dialog).getByRole('button', { name: 'Preview fixtures' }));
    expect(mocked.previewCompetition).toHaveBeenCalledWith({
      type: 'league',
      name: 'Sunday T20',
      overs: 20,
      teams: expect.arrayContaining([
        expect.objectContaining({ teamId: 'alpha', clubId: 'alpha' }),
      ]),
      format: { kind: 'round-robin', legs: 1 },
      schedule: { startDate: '2026-10-18', everyDays: 7, times: ['10:00'], excludeDates: [] },
      points: { win: 4, tie: 2, noResult: 2, loss: 0 },
    });
    const shown = within(dialog).getByRole('region', { name: 'Fixture preview' });
    expect(shown.textContent).toMatch(/6 fixtures over 3 playing dates/);
    expect(shown.textContent).toMatch(/Alpha CC v /);

    await user.click(create);
    expect(mocked.createCompetition).toHaveBeenCalledTimes(1);
    expect(p.onChanged).toHaveBeenCalled();
    expect(p.toast).toHaveBeenCalledWith('Sunday T20 created as a draft');
    expect(p.onSelectSeries).toHaveBeenCalledWith('c-sunday');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('randomises the draw with a fresh seed, and any change after a preview needs a new one', async () => {
    const user = userEvent.setup();
    mocked.previewCompetition.mockResolvedValue(preview());
    setup();
    const dialog = await fillIn(user);
    await user.click(within(dialog).getByRole('button', { name: 'Randomise draw' }));
    expect(mocked.previewCompetition.mock.calls[0][0].seed).toEqual(expect.any(Number));
    const create = within(dialog).getByRole('button', { name: 'Create league (draft)' });
    expect(create).toHaveProperty('disabled', false);

    await user.type(within(dialog).getByLabelText('Name'), ' Cup');
    expect(create).toHaveProperty('disabled', true);
    expect(within(dialog).queryByRole('region', { name: 'Fixture preview' })).toBeNull();
  });

  it('lists every reason a draw is refused, in the office’s words', async () => {
    const user = userEvent.setup();
    mocked.previewCompetition.mockRejectedValue(
      new ApiError(400, 'invalid competition', 'invalid_competition', {
        problems: ['Pick at least two teams.', 'Pick a start date.'],
      }),
    );
    setup();
    await user.click(screen.getByRole('button', { name: '+ Create league' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Preview fixtures' }));
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'Pick at least two teams. Pick a start date.',
    );
    expect(within(dialog).getByRole('button', { name: 'Create league (draft)' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('keeps the dialog open when the save is refused or the server is unreachable', async () => {
    const user = userEvent.setup();
    mocked.previewCompetition.mockResolvedValue(preview());
    mocked.createCompetition
      .mockRejectedValueOnce(
        new ApiError(409, 'a competition with this id already exists', 'competition_exists'),
      )
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const p = setup();
    const dialog = await fillIn(user);
    await user.click(within(dialog).getByRole('button', { name: 'Preview fixtures' }));
    const create = within(dialog).getByRole('button', { name: 'Create league (draft)' });

    await user.click(create);
    expect(within(dialog).getByRole('alert').textContent).toMatch(/already exists/);
    await user.click(create);
    expect(within(dialog).getByRole('alert').textContent).toMatch(/could not reach the server/i);
    expect(p.onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('offers knockout or groups-then-knockout for a tournament', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: '+ Create tournament' }));
    const dialog = screen.getByRole('dialog', { name: /create a tournament/i });
    await user.selectOptions(within(dialog).getByLabelText('Format'), 'groups-knockout');
    expect(within(dialog).getByLabelText('Groups')).toBeTruthy();
    expect(within(dialog).getByLabelText('Through to the knockout')).toBeTruthy();
    expect(within(dialog).getByRole('checkbox', { name: /third-place game/i })).toBeTruthy();
  });
});

describe('one competition', () => {
  it('shows the league table with the qualifiers marked, and the knockout as a bracket', async () => {
    const user = userEvent.setup();
    const cup = planned({
      type: 'tournament',
      name: 'Cup',
      id: 'c-cup',
      format: { kind: 'groups-knockout', groups: 2, qualifiers: 1, legs: 1 },
    }).series as unknown as CmpSeries[];
    const g1 = cup[0];
    const [f1] = g1.fixtures as Array<{ home: string; away: string }>;
    (g1.fixtures as Array<Record<string, unknown>>)[0].result = {
      homeScore: '150/4 (20)',
      awayScore: '149/8 (20)',
      winner: 'home',
    };
    window.history.replaceState(null, '', '/admin/fixtures?tab=series&series=c-cup-g1');
    let activeId = 'c-cup-g1';
    const onSelectSeries = vi.fn((id: string) => (activeId = id));
    setup(cup, { activeId, onSelectSeries });

    await user.click(screen.getByRole('tab', { name: 'Table' }));
    const table = screen.getByRole('table', { name: 'League table' });
    const first = within(table).getAllByRole('row')[1];
    expect(first.className).toBe('qualifies');
    expect(first.textContent).toContain(clubs.find((c) => c.id === f1.home)!.name);
    expect(screen.getByText(/the top 1 go through to the knockout/i)).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: /knockout/i }));
    expect(onSelectSeries).toHaveBeenCalledWith('c-cup-ko');
    expect(activeId).toBe('c-cup-ko');
  });

  it('advances the knockout and says what is still waiting; a refusal is a warning toast', async () => {
    const user = userEvent.setup();
    const ko = planned({ type: 'tournament', id: 'c-ko', format: { kind: 'knockout' } })
      .series[0] as unknown as CmpSeries;
    window.history.replaceState(null, '', '/admin/fixtures?tab=series&series=c-ko');
    mocked.advanceCompetition
      .mockResolvedValueOnce({ filled: 0, waiting: ['f1 has no winner yet'] })
      .mockRejectedValueOnce(new ApiError(409, 'this competition has no knockout', 'no_knockout'));
    const p = setup([ko]);

    await user.click(screen.getByRole('tab', { name: 'Bracket' }));
    expect(screen.queryByRole('tab', { name: 'Results matrix' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Advance knockout' }));
    expect(mocked.advanceCompetition).toHaveBeenCalledWith('c-ko', false);
    expect(screen.getByRole('note').textContent).toMatch(/f1 has no winner yet/);
    expect(p.toast).toHaveBeenCalledWith('Nothing to fill yet', 'warn');
    expect(p.onChanged).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Fill from tables as they stand' }));
    expect(mocked.advanceCompetition).toHaveBeenLastCalledWith('c-ko', true);
    expect(p.toast).toHaveBeenLastCalledWith('this competition has no knockout', 'warn');
  });

  it('renames and re-points it, and deletes it only after a second click', async () => {
    const user = userEvent.setup();
    const league = planned().series[0] as unknown as CmpSeries;
    window.history.replaceState(null, '', '/admin/fixtures?tab=series&series=c-sunday');
    mocked.patchCompetition.mockResolvedValue({ id: 'c-sunday', series: [] });
    mocked.deleteCompetition.mockResolvedValue({ ok: true, deleted: ['c-sunday'] });
    const p = setup([league]);

    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Sunday Bash');
    await user.clear(screen.getByLabelText('Win points'));
    await user.type(screen.getByLabelText('Win points'), '2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocked.patchCompetition).toHaveBeenCalledWith('c-sunday', {
      name: 'Sunday Bash',
      points: { win: 2, tie: 2, noResult: 2, loss: 0 },
    });

    await user.click(screen.getByRole('button', { name: 'Delete league…' }));
    expect(mocked.deleteCompetition).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Yes, delete Sunday T20' }));
    expect(mocked.deleteCompetition).toHaveBeenCalledWith('c-sunday');
    expect(p.toast).toHaveBeenLastCalledWith('Sunday T20 deleted');
    expect(screen.getByRole('table', { name: 'Leagues and tournaments' })).toBeTruthy();
  });

  it('locks the draw once results are in and deletion once it is released', async () => {
    const user = userEvent.setup();
    const league = planned().series[0] as unknown as CmpSeries;
    (league.fixtures as Array<Record<string, unknown>>)[0].result = { winner: 'home' };
    league.released = true;
    window.history.replaceState(null, '', '/admin/fixtures?tab=series&series=c-sunday');
    setup([league]);
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByRole('button', { name: 'Regenerate fixtures…' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Delete league…' })).toHaveProperty('disabled', true);
    expect(screen.getAllByText(/recall it/i).length).toBe(2);
  });
});
