/**
 * Integration tests for sync-club-leagues-from-series (dynalite): it writes
 * source-of-truth CLUB# rows via repo.updateClub, so the real write path is
 * non-optional. Asserts: a plain-id single side adds the league key at count 1;
 * a multi-side club gains the count + a roster built from the SERIES ids;
 * sibling leagueTeams/teamRosters for OTHER leagues survive the wholesale-key
 * replace; a stored roster with different ids is a CONFLICT and left untouched;
 * draft series are ignored without --include-drafts; the run is idempotent; the
 * --only filter and existing keys are honoured.
 *
 * Same harness as api.int.test.ts: in-process dynalite + the real repo, driving
 * the exported syncClubLeaguesFromSeries core (what the CLI's main() calls).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

// Env must be set BEFORE importing repo — it reads TABLE_NAME at module load.
const DDB_PORT = 4629; // distinct from api.int (4599) … backfill-team (4605)
const TABLE = 'SmartClubSyncLeaguesTest';
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.LOCAL_AUTH = '1';
process.env.STAGE = 'local';
process.env.USER_POOL_ID = 'test-pool';
process.env.AWS_REGION ??= 'localhost';
process.env.UPLOADS_BUCKET = 'test-uploads';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_MAX_ATTEMPTS = '1';

const TENANT = 'dolphins';

// Resolved in before().
let ddbServer: Server;
let repo: typeof import('../src/repo.js');
let syncClubLeaguesFromSeries: (typeof import('../src/sync-club-leagues-from-series.js'))['syncClubLeaguesFromSeries'];

type Club = Parameters<(typeof import('../src/repo.js'))['createClub']>[1];
type Series = Parameters<(typeof import('../src/repo.js'))['putSeries']>[1];

const club = (over: Record<string, unknown>): Club =>
  ({
    name: `${over.id} CC`,
    district: 'Test District',
    sub: 's',
    chair: 'Chair',
    affiliation: 'not_started' as const,
    cqi: 0,
    docs: {},
    players: 0,
    teams: 0,
    women: 0,
    juniors: 0,
    color: '#123456',
    ground: { venue: `${over.id} Oval` },
    leagues: [],
    version: 1,
    ...over,
  }) as unknown as Club;

const participant = (teamId: string, clubId: string, name: string) => ({ teamId, clubId, name });

const series = (
  id: string,
  leagueKey: string,
  released: boolean,
  participants: Array<{ teamId: string; clubId: string; name: string }>,
): Series =>
  ({
    id,
    name: `${leagueKey} · ${id}`,
    leagueKey,
    startDate: '2026-10-01',
    teams: participants.map((p) => p.teamId),
    participants,
    fixtures: [],
    released,
    releasedAt: released ? '2026-09-01T00:00:00.000Z' : null,
    version: 1,
  }) as unknown as Series;

before(async () => {
  const dynalite = (await import('dynalite')).default as (opts?: unknown) => Server;
  ddbServer = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => ddbServer.listen(DDB_PORT, resolve));

  const { DynamoDBClient, CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  const admin = new DynamoDBClient({
    endpoint: process.env.DYNAMO_ENDPOINT,
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  await admin.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi1pk', AttributeType: 'S' },
        { AttributeName: 'gsi1sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );

  repo = await import('../src/repo.js');
  ({ syncClubLeaguesFromSeries } = await import('../src/sync-club-leagues-from-series.js'));

  // Tenant config: the league catalogue the sync validates against. `ghost-league`
  // is deliberately ABSENT so its series is an ORPHAN.
  await repo.putTenantConfig({
    tenant: TENANT,
    branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-31',
    knownClubs: [],
    leagues: [
      { key: 'premier', label: 'Premier', group: 'Seniors', district: 'All districts' },
      {
        key: 'veterans-premier',
        label: 'Veterans Premier',
        group: 'Seniors',
        district: 'All districts',
      },
      {
        key: 'veterans-promotion',
        label: 'Veterans Promotion',
        group: 'Seniors',
        district: 'All districts',
      },
    ],
  } as unknown as Parameters<(typeof import('../src/repo.js'))['putTenantConfig']>[0]);

  // alpha: no leagues; plain-id single side in veterans-premier → gains key, count 1.
  await repo.createClub(TENANT, club({ id: 'alpha' }));
  // bravo: no leagues; A/B/C sides in veterans-promotion → count 3 + roster with series ids.
  await repo.createClub(TENANT, club({ id: 'bravo' }));
  // charlie: sibling premier roster must survive; single plain side in veterans-premier.
  await repo.createClub(
    TENANT,
    club({
      id: 'charlie',
      leagues: ['premier'],
      leagueTeams: { premier: 2 },
      teamRosters: {
        premier: [
          { id: 'tm_charlie_premier_0', name: 'Charlie A' },
          { id: 'tm_charlie_premier_1', name: 'Charlie B' },
        ],
      },
    }),
  );
  // delta: existing veterans-promotion with a STORED roster whose ids DIFFER from the
  // series → CONFLICT, left untouched.
  await repo.createClub(
    TENANT,
    club({
      id: 'delta',
      leagues: ['veterans-promotion'],
      leagueTeams: { 'veterans-promotion': 2 },
      teamRosters: {
        'veterans-promotion': [
          { id: 'tm_delta_OLD_a', name: 'Delta A' },
          { id: 'tm_delta_OLD_b', name: 'Delta B' },
        ],
      },
    }),
  );
  // foxtrot: single tm_ side (only its B side) in veterans-promotion → count stays 1, NOTE.
  await repo.createClub(TENANT, club({ id: 'foxtrot' }));
  // echo: only in a DRAFT series → ignored without --include-drafts.
  await repo.createClub(TENANT, club({ id: 'echo' }));

  await repo.putSeries(
    TENANT,
    series('s-vp', 'veterans-premier', true, [
      participant('alpha', 'alpha', 'Alpha CC'),
      participant('charlie', 'charlie', 'Charlie CC'),
    ]),
  );
  await repo.putSeries(
    TENANT,
    series('s-vpromo', 'veterans-promotion', true, [
      participant('tm_bravo_veterans-promotion_0', 'bravo', 'Bravo A'),
      participant('tm_bravo_veterans-promotion_1', 'bravo', 'Bravo B'),
      participant('tm_bravo_veterans-promotion_2', 'bravo', 'Bravo C'),
      participant('tm_delta_veterans-promotion_0', 'delta', 'Delta A'),
      participant('tm_delta_veterans-promotion_1', 'delta', 'Delta B'),
      participant('tm_foxtrot_veterans-promotion_1', 'foxtrot', 'Foxtrot B'),
    ]),
  );
  await repo.putSeries(
    TENANT,
    series('s-draft', 'veterans-premier', false, [participant('echo', 'echo', 'Echo CC')]),
  );
  await repo.putSeries(
    TENANT,
    series('s-orphan', 'ghost-league', true, [participant('alpha', 'alpha', 'Alpha CC')]),
  );
});

after(() => {
  ddbServer?.close();
});

const leaguesOf = async (id: string) => (await repo.getClub(TENANT, id))!.leagues ?? [];
const leagueTeamsOf = async (id: string) => (await repo.getClub(TENANT, id))!.leagueTeams ?? {};
const rostersOf = async (id: string) => (await repo.getClub(TENANT, id))!.teamRosters ?? {};

describe('syncClubLeaguesFromSeries', () => {
  test('dry-run flags the changes, counts orphans/conflicts, writes nothing', async () => {
    const logs: string[] = [];
    const r = await syncClubLeaguesFromSeries(TENANT, { log: (l) => logs.push(l) });
    // alpha, bravo, charlie, foxtrot would change; delta is a conflict (no write); echo draft-only.
    assert.equal(r.wouldPatch, 4);
    assert.equal(r.patched, 0);
    assert.equal(r.orphanSeries, 1); // s-orphan (ghost-league)
    assert.equal(r.conflicts, 1); // delta
    assert.equal(r.singleSideNotes, 1); // foxtrot's lone tm_ side
    assert.ok(logs.some((l) => l.startsWith('ORPHAN s-orphan')));
    assert.ok(logs.some((l) => l.startsWith('CONFLICT delta / veterans-promotion')));
    assert.ok(logs.some((l) => l.startsWith('NOTE foxtrot / veterans-promotion')));
    // Nothing written.
    assert.deepEqual(await leaguesOf('alpha'), []);
    assert.deepEqual(await leaguesOf('bravo'), []);
    // echo untouched (its only series is a draft).
    assert.deepEqual(await leaguesOf('echo'), []);
  });

  test('--confirm adds keys, writes multi-side rosters, preserves siblings, skips conflicts', async () => {
    const r = await syncClubLeaguesFromSeries(TENANT, { confirm: true, log: () => {} });
    assert.equal(r.patched, 4);
    assert.equal(r.raced, 0);

    // alpha: plain single side → key added, no leagueTeams entry (defaults to 1).
    assert.deepEqual(await leaguesOf('alpha'), ['veterans-premier']);
    assert.equal((await leagueTeamsOf('alpha'))['veterans-premier'], undefined);

    // bravo: 3 sides → count 3 + roster mirrors the SERIES ids and names.
    assert.deepEqual(await leaguesOf('bravo'), ['veterans-promotion']);
    assert.equal((await leagueTeamsOf('bravo'))['veterans-promotion'], 3);
    const bravoRoster = (await rostersOf('bravo'))['veterans-promotion'];
    assert.deepEqual(
      bravoRoster.map((t) => t.id),
      [
        'tm_bravo_veterans-promotion_0',
        'tm_bravo_veterans-promotion_1',
        'tm_bravo_veterans-promotion_2',
      ],
    );
    assert.deepEqual(
      bravoRoster.map((t) => t.name),
      ['Bravo A', 'Bravo B', 'Bravo C'],
    );

    // charlie: veterans-premier added; the premier sibling roster/count SURVIVE.
    assert.deepEqual((await leaguesOf('charlie')).sort(), ['premier', 'veterans-premier']);
    assert.equal((await leagueTeamsOf('charlie'))['premier'], 2);
    assert.deepEqual(
      (await rostersOf('charlie'))['premier'].map((t) => t.id),
      ['tm_charlie_premier_0', 'tm_charlie_premier_1'],
    );

    // foxtrot: lone tm_ side → key added at count 1, no roster.
    assert.deepEqual(await leaguesOf('foxtrot'), ['veterans-promotion']);
    assert.equal((await leagueTeamsOf('foxtrot'))['veterans-promotion'], undefined);
    assert.equal((await rostersOf('foxtrot'))['veterans-promotion'], undefined);

    // delta CONFLICT: stored roster + count untouched; key was already present.
    assert.deepEqual(await leaguesOf('delta'), ['veterans-promotion']);
    assert.equal((await leagueTeamsOf('delta'))['veterans-promotion'], 2);
    assert.deepEqual(
      (await rostersOf('delta'))['veterans-promotion'].map((t) => t.id),
      ['tm_delta_OLD_a', 'tm_delta_OLD_b'],
    );

    // echo: draft-only, still untouched.
    assert.deepEqual(await leaguesOf('echo'), []);
  });

  test('idempotent: a second --confirm run writes nothing', async () => {
    const r = await syncClubLeaguesFromSeries(TENANT, { confirm: true, log: () => {} });
    assert.equal(r.patched, 0);
    assert.equal(r.wouldPatch, 0);
  });

  test('--include-drafts picks up the draft series (echo gains its key)', async () => {
    const r = await syncClubLeaguesFromSeries(TENANT, {
      confirm: true,
      includeDrafts: true,
      log: () => {},
    });
    assert.equal(r.patched, 1); // only echo, everything else already synced
    assert.deepEqual(await leaguesOf('echo'), ['veterans-premier']);
  });

  test('--only restricts the pass to the named series', async () => {
    // Fresh club that participates only through s-vpromo; --only s-vp must skip it.
    await repo.createClub(TENANT, club({ id: 'golf' }));
    await repo.putSeries(
      TENANT,
      series('s-vpromo', 'veterans-promotion', true, [
        participant('tm_bravo_veterans-promotion_0', 'bravo', 'Bravo A'),
        participant('tm_bravo_veterans-promotion_1', 'bravo', 'Bravo B'),
        participant('tm_bravo_veterans-promotion_2', 'bravo', 'Bravo C'),
        participant('tm_delta_veterans-promotion_0', 'delta', 'Delta A'),
        participant('tm_delta_veterans-promotion_1', 'delta', 'Delta B'),
        participant('tm_foxtrot_veterans-promotion_1', 'foxtrot', 'Foxtrot B'),
        participant('golf', 'golf', 'Golf CC'),
      ]),
    );
    const r = await syncClubLeaguesFromSeries(TENANT, {
      confirm: true,
      only: ['s-vp'],
      log: () => {},
    });
    // s-vp's clubs (alpha, charlie) are already synced → 0 writes; golf is untouched.
    assert.equal(r.patched, 0);
    assert.deepEqual(await leaguesOf('golf'), []);
  });
});
