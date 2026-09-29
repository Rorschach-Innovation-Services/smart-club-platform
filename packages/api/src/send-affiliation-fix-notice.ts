/**
 * One-off notice for Sentry issue DOLPHINS-WEB-6 — the affiliation form's "Leagues & Coaches"
 * step crashed for imported Titans clubs (selecting a league blew up the page). The fix is
 * live; this tells the affected user it's fixed and invites them to complete the form.
 *
 *   npx sst shell --stage prod -- npm --prefix packages/api run send-affiliation-fix-notice        # dry-run
 *   … -- --confirm                                                                                  # real send
 *   Optional flags: --to <email>  --name <name>  --link <url>  (defaults below)
 *
 * Notify config under `sst shell`: the FromEmail secret arrives only as SST_RESOURCE_FromEmail
 * JSON, so main() copies it into FROM_EMAIL (when unset) before anything reads it — the same
 * bootstrap as import-titans-contacts.ts. This CLI deliberately does NOT import
 * './notify/email.js' (its dry-run flag freezes at module load); it builds its own SES client,
 * and only when actually sending.
 *
 * Fail-closed: `--confirm` with FROM_EMAIL still unset/empty REFUSES to run instead of
 * "sending" as a silent no-op (the 29 Sep 2026 dry-run-invite incident).
 */
import { pathToFileURL } from 'node:url';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { fromSstResource } from './env.js';

const DEFAULT_TO = 'lwandlebanele8@gmail.com';
const DEFAULT_NAME = 'there';
const DEFAULT_LINK =
  'https://titans.club.medicoach.co.za/club/hammanskraal-cricket-club/affiliation';

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Args {
  confirm: boolean;
  to: string;
  name: string;
  link: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { confirm: false, to: DEFAULT_TO, name: DEFAULT_NAME, link: DEFAULT_LINK };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') args.confirm = true;
    else if (a === '--to') args.to = argv[++i] ?? '';
    else if (a === '--name') args.name = argv[++i] ?? '';
    else if (a === '--link') args.link = argv[++i] ?? '';
    else throw new Error(`unknown flag ${a}`);
  }
  if (!args.link.startsWith('https://')) {
    throw new Error(`--link must start with https:// (got "${args.link}")`);
  }
  if (!EMAIL_SHAPE.test(args.to)) {
    throw new Error(`--to is not a valid email address (got "${args.to}")`);
  }
  return args;
}

/** Escape user-supplied values before interpolating into the HTML body (as notify/email.ts). */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function noticeContent(
  name: string,
  link: string,
): { subject: string; text: string; html: string } {
  const subject = "We've fixed the issue you hit on the Titans affiliation form";
  const greetName = name || 'there';

  const text =
    `Hi ${greetName},\n\n` +
    `While you were completing your club's 2026/27 affiliation on the Titans portal, the "Leagues & Coaches" step stopped working when you selected a league. We noticed this on our side — it was a fault in our platform, not anything you did, and we've fixed it.\n\n` +
    `Please sign back in and pick up where you left off:\n\n${link}\n\n` +
    `You'll sign in with a one-time code sent to this email address. Your club details are still there.\n\n` +
    `We've also checked the rest of the form to make sure you won't run into this again. If anything else gets in your way, just reply to this email and we'll sort it out.\n\n` +
    `Sorry for the trouble, and thank you for your patience.\n\n` +
    `The Smart Club Platform team`;

  const safeName = escapeHtml(greetName);
  const safeLink = escapeHtml(link);
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2A4A;line-height:1.55;font-size:15px">` +
    `<p>Hi ${safeName},</p>` +
    `<p>While you were completing your club's 2026/27 affiliation on the Titans portal, the <strong>&quot;Leagues &amp; Coaches&quot;</strong> step stopped working when you selected a league. We noticed this on our side — it was a fault in our platform, not anything you did, and we've fixed it.</p>` +
    `<p>Please sign back in and pick up where you left off:</p>` +
    `<p><a href="${safeLink}" style="color:#1D9E75;font-weight:600">${safeLink}</a></p>` +
    `<p>You'll sign in with a one-time code sent to this email address. Your club details are still there.</p>` +
    `<p>We've also checked the rest of the form to make sure you won't run into this again. If anything else gets in your way, just reply to this email and we'll sort it out.</p>` +
    `<p>Sorry for the trouble, and thank you for your patience.</p>` +
    `<p>The Smart Club Platform team</p>` +
    `</div>`;

  return { subject, text, html };
}

async function main(): Promise<void> {
  // FIRST, before anything reads FROM_EMAIL: copy the FromEmail secret out of the `sst shell`
  // SST_RESOURCE_FromEmail JSON. An env value already present wins; an empty secret is not copied.
  if (!process.env.FROM_EMAIL) {
    const value = fromSstResource('FromEmail', 'value');
    if (typeof value === 'string' && value) {
      process.env.FROM_EMAIL = value;
      console.log('· notify config from SST linked secrets: FROM_EMAIL');
    }
  }

  const args = parseArgs(process.argv.slice(2));
  const fromEmail = process.env.FROM_EMAIL;
  const { subject, text, html } = noticeContent(args.name, args.link);

  console.log(`To:      ${args.to}`);
  console.log(`From:    ${fromEmail || '(FROM_EMAIL unset)'}`);
  console.log(`Subject: ${subject}`);
  console.log('');
  console.log(text);
  console.log('');

  if (!args.confirm) {
    console.log('Dry-run — no email was sent. Re-run with --confirm to send it.');
    return;
  }

  if (!fromEmail) {
    console.error(
      '✗ FROM_EMAIL is unset — refusing --confirm: the send would be a silent no-op. ' +
        'Run under `npx sst shell --stage prod -- …` so the FromEmail secret is available.',
    );
    process.exitCode = 1;
    return;
  }

  const ses = new SESClient({ region: process.env.SES_REGION ?? 'eu-west-1' });
  const res = await ses.send(
    new SendEmailCommand({
      Source: fromEmail,
      Destination: { ToAddresses: [args.to] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' },
          Text: { Data: text, Charset: 'UTF-8' },
        },
      },
    }),
  );
  console.log(`✓ Sent to ${args.to} — SES MessageId: ${res.MessageId ?? '(none returned)'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
