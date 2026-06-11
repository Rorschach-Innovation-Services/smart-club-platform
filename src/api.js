/**
 * Authed, tenant-aware API client for the Smart Club Platform.
 *
 * Every request carries the Cognito ID token (Authorization: Bearer) and the
 * tenant (x-tenant in dev; the host carries it in prod). The token provider,
 * auth-lost handler, and active tenant are injected by the auth/config modules to
 * avoid React imports here. Non-2xx responses throw ApiError carrying the status
 * (used to surface 409 version conflicts and 403 authorization failures in the
 * UI); a missing/rejected token additionally triggers the auth-lost handler so
 * the app can fall back to the login screen.
 */

import { devAuthHeader } from './devAuth.js';

const BASE = import.meta.env.VITE_API_URL ?? '';
const LOCAL_AUTH = import.meta.env.VITE_LOCAL_AUTH === '1';

let _tenant = null;
let _getToken = async () => null;

/** Set by config.js once the tenant slug is resolved. */
export function setActiveTenant(slug) {
  _tenant = slug;
}
export function getActiveTenant() {
  return _tenant;
}

/** Set by the AuthProvider so requests can attach the current ID token. */
export function setTokenProvider(fn) {
  _getToken = fn;
}

/**
 * Set by the AuthProvider; called when an authed request finds no session (or the
 * API rejects the token) so the UI can revalidate and fall back to the login
 * screen. Must be idempotent — query retries can fire it several times per expiry.
 */
let _onAuthLost = null;
export function setAuthLostHandler(fn) {
  _onAuthLost = fn;
}

