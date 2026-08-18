/**
 * Titans compliance-pack import — pure data + pure parsing helpers, NO AWS imports.
 *
 * Mirrors import-planb-fixtures.ts's separation: this module is the "manifest" (club
 * roster, filename classifier, structure-spreadsheet section map) that both
 * import-titans-compliance.ts and import-titans-roster.ts read, and that
 * test/import-titans.test.ts exercises directly without ever touching DynamoDB/S3.
 *
 * WHY A SEPARATE MAP FILE (not inlined in the CLI): the CLI's `--parse-only` mode must
 * run with plain `npx tsx` (no `sst shell`, no AWS creds) so the classifier/resolver can
 * be iterated against the real extracted pack — see docs/runbooks/titans-compliance-import.md.
 */
import { clubIdFromName } from './club-id.js';
import type ExcelJS from 'exceljs';

// ───────────────────────── Club roster ─────────────────────────

export interface ClubMapEntry {
  /** Exact sub-folder name under "Compliance Documents/". */
  folder: string;
  /** Canonical display name written to Club.name. */
  name: string;
  /** Derived via clubIdFromName(name) — never hand-typed, so it can never drift. */
  id: string;
  /**
   * Normalised (uppercase, whitespace-collapsed) base token(s) this club's teams appear
   * under in the structure spreadsheet, AFTER stripping a trailing team number/letter/
   * "VETERANS"/"CC" suffix (see normalizeTeamToken). Most clubs have exactly one; a few
   * sheets use more than one spelling for the same club (Pretoria/Police full names).
   */
  sheetTokens: string[];
}

function club(folder: string, name: string, sheetTokens: string[]): ClubMapEntry {
  return { folder, name, id: clubIdFromName(name), sheetTokens };
}

/**
 * The 21 Titans clubs. Folder names are exactly what's under "Compliance Documents/"
 * (verified against the real extracted pack); display names expand acronyms only where
 * the compliance docs themselves do (Centurion Kavaliers' constitution/AGM paperwork
 * spells out "Cricket Club NPC" — kept short here since the folder/short form is what
 * the union and the structure sheet both use everywhere else).
 */
export const CLUB_MAP: ClubMapEntry[] = [
  club('Adelaar', 'Adelaar Cricket Club', ['ADELAAR']),
  club('Atteridgeville', 'Atteridgeville Cricket Club', ['ATTERIDGEVILLE']),
  club('Brits', 'Brits Cricket Club', ['BRITS']),
  club('CBCOB', 'CBCOB Cricket Club', ['CBCOB']),
  club('Centurion Kavaliers', 'Centurion Kavaliers Cricket Club', ['CENTURION KAVALIERS']),
  // "Differently Abled Cricket Club" per DACC's own Members Database header ("CLUB NAME :
  // Differently Abled Cricket Club") — the structure sheet spells the team names out in
  // full ("DIFFERENTLY ABLED 4" etc), never the acronym.
  club('DACC', 'DACC (Differently Abled Cricket Club)', ['DIFFERENTLY ABLED']),
  club('Eersterust', 'Eersterust Cricket Club', ['EERSTERUST']),
  club('Hammanskraal', 'Hammanskraal Cricket Club', ['HAMMANSKRAAL']),
  club('Harlequins', 'Harlequins Cricket Club', ['HARLEQUINS']),
  club('Irene Villagers', 'Irene Villagers Cricket Club', ['IRENE VILLAGERS']),
  club('Laudium', 'Laudium Cricket Club', ['LAUDIUM']),
  club('Mamelodi', 'Mamelodi Cricket Club', ['MAMELODI']),
  club('PHSOB', 'PHSOB Cricket Club', ['PHSOB']),
  club('Police Cricket Club', 'Police Cricket Club', ['POLICE']),
  // "PRETORIA" alone (never "PRETORIA CC") is the sheet token — confirmed by the SENIORS
  // sheet's Premier League Division B ("PRETORIA 1", venue "PRETORIA A").
  club('Pretoria Cricket Club', 'Pretoria Cricket Club', ['PRETORIA']),
  club('Pretoria East', 'Pretoria East Cricket Club', ['PRETORIA EAST']),
  club('Queenswood Cricket Club', 'Queenswood Cricket Club', ['QUEENSWOOD CRICKET CLUB']),
  club('Sinoville Cricket Club', 'Sinoville Cricket Club', ['SINOVILLE']),
  club('Soshanguve Cricket Club', 'Soshanguve Cricket Club', ['SOSHANGUVE']),
  club('TUKS', 'TUKS Cricket Club', ['TUKS']),
  club('TUT', 'TUT Cricket Club', ['TUT']),
];

