/**
 * Tuskers (KwaZulu-Natal Inland Cricket Union) compliance-pack import — pure data + pure
 * classification helpers, NO AWS imports.
 *
 * Copy-and-trim of titans-import-map.ts (the planb→titans lineage precedent): this pack
 * ships no league-structure workbook, so everything structure/team-token related is
 * gone. What's left is the club roster (CLUB_MAP) and the filename classifier
 * (DOC_RULES + FILE_OVERRIDES), consumed by import-tuskers-compliance.ts and exercised
 * directly by test/import-tuskers.test.ts without touching DynamoDB/S3.
 *
 * WHY A SEPARATE MAP FILE: the CLI's `--parse-only` mode must run with plain `npx tsx`
 * (no `sst shell`, no AWS creds) so the classifier can be iterated against the real
 * extracted pack — see docs/runbooks/tuskers-compliance-import.md.
 *
 * Every file in the pack was text-extracted (or, for image-only scans, visually
 * inspected) before these rules and overrides were written — see
 * plans/tuskers-compliance-import-plan.md. NEVER derive anything from a filename YEAR:
 * they lie (Young Natalians' "AGM 2025.docx" holds 24 Jun 2026 minutes; Howick's
 * "AGM 2023.odt" holds 12 Jun 2024 minutes).
 */
import { clubIdFromName } from './club-id.js';
import { OVERARCHING_DISTRICT } from './catalogue.js';

// ───────────────────────── Club roster ─────────────────────────

export interface ClubMapEntry {
  /** Exact sub-folder name under the pack root. */
  folder: string;
  /** Canonical display name written to Club.name (from the club's own documents). */
  name: string;
  /** Derived via clubIdFromName(name) — never hand-typed, so it can never drift. */
  id: string;
  /**
   * Chairperson NAME only, written to Club.chair on CREATE (the merge path never touches
   * it). Taken from the club's own documents; some sources are 2024-era, so the union
   * should confirm at onboarding. Phone numbers and emails in those documents are
   * deliberately NOT imported (PII, and they would drive notification side effects).
   */
  chair: string;
}

function club(folder: string, name: string, chair: string): ClubMapEntry {
  return { folder, name, id: clubIdFromName(name), chair };
}

/** The 8 KZN Inland clubs. All sit in "uMgungundlovu Cricket District" (the CLI's DISTRICT). */
export const CLUB_MAP: ClubMapEntry[] = [
  // Union account YOUNGCC. Chair: 2026/27 affiliation form, signed 24 Jun 2026.
  club('Young Natalians CC Club', 'Young Natalians Cricket Club', 'Faiyaz Patel'),
  // Chair: elected at the AGM of 12 Jun 2024 (minutes filed as "Howick AGM 2023.odt").
  club('Howick CC Club', 'Howick Cricket Club', 'Ashley Sokaloo'),
  // Est. 1886, plays at Collegians. Chair: AGM minutes 2023/2024.
  club('Standard CC Club', 'Standard Cricket Club', 'Robbie Coutts'),
  // Imbali Hub. No constitution and no logo in the pack — both stay outstanding.
  // Chair: AGM minutes 14 Jul 2023 and the union's letters.
  club('Masibemunye CC Club', 'Masibemunye Cricket Club', 'Mondli Ndlovu'),
  // Its District Teams form declares "Have a Club Constitution: NO". Chair: AGM minutes
  // 2023 + 2024 (he is also the subject of the 2026 DC eligibility inquiry — still the
  // chair per the documents).
  club('Greytown CC Club', 'Greytown Cricket Club', 'Sadaf Zaman'),
  // The union invoices this club as "Varsity CC" (INU000150) — same club. Chair: AGM of
  // 27 Mar 2026 (the current exco).
  club('UKZN CC Club', 'UKZN Cricket Club', 'Dale Nadasan'),
  // Est. 1884; the folder says "MCC", every club document says Maritzburg Cricket Club.
  // MCC's head is its "president": AGM minutes 05 Jul 2024.
  club('MCC Club', 'Maritzburg Cricket Club', 'Barry Moig'),
  // NPO constitution; sponsored style "Hollywoodbets Lancashire CC". Chair: 2024/25
  // District Teams affiliation form.
  club('Lancashire CC Club', 'Lancashire Cricket Club', 'Mike Buckley'),
];

const clubIdOf = (folder: string): string => {
  const hit = CLUB_MAP.find((c) => c.folder === folder);
  if (!hit) throw new Error(`tuskers-import-map: no CLUB_MAP entry for folder "${folder}"`);
  return hit.id;
};

// ───────────────────────── Filename classifier ─────────────────────────

