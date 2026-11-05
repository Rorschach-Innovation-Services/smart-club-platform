/**
 * Player document requests (admin console "Request ID document").
 *
 * An admin selects players; each reachable adult gets an email + WhatsApp carrying a personal
 * signed link (`/d/<token>`) to a public page where they upload the document, which lands on
 * their row exactly as a console upload would (`idDocMeta`). ID document only for now, but the
 * request and the message are parameterised by `docKey` + display name.
 *
 * Records: `DOCREQ#<naturalKey>#<docKey>` (one per player + doc) and the token pointer
 * `DOCREQLINK#<requestId>` in the tenant's DOCREQ partition (keys.ts). The token carries only
 * the random `requestId` — never the natural key (it is derived from the ID number).
 *
 * Link lifecycle: a resend to a PENDING request extends its expiry and re-signs (the old token
 * keeps verifying until its own `e`); a COMPLETED request gets a fresh one. A request dies when
 * the document arrives by ANY path (this link, or the console's PATCH id-doc), and a link whose
 * player is no longer at the stored club (deleted, erased, moved) is terminally invalid — a
 * request does not follow a moved player.
 *
 * PII: the natural key never leaves the server (not in links, S3 keys, logs or responses); the
 * public page gets the first name and branding only. Stored send results drop addresses.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from './auth.js';
import { orgCopy } from './branding.js';
import type * as RepoNs from './repo.js';
import type {
  DocRequest,
  DocRequestLink,
  PlayerRegistration,
  SendResult,
  TenantConfig,
} from './types.js';

type RepoModule = typeof RepoNs;

// ───────────────────────── Catalogue ─────────────────────────

/** Documents a request can ask for. Adding one needs no new Meta template (docName is {{3}}). */
export const DOC_REQUEST_DOCS: Record<string, { name: string }> = {
  idDoc: { name: 'ID document' },
};

/** How long a freshly signed link works. */
export const DOC_REQUEST_LINK_DAYS = 14;

/** Public presigns per link per hour (a player retrying a few photos, never a flood). */
export const DOC_REQUEST_UPLOADS_PER_HOUR = 10;

export const MAX_ID_DOC_BYTES = 5 * 1024 * 1024; // 5 MB — same cap as the console route
export const ID_DOC_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);

// ───────────────────────── Link tokens (domain-separated) ─────────────────────────

export interface DocRequestLinkPayload {
  /** tenant */
  t: string;
  /** request id (random uuid) */
  q: string;
  /** expiry, epoch seconds */
  e: number;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** `docreq-link.v1.` prefix: a squad or captain's-report token never verifies here. */
function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(`docreq-link.v1.${payload}`).digest();
}

export function signDocRequestLinkToken(p: DocRequestLinkPayload, secret: string): string {
  const payload = b64url(JSON.stringify(p));
  return `${payload}.${b64url(mac(secret, payload))}`;
}

/** Valid up to and including `e`, expired after. */
export function docRequestLinkExpired(nowMs: number, e: number): boolean {
  return nowMs / 1000 > e;
}

export type DocRequestTokenCheck =
  | { ok: true; payload: DocRequestLinkPayload }
  | { ok: false; reason: 'invalid' | 'expired' };

export function verifyDocRequestLinkToken(
  token: string,
  secret: string,
  nowMs: number,
): DocRequestTokenCheck {
  if (typeof token !== 'string' || token.length > 600) return { ok: false, reason: 'invalid' };
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return { ok: false, reason: 'invalid' };
  const expected = mac(secret, payload);
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: 'invalid' };
  let p: DocRequestLinkPayload;
  try {
    p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!p || typeof p.t !== 'string' || typeof p.q !== 'string' || typeof p.e !== 'number')
    return { ok: false, reason: 'invalid' };
  if (docRequestLinkExpired(nowMs, p.e)) return { ok: false, reason: 'expired' };
  return { ok: true, payload: p };
}

// ───────────────────────── Send-side rules ─────────────────────────

const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;

export type DocRequestSendStatus =
  | 'sent'
  | 'failed'
  | 'skipped_minor'
  | 'skipped_no_contact'
  | 'skipped_whatsapp_unavailable'
  | 'skipped_not_found';

