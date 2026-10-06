/**
 * Integration tests for chair-led player registration (club portal):
 *   - POST /clubs/:id/players — the single in-portal form, now routed through the shared
 *     clearance-aware core (registerPlayerForClub): parity with the public self-registration's
 *     clearance / sourceless / directory / off-system paths, the 'portal' provenance stamp, and
 *     the chairman notice for a portal-opened clearance.
 *   - POST /clubs/:id/players/batch — the quick-add grid: per-row outcomes, relaxed required
 *     set, idempotent re-send, club scope.
 *
 * Same harness as roster-intake.int.test.ts: in-process dynalite + the real Hono app via
 * app.request(), auth via the LOCAL_AUTH x-dev-auth bypass. The notify module runs in dry-run
 * (no FROM_EMAIL / WhatsApp secrets), so clearance notices land as comm-log rows without network.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Club, League, PlayerRegistration } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4675; // unique: 4661–4673 are taken (sync-break-gate, puller, umpires, captains-reports, …)
const TABLE = 'SmartClubChairRegisterTest';
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

const TENANT = 'chairreg';
const OFF_TENANT = 'chairreg-off'; // clearances module switched off

const devAuthAs = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const REP_HOME = devAuthAs('rep-home', 'chair@home.test', [
  { tenantId: TENANT, role: 'rep', clubIds: ['home'] },
]);
const REP_OTHER = devAuthAs('rep-other', 'chair@other.test', [
  { tenantId: TENANT, role: 'rep', clubIds: ['other'] },
]);
const REP_OFF = devAuthAs('rep-off', 'chair@off.test', [
  { tenantId: OFF_TENANT, role: 'rep', clubIds: ['off-home'] },
]);
const headers = (auth: string, tenant = TENANT) => ({
  'x-tenant': tenant,
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

const LEAGUES: League[] = [
  { key: 'premier-men', label: 'Premier Men', group: 'Senior', district: 'Test District' },
  { key: 'u11', label: 'Under 11', group: 'Junior', district: 'Test District' },
];

const mkClub = (id: string, name: string, extra: Partial<Club> = {}): Club =>
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
    ...extra,
  }) as Club;

// ── Luhn-valid RSA ids; `seq` keeps ids distinct for the same dob ──
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

/** Seed an ACTIVE player row at `clubId` keyed exactly as a registration would key it. */
async function seedActive(tenant: string, clubId: string, idNumber: string, dob: string) {
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
  await repo.createPlayer(tenant, p);
  return p;
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

  const branding = {
    name: 'Chair Reg Union',
    title: 'Chair Reg',
    logoUrl: '',
    colors: {},
    copy: {},
  };
  await repo.putTenantConfig({
    tenant: TENANT,
    branding,
    submissionDeadline: '2026-12-31',
    knownClubs: [{ id: 'old-club', name: 'Old Club' }],
    leagues: LEAGUES,
    districts: ['Test District'],
  });
  await repo.putTenantConfig({
    tenant: OFF_TENANT,
    branding,
    submissionDeadline: '2026-12-31',
    knownClubs: [],
    leagues: LEAGUES,
    districts: ['Test District'],
    features: { 'module.clearances': false },
  });
  await repo.createClub(TENANT, mkClub('home', 'Home CC'));
  await repo.createClub(
    TENANT,
    mkClub('src', 'Source CC', {
      exco: { chair: { name: 'Sipho', email: 'chair@src.test', cell: '083 555 0000' } },
    } as Partial<Club>),
  );
  await repo.createClub(TENANT, mkClub('other', 'Other CC'));
  await repo.createClub(OFF_TENANT, mkClub('off-home', 'Off Home CC'));
  await repo.createClub(OFF_TENANT, mkClub('off-src', 'Off Source CC'));
});

after(async () => {
  await new Promise<void>((resolve) => ddbServer.close(() => resolve()));
});

/** The single form's full required set (unchanged by the reroute). */
const fullBody = (extra: Record<string, unknown> = {}) => ({
  firstName: 'Lwazi',
  lastName: 'Dube',
  race: 'African',
  gender: 'Male',
  nationality: 'South African',
  cell: '0821234567',
  team: 'premier-men',
  district: 'Test District',
  ...extra,
});

const registerSingle = (body: Record<string, unknown>, auth = REP_HOME, club = 'home') =>
  app.request(`/clubs/${club}/players`, {
    method: 'POST',
    headers: headers(auth),
    body: JSON.stringify(body),
  });

