/**
 * Unit tests for the Tuskers (KZN Inland) compliance import's pure helpers — the
 * filename classifier over the REAL pack's 165 relative paths, the `{ club, docKey }`
 * reassignment extension, catalogue coverage against the `tuskers` entry in
 * configure-tenant-docs.ts, and the DOC_FORMAT_MIME odt/image additions. Pure — no
 * dynalite, no repo.js; the CLI guards its own entry point, so importing it never runs
 * main(). Same style as test/import-titans.test.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { CLUB_MAP, classifyFile, FILE_OVERRIDES, TUSKERS_DOC_KEYS, MULTI_FILE_DOC_KEYS } =
  await import('../src/tuskers-import-map.js');
const {
  classifyAll,
  buildClub,
  isImportObjectKey,
  contentAddressedKey,
  revertManifestGate,
  catalogueCoverageProblems,
  validateDocMimes,
  parseArgs,
  parseHardFailures,
  CREATED_CLUBS_MANIFEST_PATH,
  DISTRICT,
} = await import('../src/import-tuskers-compliance.js');
const { CATALOGUES } = await import('../src/configure-tenant-docs.js');
const { validateRequiredDocs } = await import('../src/config-validation.js');
const { DOC_FORMAT_MIME, acceptedMimes, activeRequiredDocs } = await import('../src/catalogue.js');
const { clubIdFromName } = await import('../src/club-id.js');

/**
 * Every file in /Users/…/Downloads/Tuskers as supplied by the union (generated with
 * `find . -type f | sort`), relative to the pack root. The classifier must place every
 * one of them — this list IS the exit criterion for the parse phase.
 */
