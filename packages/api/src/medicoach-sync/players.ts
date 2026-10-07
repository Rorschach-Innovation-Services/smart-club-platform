/**
 * Medicoach PLAYER sync — smart club → medicoach team rosters (ADR 0018).
 *
 * Every repo write that changes a player row notes the PERSON (natural key) on the
 * `PENDINGPLAYERSYNC#` outbox (`repo.recordPlayerSyncChange`); erasure writes an `erase`
 * tombstone. The 15-minute cron (and "Sync now") flushes the outbox AFTER the schedule push:
 * for each person it rebuilds the CURRENT desired state from all of their rows across the
 * tenant (`syncIntent`) and pushes it to `POST /integrations/smartclub/players` in batches of
 * ≤50. Desired state, not events: a replay or an out-of-order push is harmless.
 *
 * Results: created/linked/updated/unchanged/removed/erased/stale delete the row (only while
 * it still holds the change that was sent); `needs-review` moves the person to a
 * `PLAYERREVIEW#` row; `unmapped-team` PARKS the row (medicoach lacks a team — resending every
 * run would only repeat personal data); `error` or a failed request counts an attempt.
 *
 * Same-person guard: before pushing an upsert, another smart-club person with the same
 * normalised name + dob but a different natural key (a typo'd ID, a passport later swapped for
 * an SA ID) holds the push as a `smartclub-possible-duplicate` review, unless an admin
 * confirmed the pair distinct (`PLAYERDISTINCT#`).
 *
 * PERSONAL DATA: payloads carry names, dob, contact and guardian. Never log a payload, a ref
 * or a natural key — counts only.
 */
import { randomUUID } from 'node:crypto';
import { normaliseEmail } from '../medicoach-export-build.js';
import { refs } from '../medicoach-bundle.js';
import { recipesForTenant } from '../medicoach-recipes/index.js';
import {
  MEDICOACH_SYNC_VERSION,
  PLAYER_PUSH_MAX,
  PLAYERS_PATH,
  PlayerPushEntrySchema,
  PlayerPushResponseSchema,
  parseTeamRef,
  signRequest,
  type PlayerPushEntry,
  type PlayerPushResponse,
} from '../medicoach-sync-contract.js';
import type {
  Club,
  PendingPlayerSync,
  PlayerClearance,
  PlayerPushCounts,
  PlayerRegistration,
  PlayerReviewCandidate,
  TenantConfig,
} from '../types.js';
import { explainSyncError } from './explain.js';
import {
  buildPlacementContext,
  distinctPair,
  nameDobKey,
  playerSyncEnabled,
  syncIntent,
  type PlacementContext,
  type SyncIntent,
} from './player-placement.js';

type RepoModule = typeof import('../repo.js');

/** At most this many outbox rows per run; the rest stay queued for the next (checkpoint). */
export const PLAYER_FLUSH_MAX_PER_RUN = 500;

/**
 * The cap for an admin's "Sync now" (ONE batch): it runs inside the API Lambda behind the 30 s
 * API Gateway limit, and a single batch may take up to HTTP_TIMEOUT_MS (25 s). The rest stay
 * queued (`deferred`) and the cron continues with the full cap (10 batches × worst 25 s fits
 * its 300 s budget; steady-state batches take 1–2 s).
 */
export const PLAYER_FLUSH_MAX_MANUAL = 50;

/** The per-run row cap for a trigger: manual runs send a first slice, the cron drains. */
export function playerFlushCap(trigger: 'cron' | 'manual' | 'cli'): number {
  return trigger === 'manual' ? PLAYER_FLUSH_MAX_MANUAL : PLAYER_FLUSH_MAX_PER_RUN;
}

/**
 * Per player-push request. A worst-case batch of 50 NEW players (matcher + creates) measured
 * ~3–5 s with 3× spikes, so the fixture push's 10 s would cut real work short.
 */
const HTTP_TIMEOUT_MS = 25_000;
const ROSTER_CONCURRENCY = 8;

/* ─────────────────────────── Snapshot (one read of the tenant) ─────────────────────────── */

