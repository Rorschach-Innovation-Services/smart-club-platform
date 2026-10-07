/**
 * Medicoach ↔ smart club SCHEDULE sync (ADR 0016, Slices 3 and 4).
 *
 * Schedule = date, time, venue, postponed, cancelled (+ the `dateTbc` placeholder flag). Both
 * sides edit it; the most recent change wins, ordered by each side's `changedAt`. Smart club
 * keeps its own on the fixture as `schedule.changedAt` (a sync-owned field every rewrite
 * carries over, see fixture-identity.ts).
 *
 * Inbound (Slice 3, `applyInboundSchedule`): the puller hands every pulled fixture whose
 * schedule differs. When medicoach's `changedAt` is newer the change is applied through the
 * same gates an admin edit of the series passes — the in-season subset clash gate on a
 * released series (`introducedClashes`, shared with PATCH /series), the approval recall on a
 * draft — with a version-checked write retried up to 3 times. Release/withheld state is never
 * touched. A venue that does not resolve against the tenant's ground list, or a change the
 * clash gate refuses, is NOT applied: it is held as `SYNCCONFLICT#<ref>` (latest proposal per
 * ref) and the tenant's admins get one email per proposal. There is no override flag.
 *
 * Outbound (Slice 4, `recordScheduleDiff` + `flushScheduleOutbox`): every smart-club write
 * that changes a mapped fixture's schedule (admin PATCH, stage generate, the series CLIs)
 * stamps `schedule.changedAt = now` on the fixture and, once the series write succeeded,
 * collapses the latest snapshot onto `PENDINGSYNC#<ref>`. The 15-minute cron (and "Sync now")
 * flushes the outbox in batches of ≤100 to `POST /integrations/smartclub/schedule` before it
 * pulls. `applied|stale|unchanged|unmapped` delete the row; `error` or a failed request keep
 * it with an attempt count. A `stale` answer means medicoach holds a newer edit — the pull
 * brings it back. The inbound apply (origin `medicoach`) never enqueues, so nothing echoes.
 *
 * Drafts and withheld venue/time (ADR 0011): medicoach's match centre is public and the v1
 * contract carries no draft or withheld flags, so a fixture of a series that is not released
 * (a draft, or recalled) or currently withholds venue and/or time is never pushed. Its row is
 * kept as `heldUntilReveal` (flagged at enqueue, and re-checked against the live series on
 * every flush), and the release (nothing withheld) or the reveal that clears the last
 * withheld field re-queues every fixture of the series with its real schedule and its
 * existing `changedAt` — never re-stamped, so a medicoach edit made meanwhile still wins
 * (`requeueRevealedSeries`). A row whose series was deleted is dropped, never pushed.
 * Inbound changes still apply to a withheld series — they leak nothing. The initial
 * migration bundle carries its own `venueWithheld`/`timeWithheld`.
 */
import { randomUUID } from 'node:crypto';
import { isSlotRef, slotSource, tbdLabel } from '../../../engine/src/formats.js';
import { fixtureSyncRef } from '../fixture-identity.js';
import {
  capVenue,
  isoInstant,
  MEDICOACH_SYNC_VERSION,
  SCHEDULE_PATH,
  SCHEDULE_PUSH_MAX,
  SchedulePushResponseSchema,
  SyncScheduleSchema,
  signRequest,
  type SyncSchedule,
} from '../medicoach-sync-contract.js';
import { TENANT_UTC_OFFSET_MINUTES } from '../tenant-time.js';
import {
  formatClashForHumans,
  groundKey,
  introducedClashes,
  venueAliasesFor,
} from '../venue-clash.js';
import { explainSyncError } from './explain.js';
import { seriesIsSyncMapped } from './series-results.js';
import type {
  Club,
  PendingScheduleSync,
  ScheduleChangeOrigin,
  SchedulePushCounts,
  Series,
  SyncConflict,
  SyncScheduleSnapshot,
  TenantConfig,
  Venue,
} from '../types.js';

type RepoModule = typeof import('../repo.js');

/**
 * An outbox row that failed this many pushes in a row is shown as "stuck" on the admin page
 * (with Retry and Drop). It is still retried by every run — never silently given up on.
 */
export const STUCK_ATTEMPTS = 5;

/** Inbound apply attempts on a version conflict (a concurrent admin edit). */
const APPLY_ATTEMPTS = 3;
const HTTP_TIMEOUT_MS = 10_000;

/** The schedule-relevant slice of a stored series fixture; everything else rides along. */
export interface ScheduleFixture {
  id?: string;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  status?: string;
  dateTbc?: boolean;
  /** The date a rescheduled postponement left (ADR 0015); absent on an undated one. */
  originalDate?: string;
  venueId?: string;
  venueName?: string;
  venueOverride?: string;
  venueLat?: number;
  venueLon?: number;
  venueLocked?: boolean;
  syncRef?: string;
  schedule?: { changedAt?: string };
  [key: string]: unknown;
}

/* ─────────────────────────── Time + venue mapping ─────────────────────────── */

