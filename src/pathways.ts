/**
 * Pathways: the amateur and school results a union's site exports — one row per match with the
 * competition, division, teams, scores, overs and result — read into one shape and placed on
 * the pyramid: which tier each competition sits on, the age group, the gender and the format.
 * From there the pathway into the professional set-up can be seen as a whole: where it is dense
 * or thin, which leagues are competitive enough to show real ability, which clubs and schools
 * carry players all the way up, and how strong each side is. Pure; no names of people here.
 *
 * Tiers are read from competition and division names (trials and provincial weeks are
 * representative; Saturday/Sunday leagues sit below the Presidents and Premier leagues; a school
 * competition is primary or high school by its age groups). The rules are short and listed in
 * `tierOf`, so a new competition that lands in the wrong tier is a one-line fix.
 */

export type Site = 'club' | 'school';
export type MatchType = 'league' | 'knockout' | 'practice';
export type Gender = 'men' | 'women';
export type Format = 'T10' | 'T20' | 'short' | 'long' | 'time' | 'hundred' | 'unknown';
export type Tier =
  | 'primary'
  | 'club-junior'
  | 'high-school'
  | 'club-league'
  | 'presidents'
  | 'premier'
  | 'representative'
  | 'other';
export type ResultKind =
  | 'runs'
  | 'wickets'
  | 'innings'
  | 'tie'
  | 'draw'
  | 'abandoned'
  | 'no-result'
  | 'forfeit'
  | 'ongoing'
  | 'unknown';

/** The pyramid, bottom to top. The page draws the professional tier above these. */
export const TIERS: { key: Tier; label: string; rung: number; blurb: string }[] = [
  { key: 'primary', label: 'Primary schools', rung: 1, blurb: 'U9–U13 school cricket' },
  { key: 'club-junior', label: 'Club juniors & youth', rung: 2, blurb: 'U9–U18 at clubs' },
  { key: 'high-school', label: 'High schools', rung: 3, blurb: 'U14 to 1st XI' },
  { key: 'club-league', label: 'Saturday & Sunday leagues', rung: 4, blurb: 'Senior club ladders' },
  { key: 'presidents', label: 'Presidents leagues', rung: 5, blurb: 'Senior club, upper tier' },
  { key: 'premier', label: 'Premier league', rung: 6, blurb: 'The top of club cricket' },
  {
    key: 'representative',
    label: 'Representative',
    rung: 7,
    blurb: 'Trials, district and provincial weeks',
  },
  { key: 'other', label: 'Other', rung: 0, blurb: 'Friendlies, blind cricket' },
];
export const TIER = Object.fromEntries(TIERS.map((t) => [t.key, t])) as Record<
  Tier,
  (typeof TIERS)[number]
>;

export const FORMAT_LABEL: Record<Format, string> = {
  T10: 'T10',
  T20: 'T20',
  short: '25–35 overs',
  long: '40–50 overs',
  time: 'Time cricket',
  hundred: '100 balls',
  unknown: 'Format not recorded',
};

/** Age rungs, youngest first; 'Open' is senior cricket and school 1st XI / open sides. */
export const AGES = [
  'U9',
  'U10',
  'U11',
  'U12',
  'U13',
  'U14',
  'U15',
  'U16',
  'U17',
  'U18',
  'U19',
  'Open',
];

export interface Innings {
  runs: number;
  wkts: number;
  balls: number | null;
}

export interface Side {
  /** The name as exported. */
  name: string;
  /** The name without season tokens — one row per side in a ladder. */
  side: string;
  /** The club or school behind the side. */
  club: string;
  /** `site:slug` — a school and a club that share a name stay apart. */
  clubKey: string;
  innings: Innings[];
  runs: number | null;
  wkts: number | null;
  balls: number | null;
  /** Overs the side was allotted, when the export records it. */
  allotted: number | null;
}

export interface PathMatch {
  id: string;
  site: Site;
  competition: string;
  division: string;
  type: MatchType;
  date: string;
  venue: string;
  status: 'completed' | 'ongoing' | '';
  sides: [Side, Side];
  result: {
    kind: ResultKind;
    /** Index into `sides`, when there is a winner. */
    winner: 0 | 1 | null;
    margin: number | null;
    dl: boolean;
    text: string;
  };
  tier: Tier;
  gender: Gender;
  age: string;
  format: Format;
  /** The grouping inside the competition: the division, or the competition itself. */
  group: string;
}

/* ─── Reading the export ─── */

