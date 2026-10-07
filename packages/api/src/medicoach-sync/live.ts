/**
 * Match-day monitor (Medicoach sync): one SAST day's fixtures joined to their live-scoring
 * state in medicoach, for the admin "Match monitor".
 *
 *   GET {MedicoachSyncUrl}/integrations/smartclub/live?tenant=<t>&date=YYYY-MM-DD
 *
 * Read-through: nothing is stored. The admin page polls while it is open, so a live game is
 * never older than one poll, unlike results, which arrive on the 15-minute pull. Released
 * series only: a draft's fixtures are not in medicoach, so they could only ever show as
 * "no live scoring".
 *
 * Players: medicoach sends each side's players (team sheet + anyone added with "add player"
 * during the match) with their smart club player ref when they came from here. Each is checked
 * against the side's club roster — registered and active, inactive/clearance pending, active at
 * another club, or not registered at all — and the page is sent that STATUS and the name only.
 * The ref (a hashed ID number) never leaves this module and nothing here logs a player.
 */
import {
  LiveResponseSchema,
  livePathAndQuery,
  signRequest,
  type LiveMatch,
  type LivePlayer,
} from '../medicoach-sync-contract.js';
import { fixtureSyncRef } from '../fixture-identity.js';
import type { Club, PlayerRegistration, Series } from '../types.js';
import { explainSyncError } from './explain.js';
import { MedicoachSyncError } from './puller.js';

const HTTP_TIMEOUT_MS = 8_000;

/** What the roster says about a player who appeared in a match. */
export type PlayerCheck =
  | 'registered' // their ref names an active registration at this side's club
  | 'name-match' // no ref, but the name matches an active registration at this club
  | 'not-active' // registered at this club, but inactive or awaiting a clearance
  | 'other-club' // registered and active at a different club
  | 'unregistered' // no registration found
  | 'unchecked'; // the side has no club yet (a knockout placeholder)

export interface MonitorPlayer {
  side: 'home' | 'away';
  name: string;
  addedDuringMatch: boolean;
  addedAt: string | null;
  check: PlayerCheck;
  /** The club they ARE registered at, for `other-club`. */
  otherClub?: string;
}

export type MonitorLive = Omit<LiveMatch, 'players'> & { players: MonitorPlayer[] };

export interface MonitorMatch {
  ref: string;
  seriesId: string;
  seriesName: string;
  fixtureId: string;
  home: string;
  away: string;
  homeClubId?: string;
  awayClubId?: string;
  venue?: string;
  date: string;
  time?: string;
  fixtureStatus: 'scheduled' | 'postponed' | 'cancelled' | 'completed';
  live: MonitorLive | null;
}

export interface MatchMonitorResponse {
  date: string;
  generatedAt: string;
  dryRun: boolean;
  reachable: boolean;
  error?: string;
  technical?: string;
  matches: MonitorMatch[];
  unmatched: number;
}

interface DayFixture {
  id?: string;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  status?: string;
  venueOverride?: string;
  venueName?: string;
  syncRef?: string;
}

const STATUSES = new Set(['scheduled', 'postponed', 'cancelled', 'completed']);
const SLOT = /^(pos|win|lose|loser|winner):/;

