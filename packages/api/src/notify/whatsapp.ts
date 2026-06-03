/**
 * WhatsApp invite via the Meta WhatsApp Cloud API (Graph API).
 *
 * Business-initiated messages (this invite — the club hasn't messaged us first)
 * MUST use a pre-approved template; free-form text is rejected outside the 24h
 * customer-care window. We send the `WHATSAPP_INVITE_TEMPLATE` Utility template
 * with three body parameters: {{1}} chair name, {{2}} club name, {{3}} the link.
 * (URL-in-body is valid for Utility templates and avoids URL-button dynamic-suffix
 * coupling.) The template must be created + approved under the WABA that owns
 * WHATSAPP_PHONE_NUMBER_ID before real sends work.
 *
 * Credentials are reused from medicoach's WABA (token + phone-number id). Recipients
 * therefore see medicoach's WhatsApp display name — accepted for this round; a
 * Dolphins-owned WABA is the branding follow-up.
 *
 * Dry-run: NOTIFY_DRY_RUN=1 or missing token/phone-id → log + synthetic id.
 */
import { randomUUID } from 'node:crypto';

const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TEMPLATE = process.env.WHATSAPP_INVITE_TEMPLATE ?? 'club_onboarding_invite';
const TEMPLATE_LANG = process.env.WHATSAPP_INVITE_TEMPLATE_LANG ?? 'en';
// Fixtures broadcast uses its own approved Utility template — {{1}} player name,
// {{2}} club name, {{3}} season. Season is a variable so the template scales each
// year with no re-approval. See the plan appendix for the template to create.
const FIXTURES_TEMPLATE = process.env.WHATSAPP_FIXTURES_TEMPLATE ?? 'club_fixtures_released';
const FIXTURES_TEMPLATE_LANG = process.env.WHATSAPP_FIXTURES_TEMPLATE_LANG ?? 'en';
const GRAPH_VERSION = 'v22.0';
export const WHATSAPP_DRY_RUN = process.env.NOTIFY_DRY_RUN === '1' || !TOKEN || !PHONE_NUMBER_ID;

const RATE_LIMIT_CODE = 130429;
const MAX_RETRIES = 3;
const BACKOFF_MS = 1000;

/** Typed failure so the orchestrator can record the provider's reason. */
export class WhatsAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsAppError';
  }
}

/**
 * Normalize a South African cell to E.164 digits (no +). Mirrors the frontend
 * `waNumber` rule: strip non-digits, swap a leading 0 for country code 27. Returns
 * null when the result isn't a plausible 10–15 digit number so the caller can skip
 * the channel with a clear reason rather than hand Meta a bad recipient.
 */
export function toE164(cell: string | undefined | null): string | null {
  const digits = (cell || '').replace(/\D+/g, '');
  if (!digits) return null;
  let n = digits;
  if (n.startsWith('0')) n = '27' + n.slice(1);
  if (n.length < 10 || n.length > 15) return null;
  return n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A WhatsApp template body parameter (positional `{{n}}`). */
type TemplateParam = { type: 'text'; text: string };

/**
 * POST a pre-approved template message to the Cloud API with rate-limit retry.
 * Shared by the invite and fixtures senders so the auth/retry/dry-run handling
 * lives in exactly one place.
 */
async function sendTemplate(
  to: string,
  templateName: string,
  templateLang: string,
  params: TemplateParam[],
  dryRunLabel: string,
): Promise<{ messageId: string }> {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: templateLang },
      components: [{ type: 'body', parameters: params }],
    },
  };

  if (WHATSAPP_DRY_RUN) {
    console.log(`[notify:whatsapp dry-run] would send ${dryRunLabel} to ${to}`);
    return { messageId: `dry-run-${randomUUID()}` };
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Never log this header — it carries the long-lived Meta token.
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
      error?: { code?: number; message?: string };
    };
    if (res.ok) {
      return { messageId: data.messages?.[0]?.id ?? '' };
    }
    const code = data.error?.code;
    if (code === RATE_LIMIT_CODE && attempt < MAX_RETRIES) {
      await sleep(BACKOFF_MS * 2 ** attempt);
      continue;
    }
    throw new WhatsAppError(
      `WhatsApp send failed (${code ?? res.status}): ${data.error?.message ?? res.statusText}`,
    );
  }
}

export interface InviteWhatsAppInput {
  to: string; // already E.164 (see toE164)
  chairName: string;
  clubName: string;
  link: string;
}

export async function sendInviteWhatsApp(
  input: InviteWhatsAppInput,
): Promise<{ messageId: string }> {
  const { to, chairName, clubName, link } = input;
  return sendTemplate(
    to,
    TEMPLATE,
    TEMPLATE_LANG,
    [
      { type: 'text', text: chairName || 'there' },
      { type: 'text', text: clubName },
      { type: 'text', text: link },
    ],
    `invite for ${clubName}`,
  );
}

export interface FixturesWhatsAppInput {
  to: string; // already E.164 (see toE164)
  playerName: string;
  clubName: string;
  season: string;
}

/**
 * Fixtures heads-up to a player. Players aren't portal users and the portal is
 * auth-gated, so the template carries no link — the full schedule rides in the
 * email; this just tells them it's out.
 */
export async function sendFixturesWhatsApp(
  input: FixturesWhatsAppInput,
): Promise<{ messageId: string }> {
  const { to, playerName, clubName, season } = input;
  return sendTemplate(
    to,
    FIXTURES_TEMPLATE,
    FIXTURES_TEMPLATE_LANG,
    [
      { type: 'text', text: playerName || 'there' },
      { type: 'text', text: clubName },
      { type: 'text', text: season },
    ],
    `fixtures for ${clubName}`,
  );
}
