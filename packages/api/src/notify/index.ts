/**
 * Invite-send orchestrator. Resolves the chair contact off the club, validates per
 * channel, and fans email + WhatsApp out concurrently (each channel never throws —
 * failures become a `failed`/`skipped` result so one bad channel can't sink the
 * other). The HTTP route records these results in the comm log and returns them to
 * the admin verbatim, so the toast reflects reality instead of optimism.
 */
import type { Club, Channel, SendResult } from '../types.js';
import { sendInviteEmail } from './email.js';
import { sendInviteWhatsApp, toE164 } from './whatsapp.js';

// Re-export so existing import sites (index.ts) keep resolving these from here.
export type { Channel, SendResult } from '../types.js';

// Kept identical to the backend EMAIL_RE (index.ts) / frontend so a value that
// passes the form can't be rejected here.
const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;

interface ChairContact {
  name: string;
  email: string;
  cell: string;
}

/** Read the chair contact off `exco.chair`, tolerating a totally-absent object. */
function chairContact(club: Club): ChairContact {
  const exco = (club.exco ?? {}) as {
    chair?: { name?: string; email?: string; cell?: string };
  };
  const chair = exco.chair ?? {};
  return {
    name: (chair.name || club.chair || '').trim(),
    email: (chair.email || '').trim(),
    cell: (chair.cell || '').trim(),
  };
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function sendEmailChannel(
  contact: ChairContact,
  clubName: string,
  link: string,
): Promise<SendResult> {
  if (!EMAIL_RE.test(contact.email)) {
    // Keep an invalid-but-present value for diagnostics; omit `to` entirely when blank.
    return {
      channel: 'email',
      status: 'skipped',
      ...(contact.email ? { to: contact.email } : {}),
      error: 'no valid chair email on file',
    };
  }
  try {
    const { messageId } = await sendInviteEmail({
      to: contact.email,
      chairName: contact.name,
      clubName,
      link,
    });
    return { channel: 'email', status: 'sent', to: contact.email, messageId };
  } catch (err) {
    return { channel: 'email', status: 'failed', to: contact.email, error: errMessage(err) };
  }
}

async function sendWhatsAppChannel(
  contact: ChairContact,
  clubName: string,
  link: string,
): Promise<SendResult> {
  const e164 = toE164(contact.cell);
  if (!e164) {
    return {
      channel: 'whatsapp',
      status: 'skipped',
      ...(contact.cell ? { to: contact.cell } : {}),
      error: 'no valid chair cell on file',
    };
  }
  try {
    const { messageId } = await sendInviteWhatsApp({
      to: e164,
      chairName: contact.name,
      clubName,
      link,
    });
    return { channel: 'whatsapp', status: 'sent', to: e164, messageId };
  } catch (err) {
    return { channel: 'whatsapp', status: 'failed', to: e164, error: errMessage(err) };
  }
}

export async function sendClubInvite(args: {
  club: Club;
  channels: Channel[];
  link: string;
}): Promise<{ results: SendResult[] }> {
  const { club, channels, link } = args;
  const contact = chairContact(club);
  // Concurrent fan-out keeps worst-case latency to the slowest single channel
  // (each already retries internally) rather than the sum. Order is preserved.
  const results = await Promise.all(
    channels.map((channel) =>
      channel === 'email'
        ? sendEmailChannel(contact, club.name, link)
        : sendWhatsAppChannel(contact, club.name, link),
    ),
  );
  return { results };
}