/** Every fixture of a released series on `date`, as the monitor lists it (pure). */
export function fixturesOnDate(
  tenant: string,
  series: Series[],
  clubs: Pick<Club, 'id' | 'name'>[],
  date: string,
): Omit<MonitorMatch, 'live'>[] {
  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  const out: Omit<MonitorMatch, 'live'>[] = [];
  for (const s of series) {
    if (!s.released) continue;
    const name = (teamId?: string) =>
      (teamId &&
        (s.participants?.find((p) => p.teamId === teamId)?.name ?? clubName.get(teamId))) ||
      teamId ||
      'To be decided';
    // A multi-team club plays under its own team id; a legacy series' team id IS the club id.
    const clubOf = (teamId?: string) => {
      if (!teamId || SLOT.test(teamId)) return undefined;
      const p = s.participants?.find((x) => x.teamId === teamId);
      const id = p?.clubId ?? teamId;
      return clubName.has(id) ? id : undefined;
    };
    for (const f of (s.fixtures as DayFixture[]) ?? []) {
      if (!f?.id || f.date !== date) continue;
      const homeVenue = s.participants?.find((p) => p.teamId === f.home)?.venue;
      const venue = f.venueOverride || f.venueName || homeVenue || undefined;
      const homeClubId = clubOf(f.home);
      const awayClubId = clubOf(f.away);
      out.push({
        ref: fixtureSyncRef(tenant, String(s.id), f),
        seriesId: String(s.id),
        seriesName: s.name ?? String(s.id),
        fixtureId: f.id,
        home: name(f.home),
        away: name(f.away),
        ...(homeClubId ? { homeClubId } : {}),
        ...(awayClubId ? { awayClubId } : {}),
        ...(venue ? { venue } : {}),
        date,
        ...(f.time ? { time: f.time } : {}),
        fixtureStatus: (STATUSES.has(f.status ?? '')
          ? f.status
          : 'scheduled') as MonitorMatch['fixtureStatus'],
      });
    }
  }
  return out;
}

/** "Sipho  Ndlovu-Khumalo" → "sipho ndlovu khumalo" (accents, punctuation and case dropped). */
export function nameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface RosterDeps {
  listPlayers: (tenant: string, clubId: string) => Promise<PlayerRegistration[]>;
  clubs: Pick<Club, 'id' | 'name'>[];
}

const isActive = (p: PlayerRegistration) => (p.status ?? 'active') === 'active';

/**
 * Check every player of the day's live matches against the club rosters. Each roster is read
 * once per call (a club playing twice on one day is read once).
 */
export async function checkPlayers(
  tenant: string,
  matches: Array<Omit<MonitorMatch, 'live'> & { live: LiveMatch | null }>,
  deps: RosterDeps,
): Promise<MonitorMatch[]> {
  const rosters = new Map<string, Promise<PlayerRegistration[]>>();
  const roster = (clubId: string) => {
    if (!rosters.has(clubId)) rosters.set(clubId, deps.listPlayers(tenant, clubId));
    return rosters.get(clubId)!;
  };
  const clubName = new Map(deps.clubs.map((c) => [c.id, c.name]));
  const prefix = `smartclub:${tenant}:player:`;

  // Where else is this person registered? Only asked for a ref that isn't on this club's roster.
  const elsewhere = async (naturalKey: string, notClub: string) => {
    for (const c of deps.clubs) {
      if (c.id === notClub) continue;
      const hit = (await roster(c.id)).find((p) => p.naturalKey === naturalKey && isActive(p));
      if (hit) return c.id;
    }
    return null;
  };

  const check = async (
    p: LivePlayer,
    clubId: string | undefined,
  ): Promise<Pick<MonitorPlayer, 'check' | 'otherClub'>> => {
    if (!clubId) return { check: 'unchecked' };
    const rows = await roster(clubId);
    const key = p.ref?.startsWith(prefix) ? p.ref.slice(prefix.length) : null;
    if (key) {
      const row = rows.find((r) => r.naturalKey === key);
      if (row) return { check: isActive(row) ? 'registered' : 'not-active' };
      const other = await elsewhere(key, clubId);
      return other
        ? { check: 'other-club', otherClub: clubName.get(other) ?? other }
        : { check: 'unregistered' };
    }
    const k = nameKey(p.name);
    const byName = rows.filter((r) => nameKey(`${r.firstName} ${r.lastName}`) === k);
    if (byName.some(isActive)) return { check: 'name-match' };
    if (byName.length) return { check: 'not-active' };
    return { check: 'unregistered' };
  };

  return Promise.all(
    matches.map(async (m) => {
      if (!m.live) return { ...m, live: null };
      const { players, ...rest } = m.live;
      const checked: MonitorPlayer[] = await Promise.all(
        players.map(async (p) => ({
          side: p.side,
          name: p.name,
          addedDuringMatch: p.addedDuringMatch,
          addedAt: p.addedAt,
          ...(await check(p, p.side === 'home' ? m.homeClubId : m.awayClubId)),
        })),
      );
      return { ...m, live: { ...rest, players: checked } };
    }),
  );
}

