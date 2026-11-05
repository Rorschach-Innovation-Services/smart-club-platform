/**
 * Tuskers (KZNICU) 2026-27 FIXTURES — pure data + pure parsing helpers, NO AWS imports.
 * Consumed by import-tuskers-fixtures.ts and bootstrap-tuskers-fixture-prereqs.ts; every
 * `--parse-only` path runs under plain `npx tsx` (no `sst shell`, no AWS creds).
 *
 * Two source workbooks (both read-only):
 *   - mens: "Mens Club League Fixtures Season 2026_2027.xlsx" — in scope are ONLY its two
 *     visible sheets, 'Prem T20 Fixtures' and 'Prem 50 Overs Fixtures'. Its hidden sheets
 *     (2025/26 juniors + a stale veterans copy) are asserted hidden and skipped.
 *   - vets: "Copy of Veterans_Fixtures_2026_2027.xlsx" — the visible 'Veterans Fixtures'
 *     sheet is the authoritative veterans source.
 *
 * Sections:
 *   1. SHEET MANIFEST — sheet → series, MEASURED fixture counts (a mismatch is fatal), the
 *      hidden-sheet assertions.
 *   2. TEAMS — every sheet spelling → one club (ids via clubIdFromName, never hand-typed),
 *      incl. the 3 veterans-only clubs the prereqs bootstrap creates. One side per club per
 *      league ⇒ teamId === clubId.
 *   3. VENUES — home grounds (from the 50-overs header block), a MISSPELLINGS-ONLY alias table.
 *   4. ROW RULES — excluded rows (with reasons), the T20 side-table reschedules, the per-cell
 *      team corrections. Every entry must match exactly one row (a stale entry is fatal).
 *   5. PARSERS — parseMens50Sheet / parseMensT20Sheet / parseVetsSheet. Fail-closed: any
 *      row that is not blank, a known title/banner, a listed exclusion or a complete fixture
 *      is an error.
 */
import type ExcelJS from 'exceljs';
import { cellText, cellDate, cellTime } from './xlsx-cells.js';
import { isoDate } from './import-planb-fixtures.js';
import { clubIdFromName } from './club-id.js';
import { normaliseName, groundKey, DEFAULT_VENUE_ALIASES } from './venue-clash.js';
import { CLUB_MAP } from './tuskers-import-map.js';

export const TUSKERS_TENANT = 'tuskers';
/** Every series this importer writes carries this id prefix (`--revert` / `--release` scope). */
export const TUSKERS_SERIES_PREFIX = 's-tuskers-';

/** Season window — a date outside it is a bad read or a year typo, not data. */
export const SEASON_FROM = '2026-09-01';
export const SEASON_TO = '2027-05-31';

// ───────────────────────── 1. Sheet manifest ─────────────────────────

export type TuskersWorkbook = 'mens' | 'vets';
export type TuskersLayout = 'mens50' | 'mensT20' | 'vets';

export interface TuskersSheetSpec {
  workbook: TuskersWorkbook;
  /** Worksheet name, compared trimmed. */
  sheet: string;
  layout: TuskersLayout;
  seriesId: string;
  leagueKey: string;
  /** The half of the series name after the league label. */
  part: string;
  seriesType: string;
  maxOvers: number;
  /** Measured real-fixture count — any mismatch is fatal. */
  expected: number;
  /** Measured number of distinct teams in the sheet's team list. */
  teams: number;
  /** Each unordered pairing must meet exactly this many times (round-robin assert). */
  meetings: number;
  /** Knockout series written from this sheet's playoff rows (absent ⇒ none written). */
  koSeriesId?: string;
  /** Knockout rows this sheet must carry (written to koSeriesId). */
  koRows: number;
}

const T20 = { seriesType: 'Twenty20 (16-25 overs)', maxOvers: 20 } as const;
const OD50 = { seriesType: 'One-Day (40-50 overs)', maxOvers: 50 } as const;

export const T20_SERIES_ID = `${TUSKERS_SERIES_PREFIX}premier-league-t20`;
/** Reserved for the Prem T20 Eliminator/Final — HELD BACK (see EXCLUDED_ROWS): never written by
 * this importer; the real playoff is added via the console once KZNICU confirms the outcome. */
export const T20_KO_SERIES_ID = `${TUSKERS_SERIES_PREFIX}premier-league-t20-ko`;
export const OD50_SERIES_ID = `${TUSKERS_SERIES_PREFIX}premier-league-50-overs`;
export const VETS_SERIES_ID = `${TUSKERS_SERIES_PREFIX}veterans-league`;
export const VETS_KO_SERIES_ID = `${TUSKERS_SERIES_PREFIX}veterans-league-ko`;

/**
 * Counts measured by `--parse-only` against the real workbooks (5 Nov 2026):
 *   Prem T20: 8 teams, single round robin = 28 (3 Week-5 duplicate rows + the held-back
 *     Eliminator/Final + the Community Cup rows excluded);
 *   Prem 50 Overs: 8 teams, double round robin = 56 (Club Champs playoff excluded);
 *   Veterans: 7 teams, single round robin = 21, plus the Eliminator + Final (2 KO rows).
 */
export const TUSKERS_FIXTURE_SHEETS: TuskersSheetSpec[] = [
  {
    workbook: 'mens',
    sheet: 'Prem T20 Fixtures',
    layout: 'mensT20',
    seriesId: T20_SERIES_ID,
    leagueKey: 'premier-league',
    part: 'T20',
    ...T20,
    expected: 28,
    teams: 8,
    meetings: 1,
    koRows: 0,
  },
  {
    workbook: 'mens',
    sheet: 'Prem 50 Overs Fixtures',
    layout: 'mens50',
    seriesId: OD50_SERIES_ID,
    leagueKey: 'premier-league',
    part: '50 Overs',
    ...OD50,
    expected: 56,
    teams: 8,
    meetings: 2,
    koRows: 0,
  },
  {
    workbook: 'vets',
    sheet: 'Veterans Fixtures',
    layout: 'vets',
    seriesId: VETS_SERIES_ID,
    leagueKey: 'veterans-league',
    part: 'T20 Night League',
    ...T20,
    expected: 21,
    teams: 7,
    meetings: 1,
    koSeriesId: VETS_KO_SERIES_ID,
    koRows: 2,
  },
];

/** Sheets each workbook carries that are OUT of scope: they must be hidden (a visible one means
 * the union changed the workbook — refuse rather than guess). */
