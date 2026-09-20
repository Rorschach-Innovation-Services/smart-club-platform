/**
 * Unit tests for the Titans contact-workbook parser + mappers. Pure — no dynalite, no
 * repo.js, nothing touches DynamoDB/S3. Parse tests build a REAL exceljs workbook in-test
 * (structurally faithful to the union's sheet: trailing-space sheet name, preamble rows,
 * section rows, the "Chariman" typo, a missing cell, a landline, combined designations, a
 * leading-space mixed-case email) with entirely invented names/numbers — no real PII.
 * Mapping/resolution tests call the pure functions directly. Same style as
 * test/import-titans.test.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const { parseContactsWorkbook, mapDesignation, resolveClubs, normalizeClubName } =
  await import('../src/titans-contacts-parse.js');

// ───────────────────────── Workbook fixtures (synthetic, no real PII) ─────────────────────────

type Row = [string, string, string, string, string]; // NAME | SURNAME | DESIGNATION | Cellphone | E-mail

/** Build a contact workbook: two preamble rows, the header, then the given data rows. */
function buildWorkbook(dataRows: Row[], sheetName = 'CLUB CONTACT LIST '): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(['TITANS CLUB CHAIRMANS CONTACT LIST - 2026-2027', '', '', '', '']);
  ws.addRow(['', '', '', '', '']);
  ws.addRow(['NAME', 'SURNAME', 'DESIGNATION', 'Cellphone', 'E-mail']);
  for (const r of dataRows) ws.addRow(r);
  return wb;
}

/** A section header row: only the DESIGNATION cell filled. */
const section = (clubName: string): Row => ['', '', clubName, '', ''];

describe('parseContactsWorkbook — sections, people, and row shape', () => {
  const wb = buildWorkbook([
    section('ADELAAR'),
    ['Aden', 'Schadle', 'Chairman', '081 869 5204', '  Aden@Example.COM'],
    ['Bea', 'Molefe', 'Treasurer', '0829782786', 'bea@example.com'],
    section('TUT'),
    ['Cody', 'Naidoo', 'Chairman', '012  382 5396', 'cody@example.com'], // landline-shaped cell
    ['Dina', 'Petersen', 'Secretary', '', 'dina@example.com'], // no cell on file
  ]);
  const parsed = parseContactsWorkbook(wb);

  test('finds the sheet by its trimmed name despite the trailing space', () => {
    assert.equal(parsed.sheetName, 'CLUB CONTACT LIST ');
  });

  test('collects every section header in order', () => {
    assert.deepEqual(parsed.sections, ['ADELAAR', 'TUT']);
  });

  test('collects every person and assigns them to the current section', () => {
    assert.equal(parsed.people.length, 4);
    assert.deepEqual(
      parsed.people.map((p) => [p.fullName, p.section]),
      [
        ['Aden Schadle', 'ADELAAR'],
        ['Bea Molefe', 'ADELAAR'],
        ['Cody Naidoo', 'TUT'],
        ['Dina Petersen', 'TUT'],
      ],
    );
  });

  test('emails are trimmed + lowercased; a leading-space mixed-case email is normalised', () => {
    assert.equal(parsed.people[0].email, 'aden@example.com');
  });

  test('a person with no cell on file keeps a blank cell, never a fabricated one', () => {
    const dina = parsed.people.find((p) => p.surname === 'Petersen')!;
    assert.equal(dina.cell, '');
  });

  test('no stray/unexplained rows for a clean sheet', () => {
    assert.deepEqual(parsed.strayRows, []);
  });
});

describe('parseContactsWorkbook — fail-closed on a bad workbook', () => {
  test('a sheet missing the DESIGNATION column is rejected, not parsed to empty', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('CLUB CONTACT LIST');
    ws.addRow(['NAME', 'SURNAME', 'Cellphone', 'E-mail']); // no DESIGNATION header
    ws.addRow(['Aden', 'Schadle', '081 869 5204', 'aden@example.com']);
    assert.throws(() => parseContactsWorkbook(wb), /NAME\/SURNAME\/DESIGNATION/);
  });

  test('a workbook with no contact sheet at all throws, listing what it checked', () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Random Sheet').addRow(['just', 'some', 'data']);
    assert.throws(() => parseContactsWorkbook(wb), /contact header/);
  });

  test('falls back to a renamed sheet that still carries a contact header', () => {
    const wb = buildWorkbook(
      [section('ADELAAR'), ['Aden', 'Schadle', 'Chairman', '', 'a@b.com']],
      'Sheet1',
    );
    const parsed = parseContactsWorkbook(wb);
    assert.equal(parsed.people.length, 1);
    assert.equal(parsed.sheetName, 'Sheet1');
  });
});

