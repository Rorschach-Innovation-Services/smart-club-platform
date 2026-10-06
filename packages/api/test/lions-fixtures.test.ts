/**
 * Unit tests for the Lions (CGL) fixtures importer family: the flat league-sheet parser, the
 * T20 transcription asserts, lions venue-alias resolution, team/side resolution, the
 * grounds-sheet → registry builder, the clash-scan wiring and the prereqs bootstrap's pure
 * diff helpers. Pure — no dynalite, no repo.js: workbooks are built in memory with exceljs,
 * and the clash scan runs venue-clash.ts's real findClashes over in-memory series.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import type { Club, Series, Venue } from '../src/types.js';
import type { AffiliationRecord } from '../src/lions-affiliation-parse.js';

const {
  parseLeagueSheet,
  parseLeagueWorkbook,
  buildAllSeries,
  scanClashes,
  slotGroups,
  t20Inputs,
  parseArgs,
  KNOWN_SLUGS,
  storedDraftDrift,
} = await import('../src/import-lions-fixtures.js');
const {
  LEAGUE_SHEETS,
  T20_POOLS,
  HWB_POOLS,
  LADIES_POOLS,
  T20_SOURCES,
  LIONS_VENUES,
  LIONS_VENUE_ALIASES,
  buildVenueAliases,
  canonicalVenue,
  lionsGroundKey,
  isTbcVenue,
  isMacrocommRow,
  resolveTeam,
  t20SideFor,
  verifyT20Pools,
  parseGroundsSheet,
  buildLionsVenueRegistry,
} = await import('../src/lions-fixture-map.js');
const { leaguesToAdd, aliasMerge, registryDiff } =
  await import('../src/bootstrap-lions-fixture-prereqs.js');
const { DEFAULT_VENUE_ALIASES, groundKey } = await import('../src/venue-clash.js');

// ── builders ──
const dateCell = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));
const timeCell = (h: number, m: number): Date => new Date(Date.UTC(1899, 11, 30, h, m));
const HEADER = ['Date', 'Time', 'Home Team', 'Away Team', 'Venue'];

/** A Sunday 09:00 sheet spec with a small expected count (the real manifest asserts 132). */
const SPEC = {
  ...LEAGUE_SHEETS.find((s) => s.sheet === 'Premier A')!,
  expected: 2,
  macrocommRows: 0,
};

function sheetWith(rows: unknown[][], name = 'Premier A'): ExcelJS.Worksheet {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name);
  for (const r of rows) ws.addRow(r as ExcelJS.CellValue[]);
  return ws;
}

/** Title row, blank row, header, then data — the workbook's real layout. */
function leagueRows(data: unknown[][]): unknown[][] {
  return [['ENZA Premier League A'], [], HEADER, ...data];
}

