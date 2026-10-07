/**
 * EMCU (Ethekwini Metro Cricket Union) 2026-27 FIXTURES — pure data + pure helpers, NO AWS
 * imports. Consumed by import-emcu-fixtures.ts and bootstrap-emcu-fixture-prereqs.ts; every
 * `--parse-only` path runs under plain `npx tsx` (no `sst shell`, no AWS creds), and these
 * tables are testable in isolation.
 *
 * Source: `Complete EMCU Fixtures 2026-2027 Season.xlsx` — 8 sheets, 11 competitions, 620
 * fixtures. The sheets are a block grammar, not a flat table:
 *
 *   row 1   title banner        "EMCU Division 1 – 2026/27 Fixtures" (merged across A:G)
 *   row 2   sheet note banner   "Sunday fixtures. T20 09:00; 30 Over 08:30. …"
 *   section header (banner)     "T20 – One Round League" | "30 Over – One Round League" |
 *                               "30 Over – Group A (First 7 Listed Teams)" | "… Group B …"
 *   round header                A "Round N Fixtures" · D time · E date · F "Venue:" · G note?
 *   fixture row                 A home · C "v" · E away · F venue
 *
 * Times and dates come from the ROUND HEADER (UTC reads via planb's isoDate/isoTime). Round
 * numbers are sheet-authoritative and preserved as written, even where the sheet repeats or
 * reorders them (D5S1 has R11 between R4/R5, D5S2 has R14 there, D3S2 lists "Round 5" twice).
 *
 * Series names are a FROZEN CONTRACT with the medicoach exporter
 * ("<League> · <Stream>[ · <Group>]" → competition ref `…:competition:<leagueKey>:<stream>`).
 * Do not rename them without changing the exporter's expectations.
 *
 * Team ids: a plain side plays as its clubId; a lettered side ("Simplex … A/B/C") plays as
 * `tm_<clubId>_<leagueKey>_<index>` with A = 0 (club-name-resolve.ts `letteredTeamId`). That is
 * the 0-based convention season-run data and the medicoach map already use; structure intake
 * mints 1-based ids — see docs/runbooks/emcu-fixtures-import.md "tm_ suffix fork".
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isoDate, isoTime } from './import-planb-fixtures.js';
import { letteredTeamId, stripLetterSuffix } from './club-name-resolve.js';
import { groundKey, normaliseName } from './venue-clash.js';
import type { Club, Venue } from './types.js';
import { cellText } from './xlsx-cells.js';

export const EMCU_TENANT = 'dolphins';
/** Every series this importer writes carries this id prefix (`--revert` scope). */
export const EMCU_SERIES_PREFIX = 's-emcu-';
/** The tenant district every EMCU club (and the two new ones) is filed under. */
export const EMCU_DISTRICT = 'Ethekwini Metro Cricket Union';
export const DEFAULT_WORKBOOK = join(
  homedir(),
  'Downloads',
  'Complete EMCU Fixtures 2026-2027 Season.xlsx',
);
/** Provenance written into every fixture's venueReason. */
export const EMCU_SOURCE = 'EMCU 2026-27 fixtures workbook';

/** Season window — a date outside it is a bad read (e.g. a SAST-shifted serial), not data. */
export const SEASON_FROM = '2026-10-01';
export const SEASON_TO = '2027-04-05';

// ───────────────────────── 1. Series manifest ─────────────────────────

export type SectionKind = 't20' | '30ov' | '30ov-a' | '30ov-b';

export interface EmcuSeriesSpec {
  slug: string;
  leagueKey: string;
  /** Frozen display name — the medicoach exporter's competition contract. */
  name: string;
  seriesType: string;
  maxOvers: number;
  /** Verified fixture count — any mismatch aborts. */
  expected: number;
  /** Worksheet name, compared trimmed. */
  sheet: string;
  section: SectionKind;
  /** Every fixture date falls on this weekday (0 = Sunday, 6 = Saturday). */
  weekday: 0 | 6;
  /** Every round header's start time… */
  expectedTime: string;
  /** …except these rounds (round number → time), e.g. Div 2 T20 R10's 13:00 double-header. */
  timeExceptions?: Record<number, string>;
}