export const EXPECTED_HIDDEN_SHEETS: Record<TuskersWorkbook, string[]> = {
  mens: ['Jnr League Teams', 'U11 Fixtures', 'U13 Fixtures', 'U16 Fixtures', 'Veterans Fixtures'],
  vets: [],
};

export const EXPECTED_TOTAL_FIXTURES = TUSKERS_FIXTURE_SHEETS.reduce((n, s) => n + s.expected, 0);

/** Every series id this importer may write (league series + the veterans KO). */
export const WRITABLE_SERIES_IDS = [
  ...TUSKERS_FIXTURE_SHEETS.map((s) => s.seriesId),
  ...TUSKERS_FIXTURE_SHEETS.flatMap((s) => (s.koSeriesId ? [s.koSeriesId] : [])),
];

/** League keys the sheets use — each must already exist on the tenant (never minted here). */
export const TUSKERS_LEAGUE_KEYS = [...new Set(TUSKERS_FIXTURE_SHEETS.map((s) => s.leagueKey))];

export const TUSKERS_LEAGUE_LABELS: Record<string, string> = {
  'premier-league': 'Premier League',
  'veterans-league': 'Veterans League',
};

export function seriesNameFor(
  spec: { leagueKey: string; part: string },
  labelOf: (key: string) => string = (k) => TUSKERS_LEAGUE_LABELS[k] ?? k,
): string {
  return spec.part ? `${labelOf(spec.leagueKey)} · ${spec.part}` : labelOf(spec.leagueKey);
}

// ───────────────────────── Times ─────────────────────────

export type TimeSource = 'sheet' | 't20-marker' | 'side-table' | 'provisional';

/** Prem T20 session markers ("Sunday AM"/"Sunday PM"): provisional starts. */
export const T20_AM_TIME = '09:00';
export const T20_PM_TIME = '13:30';
/** Prem 50 Overs rows carry no time — provisional start, flagged in the report. */
export const OD50_DEFAULT_TIME = '09:30';

/** A sheet time outside these hours is a typo, not a start time (vets play evenings). */
export function plausibleSheetTime(time: string): boolean {
  return time >= '07:00' && time <= '21:00';
}

// ───────────────────────── 2. Teams ─────────────────────────

export interface TuskersTeam {
  /** Canonical club name (Club.name on a created club). */
  name: string;
  /** clubIdFromName(name). */
  id: string;
  /** Uppercased, whitespace-collapsed sheet spellings that name this club. */
  spellings: string[];
  /** A veterans-only club the prereqs bootstrap creates (not in the compliance CLUB_MAP). */
  created?: boolean;
}

const mapClub = (name: string): { name: string; id: string } => {
  const hit = CLUB_MAP.find((c) => c.name === name);
  if (!hit) throw new Error(`tuskers-fixture-map: "${name}" is not a CLUB_MAP club`);
  return { name: hit.name, id: hit.id };
};

/** Veterans-only clubs the bootstrap creates (`leagues: []`, no PII). */
export const NEW_VETS_CLUBS: Array<{ name: string; id: string }> = [
  'Midlands Cricket Club',
  'Zingari Cricket Club',
  'Cosmos Cricket Club',
].map((name) => ({ name, id: clubIdFromName(name) }));

export const TUSKERS_TEAMS: TuskersTeam[] = [
  {
    ...mapClub('Standard Cricket Club'),
    spellings: ['STANDARD', 'STANDARD CC'],
  },
  {
    ...mapClub('UKZN Cricket Club'),
    spellings: ['UKZN', 'UKZN CC', 'UKZN VETS'],
  },
  {
    ...mapClub('Lancashire Cricket Club'),
    spellings: ['LANCASHIRE', 'LANCASHIRE CC', 'LANCASHIRE VETS'],
  },
  {
    ...mapClub('Masibemunye Cricket Club'),
    spellings: ['MASIBEMUNYE', 'MASIBEMUNYE CC'],
  },
  {
    // The sheets say "MCC"; every club document says Maritzburg Cricket Club.
    ...mapClub('Maritzburg Cricket Club'),
    spellings: ['MCC'],
  },
  {
    ...mapClub('Howick Cricket Club'),
    spellings: ['HOWICK', 'HOWICK CC', 'HOWICK VETS'],
  },
  {
    ...mapClub('Greytown Cricket Club'),
    spellings: ['GREYTOWN', 'GREYTOWN CC'],
  },
  {
    ...mapClub('Young Natalians Cricket Club'),
    spellings: [
      'YOUNG NATALIANS',
      'YOUNG NATALIANS CC',
      'YOUNG NATS',
      'YOUNG NATS CC',
      'YOUNG NATS VETS',
    ],
  },
  { ...NEW_VETS_CLUBS[0], spellings: ['MIDLANDS CC', 'MIDLANDS VETS'], created: true },
  { ...NEW_VETS_CLUBS[1], spellings: ['ZINGARI CC', 'ZINGARI VETS'], created: true },
  { ...NEW_VETS_CLUBS[2], spellings: ['COSMOS CC', 'COSMOS VETS'], created: true },
];

/** Uppercase + whitespace collapse — the form `spellings` are written in. */
export function canonicalSpelling(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toUpperCase();
}

const TEAM_BY_SPELLING = (() => {
  const m = new Map<string, TuskersTeam>();
  for (const t of TUSKERS_TEAMS)
    for (const s of t.spellings) {
      if (m.has(s)) throw new Error(`tuskers-fixture-map: spelling "${s}" claimed twice`);
      m.set(s, t);
    }
  return m;
})();

/** The club a sheet team name names, or undefined (fatal at the gate). */
export function resolveTeam(raw: string): TuskersTeam | undefined {
  return TEAM_BY_SPELLING.get(canonicalSpelling(raw));
}

// ───────────────────────── 3. Venues ─────────────────────────

/** Home grounds as listed in the 'Prem 50 Overs Fixtures' header block (asserted on parse). */
export const TUSKERS_HOME_VENUES: Record<string, string> = {
  [mapClub('Standard Cricket Club').id]: 'Collegians',
  [mapClub('UKZN Cricket Club').id]: 'Varsity 1 Oval',
  [mapClub('Lancashire Cricket Club').id]: 'MP Oval',
  [mapClub('Masibemunye Cricket Club').id]: 'Alex High School',
  [mapClub('Maritzburg Cricket Club').id]: 'Linpark Oval',
  [mapClub('Howick Cricket Club').id]: 'Howick High',
  [mapClub('Greytown Cricket Club').id]: 'Wembley College',
  [mapClub('Young Natalians Cricket Club').id]: 'Noodesberg',
};

