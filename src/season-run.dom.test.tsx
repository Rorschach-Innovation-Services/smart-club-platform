/**
 * SeasonRunsPanel — the admin's stage-by-stage walk through a structured competition.
 *
 * This is the surface with the least prior coverage and the most at stake: relegation and
 * a points handover are decided here, and the platform has no results model, so a human
 * confirms every standings-dependent stage. The tests below drive the two multi-stage
 * shapes the source documents actually describe:
 *
 *   - the KZNCU mid-season SWAP — Top Six 6th ↔ Bottom Six 1st, points moving with the
 *     POSITION rather than the team
 *   - seeded pools → CROSS-POOL semis, where the order inside each pool is load-bearing
 *     because the bracket pairs A1 against B2
 *
 * Both are `manual` entrants carrying a DerivationNote: the rule is recorded, prefilled
 * and audited, but never executed. That is the honest design, and these assert it holds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { currentSeasonLabel } from './data';
import { ApiError, quickStartSeason } from './api';
import { GenerateFixturesLauncher, SeasonRunsPanel } from './season-run';
import { materialiseRun } from '../packages/engine/src/run';
import { leagueParticipants } from '../packages/engine/src/leagues';
import { addDays, formatIsoDate, todayIso } from '../packages/engine/src/calendar';
import { Sentry } from './sentry';
import type {
  Club,
  CompetitionStructure,
  League,
  SeasonCalendar,
  SeasonRun,
  Series,
  StageSpec,
  TenantConfig,
} from './types';

// Quick start posts straight to the server; the route is mocked here, the rest of the
// api module stays real (ApiError in particular).
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, quickStartSeason: vi.fn() };
});
// Error reporting is observed, never sent.
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

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

/** Twelve single-side clubs, enough for a 6/6 split — all affiliated, so the gate passes. */
const clubs = Array.from({ length: 12 }, (_, i) => ({
  id: `c${i + 1}`,
  name: `Club ${i + 1}`,
  leagues: ['premier'],
  affiliation: 'complete',
  ground: { venue: `Ground ${i + 1}`, lat: -29.8 - i / 100, lon: 31 + i / 100 },
})) as unknown as Club[];

const stage = (over: Partial<StageSpec>): StageSpec =>
  ({
    id: 's1',
    name: 'Stage',
    format: { kind: 'round-robin', legs: 1 },
    entrants: { kind: 'all-registered' },
    schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
    ...over,
  }) as StageSpec;

/** Premier Men 50 Over: two groups of six, double round robin, then a swap + final round. */
const SPLIT_LEAGUE: CompetitionStructure = {
  id: 'split',
  name: 'Split league with mid-season swap',
  version: 1,
  stages: [
    stage({
      id: 'double-round',
      name: 'Double round',
      format: { kind: 'round-robin', legs: 2 },
      entrants: { kind: 'manual', groups: { kind: 'sizes', sizes: [6, 6] } },
      groupLabels: ['Top Six', 'Bottom Six'],
    }),
    stage({
      id: 'final-round',
      name: 'Final round',
      format: { kind: 'round-robin', legs: 1 },
      entrants: {
        kind: 'manual',
        groups: { kind: 'sizes', sizes: [6, 6] },
        derivedFrom: {
          rule: 'swap',
          fromStage: 'double-round',
          detail: 'Top Six 6th ↔ Bottom Six 1st, points carried',
          carryPoints: true,
        },
      },
      groupLabels: ['Top Six', 'Bottom Six'],
      schedule: { blockIndex: 1, cadence: { kind: 'weekly' } },
    }),
  ],
} as unknown as CompetitionStructure;

/** Premier Men T20: two seeded pools of six, then a cross-pool knockout. */
const POOLS_THEN_CROSS: CompetitionStructure = {
  id: 'pools',
  name: 'Seeded groups → cross-group semis → final',
  version: 1,
  stages: [
    stage({
      id: 'pools',
      name: 'Pools',
      entrants: { kind: 'seeded-split', method: 'snake', groups: { kind: 'even', count: 2 } },
      groupLabels: ['Pool A', 'Pool B'],
    }),
    stage({
      id: 'semis',
      name: 'Semi-finals',
      format: { kind: 'knockout', pairing: 'cross-pool' },
      entrants: {
        kind: 'manual',
        derivedFrom: {
          rule: 'from-standings',
          fromStage: 'pools',
          detail: 'Top two from each pool',
        },
      },
      schedule: { blockIndex: 1, cadence: { kind: 'weekly' } },
    }),
  ],
} as unknown as CompetitionStructure;

const league = (structureId: string): League =>
  ({
    key: 'premier',
    label: 'Premier League',
    group: 'Senior',
    district: 'All districts',
    competitions: [{ id: 'c1', label: '50 Over', structureId, calendarId: 'cal' }],
  }) as unknown as League;

const run = (structure: CompetitionStructure, over: Partial<SeasonRun> = {}): SeasonRun =>
  ({
    id: 'run-1',
    leagueKey: 'premier',
    competitionId: 'c1',
    seasonLabel: '2026/27',
    structureSnapshot: structure,
    calendarSnapshot: calendar,
    stages: [],
    version: 1,
    ...over,
  }) as unknown as SeasonRun;

const setup = (
  structure: CompetitionStructure,
  runs: SeasonRun[],
  opts: {
    series?: Series[];
    /** The LIVE structures — a newer version than the run's snapshot shows the banner. */
    structures?: CompetitionStructure[];
    onRebaseRun?: ReturnType<typeof vi.fn>;
    onFetchRun?: ReturnType<typeof vi.fn>;
  } = {},
) => {
  const onPatchRun = vi.fn().mockResolvedValue(undefined);
  const onGenerate = vi.fn().mockResolvedValue(undefined);
  const onOpenLauncher = vi.fn();
  const onDeleteRun = vi.fn();
  const user = userEvent.setup();
  const panel = (r: SeasonRun[], series: Series[]) => (
    <SeasonRunsPanel
      clubs={clubs}
      allLeagues={[league(structure.id)]}
      allSeries={series}
      runs={r}
      onOpenLauncher={onOpenLauncher}
      onPatchRun={onPatchRun}
      onGenerate={onGenerate}
      onDeleteRun={onDeleteRun}
      structures={opts.structures}
      onRebaseRun={opts.onRebaseRun}
      onFetchRun={opts.onFetchRun}
    />
  );
  let currentSeries = opts.series ?? [];
  const { rerender } = render(panel(runs, currentSeries));
  /** Re-render with a new `runs` array — same props otherwise — to see what the admin
   *  sees after a PATCH actually lands, rather than only inspecting the call args. Pass
   *  `series` to also swap the series list (e.g. after a generate). */
  const rerenderRuns = (r: SeasonRun[], series?: Series[]) => {
    if (series) currentSeries = series;
    rerender(panel(r, currentSeries));
  };
  return { user, onPatchRun, onGenerate, onOpenLauncher, onDeleteRun, rerenderRuns };
};

/** The open modal. Every confirm-form query scopes to it — the stage card behind it
 *  carries the same button labels. */
const dialog = () => screen.getByRole('dialog');

const openConfirm = async (user: ReturnType<typeof userEvent.setup>, stageName: RegExp) => {
  const card = screen.getByRole('heading', { name: stageName }).closest('div')!.parentElement!;
  await user.click(
    within(card).getByRole('button', { name: /confirm entrants|edit entrants|change entrants/i }),
  );
};

/** Every "Group" picker in the confirm table, one per side, in participant order. */
const groupPickers = () => within(dialog()).getAllByRole('combobox');
const confirmBtn = () => within(dialog()).getByRole('button', { name: /confirm entrants/i });

/** The stage timeline's current step (Awaiting entrants / Ready / Generated / Released). */
const currentStep = (scope?: HTMLElement) =>
  (scope ? within(scope) : screen).getByRole('listitem', { current: 'step' });

beforeEach(() => vi.clearAllMocks());

describe('a stage that needs a human — the rule is shown, never executed', () => {
  it('states the swap rule verbatim so the admin knows what to enter', async () => {
    const { user } = setup(SPLIT_LEAGUE, [
      run(SPLIT_LEAGUE, {
        stages: [
          {
            specId: 'double-round',
            status: 'generated',
            groups: [
              { id: 'g0', label: 'Top Six', entrants: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] },
              { id: 'g1', label: 'Bottom Six', entrants: ['c7', 'c8', 'c9', 'c10', 'c11', 'c12'] },
            ],
            audit: [],
          },
        ],
      }),
    ]);

    await openConfirm(user, /^Final round · /);

    expect(
      within(dialog()).getByText(/Top Six 6th ↔ Bottom Six 1st, points carried/),
    ).toBeVisible();
    expect(
      within(dialog()).getByText(/points move with the position, not the team/i),
    ).toBeVisible();
  });

  it('asks for carried points per side, because nothing can compute them', async () => {
    const { user } = setup(SPLIT_LEAGUE, [
      run(SPLIT_LEAGUE, {
        stages: [
          {
            specId: 'double-round',
            status: 'generated',
            groups: [
              { id: 'g0', label: 'Top Six', entrants: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] },
              { id: 'g1', label: 'Bottom Six', entrants: ['c7', 'c8', 'c9', 'c10', 'c11', 'c12'] },
            ],
            audit: [],
          },
        ],
      }),
    ]);

    await openConfirm(user, /^Final round · /);
    expect(within(dialog()).getByRole('columnheader', { name: /carried points/i })).toBeVisible();
  });

  it('records the confirmed groups and the points handover on the run', async () => {
    const { user, onPatchRun } = setup(SPLIT_LEAGUE, [
      run(SPLIT_LEAGUE, {
        stages: [
          {
            specId: 'double-round',
            status: 'generated',
            groups: [
              { id: 'g0', label: 'Top Six', entrants: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] },
              { id: 'g1', label: 'Bottom Six', entrants: ['c7', 'c8', 'c9', 'c10', 'c11', 'c12'] },
            ],
            audit: [],
          },
        ],
      }),
    ]);

    await openConfirm(user, /^Final round · /);
    // Perform the swap by hand, exactly as the rule describes: club 6 down, club 7 up.
    await user.selectOptions(groupPickers()[5], '1');
    await user.selectOptions(groupPickers()[6], '0');
    // The relegated side takes on the promoted side's points, by POSITION.
    const pointsBoxes = within(dialog()).getAllByRole('spinbutton');
    await user.clear(pointsBoxes[5]);
    await user.type(pointsBoxes[5], '18');
    await user.click(confirmBtn());

    const patch = onPatchRun.mock.calls[0][1];
    const finalRound = patch.stages.find((s: { specId: string }) => s.specId === 'final-round');
    expect(finalRound.groups[0].entrants).toContain('c7');
    expect(finalRound.groups[0].entrants).not.toContain('c6');
    expect(finalRound.groups[1].entrants).toContain('c6');
    expect(finalRound.carriedPoints).toMatchObject({ c6: 18 });
  });
});