const T20 = { seriesType: 'Twenty20 (16-25 overs)', maxOvers: 20 } as const;
const OVERS30 = { seriesType: 'One-Day (40-50 overs)', maxOvers: 30 } as const;

/** The 11 competitions, in write order. Counts verified against the workbook (6 Oct 2026). */
export const EMCU_SERIES: EmcuSeriesSpec[] = [
  {
    slug: 'd1-t20',
    leagueKey: 'emcuD1',
    name: 'EMCU Division 1 · T20',
    expected: 45,
    sheet: 'Fixtures Div 1',
    section: 't20',
    weekday: 0,
    expectedTime: '09:00',
    ...T20,
  },
  {
    slug: 'd1-30ov',
    leagueKey: 'emcuD1',
    name: 'EMCU Division 1 · 30 Over',
    expected: 45,
    sheet: 'Fixtures Div 1',
    section: '30ov',
    weekday: 0,
    expectedTime: '08:30',
    ...OVERS30,
  },
  {
    slug: 'd2-t20',
    leagueKey: 'emcuD2',
    name: 'EMCU Division 2 · T20',
    expected: 91,
    sheet: 'Fixtures Div 2',
    section: 't20',
    weekday: 0,
    expectedTime: '09:00',
    timeExceptions: { 10: '13:00' },
    ...T20,
  },
  {
    slug: 'd2-30ov-a',
    leagueKey: 'emcuD2',
    name: 'EMCU Division 2 · 30 Over · Group A',
    expected: 21,
    sheet: 'Fixtures Div 2',
    section: '30ov-a',
    weekday: 0,
    expectedTime: '08:30',
    ...OVERS30,
  },
  {
    slug: 'd2-30ov-b',
    leagueKey: 'emcuD2',
    name: 'EMCU Division 2 · 30 Over · Group B',
    expected: 21,
    sheet: 'Fixtures Div 2',
    section: '30ov-b',
    weekday: 0,
    expectedTime: '08:30',
    ...OVERS30,
  },
  {
    slug: 'd3-s1-t20',
    leagueKey: 'emcuD3_s1',
    name: 'EMCU Division 3 Stream 1 · T20',
    expected: 105,
    sheet: 'Fixtures Div 3 S1',
    section: 't20',
    weekday: 0,
    expectedTime: '13:00',
    ...T20,
  },
  {
    slug: 'd3-s2-t20',
    leagueKey: 'emcuD3_s2',
    name: 'EMCU Division 3 Stream 2 · T20',
    expected: 56,
    sheet: 'Fixtures Div 3 S2',
    section: 't20',
    weekday: 0,
    expectedTime: '13:00',
    ...T20,
  },
  {
    slug: 'd4-s1-t20',
    leagueKey: 'emcuD4_s1',
    name: 'EMCU Division 4 Stream 1 · T20',
    expected: 72,
    sheet: 'Fixtures Div 4 S1',
    section: 't20',
    weekday: 0,
    expectedTime: '13:00',
    ...T20,
  },
  {
    slug: 'd4-s2-t20',
    leagueKey: 'emcuD4_s2',
    name: 'EMCU Division 4 Stream 2 · T20',
    expected: 56,
    sheet: 'Fixtures Div 4 S2',
    section: 't20',
    weekday: 0,
    expectedTime: '13:00',
    ...T20,
  },
  {
    slug: 'd5-s1-t20',
    leagueKey: 'emcuD5_s1',
    name: 'EMCU Division 5 Stream 1 · T20',
    expected: 66,
    sheet: 'Fixtures Div 5 S1',
    section: 't20',
    weekday: 6,
    expectedTime: '13:00',
    ...T20,
  },
  {
    slug: 'd5-s2-t20',
    leagueKey: 'emcuD5_s2',
    name: 'EMCU Division 5 Stream 2 · T20',
    expected: 42,
    sheet: 'Fixtures Div 5 S2',
    section: 't20',
    weekday: 6,
    expectedTime: '13:00',
    ...T20,
  },
];

