/**
 * Plain-English copy for the errors a union admin or operator can hit in the season and
 * fixtures flows. Every line says what happened and what to do next, in at most two
 * sentences, and never shows a code like `awaiting_entrants`. The mapping is keyed on the
 * server's `code` wherever one exists; the only string matches are the version-race
 * boilerplate (`<thing> changed; refetch`), which every route shares.
 *
 * `generate-feedback.ts` holds the generate-route 409s; this module holds the rest.
 */
import { ApiError, SERIES_CONFLICT_FRIENDLY, SERIES_CONFLICT_MESSAGE } from './api';

/**
 * True for a request that never got an answer: `fetch` rejects with a TypeError when the
 * server is unreachable ("Failed to fetch" in Chrome, "Load failed" in Safari,
 * "NetworkError when attempting to fetch resource." in Firefox), and the upload helpers
 * reject with a status-0 ApiError.
 */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 0;
  return err instanceof TypeError && /failed to fetch|load failed|networkerror/i.test(err.message);
}

/** What to say when the API could not be reached at all. */
export function networkErrorMessage(): string {
  return import.meta.env.VITE_LOCAL_AUTH === '1'
    ? "Couldn't reach the local API. Start it with `npm run dev:local`, then try again."
    : "Couldn't reach the server. Check your internet connection, then try again.";
}

/**
 * True for a plain optimistic-concurrency 409: the server's boilerplate for every
 * versioned record is "<thing> changed; refetch" (series, season run, club, clearance…).
 */
export function isVersionRace(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && /changed; refetch$/.test(err.message);
}

/** The version-race line for a season (entrant confirmation, rebase, generate). */
export const SEASON_CHANGED_MESSAGE =
  'Someone else changed this season at the same time. It has been refreshed — check it and try again.';

/**
 * The general fallback: a network failure or a version race gets its own copy, any other
 * server answer is shown as the server worded it, and anything else gets `fallback`.
 */
export function describeError(err: unknown, fallback: string): string {
  if (isNetworkError(err)) return networkErrorMessage();
  if (isVersionRace(err)) return SERIES_CONFLICT_FRIENDLY;
  if (err instanceof ApiError && err.message) return err.message;
  return fallback;
}

/**
 * Season-run writes outside generate: confirming entrants (`PATCH /season-runs/:id`) and
 * adopting a newer structure (`POST /season-runs/:id/rebase`). `null` when the error is
 * not one of these refusals.
 */
export function seasonRunConflictMessage(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  if (err.code === 'structure_changed')
    return 'The operator changed this structure again while you were reviewing it. Close this and open Review changes again to see the latest version.';
  if (isVersionRace(err)) return SEASON_CHANGED_MESSAGE;
  return null;
}

/** Inline copy for a failed season-run write, falling back to `describeError`. */
export function seasonRunErrorMessage(err: unknown, fallback: string): string {
  return seasonRunConflictMessage(err) ?? describeError(err, fallback);
}

/** The message shown when `POST /season-runs/quick-start` refuses. */
export function quickStartErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'invalid_dates':
        return 'Enter the dates as year-month-day (for example 2026-10-03), with the end on or after the start.';
      case 'bad_placement':
        return "A stage is set to play in a block this calendar doesn't have. Choose a block for each stage again, then start the season.";
      case 'competition_exists':
        return 'This league already has a competition on that calendar. Pick this league again and start the season from its competition.';
      case 'season_exists':
        return `${err.message}. Give the new season a different label, or carry on with the existing one under Seasons.`;
      case 'run_not_started':
        return "The competition was created but the season didn't start. Pick this league again and start it from its competition.";
    }
  }
  return describeError(err, 'Could not start the season — try again.');
}

/** What the release dialog says when `PATCH /series/:id { released: true }` refuses. */
export function releaseErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.code === 'not_approved')
    return "These fixtures haven't been approved yet. Approve them, then release.";
  const raw = err instanceof Error ? err.message : '';
  return describeError(err, raw || 'Release failed — try again.');
}

/** The per-call choices `withToast` (main.tsx) passes through to `toastCopy`. */
export interface ToastCopyOptions {
  rawConflict?: boolean;
  rawClientError?: boolean;
  /** Actionable copy for a structured 409; `null` falls back to the generic line. */
  conflictMessage?: (err: unknown) => string | null;
  /** Actionable copy for any other coded refusal (e.g. a 400); `null` falls through. */
  errorMessage?: (err: unknown) => string | null;
}

/**
 * The toast `withToast` (main.tsx) shows for a failed write, in priority order:
 * 1. the caller's structured copy (`errorMessage`, then `conflictMessage` for a 409);
 * 2. the network line when the request never reached the server — `errMsg` alone
 *    ("Could not generate the fixtures") gives the admin nothing to do next;
 * 3. the server's own words when the caller opted in (`rawConflict` for a 409,
 *    `rawClientError` for any 4xx) or for a 401 (the session-expired copy from api.ts);
 * 4. the friendly refresh line for any other 409;
 * 5. `errMsg`, else the error's message.
 *
 * Most 409s are optimistic-concurrency clashes, hence (4). User-management 409s ("user
 * already active…", "cannot remove the last admin") carry actionable copy, so those
 * callers pass `rawConflict`. A plain race carries exactly "series changed; refetch" —
 * server boilerplate — so it gets the friendly line even under `rawConflict`.
 */
export function toastCopy(err: unknown, errMsg: string | undefined, opts: ToastCopyOptions = {}) {
  const api = err instanceof ApiError ? err : undefined;
  const conflict = api?.status === 409;
  const structured =
    opts.errorMessage?.(err) ?? (conflict ? (opts.conflictMessage?.(err) ?? null) : null);
  if (structured) return structured;
  if (isNetworkError(err)) return networkErrorMessage();
  const plainConcurrency = conflict && api?.message === SERIES_CONFLICT_MESSAGE;
  const rawConflict = conflict && opts.rawConflict && !plainConcurrency;
  const rawClientError = opts.rawClientError && !!api && api.status >= 400 && api.status < 500;
  const authError = api?.status === 401;
  const message = err instanceof Error ? err.message : '';
  if (rawConflict || rawClientError || authError) return message;
  if (conflict) return SERIES_CONFLICT_FRIENDLY;
  return errMsg || message;
}
