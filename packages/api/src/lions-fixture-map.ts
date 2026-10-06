/**
 * Lions (Central Gauteng Lions / CGL) 2026-27 FIXTURES — pure data + pure helpers, NO AWS
 * imports. Consumed by import-lions-fixtures.ts and bootstrap-lions-fixture-prereqs.ts; every
 * `--parse-only` path must run under plain `npx tsx` (no `sst shell`, no AWS creds), and these
 * tables must be testable in isolation.
 *
 * Four sections:
 *   1. LEAGUES + SHEET MANIFEST — the 13 populated sheets of the converted league workbook →
 *      `s-lions-*` series, each with its VERIFIED fixture count (Phase 0 fidelity report,
 *      2 Oct 2026). A count mismatch aborts the import.
 *   2. TEAM RESOLUTION — every raw team name resolves through lions-import-map.ts's
 *      `resolveClubName` (exact, fail-closed). NEVER through import-planb-fixtures.ts's
 *      dolphins NAME_ALIASES/NAME_REDIRECTS: that is why the lions importer builds its own
 *      Series objects instead of calling planb's `buildSeries`. A digit suffix ("Delfos 1",
 *      "Delfos 2") is a second team of one club and becomes a planb-convention synthesised
 *      team id `tm_<clubId>_<leagueKey>_<n-1>`.
 *   3. T20 TRANSCRIPTION — the five T20 PDFs hand-transcribed into typed tables (pool rounds
 *      only — the Ladies semis/final rows name no teams yet, amendment 3), with mechanical
 *      verification (`verifyT20Pools`): per-PDF counts, each team at most once per date/time
 *      slot, and complete round-robins within every pool (amendment 7).
 *   4. VENUES — LIONS_VENUES (canonical ground names + every spelling seen in the fixtures
 *      workbook, both grounds sheets, the T20 PDFs and the affiliation form) → the explicit
 *      LIONS_VENUE_ALIASES map passed to venue-clash.ts's `groundKey` (never the dolphins
 *      default table), plus the grounds-sheet parser and the venue-registry builder shared by
 *      the prereqs bootstrap and the importer's parse-mode clash scan.
 */
import type ExcelJS from 'exceljs';
import { normaliseName, groundKey, JUNK_GROUND } from './venue-clash.js';
import { resolveClubName, NON_CLUB_FIXTURE_NAME, type ClubMapEntry } from './lions-import-map.js';
import type { AffiliationRecord } from './lions-affiliation-parse.js';
import type { Venue } from './types.js';

export const LIONS_TENANT = 'lions';
/** Every series this importer writes carries this id prefix (`--revert` scope). */
export const LIONS_SERIES_PREFIX = 's-lions-';

// ───────────────────────── 1. Leagues + sheet manifest ─────────────────────────

export interface LionsLeague {
  key: string;
  label: string;
  /** Console grouping. */
  group: string;
  /** A cup run beside the leagues, not an affiliation pick (League.fixturesOnly). */
  fixturesOnly?: boolean;
}

const SUN_MEN = 'Senior Men (Sunday)';
const SAT_MEN = 'Senior Men (Saturday)';

/** The league catalogue the prereqs bootstrap creates (13 sheet leagues + 2 T20 comps).
 * Keys match AFFILIATION_LEAGUE_KEYS in lions-import-map.ts. All are union-wide
 * ('All districts'). */
export const LIONS_LEAGUES: LionsLeague[] = [
  { key: 'premier-a', label: 'Premier A', group: SUN_MEN },
  { key: 'premier-b', label: 'Premier B', group: SUN_MEN },
  { key: 'presidents-a', label: 'Presidents A', group: SUN_MEN },
  { key: 'presidents-b', label: 'Presidents B', group: SUN_MEN },
  { key: 'sunday-1', label: 'Sunday 1', group: SUN_MEN },
  { key: 'sunday-2', label: 'Sunday 2', group: SUN_MEN },
  { key: 'sunday-3', label: 'Sunday 3', group: SUN_MEN },
  { key: 'sunday-4', label: 'Sunday 4', group: SUN_MEN },
  { key: 'sunday-5', label: 'Sunday 5', group: SUN_MEN },
  { key: 'saturday-1', label: 'Saturday 1', group: SAT_MEN },
  { key: 'saturday-2', label: 'Saturday 2', group: SAT_MEN },
  { key: 'saturday-3', label: 'Saturday 3', group: SAT_MEN },
  { key: 'vets-sa-1', label: 'Vets Saturday 1', group: 'Veterans' },
  {
    key: 'hwb-premier-t20',
    label: 'Hollywoodbets Premier T20',
    group: 'T20 Cups',
    fixturesOnly: true,
  },
  {
    key: 'ladies-premier-t20',
    label: 'Hollywoodbets Ladies Premier T20',
    group: 'T20 Cups',
    fixturesOnly: true,
  },
];

export interface LionsSeriesSpec {
  slug: string;
  leagueKey: string;
  /** Second half of the series name (`<league label> · <label>`). */
  label: string;
  seriesType: string;
  maxOvers: number;
  /** Verified real-fixture count — any mismatch aborts. */
  expected: number;
}

export interface LionsSheetSpec extends LionsSeriesSpec {
  /** Worksheet name, compared trimmed. */
  sheet: string;
  /** "Macrocomm Round N" placeholder rows the sheet must carry (skipped, counted). */
  macrocommRows: number;
  /** Every fixture in the sheet starts at this time (UTC read; a SAST-shifted read fails it). */
  expectedTime: string;
  /** Every fixture date falls on this weekday (0 = Sunday, 6 = Saturday). */
  weekday: 0 | 6;
}