const REAL_PACK_PATHS = [
  'Greytown CC Club/Copy of Greytown CC Nominal Roll 2023.xlsx',
  'Greytown CC Club/District Teams Affiliation Form - 2024_25 _District Clubs Affiliation GT.xlsx',
  'Greytown CC Club/Greytown AGM 2024.docx',
  'Greytown CC Club/Greytown AGM.docx',
  'Greytown CC Club/Greytown Affiliation Fee Payment Notification.pdf',
  'Greytown CC Club/Greytown Affiliation fees payment.pdf',
  'Greytown CC Club/Greytown CC - Affiliation Fees 2023.2024 - INU000147.pdf',
  'Greytown CC Club/Greytown CC - Statement.pdf',
  'Greytown CC Club/Greytown CC DC Inquiry 2026.docx',
  'Greytown CC Club/Greytown CC DC Inquiry 2026.pdf',
  'Greytown CC Club/Greytown CC Nominal Roll.xlsx',
  'Greytown CC Club/KZN Inland Letter Greytown 26 Feb 2024.docx',
  'Greytown CC Club/KZN Inland Letter Greytown 26 Feb 2024.pdf',
  'Howick CC Club/HCC Incident Report.pdf',
  'Howick CC Club/Howick AGM 2023.odt',
  'Howick CC Club/Howick CC - Affiliation Fees 2023.2024 - INU000148.pdf',
  'Howick CC Club/Howick CC - Statement as at 11 Mar 2024.pdf',
  'Howick CC Club/Howick CC - Statement.pdf',
  'Howick CC Club/Howick CC DC Letter 2024.pdf',
  'Howick CC Club/Howick CC DC Letter.docx',
  'Howick CC Club/Howick CC DC Letter.pdf',
  'Howick CC Club/Howick CC Letter 2025.pdf',
  'Howick CC Club/Howick CC Logo.jpg',
  'Howick CC Club/Howick CC Nominal Roll.xlsx',
  'Howick CC Club/Howick CC Nominal Rolls 2024.xlsx',
  'Howick CC Club/Howick CC Unregistered Players.docx',
  'Howick CC Club/Howick CC Unregistered Players.pdf',
  'Howick CC Club/Howick Cricket Club Code of Conduct.pdf',
  'Howick CC Club/Howick Cricket Club Constitution.pdf',
  'Howick CC Club/Howick letter 24 nov 2025.docx',
  'Howick CC Club/KZN CRICKET - ARBITRATION - REPORT.pdf',
  'Howick CC Club/KZN Inland Letter Howick CC.pdf',
  'Lancashire CC Club/Coaching Staff 2024 2025.docx',
  'Lancashire CC Club/Copy of District Teams Affiliation Form - 2024_25 _District Clubs Affiliation lancas.xlsx',
  'Lancashire CC Club/Final treasurers report AGM 2024.pdf',
  'Lancashire CC Club/LCC AGM 2022&2023 MINUTES.pdf',
  'Lancashire CC Club/LCC AGM 2023&2024 MINUTES.pdf',
  'Lancashire CC Club/LCC Copy of Inland Club  District Verification - 2023.2024 Season.xlsx',
  'Lancashire CC Club/LCC TREASURERS REPORT FY2022&2023.pdf',
  'Lancashire CC Club/Lancashire CC - Affiliation Fees 2023.2024 - INU000146.pdf',
  'Lancashire CC Club/Lancashire CC Nominal Roll.xlsx',
  'Lancashire CC Club/Lancashire CC Nominal Rolls 2024.xlsx',
  'Lancashire CC Club/Lancashire CC logo.jpg',
  'Lancashire CC Club/Signed NPO Consti LCC.pdf',
  'MCC Club/D Fynn.pdf',
  'MCC Club/District Teams Affiliation Form - 2024 Season.xlsx',
  'MCC Club/District Teams Affiliation Form - 2024_25 _District Clubs Affiliation (1) MCC.xlsx',
  'MCC Club/KZN Inland Letter MCC 06 March 2024.docx',
  'MCC Club/KZN Inland Letter MCC 06 March 2024.pdf',
  'MCC Club/KZN Inland Letter MCC 15 Feb 2024.docx',
  'MCC Club/KZN Inland Letter MCC 15 Feb 2024.pdf',
  'MCC Club/Lynwood Club.jpg',
  'MCC Club/MCC - AGM Minutes 05 July 2024.pdf',
  'MCC Club/MCC Constitution.pdf',
  'MCC Club/MCC DC Letter Shaun  2024.pdf',
  'MCC Club/MCC DC Letter Shaun Truter.docx',
  'MCC Club/MCC DC letter Shaun Truter.pdf',
  'MCC Club/MCC Inland Club & District Verification - 2023.2024 Season.xlsx',
  'MCC Club/MCC Nominal Roll (9).xlsx',
  'MCC Club/MCC Nominal Rolls 2024.xlsx',
  'MCC Club/MCC SLA.pdf',
  'MCC Club/MCC letter 2024.pdf',
  'MCC Club/MCC logo.jpg',
  'MCC Club/Maritzburg CC - Affiliation Fees 2023.2024 - INU000145.pdf',
  'MCC Club/Maritzburg CC Nominal Roll.xlsx',
  'MCC Club/Michael king Reg.pdf',
  'MCC Club/Proof_Of_Payment (4) MCC.pdf',
  'MCC Club/SLA Doc MCC.pdf',
  'MCC Club/Screenshot 2024-04-08 083019 - Kurt Mannikam.png',
  'MCC Club/Sohail Gani Clearance.jpg',
  'MCC Club/asanda.jpg',
  'MCC Club/virat-kohli-4k-ap-1920x1080.jpg',
  'Masibemunye CC Club/Affiliation Letter Masibemunye CC 2025.pdf',
  'Masibemunye CC Club/Affiliation Letter Masibemunye CC.docx',
  'Masibemunye CC Club/Clearance Gwala and tapelo.pdf',
  'Masibemunye CC Club/Copy of Masi- Transport Claim 2026.xlsx',
  'Masibemunye CC Club/KZN Inland Letter Masi 07 March 2024.docx',
  'Masibemunye CC Club/KZN Inland Letter Masi 07 March 2024.pdf',
  'Masibemunye CC Club/Masi Premier Promotion League - Affiliation Form 2023_24 (003) masi.xlsx',
  'Masibemunye CC Club/Masi Transport Claim.xlsx',
  'Masibemunye CC Club/Masibemunye CC - Affiliation Fees 2023.2024 - INU000151.pdf',
  'Masibemunye CC Club/Masibemunye CC - Statement.pdf',
  'Masibemunye CC Club/Masibemunye CC Club Funding Document.pdf',
  'Masibemunye CC Club/Masibemunye CC DC Letter 2024.pdf',
  'Masibemunye CC Club/Masibemunye CC Nominal Roll.xlsx',
  'Masibemunye CC Club/Masibemunye CC Nominal Rolls 2024.xlsx',
  'Masibemunye CC Club/Masibemunye Cricket Club Revised Funding.docx',
  'Masibemunye CC Club/Masibemunye Cricket Club Revised Funding.pdf',
  'Masibemunye CC Club/Masibemunye Funds request.pdf',
  'Masibemunye CC Club/Masibemunye cricket club AGM minute.docx',
  'Masibemunye CC Club/SKM_C30824080810300.pdf',
  'Standard CC Club/AGM Minutes May 2023.docx.pdf',
  'Standard CC Club/Appeals Letter Standard CC.docx',
  'Standard CC Club/Chad Incident Report 18 Feb 2024.pdf',
  'Standard CC Club/Chad P Clearance.pdf',
  'Standard CC Club/District Teams Affiliation Form - 2024 season.xlsx',
  'Standard CC Club/District Teams Affiliation Form - 2024_25 _District Clubs Affiliation Standard.xlsx',
  'Standard CC Club/KZN Inland Letter Lancashire Ground Booking 26 March 2024.pdf',
  'Standard CC Club/KZN Inland Letter Standard 14 March 2024.docx',
  'Standard CC Club/KZN Inland Letter Standard CC 14 March 2024.pdf',
  'Standard CC Club/KZN Inland Letter Standard CC 16 April 2025.pdf',
  'Standard CC Club/KZN Inland Letter Standard CC 5 December 2023.docx',
  'Standard CC Club/KZN Inland Letter to Standard CC 7April 2025 Club Champs.pdf',
  'Standard CC Club/KZN Inland Letter to Standard CC February 2026.pdf',
  'Standard CC Club/Minutes of AGM June 2024.docx',
  'Standard CC Club/POP - Standard CC - Prize Money.pdf',
  'Standard CC Club/POP - Standard CC Grant.pdf',
  'Standard CC Club/Standard Balance Sheet  Income Statement - Feb 2023.pdf',
  'Standard CC Club/Standard CC - Affiliation Fees 2023.2024 - INU000144.pdf',
  'Standard CC Club/Standard CC Franchise Final Letter 2024.pdf',
  'Standard CC Club/Standard CC Logo.jpg',
  'Standard CC Club/Standard CC Nominal Roll.xlsx',
  'Standard CC Club/Standard CC Nominal Rolls 2024.xlsx',
  'Standard CC Club/Standard CC Regional Final Letter 2024.docx',
  'Standard CC Club/Standard CSA Generic Team Return Form 2025_26-1.xlsx',
  'Standard CC Club/Standard Constitution.pdf',
  'Standard CC Club/Standard DC Letter Chad Potgieter 2024.pdf',
  'Standard CC Club/Standard DC Letter Chad Potgieter.docx',
  'Standard CC Club/Standard DC letter Chad Potgieter 2024.docx',
  'Standard CC Club/Standard DC letter Chad Potgieter 24.pdf',
  'Standard CC Club/Standard DC letter Chad Potgieter.pdf',
  'Standard CC Club/Standard DC letter ChadPotgieter 2024.docx',
  'Standard CC Club/Standard DC letter ChadPotgieter 2024.pdf',
  'Standard CC Club/Standard POP Affiliation fees.jpg',
  'Standard CC Club/Standard Womens Trial.pdf',
  'Standard CC Club/umpires report Standard vs Masi 2024.jpg',
  'UKZN CC Club/Cian Fortman .jpg',
  'UKZN CC Club/District Teams Affiliation Form - 2024 Season.xlsx',
  'UKZN CC Club/District Teams Affiliation Form - 2024_25 _District Clubs Affiliation UKZN.xlsx',
  'UKZN CC Club/LETTER TO YOGESH J - 11 JAN 2024.pdf',
  'UKZN CC Club/Minutes - AGM 13.05.2023.pdf',
  'UKZN CC Club/Minutes - UKZN CRicket  AGM 2026.pdf',
  'UKZN CC Club/SLA Letter UKZN.pdf',
  'UKZN CC Club/UKZN CC DC Inquiry.pdf',
  'UKZN CC Club/UKZN CC DC.docx',
  'UKZN CC Club/UKZN CC Logo.jpg',
  'UKZN CC Club/UKZN CC Nominal Roll 2023.2024.xlsx',
  'UKZN CC Club/UKZN CC Nominal Rolls 2024.xlsx',
  'UKZN CC Club/UKZN Constitution.pdf',
  'UKZN CC Club/UKZN Cricket Club PMB Letterhead 2022 (3) income and expenses.pdf',
  'UKZN CC Club/UKZN DC 2025.docx',
  'UKZN CC Club/UKZN DC Letter 2025.docx',
  'UKZN CC Club/UKZN DC Letter 25.pdf',
  'UKZN CC Club/UKZN DC Letter Ashok 2024.pdf',
  'UKZN CC Club/UKZN DC Letter Ashok.docx',
  'UKZN CC Club/UKZN DC letter Ashok Bharath.docx',
  'UKZN CC Club/UKZN DC letter Ashok Bharath.pdf',
  'UKZN CC Club/UKZN Letter 02 Dec 2025.pdf',
  'UKZN CC Club/UKZN Letter 02 Dec 25.docx',
  'UKZN CC Club/UKZN Letter 07 Dec 25.pdf',
  'UKZN CC Club/UKZN Thank You letter 2023.pdf',
  'UKZN CC Club/UKZN Thank You letter.docx',
  'UKZN CC Club/Umpires Report UKZN vs Lanceshire 12 October 2025 (002).docx',
  'UKZN CC Club/Varsity CC - Affiliation Fees 2023.2024 - INU000150.pdf',
  'Young Natalians CC Club/District Teams Affiliation Form - 2024_25 _District Clubs Affiliation YN.xlsx',
  'Young Natalians CC Club/KZN Inland Letter Young Natalians .pdf',
  'Young Natalians CC Club/Young Natalians CC - Affiliation Fees 2023.2024 - INU000154.pdf',
  'Young Natalians CC Club/Young Natalians CC - Statement.pdf',
  'Young Natalians CC Club/Young Natalians CC Nominal Roll.xlsx',
  'Young Natalians CC Club/Young Natalians Cricket Club Finance.docx',
  'Young Natalians CC Club/Young Nats AGM 2025.docx',
  'Young Natalians CC Club/Young Nats AGM.docx',
  'Young Natalians CC Club/Young Nats Affiliation Form - 2026_27.xlsx',
  'Young Natalians CC Club/Young Nats CC Nominal Rolls 2024.xlsx',
  'Young Natalians CC Club/Young Nats Constitution.pdf',
];

