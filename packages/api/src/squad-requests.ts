/**
 * Pre-match captain squad-selection links (2026-10-27 plan, Group A).
 *
 * On the morning of the day before a synced fixture (the 08:00–midnight SAST squad notice
 * window, `SQUAD_NOTICE_HOUR` — earlier than captain's reports' 18:00; no match-day sends),
 * each side's recipient gets a link (`/sq/<token>`) to tick the match squad from the club's
 * registered roster. The submission is pushed to medicoach as contract §8 (`medicoach-sync/squads.ts`),
 * where it prefills the scorer's start-scoring squad.
 *
 * Recipient ladder (per TEAM — a multi-team club's `tm_` sides never share a captain):
 *   1. the club's designated captain for the team (`TEAMCAPTAIN#`);
 *   2. the team's last known captain (`TEAMLASTCAPT#`, written when a captain's report
 *      resolves its captain and when a squad is submitted with a captain) — NEVER the stored
 *      results / CAPREPORT rows, which carry no player ref (POPIA);
 *   3. the club chair, who can "Send to captain" (max 3 forwards).
 * Rungs 1–2 re-resolve the player's contact FRESH (roster row, veterans affiliation, minor,
 * erasure and no-contact checks — `resolvePlayerContact`).
 *
 * Deliberate divergence from captain's reports: a SUBMITTED request stays loadable and
 * editable until its link expires (23:59:59 SAST on match day) — squads change late. Every
 * save carries `expectedModified` (CAS; 409 to a stale tab), and every submit re-queues the
 * idempotent §8 upsert (last `submittedAt` wins at medicoach).
 *
 * Gates: the tenant flag `preMatchSquadLinks` (default off), the squad notice window, the
 * medicoach go-live date — and the caller: these steps run only inside `runTenantSync`, which
 * itself only runs for `medicoachSync` tenants.
 *
 * PII: natural keys (hashed ID numbers) live on TEAMCAPTAIN#/TEAMLASTCAPT# rows and in a
 * request's `selection`; they are never served (the page gets opaque HMAC ids), never put in
 * a token and never logged. Log lines carry request ids and counts only. A provider error's
 * TEXT (an SES message can embed the recipient's address) never reaches Sentry or a durable
 * row: SQUADOPEN# `lastError` and the give-up Sentry extra carry only the error NAME (or a
 * message this module built), and the repo masks + caps whatever it persists.
 *
 * SQUADOPEN# ownership: the marker is create-if-absent. Once one exists for a request the
 * retry pass owns it — the opener neither resets its attempt count nor sends for it again — so
 * the SQUAD_OPEN_MAX_ATTEMPTS give-up is reachable and a recipient gets at most one attempt
 * per run. A given-up marker stays as a `gaveUpAt` tombstone (no sends) until the retry pass
 * drops it too-old, so the opener cannot re-arm it. A side the opener's deadline cuts short still gets its marker (no send), so the
 * retry pass picks it up instead of the side silently never opening.
 *
 * Growth: `voidChangedSquadRequests` and the admin list scan the whole SQUADREQ# prefix per
 * sync run and rows have no TTL — acceptable at current volumes, revisit if a tenant's season
 * exceeds a few thousand requests.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isSlotRef } from '../../engine/src/formats.js';
import { formatWeekdayDayYear } from '../../../src/dates.js';
import { orgCopy } from './branding.js';
import {
  contactOnly,
  deliveryOf,
  fmtExpiry,
  hasContact,
  liveFixtureVenue,
  MAX_FORWARDS,
  pastDeadline,
  resolvePlayerContact,
  sideName,
  type NoticeResult,
} from './captains-reports.js';
import { chairContactOf } from './club-contacts.js';
import { captainsReportLinkBase, captainsReportLinkSecret } from './env.js';
import { hasFeature } from './features.js';
import { refs } from './medicoach-bundle.js';
import { fixtureSyncRef } from './fixture-identity.js';
import { seriesMappedForSync } from './medicoach-sync/schedule.js';
import { toE164 } from './notify/e164.js';
import { noticeWindowOverride } from './notice-window.js';
import { WHATSAPP_TEMPLATES } from './notify/whatsapp-templates.js';
import { isWithheld, projectSeriesForClub } from './series-projection.js';
import { TENANT_UTC_OFFSET_MINUTES, tenantDate } from './tenant-time.js';
import type {
  CaptainsReportDelivery,
  Club,
  PlayerRegistration,
  Series,
  SquadRequest,
  SquadSelection,
  TenantConfig,
} from './types.js';

type RepoModule = typeof import('./repo.js');

/** SQUADOPEN# retries before giving up with Sentry. */
export const SQUAD_OPEN_MAX_ATTEMPTS = 5;
/** Max selected players, and max guests, per squad (contract §8). */
export const SQUAD_MAX = 60;
const NAME_MAX = 120;

const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;
const DAY_MS = 24 * 3600 * 1000;

/**
 * Squad links go out from this hour, SAST wall clock, until midnight on the day BEFORE the
 * match (the first sync at/after 08:00 delivers): the morning gives a captain the whole day to
 * pick. Match-day sends are deliberately never attempted. Captain's reports keep their own
 * 18:00 gate (`REPORT_NOTICE_HOUR`). Global, not per tenant — every tenant is South African
 * (TENANT_UTC_OFFSET_MINUTES, no DST).
 */
export const SQUAD_NOTICE_HOUR = 8;

/** True from 08:00:00 to 23:59:59 SAST (pure). */
export function isSquadNoticeWindowOpen(now: Date): boolean {
  const local = new Date(now.getTime() + TENANT_UTC_OFFSET_MINUTES * 60_000);
  return local.getUTCHours() >= SQUAD_NOTICE_HOUR;
}

/**
 * The gate the squad opener and the SQUADOPEN# retry pass check. Honours the squads slot of
 * the notice-window test override (`notice-window.ts`), so the e2e hook can force it alone.
 */
export function squadNoticeWindowOpen(now: Date): boolean {
  return (noticeWindowOverride('squads') ?? isSquadNoticeWindowOpen)(now);
}

/** The tenant flag (default off). */
export function squadLinksEnabled(config: TenantConfig | null | undefined): boolean {
  return hasFeature(config, 'preMatchSquadLinks', false);
}

// ───────────────────────── Ids ─────────────────────────

/**
 * Id parts are restricted to this alphabet. Team ids are a club id slug or a
 * `tm_<clubId>_<leagueKey>_<n>` id (catalogue.ts / lions-fixture-map.ts) — neither carries
 * `~` — and a side whose id fails this check is skipped (never opened), so the `~` join is
 * unambiguous.
 */
const ID_PART_RE = /^[A-Za-z0-9_.:-]+$/;

export const isSafeIdPart = (p: string) => ID_PART_RE.test(p);

/** `<seriesId>~<fixtureId>~<teamId>` — one per fixture side. */
export function squadRequestId(seriesId: string, fixtureId: string, teamId: string): string {
  return `${seriesId}~${fixtureId}~${teamId}`;
}

export function parseSquadRequestId(
  id: string,
): { seriesId: string; fixtureId: string; teamId: string } | null {
  const parts = id.split('~');
  if (parts.length !== 3 || !parts.every((p) => ID_PART_RE.test(p))) return null;
  const [seriesId, fixtureId, teamId] = parts;
  return { seriesId, fixtureId, teamId };
}

