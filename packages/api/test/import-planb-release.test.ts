/**
 * Unit tests for the 2026-27 RELEASE workbook parser (the single-file union release
 * path in src/import-planb-fixtures.ts). Pure — no dynalite, no repo.js, nothing touches
 * DynamoDB: each test builds a small synthetic ExcelJS workbook in memory and drives the
 * exported parser/splitter directly. Unlike import-planb.e2e.test.ts these need no
 * env-gated real-sheet fixtures, so they run everywhere `npm test` runs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import type { Club } from '../src/types.js';

const { parseReleaseWorkbook, splitPromotionT20, releaseDate } =
  await import('../src/import-planb-fixtures.js');

// ── cell + workbook builders (mirror import-planb.test.ts's helpers) ──
const dateCell = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));
const timeCell = (h: number, m: number): Date => new Date(Date.UTC(1899, 11, 30, h, m));

/** The five sheets the parser requires present. Any sheet not supplied is created empty. */
const RELEASE_SHEETS = [
  'PREMIER MEN',
  'PREMIER WOMEN',
  'PROMOTION MEN',
  'VETERANS PREMIER',
  'VETERANS PROMOTION',
];
function makeReleaseWorkbook(rowsBySheet: Record<string, unknown[][]>): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  for (const name of RELEASE_SHEETS) {
    const ws = wb.addWorksheet(name);
    for (const row of rowsBySheet[name] ?? []) ws.addRow(row as ExcelJS.CellValue[]);
  }
  return wb;
}

describe('releaseDate — Excel date cells + month-name text', () => {
  test('an Excel date cell parses via isoDate', () => {
    assert.equal(releaseDate(dateCell(2026, 10, 4)), '2026-10-04');
  });
  test('a text date "4-Oct-26" parses (two-digit year → 2000s)', () => {
    assert.equal(releaseDate('4-Oct-26'), '2026-10-04');
  });
  test('a text date "04 Oct 2026" parses', () => {
    assert.equal(releaseDate('04 Oct 2026'), '2026-10-04');
  });
  test('a formula result string parses', () => {
    assert.equal(releaseDate({ formula: '=x', result: '17-Jan-27' }), '2027-01-17');
  });
  test('junk returns null', () => {
    assert.equal(releaseDate('Venue:'), null);
    assert.equal(releaseDate(''), null);
  });
});

describe('parseReleaseWorkbook — PROMOTION MEN column layout + slot-time precedence', () => {
  // PROMOTION MEN: home=A, v=B, time=C, away=D, venue=E (one column left of the other
  // sheets). Week header carries a slot time in C and a date in D; a blank-home row with a
  // time in C is a slot-time row; fixture rows leave C empty (inherit the running slot).
  const wb = makeReleaseWorkbook({
    'PROMOTION MEN': [
      ['Promotion Men - T20'],
      ['Week 1 Fixtures', '', timeCell(9, 0), dateCell(2026, 10, 4), 'Venue:'],
      // sidebar junk in col H (index 7) must not leak — a stray "v" there is ignored.
      ['Saints CC', 'v', '', 'Forest Hills', 'Penguin Street', '', '', 'v'],
      ['East Coast', 'v', '', 'KwaMashu', 'Phoenix Stonebridge'],
      ['', '', timeCell(13, 30), '', ''], // slot-time row → running time becomes 13:30
      ['Umlazi', 'v', '', 'Tongaat', 'Chatsworth 114'],
      // a per-row time (col C) overrides the running slot time
      ['Newlands', 'v', timeCell(8, 0), 'Meadowridge', 'Siripat 2'],
    ],
  });
  const { sections, orphans } = parseReleaseWorkbook(wb);
  const combined = sections.find((s) => s.spec.slug === 'promotion-men-t20');

  test('the combined Promotion Men T20 section is detected with its slug', () => {
    assert.ok(combined, 'promotion-men-t20 section parsed');
    assert.equal(combined!.fixtures.length, 4);
  });
  test('home/away/venue read from the promotion-men columns, sidebar does not leak', () => {
    assert.equal(orphans.length, 0, 'no orphan from the sidebar "v"');
    const f0 = combined!.fixtures[0];
    assert.equal(f0.homeName, 'Saints CC');
    assert.equal(f0.awayName, 'Forest Hills');
    assert.equal(f0.venue, 'Penguin Street');
  });
  test('slot time inherited, then updated by a slot row, then overridden per-row', () => {
    const [f1, f2, f3, f4] = combined!.fixtures;
    assert.equal(f1.time, '09:00', 'inherits the week-header slot time');
    assert.equal(f2.time, '09:00');
    assert.equal(f3.time, '13:30', 'inherits the mid-week slot-time row');
    assert.equal(f4.time, '08:00', 'per-row time overrides the running slot');
  });
  test('all fixtures share the week header date and round', () => {
    for (const f of combined!.fixtures) {
      assert.equal(f.date, '2026-10-04');
      assert.equal(f.round, 1);
    }
  });
});

