/**
 * Unit tests for the Lions (CGL) affiliation parser + club identity map. Pure — no dynalite,
 * no repo.js, nothing touches DynamoDB/S3. Parse tests build a REAL exceljs workbook in-test
 * with the form export's exact header row (incl. the embedded newlines, the trailing colon on
 * "SIGNED BY:" and the orphaned "Column 52" upload column) and entirely invented contact
 * details — no real PII. Same style as test/titans-contacts-parse.test.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const {
  parseAffiliationWorkbook,
  detectHeaders,
  normalizeCell,
  normalizeEmail,
  parseDivisions,
  text,
} = await import('../src/lions-affiliation-parse.js');
const {
  CLUB_MAP,
  clubNameKey,
  buildAliasIndex,
  normalizeDistrict,
  resolveClubName,
  requireClubName,
  resolveLionsDistricts,
} = await import('../src/lions-import-map.js');
const { buildClubPlan, mergePatch, buildClub, renderSignoffMarkdown } =
  await import('../src/import-lions-affiliation.js');

// ───────────────────────── Workbook fixture (synthetic, no real PII) ─────────────────────────

const HEADERS = [
  'Timestamp',
  'Email Address',
  'CLUB NAME',
  'MUNICIPAL DISTRICT',
  'CHAIRMAN NAME AND SURNAME',
  'CHAIRMAN CELL NUMBER',
  'CHAIRMAN EMAIL ADDRESS',
  'SECRETARY NAME AND SURNAME',
  'SECRETARY CELL NUMBER',
  'SECRETARY EMAIL ADDRESS',
  'LEAGUES',
  'HOW MANY SATURDAY TEAMS DO YOU INTEND TO ENTER FOR THE 2026/2027 SEASON',
  'POSITION COMPLETED IN 2025/26 [SA 1]',
  'HOW MANY SUNDAY TEAMS DO YOU INTEND TO ENTER FOR THE 2026/2027 SEASON',
  'POSITION FINISHED 2025/2026 [PREM A]',
  'UNAVAILABLE DATES FOR THE CLUBS  FOR THE 2026/2027 SEASON (e.g RELIGIOUS HOLIDAYS etc)\nNB: THE OFFICE WILL TRY TO ACCOMODATE WHERE POSSIBLE.',
  'Kindly note the Fee Structure Below',
  'TOTAL AMOUNT DUE TO CGL',
  'NUMBER OF FACILITIES AVAILABLE TO CLUB',
  'NAME OF MAIN FACILITY AND DETAILS',
  'NAME OF ADDITIONAL FACILITY/IES (IF ANY) AND DETAILS.',
  'HEAD GROUNDSMAN NAME',
  'HEAD GROUNDSMAN CONTACT NUMBER',
  'NUMBER OF TURF CRICKET FIELDS (mark appropriate number)',
  'NUMBER OF ASTRO CRICKET FIELDS (mark appropriate number)',
  'OWNERSHIP OF FACILITY',
  'UNAVAILABLE DATES FOR FACILITIES FOR THE 2026/2027 SEASON (e.g RELIGIOUS HOLIDAYS etc)',
  'TOTAL NUMBER OF COACHES AND LEVEL OF QUALIFICATION  [LEVEL 1]',
  'TOTAL NUMBER OF COACHES AND LEVEL OF QUALIFICATION  [LEVEL 2]',
  'TOTAL NUMBER OF COACHES AND LEVEL OF QUALIFICATION  [LEVEL 3]',
  'TOTAL NUMBER OF PLAYERS REGISTERED TO CLUB',
  'PLAYER DATABASE\nList of all senior  players registered to the club.',
  'SIGNED BY:',
  'DATE',
  'Column 52',
];

type Answers = Partial<Record<string, unknown>>;

/** One response row keyed by header; unspecified cells are blank. */
function response(a: Answers): unknown[] {
  return HEADERS.map((h) => a[h] ?? null);
}

