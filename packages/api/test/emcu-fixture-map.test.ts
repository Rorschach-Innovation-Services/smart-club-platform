/**
 * emcu-fixture-map.ts: the EMCU workbook grammar, the team/venue maps, and the real workbook.
 *
 * Three tiers:
 *   - synthetic grids (always run): the row classifier and the fail-closed parse rules;
 *   - the REAL workbook (`EMCU_WORKBOOK`, default ~/Downloads/Complete EMCU Fixtures
 *     2026-2027 Season.xlsx; skipped when absent): counts, times, round order, groups, notes;
 *   - the prod exports (`EMCU_EXPORT_DIR` holding prod-CLUB.json / prod-VENUE.json; skipped
 *     when unset): exhaustive team + venue resolution against the real registry.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_WORKBOOK,
  EMCU_NEW_CLUBS,
  EMCU_NEW_VENUES,
  EMCU_SERIES,
  EMCU_TEAM_MAP,
  EMCU_VENUE_ALIASES,
  EMCU_VENUE_ALIAS_PAIRS,
  classifyRow,
  classifySectionHeader,
  emcuAliases,
  emcuSide,
  homeClubsAt,
  parseEmcuWorkbook,
  verifyTeamMap,
  type ParsedEmcuWorkbook,
  type SheetGrid,
} from '../src/emcu-fixture-map.js';
import {
  applyBootstrapOverlay,
  buildEmcuSeries,
  readWorkbookGrids,
} from '../src/import-emcu-fixtures.js';
import { loadOffline } from '../src/patch-fixtures.js';
import { groundKey, normaliseName, venueAliasesFor } from '../src/venue-clash.js';

const WORKBOOK = process.env.EMCU_WORKBOOK ?? DEFAULT_WORKBOOK;
const EXPORT_DIR = process.env.EMCU_EXPORT_DIR ?? '';
const haveWorkbook = existsSync(WORKBOOK);
const haveExports =
  !!EXPORT_DIR &&
  ['prod-SERIES-after.json', 'prod-CLUB.json', 'prod-VENUE.json'].every((f) =>
    existsSync(join(EXPORT_DIR, f)),
  );

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);
/** A row's cells, 1-based like exceljs. */
const cells = (...vals: unknown[]): unknown[] => [undefined, ...vals];
const banner = (text: string) => cells(text, text, text, text, text, text, text);
const roundHdr = (n: number, time: string, date: string, note?: string) =>
  cells(`Round ${n} Fixtures`, null, null, time, utc(date), 'Venue:', note ?? null);
const fx = (home: string, away: string, venue: string) => cells(home, null, 'v', null, away, venue);
const grid = (name: string, rows: unknown[][]): SheetGrid => ({
  name,
  rows: rows.map((c, i) => ({ row: i + 1, cells: c })),
});

describe('row grammar', () => {
  test('section headers', () => {
    assert.equal(classifySectionHeader('T20 – One Round League'), 't20');
    assert.equal(classifySectionHeader('T20 – Double Round League'), 't20');
    assert.equal(classifySectionHeader('30 Over – One Round League'), '30ov');
    assert.equal(classifySectionHeader('30 Over – Group A (First 7 Listed Teams)'), '30ov-a');
    assert.equal(classifySectionHeader('30 Over – Group B (Last 7 Listed Teams)'), '30ov-b');
    assert.equal(classifySectionHeader('EMCU Division 1 – 2026/27 Fixtures'), null);
  });

  test('round header, fixture row, banner, blank, unknown', () => {
    const r = classifyRow(roundHdr(10, '13:00', '2027-01-17', 'a note'));
    assert.deepEqual(r, {
      kind: 'round',
      round: 10,
      time: '13:00',
      date: '2027-01-17',
      note: 'a note',
    });
    assert.deepEqual(classifyRow(fx('Crusaders', 'Delta Cricket Club', 'Crusaders 1')), {
      kind: 'fixture',
      home: 'Crusaders',
      away: 'Delta Cricket Club',
      venue: 'Crusaders 1',
    });
    assert.equal(classifyRow(banner('EMCU Division 1 – 2026/27 Fixtures')).kind, 'banner');
    assert.equal(classifyRow(banner('T20 – One Round League')).kind, 'section');
    assert.equal(classifyRow(cells()).kind, 'blank');
    assert.equal(classifyRow(cells('Crusaders', 'x', 'v', null, 'Delta', 'Oval')).kind, 'unknown');
  });
});

