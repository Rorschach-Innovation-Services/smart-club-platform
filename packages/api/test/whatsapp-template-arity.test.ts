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

const { staffInviteParams, regLinkParams, fixturesParams, clearanceParams } =
  await import('../src/notify/whatsapp.js');
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