type SingleResponse = PlayerRegistration & {
  outcome: string;
  clearance?: { id: string; fromClubId: string; fromClubName: string };
};

describe('POST /clubs/:id/players — single registration through the shared core', () => {
  test('a first registration lands active, stamped portal + the registering chair', async () => {
    const res = await registerSingle(fullBody({ idNumber: validSaId('1995-04-04', 1) }));
    assert.equal(res.status, 201);
    const body = (await res.json()) as SingleResponse;
    assert.equal(body.outcome, 'created');
    assert.equal(body.status, 'active');
    assert.equal(body.registeredVia, 'portal');
    assert.equal(body.registeredBy, 'chair@home.test');
    assert.equal(body.dob, '1995-04-04');
    assert.equal(body.clearance, undefined);
  });

  test('a player active at another club opens a clearance FROM that club (+ chairman notice)', async () => {
    const idNumber = validSaId('1994-02-02', 2);
    await seedActive(TENANT, 'src', idNumber, '1994-02-02');
    const res = await registerSingle(fullBody({ idNumber }));
    assert.equal(res.status, 201);
    const body = (await res.json()) as SingleResponse;
    assert.equal(body.outcome, 'clearance-opened');
    assert.equal(body.status, 'clearance-pending');
    assert.equal(body.lastClub, 'Source CC');
    assert.equal(body.clearance?.fromClubId, 'src');
    assert.equal(body.clearance?.fromClubName, 'Source CC');

    const srcRow = (await repo.listPlayers(TENANT, 'src')).find((p) => p.idNumber === idNumber);
    assert.equal(srcRow?.status, 'clearance-pending', 'source row flipped pending');
    const clr = (await repo.listClearancesForSource(TENANT, 'src')).find(
      (x) => x.idNumber === idNumber,
    );
    assert.equal(clr?.origin, 'registration');
    assert.equal(clr?.toClubId, 'home');
    assert.match(clr?.note ?? '', /Auto-routed to Source CC/);

    const src = await repo.getClub(TENANT, 'src');
    const notice = (src?.commLog ?? []).find(
      (e) => e.kind === 'clearance' && e.channel === 'email' && e.idempotencyKey?.includes(clr!.id),
    );
    assert.ok(notice, 'the source chairman was notified, as for self-registration');
    assert.equal(notice?.by, 'chair@home.test', 'attributed to the registering chair');
  });

  test('registering the same mid-transfer identity again is a 409 (no second clearance)', async () => {
    const idNumber = validSaId('1994-02-02', 2);
    const res = await registerSingle(fullBody({ idNumber }));
    assert.equal(res.status, 409);
    const clrs = (await repo.listClearancesForSource(TENANT, 'src')).filter(
      (x) => x.idNumber === idNumber,
    );
    assert.equal(clrs.length, 1);
  });

  test('a declared on-system previous club with no roster record opens a sourceless clearance', async () => {
    const idNumber = validSaId('1993-03-03', 3);
    const res = await registerSingle(fullBody({ idNumber, lastClubId: 'src' }));
    assert.equal(res.status, 201);
    const body = (await res.json()) as SingleResponse;
    assert.equal(body.outcome, 'clearance-opened');
    assert.equal(body.status, 'clearance-pending');
    const clr = (await repo.listClearancesForSource(TENANT, 'src')).find(
      (x) => x.idNumber === idNumber,
    );
    assert.match(clr?.note ?? '', /has no roster record of this player/);
    assert.equal(clr?.fromClubDirectory, undefined);
  });

  test('an exact on-system name typed as the previous club takes the same clearance path', async () => {
    const idNumber = validSaId('1992-05-05', 4);
    const res = await registerSingle(fullBody({ idNumber, lastClub: '  source cc ' }));
    assert.equal(res.status, 201);
    const body = (await res.json()) as SingleResponse;
    assert.equal(body.outcome, 'clearance-opened');
    assert.equal(body.clearance?.fromClubId, 'src');
  });

  test('a directory (not-yet-on-system) previous club opens a directory-flagged clearance', async () => {
    const idNumber = validSaId('1991-06-06', 5);
    const res = await registerSingle(fullBody({ idNumber, lastClubId: 'old-club' }));
    assert.equal(res.status, 201);
    const body = (await res.json()) as SingleResponse;
    assert.equal(body.outcome, 'clearance-opened');
    assert.equal(body.clearance?.fromClubName, 'Old Club');
    const clr = (await repo.listClearancesForSource(TENANT, 'old-club')).find(
      (x) => x.idNumber === idNumber,
    );
    assert.equal(clr?.fromClubDirectory, true);
  });

  test('an unknown previous club id is a 400 (nothing written)', async () => {
    const idNumber = validSaId('1990-07-07', 6);
    const res = await registerSingle(fullBody({ idNumber, lastClubId: 'no-such-club' }));
    assert.equal(res.status, 400);
    const rows = await repo.listPlayers(TENANT, 'home');
    assert.ok(!rows.some((p) => p.idNumber === idNumber));
  });

  test('a free-text off-system previous club lands active and raises a registration review', async () => {
    const idNumber = validSaId('1989-08-08', 7);
    const res = await registerSingle(fullBody({ idNumber, lastClub: 'Faraway Ramblers' }));
    assert.equal(res.status, 201);
    const body = (await res.json()) as SingleResponse;
    assert.equal(body.outcome, 'review-opened');
    assert.equal(body.status, 'active');
    const review = (await repo.listReviewsForClub(TENANT, 'home')).find(
      (r) => r.playerNaturalKey === body.naturalKey,
    );
    assert.equal(review?.kind, 'off-system-alert');
    assert.equal(review?.typedPreviousClub, 'Faraway Ramblers');
    assert.equal(review?.linkClubId, 'home', 'the portal club is recorded as the link club');
  });

  test('the full Union required set still applies to the single form', async () => {
    const res = await registerSingle({
      firstName: 'No',
      lastName: 'Cell',
      idNumber: validSaId('1988-09-09', 8),
    });
    assert.equal(res.status, 400);
  });

  test('a rep cannot register into a club outside their scope (403)', async () => {
    const res = await registerSingle(fullBody({ idNumber: validSaId('1987-10-10', 9) }), REP_OTHER);
    assert.equal(res.status, 403);
  });

  test('with the clearances module off, a player active elsewhere lands active with a note', async () => {
    const idNumber = validSaId('1986-11-11', 10);
    await seedActive(OFF_TENANT, 'off-src', idNumber, '1986-11-11');
    const res = await app.request('/clubs/off-home/players', {
      method: 'POST',
      headers: headers(REP_OFF, OFF_TENANT),
      body: JSON.stringify(fullBody({ idNumber })),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as SingleResponse;
    assert.equal(body.outcome, 'created');
    assert.equal(body.status, 'active');
    assert.match(body.transferNote ?? '', /Previously registered at Off Source CC/);
    const src = (await repo.listPlayers(OFF_TENANT, 'off-src')).find(
      (p) => p.idNumber === idNumber,
    );
    assert.equal(src?.status, 'active', 'the other club is never touched');
  });
});

describe('POST /register/:clubId — public self-registration parity (link stamp unchanged)', () => {
  test('the public route still opens the clearance and stamps registeredVia link', async () => {
    await repo.putToken('chairreg-tok', TENANT, 'other', '2026-06-01T00:00:00.000Z');
    const idNumber = validSaId('1985-12-12', 11);
    await seedActive(TENANT, 'src', idNumber, '1985-12-12');
    const res = await app.request(`/register/other?t=chairreg-tok`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        fullBody({
          idNumber,
          idDocMeta: {
            objectKey: `${TENANT}/other/reg-x.png`,
            size: 100,
            contentType: 'image/png',
          },
        }),
      ),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true, clearance: { fromClubName: 'Source CC' } });
    const row = (await repo.listPlayers(TENANT, 'other')).find((p) => p.idNumber === idNumber);
    assert.equal(row?.status, 'clearance-pending');
    assert.equal(row?.registeredVia, 'link');
    assert.equal(row?.registeredBy, undefined, 'the public link stamps no registering user');
  });
});