describe('parseReleaseWorkbook — default layout, per-row times, TBC + banner skips', () => {
  // PREMIER WOMEN: home=A, v=C, time=D, away=E, venue=F. Every fixture carries its own time.
  const wb = makeReleaseWorkbook({
    'PREMIER WOMEN': [
      ['T20 Premier Women Group 1'],
      ['Week 1 Fixtures', '', '', 'Time:', dateCell(2026, 10, 4), 'Venue:'],
      ['Chatsworth Sporting', '', 'v', timeCell(8, 30), 'Rhythm DHS', 'Commons 2 [WBHS]'],
      ['Delta', '', 'v', timeCell(13, 0), 'KwaMashu', 'Commons 1 [WBHS]'],
      ['TBC', '', 'v', timeCell(13, 0), 'Delta', 'Commons 1 [WBHS]'], // TBC home → skipped
      ['T20 Finals Weekend'], // banner ends the section
      ['TBC', '', 'v', timeCell(9, 0), 'TBC', 'TBC'], // finals placeholder, no live section
    ],
  });
  const { sections, orphans, tbcSkipped } = parseReleaseWorkbook(wb);
  const g1 = sections.find((s) => s.spec.slug === 'premier-women-t20-g1');

  test('two real fixtures parsed; both TBC rows are skipped', () => {
    assert.ok(g1);
    assert.equal(g1!.fixtures.length, 2);
    // the in-section TBC fixture + the post-banner finals TBC placeholder
    assert.equal(tbcSkipped, 2, 'both TBC rows counted as skipped');
  });
  test('per-row times are read from the time column', () => {
    assert.equal(g1!.fixtures[0].time, '08:30');
    assert.equal(g1!.fixtures[1].time, '13:00');
  });
  test('the finals-weekend banner ends the section so its placeholder is not an orphan', () => {
    assert.equal(orphans.length, 0);
  });
});

describe('parseReleaseWorkbook — a fixture under no live section is an orphan', () => {
  test('a fixture row before any section header is reported', () => {
    const wb = makeReleaseWorkbook({
      'PREMIER MEN': [['Home', '', 'v', timeCell(13, 0), 'Away', 'Somewhere']],
    });
    const { orphans } = parseReleaseWorkbook(wb);
    assert.equal(orphans.length, 1);
    assert.match(orphans[0], /Home v Away/);
  });
});

describe('parseReleaseWorkbook — bottom-10 amendments (10 Sep 2026)', () => {
  // A bottom-10 section carrying the union's duplicate DUT v Simplex (one with a stray
  // "17-Jan-26" note in col F) and, because that displaced it, NO Meadowridge v Forest Hills.
  const wb = makeReleaseWorkbook({
    'PROMOTION MEN': [
      ['30 Over Promotion Bottom 10'],
      ['Week 5 Fixtures', '', '', dateCell(2026, 11, 29), 'Venue:'],
      ['DUT', 'v', '', 'Simplex', 'Siripat 2'],
      ['DUT', 'v', '', 'Simplex', 'Siripat 2', '17-Jan-26'], // the duplicate
      ['Spartan Sporting', 'v', '', 'Verulam', 'Siripat 1'],
      ['Week 6 Fixtures', '', '', dateCell(2026, 12, 6), 'Venue:'],
      ['DUT', 'v', '', 'Tongaat Cricket Association', 'Siripat 2'],
    ],
  });
  const { sections, amendmentNotes } = parseReleaseWorkbook(wb);
  const bottom10 = sections.find((s) => s.spec.slug === 'promotion-men-30ov-bottom10')!;
  const find = (h: string, a: string) =>
    bottom10.fixtures.filter((f) => f.homeName === h && f.awayName === a);

  test('the duplicate DUT v Simplex is dropped, keeping one', () => {
    assert.equal(find('DUT', 'Simplex').length, 1, 'exactly one DUT v Simplex remains');
    assert.ok(amendmentNotes.some((n) => /dropped duplicate/.test(n)));
  });
  test('DUT v Simplex is postponed to 2027-01-17 09:00 at Siripat 1', () => {
    const ds = find('DUT', 'Simplex')[0];
    assert.equal(ds.date, '2027-01-17');
    assert.equal(ds.time, '09:00');
    assert.equal(ds.venue, 'Siripat 1');
    assert.equal(ds.round, 5, 'keeps its original (week 5) round');
  });
  test('DUT v Tongaat CA is postponed to 2027-01-17 14:00 at Collegians', () => {
    const dt = find('DUT', 'Tongaat Cricket Association')[0];
    assert.equal(dt.date, '2027-01-17');
    assert.equal(dt.time, '14:00');
    assert.equal(dt.venue, 'Collegians');
    assert.equal(dt.round, 6, 'keeps its original (week 6) round');
  });
  test('Meadowridge v Forest Hills is re-added at round 5, 2026-11-29 13:00', () => {
    const mf = find('Meadowridge', 'Forest Hills');
    assert.equal(mf.length, 1);
    assert.equal(mf[0].round, 5);
    assert.equal(mf[0].date, '2026-11-29');
    assert.equal(mf[0].time, '13:00');
    assert.equal(mf[0].venue, 'Forest Hills Sports Club');
  });
});

