/**
 * Sync contract v1: every shared example in docs/integrations/medicoach-sync-examples/
 * parses with this repo's zod schemas WITHOUT losing a field (an unknown field would be
 * stripped, so a deep-equal catches drift), and the signing helpers produce exactly the
 * CONTRACT.md string format.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChangesResponseSchema,
  MEDICOACH_SYNC_VERSION,
  SchedulePushRequestSchema,
  SchedulePushResponseSchema,
  VENUE_MAX_LENGTH,
  capVenue,
  changesPathAndQuery,
  parseFixtureRef,
  parseTeamRef,
  signRequest,
  signingString,
  verifySignature,
} from '../src/medicoach-sync-contract.js';

const EXAMPLES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docs/integrations/medicoach-sync-examples',
);

const schemaFor = (file: string) =>
  file.startsWith('changes-')
    ? ChangesResponseSchema
    : file === 'schedule-push-request.json'
      ? SchedulePushRequestSchema
      : file === 'schedule-push-response.json'
        ? SchedulePushResponseSchema
        : null;

describe('contract examples', () => {
  const files = readdirSync(EXAMPLES).filter((f) => f.endsWith('.json'));

  test('all six shared examples are present', () => {
    assert.deepEqual(files.sort(), [
      'changes-knockout-reschedule.json',
      'changes-live-result.json',
      'changes-manual-and-cleared.json',
      'changes-result-with-play.json',
      'schedule-push-request.json',
      'schedule-push-response.json',
    ]);
  });

  for (const file of files) {
    test(`${file} parses with no field lost`, () => {
      const raw = JSON.parse(readFileSync(path.join(EXAMPLES, file), 'utf8'));
      const schema = schemaFor(file);
      assert.ok(schema, `no schema mapped for ${file}`);
      const parsed = schema.parse(raw);
      assert.deepEqual(parsed, raw);
      assert.equal(raw.version, MEDICOACH_SYNC_VERSION);
    });
  }

  test('a wrong version or a malformed instant is rejected', () => {
    const raw = JSON.parse(readFileSync(path.join(EXAMPLES, 'changes-live-result.json'), 'utf8'));
    assert.equal(ChangesResponseSchema.safeParse({ ...raw, version: 2 }).success, false);
    const bad = structuredClone(raw);
    bad.fixtures[0].result.recordedAt = '4 Oct 2026';
    assert.equal(ChangesResponseSchema.safeParse(bad).success, false);
  });

  test('a match link that is not http(s) is dropped, never passed on to a page', () => {
    const raw = JSON.parse(readFileSync(path.join(EXAMPLES, 'changes-live-result.json'), 'utf8'));
    for (const url of [
      "javascript:document.title='x'",
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
    ]) {
      const hostile = structuredClone(raw);
      hostile.fixtures[0].result.medicoachMatchUrl = url;
      const parsed = ChangesResponseSchema.parse(hostile);
      assert.equal(parsed.fixtures[0].result!.medicoachMatchUrl, null, url);
    }
    const ok = structuredClone(raw);
    ok.fixtures[0].result.medicoachMatchUrl = 'https://live.medicoach.co.za/m/1';
    assert.equal(
      ChangesResponseSchema.parse(ok).fixtures[0].result!.medicoachMatchUrl,
      'https://live.medicoach.co.za/m/1',
    );
  });

  test('a venue longer than 200 characters is accepted and truncated, never rejected', () => {
    const long = `Kingsmead ${'x'.repeat(300)}`;
    const raw = JSON.parse(readFileSync(path.join(EXAMPLES, 'changes-live-result.json'), 'utf8'));
    raw.fixtures[0].schedule.venue = long;
    const parsed = ChangesResponseSchema.parse(raw);
    assert.equal(parsed.fixtures[0].schedule.venue, long.slice(0, VENUE_MAX_LENGTH));
    assert.equal(VENUE_MAX_LENGTH, 200);

    const push = JSON.parse(
      readFileSync(path.join(EXAMPLES, 'schedule-push-request.json'), 'utf8'),
    );
    push.changes[0].schedule.venue = long;
    assert.equal(
      SchedulePushRequestSchema.parse(push).changes[0].schedule.venue!.length,
      VENUE_MAX_LENGTH,
    );
    // Exactly 200 and shorter pass through unchanged; null stays null.
    assert.equal(capVenue('a'.repeat(200)), 'a'.repeat(200));
    assert.equal(capVenue('Lahee Park'), 'Lahee Park');
    assert.equal(capVenue(null), null);
  });

  test('truncation never splits a surrogate pair', () => {
    const v = `${'a'.repeat(199)}🏏tail`;
    const capped = capVenue(v)!;
    assert.ok(capped.length <= VENUE_MAX_LENGTH);
    assert.equal(capped, 'a'.repeat(199));
  });
});

describe('request signing', () => {
  const secret = 'test-secret';
  const pathAndQuery = changesPathAndQuery('dolphins', '2026-10-04T14:32:10.123Z', 200);

  test('the path+query is built exactly once and in the documented shape', () => {
    assert.equal(
      pathAndQuery,
      '/integrations/smartclub/changes?tenant=dolphins&since=2026-10-04T14%3A32%3A10.123Z&limit=200',
    );
    assert.equal(
      changesPathAndQuery('dolphins'),
      '/integrations/smartclub/changes?tenant=dolphins',
    );
    assert.equal(
      changesPathAndQuery('dolphins', '0'),
      '/integrations/smartclub/changes?tenant=dolphins',
    );
  });

  test('signature = sha256=<hex HMAC(secret, `${ts}.${METHOD}.${pathAndQuery}.${body}`)>', () => {
    const headers = signRequest({
      secret,
      method: 'get',
      pathAndQuery,
      timestamp: 1_790_000_000_000,
    });
    assert.equal(headers['X-Sync-Timestamp'], '1790000000000');
    const expected = createHmac('sha256', secret)
      .update(`1790000000000.GET.${pathAndQuery}.`)
      .digest('hex');
    assert.equal(headers['X-Sync-Signature'], `sha256=${expected}`);
    assert.equal(signingString('1', 'post', '/x?a=1', '{"b":2}'), '1.POST./x?a=1.{"b":2}');
  });

  test('round-trip verifies; tamper, wrong secret, skew and junk are rejected', () => {
    const now = 1_790_000_000_000;
    const body = '{"version":1}';
    const h = signRequest({
      secret,
      method: 'POST',
      pathAndQuery: '/integrations/smartclub/schedule',
      body,
      timestamp: now,
    });
    const verify = (over: Partial<Parameters<typeof verifySignature>[0]> = {}) =>
      verifySignature({
        secret,
        method: 'POST',
        pathAndQuery: '/integrations/smartclub/schedule',
        body,
        timestampHeader: h['X-Sync-Timestamp'],
        signatureHeader: h['X-Sync-Signature'],
        now,
        ...over,
      });
    assert.deepEqual(verify(), { ok: true });
    assert.deepEqual(verify({ body: '{"version":2}' }), { ok: false, reason: 'mismatch' });
    assert.deepEqual(verify({ secret: 'other' }), { ok: false, reason: 'mismatch' });
    assert.deepEqual(verify({ now: now + 300_001 }), { ok: false, reason: 'skew' });
    assert.deepEqual(verify({ now: now - 300_000 }), { ok: true }, 'exactly 5 min is allowed');
    assert.deepEqual(verify({ signatureHeader: 'sha256=zz' }), { ok: false, reason: 'malformed' });
    assert.deepEqual(verify({ timestampHeader: undefined }), { ok: false, reason: 'malformed' });
  });
});

describe('refs', () => {
  test('series and recipe fixture refs parse; others do not', () => {
    assert.deepEqual(parseFixtureRef('smartclub:dolphins:fixture:s-planb-premier-men-t20-g1:f3'), {
      tenant: 'dolphins',
      kind: 'series',
      seriesId: 's-planb-premier-men-t20-g1',
      fixtureId: 'f3',
    });
    assert.deepEqual(
      parseFixtureRef('smartclub:dolphins:fixture:recipe:veterans-premier:t20:sf1'),
      {
        tenant: 'dolphins',
        kind: 'recipe',
        leagueKey: 'veterans-premier',
        stream: 't20',
        slotId: 'sf1',
      },
    );
    assert.equal(parseFixtureRef('smartclub:dolphins:team:premier:crusaders'), null);
    assert.equal(parseFixtureRef('smartclub:dolphins:fixture:s-x'), null);
  });

  test('team refs parse', () => {
    assert.deepEqual(parseTeamRef('smartclub:dolphins:team:premier:crusaders'), {
      tenant: 'dolphins',
      leagueKey: 'premier',
      teamId: 'crusaders',
    });
    assert.equal(parseTeamRef('smartclub:dolphins:fixture:a:b'), null);
  });
});

describe('stored result view', () => {
  test('a stored match link that is not http(s) is served as null (rows stored before the contract filter)', async () => {
    const { toResultView } = await import('../src/medicoach-sync/series-results.js');
    const base = {
      seriesId: 's1',
      fixtureId: 'f1',
      ref: 'smartclub:t:fixture:s1:f1',
      orderAt: '2026-10-03T00:00:00.000Z',
      recordedAt: '2026-10-03T00:00:00.000Z',
      storedAt: '2026-10-03T00:00:00.000Z',
      summary: 'A won',
    };
    assert.equal(
      toResultView({ ...base, medicoachMatchUrl: 'javascript:alert(1)' })!.medicoachMatchUrl,
      null,
    );
    assert.equal(
      toResultView({ ...base, medicoachMatchUrl: 'https://live.medicoach.co.za/m/1' })!
        .medicoachMatchUrl,
      'https://live.medicoach.co.za/m/1',
    );
  });
});

describe('result play block (ground time and balls)', () => {
  const base = () =>
    JSON.parse(readFileSync(path.join(EXAMPLES, 'changes-result-with-play.json'), 'utf8'));

  test('is optional: a medicoach that does not send it still parses', () => {
    const raw = JSON.parse(readFileSync(path.join(EXAMPLES, 'changes-live-result.json'), 'utf8'));
    const parsed = ChangesResponseSchema.parse(raw);
    assert.equal(parsed.fixtures[0].result?.play, undefined);
  });

  test('a malformed block becomes null; the result and the page still parse', () => {
    for (const bad of [
      { startedAt: 'yesterday', endedAt: null, legalBalls: 1, deliveries: 1 },
      { startedAt: null, endedAt: null, legalBalls: -4, deliveries: 1 },
      {
        startedAt: '2026-10-04T12:00:00.000Z',
        endedAt: '2026-10-04T08:00:00.000Z',
        legalBalls: 1,
        deliveries: 1,
      },
      { startedAt: null, endedAt: null, legalBalls: 240, deliveries: 100 },
      'two hundred balls',
    ]) {
      const raw = base();
      raw.fixtures[0].result.play = bad;
      const parsed = ChangesResponseSchema.parse(raw);
      assert.equal(parsed.fixtures[0].result?.play, null, JSON.stringify(bad));
      assert.equal(parsed.fixtures[0].result?.homeScore, '184/6 (20)');
    }
  });
});
