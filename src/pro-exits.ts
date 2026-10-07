/**
 * Exits: who has stopped playing for the squad, and where they are now. Pure.
 *
 * A player's status counts the squad games they have missed since their last one, in the formats
 * they play — a T20 specialist isn't "gone" because the four-day season started first — and
 * measures time from the newest game in the files (not today), so an old export doesn't make
 * everyone look gone: active = missed 3 or fewer, exited = missed 4+ and nothing for 12 months,
 * fading = in between. "Where now" looks for the same name everywhere else
 * the platform can see: another franchise in the scorecards after they left, a scouting pool
 * (club cricket), a senior scouting competition, the Smart Club player register and its
 * clearances. Names are matched exactly (accents, case and punctuation ignored) — a common
 * name can match the wrong person, so every sighting shows its source to check.
 */
import { shortTeam, type ProMatch } from './pro-scorecards';
import { isUs, type Squad } from './pro-team';
import type { ScoutPool } from './scout-pool';
import type { ScoutingEvent } from './scouting-data';

export type ExitStatus = 'active' | 'fading' | 'exited';
export type SightingKind = 'franchise' | 'club' | 'scouting' | 'register' | 'clearance';

export interface Sighting {
  kind: SightingKind;
  where: string;
  date?: string;
  detail: string;
}

export interface RegisterEntry {
  name: string;
  club: string;
  since?: string;
}

export interface ClearanceEntry {
  name: string;
  from: string;
  to: string;
  date: string;
  status: string;
}

export interface ExitRow {
  name: string;
  games: number;
  first: string;
  last: string;
  lastFormat: string;
  /** The formats they've played for the squad. */
  formats: string[];
  /** Squad games in those formats since their last one. */
  missed: number;
  /** Games per season. */
  seasons: Record<string, number>;
  daysSince: number;
  status: ExitStatus;
  sightings: Sighting[];
  whereNow: 'in-squad' | 'still-playing' | 'no-trace';
}

export interface ExitReport {
  asOf: string;
  rows: ExitRow[];
  seasons: string[];
  flow: {
    season: string;
    games: number;
    retained: number;
    arrived: number;
    left: number;
    partial: boolean;
  }[];
}

export const normName = (n: string) =>
  n
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const days = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export const ACTIVE_MISSED = 3;
export const EXITED_DAYS = 365;

export function statusOf(missed: number, daysSince: number): ExitStatus {
  if (missed <= ACTIVE_MISSED) return 'active';
  return daysSince > EXITED_DAYS ? 'exited' : 'fading';
}

/** Every name that played for the squad, with dates, games per season and last format. */
export function squadHistory(squad: Squad) {
  const by = new Map<
    string,
    {
      games: Set<string>;
      dates: string[];
      seasons: Record<string, Set<string>>;
      lastFormat: string;
      formats: Set<string>;
    }
  >();
  for (const m of [...squad.matches].sort((a, b) => a.date.localeCompare(b.date))) {
    const names = new Set<string>();
    for (const inn of m.innings ?? []) {
      if (isUs(squad, inn.bat)) inn.batting.forEach((b) => names.add(b.n));
      else inn.bowling.forEach((b) => names.add(b.n));
    }
    names.forEach((n) => {
      const r = by.get(n) ?? {
        games: new Set<string>(),
        dates: [],
        seasons: {},
        lastFormat: m.format,
        formats: new Set<string>(),
      };
      r.formats.add(m.format);
      r.games.add(m.id);
      r.dates.push(m.date);
      (r.seasons[m.season] ??= new Set()).add(m.id);
      r.lastFormat = m.format;
      by.set(n, r);
    });
  }
  return by;
}

