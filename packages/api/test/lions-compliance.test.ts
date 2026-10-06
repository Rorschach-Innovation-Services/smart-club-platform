/**
 * Unit tests for the Lions (CGL) compliance import's pure pieces — DOC_RULES /
 * FILE_OVERRIDES / SKIP_RULES over the REAL cleaned pack's 131 relative paths, the
 * `_root-unique/` routing, the parse-phase fail-closed gate, the lions catalogue MIME/
 * multiFile fit, and the revert decision. Pure — no dynalite, no repo.js; the CLI guards
 * its own entry point. Same style as test/import-tuskers.test.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const {
  CLUB_MAP,
  DOC_CLUBS,
  DOC_RULES,
  FILE_OVERRIDES,
  LIONS_DOC_KEYS,
  MULTI_FILE_DOC_KEYS,
  classifyFile,
  resolveClubName,
} = await import('../src/lions-import-map.js');
const {
  classifyAll,
  walkDocs,
  parseArgs,
  parseHardFailures,
  singleFileClashes,
  validateDocMimes,
  catalogueCoverageProblems,
  contentAddressedKey,
  isImportObjectKey,
  stripImportDocs,
  revertManifestGate,
  revertAction,
  createdClubsManifestPath,
  LEGACY_CREATED_CLUBS_MANIFEST_PATH,
  buildClub,
} = await import('../src/import-lions-compliance.js');
const { CATALOGUES } = await import('../src/configure-tenant-docs.js');
const { activeRequiredDocs } = await import('../src/catalogue.js');

const PACK_DIR = '/Users/carlton/Downloads/Lions/prepared/compliance';

/**
 * Every file in the cleaned pack (`find . -type f | sort`, relative to the pack root) with
 * its reviewed outcome: a docKey (imports into the folder's own club), `<clubId>:<docKey>`
 * (a reassignment / _root-unique routing), or 'skip'. This table IS the parse-phase exit
 * criterion, and the snapshot of every content-verified decision.
 */
