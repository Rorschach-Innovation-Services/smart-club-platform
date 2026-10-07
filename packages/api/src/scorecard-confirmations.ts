/**
 * Chair scorecard confirmation — the Monday digest (plan: chair scorecard confirmation).
 *
 * Each Monday the ScorecardConfirmations cron (crons/scorecard-confirmations.ts) gives every
 * club that played in the previous Mon–Sun week ONE digest (`SCORECONF#<weekKey>#<clubId>`)
 * listing those matches, and sends the club chair one link to it (`/sc/<token>`, email +
 * WhatsApp). On the page the chair confirms each match's scorecard or requests a correction
 * (free text, ≤ 2,000 chars); a correction emails the PLATFORM OPERATORS — never tenant admins.
 *
 * The link token is stateless: `{t, w, c, m, e}` (tenant, weekKey, clubId, the digest's random
 * memberId, expiry) HMAC-signed with the captain's-report link secret under its OWN context
 * (`scoreconf-link.v1.`), so a captain's-report token can never verify here or vice versa.
 * Rotating the memberId revokes the link. Each entry is answered once (first submit wins).
 *
 * A cleared result voids its entry; a newer scorecard fetched after the chair answered flags
 * the entry `staleConfirmation` (both via the medicoach sync, best-effort).
 *
 * PII: the digest holds club and team names, and the chair's own feedback. The public view
 * adds the scorecard's player names (already names-only) — never contacts or player refs.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import dayjs from 'dayjs';
import dayjsUtc from 'dayjs/plugin/utc.js';
import { formatSastWeekdayDay, formatWeekdayDayYear } from '../../../src/dates.js';
import type { NoticeResult } from './captains-reports.js';
import { captainsReportLinkBase } from './env.js';
import { httpUrlOrNull, type InningsScorecardWire } from './medicoach-sync-contract.js';
import { toE164 } from './notify/e164.js';
import { TENANT_UTC_OFFSET_MINUTES } from './tenant-time.js';
import type {
  CaptainsReportDelivery,
  CaptainsReportDeliveryReason,
  ScorecardConfirmation,
  ScorecardConfirmEntry,
  ScorecardConfirmEntryStatus,
  StoredFixtureResult,
  StoredFixtureScorecard,
} from './types.js';

dayjs.extend(dayjsUtc);

type RepoModule = typeof import('./repo.js');

/** The link works until the end of this SAST day after the digest was created. */
export const SCORECARD_LINK_VALID_DAYS = 14;
/** A correction request is capped at this many characters. */
export const SCORECARD_FEEDBACK_MAX = 2000;

const DAY_MS = 24 * 3600 * 1000;
const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;

// ───────────────────────── Weeks ─────────────────────────

const WEEK_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A valid YYYY-MM-DD that falls on a Sunday. */
export function isWeekKey(v: unknown): v is string {
  if (typeof v !== 'string' || !WEEK_KEY_RE.test(v)) return false;
  const d = dayjs.utc(v, 'YYYY-MM-DD');
  return d.isValid() && d.format('YYYY-MM-DD') === v && d.day() === 0;
}

/** The Sunday (YYYY-MM-DD) that closes the Mon–Sun week `date` (YYYY-MM-DD) falls in. */
export function weekKeyFor(date: string): string {
  const d = dayjs.utc(date.slice(0, 10));
  return d.add((7 - d.day()) % 7, 'day').format('YYYY-MM-DD');
}

/** The Mon–Sun window a weekKey closes: `[monday, sunday]`, both inclusive. */
export function windowForWeekKey(weekKey: string): [string, string] {
  return [dayjs.utc(weekKey).subtract(6, 'day').format('YYYY-MM-DD'), weekKey];
}

/** The SAST calendar day of an instant. */
const sastDay = (ms: number) =>
  new Date(ms + TENANT_UTC_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);

