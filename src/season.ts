/* ─── Season state: released fixtures resolved for dashboards (no React) ─── */

import { teamIdsForClub, resolveTeam } from './data';

export interface SeasonFixture {
  key: string;
  date: string;
  seriesId: string;
  series: string;
  homeName: string;
  awayName: string;
  homeClubId: string;
  awayClubId: string;
  venue: string;
}

export interface ClubFixture {
  key: string;
  date: string;
  series: string;
  isHome: boolean;
  oppClubId: string;
  oppName: string;
  venue: string;
}

type ClubBy = (id: string) => { id: string; name: string; ground?: { venue?: string } } | undefined;

/** Local YYYY-MM-DD (toISOString would shift SAST dates back a day via UTC). */
export const localISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const addDays = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localISO(d);
};

export const daysBetween = (fromISO: string, toISO: string) =>
  Math.round(
    (new Date(toISO + 'T00:00:00').getTime() - new Date(fromISO + 'T00:00:00').getTime()) /
      86400000,
  );

const fixtureKey = (s, f, i) => `${s.id}:${f.id ?? i}`;

/**
 * Same precedence as the club Fixtures view: a withheld venue stays unannounced, an
 * allocated ground beats the home side's own ground.
 */
function venueOf(s, f, homeSide) {
  if (s?.withheld?.venue) return 'Venue to be confirmed';
  return f.venueOverride || f.venueName || homeSide.ground?.venue || '';
}

/**
 * Every dated fixture in released series, with both sides resolved through the
 * series participants (so multi-team `tm_…` clubs and pinned venues are honoured).
 * Knockout slots whose teams aren't known yet ("Winner of …") are skipped.
 */
export function releasedFixtures(allSeries, clubBy: ClubBy): SeasonFixture[] {
  const out: SeasonFixture[] = [];
  (allSeries || [])
    .filter((s) => s.released && Array.isArray(s.fixtures))
    .forEach((s) =>
      s.fixtures.forEach((f, i) => {
        if (!f.date) return;
        const home = resolveTeam(s, f.home, clubBy);
        const away = resolveTeam(s, f.away, clubBy);
        if (home.pending || away.pending) return;
        out.push({
          key: fixtureKey(s, f, i),
          date: f.date,
          seriesId: s.id,
          series: s.name,
          homeName: home.name,
          awayName: away.name,
          homeClubId: home.clubId || '',
          awayClubId: away.clubId || '',
          venue: venueOf(s, f, home),
        });
      }),
    );
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.series.localeCompare(b.series));
}

/** One club's released fixtures, newest first, from its own point of view. */
export function clubFixtures(allSeries, clubId: string, clubBy: ClubBy): ClubFixture[] {
  const out: ClubFixture[] = [];
  (allSeries || [])
    .filter((s) => s.released && Array.isArray(s.fixtures))
    .forEach((s) => {
      const mine = teamIdsForClub(s, clubId);
      s.fixtures.forEach((f, i) => {
        if (!f.date) return;
        const isHome = mine.includes(f.home);
        if (!isHome && !mine.includes(f.away)) return;
        const opp = resolveTeam(s, isHome ? f.away : f.home, clubBy);
        if (opp.pending) return;
        const venue = venueOf(s, f, resolveTeam(s, f.home, clubBy));
        out.push({
          key: fixtureKey(s, f, i),
          date: f.date,
          series: s.name,
          isHome,
          oppClubId: opp.clubId || '',
          oppName: opp.name,
          venue: venue || '',
        });
      });
    });
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** The season is "on" once any released fixture date has arrived. */
export const seasonStarted = (fixtures: { date: string }[], today: string) =>
  fixtures.some((f) => f.date <= today);

export function seasonProgress(fixtures: { date: string }[], today: string) {
  const dates = fixtures.map((f) => f.date).sort();
  const played = fixtures.filter((f) => f.date < today).length;
  const todayCount = fixtures.filter((f) => f.date === today).length;
  const next = dates.find((d) => d >= today) ?? null;
  return {
    total: fixtures.length,
    played,
    today: todayCount,
    remaining: fixtures.length - played - todayCount,
    first: dates[0] ?? null,
    last: dates[dates.length - 1] ?? null,
    next,
    pct: fixtures.length ? Math.round((played / fixtures.length) * 100) : 0,
  };
}

/** Fixtures in the next `days` days (today included) and the previous `days` days. */
export function weekWindow<T extends { date: string }>(fixtures: T[], today: string, days = 7) {
  const ahead = addDays(today, days - 1);
  const behind = addDays(today, -days);
  return {
    upcoming: fixtures
      .filter((f) => f.date >= today && f.date <= ahead)
      .sort((a, b) => a.date.localeCompare(b.date)),
    recent: fixtures
      .filter((f) => f.date < today && f.date >= behind)
      .sort((a, b) => b.date.localeCompare(a.date)),
  };
}

/** Per-series progress for released series. */
export function seriesProgress(fixtures: SeasonFixture[], today: string) {
  const by = new Map<string, SeasonFixture[]>();
  fixtures.forEach((f) => by.set(f.seriesId, [...(by.get(f.seriesId) || []), f]));
  return [...by.values()].map((list) => ({
    seriesId: list[0].seriesId,
    series: list[0].series,
    ...seasonProgress(list, today),
  }));
}
