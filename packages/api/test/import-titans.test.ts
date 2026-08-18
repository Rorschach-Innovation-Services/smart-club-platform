/**
 * Unit tests for the Titans import's pure helpers — filename classification, structure-
 * sheet team-token resolution, and roster-row normalization. Pure — no dynalite, no
 * repo.js, nothing touches DynamoDB/S3; both CLI modules guard their own entry point
 * (`import.meta.url === pathToFileURL(...)`), so importing them here never runs main().
 * Same style as test/import-planb.test.ts.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const {
  CLUB_MAP,
  classifyFile: classifyFileRaw,
  resolveClubToken,
  normalizeTeamToken,
  leagueKeyForSection,
  isKnownStructureAnomaly,
  SKIP_ROSTER,
} = await import('../src/titans-import-map.js');

const {
  findHeaderRow,
  cellString,
  cellDobIso,
  cleanIdCell,
  normalizeGender,
  normalizeRace,
  ageGroupToLeagueKey,
  splitFullName,
  luhnValid,
} = await import('../src/roster-normalize.js');

const { dobFromSaId } = await import('../src/player-identity.js');
const { maskId, findCrossClubDuplicates } = await import('../src/import-titans-roster.js');

const {
  isImportObjectKey,
  revertManifestGate,
  catalogueCoverageProblems,
  readCreatedClubsManifest,
  writeCreatedClubsManifest,
  CREATED_CLUBS_MANIFEST_PATH,
} = await import('../src/import-titans-compliance.js');
const { readFile, writeFile, rm } = await import('node:fs/promises');

/** Typed wrapper: classify and return the result, asserting it's a 'doc' classification
 * (never 'skip'/'unclassified') so `.docKey` narrows cleanly for the tests below. */
function classifyFile(
  rel: string,
  filename: string,
): { kind: string; docKey?: string; reason?: string } {
  return classifyFileRaw(rel, filename);
}

