/**
 * Tuskers (KZNICU) fixtures importer family: manifest invariants, the three sheet parsers
 * (in-memory exceljs workbooks), series building, the release gate and the CLI args. Pure — no
 * dynalite, no repo.js. The last block runs the parsers on the REAL workbooks and skips cleanly
 * when they are not on this machine (TUSKERS_MENS_XLSX / TUSKERS_VETS_XLSX override the paths).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import ExcelJS from 'exceljs';
import type { Club, Series } from '../src/types.js';

const map = await import('../src/tuskers-fixture-map.js');
const cli = await import('../src/import-tuskers-fixtures.js');
const boot = await import('../src/bootstrap-tuskers-fixture-prereqs.js');

const {
  TUSKERS_FIXTURE_SHEETS,
  TUSKERS_TEAMS,
  TUSKERS_VENUE_ALIASES,
  T20_RESCHEDULES,
  EXCLUDED_ROWS,
  resolveTeam,
  canonicalVenue,
  isTbcVenue,
  weekdayName,
  parseMens50Sheet,
  parseMensT20Sheet,
  parseVetsSheet,
  checkSheetStates,
} = map;

const spec = (layout: string) => TUSKERS_FIXTURE_SHEETS.find((s) => s.layout === layout)!;
const id = (raw: string) => resolveTeam(raw)!.id;
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const T = (hhmm: string) => new Date(`1899-12-30T${hhmm}:00Z`);

/** Write `cells` ({ 'B7': value }) into a fresh sheet. */
function sheet(name: string, cells: Record<string, unknown>, state?: 'hidden') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name);
  if (state) ws.state = state;
  for (const [addr, v] of Object.entries(cells)) ws.getCell(addr).value = v as ExcelJS.CellValue;
  return { wb, ws };
}

describe('manifest', () => {
  test('ids derive from names, the 3 vets clubs are new, MCC and Young Nats resolve', () => {
    assert.equal(id('MCC'), 'maritzburg-cricket-club');
    assert.equal(id('Young Nats CC'), 'young-natalians-cricket-club');
    assert.equal(id('young  nats'), 'young-natalians-cricket-club');
    for (const n of ['Midlands Vets', 'Zingari CC', 'Cosmos Vets'])
      assert.ok(resolveTeam(n)?.created);
    assert.equal(resolveTeam('Howick High'), undefined, 'a ground is never a team globally');
    assert.equal(new Set(TUSKERS_TEAMS.map((t) => t.id)).size, 11);
  });

  test('series ids and counts', () => {
    assert.deepEqual(
      TUSKERS_FIXTURE_SHEETS.map((s) => [s.seriesId, s.leagueKey, s.maxOvers, s.expected]),
      [
        ['s-tuskers-premier-league-t20', 'premier-league', 20, 28],
        ['s-tuskers-premier-league-50-overs', 'premier-league', 50, 56],
        ['s-tuskers-veterans-league', 'veterans-league', 20, 21],
      ],
    );
    assert.ok(!map.WRITABLE_SERIES_IDS.includes(map.T20_KO_SERIES_ID), 'T20 KO is held back');
    assert.ok(map.WRITABLE_SERIES_IDS.includes(map.VETS_KO_SERIES_ID));
  });

  test('venue aliases are misspellings of one ground; T.B.C is TBC', () => {
    assert.equal(canonicalVenue('Varstiy 1')?.name, 'Varsity 1 Oval');
    assert.equal(canonicalVenue('Linpark')?.name, 'Linpark Oval');
    assert.equal(canonicalVenue('Mystery Park'), undefined);
    assert.ok(isTbcVenue('T.B.C') && isTbcVenue('TBC') && isTbcVenue(''));
    assert.ok(Object.keys(TUSKERS_VENUE_ALIASES).length >= 3);
    assert.throws(() =>
      map.buildTuskersVenueAliases([
        { name: 'A Oval', aliases: ['B Park'], note: '' },
        { name: 'B Park', aliases: [], note: '' },
      ]),
    );
  });

  test('weekday banner typo tolerance', () => {
    assert.equal(weekdayName('Satruday'), 'SATURDAY');
    assert.equal(weekdayName('Friday '), 'FRIDAY');
    assert.equal(weekdayName('Funday'), null);
  });
});