function base(club: string, district: string, at: string, extra: Answers = {}): Answers {
  return {
    Timestamp: new Date(at),
    'Email Address': 'form@example.com',
    'CLUB NAME': club,
    'MUNICIPAL DISTRICT': district,
    'CHAIRMAN NAME AND SURNAME': 'Ada Example',
    'CHAIRMAN CELL NUMBER': '082 000 0001',
    'CHAIRMAN EMAIL ADDRESS': 'ada@example.com',
    'SECRETARY NAME AND SURNAME': 'Ben Example',
    'SECRETARY CELL NUMBER': '0820000002',
    'SECRETARY EMAIL ADDRESS': 'ben@example.com',
    LEAGUES: 'Saturday teams, Sunday teams',
    'HOW MANY SATURDAY TEAMS DO YOU INTEND TO ENTER FOR THE 2026/2027 SEASON':
      'SA 1, MENS VETERANS',
    'HOW MANY SUNDAY TEAMS DO YOU INTEND TO ENTER FOR THE 2026/2027 SEASON': 'PREM A, SU 2',
    'NUMBER OF FACILITIES AVAILABLE TO CLUB': 2,
    'NAME OF MAIN FACILITY AND DETAILS': 'Example Oval\n1 Example Rd',
    'NAME OF ADDITIONAL FACILITY/IES (IF ANY) AND DETAILS.': 'None',
    'HEAD GROUNDSMAN NAME': 'Cee Example',
    'HEAD GROUNDSMAN CONTACT NUMBER': 'N/A',
    'NUMBER OF TURF CRICKET FIELDS (mark appropriate number)': 2,
    'NUMBER OF ASTRO CRICKET FIELDS (mark appropriate number)': 0,
    'OWNERSHIP OF FACILITY': 'COUNCIL OWNED',
    'TOTAL NUMBER OF PLAYERS REGISTERED TO CLUB': 40,
    'PLAYER DATABASE\nList of all senior  players registered to the club.': {
      text: 'https://drive.google.com/open?id=example',
      hyperlink: 'https://drive.google.com/open?id=example',
    },
    'SIGNED BY:': 'Ada Example',
    DATE: new Date('2026-08-03T00:00:00Z'),
    ...extra,
  };
}

function buildWorkbook(rows: Answers[], headers: string[] = HEADERS): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Form Responses 1');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(response(r));
  return wb;
}

// ───────────────────────── Header detection ─────────────────────────

describe('detectHeaders — header-driven, fail closed', () => {
  test('locates every field by header text regardless of position', () => {
    const shuffled = [...HEADERS].reverse();
    const { columns, extraUploadColumns } = detectHeaders(shuffled);
    assert.equal(columns.clubName, shuffled.indexOf('CLUB NAME') + 1);
    assert.equal(columns.signedBy, shuffled.indexOf('SIGNED BY:') + 1);
    assert.equal(
      columns.playerDatabase,
      shuffled.findIndex((h) => h.startsWith('PLAYER DATABASE')) + 1,
    );
    assert.deepEqual(extraUploadColumns, [shuffled.indexOf('Column 52') + 1]);
  });

  test('throws naming every missing expected header', () => {
    const without = HEADERS.filter((h) => h !== 'CLUB NAME' && h !== 'SECRETARY CELL NUMBER');
    assert.throws(
      () => detectHeaders(without),
      /missing header\(s\): "CLUB NAME", "SECRETARY CELL NUMBER"/,
    );
  });

  test('throws when a header matches two columns', () => {
    assert.throws(
      () => detectHeaders([...HEADERS, 'Club Name']),
      /ambiguous header\(s\): "CLUB NAME"/,
    );
  });

  test('a workbook without the "Form Responses 1" sheet fails closed', () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Sheet1').addRow(HEADERS);
    assert.throws(() => parseAffiliationWorkbook(wb), /no "Form Responses 1" sheet/);
  });
});

// ───────────────────────── Parsing ─────────────────────────

