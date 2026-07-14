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

import { Sentry } from './sentry';
import { devAuthHeader } from './devAuth';
import type {
  TenantConfig,
  TenantBranding,
  TenantSummary,
  TutorialVideo,
  UserProfile,
  Club,
  PlayerRegistration,
  PlayerClearance,
  RegistrationReview,
  League,
  Series,
  SendResult,
  LogoUploadPost,
  DnsSheet,
  TenantOverview,
} from './types';

/**
 * Resolve the API base URL for the current host. Each vanity web host has its
 * own API host (the API resolves tenant from ITS OWN Host header), mapped via
 * VITE_API_HOST_MAP (JSON, baked by sst.config.ts from infra/tenants.ts). An
 * unmapped host (dev, bare CloudFront) falls back to VITE_API_URL — dolphins
 * prod maps to the same URL VITE_API_URL carries, so behavior is unchanged.
 */
export function apiBase(): string {
  // Malformed map → {} (safe: falls back to VITE_API_URL). console.error so a
  // prod misconfiguration is debuggable — mirrors HOST_TENANT_MAP in config.ts.
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(import.meta.env.VITE_API_HOST_MAP ?? '{}');
  } catch (e) {
    console.error('VITE_API_HOST_MAP is not valid JSON; ignoring it', e);
  }
  const host = typeof window !== 'undefined' ? window.location?.hostname?.toLowerCase() : undefined;
  if (host && map[host]) return map[host];
  // Wildcard host `<slug>.club.medicoach.co.za` → the ONE shared API host (the API
  // resolves the tenant from this SPA's Origin header). Checked after the explicit map
  // so a vanity host with its own API host still wins.
  const suffix = import.meta.env.VITE_WILDCARD_WEB_SUFFIX ?? '';
  const sharedApiUrl = import.meta.env.VITE_SHARED_API_URL ?? '';
  if (host && suffix && sharedApiUrl && host.endsWith(suffix)) return sharedApiUrl;
  return import.meta.env.VITE_API_URL ?? '';
}

const BASE = apiBase();
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
    const err = new ApiError(res.status, message, code);
    // Report genuine server failures (5xx) — these are real outages worth knowing
    // about even when a caller swallows the rejection. Expected 4xx (validation,
    // auth, 404, 409 conflicts) are intentionally excluded as normal UI flow.
    // No-op without a DSN.
    if (res.status >= 500) {
      Sentry.captureException(err, {
        tags: { api_path: path, api_method: method, http_status: res.status },
      });
    }
    throw err;
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
// Admin-only hard delete: cascades players/docs/clearances, strips the club from draft series,
// and offboards reps server-side. Resolves to { ok, removed: { players, clearances, users,
// series, seriesFailed } } — seriesFailed counts draft series left with the dead club after a
// version-conflict retry (re-run the delete to retry them).
export const deleteClub = (id: string) =>
  request<{
    ok: boolean;
    removed: {
      players: number;
      clearances: number;
      users: number;
      series: number;
      seriesFailed: number;
    };
  }>(`/clubs/${id}`, { method: 'DELETE' });
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
 * Audit a player-register export (who/when/rowCount/scope) — the .xlsx is built
 * client-side, so this only records the event. `erroredClubs` flags an "export all" run
 * where some rosters failed to load, so the trail never reads a partial file as complete.
 * Best-effort: callers fire-and-forget so a log failure never blocks the download.
 */
export const logPlayerExport = (body: {
  rowCount: number;
  scope: 'all' | 'filtered';
  erroredClubs?: number;
}) => request<{ ok: boolean }>('/admin/export-log', { method: 'POST', body });
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
// Chair removes a player from their own roster (hard delete; purges the ID doc). 409 if the
// player is mid-transfer.
export const deletePlayer = (clubId: string, naturalKey: string) =>
  request(`/clubs/${clubId}/players/${encodeURIComponent(naturalKey)}`, { method: 'DELETE' });

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
// Union reject on the clubs' behalf: body { fromClubId, version?, reason? }. Restores the
// source player; removes a registration-origin clearance's pending destination row.
export const rejectClearance = (clearanceId: string, body: unknown) =>
  request<PlayerClearance>(`/admin/clearances/${clearanceId}/reject`, { method: 'POST', body });

// ── Registration reviews (off-system alerts + cross-club holds) ──
// A club's inbound cross-club holds it must accept/decline (off-system alerts are admin-only).
export const getRegistrationReviews = (clubId: string) =>
  request<RegistrationReview[]>(`/clubs/${clubId}/registration-reviews`);
// Accept a hold (materializes the player, opening a clearance to the previous club if found).
export const acceptRegistrationReview = (clubId: string, reviewId: string, body: unknown) =>
  request<RegistrationReview>(`/clubs/${clubId}/registration-reviews/${reviewId}/accept`, {
    method: 'POST',
    body,
  });
// Decline a hold (discards the parked registration; purges the uploaded ID doc).
export const declineRegistrationReview = (clubId: string, reviewId: string, body: unknown) =>
  request<RegistrationReview>(`/clubs/${clubId}/registration-reviews/${reviewId}/decline`, {
    method: 'POST',
    body,
  });
// Admin: every review in the tenant (off-system alerts to action + holds shown read-only).
export const getAllRegistrationReviews = () =>
  request<RegistrationReview[]>('/admin/registration-reviews');
// Admin acknowledges an off-system alert: body { destClubId, version? }.
export const ackRegistrationReview = (reviewId: string, body: unknown) =>
  request<RegistrationReview>(`/admin/registration-reviews/${reviewId}/ack`, {
    method: 'POST',
    body,
  });

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
// Correct a mistyped email for a not-yet-signed-in member, then re-send the invite.
// Resolves to { sub, email, status, results? } — results carries the auto-resend outcome.
export const changeUserEmail = (sub: string, email: string) =>
  request<{ sub: string; email: string; status: string; results?: SendResult[] }>(
    `/admin/users/${sub}/email`,
    { method: 'PATCH', body: { email } },
  );

