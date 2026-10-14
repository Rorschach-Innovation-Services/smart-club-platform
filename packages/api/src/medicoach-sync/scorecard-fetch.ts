/**
 * Medicoach scorecards (FIXSCORECARD#): the ball-by-ball card behind a pulled result, kept so
 * each side's captain's report can show it and ask for it to be confirmed.
 *
 *   GET {MedicoachSyncUrl}/integrations/smartclub/matches/<matchId>/scorecard?tournamentId=<id>
 *
 * signed exactly like `/changes` (contract HMAC). Two triggers:
 *   - the puller, right after it stores a result that carries both medicoach ids (never for
 *     `import`-sourced results — migrations/backfills have no card to confirm);
 *   - `sweepScorecards`, once per tenant sync run: recent results with no card yet (a fetch
 *     that failed), or whose card is older than the result, are fetched again. Bounded and
 *     sequential.
 *
 * A stored card with `available: true` flags the scorecard answer of every SUBMITTED captain's
 * report for the fixture answered against an older card as `stale` (best-effort).
 *
 * Outcomes: 200 → the row is stored. `available: false` is NOT terminal at first: medicoach can
 * publish a card after the result (scoring finished later), so the stub is re-checked by the
 * sweep at most every SCORECARD_UNAVAILABLE_RECHECK_MS for SCORECARD_UNAVAILABLE_WINDOW_MS
 * after the first `available: false` (the stub's `fetchedAt`; `lastCheckedAt` moves), then
 * flipped terminal. 404 → a terminal stub (`available: false, terminal: true`) straight away,
 * so the sweep stops asking. A 404 or
 * `available: false` NEVER replaces an available card already stored for the same match: the
 * card is kept and only its `lastCheckedAt` moves. Anything else (network, 5xx, 401, a body
 * that fails the schema) → logged, nothing written, and the next sweep retries. Never throws.
 *
 * Logs carry fixture ids and HTTP statuses only — never a scorecard (it holds player names).
 */
import {
  ScorecardResponseSchema,
  scorecardPathAndQuery,
  signRequest,
} from '../medicoach-sync-contract.js';
import type { StoredFixtureResult, StoredFixtureScorecard } from '../types.js';
import type { PullerDeps } from './puller.js';

/** Results older than this (by `recordedAt`) are left alone by the sweep. */
export const SCORECARD_SWEEP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Max fetches one sweep makes — the rest wait for the next run. */
export const SCORECARD_SWEEP_MAX_FETCHES = 25;
/**
 * Consecutive failed fetches after which a sweep gives up until the next run: a medicoach
 * that is down must not spend the cron's 5-minute budget (shared by every tenant) on timeouts.
 */
export const SCORECARD_SWEEP_MAX_CONSECUTIVE_FAILURES = 3;
/** How long after the first `available: false` the sweep keeps re-checking for a card. */
export const SCORECARD_UNAVAILABLE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** How often (at most) the sweep re-checks a non-terminal `available: false` stub. */
export const SCORECARD_UNAVAILABLE_RECHECK_MS = 60 * 60 * 1000;
const HTTP_TIMEOUT_MS = 10_000;

export type ScorecardFetchDeps = Pick<
  PullerDeps,
  'repo' | 'url' | 'secret' | 'fetch' | 'now' | 'log'
>;

export type ScorecardFetchOutcome = 'stored' | 'unavailable' | 'not-found' | 'error' | 'skipped';

/**
 * Fetch one match's scorecard and store it as the fixture's FIXSCORECARD# row. Skipped (no
 * request, no row) without a url/secret (dry run) or without both medicoach ids.
 */
