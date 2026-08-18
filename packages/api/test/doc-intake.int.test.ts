/**
 * Integration tests for the operator bulk document-intake routes (ADR 0009 Part 3):
 *   - POST /platform/tenants/:slug/doc-intake/presign — per-item validation, positional
 *     results, objectKey prefix convention
 *   - POST /platform/tenants/:slug/doc-intake/commit — grouped-by-club writes, dedupe on
 *     re-run, multiFile min/max, single-file replace, foreign-objectKey rejection,
 *     per-club partial failure
 *   - POST /platform/tenants/:slug/clubs — operator-created shell club
 *
 * Same harness as required-docs.int.test.ts: in-process dynalite + the real Hono app
 * via app.request(), auth via the LOCAL_AUTH x-dev-auth bypass. A dedicated file (not
 * platform.int.test.ts) so a custom doc-intake catalogue can be set up cleanly.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Club, RequiredDoc } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4615; // distinct from api.int (4599), platform.int (4601), logo-offline (4603), tutorial-offline (4604), backfill-team (4605), season-venues (4607), migrate-block-index (4609), release-clash-gate (4611), required-docs (4613)
const TABLE = 'SmartClubDocIntakeTest';
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

const TENANT = 'docintake';

// A form-doc key (exco), an archived key, a single-file key and a multiFile key —
// enough surface to exercise every intake gate (kind, archived, accepts, min/max).
const CATALOGUE: RequiredDoc[] = [
  { key: 'committee', name: 'Committee list' },
  {
    key: 'safeguarding',
    name: 'Safeguarding certificates',
    multiFile: true,
    minFiles: 2,
    maxFiles: 3,
  },
  { key: 'exco', name: 'Executive committee', kind: 'form' },
  { key: 'archivedDoc', name: 'Archived doc', archived: true },
];

const baseClub = (id: string): Club =>
  ({
    id,
    name: id,
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

// Resolved in before().
let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');

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
    branding: { name: 'Doc Intake Union', title: 'Doc Intake', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-31',
    knownClubs: [],
    leagues: [],
    districts: ['Test District'],
    requiredDocs: CATALOGUE,
  });
});

after(() => new Promise<void>((resolve) => ddbServer.close(() => resolve())));

describe('POST /platform/tenants/:slug/doc-intake/presign', () => {
  before(async () => {
    await repo.createClub(TENANT, baseClub('presigncc'));
  });

  test('positional per-item validation: unknown club, archived key, form key, unaccepted type, oversize, and a valid row', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/doc-intake/presign`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          { clubId: 'noSuchClub', docKey: 'committee', contentType: 'application/pdf', size: 10 },
          { clubId: 'presigncc', docKey: 'archivedDoc', contentType: 'application/pdf', size: 10 },
          { clubId: 'presigncc', docKey: 'exco', contentType: 'application/pdf', size: 10 },
          {
            clubId: 'presigncc',
            docKey: 'committee',
            contentType: 'application/vnd.ms-excel',
            size: 10,
          },
          {
            clubId: 'presigncc',
            docKey: 'committee',
            contentType: 'application/pdf',
            size: 999_999_999,
          },
          { clubId: 'presigncc', docKey: 'committee', contentType: 'application/pdf', size: 10 },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      items: Array<{ ok: boolean; error?: string; objectKey?: string; uploadUrl?: string }>;
    };
    assert.equal(body.items.length, 6, 'one result per input item, index-aligned');
    assert.equal(body.items[0].ok, false);
    assert.match(body.items[0].error!, /unknown club/);
    assert.equal(body.items[1].ok, false, 'archived key is not active — rejected like unknown');
    assert.match(body.items[1].error!, /unknown document key/);
    assert.equal(body.items[2].ok, false, 'form key can never be satisfied by an upload');
    assert.match(body.items[2].error!, /unknown document key/);
    assert.equal(body.items[3].ok, false);
    assert.match(body.items[3].error!, /file type not accepted/);
    assert.equal(body.items[4].ok, false);
    assert.match(body.items[4].error!, /under 10 MB/);
    assert.equal(body.items[5].ok, true, 'the one well-formed row still succeeds');
  });

  test('objectKey follows the tenant-side convention: <tenant>/<clubId>/<docKey>-<uuid>.<ext>', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/doc-intake/presign`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          { clubId: 'presigncc', docKey: 'committee', contentType: 'application/pdf', size: 10 },
        ],
      }),
    });
    const { items } = (await res.json()) as {
      items: Array<{ ok: boolean; objectKey?: string; uploadUrl?: string }>;
    };
    assert.equal(items[0].ok, true);
    assert.match(items[0].objectKey!, /^docintake\/presigncc\/committee-[0-9a-f-]+\.pdf$/);
    assert.ok(items[0].uploadUrl!.length > 0);
  });

  test('404s for an unknown tenant', async () => {
    const res = await app.request('/platform/tenants/noSuchTenant/doc-intake/presign', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ items: [] }),
    });
    assert.equal(res.status, 404);
  });

  test('more than 100 items → 400', async () => {
    const items = Array.from({ length: 101 }, () => ({
      clubId: 'presigncc',
      docKey: 'committee',
      contentType: 'application/pdf',
      size: 10,
    }));
    const res = await app.request(`/platform/tenants/${TENANT}/doc-intake/presign`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ items }),
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /platform/tenants/:slug/doc-intake/commit', () => {
  before(async () => {
    await repo.createClub(TENANT, baseClub('commitA'));
    await repo.createClub(TENANT, baseClub('commitB'));
  });

  test('multi-club, multi-doc happy path writes ONCE per club (version bumps by exactly 1)', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/doc-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          {
            clubId: 'commitA',
            docKey: 'committee',
            objectKey: 'local/commitA/committee-1.pdf',
            size: 10,
            contentType: 'application/pdf',
            sourceName: 'committee.pdf',
          },
          {
            clubId: 'commitA',
            docKey: 'safeguarding',
            objectKey: 'local/commitA/safeguarding-1.pdf',
            size: 10,
            contentType: 'application/pdf',
            sourceName: 'sg1.pdf',
          },
          {
            clubId: 'commitB',
            docKey: 'committee',
            objectKey: 'local/commitB/committee-1.pdf',
            size: 10,
            contentType: 'application/pdf',
            sourceName: 'committee.pdf',
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      clubs: Array<{ clubId: string; ok: boolean; docs?: Record<string, boolean> }>;
    };
    assert.equal(body.clubs.length, 2, 'grouped by club — one result per club, not per item');
    const a = body.clubs.find((c) => c.clubId === 'commitA')!;
    const b = body.clubs.find((c) => c.clubId === 'commitB')!;
    assert.equal(a.ok, true);
    assert.equal(a.docs?.committee, true);
    assert.equal(a.docs?.safeguarding, false, 'one file is below safeguarding minFiles(2)');
    assert.equal(b.ok, true);
    assert.equal(b.docs?.committee, true);

    const clubA = (await repo.getClub(TENANT, 'commitA')) as Club;
    // Two items landed on commitA (committee + safeguarding) — a single version-pinned
    // write means version goes 1 → 2, NOT 1 → 3 (which would betray a write per item).
    assert.equal(clubA.version, 2, 'both items for commitA landed in ONE write');
  });

  test('re-running the same commit is idempotent: dedupe on sourceName+size does not duplicate a multiFile entry', async () => {
    const commitOnce = () =>
      app.request(`/platform/tenants/${TENANT}/doc-intake/commit`, {
        method: 'POST',
        headers: platformHeaders(OPERATOR),
        body: JSON.stringify({
          items: [
            {
              clubId: 'commitA',
              docKey: 'safeguarding',
              objectKey: 'local/commitA/safeguarding-2.pdf',
              size: 20,
              contentType: 'application/pdf',
              sourceName: 'sg2.pdf',
            },
          ],
        }),
      });
    const first = await commitOnce();
    assert.equal(first.status, 200);
    const afterFirst = (await repo.getClub(TENANT, 'commitA')) as Club & {
      docMeta?: Record<string, { files?: unknown[] }>;
    };
    assert.equal(afterFirst.docMeta?.safeguarding?.files?.length, 2);
    assert.equal(afterFirst.docs.safeguarding, true, 'minFiles(2) reached');

    // Re-run — same sourceName+size for the same doc — must not append a 3rd file.
    const second = await commitOnce();
    assert.equal(second.status, 200);
    const afterSecond = (await repo.getClub(TENANT, 'commitA')) as Club & {
      docMeta?: Record<string, { files?: unknown[] }>;
    };
    assert.equal(
      afterSecond.docMeta?.safeguarding?.files?.length,
      2,
      're-run did not duplicate the file',
    );
  });

  test('maxFiles is enforced — a 4th safeguarding file (over maxFiles 3) fails that club only', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/doc-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          {
            clubId: 'commitA',
            docKey: 'safeguarding',
            objectKey: 'local/commitA/safeguarding-3.pdf',
            size: 30,
            contentType: 'application/pdf',
            sourceName: 'sg3.pdf',
          },
          {
            clubId: 'commitA',
            docKey: 'safeguarding',
            objectKey: 'local/commitA/safeguarding-4.pdf',
            size: 40,
            contentType: 'application/pdf',
            sourceName: 'sg4.pdf',
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const { clubs } = (await res.json()) as {
      clubs: Array<{ clubId: string; ok: boolean; error?: string }>;
    };
    assert.equal(clubs.length, 1);
    assert.equal(clubs[0].ok, false);
    assert.match(clubs[0].error!, /no more than 3 stored files/);
    const club = (await repo.getClub(TENANT, 'commitA')) as Club & {
      docMeta?: Record<string, { files?: unknown[] }>;
    };
    // The whole club's batch is one write — a mid-batch failure must leave the
    // PRIOR state untouched (still 2 files from the earlier test, not 3).
    assert.equal(club.docMeta?.safeguarding?.files?.length, 2);
  });

  test('single-file doc replace: a second commit on the same key replaces the stored objectKey', async () => {
    await app.request(`/platform/tenants/${TENANT}/doc-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          {
            clubId: 'commitB',
            docKey: 'committee',
            objectKey: 'local/commitB/committee-2.pdf',
            size: 15,
            contentType: 'application/pdf',
            sourceName: 'committee-v2.pdf',
          },
        ],
      }),
    });
    const club = (await repo.getClub(TENANT, 'commitB')) as Club & {
      docMeta?: Record<string, { objectKey?: string; sourceName?: string }>;
    };
    assert.equal(club.docMeta?.committee?.objectKey, 'local/commitB/committee-2.pdf');
    assert.equal(club.docMeta?.committee?.sourceName, 'committee-v2.pdf');
    assert.equal(club.docs.committee, true);
  });

  test('a foreign objectKey (outside the target club prefix) is rejected', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/doc-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          {
            clubId: 'commitB',
            docKey: 'committee',
            objectKey: `${TENANT}/commitA/committee-hijack.pdf`,
            size: 10,
            contentType: 'application/pdf',
            sourceName: 'hijack.pdf',
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const { clubs } = (await res.json()) as {
      clubs: Array<{ clubId: string; ok: boolean; error?: string }>;
    };
    assert.equal(clubs[0].ok, false);
    assert.match(clubs[0].error!, /does not belong to club/);
  });

  test('per-club partial failure: one bad club does not stop the other from committing', async () => {
    await repo.createClub(TENANT, baseClub('goodclub'));
    const res = await app.request(`/platform/tenants/${TENANT}/doc-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({
        items: [
          {
            clubId: 'noSuchClub',
            docKey: 'committee',
            objectKey: `${TENANT}/noSuchClub/committee-1.pdf`,
            size: 10,
            contentType: 'application/pdf',
            sourceName: 'x.pdf',
          },
          {
            clubId: 'goodclub',
            docKey: 'committee',
            objectKey: 'local/goodclub/committee-1.pdf',
            size: 10,
            contentType: 'application/pdf',
            sourceName: 'x.pdf',
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const { clubs } = (await res.json()) as {
      clubs: Array<{ clubId: string; ok: boolean; docs?: Record<string, boolean> }>;
    };
    const bad = clubs.find((c) => c.clubId === 'noSuchClub')!;
    const good = clubs.find((c) => c.clubId === 'goodclub')!;
    assert.equal(bad.ok, false, 'nonexistent club fails');
    assert.equal(good.ok, true, 'the other club in the same batch still commits');
    assert.equal(good.docs?.committee, true);
  });

  test('more than 100 items → 400', async () => {
    const items = Array.from({ length: 101 }, (_, i) => ({
      clubId: 'commitA',
      docKey: 'committee',
      objectKey: `local/commitA/committee-${i}.pdf`,
      size: 10,
      contentType: 'application/pdf',
      sourceName: `x${i}.pdf`,
    }));
    const res = await app.request(`/platform/tenants/${TENANT}/doc-intake/commit`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ items }),
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /platform/tenants/:slug/clubs', () => {
  test('happy path creates a club seeded from the tenant catalogue (archived excluded, form key included)', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/clubs`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ name: 'Operator Created CC', district: 'Test District' }),
    });
    assert.equal(res.status, 201);
    const club = (await res.json()) as Club;
    assert.equal(club.id, 'operator-created-cc');
    assert.equal(club.name, 'Operator Created CC');
    assert.equal(club.district, 'Test District');
    assert.deepEqual(club.docs, { committee: false, safeguarding: false, exco: false });
    // No chair/membership/Cognito provisioning — the affiliation seed stays empty.
    assert.equal(club.chair, '');
    assert.equal(club.affiliation, 'not_started');

    const stored = await repo.getClub(TENANT, 'operator-created-cc');
    assert.ok(stored, 'persisted via repo.createClub');
  });

  test('duplicate name → 409', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/clubs`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ name: 'Operator Created CC', district: 'Test District' }),
    });
    assert.equal(res.status, 409);
  });

  test('unknown district → 400', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/clubs`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ name: 'Another Club', district: 'Nowhere District' }),
    });
    assert.equal(res.status, 400);
  });

  test('empty name → 400', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/clubs`, {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ name: '   ', district: 'Test District' }),
    });
    assert.equal(res.status, 400);
  });

  test('404s for an unknown tenant', async () => {
    const res = await app.request('/platform/tenants/noSuchTenant/clubs', {
      method: 'POST',
      headers: platformHeaders(OPERATOR),
      body: JSON.stringify({ name: 'X', district: 'Test District' }),
    });
    assert.equal(res.status, 404);
  });
});