export interface TuskersVenueSpelling {
  /** Canonical ground name (what the registry row is called). */
  name: string;
  /** Misspellings / short forms of THAT SAME ground only. */
  aliases: string[];
  note: string;
}

/** Every ground the three sheets use, canonical spelling first. Aliases are misspellings or
 * short forms of the same field only — never a different field. */
export const TUSKERS_VENUE_SPELLINGS: TuskersVenueSpelling[] = [
  { name: 'Collegians', aliases: [], note: "Standard's home ground" },
  {
    name: 'Varsity 1 Oval',
    aliases: ['Varsity 1', 'Varstiy 1'],
    note: 'UKZN home ground; the veterans sheet writes "Varsity 1" (once "Varstiy 1")',
  },
  { name: 'MP Oval', aliases: [], note: "Lancashire's home ground" },
  { name: 'Alex High School', aliases: [], note: "Masibemunye's home ground" },
  {
    name: 'Linpark Oval',
    aliases: ['Linpark'],
    note: 'MCC home ground; the T20 sheet drops "Oval"',
  },
  {
    name: 'Howick High',
    aliases: ['Howick'],
    note: 'Howick home ground; the 50-overs Week 11 row writes the ground as "Howick"',
  },
  { name: 'Wembley College', aliases: [], note: "Greytown's home ground" },
  {
    name: 'Noodesberg',
    aliases: [],
    note: "Young Natalians' home ground (as the union spells it)",
  },
  { name: 'PMB Oval', aliases: [], note: 'T20 Sunday-PM / evening reschedule ground' },
  { name: 'Eston', aliases: [], note: 'Veterans night-league ground' },
];

/** normaliseName(alias) → normaliseName(canonical); throws on a collision (a map bug). */
export function buildTuskersVenueAliases(specs: TuskersVenueSpelling[]): Record<string, string> {
  const canonicalKeys = new Map<string, string>();
  for (const s of specs) {
    const k = normaliseName(s.name);
    if (canonicalKeys.has(k))
      throw new Error(`tuskers venues: "${s.name}" and "${canonicalKeys.get(k)}" normalise alike`);
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
          `tuskers venues: alias "${a}" collides with ground "${canonicalKeys.get(k)}"`,
        );
      if (aliases[k] && aliases[k] !== target)
        throw new Error(`tuskers venues: alias "${a}" claimed by two grounds`);
      aliases[k] = target;
    }
  }
  return aliases;
}

/** What the bootstrap merges into competitionDefaults.venueAliases. */
export const TUSKERS_VENUE_ALIASES: Record<string, string> =
  buildTuskersVenueAliases(TUSKERS_VENUE_SPELLINGS);

/** The release gate's resolution (code default, tuskers map wins on the same key). */
export const TUSKERS_GATE_ALIASES: Record<string, string> = {
  ...DEFAULT_VENUE_ALIASES,
  ...TUSKERS_VENUE_ALIASES,
};

const VENUE_BY_KEY = new Map(
  TUSKERS_VENUE_SPELLINGS.map((v) => [normaliseName(v.name), v] as const),
);

/** "TBC", "T.B.C", blank — a fixture with no ground yet. */
export function isTbcVenue(raw: string | null | undefined): boolean {
  const t = (raw ?? '').replace(/[.\s]/g, '').toUpperCase();
  return !t || /^TB[CA]$/.test(t);
}

export function tuskersGroundKey(raw: string): string {
  return groundKey(raw, TUSKERS_GATE_ALIASES);
}

/** The canonical ground for a raw sheet venue, or undefined (an unknown ground is fatal). */
export function canonicalVenue(raw: string): TuskersVenueSpelling | undefined {
  return VENUE_BY_KEY.get(groundKey(raw, TUSKERS_VENUE_ALIASES));
}

// ───────────────────────── 4. Row rules ─────────────────────────

export type ExclusionKind = 'excluded' | 'held-back' | 'duplicate';

export interface ExcludedRow {
  workbook: TuskersWorkbook;
  sheet: string;
  row: number;
  /** Text the row must contain (case-insensitive) — guards against a shifted workbook. */
  contains: string;
  kind: ExclusionKind;
  /** 'duplicate' only: the kept row this one repeats exactly (same date, teams, venue). */
  duplicateOf?: number;
  reason: string;
}

export const EXCLUDED_ROWS: ExcludedRow[] = [
  {
    workbook: 'mens',
    sheet: 'Prem 50 Overs Fixtures',
    row: 59,
    contains: 'Club Champs',
    kind: 'excluded',
    reason: 'Club Champs playoff banner (cross-competition, TBC) — not a league fixture',
  },
  {
    workbook: 'mens',
    sheet: 'Prem 50 Overs Fixtures',
    row: 61,
    contains: 'Winner Inland',
    kind: 'excluded',
    reason: 'Club Champs "Winner Inland vs Winner Coastals" — cross-competition placeholder',
  },
  ...[65, 66, 67].map(
    (row): ExcludedRow => ({
      workbook: 'mens',
      sheet: 'Prem T20 Fixtures',
      row,
      contains: 'vs',
      kind: 'duplicate',
      duplicateOf: row - 44,
      reason: `Week 5 (1 Nov, Sunday AM) repeats row ${row - 44} of the 1 Nov block exactly`,
    }),
  ),
  {
    workbook: 'mens',
    sheet: 'Prem T20 Fixtures',
    row: 70,
    contains: '2nd Place',
    kind: 'held-back',
    reason:
      'T20 Eliminator (1 Nov, already past): without pool results its pos: refs never resolve — confirm the playoff outcome with KZNICU and add it via the console',
  },
  {
    workbook: 'mens',
    sheet: 'Prem T20 Fixtures',
    row: 73,
    contains: 'Community Cup',
    kind: 'excluded',
    reason: 'Community Cup T20 play-off banner — a different competition',
  },
  {
    workbook: 'mens',
    sheet: 'Prem T20 Fixtures',
    row: 75,
    contains: 'Premier T20',
    kind: 'excluded',
    reason: 'Community Cup T20 play-off "Premier T20 | TBC" — a different competition',
  },
  {
    workbook: 'mens',
    sheet: 'Prem T20 Fixtures',
    row: 81,
    contains: '1st Place',
    kind: 'held-back',
    reason: 'T20 Final (1st Place v Winner of Eliminator) — held back with the Eliminator',
  },
];