describe('fail-closed parse (synthetic)', () => {
  const div1 = (rows: unknown[][]) => [
    grid('Fixtures Div 1', [
      banner('EMCU Division 1 – 2026/27 Fixtures'),
      banner('Sunday.'),
      ...rows,
    ]),
  ];
  test('a fixture row before any round header is an error', () => {
    const p = parseEmcuWorkbook(
      div1([banner('T20 – One Round League'), fx('Crusaders', 'Delta Cricket Club', 'X')]),
    );
    assert.ok(p.errors.some((e) => e.includes('fixture row outside a round')));
  });
  test('unknown team, wrong time, wrong weekday and out-of-window dates are errors', () => {
    const p = parseEmcuWorkbook(
      div1([
        banner('T20 – One Round League'),
        roundHdr(1, '13:00', '2026-10-10', undefined),
        fx('Crusaders', 'Nobody CC', 'Crusaders 1'),
        roundHdr(2, '09:00', '2027-05-02'),
        fx('Crusaders', 'Delta Cricket Club', 'Crusaders 1'),
      ]),
    );
    assert.ok(p.errors.some((e) => e.includes('unknown team "Nobody CC"')));
    assert.ok(p.errors.some((e) => e.includes('starts 13:00, expected 09:00')));
    assert.ok(p.errors.some((e) => e.includes('2026-10-10 is not a Sunday')));
    assert.ok(p.errors.some((e) => e.includes('outside the 2026-10-01..2027-04-05 season')));
  });
  test('a team twice in one round is an error', () => {
    const p = parseEmcuWorkbook(
      div1([
        banner('T20 – One Round League'),
        roundHdr(1, '09:00', '2026-10-11'),
        fx('Crusaders', 'Delta Cricket Club', 'A'),
        fx('Crusaders', 'Harlequins Cricket Club', 'B'),
      ]),
    );
    assert.ok(p.errors.some((e) => e.includes('"Crusaders" plays twice in Round 1')));
  });
  test('a team crossing the two Div 2 30-over groups fails the parse', () => {
    const p = parseEmcuWorkbook([
      grid('Fixtures Div 2', [
        banner('EMCU Division 2 – 2026/27 Fixtures'),
        banner('30 Over – Group A (First 7 Listed Teams)'),
        roundHdr(1, '08:30', '2027-02-14'),
        fx('West CC', 'Saints Cricket Club', 'Mpumalanga'),
        banner('30 Over – Group B (Last 7 Listed Teams)'),
        roundHdr(1, '08:30', '2027-02-14'),
        fx('Saints Cricket Club', 'Railways Cricket Club', 'Crawford NC'),
      ]),
    ]);
    assert.ok(
      p.errors.some((e) =>
        e.includes('"Saints Cricket Club" appears in both Div 2 30-over groups'),
      ),
    );
  });
  test('counts are asserted per series', () => {
    const p = parseEmcuWorkbook([]);
    assert.ok(
      p.errors.some((e) => e.includes('EMCU Division 1 · T20: 0 fixtures parsed, expected 45')),
    );
  });
});

