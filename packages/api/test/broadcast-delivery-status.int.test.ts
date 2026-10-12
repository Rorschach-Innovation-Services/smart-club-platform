/**
 * Broadcast WhatsApp delivery tracking, against an in-process dynalite through the real repo:
 * the broadcast CLI's delivery row + `WAMSG#` lookup (kind 'broadcast'), and the status webhook's
 * application of Meta statuses to it (forward-only: sent < delivered < read, failed final),
 * without disturbing the captain's-report lookup path.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4713;
const TABLE = 'SmartClubBroadcastStatusTest';
dynaliteEnv(DDB_PORT, TABLE);

type Repo = typeof import('../src/repo.js');
type Status = typeof import('../src/notify/whatsapp-status.js');
type Cli = typeof import('../src/send-dolphins-welcome-broadcast.js');

let server: Server;
let repo: Repo;
let status: Status;
let cli: Cli;

before(async () => {
  server = await startDynalite(DDB_PORT, TABLE);
  repo = await import('../src/repo.js');
  status = await import('../src/notify/whatsapp-status.js');
  cli = await import('../src/send-dolphins-welcome-broadcast.js');
});
after(async () => stopDynalite(server));

const RUN = '2026-10-09T08-00-00-000Z';
const secs = (iso: string) => String(Date.parse(iso) / 1000);

async function sendRecorded(wamid: string, to = '27820000001') {
  const record = cli.broadcastDeliveryFor(
    RUN,
    { name: 'Sipho', email: 'sipho@example.com', cell: to },
    {
      kind: 'dolphins_player_welcome',
      channel: 'whatsapp',
      to,
      status: 'sent',
      messageId: wamid,
      delivered: true,
      at: '2026-10-09T08:00:05.000Z',
    },
  );
  assert.ok(record);
  await repo.putBroadcastDelivery('dolphins', record);
}

describe('broadcast delivery records + status webhook', () => {
  test('a sent message is recorded at "sent" and resolvable through a broadcast-kind lookup', async () => {
    await sendRecorded('wamid.A');
    const d = await repo.getBroadcastDelivery('dolphins', RUN, 'wamid.A');
    assert.equal(d?.providerStatus, 'sent');
    assert.equal(d?.messageKind, 'dolphins_player_welcome');
    assert.equal(d?.recipientContact, 'sipho@example.com');
    assert.deepEqual(await repo.getWhatsAppMessageLookup('wamid.A'), {
      kind: 'broadcast',
      tenant: 'dolphins',
      runId: RUN,
    });
    // The captain's-report accessor never mistakes a broadcast lookup for a report ref.
    assert.equal(await repo.getWhatsAppMessageRef('wamid.A'), null);
  });

  test('statuses move forward only: delivered, then read; a late "delivered" is stale', async () => {
    await sendRecorded('wamid.B');
    const parsed = status.parseStatuses({
      statuses: [
        { id: 'wamid.B', status: 'delivered', timestamp: secs('2026-10-09T08:01:00Z') },
        { id: 'wamid.B', status: 'read', timestamp: secs('2026-10-09T09:30:00Z') },
        { id: 'wamid.B', status: 'delivered', timestamp: secs('2026-10-09T08:01:00Z') },
        { id: 'wamid.unknown', status: 'read', timestamp: secs('2026-10-09T09:30:00Z') },
      ],
    });
    const summary = await status.applyWhatsAppStatuses(repo, parsed);
    assert.deepEqual(summary, { matched: 2, unknown: 1, stale: 1 });
    const d = await repo.getBroadcastDelivery('dolphins', RUN, 'wamid.B');
    assert.equal(d?.providerStatus, 'read');
    assert.equal(d?.providerAt, '2026-10-09T09:30:00.000Z');
  });

  test('a failed status records Meta’s error and is final', async () => {
    await sendRecorded('wamid.C');
    await status.applyWhatsAppStatuses(
      repo,
      status.parseStatuses({
        statuses: [
          {
            id: 'wamid.C',
            status: 'failed',
            timestamp: secs('2026-10-09T08:02:00Z'),
            errors: [{ title: 'Message undeliverable' }],
          },
          { id: 'wamid.C', status: 'read', timestamp: secs('2026-10-09T08:03:00Z') },
        ],
      }),
    );
    const d = await repo.getBroadcastDelivery('dolphins', RUN, 'wamid.C');
    assert.equal(d?.providerStatus, 'failed');
    assert.equal(d?.providerError, 'Message undeliverable');
  });

  test("the run's rows are listable for the report", async () => {
    const rows = await repo.listBroadcastDeliveries('dolphins', RUN);
    assert.deepEqual(rows.map((r) => r.wamid).sort(), ['wamid.A', 'wamid.B', 'wamid.C']);
    assert.deepEqual(await repo.listBroadcastDeliveries('dolphins', 'other-run'), []);
  });
});