// ───────────────────────── Link tokens (domain-separated) ─────────────────────────

export interface SquadLinkPayload {
  /** tenant */
  t: string;
  /** recipient memberId (opaque, random) */
  r: string;
  /** squad request id */
  q: string;
  /** expiry, epoch seconds */
  e: number;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** `squad-link.v1.` prefix: a captain's-report token (`capreport-link.v1.`) never verifies. */
function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(`squad-link.v1.${payload}`).digest();
}

export function signSquadLinkToken(p: SquadLinkPayload, secret: string): string {
  const payload = b64url(JSON.stringify(p));
  return `${payload}.${b64url(mac(secret, payload))}`;
}

/** THE expiry comparator (token + resend): valid up to and including `e`, expired after. */
export function squadLinkExpired(nowMs: number, e: number): boolean {
  return nowMs / 1000 > e;
}

export type SquadTokenCheck =
  | { ok: true; payload: SquadLinkPayload }
  | { ok: false; reason: 'invalid' | 'expired' };

export function verifySquadLinkToken(
  token: string,
  secret: string,
  nowMs: number,
): SquadTokenCheck {
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
  let p: SquadLinkPayload;
  try {
    p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (
    !p ||
    typeof p.t !== 'string' ||
    typeof p.r !== 'string' ||
    typeof p.q !== 'string' ||
    typeof p.e !== 'number'
  )
    return { ok: false, reason: 'invalid' };
  if (squadLinkExpired(nowMs, p.e)) return { ok: false, reason: 'expired' };
  return { ok: true, payload: p };
}

/**
 * 23:59:59 SAST on the match day, epoch seconds. The link is valid AT this instant and expired
 * from the next second on (`squadLinkExpired`).
 *
 * SAST tripwire: TENANT_UTC_OFFSET_MINUTES is a single GLOBAL 120 (ADR 0008 — every tenant is
 * South African). A non-SA tenant would silently get a SAST expiry here; give tenants their
 * own offset before onboarding one.
 */
export function squadLinkExpiry(matchDate: string): number {
  return Math.floor(
    (Date.parse(`${matchDate}T23:59:59Z`) - TENANT_UTC_OFFSET_MINUTES * 60_000) / 1000,
  );
}

const expirySeconds = (r: Pick<SquadRequest, 'linkExpiresAt' | 'matchDate'>) => {
  const ms = Date.parse(r.linkExpiresAt);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : squadLinkExpiry(r.matchDate);
};

export function squadLink(tenant: string, req: SquadRequest, secret: string, base: string) {
  const token = signSquadLinkToken(
    { t: tenant, r: req.recipient.memberId, q: req.id, e: expirySeconds(req) },
    secret,
  );
  return { token, url: `${base}/sq/${token}` };
}

/** YYYY-MM-DD `days` after `date`. */
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// ───────────────────────── Roster (opaque ids) ─────────────────────────

/** An opaque, request-scoped handle for a roster player: the natural key never leaves. */
export function squadRosterId(
  secret: string,
  tenant: string,
  requestId: string,
  naturalKey: string,
): string {
  return createHmac('sha256', secret)
    .update(`squad-roster.v1|${tenant}|${requestId}|${naturalKey}`)
    .digest('base64url')
    .slice(0, 22);
}

export interface SquadRosterEntry {
  id: string;
  name: string;
  /** Server-only. */
  key: string;
  /** Server-only. */
  row: PlayerRegistration;
}

const fullName = (p: { firstName?: string; lastName?: string }) =>
  `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim();

/**
 * The whole club's active registered roster (every team of a multi-team club — players move
 * between sides), MINORS INCLUDED (names only — the recorded POPIA decision, unlike the
 * forward picker). A veterans side expands through its VETAFFIL# affiliations to each
 * player's row at their PRIMARY club (`listPlayers` on a veterans club returns nobody).
 */
export async function squadRoster(
  repo: RepoModule,
  tenant: string,
  req: Pick<SquadRequest, 'id' | 'clubId'>,
  secret: string,
): Promise<SquadRosterEntry[]> {
  const rows = new Map<string, PlayerRegistration>();
  for (const p of await repo.listPlayers(tenant, req.clubId))
    if ((p.status ?? 'active') === 'active') rows.set(p.naturalKey, p);
  for (const aff of await repo.listVeteransAffiliations(tenant, req.clubId)) {
    if (rows.has(aff.naturalKey)) continue;
    const p = await repo.getPlayer(tenant, aff.primaryClubId, aff.naturalKey);
    if (p && (p.status ?? 'active') === 'active') rows.set(p.naturalKey, p);
  }
  return [...rows.values()]
    .map((row) => ({
      id: squadRosterId(secret, tenant, req.id, row.naturalKey),
      name: fullName(row),
      key: row.naturalKey,
      row,
    }))
    .filter((e) => e.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ───────────────────────── Captain candidates (opaque ids) ─────────────────────────

/** Scope of a designation picker's ids: never equals a request id (those are UUIDs). */
const captainScope = (teamId: string) => `team-captain:${teamId}`;

export interface CaptainCandidate extends SquadRosterEntry {
  /** True when the player is a veterans affiliate (their row lives at a primary club). */
  affiliate: boolean;
}

/**
 * Who a club team's captain can be: the squad-link roster (own active players + VETAFFIL#
 * affiliates), with the same HMAC id construction scoped to the team instead of a request —
 * deterministic per tenant + team + player, so a PUT resolves by recompute-and-match.
 */
export async function captainCandidates(
  repo: RepoModule,
  tenant: string,
  clubId: string,
  teamId: string,
  secret: string,
): Promise<CaptainCandidate[]> {
  const roster = await squadRoster(repo, tenant, { id: captainScope(teamId), clubId }, secret);
  return roster.map((e) => ({ ...e, affiliate: e.row.clubId !== clubId }));
}

/** The opaque id a designated captain is served under (GET / PUT responses). */
export const captainCandidateId = (
  secret: string,
  tenant: string,
  teamId: string,
  naturalKey: string,
) => squadRosterId(secret, tenant, captainScope(teamId), naturalKey);

// ───────────────────────── Views ─────────────────────────

export type SquadRequestView = Omit<
  SquadRequest,
  'recipient' | 'recipientContact' | 'chairMemberId' | 'deliveries' | 'selection'
> & {
  recipient: { kind: SquadRequest['recipient']['kind']; name: string; forwardedBy?: unknown };
  deliveries?: Array<Omit<CaptainsReportDelivery, 'messageId'>>;
  /** Names only (admin) or roster ids + names (link page) — never natural keys. */
  selection?: {
    players: Array<{ id?: string; name: string }>;
    guests: Array<{ name: string }>;
    captainId?: string;
    captainName?: string;
  };
};

/**
 * What leaves the server: never the memberId, the contact, the chair's kept link, a provider
 * message id or a natural key. `secret` + `tenant` turn the selection into roster ids (link
 * page); without them the selection is names only (admin console).
 */
export function squadRequestView(
  r: SquadRequest,
  ids?: { secret: string; tenant: string },
): SquadRequestView {
  const { memberId: _m, ...recipient } = r.recipient;
  const { recipientContact: _rc, chairMemberId: _c, deliveries, selection, ...rest } = r;
  const idOf = (key: string) =>
    ids ? squadRosterId(ids.secret, ids.tenant, r.id, key) : undefined;
  const captain = selection?.captainKey
    ? selection.players.find((p) => p.key === selection.captainKey)
    : undefined;
  return {
    ...rest,
    recipient,
    ...(deliveries ? { deliveries: deliveries.map(({ messageId: _id, ...d }) => d) } : {}),
    ...(selection
      ? {
          selection: {
            players: selection.players.map((p) => ({
              ...(ids ? { id: idOf(p.key) } : {}),
              name: p.name,
            })),
            guests: selection.guests,
            ...(captain && ids ? { captainId: idOf(captain.key) } : {}),
            ...(captain ? { captainName: captain.name } : {}),
          },
        }
      : {}),
  };
}

// ───────────────────────── Notices ─────────────────────────

export interface SquadNotice {
  tenant: string;
  requestId: string;
  purpose: 'opened' | 'forwarded';
  recipientKind: 'captain' | 'chair';
  to: { name: string; email?: string; cell?: string };
  ccEmail?: string;
  clubName: string;
  matchLine: string;
  matchDateText: string;
  orgName: string;
  expiresText: string;
  token: string;
  url: string;
  channels: Array<'email' | 'whatsapp'>;
  forwardedBy?: string;
}

export interface SquadRequestDeps {
  repo: RepoModule;
  now?: () => Date;
  sendNotice?: (n: SquadNotice) => Promise<NoticeResult[]>;
  linkSecret?: () => string;
  linkBase?: () => string;
  log?: (line: string) => void;
  /** Wall-clock deadline (epoch ms); what is left stays queued for the next run. */
  deadlineMs?: number;
  /**
   * The `squad_selection_due` template status (default: the registry's). The WhatsApp leg is
   * offered only when it is `registered` — never tried-and-failed while Meta reviews it.
   */
  whatsappTemplateStatus?: () => string;
  /** Sentry capture (default: the Lambda's Sentry); injectable for tests. */
  captureException?: (
    err: Error,
    ctx: { tags: Record<string, string>; extra: Record<string, unknown> },
  ) => void;
}

/** An error's NAME (and a short code when it carries one) — never its message text. */
export function squadErrorName(err: unknown): string {
  if (!(err instanceof Error)) return 'squad open failed';
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && /^[\w.-]{1,40}$/.test(code) ? `${err.name}:${code}` : err.name;
}

let defaultSquadSender: (n: SquadNotice) => Promise<NoticeResult[]> = (n) => sendSquadNotice(n);

/** Replace the default sender (integration tests / local tooling). `undefined` restores it. */
export function setDefaultSquadNoticeSender(
  fn: ((n: SquadNotice) => Promise<NoticeResult[]>) | undefined,
): void {
  defaultSquadSender = fn ?? ((n) => sendSquadNotice(n));
}

/** SES email (+ chair cc) and the `squad_selection_due` WhatsApp template. */
export async function sendSquadNotice(n: SquadNotice): Promise<NoticeResult[]> {
  const { sendSquadSelectionDueEmail } = await import('./notify/email.js');
  const { sendSquadSelectionDueWhatsApp, WhatsAppTemplatePendingError } =
    await import('./notify/whatsapp.js');
  const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
  return Promise.all(
    n.channels.map(async (channel): Promise<NoticeResult> => {
      if (channel === 'email') {
        if (!n.to.email || !EMAIL_RE.test(n.to.email))
          return { channel, status: 'skipped', reason: 'no-email' };
        try {
          const { messageId } = await sendSquadSelectionDueEmail({
            to: n.to.email,
            ...(n.ccEmail ? { cc: n.ccEmail } : {}),
            recipientName: n.to.name,
            recipientKind: n.recipientKind,
            clubName: n.clubName,
            matchLine: n.matchLine,
            matchDateText: n.matchDateText,
            expiresText: n.expiresText,
            link: n.url,
            orgName: n.orgName,
            ...(n.forwardedBy ? { forwardedBy: n.forwardedBy } : {}),
          });
          return { channel, status: 'sent', messageId };
        } catch (err) {
          return { channel, status: 'failed', reason: 'send-failed', error: errMessage(err) };
        }
      }
      const e164 = toE164(n.to.cell);
      if (!e164) return { channel, status: 'skipped', reason: 'no-cell' };
      try {
        const { messageId } = await sendSquadSelectionDueWhatsApp({
          to: e164,
          recipientName: n.to.name,
          clubName: n.clubName,
          orgName: n.orgName,
          match: `${n.matchLine} on ${n.matchDateText}`,
          token: n.token,
        });
        return { channel, status: 'sent', messageId };
      } catch (err) {
        if (err instanceof WhatsAppTemplatePendingError)
          return { channel, status: 'skipped', reason: 'template-pending' };
        return { channel, status: 'failed', reason: 'send-failed', error: errMessage(err) };
      }
    }),
  );
}

/** Email always; WhatsApp only with `whatsappInvites` on AND the template registered. */
export function squadNoticeChannels(
  config: TenantConfig,
  templateStatus: string,
): Array<'email' | 'whatsapp'> {
  return hasFeature(config, 'whatsappInvites', true) && templateStatus === 'registered'
    ? ['email', 'whatsapp']
    : ['email'];
}

type NotifyOutcome = 'sent' | 'undelivered' | 'already' | 'failed' | 'deferred';

/**
 * Claim the squad NOTIFY# row (`recipient#<memberId>`), send, record. A notice that failed on
 * every channel releases its claim (the SQUADOPEN# retry sends again).
 */
async function notifySquadRecipient(
  deps: SquadRequestDeps,
  tenant: string,
  config: TenantConfig,
  req: SquadRequest,
  opts: {
    contact: { name: string; email?: string; cell?: string };
    ccChair: { email?: string } | null;
    purpose: 'opened' | 'forwarded';
    recipientKind: 'captain' | 'chair';
    forwardedBy?: string;
  },
): Promise<NotifyOutcome> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const secret = (deps.linkSecret ?? captainsReportLinkSecret)();
  const base = (deps.linkBase ?? captainsReportLinkBase)();
  const { token, url } = squadLink(tenant, req, secret, base);
  const audience = `recipient#${req.recipient.memberId}`;
  if (pastDeadline(deps.deadlineMs)) return 'deferred';
  if (!(await repo.claimSquadRequestNotify(tenant, req.id, audience))) return 'already';
  const { contact } = opts;
  const home = req.side === 'home' ? req.teamName : req.opponentName;
  const away = req.side === 'home' ? req.opponentName : req.teamName;
  const cc =
    opts.ccChair?.email && EMAIL_RE.test(opts.ccChair.email) && opts.ccChair.email !== contact.email
      ? opts.ccChair.email
      : undefined;
  const templateStatus = (
    deps.whatsappTemplateStatus ?? (() => String(WHATSAPP_TEMPLATES.squadSelectionDue.status))
  )();
  const notice: SquadNotice = {
    tenant,
    requestId: req.id,
    purpose: opts.purpose,
    recipientKind: opts.recipientKind,
    to: contact,
    ...(cc ? { ccEmail: cc } : {}),
    clubName: req.teamName,
    matchLine: `${home} v ${away}`,
    matchDateText: formatWeekdayDayYear(req.matchDate),
    orgName: orgCopy(config).name,
    expiresText: fmtExpiry(expirySeconds(req)),
    token,
    url,
    channels: squadNoticeChannels(config, templateStatus),
    ...(opts.forwardedBy ? { forwardedBy: opts.forwardedBy } : {}),
  };
  let results: NoticeResult[];
  if (!hasContact(contact)) {
    results = notice.channels.map((channel) => ({
      channel,
      status: 'skipped' as const,
      reason: 'no-contact' as const,
    }));
  } else {
    try {
      results = await (deps.sendNotice ?? defaultSquadSender)(notice);
    } catch (err) {
      results = notice.channels.map((channel) => ({
        channel,
        status: 'failed' as const,
        reason: 'send-failed' as const,
        error: err instanceof Error ? err.message : 'send failed',
      }));
    }
  }
  const at = now().toISOString();
  const deliveries = results.map((r) => deliveryOf(r, opts.purpose, opts.recipientKind, at));
  const delivered = deliveries.some((d) => d.status === 'sent');
  const failed = !delivered && deliveries.some((d) => d.status === 'failed');
  await repo.recordSquadRequestDeliveries(tenant, req, deliveries, {
    ...(delivered ? { notifiedAt: at } : {}),
  });
  // The status webhook finds the delivery through this ref (kind 'squad-request').
  for (const d of deliveries)
    if (d.channel === 'whatsapp' && d.status === 'sent' && d.messageId)
      await repo.putSquadWhatsAppMessageRef(d.messageId, {
        tenant,
        seriesId: req.seriesId,
        fixtureId: req.fixtureId,
        teamId: req.teamId,
      });
  if (failed) {
    await repo.releaseSquadRequestNotify(tenant, req.id, audience);
    return 'failed';
  }
  await repo.completeSquadRequestNotify(
    tenant,
    req.id,
    audience,
    results.map(({ channel, status, reason }) => ({
      channel,
      status,
      ...(reason ? { reason } : {}),
    })),
  );
  return delivered ? 'sent' : 'undelivered';
}

// ───────────────────────── Recipient ladder ─────────────────────────

export interface SquadRecipient {
  kind: 'captain' | 'chair';
  /** 'designated' | 'last-captain' | 'chair' — which rung answered. */
  rung: 'designated' | 'last-captain' | 'chair';
  contact: { name: string; email?: string; cell?: string };
}

/**
 * Designated captain → last known captain (per TEAM) → chair. A rung whose player is gone,
 * a minor or has no contact falls through. The natural key is used for the point-gets only.
 */
export async function resolveSquadRecipient(
  repo: RepoModule,
  tenant: string,
  club: Club,
  teamId: string,
): Promise<SquadRecipient> {
  const designated = await repo.getTeamCaptain(tenant, club.id, teamId);
  if (designated) {
    const c = await resolvePlayerContact(repo, tenant, club.id, designated.playerKey);
    if (c) return { kind: 'captain', rung: 'designated', contact: c };
  }
  const last = await repo.getTeamLastCaptain(tenant, club.id, teamId);
  if (last) {
    const c = await resolvePlayerContact(repo, tenant, club.id, last.naturalKey);
    if (c) return { kind: 'captain', rung: 'last-captain', contact: c };
  }
  return { kind: 'chair', rung: 'chair', contact: chairContactOf(club) };
}

// ───────────────────────── Opening ─────────────────────────

type StoredFixture = Record<string, unknown> & {
  id: string;
  date?: string;
  dateTbc?: boolean;
  status?: string;
  home?: string;
  away?: string;
  syncRef?: string;
};

export interface SquadOpenSummary {
  fixtures: number;
  opened: number;
  notified: number;
  failed: number;
  deferred: number;
  skipped: number;
  /** Markers that hit SQUAD_OPEN_MAX_ATTEMPTS in this pass (only set when non-zero). */
  gaveUp?: number;
  windowClosed?: true;
  disabled?: true;
}

const zeroSummary = (): SquadOpenSummary => ({
  fixtures: 0,
  opened: 0,
  notified: 0,
  failed: 0,
  deferred: 0,
  skipped: 0,
});

/** The fixture's live state as the squad flow judges it (null = gone). */
function liveFixture(series: Series | null, fixtureId: string): StoredFixture | null {
  return (
    ((series?.fixtures as StoredFixture[] | undefined) ?? []).find((f) => f?.id === fixtureId) ??
    null
  );
}

/** Cancelled, undated (dateTbc) or moved off `matchDate` ⇒ the request no longer stands. */
export function fixtureChanged(f: StoredFixture | null, matchDate: string): boolean {
  return !f || f.status === 'cancelled' || f.dateTbc === true || f.date !== matchDate;
}

/**
 * A request's fixture, judged for voiding. Only a CONFIRMED change voids: cancelled, TBC, or a
 * present date other than `matchDate` ⇒ 'changed'. A missing series / fixture or an absent
 * date is a transient read (a schedule rewrite mid-flight) ⇒ 'unknown': never void on it.
 */
export function squadFixtureState(
  f: StoredFixture | null,
  matchDate: string,
): 'ok' | 'changed' | 'unknown' {
  if (!f) return 'unknown';
  if (f.status === 'cancelled' || f.dateTbc === true) return 'changed';
  if (typeof f.date !== 'string' || !f.date) return 'unknown';
  return f.date === matchDate ? 'ok' : 'changed';
}

/** The `voidReason`s the void paths store. Only FIXTURE_CHANGED may ever self-heal. */
export const SQUAD_VOID_REASONS = {
  fixtureChanged: 'fixture changed',
  admin: 'voided by admin',
  expired: 'expired',
} as const;

/** A pending request whose opening notice never went out and is not settled (skipped). */
export function squadNoticeUnsettled(r: SquadRequest): boolean {
  return (
    r.status === 'pending' &&
    !r.notifiedAt &&
    !(r.deliveries ?? []).some((d) => d.status === 'skipped')
  );
}

interface SideTarget {
  tenant: string;
  config: TenantConfig;
  series: Series;
  fixture: StoredFixture;
  side: 'home' | 'away';
  matchDate: string;
}

/**
 * Open (or re-notify) ONE side's request. 'opened' / 'renotified' / 'skipped' (already
 * live and settled, no club, unsafe id). Throws when the notice failed on every channel, so
 * the caller keeps its SQUADOPEN# marker.
 */
async function openSquadForSide(
  t: SideTarget,
  deps: SquadRequestDeps,
): Promise<{ outcome: 'opened' | 'renotified' | 'skipped'; notice?: NotifyOutcome; id?: string }> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const { tenant, config, series, fixture, side } = t;
  const teamId = fixture[side];
  if (typeof teamId !== 'string' || !teamId || isSlotRef(teamId) || !isSafeIdPart(teamId))
    return { outcome: 'skipped' };
  const byTeam = new Map((series.participants ?? []).map((p) => [p.teamId, p]));
  const clubId = byTeam.get(teamId)?.clubId ?? teamId;
  const club = await repo.getClub(tenant, clubId);
  if (!club) return { outcome: 'skipped' };
  const seriesId = String(series.id);
  const id = squadRequestId(seriesId, fixture.id, teamId);
  const existing = await repo.getSquadRequest(tenant, seriesId, fixture.id, teamId);
  const chair = chairContactOf(club);

  if (existing && existing.status !== 'void') {
    // A live request: only an opening notice that never settled goes out again (the
    // NOTIFY# claim makes this safe); anything else is done.
    if (!squadNoticeUnsettled(existing)) return { outcome: 'skipped', id };
    const toCaptain = existing.recipient.kind === 'captain' && !!existing.recipientContact;
    const notice = await notifySquadRecipient(deps, tenant, config, existing, {
      contact: toCaptain ? { name: existing.recipient.name, ...existing.recipientContact } : chair,
      ccChair: toCaptain ? chair : null,
      purpose: existing.recipient.forwardedBy ? 'forwarded' : 'opened',
      recipientKind: toCaptain ? 'captain' : 'chair',
    });
    return { outcome: 'renotified', notice, id };
  }

  const other = side === 'home' ? 'away' : 'home';
  const otherTeam = typeof fixture[other] === 'string' ? (fixture[other] as string) : '';
  const otherClubId = byTeam.get(otherTeam)?.clubId ?? otherTeam;
  const otherClub =
    otherTeam && !isSlotRef(otherTeam) ? await repo.getClub(tenant, otherClubId) : null;
  const recipient = await resolveSquadRecipient(repo, tenant, club, teamId);
  const venue = isWithheld(series, 'venue') ? '' : (liveFixtureVenue(series, fixture.id) ?? '');
  const leagueKey = typeof series.leagueKey === 'string' ? series.leagueKey : '';
  const nowIso = now().toISOString();
  const req: SquadRequest = {
    id,
    seriesId,
    fixtureId: fixture.id,
    teamId,
    clubId: club.id,
    status: 'pending',
    fixtureRef: fixtureSyncRef(tenant, seriesId, fixture),
    ...(leagueKey ? { teamRef: refs.team(tenant, leagueKey, teamId) } : {}),
    matchDate: t.matchDate,
    side,
    clubName: club.name,
    teamName: sideName(series, teamId, club),
    opponentName: otherTeam ? sideName(series, otherTeam, otherClub) : 'TBC',
    competition: series.name ?? '',
    ...(venue ? { venue } : {}),
    recipient: { kind: recipient.kind, memberId: randomUUID(), name: recipient.contact.name },
    ...(recipient.kind === 'captain' ? { recipientContact: contactOnly(recipient.contact) } : {}),
    linkExpiresAt: new Date(squadLinkExpiry(t.matchDate) * 1000).toISOString(),
    modified: randomUUID(),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  if (!(await repo.openSquadRequestIfAbsent(tenant, req))) return { outcome: 'skipped', id };
  const notice = await notifySquadRecipient(deps, tenant, config, req, {
    contact: recipient.contact,
    ccChair: recipient.kind === 'captain' ? chair : null,
    purpose: 'opened',
    recipientKind: recipient.kind,
  });
  return { outcome: 'opened', notice, id };
}

/**
 * Open the squad requests of every fixture played TOMORROW (SAST) on released, sync-mapped
 * series: one per side, at most once (create-if-absent + NOTIFY# ledger). A SQUADOPEN#
 * marker is written before each side's opening and deleted once it notified, so a failure is
 * retried by `retryPendingSquadOpens` (on the marker's own target, never "tomorrow").
 */
export async function openPreMatchSquadRequests(
  tenant: string,
  config: TenantConfig,
  deps: SquadRequestDeps,
): Promise<SquadOpenSummary> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const sum = zeroSummary();
  if (!squadLinksEnabled(config)) return { ...sum, disabled: true };
  if (!squadNoticeWindowOpen(now())) return { ...sum, windowClosed: true };
  const goLive = config.integrations?.medicoach?.goLiveDate;
  const today = tenantDate(now());
  const tomorrow = addDays(today, 1);
  if (!goLive || tomorrow < goLive) return sum;

  const all = (await repo.listSeries(tenant)).filter(
    (s) => projectSeriesForClub(s, today) !== null,
  );
  for (const s of all) {
    const fixtures = ((s.fixtures as StoredFixture[] | undefined) ?? []).filter(
      (f) => f?.id && f.date === tomorrow,
    );
    if (!fixtures.length) continue;
    if (!(await seriesMappedForSync(repo, tenant, s, config))) continue;
    for (const f of fixtures) {
      sum.fixtures++;
      if (f.dateTbc === true || f.status === 'cancelled' || !isSafeIdPart(f.id)) {
        sum.skipped++;
        continue;
      }
      for (const side of ['home', 'away'] as const) {
        const teamId = f[side];
        if (typeof teamId !== 'string' || !teamId || isSlotRef(teamId) || !isSafeIdPart(teamId)) {
          sum.skipped++;
          continue;
        }
        const requestId = squadRequestId(String(s.id), f.id, teamId);
        const live = await repo.getSquadRequest(tenant, String(s.id), f.id, teamId);
        if (live && live.status !== 'void' && !squadNoticeUnsettled(live)) {
          sum.skipped++;
          continue;
        }
        // Create-if-absent: an existing marker belongs to the retry pass (which already ran
        // this sync) — never reset its attempts, never send for it a second time this run.
        const created = await repo.putSquadOpenMarker(tenant, {
          requestId,
          seriesId: String(s.id),
          fixtureId: f.id,
          teamId,
          matchDate: tomorrow,
          createdAt: now().toISOString(),
          attempts: 0,
        });
        if (!created) {
          sum.skipped++;
          continue;
        }
        // Out of time: the marker is written, so the next run's retry pass opens it.
        if (pastDeadline(deps.deadlineMs)) {
          sum.deferred++;
          continue;
        }
        await runMarker(
          tenant,
          requestId,
          { tenant, config, series: s, fixture: f, side, matchDate: tomorrow },
          deps,
          sum,
        );
      }
    }
  }
  if (sum.opened + sum.notified + sum.failed + sum.deferred)
    log(
      `[squad-links] ${tenant}: fixtures=${sum.fixtures} opened=${sum.opened} notified=${sum.notified} failed=${sum.failed} deferred=${sum.deferred} skipped=${sum.skipped}`,
    );
  return sum;
}

