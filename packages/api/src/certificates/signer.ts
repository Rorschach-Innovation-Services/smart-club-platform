/**
 * ES256 signers for the certificate JWS.
 *
 * - KMS (any real stage): `CERT_SIGNING_KEY_ARN` names an ECC_NIST_P256 / SIGN_VERIFY key.
 *   KMS returns a DER `ECDSA-Sig-Value`; JWS needs the raw 64-byte r‖s, hence derToRaw.
 * - Local (LOCAL_AUTH=1 only — the offline stack and the test suites): a P-256 key persisted
 *   as PEM at devSigningKeyPath() (created on first use, reused across restarts, regenerated
 *   if unparseable) so certificates from an earlier local run still verify. Never used in AWS.
 * - Anything else FAILS CLOSED (mirrors env.ts candidateHandleSecret): a real stage with no
 *   key configured must not mint certificates whose signature nobody can check.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KMSClient, SignCommand, GetPublicKeyCommand } from '@aws-sdk/client-kms';

export interface Signer {
  /** Key id carried in the JWS header — the KMS key id (ARN tail), or 'local-dev'. */
  readonly kid: string;
  /** Sign `data` (SHA-256 applied by the signer) → raw 64-byte r‖s. */
  sign(data: Buffer): Promise<Buffer>;
  /** SPKI PEM of the verifying key. */
  publicKeyPem(): Promise<string>;
}

/** Convert a DER ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }) to raw r‖s. */
export function derToRaw(der: Uint8Array, size = 32): Buffer {
  const buf = Buffer.from(der);
  let pos = 0;
  const readLen = (): number => {
    let len = buf[pos++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | buf[pos++];
    }
    return len;
  };
  if (buf[pos++] !== 0x30) throw new Error('derToRaw: expected SEQUENCE');
  const seqLen = readLen();
  if (pos + seqLen !== buf.length) throw new Error('derToRaw: bad SEQUENCE length');
  const readInt = (): Buffer => {
    if (buf[pos++] !== 0x02) throw new Error('derToRaw: expected INTEGER');
    const len = readLen();
    let v = buf.subarray(pos, pos + len);
    pos += len;
    while (v.length > 0 && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new Error('derToRaw: integer too large');
    const out = Buffer.alloc(size);
    v.copy(out, size - v.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
}

const toPem = (spkiDer: Uint8Array): string =>
  createPublicKey({ key: Buffer.from(spkiDer), format: 'der', type: 'spki' })
    .export({ format: 'pem', type: 'spki' })
    .toString();

export class KmsSigner implements Signer {
  readonly kid: string;
  private readonly client: KMSClient;
  private pem: Promise<string> | null = null;

  constructor(
    private readonly keyArn: string,
    client?: KMSClient,
  ) {
    this.kid = keyArn.split('/').pop() || keyArn;
    this.client = client ?? new KMSClient({});
  }

  async sign(data: Buffer): Promise<Buffer> {
    const res = await this.client.send(
      new SignCommand({
        KeyId: this.keyArn,
        Message: data,
        MessageType: 'RAW',
        SigningAlgorithm: 'ECDSA_SHA_256',
      }),
    );
    if (!res.Signature) throw new Error('KMS Sign returned no signature');
    return derToRaw(res.Signature);
  }

  publicKeyPem(): Promise<string> {
    this.pem ??= this.client
      .send(new GetPublicKeyCommand({ KeyId: this.keyArn }))
      .then((res) => {
        if (!res.PublicKey) throw new Error('KMS GetPublicKey returned no key');
        return toPem(res.PublicKey);
      })
      .catch((err) => {
        this.pem = null; // don't cache a failure
        throw err;
      });
    return this.pem;
  }
}

/**
 * Where the dev signing key lives: a sibling of the local uploads dir, derived the same way
 * src/local/server.ts derives LOCAL_UPLOADS_DIR (default `<tmpdir>/smart-club-local-uploads`).
 */
export function devSigningKeyPath(): string {
  const uploads =
    process.env.LOCAL_UPLOADS_DIR ?? path.join(os.tmpdir(), 'smart-club-local-uploads');
  return path.join(path.dirname(uploads), 'cert-signing-dev.pem');
}

/** Load the PKCS#8 P-256 private key at `file`, or create (or replace, if unparseable) it. */
function loadOrCreateDevKey(file: string): KeyObject {
  if (process.env.LOCAL_AUTH !== '1') {
    throw new Error('persisted dev signing key is LOCAL_AUTH=1 only');
  }
  try {
    const key = createPrivateKey(readFileSync(file, 'utf8'));
    if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') {
      return key;
    }
    console.warn(`cert signer: ${file} is not a P-256 key — regenerating`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`cert signer: ${file} unreadable — regenerating`, err);
    }
  }
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename so a concurrent process never reads a half-written file.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, pem, { mode: 0o600 });
  renameSync(tmp, file);
  return privateKey;
}

export class LocalSigner implements Signer {
  readonly kid = 'local-dev';
  private readonly privateKey: KeyObject;
  private readonly pem: string;

  /**
   * With `keyFile`, the key is persisted there (see loadOrCreateDevKey); without it, an
   * ephemeral in-memory key (unit tests that want a distinct key per instance).
   */
  constructor(keyFile?: string) {
    this.privateKey = keyFile
      ? loadOrCreateDevKey(keyFile)
      : generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    this.pem = createPublicKey(this.privateKey).export({ format: 'pem', type: 'spki' }).toString();
  }

  async sign(data: Buffer): Promise<Buffer> {
    return sign('sha256', data, { key: this.privateKey, dsaEncoding: 'ieee-p1363' });
  }

  async publicKeyPem(): Promise<string> {
    return this.pem;
  }
}

let cached: Signer | null = null;

/** The process-wide signer for the current environment (see module doc). */
export function certSigner(): Signer {
  if (cached) return cached;
  const arn = process.env.CERT_SIGNING_KEY_ARN;
  if (arn) cached = new KmsSigner(arn);
  else if (process.env.LOCAL_AUTH === '1') cached = new LocalSigner(devSigningKeyPath());
  else
    throw new Error(
      'CERT_SIGNING_KEY_ARN not set — certificates cannot be signed (deploy the CertSigningKey)',
    );
  return cached;
}

/**
 * Standard public-key fingerprint: SHA-256 over the DER SubjectPublicKeyInfo, as uppercase
 * colon-separated hex (e.g. `AB:12:…`).
 */
export function spkiFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g)!.join(':');
}

export interface VerifyKey {
  kid: string;
  publicKeyPem: string;
  fingerprint: string;
}

let verifyKeysCache: VerifyKey[] | null = null;

/**
 * The public key directory (GET /verify-keys): the active signing key(s) with fingerprints.
 * Cached for the process on success only — a failure throws and the next call retries.
 */
export async function activeVerifyKeys(): Promise<VerifyKey[]> {
  if (verifyKeysCache) return verifyKeysCache;
  const signer = certSigner();
  const publicKeyPem = await signer.publicKeyPem();
  verifyKeysCache = [{ kid: signer.kid, publicKeyPem, fingerprint: spkiFingerprint(publicKeyPem) }];
  return verifyKeysCache;
}
