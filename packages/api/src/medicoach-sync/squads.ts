/**
 * The §8 squad outbox: smart club → `POST /integrations/smartclub/fixture-squad` (captain
 * squad links). Modeled on the player outbox (`players.ts`).
 *
 * One `PENDINGSQUADSYNC#<requestId>` row per squad request, holding the latest push owed
 * (`upsert` after a submit, `void` after a cancel/move); the body is rebuilt from the live
 * request at flush. Drained by every sync run AFTER `flushScheduleOutbox` (so a fixture's own
 * create reaches medicoach first) and attempted at once, best-effort, after each submit.
 *
 * Answers:
 *  - `applied: true`, or `applied: false` with `stale` / `scoring-started` ⇒ terminal: the row
 *    is deleted (only while it still holds the push that was sent) and `pushOutcome` recorded;
 *  - `fixture-unmapped` ⇒ RETRYABLE (a submit can race the fixture's schedule push): the row
 *    stays and its `unmappedAttempts` count advances; after SQUAD_PUSH_MAX_ATTEMPTS unmapped
 *    ANSWERS it is dropped, recorded `gave-up` and reported to Sentry;
 *  - medicoach unreachable / HTTP error / bad body ⇒ the row stays (only `attempts` counted —
 *    transport errors never advance the unmapped bound) and is retried: an `upsert` until the
 *    day after the match has passed; a `void` until SQUAD_VOID_RETENTION_DAYS after it (an
 *    undelivered void leaves medicoach prefilling a stale squad under a reused fixture id), and
 *    dropping a still-unsent void is reported to Sentry.
 *
 * PERSONAL DATA: the body carries player refs (hashed ID numbers) and names. Never log a body,
 * a ref or a natural key — ids and counts only.
 */
import { refs } from '../medicoach-bundle.js';
import {
  FIXTURE_SQUAD_PATH,
  FixtureSquadResponseSchema,
  MEDICOACH_SYNC_VERSION,
  signRequest,
  type FixtureSquadPush,
  type FixtureSquadResponse,
} from '../medicoach-sync-contract.js';
import { parseSquadRequestId } from '../squad-requests.js';
import { tenantDate } from '../tenant-time.js';
import type { PendingSquadSync, SquadRequest } from '../types.js';

type RepoModule = typeof import('../repo.js');

/** fixture-unmapped ANSWERS (not transport errors) tolerated before a push is given up (Sentry). */
export const SQUAD_PUSH_MAX_ATTEMPTS = 8;
const HTTP_TIMEOUT_MS = 20_000;
/** Days after the match an unsent §8 `void` keeps retrying (upserts: 1). */
export const SQUAD_VOID_RETENTION_DAYS = 7;

export interface SquadPushDeps {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The §8 body for a request (upsert from its selection; void carries no names). */
export function fixtureSquadBody(
  tenant: string,
  req: SquadRequest,
  row: Pick<PendingSquadSync, 'op' | 'submittedAt'>,
): FixtureSquadPush {
  const base = {
    version: MEDICOACH_SYNC_VERSION as 1,
    tenant,
    fixtureRef: req.fixtureRef,
    side: req.side,
    ...(req.teamRef ? { teamRef: req.teamRef } : {}),
    submittedAt: row.submittedAt,
  };
  if (row.op === 'void') return { ...base, op: 'void', players: [], guests: [] };
  const sel = req.selection ?? { players: [], guests: [] };
  return {
    ...base,
    op: 'upsert',
    players: sel.players.map((p) => ({ ref: refs.player(tenant, p.key), name: p.name })),
    guests: sel.guests.map((g) => ({ name: g.name })),
    ...(sel.captainKey ? { captainRef: refs.player(tenant, sel.captainKey) } : {}),
  };
}

/** POST one squad. Throws a technical message (status / shape only) on a request failure. */
export async function postFixtureSquad(
  body: FixtureSquadPush,
  deps: SquadPushDeps,
): Promise<FixtureSquadResponse> {
  const json = JSON.stringify(body);
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${deps.url}${FIXTURE_SQUAD_PATH}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...signRequest({
          secret: deps.secret,
          method: 'POST',
          pathAndQuery: FIXTURE_SQUAD_PATH,
          body: json,
        }),
      },
      body: json,
      signal: AbortSignal.timeout(deps.timeoutMs ?? HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`medicoach unreachable: ${err instanceof Error ? err.name : 'request failed'}`);
  }
  if (!res.ok) throw new Error(`medicoach answered HTTP ${res.status}`);
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error('medicoach answered with a body that is not JSON');
  }
  const ok = FixtureSquadResponseSchema.safeParse(parsed);
  if (!ok.success) throw new Error('medicoach response failed the §8 contract');
  return ok.data;
}

export interface SquadFlushDeps extends SquadPushDeps {
  repo: RepoModule;
  now?: () => Date;
  log?: (line: string) => void;
  /** Flush only these request ids (the immediate post-submit flush). */
  only?: string[];
  /** Sentry capture (default: the Lambda's Sentry); injectable for tests. */
  captureException?: (
    err: Error,
    ctx: { tags: Record<string, string>; extra: Record<string, unknown> },
  ) => void;
}

