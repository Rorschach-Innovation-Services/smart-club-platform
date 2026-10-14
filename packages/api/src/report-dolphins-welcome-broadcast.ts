/**
 * Dolphins welcome broadcast — delivery report: who received the messages, with what status
 * and when. Joins a `--confirm` run's manifest (send-dolphins-welcome-broadcast.ts) with the
 * run's WhatsApp delivery rows (`<tenant>#BCAST#<runId>`, kept current by the status webhook)
 * and writes a self-contained HTML report plus a PDF next to it:
 *
 *   npx sst shell --stage <stage> -- npm --prefix packages/api run report:dolphins-welcome -- \
 *     --manifest ./dolphins-welcome-broadcast-<runId>.json [--out-dir <dir>]
 *
 * Outputs `dolphins-welcome-broadcast-report-<runId>.{html,pdf}` (PII — gitignored). Re-run it
 * any time: WhatsApp statuses keep arriving for days after the send.
 *
 * Also renders the EMCU scorer broadcast (send-emcu-scorer-broadcast.ts): a manifest carrying
 * `broadcast: 'emcu-scorers'` picks EMCU_SCORER_REPORT_STYLE (chairs/players labels, its run
 * args) and writes `emcu-scorer-broadcast-report-<runId>.{html,pdf}`. `npm run
 * report:emcu-scorers` is the same CLI.
 *
 * Honest wording: an email outcome is "accepted by SES" — no SES delivery/bounce events are
 * wired, so acceptance is all we know. WhatsApp statuses (delivered / read / failed) come from
 * Meta via the status webhook; a message still at "sent" has had no status back yet.
 *
 * The PDF is printed with Playwright's chromium (the repo-root e2e dependency, resolved at
 * runtime — not a packages/api dependency). Without it the HTML is still written and the CLI
 * says how to get the PDF.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Manifest, MessageOutcome } from './send-dolphins-welcome-broadcast.js';

// Compile-time check: a welcome manifest is a ReportableManifest.
const _welcomeIsReportable = (m: Manifest): ReportableManifest => m;
void _welcomeIsReportable;
import type { BroadcastDelivery } from './repo.js';
import type { Channel } from './types.js';

/**
 * The manifest fields the report reads — satisfied by the welcome broadcast's manifest and by
 * send-emcu-scorer-broadcast.ts's (`broadcast: 'emcu-scorers'`, chairs as cohort 'staff').
 */
export interface ReportableManifest {
  /** Absent on welcome manifests. */
  broadcast?: string;
  tenant: string;
  mode: 'dry-run' | 'confirm';
  runId: string;
  stage: string | null;
  startedAt: string;
  finishedAt?: string;
  args: { channels: Channel[]; only?: string } & Record<string, unknown>;
  recipients: Array<{
    cohort: 'staff' | 'player';
    name: string;
    email: string;
    cell: string;
    roles: string[];
    clubs: string[];
    outcome?: string;
    /** `marketingCap`: Meta 131049 refusal (EMCU scorer broadcast — Marketing templates). */
    messages?: Array<MessageOutcome<string> & { marketingCap?: boolean }>;
    error?: string;
  }>;
  skips: Array<{ reason: string; detail: string }>;
}

// ───────────────────────── Model (pure) ─────────────────────────

export type EmailCell =
  | { status: 'accepted'; at?: string; detail?: string }
  | { status: 'failed' | 'skipped' | 'dry-run'; at?: string; detail?: string };

export type WhatsAppCellStatus =
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'send-error'
  | 'skipped'
  | 'dry-run'
  | 'untracked'
  /** Refused by Meta's per-user marketing cap (131049) — not sent, not a failure. */
  | 'marketing-cap';

export interface WhatsAppCell {
  kind: string;
  status: WhatsAppCellStatus;
  /** The latest timestamp known for this message (status time, else send time). */
  at?: string;
  detail?: string;
}

