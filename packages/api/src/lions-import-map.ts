/**
 * Lions (Central Gauteng Lions / CGL) onboarding — pure data + pure helpers, NO AWS imports.
 *
 * Section 1 (this phase): CLUB IDENTITY. `CLUB_MAP` is the full club universe for the lions
 * tenant — the union of every club named in (a) the CGL 2026/27 affiliation Google-Form
 * responses, (b) the 2026-27 fixtures workbook + the T20 PDFs, and (c) the compliance-pack
 * folder names. Every raw spelling seen in any of those sources is listed as an alias so
 * the affiliation, compliance and fixtures importers all resolve names through ONE table.
 *
 * Later sections: DOC_RULES / FILE_OVERRIDES for the compliance importer (Phase 3, at the
 * bottom of this file); ROSTER_SOURCES / SKIP_ROSTER for the roster importer (Phase 6) —
 * the same single-map-file layout as tuskers-import-map.ts.
 *
 * WHY A SEPARATE MAP FILE: every lions importer's `--parse-only` mode must run under plain
 * `npx tsx` (no `sst shell`, no AWS creds), and this table must be testable in isolation.
 *
 * Identity rules (user-approved 2 Oct 2026, see the CGL club-list sign-off artifact):
 * - Ambiguous identities stay SPLIT, never merged — a wrong split is mendable, a wrong merge
 *   is not once docs/memberships accumulate under one clubId.
 * - Name resolution is EXACT on a normalised alias (case/whitespace/invisible-char
 *   insensitive) — never fuzzy. An unknown name resolves to null (`resolveClubName`) or
 *   throws (`requireClubName`), so a new spelling fails closed instead of minting a ghost.
 * - Districts are canonical display names here; the CLI resolves them against the tenant's
 *   configured district list at run time (resolveLionsDistricts) — ids are never hardcoded.
 */
import { clubIdFromName } from './club-id.js';

// ───────────────────────── Club identity ─────────────────────────

/** The four CGL districts, as canonical display names (tenant config is matched at run time). */
export const LIONS_DISTRICTS = ['Johannesburg', 'Sedibeng', 'Mogale City', 'West Rand'] as const;
export type LionsDistrict = (typeof LIONS_DISTRICTS)[number];

/** Where a club's name was seen. `t20` = the Hollywoodbets Premier / Ladies Premier T20 PDFs. */
export type ClubSource = 'affiliation' | 'fixtures' | 't20' | 'compliance';

export interface ClubMapEntry {
  /** Derived via clubIdFromName(name) — never hand-typed, so it can never drift. */
  id: string;
  /** Canonical display name written to Club.name. */
  name: string;
  /** Canonical district (affiliation form where the club submitted one). */
  district: LionsDistrict;
  /** True when the club has no affiliation response and `district` is a best guess. */
  districtGuess: boolean;
  /** Exact compliance-pack folder name, or null when the club has no folder. */
  folder: string | null;
  /** Every source the club appears in (drives the sign-off table + parse cross-checks). */
  sources: ClubSource[];
  /** Every raw spelling from any source that must resolve to this club (incl. the
   *  affiliation form's CLUB NAME exactly as typed). The canonical name always resolves. */
  aliases: string[];
  /** Judgment calls for the CGL sign-off, one line each (empty for uncontroversial clubs). */
  flags: string[];
}

interface ClubSpec {
  name: string;
  district: LionsDistrict;
  districtGuess?: boolean;
  folder?: string;
  sources: ClubSource[];
  aliases?: string[];
  flags?: string[];
}

function club(spec: ClubSpec): ClubMapEntry {
  return {
    id: clubIdFromName(spec.name),
    name: spec.name,
    district: spec.district,
    districtGuess: spec.districtGuess ?? false,
    folder: spec.folder ?? null,
    sources: spec.sources,
    aliases: spec.aliases ?? [],
    flags: spec.flags ?? [],
  };
}

const JHB: LionsDistrict = 'Johannesburg';
const SED: LionsDistrict = 'Sedibeng';
const MOG: LionsDistrict = 'Mogale City';
const WR: LionsDistrict = 'West Rand';

/**
 * The full lions club universe (49 clubs, derived 2 Oct 2026 from the actual files):
 * 42 affiliated (43 responses, University of Johannesburg submitted twice), 3 fixtures-only,
 * 1 Ladies-T20-only, 3 compliance-only. Ordered by district then name for review.
 */