export const EXPECTED_TOTAL = 620;
/** Every slug this manifest produces — the `--only` vocabulary and the `--revert` scope. */
export const KNOWN_SLUGS = EMCU_SERIES.map((s) => s.slug);
export const EMCU_SHEETS = [...new Set(EMCU_SERIES.map((s) => s.sheet))];
export const seriesIdFor = (slug: string) => `${EMCU_SERIES_PREFIX}${slug}`;
/** The EMCU league keys (8) — the tenant config must carry each. */
export const EMCU_LEAGUE_KEYS = [...new Set(EMCU_SERIES.map((s) => s.leagueKey))];

/** The stale season-run drafts (3 Oct backfill) this import replaces, and their runs. */
export const EMCU_STALE_SERIES_IDS = [
  's-run-1790350188827-season-g1',
  's-run-1790350188827-season-g2',
  's-run-1790350188827-stg_4ca347b9-g1',
  's-run-1790446110087-season-g1',
  's-run-1790455881102-season-g1',
];
export const EMCU_STALE_RUN_IDS = ['run-1790350188827', 'run-1790446110087', 'run-1790455881102'];

// ───────────────────────── 2. Teams ─────────────────────────

export interface EmcuTeamEntry {
  clubId: string;
  /** Lettered side of a multi-team club ("… A" → index 0). */
  letter?: 'A' | 'B' | 'C';
}

/** Every team string in the workbook (38) → its club. Exact strings; anything else fails. */
export const EMCU_TEAM_MAP: Record<string, EmcuTeamEntry> = {
  'African Warriors CC': { clubId: 'african-warriors-cc' },
  'Amanzimtoti Cricket Club': { clubId: 'amanzimtoti-cricket-club' },
  'Chatsworth United Cricket Club': { clubId: 'chatsworth-united-cricket-club' },
  'Chesterville Cricket Club': { clubId: 'chesterville-cricket-clube' },
  Crusaders: { clubId: 'crusaders' },
  'Delta Cricket Club': { clubId: 'delta-cricket-club' },
  'Dolphins Deaf Cricket Team': { clubId: 'dolphins-deaf-cricket-team' },
  'East Coast CC': { clubId: 'east-coast-cc' },
  'FAM Kwamakhutha': { clubId: 'fam-kwamakhutha' },
  'Forest Hills Cricket Club': { clubId: 'forest-hills-cricket-club' },
  'Harlequins Cricket Club': { clubId: 'harlequins-cricket-club' },
  'Hillary/Malvern Cricket Club': { clubId: 'hillary-malvern-cricket-club' },
  'Hollywoodbets Chatsworth Sporting': { clubId: 'hollywoodbets-chatsworth-sporting' },
  'KwaMashu Cricket Club': { clubId: 'kwamashu-cricket-club' },
  'Lamontville CC': { clubId: 'lamontville-cc' },
  'Lindelani Cricket Club': { clubId: 'lindelani-cricket-club' },
  'Meadowridge Sporting Cricket Club': { clubId: 'meadowridge-sporting-cricket-club' },
  'Merebank Cricket club': { clubId: 'merebank-cricket-club' },
  'Newlands Cricket Club': { clubId: 'newlands-cricket-club' },
  'Ntuzuma Cricket Club': { clubId: 'ntuzuma-cricket-club' },
  'Parkgate Hambanathi CC': { clubId: 'parkgate-hambanathi-cc' },
  'Phoenix Cricket Club': { clubId: 'phoenix-cricket-club' },
  'Pinetown Topham Cricket Club': { clubId: 'ptcc' },
  'Railways Cricket Club': { clubId: 'railways-cricket-club' },
  'Rhythm DHSOB Cricket club': { clubId: 'rhythm-dhsob-cricket-club' },
  'Saints Cricket Club': { clubId: 'saints-cricket-club' },
  'Simplex Reservoir Hills Crimson': { clubId: 'simplex-reservoir-hills-crimson' },
  'Simplex Reservoir Hills Crimson A': { clubId: 'simplex-reservoir-hills-crimson', letter: 'A' },
  'Simplex Reservoir Hills Crimson B': { clubId: 'simplex-reservoir-hills-crimson', letter: 'B' },
  'Simplex Reservoir Hills Crimson C': { clubId: 'simplex-reservoir-hills-crimson', letter: 'C' },
  'Spartan Sporting': { clubId: 'spartan-sporting' },
  'Tongaat Cricket Association': { clubId: 'tongaat-cricket-association' },
  'UKZN CRICKET CLUB': { clubId: 'ukzn-cricket-club' },
  'Umgababa Cricket Club': { clubId: 'umgababa-cricket-club' },
  // Distinct from `umlazi-cricket-club` ("uMlazi cricket club") — the MUT side is a new club.
  'Umlazi CC (MUT)': { clubId: 'umlazi-cc-mut' },
  'uMlazi cricket club': { clubId: 'umlazi-cricket-club' },
  'Verulam Cricket Club': { clubId: 'verulam-cricket-club' },
  'West CC': { clubId: 'west-cc' },
};