describe('classifyFile — filename classifier over real pack filenames', () => {
  test('leagueEntry, assetsRegister, healthTracker, memberDatabase, constitution match', () => {
    assert.equal(
      classifyFile('Adelaar/2026-27 Club League Entry.xls', '2026-27 Club League Entry.xls').docKey,
      'leagueEntry',
    );
    assert.equal(
      classifyFile(
        'Atteridgeville/Club Assets Register 2026-2027.xlsx',
        'Club Assets Register 2026-2027.xlsx',
      ).docKey,
      'assetsRegister',
    );
    assert.equal(
      classifyFile(
        'Brits/Club Health Tracker Season 2026-2027.xlsx',
        'Club Health Tracker Season 2026-2027.xlsx',
      ).docKey,
      'healthTracker',
    );
    assert.equal(
      classifyFile('Atteridgeville/Clubs Databse 1.xlsx', 'Clubs Databse 1.xlsx').docKey,
      'memberDatabase',
    );
    assert.equal(
      classifyFile(
        'Pretoria Cricket Club/Pretoria_Cricket_Club_2025_26_Player_List.xlsx',
        'Pretoria_Cricket_Club_2025_26_Player_List.xlsx',
      ).docKey,
      'memberDatabase',
    );
    assert.equal(
      classifyFile(
        'Adelaar/Adelaar Cricket Club Constitution.doc',
        'Adelaar Cricket Club Constitution.doc',
      ).docKey,
      'constitution',
    );
  });

  test('agm and chairmansReport and financials match', () => {
    assert.equal(
      classifyFile(
        'Centurion Kavaliers/Centurion Kavaliers - AGM Minutes - 12 August 2026.pdf',
        'Centurion Kavaliers - AGM Minutes - 12 August 2026.pdf',
      ).docKey,
      'agm',
    );
    assert.equal(
      classifyFile(
        'Sinoville Cricket Club/Chairmans Report 2025_2026  19 June 2026.docx',
        'Chairmans Report 2025_2026  19 June 2026.docx',
      ).docKey,
      'chairmansReport',
    );
    assert.equal(
      classifyFile(
        'Centurion Kavaliers/Centurion Kavaliers Cricket Club Financials 2025-2026.pdf',
        'Centurion Kavaliers Cricket Club Financials 2025-2026.pdf',
      ).docKey,
      'financials',
    );
  });

  test('facilityAgreement matches lease/facility/mou/field-agreement/agreement and the bare "Fields.pdf" convention', () => {
    assert.equal(
      classifyFile('DACC/Lease Agreement DACC.pdf', 'Lease Agreement DACC.pdf').docKey,
      'facilityAgreement',
    );
    assert.equal(
      classifyFile('CBCOB/CBCOB Facility.pdf', 'CBCOB Facility.pdf').docKey,
      'facilityAgreement',
    );
    assert.equal(
      classifyFile(
        'Irene Villagers/MOU IVCC and Hatfield Christian School Facility Usage (Signed).pdf',
        'MOU IVCC and Hatfield Christian School Facility Usage (Signed).pdf',
      ).docKey,
      'facilityAgreement',
    );
    assert.equal(
      classifyFile('PHSOB/PHSOB Field Agreement - AvW.pdf', 'PHSOB Field Agreement - AvW.pdf')
        .docKey,
      'facilityAgreement',
    );
    assert.equal(
      classifyFile('Pretoria East/PECC Agreement (Woodhill).pdf', 'PECC Agreement (Woodhill).pdf')
        .docKey,
      'facilityAgreement',
    );
    assert.equal(
      classifyFile('Centurion Kavaliers/Excellentiam Fields.pdf', 'Excellentiam Fields.pdf').docKey,
      'facilityAgreement',
    );
  });

  test('override cases: skip on exact path, regardless of what the regex would say', () => {
    assert.equal(
      classifyFile('Adelaar/Club Committee-  2026 - 2027.pdf', 'Club Committee-  2026 - 2027.pdf')
        .kind,
      'skip',
    );
    assert.equal(
      classifyFile(
        'Queenswood Cricket Club/QCC Club Health Tracker 2026-2027.pdf',
        'QCC Club Health Tracker 2026-2027.pdf',
      ).kind,
      'skip',
    );
    assert.equal(
      classifyFile(
        'Sinoville Cricket Club/Sinoville Contact list 2025-2026.docx',
        'Sinoville Contact list 2025-2026.docx',
      ).kind,
      'skip',
    );
    // The un-overridden sibling in the SAME pair still classifies normally.
    assert.equal(
      classifyFile('Adelaar/Club Committee-  2026 - 2027.xls', 'Club Committee-  2026 - 2027.xls')
        .docKey,
      'committee',
    );
  });

  test('an unrecognised filename is reported unclassified, not guessed at', () => {
    assert.equal(
      classifyFile('Somewhere/mystery-file.pdf', 'mystery-file.pdf').kind,
      'unclassified',
    );
  });
});

describe('normalizeTeamToken / resolveClubToken — structure-sheet name resolution', () => {
  test('a plain numbered team strips to the base club token', () => {
    assert.equal(normalizeTeamToken('TUKS 1'), 'TUKS');
    assert.equal(normalizeTeamToken('IRENE VILLAGERS 2'), 'IRENE VILLAGERS');
  });

  test('a lettered junior side strips to the base club token', () => {
    assert.equal(normalizeTeamToken('ADELAAR B'), 'ADELAAR');
  });

  test('a VETERANS-qualified side strips number then qualifier', () => {
    assert.equal(normalizeTeamToken('PHSOB VETERANS 1'), 'PHSOB');
    assert.equal(normalizeTeamToken('EERSTERUST  VETERANS 1'), 'EERSTERUST');
  });

  test('a stray "CC" suffix is stripped', () => {
    assert.equal(normalizeTeamToken('CENTURION KAVALIERS CC 2'), 'CENTURION KAVALIERS');
  });

  test('HAMMNASKRAAL typo redirects to HAMMANSKRAAL', () => {
    assert.equal(normalizeTeamToken('HAMMNASKRAAL 1'), 'HAMMANSKRAAL');
    assert.equal(resolveClubToken('HAMMNASKRAAL 1')?.folder, 'Hammanskraal');
  });

  test('DIFFERENTLY ABLED resolves to DACC', () => {
    const club = resolveClubToken('DIFFERENTLY ABLED 4');
    assert.equal(club?.folder, 'DACC');
  });

  test('PRETORIA (bare) resolves to Pretoria Cricket Club, not Pretoria East', () => {
    const club = resolveClubToken('PRETORIA 1');
    assert.equal(club?.folder, 'Pretoria Cricket Club');
    const east = resolveClubToken('PRETORIA EAST 1');
    assert.equal(east?.folder, 'Pretoria East');
    assert.notEqual(club?.id, east?.id);
  });

  test('POLICE resolves to Police Cricket Club', () => {
    assert.equal(resolveClubToken('POLICE 2')?.folder, 'Police Cricket Club');
  });

  test('an unresolvable token returns undefined, never a guess', () => {
    assert.equal(resolveClubToken('SOME UNKNOWN CLUB 1'), undefined);
  });

  test('CLUB_MAP has exactly 21 entries with ids derived via clubIdFromName', () => {
    assert.equal(CLUB_MAP.length, 21);
    for (const c of CLUB_MAP) assert.ok(c.id && c.id === c.id.toLowerCase());
  });
});

