/**
 * Transactional email via Amazon SES.
 *
 * ⚠️ SES is NOT available in af-south-1 (where the rest of the stack runs), so the
 * client targets `SES_REGION` (default eu-west-1). A Lambda in af-south-1 calling
 * SES in eu-west-1 is fully supported — only the SES identity must be verified in
 * that region. See docs/guides/popia-compliance.md (cross-border transfer) and the
 * plan in /Users/carlton/.claude/plans.
 *
 * Dry-run: when NOTIFY_DRY_RUN=1 or FROM_EMAIL is unset (local/offline dev, or any
 * stage without SES wired) we log and return a synthetic id instead of calling SES,
 * mirroring the local-DynamoDB toggle in repo.ts. Callers must never treat dry-run
 * as real delivery — the route records the returned status truthfully.
 */
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { randomUUID } from 'node:crypto';
import type { RejectOutcome } from '../types.js';

const SES_REGION = process.env.SES_REGION ?? 'eu-west-1';
const FROM_EMAIL = process.env.FROM_EMAIL;
export const EMAIL_DRY_RUN = process.env.NOTIFY_DRY_RUN === '1' || !FROM_EMAIL;

// Construct once at module load (matches repo.ts's client lifecycle); skip entirely
// in dry-run so no credentials/region are required offline.
const ses = EMAIL_DRY_RUN ? null : new SESClient({ region: SES_REGION });

/** Escape user-supplied values before interpolating into the HTML body. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface StaffInviteEmailInput {
  to: string;
  name: string;
  /** The union/tenant display name, e.g. "Dolphins Pipeline". */
  orgName: string;
  link: string;
}

/**
 * Generic "you've been added to {orgName}" email for a staff (admin/rep) invite.
 * The link is the app sign-in URL (validated by the caller).
 */
export async function sendStaffInviteEmail(
  input: StaffInviteEmailInput,
): Promise<{ messageId: string }> {
  const { to, name, orgName, link } = input;
  const subject = `You've been added to ${orgName}`;
  const greetName = name || 'there';

  const text =
    `Hi ${greetName},\n\n` +
    `You've been given access to ${orgName} on the Smart Club platform.\n\n` +
    `Sign in here to get started:\n\n${link}\n\n` +
    `You'll sign in with a one-time code sent to this email address — no password to remember.\n\n` +
    `See you inside,\nThe ${orgName} office`;

  const safeName = escapeHtml(greetName);
  const safeOrg = escapeHtml(orgName);
  const safeLink = escapeHtml(link);
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2A4A;line-height:1.55;font-size:15px">` +
    `<p>Hi ${safeName},</p>` +
    `<p>You've been given access to <strong>${safeOrg}</strong> on the Smart Club platform.</p>` +
    `<p>Sign in here to get started:</p>` +
    `<p><a href="${safeLink}" style="color:#1D9E75;font-weight:600">${safeLink}</a></p>` +
    `<p>You'll sign in with a one-time code sent to this email address — no password to remember.</p>` +
    `<p>See you inside,<br/>The ${safeOrg} office</p>` +
    `</div>`;

  if (EMAIL_DRY_RUN) {
    console.log(`[notify:email dry-run] would send staff invite to ${to} for ${orgName}`);
    return { messageId: `dry-run-${randomUUID()}` };
  }

  const res = await ses!.send(
    new SendEmailCommand({
      Source: FROM_EMAIL!,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' },
          Text: { Data: text, Charset: 'UTF-8' },
        },
      },
    }),
  );
  return { messageId: res.MessageId ?? '' };
}

/** A single how-to-use-the-app tutorial video link (absolute URL, built by the caller). */
export interface TutorialLink {
  title: string;
  url: string;
}

/** The tenant identity interpolated into the reg-link email (see orgCopy in branding.ts). */
export interface RegLinkOrgCopy {
  /** Full org display name, e.g. "Hollywoodbets Dolphins". */
  name: string;
  /** Sign-off label, e.g. "Dolphins office". */
  office: string;
  /** Cohort label, e.g. "Dolphins Pipeline cohort". */
  cohort: string;
}

export interface RegLinkEmailInput {
  to: string;
  chairName: string;
  clubName: string;
  season: string;
  /** The public player-registration URL (validated by the caller). */
  link: string;
  /** Tenant org copy — the email body carries no hardcoded union name. */
  org: RegLinkOrgCopy;
  /**
   * Optional getting-started section: a link to the in-app tutorials page plus the
   * direct video links. When present, appended below the registration link. Absent ⇒
   * the email is exactly the link-only shape it had before.
   */
  tutorials?: { pageUrl: string; videos: TutorialLink[] };
}