/** Ordered [regex, docKey] pairs — first match wins. Case-insensitive throughout. */
export const DOC_RULES: Array<[RegExp, string]> = [
  // Standard's CSA "Generic Team Return Form" is a player list too.
  [/nominal\s*roll|team\s*return/i, 'nominalRoll'],
  // The KZNICU "District Teams" registration workbook. The two union-side "Inland Club &
  // District Verification" checklists also match here and are overridden below.
  [/affiliation\s*form|district\s*teams|verification/i, 'affiliationForm'],
  // Invoices ("Affiliation Fees 2023.2024 - INU…"), statements, proofs of payment.
  [/affiliation\s*fee|statement|proof.?of.?payment|payment/i, 'affiliationFees'],
  // "consti" (not "constitution") covers Lancashire's "Signed NPO Consti LCC.pdf".
  [/consti/i, 'constitution'],
  [/agm|annual\s*general|minute/i, 'agmMinutes'],
  [/financ|treasurer|income|balance\s*sheet/i, 'financials'],
  [/logo/i, 'clubLogo'],
  [/clearance|registration|\breg\b/i, 'playerRegistrations'],
  // "umpire" (no boundary) also catches "umpires report".
  [/\bdc\b|disciplinar|incident|umpire|arbitration|unregistered/i, 'disciplinaryRecords'],
  [/\bsla\b/i, 'facilityAgreement'],
  [/funding|funds|transport\s*claim|coaching\s*staff|trial|training/i, 'clubRecords'],
  // The 2024 "Cricket Services Manager" letters (Clause 18.1 premier-league requirements,
  // unregistered-player sanctions under the old template) are all named "KZN Inland
  // Letter …" and are union correspondence, not DC paperwork.
  [/kzn\s*inland\s*letter|inland\s*letter|thank\s*you|kzn\s*cricket/i, 'unionCorrespondence'],
];

/**
 * A FILE_OVERRIDES value: `'skip'` (known, deliberately not imported — never counts as
 * unclassified), a docKey (force classification to that key, in the folder's own club),
 * or `{ club, docKey }` — a REASSIGNMENT for a file the union filed in the wrong club's
 * folder. `club` is a CLUB_MAP id.
 */
export type FileOverride = 'skip' | string | { club: string; docKey: string };

/**
 * Exact relative-path (folder/filename, forward slashes) overrides for files the regex
 * classifier can't place correctly on its own. Every entry carries a one-line reason
 * (the Titans convention); every decision here was made from the file's CONTENT.
 */