/**
 * Sheet TYPOS/variants that must resolve to a different base token before the
 * sheetTokens lookup runs. Kept separate from CLUB_MAP (which never carries an
 * unverifiable spelling) — mirrors NAME_REDIRECTS in import-planb-fixtures.ts.
 */
const TOKEN_REDIRECTS: Record<string, string> = {
  // "HAMMNASKRAAL 1" — Women's Promotion League, SENIORS sheet row 41.
  HAMMNASKRAAL: 'HAMMANSKRAAL',
};

/**
 * Strip a trailing team number ("TUKS 1"), letter ("ADELAAR B"), "VETERANS" qualifier
 * ("PHSOB VETERANS 1"), or stray "CC" suffix ("CENTURION KAVALIERS CC 2") down to the
 * club's base token, uppercased and whitespace-collapsed. Order matters: a trailing
 * digit is stripped first (so "PHSOB VETERANS 1" → "PHSOB VETERANS" → "PHSOB", not
 * "PHSOB VETERANS 1" failing the VETERANS strip because of the trailing digit).
 */
export function normalizeTeamToken(raw: string): string {
  let s = raw.trim().replace(/\s+/g, ' ').toUpperCase();
  s = s.replace(/\s+\d+$/, ''); // trailing team number
  s = s.replace(/\s+VETERANS$/, ''); // "… VETERANS" qualifier (post digit-strip)
  s = s.replace(/\s+[A-Z]$/, ''); // trailing single-letter side (A/B/C/D…)
  s = s.replace(/\s+CC$/, ''); // stray "CC" suffix ("CENTURION KAVALIERS CC")
  return TOKEN_REDIRECTS[s] ?? s;
}

function buildTokenIndex(clubs: ClubMapEntry[]): Map<string, ClubMapEntry> {
  const index = new Map<string, ClubMapEntry>();
  for (const c of clubs) for (const t of c.sheetTokens) index.set(t, c);
  return index;
}

const TOKEN_INDEX = buildTokenIndex(CLUB_MAP);

/** Resolve a raw structure-sheet team name to its CLUB_MAP entry, or undefined. */
export function resolveClubToken(raw: string): ClubMapEntry | undefined {
  return TOKEN_INDEX.get(normalizeTeamToken(raw));
}

// ───────────────────────── Filename classifier ─────────────────────────

/** Ordered [regex, docKey] pairs — first match wins. Case-insensitive throughout. */
export const DOC_RULES: Array<[RegExp, string]> = [
  [/league\s*entry/i, 'leagueEntry'],
  [/assets?\s*register/i, 'assetsRegister'],
  [/health\s*tracker/i, 'healthTracker'],
  // databa?se matches both "database" and the "Databse" typo seen across most clubs'
  // filenames in one regex; player.?list covers Pretoria CC's differently-named export.
  [/databa?se|player.?list/i, 'memberDatabase'],
  [/committee/i, 'committee'],
  [/constitution/i, 'constitution'],
  [/agm|annual\s*general/i, 'agm'],
  [/chairman/i, 'chairmansReport'],
  [/financial/i, 'financials'],
  // "fields?\.pdf$" catches "Excellentiam Fields.pdf", which names neither "facility"
  // nor "agreement"/"lease"/"mou"/"field agreement"/"field use" — every other
  // facility-doc naming convention observed in the pack is covered by the other terms.
  [
    /lease|facilit|\bmou\b|field\s*agreement|field\s*use|agreement|fields?\.pdf$/i,
    'facilityAgreement',
  ],
];