export interface EmcuSide {
  raw: string;
  clubId: string;
  /** clubId for a plain side, `tm_<clubId>_<leagueKey>_<0|1|2>` for a lettered one. */
  teamId: string;
  letter?: 'A' | 'B' | 'C';
}

/** A sheet team string → its side in `leagueKey`, or null (unknown string — fail closed). */
export function emcuSide(raw: string, leagueKey: string): EmcuSide | null {
  const e = EMCU_TEAM_MAP[raw];
  if (!e) return null;
  return {
    raw,
    clubId: e.clubId,
    teamId: e.letter ? letteredTeamId(e.clubId, leagueKey, e.letter) : e.clubId,
    ...(e.letter ? { letter: e.letter } : {}),
  };
}

/** Internal consistency: the map's letters agree with the shared suffix rule. */
export function verifyTeamMap(): string[] {
  const problems: string[] = [];
  for (const [raw, e] of Object.entries(EMCU_TEAM_MAP)) {
    const s = stripLetterSuffix(raw);
    if (e.letter && s?.letter !== e.letter)
      problems.push(`"${raw}": map letter ${e.letter}, suffix rule says ${s?.letter ?? 'none'}`);
  }
  return problems;
}

// ───────────────────────── 3. New clubs + venues ─────────────────────────

export interface EmcuNewClub {
  id: string;
  name: string;
}

/** Clubs the workbook names that the tenant does not hold yet (created by the bootstrap). */
export const EMCU_NEW_CLUBS: EmcuNewClub[] = [
  { id: 'dolphins-deaf-cricket-team', name: 'Dolphins Deaf Cricket Team' },
  { id: 'umlazi-cc-mut', name: 'Umlazi CC (MUT)' },
];

/** The skeletal club record the bootstrap writes (district/chair fixed later in the console).
 * No ground: the workbook does not say which ground is home, and guessing one would put it
 * into every clash ledger as the club's implicit venue. */
export function newClubRecord(spec: EmcuNewClub): Club {
  return {
    id: spec.id,
    name: spec.name,
    district: EMCU_DISTRICT,
    sub: '',
    chair: '',
    affiliation: 'not_started',
    cqi: 0,
    docs: {},
    players: 0,
    teams: 1,
    women: 0,
    juniors: 0,
    color: '#0E7C6B',
    ground: {},
    leagues: [],
    version: 1,
  } as unknown as Club;
}

/**
 * Grounds the workbook uses that the registry lacks. homeClubIds = every club that is the
 * HOME side of a workbook fixture at that ground (asserted against the workbook by the tests),
 * so the relocation candidate chain may offer them to those clubs.
 */
