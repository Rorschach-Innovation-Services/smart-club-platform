/**
 * Integration tests for the operator structure-intake routes (self-serve onboarding,
 * ADR 0009 follow-up):
 *   - POST /platform/tenants/:slug/structure-intake/parse — base64 transport, pre-decode
 *     size cap, manifest-free section scan (no league mapping, no club resolution)
 *   - POST /platform/tenants/:slug/structure-intake/commit — leagues-first fail-fast,
 *     server-generated `tm_…` ids, overwrite rule, fixture-reference guard, provenance
 *
 * Same harness as doc-intake.int.test.ts / roster-intake.int.test.ts: in-process dynalite
 * + the real Hono app via app.request(), auth via the LOCAL_AUTH x-dev-auth bypass, xlsx
 * fixtures built with exceljs in setup (base64-encoded for the parse route — no S3
 * involved in this transport).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import ExcelJS from 'exceljs';
import type { Club, League, RequiredDoc, Series } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
// Port distinct from every other *.int.test.ts (next free after roster-intake's 4617).
const DDB_PORT = 4619;
const TABLE = 'SmartClubStructureIntakeTest';
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

const devAuthAs = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const OPERATOR = devAuthAs('op-1', 'operator@platform', [
  { tenantId: '*', role: 'operator', clubIds: [] },
]);
const platformHeaders = (auth: string) => ({
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

const TENANT = 'structureintake';

const CATALOGUE: RequiredDoc[] = [
  { key: 'member-db', name: 'Member database', role: 'memberDatabase' },
];

const LEAGUES: League[] = [
  { key: 'premier-men', label: 'Premier Men', group: 'Senior', district: 'Test District' },
  { key: 'league-2', label: 'League 2', group: 'Senior', district: 'Test District' },
];

const baseClub = (id: string, extra?: Partial<Club>): Club =>
  ({
    id,
    name: id,
    district: 'Test District',
    sub: '',
    chair: 'Chair',
    affiliation: 'not_started',
    cqi: 0,
    docs: {},
    docMeta: {},
    players: 0,
    teams: 0,
    women: 0,
    juniors: 0,
    color: '#123456',
    ground: {},
    leagues: [],
    version: 1,
    ...extra,
  }) as Club;

let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let ddbServer: Server;

async function buildStructureWorkbookBase64(): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('SENIORS');
  ws.addRow(['PREMIER LEAGUE', 'VENUE']);
  ws.addRow(['TUKS 1', 'Tuks Oval']);
  ws.addRow(['TUKS 2', 'Tuks Oval']);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer).toString('base64');
}

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

  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');

  await repo.putTenantConfig({
    tenant: TENANT,
    branding: {
      name: 'Structure Intake Union',
      title: 'Structure Intake',
      logoUrl: '',
      colors: {},
      copy: {},
    },
    submissionDeadline: '2026-12-31',
    knownClubs: [],
    leagues: LEAGUES,
    districts: ['Test District'],
    requiredDocs: CATALOGUE,
  });

  await repo.createClub(TENANT, baseClub('clubvirgin'));
  await repo.createClub(TENANT, baseClub('clubexisting', { leagues: ['premier-men'] }));
  await repo.createClub(TENANT, baseClub('clubduplclub'));
  await repo.createClub(
    TENANT,
    baseClub('clubwithfixture', {
      leagues: ['premier-men'],
      leagueTeams: { 'premier-men': 2 },
      teamRosters: {
        'premier-men': [
          { id: 'tm_clubwithfixture_premier-men_1', name: 'Fixture Club 1' },
          { id: 'tm_clubwithfixture_premier-men_2', name: 'Fixture Club 2' },
        ],
      },
    }),
  );
  await repo.putSeries(TENANT, {
    id: 'series-1',
    name: 'Test Series',
    startDate: '2026-01-01',
    teams: ['tm_clubwithfixture_premier-men_1', 'tm_clubwithfixture_premier-men_2'],
    fixtures: [],
    released: false,
    releasedAt: null,
    version: 1,
  } as Series);
});

after(() => new Promise<void>((resolve) => ddbServer.close(() => resolve())));

describe('POST /platform/tenants/:slug/structure-intake/parse', () => {
  test('base64 cap is enforced on the STRING length BEFORE decoding', async () => {
    const oversized = 'A'.repeat(2 * 1024 * 1024 + 1);
    const res = await app.request(`/platform/tenants/${TENANT}/structure-intake/parse`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ filename: 'x.xlsx', dataBase64: oversized }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? '', /MB limit/);
  });

  test('missing dataBase64 → 400', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/structure-intake/parse`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ filename: 'x.xlsx' }),
    });
    assert.equal(res.status, 400);
  });

  test('unreadable workbook bytes → 400', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/structure-intake/parse`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        filename: 'x.xlsx',
        dataBase64: Buffer.from('not a real workbook').toString('base64'),
      }),
    });
    assert.equal(res.status, 400);
  });

  test('happy path: scans every sheet, returns bare sections (no league mapping, no club resolution)', async () => {
    const dataBase64 = await buildStructureWorkbookBase64();
    const res = await app.request(`/platform/tenants/${TENANT}/structure-intake/parse`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ filename: 'structure.xlsx', dataBase64 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      sections: Array<{
        header: string;
        sheet: string;
        rows: Array<{ raw: string; venue: string }>;
      }>;
      sheetsScanned: number;
      sheetsWithSections: number;
    };
    assert.equal(body.sheetsScanned, 1);
    assert.equal(body.sheetsWithSections, 1);
    assert.equal(body.sections.length, 1);
    assert.equal(body.sections[0].header, 'PREMIER LEAGUE');
    assert.equal(body.sections[0].sheet, 'SENIORS');
    assert.equal(body.sections[0].rows.length, 2);
    assert.equal(body.sections[0].rows[0].raw, 'TUKS 1');
    assert.equal(body.sections[0].rows[0].venue, 'Tuks Oval');
    // No league/club fields anywhere on the response — mapping is a later wizard step.
    assert.ok(!('league' in body.sections[0]));
    assert.ok(!('clubId' in body.sections[0].rows[0]));
  });

  test('404 for an unknown tenant', async () => {
    const dataBase64 = await buildStructureWorkbookBase64();
    const res = await app.request('/platform/tenants/noSuchTenant/structure-intake/parse', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ filename: 'x.xlsx', dataBase64 }),
    });
    assert.equal(res.status, 404);
  });
});

describe('POST /platform/tenants/:slug/structure-intake/commit', () => {
  test('league duplicate key → 409 BEFORE any club write', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/structure-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        newLeagues: [
          {
            key: 'premier-men',
            label: 'Premier Men (dup)',
            group: 'Senior',
            district: 'Test District',
          },
        ],
        clubs: [
          {
            clubId: 'clubvirgin',
            plan: { leagues: ['premier-men'], leagueTeams: { 'premier-men': 1 } },
          },
        ],
      }),
    });
    assert.equal(res.status, 409);
    const club = await repo.getClub(TENANT, 'clubvirgin');
    assert.equal(club?.leagues.length, 0, 'nothing was written — the leagues step failed fast');
  });

  test('duplicate clubId within one request → 400', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/structure-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        clubs: [
          { clubId: 'clubvirgin', plan: { leagues: ['premier-men'] } },
          { clubId: 'clubvirgin', plan: { leagues: ['premier-men'] } },
        ],
      }),
    });
    assert.equal(res.status, 400);
  });

  test('more than 100 clubs → 400', async () => {
    const clubs = Array.from({ length: 101 }, (_, i) => ({
      clubId: `club${i}`,
      plan: { leagues: [] },
    }));
    const res = await app.request(`/platform/tenants/${TENANT}/structure-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ clubs }),
    });
    assert.equal(res.status, 400);
  });

  test('happy path: new league appended, virgin club plan applied with server-generated tm_ ids', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/structure-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        newLeagues: [
          {
            key: 'womens-league',
            label: "Women's League",
            group: 'Women',
            district: 'Test District',
          },
        ],
        clubs: [
          {
            clubId: 'clubvirgin',
            plan: {
              leagues: ['premier-men', 'womens-league'],
              leagueTeams: { 'premier-men': 2, 'womens-league': 1 },
              teamRosters: {
                'premier-men': [
                  { name: 'Virgin CC 1st', venue: 'Ground A' },
                  { name: 'Virgin CC 2nd' },
                ],
              },
              firstTeamVenue: 'Ground A',
            },
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      batchId: string;
      leaguesAppended: string[];
      clubs: Array<{
        clubId: string;
        ok: boolean;
        teams?: number;
        women?: number;
        juniors?: number;
      }>;
    };
    assert.deepEqual(body.leaguesAppended, ['womens-league']);
    assert.match(body.batchId, new RegExp(`^intake:structure:${TENANT}:\\d{8}:operator@platform$`));
    assert.equal(body.clubs.length, 1);
    assert.equal(body.clubs[0].ok, true);
    assert.equal(body.clubs[0].teams, 3);
    assert.equal(body.clubs[0].women, 1);

    const cfg = await repo.getTenantConfig(TENANT);
    assert.ok(cfg?.leagues?.some((l) => l.key === 'womens-league'));

    const club = (await repo.getClub(TENANT, 'clubvirgin'))!;
    assert.deepEqual(club.leagues.sort(), ['premier-men', 'womens-league']);
    assert.equal(club.leagueTeams?.['premier-men'], 2);
    const roster = club.teamRosters?.['premier-men'] ?? [];
    assert.equal(roster.length, 2);
    assert.equal(roster[0].id, 'tm_clubvirgin_premier-men_1');
    assert.equal(roster[1].id, 'tm_clubvirgin_premier-men_2');
    assert.equal(roster[0].venue, 'Ground A');
    assert.equal(club.ground.venue, 'Ground A', 'ground.venue fill-absent from firstTeamVenue');

    const notes = (await repo.getClub(TENANT, 'clubvirgin'))?.notes ?? [];
    assert.ok(notes.some((n) => n.text.includes('intake:structure') && n.text.includes('applied')));
  });

  test('teamRosters length mismatch → per-club error, nothing written for that club', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/structure-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        clubs: [
          {
            clubId: 'clubduplclub',
            plan: {
              leagues: ['premier-men'],
              leagueTeams: { 'premier-men': 2 },
              teamRosters: { 'premier-men': [{ name: 'Only One' }] },
            },
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      clubs: Array<{ clubId: string; ok: boolean; error?: string }>;
    };
    assert.equal(body.clubs[0].ok, false);
    assert.match(body.clubs[0].error ?? '', /must list exactly 2 teams/);
    const club = await repo.getClub(TENANT, 'clubduplclub');
    assert.equal(club?.leagues.length, 0);
  });

  test('existing plan without overwrite → per-club 409 "confirm overwrite"', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/structure-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        clubs: [{ clubId: 'clubexisting', plan: { leagues: ['premier-men'] } }],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      clubs: Array<{ clubId: string; ok: boolean; error?: string }>;
    };
    assert.equal(body.clubs[0].ok, false);
    assert.match(body.clubs[0].error ?? '', /confirm overwrite/);
  });

  test('existing plan WITH overwrite → wholesale replace', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/structure-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        clubs: [
          {
            clubId: 'clubexisting',
            overwrite: true,
            plan: { leagues: ['league-2'], leagueTeams: { 'league-2': 1 } },
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { clubs: Array<{ clubId: string; ok: boolean }> };
    assert.equal(body.clubs[0].ok, true);
    const club = await repo.getClub(TENANT, 'clubexisting');
    assert.deepEqual(club?.leagues, ['league-2']);
  });

  test('overwrite blocked when the club’s current team ids are referenced by an existing fixture', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/structure-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        clubs: [
          {
            clubId: 'clubwithfixture',
            overwrite: true,
            plan: { leagues: ['premier-men'], leagueTeams: { 'premier-men': 1 } },
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      clubs: Array<{ clubId: string; ok: boolean; error?: string }>;
    };
    assert.equal(body.clubs[0].ok, false);
    assert.match(body.clubs[0].error ?? '', /referenced by existing fixtures/);
    // Untouched — the team ids the series references are still exactly as they were.
    const club = await repo.getClub(TENANT, 'clubwithfixture');
    assert.equal(club?.teamRosters?.['premier-men']?.length, 2);
  });

  test('per-club partial results: one bad club does not block the other in the same batch', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/structure-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        clubs: [
          { clubId: 'noSuchClub', plan: { leagues: ['premier-men'] } },
          {
            clubId: 'clubduplclub',
            plan: { leagues: ['premier-men'], leagueTeams: { 'premier-men': 1 } },
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { clubs: Array<{ clubId: string; ok: boolean }> };
    const bad = body.clubs.find((c) => c.clubId === 'noSuchClub')!;
    const good = body.clubs.find((c) => c.clubId === 'clubduplclub')!;
    assert.equal(bad.ok, false);
    assert.equal(good.ok, true);
  });

  test('404 for an unknown tenant', async () => {
    const res = await app.request('/platform/tenants/noSuchTenant/structure-intake/commit', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ clubs: [] }),
    });
    assert.equal(res.status, 404);
  });
});
