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
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { WHATSAPP_TEMPLATES, type WhatsAppTemplateDefinition } from './whatsapp-templates.js';

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

/**
 * Typed failure so the orchestrator can record the provider's reason. `code` is Meta's error
 * code when the Graph API returned one (e.g. 130429 rate limit, 131026 undeliverable);
 * `httpStatus` is the HTTP status of the failed call.
 */
export class WhatsAppError extends Error {
  readonly code?: number;
  readonly httpStatus?: number;
  constructor(message: string, details: { code?: number; httpStatus?: number } = {}) {
    super(message);
    this.name = 'WhatsAppError';
    if (details.code !== undefined) this.code = details.code;
    if (details.httpStatus !== undefined) this.httpStatus = details.httpStatus;
  }
}

// toE164 lives in ./e164.ts (pure, no env) so callers that only normalise numbers don't
// load this module and freeze WHATSAPP_DRY_RUN early; re-exported for existing importers.
export { toE164 } from './e164.js';

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
 * The Cloud API component for a URL button's dynamic suffix: button index 0, one text
 * parameter. Exported so the arity test can assert the shape.
 */
export function urlButtonComponent(suffix: string) {
  return {
    type: 'button',
    sub_type: 'url',
    index: '0',
    parameters: [{ type: 'text', text: suffix }],
  };
}

/**
 * A VIDEO header's media: either a public HTTPS `link` (Meta fetches it at send time, so it must
 * serve byte ranges) or the `id` of media already uploaded to Meta (see uploadWhatsAppMedia) —
 * Meta-hosted media has proved the more reliable of the two.
 */
export type VideoRef = { link: string } | { id: string };

/**
 * The Cloud API component for a VIDEO media header: one video parameter carrying the ref. A link
 * is passed through whole — never `cleanParam`ed (truncating a URL would break it). Exported so
 * the tests can assert the shape.
 */
export function videoHeaderComponent(ref: VideoRef) {
  const video = 'id' in ref ? { id: ref.id } : { link: ref.link };
  return { type: 'header', parameters: [{ type: 'video', video }] };
}

/**
 * Upload a local media file to Meta (Graph `/{PHONE_NUMBER_ID}/media`) and return its media id,
 * for use as a `{ id }` VideoRef. Same token / phone-number id / dry-run gate as the senders: in
 * dry-run nothing is read or uploaded and a synthetic `dry-run-media-<uuid>` id is returned.
 */
export async function uploadWhatsAppMedia(
  filePath: string,
  mimeType = 'video/mp4',
): Promise<{ mediaId: string }> {
  if (WHATSAPP_DRY_RUN) {
    console.log(`[notify:whatsapp dry-run] would upload ${filePath} (${mimeType}) to Meta`);
    return { mediaId: `dry-run-media-${randomUUID()}` };
  }
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([bytes], { type: mimeType }), basename(filePath));
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    // Never log this header — it carries the long-lived Meta token.
    headers: { authorization: `Bearer ${TOKEN}` },
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    error?: { code?: number; message?: string };
  };
  if (!res.ok || !data.id) {
    throw new WhatsAppError(
      `WhatsApp media upload failed (${data.error?.code ?? res.status}): ${data.error?.message ?? res.statusText}`,
      {
        ...(data.error?.code !== undefined ? { code: data.error.code } : {}),
        httpStatus: res.status,
      },
    );
  }
  return { mediaId: data.id };
}

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
  /** The dynamic suffix of the template's URL button (index 0), if it has one. Never logged. */
  urlButtonSuffix?: string,
  /** Media for a VIDEO-header template's header (see videoHeaderComponent). */
  headerVideo?: VideoRef,
): Promise<{ messageId: string }> {
  const components: Array<Record<string, unknown>> = [];
  if (headerVideo !== undefined) components.push(videoHeaderComponent(headerVideo));
  // A zero-param template carries no body component (Meta rejects an empty parameter list).
  if (params.length > 0) components.push({ type: 'body', parameters: params });
  if (urlButtonSuffix !== undefined) components.push(urlButtonComponent(urlButtonSuffix));
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: templateLang },
      components,
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
      { ...(code !== undefined ? { code } : {}), httpStatus: res.status },
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
  /** Deep link to the clearance in the chair's club portal ({{5}} of the template). Required. */
  portalLink: string;
}

/**
 * Build the first four positional body params of `club_clearance_pending_v2`, in order:
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
 * Build the five positional body params for `club_clearance_pending_v2`: the name params
 * ({@link clearanceParams}) plus {{5}} the clearance deep link. The link skips cleanParam (as
 * `fixtureReminderParams`' portal link does) — it is server-built from the tenant origin, never
 * free text, and truncating it would break it.
 */
