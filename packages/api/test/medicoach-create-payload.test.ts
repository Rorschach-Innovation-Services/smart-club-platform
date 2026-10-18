/**
 * buildFixtureCreate (medicoach-sync/create-payload.ts): the wire `create` for ONE fixture,
 * placed exactly where the bundle export places it — a season run's stage/group/stream, a
 * Plan-B stream's group — or a refusal (→ awaiting carry) whenever that is not unambiguous.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFixtureCreate,
  type CreatePayloadDeps,
} from '../src/medicoach-sync/create-payload.js';
import type { SeasonRun, Series, TenantConfig } from '../src/types.js';

const T = 'dolphins';
const config = { tenant: T, features: { medicoachSync: true } } as unknown as TenantConfig;

const series = (over: Partial<Series>): Series =>
  ({
    id: 's1',
    name: 'Premier League · T20 · Group 2',
    leagueKey: 'premier',
    startDate: '2026-10-04',
    teams: ['a', 'b', 'c'],
    participants: ['a', 'b', 'c'].map((t) => ({ teamId: t, clubId: t, name: t })),
    fixtures: [],
    released: true,
    releasedAt: null,
    version: 1,
    ...over,
  }) as Series;

const run = (id: string, createdAt: string, seriesIds: string[][]): SeasonRun =>
  ({
    id,
    leagueKey: 'premier',
    createdAt,
    structureSnapshot: {
      id: 'st',
      name: 'Premier',
      stages: [
        { id: 'groups', name: 'Pool stage' },
        { id: 'ko', name: 'Knockout' },
      ],
    },
    stages: [
      {
        specId: 'groups',
        status: 'generated',
        groups: seriesIds[0].map((sid, i) => ({
          id: `g${i}`,
          label: `G${i}`,
          entrants: [],
          seriesId: sid,
        })),
      },
      {
        specId: 'ko',
        status: 'generated',
        groups: seriesIds[1].map((sid, i) => ({
          id: `k${i}`,
          label: 'KO',
          entrants: [],
          seriesId: sid,
        })),
      },
    ],
  }) as unknown as SeasonRun;

const deps = (all: Series[], runs: SeasonRun[] = []): CreatePayloadDeps => ({
  listSeries: async () => all,
  listSeasonRuns: async () => runs,
  getSeasonRun: async (_t, id) => runs.find((r) => r.id === id) ?? null,
});

const fixture = { id: 'f9', date: '2026-11-01', home: 'a', away: 'c', round: 3, venueLat: -29.8 };

describe('Plan-B series', () => {
  test('stream from the series name, group from its sorted place among its siblings', async () => {
    const s = series({});
    const sibling = series({ id: 's0', name: 'Premier League · T20 · Group 1' });
    const other = series({ id: 'sx', name: 'Premier League · One Day · Group 1' });
    const out = await buildFixtureCreate(T, s, fixture, config, deps([sibling, other, s]));
    assert.deepEqual(out, {
      competitionRef: 'smartclub:dolphins:competition:premier:t20',
      sport: 'cricket',
      homeTeamRef: 'smartclub:dolphins:team:premier:a',
      awayTeamRef: 'smartclub:dolphins:team:premier:c',
      stage: 'Group stage',
      groupName: 'Group 2',
      round: 3,
      venueLat: -29.8,
    });
  });

  test('a knockout side is a slot on its feeder ref', async () => {
    const out = await buildFixtureCreate(
      T,
      series({}),
      { ...fixture, home: 'win:f1', away: 'lose:f2' },
      config,
      deps([]),
    );
    assert.deepEqual('refusal' in out ? out : [out.homeSlot, out.awaySlot], [
      { kind: 'winner', ofFixtureRef: 'smartclub:dolphins:fixture:s1:f1' },
      { kind: 'loser', ofFixtureRef: 'smartclub:dolphins:fixture:s1:f2' },
    ]);
  });

  for (const [why, f, s] of [
    ['undated', { ...fixture, date: undefined }, series({})],
    ['a pos: side', { ...fixture, home: 'pos:G1#1' }, series({})],
    ['a side that is not a team of the series', { ...fixture, home: 'zz' }, series({})],
    ['no league', fixture, series({ leagueKey: undefined })],
  ] as const)
    test(`refuses: ${why}`, async () => {
      const out = await buildFixtureCreate(T, s as Series, f, config, deps([]));
      assert.ok('refusal' in out, JSON.stringify(out));
    });
});

describe('season-run series', () => {
  test("the run's stage + group; the newest run with series is stream main", async () => {
    const s = series({ id: 'r2-g1', seasonRunId: 'r2', leagueKey: undefined });
    const runs = [
      run('r1', '2025-09-01T00:00:00.000Z', [['r1-g0'], []]),
      run('r2', '2026-09-01T00:00:00.000Z', [['r2-g0', 'r2-g1'], ['r2-ko']]),
    ];
    const all = [series({ id: 'r1-g0', seasonRunId: 'r1' }), s];
    const out = await buildFixtureCreate(T, s, fixture, config, deps(all, runs));
    assert.ok(!('refusal' in out));
    assert.equal(out.competitionRef, 'smartclub:dolphins:competition:premier:main');
    assert.equal(out.stage, 'Pool stage');
    assert.equal(out.groupName, 'Group 2');

    const older = series({ id: 'r1-g0', seasonRunId: 'r1' });
    const o = await buildFixtureCreate(T, older, fixture, config, deps(all, runs));
    assert.ok(!('refusal' in o));
    assert.equal(o.competitionRef, 'smartclub:dolphins:competition:premier:main-r1');

    const ko = series({ id: 'r2-ko', seasonRunId: 'r2' });
    const k = await buildFixtureCreate(T, ko, fixture, config, deps([...all, ko], runs));
    assert.ok(!('refusal' in k));
    assert.equal(k.stage, 'Knockout');
    assert.equal(k.groupName, undefined, 'only the first stage is grouped');
  });

  test('refuses a series its run does not link, or a missing run', async () => {
    const runs = [run('r2', '2026-09-01T00:00:00.000Z', [['r2-g0'], []])];
    const orphan = series({ id: 'r2-zz', seasonRunId: 'r2' });
    assert.ok('refusal' in (await buildFixtureCreate(T, orphan, fixture, config, deps([], runs))));
    const lost = series({ id: 'x', seasonRunId: 'gone' });
    assert.ok('refusal' in (await buildFixtureCreate(T, lost, fixture, config, deps([], runs))));
  });
});
