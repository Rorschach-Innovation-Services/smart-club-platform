/**
 * Integration tests for route behavior under a CUSTOM per-tenant compliance-doc
 * catalogue (ADR 0009): upload-url per-doc `accepts`, multi-file min/max caps,
 * the archived-key upload/view/delete split, the exco form-doc gate, signup
 * seeding off the active catalogue, and the generic-PATCH multiFile merge guard.
 *
 * A dedicated file (not api.int.test.ts, which shares one 'dolphins' tenant across
 * ~6000 lines of tests assuming the DEFAULT_REQUIRED_DOCS catalogue) so a custom
 * catalogue tenant can be set up cleanly with no risk of order-dependent drift.
 *
 * Same harness as the other *.int.test.ts files: in-process dynalite + the real
 * Hono app via app.request(), auth via the LOCAL_AUTH x-dev-auth bypass.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Club, RequiredDoc } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4613; // distinct from api.int (4599), platform.int (4601), logo-offline (4603), tutorial-offline (4604), backfill-team (4605), season-venues (4607), release-clash-gate (4611)
const TABLE = 'SmartClubRequiredDocsTest';
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
const headers = (auth: string, tenant: string) => ({
  'x-tenant': tenant,
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

const CUSTOM_TENANT = 'doccustom';
const DEFAULT_TENANT = 'docdefault';
const ADMIN = devAuthAs('adm-custom', 'admin@doccustom', [
  { tenantId: CUSTOM_TENANT, role: 'admin', clubIds: [] },
]);
const DEFAULT_ADMIN = devAuthAs('adm-default', 'admin@docdefault', [
  { tenantId: DEFAULT_TENANT, role: 'admin', clubIds: [] },
]);

// No 'exco' entry — the exco form-doc gate must never fire on this catalogue.
const CUSTOM_DOCS: RequiredDoc[] = [
  { key: 'leagueEntry', name: 'League entry form', accepts: ['pdf', 'xls', 'xlsx'] },
  {
    key: 'facilityAgreement',
    name: 'Facility agreement',
    multiFile: true,
    minFiles: 1,
    maxFiles: 3,
    allowUnavailable: true,
  },
  { key: 'committee', name: 'Committee list' },
  {
    key: 'archivedCert',
    name: 'Archived Certs',
    multiFile: true,
    minFiles: 1,
    maxFiles: 5,
    archived: true,
  },
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
    tenant: CUSTOM_TENANT,
    branding: { name: 'Doc Custom Union', title: 'Doc Custom', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-31',
    knownClubs: [],
    leagues: [],
    districts: ['Test District'],
    requiredDocs: CUSTOM_DOCS,
  });
  // Legacy tenant — no requiredDocs field, so it resolves to DEFAULT_REQUIRED_DOCS
  // (which DOES have an exco kind:'form' entry) — the exco-gate comparison point.
  await repo.putTenantConfig({
    tenant: DEFAULT_TENANT,
    branding: {
      name: 'Doc Default Union',
      title: 'Doc Default',
      logoUrl: '',
      colors: {},
      copy: {},
    },
    submissionDeadline: '2026-12-31',
    knownClubs: [],
    leagues: [],
    districts: ['Test District'],
  });
});

after(() => new Promise<void>((resolve) => ddbServer.close(() => resolve())));

describe('doc routes under a custom catalogue (ADR 0009)', () => {
  before(async () => {
    await repo.createClub(CUSTOM_TENANT, baseClub('customcc'));
  });

  test('upload-url honours per-doc accepts: leagueEntry takes xls, committee (default accepts) rejects it', async () => {
    const ok = await app.request('/clubs/customcc/docs/leagueEntry/upload-url', {
      method: 'POST',
      headers: headers(ADMIN, CUSTOM_TENANT),
      body: JSON.stringify({ contentType: 'application/vnd.ms-excel' }),
    });
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { objectKey: string; contentType: string };
    assert.ok(okBody.objectKey.endsWith('.xls'), 'objectKey carries the xls extension');

    const bad = await app.request('/clubs/customcc/docs/committee/upload-url', {
      method: 'POST',
      headers: headers(ADMIN, CUSTOM_TENANT),
      body: JSON.stringify({ contentType: 'application/vnd.ms-excel' }),
    });
    assert.equal(bad.status, 400, 'committee has no accepts override — falls back to pdf/doc/docx');
  });

  test('upload-url 400s for a key outside the catalogue, and for a legacy-default key not in it', async () => {
    const unknown = await app.request('/clubs/customcc/docs/notARealDoc/upload-url', {
      method: 'POST',
      headers: headers(ADMIN, CUSTOM_TENANT),
    });
    assert.equal(unknown.status, 400);
    assert.match(((await unknown.json()) as { error: string }).error, /unknown document key/);

    // 'safeguarding' is a DEFAULT_REQUIRED_DOCS key but not in this tenant's custom
    // catalogue — it must be rejected exactly like any other unknown key.
    const legacyDefault = await app.request('/clubs/customcc/docs/safeguarding/upload-url', {
      method: 'POST',
      headers: headers(ADMIN, CUSTOM_TENANT),
    });
    assert.equal(legacyDefault.status, 400);
  });

  test('facilityAgreement: one file (local/ sentinel) completes it at minFiles 1; a 4th exceeds maxFiles 3', async () => {
    const upload = (n: number) =>
      app.request('/clubs/customcc/docs/facilityAgreement', {
        method: 'PATCH',
        headers: headers(ADMIN, CUSTOM_TENANT),
        body: JSON.stringify({ objectKey: `local/facility-${n}.pdf`, size: 10 }),
      });

    const first = await upload(1);
    assert.equal(first.status, 200);
    const afterFirst = (await repo.getClub(CUSTOM_TENANT, 'customcc')) as Club;
    assert.equal(afterFirst.docs.facilityAgreement, true, 'one file satisfies minFiles 1');

    assert.equal((await upload(2)).status, 200);
    assert.equal((await upload(3)).status, 200);

    const fourth = await upload(4);
    assert.equal(fourth.status, 400);
    assert.match(((await fourth.json()) as { error: string }).error, /no more than 3 stored files/);
  });

  test('DELETE file works for both doc shapes, and only for a key on record', async () => {
    const del = await app.request('/clubs/customcc/docs/facilityAgreement/file', {
      method: 'DELETE',
      headers: headers(ADMIN, CUSTOM_TENANT),
      body: JSON.stringify({ objectKey: 'local/facility-1.pdf' }),
    });
    assert.equal(del.status, 200);

    // Single-file docs accept this route too — it is the only way to CLEAR one, and
    // without it an archived single-file doc could never be cleaned up (ADR 0009).
    // An objectKey that isn't the one on record is still a 404, so this can never be
    // used to S3-delete something the club never stored under this doc.
    const bad = await app.request('/clubs/customcc/docs/committee/file', {
      method: 'DELETE',
      headers: headers(ADMIN, CUSTOM_TENANT),
      body: JSON.stringify({ objectKey: 'local/whatever.pdf' }),
    });
    assert.equal(bad.status, 404);
  });

  test('archived key: view-url and DELETE file still work; upload-url 400s', async () => {
    await repo.updateClub(
      CUSTOM_TENANT,
      'customcc',
      {
        docMeta: {
          archivedCert: {
            files: [{ objectKey: 'local/archived-a.pdf', size: 10, uploadedAt: '2026-01-01' }],
          },
        },
        docs: { archivedCert: true },
      },
      'test-seed',
      new Date().toISOString(),
    );

    const view = await app.request('/clubs/customcc/docs/archivedCert/view-url', {
      method: 'POST',
      headers: headers(ADMIN, CUSTOM_TENANT),
      body: JSON.stringify({ objectKey: 'local/archived-a.pdf' }),
    });
    assert.equal(view.status, 200, 'archived key stays viewable');

    const del = await app.request('/clubs/customcc/docs/archivedCert/file', {
      method: 'DELETE',
      headers: headers(ADMIN, CUSTOM_TENANT),
      body: JSON.stringify({ objectKey: 'local/archived-a.pdf' }),
    });
    assert.equal(del.status, 200, 'archived multiFile key stays deletable — the cleanup path');

    const upload = await app.request('/clubs/customcc/docs/archivedCert/upload-url', {
      method: 'POST',
      headers: headers(ADMIN, CUSTOM_TENANT),
    });
    assert.equal(upload.status, 400, 'archived key rejects a NEW upload');
  });

  test('exco gate: a catalogue with no exco form doc never flips docs.exco', async () => {
    const res = await app.request('/clubs/customcc/exco', {
      method: 'POST',
      headers: headers(ADMIN, CUSTOM_TENANT),
      body: JSON.stringify({
        chair: { name: 'Chair Person', email: 'c@test', cell: '0821112222' },
      }),
    });
    assert.equal(res.status, 200);
    const club = (await res.json()) as Club;
    assert.equal('exco' in club.docs, false, 'docs.exco never introduced on this catalogue');
  });

  test('exco gate: a defaults-catalogue tenant DOES flip docs.exco', async () => {
    await repo.createClub(DEFAULT_TENANT, baseClub('defaultcc'));
    const res = await app.request('/clubs/defaultcc/exco', {
      method: 'POST',
      headers: headers(DEFAULT_ADMIN, DEFAULT_TENANT),
      body: JSON.stringify({
        chair: { name: 'Chair Person', email: 'c@test', cell: '0821112222' },
      }),
    });
    assert.equal(res.status, 200);
    const club = (await res.json()) as Club;
    assert.equal(club.docs.exco, true);
  });

  // A form doc is satisfiable ONLY by its on-platform form. The presign route rejects
  // form keys, but the RECORD path did not — so a rep could presign under some other
  // key, PUT a file, then record it as `exco` and flip the flag without ever completing
  // the committee form. assertOwnObjectKey does not help: it binds the tenant/club
  // prefix, not the docKey segment.
  test('the record path refuses a file against a form-satisfied doc', async () => {
    await repo.createClub(DEFAULT_TENANT, baseClub('formcc'));
    const res = await app.request('/clubs/formcc/docs/exco', {
      method: 'PATCH',
      headers: headers(DEFAULT_ADMIN, DEFAULT_TENANT),
      body: JSON.stringify({
        // A legitimately-minted key for a DIFFERENT doc on this same club.
        objectKey: `${DEFAULT_TENANT}/formcc/constitution-abc.pdf`,
        size: 100,
        contentType: 'application/pdf',
      }),
    });
    assert.equal(res.status, 400);
    const club = await repo.getClub(DEFAULT_TENANT, 'formcc');
    assert.notEqual(club?.docs.exco, true, 'docs.exco must not be flipped by a file record');
  });

  // The three escape hatches are affordances the catalogue GRANTS per doc. Without a
  // server check they were UI-only, so a rep or a stale tab could skip any requirement.
  test('escape-hatch sentinels are rejected on a doc whose catalogue entry withholds them', async () => {
    await repo.createClub(CUSTOM_TENANT, baseClub('hatchcc'));
    // `committee` is a plain single-file doc: no allowUnavailable on this catalogue.
    const res = await app.request('/clubs/hatchcc', {
      method: 'PATCH',
      headers: headers(ADMIN, CUSTOM_TENANT),
      body: JSON.stringify({
        docs: { committee: true },
        docMeta: { committee: { unavailable: true, at: '2026-08-01T00:00:00.000Z' } },
      }),
    });
    assert.equal(res.status, 400);
    const club = await repo.getClub(CUSTOM_TENANT, 'hatchcc');
    assert.notEqual(club?.docs.committee, true);
  });

  test('a sentinel already on the stored record still saves (no bricking after a flag change)', async () => {
    await repo.createClub(CUSTOM_TENANT, baseClub('stalecc'));
    // Simulate a club that legitimately used the hatch before the operator removed it.
    await repo.updateClub(
      CUSTOM_TENANT,
      'stalecc',
      { docs: { committee: true }, docMeta: { committee: { unavailable: true, at: 'X' } } },
      'seed',
      new Date().toISOString(),
    );
    const res = await app.request('/clubs/stalecc', {
      method: 'PATCH',
      headers: headers(ADMIN, CUSTOM_TENANT),
      // An unrelated save that spreads the existing docMeta, as every client does.
      body: JSON.stringify({
        cqi: 42,
        docs: { committee: true },
        docMeta: { committee: { unavailable: true, at: 'X' } },
      }),
    });
    assert.equal(res.status, 200, 'a pre-existing sentinel must not make the club unsaveable');
  });

  test('signup on the custom-catalogue tenant seeds docs = all-false for exactly the active keys', async () => {
    const mint = await app.request('/admin/club-signup-link', {
      method: 'POST',
      headers: headers(ADMIN, CUSTOM_TENANT),
    });
    assert.equal(mint.status, 200);
    const { clubSignupLink } = (await mint.json()) as { clubSignupLink: { token: string } };

    const signup = await app.request(`/club-signup?t=${clubSignupLink.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clubName: 'Signup CC',
        district: 'Test District',
        repName: 'Rep Person',
        repEmail: 'rep@signup.test',
        repCell: '083 555 0002',
      }),
    });
    assert.equal(signup.status, 201);
    const { clubId } = (await signup.json()) as { clubId: string };
    const club = (await repo.getClub(CUSTOM_TENANT, clubId)) as Club;
    // archivedCert is archived — excluded. exco isn't in this catalogue at all.
    assert.deepEqual(club.docs, { leagueEntry: false, facilityAgreement: false, committee: false });
  });

  // The record route bypasses validateClubPatch entirely, so anything it persists is
  // persisted unchecked. Spreading the raw body let a rep bloat the club item toward
  // DynamoDB's 400 KB ceiling (bricking every later write to that club) and forge a
  // files[] pointing at another tenant's object — which view-url treats as its security
  // gate, since it deliberately has no assertOwnObjectKey of its own.
  test('the record route stores only named fields, never the raw request body', async () => {
    await repo.createClub(CUSTOM_TENANT, baseClub('bloatcc'));
    const objectKey = `local/committee-bloat.pdf`;
    const res = await app.request('/clubs/bloatcc/docs/committee', {
      method: 'PATCH',
      headers: headers(ADMIN, CUSTOM_TENANT),
      body: JSON.stringify({
        objectKey,
        size: 100,
        contentType: 'application/pdf',
        junk: 'x'.repeat(5000),
        files: [{ objectKey: 'othertenant/otherclub/secret.pdf' }],
        markedCompliant: true,
      }),
    });
    assert.equal(res.status, 200);
    const club = await repo.getClub(CUSTOM_TENANT, 'bloatcc');
    const meta = club?.docMeta?.committee as Record<string, unknown>;
    assert.deepEqual(Object.keys(meta).sort(), ['contentType', 'objectKey', 'size', 'uploadedAt']);
    assert.equal(meta.junk, undefined, 'arbitrary client fields must not be persisted');
    assert.equal(meta.files, undefined, 'a forged files[] must not reach the record');
  });

  describe('generic PATCH /clubs/:id doc guards', () => {
    before(async () => {
      await repo.createClub(CUSTOM_TENANT, baseClub('patchcc'));
      await repo.updateClub(
        CUSTOM_TENANT,
        'patchcc',
        {
          docMeta: {
            facilityAgreement: {
              files: [{ objectKey: 'local/patch-a.pdf', size: 10, uploadedAt: '2026-01-01' }],
            },
          },
          docs: { facilityAgreement: true, leagueEntry: false, committee: false },
        },
        'test-seed',
        new Date().toISOString(),
      );
    });

    test('multiFile merge guard preserves facilityAgreement files when a patch omits them', async () => {
      // Mirrors the safeguarding stale-client revert test in api.int.test.ts: a patch
      // that reverts the flag and sends no docMeta.facilityAgreement must not erase
      // the stored files — they're merged back in and the flag re-derived.
      const res = await app.request('/clubs/patchcc', {
        method: 'PATCH',
        headers: headers(ADMIN, CUSTOM_TENANT),
        body: JSON.stringify({
          docs: { facilityAgreement: false, leagueEntry: false, committee: false },
          docMeta: {},
        }),
      });
      assert.equal(res.status, 200);
      const club = (await repo.getClub(CUSTOM_TENANT, 'patchcc')) as Club & {
        docMeta?: Record<string, { files?: unknown[] }>;
      };
      assert.equal(club.docMeta?.facilityAgreement?.files?.length, 1, 'stored file survived');
      assert.equal(club.docs.facilityAgreement, true, 'flag re-derived from the preserved minimum');
    });

    test('a docMeta files array over the 20-file hard cap 400s', async () => {
      const tooMany = Array.from({ length: 21 }, (_, i) => ({
        objectKey: `local/cap-${i}.pdf`,
        size: 10,
        uploadedAt: '2026-01-01',
      }));
      const res = await app.request('/clubs/patchcc', {
        method: 'PATCH',
        headers: headers(ADMIN, CUSTOM_TENANT),
        body: JSON.stringify({ docMeta: { facilityAgreement: { files: tooMany } } }),
      });
      assert.equal(res.status, 400);
      assert.match(
        ((await res.json()) as { error: string }).error,
        /no more than 20 stored files for document "facilityAgreement"/,
      );
    });
  });
});
