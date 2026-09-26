/**
 * Behavior tests for the API client's auth contract (src/api.js).
 *
 * The original production bug: the token provider swallowed every failure into
 * `null`, so requests silently went out WITHOUT an Authorization header and the
 * API 401'd with copy users can't act on. These tests pin the corrected contract:
 *
 * - provider resolves null (session definitively gone) → no network call,
 *   friendly ApiError(401), auth-lost handler fired;
 * - provider throws (transient network blip) → error propagates, handler NOT
 *   fired — a flaky connection must never sign the user out;
 * - server-side 401 (token present but rejected) → handler fired, raw API copy
 *   ("missing bearer token") replaced with the friendly message;
 * - `auth: false` routes never touch the provider or handler.
 *
 * Only the fetch boundary is stubbed; the real request() pipeline runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ApiError,
  ReleasedOverwriteError,
  generateStage,
  getMe,
  getTenant,
  quickStartSeason,
  setAuthLostHandler,
  setTokenProvider,
} from './api';

const SESSION_EXPIRED = 'Your session has expired — please sign in again.';

const okResponse = (body = {}) => ({ ok: true, status: 200, json: async () => body });
const errResponse = (status, body) => ({
  ok: false,
  status,
  statusText: 'error',
  json: async () => body,
});

let onAuthLost;

beforeEach(() => {
  (globalThis as any).window ??= { location: { origin: 'http://localhost' } };
  globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;
  onAuthLost = vi.fn();
  setAuthLostHandler(onAuthLost);
  setTokenProvider(async () => 'test-token');
});

describe('request auth contract', () => {
  it('attaches the bearer token to authed requests', async () => {
    await getMe();
    const [, init] = (fetch as any).mock.calls[0];
    expect(init.headers.authorization).toBe('Bearer test-token');
  });

  it('null token (session gone): throws friendly 401, fires handler, never hits the network', async () => {
    setTokenProvider(async () => null);
    const err = await getMe().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.message).toBe(SESSION_EXPIRED);
    expect(onAuthLost).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('provider throw (transient network error): propagates without signing the user out', async () => {
    setTokenProvider(async () => {
      throw new Error('Network error');
    });
    await expect(getMe()).rejects.toThrow('Network error');
    expect(onAuthLost).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('server-side 401: fires handler and replaces the raw API copy', async () => {
    (fetch as any).mockResolvedValueOnce(errResponse(401, { error: 'missing bearer token' }));
    const err = await getMe().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.message).toBe(SESSION_EXPIRED);
    expect(onAuthLost).toHaveBeenCalled();
  });

  it('non-401 errors keep the API copy and leave the session alone', async () => {
    (fetch as any).mockResolvedValueOnce(errResponse(409, { error: 'version conflict' }));
    const err = await getMe().catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.message).toBe('version conflict');
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it('a clash-gate 409 carries the structured clashes on err.details', async () => {
    // The gate returns `{ error, code: 'venue_clash', clashes }` — everything besides
    // error/code is preserved on `details` so the fixture editor can point at the exact
    // conflict without re-parsing the response.
    const clashes = [
      { fixtureId: 'f2', ground: 'Kingsmead', date: '2026-09-27', with: { seriesId: 'A' } },
    ];
    (fetch as any).mockResolvedValueOnce(
      errResponse(409, { error: 'Change blocked — 1 venue clash', code: 'venue_clash', clashes }),
    );
    const err = await getMe().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('venue_clash');
    expect(err.details?.clashes).toEqual(clashes);
    // error/code are pulled out of the body, not duplicated onto details.
    expect(err.details?.error).toBeUndefined();
    expect(err.details?.code).toBeUndefined();
  });

  it('public routes (auth: false) never touch the token provider or handler', async () => {
    const provider = vi.fn(async () => 'test-token');
    setTokenProvider(provider);
    (fetch as any).mockResolvedValueOnce(errResponse(401, { error: 'missing bearer token' }));
    const err = await getTenant().catch((e) => e);
    expect(provider).not.toHaveBeenCalled();
    expect(onAuthLost).not.toHaveBeenCalled();
    expect(err.message).toBe('missing bearer token');
    const [, init] = (fetch as any).mock.calls[0];
    expect(init.headers.authorization).toBeUndefined();
  });
});

describe('quickStartSeason', () => {
  it('POSTs the request body to /season-runs/quick-start and returns the server payload', async () => {
    const payload = {
      run: { id: 'run-1' },
      competitionId: 'cmp_1',
      structureId: 'st_1',
      calendarId: 'cal_1',
    };
    (fetch as any).mockResolvedValueOnce(okResponse(payload));
    const body = {
      leagueKey: 'premier-men',
      templateId: 'flat-round-robin',
      seasonLabel: '2026/27',
      calendar: { label: '2026/27', start: '2026-09-13', end: '2027-03-28' },
    };
    const res = await quickStartSeason(body);
    const [url, init] = (fetch as any).mock.calls[0];
    expect(new URL(url).pathname).toBe('/season-runs/quick-start');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(body);
    expect(res).toEqual(payload);
  });

  it('passes the server coverage warnings through when present', async () => {
    const warning =
      '2026/27: Block 2 (17 Jan 2027 → 26 Mar 2027) — no competition on this calendar uses it';
    (fetch as any).mockResolvedValueOnce(
      okResponse({
        run: { id: 'run-1' },
        competitionId: 'cmp_1',
        structureId: 'st_1',
        calendarId: 'cal_1',
        warnings: [warning],
      }),
    );
    const res = await quickStartSeason({
      leagueKey: 'premier-men',
      templateId: 'flat-round-robin',
      seasonLabel: '2026/27',
      calendar: { id: 'cal_1' },
    });
    expect(res.warnings).toEqual([warning]);
  });
});

describe('generateStage', () => {
  it('POSTs the version (and confirmation) to the stage generate route and returns the payload', async () => {
    const payload = { run: { id: 'run-1', version: 4 }, series: [{ id: 's-run-1-pools-g1' }] };
    (fetch as any).mockResolvedValueOnce(okResponse(payload));
    const body = { version: 3, confirmReleasedOverwrite: true as const };
    const res = await generateStage('run-1', 'pools', body);
    const [url, init] = (fetch as any).mock.calls[0];
    expect(new URL(url).pathname).toBe('/season-runs/run-1/stages/pools/generate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(body);
    expect(res).toEqual(payload);
  });

  it('a released_overwrite 409 rejects as ReleasedOverwriteError naming the series', async () => {
    (fetch as any).mockResolvedValueOnce(
      errResponse(409, {
        error:
          "1 of this stage's series has been released — confirm to replace the published fixtures",
        code: 'released_overwrite',
        seriesIds: ['s-run-1-pools-g1'],
      }),
    );
    const err = await generateStage('run-1', 'pools', { version: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(ReleasedOverwriteError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.seriesIds).toEqual(['s-run-1-pools-g1']);
  });

  it('any other 409 (a clash-gate refusal) stays a plain ApiError with its details', async () => {
    const clashes = [
      { fixtureId: 'f1', ground: 'A Oval', date: '2026-09-12', with: { seriesId: 'x' } },
    ];
    (fetch as any).mockResolvedValueOnce(
      errResponse(409, { error: 'Change blocked — 1 venue clash', code: 'venue_clash', clashes }),
    );
    const err = await generateStage('run-1', 'pools', { version: 3 }).catch((e) => e);
    expect(err).not.toBeInstanceOf(ReleasedOverwriteError);
    expect(err.code).toBe('venue_clash');
    expect(err.details?.clashes).toEqual(clashes);
  });
});
