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
import { ApiError, getMe, getTenant, setAuthLostHandler, setTokenProvider } from './api';

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
  globalThis.window ??= { location: { origin: 'http://localhost' } };
  globalThis.fetch = vi.fn(async () => okResponse());
  onAuthLost = vi.fn();
  setAuthLostHandler(onAuthLost);
  setTokenProvider(async () => 'test-token');
});

describe('request auth contract', () => {
  it('attaches the bearer token to authed requests', async () => {
    await getMe();
    const [, init] = fetch.mock.calls[0];
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
    fetch.mockResolvedValueOnce(errResponse(401, { error: 'missing bearer token' }));
    const err = await getMe().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.message).toBe(SESSION_EXPIRED);
    expect(onAuthLost).toHaveBeenCalled();
  });

  it('non-401 errors keep the API copy and leave the session alone', async () => {
    fetch.mockResolvedValueOnce(errResponse(409, { error: 'version conflict' }));
    const err = await getMe().catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.message).toBe('version conflict');
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it('public routes (auth: false) never touch the token provider or handler', async () => {
    const provider = vi.fn(async () => 'test-token');
    setTokenProvider(provider);
    fetch.mockResolvedValueOnce(errResponse(401, { error: 'missing bearer token' }));
    const err = await getTenant().catch((e) => e);
    expect(provider).not.toHaveBeenCalled();
    expect(onAuthLost).not.toHaveBeenCalled();
    expect(err.message).toBe('missing bearer token');
    const [, init] = fetch.mock.calls[0];
    expect(init.headers.authorization).toBeUndefined();
  });
});
