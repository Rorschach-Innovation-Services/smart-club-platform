/**
 * EMCU scorer broadcast — club selection, credential intake, the per-(chair, club) audience and
 * claim keys, chairs-wins over the player audience, the 4-account WhatsApp gate, and — above
 * all — that no password ever reaches a sample, a manifest row or an error message.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildChairAudience,
  buildPlayerAudience,
  chairClaimKey,
  chairManifestRecipient,
  chairSampleText,
  credentialsByClub,
  matchesOnlyContact,
  parseArgs,
  parseCredentials,
  pendingTemplateFor,
  planChairMessages,
  planPlayerMessages,
  playerClaimKey,
  playerSampleText,
  redactSecrets,
  selectEmcuClubs,
  summarise,
  videoFileBlocker,
  welcomeChairFlags,
  type ChairRecipient,
  type CredentialEntry,
  type EmcuClub,
  type EmcuManifest,
  emcuClaimAction,
  isMarketingCapError,
  marketingCapStats,
  MARKETING_CAP_CODE,
} from '../src/send-emcu-scorer-broadcast.js';
import { WhatsAppError } from '../src/notify/whatsapp.js';
import { isRetryableSendError } from '../src/send-dolphins-welcome-broadcast.js';
import { emcuChairScorerEmailContent, emcuPlayerScoringEmailContent } from '../src/notify/email.js';
import { WHATSAPP_TEMPLATES } from '../src/notify/whatsapp-templates.js';
import type { AudiencePlayer } from '../src/send-dolphins-welcome-broadcast.js';

const PASSWORDS = [
  'manly-pushover-sustainer',
  'brisk-otter-lantern',
  'quiet-maple-harbor',
  'sly-copper-meadow',
];
const VIDEO = 'https://bucket.s3.af-south-1.amazonaws.com/tutorials/dolphins/staff.mp4';

const club = (id: string, extra: Partial<EmcuClub> = {}): EmcuClub => ({
  id,
  name: `${id} CC`,
  ...extra,
});
const withChair = (id: string, chair: Record<string, string>, extra: Partial<EmcuClub> = {}) =>
  club(id, { exco: { chair }, ...extra });
const creds = (clubId: string, code: string, n: number, state = 'created'): CredentialEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    clubId,
    code,
    email: `scorer${i + 1}.${code}@medicoach.co.za`,
    password: PASSWORDS[i % PASSWORDS.length]!,
    state,
  }));
const player = (first: string, extra: Partial<AudiencePlayer> = {}): AudiencePlayer => ({
  firstName: first,
  lastName: 'Zulu',
  status: 'active',
  ...extra,
});

const chairOf = (accounts = 4): ChairRecipient => ({
  clubId: 'umhlali',
  clubName: 'Umhlali Cricket Club',
  code: 'umhlali',
  name: 'Thandi Nkosi',
  email: 'chairperson@umhlalicc.co.za',
  cell: '27821234567',
  accounts: creds('umhlali', 'umhlali', accounts).map((e) => ({
    email: e.email,
    password: e.password,
  })),
});

describe('selectEmcuClubs', () => {
  test('team-map ids ∪ EMCU league keys, with the district cross-check', () => {
    const clubs = [
      club('a', { district: 'EMCU' }),
      club('b', { leagues: ['emcuD2'], district: 'Elsewhere' }),
      club('c', { leagues: ['premier'], district: 'EMCU' }),
      club('d', { leagues: ['premier'] }),
    ];
    const sel = selectEmcuClubs(clubs, ['a', 'missing'], ['emcuD2'], 'EMCU');
    assert.deepEqual(
      sel.clubs.map((c) => c.id),
      ['a', 'b'],
    );
    assert.deepEqual(sel.missingFromTenant, ['missing']);
    assert.deepEqual(sel.notInDistrict, ['b']);
    assert.deepEqual(sel.districtOnly, ['c']);
  });
});

describe('credentials', () => {
  test('parses an array or { entries }, reporting incomplete entries without the password', () => {
    const ok = parseCredentials(creds('x', 'xcc', 2));
    assert.equal(ok.entries.length, 2);
    assert.deepEqual(ok.problems, []);
    const wrapped = parseCredentials({ entries: creds('x', 'xcc', 1) });
    assert.equal(wrapped.entries.length, 1);
    const bad = parseCredentials([
      { clubId: 'x', email: 'scorer1.xcc@medicoach.co.za', password: PASSWORDS[0] },
    ]);
    assert.equal(bad.entries.length, 0);
    assert.match(bad.problems[0]!, /missing code, state/);
    assert.ok(!bad.problems.join(' ').includes(PASSWORDS[0]!));
    assert.equal(parseCredentials({ nope: 1 }).problems.length, 1);
  });

  test("only 'created' entries count, ordered by scorer number; code/email mismatches are per-club problems", () => {
    const entries = [
      ...creds('x', 'xcc', 3).reverse(),
      { ...creds('x', 'xcc', 4)[3]!, state: 'pending' },
      {
        clubId: 'y',
        code: 'ycc',
        email: 'scorer1.zzz@medicoach.co.za',
        password: 'p-q-r',
        state: 'created',
      },
    ];
    const byClub = credentialsByClub(entries, { x: 'xcc', y: 'ycc' });
    const x = byClub.get('x')!;
    assert.deepEqual(
      x.accounts.map((a) => a.email),
      ['scorer1.xcc@medicoach.co.za', 'scorer2.xcc@medicoach.co.za', 'scorer3.xcc@medicoach.co.za'],
    );
    assert.equal(x.notCreated, 1);
    assert.deepEqual(x.problems, []);
    assert.match(byClub.get('y')!.problems[0]!, /is not scorer<n>\.ycc@medicoach\.co\.za/);
    assert.ok(!byClub.get('y')!.problems.join(' ').includes('p-q-r'));
  });
});

describe('buildChairAudience', () => {
  const codes = { a: 'acc', b: 'bcc', c: 'ccc', d: 'dcc', e: 'ecc', f: 'fcc' };
  const clubs = [
    withChair('a', { name: 'Ann', email: 'Ann@Example.com', cell: '0821234567' }),
    withChair('b', { name: 'Ann', email: 'ann@example.com' }), // same chair, second club
    withChair('c', { name: 'Cee', cell: '0831234567' }), // no email
    withChair('d', { name: 'Dee', email: 'dee@example.com' }), // no credentials
    withChair('e', { name: 'Eve', email: 'eve@example.com' }), // excluded
    withChair('f', { name: 'Op', email: 'op@example.com' }), // operator
    withChair('g', { name: 'Gee', email: 'gee@example.com' }), // no code
  ];
  const entries = [
    ...creds('a', 'acc', 4),
    ...creds('b', 'bcc', 2),
    ...creds('c', 'ccc', 4),
    ...creds('e', 'ecc', 4),
    ...creds('f', 'fcc', 4),
  ];
  const { recipients, skips } = buildChairAudience({
    clubs,
    codes,
    credentials: credentialsByClub(entries, codes),
    excludeClubIds: new Set(['e']),
    operators: [{ email: 'OP@example.com' }],
  });

  test('one recipient per (chair, club); a chair of two clubs gets both', () => {
    assert.deepEqual(
      recipients.map((r) => [r.clubId, r.email, r.accounts.length]),
      [
        ['a', 'ann@example.com', 4],
        ['b', 'ann@example.com', 2],
      ],
    );
    assert.equal(recipients[0]!.cell, '27821234567');
  });

  test('clubs with no chair email / credentials / code, excluded, or an operator chair are reported skips', () => {
    assert.deepEqual(
      skips.map((s) => s.reason),
      ['no-chair-email', 'no-credentials', 'excluded', 'operator', 'no-code'],
    );
    assert.match(skips[0]!.detail, /cell \+27831234567 on file/);
  });

  test('claim keys are per (club, contact) and channel set', () => {
    const [a, b] = recipients;
    const ka = chairClaimKey(a!.clubId, a!.email, ['whatsapp', 'email']);
    const kb = chairClaimKey(b!.clubId, b!.email, ['email', 'whatsapp']);
    assert.equal(ka, 'emcu-scorers-a-ann@example.com#email+whatsapp');
    assert.notEqual(ka, kb);
    assert.equal(chairClaimKey('a', 'x@y.co', ['email']), 'emcu-scorers-a-x@y.co#email');
    assert.equal(
      chairClaimKey('a', 'x@y.co', ['email'], true),
      'emcu-scorers-a-x@y.co#email#resend',
    );
    assert.equal(playerClaimKey('x@y.co', ['whatsapp']), 'emcu-player-scoring-x@y.co#whatsapp');
  });
});

describe('planChairMessages', () => {
  test('email + WhatsApp notice for a 4-account club', () => {
    assert.deepEqual(
      planChairMessages(chairOf(4), ['email', 'whatsapp']).map((m) => [m.kind, m.status]),
      [
        ['emcu-chair-email', 'send'],
        ['emcu_scorer_accounts_notice', 'send'],
      ],
    );
  });

  test('a club with ≠ 4 accounts keeps its email but its WhatsApp leg is blocked', () => {
    const plan = planChairMessages(chairOf(3), ['email', 'whatsapp']);
    assert.equal(plan[0]!.status, 'send');
    assert.deepEqual([plan[1]!.status, plan[1]!.reason], ['skip', 'accounts≠4 (3)']);
    assert.equal(summarise([plan]).accountCountBlocked, 1);
  });

  test('no cell skips the WhatsApp leg', () => {
    const plan = planChairMessages({ ...chairOf(4), cell: '' }, ['whatsapp']);
    assert.deepEqual([plan[0]!.status, plan[0]!.reason], ['skip', 'no-cell']);
  });
});

describe('buildPlayerAudience', () => {
  test('EMCU players only, deduped; a chair who also plays gets the chair message only', () => {
    const clubs = [
      withChair('a', { name: 'Ann', email: 'ann@example.com', cell: '0821234567' }),
      withChair('b', { name: 'Bob', email: 'bob@example.com' }),
      club('x'),
    ];
    const playersByClub = new Map<string, AudiencePlayer[]>([
      [
        'a',
        [
          player('Ann', { email: 'ann@example.com' }),
          player('Sipho', { cell: '0721111111' }),
          player('Gone', { email: 'g@example.com', status: 'inactive' }),
        ],
      ],
      ['b', [player('Sipho', { cell: '0721111111' }), player('Lee', { cell: '0821234567' })]],
      ['x', [player('Excluded', { email: 'ex@example.com' })]],
    ]);
    const { recipients, skips } = buildPlayerAudience({
      clubs,
      playersByClub,
      excludeClubIds: new Set(['x']),
    });
    assert.deepEqual(
      recipients.map((r) => [r.name, r.cell, r.clubName]),
      [['Sipho', '27721111111', 'a CC']],
    );
    const reasons = skips.map((s) => s.reason).sort();
    assert.deepEqual(reasons, ['chair', 'chair', 'deduped', 'excluded', 'inactive']);
    // Portal users / exco never enter the player run.
    assert.ok(!recipients.some((r) => r.email === 'bob@example.com'));
  });

  test('player plan: email + emcu_player_scoring; no email ⇒ skip', () => {
    const plan = planPlayerMessages(
      {
        name: 'Sipho',
        email: '',
        cell: '27721111111',
        roles: [],
        clubIds: ['a'],
        clubName: 'A',
        minor: false,
      },
      ['email', 'whatsapp'],
    );
    assert.deepEqual(
      plan.map((m) => [m.kind, m.status]),
      [
        ['emcu-player-email', 'skip'],
        ['emcu_player_scoring', 'send'],
      ],
    );
  });

  test('--only matches by email or cell', () => {
    const r = { email: 'a@b.co', cell: '27721111111' };
    assert.ok(matchesOnlyContact(r, 'A@B.co'));
    assert.ok(matchesOnlyContact(r, '072 111 1111'));
    assert.ok(!matchesOnlyContact(r, 'z@b.co'));
  });
});

describe('credentials never leave memory', () => {
  const chair = chairOf(4);

  test('the dry-run sample redacts every password (and still shows the sign-in emails)', () => {
    const sample = chairSampleText(
      chair,
      emcuChairScorerEmailContent,
      VIDEO,
      'Meta upload of x.mp4',
    );
    for (const p of PASSWORDS) assert.ok(!sample.includes(p), `sample leaked ${p}`);
    assert.match(sample, /Password: •••/);
    assert.match(sample, /scorer1\.umhlali@medicoach\.co\.za/);
    assert.match(sample, /emailed to chairperson@umhlalicc\.co\.za/);
  });

  test('a serialised manifest carries the account COUNT, never a password or sign-in email', () => {
    const planned = planChairMessages(chair, ['email', 'whatsapp']);
    const manifest: Pick<EmcuManifest, 'recipients'> = {
      recipients: [
        {
          ...chairManifestRecipient(chair, planned),
          messages: [
            {
              kind: 'emcu-chair-email',
              channel: 'email',
              to: chair.email,
              status: 'failed',
              delivered: false,
              error: redactSecrets(`SES rejected body containing ${PASSWORDS[1]}`, PASSWORDS),
            },
          ],
        },
      ],
    };
    const json = JSON.stringify(manifest);
    for (const p of PASSWORDS) assert.ok(!json.includes(p), `manifest leaked ${p}`);
    assert.ok(!json.includes('scorer1.umhlali'));
    assert.equal(manifest.recipients[0]!.scorerAccounts, 4);
    assert.match(json, /SES rejected body containing •••/);
  });

  test('redactSecrets strips every occurrence, longest first', () => {
    assert.equal(redactSecrets('a-b-c and a-b-c-d', ['a-b-c', 'a-b-c-d']), '••• and •••');
    assert.equal(redactSecrets('nothing here', ['', 'x-y-z']), 'nothing here');
  });
});

describe('emails', () => {
  test('chair email: copy, Scorer 1..n table with passwords, app links, support line', () => {
    const e = emcuChairScorerEmailContent({
      name: 'Thandi Nkosi',
      clubName: 'Umhlali Cricket Club',
      accounts: chairOf(4).accounts,
      staffVideoUrl: VIDEO,
    });
    assert.equal(e.subject, "Your club's MediCoach scorer accounts");
    assert.ok(e.text.startsWith('Dear Thandi Nkosi,\n\n'));
    assert.match(
      e.text,
      /EMCU matches for Umhlali Cricket Club are scored live on the MediCoach app this season\. Your club has 4 scorer accounts, so up to 4 people can score 4 different matches at the same time\. Give each scorer their own account — don't use one account for two matches at once\./,
    );
    assert.ok(e.text.includes(`▶ Watch how live scoring works: ${VIDEO}`));
    assert.match(
      e.text,
      /Scorer 4\n {2}Sign-in email: scorer4\.umhlali@medicoach\.co\.za\n {2}Password: sly-copper-meadow/,
    );
    assert.ok(e.text.includes('https://apps.apple.com/us/app/medicoach-ams/id6760149086'));
    assert.ok(e.text.includes('https://play.google.com/store/apps/details?id=co.za.medicoach.app'));
    assert.ok(e.text.includes('https://www.medicoach.co.za/'));
    assert.ok(
      e.text.endsWith(
        "Please keep these details within your club's scorers. If you are no longer the chairperson, or an account needs a reset, email info@medicoach.co.za.",
      ),
    );
    assert.match(e.html, /<th[^>]*>Sign-in email<\/th><th[^>]*>Password<\/th>/);
    assert.ok(e.html.includes('manly-pushover-sustainer'));
  });

  test('chair email uses the real count and escapes HTML', () => {
    const e = emcuChairScorerEmailContent({
      name: '',
      clubName: 'A & B <CC>',
      accounts: chairOf(3).accounts,
      staffVideoUrl: VIDEO,
    });
    assert.ok(e.text.startsWith('Dear Chairperson,'));
    assert.match(e.text, /Your club has 3 scorer accounts, so up to 3 people/);
    assert.ok(e.html.includes('A &amp; B &lt;CC&gt;'));
  });

  test('player email: the 10 Oct copy with the how-to video link and app links before the sign-off', () => {
    const e = emcuPlayerScoringEmailContent({ firstName: 'Sipho', staffVideoUrl: VIDEO });
    assert.equal(e.subject, 'Your matches are being scouted live on MediCoach 🏏');
    assert.equal(
      e.text,
      'Dear Sipho 🏏\n\n' +
        "We're proud to be professionalising the KZN cricket ecosystem — and you're part of it.\n\n" +
        'Your matches are now being scored live on the MediCoach app, which means your performances are actively being scouted into the provincial pipeline. Every run, wicket and catch counts. 📊\n\n' +
        '✅ To get started, watch the how-to video, request your scorer login details from your club chairperson, and score your games on the app.\n' +
        `▶ Watch the how-to video: ${VIDEO}\n\n` +
        'So bring your best today — the system is watching, and this is your chance to put your name forward.\n\n' +
        'Get the app:\n' +
        '  iPhone (App Store): https://apps.apple.com/us/app/medicoach-ams/id6760149086\n' +
        '  Android (Google Play): https://play.google.com/store/apps/details?id=co.za.medicoach.app\n' +
        '  Website: https://www.medicoach.co.za/\n\n' +
        'Best of luck out there. 💚🏆\n\n' +
        'Dolphins × MediCoach\n\n' +
        'Questions? Email info@medicoach.co.za',
    );
    assert.doesNotMatch(e.text, /video above|password/i);
    assert.ok(e.html.includes(`href="${VIDEO}"`));
    assert.ok(e.html.indexOf('Get the app') < e.html.indexOf('Best of luck'));
    assert.equal(
      emcuPlayerScoringEmailContent({ firstName: ' ', staffVideoUrl: VIDEO }).text.split('\n')[0],
      'Dear player 🏏',
    );
  });

  test('player sample fills the one param', () => {
    const s = playerSampleText(
      {
        name: 'Sipho',
        email: 's@x.co',
        cell: '',
        roles: [],
        clubIds: ['a'],
        clubName: 'Umhlali Cricket Club',
        minor: false,
      },
      emcuPlayerScoringEmailContent,
      VIDEO,
      'Meta upload',
    );
    assert.match(s, /Dear Sipho 🏏\n\nWe're proud to be professionalising/);
    assert.doesNotMatch(s, /\{\{\d\}\}/);
  });
});

describe('welcomeChairFlags', () => {
  test('flags chairs whose welcome failed, was skipped, or is missing', () => {
    const chairs: ChairRecipient[] = [
      { ...chairOf(4), clubId: 'ok', email: 'ok@x.co', cell: '' },
      { ...chairOf(4), clubId: 'fail', email: 'fail@x.co', cell: '' },
      { ...chairOf(4), clubId: 'partial', email: 'p@x.co', cell: '' },
      { ...chairOf(4), clubId: 'none', email: 'none@x.co', cell: '' },
      { ...chairOf(4), clubId: 'replay', email: 'r@x.co', cell: '' },
    ];
    const flags = welcomeChairFlags(
      {
        recipients: [
          {
            email: 'ok@x.co',
            outcome: 'sent',
            messages: [{ kind: 'staff-email', status: 'sent' }],
          },
          { email: 'fail@x.co', outcome: 'all-failed' },
          {
            email: 'P@x.co',
            outcome: 'sent',
            messages: [
              { kind: 'staff-email', status: 'sent' },
              { kind: 'dolphins_staff_welcome', status: 'skipped' },
            ],
          },
          { email: 'r@x.co', outcome: 'replay' },
        ],
      },
      chairs,
    );
    assert.deepEqual(
      flags.map((f) => [f.clubId, f.detail]),
      [
        ['fail', 'welcome outcome all-failed'],
        ['partial', 'welcome dolphins_staff_welcome skipped'],
        ['none', 'not in the welcome manifest'],
      ],
    );
  });
});

describe('CLI args + blockers', () => {
  test('--audience is required; chairs need --credentials; players refuse it', () => {
    assert.throws(() => parseArgs([]), /--audience/);
    assert.throws(() => parseArgs(['--audience', 'chairs']), /--credentials/);
    assert.throws(
      () => parseArgs(['--audience', 'players', '--credentials', 'x.json']),
      /chairs only/,
    );
    assert.throws(() => parseArgs(['--audience', 'everyone']), /chairs or players/);
  });

  test('parses repeatable --exclude-club and the channel set', () => {
    const a = parseArgs([
      '--audience',
      'chairs',
      '--credentials',
      '/secure/c.json',
      '--exclude-club',
      'umlazi-cc-mut',
      '--exclude-club',
      'dolphins-deaf-cricket-team',
      '--channels',
      'email',
      '--staff-video-url',
      VIDEO,
    ]);
    assert.deepEqual(a.excludeClubs, ['umlazi-cc-mut', 'dolphins-deaf-cricket-team']);
    assert.deepEqual(a.channels, ['email']);
    assert.match(a.codes, /emcu-club-codes\.json$/);
    assert.throws(
      () => parseArgs(['--audience', 'players', '--staff-video-url', 'http://x']),
      /https/,
    );
  });

  test('both templates are approved (10 Oct 2026); a pending one would block --confirm', () => {
    assert.equal(pendingTemplateFor('chairs'), null);
    assert.equal(pendingTemplateFor('players'), null);
    const pending = {
      ...WHATSAPP_TEMPLATES,
      emcuPlayerScoring: { ...WHATSAPP_TEMPLATES.emcuPlayerScoring, status: 'pending' as const },
    };
    assert.equal(pendingTemplateFor('players', pending), 'emcu_player_scoring');
  });

  test('--video-file: required with whatsapp, must exist, ≤ 16 MB', () => {
    assert.equal(
      videoFileBlocker(['email'], undefined, () => null),
      null,
    );
    assert.match(videoFileBlocker(['whatsapp'], undefined, () => null)!, /required/);
    assert.match(videoFileBlocker(['whatsapp'], 'v.mp4', () => null)!, /not found/);
    assert.match(videoFileBlocker(['whatsapp'], 'v.mp4', () => 17 * 1024 * 1024)!, /16 MB/);
    assert.equal(
      videoFileBlocker(['whatsapp'], 'v.mp4', () => 1024),
      null,
    );
  });
});

describe('Meta marketing cap (131049 — both templates are Marketing)', () => {
  const capErr = new WhatsAppError('WhatsApp send failed (131049): healthy ecosystem', {
    code: MARKETING_CAP_CODE,
  });

  test('131049 is recognised, and is NOT retryable (shared welcome semantics unchanged)', () => {
    assert.ok(isMarketingCapError(capErr));
    assert.ok(!isRetryableSendError(capErr));
    assert.ok(!isMarketingCapError(new WhatsAppError('x', { code: 131026 })));
    assert.ok(!isMarketingCapError(new Error('131049')));
  });

  test('a capped WhatsApp completes the claim — with or without the email — never releases it', () => {
    const capped = { status: 'skipped' as const, marketingCap: true as const };
    assert.equal(emcuClaimAction([{ status: 'sent' }, capped]), 'complete');
    assert.equal(emcuClaimAction([capped]), 'complete');
    assert.equal(emcuClaimAction([{ status: 'failed', retryable: false }]), 'release-none-sent');
    assert.equal(
      emcuClaimAction([capped, { status: 'failed', retryable: true }]),
      'release-retryable',
    );
  });

  test('marketingCapStats counts capped recipients and those who got the email only', () => {
    const wa = {
      kind: 'emcu_player_scoring' as const,
      channel: 'whatsapp' as const,
      delivered: false,
    };
    const stats = marketingCapStats([
      {
        messages: [
          { kind: 'emcu-player-email', channel: 'email', status: 'sent', delivered: true },
          { ...wa, status: 'skipped', marketingCap: true },
        ],
      },
      { messages: [{ ...wa, status: 'skipped', marketingCap: true }] },
      { messages: [{ ...wa, status: 'sent', delivered: true }] },
      {},
    ]);
    assert.deepEqual(stats, { capped: 2, emailOnly: 1 });
  });
});

test('load order: importing the CLI does not load the notify senders', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = (f: string) => JSON.stringify(join(here, '..', 'src', f));
  const code = `
    await import(${src('send-emcu-scorer-broadcast.ts')});
    process.env.FROM_EMAIL = 'info@example.com';
    process.env.WHATSAPP_ACCESS_TOKEN = 'tok';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
    const { EMAIL_DRY_RUN } = await import(${src('notify/email.ts')});
    const { WHATSAPP_DRY_RUN } = await import(${src('notify/whatsapp.ts')});
    console.log(JSON.stringify({ EMAIL_DRY_RUN, WHATSAPP_DRY_RUN }));
  `;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    'FROM_EMAIL',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'NOTIFY_DRY_RUN',
  ])
    delete env[k];
  const res = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    env,
    encoding: 'utf8',
    cwd: join(here, '..'),
  });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout.trim().split('\n').pop()!);
  assert.deepEqual(out, { EMAIL_DRY_RUN: false, WHATSAPP_DRY_RUN: false });
});
