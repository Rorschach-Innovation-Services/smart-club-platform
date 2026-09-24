/**
 * Unit tests for the Tuskers roster import (Phase 2) — ROSTER_SOURCES config sanity,
 * the colMap header assertion, the sheet→league mapping table, Lancashire's BirthDate
 * trichotomy + Status filter, intra-club dedupe (first-source-wins, Howick's DIV 1/2/3
 * collapse), SKIP_ROSTER coverage and TUSKERS_LEAGUES gating. The real rolls are PII, so
 * every row here is SYNTHETIC: IDs are generated with a valid Luhn check digit for a
 * made-up date, never copied from the pack.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { CLUB_MAP, ROSTER_SOURCES, ROSTER_NON_SOURCES, SKIP_ROSTER, TUSKERS_LEAGUES, classifyFile } =
  await import('../src/tuskers-import-map.js');
const {
  REGISTERED_BY,
  dedupeClubRows,
  headerDrift,
  parseTuskersSheet,
  planLeagueAdditions,
  resolveIdentityCell,
  resolveIdCell,
  rosterSourceProblems,
  sheetSetDrift,
  unionClubLeagues,
  yyyymmddToIso,
} = await import('../src/tuskers-roster-parse.js');
const { parseArgs } = await import('../src/import-tuskers-roster.js');
const { luhnValid } = await import('../src/roster-normalize.js');
const { playerNaturalKey } = await import('../src/player-identity.js');
const { clubIdFromName } = await import('../src/club-id.js');

type Spec = (typeof ROSTER_SOURCES)[number]['sheets'][number];

/** A synthetic 13-digit RSA ID for `yymmdd` with a valid Luhn check digit. */
function fakeSaId(yymmdd: string, seq = '0001'): string {
  const body = `${yymmdd}${seq}08`; // 12 digits: date + sequence + citizenship + race digit
  for (let d = 0; d <= 9; d++) if (luhnValid(`${body}${d}`)) return `${body}${d}`;
  throw new Error('unreachable');
}
/** Same body, deliberately WRONG check digit. */
function badChecksumId(yymmdd: string): string {
  const good = fakeSaId(yymmdd);
  return `${good.slice(0, 12)}${(Number(good[12]) + 1) % 10}`;
}

const MCC = clubIdFromName('Maritzburg Cricket Club');
const LCC = clubIdFromName('Lancashire Cricket Club');
const STANDARD = clubIdFromName('Standard Cricket Club');
const HOWICK = clubIdFromName('Howick Cricket Club');
const LEAGUE_KEYS = new Set(TUSKERS_LEAGUES.map((l: { key: string }) => l.key));
const RUN_NOW = '2026-09-24T00:00:00.000Z';

const specOf = (file: string, sheet: string): Spec => {
  const src = ROSTER_SOURCES.find((s: { file: string }) => s.file === file)!;
  return src.sheets.find((s: Spec) => s.name === sheet)!;
};
const LCC_FILE = 'Lancashire CC Club/Lancashire CC Nominal Roll.xlsx';
const HOWICK_FILE = 'Howick CC Club/Howick CC Nominal Roll.xlsx';

/** Build a grid whose header row is the spec's own header, followed by `rows` (objects
 * keyed by header text). */
function gridFor(spec: Spec, rows: Array<Record<string, unknown>>) {
  const header = [...spec.header];
  return {
    name: spec.name,
    rows: [
      { rowNumber: spec.headerRow, cells: header },
      ...rows.map((r, i) => ({
        rowNumber: spec.headerRow + 1 + i,
        cells: header.map((h) => r[h] ?? null),
      })),
    ],
  };
}