// ── Club self-registration link (admin) ──
// One tenant-wide link clubs use to register themselves (/signup?t=<token>).
// Generating replaces any prior token — the old link stops working immediately.
export const getClubSignupLink = () => request('/admin/club-signup-link');
export const generateClubSignupLink = () => request('/admin/club-signup-link', { method: 'POST' });
export const revokeClubSignupLink = () => request('/admin/club-signup-link', { method: 'DELETE' });

// ── Public registration ──
// `clubs` = sibling clubs for the previous-club dropdown (absent on older backends —
// the page falls back to a free-text field).
export const getRegistration = (clubId: string, token: string) =>
  request<{
    tenant: string;
    clubId: string;
    clubName: string;
    leagues: League[];
    // Tenant district list for the form's picker (absent on older backends —
    // the page falls back to the shared constant).
    districts?: string[];
    clubs?: { id: string; name: string }[];
  }>(`/register/${clubId}`, { auth: false, query: { t: token } });
// `clearance` present ⇔ the registration opened a transfer from the named previous club
// (the player is pending until that club or the union office approves). `held` present ⇔
// the player chose a current club different from the link club, so the registration is
// parked for that club's chair to accept before it lands on the roster (`destClubName`
// names the club they'll be asked to approve). Body may include `currentClubId`.
export const submitRegistration = (clubId: string, token: string, body: unknown) =>
  request<{
    ok: boolean;
    clearance?: { fromClubName: string };
    held?: boolean;
    destClubName?: string;
  }>(`/register/${clubId}`, {
    method: 'POST',
    auth: false,
    query: { t: token },
    body,
  });
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

// ── Platform operator portal (/platform/*) ──
// Operator-only routes (membership {tenantId:'*', role:'operator'}); tenant-independent,
// so :slug names the target tenant explicitly. All errors are { error: string }.
export const platformListTenants = () => request<TenantSummary[]>('/platform/tenants');
export const platformCreateTenant = (body: {
  slug: string;
  branding: Partial<TenantBranding> & { name: string };
  submissionDeadline: string;
  features?: Record<string, boolean>;
}) => request<TenantConfig>('/platform/tenants', { method: 'POST', body });
export const platformGetTenant = (slug: string) =>
  request<TenantConfig>(`/platform/tenants/${encodeURIComponent(slug)}`);
// PUT merge-patches only branding / features / submissionDeadline; each key present
// REPLACES that key wholesale (same shallow merge as PUT /tenant/config), so callers
// must send the full branding object, not a fragment.
export const platformUpdateTenant = (slug: string, patch: Partial<TenantConfig>) =>
  request<TenantConfig>(`/platform/tenants/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    body: patch,
  });
// Idempotent per email: re-granting an existing admin succeeds with the same sub.
export const platformAddAdmin = (slug: string, email: string) =>
  request<{ tenant: string; email: string; sub: string; adminCount: number }>(
    `/platform/tenants/${encodeURIComponent(slug)}/admins`,
    { method: 'POST', body: { email } },
  );
// contentType must be image/png | image/svg+xml | image/webp (≤ 1 MB, 300s expiry).
// The grant is a presigned POST — submit via uploadLogoToS3, then persist publicUrl
// as branding.logoUrl through platformUpdateTenant.
export const platformLogoUploadUrl = (slug: string, contentType: string) =>
  request<LogoUploadPost>(`/platform/tenants/${encodeURIComponent(slug)}/logo-upload`, {
    method: 'POST',
    body: { contentType },
  });
export const platformDnsSheet = (slug: string) =>
  request<DnsSheet>(`/platform/tenants/${encodeURIComponent(slug)}/dns`);
// Operator "setup complete" milestone (D6) — informational, reversible. Returns the
// updated config (setupCompletedAt present ⇒ done; DELETE clears it, reopening setup).
export const platformCompleteSetup = (slug: string) =>
  request<TenantConfig>(`/platform/tenants/${encodeURIComponent(slug)}/setup-complete`, {
    method: 'POST',
  });
export const platformReopenSetup = (slug: string) =>
  request<TenantConfig>(`/platform/tenants/${encodeURIComponent(slug)}/setup-complete`, {
    method: 'DELETE',
  });
// Read-only breakdown payload for the per-client overview page. Clubs are the
// sanitized InsightsClub projection — never the full Club records.
export const platformTenantOverview = (slug: string) =>
  request<TenantOverview>(`/platform/tenants/${encodeURIComponent(slug)}/overview`);

/**
 * Submit a logo to S3 via the presigned POST grant (not the API — plain fetch, no
 * auth headers). Policy fields must all ride along and the file part must be LAST:
 * S3 ignores form fields after the file, so a trailing file is the only valid order.
 */
export async function uploadLogoToS3(post: LogoUploadPost, file: Blob) {
  const form = new FormData();
  for (const [k, v] of Object.entries(post.fields)) form.append(k, v);
  form.append('file', file);
  const res = await fetch(post.url, { method: 'POST', body: form });
  // S3 POST errors are XML, not JSON — log the raw body for debugging (best-effort)
  // and surface a stable message with the status.
  if (!res.ok) {
    try {
      console.error('logo upload failed', res.status, await res.text());
    } catch {
      // body unreadable — the status alone will have to do
    }
    throw new ApiError(res.status, `logo upload failed (${res.statusText || res.status})`);
  }
}

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