const toEntries = (paths: string[]) =>
  paths.map((rel) => ({
    rel,
    abs: `/nonexistent/${rel}`,
    folder: rel.split('/')[0],
    filename: rel.split('/').slice(1).join('/'),
  }));

const TUSKERS_CATALOGUE = CATALOGUES.tuskers;
const ACTIVE = activeRequiredDocs({ requiredDocs: TUSKERS_CATALOGUE } as never);
const MASI = clubIdFromName('Masibemunye Cricket Club');
const LANCASHIRE = clubIdFromName('Lancashire Cricket Club');

const docKeyOf = (rel: string) => {
  const r = classifyFile(rel, rel.split('/').slice(1).join('/'));
  return r.kind === 'doc' ? r.docKey : r.kind;
};

describe('classifier over the real Tuskers pack (165 files)', () => {
  const { classified, unclassified, unmappedFolders, badReassignments } = classifyAll(
    toEntries(REAL_PACK_PATHS),
  );

  test('the embedded listing is the full pack', () => {
    assert.equal(REAL_PACK_PATHS.length, 165);
  });

  test('zero unclassified files, zero unmapped folders, zero bad reassignments', () => {
    assert.deepEqual(
      unclassified.map((f: { rel: string }) => f.rel),
      [],
    );
    assert.deepEqual(unmappedFolders, []);
    assert.deepEqual(badReassignments, []);
  });

  test('142 files import and 23 are deliberate skips', () => {
    const skips = classified.filter((f: { skipReason?: string }) => f.skipReason);
    const docs = classified.filter((f: { docKey?: string }) => f.docKey);
    assert.equal(skips.length, 23);
    assert.equal(docs.length, 142);
  });

  test('every club has at least one classified doc', () => {
    for (const club of CLUB_MAP) {
      assert.ok(
        classified.some(
          (f: { club?: { id: string }; docKey?: string }) => f.club?.id === club.id && f.docKey,
        ),
        `${club.name} has no docs`,
      );
    }
  });

  test('every doc key the classifier produces is a TUSKERS_DOC_KEYS key', () => {
    const keys = new Set(classified.flatMap((f) => (f.docKey ? [f.docKey] : [])));
    for (const k of keys) assert.ok(TUSKERS_DOC_KEYS.includes(k), `unexpected key ${k}`);
  });

  test('per-club doc-key counts (pre-dedupe) match the reviewed classification', () => {
    const counts: Record<string, Record<string, number>> = {};
    for (const f of classified as Array<{ club?: { id: string }; docKey?: string }>) {
      if (!f.docKey || !f.club) continue;
      counts[f.club.id] ??= {};
      counts[f.club.id][f.docKey] = (counts[f.club.id][f.docKey] ?? 0) + 1;
    }
    assert.deepEqual(counts, {
      [clubIdFromName('Young Natalians Cricket Club')]: {
        affiliationForm: 2,
        unionCorrespondence: 1,
        affiliationFees: 2,
        nominalRoll: 2,
        financials: 1,
        agmMinutes: 2,
        constitution: 1,
      },
      [clubIdFromName('Howick Cricket Club')]: {
        disciplinaryRecords: 6,
        agmMinutes: 1,
        affiliationFees: 3,
        clubLogo: 1,
        nominalRoll: 2,
        facilityAgreement: 1,
        constitution: 1,
        unionCorrespondence: 1,
      },
      [clubIdFromName('Standard Cricket Club')]: {
        agmMinutes: 2,
        disciplinaryRecords: 7,
        playerRegistrations: 1,
        affiliationForm: 2,
        unionCorrespondence: 6,
        clubRecords: 3,
        financials: 1,
        affiliationFees: 2,
        clubLogo: 1,
        nominalRoll: 3,
        constitution: 1,
      },
      [MASI]: {
        playerRegistrations: 2,
        unionCorrespondence: 2,
        clubRecords: 6,
        affiliationForm: 1,
        affiliationFees: 2,
        disciplinaryRecords: 1,
        nominalRoll: 2,
        agmMinutes: 1,
      },
      [clubIdFromName('Greytown Cricket Club')]: {
        nominalRoll: 2,
        affiliationForm: 1,
        agmMinutes: 2,
        affiliationFees: 4,
        disciplinaryRecords: 1,
        unionCorrespondence: 1,
      },
      [clubIdFromName('UKZN Cricket Club')]: {
        playerRegistrations: 1,
        affiliationForm: 2,
        facilityAgreement: 2,
        agmMinutes: 2,
        disciplinaryRecords: 8,
        clubLogo: 1,
        nominalRoll: 2,
        constitution: 1,
        financials: 1,
        unionCorrespondence: 1,
        affiliationFees: 1,
      },
      [clubIdFromName('Maritzburg Cricket Club')]: {
        playerRegistrations: 3,
        affiliationForm: 2,
        unionCorrespondence: 3,
        agmMinutes: 1,
        constitution: 1,
        disciplinaryRecords: 3,
        nominalRoll: 3,
        facilityAgreement: 3,
        clubLogo: 1,
        affiliationFees: 2,
        clubRecords: 1,
      },
      [LANCASHIRE]: {
        clubRecords: 1,
        affiliationForm: 1,
        financials: 2,
        agmMinutes: 2,
        unionCorrespondence: 2,
        affiliationFees: 1,
        nominalRoll: 2,
        clubLogo: 1,
        constitution: 1,
      },
    });
  });

  test('Greytown and Masibemunye have no constitution (stays outstanding — correct signal)', () => {
    for (const id of [clubIdFromName('Greytown Cricket Club'), MASI]) {
      assert.ok(
        !classified.some(
          (f: { club?: { id: string }; docKey?: string }) =>
            f.club?.id === id && f.docKey === 'constitution',
        ),
      );
    }
  });

  test('the two misfiled files are reassigned to their real club, with the source recorded', () => {
    const asanda = classified.find((f: { rel: string }) => f.rel === 'MCC Club/asanda.jpg');
    assert.equal(asanda?.club?.id, MASI);
    assert.equal(asanda?.docKey, 'playerRegistrations');
    assert.equal(asanda?.reassignedFrom?.id, clubIdFromName('Maritzburg Cricket Club'));

    const booking = classified.find(
      (f: { rel: string }) =>
        f.rel === 'Standard CC Club/KZN Inland Letter Lancashire Ground Booking 26 March 2024.pdf',
    );
    assert.equal(booking?.club?.id, LANCASHIRE);
    assert.equal(booking?.docKey, 'unionCorrespondence');
    assert.equal(booking?.reassignedFrom?.id, clubIdFromName('Standard Cricket Club'));
  });
});