export function clearanceV2Params(
  input: Pick<
    ClearanceWhatsAppInput,
    'chairName' | 'fromClubName' | 'playerName' | 'toClubName' | 'portalLink'
  >,
): TemplateParam[] {
  return [...clearanceParams(input), { type: 'text', text: input.portalLink }];
}

/**
 * Which clearance-pending template a send uses, and its params: `clearancePendingV2` — the only
 * clearance template since v1 (`club_clearance_pending`) was retired in code on 7 Oct 2026 — when
 * the notice carries a link; null when it does not. {{5}} is the link and Meta rejects an empty
 * param, so a null pick means the caller skips the WhatsApp channel (sendClearanceWhatsAppChannel
 * in notify/index.ts records it `skipped`). Exported so tests can assert both sides.
 */
export function clearanceTemplateFor(
  input: Pick<
    ClearanceWhatsAppInput,
    'chairName' | 'fromClubName' | 'playerName' | 'toClubName'
  > & {
    portalLink?: string;
  },
): { key: 'clearancePendingV2'; params: TemplateParam[] } | null {
  if (!input.portalLink) return null;
  return {
    key: 'clearancePendingV2',
    params: clearanceV2Params({ ...input, portalLink: input.portalLink }),
  };
}

/**
 * Clearance-pending heads-up to the FROM-club chairman: a player wants to leave and the club must
 * approve or reject. Sends `club_clearance_pending_v2` with the portal deep link, which is
 * required: a link-less notice never reaches here — the caller skips the channel and records why
 * (sendClearanceWhatsAppChannel in notify/index.ts). The copy keeps the "contact your union
 * office" fallback, since the chair may hold no portal login. The ClearanceReminders cron's
 * WhatsApp channel gate reads this template's registry status (crons/clearance-reminders.ts).
 */
export async function sendClearanceWhatsApp(
  input: ClearanceWhatsAppInput,
): Promise<{ messageId: string }> {
  const { to, fromClubName } = input;
  const { name, lang } = WHATSAPP_TEMPLATES.clearancePendingV2;
  return sendTemplate(
    to,
    name,
    lang,
    clearanceV2Params(input),
    `clearance notice for ${fromClubName}`,
  );
}

export interface FixtureReminderWhatsAppInput {
  to: string; // already E.164 (see toE164)
  chairName: string;
  clubName: string;
  /** Human date label, e.g. "Sat 2026-11-07". */
  dateLabel: string;
  portalLink: string;
}

/**
 * Build the four positional body params for `fixture_reminder`, in order: {{1}} chair name
 * (fallback 'there'), {{2}} club name, {{3}} fixture date, {{4}} portal link. Exported so the
 * param order/count can be asserted against the registry directly.
 */
export function fixtureReminderParams(
  input: Pick<FixtureReminderWhatsAppInput, 'chairName' | 'clubName' | 'dateLabel' | 'portalLink'>,
): TemplateParam[] {
  return [
    { type: 'text', text: cleanParam(input.chairName || 'there') },
    { type: 'text', text: cleanParam(input.clubName) },
    { type: 'text', text: cleanParam(input.dateLabel) },
    { type: 'text', text: input.portalLink },
  ];
}

/**
 * Scheduled fixture reminder to a club chair. Uses the `fixtureReminder` registry entry. The
 * caller (the FixtureReminders cron) only reaches this once that entry is "registered".
 */
export async function sendFixtureReminderWhatsApp(
  input: FixtureReminderWhatsAppInput,
): Promise<{ messageId: string }> {
  const { to, clubName } = input;
  const { name, lang } = WHATSAPP_TEMPLATES.fixtureReminder;
  return sendTemplate(
    to,
    name,
    lang,
    fixtureReminderParams(input),
    `fixture reminder for ${clubName}`,
  );
}

export interface CaptainsReportDueWhatsAppInput {
  to: string; // already E.164 (see toE164)
  recipientName: string;
  clubName: string;
  /** The union's display name ("KZN Dolphins") — v2 template {{2}}. */
  orgName: string;
  /** "Umzinto v African Warriors on Sun 4 Oct 2026" */
  match: string;
  /** The signed report token — the URL button's dynamic suffix. Never logged. */
  token: string;
}

/**
 * Build the three body params for `captains_report_due` (v2 copy, edited in place in Meta
 * on 4 Oct 2026), in order: {{1}} recipient name (fallback 'there'), {{2}} the union's
 * display name ("KZN Dolphins"), {{3}} match line + date ("Umzinto v African Warriors on
 * Sun 4 Oct 2026"). The link is NOT a body param — it rides in the URL button
 * (see `captainsReportDue.urlButton`).
 */
export function captainsReportDueParams(
  input: Pick<CaptainsReportDueWhatsAppInput, 'recipientName' | 'orgName' | 'match'>,
): TemplateParam[] {
  return [
    { type: 'text', text: cleanParam(input.recipientName || 'there') },
    { type: 'text', text: cleanParam(input.orgName) },
    { type: 'text', text: cleanParam(input.match) },
  ];
}