// The workbook states no match format. Sunday 09:00 sheets are recorded as one-day
// 50-over and the Saturday/Vets 13:00 sheets as one-day 40-over until CGL confirms —
// display metadata only, nothing schedules or clash-checks off it.
const SUNDAY_OD = { seriesType: 'One-Day (40-50 overs)', maxOvers: 50 } as const;
const SATURDAY_OD = { seriesType: 'One-Day (40-50 overs)', maxOvers: 40 } as const;
const SUN = { macrocommRows: 0, expectedTime: '09:00', weekday: 0 as const, ...SUNDAY_OD };
const SAT = { expectedTime: '13:00', weekday: 6 as const, ...SATURDAY_OD };

/** The 13 populated sheets of `Final Fixtures 2026-2027.xlsx` (Sunday 6 / U15 hold "Not done",
 * Saturday 4 / 5 are empty — out of scope and ignored). Counts from the fidelity report. */
export const LEAGUE_SHEETS: LionsSheetSpec[] = [
  {
    sheet: 'Premier A',
    slug: 'premier-a',
    leagueKey: 'premier-a',
    label: 'League',
    expected: 132,
    ...SUN,
  },
  {
    sheet: 'Premier B',
    slug: 'premier-b',
    leagueKey: 'premier-b',
    label: 'League',
    expected: 132,
    ...SUN,
  },
  {
    sheet: 'Presidents A',
    slug: 'presidents-a',
    leagueKey: 'presidents-a',
    label: 'League',
    expected: 132,
    ...SUN,
  },
  {
    sheet: 'Presidents B',
    slug: 'presidents-b',
    leagueKey: 'presidents-b',
    label: 'League',
    expected: 132,
    ...SUN,
  },
  {
    sheet: 'Sunday 1',
    slug: 'sunday-1',
    leagueKey: 'sunday-1',
    label: 'League',
    expected: 132,
    ...SUN,
  },
  {
    sheet: 'Sunday 2',
    slug: 'sunday-2',
    leagueKey: 'sunday-2',
    label: 'League',
    expected: 131,
    ...SUN,
  },
  {
    sheet: 'Sunday 3',
    slug: 'sunday-3',
    leagueKey: 'sunday-3',
    label: 'League',
    expected: 132,
    ...SUN,
  },
  {
    sheet: 'Sunday 4',
    slug: 'sunday-4',
    leagueKey: 'sunday-4',
    label: 'League',
    expected: 132,
    ...SUN,
  },
  {
    sheet: 'Sunday 5',
    slug: 'sunday-5',
    leagueKey: 'sunday-5',
    label: 'League',
    expected: 132,
    ...SUN,
  },
  {
    sheet: 'Saturday 1',
    slug: 'saturday-1',
    leagueKey: 'saturday-1',
    label: 'League',
    expected: 90,
    macrocommRows: 4,
    ...SAT,
  },
  {
    sheet: 'Saturday 2',
    slug: 'saturday-2',
    leagueKey: 'saturday-2',
    label: 'League',
    expected: 90,
    macrocommRows: 4,
    ...SAT,
  },
  {
    sheet: 'Saturday 3',
    slug: 'saturday-3',
    leagueKey: 'saturday-3',
    label: 'League',
    expected: 90,
    macrocommRows: 4,
    ...SAT,
  },
  {
    sheet: 'Vets SA 1',
    slug: 'vets-sa-1',
    leagueKey: 'vets-sa-1',
    label: 'League',
    expected: 56,
    macrocommRows: 0,
    ...SAT,
  },
];

/** 1,513 real league fixtures (+ 12 Macrocomm placeholders = the 1,525 rows). */
export const EXPECTED_LEAGUE_FIXTURES = 1513;

/** A "Macrocomm Round N" placeholder: label in Home, Away + Venue empty. Exact pattern only. */
export function isMacrocommRow(home: string, away: string, venue: string): boolean {
  return NON_CLUB_FIXTURE_NAME.test(home.trim()) && !away.trim() && !venue.trim();
}

// ───────────────────────── 2. Team resolution ─────────────────────────

export const TEAM_ID_PREFIX = 'tm_';

export interface ResolvedTeam {
  raw: string;
  club: ClubMapEntry;
  /** Participant id: the clubId for a club's only side, else `tm_<clubId>_<leagueKey>_<n>`. */
  teamId: string;
  /** Display-name suffix for a multi-side club ("1", "2", "(Premier A)"), '' otherwise. */
  sideLabel: string;
}

/** Synthesised team id — mirrors planb's `tm_<clubId>_<leagueKey>_<index>` (src/leagues.ts
 * clubTeamsForLeague), so a later admin roster converges onto the same ids. */
export function sideTeamId(clubId: string, leagueKey: string, index: number): string {
  return `${TEAM_ID_PREFIX}${clubId}_${leagueKey}_${index}`;
}

/**
 * A raw sheet name → its club + participant id, or null (fail closed). A trailing single
 * digit on a name whose BASE is a known club ("Delfos 1") is that club's n-th side; the digit
 * is tried first so "Delfos 1" never collapses onto plain Delfos through its CLUB_MAP alias.
 */
export function resolveTeam(raw: string, leagueKey: string): ResolvedTeam | null {
  const m = raw.trim().match(/^(.*\S)\s+([1-9])$/);
  if (m) {
    const base = resolveClubName(m[1]);
    if (base) {
      const n = Number(m[2]);
      return { raw, club: base, teamId: sideTeamId(base.id, leagueKey, n - 1), sideLabel: m[2] };
    }
  }
  const club = resolveClubName(raw);
  return club ? { raw, club, teamId: club.id, sideLabel: '' } : null;
}

// ───────────────────────── 3. T20 transcription ─────────────────────────

