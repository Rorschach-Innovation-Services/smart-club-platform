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
 * The response carries no player data (fixture refs, scores, timings and team names only), so
 * nothing here needs the PII handling the changes feed does.
 */
import {
  LiveResponseSchema,
  livePathAndQuery,
  signRequest,
  type LiveMatch,
} from '../medicoach-sync-contract.js';
import { fixtureSyncRef } from '../fixture-identity.js';
import type { Club, Series } from '../types.js';
import { explainSyncError } from './explain.js';
import { MedicoachSyncError } from './puller.js';

const HTTP_TIMEOUT_MS = 8_000;

export interface MonitorMatch {
  ref: string;
  seriesId: string;
  seriesName: string;
  fixtureId: string;
  home: string;
  away: string;
  venue?: string;
  date: string;
  time?: string;
  fixtureStatus: 'scheduled' | 'postponed' | 'cancelled' | 'completed';
  live: LiveMatch | null;
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
    for (const f of (s.fixtures as DayFixture[]) ?? []) {
      if (!f?.id || f.date !== date) continue;
      const homeVenue = s.participants?.find((p) => p.teamId === f.home)?.venue;
      const venue = f.venueOverride || f.venueName || homeVenue || undefined;
      out.push({
        ref: fixtureSyncRef(tenant, String(s.id), f),
        seriesId: String(s.id),
        seriesName: s.name ?? String(s.id),
        fixtureId: f.id,
        home: name(f.home),
        away: name(f.away),
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
 * The monitor for one day: smart club's fixtures, each with its live match (or null). A
 * medicoach failure still answers with the fixtures (`reachable: false` + the reason), so the
 * page keeps showing the day's schedule.
 */
export async function buildMatchMonitor(
  tenant: string,
  date: string,
  input: { series: Series[]; clubs: Pick<Club, 'id' | 'name'>[] },
  deps: LiveDeps & { now?: () => Date },
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
  try {
    const live = await fetchLiveMatches(tenant, date, deps);
    const byRef = new Map(live.map((l) => [l.ref, l]));
    const refs = new Set(day.map((m) => m.ref));
    return {
      ...base,
      dryRun: false,
      reachable: true,
      matches: day.map((m) => ({ ...m, live: byRef.get(m.ref) ?? null })),
      unmatched: live.filter((l) => !refs.has(l.ref)).length,
    };
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
}
