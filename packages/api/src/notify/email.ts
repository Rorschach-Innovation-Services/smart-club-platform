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
  /** The vertical's lowercase club noun ("club" / "school"); absent ⇒ "club". */
  club?: string;
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
  const clubNoun = org.club || 'club';

  const hasTutorials = !!tutorials && tutorials.videos.length > 0;
  const tutorialsText = hasTutorials
    ? `\n\nNew to the app? These short videos walk you through it — watch them all here:\n${tutorials!.pageUrl}\n\n` +
      tutorials!.videos.map((v) => `• ${v.title}: ${v.url}`).join('\n') +
      `\n`
    : '';

  const text =
    `Hi ${greetName},\n\n` +
    `Your ${clubName} affiliation is in. Here's your unique player-registration link for the ${season} season — share it with your members so they can register straight into the ${clubNoun}:\n\n` +
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
    `<p>Your <strong>${safeClub}</strong> affiliation is in. Here's your unique player-registration link for the ${safeSeason} season — share it with your members so they can register straight into the ${escapeHtml(clubNoun)}:</p>` +
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

const EMAIL_WRAP_OPEN = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2A4A;line-height:1.55;font-size:15px">`;

async function sendSesEmail(
  to: string,
  content: { subject: string; text: string; html: string },
  dryRunLabel: string,
): Promise<{ messageId: string }> {
  if (EMAIL_DRY_RUN) {
    console.log(`[notify:email dry-run] would send ${dryRunLabel} to ${to}`);
    return { messageId: `dry-run-${randomUUID()}` };
  }
  const res = await ses!.send(
    new SendEmailCommand({
      Source: FROM_EMAIL!,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: content.subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: content.html, Charset: 'UTF-8' },
          Text: { Data: content.text, Charset: 'UTF-8' },
        },
      },
    }),
  );
  return { messageId: res.MessageId ?? '' };
}

export interface ClearanceOpenedDestEmailInput {
  to: string;
  chairName: string;
  fromClubName: string;
  playerName: string;
  toClubName: string;
}

/**
 * DESTINATION-chair heads-up that a clearance opened into the club. The destination does not act
 * on it (the source club decides), so the copy is informational. Pure — exported for tests.
 */
export function clearanceOpenedDestEmailContent(input: Omit<ClearanceOpenedDestEmailInput, 'to'>): {
  subject: string;
  text: string;
  html: string;
} {
  const { chairName, fromClubName, playerName, toClubName } = input;
  const subject = `Incoming clearance — ${playerName.replace(/\s+/g, ' ').trim()}`;
  const greetName = chairName || 'there';
  const body =
    `${playerName} has applied to join ${toClubName} from ${fromClubName}. A clearance from ` +
    `${fromClubName} is now pending; the player becomes active at ${toClubName} once it is issued.`;
  const text =
    `Hello ${greetName},\n\n` +
    `${body}\n\n` +
    `If you have any questions, please contact your union office.\n\n` +
    `Thank you,\nThe union office`;
  const html =
    EMAIL_WRAP_OPEN +
    `<p>Hello ${escapeHtml(greetName)},</p>` +
    `<p>${escapeHtml(body)}</p>` +
    `<p>If you have any questions, please contact your union office.</p>` +
    `<p>Thank you,<br/>The union office</p>` +
    `</div>`;
  return { subject, text, html };
}

export async function sendClearanceOpenedDestEmail(
  input: ClearanceOpenedDestEmailInput,
): Promise<{ messageId: string }> {
  return sendSesEmail(
    input.to,
    clearanceOpenedDestEmailContent(input),
    `clearance-opened (destination) notice for ${input.toClubName}`,
  );
}

export interface ClearanceOpenedAdminEmailInput {
  to: string;
  fromClubName: string;
  playerName: string;
  toClubName: string;
}

