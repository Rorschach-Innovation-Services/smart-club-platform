/**
 * Structure → medicoach format, for leagues that DO have a `setup`. Mapped by the stage
 * pipeline's shape, never by the structure's name. Fixtures are the real dolphins
 * structures (test/data/medicoach/dolphins-league-config-2026-09-27.json) plus synthetic
 * shapes the real config doesn't have (rank split, knockout only).
 *
 * Also: a setup league end to end (season-run series → one `main` competition, season
 * from the bound calendar, swap resolved from real group sizes).
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MedicoachBundleSchema } from '../src/medicoach-bundle.js';
import { buildBundle, mapStructureToFormat } from '../src/medicoach-export-build.js';
import type {
  CompetitionStructure,
  SeasonRun,
  Series,
  StageSpec,
  TenantConfig,
} from '../src/types.js';

const config = JSON.parse(
  readFileSync(
    new URL('./data/medicoach/dolphins-league-config-2026-09-27.json', import.meta.url),
    'utf8',
  ),
) as TenantConfig;
const structure = (id: string) => {
  const s = config.structures!.find((x) => x.id === id);
  assert.ok(s, `structure ${id} in fixture`);
  return s;
};
const weekly = { blockIndex: 0, cadence: { kind: 'weekly' as const } };

describe('mapStructureToFormat (real dolphins structures)', () => {
  test('flat round robin → league, rounds 1, no phases', () => {
    const m = mapStructureToFormat(structure('st-2026-27-flat-round-robin'));
    assert.deepEqual(m.format, { type: 'league', rounds: 1, extraPhases: [] });
    assert.deepEqual(m.swaps, []);
  });

  test('split league with mid-season swap → league rounds 2 + CARRY phase + last↔first swap', () => {
    const m = mapStructureToFormat(structure('st-2026-27-split-league-swap'));
    assert.deepEqual(m.format, {
      type: 'league',
      rounds: 2,
      extraPhases: [{ type: 'league', rounds: 1, groupSeeding: 'carry' }],
    });
    assert.deepEqual(m.swaps, [
      { groupA: 1, positionA: 'last', groupB: 2, positionB: 1, carryPoints: true },
    ]);
    assert.deepEqual(m.phaseOfStage, { 'double-round': 1, 'final-round': 2 });
  });

  test('seeded pools → cross-pool semis → final → groups_knockout, top 2 per group', () => {
    const m = mapStructureToFormat(structure('st-2026-27-pools-to-knockout'));
    assert.equal(m.format.type, 'groups_knockout');
    assert.equal(m.format.rounds, 1);
    assert.equal(m.format.advancePerGroup, 2);
    assert.deepEqual(m.format.extraPhases, []);
    assert.deepEqual(m.phaseOfStage, { pools: 1, finals: 1 });
  });

  test('a pools→knockout copy with no qualifiersPerGroup still maps, with a warning', () => {
    const m = mapStructureToFormat(structure('st_e7c5dfb9'));
    assert.equal(m.format.type, 'groups_knockout');
    assert.equal(m.format.advancePerGroup, 2);
    assert.ok(m.warnings.some((w) => /qualifiersPerGroup/.test(w)));
  });

  test('a third all-registered stage after a swap is an extra carry phase, flagged', () => {
    const m = mapStructureToFormat(structure('st_83bdf7e9'));
    assert.deepEqual(
      m.format.extraPhases.map((p) => p.groupSeeding),
      ['carry', 'carry'],
    );
    assert.ok(m.warnings.some((w) => /no swap\/split rule/.test(w)));
  });
});

describe('mapStructureToFormat (shapes by construction)', () => {
  const rr = (id: string, legs: 1 | 2 | 3, entrants: StageSpec['entrants']): StageSpec => ({
    id,
    name: id,
    format: { kind: 'round-robin', legs },
    entrants,
    schedule: weekly,
  });
  const st = (stages: StageSpec[]): CompetitionStructure => ({
    id: 'x',
    name: 'Named to mislead: Swap',
    version: 1,
    stages,
  });

  test('2 groups → 4 groups from standings is a SUBDIVIDE with subGroups 2 (not carry)', () => {
    const m = mapStructureToFormat(
      st([
        rr('p1', 1, { kind: 'manual', groups: { kind: 'even', count: 2 } }),
        rr('p2', 1, {
          kind: 'manual',
          groups: { kind: 'sizes', sizes: [5, 5, 5, 5] },
          derivedFrom: { rule: 'from-standings', fromStage: 'p1', detail: 'split by rank' },
        }),
      ]),
    );
    assert.deepEqual(m.format.extraPhases, [
      { type: 'league', rounds: 1, groupSeeding: 'subdivide', subGroups: 2 },
    ]);
    assert.deepEqual(m.swaps, []);
  });

  test('the structure name is ignored: same groups, no rule → carry', () => {
    const m = mapStructureToFormat(
      st([
        rr('p1', 2, { kind: 'manual', groups: { kind: 'even', count: 2 } }),
        rr('p2', 1, { kind: 'manual', groups: { kind: 'even', count: 2 } }),
      ]),
    );
    assert.equal(m.format.extraPhases[0].groupSeeding, 'carry');
    assert.deepEqual(m.swaps, []);
  });

  test('a knockout alone is a knockout; 3 legs clamp to rounds 2 with a warning', () => {
    const ko = mapStructureToFormat(
      st([
        {
          id: 'k',
          name: 'Cup',
          format: { kind: 'knockout', pairing: 'seeded', thirdPlace: true },
          entrants: { kind: 'manual' },
          schedule: weekly,
        },
      ]),
    );
    assert.deepEqual(ko.format, { type: 'knockout', rounds: 1, extraPhases: [], thirdPlace: true });
    const three = mapStructureToFormat(st([rr('a', 3, { kind: 'all-registered' })]));
    assert.equal(three.format.rounds, 2);
    assert.ok(three.warnings.length);
  });
});

describe('a setup league through buildBundle', () => {
  const split = structure('st-2026-27-split-league-swap');
  const cal = config.calendars!.find((c) => c.id === 'cal-2026-27')!;
  const teams = Array.from({ length: 12 }, (_, i) => `club${i + 1}`);
  const cfg = {
    ...config,
    leagues: [
      {
        key: 'div1',
        label: 'Division 1',
        group: 'Seniors',
        district: 'All districts',
        setup: { structureId: split.id, calendarId: cal.id },
      },
    ],
  } as TenantConfig;
  const participants = teams.map((t) => ({ teamId: t, clubId: t, name: t.toUpperCase() }));
  const groupSeries = (gi: number, ids: string[]): Series =>
    ({
      id: `s-run-1-double-round-g${gi}`,
      name: `Division 1 · Double round · Group ${gi}`,
      seasonRunId: 'run-1',
      stageSpecId: 'double-round',
      groupId: `g${gi}`,
      maxOvers: 50,
      teams: ids,
      participants: participants.filter((p) => ids.includes(p.teamId)),
      fixtures: [{ id: 'f1', round: 1, date: '2026-10-03', home: ids[0], away: ids[1] }],
      released: true,
      releasedAt: null,
      version: 1,
      startDate: '2026-10-03',
    }) as Series;
  const run = {
    id: 'run-1',
    leagueKey: 'div1',
    seasonLabel: '2026/27',
    structureSnapshot: split,
    calendarSnapshot: cal,
    version: 1,
    stages: [
      {
        specId: 'double-round',
        status: 'generated',
        groups: [
          {
            id: 'g1',
            label: 'Top group',
            entrants: teams.slice(0, 6),
            seriesId: 's-run-1-double-round-g1',
          },
          {
            id: 'g2',
            label: 'Bottom group',
            entrants: teams.slice(6),
            seriesId: 's-run-1-double-round-g2',
          },
        ],
      },
      { specId: 'final-round', status: 'awaiting-entrants', groups: [] },
    ],
  } as SeasonRun;

  const { bundle } = buildBundle({
    tenant: 'acme',
    config: cfg,
    clubs: [],
    playersByClub: new Map(),
    series: [groupSeries(1, teams.slice(0, 6)), groupSeries(2, teams.slice(6))],
    seasonRuns: [run],
    recipes: { tenant: 'acme', utcOffset: '+02:00', leagues: {} },
    options: { generatedAt: 'x' },
  });
  const league = bundle.leagues[0];
  const c = league.competitions[0];

  test('season-run series resolve their league through SeasonRun.leagueKey into one `main` competition', () => {
    assert.equal(league.key, 'div1');
    assert.equal(c.stream, 'main');
    assert.equal(c.formatSource, 'setup');
    assert.equal(c.fixtures.length, 2);
    assert.deepEqual(
      c.groups.map((g) => [g.name, g.sourceName, g.teamRefs.length]),
      [
        ['Group 1', 'Top group', 6],
        ['Group 2', 'Bottom group', 6],
      ],
    );
    assert.equal(c.cricketMatchFormat, 'ODI');
  });

  test('the swap position "last" resolves from the real group size', () => {
    assert.deepEqual(league.relegation.swaps, [
      {
        competitionRef: c.externalRef,
        groupA: 'Group 1',
        positionA: 6,
        groupB: 'Group 2',
        positionB: 1,
        carryPoints: true,
      },
    ]);
  });

  test('the season comes from the bound calendar', () => {
    assert.deepEqual(league.season, {
      externalRef: 'smartclub:acme:season:div1:cal-2026-27',
      name: cal.label,
      startDate: '2026-08-01',
      endDate: '2027-05-29',
      source: 'calendar',
    });
    assert.ok(MedicoachBundleSchema.safeParse(bundle).success);
  });
});
