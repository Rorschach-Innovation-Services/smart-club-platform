/**
 * Unit tests for the Plan B fixture import's pure helpers — cell parsing (isoDate/
 * isoTime), the season-wide GroundLedger clash semantics, and assertDeleteSet's
 * subset-safety rail. Pure — no dynalite, no repo.js, nothing touches DynamoDB; the
 * module guards its own entry point (`import.meta.url === pathToFileURL(...)`), so
 * importing it here never runs main().
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const {
  isoDate,
  isoTime,
  GroundLedger,
  assertDeleteSet,
  normalise,
  redirectedNormalise,
  pairKey,
  parseWorkbook,
  computeSameClubSlotOverlaps,
} = await import('../src/import-planb-fixtures.js');

// Mirrors the module's own (unexported) constants — kept in sync by inspection, not
// import, since assertDeleteSet's contract is what's under test here.
const ID_PREFIX = 's-planb-';
const DELETE_SLUGS = [
  'premier-men-t20-top6',
  'premier-men-t20-bottom6',
  'premier-women-t20-top4',
  'premier-women-t20-bottom4',
];
const KEEP_SLUG = 'promotion-men-50ov-g1';

describe('isoDate / isoTime — Excel cell parsing', () => {
  test('a 1899-epoch Date (time-only cell) yields a time, and no date', () => {
    const cell = new Date(Date.UTC(1899, 11, 30, 13, 30));
    assert.equal(isoTime(cell), '13:30');
    assert.equal(isoDate(cell), null);
  });

  test('a modern Date (date cell) yields a date, and no time — even carrying a UTC time component', () => {
    // isoTime's guard is purely the year: any Date with getUTCFullYear() >= 1970 is
    // treated as a date cell, and isoTime returns null unconditionally — it never
    // inspects the hours/minutes on a modern Date. That's the actual implementation
    // behavior, not just the common case.
    const cell = new Date(Date.UTC(2026, 7, 16, 13, 30));
    assert.equal(isoDate(cell), '2026-08-16');
    assert.equal(isoTime(cell), null);
  });

  test('a fraction-of-day number rounds to the nearest minute', () => {
    assert.equal(isoTime(0.5625), '13:30'); // exact: 810/1440
    // 12:00:30 → 720.5 minutes; Math.round rounds the halfway case up to 721 → 12:01
    assert.equal(isoTime(720.5 / 1440), '12:01');
  });

  test('a {formula, result} cell unwraps to its result for both isoDate and isoTime', () => {
    const dateResult = new Date(Date.UTC(2026, 7, 16));
    assert.equal(isoDate({ formula: '=E2+7', result: dateResult }), '2026-08-16');
    assert.equal(isoTime({ formula: '=E2+7', result: 0.5625 }), '13:30');
  });
});

describe('GroundLedger — untimed-owns-the-whole-day clash semantics', () => {
  test('an untimed booking blocks a later timed check on the same ground/date', () => {
    const ledger = new GroundLedger();
    ledger.book('Chatsworth Oval', '2026-09-01', undefined, {
      seriesId: 's1',
      fixtureId: 'f1',
      date: '2026-09-01',
    });
    const clash = ledger.check('Chatsworth Oval', '2026-09-01', '10:00');
    assert.ok(clash, 'a timed fixture must clash with an untimed booking that day');
    assert.equal(clash.seriesId, 's1');
  });

  test('a timed booking blocks a later untimed check on the same ground/date', () => {
    const ledger = new GroundLedger();
    ledger.book('Chatsworth Oval', '2026-09-01', '10:00', {
      seriesId: 's1',
      fixtureId: 'f1',
      date: '2026-09-01',
      time: '10:00',
    });
    const clash = ledger.check('Chatsworth Oval', '2026-09-01', undefined);
    assert.ok(
      clash,
      'an untimed fixture owns the whole ground-day and must clash with any existing booking',
    );
  });

  test('two distinct times on the same ground/date do not clash', () => {
    const ledger = new GroundLedger();
    ledger.book('Chatsworth Oval', '2026-09-01', '10:00', {
      seriesId: 's1',
      fixtureId: 'f1',
      date: '2026-09-01',
      time: '10:00',
    });
    assert.equal(ledger.check('Chatsworth Oval', '2026-09-01', '11:00'), undefined);
  });

  test('the same date/time on two different grounds does not clash', () => {
    const ledger = new GroundLedger();
    ledger.book('Chatsworth Oval', '2026-09-01', '10:00', {
      seriesId: 's1',
      fixtureId: 'f1',
      date: '2026-09-01',
      time: '10:00',
    });
    assert.equal(ledger.check('Kingsmead Oval', '2026-09-01', '10:00'), undefined);
  });
});

describe('assertDeleteSet — subset safety rail', () => {
  test('the exact expected set is accepted', () => {
    const existingIds = [...DELETE_SLUGS, KEEP_SLUG].map((s) => `${ID_PREFIX}${s}`);
    const stale = assertDeleteSet(existingIds, new Set());
    assert.deepEqual([...stale].sort(), [...DELETE_SLUGS].sort());
  });

  test('a proper subset (post-prune re-run, or some already overwritten this run) is accepted', () => {
    const remaining = DELETE_SLUGS.slice(0, 2);
    const existingIds = [...remaining, KEEP_SLUG].map((s) => `${ID_PREFIX}${s}`);
    const stale = assertDeleteSet(existingIds, new Set());
    assert.deepEqual(stale.sort(), [...remaining].sort());
  });

  test('an empty set (all superseded series already pruned) is accepted', () => {
    const existingIds = [KEEP_SLUG].map((s) => `${ID_PREFIX}${s}`);
    const stale = assertDeleteSet(existingIds, new Set());
    assert.deepEqual(stale, []);
  });

  test('a stale slug outside the expected set throws', () => {
    const existingIds = [`${ID_PREFIX}some-unrelated-series`];
    assert.throws(() => assertDeleteSet(existingIds, new Set()));
  });

  test('a KEEP_LIST slug is never returned, even when present', () => {
    const existingIds = [`${ID_PREFIX}${KEEP_SLUG}`, `${ID_PREFIX}${DELETE_SLUGS[0]}`];
    const stale = assertDeleteSet(existingIds, new Set());
    assert.ok(!stale.includes(KEEP_SLUG));
    assert.deepEqual(stale, [DELETE_SLUGS[0]]);
  });
});

describe('normalise / redirectedNormalise / pairKey — cross-file name matching', () => {
  test('stopwords and team-suffix tokens are dropped', () => {
    assert.equal(normalise('Amanzimtoti CC 1st XI'), 'amanzimtoti');
    assert.equal(normalise('Tongaat Cricket Association'), 'tongaat');
  });

  test('distinguishing words survive — Sporting and United must not collide', () => {
    assert.notEqual(normalise('Chatsworth Sporting CC'), normalise('Chatsworth United'));
    assert.notEqual(normalise('Spartan Sporting'), normalise('Chatsworth Sporting'));
  });

  test('redirects collapse sheet typos and cross-file spellings to one canonical form', () => {
    assert.equal(
      redirectedNormalise('Chatsworthh United'),
      redirectedNormalise('Chatsworth United'),
    );
    assert.equal(redirectedNormalise('Illembe'), redirectedNormalise('ilembe'));
    assert.equal(redirectedNormalise('RHYTHM DHSOB 1st XI'), redirectedNormalise('Rhythm DHS'));
    assert.equal(
      redirectedNormalise('Hollywoodbets Crusaders 1st XI'),
      redirectedNormalise('Crusaders'),
    );
    assert.equal(
      redirectedNormalise('Harlequins CC DBN 1st XI'),
      redirectedNormalise('Harlequins'),
    );
  });

  test('pairKey is order-independent and redirect-aware — the cross-file venue-merge premise', () => {
    assert.equal(pairKey('UKZN', 'Delta'), pairKey('Delta', 'UKZN'));
    assert.equal(
      pairKey('Harlequins CC DBN 1st XI', 'Southern Natal CC 1st XI'),
      pairKey('Southern Natal', 'Harlequins'),
    );
    assert.notEqual(pairKey('UKZN', 'Delta'), pairKey('UKZN', 'Umzinto'));
  });
});

// ── parseWorkbook fixtures ──
// Excel serialises a date cell as UTC-midnight and a bare time as a 1899-12-30 epoch
// Date; these two helpers mirror that exactly (isoDate/isoTime tell them apart by year).
function dateCell(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}
function timeCell(h: number, m: number): Date {
  return new Date(Date.UTC(1899, 11, 30, h, m));
}

// parseWorkbook throws if any of the six manifest sheets is missing, so every workbook
// carries all six — trailing spaces on the real names included.
const SHEET_NAMES = [
  'Premier Men ',
  'Promotion Men ',
  'Premier Women ',
  'Promotion Women',
  'Veterans Premier',
  'Veterans Promotion',
];

/** A row as a 1-based column→value map, empties everywhere else. */
function cells(map: Record<number, unknown>): unknown[] {
  const nums = Object.keys(map).map(Number);
  const max = nums.length ? Math.max(...nums) : 0;
  const arr: unknown[] = new Array(max).fill(null);
  for (const n of nums) arr[n - 1] = map[n];
  return arr;
}