/** Held-back FIXTURES (parsed, reported, never written). The T20 playoff is held back at the
 * row level (EXCLUDED_ROWS kind 'held-back'), so this is empty. */
export const HELD_BACK: Array<{ seriesId: string; date: string; home: string; away: string }> = [];

export interface T20Reschedule {
  /** The pool fixture's sides as the Sunday-PM section names them (either order). */
  home: string;
  away: string;
  /** The side table's date / start / ground, applied to that fixture. */
  date: string;
  time: string;
  venue: string;
}

/**
 * The Prem T20 side table (rows 57–60, columns H–M): evening slots at PMB Oval for three
 * fixtures that also sit in the Week 4 Sunday-PM section. Applied as date/time/venue overrides
 * of that ONE fixture (never imported twice). The parser asserts the side table says exactly
 * this, and each entry must match exactly one parsed fixture.
 */
export const T20_RESCHEDULES: T20Reschedule[] = [
  { home: 'MCC', away: 'Greytown', date: '2026-10-16', time: '18:00', venue: 'PMB Oval' },
  {
    home: 'Masibemunye',
    away: 'Young Nats',
    date: '2026-10-23',
    time: '18:00',
    venue: 'PMB Oval',
  },
  { home: 'Lancashire', away: 'Howick', date: '2026-10-25', time: '17:30', venue: 'PMB Oval' },
];

/** A single sheet cell whose team text is wrong, corrected explicitly (never a global alias). */
export interface TeamCellFix {
  workbook: TuskersWorkbook;
  sheet: string;
  row: number;
  /** The raw cell text (compared canonicalised). */
  raw: string;
  /** The sheet spelling it stands for. */
  team: string;
  reason: string;
}

export const TEAM_CELL_FIXES: TeamCellFix[] = [
  {
    workbook: 'mens',
    sheet: 'Prem 50 Overs Fixtures',
    row: 44,
    raw: 'Howick High',
    team: 'Howick CC',
    reason:
      'Week 12 "MCC vs Howick High": the return of Week 5 "Howick CC vs MCC" — Howick High is Howick\'s ground, typed in the team column',
  },
];

/** Weekday banner typos the veterans sheet may carry ("Satruday"). */
const WEEKDAY_TYPOS: Record<string, string> = { SATRUDAY: 'SATURDAY', FRIADY: 'FRIDAY' };
const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
export function weekdayName(raw: string): string | null {
  const t = canonicalSpelling(raw);
  const w = WEEKDAY_TYPOS[t] ?? t;
  return WEEKDAYS.includes(w) ? w : null;
}
export function weekdayOf(iso: string): string {
  return WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
}

// ───────────────────────── 5. Parsers ─────────────────────────

export interface TuskersRawFixture {
  sheet: string;
  row: number;
  seriesId: string;
  date: string;
  time: string;
  timeSource: TimeSource;
  rawHome: string;
  rawAway: string;
  /** Resolved club ids (CLUB_MAP / NEW_VETS_CLUBS id; the importer applies --map-club). */
  home: string;
  away: string;
  /** Canonical ground name, or null for TBC. */
  venue: string | null;
  rawVenue: string;
  /** Set when a side-table reschedule moved this fixture. */
  rescheduledFrom?: { date: string; time: string; venue: string | null };
}

export interface TuskersKoRow {
  sheet: string;
  row: number;
  koSeriesId: string;
  fixtureId: string;
  stage: string;
  date: string;
  time: string;
  rawHome: string;
  rawAway: string;
  rawVenue: string;
  /** `pos:<seriesId>:<rank>` / `win:f<n>`. */
  home: string;
  away: string;
}

export interface ParsedTuskersSheet {
  spec: TuskersSheetSpec;
  fixtures: TuskersRawFixture[];
  ko: TuskersKoRow[];
  excluded: Array<ExcludedRow & { text: string }>;
  reschedules: Array<T20Reschedule & { appliedTo: number }>;
  cellFixes: TeamCellFix[];
  /** Team list read from the sheet's header block (club ids). */
  teamList: string[];
  /** 50 overs only: the header block's home grounds (club id → ground). */
  homeVenues?: Record<string, string>;
  errors: string[];
  warnings: string[];
}

function emptyParsed(spec: TuskersSheetSpec): ParsedTuskersSheet {
  return {
    spec,
    fixtures: [],
    ko: [],
    excluded: [],
    reschedules: [],
    cellFixes: [],
    teamList: [],
    errors: [],
    warnings: [],
  };
}

const cell = (ws: ExcelJS.Worksheet, r: number, c: number): unknown =>
  ws.getRow(r).getCell(c).value;
const txt = (ws: ExcelJS.Worksheet, r: number, c: number): string => cellText(cell(ws, r, c));
const rowTexts = (ws: ExcelJS.Worksheet, r: number): string[] => {
  const out: string[] = [];
  for (let c = 1; c <= Math.max(ws.columnCount, 1); c++) {
    const v = cell(ws, r, c);
    const t = cellText(v) || (cellDate(v) ?? '');
    out.push(t);
  }
  return out;
};
const isVs = (s: string) => /^vs?\.?$/i.test(s.trim());

function seasonDate(v: unknown): string | { error: string } | null {
  const d = cellDate(v) ?? isoDate(v) ?? undefined;
  if (!d) return null;
  if (d < SEASON_FROM || d > SEASON_TO)
    return { error: `date ${d} outside the ${SEASON_FROM}..${SEASON_TO} season` };
  return d;
}

/** The exclusion entry for a sheet row (and whether its text check passes). */
function exclusionFor(
  ws: ExcelJS.Worksheet,
  spec: TuskersSheetSpec,
  r: number,
  rules: ExcludedRow[],
): (ExcludedRow & { text: string }) | { error: string } | null {
  const rule = rules.find(
    (e) => e.workbook === spec.workbook && e.sheet === spec.sheet && e.row === r,
  );
  if (!rule) return null;
  const text = rowTexts(ws, r).filter(Boolean).join(' | ');
  if (!text.toLowerCase().includes(rule.contains.toLowerCase()))
    return {
      error: `${spec.sheet} row ${r}: listed exclusion expects "${rule.contains}" but the row reads "${text}" — workbook changed?`,
    };
  return { ...rule, text };
}