export interface ReportRow {
  name: string;
  email: string;
  cell: string;
  clubs: string[];
  roles: string[];
  /** Per-recipient run outcome (`replay`, `error`, `not attempted`, …). */
  outcome: string;
  /** Null when the email channel was not part of the run or nothing was attempted. */
  emailOutcome: EmailCell | null;
  whatsapp: WhatsAppCell[];
  error?: string;
}

export interface ReportSummary {
  recipients: { staff: number; player: number };
  outcomes: Record<string, number>;
  emails: { accepted: number; failed: number; skipped: number; dryRun: number };
  /** Funnel over WhatsApp messages accepted by Meta (`sent`): delivered ⊇ read. */
  whatsapp: {
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    awaitingStatus: number;
    sendErrors: number;
    skipped: number;
    untracked: number;
    marketingCap: number;
  };
  skipsByReason: Record<string, number>;
}

export interface ReportModel {
  manifest: Pick<
    ReportableManifest,
    'tenant' | 'runId' | 'stage' | 'startedAt' | 'finishedAt' | 'mode' | 'args'
  >;
  summary: ReportSummary;
  staff: ReportRow[];
  player: ReportRow[];
  skips: Array<{ reason: string; detail: string }>;
}

function emailCell(o: MessageOutcome<string>): EmailCell {
  if (o.status === 'sent') {
    return o.delivered
      ? { status: 'accepted', ...(o.at ? { at: o.at } : {}) }
      : { status: 'dry-run', ...(o.at ? { at: o.at } : {}) };
  }
  return {
    status: o.status,
    ...(o.at ? { at: o.at } : {}),
    ...(o.error ? { detail: o.error } : {}),
  };
}

function whatsappCell(
  o: MessageOutcome<string>,
  byWamid: Map<string, BroadcastDelivery>,
): WhatsAppCell {
  const base = { kind: o.kind };
  if ((o as { marketingCap?: boolean }).marketingCap)
    return { ...base, status: 'marketing-cap', ...(o.at ? { at: o.at } : {}), detail: o.error };
  if (o.status === 'skipped') return { ...base, status: 'skipped', detail: o.error };
  if (o.status === 'failed') {
    return { ...base, status: 'send-error', ...(o.at ? { at: o.at } : {}), detail: o.error };
  }
  if (!o.delivered) return { ...base, status: 'dry-run', ...(o.at ? { at: o.at } : {}) };
  const d = o.messageId ? byWamid.get(o.messageId) : undefined;
  if (!d) {
    return {
      ...base,
      status: 'untracked',
      ...(o.at ? { at: o.at } : {}),
      detail: o.deliveryRecordError ?? 'no delivery record',
    };
  }
  return {
    ...base,
    status: d.providerStatus,
    at: d.providerAt ?? d.sentAt,
    ...(d.providerError ? { detail: d.providerError } : {}),
  };
}

const sortKey = (r: ReportRow) => [r.clubs[0] ?? '￿', r.name.toLowerCase()] as const;
const byClubThenName = (a: ReportRow, b: ReportRow) => {
  const [ca, na] = sortKey(a);
  const [cb, nb] = sortKey(b);
  return ca.localeCompare(cb) || na.localeCompare(nb);
};

/**
 * Join a run's manifest with its WhatsApp delivery rows. PURE. Rows are sorted by first club
 * (people with no club last), then name.
 */