const EXPECTED: Array<[string, string]> = [
  ['_root-unique/Delfos Finance 2023_24.pdf', 'skip'],
  ['_root-unique/IMG-20250708-WA0133.jpg', 'skip'],
  ['_root-unique/IMG-20250708-WA0134.jpg', 'randfontein-cricket-club:clubRecords'],
  ['_root-unique/LCC Executive Members 2024- 25 - CGL.docx', 'skip'],
  [
    '_root-unique/New Cricket Committee 2025.2026 season.xlsx',
    'old-parktonians-cricket-club:committee',
  ],
  ['_root-unique/Re Club Documents - LCC.msg', 'skip'],
  ['_root-unique/Re Updated List - LCC Exec.msg', 'skip'],
  ['Alexandra CC/9447ca2ee9c949959ffd2026ea09e891_printpdf.pdf', 'bankConfirmation'],
  ['Alexandra CC/AGM MINUITES 2025.docx', 'agmMinutes'],
  ['Alexandra CC/AGMNOTICE2025.pdf', 'agmMinutes'],
  ['Alexandra CC/Final Alex_Constitution - martin rathogwa.pdf', 'constitution'],
  ['Azaadville/ACC AGM Minutes .pages', 'skip'],
  ['Azaadville/extracted/_inline-email-images/image003.jpg', 'skip'],
  ['Azaadville/extracted/_inline-email-images/image004.png', 'skip'],
  ['Azaadville/extracted/_inline-email-images/image005.gif', 'skip'],
  ['Azaadville/extracted/_inline-email-images/image006.jpg', 'skip'],
  ['Azaadville/extracted/ACC AGM Minutes (from pages) - page 1 preview only.jpg', 'skip'],
  ['Azaadville/extracted/LIST.OFFICIALS.25MAY25.pdf', 'azad-swaraj-sporting-club:committee'],
  ['Azaadville/extracted/RE Club Governance and Compliance - email body.txt', 'skip'],
  ['Azaadville/GOLD BUSINESS ACCOUNT 147.pdf', 'financials'],
  ['Azaadville/GOLD BUSINESS ACCOUNT 148.pdf', 'financials'],
  ['Azaadville/GOLD BUSINESS ACCOUNT 149.pdf', 'financials'],
  ['Azaadville/RE Club Governance and Compliance.msg', 'skip'],
  ['Azaadville/Scanned Documents-8.pdf', 'constitution'],
  ['Azad Swaraj/25MAY2025.Minutes of AGM of AZAD SWARAJ SPORTING CLUB.PDF', 'agmMinutes'],
  ['Azad Swaraj/ASSC.Constitution.pdf', 'constitution'],
  ['Azad Swaraj/CASHFLOW.2023.4.pdf', 'financials'],
  ['Azad Swaraj/SBSA_ConfirmationLetter_2024-09-18_240918_191234.pdf', 'bankConfirmation'],
  ['Calypso CC/Calypso.pdf', 'constitution'],
  ['Calypso CC/GOLD_BUSINESS_ACCOUNT_82 June 2024.pdf', 'financials'],
  ['Crescents/Crescents AGM Minutes (2024-2025 Season).pdf', 'agmMinutes'],
  ['Crescents/Crescents Cricket Club CONSTITUTION_2023 - Mohammed Majam.pdf', 'constitution'],
  ['Crescents/SBSA_ConfirmationLetter_2024-11-22.pdf', 'bankConfirmation'],
  ['Dalikay CC/15.59596043.090226e8f0d1bee7 (2).pdf', 'bankConfirmation'],
  ['Dalikay CC/DOC-20240508-WA0012.pdf', 'constitution'],
  ['Delfos Cricket Club/Delfos AGM Minutes 2023.pdf', 'agmMinutes'],
  ['Delfos Cricket Club/Delfos AGM Minutes 2024.pdf', 'agmMinutes'],
  ['Delfos Cricket Club/Delfos Bank Confirmation 2024.PDF', 'bankConfirmation'],
  ['Delfos Cricket Club/Delfos Constitution.pdf', 'constitution'],
  ['Delfos Cricket Club/Delfos Finance 2023_24.pdf', 'financials'],
  ['Diepsloot CC/Bank confromation letter 28 June 2024 - Salman Khan.pdf', 'bankConfirmation'],
  ['Diepsloot CC/Diepsloot.pdf', 'constitution'],
  ['Dobsonville Cricket Club/DCC COMPLIANCE DOCUMENTS 2.pdf', 'agmMinutes'],
  ['Durban Old Boys/62924552195-confirmation.pdf', 'bankConfirmation'],
  ['Durban Old Boys/Agenda_Annual General Meeting - DOB cc 2024-2025.pdf', 'agmMinutes'],
  ['Durban Old Boys/DOB_Constitution .pdf', 'constitution'],
  ['Durban Old Boys/DOBCC Financials 31-08-2024.pdf', 'financials'],
  ['Durban Old Boys/Minutes of AGM 2023-2024 - Durban Old Boys CC - 30-08-2023.pdf', 'agmMinutes'],
  ['Gauteng Lions Deaf Cricket/CGLDC Bank Account Confirmation Letter.pdf', 'bankConfirmation'],
  ["Gauteng Lions Deaf Cricket/Chairman's Report 2023-24.pdf", 'chairmansReport'],
  ['Gauteng Lions Deaf Cricket/GOLD BUSINESS ACCOUNT 117.pdf', 'financials'],
  ['Gauteng Lions Deaf Cricket/GOLD BUSINESS ACCOUNT 118.pdf', 'financials'],
  ['Gauteng Lions Deaf Cricket/GOLD BUSINESS ACCOUNT 119.pdf', 'financials'],
  ['Gauteng Lions Deaf Cricket/Lions Deaf Cricket AGM Minutes 2023-2024 v4.pdf', 'agmMinutes'],
  ['Gauteng Lions Deaf Cricket/office bearers 2024_2026.pdf', 'committee'],
  ['GM Old Edwardians/2024AGMApproved.pdf', 'agmMinutes'],
  ['GM Old Edwardians/BankConfirmation GM Old Edwardians.pdf', 'bankConfirmation'],
  ['GM Old Edwardians/Cricket Constitution amended 28092017.pdf', 'constitution'],
  ['Jeppe CC/Jeppe CC Compliance/CONSTITUTION.pdf', 'constitution'],
  ['Jeppe CC/Jeppe CC Compliance/JCC Financials 24-25.pdf', 'financials'],
  ['Jeppe CC/Jeppe CC Compliance/Jeppe CC AGM Minutes 8 July 2025.pdf', 'agmMinutes'],
  ['Jeppe CC/Jeppe CC Compliance/Jeppe CC Executives 8 July 2025 Signed.pdf', 'committee'],
  [
    'Jeppe CC/Jeppe CC Compliance/Jeppe Cricket Club Bank Account Confirmation.pdf',
    'bankConfirmation',
  ],
  ['Joburg CC/Bank Confirmation Letter.pdf', 'bankConfirmation'],
  ['Joburg CC/JCC - Constitution.pdf', 'constitution'],
  ['Joburg CC/JCC HOPE VILLAGE - NEW COMPANY REG DOCUMENTS_-signed.pdf', 'clubRecords'],
  ['Joburg CC/JCC HOPE VILLAGE CIPC DOCUMENTS.pdf', 'orgRegistration'],
  ['Kagiso CC/AGM invitation.docx', 'agmMinutes'],
  ['Kagiso CC/BEE.pdf', 'beeCert'],
  ['Kagiso CC/Document 10.pdf', 'bankConfirmation'],
  ['Kagiso CC/IMG_20241209_110929_resized_20241209_112849728.jpg', 'clubRecords'],
  ['Kagiso CC/Kagiso Cricket Club Constitution 2 - Coach Nicky.pdf', 'constitution'],
  ['Kagiso CC/Kagiso Cricket Club Constitution 2.docx', 'skip'],
  ['Khosa/Minutes_AGM_Khosa Senior Cricket_29August2024.pdf', 'agmMinutes'],
  ['Khosa/ProofOfAccounts - Nedbank - KHOSA Account.PDF', 'bankConfirmation'],
  ['Lenasia CC/extracted/LCC Executive Members - 24 June Meeting 25 Register.pdf', 'committee'],
  ['Lenasia CC/extracted/LCC Executive Members 2024- 25 - CGL.docx', 'skip'],
  ['Lenasia CC/extracted/Re Club Documents - LCC - email body.txt', 'skip'],
  ['Lenasia CC/extracted/Re Updated List - LCC Exec - email body.txt', 'skip'],
  ['Lenasia CC/L C C ESTABLISHED  - NPO19_Certificate.pdf', 'orgRegistration'],
  ['Lenasia CC/LCC - 2024 Financials.pdf', 'financials'],
  ['Lenasia CC/LCC AGM Miutes - September 2004.pdf', 'agmMinutes'],
  ['Lenasia CC/LCC Executive Members 2024- 25 - CGL.docx', 'skip'],
  ["Lenasia CC/LCC's Constitution 2022.pdf", 'constitution'],
  ['NWU/ABSA Account Confirmation Letter 2025.01.pdf', 'bankConfirmation'],
  ['NWU/CRE8 - BEE Certificate.pdf', 'beeCert'],
  ['NWU/GLSummaryReport-Cricket-04July2025.pdf', 'financials'],
  ['NWU/NWU Vdbp cricket constitution.pdf', 'constitution'],
  ['Old Lions Club Governance Docs/2024 OLCC AFS - signed.pdf', 'financials'],
  ['Old Lions Club Governance Docs/Balance Sheet as at 30 June 2025.PDF', 'financials'],
  ['Old Lions Club Governance Docs/Bank Account Confirmation Letter.pdf', 'bankConfirmation'],
  ['Old Lions Club Governance Docs/Income Statement 30 June 2025.PDF', 'financials'],
  ['Old Lions Club Governance Docs/OLCC AGM Minutes(04.04.25) - Signed.pdf', 'agmMinutes'],
  ['Old Lions Club Governance Docs/OLCC EXEC COMM.pdf', 'committee'],
  [
    'Old Lions Club Governance Docs/Old Lions Cricket Club Updated Constitution - 4 April 2025.pdf',
    'constitution',
  ],
  ['Old Vaal/Old Vaal CC - Club Verification - NPO.pdf', 'orgRegistration'],
  ['Old Vaal/Old Vaal CC - Confirmation of Banking Details.pdf', 'bankConfirmation'],
  ['Old Vaal/Old Vaal CC - Contact Details.pdf', 'committee'],
  ['Old Vaal/Old Vaal Cricket Club Constitution.pdf', 'constitution'],
  ['Ranburg/AGM 2025 RCC Minutes 24 May 2025.pdf', 'agmMinutes'],
  ['Ranburg/ProofOfAccounts (3).PDF', 'bankConfirmation'],
  ['Ranburg/RCC CONSTITUTION SCAN.pdf', 'constitution'],
  ['Ranburg/RCC_Annual_Report_2024-25_(2)[1].pdf', 'chairmansReport'],
  ['Randfontein CC/Agm 2024.docx', 'agmMinutes'],
  ['Randfontein CC/BANKconfirmationletter.pdf', 'bankConfirmation'],
  ['Randfontein CC/CoR39_60007418051.pdf', 'orgRegistration'],
  ['Randfontein CC/RANDFONTEIN KRIEKET KLUB_2025-06-01_2025-07-08_stamped.pdf', 'financials'],
  ['Sandton Tigers/bank letter.pdf', 'bankConfirmation'],
  ['Sopranos/62054946242_20241123.pdf', 'financials'],
  ['Sopranos/62054946242_20250717.pdf', 'financials'],
  ['Sopranos/Constituition.pdf', 'constitution'],
  ['Sopranos/Minutes of AGM 2024.pdf', 'agmMinutes'],
  ['Sopranos/Sopranos Bank Confirmation 22-11-2024.pdf', 'bankConfirmation'],
  ['The Old Parktonian/AGM - May 2025.docx', 'agmMinutes'],
  ['The Old Parktonian/CONSTITUTION OF THE OLD PARKTONIAN SPORTS CLUB.doc', 'constitution'],
  ['The Old Parktonian/doc01432820250324132615.pdf', 'bankConfirmation'],
  [
    'The Old Parktonian/Minutes of the Cricket AGM held in the Main Lounge of the Old Parktonian Club on Friday 30th May 2025 at 19h00.docx',
    'agmMinutes',
  ],
  ['The Old Parktonian/Non profit registration.pdf', 'orgRegistration'],
  [
    'The Old Parktonian/Old Parks finances for 2024 and 2025_cln (converted from pptx).pdf',
    'financials',
  ],
  ['The Old Parktonian/Old Parks finances for 2024 and 2025_cln.pptx', 'financials'],
  ['UJ CC/UJ Cricket 2024 and 2025 Season AGM.docx', 'agmMinutes'],
  ['VCCC/VCC Club Constitution.pdf', 'constitution'],
  ['VCCC/VCC Letter Confirming Executive Members July 2025.pdf', 'committee'],
  ['VCCC/Vereeniging Cricket Club - AGM Minutes Sep 2024.pdf', 'agmMinutes'],
  ['VCCC/Vereeniging Cricket Club - FS Mar 2024 Signed.pdf', 'financials'],
  ['VCCC/Vereeniging Cricket Club - NPO Reg Cert.pdf', 'orgRegistration'],
  ['VCCC/Vereeniging Cricket Club Confirmation of Banking Details.pdf', 'bankConfirmation'],
  ['Wanderers CC/Compliance Docs/2024 WCC AGM Minutes.pdf', 'agmMinutes'],
  ['Wanderers CC/Compliance Docs/CONSTITUTION-2019.pdf', 'constitution'],
  [
    'Wanderers CC/Compliance Docs/The Wanderers Club - STD Bank Confirnmation 09-05-2025.pdf',
    'bankConfirmation',
  ],
  [
    'Wanderers CC/Compliance Docs/Wanderers Annual Report 2025  - FINAL 9 June.pdf',
    'chairmansReport',
  ],
];
const REAL_PACK_PATHS = EXPECTED.map(([rel]) => rel);