describe('sheet states', () => {
  test('a visible out-of-scope sheet or an unknown sheet is refused', () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Prem T20 Fixtures');
    wb.addWorksheet('Prem 50 Overs Fixtures');
    for (const n of ['Jnr League Teams', 'U11 Fixtures', 'U13 Fixtures', 'U16 Fixtures'])
      wb.addWorksheet(n).state = 'hidden';
    wb.addWorksheet('Veterans Fixtures'); // visible: the stale copy must stay hidden
    wb.addWorksheet('Surprise');
    const errs = checkSheetStates(wb, 'mens');
    assert.ok(errs.some((e) => /Veterans Fixtures.*VISIBLE/.test(e)));
    assert.ok(errs.some((e) => /Surprise.*not in the manifest/.test(e)));
  });
});

/** A tiny two-team-per-week 50-overs sheet using a 4-team spec. */
const mini50 = { ...spec('mens50'), teams: 4, meetings: 2, expected: 12 };
function build50(extra: Record<string, unknown> = {}) {
  const teams = ['Standard CC', 'UKZN CC', 'MCC', 'Howick CC'];
  const cells: Record<string, unknown> = {
    A1: 'KZN Inland 50 Overs',
    B5: 'Teams',
    D5: 'Home Venue',
  };
  const homes = ['Collegians', 'Varsity 1 Oval', 'Linpark Oval', 'Howick High'];
  teams.forEach((t, i) => {
    cells[`B${7 + i}`] = t;
    cells[`D${7 + i}`] = homes[i];
  });
  // 6 pairings, left block = first leg, right block = second leg.
  const legs: Array<[number, number]> = [
    [0, 1],
    [2, 3],
    [0, 2],
    [1, 3],
    [0, 3],
    [1, 2],
  ];
  for (let w = 0; w < 3; w++) {
    const r = 16 + w * 4;
    Object.assign(cells, {
      [`A${r}`]: `Week ${w + 1}`,
      [`B${r}`]: D(`2026-11-${String(8 + w * 7).padStart(2, '0')}`),
      [`G${r}`]: `Week ${w + 4}`,
      [`H${r}`]: D(`2027-02-${String(7 + w * 7).padStart(2, '0')}`),
    });
    for (let k = 0; k < 2; k++) {
      const [h, a] = legs[w * 2 + k];
      Object.assign(cells, {
        [`B${r + 1 + k}`]: teams[h],
        [`C${r + 1 + k}`]: 'vs ',
        [`D${r + 1 + k}`]: teams[a],
        [`E${r + 1 + k}`]: homes[h],
        [`H${r + 1 + k}`]: teams[a],
        [`I${r + 1 + k}`]: 'vs',
        [`J${r + 1 + k}`]: teams[h],
        [`K${r + 1 + k}`]: homes[a],
      });
    }
  }
  return sheet('Prem 50 Overs Fixtures', { ...cells, ...extra });
}