/**
 * Pre-send reachability (no DOCREQ is created for a skip). Minors are never contacted directly;
 * a player with neither email nor cell has no channel; a cell-only player has none while
 * WhatsApp is off for the tenant or its template is not approved.
 */
export function docRequestSkipReason(
  player: Pick<PlayerRegistration, 'isMinor' | 'email' | 'cell'>,
  whatsappUsable: boolean,
  hasCell: (cell: string | undefined) => boolean,
): DocRequestSendStatus | null {
  if (player.isMinor) return 'skipped_minor';
  const email = EMAIL_RE.test((player.email ?? '').trim());
  const cell = hasCell(player.cell);
  if (!email && !cell) return 'skipped_no_contact';
  if (!email && !whatsappUsable) return 'skipped_whatsapp_unavailable';
  return null;
}

/**
 * Aggregate one player's channel results: any channel sent ⇒ `sent`; every channel skipped ⇒
 * `skipped_whatsapp_unavailable` when the WhatsApp leg was the template gate, else
 * `skipped_no_contact`; otherwise `failed`.
 */
export function aggregateDocRequestStatus(
  results: SendResult[],
  templatePendingError: string,
): DocRequestSendStatus {
  if (results.some((r) => r.status === 'sent')) return 'sent';
  if (results.length && results.every((r) => r.status === 'skipped')) {
    return results.some((r) => r.channel === 'whatsapp' && r.error === templatePendingError)
      ? 'skipped_whatsapp_unavailable'
      : 'skipped_no_contact';
  }
  return 'failed';
}

/** "Thu 19 Nov 2026" in SAST (every tenant is South African — ADR 0008). */
export function fmtDocRequestExpiry(iso: string): string {
  return new Date(Date.parse(iso)).toLocaleDateString('en-ZA', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Africa/Johannesburg',
  });
}

// ───────────────────────── Public link: resolve ─────────────────────────

export type LinkedDocRequest = {
  tenant: string;
  request: DocRequest;
  link: DocRequestLink;
  player: PlayerRegistration;
};

/**
 * Resolve a token to its live request + player. Throws HttpError with a machine-readable
 * `kind`: 404 `invalid` (bad signature, unknown/re-minted request, cancelled, or the player is
 * no longer at the stored club), 410 `expired`. A COMPLETED request resolves (state
 * `completed`) so the page can say so; callers that write must check `request.status`.
 */
export async function loadLinkedDocRequest(
  repo: Pick<RepoModule, 'getDocRequestLink' | 'getDocRequest' | 'getPlayer'>,
  token: string,
  nowMs: number,
  secret: string,
): Promise<LinkedDocRequest> {
  const invalid = () => new HttpError(404, 'this link is not valid', { kind: 'invalid' });
  const check = verifyDocRequestLinkToken(token, secret, nowMs);
  if (!check.ok) {
    if (check.reason === 'expired')
      throw new HttpError(410, 'this link has expired', { kind: 'expired' });
    throw invalid();
  }
  const { t: tenant, q: requestId } = check.payload;
  const link = await repo.getDocRequestLink(tenant, requestId);
  if (!link) throw invalid();
  const request = await repo.getDocRequest(tenant, link.naturalKey, link.docKey);
  // A re-minted request (a completed one re-requested) has a new id: the old link is dead.
  if (!request || request.requestId !== requestId || request.status === 'cancelled')
    throw invalid();
  // Moved / deleted / erased: the request dies with the club row; it never follows the player.
  const player = await repo.getPlayer(tenant, request.clubId, request.naturalKey);
  if (!player) throw invalid();
  return { tenant, request, link, player };
}

/** The public page payload: first name, the doc, branding and the state. Never a key. */
export function docRequestLinkPayload(
  found: LinkedDocRequest,
  cfg: TenantConfig | null,
  clubName: string,
) {
  const { tenant, request, player } = found;
  return {
    state: request.status === 'completed' ? ('completed' as const) : ('pending' as const),
    firstName: player.firstName,
    docName: request.docName,
    clubName,
    linkExpiresAt: request.linkExpiresAt,
    maxBytes: MAX_ID_DOC_BYTES,
    tenantBranding: {
      name: cfg ? orgCopy(cfg).name : tenant,
      logoUrl: cfg?.branding?.logoUrl ?? '',
      colors: cfg?.branding?.colors ?? {},
    },
  };
}

// ───────────────────────── Public link: complete ─────────────────────────