describe('FILE_OVERRIDES outcomes (content-verified decisions)', () => {
  test('non-document and wrong-club files are skipped', () => {
    for (const rel of [
      'MCC Club/virat-kohli-4k-ap-1920x1080.jpg',
      'MCC Club/Lynwood Club.jpg',
      'Standard CC Club/Appeals Letter Standard CC.docx',
    ]) {
      assert.equal(docKeyOf(rel), 'skip', rel);
    }
  });

  test('Greytown DC Inquiry: the blank-register .docx is skipped, the real summons .pdf imports', () => {
    assert.equal(docKeyOf('Greytown CC Club/Greytown CC DC Inquiry 2026.docx'), 'skip');
    assert.equal(
      docKeyOf('Greytown CC Club/Greytown CC DC Inquiry 2026.pdf'),
      'disciplinaryRecords',
    );
  });

  test('docx halves of same-content docx+pdf pairs are skipped; the pdf imports', () => {
    const pairs: Array<[string, string, string]> = [
      [
        'Howick CC Club/Howick CC DC Letter.docx',
        'Howick CC Club/Howick CC DC Letter.pdf',
        'disciplinaryRecords',
      ],
      [
        'MCC Club/KZN Inland Letter MCC 15 Feb 2024.docx',
        'MCC Club/KZN Inland Letter MCC 15 Feb 2024.pdf',
        'unionCorrespondence',
      ],
      [
        'UKZN CC Club/UKZN Thank You letter.docx',
        'UKZN CC Club/UKZN Thank You letter 2023.pdf',
        'unionCorrespondence',
      ],
      [
        'Masibemunye CC Club/Masibemunye Cricket Club Revised Funding.docx',
        'Masibemunye CC Club/Masibemunye Cricket Club Revised Funding.pdf',
        'clubRecords',
      ],
      [
        'Standard CC Club/Standard DC letter Chad Potgieter 2024.docx',
        'Standard CC Club/Standard DC letter Chad Potgieter 24.pdf',
        'disciplinaryRecords',
      ],
    ];
    for (const [docx, pdf, key] of pairs) {
      assert.equal(docKeyOf(docx), 'skip', docx);
      assert.equal(docKeyOf(pdf), key, pdf);
    }
  });

  test('same-stem docx letters whose CONTENT differs are kept, not skipped', () => {
    // 28 Feb outcome letters with a different sanction from the 29 Feb pdf finals.
    assert.equal(
      docKeyOf('Standard CC Club/Standard DC Letter Chad Potgieter.docx'),
      'disciplinaryRecords',
    );
    assert.equal(docKeyOf('MCC Club/MCC DC Letter Shaun Truter.docx'), 'disciplinaryRecords');
  });

  test('forced doc keys the regexes would miss or mis-place', () => {
    const forced: Record<string, string> = {
      'MCC Club/D Fynn.pdf': 'playerRegistrations',
      'UKZN CC Club/Cian Fortman .jpg': 'playerRegistrations',
      'MCC Club/Michael king Reg.pdf': 'playerRegistrations',
      'UKZN CC Club/LETTER TO YOGESH J - 11 JAN 2024.pdf': 'facilityAgreement',
      'MCC Club/MCC letter 2024.pdf': 'facilityAgreement',
      'MCC Club/SLA Doc MCC.pdf': 'facilityAgreement',
      'MCC Club/MCC SLA.pdf': 'facilityAgreement',
      'Howick CC Club/Howick Cricket Club Code of Conduct.pdf': 'facilityAgreement',
      'Howick CC Club/KZN CRICKET - ARBITRATION - REPORT.pdf': 'disciplinaryRecords',
      'Standard CC Club/Standard Womens Trial.pdf': 'clubRecords',
      'Masibemunye CC Club/SKM_C30824080810300.pdf': 'clubRecords',
      'MCC Club/Screenshot 2024-04-08 083019 - Kurt Mannikam.png': 'clubRecords',
      'Standard CC Club/umpires report Standard vs Masi 2024.jpg': 'disciplinaryRecords',
      'MCC Club/MCC Inland Club & District Verification - 2023.2024 Season.xlsx':
        'unionCorrespondence',
      'Lancashire CC Club/LCC Copy of Inland Club  District Verification - 2023.2024 Season.xlsx':
        'unionCorrespondence',
      'Masibemunye CC Club/Affiliation Letter Masibemunye CC 2025.pdf': 'unionCorrespondence',
      'Lancashire CC Club/Final treasurers report AGM 2024.pdf': 'financials',
      'Standard CC Club/Standard Balance Sheet  Income Statement - Feb 2023.pdf': 'financials',
      'Lancashire CC Club/Signed NPO Consti LCC.pdf': 'constitution',
      'Standard CC Club/Standard CSA Generic Team Return Form 2025_26-1.xlsx': 'nominalRoll',
      'MCC Club/Proof_Of_Payment (4) MCC.pdf': 'affiliationFees',
      'Standard CC Club/Standard POP Affiliation fees.jpg': 'affiliationFees',
      'MCC Club/District Teams Affiliation Form - 2024_25 _District Clubs Affiliation (1) MCC.xlsx':
        'affiliationForm',
    };
    for (const [rel, key] of Object.entries(forced)) assert.equal(docKeyOf(rel), key, rel);
  });

  test('every FILE_OVERRIDES key names a real file in the pack (no stale entries)', () => {
    const real = new Set(REAL_PACK_PATHS);
    for (const rel of Object.keys(FILE_OVERRIDES))
      assert.ok(real.has(rel), `stale override: ${rel}`);
  });

  test('an unrecognised filename is reported unclassified, not guessed at', () => {
    assert.equal(classifyFile('Howick CC Club/mystery.pdf', 'mystery.pdf').kind, 'unclassified');
  });
});