describe('leagueKeyForSection / isKnownStructureAnomaly', () => {
  test("men's senior division A/B pairs collapse onto one league key", () => {
    assert.equal(leagueKeyForSection('PREMIER LEAGUE DIVISION A'), 'premier-league');
    assert.equal(leagueKeyForSection('PREMIER LEAGUE DIVISION B'), 'premier-league');
  });

  test('junior pool sections collapse onto their age-group key', () => {
    assert.equal(leagueKeyForSection('U/9 SILVER B'), 'u9');
    assert.equal(leagueKeyForSection('U/15 PLATINUM  A'), 'u15'); // double-space variant
  });

  test("women's and veterans sections are recognised but unmapped (null, not undefined)", () => {
    assert.equal(leagueKeyForSection("WOMEN'S PREMIER LEAGUE"), null);
    assert.equal(leagueKeyForSection('VETERANS LEAGUE'), null);
  });

  test('a header the manifest has never seen is undefined (fails the run closed)', () => {
    assert.equal(leagueKeyForSection('SOME NEW LEAGUE NOBODY CONFIGURED'), undefined);
  });

  test('the documented structure anomaly is recognised and nothing else is', () => {
    assert.ok(isKnownStructureAnomaly('JUNIORS ', 'U/11 GOLD A', 'LAERSKOOL MAYVILLE'));
    assert.ok(!isKnownStructureAnomaly('JUNIORS ', 'U/11 GOLD A', 'SOME OTHER TOKEN'));
  });
});

describe('SKIP_ROSTER', () => {
  test('Queenswood is on the roster skip list with a documented reason', () => {
    const entry = SKIP_ROSTER.find(
      (s: { clubId: string }) => s.clubId === 'queenswood-cricket-club',
    );
    assert.ok(entry);
    assert.ok(entry.reason.length > 20);
  });
});

describe('luhnValid — RSA ID check digit', () => {
  test('a correct check digit validates', () => {
    assert.equal(luhnValid('9503015012085'), true);
  });

  test('a transposed check digit (the dominant hand-typed error mode) fails', () => {
    assert.equal(luhnValid('9503015012083'), false);
  });

  test('a padded 13-digit form validates the same way as the unpadded 13-digit form', () => {
    assert.equal(luhnValid('0503015012084'), true);
    assert.equal(luhnValid('0503015012083'), false);
  });
});