/** Run one marker's opening; settles the marker (delete / count a failure). */
async function runMarker(
  tenant: string,
  requestId: string,
  target: SideTarget,
  deps: SquadRequestDeps,
  sum: SquadOpenSummary,
): Promise<void> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  let error: string | null = null;
  try {
    const out = await openSquadForSide(target, deps);
    if (out.outcome === 'opened') sum.opened++;
    if (out.outcome === 'skipped') sum.skipped++;
    if (out.notice === 'sent') sum.notified++;
    if (out.notice === 'deferred') {
      sum.deferred++;
      return; // marker stays
    }
    if (out.notice === 'failed') error = 'squad notice failed on every channel';
  } catch (err) {
    error = squadErrorName(err);
  }
  if (!error) {
    await repo.deleteSquadOpenMarker(tenant, requestId);
    return;
  }
  sum.failed++;
  const attempts = await repo.markSquadOpenFailed(tenant, requestId, error, now().toISOString());
  if (attempts >= SQUAD_OPEN_MAX_ATTEMPTS) {
    // Kept as a tombstone (not deleted): the opener's create-if-absent must not re-arm it.
    await repo.markSquadOpenGaveUp(tenant, requestId, now().toISOString());
    sum.gaveUp = (sum.gaveUp ?? 0) + 1;
    console.error(`[squad-links] ${tenant} ${requestId}: gave up after ${attempts} attempts`);
    const capture =
      deps.captureException ?? (await import('./instrument.js')).Sentry.captureException;
    capture(new Error(`squad request could not be opened after ${attempts} attempts`), {
      tags: { tenant, job: 'squad-links' },
      extra: { requestId, lastError: error },
    });
  }
}

