/**
 * Unit tests for import-umpire-appointments.ts's pure core: the workbook parser (sections
 * found by their "Home Team" header, columns mapped BY NAME, everything trimmed), the
 * fixture matcher (league + date + unordered pair, the sheet's typo table and lettered
 * sides, time only as a tie-break, fail-closed on anything unclear) and the write plan
 * (idempotent: a re-run is all "unchanged"). No repo, no DynamoDB.
 *
 * The parser runs on a synthetic workbook built here with exceljs in the shape of the
 * union's "Runner 3 - 4 October 2026" sheet. When the real file is on this machine
 * (~/Downloads), it is also checked: 45 rows, 17 with two umpires, 27 umpires.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {
  matchAppointments,
  parseAppointmentsWorkbook,
  parseArgs,
  planNewUmpires,
  planWrites,
  resolveUmpireNames,
  rowDate,
  sheetDoubleBookings,
  unknownSections,
  type AppointmentRow,
} from '../src/import-umpire-appointments.js';
import type { Club, FixtureOfficials, Series, Umpire } from '../src/types.js';

// ───────────────────────── Synthetic workbook ─────────────────────────

const OCT = new Date(Date.UTC(2026, 9, 1));
const at = (h: number, m = 0) => new Date(Date.UTC(1899, 11, 30, h, m));

/** The union's layout: a title row, then sections whose column positions differ — Premier
 * has a Referee column at I, the others leave I unnamed — with trailing spaces everywhere. */
function syntheticWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('T20 Runner ');
  ws.getRow(1).values = ['KZNCU Appointments T20'];
  ws.getRow(2).values = [
    'Ref No',
    'Month',
    'Day',
    'Time ',
    'Date',
    'Home Team',
    'Away Team',
    'Venue',
    'Referee',
    'Umpire ',
    'Umpire ',
  ];
  ws.getRow(3).values = [
    'Premier league T20',
    OCT,
    'Sunday ',
    at(9),
    4,
    'Umzinto ',
    'African Warriors ',
    'Kingsmead Oval ',
    null,
    'B.Tyali',
    'O.Panday ',
  ];
  ws.getRow(4).values = [
    'Premier league T20',
    OCT,
    'Sunday ',
    at(13, 30),
    4,
    'Chatsworth United ',
    'African Warriors ',
    'Kingsmead Oval ',
    null,
    'B.Tyali',
    'O.Panday ',
  ];
  // A second section with a different header spelling and an unnamed column I.
  ws.getRow(10).values = [
    'REF',
    'Month',
    'Day',
    'Time ',
    'Date ',
    'Home Team ',
    'Away Team ',
    'Venue ',
    null,
    'Umpire ',
    'Umpire ',
  ];
  ws.getRow(11).values = [
    'Veterans league T20',
    OCT,
    'Saturday ',
    at(13),
    3,
    'Dawnheights ',
    'Amazimtoti',
    'Toti Oval',
    null,
    'S.Gasa',
  ];
  // Columns shifted one to the right in this section — mapped by name, not position.
  ws.getRow(20).values = [
    'Ref',
    'Notes',
    'Month ',
    'Day ',
    'Time ',
    'Date ',
    'Home Team ',
    'Away Team ',
    'Venue ',
    'Umpire ',
    'Umpire ',
  ];
  ws.getRow(21).values = [
    'Womens Premier league T20',
    'x',
    OCT,
    'Sunday ',
    at(8, 30),
    4,
    'KCCD ',
    'Chatsworth United ',
    'Westville Boys High Commons 1',
    'A.Khwela ',
    'A.Mahabeer',
  ];
  ws.getRow(30).values = [4]; // a stray page number below the last section
  return wb;
}