/** Union-office (tenant admin) notice that a clearance opened. Pure — exported for tests. */
export function clearanceOpenedAdminEmailContent(
  input: Omit<ClearanceOpenedAdminEmailInput, 'to'>,
): {
  subject: string;
  text: string;
  html: string;
} {
  const { fromClubName, playerName, toClubName } = input;
  const subject = `New clearance — ${playerName.replace(/\s+/g, ' ').trim()}`;
  const body =
    `A clearance has opened for ${playerName}: ${fromClubName} → ${toClubName}. ` +
    `It is waiting on ${fromClubName}'s decision and is listed under Clearances in the admin console.`;
  const text = `Hello,\n\n${body}\n\nThe union office platform`;
  const html =
    EMAIL_WRAP_OPEN +
    `<p>Hello,</p>` +
    `<p>${escapeHtml(body)}</p>` +
    `<p>The union office platform</p>` +
    `</div>`;
  return { subject, text, html };
}

export async function sendClearanceOpenedAdminEmail(
  input: ClearanceOpenedAdminEmailInput,
): Promise<{ messageId: string }> {
  return sendSesEmail(
    input.to,
    clearanceOpenedAdminEmailContent(input),
    `clearance-opened (admin) notice for ${input.fromClubName} → ${input.toClubName}`,
  );
}

export interface ClearanceReminderDigestLine {
  playerName: string;
  fromClubName: string;
  toClubName: string;
  /** Whole days the clearance has been pending (tenant wall-clock). */
  daysPending: number;
}

export interface ClearanceReminderDigestEmailInput {
  to: string;
  orgName: string;
  /** Clearances whose source chair was reminded this run. */
  nudged: ClearanceReminderDigestLine[];
  /** Stale clearances whose source club is not on the system — only the union can resolve them. */
  chairless: ClearanceReminderDigestLine[];
}

/** The ClearanceReminders cron's per-tenant admin digest. Pure — exported for tests. */
export function clearanceReminderDigestEmailContent(
  input: Omit<ClearanceReminderDigestEmailInput, 'to'>,
): { subject: string; text: string; html: string } {
  const { orgName, nudged, chairless } = input;
  const total = nudged.length + chairless.length;
  const subject = `${orgName}: ${total} clearance${total === 1 ? '' : 's'} still pending`;
  const line = (l: ClearanceReminderDigestLine) =>
    `${l.playerName}: ${l.fromClubName} → ${l.toClubName} (${l.daysPending} days)`;
  const sections: Array<{ title: string; lines: ClearanceReminderDigestLine[] }> = [
    { title: "Reminded the source club's chair today", lines: nudged },
    {
      title: 'Source club not on the system — the union office must resolve these',
      lines: chairless,
    },
  ].filter((s) => s.lines.length > 0);
  const text =
    `Hello,\n\n` +
    sections
      .map((s) => `${s.title}:\n${s.lines.map((l) => `- ${line(l)}`).join('\n')}`)
      .join('\n\n') +
    `\n\nThese are listed under Clearances in the admin console.\n\nThe union office platform`;
  const html =
    EMAIL_WRAP_OPEN +
    `<p>Hello,</p>` +
    sections
      .map(
        (s) =>
          `<p><strong>${escapeHtml(s.title)}</strong></p><ul>` +
          s.lines.map((l) => `<li>${escapeHtml(line(l))}</li>`).join('') +
          `</ul>`,
      )
      .join('') +
    `<p>These are listed under Clearances in the admin console.</p>` +
    `<p>The union office platform</p>` +
    `</div>`;
  return { subject, text, html };
}