describe('ROSTER_SOURCES config', () => {
  test('passes its own static sanity check', () => {
    assert.deepEqual(rosterSourceProblems(ROSTER_SOURCES, LEAGUE_KEYS), []);
  });

  test('a colMap header missing from the header row, or a key outside TUSKERS_LEAGUES, is reported', () => {
    const bad = [
      {
        clubId: MCC,
        file: 'x.xlsx',
        sheets: [
          {
            name: 'S',
            leagueKey: 'div-9',
            headerRow: 1,
            header: ['Name', 'Surname'],
            colMap: { Name: 'firstName', Surname: 'lastName', 'ID No.': 'idNumber' },
          },
        ],
      },
    ];
    const problems = rosterSourceProblems(bad as never, LEAGUE_KEYS);
    assert.ok(problems.some((p: string) => p.includes('"div-9"')));
    assert.ok(problems.some((p: string) => p.includes('"ID No."')));
  });

  test('the sheet → league mapping table is exactly the reviewed one', () => {
    const table = Object.fromEntries(
      ROSTER_SOURCES.map((s: { file: string; sheets: Spec[] }) => [
        s.file,
        Object.fromEntries(s.sheets.map((sh) => [sh.name, sh.leagueKey])),
      ]),
    );
    assert.deepEqual(table, {
      'MCC Club/Maritzburg CC Nominal Roll.xlsx': {
        PREM: 'premier-league',
        'UMG DIV 1': 'div-1',
        'UMG DIV 2': 'div-2',
        'UMG DIV 3': 'div-3',
        VETERANS: 'veterans-league',
        U9: 'u9',
        U11: 'u11',
        U13: 'u13',
        U15: 'u15',
        WOMEN: 'women-s-premier-league',
      },
      [LCC_FILE]: {
        'Premier League 2023': 'premier-league',
        Vets: 'veterans-league',
        U16: 'u16',
        U15: 'u15',
        U13: 'u13',
        U11: 'u11',
        U9: 'u9',
        '3rds': null,
        '4ths': null,
        Women: 'women-s-premier-league',
      },
      'Standard CC Club/Standard CSA Generic Team Return Form 2025_26-1.xlsx': {
        '202526': 'premier-league',
      },
      'Standard CC Club/Standard CC Nominal Roll.xlsx': {
        PREM: 'premier-league',
        'UMG DIV 1': 'div-1',
        'UMG DIV 2': 'div-2',
        'UMG DIV 3': 'div-3',
        VETERANS: 'veterans-league',
        U9: 'u9',
        U11: 'u11',
        U13: 'u13',
        U15: 'u15',
        WOMEN: 'women-s-premier-league',
      },
      [HOWICK_FILE]: {
        PREM: 'premier-league',
        'UMG DIV 1': 'div-1',
        'UMG DIV 2': 'div-2',
        'UMG DIV 3': 'div-3',
        VETERANS: 'veterans-league',
        U9: 'u9',
        U11: 'u11',
        U13: 'u13',
        U15: 'u15',
        WOMEN: 'women-s-premier-league',
      },
    });
  });

  test("Standard's CSA team return is its FIRST source (fresher identities win the dedupe)", () => {
    const standard = ROSTER_SOURCES.filter((s: { clubId: string }) => s.clubId === STANDARD);
    assert.equal(
      standard[0].file,
      'Standard CC Club/Standard CSA Generic Team Return Form 2025_26-1.xlsx',
    );
  });

  test('Howick and the CSA return deliberately do not map their free-text DOB columns', () => {
    for (const sheet of ROSTER_SOURCES.find((s: { file: string }) => s.file === HOWICK_FILE)!
      .sheets)
      assert.ok(!Object.values(sheet.colMap).includes('dob'), sheet.name);
    const csa = specOf(
      'Standard CC Club/Standard CSA Generic Team Return Form 2025_26-1.xlsx',
      '202526',
    );
    assert.ok(!Object.values(csa.colMap).includes('dob'));
  });

  test('every source and non-source is a nominalRoll file of an importable club', () => {
    const skip = new Set(SKIP_ROSTER.map((s: { clubId: string }) => s.clubId));
    for (const file of [
      ...ROSTER_SOURCES.map((s: { file: string }) => s.file),
      ...ROSTER_NON_SOURCES.map((s: { file: string }) => s.file),
    ]) {
      const r = classifyFile(file, file.split('/').slice(1).join('/'));
      assert.deepEqual(r, { kind: 'doc', docKey: 'nominalRoll' }, file);
      const club = CLUB_MAP.find((c: { folder: string }) => c.folder === file.split('/')[0])!;
      assert.ok(!skip.has(club.id), file);
    }
  });
});