export const FILE_OVERRIDES: Record<string, FileOverride> = {
  // ── Skips: not a compliance document for this club ──
  // A downloaded desktop wallpaper, not a document.
  'MCC Club/virat-kohli-4k-ap-1920x1080.jpg': 'skip',
  // The VENUE's logo (Lynwood), not MCC's — MCC's own is "MCC logo.jpg".
  'MCC Club/Lynwood Club.jpg': 'skip',
  // Misnamed: a KZNICU letter confirming a cricket roller was returned to Carter High
  // School. Concerns no club in this pack.
  'Standard CC Club/Appeals Letter Standard CC.docx': 'skip',
  // Despite the name, a BLANK "club cricket meeting" sign-in register template. The .pdf
  // of the same stem is the real DC summons and imports normally.
  'Greytown CC Club/Greytown CC DC Inquiry 2026.docx': 'skip',

  // ── Skips: the .docx half of a docx+pdf pair of the SAME letter (pdf is canonical —
  // the signed/rendered form). Each pair was text-compared (textutil vs pdftotext); the
  // only differences are bullet glyphs ("•" vs "1."), nothing substantive. ──
  // ≙ "Howick CC DC Letter.pdf" (29 Feb 2024 notice). "…DC Letter 2024.pdf" is a
  // different, re-scheduled 04 Apr 2024 notice and imports too.
  'Howick CC Club/Howick CC DC Letter.docx': 'skip',
  'Howick CC Club/Howick CC Unregistered Players.docx': 'skip',
  // ≙ "Howick CC Letter 2025.pdf" (24 Nov 2025 unregistered-player letter).
  'Howick CC Club/Howick letter 24 nov 2025.docx': 'skip',
  // ≙ "KZN Inland Letter Standard CC 14 March 2024.pdf".
  'Standard CC Club/KZN Inland Letter Standard 14 March 2024.docx': 'skip',
  // ≙ "Standard CC Franchise Final Letter 2024.pdf" (identical text; name differs).
  'Standard CC Club/Standard CC Regional Final Letter 2024.docx': 'skip',
  // 19 Feb 2024 hearing notice (hearing Mon 26 Feb) ≙ "Standard DC letter Chad Potgieter
  // 24.pdf". NOT the same as "Standard DC Letter Chad Potgieter.docx" (a 28 Feb outcome
  // letter — kept, see below).
  'Standard CC Club/Standard DC letter Chad Potgieter 2024.docx': 'skip',
  // 21 Feb 2024 re-notice ≙ "Standard DC letter ChadPotgieter 2024.pdf".
  'Standard CC Club/Standard DC letter ChadPotgieter 2024.docx': 'skip',
  // ≙ "Affiliation Letter Masibemunye CC 2025.pdf".
  'Masibemunye CC Club/Affiliation Letter Masibemunye CC.docx': 'skip',
  'Masibemunye CC Club/KZN Inland Letter Masi 07 March 2024.docx': 'skip',
  'Masibemunye CC Club/Masibemunye Cricket Club Revised Funding.docx': 'skip',
  // 16 Feb 2024 hearing notice ≙ "UKZN DC letter Ashok Bharath.pdf".
  'UKZN CC Club/UKZN DC letter Ashok Bharath.docx': 'skip',
  // 28 Feb 2024 outcome draft; "UKZN DC Letter Ashok 2024.pdf" (29 Feb) is the fuller
  // final with the SAME sanction (5 matches, all suspended 12 months), only reworded.
  'UKZN CC Club/UKZN DC Letter Ashok.docx': 'skip',
  // ≙ "UKZN Letter 02 Dec 2025.pdf".
  'UKZN CC Club/UKZN Letter 02 Dec 25.docx': 'skip',
  // ≙ "UKZN DC Letter 25.pdf" (08 Dec 2025 unregistered-player letter).
  'UKZN CC Club/UKZN DC Letter 2025.docx': 'skip',
  // Text-identical to "UKZN DC Letter 25.pdf" (a second PDF render of the same 08 Dec
  // 2025 letter — different bytes, so dedupeGroup can't collapse it).
  'UKZN CC Club/UKZN Letter 07 Dec 25.pdf': 'skip',
  'UKZN CC Club/UKZN Thank You letter.docx': 'skip',
  'MCC Club/KZN Inland Letter MCC 15 Feb 2024.docx': 'skip',
  'MCC Club/KZN Inland Letter MCC 06 March 2024.docx': 'skip',
  'Greytown CC Club/KZN Inland Letter Greytown 26 Feb 2024.docx': 'skip',
  // NOT skipped, despite having same-stem pdf siblings — their content differs
  // materially (verified): "Standard DC Letter Chad Potgieter.docx" is a 28 Feb 2024
  // outcome (1 match + 5 suspended for 12 months) whose sanction differs from the 29 Feb
  // "…Chad Potgieter 2024.pdf" final (1 match; a 1-match ban on reoffence); "MCC DC Letter
  // Shaun Truter.docx" is a 28 Feb 2024 outcome (3 matches suspended) vs the 29 Feb
  // "MCC DC Letter Shaun  2024.pdf" final (5 matches) and the 16 Feb ".pdf" notice. Both
  // classify as disciplinaryRecords via DOC_RULES.

  // ── Reassignments: filed in the wrong club's folder ──
  // Asanda Khumalo's KZNICU registration form — a Masibemunye player.
  'MCC Club/asanda.jpg': {
    club: clubIdOf('Masibemunye CC Club'),
    docKey: 'playerRegistrations',
  },
  // Addressed to Lancashire's chairman (Michael Patricks Oval usage 2024-25).
  'Standard CC Club/KZN Inland Letter Lancashire Ground Booking 26 March 2024.pdf': {
    club: clubIdOf('Lancashire CC Club'),
    docKey: 'unionCorrespondence',
  },

  // ── Forced docKeys: the regexes miss or mis-place these ──
  // Scanned KZNICU registration form; filename carries no keyword.
  'MCC Club/D Fynn.pdf': 'playerRegistrations',
  // Photo of a filled registration/clearance form (full RSA ID — PII). Note the trailing
  // space in the filename.
  'UKZN CC Club/Cian Fortman .jpg': 'playerRegistrations',
  // Scanned registration form. `\breg\b` catches it too; pinned explicitly.
  'MCC Club/Michael king Reg.pdf': 'playerRegistrations',
  // Headed "SERVICE LEVEL AGREEMENT": Peter Booysen Ovals use confirmation.
  'UKZN CC Club/LETTER TO YOGESH J - 11 JAN 2024.pdf': 'facilityAgreement',
  // Byte-identical to "SLA Doc MCC.pdf" (dedupe collapses them); "MCC SLA.pdf" is a
  // DIFFERENT letter (Lynwood vs Linpark) and classifies via the \bsla\b rule.
  'MCC Club/MCC letter 2024.pdf': 'facilityAgreement',
  'MCC Club/SLA Doc MCC.pdf': 'facilityAgreement',
  // A facility-use code for Howick High School's ground, not a member code of conduct.
  'Howick CC Club/Howick Cricket Club Code of Conduct.pdf': 'facilityAgreement',
  // Howick/Masibemunye arbitration outcome; the union filed it under Howick. The
  // arbitration rule catches it before "kzn cricket" would; pinned explicitly.
  'Howick CC Club/KZN CRICKET - ARBITRATION - REPORT.pdf': 'disciplinaryRecords',
  // Scanned women's trial notice; the "trial" rule catches it too, pinned explicitly.
  'Standard CC Club/Standard Womens Trial.pdf': 'clubRecords',
  // Scanner-default name, image-only, content unidentifiable — ask the club (runbook).
  'Masibemunye CC Club/SKM_C30824080810300.pdf': 'clubRecords',
  // Safeguarding-training progress screenshot.
  'MCC Club/Screenshot 2024-04-08 083019 - Kurt Mannikam.png': 'clubRecords',
  // Photo of a handwritten umpire report; the umpire rule catches it, pinned explicitly.
  'Standard CC Club/umpires report Standard vs Masi 2024.jpg': 'disciplinaryRecords',
  // Union-side multi-club verification checklists — not the club's affiliation form.
  'MCC Club/MCC Inland Club & District Verification - 2023.2024 Season.xlsx': 'unionCorrespondence',
  'Lancashire CC Club/LCC Copy of Inland Club  District Verification - 2023.2024 Season.xlsx':
    'unionCorrespondence',
  // The union's 08 May 2025 affiliation CONFIRMATION letter — not a fee or the form.
  'Masibemunye CC Club/Affiliation Letter Masibemunye CC 2025.pdf': 'unionCorrespondence',
  // "…AGM 2024" in the name would hit the agm rule first; it's the treasurer's report.
  'Lancashire CC Club/Final treasurers report AGM 2024.pdf': 'financials',
  // "Income Statement" would hit the statement (fees) rule first; it's the financials.
  'Standard CC Club/Standard Balance Sheet  Income Statement - Feb 2023.pdf': 'financials',
  // Union→club bank payment audit reports (image-only): R20,000 prize money (Apr 2025)
  // and a R5,250 grant (Sep 2025). Funding records, not affiliation-fee payments.
  'Standard CC Club/POP - Standard CC - Prize Money.pdf': 'clubRecords',
  'Standard CC Club/POP - Standard CC Grant.pdf': 'clubRecords',
  // Clause 18.6 disqualification from the 2024 Franchise Final — a union sanction letter.
  'Standard CC Club/Standard CC Franchise Final Letter 2024.pdf': 'unionCorrespondence',
  // Unregistered-player letters (Clubs Coordinator template, 2025) with no keyword in the
  // name — same template as "Howick CC Unregistered Players.pdf" / "UKZN DC Letter
  // 25.pdf", which DOC_RULES files as disciplinaryRecords; kept together with them.
  'Howick CC Club/Howick CC Letter 2025.pdf': 'disciplinaryRecords',
  'UKZN CC Club/UKZN Letter 02 Dec 2025.pdf': 'disciplinaryRecords',
};

