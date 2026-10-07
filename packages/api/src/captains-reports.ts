/**
 * Captain's reports (ADR 0016, Slice 2 / Tasks 2.2–2.3).
 *
 * A result stored by the medicoach puller opens one PENDING report per fixture side
 * (`openCaptainReports`), addressed to:
 *   - the SCORING side's match captain, when medicoach named one (`captainRef`), the player is
 *     on the club's roster (veterans: through the VETAFFIL# record), is not a minor and has a
 *     contact; otherwise
 *   - the club CHAIR (always for the non-scoring side — medicoach has no captain for it).
 * The recipient gets a submit-once link (`/r/<token>`, HMAC-signed, bound to tenant + report +
 * recipient + expiry) by email and WhatsApp; the chair is cc'd on the captain's email. The club
 * can also file from the portal. The FIRST submit wins; the link then answers 410.
 *
 * A cleared result voids pending reports (their links die) and flags submitted ones. A
 * CORRECTED result (newer recordedAt, no clear) updates `resultSummary` on still-pending
 * reports and notifies nobody again; submitted reports are never touched.
 *
 * Durability: the puller writes a `REPORTOPEN#<ref>` marker with every newly stored result and
 * deletes it once the reports opened + notified. A failure — including a notice that failed
 * on every channel it tried (its NOTIFY# claim is released) — leaves it for
 * `retryPendingReportOpens` (every cron run and "Sync now"); after REPORT_OPEN_MAX_ATTEMPTS it
 * gives up and reports to Sentry. Re-opening is idempotent (per fixture + club), and the
 * NOTIFY# ledger claim (per report + recipient) guarantees a delivered notice is never sent
 * twice. A partial success (one channel delivered) is done.
 *
 * PII: a `captainRef` is a player ref — an unsalted hash of an SA ID number. It is resolved to
 * a roster row here and then dropped: it is never stored on the report, never put in a token
 * and never logged. Log lines carry report ids (series/fixture/club ids) and counts only.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  CONCERN_AREAS,
  RATING_CRITERIA,
  type AppointedUmpire,
  type ReportUmpireEntry,
} from '../../engine/src/captainsReport.js';
import { isSlotRef } from '../../engine/src/formats.js';
import { formatSastWeekdayDay, formatWeekdayDayYear } from '../../../src/dates.js';
import { orgCopy } from './branding.js';
import { chairContactOf } from './club-contacts.js';
import { captainsReportLinkBase, captainsReportLinkSecret } from './env.js';
import { hasFeature } from './features.js';
import { toE164 } from './notify/e164.js';
import { isWithheld } from './series-projection.js';
import { TENANT_UTC_OFFSET_MINUTES, tenantDate } from './tenant-time.js';
import type {
  CaptainsReport,
  CaptainsReportDelivery,
  CaptainsReportDeliveryReason,
  CaptainsReportRecipient,
  CaptainsReportScorecardAnswer,
  Club,
  Series,
  StoredFixtureResult,
  StoredFixtureScorecard,
  TenantConfig,
} from './types.js';
import {
  httpUrlOrNull,
  type InningsScorecardWire,
  type SyncResult,
} from './medicoach-sync-contract.js';

type RepoModule = typeof import('./repo.js');

/** A link works at least until the end of this day after the match (23:59:59 SAST). */
export const LINK_VALID_DAYS = 7;
/**
 * …and at least until the end of this day after the result first arrived, so a late result
 * still leaves the captain time to report. A report opens only while that expiry is ahead.
 */
export const RESULT_GRACE_DAYS = 3;
/** The one reminder goes this long before the link expires. */
export const REMINDER_LEAD_DAYS = 2;
/** How many times a chair may send a report on to a captain. */
export const MAX_FORWARDS = 3;
/** REPORTOPEN# retries (the puller's own try included) before giving up with Sentry. */
export const REPORT_OPEN_MAX_ATTEMPTS = 5;
/**
 * The REPORTOPEN# `lastError` prefix of a notice that failed on EVERY channel it tried (the
 * admin sync page counts these as "notices failed"). Carries no address or channel error.
 */
export const NOTICE_FAILED_ERROR = 'report notice failed on every channel';

const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;
const DAY_MS = 24 * 3600 * 1000;

// ───────────────────────── Report ids ─────────────────────────

const ID_PART_RE = /^[A-Za-z0-9_.:-]+$/;

/** `<seriesId>~<fixtureId>~<clubId>` — URL-safe, deterministic, one per fixture side. */
export function captainsReportId(seriesId: string, fixtureId: string, clubId: string): string {
  return `${seriesId}~${fixtureId}~${clubId}`;
}

export function parseCaptainsReportId(
  id: string,
): { seriesId: string; fixtureId: string; clubId: string } | null {
  const parts = id.split('~');
  if (parts.length !== 3 || !parts.every((p) => ID_PART_RE.test(p))) return null;
  const [seriesId, fixtureId, clubId] = parts;
  return { seriesId, fixtureId, clubId };
}

// ───────────────────────── Submit-once link tokens ─────────────────────────

export interface ReportLinkPayload {
  /** tenant */
  t: string;
  /** report id */
  r: string;
  /** recipient memberId (opaque, random) */
  m: string;
  /** expiry, epoch seconds */
  e: number;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(`capreport-link.v1.${payload}`).digest();
}

/** `<base64url(payload)>.<base64url(hmac)>` */
export function signReportLinkToken(p: ReportLinkPayload, secret: string): string {
  const payload = b64url(JSON.stringify(p));
  return `${payload}.${b64url(mac(secret, payload))}`;
}

export type TokenCheck =
  | { ok: true; payload: ReportLinkPayload }
  | { ok: false; reason: 'invalid' | 'expired' };