describe('SKIP_ROSTER', () => {
  test('is exactly the four no-identity clubs', () => {
    assert.deepEqual(
      SKIP_ROSTER.map((s: { clubId: string }) => s.clubId).sort(),
      [
        clubIdFromName('Young Natalians Cricket Club'),
        clubIdFromName('Masibemunye Cricket Club'),
        clubIdFromName('Greytown Cricket Club'),
        clubIdFromName('UKZN Cricket Club'),
      ].sort(),
    );
  });

  test('SKIP_ROSTER and the roster-source clubs partition CLUB_MAP', () => {
    const skip = SKIP_ROSTER.map((s: { clubId: string }) => s.clubId);
    const sourced = [...new Set(ROSTER_SOURCES.map((s: { clubId: string }) => s.clubId))];
    assert.deepEqual(
      skip.filter((id: string) => sourced.includes(id)),
      [],
    );
    assert.deepEqual(
      [...skip, ...sourced].sort(),
      CLUB_MAP.map((c: { id: string }) => c.id).sort(),
    );
  });
});

describe('header assertion (colMap drift)', () => {
  const spec = specOf(LCC_FILE, 'Vets');

  test('the real header shape passes', () => {
    assert.equal(headerDrift(gridFor(spec, []), spec), null);
  });

  test('a renamed, moved or added header cell aborts', () => {
    const renamed = gridFor(spec, []);
    renamed.rows[0].cells = renamed.rows[0].cells.map((c) => (c === 'BirthDate' ? 'DOB' : c));
    assert.match(headerDrift(renamed, spec)!, /drifted/);

    const extra = gridFor(spec, []);
    extra.rows[0].cells = [...extra.rows[0].cells, 'Nationality'];
    assert.match(headerDrift(extra, spec)!, /drifted/);
  });

  test('trailing blank header cells are tolerated; a missing header row is not', () => {
    const trailing = gridFor(spec, []);
    trailing.rows[0].cells = [...trailing.rows[0].cells, '', null];
    assert.equal(headerDrift(trailing, spec), null);
    assert.match(headerDrift({ name: 'Vets', rows: [] }, spec)!, /missing/);
  });

  test('sheetSetDrift: an unexpected worksheet or a missing one aborts; ignored sheets pass', () => {
    const src = ROSTER_SOURCES.find((s: { file: string }) => s.file === LCC_FILE)!;
    const names = [...src.sheets.map((s: Spec) => s.name), 'Sheet3'];
    assert.deepEqual(sheetSetDrift(names, src), []);
    assert.equal(sheetSetDrift([...names, 'U19'], src).length, 1);
    assert.equal(
      sheetSetDrift(
        names.filter((n: string) => n !== 'Vets'),
        src,
      ).length,
      1,
    );
  });
});

describe("Lancashire's BirthDate trichotomy", () => {
  test('a 13-digit RSA ID (string or numeric cell) is an id', () => {
    const id = fakeSaId('900315');
    assert.deepEqual(resolveIdentityCell(id), { kind: 'id', idNumber: id });
    assert.deepEqual(resolveIdentityCell(Number(id)), { kind: 'id', idNumber: id });
  });

  test('an 8-digit yyyymmdd is a dob (dob-only row), and an impossible one is invalid', () => {
    assert.deepEqual(resolveIdentityCell('20150307'), { kind: 'dob', dob: '2015-03-07' });
    assert.equal(resolveIdentityCell('20151345').kind, 'invalid');
    assert.equal(yyyymmddToIso('20150230'), null);
    assert.equal(yyyymmddToIso('18000101'), null);
  });

  test('a Zimbabwean national ID is foreign (no dob derivable), masked', () => {
    for (const zim of ['12-3456789X12', '12-3456789X-12']) {
      const r = resolveIdentityCell(zim);
      assert.equal(r.kind, 'foreign');
      assert.match((r as { masked: string }).masked, /^\*+$/);
    }
  });

  test('blank is blank; a bad checksum is reported, never promoted', () => {
    assert.equal(resolveIdentityCell('').kind, 'blank');
    assert.equal(resolveIdentityCell(null).kind, 'blank');
    assert.equal(resolveIdentityCell(badChecksumId('900315')).kind, 'bad-checksum');
  });

  test('a union-template ID cell never treats 8 digits as a date', () => {
    assert.equal(resolveIdCell('20150307').kind, 'invalid');
  });
});