/** The five PDFs (all in /Users/carlton/Downloads/Lions), with their pool-fixture counts. */
export const T20_SOURCES = {
  'hwb-2026-09-20': {
    file: 'Premier T20 Fixtures 2026-2027 - Venue Changes 20-09-2026.pdf',
    expected: 24,
  },
  'hwb-2026-09-27': { file: 'HWB Premier T20 Venue Changes 27-09-2026 2.0.pdf', expected: 22 },
  'hwb-2026-10-03': {
    file: 'HWB Premier T20 Venue Changes 03-04 October 2026.pdf',
    expected: 14,
  },
  'ladies-group-a': { file: 'Ladies Premier T20 Group A.pdf', expected: 6 },
  'ladies-group-b': { file: 'Ladies Premier T20 Group B.pdf', expected: 6 },
} as const;
export type T20SourceKey = keyof typeof T20_SOURCES;

export interface T20Fixture {
  source: T20SourceKey;
  round: number;
  date: string;
  time: string;
  home: string;
  away: string;
  /** Exactly as printed; null where the PDF says TBC (imported venue-less, scan-excluded). */
  venue: string | null;
}

export interface T20Pool extends LionsSeriesSpec {
  /** HWB only: which league division the pool belongs to — a club entered in BOTH Premier A
   * and Premier B fields two sides in hwb-premier-t20 (see t20SideFor). */
  division?: 'Premier A' | 'Premier B';
  /** The pool's teams as the PDF lists them (verification roster). */
  teams: string[];
  fixtures: T20Fixture[];
}

const T20 = { seriesType: 'Twenty20 (16-25 overs)', maxOvers: 20 } as const;

/** Compact fixture-row builder: [home, away, venue|null]. */
function rows(
  source: T20SourceKey,
  round: number,
  date: string,
  time: string,
  list: Array<[string, string, string | null]>,
): T20Fixture[] {
  return list.map(([home, away, venue]) => ({ source, round, date, time, home, away, venue }));
}

const S20 = 'hwb-2026-09-20' as const;
const S27 = 'hwb-2026-09-27' as const;
const S03 = 'hwb-2026-10-03' as const;

/**
 * Hollywoodbets Premier T20 — 4 pools of 6 (15 games each), three rounds: 20 Sep, 27 Sep and
 * 3–4 Oct 2026. The venue-change PDFs are CGL's authoritative reissues. Transcribed 2 Oct 2026
 * and re-read against the PDFs (independent read-back, amendment 7).
 */