/** Shared tail: team resolution + per-cell fixes, then the fixture counts and round robin. */
function resolveSide(
  out: ParsedTuskersSheet,
  r: number,
  raw: string,
  fixes: TeamCellFix[],
): string | null {
  const fix = fixes.find(
    (f) =>
      f.workbook === out.spec.workbook &&
      f.sheet === out.spec.sheet &&
      f.row === r &&
      canonicalSpelling(f.raw) === canonicalSpelling(raw),
  );
  if (fix) out.cellFixes.push(fix);
  const team = resolveTeam(fix ? fix.team : raw);
  if (!team) {
    out.errors.push(`${out.spec.sheet} row ${r}: unknown team "${raw}"`);
    return null;
  }
  return team.id;
}

function resolveVenue(out: ParsedTuskersSheet, r: number, raw: string): string | null {
  if (isTbcVenue(raw)) return null;
  const v = canonicalVenue(raw);
  if (!v) {
    out.errors.push(`${out.spec.sheet} row ${r}: unknown ground "${raw}"`);
    return null;
  }
  return v.name;
}

function finish(out: ParsedTuskersSheet, opts: { fixes: TeamCellFix[]; rules: ExcludedRow[] }) {
  const { spec } = out;
  // Every listed exclusion / cell fix for this sheet must have matched exactly one row.
  for (const e of opts.rules.filter((x) => x.workbook === spec.workbook && x.sheet === spec.sheet))
    if (!out.excluded.some((x) => x.row === e.row))
      out.errors.push(`${spec.sheet}: listed exclusion for row ${e.row} matched no row`);
  for (const f of opts.fixes.filter((x) => x.workbook === spec.workbook && x.sheet === spec.sheet))
    if (out.cellFixes.filter((x) => x === f).length !== 1)
      out.errors.push(
        `${spec.sheet}: team cell fix row ${f.row} "${f.raw}" matched ${out.cellFixes.filter((x) => x === f).length} cell(s), expected 1`,
      );
  // Duplicates by date + pairing, self-play.
  const seen = new Set<string>();
  for (const f of out.fixtures) {
    if (f.home === f.away)
      out.errors.push(`${spec.sheet} row ${f.row}: "${f.rawHome}" plays itself`);
    const k = `${f.date}|${[f.home, f.away].sort().join('|')}`;
    if (seen.has(k))
      out.errors.push(`${spec.sheet} row ${f.row}: duplicate fixture ${f.rawHome} v ${f.rawAway}`);
    seen.add(k);
    if (!plausibleSheetTime(f.time))
      out.errors.push(`${spec.sheet} row ${f.row}: start ${f.time} outside 07:00–21:00`);
  }
  // Round robin: every pairing of the team list meets exactly `meetings` times.
  const teams = new Set(out.teamList);
  if (teams.size !== spec.teams)
    out.errors.push(`${spec.sheet}: team list has ${teams.size} team(s), expected ${spec.teams}`);
  const meet = new Map<string, number>();
  for (const f of out.fixtures) {
    for (const t of [f.home, f.away])
      if (!teams.has(t))
        out.errors.push(`${spec.sheet} row ${f.row}: ${t} is not in the sheet's team list`);
    const k = [f.home, f.away].sort().join('|');
    meet.set(k, (meet.get(k) ?? 0) + 1);
  }
  const list = [...teams].sort();
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const n = meet.get(`${list[i]}|${list[j]}`) ?? 0;
      if (n !== spec.meetings)
        out.errors.push(
          `${spec.sheet}: ${list[i]} v ${list[j]} meet ${n} time(s), expected ${spec.meetings}`,
        );
    }
  if (out.fixtures.length !== spec.expected)
    out.errors.push(
      `${spec.sheet} → ${spec.seriesId}: ${out.fixtures.length} fixtures parsed, expected ${spec.expected}`,
    );
  if (out.ko.length !== spec.koRows)
    out.errors.push(`${spec.sheet}: ${out.ko.length} knockout row(s), expected ${spec.koRows}`);
}

export interface ParseOptions {
  rules?: ExcludedRow[];
  fixes?: TeamCellFix[];
  reschedules?: T20Reschedule[];
}

/**
 * 'Prem 50 Overs Fixtures': a "Teams | Home Venue" header block, then two side-by-side week
 * blocks (A–E and G–K): `Week N | <date> | … | Venue` banners over `home | vs | away | venue`
 * rows. No times on the sheet ⇒ OD50_DEFAULT_TIME (provisional).
 */