describe('the confirm form refuses a season that would generate nothing', () => {
  const readyRun = () =>
    run(SPLIT_LEAGUE, {
      stages: [
        {
          specId: 'double-round',
          status: 'generated',
          groups: [
            { id: 'g0', label: 'Top Six', entrants: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] },
            { id: 'g1', label: 'Bottom Six', entrants: ['c7', 'c8', 'c9', 'c10', 'c11', 'c12'] },
          ],
          audit: [],
        },
      ],
    });

  it('blocks an empty group — the structure asked for it and nobody is in it', async () => {
    const { user, onPatchRun } = setup(SPLIT_LEAGUE, [readyRun()]);
    await openConfirm(user, /^Final round · /);

    // Empty the Bottom Six entirely.
    for (const i of [6, 7, 8, 9, 10, 11]) await user.selectOptions(groupPickers()[i], '');

    expect(within(dialog()).getByText(/Bottom Six has no sides/i)).toBeVisible();
    expect(confirmBtn()).toBeDisabled();
    expect(onPatchRun).not.toHaveBeenCalled();
  });

  it('blocks a group of one, which would play nobody', async () => {
    const { user } = setup(SPLIT_LEAGUE, [readyRun()]);
    await openConfirm(user, /^Final round · /);

    for (const i of [7, 8, 9, 10, 11]) await user.selectOptions(groupPickers()[i], '');

    expect(
      within(dialog()).getByText(/Bottom Six has one side — it would play nobody/i),
    ).toBeVisible();
    expect(confirmBtn()).toBeDisabled();
  });

  it('flags a group that does not match the size the structure asks for', async () => {
    const { user } = setup(SPLIT_LEAGUE, [readyRun()]);
    await openConfirm(user, /^Final round · /);

    await user.selectOptions(groupPickers()[11], '0'); // 7 in the Top Six, 5 in the Bottom

    expect(
      within(dialog()).getByText(/Top Six has 7 sides; the structure expects 6/i),
    ).toBeVisible();
  });

  it('lets a side sit the competition out without trapping the form', async () => {
    // "Not playing" is legitimate — a club entered in the league but not this competition.
    // Blocking on it made the option a trap with no way back.
    const { user, onPatchRun } = setup(SPLIT_LEAGUE, [
      run(SPLIT_LEAGUE, {
        stages: [
          {
            specId: 'double-round',
            status: 'generated',
            groups: [
              { id: 'g0', label: 'Top Six', entrants: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] },
              { id: 'g1', label: 'Bottom Six', entrants: ['c7', 'c8', 'c9', 'c10', 'c11', 'c12'] },
            ],
            audit: [],
          },
        ],
      }),
    ]);
    await openConfirm(user, /^Final round · /);

    await user.selectOptions(groupPickers()[11], ''); // c12 sits out
    await user.selectOptions(groupPickers()[0], '1'); // rebalance to 5 / 6

    expect(within(dialog()).getByText(/1 not playing/i)).toBeVisible();
    // Size mismatch is a warning about the structure, not about "not playing" itself.
    await user.selectOptions(groupPickers()[0], '0');
    expect(
      within(dialog()).getByText(/Bottom Six has 5 sides; the structure expects 6/i),
    ).toBeVisible();
    expect(onPatchRun).not.toHaveBeenCalled();
  });
});

