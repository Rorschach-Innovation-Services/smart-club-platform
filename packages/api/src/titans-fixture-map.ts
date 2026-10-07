/**
 * Titans 2026-27 FIXTURES — pure data + pure parsing helpers, NO AWS imports. Consumed by
 * import-titans-fixtures.ts; every `--parse-only` path must run under plain `npx tsx` (no
 * `sst shell`, no AWS creds), and these tables must be testable in isolation.
 *
 * Five sections:
 *   1. SHEET MANIFEST — the 36 sheets of "2026 Titans Club Cricket 2026-2027 Fixtures - 1st
 *      Half Final Final Draft.xlsx" → `s-titans-*` series (one per division / T20 group /
 *      junior pool), each with its MEASURED real-fixture count. A count mismatch is fatal.
 *   2. TIMES — `parseTitansTime` for every form the workbook uses ("8:00", "9:00 AM",
 *      "13H00", a 1899-epoch time cell, the T20 "AM"/"PM" markers) plus the provisional
 *      defaults for untimed rows. Every fixture carries a `timeSource`.
 *   3. TEAM NAMES — canonical spelling (whitespace collapse, "CENTURION KAVALIERS CC 2"),
 *      the un-numbered-side inference, and club resolution through titans-import-map.ts's
 *      `resolveClubToken` (the same tokens the August compliance import used).
 *   4. VENUES — a MISSPELLINGS-ONLY alias table (distinct fields of one complex are never
 *      merged: that manufactures false clashes) plus the ambiguous pairs listed for the union.
 *   5. SHEET PARSER — flat and grouped (T20) layouts, date carry-down, BYE skip, banners,
 *      the Women's League split-round rows, knockout rows with proposed slot refs, and the
 *      HELD_BACK list of fixtures that are parsed and reported but never written.
 */
import type ExcelJS from 'exceljs';
import { isoDate } from './import-planb-fixtures.js';
import { normaliseName, groundKey, DEFAULT_VENUE_ALIASES } from './venue-clash.js';
import { resolveClubToken, type ClubMapEntry } from './titans-import-map.js';

export const TITANS_TENANT = 'titans';
/** Every series this importer writes carries this id prefix (`--revert` scope). */
export const TITANS_SERIES_PREFIX = 's-titans-';

/** Season window — a date outside it is a bad read or a year typo, not data. */
export const SEASON_FROM = '2026-09-01';
export const SEASON_TO = '2027-05-31';

// ───────────────────────── 1. Sheet manifest ─────────────────────────

/** League labels used in series names. The real run prefers the tenant config's own labels. */
export const TITANS_LEAGUE_LABELS: Record<string, string> = {
  'premier-league': 'Premier League',
  'promotion-league': 'Promotion League',
  'second-league': 'Second League',
  'third-league': 'Third League',
  'fourth-league': 'Fourth League',
  'fifth-league': 'Fifth League',
  'sixth-league': 'Sixth League',
  'mens-t20': "Men's T20",
  'womens-t20': "Women's T20",
  'womens-premier-league': "Women's Premier League",
  'womens-junior-league': "Women's Junior League",
  'veterans-league': 'Veterans League',
  u9: 'U9',
  u11: 'U11',
  u13: 'U13',
  u15: 'U15',
};

export function leagueLabel(key: string): string {
  return TITANS_LEAGUE_LABELS[key] ?? key;
}

export interface TitansSeriesSpec {
  seriesId: string;
  leagueKey: string;
  /** `<League label> · <Division/Group>`, or just the league label for a single-division sheet. */
  seriesName: string;
  /** The division/group half of the name ('' for a single-division sheet). */
  part: string;
  /** Measured real-fixture count (held-back fixtures included) — any mismatch is fatal. */
  expected: number;
  /** T20 sheets only: the "GROUP X" banner this series is read from. */
  group?: string;
}

export interface TitansSheetSpec {
  /** Worksheet name, compared trimmed. */
  sheet: string;
  /** 'flat' = one DATE/HOME/AWAY/VENUE table; 't20' = GROUP banners + AM/PM markers + knockouts. */
  layout: 'flat' | 't20';
  /** Junior sheets (U*, Women's Junior) default untimed rows to 08:30, all others to 13:00. */
  junior: boolean;
  leagueKey: string;
  series: TitansSeriesSpec[];
  /** Knockout / playoff placeholder rows the sheet must carry (parsed, never written in A0). */
  koRows: number;
  /** The knockout series those rows belong to. */
  koSeriesId?: string;
}

/** A series name from a league label (the tenant's own on a real run) and the part. */
export function seriesNameFor(
  spec: { leagueKey: string; part: string },
  labelOf: (key: string) => string = leagueLabel,
): string {
  const label = labelOf(spec.leagueKey);
  return spec.part ? `${label} · ${spec.part}` : label;
}

function seriesSpec(
  leagueKey: string,
  suffix: string,
  part: string,
  expected: number,
  group?: string,
): TitansSeriesSpec {
  return {
    seriesId: `${TITANS_SERIES_PREFIX}${leagueKey}${suffix ? `-${suffix}` : ''}`,
    leagueKey,
    seriesName: seriesNameFor({ leagueKey, part }),
    part,
    expected,
    ...(group ? { group } : {}),
  };
}

function flat(
  sheet: string,
  leagueKey: string,
  suffix: string,
  part: string,
  expected: number,
  extra: Partial<TitansSheetSpec> = {},
): TitansSheetSpec {
  return {
    sheet,
    layout: 'flat',
    junior: false,
    leagueKey,
    series: [seriesSpec(leagueKey, suffix, part, expected)],
    koRows: 0,
    ...extra,
  };
}

/** A junior pool sheet ("U9 PLAT A") → one `u9-platinum-a` series. */
function junior(sheet: string, expected: number): TitansSheetSpec {
  const m = sheet.match(/^U(9|11|13|15) (PLAT|GOLD|SILVER)(?: ([AB]))?$/);
  if (!m) throw new Error(`titans fixtures: unrecognised junior sheet "${sheet}"`);
  const [, age, tier, pool] = m;
  const tierName = { PLAT: 'Platinum', GOLD: 'Gold', SILVER: 'Silver' }[tier]!;
  const leagueKey = `u${age}`;
  const suffix = `${tierName.toLowerCase()}${pool ? `-${pool.toLowerCase()}` : ''}`;
  return {
    ...flat(sheet, leagueKey, suffix, `${tierName}${pool ? ` ${pool}` : ''}`, expected),
    junior: true,
  };
}

/** T20 group series: `-g-a` suffix so a later groupPositionLabel can read "Group A". */
function t20Groups(leagueKey: string, groups: Array<[string, number]>): TitansSeriesSpec[] {
  return groups.map(([g, n]) =>
    seriesSpec(leagueKey, `g-${g.toLowerCase()}`, `Group ${g}`, n, `GROUP ${g}`),
  );
}

