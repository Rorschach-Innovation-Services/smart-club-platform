/**
 * Dolphins welcome broadcast — the pure audience assembly (who gets which message, once), the
 * per-recipient message plan, the --confirm dry-run guard, and the rendered email copy.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAudience,
  matchesOnly,
  planMessages,
  dryRunSendRefusals,
  idempotencyKeyFor,
  resendIdempotencyKeyFor,
  videoFileBlockers,
  WHATSAPP_VIDEO_MAX_BYTES,
  pendingBroadcastTemplates,
  type AudienceClub,
  type AudienceInput,
  type AudiencePlayer,
} from '../src/send-dolphins-welcome-broadcast.js';
import { staffWelcomeEmailContent, playerWelcomeEmailContent } from '../src/notify/email.js';

const club = (id: string, extra: Partial<AudienceClub> = {}): AudienceClub => ({
  id,
  name: `${id} CC`,
  ...extra,
});
const player = (first: string, extra: Partial<AudiencePlayer> = {}): AudiencePlayer => ({
  firstName: first,
  lastName: 'Zulu',
  status: 'active',
  ...extra,
});
const input = (over: Partial<AudienceInput> = {}): AudienceInput => ({
  clubs: [],
  playersByClub: new Map(),
  tenantUsers: [],
  ...over,
});

describe('buildAudience', () => {
  test('exco, coaches and players become staff and player recipients with their own names', () => {
    const { recipients } = buildAudience(
      input({
        clubs: [
          club('umh', {
            exco: {
              chair: { name: 'Thandi Nkosi', email: 'Thandi@Example.com', cell: '082 111 2222' },
              sec: { name: 'Ravi Pillay', email: 'ravi@example.com' },
            },
            coaches: [{ name: 'Coach Bongani', cell: '0831234567' }],
          }),
        ],
        playersByClub: new Map([['umh', [player('Sipho', { email: 'sipho@example.com' })]]]),
      }),
    );
    assert.deepEqual(
      recipients.map((r) => [r.cohort, r.name, r.email, r.cell]),
      [
        ['staff', 'Thandi Nkosi', 'thandi@example.com', '27821112222'],
        ['staff', 'Ravi Pillay', 'ravi@example.com', ''],
        ['staff', 'Coach Bongani', '', '27831234567'],
        ['player', 'Sipho', 'sipho@example.com', ''],
      ],
    );
    assert.deepEqual(recipients[0]!.roles, ['Chairperson @ umh CC']);
  });

  test('a person who is both staff and player gets staff treatment only, reported as deduped', () => {
    const { recipients, skips } = buildAudience(
      input({
        clubs: [club('a', { coaches: [{ name: 'Lungi Ngidi', email: 'lungi@example.com' }] })],
        playersByClub: new Map([['a', [player('Lungi', { email: 'LUNGI@example.com ' })]]]),
      }),
    );
    assert.equal(recipients.length, 1);
    assert.equal(recipients[0]!.cohort, 'staff');
    assert.deepEqual(recipients[0]!.roles, ['Coach @ a CC', 'Player @ a CC']);
    assert.equal(skips.length, 1);
    assert.equal(skips[0]!.reason, 'deduped');
    assert.match(skips[0]!.detail, /staff message only/);
  });

  test('a chair of several clubs is one recipient, linked by email and cell transitively', () => {
    const { recipients } = buildAudience(
      input({
        clubs: [
          club('a', { exco: { chair: { name: 'Thandi', email: 't@example.com' } } }),
          club('b', { exco: { chair: { name: 'Thandi', cell: '0821112222' } } }),
          club('c', {
            exco: { chair: { name: 'Thandi', email: 't@example.com', cell: '+27 82 111 2222' } },
          }),
        ],
      }),
    );
    assert.deepEqual(
      recipients.map((r) => [r.email, r.cell, r.clubIds]),
      [['t@example.com', '27821112222', ['a', 'b', 'c']]],
    );
  });

  test('siblings registered on one guardian contact get one player message', () => {
    const { recipients, skips } = buildAudience(
      input({
        clubs: [club('a')],
        playersByClub: new Map([
          [
            'a',
            [
              player('Ayanda', { isMinor: true, cell: '0821112222' }),
              player('Zola', { isMinor: true, cell: '082-111-2222' }),
            ],
          ],
        ]),
      }),
    );
    assert.equal(recipients.length, 1);
    assert.equal(recipients[0]!.name, 'Ayanda');
    assert.equal(recipients[0]!.minor, true);
    assert.deepEqual(
      skips.map((s) => s.reason),
      ['deduped'],
    );
    assert.match(skips[0]!.detail, /one player message/);
  });

  test('inactive and placeholder rows are skipped; clearance-pending players are included', () => {
    const { recipients, skips } = buildAudience(
      input({
        clubs: [club('a')],
        playersByClub: new Map([
          [
            'a',
            [
              player('Old', { status: 'inactive', email: 'old@example.com' }),
              player('Stub', { placeholder: true, email: 'stub@example.com' }),
              player('Moving', { status: 'clearance-pending', email: 'moving@example.com' }),
            ],
          ],
        ]),
      }),
    );
    assert.deepEqual(
      recipients.map((r) => r.name),
      ['Moving'],
    );
    assert.deepEqual(skips.map((s) => s.reason).sort(), ['inactive', 'placeholder']);
  });

  test('a player with no usable email or cell is reported no-contact; blank exco slots are silent', () => {
    const { recipients, skips } = buildAudience(
      input({
        clubs: [club('a', { exco: { tre: {} } })],
        playersByClub: new Map([['a', [player('Ghost', { email: 'not-an-email', cell: '12' })]]]),
      }),
    );
    assert.equal(recipients.length, 0);
    assert.deepEqual(
      skips.map((s) => s.reason),
      ['no-contact'],
    );
  });

  test('portal users take their name from exco or a player row, else the generic greeting', () => {
    const { recipients } = buildAudience(
      input({
        clubs: [club('a', { exco: { chair: { name: 'Thandi', email: 'thandi@example.com' } } })],
        tenantUsers: [
          { email: 'Thandi@example.com', role: 'rep' },
          { email: 'admin@example.com', role: 'admin' },
          { email: 'rep2@example.com', role: 'rep' },
        ],
        playersByClub: new Map([
          ['a', [player('Rep', { lastName: 'Two', email: 'rep2@example.com' })]],
        ]),
      }),
    );
    const byEmail = new Map(recipients.map((r) => [r.email, r]));
    assert.equal(recipients.length, 3);
    assert.equal(byEmail.get('thandi@example.com')!.name, 'Thandi');
    assert.deepEqual(byEmail.get('thandi@example.com')!.roles, [
      'Chairperson @ a CC',
      'Portal rep',
    ]);
    assert.equal(byEmail.get('rep2@example.com')!.cohort, 'staff');
    assert.equal(byEmail.get('rep2@example.com')!.name, 'Rep Two');
    assert.equal(byEmail.get('admin@example.com')!.genericGreeting, true);
  });

  test('a flat club.chair name is used when exco has no chair name', () => {
    const { recipients } = buildAudience(
      input({
        clubs: [club('a', { chair: 'Flat Chair', exco: { chair: { email: 'c@example.com' } } })],
      }),
    );
    assert.equal(recipients[0]!.name, 'Flat Chair');
  });
});

describe('platform operators', () => {
  const OPS = [{ sub: 'op-1', email: 'Carlton@rorschach.example' }];
  const opInput = (includeOperators?: boolean) =>
    input({
      clubs: [
        club('a', {
          exco: { chair: { name: 'Thandi', email: 'thandi@example.com' } },
          coaches: [{ name: 'Op As Coach', email: 'carlton@rorschach.example' }],
        }),
      ],
      tenantUsers: [
        { sub: 'op-1', email: 'carlton@rorschach.example', role: 'admin' },
        { sub: 'op-2-renamed', email: 'thandi@example.com', role: 'rep' },
      ],
      operators: OPS,
      ...(includeOperators === undefined ? {} : { includeOperators }),
    });

  test('are excluded by default and reported, wherever their email appears', () => {
    const { recipients, skips } = buildAudience(opInput());
    assert.deepEqual(
      recipients.map((r) => r.email),
      ['thandi@example.com'],
    );
    const ops = skips.filter((s) => s.reason === 'operator');
    assert.equal(ops.length, 2);
    assert.ok(ops.some((s) => /Portal admin/.test(s.detail)));
    assert.ok(ops.some((s) => /Coach @ a CC/.test(s.detail)));
  });

  test('a portal row is matched by operator sub even if its email differs', () => {
    const { recipients, skips } = buildAudience(
      input({
        tenantUsers: [{ sub: 'op-1', email: 'other@example.com', role: 'admin' }],
        operators: OPS,
      }),
    );
    assert.equal(recipients.length, 0);
    assert.deepEqual(
      skips.map((s) => s.reason),
      ['operator'],
    );
  });

  test('--include-operators keeps them in the audience as staff', () => {
    const { recipients, skips } = buildAudience(opInput(true));
    const op = recipients.find((r) => r.email === 'carlton@rorschach.example');
    assert.ok(op);
    assert.equal(op.cohort, 'staff');
    assert.equal(op.name, 'Op As Coach');
    assert.ok(!skips.some((s) => s.reason === 'operator'));
  });
});

describe('matchesOnly', () => {
  const [r] = buildAudience(
    input({
      clubs: [
        club('a', { exco: { chair: { name: 'T', email: 't@example.com', cell: '0821112222' } } }),
      ],
    }),
  ).recipients;
  test('matches by normalised email or by any spelling of the cell', () => {
    assert.ok(matchesOnly(r!, ' T@Example.com'));
    assert.ok(matchesOnly(r!, '+27 82 111 2222'));
    assert.ok(matchesOnly(r!, '082 111 2222'));
    assert.ok(!matchesOnly(r!, 'other@example.com'));
    assert.ok(!matchesOnly(r!, '0829999999'));
  });
});

describe('planMessages', () => {
  const { recipients } = buildAudience(
    input({
      clubs: [
        club('a', { exco: { chair: { name: 'T', email: 't@example.com', cell: '0821112222' } } }),
      ],
      playersByClub: new Map([
        ['a', [player('P', { email: 'p@example.com' }), player('L', { cell: '0312345678' })]],
      ]),
    }),
  );
  const [staff, emailOnlyPlayer, landlinePlayer] = recipients;

  test('staff: one combined email, then the staff welcome and the player FYI on WhatsApp', () => {
    assert.deepEqual(
      planMessages(staff!, ['email', 'whatsapp']).map((m) => [m.kind, m.status, m.to]),
      [
        ['staff-email', 'send', 't@example.com'],
        ['dolphins_staff_welcome', 'send', '27821112222'],
        ['dolphins_player_fyi', 'send', '27821112222'],
      ],
    );
  });

  test('player: one email and one WhatsApp; a missing channel is skipped with a reason', () => {
    assert.deepEqual(
      planMessages(emailOnlyPlayer!, ['email', 'whatsapp']).map((m) => [
        m.kind,
        m.status,
        m.reason,
      ]),
      [
        ['player-email', 'send', undefined],
        ['dolphins_player_welcome', 'skip', 'no-cell'],
      ],
    );
    assert.deepEqual(
      planMessages(landlinePlayer!, ['email', 'whatsapp']).map((m) => [m.kind, m.status, m.reason]),
      [
        ['player-email', 'skip', 'no-email'],
        ['dolphins_player_welcome', 'skip', 'landline?'],
      ],
    );
  });

  test('--channels email plans no WhatsApp', () => {
    assert.deepEqual(
      planMessages(staff!, ['email']).map((m) => m.kind),
      ['staff-email'],
    );
  });

  test('ledger keys are per person, with a distinct resend key', () => {
    assert.equal(idempotencyKeyFor('t@example.com'), 'welcome-broadcast-t@example.com');
    assert.equal(resendIdempotencyKeyFor('27821112222'), 'welcome-broadcast-27821112222#resend');
  });

  test('--confirm refuses a dry-run channel only when something would actually send', () => {
    const plans = [planMessages(staff!, ['email', 'whatsapp'])];
    const refusals = dryRunSendRefusals(
      plans,
      ['email', 'whatsapp'],
      { email: false, whatsapp: true },
      {},
    );
    assert.equal(refusals.length, 1);
    assert.match(
      refusals[0]!,
      /whatsapp channel is in notify dry-run \(WHATSAPP_ACCESS_TOKEN \+ WHATSAPP_PHONE_NUMBER_ID unset\)/,
    );
    const nothing = [planMessages(landlinePlayer!, ['whatsapp'])];
    assert.deepEqual(
      dryRunSendRefusals(nothing, ['whatsapp'], { email: true, whatsapp: true }, {}),
      [],
    );
  });
});

describe('videoFileBlockers (WhatsApp videos are uploaded to Meta)', () => {
  const MB = 1024 * 1024;
  const sizes: Record<string, number> = {
    '/v/staff.mp4': 15.9 * MB,
    '/v/player.mp4': 4 * MB,
    '/v/big.mp4': 17 * MB,
    '/v/exact.mp4': WHATSAPP_VIDEO_MAX_BYTES,
  };
  const sizeOf = (p: string) => sizes[p] ?? null;

  test('both files present and within 16 MB ⇒ no blockers', () => {
    assert.deepEqual(
      videoFileBlockers(
        ['email', 'whatsapp'],
        { staffVideoFile: '/v/staff.mp4', playerVideoFile: '/v/exact.mp4' },
        sizeOf,
      ),
      [],
    );
  });

  test('with the whatsapp channel, both file flags are required', () => {
    const b = videoFileBlockers(['email', 'whatsapp'], {}, sizeOf);
    assert.equal(b.length, 2);
    assert.match(b[0]!, /--staff-video-file is required with the whatsapp channel/);
    assert.match(b[1]!, /--player-video-file is required with the whatsapp channel/);
  });

  test('email-only runs need no video files', () => {
    assert.deepEqual(videoFileBlockers(['email'], {}, sizeOf), []);
  });

  test('a missing file or one over 16 MB is refused with a clear reason', () => {
    const b = videoFileBlockers(
      ['whatsapp'],
      { staffVideoFile: '/v/big.mp4', playerVideoFile: '/v/nope.mp4' },
      sizeOf,
    );
    assert.deepEqual(b, [
      "--staff-video-file /v/big.mp4: 17.0 MB exceeds Meta's 16 MB video cap — re-encode it",
      '--player-video-file /v/nope.mp4: file not found',
    ]);
  });
});

describe('pendingBroadcastTemplates (the --confirm WhatsApp blocker)', () => {
  test('all three broadcast templates are registered — nothing blocks', () => {
    assert.deepEqual(pendingBroadcastTemplates(), []);
  });

  test('a template not yet registered is named as a blocker', async () => {
    const { WHATSAPP_TEMPLATES } = await import('../src/notify/whatsapp-templates.js');
    const fake = {
      ...WHATSAPP_TEMPLATES,
      dolphinsPlayerFyi: { ...WHATSAPP_TEMPLATES.dolphinsPlayerFyi, status: 'pending' as const },
    };
    assert.deepEqual(pendingBroadcastTemplates(fake), ['dolphins_player_fyi']);
  });
});

describe('welcome emails', () => {
  const STAFF_URL = 'https://cdn.example.com/staff.mp4';
  const PLAYER_URL = 'https://cdn.example.com/player.mp4';

  test('staff email: personal greeting, staff video, then the player message as FYI', () => {
    const e = staffWelcomeEmailContent({
      name: 'Thandi <Nkosi>',
      staffVideoUrl: STAFF_URL,
      playerVideoUrl: PLAYER_URL,
    });
    assert.equal(e.subject, 'Welcome to the Dolphins Pipeline 🏏');
    assert.ok(e.text.startsWith('Dear Thandi <Nkosi>\n\n'));
    assert.match(
      e.text,
      /^Dear Thandi <Nkosi>\n\nYour club is set up on the Dolphins live scoring system, powered by Medicoach\. Please watch the video linked below to see how match-day scoring works for your club\.\n\n▶ Watch: https:\/\/cdn\.example\.com\/staff\.mp4\n/,
    );
    assert.match(
      e.text,
      /Live-scored matches also feed the Dolphins scouting pipeline, where players from clubs, schools and universities are visible to teams looking for them\.\n\n—————/,
    );
    assert.match(e.text, /▶ Watch: https:\/\/cdn\.example\.com\/staff\.mp4/);
    assert.match(
      e.text,
      /✅ Setup: scoring system setup instructions will be sent to you separately/,
    );
    assert.match(
      e.text,
      /For your information, below is the message every registered player has received:\n\nPlayers are registered on the Dolphins scouting pipeline, part of the Medicoach Athlete Management System\. The video linked below shows how it works for them this season\.\n/,
    );
    assert.match(
      e.text,
      /for them this season\.\n▶ Watch: https:\/\/cdn\.example\.com\/player\.mp4\n\n📊 Every ball of their matches is scored live and builds their player profile/,
    );
    assert.doesNotMatch(e.text, /Chairman/);
    // The FYI block mirrors the approved trimmed FYI: no player greeting, season paragraph or sign-off.
    assert.doesNotMatch(e.text, /Dear player|Your season counts|Good luck/);
    // HTML escapes the name and links both videos.
    assert.match(e.html, /Dear Thandi &lt;Nkosi&gt;/);
    assert.ok(e.html.includes(`href="${STAFF_URL}"`));
    assert.ok(e.html.includes(`href="${PLAYER_URL}"`));
  });

  test('staff email falls back to "Club Representative" with no name', () => {
    const e = staffWelcomeEmailContent({
      name: ' ',
      staffVideoUrl: STAFF_URL,
      playerVideoUrl: PLAYER_URL,
    });
    assert.ok(e.text.startsWith('Dear Club Representative\n'));
  });

  test('player email: first-name greeting and the player video only', () => {
    const e = playerWelcomeEmailContent({ firstName: 'Sipho', playerVideoUrl: PLAYER_URL });
    assert.equal(e.subject, 'Welcome to the Dolphins Scouting Program 🏏');
    assert.ok(e.text.startsWith('Dear Sipho 🏏\n\n'));
    assert.match(
      e.text,
      /You are registered on the Dolphins scouting pipeline, part of the Medicoach Athlete Management System\. The video linked below shows how it works for you this season\.\n▶ Watch: https:\/\/cdn\.example\.com\/player\.mp4/,
    );
    assert.match(
      e.text,
      /📊 Every ball of your matches is scored live and builds your player profile/,
    );
    assert.match(e.text, /Good luck this season! 💚$/);
    assert.ok(!e.text.includes(STAFF_URL));
    assert.ok(e.html.includes(`href="${PLAYER_URL}"`));
  });
});
