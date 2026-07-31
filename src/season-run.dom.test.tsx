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
import { SeasonRunsPanel } from './season-run';
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
    schedule: { blockId: 'b1', cadence: { kind: 'weekly' } },
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
      schedule: { blockId: 'b2', cadence: { kind: 'weekly' } },
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
      schedule: { blockId: 'b2', cadence: { kind: 'weekly' } },
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
  const onCreateRun = vi.fn().mockResolvedValue(undefined);
  const onDeleteRun = vi.fn();
  const user = userEvent.setup();
  render(
    <SeasonRunsPanel
      clubs={clubs}
      allLeagues={[league(structure.id)]}
      allSeries={[]}
      runs={runs}
      config={{ structures: [structure], calendars: [calendar] } as unknown as TenantConfig}
      onCreateRun={onCreateRun}
      onPatchRun={onPatchRun}
      onGenerate={onGenerate}
      onDeleteRun={onDeleteRun}
      toast={vi.fn()}
    />,
  );
  return { user, onPatchRun, onGenerate, onCreateRun, onDeleteRun };
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
        config={{} as TenantConfig}
        configFailed
        onCreateRun={vi.fn()}
        onPatchRun={vi.fn()}
        onGenerate={vi.fn()}
        onDeleteRun={vi.fn()}
        toast={vi.fn()}
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