export interface SquadRetrySummary {
  retried: number;
  done: number;
  failed: number;
  gaveUp: number;
  /** Dropped because the day before the match has passed (`too-old`) or it changed. */
  dropped: number;
  deferred: number;
}

/**
 * Retry every SQUADOPEN# marker (each run). A retry acts on the marker's STORED target — the
 * fixture and match date it was written for, never "tomorrow" — and gives up `too-old` once
 * the day before the match has passed (match day or later): squad sends happen only on D-1.
 * A fixture that moved or was cancelled drops its marker.
 */
export async function retryPendingSquadOpens(
  tenant: string,
  deps: SquadRequestDeps,
): Promise<SquadRetrySummary> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const out: SquadRetrySummary = {
    retried: 0,
    done: 0,
    failed: 0,
    gaveUp: 0,
    dropped: 0,
    deferred: 0,
  };
  const markers = await repo.listSquadOpenMarkers(tenant);
  if (!markers.length) return out;
  if (!squadNoticeWindowOpen(now())) return { ...out, deferred: markers.length };
  const config = await repo.getTenantConfig(tenant);
  const today = tenantDate(now());
  for (const [i, m] of markers.entries()) {
    if (pastDeadline(deps.deadlineMs)) {
      out.deferred += markers.length - i;
      break;
    }
    const series = config ? await repo.getSeries(tenant, m.seriesId) : null;
    const fixture = liveFixture(series, m.fixtureId);
    const side = fixture?.home === m.teamId ? 'home' : fixture?.away === m.teamId ? 'away' : null;
    if (
      !config ||
      !squadLinksEnabled(config) ||
      // too-old: sends happen only on D-1. A match-day send is deliberately not attempted
      // (the link itself would still work until 23:59:59) — an admin resend covers exceptions.
      m.matchDate <= today ||
      !series ||
      !side ||
      fixtureChanged(fixture, m.matchDate)
    ) {
      await repo.deleteSquadOpenMarker(tenant, m.requestId);
      out.dropped++;
      continue;
    }
    if (m.gaveUpAt) continue; // a tombstone: given up, nothing more is sent
    out.retried++;
    const sum = zeroSummary();
    await runMarker(
      tenant,
      m.requestId,
      { tenant, config, series, fixture: fixture!, side, matchDate: m.matchDate },
      deps,
      sum,
    );
    if (sum.deferred) out.deferred++;
    else if (sum.gaveUp) out.gaveUp++;
    else if (sum.failed) out.failed++;
    else out.done++;
  }
  return out;
}