describe('team + venue maps', () => {
  test('lettered sides are 0-based tm_ ids (A = 0); plain sides play as the club', () => {
    assert.equal(
      emcuSide('Simplex Reservoir Hills Crimson A', 'emcuD2')!.teamId,
      'tm_simplex-reservoir-hills-crimson_emcuD2_0',
    );
    assert.equal(
      emcuSide('Simplex Reservoir Hills Crimson C', 'emcuD2')!.teamId,
      'tm_simplex-reservoir-hills-crimson_emcuD2_2',
    );
    assert.equal(
      emcuSide('Simplex Reservoir Hills Crimson', 'emcuD1')!.teamId,
      'simplex-reservoir-hills-crimson',
    );
    assert.equal(emcuSide('Umlazi CC (MUT)', 'emcuD5_s1')!.clubId, 'umlazi-cc-mut');
    assert.equal(emcuSide('uMlazi cricket club', 'emcuD2')!.clubId, 'umlazi-cricket-club');
    assert.equal(emcuSide('Simplex Reservoir Hills Crimson D', 'emcuD2'), null);
    assert.deepEqual(verifyTeamMap(), []);
    assert.equal(Object.keys(EMCU_TEAM_MAP).length, 38);
  });
  test('alias map drops identity pairs and never lets the tenant lose a key', () => {
    assert.equal(EMCU_VENUE_ALIASES[normaliseName('Phoenix Northcroft')], undefined);
    assert.equal(
      EMCU_VENUE_ALIASES[normaliseName('Forest Hill')],
      normaliseName('Forest Hills Sports Club'),
    );
    assert.equal(emcuAliases({ foresthill: 'elsewhere' }).foresthill, 'elsewhere');
  });
  test('series names are the frozen "<League> · <Stream>[ · <Group>]" contract', () => {
    for (const s of EMCU_SERIES)
      assert.match(s.name, /^EMCU Division \d( Stream \d)? · (T20|30 Over)( · Group [AB])?$/);
  });
});

describe(
  'the real workbook',
  { skip: haveWorkbook ? false : `workbook not found at ${WORKBOOK}` },
  () => {
    let parsed: ParsedEmcuWorkbook;
    const get = async () => (parsed ??= parseEmcuWorkbook(await readWorkbookGrids(WORKBOOK)));

    test('620 fixtures, every series at its verified count, no errors', async () => {
      const p = await get();
      assert.deepEqual(p.errors, []);
      assert.equal(p.fixtures.length, 620);
      for (const s of EMCU_SERIES)
        assert.equal(p.fixtures.filter((f) => f.slug === s.slug).length, s.expected, s.slug);
    });
    test('times come from round headers: Div 2 T20 R10 is 17 Jan 13:00, R9 the same day 09:00', async () => {
      const d2 = (await get()).fixtures.filter((f) => f.slug === 'd2-t20');
      assert.ok(
        d2
          .filter((f) => f.round === 10)
          .every((f) => f.date === '2027-01-17' && f.time === '13:00'),
      );
      assert.ok(
        d2.filter((f) => f.round === 9).every((f) => f.date === '2027-01-17' && f.time === '09:00'),
      );
      assert.ok(
        (await get()).fixtures.filter((f) => f.slug === 'd1-30ov').every((f) => f.time === '08:30'),
      );
    });
    test('Div 5 plays Saturdays, Div 1-4 Sundays', async () => {
      for (const f of (await get()).fixtures) {
        const day = utc(f.date).getUTCDay();
        assert.equal(day, f.slug.startsWith('d5-') ? 6 : 0, `${f.slug} ${f.date}`);
      }
    });
    test('round labels are sheet-authoritative: D5S1 R11 sits on 5 Dec between R4 and R5', async () => {
      const p = await get();
      const d5 = p.fixtures.filter((f) => f.slug === 'd5-s1-t20');
      const order = [...new Set(d5.map((f) => f.round))];
      assert.deepEqual(order.slice(0, 6), [1, 2, 3, 4, 11, 5]);
      assert.ok(d5.filter((f) => f.round === 11).every((f) => f.date === '2026-12-05'));
      assert.ok(p.warnings.some((w) => w.includes('Div 3 S2') && w.includes('"Round 5" again')));
    });
    test('the Div 2 30-over groups are explicit, disjoint, seven each', async () => {
      const p = await get();
      const a = p.sectionTeams.get('d2-30ov-a')!;
      const b = p.sectionTeams.get('d2-30ov-b')!;
      assert.equal(a.size, 7);
      assert.equal(b.size, 7);
      assert.ok([...a].every((t) => !b.has(t)));
    });
    test('the Easter "TO MOVE" note on Div 2 30-over Group B R7 is captured', async () => {
      const notes = (await get()).roundNotes;
      assert.equal(notes.length, 1);
      assert.equal(notes[0].slug, 'd2-30ov-b');
      assert.equal(notes[0].round, 7);
      assert.equal(notes[0].date, '2027-03-28');
      assert.match(notes[0].note, /EASTER/);
    });
    test('the new venues list exactly the clubs that host there', async () => {
      const p = await get();
      for (const v of EMCU_NEW_VENUES)
        assert.deepEqual(homeClubsAt(p.fixtures, v.name), [...v.homeClubIds!].sort(), v.name);
    });
  },
);

