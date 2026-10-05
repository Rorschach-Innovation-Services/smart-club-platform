/**
 * Every fixture of every series as one flat, searchable list (Fixtures & Venues hub).
 *
 * Pure: takes the series cache (which already carries each fixture's medicoach `result` and
 * its appointed umpires, joined by GET /series), the clubs and the ground list, and returns
 * one row per fixture with names, venue, result and the checks the union's weekly cycle runs:
 * results confirmed, fixtures complete (time, ground), umpires appointed, no ground
 * double-booked. Dates are calendar days (YYYY-MM-DD), compared as strings — no time zones.
 */

export type FixtureStatus = 'scheduled' | 'completed' | 'postponed' | 'cancelled';

/** The medicoach result joined onto a fixture by GET /series (response-only). */
export interface FixtureResult {
  homeScore?: string | null;
  awayScore?: string | null;
  summary?: string | null;
  winner?: 'home' | 'away' | 'tie' | 'none' | null;
  method?: string | null;
  noResult?: boolean;
  source?: 'live' | 'manual' | 'import';
  recordedAt?: string;
  medicoachMatchUrl?: string | null;
}

interface RawFixture {
  id?: string;
  round?: number;
  date?: string;
  time?: string;
  dateTbc?: boolean;
  home?: string;
  away?: string;
  status?: string;
  venueId?: string;
  venueName?: string;
  venueOverride?: string;
  officials?: { umpires?: Array<{ umpireId?: string; name?: string }> };
  result?: FixtureResult | null;
}

export interface IndexSeries {
  id: string;
  name: string;
  leagueKey?: string;
  maxOvers?: number;
  released?: boolean;
  participants?: Array<{ teamId: string; clubId: string; name: string; venue?: string }>;
  fixtures: unknown[];
}
export interface IndexClub {
  id: string;
  name: string;
  ground?: { venue?: string };
}
export interface IndexVenue {
  id: string;
  name: string;
  suburb?: string;
  surfaces?: number;
}

export type IssueKey =
  | 'awaiting-result'
  | 'venue-clash'
  | 'no-umpires'
  | 'one-umpire'
  | 'venue-tbc'
  | 'time-tbc'
  | 'draft';

export const ISSUES: Record<IssueKey, { label: string; tone: 'alert' | 'warn' | 'info' }> = {
  'awaiting-result': { label: 'Result missing', tone: 'alert' },
  'venue-clash': { label: 'Ground double-booked', tone: 'alert' },
  'no-umpires': { label: 'No umpires', tone: 'warn' },
  'one-umpire': { label: 'One umpire', tone: 'warn' },
  'venue-tbc': { label: 'No ground', tone: 'warn' },
  'time-tbc': { label: 'Start time TBC', tone: 'warn' },
  draft: { label: 'Not released', tone: 'info' },
};

/** Where a fixture stands, from the result and the status. */
export type FixtureState =
  | 'upcoming'
  | 'today'
  | 'awaiting-result'
  | 'result'
  | 'no-result'
  | 'postponed'
  | 'cancelled';

export interface FixtureRow {
  key: string;
  seriesId: string;
  seriesName: string;
  leagueKey?: string;
  overs?: number;
  released: boolean;
  fixtureId: string;
  round?: number;
  date?: string;
  time?: string;
  homeId?: string;
  awayId?: string;
  home: string;
  away: string;
  homeClubId?: string;
  awayClubId?: string;
  venue: string | null;
  venueId?: string;
  status: FixtureStatus;
  state: FixtureState;
  result: FixtureResult | null;
  umpires: string[];
  issues: IssueKey[];
}

const STATUSES = new Set<FixtureStatus>(['scheduled', 'completed', 'postponed', 'cancelled']);
/** Knockout placeholders: `pos:A:1`, `win:sf1`… */
const SLOT = /^(pos|win|lose|loser|winner):/;

