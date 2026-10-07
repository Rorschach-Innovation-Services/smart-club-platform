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
 * state, and the send path fails open (attempts the send) for every entry. The exceptions
 * are `fixtureReminder` (the FixtureReminders cron skips WhatsApp until it is
 * "registered"), `captainsReportDue` / `captainsReportOpsDigest` (their senders skip the
 * channel as template-pending until it is "registered") and `clearancePendingV2` (the
 * ClearanceReminders cron's WhatsApp gate) — see those entries.
 *
 * RETIRED: `club_clearance_pending` (the 4-param, link-less v1 clearance template) has NO entry
 * here since 7 Oct 2026. `club_clearance_pending_v2` is the only clearance template; a clearance
 * notice with no link skips WhatsApp rather than sending a link-less message.
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
  /**
   * A URL button with a dynamic suffix (Meta "Visit website" button, URL ending in `{{1}}`).
   * `urlTemplate` is the URL as registered in Meta; the sender supplies the ONE suffix value
   * (button index 0). Absent ⇒ a body-only template.
   */
  urlButton?: { urlTemplate: string; suffix: string };
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
   * Clearance-pending heads-up to the from-club chairman, with a deep link ({{5}}) to the
   * clearance in the chair's club portal. Body-only Utility template. It replaced the 4-param
   * `club_clearance_pending` (v1) under a NEW name rather than an in-place edit, which would have
   * failed every live 4-param send with error 132000 until the edit cleared review; v1 was retired
   * in code on 7 Oct 2026. The link sits mid-body because Meta rejects a body that ends on a
   * variable; the "contact your union office" fallback stays (a chair with no portal login can't
   * get past sign-in). POPIA: names only, never a reject/override reason.
   *
   * Approved in Meta 7 Oct 2026 (template id 1076095408549057). The only clearance template:
   * a notice with no link skips the WhatsApp channel (see `sendClearanceWhatsApp`). This status
   * IS read at runtime: the ClearanceReminders cron's WhatsApp gate.
   */
  clearancePendingV2: {
    name: 'club_clearance_pending_v2',
    lang: 'en',
    paramCount: 5,
    params: ['chair name', 'from-club name', 'player name', 'to-club name', 'clearance link'],
    bodyText:
      'Hello {{1}},\n\n' +
      "A player clearance is awaiting {{2}}'s review: {{3}} has applied to join {{4}} " +
      'and needs a clearance from your club.\n\n' +
      'Review it here: {{5}}\n\n' +
      'Please have this reviewed and approved or rejected in your club portal, or ' +
      'contact your union office if you have any questions.',
    status: 'registered',
  },

  /**
   * Chair onboarding heads-up sent on affiliation-complete: player-registration
   * link + tutorials URL.
   *
   * Active in Meta (template id 2437210353459453, Utility, last edited 19 Jun 2026;
   * confirmed in Business Manager 6 Oct 2026 — "Quality pending" is the rating, not
   * approval state). `bodyText` below is the registered copy, which predates this
   * registry and differs from the wording the entry originally reconstructed; the
   * 4-param order is unchanged, so `regLinkParams` is unaffected.
   */
  reglinkReady: {
    name: 'club_reglink_ready',
    lang: 'en',
    paramCount: 4,
    params: ['chair name', 'club name', 'reg link', 'tutorials URL'],
    bodyText:
      "Hi {{1}}, your {{2}} affiliation is approved. Here is your club's " +
      'player registration link ({{3}}), share it with your players so they ' +
      'register straight into your club.\n\n' +
      'New to the app? Visit this link ({{4}}) for quick how-to videos.',
    status: 'registered',
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

  /**
   * Scheduled fixture reminder to a club chair (the FixtureReminders cron), sent N days
   * before a match day. Body-only Utility template; the fixture detail (opponents, and the
   * kick-off/ground only when revealed) rides in the email and the portal, never here, so
   * the template can't leak a withheld time or venue.
   *
   * Submitted to Meta 6 Oct 2026 and IN REVIEW (template id 1536264794855191); the
   * registered copy matches `bodyText` below. Unlike the other entries, this status IS
   * read at runtime: the cron skips the WhatsApp channel unless it is "registered" (a
   * daily cron across every tenant would otherwise fail the same send on every run
   * until approval). Flip to "registered" once Meta approves it.
   */
  fixtureReminder: {
    name: 'fixture_reminder',
    lang: 'en',
    paramCount: 4,
    params: ['chair name', 'club name', 'fixture date', 'portal link'],
    bodyText:
      'Hello {{1}},\n\n' +
      'A reminder that {{2}} has fixtures on {{3}}. ' +
      'See the match details in your club portal: {{4}}\n\n' +
      'If you have any questions, please contact your union office.',
    // Approved in Meta Business Manager 6 Oct 2026.
    status: 'registered',
  },

  /**
   * Captain's report due (ADR 0016, Slice 2): the submit-once report link to the match
   * captain, or to the club chair when the captain can't be reached. The link is a URL
   * BUTTON with a dynamic suffix (the signed report token), NOT a URL in the body — Meta
   * scrutinises body URLs, and the token must not sit in the message text.
   *
   * The button URL is fixed per template in Meta, so it points at the PLATFORM host (the
   * `/r/<token>` page is tenant-independent, like `/verify`): every tenant shares one
   * template. Non-prod stages send the same button — they normally dry-run anyway.
   *
   * Created in Meta 3 Oct 2026; EDITED IN PLACE to the v2 copy on 4 Oct 2026 (Utility,
   * English, 3 body params, dynamic URL button `https://platform.club.medicoach.co.za/r/{{1}}`).
   * The v2 copy names the UNION instead of the club (no awkward "Crusaders's") and drops
   * "works once" (a link can be opened and drafted many times; it is SUBMITTED once).
   * Meta keeps serving the previously approved body until the edit clears review, so during
   * that window {{2}} (now the union) renders inside the old club-possessive sentence —
   * cosmetic only, same arity. `bodyText` is the exact copy submitted; confirm against
   * Business Manager after the edit is approved.
   */
  captainsReportDue: {
    name: 'captains_report_due',
    lang: 'en',
    paramCount: 3,
    params: ['recipient name', 'org name', 'match line + date'],
    bodyText:
      'Hello {{1}},\n\n' +
      "The {{2}} captain's report for {{3}} is open. Please rate the umpires.\n\n" +
      'Tap the button below to open it. You can submit it once; the link expires on the date shown in the report.',
    status: 'registered',
    urlButton: {
      urlTemplate: 'https://platform.club.medicoach.co.za/r/{{1}}',
      suffix: 'signed report token',
    },
  },

  /**
   * Captain's-report ops digest: ONE status line to a union-admin cell (the `OpsDigestCell`
   * secret) after a medicoach sync run that produced report activity — new results, reports
   * opened, notices sent or failed. Body-only Utility template (no button); {{2}} is a
   * one-line count summary ("Dolphins: 3 new results, 6 reports opened, 6 notices sent,
   * 0 failed") with no player, club-contact or link detail.
   *
   * Like `captainsReportDue`, this status IS read at runtime: the sender throws
   * `WhatsAppTemplatePendingError` until it is "registered", and the sync run skips the
   * digest silently.
   *
   * V2 HISTORY: the original `captains_report_ops_digest` (approved 6 Oct 2026, template id
   * 1516075533660158) was auto-categorized MARKETING by Meta — its body was a greeting plus
   * one free-text variable, nothing transactional for the classifier to anchor on. Category
   * is immutable once approved, so this v2 was created fresh as UTILITY with
   * transaction-anchored copy ("account status notification", "no action is required") and
   * approved Active on 7 Oct 2026 (template id 29115540798081571). Delete the Marketing v1
   * in Business Manager once this is deployed.
   */
  captainsReportOpsDigest: {
    name: 'captains_report_ops_digest_v2',
    lang: 'en',
    paramCount: 2,
    params: ['recipient name', 'run summary'],
    bodyText:
      'Hello {{1}},\n\n' +
      'Account status notification for your union administrator account.\n\n' +
      "Latest captain's report processing run: {{2}}.\n\n" +
      'This is an automated service message. No action is required.',
    // Approved in Meta as UTILITY on 7 Oct 2026 (v2; v1 was approved-as-Marketing).
    status: 'registered',
  },
} as const satisfies Record<string, WhatsAppTemplateDefinition>;

export type WhatsAppTemplateKey = keyof typeof WHATSAPP_TEMPLATES;
