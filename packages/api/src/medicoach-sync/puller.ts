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
 *                   store calls `onResultStored` (a no-op until Slice 2.3 opens captain's
 *                   reports) — a replay never does.
 *   - teams       → a knockout slot (`pos:`/`win:` placeholder) takes the resolved team when
 *                   the team ref names one of that series' own team ids (version-checked).
 *   - schedule    → compared only; a difference is counted + listed in SYNCLOG and handed to
 *                   the pluggable `onScheduleDiffers` (Slice 3 applies it; today: record).
 *   - unknown ref → counted as "unmapped" (no ref values logged).
 *
 * Idempotent per fixture: re-applying the same page changes nothing, so a full resync
 * (no cursor) is always safe.
 *
 * Dry-run: with `MedicoachSyncUrl` or `MedicoachSyncSecret` empty the puller logs the
 * request it would make and stops — no HTTP, no writes.
 *
 * PII: a result's `captainRef` is a player ref (a hashed ID number). It is stored on the
 * result item for Slice 2.3 and NEVER logged — nothing here prints a fixture change, only
 * counts and fixture refs.
 */
import { randomUUID } from 'node:crypto';
import { isSlotRef } from '../../../engine/src/formats.js';
import { hasFeature } from '../features.js';
import { fixtureSyncRef } from '../fixture-identity.js';
import {
  ChangesResponseSchema,
  changesPathAndQuery,
  parseFixtureRef,
  parseTeamRef,
  signRequest,
  type FixtureChange,
  type SyncResult,
} from '../medicoach-sync-contract.js';
import { TENANT_UTC_OFFSET_MINUTES } from '../tenant-time.js';
import type { Series, StoredFixtureResult, SyncLogEntry, TenantConfig } from '../types.js';

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

/**
 * The post-result hook. Slice 2.3 replaces this with `openCaptainReports` (skipped for
 * `source: 'import'`, matches before `integrations.medicoach.goLiveDate`, and old matches).
 * Called ONLY when a result is newly stored — never for a replay or a stale change.
 */
export async function onResultStored(_event: ResultStoredEvent): Promise<void> {
  // Intentionally a no-op until captain's reports exist (Slice 2.3).
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

/**
 * The schedule handler slot. Slice 3 plugs in "most-recent-wins → clash gate → apply or
 * SYNCCONFLICT#". Today schedule changes are only recorded (SYNCLOG), never applied.
 */
export async function recordScheduleDiffers(_event: ScheduleDiffersEvent): Promise<void> {}

export interface PullerDeps {
  repo: RepoModule;
  url: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => Date;
  onResultStored?: (event: ResultStoredEvent) => Promise<void>;
  onScheduleDiffers?: (event: ScheduleDiffersEvent) => Promise<void>;
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

/** A medicoach instant → the tenant's wall-clock date + HH:MM (SAST, no DST). */
export function wallClock(iso: string): { date: string; time: string } {
  const local = new Date(Date.parse(iso) + TENANT_UTC_OFFSET_MINUTES * 60_000);
  const s = local.toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
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
    orderAt: r.recordedAt,
    homeScore: r.homeScore,
    awayScore: r.awayScore,
    summary: r.summary,
    winner: r.winner,
    method: r.method,
    noResult: r.noResult,
    resultSource: r.source,
    recordedAt: r.recordedAt,
    scoringSide: r.scoringSide,
    captainRef: r.captainRef,
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
  const resultHook = deps.onResultStored ?? onResultStored;
  const scheduleHook = deps.onScheduleDiffers ?? recordScheduleDiffers;

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

  let index: Map<string, FixtureTarget> | null = null;
  const loadIndex = async () => (index ??= buildRefIndex(tenant, await repo.listSeries(tenant)));
  const scheduleRefs: string[] = [];
  let cursor = cursorBefore;

  const record = async (outcome: 'ok' | 'error', error?: string) => {
    const notable =
      outcome === 'error' ||
      counts.resultsStored + counts.resultsCleared + counts.unmapped > 0 ||
      counts.slotsFilled + counts.scheduleDiffers > 0;
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
      ...(error ? { error } : {}),
    });
  };

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

      // Knockout slot fills, grouped per series so each series is written once per page.
      const slotFills = new Map<string, Map<string, { home?: string; away?: string }>>();
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
          const stored = await repo.putFixtureResultIfNewer(
            tenant,
            resultItem(seriesId, fixtureId, change.ref, change.result, now().toISOString()),
          );
          if (stored) {
            counts.resultsStored++;
            await resultHook({
              tenant,
              seriesId,
              fixtureId,
              ref: change.ref,
              result: change.result,
              first: !prior || prior.cleared === true,
              config,
            });
          } else counts.resultsStale++;
        } else if (change.resultClearedAt) {
          const cleared = await repo.putFixtureResultIfNewer(tenant, {
            seriesId,
            fixtureId,
            ref: change.ref,
            orderAt: change.resultClearedAt,
            cleared: true,
            clearedAt: change.resultClearedAt,
            storedAt: now().toISOString(),
          });
          if (cleared) counts.resultsCleared++;
          else counts.resultsStale++;
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

        // ── Schedule: compare + record only (Slice 3 applies) ──
        const fields = scheduleDifferences(target.series, target.fixture, change);
        if (fields.length) {
          counts.scheduleDiffers++;
          scheduleRefs.push(change.ref);
          await scheduleHook({ tenant, seriesId, fixtureId, ref: change.ref, change, fields });
        }
      }

      if (slotFills.size) {
        counts.slotsFilled += await applySlotFills(repo, tenant, slotFills);
        index = null; // the series changed; re-read before the next page
      }

      if (data.nextCursor !== cursor) {
        await repo.putSyncCursor(tenant, data.nextCursor);
        cursor = data.nextCursor;
      }
      if (!data.hasMore) break;
    }
    summary.cursorAfter = cursor;
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
