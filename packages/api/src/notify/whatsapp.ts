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
import { WHATSAPP_TEMPLATES } from './whatsapp-templates.js';

const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
// Template NAMES and languages come from the code registry (./whatsapp-templates.ts),
// not from env/SST secrets: a template name only changes when the template is
// created/renamed in Meta, which is a code change anyway (the sender's param shape
// moves with it). The env still carries the real secrets/config — WHATSAPP_ACCESS_TOKEN,
// WHATSAPP_PHONE_NUMBER_ID, NOTIFY_DRY_RUN — handled below.
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
  /** The email address the portal expects the recipient to sign in with ({{3}}). */
  email: string;
  link: string;
}

/**
 * Build the four positional body params for `staff_portal_invite`, in order: {{1}} staff
 * name (fallback 'there'), {{2}} org name, {{3}} email on file, {{4}} sign-in link. EVERY
 * param rides through cleanParam — sheet-sourced names/emails (the contact-import CLI)
 * can carry the leading spaces / double spaces Meta rejects, and relying on callers to
 * pre-clean would be a silent trap. Exported so the param order/count/cleaning can be
 * asserted directly (a real send in dev returns only a synthetic id, revealing nothing).
 */
export function staffInviteParams(
  input: Pick<StaffInviteWhatsAppInput, 'name' | 'orgName' | 'email' | 'link'>,
): TemplateParam[] {
  return [
    { type: 'text', text: cleanParam(input.name || 'there') },
    { type: 'text', text: cleanParam(input.orgName) },
    { type: 'text', text: cleanParam(input.email) },
    { type: 'text', text: cleanParam(input.link) },
  ];
}

/**
 * Staff (admin/rep) invite heads-up. Uses the `staffInvite` registry entry — the
 * dedicated four-param `staff_portal_invite` in production ({{1}} name, {{2}} org,
 * {{3}} email, {{4}} sign-in link). Email is the primary staff channel; WhatsApp is
 * best-effort.
 */
export async function sendStaffInviteWhatsApp(
  input: StaffInviteWhatsAppInput,
): Promise<{ messageId: string }> {
  const { to, orgName } = input;
  const { name, lang } = WHATSAPP_TEMPLATES.staffInvite;
  return sendTemplate(to, name, lang, staffInviteParams(input), `staff invite for ${orgName}`);
}

export interface RegLinkWhatsAppInput {
  to: string; // already E.164 (see toE164)
  chairName: string;
  clubName: string;
  regLink: string;
  tutorialsUrl: string;
}

/**
 * Build the four positional body params for `club_reglink_ready`, in order: {{1}} chair
 * name (fallback 'there'), {{2}} club name, {{3}} reg link, {{4}} tutorials URL. Exported
 * so the param order/count can be asserted against the registry directly.
 */
export function regLinkParams(
  input: Pick<RegLinkWhatsAppInput, 'chairName' | 'clubName' | 'regLink' | 'tutorialsUrl'>,
): TemplateParam[] {
  return [
    { type: 'text', text: cleanParam(input.chairName || 'there') },
    { type: 'text', text: cleanParam(input.clubName) },
    { type: 'text', text: input.regLink },
    { type: 'text', text: input.tutorialsUrl },
  ];
}

/**
 * Chair onboarding heads-up sent on affiliation-complete: the club's player-registration
 * link to forward to members, plus a link to the how-to-use-the-app tutorial videos. Uses
 * the `reglinkReady` registry entry — {{1}} chair name, {{2}} club name, {{3}} reg link,
 * {{4}} tutorials URL. WhatsApp is best-effort alongside the (primary) email.
 */
export async function sendRegLinkWhatsApp(
  input: RegLinkWhatsAppInput,
): Promise<{ messageId: string }> {
  const { to, clubName } = input;
  const { name, lang } = WHATSAPP_TEMPLATES.reglinkReady;
  return sendTemplate(to, name, lang, regLinkParams(input), `reg link for ${clubName}`);
}

export interface FixturesWhatsAppInput {
  to: string; // already E.164 (see toE164)
  playerName: string;
  clubName: string;
  season: string;
}

/**
 * Build the three positional body params for `club_fixtures_released`, in order:
 * {{1}} player name (fallback 'there'), {{2}} club name, {{3}} season. Exported so the
 * param order/count can be asserted against the registry directly.
 */
export function fixturesParams(
  input: Pick<FixturesWhatsAppInput, 'playerName' | 'clubName' | 'season'>,
): TemplateParam[] {
  return [
    { type: 'text', text: cleanParam(input.playerName || 'there') },
    { type: 'text', text: cleanParam(input.clubName) },
    { type: 'text', text: cleanParam(input.season) },
  ];
}

/**
 * Fixtures heads-up to a player. Players aren't portal users and the portal is
 * auth-gated, so the template carries no link — the full schedule rides in the
 * email; this just tells them it's out. Uses the `fixturesReleased` registry entry.
 */
export async function sendFixturesWhatsApp(
  input: FixturesWhatsAppInput,
): Promise<{ messageId: string }> {
  const { to, clubName } = input;
  const { name, lang } = WHATSAPP_TEMPLATES.fixturesReleased;
  return sendTemplate(to, name, lang, fixturesParams(input), `fixtures for ${clubName}`);
}

export interface ClearanceWhatsAppInput {
  to: string; // already E.164 (see toE164)
  chairName: string;
  fromClubName: string;
  playerName: string;
  toClubName: string;
}

/**
 * Build the four positional body params for `club_clearance_pending`, in order:
 * {{1}} chair name (fallback 'there'), {{2}} from-club, {{3}} player, {{4}} to-club.
 * Every param rides through cleanParam — the player name arrives from the PUBLIC register
 * form as free text (Meta rejects newlines/tabs/4+ spaces). Exported so the param
 * order/count/cleaning can be asserted against the registry directly.
 */
export function clearanceParams(
  input: Pick<ClearanceWhatsAppInput, 'chairName' | 'fromClubName' | 'playerName' | 'toClubName'>,
): TemplateParam[] {
  return [
    { type: 'text', text: cleanParam(input.chairName || 'there') },
    { type: 'text', text: cleanParam(input.fromClubName) },
    { type: 'text', text: cleanParam(input.playerName) },
    { type: 'text', text: cleanParam(input.toClubName) },
  ];
}

/**
 * Clearance-pending heads-up to the FROM-club chairman: a player wants to leave and
 * the club must approve or reject. No link in the body — the chair may hold no portal
 * login (chair invites were removed with admin onboarding), so the copy points at the
 * club portal / union office rather than telling the recipient to sign in. Uses the
 * `clearancePending` registry entry.
 */
export async function sendClearanceWhatsApp(
  input: ClearanceWhatsAppInput,
): Promise<{ messageId: string }> {
  const { to, fromClubName } = input;
  const { name, lang } = WHATSAPP_TEMPLATES.clearancePending;
  return sendTemplate(
    to,
    name,
    lang,
    clearanceParams(input),
    `clearance notice for ${fromClubName}`,
  );
}