/**
 * Exact relative-path (folder/filename, forward slashes) overrides for files the regex
 * classifier can't place correctly on its own — duplicate pairs where only one file may
 * be kept per single-file doc key, and a supplementary file that isn't a distinct
 * compliance document at all. `'skip'` means "known, deliberately not imported" (never
 * counts as an unclassified-file abort); a docKey override forces classification to that
 * key even if DOC_RULES would (or wouldn't) have matched it.
 */
export const FILE_OVERRIDES: Record<string, string | 'skip'> = {
  // Committee pdf+xls pair — keep the xls (structured data), skip the pdf render of it.
  'Adelaar/Club Committee-  2026 - 2027.pdf': 'skip',
  // healthTracker is single-file: Queenswood supplied both the xlsx workbook and a pdf
  // export of the same tracker. Keep the xlsx, skip the pdf.
  'Queenswood Cricket Club/QCC Club Health Tracker 2026-2027.pdf': 'skip',
  // Sinoville supplied a "Club DataBase" workbook AND a separate "Contact list" — the
  // latter doesn't match the memberDatabase regex (no "database"/"player list" wording)
  // and isn't a distinct compliance document; the workbook is the canonical roster
  // source used by import-titans-roster.ts, so the contact list is skipped explicitly
  // rather than left to abort the run as unclassified.
  'Sinoville Cricket Club/Sinoville Contact list 2025-2026.docx': 'skip',
};

/**
 * Doc keys that store MORE THAN ONE file (docMeta[key] = { files: [...] }), mirrored
 * from the tenant's operator-configured catalogue (see TITANS_DOC_KEYS below) so the
 * classifier and importer agree on which keys may hold >1 file without importing
 * catalogue.ts's runtime resolution logic into this pure module.
 */
export const MULTI_FILE_DOC_KEYS = new Set(['agm', 'facilityAgreement']);

/** Every doc key this import ever writes — must equal the tenant's configured catalogue
 * (asserted at dry-run against resolveRequiredDocs(config) — see import-titans-compliance.ts). */
export const TITANS_DOC_KEYS = [
  'leagueEntry',
  'assetsRegister',
  'healthTracker',
  'memberDatabase',
  'committee',
  'constitution',
  'agm',
  'chairmansReport',
  'financials',
  'facilityAgreement',
];

export type ClassifyResult =
  | { kind: 'doc'; docKey: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'unclassified' };

/** Classify one compliance-pack file by its folder/filename relative path. */
export function classifyFile(relPath: string, filename: string): ClassifyResult {
  const override = FILE_OVERRIDES[relPath];
  if (override === 'skip') return { kind: 'skip', reason: 'FILE_OVERRIDES: explicit skip' };
  if (override) return { kind: 'doc', docKey: override };
  for (const [re, docKey] of DOC_RULES) {
    if (re.test(filename)) return { kind: 'doc', docKey };
  }
  return { kind: 'unclassified' };
}

// ───────────────────────── Roster import exceptions ─────────────────────────

export interface SkipRosterEntry {
  clubId: string;
  reason: string;
}

/**
 * Clubs whose memberDatabase file cannot be imported at all — reviewed exceptions,
 * checked by import-titans-roster.ts before it even opens the file. Never silently
 * skipped without a documented reason.
 */
export const SKIP_ROSTER: SkipRosterEntry[] = [
  {
    clubId: 'queenswood-cricket-club',
    reason:
      '"QCC players database 2026-2027.xlsx" is a names-only template (columns ' +
      'U9s/U11s/U13s/U15s/1st team, one bare full-name string per cell — no surname, ' +
      'ID number, DOB, gender or race column at all). There is no identity data to build ' +
      'a PlayerRegistration from; the club needs to supply a proper roster export before ' +
      'this can import.',
  },
];

// ───────────────────────── Structure spreadsheet ─────────────────────────

