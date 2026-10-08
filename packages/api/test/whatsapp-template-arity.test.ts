/**
 * Every WhatsApp sender must emit exactly the number of body parameters its Meta
 * template declares. A mismatch fails at send time with Meta error 132000, which the
 * send path records as a `failed` comm-log row rather than throwing — so an arity
 * drift is otherwise silent (the email still goes). This walks the code registry so a
 * changed template arity or param builder cannot land without updating one shared table.
 *
 * Ported from medicoach's whatsapp-template-arity.test.ts, adapted to node:test.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  staffInviteParams,
  regLinkParams,
  fixturesParams,
  clearanceV2Params,
  clearanceTemplateFor,
  fixtureReminderParams,
  captainsReportDueParams,
  captainsReportOpsDigestParams,
  sendCaptainsReportOpsDigestWhatsApp,
  urlButtonComponent,
  videoHeaderComponent,
  dolphinsStaffWelcomeParams,
  dolphinsPlayerWelcomeParams,
  dolphinsPlayerFyiParams,
  sendDolphinsStaffWelcomeWhatsApp,
  sendDolphinsPlayerWelcomeWhatsApp,
  sendDolphinsPlayerFyiWhatsApp,
  WhatsAppTemplatePendingError,
  assertTemplateSendable,
} = await import('../src/notify/whatsapp.js');
const { WHATSAPP_TEMPLATES } = await import('../src/notify/whatsapp-templates.js');

const LINK = 'https://club.example.com/sign-in';

/** Every live param builder, invoked with representative args, keyed to its registry entry. */
const BUILDERS = [
  {
    key: 'staffInvite' as const,
    params: staffInviteParams({
      name: 'Thandi Nkosi',
      orgName: 'Titans Cricket',
      email: 'thandi@example.com',
      link: LINK,
    }),
  },
  {
    key: 'reglinkReady' as const,
    params: regLinkParams({
      chairName: 'Thandi Nkosi',
      clubName: 'Adelaar CC',
      regLink: LINK,
      tutorialsUrl: 'https://club.example.com/tutorials',
    }),
  },
  {
    key: 'fixturesReleased' as const,
    params: fixturesParams({
      playerName: 'A Player',
      clubName: 'Adelaar CC',
      season: '2026-27',
    }),
  },
  {
    key: 'captainsReportDue' as const,
    params: captainsReportDueParams({
      recipientName: 'Sanele Mthembu',
      orgName: 'KZN Dolphins',
      match: 'Umzinto v African Warriors on Sun 4 Oct 2026',
    }),
  },
  {
    key: 'captainsReportOpsDigest' as const,
    params: captainsReportOpsDigestParams({
      recipientName: 'Union admin',
      summary: 'Dolphins: 3 new results, 6 reports opened, 6 notices sent, 0 failed',
    }),
  },
  {
    key: 'clearancePendingV2' as const,
    params: clearanceV2Params({
      chairName: 'Thandi Nkosi',
      fromClubName: 'Adelaar CC',
      playerName: 'A Player',
      toClubName: 'Centurion Kavaliers',
      portalLink: 'https://club.example.com/club/c1/clearances?clearance=clr-1',
    }),
  },
  {
    key: 'fixtureReminder' as const,
    params: fixtureReminderParams({
      chairName: 'Thandi Nkosi',
      clubName: 'Adelaar CC',
      dateLabel: 'Sat 2026-11-07',
      portalLink: LINK,
    }),
  },
  {
    key: 'dolphinsStaffWelcome' as const,
    params: dolphinsStaffWelcomeParams({ name: 'Thandi Nkosi' }),
  },
  {
    key: 'dolphinsPlayerWelcome' as const,
    params: dolphinsPlayerWelcomeParams({ firstName: 'Sipho' }),
  },
  {
    key: 'dolphinsPlayerFyi' as const,
    params: dolphinsPlayerFyiParams(),
  },
];

/** The {{n}} placeholders in a body, in the order they appear. */
const placeholdersIn = (body: string): number[] =>
  (body.match(/\{\{(\d+)\}\}/g) ?? []).map((p) => Number(p.slice(2, -2)));

describe('whatsapp template arity', () => {
  for (const { key, params } of BUILDERS) {
    const def = WHATSAPP_TEMPLATES[key];

    test(`${key}: builder emits exactly the declared paramCount`, () => {
      assert.equal(params.length, def.paramCount);
      for (const p of params) assert.equal(p.type, 'text');
    });

    test(`${key}: bodyText placeholders are sequential from 1 with no gaps and count === paramCount`, () => {
      const nums = placeholdersIn(def.bodyText);
      assert.equal(nums.length, def.paramCount, 'placeholder count must equal paramCount');
      const expected = Array.from({ length: def.paramCount }, (_, i) => i + 1);
      assert.deepEqual(nums, expected, 'placeholders must run 1..paramCount in order');
    });

    test(`${key}: params meaning list length matches paramCount`, () => {
      assert.equal(def.params.length, def.paramCount);
    });
  }
});

