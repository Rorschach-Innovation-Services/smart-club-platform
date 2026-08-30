/**
 * WhatsApp sends via the Meta WhatsApp Cloud API (Graph API).
 *
 * Business-initiated messages (these — the recipient hasn't messaged us first)
 * MUST use a pre-approved template; free-form text is rejected outside the 24h
 * customer-care window. Templates carry positional body parameters; URL-in-body
 * is valid for Utility templates and avoids URL-button dynamic-suffix coupling.
 * Each template must be created + approved under the WABA that owns
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
// The approved onboarding-invite template survives as the staff-template DEV default
// only — the chair-invite send itself was removed with admin club onboarding.
const TEMPLATE = process.env.WHATSAPP_INVITE_TEMPLATE ?? 'club_onboarding_invite';
const TEMPLATE_LANG = process.env.WHATSAPP_INVITE_TEMPLATE_LANG ?? 'en';
// Fixtures broadcast uses its own approved Utility template — {{1}} player name,
// {{2}} club name, {{3}} season. Season is a variable so the template scales each
// year with no re-approval. See the plan appendix for the template to create.
const FIXTURES_TEMPLATE = process.env.WHATSAPP_FIXTURES_TEMPLATE ?? 'club_fixtures_released';
const FIXTURES_TEMPLATE_LANG = process.env.WHATSAPP_FIXTURES_TEMPLATE_LANG ?? 'en';
// Staff (admin/rep) invite template. The approved invite template's {{2}} is approved
// by Meta as "club name", so reusing it for an org name is a semantic/policy mismatch;
// a DEDICATED approved staff template is the correct production step (see runbook). We
// default to the invite template so dev dry-run works out of the box, and send {{1}}
// staff name, {{2}} org name, {{3}} the sign-in link (same body slots as the invite).
const STAFF_TEMPLATE = process.env.WHATSAPP_STAFF_TEMPLATE ?? TEMPLATE;
const STAFF_TEMPLATE_LANG = process.env.WHATSAPP_STAFF_TEMPLATE_LANG ?? TEMPLATE_LANG;
// Chair onboarding template, sent the moment affiliation completes — {{1}} chair name,
// {{2}} club name, {{3}} the player-registration link, {{4}} the tutorials-page URL.
// A single business-initiated message carries both links (one conversation, not two).
// Create + approve this Utility template before real sends; see the runbook. Two URL
// body variables are more scrutinised by Meta — if {{4}} blocks approval, drop it and
// rely on the email + portal for tutorials (the email already carries every link).
const REGLINK_TEMPLATE = process.env.WHATSAPP_REGLINK_TEMPLATE ?? 'club_reglink_ready';
const REGLINK_TEMPLATE_LANG = process.env.WHATSAPP_REGLINK_TEMPLATE_LANG ?? 'en';
// Clearance-pending heads-up to the from-club chairman — {{1}} chair name, {{2}} from-club
// name, {{3}} player name, {{4}} to-club name. Body-only Utility template, no buttons/links
// (the chair may have no portal login — see the softened copy in the plan). Create + approve
// this template before real sends; see the runbook.
const CLEARANCE_TEMPLATE = process.env.WHATSAPP_CLEARANCE_TEMPLATE ?? 'club_clearance_pending';
const CLEARANCE_TEMPLATE_LANG = process.env.WHATSAPP_CLEARANCE_TEMPLATE_LANG ?? 'en';
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

/**
 * Meta rejects template parameters containing newlines, tabs, or 4+ consecutive
 * spaces. Clearance params include a player name typed as free text on the PUBLIC
 * register form, so collapse every whitespace run to a single space and bound the
 * length — a hostile value must not be able to break (or bloat) the send.
 */
function cleanParam(value: string, max = 100): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

/** A WhatsApp template body parameter (positional `{{n}}`). */
type TemplateParam = { type: 'text'; text: string };

/**
 * POST a pre-approved template message to the Cloud API with rate-limit retry.
 * Shared by the staff-invite and fixtures senders so the auth/retry/dry-run
 * handling lives in exactly one place.
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

export interface StaffInviteWhatsAppInput {
  to: string; // already E.164 (see toE164)
  name: string;
  orgName: string;
  link: string;
}

/**
 * Staff (admin/rep) invite heads-up. Uses STAFF_TEMPLATE (defaults to the invite
 * template for dev) — {{1}} staff name, {{2}} org name, {{3}} sign-in link. Email is
 * the primary staff channel; WhatsApp is best-effort. See STAFF_TEMPLATE note above
 * re: a dedicated approved template before any real production staff send.
 */
export async function sendStaffInviteWhatsApp(
  input: StaffInviteWhatsAppInput,
): Promise<{ messageId: string }> {
  const { to, name, orgName, link } = input;
  return sendTemplate(
    to,
    STAFF_TEMPLATE,
    STAFF_TEMPLATE_LANG,
    [
      { type: 'text', text: name || 'there' },
      { type: 'text', text: orgName },
      { type: 'text', text: link },
    ],
    `staff invite for ${orgName}`,
  );
}

export interface RegLinkWhatsAppInput {
  to: string; // already E.164 (see toE164)
  chairName: string;
  clubName: string;
  regLink: string;
  tutorialsUrl: string;
}

/**
 * Chair onboarding heads-up sent on affiliation-complete: the club's player-registration
 * link to forward to members, plus a link to the how-to-use-the-app tutorial videos. Uses
 * REGLINK_TEMPLATE — {{1}} chair name, {{2}} club name, {{3}} reg link, {{4}} tutorials URL.
 * WhatsApp is best-effort alongside the (primary) email.
 */
export async function sendRegLinkWhatsApp(
  input: RegLinkWhatsAppInput,
): Promise<{ messageId: string }> {
  const { to, chairName, clubName, regLink, tutorialsUrl } = input;
  return sendTemplate(
    to,
    REGLINK_TEMPLATE,
    REGLINK_TEMPLATE_LANG,
    [
      { type: 'text', text: chairName || 'there' },
      { type: 'text', text: clubName },
      { type: 'text', text: regLink },
      { type: 'text', text: tutorialsUrl },
    ],
    `reg link for ${clubName}`,
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

export interface ClearanceWhatsAppInput {
  to: string; // already E.164 (see toE164)
  chairName: string;
  fromClubName: string;
  playerName: string;
  toClubName: string;
}

/**
 * Clearance-pending heads-up to the FROM-club chairman: a player wants to leave and
 * the club must approve or reject. No link in the body — the chair may hold no portal
 * login (chair invites were removed with admin onboarding), so the copy points at the
 * club portal / union office rather than telling the recipient to sign in. The player
 * name arrives from the public register form, so every param rides through cleanParam.
 */
export async function sendClearanceWhatsApp(
  input: ClearanceWhatsAppInput,
): Promise<{ messageId: string }> {
  const { to, chairName, fromClubName, playerName, toClubName } = input;
  return sendTemplate(
    to,
    CLEARANCE_TEMPLATE,
    CLEARANCE_TEMPLATE_LANG,
    [
      { type: 'text', text: cleanParam(chairName || 'there') },
      { type: 'text', text: cleanParam(fromClubName) },
      { type: 'text', text: cleanParam(playerName) },
      { type: 'text', text: cleanParam(toClubName) },
    ],
    `clearance notice for ${fromClubName}`,
  );
}