/**
 * The most recent COMPLETED Mon–Sun week at `now` (SAST): on a Monday that is the week that
 * ended yesterday; on a Sunday, the week that ended a week ago (today's is still running).
 */
export function lastCompletedWeekKey(now: Date): string {
  return dayjs
    .utc(weekKeyFor(sastDay(now.getTime())))
    .subtract(7, 'day')
    .format('YYYY-MM-DD');
}

/** "5–11 Oct 2026", "28 Sep – 4 Oct 2026", "29 Dec 2025 – 4 Jan 2026". */
export function weekLabel(weekKey: string): string {
  const [mon, sun] = windowForWeekKey(weekKey).map((d) => dayjs.utc(d));
  if (mon.year() !== sun.year()) return `${mon.format('D MMM YYYY')} – ${sun.format('D MMM YYYY')}`;
  if (mon.month() !== sun.month()) return `${mon.format('D MMM')} – ${sun.format('D MMM YYYY')}`;
  return `${mon.format('D')}–${sun.format('D MMM YYYY')}`;
}

// ───────────────────────── Link tokens ─────────────────────────

export interface ScorecardLinkPayload {
  /** tenant */
  t: string;
  /** weekKey (the Sunday closing the week) */
  w: string;
  /** clubId */
  c: string;
  /** the digest's memberId (opaque, random) */
  m: string;
  /** expiry, epoch seconds */
  e: number;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Its OWN context prefix: a captain's-report token (`capreport-link.v1.`) never verifies. */
function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(`scoreconf-link.v1.${payload}`).digest();
}

/** `<base64url(payload)>.<base64url(hmac)>` */
export function signScorecardLinkToken(p: ScorecardLinkPayload, secret: string): string {
  const payload = b64url(JSON.stringify(p));
  return `${payload}.${b64url(mac(secret, payload))}`;
}

export type ScorecardTokenCheck =
  | { ok: true; payload: ScorecardLinkPayload }
  | { ok: false; reason: 'invalid' | 'expired' };

/** Verify a digest token's signature (constant-time), shape and expiry. */
export function verifyScorecardLinkToken(
  token: string,
  secret: string,
  nowMs: number,
): ScorecardTokenCheck {
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
  let p: ScorecardLinkPayload;
  try {
    p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (
    !p ||
    typeof p.t !== 'string' ||
    typeof p.w !== 'string' ||
    typeof p.c !== 'string' ||
    typeof p.m !== 'string' ||
    typeof p.e !== 'number'
  )
    return { ok: false, reason: 'invalid' };
  if (nowMs / 1000 > p.e) return { ok: false, reason: 'expired' };
  return { ok: true, payload: p };
}

/** 23:59:59 SAST on the day SCORECARD_LINK_VALID_DAYS after `createdAtMs`, epoch seconds. */
export function scorecardLinkExpiry(createdAtMs: number): number {
  const day = sastDay(createdAtMs);
  return Math.floor(
    (Date.parse(`${day}T23:59:59Z`) -
      TENANT_UTC_OFFSET_MINUTES * 60_000 +
      SCORECARD_LINK_VALID_DAYS * DAY_MS) /
      1000,
  );
}

/** A stored digest's expiry in epoch seconds. */
export const scorecardExpirySeconds = (r: Pick<ScorecardConfirmation, 'linkExpiresAt'>) =>
  Math.floor(Date.parse(r.linkExpiresAt) / 1000);

/** The link for a digest: `${base}/sc/<token>`, expiring at the digest's stored expiry. */
export function scorecardLink(
  tenant: string,
  record: Pick<ScorecardConfirmation, 'weekKey' | 'clubId' | 'memberId' | 'linkExpiresAt'>,
  secret: string,
  base: string = captainsReportLinkBase(),
) {
  const token = signScorecardLinkToken(
    {
      t: tenant,
      w: record.weekKey,
      c: record.clubId,
      m: record.memberId,
      e: scorecardExpirySeconds(record),
    },
    secret,
  );
  return { token, url: `${base}/sc/${token}` };
}

/** The link route's digest lookup: 404 bad token / unknown digest, 410 expired / revoked. */
export async function loadLinkedScorecardConfirmation(
  repo: Pick<RepoModule, 'getScorecardConfirmation'>,
  token: string,
  nowMs: number,
  secret: string,
): Promise<
  | { ok: true; tenant: string; record: ScorecardConfirmation; memberId: string }
  | { ok: false; status: 404 | 410; error: string }
> {
  const check = verifyScorecardLinkToken(token, secret, nowMs);
  if (!check.ok)
    return check.reason === 'expired'
      ? { ok: false, status: 410, error: 'This link has expired.' }
      : { ok: false, status: 404, error: 'not found' };
  const { t: tenant, w: weekKey, c: clubId, m: memberId } = check.payload;
  if (!isWeekKey(weekKey)) return { ok: false, status: 404, error: 'not found' };
  const record = await repo.getScorecardConfirmation(tenant, weekKey, clubId);
  if (!record) return { ok: false, status: 404, error: 'not found' };
  if (record.memberId !== memberId)
    return { ok: false, status: 410, error: 'this link is no longer valid' };
  return { ok: true, tenant, record, memberId };
}

// ───────────────────────── Entries ─────────────────────────

/** `<seriesId>#<fixtureId>` — the key of an entry in `ScorecardConfirmation.entries`. */
export const scorecardEntryKey = (seriesId: string, fixtureId: string) =>
  `${seriesId}#${fixtureId}`;

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
  if (b.action === 'correction') {
    if (!feedback) throw new ScorecardInputError('feedback is required to request a correction');
    return { action: 'correction', feedback };
  }
  return { action: 'confirm', ...(feedback ? { feedback } : {}) };
}

