/**
 * Medicoach sync puller (ADR 0016, Slice 2 / Task 2.1): pull changed fixtures from
 * medicoach and apply what smart club stores from them.
 *
 *   GET {MedicoachSyncUrl}/integrations/smartclub/changes?tenant=<t>&since=<cursor>
 *
 * Runs from one `sst.aws.Cron` every 15 minutes (every tenant with `features.medicoachSync`)
 * and from the admin "Sync now" route (the caller's tenant only). Each page is applied, then
 * the cursor advances, and the loop continues while `hasMore`.
 *
 * What a pulled fixture change does today:
 *   - result      → FIXRESULT#<seriesId>#<fixtureId>, only if `recordedAt` is newer than the
 *                   stored item; a `resultClearedAt` newer than it leaves a tombstone. A NEW
 *                   store calls `onResultStored` (opens captain's reports) — a replay
 *                   never does; a newly stored clear calls `onResultCleared` (voids them).
 *   - teams       → a knockout slot (`pos:`/`win:` placeholder) takes the resolved team when
 *                   the team ref names one of that series' own team ids (version-checked).
 *   - schedule    → a difference is counted + listed in SYNCLOG and handed to
 *                   `onScheduleDiffers` — by default `applyInboundSchedule` (Slice 3,
 *                   schedule.ts): most-recent-wins, then the clash gate, then apply or hold
 *                   as SYNCCONFLICT#.
 *   - unknown ref → counted as "unmapped" (no ref values logged).
 *
 * A newly stored result is first marked `REPORTOPEN#<ref>`; the marker is deleted once the
 * hook succeeded, so a report/notify failure is retried by the next run
 * (`retryPendingReportOpens`, up to REPORT_OPEN_MAX_ATTEMPTS) instead of being lost — a
 * replay never re-fires the hook. A notice counts as failed only when it reached nobody
 * (every channel tried failed): its NOTIFY# claim is released and the hook throws, so the
 * retry re-sends it. One channel delivered is done; a delivered notice is never re-sent.
 *
 * Idempotent per fixture: re-applying the same page changes nothing, so a full resync
 * (no cursor) is always safe.
 *
 * Dry-run: with `MedicoachSyncUrl` or `MedicoachSyncSecret` empty the puller logs the
 * request it would make and stops — no HTTP, no writes.
 *
 * PII: a result's `captainRef` is a player ref (a hashed ID number). It is NOT stored on the
 * result item: it is handed to the captain's-report hook in memory (resolved to a roster row
 * at open time, then dropped) and kept only on the `REPORTOPEN#` marker while that opening is
 * pending, so a retry can still address the captain; the marker is deleted once the reports
 * opened (or the retries gave up). It is NEVER logged or written to SYNCLOG — nothing here
 * prints a fixture change, only counts and fixture refs.
 */
import { randomUUID } from 'node:crypto';
import { isSlotRef } from '../../../engine/src/formats.js';
import {
  captainsReportClearedHook,
  captainsReportResultHook,
  type CaptainsReportDeps,
} from '../captains-reports.js';
import { hasFeature } from '../features.js';
import { fixtureSyncRef } from '../fixture-identity.js';
import {
  ChangesResponseSchema,
  changesPathAndQuery,
  isoInstant,
  parseFixtureRef,
  parseTeamRef,
  signRequest,
  type FixtureChange,
  type SyncResult,
} from '../medicoach-sync-contract.js';
import type { Series, StoredFixtureResult, SyncLogEntry, TenantConfig } from '../types.js';
import {
  applyInboundSchedule,
  wallClock,
  type InboundApplyCache,
  type ScheduleOutcome,
} from './schedule.js';

export { wallClock };

type RepoModule = typeof import('../repo.js');

/** Max pages per run — a runaway `hasMore` can't loop forever; the next run continues. */
export const MAX_PAGES_PER_RUN = 50;
/** Changes per page requested from medicoach. */
export const PAGE_LIMIT = 200;
/** Max schedule-differs refs kept on one SYNCLOG row. */
const MAX_LOGGED_REFS = 50;
const HTTP_TIMEOUT_MS = 10_000;