export const EMCU_NEW_VENUES: Venue[] = [
  {
    id: 'v-dokkies-primary-school',
    name: 'Dokkies Primary School',
    homeClubIds: [
      'amanzimtoti-cricket-club',
      'chesterville-cricket-clube',
      'hollywoodbets-chatsworth-sporting',
      'newlands-cricket-club',
      'ntuzuma-cricket-club',
      'saints-cricket-club',
      'simplex-reservoir-hills-crimson',
    ],
    surfaces: 1,
  },
  {
    id: 'v-lutherfield',
    name: 'Lutherfield',
    homeClubIds: [
      'harlequins-cricket-club',
      'hillary-malvern-cricket-club',
      'hollywoodbets-chatsworth-sporting',
    ],
    surfaces: 1,
  },
];

// ───────────────────────── 4. Venue aliases ─────────────────────────

/**
 * Workbook ground spelling → the registry venue it names. Spellings that already normalise
 * onto the registry name ("Phoenix Northcroft" = "PHOENIX NORTHCROFT", "Chatsworth Oval" =
 * "CHATSWORTH OVAL") need no entry and are listed only for the record. Most entries
 * duplicate the code-default map (engine venue-aliases.ts); they are merged into the
 * tenant's `competitionDefaults.venueAliases` so the release gate resolves EMCU spellings
 * from tenant data rather than from code defaults that may be emptied.
 */
export const EMCU_VENUE_ALIAS_PAIRS: Array<[sheet: string, registry: string]> = [
  ['Penguin Street (Chatsworth)', 'PENGUIN STREET GROUND'],
  ['Phoenix Sydmore', 'Sidmore'],
  ['Dhubri Road', 'Dhubri road grounds'],
  ['Toti Oval', 'Toti 1'],
  ['Toti Oval 2', 'Toti 2'],
  ['Forest Hill', 'Forest Hills Sports Club'],
  ['Lahee Park 1', 'Lahee park cricket oval'],
  ['Phoenix Northcroft', 'PHOENIX NORTHCROFT'],
  ['Crawford NC', 'Crawford North Coast'],
  ['Hammond (UKZN)', 'Hammond Cricket Oval'],
  ['Kloof Country Club', 'Kloof CC'],
  ['Gledhow', 'Gledhow Cricket Ground'],
  ['Mpumalanga', 'Mpumalanga Township Cricket Stadium'],
  ['Tills', 'Tills Crescent Ground'],
  ['Phoenix Stonebridge', 'Stonebridge'],
];

/** normaliseName(sheet) → normaliseName(registry); identity pairs dropped. */
export const EMCU_VENUE_ALIASES: Record<string, string> = Object.fromEntries(
  EMCU_VENUE_ALIAS_PAIRS.map(([a, b]) => [normaliseName(a), normaliseName(b)] as const).filter(
    ([k, v]) => k !== v,
  ),
);

/** The tenant alias map with the EMCU entries filled in where the tenant has no key (a tenant
 * entry wins, so the importer resolves exactly as the release gate will after bootstrap). */
export function emcuAliases(tenantAliases: Record<string, string>): Record<string, string> {
  return { ...EMCU_VENUE_ALIASES, ...tenantAliases };
}

// ───────────────────────── 5. Workbook grammar ─────────────────────────

/** One worksheet as plain rows: `cells[c]` is column c (1-based), raw exceljs values. */
export interface SheetGrid {
  name: string;
  rows: Array<{ row: number; cells: unknown[] }>;
}

export interface EmcuRawFixture {
  slug: string;
  sheet: string;
  row: number;
  round: number;
  date: string;
  time: string;
  home: string;
  away: string;
  venue: string;
}

export interface RoundNote {
  slug: string;
  sheet: string;
  row: number;
  round: number;
  date: string;
  note: string;
}