describe('parseMens50Sheet', () => {
  const noRules = { rules: [], fixes: [] };

  test('reads both blocks, provisional 09:30, home grounds from the header', () => {
    const { ws } = build50();
    const p = parseMens50Sheet(ws, mini50, noRules);
    // The manifest home-venue table names 8 clubs; the mini sheet lists 4 → 4 header errors only.
    const other = p.errors.filter((e) => !/header lists/.test(e));
    assert.deepEqual(other, []);
    assert.equal(p.fixtures.length, 12);
    assert.ok(p.fixtures.every((f) => f.time === '09:30' && f.timeSource === 'provisional'));
    assert.equal(p.homeVenues![id('MCC')], 'Linpark Oval');
    assert.equal(p.fixtures[0].date, '2026-11-08');
  });

  test('unknown team and unknown ground are fatal; a listed cell fix applies once', () => {
    const { ws } = build50({ D17: 'Howick High' });
    const p = parseMens50Sheet(ws, mini50, noRules);
    assert.ok(p.errors.some((e) => /unknown team "Howick High"/.test(e)));
    const fixed = parseMens50Sheet(ws, mini50, {
      rules: [],
      fixes: [
        {
          workbook: 'mens',
          sheet: 'Prem 50 Overs Fixtures',
          row: 17,
          raw: 'Howick High',
          team: 'UKZN CC',
          reason: 't',
        },
      ],
    });
    assert.ok(!fixed.errors.some((e) => /unknown team/.test(e)));
    const { ws: ws2 } = build50({ E17: 'Mystery Park' });
    assert.ok(parseMens50Sheet(ws2, mini50, noRules).errors.some((e) => /unknown ground/.test(e)));
  });

  test('an unlisted stray row is fatal; a listed exclusion must match its text', () => {
    const { ws } = build50({ B40: 'Club Champs - Playoff TBC' });
    assert.ok(parseMens50Sheet(ws, mini50, noRules).errors.some((e) => /unrecognised row/.test(e)));
    const rule = {
      workbook: 'mens' as const,
      sheet: 'Prem 50 Overs Fixtures',
      row: 40,
      contains: 'Club Champs',
      kind: 'excluded' as const,
      reason: 'x',
    };
    const ok = parseMens50Sheet(ws, mini50, { rules: [rule], fixes: [] });
    assert.equal(ok.excluded.length, 1);
    const stale = parseMens50Sheet(ws, mini50, { rules: [{ ...rule, row: 41 }], fixes: [] });
    assert.ok(stale.errors.some((e) => /matched no row/.test(e)));
  });

  test('a missing second leg breaks the round robin', () => {
    const { ws } = build50({ H17: null, I17: null, J17: null, K17: null });
    const p = parseMens50Sheet(ws, mini50, noRules);
    assert.ok(p.errors.some((e) => /meet 1 time\(s\), expected 2/.test(e)));
  });
});

/** A 4-team single-round-robin T20 sheet with AM/PM sessions, a side table and a dup row. */
const miniT20 = { ...spec('mensT20'), teams: 4, meetings: 1, expected: 6 };
function buildT20(extra: Record<string, unknown> = {}) {
  const cells: Record<string, unknown> = {
    A1: 'KZN Inland T20',
    B5: 'Pool A',
    B6: 'MCC',
    D6: 'Greytown',
    B7: 'Howick',
    D7: 'Lancashire',
    B11: 'Pool A Fixtures',
    A13: 'Week 1',
    B13: D('2026-10-04'),
    D13: 'Sunday AM ',
    B15: 'MCC',
    C15: 'vs ',
    D15: 'Greytown',
    E15: 'Linpark',
    B16: 'Howick',
    C16: 'vs',
    D16: 'Lancashire',
    E16: 'Howick High',
    D18: 'Sunday PM',
    B19: 'MCC',
    C19: 'vs',
    D19: 'Howick',
    E19: 'TBC',
    B20: 'Greytown',
    C20: 'vs',
    D20: 'Lancashire',
    E20: 'MP Oval',
    A22: 'Week 2',
    B22: D('2026-10-11'),
    D22: 'Sunday PM',
    H22: 'Date',
    I22: 'Fixture',
    L22: 'Venue',
    M22: 'Time',
    B23: 'Lancashire',
    C23: 'vs',
    D23: 'MCC',
    E23: 'PMB Oval',
    H23: D('2026-10-09'),
    I23: 'MCC',
    J23: 'vs',
    K23: 'Greytown',
    L23: 'PMB Oval',
    M23: T('18:00'),
    B24: 'Greytown',
    C24: 'vs',
    D24: 'Howick',
    E24: 'Wembley College',
    A26: 'Week 3',
    B26: D('2026-10-11'),
    D26: 'Sunday PM',
    B27: 'Lancashire',
    C27: 'vs',
    D27: 'MCC',
    E27: 'PMB Oval',
  };
  return sheet('Prem T20 Fixtures', { ...cells, ...extra });
}
const t20Opts = {
  rules: [
    {
      workbook: 'mens' as const,
      sheet: 'Prem T20 Fixtures',
      row: 27,
      contains: 'vs',
      kind: 'duplicate' as const,
      duplicateOf: 23,
      reason: 'repeat',
    },
  ],
  fixes: [],
  reschedules: [
    { home: 'MCC', away: 'Greytown', date: '2026-10-09', time: '18:00', venue: 'PMB Oval' },
  ],
};