describe('parseAppointmentsWorkbook', () => {
  test('finds every section by its header and maps columns by name', () => {
    const { sheet, rows, problems } = parseAppointmentsWorkbook(syntheticWorkbook());
    assert.equal(sheet, 'T20 Runner ');
    assert.deepEqual(problems, []);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0], {
      sheetRow: 3,
      section: 'Premier league T20',
      date: '2026-10-04',
      time: '09:00',
      kickoff: '2026-10-04T09:00:00+02:00',
      home: 'Umzinto',
      away: 'African Warriors',
      venue: 'Kingsmead Oval',
      umpires: ['B.Tyali', 'O.Panday'],
    });
    assert.equal(rows[1].time, '13:30');
    assert.deepEqual(
      { date: rows[2].date, time: rows[2].time, umpires: rows[2].umpires, away: rows[2].away },
      { date: '2026-10-03', time: '13:00', umpires: ['S.Gasa'], away: 'Amazimtoti' },
    );
    // The shifted section reads the right cells despite the extra column.
    assert.deepEqual(
      {
        section: rows[3].section,
        home: rows[3].home,
        venue: rows[3].venue,
        umpires: rows[3].umpires,
      },
      {
        section: 'Womens Premier league T20',
        home: 'KCCD',
        venue: 'Westville Boys High Commons 1',
        umpires: ['A.Khwela', 'A.Mahabeer'],
      },
    );
  });

  test('a row with teams but no readable date is a problem, not a fixture', () => {
    const wb = syntheticWorkbook();
    wb.worksheets[0].getRow(5).values = [
      'Premier league T20',
      OCT,
      'Sunday',
      at(9),
      'tbc',
      'UKZN',
      'Delta',
      'Hammond',
      null,
      'T.Daly',
    ];
    const { rows, problems } = parseAppointmentsWorkbook(wb);
    assert.equal(rows.length, 4);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /row 5: UKZN v Delta — no readable date/);
  });

  test('rowDate builds the date from Month + day and rejects impossible days', () => {
    assert.equal(rowDate(OCT, 4), '2026-10-04');
    assert.equal(rowDate(new Date(Date.UTC(2026, 8, 1)), 31), undefined);
    assert.equal(rowDate(OCT, new Date(Date.UTC(2026, 9, 11))), '2026-10-11');
  });

  test('unknown section labels are reported', () => {
    const rows = [{ section: 'Premier league T20' }, { section: 'Under 19 T20' }];
    assert.deepEqual(unknownSections(rows as AppointmentRow[]), ['Under 19 T20']);
  });

  const REAL = path.join(
    homedir(),
    'Downloads',
    'Copy of KZNCU Umpires appointments Runner 3 - 4 October 2026 - Appointments.xlsx',
  );
  test(
    'the real 3–4 Oct 2026 sheet: 45 rows, 17 with two umpires, 27 umpires',
    { skip: !existsSync(REAL) && 'real workbook not on this machine' },
    async () => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(REAL);
      const { rows, problems } = parseAppointmentsWorkbook(wb);
      assert.deepEqual(problems, []);
      assert.equal(rows.length, 45);
      assert.equal(rows.filter((r) => r.umpires.length === 2).length, 17);
      assert.equal(rows.filter((r) => r.umpires.length === 1).length, 28);
      assert.ok(rows.every((r) => !r.referee));
      const names = new Set(rows.flatMap((r) => r.umpires.map((u) => u.toLowerCase())));
      assert.equal(names.size, 27);
      const bySection = (s: string) => rows.filter((r) => r.section === s).length;
      assert.equal(bySection('Premier league T20'), 12);
      assert.equal(bySection('Promotion league T20'), 16);
      assert.equal(bySection('Womens Premier league T20'), 4);
      assert.equal(bySection('Veterans league T20'), 13);
      assert.deepEqual(unknownSections(rows), []);
      assert.ok(rows.every((r) => r.date === '2026-10-03' || r.date === '2026-10-04'));
      assert.ok(
        rows.every((r) => r.home === r.home.trim() && r.umpires.every((u) => u === u.trim())),
      );
    },
  );
});

// ───────────────────────── Matcher ─────────────────────────

