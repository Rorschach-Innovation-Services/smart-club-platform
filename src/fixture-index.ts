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
  /** Ground time and balls from the scorecard (contract `play`); null when not sent. */
  play?: {
    startedAt: string | null;
    endedAt: string | null;
    legalBalls: number | null;
    deliveries: number | null;
  } | null;
  /** The office's confirmation of THIS result (admin only). */
  confirmation?: { confirmedAt: string; confirmedBy: string; note?: string } | null;
  /** The office confirmed an earlier version of this result: check it again. */
  changedSinceConfirmed?: boolean;
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
  officials?: {
    umpires?: Array<{ umpireId?: string; name?: string }>;
    scorers?: Array<{ scorerId?: string; name?: string }>;
  };
  syncMapped?: boolean;
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
  | 'result-changed'
  | 'venue-clash'
  | 'unconfirmed'
  | 'no-umpires'
  | 'one-umpire'
  | 'no-scorer'
  | 'venue-tbc'
  | 'time-tbc'
  | 'draft';

export const ISSUES: Record<IssueKey, { label: string; tone: 'alert' | 'warn' | 'info' }> = {
  'awaiting-result': { label: 'Result missing', tone: 'alert' },
  'result-changed': { label: 'Result changed since confirmed', tone: 'alert' },
  'venue-clash': { label: 'Ground double-booked', tone: 'alert' },
  unconfirmed: { label: 'Result to confirm', tone: 'warn' },
  'no-umpires': { label: 'No umpires', tone: 'warn' },
  'one-umpire': { label: 'One umpire', tone: 'warn' },
  'no-scorer': { label: 'No scorer', tone: 'warn' },
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
  /** Medicoach owns this fixture's result (the series is synced). */
  syncMapped: boolean;
  umpires: string[];
  umpireIds: string[];
  scorers: string[];
  scorerIds: string[];
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
      const umpireRefs = (raw.officials?.umpires ?? []).filter((u) => u.umpireId || u.name);
      const umpires = umpireRefs.map((u) => u.name ?? u.umpireId ?? '');
      const scorerRefs = (raw.officials?.scorers ?? []).filter((x) => x.scorerId || x.name);
      const scorers = scorerRefs.map((x) => x.name ?? x.scorerId ?? '');
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
      const played = state === 'result' || state === 'no-result';
      const issues: IssueKey[] = [];
      if (state === 'awaiting-result') issues.push('awaiting-result');
      if (played && result?.changedSinceConfirmed) issues.push('result-changed');
      else if (played && !result?.confirmation) issues.push('unconfirmed');
      if (!off && !umpires.length) issues.push('no-umpires');
      else if (!off && umpires.length === 1) issues.push('one-umpire');
      // Scorers are a pre-match job: flag a missing one only while the game is still to come.
      if ((state === 'upcoming' || state === 'today') && !scorers.length) issues.push('no-scorer');
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
        syncMapped: raw.syncMapped === true,
        umpires,
        umpireIds: umpireRefs.map((u) => u.umpireId ?? '').filter(Boolean),
        scorers,
        scorerIds: scorerRefs.map((x) => x.scorerId ?? '').filter(Boolean),
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
    [r.home, r.away, r.venue, r.seriesName, ...r.umpires, ...r.scorers, r.result?.summary].join(
      ' ',
    ),
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
  /** Results the office has confirmed (the current version). */
  confirmed: number;
  /** Results in but not (or no longer) confirmed. */
  toConfirm: number;
  awaitingResult: number;
  scorersShort: number;
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
    confirmed: played.filter((r) => r.result?.confirmation).length,
    toConfirm: rows.filter((r) => has(r, 'unconfirmed', 'result-changed')).length,
    awaitingResult: rows.filter((r) => r.state === 'awaiting-result').length,
    scorersShort: rows.filter((r) => has(r, 'no-scorer')).length,
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
    'Scorers',
    'Status',
    'Home score',
    'Away score',
    'Result',
    'Confirmed by',
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
      r.scorers.join(' / '),
      r.state,
      r.result?.homeScore ?? '',
      r.result?.awayScore ?? '',
      r.result?.summary ?? '',
      r.result?.confirmation?.confirmedBy ?? '',
    ]
      .map(esc)
      .join(','),
  );
  return [head.join(','), ...lines].join('\n');
}