describe('parseMensT20Sheet', () => {
  test('sessions, side-table reschedule, duplicate exclusion, TBC', () => {
    const { ws } = buildT20();
    const p = parseMensT20Sheet(ws, miniT20, t20Opts);
    assert.deepEqual(p.errors, []);
    assert.equal(p.fixtures.length, 6);
    const moved = p.fixtures.find((f) => f.row === 15)!;
    assert.deepEqual(
      [moved.date, moved.time, moved.venue, moved.timeSource],
      ['2026-10-09', '18:00', 'PMB Oval', 'side-table'],
    );
    assert.deepEqual(moved.rescheduledFrom, {
      date: '2026-10-04',
      time: '09:00',
      venue: 'Linpark Oval',
    });
    assert.equal(p.fixtures.find((f) => f.row === 19)!.time, '13:30');
    assert.equal(p.fixtures.find((f) => f.row === 19)!.venue, null);
    assert.equal(p.excluded.length, 1);
  });

  test('a side table that disagrees with the manifest is fatal', () => {
    const { ws } = buildT20({ M23: T('17:30') });
    assert.ok(parseMensT20Sheet(ws, miniT20, t20Opts).errors.some((e) => /side table/.test(e)));
  });

  test('a "duplicate" row that differs from its kept row is fatal', () => {
    const { ws } = buildT20({ E27: 'MP Oval' });
    assert.ok(
      parseMensT20Sheet(ws, miniT20, t20Opts).errors.some((e) => /listed as a duplicate/.test(e)),
    );
  });
});

/** A 3-team vets sheet: two blocks, mixed text/Excel times, December break, playoff. */
const miniVets = { ...spec('vets'), teams: 3, meetings: 1, expected: 3 };
function buildVets(extra: Record<string, unknown> = {}) {
  const title = 'KZN Inland Veterans League T20 Season 2026/2027';
  const cells: Record<string, unknown> = {
    A1: title,
    B1: title,
    C1: title,
    C3: 'Veterans Teams',
    C5: 'Midlands CC',
    C6: 'UKZN CC',
    C7: 'Cosmos CC',
    C13: 'T20 Night League',
    B15: 'Week 1',
    C15: D('2026-11-06'),
    E15: 'Friday',
    F15: 'Venue',
    G15: 'Time',
    I15: 'Week 2',
    J15: D('2027-01-16'),
    L15: 'Satruday',
    M15: 'Venue',
    N15: 'Time',
    C16: 'UKZN Vets',
    D16: 'vs',
    E16: 'Cosmos Vets',
    F16: 'Varsity 1',
    G16: '18:30',
    J16: 'Cosmos Vets',
    K16: 'vs',
    L16: 'Midlands Vets',
    M16: 'Varstiy 1',
    N16: T('18:30'),
    C18: 'Midlands Vets',
    D18: 'vs',
    E18: 'UKZN Vets',
    F18: 'Eston',
    G18: T('18:30'),
    I20: 'Eliminator',
    J20: D('2027-01-30'),
    L20: 'Saturday',
    M20: 'Venue',
    N20: 'Time',
    J21: '2nd Place',
    K21: 'vs',
    L21: '3rd Place',
    M21: 'T.B.C',
    N21: '18:30',
    I23: 'Final',
    J23: D('2027-02-06'),
    L23: 'Saturday',
    M23: 'Venue',
    N23: 'Time',
    J24: '1st Place',
    K24: 'vs',
    L24: 'Winner Eliminator',
    M24: 'T.B.C',
    N24: '18:30',
    C26: 'December Break',
    E26: 'December Break',
  };
  return sheet('Veterans Fixtures', { ...cells, ...extra });
}