describe('parseAffiliationWorkbook — records', () => {
  const wb = buildWorkbook([
    base('Randburg Cricket Club', 'JOHANNESBURG', '2026-07-29T15:00:00Z', {
      'CHAIRMAN CELL NUMBER': '‪+27 (82) 000-0003‬',
      'SECRETARY EMAIL ADDRESS': ' Ben@Example.COM / other@example.com',
      'NAME OF ADDITIONAL FACILITY/IES (IF ANY) AND DETAILS.': 'Second Oval\nThird Oval',
      'Column 52': 'https://drive.google.com/open?id=a, https://drive.google.com/open?id=b',
    }),
    base('Randfontein', 'Westrand', '2026-08-03T20:00:00Z', {
      'HOW MANY SATURDAY TEAMS DO YOU INTEND TO ENTER FOR THE 2026/2027 SEASON': 'None',
      'HOW MANY SUNDAY TEAMS DO YOU INTEND TO ENTER FOR THE 2026/2027 SEASON':
        'PREM B, Not sure about our Vets',
    }),
    base('KHOSA SPORTS CLUB', 'MOGALE', '2026-08-04T12:00:00Z'),
  ]);
  const parsed = parseAffiliationWorkbook(wb);

  test('resolves names through CLUB_MAP and normalises districts', () => {
    assert.equal(parsed.responseCount, 3);
    assert.deepEqual(
      parsed.records.map((r) => [r.club.id, r.district]),
      [
        ['randburg-cricket-club', 'Johannesburg'],
        ['randfontein-cricket-club', 'West Rand'],
        ['khosa-sports-club', 'Mogale City'],
      ],
    );
    assert.equal(parsed.rejected.length, 0);
  });

  test('normalises contacts: bidi-marked +27 cell, multi-email cell', () => {
    const r = parsed.records[0];
    assert.equal(r.chairman.cell.cell, '0820000003');
    assert.equal(r.chairman.cell.e164, '27820000003');
    assert.equal(r.secretary.email, 'ben@example.com');
    assert.ok(r.warnings.some((w) => /2 emails in one cell/.test(w)));
  });

  test('parses divisions, facilities, database links and signature', () => {
    const r = parsed.records[0];
    assert.deepEqual(r.saturday.tokens, ['SA 1', 'MENS VETERANS']);
    assert.deepEqual(r.sunday.tokens, ['PREM A', 'SU 2']);
    assert.equal(r.saturdayTeamCount, 2);
    assert.equal(r.facilities.mainName, 'Example Oval');
    assert.equal(r.facilities.mainDetails, '1 Example Rd');
    assert.deepEqual(r.facilities.additional, ['Second Oval', 'Third Oval']);
    assert.equal(r.facilities.turf, 2);
    assert.equal(r.facilities.astro, 0);
    assert.equal(r.facilities.groundsmanCell.cell, '');
    assert.equal(r.playerCountRaw, '40');
    assert.equal(r.playerDatabaseUrl, 'https://drive.google.com/open?id=example');
    assert.deepEqual(r.extraDatabaseUrls, [
      'https://drive.google.com/open?id=a',
      'https://drive.google.com/open?id=b',
    ]);
    assert.equal(r.signedDate, '2026-08-03');
  });

  test('free-text division answers are reported, never mapped', () => {
    const r = parsed.records[1];
    assert.deepEqual(r.saturday.tokens, []);
    assert.deepEqual(r.sunday.tokens, ['PREM B']);
    assert.ok(r.warnings.some((w) => w.includes('Not sure about our Vets')));
  });
});