/** Everything a flush, the backfill and the duplicate audit read about the tenant, once. */
export interface PlayerSyncSnapshot {
  config: TenantConfig | null;
  ctx: PlacementContext;
  clubsById: Map<string, Club>;
  /** Every player row of every club, by natural key. */
  rowsByNk: Map<string, PlayerRegistration[]>;
  /** Every clearance naming the person, by natural key. */
  clearancesByNk: Map<string, PlayerClearance[]>;
  /** normalised name + dob → the natural keys of non-placeholder rows carrying it. */
  byNameDob: Map<string, Set<string>>;
  /** Confirmed-distinct pairs (`${a}#${b}`, a < b). */
  distinct: Set<string>;
}

export async function loadPlayerSyncSnapshot(
  repo: Pick<
    RepoModule,
    | 'getTenantConfig'
    | 'listClubs'
    | 'listSeries'
    | 'listSeasonRuns'
    | 'listPlayers'
    | 'listAllClearances'
    | 'listPlayerDistinctPairs'
  >,
  tenant: string,
  opts: { config?: TenantConfig | null } = {},
): Promise<PlayerSyncSnapshot> {
  const [config, clubs, series, seasonRuns, clearances, distinct] = await Promise.all([
    opts.config !== undefined ? Promise.resolve(opts.config) : repo.getTenantConfig(tenant),
    repo.listClubs(tenant),
    repo.listSeries(tenant),
    repo.listSeasonRuns(tenant),
    repo.listAllClearances(tenant),
    repo.listPlayerDistinctPairs(tenant),
  ]);
  const ctx = buildPlacementContext({
    tenant,
    config,
    clubs,
    series,
    seasonRuns,
    recipes: recipesForTenant(tenant),
  });
  const rowsByNk = new Map<string, PlayerRegistration[]>();
  const byNameDob = new Map<string, Set<string>>();
  // One paginated query per club in bounded parallel slices (buildCrossClubIndex's pattern).
  for (let i = 0; i < clubs.length; i += ROSTER_CONCURRENCY) {
    const slice = clubs.slice(i, i + ROSTER_CONCURRENCY);
    // eslint-disable-next-line no-await-in-loop -- sequential slices, each internally parallel
    const rosters = await Promise.all(slice.map((c) => repo.listPlayers(tenant, c.id)));
    for (const roster of rosters)
      for (const p of roster) {
        rowsByNk.set(p.naturalKey, [...(rowsByNk.get(p.naturalKey) ?? []), p]);
        if (p.placeholder === true) continue;
        const key = nameDobKey(p);
        if (!key) continue;
        const set = byNameDob.get(key) ?? new Set<string>();
        set.add(p.naturalKey);
        byNameDob.set(key, set);
      }
  }
  const clearancesByNk = new Map<string, PlayerClearance[]>();
  for (const c of clearances)
    clearancesByNk.set(c.playerNaturalKey, [...(clearancesByNk.get(c.playerNaturalKey) ?? []), c]);
  return {
    config,
    ctx,
    clubsById: new Map(clubs.map((c) => [c.id, c])),
    rowsByNk,
    clearancesByNk,
    byNameDob,
    distinct,
  };
}

/** The person's intent from the snapshot. */
export function intentOf(snap: PlayerSyncSnapshot, naturalKey: string): SyncIntent {
  return syncIntent(
    snap.rowsByNk.get(naturalKey) ?? [],
    snap.clearancesByNk.get(naturalKey) ?? [],
    snap.ctx,
  );
}

/**
 * Other smart-club persons with this person's normalised name + dob, minus pairs an admin
 * confirmed distinct. Empty when the guard has nothing to say.
 */
export function possibleDuplicates(
  snap: PlayerSyncSnapshot,
  naturalKey: string,
  person: Pick<PlayerRegistration, 'firstName' | 'lastName' | 'dob'>,
): string[] {
  const key = nameDobKey(person);
  if (!key) return [];
  return [...(snap.byNameDob.get(key) ?? [])].filter(
    (nk) => nk !== naturalKey && !snap.distinct.has(distinctPair(naturalKey, nk).join('#')),
  );
}

