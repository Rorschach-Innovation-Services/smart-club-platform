/**
 * Certificate JWS: canonical JSON stability, ES256 sign→verify with the local signer, the
 * KMS DER→raw conversion (incl. hand vectors for padded / short integers), fail-closed
 * signer selection, and the persisted dev key (stable across LocalSigner instances).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  canonicalJson,
  decodeJws,
  signPayload,
  verifyJws,
  type CertificatePayload,
} from '../src/certificates/payload.js';
import {
  LocalSigner,
  certSigner,
  derToRaw,
  devSigningKeyPath,
  spkiFingerprint,
} from '../src/certificates/signer.js';

const payload: CertificatePayload = {
  v: 1,
  serial: 'SC-TRF-ABCDE-FGHJK-MNPQR-STVWX',
  tenant: 'dolphins',
  clearanceId: 'c-1',
  playerName: 'Test Player',
  idNumberMasked: '90********087',
  fromClub: { id: 'a', name: 'Alpha' },
  toClub: { id: 'b', name: 'Beta' },
  effectiveDate: '2026-09-29',
  issuedAt: '2026-09-29T10:00:00.000Z',
  transferringApproval: { kind: 'club', by: 'rep@alpha', at: '2026-09-29T09:59:00.000Z' },
  acquiringApproval: { kind: 'club', by: 'rep@beta', at: '2026-09-20T08:00:00.000Z' },
  template: 'classic',
};

describe('canonicalJson', () => {
  test('is independent of key insertion order, at every depth', () => {
    const a = { b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } };
    const b = { a: { c: 'x', d: [1, { y: 2, z: 1 }] }, b: 1 };
    assert.equal(canonicalJson(a), canonicalJson(b));
    assert.equal(canonicalJson(a), '{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
  });

  test('drops undefined members', () => {
    assert.equal(canonicalJson({ a: undefined, b: 2 }), '{"b":2}');
  });
});

describe('signPayload / verifyJws (local signer)', () => {
  test('round-trips, carries kid + ES256, and rejects tampering', async () => {
    const signer = new LocalSigner();
    const jws = await signPayload(payload, signer);
    const pem = await signer.publicKeyPem();
    assert.equal(verifyJws(jws, pem), true);
    const { header, payload: decoded } = decodeJws(jws);
    assert.deepEqual(header, { alg: 'ES256', kid: 'local-dev', typ: 'JWT' });
    assert.deepEqual(decoded, JSON.parse(canonicalJson(payload)));

    const [h, , s] = jws.split('.');
    const forged = Buffer.from(canonicalJson({ ...payload, playerName: 'Someone Else' })).toString(
      'base64url',
    );
    assert.equal(verifyJws(`${h}.${forged}.${s}`, pem), false);
    assert.equal(verifyJws(jws, await new LocalSigner().publicKeyPem()), false);
  });

  test('the same payload always signs the same bytes (stable signing input)', async () => {
    const signer = new LocalSigner();
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as CertificatePayload;
    const [h1, p1] = (await signPayload(payload, signer)).split('.');
    const [h2, p2] = (await signPayload(reordered, signer)).split('.');
    assert.equal(`${h1}.${p1}`, `${h2}.${p2}`);
  });
});

describe('derToRaw', () => {
  test('converts real DER signatures into verifiable IEEE-P1363 r‖s', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    for (let i = 0; i < 50; i++) {
      const data = Buffer.from(`message ${i}`);
      const der = sign('sha256', data, { key: privateKey, dsaEncoding: 'der' });
      const raw = derToRaw(der);
      assert.equal(raw.length, 64);
      assert.ok(verify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw));
    }
  });

  test('strips the sign-padding 0x00 and left-pads short integers', () => {
    const r = Buffer.alloc(32, 0xaa); // high bit set → DER adds a leading 0x00
    const s = Buffer.alloc(31, 0x11); // 31-byte integer → must be left-padded to 32
    const der = Buffer.concat([
      Buffer.from([0x30, 2 + 33 + 2 + 31, 0x02, 33, 0x00]),
      r,
      Buffer.from([0x02, 31]),
      s,
    ]);
    const raw = derToRaw(der);
    assert.deepEqual(raw.subarray(0, 32), r);
    assert.deepEqual(raw.subarray(32), Buffer.concat([Buffer.from([0]), s]));
  });

  test('rejects malformed input', () => {
    assert.throws(() => derToRaw(Buffer.from([0x31, 0x00])));
    assert.throws(() => derToRaw(Buffer.from([0x30, 0x05, 0x02, 0x01, 0x01])));
  });
});

describe('certSigner selection', () => {
  test('fails closed with no key ARN outside LOCAL_AUTH', () => {
    const saved = { arn: process.env.CERT_SIGNING_KEY_ARN, local: process.env.LOCAL_AUTH };
    delete process.env.CERT_SIGNING_KEY_ARN;
    delete process.env.LOCAL_AUTH;
    try {
      assert.throws(() => certSigner(), /CERT_SIGNING_KEY_ARN not set/);
    } finally {
      if (saved.arn !== undefined) process.env.CERT_SIGNING_KEY_ARN = saved.arn;
      if (saved.local !== undefined) process.env.LOCAL_AUTH = saved.local;
    }
  });
});

describe('persisted dev signing key (LOCAL_AUTH=1)', () => {
  const withLocalAuth = async (fn: (dir: string) => Promise<void>) => {
    const saved = process.env.LOCAL_AUTH;
    process.env.LOCAL_AUTH = '1';
    const dir = await mkdtemp(path.join(tmpdir(), 'cert-dev-key-'));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
      if (saved === undefined) delete process.env.LOCAL_AUTH;
      else process.env.LOCAL_AUTH = saved;
    }
  };

  test('two signers over the same file share one key (a restart keeps verifying)', () =>
    withLocalAuth(async (dir) => {
      const file = path.join(dir, 'cert-signing-dev.pem');
      const first = new LocalSigner(file);
      const jws = await signPayload(payload, first);
      assert.match(await readFile(file, 'utf8'), /BEGIN PRIVATE KEY/);

      const second = new LocalSigner(file); // "after a restart"
      assert.equal(await second.publicKeyPem(), await first.publicKeyPem());
      assert.equal(verifyJws(jws, await second.publicKeyPem()), true);
      assert.equal(verifyJws(await signPayload(payload, second), await first.publicKeyPem()), true);
    }));

  test('an unparseable key file is replaced with a fresh working key', () =>
    withLocalAuth(async (dir) => {
      const file = path.join(dir, 'cert-signing-dev.pem');
      await writeFile(file, 'not a pem');
      const signer = new LocalSigner(file);
      assert.equal(
        verifyJws(await signPayload(payload, signer), await signer.publicKeyPem()),
        true,
      );
      assert.equal(await new LocalSigner(file).publicKeyPem(), await signer.publicKeyPem());
    }));

  test('refuses to persist outside LOCAL_AUTH=1', async () => {
    const saved = process.env.LOCAL_AUTH;
    delete process.env.LOCAL_AUTH;
    try {
      assert.throws(() => new LocalSigner(path.join(tmpdir(), 'never.pem')), /LOCAL_AUTH=1 only/);
    } finally {
      if (saved !== undefined) process.env.LOCAL_AUTH = saved;
    }
  });

  test('lives beside LOCAL_UPLOADS_DIR', () => {
    const saved = process.env.LOCAL_UPLOADS_DIR;
    process.env.LOCAL_UPLOADS_DIR = path.join('/x', 'smart-club-local-uploads');
    try {
      assert.equal(devSigningKeyPath(), path.join('/x', 'cert-signing-dev.pem'));
    } finally {
      if (saved === undefined) delete process.env.LOCAL_UPLOADS_DIR;
      else process.env.LOCAL_UPLOADS_DIR = saved;
    }
  });
});

describe('spkiFingerprint', () => {
  test('is the SHA-256 of the DER SPKI as colon-separated uppercase hex', async () => {
    const pem = await new LocalSigner().publicKeyPem();
    const fp = spkiFingerprint(pem);
    assert.match(fp, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.equal(spkiFingerprint(pem), fp, 'deterministic');
    assert.notEqual(spkiFingerprint(await new LocalSigner().publicKeyPem()), fp);
  });
});