describe('splitPromotionT20 — group split by prod participants + dense round renumber', () => {
  const clubs = [
    { id: 'alpha', name: 'Alpha' },
    { id: 'beta', name: 'Beta' },
    { id: 'gamma', name: 'Gamma' },
    { id: 'delta', name: 'Delta' },
  ] as unknown as Club[];
  const byNorm = new Map<string, Club>();
  for (const c of clubs) {
    byNorm.set(c.name.toLowerCase(), c);
    byNorm.set(c.id.toLowerCase(), c);
  }
  const prodSeries = [
    { id: 's-planb-promotion-men-t20-g1', participants: [{ teamId: 'alpha' }, { teamId: 'beta' }] },
    {
      id: 's-planb-promotion-men-t20-g2',
      participants: [{ teamId: 'gamma' }, { teamId: 'delta' }],
    },
  ];
  // Combined section: two g1 pairs (across two dates) + one g2 pair. Sheet weeks are noisy
  // (7, 3) so the dense (date,time) renumber is what's actually under test.
  const combined = {
    spec: {
      slug: 'promotion-men-t20',
      label: 'T20 (combined)',
      leagueKey: 'promotion',
      seriesType: 'Twenty20 (16-25 overs)',
      maxOvers: 20,
      expected: 40,
    },
    skippedRows: [],
    fixtures: [
      {
        round: 7,
        date: '2026-10-11',
        time: '09:00',
        homeName: 'Beta',
        awayName: 'Alpha',
        venue: 'V2',
      },
      {
        round: 3,
        date: '2026-10-04',
        time: '09:00',
        homeName: 'Alpha',
        awayName: 'Beta',
        venue: 'V1',
      },
      {
        round: 5,
        date: '2026-10-04',
        time: '09:00',
        homeName: 'Gamma',
        awayName: 'Delta',
        venue: 'V3',
      },
    ],
  };

  const { groups, unresolved, crossGroup } = splitPromotionT20(
    combined as never,
    clubs,
    byNorm,
    prodSeries,
  );
  const g = (n: number) => groups.find((x) => x.spec.slug === `promotion-men-t20-g${n}`)!;

  test('every fixture resolves to exactly one prod group', () => {
    assert.equal(unresolved.length, 0);
    assert.equal(crossGroup.length, 0);
  });
  test('g1 gets both Alpha/Beta pairs, g2 the Gamma/Delta pair, g3/g4 empty', () => {
    assert.equal(g(1).fixtures.length, 2);
    assert.equal(g(2).fixtures.length, 1);
    assert.equal(g(3).fixtures.length, 0);
    assert.equal(g(4).fixtures.length, 0);
  });
  test('g1 rounds renumbered densely from 1 by (date,time) ordinal, sorted', () => {
    // Two distinct dates (2026-10-04, 2026-10-11) → rounds 1 and 2, in chronological order.
    assert.deepEqual(
      g(1).fixtures.map((f) => [f.date, f.round]),
      [
        ['2026-10-04', 1],
        ['2026-10-11', 2],
      ],
    );
  });
  test('g2 renumbers from 1 independently of the sheet week', () => {
    assert.equal(g(2).fixtures[0].round, 1);
  });
});