describe('parseVetsSheet', () => {
  const noRules = { rules: [], fixes: [] };
  test('both blocks, times, weekday typo, playoff slot refs', () => {
    const { ws } = buildVets();
    const p = parseVetsSheet(ws, miniVets, noRules);
    assert.deepEqual(p.errors, []);
    assert.equal(p.fixtures.length, 3);
    assert.ok(p.fixtures.every((f) => f.time === '18:30' && f.timeSource === 'sheet'));
    assert.equal(
      p.fixtures.find((f) => f.row === 16 && f.date === '2027-01-16')!.venue,
      'Varsity 1 Oval',
    );
    assert.deepEqual(
      p.ko.map((k) => [k.fixtureId, k.stage, k.home, k.away]),
      [
        ['f1', 'Eliminator', 'pos:s-tuskers-veterans-league:2', 'pos:s-tuskers-veterans-league:3'],
        ['f2', 'Final', 'pos:s-tuskers-veterans-league:1', 'win:f1'],
      ],
    );
  });

  test('a weekday banner that disagrees with its date is fatal', () => {
    const { ws } = buildVets({ E15: 'Saturday' });
    assert.ok(parseVetsSheet(ws, miniVets, noRules).errors.some((e) => /is a FRIDAY/.test(e)));
  });

  test('a fixture without a time is fatal', () => {
    const { ws } = buildVets({ G18: null });
    assert.ok(parseVetsSheet(ws, miniVets, noRules).errors.some((e) => /no time/.test(e)));
  });
});

