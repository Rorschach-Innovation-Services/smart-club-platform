/**
 * Integration tests for clearance transfer certificates, end to end through the real Hono app:
 *   approve (club route) → awaited issue → pointer on BOTH rows + CERT# item + PDF on disk
 *   view-url from source and destination (third club 403/404) · public /verify shapes
 *   (valid with masked ID + sha256 + verifiable JWS; revoked status-only; unknown uniform 404)
 *   · public key directory (/verify-keys fingerprint)
 *   idempotent + concurrent issue · lazy issue on view after a failed hook (certificatePending)
 *   override with the certificate declined (no cert, view 409) vs default (cert)
 *   revoke · player DELETE purge · club erasure purge by prefix (incl. an orphaned PDF)
 *   operator template switch → confirmation layout; tenant admin can't set either field.
 *
 * Harness: in-process dynalite + app.request(), LOCAL_AUTH x-dev-auth, and the local upload
 * sink (STAGE=local + LOCAL_UPLOADS_DIR) so PDFs land on disk where they can be asserted.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createHash, createPublicKey } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { Club, PlayerClearance, PlayerRegistration, CertificateMeta } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4651;
const TABLE = 'SmartClubCertificateTest';
const TENANT = 'certs';
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
process.env.VERIFY_BASE_URL = 'https://platform.club.example';
delete process.env.CERT_SIGNING_KEY_ARN;

const devAuthAs = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const rep = (club: string) =>
  devAuthAs(`rep-${club}`, `rep@${club}.test`, [
    { tenantId: TENANT, role: 'rep', clubIds: [club] },
  ]);
const ADMIN = devAuthAs('admin-1', 'admin@union.test', [
  { tenantId: TENANT, role: 'admin', clubIds: [] },
]);
const OPERATOR = devAuthAs('op-1', 'operator@platform', [
  { tenantId: '*', role: 'operator', clubIds: [] },
]);
const headers = (auth: string) => ({
  'x-dev-auth': auth,
  'x-tenant': TENANT,
  'content-type': 'application/json',
});

const FULL_ID = '9001015009087';

let uploadsDir: string;
let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let issue: typeof import('../src/certificates/issue.js');
let payloadMod: typeof import('../src/certificates/payload.js');

const mkClub = (id: string): Club =>
  ({
    id,
    name: `${id[0].toUpperCase()}${id.slice(1)} CC`,
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
  }) as unknown as Club;

let seq = 0;
async function seedPlayer(clubId: string): Promise<PlayerRegistration> {
  seq++;
  const idNumber = seq === 1 ? FULL_ID : `90010150${String(10000 + seq).slice(-5)}`;
  const p: PlayerRegistration = {
    naturalKey: `nk-${seq}`,
    clubId,
    firstName: 'Player',
    lastName: `Number${seq}`,
    dob: '1990-01-01',
    isMinor: false,
    status: 'active',
    consentAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
    idType: 'sa-id',
    idNumber,
  };
  await repo.createPlayer(TENANT, p);
  return p;
}

const call = (method: string, url: string, auth: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: headers(auth),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function openClearance(from: string, to: string, p: PlayerRegistration) {
  const res = await call('POST', `/clubs/${to}/clearances`, rep(to), {
    fromClubId: from,
    playerNaturalKey: p.naturalKey,
  });
  assert.equal(res.status, 201);
  return (await res.json()) as PlayerClearance;
}

async function approveViaClub(from: string, to: string) {
  const p = await seedPlayer(from);
  const opened = await openClearance(from, to, p);
  const res = await call('PATCH', `/clubs/${from}/clearances/${opened.id}`, rep(from), {
    action: 'issue',
    feesCleared: true,
    misconductCleared: true,
    version: opened.version,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as PlayerClearance & {
    certificateMeta?: CertificateMeta;
    certificatePending?: boolean;
  };
  return { player: p, clearance: body };
}

const diskPath = (objectKey: string) => path.join(uploadsDir, objectKey.slice('local/'.length));
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

before(async () => {
  uploadsDir = await mkdtemp(path.join(tmpdir(), 'cert-test-'));
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
  issue = await import('../src/certificates/issue.js');
  payloadMod = await import('../src/certificates/payload.js');

  await repo.putTenantConfig({
    tenant: TENANT,
    branding: {
      name: 'Certificate Test Union',
      title: 'Cert Union',
      logoUrl: '/dolphins-logo.png',
      colors: { '--brand-accent': '#1B4D8C' },
      copy: {},
    },
    submissionDeadline: '2026-12-31',
    knownClubs: [],
    leagues: [],
    districts: ['Test District'],
  });
  for (const id of ['alpha', 'beta', 'gamma', 'delta', 'omega']) {
    await repo.createClub(TENANT, mkClub(id));
  }
});

after(async () => {
  await new Promise<void>((resolve) => ddbServer.close(() => resolve()));
  await rm(uploadsDir, { recursive: true, force: true });
});

describe('issue on club approval', () => {
  let first: Awaited<ReturnType<typeof approveViaClub>>;

  before(async () => {
    first = await approveViaClub('alpha', 'beta');
  });

  test('the approve response carries the certificate; both rows point at it; the PDF exists', async () => {
    const meta = first.clearance.certificateMeta!;
    assert.ok(meta, 'certificateMeta in the approve response');
    assert.equal(first.clearance.certificatePending, undefined);
    assert.match(meta.serial, /^SC-TRF-/);
    assert.equal(meta.template, 'classic');
    assert.equal(first.clearance.clubApprovedBy, 'rep@alpha.test');

    const canonical = await repo.getClearance(TENANT, 'alpha', first.clearance.id);
    const mirror = await repo.getInboundClearance(TENANT, 'beta', first.clearance.id);
    assert.deepEqual(canonical?.certificateMeta, meta);
    assert.deepEqual(mirror?.certificateMeta, meta);
    assert.equal(canonical?.clubApprovedBy, 'rep@alpha.test');

    const record = await repo.getCertificateBySerial(meta.serial);
    assert.equal(record?.status, 'valid');
    assert.equal(record?.tenant, TENANT);
    assert.equal(record?.idNumberMasked, '90********087');
    assert.ok(meta.objectKey.startsWith(`local/${TENANT}/alpha/clearances/${first.clearance.id}/`));

    const pdf = await readFile(diskPath(meta.objectKey));
    const doc = await PDFDocument.load(pdf);
    assert.equal(doc.getPageCount(), 1);
    const { width, height } = doc.getPage(0).getSize();
    assert.ok(width > height, 'classic is landscape');
    assert.equal(createHash('sha256').update(pdf).digest('hex'), record?.sha256);
  });

  test('view-url works for the source AND the destination club', async () => {
    for (const club of ['alpha', 'beta']) {
      const res = await call(
        'POST',
        `/clubs/${club}/clearances/${first.clearance.id}/certificate/view-url`,
        rep(club),
      );
      assert.equal(res.status, 200, club);
      const body = (await res.json()) as { viewUrl: string; serial: string };
      assert.equal(body.serial, first.clearance.certificateMeta!.serial);
      assert.ok(body.viewUrl.includes('/local-uploads/local/'));
      const pdf = await app.request(new URL(body.viewUrl).pathname + new URL(body.viewUrl).search);
      assert.equal(pdf.status, 200);
      assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    }
  });

  test('a third club is refused', async () => {
    const onOther = await call(
      'POST',
      `/clubs/alpha/clearances/${first.clearance.id}/certificate/view-url`,
      rep('gamma'),
    );
    assert.equal(onOther.status, 403);
    const onOwn = await call(
      'POST',
      `/clubs/gamma/clearances/${first.clearance.id}/certificate/view-url`,
      rep('gamma'),
    );
    assert.equal(onOwn.status, 404);
  });

  test('admin view-url twin', async () => {
    const res = await call(
      'POST',
      `/admin/clearances/${first.clearance.id}/certificate/view-url`,
      ADMIN,
      { fromClubId: 'alpha' },
    );
    assert.equal(res.status, 200);
  });

  test('public verify: valid shape, masked ID only, verifiable JWS, no DOB', async () => {
    const serial = first.clearance.certificateMeta!.serial;
    // Retyped: lowercase, no hyphens, O for 0 where applicable.
    const typed = serial.toLowerCase().replace(/-/g, '');
    const res = await app.request(`/verify/${typed}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = (await res.json()) as Record<string, unknown> & {
      signedPayload: string;
      publicKeyPem: string;
      tenantBranding: Record<string, unknown>;
    };
    assert.equal(body.status, 'valid');
    assert.equal(body.serial, serial);
    assert.equal(body.playerName, first.clearance.playerName);
    assert.equal(body.idNumberMasked, '90********087');
    assert.equal(body.fromClubName, 'Alpha CC');
    assert.equal(body.toClubName, 'Beta CC');
    assert.equal(body.orgName, 'Certificate Test Union');
    assert.deepEqual(body.tenantBranding, {
      name: 'Certificate Test Union',
      logoUrl: '/dolphins-logo.png',
      colors: { '--brand-accent': '#1B4D8C' },
    });
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes(FULL_ID), 'full ID never leaves the API publicly');
    assert.ok(!raw.includes('1990-01-01'), 'DOB never leaves the API publicly');

    assert.equal(payloadMod.verifyJws(body.signedPayload, body.publicKeyPem), true);
    // The verifying key + kid come from the record (rotation-safe), not the live signer.
    const record = await repo.getCertificateBySerial(serial);
    assert.equal(body.kid, 'local-dev');
    assert.equal(body.publicKeyPem, record?.publicKeyPem);
    // The stored PDF's sha256 rides along so the verify page can check a PDF file.
    assert.equal(body.sha256, record?.sha256);
    assert.match(String(body.sha256), /^[0-9a-f]{64}$/);
    const decoded = payloadMod.decodeJws(body.signedPayload);
    assert.equal(decoded.header.alg, 'ES256');
    assert.equal(decoded.header.kid, 'local-dev');
    const p = decoded.payload as Record<string, unknown>;
    assert.equal(p.serial, serial);
    assert.equal(p.idNumberMasked, '90********087');
    assert.ok(!JSON.stringify(p).includes(FULL_ID), 'JWS payload carries the masked ID only');
  });

  test('public key directory: active key with a pinnable SPKI fingerprint', async () => {
    const res = await app.request('/verify-keys');
    assert.equal(res.status, 200);
    const keys = (await res.json()) as Array<{
      kid: string;
      publicKeyPem: string;
      fingerprint: string;
    }>;
    assert.equal(keys.length, 1);
    const [key] = keys;
    assert.deepEqual(Object.keys(key).sort(), ['fingerprint', 'kid', 'publicKeyPem']);
    assert.equal(key.kid, 'local-dev');
    // Recompute independently: SHA-256 over the DER SPKI, uppercase colon-separated hex.
    const der = createPublicKey(key.publicKeyPem).export({ format: 'der', type: 'spki' });
    const expected = createHash('sha256').update(der).digest('hex').toUpperCase();
    assert.match(key.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.equal(key.fingerprint.replace(/:/g, ''), expected);
    // The pinned key verifies an issued certificate's JWS offline.
    const record = await repo.getCertificateBySerial(first.clearance.certificateMeta!.serial);
    assert.equal(payloadMod.verifyJws(record!.signedPayload, key.publicKeyPem), true);
  });

  test('unknown, malformed and wrong-length serials all get the same 404', async () => {
    for (const s of ['SC-TRF-00000-00000-00000-00000', 'nope', 'SC-TRF-AAAA']) {
      const res = await app.request(`/verify/${s}`);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: 'not found' });
    }
  });

  test('re-issuing returns the existing certificate', async () => {
    const again = await issue.issueCertificate(TENANT, 'alpha', first.clearance.id);
    assert.equal(again.created, false);
    assert.equal(again.meta.serial, first.clearance.certificateMeta!.serial);
    const files = await readdir(
      path.join(uploadsDir, TENANT, 'alpha', 'clearances', first.clearance.id),
    );
    assert.equal(files.length, 1);
  });
});

describe('concurrent issue', () => {
  test('two racing issuers produce ONE certificate; the loser cleans up after itself', async () => {
    const p = await seedPlayer('alpha');
    const opened = await openClearance('alpha', 'delta', p);
    await repo.resolveClearance(TENANT, 'alpha', opened.id, {
      mode: 'club',
      at: new Date().toISOString(),
      by: 'rep@alpha.test',
    });
    const [a, b] = await Promise.all([
      issue.issueCertificate(TENANT, 'alpha', opened.id),
      issue.issueCertificate(TENANT, 'alpha', opened.id),
    ]);
    assert.equal(a.meta.serial, b.meta.serial);
    assert.equal([a.created, b.created].filter(Boolean).length, 1);
    const files = await readdir(path.join(uploadsDir, TENANT, 'alpha', 'clearances', opened.id));
    assert.deepEqual(files, [`certificate-${a.meta.serial}.pdf`]);
  });
});

describe('lazy issue when the approve-time hook failed', () => {
  test('approve still succeeds with certificatePending; the first view issues it', async () => {
    const good = process.env.LOCAL_UPLOADS_DIR!;
    // A path under a regular file can't be created → the PDF write (and so issuance) fails.
    const blocker = path.join(good, 'blocker');
    await writeFile(blocker, 'x');
    process.env.LOCAL_UPLOADS_DIR = path.join(blocker, 'sub');
    let approved: Awaited<ReturnType<typeof approveViaClub>>;
    try {
      approved = await approveViaClub('alpha', 'gamma');
    } finally {
      process.env.LOCAL_UPLOADS_DIR = good;
    }
    assert.equal(approved.clearance.status, 'approved', 'the approval stands');
    assert.equal(approved.clearance.certificatePending, true);
    assert.equal(approved.clearance.certificateMeta, undefined);
    assert.equal(
      (await repo.getClearance(TENANT, 'alpha', approved.clearance.id))?.certificateMeta,
      undefined,
    );

    const res = await call(
      'POST',
      `/clubs/gamma/clearances/${approved.clearance.id}/certificate/view-url`,
      rep('gamma'),
    );
    assert.equal(res.status, 200);
    const { serial } = (await res.json()) as { serial: string };
    const mirror = await repo.getInboundClearance(TENANT, 'gamma', approved.clearance.id);
    assert.equal(mirror?.certificateMeta?.serial, serial);
    assert.equal((await repo.getCertificateBySerial(serial))?.status, 'valid');
  });

  test('view-url on a still-pending clearance is a 409', async () => {
    const p = await seedPlayer('alpha');
    const opened = await openClearance('alpha', 'beta', p);
    const res = await call(
      'POST',
      `/clubs/alpha/clearances/${opened.id}/certificate/view-url`,
      rep('alpha'),
    );
    assert.equal(res.status, 409);
  });
});

describe('admin override', () => {
  test('issueCertificate:false ⇒ no certificate, and viewing never lazily issues one', async () => {
    const p = await seedPlayer('alpha');
    const opened = await openClearance('alpha', 'beta', p);
    const res = await call('POST', `/admin/clearances/${opened.id}/override`, ADMIN, {
      fromClubId: 'alpha',
      reason: 'junk registration',
      issueCertificate: false,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as PlayerClearance & { certificatePending?: boolean };
    assert.equal(body.status, 'admin-override');
    assert.equal(body.certificateMeta, undefined);
    assert.equal(body.certificatePending, undefined);
    assert.equal(body.certificateDeclined, true);

    for (const [url, auth, reqBody] of [
      [`/clubs/alpha/clearances/${opened.id}/certificate/view-url`, rep('alpha'), undefined],
      [`/clubs/beta/clearances/${opened.id}/certificate/view-url`, rep('beta'), undefined],
      [`/admin/clearances/${opened.id}/certificate/view-url`, ADMIN, { fromClubId: 'alpha' }],
    ] as const) {
      const v = await call('POST', url, auth, reqBody);
      assert.equal(v.status, 409, url);
    }
    await assert.rejects(
      issue.issueCertificate(TENANT, 'alpha', opened.id),
      issue.CertificateNotIssuableError,
    );
    const canonical = await repo.getClearance(TENANT, 'alpha', opened.id);
    assert.equal(canonical?.certificateMeta, undefined);
    assert.equal(
      await exists(path.join(uploadsDir, TENANT, 'alpha', 'clearances', opened.id)),
      false,
    );
  });

  test('default (issueCertificate omitted) ⇒ certificate with the override copy', async () => {
    const p = await seedPlayer('alpha');
    const opened = await openClearance('alpha', 'beta', p);
    const res = await call('POST', `/admin/clearances/${opened.id}/override`, ADMIN, {
      fromClubId: 'alpha',
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as PlayerClearance;
    assert.ok(body.certificateMeta);
    const record = await repo.getCertificateBySerial(body.certificateMeta!.serial);
    assert.deepEqual(record?.transferringApproval.kind, 'admin');
    assert.equal(record?.transferringApproval.by, 'admin@union.test');
  });

  test('a non-boolean issueCertificate is a 400', async () => {
    const p = await seedPlayer('alpha');
    const opened = await openClearance('alpha', 'beta', p);
    const res = await call('POST', `/admin/clearances/${opened.id}/override`, ADMIN, {
      fromClubId: 'alpha',
      issueCertificate: 'no',
    });
    assert.equal(res.status, 400);
  });
});

describe('registry item lost between the pointer and registry writes', () => {
  test('the first view-url restores it and verify returns valid again', async () => {
    const { clearance } = await approveViaClub('alpha', 'beta');
    const meta = clearance.certificateMeta!;
    const original = await repo.getCertificateBySerial(meta.serial);
    await repo.deleteCertificateRecord(meta.serial);
    assert.equal((await app.request(`/verify/${meta.serial}`)).status, 404);

    const view = await call(
      'POST',
      `/clubs/beta/clearances/${clearance.id}/certificate/view-url`,
      rep('beta'),
    );
    assert.equal(view.status, 200);

    const restored = await repo.getCertificateBySerial(meta.serial);
    assert.equal(restored?.status, 'valid');
    assert.equal(restored?.sha256, original?.sha256);
    assert.equal(restored?.issuedAt, original?.issuedAt);
    assert.deepEqual(
      payloadMod.decodeJws(restored!.signedPayload).payload,
      payloadMod.decodeJws(original!.signedPayload).payload,
      'the rebuilt record asserts exactly the facts first issued',
    );
    const v = await app.request(`/verify/${meta.serial}`);
    assert.equal(v.status, 200);
    const body = (await v.json()) as {
      status: string;
      signedPayload: string;
      publicKeyPem: string;
    };
    assert.equal(body.status, 'valid');
    assert.equal(payloadMod.verifyJws(body.signedPayload, body.publicKeyPem), true);
  });

  test('revoke restores a missing item before revoking it', async () => {
    const { clearance } = await approveViaClub('alpha', 'beta');
    await repo.deleteCertificateRecord(clearance.certificateMeta!.serial);
    const res = await call('POST', `/admin/clearances/${clearance.id}/certificate/revoke`, ADMIN, {
      fromClubId: 'alpha',
      reason: 'issued in error',
    });
    assert.equal(res.status, 200);
    assert.equal(
      (await repo.getCertificateBySerial(clearance.certificateMeta!.serial))?.status,
      'revoked',
    );
  });
});

describe('revoke', () => {
  test('marks the registry + both rows; verify goes status-only; viewing is a 410', async () => {
    const { clearance } = await approveViaClub('alpha', 'beta');
    const serial = clearance.certificateMeta!.serial;

    const bad = await call('POST', `/admin/clearances/${clearance.id}/certificate/revoke`, ADMIN, {
      fromClubId: 'alpha',
    });
    assert.equal(bad.status, 400, 'reason required');

    const res = await call('POST', `/admin/clearances/${clearance.id}/certificate/revoke`, ADMIN, {
      fromClubId: 'alpha',
      reason: 'issued in error',
    });
    assert.equal(res.status, 200);
    const out = (await res.json()) as { status: string; revokedAt: string };
    assert.equal(out.status, 'revoked');

    const record = await repo.getCertificateBySerial(serial);
    assert.equal(record?.status, 'revoked');
    assert.equal(record?.revokedBy, 'admin@union.test');
    assert.equal(record?.revokeReason, 'issued in error');
    const canonical = await repo.getClearance(TENANT, 'alpha', clearance.id);
    const mirror = await repo.getInboundClearance(TENANT, 'beta', clearance.id);
    assert.equal(canonical?.certificateMeta?.revokedAt, out.revokedAt);
    assert.equal(mirror?.certificateMeta?.revokedAt, out.revokedAt);

    const v = await app.request(`/verify/${serial}`);
    assert.equal(v.status, 200);
    assert.deepEqual(await v.json(), {
      serial,
      status: 'revoked',
      issuedAt: record!.issuedAt,
      revokedAt: out.revokedAt,
    });

    const view = await call(
      'POST',
      `/clubs/beta/clearances/${clearance.id}/certificate/view-url`,
      rep('beta'),
    );
    assert.equal(view.status, 410);
    assert.deepEqual(await view.json(), { revokedAt: out.revokedAt, error: 'certificate revoked' });

    const again = await call(
      'POST',
      `/admin/clearances/${clearance.id}/certificate/revoke`,
      ADMIN,
      {
        fromClubId: 'alpha',
        reason: 'twice',
      },
    );
    assert.equal(again.status, 409);
  });
});

describe('player DELETE purges the certificate', () => {
  test('PDF, CERT# item and both pointers go; verify 404s', async () => {
    const { player, clearance } = await approveViaClub('alpha', 'beta');
    const meta = clearance.certificateMeta!;
    assert.equal(await exists(diskPath(meta.objectKey)), true);

    const res = await call('DELETE', `/clubs/beta/players/${player.naturalKey}`, rep('beta'));
    assert.equal(res.status, 200);

    assert.equal(await exists(diskPath(meta.objectKey)), false);
    assert.equal(await repo.getCertificateBySerial(meta.serial), null);
    assert.equal(
      (await repo.getClearance(TENANT, 'alpha', clearance.id))?.certificateMeta,
      undefined,
    );
    assert.equal(
      (await repo.getInboundClearance(TENANT, 'beta', clearance.id))?.certificateMeta,
      undefined,
    );
    assert.equal((await app.request(`/verify/${meta.serial}`)).status, 404);
  });
});

describe('club erasure purges certificates of APPROVED clearances', () => {
  test('PDF (and an orphan in the same prefix) + CERT# item removed; verify 404s', async () => {
    const { clearance } = await approveViaClub('omega', 'beta');
    const meta = clearance.certificateMeta!;
    const prefixDir = path.join(uploadsDir, TENANT, 'omega', 'clearances', clearance.id);
    // A PDF orphaned between its S3 put and the pointer write — no row names it.
    await mkdir(prefixDir, { recursive: true });
    await writeFile(path.join(prefixDir, 'certificate-SC-TRF-ORPHN-00000-00000-00000.pdf'), 'x');

    const res = await call('DELETE', '/clubs/omega', ADMIN);
    assert.equal(res.status, 200);

    assert.equal(await exists(prefixDir), false, 'whole clearance prefix purged');
    assert.equal(await repo.getCertificateBySerial(meta.serial), null);
    assert.equal((await app.request(`/verify/${meta.serial}`)).status, 404);
  });
});

describe('tenant certificate config', () => {
  test('tenant admins cannot set the template or orgContact', async () => {
    const res = await call('PUT', '/tenant/config', ADMIN, {
      clearanceCertTemplate: 'confirmation',
      orgContact: { phone: '1' },
    });
    assert.equal(res.status, 200);
    const cfg = await repo.getTenantConfig(TENANT);
    assert.equal(cfg?.clearanceCertTemplate, undefined);
    assert.equal(cfg?.orgContact, undefined);
  });

  test('operator validation', async () => {
    const bad = await app.request(`/platform/tenants/${TENANT}`, {
      method: 'PUT',
      headers: { 'x-dev-auth': OPERATOR, 'content-type': 'application/json' },
      body: JSON.stringify({ clearanceCertTemplate: 'fancy' }),
    });
    assert.equal(bad.status, 400);
    const badContact = await app.request(`/platform/tenants/${TENANT}`, {
      method: 'PUT',
      headers: { 'x-dev-auth': OPERATOR, 'content-type': 'application/json' },
      body: JSON.stringify({ orgContact: { fax: '1' } }),
    });
    assert.equal(badContact.status, 400);
  });

  test('operator switch to confirmation → next certificate is the portrait tabular layout', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}`, {
      method: 'PUT',
      headers: { 'x-dev-auth': OPERATOR, 'content-type': 'application/json' },
      body: JSON.stringify({
        clearanceCertTemplate: 'confirmation',
        orgContact: { regNo: ' 2001/1 ', phone: '+27 31 000 0000', email: '' },
      }),
    });
    assert.equal(res.status, 200);
    const cfg = await repo.getTenantConfig(TENANT);
    assert.equal(cfg?.clearanceCertTemplate, 'confirmation');
    assert.deepEqual(cfg?.orgContact, { regNo: '2001/1', phone: '+27 31 000 0000' });

    const { clearance } = await approveViaClub('alpha', 'beta');
    const meta = clearance.certificateMeta!;
    assert.equal(meta.template, 'confirmation');
    assert.equal((await repo.getCertificateBySerial(meta.serial))?.template, 'confirmation');
    const doc = await PDFDocument.load(await readFile(diskPath(meta.objectKey)));
    assert.equal(doc.getPageCount(), 1);
    const { width, height } = doc.getPage(0).getSize();
    assert.ok(height > width, 'confirmation is portrait');
  });
});