/**
 * The 36 sheets, in workbook order. Counts were measured by parsing (real fixtures only:
 * BYE rows, banners, knockout placeholders and the Women's League Top 6/Bottom 6 rows are
 * excluded). Division sheets keep their own series (`-a`/`-b`) under one league key.
 */
export const TITANS_FIXTURE_SHEETS: TitansSheetSpec[] = [
  {
    sheet: 'MENS T20 1ST TEAMS',
    layout: 't20',
    junior: false,
    leagueKey: 'mens-t20',
    series: t20Groups('mens-t20', [
      ['A', 6],
      ['B', 6],
      ['C', 6],
      ['D', 6],
      ['E', 6],
    ]),
    koRows: 8,
    koSeriesId: `${TITANS_SERIES_PREFIX}mens-t20-ko`,
  },
  flat('PREMIER DIVISION A', 'premier-league', 'a', 'Division A', 56),
  flat('PREMIER DIVISION B', 'premier-league', 'b', 'Division B', 56),
  flat('PROMOTION DIVISION A', 'promotion-league', 'a', 'Division A', 56),
  flat('PROMOTION DIVISION B', 'promotion-league', 'b', 'Division B', 56),
  flat('SECOND', 'second-league', '', '', 132),
  flat('THIRD', 'third-league', '', '', 132),
  flat('FOURTH', 'fourth-league', '', '', 90),
  flat('FIFTH', 'fifth-league', '', '', 72),
  flat('SIXTH (BLIND)', 'sixth-league', '', '', 24),
  {
    sheet: 'WOMENS T20',
    layout: 't20',
    junior: false,
    leagueKey: 'womens-t20',
    // The banners read GROUP A/B/C; the knockout rows call the same groups G1/G2/G3.
    series: t20Groups('womens-t20', [
      ['A', 6],
      ['B', 6],
      ['C', 6],
    ]),
    koRows: 7,
    koSeriesId: `${TITANS_SERIES_PREFIX}womens-t20-ko`,
  },
  flat('WOMENS LEAGUE', 'womens-premier-league', '', '', 66),
  flat('TITANS VETERANS LEAGUE A', 'veterans-league', 'a', 'Division A', 45, {
    koRows: 2,
    koSeriesId: `${TITANS_SERIES_PREFIX}veterans-league-a-ko`,
  }),
  flat('TITANS VETERANS LEAGUE B', 'veterans-league', 'b', 'Division B', 36, {
    koRows: 2,
    koSeriesId: `${TITANS_SERIES_PREFIX}veterans-league-b-ko`,
  }),
  { ...flat('WOMENS JUNIOR LEAGUE', 'womens-junior-league', '', '', 20), junior: true },
  junior('U9 PLAT A', 28),
  junior('U9 PLAT B', 28),
  junior('U9 GOLD A', 21),
  junior('U9 GOLD B', 21),
  junior('U9 SILVER A', 15),
  junior('U9 SILVER B', 15),
  junior('U11 PLAT A', 36),
  junior('U11 PLAT B', 36),
  junior('U11 GOLD A', 28),
  junior('U11 GOLD B', 21),
  junior('U11 SILVER A', 21),
  junior('U11 SILVER B', 21),
  junior('U13 PLAT A', 28),
  junior('U13 PLAT B', 28),
  junior('U13 GOLD A', 21),
  junior('U13 GOLD B', 28),
  junior('U13 SILVER', 28),
  junior('U15 PLAT A', 28),
  junior('U15 PLAT B', 21),
  junior('U15 GOLD A', 21),
  junior('U15 GOLD B', 15),
];

/** Sum of every series' expected count — the workbook's 1,398 real fixtures. */
export const EXPECTED_TOTAL_FIXTURES = TITANS_FIXTURE_SHEETS.reduce(
  (n, s) => n + s.series.reduce((m, x) => m + x.expected, 0),
  0,
);

/** Every series id the manifest produces (league + group series; KO series are separate). */
export const KNOWN_SERIES_IDS = TITANS_FIXTURE_SHEETS.flatMap((s) =>
  s.series.map((x) => x.seriesId),
);

/** Knockout series: veterans playoffs are written by this importer (`pos:`/`win:` only); the
 * T20 brackets need PR B's `tbd:` slots and are parsed and reported only. */
export const VETERANS_KO_SERIES_IDS = TITANS_FIXTURE_SHEETS.filter(
  (s) => s.leagueKey === 'veterans-league' && s.koSeriesId,
).map((s) => s.koSeriesId!);
export const T20_KO_SERIES_IDS = TITANS_FIXTURE_SHEETS.filter(
  (s) => s.layout === 't20' && s.koSeriesId,
).map((s) => s.koSeriesId!);

/** Every league key the workbook uses — each must exist on the tenant before a write. */
export const TITANS_LEAGUE_KEYS = [...new Set(TITANS_FIXTURE_SHEETS.map((s) => s.leagueKey))];

/**
 * Match length per league, SOURCED, never guessed. The union's own 2026-27 "Club League Entry"
 * form template (every club's entry form; e.g. TUT's and Pretoria East's in the Oct top-up pack)
 * labels "2nd/3rd/4th League (45 Overs)", "5th League (35 Overs)" and "Womens' League (35
 * Overs)"; the T20 sheets are titled T20. Every other league is left unset and listed in the
 * union report as "overs unknown" (TITANS_OVERS_UNKNOWN).
 */
export const TITANS_LEAGUE_OVERS: Record<string, { maxOvers: number; source: string }> = {
  'second-league': { maxOvers: 45, source: 'entry form "2nd League (45 Overs)"' },
  'third-league': { maxOvers: 45, source: 'entry form "3rd League (45 Overs)"' },
  'fourth-league': { maxOvers: 45, source: 'entry form "4th League (45 Overs)"' },
  'fifth-league': { maxOvers: 35, source: 'entry form "5th League (35 Overs)"' },
  'womens-premier-league': { maxOvers: 35, source: `entry form "Womens' League (35 Overs)"` },
  'mens-t20': { maxOvers: 20, source: 'sheet title (T20)' },
  'womens-t20': { maxOvers: 20, source: 'sheet title (T20)' },
};