/**
 * Doc keys that store MORE THAN ONE file (docMeta[key] = { files: [...] }), mirrored from
 * the tenant's catalogue (the `tuskers` entry in configure-tenant-docs.ts). Asserted in
 * both directions against the live catalogue at dry-run.
 */
export const MULTI_FILE_DOC_KEYS = new Set([
  'agmMinutes',
  'financials',
  'affiliationForm',
  'affiliationFees',
  'nominalRoll',
  'facilityAgreement',
  'disciplinaryRecords',
  'unionCorrespondence',
  'playerRegistrations',
  'clubRecords',
]);

/** Every doc key this import ever writes — must be covered by the tenant's configured
 * catalogue (asserted at dry-run against resolveRequiredDocs(config)). */
export const TUSKERS_DOC_KEYS = [
  'constitution',
  'agmMinutes',
  'financials',
  'affiliationForm',
  'affiliationFees',
  'nominalRoll',
  'clubLogo',
  'facilityAgreement',
  'disciplinaryRecords',
  'unionCorrespondence',
  'playerRegistrations',
  'clubRecords',
];

export type ClassifyResult =
  /** `club` is set only when a FILE_OVERRIDES reassignment moves the file to a club
   * other than its folder's. */
  | { kind: 'doc'; docKey: string; club?: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'unclassified' };

/** Classify one compliance-pack file by its folder/filename relative path. */
export function classifyFile(relPath: string, filename: string): ClassifyResult {
  const override = FILE_OVERRIDES[relPath];
  if (override === 'skip') return { kind: 'skip', reason: 'FILE_OVERRIDES: explicit skip' };
  if (typeof override === 'object')
    return { kind: 'doc', docKey: override.docKey, club: override.club };
  if (override) return { kind: 'doc', docKey: override };
  for (const [re, docKey] of DOC_RULES) {
    if (re.test(filename)) return { kind: 'doc', docKey };
  }
  return { kind: 'unclassified' };
}

// ───────────────────────── Phase 2: roster import ─────────────────────────
//
// Consumed by import-tuskers-roster.ts via tuskers-roster-parse.ts. Every source, sheet,
// header row and league mapping below was checked against the real workbooks (plans/
// tuskers-compliance-import-plan.md, "Phase 2"). No cell VALUE is reproduced here — the
// rolls carry full RSA ID numbers, including minors'.

/**
 * What one header cell feeds. `identityOrDob` is Lancashire's CSA-export `BirthDate`
 * column, which despite its name holds IDENTITY values — 13-digit RSA IDs, a few 8-digit
 * yyyymmdd dates, Zimbabwean national IDs, or blanks (see resolveIdentityCell).
 */
export type TuskersRosterField =
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'idNumber'
  | 'dob'
  | 'identityOrDob'
  | 'gender'
  | 'race'
  | 'status';

export interface RosterSheetSpec {
  /** Exact worksheet name. */
  name: string;
  /** player.team for every row written from this sheet. `null` = import with NO team
   * (Lancashire's 3rds/4ths — team ordinals, not leagues; reported for the union). */
  leagueKey: string | null;
  /** 1-based sheet row holding the header. */
  headerRow: number;
  /** The EXACT header cells from column A, trailing blanks trimmed. Asserted against the
   * real row before anything is parsed — any drift aborts the run. */
  header: readonly string[];
  /** Header text → field. Header cells not listed here are asserted but ignored. */
  colMap: Readonly<Record<string, TuskersRosterField>>;
}

