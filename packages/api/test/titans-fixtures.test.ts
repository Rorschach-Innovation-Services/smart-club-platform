/**
 * Unit tests for the Titans fixtures importer (step A0, --parse-only): the time reader, the
 * flat and T20 sheet parsers (carry-down, BYE skip, banners, knockout slot proposals), team
 * name fixes, the misspellings-only venue aliases, HELD_BACK and the clash-scan wiring. Pure —
 * no dynalite, no repo.js: sheets are built in memory with exceljs and the scan runs
 * venue-clash.ts's real findClashes. The last block reads the real union workbook when it is
 * present on this machine and skips otherwise.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import ExcelJS from 'exceljs';

const {
  TITANS_FIXTURE_SHEETS,
  EXPECTED_TOTAL_FIXTURES,
  HELD_BACK,
  TITANS_VENUE_SPELLINGS,
  buildTitansVenueAliases,
  canonicalTeamName,
  canonicalVenueName,
  inferUnnumberedSides,
  parseTitansSheet,
  parseTitansTime,
  parseTitansWorkbook,
  proposeSlotRef,
  resolveTeamClub,
  seasonDate,
  titansGroundKey,
} = await import('../src/titans-fixture-map.js');
const { buildTitansSeries, clubsFromMap, scanTitansClashes, wouldBeRegistry, sharedGroundDays } =
  await import('../src/import-titans-fixtures.js');

// ── builders ──
const dateCell = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));
const timeCell = (h: number, m: number): Date => new Date(Date.UTC(1899, 11, 30, h, m));
const HEADER = ['DATE', 'HOME', 'AWAY', 'VENUE'];

function sheetWith(rows: unknown[][], name = 'TEST'): ExcelJS.Worksheet {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name);
  for (const r of rows) ws.addRow(r as ExcelJS.CellValue[]);
  return ws;
}

type SheetSpec = (typeof TITANS_FIXTURE_SHEETS)[number];
function specFor(sheet: string, expected: number[], extra: Partial<SheetSpec> = {}): SheetSpec {
  const base = TITANS_FIXTURE_SHEETS.find((s) => s.sheet === sheet)!;
  return {
    ...base,
    series: base.series.map((s, i) => ({ ...s, expected: expected[i] ?? 0 })),
    ...extra,
  };
}

const title = (t: string) => [`TITANS CRICKET UNION ${t}`, `TITANS CRICKET UNION ${t}`];

describe('parseTitansTime — every form the workbook uses', () => {
  test('24-hour, 12-hour and "H" text forms read as sheet times', () => {
    assert.deepEqual(parseTitansTime('8:00'), { time: '08:00', source: 'sheet' });
    assert.deepEqual(parseTitansTime('14:30'), { time: '14:30', source: 'sheet' });
    assert.deepEqual(parseTitansTime('9:00 AM'), { time: '09:00', source: 'sheet' });
    assert.deepEqual(parseTitansTime('2:00 PM'), { time: '14:00', source: 'sheet' });
    assert.deepEqual(parseTitansTime('12:00 PM'), { time: '12:00', source: 'sheet' });
    assert.deepEqual(parseTitansTime('13H00'), { time: '13:00', source: 'sheet' });
    assert.deepEqual(parseTitansTime(' 12h00 '), { time: '12:00', source: 'sheet' });
  });

  test('a 1899-epoch time cell and a fraction-of-day number read as sheet times', () => {
    assert.deepEqual(parseTitansTime(timeCell(14, 30)), { time: '14:30', source: 'sheet' });
    assert.deepEqual(parseTitansTime(0.375), { time: '09:00', source: 'sheet' });
    assert.deepEqual(parseTitansTime({ formula: 'X', result: timeCell(8, 0) }), {
      time: '08:00',
      source: 'sheet',
    });
  });

  test('the bare T20 markers map to 09:00 / 13:30 with source t20-marker', () => {
    assert.deepEqual(parseTitansTime('AM'), { time: '09:00', source: 't20-marker' });
    assert.deepEqual(parseTitansTime('pm'), { time: '13:30', source: 't20-marker' });
  });

  test('dates, team names, blanks and impossible times are not times', () => {
    assert.equal(parseTitansTime(dateCell(2026, 10, 10)), null);
    assert.equal(parseTitansTime('TUKS 1'), null);
    assert.equal(parseTitansTime(''), null);
    assert.equal(parseTitansTime(null), null);
    assert.equal(parseTitansTime('25:00'), null);
  });
});

describe('flat sheets — carry-down, BYE, times, counts', () => {
  test('a dateless row carries the date above; BYE rows are skipped and counted', () => {
    const ws = sheetWith([
      title('FIFTH LEAGUE'),
      HEADER,
      [dateCell(2026, 10, 10), 'PRETORIA 6', 'SOSHANGUVE 3', 'PRETORIA B'],
      [null, 'MAMELODI 3', 'ATTERIDGEVILLE 3', 'MAMELODI OVAL'],
      [dateCell(2026, 10, 10), 'EERSTERUST 3', 'BYE', 'BYE'],
      [],
      [dateCell(2026, 10, 17), 'PRETORIA 6', 'EERSTERUST 3', 'PRETORIA B'],
    ]);
    const p = parseTitansSheet(ws, specFor('FIFTH', [3]));
    assert.deepEqual(p.errors, []);
    assert.deepEqual(
      p.fixtures.map((f) => [f.date, f.home, f.away]),
      [
        ['2026-10-10', 'PRETORIA 6', 'SOSHANGUVE 3'],
        ['2026-10-10', 'MAMELODI 3', 'ATTERIDGEVILLE 3'],
        ['2026-10-17', 'PRETORIA 6', 'EERSTERUST 3'],
      ],
    );
    assert.deepEqual(p.byes, [{ row: 5, date: '2026-10-10', team: 'EERSTERUST 3' }]);
  });

  test('a fixture with no date and none to carry is an error', () => {
    const ws = sheetWith([HEADER, [null, 'TUKS 1', 'TUT 1', 'TUKS OVAL']]);
    const p = parseTitansSheet(ws, specFor('SECOND', [1]));
    assert.ok(
      p.errors.some((e) => /no date/.test(e)),
      p.errors.join('\n'),
    );
  });

  test('untimed rows get the provisional default: 08:30 junior, 13:00 senior', () => {
    const junior = parseTitansSheet(
      sheetWith([HEADER, [dateCell(2026, 10, 10), 'TUKS A', 'TUT A', 'TUKS B']]),
      specFor('U13 SILVER', [1]),
    );
    const senior = parseTitansSheet(
      sheetWith([HEADER, [dateCell(2026, 10, 10), 'TUKS 1', 'TUT 1', 'TUKS OVAL']]),
      specFor('SECOND', [1]),
    );
    assert.deepEqual(
      [junior.fixtures[0].time, junior.fixtures[0].timeSource],
      ['08:30', 'provisional'],
    );
    assert.deepEqual(
      [senior.fixtures[0].time, senior.fixtures[0].timeSource],
      ['13:00', 'provisional'],
    );
  });

  test('a TIME column wins over the default ("13H00" text and a time cell alike)', () => {
    const ws = sheetWith([
      [...HEADER, 'TIME'],
      [dateCell(2026, 10, 10), 'TUKS A', 'TUT A', 'TUKS B', '13H00'],
      [dateCell(2026, 10, 10), 'PHSOB A', 'CBCOB A', 'BRUINSLICH PARK', timeCell(9, 0)],
      [dateCell(2026, 10, 10), 'LAUDIUM A', 'BRITS A', 'LAUDIUM B'],
    ]);
    const p = parseTitansSheet(ws, specFor('U13 SILVER', [3]));
    assert.deepEqual(
      p.fixtures.map((f) => [f.time, f.timeSource]),
      [
        ['13:00', 'sheet'],
        ['09:00', 'sheet'],
        ['08:30', 'provisional'],
      ],
    );
  });

  test('a count off the manifest is fatal', () => {
    const ws = sheetWith([HEADER, [dateCell(2026, 10, 10), 'TUKS 1', 'TUT 1', 'TUKS OVAL']]);
    const p = parseTitansSheet(ws, specFor('SECOND', [2]));
    assert.ok(
      p.errors.some((e) => /1 fixtures parsed, expected 2/.test(e)),
      p.errors.join('\n'),
    );
  });

  test('banner rows are skipped; Top 6 / Bottom 6 rows are split rounds, not fixtures', () => {
    const ws = sheetWith([
      [...HEADER, 'TIME'],
      ['T20s', 'T20s', 'T20s', 'T20s'],
      [
        dateCell(2026, 9, 5),
        'DIFFERENTLY ABLED 4',
        'DIFFERENTLY ABLED 7',
        'TRANSNET OVAL',
        timeCell(9, 0),
      ],
      [dateCell(2027, 2, 21), 'TOP 6 /BOTTOM 6', 'TOP 6 /BOTTOM 6', 'TOP 6 /BOTTOM 6'],
      [null, 'TOP 6 /BOTTOM 6', 'TOP 6 /BOTTOM 6', 'TOP 6 /BOTTOM 6'],
    ]);
    const p = parseTitansSheet(ws, specFor('SIXTH (BLIND)', [1]));
    assert.deepEqual(p.errors, []);
    assert.deepEqual(
      p.banners.map((b) => b.text),
      ['T20s'],
    );
    assert.deepEqual(
      p.splitRounds.map((s) => s.date),
      ['2027-02-21', '2027-02-21'],
    );
  });

  test('a Jan–May date keyed as 2026 is corrected to 2027 and reported; a wild date is fatal', () => {
    assert.deepEqual(seasonDate(dateCell(2026, 1, 17)), {
      date: '2027-01-17',
      corrected: '2026-01-17',
    });
    assert.deepEqual(seasonDate(dateCell(2026, 10, 10)), { date: '2026-10-10' });
    assert.ok('error' in (seasonDate(dateCell(2025, 10, 10)) as object));
  });
});

describe('date and time sanity', () => {
  test('a year fix that would run backwards from the running date is fatal', () => {
    const ws = sheetWith([
      HEADER,
      [dateCell(2027, 3, 6), 'TUKS 1', 'TUT 1', 'TUKS OVAL'],
      [dateCell(2026, 1, 17), 'TUKS 2', 'TUT 2', 'TUKS B'],
    ]);
    const p = parseTitansSheet(ws, specFor('SECOND', [2]));
    assert.ok(
      p.errors.some((e) => /before the running date 2027-03-06/.test(e)),
      p.errors.join('\n'),
    );
  });

  test('a forward year fix is accepted and reported', () => {
    const ws = sheetWith([
      HEADER,
      [dateCell(2027, 1, 16), 'TUKS 1', 'TUT 1', 'TUKS OVAL'],
      [dateCell(2026, 1, 17), 'TUKS 2', 'TUT 2', 'TUKS B'],
    ]);
    const p = parseTitansSheet(ws, specFor('SECOND', [2]));
    assert.deepEqual(p.errors, []);
    assert.equal(p.fixtures[1].date, '2027-01-17');
    assert.equal(p.dateCorrections.length, 1);
  });

  test('a sheet time outside 07:00–18:30 is fatal ("1:00" with no AM/PM)', () => {
    const ws = sheetWith([
      [...HEADER, 'TIME'],
      [dateCell(2026, 10, 10), 'TUKS A', 'TUT A', 'TUKS B', '1:00'],
    ]);
    const p = parseTitansSheet(ws, specFor('U13 SILVER', [1]));
    assert.ok(
      p.errors.some((e) => /01:00.*outside 07:00/.test(e)),
      p.errors.join('\n'),
    );
  });
});

describe('team names', () => {
  test('whitespace collapses and "CC" before the side number drops', () => {
    assert.equal(canonicalTeamName('CENTURION KAVALIERS CC 2'), 'CENTURION KAVALIERS 2');
    assert.equal(canonicalTeamName('CBCOB  VETERANS 1'), 'CBCOB VETERANS 1');
    assert.equal(canonicalTeamName(' laudium  b '), 'LAUDIUM B');
    assert.equal(
      resolveTeamClub('CENTURION KAVALIERS CC 2')?.id,
      'centurion-kavaliers-cricket-club',
    );
    assert.equal(resolveTeamClub('EERSTERUST  VETERANS 1')?.id, 'eersterust-cricket-club');
    assert.equal(resolveTeamClub('QUEENSWOOD CRICKET CLUB 1')?.id, 'queenswood-cricket-club');
    assert.equal(resolveTeamClub('NOT A CLUB 1'), undefined);
  });

  test("an un-numbered side is the sheet's one numbered side of that club", () => {
    const { rewrites, errors } = inferUnnumberedSides([
      'QUEENSWOOD CRICKET CLUB',
      'QUEENSWOOD CRICKET CLUB 2',
      'TUKS 1',
    ]);
    assert.deepEqual(errors, []);
    assert.equal(rewrites.get('QUEENSWOOD CRICKET CLUB'), 'QUEENSWOOD CRICKET CLUB 2');
  });

  test('an un-numbered side next to two numbered sides is ambiguous (fatal)', () => {
    const { rewrites, errors } = inferUnnumberedSides([
      'QUEENSWOOD CRICKET CLUB',
      'QUEENSWOOD CRICKET CLUB 1',
      'QUEENSWOOD CRICKET CLUB 2',
    ]);
    assert.equal(rewrites.size, 0);
    assert.equal(errors.length, 1);
  });

  test('the sheet parser applies the inference and reports it', () => {
    const ws = sheetWith([
      HEADER,
      [dateCell(2026, 10, 10), 'QUEENSWOOD CRICKET CLUB 1', 'LAUDIUM 3', 'CR SWART'],
      [dateCell(2026, 10, 17), 'QUEENSWOOD CRICKET CLUB', 'BRITS 3', 'CR SWART'],
    ]);
    const p = parseTitansSheet(ws, specFor('FOURTH', [2]));
    assert.deepEqual(p.errors, []);
    assert.equal(p.fixtures[1].home, 'QUEENSWOOD CRICKET CLUB 1');
    assert.deepEqual(p.sideInferences, [
      { from: 'QUEENSWOOD CRICKET CLUB', to: 'QUEENSWOOD CRICKET CLUB 1' },
    ]);
  });
});

describe('venues — misspellings merged, distinct fields never', () => {
  test('known misspellings share the canonical ledger key and display name', () => {
    for (const [typo, canon] of [
      ['GIJIMA SPORTS GROUNDS', 'GIJIMA SPORTS GROUND'],
      ['HIGH SCHOOL UITISIG A', 'HIGH SCHOOL UITSIG A'],
      ['HIGH SCHOOL UITISG A', 'HIGH SCHOOL UITSIG A'],
      ['SOSGANGUVE OVAL', 'SOSHANGUVE OVAL'],
      ['LAERSKOOL ANTON VAN VOUW', 'LAERSKOOL ANTON VAN WOUW'],
      ['MIDSTREAM RIDGE A', 'MIDSTREAM RIDGE A FIELD'],
      ['HOFEMYER PARK B', 'HOFMEYER PARK B'],
      ['MAMEMLODI OVAL', 'MAMELODI OVAL'],
    ]) {
      assert.equal(titansGroundKey(typo), titansGroundKey(canon), `${typo} → ${canon}`);
      assert.equal(canonicalVenueName(typo), canon);
    }
  });

  test('distinct fields of one complex keep distinct ledger keys', () => {
    for (const [a, b] of [
      ['IRENE OVAL', 'IRENE COUNTRY CLUB'],
      ['GIJIMA OVAL', 'GIJIMA SPORTS GROUND'],
      ['SILVER VALKE', 'SILVER VALKE B'],
      ['SOUTHDOWNS COLLEGE A', 'SOUTHDOWNS COLLEGE B'],
      ['LAERSKOOL LYNWOOD ATTSPORTS A', 'LAERSKOOL LYNWOOD ATTSPORTS B'],
      ['MIDSTREAM RIDGE A FIELD', 'MIDSTREAM RIDGE B FIELD'],
      ['THE GLEN', 'THE GLEN HIGH'],
    ])
      assert.notEqual(titansGroundKey(a), titansGroundKey(b), `${a} must not merge with ${b}`);
  });

  test('the alias builder refuses an alias that would hijack another ground', () => {
    assert.throws(() =>
      buildTitansVenueAliases([
        ...TITANS_VENUE_SPELLINGS,
        { name: 'IRENE COUNTRY CLUB', aliases: ['IRENE OVAL'], note: 'bad' },
        { name: 'IRENE OVAL', aliases: [], note: 'x' },
      ]),
    );
  });
});

describe('T20 sheets — groups, AM/PM sessions, knockout slots', () => {
  const rows = [
    title('T20'),
    ['GROUP A', 'GROUP A', 'GROUP A', 'GROUP A'],
    HEADER,
    [dateCell(2026, 10, 3), 'MAMELODI 1', 'SOSHANGUVE 1', 'MAMELODI OVAL'],
    ['AM', 'LAUDIUM 1', 'POLICE 1', 'LAUDIUM OVAL'],
    ['PM', 'MAMELODI 1', 'LAUDIUM 1', 'MAMELODI OVAL'],
    [null, 'POLICE 1', 'SOSHANGUVE 1', 'ALOE PARK'],
    ['GROUP B', 'GROUP B', 'GROUP B', 'GROUP B'],
    HEADER,
    [dateCell(2026, 10, 6), 'TUKS 1', 'TUKS 2', 'TUKS OVAL'],
    ['13H00'],
    ['KNOCK-OUT FINAL STAGE', 'KNOCK-OUT FINAL STAGE', 'KNOCK-OUT FINAL STAGE'],
    [...HEADER, 'WINNER'],
    [dateCell(2026, 10, 10), 'WINNER GA', 'IRENE VILLAGERS 1', 'WINNER GA (Q1)'],
    ['AM', 'WINNER GB', 'RUNNER UP 1', 'WINNER GB (Q2)'],
    ['PM', 'WINNER Q1', 'WINNER Q2', 'WINNER Q1 (S1)'],
    [dateCell(2027, 3, 20), 'COMMUNITY CUP WINNER', 'GROUP B WINNER', 'TBC'],
  ];
  const spec: SheetSpec = {
    sheet: 'TEST T20',
    layout: 't20',
    junior: false,
    leagueKey: 'mens-t20',
    series: [
      {
        seriesId: 's-g-a',
        leagueKey: 'mens-t20',
        seriesName: 'A',
        part: 'Group A',
        expected: 4,
        group: 'GROUP A',
      },
      {
        seriesId: 's-g-b',
        leagueKey: 'mens-t20',
        seriesName: 'B',
        part: 'Group B',
        expected: 1,
        group: 'GROUP B',
      },
    ],
    koRows: 4,
    koSeriesId: 's-ko',
  };
  const p = parseTitansSheet(sheetWith(rows), spec);

  test('parses clean, each fixture in its group series', () => {
    assert.deepEqual(p.errors, []);
    assert.deepEqual(
      p.fixtures.map((f) => f.seriesId),
      ['s-g-a', 's-g-a', 's-g-a', 's-g-a', 's-g-b'],
    );
  });

  test('the date row and the AM row are the morning session, PM carries down', () => {
    assert.deepEqual(
      p.fixtures.slice(0, 4).map((f) => [f.date, f.time, f.timeSource]),
      [
        ['2026-10-03', '09:00', 't20-marker'],
        ['2026-10-03', '09:00', 't20-marker'],
        ['2026-10-03', '13:30', 't20-marker'],
        ['2026-10-03', '13:30', 't20-marker'],
      ],
    );
  });

  test('a stand-alone "13H00" row sets the start of the fixture above it', () => {
    assert.deepEqual([p.fixtures[4].time, p.fixtures[4].timeSource], ['13:00', 'sheet']);
    assert.equal(p.timeRows.length, 1);
  });

  test('knockout rows become proposals: pos / tbd / win / team', () => {
    assert.deepEqual(
      p.ko.map((k) => [k.fixtureId, k.tag, k.time, k.home.ref, k.away.ref]),
      [
        ['f1', 'Q1', '09:00', 'pos:s-g-a:1', 'team:IRENE VILLAGERS 1'],
        ['f2', 'Q2', '09:00', 'pos:s-g-b:1', 'tbd:Runner-up 1'],
        ['f3', 'S1', '13:30', 'win:f1', 'win:f2'],
        ['f4', null, '09:00', 'tbd:Community Cup winner', 'pos:s-g-b:1'],
      ],
    );
  });

  test('slot proposals for the other labels the workbook uses', () => {
    const ctx = {
      groupSeries: new Map([
        ['A', 's-g-a'],
        ['1', 's-g-a'],
        ['3', 's-g-c'],
      ]),
      tags: new Map([['S2', 'f6']]),
      leagueSeries: 's-vets-a',
      firstKoFixture: 'f1',
    };
    assert.equal(proposeSlotRef('WINNER G1', ctx)?.ref, 'pos:s-g-a:1');
    assert.equal(proposeSlotRef('RUNNER UP G3', ctx)?.ref, 'pos:s-g-c:2');
    assert.equal(proposeSlotRef('BEST 3RD PLACE', ctx)?.ref, 'tbd:Best 3rd place');
    assert.equal(proposeSlotRef('SECOND BEST 3RDD PLACE', ctx)?.ref, 'tbd:Second best 3rd place');
    assert.equal(proposeSlotRef('WINNER S2', ctx)?.ref, 'win:f6');
    assert.equal(proposeSlotRef('2ND PLACE', ctx)?.ref, 'pos:s-vets-a:2');
    assert.equal(proposeSlotRef('SEMI-FINAL WINNER', ctx)?.ref, 'win:f1');
    assert.equal(proposeSlotRef('SOMETHING ELSE', ctx), null);
  });
});

describe('veterans playoff rows sit inline and are not league fixtures', () => {
  test('2ND v 3RD and 1ST v SEMI-FINAL WINNER become KO rows', () => {
    const ws = sheetWith([
      [...HEADER, 'TIME'],
      [dateCell(2026, 9, 13), 'BRITS VETERANS 1', 'PRETORIA 1', 'BRITS OVAL', timeCell(8, 0)],
      [dateCell(2026, 11, 15), '2ND PLACE', '3RD PLACE', '2ND PLACE HOME VENUE', timeCell(8, 0)],
      [
        dateCell(2026, 11, 22),
        '1ST PLACE',
        'SEMI-FINAL WINNER',
        '1ST PLACE HOME VENUE',
        timeCell(8, 0),
      ],
    ]);
    const p = parseTitansSheet(ws, specFor('TITANS VETERANS LEAGUE A', [1]));
    assert.deepEqual(p.errors, []);
    assert.equal(p.fixtures.length, 1);
    assert.deepEqual(
      p.ko.map((k) => [k.home.ref, k.away.ref]),
      [
        ['pos:s-titans-veterans-league-a:2', 'pos:s-titans-veterans-league-a:3'],
        ['pos:s-titans-veterans-league-a:1', 'win:f1'],
      ],
    );
  });
});

describe('HELD_BACK + clash scan', () => {
  // Two junior pools at one ground on one date, both on the provisional 08:30.
  const u11PlatB = parseTitansSheet(
    sheetWith([
      HEADER,
      [dateCell(2026, 10, 17), 'BRITS A', 'ADELAAR B', 'BRITS LAER A'],
      [dateCell(2026, 10, 24), 'PHSOB A', 'HARLEQUINS A', 'LAERSKOOL ANTON VAN WOUW'],
    ]),
    specFor('U11 PLAT B', [2]),
  );
  const u11GoldA = parseTitansSheet(
    sheetWith([
      HEADER,
      [dateCell(2026, 10, 24), 'PHSOB B', 'IRENE VILLAGERS C', 'LAERSKOOL ANTON VAN VOUW'],
    ]),
    specFor('U11 GOLD A', [1]),
  );
  const sheets = [u11PlatB, u11GoldA];
  const clubs = clubsFromMap();
  const venues = wouldBeRegistry(sheets, clubs);
  const held = HELD_BACK.filter((h) => h.date === '2026-10-24');

  test('the misspelt pair is one ground, so it clashes provisional-vs-provisional', () => {
    const none = buildTitansSeries(sheets, venues, []);
    const clashes = scanTitansClashes(
      none.built.map((b) => b.series),
      clubs,
      venues,
    );
    assert.equal(clashes.length, 1);
    assert.equal(clashes[0].tag, 'provisional-vs-provisional');
  });

  test('held-back fixtures are not written, take ids after the kept ones, and clear the clash', () => {
    const out = buildTitansSeries(sheets, venues, held);
    assert.deepEqual(out.heldProblems, []);
    assert.deepEqual(
      out.held.map((h) => [h.seriesId, h.fixtureId]),
      [
        ['s-titans-u11-platinum-b', 'f2'],
        ['s-titans-u11-gold-a', 'f1'],
      ],
    );
    const platB = out.built.find((b) => b.series.id === 's-titans-u11-platinum-b')!;
    assert.deepEqual(
      platB.fixtures.map((f) => f.id),
      ['f1'],
    );
    assert.equal(
      scanTitansClashes(
        out.built.map((b) => b.series),
        clubs,
        venues,
      ).length,
      0,
    );
  });

  test('a HELD_BACK entry that matches nothing is a problem, not a silent no-op', () => {
    const out = buildTitansSeries(sheets, venues, [{ ...held[0], date: '2026-10-31' }]);
    assert.equal(out.heldProblems.length, 1);
  });

  test('a junior 08:30 and a senior 13:00 on one ground-day are listed, not clashed', () => {
    const second = parseTitansSheet(
      sheetWith([HEADER, [dateCell(2026, 10, 17), 'BRITS 2', 'TUT 2', 'BRITS LAER A']]),
      specFor('SECOND', [1]),
    );
    const all = [u11PlatB, second];
    const v = wouldBeRegistry(all, clubs);
    const out = buildTitansSeries(all, v, []);
    assert.equal(
      scanTitansClashes(
        out.built.map((b) => b.series),
        clubs,
        v,
      ).length,
      0,
    );
    const days = sharedGroundDays(out.built);
    assert.equal(days.length, 1);
    assert.equal(days[0].date, '2026-10-17');
  });
});

describe('manifest', () => {
  test('36 sheets, 1,398 expected fixtures, unique series ids', () => {
    assert.equal(TITANS_FIXTURE_SHEETS.length, 36);
    assert.equal(EXPECTED_TOTAL_FIXTURES, 1398);
    const ids = TITANS_FIXTURE_SHEETS.flatMap((s) => s.series.map((x) => x.seriesId));
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes('s-titans-premier-league-a'));
    assert.ok(ids.includes('s-titans-mens-t20-g-e'));
    assert.ok(ids.includes('s-titans-u9-platinum-a'));
  });
});

const WORKBOOK = `${process.env.HOME}/Downloads/2026 Titans Club Cricket 2026-2027 Fixtures - 1st Half Final Final Draft.xlsx`;
describe('the real union workbook (skipped when absent)', { skip: !existsSync(WORKBOOK) }, () => {
  test('parses clean to 1,398 fixtures, 19 KO rows; 2 clashes before HELD_BACK, 0 after', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(WORKBOOK);
    const { sheets, errors } = parseTitansWorkbook(wb);
    assert.deepEqual(errors, []);
    assert.equal(
      sheets.reduce((n, s) => n + s.fixtures.length, 0),
      1398,
    );
    assert.equal(
      sheets.reduce((n, s) => n + s.ko.length, 0),
      19,
    );
    const clubs = clubsFromMap();
    const venues = wouldBeRegistry(sheets, clubs);
    const before = buildTitansSeries(sheets, venues, []);
    const after = buildTitansSeries(sheets, venues);
    assert.deepEqual(before.unresolvedNames, []);
    assert.deepEqual(after.heldProblems, []);
    assert.equal(
      scanTitansClashes(
        before.built.map((b) => b.series),
        clubs,
        venues,
      ).length,
      2,
    );
    assert.equal(
      scanTitansClashes(
        after.built.map((b) => b.series),
        clubs,
        venues,
      ).length,
      0,
    );
  });
});