/** Lower-cased, punctuation-free, single-spaced — for venue identity and search. */
export const norm = (s: string | null | undefined) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export function buildFixtureIndex(
  series: IndexSeries[],
  clubs: IndexClub[],
  venues: IndexVenue[],
  today: string,
): FixtureRow[] {
  const clubById = new Map(clubs.map((c) => [c.id, c]));
  const venueById = new Map(venues.map((v) => [v.id, v]));
  const rows: FixtureRow[] = [];
  for (const s of series) {
    const part = (teamId?: string) => s.participants?.find((p) => p.teamId === teamId);
    const clubOf = (teamId?: string) => {
      if (!teamId || SLOT.test(teamId)) return undefined;
      const id = part(teamId)?.clubId ?? teamId;
      return clubById.has(id) ? id : undefined;
    };
    const nameOf = (teamId?: string) => {
      if (!teamId) return 'To be decided';
      if (SLOT.test(teamId)) return 'To be decided';
      return part(teamId)?.name ?? clubById.get(teamId)?.name ?? teamId;
    };
    for (const raw of (s.fixtures as RawFixture[]) ?? []) {
      if (!raw?.id) continue;
      const homeClubId = clubOf(raw.home);
      const venueRec = raw.venueId ? venueById.get(raw.venueId) : undefined;
      const venue =
        raw.venueOverride ||
        raw.venueName ||
        venueRec?.name ||
        part(raw.home)?.venue ||
        (homeClubId ? clubById.get(homeClubId)?.ground?.venue : undefined) ||
        null;
      const status = (
        STATUSES.has(raw.status as FixtureStatus) ? raw.status : 'scheduled'
      ) as FixtureStatus;
      const result = raw.result ?? null;
      const umpires = (raw.officials?.umpires ?? [])
        .map((u) => u.name ?? u.umpireId ?? '')
        .filter(Boolean);
      const date = raw.dateTbc ? undefined : raw.date;
      const state: FixtureState =
        status === 'postponed'
          ? 'postponed'
          : status === 'cancelled'
            ? 'cancelled'
            : result
              ? result.noResult
                ? 'no-result'
                : 'result'
              : date && date < today
                ? 'awaiting-result'
                : date === today
                  ? 'today'
                  : 'upcoming';
      const off = state === 'postponed' || state === 'cancelled';
      const issues: IssueKey[] = [];
      if (state === 'awaiting-result') issues.push('awaiting-result');
      if (!off && !umpires.length) issues.push('no-umpires');
      else if (!off && umpires.length === 1) issues.push('one-umpire');
      if (!off && !venue) issues.push('venue-tbc');
      if (!off && date && !raw.time && state !== 'result' && state !== 'no-result')
        issues.push('time-tbc');
      if (!s.released) issues.push('draft');
      rows.push({
        key: `${s.id}:${raw.id}`,
        seriesId: s.id,
        seriesName: s.name,
        leagueKey: s.leagueKey,
        overs: s.maxOvers,
        released: !!s.released,
        fixtureId: raw.id,
        round: raw.round,
        date,
        time: raw.time,
        homeId: raw.home,
        awayId: raw.away,
        home: nameOf(raw.home),
        away: nameOf(raw.away),
        homeClubId,
        awayClubId: clubOf(raw.away),
        venue,
        venueId: raw.venueId ?? venueRec?.id,
        status,
        state,
        result,
        umpires,
        issues,
      });
    }
  }

  // A ground hosting more games on one day than it has pitches (released fixtures only).
  const byGroundDay = new Map<string, FixtureRow[]>();
  for (const r of rows) {
    if (!r.venue || !r.date || !r.released || r.state === 'postponed' || r.state === 'cancelled')
      continue;
    const k = `${norm(r.venue)}|${r.date}`;
    byGroundDay.set(k, [...(byGroundDay.get(k) ?? []), r]);
  }
  const surfacesOf = (r: FixtureRow) =>
    (r.venueId ? venueById.get(r.venueId)?.surfaces : undefined) ??
    venues.find((v) => norm(v.name) === norm(r.venue))?.surfaces ??
    1;
  for (const group of byGroundDay.values())
    if (group.length > surfacesOf(group[0])) for (const r of group) r.issues.unshift('venue-clash');

  return rows.sort(compareRows);
}

/** Date, then start time, then series, then home side. Undated fixtures last. */
export function compareRows(a: FixtureRow, b: FixtureRow): number {
  return (
    (a.date ?? '9999').localeCompare(b.date ?? '9999') ||
    (a.time ?? '99').localeCompare(b.time ?? '99') ||
    a.seriesName.localeCompare(b.seriesName) ||
    a.home.localeCompare(b.home)
  );
}

/* ─── Weeks (Monday to Sunday) ─── */

const DAY = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const toDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (date: string, n: number) => toDate(toMs(date) + n * DAY);