export const CLUB_MAP: ClubMapEntry[] = [
  // ── Affiliated: Johannesburg ──
  club({
    name: 'Alexandra Cricket Club',
    district: JHB,
    folder: 'Alexandra CC',
    sources: ['affiliation', 'fixtures', 'compliance'],
    aliases: ['Alexandra cricket club', 'Alexandra Cricket', 'Alexandra CC'],
  }),
  club({
    name: 'Alfeco Cricket Club',
    district: JHB,
    sources: ['affiliation', 'fixtures'],
    aliases: ['Alfeco CC'],
  }),
  club({
    name: 'Azad Swaraj Sporting Club',
    district: JHB,
    folder: 'Azad Swaraj',
    sources: ['affiliation', 'fixtures', 'compliance'],
    // The fixtures workbook misspells it "Sewraj".
    aliases: ['AZAD SWARAJ SPORTING CLUB', 'Azad Sewraj Sporting', 'Azad Swaraj'],
  }),
  club({
    name: 'Crosby Legends Cricket Club',
    district: JHB,
    sources: ['affiliation', 'fixtures'],
    aliases: ['Crosby legends', 'Crosby Legends'],
  }),
  club({
    name: 'Dalikay Cricket Club',
    district: JHB,
    folder: 'Dalikay CC',
    sources: ['affiliation', 'fixtures', 'compliance'],
    aliases: ['Dalikay cricket club', 'Dalikay', 'Dalikay CC'],
  }),
  club({
    name: 'Delfos Cricket Club',
    district: JHB,
    folder: 'Delfos Cricket Club',
    sources: ['affiliation', 'fixtures', 't20', 'compliance'],
    // "Delfos 1" / "Delfos 2" are Delfos's two Vets SA 1 TEAMS, not clubs — the fixtures
    // importer keeps them as two participants of this one club.
    aliases: ['Delfos', 'Delfos CC', 'Delfos 1', 'Delfos 2'],
    flags: ['"Delfos 1" and "Delfos 2" (Vets) are two Delfos teams, not separate clubs.'],
  }),
  club({
    name: 'Dobsonville Cricket Club',
    district: JHB,
    folder: 'Dobsonville Cricket Club',
    sources: ['affiliation', 'fixtures', 'compliance'],
    aliases: ['Dobsonville'],
  }),
  club({
    name: 'Durban Old Boys Cricket Club',
    district: JHB,
    folder: 'Durban Old Boys',
    sources: ['affiliation', 'compliance'],
    aliases: ['DURBAN OLD BOYS CC', 'Durban Old Boys', 'DOBCC'],
    flags: [
      'Affiliated (entered SA 5), but appears in no 2026-27 fixtures sheet (the Saturday 4/5 sheets are empty).',
    ],
  }),
  club({
    name: 'GM Old Edwardians Cricket Club',
    district: JHB,
    folder: 'GM Old Edwardians',
    sources: ['affiliation', 'fixtures', 't20', 'compliance'],
    aliases: ['GM Old Edwardians', 'G&M Old Edwardians', 'Old Eds CC', 'Old Eds'],
  }),
  club({
    name: 'Jeppe Cricket Club',
    district: JHB,
    folder: 'Jeppe CC',
    sources: ['affiliation', 'fixtures', 't20', 'compliance'],
    aliases: ['Jeppe', 'Jeppe CC'],
  }),
  club({
    name: 'Joburg Cricket Club',
    district: JHB,
    folder: 'Joburg CC',
    sources: ['affiliation', 'fixtures', 't20', 'compliance'],
    aliases: ['Joburg', 'Joburg CC'],
  }),
  club({
    name: 'Lenasia Cricket Club',
    district: JHB,
    folder: 'Lenasia CC',
    sources: ['affiliation', 'fixtures', 't20', 'compliance'],
    aliases: ['Lenasia cricket club', 'Lenasia Cricket', 'Lenasia', 'Lenasia CC'],
  }),
  club({
    name: 'Midrand Knights Cricket Club',
    district: JHB,
    sources: ['affiliation', 'fixtures'],
    aliases: ['Midrand Knights'],
  }),
  club({
    name: 'Noordgesig Cricket Club',
    district: JHB,
    sources: ['affiliation', 'fixtures'],
    aliases: ['Noordgesig'],
  }),
  club({
    name: 'Old Lions Cricket Club',
    district: JHB,
    folder: 'Old Lions Club Governance Docs',
    sources: ['affiliation', 'fixtures', 'compliance'],
    aliases: ['Old Lions Cricket', 'Old Lions CC', 'Old Lions'],
  }),
  club({
    name: 'Old Parktonians Cricket Club',
    district: JHB,
    folder: 'The Old Parktonian',
    sources: ['affiliation', 'fixtures', 't20', 'compliance'],
    aliases: ['The Old Parktonians', 'Old Parktonians', 'Old Parks', 'The Old Parktonian'],
    flags: ['"The Old Parktonians", "Old Parktonians" and "Old Parks" are treated as one club.'],
  }),
  club({
    name: 'Orange Farm Cricket Club',
    district: JHB,
    // Empty folder in the pack: the club exists, it just has no documents yet.
    folder: 'Orange Farm',
    sources: ['affiliation', 'compliance'],
    aliases: ['Orange Farm'],
    flags: [
      'Affiliated, but its compliance folder is empty — created with no documents.',
      'Appears in no 2026-27 fixtures sheet (entered Ladies Promotion + SU 7, which have no fixtures sheet).',
    ],
  }),
  club({
    name: 'PAV Soweto Cricket Club',
    district: JHB,
    districtGuess: true,
    sources: ['t20'],
    aliases: ['PAV Soweto', 'PAV Soweto CC'],
    flags: [
      'Appears ONLY in the Ladies Premier T20 (Group A) — no affiliation response, no league fixtures, no compliance folder. Kept as its own club.',
    ],
  }),
  club({
    name: 'Pirates Cricket Club',
    district: JHB,
    sources: ['affiliation', 'fixtures', 't20'],
    aliases: ['Pirates'],
  }),
  club({
    name: 'Randburg Cricket Club',
    district: JHB,
    folder: 'Ranburg',
    sources: ['affiliation', 'fixtures', 't20', 'compliance'],
    aliases: ['Randburg', 'Randburg CC', 'Ranburg'],
  }),
  club({
    name: 'Riverlea Cricket Club',
    district: JHB,
    sources: ['affiliation', 'fixtures'],
    aliases: ['Riverlea cricket club', 'Riverlea', 'Riverlea Sports Club'],
  }),
  club({
    name: 'Roodepoort Cricket Club',
    district: JHB,
    sources: ['affiliation'],
    aliases: ['Roodepoort cricket club', 'Roodepoort'],
    flags: ['Affiliated, but appears in no 2026-27 fixtures sheet.'],
  }),
  club({
    name: 'Sandton Tigers Cricket Club',
    district: JHB,
    folder: 'Sandton Tigers',
    sources: ['affiliation', 'fixtures', 'compliance'],
    aliases: ['Sandton Tigers CC', 'Sandton Tigers'],
  }),
  club({
    name: 'Sopranos Cricket Club',
    district: JHB,
    folder: 'Sopranos',
    sources: ['affiliation', 'fixtures', 'compliance'],
    aliases: ['Sopranos'],
  }),
  club({
    name: 'Soweto Pioneers Cricket Club',
    district: JHB,
    sources: ['affiliation', 'fixtures', 't20'],
    aliases: ['SOWETO PIONEERS CRICKET CLUB', 'Soweto Pioneers'],
  }),
  club({
    name: 'The Wanderers Cricket Club',
    district: JHB,
    folder: 'Wanderers CC',
    sources: ['affiliation', 'fixtures', 't20', 'compliance'],
    aliases: ['Wanderers', 'Wanderers CC'],
  }),
  club({
    name: 'Trent Bridge Lions Cricket Club',
    district: JHB,
    sources: ['affiliation'],
    aliases: ['Trent bridge lions', 'Trent Bridge Lions'],
    flags: ['Affiliated (entered Saturday + Sunday divisions), but appears in no fixtures sheet.'],
  }),
  club({
    name: 'University of Johannesburg Cricket Club',
    district: JHB,
    folder: 'UJ CC',
    sources: ['affiliation', 'fixtures', 't20', 'compliance'],
    aliases: ['UJ', 'UJ CC'],
    flags: [
      'Submitted the affiliation form twice (3 Aug and 4 Aug 2026); the later response is used.',
    ],
  }),
  club({
    name: 'Western Warriors Cricket Club',
    district: JHB,
    folder: 'Crescents',
    sources: ['affiliation', 'fixtures', 'compliance'],
    aliases: ['Western Warriors CC', 'Western Warriors/Crescents', 'Western Warriors', 'Crescents'],
    flags: [
      'MERGED: "Western Warriors CC" (affiliation), "Western Warriors/Crescents" (fixtures) and the "Crescents" compliance folder are treated as ONE club.',
    ],
  }),
  club({
    name: 'Wits Lions Cricket Club',
    district: JHB,
    sources: ['affiliation', 'fixtures'],
    aliases: ['Wits Lions'],
    flags: [
      'Kept SEPARATE from Wits University Cricket Club (both submitted their own affiliation form).',
    ],
  }),
  club({
    name: 'Wits University Cricket Club',
    district: JHB,
    sources: ['affiliation', 'fixtures', 't20'],
    // "Wits CC" (Sunday 5 only) — resolved to Wits University, not Wits Lions: Wits Lions
    // entered Saturday divisions only ("N/A" for Sunday); Wits University is the Sunday club.
    aliases: ['Wits university cricket club', 'Wits University', 'Wits CC'],
    flags: [
      'Kept SEPARATE from Wits Lions Cricket Club (both submitted their own affiliation form).',
      '"Wits CC" in the Sunday 5 fixtures is assumed to be Wits University (Wits Lions plays Saturdays only) — please confirm.',
    ],
  }),

  // ── Affiliated: Sedibeng ──
  club({
    name: 'Die Ratels Cricket Club',
    district: SED,
    sources: ['affiliation', 'fixtures'],
    aliases: ['Die Ratels CC', 'Die Ratels (Mens)', 'Die Ratels'],
  }),
  club({
    name: 'Heidelberg Cricket Club',
    district: SED,
    sources: ['affiliation', 'fixtures'],
    // "Heidelburg" is a typo on the Sunday teams/grounds sheet.
    aliases: ['Heidelberg', 'Heidelburg'],
  }),
  club({
    name: 'NWU Vaal Cricket Club',
    district: SED,
    folder: 'NWU',
    sources: ['affiliation', 'fixtures', 'compliance'],
    aliases: ['NWU VC', 'NWU Vaal', 'NWU'],
  }),
  club({
    name: 'Old Vaaltonians Cricket Club',
    district: SED,
    folder: 'Old Vaal',
    sources: ['affiliation', 'fixtures', 'compliance'],
    aliases: ['Old Vaaltonians', 'Old Vaal', 'Old Vaal CC'],
  }),
  club({
    name: 'Roshnee Cricket Club',
    district: SED,
    sources: ['affiliation', 'fixtures', 't20'],
    aliases: ['Roshnee'],
  }),
  club({
    name: 'Vaal University of Technology Cricket Club',
    district: SED,
    sources: ['affiliation', 'fixtures'],
    aliases: ['Vaal University of Technology Cricket Club(VUT CC)', 'VUT', 'VUT CC'],
  }),
  club({
    name: 'Vereeniging Cricket Club',
    district: SED,
    folder: 'VCCC',
    sources: ['affiliation', 'fixtures', 't20', 'compliance'],
    aliases: ['Vereeniging', 'VCC', 'VCCC'],
  }),

  // ── Affiliated: Mogale City ──
  club({
    name: 'Azaadville Cricket Club',
    district: MOG,
    folder: 'Azaadville',
    sources: ['affiliation', 'fixtures', 'compliance'],
    aliases: ['Azaadville cricket club (ACC)', 'Azaadville'],
  }),
  club({
    name: 'Kagiso Cricket Club',
    district: MOG,
    folder: 'Kagiso CC',
    sources: ['affiliation', 'fixtures', 't20', 'compliance'],
    aliases: ['Kagiso Cricket club', 'Kagiso', 'Kagiso CC'],
  }),
  club({
    name: 'Khosa Sports Club',
    district: MOG,
    folder: 'Khosa',
    sources: ['affiliation', 'fixtures', 't20', 'compliance'],
    aliases: ['Khosa Cricket', 'Khosa CC', 'Khosa'],
    flags: [
      '"Khosa Cricket", "Khosa CC", "Khosa" and "Khosa Sports Club" are treated as one club.',
    ],
  }),
  club({
    name: 'Swaneville Cricket Club',
    district: MOG,
    sources: ['affiliation', 'fixtures'],
    aliases: ['Swaneville'],
  }),

  // ── Affiliated: West Rand ──
  club({
    name: 'Randfontein Cricket Club',
    district: WR,
    folder: 'Randfontein CC',
    sources: ['affiliation', 'fixtures', 't20', 'compliance'],
    aliases: ['Randfontein', 'Randfontein CC'],
  }),

  // ── Fixtures-only (no affiliation response) ──
  club({
    name: 'Eldorado Park Ottomans Cricket Club',
    district: JHB,
    districtGuess: true,
    sources: ['fixtures'],
    aliases: ['EP Ottomans', 'Eldorado Park Ottomans CC', 'Eldorado Park Ottomans'],
    flags: [
      'In 5 fixture sheets as "EP Ottomans" / "Eldorado Park Ottomans CC" (treated as one club), but NO affiliation response was found.',
    ],
  }),
  club({
    name: 'Marks Park Cricket Club',
    district: JHB,
    districtGuess: true,
    sources: ['fixtures'],
    aliases: ['Marks Park'],
    flags: [
      'Kept SEPARATE from Marks Park Thistles, but please check: the two never meet in the same division (Thistles plays Premier A / Sunday 1 / Saturday 1, Marks Park plays Presidents A / Sunday 2 / Saturday 2), which could mean they are the 1st and 2nd teams of ONE club. Neither sent an affiliation form.',
    ],
  }),
  club({
    name: 'Marks Park Thistles Cricket Club',
    district: JHB,
    districtGuess: true,
    sources: ['fixtures', 't20'],
    // "Thisthles" is a typo on the Sunday teams/grounds sheet.
    aliases: ['Marks Park Thistles', 'Marks Park Thisthles'],
    flags: [
      'Kept SEPARATE from Marks Park Cricket Club until CGL confirms whether these are two clubs or two teams of one club. No affiliation response.',
    ],
  }),

  // ── Compliance-only (folder in the compliance pack; no affiliation, no fixtures) ──
  club({
    name: 'Calypso Cricket Club',
    district: JHB,
    districtGuess: true,
    folder: 'Calypso CC',
    sources: ['compliance'],
    // Its constitution names it "Calypso Old Maristonians" (formerly Old Maristonians CC).
    aliases: ['Calypso CC', 'Calypso', 'Calypso Old Maristonians'],
    flags: [
      'Compliance documents only (constitution says "Calypso Old Maristonians") — no affiliation response and no fixtures.',
    ],
  }),
  club({
    name: 'Diepsloot Cricket Club',
    district: JHB,
    districtGuess: true,
    folder: 'Diepsloot CC',
    sources: ['compliance'],
    aliases: ['Diepsloot CC', 'Diepsloot'],
    flags: ['Compliance documents only — no affiliation response and no fixtures.'],
  }),
  club({
    name: 'Gauteng Lions Deaf Cricket',
    district: JHB,
    districtGuess: true,
    folder: 'Gauteng Lions Deaf Cricket',
    sources: ['compliance'],
    aliases: ['Central Gauteng Lions Deaf Cricket', 'CGLDC', 'Lions Deaf Cricket'],
    flags: ['Compliance documents only — no affiliation response and no fixtures.'],
  }),
];