export const HWB_POOLS: T20Pool[] = [
  {
    slug: 'hwb-premier-t20-a-group-a',
    leagueKey: 'hwb-premier-t20',
    label: 'Premier A · Group A',
    division: 'Premier A',
    expected: 15,
    ...T20,
    teams: ['G&M Old Edwardians', 'Jeppe', 'Delfos', 'Old Parks', 'UJ', 'Wanderers'],
    fixtures: [
      ...rows(S20, 1, '2026-09-20', '09:00', [
        ['G&M Old Edwardians', 'Jeppe', 'UJ Main'],
        ['Delfos', 'Old Parks', 'Wanderers Bottom'],
        ['UJ', 'Wanderers', 'Alan Lawson'],
      ]),
      ...rows(S20, 1, '2026-09-20', '13:30', [
        ['Wanderers', 'Delfos', 'UJ Main'],
        ['UJ', 'G&M Old Edwardians', 'Wanderers Bottom'],
        ['Jeppe', 'Old Parks', 'Alan Lawson'],
      ]),
      ...rows(S27, 2, '2026-09-27', '09:00', [
        ['UJ', 'Delfos', 'Jeppe Quondam'],
        ['Old Parks', 'G&M Old Edwardians', 'UJ Main'],
        ['Jeppe', 'Wanderers', 'Alan Lawson'],
      ]),
      ...rows(S27, 2, '2026-09-27', '13:30', [
        ['Wanderers', 'G&M Old Edwardians', 'Jeppe Quondam'],
        ['Delfos', 'Jeppe', 'UJ Main'],
        ['Old Parks', 'UJ', 'Alan Lawson'],
      ]),
      ...rows(S03, 3, '2026-10-04', '09:00', [
        ['UJ', 'Jeppe', 'Alan Lawson'],
        ['G&M Old Edwardians', 'Delfos', 'Wanderers Bottom'],
        ['Wanderers', 'Old Parks', 'UJ Main'],
      ]),
    ],
  },
  {
    slug: 'hwb-premier-t20-a-group-b',
    leagueKey: 'hwb-premier-t20',
    label: 'Premier A · Group B',
    division: 'Premier A',
    expected: 15,
    ...T20,
    teams: [
      'Khosa',
      'Pirates',
      'Lenasia',
      'Marks Park Thistles',
      'Soweto Pioneers',
      'Wits University',
    ],
    fixtures: [
      ...rows(S20, 1, '2026-09-20', '09:00', [
        ['Khosa', 'Pirates', 'Delfos Main'],
        ['Lenasia', 'Marks Park Thistles', 'Walter Milton A'],
        ['Soweto Pioneers', 'Wits University', 'Jeppe Quondam'],
      ]),
      ...rows(S20, 1, '2026-09-20', '13:30', [
        ['Wits University', 'Marks Park Thistles', 'Jeppe Quondam'],
        ['Khosa', 'Soweto Pioneers', 'Delfos Main'],
        ['Pirates', 'Lenasia', 'Walter Milton A'],
      ]),
      ...rows(S27, 2, '2026-09-27', '09:00', [
        ['Marks Park Thistles', 'Khosa', 'Walter Milton A'],
        ['Lenasia', 'Wits University', 'Khosa Main'],
      ]),
      ...rows(S27, 2, '2026-09-27', '13:30', [
        ['Lenasia', 'Khosa', 'Walter Milton A'],
        ['Pirates', 'Wits University', 'Khosa Main'],
      ]),
      // Saturday 3 Oct 13:30 — the PDF prints the venue as TBC.
      ...rows(S03, 3, '2026-10-03', '13:30', [['Soweto Pioneers', 'Marks Park Thistles', null]]),
      ...rows(S03, 3, '2026-10-04', '09:00', [
        ['Khosa', 'Wits University', 'Marks Park Main'],
        ['Pirates', 'Marks Park Thistles', 'Walter Milton A'],
        ['Lenasia', 'Soweto Pioneers', 'Sir Lionel Phillips A'],
      ]),
      ...rows(S03, 3, '2026-10-04', '13:30', [['Soweto Pioneers', 'Pirates', 'Walter Milton A']]),
    ],
  },
  {
    slug: 'hwb-premier-t20-b-group-a',
    leagueKey: 'hwb-premier-t20',
    label: 'Premier B · Group A',
    division: 'Premier B',
    expected: 15,
    ...T20,
    teams: ['Roshnee', 'Randfontein', 'Randburg', 'G&M Old Edwardians', 'Vereeniging', 'UJ'],
    fixtures: [
      ...rows(S20, 1, '2026-09-20', '09:00', [
        ['Roshnee', 'Randfontein', 'Hope Village'],
        ['Randburg', 'G&M Old Edwardians', 'UJ Orban'],
        ['Vereeniging', 'UJ', 'Lenasia'],
      ]),
      ...rows(S20, 1, '2026-09-20', '13:30', [
        ['Randburg', 'Roshnee', 'UJ Orban'],
        ['Randfontein', 'UJ', 'Hope Village'],
        ['G&M Old Edwardians', 'Vereeniging', 'lenasia'],
      ]),
      ...rows(S27, 2, '2026-09-27', '09:00', [
        ['UJ', 'Roshnee', 'Trezona Park'],
        ['G&M Old Edwardians', 'Randfontein', 'Delfos Main'],
        ['Randburg', 'Vereeniging', 'UJ Orban'],
      ]),
      ...rows(S27, 2, '2026-09-27', '13:30', [
        ['Randfontein', 'Vereeniging', 'Trezona Park'],
        ['Randburg', 'UJ', 'Delfos Main'],
        ['Roshnee', 'G&M Old Edwardians', 'UJ Orban'],
      ]),
      ...rows(S03, 3, '2026-10-04', '09:00', [
        ['G&M Old Edwardians', 'UJ', 'Randburg A'],
        ['Roshnee', 'Vereeniging', 'Lenasia stadium'],
        ['Randfontein', 'Randburg', 'UJ Orban'],
      ]),
    ],
  },
  {
    slug: 'hwb-premier-t20-b-group-b',
    leagueKey: 'hwb-premier-t20',
    label: 'Premier B · Group B',
    division: 'Premier B',
    expected: 15,
    ...T20,
    teams: ['Old Parktonians', 'Jeppe', 'Lenasia', 'Joburg', 'Kagiso', 'Khosa'],
    fixtures: [
      ...rows(S20, 1, '2026-09-20', '09:00', [
        ['Old Parktonians', 'Jeppe', 'Puntans'],
        ['Lenasia', 'Joburg', 'Trezona Park'],
        ['Kagiso', 'Khosa', 'Randburg A'],
      ]),
      ...rows(S20, 1, '2026-09-20', '13:30', [
        ['Khosa', 'Lenasia', 'Trezona Park'],
        ['Kagiso', 'Jeppe', 'Randburg A'],
        ['Old Parktonians', 'Joburg', 'Puntans'],
      ]),
      ...rows(S27, 2, '2026-09-27', '09:00', [
        ['Joburg', 'Khosa', 'Walter Milton B'],
        ['Old Parktonians', 'Kagiso', 'Hope Village'],
        ['Jeppe', 'Lenasia', 'Puntans'],
      ]),
      ...rows(S27, 2, '2026-09-27', '13:30', [
        ['Kagiso', 'Lenasia', 'Hope Village'],
        ['Joburg', 'Jeppe', 'Walter Milton B'],
        ['Old Parktonians', 'Khosa', 'Puntans'],
      ]),
      ...rows(S03, 3, '2026-10-04', '09:00', [
        ['Old Parktonians', 'Lenasia', 'Jeppe Quondam'],
        ['Jeppe', 'Khosa', 'Hope Village'],
        ['Kagiso', 'Joburg', 'Khosa Main'],
      ]),
    ],
  },
];

const LA = 'ladies-group-a' as const;
const LB = 'ladies-group-b' as const;

/**
 * Hollywoodbets Ladies Premier T20 — two pools of 4 (6 games each), 3 + 10 Oct 2026. POOL
 * ROUNDS ONLY: the PDFs' 10 Oct 14:00 "Semi 1 / Semi 2" rows ("Group A winner vs Group B
 * Runner Up", venue TBC) name no teams and are deliberately NOT transcribed (amendment 3) —
 * they are added by a follow-up `--only` pass once CGL names the qualifiers.
 */
export const LADIES_POOLS: T20Pool[] = [
  {
    slug: 'ladies-premier-t20-group-a',
    leagueKey: 'ladies-premier-t20',
    label: 'Group A',
    expected: 6,
    ...T20,
    teams: ['Wanderers CC', 'Jeppe CC', 'PAV Soweto', 'Joburg CC'],
    fixtures: [
      ...rows(LA, 1, '2026-10-03', '09:00', [
        ['Wanderers CC', 'Jeppe CC', 'Jeppe Quondam'],
        ['Joburg CC', 'PAV Soweto CC', 'Wanderers Top'],
      ]),
      ...rows(LA, 1, '2026-10-03', '13:30', [
        ['Jeppe CC', 'Joburg CC', 'Wanderers Top'],
        ['PAV Soweto CC', 'Wanderers CC', 'Jeppe Quondam'],
      ]),
      ...rows(LA, 2, '2026-10-10', '09:00', [
        ['Joburg CC', 'Wanderers CC', 'Jeppe Quondam'],
        ['Jeppe CC', 'PAV Soweto CC', 'Hope Village'],
      ]),
    ],
  },
  {
    slug: 'ladies-premier-t20-group-b',
    leagueKey: 'ladies-premier-t20',
    label: 'Group B',
    expected: 6,
    ...T20,
    teams: ['Randburg CC', 'UJ CC', 'Old Eds CC', 'Delfos CC'],
    fixtures: [
      ...rows(LB, 1, '2026-10-03', '09:00', [
        ['Randburg CC', 'UJ CC', 'Sullivan'],
        ['Delfos CC', 'Old Eds CC', 'UJ Orban'],
      ]),
      ...rows(LB, 1, '2026-10-03', '13:30', [
        ['UJ CC', 'Delfos CC', 'Sullivan'],
        ['Old Eds CC', 'Randburg CC', 'UJ Orban'],
      ]),
      ...rows(LB, 2, '2026-10-10', '09:00', [
        ['Delfos CC', 'Randburg CC', 'UJ Orban'],
        ['UJ CC', 'Old Eds CC', 'Sullivan'],
      ]),
    ],
  },
];