describe('whatsapp URL buttons', () => {
  test('every template with a URL button registers exactly one {{1}} suffix at the end', () => {
    for (const def of Object.values(WHATSAPP_TEMPLATES)) {
      const button = (def as { urlButton?: { urlTemplate: string } }).urlButton;
      if (!button) continue;
      assert.match(button.urlTemplate, /^https:\/\/[^{}]+\{\{1\}\}$/);
    }
  });

  test('the captains_report_due button carries the token as its single suffix param', () => {
    assert.ok(WHATSAPP_TEMPLATES.captainsReportDue.urlButton);
    const c = urlButtonComponent('tok.sig');
    assert.deepEqual(c, {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: 'tok.sig' }],
    });
  });

  test('the report link never rides in the body params', () => {
    const params = captainsReportDueParams({
      recipientName: 'A',
      orgName: 'O',
      match: 'C',
    });
    for (const p of params) assert.doesNotMatch(p.text, /https?:\/\//);
  });
});

describe("captain's report template (v2 copy, edited in place in Meta 4 Oct 2026)", () => {
  const due = WHATSAPP_TEMPLATES.captainsReportDue;

  test('three body params: recipient name, union name, match line + date', () => {
    assert.equal(due.name, 'captains_report_due');
    assert.equal(due.status, 'registered');
    assert.equal(due.paramCount, 3);
    assert.deepEqual(due.params, ['recipient name', 'org name', 'match line + date']);
    assert.equal(
      due.bodyText,
      'Hello {{1}},\n\n' +
        "The {{2}} captain's report for {{3}} is open. Please rate the umpires.\n\n" +
        'Tap the button below to open it. You can submit it once; the link expires on the date shown in the report.',
    );
    assert.deepEqual(
      captainsReportDueParams({
        recipientName: 'Sanele',
        orgName: 'KZN Dolphins',
        match: 'Umzinto v AW on Sun 20 Sep 2026',
      }).map((p) => p.text),
      ['Sanele', 'KZN Dolphins', 'Umzinto v AW on Sun 20 Sep 2026'],
    );
  });

  test('the copy says "submit it once" and never "works once" or a possessive club name', () => {
    assert.match(due.bodyText, /You can submit it once; the link expires on the date shown/);
    assert.doesNotMatch(due.bodyText, /works once/);
    assert.doesNotMatch(due.bodyText, /'s captain's report/);
  });

  test("there is exactly one captain's-report LINK template in the registry", () => {
    // The ops digest (below) is a separate, button-less status template.
    const names = Object.values(WHATSAPP_TEMPLATES)
      .map((d) => d.name)
      .filter((n) => n.startsWith('captains_report'));
    assert.deepEqual(names, ['captains_report_due', 'captains_report_ops_digest_v2']);
    const linked = Object.values(WHATSAPP_TEMPLATES).filter(
      (d) => d.name.startsWith('captains_report') && 'urlButton' in d,
    );
    assert.deepEqual(
      linked.map((d) => d.name),
      ['captains_report_due'],
    );
  });
});

describe("captain's report ops digest template", () => {
  const digest = WHATSAPP_TEMPLATES.captainsReportOpsDigest;

  test('two body params, no URL button, registered in Meta as UTILITY (v2, 7 Oct 2026)', () => {
    // v1 (captains_report_ops_digest) was approved as MARKETING; category is immutable
    // once approved, so v2 was created fresh as Utility with transaction-anchored copy.
    assert.equal(digest.name, 'captains_report_ops_digest_v2');
    assert.equal(digest.lang, 'en');
    assert.equal(digest.status, 'registered');
    assert.equal(digest.paramCount, 2);
    assert.deepEqual(digest.params, ['recipient name', 'run summary']);
    assert.ok(!('urlButton' in digest));
    assert.equal(
      digest.bodyText,
      'Hello {{1}},\n\n' +
        'Account status notification for your union administrator account.\n\n' +
        "Latest captain's report processing run: {{2}}.\n\n" +
        'This is an automated service message. No action is required.',
    );
  });

  test('the summary is bounded at 300 chars and collapsed to one line', () => {
    const [name, summary] = captainsReportOpsDigestParams({
      recipientName: '',
      summary: `Dolphins:\n${'x'.repeat(400)}`,
    });
    assert.equal(name.text, 'there');
    assert.equal(summary.text.length, 300);
    assert.doesNotMatch(summary.text, /\n/);
  });

  test('the sender sends once registered (dry-run without credentials)', async () => {
    const { messageId } = await sendCaptainsReportOpsDigestWhatsApp({
      to: '+27000000000',
      recipientName: 'Union admin',
      summary: 'x',
    });
    assert.match(messageId, /^dry-run-/);
  });
});