/** Verify a link token's signature (constant-time) and expiry. */
export function verifyReportLinkToken(token: string, secret: string, nowMs: number): TokenCheck {
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
  let p: ReportLinkPayload;
  try {
    p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (
    !p ||
    typeof p.t !== 'string' ||
    typeof p.r !== 'string' ||
    typeof p.m !== 'string' ||
    typeof p.e !== 'number'
  )
    return { ok: false, reason: 'invalid' };
  if (nowMs / 1000 > p.e) return { ok: false, reason: 'expired' };
  return { ok: true, payload: p };
}

/** 23:59:59 SAST on the day `plusDays` after `date` (YYYY-MM-DD), in epoch seconds. */
const endOfSastDay = (date: string, plusDays: number) =>
  Math.floor(
    (Date.parse(`${date}T23:59:59Z`) - TENANT_UTC_OFFSET_MINUTES * 60_000 + plusDays * DAY_MS) /
      1000,
  );

/** The SAST calendar day of an instant. */
const sastDay = (ms: number) =>
  new Date(ms + TENANT_UTC_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);

/**
 * When a report link stops working (epoch seconds): 23:59:59 SAST on the later of the day
 * LINK_VALID_DAYS after the match and the day RESULT_GRACE_DAYS after the result first
 * arrived (`receivedAtMs`; omitted ⇒ the match rule alone). There is no due date — the link
 * is single-submission and short-lived.
 */
export function reportLinkExpiry(matchDate: string, receivedAtMs?: number): number {
  const byMatch = endOfSastDay(matchDate, LINK_VALID_DAYS);
  if (receivedAtMs === undefined || !Number.isFinite(receivedAtMs)) return byMatch;
  return Math.max(byMatch, endOfSastDay(sastDay(receivedAtMs), RESULT_GRACE_DAYS));
}

/** A stored report's link expiry (epoch seconds); older reports fall back to the match rule. */
export function reportExpirySeconds(
  r: Pick<CaptainsReport, 'linkExpiresAt' | 'matchDate'>,
): number {
  const stored = r.linkExpiresAt ? Date.parse(r.linkExpiresAt) : NaN;
  return Number.isFinite(stored) ? Math.floor(stored / 1000) : reportLinkExpiry(r.matchDate);
}

/** "Sunday, 11 Oct" — the SAST day a link expires (the platform formatter: "Sep", not "Sept"). */
export function fmtExpiry(epochSeconds: number): string {
  return formatSastWeekdayDay(new Date(epochSeconds * 1000).toISOString());
}

/** The link for a report: `${base}/r/<token>`, expiring at the report's stored expiry. */
export function reportLink(tenant: string, report: CaptainsReport, secret: string, base: string) {
  const exp = reportExpirySeconds(report);
  const token = signReportLinkToken(
    { t: tenant, r: report.id, m: report.recipient.memberId, e: exp },
    secret,
  );
  return { token, url: `${base}/r/${token}` };
}

// ───────────────────────── Projections ─────────────────────────

/**
 * What a club member / link holder / admin sees: never the recipient's opaque memberId, the
 * chair's kept link id, the captain's contact or a provider message id, and never the
 * `deadline` reports opened before the due date was dropped still carry. `venueWithheld` is
 * set while the series withholds the venue from clubs (the venue is then left out).
 */
export type CaptainsReportView = Omit<
  CaptainsReport,
  'recipient' | 'deadline' | 'chairMemberId' | 'recipientContact' | 'deliveries'
> & {
  recipient: Omit<CaptainsReportRecipient, 'memberId'>;
  deliveries?: Array<Omit<CaptainsReportDelivery, 'messageId'>>;
  venueWithheld?: true;
};

/** Series id of a report for a match that is not in the fixture list. */
export const UNLISTED_SERIES_ID = 'unlisted';

/** A fixture's venue as the console shows it: override, allocated venue, else home ground. */
export function liveFixtureVenue(series: Series, fixtureId: string): string | undefined {
  const fixture = (series.fixtures as StoredFixture[] | undefined)?.find(
    (f) => f?.id === fixtureId,
  );
  if (!fixture) return undefined;
  const home = fixture.home
    ? series.participants?.find((p) => p.teamId === fixture.home)?.venue
    : undefined;
  return fixture.venueOverride || fixture.venueName || home || undefined;
}

/**
 * Where to read a report's venue from: the LIVE series (re-evaluated on every read, so a reveal
 * shows the venue later). `forClub` applies the club projection's rule (ADR 0011): an
 * unreleased series or one withholding its venue shows none. Admins (forClub false) see it.
 */
export interface ReportViewScope {
  series: Series | null | undefined;
  forClub: boolean;
}

function scopedVenue(
  r: CaptainsReport,
  scope: ReportViewScope | undefined,
): { venue?: string; venueWithheld?: true } {
  const stored = r.venue ? { venue: r.venue } : {};
  if (!scope || r.source === 'manual-unlisted' || r.seriesId === UNLISTED_SERIES_ID) return stored;
  const s = scope.series;
  if (!s) return scope.forClub ? {} : stored;
  if (scope.forClub) {
    if (!s.released) return {};
    if (isWithheld(s, 'venue')) return { venueWithheld: true };
  }
  const venue = liveFixtureVenue(s, r.fixtureId) || r.venue;
  return venue ? { venue } : {};
}

export function reportView(r: CaptainsReport, scope?: ReportViewScope): CaptainsReportView {
  const { memberId: _m, ...recipient } = r.recipient;
  const {
    deadline: _d,
    chairMemberId: _c,
    recipientContact: _rc,
    deliveries,
    venue: _v,
    ...rest
  } = r;
  return {
    ...rest,
    ...scopedVenue(r, scope),
    recipient,
    ...(deliveries ? { deliveries: deliveries.map(({ messageId: _id, ...d }) => d) } : {}),
  };
}

// ───────────────────────── Input parsing ─────────────────────────

export class ReportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportInputError';
  }
}

const str = (v: unknown, max: number, field: string): string => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new ReportInputError(`${field} must be text`);
  const t = v.trim();
  if (t.length > max) throw new ReportInputError(`${field} is too long (max ${max})`);
  return t;
};

const RATING_KEYS = new Set<string>(RATING_CRITERIA.map((c) => c.key));
const CONCERN_KEYS = new Set<string>(CONCERN_AREAS.map((c) => c.key));

/**
 * The scorecard answer from a request body: `{action: 'confirmed' | 'correction', feedback?,
 * againstFetchedAt?}` (the `fetchedAt` of the card the form rendered, echoed back). `stale` is
 * server-only and dropped. Feedback is kept for a correction only; whether a correction has
 * its text is a submission rule (drafts save partial answers).
 */
function parseScorecardField(v: unknown): CaptainsReportScorecardAnswer | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v))
    throw new ReportInputError('scorecard must be an object');
  const x = v as Record<string, unknown>;
  if (x.action !== 'confirmed' && x.action !== 'correction')
    throw new ReportInputError("scorecard action must be 'confirmed' or 'correction'");
  const feedback = str(x.feedback, SCORECARD_FEEDBACK_MAX, 'the scorecard correction');
  const fa = x.againstFetchedAt;
  if (
    fa !== undefined &&
    fa !== null &&
    (typeof fa !== 'string' || fa.length > 40 || !Number.isFinite(Date.parse(fa)))
  )
    throw new ReportInputError('scorecard againstFetchedAt must be an ISO timestamp');
  return {
    action: x.action,
    ...(x.action === 'correction' && feedback ? { feedback } : {}),
    ...(typeof fa === 'string' ? { againstFetchedAt: fa } : {}),
  };
}

/** The editable fields of a report from a request body (unknown keys are dropped). */
export function parseReportFields(raw: unknown): {
  captainName: string;
  umpires: ReportUmpireEntry[];
  general: string;
  declaration: boolean;
  scorecard?: CaptainsReportScorecardAnswer;
} {
  if (!raw || typeof raw !== 'object') throw new ReportInputError('body must be an object');
  const b = raw as Record<string, unknown>;
  const umpiresRaw = b.umpires ?? [];
  if (!Array.isArray(umpiresRaw)) throw new ReportInputError('umpires must be a list');
  if (umpiresRaw.length > 2) throw new ReportInputError('a report rates at most two umpires');
  const umpires = umpiresRaw.map((u, i): ReportUmpireEntry => {
    if (!u || typeof u !== 'object') throw new ReportInputError(`umpire ${i + 1} is malformed`);
    const x = u as Record<string, unknown>;
    const ratings: ReportUmpireEntry['ratings'] = {};
    if (x.ratings && typeof x.ratings === 'object') {
      for (const [k, v] of Object.entries(x.ratings as Record<string, unknown>)) {
        if (!RATING_KEYS.has(k) || v === null || v === undefined) continue;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5)
          throw new ReportInputError(`umpire ${i + 1}: ratings are whole numbers 1–5`);
        ratings[k as keyof ReportUmpireEntry['ratings']] = v;
      }
    }
    const concerns: Record<string, boolean> = {};
    if (x.concerns && typeof x.concerns === 'object') {
      for (const [k, v] of Object.entries(x.concerns as Record<string, unknown>))
        if (CONCERN_KEYS.has(k) && v === true) concerns[k] = true;
    }
    const umpireId = str(x.umpireId, 80, 'umpireId');
    return {
      ...(umpireId ? { umpireId } : {}),
      name: str(x.name, 120, `umpire ${i + 1} name`),
      ...(x.substitute === true ? { substitute: true } : {}),
      ratings,
      concerns,
      otherConcern: str(x.otherConcern, 300, 'other concern'),
      comments: str(x.comments, 2000, 'comments'),
    };
  });
  const scorecard = parseScorecardField(b.scorecard);
  return {
    captainName: str(b.captainName, 120, "captain's name"),
    umpires,
    general: str(b.general, 4000, 'general comments'),
    declaration: b.declaration === true,
    ...(scorecard ? { scorecard } : {}),
  };
}

/**
 * An umpire picked as "appointed" must be one of the appointed pair; any other registry id
 * must be a real registry entry and is marked a substitute. Free-text names carry no id.
 */
export async function checkUmpireIds(
  repo: RepoModule,
  tenant: string,
  report: Pick<CaptainsReport, 'umpiresSnapshot'>,
  umpires: ReportUmpireEntry[],
): Promise<ReportUmpireEntry[]> {
  const appointed = new Map(report.umpiresSnapshot.map((u) => [u.umpireId, u]));
  const out: ReportUmpireEntry[] = [];
  for (const u of umpires) {
    if (!u.umpireId) {
      out.push(appointed.size ? { ...u, substitute: true } : u);
      continue;
    }
    if (appointed.has(u.umpireId)) {
      const { substitute: _s, ...rest } = u;
      out.push({ ...rest, name: appointed.get(u.umpireId)!.name });
      continue;
    }
    const reg = await repo.getUmpire(tenant, u.umpireId);
    if (!reg || reg.mergedInto) throw new ReportInputError('unknown umpire');
    out.push({
      ...u,
      name: reg.displayName,
      ...(appointed.size ? { substitute: true } : {}),
    });
  }
  return out;
}