const SESSION_EXPIRED = 'Your session has expired — please sign in again.';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, auth = true, query } = {}) {
  const url = new URL(BASE + path, BASE || window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, v);
    }
  }
  const headers = { 'content-type': 'application/json' };
  if (_tenant) headers['x-tenant'] = _tenant;
  if (auth) {
    if (LOCAL_AUTH) {
      // Local dev: send the dev identity instead of a Cognito token.
      const dev = devAuthHeader();
      if (dev) headers['x-dev-auth'] = dev;
    } else {
      // The provider returns null only when the session is definitively gone
      // (it rethrows transient refresh errors) — don't send an unauthenticated
      // request the API will 401 anyway; surface the expiry instead.
      const token = await _getToken();
      if (token == null) {
        _onAuthLost?.();
        throw new ApiError(401, SESSION_EXPIRED);
      }
      headers.authorization = `Bearer ${token}`;
    }
  }
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      message = data.error || message;
    } catch {
      /* non-JSON error body */
    }
    // Token present but rejected (expired/revoked server-side): revalidate the
    // session, and replace the API's raw copy ("missing bearer token") with the
    // same friendly message as the pre-flight check — it's what callers surface.
    // The handler only signs out if the local session is really gone, so a
    // systemic 401 (e.g. config mismatch) can't cause a sign-in loop.
    if (res.status === 401 && auth && !LOCAL_AUTH) {
      _onAuthLost?.();
      message = SESSION_EXPIRED;
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Tenant config ──
// Email validation — kept identical to the backend EMAIL_RE (index.ts) so a value
// that passes the form can't be rejected by the API.
export const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;
export const getTenant = () => request('/tenant', { auth: false });
export const putTenantConfig = (patch) => request('/tenant/config', { method: 'PUT', body: patch });
export const putSupportContact = ({ name, email }) =>
  request('/tenant/support', { method: 'PUT', body: { name, email } });

// ── Current user ──
export const getMe = () => request('/me');
export const patchMe = (patch) => request('/me', { method: 'PATCH', body: patch });

// ── Clubs ──
export const getClubs = () => request('/clubs');
export const getClub = (id) => request(`/clubs/${id}`);
export const onboardClub = (spec) => request('/clubs', { method: 'POST', body: spec });
export const bulkOnboardClubs = (specs) => request('/clubs/bulk', { method: 'POST', body: specs });
export const patchClub = (id, patch) => request(`/clubs/${id}`, { method: 'PATCH', body: patch });
export const saveExco = (id, exco) => request(`/clubs/${id}/exco`, { method: 'POST', body: exco });
export const setPaid = (id, paid) =>
  request(`/clubs/${id}/paid`, { method: 'PATCH', body: { paid } });
export const setProgression = (id, progressionMode) =>
  request(`/clubs/${id}/progression`, { method: 'PATCH', body: { progressionMode } });
export const generateRegLink = (id) => request(`/clubs/${id}/reg-link`, { method: 'POST' });
export const getDocUploadUrl = (id, key) =>
  request(`/clubs/${id}/docs/${key}/upload-url`, { method: 'POST' });
export const markDocUploaded = (id, key, meta) =>
  request(`/clubs/${id}/docs/${key}`, { method: 'PATCH', body: meta });
export const getDocViewUrl = (id, key) =>
  request(`/clubs/${id}/docs/${key}/view-url`, { method: 'POST' });
export const addClubNote = (id, text) =>
  request(`/clubs/${id}/notes`, { method: 'POST', body: { text } });
/**
 * Send the onboarding invite to the club's chair over the given channels
 * (['email'] | ['whatsapp'] | both). The link is built from the caller's own origin
 * so it stays correct per-tenant; idempotencyKey makes a lost-response retry replay
 * instead of double-sending. Resolves to { results: [{ channel, status, error? }] }.
 */
export const sendClubInvite = (id, { channels, link, idempotencyKey }) =>
  request(`/clubs/${id}/send-invite`, {
    method: 'POST',
    body: { channels, link, idempotencyKey },
  });
/**
 * Share the club's released fixtures with its registered players over the given
 * channels (['email'] | ['whatsapp'] | both). The schedule is built server-side; this
 * just selects channels. idempotencyKey makes a lost-response retry replay instead of
 * re-broadcasting. Resolves to { results: [{ channel, status, summary }] } — one
 * PII-free per-channel row whose `summary` carries the counts (e.g. "8 sent · 2 skipped").
 */
export const sendClubFixtures = (id, { channels, idempotencyKey }) =>
  request(`/clubs/${id}/send-fixtures`, {
    method: 'POST',
    body: { channels, idempotencyKey },
  });

// ── Players (roster) ──
export const getPlayers = (clubId) => request(`/clubs/${clubId}/players`);
export const registerPlayer = (clubId, body) =>
  request(`/clubs/${clubId}/players`, { method: 'POST', body });
export const getPlayerIdDocUploadUrl = (clubId, naturalKey, contentType) =>
  request(`/clubs/${clubId}/players/${naturalKey}/id-doc/upload-url`, {
    method: 'POST',
    body: { contentType },
  });
export const markPlayerIdDoc = (clubId, naturalKey, meta) =>
  request(`/clubs/${clubId}/players/${naturalKey}/id-doc`, { method: 'PATCH', body: meta });
export const getPlayerIdDocViewUrl = (clubId, naturalKey) =>
  request(`/clubs/${clubId}/players/${naturalKey}/id-doc/view-url`, { method: 'POST' });

// Rep-safe {id,name} list of sibling clubs (for clearance source/destination choice).
export const getClubDirectory = () => request('/clubs/directory');

// ── Player clearances (inter-club transfers) ──
// Returns { incoming, outbound } for a club: incoming = it must action (source),
// outbound = players moving to it (destination).
export const getClearances = (clubId) => request(`/clubs/${clubId}/clearances`);
// Destination club initiates: body { fromClubId, idNumber | playerNaturalKey, note? }.
export const createClearance = (toClubId, body) =>
  request(`/clubs/${toClubId}/clearances`, { method: 'POST', body });
export const patchClearance = (fromClubId, clearanceId, body) =>
  request(`/clubs/${fromClubId}/clearances/${clearanceId}`, { method: 'PATCH', body });
export const getAllClearances = () => request('/admin/clearances');
export const overrideClearance = (clearanceId, body) =>
  request(`/admin/clearances/${clearanceId}/override`, { method: 'POST', body });

// ── Series ──
export const getSeriesList = () => request('/series');
export const createSeries = (series) => request('/series', { method: 'POST', body: series });
export const patchSeries = (id, patch) =>
  request(`/series/${id}`, { method: 'PATCH', body: patch });
export const deleteSeriesReq = (id) => request(`/series/${id}`, { method: 'DELETE' });
export const duplicateSeriesReq = (id) => request(`/series/${id}/duplicate`, { method: 'POST' });

// ── Users (admin) ──
// List every tenant user with role, club scope and sign-in status.
export const getUsers = () => request('/admin/users');
/**
 * Provision an admin/rep for this tenant. The body carries { email, role, clubIds?, channels?,
 * link? } — channels selects email/WhatsApp sends and link is the tenant-origin login URL used
 * in the notification (and echoed back). Resolves to { sub, email, loginUrl, results? }.
 */
export const inviteUser = (body) => request('/admin/users', { method: 'POST', body });
export const patchUser = (sub, body) => request(`/admin/users/${sub}`, { method: 'PATCH', body });
export const removeUser = (sub) => request(`/admin/users/${sub}`, { method: 'DELETE' });
export const resendInvite = (sub) => request(`/admin/users/${sub}/resend`, { method: 'POST' });

// ── Public registration ──
export const getRegistration = (clubId, token) =>
  request(`/register/${clubId}`, { auth: false, query: { t: token } });
export const submitRegistration = (clubId, token, body) =>
  request(`/register/${clubId}`, { method: 'POST', auth: false, query: { t: token }, body });

/**
 * Upload a file directly to a presigned S3 URL (not the API). The content-type must
 * match what the URL was signed with (compliance docs sign as application/pdf; player
 * ID docs sign as the file's image/PDF type — pass it explicitly there).
 */
export async function uploadToPresigned(uploadUrl, file, contentType = 'application/pdf') {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: file,
  });
  if (!res.ok) throw new ApiError(res.status, 'upload failed');
}