describe('clearance-pending template (v2 only; v1 retired in code 7 Oct 2026)', () => {
  const v2 = WHATSAPP_TEMPLATES.clearancePendingV2;
  const copy = {
    chairName: 'Thandi  Nkosi',
    fromClubName: 'Adelaar CC',
    playerName: 'A\nPlayer',
    toClubName: 'Centurion Kavaliers',
  };
  const LONG_LINK = `https://club.example.com/club/c1/clearances?clearance=${'x'.repeat(120)}`;

  test('v2 is the only clearance template: the retired v1 name has no registry entry', () => {
    assert.equal(v2.name, 'club_clearance_pending_v2');
    assert.equal(v2.status, 'registered');
    assert.equal(v2.paramCount, 5);
    const names = Object.values(WHATSAPP_TEMPLATES)
      .map((d) => d.name)
      .filter((n) => n.startsWith('club_clearance'));
    assert.deepEqual(names, ['club_clearance_pending_v2']);
  });

  test('a linked notice picks v2 with the link passed through whole (never truncated)', () => {
    const pick = clearanceTemplateFor({ ...copy, portalLink: LONG_LINK });
    assert.ok(pick);
    assert.equal(pick.key, 'clearancePendingV2');
    assert.equal(pick.params.length, v2.paramCount);
    // Text params are cleaned; the link is not.
    assert.deepEqual(
      pick.params.map((p) => p.text),
      ['Thandi Nkosi', 'Adelaar CC', 'A Player', 'Centurion Kavaliers', LONG_LINK],
    );
  });

  test('a notice with no link picks no template — the caller skips WhatsApp', () => {
    assert.equal(clearanceTemplateFor(copy), null);
    assert.equal(clearanceTemplateFor({ ...copy, portalLink: '' }), null);
  });

  test('the v2 body keeps the union-office fallback and does not end on the link variable', () => {
    assert.match(v2.bodyText, /Review it here: \{\{5\}\}/);
    assert.match(v2.bodyText, /contact your union office/);
    assert.doesNotMatch(v2.bodyText, /\{\{\d+\}\}\s*$/);
  });
});

