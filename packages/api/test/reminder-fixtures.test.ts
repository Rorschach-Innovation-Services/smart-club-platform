/**
 * Unit tests for reminder-fixtures.ts: the reminder-sheet parser (against a generated
 * workbook mirroring the real KZNCU/EMCU layouts), the competition-scoped matcher and its
 * adversarial cases, and the planner's gate + planHash. Pure — no repo, no DynamoDB; the
 * real clash detector, ledger and patch planner run underneath.
 *
 * The sample workbook (test/data/reminder-fixtures/reminder-fixtures-sample.xlsx) was
 * generated with exceljs to the 7 Oct 2026 KZNCU + EMCU shapes: two competitions in one
 * sheet with Group sections, a mid-block time restatement, raw Excel serial/fraction cells,
 * a per-row "Time:" column, the Promotion layout ('v' in column B + a group legend), merged
 * EMCU headings with a "Venue Changes:" column, a notes sheet and two broken-layout sheets.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  cellDate,
  cellTime,
  competitionKey,
  matchReminderRows,
  parseReminderArgs,
  parseReminderGrids,
  parseReminderWorkbook,
  planReminderAmendments,
  reminderPreview,
  seriesForCompetition,
  writeReminderPlan,
  type ParsedReminderWorkbook,
  type ReminderRow,
} from '../src/reminder-fixtures.js';
import { DEFAULT_VENUE_ALIASES } from '../src/venue-clash.js';
import type { Club, Series, Venue } from '../src/types.js';

const SAMPLE = fileURLToPath(
  new URL('./data/reminder-fixtures/reminder-fixtures-sample.xlsx', import.meta.url),
);
const SAT = '2026-10-10';
const SUN = '2026-10-11';
const aliases = DEFAULT_VENUE_ALIASES;

// ─────────────────────────────── parser ───────────────────────────────

describe('reminder parser — cell values', () => {
  test('Excel serials, day fractions, exceljs Dates and text all read', () => {
    assert.equal(cellDate(46305), '2026-10-10');
    assert.equal(cellDate(46305.5417), '2026-10-10');
    assert.equal(cellDate(new Date('2026-10-11T00:00:00Z')), SUN);
    assert.equal(cellDate('11/10/2026'), SUN);
    assert.equal(cellDate(0.5417), undefined, 'a fraction is a time, not a date');
    assert.equal(cellDate(new Date(Date.UTC(1899, 11, 30, 13))), undefined);
    assert.equal(cellTime(0.5417), '13:00');
    assert.equal(cellTime(0.5625), '13:30');
    assert.equal(cellTime(new Date(Date.UTC(1899, 11, 30, 9, 0))), '09:00');
    assert.equal(cellTime('13:00'), '13:00');
    assert.equal(cellTime('9h30'), '09:30');
    assert.equal(cellTime(46305), undefined, 'a serial is a date, not a time');
    assert.equal(cellTime('Reminder Fixtures: 10th & 11th October 2026'), undefined);
    assert.equal(cellTime('25:00'), undefined);
  });

  test('a combined date+time cell yields BOTH the date and the time', () => {
    const dt = new Date(Date.UTC(2026, 9, 11, 13, 30));
    assert.equal(cellDate(dt), SUN);
    assert.equal(cellTime(dt), '13:30');
    assert.equal(cellTime(new Date(Date.UTC(2026, 9, 11))), undefined, 'midnight = date only');
    assert.equal(cellDate(46306.5625), SUN);
    assert.equal(cellTime(46306.5625), '13:30');
    assert.equal(cellTime(46306), undefined, 'a whole serial has no time');
    assert.equal(cellTime(1234.5), undefined, 'outside the serial range: neither');
  });
});

describe('reminder parser — sample workbook', async () => {
  const parsed = await parseReminderWorkbook(readFileSync(SAMPLE));
  const row = (id: string) => parsed.rows.find((r) => r.rowId === id)!;

  test('every accepted sheet reports its v column; notes are empty; broken layouts refused', () => {
    const by = Object.fromEntries(parsed.sheets.map((s) => [s.sheet, s]));
    assert.equal(by['Veterans Reminder Fixtures'].status, 'ok');
    assert.equal(by['Premier Men Reminder Fixtures'].vColumn, 3);
    assert.equal(by['Promotion Men Reminder Fixtures'].vColumn, 2);
    assert.equal(by['SUNDAY EMCU FIXTURES'].status, 'ok');
    assert.equal(by['Notes'].status, 'empty');
    assert.equal(by['Broken Layout'].status, 'refused');
    assert.match(by['Broken Layout'].reason!, /'v' column varies/);
    assert.equal(by['Mostly Junk'].status, 'refused');
    assert.match(by['Mostly Junk'].reason!, /only 1 of 3/);
    // Refused sheets contribute no rows at all.
    assert.ok(!parsed.rows.some((r) => r.sheet === 'Broken Layout' || r.sheet === 'Mostly Junk'));
    assert.equal(parsed.rows.length, 13);
  });

  test('two competitions in one sheet, each with its groups; names trimmed', () => {
    assert.deepEqual(
      { ...row('Veterans Reminder Fixtures:7') },
      {
        rowId: 'Veterans Reminder Fixtures:7',
        sheet: 'Veterans Reminder Fixtures',
        sheetRow: 7,
        competition: 'Veterans Premier',
        group: 'A',
        home: 'Alpha',
        away: 'Beta',
        date: SAT,
        time: '13:00',
        venue: 'Alpha Oval',
      },
    );
    assert.equal(row('Veterans Reminder Fixtures:11').group, 'B');
    assert.equal(row('Veterans Reminder Fixtures:11').venue, 'Gamma Field');
    assert.equal(row('Veterans Reminder Fixtures:19').competition, 'Veterans Promotion');
    assert.equal(row('Veterans Reminder Fixtures:19').home, 'Alpha B');
  });

  test('raw serial date + fraction header, mid-block time restatement, postponed marker', () => {
    assert.equal(row('Premier Men Reminder Fixtures:7').date, SUN);
    assert.equal(row('Premier Men Reminder Fixtures:7').time, '09:00');
    assert.equal(row('Premier Men Reminder Fixtures:10').time, '13:30');
    const p = row('Premier Men Reminder Fixtures:11');
    assert.equal(p.postponed, true);
    assert.equal(p.venue, '', 'the POSTPONED marker is not a ground');
  });

  test('per-row Time: column (Date and text cells)', () => {
    assert.equal(row('Premier Women Reminder Fixtures:7').time, '09:00');
    assert.equal(row('Premier Women Reminder Fixtures:8').time, '13:00');
  });

  test("Promotion layout: 'v' in column B, venue column E, legend ignored, TBC venue blank", () => {
    const r = row('Promotion Men Reminder Fixtures:6');
    assert.equal(r.home, 'Beta');
    assert.equal(r.away, 'Alpha');
    assert.equal(r.venue, 'Neutral Ground');
    assert.equal(r.competition, 'Promotion Men');
    assert.equal(r.group, undefined);
    assert.equal(row('Promotion Men Reminder Fixtures:7').venue, '');
  });

  test('EMCU: merged headings name the competition, text time, Venue Changes wins', () => {
    const r = row('SUNDAY EMCU FIXTURES:5');
    assert.equal(r.competition, 'EMCU Division 1');
    assert.equal(r.time, '09:00');
    assert.equal(r.venue, 'Neutral Ground');
    assert.equal(row('SUNDAY EMCU FIXTURES:6').venue, 'Beta Park');
  });
});

describe('reminder parser — grid edge cases', () => {
  const grid = (rows: unknown[][]) =>
    parseReminderGrids([
      { name: 'S', rows: rows.map((r, i) => ({ row: i + 1, cells: [undefined, ...r] })) },
    ]);

  test('a fixture row before any dated block header is unrecognised, not guessed', () => {
    const p = grid([
      ['Alpha', '', 'v', '', 'Beta', 'Beta Park'],
      ['Week 1', '', '', 0.375, 46306, 'Venue:'],
      ['Gamma', '', 'v', '', 'Delta', 'Gamma Field'],
      ['Beta', '', 'v', '', 'Alpha', 'Alpha Oval'],
      ['Delta', '', 'v', '', 'Gamma', 'Gamma Field'],
    ]);
    assert.equal(p.sheets[0].status, 'ok');
    assert.equal(p.rows.length, 3);
    assert.equal(p.skippedRows[0].sheetRow, 1);
    assert.match(p.skippedRows[0].reason, /before any dated/);
  });

  test('a datetime block header (one cell) sets both the block date and time', () => {
    const p = grid([
      ['Week 1', '', '', '', new Date(Date.UTC(2026, 9, 11, 13, 30)), 'Venue:'],
      ['Alpha', '', 'v', '', 'Beta', 'Beta Park'],
      ['Week 2', '', '', '', 46313.375, 'Venue:'],
      ['Gamma', '', 'v', '', 'Delta', 'Gamma Field'],
    ]);
    assert.equal(p.sheets[0].status, 'ok');
    assert.deepEqual(
      p.rows.map((r) => [r.date, r.time]),
      [
        [SUN, '13:30'],
        ['2026-10-18', '09:00'],
      ],
    );
  });

  test('a sheet without a heading takes its competition from the sheet name', () => {
    const p = parseReminderGrids([
      {
        name: 'Premier Men Reminder Fixtures',
        rows: [
          { row: 1, cells: [undefined, 'Week 1', '', '', 0.375, 46306, 'Venue:'] },
          { row: 2, cells: [undefined, 'Alpha', '', 'v', '', 'Beta', 'Beta Park'] },
        ],
      },
    ]);
    assert.equal(p.rows[0].competition, 'Premier Men');
  });

  test('cancelled marker in a note column flags the row', () => {
    const p = grid([
      ['Week 1', '', '', 0.375, 46306, 'Venue:', 'Note'],
      ['Alpha', '', 'v', '', 'Beta', 'Beta Park', 'Match cancelled'],
    ]);
    assert.equal(p.rows[0].cancelled, true);
    assert.equal(p.rows[0].venue, 'Beta Park');
  });
});

// ─────────────────────────────── world ───────────────────────────────

const clubs = [
  { id: 'alpha', name: 'Alpha CC', ground: { venue: 'Alpha Oval' } },
  { id: 'beta', name: 'Beta CC', ground: { venue: 'Beta Park' } },
  { id: 'gamma', name: 'Gamma CC', ground: { venue: 'Gamma Field' } },
  { id: 'delta', name: 'Delta CC', ground: { venue: 'Delta Fields', secondaryVenue: 'Delta 2' } },
] as unknown as Club[];

const venues: Venue[] = [
  { id: 'v-alpha', name: 'Alpha Oval', homeClubIds: ['alpha'] },
  { id: 'v-alpha2', name: 'Alpha 2', homeClubIds: ['alpha'] },
  { id: 'v-beta', name: 'Beta Park', homeClubIds: ['beta'] },
  { id: 'v-gamma', name: 'Gamma Field', homeClubIds: ['gamma'] },
  { id: 'v-delta', name: 'Delta Fields', homeClubIds: ['delta'] },
  { id: 'v-delta2', name: 'Delta 2', homeClubIds: ['delta'] },
  { id: 'v-neutral', name: 'Neutral Ground', homeClubIds: [] },
];

interface Fx {
  id: string;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  status?: string;
  originalDate?: string;
  venueId?: string;
  venueName?: string;
  venueOverride?: string;
  result?: unknown;
  [k: string]: unknown;
}

const participants = ['alpha', 'beta', 'gamma', 'delta'].map((id) => ({
  teamId: id,
  clubId: id,
  name: `${id[0].toUpperCase()}${id.slice(1)} CC`,
}));

function series(id: string, name: string, released: boolean, fixtures: Fx[]): Series {
  return {
    id,
    name,
    startDate: SAT,
    teams: participants.map((p) => p.teamId),
    participants,
    fixtures,
    released,
    releasedAt: released ? '2026-09-01T00:00:00.000Z' : null,
    version: 3,
  } as unknown as Series;
}

/** Premier League (released): the Premier Men sheet rows. f5 = the SAME pairing as the
 * veterans fixture, on the same Saturday — the scoping trap. */