function makeWorkbook(rowsBySheet: Record<string, unknown[][]>): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  for (const name of SHEET_NAMES) {
    const ws = wb.addWorksheet(name);
    for (const row of rowsBySheet[name.trim()] ?? []) ws.addRow(row as ExcelJS.CellValue[]);
  }
  return wb;
}

describe('parseWorkbook — narrow sheet', () => {
  test('a bare "T20 Premier Women Group 2" header (no womens) slugs to g2, with round/date/time running', () => {
    const wb = makeWorkbook({
      'Premier Women': [
        cells({ 1: 'T20 Premier Women Group 2' }),
        cells({ 1: 'Week 1' }),
        cells({ 1: 'Home1', 3: 'v', 4: 'Away1', 5: dateCell(2026, 9, 5), 6: timeCell(9, 0) }),
        cells({ 5: dateCell(2026, 9, 6) }), // date-only row → resets running time to null
        cells({ 1: 'Home2', 3: 'v', 4: 'Away2' }), // inherits the date, no time
        cells({ 6: timeCell(10, 0) }), // time-only row sets a new running time
        cells({ 1: 'Home3', 3: 'v', 4: 'Away3' }),
      ],
    });
    const { sections, orphans } = parseWorkbook(wb);
    assert.equal(orphans.length, 0);
    assert.equal(sections.length, 1);
    const g2 = sections[0];
    assert.equal(g2.spec.slug, 'premier-women-t20-g2');
    assert.equal(g2.fixtures.length, 3);
    assert.deepEqual(g2.fixtures[0], {
      round: 1,
      date: '2026-09-05',
      time: '09:00',
      homeName: 'Home1',
      awayName: 'Away1',
    });
    assert.equal(g2.fixtures[1].date, '2026-09-06');
    assert.equal(g2.fixtures[1].time, undefined); // the date-without-time row cleared it
    assert.equal(g2.fixtures[2].date, '2026-09-06');
    assert.equal(g2.fixtures[2].time, '10:00');
  });

  test('the legacy "T20 Womens Premier Women Group 2" header still matches', () => {
    const wb = makeWorkbook({
      'Premier Women': [
        cells({ 1: 'T20 Womens Premier Women Group 2' }),
        cells({ 1: 'Week 1' }),
        cells({ 1: 'HomeL', 3: 'v', 4: 'AwayL', 5: dateCell(2026, 9, 5) }),
      ],
    });
    const { sections } = parseWorkbook(wb);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].spec.slug, 'premier-women-t20-g2');
    assert.equal(sections[0].fixtures.length, 1);
  });
});

