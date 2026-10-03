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
  clearanceParams,
  captainsReportDueParams,
  captainsReportOpenParams,
  urlButtonComponent,
} = await import('../src/notify/whatsapp.js');
const { WHATSAPP_TEMPLATES, captainsReportTemplateKey } =
  await import('../src/notify/whatsapp-templates.js');

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
      clubName: 'Umzinto CC',
      match: 'Umzinto v African Warriors, Sun 4 Oct 2026',
    }),
  },
  {
    key: 'captainsReportOpen' as const,
    params: captainsReportOpenParams({
      recipientName: 'Sanele Mthembu',
      orgName: 'KZN Dolphins',
      match: 'Umzinto v African Warriors on Sun 4 Oct 2026',
    }),
  },
  {
    key: 'clearancePending' as const,
    params: clearanceParams({
      chairName: 'Thandi Nkosi',
      fromClubName: 'Adelaar CC',
      playerName: 'A Player',
      toClubName: 'Centurion Kavaliers',
    }),
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
      clubName: 'B',
      match: 'C',
    });
    for (const p of params) assert.doesNotMatch(p.text, /https?:\/\//);
  });
});

describe("captain's report template v2 (captains_report_open)", () => {
  const v2 = WHATSAPP_TEMPLATES.captainsReportOpen;

  test('three body params: recipient name, union name, match line + date', () => {
    assert.equal(v2.name, 'captains_report_open');
    assert.equal(v2.paramCount, 3);
    assert.deepEqual(v2.params, ['recipient name', 'org name', 'match line + date']);
    assert.equal(
      v2.bodyText,
      'Hello {{1}},\n\n' +
        "The {{2}} captain's report for {{3}} is open. Please rate the umpires.\n\n" +
        'Tap the button below to open it. You can submit it once; the link expires on the date shown in the report.',
    );
    assert.deepEqual(
      captainsReportOpenParams({
        recipientName: 'Sanele',
        orgName: 'KZN Dolphins',
        match: 'Umzinto v AW on Sun 20 Sep 2026',
      }).map((p) => p.text),
      ['Sanele', 'KZN Dolphins', 'Umzinto v AW on Sun 20 Sep 2026'],
    );
  });

  test('the copy says "submit it once" and never "works once" or a possessive club name', () => {
    assert.match(v2.bodyText, /You can submit it once; the link expires on the date shown/);
    assert.doesNotMatch(v2.bodyText, /works once/);
    assert.doesNotMatch(v2.bodyText, /'s captain's report/);
  });

  test('same URL button as v1', () => {
    assert.deepEqual(v2.urlButton, WHATSAPP_TEMPLATES.captainsReportDue.urlButton);
  });

  test('the sender uses v2 only once it is registered, else falls back to v1', () => {
    const base = {
      captainsReportOpen: { ...v2, status: 'pending' as const },
      captainsReportDue: WHATSAPP_TEMPLATES.captainsReportDue,
    };
    assert.equal(captainsReportTemplateKey(base), 'captainsReportDue');
    assert.equal(
      captainsReportTemplateKey({
        ...base,
        captainsReportOpen: { ...v2, status: 'registered' as const },
      }),
      'captainsReportOpen',
    );
    assert.equal(
      captainsReportTemplateKey({
        captainsReportOpen: { ...v2, status: 'pending' as const },
        captainsReportDue: { ...WHATSAPP_TEMPLATES.captainsReportDue, status: 'pending' as const },
      }),
      null,
    );
    // Today: v2 is pending, so the live sender still uses v1.
    assert.equal(captainsReportTemplateKey(), 'captainsReportDue');
  });

  test('the report link never rides in the v2 body params', () => {
    for (const p of captainsReportOpenParams({ recipientName: 'A', orgName: 'O', match: 'B' }))
      assert.doesNotMatch(p.text, /https?:\/\//);
  });
});
