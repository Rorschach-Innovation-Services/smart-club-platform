/**
 * Integration tests for the operator roster-intake routes (self-serve onboarding, ADR
 * 0009 follow-up):
 *   - POST /platform/tenants/:slug/roster-intake/parse — role-resolved doc key, stored-
 *     file/size/content-type gates, per-sheet parse results, junior age-band mapping
 *   - POST /platform/tenants/:slug/roster-intake/commit — ALL-before-ANY-write
 *     validation, cross-club conflict exclusion, idempotent re-commit, provenance
 *
 * Plus a parity test: the shared-fixtures/cross-club-duplicates.json fixture run through
 * findCrossClubDuplicates must produce exactly `expectedConflictGroups` — the frontend's
 * roster-review.ts hand-port asserts the same fixture, so a divergence between the two
 * fails one of the two suites.
 *
 * Same harness as doc-intake.int.test.ts: in-process dynalite + the real Hono app via
 * app.request(), auth via the LOCAL_AUTH x-dev-auth bypass, and the readUploadObject
 * `local/` + LOCAL_UPLOADS_DIR offline seam (no real S3) for the stored "member
 * database" xlsx fixtures, built with exceljs in setup.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { Club, League, RequiredDoc } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
// Port distinct from every other *.int.test.ts (see doc-intake.int.test.ts's registry;
// next free after 4615 is 4617).
const DDB_PORT = 4617;
const TABLE = 'SmartClubRosterIntakeTest';
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

const TENANT = 'rosterintake';
const NOROLE_TENANT = 'rosterintake-norole';

const CATALOGUE: RequiredDoc[] = [
  { key: 'member-db', name: 'Member database', role: 'memberDatabase' },
  { key: 'committee-list', name: 'Committee list', role: 'committee' },
];
const NOROLE_CATALOGUE: RequiredDoc[] = [{ key: 'member-db', name: 'Member database' }];

const LEAGUES: League[] = [
  { key: 'premier-men', label: 'Premier Men', group: 'Senior', district: 'Test District' },
  { key: 'u9', label: 'Under 9', group: 'Junior', district: 'Test District' },
  { key: 'u11', label: 'Under 11', group: 'Junior', district: 'Test District' },
];

const baseClub = (id: string, docMeta?: Record<string, unknown>): Club =>
  ({
    id,
    name: id,
    district: 'Test District',
    sub: '',
    chair: 'Chair',
    affiliation: 'not_started',
    cqi: 0,
    docs: {},
    docMeta: docMeta ?? {},
    players: 0,
    teams: 0,
    women: 0,
    juniors: 0,
    color: '#123456',
    ground: {},
    leagues: [],
    version: 1,
  }) as Club;

// ── Luhn-valid RSA id generation, matching dobFromSaId's own algorithm ──
function luhnCheckDigit(twelve: string): string {
  let sum = 0;
  let alt = true; // rightmost of the 12 doubles first (adjacent to the check digit)
  for (let i = twelve.length - 1; i >= 0; i--) {
    let d = twelve.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return String((10 - (sum % 10)) % 10);
}
function validSaId(dobIso: string): string {
  const [y, m, d] = dobIso.split('-');
  const twelve = `${y.slice(2)}${m}${d}000008`;
  return twelve + luhnCheckDigit(twelve);
}

let uploadsDir: string;
let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');

async function writeXlsx(
  relPath: string,
  build: (wb: ExcelJS.Workbook) => void,
): Promise<{ objectKey: string; size: number }> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  const abs = path.join(uploadsDir, relPath);
  const { mkdir, stat } = await import('node:fs/promises');
  await mkdir(path.dirname(abs), { recursive: true });
  await wb.xlsx.writeFile(abs);
  const { size } = await stat(abs);
  return { objectKey: `local/${relPath}`, size };
}

before(async () => {
  uploadsDir = await mkdtemp(path.join(tmpdir(), 'roster-intake-test-'));
  process.env.LOCAL_UPLOADS_DIR = uploadsDir;

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
      name: 'Roster Intake Union',
      title: 'Roster Intake',
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
  await repo.putTenantConfig({
    tenant: NOROLE_TENANT,
    branding: { name: 'No Role Union', title: 'No Role', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-31',
    knownClubs: [],
    leagues: [],
    districts: ['Test District'],
    requiredDocs: NOROLE_CATALOGUE,
  });

  // ── Fixture xlsx files ──
  const idAlice = validSaId('1998-03-14');
  const idBob = validSaId('2000-05-20');
  const badChecksumId = `${idAlice.slice(0, 12)}${idAlice.slice(12) === '0' ? '1' : '0'}`; // flip the check digit

  const seniorFile = await writeXlsx('senior/roster.xlsx', (wb) => {
    const ws = wb.addWorksheet('Seniors');
    ws.addRow(['First Name', 'Last Name', 'ID Number', 'Gender', 'Race']);
    ws.addRow(['Alice', 'Alpha', idAlice, 'Female', 'African']);
    ws.addRow(['Bob', 'Beta', idBob, 'Male', 'White']);
    ws.addRow(['Bad', 'Checksum', badChecksumId, 'Male', 'African']);
  });
  const dobVariantFile = await writeXlsx('dob/roster.xlsx', (wb) => {
    const ws = wb.addWorksheet('Seniors');
    ws.addRow(['First Name', 'Last Name', 'Date of Birth', 'Gender']);
    ws.addRow(['Dana', 'Dobonly', '1995-06-01', 'Female']);
    ws.addRow(['Eli', 'Dobonly', '1996-07-02', 'Male']);
  });
  const juniorFile = await writeXlsx('junior/roster.xlsx', (wb) => {
    const ws = wb.addWorksheet('Juniors');
    ws.addRow(['First Name', 'Last Name', 'Date of Birth', 'Age Group']);
    ws.addRow(['Jay', 'Junior', '2016-01-01', 'U9']);
    ws.addRow(['Kay', 'Junior', '2008-01-01', 'U17']); // no U17 league on this tenant — unmapped
  });
  const pdfFile = { objectKey: 'local/notreal.pdf', size: 100 };

  // Legacy BIFF (.xls) magic bytes — real bytes on disk (the route reads them, not just
  // the declared contentType) so isLegacyXlsBuffer's sniff actually fires.
  const legacyXlsBytes = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(64),
  ]);
  const legacyXlsRel = 'legacy/roster.xls';
  await mkdir(path.join(uploadsDir, 'legacy'), { recursive: true });
  await writeFile(path.join(uploadsDir, legacyXlsRel), legacyXlsBytes);
  const legacyXlsFile = { objectKey: `local/${legacyXlsRel}`, size: legacyXlsBytes.length };

  // A real CSV — looksLikeSpreadsheet accepts it (it's in the roster mime/extension
  // set) but exceljs's `xlsx.load` can't read it; the route must name the real reason.
  const csvBytes = Buffer.from('First Name,Last Name,ID Number\nCsv,Row,000\n');
  const csvRel = 'csv/roster.csv';
  await mkdir(path.join(uploadsDir, 'csv'), { recursive: true });
  await writeFile(path.join(uploadsDir, csvRel), csvBytes);
  const csvFile = { objectKey: `local/${csvRel}`, size: csvBytes.length };

  await repo.createClub(
    TENANT,
    baseClub('clubalpha', {
      'member-db': {
        objectKey: seniorFile.objectKey,
        size: seniorFile.size,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    }),
  );
  await repo.createClub(
    TENANT,
    baseClub('clubdob', {
      'member-db': {
        objectKey: dobVariantFile.objectKey,
        size: dobVariantFile.size,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    }),
  );
  await repo.createClub(
    TENANT,
    baseClub('clubjunior', {
      'member-db': {
        objectKey: juniorFile.objectKey,
        size: juniorFile.size,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    }),
  );
  await repo.createClub(TENANT, baseClub('clubnofile'));
  await repo.createClub(
    TENANT,
    baseClub('cluboversize', {
      'member-db': {
        objectKey: 'local/does-not-matter.xlsx',
        size: 999_999_999,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    }),
  );
  await repo.createClub(
    TENANT,
    baseClub('clubpdf', {
      'member-db': {
        objectKey: pdfFile.objectKey,
        size: pdfFile.size,
        contentType: 'application/pdf',
      },
    }),
  );
  await repo.createClub(
    TENANT,
    baseClub('clublegacyxls', {
      'member-db': {
        objectKey: legacyXlsFile.objectKey,
        size: legacyXlsFile.size,
        contentType: 'application/vnd.ms-excel',
      },
    }),
  );
  await repo.createClub(
    TENANT,
    baseClub('clubcsv', {
      'member-db': {
        objectKey: csvFile.objectKey,
        size: csvFile.size,
        contentType: 'text/csv',
      },
    }),
  );
  await repo.createClub(TENANT, baseClub('clubcommit'));
  await repo.createClub(TENANT, baseClub('clubcommitb'));
  await repo.createClub(TENANT, baseClub('clubdobvalid'));
  await repo.createClub(NOROLE_TENANT, baseClub('clubnorole'));

  (global as unknown as { __fixtureIds: Record<string, string> }).__fixtureIds = {
    idAlice,
    idBob,
    badChecksumId,
  };
});

after(async () => {
  await new Promise<void>((resolve) => ddbServer.close(() => resolve()));
  await rm(uploadsDir, { recursive: true, force: true });
});

const ids = () => (global as unknown as { __fixtureIds: Record<string, string> }).__fixtureIds;

describe('POST /platform/tenants/:slug/roster-intake/parse', () => {
  test('role-unassigned catalogue → 409 with role-assignment guidance', async () => {
    const res = await app.request(`/platform/tenants/${NOROLE_TENANT}/roster-intake/parse`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ clubId: 'clubnorole' }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? '', /assign the role in Required documents/);
  });

  test('club with no stored file → 409', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/parse`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ clubId: 'clubnofile' }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? '', /upload it via document intake first/);
  });

  test('oversized stored file → 400 BEFORE any read is attempted', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/parse`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ clubId: 'cluboversize' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? '', /MB parse limit/);
  });

  test('non-spreadsheet content type → 200 {parseable:false}', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/parse`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ clubId: 'clubpdf' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = (await res.json()) as { parseable: boolean; reason: string };
    assert.equal(body.parseable, false);
    assert.match(body.reason, /scan or PDF/);
  });

  test('404 for an unknown tenant / unknown club', async () => {
    const noTenant = await app.request(`/platform/tenants/noSuchTenant/roster-intake/parse`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ clubId: 'clubalpha' }),
    });
    assert.equal(noTenant.status, 404);
    const noClub = await app.request(`/platform/tenants/${TENANT}/roster-intake/parse`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ clubId: 'noSuchClub' }),
    });
    assert.equal(noClub.status, 404);
  });

  test('legacy .xls bytes (BIFF magic) → 200 {parseable:false} with an actionable reason', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/parse`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ clubId: 'clublegacyxls' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { parseable: boolean; reason: string };
    assert.equal(body.parseable, false);
    assert.match(body.reason, /legacy \.xls workbook — save it as \.xlsx/);
  });

  test('a stored CSV → 200 {parseable:false} with a CSV-specific reason', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/parse`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ clubId: 'clubcsv' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { parseable: boolean; reason: string };
    assert.equal(body.parseable, false);
    assert.match(body.reason, /^CSV file/);
  });

  test('senior sheet parses with a bad-checksum exception, valid rows, and no-store header', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/parse`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ clubId: 'clubalpha' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = (await res.json()) as {
      parseable: boolean;
      sheets: Array<{
        name: string;
        hasIdColumn: boolean;
        totalDataRows: number;
        rows: Array<{ rowNumber: number; firstName: string; idNumber?: string }>;
        exceptions: Array<{ reason: string; maskedId?: string }>;
      }>;
      juniorLeagueKeys: string[];
      dobOnlyCount: number;
      ageGroupRaws: Array<{ raw: string; leagueKey: string | null }>;
    };
    assert.equal(body.parseable, true, 'parseable:true discriminant present on a real parse');
    assert.deepEqual(body.juniorLeagueKeys.sort(), ['u11', 'u9']);
    assert.equal(body.dobOnlyCount, 0, 'top-level total — this club has no dob-only rows');
    const sheet = body.sheets[0];
    assert.equal(sheet.hasIdColumn, true);
    assert.equal(sheet.totalDataRows, 3);
    assert.equal(sheet.rows.length, 2, 'the bad-checksum row is excluded from rows');
    assert.ok(sheet.rows.every((r) => typeof r.rowNumber === 'number'));
    assert.equal(sheet.exceptions.length, 1);
    assert.equal(sheet.exceptions[0].reason, 'bad-id-checksum');
    assert.ok(sheet.exceptions[0].maskedId, 'exception id is masked, never raw');
    assert.ok(!/\d/.test(sheet.exceptions[0].maskedId!), 'masked id carries no real digits');
  });

  test('DOB-variant club: allowMissingId=false excludes dob-only rows as bad-id exceptions', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/parse`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ clubId: 'clubdob', allowMissingId: false }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      sheets: Array<{
        hasIdColumn: boolean;
        rows: unknown[];
        exceptions: Array<{ reason: string }>;
      }>;
      dobOnlyCount: number;
    };
    const sheet = body.sheets[0];
    assert.equal(sheet.hasIdColumn, false, 'DOB-variant template pill signal');
    assert.equal(sheet.rows.length, 0);
    assert.equal(sheet.exceptions.length, 2);
    assert.ok(sheet.exceptions.every((e) => e.reason === 'bad-id'));
    assert.equal(body.dobOnlyCount, 0, 'top-level total — excluded rows never count as dob-only');
  });

  test('DOB-variant club: allowMissingId=true includes the same rows as missingId dob-only', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/parse`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ clubId: 'clubdob', allowMissingId: true }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      sheets: Array<{
        rows: Array<{ missingId: boolean; idNumber?: string }>;
        exceptions: unknown[];
      }>;
      dobOnlyCount: number;
    };
    const sheet = body.sheets[0];
    assert.equal(sheet.rows.length, 2);
    assert.ok(sheet.rows.every((r) => r.missingId === true && r.idNumber === undefined));
    assert.equal(sheet.exceptions.length, 0);
    assert.equal(body.dobOnlyCount, 2, 'top-level total across sheets');
  });

  test('junior club: an unmapped age band becomes an exception, a mapped one carries through as team', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/parse`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ clubId: 'clubjunior', allowMissingId: true }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      sheets: Array<{
        rows: Array<{ team?: string; firstName: string }>;
        exceptions: Array<{ reason: string }>;
      }>;
      ageGroupRaws: Array<{ raw: string; leagueKey: string | null }>;
    };
    const sheet = body.sheets[0];
    assert.equal(sheet.rows.length, 1);
    assert.equal(sheet.rows[0].team, 'u9');
    assert.equal(sheet.exceptions.length, 1);
    assert.equal(sheet.exceptions[0].reason, 'unmapped-age-group');
    const raws = Object.fromEntries(body.ageGroupRaws.map((a) => [a.raw, a.leagueKey]));
    assert.equal(raws['U9'], 'u9');
    assert.equal(raws['U17'], null);
  });
});

describe('POST /platform/tenants/:slug/roster-intake/commit', () => {
  test('a slash-separated dob → 400, never silently reinterpreted', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          { clubId: 'clubcommit', rowNumber: 1, firstName: 'A', lastName: 'B', dob: '3/4/2020' },
        ],
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? '', /dob must be a valid ISO date/);
  });

  test('an out-of-range calendar date (2020-02-31) → 400, never silently rolled to March', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          {
            clubId: 'clubcommit',
            rowNumber: 1,
            firstName: 'A',
            lastName: 'B',
            dob: '2020-02-31',
          },
        ],
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? '', /dob must be a valid ISO date/);
  });

  test('a real strict-ISO calendar date is accepted', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          {
            clubId: 'clubdobvalid',
            rowNumber: 99,
            firstName: 'Valid',
            lastName: 'Dob',
            dob: '2000-02-29', // a real leap day — must NOT be rejected as out-of-range
          },
        ],
      }),
    });
    assert.equal(res.status, 200, await res.text());
  });

  test('dob does not match the id-derived dob → 400, nothing written', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          {
            clubId: 'clubcommit',
            rowNumber: 1,
            firstName: 'Wrong',
            lastName: 'Dob',
            dob: '2001-01-01',
            idNumber: ids().idAlice,
          },
        ],
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? '', /dob does not match the id number/);
  });

  test('unrecognised gender → 400; unknown league key → 400', async () => {
    const badGender = await app.request(`/platform/tenants/${TENANT}/roster-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          {
            clubId: 'clubcommit',
            rowNumber: 1,
            firstName: 'A',
            lastName: 'B',
            dob: '2000-01-01',
            gender: 'Alien',
          },
        ],
      }),
    });
    assert.equal(badGender.status, 400);

    const badTeam = await app.request(`/platform/tenants/${TENANT}/roster-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          {
            clubId: 'clubcommit',
            rowNumber: 1,
            firstName: 'A',
            lastName: 'B',
            dob: '2000-01-01',
            team: 'u99',
          },
        ],
      }),
    });
    assert.equal(badTeam.status, 400);
  });

  test('more than 500 items → 400', async () => {
    const items = Array.from({ length: 501 }, (_, i) => ({
      clubId: 'clubcommit',
      rowNumber: i + 1,
      firstName: `P${i}`,
      lastName: 'Test',
      dob: '2000-01-01',
    }));
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ items }),
    });
    assert.equal(res.status, 400);
  });

  test('happy path: writes players, returns authoritative playerCount, batchId + no-store', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          {
            clubId: 'clubcommit',
            rowNumber: 1,
            firstName: 'Alice',
            lastName: 'Alpha',
            dob: '1998-03-14',
            idNumber: ids().idAlice,
            gender: 'Female',
            race: 'African',
          },
          {
            clubId: 'clubcommit',
            rowNumber: 2,
            firstName: 'Bob',
            lastName: 'Beta',
            dob: '2000-05-20',
            idNumber: ids().idBob,
            team: 'premier-men',
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = (await res.json()) as {
      batchId: string;
      created: number;
      alreadyPresent: number;
      crossClubConflicts: unknown[];
      playerCount: Record<string, number>;
    };
    assert.match(body.batchId, new RegExp(`^intake:roster:${TENANT}:\\d{8}:operator@platform$`));
    assert.equal(body.created, 2);
    assert.equal(body.alreadyPresent, 0);
    assert.equal(body.playerCount.clubcommit, 2);
    assert.equal(body.crossClubConflicts.length, 0);

    const players = await repo.listPlayers(TENANT, 'clubcommit');
    const alice = players.find((p) => p.firstName === 'Alice')!;
    assert.equal(alice.status, 'active');
    assert.equal(alice.version, 0);
    assert.equal(alice.registeredVia, 'portal');
    assert.match(alice.registeredBy ?? '', /^intake:roster:/);
  });

  test('re-committing the same items is idempotent: alreadyPresent, no double playerCount', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          {
            clubId: 'clubcommit',
            rowNumber: 1,
            firstName: 'Alice',
            lastName: 'Alpha',
            dob: '1998-03-14',
            idNumber: ids().idAlice,
            gender: 'Female',
            race: 'African',
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      created: number;
      alreadyPresent: number;
      playerCount: Record<string, number>;
    };
    assert.equal(body.created, 0);
    assert.equal(body.alreadyPresent, 1);
    assert.equal(body.playerCount.clubcommit, 2, 'count unchanged — no double count on re-commit');
  });

  test('cross-club conflict, in-batch: same identity in two clubs in one call — excluded both sides', async () => {
    const idCarl = validSaId('2003-02-02');
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          {
            clubId: 'clubcommit',
            rowNumber: 1,
            firstName: 'Carl',
            lastName: 'Conflict',
            dob: '2003-02-02',
            idNumber: idCarl,
          },
          {
            clubId: 'clubcommitb',
            rowNumber: 1,
            firstName: 'Carl',
            lastName: 'Conflict',
            dob: '2003-02-02',
            idNumber: idCarl,
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      created: number;
      playerCount: Record<string, number>;
      crossClubConflicts: Array<{
        rowNumber: number;
        clubId: string;
        playerNaturalKey: string;
        claimedBy: string;
        alreadyRegisteredAt?: string;
      }>;
    };
    assert.equal(body.created, 0, 'both rows excluded — nothing written');
    assert.deepEqual(body.playerCount, {}, 'no club was touched');
    assert.equal(body.crossClubConflicts.length, 2);
    assert.ok(body.crossClubConflicts.every((cc) => cc.alreadyRegisteredAt === undefined));
    const conflictClubs = body.crossClubConflicts.map((cc) => cc.clubId).sort();
    assert.deepEqual(conflictClubs, ['clubcommit', 'clubcommitb']);
    const carlEntry = body.crossClubConflicts.find((cc) => cc.clubId === 'clubcommit')!;
    assert.equal(carlEntry.claimedBy, 'clubcommitb');
    assert.equal(carlEntry.rowNumber, 1);

    const inA = await repo.listPlayers(TENANT, 'clubcommit');
    const inB = await repo.listPlayers(TENANT, 'clubcommitb');
    assert.ok(!inA.some((p) => p.firstName === 'Carl'));
    assert.ok(!inB.some((p) => p.firstName === 'Carl'));
  });

  test('cross-club conflict, already-registered elsewhere: excluded, never fatal to the rest of the batch', async () => {
    const idDee = validSaId('1999-09-09');
    // Dee is already active at clubcommit, seeded directly via repo (not through the
    // route) — the SAME naturalKey derivation the route uses (sa-id based) so the
    // cross-club lookup hits.
    const { playerNaturalKey } = await import('../src/player-identity.js');
    const naturalKey = playerNaturalKey({ idNumber: idDee, idType: 'sa-id' });
    await repo.createPlayer(TENANT, {
      naturalKey,
      clubId: 'clubcommit',
      firstName: 'Dee',
      lastName: 'Existing',
      dob: '1999-09-09',
      idNumber: idDee,
      idType: 'sa-id',
      isMinor: false,
      consentAt: '2020-01-01T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z',
      status: 'active',
      version: 0,
    });

    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          {
            clubId: 'clubcommitb',
            rowNumber: 1,
            firstName: 'Dee',
            lastName: 'Existing',
            dob: '1999-09-09',
            idNumber: idDee,
          },
          {
            clubId: 'clubcommitb',
            rowNumber: 2,
            firstName: 'Frank',
            lastName: 'Fresh',
            dob: '2004-04-04',
            idNumber: validSaId('2004-04-04'),
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      created: number;
      playerCount: Record<string, number>;
      crossClubConflicts: Array<{
        rowNumber: number;
        clubId: string;
        claimedBy: string;
        alreadyRegisteredAt?: string;
      }>;
    };
    assert.equal(body.crossClubConflicts.length, 1);
    assert.equal(body.crossClubConflicts[0].alreadyRegisteredAt, 'clubcommit');
    assert.equal(body.crossClubConflicts[0].claimedBy, 'clubcommit');
    assert.equal(body.crossClubConflicts[0].rowNumber, 1);
    // The rest of the batch (Frank) still commits — a conflict never aborts the request.
    assert.equal(body.created, 1);
    assert.equal(body.playerCount.clubcommitb, 1);
  });

  test('404 for an unknown tenant', async () => {
    const res = await app.request('/platform/tenants/noSuchTenant/roster-intake/commit', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ items: [] }),
    });
    assert.equal(res.status, 404);
  });
});

describe('cross-club duplicate parity fixture (shared with the frontend suite)', () => {
  test('findCrossClubDuplicates on shared-fixtures/cross-club-duplicates.json matches expectedConflictGroups', async () => {
    const { readFile } = await import('node:fs/promises');
    const { findCrossClubDuplicates } = await import('../src/roster-parse.js');
    const { playerNaturalKey } = await import('../src/player-identity.js');
    const fixtureUrl = new URL(
      '../../../shared-fixtures/cross-club-duplicates.json',
      import.meta.url,
    );
    const raw = JSON.parse(await readFile(fixtureUrl, 'utf8')) as {
      rows: Array<{
        clubId: string;
        clubName: string;
        firstName: string;
        lastName: string;
        dob: string;
        idNumber?: string;
      }>;
      expectedConflictGroups: number[][];
    };

    const entries = raw.rows.map((row, i) => {
      const naturalKey = playerNaturalKey({
        firstName: row.firstName,
        lastName: row.lastName,
        dob: row.dob,
        ...(row.idNumber ? { idNumber: row.idNumber, idType: 'sa-id' as const } : {}),
      });
      return {
        clubId: row.clubId,
        clubName: row.clubName,
        row: {
          player: {
            naturalKey,
            clubId: row.clubId,
            firstName: row.firstName,
            lastName: row.lastName,
            dob: row.dob,
            isMinor: false,
            consentAt: '',
            createdAt: '',
          },
          hadRealId: !!row.idNumber,
          missingId: false,
          rowNumber: i,
        },
        index: i,
        naturalKey,
      };
    });

    const { duplicateNaturalKeys } = findCrossClubDuplicates(
      entries.map(({ clubId, clubName, row }) => ({ clubId, clubName, row })),
    );

    const groupsByKey = new Map<string, number[]>();
    for (const e of entries) {
      if (!duplicateNaturalKeys.has(`${e.clubId}::${e.naturalKey}`)) continue;
      const list = groupsByKey.get(e.naturalKey);
      if (list) list.push(e.index);
      else groupsByKey.set(e.naturalKey, [e.index]);
    }
    const actualGroups = [...groupsByKey.values()].map((g) => g.sort((a, b) => a - b));
    actualGroups.sort((a, b) => a[0] - b[0]);
    const expected = raw.expectedConflictGroups.map((g) => [...g].sort((a, b) => a - b));
    expected.sort((a, b) => a[0] - b[0]);
    assert.deepEqual(actualGroups, expected);
  });
});