// ───────────────────────── Opening reports on a result ─────────────────────────

/** What the puller hands the result hook (see medicoach-sync/puller.ts). */
export interface ResultEventLike {
  tenant: string;
  seriesId: string;
  fixtureId: string;
  ref: string;
  result: SyncResult;
  config: TenantConfig;
  /** When the result first arrived (a retry passes its marker's time); default now. */
  receivedAt?: Date;
}

/** One outbound notice (the default sender fans it out over email + WhatsApp). */
export interface ReportNotice {
  tenant: string;
  reportId: string;
  purpose: CaptainsReportDelivery['purpose'];
  recipientKind: 'captain' | 'chair';
  to: { name: string; email?: string; cell?: string };
  /** The chair, cc'd by email when the captain is the recipient. */
  ccEmail?: string;
  clubName: string;
  matchLine: string;
  matchDateText: string;
  orgName: string;
  /** "Sunday, 11 Oct" — when the link stops working. */
  expiresText: string;
  token: string;
  url: string;
  channels: Array<'email' | 'whatsapp'>;
  /** The one pre-expiry reminder (same link). */
  reminder?: boolean;
  /** The chair who sent the report on to this captain. */
  forwardedBy?: string;
}

export interface NoticeResult {
  channel: 'email' | 'whatsapp';
  status: 'sent' | 'skipped' | 'failed';
  reason?: CaptainsReportDeliveryReason;
  /** The provider's message id (a `dry-run-` id means nothing was sent). Never logged. */
  messageId?: string;
  error?: string;
}

export interface CaptainsReportDeps {
  repo: RepoModule;
  now?: () => Date;
  /** Overridable for tests; defaults to the SES + Meta senders (dry-run without secrets). */
  sendNotice?: (n: ReportNotice) => Promise<NoticeResult[]>;
  linkSecret?: () => string;
  linkBase?: () => string;
  log?: (line: string) => void;
  /**
   * Told the report ids of every opening that got as far as the notices (pull hook and
   * retry alike), just before it returns or throws — the sync run tallies these for its ops
   * digest. Observation only: it never changes the outcome or the retry.
   */
  onOpenOutcome?: (o: { opened: string[]; notified: string[]; failed: string[] }) => void;
}

export interface OpenOutcome {
  skipped?: 'import' | 'no-go-live' | 'before-go-live' | 'too-old' | 'no-fixture';
  opened: string[];
  /** Reports whose notice actually reached someone (a channel sent). */
  notified: string[];
}

type StoredFixture = Record<string, unknown> & {
  id: string;
  date?: string;
  home?: string;
  away?: string;
  venueOverride?: string;
  venueName?: string;
};

/** "Sun 20 Sep 2026" — the platform formatter, so every surface spells months the same. */
const fmtDay = (iso: string) => formatWeekdayDayYear(iso);

function sideName(series: Series, teamId: string, club: Club | null): string {
  return (
    series.participants?.find((p) => p.teamId === teamId)?.name ?? club?.name ?? String(teamId)
  );
}

/** `smartclub:<tenant>:player:<naturalKey>` → naturalKey (only for THIS tenant). */
function playerNaturalKey(ref: string | null | undefined, tenant: string): string | null {
  if (!ref) return null;
  const prefix = `smartclub:${tenant}:player:`;
  if (!ref.startsWith(prefix)) return null;
  const key = ref.slice(prefix.length);
  return /^[A-Za-z0-9_-]{1,128}$/.test(key) ? key : null;
}

export const hasContact = (c: { email?: string; cell?: string }) =>
  (!!c.email && EMAIL_RE.test(c.email)) || !!toE164(c.cell);

/**
 * The scoring side's match captain as a notify contact, or null (→ the chair). The ref is used
 * for two point-gets and then dropped.
 */
async function resolveCaptain(
  repo: RepoModule,
  tenant: string,
  clubId: string,
  captainRef: string | null,
): Promise<{ name: string; email?: string; cell?: string } | null> {
  const naturalKey = playerNaturalKey(captainRef, tenant);
  if (!naturalKey) return null;
  let player = await repo.getPlayer(tenant, clubId, naturalKey);
  if (!player) {
    // A veterans side: the player's roster row lives at their PRIMARY club; the veterans club
    // holds only the VETAFFIL# pointer.
    const aff = await repo.getVeteransAffiliation(tenant, clubId, naturalKey);
    if (aff) player = await repo.getPlayer(tenant, aff.primaryClubId, naturalKey);
  }
  if (!player || player.isMinor) return null;
  const contact = {
    name: `${player.firstName ?? ''} ${player.lastName ?? ''}`.trim(),
    email: player.email?.trim(),
    cell: player.cell?.trim(),
  };
  return hasContact(contact) ? contact : null;
}

/**
 * Open the reports for a newly stored result. Idempotent per fixture + club: an existing
 * pending/submitted report is left alone (a void one is re-opened with a NEW recipient id, so
 * old links stay dead). Skipped for imported results, matches before the tenant's
 * `integrations.medicoach.goLiveDate` (unset ⇒ not live ⇒ skipped), and results whose link
 * would already have expired (`reportLinkExpiry`).
 */