export async function fetchAndStoreScorecard(
  deps: ScorecardFetchDeps,
  tenant: string,
  seriesId: string,
  fixtureId: string,
  medicoachMatchId: string | undefined,
  medicoachTournamentId: string | undefined,
): Promise<ScorecardFetchOutcome> {
  const log = deps.log ?? ((line: string) => console.warn(line));
  const now = deps.now ?? (() => new Date());
  if (!deps.url || !deps.secret || !medicoachMatchId || !medicoachTournamentId) return 'skipped';
  const where = `${tenant}: scorecard for ${seriesId}/${fixtureId}`;
  try {
    const pq = scorecardPathAndQuery(medicoachMatchId, medicoachTournamentId, tenant);
    const res = await (deps.fetch ?? fetch)(`${deps.url}${pq}`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...signRequest({ secret: deps.secret, method: 'GET', pathAndQuery: pq }),
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const base = {
      seriesId,
      fixtureId,
      medicoachMatchId,
      medicoachTournamentId,
      schemaVersion: 1 as const,
      fetchedAt: now().toISOString(),
    };
    // "No card" must never destroy a card a captain may already be looking at: an available
    // card stored for this same match is kept (its lastCheckedAt moves), else a stub.
    const storeNoCard = async (stub: StoredFixtureScorecard) => {
      const existing = await deps.repo.getFixtureScorecard(tenant, seriesId, fixtureId);
      const sameMatch =
        existing?.medicoachMatchId === medicoachMatchId &&
        existing?.medicoachTournamentId === medicoachTournamentId;
      if (existing?.available && sameMatch) {
        await deps.repo.touchFixtureScorecardCheckedAt(
          tenant,
          seriesId,
          fixtureId,
          existing.fetchedAt,
          base.fetchedAt,
        );
        return;
      }
      // A non-terminal `available: false` stub for this match is still inside its re-check
      // window: keep the window's start (`fetchedAt`), note this check, and flip terminal once
      // the window has run out. A terminal stub (or none) starts a fresh window.
      if (!stub.terminal && existing && sameMatch && !existing.available && !existing.terminal) {
        const expired =
          Date.parse(base.fetchedAt) - Date.parse(existing.fetchedAt) >=
          SCORECARD_UNAVAILABLE_WINDOW_MS;
        await deps.repo.putFixtureScorecard(tenant, {
          ...stub,
          fetchedAt: existing.fetchedAt,
          lastCheckedAt: base.fetchedAt,
          ...(expired ? { terminal: true } : {}),
        });
        return;
      }
      await deps.repo.putFixtureScorecard(tenant, stub);
    };
    if (res.status === 404) {
      await storeNoCard({ ...base, available: false, terminal: true });
      return 'not-found';
    }
    if (!res.ok) {
      log(`[medicoach-sync] ${where}: medicoach answered HTTP ${res.status} — will retry`);
      return 'error';
    }
    const parsed = ScorecardResponseSchema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success || parsed.data.matchId !== medicoachMatchId) {
      // Paths only: a zod message can echo values, and the values here are player names.
      const at = parsed.success
        ? 'matchId (a different match)'
        : parsed.error.issues
            .slice(0, 3)
            .map((i) => i.path.join('.') || '(root)')
            .join(', ');
      log(`[medicoach-sync] ${where}: response failed the contract at ${at} — will retry`);
      return 'error';
    }
    const card = parsed.data;
    const row: StoredFixtureScorecard = {
      ...base,
      available: card.available,
      ...(card.matchState !== undefined ? { matchState: card.matchState } : {}),
      ...(card.available && card.innings ? { innings: card.innings } : {}),
    };
    if (card.available) await deps.repo.putFixtureScorecard(tenant, row);
    else await storeNoCard(row);
    if (card.available) {
      // A captain who already answered saw an older card: flag the answer stale.
      // Best-effort — a failure is a log line, never the fetch's.
      const failed = (err: unknown) =>
        log(
          `[medicoach-sync] ${where}: could not flag stale scorecard answers — ${
            err instanceof Error ? err.name : 'error'
          }`,
        );
      await deps.repo
        .flagStaleCaptainsReportScorecards(tenant, seriesId, fixtureId, base.fetchedAt)
        .catch(failed);
    }
    return card.available ? 'stored' : 'unavailable';
  } catch (err) {
    log(
      `[medicoach-sync] ${where}: fetch failed — ${err instanceof Error ? err.name : 'error'} — will retry`,
    );
    return 'error';
  }
}

/** Whether the sweep should (re)fetch the card for this result. Pure. */
export function needsScorecardFetch(
  result: StoredFixtureResult,
  card: StoredFixtureScorecard | undefined,
  nowMs: number,
): boolean {
  if (result.cleared || result.resultSource === 'import') return false;
  if (!result.medicoachMatchId || !result.medicoachTournamentId || !result.recordedAt) return false;
  const recordedMs = Date.parse(result.recordedAt);
  if (!Number.isFinite(recordedMs) || nowMs - recordedMs > SCORECARD_SWEEP_WINDOW_MS) return false;
  if (!card) return true;
  // The result now points at a different medicoach match: the stored card is not its card.
  if (
    card.medicoachMatchId !== result.medicoachMatchId ||
    card.medicoachTournamentId !== result.medicoachTournamentId
  )
    return true;
  if (card.terminal) return false;
  // A kept card that a later fetch found gone counts as checked then (see storeNoCard).
  const checkedMs = Date.parse(card.lastCheckedAt ?? card.fetchedAt);
  // No card yet, but still inside its re-check window (non-terminal): ask again now and then.
  if (!card.available && nowMs - checkedMs >= SCORECARD_UNAVAILABLE_RECHECK_MS) return true;
  return recordedMs > checkedMs;
}

export interface ScorecardSweepSummary {
  candidates: number;
  fetched: number;
  failed: number;
}

/**
 * Fetch the scorecards the tenant's recent results still lack (see `needsScorecardFetch`),
 * at most SCORECARD_SWEEP_MAX_FETCHES, one at a time, stopping early after
 * SCORECARD_SWEEP_MAX_CONSECUTIVE_FAILURES failures in a row. A failed fetch is counted and
 * left for the next sweep. A repo read failure throws (the caller isolates it).
 */
export async function sweepScorecards(
  deps: ScorecardFetchDeps,
  tenant: string,
): Promise<ScorecardSweepSummary> {
  const summary: ScorecardSweepSummary = { candidates: 0, fetched: 0, failed: 0 };
  if (!deps.url || !deps.secret) return summary; // dry run
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const [results, cards] = await Promise.all([
    deps.repo.listFixtureResults(tenant),
    deps.repo.listFixtureScorecards(tenant),
  ]);
  const byFixture = new Map(cards.map((c) => [`${c.seriesId}#${c.fixtureId}`, c]));
  const due = results
    .filter((r) => needsScorecardFetch(r, byFixture.get(`${r.seriesId}#${r.fixtureId}`), nowMs))
    // Newest results first: they are the ones a chair is about to confirm.
    .sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)));
  summary.candidates = due.length;
  let consecutiveFailures = 0;
  for (const r of due.slice(0, SCORECARD_SWEEP_MAX_FETCHES)) {
    if (consecutiveFailures >= SCORECARD_SWEEP_MAX_CONSECUTIVE_FAILURES) break;
    const outcome = await fetchAndStoreScorecard(
      deps,
      tenant,
      r.seriesId,
      r.fixtureId,
      r.medicoachMatchId,
      r.medicoachTournamentId,
    );
    if (outcome === 'error') {
      summary.failed++;
      consecutiveFailures++;
    } else {
      consecutiveFailures = 0;
      if (outcome !== 'skipped') summary.fetched++;
    }
  }
  return summary;
}
