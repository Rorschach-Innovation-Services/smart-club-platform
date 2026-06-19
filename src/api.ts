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

import { devAuthHeader } from './devAuth';
import type {
  TenantConfig,
  TutorialVideo,
  UserProfile,
  Club,
  PlayerRegistration,
  PlayerClearance,
  Series,
  SendResult,
} from './types';

const BASE = import.meta.env.VITE_API_URL ?? '';
const LOCAL_AUTH = import.meta.env.VITE_LOCAL_AUTH === '1';

let _tenant: string | null = null;
let _getToken: () => Promise<string | null> = async () => null;

/** Set by config.js once the tenant slug is resolved. */
export function setActiveTenant(slug: string) {
  _tenant = slug;
}
export function getActiveTenant(): string | null {
  return _tenant;
}

/** Set by the AuthProvider so requests can attach the current ID token. */
export function setTokenProvider(fn: () => Promise<string | null>) {
  _getToken = fn;
}

/**
 * Set by the AuthProvider; called when an authed request finds no session (or the
 * API rejects the token) so the UI can revalidate and fall back to the login
 * screen. Must be idempotent — query retries can fire it several times per expiry.
 */
let _onAuthLost: (() => void) | null = null;
export function setAuthLostHandler(fn: (() => void) | null) {
  _onAuthLost = fn;
}

const SESSION_EXPIRED = 'Your session has expired — please sign in again.';

export class ApiError extends Error {
  status: number;
  // Optional machine-readable discriminator from the error body (e.g. club
  // signup's 'name_taken') so callers can branch on more than the status.
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
  query?: Record<string, string | number | null | undefined>;
}