export interface ParsedEmcuWorkbook {
  fixtures: EmcuRawFixture[];
  /** Column-G notes on round headers (e.g. the Div 2 30-over R7 Easter "TO MOVE" note). */
  roundNotes: RoundNote[];
  /** Section → the teams appearing in it (drives the group-split assert). */
  sectionTeams: Map<string, Set<string>>;
  errors: string[];
  warnings: string[];
}

// Cell text lives in xlsx-cells.ts (shared with the reminder and umpire importers).
export { cellText };

/** A banner/section header's text → the section it opens, or null. */
export function classifySectionHeader(text: string): SectionKind | null {
  const t = text.trim();
  if (/^T20\s*[–—-]/i.test(t)) return 't20';
  const g = t.match(/^30\s*Over\s*[–—-]\s*Group\s+([AB])\b/i);
  if (g) return g[1].toUpperCase() === 'A' ? '30ov-a' : '30ov-b';
  if (/^30\s*Over\s*[–—-]/i.test(t)) return '30ov';
  return null;
}

export type RowClass =
  | { kind: 'blank' }
  | { kind: 'banner'; text: string }
  | { kind: 'section'; section: SectionKind; text: string }
  | { kind: 'round'; round: number; time: string | null; date: string | null; note: string }
  | { kind: 'fixture'; home: string; away: string; venue: string }
  | { kind: 'unknown'; why: string };

/**
 * Classify one row. A merged banner repeats its text across A:G, so "A non-empty and every
 * other non-empty cell equal to it" is a banner; a section banner is one whose text is a
 * section header. Round headers and fixture rows are recognised by their fixed columns.
 */
export function classifyRow(cells: unknown[]): RowClass {
  const text = (c: number) => cellText(cells[c]);
  const nonEmpty: number[] = [];
  for (let c = 1; c < cells.length; c++) if (cells[c] != null && text(c) !== '') nonEmpty.push(c);
  // Date cells read as '' through cellText — count them separately.
  const hasDate = cells.some((v) => v instanceof Date);
  if (!nonEmpty.length && !hasDate) return { kind: 'blank' };
  const a = text(1);
  const round = a.match(/^Round\s+(\d+)\s+Fixtures$/i);
  if (round) {
    return {
      kind: 'round',
      round: Number(round[1]),
      time: isoTime(cells[4]),
      date: isoDate(cells[5]),
      note: text(7),
    };
  }
  if (a && !hasDate && nonEmpty.every((c) => text(c) === a)) {
    const section = classifySectionHeader(a);
    return section ? { kind: 'section', section, text: a } : { kind: 'banner', text: a };
  }
  if (text(3).toLowerCase() === 'v') {
    const stray = nonEmpty.filter((c) => ![1, 3, 5, 6].includes(c));
    if (stray.length) return { kind: 'unknown', why: `stray value(s) in column(s) ${stray}` };
    return { kind: 'fixture', home: a, away: text(5), venue: text(6) };
  }
  return { kind: 'unknown', why: `unrecognised row: ${nonEmpty.map((c) => text(c)).join(' | ')}` };
}

const WEEKDAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Parse every manifest sheet. Fail-closed: a missing sheet, an unknown section, a fixture row
 * outside a round, an unparseable header, a time/weekday/window miss, an unknown team, a team
 * twice in one round, a team crossing the two 30-over groups, or a count off the manifest
 * lands in `errors`. Non-fatal oddities (repeated/out-of-order round labels) are `warnings`.
 */