/** A candidate as the review shows it: another smart-club person (their newest row). */
function smartClubCandidate(snap: PlayerSyncSnapshot, nk: string): PlayerReviewCandidate {
  const rows = [...(snap.rowsByNk.get(nk) ?? [])].sort((a, b) =>
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
  );
  const r = rows.find((x) => (x.status ?? 'active') === 'active') ?? rows[0];
  return {
    naturalKey: nk,
    name: r ? `${r.firstName} ${r.lastName}`.trim() : '',
    dob: r?.dob ?? null,
    institutionName: r ? (snap.clubsById.get(r.clubId)?.name ?? null) : null,
  };
}

/* ─────────────────────────── Payload ─────────────────────────── */

const optStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/**
 * The wire entry for one outbox row, or why it cannot be sent. `erase` (a tombstone, or the
 * erase owed before a re-registration) never reads the snapshot.
 */
export function buildPlayerEntry(
  tenant: string,
  row: Pick<PendingPlayerSync, 'naturalKey' | 'changedAt' | 'op' | 'eraseFirst' | 'resolution'>,
  intent: SyncIntent | null,
): PlayerPushEntry {
  const ref = refs.player(tenant, row.naturalKey);
  if (row.op === 'erase' || row.eraseFirst || !intent)
    return { ref, op: 'erase', changedAt: row.changedAt };
  if (intent.op === 'remove') return { ref, op: 'remove', changedAt: row.changedAt };
  const p = intent.primary;
  const dob = optStr(p.dob);
  return {
    ref,
    op: 'upsert',
    changedAt: row.changedAt,
    institutionRef: refs.institution(tenant, p.clubId),
    firstName: String(p.firstName ?? '').trim(),
    lastName: String(p.lastName ?? '').trim(),
    ...(dob ? { dob } : {}),
    ...(optStr(p.gender) ? { gender: optStr(p.gender) } : {}),
    ...(normaliseEmail(p.email) ? { email: normaliseEmail(p.email) } : {}),
    ...(optStr(p.cell) ? { cell: optStr(p.cell) } : {}),
    isMinor: p.isMinor === true,
    ...(optStr(p.guardianName) ? { guardianName: optStr(p.guardianName) } : {}),
    teamRefs: intent.teamRefs,
    ...(intent.veteransClubId
      ? { veteransInstitutionRef: refs.institution(tenant, intent.veteransClubId) }
      : {}),
    ...(row.resolution ? { resolution: row.resolution } : {}),
  };
}

/* ─────────────────────────── Transport ─────────────────────────── */

export interface PlayerPushDeps {
  url: string;
  secret: string;
  fetch?: typeof fetch;
}

/**
 * POST one batch (≤50). Throws a technical message (statuses and field paths only) on a
 * whole-request failure; per-player answers come back in `results`.
 */
export async function postPlayerBatch(
  tenant: string,
  players: PlayerPushEntry[],
  deps: PlayerPushDeps,
  opts: { dryRun?: boolean } = {},
): Promise<PlayerPushResponse> {
  const body = JSON.stringify({
    version: MEDICOACH_SYNC_VERSION,
    tenant,
    ...(opts.dryRun ? { dryRun: true } : {}),
    players,
  });
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${deps.url}${PLAYERS_PATH}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...signRequest({ secret: deps.secret, method: 'POST', pathAndQuery: PLAYERS_PATH, body }),
      },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
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
  const ok = PlayerPushResponseSchema.safeParse(parsed);
  if (!ok.success) throw new Error('medicoach response failed the v1 contract');
  return ok.data;
}

/* ─────────────────────────── Flush ─────────────────────────── */

export interface PlayerFlushDeps extends PlayerPushDeps {
  repo: RepoModule;
  now?: () => Date;
  log?: (line: string) => void;
  /** Rows per run (default PLAYER_FLUSH_MAX_PER_RUN). */
  maxRows?: number;
  /**
   * Flush ONLY these people (natural keys) — an admin's review resolution sends the affected
   * rows at once. Parked rows are still skipped; everything else is the normal flush.
   */
  only?: string[];
  config?: TenantConfig | null;
}