describe(
  'resolution against the prod exports',
  {
    skip:
      haveWorkbook && haveExports
        ? false
        : 'set EMCU_EXPORT_DIR (prod-*.json) and have the workbook',
  },
  () => {
    const load = () =>
      loadOffline({
        series: join(EXPORT_DIR, 'prod-SERIES-after.json'),
        clubs: join(EXPORT_DIR, 'prod-CLUB.json'),
        venues: join(EXPORT_DIR, 'prod-VENUE.json'),
      });
    test('every team string resolves; the shared resolver agrees; only the 2 new clubs are missing', async () => {
      const { clubs, venues } = load();
      const parsed = parseEmcuWorkbook(await readWorkbookGrids(WORKBOOK));
      const aliases = emcuAliases(venueAliasesFor(undefined));
      const before = buildEmcuSeries(parsed, { clubs, venues, aliases });
      assert.deepEqual(before.missingClubs.sort(), EMCU_NEW_CLUBS.map((c) => c.id).sort());
      assert.deepEqual(before.resolverMismatches, []);
      const o = applyBootstrapOverlay(clubs, venues, aliases);
      const after = buildEmcuSeries(parsed, { clubs: o.clubs, venues: o.venues, aliases });
      assert.deepEqual(after.missingClubs, []);
      assert.deepEqual(after.resolverMismatches, []);
      // Every distinct workbook team string was resolved in at least one league.
      assert.equal(new Set(after.resolutions.map((r) => r.raw)).size, 38);
    });
    test('every workbook venue resolves to the registry; before bootstrap only the 2 new grounds miss', async () => {
      const { clubs, venues } = load();
      const parsed = parseEmcuWorkbook(await readWorkbookGrids(WORKBOOK));
      const aliases = emcuAliases(venueAliasesFor(undefined));
      const before = buildEmcuSeries(parsed, { clubs, venues, aliases });
      assert.deepEqual([...before.registryMisses.keys()].sort(), [
        'Dokkies Primary School',
        'Lutherfield',
      ]);
      const o = applyBootstrapOverlay(clubs, venues, aliases);
      const after = buildEmcuSeries(parsed, { clubs: o.clubs, venues: o.venues, aliases });
      assert.equal(after.registryMisses.size, 0);
      assert.equal(after.locked, 620);
    });
    test('every alias target is a real registry ground', () => {
      const { venues } = load();
      const keys = new Set(venues.map((v) => groundKey(v.name, {})));
      for (const [sheet, registry] of EMCU_VENUE_ALIAS_PAIRS)
        assert.ok(keys.has(normaliseName(registry)), `${sheet} → ${registry}`);
    });
  },
);