describe('parseTuskersSheet — Lancashire export rows', () => {
  const spec = specOf(LCC_FILE, 'Premier League 2023');
  const base = { Gender: 'MALE', Race: 'COL' };
  const ID_A = fakeSaId('900315', '0001');
  const ID_B = fakeSaId('880720', '0002');
  const grid = gridFor(spec, [
    { ...base, Name: 'Aa', Surname: 'Alpha', BirthDate: ID_A, Status: 'Active' },
    { ...base, Name: 'Bb', Surname: 'Bravo', BirthDate: ID_B, Status: '' },
    { ...base, Name: 'Cc', Surname: 'Charlie', BirthDate: fakeSaId('910101'), Status: 'NOT' },
    { ...base, Name: 'Dd', Surname: 'Delta', BirthDate: '12-3456789X12', Status: 'ACTIVE' },
    { ...base, Name: 'Ee', Surname: 'Echo', BirthDate: '20150307', Status: 'Active' },
    { ...base, Name: 'Ff', Surname: 'Foxtrot', BirthDate: '', Status: 'Active' },
    { ...base, Name: 'Gg', Surname: 'Golf', BirthDate: fakeSaId('920202'), Status: 'Left Group' },
    { Name: '', Surname: '' }, // blank row — not counted
  ]);

  test('strict mode: Active + blank Status import, NOT/Left Group excluded, identity exceptions', () => {
    const r = parseTuskersSheet(grid, spec, {
      clubId: LCC,
      runNow: RUN_NOW,
      allowMissingId: false,
    });
    assert.equal(r.totalDataRows, 7);
    assert.deepEqual(
      r.rows.map((x: { player: { lastName: string } }) => x.player.lastName),
      ['Alpha', 'Bravo'],
    );
    assert.equal(r.blankStatus, 1);
    assert.equal(r.dobOnlyWithheld, 1);
    const reasons = r.exceptions.map((e: { reason: string; detail?: string }) => [
      e.reason,
      e.detail,
    ]);
    assert.deepEqual(reasons, [
      ['excluded-status', 'NOT'],
      ['foreign-id-no-dob', undefined],
      ['bad-id', undefined],
      ['no-usable-identity', undefined],
      ['excluded-status', 'Left Group'],
    ]);
  });

  test('--allow-missing-id: the 8-digit-date row imports dob-only', () => {
    const r = parseTuskersSheet(grid, spec, { clubId: LCC, runNow: RUN_NOW, allowMissingId: true });
    const echo = r.rows.find(
      (x: { player: { lastName: string } }) => x.player.lastName === 'Echo',
    )!;
    assert.equal(echo.missingId, true);
    assert.equal(echo.player.dob, '2015-03-07');
    assert.equal(echo.player.idNumber, undefined);
    assert.equal(r.dobOnlyWithheld, 0);
  });

  test('a written row: team from the sheet, registeredBy, reused identity semantics, race synonym', () => {
    const r = parseTuskersSheet(grid, spec, {
      clubId: LCC,
      runNow: RUN_NOW,
      allowMissingId: false,
    });
    const p = r.rows[0].player;
    assert.equal(p.team, 'premier-league');
    assert.equal(p.registeredBy, REGISTERED_BY);
    assert.equal(REGISTERED_BY, 'import:tuskers-compliance-2026');
    assert.equal(p.registeredVia, 'portal');
    assert.equal(p.idType, 'sa-id');
    assert.equal(p.dob, '1990-03-15');
    assert.equal(p.gender, 'Male');
    assert.equal(p.race, 'Coloured');
    assert.equal(
      p.naturalKey,
      playerNaturalKey({
        clubId: LCC,
        firstName: 'Aa',
        lastName: 'Alpha',
        dob: '1990-03-15',
        idType: 'sa-id',
        idNumber: ID_A,
      }),
    );
  });

  test('exceptions never carry an unmasked id', () => {
    const r = parseTuskersSheet(grid, spec, {
      clubId: LCC,
      runNow: RUN_NOW,
      allowMissingId: false,
    });
    for (const e of r.exceptions as Array<{ maskedId?: string }>)
      if (e.maskedId) assert.match(e.maskedId, /^\*+$/);
  });

  test('3rds/4ths rows import with NO team', () => {
    const thirds = specOf(LCC_FILE, '3rds');
    const g = gridFor(thirds, [
      { Name: 'Hh', Surname: 'Hotel', BirthDate: fakeSaId('930303'), Status: 'ACTIVE' },
    ]);
    const r = parseTuskersSheet(g, thirds, { clubId: LCC, runNow: RUN_NOW, allowMissingId: false });
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].player.team, undefined);
  });

  test('the Women sheet (no identity columns) parses but every row is an exception', () => {
    const women = specOf(LCC_FILE, 'Women');
    const g = gridFor(women, [
      { No: 1, Name: 'Ii', Surname: 'India', Gender: 'Female', RACE: 'Indian' },
      { No: 2, Name: 'Jj', Surname: 'Juliet', Gender: 'Female', RACE: 'Indian' },
    ]);
    const r = parseTuskersSheet(g, women, { clubId: LCC, runNow: RUN_NOW, allowMissingId: true });
    assert.equal(r.rows.length, 0);
    assert.equal(r.exceptions.length, 2);
    assert.ok(r.exceptions.every((e: { reason: string }) => e.reason === 'no-usable-identity'));
  });
});