// ───────────────────────── The public view ─────────────────────────

export interface ScorecardConfirmEntryView {
  entryKey: string;
  seriesId: string;
  fixtureId: string;
  homeTeamName: string;
  awayTeamName: string;
  fixtureDate: string;
  competition?: string;
  venue?: string;
  status: ScorecardConfirmEntryStatus;
  feedback?: string;
  submittedAt?: string;
  staleConfirmation?: boolean;
  result?: {
    homeScore: string | null;
    awayScore: string | null;
    summary?: string;
    winner?: 'home' | 'away' | 'tie' | 'none';
  };
  medicoachMatchUrl?: string;
  scorecard?: { matchState?: string; innings: InningsScorecardWire[] };
}

export interface ScorecardBranding {
  name: string;
  logoUrl: string;
  colors: Record<string, string>;
}

/** GET /scorecard-confirm-link/:token — the pinned shape the `/sc/` page builds against. */
export interface ScorecardConfirmView {
  clubName: string;
  weekKey: string;
  weekLabel: string;
  ref: string;
  linkExpiresAt: string;
  branding: ScorecardBranding;
  entries: ScorecardConfirmEntryView[];
}

/**
 * Assemble the link payload: each entry with its embedded scorecard (only a stored row with
 * `available: true`), else its headline result + the medicoach match link. Sorted by
 * fixture date, then entry key. Never the memberId, deliveries or anyone's contact.
 */