/** A small CSV reader: quoted fields, doubled quotes, CRLF. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const COLUMNS = ['site', 'competition', 'division', 'match type', 'date', 'team 1', 'result'];

/** Does this text look like the results export? */
export function isResultsExport(text: string): boolean {
  const head = csvRows(text.slice(0, 600))[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  return COLUMNS.every((c) => head.includes(c));
}

export const oversToBalls = (o: string): number | null => {
  const m = /^(\d+)(?:\.(\d))?$/.exec(o.trim());
  if (!m) return null;
  return Number(m[1]) * 6 + Number(m[2] ?? 0);
};

/** "181/5" → one innings; "196/10 & 105/10" → two. */
export function parseScore(s: string): { runs: number; wkts: number }[] {
  return s
    .split('&')
    .map((p) => /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(p))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ runs: Number(m[1]), wkts: Number(m[2]) }));
}

/** "12.2/20" → faced and allotted; "59" → faced only; "61.3 & 42.2" → per innings. */
export function parseOvers(s: string): { balls: (number | null)[]; allotted: number | null } {
  const parts = s.split('&').map((p) => p.trim());
  let allotted: number | null = null;
  const balls = parts.map((p) => {
    const [faced, given] = p.split('/');
    if (given !== undefined && allotted === null) allotted = Number(given) || null;
    return faced ? oversToBalls(faced) : null;
  });
  return { balls, allotted };
}

function side(name: string, score: string, overs: string): Side {
  const inns = parseScore(score);
  const ov = parseOvers(overs);
  const innings: Innings[] = inns.map((i, k) => ({ ...i, balls: ov.balls[k] ?? null }));
  const has = innings.length > 0;
  const ballsKnown = innings.every((i) => i.balls !== null);
  return {
    name: name.trim(),
    side: sideName(name),
    club: clubName(name),
    clubKey: slug(clubName(name)),
    innings,
    runs: has ? innings.reduce((n, i) => n + i.runs, 0) : null,
    wkts: has ? innings.reduce((n, i) => n + i.wkts, 0) : null,
    balls: has && ballsKnown ? innings.reduce((n, i) => n + (i.balls ?? 0), 0) : null,
    allotted: ov.allotted,
  };
}

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Season tokens the site appends: "SU4 2025", "Pres A 25/26", "(2) 2026". */
const YEAR = /(20\d\d(?:\/\d\d)?|\b\d\d\/\d\d)\b/g;