/** Leagues whose overs no source states: left unset, asked in the union report. */
export const TITANS_OVERS_UNKNOWN: Array<{ leagueKey: string; why: string }> = [
  { leagueKey: 'premier-league', why: 'the entry form gives no overs for the Premier League' },
  { leagueKey: 'promotion-league', why: 'the entry form gives no overs for the Promotion League' },
  {
    leagueKey: 'sixth-league',
    why: 'the sheet switches format mid-season ("T20s" rounds, then "30 OVERS"), and one series cannot carry both',
  },
  { leagueKey: 'veterans-league', why: `the entry form's "Veterans" row gives no overs` },
  {
    leagueKey: 'womens-junior-league',
    why: `no source (the entry form's "Junior Girls" row gives none)`,
  },
  { leagueKey: 'u9', why: `the entry form's junior rows give no overs` },
  { leagueKey: 'u11', why: `the entry form's junior rows give no overs` },
  { leagueKey: 'u13', why: `the entry form's junior rows give no overs` },
  { leagueKey: 'u15', why: `the entry form's junior rows give no overs` },
];

/**
 * T20 cup sides REUSE the club's existing league side ids (user decision, 7 Oct 2026): the host
 * leagues each cup borrows from, in preference order. Men's T20 → the senior men's league the
 * exact sheet name plays in this workbook; women's T20 → women's premier, else promotion.
 */
export const T20_HOST_LEAGUES: Record<string, string[]> = {
  'mens-t20': [
    'premier-league',
    'promotion-league',
    'second-league',
    'third-league',
    'fourth-league',
    'fifth-league',
    'sixth-league',
  ],
  'womens-t20': ['womens-premier-league', 'womens-promotion-league'],
};

/** League keys the prereqs bootstrap adds when absent (every other key must already exist).
 * The T20 cups are fixtures-only: competitions the clubs' existing sides play. */
export const TITANS_NEW_LEAGUES: Array<{
  key: string;
  label: string;
  group: string;
  fixturesOnly?: boolean;
}> = [
  { key: 'mens-t20', label: "Men's T20", group: 'T20 Cups', fixturesOnly: true },
  { key: 'womens-t20', label: "Women's T20", group: 'T20 Cups', fixturesOnly: true },
  { key: 'womens-junior-league', label: "Women's Junior League", group: 'Junior Leagues' },
];

// ───────────────────────── 2. Times ─────────────────────────

export type TimeSource = 'sheet' | 't20-marker' | 'provisional';

/** T20 block markers: the date row and the "AM" row start the morning game, "PM" the afternoon. */
export const T20_AM_TIME = '09:00';
export const T20_PM_TIME = '13:30';
/** Provisional start for untimed rows — an assumption the union must confirm (risk R1). */
export const JUNIOR_DEFAULT_TIME = '08:30';
export const SENIOR_DEFAULT_TIME = '13:00';

/** A sheet start time outside daylight cricket hours is a typo ("1:00" meaning 13:00). */
export const SHEET_TIME_RANGE = '07:00–18:30';
export function plausibleSheetTime(time: string): boolean {
  return time >= '07:00' && time <= '18:30';
}