export const T20_POOLS: T20Pool[] = [...HWB_POOLS, ...LADIES_POOLS];

/**
 * hwb-premier-t20 groups BOTH Premier A and Premier B pools under one league key, so a club
 * entered in both divisions (UJ, G&M Old Edwardians, Jeppe, Khosa, Lenasia, Old Parktonians)
 * fields two distinct sides there: `tm_<clubId>_hwb-premier-t20_0` (its Premier A side) and
 * `_1` (Premier B). A club in only one division keeps teamId === clubId. Returns undefined
 * for a single-division club or a non-HWB pool.
 */
export function t20SideFor(
  pool: T20Pool,
  clubId: string,
  pools: T20Pool[] = T20_POOLS,
): { index: number; label: string } | undefined {
  if (!pool.division) return undefined;
  const divisions = new Set<string>();
  for (const p of pools) {
    if (p.leagueKey !== pool.leagueKey || !p.division) continue;
    for (const t of p.teams) if (resolveClubName(t)?.id === clubId) divisions.add(p.division);
  }
  if (divisions.size < 2) return undefined;
  return { index: pool.division === 'Premier A' ? 0 : 1, label: `(${pool.division})` };
}

/**
 * Mechanical verification of the T20 tables (amendment 7). Returns every problem found (empty
 * = clean); the importer aborts on any. Checks: per-PDF fixture counts; per-pool expected
 * count; every fixture's teams resolve and belong to the pool roster; no team twice in one
 * date/time slot of a pool; a COMPLETE single round-robin per pool (each pair exactly once,
 * n(n-1)/2 games); no team plays itself; dates/times well-formed.
 */
export function verifyT20Pools(pools: T20Pool[] = T20_POOLS): string[] {
  const problems: string[] = [];
  const perSource = new Map<string, number>();
  for (const pool of pools) {
    const rosterIds = new Map<string, string>();
    for (const t of pool.teams) {
      const c = resolveClubName(t);
      if (!c) problems.push(`${pool.slug}: roster team "${t}" does not resolve to a club`);
      else if (rosterIds.has(c.id))
        problems.push(
          `${pool.slug}: roster lists ${c.id} twice ("${rosterIds.get(c.id)}", "${t}")`,
        );
      else rosterIds.set(c.id, t);
    }
    const n = rosterIds.size;
    if (pool.fixtures.length !== pool.expected)
      problems.push(`${pool.slug}: ${pool.fixtures.length} fixtures, expected ${pool.expected}`);
    if ((n * (n - 1)) / 2 !== pool.expected)
      problems.push(
        `${pool.slug}: ${n} teams ⇒ ${(n * (n - 1)) / 2} round-robin games, but expected ${pool.expected}`,
      );
    const slotTeams = new Map<string, Set<string>>();
    const pairs = new Map<string, number>();
    for (const f of pool.fixtures) {
      perSource.set(f.source, (perSource.get(f.source) ?? 0) + 1);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date) || !/^\d{2}:\d{2}$/.test(f.time))
        problems.push(`${pool.slug}: malformed date/time ${f.date} ${f.time}`);
      const h = resolveClubName(f.home);
      const a = resolveClubName(f.away);
      const where = `${pool.slug} ${f.date} ${f.time} ${f.home} v ${f.away}`;
      if (!h || !a) {
        problems.push(`${where}: a team name does not resolve`);
        continue;
      }
      if (!rosterIds.has(h.id)) problems.push(`${where}: ${h.id} is not in the pool roster`);
      if (!rosterIds.has(a.id)) problems.push(`${where}: ${a.id} is not in the pool roster`);
      if (h.id === a.id) problems.push(`${where}: a team plays itself`);
      const slot = `${f.date} ${f.time}`;
      const seen = slotTeams.get(slot) ?? new Set<string>();
      for (const id of [h.id, a.id]) {
        if (seen.has(id)) problems.push(`${where}: ${id} plays twice in the ${slot} slot`);
        seen.add(id);
      }
      slotTeams.set(slot, seen);
      const key = [h.id, a.id].sort().join('|');
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
    const ids = [...rosterIds.keys()].sort();
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const c = pairs.get(`${ids[i]}|${ids[j]}`) ?? 0;
        if (c !== 1)
          problems.push(`${pool.slug}: ${ids[i]} v ${ids[j]} meet ${c} time(s), expected 1`);
      }
  }
  for (const [key, spec] of Object.entries(T20_SOURCES)) {
    const got = perSource.get(key) ?? 0;
    // Only assert sources the given pools draw from (lets tests verify a subset).
    if (perSource.has(key) && got !== spec.expected)
      problems.push(
        `T20 source ${spec.file}: ${got} fixtures transcribed, expected ${spec.expected}`,
      );
  }
  return problems;
}

// ───────────────────────── 4. Venues ─────────────────────────

export interface LionsVenueSpec {
  /** Canonical registry name (the fixtures workbook's spelling where it has one). */
  name: string;
  /** Every other spelling, from any source, that names this ground. */
  aliases?: string[];
  /** Set when an equivalence is INFERRED from usage rather than spelled out — listed in the
   * CGL question list for confirmation. Inference only ever MERGES names, which can only add
   * clashes to the scan, never hide one. */
  inferred?: string;
}

