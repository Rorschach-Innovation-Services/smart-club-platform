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
  ScorecardResponseSchema,
  VENUE_MAX_LENGTH,
  capVenue,
  changesPathAndQuery,
  parseFixtureRef,
  parseTeamRef,
  scorecardPathAndQuery,
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
        : file.startsWith('scorecard-')
          ? ScorecardResponseSchema
          : null;

describe('contract examples', () => {
  const files = readdirSync(EXAMPLES).filter((f) => f.endsWith('.json'));

  test('all six shared examples are present', () => {
    assert.deepEqual(files.sort(), [
      'changes-knockout-reschedule.json',
      'changes-live-result.json',
      'changes-manual-and-cleared.json',
      'schedule-push-request.json',
      'schedule-push-response.json',
      'scorecard-live-match.json',
    ]);
  });

  for (const file of files) {
    test(`${file} parses with no field lost`, () => {
      const raw = JSON.parse(readFileSync(path.join(EXAMPLES, file), 'utf8'));
      const schema = schemaFor(file);
      assert.ok(schema, `no schema mapped for ${file}`);
      const parsed = schema.parse(raw);
      assert.deepEqual(parsed, raw);
      // The scorecard response is pinned without a `version` field (contract §3).
      if (!file.startsWith('scorecard-')) assert.equal(raw.version, MEDICOACH_SYNC_VERSION);
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

describe('scorecard contract', () => {
  /** The pinned wire example for GET /integrations/smartclub/matches/:matchId/scorecard. */
  const pinned = {
    available: true,
    matchId: 'pma-123',
    matchState: 'Umzinto won by 23 runs',
    innings: [
      {
        battingTeamName: 'Umzinto',
        totalRuns: 184,
        wickets: 6,
        overs: '20.0',
        extras: { byes: 1, legByes: 2, wides: 5, noBalls: 1, penalties: 0, total: 9 },
        batters: [
          {
            order: 1,
            name: 'A Batter',
            runs: 64,
            ballsFaced: 41,
            fours: 6,
            sixes: 3,
            strikeRate: 156.1,
            howOut: 'c Fielder b Bowler',
            dismissal: 'caught',
          },
          {
            order: 2,
            name: 'B Batter',
            runs: 12,
            ballsFaced: 10,
            fours: 1,
            sixes: 0,
            strikeRate: 120,
            howOut: 'not out',
          },
        ],
        bowlers: [
          {
            order: 1,
            name: 'C Bowler',
            overs: '4.0',
            maidens: 0,
            runsConceded: 31,
            wickets: 2,
            economy: 7.75,
            wides: 2,
            noBalls: 0,
          },
        ],
        fallOfWickets: [{ wicket: 1, runs: 22, overs: '2.6', batterName: 'A Batter' }],
      },
    ],
  };

  test('the pinned example round-trips with no field lost', () => {
    assert.deepEqual(ScorecardResponseSchema.parse(pinned), pinned);
  });

  test('available:false needs no innings or match state', () => {
    const bare = { available: false, matchId: 'pma-123' };
    assert.deepEqual(ScorecardResponseSchema.parse(bare), bare);
  });

  test('a batter missing a required field fails the schema', () => {
    const bad = structuredClone(pinned) as Record<string, any>;
    delete bad.innings[0].batters[0].ballsFaced;
    assert.equal(ScorecardResponseSchema.safeParse(bad).success, false);
    assert.equal(ScorecardResponseSchema.safeParse({ available: true }).success, false);
  });

  test('a result carries the optional medicoach match + tournament ids through the schema', () => {
    const raw = JSON.parse(readFileSync(path.join(EXAMPLES, 'changes-live-result.json'), 'utf8'));
    raw.fixtures[0].result.medicoachMatchId = 'pma-123';
    raw.fixtures[0].result.medicoachTournamentId = 'tour-9';
    const parsed = ChangesResponseSchema.parse(raw);
    assert.equal(parsed.fixtures[0].result!.medicoachMatchId, 'pma-123');
    assert.equal(parsed.fixtures[0].result!.medicoachTournamentId, 'tour-9');
  });

  test('a malformed medicoach match or tournament id fails the contract', () => {
    const raw = JSON.parse(readFileSync(path.join(EXAMPLES, 'changes-live-result.json'), 'utf8'));
    for (const [field, bad] of [
      ['medicoachMatchId', 'pma 1/2'],
      ['medicoachTournamentId', 'x'.repeat(129)],
      ['medicoachTournamentId', 'tour?9'],
    ] as const) {
      const copy = structuredClone(raw);
      copy.fixtures[0].result.medicoachMatchId = 'pma-123';
      copy.fixtures[0].result.medicoachTournamentId = 'tour-9';
      copy.fixtures[0].result[field] = bad;
      assert.equal(ChangesResponseSchema.safeParse(copy).success, false, `${field}=${bad}`);
    }
    // An empty id is another spelling of "absent" (the puller drops it), not malformed.
    const empty = structuredClone(raw);
    empty.fixtures[0].result.medicoachMatchId = '';
    empty.fixtures[0].result.medicoachTournamentId = 'x'.repeat(128);
    assert.equal(ChangesResponseSchema.safeParse(empty).success, true);
  });

  test('scorecard path: match id encoded, tournamentId then tenant always in the query', () => {
    assert.equal(
      scorecardPathAndQuery('pma 1/2', 'tour-9', 'dolphins'),
      '/integrations/smartclub/matches/pma%201%2F2/scorecard?tournamentId=tour-9&tenant=dolphins',
    );
    // Values are URL-encoded; the order never changes (it is part of the signed string).
    assert.equal(
      scorecardPathAndQuery('pma-1', 'tour 9&x', 'a b'),
      '/integrations/smartclub/matches/pma-1/scorecard?tournamentId=tour+9%26x&tenant=a+b',
    );
  });

  test('scorecard path signs and verifies with the tenant in the signed query', () => {
    const pathAndQuery = scorecardPathAndQuery('pma-1', 'tour-9', 'dolphins');
    const headers = signRequest({ secret: 's3cret', method: 'GET', pathAndQuery });
    const verify = (pq: string) =>
      verifySignature({
        secret: 's3cret',
        method: 'GET',
        pathAndQuery: pq,
        body: '',
        timestampHeader: headers['X-Sync-Timestamp'],
        signatureHeader: headers['X-Sync-Signature'],
      }).ok;
    assert.equal(verify(pathAndQuery), true);
    // Swapping the tenant breaks the signature.
    assert.equal(verify(pathAndQuery.replace('tenant=dolphins', 'tenant=titans')), false);
  });
});