/** The Monday of the week holding `date`. */
export function weekStart(date: string): string {
  const dow = new Date(toMs(date)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

export const inWeek = (r: FixtureRow, monday: string) =>
  !!r.date && r.date >= monday && r.date <= addDays(monday, 6);

/* ─── Search and filters ─── */

export interface FixtureFilter {
  q?: string;
  seriesId?: string;
  clubId?: string;
  venue?: string;
  state?: 'all' | 'upcoming' | 'played' | 'awaiting-result' | 'off';
  issue?: IssueKey | 'any';
  from?: string;
  to?: string;
}

/** Every word of `q` must appear in the teams, ground, series, umpires or result. */
export function matchesQuery(r: FixtureRow, q: string): boolean {
  // "round 3" / "r3" names a round exactly (a bare "3" would match "Division 3" too).
  let rest = norm(q);
  const round = /(?:^| )(?:round ?|r)(\d+)(?= |$)/.exec(rest);
  if (round) {
    if (r.round !== Number(round[1])) return false;
    rest = rest.replace(round[0], ' ');
  }
  const words = rest.split(' ').filter(Boolean);
  if (!words.length) return true;
  const hay = norm(
    [r.home, r.away, r.venue, r.seriesName, ...r.umpires, r.result?.summary].join(' '),
  );
  return words.every((w) => hay.includes(w));
}

export function filterRows(rows: FixtureRow[], f: FixtureFilter): FixtureRow[] {
  return rows.filter((r) => {
    if (f.q && !matchesQuery(r, f.q)) return false;
    if (f.seriesId && r.seriesId !== f.seriesId) return false;
    if (f.clubId && r.homeClubId !== f.clubId && r.awayClubId !== f.clubId) return false;
    if (f.venue && norm(r.venue) !== norm(f.venue)) return false;
    if (f.from && (!r.date || r.date < f.from)) return false;
    if (f.to && (!r.date || r.date > f.to)) return false;
    if (f.issue === 'any' && !r.issues.some((i) => i !== 'draft')) return false;
    if (f.issue && f.issue !== 'any' && !r.issues.includes(f.issue)) return false;
    switch (f.state) {
      case 'upcoming':
        return r.state === 'upcoming' || r.state === 'today';
      case 'played':
        return r.state === 'result' || r.state === 'no-result' || r.state === 'awaiting-result';
      case 'awaiting-result':
        return r.state === 'awaiting-result';
      case 'off':
        return r.state === 'postponed' || r.state === 'cancelled';
      default:
        return true;
    }
  });
}

/* ─── The weekly cycle (Dolphins match-week SOP) ─── */

export interface WeekChecks {
  games: number;
  played: number;
  resultsIn: number;
  awaitingResult: number;
  incomplete: number;
  umpiresShort: number;
  clashes: number;
  postponed: number;
  drafts: number;
}

export function weekChecks(rows: FixtureRow[]): WeekChecks {
  const has = (r: FixtureRow, ...k: IssueKey[]) => k.some((x) => r.issues.includes(x));
  const played = rows.filter((r) => ['result', 'no-result', 'awaiting-result'].includes(r.state));
  return {
    games: rows.filter((r) => r.state !== 'cancelled').length,
    played: played.length,
    resultsIn: played.filter((r) => r.result).length,
    awaitingResult: rows.filter((r) => r.state === 'awaiting-result').length,
    incomplete: rows.filter((r) => has(r, 'venue-tbc', 'time-tbc')).length,
    umpiresShort: rows.filter((r) => has(r, 'no-umpires', 'one-umpire')).length,
    clashes: rows.filter((r) => has(r, 'venue-clash')).length,
    postponed: rows.filter((r) => r.state === 'postponed').length,
    drafts: rows.filter((r) => has(r, 'draft')).length,
  };
}

/** "UKZN CC 186/7 (49.1)" lines, the winner first-class; null before a result. */
export function resultLines(
  r: FixtureRow,
): { home: string; away: string; summary: string | null; winner: 'home' | 'away' | null } | null {
  if (!r.result) return null;
  const w = r.result.winner;
  return {
    home: r.result.homeScore ?? '—',
    away: r.result.awayScore ?? '—',
    summary: r.result.summary ?? (r.result.noResult ? 'No result' : null),
    winner: w === 'home' || w === 'away' ? w : null,
  };
}

/** One CSV line per fixture — the list as the union shares it (Monday confirmations). */
export function toCsv(rows: FixtureRow[]): string {
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = [
    'Date',
    'Time',
    'Series',
    'Round',
    'Home',
    'Away',
    'Ground',
    'Umpires',
    'Status',
    'Home score',
    'Away score',
    'Result',
  ];
  const lines = rows.map((r) =>
    [
      r.date ?? 'TBC',
      r.time ?? 'TBC',
      r.seriesName,
      r.round ?? '',
      r.home,
      r.away,
      r.venue ?? '',
      r.umpires.join(' / '),
      r.state,
      r.result?.homeScore ?? '',
      r.result?.awayScore ?? '',
      r.result?.summary ?? '',
    ]
      .map(esc)
      .join(','),
  );
  return [head.join(','), ...lines].join('\n');
}