export interface PlayerFlushSummary {
  status: 'disabled' | 'empty' | 'ok' | 'dry-run';
  /** Rows waiting (not parked) when the flush started. */
  pending: number;
  parked: number;
  /** Rows left for the next run by the per-run cap. */
  deferred: number;
  counts: PlayerPushCounts;
}

export const zeroPlayerPush = (): PlayerPushCounts => ({
  sent: 0,
  created: 0,
  linked: 0,
  updated: 0,
  unchanged: 0,
  removed: 0,
  erased: 0,
  stale: 0,
  needsReview: 0,
  possibleDuplicates: 0,
  parked: 0,
  errors: 0,
});

/** The person's display name/dob/club for a review row (their primary or newest row). */
function reviewSubject(snap: PlayerSyncSnapshot, nk: string, intent: SyncIntent | null) {
  const p =
    intent?.op === 'upsert'
      ? intent.primary
      : [...(snap.rowsByNk.get(nk) ?? [])].sort((a, b) =>
          String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
        )[0];
  return {
    playerName: p ? `${p.firstName} ${p.lastName}`.trim() : '',
    dob: p?.dob ?? null,
    clubName: p ? (snap.clubsById.get(p.clubId)?.name ?? null) : null,
  };
}

/**
 * Push the tenant's player outbox (ADR 0018). Never throws for a medicoach failure: failed
 * rows keep their attempt count for the next run. Parked rows are skipped. Dry run (URL or
 * secret empty): logs a count, sends nothing, writes nothing.
 */