describe('cross-pool — the order inside a pool is load-bearing', () => {
  const pooledRun = () =>
    run(POOLS_THEN_CROSS, {
      stages: [
        {
          specId: 'pools',
          status: 'generated',
          groups: [
            { id: 'g0', label: 'Pool A', entrants: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] },
            { id: 'g1', label: 'Pool B', entrants: ['c7', 'c8', 'c9', 'c10', 'c11', 'c12'] },
          ],
          audit: [],
        },
      ],
    });

  it('asks for a finishing position, not just which pool a side was in', async () => {
    const { user } = setup(POOLS_THEN_CROSS, [pooledRun()]);
    await openConfirm(user, /^Pools · /);

    // The bracket pairs the winner of A against the runner-up of B, so registration
    // order is not a ranking of anything and must not decide the semi-finals.
    expect(within(dialog()).getByText(/order matters here/i)).toBeVisible();
    expect(within(dialog()).getByRole('columnheader', { name: /position/i })).toBeVisible();
  });

  it('refuses two sides in the same position', async () => {
    const { user } = setup(POOLS_THEN_CROSS, [pooledRun()]);
    await openConfirm(user, /^Pools · /);

    const positions = within(dialog()).getAllByRole('spinbutton');
    await user.clear(positions[1]);
    await user.type(positions[1], '1'); // now two sides claim 1st in Pool A

    expect(within(dialog()).getByText(/Pool A has two sides in the same position/i)).toBeVisible();
    expect(confirmBtn()).toBeDisabled();
  });

  it('stores each pool in the confirmed finishing order', async () => {
    const { user, onPatchRun } = setup(POOLS_THEN_CROSS, [pooledRun()]);
    await openConfirm(user, /^Pools · /);

    // Reverse Pool A: the side registered last finished first.
    const positions = within(dialog()).getAllByRole('spinbutton');
    await user.clear(positions[0]);
    await user.type(positions[0], '6');
    await user.clear(positions[5]);
    await user.type(positions[5], '1');
    await user.click(confirmBtn());

    const patch = onPatchRun.mock.calls[0][1];
    const pools = patch.stages.find((s: { specId: string }) => s.specId === 'pools');
    expect(pools.groups[0].entrants[0]).toBe('c6');
    expect(pools.groups[0].entrants[5]).toBe('c1');
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Seeded knockouts and non-adjacent cross-pool derivation (the Kingsmead shape) also
   get the Position column and ranked ordering — `ranked` in season-run.tsx is set for
   BOTH a stage that feeds a cross-pool draw AND a seeded knockout in its own right, and
   `feedsPoolKnockout`/`crossPoolSourceStage` (structure.ts) resolve via
   `derivedFrom.fromStage` past an intervening stage, not just the adjacent one.
   ───────────────────────────────────────────────────────────────────────────── */

describe('the Position column also appears on a seeded knockout and a non-adjacent feeder', () => {
  const KNOCKOUT_SEEDED: CompetitionStructure = {
    id: 'cup',
    name: 'Seeded knockout',
    version: 1,
    stages: [
      stage({
        id: 'ko',
        name: 'Cup',
        format: { kind: 'knockout', pairing: 'seeded' },
        entrants: { kind: 'manual' },
      }),
    ],
  } as unknown as CompetitionStructure;

  const generatedKnockoutRun = () =>
    run(KNOCKOUT_SEEDED, {
      stages: [
        {
          specId: 'ko',
          status: 'generated',
          groups: [{ id: 'g0', label: 'Group A', entrants: ['c1', 'c2', 'c3', 'c4'] }],
          audit: [],
        },
      ],
    });

  it('asks a seeded knockout for the seed line, not just who is in the draw', async () => {
    const { user } = setup(KNOCKOUT_SEEDED, [generatedKnockoutRun()]);
    await openConfirm(user, /^Cup · /);

    expect(within(dialog()).getByText(/seeded knockout/i)).toBeVisible();
    expect(within(dialog()).getByRole('columnheader', { name: /position/i })).toBeVisible();
  });

  it('reordering a knockout’s positions before confirming reorders the resulting seed line', async () => {
    const { user, onPatchRun } = setup(KNOCKOUT_SEEDED, [generatedKnockoutRun()]);
    await openConfirm(user, /^Cup · /);

    const positions = within(dialog()).getAllByRole('spinbutton');
    // Swap seed 1 and seed 2 — c1 was first, c2 second.
    await user.clear(positions[0]);
    await user.type(positions[0], '2');
    await user.clear(positions[1]);
    await user.type(positions[1], '1');
    await user.click(confirmBtn());

    const ko = onPatchRun.mock.calls[0][1].stages.find(
      (s: { specId: string }) => s.specId === 'ko',
    );
    expect(ko.groups[0].entrants[0]).toBe('c2');
    expect(ko.groups[0].entrants[1]).toBe('c1');
  });

  /** The Kingsmead shape: Pools → an unrelated Streams stage → a cross-pool Cup that
   *  names Pools directly via `derivedFrom.fromStage`, two stages back. */
  const KINGSMEAD_SHAPE: CompetitionStructure = {
    id: 'kingsmead',
    name: 'Kingsmead shape',
    version: 1,
    stages: [
      stage({
        id: 'pools',
        name: 'Pools',
        entrants: { kind: 'seeded-split', method: 'snake', groups: { kind: 'even', count: 2 } },
        groupLabels: ['Pool A', 'Pool B'],
      }),
      stage({
        id: 'streams',
        name: 'Streams',
        entrants: { kind: 'all-registered' },
      }),
      stage({
        id: 'cup',
        name: 'Kingsmead Cup',
        format: { kind: 'knockout', pairing: 'cross-pool' },
        entrants: {
          kind: 'manual',
          derivedFrom: { rule: 'from-standings', fromStage: 'pools', detail: 'Top two per pool' },
        },
        schedule: { blockIndex: 1, cadence: { kind: 'weekly' } },
      }),
    ],
  } as unknown as CompetitionStructure;

  it('still asks Pools for finishing positions when the stage it feeds is two stages ahead', async () => {
    const { user } = setup(KINGSMEAD_SHAPE, [
      run(KINGSMEAD_SHAPE, {
        stages: [
          {
            specId: 'pools',
            status: 'generated',
            groups: [
              { id: 'g0', label: 'Pool A', entrants: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] },
              { id: 'g1', label: 'Pool B', entrants: ['c7', 'c8', 'c9', 'c10', 'c11', 'c12'] },
            ],
            audit: [],
          },
        ],
      }),
    ]);
    await openConfirm(user, /^Pools · /);

    // Not adjacent — Streams sits between Pools and the Cup — but the derivation names
    // Pools directly, so it still gets ranked ordering.
    expect(within(dialog()).getByText(/order matters here/i)).toBeVisible();
    expect(within(dialog()).getByRole('columnheader', { name: /position/i })).toBeVisible();
  });

  it('does not ask the intervening Streams stage for a ranking — nothing draws from it', async () => {
    const { user } = setup(KINGSMEAD_SHAPE, [
      run(KINGSMEAD_SHAPE, {
        stages: [
          { specId: 'pools', status: 'ready', groups: [], audit: [] },
          {
            specId: 'streams',
            status: 'generated',
            groups: [{ id: 'g0', label: 'Group A', entrants: ['c1', 'c2'] }],
            audit: [],
          },
        ],
      }),
    ]);
    await openConfirm(user, /^Streams · /);
    expect(within(dialog()).queryByText(/order matters here/i)).toBeNull();
    expect(within(dialog()).queryByRole('columnheader', { name: /position/i })).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Order-sensitive staleness (season-run.tsx `confirmEntrants`): a knockout stage's own
   order IS the seed line, so a pure reorder must invalidate its already-generated
   fixtures. A round-robin FEEDER stage is the opposite — its own fixtures don't depend
   on the finishing-position order the admin is asked for (that order is only load-
   bearing for the LATER cross-pool stage reading it), so a pure reorder there must not
   flip a generated stage back to "needs regenerating".
   ───────────────────────────────────────────────────────────────────────────── */

describe('order-sensitive staleness — a pure reorder on a knockout invalidates it, a pool it does not', () => {
  const KNOCKOUT_SEEDED: CompetitionStructure = {
    id: 'cup',
    name: 'Seeded knockout',
    version: 1,
    stages: [
      stage({
        id: 'ko',
        name: 'Cup',
        format: { kind: 'knockout', pairing: 'seeded' },
        entrants: { kind: 'manual' },
      }),
    ],
  } as unknown as CompetitionStructure;

  const generatedKnockoutRun = () =>
    run(KNOCKOUT_SEEDED, {
      stages: [
        {
          specId: 'ko',
          status: 'generated',
          // A `seriesId` on the group is what turns a 'ready' status back into the
          // "Needs regenerating" signal (`staleEntrants` in season-run.tsx) — a
          // generated stage's fixtures live in a series, so there is something to
          // regenerate.
          groups: [
            { id: 'g0', label: 'Group A', entrants: ['c1', 'c2', 'c3', 'c4'], seriesId: 'ser-ko' },
          ],
          audit: [],
        },
      ],
    });

  it('reordering a knockout’s confirmed seed line marks it stale, and Regenerate reappears', async () => {
    const { user, onPatchRun, rerenderRuns } = setup(KNOCKOUT_SEEDED, [generatedKnockoutRun()]);
    // Starting state: generated, nothing to regenerate.
    expect(currentStep()).toHaveTextContent(/^Generated/);
    expect(screen.queryByText(/needs regenerating/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /regenerate \d+ fixtures/i })).toBeNull();

    await openConfirm(user, /^Cup · /);
    const positions = within(dialog()).getAllByRole('spinbutton');
    await user.clear(positions[0]);
    await user.type(positions[0], '2');
    await user.clear(positions[1]);
    await user.type(positions[1], '1');
    await user.click(confirmBtn());

    const patch = onPatchRun.mock.calls[0][1];
    const ko = patch.stages.find((s: { specId: string }) => s.specId === 'ko');
    // Order changed for a KNOCKOUT — a real change, so it drops out of 'generated'.
    expect(ko.status).toBe('ready');

    // Apply the patch the way a successful PATCH would, and see what the admin sees.
    rerenderRuns([run(KNOCKOUT_SEEDED, { stages: patch.stages })]);

    expect(screen.getByText(/needs regenerating/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /regenerate \d+ fixtures/i })).toBeVisible();
  });

  const generatedPoolsRun = () =>
    run(POOLS_THEN_CROSS, {
      stages: [
        {
          specId: 'pools',
          status: 'generated',
          groups: [
            {
              id: 'g0',
              label: 'Pool A',
              entrants: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
              seriesId: 'ser-a',
            },
            {
              id: 'g1',
              label: 'Pool B',
              entrants: ['c7', 'c8', 'c9', 'c10', 'c11', 'c12'],
              seriesId: 'ser-b',
            },
          ],
          audit: [],
        },
      ],
    });

  it('reordering a feeder pool’s finishing positions leaves it generated — set-compare preserved', async () => {
    const { user, onPatchRun, rerenderRuns } = setup(POOLS_THEN_CROSS, [generatedPoolsRun()]);
    expect(screen.queryByText(/needs regenerating/i)).toBeNull();

    await openConfirm(user, /^Pools · /);
    // Reverse the finishing order within Pool A — same six sides, different positions.
    const positions = within(dialog()).getAllByRole('spinbutton');
    await user.clear(positions[0]);
    await user.type(positions[0], '6');
    await user.clear(positions[5]);
    await user.type(positions[5], '1');
    await user.click(confirmBtn());

    const patch = onPatchRun.mock.calls[0][1];
    const pools = patch.stages.find((s: { specId: string }) => s.specId === 'pools');
    // MEMBERSHIP is unchanged — only the position within the group — so a round-robin
    // feeder's own generated fixtures are not considered stale by this.
    expect(pools.status).toBe('generated');

    rerenderRuns([run(POOLS_THEN_CROSS, { stages: patch.stages })]);
    expect(screen.queryByText(/needs regenerating/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /regenerate \d+ fixtures/i })).toBeNull();
  });
});

describe('a write that loses a race says so in words, inline', () => {
  it('a confirm refused by a version race shows the refreshed-season line, not the boilerplate', async () => {
    const { user, onPatchRun } = setup(POOLS_THEN_CROSS, [run(POOLS_THEN_CROSS)]);
    onPatchRun.mockRejectedValueOnce(new ApiError(409, 'season run changed; refetch'));
    await openConfirm(user, /^Pools · /);
    await user.click(confirmBtn());

    expect(
      await within(dialog()).findByText(
        'Someone else changed this season at the same time. It has been refreshed — check it and try again.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(/refetch/)).toBeNull();
  });
});

describe('the audit trail — who decided the relegation', () => {
  it('records an accepted suggestion as accepted', async () => {
    const { user, onPatchRun } = setup(POOLS_THEN_CROSS, [run(POOLS_THEN_CROSS)]);
    await openConfirm(user, /^Pools · /);
    await user.click(confirmBtn());

    const entry = onPatchRun.mock.calls[0][1].stages[0].audit.at(-1);
    expect(entry.accepted).toBe(true);
    expect(entry.at).toEqual(expect.any(String));
  });

  it('records an overridden suggestion as overridden', async () => {
    const { user, onPatchRun } = setup(POOLS_THEN_CROSS, [run(POOLS_THEN_CROSS)]);
    await openConfirm(user, /^Pools · /);

    // Reordering inside a pool IS an override: for a cross-pool bracket the order is
    // the decision, so A1-v-B2 changing is exactly what the trail has to record.
    // A snake split of 12 into two puts clubs 1 and 4 both in Pool A, 1st and 2nd —
    // swapping THOSE avoids colliding with a position held in the other pool.
    const positions = within(dialog()).getAllByRole('spinbutton');
    await user.clear(positions[3]);
    await user.type(positions[3], '1');
    await user.clear(positions[0]);
    await user.type(positions[0], '2');
    await user.click(confirmBtn());

    expect(onPatchRun.mock.calls[0][1].stages[0].audit.at(-1).accepted).toBe(false);
  });

  it('keeps earlier audit entries exactly as they were stored', async () => {
    // Re-confirming replays the whole array to the server. Restamping the prefix with the
    // current actor and time would rewrite history — which is the one thing an audit
    // trail must never do, and is what this records relegation decisions for.
    const prior = {
      by: 'first@union',
      at: '2026-07-01T09:00:00.000Z',
      prefill: [],
      accepted: true,
    };
    const { user, onPatchRun } = setup(POOLS_THEN_CROSS, [
      run(POOLS_THEN_CROSS, {
        stages: [
          {
            specId: 'pools',
            status: 'generated',
            groups: [
              { id: 'g0', label: 'Pool A', entrants: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] },
              { id: 'g1', label: 'Pool B', entrants: ['c7', 'c8', 'c9', 'c10', 'c11', 'c12'] },
            ],
            audit: [prior],
          },
        ],
      }),
    ]);

    await openConfirm(user, /^Pools · /);
    await user.click(confirmBtn());

    const audit = onPatchRun.mock.calls[0][1].stages[0].audit;
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject(prior);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Semi-final pairing, chosen per season. The structure names a default (cross- or
   within-group); the union may decide the other way when the qualifiers are confirmed.
   The choice is stored on the StageRun as `pairingOverride` (omitted when it matches
   the structure), recorded on the audit entry, and — because the stage's materialised
   bracket now differs from the generated series — flips a generated stage to
   "Needs regenerating".
   ───────────────────────────────────────────────────────────────────────────── */

/** Two pools of six, top two from each into cross-group semis in the next block. */
const POOLS_TOP_TWO: CompetitionStructure = {
  id: 'pools-q2',
  name: 'Pools → semis → final',
  version: 1,
  stages: [
    stage({
      id: 'pools',
      name: 'Pools',
      entrants: { kind: 'seeded-split', method: 'snake', groups: { kind: 'even', count: 2 } },
      groupLabels: ['Pool A', 'Pool B'],
    }),
    stage({
      id: 'semis',
      name: 'Semi-finals',
      format: { kind: 'knockout', pairing: 'cross-pool' },
      entrants: {
        kind: 'manual',
        derivedFrom: {
          rule: 'from-standings',
          fromStage: 'pools',
          detail: 'Top two from each pool',
          qualifiersPerGroup: 2,
        },
      },
      schedule: { blockIndex: 1, cadence: { kind: 'weekly' } },
    }),
  ],
} as unknown as CompetitionStructure;

const poolsConfirmed = {
  specId: 'pools',
  status: 'generated' as const,
  groups: [
    { id: 'g0', label: 'Pool A', entrants: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] },
    { id: 'g1', label: 'Pool B', entrants: ['c7', 'c8', 'c9', 'c10', 'c11', 'c12'] },
  ],
  audit: [],
};

/** The card for one stage, found by its heading. */
const cardFor = (name: RegExp) =>
  screen.getByRole('heading', { name }).closest('div')!.parentElement!;

/**
 * The series a generate call would have written. `onGenerate` is handed only the run and
 * the stage (the server materialises it, ADR 0014), so this materialises the same way with
 * the shared engine over the test's clubs.
 */
const seriesFromGenerate = (
  call: unknown[],
  over: Partial<Series> = {},
): { series: Series[]; groups: Array<{ id: string; seriesId: string }> } => {
  const [genRun, stageSpec] = call as [SeasonRun, StageSpec];
  const index = genRun.structureSnapshot.stages.findIndex((x) => x.id === stageSpec.id);
  const m = materialiseRun(genRun, leagueParticipants(clubs, genRun.leagueKey)).materialisations[
    index
  ];
  if (m.status !== 'ready') throw new Error(`stage ${stageSpec.id} is not ready to generate`);
  const series = m.groups.map(
    (g) =>
      ({
        id: `s-${genRun.id}-${stageSpec.id}-${g.id}`,
        name: stageSpec.name,
        fixtures: g.fixtures,
        teams: g.entrants,
        released: false,
        seasonRunId: genRun.id,
        stageSpecId: stageSpec.id,
        groupId: g.id,
        version: 1,
        ...over,
      }) as unknown as Series,
  );
  return {
    series,
    groups: m.groups.map((g) => ({
      id: g.id,
      seriesId: `s-${genRun.id}-${stageSpec.id}-${g.id}`,
    })),
  };
};

describe('semi-final pairing — the union decides within- or cross-group per season', () => {
  it('previews the first round live and stores the choice as a pairing override', async () => {
    const { user, onPatchRun } = setup(POOLS_TOP_TWO, [
      run(POOLS_TOP_TWO, { stages: [poolsConfirmed] }),
    ]);
    await openConfirm(user, /^Semi-finals · /);

    // The structure's default is pre-selected, and its bracket is previewed: A1 v B2.
    expect(within(dialog()).getByRole('radio', { name: /structure default/i })).toBeChecked();
    expect(within(dialog()).getByText(/first round:/i).parentElement).toHaveTextContent(
      /Club 1 v Club 8/,
    );

    await user.click(within(dialog()).getByRole('radio', { name: /^within-group/i }));
    // Now each pool's qualifiers meet each other first: A1 v A2, B1 v B2.
    const preview = within(dialog()).getByText(/first round:/i).parentElement!;
    expect(preview).toHaveTextContent(/Club 1 v Club 2/);
    expect(preview).toHaveTextContent(/Club 7 v Club 8/);

    await user.click(confirmBtn());
    const semis = onPatchRun.mock.calls[0][1].stages.find(
      (s: { specId: string }) => s.specId === 'semis',
    );
    expect(semis.pairingOverride).toBe('within-pool');
    expect(semis.audit.at(-1).pairing).toBe('within-pool');
  });

  it('stores no override when the admin keeps the structure default', async () => {
    const { user, onPatchRun } = setup(POOLS_TOP_TWO, [
      run(POOLS_TOP_TWO, { stages: [poolsConfirmed] }),
    ]);
    await openConfirm(user, /^Semi-finals · /);
    await user.click(confirmBtn());

    const semis = onPatchRun.mock.calls[0][1].stages.find(
      (s: { specId: string }) => s.specId === 'semis',
    );
    expect(semis).not.toHaveProperty('pairingOverride');
    // Still recorded: the union was asked, and chose the default.
    expect(semis.audit.at(-1).pairing).toBe('cross-pool');
  });

  it('flipping the pairing after generation marks the stage "Needs regenerating"', async () => {
    const semisReady = {
      specId: 'semis',
      status: 'ready' as const,
      groups: [{ id: 'g1', label: 'Group A', entrants: ['c1', 'c2', 'c7', 'c8'] }],
      audit: [],
    };
    const { user, onGenerate, onPatchRun, rerenderRuns } = setup(POOLS_TOP_TWO, [
      run(POOLS_TOP_TWO, { stages: [poolsConfirmed, semisReady] }),
    ]);

    // Generate the cross-group semis, then land them the way a real generate would.
    await user.click(
      within(cardFor(/^Semi-finals · /)).getByRole('button', { name: /generate \d+ fixtures/i }),
    );
    const { series, groups } = seriesFromGenerate(onGenerate.mock.calls[0]);
    const generated = {
      ...semisReady,
      status: 'generated' as const,
      groups: semisReady.groups.map((g) => ({
        ...g,
        seriesId: groups.find((x) => x.id === g.id)?.seriesId ?? groups[0].seriesId,
      })),
    };
    rerenderRuns([run(POOLS_TOP_TWO, { stages: [poolsConfirmed, generated] })], series);
    expect(currentStep(cardFor(/^Semi-finals · /))).toHaveTextContent(/^Generated/);
    expect(within(cardFor(/^Semi-finals · /)).queryByText(/needs regenerating/i)).toBeNull();

    // Same qualifiers, different pairing — no entrant changed, so only the bracket moved.
    await openConfirm(user, /^Semi-finals · /);
    await user.click(within(dialog()).getByRole('radio', { name: /^within-group/i }));
    await user.click(confirmBtn());
    const patch = onPatchRun.mock.calls[0][1];
    expect(patch.stages.find((s: { specId: string }) => s.specId === 'semis').status).toBe(
      'generated',
    );

    rerenderRuns([run(POOLS_TOP_TWO, { stages: patch.stages })]);
    const card = cardFor(/^Semi-finals · /);
    expect(within(card).getByText(/needs regenerating/i)).toBeVisible();
    expect(within(card).getByRole('button', { name: /regenerate \d+ fixtures/i })).toBeVisible();
  });

  it('disables Within-group when the pools on screen cannot be drawn that way', async () => {
    // Three pools: within-group needs a power-of-two number of them.
    const THREE_POOLS = {
      ...POOLS_TOP_TWO,
      id: 'pools-3',
      stages: [
        {
          ...POOLS_TOP_TWO.stages[0],
          entrants: { kind: 'seeded-split', method: 'snake', groups: { kind: 'even', count: 3 } },
          groupLabels: ['Pool A', 'Pool B', 'Pool C'],
        },
        POOLS_TOP_TWO.stages[1],
      ],
    } as unknown as CompetitionStructure;
    const threeConfirmed = {
      specId: 'pools',
      status: 'generated' as const,
      groups: [
        { id: 'g0', label: 'Pool A', entrants: ['c1', 'c2', 'c3', 'c4'] },
        { id: 'g1', label: 'Pool B', entrants: ['c5', 'c6', 'c7', 'c8'] },
        { id: 'g2', label: 'Pool C', entrants: ['c9', 'c10', 'c11', 'c12'] },
      ],
      audit: [],
    };
    const semisReady = {
      specId: 'semis',
      status: 'ready' as const,
      groups: [{ id: 'g1', label: 'Group A', entrants: ['c1', 'c2', 'c5', 'c6', 'c9', 'c10'] }],
      audit: [],
    };
    const { user } = setup(THREE_POOLS, [
      run(THREE_POOLS, { stages: [threeConfirmed, semisReady] }),
    ]);
    await openConfirm(user, /^Semi-finals · /);

    expect(within(dialog()).getByRole('radio', { name: /^within-group/i })).toBeDisabled();
    expect(within(dialog()).getByRole('radio', { name: /^cross-group/i })).toBeEnabled();
    expect(within(dialog()).getByText(/within-group is unavailable/i)).toBeVisible();
  });
});

describe('the confirm form explains why it asks, and draws the pairing choice', () => {
  it('quotes the rule, says why a human types the order, and notes the trimmed prefill', async () => {
    const { user } = setup(POOLS_TOP_TWO, [run(POOLS_TOP_TWO, { stages: [poolsConfirmed] })]);
    await openConfirm(user, /^Semi-finals · /);

    expect(within(dialog()).getByText(/^The rule:/).parentElement).toHaveTextContent(
      /Top two from each pool/,
    );
    expect(within(dialog()).getByText(/^Why you.re asked:/).parentElement).toHaveTextContent(
      /does not record results, so the finishing order is typed by you and recorded against your name/,
    );
    expect(
      within(dialog()).getByText(
        /Prefilled with the top 2 of each group; sides that did not qualify are not re-added\./,
      ),
    ).toBeVisible();
  });

  it('offers the semi-final pairing as cards, each with its first round drawn in miniature', async () => {
    const { user } = setup(POOLS_TOP_TWO, [run(POOLS_TOP_TWO, { stages: [poolsConfirmed] })]);
    await openConfirm(user, /^Semi-finals · /);

    const group = within(dialog()).getByRole('radiogroup', { name: /semi-final pairing/i });
    expect(within(group).getAllByRole('radio')).toHaveLength(4);
    expect(
      within(group)
        .getByRole('radio', { name: /^within-group/i })
        .closest('label'),
    ).toHaveTextContent('A1 v A2 · B1 v B2');
    expect(
      within(group)
        .getByRole('radio', { name: /^cross-group/i })
        .closest('label'),
    ).toHaveTextContent('A1 v B2 · B1 v A2');
    expect(
      within(dialog()).getByText(/Whether the semi-finals are within each group or across groups/),
    ).toBeVisible();
  });

  it('explains the Position column once, above the table, not per row', async () => {
    const { user } = setup(POOLS_TOP_TWO, [run(POOLS_TOP_TWO, { stages: [poolsConfirmed] })]);
    await openConfirm(user, /^Pools · /);

    expect(within(dialog()).getAllByText(/Where each side finished in its group/)).toHaveLength(1);
    expect(within(dialog()).getAllByText(/^Why you.re asked:/)).toHaveLength(1);
  });
});

describe('stage cards say where each stage is, where it plays and what it needs', () => {
  it('walks the timeline and names the block, the narrative and what is asked', () => {
    setup(SPLIT_LEAGUE, [
      run(SPLIT_LEAGUE, {
        stages: [
          {
            specId: 'double-round',
            status: 'generated',
            groups: [
              { id: 'g0', label: 'Top Six', entrants: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] },
              { id: 'g1', label: 'Bottom Six', entrants: ['c7', 'c8', 'c9', 'c10', 'c11', 'c12'] },
            ],
            audit: [],
          },
        ],
      }),
    ]);

    const first = cardFor(/^Double round · /);
    expect(currentStep(first)).toHaveTextContent(
      /^GeneratedApprove and release from the Fixtures list$/,
    );
    expect(within(first).getByText(/^Plays in Block 1 · /)).toBeVisible();
    expect(within(first).getByText(/^Stage 1 · Round-robin stage · /)).toBeVisible();
    // A generated stage no longer shows it as a hint; the card still says it.
    expect(
      within(first).getByText(/What the platform needs from you:/).parentElement,
    ).toHaveTextContent(/Which sides play in each group/);

    // The final round waits on the admin: its sides are chosen from the first stage.
    const second = cardFor(/^Final round · /);
    expect(currentStep(second)).toHaveTextContent(/^Awaiting entrants/);
    expect(currentStep(second)).toHaveTextContent(/Which sides play in each group/);
    expect(within(second).getByText(/^Plays in Block 2 · /)).toBeVisible();
    expect(within(second).getByRole('button', { name: /confirm entrants/i })).toBeVisible();
  });

  it('reads Ready before generation and Released once every group is out', async () => {
    const readyStage = { specId: 'league', status: 'ready' as const, groups: [], audit: [] };
    const { user, onGenerate, rerenderRuns } = setup(ONE_STAGE_FOR_CARDS, [
      run(ONE_STAGE_FOR_CARDS, { stages: [readyStage] }),
    ]);
    expect(currentStep()).toHaveTextContent(/^ReadyGenerate to create the fixtures$/);

    await user.click(screen.getByRole('button', { name: /generate \d+ fixtures/i }));
    const { series, groups } = seriesFromGenerate(onGenerate.mock.calls[0], { released: true });
    rerenderRuns(
      [
        run(ONE_STAGE_FOR_CARDS, {
          stages: [
            {
              specId: 'league',
              status: 'generated',
              groups: groups.map((g) => ({
                id: g.id,
                label: 'Group A',
                entrants: [],
                seriesId: g.seriesId,
              })),
              audit: [],
            },
          ],
        }),
      ],
      series,
    );
    expect(currentStep()).toHaveTextContent(/^Released$/);
  });

  it('keeps Start a season to an outline button once a season is on screen', () => {
    setup(SPLIT_LEAGUE, [run(SPLIT_LEAGUE)]);
    expect(screen.getByRole('button', { name: /start a season/i })).not.toHaveClass('btn-teal');
  });
});

const ONE_STAGE_FOR_CARDS: CompetitionStructure = {
  id: 'flat-cards',
  name: 'One round robin',
  version: 1,
  stages: [stage({ id: 'league', name: 'League' })],
} as unknown as CompetitionStructure;

/* ─────────────────────────────────────────────────────────────────────────────
   Schedule staleness from a structure rebase. The server marks `staleSchedule` on any
   stage whose schedule spec changed — even one with nothing generated yet — so the card
   only surfaces it once there are series to rebuild.
   ───────────────────────────────────────────────────────────────────────────── */

const ONE_STAGE: CompetitionStructure = {
  id: 'flat',
  name: 'One round robin',
  version: 1,
  stages: [stage({ id: 'league', name: 'League' })],
} as unknown as CompetitionStructure;

describe('a rebase-changed schedule — "Needs regenerating" only once there are fixtures', () => {
  it('ignores the marker before generation, then shows it over generated series', async () => {
    const readyStage = { specId: 'league', status: 'ready' as const, groups: [], audit: [] };
    const { user, onGenerate, rerenderRuns } = setup(ONE_STAGE, [
      run(ONE_STAGE, { stages: [{ ...readyStage, staleSchedule: true }] }),
    ]);

    // Nothing generated: generating simply uses the new schedule, nothing is stale.
    expect(screen.queryByText(/needs regenerating/i)).toBeNull();
    expect(currentStep()).toHaveTextContent(/^Ready/);

    await user.click(screen.getByRole('button', { name: /generate \d+ fixtures/i }));
    const { series, groups } = seriesFromGenerate(onGenerate.mock.calls[0]);
    const generated = {
      specId: 'league',
      status: 'generated' as const,
      groups: groups.map((g) => ({
        id: g.id,
        label: 'Group A',
        entrants: [],
        seriesId: g.seriesId,
      })),
      audit: [],
    };

    // Generated, same pairings, no marker: plain "Generated".
    rerenderRuns([run(ONE_STAGE, { stages: [generated] })], series);
    expect(currentStep()).toHaveTextContent(/^Generated/);
    expect(screen.queryByText(/needs regenerating/i)).toBeNull();

    // Generated AND marked: the pairings still match, so only the marker can say so.
    rerenderRuns([run(ONE_STAGE, { stages: [{ ...generated, staleSchedule: true }] })]);
    expect(screen.getByText(/needs regenerating/i)).toBeVisible();
    expect(screen.getByText(/schedule for this stage changed/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /regenerate \d+ fixtures/i })).toBeVisible();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   A chained stage (`startAfter: 'previous-stage'`) must start after its feeder, so a
   feeder regenerate that pushes the feeder later can run into it while every pairing
   stays put. The check is an ACTUAL overlap — the chained stage's earliest fixture on or
   before the feeder's latest — so a hand-rescheduled fixture never flags on its own.
   ───────────────────────────────────────────────────────────────────────────── */

describe('a chained stage notices when its feeder now runs into its fixtures', () => {
  const chainedStructure = (startAfter: boolean): CompetitionStructure =>
    ({
      id: 'chain',
      name: 'League then play-off',
      version: 1,
      stages: [
        stage({ id: 'league', name: 'League' }),
        stage({
          id: 'playoff',
          name: 'Play-off',
          entrants: { kind: 'manual' },
          schedule: {
            blockIndex: 0,
            cadence: { kind: 'weekly' },
            ...(startAfter ? { startAfter: 'previous-stage' } : {}),
          },
        }),
      ],
    }) as unknown as CompetitionStructure;

  const playoffReady = {
    specId: 'playoff',
    status: 'ready' as const,
    groups: [{ id: 'g1', label: 'Group A', entrants: ['c1', 'c2'] }],
    audit: [],
  };

  /**
   * Generate the play-off, then land its series — every fixture moved to `playoffDate`
   * when given — alongside a feeder (league) series whose last round is `feederLast`
   * (`'playoff-start'` puts it on the play-off's own opening date).
   */
  const generateThenLand = async (
    startAfter: boolean,
    { playoffDate, feederLast }: { playoffDate?: string; feederLast: string | 'playoff-start' },
  ) => {
    const structure = chainedStructure(startAfter);
    const { user, onGenerate, rerenderRuns } = setup(structure, [
      run(structure, { stages: [playoffReady] }),
    ]);
    await user.click(
      within(cardFor(/^Play-off · /)).getByRole('button', { name: /generate \d+ fixtures/i }),
    );
    const { series, groups } = seriesFromGenerate(onGenerate.mock.calls[0]);
    const playoff = series.map(
      (s) =>
        ({
          ...s,
          fixtures: (s.fixtures as Array<Record<string, unknown>>).map((f) =>
            playoffDate ? { ...f, date: playoffDate } : f,
          ),
        }) as unknown as Series,
    );
    const playoffStart = playoff
      .flatMap((s) => (s.fixtures as Array<{ date?: string }>).map((f) => f.date!))
      .sort()[0];
    const feeder = {
      id: 's-run-1-league-g-league',
      name: 'League',
      teams: ['c1', 'c2', 'c3', 'c4'],
      fixtures: [
        { round: 1, home: 'c1', away: 'c2', date: '2026-09-12' },
        {
          round: 2,
          home: 'c3',
          away: 'c4',
          date: feederLast === 'playoff-start' ? playoffStart : feederLast,
        },
      ],
      released: false,
      seasonRunId: 'run-1',
      stageSpecId: 'league',
      groupId: 'g-league',
      version: 1,
    } as unknown as Series;
    rerenderRuns(
      [
        run(structure, {
          stages: [
            {
              ...playoffReady,
              status: 'generated',
              groups: playoffReady.groups.map((g) => ({ ...g, seriesId: groups[0].seriesId })),
            },
          ],
        }),
      ],
      [feeder, ...playoff],
    );
  };

  it('flags a chained stage once its regenerated feeder runs into its fixtures', async () => {
    // The feeder's last round now lands on the play-off's opening date.
    await generateThenLand(true, { feederLast: 'playoff-start' });
    const card = cardFor(/^Play-off · /);
    expect(within(card).getByText(/needs regenerating/i)).toBeVisible();
    expect(
      within(card).getByText(/the stage this one follows now runs into these fixtures/i),
    ).toBeVisible();
  });

  it('leaves a chained stage alone when its own opener is merely rescheduled later', async () => {
    // A rained-off play-off pushed into December, well clear of the feeder's last round.
    await generateThenLand(true, { playoffDate: '2026-12-05', feederLast: '2026-09-19' });
    const card = cardFor(/^Play-off · /);
    expect(within(card).queryByText(/needs regenerating/i)).toBeNull();
    expect(currentStep(card)).toHaveTextContent(/^Generated/);
  });

  it('never flags an unchained stage, even when it overlaps the stage before it', async () => {
    await generateThenLand(false, { feederLast: 'playoff-start' });
    const card = cardFor(/^Play-off · /);
    expect(within(card).queryByText(/needs regenerating/i)).toBeNull();
    expect(currentStep(card)).toHaveTextContent(/^Generated/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Rebase — adopting a newer structure version. The run keeps its snapshot until an admin
   reviews the diff and applies it; drafts regenerate one stage at a time, with a fresh
   read of the run between stages (each generate patches the run with the version it was
   handed, so a loop over one snapshot would 409 on the second stage).
   ───────────────────────────────────────────────────────────────────────────── */

describe('rebase — review and apply a newer structure version', () => {
  const TWO_STAGES_V1: CompetitionStructure = {
    id: 'two',
    name: 'League and cup',
    version: 1,
    stages: [
      stage({ id: 'league', name: 'League' }),
      stage({ id: 'cup', name: 'Cup', schedule: { blockIndex: 1, cadence: { kind: 'weekly' } } }),
    ],
  } as unknown as CompetitionStructure;
  /** v2: both stages move to Saturday + Sunday — a schedule change, fixtures must move. */
  const TWO_STAGES_V2: CompetitionStructure = {
    ...TWO_STAGES_V1,
    version: 2,
    stages: TWO_STAGES_V1.stages.map((s) => ({
      ...s,
      schedule: { ...s.schedule, cadence: { kind: 'weekdays', days: [0, 6] } },
    })),
  } as unknown as CompetitionStructure;

  const generatedStage = (specId: string) => ({
    specId,
    status: 'generated' as const,
    groups: [{ id: 'g1', label: 'Group A', entrants: [], seriesId: `ser-${specId}` }],
    audit: [],
  });
  const draft = (specId: string, over: Partial<Series> = {}) =>
    ({
      id: `ser-${specId}`,
      name: specId,
      fixtures: [],
      released: false,
      seasonRunId: 'run-1',
      stageSpecId: specId,
      groupId: 'g1',
      version: 1,
      ...over,
    }) as unknown as Series;
  const v1Run = () =>
    run(TWO_STAGES_V1, { stages: [generatedStage('league'), generatedStage('cup')] });
  const rebased = (version: number) =>
    run(TWO_STAGES_V2, {
      version,
      stages: [
        { ...generatedStage('league'), staleSchedule: true },
        { ...generatedStage('cup'), staleSchedule: true },
      ],
    });

  it('shows no banner while the run is on the live version', () => {
    setup(TWO_STAGES_V1, [v1Run()], { structures: [TWO_STAGES_V1] });
    expect(screen.queryByText(/the template is now/i)).toBeNull();
  });

  it('applies v2 and regenerates each draft stage against a freshly read run', async () => {
    const onRebaseRun = vi.fn().mockResolvedValue(rebased(2));
    const onFetchRun = vi.fn().mockResolvedValue(rebased(3));
    const { user, onGenerate } = setup(TWO_STAGES_V1, [v1Run()], {
      series: [draft('league'), draft('cup')],
      structures: [TWO_STAGES_V2],
      onRebaseRun,
      onFetchRun,
    });

    expect(screen.getByText(/runs structure v1; the template is now v2/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /review changes/i }));

    // Both stages changed their schedule, and every series is a draft: offered, ticked.
    expect(within(dialog()).getAllByText(/changed · schedule/i)).toHaveLength(2);
    expect(within(dialog()).getAllByText(/drafts will be regenerated/i)).toHaveLength(2);
    expect(within(dialog()).getByRole('checkbox', { name: /league/i })).toBeChecked();
    expect(within(dialog()).getByText(/venues and any dates you changed by hand are lost/i));
    expect(within(dialog()).getByText(/keep occupying their grounds/i)).toBeVisible();

    await user.click(within(dialog()).getByRole('button', { name: /apply structure v2/i }));

    expect(onRebaseRun).toHaveBeenCalledWith('run-1', { structureVersion: 2, version: 1 });
    expect(onGenerate).toHaveBeenCalledTimes(2);
    // Stage one generates against the run the rebase returned…
    const [firstRun, firstStage] = onGenerate.mock.calls[0];
    expect(firstRun.version).toBe(2);
    expect(firstStage.id).toBe('league');
    expect(firstStage.schedule.cadence.kind).toBe('weekdays');
    // …stage two against a FRESH read, not the snapshot stage one already moved on.
    expect(onFetchRun).toHaveBeenCalledTimes(1);
    const [secondRun, secondStage] = onGenerate.mock.calls[1];
    expect(secondRun.version).toBe(3);
    expect(secondStage.id).toBe('cup');

    expect(within(dialog()).getByRole('status')).toHaveTextContent(/regenerated: league, cup/i);
  });

  it('a rebase refused because the structure moved again says to reopen Review changes', async () => {
    const onRebaseRun = vi
      .fn()
      .mockRejectedValue(
        new ApiError(
          409,
          'the structure changed since you reviewed it; refetch',
          'structure_changed',
        ),
      );
    const { user, onGenerate } = setup(TWO_STAGES_V1, [v1Run()], {
      series: [draft('league'), draft('cup')],
      structures: [TWO_STAGES_V2],
      onRebaseRun,
    });

    await user.click(screen.getByRole('button', { name: /review changes/i }));
    await user.click(within(dialog()).getByRole('button', { name: /apply structure v2/i }));

    expect(
      await within(dialog()).findByText(
        'The operator changed this structure again while you were reviewing it. Close this and open Review changes again to see the latest version.',
      ),
    ).toBeVisible();
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it('leaves an unticked stage’s drafts alone and shows the server’s warnings', async () => {
    const onRebaseRun = vi.fn().mockResolvedValue({
      ...rebased(2),
      warnings: ['"Cup" derives from a stage that no longer exists'],
    });
    const { user, onGenerate } = setup(TWO_STAGES_V1, [v1Run()], {
      series: [draft('league'), draft('cup')],
      structures: [TWO_STAGES_V2],
      onRebaseRun,
      onFetchRun: vi.fn(),
    });
    await user.click(screen.getByRole('button', { name: /review changes/i }));
    await user.click(within(dialog()).getByRole('checkbox', { name: /cup/i }));
    await user.click(within(dialog()).getByRole('button', { name: /apply structure v2/i }));

    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onGenerate.mock.calls[0][1].id).toBe('league');
    expect(within(dialog()).getByText(/derives from a stage that no longer exists/i)).toBeVisible();
  });

  it('says why a stage was not regenerated when the fresh read fails', async () => {
    const onRebaseRun = vi.fn().mockResolvedValue(rebased(2));
    const onFetchRun = vi.fn().mockRejectedValue(new Error('Network request failed'));
    const { user, onGenerate } = setup(TWO_STAGES_V1, [v1Run()], {
      series: [draft('league'), draft('cup')],
      structures: [TWO_STAGES_V2],
      onRebaseRun,
      onFetchRun,
    });
    await user.click(screen.getByRole('button', { name: /review changes/i }));
    await user.click(within(dialog()).getByRole('button', { name: /apply structure v2/i }));

    expect(onGenerate).toHaveBeenCalledTimes(1);
    const status = within(dialog()).getByRole('status');
    expect(status).toHaveTextContent(/regenerated: league/i);
    expect(status).toHaveTextContent(/couldn.t regenerate cup/i);
    expect(status).toHaveTextContent(/cup: network request failed/i);
  });

  it('stops at a 401 and lists the stages it never tried', async () => {
    const THREE_V1 = {
      ...TWO_STAGES_V1,
      stages: [...TWO_STAGES_V1.stages, { ...TWO_STAGES_V1.stages[1], id: 'plate', name: 'Plate' }],
    } as CompetitionStructure;
    const THREE_V2 = {
      ...TWO_STAGES_V2,
      stages: [...TWO_STAGES_V2.stages, { ...TWO_STAGES_V2.stages[1], id: 'plate', name: 'Plate' }],
    } as CompetitionStructure;
    const r2 = rebased(2);
    const onRebaseRun = vi.fn().mockResolvedValue({
      ...r2,
      structureSnapshot: THREE_V2,
      stages: [...r2.stages, { ...generatedStage('plate'), staleSchedule: true }],
    });
    const onFetchRun = vi.fn().mockRejectedValue(new ApiError(401, 'Your session has expired'));
    const threeRun = run(THREE_V1, {
      stages: [generatedStage('league'), generatedStage('cup'), generatedStage('plate')],
    });
    const { user, onGenerate } = setup(THREE_V1, [threeRun], {
      series: [draft('league'), draft('cup'), draft('plate')],
      structures: [THREE_V2],
      onRebaseRun,
      onFetchRun,
    });
    await user.click(screen.getByRole('button', { name: /review changes/i }));
    await user.click(within(dialog()).getByRole('button', { name: /apply structure v2/i }));

    // One fetch, then the loop stops — no second attempt against a lost session.
    expect(onFetchRun).toHaveBeenCalledTimes(1);
    expect(onGenerate).toHaveBeenCalledTimes(1);
    const status = within(dialog()).getByRole('status');
    expect(status).toHaveTextContent(/cup: your session has expired/i);
    expect(status).toHaveTextContent(/plate: not attempted/i);
  });

  it('reports a regenerate that came back with a warning apart from the clean ones', async () => {
    const onRebaseRun = vi.fn().mockResolvedValue(rebased(2));
    const { user, onGenerate } = setup(TWO_STAGES_V1, [v1Run()], {
      series: [draft('league'), draft('cup')],
      structures: [TWO_STAGES_V2],
      onRebaseRun,
      onFetchRun: vi.fn().mockResolvedValue(rebased(3)),
    });
    onGenerate.mockResolvedValueOnce({}).mockResolvedValueOnce({
      warnings: [
        'Paired as a seeded bracket, not cross-group; fix the confirmed positions and regenerate',
      ],
    });
    await user.click(screen.getByRole('button', { name: /review changes/i }));
    await user.click(within(dialog()).getByRole('button', { name: /apply structure v2/i }));

    const status = within(dialog()).getByRole('status');
    expect(status).toHaveTextContent(/regenerated: league\./i);
    expect(status).toHaveTextContent(
      /regenerated cup, with a warning: paired as a seeded bracket, not cross-group/i,
    );
  });

  it('never offers to auto-regenerate a released stage — it keeps the confirm path', async () => {
    const onRebaseRun = vi.fn();
    const { user } = setup(TWO_STAGES_V1, [v1Run()], {
      // The released series is found by its own run/stage back-reference.
      series: [draft('league', { released: true }), draft('cup')],
      structures: [TWO_STAGES_V2],
      onRebaseRun,
    });
    await user.click(screen.getByRole('button', { name: /review changes/i }));
    expect(
      within(dialog()).getByText(/released — you’ll confirm before fixtures are replaced/i),
    ).toBeVisible();
    expect(within(dialog()).queryByRole('checkbox', { name: /league/i })).toBeNull();
    expect(within(dialog()).getByRole('checkbox', { name: /cup/i })).toBeChecked();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   A rebase that changes a stage's entrant spec clears its groups — and the seriesId
   back-pointers with them. The series survive under deterministic ids, so the next
   generate rewrites them in place. The released-schedule prompt must still fire: the
   card finds the series by their own `seasonRunId` / `stageSpecId`.
   ───────────────────────────────────────────────────────────────────────────── */

describe('a rebase-cleared stage re-confirms from where the season actually was', () => {
  const entrantRebase = {
    at: '2026-09-20T09:00:00.000Z',
    by: 'admin@union',
    // Deliberately not registration order — the registered list would put
    // Club 1 in the Top Six.
    prefill: [
      ['c7', 'c8', 'c9', 'c10', 'c11', 'c12'],
      ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
    ],
    accepted: false,
    event: 'rebase' as const,
  };
  // A later schedule- or wording-only rebase appends an entry with nothing to prefill.
  const scheduleRebase = {
    at: '2026-09-22T09:00:00.000Z',
    by: 'admin@union',
    prefill: [],
    accepted: false,
    event: 'rebase' as const,
  };

  it.each([
    ['a single rebase entry', [entrantRebase]],
    ['a later rebase with an empty prefill', [entrantRebase, scheduleRebase]],
  ])('pre-fills the confirm form from the grouping the rebase cleared (%s)', async (_, audit) => {
    const { user } = setup(SPLIT_LEAGUE, [
      run(SPLIT_LEAGUE, {
        stages: [
          {
            specId: 'double-round',
            status: 'awaiting-entrants',
            groups: [],
            audit,
          },
        ],
      }),
    ]);
    await openConfirm(user, /^Double round · /);

    const pickerFor = (side: string) => {
      const row = within(dialog())
        .getAllByRole('row')
        .find((r) => r.textContent?.startsWith(side));
      const sel = within(row!).getByRole('combobox') as HTMLSelectElement;
      return sel.options[sel.selectedIndex].text;
    };
    expect(pickerFor('Club 7')).toBe('Top Six');
    expect(pickerFor('Club 1')).toBe('Bottom Six');
    // The rebase entry is not a confirmation, and must not read as one.
    expect(screen.queryByText(/entrants confirmed by admin@union/i)).toBeNull();
  });
});

describe('a rebase-cleared stage still protects its released series', () => {
  const POOLS_ONLY: CompetitionStructure = {
    id: 'pools-only',
    name: 'Two pools',
    version: 2,
    stages: [
      stage({
        id: 'pools',
        name: 'Pools',
        entrants: { kind: 'seeded-split', method: 'snake', groups: { kind: 'even', count: 2 } },
        groupLabels: ['Pool A', 'Pool B'],
      }),
    ],
  } as unknown as CompetitionStructure;

  it('asks before regenerating over a released series it has no back-pointer to', async () => {
    const released = {
      id: 's-run-1-pools-g1',
      name: 'Premier League · Pools · Pool A',
      fixtures: [],
      released: true,
      seasonRunId: 'run-1',
      stageSpecId: 'pools',
      groupId: 'g1',
      version: 4,
    } as unknown as Series;
    const { user, onGenerate } = setup(
      POOLS_ONLY,
      [
        run(POOLS_ONLY, {
          stages: [
            {
              specId: 'pools',
              status: 'awaiting-entrants',
              groups: [],
              audit: [
                {
                  at: '2026-09-20T09:00:00.000Z',
                  by: 'admin@union',
                  prefill: [
                    ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
                    ['c7', 'c8', 'c9', 'c10', 'c11', 'c12'],
                  ],
                  accepted: false,
                  event: 'rebase',
                },
              ],
            },
          ],
        }),
      ],
      { series: [released] },
    );

    // The series exist, so this is a REgenerate, and it says so.
    expect(screen.getByText(/needs regenerating/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /regenerate \d+ fixtures/i }));

    expect(screen.getByRole('dialog', { name: /regenerate a released schedule/i })).toBeVisible();
    expect(onGenerate).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /replace the fixtures/i }));
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });
});

describe('failure states', () => {
  it('does not offer to start a season when the config could not be loaded', () => {
    render(
      <SeasonRunsPanel
        clubs={clubs}
        allLeagues={[]}
        allSeries={[]}
        runs={[]}
        configFailed
        onOpenLauncher={vi.fn()}
        onPatchRun={vi.fn()}
        onGenerate={vi.fn()}
        onDeleteRun={vi.fn()}
      />,
    );

    // Otherwise a loading failure reads as "no season running" beside a Start button
    // whose duplicate guard is checking an empty list.
    expect(screen.queryByRole('button', { name: /start a season/i })).toBeNull();
  });
});

describe('the swap prefill starts from where the previous stage ended', () => {
  /*
   * Found by running the app, not by any gate. Stage 1 was confirmed as
   * Top Six = [Club 7, 8, 9] and stage 2 proposed Top Six = [Club 1, 2, 3] — the exact
   * inverse — because the prefill blocked the REGISTERED list into the right sizes and
   * called that a suggestion. A swap moves one side; this moved all six.
   *
   * It passed an earlier manual walkthrough only because that season's clubs happened to
   * sit in alphabetical order, so the wrong answer and the right one coincided.
   */
  const stage1Confirmed = (top: string[], bottom: string[]) =>
    run(SPLIT_LEAGUE, {
      stages: [
        {
          specId: 'double-round',
          status: 'generated',
          groups: [
            { id: 'g0', label: 'Top Six', entrants: top },
            { id: 'g1', label: 'Bottom Six', entrants: bottom },
          ],
          audit: [],
        },
      ],
    });

  const groupOf = (side: string) => {
    const row = within(dialog())
      .getAllByRole('row')
      .find((r) => r.textContent?.startsWith(side));
    const sel = within(row!).getByRole('combobox') as HTMLSelectElement;
    return sel.options[sel.selectedIndex].text;
  };

  it('proposes the previous stage’s groups, not the registration order', async () => {
    const { user } = setup(SPLIT_LEAGUE, [
      // Deliberately NOT alphabetical — the case the earlier walkthrough couldn't see.
      stage1Confirmed(
        ['c7', 'c8', 'c9', 'c10', 'c11', 'c12'],
        ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
      ),
    ]);
    await openConfirm(user, /^Final round · /);

    expect(groupOf('Club 7')).toBe('Top Six');
    expect(groupOf('Club 12')).toBe('Top Six');
    // Blocking the registered list would have put Club 1 top. It finished bottom.
    expect(groupOf('Club 1')).toBe('Bottom Six');
    expect(groupOf('Club 6')).toBe('Bottom Six');
  });

  it('leaves every other side where it was, so accepting it swaps nobody', async () => {
    const top = ['c7', 'c8', 'c9', 'c10', 'c11', 'c12'];
    const bottom = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
    const { user, onPatchRun } = setup(SPLIT_LEAGUE, [stage1Confirmed(top, bottom)]);
    await openConfirm(user, /^Final round · /);
    await user.click(confirmBtn());

    const finalRound = onPatchRun.mock.calls[0][1].stages.find(
      (s: { specId: string }) => s.specId === 'final-round',
    );
    expect(finalRound.groups[0].entrants).toEqual(top);
    expect(finalRound.groups[1].entrants).toEqual(bottom);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Group labels. There were three spellings of one fallback — `labelFor` in the
   engine ("Group A"), `String.fromCharCode(65 + i)` in this form (identical
   until index 26, where it emits "Group ["), and `Group ${i + 1}` on the save
   path. So an unnamed stage DISPLAYED "Group A" and PERSISTED "Group 1", which
   is visible in the live dev data: a human-reconfirmed stage reads "Group 1"
   beside CLI-written ones reading "Group A".
   ───────────────────────────────────────────────────────────────────────────── */

describe('a group is called the same thing wherever it is written', () => {
  /** Two groups, deliberately unnamed, so the fallback is what gets stored. */
  const UNNAMED: CompetitionStructure = {
    id: 'unnamed',
    name: 'Two pools',
    version: 1,
    stages: [
      stage({
        id: 'pools',
        name: 'Pools',
        entrants: { kind: 'seeded-split', method: 'blocks', groups: { kind: 'even', count: 2 } },
      }),
    ],
  } as unknown as CompetitionStructure;

  it('stores Group A and Group B, not Group 1 and Group 2', async () => {
    const { user, onPatchRun } = setup(UNNAMED, [run(UNNAMED)]);
    await openConfirm(user, /^Pools · /);
    await user.click(confirmBtn());

    const stored = onPatchRun.mock.calls[0][1].stages[0].groups.map(
      (g: { label: string }) => g.label,
    );
    expect(stored).toEqual(['Group A', 'Group B']);
  });

  it('shows the admin the same names it is about to store', async () => {
    const { user } = setup(UNNAMED, [run(UNNAMED)]);
    await openConfirm(user, /^Pools · /);
    const shown = Array.from((groupPickers()[0] as HTMLSelectElement).options).map((o) => o.text);
    expect(shown).toEqual(['Not playing', 'Group A', 'Group B']);
  });
});

describe('two groups may share a name', () => {
  // `groupLabels` is free text from a comma box and nothing — client or server —
  // checks it for uniqueness. Keying the option list by label made a duplicate a
  // React key collision with unstable reconciliation, on the control that decides
  // who gets relegated.
  const SAME_NAME: CompetitionStructure = {
    id: 'same',
    name: 'Two pools, one name',
    version: 1,
    stages: [
      stage({
        id: 'pools',
        name: 'Pools',
        entrants: { kind: 'seeded-split', method: 'blocks', groups: { kind: 'even', count: 2 } },
        groupLabels: ['Pool A', 'Pool A'],
      }),
    ],
  } as unknown as CompetitionStructure;

  it('renders both without a duplicate-key warning, and keeps them distinct', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { user, onPatchRun } = setup(SAME_NAME, [run(SAME_NAME)]);
    await openConfirm(user, /^Pools · /);

    expect(spy.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false);

    // Both groups are offered, and picking the SECOND puts the side in the second
    // group — not the first one that happens to share its name.
    const options = Array.from((groupPickers()[0] as HTMLSelectElement).options);
    expect(options.map((o) => o.text)).toEqual(['Not playing', 'Pool A', 'Pool A']);
    await user.selectOptions(groupPickers()[0], '1');
    await user.click(confirmBtn());

    const groups = onPatchRun.mock.calls[0][1].stages[0].groups;
    expect(groups[1].entrants).toContain('c1');
    expect(groups[0].entrants).not.toContain('c1');
    spy.mockRestore();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   GenerateFixturesLauncher — routing into StartSeasonForm and back.

   Once routed past the league picker there used to be no way back to it short of
   closing the whole modal — which threw away the league choice too, not just the
   in-progress form. Back returns to the picker without calling `onClose`.
   ───────────────────────────────────────────────────────────────────────────── */

describe('GenerateFixturesLauncher — Back out of "Start a season"', () => {
  const launcherProps = (over: Partial<Parameters<typeof GenerateFixturesLauncher>[0]> = {}) => ({
    clubs,
    allLeagues: [league(SPLIT_LEAGUE.id)],
    config: { structures: [SPLIT_LEAGUE], calendars: [calendar] } as unknown as TenantConfig,
    existingRuns: [],
    onCreateRun: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    toast: vi.fn(),
    ...over,
  });

  it('returns to the league picker rather than closing the launcher', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<GenerateFixturesLauncher {...launcherProps({ onClose })} />);

    // The one season-capable league routes straight into StartSeasonForm.
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    expect(screen.getByRole('button', { name: /^start season$/i })).toBeInTheDocument();
    // Under the primary button: what the admin will do after starting, in order.
    expect(screen.getByText('What happens next').nextElementSibling).toHaveTextContent(
      /Confirm entrants.*finishing order.*Generate fixtures.*Approve.*Release/,
    );

    await user.click(screen.getByRole('button', { name: /^back$/i }));

    // Back at the league picker — Continue is there again, and the launcher itself
    // was never told to close.
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^start season$/i })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says plainly when a league has a competition its operator set up', () => {
    render(<GenerateFixturesLauncher {...launcherProps()} />);

    expect(screen.getByRole('dialog', { name: /^start a season$/i })).toBeInTheDocument();
    expect(
      screen.getByText(
        /This league has a competition set up by your operator: 50 Over \(Split league with mid-season swap\)/,
      ),
    ).toBeInTheDocument();
    // Outside a HelpProvider the help link falls back to the guide page.
    expect(screen.getByRole('link', { name: /how does this work/i })).toHaveAttribute(
      'href',
      expect.stringContaining('league-structures-tutorial'),
    );
    // A bound league continues to the season form — no quick start on offer.
    expect(screen.queryByRole('radiogroup', { name: /how the season is played/i })).toBeNull();
  });

  it('falls back to the league picker if the chosen league vanishes mid-flow', async () => {
    const flatLeague = {
      key: 'friendlies',
      label: 'Friendlies',
      group: 'Senior',
      district: 'All districts',
    } as unknown as League;
    const onClose = vi.fn();

    const { rerender } = render(
      <GenerateFixturesLauncher {...launcherProps({ allLeagues: [flatLeague], onClose })} />,
    );
    expect(screen.getByRole('radiogroup', { name: /how the season is played/i })).toBeVisible();

    // The league is gone from config — deleted in another tab, picked up by this
    // console's own refetch — while the admin is looking at its quick start.
    rerender(<GenerateFixturesLauncher {...launcherProps({ allLeagues: [], onClose })} />);

    // Back to a plain picker — not a form for a league that no longer exists.
    expect(screen.queryByRole('radiogroup', { name: /how the season is played/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  // ADR 0014: exactly two paths. A one-off event is the One-off tournament template in
  // quick start, not a third, league-less option.
  it('offers only leagues — no one-off series option', () => {
    render(<GenerateFixturesLauncher {...launcherProps()} />);
    const options = within(screen.getByRole('combobox', { name: 'League' }))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Premier League']);
    expect(screen.queryByRole('option', { name: /one-off/i })).toBeNull();
  });

  it('counts the registered sides and says how many are not yet affiliated', () => {
    const mixed = clubs.map((c, i) =>
      i < 2 ? { ...c, affiliation: 'in_progress' } : c,
    ) as unknown as Club[];
    render(<GenerateFixturesLauncher {...launcherProps({ clubs: mixed })} />);
    expect(
      screen.getByText(/12 sides \(2 not yet affiliated\) registered for Premier League/),
    ).toBeVisible();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Quick start — a league with no competition starts a season from a starter shape.
   The server builds the competition, structure, calendar and run in one call; the form
   previews the season as the same narrative the operator console shows.
   ───────────────────────────────────────────────────────────────────────────── */

describe('Quick start', () => {
  const flatLeague = {
    key: 'friendlies',
    label: 'Friendlies',
    group: 'Senior',
    district: 'All districts',
  } as unknown as League;

  // The top-of-file `clubs` fixture is registered for 'premier', not 'friendlies'.
  const friendliesClubs = clubs.map((c) => ({ ...c, leagues: ['friendlies'] })) as Club[];

  const mockedQuickStart = vi.mocked(quickStartSeason);

  const setup = (over: Record<string, unknown> = {}) => {
    const onSeasonSetupChanged = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <GenerateFixturesLauncher
        clubs={friendliesClubs}
        allLeagues={[flatLeague]}
        config={{ structures: [], calendars: [calendar] } as unknown as TenantConfig}
        existingRuns={[]}
        onCreateRun={vi.fn()}
        onSeasonSetupChanged={onSeasonSetupChanged}
        onClose={onClose}
        toast={vi.fn()}
        {...over}
      />,
    );
    return { user, onSeasonSetupChanged, onClose };
  };

  const shapes = () => screen.getByRole('radiogroup', { name: /how the season is played/i });
  const startBtn = () => screen.getByRole('button', { name: /^start season$/i });

  beforeEach(() => {
    mockedQuickStart.mockReset();
    mockedQuickStart.mockResolvedValue({
      run: {} as SeasonRun,
      competitionId: 'comp-1',
      structureId: 'st-1',
      calendarId: 'cal',
    });
  });

  it('says the league has no competition and offers the starter shapes, flat first', () => {
    setup();

    expect(
      screen.getByText(
        /No competition has been set up for this league yet\. Quick-start one below/,
      ),
    ).toBeVisible();
    const cards = within(shapes()).getAllByRole('radio');
    expect(cards).toHaveLength(6);
    expect(within(shapes()).getByRole('radio', { name: /^flat round robin/i })).toBeChecked();
    // Each card carries its first stage's example from the stage-kind registry.
    expect(within(shapes()).getAllByText(/^e\.g\. /).length).toBeGreaterThan(0);
  });

  it('previews the season as a narrative against the registered sides and the calendar', async () => {
    const { user } = setup();

    expect(
      screen.getByText(/Stage 1 · Round-robin stage · all 12 sides in one group · everyone plays/),
    ).toBeVisible();

    await user.click(
      within(shapes()).getByRole('radio', { name: /^seeded groups → cross-group semis/i }),
    );
    expect(
      screen.getByText(/Stage 1 · Round-robin stage · 12 sides seeded into 2 groups/),
    ).toBeVisible();
    expect(screen.getByText(/^Stage 2 · Knockout stage/)).toBeVisible();
    // Two blocks on the calendar: each stage gets a "plays in" choice, prefilled.
    expect(screen.getByRole('combobox', { name: 'Stage 1 plays in' })).toHaveValue('0');
    expect(screen.getByRole('combobox', { name: 'Stage 2 plays in' })).toHaveValue('1');
  });

  it('posts the quick start, refetches, then shows what happens next', async () => {
    const { user, onSeasonSetupChanged } = setup();

    await user.click(
      within(shapes()).getByRole('radio', { name: /^seeded groups → cross-group semis/i }),
    );
    // Keep the knockout in the first block, straight after the groups.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Stage 2 plays in' }), '0');
    await user.selectOptions(screen.getByLabelText('Match format'), 'One-Day (40-50 overs)');
    // Picking a format prefills its overs; ball type stays the admin's to add.
    expect(screen.getByLabelText('Overs')).toHaveValue(50);
    await user.type(screen.getByLabelText('Ball type'), 'White');
    await user.click(startBtn());

    expect(mockedQuickStart).toHaveBeenCalledTimes(1);
    expect(mockedQuickStart).toHaveBeenCalledWith({
      leagueKey: 'friendlies',
      templateId: 'pools-to-knockout',
      seasonLabel: currentSeasonLabel(),
      calendar: { id: 'cal' },
      matchFormat: { label: 'One-Day (40-50 overs)', overs: 50, ballType: 'White' },
      placement: [0, 0],
    });
    expect(onSeasonSetupChanged).toHaveBeenCalledTimes(1);

    expect(await screen.findByRole('status')).toHaveTextContent(/Friendlies · .* has started/);
    const next = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(next.join('|')).toMatch(/Confirm entrants.*Generate fixtures.*Approve.*Release/);
    expect(screen.queryByRole('radiogroup', { name: /how the season is played/i })).toBeNull();
  });

  it('offers the tenant’s own match formats and prefills overs and ball type from the pick', async () => {
    const { user } = setup({
      config: {
        structures: [],
        calendars: [calendar],
        competitionDefaults: {
          matchFormats: [
            { label: '50 Over (Red Ball)', overs: 50, ballType: 'Red' },
            { label: 'T20 (Pink Ball)', overs: 20, ballType: 'Pink' },
          ],
        },
      } as unknown as TenantConfig,
    });

    const picker = screen.getByLabelText('Match format');
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['50 Over (Red Ball)', 'T20 (Pink Ball)']);
    // The first format is the default, overs and ball included.
    expect(screen.getByLabelText('Overs')).toHaveValue(50);
    expect(screen.getByLabelText('Ball type')).toHaveValue('Red');

    await user.selectOptions(picker, 'T20 (Pink Ball)');
    expect(screen.getByLabelText('Overs')).toHaveValue(20);
    expect(screen.getByLabelText('Ball type')).toHaveValue('Pink');
    await user.click(startBtn());

    expect(mockedQuickStart).toHaveBeenCalledWith(
      expect.objectContaining({
        matchFormat: { label: 'T20 (Pink Ball)', overs: 20, ballType: 'Pink' },
      }),
    );
  });

  it('sends custom dates as a label with a start and an end, and no placement', async () => {
    const { user } = setup();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Dates' }), 'Custom dates');
    expect(screen.getByText(/The first and last date a match may be played/)).toBeVisible();
    expect(startBtn()).toBeDisabled();

    await user.type(screen.getByLabelText('Start date'), '2026-09-05');
    await user.type(screen.getByLabelText('End date'), '2026-12-12');
    await user.click(startBtn());

    expect(mockedQuickStart).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: 'flat-round-robin',
        calendar: { label: currentSeasonLabel(), start: '2026-09-05', end: '2026-12-12' },
      }),
    );
    expect(mockedQuickStart.mock.calls[0][0]).not.toHaveProperty('placement');
  });

  it('keeps the form open with the server’s reason when the quick start is refused', async () => {
    mockedQuickStart.mockRejectedValue(
      new ApiError(400, 'That season is already running for this league.'),
    );
    const { user, onSeasonSetupChanged } = setup();

    await user.click(startBtn());

    expect(
      await screen.findByText('That season is already running for this league.'),
    ).toBeVisible();
    expect(onSeasonSetupChanged).not.toHaveBeenCalled();
    expect(shapes()).toBeVisible();
  });

  it('refetches before showing the recovery copy when the season could not be started', async () => {
    mockedQuickStart.mockRejectedValue(
      new ApiError(
        500,
        'The competition was set up (cmp-1) but its season could not be started — start it from "Start a season"',
        'run_not_started',
        { competitionId: 'cmp-1' },
      ),
    );
    const { user, onSeasonSetupChanged } = setup();

    await user.click(startBtn());

    expect(
      await screen.findByText(
        "The competition was created but the season didn't start. Pick this league again and start it from its competition.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/run_not_started/)).toBeNull();
    // The competition now exists, so the config must be refetched for "Start a season"
    // to find it.
    expect(onSeasonSetupChanged).toHaveBeenCalledTimes(1);
  });

  it('turns a coded date refusal into how to type a date', async () => {
    mockedQuickStart.mockRejectedValue(
      new ApiError(
        400,
        'a new calendar needs valid start and end dates (YYYY-MM-DD)',
        'invalid_dates',
      ),
    );
    const { user } = setup();

    await user.click(startBtn());

    expect(
      await screen.findByText(
        'Enter the dates as year-month-day (for example 2026-10-03), with the end on or after the start.',
      ),
    ).toBeVisible();
  });

  it('says how to carry on when the season label is already taken', async () => {
    mockedQuickStart.mockRejectedValue(
      new ApiError(409, '"2026/27" is already running for "Premier Men"', 'season_exists'),
    );
    const { user } = setup();

    await user.click(startBtn());

    expect(
      await screen.findByText(
        '"2026/27" is already running for "Premier Men". Give the new season a different label, or carry on with the existing one under Seasons.',
      ),
    ).toBeVisible();
  });

  it('reports a failure that never reached the server, and says to try again', async () => {
    const offline = new TypeError('Failed to fetch');
    mockedQuickStart.mockRejectedValue(offline);
    const { user, onSeasonSetupChanged } = setup();

    await user.click(startBtn());

    expect(await screen.findByText(/^Couldn't reach the (local API|server)\./)).toBeVisible();
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(offline, {
      tags: { where: 'quick-start' },
    });
    expect(onSeasonSetupChanged).not.toHaveBeenCalled();
  });

  describe('a league whose competitions are on calendars that have ended', () => {
    const endingOn = (end: string): SeasonCalendar => ({
      id: 'cal-old',
      label: '2025/26',
      blocks: [{ id: 'b1', label: 'Block 1', start: addDays(end, -60), end }],
    });
    const boundLeague = {
      ...flatLeague,
      competitions: [
        { id: 'cmp-old', label: '50 Over', structureId: 'st-old', calendarId: 'cal-old' },
      ],
    } as unknown as League;
    const bound = (cal: SeasonCalendar) => ({
      allLeagues: [boundLeague],
      config: {
        structures: [{ id: 'st-old', name: 'Old league', version: 1, stages: [] }],
        calendars: [cal, calendar],
      } as unknown as TenantConfig,
    });

    it('offers quick start when every calendar ended before today', () => {
      const yesterday = addDays(todayIso(), -1);
      setup(bound(endingOn(yesterday)));

      expect(
        screen.getByText(
          `This league's competitions are on calendars that have ended (2025/26, ended ${formatIsoDate(yesterday)}). Quick-start the new season below, or ask your operator to bind a new calendar.`,
        ),
      ).toBeVisible();
      expect(shapes()).toBeVisible();
      expect(screen.queryByRole('button', { name: /^continue$/i })).toBeNull();
    });

    it('says the operator can renew last season’s structure instead', () => {
      setup(bound(endingOn(addDays(todayIso(), -1))));

      expect(
        screen.getByText(
          "Your operator can also renew last season's Old league in the season wizard.",
        ),
      ).toBeVisible();
    });

    it('continues to the season form while a calendar is still running', () => {
      setup(bound(endingOn(addDays(todayIso(), 1))));

      expect(screen.queryByRole('radiogroup', { name: /how the season is played/i })).toBeNull();
      expect(screen.getByText(/has a competition set up by your operator/)).toBeVisible();
      expect(screen.getByRole('button', { name: /^continue$/i })).toBeInTheDocument();
    });
  });

  it('warns when the chosen calendar keeps a block nothing on it plays in', async () => {
    const { user } = setup();

    // Flat round robin on the two-block calendar: Block 2 is left empty.
    expect(
      screen.getByText(/^2026\/27: Block 2 \(.*\) — no competition on this calendar uses it$/),
    ).toBeVisible();

    // Custom dates are one block the new season always fills — nothing to warn about.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Dates' }), 'Custom dates');
    await user.type(screen.getByLabelText('Start date'), '2026-09-05');
    await user.type(screen.getByLabelText('End date'), '2026-12-12');
    expect(screen.queryByText(/no competition on this calendar uses it/)).toBeNull();
  });

  it('counts competitions other leagues already run on the calendar', () => {
    // Another league's structure plays Block 2, so between them the calendar is covered.
    const blockTwo = {
      id: 'st-b2',
      name: 'Second half',
      version: 1,
      stages: [
        stage({
          id: 'late',
          name: 'Late',
          schedule: { blockIndex: 1, cadence: { kind: 'weekly' } },
        }),
      ],
    };
    const other = {
      key: 'div1',
      label: 'Division 1',
      competitions: [{ id: 'cx', label: 'League', structureId: 'st-b2', calendarId: 'cal' }],
    };
    setup({
      allLeagues: [flatLeague],
      config: {
        structures: [blockTwo],
        calendars: [calendar],
        leagues: [flatLeague, other],
      } as unknown as TenantConfig,
    });

    expect(screen.queryByText(/no competition on this calendar uses it/)).toBeNull();
  });

  it('repeats the server’s coverage warnings once the season has started', async () => {
    mockedQuickStart.mockResolvedValue({
      run: {} as SeasonRun,
      competitionId: 'comp-1',
      structureId: 'st-1',
      calendarId: 'cal',
      warnings: ['2026/27: Block 2 (from the server) — no competition on this calendar uses it'],
    });
    const { user } = setup();

    await user.click(startBtn());

    expect(await screen.findByRole('status')).toHaveTextContent(/has started/);
    expect(
      screen.getByText(
        '2026/27: Block 2 (from the server) — no competition on this calendar uses it',
      ),
    ).toBeVisible();
  });

  it('refuses to start with fewer than two registered sides', () => {
    setup({ clubs: [] });
    expect(screen.getByText(/at least two affiliated sides must be registered/i)).toBeVisible();
    expect(startBtn()).toBeDisabled();
  });

  // The affiliation gate: the preview counts only affiliated sides.
  it('previews against the affiliated sides only', () => {
    setup({
      clubs: friendliesClubs.map((c, i) => (i < 2 ? { ...c, affiliation: 'in_progress' } : c)),
    });
    expect(screen.getByText(/with the 10 sides registered for Friendlies/)).toBeVisible();
    expect(screen.getByText(/all 10 sides in one group/)).toBeVisible();
  });

  // What the retired create-series form did for a cup weekend, as a template.
  it('starts a one-off tournament from its template', async () => {
    const { user } = setup();

    await user.click(within(shapes()).getByRole('radio', { name: /^one-off tournament/i }));
    expect(
      screen.getByText(/Stage 1 · Knockout stage · chosen by the admin · a seeded knockout/),
    ).toBeVisible();
    await user.click(startBtn());

    expect(mockedQuickStart).toHaveBeenCalledWith(
      expect.objectContaining({ leagueKey: 'friendlies', templateId: 'one-off-tournament' }),
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Dropping a side from an all-registered stage — what the retired create-series form's
   team opt-out chips did, re-homed as Edit entrants (ADR 0014).
   ───────────────────────────────────────────────────────────────────────────── */

describe('Edit entrants on an all-registered stage', () => {
  const FLAT: CompetitionStructure = {
    id: 'flat',
    name: 'Flat round robin',
    version: 1,
    stages: [stage({ id: 'season', name: 'League season' })],
  } as unknown as CompetitionStructure;

  it('opens with every registered side in, and confirming without one writes the groups', async () => {
    const { user, onPatchRun } = setup(FLAT, [run(FLAT)]);

    await openConfirm(user, /^League season · /);
    expect(
      within(dialog()).getByText(
        'Every registered side is in by default. Remove a side here if it is not playing this season.',
      ),
    ).toBeVisible();
    // Every side starts in the one group.
    expect(groupPickers()).toHaveLength(12);
    for (const picker of groupPickers()) expect(picker).toHaveValue('0');

    // Club 3 is not playing this season.
    await user.selectOptions(groupPickers()[2], 'Not playing');
    expect(within(dialog()).getByText('1 not playing')).toBeVisible();
    await user.click(confirmBtn());

    expect(onPatchRun).toHaveBeenCalledTimes(1);
    const [, patch] = onPatchRun.mock.calls[0];
    const [stageRun] = patch.stages;
    expect(stageRun.specId).toBe('season');
    expect(stageRun.status).toBe('ready');
    expect(stageRun.groups).toHaveLength(1);
    expect(stageRun.groups[0].entrants).toHaveLength(11);
    expect(stageRun.groups[0].entrants).not.toContain('c3');
    // Recorded like any other confirmation: the suggestion, and that it was overridden.
    expect(stageRun.audit).toEqual([
      expect.objectContaining({ accepted: false, prefill: [clubs.map((c) => c.id)] }),
    ]);
  });

  it('marks the generated stage stale once a side is dropped', () => {
    const all = clubs.map((c) => c.id);
    // What confirmEntrants writes after a drop on a generated stage: back to 'ready',
    // the series back-pointer kept.
    const dropped = run(FLAT, {
      stages: [
        {
          specId: 'season',
          status: 'ready',
          groups: [
            { id: 'g1', label: 'Group A', entrants: all.filter((t) => t !== 'c3'), seriesId: 's1' },
          ],
        },
      ],
    } as Partial<SeasonRun>);
    const series = [
      { id: 's1', name: 'Premier · League season', released: false, fixtures: [] },
    ] as unknown as Series[];
    setup(FLAT, [dropped], { series });
    expect(screen.getByText(/needs regenerating/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /regenerate \d+ fixtures/i })).toBeVisible();
  });
});

describe('the affiliation gate on Confirm entrants', () => {
  const FLAT: CompetitionStructure = {
    id: 'flat',
    name: 'Flat round robin',
    version: 1,
    stages: [stage({ id: 'season', name: 'League season' })],
  } as unknown as CompetitionStructure;
  // Club 1 and Club 2 have not submitted their affiliation form.
  const mixed = clubs.map((c, i) =>
    i < 2 ? { ...c, affiliation: 'in_progress' } : c,
  ) as unknown as Club[];

  const renderMixed = () => {
    const onPatchRun = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <SeasonRunsPanel
        clubs={mixed}
        allLeagues={[league(FLAT.id)]}
        allSeries={[]}
        runs={[run(FLAT)]}
        onOpenLauncher={vi.fn()}
        onPatchRun={onPatchRun}
        onGenerate={vi.fn().mockResolvedValue(undefined)}
        onDeleteRun={vi.fn()}
      />,
    );
    return { user, onPatchRun };
  };

  it('keeps unaffiliated sides out of the pool and says how many there are', () => {
    renderMixed();
    expect(screen.getByText(/12 sides \(2 not yet affiliated\) registered/)).toBeVisible();
    // The group line's <strong> is the label; its parent reads "Group A · 10 sides · …".
    expect(screen.getByText('Group A', { selector: 'strong' }).parentElement).toHaveTextContent(
      /^Group A · 10 sides/,
    );
  });

  it('lists them greyed with a one-click "Include anyway"', async () => {
    const { user, onPatchRun } = renderMixed();
    await openConfirm(user, /^League season · /);

    expect(groupPickers()).toHaveLength(10);
    const held = within(dialog())
      .getAllByText('Not yet affiliated')
      .map((el) => el.closest('tr')!);
    expect(held).toHaveLength(2);
    for (const row of held) expect(row).toHaveClass('sr-held-back');

    await user.click(within(dialog()).getByRole('button', { name: 'Include Club 1 anyway' }));
    // Included straight into the only group; the other stays held back.
    expect(groupPickers()).toHaveLength(11);
    expect(within(dialog()).getAllByText('Not yet affiliated')).toHaveLength(1);
    await user.click(confirmBtn());

    const [, patch] = onPatchRun.mock.calls[0];
    expect(patch.stages[0].groups[0].entrants).toHaveLength(11);
    expect(patch.stages[0].groups[0].entrants).toContain('c1');
    expect(patch.stages[0].groups[0].entrants).not.toContain('c2');
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   StartSeasonForm — the competition picker once reuse mints one competition per
   season. Each option names its calendar, the current season is preselected (not the
   oldest), and ended seasons wait behind "Show past seasons".
   ───────────────────────────────────────────────────────────────────────────── */

describe('StartSeasonForm — picking among seasons of the same competition', () => {
  const yesterday = addDays(todayIso(), -1);
  const pastCalendar: SeasonCalendar = {
    id: 'cal-old',
    label: '2025/26',
    blocks: [{ id: 'o1', label: 'Block 1', start: addDays(yesterday, -120), end: yesterday }],
    breaks: [],
    excludeDates: [],
  };
  const laterCalendar: SeasonCalendar = {
    id: 'cal-later',
    label: '2027/28',
    blocks: [
      {
        id: 'l1',
        label: 'Block 1',
        start: addDays(todayIso(), 400),
        end: addDays(todayIso(), 500),
      },
    ],
    breaks: [],
    excludeDates: [],
  };
  const comp = (id: string, label: string, calendarId: string) => ({
    id,
    label,
    structureId: SPLIT_LEAGUE.id,
    calendarId,
  });

  const open = async (competitions: ReturnType<typeof comp>[]) => {
    const onCreateRun = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <GenerateFixturesLauncher
        clubs={clubs}
        allLeagues={[{ ...league(SPLIT_LEAGUE.id), competitions } as unknown as League]}
        config={
          {
            structures: [SPLIT_LEAGUE],
            calendars: [pastCalendar, calendar, laterCalendar],
          } as unknown as TenantConfig
        }
        existingRuns={[]}
        onCreateRun={onCreateRun}
        onClose={vi.fn()}
        toast={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    return { user, onCreateRun };
  };
  const picker = () => screen.getByRole('combobox', { name: 'Competition' });
  const optionTexts = () =>
    within(picker())
      .getAllByRole('option')
      .map((o) => o.textContent);

  it('labels each option with its calendar and preselects the newest current season', async () => {
    // Config order is creation order: the ended season comes first.
    await open([
      comp('c-old', '50 Over', 'cal-old'),
      comp('c-now', '50 Over', 'cal'),
      comp('c-next', '50 Over', 'cal-later'),
    ]);

    expect(optionTexts()).toEqual(['50 Over · 2027/28', '50 Over · 2026/27']);
    expect(picker()).toHaveValue('c-next');
  });

  it('keeps ended seasons behind “Show past seasons” until asked', async () => {
    const { user } = await open([
      comp('c-old', 'T20', 'cal-old'),
      comp('c-t20', 'T20', 'cal'),
      comp('c-50', '50 Over', 'cal'),
    ]);

    expect(optionTexts()).toEqual(['T20 · 2026/27', '50 Over · 2026/27']);
    expect(picker()).toHaveValue('c-t20');

    await user.click(screen.getByRole('button', { name: /show past seasons/i }));

    expect(optionTexts()).toEqual(['T20 · 2026/27', '50 Over · 2026/27', 'T20 · 2025/26']);
    expect(picker()).toHaveValue('c-t20');
  });

  it('skips the dropdown for one current season even with an ended one beside it', async () => {
    const { user, onCreateRun } = await open([
      comp('c-old', '50 Over', 'cal-old'),
      comp('c-now', '50 Over', 'cal'),
    ]);

    expect(screen.queryByRole('combobox', { name: 'Competition' })).toBeNull();
    expect(screen.getByText('50 Over · 2026/27')).toBeVisible();
    expect(screen.getByRole('button', { name: /show past seasons \(1\)/i })).toBeVisible();

    await user.click(screen.getByRole('button', { name: /^start season$/i }));
    expect(onCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({ competitionId: 'c-now', calendarSnapshot: calendar }),
    );
  });
});