const premier = (over: Partial<Record<string, Partial<Fx>>> = {}) =>
  series(
    's-prem',
    'Premier League · T20 · Group 1',
    true,
    [
      {
        id: 'f1',
        date: SUN,
        time: '09:00',
        home: 'alpha',
        away: 'beta',
        venueId: 'v-beta',
        venueName: 'Beta Park',
      },
      {
        id: 'f2',
        date: SUN,
        time: '13:30',
        home: 'gamma',
        away: 'delta',
        venueName: 'Gamma Field',
      },
      { id: 'f3', date: SUN, time: '13:30', home: 'beta', away: 'gamma', venueName: 'Beta Park' },
      {
        id: 'f4',
        date: SUN,
        time: '13:30',
        home: 'delta',
        away: 'alpha',
        venueName: 'Delta Fields',
      },
      { id: 'f5', date: SAT, time: '13:00', home: 'alpha', away: 'beta', venueName: 'Alpha 2' },
    ].map((f) => ({ ...f, ...(over[f.id] ?? {}) })) as Fx[],
  );

const veterans = () =>
  series('s-vet', 'Veterans Premier · T20 · Group 1', true, [
    { id: 'f1', date: SAT, time: '13:00', home: 'alpha', away: 'beta', venueName: 'Beta Park' },
  ]);

