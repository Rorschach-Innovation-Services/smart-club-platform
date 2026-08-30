/**
 * Notification orchestrator. Validates recipients per channel and fans email +
 * WhatsApp out concurrently (each channel never throws — failures become a
 * `failed`/`skipped` result so one bad channel can't sink the other). The HTTP
 * routes record these results and return them to the caller verbatim, so the
 * toast reflects reality instead of optimism.
 */
import type { Club, Channel, SendResult, PlayerRegistration, RejectOutcome } from '../types.js';
import {
  sendStaffInviteEmail,
  sendFixturesEmail,
  sendRegLinkEmail,
  sendClearanceEmail,
  sendClearanceResolvedEmail,
  sendClearanceReopenedSourceEmail,
  sendClearanceReopenedDestEmail,
} from './email.js';
import type { TutorialLink, RegLinkOrgCopy } from './email.js';
import {
  sendStaffInviteWhatsApp,
  sendFixturesWhatsApp,
  sendRegLinkWhatsApp,
  sendClearanceWhatsApp,
  toE164,
} from './whatsapp.js';

// Re-export so existing import sites (index.ts) keep resolving these from here.
export type { Channel, SendResult } from '../types.js';

// Kept identical to the backend EMAIL_RE (index.ts) / frontend so a value that
// passes the form can't be rejected here.
const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;

