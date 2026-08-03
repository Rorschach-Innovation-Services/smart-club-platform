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
import {
  buildFlatSeasonRun,
  FLAT_COMPETITION_ID,
  GenerateFixturesLauncher,
  SeasonRunsPanel,
} from './season-run';
import type {
  Club,
  CompetitionStructure,
  League,
  SeasonCalendar,
  SeasonRun,
  StageSpec,
  TenantConfig,
} from './types';

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

/** Twelve single-side clubs, enough for a 6/6 split. */
const clubs = Array.from({ length: 12 }, (_, i) => ({
  id: `c${i + 1}`,
  name: `Club ${i + 1}`,
  leagues: ['premier'],
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
  name: 'Seeded pools → cross-pool semis → final',
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

const setup = (structure: CompetitionStructure, runs: SeasonRun[]) => {
  const onPatchRun = vi.fn().mockResolvedValue(undefined);
  const onGenerate = vi.fn().mockResolvedValue(undefined);
  const onOpenLauncher = vi.fn();
  const onDeleteRun = vi.fn();
  const user = userEvent.setup();
  render(
    <SeasonRunsPanel
      clubs={clubs}
      allLeagues={[league(structure.id)]}
      allSeries={[]}
      runs={runs}
      onOpenLauncher={onOpenLauncher}
      onPatchRun={onPatchRun}
      onGenerate={onGenerate}
      onDeleteRun={onDeleteRun}
    />,
  );
  return { user, onPatchRun, onGenerate, onOpenLauncher, onDeleteRun };
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

    await openConfirm(user, /^Final round$/);

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

    await openConfirm(user, /^Final round$/);
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

    await openConfirm(user, /^Final round$/);
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
    await openConfirm(user, /^Final round$/);

    // Empty the Bottom Six entirely.
    for (const i of [6, 7, 8, 9, 10, 11]) await user.selectOptions(groupPickers()[i], '');

    expect(within(dialog()).getByText(/Bottom Six has no sides/i)).toBeVisible();
    expect(confirmBtn()).toBeDisabled();
    expect(onPatchRun).not.toHaveBeenCalled();
  });

  it('blocks a group of one, which would play nobody', async () => {
    const { user } = setup(SPLIT_LEAGUE, [readyRun()]);
    await openConfirm(user, /^Final round$/);

    for (const i of [7, 8, 9, 10, 11]) await user.selectOptions(groupPickers()[i], '');

    expect(
      within(dialog()).getByText(/Bottom Six has one side — it would play nobody/i),
    ).toBeVisible();
    expect(confirmBtn()).toBeDisabled();
  });

  it('flags a group that does not match the size the structure asks for', async () => {
    const { user } = setup(SPLIT_LEAGUE, [readyRun()]);
    await openConfirm(user, /^Final round$/);

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
    await openConfirm(user, /^Final round$/);

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
    await openConfirm(user, /^Pools$/);

    // The bracket pairs the winner of A against the runner-up of B, so registration
    // order is not a ranking of anything and must not decide the semi-finals.
    expect(within(dialog()).getByText(/order matters here/i)).toBeVisible();
    expect(within(dialog()).getByRole('columnheader', { name: /position/i })).toBeVisible();
  });

  it('refuses two sides in the same position', async () => {
    const { user } = setup(POOLS_THEN_CROSS, [pooledRun()]);
    await openConfirm(user, /^Pools$/);

    const positions = within(dialog()).getAllByRole('spinbutton');
    await user.clear(positions[1]);
    await user.type(positions[1], '1'); // now two sides claim 1st in Pool A

    expect(within(dialog()).getByText(/Pool A has two sides in the same position/i)).toBeVisible();
    expect(confirmBtn()).toBeDisabled();
  });

  it('stores each pool in the confirmed finishing order', async () => {
    const { user, onPatchRun } = setup(POOLS_THEN_CROSS, [pooledRun()]);
    await openConfirm(user, /^Pools$/);

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

describe('the audit trail — who decided the relegation', () => {
  it('records an accepted suggestion as accepted', async () => {
    const { user, onPatchRun } = setup(POOLS_THEN_CROSS, [run(POOLS_THEN_CROSS)]);
    await openConfirm(user, /^Pools$/);
    await user.click(confirmBtn());

    const entry = onPatchRun.mock.calls[0][1].stages[0].audit.at(-1);
    expect(entry.accepted).toBe(true);
    expect(entry.at).toEqual(expect.any(String));
  });

  it('records an overridden suggestion as overridden', async () => {
    const { user, onPatchRun } = setup(POOLS_THEN_CROSS, [run(POOLS_THEN_CROSS)]);
    await openConfirm(user, /^Pools$/);

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

    await openConfirm(user, /^Pools$/);
    await user.click(confirmBtn());

    const audit = onPatchRun.mock.calls[0][1].stages[0].audit;
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject(prior);
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
    await openConfirm(user, /^Final round$/);

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
    await openConfirm(user, /^Final round$/);
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
    await openConfirm(user, /^Pools$/);
    await user.click(confirmBtn());

    const stored = onPatchRun.mock.calls[0][1].stages[0].groups.map(
      (g: { label: string }) => g.label,
    );
    expect(stored).toEqual(['Group A', 'Group B']);
  });

  it('shows the admin the same names it is about to store', async () => {
    const { user } = setup(UNNAMED, [run(UNNAMED)]);
    await openConfirm(user, /^Pools$/);
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
    await openConfirm(user, /^Pools$/);

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
  // `renderSeriesForm` stands in for the real CreateSeriesForm here (that form's own
  // behaviour is covered by admin-create-series.dom.test.tsx) — this boundary only cares
  // that the launcher hands it the right args and mounts it in place. It is reached ONLY
  // via the ad-hoc option now — every real league routes to a season form instead.
  const stubRenderSeriesForm =
    (spy: ReturnType<typeof vi.fn>) =>
    ({ onBack }: { onBack: () => void }) => {
      spy({ onBack });
      return (
        <div>
          <span>stub series form</span>
          <button onClick={onBack}>Back to picker</button>
        </div>
      );
    };

  const launcherProps = (over: Partial<Parameters<typeof GenerateFixturesLauncher>[0]> = {}) => ({
    clubs,
    allLeagues: [league(SPLIT_LEAGUE.id)],
    config: { structures: [SPLIT_LEAGUE], calendars: [calendar] } as unknown as TenantConfig,
    existingRuns: [],
    onCreateRun: vi.fn().mockResolvedValue(undefined),
    onGenerateStage: vi.fn().mockResolvedValue(undefined),
    renderSeriesForm: stubRenderSeriesForm(vi.fn()),
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

    await user.click(screen.getByRole('button', { name: /^back$/i }));

    // Back at the league picker — Continue is there again, and the launcher itself
    // was never told to close.
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^start season$/i })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('routes a non-capable league to the flat-season dialog, and Back returns to the picker', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const spy = vi.fn();
    // No competitions bound to this league at all (unlike `league()` above, which always
    // sets one) — this is the every-tenant-admin-created-league case, always flat.
    const flatLeague = {
      key: 'friendlies',
      label: 'Friendlies',
      group: 'Senior',
      district: 'All districts',
    } as unknown as League;
    const config = { structures: [], calendars: [] } as unknown as TenantConfig;

    render(
      <GenerateFixturesLauncher
        {...launcherProps({
          allLeagues: [flatLeague],
          config,
          onClose,
          renderSeriesForm: stubRenderSeriesForm(spy),
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    // The flat-season dialog, not the ad-hoc series form — and it names the league.
    expect(screen.getByRole('dialog', { name: /start.*flat season/i })).toBeInTheDocument();
    expect(screen.getByText(/Friendlies has no competition bound to it/)).toBeInTheDocument();
    expect(screen.queryByText('stub series form')).toBeNull();
    expect(spy).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^back$/i }));

    // Back at the league picker, without the launcher having been told to close.
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /start.*flat season/i })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('falls back to the league picker if the flat step’s league vanishes mid-flow', async () => {
    const flatLeague = {
      key: 'friendlies',
      label: 'Friendlies',
      group: 'Senior',
      district: 'All districts',
    } as unknown as League;
    const onClose = vi.fn();
    const user = userEvent.setup();

    const { rerender } = render(
      <GenerateFixturesLauncher {...launcherProps({ allLeagues: [flatLeague], onClose })} />,
    );

    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    expect(screen.getByRole('dialog', { name: /start.*flat season/i })).toBeInTheDocument();

    // The league is gone from config — deleted in another tab, picked up by this
    // console's own refetch — while the admin is still sitting on the flat-season step.
    // `step` stays 'flat' in this component's own state; only `allLeagues` changed.
    rerender(<GenerateFixturesLauncher {...launcherProps({ allLeagues: [], onClose })} />);

    // Back at the picker — not a dead modal the admin can only abandon by refreshing.
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /start.*flat season/i })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('only reaches the embedded series form via the ad-hoc option', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();

    render(
      <GenerateFixturesLauncher
        {...launcherProps({ renderSeriesForm: stubRenderSeriesForm(spy) })}
      />,
    );

    await user.selectOptions(
      screen.getByRole('combobox'),
      screen.getByRole('option', { name: /one-off series/i }),
    );
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(screen.getByText('stub series form')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ onBack: expect.any(Function) }));

    await user.click(screen.getByRole('button', { name: /back to picker/i }));
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeInTheDocument();
    expect(screen.queryByText('stub series form')).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   SeasonRunsPanel — a flat run's persisted format survives a regenerate.

   A flat run has no config competition to read a Series Type/overs from (there is no
   `league.competitions` entry for the `__flat__` sentinel) — `flatFormat` on the run is
   the only place that choice lives, so the panel must synthesize the Competition it hands
   to `onGenerate` FROM `flatFormat`, not from a lookup that was always going to come back
   empty.
   ───────────────────────────────────────────────────────────────────────────── */

describe('SeasonRunsPanel — a flat run regenerating preserves its persisted format', () => {
  const flatLeague = {
    key: 'flatty',
    label: 'Flat League',
    group: 'Senior',
    district: 'All districts',
  } as unknown as League;

  // A separate roster registered for 'flatty' — the top-of-file `clubs` fixture is
  // registered for 'premier'.
  const flatClubs = clubs.map((c) => ({ ...c, leagues: ['flatty'] })) as Club[];

  it('carries flatFormat’s seriesType/overs into the regenerate payload, not a re-derived default', async () => {
    const teamIds = flatClubs.map((c) => c.id);
    const flatStage: StageSpec = {
      id: 'stage-1',
      name: '2026/27',
      format: { kind: 'round-robin', legs: 1 },
      entrants: { kind: 'all-registered' },
      schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
    } as unknown as StageSpec;
    const flatRun = {
      id: 'run-flat-1',
      leagueKey: 'flatty',
      competitionId: FLAT_COMPETITION_ID,
      seasonLabel: '2026/27',
      structureSnapshot: {
        id: 'st-flat-default',
        name: 'Flat season',
        version: 1,
        stages: [flatStage],
      },
      calendarSnapshot: calendar,
      stages: [
        {
          specId: 'stage-1',
          // 'ready' (not 'generated') with a `seriesId` already on its one group is what
          // makes the stage STALE — entrants re-confirmed after an earlier generate — so
          // the button reads "Regenerate", exactly the path the fix targets.
          status: 'ready',
          groups: [{ id: 'g1', label: 'Group A', entrants: teamIds, seriesId: 'existing-series' }],
        },
      ],
      version: 1,
      // NOT the defaults (Twenty20 / 20 overs) — chosen precisely so a coincidental
      // default couldn't make this assertion pass by accident.
      flatFormat: { seriesType: 'Multi-Day', overs: 35 },
    } as unknown as SeasonRun;

    const onGenerate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <SeasonRunsPanel
        clubs={flatClubs}
        allLeagues={[flatLeague]}
        allSeries={[]}
        runs={[flatRun]}
        onOpenLauncher={vi.fn()}
        onPatchRun={vi.fn().mockResolvedValue(undefined)}
        onGenerate={onGenerate}
        onDeleteRun={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /^regenerate \d+ fixtures$/i }));

    expect(onGenerate).toHaveBeenCalled();
    const [payloads] = onGenerate.mock.calls[0];
    expect(payloads[0].competition).toMatchObject({
      id: FLAT_COMPETITION_ID,
      label: 'Multi-Day',
      matchFormat: { overs: 35 },
    });
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   buildFlatSeasonRun — the pure synthesis a flat season starts from.
   ───────────────────────────────────────────────────────────────────────────── */

describe('buildFlatSeasonRun', () => {
  const flatLeague = {
    key: 'friendlies',
    label: 'Friendlies',
    group: 'Senior',
    district: 'All districts',
  } as unknown as League;

  it('synthesizes a single-block calendar from custom dates', () => {
    const run = buildFlatSeasonRun({
      id: 'run-x',
      league: flatLeague,
      seasonLabel: '2026/27',
      custom: { start: '2026-09-01', end: '2026-12-01' },
      seriesType: 'Twenty20 (16-25 overs)',
      overs: 20,
    });

    expect(run.calendarSnapshot.id).toBe('cal-flat-friendlies');
    expect(run.calendarSnapshot.label).toBe('2026/27');
    expect(run.calendarSnapshot.blocks).toEqual([
      { id: 'b1', label: 'Season', start: '2026-09-01', end: '2026-12-01' },
    ]);
  });

  it('passes an operator calendar through verbatim, with the given blockIndex', () => {
    const run = buildFlatSeasonRun({
      id: 'run-x',
      league: flatLeague,
      seasonLabel: '2026/27',
      calendar,
      blockIndex: 1,
      seriesType: 'Twenty20 (16-25 overs)',
      overs: 20,
    });

    expect(run.calendarSnapshot).toBe(calendar);
    expect(run.structureSnapshot.stages[0].schedule.blockIndex).toBe(1);
  });

  it('defaults blockIndex to 0 when not given', () => {
    const run = buildFlatSeasonRun({
      id: 'run-x',
      league: flatLeague,
      seasonLabel: '2026/27',
      calendar,
      seriesType: 'Twenty20 (16-25 overs)',
      overs: 20,
    });
    expect(run.structureSnapshot.stages[0].schedule.blockIndex).toBe(0);
  });

  it('places activateFrom on the stage schedule when given, and omits it otherwise', () => {
    const withDate = buildFlatSeasonRun({
      id: 'run-x',
      league: flatLeague,
      seasonLabel: '2026/27',
      calendar,
      activateFrom: '2026-08-01',
      seriesType: 'Twenty20 (16-25 overs)',
      overs: 20,
    });
    expect(withDate.structureSnapshot.stages[0].schedule.activateFrom).toBe('2026-08-01');

    const without = buildFlatSeasonRun({
      id: 'run-y',
      league: flatLeague,
      seasonLabel: '2026/27',
      calendar,
      seriesType: 'Twenty20 (16-25 overs)',
      overs: 20,
    });
    expect(without.structureSnapshot.stages[0].schedule.activateFrom).toBeUndefined();
  });

  it('stamps the flat sentinel competitionId, version 1 and one awaiting stage', () => {
    const run = buildFlatSeasonRun({
      id: 'run-x',
      league: flatLeague,
      seasonLabel: '2026/27',
      calendar,
      seriesType: 'Twenty20 (16-25 overs)',
      overs: 20,
    });

    expect(run.competitionId).toBe(FLAT_COMPETITION_ID);
    expect(run.version).toBe(1);
    expect(run.structureSnapshot.version).toBe(1);
    expect(run.stages).toEqual([{ specId: 'stage-1', status: 'awaiting-entrants', groups: [] }]);
    expect(run.structureSnapshot.stages).toHaveLength(1);
    expect(run.structureSnapshot.stages[0].entrants).toEqual({ kind: 'all-registered' });
    // The stage takes the SEASON's name, not the league's — parity with the old flat
    // naming ("Promotion League · 2026/27") via generateStageSeriesInner's template.
    expect(run.structureSnapshot.stages[0].name).toBe('2026/27');
  });

  it('persists the chosen series type and overs as flatFormat — the single source of truth a regenerate reads back', () => {
    const run = buildFlatSeasonRun({
      id: 'run-x',
      league: flatLeague,
      seasonLabel: '2026/27',
      calendar,
      seriesType: 'Multi-Day',
      overs: 35,
    });

    expect(run.flatFormat).toEqual({ seriesType: 'Multi-Day', overs: 35 });
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   StartFlatSeasonForm — reached through the launcher for any non-capable league.
   ───────────────────────────────────────────────────────────────────────────── */

describe('StartFlatSeasonForm', () => {
  const flatLeague = {
    key: 'friendlies',
    label: 'Friendlies',
    group: 'Senior',
    district: 'All districts',
  } as unknown as League;

  const config = {
    structures: [],
    calendars: [calendar],
  } as unknown as TenantConfig;

  // The top-of-file `clubs` fixture is registered for 'premier', not 'friendlies' — a
  // separate roster so `leagueParticipants` actually finds sides for this league.
  const friendliesClubs = clubs.map((c) => ({ ...c, leagues: ['friendlies'] })) as Club[];

  const setup = (over: Record<string, unknown> = {}) => {
    const onCreateRun = vi.fn().mockImplementation((run: SeasonRun) => Promise.resolve(run));
    const onGenerateStage = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const toast = vi.fn();
    const user = userEvent.setup();
    render(
      <GenerateFixturesLauncher
        clubs={friendliesClubs}
        allLeagues={[flatLeague]}
        config={config}
        existingRuns={[]}
        onCreateRun={onCreateRun}
        onGenerateStage={onGenerateStage}
        renderSeriesForm={() => <div>stub series form</div>}
        onClose={onClose}
        toast={toast}
        {...over}
      />,
    );
    return { user, onCreateRun, onGenerateStage, onClose, toast };
  };

  const openFlatDialog = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    return screen.getByRole('dialog', { name: /start.*flat season/i });
  };

  const fillCustomDates = async (
    user: ReturnType<typeof userEvent.setup>,
    dialog: HTMLElement,
    start: string,
    end: string,
  ) => {
    const startInput = within(dialog).getByLabelText(/start date/i);
    const endInput = within(dialog).getByLabelText(/end date/i);
    await user.clear(startInput);
    await user.type(startInput, start);
    await user.clear(endInput);
    await user.type(endInput, end);
  };

  /** Picks the one operator calendar on offer — the form defaults to "Custom dates". */
  const selectCalendar = async (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) =>
    user.selectOptions(within(dialog).getByLabelText(/dates/i), calendar.id);

  it('blocks a duplicate label for the same league', async () => {
    // The label field defaults to the real current season — match `existingRuns` to
    // whatever that resolves to right now, rather than assuming a fixed value.
    const existingRuns = [
      buildFlatSeasonRun({
        id: 'run-existing',
        league: flatLeague,
        seasonLabel: currentSeasonLabel(),
        calendar,
        seriesType: 'Twenty20 (16-25 overs)',
        overs: 20,
      }),
    ];
    const { user } = setup({ existingRuns });
    const dialog = await openFlatDialog(user);

    expect(within(dialog).getByDisplayValue(currentSeasonLabel())).toBeInTheDocument();
    expect(
      within(dialog).getByText(/flat season with that label is already running/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^start season$/i })).toBeDisabled();
  });

  it('blocks fewer than two registered sides', async () => {
    const { user } = setup({ clubs: [] });
    const dialog = await openFlatDialog(user);

    expect(within(dialog).getByText(/at least two sides must be registered/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^start season$/i })).toBeDisabled();
  });

  it('blocks custom dates where the end is before the start', async () => {
    const { user } = setup({
      config: { structures: [], calendars: [] } as unknown as TenantConfig,
    });
    const dialog = await openFlatDialog(user);

    await fillCustomDates(user, dialog, '2026-12-01', '2026-09-01');

    expect(within(dialog).getByRole('button', { name: /^start season$/i })).toBeDisabled();
  });

  it('creates the run then generates its fixtures, in order, with the synthetic competition', async () => {
    const { user, onCreateRun, onGenerateStage, onClose } = setup();
    const dialog = await openFlatDialog(user);
    await selectCalendar(user, dialog);

    await user.click(within(dialog).getByRole('button', { name: /^start season$/i }));

    expect(onCreateRun).toHaveBeenCalled();
    expect(onGenerateStage).toHaveBeenCalled();
    const createOrder = onCreateRun.mock.invocationCallOrder[0];
    const generateOrder = onGenerateStage.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(generateOrder);

    const [payloads] = onGenerateStage.mock.calls[0];
    expect(payloads[0].competition).toMatchObject({
      id: '__flat__',
      label: 'Twenty20 (16-25 overs)',
      matchFormat: { overs: 20 },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('carries the chosen series type and overs into the synthetic competition, independently', async () => {
    // Overs and Series Type are separate controls — nothing here should infer one from
    // the other, so picking a One-Day type with 50 overs must produce exactly that label
    // and overs count, not the Twenty20 default either field started at.
    const { user, onGenerateStage } = setup();
    const dialog = await openFlatDialog(user);
    await selectCalendar(user, dialog);

    await user.selectOptions(within(dialog).getByLabelText('Series Type'), 'One-Day (40-50 overs)');
    const oversInput = within(dialog).getByLabelText('Overs');
    await user.clear(oversInput);
    await user.type(oversInput, '50');

    await user.click(within(dialog).getByRole('button', { name: /^start season$/i }));

    const [payloads] = onGenerateStage.mock.calls[0];
    expect(payloads[0].competition).toMatchObject({
      label: 'One-Day (40-50 overs)',
      matchFormat: { overs: 50 },
    });
  });

  it('still closes and points at the Seasons panel when generation fails', async () => {
    const onGenerateStage = vi.fn().mockRejectedValue(new Error('nope'));
    const { user, onClose, toast } = setup({ onGenerateStage });
    const dialog = await openFlatDialog(user);
    await selectCalendar(user, dialog);

    await user.click(within(dialog).getByRole('button', { name: /^start season$/i }));

    expect(onClose).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/generate the fixtures from the seasons panel/i),
    );
  });

  it('guards against a double-submit — a rapid second click creates nothing extra', async () => {
    // Never resolves within this test — the button's own `busy` disable is what has to
    // stop the second click from reaching `onCreate` at all, not a fast round trip.
    const onCreateRun = vi.fn(() => new Promise<SeasonRun>(() => {}));
    const { user } = setup({ onCreateRun });
    const dialog = await openFlatDialog(user);
    await selectCalendar(user, dialog);

    const startBtn = within(dialog).getByRole('button', { name: /^start season$/i });
    // Not awaited individually — this is the rapid double-click the busy guard exists
    // for. A guard that only worked when the two clicks were serialised wouldn't be
    // proving anything a disabled-button check couldn't.
    await Promise.all([user.click(startBtn), user.click(startBtn)]);

    expect(onCreateRun).toHaveBeenCalledTimes(1);
  });

  it('keeps the modal open with an inline error when create fails outright', async () => {
    const onCreateRun = vi.fn().mockRejectedValue(new Error('boom'));
    const onGenerateStage = vi.fn();
    const { user } = setup({ onCreateRun, onGenerateStage });
    const dialog = await openFlatDialog(user);
    await selectCalendar(user, dialog);

    await user.click(within(dialog).getByRole('button', { name: /^start season$/i }));

    expect(
      await within(dialog).findByText(/could not start the season — try again/i),
    ).toBeInTheDocument();
    expect(onGenerateStage).not.toHaveBeenCalled();
    // Still open — a failed create must not discard the admin's half-filled form.
    expect(screen.getByRole('dialog', { name: /start.*flat season/i })).toBeInTheDocument();
  });

  it('shows no inline error when the rejection was already toasted', async () => {
    // withToast (main.tsx) flags a rethrown error `alreadyToasted` once it has surfaced
    // its own toast — an inline message on top of that would tell the admin the same
    // thing twice.
    const toasted = Object.assign(new Error('surfaced elsewhere'), { alreadyToasted: true });
    const onCreateRun = vi.fn().mockRejectedValue(toasted);
    const onGenerateStage = vi.fn();
    const { user } = setup({ onCreateRun, onGenerateStage });
    const dialog = await openFlatDialog(user);
    await selectCalendar(user, dialog);

    await user.click(within(dialog).getByRole('button', { name: /^start season$/i }));

    // Wait for the busy state to settle back (the button reads "Start season" again)
    // before asserting the error never appeared.
    await within(dialog).findByRole('button', { name: /^start season$/i });
    expect(within(dialog).queryByText(/could not start the season/i)).toBeNull();
    expect(onGenerateStage).not.toHaveBeenCalled();
  });
});