const rowOf = (over: Partial<ReminderRow>): ReminderRow => ({
  rowId: `S:${over.sheetRow ?? 1}`,
  sheet: 'S',
  sheetRow: 1,
  competition: 'Premier Men',
  home: 'Alpha',
  away: 'Beta',
  date: SUN,
  time: '09:00',
  venue: 'Beta Park',
  ...over,
});

const match = (rows: ReminderRow[], all: Series[], playedRefs?: Set<string>) =>
  matchReminderRows(rows, all, clubs, venues, aliases, { playedRefs }).matches;

// ─────────────────────────────── matcher ───────────────────────────────

describe('competition scoping', () => {
  test('labels map to league names by token set, never across competitions', () => {
    assert.equal(competitionKey('Premier Men'), competitionKey('Premier League'));
    assert.equal(competitionKey('Premier Women'), competitionKey('Premier Women’s League'));
    assert.notEqual(competitionKey('Premier Men'), competitionKey('Veterans Premier'));
    const all = [premier(), veterans()];
    assert.deepEqual(
      seriesForCompetition('Premier Men', all).map((s) => s.id),
      ['s-prem'],
    );
    assert.deepEqual(
      seriesForCompetition('Veterans Premier', all).map((s) => s.id),
      ['s-vet'],
    );
    const emcu = series('s-e3', 'EMCU Division 3 · Stream 1 · EMCU Division 2', false, []);
    assert.deepEqual(
      seriesForCompetition('EMCU Division 3 – Stream 1', [emcu]).map((s) => s.id),
      ['s-e3'],
    );
    assert.deepEqual(seriesForCompetition('EMCU Division 5 – Stream 1', [emcu]), []);
  });

  test('same pairing in two competitions on the sheet date: each row hits its own', () => {
    const all = [premier(), veterans()];
    const [vet, prem] = match(
      [
        rowOf({
          sheetRow: 1,
          competition: 'Veterans Premier',
          date: SAT,
          time: '13:00',
          venue: 'Beta Park',
        }),
        rowOf({
          sheetRow: 2,
          competition: 'Premier Men',
          date: SAT,
          time: '13:00',
          venue: 'Alpha 2',
        }),
      ],
      all,
    );
    assert.equal(vet.seriesId, 's-vet');
    assert.equal(vet.outcome, 'matched-no-change');
    assert.equal(prem.seriesId, 's-prem');
    assert.equal(prem.fixtureId, 'f5');
    assert.equal(prem.outcome, 'matched-no-change');
  });

  test('an unmappable competition is refused, never matched tenant-wide', () => {
    const [m] = match([rowOf({ competition: 'Masters League' })], [premier(), veterans()]);
    assert.equal(m.outcome, 'competition-unknown');
    assert.equal(m.entry, undefined);
  });
});