const club = (id: string, name: string) => ({ id, name }) as Club;
const CLUBS: Club[] = [
  club('amanzimtoti-cricket-club', 'Amanzimtoti Cricket Club'),
  club('dawnheights-cricket-club', 'Dawnheights Cricket Club'),
  club('tongaat-cricket-association', 'Tongaat Cricket Association'),
  club('southern-natal', 'Southern Natal'),
  club('rhythm-dhsob-cricket-club', 'Rhythm DHSOB Cricket club'),
  club('simplex-reservoir-hills-crimson', 'Simplex Reservoir Hills Crimson'),
  club('east-coast-cc', 'East Coast CC'),
  club('hillary-malvern-cricket-club', 'Hillary/Malvern Cricket Club'),
  club('umzinto', 'Umzinto'),
  club('african-warriors-cc', 'African Warriors CC'),
  club('hollywoodbets-chatsworth-sporting', 'Hollywoodbets Chatsworth Sporting'),
];

const P = (teamId: string, clubId: string, name: string) => ({ teamId, clubId, name });

function seriesOf(
  id: string,
  leagueKey: string,
  participants: ReturnType<typeof P>[],
  fixtures: Array<Record<string, unknown>>,
): Series {
  return {
    id,
    name: `${leagueKey} · T20`,
    leagueKey,
    maxOvers: 20,
    startDate: '2026-10-03',
    teams: participants.map((p) => p.teamId),
    participants,
    fixtures,
    released: true,
    releasedAt: '2026-09-10T00:00:00.000Z',
    version: 1,
  } as Series;
}

const VPREM = seriesOf(
  's-vet-prem',
  'veterans-premier',
  [
    P('dawnheights-cricket-club', 'dawnheights-cricket-club', 'Dawnheights Cricket Club'),
    P('amanzimtoti-cricket-club', 'amanzimtoti-cricket-club', 'Amanzimtoti Cricket Club'),
  ],
  [
    {
      id: 'f1',
      date: '2026-10-03',
      time: '13:00',
      home: 'dawnheights-cricket-club',
      away: 'amanzimtoti-cricket-club',
      venueName: 'Gledhow',
    },
  ],
);

const VPROM = seriesOf(
  's-vet-prom',
  'veterans-promotion',
  [
    P('tongaat-cricket-association', 'tongaat-cricket-association', 'Tongaat CA'),
    P('southern-natal', 'southern-natal', 'Southern Natal'),
    P('tm_rhythm-dhsob-cricket-club_veterans-promotion_1', 'rhythm-dhsob-cricket-club', 'Rhythm B'),
    P('hillary-malvern-cricket-club', 'hillary-malvern-cricket-club', 'Hillary/Malvern'),
    P(
      'tm_simplex-reservoir-hills-crimson_veterans-promotion_0',
      'simplex-reservoir-hills-crimson',
      'Simplex A',
    ),
    P('east-coast-cc', 'east-coast-cc', 'East Coast CC'),
    P('tm_amanzimtoti-cricket-club_veterans-promotion_1', 'amanzimtoti-cricket-club', 'Toti B'),
  ],
  [
    {
      id: 'f1',
      date: '2026-10-03',
      time: '13:00',
      home: 'tongaat-cricket-association',
      away: 'southern-natal',
      venueOverride: 'Kingsmead Oval',
    },
    // Reversed home/away vs the sheet: still the same unordered pair.
    {
      id: 'f2',
      date: '2026-10-03',
      time: '13:00',
      home: 'hillary-malvern-cricket-club',
      away: 'tm_rhythm-dhsob-cricket-club_veterans-promotion_1',
    },
    {
      id: 'f3',
      date: '2026-10-03',
      time: '13:00',
      home: 'east-coast-cc',
      away: 'tm_simplex-reservoir-hills-crimson_veterans-promotion_0',
    },
    {
      id: 'f4',
      date: '2026-09-26',
      time: '13:00',
      home: 'tm_amanzimtoti-cricket-club_veterans-promotion_1',
      away: 'east-coast-cc',
    },
  ],
);