describe('parseTuskersSheet — union template rows', () => {
  test('a non-blank ID that does not clean up, with no dob column, is bad-id (masked)', () => {
    const spec = specOf(HOWICK_FILE, 'UMG DIV 1');
    const g = gridFor(spec, [
      { 'Name:': 'Kk', 'Surname:': 'Kilo', 'ID Number:': `0${fakeSaId('950505')}` }, // 14 digits
      { 'Name:': 'Ll', 'Surname:': 'Lima', 'ID Number:': '' },
    ]);
    const r = parseTuskersSheet(g, spec, { clubId: HOWICK, runNow: RUN_NOW, allowMissingId: true });
    assert.deepEqual(
      r.exceptions.map((e: { reason: string }) => e.reason),
      ['bad-id', 'no-usable-identity'],
    );
    assert.equal((r.exceptions[0] as { maskedId: string }).maskedId, '*'.repeat(14));
  });

  test('MCC juniors: a DOB-only row is withheld in strict mode and written with --allow-missing-id', () => {
    const spec = specOf('MCC Club/Maritzburg CC Nominal Roll.xlsx', 'U11');
    const dob = new Date(Date.UTC(2015, 5, 1));
    const g = gridFor(spec, [{ 'Name:': 'Mm', 'Surname:': 'Mike', 'DOB:': dob }]);
    const strict = parseTuskersSheet(g, spec, {
      clubId: MCC,
      runNow: RUN_NOW,
      allowMissingId: false,
    });
    assert.equal(strict.rows.length, 0);
    assert.equal(strict.dobOnlyWithheld, 1);
    const lax = parseTuskersSheet(g, spec, { clubId: MCC, runNow: RUN_NOW, allowMissingId: true });
    assert.equal(lax.rows[0].player.dob, '2015-06-01');
    assert.equal(lax.rows[0].player.team, 'u11');
    assert.equal(lax.rows[0].player.isMinor, true);
  });

  test("Standard's WOMEN single full-name column splits at the last space", () => {
    const spec = specOf('Standard CC Club/Standard CC Nominal Roll.xlsx', 'WOMEN');
    const g = gridFor(spec, [
      { 'No:': '1.', 'Player Name:': 'Nn Oo Papa', 'ID Number:': fakeSaId('000101') },
    ]);
    const r = parseTuskersSheet(g, spec, {
      clubId: STANDARD,
      runNow: RUN_NOW,
      allowMissingId: false,
    });
    assert.equal(r.rows[0].player.firstName, 'Nn Oo');
    assert.equal(r.rows[0].player.lastName, 'Papa');
  });
});