export function parseMens50Sheet(
  ws: ExcelJS.Worksheet,
  spec: TuskersSheetSpec,
  opts: ParseOptions = {},
): ParsedTuskersSheet {
  const rules = opts.rules ?? EXCLUDED_ROWS;
  const fixes = opts.fixes ?? TEAM_CELL_FIXES;
  const out = emptyParsed(spec);
  out.homeVenues = {};
  const blocks = [0, 6]; // column offsets of the two week blocks
  const dates: Array<string | null> = [null, null];
  let inHeader = false;
  let weeksSeen = false;
  for (let r = 1; r <= ws.rowCount; r++) {
    const texts = rowTexts(ws, r);
    if (texts.every((t) => !t)) {
      if (inHeader && out.teamList.length) inHeader = false;
      continue;
    }
    const where = `${spec.sheet} row ${r}`;
    const ex = exclusionFor(ws, spec, r, rules);
    if (ex && 'error' in ex) {
      out.errors.push(ex.error);
      continue;
    }
    if (ex) {
      out.excluded.push(ex);
      continue;
    }
    if (!weeksSeen) {
      if (/^teams$/i.test(txt(ws, r, 2)) && /^home venue$/i.test(txt(ws, r, 4))) {
        inHeader = true;
        continue;
      }
      if (inHeader) {
        const team = resolveSide(out, r, txt(ws, r, 2), fixes);
        const venue = resolveVenue(out, r, txt(ws, r, 4));
        if (team) {
          out.teamList.push(team);
          if (venue) out.homeVenues[team] = venue;
        }
        continue;
      }
    }
    let handled = false;
    for (const [b, o] of blocks.entries()) {
      const label = txt(ws, r, 1 + o);
      if (/^week\s*\d+$/i.test(label)) {
        weeksSeen = true;
        handled = true;
        const d = seasonDate(cell(ws, r, 2 + o));
        if (!d || typeof d !== 'string') {
          out.errors.push(
            `${where}: "${label}" banner without a valid date${d && typeof d !== 'string' ? ` (${d.error})` : ''}`,
          );
          dates[b] = null;
        } else dates[b] = d;
        continue;
      }
      if (!isVs(txt(ws, r, 3 + o))) continue;
      handled = true;
      const rawHome = txt(ws, r, 2 + o);
      const rawAway = txt(ws, r, 4 + o);
      const rawVenue = txt(ws, r, 5 + o);
      const date = dates[b];
      if (!date) {
        out.errors.push(`${where}: fixture "${rawHome}" v "${rawAway}" before any Week banner`);
        continue;
      }
      if (!rawHome || !rawAway || !rawVenue) {
        out.errors.push(`${where}: incomplete fixture "${rawHome}" v "${rawAway}" @ "${rawVenue}"`);
        continue;
      }
      const home = resolveSide(out, r, rawHome, fixes);
      const away = resolveSide(out, r, rawAway, fixes);
      const venue = resolveVenue(out, r, rawVenue);
      if (!home || !away) continue;
      out.fixtures.push({
        sheet: spec.sheet,
        row: r,
        seriesId: spec.seriesId,
        date,
        time: OD50_DEFAULT_TIME,
        timeSource: 'provisional',
        rawHome,
        rawAway,
        home,
        away,
        venue,
        rawVenue,
      });
    }
    if (handled) continue;
    // Titles before the first week banner ("KZN Inland …", "50 Over Fixtures").
    if (!weeksSeen && texts.filter(Boolean).length === 1) continue;
    out.errors.push(`${where}: unrecognised row "${texts.filter(Boolean).join(' | ')}"`);
  }
  // The header block must name every manifest home ground.
  for (const [clubId, ground] of Object.entries(TUSKERS_HOME_VENUES))
    if (out.homeVenues[clubId] !== ground)
      out.errors.push(
        `${spec.sheet}: header lists ${clubId}'s home ground as "${out.homeVenues[clubId] ?? '—'}", manifest says "${ground}"`,
      );
  // Order: left block then right block reads row-interleaved; sort by date then row.
  out.fixtures.sort((a, b) => a.date.localeCompare(b.date) || a.row - b.row);
  finish(out, { fixes, rules });
  return out;
}

/**
 * 'Prem T20 Fixtures': a "Pool A" team list (two columns), then `[Week N] | <date> | … |
 * Sunday AM` / `Sunday PM` session banners over `home | vs | away | venue` rows; the side table
 * (H–M) from the "Date | Fixture | Venue | Time" header lists evening reschedules.
 */
export function parseMensT20Sheet(
  ws: ExcelJS.Worksheet,
  spec: TuskersSheetSpec,
  opts: ParseOptions = {},
): ParsedTuskersSheet {
  const rules = opts.rules ?? EXCLUDED_ROWS;
  const fixes = opts.fixes ?? TEAM_CELL_FIXES;
  const expectedReschedules = opts.reschedules ?? T20_RESCHEDULES;
  const out = emptyParsed(spec);
  let date: string | null = null;
  let session: { time: string } | null = null;
  let sessionsSeen = false;
  let poolList = false;
  let sideTable = false;
  const sideRows: Array<T20Reschedule & { row: number }> = [];
  const keptRows = new Map<number, { date: string; key: string }>();
  for (let r = 1; r <= ws.rowCount; r++) {
    const texts = rowTexts(ws, r);
    if (texts.every((t) => !t)) continue;
    const where = `${spec.sheet} row ${r}`;
    // Side table (columns H–M) — read first; the left half of the row is parsed below.
    if (/^date$/i.test(txt(ws, r, 8)) && /^fixture$/i.test(txt(ws, r, 9))) {
      sideTable = true;
      if (!/^venue$/i.test(txt(ws, r, 12)) || !/^time$/i.test(txt(ws, r, 13)))
        out.errors.push(
          `${where}: side-table header expected Venue/Time in columns L/M, got "${txt(ws, r, 12)}" / "${txt(ws, r, 13)}"`,
        );
    } else if (sideTable && cellDate(cell(ws, r, 8))) {
      const time = cellTime(cell(ws, r, 13));
      const venue = canonicalVenue(txt(ws, r, 12))?.name;
      if (!isVs(txt(ws, r, 10)) || !time || !venue)
        out.errors.push(`${where}: unreadable side-table entry "${texts.slice(7).join(' | ')}"`);
      else
        sideRows.push({
          row: r,
          home: txt(ws, r, 9),
          away: txt(ws, r, 11),
          date: cellDate(cell(ws, r, 8))!,
          time,
          venue,
        });
    } else if (sideTable && texts.slice(7).some(Boolean))
      out.errors.push(`${where}: unrecognised side-table cells "${texts.slice(7).join(' | ')}"`);

    const ex = exclusionFor(ws, spec, r, rules);
    if (ex && 'error' in ex) {
      out.errors.push(ex.error);
      continue;
    }
    if (ex) {
      out.excluded.push(ex);
      if (ex.kind === 'duplicate') {
        const kept = keptRows.get(ex.duplicateOf!);
        const key = [txt(ws, r, 2), txt(ws, r, 4), txt(ws, r, 5)].map(canonicalSpelling).join('|');
        if (!kept || kept.key !== key || kept.date !== date)
          out.errors.push(
            `${where}: listed as a duplicate of row ${ex.duplicateOf}, but they differ (date ${date} / ${kept?.date ?? '—'})`,
          );
      }
      continue;
    }
    const sessionText = txt(ws, r, 4);
    const sm = sessionText.match(/^sunday\s+(am|pm)$/i);
    if (sm && !isVs(txt(ws, r, 3))) {
      sessionsSeen = true;
      poolList = false;
      const d = cell(ws, r, 2);
      if (d != null) {
        const sd = seasonDate(d);
        if (!sd || typeof sd !== 'string') {
          out.errors.push(`${where}: session banner with an unreadable date`);
          continue;
        }
        if (weekdayOf(sd) !== 'SUNDAY') out.errors.push(`${where}: ${sd} is not a Sunday`);
        date = sd;
      } else if (!date) out.errors.push(`${where}: "${sessionText}" before any dated banner`);
      if (txt(ws, r, 1) && !/^week\s*\d+$/i.test(txt(ws, r, 1)))
        out.errors.push(`${where}: unexpected label "${txt(ws, r, 1)}"`);
      session = { time: sm[1].toLowerCase() === 'am' ? T20_AM_TIME : T20_PM_TIME };
      continue;
    }
    if (!sessionsSeen) {
      if (/^pool a$/i.test(txt(ws, r, 2))) {
        poolList = true;
        continue;
      }
      if (poolList && txt(ws, r, 2) && txt(ws, r, 4) && !txt(ws, r, 3)) {
        for (const raw of [txt(ws, r, 2), txt(ws, r, 4)]) {
          const t = resolveSide(out, r, raw, fixes);
          if (t) out.teamList.push(t);
        }
        continue;
      }
      if (texts.filter(Boolean).length === 1) continue; // titles
    }
    if (isVs(txt(ws, r, 3))) {
      const rawHome = txt(ws, r, 2);
      const rawAway = txt(ws, r, 4);
      const rawVenue = txt(ws, r, 5);
      if (!date || !session) {
        out.errors.push(`${where}: fixture before any session banner`);
        continue;
      }
      if (!rawHome || !rawAway || !rawVenue) {
        out.errors.push(`${where}: incomplete fixture "${rawHome}" v "${rawAway}" @ "${rawVenue}"`);
        continue;
      }
      const home = resolveSide(out, r, rawHome, fixes);
      const away = resolveSide(out, r, rawAway, fixes);
      const venue = resolveVenue(out, r, rawVenue);
      if (!home || !away) continue;
      keptRows.set(r, {
        date,
        key: [rawHome, rawAway, rawVenue].map(canonicalSpelling).join('|'),
      });
      out.fixtures.push({
        sheet: spec.sheet,
        row: r,
        seriesId: spec.seriesId,
        date,
        time: session.time,
        timeSource: 't20-marker',
        rawHome,
        rawAway,
        home,
        away,
        venue,
        rawVenue,
      });
      continue;
    }
    // A row holding only side-table cells (already read above).
    if (sideTable && texts.slice(0, 7).every((t) => !t)) continue;
    out.errors.push(`${where}: unrecognised row "${texts.filter(Boolean).join(' | ')}"`);
  }

  // Side table must say exactly what the manifest says, and each entry moves ONE fixture.
  const norm = (x: { home: string; away: string; date: string; time: string; venue: string }) =>
    `${[resolveTeam(x.home)?.id ?? x.home, resolveTeam(x.away)?.id ?? x.away].sort().join('|')}|${x.date}|${x.time}|${normaliseName(x.venue)}`;
  const want = expectedReschedules.map(norm).sort();
  const got = sideRows.map(norm).sort();
  if (JSON.stringify(want) !== JSON.stringify(got))
    out.errors.push(
      `${spec.sheet}: side table ${JSON.stringify(got)} ≠ manifest T20_RESCHEDULES ${JSON.stringify(want)}`,
    );
  for (const rs of expectedReschedules) {
    const pair = [resolveTeam(rs.home)?.id, resolveTeam(rs.away)?.id].sort().join('|');
    const hits = out.fixtures.filter((f) => [f.home, f.away].sort().join('|') === pair);
    if (hits.length !== 1) {
      out.errors.push(
        `${spec.sheet}: reschedule ${rs.home} v ${rs.away} matches ${hits.length} fixture(s), expected exactly 1`,
      );
      continue;
    }
    const f = hits[0];
    f.rescheduledFrom = { date: f.date, time: f.time, venue: f.venue };
    f.date = rs.date;
    f.time = rs.time;
    f.venue = canonicalVenue(rs.venue)?.name ?? rs.venue;
    f.timeSource = 'side-table';
    out.reschedules.push({ ...rs, appliedTo: f.row });
  }
  out.fixtures.sort((a, b) => a.row - b.row);
  finish(out, { fixes, rules });
  return out;
}