describe('cleanIdCell — SA-ID cleanup', () => {
  // '9503015012085' is date-plausible (950301 -> 1 Mar 1995) AND has a correct Luhn
  // check digit — computed once and reused across the "should clean up to a real ID"
  // cases below. '...083' (one digit off) is the dedicated bad-checksum fixture further
  // down: same date, wrong check digit, exactly the transposed-digit case Luhn exists
  // to catch.
  test('a valid 13-digit ID (correct Luhn check digit) passes through', () => {
    const res = cleanIdCell('9503015012085', dobFromSaId);
    assert.equal(res.kind, 'valid');
  });

  test('a 12-digit ID (leading zero lost) is left-padded and accepted when it validates', () => {
    const res = cleanIdCell('503015012084', dobFromSaId);
    assert.equal(res.kind, 'padded');
    if (res.kind === 'padded') assert.equal(res.idNumber, '0503015012084');
  });

  test('a spaced/grouped ID is cleaned to 13 digits', () => {
    const res = cleanIdCell('950301 5012 08 5', dobFromSaId);
    assert.equal(res.kind, 'valid');
  });

  test('a float-cell ".0" artifact is stripped, not treated as a real digit', () => {
    const res = cleanIdCell('503015012084.0', dobFromSaId);
    assert.equal(res.kind, 'padded');
    if (res.kind === 'padded') assert.equal(res.idNumber, '0503015012084');
  });

  test('a stray leading punctuation character is stripped', () => {
    const res = cleanIdCell('*9503015012085', dobFromSaId);
    assert.equal(res.kind, 'valid');
  });

  test('a date-plausible 13-digit ID with a wrong Luhn check digit is bad-checksum, never promoted to valid', () => {
    const res = cleanIdCell('9503015012083', dobFromSaId);
    assert.equal(res.kind, 'bad-checksum');
    if (res.kind === 'bad-checksum') assert.equal(res.idNumber, '9503015012083');
  });

  test('a padded 12-digit ID whose check digit is wrong is bad-checksum, not silently accepted', () => {
    const res = cleanIdCell('503015012083', dobFromSaId); // pads to …083, same wrong check digit
    assert.equal(res.kind, 'bad-checksum');
  });

  test('a Date object in the ID column is date-mangled, unrecoverable as an ID', () => {
    const res = cleanIdCell(new Date(Date.UTC(2013, 3, 5)), dobFromSaId);
    assert.equal(res.kind, 'date-mangled');
    if (res.kind === 'date-mangled') assert.equal(res.isoDate, '2013-04-05');
  });

  test('a DD/MM/YYYY-shaped date string is date-mangled', () => {
    const res = cleanIdCell('05/04/2013', dobFromSaId);
    assert.equal(res.kind, 'date-mangled');
  });

  test("a YYYY/MM/DD-shaped date string (seen in TUKS' junior sheet) is date-mangled", () => {
    const res = cleanIdCell('2013/04/05', dobFromSaId);
    assert.equal(res.kind, 'date-mangled');
  });

  test('a spelled-out month date string is date-mangled', () => {
    const res = cleanIdCell('05 April 2018', dobFromSaId);
    assert.equal(res.kind, 'date-mangled');
  });

  test('wrong digit count that still fails validation is invalid, not silently accepted', () => {
    const res = cleanIdCell('12345', dobFromSaId);
    assert.equal(res.kind, 'invalid');
  });

  test('a well-formed-length ID with an impossible date is invalid, never a false positive', () => {
    const res = cleanIdCell('9599995012083', dobFromSaId); // month 99, day 99
    assert.equal(res.kind, 'invalid');
  });

  test('an empty cell is invalid', () => {
    const res = cleanIdCell('', dobFromSaId);
    assert.equal(res.kind, 'invalid');
  });
});

describe('normalizeGender', () => {
  test('canonical values pass through case-insensitively', () => {
    assert.equal(normalizeGender('Male').value, 'Male');
    assert.equal(normalizeGender('female').value, 'Female');
  });

  test('M/F abbreviations (Police, TUT sheets) normalize to the full canonical value', () => {
    assert.equal(normalizeGender('M').value, 'Male');
    assert.equal(normalizeGender('f').value, 'Female');
  });

  test('an unrecognised value is reported unknown, not guessed at', () => {
    const res = normalizeGender('Senior Womens teams'); // Sinoville's mis-populated column
    assert.equal(res.value, undefined);
    assert.equal(res.unknownRaw, 'Senior Womens teams');
  });

  test('a blank cell normalizes to undefined without an unknownRaw report', () => {
    const res = normalizeGender('');
    assert.equal(res.value, undefined);
    assert.equal(res.unknownRaw, undefined);
  });
});

describe('normalizeRace', () => {
  test('canonical values pass through', () => {
    assert.equal(normalizeRace('White').value, 'White');
    assert.equal(normalizeRace('Indian').value, 'Indian');
  });

  test('"Black" (Mamelodi/Soshanguve convention) maps to the canonical "African"', () => {
    assert.equal(normalizeRace('Black').value, 'African');
  });

  test('"Asian" (Pretoria CC) maps to the canonical "Other"', () => {
    assert.equal(normalizeRace('Asian').value, 'Other');
  });

  test('an unrecognised value is reported unknown', () => {
    const res = normalizeRace('Martian');
    assert.equal(res.value, undefined);
    assert.equal(res.unknownRaw, 'Martian');
  });
});

