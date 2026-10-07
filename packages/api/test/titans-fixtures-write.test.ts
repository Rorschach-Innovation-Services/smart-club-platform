/**
 * Unit tests for the Titans fixtures write steps (A1–A4): the prereqs bootstrap's pure diffs,
 * the --append-sides side plan (roster matching, the guarded 1→2 tm_ seed, next-free
 * tm_ ids, women's sides never appended, counters), the live-side series build, the veterans
 * playoff series, stable fixture ids (held-back reservation, a knockout fixture after "Set
 * team") and the CLI's flag guards. Pure — no dynalite, no repo.js.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import type { Club, Series } from '../src/types.js';

const { planSides, sideSuffixFor, singleSideReferences } = await import('../src/titans-sides.js');
const { leaguePlan, aliasMerge, registryDiff } =
  await import('../src/bootstrap-titans-fixture-prereqs.js');
const {
  buildTitansSeries,
  buildVeteransKnockouts,
  clubsFromMap,
  planClubRestore,
  runScope,
  scanTitansClashes,
  sideNeeds,
  titansAliasState,
  usableGround,
  t20HostLeagues,
  parseArgs,
  stabiliseIds,
  wouldBeRegistry,
} = await import('../src/import-titans-fixtures.js');
const {
  T20_HOST_LEAGUES,
  TITANS_FIXTURE_SHEETS,
  TITANS_VENUE_ALIASES,
  parseTitansSheet,
  seriesNameFor,
} = await import('../src/titans-fixture-map.js');
const { CLUB_MAP } = await import('../src/titans-import-map.js');

const club = (id: string, extra: Partial<Club> = {}): Club =>
  ({
    id,
    name: CLUB_MAP.find((c) => c.id === id)!.name,
    version: 3,
    leagues: [],
    leagueTeams: {},
    teamRosters: {},
    ground: { venue: 'GROUND' },
    ...extra,
  }) as unknown as Club;

describe('side suffixes', () => {
  test('sheet labels and generated roster names reduce to the same side', () => {
    const tut = CLUB_MAP.find((c) => c.id === 'tut-cricket-club')!;
    assert.equal(sideSuffixFor('TUT A', tut), 'A');
    assert.equal(sideSuffixFor('TUT Cricket Club A', tut), 'A');
    assert.equal(sideSuffixFor('TUT', tut), '');
    const phsob = CLUB_MAP.find((c) => c.id === 'phsob-cricket-club')!;
    assert.equal(sideSuffixFor('PHSOB VETERANS 1', phsob), 'VETERANS 1');
    assert.equal(sideSuffixFor('Something Else', phsob), null);
  });
});

describe('planSides — resolution against live rosters', () => {
  test('a roster entry with the same side wins; a lone side in a no-roster league is the club id', () => {
    const tut = club('tut-cricket-club', {
      leagues: ['u13', 'second-league'],
      leagueTeams: { u13: 2, 'second-league': 1 },
      teamRosters: {
        u13: [
          { id: 'tm_tut-cricket-club_u13_0', name: 'TUT Cricket Club A' },
          { id: 'tm_tut-cricket-club_u13_1', name: 'TUT Cricket Club B' },
        ],
      },
    });
    const plan = planSides(
      [
        { leagueKey: 'u13', name: 'TUT B' },
        { leagueKey: 'second-league', name: 'TUT 2' },
      ],
      [tut],
      { allowAppend: false },
    );
    assert.deepEqual(plan.fatal, []);
    assert.equal(plan.resolve.get('u13::TUT B')!.teamId, 'tm_tut-cricket-club_u13_1');
    assert.equal(plan.resolve.get('second-league::TUT 2')!.teamId, 'tut-cricket-club');
    assert.equal(plan.patches.length, 0);
  });

  test('without --append-sides a missing side is listed, never invented', () => {
    const tuks = club('tuks-cricket-club', { leagues: ['premier-league'] });
    const plan = planSides(
      [
        { leagueKey: 'premier-league', name: 'TUKS 1' },
        { leagueKey: 'premier-league', name: 'TUKS 2' },
      ],
      [tuks],
      { allowAppend: false },
    );
    assert.equal(plan.needsAppend.length, 1);
    assert.equal(plan.resolve.size, 0);
  });

  test('growing 1 → 2 seeds roster[0] with a tm_ id (no references) and appends the next free one', () => {
    const tuks = club('tuks-cricket-club', {
      leagues: ['premier-league', 'u9'],
      leagueTeams: { 'premier-league': 1, u9: 2 },
      teamRosters: {
        // An id that would collide with the generated one must be skipped.
        u9: [
          { id: 'tm_tuks-cricket-club_premier-league_1', name: 'TUKS A' },
          { id: 'tm_tuks-cricket-club_u9_1', name: 'TUKS B' },
        ],
      },
      teams: 3,
      women: 0,
      juniors: 2,
    });
    const plan = planSides(
      [
        { leagueKey: 'premier-league', name: 'TUKS 2' },
        { leagueKey: 'premier-league', name: 'TUKS 1' },
      ],
      [tuks],
      { allowAppend: true },
    );
    assert.deepEqual(plan.fatal, []);
    assert.equal(
      plan.resolve.get('premier-league::TUKS 1')!.teamId,
      'tm_tuks-cricket-club_premier-league_0',
    );
    assert.equal(plan.resolve.get('premier-league::TUKS 1')!.how, 'seed');
    assert.ok(
      plan.patches[0].changes.some((c) =>
        c.includes('single side tuks-cricket-club → tm_tuks-cricket-club_premier-league_0'),
      ),
    );
    assert.equal(
      plan.resolve.get('premier-league::TUKS 2')!.teamId,
      'tm_tuks-cricket-club_premier-league_2',
    );
    const p = plan.patches[0];
    assert.deepEqual(p.teamRosters['premier-league'], [
      { id: 'tm_tuks-cricket-club_premier-league_0', name: 'TUKS 1' },
      { id: 'tm_tuks-cricket-club_premier-league_2', name: 'TUKS 2' },
    ]);
    assert.equal(p.leagueTeams['premier-league'], 2);
    // u9 roster untouched; counters recomputed (premier 2 + u9 2).
    assert.equal(p.teamRosters.u9, tuks.teamRosters!.u9);
    assert.deepEqual([p.teams, p.women, p.juniors], [4, 0, 2]);
    assert.equal(p.version, 3);
  });

  test('the reference guard refuses a 1 → 2 growth whose club id a stored series or coach uses', () => {
    const base = {
      leagues: ['third-league'],
      leagueTeams: { 'third-league': 1 },
    };
    const needs = [
      { leagueKey: 'third-league', name: 'TUKS 5' },
      { leagueKey: 'third-league', name: 'TUKS 6' },
    ];
    const series = [
      {
        id: 's-old-third',
        leagueKey: 'third-league',
        participants: [{ teamId: 'tuks-cricket-club', clubId: 'tuks-cricket-club', name: 'TUKS' }],
        fixtures: [{ id: 'f1', home: 'tuks-cricket-club', away: 'x' }],
      },
      // another league naming the club id is not a reference for third-league
      {
        id: 's-other',
        leagueKey: 'premier-league',
        participants: [{ teamId: 'tuks-cricket-club', clubId: 'tuks-cricket-club', name: 'TUKS' }],
        fixtures: [],
      },
    ] as unknown as Series[];
    const bySeries = planSides(needs, [club('tuks-cricket-club', base)], {
      allowAppend: true,
      storedSeries: series,
    });
    assert.equal(bySeries.patches.length, 0);
    assert.match(bySeries.fatal.join('\n'), /s-old-third \(1 fixture/);
    assert.ok(!bySeries.fatal.join('\n').includes('s-other'));

    const byCoach = planSides(
      needs,
      [
        club('tuks-cricket-club', {
          ...base,
          coaches: [{ name: 'Coach K', teams: ['third-league'], teamIds: ['tuks-cricket-club'] }],
        }),
      ],
      { allowAppend: true, storedSeries: [series[1]] },
    );
    assert.equal(byCoach.patches.length, 0);
    assert.match(byCoach.fatal.join('\n'), /coach "Coach K"/);

    // A coach covering the league by key only (no teamIds) is not a reference.
    const pass = planSides(
      needs,
      [club('tuks-cricket-club', { ...base, coaches: [{ name: 'C', teams: ['third-league'] }] })],
      { allowAppend: true, storedSeries: [series[1]] },
    );
    assert.deepEqual(pass.fatal, []);
    assert.equal(
      pass.resolve.get('third-league::TUKS 5')!.teamId,
      'tm_tuks-cricket-club_third-league_0',
    );
    assert.equal(
      pass.resolve.get('third-league::TUKS 6')!.teamId,
      'tm_tuks-cricket-club_third-league_1',
    );
  });

  test('an existing roster grows at the end; existing ids keep their places', () => {
    const lau = club('laudium-cricket-club', {
      leagues: ['veterans-league'],
      leagueTeams: { 'veterans-league': 2 },
      teamRosters: {
        'veterans-league': [
          { id: 'laudium-cricket-club', name: 'LAUDIUM 1' },
          { id: 'tm_laudium-cricket-club_veterans-league_1', name: 'LAUDIUM 2' },
        ],
      },
    });
    const plan = planSides(
      ['LAUDIUM 1', 'LAUDIUM 2', 'LAUDIUM 3', 'LAUDIUM 4'].map((name) => ({
        leagueKey: 'veterans-league',
        name,
      })),
      [lau],
      { allowAppend: true },
    );
    assert.deepEqual(plan.fatal, []);
    assert.deepEqual(
      plan.patches[0].teamRosters['veterans-league'].map((t) => t.id),
      [
        'laudium-cricket-club',
        'tm_laudium-cricket-club_veterans-league_1',
        'tm_laudium-cricket-club_veterans-league_2',
        'tm_laudium-cricket-club_veterans-league_3',
      ],
    );
  });

  test("women's sides are never appended — a missing one is a listed decision", () => {
    const irene = club('irene-villagers-cricket-club', {
      leagues: ['womens-premier-league', 'womens-promotion-league'],
      leagueTeams: { 'womens-premier-league': 1, 'womens-promotion-league': 1 },
    });
    const plan = planSides(
      [
        { leagueKey: 'womens-premier-league', name: 'IRENE VILLAGERS 1' },
        { leagueKey: 'womens-premier-league', name: 'IRENE VILLAGERS 2' },
      ],
      [irene],
      { allowAppend: true },
    );
    assert.equal(plan.patches.length, 0);
    assert.ok(
      plan.fatal.some((f) => /never auto-appended/.test(f)),
      plan.fatal.join('\n'),
    );
    assert.equal(plan.womens[0].verdict, 'DECISION');
    assert.match(plan.womens[0].promotion, /womens-promotion-league/);
  });

  test("a club with no women's premier side at all is a decision, not a bare club id", () => {
    const tut = club('tut-cricket-club', { leagues: ['womens-promotion-league'] });
    const plan = planSides([{ leagueKey: 'womens-premier-league', name: 'TUT 1' }], [tut], {
      allowAppend: true,
    });
    assert.equal(plan.resolve.size, 0);
    assert.equal(plan.fatal.length, 1);
  });

  test('a club the tenant lacks, and a count-2 league with no roster, are fatal', () => {
    const sin = club('sinoville-cricket-club', {
      leagues: ['u9'],
      leagueTeams: { u9: 2 },
    });
    const plan = planSides(
      [
        { leagueKey: 'u9', name: 'SINOVILLE A' },
        { leagueKey: 'second-league', name: 'POLICE 1' },
      ],
      [sin],
      { allowAppend: true },
    );
    assert.equal(plan.fatal.length, 2, plan.fatal.join('\n'));
  });

  test('a stored roster under a count of 1 is ignored, as the engine does', () => {
    const sin = club('sinoville-cricket-club', {
      leagues: ['veterans-league'],
      leagueTeams: { 'veterans-league': 1 },
      teamRosters: {
        'veterans-league': [
          { id: 'tm_sinoville-cricket-club_veterans-league_0', name: 'SINOVILLE 1' },
          { id: 'tm_sinoville-cricket-club_veterans-league_1', name: 'SINOVILLE 2' },
        ],
      },
    });
    const one = planSides([{ leagueKey: 'veterans-league', name: 'SINOVILLE 1' }], [sin], {
      allowAppend: true,
    });
    assert.equal(one.resolve.get('veterans-league::SINOVILLE 1')!.teamId, 'sinoville-cricket-club');
    assert.equal(one.warnings.length, 1);
    const two = planSides(
      [
        { leagueKey: 'veterans-league', name: 'SINOVILLE 1' },
        { leagueKey: 'veterans-league', name: 'SINOVILLE 2' },
      ],
      [sin],
      { allowAppend: true },
    );
    assert.equal(two.fatal.length, 1);
    assert.equal(two.patches.length, 0);
  });

  test('fixtures-only cup sides are left out of the counters', () => {
    const tuks = club('tuks-cricket-club', {
      leagues: ['premier-league'],
      leagueTeams: { 'premier-league': 1 },
      teams: 1,
    });
    const plan = planSides(
      [
        { leagueKey: 'mens-t20', name: 'TUKS 1' },
        { leagueKey: 'mens-t20', name: 'TUKS 2' },
      ],
      [tuks],
      { allowAppend: true, fixturesOnlyKeys: new Set(['mens-t20']) },
    );
    assert.equal(plan.patches[0].leagueTeams['mens-t20'], 2);
    assert.equal(plan.patches[0].teams, 1);
  });
});

describe("T20 sides reuse the clubs' existing league ids", () => {
  const hosts = (k: string, n: string) =>
    k === 'mens-t20'
      ? n.startsWith('TUKS')
        ? ['premier-league']
        : ['promotion-league']
      : (T20_HOST_LEAGUES[k] ?? null);
  const tuks = club('tuks-cricket-club', {
    leagues: ['premier-league'],
    leagueTeams: { 'premier-league': 2 },
    teamRosters: {
      'premier-league': [
        { id: 'tuks-cricket-club', name: 'TUKS 1' },
        { id: 'tm_tuks-cricket-club_premier-league_1', name: 'TUKS 2' },
      ],
    },
  });
  const brits = club('brits-cricket-club', { leagues: ['promotion-league'] });
  const irene = club('irene-villagers-cricket-club', {
    leagues: ['womens-premier-league'],
    leagueTeams: { 'womens-premier-league': 2 },
    teamRosters: {
      'womens-premier-league': [
        { id: 'irene-villagers-cricket-club', name: 'IRENE VILLAGERS 1' },
        {
          id: 'tm_irene-villagers-cricket-club_womens-premier-league_1',
          name: 'IRENE VILLAGERS 2',
        },
      ],
    },
  });
  const plan = planSides(
    [
      { leagueKey: 'mens-t20', name: 'TUKS 1' },
      { leagueKey: 'mens-t20', name: 'TUKS 2' },
      { leagueKey: 'mens-t20', name: 'BRITS 1' },
      { leagueKey: 'womens-t20', name: 'IRENE VILLAGERS 1' },
      { leagueKey: 'womens-t20', name: 'IRENE VILLAGERS 2' },
    ],
    [tuks, brits, irene],
    { allowAppend: true, hostLeagues: hosts },
  );

  test("men's T20 sides are the premier roster ids / a bare single side", () => {
    assert.deepEqual(plan.fatal, []);
    assert.equal(plan.resolve.get('mens-t20::TUKS 1')!.teamId, 'tuks-cricket-club');
    assert.equal(
      plan.resolve.get('mens-t20::TUKS 2')!.teamId,
      'tm_tuks-cricket-club_premier-league_1',
    );
    assert.equal(plan.resolve.get('mens-t20::BRITS 1')!.teamId, 'brits-cricket-club');
  });

  test("women's T20 sides are the women's premier roster ids", () => {
    assert.equal(
      plan.resolve.get('womens-t20::IRENE VILLAGERS 2')!.teamId,
      'tm_irene-villagers-cricket-club_womens-premier-league_1',
    );
  });

  test('no T20 roster, leagueTeams or counter change is planned', () => {
    assert.equal(plan.patches.length, 0);
  });

  test('a T20 side with no side in its host league is a decision', () => {
    const p = planSides([{ leagueKey: 'mens-t20', name: 'TUKS 3' }], [tuks], {
      allowAppend: true,
      hostLeagues: hosts,
    });
    assert.equal(p.fatal.length, 1);
    assert.equal(p.patches.length, 0);
  });
});

describe('t20HostLeagues', () => {
  test("a men's T20 name borrows from the senior league it plays in the workbook", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('P');
    ws.addRow(['DATE', 'HOME', 'AWAY', 'VENUE']);
    ws.addRow([new Date(Date.UTC(2026, 9, 24)), 'TUKS 2', 'MAMELODI 1', 'TUKS C']);
    const base = TITANS_FIXTURE_SHEETS.find((s) => s.sheet === 'PREMIER DIVISION A')!;
    const sheet = parseTitansSheet(ws, { ...base, series: [{ ...base.series[0], expected: 1 }] });
    const h = t20HostLeagues([sheet]);
    assert.deepEqual(h('mens-t20', 'TUKS 2'), ['premier-league']);
    assert.deepEqual(h('mens-t20', 'TUKS 9'), []);
    assert.deepEqual(h('womens-t20', 'TUKS 1'), [
      'womens-premier-league',
      'womens-promotion-league',
    ]);
    assert.equal(h('premier-league', 'TUKS 2'), null);
  });
});

describe('bootstrap diffs', () => {
  test('adds only the bootstrap-able leagues; any other missing key is fatal', () => {
    const r = leaguePlan({ leagues: [{ key: 'premier-league', label: 'P' }] as never });
    assert.deepEqual(
      r.add.map((l) => [l.key, l.fixturesOnly ?? false]),
      [
        ['mens-t20', true],
        ['womens-t20', true],
        ['womens-junior-league', false],
      ],
    );
    assert.ok(r.missing.includes('second-league'));
    assert.ok(!r.missing.includes('mens-t20'));
  });

  test('aliases merge missing keys only and report a conflicting one', () => {
    const [k, v] = Object.entries(TITANS_VENUE_ALIASES)[0];
    const r = aliasMerge({ competitionDefaults: { venueAliases: { [k]: `${v}x` } } } as never);
    assert.equal(r.conflicts.length, 1);
    assert.ok(!(k in r.add));
    assert.equal(Object.keys(r.add).length, Object.keys(TITANS_VENUE_ALIASES).length - 1);
  });

  test('existing registry rows are matched (aliases too) and reused untouched, never duplicated', () => {
    const existing = [
      // prod's own spelling of Centurion Kavaliers' ground, with a prod-style id
      {
        id: 'high-school-uitisg-a-b26276',
        name: 'HIGH SCHOOL UITISG A',
        homeClubIds: ['c1'],
        surfaces: 2,
      },
      { id: 'aloe-park-08c18e', name: 'Aloe Park', homeClubIds: ['police'], surfaces: 1 },
      {
        id: 'irene-oval-cricket-ground-de34e6',
        name: 'irene Oval Cricket Ground',
        homeClubIds: ['x'],
      },
    ];
    const r = registryDiff(
      [
        {
          id: 'v-high-school-uitsig-a',
          name: 'HIGH SCHOOL UITSIG A',
          homeClubIds: ['c1', 'c2'],
          surfaces: 1,
        },
        { id: 'v-aloe-park', name: 'ALOE PARK', homeClubIds: ['police'], surfaces: 1 },
        { id: 'v-irene-oval', name: 'IRENE OVAL', homeClubIds: [], surfaces: 1 },
      ],
      existing,
    );
    assert.deepEqual(r.problems, []);
    assert.deepEqual(
      r.matched.map((m) => [m.wanted.name, m.existing.id]),
      [
        ['HIGH SCHOOL UITSIG A', 'high-school-uitisg-a-b26276'],
        ['ALOE PARK', 'aloe-park-08c18e'],
      ],
    );
    // the derived home club difference is reported, the stored row is not rewritten
    assert.deepEqual(r.matched[0].homeMissing, ['c2']);
    assert.deepEqual(existing[0].homeClubIds, ['c1']);
    // "irene Oval Cricket Ground" is not merged into IRENE OVAL by guesswork
    assert.deepEqual(
      r.create.map((v) => v.name),
      ['IRENE OVAL'],
    );
    assert.deepEqual(
      r.unused.map((v) => v.id),
      ['irene-oval-cricket-ground-de34e6'],
    );
  });

  test('a new id colliding with an existing venue is a problem, not an overwrite', () => {
    const r = registryDiff(
      [{ id: 'v-new', name: 'NEW GROUND', homeClubIds: [], surfaces: 1 }],
      [{ id: 'v-new', name: 'Something Else' }],
    );
    assert.equal(r.problems.length, 1);
  });
});

// ── a veterans division with its two playoff rows ──
const dateCell = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));
const timeCell = (h: number, m: number): Date => new Date(Date.UTC(1899, 11, 30, h, m));
function vetsSheet() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('V');
  for (const r of [
    ['DATE', 'HOME', 'AWAY', 'VENUE', 'TIME'],
    [dateCell(2026, 9, 13), 'BRITS VETERANS 1', 'PRETORIA 1', 'BRITS OVAL', timeCell(8, 0)],
    [dateCell(2026, 9, 20), 'PRETORIA 1', 'BRITS VETERANS 1', 'PRETORIA A', timeCell(11, 0)],
    [dateCell(2026, 11, 15), '2ND PLACE', '3RD PLACE', '2ND PLACE HOME VENUE', timeCell(8, 0)],
    [
      dateCell(2026, 11, 22),
      '1ST PLACE',
      'SEMI-FINAL WINNER',
      '1ST PLACE HOME VENUE',
      timeCell(8, 0),
    ],
  ])
    ws.addRow(r as ExcelJS.CellValue[]);
  const base = TITANS_FIXTURE_SHEETS.find((s) => s.sheet === 'TITANS VETERANS LEAGUE A')!;
  return parseTitansSheet(ws, { ...base, series: [{ ...base.series[0], expected: 2 }] });
}

describe('live build + veterans playoff', () => {
  const sheet = vetsSheet();
  const clubs = clubsFromMap();
  const venues = wouldBeRegistry([sheet], clubs);
  const live = new Map([
    ['BRITS VETERANS 1', { teamId: 'brits-cricket-club', name: 'BRITS VETERANS 1' }],
    ['PRETORIA 1', { teamId: 'tm_pretoria-cricket-club_veterans-league_0', name: 'PRETORIA 1' }],
  ]);
  const outcome = buildTitansSeries([sheet], venues, [], {
    sideOf: (_k, n) => {
      const s = live.get(n);
      return (
        s && {
          ...s,
          clubId: s.teamId.includes('pretoria') ? 'pretoria-cricket-club' : 'brits-cricket-club',
          how: 'roster' as const,
        }
      );
    },
    labelOf: () => 'Vets',
  });

  test('participants and fixtures carry the live ids; the name uses the tenant label', () => {
    const s = outcome.built[0].series;
    assert.equal(s.name, 'Vets · Division A');
    assert.deepEqual(s.teams, ['brits-cricket-club', 'tm_pretoria-cricket-club_veterans-league_0']);
    assert.equal((s.fixtures as Array<{ home: string }>)[0].home, 'brits-cricket-club');
  });

  test('the playoff series uses pos:/win: sides, real dates, no ground', () => {
    const { series, errors } = buildVeteransKnockouts([sheet], outcome.built, () => 'Vets');
    assert.deepEqual(errors, []);
    const ko = series[0];
    assert.equal(ko.id, 's-titans-veterans-league-a-ko');
    assert.equal(ko.name, 'Vets · Division A · Playoff');
    assert.deepEqual(
      (ko.fixtures as Array<Record<string, unknown>>).map((f) => [
        f.id,
        f.date,
        f.time,
        f.home,
        f.away,
        f.stage,
        f.venueStatus,
      ]),
      [
        [
          'f1',
          '2026-11-15',
          '08:00',
          'pos:s-titans-veterans-league-a:2',
          'pos:s-titans-veterans-league-a:3',
          'Semi-final',
          'unresolved',
        ],
        [
          'f2',
          '2026-11-22',
          '08:00',
          'pos:s-titans-veterans-league-a:1',
          'win:f1',
          'Final',
          'unresolved',
        ],
      ],
    );
    assert.deepEqual(ko.teams, outcome.built[0].series.teams);
  });

  test('a single-division series is named by its league label alone', () => {
    assert.equal(seriesNameFor({ leagueKey: 'second-league', part: '' }), 'Second League');
    assert.equal(
      seriesNameFor({ leagueKey: 'premier-league', part: 'Division A' }),
      'Premier League · Division A',
    );
  });
});

describe('stable ids', () => {
  test('a first import keeps sheet order, held-back positions included', () => {
    const inc = [
      {
        id: 'f1',
        date: '2026-10-10',
        home: 'a',
        away: 'b',
        timeSource: 'sheet' as const,
        round: 1,
      },
      {
        id: 'f2',
        date: '2026-10-10',
        home: 'c',
        away: 'd',
        timeSource: 'sheet' as const,
        round: 1,
      },
    ];
    const r = stabiliseIds(inc, undefined);
    assert.deepEqual(
      inc.map((f) => f.id),
      ['f1', 'f2'],
    );
    assert.deepEqual(r.removed, []);
  });

  test('an inserted row keeps the stored ids and takes max + 1', () => {
    const stored = {
      id: 's',
      fixtures: [
        { id: 'f1', date: '2026-10-10', home: 'a', away: 'b' },
        { id: 'f2', date: '2026-10-17', home: 'c', away: 'd' },
      ],
    } as unknown as Series;
    const inc = [
      {
        id: 'f1',
        date: '2026-10-10',
        home: 'a',
        away: 'b',
        timeSource: 'sheet' as const,
        round: 1,
      },
      {
        id: 'f2',
        date: '2026-10-10',
        home: 'e',
        away: 'f',
        timeSource: 'sheet' as const,
        round: 1,
      },
      {
        id: 'f3',
        date: '2026-10-17',
        home: 'c',
        away: 'd',
        timeSource: 'sheet' as const,
        round: 2,
      },
    ];
    stabiliseIds(inc, stored);
    assert.deepEqual(
      inc.map((f) => f.id),
      ['f1', 'f3', 'f2'],
    );
  });

  test('a knockout fixture whose team was set in the console still matches its placeholder', () => {
    const stored = {
      id: 'ko',
      fixtures: [
        {
          id: 'f7',
          date: '2026-11-22',
          home: 'pretoria-cricket-club',
          away: 'win:f1',
          slots: { home: 'pos:s-x:1' },
        },
      ],
    } as unknown as Series;
    const inc = [
      {
        id: 'f2',
        date: '2026-11-22',
        home: 'pos:s-x:1',
        away: 'win:f1',
        timeSource: 'sheet' as const,
        round: 2,
      },
    ];
    const r = stabiliseIds(inc, stored);
    assert.equal(inc[0].id, 'f7');
    assert.deepEqual(r.removed, []);
  });
});

describe('CLI flag guards', () => {
  test('T20 knockouts cannot be imported in PR A; --parse-only takes no --confirm', () => {
    assert.throws(() => parseArgs(['--only', 's-titans-mens-t20-ko']), /PR B/);
    assert.throws(() => parseArgs(['--parse-only', '--confirm']));
    assert.equal(parseArgs(['--only', 's-titans-veterans-league-a-ko']).only.length, 1);
    assert.equal(parseArgs(['--append-sides']).mode, 'append-sides');
  });
});

describe('review fixes', () => {
  test('appending beside an unmatched roster entry is refused (a renamed side is not duplicated)', () => {
    const tuks = club('tuks-cricket-club', {
      leagues: ['u11'],
      leagueTeams: { u11: 2 },
      teamRosters: {
        u11: [
          { id: 'tm_tuks-cricket-club_u11_0', name: 'TUKS A' },
          { id: 'tm_tuks-cricket-club_u11_1', name: 'Tuks Seconds' },
        ],
      },
    });
    const plan = planSides(
      [
        { leagueKey: 'u11', name: 'TUKS A' },
        { leagueKey: 'u11', name: 'TUKS B' },
      ],
      [tuks],
      { allowAppend: true },
    );
    assert.equal(plan.patches.length, 0);
    assert.match(plan.fatal.join('\n'), /Tuks Seconds.*unmatched while appending TUKS B/);
  });

  test('a season run listing the club id as an entrant blocks a 1 → 2 growth', () => {
    const tuks = club('tuks-cricket-club', {
      leagues: ['third-league'],
      leagueTeams: { 'third-league': 1 },
    });
    const run = {
      id: 'run-1',
      leagueKey: 'third-league',
      stages: [
        {
          specId: 's',
          status: 'generated',
          groups: [{ id: 'g', label: 'G', entrants: ['tuks-cricket-club'] }],
        },
      ],
    } as never;
    assert.deepEqual(singleSideReferences(tuks, 'third-league', [], [run]), ['season run run-1']);
    const plan = planSides(
      [
        { leagueKey: 'third-league', name: 'TUKS 5' },
        { leagueKey: 'third-league', name: 'TUKS 6' },
      ],
      [tuks],
      { allowAppend: true, seasonRuns: [run] },
    );
    assert.equal(plan.patches.length, 0);
    assert.match(plan.fatal.join('\n'), /season run run-1/);
  });

  test('--only scopes the sides; a playoff id brings its division into scope', () => {
    assert.equal(runScope([]), null);
    const sc = runScope(['s-titans-veterans-league-a-ko'])!;
    assert.ok(sc.has('s-titans-veterans-league-a'));
    const sheet = vetsSheet();
    assert.equal(sideNeeds([sheet], new Set(['s-titans-u9-gold-a'])).length, 0);
    assert.equal(sideNeeds([sheet], sc).length, 2);
  });

  test('unresolved sides are recorded per series (so --only can scope them)', () => {
    const sheet = vetsSheet();
    const out = buildTitansSeries([sheet], wouldBeRegistry([sheet], clubsFromMap()), [], {
      sideOf: () => undefined,
    });
    assert.equal(out.unresolvedBySeries.get('s-titans-veterans-league-a')!.length, 2);
  });

  test("the strict scan drops a stored series' marked-TBC fixtures, keeps legacy venue-less ones", () => {
    const clubs = [
      { id: 'c1', name: 'C1', ground: { venue: 'ALOE PARK' } },
      { id: 'c2', name: 'C2', ground: { venue: 'ALOE PARK' } },
    ] as unknown as Club[];
    const venues = [{ id: 'v-aloe', name: 'ALOE PARK', surfaces: 1 }];
    const p = (id: string) => ({ teamId: id, clubId: id, name: id });
    const subject = {
      id: 's-new',
      name: 'New',
      participants: [p('c1'), p('x')],
      fixtures: [
        {
          id: 'f1',
          date: '2026-10-18',
          time: '14:00',
          home: 'c1',
          away: 'x',
          venueName: 'ALOE PARK',
          timeSource: 'sheet',
        },
      ],
    } as unknown as Series;
    const storedTbc = {
      id: 's-stored',
      name: 'Stored',
      participants: [p('c2'), p('y')],
      fixtures: [
        {
          id: 'f1',
          date: '2026-10-18',
          time: '14:00',
          home: 'c2',
          away: 'y',
          venueStatus: 'unresolved',
        },
      ],
    } as unknown as Series;
    assert.equal(
      scanTitansClashes([subject], clubs, venues, { existingOther: [storedTbc] }).length,
      0,
    );
    assert.equal(
      scanTitansClashes([subject], clubs, venues, { existingOther: [storedTbc], includeTbc: true })
        .length,
      1,
    );
    const legacy = {
      ...storedTbc,
      fixtures: [{ id: 'f1', date: '2026-10-18', time: '14:00', home: 'c2', away: 'y' }],
    } as unknown as Series;
    assert.equal(
      scanTitansClashes([subject], clubs, venues, { existingOther: [legacy] }).length,
      1,
    );
  });

  test('aliases: the gate map once all titans keys are stored equal; conflicts and gaps are reported', () => {
    const all = { competitionDefaults: { venueAliases: { ...TITANS_VENUE_ALIASES } } } as never;
    const ok = titansAliasState(all);
    assert.deepEqual([ok.missing, ok.conflicts], [[], []]);
    const [k] = Object.keys(TITANS_VENUE_ALIASES);
    const bad = titansAliasState({
      competitionDefaults: { venueAliases: { ...TITANS_VENUE_ALIASES, [k]: 'elsewhere' } },
    } as never);
    assert.equal(bad.conflicts.length, 1);
    assert.equal(
      titansAliasState({} as never).missing.length,
      Object.keys(TITANS_VENUE_ALIASES).length,
    );
  });

  test('junk club grounds never become registry rows', () => {
    for (const j of ['N/A', '-', 'None', 'TBC', '  ', '!!'])
      assert.equal(usableGround(j), false, `"${j}"`);
    assert.equal(usableGround('ALOE PARK'), true);
    const clubs = [
      { id: 'a', name: 'A', ground: { venue: '-' } },
      { id: 'b', name: 'B', ground: { venue: 'N/A' } },
    ] as unknown as Club[];
    assert.equal(wouldBeRegistry([], clubs).length, 0);
  });

  test('--restore-clubs plans only the structure fields that differ, and only ones the backup has', () => {
    const cur = club('tuks-cricket-club', {
      leagues: ['premier-league', 'mens-t20'],
      leagueTeams: { 'premier-league': 2 },
      teams: 2,
    });
    const plan = planClubRestore(
      [
        {
          id: 'tuks-cricket-club',
          leagues: ['premier-league'],
          leagueTeams: { 'premier-league': 2 },
        },
        { id: 'not-on-tenant', leagues: [] },
      ],
      [cur],
    );
    assert.equal(plan.length, 1);
    assert.deepEqual(plan[0].fields, ['leagues']);
    assert.deepEqual(plan[0].patch, { leagues: ['premier-league'] });
    assert.equal(plan[0].version, 3);
  });

  test('held-back ids come after the kept ones; a re-import with HELD_BACK keeps every stored id', () => {
    const sheet = vetsSheet();
    const venues = wouldBeRegistry([sheet], clubsFromMap());
    const held = [
      {
        sheet: 'TITANS VETERANS LEAGUE A',
        date: '2026-09-13',
        home: 'BRITS VETERANS 1',
        away: 'PRETORIA 1',
        venue: 'BRITS OVAL',
        reason: 't',
      },
    ];
    const first = buildTitansSeries([sheet], venues, held);
    const b = first.built[0];
    assert.deepEqual(
      b.fixtures.map((f) => f.id),
      ['f1'],
    );
    assert.equal(first.held[0].fixtureId, 'f2');
    // stored = what the first run wrote; the second run must keep f1 and report the held id after it
    const stored = new Map([
      [String(b.series.id), { ...b.series, fixtures: b.fixtures } as Series],
    ]);
    const again = buildTitansSeries([sheet], venues, held, { stored });
    assert.deepEqual(
      again.built[0].fixtures.map((f) => f.id),
      ['f1'],
    );
    assert.equal(again.held[0].fixtureId, 'f2');
    assert.equal(again.removedBySeries.size, 0);
  });
});