describe('intra-club dedupe', () => {
  const spec1 = specOf(HOWICK_FILE, 'UMG DIV 1');
  const spec2 = specOf(HOWICK_FILE, 'UMG DIV 2');
  const spec3 = specOf(HOWICK_FILE, 'UMG DIV 3');
  const ids = ['850101', '860202', '870303'].map((d, i) => fakeSaId(d, `000${i + 1}`));
  const people = ids.map((id, i) => ({
    'Name:': `P${i}`,
    'Surname:': `Person${i}`,
    'ID Number:': id,
  }));
  const parse = (spec: Spec, rows: Array<Record<string, unknown>>) =>
    parseTuskersSheet(gridFor(spec, rows), spec, {
      clubId: HOWICK,
      runNow: RUN_NOW,
      allowMissingId: false,
    });

  test("Howick's DIV 1/2/3 repeats collapse to one player each, first sheet wins", () => {
    // DIV 1 carries a corrupted (14-digit) ID for person 2; DIV 2 has the valid one.
    const div1 = parse(spec1, [people[0], people[1], { ...people[2], 'ID Number:': `0${ids[2]}` }]);
    const div2 = parse(spec2, people);
    const div3 = parse(spec3, people);
    const ordered = [div1, div2, div3].flatMap((r) =>
      r.rows.map((row: unknown) => ({ sheet: r.sheet, row })),
    );
    const { kept, dupes } = dedupeClubRows(ordered as never);
    assert.equal(kept.length, 3);
    assert.deepEqual(
      kept.map((k) => k.row.player.team),
      ['div-1', 'div-1', 'div-2'],
    );
    assert.equal(dupes.length, 5);
    assert.ok(dupes.every((d: { via: string }) => d.via === 'naturalKey'));
    assert.equal(div1.exceptions[0].reason, 'bad-id');
  });

  test('an id-based row and a dob-only row for the same name+dob are one person', () => {
    const spec = specOf('Standard CC Club/Standard CC Nominal Roll.xlsx', 'PREM');
    const id = fakeSaId('900315');
    const r = parseTuskersSheet(
      gridFor(spec, [
        { 'Name:': 'Qq', 'Surname:': 'Quebec', 'ID Number:': id },
        { 'Name:': 'qq', 'Surname:': 'QUEBEC', 'DOB:': new Date(Date.UTC(1990, 2, 15)) },
      ]),
      spec,
      { clubId: STANDARD, runNow: RUN_NOW, allowMissingId: true },
    );
    assert.equal(r.rows.length, 2);
    assert.notEqual(r.rows[0].player.naturalKey, r.rows[1].player.naturalKey);
    const { kept, dupes } = dedupeClubRows(
      r.rows.map((row: unknown) => ({ sheet: 'PREM', row })) as never,
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0].row.player.idNumber, id);
    assert.equal(dupes[0].via, 'name+dob');
  });
});