const KO_SEED = /^(\d)(?:st|nd|rd|th) place$/i;
const KO_WINNER = /^winner(?: of)? eliminator$/i;

/**
 * 'Veterans Fixtures': a team list (column C), then two side-by-side blocks (B–G / I–N):
 * banners `[Week N | Eliminator | Final] | <date> | | <weekday> | Venue | Time` over
 * `home | vs | away | venue | time` rows. "December Break" rows are skipped. Rows under the
 * Eliminator / Final banners are the playoff (`pos:` / `win:f1` slot refs).
 */
export function parseVetsSheet(
  ws: ExcelJS.Worksheet,
  spec: TuskersSheetSpec,
  opts: ParseOptions = {},
): ParsedTuskersSheet {
  const rules = opts.rules ?? EXCLUDED_ROWS;
  const fixes = opts.fixes ?? TEAM_CELL_FIXES;
  const out = emptyParsed(spec);
  const blocks = [0, 7];
  const state: Array<{ date: string | null; stage: string | null }> = [
    { date: null, stage: null },
    { date: null, stage: null },
  ];
  let bannersSeen = false;
  let teamList = false;
  const koPending: Array<Omit<TuskersKoRow, 'home' | 'away' | 'fixtureId'>> = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const texts = rowTexts(ws, r);
    if (texts.every((t) => !t)) continue;
    const where = `${spec.sheet} row ${r}`;
    const ex = exclusionFor(ws, spec, r, rules);
    if (ex && 'error' in ex) {
      out.errors.push(ex.error);
      continue;
    }
    if (ex) {
      out.excluded.push(ex);
      continue;
    }
    const nonEmpty = texts.filter(Boolean);
    // Title row: one text repeated across the row.
    if (!bannersSeen && nonEmpty.every((t) => t === nonEmpty[0]) && nonEmpty.length > 1) continue;
    if (nonEmpty.every((t) => /^december break$/i.test(t))) continue;
    if (!bannersSeen) {
      if (/^veterans teams$/i.test(txt(ws, r, 3))) {
        teamList = true;
        continue;
      }
      if (teamList && nonEmpty.length === 1 && txt(ws, r, 3) && resolveTeam(txt(ws, r, 3))) {
        out.teamList.push(resolveTeam(txt(ws, r, 3))!.id);
        continue;
      }
      if (nonEmpty.length === 1 && !cellDate(cell(ws, r, 3))) continue; // "T20 Night League"
    }
    let handled = false;
    for (const [b, o] of blocks.entries()) {
      const dateCell = cell(ws, r, 3 + o);
      const label = txt(ws, r, 2 + o);
      const dayText = txt(ws, r, 5 + o);
      if (cellDate(dateCell) && /^venue$/i.test(txt(ws, r, 6 + o))) {
        bannersSeen = true;
        handled = true;
        const d = seasonDate(dateCell);
        if (!d || typeof d !== 'string') {
          out.errors.push(`${where}: banner date unreadable or outside the season`);
          state[b].date = null;
          continue;
        }
        const wd = weekdayName(dayText);
        if (!wd) out.errors.push(`${where}: unreadable weekday "${dayText}"`);
        else if (wd !== weekdayOf(d))
          out.errors.push(`${where}: banner says ${dayText} but ${d} is a ${weekdayOf(d)}`);
        if (/^time$/i.test(txt(ws, r, 7 + o)) === false)
          out.errors.push(`${where}: banner without its "Time" header`);
        state[b].date = d;
        if (/^eliminator$/i.test(label) || /^final$/i.test(label)) state[b].stage = label;
        else if (!label || /^week\s*\d+$/i.test(label)) state[b].stage = null;
        else out.errors.push(`${where}: unexpected banner label "${label}"`);
        continue;
      }
      if (!isVs(txt(ws, r, 4 + o))) continue;
      handled = true;
      const rawHome = txt(ws, r, 3 + o);
      const rawAway = dayText;
      const rawVenue = txt(ws, r, 6 + o);
      const time = cellTime(cell(ws, r, 7 + o));
      const { date, stage } = state[b];
      if (!date) {
        out.errors.push(`${where}: fixture before any dated banner`);
        continue;
      }
      if (!rawHome || !rawAway || !rawVenue || !time) {
        out.errors.push(
          `${where}: incomplete fixture "${rawHome}" v "${rawAway}" @ "${rawVenue}" ${time ?? '(no time)'}`,
        );
        continue;
      }
      if (stage) {
        koPending.push({
          sheet: spec.sheet,
          row: r,
          koSeriesId: spec.koSeriesId ?? '',
          stage,
          date,
          time,
          rawHome,
          rawAway,
          rawVenue,
        });
        continue;
      }
      const home = resolveSide(out, r, rawHome, fixes);
      const away = resolveSide(out, r, rawAway, fixes);
      const venue = resolveVenue(out, r, rawVenue);
      if (!home || !away) continue;
      out.fixtures.push({
        sheet: spec.sheet,
        row: r,
        seriesId: spec.seriesId,
        date,
        time,
        timeSource: 'sheet',
        rawHome,
        rawAway,
        home,
        away,
        venue,
        rawVenue,
      });
    }
    if (handled) continue;
    out.errors.push(`${where}: unrecognised row "${nonEmpty.join(' | ')}"`);
  }
  // Playoff: Eliminator first (f1), Final second (f2); refs into the league series.
  koPending.sort((a, b) => a.date.localeCompare(b.date));
  koPending.forEach((k, i) => {
    const ref = (raw: string): string | null => {
      const t = raw.replace(/\s+/g, ' ').trim();
      const seed = t.match(KO_SEED);
      if (seed) return `pos:${spec.seriesId}:${seed[1]}`;
      if (KO_WINNER.test(t) && i > 0) return 'win:f1';
      return null;
    };
    const home = ref(k.rawHome);
    const away = ref(k.rawAway);
    if (!home || !away) {
      out.errors.push(
        `${spec.sheet} row ${k.row}: unrecognised playoff side "${!home ? k.rawHome : k.rawAway}"`,
      );
      return;
    }
    if (!isTbcVenue(k.rawVenue))
      out.warnings.push(`${spec.sheet} row ${k.row}: playoff venue "${k.rawVenue}" ignored`);
    out.ko.push({ ...k, fixtureId: `f${i + 1}`, home, away });
  });
  if (out.ko.length && !spec.koSeriesId)
    out.errors.push(`${spec.sheet}: playoff rows but no koSeriesId in the manifest`);
  out.fixtures.sort((a, b) => a.date.localeCompare(b.date) || a.row - b.row);
  finish(out, { fixes, rules });
  return out;
}

