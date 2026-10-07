/**
 * Integration tests (dynalite) for the Titans fixtures CLI's repo-writing modes that need no
 * workbook: `--revert` (manifest series only, released refusal, backup) and `--restore-clubs`
 * (structure fields only, version-pinned, validated, idempotent). Same harness as
 * sync-club-leagues.int.test.ts: in-process dynalite + the real repo.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Env must be set BEFORE importing repo — it reads TABLE_NAME at module load.
const DDB_PORT = 4641;
const TABLE = 'SmartClubTitansFixturesTest';
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

const TENANT = 'titans';
let ddbServer: Server;
let repo: typeof import('../src/repo.js');
let cli: typeof import('../src/import-titans-fixtures.js');
const dir = mkdtempSync(join(tmpdir(), 'titans-int-'));

type Club = Parameters<(typeof import('../src/repo.js'))['createClub']>[1];
type Series = Parameters<(typeof import('../src/repo.js'))['putSeries']>[1];

const club = (over: Record<string, unknown>): Club =>
  ({
    name: `${over.id}`,
    district: 'All districts',
    sub: 's',
    chair: 'Chair',
    affiliation: 'not_started' as const,
    cqi: 0,
    docs: {},
    players: 0,
    teams: 1,
    women: 0,
    juniors: 0,
    color: '#123456',
    ground: { venue: 'ALOE PARK' },
    leagues: [],
    version: 1,
    ...over,
  }) as unknown as Club;

const series = (id: string, released = false): Series =>
  ({
    id,
    name: id,
    leagueKey: 'premier-league',
    startDate: '2026-10-24',
    teams: [],
    participants: [],
    fixtures: [],
    released,
    releasedAt: released ? '2026-10-01T00:00:00.000Z' : null,
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
  cli = await import('../src/import-titans-fixtures.js');
  await repo.putTenantConfig({
    tenant: TENANT,
    branding: { name: 'Titans', title: 'Titans', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-31',
    knownClubs: [],
    leagues: [
      { key: 'premier-league', label: 'Premier League', group: 'G', district: 'All districts' },
      { key: 'third-league', label: 'Third League', group: 'G', district: 'All districts' },
      {
        key: 'mens-t20',
        label: "Men's T20",
        group: 'T20 Cups',
        district: 'All districts',
        fixturesOnly: true,
      },
    ],
  } as unknown as Parameters<(typeof import('../src/repo.js'))['putTenantConfig']>[0]);
});

after(() => {
  ddbServer?.close();
});

describe('--revert', () => {
  test('dry run deletes nothing; a RELEASED series refuses --confirm without --include-released', async () => {
    await repo.putSeries(TENANT, series('s-titans-premier-league-a'));
    await repo.putSeries(TENANT, series('s-titans-premier-league-b', true));
    await repo.putSeries(TENANT, series('s-titans-not-in-manifest'));
    await cli.runRevert(cli.parseArgs(['--revert', '--backup-dir', dir]));
    assert.equal((await repo.listSeries(TENANT)).length, 3);
    process.exitCode = 0;
    await cli.runRevert(cli.parseArgs(['--revert', '--confirm', '--backup-dir', dir]));
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
    assert.equal((await repo.listSeries(TENANT)).length, 3);
  });

  test('--include-released --confirm backs up and deletes only the manifest series', async () => {
    await cli.runRevert(
      cli.parseArgs(['--revert', '--confirm', '--include-released', '--backup-dir', dir]),
    );
    const left = (await repo.listSeries(TENANT)).map((s) => s.id);
    assert.deepEqual(left, ['s-titans-not-in-manifest']);
    assert.ok(readdirSync(dir).some((f) => f.startsWith('titans-fixtures-backup-')));
  });
});

describe('--restore-clubs', () => {
  test('restores only the structure fields, version-pinned, and is idempotent', async () => {
    const pre = club({
      id: 'tuks-cricket-club',
      leagues: ['premier-league', 'third-league'],
      leagueTeams: { 'premier-league': 1, 'third-league': 1 },
      teamRosters: {},
      teams: 2,
      chair: 'Original Chair',
    });
    await repo.createClub(TENANT, pre);
    const backupFile = join(dir, 'clubs-before.json');
    writeFileSync(backupFile, JSON.stringify([await repo.getClub(TENANT, 'tuks-cricket-club')]));
    // what the import did afterwards: a 1 → 2 growth, a cup key, and an unrelated chair edit
    const cur = (await repo.getClub(TENANT, 'tuks-cricket-club'))!;
    await repo.updateClub(
      TENANT,
      'tuks-cricket-club',
      {
        version: cur.version,
        leagues: ['premier-league', 'third-league', 'mens-t20'],
        leagueTeams: { 'premier-league': 1, 'third-league': 2 },
        teamRosters: {
          'third-league': [
            { id: 'tm_tuks-cricket-club_third-league_0', name: 'TUKS 5' },
            { id: 'tm_tuks-cricket-club_third-league_1', name: 'TUKS 6' },
          ],
        },
        teams: 3,
        chair: 'New Chair',
      } as never,
      'test',
      new Date().toISOString(),
    );
    // dry run writes nothing
    await cli.runRestoreClubs(cli.parseArgs(['--restore-clubs', backupFile]));
    assert.equal((await repo.getClub(TENANT, 'tuks-cricket-club'))!.teams, 3);
    await cli.runRestoreClubs(cli.parseArgs(['--restore-clubs', backupFile, '--confirm']));
    const after1 = (await repo.getClub(TENANT, 'tuks-cricket-club'))!;
    assert.deepEqual(after1.leagues, ['premier-league', 'third-league']);
    assert.deepEqual(after1.leagueTeams, { 'premier-league': 1, 'third-league': 1 });
    assert.deepEqual(after1.teamRosters, {});
    assert.equal(after1.teams, 2);
    assert.equal((after1 as unknown as { chair: string }).chair, 'New Chair'); // not a structure field
    // idempotent
    const v = after1.version;
    await cli.runRestoreClubs(cli.parseArgs(['--restore-clubs', backupFile, '--confirm']));
    assert.equal((await repo.getClub(TENANT, 'tuks-cricket-club'))!.version, v);
  });
});
