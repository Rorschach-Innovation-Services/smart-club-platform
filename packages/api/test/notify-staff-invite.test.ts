/**
 * Unit tests for the staff-invite WhatsApp body — the 4-param `staff_portal_invite`
 * shape ({{1}} name, {{2}} org, {{3}} email, {{4}} sign-in link) and the cleanParam
 * pass every param now rides through. Pure: exercises the exported param builder rather
 * than the network sender (a real send returns only a synthetic id in dry-run, revealing
 * nothing about the params). Same style as the other notify tests.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { staffInviteParams, sendStaffInviteWhatsApp, WHATSAPP_DRY_RUN } =
  await import('../src/notify/whatsapp.js');
const { sendStaffInvite } = await import('../src/notify/index.js');

describe('staffInviteParams — 4-param staff_portal_invite body', () => {
  test('emits exactly four positional params in order: name, org, email, link', () => {
    const params = staffInviteParams({
      name: 'Thandi Nkosi',
      orgName: 'Titans Cricket',
      email: 'thandi@example.com',
      link: 'https://titans.example.com/sign-in',
    });
    assert.equal(params.length, 4);
    assert.deepEqual(
      params.map((p) => p.text),
      [
        'Thandi Nkosi',
        'Titans Cricket',
        'thandi@example.com',
        'https://titans.example.com/sign-in',
      ],
    );
    for (const p of params) assert.equal(p.type, 'text');
  });

  test('a blank name falls back to "there", never an empty param', () => {
    const params = staffInviteParams({
      name: '',
      orgName: 'Titans Cricket',
      email: 'x@example.com',
      link: 'https://x/',
    });
    assert.equal(params[0].text, 'there');
  });

  test('every param is run through cleanParam (leading/collapsed whitespace Meta rejects)', () => {
    const params = staffInviteParams({
      name: '  Thandi   Nkosi ',
      orgName: 'Titans   Cricket',
      // sheet-sourced emails commonly carry a leading space and mixed case
      email: '  Thandi@Example.com',
      link: 'https://titans.example.com/sign-in',
    });
    assert.equal(params[0].text, 'Thandi Nkosi');
    assert.equal(params[1].text, 'Titans Cricket');
    assert.equal(params[2].text, 'Thandi@Example.com');
    // No param retains a leading/trailing space or a 2+ space run.
    for (const p of params) {
      assert.equal(p.text, p.text.trim());
      assert.doesNotMatch(p.text, /\s{2,}/);
    }
  });
});

describe('sendStaffInviteWhatsApp — dry-run wiring', () => {
  test('in dry-run mode returns a synthetic message id (no network)', async (t) => {
    // The suite runs without WhatsApp credentials, so WHATSAPP_DRY_RUN is on; guard so the
    // test never accidentally attempts a real Graph API POST if credentials are present.
    if (!WHATSAPP_DRY_RUN) return t.skip('WhatsApp credentials present — skipping live-path guard');
    const { messageId } = await sendStaffInviteWhatsApp({
      to: '27831234567',
      name: 'Thandi Nkosi',
      orgName: 'Titans Cricket',
      email: 'thandi@example.com',
      link: 'https://titans.example.com/sign-in',
    });
    assert.match(messageId, /^dry-run-/);
  });
});

describe('sendStaffInvite — an invalid email skips WhatsApp too (minor 5)', () => {
  test('a valid cell but invalid email: both channels skip, WhatsApp names the email', async () => {
    // The template echoes the email as {{3}} — Meta would reject a blank param — so an
    // unusable email must skip WhatsApp, not only the email channel.
    const { results } = await sendStaffInvite({
      email: 'not-an-email',
      name: 'Thandi Nkosi',
      cell: '0831234567',
      orgName: 'Titans Cricket',
      channels: ['email', 'whatsapp'],
      link: 'https://titans.example.com/sign-in',
    });
    const email = results.find((r) => r.channel === 'email');
    const whatsapp = results.find((r) => r.channel === 'whatsapp');
    assert.equal(email?.status, 'skipped');
    assert.equal(whatsapp?.status, 'skipped');
    // The cell is valid here, so the WhatsApp skip is attributed to the email, not the cell.
    assert.match(whatsapp?.error ?? '', /email/);
  });

  test('a valid email + valid cell still sends WhatsApp (dry-run)', async (t) => {
    if (!WHATSAPP_DRY_RUN) return t.skip('WhatsApp credentials present — skipping live-path guard');
    const { results } = await sendStaffInvite({
      email: 'thandi@example.com',
      name: 'Thandi Nkosi',
      cell: '0831234567',
      orgName: 'Titans Cricket',
      channels: ['whatsapp'],
      link: 'https://titans.example.com/sign-in',
    });
    assert.equal(results[0].channel, 'whatsapp');
    assert.equal(results[0].status, 'sent');
  });
});