/**
 * Build the reg-link email bodies. Pure (no SES, no env) — exported so tests can
 * assert the rendered copy (e.g. that no hardcoded union name leaks in) without
 * sending anything.
 */
export function regLinkEmailContent(input: RegLinkEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { chairName, clubName, season, link, org, tutorials } = input;
  const subject = `${clubName} · player registration link (${season})`;
  const greetName = chairName || 'there';

  const hasTutorials = !!tutorials && tutorials.videos.length > 0;
  const tutorialsText = hasTutorials
    ? `\n\nNew to the app? These short videos walk you through it — watch them all here:\n${tutorials!.pageUrl}\n\n` +
      tutorials!.videos.map((v) => `• ${v.title}: ${v.url}`).join('\n') +
      `\n`
    : '';

  const text =
    `Hi ${greetName},\n\n` +
    `Your ${clubName} affiliation is in. Here's your unique player-registration link for the ${season} season — share it with your members so they can register straight into the club:\n\n` +
    `${link}\n\n` +
    `Every registration flows directly into your roster and the ${org.cohort}.` +
    `${tutorialsText}\n\n` +
    `The ${org.office}`;

  const safeName = escapeHtml(greetName);
  const safeClub = escapeHtml(clubName);
  const safeSeason = escapeHtml(season);
  const safeLink = escapeHtml(link);
  const safeCohort = escapeHtml(org.cohort);
  const safeOffice = escapeHtml(org.office);
  const tutorialsHtml = hasTutorials
    ? `<p style="margin-top:22px">New to the app? These short videos walk you through it — ` +
      `<a href="${escapeHtml(tutorials!.pageUrl)}" style="color:#1D9E75;font-weight:600">watch them all here</a>:</p>` +
      `<ul style="padding-left:18px;margin:8px 0">` +
      tutorials!.videos
        .map(
          (v) =>
            `<li style="margin:4px 0"><a href="${escapeHtml(v.url)}" style="color:#1D9E75">${escapeHtml(v.title)}</a></li>`,
        )
        .join('') +
      `</ul>`
    : '';
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2A4A;line-height:1.55;font-size:15px">` +
    `<p>Hi ${safeName},</p>` +
    `<p>Your <strong>${safeClub}</strong> affiliation is in. Here's your unique player-registration link for the ${safeSeason} season — share it with your members so they can register straight into the club:</p>` +
    `<p><a href="${safeLink}" style="color:#1D9E75;font-weight:600">${safeLink}</a></p>` +
    `<p>Every registration flows directly into your roster and the ${safeCohort}.</p>` +
    `${tutorialsHtml}` +
    `<p>The ${safeOffice}</p>` +
    `</div>`;

  return { subject, text, html };
}

/**
 * Sent to the chairperson the moment affiliation completes: their unique
 * player-registration link, ready to share with members, plus (optionally) the
 * how-to-use-the-app tutorial videos. Mirrors the invite email shape (a link in the
 * body) and honours the same dry-run gate.
 */
export async function sendRegLinkEmail(input: RegLinkEmailInput): Promise<{ messageId: string }> {
  const { to, clubName } = input;
  const { subject, text, html } = regLinkEmailContent(input);

  if (EMAIL_DRY_RUN) {
    console.log(`[notify:email dry-run] would send reg-link to ${to} for ${clubName}`);
    return { messageId: `dry-run-${randomUUID()}` };
  }

  const res = await ses!.send(
    new SendEmailCommand({
      Source: FROM_EMAIL!,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' },
          Text: { Data: text, Charset: 'UTF-8' },
        },
      },
    }),
  );
  return { messageId: res.MessageId ?? '' };
}

export interface ClearanceEmailInput {
  to: string;
  chairName: string;
  fromClubName: string;
  playerName: string;
  toClubName: string;
}

/**
 * Clearance-pending heads-up to the FROM-club chairman, mirroring the WhatsApp
 * template's copy. Deliberately no sign-in link or "log in" instruction — the chair
 * may hold no portal login (chair invites were removed with admin onboarding), so the
 * body asks for the review to happen in the club portal / via the union office.
 */
