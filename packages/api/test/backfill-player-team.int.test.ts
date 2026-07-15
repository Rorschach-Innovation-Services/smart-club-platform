/**
 * Integration tests for the backfill-player-team script core (dynalite): it
 * writes source-of-truth PLAYER# rows, so the real write path is non-optional.
 * Asserts: fills absent `team` at single-league clubs, never touches existing
 * or orphaned values, skips multi/zero-league clubs, dry-run writes nothing,
 * idempotent on re-run.
 *
 * Same harness as api.int.test.ts: in-process dynalite + the real repo, driving
 * the exported backfillPlayerTeam core (what the CLI's main() calls).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

// Env must be set BEFORE importing repo — it reads TABLE_NAME at module load.
const DDB_PORT = 4605; // distinct from api.int (4599), platform.int (4601), logo-offline (4603)
const TABLE = 'SmartClubBackfillTeamTest';
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

// Resolved in before().
let ddbServer: Server;
let repo: typeof import('../src/repo.js');
let backfillPlayerTeam: (typeof import('../src/backfill-player-team.js'))['backfillPlayerTeam'];

const club = (id: string, leagues: string[]) =>
  ({
    id,
    name: `${id} CC`,
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
    ground: {},
    leagues,
    version: 1,
  }) as unknown as Parameters<(typeof import('../src/repo.js'))['createClub']>[1];

const player = (clubId: string, n: string, team?: string) => ({
  naturalKey: n,
  clubId,
  firstName: n,
  lastName: 'Player',
  dob: '1995-01-01',
  isMinor: false,
  consentAt: '2026-05-01T00:00:00.000Z',
  createdAt: '2026-05-01T00:00:00.000Z',
  ...(team !== undefined ? { team } : {}),
});

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

  const seed = await import('../src/seed-core.js');
  await seed.seedTenantConfig('dolphins');
  repo = await import('../src/repo.js');
  ({ backfillPlayerTeam } = await import('../src/backfill-player-team.js'));

  // solo: single-league — the backfill's target shape.
  await repo.createClub('dolphins', club('solo', ['premier']));
  await repo.createPlayer('dolphins', player('solo', 'noteam1'));
  await repo.createPlayer('dolphins', player('solo', 'noteam2'));
  await repo.createPlayer('dolphins', player('solo', 'kept', 'existing-league'));
  await repo.createPlayer('dolphins', player('solo', 'orphan', 'ghost-league')); // orphaned key
  // multi: two leagues — attribution would be a guess, must be skipped.
  await repo.createClub('dolphins', club('multi', ['premier', 'u13']));
  await repo.createPlayer('dolphins', player('multi', 'mnoteam'));
  // bare: zero leagues — nothing to attribute to, must be skipped.
  await repo.createClub('dolphins', club('bare', []));
  await repo.createPlayer('dolphins', player('bare', 'bnoteam'));
});

after(() => {
  ddbServer?.close();
});

const teamOf = async (clubId: string, naturalKey: string) => {
  const players = await repo.listPlayers('dolphins', clubId);
  return players.find((p) => p.naturalKey === naturalKey)?.team;
};

describe('backfillPlayerTeam', () => {
  test('dry-run counts the candidates but writes nothing', async () => {
    const logs: string[] = [];
    const result = await backfillPlayerTeam('dolphins', { log: (l) => logs.push(l) });
    assert.equal(result.clubs, 3);
    assert.equal(result.skippedClubs, 2); // multi + bare
    assert.equal(result.candidates, 2); // solo's two team-less players
    assert.equal(result.filled, 0);
    assert.ok(logs.some((l) => l.startsWith('[dry-run] solo')));
    // Nothing changed on any row.
    assert.equal(await teamOf('solo', 'noteam1'), undefined);
    assert.equal(await teamOf('solo', 'noteam2'), undefined);
    assert.equal(await teamOf('multi', 'mnoteam'), undefined);
    assert.equal(await teamOf('bare', 'bnoteam'), undefined);
  });

  test('--confirm fills only absent teams at the single-league club', async () => {
    const result = await backfillPlayerTeam('dolphins', { confirm: true, log: () => {} });
    assert.equal(result.candidates, 2);
    assert.equal(result.filled, 2);
    assert.equal(result.raced, 0);
    assert.equal(await teamOf('solo', 'noteam1'), 'premier');
    assert.equal(await teamOf('solo', 'noteam2'), 'premier');
    // Existing and orphaned values are registration-time source data — untouched.
    assert.equal(await teamOf('solo', 'kept'), 'existing-league');
    assert.equal(await teamOf('solo', 'orphan'), 'ghost-league');
    // Multi/zero-league clubs' players stay team-less (honestly unattributed).
    assert.equal(await teamOf('multi', 'mnoteam'), undefined);
    assert.equal(await teamOf('bare', 'bnoteam'), undefined);
  });

  test('idempotent: a re-run finds no candidates and writes nothing', async () => {
    const result = await backfillPlayerTeam('dolphins', { confirm: true, log: () => {} });
    assert.equal(result.candidates, 0);
    assert.equal(result.filled, 0);
  });

  test('the conditional guard itself refuses to overwrite a stored team', async () => {
    // Belt-and-suspenders on the repo primitive: even called directly against a
    // row that already has a team, the write must lose (return false), not clobber.
    const ok = await repo.setPlayerTeamIfAbsent('dolphins', 'solo', 'kept', 'premier');
    assert.equal(ok, false);
    assert.equal(await teamOf('solo', 'kept'), 'existing-league');
    // And it must not resurrect a phantom row for a player that does not exist.
    const ghost = await repo.setPlayerTeamIfAbsent(
      'dolphins',
      'solo',
      'never-registered',
      'premier',
    );
    assert.equal(ghost, false);
    const solos = await repo.listPlayers('dolphins', 'solo');
    assert.ok(!solos.some((p) => p.naturalKey === 'never-registered'));
  });
});