export async function sendClearanceReminderDigestEmail(
  input: ClearanceReminderDigestEmailInput,
): Promise<{ messageId: string }> {
  return sendSesEmail(
    input.to,
    clearanceReminderDigestEmailContent(input),
    `clearance-reminder digest for ${input.orgName}`,
  );
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

// ───────────────────────── Veterans squad-selection requests (ADR 0013) ─────────────────────────

export interface VeteransRequestEmailInput {
  to: string;
  /** The PRIMARY club's chair — the one who confirms the affiliation. */
  chairName: string;
  veteransClubName: string;
  playerName: string;
  primaryClubName: string;
  /** Free note from the requesting club. Appended as "Note: …" when present. */
  note?: string;
}

/**
 * Build the request-opened email to the PRIMARY club's chair: a veterans club wants to register
 * one of their players for veterans cricket, and the club confirms in its portal. Pure (no SES,
 * no env) — exported so tests can assert the rendered copy, mirroring
 * clearanceResolvedEmailContent. Deliberately link-free (the chair may hold no portal login) and
 * email-only, like the clearance resolved notice.
 */
export function veteransRequestEmailContent(input: VeteransRequestEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { chairName, veteransClubName, playerName, primaryClubName, note } = input;
  const safePlayer = playerName.replace(/\s+/g, ' ').trim();
  const subject = `Veterans request — ${safePlayer}`;
  const greetName = chairName || 'there';
  const body =
    `${veteransClubName} has asked to register ${playerName} (one of ${primaryClubName}'s ` +
    `players) for veterans cricket. As their club, you confirm this in your club portal — ` +
    `Accept adds the affiliation, Decline turns it down. It does not move the player or change ` +
    `your roster.`;
  const noteLine = note ? `\n\nNote from ${veteransClubName}: ${note}` : '';

  const text =
    `Hello ${greetName},\n\n` +
    `${body}${noteLine}\n\n` +
    `If you have any questions, please contact your union office.\n\n` +
    `Thank you,\nThe union office`;

  const safeName = escapeHtml(greetName);
  const safeBody = escapeHtml(body);
  const noteHtml = note
    ? `<p><strong>Note from ${escapeHtml(veteransClubName)}:</strong> ${escapeHtml(note)}</p>`
    : '';
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2A4A;line-height:1.55;font-size:15px">` +
    `<p>Hello ${safeName},</p>` +
    `<p>${safeBody}</p>` +
    `${noteHtml}` +
    `<p>If you have any questions, please contact your union office.</p>` +
    `<p>Thank you,<br/>The union office</p>` +
    `</div>`;

  return { subject, text, html };
}

/**
 * Send the request-opened notice to the primary club chairman. Same dry-run gate + link-free body
 * as the clearance senders.
 */
export async function sendVeteransRequestEmail(
  input: VeteransRequestEmailInput,
): Promise<{ messageId: string }> {
  const { to, playerName } = input;
  const { subject, text, html } = veteransRequestEmailContent(input);

  if (EMAIL_DRY_RUN) {
    console.log(
      `[notify:email dry-run] would send veterans-request notice to ${to} for ${playerName}`,
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

export interface VeteransRequestResolvedEmailInput {
  to: string;
  chairName: string;
  veteransClubName: string;
  playerName: string;
  primaryClubName: string;
  /** 'accepted' → the affiliation is confirmed; 'declined' → the primary club turned it down. */
  outcome: 'accepted' | 'declined';
  /** Decline reason recorded by the primary club / admin. Appended as "Reason: …" when present. */
  reason?: string;
}

/**
 * Build the request-resolved email (to the veterans club chair, and both chairs on an admin
 * override). Pure (no SES, no env) — exported for tests.
 */
export function veteransRequestResolvedEmailContent(input: VeteransRequestResolvedEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { chairName, veteransClubName, playerName, primaryClubName, outcome, reason } = input;
  const safePlayer = playerName.replace(/\s+/g, ' ').trim();
  const subject = `Veterans request ${outcome} — ${safePlayer}`;
  const greetName = chairName || 'there';
  const body =
    outcome === 'accepted'
      ? `${primaryClubName} has confirmed ${playerName}'s affiliation to ${veteransClubName} for ` +
        `veterans cricket. They stay registered at ${primaryClubName}; the veterans affiliation ` +
        `is now recorded.`
      : `${primaryClubName} has declined the request to register ${playerName} for veterans ` +
        `cricket with ${veteransClubName}.`;
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

/** Send the request-resolved notice to a club chairman. Same dry-run gate as the other senders. */
export async function sendVeteransRequestResolvedEmail(
  input: VeteransRequestResolvedEmailInput,
): Promise<{ messageId: string }> {
  const { to, outcome, playerName } = input;
  const { subject, text, html } = veteransRequestResolvedEmailContent(input);

  if (EMAIL_DRY_RUN) {
    console.log(
      `[notify:email dry-run] would send veterans-request-${outcome} notice to ${to} for ${playerName}`,
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

// ───────────────────────── Fixture postponement negotiation (ADR 0015) ─────────────────────────
//
// Email-only, link-free (the chair may hold no portal login), like the veterans notices. Each
// builder is pure (no SES, no env) and exported so tests can assert the rendered copy. The CALLER
// decides what may appear: a kick-off time or ground withheld from clubs (ADR 0011) is simply not
// passed in, so these builders can never leak one.

/** "Sat 2026-11-07" / "Sat 2026-11-07 at 13:00" — weekday + ISO date keeps the copy unambiguous. */
function postponementWhen(date: string, time?: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  const weekday = Number.isNaN(ms)
    ? ''
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(ms).getUTCDay()] + ' ';
  return `${weekday}${date}${time ? ` at ${time}` : ''}`;
}

/** Shared text + html shell for every postponement notice. `lines` are labelled extras. */
function postponementNotice(
  chairName: string,
  body: string,
  lines: Array<[label: string, value: string | undefined]>,
  closing?: string,
): { text: string; html: string } {
  const greetName = chairName || 'there';
  const shown = lines.filter((l): l is [string, string] => !!l[1]);
  const extraText = shown.map(([k, v]) => `\n\n${k}: ${v}`).join('');
  const closingText = closing ? `\n\n${closing}` : '';
  const text =
    `Hello ${greetName},\n\n` +
    `${body}${extraText}${closingText}\n\n` +
    `If you have any questions, please contact your union office.\n\n` +
    `Thank you,\nThe union office`;
  const extraHtml = shown
    .map(([k, v]) => `<p><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</p>`)
    .join('');
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2A4A;line-height:1.55;font-size:15px">` +
    `<p>Hello ${escapeHtml(greetName)},</p>` +
    `<p>${escapeHtml(body)}</p>` +
    `${extraHtml}` +
    (closing ? `<p>${escapeHtml(closing)}</p>` : '') +
    `<p>If you have any questions, please contact your union office.</p>` +
    `<p>Thank you,<br/>The union office</p>` +
    `</div>`;
  return { text, html };
}

export interface PostponementOpenedEmailInput {
  chairName: string;
  requestingClubName: string;
  /** "Home v Away · Series name". */
  fixtureLabel: string;
  originalDate: string;
  originalTime?: string;
  proposedDate: string;
  proposedTime?: string;
  reason?: string;
}

/** To the OPPOSING chair: the other club asks to move the fixture to a new date. */
export function postponementOpenedEmailContent(input: PostponementOpenedEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `Postponement request — ${input.fixtureLabel}`;
  const body =
    `${input.requestingClubName} has asked to postpone ${input.fixtureLabel}, scheduled for ` +
    `${postponementWhen(input.originalDate, input.originalTime)}, to ` +
    `${postponementWhen(input.proposedDate, input.proposedTime)}. Please respond in your club ` +
    `portal — accept the new date, propose another, or decline.`;
  return {
    subject,
    ...postponementNotice(input.chairName, body, [
      [`Reason from ${input.requestingClubName}`, input.reason],
    ]),
  };
}

export interface PostponementCounteredEmailInput {
  chairName: string;
  counteringClubName: string;
  fixtureLabel: string;
  originalDate: string;
  originalTime?: string;
  proposedDate: string;
  proposedTime?: string;
  note?: string;
}

/** To the OTHER chair: a side has proposed a different new date. */
export function postponementCounteredEmailContent(input: PostponementCounteredEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `New date proposed — ${input.fixtureLabel}`;
  const body =
    `${input.counteringClubName} has proposed ${postponementWhen(input.proposedDate, input.proposedTime)} ` +
    `for ${input.fixtureLabel} (originally ${postponementWhen(input.originalDate, input.originalTime)}). ` +
    `Please respond in your club portal — accept it, or propose another date.`;
  return {
    subject,
    ...postponementNotice(input.chairName, body, [
      [`Note from ${input.counteringClubName}`, input.note],
    ]),
  };
}

export interface PostponementAgreedEmailInput {
  chairName: string;
  fixtureLabel: string;
  originalDate: string;
  originalTime?: string;
  newDate: string;
  newTime?: string;
}

/** To BOTH chairs: the clubs agreed and the fixture has moved. */
export function postponementAgreedEmailContent(input: PostponementAgreedEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `Fixture postponed — ${input.fixtureLabel}`;
  const body =
    `Both clubs have agreed: ${input.fixtureLabel}, originally ` +
    `${postponementWhen(input.originalDate, input.originalTime)}, is now on ` +
    `${postponementWhen(input.newDate, input.newTime)}. The fixture list has been updated.`;
  return { subject, ...postponementNotice(input.chairName, body, []) };
}

export interface PostponementAdminFinalEmailInput {
  chairName: string;
  fixtureLabel: string;
  originalDate: string;
  originalTime?: string;
  newDate: string;
  newTime?: string;
  /** Only when the ground is visible to clubs. */
  venueName?: string;
}

/** To BOTH chairs: the union office has set the final date — acknowledge in the portal. */
export function postponementAdminFinalEmailContent(input: PostponementAdminFinalEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `Fixture rescheduled by the union office — ${input.fixtureLabel}`;
  const body =
    `The union office has set the final date for ${input.fixtureLabel} (originally ` +
    `${postponementWhen(input.originalDate, input.originalTime)}): it is now on ` +
    `${postponementWhen(input.newDate, input.newTime)}. The fixture list has been updated.`;
  return {
    subject,
    ...postponementNotice(
      input.chairName,
      body,
      [['Venue', input.venueName]],
      'Please acknowledge this ruling in your club portal.',
    ),
  };
}

export interface PostponementDeclinedEmailInput {
  chairName: string;
  /** The club that declined (opposing) or withdrew (requesting). */
  actingClubName: string;
  fixtureLabel: string;
  originalDate: string;
  originalTime?: string;
  outcome: 'declined' | 'withdrawn';
  reason?: string;
}

/** To the COUNTERPART chair: the request was declined / withdrawn; the fixture stays as it was. */
export function postponementDeclinedEmailContent(input: PostponementDeclinedEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `Postponement ${input.outcome} — ${input.fixtureLabel}`;
  const verb = input.outcome === 'declined' ? 'declined the request' : 'withdrawn its request';
  const body =
    `${input.actingClubName} has ${verb} to postpone ${input.fixtureLabel}. The fixture stays on ` +
    `${postponementWhen(input.originalDate, input.originalTime)}.`;
  return { subject, ...postponementNotice(input.chairName, body, [['Reason', input.reason]]) };
}

// ───────────────────────── Scheduled fixture reminders (FixtureReminders cron) ─────────────────────────
//
// Pure builder, same contract as the postponement notices: the CALLER decides what may appear. A
// kick-off time or ground the series withholds from clubs (ADR 0011) is never passed in — the cron
// reads fixtures through projectSeriesForClub — so this builder cannot leak one.

/** One match on the reminder's date, from the reminded club's point of view. */
export interface FixtureReminderLine {
  seriesName: string;
  /** The club's own side (a multi-team club fields several). */
  sideName: string;
  opponentName: string;
  isHome: boolean;
  /** Only when the series reveals kick-off times to clubs. */
  time?: string;
  /** Only when the series reveals grounds to clubs. */
  venue?: string;
}

export interface FixtureReminderEmailInput {
  chairName: string;
  clubName: string;
  /** "Sat 2026-11-07". */
  dateLabel: string;
  fixtures: FixtureReminderLine[];
  /** The tenant's portal origin; omitted when the tenant has no canonical web origin. */
  portalLink?: string;
}

/** Human date label for a reminder: weekday + ISO date ("Sat 2026-11-07"). */
export function fixtureReminderDateLabel(date: string): string {
  return postponementWhen(date);
}

/** The reminder email to a club chair: every match the club plays on one date. */
export function fixtureReminderEmailContent(input: FixtureReminderEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const greetName = input.chairName || 'there';
  const n = input.fixtures.length;
  const subject = `Fixture reminder — ${input.clubName} · ${input.dateLabel}`;
  const intro = `A reminder that ${input.clubName} has ${n === 1 ? 'a fixture' : `${n} fixtures`} on ${input.dateLabel}:`;
  const lineText = (f: FixtureReminderLine) =>
    [
      f.seriesName,
      `${f.sideName} vs ${f.opponentName} (${f.isHome ? 'Home' : 'Away'})`,
      ...(f.time ? [f.time] : []),
      ...(f.venue ? [f.venue] : []),
    ].join(' · ');
  const portalText = input.portalLink
    ? `See the full fixture details in your club portal: ${input.portalLink}`
    : 'See the full fixture details in your club portal.';
  const text =
    `Hello ${greetName},\n\n` +
    `${intro}\n\n` +
    input.fixtures.map((f) => `  • ${lineText(f)}`).join('\n') +
    `\n\n${portalText}\n\n` +
    `If you have any questions, please contact your union office.\n\n` +
    `Thank you,\nThe union office`;
  const portalHtml = input.portalLink
    ? `See the full fixture details in your club portal: <a href="${escapeHtml(input.portalLink)}">${escapeHtml(input.portalLink)}</a>`
    : 'See the full fixture details in your club portal.';
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2A4A;line-height:1.55;font-size:15px">` +
    `<p>Hello ${escapeHtml(greetName)},</p>` +
    `<p>${escapeHtml(intro)}</p>` +
    `<ul>${input.fixtures.map((f) => `<li>${escapeHtml(lineText(f))}</li>`).join('')}</ul>` +
    `<p>${portalHtml}</p>` +
    `<p>If you have any questions, please contact your union office.</p>` +
    `<p>Thank you,<br/>The union office</p>` +
    `</div>`;
  return { subject, text, html };
}

/** Send one rendered fixture reminder. Same dry-run gate as the other senders. */
export function sendFixtureReminderEmail(
  to: string,
  content: { subject: string; text: string; html: string },
): Promise<{ messageId: string }> {
  return sendPostponementEmail(to, content, 'fixture-reminder');
}

/** Send one rendered postponement notice. Same dry-run gate as the other senders. */
export async function sendPostponementEmail(
  to: string,
  content: { subject: string; text: string; html: string },
  label: string,
): Promise<{ messageId: string }> {
  if (EMAIL_DRY_RUN) {
    console.log(`[notify:email dry-run] would send ${label} notice to ${to}: ${content.subject}`);
    return { messageId: `dry-run-${randomUUID()}` };
  }
  const res = await ses!.send(
    new SendEmailCommand({
      Source: FROM_EMAIL!,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: content.subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: content.html, Charset: 'UTF-8' },
          Text: { Data: content.text, Charset: 'UTF-8' },
        },
      },
    }),
  );
  return { messageId: res.MessageId ?? '' };
}

// ───────────────────────── Captain's report due ─────────────────────────

export interface CaptainsReportDueEmailInput {
  to: string;
  /** Club chair cc'd when the captain is the recipient. */
  cc?: string;
  recipientName: string;
  /** 'captain' → "you captained"; 'chair' → "please complete or send it to the captain". */
  recipientKind: 'captain' | 'chair';
  clubName: string;
  /** "Umzinto v African Warriors" */
  matchLine: string;
  /** "Sun 4 Oct 2026" */
  matchDateText: string;
  /** When the link stops working, "Sunday, 11 Oct" (23:59 SAST that day). */
  expiresText: string;
  /** The submit-once link. NEVER logged. */
  link: string;
  orgName: string;
  /** The one pre-expiry reminder (same link). */
  reminder?: boolean;
  /** The chair who sent the report on to this captain. */
  forwardedBy?: string;
}

/** Build the captain's-report-due email. Pure — exported so tests can assert the copy. */
export function captainsReportDueEmailContent(input: CaptainsReportDueEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { recipientName, recipientKind, clubName, matchLine, matchDateText } = input;
  const greet = recipientName || 'there';
  const subject = `${input.reminder ? 'Reminder: ' : ''}Captain's report open: ${matchLine} (${matchDateText})`;
  const ask = input.forwardedBy
    ? `${input.forwardedBy} asked you to complete ${clubName}'s captain's report for ${matchLine} on ${matchDateText}. Please rate the umpires.`
    : recipientKind === 'captain'
      ? `Please rate the umpires from ${clubName}'s match ${matchLine} on ${matchDateText}.`
      : `${clubName}'s captain's report for ${matchLine} on ${matchDateText} is open. Please complete it, or use "Send to captain" on the report to pass it to the match captain.`;
  const lead = input.reminder
    ? `A reminder: the captain's report is still open and the link expires soon. ${ask}`
    : ask;
  const terms = `You can save a draft and submit once. Link expires ${input.expiresText}.`;
  const after = 'After that, your club chair can still file the report from the club portal.';
  const text =
    `Hi ${greet},\n\n${lead}\n\n` +
    `Open the report here (no sign-in needed):\n\n${input.link}\n\n` +
    `${terms} ${after}\n\n` +
    `Thank you,\nThe ${input.orgName} office`;
  const e = escapeHtml;
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2A4A;line-height:1.55;font-size:15px">` +
    `<p>Hi ${e(greet)},</p>` +
    `<p>${e(lead)}</p>` +
    `<p><a href="${e(input.link)}" style="color:#1D9E75;font-weight:600">Open the captain's report</a> (no sign-in needed)</p>` +
    `<p>${e(terms)} ${e(after)}</p>` +
    `<p>Thank you,<br/>The ${e(input.orgName)} office</p>` +
    `</div>`;
  return { subject, text, html };
}

/** Send the captain's-report-due email (the link rides in the body; never logged). */
export async function sendCaptainsReportDueEmail(
  input: CaptainsReportDueEmailInput,
): Promise<{ messageId: string }> {
  const { subject, text, html } = captainsReportDueEmailContent(input);
  if (EMAIL_DRY_RUN) {
    console.log(
      `[notify:email dry-run] would send captain's report link to ${input.to}` +
        `${input.cc ? ` (cc ${input.cc})` : ''} for ${input.clubName}`,
    );
    return { messageId: `dry-run-${randomUUID()}` };
  }
  const res = await ses!.send(
    new SendEmailCommand({
      Source: FROM_EMAIL!,
      Destination: { ToAddresses: [input.to], ...(input.cc ? { CcAddresses: [input.cc] } : {}) },
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

export interface SyncConflictEmailInput {
  to: string;
  orgName: string;
  /** "Umzinto v African Warriors" */
  matchLine: string;
  seriesName: string;
  reason: 'venue-unresolved' | 'clash';
  /** The clash lines, or the venue that did not resolve. */
  detail: string[];
  /** "2026-10-11 13:30 · Toti Oval 1" */
  proposed: string;
}

/** Build the "medicoach change held for review" email. Pure — exported for tests. */
export function syncConflictEmailContent(input: SyncConflictEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const why =
    input.reason === 'clash'
      ? 'It would double-book a ground, so it was not applied.'
      : 'Its venue does not match any ground in your venue list, so it was not applied.';
  const subject = `Fixture change from medicoach needs review: ${input.matchLine}`;
  const text =
    `A schedule change made in medicoach for ${input.matchLine} (${input.seriesName}) is waiting for review.\n\n` +
    `Proposed: ${input.proposed}\n${why}\n\n` +
    input.detail.map((d) => `- ${d}`).join('\n') +
    `\n\nOpen the admin console, go to Medicoach sync, and apply, discard or edit the fixture.\n\n` +
    `The ${input.orgName} office`;
  const e = escapeHtml;
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2A4A;line-height:1.55;font-size:15px">` +
    `<p>A schedule change made in medicoach for <strong>${e(input.matchLine)}</strong> (${e(input.seriesName)}) is waiting for review.</p>` +
    `<p>Proposed: <strong>${e(input.proposed)}</strong><br/>${e(why)}</p>` +
    `<ul>${input.detail.map((d) => `<li>${e(d)}</li>`).join('')}</ul>` +
    `<p>Open the admin console, go to <strong>Medicoach sync</strong>, and apply, discard or edit the fixture.</p>` +
    `<p>The ${e(input.orgName)} office</p>` +
    `</div>`;
  return { subject, text, html };
}

/** Email one admin about a held medicoach schedule change. */
export async function sendSyncConflictEmail(
  input: SyncConflictEmailInput,
): Promise<{ messageId: string }> {
  const { subject, text, html } = syncConflictEmailContent(input);
  if (EMAIL_DRY_RUN) {
    console.log(
      `[notify:email dry-run] would send sync-conflict notice to ${input.to} for ${input.matchLine}`,
    );
    return { messageId: `dry-run-${randomUUID()}` };
  }
  const res = await ses!.send(
    new SendEmailCommand({
      Source: FROM_EMAIL!,
      Destination: { ToAddresses: [input.to] },
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