/** The side without season tokens, so one side is one ladder row across the season. */
export function sideName(name: string): string {
  return name.replace(YEAR, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The club or school behind a side: grade, age, side number, gender and season tokens
 * stripped ("GM Old Summit U13 Prem 2025" → "GM Old Summit"; "St Judes 3rd XI 2025" →
 * "St Judes"). Heuristic — the pipeline view says so.
 */
export function clubName(name: string): string {
  let s = ` ${name} `;
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.replace(YEAR, ' ');
  s = s.replace(/\b(SA|SU)\s?\d+\b/gi, ' ');
  s = s.replace(/\b(enza|dp|sa20|opens?)\b/gi, ' ');
  s = s.replace(/\b(pres|prem|premier|president'?s?)\s?(a|b|league)?\b/gi, ' ');
  s = s.replace(/\b\d?\s?div(?:ision)?\s?\d?\b/gi, ' ');
  s = s.replace(/\b(u|under)\s?\d{1,2}\s?[a-d]?\b/gi, ' ');
  s = s.replace(/\b1\d[a-d]\b/gi, ' ');
  s = s.replace(/\b(1st|2nd|3rd|4th|\d+(?:de|ste)|\d)\s?X[IL]\b/gi, ' ');
  s = s.replace(/\b(first|second|third|fourth|\d+(?:st|nd|rd|th|de|ste))\s?(team|side)\b/gi, ' ');
  s = s.replace(/\b(cc|cricket club|club)\b/gi, ' ');
  s = s.replace(/\s\d\s/g, ' ');
  // Trailing tags, a few passes: "… Girls 1st" → "… Girls" → "…"; "Old Boys" is a club name.
  for (let k = 0; k < 3; k++) {
    s = s.replace(/\s(1st|2nd|3rd|4th|first|second|third)\s*$/i, ' ');
    s = s.replace(/\s(girls?|women'?s?|ladies|mens?|men's)\s*$/i, ' ');
    s = s.replace(/(?<!\bold)\s(boys)\s*$/i, ' ');
    s = s.replace(/\s[a-d]\s*$/i, ' ');
    s = s.replace(/\s(for|of|the)\s*$/i, ' ');
  }
  return s.replace(/\s+/g, ' ').trim() || name.trim();
}

const RESULT_WON = /^(.*?) won by (\d+) (runs?|wickets?)( \(D\/L\))?\.?$/i;
const RESULT_INNINGS = /^(.*?) won by (?:an )?innings and (\d+) runs?( \(D\/L\))?\.?$/i;
const RESULT_FORFEIT = /^(?:forfeited\.?\s*)?winner:\s*(.*)$/i;

function whichSide(winner: string, sides: [Side, Side]): 0 | 1 | null {
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ').trim();
  const w = norm(winner);
  const exact = sides.findIndex((s) => norm(s.name) === w);
  if (exact >= 0) return exact as 0 | 1;
  const loose = sides.findIndex((s) => w.startsWith(norm(s.name)) || norm(s.name).startsWith(w));
  return loose >= 0 ? (loose as 0 | 1) : null;
}

export function parseResult(text: string, sides: [Side, Side], status: string) {
  const t = text.trim();
  const base = { text: t, dl: /\(D\/L\)/i.test(t), margin: null as number | null };
  let m: RegExpExecArray | null;
  if ((m = RESULT_INNINGS.exec(t)))
    return {
      ...base,
      kind: 'innings' as const,
      winner: whichSide(m[1], sides),
      margin: Number(m[2]),
    };
  if ((m = RESULT_WON.exec(t)))
    return {
      ...base,
      kind: (/^w/i.test(m[3]) ? 'wickets' : 'runs') as ResultKind,
      winner: whichSide(m[1], sides),
      margin: Number(m[2]),
    };
  if ((m = RESULT_FORFEIT.exec(t)))
    return { ...base, kind: 'forfeit' as const, winner: whichSide(m[1], sides) };
  if (/^forfeited\.?$/i.test(t)) return { ...base, kind: 'forfeit' as const, winner: null };
  if (/tie/i.test(t)) return { ...base, kind: 'tie' as const, winner: null };
  if (/draw/i.test(t)) return { ...base, kind: 'draw' as const, winner: null };
  if (/abandon/i.test(t)) return { ...base, kind: 'abandoned' as const, winner: null };
  if (/no result/i.test(t)) return { ...base, kind: 'no-result' as const, winner: null };
  if (/won/i.test(t)) {
    // "X won on …" and other wordings: the winner is the side named first.
    const w = sides.find((s) => t.toLowerCase().startsWith(s.name.toLowerCase()));
    return { ...base, kind: 'unknown' as const, winner: w ? (sides.indexOf(w) as 0 | 1) : null };
  }
  if (/ongoing/i.test(status)) return { ...base, kind: 'ongoing' as const, winner: null };
  return { ...base, kind: 'unknown' as const, winner: null };
}

/* ─── Placing a match on the pyramid ─── */

const REP = /trial|provincial|sa20|regional week|area week|district|warm[- ]?up/i;

export function tierOf(site: Site, competition: string, division: string): Tier {
  const c = `${competition} ${division}`.toLowerCase();
  if (REP.test(c)) return 'representative';
  if (/blind|friendly/.test(c)) return 'other';
  if (site === 'school') {
    if (
      /high school|johnny waite|gauteng cup high|petrian|1st xi|\bu1[4-9]\b|time format|misc fixtures/.test(
        c,
      )
    )
      return 'high-school';
    return 'primary';
  }
  if (/junior|\bu\s?\d{1,2}\b|under \d{1,2}/.test(c)) return 'club-junior';
  if (/premier|prem\b|prem a|prem b|enza/.test(c)) return 'premier';
  if (/\bpres\b|president/.test(c)) return 'presidents';
  if (/saturday|sunday|promotion|development/.test(c)) return 'club-league';
  return 'other';
}

export function genderOf(...texts: string[]): Gender {
  return /\b(women|womens|women's|ladies|girls?|female)\b/i.test(texts.join(' ')) ? 'women' : 'men';
}

/** "U13A", "Under 13", "U15s" → "U13"/"U15"; senior sides and 1st XIs → "Open". */
export function ageOf(...texts: string[]): string {
  for (const t of texts) {
    const m = /\b(?:u|under)\s?(\d{1,2})(?!\d)/i.exec(t);
    if (m) {
      const n = Number(m[1]);
      if (n >= 9 && n <= 19) return `U${n}`;
    }
  }
  return 'Open';
}

export function formatOf(
  allotted: number | null,
  innings: number,
  faced: number | null,
  ...texts: string[]
): Format {
  if (innings >= 2) return 'time';
  if (allotted) {
    if (allotted === 100) return 'hundred';
    if (allotted <= 12) return 'T10';
    if (allotted <= 22) return 'T20';
    if (allotted <= 36) return 'short';
    if (allotted <= 60) return 'long';
  }
  const t = texts.join(' ').toLowerCase();
  if (/\bt10\b/.test(t)) return 'T10';
  if (/\bt20\b/.test(t)) return 'T20';
  if (/\b(25|30|35)\s?over/.test(t)) return 'short';
  if (/\b(40|45|50)\s?over/.test(t)) return 'long';
  if (/\btime\b/.test(t)) return 'time';
  if (/100'?s\b/.test(t)) return 'hundred';
  // No allotment recorded: the longer innings says what the game at least was. A full 20 or
  // 10 overs reads as T20 / T10; anything shorter could be any format cut short, so unknown.
  if (faced) {
    if (faced > 36 * 6) return 'long';
    if (faced > 20 * 6) return 'short';
    if (faced === 20 * 6) return 'T20';
    if (faced === 10 * 6) return 'T10';
  }
  return 'unknown';
}

function matchType(s: string): MatchType {
  const t = s.toLowerCase();
  if (/practice|friendly/.test(t)) return 'practice';
  if (/final|eliminator|qualifier|position|play-?off/.test(t)) return 'knockout';
  return 'league';
}

/** Read the export. Rows that aren't a match (no teams, no date) are skipped. */
export function parseResults(text: string): PathMatch[] {
  const rows = csvRows(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const ix = (k: string) => head.indexOf(k);
  const col = {
    site: ix('site'),
    comp: ix('competition'),
    div: ix('division'),
    type: ix('match type'),
    date: ix('date'),
    t1: ix('team 1'),
    s1: ix('team 1 score'),
    o1: ix('team 1 overs'),
    t2: ix('team 2'),
    s2: ix('team 2 score'),
    o2: ix('team 2 overs'),
    result: ix('result'),
    venue: ix('venue'),
    status: ix('status'),
    id: ix('match id'),
  };
  if (col.comp < 0 || col.t1 < 0 || col.t2 < 0 || col.date < 0) return [];
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const out: PathMatch[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(1)) {
    const t1 = get(r, col.t1);
    const t2 = get(r, col.t2);
    const date = get(r, col.date);
    if (!t1 || !t2 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const site: Site = /school/i.test(get(r, col.site)) ? 'school' : 'club';
    const competition = get(r, col.comp);
    const division = get(r, col.div);
    const sides: [Side, Side] = [
      side(t1, get(r, col.s1), get(r, col.o1)),
      side(t2, get(r, col.s2), get(r, col.o2)),
    ];
    // A school and a club can share a name: the key keeps them apart.
    for (const x of sides) x.clubKey = `${site}:${x.clubKey}`;
    const status = get(r, col.status).toLowerCase();
    const id = get(r, col.id) || `${date}_${slug(t1)}_${slug(t2)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const allotted = sides[0].allotted ?? sides[1].allotted;
    const innings = Math.max(sides[0].innings.length, sides[1].innings.length);
    const faced = Math.max(0, ...sides.map((x) => x.balls ?? 0)) || null;
    out.push({
      id,
      site,
      competition,
      division,
      type: matchType(get(r, col.type)),
      date,
      venue: get(r, col.venue),
      status: status === 'completed' ? 'completed' : status === 'ongoing' ? 'ongoing' : '',
      sides,
      result: parseResult(get(r, col.result), sides, status),
      tier: tierOf(site, competition, division),
      gender: genderOf(competition, division, t1, t2),
      age: ageOf(division, competition, t1, t2),
      format: formatOf(allotted, innings, faced, division, competition),
      group: division || competition,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

/* ─── Filtering ─── */

export interface PathFilter {
  site?: Site | 'all';
  gender?: Gender | 'all';
  tier?: Tier | 'all';
  age?: string | 'all';
  format?: Format | 'all';
  /** Practice games are left out unless asked for. */
  practice?: boolean;
  from?: string;
  to?: string;
  competition?: string | 'all';
  /** Case-insensitive match on either side's name or club. */
  team?: string;
}

export function filterMatches(ms: PathMatch[], f: PathFilter): PathMatch[] {
  const team = f.team?.trim().toLowerCase();
  return ms.filter(
    (m) =>
      (!f.site || f.site === 'all' || m.site === f.site) &&
      (!f.gender || f.gender === 'all' || m.gender === f.gender) &&
      (!f.tier || f.tier === 'all' || m.tier === f.tier) &&
      (!f.age || f.age === 'all' || m.age === f.age) &&
      (!f.format || f.format === 'all' || m.format === f.format) &&
      (f.practice || m.type !== 'practice') &&
      (!f.from || m.date >= f.from) &&
      (!f.to || m.date <= f.to) &&
      (!f.competition || f.competition === 'all' || m.competition === f.competition) &&
      (!team ||
        m.sides.some(
          (s) => s.name.toLowerCase().includes(team) || s.club.toLowerCase().includes(team),
        )),
  );
}

/* ─── Results and ladders ─── */

export type Outcome = 'W' | 'L' | 'T' | 'NR';

export const decided = (m: PathMatch) =>
  m.result.winner !== null && m.result.kind !== 'forfeit' && m.result.kind !== 'unknown';

/** What the match was for one side. */
export function outcomeFor(m: PathMatch, i: 0 | 1): Outcome {
  if (m.result.kind === 'tie') return 'T';
  if (m.result.winner === null) return 'NR';
  if (m.result.kind === 'forfeit') return m.result.winner === i ? 'W' : 'L';
  return m.result.winner === i ? 'W' : 'L';
}

export interface LadderRow {
  key: string;
  label: string;
  club: string;
  clubKey: string;
  played: number;
  won: number;
  lost: number;
  tied: number;
  nr: number;
  winPct: number | null;
  runsFor: number;
  ballsFor: number;
  runsAgainst: number;
  ballsAgainst: number;
  /** Runs per over, for and against, and the difference (only where overs were recorded). */
  rrFor: number | null;
  rrAgainst: number | null;
  nrr: number | null;
  avgFor: number | null;
  /** Batting first: games and wins (the export lists the side batting first first). */
  batFirst: { games: number; won: number };
  biggestWin: string | null;
  formats: Format[];
  tiers: Tier[];
  results: {
    key: string;
    date: string;
    outcome: Outcome;
    tip: string;
    score: number | null;
    competition: string;
  }[];
}

const rate = (runs: number, balls: number) => (balls ? (runs / balls) * 6 : null);

/** One row per side. `by: 'club'` folds a club's sides together (the pipeline view). */
export function ladder(ms: PathMatch[], by: 'side' | 'club' = 'side'): LadderRow[] {
  const rows = new Map<string, LadderRow & { bestMargin: number }>();
  const keyOf = (s: Side) => (by === 'club' ? s.clubKey : slug(s.side));
  for (const m of [...ms].sort((a, b) => a.date.localeCompare(b.date))) {
    m.sides.forEach((s, i) => {
      const k = keyOf(s);
      const row =
        rows.get(k) ??
        ({
          key: k,
          label: by === 'club' ? s.club : s.side,
          club: s.club,
          clubKey: s.clubKey,
          played: 0,
          won: 0,
          lost: 0,
          tied: 0,
          nr: 0,
          winPct: null,
          runsFor: 0,
          ballsFor: 0,
          runsAgainst: 0,
          ballsAgainst: 0,
          rrFor: null,
          rrAgainst: null,
          nrr: null,
          avgFor: null,
          batFirst: { games: 0, won: 0 },
          biggestWin: null,
          bestMargin: -1,
          formats: [],
          tiers: [],
          results: [],
        } as LadderRow & { bestMargin: number });
      const o = outcomeFor(m, i as 0 | 1);
      const other = m.sides[1 - i];
      if (o === 'NR') row.nr++;
      else {
        row.played++;
        if (o === 'W') row.won++;
        else if (o === 'L') row.lost++;
        else row.tied++;
      }
      if (s.runs !== null && s.balls !== null && other.runs !== null && other.balls !== null) {
        row.runsFor += s.runs;
        row.ballsFor += s.balls;
        row.runsAgainst += other.runs;
        row.ballsAgainst += other.balls;
      }
      if (i === 0 && o !== 'NR') {
        row.batFirst.games++;
        if (o === 'W') row.batFirst.won++;
      }
      if (o === 'W' && m.result.margin !== null) {
        // Compare like with like: a wickets margin counts as its share of ten.
        const scale = m.result.kind === 'wickets' ? m.result.margin * 10 : m.result.margin;
        if (scale > row.bestMargin) {
          row.bestMargin = scale;
          row.biggestWin = `${m.result.text.replace(/^.*? won by /i, '')} v ${other.side}`;
        }
      }
      if (!row.formats.includes(m.format)) row.formats.push(m.format);
      if (!row.tiers.includes(m.tier)) row.tiers.push(m.tier);
      row.results.push({
        key: m.id,
        date: m.date,
        outcome: o,
        score: s.runs,
        competition: m.competition,
        tip: `${m.date} · ${o === 'NR' ? m.result.text || 'No result' : m.result.text} · ${s.side} ${
          s.runs !== null ? `${s.runs}/${s.wkts}` : '—'
        } v ${other.side} ${other.runs !== null ? `${other.runs}/${other.wkts}` : '—'}`,
      });
      rows.set(k, row);
    });
  }
  return [...rows.values()].map(({ bestMargin: _b, ...r }) => {
    const scored = r.results.filter((x) => x.score !== null);
    return {
      ...r,
      winPct: r.played ? Math.round(((r.won + r.tied / 2) / r.played) * 100) : null,
      rrFor: rate(r.runsFor, r.ballsFor),
      rrAgainst: rate(r.runsAgainst, r.ballsAgainst),
      nrr:
        r.ballsFor && r.ballsAgainst
          ? Math.round((r.runsFor / r.ballsFor - r.runsAgainst / r.ballsAgainst) * 6 * 100) / 100
          : null,
      avgFor: scored.length
        ? Math.round(scored.reduce((n, x) => n + (x.score ?? 0), 0) / scored.length)
        : null,
    };
  });
}

/** Ladder order: win % then net run rate then games played. */
export const ladderSort = (a: LadderRow, b: LadderRow) =>
  (b.winPct ?? -1) - (a.winPct ?? -1) || (b.nrr ?? -99) - (a.nrr ?? -99) || b.played - a.played;

/* ─── Competitions ─── */

export interface CompetitionSummary {
  competition: string;
  site: Site;
  tier: Tier;
  genders: Gender[];
  ages: string[];
  formats: Format[];
  groups: string[];
  matches: number;
  completed: number;
  abandoned: number;
  abandonedPct: number;
  ties: number;
  /** Decided games settled by 10 runs / 2 wickets or less, as a share of decided games. */
  closePct: number | null;
  /** Share of decided games won by the side batting first. */
  batFirstWinPct: number | null;
  avgFirstInnings: number | null;
  runRate: number | null;
  teams: number;
  clubs: number;
  /** Top side's win % minus the median side's (sides with 3+ games): spread of strength. */
  dominance: number | null;
  venues: number;
  from: string;
  to: string;
}

export const isClose = (m: PathMatch) =>
  m.result.kind === 'tie' ||
  (decided(m) &&
    m.result.margin !== null &&
    ((m.result.kind === 'runs' && m.result.margin <= 10) ||
      (m.result.kind === 'wickets' && m.result.margin <= 2)));

export function competitionSummaries(ms: PathMatch[]): CompetitionSummary[] {
  const by = new Map<string, PathMatch[]>();
  for (const m of ms) by.set(m.competition, [...(by.get(m.competition) ?? []), m]);
  return [...by.entries()]
    .map(([competition, list]) => {
      const dec = list.filter((m) => decided(m) || m.result.kind === 'tie');
      const first = list.filter((m) => m.sides[0].runs !== null && m.status !== 'ongoing');
      const abandoned = list.filter(
        (m) => m.result.kind === 'abandoned' || m.result.kind === 'no-result',
      ).length;
      const rows = ladder(list).filter((r) => r.played >= 3);
      const pcts = rows.map((r) => r.winPct ?? 0).sort((a, b) => b - a);
      const median = pcts.length ? pcts[Math.floor(pcts.length / 2)] : null;
      const runs = list.reduce(
        (a, m) =>
          m.sides.reduce(
            (b, s) =>
              s.runs !== null && s.balls !== null ? { r: b.r + s.runs, b: b.b + s.balls } : b,
            a,
          ),
        { r: 0, b: 0 },
      );
      const uniq = <T>(xs: T[]) => [...new Set(xs)];
      return {
        competition,
        site: list[0].site,
        tier: list[0].tier,
        genders: uniq(list.map((m) => m.gender)),
        ages: uniq(list.map((m) => m.age)).sort((a, b) => AGES.indexOf(a) - AGES.indexOf(b)),
        formats: uniq(list.map((m) => m.format)),
        groups: uniq(list.map((m) => m.group)),
        matches: list.length,
        completed: dec.length + list.filter((m) => m.result.kind === 'tie').length,
        abandoned,
        abandonedPct: list.length ? Math.round((abandoned / list.length) * 100) : 0,
        ties: list.filter((m) => m.result.kind === 'tie').length,
        closePct: dec.length ? Math.round((list.filter(isClose).length / dec.length) * 100) : null,
        batFirstWinPct: dec.length
          ? Math.round((dec.filter((m) => m.result.winner === 0).length / dec.length) * 100)
          : null,
        avgFirstInnings: first.length
          ? Math.round(first.reduce((n, m) => n + (m.sides[0].runs ?? 0), 0) / first.length)
          : null,
        runRate: runs.b ? Math.round((runs.r / runs.b) * 60) / 10 : null,
        teams: uniq(list.flatMap((m) => m.sides.map((s) => s.side))).length,
        clubs: uniq(list.flatMap((m) => m.sides.map((s) => s.clubKey))).length,
        dominance: pcts.length >= 3 && median !== null ? pcts[0] - median : null,
        venues: uniq(list.map((m) => m.venue).filter(Boolean)).length,
        from: list[0].date,
        to: list[list.length - 1].date,
      };
    })
    .sort((a, b) => TIER[b.tier].rung - TIER[a.tier].rung || b.matches - a.matches);
}

/* ─── The pyramid, coverage, pipeline and calendar ─── */

export interface TierSummary {
  tier: Tier;
  matches: number;
  decided: number;
  teams: number;
  clubs: number;
  competitions: { competition: string; matches: number; site: Site; genders: Gender[] }[];
  women: number;
  ages: string[];
  formats: Partial<Record<Format, number>>;
}

export function pyramid(ms: PathMatch[]): TierSummary[] {
  return TIERS.map((t) => {
    const list = ms.filter((m) => m.tier === t.key);
    const comps = new Map<string, { matches: number; site: Site; genders: Set<Gender> }>();
    const formats: Partial<Record<Format, number>> = {};
    for (const m of list) {
      const c = comps.get(m.competition) ?? { matches: 0, site: m.site, genders: new Set() };
      c.matches++;
      c.genders.add(m.gender);
      comps.set(m.competition, c);
      formats[m.format] = (formats[m.format] ?? 0) + 1;
    }
    return {
      tier: t.key,
      matches: list.length,
      decided: list.filter(decided).length,
      teams: new Set(list.flatMap((m) => m.sides.map((s) => s.side))).size,
      clubs: new Set(list.flatMap((m) => m.sides.map((s) => s.clubKey))).size,
      competitions: [...comps.entries()]
        .map(([competition, c]) => ({
          competition,
          matches: c.matches,
          site: c.site,
          genders: [...c.genders],
        }))
        .sort((a, b) => b.matches - a.matches),
      women: list.filter((m) => m.gender === 'women').length,
      ages: [...new Set(list.map((m) => m.age))].sort((a, b) => AGES.indexOf(a) - AGES.indexOf(b)),
      formats,
    };
  }).filter((t) => t.matches > 0);
}

/** Matches by tier × age rung: where the pathway is dense and where it thins out. */
export function coverage(ms: PathMatch[]) {
  const grid = new Map<string, number>();
  for (const m of ms) grid.set(`${m.tier}|${m.age}`, (grid.get(`${m.tier}|${m.age}`) ?? 0) + 1);
  const ages = AGES.filter((a) => ms.some((m) => m.age === a));
  const tiers = TIERS.filter(
    (t) => t.key !== 'other' && ms.some((m) => m.tier === t.key),
  ).reverse();
  return {
    ages,
    tiers: tiers.map((t) => t.key),
    cell: (tier: Tier, age: string) => grid.get(`${tier}|${age}`) ?? 0,
    max: Math.max(1, ...grid.values()),
  };
}

export interface PipelineRow {
  clubKey: string;
  club: string;
  site: Site;
  matches: number;
  /** Age rungs with a side, youngest first. */
  rungs: { age: string; sides: number; played: number; won: number; winPct: number | null }[];
  tiers: Tier[];
  topTier: Tier;
  /** How many of the age rungs the club covers. */
  breadth: number;
  winPct: number | null;
  genders: Gender[];
}

/** Clubs and schools by how much of the ladder they field — the feeders. */
export function pipeline(ms: PathMatch[]): PipelineRow[] {
  const by = new Map<
    string,
    {
      club: string;
      site: Site;
      matches: number;
      rungs: Map<string, { sides: Set<string>; played: number; won: number }>;
      tiers: Set<Tier>;
      won: number;
      played: number;
      genders: Set<Gender>;
    }
  >();
  for (const m of ms)
    m.sides.forEach((s, i) => {
      const r = by.get(s.clubKey) ?? {
        club: s.club,
        site: m.site,
        matches: 0,
        rungs: new Map(),
        tiers: new Set(),
        won: 0,
        played: 0,
        genders: new Set(),
      };
      r.matches++;
      r.tiers.add(m.tier);
      r.genders.add(m.gender);
      const rung = r.rungs.get(m.age) ?? { sides: new Set(), played: 0, won: 0 };
      rung.sides.add(s.side);
      const o = outcomeFor(m, i as 0 | 1);
      if (o !== 'NR') {
        rung.played++;
        r.played++;
        if (o === 'W') {
          rung.won++;
          r.won++;
        }
      }
      r.rungs.set(m.age, rung);
      by.set(s.clubKey, r);
    });
  return [...by.entries()]
    .map(([clubKey, r]) => {
      const tiers = [...r.tiers].sort((a, b) => TIER[b].rung - TIER[a].rung);
      return {
        clubKey,
        club: r.club,
        site: r.site,
        matches: r.matches,
        rungs: [...r.rungs.entries()]
          .sort((a, b) => AGES.indexOf(a[0]) - AGES.indexOf(b[0]))
          .map(([age, x]) => ({
            age,
            sides: x.sides.size,
            played: x.played,
            won: x.won,
            winPct: x.played ? Math.round((x.won / x.played) * 100) : null,
          })),
        tiers,
        topTier: tiers[0],
        breadth: r.rungs.size,
        winPct: r.played ? Math.round((r.won / r.played) * 100) : null,
        genders: [...r.genders],
      };
    })
    .sort((a, b) => b.breadth - a.breadth || b.matches - a.matches);
}

/** ISO week start (Monday) of a date. */
export function weekOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/** Matches per week per tier — when each level of the pathway is playing. */
export function calendar(ms: PathMatch[]) {
  const weeks = new Map<string, Partial<Record<Tier, number>>>();
  for (const m of ms) {
    const w = weekOf(m.date);
    const row = weeks.get(w) ?? {};
    row[m.tier] = (row[m.tier] ?? 0) + 1;
    weeks.set(w, row);
  }
  if (!weeks.size) return [];
  const sorted = [...weeks.keys()].sort();
  // Fill the gaps so a quiet week shows as quiet.
  const out: { week: string; byTier: Partial<Record<Tier, number>>; total: number }[] = [];
  const d = new Date(`${sorted[0]}T00:00:00Z`);
  const end = new Date(`${sorted[sorted.length - 1]}T00:00:00Z`);
  while (d <= end) {
    const w = d.toISOString().slice(0, 10);
    const byTier = weeks.get(w) ?? {};
    out.push({ week: w, byTier, total: Object.values(byTier).reduce((a, b) => a + (b ?? 0), 0) });
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

/** Margins of decided games in bands, for the competitiveness view. */
export function marginBands(ms: PathMatch[]) {
  const runs = [
    { label: '1–10', from: 1, to: 10 },
    { label: '11–30', from: 11, to: 30 },
    { label: '31–60', from: 31, to: 60 },
    { label: '61–100', from: 61, to: 100 },
    { label: '100+', from: 101, to: Infinity },
  ].map((b) => ({
    ...b,
    n: ms.filter(
      (m) =>
        m.result.kind === 'runs' &&
        m.result.margin !== null &&
        m.result.margin >= b.from &&
        m.result.margin <= b.to,
    ).length,
  }));
  const wickets = [
    { label: '1–2', from: 1, to: 2 },
    { label: '3–5', from: 3, to: 5 },
    { label: '6–8', from: 6, to: 8 },
    { label: '9–10', from: 9, to: 10 },
  ].map((b) => ({
    ...b,
    n: ms.filter(
      (m) =>
        m.result.kind === 'wickets' &&
        m.result.margin !== null &&
        m.result.margin >= b.from &&
        m.result.margin <= b.to,
    ).length,
  }));
  return { runs, wickets, ties: ms.filter((m) => m.result.kind === 'tie').length };
}

/** Venues by matches, with the highest tier seen there — where to be. */
export function venues(ms: PathMatch[]) {
  const by = new Map<string, { matches: number; top: Tier; tiers: Set<Tier> }>();
  for (const m of ms) {
    if (!m.venue) continue;
    const v = by.get(m.venue) ?? { matches: 0, top: m.tier, tiers: new Set() };
    v.matches++;
    v.tiers.add(m.tier);
    if (TIER[m.tier].rung > TIER[v.top].rung) v.top = m.tier;
    by.set(m.venue, v);
  }
  return [...by.entries()]
    .map(([venue, v]) => ({ venue, matches: v.matches, top: v.top, tiers: [...v.tiers] }))
    .sort((a, b) => b.matches - a.matches);
}