describe('ageGroupToLeagueKey', () => {
  test('U9/U/11/U 13 forms all resolve', () => {
    assert.equal(ageGroupToLeagueKey('U9').value, 'u9');
    assert.equal(ageGroupToLeagueKey('U/11').value, 'u11');
    assert.equal(ageGroupToLeagueKey('U 13').value, 'u13');
  });

  test('"Under 9"/"Under 15" (Harlequins\' junior sheet) resolve', () => {
    assert.equal(ageGroupToLeagueKey('Under 9').value, 'u9');
    assert.equal(ageGroupToLeagueKey('Under 15').value, 'u15');
  });

  test('a bare number with no prefix (Mamelodi/Atteridgeville) resolves', () => {
    assert.equal(ageGroupToLeagueKey('13').value, 'u13');
  });

  test('DACC\'s "0/9" typo (leading 0 for U) resolves', () => {
    assert.equal(ageGroupToLeagueKey('0/9').value, 'u9');
    assert.equal(ageGroupToLeagueKey('0/11').value, 'u11');
  });

  test('a combined/ambiguous cell ("13&15") is reported unknown, never guessed at', () => {
    const res = ageGroupToLeagueKey('13&15');
    assert.equal(res.value, undefined);
    assert.equal(res.unknownRaw, '13&15');
  });

  test('an out-of-range number (a likely "51" typo for "15") is reported unknown', () => {
    const res = ageGroupToLeagueKey('51');
    assert.equal(res.value, undefined);
  });
});

describe('splitFullName', () => {
  test('splits at the last whitespace run', () => {
    assert.deepEqual(splitFullName('Aden Schadle'), { firstName: 'Aden', lastName: 'Schadle' });
  });

  test('a compound first name splits correctly (surname is the last token)', () => {
    assert.deepEqual(splitFullName('Van Schalkwyk Luke'), {
      firstName: 'Van Schalkwyk',
      lastName: 'Luke',
    });
  });

  test('a single-token name has no surname', () => {
    assert.deepEqual(splitFullName('Cher'), { firstName: 'Cher', lastName: '' });
  });
});

describe('findHeaderRow', () => {
  test('a standard Name/Surname/Gender/Race/ID template maps every field without collision', () => {
    const rows = [
      ['CLUB NAME : X', '', '', '', ''],
      ['CLUB NAME : X', '', '', '', ''],
      ['Name', 'Surname', 'Gender', 'Race', 'ID number (Compulsory)'],
    ];
    const header = findHeaderRow(rows);
    assert.ok(header);
    assert.equal(header!.columns.firstName, 0);
    assert.equal(header!.columns.lastName, 1);
    assert.equal(header!.columns.gender, 2);
    assert.equal(header!.columns.race, 3);
    assert.equal(header!.columns.idNumber, 4);
  });

  test('Pretoria CC\'s "Player First Name"/"Player Surname" template maps correctly', () => {
    const rows = [
      [
        'Player First Name',
        'Player Surname',
        'Nationality',
        'ID Number',
        'Date of Birth',
        'Race',
        'Gender',
      ],
    ];
    const header = findHeaderRow(rows);
    assert.ok(header);
    assert.equal(header!.columns.firstName, 0);
    assert.equal(header!.columns.lastName, 1);
    assert.equal(header!.columns.dob, 4);
  });

  test('Centurion Kavaliers\' combined "Name  & Surname" column resolves as fullName, not lastName-only', () => {
    const rows = [
      ['CLUB NAME : X', '', '', ''],
      ['CLUB NAME : X', '', '', ''],
      ['Name  & Surname', 'Gender', 'Race', 'ID number (Compulsory)'],
    ];
    const header = findHeaderRow(rows);
    assert.ok(header);
    assert.equal(header!.columns.fullName, 0);
    assert.equal(header!.columns.firstName, undefined);
    assert.equal(header!.columns.lastName, undefined);
  });

  test('a closed-parenthetical age-group header strips to "age group"', () => {
    const rows = [
      ['Name', 'Surname', 'ID number (Compulsory)', 'Race', 'Age Group (U9, U11, U13 , u15)'],
    ];
    const header = findHeaderRow(rows);
    assert.equal(header!.columns.ageGroup, 4);
  });

  test('an UNCLOSED parenthetical age-group header (a real typo in the pack) still resolves via startsWith', () => {
    const rows = [
      ['Name', 'Surname', 'ID number (Compulsory)', 'Race', 'Age Group (U9, U11, U13 , u15'],
    ];
    const header = findHeaderRow(rows);
    assert.equal(header!.columns.ageGroup, 4);
  });

  test('names-only sheet with no surname/id column at all finds no header row', () => {
    const rows = [
      ['U9s', 'U11s', 'U13s'],
      ['Riley le Roux', 'Nico Jacobs', 'Jeandré de Bie'],
    ];
    assert.equal(findHeaderRow(rows), null);
  });
});