export async function sendClearanceEmail(
  input: ClearanceEmailInput,
): Promise<{ messageId: string }> {
  const { to, chairName, fromClubName, playerName, toClubName } = input;
  // Public-route names are collapsed at validation, but portal-entered roster names are
  // not — never let a newline reach an email header.
  const subject = `Clearance pending — ${playerName.replace(/\s+/g, ' ').trim()}`;
  const greetName = chairName || 'there';

  const text =
    `Hello ${greetName},\n\n` +
    `A player clearance is awaiting ${fromClubName}'s review: ${playerName} has applied to join ` +
    `${toClubName} and needs a clearance from your club.\n\n` +
    `Please have this reviewed and approved or rejected in your club portal, or contact your ` +
    `union office if you have any questions.\n\n` +
    `Thank you,\nThe union office`;

  const safeName = escapeHtml(greetName);
  const safeFrom = escapeHtml(fromClubName);
  const safePlayer = escapeHtml(playerName);
  const safeTo = escapeHtml(toClubName);
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2A4A;line-height:1.55;font-size:15px">` +
    `<p>Hello ${safeName},</p>` +
    `<p>A player clearance is awaiting <strong>${safeFrom}</strong>'s review: <strong>${safePlayer}</strong> ` +
    `has applied to join <strong>${safeTo}</strong> and needs a clearance from your club.</p>` +
    `<p>Please have this reviewed and approved or rejected in your club portal, or contact your ` +
    `union office if you have any questions.</p>` +
    `<p>Thank you,<br/>The union office</p>` +
    `</div>`;

  if (EMAIL_DRY_RUN) {
    console.log(`[notify:email dry-run] would send clearance notice to ${to} for ${fromClubName}`);
    return { messageId: `dry-run-${randomUUID()}` };
  }

  const res = await ses!.send(
    new SendEmailCommand({
      Source: FROM_EMAIL!,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' },
          Text: { Data: text, Charset: 'UTF-8' },
        },
      },
    }),
  );
  return { messageId: res.MessageId ?? '' };
}

export interface ClearanceResolvedEmailInput {
  to: string;
  chairName: string;
  fromClubName: string;
  playerName: string;
  toClubName: string;
  /** 'approved' → the union issued the clearance; 'rejected' → the union declined it. */
  outcome: 'approved' | 'rejected';
  /** Free admin note recorded on the resolution. Appended as "Reason: …" when present. */
  reason?: string;
  /**
   * For a REJECTED clearance, what became of the player — reject now cancels the move rather
   * than flagging the destination row, so the body copy states where the player ended up:
   * `source-reactivated` (they stay at / return to the source), `moved-to-source` (the
   * registration moved to the source club), `stays-at-destination` (the source is off-system,
   * so they stay put). Absent on an approved notice; a rejected notice with no value falls
   * back to the source-reactivated copy.
   */
  rejectOutcome?: RejectOutcome;
}

/**
 * Build the clearance-resolved email bodies. Pure (no SES, no env) — exported so tests can
 * assert the rendered copy (e.g. that the admin reason is present and escaped) without
 * sending anything, mirroring regLinkEmailContent.
 */
export function clearanceResolvedEmailContent(input: ClearanceResolvedEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { chairName, fromClubName, playerName, toClubName, outcome, reason, rejectOutcome } = input;
  // Portal-entered roster names aren't whitespace-collapsed on the way in — never let a
  // newline reach an email header.
  const subject = `Clearance ${outcome} — ${playerName.replace(/\s+/g, ' ').trim()}`;
  const greetName = chairName || 'there';

  // Reject now CANCELS the move — the player ends up at the source (or stays put), never on a
  // terminal `clearance-rejected` destination row — so the rejected copy states the outcome and
  // that the clearance can be reopened. The approved copy is unchanged (true for every case).
  const rejectedLead =
    `${playerName}'s clearance from ${fromClubName} to ${toClubName} has been rejected by the ` +
    `union office.`;
  const rejectedDetail =
    rejectOutcome === 'moved-to-source'
      ? `Their registration has been moved to ${fromClubName}, and they no longer appear on ` +
        `${toClubName}'s roster.`
      : rejectOutcome === 'stays-at-destination'
        ? `${fromClubName} is not on the system, so their registration stays at ${toClubName}.`
        : `The move is cancelled and they remain registered at ${fromClubName}.`;
  const rejectedBody =
    `${rejectedLead} ${rejectedDetail} ` +
    `The union office can reopen this clearance if it was rejected in error.`;
  const body =
    outcome === 'approved'
      ? `${playerName}'s clearance from ${fromClubName} to ${toClubName} has been issued by the ` +
        `union office; they are now registered at ${toClubName}.`
      : rejectedBody;
  const reasonLine = reason ? `\n\nReason: ${reason}` : '';

  const text =
    `Hello ${greetName},\n\n` +
    `${body}${reasonLine}\n\n` +
    `If you have any questions, please contact your union office.\n\n` +
    `Thank you,\nThe union office`;

  const safeName = escapeHtml(greetName);
  const safeBody = escapeHtml(body);
  const reasonHtml = reason ? `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : '';
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2A4A;line-height:1.55;font-size:15px">` +
    `<p>Hello ${safeName},</p>` +
    `<p>${safeBody}</p>` +
    `${reasonHtml}` +
    `<p>If you have any questions, please contact your union office.</p>` +
    `<p>Thank you,<br/>The union office</p>` +
    `</div>`;

  return { subject, text, html };
}