export interface LiveDeps {
  url: string;
  secret: string;
  fetch?: typeof fetch;
}

/** Fetch medicoach's live state for one day. Throws `MedicoachSyncError` on any failure. */
export async function fetchLiveMatches(
  tenant: string,
  date: string,
  deps: LiveDeps,
): Promise<LiveMatch[]> {
  const pq = livePathAndQuery(tenant, date);
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${deps.url}${pq}`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...signRequest({ secret: deps.secret, method: 'GET', pathAndQuery: pq }),
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new MedicoachSyncError(
      `medicoach unreachable: ${err instanceof Error ? err.name : 'request failed'}`,
    );
  }
  if (!res.ok) throw new MedicoachSyncError(`medicoach answered HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new MedicoachSyncError('medicoach answered with a body that is not JSON');
  }
  const parsed = LiveResponseSchema.safeParse(body);
  // Paths only: a zod message can echo a value, and a value here may be a player's name/ref.
  if (!parsed.success)
    throw new MedicoachSyncError(
      `medicoach response failed the v1 contract at ${parsed.error.issues
        .slice(0, 3)
        .map((i) => i.path.join('.') || '(root)')
        .join(', ')}`,
    );
  if (parsed.data.tenant !== tenant)
    throw new MedicoachSyncError('medicoach answered for a different tenant');
  return parsed.data.matches;
}

/**
 * The monitor for one day: smart club's fixtures, each with its live match (or null) and its
 * players checked against the rosters. A medicoach failure still answers with the fixtures
 * (`reachable: false` + the reason), so the page keeps showing the day's schedule.
 */
export async function buildMatchMonitor(
  tenant: string,
  date: string,
  input: { series: Series[]; clubs: Pick<Club, 'id' | 'name'>[] },
  deps: LiveDeps & {
    now?: () => Date;
    listPlayers: RosterDeps['listPlayers'];
  },
): Promise<MatchMonitorResponse> {
  const now = deps.now ?? (() => new Date());
  const day = fixturesOnDate(tenant, input.series, input.clubs, date);
  const base = { date, generatedAt: now().toISOString() };
  if (!deps.url || !deps.secret)
    return {
      ...base,
      dryRun: true,
      reachable: false,
      matches: day.map((m) => ({ ...m, live: null })),
      unmatched: 0,
    };
  let live: LiveMatch[];
  try {
    live = await fetchLiveMatches(tenant, date, deps);
  } catch (err) {
    if (!(err instanceof MedicoachSyncError)) throw err;
    return {
      ...base,
      dryRun: false,
      reachable: false,
      // The explainer's "try again in 15 minutes" is the cron's cadence; this page polls.
      error: explainSyncError(err.message).replace(
        /\s*We'll try again automatically in 15 minutes\./,
        ' The monitor keeps trying while this page is open.',
      ),
      technical: err.message,
      matches: day.map((m) => ({ ...m, live: null })),
      unmatched: 0,
    };
  }
  const byRef = new Map(live.map((l) => [l.ref, l]));
  const refs = new Set(day.map((m) => m.ref));
  return {
    ...base,
    dryRun: false,
    reachable: true,
    matches: await checkPlayers(
      tenant,
      day.map((m) => ({ ...m, live: byRef.get(m.ref) ?? null })),
      { listPlayers: deps.listPlayers, clubs: input.clubs },
    ),
    unmatched: live.filter((l) => !refs.has(l.ref)).length,
  };
}