// ───────────────────────── Void on cancel / move ─────────────────────────

/** Queue a §8 `void` push for a request medicoach may hold a squad for. */
async function enqueueVoidPush(
  repo: RepoModule,
  tenant: string,
  req: SquadRequest,
  at: string,
): Promise<void> {
  await repo.putPendingSquadSync(tenant, {
    requestId: req.id,
    op: 'void',
    submittedAt: at,
    enqueuedAt: at,
    attempts: 0,
  });
}

/** Void one request because its fixture changed; a submitted one also queues the §8 void. */
export async function voidSquadRequestForFixtureChange(
  repo: RepoModule,
  tenant: string,
  req: SquadRequest,
  at: string,
): Promise<boolean> {
  const res = await repo.voidSquadRequest(tenant, req, SQUAD_VOID_REASONS.fixtureChanged, at);
  if (res === 'voided' && req.status === 'submitted') await enqueueVoidPush(repo, tenant, req, at);
  return res === 'voided';
}

/**
 * Admin void: mark a live request void (its links 410 from now on); a submitted one also
 * queues the §8 `void` push, exactly like a fixture-change void. 'none' when it was already
 * void or is gone.
 */
export async function adminVoidSquadRequest(
  repo: RepoModule,
  tenant: string,
  req: SquadRequest,
  at: string,
): Promise<'voided' | 'none'> {
  const res = await repo.voidSquadRequest(tenant, req, SQUAD_VOID_REASONS.admin, at);
  if (res === 'voided' && req.status === 'submitted') await enqueueVoidPush(repo, tenant, req, at);
  return res;
}