describe('Dolphins welcome broadcast templates (VIDEO header; all three approved 8 Oct 2026)', () => {
  const VIDEO = 'https://bucket.s3.af-south-1.amazonaws.com/tutorials/dolphins/x.mp4';
  const entries = [
    ['dolphinsStaffWelcome', 'dolphins_staff_welcome', 1],
    ['dolphinsPlayerWelcome', 'dolphins_player_welcome', 1],
    ['dolphinsPlayerFyi', 'dolphins_player_fyi', 0],
  ] as const;

  for (const [key, name, arity] of entries) {
    test(`${name}: en, ${arity} body param(s), VIDEO header, no URL button`, () => {
      const def = WHATSAPP_TEMPLATES[key];
      assert.equal(def.name, name);
      assert.equal(def.lang, 'en');
      assert.equal(def.paramCount, arity);
      assert.deepEqual(def.header, { format: 'VIDEO' });
      assert.ok(!('urlButton' in def));
      assert.ok(def.bodyText.length <= 1024, 'Meta caps a template body at 1024 chars');
      assert.doesNotMatch(
        def.bodyText,
        /^\{\{|\{\{\d+\}\}\s*$/,
        'Meta rejects a body starting/ending on a variable',
      );
    });
  }

  test('only the broadcast templates declare a media header', () => {
    const withHeader = Object.values(WHATSAPP_TEMPLATES)
      .filter((d) => 'header' in d)
      .map((d) => d.name);
    assert.deepEqual(withHeader, [
      'dolphins_staff_welcome',
      'dolphins_player_welcome',
      'dolphins_player_fyi',
    ]);
  });

  test('the WhatsApp copy points at the video above, not a link', () => {
    for (const [key] of entries) {
      assert.match(WHATSAPP_TEMPLATES[key].bodyText, /video above/);
      assert.doesNotMatch(WHATSAPP_TEMPLATES[key].bodyText, /https?:\/\//);
    }
  });

  test('the player and FYI bodies are the Meta-approved wording (8 Oct 2026)', () => {
    const player = WHATSAPP_TEMPLATES.dolphinsPlayerWelcome;
    assert.equal(player.status, 'registered');
    assert.equal(
      player.bodyText,
      'Dear {{1}} 🏏\n\n' +
        'You are registered on the Dolphins scouting pipeline, part of the Medicoach Athlete Management System. The video above shows how it works for you this season.\n\n' +
        '📊 Every ball of your matches is scored live and builds your player profile\n' +
        '⭐ Standout performances are flagged and shortlisted\n' +
        '🤝 Players are matched to teams that need them: franchises, tournaments and county teams overseas\n\n' +
        'Your season counts, not just one good day. Keep showing up, keep performing, and make sure your name is spelled correctly on the team sheet so your stats land on your record.\n\n' +
        'Good luck this season! 💚',
    );
    // The approved FYI is a trimmed third-person variant, not the player body minus its greeting.
    const fyi = WHATSAPP_TEMPLATES.dolphinsPlayerFyi;
    assert.equal(fyi.status, 'registered');
    assert.equal(
      fyi.bodyText,
      'For your information, this is the message every registered player has received:\n\n' +
        'Players are registered on the Dolphins scouting pipeline, part of the Medicoach Athlete Management System. The video above shows how it works for them this season.\n\n' +
        '📊 Every ball of their matches is scored live and builds their player profile\n' +
        '⭐ Standout performances are flagged and shortlisted\n' +
        '🤝 Players are matched to teams that need them: franchises, tournaments and county teams overseas',
    );
  });

  test('the video header carries the link whole (never cleaned or truncated)', () => {
    const long = `${VIDEO}?${'x'.repeat(200)}`;
    assert.deepEqual(videoHeaderComponent({ link: long }), {
      type: 'header',
      parameters: [{ type: 'video', video: { link: long } }],
    });
  });

  test('the video header carries a Meta media id as video.id (no link)', () => {
    assert.deepEqual(videoHeaderComponent({ id: '1234567890' }), {
      type: 'header',
      parameters: [{ type: 'video', video: { id: '1234567890' } }],
    });
  });

  test('name params are cleaned, with neutral fallbacks', () => {
    assert.deepEqual(
      dolphinsStaffWelcomeParams({ name: ' Thandi\n Nkosi ' }).map((p) => p.text),
      ['Thandi Nkosi'],
    );
    assert.deepEqual(
      dolphinsStaffWelcomeParams({ name: '' }).map((p) => p.text),
      ['Club Representative'],
    );
    assert.deepEqual(
      dolphinsPlayerWelcomeParams({ firstName: '' }).map((p) => p.text),
      ['player'],
    );
  });

  test('all three are approved in Meta (8 Oct 2026) and their senders pass the gate', async () => {
    for (const [key] of entries) assert.equal(WHATSAPP_TEMPLATES[key].status, 'registered');
    // Registered: they reach sendTemplate (dry-run without credentials).
    const staff = await sendDolphinsStaffWelcomeWhatsApp('27820000000', 'A', { link: VIDEO });
    assert.match(staff.messageId, /^dry-run-/);
    const player = await sendDolphinsPlayerWelcomeWhatsApp('27820000000', 'A', { id: 'media-1' });
    assert.match(player.messageId, /^dry-run-/);
    const fyi = await sendDolphinsPlayerFyiWhatsApp('27820000000', { id: 'media-1' });
    assert.match(fyi.messageId, /^dry-run-/);
  });

  test('the gate refuses a pending template unless allowPending (experiment CLI only)', () => {
    const pending = { ...WHATSAPP_TEMPLATES.dolphinsStaffWelcome, status: 'pending' as const };
    assert.throws(() => assertTemplateSendable(pending), WhatsAppTemplatePendingError);
    assert.throws(() => assertTemplateSendable(pending), /dolphins_staff_welcome/);
    assert.doesNotThrow(() => assertTemplateSendable(pending, { allowPending: true }));
    assert.doesNotThrow(() => assertTemplateSendable(WHATSAPP_TEMPLATES.dolphinsStaffWelcome));
  });

  test('the staff body is the Meta-approved Utility wording (8 Oct 2026)', () => {
    const staff = WHATSAPP_TEMPLATES.dolphinsStaffWelcome.bodyText;
    assert.ok(
      staff.startsWith(
        'Dear {{1}}\n\nYour club is set up on the Dolphins live scoring system, powered by Medicoach. ' +
          'Please watch the video above to see how match-day scoring works for your club.\n\n' +
          '✅ Setup: scoring system setup instructions will be sent to you separately\n',
      ),
    );
    assert.ok(
      staff.endsWith(
        'Live-scored matches also feed the Dolphins scouting pipeline, where players from clubs, schools and universities are visible to teams looking for them.',
      ),
    );
    assert.doesNotMatch(staff, /login details/i);
  });
});