/**
 * Fixture-sheet rows that are NOT teams: "Macrocomm Round 1–4" is an interleaved T20-cup
 * placeholder in the Saturday sheets. Exact pattern only — the fixtures importer skips these
 * rows and aborts on every other unresolved name. Never resolvable via resolveClubName.
 */
export const NON_CLUB_FIXTURE_NAME = /^macrocomm round [1-4]$/i;

/** Normalise a raw club spelling to its lookup key: strips bidi/zero-width marks, collapses
 *  whitespace, lowercases. Never strips words — "Marks Park" ≠ "Marks Park Thistles". */
export function clubNameKey(raw: string): string {
  return raw
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Build the alias → club index. Throws on a key claimed by two clubs (a map-file bug that
 * would silently merge them) and on duplicate ids/folders. Exported for tests.
 */
export function buildAliasIndex(clubs: ClubMapEntry[]): Map<string, ClubMapEntry> {
  const index = new Map<string, ClubMapEntry>();
  const ids = new Set<string>();
  const folders = new Set<string>();
  for (const c of clubs) {
    if (ids.has(c.id)) throw new Error(`lions-import-map: duplicate club id "${c.id}"`);
    ids.add(c.id);
    if (c.folder !== null) {
      if (folders.has(c.folder))
        throw new Error(`lions-import-map: folder "${c.folder}" claimed by two clubs`);
      folders.add(c.folder);
    }
    for (const spelling of [c.name, ...c.aliases]) {
      const key = clubNameKey(spelling);
      if (NON_CLUB_FIXTURE_NAME.test(key))
        throw new Error(`lions-import-map: "${spelling}" is a non-club placeholder name`);
      const prior = index.get(key);
      if (prior && prior.id !== c.id)
        throw new Error(
          `lions-import-map: "${spelling}" resolves to both "${prior.id}" and "${c.id}"`,
        );
      index.set(key, c);
    }
  }
  return index;
}

const ALIAS_INDEX = buildAliasIndex(CLUB_MAP);

/** The club a raw spelling names, or null when it is unknown (fail closed — never guessed). */
export function resolveClubName(raw: string): ClubMapEntry | null {
  return ALIAS_INDEX.get(clubNameKey(raw)) ?? null;
}

/** resolveClubName, throwing on an unknown name (for callers that must abort). */
export function requireClubName(raw: string): ClubMapEntry {
  const hit = resolveClubName(raw);
  if (!hit)
    throw new Error(
      `lions-import-map: unknown club name "${raw}" — add it as an alias in CLUB_MAP (never guessed)`,
    );
  return hit;
}

export function clubById(id: string): ClubMapEntry | undefined {
  return CLUB_MAP.find((c) => c.id === id);
}

// ───────────────────────── District normalisation + resolution ─────────────────────────

/**
 * The affiliation form's MUNICIPAL DISTRICT free text → canonical district, or null when
 * unrecognised (fail closed). Seen values: JOHANNESBURG, SEDIBENG, MOGALE, Westrand.
 */
export function normalizeDistrict(raw: string): LionsDistrict | null {
  const s = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  if (/^(CITY OF )?(JOHANNESBURG|JOBURG|JHB)$/.test(s)) return 'Johannesburg';
  if (/^SEDIBENG$/.test(s)) return 'Sedibeng';
  if (/^MOGALE( CITY)?$/.test(s)) return 'Mogale City';
  if (/^WEST ?RAND$/.test(s)) return 'West Rand';
  return null;
}

const DISTRICT_PATTERNS: Record<LionsDistrict, RegExp> = {
  Johannesburg: /johannesburg|joburg|\bjhb\b/i,
  Sedibeng: /sedibeng/i,
  'Mogale City': /mogale/i,
  'West Rand': /west\s*-?\s*rand/i,
};

/**
 * Map each canonical district onto the tenant's configured district NAME. Never hardcoded —
 * club.district must equal a configured name exactly for admin filters and insights.
 * Exactly one configured name must match each district; zero or several is fail-closed,
 * with the configured list in the message (the resolveTuskersDistrict contract, ×4).
 */
export function resolveLionsDistricts(
  configuredDistricts: string[],
): { kind: 'ok'; byDistrict: Record<LionsDistrict, string> } | { kind: 'error'; message: string } {
  const byDistrict = {} as Record<LionsDistrict, string>;
  const problems: string[] = [];
  for (const d of LIONS_DISTRICTS) {
    const hits = configuredDistricts.filter((c) => DISTRICT_PATTERNS[d].test(c));
    if (hits.length === 1) byDistrict[d] = hits[0];
    else problems.push(`"${d}": ${hits.length} configured match(es)`);
  }
  if (problems.length)
    return {
      kind: 'error',
      message:
        `expected exactly one configured district per CGL district — ${problems.join('; ')} ` +
        `— configured: ${configuredDistricts.map((d) => JSON.stringify(d)).join(', ') || '(none)'}`,
    };
  return { kind: 'ok', byDistrict };
}

// ───────────────────────── Affiliation league tokens → league keys ─────────────────────────

/**
 * Affiliation-form division tokens → the lions league keys the fixtures bootstrap (Phase 5)
 * creates. The affiliation importer assigns a key ONLY when it exists in the tenant config
 * at run time; anything else is reported. Fixtures are authoritative for actual entries —
 * sync-club-leagues runs after the fixtures import.
 */
export const AFFILIATION_LEAGUE_KEYS: Record<string, string> = {
  'PREM A': 'premier-a',
  'PREM B': 'premier-b',
  'PRES A': 'presidents-a',
  'PRES B': 'presidents-b',
  'SU 1': 'sunday-1',
  'SU 2': 'sunday-2',
  'SU 3': 'sunday-3',
  'SU 4': 'sunday-4',
  'SU 5': 'sunday-5',
  'SU 6': 'sunday-6',
  'SU 7 (35 OVERS U18)': 'sunday-7',
  'SA 1': 'saturday-1',
  'SA 2': 'saturday-2',
  'SA 3': 'saturday-3',
  'SA 4': 'saturday-4',
  'SA 5': 'saturday-5',
  'MENS VETERANS': 'vets-sa-1',
  'LADIES PREM': 'ladies-premier',
  'LADIES PRES': 'ladies-presidents',
  'LADIES DEV LEAGUE': 'ladies-development',
  'LADIES PROMOTION': 'ladies-promotion',
};

// ───────────────────────── Compliance pack: doc classification ─────────────────────────
//
// Consumed by import-lions-compliance.ts and exercised directly by
// test/lions-compliance.test.ts. The pack is the CLEANED copy built in Phase 0
// (Downloads/Lions/prepared/compliance/): 28 club folders, `_root-unique/` (the 7 loose root
// files that were not byte-duplicates of a folder file), and `<club>/extracted/` holding the
// attachments and bodies pulled out of the .msg emails. Every file was opened (text layer,
// or rendered page images for scans) before these rules and overrides were written. Never
// derive anything from a filename YEAR — Lenasia's "AGM Miutes - September 2004" is a
// typo for 2024.

/** The pack's folder of loose root files: no club of its own, so every file in it must be
 * an explicit FILE_OVERRIDES reassignment or skip (DOC_RULES never run there). */
export const ROOT_UNIQUE_FOLDER = '_root-unique';

/**
 * CLUB_MAP folders deliberately left out of the doc pass. Orange Farm's folder is empty in
 * the source pack (and absent from the cleaned copy) — the club itself is created by the
 * affiliation import (amendment 10); here it is simply not expected to carry docs.
 */
export const DOC_PASS_EXCLUDED_FOLDERS = new Set(['Orange Farm']);

/** The clubs this import attaches documents to: every CLUB_MAP club with a pack folder,
 * minus DOC_PASS_EXCLUDED_FOLDERS. Each must end up with at least one classified doc. */
export const DOC_CLUBS: ClubMapEntry[] = CLUB_MAP.filter(
  (c) => c.folder !== null && !DOC_PASS_EXCLUDED_FOLDERS.has(c.folder),
);

const clubIdOfFolder = (folder: string): string => {
  const hit = CLUB_MAP.find((c) => c.folder === folder);
  if (!hit) throw new Error(`lions-import-map: no CLUB_MAP entry for folder "${folder}"`);
  return hit.id;
};

/** Every doc key of the `lions` catalogue (configure-tenant-docs.ts) — asserted against the
 * live tenant catalogue at dry-run. memberDatabase and clubLogo get no file from this pack
 * (rosters are Phase 6; no club sent a logo). */
export const LIONS_DOC_KEYS = [
  'constitution',
  'agmMinutes',
  'financials',
  'committee',
  'memberDatabase',
  'chairmansReport',
  'bankConfirmation',
  'orgRegistration',
  'beeCert',
  'clubLogo',
  'clubRecords',
];

/** Doc keys that store more than one file, mirrored from the `lions` catalogue. Asserted in
 * both directions against the live catalogue at dry-run. */
export const MULTI_FILE_DOC_KEYS = new Set(['agmMinutes', 'financials', 'clubRecords']);

/** Ordered [regex, docKey] pairs over the FILENAME — first match wins, case-insensitive. */
export const DOC_RULES: Array<[RegExp, string]> = [
  // "consti" (not "constitution") also covers Sopranos' "Constituition.pdf".
  [/consti/i, 'constitution'],
  // Chairman's report, and club annual reports (Wanderers, Randburg's RCC_Annual_Report_…).
  [/chairman|annual[\s_]*report/i, 'chairmansReport'],
  // No word boundaries: "Minutes_AGM_Khosa", "2024AGMApproved", "AGMNOTICE2025". Notices,
  // agendas and invitations travel with the minutes. "miute"/"minuite" are pack typos.
  [/agm|annual\s*general|minut|miute|agenda/i, 'agmMinutes'],
  [/\bb-?b?bee\b|\bbee\b/i, 'beeCert'],
  // NPO / CIPC / CoR39 (Randfontein's company registration), "Club Verification - NPO"
  // (Old Vaal's NPO attestation), "Non profit registration" (Old Parks).
  [/\bnpo|cipc|cor\s*39|registration|club\s*verification|non\s*profit/i, 'orgRegistration'],
  // Executive / office-bearer / officials lists. "contact details" is Old Vaal's memo of
  // its office-bearers with their contact details.
  [/exec|office\s*bearers|committee|officials|contact\s*details/i, 'committee'],
  // Bank-stamped account confirmations: "bank letter", "Bank confromation letter" (sic),
  // SBSA_ConfirmationLetter, Nedbank "ProofOfAccounts", ABSA "Account Confirmation".
  [/bank|proof\s*of\s*accounts?|confirmation\s*letter|account\s*confirmation/i, 'bankConfirmation'],
  // Financial statements, AFS, trial balances (NWU's GLSummaryReport), cash-flows, and the
  // FNB "GOLD BUSINESS ACCOUNT nnn" monthly BANK STATEMENTS — statements are financial
  // evidence (CGL asked for "AFS or bank statements"), not the single bank-confirmation
  // letter, and a club often sent several of them.
  [
    /financ|\bafs\b|\bfs\b|income\s*statement|balance\s*sheet|cash\s*flow|gl\s*summary|treasurer|gold[\s_]*business[\s_]*account/i,
    'financials',
  ],
];

/**
 * Relative-path (forward slashes) patterns for files that are known and deliberately NOT
 * imported, with the reason printed in the parse report. Checked after FILE_OVERRIDES and
 * before DOC_RULES.
 */
export const SKIP_RULES: Array<[RegExp, string]> = [
  [/\/_inline-email-images\//, 'inline email signature/banner image (reference only)'],
  [/ - email body\.txt$/i, 'extracted email body (reference only, not a document)'],
  [
    /\.msg$/i,
    'Outlook .msg container — its attachments were extracted to <club>/extracted/ and import from there',
  ],
  [
    /\.pages$/i,
    'Apple Pages file — not uploadable; export it to PDF from Pages.app and drop the PDF in the same folder (see the Azaadville FILE_OVERRIDES note)',
  ],
];

/**
 * A FILE_OVERRIDES value: `{ skip: reason }` (known, deliberately not imported), a docKey
 * (force that key, in the folder's own club), or `{ club, docKey }` — a REASSIGNMENT to
 * another club (`club` is a CLUB_MAP id). Every `_root-unique/` file needs one of these.
 */
export type FileOverride = { skip: string } | string | { club: string; docKey: string };

/**
 * Exact relative-path overrides. Every decision here was made from the file's CONTENT.
 */
export const FILE_OVERRIDES: Record<string, FileOverride> = {
  // ── _root-unique/: the 7 loose root files that were not byte-duplicates ──
  // Same text (pdftotext diff is empty) as "Delfos Cricket Club/Delfos Finance 2023_24.pdf"
  // — a second Excel export of the same workbook (Jul 2025 vs Dec 2024), so different bytes
  // and content-hash dedupe can't collapse it. The folder copy imports.
  '_root-unique/Delfos Finance 2023_24.pdf': {
    skip: 'text-identical re-export of "Delfos Cricket Club/Delfos Finance 2023_24.pdf" (the folder copy imports)',
  },
  // Central Gauteng Lions BLIND Cricket's 2021 Disability Awareness Month proposal to CGL
  // — not a compliance document, and CGLBC is not a club in this pack.
  '_root-unique/IMG-20250708-WA0133.jpg': {
    skip: 'CGL Blind Cricket 2021 Disability Awareness Month letter — not a club compliance document',
  },
  // Randfontein Cricket Club's signed "Socio-economic Development — confirmation letter for
  // qualifying contributions" (CGL monthly grant), 1 Jul 2025. Not a B-BBEE certificate.
  '_root-unique/IMG-20250708-WA0134.jpg': {
    club: clubIdOfFolder('Randfontein CC'),
    docKey: 'clubRecords',
  },
  // A 2024-25 exec-list draft; superseded by the 24 June register (see Lenasia below).
  '_root-unique/LCC Executive Members 2024- 25 - CGL.docx': {
    skip: 'superseded Lenasia exec-list draft — the 24 June 2025 register is the committee file',
  },
  // Old Parktonians' 2025/26 cricket committee (chair Ryan Wessels, club manager etc.).
  '_root-unique/New Cricket Committee 2025.2026 season.xlsx': {
    club: clubIdOfFolder('The Old Parktonian'),
    docKey: 'committee',
  },
  // The two Lenasia .msg containers are caught by the .msg SKIP_RULE.

  // ── Lenasia CC: three versions of the 2024-25 exec list (different bytes, same list);
  // the club's later email "Re: Updated List - LCC Exec" (10 Jul 2025 18:20) sends the
  // "latest LCC Executive List" — the 24 June 2025 meeting register — which is authoritative.
  'Lenasia CC/extracted/LCC Executive Members - 24 June Meeting 25 Register.pdf': 'committee',
  'Lenasia CC/LCC Executive Members 2024- 25 - CGL.docx': {
    skip: 'superseded Lenasia exec-list draft — the 24 June 2025 register is the committee file',
  },
  'Lenasia CC/extracted/LCC Executive Members 2024- 25 - CGL.docx': {
    skip: 'superseded Lenasia exec-list draft (email attachment) — the 24 June 2025 register is the committee file',
  },

  // ── Azaadville folder: the .msg email inside it is from Ajit Gandabhai of AZAD SWARAJ
  // Sporting Club (its 25 May 2025 AGM elected President Keyur Chauhan; the body says
  // "Cash flow attached" = Azad Swaraj's CASHFLOW.2023.4.pdf). Its attachment is Azad
  // Swaraj's officials list, filed under the wrong club. ──
  'Azaadville/extracted/LIST.OFFICIALS.25MAY25.pdf': {
    club: clubIdOfFolder('Azad Swaraj'),
    docKey: 'committee',
  },
  // Page-1 QuickLook thumbnail of the .pages minutes — a partial document.
  'Azaadville/extracted/ACC AGM Minutes (from pages) - page 1 preview only.jpg': {
    skip: 'page-1 preview image of the .pages AGM minutes — partial document; import the full PDF export instead',
  },
  // PENDING: when the user exports "ACC AGM Minutes .pages" to PDF from Pages.app and drops
  // it in Azaadville/, it imports as agmMinutes — the DOC_RULES agm rule matches it under any
  // name containing "AGM Minutes". Pinned here for the expected export name (an override
  // for an absent file is inert).
  'Azaadville/ACC AGM Minutes .pdf': 'agmMinutes',
  // Scan, no text layer: "Constitution of Azaadville Cricket Club, 01 March 2019", 6 pages.
  'Azaadville/Scanned Documents-8.pdf': 'constitution',

  // ── Opaque filenames, identified from content ──
  // TymeBank "Proof of account" for Alexandra cricket club, 1 Oct 2024.
  'Alexandra CC/9447ca2ee9c949959ffd2026ea09e891_printpdf.pdf': 'bankConfirmation',
  // "Constitution of Calypso Old Maristonians" (amended to the 2018 AGM).
  'Calypso CC/Calypso.pdf': 'constitution',
  // FNB electronic-stamp ACCOUNT CONFIRMATION LETTER for DALIKAY CRICKET CLUB, 26 Nov 2024.
  'Dalikay CC/15.59596043.090226e8f0d1bee7 (2).pdf': 'bankConfirmation',
  // WhatsApp-shared scan (renamed .pdf in Phase 0): Dalikay Cricket Club constitution, 2013.
  'Dalikay CC/DOC-20240508-WA0012.pdf': 'constitution',
  // Scan, no text layer: "Diepsloot Cricket Club 'DCC' Constitution", 8 pages, signed 2018.
  'Diepsloot CC/Diepsloot.pdf': 'constitution',
  // FNB ACCOUNT CONFIRMATION LETTER for DURBAN OLD BOYS CRICKET CLUB, 22 Nov 2024.
  'Durban Old Boys/62924552195-confirmation.pdf': 'bankConfirmation',
  // Standard Bank "Confirmation of Bank account" for OLD PARKTONIAN SPORTS CLUB, 24 Mar 2025.
  'The Old Parktonian/doc01432820250324132615.pdf': 'bankConfirmation',
  // FNB Gold Business Account monthly STATEMENTS (Nov 2024, Jul 2025) for Sopranos.
  'Sopranos/62054946242_20241123.pdf': 'financials',
  'Sopranos/62054946242_20250717.pdf': 'financials',
  // ABSA stamped transaction history (Jun–Jul 2025) for RANDFONTEIN KRIEKET KLUB.
  'Randfontein CC/RANDFONTEIN KRIEKET KLUB_2025-06-01_2025-07-08_stamped.pdf': 'financials',
  // Scanned 4-page bundle: Standard Bank 60-day statement + Standard Bank "Confirmation of
  // Bank account" (11 Jul 2025) + the 13 Jul 2025 AGM attendance register. Filed as the
  // club's (newest) bank confirmation.
  'Kagiso CC/Document 10.pdf': 'bankConfirmation',
  // Phone photo of Kagiso's EARLIER Standard Bank confirmation letter (9 Dec 2024) —
  // superseded by the Jul 2025 letter above, and bankConfirmation holds one file.
  'Kagiso CC/IMG_20241209_110929_resized_20241209_112849728.jpg': 'clubRecords',
  // Editable .docx of the same constitution as "…Constitution 2 - Coach Nicky.pdf" (the
  // word-level diff is only the PBO number line and the signature-table layout); the pdf
  // is the rendered copy and constitution holds one file.
  'Kagiso CC/Kagiso Cricket Club Constitution 2.docx': {
    skip: 'editable .docx of the same constitution as "Kagiso Cricket Club Constitution 2 - Coach Nicky.pdf" (the pdf imports)',
  },
  // CIPC COR14.3 registration certificate for JCC Hope Village NPC (25 Jan 2023).
  'Joburg CC/JCC HOPE VILLAGE CIPC DOCUMENTS.pdf': 'orgRegistration',
  // The CIPC incorporation filing (directors/incorporators with ID numbers, 28 Nov 2022) —
  // supporting paperwork; orgRegistration holds one file (the certificate above).
  'Joburg CC/JCC HOPE VILLAGE - NEW COMPANY REG DOCUMENTS_-signed.pdf': 'clubRecords',
  // 15-page scanned bundle: 7 Jul 2025 AGM minutes (first), 2023/24 income & expenditure,
  // SARS PBO tax-exemption letter, the club constitution, and the exec list. A file lands
  // under one key — filed as the AGM minutes it opens with (see the runbook: the admin can
  // mark constitution/committee compliant from the same file).
  'Dobsonville Cricket Club/DCC COMPLIANCE DOCUMENTS 2.pdf': 'agmMinutes',

  // ── Pinned for clarity (DOC_RULES would place these the same way) ──
  // Old Parks' financials arrived as a .pptx; the Phase 0 PDF conversion previews inline,
  // and the original deck is kept as an additional financials file (source of record).
  'The Old Parktonian/Old Parks finances for 2024 and 2025_cln (converted from pptx).pdf':
    'financials',
  'The Old Parktonian/Old Parks finances for 2024 and 2025_cln.pptx': 'financials',
};

export type ClassifyResult =
  /** `club` is set only when a FILE_OVERRIDES reassignment moves the file to a club other
   * than its folder's. */
  | { kind: 'doc'; docKey: string; club?: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'unclassified' };

/**
 * Classify one compliance-pack file by its relative path (folder/…/filename). Order:
 * FILE_OVERRIDES → SKIP_RULES → DOC_RULES (DOC_RULES never run in ROOT_UNIQUE_FOLDER).
 */
export function classifyFile(relPath: string, filename: string): ClassifyResult {
  const override = FILE_OVERRIDES[relPath];
  if (typeof override === 'string') return { kind: 'doc', docKey: override };
  if (override && 'skip' in override) return { kind: 'skip', reason: override.skip };
  if (override) return { kind: 'doc', docKey: override.docKey, club: override.club };
  for (const [re, reason] of SKIP_RULES) {
    if (re.test(relPath)) return { kind: 'skip', reason };
  }
  if (relPath.split('/')[0] === ROOT_UNIQUE_FOLDER) return { kind: 'unclassified' };
  for (const [re, docKey] of DOC_RULES) {
    if (re.test(filename)) return { kind: 'doc', docKey };
  }
  return { kind: 'unclassified' };
}
