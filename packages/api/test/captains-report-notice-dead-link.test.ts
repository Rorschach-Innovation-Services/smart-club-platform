/**
 * sendReportNotice's prod dead-link guard: a notice whose link points at a loopback host
 * (`captainsReportLinkBase()` falls back to localhost when its env is unset) is refused on
 * every channel in the prod stage, sending nothing. Other stages are unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NOTIFY_DRY_RUN = '1';

const { sendReportNotice } = await import('../src/captains-reports.js');
type Notice = import('../src/captains-reports.js').ReportNotice;

const notice = (url: string): Notice => ({
  tenant: 'dolphins',
  reportId: 's1~f1~umzinto',
  purpose: 'opened',
  recipientKind: 'chair',
  to: { name: 'Chair', email: 'chair@umzinto.test', cell: '0821234567' },
  clubName: 'Umzinto CC',
  matchLine: 'Umzinto CC v African Warriors',
  matchDateText: 'Sun 4 Oct 2026',
  orgName: 'Dolphins',
  expiresText: 'Sunday, 11 Oct',
  token: 'tok',
  url,
  channels: ['email', 'whatsapp'],
});

const prod = { SST_STAGE: 'prod' } as NodeJS.ProcessEnv;
const prodViaApp = { SST_RESOURCE_App: JSON.stringify({ stage: 'prod' }) } as NodeJS.ProcessEnv;

for (const url of [
  'http://localhost:5173/r/tok',
  'http://127.0.0.1:5173/r/tok',
  'http://[::1]:5173/r/tok',
]) {
  test(`prod refuses a ${new URL(url).hostname} link on every channel`, async () => {
    for (const env of [prod, prodViaApp]) {
      const out = await sendReportNotice(notice(url), env);
      assert.deepEqual(out, [
        { channel: 'email', status: 'failed', reason: 'dead-link-base' },
        { channel: 'whatsapp', status: 'failed', reason: 'dead-link-base' },
      ]);
    }
  });
}

test('prod with a real link base sends (dry run here)', async () => {
  const out = await sendReportNotice(notice('https://platform.example.co.za/r/tok'), prod);
  assert.ok(out.every((r) => r.status === 'sent' && r.reason === undefined));
});

test('non-prod stages keep sending localhost links (local dev)', async () => {
  for (const env of [{ SST_STAGE: 'dev' }, {}] as NodeJS.ProcessEnv[]) {
    const out = await sendReportNotice(notice('http://localhost:5173/r/tok'), env);
    assert.ok(out.every((r) => r.status === 'sent'));
  }
});
