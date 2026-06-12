/**
 * Notification orchestrator. Validates recipients per channel and fans email +
 * WhatsApp out concurrently (each channel never throws — failures become a
 * `failed`/`skipped` result so one bad channel can't sink the other). The HTTP
 * routes record these results and return them to the caller verbatim, so the
 * toast reflects reality instead of optimism.
 */
import type { Club, Channel, SendResult, PlayerRegistration } from '../types.js';
import { sendStaffInviteEmail, sendFixturesEmail } from './email.js';
import { sendStaffInviteWhatsApp, sendFixturesWhatsApp, toE164 } from './whatsapp.js';

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
