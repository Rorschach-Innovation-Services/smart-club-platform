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
import { z } from 'zod';
import {
  LiveMatchSchema,
  LiveResponseSchema,
  livePathAndQuery,
  signRequest,
  type LiveMatch,
  type LivePlayer,
} from '../medicoach-sync-contract.js';
import { fixtureSyncRef } from '../fixture-identity.js';
import type {
  Club,
  PlayerRegistration,
  Series,
  StoredFixtureResult,
  SyncHealth,
} from '../types.js';
import { explainSyncError } from './explain.js';
import { MedicoachSyncError } from './puller.js';

const HTTP_TIMEOUT_MS = 8_000;

/*
 * In-memory caches, per Lambda container. Concurrent polls usually land on different
 * containers, so neither is shared; both only cut repeat work inside one warm container.
 * Deliberately not in DynamoDB: the data is seconds-to-minutes fresh and cheap to rebuild,
 * and a shared cache would cost a read+write on every poll to save at most a few reads.
 */

/** Club rosters change rarely; the monitor polls every 30 s. */
export const ROSTER_TTL_MS = 5 * 60_000;
const rosterCache = new Map<string, { at: number; rows: Promise<PlayerRegistration[]> }>();

/** A whole day's monitor answer, so a burst of polls for one day makes one medicoach call. */
export const RESPONSE_TTL_MS = 15_000;
const responseCache = new Map<string, { at: number; payload: MatchMonitorResponse }>();

/** Forget every cached roster and response (tests, and after a roster import if ever needed). */
export function resetLiveCaches(): void {
  rosterCache.clear();
  responseCache.clear();
}

/** What the roster says about a player who appeared in a match. */
export type PlayerCheck =
  | 'registered' // their ref names an active registration at this side's club
  | 'name-match' // no ref, but the name matches an active registration at this club
  | 'not-active' // registered at this club, but inactive or awaiting a clearance
  | 'other-club' // registered and active at a different club
  | 'unregistered' // no registration found
  | 'unchecked'; // the side has no club yet (a knockout placeholder), or its roster read failed

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
  /**
   * True when the connection console lists this fixture as awaiting a medicoach carry
   * (MCAWAIT#): medicoach has no match for it yet, so "no live scoring" is not the scorer's.
   */
  notInMedicoach?: boolean;
  /** The result smart club holds for it (pulled, or an administrator's override). */
  result?: { summary: string; manual: boolean };
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
  /** Live matches medicoach sent that failed the contract and were left out (the rest show). */
  parseFailures: number;
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
  /** Injectable clock for the roster cache TTL (tests). */
  now?: () => Date;
}

const isActive = (p: PlayerRegistration) => (p.status ?? 'active') === 'active';

/**
 * Check every player of the day's live matches against the club rosters. Each roster is read
 * once per ROSTER_TTL_MS in this container (a club playing twice on one day is read once).
 */
