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
 * channel as template-pending until it is "registered"), `clearancePendingV2` (the
 * ClearanceReminders cron's WhatsApp gate), the three `dolphins*` welcome-broadcast entries and
 * the two `emcu*` scorer-broadcast entries (their senders throw until "registered") — see those
 * entries.
 *
 * RETIRED: `club_clearance_pending` (the 4-param, link-less v1 clearance template) has NO entry
 * here since 7 Oct 2026. `club_clearance_pending_v2` is the only clearance template; a clearance
 * notice with no link skips WhatsApp rather than sending a link-less message.
 *
 * RETIRED: `scorecard_confirm_due` (the Monday chair scorecard digest) has NO entry here since
 * 7 Oct 2026 — scorecards are confirmed inside the captain's report instead. See the runbook.
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
  /**
   * A media header registered on the template. `VIDEO` ⇒ the sender supplies a public video
   * `link` (header component) on every send. Absent ⇒ no header.
   */
  header?: { format: 'VIDEO' };
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
   * approved Active on 7 Oct 2026 (template id 29115540798081571). The Marketing v1 was
   * deleted from the WABA after the v2 registry change deployed (verified gone 8 Oct 2026).
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

  /**
   * Dolphins welcome broadcast, STAFF message (one-off CLI send-dolphins-welcome-broadcast.ts):
   * chairs, exco, coaches and portal users get the live-scoring tutorial as an inline VIDEO
   * header plus this body. {{1}} is the recipient's actual name (never "Chairman"). Staff
   * receive a SECOND message after this one (`dolphinsPlayerFyi`) — one template carries one
   * video header, and both bodies together would exceed Meta's 1024-char body limit.
   *
   * APPROVED in Meta 8 Oct 2026 as **Utility** (template id 1640089817899845) — reworded from
   * the original Marketing draft (club-setup anchored opener; the "login details" bullet became
   * "Setup" after Meta flagged it as auth-like). `bodyText` is the approved wording; the lines
   * below the bullets were not visible in the approval screenshot, so correct them here if a
   * real send renders differently. This status IS read at runtime: the sender throws
   * `WhatsAppTemplatePendingError` unless it is "registered".
   */
  dolphinsStaffWelcome: {
    name: 'dolphins_staff_welcome',
    lang: 'en',
    paramCount: 1,
    params: ['recipient name'],
    bodyText:
      'Dear {{1}}\n\n' +
      'Your club is set up on the Dolphins live scoring system, powered by Medicoach. Please ' +
      'watch the video above to see how match-day scoring works for your club.\n\n' +
      '✅ Setup: scoring system setup instructions will be sent to you separately\n' +
      '✅ Before the game: scorer login, match checks, squad confirmation\n' +
      '✅ Toss and setup: squads, toss, format and innings setup in the app\n' +
      '✅ During play: ball-by-ball scoring, adding registered or guest players\n' +
      '✅ End of match: totals checked against the umpire, result signed off\n' +
      '✅ Safeguards: switch to paper after 5 minutes stuck, with match-day support on hand\n\n' +
      'Live-scored matches also feed the Dolphins scouting pipeline, where players from clubs, ' +
      'schools and universities are visible to teams looking for them.',
    // Approved in Meta as UTILITY on 8 Oct 2026 (id 1640089817899845).
    status: 'registered',
    header: { format: 'VIDEO' },
  },

  /**
   * Dolphins welcome broadcast, PLAYER message: the scouting-pipeline video as an inline VIDEO
   * header plus this body. {{1}} is the player's first name. Minors receive it on the
   * registered contact (typically the guardian's). Runtime-gated on status, as
   * `dolphinsStaffWelcome`.
   *
   * APPROVED in Meta 8 Oct 2026 as **Utility** (template id 2049161739067483). The registered
   * copy was reworded for Utility (registration-anchored, "for you this season") from the
   * original Marketing draft; `bodyText` is the approved wording.
   */
  dolphinsPlayerWelcome: {
    name: 'dolphins_player_welcome',
    lang: 'en',
    paramCount: 1,
    params: ['player first name'],
    bodyText:
      'Dear {{1}} 🏏\n\n' +
      'You are registered on the Dolphins scouting pipeline, part of the Medicoach Athlete ' +
      'Management System. The video above shows how it works for you this season.\n\n' +
      '📊 Every ball of your matches is scored live and builds your player profile\n' +
      '⭐ Standout performances are flagged and shortlisted\n' +
      '🤝 Players are matched to teams that need them: franchises, tournaments and county teams overseas\n\n' +
      'Your season counts, not just one good day. Keep showing up, keep performing, and make ' +
      'sure your name is spelled correctly on the team sheet so your stats land on your record.\n\n' +
      'Good luck this season! 💚',
    // Approved in Meta as UTILITY on 8 Oct 2026 (id 2049161739067483).
    status: 'registered',
    header: { format: 'VIDEO' },
  },

  /**
   * Dolphins welcome broadcast, staff FYI: the second staff message — the player video header
   * plus a trimmed, third-person version of the player message, framed as what every registered
   * player received. NO body params. Runtime-gated on status, as `dolphinsStaffWelcome`.
   *
   * APPROVED in Meta 8 Oct 2026 as **Marketing** (template id 2158879548337539); `bodyText` is
   * the approved wording (it drops the player message's season paragraph and sign-off).
   */
  dolphinsPlayerFyi: {
    name: 'dolphins_player_fyi',
    lang: 'en',
    paramCount: 0,
    params: [],
    bodyText:
      'For your information, this is the message every registered player has received:\n\n' +
      'Players are registered on the Dolphins scouting pipeline, part of the Medicoach Athlete ' +
      'Management System. The video above shows how it works for them this season.\n\n' +
      '📊 Every ball of their matches is scored live and builds their player profile\n' +
      '⭐ Standout performances are flagged and shortlisted\n' +
      '🤝 Players are matched to teams that need them: franchises, tournaments and county teams overseas',
    // Approved in Meta as MARKETING on 8 Oct 2026 (id 2158879548337539).
    status: 'registered',
    header: { format: 'VIDEO' },
  },

  /**
   * EMCU scorer accounts, CHAIR notice (one-off CLI send-emcu-scorer-broadcast.ts): tells an EMCU
   * club chair their club's MediCoach scorer logins were EMAILED to {{3}}. NO credentials ride on
   * WhatsApp — a credentials template was forced toward Meta's Authentication category (fixed OTP
   * format) and dropped on 9 Oct 2026; logins go by email only. VIDEO header = the staff
   * live-scoring video (Meta-hosted media id, as the welcome broadcast).
   *
   * "4 scorer accounts" is FIXED copy: a club whose credentials file holds a different count has
   * its WhatsApp leg blocked by the CLI (its email states the real count).
   *
   * Buttons (registered in Meta, STATIC — no send-time component; sendTemplate adds a button
   * component only when a dynamic suffix is passed):
   *   0. URL "Download for iPhone"  → https://apps.apple.com/us/app/medicoach-ams/id6760149086
   *   1. URL "Download for Android" → https://play.google.com/store/apps/details?id=co.za.medicoach.app
   *
   * APPROVED in Meta 10 Oct 2026 as **Marketing** (not Utility; template id 1622017422982612),
   * VIDEO header + the two static buttons, body as below. Marketing ⇒ Meta's per-user marketing
   * frequency cap can refuse a send (error 131049); the CLI records that as `marketing-cap`
   * (email-only), not a failure. Runtime-gated on status like the dolphins* entries.
   */
  emcuScorerAccountsNotice: {
    name: 'emcu_scorer_accounts_notice',
    lang: 'en',
    paramCount: 3,
    params: ['chair name', 'club name', 'chair email the logins went to'],
    bodyText:
      'Dear {{1}}\n\n' +
      "EMCU matches for {{2}} are scored live on the MediCoach app this season. Your club's 4 " +
      'scorer accounts have been emailed to {{3}}. Please check your spam folder if you ' +
      "can't see it.\n\n" +
      'Give each scorer their own account, one account per match. Watch the video above to see ' +
      'how scoring works, and download the app using the buttons below or sign in at ' +
      'https://www.medicoach.co.za/\n\n' +
      'Need help? Email info@medicoach.co.za',
    // Approved in Meta as MARKETING on 10 Oct 2026 (id 1622017422982612).
    status: 'registered',
    header: { format: 'VIDEO' },
  },

  /**
   * EMCU live scoring, PLAYER notice (same CLI, `--audience players`): EMCU clubs' players learn
   * their matches are scored live on MediCoach and scouted into the provincial pipeline, and are
   * told to get scorer logins from their club chairperson. {{1}} = first name (no club param since
   * the 10 Oct edit). VIDEO header = the staff live-scoring video. Same two STATIC app buttons as
   * `emcuScorerAccountsNotice`.
   *
   * APPROVED in Meta 10 Oct 2026 as **Marketing** (template id 1785078815861322), VIDEO header +
   * the two static buttons. Subject to the 131049 marketing cap, as above. Runtime-gated on status.
   *
   * EDITED 10 Oct 2026 (same name and id): new user-supplied body with ONE variable (was 2:
   * first name + club). Re-review in Meta is in progress; it stays 'registered' because the name is
   * unchanged and approval is expected before the send. Until the edit clears review, Meta keeps
   * serving the previously approved 2-param body and a 1-param send fails with error 132000, so
   * confirm the edit is approved before running the player WhatsApp leg.
   */
  emcuPlayerScoring: {
    name: 'emcu_player_scoring',
    lang: 'en',
    paramCount: 1,
    params: ['player first name'],
    bodyText:
      'Dear {{1}} 🏏\n\n' +
      "We're proud to be professionalising the KZN cricket ecosystem — and you're part of it.\n\n" +
      'Your matches are now being scored live on the MediCoach app, which means your performances ' +
      'are actively being scouted into the provincial pipeline. Every run, wicket and catch ' +
      'counts. 📊\n\n' +
      '✅ To get started, watch the how-to video above, request your scorer login details from ' +
      'your club chairperson, and score your games on the app.\n\n' +
      'So bring your best today — the system is watching, and this is your chance to put your ' +
      'name forward.\n\n' +
      'Best of luck out there. 💚🏆\n\n' +
      'Dolphins × MediCoach\n\n' +
      'Questions? Email info@medicoach.co.za',
    // Approved in Meta as MARKETING on 10 Oct 2026 (id 1785078815861322); body edited 10 Oct 2026.
    status: 'registered',
    header: { format: 'VIDEO' },
  },
} as const satisfies Record<string, WhatsAppTemplateDefinition>;

export type WhatsAppTemplateKey = keyof typeof WHATSAPP_TEMPLATES;