describe('parseWorkbook — wide Promotion Women', () => {
  const SAT = [
    dateCell(2026, 10, 24),
    dateCell(2026, 11, 21),
    dateCell(2027, 1, 23),
    dateCell(2027, 2, 20),
  ];
  const SUN = [
    dateCell(2026, 10, 25),
    dateCell(2026, 11, 22),
    dateCell(2027, 1, 24),
    dateCell(2027, 2, 21),
  ];
  const BASES = [1, 7, 13, 19];
  // Same logical content in every 6-wide block (Series 1–4), with per-block dates.
  const wideRow = (
    perBlock: (i: number, base: number) => Record<number, unknown>,
    extra: Record<number, unknown> = {},
  ): unknown[] => {
    const map: Record<number, unknown> = { ...extra };
    BASES.forEach((base, i) => Object.assign(map, perBlock(i, base)));
    return cells(map);
  };

  const wb = makeWorkbook({
    'Promotion Women': [
      wideRow((i, base) => ({ [base]: `Series ${i + 1}` })),
      // cols 25–27 are team-list metadata: outside every block window, must be ignored.
      wideRow((_i, base) => ({ [base]: 'T20 Group A' }), {
        25: 'MetaTeam',
        26: 'v',
        27: 'MetaTeam2',
      }),
      wideRow((i, base) => ({ [base + 4]: SAT[i] })),
      wideRow((_i, base) => ({
        [base]: 'GA-home',
        [base + 2]: 'v',
        [base + 3]: timeCell(9, 0),
        [base + 4]: 'GA-away',
      })),
      wideRow((_i, base) => ({ [base]: 'T20 Group B' })),
      wideRow((_i, base) => ({ [base]: 'Week 1' })),
      wideRow((i, base) => ({ [base + 4]: SAT[i] })),
      wideRow((_i, base) => ({
        [base]: 'GB-home',
        [base + 2]: 'v',
        [base + 3]: timeCell(9, 0),
        [base + 4]: 'GB-away',
      })),
      wideRow((_i, base) => ({ [base]: 'Week 2' })),
      wideRow((i, base) => ({ [base + 4]: SUN[i] })),
      wideRow((_i, base) => ({
        [base]: 'GB2-home',
        [base + 2]: 'v',
        [base + 3]: timeCell(11, 0),
        [base + 4]: 'GB2-away',
      })),
    ],
  });
  const { sections, orphans } = parseWorkbook(wb);
  const ga = sections.find((s) => s.spec.slug === 'promotion-women-t20-ga')!;
  const gb = sections.find((s) => s.spec.slug === 'promotion-women-t20-gb')!;

  test('one section per group, no orphans or fixtures from the metadata columns', () => {
    assert.equal(orphans.length, 0);
    assert.equal(sections.length, 2);
    assert.ok(ga && gb);
    assert.equal(ga.fixtures.length, 4); // one per block
    assert.equal(gb.fixtures.length, 8); // two per block
  });

  test('the group spec still expects 40 (4 blocks × 10)', () => {
    assert.equal(ga.spec.expected, 40);
  });

  test('round is the block index, and Group B "Week 2" rows stay round 1 in block 1', () => {
    assert.deepEqual(
      ga.fixtures.map((f) => f.round),
      [1, 2, 3, 4],
    );
    // Block 1 holds a "Week 1" and a "Week 2" fixture — both must be round 1.
    assert.equal(gb.fixtures[0].round, 1);
    assert.equal(gb.fixtures[0].date, '2026-10-24');
    assert.equal(gb.fixtures[1].round, 1);
    assert.equal(gb.fixtures[1].date, '2026-10-25');
  });

  test('fixtures are ordered chronologically by (round, date) across blocks', () => {
    assert.deepEqual(
      ga.fixtures.map((f) => f.date),
      ['2026-10-24', '2026-11-21', '2027-01-23', '2027-02-20'],
    );
    assert.deepEqual(
      gb.fixtures.map((f) => f.round),
      [1, 1, 2, 2, 3, 3, 4, 4],
    );
    assert.deepEqual(
      gb.fixtures.map((f) => f.date),
      [
        '2026-10-24',
        '2026-10-25',
        '2026-11-21',
        '2026-11-22',
        '2027-01-23',
        '2027-01-24',
        '2027-02-20',
        '2027-02-21',
      ],
    );
  });
});