describe('cellString / cellDobIso', () => {
  test('cellString unwraps richText and formula-result cells', () => {
    assert.equal(cellString({ richText: [{ text: 'Foo' }, { text: ' Bar' }] }), 'Foo Bar');
    assert.equal(cellString({ formula: '=A1', result: 'Baz' }), 'Baz');
  });

  test('cellDobIso reads a real Date cell', () => {
    assert.equal(cellDobIso(new Date(Date.UTC(2013, 3, 5))), '2013-04-05');
  });

  test('cellDobIso reads an ISO string directly', () => {
    assert.equal(cellDobIso('2013-04-05'), '2013-04-05');
  });
});

describe('maskId', () => {
  test('fully masks every digit — no partial digits (not even a DOB prefix) are ever printed', () => {
    assert.equal(maskId('9503015012083'), '*************');
    assert.equal(maskId(''), '');
  });
});

describe('isImportObjectKey — anchored -import- marker match', () => {
  test('a genuine import-written key matches', () => {
    assert.equal(
      isImportObjectKey(
        'titans/adelaar-cricket-club/agm-import-abc123.pdf',
        'adelaar-cricket-club',
        'agm',
      ),
      true,
    );
  });

  test('a rep upload for a docKey ending "-import" is NOT falsely matched (unanchored .includes would match)', () => {
    // Real upload key shape: `${docKey}-${uuid}` — never literally "-import-" again after
    // the docKey boundary, but an unanchored substring test sees "-import-" inside
    // "committee-import-<uuid>" and would wrongly call this an import file.
    assert.equal(
      isImportObjectKey(
        'titans/adelaar-cricket-club/committee-import-9f2c1a30-uuid.pdf',
        'adelaar-cricket-club',
        'committee-import',
      ),
      false,
    );
  });

  test('a key for a DIFFERENT club or docKey never matches, even with the right marker', () => {
    const key = 'titans/adelaar-cricket-club/agm-import-abc123.pdf';
    assert.equal(isImportObjectKey(key, 'other-club', 'agm'), false);
    assert.equal(isImportObjectKey(key, 'adelaar-cricket-club', 'financials'), false);
  });
});