export function toScorecardConfirmView(
  record: ScorecardConfirmation,
  scorecardsByEntryKey: Map<string, StoredFixtureScorecard>,
  resultsByEntryKey: Map<string, StoredFixtureResult>,
  branding: ScorecardBranding,
): ScorecardConfirmView {
  const entries = Object.entries(record.entries ?? {})
    .map(([entryKey, e]): ScorecardConfirmEntryView => {
      const card = scorecardsByEntryKey.get(entryKey);
      const res = resultsByEntryKey.get(entryKey);
      const live = res && !res.cleared && res.recordedAt ? res : undefined;
      const url = live ? httpUrlOrNull(live.medicoachMatchUrl) : null;
      return {
        entryKey,
        seriesId: e.seriesId,
        fixtureId: e.fixtureId,
        homeTeamName: e.homeTeamName,
        awayTeamName: e.awayTeamName,
        fixtureDate: e.fixtureDate,
        ...(e.competition ? { competition: e.competition } : {}),
        ...(e.venue ? { venue: e.venue } : {}),
        status: e.status,
        ...(e.feedback ? { feedback: e.feedback } : {}),
        ...(e.submittedAt ? { submittedAt: e.submittedAt } : {}),
        ...(e.staleConfirmation ? { staleConfirmation: true } : {}),
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
        ...(card?.available
          ? {
              scorecard: {
                ...(card.matchState !== undefined ? { matchState: card.matchState } : {}),
                innings: card.innings ?? [],
              },
            }
          : {}),
      };
    })
    .sort(
      (a, b) => a.fixtureDate.localeCompare(b.fixtureDate) || a.entryKey.localeCompare(b.entryKey),
    );
  return {
    clubName: record.clubName,
    weekKey: record.weekKey,
    weekLabel: weekLabel(record.weekKey),
    ref: record.ref,
    linkExpiresAt: record.linkExpiresAt,
    branding,
    entries,
  };
}

// ───────────────────────── Operator console ─────────────────────────

export type ScorecardDeliveryView = Omit<CaptainsReportDelivery, 'messageId'>;

export interface PlatformScorecardSide {
  clubId: string;
  clubName: string;
  ref: string;
  status: ScorecardConfirmEntryStatus;
  feedback?: string;
  submittedAt?: string;
  staleConfirmation?: boolean;
  confirmedAgainstFetchedAt?: string;
  /** The digest's notice outcome: first delivered at, and the per-channel rows. */
  notifiedAt?: string;
  deliveries: ScorecardDeliveryView[];
}

export interface PlatformScorecardFixture {
  seriesId: string;
  fixtureId: string;
  fixtureDate: string;
  competition?: string;
  homeTeamName: string;
  awayTeamName: string;
  sides: PlatformScorecardSide[];
}

export interface PlatformScorecardRecord {
  clubId: string;
  clubName: string;
  ref: string;
  createdAt: string;
  linkExpiresAt: string;
  notifiedAt?: string;
  deliveries: ScorecardDeliveryView[];
  counts: Record<ScorecardConfirmEntryStatus, number>;
}

export interface PlatformScorecardTenant {
  tenant: string;
  tenantName: string;
  weekKey: string;
  enabled: boolean;
  fixtures: PlatformScorecardFixture[];
  records: PlatformScorecardRecord[];
}

const deliveriesView = (r: ScorecardConfirmation): ScorecardDeliveryView[] =>
  (r.deliveries ?? []).map(({ messageId: _m, ...d }) => d);

/**
 * One tenant's week for the operator console: fixtures with BOTH clubs' answers side by side
 * (the home side first), plus each digest's delivery status and entry counts.
 */