/**
 * Structure-sheet section header → titans league key. Matched against the header text
 * AFTER whitespace-collapse + uppercase (so "U/15 PLATINUM  A" and "U/9 PLATINUM A" are
 * matched the same way). Men's senior sections collapse Division A/B pairs onto one
 * league key (the sheet splits a league into venue-balanced divisions, not separate
 * competitions); junior sections collapse every Platinum/Gold/Silver × A/B pool onto its
 * age-group key. Women's and Veterans sections originally resolved to `null` (parsed and
 * reported, never written) because the tenant had no league keys for them; those keys now
 * exist on the tenant (see EXTRA_LEAGUES + docs/runbooks/titans-compliance-import.md), so
 * they map like everything else. The dry-run still asserts every referenced key exists in
 * TenantConfig.leagues before any write.
 */
const SECTION_LEAGUE_MAP: Array<[RegExp, string | null]> = [
  [/^PREMIER LEAGUE DIVISION [AB]$/, 'premier-league'],
  [/^PROMOTION LEAGUE DIVISION [AB]$/, 'promotion-league'],
  [/^SECOND LEAGUE$/, 'second-league'],
  [/^THIRD LEAGUE$/, 'third-league'],
  [/^FOURTH LEAGUE$/, 'fourth-league'],
  [/^FIFTH LEAGUE$/, 'fifth-league'],
  [/^SIXTH LEAGUE$/, 'sixth-league'],
  [/^WOMEN'S PREMIER LEAGUE$/, 'womens-premier-league'],
  [/^WOMEN'S PROMOTION LEAGUE$/, 'womens-promotion-league'],
  [/^VETERANS LEAGUE$/, 'veterans-league'],
  [/^U\/9 (PLATINUM|GOLD|SILVER) [AB]$/, 'u9'],
  [/^U\/11 (PLATINUM|GOLD|SILVER) [AB]$/, 'u11'],
  [/^U\/13 (PLATINUM|GOLD|SILVER) [AB]$/, 'u13'],
  [/^U\/15 (PLATINUM|GOLD|SILVER) [AB]$/, 'u15'],
];

/**
 * League entries the structure sheet needs beyond the 13 originally configured on the
 * tenant — the Women's and Veterans competitions. Shape mirrors the existing entries
 * (overarching, no district split). Consumed by the import's `--add-missing-leagues`
 * config step, which appends only the ones absent (idempotent) before any team write.
 */
export const EXTRA_LEAGUES = [
  { key: 'womens-premier-league', label: "Women's Premier League", group: 'Overarching Leagues' },
  {
    key: 'womens-promotion-league',
    label: "Women's Promotion League",
    group: 'Overarching Leagues',
  },
  { key: 'veterans-league', label: 'Veterans League', group: 'Overarching Leagues' },
];

export interface KnownStructureAnomaly {
  sheet: string;
  header: string;
  raw: string;
  reason: string;
}

/**
 * Structure-sheet cells that are known-corrupted source data, not a resolvable team
 * token — reviewed and documented exceptions (same convention as import-planb-fixtures'
 * KEEP_LIST/DELETE_SLUGS), never a silent catch-all. Excluded from the "unresolved
 * token" abort gate but still printed, separately, by the importer's report — "knowingly
 * reported", not silently dropped.
 */
export const KNOWN_STRUCTURE_ANOMALIES: KnownStructureAnomaly[] = [
  {
    sheet: 'JUNIORS ',
    header: 'U/11 GOLD A',
    raw: 'LAERSKOOL MAYVILLE',
    reason:
      "Source row is corrupted: a venue name ('Laerskool Mayville') landed in the " +
      'TEAM-NAME cell instead of a club team token (row 22 of the JUNIORS sheet, the ' +
      "U/11 GOLD A column pair) — the adjacent VENUE cell reads 'TUKS C', which is not " +
      'this venue either, so the row looks shifted/overwritten rather than merely ' +
      'mistyped. No club can be inferred from the cell alone. Confirmed against a full ' +
      'workbook dump on 17 Aug 2026 — needs the union to identify the intended team.',
  },
];

export function isKnownStructureAnomaly(sheet: string, header: string, raw: string): boolean {
  return KNOWN_STRUCTURE_ANOMALIES.some(
    (a) => a.sheet === sheet && a.header === header && a.raw === raw,
  );
}

/** Resolve a section header's league key. `undefined` ⇒ the manifest doesn't recognise
 * this header at all (fails the run closed — a genuinely new section must be added to
 * SECTION_LEAGUE_MAP deliberately, never silently ignored or silently mapped). */
export function leagueKeyForSection(headerText: string): string | null | undefined {
  const h = headerText.trim().replace(/\s+/g, ' ').toUpperCase();
  const hit = SECTION_LEAGUE_MAP.find(([re]) => re.test(h));
  return hit ? hit[1] : undefined;
}

export interface StructureTeamRow {
  /** Raw team-name cell text, e.g. "TUKS 1". */
  raw: string;
  /** Venue cell text (may be blank). */
  venue: string;
  club: ClubMapEntry | undefined;
}

export interface StructureSection {
  /** Raw header text, e.g. "PREMIER LEAGUE DIVISION A". */
  header: string;
  /** Sheet name this section came from ("SENIORS" / "JUNIORS "). */
  sheet: string;
  leagueKey: string | null | undefined;
  rows: StructureTeamRow[];
}

function cellText(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return '';
  if (typeof v === 'object' && 'richText' in (v as object))
    return (v as { richText: Array<{ text: string }> }).richText.map((r) => r.text).join('');
  if (typeof v === 'object' && 'result' in (v as object))
    return String((v as { result: unknown }).result ?? '');
  return String(v).trim();
}

/**
 * Grid-scan a SENIORS/JUNIORS-shaped sheet: header rows declare up to 6 (name, VENUE)
 * column pairs side by side; a second header row directly below repeats "VENUE" per
 * pair (carrying an overs figure in the name slot — not real data, skipped); every row
 * after that is data until a fresh header row is hit or the sheet ends. This single scan
 * handles every section on both sheets (SENIORS' 5-, 4- and 1-column-pair blocks;
 * JUNIORS' 6-, 5- and 4-column-pair blocks) with no per-block special-casing, because a
 * header row is identified structurally (a "VENUE" cell in the next column), not by
 * position.
 */
export function parseStructureSheet(ws: ExcelJS.Worksheet): StructureSection[] {
  const sections: StructureSection[] = [];
  /** Live sections, one per (nameCol, venueCol) pair, cleared whenever a new header row
   * is scanned (so a data row after the last real section for a pair is never mis-read
   * as belonging to a stale one). */
  let live: Array<{ nameCol: number; venueCol: number; section: StructureSection }> = [];

  ws.eachRow((row) => {
    const cols: string[] = [''];
    for (let c = 1; c <= ws.columnCount; c++) cols[c] = cellText(row.getCell(c).value);

    const headerPairs: number[] = [];
    for (let c = 1; c < cols.length; c++) {
      if (cols[c] && cols[c + 1]?.toUpperCase() === 'VENUE') headerPairs.push(c);
    }
    if (headerPairs.length > 0) {
      // A header-SHAPED row (name cell + "VENUE" next to it). The SENIORS sheet repeats
      // this shape one row below every real header for an overs sub-header ("50 - OVERS"
      // | "VENUE" | …) that carries no team data — indistinguishable from a real header
      // by shape alone. The real distinguishing signal is whether ANY pair's header text
      // resolves via leagueKeyForSection: a genuine header always has at least one
      // recognised pair; a pure sub-header resolves none. Only replace `live` when at
      // least one pair was recognised — an all-unrecognised header-shaped row (the overs
      // sub-header) is skipped in place, leaving the previous section's `live` entries
      // (and their column positions) intact for the data rows that follow it.
      const next: typeof live = [];
      for (const c of headerPairs) {
        const header = cols[c];
        const leagueKey = leagueKeyForSection(header);
        if (leagueKey === undefined) continue; // not a recognised section header — skip
        const section: StructureSection = { header, sheet: ws.name, leagueKey, rows: [] };
        sections.push(section);
        next.push({ nameCol: c, venueCol: c + 1, section });
      }
      if (next.length > 0) live = next;
      return;
    }

    if (live.length === 0) return;
    for (const { nameCol, venueCol, section } of live) {
      const raw = cols[nameCol];
      if (!raw) continue;
      // A stray punctuation-only artifact (e.g. a lone "`" left in an otherwise blank
      // row) is not a team — skip rather than report as an unresolved token.
      if (/^[`'".,\-–—]+$/.test(raw)) continue;
      section.rows.push({ raw, venue: cols[venueCol] ?? '', club: resolveClubToken(raw) });
    }
  });

  return sections;
}

/** Parse both sheets ("SENIORS", "JUNIORS " — note the trailing space) of the Titans
 * league-structure workbook. Throws if either sheet is missing. */
export function parseStructureWorkbook(wb: ExcelJS.Workbook): StructureSection[] {
  const seniors = wb.worksheets.find((w) => w.name.trim() === 'SENIORS');
  const juniors = wb.worksheets.find((w) => w.name.trim() === 'JUNIORS');
  if (!seniors) throw new Error('sheet "SENIORS" not found in the structure workbook');
  if (!juniors) throw new Error('sheet "JUNIORS " not found in the structure workbook');
  return [...parseStructureSheet(seniors), ...parseStructureSheet(juniors)];
}

/**
 * Per-club rollup used to build Club rows and print the coverage table: every league
 * this club's teams appear in (mapped sections only), team counts per league, and a
 * best-guess "1st team" venue for `Club.ground.venue`.
 *
 * "1st team" heuristic: the first section (SENIORS scanned before JUNIORS, sections in
 * sheet row order) where this club has a team whose token carried NO number (bare name)
 * or number "1" — i.e., the earliest "…1" or unnumbered side found. Falls back to this
 * club's very first appearance anywhere if it never fields a "1"/unnumbered side (should
 * not happen for the men's senior sections, which is all this heuristic is used for).
 */
export interface ClubStructureSummary {
  club: ClubMapEntry;
  /** leagueKey -> team count (mapped sections only). */
  leagueTeamCounts: Map<string, number>;
  /**
   * leagueKey -> the club's sides in that league, in sheet order: the raw side label
   * exactly as the union writes it ("TUKS 2", "PHSOB VETERANS 1", "ADELAAR B") and its
   * venue cell. This is what makes the sheet's per-side venue data land on teamRosters
   * instead of being flattened away into a single count.
   */
  leagueSides: Map<string, Array<{ label: string; venue: string }>>;
  firstTeamVenue: string | undefined;
}

export function summarizeByClub(sections: StructureSection[]): Map<string, ClubStructureSummary> {
  const out = new Map<string, ClubStructureSummary>();
  const get = (c: ClubMapEntry) => {
    let s = out.get(c.id);
    if (!s) {
      s = {
        club: c,
        leagueTeamCounts: new Map(),
        leagueSides: new Map(),
        firstTeamVenue: undefined,
      };
      out.set(c.id, s);
    }
    return s;
  };
  for (const section of sections) {
    if (!section.leagueKey) continue; // unmapped section — reported separately, never written
    for (const row of section.rows) {
      if (!row.club) continue; // unresolved token — reported separately, never silently dropped
      const summary = get(row.club);
      summary.leagueTeamCounts.set(
        section.leagueKey,
        (summary.leagueTeamCounts.get(section.leagueKey) ?? 0) + 1,
      );
      const sides = summary.leagueSides.get(section.leagueKey) ?? [];
      sides.push({ label: row.raw.trim().replace(/\s+/g, ' '), venue: row.venue });
      summary.leagueSides.set(section.leagueKey, sides);
      const suffix = row.raw.trim().match(/(\d+)$/);
      const isFirstSide = !suffix || suffix[1] === '1';
      if (isFirstSide && !summary.firstTeamVenue && row.venue) summary.firstTeamVenue = row.venue;
    }
  }
  // Fallback: any club with team counts but no venue yet (never fielded a "…1"/unnumbered
  // side) takes its very first row's venue instead of staying undefined.
  for (const section of sections) {
    if (!section.leagueKey) continue;
    for (const row of section.rows) {
      if (!row.club) continue;
      const summary = out.get(row.club.id)!;
      if (!summary.firstTeamVenue && row.venue) summary.firstTeamVenue = row.venue;
    }
  }
  return out;
}
