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

export interface InviteEmailInput {
  to: string;
  chairName: string;
  clubName: string;
  link: string;
}

export async function sendInviteEmail(input: InviteEmailInput): Promise<{ messageId: string }> {
  const { to, chairName, clubName, link } = input;
  const subject = `Welcome to Dolphins Pipeline · ${clubName}`;
  const greetName = chairName || 'team';

  const text =
    `Hi ${greetName},\n\n` +
    `Welcome to the 2026/27 Dolphins Cricket Services season.\n\n` +
    `Open this link to get started — affiliation form, compliance documents and the ` +
    `Club Quality Index self-assessment all live here:\n\n${link}\n\n` +
    `If any of the required documents are outstanding, reach out to the union office. ` +
    `The deadline for submissions is in the platform.\n\n` +
    `Welcome aboard,\nThe Dolphins office`;

  const safeName = escapeHtml(greetName);
  const safeClub = escapeHtml(clubName);
  const safeLink = escapeHtml(link);
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2A4A;line-height:1.55;font-size:15px">` +
    `<p>Hi ${safeName},</p>` +
    `<p>Welcome to the 2026/27 Dolphins Cricket Services season for <strong>${safeClub}</strong>.</p>` +
    `<p>Open this link to get started — affiliation form, compliance documents and the ` +
    `Club Quality Index self-assessment all live here:</p>` +
    `<p><a href="${safeLink}" style="color:#1D9E75;font-weight:600">${safeLink}</a></p>` +
    `<p>If any of the required documents are outstanding, reach out to the union office. ` +
    `The deadline for submissions is in the platform.</p>` +
    `<p>Welcome aboard,<br/>The Dolphins office</p>` +
    `</div>`;

  if (EMAIL_DRY_RUN) {
    console.log(`[notify:email dry-run] would send invite to ${to} for ${clubName}`);
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