describe('classifyAll — { club, docKey } reassignment extension', () => {
  test('a reassigned file lands in the target club, not its folder club', () => {
    const { classified } = classifyAll(toEntries(['MCC Club/asanda.jpg']));
    assert.equal(classified.length, 1);
    assert.equal(classified[0].club?.id, MASI);
    assert.equal(classified[0].docKey, 'playerRegistrations');
    assert.equal(classified[0].reassignedFrom?.folder, 'MCC Club');
  });

  test('a non-reassigned file keeps its folder club and records no source', () => {
    const { classified } = classifyAll(toEntries(['MCC Club/MCC logo.jpg']));
    assert.equal(classified[0].club?.id, clubIdFromName('Maritzburg Cricket Club'));
    assert.equal(classified[0].reassignedFrom, undefined);
  });

  test('classifyFile surfaces the reassignment club only for reassignments', () => {
    const moved = classifyFile('MCC Club/asanda.jpg', 'asanda.jpg');
    assert.deepEqual(moved, { kind: 'doc', docKey: 'playerRegistrations', club: MASI });
    const plain = classifyFile('MCC Club/D Fynn.pdf', 'D Fynn.pdf');
    assert.deepEqual(plain, { kind: 'doc', docKey: 'playerRegistrations' });
  });

  test('an unknown folder is reported unmapped', () => {
    const { unmappedFolders } = classifyAll(toEntries(['Some Other CC/MCC logo.jpg']));
    assert.deepEqual(unmappedFolders, ['Some Other CC']);
  });
});