describe('catalogueCoverageProblems — two-directional multiFile assertion', () => {
  const baseDocs = [
    { key: 'leagueEntry', name: 'League Entry' },
    { key: 'assetsRegister', name: 'Assets Register' },
    { key: 'healthTracker', name: 'Health Tracker' },
    { key: 'memberDatabase', name: 'Member Database' },
    { key: 'committee', name: 'Committee' },
    { key: 'constitution', name: 'Constitution' },
    { key: 'chairmansReport', name: 'Chairmans Report' },
    { key: 'financials', name: 'Financials' },
  ];
  const wellFormedMultiDocs = [
    { key: 'agm', name: 'AGM', multiFile: true, minFiles: 1, maxFiles: 10 },
    {
      key: 'facilityAgreement',
      name: 'Facility Agreement',
      multiFile: true,
      minFiles: 1,
      maxFiles: 10,
    },
  ];

  test('a well-formed catalogue (forward direction satisfied, no other key multiFile) reports nothing', () => {
    const problems = catalogueCoverageProblems(
      [...baseDocs, ...wellFormedMultiDocs] as never,
      new Map(),
    );
    assert.deepEqual(problems, []);
  });

  test('forward: agm configured single-file (not multiFile) is reported', () => {
    const docs = [
      ...baseDocs,
      { key: 'agm', name: 'AGM' }, // multiFile omitted
      wellFormedMultiDocs[1],
    ];
    const problems = catalogueCoverageProblems(docs as never, new Map());
    assert.ok(problems.some((p) => p.includes('"agm"') && p.includes('single-file')));
  });

  test('reverse: an unrelated key (committee) marked multiFile is reported, even though the forward direction is fine', () => {
    const docs = [
      ...baseDocs.filter((d) => d.key !== 'committee'),
      { key: 'committee', name: 'Committee', multiFile: true, minFiles: 1, maxFiles: 5 },
      ...wellFormedMultiDocs,
    ];
    const problems = catalogueCoverageProblems(docs as never, new Map());
    assert.ok(
      problems.some((p) => p.includes('"committee"') && p.includes('multiFile')),
      `expected a "committee" multiFile problem, got: ${JSON.stringify(problems)}`,
    );
  });
});

describe('created-clubs manifest — read/write durability', () => {
  let originalRaw: string | undefined;

  before(async () => {
    try {
      originalRaw = await readFile(CREATED_CLUBS_MANIFEST_PATH, 'utf8');
      await rm(CREATED_CLUBS_MANIFEST_PATH);
    } catch {
      originalRaw = undefined;
    }
  });

  after(async () => {
    if (originalRaw === undefined) {
      await rm(CREATED_CLUBS_MANIFEST_PATH, { force: true });
    } else {
      await writeFile(CREATED_CLUBS_MANIFEST_PATH, originalRaw);
    }
  });

  test('a missing manifest reads as "absent", never "corrupt" or an empty ok set', async () => {
    await rm(CREATED_CLUBS_MANIFEST_PATH, { force: true });
    const result = await readCreatedClubsManifest();
    assert.equal(result.kind, 'absent');
  });

  test('a well-formed manifest round-trips through write then read', async () => {
    await writeCreatedClubsManifest(new Set(['club-a', 'club-b']));
    const result = await readCreatedClubsManifest();
    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') {
      assert.deepEqual([...result.ids].sort(), ['club-a', 'club-b']);
    }
  });

  test('invalid JSON is reported "corrupt", distinct from "absent" — never silently treated as zero clubs', async () => {
    await writeFile(CREATED_CLUBS_MANIFEST_PATH, '{ not valid json');
    const result = await readCreatedClubsManifest();
    assert.equal(result.kind, 'corrupt');
    if (result.kind === 'corrupt') assert.match(result.detail, /JSON/);
  });

  test('well-formed JSON that is not an array of strings is also reported "corrupt"', async () => {
    await writeFile(CREATED_CLUBS_MANIFEST_PATH, JSON.stringify({ notAnArray: true }));
    const firstResult = await readCreatedClubsManifest();
    assert.equal(firstResult.kind, 'corrupt');

    await writeFile(CREATED_CLUBS_MANIFEST_PATH, JSON.stringify(['ok-id', 42]));
    const secondResult = await readCreatedClubsManifest();
    assert.equal(secondResult.kind, 'corrupt');
  });
});