/**
 * Captain's report link over WhatsApp (URL button with the token as its suffix). Throws
 * `WhatsAppTemplatePendingError` while the registry entry is not `registered` — the
 * channel is then skipped as `template-pending`, never failed.
 */
export async function sendCaptainsReportDueWhatsApp(
  input: CaptainsReportDueWhatsAppInput,
): Promise<{ messageId: string }> {
  const { name, lang, status } = WHATSAPP_TEMPLATES.captainsReportDue;
  if (status !== 'registered') throw new WhatsAppTemplatePendingError();
  return sendTemplate(
    input.to,
    name,
    lang,
    captainsReportDueParams(input),
    `captain's report link for ${input.clubName}`,
    input.token,
  );
}

export interface CaptainsReportOpsDigestWhatsAppInput {
  to: string; // already E.164 (see toE164)
  recipientName: string;
  /** "Dolphins: 3 new results, 6 reports opened, 6 notices sent, 0 failed" */
  summary: string;
}

/**
 * Build the two body params for `captains_report_ops_digest_v2`, in order: {{1}} recipient
 * name (fallback 'there'), {{2}} the one-line run summary (bounded at 300 chars).
 */
export function captainsReportOpsDigestParams(
  input: Pick<CaptainsReportOpsDigestWhatsAppInput, 'recipientName' | 'summary'>,
): TemplateParam[] {
  return [
    { type: 'text', text: cleanParam(input.recipientName || 'there') },
    { type: 'text', text: cleanParam(input.summary, 300) },
  ];
}

/**
 * The sync run's ops digest to the union-admin cell (body-only, no button). Throws
 * `WhatsAppTemplatePendingError` while the registry entry is not `registered`.
 */
export async function sendCaptainsReportOpsDigestWhatsApp(
  input: CaptainsReportOpsDigestWhatsAppInput,
): Promise<{ messageId: string }> {
  const { name, lang } = WHATSAPP_TEMPLATES.captainsReportOpsDigest;
  // Widened: the `as const` literal would make the gate a type error while it is 'pending'.
  const status = WHATSAPP_TEMPLATES.captainsReportOpsDigest
    .status as WhatsAppTemplateDefinition['status'];
  if (status !== 'registered') throw new WhatsAppTemplatePendingError();
  return sendTemplate(
    input.to,
    name,
    lang,
    captainsReportOpsDigestParams(input),
    "captain's report ops digest",
  );
}

// ── Dolphins welcome broadcast (one-off CLI: send-dolphins-welcome-broadcast.ts) ──

/** Registry status, widened: the `as const` literal would make the gate a type error while 'pending'. */
const statusOf = (def: WhatsAppTemplateDefinition): WhatsAppTemplateDefinition['status'] =>
  def.status;

/**
 * Options for the dolphins senders. `allowPending` skips the registry-status gate — ONLY for the
 * video-header experiment CLI, when Meta has approved a template before its registry entry is
 * flipped to 'registered'.
 */
export interface DolphinsSendOptions {
  allowPending?: boolean;
}

/** The registry-status send gate (exported for tests). Throws unless registered or allowPending. */
export const assertTemplateSendable = (
  def: WhatsAppTemplateDefinition,
  opts?: DolphinsSendOptions,
): void => {
  if (statusOf(def) !== 'registered' && !opts?.allowPending) {
    throw new WhatsAppTemplatePendingError(def.name);
  }
};

/** {{1}} for `dolphins_staff_welcome`: the recipient's name (fallback 'Club Representative'). */
export function dolphinsStaffWelcomeParams(input: { name: string }): TemplateParam[] {
  return [{ type: 'text', text: cleanParam(input.name || 'Club Representative') }];
}

/** {{1}} for `dolphins_player_welcome`: the player's first name (fallback 'player'). */
export function dolphinsPlayerWelcomeParams(input: { firstName: string }): TemplateParam[] {
  return [{ type: 'text', text: cleanParam(input.firstName || 'player') }];
}

/** `dolphins_player_fyi` has no body params. */
export function dolphinsPlayerFyiParams(): TemplateParam[] {
  return [];
}

/**
 * Staff welcome (VIDEO header = the live-scoring tutorial). Throws
 * `WhatsAppTemplatePendingError` while the registry entry is not `registered`.
 */
export async function sendDolphinsStaffWelcomeWhatsApp(
  to: string,
  name: string,
  videoRef: VideoRef,
  opts?: DolphinsSendOptions,
): Promise<{ messageId: string }> {
  const def = WHATSAPP_TEMPLATES.dolphinsStaffWelcome;
  assertTemplateSendable(def, opts);
  return sendTemplate(
    to,
    def.name,
    def.lang,
    dolphinsStaffWelcomeParams({ name }),
    'dolphins staff welcome',
    undefined,
    videoRef,
  );
}