export async function flushPlayerOutbox(
  tenant: string,
  trigger: 'cron' | 'manual' | 'cli',
  deps: PlayerFlushDeps,
): Promise<PlayerFlushSummary> {
  const { repo } = deps;
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());
  const counts = zeroPlayerPush();
  const config = deps.config !== undefined ? deps.config : await repo.getTenantConfig(tenant);
  const all = await repo.listPendingPlayerSync(tenant);
  const parked = all.filter((r) => r.parked).length;
  if (!playerSyncEnabled(config))
    return { status: 'disabled', pending: all.length - parked, parked, deferred: 0, counts };
  // Fresh rows before rows that keep failing, then oldest first.
  const only = deps.only ? new Set(deps.only) : null;
  const live = all
    .filter((r) => !only || only.has(r.naturalKey))
    .filter((r) => !r.parked)
    .sort((a, b) => a.attempts - b.attempts || a.enqueuedAt.localeCompare(b.enqueuedAt));
  if (!live.length) return { status: 'empty', pending: 0, parked, deferred: 0, counts };
  const cap = deps.maxRows ?? PLAYER_FLUSH_MAX_PER_RUN;
  const rows = live.slice(0, cap);
  const deferred = live.length - rows.length;
  if (!deps.url || !deps.secret) {
    log(
      `[medicoach-sync dry-run] ${tenant}: would push ${rows.length} player change(s) to ` +
        `${deps.url || '<MedicoachSyncUrl unset>'}${PLAYERS_PATH}` +
        `${deps.secret ? '' : ' (MedicoachSyncSecret unset)'} — no request made`,
    );
    return { status: 'dry-run', pending: live.length, parked, deferred, counts };
  }

  const at = () => now().toISOString();
  // `unreached`: the request never reached medicoach (transport/HTTP/contract failure) — the
  // row is still queued; distinct from medicoach rejecting this player (`errors`).
  const failRow = async (row: PendingPlayerSync, error: string, unreached = false) => {
    if (unreached) counts.unreached = (counts.unreached ?? 0) + 1;
    else counts.errors++;
    await repo.markPendingPlayerSyncFailed(tenant, row.naturalKey, row.changedAt, error, at());
  };
  const snap = await loadPlayerSyncSnapshot(repo, tenant, { config });

  // Build every entry; hold possible duplicates; drop what cannot fit the contract.
  const sendable: Array<{
    row: PendingPlayerSync;
    entry: PlayerPushEntry;
    intent: SyncIntent | null;
  }> = [];
  for (const row of rows) {
    const erasing = row.op === 'erase' || row.eraseFirst === true;
    const intent = erasing ? null : intentOf(snap, row.naturalKey);
    // An admin's link/create resolution already decided who this is: the guard never discards it.
    if (intent?.op === 'upsert' && !row.resolution) {
      const dups = possibleDuplicates(snap, row.naturalKey, intent.primary);
      if (dups.length) {
        await repo.putPlayerReview(tenant, {
          naturalKey: row.naturalKey,
          reason: 'smartclub-possible-duplicate',
          message: 'another smart club registration has the same name and date of birth',
          detectedAt: at(),
          ...reviewSubject(snap, row.naturalKey, intent),
          candidates: dups.map((nk) => smartClubCandidate(snap, nk)),
        });
        await repo.deletePendingPlayerSyncIfUnchanged(tenant, row.naturalKey, row.changedAt);
        counts.possibleDuplicates++;
        continue;
      }
    }
    const entry = buildPlayerEntry(tenant, row, intent);
    const check = PlayerPushEntrySchema.safeParse(entry);
    if (!check.success) {
      const fields = [...new Set(check.error.issues.map((i) => i.path.join('.') || 'entry'))];
      await failRow(row, `the player does not fit the sync contract (${fields.join(', ')})`);
      continue;
    }
    sendable.push({ row, entry, intent });
  }

  let requestError: string | undefined;
  for (let i = 0; i < sendable.length; i += PLAYER_PUSH_MAX) {
    const batch = sendable.slice(i, i + PLAYER_PUSH_MAX);
    counts.sent += batch.length;
    let results: Map<string, PlayerPushResponse['results'][number]>;
    try {
      const res = await postPlayerBatch(
        tenant,
        batch.map((b) => b.entry),
        deps,
      );
      results = new Map(res.results.map((r) => [r.ref, r]));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'push failed';
      log(`[medicoach-sync] ${tenant}: player push failed — ${message}`);
      requestError ??= message;
      for (const b of batch) await failRow(b.row, message, true);
      continue;
    }
    for (const { row, entry, intent } of batch) {
      const r = results.get(entry.ref);
      if (!r) {
        await failRow(row, 'medicoach returned no result for this player');
        continue;
      }
      switch (r.status) {
        case 'error':
          await failRow(row, r.message || 'medicoach reported an error');
          break;
        case 'unmapped-team':
          counts.parked++;
          await repo.parkPendingPlayerSync(
            tenant,
            row.naturalKey,
            row.changedAt,
            r.missingTeamRefs ?? [],
            at(),
          );
          break;
        case 'needs-review':
          counts.needsReview++;
          await repo.putPlayerReview(tenant, {
            naturalKey: row.naturalKey,
            reason: 'medicoach-needs-review',
            ...(r.message ? { message: r.message.slice(0, 300) } : {}),
            detectedAt: at(),
            ...reviewSubject(snap, row.naturalKey, intent),
            candidates: (r.candidates ?? []).map((c) => ({
              playerId: c.playerId,
              name: c.name,
              dob: c.dob,
              institutionName: c.institutionName,
            })),
          });
          await repo.deletePendingPlayerSyncIfUnchanged(tenant, row.naturalKey, row.changedAt);
          break;
        default: {
          // created | linked | updated | unchanged | removed | erased | stale: done.
          counts[r.status]++;
          if (entry.op === 'erase' && row.eraseFirst && row.op !== 'erase') {
            // The owed erase went out; the row stays for the re-registration's upsert.
            await repo.clearPendingPlayerSyncEraseFirst(tenant, row.naturalKey, row.changedAt);
            break;
          }
          if (await repo.deletePendingPlayerSyncIfUnchanged(tenant, row.naturalKey, row.changedAt))
            await repo.deletePlayerReview(tenant, row.naturalKey);
        }
      }
    }
  }

  if (counts.sent || counts.errors || counts.unreached || counts.possibleDuplicates)
    await repo.putSyncLog(tenant, {
      id: randomUUID(),
      at: at(),
      trigger: trigger === 'cli' ? 'cli' : trigger,
      kind: 'player-push',
      outcome: counts.errors || counts.unreached ? 'error' : 'ok',
      pages: 0,
      fixtures: 0,
      counts: {
        resultsStored: 0,
        resultsStale: 0,
        resultsCleared: 0,
        unmapped: 0,
        slotsFilled: 0,
        scheduleDiffers: 0,
      },
      playerPush: counts,
      ...(requestError ? { error: requestError, message: explainSyncError(requestError) } : {}),
    });
  if (deferred)
    log(`[medicoach-sync] ${tenant}: ${deferred} player change(s) left for the next run`);
  return { status: 'ok', pending: live.length, parked, deferred, counts };
}