export function buildReport(
  manifest: ReportableManifest,
  deliveries: BroadcastDelivery[],
): ReportModel {
  const byWamid = new Map(deliveries.map((d) => [d.wamid, d]));
  const emailRequested = manifest.args.channels.includes('email');
  const summary: ReportSummary = {
    recipients: { staff: 0, player: 0 },
    outcomes: {},
    emails: { accepted: 0, failed: 0, skipped: 0, dryRun: 0 },
    whatsapp: {
      sent: 0,
      delivered: 0,
      read: 0,
      failed: 0,
      awaitingStatus: 0,
      sendErrors: 0,
      skipped: 0,
      untracked: 0,
      marketingCap: 0,
    },
    skipsByReason: {},
  };
  const staff: ReportRow[] = [];
  const player: ReportRow[] = [];

  for (const r of manifest.recipients) {
    summary.recipients[r.cohort]++;
    const outcome = r.outcome ?? 'not attempted';
    summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
    const messages = r.messages ?? [];
    const emailMsg = messages.find((m) => m.channel === 'email');
    const email = emailMsg ? emailCell(emailMsg) : null;
    if (email) {
      if (email.status === 'accepted') summary.emails.accepted++;
      else if (email.status === 'failed') summary.emails.failed++;
      else if (email.status === 'skipped') summary.emails.skipped++;
      else summary.emails.dryRun++;
    }
    const whatsapp = messages
      .filter((m) => m.channel === 'whatsapp')
      .map((m) => whatsappCell(m, byWamid));
    for (const w of whatsapp) {
      const f = summary.whatsapp;
      if (w.status === 'marketing-cap') f.marketingCap++;
      else if (w.status === 'skipped') f.skipped++;
      else if (w.status === 'send-error') f.sendErrors++;
      else if (w.status === 'untracked') {
        f.sent++;
        f.untracked++;
      } else if (w.status !== 'dry-run') {
        f.sent++;
        if (w.status === 'delivered' || w.status === 'read') f.delivered++;
        if (w.status === 'read') f.read++;
        if (w.status === 'failed') f.failed++;
        if (w.status === 'sent') f.awaitingStatus++;
      }
    }
    const row: ReportRow = {
      name: r.name || (r.cohort === 'staff' ? 'Club Representative' : '(no name)'),
      email: r.email,
      cell: r.cell,
      clubs: r.clubs ?? [],
      roles: r.roles,
      outcome,
      emailOutcome: emailRequested ? email : null,
      whatsapp,
      ...(r.error ? { error: r.error } : {}),
    };
    (r.cohort === 'staff' ? staff : player).push(row);
  }
  for (const s of manifest.skips) {
    summary.skipsByReason[s.reason] = (summary.skipsByReason[s.reason] ?? 0) + 1;
  }
  staff.sort(byClubThenName);
  player.sort(byClubThenName);
  const { tenant, runId, stage, startedAt, finishedAt, mode, args } = manifest;
  return {
    manifest: {
      tenant,
      runId,
      stage,
      startedAt,
      ...(finishedAt ? { finishedAt } : {}),
      mode,
      args,
    },
    summary,
    staff,
    player,
    skips: manifest.skips,
  };
}

// ───────────────────────── HTML (pure) ─────────────────────────

const esc = (v: string): string =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const SAST = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Johannesburg',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** "8 Oct 2026, 14:05" in SAST; '' for a missing/invalid timestamp. */
export function formatSast(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : SAST.format(d);
}

/** What differs between the broadcasts this report renders (title, labels, run-args rows). */
export interface ReportStyle {
  title: string;
  subtitle: string;
  /** PDF footer label. */
  footer: string;
  /** Output file base name, before `-<runId>.{html,pdf}`. */
  fileBase: string;
  cohortLabels: { staff: string; player: string };
  /** WhatsApp message kind → column label. */
  kindLabels: Record<string, string>;
  /** Broadcast-specific "Run" rows (videos, media ids, …). */
  argRows: (args: ReportableManifest['args']) => Array<[string, string]>;
}

const argStr = (v: unknown): string => (typeof v === 'string' ? v : '—');

export const WELCOME_REPORT_STYLE: ReportStyle = {
  title: 'Dolphins welcome broadcast',
  subtitle:
    'Who received the Dolphins Pipeline / Scouting Program welcome, with delivery status and time.',
  footer: 'Dolphins welcome broadcast',
  fileBase: 'dolphins-welcome-broadcast-report',
  cohortLabels: { staff: 'Staff', player: 'Players' },
  kindLabels: {
    dolphins_staff_welcome: 'Staff welcome',
    dolphins_player_fyi: 'Player FYI',
    dolphins_player_welcome: 'Player welcome',
  },
  argRows: (a) => [
    ['Staff video (email link)', argStr(a.staffVideoUrl)],
    ['Player video (email link)', argStr(a.playerVideoUrl)],
    ...(a.staffMediaId
      ? ([
          [
            'WhatsApp videos (Meta media ids)',
            `staff ${argStr(a.staffMediaId)}, player ${a.playerMediaId ? argStr(a.playerMediaId) : '—'}`,
          ],
        ] as Array<[string, string]>)
      : []),
  ],
};