describe('build + release gate', () => {
  const clubs = cli.clubsFromMap();
  const venues = cli.wouldBeRegistry();

  function parsedVets() {
    const { ws } = buildVets();
    return parseVetsSheet(ws, miniVets, { rules: [], fixes: [] });
  }

  test('participants are clubs (teamId === clubId); venues locked; KO series built', () => {
    const out = cli.buildTuskersSeries([parsedVets()], {
      clubs,
      venues,
      leagueLabel: (k) => k,
    });
    assert.deepEqual(out.missingClubs, []);
    assert.equal(out.series.length, 2);
    const [league, ko] = out.series;
    assert.ok(league.participants!.every((p) => p.teamId === p.clubId));
    assert.equal(out.locked, 3);
    assert.equal(league.approved, false);
    assert.equal(league.released, false);
    assert.equal(ko.id, 's-tuskers-veterans-league-ko');
    assert.equal((ko.fixtures as Array<{ away: string }>)[1].away, 'win:f1');
  });

  test('--map-club re-targets a club id; a missing club is reported', () => {
    const mapping = new Map([['ukzn-cricket-club', 'ukzn-cc-pmb']]);
    const out = cli.buildTuskersSeries([parsedVets()], {
      clubs,
      venues,
      leagueLabel: (k) => k,
      mapping,
    });
    assert.deepEqual(out.missingClubs, ['ukzn-cc-pmb']);
  });

  test('re-import keeps stored ids; the KO Final keeps pointing at the Eliminator', () => {
    const first = cli.buildTuskersSeries([parsedVets()], { clubs, venues, leagueLabel: (k) => k });
    const stored = first.series.map((s) => {
      const fx = (s.fixtures as Array<{ id: string; away: string }>).map((f) => ({ ...f }));
      // Simulate a history where the stored ids were renumbered (f7/f8 for the KO).
      if (s.id === 's-tuskers-veterans-league-ko') {
        fx[0].id = 'f7';
        fx[1].away = 'win:f7';
        fx[1].id = 'f8';
      }
      return { ...s, fixtures: fx, version: 3 } as Series;
    });
    const again = cli.buildTuskersSeries([parsedVets()], {
      clubs,
      venues,
      leagueLabel: (k) => k,
      stored,
    });
    const ko = again.series[1].fixtures as Array<{ id: string; away: string }>;
    assert.deepEqual(
      ko.map((f) => f.id),
      ['f7', 'f8'],
    );
    assert.equal(ko[1].away, 'win:f7');
  });

  test('planRelease holds a clashing series and releases the rest', () => {
    const { series } = cli.buildTuskersSeries([parsedVets()], {
      clubs,
      venues,
      leagueLabel: (k) => k,
    });
    const league = series[0];
    const f = (league.fixtures as Array<Record<string, unknown>>)[0];
    const clashing = {
      id: 's-other',
      name: 'Other',
      leagueKey: 'x',
      fixtures: [{ ...f, id: 'f1', home: 'midlands-cricket-club', away: 'cosmos-cricket-club' }],
      participants: [],
      released: true,
    } as unknown as Series;
    const all = [...series, clashing];
    const plan = cli.planRelease(
      series,
      all,
      clubs,
      venues,
      map.TUSKERS_GATE_ALIASES,
      '2026-11-05T10:00:00Z',
    );
    assert.deepEqual(
      plan.held.map((h) => h.series.id),
      [league.id],
    );
    assert.deepEqual(
      plan.release.map((r) => r.next.id),
      ['s-tuskers-veterans-league-ko'],
    );
    const next = plan.release[0].next;
    assert.equal(next.approved, true);
    assert.equal(next.released, true);
    assert.equal(next.releasedAt, '2026-11-05T10:00:00Z');
    const clean = cli.planRelease(series, series, clubs, venues, map.TUSKERS_GATE_ALIASES, 'now');
    assert.equal(clean.held.length, 0);
    assert.equal(clean.release.length, 2);
  });

  test('release preamble refuses reminders or medicoach sync', () => {
    const base = { tenant: 'tuskers' } as never;
    assert.deepEqual(cli.releasePreambleBlockers(base), []);
    assert.equal(
      cli.releasePreambleBlockers({
        ...(base as object),
        features: { medicoachSync: true },
      } as never).length,
      1,
    );
    assert.equal(
      cli.releasePreambleBlockers({
        ...(base as object),
        fixtureReminders: { enabled: true, leadDays: [1], channels: [] },
      } as never).length,
      1,
    );
    assert.equal(cli.releasePreambleBlockers(null).length, 1);
  });

  test('release scope is the manifest writable ids, never a prefix sweep', () => {
    const mk = (id: string) => ({ id, fixtures: [] }) as unknown as Series;
    const all = [
      ...map.WRITABLE_SERIES_IDS.map(mk),
      mk(map.T20_KO_SERIES_ID),
      mk('s-tuskers-something-else'),
      mk('s-other'),
    ];
    const ids = (xs: Series[]) => xs.map((s) => String(s.id));
    assert.deepEqual(ids(cli.releaseCandidates(all, () => true)), map.WRITABLE_SERIES_IDS);
    assert.ok(!ids(cli.releaseCandidates(all, () => true)).includes(map.T20_KO_SERIES_ID));
    assert.deepEqual(ids(cli.releaseCandidates(all, (id) => id === map.VETS_SERIES_ID)), [
      map.VETS_SERIES_ID,
    ]);
  });

  test('--only scopes the fatal gate inputs to the in-scope series (still fail-closed)', () => {
    const outcome = {
      missingClubs: ['club-a', 'club-b'],
      registryMisses: new Map([['Ground X', 3]]),
    } as never;
    const built = [
      {
        id: map.VETS_SERIES_ID,
        leagueKey: 'veterans-league',
        teams: ['club-b', 'club-c'],
        fixtures: [{ venueOverride: 'Ground X' }, {}],
      },
    ] as unknown as Series[];
    const all = cli.scopedGateInputs(outcome, built, false);
    assert.deepEqual(all.missingClubs, ['club-a', 'club-b']);
    assert.deepEqual(all.leagueKeys, map.TUSKERS_LEAGUE_KEYS);
    assert.equal(all.registryMisses, 3);
    const scoped = cli.scopedGateInputs(outcome, built, true);
    assert.deepEqual(scoped.missingClubs, ['club-b']);
    assert.deepEqual(scoped.leagueKeys, ['veterans-league']);
    assert.equal(scoped.registryMisses, 1);
  });
});

describe('CLI args', () => {
  test('modes, --only slugs, no --allow-clashes', () => {
    const a = cli.parseArgs(
      ['--release', '--confirm', '--only', 'veterans-league'],
      new Date('2026-11-05'),
    );
    assert.equal(a.mode, 'release');
    assert.deepEqual(a.only, ['s-tuskers-veterans-league']);
    assert.throws(() => cli.parseArgs(['--allow-clashes']), /does not exist/);
    assert.throws(() => cli.parseArgs(['--only', 'premier-league-t20-ko']), /unknown series/);
    assert.throws(() => cli.parseArgs(['--parse-only', '--confirm']));
    assert.throws(() => cli.parseArgs(['--release', '--parse-only']));
    assert.throws(() => cli.parseArgs(['--map-club', 'nope=x']));
  });
});