export function exitReport(
  squad: Squad,
  allMatches: ProMatch[],
  sources: {
    pools?: ScoutPool[];
    events?: ScoutingEvent[];
    register?: RegisterEntry[];
    clearances?: ClearanceEntry[];
  } = {},
): ExitReport {
  const history = squadHistory(squad);
  const asOf = squad.matches.reduce((d, m) => (m.date > d ? m.date : d), '');
  const seasons = [...new Set(squad.matches.map((m) => m.season))].sort();

  // Other franchises in the same files, by normalised name → latest appearance.
  const elsewhere = new Map<string, { team: string; date: string }>();
  for (const m of allMatches.filter((x) => x.gender === squad.gender))
    for (const inn of m.innings ?? []) {
      const add = (n: string, team: string) => {
        if (isUs(squad, team)) return;
        const k = normName(n);
        const cur = elsewhere.get(k);
        if (!cur || m.date > cur.date) elsewhere.set(k, { team, date: m.date });
      };
      inn.batting.forEach((b) => add(b.n, inn.bat));
      inn.bowling.forEach((b) => add(b.n, inn.fld));
    }

  const index = new Map<string, Sighting[]>();
  const push = (name: string, s: Sighting) => {
    const k = normName(name);
    index.set(k, [...(index.get(k) ?? []), s]);
  };
  for (const pool of sources.pools ?? [])
    if (pool.gender === squad.gender)
      pool.players.forEach((p) =>
        push(p.name, {
          kind: 'club',
          where: `${p.club}${p.union ? ` (${p.union})` : ''}`,
          date: pool.date,
          detail: pool.name,
        }),
      );
  for (const ev of sources.events ?? []) {
    if (/^u\s?\d+/i.test(ev.ageGroup)) continue;
    ev.players.forEach((p) =>
      push(p.name, {
        kind: 'scouting',
        where: ev.teams.find((t) => t.code === p.hub)?.name ?? p.hub,
        date: ev.dates.to,
        detail: ev.name,
      }),
    );
  }
  (sources.register ?? []).forEach((r) =>
    push(r.name, {
      kind: 'register',
      where: r.club,
      date: r.since,
      detail: 'Smart Club player register',
    }),
  );
  (sources.clearances ?? []).forEach((c) =>
    push(c.name, {
      kind: 'clearance',
      where: `${c.from} → ${c.to}`,
      date: c.date,
      detail: `Clearance (${c.status})`,
    }),
  );

  const rows: ExitRow[] = [...history].map(([name, h]) => {
    const last = h.dates[h.dates.length - 1];
    const daysSince = days(last, asOf);
    const missed = squad.matches.filter((m) => m.date > last && h.formats.has(m.format)).length;
    const status = statusOf(missed, daysSince);
    const sightings: Sighting[] = [];
    const other = elsewhere.get(normName(name));
    if (other && other.date > last)
      sightings.push({
        kind: 'franchise',
        where: shortTeam(other.team),
        date: other.date,
        detail: 'Scorecards',
      });
    sightings.push(...(index.get(normName(name)) ?? []));
    sightings.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    // Evidence they're still playing: anything dated after their last squad game, or a
    // current registration.
    const recent = sightings.some((s) => s.kind === 'register' || (s.date ?? '') > last);
    return {
      name,
      games: h.games.size,
      first: h.dates[0],
      last,
      lastFormat: h.lastFormat,
      formats: [...h.formats],
      missed,
      seasons: Object.fromEntries(Object.entries(h.seasons).map(([k, v]) => [k, v.size])),
      daysSince,
      status,
      sightings,
      whereNow: status === 'active' ? 'in-squad' : recent ? 'still-playing' : 'no-trace',
    };
  });
  rows.sort((a, b) => a.last.localeCompare(b.last) * -1 || a.name.localeCompare(b.name));

  const inSeason = (s: string) => new Set(rows.filter((r) => r.seasons[s]).map((r) => r.name));
  const flow = seasons.map((s, i) => {
    const now = inSeason(s);
    const prev = i ? inSeason(seasons[i - 1]) : new Set<string>();
    const games = squad.matches.filter((m) => m.season === s).length;
    return {
      season: s,
      games,
      // The newest season with only a few games is still under way: "left" means "not yet".
      partial: i === seasons.length - 1 && games < 6,
      retained: [...now].filter((n) => prev.has(n)).length,
      arrived: [...now].filter((n) => !prev.has(n)).length,
      left: [...prev].filter((n) => !now.has(n)).length,
    };
  });
  return { asOf, rows, seasons, flow };
}