describe('CLUB_MAP / buildClub', () => {
  test('8 clubs, ids derived via clubIdFromName', () => {
    assert.equal(CLUB_MAP.length, 8);
    for (const c of CLUB_MAP) assert.equal(c.id, clubIdFromName(c.name));
    assert.equal(new Set(CLUB_MAP.map((c: { id: string }) => c.id)).size, 8);
  });

  test('a built club is in Umgungundlovu with no leagues, no team plan and no ground', () => {
    const club = buildClub(CLUB_MAP[0], ACTIVE, 0);
    assert.equal(DISTRICT, 'Umgungundlovu');
    assert.equal(club.district, 'Umgungundlovu');
    assert.deepEqual(club.leagues, []);
    assert.deepEqual(club.ground, {});
    assert.equal(club.leagueTeams, undefined);
    assert.equal(club.teamRosters, undefined);
    assert.equal(club.affiliation, 'not_started');
    assert.deepEqual(Object.keys(club.docs).sort(), [...TUSKERS_DOC_KEYS].sort());
    assert.ok(Object.values(club.docs).every((v) => v === false));
  });

  test("each built club's chair is the content-verified NAME from its own documents", () => {
    const expected: Record<string, string> = {
      'Young Natalians Cricket Club': 'Faiyaz Patel',
      'Howick Cricket Club': 'Ashley Sokaloo',
      'Standard Cricket Club': 'Robbie Coutts',
      'Masibemunye Cricket Club': 'Mondli Ndlovu',
      'Greytown Cricket Club': 'Sadaf Zaman',
      'UKZN Cricket Club': 'Dale Nadasan',
      'Maritzburg Cricket Club': 'Barry Moig',
      'Lancashire Cricket Club': 'Mike Buckley',
    };
    for (const [i, c] of CLUB_MAP.entries()) {
      const club = buildClub(c, ACTIVE, i);
      assert.equal(club.chair, expected[c.name], c.name);
      assert.doesNotMatch(club.chair, /pending/i);
    }
  });

  test('names only: a built club carries no chair phone or email (PII + notifications)', () => {
    for (const [i, c] of CLUB_MAP.entries()) {
      const club = buildClub(c, ACTIVE, i) as unknown as Record<string, unknown>;
      // `exco.chair` is where a chair's contact details live — never seeded by this import.
      for (const field of ['exco', 'chairEmail', 'chairPhone', 'email', 'phone', 'cell'])
        assert.equal(club[field], undefined, `${c.name}.${field}`);
      assert.doesNotMatch(String(club.chair), /@|\d/, `${c.name} chair is a bare name`);
    }
  });
});