export interface DocRequestUploadDeps {
  repo: Pick<RepoModule, 'getPlayer' | 'updatePlayer' | 'completeDocRequest'>;
  /** The stored object's REAL size + content type (S3 HEAD / local stat), or null if absent. */
  headObject: (objectKey: string) => Promise<{ size: number; contentType: string } | null>;
  /** Best-effort object delete (S3 / local sink). */
  deleteObject: (objectKey: string) => Promise<void>;
  now: () => string;
  isVersionConflict: (err: unknown) => boolean;
}

/** The only object keys a link may record: this tenant + club's `player-id-` prefix. */
export function docRequestObjectKeyOk(tenant: string, clubId: string, objectKey: string): boolean {
  const re = /^player-id-[0-9a-f-]{36}\.(jpg|png|pdf)$/;
  for (const prefix of [`${tenant}/${clubId}/`, `local/${tenant}/${clubId}/`]) {
    if (objectKey.startsWith(prefix) && re.test(objectKey.slice(prefix.length))) return true;
  }
  return false;
}

/**
 * Record an uploaded document on the player through a link. Anonymous route, so nothing the
 * client asserts is trusted: the key must be this club's `player-id-` key, and size + type come
 * from the stored object itself. Refuses (409 `on_file`) when a document arrived by another path
 * after the request was made — a live link never overwrites it — and completes the request.
 * The write is version-conditioned and retried once on a conflict (an anonymous page cannot ask
 * the player to refetch); the REPLACED object is deleted only AFTER the write succeeds.
 */
export async function completeDocRequestUpload(
  deps: DocRequestUploadDeps,
  found: LinkedDocRequest,
  objectKey: unknown,
): Promise<PlayerRegistration> {
  const { tenant, request } = found;
  if (request.status !== 'pending')
    throw new HttpError(409, 'this request is already complete', { kind: 'completed' });
  if (typeof objectKey !== 'string' || !docRequestObjectKeyOk(tenant, request.clubId, objectKey))
    throw new HttpError(400, 'objectKey does not belong to this request');
  const head = await deps.headObject(objectKey);
  if (!head) throw new HttpError(400, 'upload not found — please try again');
  if (head.size <= 0 || head.size > MAX_ID_DOC_BYTES || !ID_DOC_TYPES.has(head.contentType)) {
    await deps.deleteObject(objectKey);
    throw new HttpError(400, 'file must be a non-empty image (JPG/PNG) or PDF under 5 MB');
  }

  for (let attempt = 0; ; attempt++) {
    const player = await deps.repo.getPlayer(tenant, request.clubId, request.naturalKey);
    if (!player) {
      await deps.deleteObject(objectKey);
      throw new HttpError(404, 'this link is not valid', { kind: 'invalid' });
    }
    const current = player.idDocMeta;
    // Staleness guard: a document that arrived (any path) after the request was made wins.
    if (current?.uploadedAt && current.uploadedAt > request.createdAt) {
      await deps.deleteObject(objectKey);
      await deps.repo.completeDocRequest(tenant, request.naturalKey, request.docKey, {
        at: deps.now(),
        via: 'console',
        requestId: request.requestId,
      });
      throw new HttpError(409, 'your document is already on file', { kind: 'on_file' });
    }
    let updated: PlayerRegistration;
    try {
      updated = await deps.repo.updatePlayer(tenant, request.clubId, request.naturalKey, {
        idDocMeta: {
          objectKey,
          size: head.size,
          contentType: head.contentType,
          uploadedAt: deps.now(),
        },
        version: player.version,
      });
    } catch (err) {
      if (deps.isVersionConflict(err) && attempt === 0) continue;
      if (deps.isVersionConflict(err))
        throw new HttpError(409, 'your registration changed — please try again');
      throw err;
    }
    // Delete the replaced object only now the new pointer is durable (POPIA minimisation).
    const prevKey = current?.objectKey;
    if (prevKey && prevKey !== objectKey) {
      try {
        await deps.deleteObject(prevKey);
      } catch (err) {
        console.warn('doc-request: failed to delete the replaced ID document', err);
      }
    }
    await deps.repo.completeDocRequest(tenant, request.naturalKey, request.docKey, {
      at: deps.now(),
      via: 'link',
      requestId: request.requestId,
    });
    return updated;
  }
}
