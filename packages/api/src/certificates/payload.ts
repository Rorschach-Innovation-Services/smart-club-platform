/**
 * The signed certificate facts: canonical JSON → compact JWS (ES256).
 *
 * The payload carries the MASKED ID only — the JWS is served by the public verify endpoint
 * (POPIA; the weaker binding is accepted). The PDF's sha256 lives beside the JWS in the
 * registry, not inside it: the PDF embeds a QR of the serial, so hashing the PDF into the
 * payload would be circular.
 */
import { createPublicKey, verify } from 'node:crypto';
import type { CertificateApproval, CertificateTemplate } from '../types.js';
import type { Signer } from './signer.js';

export interface CertificatePayload {
  v: 1;
  serial: string;
  tenant: string;
  clearanceId: string;
  playerName: string;
  idNumberMasked: string;
  fromClub: { id: string; name: string };
  toClub: { id: string; name: string };
  effectiveDate: string;
  issuedAt: string;
  transferringApproval: CertificateApproval;
  acquiringApproval: CertificateApproval;
  template: CertificateTemplate;
}

/** JSON with object keys sorted at every depth and undefined members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(',')}}`;
}

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');

/** Sign `payload` → compact JWS `header.payload.signature` with `kid` in the header. */
export async function signPayload(payload: CertificatePayload, signer: Signer): Promise<string> {
  const header = canonicalJson({ alg: 'ES256', kid: signer.kid, typ: 'JWT' });
  const signingInput = `${b64url(header)}.${b64url(canonicalJson(payload))}`;
  const sig = await signer.sign(Buffer.from(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

/** Decode (without verifying) a compact JWS's header + payload. */
export function decodeJws(jws: string): { header: Record<string, unknown>; payload: unknown } {
  const [h, p] = jws.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')),
  };
}

/** Verify a compact ES256 JWS against an SPKI PEM public key. */
export function verifyJws(jws: string, publicKeyPem: string): boolean {
  const parts = jws.split('.');
  if (parts.length !== 3) return false;
  const [h, p, s] = parts;
  return verify(
    'sha256',
    Buffer.from(`${h}.${p}`),
    { key: createPublicKey(publicKeyPem), dsaEncoding: 'ieee-p1363' },
    Buffer.from(s, 'base64url'),
  );
}