/**
 * Canonical CGL grounds, reconciled 2 Oct 2026 from the distinct venue strings of: the league
 * workbook (70 strings), the Saturday + Sunday teams/grounds sheets, the five T20 PDFs and the
 * affiliation form's facility answers. Spellings that only differ in case, spacing or the
 * generic words normaliseName drops ("cricket", "club", "cc") need no alias.
 * Affiliation answers that are ambiguous between two ovals ("Marks Park", "Hyde Park High
 * School", "Lenasia Tech Grounds", "Sir Lionel Phillips - Pirates Sports Club", "Dainfern
 * College") are deliberately NOT aliased — the bootstrap reports them instead.
 */
export const LIONS_VENUES: LionsVenueSpec[] = [
  { name: 'Alan Lawson', aliases: ['Alan Lawson, The Old Edwardian Society'] },
  {
    name: 'Azaadville Sports Complex',
    aliases: ['Azaadville cricket ground', 'Azaardvile sports complex'],
    inferred:
      'Affiliation "Azaadville cricket ground" = the fixtures\' "Azaadville Sports Complex" (Azaadville\'s only home ground in the fixtures).',
  },
  { name: 'Aw Muller' },
  { name: 'Bedfordview High School' },
  { name: 'Braamfisherville', aliases: ['Braamfischerville Cricket Oval'] },
  { name: 'Dainfern 2' },
  { name: 'Dainfern College Main' },
  { name: 'Delfos Main', aliases: ['Delfos Main Oval'] },
  { name: 'Delfos West' },
  { name: 'East Bank Oval' },
  { name: 'Ferndale High School' },
  { name: 'Florida Park High' },
  {
    name: 'Heidelberg',
    aliases: ['Heidelburg', 'Unie Grounds'],
    inferred:
      'The fixtures\' "Heidelburg" ground = Heidelberg CC\'s affiliation facility "Unie Grounds" (its only ground).',
  },
  { name: 'Hoerskool Riebeeckrand', aliases: ['Highschool Riebeeckrand'] },
  { name: 'Hope Village', aliases: ['JCC Hope Village'] },
  { name: 'Hyde Park A' },
  { name: 'Hyde Park B' },
  { name: 'Isak Steyl', aliases: ['Isak Steyl Stadium'] },
  {
    name: 'Jan Cilliers',
    aliases: [
      'Laerskool Jan Cilliers - Only for suited for SU4 & SU5 games but need to check weekly on availability',
    ],
  },
  {
    name: 'Jeppe Boys High',
    aliases: [
      'Jeppe Boys',
      'Jeppe Boys (1 x field on Sundays only -- school is NOT available on Saturdays)',
    ],
  },
  { name: 'Jeppe Quondam', aliases: ['Jeppe Quondam (1 x field)'] },
  { name: 'John Griffiths' },
  {
    name: 'Kagiso Main',
    aliases: ['Kagiso Stadium', 'Kagiso Sports Complex'],
    inferred:
      'Grounds-sheet "Kagiso Stadium" and affiliation "Kagiso Sports Complex" = the fixtures\' "Kagiso Main" (Kagiso\'s only home ground in the fixtures).',
  },
  { name: 'KES 1' },
  {
    name: 'KHS',
    aliases: ['KHS 1'],
    inferred: 'Vets grounds-sheet "KHS 1" = the fixtures\' "KHS" (beside "KHS 2").',
  },
  { name: 'KHS 2' },
  {
    name: 'Khosa Main',
    aliases: ['Doug Poole'],
    inferred:
      'Sunday grounds-sheet "Doug Poole" = the fixtures\' "Khosa Main" (Khosa\'s Sunday home games are all at Khosa Main; Doug Poole is never used).',
  },
  {
    name: 'King School West Rand',
    aliases: ['Kings School West Rand', 'The King School Westrand'],
  },
  { name: 'Lenasia South', aliases: ['LENASIA SOUTH CRICKET GROUND'] },
  { name: 'Lenasia Stadium', aliases: ['Lenasia'] },
  { name: 'Lens Tech 1' },
  { name: 'Lens Tech 2' },
  { name: 'Lens Tech 3' },
  { name: 'Malboro Sports Complex', aliases: ['Marlboro Sports complex'] },
  { name: 'Marks Park 2' },
  { name: 'Marks Park 3' },
  { name: 'Marks Park Main', aliases: ['Marks Park ThistlesMain'] },
  {
    name: 'NWU 1',
    aliases: ['NWU Vanderbijlpark'],
    inferred:
      'Affiliation "NWU Vanderbijlpark" = the fixtures\' "NWU 1" (NWU Vaal\'s only ground).',
  },
  {
    name: 'Old Parks A',
    aliases: ['Doug Neilson', 'Doug Neilson Oval'],
    inferred:
      '"Doug Neilson" (Premier B grounds sheet, affiliation) = "Old Parks A" (all Old Parktonians\' Premier B home games are at Old Parks A).',
  },
  {
    name: 'Old Parks B',
    aliases: ['Old Park B', 'Copper Orr Oval'],
    inferred: 'Affiliation "Copper Orr Oval" = "Old Parks B" (Old Parktonians\' second oval).',
  },
  {
    name: 'Old Vaal Sports Complex',
    aliases: [
      'Old Vaaltonians Cricket Club. Turf pitch, practice nets, bathroom, change rooms & bar.',
    ],
  },
  { name: 'Progress Ground', aliases: ['Progress Grounds', 'PROGRESS GROUNDS LENASIA'] },
  { name: 'Puntans' },
  { name: 'Queens 1' },
  { name: 'Queens 2' },
  { name: 'Randburg A' },
  { name: 'Randburg B' },
  { name: 'Riverlea Sports Club', aliases: ['Riverlea'] },
  { name: 'Roshnee A', aliases: ['Roshnee Ground A', 'Roshnee Cricket Club A Field'] },
  { name: 'Roshnee B', aliases: ['Roshnee Ground B', 'Roshnee Cricket Club B Field'] },
  { name: 'Saheti High School', aliases: ['Saheti School'] },
  { name: 'Sir John Adams' },
  { name: 'Sir Lionel Phillips A', aliases: ['Sir Lionell Phillips A'] },
  { name: 'Sir Lionel Phillips B' },
  { name: 'Soweto Elkah', aliases: ['SOWETO CRICKET OVAL (ELKAH SPORTS PRECINCT)'] },
  { name: 'St Martins' },
  { name: 'Sullivan Oval', aliases: ['Sullivan'] },
  {
    name: 'Swaneville Cricket Oval',
    aliases: ['Swaneville Cricket Club, 607 Sandpiper Rd Swaneville Krugersdorp 1754'],
  },
  { name: 'Trezona Park', aliases: ['Trezona'] },
  { name: 'UJ Main', aliases: ['UJ Main oval'] },
  { name: 'UJ Orban Oval', aliases: ['UJ Orban', 'Orban Oval'] },
  {
    name: 'Vereeniging',
    aliases: ['Dick Fourie', 'Dick Fourie Vereeninging CC', 'Dick Fourie Stadium'],
    inferred:
      'The fixtures\' venue "Vereeniging" = Dick Fourie (grounds sheets + Vereeniging CC\'s affiliation; Die Ratels\' Saturday home games are also at "Vereeniging").',
  },
  { name: 'Walter Milton A', aliases: ['Walter Milton A oval'] },
  { name: 'Walter Milton B', aliases: ['2. Walter Milton B oval (3rd option)'] },
  {
    name: 'Wanderers Bottom Oval',
    aliases: ['Wanderers Bottom', 'The Wanderers (Kent Park) Bottom Oval'],
  },
  { name: 'Wanderers Top', aliases: ['The Wanderers (Kent Park) Top Oval'] },
  { name: 'Waterstone A', aliases: ['Waterstone College A'] },
  { name: 'Waterstone B', aliases: ['Waterstone College B'] },
  { name: 'Wits Education', aliases: ['1. Wits education campus OVAL'] },
];