const PREM = seriesOf(
  's-prem',
  'premier',
  [
    P('umzinto', 'umzinto', 'Umzinto'),
    P('african-warriors-cc', 'african-warriors-cc', 'African Warriors'),
    P('amanzimtoti-cricket-club', 'amanzimtoti-cricket-club', 'Amanzimtoti'),
    P(
      'hollywoodbets-chatsworth-sporting',
      'hollywoodbets-chatsworth-sporting',
      'Chatsworth Sporting',
    ),
  ],
  [
    // A double-header: the same pair twice in a day (only time tells them apart).
    { id: 'f1', date: '2026-10-04', time: '09:00', home: 'umzinto', away: 'african-warriors-cc' },
    { id: 'f2', date: '2026-10-04', time: '13:30', home: 'african-warriors-cc', away: 'umzinto' },
    {
      id: 'f3',
      date: '2026-10-04',
      time: '13:30',
      home: 'hollywoodbets-chatsworth-sporting',
      away: 'amanzimtoti-cricket-club',
      venueName: 'Toti Oval 1',
    },
  ],
);

// A 50-over series with the same pair on the same day must never be picked for a T20 row.
const PREM50 = {
  ...seriesOf('s-prem-50', 'premier', PREM.participants!, [
    { id: 'f1', date: '2026-10-04', time: '09:00', home: 'umzinto', away: 'african-warriors-cc' },
  ]),
  maxOvers: 50,
} as Series;

const ALL = [VPREM, VPROM, PREM, PREM50];

const row = (over: Partial<AppointmentRow> & Pick<AppointmentRow, 'home' | 'away'>) =>
  ({
    sheetRow: 1,
    section: 'Veterans league T20',
    date: '2026-10-03',
    time: '13:00',
    venue: '',
    umpires: ['S.Gasa'],
    ...over,
  }) as AppointmentRow;