describe('parseAffiliationWorkbook — fail-closed rows + dedupe', () => {
  test('an unknown club name and an unknown district are rejected, not guessed', () => {
    const parsed = parseAffiliationWorkbook(
      buildWorkbook([
        base('Randburg Cricket Clb', 'JOHANNESBURG', '2026-08-01T10:00:00Z'),
        base('Jeppe', 'GAUTENG NORTH', '2026-08-01T11:00:00Z'),
      ]),
    );
    assert.equal(parsed.records.length, 0);
    assert.deepEqual(
      parsed.rejected.map((r) => r.rowNumber),
      [2, 3],
    );
    assert.match(parsed.rejected[0].reason, /not in lions-import-map/);
    assert.match(parsed.rejected[1].reason, /unrecognised MUNICIPAL DISTRICT "GAUTENG NORTH"/);
  });

  test('University of Johannesburg submitted twice: the LATEST timestamp wins, discard reported', () => {
    const parsed = parseAffiliationWorkbook(
      buildWorkbook([
        base('University of Johannesburg Cricket Club', 'JOHANNESBURG', '2026-08-03T11:07:00Z', {
          'CHAIRMAN NAME AND SURNAME': 'Early Answer',
        }),
        base('Jeppe', 'JOHANNESBURG', '2026-08-04T14:00:00Z'),
        base('University of Johannesburg cricket club', 'JOHANNESBURG', '2026-08-04T19:47:00Z', {
          'CHAIRMAN NAME AND SURNAME': 'Late Answer',
        }),
      ]),
    );
    assert.equal(parsed.responseCount, 3);
    assert.equal(parsed.records.length, 2);
    const uj = parsed.records.find((r) => r.club.id === 'university-of-johannesburg-cricket-club');
    assert.equal(uj?.chairman.name, 'Late Answer');
    assert.equal(uj?.rowNumber, 4);
    assert.deepEqual(parsed.duplicates, [
      {
        clubId: 'university-of-johannesburg-cricket-club',
        kept: {
          rowNumber: 4,
          timestamp: '2026-08-04T19:47:00.000Z',
          rawClubName: 'University of Johannesburg cricket club',
        },
        discarded: [
          {
            rowNumber: 2,
            timestamp: '2026-08-03T11:07:00.000Z',
            rawClubName: 'University of Johannesburg Cricket Club',
          },
        ],
      },
    ]);
  });
});

// ───────────────────────── Normalisers ─────────────────────────

describe('normalisers', () => {
  test('districts: the four form spellings, anything else null', () => {
    assert.equal(normalizeDistrict('JOHANNESBURG'), 'Johannesburg');
    assert.equal(normalizeDistrict(' Sedibeng '), 'Sedibeng');
    assert.equal(normalizeDistrict('MOGALE'), 'Mogale City');
    assert.equal(normalizeDistrict('Westrand'), 'West Rand');
    assert.equal(normalizeDistrict('West Rand'), 'West Rand');
    assert.equal(normalizeDistrict('Ekurhuleni'), null);
    assert.equal(normalizeDistrict(''), null);
  });

  test('cells: ZA local form, dropped leading zero, two numbers, landline, junk', () => {
    assert.equal(normalizeCell('+27 (73) 248-1451').cell, '0732481451');
    assert.equal(normalizeCell(821234567).cell, '0821234567');
    const two = normalizeCell('0695937065/0798698464');
    assert.equal(two.cell, '0695937065');
    assert.deepEqual(two.extra, ['0798698464']);
    const land = normalizeCell('016 950 9307');
    assert.equal(land.cell, '0169509307');
    assert.equal(land.landline, true);
    assert.equal(normalizeCell('071 435 488').cell, '');
    assert.match(normalizeCell('071 435 488').warning ?? '', /unusable number/);
    assert.deepEqual(normalizeCell('TBC').warning, undefined);
  });

  test('emails: lowercase/trim; invalid → blank with a warning', () => {
    assert.equal(normalizeEmail('  A@B.CO.ZA ').email, 'a@b.co.za');
    assert.equal(normalizeEmail('not an email').email, '');
    assert.match(normalizeEmail('not an email').warning ?? '', /invalid email/);
  });

  test('divisions: None/N/A/0 mean nothing; duplicates collapse', () => {
    assert.deepEqual(parseDivisions('None').tokens, []);
    assert.deepEqual(parseDivisions(0).tokens, []);
    assert.deepEqual(parseDivisions('SA 2, MENS VETERANS, SA 3, ').tokens, [
      'SA 2',
      'MENS VETERANS',
      'SA 3',
    ]);
    assert.deepEqual(parseDivisions(' Ladies Promotion').tokens, ['LADIES PROMOTION']);
  });

  test('invisible marks: every zero-width/bidi code point is stripped, nothing else', () => {
    // U+200B–U+200F, U+202A–U+202E, U+2066–U+2069, U+FEFF — each range end plus a middle one.
    const marks = [
      0x200b, 0x200d, 0x200f, 0x202a, 0x202c, 0x202e, 0x2066, 0x2068, 0x2069, 0xfeff,
    ].map((cp) => String.fromCodePoint(cp));
    for (const m of marks) {
      const cp = m.codePointAt(0)!.toString(16);
      assert.equal(text(`${m}+27 82${m} 000${m}`), '+27 82 000', `text() U+${cp}`);
      assert.equal(clubNameKey(`${m}PAV Soweto CC${m}`), 'pav soweto cc', `clubNameKey U+${cp}`);
    }
    // Just outside the class: U+2010 (hyphen) and U+2065 (unassigned) are kept.
    assert.equal(text('a\u2010b'), 'a\u2010b');
    assert.equal(clubNameKey('a\u2065b'), 'a\u2065b');
  });
});