export const EMCU_SCORER_REPORT_STYLE: ReportStyle = {
  title: 'EMCU scorer broadcast',
  subtitle:
    'Who received the EMCU MediCoach live-scoring messages (chairs: scorer logins by email + WhatsApp notice; players: scoring notice), with delivery status and time.',
  footer: 'EMCU scorer broadcast',
  fileBase: 'emcu-scorer-broadcast-report',
  cohortLabels: { staff: 'Chairs', player: 'Players' },
  kindLabels: {
    emcu_scorer_accounts_notice: 'Scorer accounts notice',
    emcu_player_scoring: 'Player scoring notice',
  },
  argRows: (a) => [
    ['Staff video (email link)', argStr(a.staffVideoUrl)],
    ...(a.mediaId
      ? ([['WhatsApp video (Meta media id)', argStr(a.mediaId)]] as Array<[string, string]>)
      : []),
    ...(Array.isArray(a.excludeClubs) && a.excludeClubs.length
      ? ([['Clubs excluded', (a.excludeClubs as string[]).join(', ')]] as Array<[string, string]>)
      : []),
  ],
};

/** The style for a manifest: EMCU scorer manifests carry `broadcast: 'emcu-scorers'`. PURE. */
export const reportStyleFor = (m: Pick<ReportableManifest, 'broadcast'>): ReportStyle =>
  m.broadcast === 'emcu-scorers' ? EMCU_SCORER_REPORT_STYLE : WELCOME_REPORT_STYLE;

const STATUS_LABEL: Record<string, string> = {
  accepted: 'Accepted by SES',
  sent: 'Sent (no status yet)',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed',
  'send-error': 'Send error',
  skipped: 'Skipped',
  'dry-run': 'Dry run (not sent)',
  untracked: 'Sent (untracked)',
  'marketing-cap': 'Not sent — Meta marketing cap',
};

const pill = (status: string, at?: string, detail?: string): string =>
  `<span class="pill s-${esc(status)}">${esc(STATUS_LABEL[status] ?? status)}</span>` +
  (at ? ` <span class="at">${esc(formatSast(at))}</span>` : '') +
  (detail ? `<div class="detail">${esc(detail)}</div>` : '');

function rowsHtml(
  rows: ReportRow[],
  showEmail: boolean,
  kindLabels: Record<string, string>,
): string {
  if (!rows.length) return '<p class="muted">None.</p>';
  const body = rows
    .map((r) => {
      const contact = [r.email, r.cell ? `+${r.cell}` : ''].filter(Boolean).map(esc).join('<br/>');
      const emailCellHtml = !showEmail
        ? ''
        : `<td>${r.outcome === 'replay' ? '<span class="muted">Sent in an earlier run</span>' : rowEmail(r)}</td>`;
      const wa =
        r.outcome === 'replay'
          ? '<span class="muted">Sent in an earlier run</span>'
          : r.whatsapp.length
            ? r.whatsapp
                .map(
                  (w) =>
                    `<div class="wa"><span class="kind">${esc(kindLabels[w.kind] ?? w.kind)}</span> ${pill(w.status, w.at, w.detail)}</div>`,
                )
                .join('')
            : `<span class="muted">${r.outcome === 'sent' ? '—' : esc(r.outcome)}</span>`;
      return (
        `<tr><td><strong>${esc(r.name)}</strong><div class="contact">${contact}</div>` +
        (r.error ? `<div class="detail">${esc(r.error)}</div>` : '') +
        `</td><td>${esc(r.clubs.join(', ') || '—')}</td><td class="roles">${r.roles.map(esc).join('<br/>')}</td>` +
        `${emailCellHtml}<td>${wa}</td></tr>`
      );
    })
    .join('\n');
  return (
    `<table><thead><tr><th>Recipient</th><th>Club</th><th>Role(s)</th>` +
    `${showEmail ? '<th>Email</th>' : ''}<th>WhatsApp</th></tr></thead><tbody>${body}</tbody></table>`
  );
}