export interface RosterSource {
  clubId: string;
  /** Exact relative path under the pack root. */
  file: string;
  /** In priority order: the first appearance of a person wins the intra-club dedupe, so
   * sheets run senior-competition-first. */
  sheets: RosterSheetSpec[];
  /** Worksheets deliberately not parsed. Every worksheet in the file must be listed in
   * `sheets` or here — an unexpected sheet is drift and aborts the run. */
  ignoredSheets?: Array<{ name: string; reason: string }>;
}

// The union "Team Nominal Rolls" template: header on row 3, offset one column (col A is
// a blank/row-number column).
const UNION_HEADER = [
  '',
  'Name:',
  'Surname:',
  'Race:',
  'Gender:',
  'Age:',
  'ID Number:',
  'DOB:',
  'Contact Number:',
  'Address:',
  'Batting Style:',
  'Bowling Style:',
] as const;
const UNION_COLMAP = {
  'Name:': 'firstName',
  'Surname:': 'lastName',
  'Race:': 'race',
  'Gender:': 'gender',
  'ID Number:': 'idNumber',
  'DOB:': 'dob',
} as const;
// Howick fills its DOB column with free-text d-m-yyyy strings. cellDobIso reads a
// slash/dash date string month-first, so mapping it would silently swap day and month —
// it is deliberately NOT mapped; Howick identity comes from its ID column only.
const HOWICK_COLMAP = {
  'Name:': 'firstName',
  'Surname:': 'lastName',
  'Race:': 'race',
  'Gender:': 'gender',
  'ID Number:': 'idNumber',
} as const;

const unionSheet = (
  name: string,
  leagueKey: string | null,
  colMap: Readonly<Record<string, TuskersRosterField>> = UNION_COLMAP,
): RosterSheetSpec => ({ name, leagueKey, headerRow: 3, header: UNION_HEADER, colMap });

// Lancashire's CSA player-management export: header on row 1.
const CSA_EXPORT_HEADER = [
  'Name',
  'Surname',
  'PlayerType',
  'BattingHand',
  'BowlingHand',
  'BowlingAction',
  'Gender',
  'Race',
  'Team',
  'BirthDate',
  'Status',
] as const;
const CSA_EXPORT_JUNIOR_HEADER = [
  ...CSA_EXPORT_HEADER,
  'ServerPlayerID',
  'Organisation',
  'Region',
] as const;
const CSA_EXPORT_COLMAP = {
  Name: 'firstName',
  Surname: 'lastName',
  Gender: 'gender',
  Race: 'race',
  BirthDate: 'identityOrDob',
  Status: 'status',
} as const;
const lccSheet = (name: string, leagueKey: string | null, junior = false): RosterSheetSpec => ({
  name,
  leagueKey,
  headerRow: 1,
  header: junior ? CSA_EXPORT_JUNIOR_HEADER : CSA_EXPORT_HEADER,
  colMap: CSA_EXPORT_COLMAP,
});

/**
 * The per-club roster sources (plan: "Importable vs skipped"). Order matters twice: across
 * sources within a club (Standard's CSA team return first, so its fresher identities win
 * the dedupe) and across sheets within a source (senior competition first).
 */