describe('matchAppointments', () => {
  test('resolves the sheet typos and lettered sides onto the right fixtures', () => {
    const { matched, unmatched } = matchAppointments(
      [
        row({ sheetRow: 1, home: 'Dawnheights', away: 'Amazimtoti' }),
        row({ sheetRow: 2, home: 'Tongaat Cricket Assoication', away: 'Southern Natal' }),
        row({ sheetRow: 3, home: 'Rhythm DHS B', away: 'Hillary Malvern' }),
        row({ sheetRow: 4, home: 'East Coast', away: 'Simplex A' }),
        row({
          sheetRow: 5,
          section: 'Premier league T20',
          date: '2026-10-04',
          time: '13:30',
          home: 'Chatsworth Sporting',
          away: 'ACC',
        }),
      ],
      ALL,
      CLUBS,
    );
    assert.deepEqual(unmatched, []);
    assert.deepEqual(
      matched.map((m) => `${m.row.sheetRow}:${m.seriesId}/${m.fixtureId}`),
      ['1:s-vet-prem/f1', '2:s-vet-prom/f1', '3:s-vet-prom/f2', '4:s-vet-prom/f3', '5:s-prem/f3'],
    );
  });

  test('time breaks a same-day tie and never picks a 50-over fixture', () => {
    const { matched } = matchAppointments(
      [
        row({
          section: 'Premier league T20',
          date: '2026-10-04',
          time: '13:30',
          home: 'Umzinto',
          away: 'African Warriors',
        }),
      ],
      ALL,
      CLUBS,
    );
    assert.equal(matched.length, 1);
    assert.equal(matched[0].seriesId, 's-prem');
    assert.equal(matched[0].fixtureId, 'f2');
    assert.deepEqual(matched[0].notes, ['tie broken by time 13:30']);
  });

  test('an unbreakable tie is ambiguous and not matched', () => {
    const { matched, unmatched } = matchAppointments(
      [
        row({
          section: 'Premier league T20',
          date: '2026-10-04',
          time: undefined,
          home: 'Umzinto',
          away: 'African Warriors',
        }),
      ],
      ALL,
      CLUBS,
    );
    assert.equal(matched.length, 0);
    assert.equal(unmatched[0].kind, 'ambiguous');
  });

  test('reports time and venue differences but never changes them', () => {
    const { matched } = matchAppointments(
      [
        row({ home: 'Dawnheights', away: 'Amazimtoti', time: '10:00', venue: 'Toti Oval' }),
        row({
          sheetRow: 2,
          home: 'Tongaat Cricket Assoication',
          away: 'Southern Natal',
          venue: 'Kingsmead Oval ',
        }),
      ],
      ALL,
      CLUBS,
    );
    assert.deepEqual(matched[0].notes, [
      'time differs: sheet 10:00, fixture 13:00 (not changed)',
      'venue differs: sheet "Toti Oval", fixture "Gledhow" (not changed)',
    ]);
    // Same ground, different spelling ⇒ no note.
    assert.deepEqual(matched[1].notes, []);
    assert.equal(matched[0].fixture.time, '13:00');
  });

  test('unknown teams, missing fixtures and duplicate rows are listed and not matched', () => {
    const { matched, unmatched } = matchAppointments(
      [
        row({ sheetRow: 1, home: 'Nowhere XI', away: 'Southern Natal' }),
        // Plays on 26 Sep, not 3 Oct.
        row({ sheetRow: 2, home: 'Amanzimtoti B', away: 'East Coast' }),
        row({ sheetRow: 3, home: 'Dawnheights', away: 'Amazimtoti' }),
        row({ sheetRow: 4, home: 'Amanzimtoti', away: 'Dawnheights' }),
      ],
      ALL,
      CLUBS,
    );
    assert.equal(matched.length, 0);
    assert.deepEqual(
      unmatched.map((u) => `${u.row.sheetRow}:${u.kind}`),
      ['1:unknown-team', '2:no-fixture', '3:duplicate', '4:duplicate'],
    );
    assert.match(unmatched[0].reason, /Nowhere XI/);
    assert.match(unmatched[1].reason, /plays on 2026-09-26 \(s-vet-prom\)/);
  });

  test('a lettered side never matches a different letter', () => {
    // The fixture is Rhythm B; the sheet says Rhythm C.
    const { matched, unmatched } = matchAppointments(
      [row({ home: 'Rhythm DHS C', away: 'Hillary Malvern' })],
      ALL,
      CLUBS,
    );
    assert.equal(matched.length, 0);
    assert.equal(unmatched[0].kind, 'no-fixture');
  });

  test('an unknown section stops the match', () => {
    assert.throws(
      () => matchAppointments([row({ section: 'Under 19', home: 'A', away: 'B' })], ALL, CLUBS),
      /unknown section "Under 19"/,
    );
  });
});

// ───────────────────────── Umpires + write plan ─────────────────────────

const umpire = (id: string, displayName: string, aliases: string[]): Umpire => ({
  id,
  displayName,
  aliases,
  active: true,
});