// ───────────────────────── Club identity map ─────────────────────────

describe('lions-import-map — alias resolution', () => {
  test('every alias spelling from the three sources resolves to its one club', () => {
    const cases: Array<[string, string]> = [
      ['Western Warriors/Crescents', 'western-warriors-cricket-club'],
      ['Western Warriors CC', 'western-warriors-cricket-club'],
      ['Crescents', 'western-warriors-cricket-club'],
      ['Khosa Cricket', 'khosa-sports-club'],
      ['Khosa CC', 'khosa-sports-club'],
      ['khosa', 'khosa-sports-club'],
      ['Old Parks', 'old-parktonians-cricket-club'],
      ['The Old Parktonians', 'old-parktonians-cricket-club'],
      ['EP Ottomans', 'eldorado-park-ottomans-cricket-club'],
      ['Eldorado Park Ottomans CC', 'eldorado-park-ottomans-cricket-club'],
      ['Delfos 2', 'delfos-cricket-club'],
      [
        'Vaal University of Technology Cricket Club(VUT CC)',
        'vaal-university-of-technology-cricket-club',
      ],
      ['Azad Sewraj Sporting', 'azad-swaraj-sporting-club'],
      ['Die Ratels (Mens)', 'die-ratels-cricket-club'],
      ['NWU VC', 'nwu-vaal-cricket-club'],
      ['  Trent  bridge lions ', 'trent-bridge-lions-cricket-club'],
      ['‪PAV Soweto CC‬', 'pav-soweto-cricket-club'],
    ];
    for (const [raw, id] of cases) assert.equal(resolveClubName(raw)?.id, id, raw);
  });

  test('ambiguous identities stay split', () => {
    assert.notEqual(resolveClubName('Wits Lions')?.id, resolveClubName('Wits University')?.id);
    assert.notEqual(resolveClubName('Marks Park')?.id, resolveClubName('Marks Park Thistles')?.id);
  });

  test('fails closed: unknown names and Macrocomm placeholders never resolve', () => {
    assert.equal(resolveClubName('Marks Pk'), null);
    assert.equal(resolveClubName('Macrocomm Round 1'), null);
    assert.equal(resolveClubName('Wits'), null);
    assert.throws(() => requireClubName('Sandton Lions'), /unknown club name "Sandton Lions"/);
  });

  test('the alias index rejects a spelling claimed by two clubs', () => {
    const a = { ...CLUB_MAP[0], aliases: ['Shared'] };
    const b = { ...CLUB_MAP[1], aliases: ['shared'] };
    assert.throws(() => buildAliasIndex([a, b]), /resolves to both/);
  });

  test('club ids derive from names and are unique; guessed districts only without a response', () => {
    assert.equal(new Set(CLUB_MAP.map((c) => c.id)).size, CLUB_MAP.length);
    for (const c of CLUB_MAP)
      if (c.districtGuess) assert.ok(!c.sources.includes('affiliation'), c.id);
  });

  test('resolveLionsDistricts maps all four onto configured names, fail-closed otherwise', () => {
    const ok = resolveLionsDistricts([
      'Johannesburg Cricket District',
      'Sedibeng',
      'Mogale City',
      'West Rand',
    ]);
    assert.equal(ok.kind, 'ok');
    if (ok.kind === 'ok') assert.equal(ok.byDistrict.Johannesburg, 'Johannesburg Cricket District');
    const missing = resolveLionsDistricts(['Johannesburg', 'Sedibeng', 'Mogale City']);
    assert.equal(missing.kind, 'error');
    if (missing.kind === 'error') assert.match(missing.message, /"West Rand": 0 configured/);
  });
});

