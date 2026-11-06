import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SendResult } from '../src/types.js';
import {
  assertSendableLinkOrigin,
  buildReport,
  channelSkipReason,
  checkMetaTemplate,
  EMAIL_CORRECTION_NOTE,
  resolveLinkOrigin,
  mergeSendResults,
  parseChannelsArg,
  resolveChannels,
  matchRows,
  namesAgree,
  parseSheetRows,
  type MatchPlayer,
  type SheetRow,
} from '../src/request-id-docs-from-sheet.js';
import { WHATSAPP_TEMPLATES } from '../src/notify/whatsapp-templates.js';
import { docRequestEmailContent } from '../src/notify/email.js';

// Synthetic data only.
const clubs = [
  { id: 'c-alpha', name: 'Alpha CC' },
  { id: 'c-beta', name: 'Beta CC' },
];
const p = (o: Partial<MatchPlayer> & Pick<MatchPlayer, 'naturalKey' | 'clubId'>): MatchPlayer => ({
  firstName: 'Test',
  lastName: 'Person',
  idNumber: '0000000000000',
  status: 'active',
  ...o,
});
const players = new Map<string, MatchPlayer[]>([
  [
    'c-alpha',
    [
      p({
        naturalKey: 'k1',
        clubId: 'c-alpha',
        firstName: 'Zed',
        lastName: 'Quill',
        idNumber: '1111111111111',
      }),
      p({ naturalKey: 'k3a', clubId: 'c-alpha', idNumber: '3333333333333', status: 'inactive' }),
      p({ naturalKey: 'k3b', clubId: 'c-alpha', idNumber: '3333333333333', status: 'active' }),
      p({ naturalKey: 'k4a', clubId: 'c-alpha', idNumber: 'X4444', status: 'active' }),
      p({ naturalKey: 'k4b', clubId: 'c-alpha', idNumber: 'X4444', status: 'active' }),
    ],
  ],
  [
    'c-beta',
    [
      p({
        naturalKey: 'k2',
        clubId: 'c-beta',
        firstName: 'Ann',
        lastName: 'Moved',
        idNumber: '2222222222222',
      }),
    ],
  ],
]);
const row = (num: string, player: string, club: string, idNumber: string): SheetRow => ({
  num,
  line: Number(num) + 1,
  problem: 'Missing',
  player,
  club,
  idNumber,
});