export const ROSTER_SOURCES: RosterSource[] = [
  {
    clubId: clubIdOf('MCC Club'),
    file: 'MCC Club/Maritzburg CC Nominal Roll.xlsx',
    sheets: [
      // PREM's header spells the ID column "IDNumber:"; ~11 trailing name-only rows
      // exception out. Known ID mangling (leading-zero-lost 12-digit cells, an
      // apostrophe-quoted text cell, space-grouped digits, a zero-padded value) is left to
      // cleanIdCell + Luhn — never hand-fixed.
      {
        name: 'PREM',
        leagueKey: 'premier-league',
        headerRow: 3,
        header: UNION_HEADER.map((h) => (h === 'ID Number:' ? 'IDNumber:' : h)),
        colMap: {
          'Name:': 'firstName',
          'Surname:': 'lastName',
          'Race:': 'race',
          'Gender:': 'gender',
          'IDNumber:': 'idNumber',
          'DOB:': 'dob',
        },
      },
      unionSheet('UMG DIV 1', 'div-1'), // header-only
      unionSheet('UMG DIV 2', 'div-2'),
      unionSheet('UMG DIV 3', 'div-3'),
      unionSheet('VETERANS', 'veterans-league'),
      // Juniors carry a DOB but no ID → dob-only, written only under --allow-missing-id.
      unionSheet('U9', 'u9'),
      unionSheet('U11', 'u11'),
      unionSheet('U13', 'u13'),
      unionSheet('U15', 'u15'),
      // A reduced name-only header variant: every row exceptions out (parsed + reported).
      {
        name: 'WOMEN',
        leagueKey: 'women-s-premier-league',
        headerRow: 3,
        header: ['No:', 'Name:', 'Surname:', 'Race:', 'Gender:'],
        colMap: {
          'Name:': 'firstName',
          'Surname:': 'lastName',
          'Race:': 'race',
          'Gender:': 'gender',
        },
      },
    ],
  },
  {
    clubId: clubIdOf('Lancashire CC Club'),
    file: 'Lancashire CC Club/Lancashire CC Nominal Roll.xlsx',
    sheets: [
      lccSheet('Premier League 2023', 'premier-league'),
      lccSheet('Vets', 'veterans-league'),
      lccSheet('U16', 'u16'), // U16 uses the 11-column senior export header
      lccSheet('U15', 'u15', true),
      lccSheet('U13', 'u13', true),
      lccSheet('U11', 'u11', true),
      lccSheet('U9', 'u9', true),
      // 3rds/4ths are TEAM ORDINALS, not league names — imported with no team rather than
      // guessing a division (runbook: the union confirms where they play). Placed after
      // every league-mapped sheet so a person also on a mapped sheet keeps that league.
      lccSheet('3rds', null),
      lccSheet('4ths', null),
      // Reduced no-ID header on row 2 — every row exceptions out (parsed + reported).
      {
        name: 'Women',
        leagueKey: 'women-s-premier-league',
        headerRow: 2,
        header: ['No', 'Name', 'Surname', 'Gender', 'RACE', 'TEAM'],
        colMap: { Name: 'firstName', Surname: 'lastName', Gender: 'gender', RACE: 'race' },
      },
    ],
    ignoredSheets: [{ name: 'Sheet3', reason: 'empty worksheet' }],
  },
  {
    clubId: clubIdOf('Standard CC Club'),
    // FIRST: the 2025/26 CSA team return — 19 fully-identified premier players, the
    // freshest identities in the pack, so they win the intra-club dedupe.
    file: 'Standard CC Club/Standard CSA Generic Team Return Form 2025_26-1.xlsx',
    sheets: [
      {
        name: '202526',
        leagueKey: 'premier-league',
        headerRow: 10,
        header: [
          '',
          'ID No.',
          'First Name',
          'Surname',
          'Bat Hand',
          'Bat Skill',
          'Bowl Hand',
          'Bowl Skill',
          'D.O.B.',
          'School or Hub/ RPC',
          'Race',
          'Gender',
        ],
        // D.O.B. is dd-mm-yyyy TEXT (cellDobIso would read it month-first) and every row
        // carries an ID, so it is deliberately not mapped — dob comes from the ID.
        colMap: {
          'ID No.': 'idNumber',
          'First Name': 'firstName',
          Surname: 'lastName',
          Race: 'race',
          Gender: 'gender',
        },
      },
    ],
  },
  {
    clubId: clubIdOf('Standard CC Club'),
    file: 'Standard CC Club/Standard CC Nominal Roll.xlsx',
    sheets: [
      unionSheet('PREM', 'premier-league'),
      unionSheet('UMG DIV 1', 'div-1'),
      unionSheet('UMG DIV 2', 'div-2'), // one known intra-sheet duplicate — deduped
      unionSheet('UMG DIV 3', 'div-3'), // header-only
      unionSheet('VETERANS', 'veterans-league'),
      unionSheet('U9', 'u9'),
      unionSheet('U11', 'u11'),
      unionSheet('U13', 'u13'), // header-only
      unionSheet('U15', 'u15'),
      // Single "Player Name:" column (split at the last space); ID/DOB columns are blank,
      // so every row exceptions out.
      {
        name: 'WOMEN',
        leagueKey: 'women-s-premier-league',
        headerRow: 3,
        header: [
          'No:',
          'Player Name:',
          'Race:',
          'Gender:',
          'Team Name:',
          'Age:',
          'ID Number:',
          'DOB:',
          'Contact Number:',
          'Address:',
          'Batting Style:',
          'Bowling Style:',
        ],
        colMap: {
          'Player Name:': 'fullName',
          'Race:': 'race',
          'Gender:': 'gender',
          'ID Number:': 'idNumber',
          'DOB:': 'dob',
        },
      },
    ],
  },
  {
    clubId: clubIdOf('Howick CC Club'),
    file: 'Howick CC Club/Howick CC Nominal Roll.xlsx',
    // Only UMG DIV 1/2/3 carry IDs, and they are ~the same 14 players repeated across all
    // three — intra-club dedupe is what makes this importable. Several 14-digit
    // leading-zero-corrupted IDs exception out as bad-id on DIV 1/3; the same players
    // carry valid IDs on DIV 2. Everything else is name-only → exceptions.
    sheets: [
      unionSheet('PREM', 'premier-league', HOWICK_COLMAP),
      unionSheet('UMG DIV 1', 'div-1', HOWICK_COLMAP),
      unionSheet('UMG DIV 2', 'div-2', HOWICK_COLMAP),
      unionSheet('UMG DIV 3', 'div-3', HOWICK_COLMAP),
      unionSheet('VETERANS', 'veterans-league', HOWICK_COLMAP),
      unionSheet('U9', 'u9', HOWICK_COLMAP),
      unionSheet('U11', 'u11', HOWICK_COLMAP),
      unionSheet('U13', 'u13', HOWICK_COLMAP),
      unionSheet('U15', 'u15', HOWICK_COLMAP),
      unionSheet('WOMEN', 'women-s-premier-league', HOWICK_COLMAP),
    ],
  },
];

/**
 * nominalRoll files of IMPORTABLE clubs that are deliberately NOT roster sources. Every
 * nominalRoll-classified file of a non-SKIP_ROSTER club must be a ROSTER_SOURCES file or
 * listed here — the CLI fails closed otherwise.
 */