export function provisionalTime(junior: boolean): string {
  return junior ? JUNIOR_DEFAULT_TIME : SENIOR_DEFAULT_TIME;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Read one time cell. Handles a 1899-epoch time cell (exceljs Date), a fraction-of-day number,
 * `{formula, result}`, and the text forms "8:00", "14:30", "9:00 AM", "2:00 PM", "13H00",
 * "12H00". The bare T20 markers "AM"/"PM" map to 09:00/13:30 with source 't20-marker'. Anything
 * else (a date cell, a team name, blank) → null.
 */
export function parseTitansTime(raw: unknown): { time: string; source: TimeSource } | null {
  if (raw == null) return null;
  if (raw instanceof Date) {
    if (raw.getUTCFullYear() >= 1970) return null; // a date cell, not a time
    return { time: `${pad2(raw.getUTCHours())}:${pad2(raw.getUTCMinutes())}`, source: 'sheet' };
  }
  if (typeof raw === 'object' && 'result' in (raw as object))
    return parseTitansTime((raw as { result: unknown }).result);
  if (typeof raw === 'number') {
    if (!(raw > 0 && raw < 1)) return null;
    const mins = Math.round(raw * 24 * 60);
    return { time: `${pad2(Math.floor(mins / 60) % 24)}:${pad2(mins % 60)}`, source: 'sheet' };
  }
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toUpperCase();
  if (t === 'AM') return { time: T20_AM_TIME, source: 't20-marker' };
  if (t === 'PM') return { time: T20_PM_TIME, source: 't20-marker' };
  const m = t.match(/^(\d{1,2})\s*[:H.]\s*(\d{2})(?:\s*(AM|PM))?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[3] === 'PM' && h < 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { time: `${pad2(h)}:${pad2(min)}`, source: 'sheet' };
}

// ───────────────────────── 3. Team names ─────────────────────────

/**
 * The canonical spelling of a sheet team name: uppercase, whitespace collapsed ("CBCOB
 * VETERANS 1"), and the stray "CC" before a side number dropped ("CENTURION KAVALIERS CC 2"
 * → "CENTURION KAVALIERS 2", matching every other Centurion side in the workbook).
 */
export function canonicalTeamName(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .replace(/ CC (\d+|[A-Z])$/, ' $1');
}

/** The CLUB_MAP club a sheet team name belongs to, or undefined (fatal at the gate). */
export function resolveTeamClub(raw: string): ClubMapEntry | undefined {
  return resolveClubToken(canonicalTeamName(raw));
}

/** The side qualifier after the club token ("TUKS 2" → "2", "PHSOB VETERANS 1" → "VETERANS
 * 1", "ADELAAR B" → "B"), or '' for an un-numbered side. */
export function sideSuffix(canonical: string): string {
  const club = resolveClubToken(canonical);
  if (!club) return '';
  const token = club.sheetTokens.find((t) => canonical === t || canonical.startsWith(`${t} `));
  return token ? canonical.slice(token.length).trim() : '';
}

/**
 * Un-numbered side inference, per sheet. A bare club name ("QUEENSWOOD CRICKET CLUB") on a
 * sheet whose other rows name exactly ONE numbered side of that club is that side; with two
 * or more numbered sides it is ambiguous and fatal; with none it stays the plain club side.
 * Returns bare-name → numbered-name for the rewrites, plus the ambiguities.
 */
export function inferUnnumberedSides(names: string[]): {
  rewrites: Map<string, string>;
  errors: string[];
} {
  const rewrites = new Map<string, string>();
  const errors: string[] = [];
  const canon = [...new Set(names.map(canonicalTeamName))];
  for (const bare of canon) {
    const club = resolveClubToken(bare);
    if (!club || sideSuffix(bare) !== '') continue;
    const numbered = canon.filter(
      (n) => n !== bare && resolveClubToken(n)?.id === club.id && sideSuffix(n) !== '',
    );
    if (numbered.length === 1) rewrites.set(bare, numbered[0]);
    else if (numbered.length > 1)
      errors.push(
        `"${bare}" is un-numbered but the sheet also has ${numbered.join(', ')} — cannot tell which side it is`,
      );
  }
  return { rewrites, errors };
}

/** Provisional (parse-only) side id: league + canonical sheet name. Live roster ids replace it
 * in the write steps — never derived from the sheet digit. */
export function provisionalSideId(leagueKey: string, canonical: string): string {
  return `prov:${leagueKey}:${canonical
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;
}

// ───────────────────────── 4. Venues ─────────────────────────

export interface TitansVenueSpelling {
  /** Canonical ground name (what the registry row is called). */
  name: string;
  /** Misspellings of THAT SAME FIELD only — never a different field of the same complex. */
  aliases: string[];
  /** Where the misspelling comes from. */
  note: string;
}

/**
 * Misspellings only. Distinct fields of one complex stay separate grounds (IRENE OVAL vs
 * IRENE COUNTRY CLUB, GIJIMA OVAL vs GIJIMA SPORTS GROUND, SILVER VALKE vs SILVER VALKE B,
 * SOUTHDOWNS COLLEGE A vs B, LAERSKOOL LYNWOOD ATTSPORTS A vs B): merging them books two
 * real pitches as one and manufactures false clashes. Spellings that differ only in spacing
 * ("TYGER VALLEY" / "TYGERVALLEY") already share a normaliseName key and need no entry.
 */
export const TITANS_VENUE_SPELLINGS: TitansVenueSpelling[] = [
  {
    name: 'GIJIMA SPORTS GROUND',
    aliases: ['GIJIMA SPORTS GROUNDS'],
    note: 'Men\'s T20 sheet pluralises Hammanskraal\'s "GIJIMA SPORTS GROUND" (GIJIMA OVAL is a different field)',
  },
  {
    name: 'HIGH SCHOOL UITSIG A',
    aliases: ['HIGH SCHOOL UITISIG A', 'HIGH SCHOOL UITISG A'],
    note: "Centurion Kavaliers' ground — T20 sheets and the August club record misspell UITSIG",
  },
  {
    name: 'HIGH SCHOOL UITSIG B',
    aliases: ['HIGH SCHOOL UITISIG B', 'HIGH SCHOOL UITISG B'],
    note: 'August structure-sheet misspelling of UITSIG',
  },
  {
    name: 'SOSHANGUVE OVAL',
    aliases: ['SOSGANGUVE OVAL'],
    note: 'Veterans B sheet typo',
  },
  {
    name: 'LAERSKOOL ANTON VAN WOUW',
    aliases: ['LAERSKOOL ANTON VAN VOUW'],
    note: 'Junior sheets spell the school both VOUW and WOUW',
  },
  {
    name: 'MIDSTREAM RIDGE A FIELD',
    aliases: ['MIDSTREAM RIDGE A'],
    note: 'Women\'s Junior League drops "FIELD" (MIDSTREAM RIDGE B FIELD is a different field)',
  },
  {
    name: 'HOFMEYER PARK B',
    aliases: ['HOFEMYER PARK B'],
    note: 'August structure-sheet / club-record typo',
  },
  {
    name: 'HOFMEYER PARK A',
    aliases: ['HOFEMYER PARK A'],
    note: 'August structure-sheet typo family (HOFEMYER)',
  },
  {
    name: 'MAMELODI OVAL',
    aliases: ['MAMEMLODI OVAL'],
    note: 'August structure-sheet / club-record typo',
  },
  {
    name: 'LAERSKOOL GHS B',
    aliases: ['KAERSKOOL GHS B'],
    note: 'August structure-sheet typo',
  },
  {
    name: 'LAERSKOOL MAGALIESKRUIN',
    aliases: ['LAERSKOOL MAGA;ISKRUIN'],
    note: 'August structure-sheet typo',
  },
  {
    name: 'LOUIS LEIPOLDT',
    aliases: ['LOUIS LEPOLDT'],
    note: 'August structure-sheet typo',
  },
  {
    name: 'MIDSTREAM PRIMARY RUGBY FIELD',
    aliases: ['MIDSTREAM PRIMARY RIGBY FIELD'],
    note: 'August structure-sheet typo',
  },
];

/**
 * Pairs that MIGHT be one ground but are not merged — listed in the union report for an
 * answer. Report-only: nothing here changes a ledger key.
 */
export const AMBIGUOUS_VENUES: Array<{ names: string[]; question: string }> = [
  {
    names: ['THE GLEN', 'THE GLEN HIGH'],
    question: 'Is THE GLEN HIGH (Women\'s T20) the same field as "THE GLEN" (Pretoria)?',
  },
  {
    names: ['SOUTHDOWNS COLLEGE', 'SOUTHDOWNS COLLEGE A', 'SOUTHDOWNS COLLEGE B'],
    question: 'Which Southdowns field is the Women\'s T20 "SOUTHDOWNS COLLEGE" — A, B or another?',
  },
  {
    names: [
      'LAERSKOOL LYNWOOD',
      'LYNWOOD ATTSPORT',
      'LAERSKOOL LYNWOOD ATTSPORTS A',
      'LAERSKOOL LYNWOOD ATTSPORTS B',
    ],
    question:
      'Are LAERSKOOL LYNWOOD (U13 Silver) and LYNWOOD ATTSPORT (Fifth) the ATTSPORTS A field, the B field, or separate grounds?',
  },
  {
    names: ['SILVER VALKE', 'SILVER VALKE B'],
    question: 'Is "SILVER VALKE" (juniors) a different field from SILVER VALKE B (Fourth)?',
  },
  {
    names: ['MIDSTREAM COLLEGE HOCKEY FIELD', 'MIDSTREAM COLLEGE HOCKEY F'],
    question:
      'Confirm MIDSTREAM COLLEGE HOCKEY FIELD is its own ground (not a Midstream Ridge field)',
  },
  {
    names: ['MAYVILLE', 'LAERSKOOL MAYVILLE'],
    question: 'Is "MAYVILLE" (U11 Silver B) the same ground as LAERSKOOL MAYVILLE (U11 Plat)?',
  },
  {
    names: ['TOTIUSDAL PRIMARY', 'LAERSKOOL TOTIUSDAL'],
    question:
      'Is TOTIUSDAL PRIMARY (U11 Silver B) the same field as LAERSKOOL TOTIUSDAL (Adelaar juniors)?',
  },
  {
    names: ['LAERSKOOL ANTON VAN WOUW', 'LAERSKOOL ANTON VAN VOUW A'],
    question:
      'The August structure sheet lists "LAERSKOOL ANTON VAN VOUW A" — does the school have more than one field?',
  },
];

/**
 * normaliseName(alias) → normaliseName(canonical). Throws on a key claimed by two grounds or
 * an alias that would hijack another ground's canonical name (a map bug that would silently
 * merge two fields). Exported for tests.
 */
export function buildTitansVenueAliases(specs: TitansVenueSpelling[]): Record<string, string> {
  const canonicalKeys = new Map<string, string>();
  for (const s of specs) {
    const k = normaliseName(s.name);
    if (canonicalKeys.has(k))
      throw new Error(`titans venues: "${s.name}" and "${canonicalKeys.get(k)}" normalise alike`);
    canonicalKeys.set(k, s.name);
  }
  const aliases: Record<string, string> = {};
  for (const s of specs) {
    const target = normaliseName(s.name);
    for (const a of s.aliases) {
      const k = normaliseName(a);
      if (k === target) continue;
      if (canonicalKeys.has(k))
        throw new Error(
          `titans venues: alias "${a}" collides with ground "${canonicalKeys.get(k)}"`,
        );
      if (aliases[k] && aliases[k] !== target)
        throw new Error(`titans venues: alias "${a}" claimed by two grounds`);
      aliases[k] = target;
    }
  }
  return aliases;
}

/** The titans misspelling map on its own (what the bootstrap writes to venueAliases). */
export const TITANS_VENUE_ALIASES: Record<string, string> =
  buildTitansVenueAliases(TITANS_VENUE_SPELLINGS);

/** What the release gate will resolve through: the code default merged under the titans map
 * (`venueAliasesFor` semantics — a tenant entry wins on the same key). */
export const TITANS_GATE_ALIASES: Record<string, string> = {
  ...DEFAULT_VENUE_ALIASES,
  ...TITANS_VENUE_ALIASES,
};

const CANONICAL_BY_KEY = new Map(TITANS_VENUE_SPELLINGS.map((v) => [normaliseName(v.name), v]));

/** Whitespace-collapsed, trimmed, uppercased display form of a raw venue string. */
export function cleanVenue(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toUpperCase();
}

/** "TBC", blank — a fixture with no ground yet. */
export function isTbcVenue(raw: string | null | undefined): boolean {
  if (raw == null) return true;
  const t = cleanVenue(raw);
  return !t || /^TB[CA]\b/.test(t);
}

/** A ground name's ledger key under the gate's alias map. */
export function titansGroundKey(raw: string): string {
  return groundKey(raw, TITANS_GATE_ALIASES);
}

/** The canonical display name for a raw venue: the spelling table's name when it is a known
 * misspelling (or the canonical itself), else the cleaned sheet spelling. */
export function canonicalVenueName(raw: string): string {
  const spec = CANONICAL_BY_KEY.get(groundKey(raw, TITANS_VENUE_ALIASES));
  return spec ? spec.name : cleanVenue(raw);
}

// ───────────────────────── 5. Held back ─────────────────────────

export interface HeldBackFixture {
  sheet: string;
  date: string;
  home: string;
  away: string;
  venue: string;
  reason: string;
}

/**
 * Fixtures parsed, counted and reported but NEVER written: real double-bookings the union
 * must resolve (both fixtures of each pair are held — which one moves is the union's call).
 * Data-driven so the union's answer is a one-line edit; an entry that matches no parsed
 * fixture is fatal (a stale list must not silently hold nothing).
 */
export const HELD_BACK: HeldBackFixture[] = [
  {
    sheet: 'U11 PLAT B',
    date: '2026-10-24',
    home: 'PHSOB A',
    away: 'HARLEQUINS A',
    venue: 'LAERSKOOL ANTON VAN WOUW',
    reason:
      'Same ground, date and provisional 08:30 start as U11 Gold A PHSOB B v Irene Villagers C',
  },
  {
    sheet: 'U11 GOLD A',
    date: '2026-10-24',
    home: 'PHSOB B',
    away: 'IRENE VILLAGERS C',
    venue: 'LAERSKOOL ANTON VAN WOUW',
    reason: 'Same ground, date and provisional 08:30 start as U11 Plat B PHSOB A v Harlequins A',
  },
  {
    sheet: 'U15 PLAT A',
    date: '2026-10-25',
    home: 'IRENE VILLAGERS B',
    away: 'HAMMANSKRAAL A',
    venue: 'IRENE OVAL',
    reason:
      'Same ground, date and provisional 08:30 start as U15 Gold A Irene Villagers C v Centurion Kavaliers B',
  },
  {
    sheet: 'U15 GOLD A',
    date: '2026-10-25',
    home: 'IRENE VILLAGERS C',
    away: 'CENTURION KAVALIERS B',
    venue: 'IRENE OVAL',
    reason:
      'Same ground, date and provisional 08:30 start as U15 Plat A Irene Villagers B v Hammanskraal A',
  },
];

export function isHeldBack(
  f: { sheet: string; date: string; home: string; away: string; venue: string | null },
  list: HeldBackFixture[] = HELD_BACK,
): HeldBackFixture | undefined {
  return list.find(
    (h) =>
      h.sheet === f.sheet &&
      h.date === f.date &&
      canonicalTeamName(h.home) === f.home &&
      canonicalTeamName(h.away) === f.away &&
      titansGroundKey(h.venue) === titansGroundKey(f.venue ?? ''),
  );
}

// ───────────────────────── 6. Sheet parser ─────────────────────────

export interface TitansRawFixture {
  sheet: string;
  row: number;
  seriesId: string;
  date: string;
  time: string;
  timeSource: TimeSource;
  /** Canonical team names (after the un-numbered-side inference). */
  home: string;
  away: string;
  rawHome: string;
  rawAway: string;
  /** Canonical venue name, or null for TBC. */
  venue: string | null;
  rawVenue: string;
}

export type SlotRefKind = 'pos' | 'win' | 'tbd' | 'team';

export interface KoSlotProposal {
  raw: string;
  kind: SlotRefKind;
  /** `pos:<seriesId>:<rank>`, `win:f<n>`, `tbd:<label>` or `team:<canonical name>`. */
  ref: string;
  note?: string;
}

export interface KoRow {
  sheet: string;
  row: number;
  koSeriesId: string;
  /** Proposed KO fixture id (row order within the sheet's knockout block). */
  fixtureId: string;
  /** The match tag the sheet gives it ("Q1", "S2"), when it does. */
  tag: string | null;
  date: string;
  time: string;
  timeSource: TimeSource;
  rawHome: string;
  rawAway: string;
  rawVenue: string;
  home: KoSlotProposal;
  away: KoSlotProposal;
}

export interface ParsedTitansSheet {
  spec: TitansSheetSpec;
  fixtures: TitansRawFixture[];
  ko: KoRow[];
  byes: Array<{ row: number; date: string; team: string }>;
  banners: Array<{ row: number; text: string }>;
  /** Women's League "TOP 6 /BOTTOM 6" rows: dated, no teams yet. */
  splitRounds: Array<{ row: number; date: string }>;
  /** A stand-alone time row ("13H00" under a T20 fixture) applied to the fixture above it. */
  timeRows: Array<{ row: number; appliedTo: number; time: string }>;
  /** Year typos corrected (2026-01-17 → 2027-01-17). */
  dateCorrections: string[];
  /** Un-numbered names rewritten to the sheet's one numbered side of that club. */
  sideInferences: Array<{ from: string; to: string }>;
  errors: string[];
  warnings: string[];
}

function cellText(v: unknown): string {
  if (v == null || v instanceof Date) return '';
  if (typeof v === 'object' && 'richText' in (v as object))
    return cellText(
      (v as { richText: Array<{ text: string }> }).richText.map((r) => r.text).join(''),
    );
  if (typeof v === 'object' && 'result' in (v as object))
    return cellText((v as { result: unknown }).result);
  return String(v).replace(/\s+/g, ' ').trim();
}

/** isoDate (UTC-safe, planb) + the season window, with the one recurring typo corrected: a
 * Jan–May date keyed as 2026 instead of 2027 (Sunday catch-up rows in FOURTH/FIFTH). */
export function seasonDate(
  v: unknown,
): { date: string; corrected?: string } | { error: string } | null {
  const d = isoDate(v);
  if (!d) return null;
  if (d >= SEASON_FROM && d <= SEASON_TO) return { date: d };
  const bumped = `${Number(d.slice(0, 4)) + 1}${d.slice(4)}`;
  const janToMay = Number(d.slice(5, 7)) <= 5;
  if (janToMay && d < SEASON_FROM && bumped >= SEASON_FROM && bumped <= SEASON_TO)
    return { date: bumped, corrected: d };
  return { error: `date ${d} outside the ${SEASON_FROM}..${SEASON_TO} season` };
}

const HEADER = ['DATE', 'HOME', 'AWAY', 'VENUE'];
const isBye = (s: string) => /^BYE$/i.test(s.trim());
const SPLIT_ROUND = /^TOP\s*6\s*\/\s*BOTTOM\s*6$/i;
const KO_BANNER = /^KNOCK-?\s*OUT/i;
const GROUP_BANNER = /^GROUP ([A-Z0-9]+)$/i;

/** Every non-empty cell text in a row, by column. */
function rowValues(ws: ExcelJS.Worksheet, r: number, width: number): unknown[] {
  const row = ws.getRow(r);
  const out: unknown[] = [];
  for (let c = 1; c <= width; c++) out.push(row.getCell(c).value);
  return out;
}

/** A banner row: one text repeated across every non-empty cell, no date. */
function bannerText(values: unknown[]): string | null {
  const texts = values.map(cellText).filter(Boolean);
  if (!texts.length || values.some((v) => isoDate(v))) return null;
  return texts.every((t) => t === texts[0]) && texts.length > 1 ? texts[0] : null;
}

/**
 * The knockout slot a sheet label proposes. `groupSeries` maps a group token ("A", "1") to the
 * group series id; `tags` maps a match tag ("Q1", "S2") to the KO fixture id; `leagueSeries`
 * is the sheet's own league series (veterans "2ND PLACE").
 */
export function proposeSlotRef(
  raw: string,
  ctx: {
    groupSeries: Map<string, string>;
    tags: Map<string, string>;
    leagueSeries?: string;
    firstKoFixture?: string;
  },
): KoSlotProposal | null {
  const t = raw.replace(/\s+/g, ' ').trim().toUpperCase();
  const groupRef = (g: string) => ctx.groupSeries.get(g);
  // "G1" names a group by banner order (the Women's T20 banners read GROUP A/B/C).
  const groupNote = (g: string) =>
    /^\d$/.test(g)
      ? { note: `G${g} read as the ${g}${['st', 'nd', 'rd'][Number(g) - 1] ?? 'th'} GROUP banner` }
      : {};
  let m = t.match(/^WINNER G(?:ROUP )?([A-Z0-9])$/) ?? t.match(/^GROUP ([A-Z0-9]) WINNER$/);
  if (m && groupRef(m[1]))
    return { raw, kind: 'pos', ref: `pos:${groupRef(m[1])}:1`, ...groupNote(m[1]) };
  m = t.match(/^RUNNER[- ]UP G(?:ROUP )?([A-Z0-9])$/);
  if (m && groupRef(m[1]))
    return { raw, kind: 'pos', ref: `pos:${groupRef(m[1])}:2`, ...groupNote(m[1]) };
  m = t.match(/^RUNNER[- ]UP (\d)$/);
  if (m)
    return {
      raw,
      kind: 'tbd',
      ref: `tbd:Runner-up ${m[1]}`,
      note: 'ranked runner-up across groups — no pos: ref can express it',
    };
  m = t.match(/^WINNER ([QS]\d)$/);
  if (m && ctx.tags.has(m[1])) return { raw, kind: 'win', ref: `win:${ctx.tags.get(m[1])}` };
  if (/^BEST 3RD+ PLACE$/.test(t)) return { raw, kind: 'tbd', ref: 'tbd:Best 3rd place' };
  if (/^SECOND BEST 3RD+ PLACE$/.test(t))
    return { raw, kind: 'tbd', ref: 'tbd:Second best 3rd place' };
  if (/^COMMUNITY CUP WINNER$/.test(t))
    return { raw, kind: 'tbd', ref: 'tbd:Community Cup winner' };
  m = t.match(/^(\d)(?:ST|ND|RD|TH) PLACE$/);
  if (m && ctx.leagueSeries) return { raw, kind: 'pos', ref: `pos:${ctx.leagueSeries}:${m[1]}` };
  if (/^SEMI-?FINAL WINNER$/.test(t) && ctx.firstKoFixture)
    return { raw, kind: 'win', ref: `win:${ctx.firstKoFixture}` };
  if (resolveTeamClub(t)) {
    const name = canonicalTeamName(t);
    return {
      raw,
      kind: 'team',
      ref: `team:${name}`,
      note: 'a named team in a knockout slot — confirm with the union',
    };
  }
  return null;
}

/** Is this a knockout placeholder label (not a real team)? Veterans playoff rows sit inline. */
function isKoLabel(s: string): boolean {
  const t = s.replace(/\s+/g, ' ').trim().toUpperCase();
  return (
    /^(\d)(ST|ND|RD|TH) PLACE$/.test(t) ||
    /^SEMI-?FINAL WINNER$/.test(t) ||
    /^WINNER\b/.test(t) ||
    /\bWINNER$/.test(t) ||
    /^RUNNER[- ]UP\b/.test(t) ||
    /3RD+ PLACE$/.test(t)
  );
}

interface PendingFixture {
  row: number;
  seriesId: string;
  date: string;
  time: string;
  timeSource: TimeSource;
  rawHome: string;
  rawAway: string;
  rawVenue: string;
}
interface PendingKo extends Omit<PendingFixture, 'seriesId'> {
  tag: string | null;
}

/**
 * Parse one sheet. Fail-closed: a row that is not blank, a title/header/banner, a BYE, a
 * split-round placeholder, a knockout placeholder or a complete fixture is an error. Dates
 * carry down from the last dated row (the Plan-B `consumeRow` running-date pattern); a dated
 * row in a T20 block restarts the morning (AM) session.
 */
export function parseTitansSheet(ws: ExcelJS.Worksheet, spec: TitansSheetSpec): ParsedTitansSheet {
  const out: ParsedTitansSheet = {
    spec,
    fixtures: [],
    ko: [],
    byes: [],
    banners: [],
    splitRounds: [],
    timeRows: [],
    dateCorrections: [],
    sideInferences: [],
    errors: [],
    warnings: [],
  };
  const width = Math.max(ws.columnCount, 6);
  const pending: PendingFixture[] = [];
  const pendingKo: PendingKo[] = [];
  // Group token → series id, by banner letter ("A") and by banner order ("1").
  const groupSeries = new Map<string, string>();
  spec.series
    .filter((s) => s.group)
    .forEach((s, i) => {
      groupSeries.set(s.group!.replace(/^GROUP /, ''), s.seriesId);
      groupSeries.set(String(i + 1), s.seriesId);
    });

  let headerSeen = false;
  let timeCol: number | null = null;
  let currentSeries: string | null = spec.layout === 'flat' ? spec.series[0].seriesId : null;
  let inKo = false;
  let date: string | null = null;
  let t20Half: { time: string; source: TimeSource } | null = null;
  let lastFixtureRow: { row: number; ref: PendingFixture | PendingKo } | null = null;

  for (let r = 1; r <= ws.rowCount; r++) {
    const values = rowValues(ws, r, width);
    const texts = values.map(cellText);
    if (texts.every((t) => !t) && !values.some((v) => isoDate(v))) continue;
    const where = `${spec.sheet} row ${r}`;
    if (texts.some((t) => /^TITANS CRICKET/i.test(t))) continue; // title row

    // Header row: DATE | HOME | AWAY | VENUE [| TIME].
    if (HEADER.every((h, i) => texts[i]?.toUpperCase() === h)) {
      headerSeen = true;
      const tc = texts.findIndex((t) => t.toUpperCase() === 'TIME');
      timeCol = tc >= 0 ? tc : null;
      continue;
    }
    const banner = bannerText(values);
    if (banner) {
      if (spec.layout === 't20' && GROUP_BANNER.test(banner)) {
        const g = banner.match(GROUP_BANNER)![1].toUpperCase();
        currentSeries = groupSeries.get(g) ?? null;
        if (!currentSeries)
          out.errors.push(`${where}: banner "${banner}" has no series in the manifest`);
        inKo = false;
        date = null;
        t20Half = null;
        continue;
      }
      if (KO_BANNER.test(banner)) {
        inKo = true;
        currentSeries = null;
        date = null;
        t20Half = null;
        continue;
      }
      if (!SPLIT_ROUND.test(banner)) {
        out.banners.push({ row: r, text: banner });
        continue;
      }
    }
    if (!headerSeen) {
      out.errors.push(`${where}: content before the DATE/HOME/AWAY/VENUE header`);
      continue;
    }

    const c1 = values[0];
    const home = texts[1] ?? '';
    const away = texts[2] ?? '';
    const venue = texts[3] ?? '';

    // Running date (carry-down).
    const sd = seasonDate(c1);
    if (sd && 'error' in sd) {
      out.errors.push(`${where}: ${sd.error}`);
      continue;
    }
    if (sd) {
      // A corrected year must still run forward from the sheet's running date — otherwise it
      // is not the 2026→2027 slip but a different error, and fatal.
      if (sd.corrected && date && sd.date < date) {
        out.errors.push(
          `${where}: date ${sd.corrected} reads as ${sd.date} after a year fix, but that is before the running date ${date}`,
        );
        continue;
      }
      date = sd.date;
      if (sd.corrected)
        out.dateCorrections.push(
          `${where}: ${sd.corrected} → ${sd.date} (year typo; Jan–May is 2027)`,
        );
      if (spec.layout === 't20') t20Half = { time: T20_AM_TIME, source: 't20-marker' };
    }
    // T20 AM/PM markers and stand-alone time rows sit in column A.
    const c1Time = !sd ? parseTitansTime(c1) : null;
    if (c1Time && spec.layout === 't20') {
      if (c1Time.source === 't20-marker') t20Half = c1Time;
      else if (!home && !away && !venue) {
        // "13H00" on its own row under a fixture: that fixture's real start time.
        if (!lastFixtureRow || lastFixtureRow.row !== r - 1)
          out.errors.push(
            `${where}: stand-alone time "${texts[0]}" with no fixture directly above`,
          );
        else {
          if (!plausibleSheetTime(c1Time.time))
            out.errors.push(`${where}: start time ${c1Time.time} outside ${SHEET_TIME_RANGE}`);
          lastFixtureRow.ref.time = c1Time.time;
          lastFixtureRow.ref.timeSource = 'sheet';
          out.timeRows.push({ row: r, appliedTo: lastFixtureRow.row, time: c1Time.time });
        }
        continue;
      }
    } else if (!sd && texts[0]) {
      out.errors.push(`${where}: unreadable column A "${texts[0]}"`);
      continue;
    }
    if (!home && !away && !venue) continue; // a marker-only row ("AM" with no fixture)

    if (SPLIT_ROUND.test(home) || SPLIT_ROUND.test(away)) {
      if (!date) out.errors.push(`${where}: split-round row with no date`);
      else out.splitRounds.push({ row: r, date });
      continue;
    }
    if (!date) {
      out.errors.push(`${where}: no date (and none to carry down) — "${home}" v "${away}"`);
      continue;
    }
    if (isBye(home) || isBye(away)) {
      out.byes.push({ row: r, date, team: isBye(home) ? away : home });
      continue;
    }
    if (!home || !away || !venue) {
      out.errors.push(`${where}: incomplete fixture "${home}" v "${away}" @ "${venue}"`);
      continue;
    }

    // Time: the TIME column (flat sheets), the T20 session marker, else provisional.
    let time: { time: string; source: TimeSource };
    if (spec.layout === 't20') time = t20Half ?? { time: T20_AM_TIME, source: 't20-marker' };
    else {
      const raw = timeCol != null ? values[timeCol] : null;
      const hasRaw = raw instanceof Date || cellText(raw) !== '';
      const parsed = hasRaw ? parseTitansTime(raw) : null;
      if (hasRaw && !parsed) out.errors.push(`${where}: unreadable time "${cellText(raw)}"`);
      if (parsed && !plausibleSheetTime(parsed.time))
        out.errors.push(
          `${where}: start time ${parsed.time} ("${cellText(raw) || 'time cell'}") outside ${SHEET_TIME_RANGE} — an AM/PM slip?`,
        );
      time = parsed ?? { time: provisionalTime(spec.junior), source: 'provisional' };
    }
    for (let c = 4; c < values.length; c++)
      if (c !== timeCol && cellText(values[c]))
        out.warnings.push(
          `${where}: stray value "${cellText(values[c])}" in column ${c + 1} ignored`,
        );

    const isKo = inKo || isKoLabel(home) || isKoLabel(away);
    if (isKo) {
      const tag = venue.match(/\(([QS]\d)\)\s*$/)?.[1] ?? null;
      const k: PendingKo = {
        row: r,
        date,
        time: time.time,
        timeSource: time.source,
        rawHome: home,
        rawAway: away,
        rawVenue: venue,
        tag,
      };
      pendingKo.push(k);
      lastFixtureRow = { row: r, ref: k };
      continue;
    }
    if (!currentSeries) {
      out.errors.push(`${where}: fixture outside any GROUP block — "${home}" v "${away}"`);
      continue;
    }
    const f: PendingFixture = {
      row: r,
      seriesId: currentSeries,
      date,
      time: time.time,
      timeSource: time.source,
      rawHome: home,
      rawAway: away,
      rawVenue: venue,
    };
    pending.push(f);
    lastFixtureRow = { row: r, ref: f };
  }

  // Un-numbered sides (per sheet), then canonical names + venues.
  const inference = inferUnnumberedSides(pending.flatMap((f) => [f.rawHome, f.rawAway]));
  for (const e of inference.errors) out.errors.push(`${spec.sheet}: ${e}`);
  for (const [from, to] of inference.rewrites) out.sideInferences.push({ from, to });
  const name = (raw: string) => {
    const c = canonicalTeamName(raw);
    return inference.rewrites.get(c) ?? c;
  };
  const seen = new Set<string>();
  for (const p of pending) {
    const f: TitansRawFixture = {
      sheet: spec.sheet,
      row: p.row,
      seriesId: p.seriesId,
      date: p.date,
      time: p.time,
      timeSource: p.timeSource,
      home: name(p.rawHome),
      away: name(p.rawAway),
      rawHome: p.rawHome,
      rawAway: p.rawAway,
      venue: isTbcVenue(p.rawVenue) ? null : canonicalVenueName(p.rawVenue),
      rawVenue: p.rawVenue,
    };
    const where = `${spec.sheet} row ${p.row}`;
    if (f.home === f.away) out.errors.push(`${where}: "${f.home}" plays itself`);
    const dup = `${f.seriesId}|${f.date}|${f.home}|${f.away}`;
    if (seen.has(dup))
      out.errors.push(`${where}: duplicate fixture ${f.home} v ${f.away} on ${f.date}`);
    seen.add(dup);
    out.fixtures.push(f);
  }

  // Knockout rows → proposed slot refs. Fixture ids follow row order; Q/S tags come from the
  // venue column ("WINNER GA (Q1)").
  if (pendingKo.length) {
    const koSeriesId = spec.koSeriesId;
    if (!koSeriesId)
      out.errors.push(`${spec.sheet}: ${pendingKo.length} knockout row(s) but no koSeriesId`);
    const tags = new Map<string, string>();
    pendingKo.forEach((k, i) => {
      if (k.tag) tags.set(k.tag, `f${i + 1}`);
    });
    const ctx = {
      groupSeries,
      tags,
      leagueSeries: spec.layout === 'flat' ? spec.series[0].seriesId : undefined,
      firstKoFixture: 'f1',
    };
    pendingKo.forEach((k, i) => {
      const home = proposeSlotRef(k.rawHome, ctx);
      const away = proposeSlotRef(k.rawAway, ctx);
      const where = `${spec.sheet} row ${k.row}`;
      if (!home) out.errors.push(`${where}: unrecognised knockout label "${k.rawHome}"`);
      if (!away) out.errors.push(`${where}: unrecognised knockout label "${k.rawAway}"`);
      if (!home || !away || !koSeriesId) return;
      out.ko.push({
        sheet: spec.sheet,
        row: k.row,
        koSeriesId,
        fixtureId: `f${i + 1}`,
        tag: k.tag,
        date: k.date,
        time: k.time,
        timeSource: k.timeSource,
        rawHome: k.rawHome,
        rawAway: k.rawAway,
        rawVenue: k.rawVenue,
        home,
        away,
      });
    });
  }

  // Counts: per series, and knockout rows.
  for (const s of spec.series) {
    const n = out.fixtures.filter((f) => f.seriesId === s.seriesId).length;
    if (n !== s.expected)
      out.errors.push(
        `${spec.sheet} → ${s.seriesId}: ${n} fixtures parsed, expected ${s.expected}`,
      );
  }
  if (pendingKo.length !== spec.koRows)
    out.errors.push(`${spec.sheet}: ${pendingKo.length} knockout row(s), expected ${spec.koRows}`);
  return out;
}

export function parseTitansWorkbook(
  wb: ExcelJS.Workbook,
  sheets: TitansSheetSpec[] = TITANS_FIXTURE_SHEETS,
): { sheets: ParsedTitansSheet[]; errors: string[] } {
  const parsed: ParsedTitansSheet[] = [];
  const errors: string[] = [];
  const known = new Set(sheets.map((s) => s.sheet));
  for (const ws of wb.worksheets)
    if (!known.has(ws.name.trim())) errors.push(`sheet "${ws.name}" is not in the manifest`);
  for (const spec of sheets) {
    const ws = wb.worksheets.find((w) => w.name.trim() === spec.sheet);
    if (!ws) {
      errors.push(`sheet "${spec.sheet}" not found`);
      continue;
    }
    const p = parseTitansSheet(ws, spec);
    errors.push(...p.errors);
    parsed.push(p);
  }
  const total = parsed.reduce((n, s) => n + s.fixtures.length, 0);
  if (!errors.length && total !== EXPECTED_TOTAL_FIXTURES)
    errors.push(`${total} fixtures parsed, expected ${EXPECTED_TOTAL_FIXTURES}`);
  return { sheets: parsed, errors };
}