/** Passed to `onResultStored` when a result is stored for the first time or replaced by a
 * newer one. Carries the full pulled result (captainRef included) — handle it as PII. */
export interface ResultStoredEvent {
  tenant: string;
  seriesId: string;
  fixtureId: string;
  ref: string;
  result: SyncResult;
  /** True when no live (non-cleared) result was stored before this one. */
  first: boolean;
  config: TenantConfig;
}

/** Passed to `onResultCleared` when a clear tombstone is newly stored for a fixture. */
export interface ResultClearedEvent {
  tenant: string;
  seriesId: string;
  fixtureId: string;
  ref: string;
}

/** A fixture whose medicoach schedule differs from smart club's. */
export interface ScheduleDiffersEvent {
  tenant: string;
  seriesId: string;
  fixtureId: string;
  ref: string;
  change: FixtureChange;
  /** Which fields differ: 'date' | 'time' | 'venue' | 'status' | 'dateTbc'. */
  fields: string[];
}

/** A record-only schedule handler (counts the difference, applies nothing). */
export async function recordScheduleDiffers(_event: ScheduleDiffersEvent): Promise<void> {}

export interface PullerDeps {
  repo: RepoModule;
  url: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Defaults to opening captain's reports (captains-reports.ts) — never throws. */
  onResultStored?: (event: ResultStoredEvent) => Promise<void>;
  /** Defaults to voiding pending captain's reports / flagging submitted ones. */
  onResultCleared?: (event: ResultClearedEvent) => Promise<void>;
  /** Overrides for the default captain's-report hooks (tests inject a capturing sender). */
  captainsReports?: Omit<CaptainsReportDeps, 'repo'>;
  /** Defaults to `applyInboundSchedule` (Slice 3). A void return counts as recorded only. */
  onScheduleDiffers?: (event: ScheduleDiffersEvent) => Promise<ScheduleOutcome | void>;
  /** Overrides the conflict email of the default schedule handler (tests capture it). */
  notifyConflict?: import('./schedule.js').InboundScheduleDeps['notifyConflict'];
  log?: (line: string) => void;
}

export interface SyncRunSummary {
  tenant: string;
  status: 'ok' | 'dry-run' | 'disabled' | 'error';
  trigger: 'cron' | 'manual';
  pages: number;
  fixtures: number;
  counts: SyncLogEntry['counts'];
  cursorBefore: string | null;
  cursorAfter: string | null;
  error?: string;
  /** What a dry run would have requested (path + query; no host, no secret). */
  wouldRequest?: string;
}

export class MedicoachSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MedicoachSyncError';
  }
}

const zeroCounts = (): SyncLogEntry['counts'] => ({
  resultsStored: 0,
  resultsStale: 0,
  resultsCleared: 0,
  unmapped: 0,
  slotsFilled: 0,
  scheduleDiffers: 0,
  scheduleApplied: 0,
  scheduleStale: 0,
  scheduleConflicts: 0,
});

/** Where one ref lands in smart club. */
interface FixtureTarget {
  series: Series;
  fixture: StoredSeriesFixture;
}

interface StoredSeriesFixture {
  id: string;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  status?: string;
  dateTbc?: boolean;
  venueOverride?: string;
  venueName?: string;
  syncRef?: string;
  /** The placeholder a slot held before the sync filled it with a team (audit/restore). */
  slots?: { home?: string; away?: string };
}

/** ref → series/fixture, over every fixture's derived ref and explicit `syncRef`. */
export function buildRefIndex(tenant: string, all: Series[]): Map<string, FixtureTarget> {
  const index = new Map<string, FixtureTarget>();
  for (const series of all) {
    for (const fixture of (series.fixtures as StoredSeriesFixture[]) ?? []) {
      if (!fixture?.id) continue;
      index.set(`smartclub:${tenant}:fixture:${series.id}:${fixture.id}`, { series, fixture });
      const ref = fixtureSyncRef(tenant, String(series.id), fixture);
      if (ref) index.set(ref, { series, fixture });
    }
  }
  return index;
}