describe('mapDesignation — designation → role mapping branches', () => {
  test('a plain chairman maps to the chair slot', () => {
    assert.deepEqual(mapDesignation('Chairman'), { excoKey: 'chair' });
  });

  test('the "Chariman" typo (Eersterust) still maps to chair', () => {
    assert.equal(mapDesignation('Chariman').excoKey, 'chair');
  });

  test('vice/deputy maps to vc, and beats the embedded "Chairman" in "Vice Chairman"', () => {
    assert.equal(mapDesignation('Vice Chairman').excoKey, 'vc');
    assert.equal(mapDesignation('Deputy Chairperson').excoKey, 'vc');
  });

  test('treasurer and secretary map to their slots', () => {
    assert.equal(mapDesignation('Treasurer').excoKey, 'tre');
    assert.equal(mapDesignation('Club Secretary').excoKey, 'sec');
    assert.equal(mapDesignation('Secretariat').excoKey, 'sec'); // /secretar/ stem
  });

  test('coach and "Director of Cricket" map to coach (not an exco slot)', () => {
    assert.deepEqual(mapDesignation('Head Coach'), { coach: true });
    assert.deepEqual(mapDesignation('Director of Cricket'), { coach: true });
  });

  test('admin/manager is recognised (invited) but claims no slot and is not unmapped', () => {
    assert.deepEqual(mapDesignation('Club Administrator'), {});
    assert.deepEqual(mapDesignation('Team Manager'), {});
  });

  test('an unrecognised designation is flagged unmapped (still invited by the CLI)', () => {
    assert.deepEqual(mapDesignation('Groundsman'), { unmapped: true });
  });

  test('a comma-split designation: the FIRST role-bearing segment wins the slot', () => {
    const m = mapDesignation('Chairman, 1st Men and Ladies, Pta 3');
    assert.equal(m.excoKey, 'chair');
  });

  test('a slash-split designation resolves on its first segment', () => {
    assert.equal(mapDesignation('Club Chairman/ 1st Team & Snr Womens').excoKey, 'chair');
  });

  test('"Vice Chairman and Treasurer" claims ONE slot (vc) and reports the extra role', () => {
    const m = mapDesignation('Vice Chairman and Treasurer');
    assert.equal(m.excoKey, 'vc');
    assert.deepEqual(m.extraRoles, ['treasurer']);
  });

  test('a combined coach+exco designation carries both the slot and the coach flag', () => {
    const m = mapDesignation('IVCC Director of Cricket, Mens & Womens Head Coach');
    assert.equal(m.coach, true);
    assert.equal(m.excoKey, undefined);
    assert.equal(m.unmapped, undefined);
  });
});

describe('resolveClubs — section → live-club resolution', () => {
  const live = [
    { id: 'adelaar-cricket-club', name: 'Adelaar Cricket Club' },
    { id: 'cbcob-cricket-club', name: 'CBCOB Cricket Club' },
    { id: 'dacc-differently-abled-cricket-club', name: 'DACC (Differently Abled Cricket Club)' },
    { id: 'harlequins-cricket-club', name: 'Harlequins Cricket Club' },
    { id: 'irene-villagers-cricket-club', name: 'Irene Villagers Cricket Club' },
    { id: 'police-cricket-club', name: 'Police Cricket Club' },
    { id: 'pretoria-cricket-club', name: 'Pretoria Cricket Club' },
    { id: 'pretoria-east-cricket-club', name: 'Pretoria East Cricket Club' },
    { id: 'queenswood-cricket-club', name: 'Queenswood Cricket Club' },
  ];

  test('a plain section resolves by normalization alone', () => {
    const r = resolveClubs(['ADELAAR'], live);
    assert.deepEqual(r.matched, [
      { section: 'ADELAAR', clubId: 'adelaar-cricket-club', clubName: 'Adelaar Cricket Club' },
    ]);
  });

  test('the aliased sections resolve to their system clubs', () => {
    const r = resolveClubs(
      [
        'CBC OLD BOYS',
        'DIFFERENTLY ABLED',
        'HARLEQUINS SENIORS',
        'IRENE VILLAGERS CRICKET',
        'POLICE',
        'PRETORIA',
      ],
      live,
    );
    assert.deepEqual(
      r.matched.map((m) => m.clubId),
      [
        'cbcob-cricket-club',
        'dacc-differently-abled-cricket-club',
        'harlequins-cricket-club',
        'irene-villagers-cricket-club',
        'police-cricket-club',
        'pretoria-cricket-club',
      ],
    );
    assert.deepEqual(r.unmatchedSections, []);
  });

  test('"PRETORIA" resolves to Pretoria CC, never Pretoria East', () => {
    const r = resolveClubs(['PRETORIA'], live);
    assert.equal(r.matched[0].clubId, 'pretoria-cricket-club');
  });

  test('a section with no system club (the scorers/umpires associations) is unmatched, never guessed', () => {
    const r = resolveClubs(['TITANS SCORERS ASSOCIATION', 'TITANS UMPIRES ASSCOCIATION'], live);
    assert.deepEqual(r.unmatchedSections, [
      'TITANS SCORERS ASSOCIATION',
      'TITANS UMPIRES ASSCOCIATION',
    ]);
    assert.equal(r.matched.length, 0);
  });

  test('a system club with no section is reported (informational — e.g. Queenswood)', () => {
    const r = resolveClubs(['ADELAAR'], live);
    assert.ok(r.clubsWithoutSection.some((c) => c.id === 'queenswood-cricket-club'));
    assert.ok(!r.clubsWithoutSection.some((c) => c.id === 'adelaar-cricket-club'));
  });

  test('normalizeClubName drops parentheticals and the trailing Cricket Club/CC qualifier', () => {
    assert.equal(normalizeClubName('DACC (Differently Abled Cricket Club)'), 'DACC');
    assert.equal(normalizeClubName('Pretoria Cricket Club'), 'PRETORIA');
    assert.equal(normalizeClubName('CBCOB Cricket Club'), 'CBCOB');
  });
});