describe('tuskers catalogue (configure-tenant-docs.ts)', () => {
  test('passes the operator route validator', () => {
    assert.doesNotThrow(() => validateRequiredDocs(TUSKERS_CATALOGUE));
  });

  test('keys are exactly TUSKERS_DOC_KEYS', () => {
    assert.deepEqual(
      TUSKERS_CATALOGUE.map((d: { key: string }) => d.key).sort(),
      [...TUSKERS_DOC_KEYS].sort(),
    );
  });

  test('the catalogue multiFile set equals MULTI_FILE_DOC_KEYS', () => {
    const multi = TUSKERS_CATALOGUE.filter((d: { multiFile?: boolean }) => d.multiFile).map(
      (d: { key: string }) => d.key,
    );
    assert.deepEqual(multi.sort(), [...MULTI_FILE_DOC_KEYS].sort());
  });

  test('catalogueCoverageProblems reports nothing at the real pack’s post-dedupe worst case', () => {
    const needed = new Map([
      ['nominalRoll', 3],
      ['affiliationForm', 2],
      ['agmMinutes', 2],
      ['affiliationFees', 3],
      ['disciplinaryRecords', 8],
      ['unionCorrespondence', 6],
      ['facilityAgreement', 2],
      ['clubRecords', 6],
      ['financials', 2],
      ['playerRegistrations', 3],
    ]);
    assert.deepEqual(catalogueCoverageProblems(ACTIVE, needed), []);
  });

  test('forward: a multi-file key configured single-file is reported', () => {
    const docs = ACTIVE.map((d) =>
      d.key === 'agmMinutes' ? { key: 'agmMinutes', name: 'AGM minutes' } : d,
    );
    const problems = catalogueCoverageProblems(docs, new Map());
    assert.ok(
      problems.some((p: string) => p.includes('"agmMinutes"') && p.includes('single-file')),
    );
  });

  test('forward: a cap below the busiest club is reported', () => {
    const problems = catalogueCoverageProblems(ACTIVE, new Map([['disciplinaryRecords', 16]]));
    assert.ok(
      problems.some((p: string) => p.includes('"disciplinaryRecords"') && p.includes('16')),
    );
  });

  test('reverse: a single-file key (constitution) configured multiFile is reported', () => {
    const docs = ACTIVE.map((d) =>
      d.key === 'constitution'
        ? { key: 'constitution', name: 'C', multiFile: true, minFiles: 1, maxFiles: 2 }
        : d,
    );
    const problems = catalogueCoverageProblems(docs, new Map());
    assert.ok(
      problems.some((p: string) => p.includes('"constitution"') && p.includes('multiFile')),
    );
  });

  test('nominalRoll carries the memberDatabase role', () => {
    const roll = TUSKERS_CATALOGUE.find((d: { key: string }) => d.key === 'nominalRoll');
    assert.equal(roll?.role, 'memberDatabase');
  });
});

describe('DOC_FORMAT_MIME additions (odt + images)', () => {
  test('odt/jpg/jpeg/png resolve to their MIME types', () => {
    assert.equal(DOC_FORMAT_MIME.odt, 'application/vnd.oasis.opendocument.text');
    assert.equal(DOC_FORMAT_MIME.jpg, 'image/jpeg');
    assert.equal(DOC_FORMAT_MIME.jpeg, 'image/jpeg');
    assert.equal(DOC_FORMAT_MIME.png, 'image/png');
  });

  test('presign accept logic: an image passes on a key that accepts it', () => {
    const logo = ACTIVE.find((d: { key: string }) => d.key === 'clubLogo');
    const mimes = acceptedMimes(logo);
    assert.equal(mimes['image/png'], 'png');
    // jpg and jpeg share image/jpeg — the first listed (jpg) is the stored extension.
    assert.equal(mimes['image/jpeg'], 'jpg');
  });

  test('presign accept logic: an image is still rejected on a key that does not accept it', () => {
    const constitution = ACTIVE.find((d: { key: string }) => d.key === 'constitution');
    assert.equal(acceptedMimes(constitution)['image/jpeg'], undefined);
    assert.equal(acceptedMimes(constitution)['image/png'], undefined);
    // A doc with no `accepts` keeps the legacy pdf/doc/docx default — no images, no odt.
    const legacy = acceptedMimes({ key: 'x', name: 'X' });
    assert.deepEqual(Object.values(legacy).sort(), ['doc', 'docx', 'pdf']);
  });

  test('odt is accepted on agmMinutes only where configured', () => {
    const agm = ACTIVE.find((d: { key: string }) => d.key === 'agmMinutes');
    assert.equal(acceptedMimes(agm)['application/vnd.oasis.opendocument.text'], 'odt');
    const fin = ACTIVE.find((d: { key: string }) => d.key === 'financials');
    assert.equal(acceptedMimes(fin)['application/vnd.oasis.opendocument.text'], undefined);
  });

  test('the validator accepts the new formats in `accepts`', () => {
    assert.doesNotThrow(() =>
      validateRequiredDocs([{ key: 'pics', name: 'Pics', accepts: ['odt', 'jpg', 'jpeg', 'png'] }]),
    );
  });
});

