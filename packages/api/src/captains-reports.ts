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
 * deletes it once the reports opened + notified. A failure leaves it for
 * `retryPendingReportOpens` (every cron run and "Sync now"); after REPORT_OPEN_MAX_ATTEMPTS it
 * gives up and reports to Sentry. Re-opening is idempotent (per fixture + club), and the
 * NOTIFY# ledger claim guarantees nothing is ever sent twice.
 *
 * PII: a `captainRef` is a player ref — an unsalted hash of an SA ID number. It is resolved to
 * a roster row here and then dropped: it is never stored on the report, never put in a token
 * and never logged. Log lines carry report ids (series/fixture/club ids) and counts only.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  CONCERN_AREAS,
  RATING_CRITERIA,
  isReportLate,
  reportDeadline,
  type AppointedUmpire,
  type ReportUmpireEntry,
} from '../../engine/src/captainsReport.js';
import { isSlotRef } from '../../engine/src/formats.js';
import { orgCopy } from './branding.js';
import { chairContactOf } from './club-contacts.js';
import { captainsReportLinkBase, captainsReportLinkSecret } from './env.js';
import { hasFeature } from './features.js';
import { toE164 } from './notify/e164.js';
import type {
  CaptainsReport,
  CaptainsReportRecipient,
  Club,
  Series,
  StoredFixtureResult,
  TenantConfig,
} from './types.js';
import type { SyncResult } from './medicoach-sync-contract.js';

type RepoModule = typeof import('./repo.js');

/** Results for matches older than this never open reports (a late backfill, a re-pull). */
export const MAX_REPORT_AGE_DAYS = 14;
/** A link stays usable this long after the report's deadline (late reports are accepted). */
export const LINK_GRACE_DAYS = 7;
/** REPORTOPEN# retries (the puller's own try included) before giving up with Sentry. */
export const REPORT_OPEN_MAX_ATTEMPTS = 5;

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

/** The link for a report: `${base}/r/<token>`, expiring LINK_GRACE_DAYS after the deadline. */
export function reportLink(tenant: string, report: CaptainsReport, secret: string, base: string) {
  const exp = Math.floor((Date.parse(report.deadline) + LINK_GRACE_DAYS * DAY_MS) / 1000);
  const token = signReportLinkToken(
    { t: tenant, r: report.id, m: report.recipient.memberId, e: exp },
    secret,
  );
  return { token, url: `${base}/r/${token}` };
}

// ───────────────────────── Projections ─────────────────────────

/** What a club member / link holder / admin sees: never the recipient's opaque memberId. */
export type CaptainsReportView = Omit<CaptainsReport, 'recipient'> & {
  recipient: Omit<CaptainsReportRecipient, 'memberId'>;
  late: boolean;
};