describe('TUSKERS_LEAGUES gating', () => {
  // The live tuskers tenant (operator-created on dev) already has these keys.
  const LIVE_KEYS = new Set([
    'premier-league',
    'promotion-league',
    'women-s-premier-league',
    'women-s-promotion-league',
    'veterans-league',
    'u11',
    'u13',
    'u15',
  ]);

  test('the league catalogue matches the live tenant shape and key set', () => {
    assert.deepEqual(TUSKERS_LEAGUES.map((l: { key: string }) => l.key).sort(), [
      'div-1',
      'div-2',
      'div-3',
      'premier-league',
      'u11',
      'u13',
      'u15',
      'u16',
      'u9',
      'veterans-league',
      'women-s-premier-league',
    ]);
    for (const l of TUSKERS_LEAGUES as Array<{ key: string; group: string; district: string }>) {
      assert.equal(l.group, 'Overarching Leagues', l.key);
      assert.equal(
        l.district,
        l.key.startsWith('div-') ? 'uMgungundlovu Cricket District' : 'All districts',
        l.key,
      );
    }
  });

  test('every sheet league key is a live key or one of the reviewed additions (no parallel keys)', () => {
    const additions = new Set(['div-1', 'div-2', 'div-3', 'u9', 'u16']);
    for (const src of ROSTER_SOURCES)
      for (const sheet of src.sheets as Spec[])
        if (sheet.leagueKey)
          assert.ok(
            LIVE_KEYS.has(sheet.leagueKey) || additions.has(sheet.leagueKey),
            `${src.file} [${sheet.name}] → ${sheet.leagueKey}`,
          );
  });

  test('against the live tenant, the real referenced set appends exactly div-1/2/3 + u9', () => {
    // The keys eligible rows reference on the real pack (--parse-only output).
    const referenced = new Set([
      'div-1',
      'div-2',
      'div-3',
      'premier-league',
      'u11',
      'u13',
      'u15',
      'u9',
      'veterans-league',
    ]);
    const plan = planLeagueAdditions(LIVE_KEYS, referenced, TUSKERS_LEAGUES);
    assert.deepEqual(plan.missing, ['div-1', 'div-2', 'div-3', 'u9']);
    assert.deepEqual(plan.unknown, []);
  });

  test('only referenced-and-missing keys are addable; unreferenced keys never are', () => {
    const plan = planLeagueAdditions(
      new Set(['premier-league']),
      new Set(['premier-league', 'div-2', 'u9']),
      TUSKERS_LEAGUES,
    );
    assert.deepEqual(plan.missing, ['div-2', 'u9']);
    assert.deepEqual(
      plan.addable.map((l: { key: string }) => l.key),
      ['div-2', 'u9'],
    );
    assert.deepEqual(plan.unknown, []);
  });

  test('a referenced key outside TUSKERS_LEAGUES is unknown (the CLI aborts)', () => {
    const plan = planLeagueAdditions(new Set(), new Set(['div-4']), TUSKERS_LEAGUES);
    assert.deepEqual(plan.unknown, ['div-4']);
    assert.deepEqual(plan.addable, []);
  });

  test('idempotent: nothing to add once configured', () => {
    const all = new Set(TUSKERS_LEAGUES.map((l: { key: string }) => l.key));
    assert.deepEqual(planLeagueAdditions(all, all, TUSKERS_LEAGUES).missing, []);
  });

  test('club.leagues is unioned, never shrunk', () => {
    assert.deepEqual(unionClubLeagues(['div-1'], new Set(['premier-league', 'div-1'])), [
      'div-1',
      'premier-league',
    ]);
    assert.equal(unionClubLeagues(['div-1', 'u9'], new Set(['div-1'])), null);
    assert.deepEqual(unionClubLeagues(undefined, new Set(['u9'])), ['u9']);
  });
});

describe('roster CLI flags', () => {
  test('silently-ignored combinations are rejected', () => {
    assert.throws(() => parseArgs(['--revert', '--club', MCC]), /--revert takes no --club/);
    assert.throws(() => parseArgs(['--revert', '--allow-missing-id']), /--allow-missing-id/);
    assert.throws(() => parseArgs(['--revert', '--add-missing-leagues']), /--add-missing-leagues/);
    assert.throws(() => parseArgs(['--dir', '/x', '--parse-only', '--confirm']), /--parse-only/);
    assert.throws(() => parseArgs([]), /requires --dir/);
  });

  test('valid combinations parse', () => {
    const a = parseArgs([
      '--dir',
      '/x',
      '--confirm',
      '--add-missing-leagues',
      '--allow-missing-id',
    ]);
    assert.equal(a.confirm && a.addMissingLeagues && a.allowMissingId, true);
    assert.equal(parseArgs(['--revert', '--confirm']).revert, true);
  });
});