/**
 * Admin resend: re-notify the request's CURRENT recipient on a fresh `memberId`, so every
 * earlier link to them dies (410) and the NOTIFY# claim (`recipient#<memberId>`) is new —
 * at most one notice per resend. An un-forwarded request re-runs the recipient ladder (a
 * captain designated since opening, or a changed contact, is picked up); a forwarded one
 * keeps the chair's pick and its stored contact (there is no natural key to re-resolve).
 * Refused (409) once submitted, void or past its link expiry.
 */
export async function resendSquadRequest(
  deps: SquadRequestDeps,
  input: { tenant: string; request: SquadRequest },
): Promise<{ request: SquadRequest; notice: NotifyOutcome }> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const { tenant, request } = input;
  if (request.status === 'submitted')
    throw new SquadFlowError(409, 'this squad has already been submitted', 'submitted');
  if (request.status === 'void')
    throw new SquadFlowError(409, 'this squad request is void', 'void');
  if (squadLinkExpired(now().getTime(), expirySeconds(request)))
    throw new SquadFlowError(409, 'this squad link has expired', 'expired');
  const [club, config] = await Promise.all([
    repo.getClub(tenant, request.clubId),
    repo.getTenantConfig(tenant),
  ]);
  if (!club || !config) throw new SquadFlowError(404, 'squad request not found');
  const chair = chairContactOf(club);
  const forwarded = request.recipient.forwardedBy;
  let kind: 'captain' | 'chair';
  let contact: { name: string; email?: string; cell?: string };
  if (forwarded) {
    kind = 'captain';
    contact = { name: request.recipient.name, ...request.recipientContact };
  } else {
    const fresh = await resolveSquadRecipient(repo, tenant, club, request.teamId);
    kind = fresh.kind;
    contact = fresh.contact;
  }
  let updated: SquadRequest;
  try {
    updated = await repo.rotateSquadRequestRecipient(
      tenant,
      request,
      {
        recipient: {
          kind,
          memberId: randomUUID(),
          name: contact.name,
          ...(forwarded ? { forwardedBy: forwarded } : {}),
        },
        ...(kind === 'captain' ? { recipientContact: contactOnly(contact) } : {}),
      },
      { expectedMemberId: request.recipient.memberId },
    );
  } catch (err) {
    if (err instanceof repo.SquadRequestConflict)
      throw new SquadFlowError(409, 'the squad request changed meanwhile — try again');
    throw err;
  }
  const notice = await notifySquadRecipient(deps, tenant, config, updated, {
    contact,
    ccChair: kind === 'captain' ? chair : null,
    purpose: forwarded ? 'forwarded' : 'opened',
    recipientKind: kind,
    ...(forwarded ? { forwardedBy: forwarded.name } : {}),
  });
  const fresh = await repo.getSquadRequest(
    tenant,
    request.seriesId,
    request.fixtureId,
    request.teamId,
  );
  return { request: fresh ?? updated, notice };
}