/* ─────────────────────────── Enable-time coverage probe ─────────────────────────── */

export interface PlayerSyncCoverage {
  /** People the sync would push as upserts. */
  players: number;
  /** Distinct teams they would be placed on. */
  teams: number;
  /** Teams in a league the last medicoach export did not cover (players there would park). */
  uncoveredTeams: number;
  /** Club squad teams: in medicoach only if the last export placed a player there. */
  squadTeams: number;
  lastExportAt: string | null;
  /** Plain-language warnings (counts only), empty when nothing looks missing. */
  warnings: string[];
}

/**
 * Teams reach medicoach ONLY through the migration bundle, and a player whose team medicoach
 * lacks is parked. Run when the player sync is switched on: compares the teams the sync would
 * place players on with the leagues the tenant's last medicoach export covered, and warns on
 * gaps. A heuristic (smart club cannot see medicoach's teams) — it never blocks the switch.
 */
export async function playerSyncCoverageProbe(
  repo: Parameters<typeof loadPlayerSyncSnapshot>[0] & Pick<RepoModule, 'listMedicoachExportLogs'>,
  tenant: string,
  config: TenantConfig | null,
): Promise<PlayerSyncCoverage> {
  const [snap, exports] = await Promise.all([
    loadPlayerSyncSnapshot(repo, tenant, { config }),
    repo.listMedicoachExportLogs(tenant),
  ]);
  const teams = new Set<string>();
  let players = 0;
  for (const nk of snap.rowsByNk.keys()) {
    const intent = intentOf(snap, nk);
    if (intent.op !== 'upsert') continue;
    players++;
    for (const t of intent.teamRefs) teams.add(t);
  }
  const last = [...exports].sort((a, b) => a.at.localeCompare(b.at)).pop() ?? null;
  const covered = new Set(last?.leagues ?? []);
  let uncoveredTeams = 0;
  let squadTeams = 0;
  for (const t of teams) {
    const parsed = parseTeamRef(t);
    if (parsed?.teamId === 'squad') squadTeams++;
    else if (!parsed || !covered.has(parsed.leagueKey)) uncoveredTeams++;
  }
  const warnings: string[] = [];
  if (!last)
    warnings.push(
      'No medicoach bundle export is recorded for this client, so its teams are not in ' +
        'medicoach yet: every player would be parked. Run export-medicoach and the medicoach ' +
        'import first.',
    );
  else if (uncoveredTeams)
    warnings.push(
      `${uncoveredTeams} of ${teams.size} team(s) are in leagues the last medicoach export ` +
        `(${last.at.slice(0, 10)}) did not cover: their players will be parked until a ` +
        'bundle top-up adds those teams.',
    );
  if (last && squadTeams)
    warnings.push(
      `${squadTeams} club squad team(s) are only in medicoach if the last export placed a ` +
        'player there; players on a missing squad will be parked until a bundle top-up.',
    );
  return {
    players,
    teams: teams.size,
    uncoveredTeams,
    squadTeams,
    lastExportAt: last?.at ?? null,
    warnings,
  };
}