export const ROSTER_NON_SOURCES: Array<{ file: string; reason: string }> = [
  {
    file: 'MCC Club/MCC Nominal Roll (9).xlsx',
    reason:
      'an alternate copy of "Maritzburg CC Nominal Roll.xlsx" (same sheets, overlapping ' +
      'players, more mangled ID cells) — that roll is the single MCC source',
  },
  ...[
    'MCC Club/MCC Nominal Rolls 2024.xlsx',
    'Howick CC Club/Howick CC Nominal Rolls 2024.xlsx',
    'Lancashire CC Club/Lancashire CC Nominal Rolls 2024.xlsx',
    'Standard CC Club/Standard CC Nominal Rolls 2024.xlsx',
  ].map((file) => ({
    file,
    reason:
      'sparse 2024 union template: only the Premier League sheet is filled, with name/' +
      'gender/race/team only — no ID or DOB column; the other sheets are blank',
  })),
];

/**
 * Clubs whose rolls carry no ID and no DOB column at all (name + gender + race only).
 * `PlayerRegistration.dob` is required and playerNaturalKey needs an ID or name+DOB, so
 * no player is buildable — their compliance DOCUMENTS import normally; report them to the
 * union for proper roster exports. Documented, reported, never silent.
 */
export const SKIP_ROSTER: Array<{ clubId: string; reason: string }> = [
  'Young Natalians CC Club',
  'Masibemunye CC Club',
  'Greytown CC Club',
  'UKZN CC Club',
].map((folder) => ({
  clubId: clubIdOf(folder),
  reason:
    'nominal rolls carry no ID-number and no DOB column (name/gender/race only) — no ' +
    'player identity is buildable; ask the union for a roster export with ID numbers',
}));

/**
 * Every league key a roster sheet may map to, in the LIVE `tuskers` tenant's shape
 * (`{ key, label, group, district }`). The tenant pre-exists (operator-created on dev)
 * with premier-league, promotion-league, women-s-premier-league, women-s-promotion-league,
 * veterans-league, u11, u13 and u15 — the entries for those keys use its keys exactly, so
 * nothing is ever duplicated (planLeagueAdditions only appends keys the tenant LACKS, so
 * their label/group/district here are never written). The keys the tenant lacks, appended
 * by `--confirm --add-missing-leagues` only when an eligible row references them:
 *
 * - div-1/2/3: uMgungundlovu's own district divisions. `district` is the tenant's district
 *   NAME — which differs per stage (dev "uMgungundlovu Cricket District", prod
 *   "uMgungundlovu District"), so the entries carry UMG_DISTRICT_PLACEHOLDER and the CLI
 *   substitutes the resolved name via materializeTuskersLeagues before appending. Not the
 *   'All districts' sentinel — leagueOptionsForDistrict (packages/engine/src/leagues.ts)
 *   offers a district-scoped league only to that district's clubs, and the tenant PUT
 *   validator accepts a configured district name. `group` stays "Overarching Leagues" like
 *   every live entry (group is a display grouping only; the one group with behaviour is
 *   'Juniors', which none of the live leagues use).
 * - u9: shaped like the live u11/u13/u15.
 * - u16: same shape; appended only if a written row lands in it (today every valid U16
 *   player also appears on Lancashire's Premier sheet, which wins), so it never dangles.
 *
 * The Women sheets map to the operator's `women-s-premier-league` (never a parallel key);
 * today every Women row is an identity exception, so nothing is written there yet.
 */
const OVERARCHING_GROUP = 'Overarching Leagues';
const ALL_DISTRICTS = OVERARCHING_DISTRICT;
/** Stands in for the tenant's resolved uMgungundlovu district name (resolveTuskersDistrict)
 * on district-scoped entries — never written as-is (materializeTuskersLeagues replaces it,
 * and the CLI refuses to append an unresolved placeholder). */
export const UMG_DISTRICT_PLACEHOLDER = '<uMgungundlovu district>';
const UMG_DISTRICT = UMG_DISTRICT_PLACEHOLDER;
export const TUSKERS_LEAGUES: Array<{
  key: string;
  label: string;
  group: string;
  district: string;
}> = [
  // ── Already on the tenant (never appended) ──
  {
    key: 'premier-league',
    label: 'Premier League',
    group: OVERARCHING_GROUP,
    district: ALL_DISTRICTS,
  },
  {
    key: 'women-s-premier-league',
    label: "Women's Premier League",
    group: OVERARCHING_GROUP,
    district: ALL_DISTRICTS,
  },
  {
    key: 'veterans-league',
    label: 'Veterans League',
    group: OVERARCHING_GROUP,
    district: ALL_DISTRICTS,
  },
  { key: 'u11', label: 'U11', group: OVERARCHING_GROUP, district: ALL_DISTRICTS },
  { key: 'u13', label: 'U13', group: OVERARCHING_GROUP, district: ALL_DISTRICTS },
  { key: 'u15', label: 'U15', group: OVERARCHING_GROUP, district: ALL_DISTRICTS },
  // ── Missing on the tenant (appended on demand) ──
  { key: 'div-1', label: 'UMG Division 1', group: OVERARCHING_GROUP, district: UMG_DISTRICT },
  { key: 'div-2', label: 'UMG Division 2', group: OVERARCHING_GROUP, district: UMG_DISTRICT },
  { key: 'div-3', label: 'UMG Division 3', group: OVERARCHING_GROUP, district: UMG_DISTRICT },
  { key: 'u9', label: 'U9', group: OVERARCHING_GROUP, district: ALL_DISTRICTS },
  { key: 'u16', label: 'U16', group: OVERARCHING_GROUP, district: ALL_DISTRICTS },
];

