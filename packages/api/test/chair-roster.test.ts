/**
 * Integration tests for the chair spreadsheet upload (club portal):
 *   - POST /clubs/:id/roster/parse — multipart (and base64-JSON) xlsx → draft rows with the
 *     club forced to :id, strict identity, blank age group = senior, per-row conflict
 *     annotation (already on this roster / registered at another club), club scope.
 *   - POST /clubs/:id/roster/commit — ≤50-row chunks through the clearance-aware core:
 *     per-row outcomes (created / clearance-opened / skipped-duplicate / error), a clearance
 *     per moving row, idempotent re-commit (→ skipped-duplicate / clearance-already-open),
 *     playerCount reconciled, club scope, item clubId ignored.
 *
 * Same harness as chair-register.test.ts (dynalite + app.request + x-dev-auth).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import ExcelJS from 'exceljs';
import type { Club, League, PlayerRegistration } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4677; // unique: after chair-register (4675)
const TABLE = 'SmartClubChairRosterTest';
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

const TENANT = 'chairroster';
const devAuthAs = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const REP_HOME = devAuthAs('rep-home', 'chair@home.test', [
  { tenantId: TENANT, role: 'rep', clubIds: ['home'] },
]);
const REP_OTHER = devAuthAs('rep-other', 'chair@other.test', [
  { tenantId: TENANT, role: 'rep', clubIds: ['other'] },
]);
const authHeaders = (auth: string) => ({ 'x-tenant': TENANT, 'x-dev-auth': auth });

const LEAGUES: League[] = [
  { key: 'premier-men', label: 'Premier Men', group: 'Senior', district: 'Test District' },
  { key: 'u11', label: 'Under 11', group: 'Junior', district: 'Test District' },
];

const mkClub = (id: string, name: string): Club =>
  ({
    id,
    name,
    district: 'Test District',
    sub: '',
    chair: 'Chair',
    affiliation: 'not_started',
    cqi: 0,
    docs: {},
    players: 0,
    teams: 0,
    women: 0,
    juniors: 0,
    color: '#123456',
    ground: {},
    leagues: [],
    version: 1,
  }) as Club;

function validSaId(dobIso: string, seq = 0): string {
  const [y, m, d] = dobIso.split('-');
  const twelve = `${y.slice(2)}${m}${d}${String(seq).padStart(4, '0')}08`;
  let sum = 0;
  let alt = true;
  for (let i = twelve.length - 1; i >= 0; i--) {
    let digit = twelve.charCodeAt(i) - 48;
    if (alt) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alt = !alt;
  }
  return twelve + String((10 - (sum % 10)) % 10);
}

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let playerNaturalKey: (typeof import('../src/player-identity.js'))['playerNaturalKey'];

async function seedActive(clubId: string, idNumber: string, dob: string) {
  const p: PlayerRegistration = {
    naturalKey: playerNaturalKey({ idType: 'sa-id', idNumber }),
    clubId,
    firstName: 'Seeded',
    lastName: 'Player',
    dob,
    idType: 'sa-id',
    idNumber,
    isMinor: false,
    status: 'active',
    registeredVia: 'portal',
    version: 0,
    consentAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  await repo.createPlayer(TENANT, p);
}

// Identities used across the file.
const ID_NEW = validSaId('1996-01-01', 1); // brand new
const ID_OWN = validSaId('1995-02-02', 2); // already on home's roster
const ID_MOVING = validSaId('1994-03-03', 3); // active at "src"
const ID_JUNIOR = validSaId('2016-04-04', 4); // U11 junior
const BAD_CHECKSUM = `${ID_NEW.slice(0, 12)}${ID_NEW.slice(12) === '0' ? '1' : '0'}`;

async function workbookBytes(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Players');
  ws.addRow([
    'Player First Name',
    'Player Surname',
    'ID Number',
    'Date of Birth',
    'Gender',
    'Race',
    'Age Group',
  ]);
  ws.addRow(['Nandi', 'New', ID_NEW, '', 'F', 'African', '']); // row 2
  ws.addRow(['Owen', 'Own', ID_OWN, '', 'Male', 'White', '']); // row 3
  ws.addRow(['Mo', 'Mover', ID_MOVING, '', 'Male', 'Indian', '']); // row 4
  ws.addRow(['Jay', 'Junior', ID_JUNIOR, '', 'Male', 'Coloured', 'U11']); // row 5
  ws.addRow(['Bad', 'Checksum', BAD_CHECKSUM, '', 'Male', 'African', '']); // row 6
  ws.addRow(['Dob', 'Only', '', '1990-01-01', 'Male', 'African', '']); // row 7
  return Buffer.from(await wb.xlsx.writeBuffer());
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
  playerNaturalKey = (await import('../src/player-identity.js')).playerNaturalKey;

  await repo.putTenantConfig({
    tenant: TENANT,
    branding: { name: 'Chair Roster Union', title: 'CR', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-31',
    knownClubs: [],
    leagues: LEAGUES,
    districts: ['Test District'],
  });
  await repo.createClub(TENANT, mkClub('home', 'Home CC'));
  await repo.createClub(TENANT, mkClub('src', 'Source CC'));
  await repo.createClub(TENANT, mkClub('other', 'Other CC'));
  await seedActive('home', ID_OWN, '1995-02-02');
  await seedActive('src', ID_MOVING, '1994-03-03');
});

after(async () => {
  await new Promise<void>((resolve) => ddbServer.close(() => resolve()));
});

type ParsedRow = {
  rowNumber: number;
  firstName: string;
  lastName: string;
  dob: string;
  idNumber?: string;
  gender?: string;
  race?: string;
  team?: string;
  conflict?: {
    type: string;
    clubId?: string;
    clubName?: string;
    status?: string;
    message?: string;
    messageShort?: string;
  };
};
type ParseResponse = {
  parseable: boolean;
  sheets: Array<{
    name: string;
    skipped: boolean;
    rows: ParsedRow[];
    exceptions: Array<{ rowNumber: number; reason: string }>;
  }>;
  juniorLeagueKeys: string[];
};

const parseMultipart = async (auth = REP_HOME, club = 'home') => {
  const form = new FormData();
  form.append(
    'file',
    new Blob([await workbookBytes()], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    'roster.xlsx',
  );
  return app.request(`/clubs/${club}/roster/parse`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: form,
  });
};

describe('POST /clubs/:id/roster/parse', () => {
  test('parses the upload into draft rows with per-row conflict annotation', async () => {
    const res = await parseMultipart();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = (await res.json()) as ParseResponse;
    assert.equal(body.parseable, true);
    assert.deepEqual(body.juniorLeagueKeys, ['u11']);
    const sheet = body.sheets[0];
    const byRow = new Map(sheet.rows.map((r) => [r.rowNumber, r]));
    assert.deepEqual([...byRow.keys()], [2, 3, 4, 5]);

    assert.equal(byRow.get(2)?.conflict, undefined, 'a brand-new player has no conflict');
    assert.equal(byRow.get(2)?.gender, 'Female');
    assert.equal(byRow.get(2)?.team, undefined, 'blank age group = senior, team-less');
    assert.deepEqual(byRow.get(3)?.conflict, { type: 'in-club-duplicate' });
    assert.deepEqual(byRow.get(4)?.conflict, {
      type: 'cross-club',
      clubId: 'src',
      clubName: 'Source CC',
      status: 'active',
    });
    assert.equal(byRow.get(5)?.team, 'u11');

    const reasons = new Map(sheet.exceptions.map((e) => [e.rowNumber, e.reason]));
    assert.equal(reasons.get(6), 'bad-id-checksum');
    assert.equal(reasons.get(7), 'bad-id', 'strict identity: a dob-only row is an exception');

    // Parse writes nothing.
    assert.equal((await repo.listPlayers(TENANT, 'home')).length, 1);
  });

  test('a row whose ID sits under an older (legacy-key) record is flagged, not "new"', async () => {
    // The same ID as row 2, rostered at Source CC under a legacy slug key: the commit would
    // refuse it (existing-registration-under-legacy-key), so the review must say so up front.
    const legacyKey = 'nandi-new-1996-01-01';
    await repo.createPlayer(TENANT, {
      naturalKey: legacyKey,
      clubId: 'src',
      firstName: 'Nandi',
      lastName: 'New',
      dob: '1996-01-01',
      idType: 'sa-id',
      idNumber: ID_NEW,
      isMinor: false,
      status: 'active',
      version: 0,
      consentAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    } as PlayerRegistration);
    try {
      const body = (await (await parseMultipart()).json()) as ParseResponse;
      const row2 = body.sheets[0].rows.find((r) => r.rowNumber === 2);
      assert.deepEqual(row2?.conflict, {
        type: 'legacy-id',
        clubId: 'src',
        clubName: 'Source CC',
        message:
          'This ID is already registered at Source CC under an older record. Ask the union office to resolve the duplicate before registering this player.',
        messageShort: 'Already at Source CC under an older record — union office must resolve',
      });
      assert.ok(!JSON.stringify(body).includes(legacyKey), 'the legacy key is never returned');
    } finally {
      await repo.deletePlayer(TENANT, (await repo.getPlayer(TENANT, 'src', legacyKey))!);
    }
  });

  test('the base64-JSON transport is accepted too', async () => {
    const res = await app.request('/clubs/home/roster/parse', {
      method: 'POST',
      headers: { ...authHeaders(REP_HOME), 'content-type': 'application/json' },
      body: JSON.stringify({ dataBase64: (await workbookBytes()).toString('base64') }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as ParseResponse;
    assert.equal(body.sheets[0].rows.length, 4);
  });

  test('a rep cannot parse for a club outside their scope (403)', async () => {
    const res = await parseMultipart(REP_OTHER, 'home');
    assert.equal(res.status, 403);
  });

  test('no file / a non-workbook / a legacy .xls are 400s', async () => {
    const noFile = await app.request('/clubs/home/roster/parse', {
      method: 'POST',
      headers: authHeaders(REP_HOME),
      body: new FormData(),
    });
    assert.equal(noFile.status, 400);

    const junk = new FormData();
    junk.append('file', new Blob([Buffer.from('not a workbook')]), 'x.xlsx');
    const junkRes = await app.request('/clubs/home/roster/parse', {
      method: 'POST',
      headers: authHeaders(REP_HOME),
      body: junk,
    });
    assert.equal(junkRes.status, 400);

    const xls = new FormData();
    xls.append(
      'file',
      new Blob([
        Buffer.concat([
          Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
          Buffer.alloc(64),
        ]),
      ]),
      'old.xls',
    );
    const xlsRes = await app.request('/clubs/home/roster/parse', {
      method: 'POST',
      headers: authHeaders(REP_HOME),
      body: xls,
    });
    assert.equal(xlsRes.status, 400);
    assert.match(((await xlsRes.json()) as { error: string }).error ?? '', /legacy \.xls/);
  });
});

describe('POST /clubs/:id/roster/commit', () => {
  type CommitResponse = {
    results: Array<{
      index: number;
      rowNumber?: number;
      sheet?: string;
      outcome: string;
      fromClubName?: string;
      error?: string;
    }>;
    summary: Record<string, number>;
    playerCount: number;
  };
  const commit = (items: unknown[], auth = REP_HOME, club = 'home') =>
    app.request(`/clubs/${club}/roster/commit`, {
      method: 'POST',
      headers: { ...authHeaders(auth), 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    });

  const items = [
    {
      rowNumber: 2,
      sheet: 'Players',
      firstName: 'Nandi',
      lastName: 'New',
      dob: '1996-01-01',
      idNumber: ID_NEW,
      gender: 'Female',
      race: 'African',
    },
    {
      rowNumber: 3,
      sheet: 'Players',
      firstName: 'Owen',
      lastName: 'Own',
      dob: '1995-02-02',
      idNumber: ID_OWN,
    },
    {
      rowNumber: 4,
      sheet: 'Players',
      firstName: 'Mo',
      lastName: 'Mover',
      dob: '1994-03-03',
      idNumber: ID_MOVING,
    },
    // clubId of ANOTHER club is ignored — the row lands in :id
    {
      rowNumber: 5,
      sheet: 'Players',
      clubId: 'other',
      firstName: 'Jay',
      lastName: 'Junior',
      dob: '2016-04-04',
      idNumber: ID_JUNIOR,
      team: 'u11',
    },
    {
      rowNumber: 8,
      firstName: 'Wrong',
      lastName: 'Dob',
      dob: '1999-09-09',
      idNumber: validSaId('1997-07-07', 8),
    },
    { rowNumber: 9, firstName: 'No', lastName: 'Id', dob: '1990-01-01' },
  ];

  test('each row is registered through the core: create, skip, clearance, error', async () => {
    const res = await commit(items);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = (await res.json()) as CommitResponse;
    assert.deepEqual(
      body.results.map((r) => [r.rowNumber, r.outcome]),
      [
        [2, 'created'],
        [3, 'skipped-duplicate'],
        [4, 'clearance-opened'],
        [5, 'created'],
        [8, 'error'],
        [9, 'error'],
      ],
    );
    assert.equal(body.results[0].sheet, 'Players');
    assert.equal(body.results[2].fromClubName, 'Source CC');
    assert.match(body.results[4].error ?? '', /dob does not match the id number/);
    assert.match(body.results[5].error ?? '', /idNumber is required/);
    assert.deepEqual(body.summary, {
      created: 2,
      'clearance-opened': 1,
      'clearance-already-open': 0,
      'skipped-duplicate': 1,
      error: 2,
    });

    const home = await repo.listPlayers(TENANT, 'home');
    assert.equal(body.playerCount, home.length);
    assert.equal((await repo.getClub(TENANT, 'home'))?.playerCount, home.length);
    const junior = home.find((p) => p.idNumber === ID_JUNIOR);
    assert.equal(junior?.team, 'u11');
    assert.equal(junior?.registeredBy, 'chair@home.test');
    assert.equal(junior?.registeredVia, 'portal');
    assert.equal(home.find((p) => p.idNumber === ID_MOVING)?.status, 'clearance-pending');
    assert.equal((await repo.listPlayers(TENANT, 'other')).length, 0, 'other club untouched');

    const clr = (await repo.listClearancesForSource(TENANT, 'src')).filter(
      (x) => x.idNumber === ID_MOVING,
    );
    assert.equal(clr.length, 1, 'one clearance for the moving row');
    assert.equal(clr[0].toClubId, 'home');
    assert.equal(clr[0].origin, 'registration');
  });

  test('re-committing the same chunk is idempotent — never a 409, never a second clearance', async () => {
    const res = await commit(items);
    assert.equal(res.status, 200);
    const body = (await res.json()) as CommitResponse;
    assert.deepEqual(
      body.results.map((r) => r.outcome),
      [
        'skipped-duplicate',
        'skipped-duplicate',
        'clearance-already-open',
        'skipped-duplicate',
        'error',
        'error',
      ],
    );
    const clr = (await repo.listClearancesForSource(TENANT, 'src')).filter(
      (x) => x.idNumber === ID_MOVING,
    );
    assert.equal(clr.length, 1);
  });

  test('more than 50 items per chunk is a 400', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      rowNumber: i + 2,
      firstName: 'X',
      lastName: `Y${i}`,
      dob: '2003-01-01',
      idNumber: validSaId('2003-01-01', 200 + i),
    }));
    assert.equal((await commit(many)).status, 400);
    assert.equal((await commit([])).status, 400);
  });

  test('a rep cannot commit into a club outside their scope (403, nothing written)', async () => {
    const before = (await repo.listPlayers(TENANT, 'home')).length;
    const res = await commit(
      [
        {
          rowNumber: 2,
          firstName: 'S',
          lastName: 'T',
          dob: '2005-05-05',
          idNumber: validSaId('2005-05-05', 9),
        },
      ],
      REP_OTHER,
    );
    assert.equal(res.status, 403);
    assert.equal((await repo.listPlayers(TENANT, 'home')).length, before);
  });

  test('after commit, a re-parse annotates the committed rows as already on the roster', async () => {
    const res = await parseMultipart();
    const body = (await res.json()) as ParseResponse;
    const byRow = new Map(body.sheets[0].rows.map((r) => [r.rowNumber, r]));
    assert.deepEqual(byRow.get(2)?.conflict, { type: 'in-club-duplicate' });
    assert.deepEqual(byRow.get(4)?.conflict, { type: 'in-club-duplicate' });
  });
});