describe('bootstrap helpers', () => {
  test('clubPlan creates only the absent vets clubs and flags a missing union club', () => {
    const have = new Set(TUSKERS_TEAMS.filter((t) => !t.created).map((t) => t.id));
    have.add('zingari-cricket-club');
    const plan = boot.clubPlan(have);
    assert.deepEqual(
      plan.create.map((c) => c.id),
      ['midlands-cricket-club', 'cosmos-cricket-club'],
    );
    assert.deepEqual(plan.missing, []);
    have.delete('lancashire-cricket-club');
    have.add('lancashire-cricket-club-pmb');
    assert.deepEqual(boot.clubPlan(have).missing, ['lancashire-cricket-club']);
    assert.deepEqual(
      boot.clubPlan(have, new Map([['lancashire-cricket-club', 'lancashire-cricket-club-pmb']]))
        .missing,
      [],
    );
  });

  test('buildVetsClub carries no contacts and no leagues', () => {
    const c = boot.buildVetsClub(
      { id: 'cosmos-cricket-club', name: 'Cosmos Cricket Club' },
      [],
      'uMgungundlovu District',
    ) as Club;
    assert.equal(c.chair, '');
    assert.deepEqual(c.leagues, []);
    assert.equal(c.district, 'uMgungundlovu District');
  });

  test('aliasMerge adds missing keys and reports conflicts', () => {
    const [k] = Object.keys(TUSKERS_VENUE_ALIASES);
    const r = boot.aliasMerge({
      competitionDefaults: { venueAliases: { [k]: 'elsewhere' } },
    } as never);
    assert.equal(r.conflicts.length, 1);
    assert.ok(!(k in r.add));
  });

  test('registryDiff reuses an existing row matched through the aliases', () => {
    const wanted = cli.wouldBeRegistry();
    const existing = [{ id: 'v-linpark', name: 'Linpark', surfaces: 2 }] as never[];
    const d = boot.registryDiff(wanted, existing, map.TUSKERS_GATE_ALIASES);
    assert.equal(d.matched.length, 1);
    assert.equal(d.matched[0].existing.id, 'v-linpark');
    assert.equal(d.create.length, wanted.length - 1);
  });
});

// ───────────────────────── Real workbooks (skip when absent) ─────────────────────────

const MENS = process.env.TUSKERS_MENS_XLSX ?? cli.DEFAULT_PATHS.mens;
const VETS = process.env.TUSKERS_VETS_XLSX ?? cli.DEFAULT_PATHS.vets;
const haveReal = existsSync(MENS) && existsSync(VETS);

describe(
  'real KZNICU workbooks',
  { skip: haveReal ? false : 'workbooks not on this machine' },
  () => {
    test('parse clean at the frozen counts, with every listed rule applied', async () => {
      const { sheets, errors } = await cli.parseFiles({ mens: MENS, vets: VETS });
      assert.deepEqual(errors, []);
      assert.deepEqual(
        sheets.map((s) => [s.spec.seriesId, s.fixtures.length, s.ko.length]),
        TUSKERS_FIXTURE_SHEETS.map((s) => [s.seriesId, s.expected, s.koRows]),
      );
      assert.equal(
        sheets.reduce((n, s) => n + s.excluded.length, 0),
        EXCLUDED_ROWS.length,
      );
      assert.equal(
        sheets.find((s) => s.spec.layout === 'mensT20')!.reschedules.length,
        T20_RESCHEDULES.length,
      );
      const out = cli.buildTuskersSeries(sheets, {
        clubs: cli.clubsFromMap(),
        venues: cli.wouldBeRegistry(),
        leagueLabel: (k) => k,
      });
      assert.equal(out.registryMisses.size, 0);
      assert.deepEqual(
        cli.scanClashes(out.series, [], cli.clubsFromMap(), cli.wouldBeRegistry()),
        [],
      );
    });
  },
);