/** "+02:00" for the tenant's fixed wall-clock offset (SAST, no DST). */
const OFFSET = (() => {
  const m = TENANT_UTC_OFFSET_MINUTES;
  const a = Math.abs(m);
  return `${m >= 0 ? '+' : '-'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
})();

/** A medicoach instant → the tenant's wall-clock date + HH:MM (Africa/Johannesburg). */
export function wallClock(iso: string): { date: string; time: string } {
  const local = new Date(Date.parse(iso) + TENANT_UTC_OFFSET_MINUTES * 60_000);
  const s = local.toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}

/** A fixture's ground as clubs see it: explicit venue, else the home side's ground. */
export function effectiveVenue(series: Series, f: ScheduleFixture): string | null {
  const homeVenue = series.participants?.find((p) => p.teamId === f.home)?.venue;
  return f.venueOverride || f.venueName || homeVenue || null;
}

const statusFlag = (status: string | undefined) =>
  status === 'cancelled' || status === 'postponed' ? status : '';

/** The fields whose change is a schedule change (and nothing else is). */
function scheduleKey(series: Series, f: ScheduleFixture): string {
  return JSON.stringify([
    f.date ?? '',
    f.time ?? '',
    f.dateTbc === true,
    statusFlag(f.status),
    (effectiveVenue(series, f) ?? '').trim().toLowerCase().replace(/\s+/g, ' '),
  ]);
}

/** A smart-club fixture's schedule in the wire shape (contract v1 `SyncSchedule`). */
export function fixtureSchedule(
  series: Series,
  f: ScheduleFixture,
  changedAt: string,
): SyncScheduleSnapshot {
  const time = typeof f.time === 'string' && /^\d{2}:\d{2}$/.test(f.time) ? f.time : '';
  return {
    scheduledTime: f.date ? `${f.date}T${time || '00:00'}:00${OFFSET}` : null,
    timeTbc: !time,
    dateTbc: f.dateTbc === true || !f.date,
    // Contract v1: at most 200 characters — a sender never exceeds it.
    venue: capVenue(effectiveVenue(series, f)),
    postponed: f.status === 'postponed',
    cancelled: f.status === 'cancelled',
    changedAt,
  };
}

/** True when a side is a placeholder the medicoach export can't carry: a `pos:` group position
 * or a `tbd:` label (not a `win:`/`lose:` fixture link). Such a fixture is skipped by the
 * export (`unresolved-side`), so medicoach never had it. */
export function neverExported(f: Pick<ScheduleFixture, 'home' | 'away'>): boolean {
  return [f.home, f.away].some(
    (side) => typeof side === 'string' && isSlotRef(side) && !slotSource(side),
  );
}

/** Same match before and after an edit: the same unordered pair, or a knockout slot filled. */
export function sameMatch(a: ScheduleFixture, b: ScheduleFixture): boolean {
  const pair = (f: ScheduleFixture) =>
    [String(f.home ?? ''), String(f.away ?? '')].sort().join('|');
  if (pair(a) === pair(b)) return true;
  return [a.home, a.away].some((side) => typeof side === 'string' && isSlotRef(side));
}

/**
 * Editing a DRAFT series' fixtures recalls its approval (it must be re-approved before
 * release); a released series keeps its state so in-season edits still reach clubs. The one
 * rule PATCH /series and the medicoach apply both follow.
 */
export function fixturesEditRecallsApproval(current: Pick<Series, 'released'>): boolean {
  return !current.released;
}

/* ─────────────────────────── Outbound: diff + outbox ─────────────────────────── */

/**
 * True while the series hides venue and/or time from clubs (ADR 0011). Its fixtures'
 * schedules must not reach medicoach's public match centre until it is fully revealed.
 */
export function seriesWithholdsSchedule(series: Pick<Series, 'withheld'> | null | undefined) {
  return series?.withheld?.venue === true || series?.withheld?.time === true;
}

/**
 * True while a series' schedule must not reach medicoach's public match centre: it is a
 * draft (never released, or recalled) or it withholds venue and/or time (ADR 0011). Its
 * outbox rows are kept as `heldUntilReveal` until the release (nothing withheld) or the
 * reveal of the last withheld field re-queues the series (`requeueRevealedSeries`).
 */
export function seriesHoldsSchedule(
  series: Pick<Series, 'withheld' | 'released'> | null | undefined,
): boolean {
  return !series || !series.released || seriesWithholdsSchedule(series);
}

/**
 * `seriesIsSyncMapped` with the league resolved the way the medicoach exporter resolves it:
 * a season-run series carries no `leagueKey` of its own, so its run's league decides.
 */
export async function seriesMappedForSync(
  repo: Pick<RepoModule, 'getSeasonRun'>,
  tenant: string,
  series: Series,
  config: TenantConfig | null | undefined,
): Promise<boolean> {
  if (typeof series.leagueKey === 'string' && series.leagueKey)
    return seriesIsSyncMapped(tenant, series, config);
  const runId = (series as { seasonRunId?: string }).seasonRunId;
  if (!runId || !seriesIsSyncMapped(tenant, { id: series.id, leagueKey: 'x' }, config))
    return seriesIsSyncMapped(tenant, series, config);
  const run = await repo.getSeasonRun(tenant, runId);
  return seriesIsSyncMapped(tenant, { ...series, leagueKey: run?.leagueKey }, config);
}

export interface ScheduleDiffHandle {
  /** Refs whose schedule this write changes (already stamped on `after.fixtures`). */
  refs: string[];
  /**
   * Refs of fixtures this write ADDS to a mapped series. Medicoach has no such match and the
   * v1 contract cannot create one, so they are never pushed — `enqueue()` reports them (log +
   * SYNCLOG) as needing a bundle top-up instead of ignoring them silently.
   */
  newRefs: string[];
  /** Write the PENDINGSYNC# rows — call only AFTER the series write succeeded. */
  enqueue(): Promise<number>;
}

const NO_DIFF: ScheduleDiffHandle = { refs: [], newRefs: [], enqueue: async () => 0 };

/** The CLI/log line for fixtures medicoach does not have (no create in contract v1). */
export function newFixturesNotice(tenant: string, seriesId: string, refs: string[]): string {
  return (
    `[medicoach-sync] ${tenant}: ${refs.length} new fixture(s) in ${seriesId} not in medicoach ` +
    `(needs bundle top-up): ${refs.join(', ')}`
  );
}

/**
 * The one helper every smart-club series write calls (Slice 4). Compares `before` and
 * `after` fixture by fixture (same id, same match); for each whose schedule changed it
 * REPLACES the fixture in `after.fixtures` with a copy stamped `schedule.changedAt = now`,
 * and returns a handle whose `enqueue()` writes the outbox rows once the caller's series
 * write has succeeded (an outbox row for a write that then failed would push a schedule that
 * never happened).
 *
 * A no-op for origin `medicoach` (the inbound apply — nothing echoes), for a tenant without
 * `features.medicoachSync` and for a series medicoach does not own (`seriesIsSyncMapped`).
 * Fixtures that are new (no stored counterpart, or a brand-new series) are never pushed —
 * medicoach cannot create a match — but are reported by `enqueue()` as "new fixture not in
 * medicoach (needs bundle top-up)"; a fixture whose id now names a different match is skipped
 * (its ref no longer means what medicoach has).
 */
export async function recordScheduleDiff(
  repo: Pick<RepoModule, 'getTenantConfig' | 'putPendingSync' | 'getSeasonRun' | 'putSyncLog'>,
  tenant: string,
  before: Series | null | undefined,
  after: Series,
  origin: ScheduleChangeOrigin,
  opts: { config?: TenantConfig | null; now?: () => Date; log?: (line: string) => void } = {},
): Promise<ScheduleDiffHandle> {
  if (origin === 'medicoach' || !Array.isArray(after.fixtures)) return NO_DIFF;
  const config = opts.config !== undefined ? opts.config : await repo.getTenantConfig(tenant);
  if (!(await seriesMappedForSync(repo, tenant, after, config))) return NO_DIFF;
  const nowIso = (opts.now?.() ?? new Date()).toISOString();
  const held = seriesHoldsSchedule(after);
  const prior = new Map<string, ScheduleFixture>();
  for (const f of (before?.fixtures as ScheduleFixture[] | undefined) ?? [])
    if (f?.id) prior.set(f.id, f);

  const rows: PendingScheduleSync[] = [];
  const newRefs: string[] = [];
  after.fixtures = (after.fixtures as ScheduleFixture[]).map((f) => {
    const old = f?.id ? prior.get(f.id) : undefined;
    if (!old) {
      if (f?.id) newRefs.push(fixtureSyncRef(tenant, String(after.id), f));
      return f;
    }
    // A fixture with a `pos:`/`tbd:` side was never exported (ADR 0018: no team, no fixture to
    // wait on), so medicoach has no match to update. Once Set team leaves it with no such side
    // it needs a bundle top-up — reported like a new fixture, never pushed (a push would come
    // back `unmapped` and vanish). Still unresolved: nothing to push either.
    if (neverExported(old)) {
      if (!neverExported(f) && f.id) newRefs.push(fixtureSyncRef(tenant, String(after.id), f));
      return f;
    }
    // Reverted to a `pos:`/`tbd:` placeholder: the contract can't carry it, so nothing is pushed.
    if (neverExported(f)) return f;
    if (!before || !sameMatch(old, f)) return f;
    if (scheduleKey(before, old) === scheduleKey(after, f)) return f;
    const next: ScheduleFixture = { ...f, schedule: { ...(f.schedule ?? {}), changedAt: nowIso } };
    rows.push({
      ref: fixtureSyncRef(tenant, String(after.id), next),
      seriesId: String(after.id),
      fixtureId: String(f.id),
      schedule: fixtureSchedule(after, next, nowIso),
      origin,
      enqueuedAt: nowIso,
      attempts: 0,
      ...(held ? { heldUntilReveal: true } : {}),
    });
    return next;
  });
  if (!rows.length && !newRefs.length) return NO_DIFF;
  const log = opts.log ?? ((line: string) => console.log(line));
  return {
    refs: rows.map((r) => r.ref),
    newRefs,
    enqueue: async () => {
      for (const r of rows) await repo.putPendingSync(tenant, r);
      if (newRefs.length) {
        log(newFixturesNotice(tenant, String(after.id), newRefs));
        await repo.putSyncLog(tenant, {
          id: randomUUID(),
          at: nowIso,
          trigger: origin === 'cli' ? 'cli' : 'write',
          kind: 'new-fixtures',
          outcome: 'ok',
          pages: 0,
          fixtures: newRefs.length,
          counts: {
            resultsStored: 0,
            resultsStale: 0,
            resultsCleared: 0,
            unmapped: 0,
            slotsFilled: 0,
            scheduleDiffers: 0,
          },
          newFixtureRefs: newRefs,
        });
      }
      return rows.length;
    },
  };
}

/**
 * The `changedAt` a fixture smart club never edited since import carries on the wire: one
 * millisecond after medicoach's never-edited epoch (`1970-01-01T00:00:00.000Z`), so smart
 * club's real values (a newly revealed venue, say) still win over a never-edited medicoach
 * row, while any real medicoach edit wins over them.
 */
export const NEVER_EDITED_CHANGED_AT = '1970-01-01T00:00:00.001Z';

/**
 * Inbound counterpart: a smart-club fixture with no `schedule.changedAt` (never edited since
 * import) counts as medicoach's epoch, so a never-edited medicoach row is never newer than it
 * and any real medicoach edit is.
 */
export const EPOCH_CHANGED_AT = '1970-01-01T00:00:00.000Z';

/**
 * The write that makes a series' real schedule public — the release (false→true) of a series
 * withholding nothing, or the reveal that clears its LAST withheld field (ADR 0011) — means
 * medicoach must now get it: `enqueue()` (called once that write landed) queues every fixture
 * of a sync-mapped series with its real schedule and its EXISTING `schedule.changedAt` —
 * never re-stamped, so a medicoach edit made while the series was a draft or withheld still
 * wins ("most recent change wins") — or `NEVER_EDITED_CHANGED_AT` when smart club never
 * edited it. A row already held for the fixture carries the same or a newer `changedAt`, so
 * the conditional `putPendingSync` keeps it (the flush un-holds it against the live series).
 * Queues nothing for a series that still holds its schedule (`seriesHoldsSchedule`: draft or
 * withholding a field), an unmapped series or a tenant without the sync.
 */
export async function requeueRevealedSeries(
  repo: Pick<RepoModule, 'getTenantConfig' | 'putPendingSync' | 'getSeasonRun'>,
  tenant: string,
  revealed: Series,
  opts: { config?: TenantConfig | null; now?: () => Date } = {},
): Promise<{ enqueue(): Promise<number> }> {
  const none = { enqueue: async () => 0 };
  if (seriesHoldsSchedule(revealed) || !Array.isArray(revealed.fixtures)) return none;
  const config = opts.config !== undefined ? opts.config : await repo.getTenantConfig(tenant);
  if (!(await seriesMappedForSync(repo, tenant, revealed, config))) return none;
  const nowIso = (opts.now?.() ?? new Date()).toISOString();
  const rows: PendingScheduleSync[] = [];
  for (const f of revealed.fixtures as ScheduleFixture[]) {
    if (!f?.id) continue;
    const changedAt = f.schedule?.changedAt || NEVER_EDITED_CHANGED_AT;
    rows.push({
      ref: fixtureSyncRef(tenant, String(revealed.id), f),
      seriesId: String(revealed.id),
      fixtureId: String(f.id),
      schedule: fixtureSchedule(revealed, f, changedAt),
      origin: 'admin',
      enqueuedAt: nowIso,
      attempts: 0,
    });
  }
  if (!rows.length) return none;
  return {
    enqueue: async () => {
      for (const r of rows) await repo.putPendingSync(tenant, r);
      return rows.length;
    },
  };
}

export interface FlushDeps {
  repo: RepoModule;
  url: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface FlushSummary {
  status: 'empty' | 'ok' | 'dry-run';
  pending: number;
  /** Rows not sent because their series still withholds venue/time (ADR 0011). */
  held: number;
  counts: SchedulePushCounts;
}

const zeroPush = (): SchedulePushCounts => ({
  sent: 0,
  applied: 0,
  stale: 0,
  unchanged: 0,
  unmapped: 0,
  errors: 0,
});

/**
 * Push the tenant's outbox to medicoach (Slice 4). Never throws for a medicoach failure: a
 * failed batch keeps its rows (attempts + 1, lastError) for the next run, and the pull still
 * runs. Dry run (URL or secret empty): logs what it would send, sends nothing.
 */
export async function flushScheduleOutbox(
  tenant: string,
  trigger: 'cron' | 'manual',
  deps: FlushDeps,
): Promise<FlushSummary> {
  const { repo } = deps;
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());
  const doFetch = deps.fetch ?? fetch;
  const counts = zeroPush();
  const all = (await repo.listPendingSync(tenant)).sort((a, b) =>
    a.enqueuedAt.localeCompare(b.enqueuedAt),
  );
  if (!all.length) return { status: 'empty', pending: 0, held: 0, counts };

  // A draft (never released, or recalled) or withheld venue/time never leaves smart club
  // (ADR 0011): decided against the series as it stands NOW, not the flag the row was
  // enqueued with, so a recall or a release-with-withheld after the enqueue still holds it and
  // a release/reveal by any path releases it. A row whose series no longer exists is dropped:
  // there is nothing left to say about it, and pushing it would leak a deleted draft.
  const live = new Map<string, Series | null>();
  const rows: PendingScheduleSync[] = [];
  let held = 0;
  let dropped = 0;
  for (const row of all) {
    if (!live.has(row.seriesId)) live.set(row.seriesId, await repo.getSeries(tenant, row.seriesId));
    const series = live.get(row.seriesId)!;
    if (!series) {
      await repo.deletePendingSyncIfUnchanged(tenant, row.ref, row.schedule.changedAt);
      dropped++;
      continue;
    }
    const hold = seriesHoldsSchedule(series);
    if (hold) held++;
    else rows.push(row);
    if (hold !== (row.heldUntilReveal === true))
      await repo.setPendingSyncHeld(tenant, row.ref, row.schedule.changedAt, hold);
  }
  if (dropped)
    log(`[medicoach-sync] ${tenant}: dropped ${dropped} outbox row(s) of deleted series`);
  if (!rows.length) return { status: 'empty', pending: all.length - dropped, held, counts };
  if (!deps.url || !deps.secret) {
    log(
      `[medicoach-sync dry-run] ${tenant}: would POST ${rows.length} schedule change(s) to ` +
        `${deps.url || '<MedicoachSyncUrl unset>'}${SCHEDULE_PATH}` +
        `${deps.secret ? '' : ' (MedicoachSyncSecret unset)'} — no request made`,
    );
    return { status: 'dry-run', pending: all.length - dropped, held, counts };
  }

  const failRow = async (row: PendingScheduleSync, error: string) => {
    counts.errors++;
    await repo.markPendingSyncFailed(
      tenant,
      row.ref,
      row.schedule.changedAt,
      error,
      now().toISOString(),
    );
  };

  // A row whose snapshot no longer fits the contract can never be sent; keep it visible.
  const sendable: PendingScheduleSync[] = [];
  for (const row of rows) {
    if (SyncScheduleSchema.safeParse(row.schedule).success) sendable.push(row);
    else await failRow(row, 'the stored schedule does not fit the v1 contract');
  }

  /** The first whole-request failure of this flush (unreachable, HTTP, contract), if any. */
  let requestError: string | undefined;
  for (let i = 0; i < sendable.length; i += SCHEDULE_PUSH_MAX) {
    const batch = sendable.slice(i, i + SCHEDULE_PUSH_MAX);
    const body = JSON.stringify({
      version: MEDICOACH_SYNC_VERSION,
      tenant,
      // Rows queued before the venue cap still go out within it.
      changes: batch.map((r) => ({
        ref: r.ref,
        schedule: { ...r.schedule, venue: capVenue(r.schedule.venue) },
      })),
    });
    counts.sent += batch.length;
    let results: Map<string, { status: string; message?: string }>;
    try {
      let res: Response;
      try {
        res = await doFetch(`${deps.url}${SCHEDULE_PATH}`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            ...signRequest({
              secret: deps.secret,
              method: 'POST',
              pathAndQuery: SCHEDULE_PATH,
              body,
            }),
          },
          body,
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
      } catch (err) {
        throw new Error(
          `medicoach unreachable: ${err instanceof Error ? err.name : 'request failed'}`,
        );
      }
      if (!res.ok) throw new Error(`medicoach answered HTTP ${res.status}`);
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        throw new Error('medicoach answered with a body that is not JSON');
      }
      const ok = SchedulePushResponseSchema.safeParse(parsed);
      if (!ok.success) throw new Error('medicoach response failed the v1 contract');
      results = new Map(ok.data.results.map((r) => [r.ref, r]));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'push failed';
      log(`[medicoach-sync] ${tenant}: schedule push failed — ${message}`);
      requestError ??= message;
      for (const row of batch) await failRow(row, message);
      continue;
    }
    for (const row of batch) {
      const r = results.get(row.ref);
      if (!r) await failRow(row, 'medicoach returned no result for this fixture');
      else if (r.status === 'error') await failRow(row, r.message || 'medicoach reported an error');
      else {
        counts[r.status as 'applied' | 'stale' | 'unchanged' | 'unmapped']++;
        await repo.deletePendingSyncIfUnchanged(tenant, row.ref, row.schedule.changedAt);
      }
    }
  }

  if (counts.sent || counts.errors)
    await repo.putSyncLog(tenant, {
      id: randomUUID(),
      at: now().toISOString(),
      trigger,
      kind: 'push',
      outcome: counts.errors ? 'error' : 'ok',
      pages: 0,
      fixtures: counts.sent,
      counts: {
        resultsStored: 0,
        resultsStale: 0,
        resultsCleared: 0,
        unmapped: 0,
        slotsFilled: 0,
        scheduleDiffers: 0,
      },
      push: counts,
      ...(requestError ? { error: requestError, message: explainSyncError(requestError) } : {}),
    });
  return { status: 'ok', pending: all.length - dropped, held, counts };
}

/* ─────────────────────────── Inbound: apply or hold ─────────────────────────── */

export type InboundBuild =
  | { ok: true; fixture: ScheduleFixture; changed: string[] }
  | { ok: false; reason: 'venue-unresolved'; detail: string[] };

/**
 * The fixture as it becomes under `schedule` (pure). dateTbc → the placeholder flag (the
 * stored date is kept as the placeholder); scheduledTime → date/time in Africa/Johannesburg;
 * timeTbc → no time; postponed/cancelled → status (neither ⇒ a postponed/cancelled fixture
 * returns to scheduled); venue → the tenant ground it resolves to by normalised name, else
 * `venue-unresolved`. A venue that names the ground the fixture already plays at is no
 * change. `schedule.changedAt` is NOT set here.
 */
export function buildInboundFixture(
  series: Series,
  fixture: ScheduleFixture,
  schedule: Pick<
    SyncSchedule,
    'scheduledTime' | 'timeTbc' | 'dateTbc' | 'venue' | 'postponed' | 'cancelled'
  >,
  venues: Venue[],
  aliases: Record<string, string>,
): InboundBuild {
  const next: ScheduleFixture = { ...fixture };
  const changed: string[] = [];
  if (schedule.dateTbc) {
    if (!fixture.dateTbc) {
      next.dateTbc = true;
      changed.push('dateTbc');
    }
  } else {
    if (fixture.dateTbc) {
      delete next.dateTbc;
      changed.push('dateTbc');
    }
    if (schedule.scheduledTime) {
      const { date, time } = wallClock(schedule.scheduledTime);
      if (date !== fixture.date) {
        next.date = date;
        changed.push('date');
      }
      const t = schedule.timeTbc ? '' : time;
      if (t !== (fixture.time ?? '')) {
        if (t) next.time = t;
        else delete next.time;
        changed.push('time');
      }
    }
  }
  const theirs = schedule.cancelled ? 'cancelled' : schedule.postponed ? 'postponed' : '';
  const ours = fixture.status ?? 'scheduled';
  if (theirs && theirs !== ours) {
    next.status = theirs;
    changed.push('status');
  } else if (!theirs && statusFlag(ours)) {
    next.status = 'scheduled';
    changed.push('status');
  }
  // A postponement that lands on a new date is a RESCHEDULED one: stamp the date being left
  // (only if absent — ADR 0015 `postponedFixture` semantics). An undated postponement's
  // `dateTbc` needs no handling here: it mirrors `schedule.dateTbc` above, so a dated change
  // already clears it. A fixture that LEAVES postponed drops `originalDate`, so a stale one
  // never resurfaces on a later postponement.
  if (statusFlag(ours) === 'postponed' && next.status !== 'postponed' && next.originalDate)
    delete next.originalDate;
  if (
    next.status === 'postponed' &&
    !next.originalDate &&
    fixture.date &&
    next.date &&
    next.date !== fixture.date
  )
    next.originalDate = fixture.date;
  // Truncated to the contract's 200-character cap before it is resolved, on both sides of
  // the comparison (a ground named longer than that is what medicoach holds of it).
  const wanted = capVenue(schedule.venue)?.trim();
  if (wanted) {
    const current = capVenue(effectiveVenue(series, fixture));
    const key = groundKey(wanted, aliases);
    if (!current || groundKey(current, aliases) !== key) {
      const venue = venues.find((v) => groundKey(capVenue(v.name), aliases) === key);
      if (!venue)
        return {
          ok: false,
          reason: 'venue-unresolved',
          detail: [`"${wanted}" does not match any ground in the venue list`],
        };
      // Same shape as the importers' registry match (import-planb setVenue).
      next.venueId = venue.id;
      next.venueName = venue.name;
      next.venueLat = Number.isFinite(venue.lat) ? venue.lat : undefined;
      next.venueLon = Number.isFinite(venue.lon) ? venue.lon : undefined;
      next.venueOverride = undefined;
      next.venueLocked = true;
      changed.push('venue');
    }
  }
  return { ok: true, fixture: next, changed };
}

export type ScheduleOutcome = 'applied' | 'stale' | 'conflict' | 'unchanged' | 'missing';

export interface InboundScheduleInput {
  tenant: string;
  seriesId: string;
  fixtureId: string;
  ref: string;
  schedule: SyncSchedule;
  fields: string[];
}

/**
 * Tenant-wide reads an inbound apply needs, loaded at most once per puller page and shared by
 * every apply in it (a full resync can apply hundreds). `series` is patched in place with
 * each written series, so later applies' clash gates see earlier ones without a re-list.
 */
export interface InboundApplyCache {
  config?: TenantConfig | null;
  venues?: Venue[];
  series?: Series[];
  clubs?: Club[];
}

export interface InboundScheduleDeps {
  repo: RepoModule;
  /** Shared per-page reads (see InboundApplyCache); absent ⇒ a private one per call. */
  cache?: InboundApplyCache;
  now?: () => Date;
  /** Emails the tenant's admins about a newly held conflict. Defaults to SES (dry-run offline). */
  notifyConflict?: (
    tenant: string,
    conflict: SyncConflict,
    config: TenantConfig | null,
  ) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Slice 3: apply one pulled schedule change, or hold it. Most-recent-wins first (a change no
 * newer than the fixture's `schedule.changedAt` is `stale`), then the venue, then — on a
 * released series — the in-season clash gate. The write is version-checked and retried up to
 * 3 times against a concurrent admin edit; a clean apply supersedes any conflict held for
 * the ref. Throws only for a repo failure or a fourth version conflict (the puller then
 * leaves the cursor where it was, so the change is retried).
 */
export async function applyInboundSchedule(
  input: InboundScheduleInput,
  deps: InboundScheduleDeps,
): Promise<ScheduleOutcome> {
  const { repo } = deps;
  const { tenant, seriesId, fixtureId, ref, schedule } = input;
  const { VersionConflictError } = repo;
  const cache: InboundApplyCache = deps.cache ?? {};
  for (let attempt = 0; attempt < APPLY_ATTEMPTS; attempt++) {
    const series = await repo.getSeries(tenant, seriesId);
    const fixtures = (series?.fixtures as ScheduleFixture[] | undefined) ?? [];
    const i = fixtures.findIndex((f) => f?.id === fixtureId);
    if (!series || i < 0) return 'missing';
    const fixture = fixtures[i];
    // Never edited by smart club since import = epoch: medicoach's never-edited rows (epoch)
    // are never newer; any real medicoach edit is.
    const ours = fixture.schedule?.changedAt || EPOCH_CHANGED_AT;
    if (!(Date.parse(schedule.changedAt) > Date.parse(ours))) return 'stale';

    if (!('config' in cache)) cache.config = await repo.getTenantConfig(tenant);
    const config = cache.config ?? null;
    const venues = (cache.venues ??= await repo.listVenues(tenant));
    const aliases = venueAliasesFor(config);
    const built = buildInboundFixture(series, fixture, schedule, venues, aliases);
    if (!built.ok) {
      await holdConflict(deps, config, {
        series,
        fixture,
        input,
        reason: built.reason,
        detail: built.detail,
      });
      return 'conflict';
    }
    if (!built.changed.length) return 'unchanged';
    const next: ScheduleFixture = {
      ...built.fixture,
      schedule: { ...(fixture.schedule ?? {}), changedAt: isoInstant(schedule.changedAt) },
    };
    const nextFixtures = fixtures.map((f, j) => (j === i ? next : f));
    if (series.released) {
      const [listed, clubs] = await Promise.all([
        cache.series ?? repo.listSeries(tenant),
        cache.clubs ?? repo.listClubs(tenant),
      ]);
      cache.series = listed;
      cache.clubs = clubs;
      // The subject as just point-read (its version is what the write checks), the rest
      // from the shared list.
      const allSeries = listed.map((s) => (s.id === series.id ? series : s));
      const clashes = introducedClashes(
        series,
        { ...series, fixtures: nextFixtures },
        allSeries,
        clubs,
        venues,
        aliases,
      );
      if (clashes.length) {
        await holdConflict(deps, config, {
          series,
          fixture,
          input,
          reason: 'clash',
          detail: clashes.slice(0, 5).map(formatClashForHumans),
        });
        return 'conflict';
      }
    }
    let written: Series;
    try {
      written = await repo.updateSeries(tenant, seriesId, {
        fixtures: nextFixtures,
        version: series.version,
        ...(fixturesEditRecallsApproval(series) ? { approved: false, approvedAt: null } : {}),
      });
    } catch (err) {
      if (err instanceof VersionConflictError) continue;
      throw err;
    }
    if (cache.series) cache.series = cache.series.map((s) => (s.id === written.id ? written : s));
    // A held proposal for this ref is now moot: the newer change applied cleanly.
    const held = await repo.getSyncConflict(tenant, ref);
    if (held && !(Date.parse(held.proposed.changedAt) > Date.parse(schedule.changedAt)))
      await repo.deleteSyncConflict(tenant, ref);
    return 'applied';
  }
  throw new Error(
    `series ${seriesId} kept changing; schedule apply gave up after ${APPLY_ATTEMPTS} attempts`,
  );
}

/** A readable "Home v Away" for a fixture (participant names, else the raw side). */
function matchLineOf(series: Series, f: ScheduleFixture): string {
  const name = (side: string | undefined) =>
    series.participants?.find((p) => p.teamId === side)?.name ??
    (side ? tbdLabel(side) : null) ??
    side ??
    '?';
  return `${name(f.home)} v ${name(f.away)}`;
}

/**
 * Write (or keep) the SYNCCONFLICT# row for a refused change. Latest proposal wins per ref:
 * an older proposal than the one held is ignored, the same proposal again (a replayed page)
 * changes nothing — except that a held proposal whose email never went out (`notifiedAt`
 * unset: the send failed) retries the email. Each proposal emails the admins once.
 */
async function holdConflict(
  deps: InboundScheduleDeps,
  config: TenantConfig | null,
  args: {
    series: Series;
    fixture: ScheduleFixture;
    input: InboundScheduleInput;
    reason: SyncConflict['reason'];
    detail: string[];
  },
): Promise<void> {
  const { repo } = deps;
  const { series, fixture, input } = args;
  const now = deps.now ?? (() => new Date());
  const held = await repo.getSyncConflict(input.tenant, input.ref);
  if (held && Date.parse(held.proposed.changedAt) > Date.parse(input.schedule.changedAt)) return;
  if (held && Date.parse(held.proposed.changedAt) === Date.parse(input.schedule.changedAt)) {
    // The same proposal replayed: nothing to write; retry the email only if it never went out.
    if (!held.notifiedAt) await emailConflict(deps, input.tenant, config, held);
    return;
  }
  const conflict: SyncConflict = {
    ref: input.ref,
    seriesId: input.seriesId,
    fixtureId: input.fixtureId,
    ...(series.name ? { seriesName: series.name } : {}),
    matchLine: matchLineOf(series, fixture),
    current: {
      ...(fixture.date ? { date: fixture.date } : {}),
      ...(fixture.time ? { time: fixture.time } : {}),
      ...(effectiveVenue(series, fixture) ? { venue: effectiveVenue(series, fixture)! } : {}),
      status: fixture.status ?? 'scheduled',
      ...(fixture.dateTbc ? { dateTbc: true } : {}),
    },
    proposed: { ...input.schedule },
    fields: input.fields,
    reason: args.reason,
    detail: args.detail,
    detectedAt: now().toISOString(),
  };
  await repo.putSyncConflict(input.tenant, conflict);
  const log = deps.log ?? ((line: string) => console.log(line));
  log(
    `[medicoach-sync] ${input.tenant}: schedule change held for review (${args.reason}) ${input.ref}`,
  );
  await emailConflict(deps, input.tenant, config, conflict);
}

/** Email the admins about a held conflict and stamp `notifiedAt`; a failure is only logged. */
async function emailConflict(
  deps: InboundScheduleDeps,
  tenant: string,
  config: TenantConfig | null,
  conflict: SyncConflict,
): Promise<void> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  try {
    await (deps.notifyConflict ?? notifyConflictByEmail(repo))(tenant, conflict, config);
    await repo.putSyncConflict(tenant, { ...conflict, notifiedAt: now().toISOString() });
  } catch (err) {
    // The conflict is held and visible in the admin inbox either way; a failed email is
    // logged (the next replay of the same proposal retries it), never allowed to fail the
    // sync run.
    console.error(
      `[medicoach-sync] ${tenant}: conflict email failed — ${err instanceof Error ? err.message : 'error'}`,
    );
  }
}

/**
 * A wire schedule as the conflict inbox compares it with smart club's (`SyncConflict.current`
 * has the same shape): wall-clock date and time, venue, and a status.
 */
export function scheduleParts(s: SyncScheduleSnapshot | SyncSchedule): {
  date?: string;
  time?: string;
  venue?: string;
  status: string;
  dateTbc?: boolean;
} {
  const out: { date?: string; time?: string; venue?: string; status: string; dateTbc?: boolean } = {
    status: s.cancelled ? 'cancelled' : s.postponed ? 'postponed' : 'scheduled',
  };
  if (s.dateTbc) out.dateTbc = true;
  else if (s.scheduledTime) {
    const { date, time } = wallClock(s.scheduledTime);
    out.date = date;
    if (!s.timeTbc) out.time = time;
  }
  if (s.venue) out.venue = s.venue;
  // Key order as `current` lists them, so the two read side by side.
  const { date, time, venue, status, dateTbc } = out;
  return {
    ...(date ? { date } : {}),
    ...(time ? { time } : {}),
    ...(venue ? { venue } : {}),
    status,
    ...(dateTbc ? { dateTbc } : {}),
  };
}

/** Human text of a proposed schedule for the inbox and the email. */
export function describeSchedule(s: SyncScheduleSnapshot | SyncSchedule): string {
  const parts: string[] = [];
  if (s.dateTbc) parts.push('date TBC');
  else if (s.scheduledTime) {
    const { date, time } = wallClock(s.scheduledTime);
    parts.push(s.timeTbc ? date : `${date} ${time}`);
  }
  if (s.venue) parts.push(s.venue);
  if (s.cancelled) parts.push('cancelled');
  else if (s.postponed) parts.push('postponed');
  return parts.join(' · ') || '(no schedule)';
}

/**
 * The default conflict notice: one email to each tenant admin (SES; dry-run offline). Platform
 * operators are left out even when they hold an admin membership (operator auto-admin): they
 * see the inbox in the console and would otherwise get every tenant's conflicts.
 */
export function notifyConflictByEmail(
  repo: RepoModule,
  opts: {
    send?: (
      input: Parameters<(typeof import('../notify/email.js'))['sendSyncConflictEmail']>[0],
    ) => Promise<unknown>;
  } = {},
) {
  return async (tenant: string, conflict: SyncConflict, config: TenantConfig | null) => {
    const sendSyncConflictEmail =
      opts.send ?? (await import('../notify/email.js')).sendSyncConflictEmail;
    const { orgCopy } = await import('../branding.js');
    const { listTenantAdminEmails } = await import('../notify/admin-emails.js');
    const emails = await listTenantAdminEmails(repo, tenant);
    const orgName = config ? orgCopy(config).name : tenant;
    for (const to of emails)
      await sendSyncConflictEmail({
        to,
        orgName,
        matchLine: conflict.matchLine ?? conflict.ref,
        seriesName: conflict.seriesName ?? conflict.seriesId,
        reason: conflict.reason,
        detail: conflict.detail,
        proposed: describeSchedule(conflict.proposed),
      });
  };
}