export function parseEmcuWorkbook(grids: SheetGrid[]): ParsedEmcuWorkbook {
  const out: ParsedEmcuWorkbook = {
    fixtures: [],
    roundNotes: [],
    sectionTeams: new Map(),
    errors: [],
    warnings: [],
  };
  for (const sheet of EMCU_SHEETS) {
    const grid = grids.find((g) => g.name.trim() === sheet);
    if (!grid) {
      out.errors.push(
        `sheet "${sheet}" not found (have: ${grids.map((g) => `"${g.name}"`).join(', ')})`,
      );
      continue;
    }
    const specs = EMCU_SERIES.filter((s) => s.sheet === sheet);
    let spec: EmcuSeriesSpec | null = null;
    let round: {
      round: number;
      time: string;
      date: string;
      row: number;
      teams: Set<string>;
    } | null = null;
    const seenRounds = new Map<string, number[]>();
    const seenSections = new Set<SectionKind>();
    for (const { row, cells } of grid.rows) {
      const where = `${sheet} row ${row}`;
      const rc = classifyRow(cells);
      switch (rc.kind) {
        case 'blank':
          break;
        case 'banner':
          // Title + sheet-note banners sit above the first section only.
          if (spec)
            out.errors.push(`${where}: unexpected banner "${rc.text}" inside a fixture section`);
          else if (row > 3) out.errors.push(`${where}: unexpected banner "${rc.text}"`);
          break;
        case 'section': {
          const next = specs.find((s) => s.section === rc.section);
          if (!next) {
            out.errors.push(`${where}: section "${rc.text}" has no manifest series on ${sheet}`);
            spec = null;
          } else if (seenSections.has(rc.section)) {
            out.errors.push(`${where}: section "${rc.text}" appears twice`);
            spec = null;
          } else {
            spec = next;
            seenSections.add(rc.section);
          }
          round = null;
          break;
        }
        case 'round': {
          if (!spec) {
            out.errors.push(`${where}: round header outside a known section`);
            round = null;
            break;
          }
          const problems: string[] = [];
          if (!rc.date) problems.push('no date');
          if (!rc.time) problems.push('no time');
          if (problems.length) {
            out.errors.push(`${where}: Round ${rc.round} header has ${problems.join(', ')}`);
            round = null;
            break;
          }
          const want = spec.timeExceptions?.[rc.round] ?? spec.expectedTime;
          if (rc.time !== want)
            out.errors.push(
              `${where}: ${spec.name} Round ${rc.round} starts ${rc.time}, expected ${want}`,
            );
          if (rc.date! < SEASON_FROM || rc.date! > SEASON_TO)
            out.errors.push(
              `${where}: date ${rc.date} outside the ${SEASON_FROM}..${SEASON_TO} season`,
            );
          if (new Date(`${rc.date}T00:00:00Z`).getUTCDay() !== spec.weekday)
            out.errors.push(
              `${where}: ${rc.date} is not a ${WEEKDAY_NAME[spec.weekday]} (${spec.name})`,
            );
          const labels = seenRounds.get(spec.slug) ?? [];
          if (labels.includes(rc.round))
            out.warnings.push(
              `${where}: ${spec.name} lists "Round ${rc.round}" again (${rc.date}) — kept as sheeted`,
            );
          else if (labels.length && rc.round < labels[labels.length - 1])
            out.warnings.push(
              `${where}: ${spec.name} Round ${rc.round} (${rc.date}) follows Round ${labels[labels.length - 1]} — sheet order kept`,
            );
          labels.push(rc.round);
          seenRounds.set(spec.slug, labels);
          if (rc.note)
            out.roundNotes.push({
              slug: spec.slug,
              sheet,
              row,
              round: rc.round,
              date: rc.date!,
              note: rc.note,
            });
          round = { round: rc.round, time: rc.time!, date: rc.date!, row, teams: new Set() };
          break;
        }
        case 'fixture': {
          if (!spec || !round) {
            out.errors.push(`${where}: fixture row outside a round ("${rc.home}" v "${rc.away}")`);
            break;
          }
          const problems: string[] = [];
          if (!rc.home) problems.push('blank home');
          if (!rc.away) problems.push('blank away');
          if (!rc.venue) problems.push('blank venue');
          for (const t of [rc.home, rc.away])
            if (t && !EMCU_TEAM_MAP[t]) problems.push(`unknown team "${t}"`);
          if (rc.home && rc.home === rc.away) problems.push(`"${rc.home}" plays itself`);
          for (const t of [rc.home, rc.away]) {
            if (!t) continue;
            if (round.teams.has(t)) problems.push(`"${t}" plays twice in Round ${round.round}`);
            round.teams.add(t);
          }
          if (problems.length) {
            out.errors.push(`${where}: ${problems.join('; ')}`);
            break;
          }
          const teams = out.sectionTeams.get(spec.slug) ?? new Set<string>();
          teams.add(rc.home);
          teams.add(rc.away);
          out.sectionTeams.set(spec.slug, teams);
          out.fixtures.push({
            slug: spec.slug,
            sheet,
            row,
            round: round.round,
            date: round.date,
            time: round.time,
            home: rc.home,
            away: rc.away,
            venue: rc.venue,
          });
          break;
        }
        case 'unknown':
          out.errors.push(`${where}: ${rc.why}`);
          break;
      }
    }
    for (const s of specs)
      if (!seenSections.has(s.section))
        out.errors.push(`${sheet}: no "${s.section}" section for ${s.name}`);
  }
  // Counts.
  for (const s of EMCU_SERIES) {
    const n = out.fixtures.filter((f) => f.slug === s.slug).length;
    if (n !== s.expected)
      out.errors.push(`${s.name}: ${n} fixtures parsed, expected ${s.expected}`);
  }
  if (!out.errors.length && out.fixtures.length !== EXPECTED_TOTAL)
    out.errors.push(`${out.fixtures.length} fixtures parsed, expected ${EXPECTED_TOTAL}`);
  // Explicit 30-over groups: disjoint, seven each.
  const ga = out.sectionTeams.get('d2-30ov-a') ?? new Set<string>();
  const gb = out.sectionTeams.get('d2-30ov-b') ?? new Set<string>();
  for (const t of ga)
    if (gb.has(t))
      out.errors.push(`"${t}" appears in both Div 2 30-over groups — groups must be disjoint`);
  for (const [label, g] of [
    ['A', ga],
    ['B', gb],
  ] as const)
    if (g.size && g.size !== 7)
      out.errors.push(`Div 2 30-over Group ${label} has ${g.size} teams, expected 7`);
  return out;
}