describe('matcher outcomes', () => {
  test('time and venue changes become a guarded entry with expect from live data', () => {
    const [t, v] = match(
      [
        rowOf({ sheetRow: 1, home: 'Gamma', away: 'Delta', time: '09:00', venue: 'Gamma Field' }),
        rowOf({ sheetRow: 2, home: 'Beta', away: 'Gamma', time: '13:30', venue: 'Neutral Ground' }),
      ],
      [premier()],
    );
    assert.equal(t.outcome, 'matched-change');
    assert.deepEqual(t.entry, {
      seriesId: 's-prem',
      fixtureId: 'f2',
      expect: { home: 'gamma', away: 'delta', date: SUN, time: '13:30', venue: 'Gamma Field' },
      set: { time: '09:00' },
    });
    assert.deepEqual(t.changes, [{ field: 'time', before: '13:30', after: '09:00' }]);
    assert.deepEqual(v.entry?.set, { venueId: 'v-neutral' });
    assert.deepEqual(v.changes, [{ field: 'venue', before: 'Beta Park', after: 'Neutral Ground' }]);
  });

  test('a venue named differently but resolving to the bound ground is no change', () => {
    const [m] = match([rowOf({ venue: '  beta park ' })], [premier()]);
    assert.equal(m.outcome, 'matched-no-change');
  });

  test('a stale venueId under a differing venueOverride is a change, not a no-op', () => {
    // f1 is still bound to v-beta, but its effective ground is the override.
    const all = [premier({ f1: { venueOverride: 'Neutral Ground' } })];
    const [m] = match([rowOf({ venue: 'Beta Park' })], all);
    assert.equal(m.outcome, 'matched-change');
    assert.deepEqual(m.entry?.set, { venueId: 'v-beta' });
    assert.equal(m.entry?.expect.venue, 'Neutral Ground');
    assert.deepEqual(m.changes, [{ field: 'venue', before: 'Neutral Ground', after: 'Beta Park' }]);
    // Applies cleanly through the guard.
    const rp = plan(parsedOf([rowOf({ venue: 'Beta Park' })]), all);
    assert.deepEqual(rp.plan.errors, []);
    assert.equal(rp.plan.diffs.length, 1);
  });

  test('reversed orientation matches with a warning and never swaps sides', () => {
    const [m] = match([rowOf({ home: 'Beta', away: 'Alpha', time: '10:00' })], [premier()]);
    assert.equal(m.outcome, 'matched-change');
    assert.equal(m.fixtureId, 'f1');
    assert.match(m.warnings[0], /other way round/);
    assert.deepEqual(m.entry?.set, { time: '10:00' });
  });

  test('date amendment: fallback window is ±7 days inclusive, then unmatched', () => {
    const all = [premier()];
    const [in7] = match(
      [
        rowOf({
          home: 'Gamma',
          away: 'Delta',
          date: '2026-10-18',
          time: '13:30',
          venue: 'Gamma Field',
        }),
      ],
      all,
    );
    assert.equal(in7.outcome, 'matched-change');
    assert.deepEqual(in7.entry?.set, { date: '2026-10-18' });
    const [back7] = match(
      [
        rowOf({
          home: 'Gamma',
          away: 'Delta',
          date: '2026-10-04',
          time: '13:30',
          venue: 'Gamma Field',
        }),
      ],
      all,
    );
    assert.deepEqual(back7.entry?.set, { date: '2026-10-04' });
    const [out8] = match(
      [
        rowOf({
          home: 'Gamma',
          away: 'Delta',
          date: '2026-10-19',
          time: '13:30',
          venue: 'Gamma Field',
        }),
      ],
      all,
    );
    assert.equal(out8.outcome, 'unmatched');
    assert.match(out8.reason!, /within 7 days/);
  });

  test('two candidates inside the fallback window are ambiguous', () => {
    const all = [
      premier({ f2: { date: '2026-10-08' } }),
      series('s-prem2', 'Premier League · T20 · Group 2', true, [
        { id: 'g1', date: '2026-10-14', time: '13:30', home: 'gamma', away: 'delta' },
      ]),
    ];
    const [m] = match([rowOf({ home: 'Gamma', away: 'Delta', date: SUN, venue: '' })], all);
    assert.equal(m.outcome, 'ambiguous');
    assert.match(m.reason!, /2 fixtures fit/);
  });

  test('the fallback window breaks a tie on the row time before calling it ambiguous', () => {
    const all = [
      premier({ f2: { date: '2026-10-08' } }),
      series('s-prem2', 'Premier League · T20 · Group 2', true, [
        { id: 'g1', date: '2026-10-14', time: '15:00', home: 'gamma', away: 'delta' },
      ]),
    ];
    const [m] = match(
      [rowOf({ home: 'Gamma', away: 'Delta', date: SUN, time: '15:00', venue: '' })],
      all,
    );
    assert.equal(m.outcome, 'matched-change');
    assert.equal(m.seriesId, 's-prem2');
    assert.equal(m.fixtureId, 'g1');
    assert.deepEqual(m.entry?.set, { date: SUN });
  });

  test('played fixtures are refused: completed status, an inline result, a stored result', () => {
    const all = [premier({ f2: { status: 'completed' }, f3: { result: { homeScore: '120/4' } } })];
    const [a, b, c] = match(
      [
        rowOf({ sheetRow: 1, home: 'Gamma', away: 'Delta' }),
        rowOf({ sheetRow: 2, home: 'Beta', away: 'Gamma', venue: 'Neutral Ground' }),
        rowOf({ sheetRow: 3, time: '10:00' }),
      ],
      all,
      new Set(['s-prem#f1']),
    );
    for (const m of [a, b, c]) {
      assert.equal(m.outcome, 'blocked');
      assert.match(m.reason!, /played/);
      assert.equal(m.entry, undefined);
    }
  });

  test('a cancelled fixture and a cancelled-marker row are both blocked', () => {
    const [a] = match([rowOf({ time: '10:00' })], [premier({ f1: { status: 'cancelled' } })]);
    assert.equal(a.outcome, 'blocked');
    const [b] = match([rowOf({ time: '10:00', cancelled: true })], [premier()]);
    assert.equal(b.outcome, 'blocked');
    assert.match(b.reason!, /cancel/);
  });

  test('two sheet rows on one fixture: neither applies', () => {
    const ms = match(
      [rowOf({ sheetRow: 1, time: '10:00' }), rowOf({ sheetRow: 2, home: 'Beta', away: 'Alpha' })],
      [premier()],
    );
    for (const m of ms) {
      assert.equal(m.outcome, 'ambiguous');
      assert.match(m.reason!, /2 sheet rows map to s-prem\/f1/);
      assert.equal(m.entry, undefined);
    }
  });

  test('two sheet rows asking for the SAME change on one fixture: the first applies once', () => {
    const ms = match(
      [rowOf({ sheetRow: 1, time: '10:00' }), rowOf({ sheetRow: 2, time: '10:00' })],
      [premier()],
    );
    assert.equal(ms[0].outcome, 'matched-change');
    assert.deepEqual(ms[0].entry?.set, { time: '10:00' });
    assert.equal(ms[1].outcome, 'matched-no-change');
    assert.equal(ms[1].entry, undefined);
    assert.match(ms[1].reason!, /duplicate of S:1/);
    // Identical no-change rows are no longer "ambiguous" either.
    const same = match([rowOf({ sheetRow: 1 }), rowOf({ sheetRow: 2 })], [premier()]);
    assert.deepEqual(
      same.map((m) => m.outcome),
      ['matched-no-change', 'matched-no-change'],
    );
    // Planner: one manifest entry; the preview lists the duplicate with its note.
    const rp = plan(
      parsedOf([rowOf({ sheetRow: 1, time: '10:00' }), rowOf({ sheetRow: 2, time: '10:00' })]),
      [premier()],
    );
    assert.deepEqual(rp.plan.errors, []);
    assert.equal(rp.manifest.entries.length, 1);
    assert.deepEqual(rp.appliedRowIds, ['S:1']);
    const pv = reminderPreview(rp, [premier()], clubs);
    const dup = pv.sheets[0].rows.find((r) => r.rowId === 'S:2')!;
    assert.equal(dup.outcome, 'matched-no-change');
    assert.match(dup.reason!, /duplicate/);
    assert.equal(pv.sheets[0].alreadyCorrect, 0);
  });

  test('an unknown ground skips the whole row with the raw name shown', () => {
    const [m] = match([rowOf({ venue: 'Mystery Park', time: '10:00' })], [premier()]);
    assert.equal(m.outcome, 'venue-unknown');
    assert.match(m.reason!, /"Mystery Park"/);
    assert.equal(m.entry, undefined);
  });

  test('unknown club → unmatched', () => {
    const [m] = match([rowOf({ home: 'Zulu Lions' })], [premier()]);
    assert.equal(m.outcome, 'unmatched');
    assert.match(m.reason!, /no club for: Zulu Lions/);
  });

  test('postponed: on its date → status only; on a new date → date + postponed', () => {
    const [same] = match(
      [rowOf({ home: 'Delta', away: 'Alpha', time: '13:30', venue: '', postponed: true })],
      [premier()],
    );
    assert.deepEqual(same.entry?.set, { postponed: true });
    assert.deepEqual(same.changes, [{ field: 'status', before: 'scheduled', after: 'postponed' }]);
    const [moved] = match(
      [rowOf({ home: 'Delta', away: 'Alpha', date: '2026-10-17', venue: '', postponed: true })],
      [premier()],
    );
    assert.deepEqual(moved.entry?.set, { date: '2026-10-17', postponed: true });
    // Already postponed on its date ⇒ nothing to do.
    const [again] = match(
      [rowOf({ home: 'Delta', away: 'Alpha', time: '13:30', venue: '', postponed: true })],
      [premier({ f4: { status: 'postponed' } })],
    );
    assert.equal(again.outcome, 'matched-no-change');
  });

  test('a postponed row matched via the fallback never re-dates backwards or onto originalDate', () => {
    // f4 already rescheduled from SUN to the 17th.
    const rescheduled = [
      premier({ f4: { status: 'postponed', date: '2026-10-17', originalDate: SUN } }),
    ];
    const [onOriginal] = match(
      [rowOf({ home: 'Delta', away: 'Alpha', time: '13:30', venue: '', postponed: true })],
      rescheduled,
    );
    assert.equal(onOriginal.outcome, 'matched-no-change');
    assert.equal(onOriginal.entry, undefined);
    // Earlier than the live date (not the originalDate): still no set.date.
    const moved = [
      premier({ f4: { status: 'postponed', date: '2026-10-17', originalDate: '2026-10-04' } }),
    ];
    const [earlier] = match(
      [rowOf({ home: 'Delta', away: 'Alpha', time: '13:30', venue: '', postponed: true })],
      moved,
    );
    assert.equal(earlier.outcome, 'matched-no-change');
    assert.equal(earlier.entry, undefined);
    // Re-dated (not postponed) to the 17th: listed postponed on SUN ⇒ noted, not changed.
    const [plain] = match(
      [rowOf({ home: 'Delta', away: 'Alpha', time: '13:30', venue: '', postponed: true })],
      [premier({ f4: { date: '2026-10-17' } })],
    );
    assert.equal(plain.outcome, 'matched-no-change');
    assert.equal(plain.entry, undefined);
    assert.match(plain.reason!, /already plays on 2026-10-17/);
    // Forward is still a reschedule.
    const [forward] = match(
      [rowOf({ home: 'Delta', away: 'Alpha', date: '2026-10-17', venue: '', postponed: true })],
      [premier()],
    );
    assert.deepEqual(forward.entry?.set, { date: '2026-10-17', postponed: true });
  });

  test('an undated (dateTbc) postponement listed on a new date is rescheduled; on its old date, blocked', () => {
    const all = [premier({ f4: { status: 'postponed', dateTbc: true } })];
    const [moved] = match(
      [rowOf({ home: 'Delta', away: 'Alpha', date: '2026-10-17', time: '13:30', venue: '' })],
      all,
    );
    assert.deepEqual(moved.entry?.set, { date: '2026-10-17', postponed: true });
    const [same] = match(
      [rowOf({ home: 'Delta', away: 'Alpha', time: '13:30', venue: 'Delta Fields' })],
      all,
    );
    assert.equal(same.outcome, 'blocked');
    assert.match(same.reason!, /reinstate/);
    // Planned: the new date books its slot again — dateTbc cleared, originalDate stamped.
    const rp = plan(
      parsedOf([
        rowOf({ home: 'Delta', away: 'Alpha', date: '2026-10-17', time: '13:30', venue: '' }),
      ]),
      all,
    );
    assert.deepEqual(rp.plan.errors, []);
    const f4 = (rp.plan.next[0].fixtures as Fx[]).find((f) => f.id === 'f4')!;
    assert.equal(f4.dateTbc, undefined);
    assert.equal(f4.originalDate, SUN);
    assert.equal(f4.date, '2026-10-17');
  });

  test('a legacy postponement (no originalDate, no dateTbc) listed on a new date is rescheduled; on its old date, blocked', () => {
    const all = [premier({ f4: { status: 'postponed' } })];
    const [moved] = match(
      [rowOf({ home: 'Delta', away: 'Alpha', date: '2026-10-17', time: '13:30', venue: '' })],
      all,
    );
    assert.deepEqual(moved.entry?.set, { date: '2026-10-17', postponed: true });
    const [same] = match(
      [rowOf({ home: 'Delta', away: 'Alpha', time: '13:30', venue: 'Delta Fields' })],
      all,
    );
    assert.equal(same.outcome, 'blocked');
    assert.match(same.reason!, /reinstate/);
  });
});

