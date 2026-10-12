/**
 * Video-header experiment CLI — arg parsing, template resolution, send planning and the
 * --confirm refusal gate (all pure).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExperimentArgs,
  planExperimentSends,
  resolveTemplateKey,
  experimentRefusals,
} from '../src/send-video-header-experiment.js';
import { WHATSAPP_TEMPLATES } from '../src/notify/whatsapp-templates.js';

// Synthetic numbers only — never commit real test phones.
const BASE = [
  '--template',
  'dolphins_player_welcome',
  '--to',
  '082 000 0001, +27820000002,0820000001',
  '--video-file',
  '/tmp/v.mp4',
  '--video-url',
  'https://bucket.example.com/v.mp4',
];

describe('parseExperimentArgs', () => {
  test('defaults: both variants, name "Test", dry-run, gate on; numbers normalised + deduped', () => {
    const a = parseExperimentArgs(BASE);
    assert.equal(a.template, 'dolphinsPlayerWelcome');
    assert.deepEqual(a.to, ['27820000001', '27820000002']);
    assert.deepEqual(a.variants, ['meta', 'link']);
    assert.equal(a.name, 'Test');
    assert.equal(a.confirm, false);
    assert.equal(a.allowPending, false);
  });

  test('accepts a registry key or the Meta template name', () => {
    assert.equal(resolveTemplateKey('dolphinsPlayerFyi'), 'dolphinsPlayerFyi');
    assert.equal(resolveTemplateKey('dolphins_staff_welcome'), 'dolphinsStaffWelcome');
    assert.throws(() => resolveTemplateKey('staff_portal_invite'), /not one of/);
  });

  test('a single variant only needs its own video source', () => {
    const link = parseExperimentArgs([
      '--template',
      'dolphinsPlayerFyi',
      '--to',
      '0820000001',
      '--variant',
      'link',
      '--video-url',
      'https://x.example.com/v.mp4',
    ]);
    assert.deepEqual(link.variants, ['link']);
    assert.equal(link.videoFile, undefined);
    const meta = parseExperimentArgs([
      '--template',
      'dolphinsPlayerFyi',
      '--to',
      '0820000001',
      '--variant',
      'meta',
      '--video-file',
      '/tmp/v.mp4',
      '--confirm',
      '--allow-pending',
      '--name',
      ' Sipho ',
    ]);
    assert.deepEqual(meta.variants, ['meta']);
    assert.equal(meta.confirm, true);
    assert.equal(meta.allowPending, true);
    assert.equal(meta.name, 'Sipho');
  });

  test('rejects missing or invalid inputs', () => {
    assert.throws(() => parseExperimentArgs(BASE.slice(2)), /--template is required/);
    assert.throws(
      () => parseExperimentArgs(['--template', 'dolphinsPlayerFyi', '--to', '12']),
      /not a usable cell/,
    );
    assert.throws(
      () => parseExperimentArgs(['--template', 'dolphinsPlayerFyi']),
      /--to needs at least one/,
    );
    assert.throws(() => parseExperimentArgs([...BASE, '--variant', 'cdn']), /--variant must be/);
    assert.throws(
      () => parseExperimentArgs(['--template', 'dolphinsPlayerFyi', '--to', '0820000001']),
      /meta variant needs --video-file/,
    );
    assert.throws(
      () =>
        parseExperimentArgs([
          '--template',
          'dolphinsPlayerFyi',
          '--to',
          '0820000001',
          '--variant',
          'link',
          '--video-url',
          'http://insecure.example.com/v.mp4',
        ]),
      /https URL/,
    );
    assert.throws(() => parseExperimentArgs([...BASE, '--bogus']), /unknown flag --bogus/);
  });
});

describe('planExperimentSends', () => {
  test('every number × variant, meta-hosted before s3-link per number', () => {
    assert.deepEqual(
      planExperimentSends({ to: ['27820000001', '27820000002'], variants: ['meta', 'link'] }),
      [
        { to: '27820000001', variant: 'meta', label: 'meta-hosted' },
        { to: '27820000001', variant: 'link', label: 's3-link' },
        { to: '27820000002', variant: 'meta', label: 'meta-hosted' },
        { to: '27820000002', variant: 'link', label: 's3-link' },
      ],
    );
  });
});

describe('experimentRefusals', () => {
  const pending = { ...WHATSAPP_TEMPLATES.dolphinsPlayerWelcome, status: 'pending' as const };
  const registered = { ...pending, status: 'registered' as const };

  test('a pending template is refused unless --allow-pending', () => {
    assert.match(
      experimentRefusals(pending, { allowPending: false }, false, {})[0]!,
      /--allow-pending/,
    );
    assert.deepEqual(experimentRefusals(pending, { allowPending: true }, false, {}), []);
    assert.deepEqual(experimentRefusals(registered, { allowPending: false }, false, {}), []);
  });

  test('a dry-run WhatsApp channel is refused, naming what is missing', () => {
    const [r] = experimentRefusals(registered, { allowPending: false }, true, {});
    assert.match(r!, /WHATSAPP_ACCESS_TOKEN \+ WHATSAPP_PHONE_NUMBER_ID unset/);
  });
});