describe('parseLeagueSheet — header detection + UTC reads', () => {
  test('finds the header below the title/blank rows and reads UTC date + time', () => {
    const ws = sheetWith(
      leagueRows([
        [dateCell(2026, 10, 11), timeCell(9, 0), 'Delfos', 'Wits University', 'Delfos Main'],
        [dateCell(2026, 10, 18), timeCell(9, 0), 'Jeppe', 'UJ', ' Jeppe Quondam '],
      ]),
    );
    const p = parseLeagueSheet(ws, SPEC);
    assert.deepEqual(p.errors, []);
    assert.equal(p.fixtures.length, 2);
    assert.deepEqual(
      p.fixtures.map((f) => [f.round, f.date, f.time, f.home, f.away, f.venue]),
      [
        [1, '2026-10-11', '09:00', 'Delfos', 'Wits University', 'Delfos Main'],
        [2, '2026-10-18', '09:00', 'Jeppe', 'UJ', 'Jeppe Quondam'],
      ],
    );
  });

  test('a SAST-shifted date (local-time read) fails closed on the weekday check', () => {
    // 2026-10-10T22:00Z is what a local SAST read of "11 Oct" looks like — a Saturday in UTC.
    const ws = sheetWith(
      leagueRows([
        [new Date(Date.UTC(2026, 9, 10, 22, 0)), timeCell(9, 0), 'Delfos', 'UJ', 'Delfos Main'],
        [dateCell(2026, 10, 18), timeCell(9, 0), 'Jeppe', 'UJ', 'Jeppe Quondam'],
      ]),
    );
    const p = parseLeagueSheet(ws, SPEC);
    assert.ok(
      p.errors.some((e) => /is not a Sunday/.test(e)),
      p.errors.join('\n'),
    );
  });

  test('a start time off the sheet-wide time fails closed', () => {
    const ws = sheetWith(
      leagueRows([
        [dateCell(2026, 10, 11), timeCell(13, 0), 'Delfos', 'UJ', 'Delfos Main'],
        [dateCell(2026, 10, 18), timeCell(9, 0), 'Jeppe', 'UJ', 'Jeppe Quondam'],
      ]),
    );
    assert.ok(parseLeagueSheet(ws, SPEC).errors.some((e) => /start time 13:00/.test(e)));
  });

  test('no header row is an error, not an empty sheet', () => {
    const ws = sheetWith([['Not done']]);
    const p = parseLeagueSheet(ws, SPEC);
    assert.equal(p.fixtures.length, 0);
    assert.ok(p.errors.some((e) => /no "Date \| Time/.test(e)));
  });

  test('a row with a blank venue aborts; a TBC venue parses as null', () => {
    const ws = sheetWith(
      leagueRows([
        [dateCell(2026, 10, 11), timeCell(9, 0), 'Delfos', 'UJ', 'TBC - no ground free '],
        [dateCell(2026, 10, 18), timeCell(9, 0), 'Jeppe', 'UJ', ''],
      ]),
    );
    const p = parseLeagueSheet(ws, SPEC);
    assert.equal(p.fixtures[0].venue, null);
    assert.ok(p.errors.some((e) => /blank Venue/.test(e)));
  });
});

describe('parseLeagueSheet — Macrocomm placeholders + count asserts', () => {
  const satSpec = {
    ...LEAGUE_SHEETS.find((s) => s.sheet === 'Saturday 1')!,
    expected: 1,
    macrocommRows: 1,
  };
  test('a "Macrocomm Round N" row (label in Home, Away/Venue empty) is skipped and counted', () => {
    const ws = sheetWith(
      leagueRows([
        [dateCell(2026, 10, 10), timeCell(13, 0), 'GM Old Edwardians', 'Delfos', 'Alan Lawson'],
        [dateCell(2026, 10, 17), timeCell(13, 0), 'Macrocomm Round 1', null, null],
      ]),
      'Saturday 1',
    );
    const p = parseLeagueSheet(ws, satSpec);
    assert.deepEqual(p.errors, []);
    assert.equal(p.fixtures.length, 1);
    assert.equal(p.macrocomm.length, 1);
    assert.equal(p.macrocomm[0].label, 'Macrocomm Round 1');
  });

  test('a Macrocomm-looking row WITH an away team is not skipped (and aborts later on name resolution)', () => {
    assert.equal(isMacrocommRow('Macrocomm Round 1', 'Delfos', ''), false);
    assert.equal(isMacrocommRow('Macrocomm Round 5', '', ''), false);
    assert.equal(isMacrocommRow(' macrocomm round 4 ', '', ''), true);
  });

  test('a fixture count off the verified count is an error', () => {
    const ws = sheetWith(
      leagueRows([
        [dateCell(2026, 10, 10), timeCell(13, 0), 'GM Old Edwardians', 'Delfos', 'Alan Lawson'],
        [dateCell(2026, 10, 17), timeCell(13, 0), 'Jeppe', 'Delfos', 'Jeppe Quondam'],
      ]),
      'Saturday 1',
    );
    const p = parseLeagueSheet(ws, satSpec);
    assert.ok(p.errors.some((e) => /2 fixtures parsed, expected 1/.test(e)));
    assert.ok(p.errors.some((e) => /0 Macrocomm placeholder row\(s\), expected 1/.test(e)));
  });

  test('parseLeagueWorkbook reports every missing manifest sheet', () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Premier A');
    const { errors } = parseLeagueWorkbook(wb);
    assert.ok(errors.some((e) => /sheet "Vets SA 1" not found/.test(e)));
    assert.equal(
      LEAGUE_SHEETS.reduce((n, s) => n + s.expected, 0),
      1513,
    );
  });
});

describe('team resolution', () => {
  test('a digit suffix is a second side of one club (planb tm_ convention)', () => {
    const one = resolveTeam('Delfos 1', 'vets-sa-1')!;
    const two = resolveTeam('Delfos 2', 'vets-sa-1')!;
    assert.equal(one.club.id, 'delfos-cricket-club');
    assert.equal(one.teamId, 'tm_delfos-cricket-club_vets-sa-1_0');
    assert.equal(two.teamId, 'tm_delfos-cricket-club_vets-sa-1_1');
    assert.equal(resolveTeam('Delfos', 'premier-a')!.teamId, 'delfos-cricket-club');
  });

  test('an unknown name resolves to null (fail closed)', () => {
    assert.equal(resolveTeam('Nowhere United', 'premier-a'), null);
  });

  test('HWB: a club in both Premier A and B pools fields two sides; a one-division club one', () => {
    const aa = HWB_POOLS.find((p) => p.slug === 'hwb-premier-t20-a-group-a')!;
    const ba = HWB_POOLS.find((p) => p.slug === 'hwb-premier-t20-b-group-a')!;
    assert.deepEqual(t20SideFor(aa, 'university-of-johannesburg-cricket-club'), {
      index: 0,
      label: '(Premier A)',
    });
    assert.equal(t20SideFor(ba, 'university-of-johannesburg-cricket-club')!.index, 1);
    assert.equal(t20SideFor(aa, 'the-wanderers-cricket-club'), undefined);
    assert.equal(t20SideFor(LADIES_POOLS[0], 'the-wanderers-cricket-club'), undefined);
  });

  test('buildAllSeries collects unresolved names instead of inventing a club', () => {
    const out = buildAllSeries(
      [
        {
          spec: SPEC,
          fixtures: [
            {
              row: 4,
              round: 1,
              date: '2026-10-11',
              time: '09:00',
              home: 'Delfos',
              away: 'Mystery XI',
              venue: 'Delfos Main',
              source: 'test',
            },
          ],
        },
      ],
      {
        clubs: [club('delfos-cricket-club', 'Delfos Cricket Club')],
        venues: [],
        leagueLabel: (k) => k,
      },
    );
    assert.deepEqual(out.unresolvedNames, ['premier-a: "Mystery XI"']);
  });
});

describe('T20 transcription — mechanical verification (amendment 7)', () => {
  test('the transcribed tables pass every assert', () => {
    assert.deepEqual(verifyT20Pools(), []);
  });

  test('per-PDF counts add up to the transcribed fixtures (60 HWB + 12 Ladies pool games)', () => {
    const total = Object.values(T20_SOURCES).reduce((n, s) => n + s.expected, 0);
    assert.equal(total, 72);
    assert.equal(
      T20_POOLS.reduce((n, p) => n + p.fixtures.length, 0),
      72,
    );
  });

  test('Ladies semis/final placeholders are not transcribed', () => {
    for (const p of LADIES_POOLS)
      for (const f of p.fixtures) assert.doesNotMatch(`${f.home} ${f.away}`, /winner|runner/i);
  });

  test('a duplicated pairing and a missing pairing are both caught', () => {
    const pool = structuredClone(LADIES_POOLS[0]);
    // Replace Jeppe v PAV Soweto with a second Joburg v Wanderers.
    pool.fixtures[5] = { ...pool.fixtures[5], home: 'Wanderers CC', away: 'Joburg CC' };
    const problems = verifyT20Pools([pool]);
    assert.ok(
      problems.some((p) => /meet 2 time/.test(p)),
      problems.join('\n'),
    );
    assert.ok(
      problems.some((p) => /meet 0 time/.test(p)),
      problems.join('\n'),
    );
  });

  test('a team twice in one date/time slot is caught', () => {
    const pool = structuredClone(LADIES_POOLS[1]);
    // Move a 13:30 game into the 09:00 slot where both of its teams already play.
    pool.fixtures[2] = { ...pool.fixtures[2], time: '09:00' };
    assert.ok(
      verifyT20Pools([pool]).some((p) => /plays twice in the 2026-10-03 09:00 slot/.test(p)),
    );
  });

  test('a team outside the pool roster is caught', () => {
    const pool = structuredClone(HWB_POOLS[0]);
    pool.fixtures[0] = { ...pool.fixtures[0], away: 'Pirates' };
    assert.ok(
      verifyT20Pools([pool]).some((p) => /pirates-cricket-club is not in the pool roster/.test(p)),
    );
  });

  test('the Premier A Group B 3 Oct TBC fixture is venue-less', () => {
    const inputs = t20Inputs();
    const tbc = inputs.flatMap((i) => i.fixtures.filter((f) => f.venue === null));
    assert.equal(tbc.length, 1);
    assert.equal(tbc[0].date, '2026-10-03');
  });
});

describe('lions venue aliases', () => {
  test('known spelling variants collapse onto one ground key', () => {
    const same = (a: string, b: string) =>
      assert.equal(lionsGroundKey(a), lionsGroundKey(b), `${a} vs ${b}`);
    same('Sir Lionell Phillips A', 'Sir Lionel Phillips A');
    same('Heidelburg ', 'Heidelberg');
    same('Old Park B', 'Old Parks B');
    same('lenasia', 'Lenasia Stadium');
    same('Lenasia stadium', 'Lenasia Stadium');
    same('Trezona', 'Trezona Park ');
    same('Marks Park ThistlesMain', 'Marks Park Main');
    same('UJ Orban', 'UJ Orban Oval');
    same('Wanderers Bottom', 'Wanderers Bottom Oval');
    same('lens tech 2 ', 'Lens Tech 2');
  });

  test('distinct ovals stay distinct', () => {
    assert.notEqual(lionsGroundKey('Marks Park 2'), lionsGroundKey('Marks Park Main'));
    assert.notEqual(lionsGroundKey('Lenasia South'), lionsGroundKey('Lenasia Stadium'));
    assert.notEqual(lionsGroundKey('Walter Milton A'), lionsGroundKey('Walter Milton B'));
  });

  test('canonicalVenue returns the canonical name, or null for an unknown string', () => {
    assert.equal(canonicalVenue('Sir Lionell Phillips A')?.name, 'Sir Lionel Phillips A');
    assert.equal(canonicalVenue('Somewhere Else Oval'), null);
  });

  test('TBC detection', () => {
    for (const t of ['TBC - no ground free ', 'TBC', '', 'n/a', null])
      assert.equal(isTbcVenue(t), true);
    assert.equal(isTbcVenue('Delfos Main'), false);
  });

  test('the map refuses an alias claimed by two grounds or hijacking a canonical name', () => {
    assert.throws(() =>
      buildVenueAliases([
        { name: 'Ground One', aliases: ['Shared'] },
        { name: 'Ground Two', aliases: ['Shared'] },
      ]),
    );
    assert.throws(() =>
      buildVenueAliases([{ name: 'Ground One' }, { name: 'Ground Two', aliases: ['Ground One'] }]),
    );
  });

  test('release-gate parity: the dolphins default aliases never redirect a lions spelling', () => {
    // The API gate resolves through { ...DEFAULT_VENUE_ALIASES, ...tenant aliases }.
    const merged = { ...DEFAULT_VENUE_ALIASES, ...LIONS_VENUE_ALIASES };
    for (const v of LIONS_VENUES)
      for (const s of [v.name, ...(v.aliases ?? [])])
        assert.equal(groundKey(s, merged), lionsGroundKey(s), s);
  });
});

describe('grounds sheets → venue registry', () => {
  function groundsWb(rows: unknown[][]): ExcelJS.Workbook {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    for (const r of rows) ws.addRow(r as ExcelJS.CellValue[]);
    return wb;
  }

  test('titled + untitled blocks parse; canonicalised grounds merge and union their clubs', () => {
    const wb = groundsWb([
      ['Enza Premier League A'],
      ['Club / Team', 'Home Ground'],
      ['Pirates', 'Sir Lionel Phillips A'],
      [],
      // Untitled block (the Sunday sheet's Presidents A lost its title row).
      ['Club / Team', 'Home Ground 1', 'Second Ground'],
      ['Pirates', 'Sir Lionell Phillips A', 'Jan Cilliers'],
      ['Heidelberg', 'Heidelburg '],
      ['Wits ', 'Walter Milton A'],
      ['Nobody FC', 'Somewhere'],
    ]);
    const entries = parseGroundsSheet(wb, 'Sunday');
    assert.deepEqual(
      [...new Set(entries.map((e) => e.block))],
      ['Enza Premier League A', '(untitled block)'],
    );
    assert.equal(entries.find((e) => e.rawClub === 'Wits')?.clubId, 'wits-university-cricket-club');
    const affiliation = [
      {
        club: { id: 'pirates-cricket-club' },
        facilities: { mainName: 'Sir Lionel Phillips - Pirates Sports Club', additional: [] },
      },
      {
        club: { id: 'heidelberg-cricket-club' },
        facilities: { mainName: 'Unie Grounds', additional: [] },
      },
    ] as unknown as AffiliationRecord[];
    const { venues, report } = buildLionsVenueRegistry(entries, affiliation);
    assert.deepEqual(
      report.unresolvedClubs.map((u) => u.rawClub),
      ['Nobody FC'],
    );
    const slp = venues.filter((v) => v.name === 'Sir Lionel Phillips A');
    assert.equal(slp.length, 1, 'one row for both spellings');
    assert.deepEqual(slp[0].homeClubIds, ['pirates-cricket-club']);
    assert.equal(slp[0].surfaces, 1);
    assert.equal(venues.find((v) => v.name === 'Heidelberg')?.id, 'v-heidelberg');
    assert.deepEqual(
      report.affiliationUnmatched.map((u) => u.line),
      ['Sir Lionel Phillips - Pirates Sports Club'],
    );
    assert.deepEqual(
      report.affiliationMatched.map((m) => m.venue),
      ['Heidelberg'],
    );
  });
});

// ── clash-scan wiring ──
function club(id: string, name: string): Club {
  return { id, name, ground: {} } as unknown as Club;
}
const CLUBS = [
  club('delfos-cricket-club', 'Delfos Cricket Club'),
  club('pirates-cricket-club', 'Pirates Cricket Club'),
  club('jeppe-cricket-club', 'Jeppe Cricket Club'),
  club('the-wanderers-cricket-club', 'The Wanderers Cricket Club'),
];
function oneFixtureInput(slug: string, home: string, away: string, venue: string | null) {
  return {
    spec: { ...SPEC, slug, leagueKey: slug, expected: 1 },
    fixtures: [
      { row: 4, round: 1, date: '2026-10-11', time: '09:00', home, away, venue, source: 'test' },
    ],
  };
}

describe('clash scan wiring (findClashes + lions aliases + registry capacity)', () => {
  const inputs = [
    oneFixtureInput('premier-a', 'Delfos', 'Pirates', 'Sir Lionel Phillips A'),
    oneFixtureInput('sunday-1', 'Jeppe', 'Wanderers', 'Sir Lionell Phillips A'),
  ];
  const registry = (surfaces: number): Venue[] => [
    {
      id: 'v-sir-lionel-phillips-a',
      name: 'Sir Lionel Phillips A',
      homeClubIds: ['pirates-cricket-club'],
      surfaces,
    },
  ];

  test('capacity 1: two same-time fixtures at one ground (two spellings) clash once', () => {
    const out = buildAllSeries(inputs, {
      clubs: CLUBS,
      venues: registry(1),
      leagueLabel: (k) => k,
    });
    assert.equal(out.locked, 2, 'both spellings lock to the registry row');
    const clashes = scanClashes(
      out.built.map((b) => b.series),
      [],
      CLUBS,
      registry(1),
    );
    assert.equal(clashes.length, 1);
    assert.equal(clashes[0].seriesId, 's-lions-sunday-1');
    assert.equal(clashes[0].with.seriesId, 's-lions-premier-a');
    const over = slotGroups(out.built, registry(1)).filter((g) => g.fixtures.length > g.capacity);
    assert.equal(over.length, 1);
  });

  test('capacity 2: the same pair is not a clash', () => {
    const out = buildAllSeries(inputs, {
      clubs: CLUBS,
      venues: registry(2),
      leagueLabel: (k) => k,
    });
    assert.equal(
      scanClashes(
        out.built.map((b) => b.series),
        [],
        CLUBS,
        registry(2),
      ).length,
      0,
    );
  });

  test('a registry miss is a venueOverride and still clashes at capacity 1', () => {
    const out = buildAllSeries(inputs, { clubs: CLUBS, venues: [], leagueLabel: (k) => k });
    const f = out.built[0].fixtures[0];
    assert.equal(f.venueOverride, 'Sir Lionel Phillips A');
    assert.equal(f.venueName, f.venueOverride);
    assert.equal(f.venueLocked, undefined);
    assert.equal(
      scanClashes(
        out.built.map((b) => b.series),
        [],
        CLUBS,
        [],
      ).length,
      1,
    );
  });

  test('TBC fixtures are excluded from the scan (and written venue-less)', () => {
    const tbcInputs = [
      oneFixtureInput('premier-a', 'Delfos', 'Pirates', null),
      oneFixtureInput('sunday-1', 'Jeppe', 'Wanderers', null),
    ];
    const out = buildAllSeries(tbcInputs, { clubs: CLUBS, venues: [], leagueLabel: (k) => k });
    assert.equal(out.tbc.length, 2);
    const f = out.built[0].fixtures[0];
    assert.equal(f.venueName, undefined);
    assert.equal(f.venueStatus, 'unresolved');
    assert.equal(
      scanClashes(
        out.built.map((b) => b.series as Series),
        [],
        CLUBS,
        [],
      ).length,
      0,
    );
  });

  test('venue status follows the registry homeClubIds: home / alternative / neutral', () => {
    const status = (home: string, away: string) =>
      buildAllSeries([oneFixtureInput('premier-a', home, away, 'Sir Lionel Phillips A')], {
        clubs: CLUBS,
        venues: registry(1),
        leagueLabel: (k) => k,
      }).built[0].fixtures[0].venueStatus;
    assert.equal(status('Pirates', 'Delfos'), 'home');
    assert.equal(status('Delfos', 'Pirates'), 'alternative');
    assert.equal(status('Jeppe', 'Delfos'), 'neutral');
  });
});

describe('CLI flags', () => {
  test('there is no --allow-clashes bypass', () => {
    assert.throws(() => parseArgs(['--allow-clashes']), /unknown flag --allow-clashes/);
  });
  test('--only accepts known slugs only', () => {
    assert.deepEqual(parseArgs(['--only', 'premier-a,ladies-premier-t20-group-a']).only, [
      'premier-a',
      'ladies-premier-t20-group-a',
    ]);
    assert.throws(() => parseArgs(['--only', 'premier-z']), /unknown series slug/);
  });
  test('19 known series slugs, all unique', () => {
    assert.equal(KNOWN_SLUGS.length, 19);
    assert.equal(new Set(KNOWN_SLUGS).size, 19);
  });
  test('--revert takes only --all/--confirm', () => {
    assert.equal(parseArgs(['--revert', '--all']).mode, 'revert');
    assert.throws(() => parseArgs(['--revert', '--parse-only']));
  });
  test('--include-released is a --revert-only flag', () => {
    assert.equal(parseArgs(['--revert']).includeReleased, false);
    assert.equal(parseArgs(['--revert', '--include-released', '--confirm']).includeReleased, true);
    assert.throws(() => parseArgs(['--include-released']), /--include-released is a --revert flag/);
    assert.throws(
      () => parseArgs(['--include-released', '--confirm']),
      /--include-released is a --revert flag/,
    );
  });
});

describe('storedDraftDrift — what a re-import would overwrite', () => {
  const fx = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    round: 1,
    date: '2026-10-10',
    time: '10:00',
    home: 'a',
    away: 'b',
    venueId: 'v1',
    venueName: 'Ground 1',
    ...over,
  });
  const series = (fixtures: unknown[], over: Record<string, unknown> = {}) =>
    ({
      id: 's-lions-premier-a',
      name: 'Premier A',
      teams: ['a', 'b'],
      fixtures,
      ...over,
    }) as unknown as Series;

  test('identical stored copy → no notes', () => {
    const built = series([fx('f1'), fx('f2')]);
    assert.deepEqual(storedDraftDrift(built, series([fx('f1'), fx('f2')])), []);
  });

  test('absent vs null optional fields are not drift', () => {
    const built = series([fx('f1', { venueOverride: null })]);
    assert.deepEqual(storedDraftDrift(built, series([fx('f1')])), []);
  });

  test('a console-edited fixture is listed with the changed fields', () => {
    const built = series([fx('f1'), fx('f2')]);
    const stored = series([fx('f1'), fx('f2', { date: '2026-10-17', venueId: 'v9' })]);
    assert.deepEqual(storedDraftDrift(built, stored), ['1 fixture(s) edited: f2 (date, venueId)']);
  });

  test('added and removed fixtures are counted', () => {
    const built = series([fx('f1'), fx('f2'), fx('f3')]);
    const stored = series([fx('f1'), fx('f4')]);
    assert.deepEqual(storedDraftDrift(built, stored), [
      '2 fixture(s) not in the stored copy',
      '1 stored fixture(s) the sheet no longer has',
    ]);
  });

  test('a renamed series and a changed team list are reported', () => {
    const built = series([fx('f1')]);
    const stored = series([fx('f1')], { name: 'Premier A (edited)', teams: ['a', 'c'] });
    assert.deepEqual(storedDraftDrift(built, stored), [
      'name "Premier A (edited)" → "Premier A"',
      'team list differs',
    ]);
  });

  test('more than five edited fixtures are truncated with an ellipsis', () => {
    const ids = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'];
    const built = series(ids.map((id) => fx(id)));
    const stored = series(ids.map((id) => fx(id, { time: '13:00' })));
    const [note] = storedDraftDrift(built, stored);
    assert.match(note, /^7 fixture\(s\) edited: f1 \(time\); .*f5 \(time\); …$/);
    assert.doesNotMatch(note, /f6/);
  });
});