// ─────────────────────────────── planner ───────────────────────────────

const parsedOf = (rows: ReminderRow[]): ParsedReminderWorkbook => ({
  rows,
  skippedRows: [],
  sheets: [{ sheet: 'S', status: 'ok', fixtureRows: rows.length, unrecognisedRows: 0, vColumn: 3 }],
});

/** The Premier Men rows of the sample workbook, as the parser reads them. */
async function premierSheet(): Promise<ParsedReminderWorkbook> {
  const all = await parseReminderWorkbook(readFileSync(SAMPLE));
  const rows = all.rows.filter((r) => r.sheet === 'Premier Men Reminder Fixtures');
  return { rows, skippedRows: [], sheets: all.sheets.filter((s) => s.sheet === rows[0].sheet) };
}

const plan = (
  parsed: ParsedReminderWorkbook,
  all: Series[],
  over: Partial<Parameters<typeof planReminderAmendments>[0]> = {},
) => planReminderAmendments({ parsed, series: all, clubs, venues, aliases, ...over });

describe('planReminderAmendments', () => {
  test('sample Premier Men sheet end to end: time, venue and postponement planned; gate clean', async () => {
    const rp = plan(await premierSheet(), [premier(), veterans()]);
    assert.deepEqual(rp.plan.errors, []);
    assert.equal(rp.gateVerdict.ok, true);
    assert.deepEqual(
      rp.manifest.entries.map((e) => [e.fixtureId, e.set]),
      [
        ['f2', { time: '09:00' }],
        ['f3', { venueId: 'v-neutral' }],
        ['f4', { postponed: true }],
      ],
    );
    const next = rp.plan.next.find((s) => s.id === 's-prem')!.fixtures as Fx[];
    assert.equal(next[3].status, 'postponed');
    assert.equal(next[3].originalDate, undefined);
    assert.equal(next[3].date, SUN);
  });

  test('idempotent re-upload: after applying, every row is matched-no-change', async () => {
    const parsed = await premierSheet();
    const first = plan(parsed, [premier(), veterans()]);
    const applied = first.plan.next.map((s) =>
      first.plan.touchedSeriesIds.includes(String(s.id)) ? { ...s, version: s.version + 1 } : s,
    );
    const again = plan(parsed, applied);
    assert.deepEqual(
      again.match.matches.map((m) => m.outcome),
      Array(parsed.rows.length).fill('matched-no-change'),
    );
    assert.equal(again.manifest.entries.length, 0);
    assert.equal(again.plan.diffs.length, 0);
    assert.equal(again.gateVerdict.ok, true);
  });

  test('an undated postponement of a released fixture frees its ground (postponed + dateTbc)', () => {
    // f1 (alpha v beta, Beta Park 09:00 SUN) postponed; f3 (beta v gamma, Beta Park) to 09:00.
    const rows = [
      rowOf({ sheetRow: 1, venue: '', postponed: true }),
      rowOf({ sheetRow: 2, home: 'Beta', away: 'Gamma', time: '09:00', venue: 'Beta Park' }),
    ];
    const rp = plan(parsedOf(rows), [premier()]);
    assert.deepEqual(rp.plan.errors, []);
    assert.deepEqual(rp.gateVerdict.introduced, []);
    const f1 = (rp.plan.next[0].fixtures as Fx[]).find((f) => f.id === 'f1')!;
    assert.equal(f1.status, 'postponed');
    assert.equal(f1.dateTbc, true);
    assert.equal(f1.date, SUN);
    // Without the postponement the same move is an introduced clash.
    const blocked = plan(parsedOf([rows[1]]), [premier()]);
    assert.ok(blocked.gateVerdict.introduced.length > 0);
  });

  test('an introduced clash aborts the plan; a pre-existing one only reports', () => {
    // Moving f2 onto Beta Park at 09:00, which released f1 already holds ⇒ introduced.
    const rows = [rowOf({ home: 'Gamma', away: 'Delta', time: '09:00', venue: 'Beta Park' })];
    const rp = plan(parsedOf(rows), [premier()]);
    assert.equal(rp.gateVerdict.ok, false);
    assert.equal(rp.gateVerdict.introduced.length > 0, true);
    assert.ok(rp.plan.errors.some((e) => /introduce/.test(e)));

    // A standing released clash on the date (f3 shares Beta Park 13:30 with another series),
    // and the sheet only retimes an unrelated fixture.
    const standing = series('s-other', 'Premier League · T20 · Group 9', true, [
      { id: 'o1', date: SUN, time: '13:30', home: 'gamma', away: 'delta', venueName: 'Beta Park' },
    ]);
    const ok = plan(parsedOf([rowOf({ time: '10:00' })]), [premier(), standing]);
    assert.equal(ok.gateVerdict.ok, true, 'introduced-only mode');
    const pv = reminderPreview(ok, [premier(), standing], clubs);
    assert.ok(pv.gate.preExisting.length > 0);
    assert.equal(pv.gate.introduced.length, 0);
    const strict = plan(parsedOf([rowOf({ time: '10:00' })]), [premier(), standing], {
      gateMode: 'strict',
    });
    assert.equal(strict.gateVerdict.ok, false, 'the CLI default stays strict');
  });

  test('the preview lists one entry per double-booking and says whether its holder is a draft', () => {
    // f2 (Gamma v Delta) moves onto Delta Fields 13:30 SUN; f4 is out of the way on SAT.
    const rows = [rowOf({ home: 'Gamma', away: 'Delta', time: '13:30', venue: 'Delta Fields' })];
    const holder = (released: boolean) =>
      series('s-hold', 'Holder Cup · T20', released, [
        {
          id: 'h1',
          date: SUN,
          time: '13:30',
          home: 'gamma',
          away: 'alpha',
          venueName: 'Delta Fields',
        },
      ]);
    for (const released of [true, false]) {
      const all = [premier({ f4: { date: SAT } }), holder(released)];
      const rp = plan(parsedOf(rows), all);
      // The gate sees the pair from both sides; the preview shows it once.
      assert.equal(rp.plan.gate!.introduced.length, 2);
      const pv = reminderPreview(rp, all, clubs);
      assert.equal(pv.gate.introduced.length, 1);
      const [c] = pv.gate.introduced;
      assert.equal(c.ground, 'Delta Fields');
      assert.equal(c.fixture, 'Gamma CC v Delta CC', 'the amended side');
      assert.equal(c.with, 'Holder Cup · T20: Gamma CC v Alpha CC', 'the ground-holder');
      assert.equal(c.holderDraft, !released);
    }
  });

  test('skip toggles drop the row from the manifest and change the hash', async () => {
    const parsed = await premierSheet();
    const all = [premier(), veterans()];
    const full = plan(parsed, all);
    const skipped = plan(parsed, all, { skipRowIds: ['Premier Men Reminder Fixtures:8'] });
    assert.equal(skipped.manifest.entries.length, full.manifest.entries.length - 1);
    assert.ok(!skipped.manifest.entries.some((e) => e.fixtureId === 'f2'));
    assert.notEqual(skipped.planHash, full.planHash);
    assert.deepEqual(skipped.appliedRowIds.includes('Premier Men Reminder Fixtures:8'), false);
  });

  test('planHash: deterministic; changes on a touched-series version bump', async () => {
    const parsed = await premierSheet();
    const a = plan(parsed, [premier(), veterans()]);
    const b = plan(parsed, [premier(), veterans()]);
    assert.equal(a.planHash, b.planHash);
    const bumped = { ...premier(), version: 4 } as Series;
    assert.notEqual(plan(parsed, [bumped, veterans()]).planHash, a.planHash);
    // An UNtouched series' version is not part of the plan.
    const vetBumped = { ...veterans(), version: 9 } as Series;
    assert.equal(plan(parsed, [premier(), vetBumped]).planHash, a.planHash);
  });

  test('planHash: changes when the relocation outcome changes (untouched series)', () => {
    // The sheet moves f2 to Delta Fields 13:30, where an untimed draft (delta at home) sits —
    // relocation moves the draft to its next free ground (Delta 2).
    const rows = [rowOf({ home: 'Gamma', away: 'Delta', time: '13:30', venue: 'Delta Fields' })];
    const draftWith = (extra: Fx[]) =>
      series('s-draft', 'EMCU Division 1 · EMCU Division 1', false, [
        { id: 'd1', date: SUN, home: 'delta', away: 'beta' },
        ...extra,
      ]);
    const all1 = [premier({ f4: { date: SAT } }), draftWith([])];
    const r1 = plan(parsedOf(rows), all1, { relocateDraftClashes: true });
    assert.deepEqual(r1.plan.errors, []);
    assert.equal(r1.plan.moves.length, 1);
    // Another untouched draft now takes the first destination ⇒ the move lands elsewhere.
    const firstTo = r1.plan.moves[0].to;
    const blocker = series('s-blocker', 'Some Cup · T20', false, [
      { id: 'b1', date: SUN, home: 'gamma', away: 'alpha', venueName: firstTo },
    ]);
    const r2 = plan(parsedOf(rows), [...all1, blocker], { relocateDraftClashes: true });
    if (r2.plan.moves[0]) assert.notEqual(r2.plan.moves[0].to, firstTo);
    assert.notEqual(r2.planHash, r1.planHash);
  });

  test('a set.date destination joins the relocation dates', () => {
    const rows = [
      rowOf({
        home: 'Gamma',
        away: 'Delta',
        date: '2026-10-17',
        time: '13:30',
        venue: 'Gamma Field',
      }),
    ];
    const rp = plan(parsedOf(rows), [premier()], { relocateDraftClashes: true });
    assert.deepEqual(rp.manifest.relocateDraftClashes?.dates, ['2026-10-17']);
    const rp2 = plan(parsedOf([...rows, rowOf({ sheetRow: 2, time: '09:00' })]), [premier()], {
      relocateDraftClashes: true,
    });
    assert.deepEqual(rp2.manifest.relocateDraftClashes?.dates, [SUN, '2026-10-17']);
  });

  test('the preview DTO is slim: no series bodies, collapsed no-ops, counts', async () => {
    const all = [premier(), veterans()];
    const rp = plan(await premierSheet(), all);
    const pv = reminderPreview(rp, all, clubs);
    const json = JSON.stringify(pv);
    assert.ok(!json.includes('"next"'));
    assert.ok(!json.includes('"fixtures"'));
    assert.equal(pv.planHash, rp.planHash);
    assert.equal(pv.counts['matched-change'], 3);
    assert.equal(pv.counts['matched-no-change'], 1);
    assert.equal(pv.sheets[0].alreadyCorrect, 1);
    // The already-correct rows themselves are listed (no fixture body, just who/when).
    assert.equal(pv.sheets[0].alreadyCorrectRows.length, 1);
    const ok = pv.sheets[0].alreadyCorrectRows[0];
    assert.deepEqual(Object.keys(ok).sort(), ['away', 'date', 'home', 'rowId', 'sheetRow']);
    assert.ok(ok.home && ok.away && ok.date && ok.rowId.includes(':'));
    assert.ok(!pv.sheets[0].rows.some((r) => r.rowId === ok.rowId), 'not listed twice');
    assert.equal(pv.sheets[0].rows.length, 3);
    assert.deepEqual(pv.touchedSeries, [
      { id: 's-prem', name: 'Premier League · T20 · Group 1', version: 3 },
    ]);
  });
});