/**
 * Clearance-resolved notice to a club chairman (recorded on BOTH clubs by the caller),
 * mirroring the pending notice's shape. Unlike the WhatsApp resolved template, this
 * email CARRIES the admin reason: the recipients are the two clubs' chairs (not Meta's
 * infrastructure), so the free-text note stays inside the union's own channel. Same
 * deliberately link-free body — the chair may hold no portal login — and the same
 * dry-run gate as the other clearance senders.
 */
export async function sendClearanceResolvedEmail(
  input: ClearanceResolvedEmailInput,
): Promise<{ messageId: string }> {
  const { to, fromClubName, outcome } = input;
  const { subject, text, html } = clearanceResolvedEmailContent(input);

  if (EMAIL_DRY_RUN) {
    console.log(
      `[notify:email dry-run] would send clearance-${outcome} notice to ${to} for ${fromClubName}`,
    );
    return { messageId: `dry-run-${randomUUID()}` };
  }

  const res = await ses!.send(
    new SendEmailCommand({
      Source: FROM_EMAIL!,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' },
          Text: { Data: text, Charset: 'UTF-8' },
        },
      },
    }),
  );
  return { messageId: res.MessageId ?? '' };
}

export interface ClearanceReopenedEmailInput {
  to: string;
  chairName: string;
  fromClubName: string;
  playerName: string;
  toClubName: string;
}

/**
 * Build the SOURCE-chair reopen email: the pending clearance copy (the source club must decide
 * the transfer again) with a preamble saying the union office reopened a previously rejected
 * clearance. Pure (no SES, no env) — exported so tests can assert the rendered copy. The pending
 * WhatsApp template rides alongside it (see notify/index.ts); there is no new Meta template.
 */
export function clearanceReopenedSourceEmailContent(input: ClearanceReopenedEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { chairName, fromClubName, playerName, toClubName } = input;
  const subject = `Clearance reopened — ${playerName.replace(/\s+/g, ' ').trim()}`;
  const greetName = chairName || 'there';
  const preamble =
    `The union office has reopened a previously rejected clearance — it needs your club's ` +
    `decision again.`;

  const text =
    `Hello ${greetName},\n\n` +
    `${preamble}\n\n` +
    `A player clearance is awaiting ${fromClubName}'s review: ${playerName} has applied to join ` +
    `${toClubName} and needs a clearance from your club.\n\n` +
    `Please have this reviewed and approved or rejected in your club portal, or contact your ` +
    `union office if you have any questions.\n\n` +
    `Thank you,\nThe union office`;

  const safeName = escapeHtml(greetName);
  const safeFrom = escapeHtml(fromClubName);
  const safePlayer = escapeHtml(playerName);
  const safeTo = escapeHtml(toClubName);
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2A4A;line-height:1.55;font-size:15px">` +
    `<p>Hello ${safeName},</p>` +
    `<p>${escapeHtml(preamble)}</p>` +
    `<p>A player clearance is awaiting <strong>${safeFrom}</strong>'s review: <strong>${safePlayer}</strong> ` +
    `has applied to join <strong>${safeTo}</strong> and needs a clearance from your club.</p>` +
    `<p>Please have this reviewed and approved or rejected in your club portal, or contact your ` +
    `union office if you have any questions.</p>` +
    `<p>Thank you,<br/>The union office</p>` +
    `</div>`;

  return { subject, text, html };
}

/**
 * Build the DESTINATION-chair reopen email. Unlike the source, the destination does NOT act on
 * the clearance — the source club decides — so this is its own body rather than the pending copy,
 * and no WhatsApp template exists for it (the caller records that channel skipped).
 */
