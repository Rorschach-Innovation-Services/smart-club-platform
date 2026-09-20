/**
 * Registry of every Meta WhatsApp template this platform sends, and how many
 * positional body parameters each one takes.
 *
 * WHY THIS EXISTS
 *
 * A sender that emits a different number of `{{n}}` parameters than the template
 * registered in Meta Business Manager fails at send time with error 132000. Meta
 * returns that failure as a value (the send path records a `failed` comm-log row),
 * not a thrown error, so a param-count drift is easy to miss: the email still goes,
 * and only the WhatsApp row shows `failed`. Ported from medicoach's
 * `whatsapp-templates.ts` registry pattern, adapted to this repo's single notify
 * module (medicoach splits it per domain).
 *
 * This registry replaces the SST-secret indirection that used to carry template
 * NAMES (the former per-template name/language env vars). Template names are code, not
 * config: they only ever changed when a template was created/renamed in Meta, which
 * is a code change anyway (the matching sender's param shape moves with it). The
 * real secrets — WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, NOTIFY_DRY_RUN —
 * stay in the environment. `test/whatsapp-template-arity.test.ts` asserts every
 * sender's param builder against the `paramCount` below, so an arity drift is a
 * failing test rather than a silent production loss.
 *
 * RETIRED: `club_onboarding_invite` (the legacy 3-param chair-invite template) has
 * NO entry here. Its send path was removed with admin club onboarding, and its only
 * remaining use was as the dev fallback default for the staff template — which this
 * change eliminates by naming `staff_portal_invite` directly. Nothing sends it.
 *
 * KEEPING IT HONEST
 *
 * `bodyText` mirrors what is registered in Meta for templates whose status is
 * "registered". For "pending"/"unverified" templates it is RECONSTRUCTED from the
 * parameter order (annotated on the entry) — treat those as the ARITY contract the
 * test enforces, not as a transcript of Meta's copy.
 *
 * `status`:
 *   "registered" — confirmed Active in Meta and in use.
 *   "unverified" — sent by a live sender, but its Meta registration/copy has not
 *      been confirmed against Business Manager. Verify before trusting the copy.
 *   "pending"    — NOT yet created/approved in Meta. The sender exists; a real send
 *      is rejected on the missing template until it is created under this name.
 * `status` is documentation, not a runtime gate — nothing here can verify Meta's
 * state, and the send path fails open (attempts the send) for every entry.
 */

export type WhatsAppTemplateDefinition = {
  /** Template name as registered (or to be registered) in Meta. */
  name: string;
  /** Language code the template is registered under. */
  lang: string;
  /** Number of `{{n}}` placeholders in the template BODY. */
  paramCount: number;
  /** The meaning of each positional param, in order ({{1}} first). */
  params: readonly string[];
  /** The registered body text (or, for pending/unverified, a reconstruction). */
  bodyText: string;
  status: 'registered' | 'unverified' | 'pending';
};

export const WHATSAPP_TEMPLATES = {
  /**
   * Staff (admin/rep) invite. Dedicated 4-param Utility body. Approved/Active in
   * Meta since 18 Sep 2026 (template id 1388345850069490). The email ({{3}}) is
   * echoed so the recipient can confirm which address the portal expects them to
   * sign in with (passwordless OTP is keyed on it).
   */
  staffInvite: {
    name: 'staff_portal_invite',
    lang: 'en',
    paramCount: 4,
    params: ['staff name', 'org name', 'email on file', 'sign-in link'],
    bodyText:
      'Hello {{1}},\n\n' +
      'You have been added as a staff member for {{2}} on the club management portal.\n\n' +
      'Sign in here using your email address {{3}} to receive a one-time code: {{4}}\n\n' +
      'If you have any questions, please contact your union office.',
    status: 'registered',
  },

  /**
   * Clearance-pending heads-up to the from-club chairman. Body-only Utility
   * template (no header/buttons/links). LIVE — created under the medicoach WABA on
   * 4 Aug 2026 and Active (template id 1015867618110855). Body copied verbatim from
   * docs/runbooks/whatsapp-templates.md; POPIA: names only, never a reject/override
   * reason. See `sendClearanceWhatsApp`.
   */
  clearancePending: {
    name: 'club_clearance_pending',
    lang: 'en',
    paramCount: 4,
    params: ['chair name', 'from-club name', 'player name', 'to-club name'],
    bodyText:
      'Hello {{1}},\n\n' +
      "A player clearance is awaiting {{2}}'s review: {{3}} has applied to join {{4}} " +
      'and needs a clearance from your club.\n\n' +
      'Please have this reviewed and approved or rejected in your club portal, or ' +
      'contact your union office if you have any questions.',
    status: 'registered',
  },

  /**
   * Chair onboarding heads-up sent on affiliation-complete: player-registration
   * link + tutorials URL.
   *
   * NOT YET CREATED IN META. `bodyText` below is RECONSTRUCTED from the parameter
   * order (the arity contract), not a transcript. Two URL body variables draw extra
   * Meta scrutiny — if {{4}} blocks approval, drop it and rely on the email + portal
   * for tutorials (the email already carries every link), which is a paramCount
   * change here and in `regLinkParams`. Status flips to "registered" once approved.
   */
  reglinkReady: {
    name: 'club_reglink_ready',
    lang: 'en',
    paramCount: 4,
    params: ['chair name', 'club name', 'reg link', 'tutorials URL'],
    bodyText:
      'Hello {{1}},\n\n' +
      '{{2}} is now set up on the club management portal. Share this ' +
      'player-registration link with your members so they can register: {{3}}\n\n' +
      'A short set of how-to videos is here: {{4}}\n\n' +
      'If you have any questions, please contact your union office.',
    status: 'pending',
  },

  /**
   * Fixtures-released heads-up to a player (no link — players aren't portal users;
   * the schedule rides in the email). Season is a variable so the template scales
   * each year with no re-approval.
   *
   * UNVERIFIED: the previous sender comment described this as an "approved Utility
   * template" yet also pointed at a (now-absent) plan appendix "for the template to
   * create" — a contradiction, and there is no Meta id, runbook entry, or SST secret
   * confirming it. `bodyText` is RECONSTRUCTED from the parameter order. Confirm
   * against Business Manager and flip to "registered" (or "pending" if it turns out
   * never to have been created).
   */
  fixturesReleased: {
    name: 'club_fixtures_released',
    lang: 'en',
    paramCount: 3,
    params: ['player name', 'club name', 'season'],
    bodyText:
      'Hello {{1}},\n\n' +
      'The fixtures for {{2}} for the {{3}} season have been released. ' +
      'Check your email for the full schedule.\n\n' +
      'If you have any questions, please contact your club.',
    status: 'unverified',
  },
} as const satisfies Record<string, WhatsAppTemplateDefinition>;

export type WhatsAppTemplateKey = keyof typeof WHATSAPP_TEMPLATES;