/** Visible/hidden sheet assertions for one workbook. */
export function checkSheetStates(wb: ExcelJS.Workbook, workbook: TuskersWorkbook): string[] {
  const errors: string[] = [];
  const inScope = TUSKERS_FIXTURE_SHEETS.filter((s) => s.workbook === workbook).map((s) => s.sheet);
  const hidden = EXPECTED_HIDDEN_SHEETS[workbook];
  for (const ws of wb.worksheets) {
    const name = ws.name.trim();
    const visible = (ws.state ?? 'visible') === 'visible';
    if (inScope.includes(name)) {
      if (!visible) errors.push(`${workbook}: in-scope sheet "${name}" is ${ws.state}`);
    } else if (hidden.includes(name)) {
      if (visible)
        errors.push(
          `${workbook}: out-of-scope sheet "${name}" is VISIBLE — the workbook changed; refusing to guess`,
        );
    } else errors.push(`${workbook}: sheet "${name}" is not in the manifest`);
  }
  for (const s of [...inScope, ...hidden])
    if (!wb.worksheets.some((w) => w.name.trim() === s))
      errors.push(`${workbook}: sheet "${s}" not found`);
  return errors;
}

/** Parse both workbooks (each sheet asserted against its manifest counts). */
export function parseTuskersWorkbooks(
  books: Record<TuskersWorkbook, ExcelJS.Workbook>,
  sheets: TuskersSheetSpec[] = TUSKERS_FIXTURE_SHEETS,
): { sheets: ParsedTuskersSheet[]; errors: string[] } {
  const errors: string[] = [];
  const parsed: ParsedTuskersSheet[] = [];
  for (const wbName of ['mens', 'vets'] as const)
    errors.push(...checkSheetStates(books[wbName], wbName));
  for (const spec of sheets) {
    const ws = books[spec.workbook].worksheets.find((w) => w.name.trim() === spec.sheet);
    if (!ws) continue; // reported by checkSheetStates
    const p =
      spec.layout === 'mens50'
        ? parseMens50Sheet(ws, spec)
        : spec.layout === 'mensT20'
          ? parseMensT20Sheet(ws, spec)
          : parseVetsSheet(ws, spec);
    errors.push(...p.errors);
    parsed.push(p);
  }
  const total = parsed.reduce((n, s) => n + s.fixtures.length, 0);
  if (!errors.length && total !== EXPECTED_TOTAL_FIXTURES)
    errors.push(`${total} fixtures parsed, expected ${EXPECTED_TOTAL_FIXTURES}`);
  return { sheets: parsed, errors };
}