/** Mirrors walkDocs: folder = first segment, filename = basename. */
const toEntries = (paths: string[]) =>
  paths.map((rel) => ({
    rel,
    abs: `/nonexistent/${rel}`,
    folder: rel.split('/')[0],
    filename: rel.split('/').at(-1)!,
  }));

const outcomeOf = (f: {
  skipReason?: string;
  docKey?: string;
  club?: { id: string };
  folder: string;
  reassignedFrom?: unknown;
}) =>
  f.skipReason
    ? 'skip'
    : f.folder === '_root-unique' || f.reassignedFrom
      ? `${f.club!.id}:${f.docKey}`
      : f.docKey!;

const classifyRel = (rel: string) => classifyFile(rel, rel.split('/').at(-1)!);

const LIONS_ACTIVE = activeRequiredDocs({ requiredDocs: CATALOGUES.lions } as never);
const idOf = (name: string) => resolveClubName(name)!.id;

describe('classifier over the real cleaned CGL pack (131 files)', () => {
  const { classified, unclassified, unmappedFolders, badReassignments } = classifyAll(
    toEntries(REAL_PACK_PATHS),
  );

  test('zero unclassified files, zero unmapped folders, zero bad reassignments', () => {
    assert.equal(REAL_PACK_PATHS.length, 131);
    assert.deepEqual(
      unclassified.map((f: { rel: string }) => f.rel),
      [],
    );
    assert.deepEqual(unmappedFolders, []);
    assert.deepEqual(badReassignments, []);
  });

  test('every file lands exactly where the reviewed table says', () => {
    const got = new Map(classified.map((f) => [f.rel, outcomeOf(f)]));
    for (const [rel, want] of EXPECTED) assert.equal(got.get(rel), want, rel);
  });

  test('113 files import and 18 are deliberate skips', () => {
    assert.equal(classified.filter((f) => f.docKey).length, 113);
    assert.equal(classified.filter((f) => f.skipReason).length, 18);
  });

  test('every doc club (28 folders, Orange Farm excluded) gets at least one doc', () => {
    assert.equal(DOC_CLUBS.length, 28);
    assert.ok(!DOC_CLUBS.some((c) => c.folder === 'Orange Farm'));
    for (const club of DOC_CLUBS)
      assert.ok(
        classified.some((f) => f.club?.id === club.id && f.docKey),
        `${club.name} has no docs`,
      );
  });

  test('the parse gate passes on the real pack', () => {
    assert.deepEqual(
      parseHardFailures({ classified, unclassified, unmappedFolders, badReassignments }),
      [],
    );
  });

  test('every FILE_OVERRIDES key names a real file, except the pending Pages export', () => {
    const real = new Set(REAL_PACK_PATHS);
    const stale = Object.keys(FILE_OVERRIDES).filter((rel) => !real.has(rel));
    assert.deepEqual(stale, ['Azaadville/ACC AGM Minutes .pdf']);
  });

  test('every produced docKey is a catalogue key; single-file keys hold one file per club', () => {
    for (const f of classified)
      if (f.docKey) assert.ok(LIONS_DOC_KEYS.includes(f.docKey), `${f.rel} → ${f.docKey}`);
    const perClubKey = new Map<string, number>();
    for (const f of classified) {
      if (!f.docKey || MULTI_FILE_DOC_KEYS.has(f.docKey)) continue;
      const k = `${f.club!.id}/${f.docKey}`;
      perClubKey.set(k, (perClubKey.get(k) ?? 0) + 1);
    }
    for (const [k, n] of perClubKey) assert.equal(n, 1, k);
  });

  test('every classified file passes the lions catalogue MIME check (pptx, xlsx, jpg incl.)', () => {
    assert.doesNotThrow(() =>
      validateDocMimes(
        classified.filter((f) => f.docKey),
        LIONS_ACTIVE,
      ),
    );
  });

  test('the pack fits the lions catalogue multiFile caps', () => {
    const counts = new Map<string, number>();
    for (const f of classified) {
      if (!f.docKey || !MULTI_FILE_DOC_KEYS.has(f.docKey)) continue;
      const k = `${f.club!.id}::${f.docKey}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const worst = new Map<string, number>();
    for (const [k, n] of counts) {
      const docKey = k.split('::')[1];
      worst.set(docKey, Math.max(worst.get(docKey) ?? 0, n));
    }
    assert.deepEqual(catalogueCoverageProblems(LIONS_ACTIVE, worst), []);
  });
});

describe('live pack listing (runs only where the prepared pack exists)', () => {
  test(
    'walkDocs over the prepared pack yields exactly the embedded listing, and passes the gate',
    { skip: existsSync(PACK_DIR) ? false : 'prepared CGL pack not on this machine' },
    async () => {
      const files = await walkDocs(PACK_DIR);
      assert.deepEqual(
        files.map((f: { rel: string }) => f.rel).sort(),
        [...REAL_PACK_PATHS].sort(),
      );
      const { classified, unclassified, unmappedFolders, badReassignments } = classifyAll(files);
      assert.deepEqual(
        parseHardFailures({
          classified,
          unclassified,
          unmappedFolders,
          badReassignments,
          singleFileClashes: await singleFileClashes(classified),
        }),
        [],
      );
    },
  );
});

describe('DOC_RULES on the tricky filenames', () => {
  const cases: Array<[string, string]> = [
    ['Minutes_AGM_Khosa Senior Cricket_29August2024.pdf', 'agmMinutes'],
    ['2024AGMApproved.pdf', 'agmMinutes'],
    ['AGMNOTICE2025.pdf', 'agmMinutes'],
    ['AGM invitation.docx', 'agmMinutes'],
    ['Agenda_Annual General Meeting - DOB cc 2024-2025.pdf', 'agmMinutes'],
    ['LCC AGM Miutes - September 2004.pdf', 'agmMinutes'],
    ['Constituition.pdf', 'constitution'],
    ["Chairman's Report 2023-24.pdf", 'chairmansReport'],
    ['RCC_Annual_Report_2024-25_(2)[1].pdf', 'chairmansReport'],
    ['CRE8 - BEE Certificate.pdf', 'beeCert'],
    ['L C C ESTABLISHED  - NPO19_Certificate.pdf', 'orgRegistration'],
    ['CoR39_60007418051.pdf', 'orgRegistration'],
    ['Old Vaal CC - Club Verification - NPO.pdf', 'orgRegistration'],
    ['Non profit registration.pdf', 'orgRegistration'],
    ['OLCC EXEC COMM.pdf', 'committee'],
    ['LIST.OFFICIALS.25MAY25.pdf', 'committee'],
    ['office bearers 2024_2026.pdf', 'committee'],
    ['VCC Letter Confirming Executive Members July 2025.pdf', 'committee'],
    ['Old Vaal CC - Contact Details.pdf', 'committee'],
    ['SBSA_ConfirmationLetter_2024-11-22.pdf', 'bankConfirmation'],
    ['ProofOfAccounts (3).PDF', 'bankConfirmation'],
    ['Bank confromation letter 28 June 2024 - Salman Khan.pdf', 'bankConfirmation'],
    ['ABSA Account Confirmation Letter 2025.01.pdf', 'bankConfirmation'],
    ['bank letter.pdf', 'bankConfirmation'],
    ['GOLD BUSINESS ACCOUNT 147.pdf', 'financials'],
    ['GOLD_BUSINESS_ACCOUNT_82 June 2024.pdf', 'financials'],
    ['GLSummaryReport-Cricket-04July2025.pdf', 'financials'],
    ['CASHFLOW.2023.4.pdf', 'financials'],
    ['2024 OLCC AFS - signed.pdf', 'financials'],
    ['Vereeniging Cricket Club - FS Mar 2024 Signed.pdf', 'financials'],
  ];
  for (const [name, key] of cases)
    test(`${name} → ${key}`, () => {
      const hit = DOC_RULES.find(([re]: [RegExp, string]) => re.test(name));
      assert.equal(hit?.[1], key);
    });

  test('an unrecognised filename is unclassified, never guessed', () => {
    assert.equal(classifyRel('Jeppe CC/mystery.pdf').kind, 'unclassified');
  });

  test('a bare "registration" (player forms) is not claimed as the club registration', () => {
    assert.equal(classifyRel('Jeppe CC/Player Registration Form.xlsx').kind, 'unclassified');
  });
});

describe('skip rules and _root-unique routing', () => {
  test('email bodies, inline email images, .msg and .pages are skipped wherever they appear', () => {
    for (const rel of [
      'Some Club/extracted/Re Anything - email body.txt',
      'Some Club/extracted/_inline-email-images/image001.png',
      'Some Club/Whatever.msg',
      'Some Club/Minutes.pages',
    ])
      assert.equal(classifyRel(rel).kind, 'skip', rel);
  });

  test('a _root-unique file with no override is unclassified even if a rule would match', () => {
    assert.equal(classifyRel('_root-unique/Some Club Constitution.pdf').kind, 'unclassified');
  });

  test('a club-less _root-unique doc override is a hard failure (no folder club)', () => {
    const rel = '_root-unique/Test Only Financials.pdf';
    FILE_OVERRIDES[rel] = 'financials';
    try {
      const r = classifyAll(toEntries([rel]));
      assert.equal(r.badReassignments.length, 1);
      assert.match(r.badReassignments[0], /has no club/);
    } finally {
      delete FILE_OVERRIDES[rel];
    }
  });

  test('Azaadville folder: the Azad Swaraj officials list is reassigned, source recorded', () => {
    const { classified } = classifyAll(
      toEntries(['Azaadville/extracted/LIST.OFFICIALS.25MAY25.pdf']),
    );
    assert.equal(classified[0].club?.id, idOf('Azad Swaraj'));
    assert.equal(classified[0].reassignedFrom?.id, idOf('Azaadville'));
    assert.equal(classified[0].docKey, 'committee');
  });

  test('the exported Pages PDF will import as Azaadville AGM minutes once dropped in', () => {
    assert.deepEqual(classifyRel('Azaadville/ACC AGM Minutes .pdf'), {
      kind: 'doc',
      docKey: 'agmMinutes',
    });
  });

  test('Old Parks keeps both the pptx original and its PDF conversion as financials', () => {
    const { classified } = classifyAll(
      toEntries([
        'The Old Parktonian/Old Parks finances for 2024 and 2025_cln (converted from pptx).pdf',
        'The Old Parktonian/Old Parks finances for 2024 and 2025_cln.pptx',
      ]),
    );
    assert.deepEqual(
      classified.map((f) => f.docKey),
      ['financials', 'financials'],
    );
  });
});

describe('fail-closed gate', () => {
  const { classified } = classifyAll(toEntries(REAL_PACK_PATHS));
  const base = { unclassified: [], unmappedFolders: [], badReassignments: [] };

  test('a docKey outside LIONS_DOC_KEYS is a hard failure', () => {
    const typo = {
      ...classified.find((f) => f.docKey === 'constitution')!,
      docKey: 'constitutoin',
    };
    const failures = parseHardFailures({ ...base, classified: [...classified, typo] });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /not in LIONS_DOC_KEYS/);
  });

  test('a doc club whose folder is missing is a hard failure', () => {
    const withoutJeppe = classified.filter((f) => f.folder !== 'Jeppe CC');
    const failures = parseHardFailures({ ...base, classified: withoutJeppe });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /Jeppe Cricket Club \[Jeppe CC\]/);
  });

  test('a single-file clash is a hard failure', () => {
    const failures = parseHardFailures({
      ...base,
      classified,
      singleFileClashes: ['x/constitution: a.pdf, b.pdf'],
    });
    assert.match(failures[0], /single-file doc key/);
  });

  test('an unknown pack folder is reported unmapped', () => {
    assert.deepEqual(classifyAll(toEntries(['Nowhere CC/x.pdf'])).unmappedFolders, ['Nowhere CC']);
  });
});

describe('catalogue alignment', () => {
  test('LIONS_DOC_KEYS / MULTI_FILE_DOC_KEYS mirror the lions catalogue exactly', () => {
    assert.deepEqual(
      LIONS_ACTIVE.map((d: { key: string }) => d.key),
      LIONS_DOC_KEYS,
    );
    assert.deepEqual(
      LIONS_ACTIVE.filter((d: { multiFile?: boolean }) => d.multiFile)
        .map((d: { key: string }) => d.key)
        .sort(),
      [...MULTI_FILE_DOC_KEYS].sort(),
    );
  });
});

describe('CLI flags', () => {
  test('--dir defaults to the prepared pack', () => {
    assert.equal(parseArgs(['--parse-only']).dir, PACK_DIR);
  });

  test('--revert takes no --dir / --club; --parse-only --confirm is rejected', () => {
    assert.throws(() => parseArgs(['--revert', '--dir', '/x']), /--revert takes no --dir/);
    assert.throws(() => parseArgs(['--revert', '--club', 'x']), /--revert takes no --club/);
    assert.throws(() => parseArgs(['--parse-only', '--confirm']), /--parse-only/);
    assert.equal(parseArgs(['--revert', '--confirm']).revert, true);
  });

  test('--club must be a doc club', () => {
    assert.throws(() => parseArgs(['--club', idOf('Pirates')]), /not a doc club/);
    assert.equal(parseArgs(['--club', idOf('Jeppe')]).club, idOf('Jeppe'));
  });

  test('--map-club is not supported (lions ids all come from CLUB_MAP)', () => {
    assert.throws(() => parseArgs(['--map-club', 'a=b']), /unknown flag --map-club/);
  });
});

describe('keys, manifest, revert, club building', () => {
  test('contentAddressedKey and isImportObjectKey agree under the lions prefix', () => {
    const id = idOf('Jeppe');
    const key = contentAddressedKey(id, 'financials', 'b'.repeat(64), 'pptx');
    assert.equal(key, `lions/${id}/financials-import-${'b'.repeat(16)}.pptx`);
    assert.equal(isImportObjectKey(key, id, 'financials'), true);
    assert.equal(isImportObjectKey(key.replace('lions/', 'tuskers/'), id, 'financials'), false);
  });

  test('the created-clubs manifest is lions-specific and stage-scoped', () => {
    assert.equal(LEGACY_CREATED_CLUBS_MANIFEST_PATH, './lions-import-created-clubs.json');
    assert.equal(createdClubsManifestPath({}), LEGACY_CREATED_CLUBS_MANIFEST_PATH);
    assert.equal(
      createdClubsManifestPath({ SST_RESOURCE_App: JSON.stringify({ stage: 'prod' }) }),
      './lions-import-created-clubs.prod.json',
    );
  });

  test('revert never deletes a club this import did not create, unless explicitly forced', () => {
    const r = (pristine: boolean, createdByImport: boolean, all = false, erase = false) =>
      revertAction({ pristine, createdByImport, all, erasePreexisting: erase });
    // An affiliation-created club looks pristine — stripped, never deleted.
    assert.equal(r(true, false), 'strip');
    assert.equal(r(true, false, true), 'strip');
    assert.equal(r(false, false, true), 'strip');
    assert.equal(r(true, true), 'delete-created');
    assert.equal(r(false, true), 'strip');
    assert.equal(r(false, true, true), 'delete-created');
    assert.equal(r(false, false, true, true), 'delete-forced');
    assert.equal(
      revertManifestGate({ all: true, erasePreexisting: true }, { kind: 'absent' }).kind,
      'refuse',
    );
    assert.equal(revertManifestGate({ all: true }, { kind: 'absent' }).kind, 'warn');
  });

  test('a created club carries the resolved district name and no officers', () => {
    const sed = CLUB_MAP.find((c) => c.district === 'Sedibeng' && c.folder)!;
    const club = buildClub(sed, LIONS_ACTIVE, 0, 'Sedibeng Cricket District');
    assert.equal(club.id, sed.id);
    assert.equal(club.district, 'Sedibeng Cricket District');
    assert.equal(club.chair, '');
    assert.deepEqual(club.leagues, []);
    assert.deepEqual(Object.keys(club.docs), LIONS_DOC_KEYS);
  });
});

describe('revert strip — import files only, never a rep upload', () => {
  const id = idOf('Jeppe');
  const imp = (docKey: string, c: string) => ({
    objectKey: contentAddressedKey(id, docKey, c.repeat(64), 'pdf'),
    size: 1,
    uploadedAt: '2026-10-01T00:00:00.000Z',
  });
  const rep = (docKey: string, n: number) => ({
    objectKey: `lions/${id}/${docKey}-rep-${n}.pdf`,
    size: 1,
    uploadedAt: '2026-10-02T00:00:00.000Z',
  });
  const defs = (min: number) =>
    new Map([['financials', { key: 'financials', multiFile: true, minFiles: min }]]) as never;

  test('a mixed multi-file key keeps only the rep files; import objects are queued for delete', () => {
    const a = imp('financials', 'a');
    const b = imp('financials', 'b');
    const r1 = rep('financials', 1);
    const out = stripImportDocs(
      {
        id,
        docs: { financials: true },
        docMeta: { financials: { files: [a, r1, b], markedCompliant: true, at: 'T' } },
      },
      defs(1),
    );
    assert.equal(out.stripped, 1);
    assert.deepEqual(out.objectKeysToDelete, [a.objectKey, b.objectKey]);
    assert.deepEqual(out.docMeta.financials, { files: [r1], markedCompliant: true, at: 'T' });
    assert.equal(out.docs.financials, true);
  });

  test('the docs flag is recomputed against minFiles once import files are gone', () => {
    const out = stripImportDocs(
      {
        id,
        docs: { financials: true },
        docMeta: { financials: { files: [imp('financials', 'a'), rep('financials', 1)] } },
      },
      defs(2),
    );
    assert.deepEqual(out.docMeta.financials, { files: [rep('financials', 1)] });
    assert.equal(out.docs.financials, false, 'one rep file left, two required');
  });

  test('an all-import key is removed outright; a rep-only key and a rep single upload are untouched', () => {
    const a = imp('financials', 'a');
    const single = imp('constitution', 'c');
    const repSingle = rep('beeCert', 1);
    const repMulti = { files: [rep('agmMinutes', 1)] };
    const out = stripImportDocs(
      {
        id,
        docs: { financials: true, constitution: true, beeCert: true, agmMinutes: true },
        docMeta: {
          financials: { files: [a] },
          constitution: single,
          beeCert: repSingle,
          agmMinutes: repMulti,
        },
      },
      defs(1),
    );
    assert.equal(out.stripped, 2);
    assert.deepEqual(out.objectKeysToDelete.sort(), [a.objectKey, single.objectKey].sort());
    assert.deepEqual(Object.keys(out.docMeta).sort(), ['agmMinutes', 'beeCert']);
    assert.deepEqual(out.docMeta.beeCert, repSingle);
    assert.deepEqual(out.docMeta.agmMinutes, repMulti);
    assert.deepEqual(out.docs, {
      financials: false,
      constitution: false,
      beeCert: true,
      agmMinutes: true,
    });
  });
});