export function toPlatformScorecardTenant(
  tenant: string,
  tenantName: string,
  weekKey: string,
  enabled: boolean,
  records: ScorecardConfirmation[],
): PlatformScorecardTenant {
  const fixtures = new Map<string, PlatformScorecardFixture>();
  const sideRank = new Map<PlatformScorecardSide, number>();
  for (const r of records) {
    for (const [k, e] of Object.entries(r.entries ?? {})) {
      let f = fixtures.get(k);
      if (!f) {
        f = {
          seriesId: e.seriesId,
          fixtureId: e.fixtureId,
          fixtureDate: e.fixtureDate,
          ...(e.competition ? { competition: e.competition } : {}),
          homeTeamName: e.homeTeamName,
          awayTeamName: e.awayTeamName,
          sides: [],
        };
        fixtures.set(k, f);
      }
      const side: PlatformScorecardSide = {
        clubId: r.clubId,
        clubName: r.clubName,
        ref: r.ref,
        status: e.status,
        ...(e.feedback ? { feedback: e.feedback } : {}),
        ...(e.submittedAt ? { submittedAt: e.submittedAt } : {}),
        ...(e.staleConfirmation ? { staleConfirmation: true } : {}),
        ...(e.confirmedAgainstFetchedAt
          ? { confirmedAgainstFetchedAt: e.confirmedAgainstFetchedAt }
          : {}),
        ...(r.notifiedAt ? { notifiedAt: r.notifiedAt } : {}),
        deliveries: deliveriesView(r),
      };
      sideRank.set(side, e.side === 'away' ? 1 : 0);
      f.sides.push(side);
    }
  }
  for (const f of fixtures.values())
    f.sides.sort(
      (a, b) =>
        (sideRank.get(a) ?? 0) - (sideRank.get(b) ?? 0) || a.clubName.localeCompare(b.clubName),
    );
  const counts = (r: ScorecardConfirmation) => {
    const c: Record<ScorecardConfirmEntryStatus, number> = {
      pending: 0,
      confirmed: 0,
      correction: 0,
      void: 0,
    };
    for (const e of Object.values(r.entries ?? {})) c[e.status]++;
    return c;
  };
  return {
    tenant,
    tenantName,
    weekKey,
    enabled,
    fixtures: [...fixtures.values()].sort(
      (a, b) =>
        a.fixtureDate.localeCompare(b.fixtureDate) ||
        `${a.seriesId}#${a.fixtureId}`.localeCompare(`${b.seriesId}#${b.fixtureId}`),
    ),
    records: records
      .map((r) => ({
        clubId: r.clubId,
        clubName: r.clubName,
        ref: r.ref,
        createdAt: r.createdAt,
        linkExpiresAt: r.linkExpiresAt,
        ...(r.notifiedAt ? { notifiedAt: r.notifiedAt } : {}),
        deliveries: deliveriesView(r),
        counts: counts(r),
      }))
      .sort((a, b) => a.clubName.localeCompare(b.clubName)),
  };
}

// ───────────────────────── Notices ─────────────────────────

/** One outbound digest notice (the default sender fans it out over email + WhatsApp). */
export interface ScorecardNotice {
  tenant: string;
  weekKey: string;
  clubId: string;
  to: { name: string; email?: string; cell?: string };
  clubName: string;
  orgName: string;
  weekLabel: string;
  matchCount: number;
  /** "Sunday, 25 Oct" — when the link stops working. */
  expiresText: string;
  token: string;
  url: string;
  channels: Array<'email' | 'whatsapp'>;
}

let defaultNoticeSender: (n: ScorecardNotice) => Promise<NoticeResult[]> = (n) =>
  sendScorecardNotice(n);

/** The sender used when no `deps.sendNotice` is given. Tests/local only; `undefined` restores. */
export function setDefaultScorecardNoticeSender(
  fn: ((n: ScorecardNotice) => Promise<NoticeResult[]>) | undefined,
): void {
  defaultNoticeSender = fn ?? ((n) => sendScorecardNotice(n));
}

export const defaultScorecardNoticeSender = (n: ScorecardNotice) => defaultNoticeSender(n);

/**
 * The default sender: SES email and the `scorecard_confirm_due` WhatsApp template. Each
 * channel says why it was not sent (`no-email`, `no-cell`, `template-pending`,
 * `send-failed`); a dry-run send returns a `dry-run-` id, which the caller records as not sent.
 */