async function request<T = any>(
  path: string,
  { method = 'GET', body, auth = true, query }: RequestOptions = {},
): Promise<T> {
  const url = new URL(BASE + path, BASE || window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
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
    let code: string | undefined;
    try {
      const data = await res.json();
      message = data.error || message;
      code = data.code;
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
    throw new ApiError(res.status, message, code);
  }
  // No current backend route emits 204; kept for forward-compat (callers of a
  // future 204 route should type T to include null).
  if (res.status === 204) return null as T;
  return res.json();
}

// ── Tenant config ──
// Email validation — kept identical to the backend EMAIL_RE (index.ts) so a value
// that passes the form can't be rejected by the API.
export const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;
// ZA cell normalization — kept identical to the backend normalizer in index.ts so
// a value that passes the form can't be rejected by the API. Accepts local
// (083…) and international (+27/27) forms with spaces/dashes/dots/parens; returns
// the canonical stored form `0XXXXXXXXX` (what waNumber/toE164 expect) or null.
// The [6-8] range is a deliberate permissive SUPERSET of real mobile prefixes (it
// admits some non-mobile ranges like 080x/086/087) — don't "tighten" it; WhatsApp
// sends already skip undeliverable numbers, and false rejections cost signups.
export function normalizeZaCell(raw: unknown): string | null {
  const digits = String(raw ?? '').replace(/[\s\-().]/g, '');
  const m = digits.match(/^(?:\+?27|0)([6-8]\d{8})$/);
  return m ? `0${m[1]}` : null;
}
export const getTenant = () => request<TenantConfig>('/tenant', { auth: false });
// How-to-use-the-app tutorial videos ride the public /tenant payload (falls back to the
// backend default set). Thin accessor for the public Tutorials page.
export const getTutorials = async (): Promise<TutorialVideo[]> =>
  (await getTenant()).tutorials ?? [];
export const putTenantConfig = (patch: Partial<TenantConfig>) =>
  request<TenantConfig>('/tenant/config', { method: 'PUT', body: patch });
export const putSupportContact = ({ name, email }: { name: string; email: string }) =>
  request<TenantConfig>('/tenant/support', { method: 'PUT', body: { name, email } });

// ── Current user ──
export const getMe = () => request<UserProfile>('/me');
export const patchMe = (patch: Partial<UserProfile>) =>
  request<UserProfile>('/me', { method: 'PATCH', body: patch });

// ── Clubs ──
export const getClubs = () => request<Club[]>('/clubs');
export const getClub = (id: string) => request<Club>(`/clubs/${id}`);
export const patchClub = (id: string, patch: Partial<Club>) =>
  request<Club>(`/clubs/${id}`, { method: 'PATCH', body: patch });
// Admin-only hard delete: cascades players/docs/clearances and offboards reps
// server-side. Resolves to { ok, removed: { players, clearances, users } }.
export const deleteClub = (id: string) =>
  request<{ ok: boolean; removed: { players: number; clearances: number; users: number } }>(
    `/clubs/${id}`,
    { method: 'DELETE' },
  );
export const saveExco = (id: string, exco: Record<string, unknown>) =>
  request<Club>(`/clubs/${id}/exco`, { method: 'POST', body: exco });
export const generateRegLink = (id: string) =>
  request<{ token: string; createdAt: string }>(`/clubs/${id}/reg-link`, { method: 'POST' });
export const getDocUploadUrl = (id: string, key: string, contentType?: string) =>
  request<{ uploadUrl: string; objectKey: string; contentType: string }>(
    `/clubs/${id}/docs/${key}/upload-url`,
    {
      method: 'POST',
      body: contentType ? { contentType } : undefined,
    },
  );
export const markDocUploaded = (id: string, key: string, meta: Record<string, unknown>) =>
  request<Club>(`/clubs/${id}/docs/${key}`, { method: 'PATCH', body: meta });
// objectKey selects one of a multi-file doc's stored files (safeguarding);
// omitted for single-file docs.
export const getDocViewUrl = (id: string, key: string, objectKey?: string) =>
  request<{ viewUrl: string }>(`/clubs/${id}/docs/${key}/view-url`, {
    method: 'POST',
    body: objectKey ? { objectKey } : undefined,
  });
export const deleteDocFile = (id: string, key: string, objectKey: string) =>
  request<Club>(`/clubs/${id}/docs/${key}/file`, { method: 'DELETE', body: { objectKey } });
export const addClubNote = (id: string, text: string) =>
  request<Club>(`/clubs/${id}/notes`, { method: 'POST', body: { text } });
/**
 * Share the club's released fixtures with its registered players over the given
 * channels (['email'] | ['whatsapp'] | both). The schedule is built server-side; this
 * just selects channels. idempotencyKey makes a lost-response retry replay instead of
 * re-broadcasting. Resolves to { results: [{ channel, status, summary }] } — one
 * PII-free per-channel row whose `summary` carries the counts (e.g. "8 sent · 2 skipped").
 */
export const sendClubFixtures = (
  id: string,
  { channels, idempotencyKey }: { channels: string[]; idempotencyKey: string },
) =>
  request<{ results: SendResult[] }>(`/clubs/${id}/send-fixtures`, {
    method: 'POST',
    body: { channels, idempotencyKey },
  });

// ── Players (roster) ──
// Players now self-register via the public link (see register* below). The in-portal chair
// "Register player" form was retired, so its client wrappers (registerPlayer / id-doc
// upload + mark) were removed; the backend routes remain for any future re-introduction.
export const getPlayers = (clubId: string) =>
  request<PlayerRegistration[]>(`/clubs/${clubId}/players`);
export const getPlayerIdDocViewUrl = (clubId: string, naturalKey: string) =>
  request<{ viewUrl: string }>(`/clubs/${clubId}/players/${naturalKey}/id-doc/view-url`, {
    method: 'POST',
  });

// Rep-safe {id,name} list of sibling clubs (for clearance source/destination choice).
export const getClubDirectory = () => request<{ id: string; name: string }[]>('/clubs/directory');

// ── Player clearances (inter-club transfers) ──
// Returns { incoming, outbound } for a club: incoming = it must action (source),
// outbound = players moving to it (destination).
export const getClearances = (clubId: string) =>
  request<{ incoming: PlayerClearance[]; outbound: PlayerClearance[] }>(
    `/clubs/${clubId}/clearances`,
  );
// Destination club initiates: body { fromClubId, idNumber | playerNaturalKey, note? }.
export const createClearance = (toClubId: string, body: unknown) =>
  request<PlayerClearance>(`/clubs/${toClubId}/clearances`, { method: 'POST', body });
export const patchClearance = (fromClubId: string, clearanceId: string, body: unknown) =>
  request<PlayerClearance>(`/clubs/${fromClubId}/clearances/${clearanceId}`, {
    method: 'PATCH',
    body,
  });
export const getAllClearances = () => request<PlayerClearance[]>('/admin/clearances');
export const overrideClearance = (clearanceId: string, body: unknown) =>
  request<PlayerClearance>(`/admin/clearances/${clearanceId}/override`, { method: 'POST', body });

// ── Series ──
export const getSeriesList = () => request<Series[]>('/series');
export const createSeries = (series: unknown) =>
  request<Series>('/series', { method: 'POST', body: series });
export const patchSeries = (id: string, patch: unknown) =>
  request<Series>(`/series/${id}`, { method: 'PATCH', body: patch });
export const deleteSeriesReq = (id: string) => request(`/series/${id}`, { method: 'DELETE' });
export const duplicateSeriesReq = (id: string) =>
  request<Series>(`/series/${id}/duplicate`, { method: 'POST' });

// ── Users (admin) ──
// List every tenant user with role, club scope and sign-in status.
export const getUsers = () => request<any[]>('/admin/users');
/**
 * Provision an admin/rep for this tenant. The body carries { email, role, clubIds?, channels?,
 * link? } — channels selects email/WhatsApp sends and link is the tenant-origin login URL used
 * in the notification (and echoed back). Resolves to { sub, email, loginUrl, results? }.
 */
export const inviteUser = (body: unknown) =>
  request<{ sub: string; email: string; loginUrl: string; results?: SendResult[] }>(
    '/admin/users',
    { method: 'POST', body },
  );
export const patchUser = (sub: string, body: unknown) =>
  request(`/admin/users/${sub}`, { method: 'PATCH', body });
export const removeUser = (sub: string) => request(`/admin/users/${sub}`, { method: 'DELETE' });
export const resendInvite = (sub: string) =>
  request(`/admin/users/${sub}/resend`, { method: 'POST' });

// ── Club self-registration link (admin) ──
// One tenant-wide link clubs use to register themselves (/signup?t=<token>).
// Generating replaces any prior token — the old link stops working immediately.
export const getClubSignupLink = () => request('/admin/club-signup-link');
export const generateClubSignupLink = () => request('/admin/club-signup-link', { method: 'POST' });
export const revokeClubSignupLink = () => request('/admin/club-signup-link', { method: 'DELETE' });

// ── Public registration ──
export const getRegistration = (clubId: string, token: string) =>
  request(`/register/${clubId}`, { auth: false, query: { t: token } });
export const submitRegistration = (clubId: string, token: string, body: unknown) =>
  request(`/register/${clubId}`, { method: 'POST', auth: false, query: { t: token }, body });
// Token-scoped presign for the self-registering player's ID document (no auth). Returns
// { uploadUrl, objectKey, contentType }; PUT the file via uploadToPresigned, then send the
// resulting { objectKey, size, contentType } as idDocMeta on submitRegistration.
export const getRegistrationIdDocUploadUrl = (clubId: string, token: string, contentType: string) =>
  request<{ uploadUrl: string; objectKey: string; contentType: string }>(
    `/register/${clubId}/id-doc/upload-url`,
    {
      method: 'POST',
      auth: false,
      query: { t: token },
      body: { contentType },
    },
  );

// ── Public club signup (the tenant-wide self-registration link) ──
export const getClubSignup = (token: string) =>
  request('/club-signup', { auth: false, query: { t: token } });
export const submitClubSignup = (token: string, body: unknown) =>
  request('/club-signup', { method: 'POST', auth: false, query: { t: token }, body });

/**
 * Upload a file directly to a presigned S3 URL (not the API). The content-type must
 * match what the URL was signed with — compliance docs and player ID docs both sign
 * with the file's own type, so pass the contentType echoed by the upload-url route.
 */
export async function uploadToPresigned(
  uploadUrl: string,
  file: Blob,
  contentType = 'application/pdf',
) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: file,
  });
  if (!res.ok) throw new ApiError(res.status, 'upload failed');
}