/**
 * normaliseName(alias) → normaliseName(canonical), built from LIONS_VENUES. Throws on a key
 * claimed by two grounds or an alias that would hijack another ground's canonical name — a
 * map bug that would silently merge two grounds. Exported for tests.
 */
export function buildVenueAliases(specs: LionsVenueSpec[]): Record<string, string> {
  const canonicalKeys = new Map<string, string>();
  for (const s of specs) {
    const k = normaliseName(s.name);
    if (canonicalKeys.has(k))
      throw new Error(`lions venues: "${s.name}" and "${canonicalKeys.get(k)}" normalise alike`);
    canonicalKeys.set(k, s.name);
  }
  const aliases: Record<string, string> = {};
  for (const s of specs) {
    const target = normaliseName(s.name);
    for (const a of s.aliases ?? []) {
      const k = normaliseName(a);
      if (k === target) continue;
      if (canonicalKeys.has(k))
        throw new Error(
          `lions venues: alias "${a}" collides with ground "${canonicalKeys.get(k)}"`,
        );
      if (aliases[k] && aliases[k] !== target)
        throw new Error(`lions venues: alias "${a}" claimed by two grounds`);
      aliases[k] = target;
    }
  }
  return aliases;
}

/** The explicit lions ground-alias map handed to venue-clash.ts (never the dolphins default). */
export const LIONS_VENUE_ALIASES: Record<string, string> = buildVenueAliases(LIONS_VENUES);

const CANONICAL_BY_KEY = new Map(LIONS_VENUES.map((v) => [normaliseName(v.name), v]));

/** A ground name's ledger/registry key under the lions alias map. */
export function lionsGroundKey(raw: string): string {
  return groundKey(raw, LIONS_VENUE_ALIASES);
}

/** The canonical ground a raw spelling names, or null when it matches no LIONS_VENUES entry. */
export function canonicalVenue(raw: string): LionsVenueSpec | null {
  return CANONICAL_BY_KEY.get(lionsGroundKey(raw)) ?? null;
}