const venueKey = (v: string | null | undefined) =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

/** Which schedule fields of `change` differ from the smart club fixture (pure). */
export function scheduleDifferences(
  series: Series,
  fixture: StoredSeriesFixture,
  change: FixtureChange,
): string[] {
  const s = change.schedule;
  const fields: string[] = [];
  if (Boolean(s.dateTbc) !== Boolean(fixture.dateTbc)) fields.push('dateTbc');
  if (s.scheduledTime && !s.dateTbc) {
    const { date, time } = wallClock(s.scheduledTime);
    if (date !== fixture.date) fields.push('date');
    const theirs = s.timeTbc ? '' : time;
    if (theirs !== (fixture.time ?? '')) fields.push('time');
  }
  const homeVenue = series.participants?.find((p) => p.teamId === fixture.home)?.venue;
  const ours = fixture.venueOverride || fixture.venueName || homeVenue || null;
  if (s.venue !== null && venueKey(s.venue) !== venueKey(ours)) fields.push('venue');
  const ourStatus = fixture.status ?? 'scheduled';
  const theirStatus = s.cancelled ? 'cancelled' : s.postponed ? 'postponed' : null;
  if (
    theirStatus ? theirStatus !== ourStatus : ourStatus === 'cancelled' || ourStatus === 'postponed'
  )
    fields.push('status');
  return fields;
}

/** The stored item for a pulled result. */
function resultItem(
  seriesId: string,
  fixtureId: string,
  ref: string,
  r: SyncResult,
  now: string,
): StoredFixtureResult {
  return {
    seriesId,
    fixtureId,
    ref,
    orderAt: isoInstant(r.recordedAt),
    homeScore: r.homeScore,
    awayScore: r.awayScore,
    summary: r.summary,
    winner: r.winner,
    method: r.method,
    noResult: r.noResult,
    resultSource: r.source,
    recordedAt: isoInstant(r.recordedAt),
    scoringSide: r.scoringSide,
    // No captainRef: a player ref is never kept on the result (POPIA). It rides only on the
    // REPORTOPEN# marker while the reports are pending.
    medicoachMatchUrl: r.medicoachMatchUrl,
    storedAt: now,
  };
}

/**
 * Pull and apply every page of changes for one tenant. Never throws for a disabled tenant
 * or a dry run; throws `MedicoachSyncError` for an HTTP/contract failure AFTER recording it
 * in SYNCLOG (the cursor is not advanced past an unprocessed page).
 */