/** The staff (admin/rep) invite recipient. */
interface Contact {
  name: string;
  email: string;
  cell: string;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function sendEmailChannel(
  contact: Contact,
  orgName: string,
  link: string,
): Promise<SendResult> {
  if (!EMAIL_RE.test(contact.email)) {
    // Keep an invalid-but-present value for diagnostics; omit `to` entirely when blank.
    return {
      channel: 'email',
      status: 'skipped',
      ...(contact.email ? { to: contact.email } : {}),
      error: 'no valid staff email on file',
    };
  }
  try {
    const { messageId } = await sendStaffInviteEmail({
      to: contact.email,
      name: contact.name,
      orgName,
      link,
    });
    return { channel: 'email', status: 'sent', to: contact.email, messageId };
  } catch (err) {
    return { channel: 'email', status: 'failed', to: contact.email, error: errMessage(err) };
  }
}

async function sendWhatsAppChannel(
  contact: Contact,
  orgName: string,
  link: string,
): Promise<SendResult> {
  const e164 = toE164(contact.cell);
  if (!e164) {
    return {
      channel: 'whatsapp',
      status: 'skipped',
      ...(contact.cell ? { to: contact.cell } : {}),
      error: 'no valid staff cell on file',
    };
  }
  try {
    const { messageId } = await sendStaffInviteWhatsApp({
      to: e164,
      name: contact.name,
      orgName,
      link,
    });
    return { channel: 'whatsapp', status: 'sent', to: e164, messageId };
  } catch (err) {
    return { channel: 'whatsapp', status: 'failed', to: e164, error: errMessage(err) };
  }
}

/**
 * Send the generic staff (admin/rep) invite — "you've been added to {orgName}" — over
 * email and/or WhatsApp. Non-throwing per-channel results (a bad/blank contact becomes
 * a `skipped`/`failed` result, never sinking the other channel). Email is the primary
 * staff channel; WhatsApp is best-effort.
 */
export async function sendStaffInvite(args: {
  email: string;
  name?: string;
  cell?: string;
  orgName: string;
  channels: Channel[];
  link: string;
}): Promise<{ results: SendResult[] }> {
  const { email, name, cell, orgName, channels, link } = args;
  const contact: Contact = {
    name: (name ?? '').trim(),
    email: (email ?? '').trim(),
    cell: (cell ?? '').trim(),
  };
  // Concurrent fan-out keeps worst-case latency to the slowest single channel rather
  // than the sum (only ≤2 calls — one recipient × ≤2 channels). Order is preserved.
  // Note: WhatsApp retries on rate-limit; SES (email) does not.
  const results = await Promise.all(
    channels.map((channel) =>
      channel === 'email'
        ? sendEmailChannel(contact, orgName, link)
        : sendWhatsAppChannel(contact, orgName, link),
    ),
  );
  return { results };
}

// ───────────────────────── Chair onboarding (reg link + tutorials) ─────────────────────────

interface ChairContact {
  name: string;
  email: string;
  cell: string;
}

interface OnboardingTutorials {
  /** Absolute URL of the in-app /tutorials page. */
  pageUrl: string;
  /** Direct video links (absolute URLs) listed in the email body. */
  videos: TutorialLink[];
}

async function sendOnboardingEmail(
  chair: ChairContact,
  clubName: string,
  season: string,
  regLink: string,
  tutorials: OnboardingTutorials,
  org: RegLinkOrgCopy,
): Promise<SendResult> {
  if (!EMAIL_RE.test(chair.email)) {
    return {
      channel: 'email',
      status: 'skipped',
      ...(chair.email ? { to: chair.email } : {}),
      error: 'no valid chair email on file',
    };
  }
  try {
    const { messageId } = await sendRegLinkEmail({
      to: chair.email,
      chairName: chair.name,
      clubName,
      season,
      link: regLink,
      org,
      tutorials,
    });
    return { channel: 'email', status: 'sent', to: chair.email, messageId };
  } catch (err) {
    return { channel: 'email', status: 'failed', to: chair.email, error: errMessage(err) };
  }
}

async function sendOnboardingWhatsApp(
  chair: ChairContact,
  clubName: string,
  regLink: string,
  tutorialsUrl: string,
): Promise<SendResult> {
  const e164 = toE164(chair.cell);
  if (!e164) {
    return {
      channel: 'whatsapp',
      status: 'skipped',
      ...(chair.cell ? { to: chair.cell } : {}),
      error: 'no valid chair cell on file',
    };
  }
  try {
    const { messageId } = await sendRegLinkWhatsApp({
      to: e164,
      chairName: chair.name,
      clubName,
      regLink,
      tutorialsUrl,
    });
    return { channel: 'whatsapp', status: 'sent', to: e164, messageId };
  } catch (err) {
    return { channel: 'whatsapp', status: 'failed', to: e164, error: errMessage(err) };
  }
}

/**
 * Deliver the chair's onboarding bundle — their club's player-registration link plus the
 * how-to-use-the-app tutorials — over email and/or WhatsApp, the moment affiliation
 * completes. The reg-link email carries the tutorials section inline; the reg-link
 * WhatsApp carries the tutorials-page URL. Non-throwing per channel (a bad/blank chair
 * contact becomes a `skipped`/`failed` result, never sinking the other channel). Email is
 * primary; WhatsApp is best-effort.
 */
export async function sendChairOnboarding(args: {
  chair: { name?: string; email?: string; cell?: string };
  clubName: string;
  channels: Channel[];
  regLink: string;
  tutorials: OnboardingTutorials;
  season: string;
  /** Tenant org copy for the email body (see orgCopy in branding.ts). */
  org: RegLinkOrgCopy;
}): Promise<{ results: SendResult[] }> {
  const { chair, clubName, channels, regLink, tutorials, season, org } = args;
  const contact: ChairContact = {
    name: (chair.name ?? '').trim(),
    email: (chair.email ?? '').trim(),
    cell: (chair.cell ?? '').trim(),
  };
  const results = await Promise.all(
    channels.map((channel) =>
      channel === 'email'
        ? sendOnboardingEmail(contact, clubName, season, regLink, tutorials, org)
        : sendOnboardingWhatsApp(contact, clubName, regLink, tutorials.pageUrl),
    ),
  );
  return { results };
}

// ───────────────────────── Clearance pending (chairman heads-up) ─────────────────────────

interface ClearanceCopy {
  fromClubName: string;
  playerName: string;
  toClubName: string;
}

async function sendClearanceEmailChannel(
  chair: ChairContact,
  copy: ClearanceCopy,
): Promise<SendResult> {
  if (!EMAIL_RE.test(chair.email)) {
    return {
      channel: 'email',
      status: 'skipped',
      ...(chair.email ? { to: chair.email } : {}),
      error: 'no valid chair email on file',
    };
  }
  try {
    const { messageId } = await sendClearanceEmail({
      to: chair.email,
      chairName: chair.name,
      ...copy,
    });
    return { channel: 'email', status: 'sent', to: chair.email, messageId };
  } catch (err) {
    return { channel: 'email', status: 'failed', to: chair.email, error: errMessage(err) };
  }
}

async function sendClearanceWhatsAppChannel(
  chair: ChairContact,
  copy: ClearanceCopy,
): Promise<SendResult> {
  const e164 = toE164(chair.cell);
  if (!e164) {
    return {
      channel: 'whatsapp',
      status: 'skipped',
      ...(chair.cell ? { to: chair.cell } : {}),
      error: 'no valid chair cell on file',
    };
  }
  try {
    const { messageId } = await sendClearanceWhatsApp({
      to: e164,
      chairName: chair.name,
      ...copy,
    });
    return { channel: 'whatsapp', status: 'sent', to: e164, messageId };
  } catch (err) {
    return { channel: 'whatsapp', status: 'failed', to: e164, error: errMessage(err) };
  }
}

/**
 * Tell the FROM-club chairman a clearance now awaits the club's decision, over email
 * and/or WhatsApp. Non-throwing per channel (a bad/blank chair contact becomes a
 * `skipped`/`failed` result, never sinking the other channel). The caller owns the
 * daily cap and the comm-log append — this only fans out the channels.
 */
export async function sendClearanceNotice(args: {
  chair: { name?: string; email?: string; cell?: string };
  fromClubName: string;
  playerName: string;
  toClubName: string;
  channels: Channel[];
}): Promise<{ results: SendResult[] }> {
  const { chair, fromClubName, playerName, toClubName, channels } = args;
  const contact: ChairContact = {
    name: (chair.name ?? '').trim(),
    email: (chair.email ?? '').trim(),
    cell: (chair.cell ?? '').trim(),
  };
  const copy: ClearanceCopy = { fromClubName, playerName, toClubName };
  const results = await Promise.all(
    channels.map((channel) =>
      channel === 'email'
        ? sendClearanceEmailChannel(contact, copy)
        : sendClearanceWhatsAppChannel(contact, copy),
    ),
  );
  return { results };
}

// ───────────────────────── Clearance resolved (both clubs' chairs) ─────────────────────────

interface ClearanceResolvedCopy {
  fromClubName: string;
  playerName: string;
  toClubName: string;
  outcome: 'approved' | 'rejected';
  /** Admin note carried in the resolved email body. */
  reason?: string;
  /** Reject outcome — steers the rejected email copy (see ClearanceResolvedEmailInput). */
  rejectOutcome?: RejectOutcome;
}

async function sendClearanceResolvedEmailChannel(
  chair: ChairContact,
  copy: ClearanceResolvedCopy,
): Promise<SendResult> {
  if (!EMAIL_RE.test(chair.email)) {
    return {
      channel: 'email',
      status: 'skipped',
      ...(chair.email ? { to: chair.email } : {}),
      error: 'no valid chair email on file',
    };
  }
  try {
    const { messageId } = await sendClearanceResolvedEmail({
      to: chair.email,
      chairName: chair.name,
      ...copy,
    });
    return { channel: 'email', status: 'sent', to: chair.email, messageId };
  } catch (err) {
    return { channel: 'email', status: 'failed', to: chair.email, error: errMessage(err) };
  }
}

/**
 * Tell a club chairman the union office has RESOLVED a clearance (issued or declined it).
 * Email only by design — the pending notice is the one that needs a response; resolutions are
 * informational, the email carries the reason, and 2 clubs × 2 channels per resolution was
 * judged too much WhatsApp volume (each business-initiated message is a billed Meta
 * conversation). Called once per club (source and destination) by the caller, who owns the
 * comm-log append. Non-throwing (a bad/blank chair email becomes a `skipped`/`failed` result),
 * so the comm log still records a `skipped` row when there is no chair email on file.
 */
export async function sendClearanceResolvedNotice(args: {
  chair: { name?: string; email?: string; cell?: string };
  fromClubName: string;
  playerName: string;
  toClubName: string;
  outcome: 'approved' | 'rejected';
  reason?: string;
  rejectOutcome?: RejectOutcome;
}): Promise<{ results: SendResult[] }> {
  const { chair, fromClubName, playerName, toClubName, outcome, reason, rejectOutcome } = args;
  const contact: ChairContact = {
    name: (chair.name ?? '').trim(),
    email: (chair.email ?? '').trim(),
    cell: (chair.cell ?? '').trim(),
  };
  const copy: ClearanceResolvedCopy = {
    fromClubName,
    playerName,
    toClubName,
    outcome,
    reason,
    rejectOutcome,
  };
  const results = [await sendClearanceResolvedEmailChannel(contact, copy)];
  return { results };
}

// ───────────────────── Clearance reopened (source decides again; dest FYI) ─────────────────────

async function sendReopenedSourceEmailChannel(
  chair: ChairContact,
  copy: ClearanceCopy,
): Promise<SendResult> {
  if (!EMAIL_RE.test(chair.email)) {
    return {
      channel: 'email',
      status: 'skipped',
      ...(chair.email ? { to: chair.email } : {}),
      error: 'no valid chair email on file',
    };
  }
  try {
    const { messageId } = await sendClearanceReopenedSourceEmail({
      to: chair.email,
      chairName: chair.name,
      ...copy,
    });
    return { channel: 'email', status: 'sent', to: chair.email, messageId };
  } catch (err) {
    return { channel: 'email', status: 'failed', to: chair.email, error: errMessage(err) };
  }
}

async function sendReopenedDestEmailChannel(
  chair: ChairContact,
  copy: ClearanceCopy,
): Promise<SendResult> {
  if (!EMAIL_RE.test(chair.email)) {
    return {
      channel: 'email',
      status: 'skipped',
      ...(chair.email ? { to: chair.email } : {}),
      error: 'no valid chair email on file',
    };
  }
  try {
    const { messageId } = await sendClearanceReopenedDestEmail({
      to: chair.email,
      chairName: chair.name,
      ...copy,
    });
    return { channel: 'email', status: 'sent', to: chair.email, messageId };
  } catch (err) {
    return { channel: 'email', status: 'failed', to: chair.email, error: errMessage(err) };
  }
}

/**
 * Tell one club's chairman the union office has REOPENED a rejected clearance. The two clubs get
 * DIFFERENT content: the pending copy ("your club must decide") is true only for the SOURCE, so
 * the source chair receives the pending email (with a reopen preamble) plus the pending WhatsApp
 * template — there is no new Meta template — while the destination chair receives an email-only
 * heads-up and the WhatsApp channel is recorded `skipped` ('no destination template for reopen')
 * so the comm log stays honest. Called once per club (source and destination) by the caller, who
 * owns the comm-log append. Non-throwing per channel, like the other clearance senders.
 */
export async function sendClearanceReopenedNotice(args: {
  side: 'source' | 'destination';
  chair: { name?: string; email?: string; cell?: string };
  fromClubName: string;
  playerName: string;
  toClubName: string;
  channels: Channel[];
}): Promise<{ results: SendResult[] }> {
  const { side, chair, fromClubName, playerName, toClubName, channels } = args;
  const contact: ChairContact = {
    name: (chair.name ?? '').trim(),
    email: (chair.email ?? '').trim(),
    cell: (chair.cell ?? '').trim(),
  };
  const copy: ClearanceCopy = { fromClubName, playerName, toClubName };
  const results = await Promise.all(
    channels.map((channel): Promise<SendResult> => {
      if (channel === 'email') {
        return side === 'source'
          ? sendReopenedSourceEmailChannel(contact, copy)
          : sendReopenedDestEmailChannel(contact, copy);
      }
      // WhatsApp: the source reuses the pending template; the destination has no template at all,
      // so its channel is recorded skipped rather than sent — the comm log must not imply a send.
      if (side === 'source') return sendClearanceWhatsAppChannel(contact, copy);
      return Promise.resolve<SendResult>({
        channel: 'whatsapp',
        status: 'skipped',
        ...(contact.cell ? { to: contact.cell } : {}),
        error: 'no destination template for reopen',
      });
    }),
  );
  return { results };
}

// ───────────────────────── Fixtures broadcast ─────────────────────────

interface PlayerContact {
  name: string;
  email: string;
  cell: string;
  isMinor: boolean;
}

function playerContact(p: PlayerRegistration): PlayerContact {
  return {
    name: `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim(),
    email: (p.email ?? '').trim(),
    cell: (p.cell ?? '').trim(),
    isMinor: !!p.isMinor,
  };
}

/**
 * Run thunks with a bounded concurrency pool. A 50-player roster × 2 channels is 100
 * sends; firing them all at once would exceed SES's send rate and thunder-herd Meta's
 * rate limiter. A small pool keeps us within provider limits while staying parallel.
 */
async function runPool<T>(thunks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(thunks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < thunks.length) {
      const idx = next++;
      results[idx] = await thunks[idx]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker));
  return results;
}

const SEND_CONCURRENCY = 8;

async function sendPlayerChannel(
  channel: Channel,
  contact: PlayerContact,
  clubName: string,
  season: string,
  scheduleText: string,
): Promise<SendResult> {
  // POPIA / child-protection: there is no guardian contact on file, so we do not
  // message a minor's own email/cell directly. Skip with a clear, PII-free reason.
  if (contact.isMinor) {
    return {
      channel,
      status: 'skipped',
      error: 'minor — not messaged directly (no guardian contact on file)',
    };
  }
  if (channel === 'email') {
    if (!EMAIL_RE.test(contact.email)) {
      return {
        channel: 'email',
        status: 'skipped',
        ...(contact.email ? { to: contact.email } : {}),
        error: 'no valid player email on file',
      };
    }
    try {
      const { messageId } = await sendFixturesEmail({
        to: contact.email,
        playerName: contact.name,
        clubName,
        season,
        scheduleText,
      });
      return { channel: 'email', status: 'sent', to: contact.email, messageId };
    } catch (err) {
      return { channel: 'email', status: 'failed', to: contact.email, error: errMessage(err) };
    }
  }
  const e164 = toE164(contact.cell);
  if (!e164) {
    return {
      channel: 'whatsapp',
      status: 'skipped',
      ...(contact.cell ? { to: contact.cell } : {}),
      error: 'no valid player cell on file',
    };
  }
  try {
    const { messageId } = await sendFixturesWhatsApp({
      to: e164,
      playerName: contact.name,
      clubName,
      season,
    });
    return { channel: 'whatsapp', status: 'sent', to: e164, messageId };
  } catch (err) {
    return { channel: 'whatsapp', status: 'failed', to: e164, error: errMessage(err) };
  }
}

/**
 * Broadcast a club's released fixtures to its registered players over email and/or
 * WhatsApp. Fans out per eligible player × channel under a bounded pool; each send is
 * non-throwing (a bad recipient becomes a `failed`/`skipped` result, never sinking the
 * batch). Minors are skipped (see sendPlayerChannel). Caller summarizes the results —
 * per-recipient outcomes are intentionally not persisted (POPIA minimisation).
 */
export async function sendClubFixtures(args: {
  club: Club;
  players: PlayerRegistration[];
  channels: Channel[];
  scheduleText: string;
  season: string;
}): Promise<{ results: SendResult[] }> {
  const { club, players, channels, scheduleText, season } = args;
  const thunks: Array<() => Promise<SendResult>> = [];
  for (const p of players) {
    const contact = playerContact(p);
    for (const channel of channels) {
      thunks.push(() => sendPlayerChannel(channel, contact, club.name, season, scheduleText));
    }
  }
  const results = await runPool(thunks, SEND_CONCURRENCY);
  return { results };
}