// ───────────────────────── 6. Checks used by the union report ─────────────────────────

/**
 * Div 1 sheet rule: "Premier Reserve matches use only a listed Premier facility of one of the
 * two teams". Warn-only: a Div 1 fixture whose ground is neither club's registered facility
 * (registry homeClubIds, or the club record's ground/secondary ground).
 */
export function premierReserveWarnings(
  fixtures: EmcuRawFixture[],
  clubs: Club[],
  venues: Venue[],
  aliases: Record<string, string>,
): string[] {
  const clubsById = new Map(clubs.map((c) => [c.id, c]));
  const byKey = new Map(venues.map((v) => [groundKey(v.name, aliases), v]));
  const out: string[] = [];
  for (const f of fixtures.filter((x) => x.slug.startsWith('d1-'))) {
    const gk = groundKey(f.venue, aliases);
    const v = byKey.get(gk);
    const sides = [f.home, f.away].map((t) => EMCU_TEAM_MAP[t]?.clubId).filter(Boolean);
    const listed = sides.some((cid) => {
      if (v?.homeClubIds?.includes(cid!)) return true;
      const g = clubsById.get(cid!)?.ground;
      return [g?.venue, g?.secondaryVenue].some((x) => x && groundKey(x, aliases) === gk);
    });
    if (!listed)
      out.push(
        `${f.date} ${f.time} ${f.home} v ${f.away} @ ${f.venue} — not a listed facility of either team`,
      );
  }
  return out;
}

/** Home clubs per workbook ground (for EMCU_NEW_VENUES homeClubIds). */
export function homeClubsAt(fixtures: EmcuRawFixture[], venue: string): string[] {
  const ids = new Set<string>();
  for (const f of fixtures)
    if (f.venue === venue && EMCU_TEAM_MAP[f.home]) ids.add(EMCU_TEAM_MAP[f.home].clubId);
  return [...ids].sort();
}