export interface SquadFlushSummary {
  status: 'empty' | 'ok' | 'dry-run';
  pending: number;
  sent: number;
  applied: number;
  /** stale + scoring-started answers (terminal, not applied). */
  notApplied: number;
  /** fixture-unmapped answers kept for a retry. */
  unmapped: number;
  gaveUp: number;
  errors: number;
  /** Rows dropped unsent: request gone, or the match day has passed. */
  dropped: number;
}

/**
 * Push the tenant's squad outbox. Never throws for a medicoach failure. Dry run (URL or
 * secret empty): sends nothing, writes nothing.
 */
export async function flushSquadOutbox(
  tenant: string,
  deps: SquadFlushDeps,
): Promise<SquadFlushSummary> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const out: SquadFlushSummary = {
    status: 'empty',
    pending: 0,
    sent: 0,
    applied: 0,
    notApplied: 0,
    unmapped: 0,
    gaveUp: 0,
    errors: 0,
    dropped: 0,
  };
  const only = deps.only ? new Set(deps.only) : null;
  const rows = (await repo.listPendingSquadSync(tenant)).filter(
    (r) => !only || only.has(r.requestId),
  );
  out.pending = rows.length;
  if (!rows.length) return out;
  if (!deps.url || !deps.secret) {
    log(`[squad-push] ${tenant}: dry run — ${rows.length} squad push(es) not sent`);
    return { ...out, status: 'dry-run' };
  }
  out.status = 'ok';
  const today = tenantDate(now());
  for (const row of rows) {
    const key = parseSquadRequestId(row.requestId);
    const req = key
      ? await repo.getSquadRequest(tenant, key.seriesId, key.fixtureId, key.teamId)
      : null;
    // Gone, or an upsert for a request voided since (the void row replaces it on enqueue),
    // or a match past its retention (upsert: matchDate+1; void: +SQUAD_VOID_RETENTION_DAYS).
    const retentionDays = row.op === 'void' ? SQUAD_VOID_RETENTION_DAYS : 1;
    const tooOld = !!req && req.matchDate < addDay(today, -retentionDays);
    if (!req || (row.op === 'upsert' && req.status !== 'submitted') || tooOld) {
      await repo.deletePendingSquadSyncIfUnchanged(tenant, row.requestId, row.submittedAt);
      out.dropped++;
      if (row.op === 'void' && tooOld) {
        // Never delivered: medicoach may still prefill the voided squad under this fixture id.
        const msg = `squad void dropped undelivered ${SQUAD_VOID_RETENTION_DAYS} days after the match (${row.attempts ?? 0} attempts)`;
        console.error(`[squad-push] ${tenant} ${row.requestId}: ${msg}`);
        const capture =
          deps.captureException ?? (await import('../instrument.js')).Sentry.captureException;
        capture(new Error(msg), {
          tags: { tenant, job: 'squad-push' },
          extra: { requestId: row.requestId, attempts: row.attempts ?? 0 },
        });
      }
      continue;
    }
    const at = now().toISOString();
    let res: FixtureSquadResponse;
    try {
      out.sent++;
      res = await postFixtureSquad(fixtureSquadBody(tenant, req, row), deps);
    } catch (err) {
      out.errors++;
      await repo.markPendingSquadSyncFailed(
        tenant,
        row.requestId,
        err instanceof Error ? err.message : 'push failed',
        at,
      );
      continue;
    }
    if (!res.applied && res.reason === 'fixture-unmapped') {
      const { attempts, unmappedAttempts } = await repo.markPendingSquadSyncFailed(
        tenant,
        row.requestId,
        'fixture-unmapped',
        at,
        'unmapped',
      );
      if (unmappedAttempts >= SQUAD_PUSH_MAX_ATTEMPTS) {
        out.gaveUp++;
        await repo.deletePendingSquadSyncIfUnchanged(tenant, row.requestId, row.submittedAt);
        await repo.recordSquadPushOutcome(tenant, req, { at, applied: false, reason: 'gave-up' });
        const msg = `squad push gave up: fixture still unmapped after ${unmappedAttempts} fixture-unmapped answers (${attempts} attempts in all)`;
        console.error(`[squad-push] ${tenant} ${row.requestId}: ${msg}`);
        const capture =
          deps.captureException ?? (await import('../instrument.js')).Sentry.captureException;
        capture(new Error(msg), {
          tags: { tenant, job: 'squad-push' },
          extra: { requestId: row.requestId, unmappedAttempts, attempts },
        });
      } else {
        out.unmapped++;
        await repo.recordSquadPushOutcome(tenant, req, {
          at,
          applied: false,
          reason: 'fixture-unmapped',
        });
      }
      continue;
    }
    if (res.applied) out.applied++;
    else out.notApplied++;
    await repo.recordSquadPushOutcome(tenant, req, {
      at,
      applied: res.applied,
      ...(res.reason ? { reason: res.reason } : {}),
      mappedPlayers: res.mappedPlayers,
      unmappedAsGuest: res.unmappedAsGuest,
      guests: res.guests,
    });
    await repo.deletePendingSquadSyncIfUnchanged(tenant, row.requestId, row.submittedAt);
  }
  if (out.sent || out.dropped)
    log(
      `[squad-push] ${tenant}: sent=${out.sent} applied=${out.applied} notApplied=${out.notApplied} unmapped=${out.unmapped} gaveUp=${out.gaveUp} errors=${out.errors} dropped=${out.dropped}`,
    );
  return out;
}

const addDay = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
