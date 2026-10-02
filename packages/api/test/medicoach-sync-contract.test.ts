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

  test('all five shared examples are present', () => {
    assert.deepEqual(files.sort(), [
      'changes-knockout-reschedule.json',
      'changes-live-result.json',
      'changes-manual-and-cleared.json',
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