/* ─── Ground usage (pitch-load proxy) ─── */

/**
 * When a ground counts as heavily used: this many games, or this many legal balls, in the 7
 * days to today. A starting proxy for pitch health — about three T20s or one and a half
 * one-day games in a week — to be tuned with the union's groundsmen.
 */
export const HEAVY_WEEK_GAMES = 3;
export const HEAVY_WEEK_BALLS = 720;
/** No game for this many days ⇒ "rested". */
export const RESTED_DAYS = 14;

export interface GroundUsage {
  venue: string;
  /** Played games (a result is in) on this ground. */
  played: number;
  /** Of those, how many came with ground time and balls from the scorecard. */
  withPlay: number;
  /** Minutes on the ground, first ball to last, summed. */
  minutes: number;
  legalBalls: number;
  deliveries: number;
  /** Games still to come on this ground (not postponed/cancelled). */
  upcoming: number;
  lastPlayed: string | null;
  weekGames: number;
  weekBalls: number;
  /** Legal balls per week, oldest first, for the last `weeks` Monday-to-Sunday weeks. */
  weekly: Array<{ monday: string; balls: number; games: number }>;
  load: 'heavy' | 'normal' | 'rested' | 'unused';
}

const minutesOf = (p?: FixtureResult['play']) =>
  p?.startedAt && p.endedAt
    ? Math.max(0, Math.round((Date.parse(p.endedAt) - Date.parse(p.startedAt)) / 60_000))
    : 0;

export function groundUsage(rows: FixtureRow[], today: string, weeks = 6): GroundUsage[] {
  const thisMonday = weekStart(today);
  const mondays = Array.from({ length: weeks }, (_, i) => addDays(thisMonday, (i - weeks + 1) * 7));
  const weekFrom = addDays(today, -6);
  const byVenue = new Map<string, FixtureRow[]>();
  for (const r of rows) {
    if (!r.venue || r.state === 'cancelled') continue;
    const k = norm(r.venue);
    byVenue.set(k, [...(byVenue.get(k) ?? []), r]);
  }
  const out: GroundUsage[] = [];
  for (const games of byVenue.values()) {
    const played = games.filter(
      (r) => (r.state === 'result' || r.state === 'no-result') && r.date && r.date <= today,
    );
    const balls = (r: FixtureRow) => r.result?.play?.legalBalls ?? 0;
    const week = played.filter((r) => r.date! >= weekFrom);
    const lastPlayed =
      played
        .map((r) => r.date!)
        .sort()
        .pop() ?? null;
    const weekBalls = week.reduce((n, r) => n + balls(r), 0);
    const upcoming = games.filter((r) => r.state === 'upcoming' || r.state === 'today').length;
    out.push({
      venue: games[0].venue!,
      played: played.length,
      withPlay: played.filter((r) => r.result?.play).length,
      minutes: played.reduce((n, r) => n + minutesOf(r.result?.play), 0),
      legalBalls: played.reduce((n, r) => n + balls(r), 0),
      deliveries: played.reduce((n, r) => n + (r.result?.play?.deliveries ?? 0), 0),
      upcoming,
      lastPlayed,
      weekGames: week.length,
      weekBalls,
      weekly: mondays.map((m) => {
        const inW = played.filter((r) => inWeek(r, m));
        return { monday: m, games: inW.length, balls: inW.reduce((n, r) => n + balls(r), 0) };
      }),
      load:
        !played.length && !upcoming
          ? 'unused'
          : week.length >= HEAVY_WEEK_GAMES || weekBalls >= HEAVY_WEEK_BALLS
            ? 'heavy'
            : !lastPlayed || lastPlayed < addDays(today, -RESTED_DAYS)
              ? 'rested'
              : 'normal',
    });
  }
  const rank = { heavy: 0, normal: 1, rested: 2, unused: 3 };
  return out.sort(
    (a, b) =>
      rank[a.load] - rank[b.load] || b.legalBalls - a.legalBalls || a.venue.localeCompare(b.venue),
  );
}
