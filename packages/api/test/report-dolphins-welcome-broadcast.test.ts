/**
 * Dolphins welcome broadcast report — the pure join of a run manifest with its WhatsApp delivery
 * rows (per-recipient cells + the summary funnel), the HTML rendering, and the forward-only
 * status rule the webhook applies to broadcast rows.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReport,
  renderReportHtml,
  formatSast,
  reportStyleFor,
  EMCU_SCORER_REPORT_STYLE,
  WELCOME_REPORT_STYLE,
} from '../src/report-dolphins-welcome-broadcast.js';
import { broadcastDeliveryFor, broadcastRunId } from '../src/send-dolphins-welcome-broadcast.js';
import { nextProviderStatus } from '../src/notify/whatsapp-status.js';
import type {
  Manifest,
  ManifestRecipient,
  MessageOutcome,
} from '../src/send-dolphins-welcome-broadcast.js';
import type { BroadcastDelivery } from '../src/repo.js';

const RUN = '2026-10-09T08-00-00-000Z';
const AT = '2026-10-09T08:00:05.000Z';

const wa = (
  kind: string,
  messageId: string,
  extra: Partial<MessageOutcome> = {},
): MessageOutcome => ({
  kind: kind as MessageOutcome['kind'],
  channel: 'whatsapp',
  to: '27820000001',
  status: 'sent',
  messageId,
  delivered: true,
  at: AT,
  ...extra,
});
const mail = (kind: string, extra: Partial<MessageOutcome> = {}): MessageOutcome => ({
  kind: kind as MessageOutcome['kind'],
  channel: 'email',
  to: 'x@example.com',
  status: 'sent',
  messageId: 'ses-1',
  delivered: true,
  at: AT,
  ...extra,
});
const recipient = (over: Partial<ManifestRecipient>): ManifestRecipient => ({
  cohort: 'player',
  name: 'P',
  email: '',
  cell: '',
  roles: [],
  clubs: [],
  genericGreeting: false,
  planned: [],
  ...over,
});
const delivery = (wamid: string, over: Partial<BroadcastDelivery> = {}): BroadcastDelivery => ({
  runId: RUN,
  wamid,
  to: '27820000001',
  messageKind: 'dolphins_player_welcome',
  recipientName: 'P',
  recipientContact: 'x',
  providerStatus: 'sent',
  sentAt: AT,
  ...over,
});

const manifest = (recipients: ManifestRecipient[]): Manifest => ({
  tenant: 'dolphins',
  mode: 'confirm',
  runId: RUN,
  stage: 'production',
  startedAt: '2026-10-09T08:00:00.000Z',
  finishedAt: '2026-10-09T08:20:00.000Z',
  args: {
    channels: ['email', 'whatsapp'],
    resend: false,
    includeOperators: false,
    staffVideoUrl: 'https://s3.example.com/staff.mp4',
    playerVideoUrl: 'https://s3.example.com/player.mp4',
    staffMediaId: 'm-staff',
    playerMediaId: 'm-player',
  },
  summary: {} as Manifest['summary'],
  recipients,
  skips: [
    { reason: 'inactive', detail: 'Old Zulu @ A CC' },
    { reason: 'deduped', detail: 'Zola Zulu @ A CC shares a contact with Ayanda' },
    { reason: 'inactive', detail: 'Older Zulu @ B CC' },
  ],
});

describe('buildReport', () => {
  const m = manifest([
    recipient({
      cohort: 'staff',
      name: 'Thandi',
      email: 't@example.com',
      cell: '27820000001',
      clubs: ['Umhlali CC'],
      outcome: 'sent',
      messages: [
        mail('staff-email'),
        wa('dolphins_staff_welcome', 'w1'),
        wa('dolphins_player_fyi', 'w2'),
      ],
    }),
    recipient({
      name: 'Zed',
      cell: '27820000003',
      clubs: ['Zinkwazi CC'],
      outcome: 'sent',
      messages: [
        mail('player-email', {
          status: 'skipped',
          delivered: false,
          error: 'no-email',
          messageId: undefined,
        }),
        wa('dolphins_player_welcome', 'w3'),
      ],
    }),
    recipient({
      name: 'Amy',
      email: 'amy@example.com',
      clubs: ['Amanzimtoti CC'],
      outcome: 'sent',
      messages: [
        mail('player-email'),
        wa('dolphins_player_welcome', '', {
          status: 'failed',
          delivered: false,
          error: '(131026) undeliverable',
          messageId: undefined,
        }),
      ],
    }),
    recipient({
      name: 'Rita',
      email: 'r@example.com',
      clubs: ['Amanzimtoti CC'],
      outcome: 'replay',
    }),
    recipient({ name: 'Never', email: 'n@example.com', clubs: ['Amanzimtoti CC'] }),
  ]);
  const deliveries = [
    delivery('w1', { providerStatus: 'read', providerAt: '2026-10-09T09:00:00.000Z' }),
    delivery('w2', { providerStatus: 'delivered', providerAt: '2026-10-09T08:01:00.000Z' }),
    delivery('w3', {
      providerStatus: 'failed',
      providerAt: '2026-10-09T08:02:00.000Z',
      providerError: 'Message undeliverable',
    }),
  ];
  const report = buildReport(m, deliveries);

  test('joins each WhatsApp message with its latest Meta status and time', () => {
    const [thandi] = report.staff;
    assert.deepEqual(thandi!.emailOutcome, { status: 'accepted', at: AT });
    assert.deepEqual(thandi!.whatsapp, [
      { kind: 'dolphins_staff_welcome', status: 'read', at: '2026-10-09T09:00:00.000Z' },
      { kind: 'dolphins_player_fyi', status: 'delivered', at: '2026-10-09T08:01:00.000Z' },
    ]);
    const zed = report.player.find((r) => r.name === 'Zed')!;
    assert.equal(zed.emailOutcome?.status, 'skipped');
    assert.deepEqual(zed.whatsapp[0], {
      kind: 'dolphins_player_welcome',
      status: 'failed',
      at: '2026-10-09T08:02:00.000Z',
      detail: 'Message undeliverable',
    });
    const amy = report.player.find((r) => r.name === 'Amy')!;
    assert.equal(amy.whatsapp[0]!.status, 'send-error');
  });

  test('players are sorted by club then name; replays and unattempted rows keep their outcome', () => {
    assert.deepEqual(
      report.player.map((r) => [r.clubs[0], r.name, r.outcome]),
      [
        ['Amanzimtoti CC', 'Amy', 'sent'],
        ['Amanzimtoti CC', 'Never', 'not attempted'],
        ['Amanzimtoti CC', 'Rita', 'replay'],
        ['Zinkwazi CC', 'Zed', 'sent'],
      ],
    );
  });

  test('summary: recipients, email acceptance, the WhatsApp funnel and skips by reason', () => {
    assert.deepEqual(report.summary.recipients, { staff: 1, player: 4 });
    assert.deepEqual(report.summary.outcomes, { sent: 3, replay: 1, 'not attempted': 1 });
    assert.deepEqual(report.summary.emails, { accepted: 2, failed: 0, skipped: 1, dryRun: 0 });
    assert.deepEqual(report.summary.whatsapp, {
      sent: 3,
      delivered: 2,
      read: 1,
      failed: 1,
      awaitingStatus: 0,
      sendErrors: 1,
      skipped: 0,
      untracked: 0,
      marketingCap: 0,
    });
    assert.deepEqual(report.summary.skipsByReason, { inactive: 2, deduped: 1 });
  });

  test('a real send with no delivery row is "untracked"; a dry-run id is never counted as sent', () => {
    const r = buildReport(
      manifest([
        recipient({
          outcome: 'sent',
          messages: [
            wa('dolphins_player_welcome', 'w-missing', { deliveryRecordError: 'throttled' }),
            wa('dolphins_player_welcome', 'dry-run-1', { delivered: false }),
          ],
        }),
      ]),
      [],
    );
    assert.deepEqual(
      r.player[0]!.whatsapp.map((w) => [w.status, w.detail]),
      [
        ['untracked', 'throttled'],
        ['dry-run', undefined],
      ],
    );
    assert.equal(r.summary.whatsapp.sent, 1);
    assert.equal(r.summary.whatsapp.untracked, 1);
  });

  test('the HTML escapes recipient data and states what each status means', () => {
    const r = buildReport(
      manifest([
        recipient({
          name: '<script>x</script>',
          clubs: ['A & B'],
          outcome: 'sent',
          messages: [mail('player-email')],
        }),
      ]),
      [],
    );
    const html = renderReportHtml(r, '2026-10-09T10:00:00.000Z');
    assert.ok(html.startsWith('<!doctype html>'));
    assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>x/);
    assert.match(html, /A &amp; B/);
    assert.match(html, /accepted by SES/);
    assert.match(html, /@page \{ size: A4/);
  });

  test('times render in SAST', () => {
    assert.equal(formatSast('2026-10-09T08:05:00.000Z'), '9 Oct 2026, 10:05');
    assert.equal(formatSast(undefined), '');
  });
});

describe('broadcast delivery record (CLI write path)', () => {
  const who = { name: 'Thandi', email: 't@example.com', cell: '27820000001' };

  test('a real WhatsApp send becomes a "sent" delivery row keyed by its wamid', () => {
    assert.deepEqual(broadcastDeliveryFor(RUN, who, wa('dolphins_staff_welcome', 'wamid.X')), {
      runId: RUN,
      wamid: 'wamid.X',
      to: '27820000001',
      messageKind: 'dolphins_staff_welcome',
      recipientName: 'Thandi',
      recipientContact: 't@example.com',
      providerStatus: 'sent',
      sentAt: AT,
    });
  });

  test('emails, failures, skips and dry-run ids are never recorded', () => {
    assert.equal(broadcastDeliveryFor(RUN, who, mail('staff-email')), null);
    assert.equal(
      broadcastDeliveryFor(
        RUN,
        who,
        wa('dolphins_staff_welcome', 'dry-run-1', { delivered: false }),
      ),
      null,
    );
    assert.equal(
      broadcastDeliveryFor(
        RUN,
        who,
        wa('dolphins_staff_welcome', '', { status: 'failed', delivered: false }),
      ),
      null,
    );
  });

  test('the run id is the start timestamp as a key-safe slug', () => {
    assert.equal(broadcastRunId('2026-10-09T08:00:00.000Z'), RUN);
  });
});

describe('nextProviderStatus (webhook, broadcast rows)', () => {
  const s = (status: 'sent' | 'delivered' | 'read' | 'failed', error?: string) => ({
    id: 'w',
    status,
    at: AT,
    ...(error ? { error } : {}),
  });
  test('moves forward only; failed is final and carries an error', () => {
    assert.deepEqual(nextProviderStatus('sent', s('delivered')), {
      providerStatus: 'delivered',
      providerAt: AT,
    });
    assert.equal(nextProviderStatus('read', s('delivered')), null);
    assert.equal(nextProviderStatus('delivered', s('delivered')), null);
    assert.deepEqual(nextProviderStatus('sent', s('failed')), {
      providerStatus: 'failed',
      providerAt: AT,
      providerError: 'failed',
    });
    assert.equal(nextProviderStatus('failed', s('read')), null);
  });
});

describe('EMCU scorer broadcast manifests render through the same report', () => {
  const emcu = {
    broadcast: 'emcu-scorers',
    audience: 'chairs',
    tenant: 'dolphins',
    mode: 'confirm' as const,
    runId: RUN,
    stage: 'prod',
    startedAt: AT,
    args: {
      channels: ['email' as const, 'whatsapp' as const],
      staffVideoUrl: 'https://example.com/staff.mp4',
      mediaId: 'media-9',
      excludeClubs: ['umlazi-cc-mut'],
    },
    recipients: [
      {
        cohort: 'staff' as const,
        name: 'Thandi Nkosi',
        email: 'chair@example.com',
        cell: '27820000001',
        roles: ['Chairperson @ Umhlali CC'],
        clubs: ['Umhlali CC'],
        outcome: 'sent',
        scorerAccounts: 4,
        messages: [mail('emcu-chair-email'), wa('emcu_scorer_accounts_notice', 'wamid.E1')],
      },
    ],
    skips: [{ reason: 'no-chair-email', detail: 'Dolphins Deaf (dolphins-deaf-cricket-team)' }],
  };

  test('the manifest picks the EMCU style; a welcome manifest keeps the welcome style', () => {
    assert.equal(reportStyleFor(emcu), EMCU_SCORER_REPORT_STYLE);
    assert.equal(reportStyleFor({}), WELCOME_REPORT_STYLE);
  });

  test('chairs are labelled as chairs, with EMCU kind labels and run args', () => {
    const model = buildReport(emcu, [delivery('wamid.E1', { providerStatus: 'read' })]);
    assert.equal(model.staff.length, 1);
    assert.equal(model.summary.whatsapp.read, 1);
    const html = renderReportHtml(model, AT, EMCU_SCORER_REPORT_STYLE);
    assert.match(html, /<title>EMCU scorer broadcast report<\/title>/);
    assert.match(html, /<h2>Chairs \(1\)<\/h2>/);
    assert.match(html, /Scorer accounts notice/);
    assert.match(html, /WhatsApp video \(Meta media id\)<\/dt><dd>media-9/);
    assert.match(html, /Clubs excluded<\/dt><dd>umlazi-cc-mut/);
    assert.doesNotMatch(html, /Dolphins welcome/);
  });

  test('a marketing-capped WhatsApp shows as its own status, not a send error', () => {
    const capped = {
      ...emcu,
      recipients: [
        {
          ...emcu.recipients[0]!,
          messages: [
            mail('emcu-chair-email'),
            {
              ...wa('emcu_scorer_accounts_notice', ''),
              status: 'skipped' as const,
              delivered: false,
              error: 'marketing-cap (131049): healthy ecosystem',
              marketingCap: true,
            },
          ],
        },
      ],
    };
    const model = buildReport(capped, []);
    assert.equal(model.summary.whatsapp.marketingCap, 1);
    assert.equal(model.summary.whatsapp.sendErrors, 0);
    assert.equal(model.summary.whatsapp.skipped, 0);
    assert.equal(model.staff[0]!.whatsapp[0]!.status, 'marketing-cap');
    const html = renderReportHtml(model, AT, EMCU_SCORER_REPORT_STYLE);
    assert.match(html, /Not sent — Meta marketing cap/);
    assert.match(html, /1 refused by Meta&#39;s marketing cap|1 refused by Meta's marketing cap/);
  });
});