describe('parse-phase fail-closed gate', () => {
  const { classified } = classifyAll(toEntries(REAL_PACK_PATHS));

  test('the real pack produces no hard failures', () => {
    assert.deepEqual(
      parseHardFailures({
        classified,
        unclassified: [],
        unmappedFolders: [],
        badReassignments: [],
      }),
      [],
    );
  });

  test('a docKey outside TUSKERS_DOC_KEYS (override/rule typo) is a hard failure', () => {
    // A pdf under a typo'd key would otherwise pass MIME validation: acceptedMimes(undefined)
    // falls back to the legacy pdf/doc/docx default.
    const typo = {
      ...classified.find((f) => f.docKey === 'constitution')!,
      docKey: 'constitutoin',
    };
    const failures = parseHardFailures({
      classified: [...classified, typo],
      unclassified: [],
      unmappedFolders: [],
      badReassignments: [],
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /not in TUSKERS_DOC_KEYS/);
    assert.match(failures[0], /"constitutoin"/);
  });
});

describe('catalogue accepts vs real-pack extensions (validateDocMimes over all 142 docs)', () => {
  test('every classified real-pack file passes the tuskers catalogue MIME check', () => {
    const { classified } = classifyAll(toEntries(REAL_PACK_PATHS));
    const docs = classified.filter((f: { docKey?: string }) => f.docKey);
    assert.equal(docs.length, 142);
    // Same ext → DOC_FORMAT_MIME → acceptedMimes(def) path the dry-run/confirm run uses —
    // catches a catalogue `accepts` narrowing (or a new pack extension) before prod does.
    assert.doesNotThrow(() => validateDocMimes(docs, ACTIVE));
  });

  test('the check still bites: a jpg on constitution fails', () => {
    const { classified } = classifyAll(toEntries(['Howick CC Club/Howick CC Logo.jpg']));
    const wrong = [{ ...classified[0], docKey: 'constitution' }];
    assert.throws(() => validateDocMimes(wrong, ACTIVE), /accepted-type validation/);
  });
});

describe('CLI flag combinations', () => {
  test('--revert --club is rejected (there is no scoped revert)', () => {
    assert.throws(() => parseArgs(['--revert', '--club', MASI]), /--revert takes no --club/);
  });

  test('--parse-only --confirm is rejected', () => {
    assert.throws(() => parseArgs(['--dir', '/x', '--parse-only', '--confirm']), /--parse-only/);
  });

  test('valid combinations still parse', () => {
    assert.equal(parseArgs(['--revert', '--confirm']).revert, true);
    assert.equal(parseArgs(['--dir', '/x', '--confirm', '--club', MASI]).club, MASI);
    assert.equal(parseArgs(['--dir', '/x', '--parse-only']).parseOnly, true);
  });
});

describe('import-authored object keys + revert gate (tuskers copies)', () => {
  test('contentAddressedKey and isImportObjectKey agree, under the tuskers prefix', () => {
    const key = contentAddressedKey(MASI, 'playerRegistrations', 'a'.repeat(64), 'jpg');
    assert.equal(key, `tuskers/${MASI}/playerRegistrations-import-${'a'.repeat(16)}.jpg`);
    assert.equal(isImportObjectKey(key, MASI, 'playerRegistrations'), true);
    assert.equal(isImportObjectKey(key, MASI, 'clubRecords'), false);
    assert.equal(
      isImportObjectKey(key.replace('tuskers/', 'titans/'), MASI, 'playerRegistrations'),
      false,
    );
  });

  test('the created-clubs manifest is tuskers-specific (never shares titans state)', () => {
    assert.equal(CREATED_CLUBS_MANIFEST_PATH, './tuskers-import-created-clubs.json');
  });

  test('--all --erase-preexisting refuses without a readable manifest; --all alone warns', () => {
    assert.equal(
      revertManifestGate({ all: true, erasePreexisting: true }, { kind: 'absent' }).kind,
      'refuse',
    );
    assert.equal(revertManifestGate({ all: true }, { kind: 'absent' }).kind, 'warn');
    assert.equal(revertManifestGate({ all: true }, { kind: 'ok' }).kind, 'proceed');
  });
});