// ───────────────────────── Club plan + building (import-lions-affiliation.ts) ─────────────────────────

describe('import-lions-affiliation — plan cross-checks', () => {
  const twoClubs = CLUB_MAP.filter((c) =>
    ['jeppe-cricket-club', 'pav-soweto-cricket-club'].includes(c.id),
  );

  test('a clean pairing has no hard failures', () => {
    const parsed = parseAffiliationWorkbook(
      buildWorkbook([base('Jeppe', 'JOHANNESBURG', '2026-08-04T14:00:00Z')]),
    );
    const { plan, hardFailures } = buildClubPlan(parsed, twoClubs);
    assert.deepEqual(hardFailures, []);
    assert.equal(plan.find((p) => p.entry.id === 'jeppe-cricket-club')?.record?.rowNumber, 2);
    assert.equal(plan.find((p) => p.entry.id === 'pav-soweto-cricket-club')?.record, undefined);
  });

  test('an affiliated club with no response, or a district disagreeing with the map, fails', () => {
    const empty = parseAffiliationWorkbook(buildWorkbook([]));
    assert.match(
      buildClubPlan(empty, twoClubs).hardFailures.join('\n'),
      /Jeppe Cricket Club: CLUB_MAP lists an affiliation source/,
    );
    const wrongDistrict = parseAffiliationWorkbook(
      buildWorkbook([base('Jeppe', 'SEDIBENG', '2026-08-04T14:00:00Z')]),
    );
    assert.match(
      buildClubPlan(wrongDistrict, twoClubs).hardFailures.join('\n'),
      /form says district "Sedibeng".*CLUB_MAP says "Johannesburg"/,
    );
  });

  test('merge fills absent fields only — an existing exco slot or ground is never clobbered', () => {
    const parsed = parseAffiliationWorkbook(
      buildWorkbook([base('Jeppe', 'JOHANNESBURG', '2026-08-04T14:00:00Z')]),
    );
    const { plan } = buildClubPlan(parsed, twoClubs);
    const jeppe = plan.find((p) => p.entry.id === 'jeppe-cricket-club')!;
    const built = buildClub(
      jeppe,
      [{ key: 'constitution', label: 'Constitution' } as never],
      0,
      'Johannesburg',
      ['premier-a'],
    );
    assert.deepEqual(built.exco, {
      chair: { name: 'Ada Example', email: 'ada@example.com', cell: '0820000001' },
      sec: { name: 'Ben Example', email: 'ben@example.com', cell: '0820000002' },
    });
    const current = {
      ...built,
      chair: 'Existing Chair',
      exco: { chair: { name: 'Existing Chair', email: 'x@example.com' } },
      ground: { venue: 'Existing Ground' },
      leagues: [],
      docs: {},
    };
    const patch = mergePatch(current, built);
    assert.equal(patch.chair, undefined);
    assert.equal(patch.ground, undefined);
    assert.deepEqual(patch.exco, {
      chair: { name: 'Existing Chair', email: 'x@example.com' },
      sec: built.exco!.sec,
    });
    assert.deepEqual(patch.leagues, ['premier-a']);
    assert.deepEqual(patch.docs, { constitution: false });
  });

  test('the sign-off lists every club and the judgment calls', () => {
    const parsed = parseAffiliationWorkbook(
      buildWorkbook([base('Jeppe', 'JOHANNESBURG', '2026-08-04T14:00:00Z')]),
    );
    const md = renderSignoffMarkdown(buildClubPlan(parsed, twoClubs).plan, parsed);
    assert.match(md, /\| Jeppe Cricket Club \|/);
    assert.match(md, /PAV Soweto Cricket Club \*\(district assumed\)\* ⚑/);
    assert.match(md, /Macrocomm Round 1/);
  });
});