/**
 * The schedule-change sweep, run every sync:
 *  - VOID: a live request (match today or later) whose fixture was CONFIRMED cancelled, made
 *    TBC or moved off its date is voided (a move to a future date lets that D-1 trigger reopen
 *    it), and a submitted one queues a §8 `void` so medicoach never prefills a stale squad
 *    under the same fixture id (a reschedule keeps the fixture id). A missing series / fixture
 *    or an absent date is a transient read and never voids (`squadFixtureState`).
 *  - SELF-HEAL: a request voided for a fixture change (and only that reason — never an admin
 *    void or an expiry) whose fixture again matches its ORIGINAL match date, today or later,
 *    is reopened in place: same recipient + memberId, so links already sent work again; no
 *    re-notice (the NOTIFY# ledger is untouched); a submitted one re-queues its §8 upsert.
 *    Works on match day — this is recovery, not a new send.
 *  - EXPIRE: a request still `pending` after its match day is settled void `expired` (no §8
 *    push — nothing was submitted — and no notice). Match day itself stays live.
 * Covers every schedule writer — admin edits, generate, CLIs and medicoach's own inbound
 * changes — in one place.
 */
export async function voidChangedSquadRequests(
  tenant: string,
  deps: Pick<SquadRequestDeps, 'repo' | 'now'>,
): Promise<{ voided: number; reopened: number; expired: number }> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const today = tenantDate(now());
  const all = await repo.listSquadRequests(tenant);
  const seriesCache = new Map<string, Series | null>();
  const fixtureOf = async (r: SquadRequest) => {
    if (!seriesCache.has(r.seriesId))
      seriesCache.set(r.seriesId, await repo.getSeries(tenant, r.seriesId));
    return liveFixture(seriesCache.get(r.seriesId) ?? null, r.fixtureId);
  };
  let voided = 0;
  let reopened = 0;
  let expired = 0;
  for (const r of all) {
    if (r.matchDate < today) {
      if (r.status !== 'pending') continue;
      const at = now().toISOString();
      if ((await repo.voidSquadRequest(tenant, r, SQUAD_VOID_REASONS.expired, at)) === 'voided')
        expired++;
      continue;
    }
    if (r.status === 'void') {
      if (r.voidReason !== SQUAD_VOID_REASONS.fixtureChanged) continue;
      if (squadFixtureState(await fixtureOf(r), r.matchDate) !== 'ok') continue;
      const at = now().toISOString();
      const healed = await repo.reopenSquadRequest(tenant, r, {
        reason: SQUAD_VOID_REASONS.fixtureChanged,
        status: r.submittedAt ? 'submitted' : 'pending',
        at,
      });
      if (!healed) continue;
      reopened++;
      if (healed.status === 'submitted')
        await repo.putPendingSquadSync(tenant, {
          requestId: r.id,
          op: 'upsert',
          submittedAt: at,
          enqueuedAt: at,
          attempts: 0,
        });
      continue;
    }
    if (squadFixtureState(await fixtureOf(r), r.matchDate) !== 'changed') continue;
    if (await voidSquadRequestForFixtureChange(repo, tenant, r, now().toISOString())) voided++;
  }
  return { voided, reopened, expired };
}

// ───────────────────────── The link ─────────────────────────

/** A refused squad action, with the HTTP status the route answers. */
export class SquadFlowError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 410 | 429,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SquadFlowError';
  }
}

/**
 * A link-safe request lookup. Unlike the captain's report, a SUBMITTED request loads (and
 * stays editable) until the link expires. 404 bad token; 410 expired / void / re-addressed;
 * every load re-reads the fixture — CONFIRMED cancelled, TBC or moved ⇒ the request is voided
 * and 410; a missing series / fixture or absent date (a transient read) ⇒ 410 "temporarily
 * unavailable" WITHOUT voiding, so the same link works again once the read recovers.
 */
export async function loadLinkedSquadRequest(
  repo: RepoModule,
  token: string,
  nowMs: number,
  secret: string,
): Promise<
  | { ok: true; tenant: string; request: SquadRequest; memberId: string; isChairLink: boolean }
  | { ok: false; status: 404 | 410; error: string }
> {
  const check = verifySquadLinkToken(token, secret, nowMs);
  if (!check.ok)
    return check.reason === 'expired'
      ? { ok: false, status: 410, error: 'This squad link has expired.' }
      : { ok: false, status: 404, error: 'not found' };
  const { t: tenant, r: memberId, q } = check.payload;
  const key = parseSquadRequestId(q);
  if (!key) return { ok: false, status: 404, error: 'not found' };
  const request = await repo.getSquadRequest(tenant, key.seriesId, key.fixtureId, key.teamId);
  if (!request) return { ok: false, status: 404, error: 'not found' };
  const isCurrent = request.recipient.memberId === memberId;
  const isKeptChairLink = !!request.chairMemberId && request.chairMemberId === memberId;
  if (request.status === 'void' || (!isCurrent && !isKeptChairLink))
    return { ok: false, status: 410, error: 'this link is no longer valid' };
  const series = await repo.getSeries(tenant, request.seriesId);
  const state = squadFixtureState(liveFixture(series, request.fixtureId), request.matchDate);
  if (state === 'unknown')
    return {
      ok: false,
      status: 410,
      error: 'this squad link is temporarily unavailable — please try again shortly',
    };
  if (state === 'changed') {
    await voidSquadRequestForFixtureChange(repo, tenant, request, new Date(nowMs).toISOString());
    return {
      ok: false,
      status: 410,
      error: 'fixture changed — this squad link is no longer valid',
    };
  }
  const isChairLink = isKeptChairLink || (isCurrent && request.recipient.kind === 'chair');
  return { ok: true, tenant, request, memberId, isChairLink };
}

/** The squad page payload: the request (roster ids, never keys) + the club roster, names only. */
export async function squadLinkPayload(
  repo: RepoModule,
  tenant: string,
  request: SquadRequest,
  isChairLink: boolean,
  secret: string,
) {
  const [cfg, roster] = await Promise.all([
    repo.getTenantConfig(tenant),
    squadRoster(repo, tenant, request, secret),
  ]);
  return {
    request: squadRequestView(request, { secret, tenant }),
    roster: roster.map(({ id, name }) => ({ id, name })),
    canForward: isChairLink,
    forwardsRemaining: Math.max(0, MAX_FORWARDS - (request.forwardCount ?? 0)),
    maxPlayers: SQUAD_MAX,
    tenantBranding: {
      name: cfg ? orgCopy(cfg).name : tenant,
      logoUrl: cfg?.branding?.logoUrl ?? '',
      colors: cfg?.branding?.colors ?? {},
    },
  };
}