describe('umpire resolution and the write plan', () => {
  test('names resolve by alias; unknown names are planned once per person', () => {
    const registry = [umpire('u-s-gasa', 'S.Gasa', ['sgasa'])];
    const { byName, unknown } = resolveUmpireNames(
      ['S. Gasa', 'V.Surujbally ', 'V.Surujbally'],
      registry,
    );
    assert.equal(byName.get('S. Gasa')?.id, 'u-s-gasa');
    assert.deepEqual(unknown, ['V.Surujbally ', 'V.Surujbally']);
    const created = planNewUmpires(unknown, registry, '2026-10-02T00:00:00.000Z');
    assert.equal(created.length, 1);
    assert.equal(created[0].id, 'u-v-surujbally');
    assert.equal(created[0].displayName, 'V.Surujbally');
    assert.deepEqual(created[0].aliases, ['vsurujbally']);
    // An id already in the registry is never reused.
    const again = planNewUmpires(['S Gasa!'], registry, 'x');
    assert.equal(again[0].id, 'u-s-gasa-2');
  });

  test('a re-run with the same appointments is all "unchanged"; an edit is "changed"', () => {
    const registry = [
      umpire('u-s-gasa', 'S.Gasa', ['sgasa']),
      umpire('u-b-tyali', 'B.Tyali', ['btyali']),
      umpire('u-o-panday', 'O.Panday', ['opanday']),
    ];
    const { matched } = matchAppointments(
      [
        row({ sheetRow: 1, home: 'Dawnheights', away: 'Amazimtoti', umpires: ['S.Gasa'] }),
        row({
          sheetRow: 2,
          section: 'Premier league T20',
          date: '2026-10-04',
          time: '09:00',
          home: 'Umzinto',
          away: 'African Warriors',
          umpires: ['B.Tyali', 'O.Panday'],
        }),
        row({ sheetRow: 3, home: 'East Coast', away: 'Simplex A', umpires: ['Z.Unknown'] }),
      ],
      ALL,
      CLUBS,
    );
    const names = [...new Set(matched.flatMap((m) => m.row.umpires))];
    const { byName } = resolveUmpireNames(names, registry);

    const first = planWrites(matched, byName, new Map());
    assert.deepEqual(
      first.writes.map((w) => w.action),
      ['new', 'new'],
    );
    assert.equal(first.skipped.length, 1);
    assert.match(first.skipped[0].reason, /unknown umpire: Z.Unknown/);
    assert.deepEqual(first.writes[1].officials.umpires, [
      { umpireId: 'u-b-tyali', name: 'B.Tyali' },
      { umpireId: 'u-o-panday', name: 'O.Panday' },
    ]);

    // Apply the first run, then run again: nothing to write.
    const stored = new Map<string, FixtureOfficials>(
      first.writes.map((w) => [`${w.match.seriesId}#${w.match.fixtureId}`, w.officials]),
    );
    const second = planWrites(matched, byName, stored);
    assert.deepEqual(
      second.writes.map((w) => w.action),
      ['unchanged', 'unchanged'],
    );

    // An admin swapped one umpire by hand — the sheet puts it back, reported as changed.
    stored.set('s-prem#f1', { umpires: [{ umpireId: 'u-s-gasa', name: 'S.Gasa' }] });
    const third = planWrites(matched, byName, stored);
    assert.deepEqual(
      third.writes.map((w) => w.action),
      ['unchanged', 'changed'],
    );
    assert.deepEqual(third.writes[1].previous, ['S.Gasa']);
  });

  test('flags an umpire at two different grounds at overlapping times', () => {
    const registry = [umpire('u-s-gasa', 'S.Gasa', ['sgasa'])];
    const { matched } = matchAppointments(
      [
        row({
          sheetRow: 1,
          home: 'Dawnheights',
          away: 'Amazimtoti',
          venue: 'Toti Oval',
          umpires: ['S.Gasa'],
        }),
        row({
          sheetRow: 2,
          home: 'Tongaat Cricket Assoication',
          away: 'Southern Natal',
          venue: 'Kingsmead Oval',
          umpires: ['S.Gasa'],
        }),
      ],
      ALL,
      CLUBS,
    );
    const { byName } = resolveUmpireNames(['S.Gasa'], registry);
    const doubles = sheetDoubleBookings(planWrites(matched, byName, new Map()).writes);
    assert.equal(doubles.length, 1);
    assert.equal(doubles[0].umpireId, 'u-s-gasa');
  });
});

describe('parseArgs', () => {
  test('requires a tenant (except parse-only) and refuses to write from a snapshot', () => {
    assert.throws(() => parseArgs(['--file', 'x.xlsx']), /--tenant/);
    assert.equal(parseArgs(['--file', 'x.xlsx', '--parse-only']).parseOnly, true);
    assert.throws(
      () => parseArgs(['--tenant', 'd', '--file', 'x', '--snapshot', 's.json', '--confirm']),
      /--snapshot/,
    );
    assert.throws(() => parseArgs(['--tenant', 'd', '--file', 'x', '--bogus']), /unknown flag/);
  });
});