export async function runMedicoachSync(
  tenant: string,
  trigger: 'cron' | 'manual',
  deps: PullerDeps,
): Promise<SyncRunSummary> {
  const { repo } = deps;
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());
  const doFetch = deps.fetch ?? fetch;
  const resultHook =
    deps.onResultStored ?? captainsReportResultHook({ repo, now, ...(deps.captainsReports ?? {}) });
  const clearedHook =
    deps.onResultCleared ?? captainsReportClearedHook({ repo, ...(deps.captainsReports ?? {}) });
  const scheduleHook =
    deps.onScheduleDiffers ??
    ((e: ScheduleDiffersEvent) =>
      applyInboundSchedule(
        {
          tenant: e.tenant,
          seriesId: e.seriesId,
          fixtureId: e.fixtureId,
          ref: e.ref,
          schedule: e.change.schedule,
          fields: e.fields,
        },
        {
          repo,
          now,
          log,
          cache: pageCache,
          ...(deps.notifyConflict ? { notifyConflict: deps.notifyConflict } : {}),
        },
      ));

  const config = await repo.getTenantConfig(tenant);
  const counts = zeroCounts();
  const summary: SyncRunSummary = {
    tenant,
    status: 'ok',
    trigger,
    pages: 0,
    fixtures: 0,
    counts,
    cursorBefore: null,
    cursorAfter: null,
  };
  if (!config || !hasFeature(config, 'medicoachSync')) return { ...summary, status: 'disabled' };

  const cursorBefore = await repo.getSyncCursor(tenant);
  summary.cursorBefore = cursorBefore;
  summary.cursorAfter = cursorBefore;

  if (!deps.url || !deps.secret) {
    const pq = changesPathAndQuery(tenant, cursorBefore ?? undefined, PAGE_LIMIT);
    log(
      `[medicoach-sync dry-run] ${tenant}: would GET ${deps.url || '<MedicoachSyncUrl unset>'}${pq}` +
        `${deps.secret ? '' : ' (MedicoachSyncSecret unset)'} — no request made`,
    );
    return { ...summary, status: 'dry-run', wouldRequest: pq };
  }

  // Per-page reads (ADR 0016): the tenant's series list is read once per page and shared by
  // the ref index and every inbound apply; an apply patches the in-memory list with the
  // series it wrote, so a full resync (~800 fixtures) costs a handful of list reads, not one
  // per change. Only a slot fill (a separate write path) forces a re-list.
  let pageCache: InboundApplyCache = { config };
  let index: Map<string, FixtureTarget> | null = null;
  const loadIndex = async () =>
    (index ??= buildRefIndex(tenant, (pageCache.series ??= await repo.listSeries(tenant))));
  const scheduleRefs: string[] = [];
  const staleRefs: string[] = [];
  let cursor = cursorBefore;

  const record = async (outcome: 'ok' | 'error', error?: string) => {
    const notable =
      outcome === 'error' ||
      counts.resultsStored + counts.resultsCleared + counts.unmapped > 0 ||
      counts.slotsFilled + counts.scheduleDiffers > 0;
    // (scheduleApplied/Stale/Conflicts only ever move together with scheduleDiffers.)
    if (!notable) return;
    await repo.putSyncLog(tenant, {
      id: randomUUID(),
      at: now().toISOString(),
      trigger,
      outcome,
      pages: summary.pages,
      fixtures: summary.fixtures,
      counts,
      ...(scheduleRefs.length
        ? { scheduleDiffersRefs: scheduleRefs.slice(0, MAX_LOGGED_REFS) }
        : {}),
      ...(staleRefs.length ? { scheduleStaleRefs: staleRefs.slice(0, MAX_LOGGED_REFS) } : {}),
      ...(error ? { error } : {}),
    });
  };

  let moreToFetch = false;
  try {
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const pq = changesPathAndQuery(tenant, cursor ?? undefined, PAGE_LIMIT);
      let res: Response;
      try {
        res = await doFetch(`${deps.url}${pq}`, {
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
      const parsed = ChangesResponseSchema.safeParse(body);
      // Report the failing PATHS only: zod messages can echo values, and a value here may be
      // a player ref.
      if (!parsed.success)
        throw new MedicoachSyncError(
          `medicoach response failed the v1 contract at ${parsed.error.issues
            .slice(0, 3)
            .map((i) => i.path.join('.') || '(root)')
            .join(', ')}`,
        );
      const data = parsed.data;
      if (data.tenant !== tenant)
        throw new MedicoachSyncError('medicoach answered for a different tenant');
      summary.pages++;
      summary.fixtures += data.fixtures.length;
      // Fresh tenant-wide reads for every page (a page can follow minutes of admin edits).
      pageCache = { config };
      index = null;

      // Knockout slot fills, grouped per series so each series is written once per page.
      const slotFills = new Map<string, Map<string, { home?: string; away?: string }>>();
      const scheduleQueue: FixtureChange[] = [];
      for (const change of data.fixtures) {
        const parsedRef = parseFixtureRef(change.ref);
        const target =
          parsedRef && parsedRef.tenant === tenant
            ? (await loadIndex()).get(change.ref)
            : undefined;
        if (!target) {
          counts.unmapped++;
          continue;
        }
        const seriesId = String(target.series.id);
        const fixtureId = target.fixture.id;

        // ── Result ──
        if (change.result) {
          const prior = await repo.getFixtureResult(tenant, seriesId, fixtureId);
          // Only a result that can be newer gets a marker (a replay writes nothing extra).
          const mayStore =
            !prior || Date.parse(change.result.recordedAt) > Date.parse(prior.orderAt);
          if (mayStore)
            await repo.putReportOpenMarker(tenant, {
              ref: change.ref,
              seriesId,
              fixtureId,
              recordedAt: isoInstant(change.result.recordedAt),
              createdAt: now().toISOString(),
              attempts: 0,
              // The only place the player ref is kept, and only until the reports opened.
              ...(change.result.captainRef ? { captainRef: change.result.captainRef } : {}),
            });
          // A result stored before refs left the result item: scrub the old copy.
          if (prior && 'captainRef' in prior)
            await repo.removeFixtureResultCaptainRef(tenant, seriesId, fixtureId);
          const stored = await repo.putFixtureResultIfNewer(
            tenant,
            resultItem(seriesId, fixtureId, change.ref, change.result, now().toISOString()),
          );
          if (stored) {
            counts.resultsStored++;
            try {
              await resultHook({
                tenant,
                seriesId,
                fixtureId,
                ref: change.ref,
                result: change.result,
                first: !prior || prior.cleared === true,
                config,
              });
              await repo.deleteReportOpenMarker(tenant, change.ref);
            } catch (err) {
              // The result is stored; the marker keeps the report opening for the next run.
              // Never fails the sync run (ids only — no payload is logged).
              await repo.markReportOpenFailed(
                tenant,
                change.ref,
                err instanceof Error ? err.message : 'report hook failed',
                now().toISOString(),
              );
              log(
                `[medicoach-sync] ${tenant}: captain's reports for ${seriesId}/${fixtureId} will be retried`,
              );
            }
          } else {
            counts.resultsStale++;
            if (mayStore) await repo.deleteReportOpenMarker(tenant, change.ref);
          }
        } else if (change.resultClearedAt) {
          const cleared = await repo.putFixtureResultIfNewer(tenant, {
            seriesId,
            fixtureId,
            ref: change.ref,
            orderAt: isoInstant(change.resultClearedAt),
            cleared: true,
            clearedAt: isoInstant(change.resultClearedAt),
            storedAt: now().toISOString(),
          });
          if (cleared) {
            counts.resultsCleared++;
            await clearedHook({ tenant, seriesId, fixtureId, ref: change.ref });
          } else counts.resultsStale++;
        }

        // ── Knockout teams (medicoach-owned once resolved) ──
        const fill: { home?: string; away?: string } = {};
        for (const side of ['home', 'away'] as const) {
          const teamRef = side === 'home' ? change.teams.homeRef : change.teams.awayRef;
          const current = target.fixture[side];
          const placeholder = target.fixture.slots?.[side] ?? current;
          if (!teamRef || !placeholder || !isSlotRef(placeholder)) continue;
          const team = parseTeamRef(teamRef);
          if (
            !team ||
            team.tenant !== tenant ||
            team.leagueKey !== target.series.leagueKey ||
            !(target.series.teams ?? []).includes(team.teamId)
          )
            continue;
          if (current !== team.teamId) fill[side] = team.teamId;
        }
        if (fill.home || fill.away) {
          const perSeries = slotFills.get(seriesId) ?? new Map();
          perSeries.set(fixtureId, fill);
          slotFills.set(seriesId, perSeries);
        }

        scheduleQueue.push(change);
      }

      if (slotFills.size) {
        counts.slotsFilled += await applySlotFills(repo, tenant, slotFills);
        // The series changed; re-read before the next lookup.
        pageCache.series = undefined;
        index = null;
      }

      // ── Schedule: most-recent-wins → clash gate → apply or hold (Slice 3) ──
      // After the slot fills, so a knockout's ground (its home side's) is judged on the
      // teams medicoach just resolved, not on the placeholder.
      for (const change of scheduleQueue.splice(0)) {
        const target = (await loadIndex()).get(change.ref);
        if (!target) continue;
        const fields = scheduleDifferences(target.series, target.fixture, change);
        if (!fields.length) continue;
        counts.scheduleDiffers++;
        scheduleRefs.push(change.ref);
        const outcome = await scheduleHook({
          tenant,
          seriesId: String(target.series.id),
          fixtureId: target.fixture.id,
          ref: change.ref,
          change,
          fields,
        });
        if (outcome === 'applied') {
          counts.scheduleApplied!++;
          // The apply patched pageCache.series with what it wrote: rebuild the index from
          // memory (a custom hook that wrote elsewhere gets a fresh list).
          if (deps.onScheduleDiffers) pageCache.series = undefined;
          index = null;
        } else if (outcome === 'stale') {
          counts.scheduleStale!++;
          staleRefs.push(change.ref);
        } else if (outcome === 'conflict') counts.scheduleConflicts!++;
      }

      if (data.nextCursor !== cursor) {
        await repo.putSyncCursor(tenant, data.nextCursor);
        cursor = data.nextCursor;
      }
      moreToFetch = data.hasMore;
      if (!data.hasMore) break;
    }
    summary.cursorAfter = cursor;
    if (moreToFetch) {
      // The page cap stopped a run medicoach says isn't finished. A backlog drains over the
      // next runs; a medicoach that never stops answering hasMore would otherwise cost 50
      // requests every 15 minutes with nothing on the admin page, so it is always logged.
      summary.error = `stopped after ${MAX_PAGES_PER_RUN} pages with more still to fetch; the next run continues`;
      await record('error', summary.error);
      return summary;
    }
    await record('ok');
    return summary;
  } catch (err) {
    const message = err instanceof MedicoachSyncError ? err.message : 'internal error';
    summary.status = 'error';
    summary.error = message;
    summary.cursorAfter = cursor;
    // The audit row is best-effort here: losing it must not mask the original failure.
    await record('error', message).catch((logErr) =>
      console.error(`[medicoach-sync] ${tenant}: could not write the SYNCLOG error row`, logErr),
    );
    throw err;
  }
}

/**
 * Write knockout slot fills with a version-checked update (retried on a concurrent admin
 * edit). Only a side that still holds a placeholder — or one the sync filled before (its
 * original placeholder is kept in `slots`) — is replaced. Returns the sides filled.
 */
async function applySlotFills(
  repo: RepoModule,
  tenant: string,
  fills: Map<string, Map<string, { home?: string; away?: string }>>,
): Promise<number> {
  const { VersionConflictError } = repo;
  let filled = 0;
  for (const [seriesId, byFixture] of fills) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const series = await repo.getSeries(tenant, seriesId);
      if (!series) break;
      let n = 0;
      const fixtures = ((series.fixtures as StoredSeriesFixture[]) ?? []).map((f) => {
        const fill = f?.id ? byFixture.get(f.id) : undefined;
        if (!fill) return f;
        const next: StoredSeriesFixture = { ...f, slots: { ...(f.slots ?? {}) } };
        let changed = 0;
        for (const side of ['home', 'away'] as const) {
          const team = fill[side];
          const placeholder = f.slots?.[side] ?? f[side];
          if (!team || !placeholder || !isSlotRef(placeholder) || f[side] === team) continue;
          next.slots![side] = placeholder;
          next[side] = team;
          changed++;
        }
        n += changed;
        return changed ? next : f;
      });
      if (!n) break;
      try {
        await repo.updateSeries(tenant, seriesId, { fixtures, version: series.version });
        filled += n;
        break;
      } catch (err) {
        if (!(err instanceof VersionConflictError) || attempt === 2) throw err;
      }
    }
  }
  return filled;
}