/** Parse + validate a PUT body against the roster. */
export function parseSquadBody(
  raw: unknown,
  roster: SquadRosterEntry[],
): { selection: SquadSelection; submit: boolean; expectedModified: string } {
  if (!raw || typeof raw !== 'object') throw new SquadFlowError(400, 'body must be an object');
  const b = raw as Record<string, unknown>;
  if (typeof b.expectedModified !== 'string' || !b.expectedModified)
    throw new SquadFlowError(400, 'expectedModified is required');
  const ids = b.players ?? [];
  const guestsRaw = b.guests ?? [];
  if (!Array.isArray(ids) || !Array.isArray(guestsRaw))
    throw new SquadFlowError(400, 'players and guests must be lists');
  if (ids.length > SQUAD_MAX || guestsRaw.length > SQUAD_MAX)
    throw new SquadFlowError(
      400,
      `a squad has at most ${SQUAD_MAX} players and ${SQUAD_MAX} guests`,
    );
  const byId = new Map(roster.map((e) => [e.id, e]));
  const seen = new Set<string>();
  const players: SquadSelection['players'] = [];
  for (const id of ids) {
    const e = typeof id === 'string' ? byId.get(id) : undefined;
    if (!e) throw new SquadFlowError(400, 'unknown player');
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    players.push({ key: e.key, name: e.name });
  }
  const guests = guestsRaw.map((g, i) => {
    const name =
      g && typeof g === 'object' && typeof (g as { name?: unknown }).name === 'string'
        ? (g as { name: string }).name.trim().replace(/\s+/g, ' ')
        : '';
    if (!name) throw new SquadFlowError(400, `guest ${i + 1} needs a name`);
    if (name.length > NAME_MAX) throw new SquadFlowError(400, `guest ${i + 1} name is too long`);
    return { name };
  });
  let captainKey: string | undefined;
  if (b.captainId !== undefined && b.captainId !== null) {
    const e = typeof b.captainId === 'string' ? byId.get(b.captainId) : undefined;
    if (!e || !seen.has(e.key)) throw new SquadFlowError(400, 'the captain must be in the squad');
    captainKey = e.key;
  }
  const submit = b.submit === true;
  if (submit && !players.length && !guests.length)
    throw new SquadFlowError(400, 'select at least one player to submit the squad');
  return {
    selection: { players, guests, ...(captainKey ? { captainKey } : {}) },
    submit,
    expectedModified: b.expectedModified,
  };
}

/**
 * Save a draft or submit (CAS on `expectedModified`; 409 to a stale tab). A submit stamps
 * `submittedAt`, records the team's last captain, queues the §8 upsert and — best-effort —
 * flushes it at once (`flushNow`; the cron drains whatever this misses).
 */
export async function saveSquad(
  deps: SquadRequestDeps & { flushNow?: (tenant: string, requestId: string) => Promise<unknown> },
  input: { tenant: string; request: SquadRequest; body: unknown },
): Promise<SquadRequest> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const { tenant, request } = input;
  const secret = (deps.linkSecret ?? captainsReportLinkSecret)();
  const roster = await squadRoster(repo, tenant, request, secret);
  const parsed = parseSquadBody(input.body, roster);
  const at = now().toISOString();
  let saved: SquadRequest;
  try {
    saved = await repo.saveSquadSelection(tenant, request, {
      selection: parsed.selection,
      submit: parsed.submit,
      expectedModified: parsed.expectedModified,
      modified: randomUUID(),
      at,
    });
  } catch (err) {
    if (err instanceof repo.SquadRequestConflict)
      throw new SquadFlowError(
        409,
        'the squad was changed elsewhere — reload and try again',
        'stale',
      );
    throw err;
  }
  if (!parsed.submit) return saved;
  const cap = parsed.selection.captainKey
    ? parsed.selection.players.find((p) => p.key === parsed.selection.captainKey)
    : undefined;
  if (cap)
    await repo
      .putTeamLastCaptain(tenant, {
        clubId: request.clubId,
        teamId: request.teamId,
        naturalKey: cap.key,
        name: cap.name,
        seenAt: at,
      })
      .catch(() => {});
  await repo.putPendingSquadSync(tenant, {
    requestId: request.id,
    op: 'upsert',
    submittedAt: at,
    enqueuedAt: at,
    attempts: 0,
  });
  if (deps.flushNow)
    await deps
      .flushNow(tenant, request.id)
      .catch((err) =>
        console.warn(
          `[squad-links] ${tenant} ${request.id}: immediate push failed (the cron retries) — ${
            err instanceof Error ? err.name : 'error'
          }`,
        ),
      );
  return (
    (await repo.getSquadRequest(tenant, request.seriesId, request.fixtureId, request.teamId)) ??
    saved
  );
}

// ───────────────────────── "Send to captain" ─────────────────────────

/** Opaque forward-candidate id (separate domain from the report's and the roster's). */
export function squadForwardCandidateId(
  secret: string,
  tenant: string,
  requestId: string,
  naturalKey: string,
): string {
  return createHmac('sha256', secret)
    .update(`squad-forward.v1|${tenant}|${requestId}|${naturalKey}`)
    .digest('base64url')
    .slice(0, 22);
}

/** Who a chair may send the squad link to: adult roster players with a contact (names only). */
export async function squadForwardCandidates(
  repo: RepoModule,
  tenant: string,
  request: SquadRequest,
  secret: string,
): Promise<
  Array<{ id: string; name: string; contact: { name: string; email?: string; cell?: string } }>
> {
  const roster = await squadRoster(repo, tenant, request, secret);
  return roster
    .filter((e) => !e.row.isMinor)
    .map((e) => ({
      id: squadForwardCandidateId(secret, tenant, request.id, e.key),
      name: e.name,
      contact: {
        name: e.name,
        email: e.row.email?.trim() || undefined,
        cell: e.row.cell?.trim() || undefined,
      },
    }))
    .filter((c) => hasContact(c.contact));
}

export async function forwardSquadRequest(
  deps: SquadRequestDeps,
  input: { tenant: string; request: SquadRequest; candidateId: string },
): Promise<SquadRequest> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const { tenant, request } = input;
  if ((request.forwardCount ?? 0) >= MAX_FORWARDS)
    throw new SquadFlowError(
      429,
      `this squad link has already been sent on ${MAX_FORWARDS} times`,
      'forward_limit',
    );
  const secret = (deps.linkSecret ?? captainsReportLinkSecret)();
  const picked = (await squadForwardCandidates(repo, tenant, request, secret)).find(
    (c) => c.id === input.candidateId,
  );
  if (!picked) throw new SquadFlowError(404, 'that player cannot be sent the squad link');
  const [club, config] = await Promise.all([
    repo.getClub(tenant, request.clubId),
    repo.getTenantConfig(tenant),
  ]);
  if (!club || !config) throw new SquadFlowError(404, 'squad request not found');
  const chair = chairContactOf(club);
  const byName = chair.name || club.name;
  const chairMemberId =
    request.chairMemberId ??
    (request.recipient.kind === 'chair' ? request.recipient.memberId : undefined);
  let updated: SquadRequest;
  try {
    updated = await repo.forwardSquadRequest(
      tenant,
      request,
      {
        recipient: {
          kind: 'captain',
          memberId: randomUUID(),
          name: picked.name,
          forwardedBy: { name: byName, via: 'link', at: now().toISOString() },
        },
        ...(chairMemberId ? { chairMemberId } : {}),
        recipientContact: contactOnly(picked.contact),
      },
      { expectedMemberId: request.recipient.memberId, maxForwards: MAX_FORWARDS },
    );
  } catch (err) {
    if (err instanceof repo.SquadRequestConflict)
      throw new SquadFlowError(409, 'the squad request changed meanwhile — try again');
    throw err;
  }
  await notifySquadRecipient(deps, tenant, config, updated, {
    contact: picked.contact,
    ccChair: chair,
    purpose: 'forwarded',
    recipientKind: 'captain',
    forwardedBy: byName,
  });
  return (
    (await repo.getSquadRequest(tenant, request.seriesId, request.fixtureId, request.teamId)) ??
    updated
  );
}