export function clearanceReopenedDestEmailContent(input: ClearanceReopenedEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { chairName, fromClubName, playerName } = input;
  const subject = `Clearance reopened — ${playerName.replace(/\s+/g, ' ').trim()}`;
  const greetName = chairName || 'there';
  const body =
    `The union office has reopened ${playerName}'s clearance from ${fromClubName} to your club; ` +
    `the move is under review again and ${fromClubName} will decide.`;

  const text =
    `Hello ${greetName},\n\n` +
    `${body}\n\n` +
    `If you have any questions, please contact your union office.\n\n` +
    `Thank you,\nThe union office`;

  const safeName = escapeHtml(greetName);
  const safeBody = escapeHtml(body);
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2A4A;line-height:1.55;font-size:15px">` +
    `<p>Hello ${safeName},</p>` +
    `<p>${safeBody}</p>` +
    `<p>If you have any questions, please contact your union office.</p>` +
    `<p>Thank you,<br/>The union office</p>` +
    `</div>`;

  return { subject, text, html };
}

/** Send the SOURCE-chair reopen email (pending copy + preamble). Dry-run gated like its siblings. */
export async function sendClearanceReopenedSourceEmail(
  input: ClearanceReopenedEmailInput,
): Promise<{ messageId: string }> {
  const { to, fromClubName } = input;
  const { subject, text, html } = clearanceReopenedSourceEmailContent(input);
  if (EMAIL_DRY_RUN) {
    console.log(
      `[notify:email dry-run] would send clearance-reopened (source) notice to ${to} for ${fromClubName}`,
    );
    return { messageId: `dry-run-${randomUUID()}` };
  }
  const res = await ses!.send(
    new SendEmailCommand({
      Source: FROM_EMAIL!,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Html: { Data: html, Charset: 'UTF-8' }, Text: { Data: text, Charset: 'UTF-8' } },
      },
    }),
  );
  return { messageId: res.MessageId ?? '' };
}

/** Send the DESTINATION-chair reopen email (its own body). Dry-run gated like its siblings. */
export async function sendClearanceReopenedDestEmail(
  input: ClearanceReopenedEmailInput,
): Promise<{ messageId: string }> {
  const { to, fromClubName } = input;
  const { subject, text, html } = clearanceReopenedDestEmailContent(input);
  if (EMAIL_DRY_RUN) {
    console.log(
      `[notify:email dry-run] would send clearance-reopened (destination) notice to ${to} for ${fromClubName}`,
    );
    return { messageId: `dry-run-${randomUUID()}` };
  }
  const res = await ses!.send(
    new SendEmailCommand({
      Source: FROM_EMAIL!,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Html: { Data: html, Charset: 'UTF-8' }, Text: { Data: text, Charset: 'UTF-8' } },
      },
    }),
  );
  return { messageId: res.MessageId ?? '' };
}

export interface FixturesEmailInput {
  to: string;
  playerName: string;
  clubName: string;
  season: string;
  /** Pre-built plain-text schedule (newline-separated). Rendered verbatim into the body. */
  scheduleText: string;
}

/**
 * Send a player the club's released fixtures. Unlike the invite, the full schedule
 * travels in the body (players can't open the auth-gated portal), so there is no link.
 */
export async function sendFixturesEmail(input: FixturesEmailInput): Promise<{ messageId: string }> {
  const { to, playerName, clubName, season, scheduleText } = input;
  const subject = `${clubName} · ${season} fixtures released`;
  const greetName = playerName || 'there';

  const text =
    `Hi ${greetName},\n\n` +
    `${clubName}'s ${season} fixtures have been released. Here's the full schedule:\n\n` +
    `${scheduleText}\n\n` +
    `Travel distances are round-trip estimates. See you on the field,\n${clubName}`;

  const safeName = escapeHtml(greetName);
  const safeClub = escapeHtml(clubName);
  const safeSeason = escapeHtml(season);
  const safeSchedule = escapeHtml(scheduleText).replace(/\n/g, '<br/>');
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2A4A;line-height:1.55;font-size:15px">` +
    `<p>Hi ${safeName},</p>` +
    `<p><strong>${safeClub}</strong>'s ${safeSeason} fixtures have been released. Here's the full schedule:</p>` +
    `<p style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px;white-space:pre-wrap">${safeSchedule}</p>` +
    `<p style="color:#5A6B8C;font-size:13px">Travel distances are round-trip estimates.</p>` +
    `<p>See you on the field,<br/>${safeClub}</p>` +
    `</div>`;

  if (EMAIL_DRY_RUN) {
    console.log(`[notify:email dry-run] would send fixtures to ${to} for ${clubName}`);
    return { messageId: `dry-run-${randomUUID()}` };
  }

  const res = await ses!.send(
    new SendEmailCommand({
      Source: FROM_EMAIL!,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' },
          Text: { Data: text, Charset: 'UTF-8' },
        },
      },
    }),
  );
  return { messageId: res.MessageId ?? '' };
}