// ─────────────────────────────── write ───────────────────────────────

describe('writeReminderPlan', () => {
  /** A repo stand-in at the storage boundary: records puts, drifts the named series. */
  const fakeRepo = (drift: Set<string>) => {
    const written: Series[] = [];
    return {
      written,
      repo: {
        getTenantConfig: async () => null,
        getSeasonRun: async () => null,
        putPendingSync: async () => undefined,
        putSyncLog: async () => undefined,
        putSeriesIfVersion: async (_t: string, s: Series) => {
          if (drift.has(String(s.id)))
            throw Object.assign(new Error('changed'), { name: 'VersionConflictError' });
          written.push(s);
        },
      } as unknown as Parameters<typeof writeReminderPlan>[0],
    };
  };

  test('a slot swap split by drift is flagged as a double-booking risk', async () => {
    // s-a f1 09:00 at Beta Park ↔ s-b g1 13:30 at Beta Park: the sheet swaps their times.
    const sA = series('s-a', 'Premier League · T20 · Group 1', true, [
      { id: 'f1', date: SUN, time: '09:00', home: 'beta', away: 'alpha', venueName: 'Beta Park' },
    ]);
    const sB = series('s-b', 'Premier League · T20 · Group 2', true, [
      { id: 'g1', date: SUN, time: '13:30', home: 'beta', away: 'gamma', venueName: 'Beta Park' },
    ]);
    const rows = [
      rowOf({ sheetRow: 1, home: 'Beta', away: 'Alpha', time: '13:30', venue: 'Beta Park' }),
      rowOf({ sheetRow: 2, home: 'Beta', away: 'Gamma', time: '09:00', venue: 'Beta Park' }),
    ];
    const rp = plan(parsedOf(rows), [sA, sB]);
    assert.deepEqual(rp.plan.errors, []);
    assert.equal(rp.plan.touchedSeriesIds.length, 2);

    const clean = fakeRepo(new Set());
    const ok = await writeReminderPlan(clean.repo, 't', [sA, sB], rp, clubs, aliases, {
      error: () => {},
    });
    assert.deepEqual(
      ok.results.map((r) => [r.seriesId, r.status, r.version]),
      [
        ['s-a', 'written', 4],
        ['s-b', 'written', 4],
      ],
    );
    assert.deepEqual(ok.splitSlotRisks, []);

    const split = fakeRepo(new Set(['s-b']));
    const out = await writeReminderPlan(split.repo, 't', [sA, sB], rp, clubs, aliases, {
      error: () => {},
    });
    assert.deepEqual(
      out.results.map((r) => r.status),
      ['written', 'drifted'],
    );
    assert.deepEqual(out.splitSlotRisks, [
      {
        written: { seriesId: 's-a', fixtureId: 'f1' },
        stranded: { seriesId: 's-b', fixtureId: 'g1' },
        ground: 'Beta Park',
        date: SUN,
        time: '13:30',
      },
    ]);
  });
});

describe('CLI args', () => {
  test('offline needs all three exports and never confirms', () => {
    assert.throws(
      () => parseReminderArgs(['--tenant', 't', '--file', 'x.xlsx', '--series-json', 's.json']),
      /all three/,
    );
    assert.throws(
      () =>
        parseReminderArgs([
          '--tenant',
          't',
          '--file',
          'x.xlsx',
          '--series-json',
          's',
          '--clubs-json',
          'c',
          '--venues-json',
          'v',
          '--confirm',
        ]),
      /never writes/,
    );
    const a = parseReminderArgs(['--tenant', 't', '--file', 'x.xlsx', '--skip', 'S:3']);
    assert.equal(a.gate, 'strict', 'the CLI defaults to the strict gate');
    assert.deepEqual(a.skip, ['S:3']);
  });
});