describe('parseWorkbook — orphan detection', () => {
  test('a fixture row under an unknown header is one orphan naming the sheet', () => {
    const wb = makeWorkbook({
      'Premier Men': [
        cells({ 1: 'Some Unknown Header' }),
        cells({ 1: 'HomeO', 3: 'v', 4: 'AwayO' }),
      ],
    });
    const { sections, orphans } = parseWorkbook(wb);
    assert.equal(sections.length, 0);
    assert.equal(orphans.length, 1);
    assert.match(orphans[0], /Premier Men/);
    assert.doesNotMatch(orphans[0], /\[block/); // narrow sheet — no block prefix
  });
});

describe('parseWorkbook — narrow-sheet regressions', () => {
  test('a "Series 2" banner still sets round 2 on a narrow sheet', () => {
    const wb = makeWorkbook({
      'Premier Women': [
        cells({ 1: 'T20 Premier Women Group 2' }),
        cells({ 1: 'Series 2' }),
        cells({ 1: 'HomeS', 3: 'v', 4: 'AwayS', 5: dateCell(2026, 9, 5) }),
      ],
    });
    const { sections } = parseWorkbook(wb);
    assert.equal(sections[0].fixtures.length, 1);
    assert.equal(sections[0].fixtures[0].round, 2);
  });

  test('a text time cell in column D is not swallowed as the away name', () => {
    const wb = makeWorkbook({
      'Premier Women': [
        cells({ 1: 'T20 Premier Women Group 2' }),
        cells({ 1: 'Week 1' }),
        cells({ 1: 'HomeT', 3: 'v', 4: '13:00', 5: 'RealAway', 6: dateCell(2026, 9, 5) }),
      ],
    });
    const { sections } = parseWorkbook(wb);
    const f = sections[0].fixtures[0];
    assert.equal(f.awayName, 'RealAway');
    assert.equal(f.time, '13:00');
  });
});

describe('GroundLedger — multi-surface capacity (registry-resolved grounds)', () => {
  const twoSurfaces = () => new GroundLedger(() => ({ key: 'v:chatsworth-oval', capacity: 2 }));

  test('a 2-surface ground hosts two same-slot fixtures and blocks the third', () => {
    const ledger = twoSurfaces();
    ledger.book('Chatsworth Oval', '2026-09-01', '13:00', {
      seriesId: 's1',
      fixtureId: 'f1',
      date: '2026-09-01',
      time: '13:00',
    });
    assert.equal(ledger.check('Chatsworth Oval', '2026-09-01', '13:00'), undefined);
    ledger.book('Chatsworth Oval', '2026-09-01', '13:00', {
      seriesId: 's2',
      fixtureId: 'f1',
      date: '2026-09-01',
      time: '13:00',
    });
    assert.ok(ledger.check('Chatsworth Oval', '2026-09-01', '13:00'));
  });

  test('resolver key unifies spelling variants onto one ledger row', () => {
    const ledger = new GroundLedger(() => ({ key: 'v:chatsworth-oval', capacity: 1 }));
    ledger.book('Chatsworth Cricket Oval', '2026-09-01', '13:00', {
      seriesId: 's1',
      fixtureId: 'f1',
      date: '2026-09-01',
      time: '13:00',
    });
    assert.ok(ledger.check('CHATSWORTH OVAL', '2026-09-01', '13:00'));
  });

  test('an untimed booking consumes one of two surfaces, not the whole ground', () => {
    const ledger = twoSurfaces();
    ledger.book('Chatsworth Oval', '2026-09-01', undefined, {
      seriesId: 's1',
      fixtureId: 'f1',
      date: '2026-09-01',
    });
    assert.equal(ledger.check('Chatsworth Oval', '2026-09-01', '13:00'), undefined);
  });
});

describe('computeSameClubSlotOverlaps — same-club same-slot detection', () => {
  // A club id shared across two DIFFERENT series (different squads) at the exact same
  // slot is the informational case; the same club twice in ONE series is the loud one.
  test('a club id in two different series at the same date+time is a cross-series overlap', () => {
    const { crossSeries, sameSeries } = computeSameClubSlotOverlaps([
      {
        slug: 'premier-women-t20-g1',
        participants: [
          { teamId: 'tm_chats_pw_0', clubId: 'chatsworth-sporting' },
          { teamId: 'tm_opp1', clubId: 'opp-one' },
        ],
        fixtures: [
          { id: 'f1', date: '2026-09-27', time: '09:00', home: 'tm_chats_pw_0', away: 'tm_opp1' },
        ],
      },
      {
        slug: 'premier-men-t20-2',
        participants: [
          { teamId: 'tm_chats_pm_0', clubId: 'chatsworth-sporting' },
          { teamId: 'tm_opp2', clubId: 'opp-two' },
        ],
        fixtures: [
          { id: 'f2', date: '2026-09-27', time: '09:00', home: 'tm_chats_pm_0', away: 'tm_opp2' },
        ],
      },
    ]);
    assert.equal(sameSeries.length, 0, 'not a same-series double-booking');
    assert.equal(crossSeries.length, 1);
    const o = crossSeries[0];
    assert.equal(o.clubId, 'chatsworth-sporting');
    assert.equal(o.date, '2026-09-27');
    assert.equal(o.time, '09:00');
    assert.deepEqual(
      o.entries.map((e) => `${e.seriesSlug}/${e.fixtureId} v ${e.opponent}`),
      ['premier-men-t20-2/f2 v opp-two', 'premier-women-t20-g1/f1 v opp-one'],
    );
  });

  test('a club playing twice in ONE series in one slot is flagged as a same-series double-booking', () => {
    const { crossSeries, sameSeries } = computeSameClubSlotOverlaps([
      {
        slug: 'premier-men-t20-1',
        participants: [
          { teamId: 'tm_a', clubId: 'club-a' },
          { teamId: 'tm_b', clubId: 'club-b' },
          { teamId: 'tm_c', clubId: 'club-c' },
        ],
        fixtures: [
          // club-a is home in f1 and away in f2, same date+time → double-booked.
          { id: 'f1', date: '2026-10-04', time: '10:30', home: 'tm_a', away: 'tm_b' },
          { id: 'f2', date: '2026-10-04', time: '10:30', home: 'tm_c', away: 'tm_a' },
        ],
      },
    ]);
    assert.equal(crossSeries.length, 0, 'only one series involved — not cross-series');
    const doubled = sameSeries.find((o) => o.clubId === 'club-a');
    assert.ok(doubled, 'club-a is reported as double-booked');
    assert.deepEqual(
      doubled!.entries.map((e) => `${e.seriesSlug}/${e.fixtureId} v ${e.opponent}`),
      ['premier-men-t20-1/f1 v club-b', 'premier-men-t20-1/f2 v club-c'],
    );
  });

  test('an untimed fixture never overlaps a timed one at the same club/date', () => {
    const { crossSeries, sameSeries } = computeSameClubSlotOverlaps([
      {
        slug: 'series-timed',
        participants: [
          { teamId: 'tm_a', clubId: 'club-a' },
          { teamId: 'tm_b', clubId: 'club-b' },
        ],
        fixtures: [{ id: 'f1', date: '2026-09-27', time: '09:00', home: 'tm_a', away: 'tm_b' }],
      },
      {
        slug: 'series-untimed',
        participants: [
          { teamId: 'tm_a2', clubId: 'club-a' },
          { teamId: 'tm_c', clubId: 'club-c' },
        ],
        // No time → dropped from the slot keying entirely.
        fixtures: [{ id: 'f9', date: '2026-09-27', home: 'tm_a2', away: 'tm_c' }],
      },
    ]);
    assert.equal(crossSeries.length, 0);
    assert.equal(sameSeries.length, 0);
  });

  test('the same club at two DIFFERENT times on the same date does not overlap', () => {
    const { crossSeries, sameSeries } = computeSameClubSlotOverlaps([
      {
        slug: 'series-x',
        participants: [
          { teamId: 'tm_a', clubId: 'club-a' },
          { teamId: 'tm_b', clubId: 'club-b' },
        ],
        fixtures: [{ id: 'f1', date: '2026-09-27', time: '09:00', home: 'tm_a', away: 'tm_b' }],
      },
      {
        slug: 'series-y',
        participants: [
          { teamId: 'tm_a2', clubId: 'club-a' },
          { teamId: 'tm_c', clubId: 'club-c' },
        ],
        fixtures: [{ id: 'f2', date: '2026-09-27', time: '13:30', home: 'tm_a2', away: 'tm_c' }],
      },
    ]);
    assert.equal(crossSeries.length, 0);
    assert.equal(sameSeries.length, 0);
  });

  test('legacy series (no participants) resolve sides by clubId directly', () => {
    const { crossSeries } = computeSameClubSlotOverlaps([
      {
        // Legacy: home/away ARE club ids, no participants snapshot.
        slug: 'legacy-league',
        fixtures: [{ id: 'f1', date: '2026-09-27', time: '09:00', home: 'club-a', away: 'club-z' }],
      },
      {
        slug: 'premier-men-t20-2',
        participants: [
          { teamId: 'tm_a', clubId: 'club-a' },
          { teamId: 'tm_b', clubId: 'club-b' },
        ],
        fixtures: [{ id: 'f2', date: '2026-09-27', time: '09:00', home: 'tm_a', away: 'tm_b' }],
      },
    ]);
    assert.equal(crossSeries.length, 1, 'club-a resolved from the legacy series by clubId');
    assert.equal(crossSeries[0].clubId, 'club-a');
    assert.deepEqual(
      crossSeries[0].entries.map((e) => `${e.seriesSlug}/${e.fixtureId} v ${e.opponent}`),
      ['legacy-league/f1 v club-z', 'premier-men-t20-2/f2 v club-b'],
    );
  });
});