export async function openCaptainReports(
  event: ResultEventLike,
  deps: CaptainsReportDeps,
): Promise<OpenOutcome> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const out: OpenOutcome = { opened: [], notified: [] };
  const { tenant, seriesId, fixtureId, result, config } = event;

  if (result.source === 'import') return { ...out, skipped: 'import' };

  // A corrected result (same fixture, newer recordedAt): pending reports take the new
  // summary. Done before the go-live/age rules — they decide whether reports OPEN, not
  // whether an open one shows the right score. Nobody is notified again.
  for (const r of await repo.listCaptainsReportsForFixture(tenant, seriesId, fixtureId))
    if (r.status === 'pending' && (r.resultSummary ?? null) !== (result.summary ?? null))
      await repo.updatePendingCaptainsReportSummary(tenant, r, result.summary ?? null);

  const goLive = config.integrations?.medicoach?.goLiveDate;
  if (!goLive) return { ...out, skipped: 'no-go-live' };

  const series = await repo.getSeries(tenant, seriesId);
  const fixture = (series?.fixtures as StoredFixture[] | undefined)?.find(
    (f) => f?.id === fixtureId,
  );
  if (!series || !fixture?.date) return { ...out, skipped: 'no-fixture' };
  const matchDate = fixture.date;
  if (matchDate < goLive) return { ...out, skipped: 'before-go-live' };
  // Too old = the link would already be dead: its expiry (the later of match + 7 days and
  // result received + 3 days, end of that SAST day) has passed. A retry judges this on the
  // time the result first arrived, so a long-failing opening does not stretch the window.
  const receivedAtMs = (event.receivedAt ?? now()).getTime();
  const expiry = reportLinkExpiry(matchDate, receivedAtMs);
  if (expiry * 1000 <= now().getTime()) return { ...out, skipped: 'too-old' };

  const officials = await repo.getFixtureOfficials(tenant, seriesId, fixtureId);
  const umpiresSnapshot: AppointedUmpire[] = (officials?.umpires ?? []).map((u) => ({
    umpireId: u.umpireId,
    name: u.name,
  }));
  const byTeam = new Map((series.participants ?? []).map((p) => [p.teamId, p]));
  // A series withholding its venue (ADR 0011) keeps it off the report: the link and the club
  // portal re-read the live series, so the reveal shows it later.
  const venue = isWithheld(series, 'venue') ? '' : (liveFixtureVenue(series, fixtureId) ?? '');

  const clubs = new Map<string, Club | null>();
  const sides = (['home', 'away'] as const).map((side) => {
    const teamId = fixture[side];
    if (typeof teamId !== 'string' || !teamId || isSlotRef(teamId)) return null;
    return { side, teamId, clubId: byTeam.get(teamId)?.clubId ?? teamId };
  });
  for (const s of sides) if (s) clubs.set(s.clubId, await repo.getClub(tenant, s.clubId));

  const nowIso = now().toISOString();
  const failedNotices: string[] = [];
  for (const s of sides) {
    if (!s) continue;
    const club = clubs.get(s.clubId);
    if (!club) continue;
    const other = sides.find((x) => x && x.side !== s.side);
    const opponentName = other
      ? sideName(series, other.teamId, clubs.get(other.clubId) ?? null)
      : 'TBC';
    const chair = chairContactOf(club);
    const captain =
      result.scoringSide === s.side
        ? await resolveCaptain(repo, tenant, club.id, result.captainRef)
        : null;
    const contact = captain ?? chair;
    const recipient: CaptainsReportRecipient = {
      kind: captain ? 'captain' : 'chair',
      memberId: randomUUID(),
      name: contact.name,
    };
    const report: CaptainsReport = {
      id: captainsReportId(seriesId, fixtureId, club.id),
      seriesId,
      fixtureId,
      clubId: club.id,
      status: 'pending',
      source: 'auto',
      fixtureRef: event.ref,
      matchDate,
      side: s.side,
      clubName: sideName(series, s.teamId, club),
      opponentName,
      competition: series.name ?? '',
      ...(venue ? { venue } : {}),
      resultSummary: result.summary ?? null,
      umpiresSnapshot,
      recipient,
      captainName: captain?.name ?? '',
      umpires: [],
      general: '',
      linkExpiresAt: new Date(expiry * 1000).toISOString(),
      ...(captain ? { recipientContact: contactOnly(captain) } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    if (!(await repo.openCaptainsReportIfAbsent(tenant, report))) {
      // Already open. A retry (REPORTOPEN#) after a failed notify must still notify — the
      // NOTIFY# ledger claim makes this a no-op when the first send was already claimed.
      const existing = await repo.getCaptainsReport(tenant, seriesId, fixtureId, club.id);
      if (!existing || existing.status !== 'pending' || existing.source !== 'auto') continue;
      const toCaptain = existing.recipient.kind === 'captain';
      const captainContact = existing.recipientContact
        ? { name: existing.recipient.name, ...existing.recipientContact }
        : captain;
      // No captain contact left (e.g. the captain was erased: report contact + marker ref both
      // scrubbed) → the chair gets the notice, as the chair, with the chair's wording.
      const reachCaptain = toCaptain && !!captainContact;
      const sent = await notifyRecipient(deps, tenant, config, existing, {
        contact: reachCaptain && captainContact ? captainContact : chair,
        ccChair: reachCaptain ? chair : null,
        purpose: existing.recipient.forwardedBy ? 'forwarded' : 'opened',
        recipientKind: reachCaptain ? 'captain' : 'chair',
      });
      if (sent === 'sent') out.notified.push(existing.id);
      else if (sent === 'failed') failedNotices.push(existing.id);
      continue;
    }
    out.opened.push(report.id);

    const sent = await notifyRecipient(deps, tenant, config, report, {
      contact,
      ccChair: captain ? chair : null,
      purpose: 'opened',
    });
    if (sent === 'sent') out.notified.push(report.id);
    else if (sent === 'failed') failedNotices.push(report.id);
  }
  // A notice that reached nobody (every channel tried failed) released its ledger claim;
  // throwing keeps the REPORTOPEN# marker, so the next run re-sends it (bounded by
  // REPORT_OPEN_MAX_ATTEMPTS). Both sides were handled first, so one side's failure never
  // stops the other side's report from opening.
  deps.onOpenOutcome?.({ opened: out.opened, notified: out.notified, failed: failedNotices });
  if (failedNotices.length)
    throw new Error(`${NOTICE_FAILED_ERROR} (${failedNotices.length} report(s))`);
  return out;
}

const contactOnly = (c: { email?: string; cell?: string }) => ({
  ...(c.email ? { email: c.email } : {}),
  ...(c.cell ? { cell: c.cell } : {}),
});

/** A result's outcome as a stored delivery: a dry-run "send" is recorded as not sent. */
function deliveryOf(
  r: NoticeResult,
  purpose: CaptainsReportDelivery['purpose'],
  recipientKind: CaptainsReportDelivery['recipientKind'],
  at: string,
): CaptainsReportDelivery {
  const dry = r.status === 'sent' && !!r.messageId?.startsWith('dry-run-');
  const status = dry ? 'skipped' : r.status;
  const reason: CaptainsReportDeliveryReason | undefined = dry
    ? 'dry-run'
    : (r.reason ?? (r.status === 'failed' ? 'send-failed' : undefined));
  return {
    channel: r.channel,
    status,
    ...(reason ? { reason } : {}),
    at,
    ...(status === 'sent' && r.messageId ? { messageId: r.messageId } : {}),
    purpose,
    recipientKind,
  };
}

/**
 * Claim the NOTIFY# ledger row, send, and record the per-channel outcome on the report.
 *
 *  - 'already': the send was already claimed (a replay, a retried run) — nothing sent.
 *  - 'sent': at least one channel actually went out (`notifiedAt` is set).
 *  - 'undelivered': nothing went out but nothing failed either (no contact, dry run, no
 *    approved template) — recorded honestly, and never counted as notified.
 *  - 'failed': nothing went out and a channel FAILED. For the opening/forward audience
 *    (`recipient#<memberId>`) the claim is released so the REPORTOPEN# retry can send again;
 *    a reminder is best-effort and keeps its claim (at most one).
 */
async function notifyRecipient(
  deps: CaptainsReportDeps,
  tenant: string,
  config: TenantConfig,
  report: CaptainsReport,
  opts: {
    contact: { name: string; email?: string; cell?: string };
    ccChair: { email?: string } | null;
    purpose: CaptainsReportDelivery['purpose'];
    forwardedBy?: string;
    /** Who is actually being reached, when it differs from the report's recipient kind. */
    recipientKind?: 'captain' | 'chair';
  },
): Promise<'sent' | 'undelivered' | 'already' | 'failed'> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const { contact, ccChair, purpose } = opts;
  // Everything that can throw BEFORE a send is resolved before the ledger claim, so a
  // failure (e.g. the link secret unset) leaves the claim free for the REPORTOPEN# retry.
  const secret = (deps.linkSecret ?? captainsReportLinkSecret)();
  const base = (deps.linkBase ?? captainsReportLinkBase)();
  const { token, url } = reportLink(tenant, report, secret, base);
  // The ledger audience is per RECIPIENT (its random memberId), not per report: a report
  // voided by a cleared result and re-opened by a re-recorded one gets a new memberId (a new
  // link) and must be notified again, while a replay of the same opening never is. The one
  // reminder has its own audience.
  const reminder = purpose === 'reminder';
  const audience = `${reminder ? 'reminder' : 'recipient'}#${report.recipient.memberId}`;
  if (!(await repo.claimCaptainsReportNotify(tenant, report.id, audience))) return 'already';
  const recipientKind: 'captain' | 'chair' =
    opts.recipientKind ?? (report.recipient.kind === 'captain' ? 'captain' : 'chair');
  const home = report.side === 'home' ? report.clubName : report.opponentName;
  const away = report.side === 'home' ? report.opponentName : report.clubName;
  const cc =
    ccChair?.email && EMAIL_RE.test(ccChair.email) && ccChair.email !== contact.email
      ? ccChair.email
      : undefined;
  const notice: ReportNotice = {
    tenant,
    reportId: report.id,
    purpose,
    recipientKind,
    to: contact,
    ...(cc ? { ccEmail: cc } : {}),
    clubName: report.clubName,
    matchLine: `${home} v ${away}`,
    matchDateText: fmtDay(report.matchDate),
    orgName: orgCopy(config).name,
    expiresText: fmtExpiry(reportExpirySeconds(report)),
    token,
    url,
    channels: hasFeature(config, 'whatsappInvites', true) ? ['email', 'whatsapp'] : ['email'],
    ...(reminder ? { reminder: true } : {}),
    ...(opts.forwardedBy ? { forwardedBy: opts.forwardedBy } : {}),
  };
  let results: NoticeResult[];
  if (!hasContact(contact)) {
    // Nobody to send to: say so on every channel instead of calling the providers.
    results = notice.channels.map((channel) => ({
      channel,
      status: 'skipped' as const,
      reason: 'no-contact' as const,
    }));
  } else {
    const send = deps.sendNotice ?? defaultSender;
    try {
      results = await send(notice);
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
  const deliveries = results.map((r) => deliveryOf(r, purpose, recipientKind, at));
  const delivered = deliveries.some((d) => d.status === 'sent');
  const failed = !delivered && deliveries.some((d) => d.status === 'failed');
  await repo.recordCaptainsReportDeliveries(tenant, report, deliveries, {
    ...(delivered ? { notifiedAt: at } : {}),
    ...(reminder ? { reminderSentAt: at } : {}),
  });
  for (const d of deliveries)
    if (d.channel === 'whatsapp' && d.status === 'sent' && d.messageId)
      await repo.putWhatsAppMessageRef(d.messageId, {
        tenant,
        seriesId: report.seriesId,
        fixtureId: report.fixtureId,
        clubId: report.clubId,
      });
  if (failed && !reminder) {
    await repo.releaseCaptainsReportNotify(tenant, report.id, audience);
    return 'failed';
  }
  await repo.completeCaptainsReportNotify(
    tenant,
    report.id,
    audience,
    results.map(({ channel, status, reason }) => ({
      channel,
      status,
      ...(reason ? { error: reason } : {}),
    })),
  );
  return delivered ? 'sent' : 'undelivered';
}

let defaultSender: (n: ReportNotice) => Promise<NoticeResult[]> = (n) => sendReportNotice(n);

/**
 * Replace the sender used when no `deps.sendNotice` is given (the HTTP routes, e.g. "Send to
 * captain"). For integration tests and local tooling only; `undefined` restores SES + Meta.
 */
export function setDefaultReportNoticeSender(
  fn: ((n: ReportNotice) => Promise<NoticeResult[]>) | undefined,
): void {
  defaultSender = fn ?? ((n) => sendReportNotice(n));
}

/**
 * The default sender: SES email (+ cc) and the `captains_report_due` WhatsApp template
 * (v2 copy, edited in place in Meta 4 Oct 2026). Each channel says why it was not
 * sent (`no-email`, `no-cell`, `template-pending`, `send-failed`); a dry-run send returns a
 * `dry-run-` message id, which the caller records as not sent.
 */
export async function sendReportNotice(n: ReportNotice): Promise<NoticeResult[]> {
  const { sendCaptainsReportDueEmail } = await import('./notify/email.js');
  const { sendCaptainsReportDueWhatsApp, WhatsAppTemplatePendingError } =
    await import('./notify/whatsapp.js');
  const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
  return Promise.all(
    n.channels.map(async (channel): Promise<NoticeResult> => {
      if (channel === 'email') {
        if (!n.to.email || !EMAIL_RE.test(n.to.email))
          return { channel, status: 'skipped', reason: 'no-email' };
        try {
          const { messageId } = await sendCaptainsReportDueEmail({
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
            ...(n.reminder ? { reminder: true } : {}),
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
        const { messageId } = await sendCaptainsReportDueWhatsApp({
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

/**
 * The puller's result hook: open reports. A failure is logged and RETHROWN — the puller
 * catches it (the sync run never fails on it) and keeps the REPORTOPEN# marker, so the next
 * run retries. Logs ids and counts only.
 */
export function captainsReportResultHook(deps: CaptainsReportDeps) {
  const log = deps.log ?? ((line: string) => console.log(line));
  return async (event: ResultEventLike): Promise<void> => {
    try {
      const outcome = await openCaptainReports(event, deps);
      if (outcome.opened.length || outcome.skipped)
        log(
          `[captains-report] ${event.tenant} ${event.seriesId}/${event.fixtureId}: ` +
            (outcome.skipped
              ? `skipped (${outcome.skipped})`
              : `opened ${outcome.opened.length}, notified ${outcome.notified.length}`),
        );
    } catch (err) {
      console.error(
        `[captains-report] ${event.tenant} ${event.seriesId}/${event.fixtureId}: open failed — ${
          err instanceof Error ? err.name : 'error'
        } (will retry)`,
      );
      throw err;
    }
  };
}

/**
 * A stored result back in the wire shape the report opener reads. The result item carries no
 * player ref (POPIA); the captain's comes from the pending REPORTOPEN# marker.
 */
function syncResultOf(r: StoredFixtureResult, captainRef: string | null): SyncResult {
  return {
    homeScore: r.homeScore ?? null,
    awayScore: r.awayScore ?? null,
    summary: r.summary ?? null,
    winner: r.winner ?? null,
    method: (r.method as SyncResult['method']) ?? null,
    noResult: r.noResult === true,
    source: r.resultSource ?? 'manual',
    recordedAt: r.recordedAt!,
    scoringSide: r.scoringSide ?? null,
    captainRef,
    medicoachMatchUrl: r.medicoachMatchUrl ?? null,
  };
}

export interface ReportRetrySummary {
  retried: number;
  done: number;
  failed: number;
  gaveUp: number;
}

/**
 * Retry every pending REPORTOPEN# marker for a tenant (each cron run and "Sync now"). The
 * marker's result is re-read from its FIXRESULT# item, so the usual rules apply unchanged
 * (import source, goLiveDate, the link window — judged on when the result first arrived). A marker whose result is gone, cleared, or
 * older than the one it was written for (the store never happened) is simply dropped.
 * After REPORT_OPEN_MAX_ATTEMPTS failures the marker is dropped and Sentry told.
 */
export async function retryPendingReportOpens(
  tenant: string,
  deps: CaptainsReportDeps,
): Promise<ReportRetrySummary> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const out: ReportRetrySummary = { retried: 0, done: 0, failed: 0, gaveUp: 0 };
  const markers = await repo.listReportOpenMarkers(tenant);
  if (!markers.length) return out;
  const config = await repo.getTenantConfig(tenant);
  for (const m of markers) {
    const stored = await repo.getFixtureResult(tenant, m.seriesId, m.fixtureId);
    if (
      !config ||
      !stored ||
      stored.cleared ||
      !stored.recordedAt ||
      Date.parse(stored.recordedAt) < Date.parse(m.recordedAt)
    ) {
      await repo.deleteReportOpenMarker(tenant, m.ref);
      continue;
    }
    out.retried++;
    try {
      await openCaptainReports(
        {
          tenant,
          seriesId: m.seriesId,
          fixtureId: m.fixtureId,
          ref: m.ref,
          result: syncResultOf(stored, m.captainRef ?? null),
          config,
          receivedAt: new Date(m.createdAt),
        },
        deps,
      );
      await repo.deleteReportOpenMarker(tenant, m.ref);
      out.done++;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'report open failed';
      const attempts = await repo.markReportOpenFailed(tenant, m.ref, message, now().toISOString());
      if (attempts >= REPORT_OPEN_MAX_ATTEMPTS) {
        out.gaveUp++;
        await repo.deleteReportOpenMarker(tenant, m.ref);
        console.error(
          `[captains-report] ${tenant} ${m.seriesId}/${m.fixtureId}: gave up after ${attempts} attempts`,
        );
        const { Sentry } = await import('./instrument.js');
        Sentry.captureException(
          new Error(`captain's reports could not be opened after ${attempts} attempts`),
          {
            tags: { tenant, job: 'captains-report' },
            extra: { seriesId: m.seriesId, fixtureId: m.fixtureId, lastError: message },
          },
        );
      } else out.failed++;
    }
  }
  return out;
}

/** The puller's cleared-result hook: void pending reports, flag submitted ones. */
export function captainsReportClearedHook(deps: CaptainsReportDeps) {
  return async (event: { tenant: string; seriesId: string; fixtureId: string }) => {
    const reports = await deps.repo.listCaptainsReportsForFixture(
      event.tenant,
      event.seriesId,
      event.fixtureId,
    );
    for (const r of reports)
      await deps.repo.voidOrFlagCaptainsReport(event.tenant, r, 'result cleared in medicoach');
  };
}

/** Exported for the link route: a link-safe report lookup. */
export async function loadLinkedReport(
  repo: RepoModule,
  token: string,
  nowMs: number,
  secret: string,
): Promise<
  | { ok: true; tenant: string; report: CaptainsReport; memberId: string; isChairLink: boolean }
  | { ok: false; status: 404 | 410; error: string }
> {
  const check = verifyReportLinkToken(token, secret, nowMs);
  if (!check.ok)
    return check.reason === 'expired'
      ? {
          ok: false,
          status: 410,
          error:
            'This link has expired. Your club chair can still file the report from the club portal.',
        }
      : { ok: false, status: 404, error: 'not found' };
  const { t: tenant, r: reportId, m: memberId } = check.payload;
  const key = parseCaptainsReportId(reportId);
  if (!key) return { ok: false, status: 404, error: 'not found' };
  const report = await repo.getCaptainsReport(tenant, key.seriesId, key.fixtureId, key.clubId);
  if (!report) return { ok: false, status: 404, error: 'not found' };
  if (report.status === 'submitted')
    return { ok: false, status: 410, error: 'this report has already been submitted' };
  // The current recipient's link, or — after "Send to captain" — the chair's kept link.
  const isCurrent = report.recipient.memberId === memberId;
  const isKeptChairLink = !!report.chairMemberId && report.chairMemberId === memberId;
  if (report.status === 'void' || (!isCurrent && !isKeptChairLink))
    return { ok: false, status: 410, error: 'this link is no longer valid' };
  const isChairLink = isKeptChairLink || (isCurrent && report.recipient.kind === 'chair');
  return { ok: true, tenant, report, memberId, isChairLink };
}

// ───────────────────────── "Send to captain" ─────────────────────────

/** A refused report action, with the HTTP status the route answers. */
export class ReportFlowError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 429,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ReportFlowError';
  }
}

/**
 * An opaque, report-scoped handle for a forward candidate: HMAC(link secret, tenant | report |
 * roster key). The roster key is a hashed ID number, so it never leaves the server.
 */
export function forwardCandidateId(
  secret: string,
  tenant: string,
  reportId: string,
  naturalKey: string,
): string {
  return createHmac('sha256', secret)
    .update(`capreport-forward.v1|${tenant}|${reportId}|${naturalKey}`)
    .digest('base64url')
    .slice(0, 22);
}

interface ForwardCandidate {
  id: string;
  name: string;
  contact: { name: string; email?: string; cell?: string };
}

/**
 * Who a chair may send a report to: the club's OWN registered players (active roster rows),
 * never minors, and only those with an email or a cell on file. Names only leave the server.
 */
export async function forwardCandidates(
  repo: RepoModule,
  tenant: string,
  report: CaptainsReport,
  secret: string,
): Promise<ForwardCandidate[]> {
  const players = await repo.listPlayers(tenant, report.clubId);
  return players
    .filter((p) => (p.status ?? 'active') === 'active' && !p.isMinor)
    .map((p) => {
      const contact = {
        name: `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim(),
        email: p.email?.trim() || undefined,
        cell: p.cell?.trim() || undefined,
      };
      return { id: forwardCandidateId(secret, tenant, report.id, p.naturalKey), contact };
    })
    .filter((c) => c.contact.name && hasContact(c.contact))
    .map((c) => ({ id: c.id, name: c.contact.name, contact: c.contact }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The chair sends a PENDING report on to the match captain: a new link (new memberId) for the
 * picked player, the recipient re-pointed (`kind: 'captain'`, `forwardedBy`), and the captain
 * notified (the chair cc'd by email). The chair's own link keeps working until the report is
 * submitted — first submit wins. At most MAX_FORWARDS per report.
 */
export async function forwardReport(
  deps: CaptainsReportDeps,
  input: {
    tenant: string;
    report: CaptainsReport;
    candidateId: string;
    via: 'link' | 'portal';
  },
): Promise<CaptainsReport> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const { tenant, report, via } = input;
  if (report.status !== 'pending')
    throw new ReportFlowError(409, "captain's report already submitted", 'report_closed');
  if ((report.forwardCount ?? 0) >= MAX_FORWARDS)
    throw new ReportFlowError(
      429,
      `this report has already been sent on ${MAX_FORWARDS} times`,
      'forward_limit',
    );
  const secret = (deps.linkSecret ?? captainsReportLinkSecret)();
  const picked = (await forwardCandidates(repo, tenant, report, secret)).find(
    (c) => c.id === input.candidateId,
  );
  if (!picked) throw new ReportFlowError(404, 'that player cannot be sent the report');
  const [club, config] = await Promise.all([
    repo.getClub(tenant, report.clubId),
    repo.getTenantConfig(tenant),
  ]);
  if (!club || !config) throw new ReportFlowError(404, 'report not found');
  const chair = chairContactOf(club);
  const byName = chair.name || club.name;
  const chairMemberId =
    report.chairMemberId ??
    (report.recipient.kind === 'chair' ? report.recipient.memberId : undefined);
  let updated: CaptainsReport;
  try {
    updated = await repo.forwardCaptainsReport(
      tenant,
      report,
      {
        recipient: {
          kind: 'captain',
          memberId: randomUUID(),
          name: picked.name,
          forwardedBy: { name: byName, via, at: now().toISOString() },
        },
        ...(chairMemberId ? { chairMemberId } : {}),
        recipientContact: contactOnly(picked.contact),
        captainName: report.captainName || picked.name,
      },
      { expectedMemberId: report.recipient.memberId, maxForwards: MAX_FORWARDS },
    );
  } catch (err) {
    if (!(err instanceof repo.CaptainsReportForwardConflict)) throw err;
    const fresh = await repo.getCaptainsReport(
      tenant,
      report.seriesId,
      report.fixtureId,
      report.clubId,
    );
    if (!fresh || fresh.status !== 'pending')
      throw new ReportFlowError(409, "captain's report already submitted", 'report_closed');
    if ((fresh.forwardCount ?? 0) >= MAX_FORWARDS)
      throw new ReportFlowError(429, `this report has already been sent on ${MAX_FORWARDS} times`);
    throw new ReportFlowError(409, 'the report changed meanwhile — try again');
  }
  await notifyRecipient(deps, tenant, config, updated, {
    contact: picked.contact,
    ccChair: chair,
    purpose: 'forwarded',
    forwardedBy: byName,
  });
  return (
    (await repo.getCaptainsReport(tenant, report.seriesId, report.fixtureId, report.clubId)) ??
    updated
  );
}

// ───────────────────────── The one reminder ─────────────────────────

export interface ReminderSummary {
  /** Pending reports inside the reminder window that had not been reminded yet. */
  due: number;
  /** Reminders that reached someone. */
  sent: number;
  /** Reminders recorded but not delivered (no contact, dry run, every channel failed). */
  undelivered: number;
}

/**
 * Remind the current recipient of every PENDING report whose link expires within
 * REMINDER_LEAD_DAYS — once, at most (NOTIFY# audience `reminder#<memberId>`), on the same
 * channels with the same link. Runs in the 15-minute sync run (sync-enabled tenants only).
 * A captain recipient is reached through the contact stored when the report was addressed
 * to them; a chair through the club's current chair contact.
 */
export async function sendReportReminders(
  tenant: string,
  deps: CaptainsReportDeps,
): Promise<ReminderSummary> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const out: ReminderSummary = { due: 0, sent: 0, undelivered: 0 };
  const nowMs = now().getTime();
  const due = (await repo.listCaptainsReports(tenant)).filter((r) => {
    if (r.status !== 'pending' || r.reminderSentAt) return false;
    if (r.recipient.kind !== 'captain' && r.recipient.kind !== 'chair') return false;
    const exp = reportExpirySeconds(r) * 1000;
    return nowMs < exp && nowMs >= exp - REMINDER_LEAD_DAYS * DAY_MS;
  });
  if (!due.length) return out;
  const config = await repo.getTenantConfig(tenant);
  if (!config) return out;
  const clubs = new Map<string, Club | null>();
  for (const r of due) {
    if (!clubs.has(r.clubId)) clubs.set(r.clubId, await repo.getClub(tenant, r.clubId));
    const club = clubs.get(r.clubId);
    if (!club) continue;
    const chair = chairContactOf(club);
    const toCaptain = r.recipient.kind === 'captain';
    if (toCaptain && !r.recipientContact) continue; // opened before contacts were kept
    out.due++;
    const contact = toCaptain ? { name: r.recipient.name, ...r.recipientContact } : chair;
    const sent = await notifyRecipient(deps, tenant, config, r, {
      contact,
      ccChair: toCaptain ? chair : null,
      purpose: 'reminder',
    });
    if (sent === 'sent') out.sent++;
    else if (sent !== 'already') out.undelivered++;
  }
  return out;
}

// ───────────────────────── Scorecard confirmation ─────────────────────────

/** A correction request is capped at this many characters. */
export const SCORECARD_FEEDBACK_MAX = 2000;

export class ScorecardInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScorecardInputError';
  }
}

/** A chair's answer from a request body: `{action: 'confirm' | 'correction', feedback?}`. */
export function parseScorecardAnswer(raw: unknown): {
  action: 'confirm' | 'correction';
  feedback?: string;
  scorecardFetchedAt?: string;
} {
  if (!raw || typeof raw !== 'object') throw new ScorecardInputError('body must be an object');
  const b = raw as Record<string, unknown>;
  if (b.action !== 'confirm' && b.action !== 'correction')
    throw new ScorecardInputError("action must be 'confirm' or 'correction'");
  if (b.feedback !== undefined && b.feedback !== null && typeof b.feedback !== 'string')
    throw new ScorecardInputError('feedback must be text');
  const feedback = typeof b.feedback === 'string' ? b.feedback.trim() : '';
  if (feedback.length > SCORECARD_FEEDBACK_MAX)
    throw new ScorecardInputError(`feedback is too long (max ${SCORECARD_FEEDBACK_MAX})`);
  // The `fetchedAt` of the scorecard the page rendered (echoed from the view), if any.
  const fa = b.scorecardFetchedAt;
  if (
    fa !== undefined &&
    fa !== null &&
    (typeof fa !== 'string' || fa.length > 40 || !Number.isFinite(Date.parse(fa)))
  )
    throw new ScorecardInputError('scorecardFetchedAt must be an ISO timestamp');
  const echoed = typeof fa === 'string' ? { scorecardFetchedAt: fa } : {};
  if (b.action === 'correction') {
    if (!feedback) throw new ScorecardInputError('feedback is required to request a correction');
    return { action: 'correction', feedback, ...echoed };
  }
  return { action: 'confirm', ...(feedback ? { feedback } : {}), ...echoed };
}

/**
 * The card version an answer (confirm OR correction) was given against, stored as the entry's
 * `confirmedAgainstFetchedAt`. The page echoes the `scorecardFetchedAt` it rendered; that echo
 * is client-supplied, so it is trusted only as a plausible PAST value no later than the card
 * stored now — a forged future echo would otherwise defeat every later stale check. Anything
 * else (later than the stored card, in the future, or no echo) falls back to the stored
 * card's `fetchedAt`. No available card stored ⇒ undefined (the stale check then uses
 * `submittedAt`). Returned in `toISOString()` form so DynamoDB's string compare stays sound.
 */
export function answeredAgainstFetchedAt(
  echo: string | undefined,
  card: { available: boolean; fetchedAt?: string } | null,
  now: Date,
): string | undefined {
  const stored = card?.available && card.fetchedAt ? card.fetchedAt : undefined;
  if (!stored) return undefined;
  if (echo === undefined) return stored;
  const ms = Date.parse(echo);
  if (!Number.isFinite(ms) || ms > Date.parse(stored) || ms > now.getTime()) return stored;
  return new Date(ms).toISOString();
}

export interface ScorecardBranding {
  name: string;
  logoUrl: string;
  colors: Record<string, string>;
}

// ───────────────────────── Scorecard correction → operators ─────────────────────────

export interface ScorecardCorrectionNotice {
  to: string;
  tenantName: string;
  clubName: string;
  ref: string;
  fixtureLine: string;
  feedback: string;
  consoleLink?: string;
}

let defaultCorrectionSender: (
  n: ScorecardCorrectionNotice,
) => Promise<{ messageId: string }> = async (n) =>
  (await import('./notify/email.js')).sendScorecardCorrectionEmail(n);

/** The operator-email sender for correction requests. Tests/local only; `undefined` restores. */
export function setDefaultScorecardCorrectionSender(
  fn: ((n: ScorecardCorrectionNotice) => Promise<{ messageId: string }>) | undefined,
): void {
  defaultCorrectionSender =
    fn ?? (async (n) => (await import('./notify/email.js')).sendScorecardCorrectionEmail(n));
}

/**
 * Email every platform operator about a scorecard correction request. Best-effort: the caller
 * never fails the submit on it; failures are counted and logged (no address, no feedback).
 */
export async function notifyOperatorsOfCorrection(
  deps: {
    repo: Pick<RepoModule, 'listOperators'>;
    send?: (n: ScorecardCorrectionNotice) => Promise<{ messageId: string }>;
    log?: (line: string) => void;
  },
  input: Omit<ScorecardCorrectionNotice, 'to'>,
): Promise<{ sent: number; failed: number }> {
  const { listOperatorEmails } = await import('./notify/operator-emails.js');
  const log = deps.log ?? ((l: string) => console.warn(l));
  const send = deps.send ?? defaultCorrectionSender;
  const out = { sent: 0, failed: 0 };
  for (const to of await listOperatorEmails({ repo: deps.repo })) {
    try {
      await send({ ...input, to });
      out.sent++;
    } catch (err) {
      out.failed++;
      log(
        `[scorecard-correction] correction notice ${input.ref}: an operator email failed — ${
          err instanceof Error ? err.name : 'error'
        }`,
      );
    }
  }
  return out;
}

/**
 * A submitted scorecard answer, stamped by the server: `againstFetchedAt` is the card version
 * answered against, from the client's echo clamped by {@link answeredAgainstFetchedAt} (an
 * echo later than the stored card or in the future, or no echo ⇒ the stored card's
 * `fetchedAt`). An echo OLDER than the stored card means the captain answered a card that has
 * since been replaced, so the answer is stored `stale` straight away. No available card ⇒ no
 * `againstFetchedAt` (the answer is kept as given). `stale` from the client never survives.
 */
export function stampScorecardAnswer(
  answer: CaptainsReportScorecardAnswer,
  card: Pick<StoredFixtureScorecard, 'available' | 'fetchedAt'> | null,
  now: Date,
): CaptainsReportScorecardAnswer {
  const { againstFetchedAt: echo, stale: _s, ...rest } = answer;
  const against = answeredAgainstFetchedAt(echo, card, now);
  if (!against) return rest;
  const stale = !!card?.available && Date.parse(against) < Date.parse(card.fetchedAt);
  return { ...rest, againstFetchedAt: against, ...(stale ? { stale: true as const } : {}) };
}

/** A draft's scorecard answer: as given, without the submission-only stamps. */
export function draftScorecardAnswer(
  answer: CaptainsReportScorecardAnswer | undefined,
): CaptainsReportScorecardAnswer | undefined {
  if (!answer) return undefined;
  const { againstFetchedAt: _a, stale: _s, ...rest } = answer;
  return rest;
}

/** The match scorecard a report's form shows, and what to show when there is none. */
export interface ScorecardContext {
  /** An AVAILABLE stored card only; `fetchedAt` is echoed back with the answer. */
  scorecard?: { matchState?: string; innings: InningsScorecardWire[]; fetchedAt: string };
  /** The headline result — only a recorded result that was not cleared. */
  result?: {
    homeScore: string | null;
    awayScore: string | null;
    summary?: string;
    winner?: 'home' | 'away' | 'tie' | 'none';
  };
  /** Medicoach's own match page (http(s) only). */
  medicoachMatchUrl?: string;
}

/**
 * The scorecard context for ONE report's detail view (the `/r/` link and the portal's report
 * route — never lists): two GetItems. Empty for an unlisted match (it has no fixture).
 */
export async function attachScorecardContext(
  repo: Pick<RepoModule, 'getFixtureScorecard' | 'getFixtureResult'>,
  tenant: string,
  report: Pick<CaptainsReport, 'seriesId' | 'fixtureId' | 'source'>,
): Promise<ScorecardContext> {
  if (report.seriesId === UNLISTED_SERIES_ID || report.source === 'manual-unlisted') return {};
  const [card, res] = await Promise.all([
    repo.getFixtureScorecard(tenant, report.seriesId, report.fixtureId),
    repo.getFixtureResult(tenant, report.seriesId, report.fixtureId),
  ]);
  const live = res && !res.cleared && res.recordedAt ? res : null;
  const url = live ? httpUrlOrNull(live.medicoachMatchUrl) : null;
  return {
    ...(card?.available
      ? {
          scorecard: {
            ...(card.matchState !== undefined ? { matchState: card.matchState } : {}),
            innings: card.innings ?? [],
            fetchedAt: card.fetchedAt,
          },
        }
      : {}),
    ...(live
      ? {
          result: {
            homeScore: live.homeScore ?? null,
            awayScore: live.awayScore ?? null,
            ...(live.summary ? { summary: live.summary } : {}),
            ...(live.winner ? { winner: live.winner } : {}),
          },
        }
      : {}),
    ...(url ? { medicoachMatchUrl: url } : {}),
  };
}

/** "Umzinto CC v African Warriors (Premier T20), Sun 4 Oct 2026" — home side first. */
export function reportFixtureLine(
  r: Pick<CaptainsReport, 'side' | 'clubName' | 'opponentName' | 'competition' | 'matchDate'>,
): string {
  const home = r.side === 'home' ? r.clubName : r.opponentName;
  const away = r.side === 'home' ? r.opponentName : r.clubName;
  return (
    `${home} v ${away}` +
    (r.competition ? ` (${r.competition})` : '') +
    `, ${formatWeekdayDayYear(r.matchDate)}`
  );
}

// ───────────────────────── Operator console ─────────────────────────

/** The console's window: `days` back from the tenant's today (default 14, capped at 60). */
export const CONSOLE_DAYS_DEFAULT = 14;
export const CONSOLE_DAYS_MAX = 60;
/** At most this many fixture rows per response (newest first); `truncated` says when cut. */
export const CONSOLE_ROW_CAP = 500;

export const CONSOLE_STATUSES = [
  'all',
  'pending',
  'confirmed',
  'correction',
  'stale',
  'not-asked',
] as const;
export type ConsoleStatusFilter = (typeof CONSOLE_STATUSES)[number];

/**
 * One side's scorecard state:
 * - `n/a` — no available card for the match (nothing to confirm against);
 * - `pending` — the report is still open and a card is there to answer;
 * - `not-asked` — the report closed (submitted / void) without an answer while a card exists
 *   (incl. reports submitted before the card arrived, and pre-pivot submissions);
 * - `confirmed` / `correction` — the SUBMITTED answer;
 * - `stale` — a submitted answer against a card that has since changed (wins over both).
 * A draft answer on an open report does not count — only a submitted one does.
 */
export type ScorecardConsoleStatus =
  | 'n/a'
  | 'pending'
  | 'not-asked'
  | 'confirmed'
  | 'correction'
  | 'stale';

export interface ScorecardConsoleCell {
  reportId: string;
  /** `CR-YYYY-NNNN` — only once submitted. */
  reportRef?: string;
  clubId: string;
  clubName: string;
  reportStatus: CaptainsReport['status'];
  scorecardStatus: ScorecardConsoleStatus;
  /** The submitted answer behind a `stale` status. */
  answeredAction?: CaptainsReportScorecardAnswer['action'];
  /** A submitted correction's text. */
  feedback?: string;
  submittedAt?: string;
}

export interface ScorecardConsoleRow {
  seriesId: string;
  fixtureId: string;
  matchDate: string;
  competition: string;
  homeTeamName: string;
  awayTeamName: string;
  home?: ScorecardConsoleCell;
  away?: ScorecardConsoleCell;
}

export interface ScorecardConsoleTenant {
  tenant: string;
  tenantName: string;
  rows: ScorecardConsoleRow[];
}

export interface ScorecardConsolePayload {
  days: number;
  status: ConsoleStatusFilter;
  /** The first match date in the window (YYYY-MM-DD, tenant time). */
  since: string;
  /** Fixture rows matching the filter before the cap. */
  total: number;
  truncated: boolean;
  tenants: ScorecardConsoleTenant[];
}

export function scorecardConsoleStatus(
  r: Pick<CaptainsReport, 'status' | 'scorecard'>,
  cardAvailable: boolean,
): ScorecardConsoleStatus {
  if (r.status === 'submitted' && r.scorecard) {
    return r.scorecard.stale ? 'stale' : r.scorecard.action;
  }
  if (!cardAvailable) return 'n/a';
  return r.status === 'pending' ? 'pending' : 'not-asked';
}

export function scorecardConsoleCell(
  r: CaptainsReport,
  cardAvailable: boolean,
): ScorecardConsoleCell {
  const scorecardStatus = scorecardConsoleStatus(r, cardAvailable);
  const answered = r.status === 'submitted' ? r.scorecard : undefined;
  return {
    reportId: r.id,
    ...(r.ref ? { reportRef: r.ref } : {}),
    clubId: r.clubId,
    clubName: r.clubName,
    reportStatus: r.status,
    scorecardStatus,
    ...(scorecardStatus === 'stale' && answered ? { answeredAction: answered.action } : {}),
    ...(answered?.action === 'correction' && answered.feedback
      ? { feedback: answered.feedback }
      : {}),
    ...(r.submittedAt ? { submittedAt: r.submittedAt } : {}),
  };
}

/** The first match date a `days` window covers, in tenant time. */
export function consoleSince(days: number, now: Date): string {
  return tenantDate(new Date(now.getTime() - days * 24 * 3600 * 1000));
}

/**
 * One tenant's reports → fixture rows pairing both sides (home / away), newest first. Reports
 * outside the window and unlisted matches (no fixture, never a card) are left out.
 */
export function pairScorecardConsoleRows(
  reports: CaptainsReport[],
  cards: Map<string, { available: boolean }>,
  since: string,
): ScorecardConsoleRow[] {
  const rows = new Map<string, ScorecardConsoleRow>();
  for (const r of reports) {
    if (r.seriesId === UNLISTED_SERIES_ID || r.source === 'manual-unlisted') continue;
    if (r.matchDate < since) continue;
    const key = `${r.seriesId}#${r.fixtureId}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        seriesId: r.seriesId,
        fixtureId: r.fixtureId,
        matchDate: r.matchDate,
        competition: r.competition,
        homeTeamName: r.side === 'home' ? r.clubName : r.opponentName,
        awayTeamName: r.side === 'home' ? r.opponentName : r.clubName,
      };
      rows.set(key, row);
    }
    row[r.side] = scorecardConsoleCell(r, cards.get(key)?.available === true);
  }
  return [...rows.values()].sort(
    (a, b) =>
      b.matchDate.localeCompare(a.matchDate) ||
      `${a.seriesId}#${a.fixtureId}`.localeCompare(`${b.seriesId}#${b.fixtureId}`),
  );
}

/** A row matches a status filter when EITHER side has that status. */
export function consoleRowMatches(row: ScorecardConsoleRow, status: ConsoleStatusFilter) {
  if (status === 'all') return true;
  return row.home?.scorecardStatus === status || row.away?.scorecardStatus === status;
}

/**
 * Cross-tenant scorecard status of captains reports, for the operator console. Tenants are
 * read one at a time (one CAPREPORT Query each — the partition is not date-keyed, so the
 * window is applied here); scorecards via a projected BatchGet over the window's fixtures.
 * Rows are capped at `rowCap` across tenants, newest match first.
 */
export async function loadScorecardConsole(
  repo: Pick<RepoModule, 'listTenants' | 'listCaptainsReports' | 'getFixtureScorecardAvailability'>,
  opts: { days: number; status: ConsoleStatusFilter; now: Date; rowCap?: number },
): Promise<ScorecardConsolePayload> {
  const since = consoleSince(opts.days, opts.now);
  const rowCap = opts.rowCap ?? CONSOLE_ROW_CAP;
  const all: Array<{ tenant: string; tenantName: string; row: ScorecardConsoleRow }> = [];
  for (const cfg of await repo.listTenants()) {
    const reports = (await repo.listCaptainsReports(cfg.tenant)).filter(
      (r) =>
        r.matchDate >= since && r.seriesId !== UNLISTED_SERIES_ID && r.source !== 'manual-unlisted',
    );
    if (!reports.length) continue;
    const cards = await repo.getFixtureScorecardAvailability(
      cfg.tenant,
      reports.map((r) => ({ seriesId: r.seriesId, fixtureId: r.fixtureId })),
    );
    const tenantName = orgCopy(cfg).name;
    for (const row of pairScorecardConsoleRows(reports, cards, since))
      if (consoleRowMatches(row, opts.status)) all.push({ tenant: cfg.tenant, tenantName, row });
  }
  all.sort(
    (a, b) =>
      b.row.matchDate.localeCompare(a.row.matchDate) || a.tenantName.localeCompare(b.tenantName),
  );
  const kept = all.slice(0, rowCap);
  const byTenant = new Map<string, ScorecardConsoleTenant>();
  for (const { tenant, tenantName, row } of kept) {
    let t = byTenant.get(tenant);
    if (!t) byTenant.set(tenant, (t = { tenant, tenantName, rows: [] }));
    t.rows.push(row);
  }
  return {
    days: opts.days,
    status: opts.status,
    since,
    total: all.length,
    truncated: all.length > kept.length,
    tenants: [...byTenant.values()].sort((a, b) => a.tenantName.localeCompare(b.tenantName)),
  };
}