describe('findCrossClubDuplicates', () => {
  test('an idNumber claimed by two different clubs is reported and ALL rows excluded', () => {
    // Same idNumber ⇒ same naturalKey in real data (naturalKey is derived FROM the id) —
    // the fixture reflects that invariant rather than hand-picking distinct keys.
    const rowA = { player: { naturalKey: 'nkSame', idNumber: '9503015012085' } };
    const rowB = { player: { naturalKey: 'nkSame', idNumber: '9503015012085' } };
    const { duplicateNaturalKeys, report } = findCrossClubDuplicates([
      { clubId: 'club-a', clubName: 'Club A', row: rowA as never },
      { clubId: 'club-b', clubName: 'Club B', row: rowB as never },
    ]);
    assert.equal(report.length, 1);
    assert.ok(duplicateNaturalKeys.has('club-a::nkSame'));
    assert.ok(duplicateNaturalKeys.has('club-b::nkSame'));
  });

  test('a dob-only identity (no idNumber) claimed by two different clubs is caught too — --allow-missing-id must not exempt it', () => {
    const rowA = { player: { naturalKey: 'nkDobOnly', dob: '2010-05-01' } };
    const rowB = { player: { naturalKey: 'nkDobOnly', dob: '2010-05-01' } };
    const { duplicateNaturalKeys, report } = findCrossClubDuplicates([
      { clubId: 'club-a', clubName: 'Club A', row: rowA as never },
      { clubId: 'club-b', clubName: 'Club B', row: rowB as never },
    ]);
    assert.equal(report.length, 1);
    assert.match(report[0], /dob-only match/);
    assert.doesNotMatch(report[0], /2010-05-01/); // never print a raw dob (PII)
    assert.ok(duplicateNaturalKeys.has('club-a::nkDobOnly'));
    assert.ok(duplicateNaturalKeys.has('club-b::nkDobOnly'));
  });

  test('the same club claiming the same identity twice is not a cross-club duplicate', () => {
    const rowA = { player: { naturalKey: 'nkSame', idNumber: '9503015012085' } };
    const rowB = { player: { naturalKey: 'nkSame', idNumber: '9503015012085' } };
    const { duplicateNaturalKeys } = findCrossClubDuplicates([
      { clubId: 'club-a', clubName: 'Club A', row: rowA as never },
      { clubId: 'club-a', clubName: 'Club A', row: rowB as never },
    ]);
    assert.equal(duplicateNaturalKeys.size, 0);
  });

  test('rows with distinct natural keys never collide', () => {
    const rowA = { player: { naturalKey: 'nkA' } };
    const rowB = { player: { naturalKey: 'nkB' } };
    const { duplicateNaturalKeys } = findCrossClubDuplicates([
      { clubId: 'club-a', clubName: 'Club A', row: rowA as never },
      { clubId: 'club-b', clubName: 'Club B', row: rowB as never },
    ]);
    assert.equal(duplicateNaturalKeys.size, 0);
  });
});

// The two gates that stand between a lost/damaged manifest and a destructive revert.
// Extracted from runRevert precisely so both branches can be pinned without a repo, a
// tenant config, or a real manifest on disk — the refusal in particular is the only
// thing stopping `--revert --all --erase-preexisting` from full-wiping every CLUB_MAP
// club when it has no positive evidence of what the import actually created.
describe('revertManifestGate', () => {
  const ABSENT = { kind: 'absent' } as const;
  const CORRUPT = { kind: 'corrupt', detail: 'invalid JSON — bad token' } as const;
  const OK = { kind: 'ok' } as const;

  test('no --all: nothing to gate, whatever the manifest says', () => {
    assert.equal(revertManifestGate({}, ABSENT).kind, 'proceed');
    assert.equal(revertManifestGate({ erasePreexisting: true }, CORRUPT).kind, 'proceed');
  });

  test('--all with a readable manifest proceeds', () => {
    assert.equal(revertManifestGate({ all: true }, OK).kind, 'proceed');
    assert.equal(revertManifestGate({ all: true, erasePreexisting: true }, OK).kind, 'proceed');
  });

  test('--all alone falls back to pristine-only, and says so', () => {
    for (const result of [ABSENT, CORRUPT]) {
      const gate = revertManifestGate({ all: true }, result);
      assert.equal(gate.kind, 'warn');
      assert.match(gate.kind === 'warn' ? gate.message : '', /pristine-only/);
    }
  });

  test('--all --erase-preexisting REFUSES without a readable manifest', () => {
    for (const result of [ABSENT, CORRUPT]) {
      const gate = revertManifestGate({ all: true, erasePreexisting: true }, result);
      assert.equal(gate.kind, 'refuse', 'must never fall through to a full wipe');
      // The message has to name the actual consequence, not just "missing file".
      assert.match(gate.kind === 'refuse' ? gate.message : '', /fully deleted/);
    }
  });

  test('the corrupt case is reported as corrupt, not as missing', () => {
    const gate = revertManifestGate({ all: true }, CORRUPT);
    assert.match(gate.kind === 'warn' ? gate.message : '', /unreadable\/malformed/);
  });
});