export function reportView(r: CaptainsReport, nowIso: string): CaptainsReportView {
  const { memberId: _m, ...recipient } = r.recipient;
  return { ...r, recipient, late: isReportLate(r, nowIso) };
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

/** The editable fields of a report from a request body (unknown keys are dropped). */
export function parseReportFields(raw: unknown): {
  captainName: string;
  umpires: ReportUmpireEntry[];
  general: string;
  declaration: boolean;
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
  return {
    captainName: str(b.captainName, 120, "captain's name"),
    umpires,
    general: str(b.general, 4000, 'general comments'),
    declaration: b.declaration === true,
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
}

/** One outbound notice (the default sender fans it out over email + WhatsApp). */
export interface ReportNotice {
  tenant: string;
  reportId: string;
  recipientKind: 'captain' | 'chair';
  to: { name: string; email?: string; cell?: string };
  /** The chair, cc'd by email when the captain is the recipient. */
  ccEmail?: string;
  clubName: string;
  matchLine: string;
  matchDateText: string;
  deadlineText: string;
  orgName: string;
  token: string;
  url: string;
  channels: Array<'email' | 'whatsapp'>;
}

export interface NoticeResult {
  channel: 'email' | 'whatsapp';
  status: 'sent' | 'skipped' | 'failed';
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
}

export interface OpenOutcome {
  skipped?: 'import' | 'no-go-live' | 'before-go-live' | 'too-old' | 'no-fixture';
  opened: string[];
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

const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** "18h00 on Wed 7 Oct 2026" */
export const deadlineText = (deadline: string) => `18h00 on ${fmtDay(deadline.slice(0, 10))}`;

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

const hasContact = (c: { email?: string; cell?: string }) =>
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
 * `integrations.medicoach.goLiveDate` (unset ⇒ not live ⇒ skipped), and matches older than
 * MAX_REPORT_AGE_DAYS.
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
  const today = now().toISOString().slice(0, 10);
  if (Date.parse(today) - Date.parse(matchDate) > MAX_REPORT_AGE_DAYS * DAY_MS)
    return { ...out, skipped: 'too-old' };

  const deadline = reportDeadline(matchDate)!;
  const officials = await repo.getFixtureOfficials(tenant, seriesId, fixtureId);
  const umpiresSnapshot: AppointedUmpire[] = (officials?.umpires ?? []).map((u) => ({
    umpireId: u.umpireId,
    name: u.name,
  }));
  const byTeam = new Map((series.participants ?? []).map((p) => [p.teamId, p]));
  const homeTeam = fixture.home;
  const homeVenue = homeTeam ? byTeam.get(homeTeam)?.venue : undefined;
  const venue = fixture.venueOverride || fixture.venueName || homeVenue || '';

  const clubs = new Map<string, Club | null>();
  const sides = (['home', 'away'] as const).map((side) => {
    const teamId = fixture[side];
    if (typeof teamId !== 'string' || !teamId || isSlotRef(teamId)) return null;
    return { side, teamId, clubId: byTeam.get(teamId)?.clubId ?? teamId };
  });
  for (const s of sides) if (s) clubs.set(s.clubId, await repo.getClub(tenant, s.clubId));

  const nowIso = now().toISOString();
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
      deadline,
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
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    if (!(await repo.openCaptainsReportIfAbsent(tenant, report))) {
      // Already open. A retry (REPORTOPEN#) after a failed notify must still notify — the
      // NOTIFY# ledger claim makes this a no-op when the first send was already claimed.
      const existing = await repo.getCaptainsReport(tenant, seriesId, fixtureId, club.id);
      if (!existing || existing.status !== 'pending' || existing.source !== 'auto') continue;
      const toCaptain = existing.recipient.kind === 'captain' && captain;
      if (
        await notifyReportOpened(
          deps,
          tenant,
          config,
          existing,
          toCaptain ? captain : chair,
          toCaptain ? chair : null,
        )
      )
        out.notified.push(existing.id);
      continue;
    }
    out.opened.push(report.id);

    if (await notifyReportOpened(deps, tenant, config, report, contact, captain ? chair : null))
      out.notified.push(report.id);
  }
  return out;
}

/** Claim the NOTIFY# ledger row, then send. False when the send was already claimed. */
async function notifyReportOpened(
  deps: CaptainsReportDeps,
  tenant: string,
  config: TenantConfig,
  report: CaptainsReport,
  contact: { name: string; email?: string; cell?: string },
  ccChair: { email?: string } | null,
): Promise<boolean> {
  const { repo } = deps;
  // Everything that can throw BEFORE a send is resolved before the ledger claim, so a
  // failure (e.g. the link secret unset) leaves the claim free for the REPORTOPEN# retry.
  const secret = (deps.linkSecret ?? captainsReportLinkSecret)();
  const base = (deps.linkBase ?? captainsReportLinkBase)();
  const { token, url } = reportLink(tenant, report, secret, base);
  if (!(await repo.claimCaptainsReportNotify(tenant, report.id, 'recipient'))) return false;
  const home = report.side === 'home' ? report.clubName : report.opponentName;
  const away = report.side === 'home' ? report.opponentName : report.clubName;
  const cc =
    ccChair?.email && EMAIL_RE.test(ccChair.email) && ccChair.email !== contact.email
      ? ccChair.email
      : undefined;
  const notice: ReportNotice = {
    tenant,
    reportId: report.id,
    recipientKind: report.recipient.kind === 'captain' ? 'captain' : 'chair',
    to: contact,
    ...(cc ? { ccEmail: cc } : {}),
    clubName: report.clubName,
    matchLine: `${home} v ${away}`,
    matchDateText: fmtDay(report.matchDate),
    deadlineText: deadlineText(report.deadline),
    orgName: orgCopy(config).name,
    token,
    url,
    channels: hasFeature(config, 'whatsappInvites', true) ? ['email', 'whatsapp'] : ['email'],
  };
  const send = deps.sendNotice ?? sendReportNotice;
  let results: NoticeResult[];
  try {
    results = await send(notice);
  } catch (err) {
    results = notice.channels.map((channel) => ({
      channel,
      status: 'failed' as const,
      error: err instanceof Error ? err.message : 'send failed',
    }));
  }
  await repo.completeCaptainsReportNotify(tenant, report.id, 'recipient', results);
  return true;
}

/** The default sender: SES email (+ cc) and the `captains_report_due` WhatsApp template. */
export async function sendReportNotice(n: ReportNotice): Promise<NoticeResult[]> {
  const { sendCaptainsReportDueEmail } = await import('./notify/email.js');
  const { sendCaptainsReportDueWhatsApp } = await import('./notify/whatsapp.js');
  const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
  return Promise.all(
    n.channels.map(async (channel): Promise<NoticeResult> => {
      if (channel === 'email') {
        if (!n.to.email || !EMAIL_RE.test(n.to.email))
          return { channel, status: 'skipped', error: 'no valid email on file' };
        try {
          await sendCaptainsReportDueEmail({
            to: n.to.email,
            ...(n.ccEmail ? { cc: n.ccEmail } : {}),
            recipientName: n.to.name,
            recipientKind: n.recipientKind,
            clubName: n.clubName,
            matchLine: n.matchLine,
            matchDateText: n.matchDateText,
            deadlineText: n.deadlineText,
            link: n.url,
            orgName: n.orgName,
          });
          return { channel, status: 'sent' };
        } catch (err) {
          return { channel, status: 'failed', error: errMessage(err) };
        }
      }
      const e164 = toE164(n.to.cell);
      if (!e164) return { channel, status: 'skipped', error: 'no valid cell on file' };
      try {
        await sendCaptainsReportDueWhatsApp({
          to: e164,
          recipientName: n.to.name,
          clubName: n.clubName,
          match: `${n.matchLine}, ${n.matchDateText}`,
          deadline: n.deadlineText,
          token: n.token,
        });
        return { channel, status: 'sent' };
      } catch (err) {
        return { channel, status: 'failed', error: errMessage(err) };
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

/** A stored result back in the wire shape the report opener reads. */
function syncResultOf(r: StoredFixtureResult): SyncResult {
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
    captainRef: r.captainRef ?? null,
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
 * (import source, goLiveDate, the 14-day window). A marker whose result is gone, cleared, or
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
          result: syncResultOf(stored),
          config,
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
  | { ok: true; tenant: string; report: CaptainsReport; memberId: string }
  | { ok: false; status: 404 | 410; error: string }
> {
  const check = verifyReportLinkToken(token, secret, nowMs);
  if (!check.ok)
    return check.reason === 'expired'
      ? { ok: false, status: 410, error: 'this link has expired' }
      : { ok: false, status: 404, error: 'not found' };
  const { t: tenant, r: reportId, m: memberId } = check.payload;
  const key = parseCaptainsReportId(reportId);
  if (!key) return { ok: false, status: 404, error: 'not found' };
  const report = await repo.getCaptainsReport(tenant, key.seriesId, key.fixtureId, key.clubId);
  if (!report) return { ok: false, status: 404, error: 'not found' };
  if (report.status === 'submitted')
    return { ok: false, status: 410, error: 'this report has already been submitted' };
  if (report.status === 'void' || report.recipient.memberId !== memberId)
    return { ok: false, status: 410, error: 'this link is no longer valid' };
  return { ok: true, tenant, report, memberId };
}