/** Whitespace-collapsed, trimmed display form of a raw venue string. */
export function cleanVenue(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** "TBC - no ground free", "TBC", blank, N/A — a fixture with no ground yet. */
export function isTbcVenue(raw: string | null | undefined): boolean {
  if (raw == null) return true;
  const t = cleanVenue(raw);
  return !t || /^tbc\b/i.test(t) || /^tba\b/i.test(t) || JUNK_GROUND.test(t);
}

/**
 * Per-ground simultaneous-match capacity (Venue.surfaces) CONFIRMED BY CGL — keyed by the
 * canonical LIONS_VENUES name. EMPTY until CGL answers the capacity question list
 * (prepared/lions-clash-and-capacity-questions.md); every ground defaults to 1 meanwhile,
 * which is the strictest clash setting. Never guess an entry here.
 */
export const KNOWN_GROUND_CAPACITIES: Record<string, number> = {};

export function groundCapacity(name: string): number {
  const canon = canonicalVenue(name)?.name ?? cleanVenue(name);
  const n = KNOWN_GROUND_CAPACITIES[canon];
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

// ───────────────────────── Grounds sheets → venue registry ─────────────────────────

export interface GroundsSheetEntry {
  sheetLabel: string;
  /** Block title, or '(untitled block)' — the Sunday sheet's Presidents A block lost its title row. */
  block: string;
  row: number;
  rawClub: string;
  clubId: string | null;
  grounds: string[];
}

/** Grounds-sheet club spellings CLUB_MAP does not carry, scoped to the grounds sheets only. */
export const GROUNDS_SHEET_CLUB_OVERRIDES: Record<string, string> = {
  // Sunday sheet, Sunday 2 block: "Wits" with grounds Walter Milton A/B + Wits Education —
  // Wits University's grounds (Wits Lions plays Saturdays only, at Marks Park 2).
  wits: 'Wits University',
};

function cellText(v: unknown): string {
  if (v == null || v instanceof Date) return '';
  if (typeof v === 'object' && 'richText' in (v as object))
    return (v as { richText: Array<{ text: string }> }).richText.map((r) => r.text).join('');
  if (typeof v === 'object' && 'result' in (v as object))
    return cellText((v as { result: unknown }).result);
  return String(v).replace(/\s+/g, ' ').trim();
}

/**
 * Parse a CGL "Teams per division and grounds" sheet. Header-driven: a row whose cells
 * include "Club / Team" starts a block; the club column is that cell's column and every
 * column to its right is a ground. The block's title is the nearest single-cell row above
 * the header — the Sunday sheet's Presidents A block has none, so it is labelled
 * '(untitled block)' rather than guessed (the registry needs club → grounds only, never the
 * division). Defensive by design: a missing block (no Sunday 5 block) simply contributes
 * nothing. Unresolvable club names are returned with clubId null for the caller to fail on.
 */
export function parseGroundsSheet(wb: ExcelJS.Workbook, sheetLabel: string): GroundsSheetEntry[] {
  const out: GroundsSheetEntry[] = [];
  for (const ws of wb.worksheets) {
    let clubCol = 0;
    let block = '';
    let lastTitle = '';
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells: string[] = [];
      for (let c = 1; c <= Math.max(ws.columnCount, 6); c++)
        cells.push(cellText(row.getCell(c).value));
      const nonEmpty = cells.filter(Boolean);
      if (!nonEmpty.length) {
        clubCol = 0;
        continue;
      }
      const headerIdx = cells.findIndex((t) => /^club\s*\/\s*team$/i.test(t));
      if (headerIdx >= 0) {
        clubCol = headerIdx + 1;
        block = lastTitle || '(untitled block)';
        lastTitle = '';
        continue;
      }
      if (!clubCol) {
        // Outside a block: a lone text cell is a title for the next block.
        if (nonEmpty.length === 1 && !/^\d+$/.test(nonEmpty[0])) lastTitle = nonEmpty[0];
        continue;
      }
      const rawClub = cells[clubCol - 1];
      if (!rawClub) continue;
      const grounds = cells.slice(clubCol).filter(Boolean);
      const override = GROUNDS_SHEET_CLUB_OVERRIDES[rawClub.toLowerCase()];
      const club = resolveClubName(override ?? rawClub);
      out.push({ sheetLabel, block, row: r, rawClub, clubId: club?.id ?? null, grounds });
    }
  }
  return out;
}

export interface RegistryReport {
  /** Grounds-sheet rows whose club name resolves to nothing (the bootstrap fails on these). */
  unresolvedClubs: GroundsSheetEntry[];
  /** Grounds-sheet ground names with no LIONS_VENUES entry (registered under their own name). */
  groundsNotCanonical: string[];
  /** Affiliation facility lines that match no canonical ground — NOT registered (free text). */
  affiliationUnmatched: Array<{ clubId: string; line: string }>;
  /** Affiliation lines that did match, for the sign-off print. */
  affiliationMatched: Array<{ clubId: string; line: string; venue: string }>;
}

/** Deterministic registry id for a canonical ground name. */
export function venueIdFor(name: string): string {
  return `v-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')}`;
}

/**
 * The would-be lions venue registry: every ground on the two grounds sheets (canonicalised
 * through LIONS_VENUE_ALIASES, so "Sir Lionell Phillips A" and "Sir Lionel Phillips A" are one
 * row) with the clubs that list it as homeClubIds, merged with affiliation facility answers
 * that match a canonical ground (their club is unioned in). Affiliation lines that match
 * nothing are reported, never registered — they are free text (addresses, "As per Normal").
 * `surfaces` comes from KNOWN_GROUND_CAPACITIES, default 1.
 */
export function buildLionsVenueRegistry(
  groundsEntries: GroundsSheetEntry[],
  affiliation: AffiliationRecord[],
): { venues: Venue[]; report: RegistryReport } {
  const report: RegistryReport = {
    unresolvedClubs: [],
    groundsNotCanonical: [],
    affiliationUnmatched: [],
    affiliationMatched: [],
  };
  const byKey = new Map<string, Venue>();
  const add = (name: string, clubId: string) => {
    const key = lionsGroundKey(name);
    let v = byKey.get(key);
    if (!v) {
      const canon = canonicalVenue(name)?.name ?? cleanVenue(name);
      v = { id: venueIdFor(canon), name: canon, homeClubIds: [], surfaces: groundCapacity(canon) };
      byKey.set(key, v);
    }
    if (!v.homeClubIds!.includes(clubId)) v.homeClubIds!.push(clubId);
    return v;
  };
  for (const e of groundsEntries) {
    if (!e.clubId) {
      report.unresolvedClubs.push(e);
      continue;
    }
    for (const g of e.grounds) {
      if (isTbcVenue(g)) continue;
      if (!canonicalVenue(g) && !report.groundsNotCanonical.includes(cleanVenue(g)))
        report.groundsNotCanonical.push(cleanVenue(g));
      add(g, e.clubId);
    }
  }
  for (const r of affiliation) {
    const lines = [r.facilities.mainName, ...r.facilities.additional].filter(Boolean);
    for (const line of lines) {
      const canon = canonicalVenue(line);
      if (!canon) {
        report.affiliationUnmatched.push({ clubId: r.club.id, line });
        continue;
      }
      add(canon.name, r.club.id);
      report.affiliationMatched.push({ clubId: r.club.id, line, venue: canon.name });
    }
  }
  const venues = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const v of venues) v.homeClubIds!.sort();
  return { venues, report };
}