describe('POST /clubs/:id/players/batch — quick-add grid', () => {
  const batch = (rows: unknown[], auth = REP_HOME, club = 'home') =>
    app.request(`/clubs/${club}/players/batch`, {
      method: 'POST',
      headers: headers(auth),
      body: JSON.stringify({ rows }),
    });
  type BatchResponse = {
    results: Array<{ index: number; outcome: string; fromClubName?: string; error?: string }>;
    summary: Record<string, number>;
    playerCount: number;
  };

  const newId = validSaId('2001-01-01', 20);
  const movingId = validSaId('2000-02-02', 21);
  let rows: unknown[];

  before(async () => {
    await seedActive(TENANT, 'src', movingId, '2000-02-02');
    rows = [
      // relaxed contract: no cell / nationality / district / race / team
      { firstName: 'Quick', lastName: 'Add', idNumber: newId, gender: 'M' },
      { firstName: 'Moving', lastName: 'Player', idNumber: movingId, team: 'premier-men' },
      { firstName: 'Bad', lastName: 'Id', idNumber: '1234567890123' },
      { firstName: 'Quick', lastName: 'Again', idNumber: newId }, // same identity as row 0
      {
        firstName: 'Pass',
        lastName: 'Port',
        idType: 'passport',
        idNumber: 'ZP1',
        dob: '1999-01-01',
      },
      { firstName: 'Bad', lastName: 'Team', idNumber: validSaId('2002-03-03', 22), team: 'nope' },
    ];
  });

  test('each row gets its own outcome; one bad row never aborts the batch', async () => {
    const res = await batch(rows);
    assert.equal(res.status, 200);
    const body = (await res.json()) as BatchResponse;
    assert.deepEqual(
      body.results.map((r) => r.outcome),
      ['created', 'clearance-opened', 'error', 'skipped-duplicate', 'error', 'error'],
    );
    assert.equal(body.results[1].fromClubName, 'Source CC');
    assert.match(body.results[2].error ?? '', /not a valid RSA ID/);
    assert.match(body.results[4].error ?? '', /nationality is required/);
    assert.match(body.results[5].error ?? '', /unknown team/);
    assert.equal(body.summary.created, 1);
    assert.equal(body.summary['clearance-opened'], 1);
    assert.equal(body.summary.error, 3);
    assert.equal(body.playerCount, (await repo.listPlayers(TENANT, 'home')).length);
    assert.equal((await repo.getClub(TENANT, 'home'))?.playerCount, body.playerCount);

    const created = (await repo.listPlayers(TENANT, 'home')).find((p) => p.idNumber === newId);
    assert.equal(created?.gender, 'Male', 'gender normalised');
    assert.equal(created?.registeredVia, 'portal');
    assert.equal(created?.registeredBy, 'chair@home.test');
    const clr = (await repo.listClearancesForSource(TENANT, 'src')).find(
      (x) => x.idNumber === movingId,
    );
    assert.equal(clr?.toClubId, 'home');
  });

  test('re-sending the same rows is idempotent', async () => {
    const res = await batch(rows);
    assert.equal(res.status, 200);
    const body = (await res.json()) as BatchResponse;
    assert.deepEqual(
      body.results.map((r) => r.outcome),
      [
        'skipped-duplicate',
        'clearance-already-open',
        'error',
        'skipped-duplicate',
        'error',
        'error',
      ],
    );
    const clrs = (await repo.listClearancesForSource(TENANT, 'src')).filter(
      (x) => x.idNumber === movingId,
    );
    assert.equal(clrs.length, 1, 'no second clearance');
  });

  test('a passport row with nationality + dob is accepted', async () => {
    const res = await batch([
      {
        firstName: 'Tendai',
        lastName: 'Moyo',
        idType: 'passport',
        idNumber: ' zw123 ',
        nationality: 'Zimbabwean',
        dob: '1998-04-04',
      },
    ]);
    const body = (await res.json()) as BatchResponse;
    assert.equal(body.results[0].outcome, 'created');
    const row = (await repo.listPlayers(TENANT, 'home')).find((p) => p.idNumber === 'ZW123');
    assert.equal(row?.dob, '1998-04-04');
  });

  test('more than 25 rows, or no rows, is a 400', async () => {
    const many = Array.from({ length: 26 }, (_, i) => ({
      firstName: 'X',
      lastName: `Y${i}`,
      idNumber: validSaId('2003-01-01', 100 + i),
    }));
    assert.equal((await batch(many)).status, 400);
    assert.equal((await batch([])).status, 400);
  });

  test('a rep cannot batch-register into a club outside their scope (403, nothing written)', async () => {
    const before = (await repo.listPlayers(TENANT, 'home')).length;
    const res = await batch(
      [{ firstName: 'Sneaky', lastName: 'Add', idNumber: validSaId('2004-04-04', 30) }],
      REP_OTHER,
    );
    assert.equal(res.status, 403);
    assert.equal((await repo.listPlayers(TENANT, 'home')).length, before);
  });
});