describe('prereqs bootstrap — pure diffs', () => {
  test('leaguesToAdd is idempotent and files T20 cups as fixtures-only', () => {
    const first = leaguesToAdd({ leagues: [] });
    assert.equal(first.length, 15);
    assert.equal(first.find((l) => l.key === 'hwb-premier-t20')?.fixturesOnly, true);
    assert.equal(first.find((l) => l.key === 'premier-a')?.district, 'All districts');
    assert.deepEqual(leaguesToAdd({ leagues: first }), []);
  });

  test('aliasMerge adds missing keys and never overwrites a conflicting one', () => {
    const [k, v] = Object.entries(LIONS_VENUE_ALIASES)[0];
    const { add, conflicts } = aliasMerge({
      competitionDefaults: { venueAliases: { [k]: 'elsewhere' } },
    });
    assert.equal(add[k], undefined);
    assert.equal(conflicts.length, 1);
    assert.equal(Object.keys(add).length, Object.keys(LIONS_VENUE_ALIASES).length - 1);
    assert.equal(
      aliasMerge({ competitionDefaults: { venueAliases: { ...LIONS_VENUE_ALIASES } } }).conflicts
        .length,
      0,
    );
    void v;
  });

  test('registryDiff matches existing rows by lions ground key and only unions clubs', () => {
    const wanted: Venue[] = [
      {
        id: 'v-sir-lionel-phillips-a',
        name: 'Sir Lionel Phillips A',
        homeClubIds: ['pirates-cricket-club'],
        surfaces: 1,
      },
      {
        id: 'v-jan-cilliers',
        name: 'Jan Cilliers',
        homeClubIds: ['pirates-cricket-club'],
        surfaces: 1,
      },
    ];
    const existing: Venue[] = [
      { id: 'v-custom', name: 'Sir Lionell Phillips A', homeClubIds: [], lat: 1, lon: 2 },
    ];
    const d = registryDiff(wanted, existing);
    assert.deepEqual(
      d.create.map((v) => v.id),
      ['v-jan-cilliers'],
    );
    assert.equal(d.update.length, 1);
    assert.equal(d.update[0].venue.id, 'v-custom');
    assert.deepEqual(d.update[0].venue.homeClubIds, ['pirates-cricket-club']);
    assert.equal(d.update[0].venue.lat, 1);
    assert.deepEqual(
      registryDiff(wanted, [
        ...existing.map((e) => ({ ...e, homeClubIds: ['pirates-cricket-club'] })),
        wanted[1],
      ]).create,
      [],
    );
  });
});