test('parseSheetRows reads the named columns and drops blank players', () => {
  const rows = parseSheetRows([
    ['#', 'Problem', 'Detail', 'Player', 'Club', 'Team', 'Status', 'ID type', 'ID / passport no.'],
    [1, 'No doc', '', 'Zed Quill', 'Alpha CC', '', '', '', 1111111111111],
    [2, '', '', '', '', '', '', '', ''],
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { ...rows[0] },
    {
      num: '1',
      line: 2,
      problem: 'No doc',
      player: 'Zed Quill',
      club: 'Alpha CC',
      idNumber: '1111111111111',
    },
  );
});

test('exact club + ID match', () => {
  const [o] = matchRows([row('1', 'zed quill', ' alpha cc ', '1111111111111')], clubs, players);
  assert.equal(o.kind, 'matched');
  if (o.kind !== 'matched') return;
  assert.equal(o.player.naturalKey, 'k1');
  assert.equal(o.movedFromSheetClub, false);
  assert.equal(o.nameMismatch, false);
});

test('moved-club fallback finds the player at another club', () => {
  const [o] = matchRows([row('2', 'Ann Moved', 'Alpha CC', '2222222222222')], clubs, players);
  assert.equal(o.kind, 'matched');
  if (o.kind !== 'matched') return;
  assert.equal(o.player.clubId, 'c-beta');
  assert.equal(o.movedFromSheetClub, true);
});

test('duplicate IDs prefer the single active row, else ambiguous', () => {
  const [a, b] = matchRows(
    [
      row('3', 'Test Person', 'Alpha CC', '3333333333333'),
      row('4', 'Test Person', 'Alpha CC', 'x4444'),
    ],
    clubs,
    players,
  );
  assert.equal(a.kind, 'matched');
  if (a.kind === 'matched') assert.equal(a.player.naturalKey, 'k3b');
  assert.equal(b.kind, 'ambiguous');
});

test('not found when no club has the ID', () => {
  const [o] = matchRows([row('5', 'Nobody', 'Alpha CC', '9999999999999')], clubs, players);
  assert.equal(o.kind, 'not-found');
});

test('name mismatch warns but the ID match still sends', () => {
  const [o] = matchRows(
    [row('6', 'Completely Different', 'Alpha CC', '1111111111111')],
    clubs,
    players,
  );
  assert.equal(o.kind, 'matched');
  if (o.kind === 'matched') assert.equal(o.nameMismatch, true);
  const { lines } = buildReport(
    [o],
    (id) => clubs.find((c) => c.id === id)!.name,
    () => null,
  );
  assert.ok(lines.some((l) => l.bucket === 'name-mismatch'));
  assert.ok(lines.some((l) => l.bucket === 'will-send'));
  assert.equal(namesAgree('Zed Quill', 'Zara', 'Quill'), false);
  assert.equal(namesAgree('Zed', 'Zed', 'Quill'), true);
});

test('unmatched club is reported and still falls back across clubs', () => {
  const outcomes = matchRows(
    [
      row('7', 'Ann Moved', 'Gamma CC', '2222222222222'),
      row('8', 'Nobody', 'Gamma CC', '8888888888888'),
    ],
    clubs,
    players,
  );
  assert.equal(outcomes[0].kind, 'matched');
  assert.equal(outcomes[0].unmatchedClub, true);
  assert.equal(outcomes[1].kind, 'not-found');
  const report = buildReport(
    outcomes,
    (id) => clubs.find((c) => c.id === id)!.name,
    () => 'skipped_minor',
  );
  assert.deepEqual(report.unmatchedClubNames, ['Gamma CC']);
  assert.ok(report.lines.some((l) => l.bucket === 'skip'));
  // PII-free: no ID numbers in any report line.
  assert.ok(report.lines.every((l) => !/\d{6,}/.test(l.text)));
});

test('parseChannelsArg: default both, csv, dedupe, rejects unknown/empty', () => {
  assert.deepEqual(parseChannelsArg(undefined), ['email', 'whatsapp']);
  assert.deepEqual(parseChannelsArg('whatsapp'), ['whatsapp']);
  assert.deepEqual(parseChannelsArg(' WhatsApp , email,email'), ['whatsapp', 'email']);
  assert.throws(() => parseChannelsArg('sms'), /unknown channel/);
  assert.throws(() => parseChannelsArg(' , '), /no channels/);
});

test('resolveChannels: intersection with allowed + explicit-whatsapp aborts', () => {
  const ok = { whatsappOn: true, templateReady: true };
  assert.deepEqual(resolveChannels(['whatsapp', 'email'], ok), ['email', 'whatsapp']);
  assert.deepEqual(resolveChannels(['whatsapp'], ok), ['whatsapp']);
  assert.deepEqual(resolveChannels(['email'], { whatsappOn: false, templateReady: false }), [
    'email',
  ]);
  assert.throws(
    () => resolveChannels(['whatsapp'], { whatsappOn: false, templateReady: true }),
    /whatsappInvites off/,
  );
  assert.throws(
    () => resolveChannels(['whatsapp'], { whatsappOn: true, templateReady: false }),
    /template is not ready/,
  );
  assert.throws(() => resolveChannels([], ok), /no effective channels/);
});

test('channelSkipReason: whatsapp-only sends cell-only, skips no-cell even with email', () => {
  const hasCell = (c: string | undefined) => !!c;
  const cellOnly = { isMinor: false, email: '', cell: '0820000000' };
  const emailOnly = { isMinor: false, email: 'a@example.com', cell: '' };
  assert.equal(channelSkipReason(cellOnly, ['whatsapp'], hasCell), null);
  assert.equal(channelSkipReason(emailOnly, ['whatsapp'], hasCell), 'skipped_no_contact');
  assert.equal(channelSkipReason(emailOnly, ['email'], hasCell), null);
  assert.equal(channelSkipReason(cellOnly, ['email'], hasCell), 'skipped_no_contact');
  assert.equal(channelSkipReason(cellOnly, ['email', 'whatsapp'], hasCell), null);
  assert.equal(
    channelSkipReason({ ...cellOnly, isMinor: true }, ['whatsapp'], hasCell),
    'skipped_minor',
  );
});

test('mergeSendResults: replaces attempted channels, keeps the others', () => {
  const prior: SendResult[] = [
    { channel: 'email', status: 'sent' } as SendResult,
    { channel: 'whatsapp', status: 'failed', error: 'no button' } as SendResult,
  ];
  const next: SendResult[] = [{ channel: 'whatsapp', status: 'sent' } as SendResult];
  assert.deepEqual(mergeSendResults(prior, next, ['whatsapp']), [prior[0], next[0]]);
  assert.deepEqual(mergeSendResults(undefined, next, ['whatsapp']), next);
  assert.deepEqual(mergeSendResults(prior, [], ['whatsapp']), [prior[0]]);
});

// ── Link origin (the Nov 2026 localhost-link incident)

const vanity = [
  { slug: 'dolphins', webHost: 'dolphins.example.org', enabled: true },
] as unknown as Parameters<typeof resolveLinkOrigin>[0]['vanity'];

test('resolveLinkOrigin: prod vanity tenant resolves to its https origin', () => {
  assert.equal(
    resolveLinkOrigin({ stage: 'prod', tenant: 'dolphins', vanity, wildcardEnabled: true }),
    'https://dolphins.example.org',
  );
});

test('resolveLinkOrigin: prod unknown tenant falls to the wildcard when armed', () => {
  assert.equal(
    resolveLinkOrigin({
      stage: 'prod',
      tenant: 'titans',
      vanity,
      wildcardEnabled: true,
      wildcardSuffix: '.club.example.org',
    }),
    'https://titans.club.example.org',
  );
  assert.throws(
    () => resolveLinkOrigin({ stage: 'prod', tenant: 'titans', vanity, wildcardEnabled: false }),
    /--link-origin/,
  );
});

test('resolveLinkOrigin: non-prod / unknown stage needs --link-origin', () => {
  assert.throws(
    () => resolveLinkOrigin({ stage: 'dev', tenant: 'dolphins', vanity }),
    /--link-origin/,
  );
  assert.throws(
    () => resolveLinkOrigin({ stage: null, tenant: 'dolphins', vanity }),
    /--link-origin/,
  );
  assert.equal(
    resolveLinkOrigin({ stage: 'dev', tenant: 'dolphins', linkOrigin: 'https://dev.example.org/' }),
    'https://dev.example.org',
  );
});

test('assertSendableLinkOrigin: rejects localhost / loopback / non-https', () => {
  assert.throws(() => assertSendableLinkOrigin('http://localhost:5173'), /aborted/);
  assert.throws(() => assertSendableLinkOrigin('https://localhost:5173'), /aborted/);
  assert.throws(() => assertSendableLinkOrigin('https://127.0.0.1'), /aborted/);
  assert.throws(() => assertSendableLinkOrigin('http://dolphins.example.org'), /aborted/);
  assert.doesNotThrow(() => assertSendableLinkOrigin('https://dolphins.example.org'));
});

// ── Meta template preflight

const def = WHATSAPP_TEMPLATES.playerDocRequest;
const goodMeta = () => ({
  name: 'player_doc_request_v2',
  language: 'en',
  status: 'APPROVED',
  parameter_format: 'POSITIONAL',
  components: [
    { type: 'BODY', text: 'Hello {{1}}, {{2}} wants your {{3}}.' },
    {
      type: 'BUTTONS',
      buttons: [{ type: 'URL', text: 'Upload', url: 'https://platform.example.org/d/{{1}}' }],
    },
  ],
});

test('checkMetaTemplate: the correct live shape passes', () => {
  assert.deepEqual(checkMetaTemplate(def, goodMeta()), []);
});

test('checkMetaTemplate: missing BUTTONS fails', () => {
  const m = goodMeta();
  m.components = m.components.filter((c) => c.type !== 'BUTTONS');
  const p = checkMetaTemplate(def, m);
  assert.equal(p.length, 1);
  assert.match(p[0], /URL button/);
});

test('checkMetaTemplate: static URL button without {{1}} fails', () => {
  const m = goodMeta();
  m.components[1] = {
    type: 'BUTTONS',
    buttons: [{ type: 'URL', text: 'Upload', url: 'https://platform.example.org/d/' }],
  };
  const p = checkMetaTemplate(def, m);
  assert.equal(p.length, 1);
  assert.match(p[0], /platform\.example\.org\/d\//);
});

test('checkMetaTemplate: wrong language / status / body arity fail', () => {
  const p = checkMetaTemplate(def, {
    ...goodMeta(),
    language: 'en_US',
    status: 'PENDING',
    components: [{ type: 'BODY', text: 'Hello {{1}}' }, goodMeta().components[1]],
  });
  assert.equal(p.length, 3);
  assert.ok(p.some((x) => /language/.test(x)));
  assert.ok(p.some((x) => /status/.test(x)));
  assert.ok(p.some((x) => /BODY/.test(x)));
});

// ── --email-correction

test('docRequestEmailContent: correction note in both variants only when set', () => {
  const base = {
    firstName: 'Sam',
    orgName: 'Org',
    clubName: 'Alpha CC',
    docName: 'ID document',
    link: 'https://x.example.org/d/tok',
    expiresText: 'Thu 19 Nov 2026',
  };
  const plain = docRequestEmailContent(base);
  assert.ok(!plain.text.includes('Apologies'));
  assert.ok(!plain.html.includes('Apologies'));
  const fixed = docRequestEmailContent({ ...base, correctionNote: EMAIL_CORRECTION_NOTE });
  assert.ok(fixed.text.includes(EMAIL_CORRECTION_NOTE));
  assert.ok(fixed.html.includes('<p>Apologies — the link in our earlier email did not work.'));
  assert.ok(fixed.text.indexOf('Apologies') < fixed.text.indexOf('has asked you'));
  // Absent ⇒ identical to the pre-change email: removing the note restores it exactly.
  assert.equal(fixed.text.replace(`${EMAIL_CORRECTION_NOTE}\n\n`, ''), plain.text);
  assert.equal(fixed.html.replace(`<p>${EMAIL_CORRECTION_NOTE}</p>`, ''), plain.html);
});