export async function checkPlayers(
  tenant: string,
  matches: Array<Omit<MonitorMatch, 'live'> & { live: LiveMatch | null }>,
  deps: RosterDeps,
): Promise<MonitorMatch[]> {
  // Each roster is read at most once per ROSTER_TTL_MS: an unregistered player sends
  // `elsewhere` through every club's roster, and the page asks again every 30 s.
  const roster = (clubId: string) => {
    const key = `${tenant}|${clubId}`;
    const hit = rosterCache.get(key);
    const nowMs = (deps.now ?? (() => new Date()))().getTime();
    if (hit && nowMs - hit.at < ROSTER_TTL_MS) return hit.rows;
    const rows = deps.listPlayers(tenant, clubId);
    for (const [k, v] of rosterCache) if (nowMs - v.at >= ROSTER_TTL_MS) rosterCache.delete(k);
    rosterCache.set(key, { at: nowMs, rows });
    // A failed read is never cached; the next poll tries again.
    rows.catch(() => {
      if (rosterCache.get(key)?.rows === rows) rosterCache.delete(key);
    });
    return rows;
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
    let rows: PlayerRegistration[];
    try {
      rows = await roster(clubId);
    } catch {
      // A failed roster read degrades this player to unchecked rather than sinking the day.
      // Nothing is logged: the player's name/ref must not reach the logs.
      return { check: 'unchecked' };
    }
    const key = p.ref?.startsWith(prefix) ? p.ref.slice(prefix.length) : null;
    if (key) {
      const row = rows.find((r) => r.naturalKey === key);
      if (row) return { check: isActive(row) ? 'registered' : 'not-active' };
      let other: string | null;
      try {
        other = await elsewhere(key, clubId);
      } catch {
        return { check: 'unchecked' };
      }
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

/** A medicoach match is "live" here while it is being scored (not before, not after). */
const LIVE_STATUSES = new Set<LiveMatch['status']>(['in_progress', 'innings_break']);

/**
 * Merge one fetch's live facet into SYNCHEALTH#, keeping `liveFailingSince` at the first
 * failure of a run of failures (one extra read per real fetch; the response cache bounds it).
 */
export async function recordLiveHealth(
  repo: {
    getSyncHealth: (tenant: string) => Promise<SyncHealth | null>;
    putSyncHealth: (tenant: string, patch: SyncHealth) => Promise<void>;
  },
  tenant: string,
  patch: SyncHealth,
): Promise<void> {
  if (patch.liveLastErrorAt) {
    const prev = await repo.getSyncHealth(tenant);
    const wasFailing =
      prev?.liveFailingSince &&
      (!prev.liveLastOkAt || Date.parse(prev.liveFailingSince) > Date.parse(prev.liveLastOkAt));
    patch = {
      ...patch,
      liveFailingSince: wasFailing ? prev!.liveFailingSince : patch.liveLastErrorAt,
    };
  }
  await repo.putSyncHealth(tenant, patch);
}

/**
 * The live facet of SYNCHEALTH# for one real fetch (pure): ok or failed, and — when the answer
 * had a live match — whether any live match came without a medicoach link.
 */
export function liveHealthPatch(
  at: string,
  outcome: { ok: true; matches: LiveMatch[] } | { ok: false; error: string },
): SyncHealth {
  if (!outcome.ok) return { liveLastErrorAt: at, liveLastError: outcome.error };
  const liveNow = outcome.matches.filter((m) => LIVE_STATUSES.has(m.status));
  return {
    liveLastOkAt: at,
    ...(liveNow.length
      ? {
          liveLinksUnconfigured: liveNow.some((m) => m.medicoachMatchUrl === null),
          liveLinksCheckedAt: at,
        }
      : {}),
  };
}

/** The live response with each match left unparsed, so one bad match can't sink the day. */
const LiveEnvelopeSchema = LiveResponseSchema.extend({ matches: z.array(z.unknown()) });

/**
 * Fetch medicoach's live state for one day. Throws `MedicoachSyncError` when the request or
 * the envelope fails; a single match that fails the contract is dropped and counted instead.
 */
export async function fetchLiveMatches(
  tenant: string,
  date: string,
  deps: LiveDeps,
): Promise<{ matches: LiveMatch[]; parseFailures: number }> {
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
  const parsed = LiveEnvelopeSchema.safeParse(body);
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
  if (parsed.data.date !== date)
    throw new MedicoachSyncError('medicoach answered for a different date');
  const matches: LiveMatch[] = [];
  let parseFailures = 0;
  for (const raw of parsed.data.matches) {
    // Counted, never logged: a failing match may carry a player's name or ref.
    const one = LiveMatchSchema.safeParse(raw);
    if (one.success) matches.push(one.data);
    else parseFailures++;
  }
  return { matches, parseFailures };
}

/**
 * The monitor for one day: smart club's fixtures, each with its live match (or null) and its
 * players checked against the rosters. A medicoach failure still answers with the fixtures
 * (`reachable: false` + the reason), so the page keeps showing the day's schedule.
 */
export async function buildMatchMonitor(
  tenant: string,
  date: string,
  input: {
    series: Series[];
    clubs: Pick<Club, 'id' | 'name'>[];
    /** Fixture refs the connection console lists as awaiting a medicoach carry (MCAWAIT#). */
    awaitingRefs?: ReadonlySet<string>;
  },
  deps: LiveDeps & {
    now?: () => Date;
    listPlayers: RosterDeps['listPlayers'];
    /** The stored result of one fixture (only asked for games that are over). */
    getResult?: (
      seriesId: string,
      fixtureId: string,
    ) => Promise<Pick<StoredFixtureResult, 'summary' | 'cleared' | 'resultSource'> | null>;
    /** Merge the live facet into SYNCHEALTH# (real fetches only; a failure here is logged, never thrown). */
    recordHealth?: (patch: SyncHealth) => Promise<void>;
  },
): Promise<MatchMonitorResponse> {
  const now = deps.now ?? (() => new Date());
  const cacheKey = `${tenant}|${date}`;
  const cached = responseCache.get(cacheKey);
  if (cached && now().getTime() - cached.at < RESPONSE_TTL_MS) return cached.payload;
  const day = fixturesOnDate(tenant, input.series, input.clubs, date).map((m) =>
    input.awaitingRefs?.has(m.ref) ? { ...m, notInMedicoach: true } : m,
  );
  const base = { date, generatedAt: now().toISOString() };
  if (!deps.url || !deps.secret)
    return {
      ...base,
      dryRun: true,
      reachable: false,
      matches: day.map((m) => ({ ...m, live: null })),
      unmatched: 0,
      parseFailures: 0,
    };
  const record = async (patch: SyncHealth) => {
    if (!deps.recordHealth) return;
    try {
      await deps.recordHealth(patch);
    } catch (err) {
      // The console line goes stale; the monitor still answers. No payload data is logged.
      console.error('match monitor: recording live health failed', {
        tenant,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  // A stored result is decoration: a failed read leaves it off rather than failing the poll.
  const resultOf = async (m: { seriesId: string; fixtureId: string }) => {
    if (!deps.getResult) return undefined;
    try {
      const r = await deps.getResult(m.seriesId, m.fixtureId);
      return r && !r.cleared && r.summary
        ? { summary: r.summary, manual: r.resultSource === 'manual' }
        : undefined;
    } catch {
      return undefined;
    }
  };
  let live: LiveMatch[];
  let parseFailures: number;
  try {
    ({ matches: live, parseFailures } = await fetchLiveMatches(tenant, date, deps));
  } catch (err) {
    if (!(err instanceof MedicoachSyncError)) throw err;
    await record(liveHealthPatch(base.generatedAt, { ok: false, error: err.message }));
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
      // A completed fixture keeps its stored result through the outage.
      matches: await Promise.all(
        day.map(async (m) => {
          const result = m.fixtureStatus === 'completed' ? await resultOf(m) : undefined;
          return { ...m, ...(result ? { result } : {}), live: null };
        }),
      ),
      unmatched: 0,
      parseFailures: 0,
    };
  }
  await record(liveHealthPatch(base.generatedAt, { ok: true, matches: live }));
  const byRef = new Map(live.map((l) => [l.ref, l]));
  const refs = new Set(day.map((m) => m.ref));
  const joined = await Promise.all(
    day.map(async (m) => {
      const l = byRef.get(m.ref) ?? null;
      // A medicoach match counts as linked once it is in the live answer, whatever MCAWAIT# says.
      const { notInMedicoach, ...rest } = m;
      const over =
        m.fixtureStatus === 'completed' || l?.status === 'completed' || l?.status === 'abandoned';
      const result = over ? await resultOf(m) : undefined;
      return {
        ...rest,
        ...(notInMedicoach && !l ? { notInMedicoach } : {}),
        ...(result ? { result } : {}),
        live: l,
      };
    }),
  );
  const payload: MatchMonitorResponse = {
    ...base,
    dryRun: false,
    reachable: true,
    matches: await checkPlayers(tenant, joined, {
      listPlayers: deps.listPlayers,
      clubs: input.clubs,
      now,
    }),
    unmatched: live.filter((l) => !refs.has(l.ref)).length,
    parseFailures,
  };
  // Only a good answer is reused; a failure is retried on the next poll.
  // Sweep expired entries so the cache stays bounded by live days, not every day ever asked for.
  for (const [k, v] of responseCache)
    if (now().getTime() - v.at >= RESPONSE_TTL_MS) responseCache.delete(k);
  responseCache.set(cacheKey, { at: now().getTime(), payload });
  return payload;
}

/**
 * True when medicoach reports the fixture as being scored right now (in progress or at the
 * innings break) on `date`. Asked before a postponement moves a fixture, so the club can be
 * warned. Fail-open: an unconfigured, unreachable or off-contract medicoach answers false —
 * the warning is advice, never a gate the postponement depends on.
 */
export async function fixtureLiveInMedicoach(
  tenant: string,
  ref: string,
  date: string,
  deps: LiveDeps,
): Promise<boolean> {
  if (!deps.url || !deps.secret) return false;
  try {
    const { matches } = await fetchLiveMatches(tenant, date, deps);
    return matches.some((m) => m.ref === ref && LIVE_STATUSES.has(m.status));
  } catch (err) {
    if (err instanceof MedicoachSyncError) return false;
    throw err;
  }
}