export async function sendScorecardNotice(n: ScorecardNotice): Promise<NoticeResult[]> {
  const { sendScorecardConfirmEmail } = await import('./notify/email.js');
  const { sendScorecardConfirmDueWhatsApp, WhatsAppTemplatePendingError } =
    await import('./notify/whatsapp.js');
  const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
  return Promise.all(
    n.channels.map(async (channel): Promise<NoticeResult> => {
      if (channel === 'email') {
        if (!n.to.email || !EMAIL_RE.test(n.to.email))
          return { channel, status: 'skipped', reason: 'no-email' };
        try {
          const { messageId } = await sendScorecardConfirmEmail({
            to: n.to.email,
            chairName: n.to.name,
            clubName: n.clubName,
            weekLabel: n.weekLabel,
            matchCount: n.matchCount,
            expiresText: n.expiresText,
            link: n.url,
            orgName: n.orgName,
          });
          return { channel, status: 'sent', messageId };
        } catch (err) {
          return { channel, status: 'failed', reason: 'send-failed', error: errMessage(err) };
        }
      }
      const e164 = toE164(n.to.cell);
      if (!e164) return { channel, status: 'skipped', reason: 'no-cell' };
      try {
        const { messageId } = await sendScorecardConfirmDueWhatsApp({
          to: e164,
          chairName: n.to.name,
          clubName: n.clubName,
          weekLabel: n.weekLabel,
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

/** A send outcome as a stored delivery: a dry-run "send" is recorded as not sent. */
export function scorecardDeliveryOf(r: NoticeResult, at: string): CaptainsReportDelivery {
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
    purpose: 'opened',
    recipientKind: 'chair',
  };
}

/** "Sunday, 25 Oct" — the SAST day a digest link expires. */
export const scorecardExpiresText = (r: Pick<ScorecardConfirmation, 'linkExpiresAt'>) =>
  formatSastWeekdayDay(r.linkExpiresAt);

// ───────────────────────── Correction → operators ─────────────────────────

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

/** "Umzinto CC v African Warriors (Premier T20), Sun 4 Oct 2026" */
export function scorecardFixtureLine(e: ScorecardConfirmEntry): string {
  return (
    `${e.homeTeamName} v ${e.awayTeamName}` +
    (e.competition ? ` (${e.competition})` : '') +
    `, ${formatWeekdayDayYear(e.fixtureDate)}`
  );
}

/**
 * Email every platform operator about a chair's correction request. Best-effort: the caller
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
        `[scorecard-confirm] correction notice ${input.ref}: an operator email failed — ${
          err instanceof Error ? err.name : 'error'
        }`,
      );
    }
  }
  return out;
}

// ───────────────────────── Sync hooks (void / stale) ─────────────────────────

type HookRepo = Pick<
  RepoModule,
  'listScorecardConfirmations' | 'voidScorecardConfirmEntry' | 'flagScorecardEntryStale'
>;

/** A cleared result: void its entry in every digest that lists it. Returns how many. */
export async function voidScorecardEntriesForFixture(
  repo: HookRepo,
  tenant: string,
  seriesId: string,
  fixtureId: string,
): Promise<number> {
  const k = scorecardEntryKey(seriesId, fixtureId);
  let n = 0;
  for (const r of await repo.listScorecardConfirmations(tenant)) {
    const e = r.entries?.[k];
    if (!e || e.status === 'void') continue;
    if (await repo.voidScorecardConfirmEntry(tenant, r.weekKey, r.clubId, k)) n++;
  }
  return n;
}

/**
 * A scorecard was (re)fetched at `fetchedAt`: flag every ANSWERED entry for that fixture that
 * was submitted before it as `staleConfirmation`. Returns how many were flagged.
 */
export async function flagStaleScorecardEntries(
  repo: HookRepo,
  tenant: string,
  seriesId: string,
  fixtureId: string,
  fetchedAt: string,
): Promise<number> {
  const k = scorecardEntryKey(seriesId, fixtureId);
  let n = 0;
  for (const r of await repo.listScorecardConfirmations(tenant)) {
    const e = r.entries?.[k];
    if (!e || (e.status !== 'confirmed' && e.status !== 'correction') || e.staleConfirmation)
      continue;
    if (!e.submittedAt || e.submittedAt >= fetchedAt) continue;
    if (await repo.flagScorecardEntryStale(tenant, r.weekKey, r.clubId, k, fetchedAt)) n++;
  }
  return n;
}