/**
 * Player welcome (VIDEO header = the scouting-pipeline video). Throws
 * `WhatsAppTemplatePendingError` while the registry entry is not `registered`.
 */
export async function sendDolphinsPlayerWelcomeWhatsApp(
  to: string,
  firstName: string,
  videoRef: VideoRef,
  opts?: DolphinsSendOptions,
): Promise<{ messageId: string }> {
  const def = WHATSAPP_TEMPLATES.dolphinsPlayerWelcome;
  assertTemplateSendable(def, opts);
  return sendTemplate(
    to,
    def.name,
    def.lang,
    dolphinsPlayerWelcomeParams({ firstName }),
    'dolphins player welcome',
    undefined,
    videoRef,
  );
}

/**
 * Staff FYI copy of the player message (VIDEO header = the scouting-pipeline video), sent after
 * the staff welcome. Throws `WhatsAppTemplatePendingError` while not `registered`.
 */
export async function sendDolphinsPlayerFyiWhatsApp(
  to: string,
  videoRef: VideoRef,
  opts?: DolphinsSendOptions,
): Promise<{ messageId: string }> {
  const def = WHATSAPP_TEMPLATES.dolphinsPlayerFyi;
  assertTemplateSendable(def, opts);
  return sendTemplate(
    to,
    def.name,
    def.lang,
    dolphinsPlayerFyiParams(),
    'dolphins player FYI',
    undefined,
    videoRef,
  );
}

// ── EMCU scorer broadcast (one-off CLI: send-emcu-scorer-broadcast.ts) ──
// Both templates carry a VIDEO header and two STATIC URL buttons (App Store / Google Play):
// static buttons need no send-time component, so these senders pass no button suffix.

/**
 * The three body params for `emcu_scorer_accounts_notice`, in order: {{1}} chair name (fallback
 * 'Chairperson'), {{2}} club name, {{3}} the chair email the logins were sent to. Every param
 * rides through cleanParam (an email address has no whitespace, so it passes unchanged).
 * NEVER a password — logins go by email only.
 */
export function emcuScorerAccountsNoticeParams(input: {
  chairName: string;
  clubName: string;
  chairEmail: string;
}): TemplateParam[] {
  return [
    { type: 'text', text: cleanParam(input.chairName || 'Chairperson') },
    { type: 'text', text: cleanParam(input.clubName) },
    { type: 'text', text: cleanParam(input.chairEmail) },
  ];
}

/** The one body param for `emcu_player_scoring` (10 Oct 2026 edit): {{1}} first name (fallback 'player'). */
export function emcuPlayerScoringParams(input: { firstName: string }): TemplateParam[] {
  return [{ type: 'text', text: cleanParam(input.firstName || 'player') }];
}

/**
 * EMCU chair notice (VIDEO header = the staff live-scoring video): "your club's scorer accounts
 * have been emailed to {{3}}". Throws `WhatsAppTemplatePendingError` while not `registered`.
 */
export async function sendEmcuScorerAccountsNoticeWhatsApp(
  to: string,
  input: { chairName: string; clubName: string; chairEmail: string },
  videoRef: VideoRef,
  opts?: DolphinsSendOptions,
): Promise<{ messageId: string }> {
  const def = WHATSAPP_TEMPLATES.emcuScorerAccountsNotice;
  assertTemplateSendable(def, opts);
  return sendTemplate(
    to,
    def.name,
    def.lang,
    emcuScorerAccountsNoticeParams(input),
    'EMCU scorer accounts notice',
    undefined,
    videoRef,
  );
}

/**
 * EMCU player notice (VIDEO header = the staff live-scoring video). Throws
 * `WhatsAppTemplatePendingError` while not `registered`.
 */
export async function sendEmcuPlayerScoringWhatsApp(
  to: string,
  input: { firstName: string },
  videoRef: VideoRef,
  opts?: DolphinsSendOptions,
): Promise<{ messageId: string }> {
  const def = WHATSAPP_TEMPLATES.emcuPlayerScoring;
  assertTemplateSendable(def, opts);
  return sendTemplate(
    to,
    def.name,
    def.lang,
    emcuPlayerScoringParams(input),
    'EMCU player scoring notice',
    undefined,
    videoRef,
  );
}

/** No approved template in Meta for this send: the channel is skipped, not failed. */
export class WhatsAppTemplatePendingError extends Error {
  /** `templateName` absent ⇒ the captain's-report wording (the original and default use). */
  constructor(templateName?: string) {
    super(
      templateName
        ? `WhatsApp template ${templateName} is not approved in Meta yet`
        : "no captain's report WhatsApp template is approved yet",
    );
    this.name = 'WhatsAppTemplatePendingError';
  }
}