function rowEmail(r: ReportRow): string {
  if (!r.emailOutcome)
    return `<span class="muted">${r.outcome === 'sent' ? '—' : esc(r.outcome)}</span>`;
  return pill(r.emailOutcome.status, r.emailOutcome.at, r.emailOutcome.detail);
}

/** Render the report as one self-contained, print-friendly (A4) HTML document. PURE. */
export function renderReportHtml(
  model: ReportModel,
  generatedAt: string,
  style: ReportStyle = WELCOME_REPORT_STYLE,
): string {
  const { manifest: m, summary: s } = model;
  const showEmail = m.args.channels.includes('email');
  const pct = (n: number, of: number) => (of ? ` (${Math.round((n / of) * 100)}%)` : '');
  const metaRows: Array<[string, string]> = [
    ['Tenant', m.tenant],
    ['Stage', m.stage ?? 'unknown'],
    ['Run', m.runId],
    [
      'Sent',
      `${formatSast(m.startedAt)}${m.finishedAt ? ` – ${formatSast(m.finishedAt)}` : ''} (SAST)`,
    ],
    ['Channels', m.args.channels.join(', ')],
    ...style.argRows(m.args),
    ...(m.args.only ? ([['Audience restricted to', m.args.only]] as Array<[string, string]>) : []),
    ['Report generated', `${formatSast(generatedAt)} (SAST)`],
  ];
  const w = s.whatsapp;
  const skipLines = Object.entries(s.skipsByReason)
    .map(([k, n]) => `<li>${esc(k)}: <strong>${n}</strong></li>`)
    .join('');
  const outcomeLines = Object.entries(s.outcomes)
    .map(([k, n]) => `<li>${esc(k)}: <strong>${n}</strong></li>`)
    .join('');
  const skipsTable = model.skips.length
    ? `<table class="compact"><thead><tr><th>Reason</th><th>Row</th></tr></thead><tbody>${model.skips
        .map((k) => `<tr><td>${esc(k.reason)}</td><td>${esc(k.detail)}</td></tr>`)
        .join('')}</tbody></table>`
    : '<p class="muted">No rows were skipped.</p>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(style.title)} report</title>
<style>
  @page { size: A4; margin: 14mm 12mm 16mm; }
  :root { --ink:#1B2A4A; --green:#1D9E75; --muted:#6B7A90; --line:#D5DCE6; --soft:#F3F6F9; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #fff; color: var(--ink);
    font: 10.5pt/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  h1 { font-size: 20pt; margin: 0 0 2px; }
  h1 + .sub { color: var(--muted); margin: 0 0 18px; }
  h2 { font-size: 13pt; margin: 26px 0 8px; padding-bottom: 4px; border-bottom: 2px solid var(--green); }
  a { color: var(--green); }
  .bar { height: 6px; background: var(--green); border-radius: 3px; margin-bottom: 16px; }
  dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 3px 16px; margin: 0; }
  dl.meta dt { color: var(--muted); } dl.meta dd { margin: 0; word-break: break-all; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .card { background: var(--soft); border-radius: 8px; padding: 10px 12px; }
  .card h3 { margin: 0 0 6px; font-size: 10pt; color: var(--muted); font-weight: 600; }
  .card .big { font-size: 18pt; font-weight: 700; }
  .card ul { margin: 4px 0 0; padding-left: 16px; }
  .funnel { display: flex; gap: 8px; margin: 10px 0 4px; }
  .funnel div { flex: 1; text-align: center; background: var(--soft); border-radius: 6px; padding: 8px 4px; }
  .funnel strong { display: block; font-size: 15pt; }
  .note { color: var(--muted); font-size: 9pt; margin: 6px 0 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th { text-align: left; font-size: 9pt; color: var(--muted); border-bottom: 1px solid var(--line); padding: 5px 6px; }
  td { vertical-align: top; border-bottom: 1px solid var(--line); padding: 6px; font-size: 9.5pt; }
  table.compact td { padding: 3px 6px; }
  .contact, .roles, .at, .detail, .muted { color: var(--muted); font-size: 8.5pt; }
  .detail { margin-top: 2px; }
  .wa + .wa { margin-top: 4px; }
  .kind { font-weight: 600; font-size: 8.5pt; }
  .pill { display: inline-block; border-radius: 10px; padding: 1px 7px; font-size: 8.5pt; font-weight: 600;
    background: var(--soft); color: var(--ink); }
  .s-accepted, .s-delivered { background: #DFF3EC; color: #12684D; }
  .s-read { background: var(--green); color: #fff; }
  .s-sent, .s-untracked { background: #E6ECF5; color: var(--ink); }
  .s-failed, .s-send-error { background: #FBE3E1; color: #A3271B; }
  .s-skipped, .s-dry-run, .s-marketing-cap { background: #F1F1F1; color: var(--muted); }
  @media print { body { padding: 0; } h2 { page-break-after: avoid; } }
</style></head>
<body>
<div class="bar"></div>
<h1>${esc(style.title)}</h1>
<p class="sub">${esc(style.subtitle)}</p>

<h2>Run</h2>
<dl class="meta">${metaRows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>

<h2>Summary</h2>
<div class="cards">
  <div class="card"><h3>Recipients</h3><div class="big">${s.recipients.staff + s.recipients.player}</div>
    <ul><li>${esc(style.cohortLabels.staff)}: <strong>${s.recipients.staff}</strong></li><li>${esc(style.cohortLabels.player)}: <strong>${s.recipients.player}</strong></li></ul>
    <ul>${outcomeLines}</ul></div>
  <div class="card"><h3>Emails</h3><div class="big">${s.emails.accepted}</div>
    <ul><li>Accepted by SES: <strong>${s.emails.accepted}</strong></li><li>Failed: <strong>${s.emails.failed}</strong></li>
    <li>Skipped (no email): <strong>${s.emails.skipped}</strong></li>${s.emails.dryRun ? `<li>Dry run: <strong>${s.emails.dryRun}</strong></li>` : ''}</ul></div>
  <div class="card"><h3>Rows skipped</h3><div class="big">${model.skips.length}</div><ul>${skipLines || '<li>none</li>'}</ul></div>
</div>
<h3 style="margin:16px 0 0;font-size:10.5pt">WhatsApp messages</h3>
<div class="funnel">
  <div><strong>${w.sent}</strong>Sent to Meta</div>
  <div><strong>${w.delivered}</strong>Delivered${esc(pct(w.delivered, w.sent))}</div>
  <div><strong>${w.read}</strong>Read${esc(pct(w.read, w.sent))}</div>
  <div><strong>${w.failed}</strong>Failed</div>
  <div><strong>${w.awaitingStatus}</strong>No status yet</div>
</div>
<p class="note">Also: ${w.sendErrors} rejected at send time, ${w.skipped} skipped (no usable cell)${w.marketingCap ? `, ${w.marketingCap} refused by Meta's marketing cap (131049; email only)` : ''}${w.untracked ? `, ${w.untracked} sent without status tracking` : ''}.
Email outcomes mean <em>accepted by SES</em> — no delivery or bounce events are wired for these emails.
WhatsApp statuses are Meta's delivery receipts (delivered / read / failed), received via the status webhook; "read" depends on the recipient's read receipts setting.
Times are SAST.</p>

<h2>${esc(style.cohortLabels.staff)} (${model.staff.length})</h2>
${rowsHtml(model.staff, showEmail, style.kindLabels)}

<h2>${esc(style.cohortLabels.player)} (${model.player.length})</h2>
${rowsHtml(model.player, showEmail, style.kindLabels)}

<h2>Appendix — skipped rows (${model.skips.length})</h2>
${skipsTable}
</body></html>
`;
}

// ───────────────────────── PDF ─────────────────────────

interface PlaywrightLike {
  chromium: {
    launch: () => Promise<{
      newPage: () => Promise<{
        setContent: (html: string, opts: { waitUntil: 'load' }) => Promise<void>;
        pdf: (opts: Record<string, unknown>) => Promise<unknown>;
      }>;
      close: () => Promise<void>;
    }>;
  };
}

/** Print the HTML to an A4 PDF via Playwright's chromium; returns why not when unavailable. */
export async function writePdf(
  html: string,
  path: string,
  footerLabel: string = WELCOME_REPORT_STYLE.footer,
): Promise<{ ok: true } | { ok: false; why: string }> {
  // A variable specifier: playwright is the repo-root e2e dependency, resolved at runtime only.
  const specifier = 'playwright';
  let pw: PlaywrightLike;
  try {
    pw = (await import(specifier)) as PlaywrightLike;
  } catch (err) {
    return {
      ok: false,
      why: `playwright not resolvable (${err instanceof Error ? err.message : err})`,
    };
  }
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="font-size:8px;color:#6B7A90;width:100%;text-align:center">' +
        `${esc(footerLabel)} · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
    });
    return { ok: true };
  } finally {
    await browser.close();
  }
}

// ───────────────────────── Main ─────────────────────────

function parseArgs(argv: string[]): { manifest: string; outDir?: string } {
  let manifest = '';
  let outDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') manifest = argv[++i] ?? '';
    else if (a === '--out-dir') outDir = argv[++i];
    else throw new Error(`unknown flag ${a}`);
  }
  if (!manifest) throw new Error('--manifest <path> is required (a --confirm run manifest)');
  return { manifest, ...(outDir ? { outDir } : {}) };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // A welcome manifest (Manifest) or an EMCU scorer one — both satisfy ReportableManifest.
  const manifest = JSON.parse(await readFile(args.manifest, 'utf8')) as ReportableManifest;
  const style = reportStyleFor(manifest);
  if (manifest.mode !== 'confirm') {
    throw new Error(
      `${args.manifest} is a ${manifest.mode} manifest — only a --confirm run sent anything`,
    );
  }
  if (!manifest.runId) {
    throw new Error(`${args.manifest} has no runId (written before delivery tracking existed)`);
  }

  const repo = await import('./repo.js');
  const deliveries = await repo.listBroadcastDeliveries(manifest.tenant, manifest.runId);
  console.log(`· ${deliveries.length} WhatsApp delivery record(s) for run ${manifest.runId}`);

  const model = buildReport(manifest, deliveries);
  const html = renderReportHtml(model, new Date().toISOString(), style);
  const outDir = args.outDir ?? dirname(args.manifest);
  const base = join(outDir, `${style.fileBase}-${manifest.runId}`);
  await writeFile(`${base}.html`, html);
  console.log(`· HTML: ${base}.html`);

  const pdf = await writePdf(html, `${base}.pdf`, style.footer);
  if (pdf.ok) console.log(`· PDF:  ${base}.pdf`);
  else {
    console.warn(
      `⚠ PDF not written — ${pdf.why}. Install the repo's e2e deps (\`npm install\` at the repo ` +
        'root, then `npx playwright install chromium`) and re-run, or print the HTML to PDF from a browser.',
    );
  }

  const w = model.summary.whatsapp;
  console.log(
    `\n  recipients ${model.staff.length} ${style.cohortLabels.staff.toLowerCase()} + ` +
      `${model.player.length} ${style.cohortLabels.player.toLowerCase()}; emails accepted ` +
      `${model.summary.emails.accepted}; WhatsApp sent ${w.sent}, delivered ${w.delivered}, ` +
      `read ${w.read}, failed ${w.failed}, no status yet ${w.awaitingStatus}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