// ───────────────────────── --map-club (pre-existing tenant clubs) ─────────────────────────

/**
 * Parse repeatable `--map-club <clubMapId>=<existingId>` values into a CLUB_MAP id →
 * existing-tenant-club id map. Remaps a CLUB_MAP club onto a club that already exists on
 * the tenant under a different id (prod: Lancashire self-signed-up as
 * `lancashire-cricket-club-pmb`), so the import merges into it instead of creating a
 * duplicate. Pure, fail-closed validation: the left side must be a CLUB_MAP id (once),
 * and the right side must not be another CLUB_MAP club's id (that would merge two clubs)
 * or the left side itself. Whether the right side EXISTS is a run-time check the CLIs
 * make against the tenant (see mapTargetsMissing).
 */
export function parseMapClubArgs(
  values: string[],
  clubMapIds: string[] = CLUB_MAP.map((c) => c.id),
): Map<string, string> {
  const known = new Set(clubMapIds);
  const map = new Map<string, string>();
  for (const v of values) {
    const m = /^([^=\s]+)=([^=\s]+)$/.exec(v);
    if (!m) throw new Error(`--map-club expects <clubMapId>=<existingId>, got "${v}"`);
    const [, from, to] = m;
    if (!known.has(from)) throw new Error(`--map-club: "${from}" is not a CLUB_MAP club id`);
    if (map.has(from)) throw new Error(`--map-club: "${from}" is mapped twice`);
    if (to === from) throw new Error(`--map-club: "${from}" is mapped onto itself`);
    if (known.has(to))
      throw new Error(
        `--map-club: target "${to}" is another CLUB_MAP club — refusing to merge two clubs`,
      );
    if ([...map.values()].includes(to))
      throw new Error(`--map-club: target "${to}" is the target of two mappings`);
    map.set(from, to);
  }
  return map;
}

/** The tenant club id a CLUB_MAP club is written to/read from. */
export function effectiveClubId(clubMapId: string, mapping: Map<string, string>): string {
  return mapping.get(clubMapId) ?? clubMapId;
}

/** Mapping targets that don't exist on the tenant — each one aborts the run. */
export function mapTargetsMissing(
  mapping: Map<string, string>,
  existingClubIds: Set<string>,
): string[] {
  return [...mapping.entries()]
    .filter(([, to]) => !existingClubIds.has(to))
    .map(([from, to]) => `--map-club ${from}=${to}: club "${to}" does not exist on the tenant`);
}

/**
 * Create-vs-merge for one CLUB_MAP club. A MAPPED club is never created: its target must
 * already exist (abort otherwise); an unmapped club is created when absent, else merged.
 */
export function clubWriteDecision(
  clubMapId: string,
  mapping: Map<string, string>,
  existingClubIds: Set<string>,
): { action: 'create' | 'merge'; clubId: string } | { action: 'abort'; reason: string } {
  const clubId = effectiveClubId(clubMapId, mapping);
  if (mapping.has(clubMapId)) {
    return existingClubIds.has(clubId)
      ? { action: 'merge', clubId }
      : {
          action: 'abort',
          reason: `${clubMapId} is mapped onto "${clubId}", which does not exist on the tenant — a mapped club is never created`,
        };
  }
  return { action: existingClubIds.has(clubId) ? 'merge' : 'create', clubId };
}

// ───────────────────────── District resolution ─────────────────────────

/**
 * The tenant's configured district these clubs sit in. Never hardcoded — the district
 * NAME differs per stage (dev: "uMgungundlovu Cricket District", prod: "uMgungundlovu
 * District"), and club.district must equal a configured name exactly for admin filters
 * and insights. Exactly one configured name may match /mgungundlovu/i; zero or several is
 * fail-closed, with the configured list in the message.
 */
export function resolveTuskersDistrict(
  configuredDistricts: string[],
): { kind: 'ok'; district: string } | { kind: 'error'; message: string } {
  const hits = configuredDistricts.filter((d) => /mgungundlovu/i.test(d));
  if (hits.length === 1) return { kind: 'ok', district: hits[0] };
  return {
    kind: 'error',
    message:
      `expected exactly one configured district matching /mgungundlovu/i, found ${hits.length} ` +
      `— configured: ${configuredDistricts.map((d) => JSON.stringify(d)).join(', ') || '(none)'}`,
  };
}

/** TUSKERS_LEAGUES with the district placeholder replaced by the tenant's resolved
 * uMgungundlovu district name — what the roster CLI actually appends. */
export function materializeTuskersLeagues(
  district: string,
  leagues: typeof TUSKERS_LEAGUES = TUSKERS_LEAGUES,
): typeof TUSKERS_LEAGUES {
  return leagues.map((l) =>
    l.district === UMG_DISTRICT_PLACEHOLDER ? { ...l, district } : { ...l },
  );
}
