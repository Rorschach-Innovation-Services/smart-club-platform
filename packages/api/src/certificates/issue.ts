/**
 * Issue a clearance's transfer certificate.
 *
 * Idempotent: a clearance that already points at a certificate returns that one. Otherwise:
 * gather → render (per the tenant's template) → sha256 → store the PDF under the clearance's
 * prefix → conditional pointer write on the canonical (+ mirror) → sign the canonical facts
 * (JWS ES256) → registry put (CERT#). The pointer condition is the ONLY race gate: a concurrent
 * issuer that loses deletes its own PDF and returns the winner's pointer. Writing the registry
 * LAST means a crash can only ever leave a pointer without a registry item (verify 404s until
 * ensureCertificateRecord restores it on first view) — never a VALID registry item that no
 * clearance row names, which erasure could not reach.
 */
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Sentry } from '../instrument.js';
import * as repo from '../repo.js';
import { orgCopy } from '../branding.js';
import { uploadsBucket } from '../env.js';
import type {
  CertificateMeta,
  CertificateRecord,
  PlayerClearance,
  PlayerRegistration,
  TenantConfig,
} from '../types.js';
import { resolveCertTemplate } from './config.js';
import { signPayload, type CertificatePayload } from './payload.js';
import { maskIdNumber, newSerial } from './serial.js';
import { certSigner, type Signer } from './signer.js';
import {
  accentColor,
  buildApprovals,
  effectiveDateOf,
  qrPng,
  resolveLogo,
  verifyUrlFor,
  type CertificateView,
} from './render-common.js';
import { renderClassic } from './render-classic.js';
import { renderConfirmation } from './render-confirmation.js';

const PDF = 'application/pdf';
const s3 = new S3Client({});

/** Thrown when a clearance can't carry a certificate (missing, or not approved/overridden). */
export class CertificateNotIssuableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CertificateNotIssuableError';
  }
}

export const isCertifiable = (c: Pick<PlayerClearance, 'status'>): boolean =>
  c.status === 'approved' || c.status === 'admin-override';

/**
 * The origin printed in every QR (`${base}/verify/<serial>`). A platform host set per stage in
 * sst.config.ts; the offline stack falls back to the local SPA. Anything else fails closed —
 * a certificate whose QR points nowhere is worse than none.
 */
export function verifyBaseUrl(): string {
  const v = process.env.VERIFY_BASE_URL;
  if (v) return v.replace(/\/$/, '');
  if (process.env.LOCAL_AUTH === '1') return 'http://localhost:3201';
  throw new Error('VERIFY_BASE_URL not set — certificates cannot be issued');
}

const isLocalUploadsMode = (): boolean =>
  process.env.STAGE === 'local' && !!process.env.LOCAL_UPLOADS_DIR;

async function storeObject(objectKey: string, bytes: Uint8Array): Promise<void> {
  if (objectKey.startsWith('local/')) {
    const file = path.join(process.env.LOCAL_UPLOADS_DIR!, objectKey.slice('local/'.length));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    return;
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: uploadsBucket(),
      Key: objectKey,
      Body: bytes,
      ContentType: PDF,
    }),
  );
}

async function removeObject(objectKey: string): Promise<void> {
  try {
    if (objectKey.startsWith('local/')) {
      await rm(path.join(process.env.LOCAL_UPLOADS_DIR!, objectKey.slice('local/'.length)), {
        force: true,
      });
      return;
    }
    await s3.send(new DeleteObjectCommand({ Bucket: uploadsBucket(), Key: objectKey }));
  } catch (err) {
    Sentry.captureException(err);
    console.error(`certificate: failed to remove ${objectKey} (erasure prefix purge will)`, err);
  }
}

/** The league label for a stored team key, when the catalogue knows it. */
function teamLabel(cfg: TenantConfig | null, key: string | undefined): string | undefined {
  if (!key) return undefined;
  return cfg?.leagues?.find((l) => l.key === key)?.label;
}

/** Everything a renderer needs, gathered from the clearance, tenant and destination row. */
export async function buildCertificateView(args: {
  clearance: PlayerClearance;
  cfg: TenantConfig | null;
  player: PlayerRegistration | null;
  serial: string;
  issuedAt: string;
  verifyBase: string;
  historical?: boolean;
}): Promise<CertificateView> {
  const { clearance: c, cfg, player } = args;
  const { transferring, acquiring } = buildApprovals(c, { historical: args.historical });
  const verifyUrl = verifyUrlFor(args.verifyBase, args.serial);
  const [logo, qr] = await Promise.all([
    resolveLogo(cfg?.branding?.logoUrl, args.verifyBase),
    qrPng(verifyUrl),
  ]);
  return {
    template: resolveCertTemplate(cfg),
    serial: args.serial,
    issuedAt: args.issuedAt,
    orgName: orgCopy(cfg).name,
    orgContact: cfg?.orgContact,
    logo,
    accent: accentColor(cfg?.branding?.colors),
    playerName: c.playerName,
    idNumber: c.idNumber ?? player?.idNumber,
    idType: player?.idType,
    dob: player?.dob || undefined,
    team: teamLabel(cfg, c.team ?? player?.team),
    fromClubName: c.fromClubName,
    toClubName: c.toClubName,
    effectiveDate: effectiveDateOf(c),
    origin: c.origin ?? 'request',
    transferring,
    acquiring,
    verifyUrl,
    qrPng: qr,
  };
}

export function renderCertificate(view: CertificateView): Promise<Uint8Array> {
  return view.template === 'confirmation' ? renderConfirmation(view) : renderClassic(view);
}

export interface IssueResult {
  meta: CertificateMeta;
  /** false when an existing certificate (or a concurrent winner's) was returned. */
  created: boolean;
}

/**
 * The registry item for an issued certificate, derived from the clearance row and its pointer.
 * The ONE builder for both first issue and crash recovery (ensureCertificateRecord), so the two
 * can't drift: facts come from the clearance, the issue time/template/hash from the pointer.
 */
async function buildRecord(args: {
  tenant: string;
  clearance: PlayerClearance;
  cfg: TenantConfig | null;
  player: PlayerRegistration | null;
  meta: CertificateMeta;
  signer: Signer;
}): Promise<CertificateRecord> {
  const { tenant, clearance: c, meta, signer } = args;
  const { transferring, acquiring } = buildApprovals(c, { historical: meta.historical });
  const idNumberMasked = maskIdNumber(c.idNumber ?? args.player?.idNumber);
  const effectiveDate = effectiveDateOf(c);
  const payload: CertificatePayload = {
    v: 1,
    serial: meta.serial,
    tenant,
    clearanceId: c.id,
    playerName: c.playerName,
    idNumberMasked,
    fromClub: { id: c.fromClubId, name: c.fromClubName },
    toClub: { id: c.toClubId, name: c.toClubName },
    effectiveDate,
    issuedAt: meta.generatedAt,
    transferringApproval: transferring,
    acquiringApproval: acquiring,
    template: meta.template,
  };
  const [signedPayload, publicKeyPem] = await Promise.all([
    signPayload(payload, signer),
    signer.publicKeyPem(),
  ]);
  return {
    serial: meta.serial,
    tenant,
    clearanceId: c.id,
    fromClubId: c.fromClubId,
    toClubId: c.toClubId,
    fromClubName: c.fromClubName,
    toClubName: c.toClubName,
    playerName: c.playerName,
    idNumberMasked,
    orgName: orgCopy(args.cfg).name,
    effectiveDate,
    issuedAt: meta.generatedAt,
    transferringApproval: transferring,
    acquiringApproval: acquiring,
    template: meta.template,
    objectKey: meta.objectKey,
    sha256: meta.sha256,
    kid: signer.kid,
    signedPayload,
    publicKeyPem,
    status: 'valid',
  };
}

/**
 * Self-heal a certificate whose pointer landed but whose registry item didn't (a crash between
 * the two writes — verify 404s meanwhile, which is safe: nothing unverifiable was printed yet).
 * Rebuilds the item from the clearance + pointer and writes it only if still absent. Returns
 * true when it (re)created the item.
 */
export async function ensureCertificateRecord(
  tenant: string,
  clearance: PlayerClearance,
  opts: { signer?: Signer } = {},
): Promise<boolean> {
  const meta = clearance.certificateMeta;
  if (!meta || (await repo.getCertificateBySerial(meta.serial))) return false;
  const [cfg, player] = await Promise.all([
    repo.getTenantConfig(tenant),
    repo.getPlayer(tenant, clearance.toClubId, clearance.playerNaturalKey),
  ]);
  const record = await buildRecord({
    tenant,
    clearance,
    cfg,
    player,
    meta,
    signer: opts.signer ?? certSigner(),
  });
  return repo.putCertificateRecord(record);
}

/**
 * Issue a clearance's certificate. Order: PDF put → conditional pointer write (the single race
 * decider) → registry put. A loser removes only its own PDF (it never wrote a registry item). A
 * crash after the pointer leaves the registry item missing, which ensureCertificateRecord
 * restores on first view; erasure always reaches the serial through the clearance rows.
 */
export async function issueCertificate(
  tenant: string,
  fromClubId: string,
  clearanceId: string,
  opts: { historical?: boolean; signer?: Signer; now?: () => string } = {},
): Promise<IssueResult> {
  const c = await repo.getClearance(tenant, fromClubId, clearanceId);
  if (!c) throw new CertificateNotIssuableError('clearance not found');
  if (c.certificateMeta) return { meta: c.certificateMeta, created: false };
  if (!isCertifiable(c)) {
    throw new CertificateNotIssuableError(`clearance is ${c.status}, not approved`);
  }
  if (c.certificateDeclined) {
    throw new CertificateNotIssuableError('the override declined a certificate for this clearance');
  }

  const signer = opts.signer ?? certSigner();
  const verifyBase = verifyBaseUrl();
  const [cfg, player] = await Promise.all([
    repo.getTenantConfig(tenant),
    repo.getPlayer(tenant, c.toClubId, c.playerNaturalKey),
  ]);
  const serial = newSerial();
  const issuedAt = (opts.now ?? (() => new Date().toISOString()))();
  const view = await buildCertificateView({
    clearance: c,
    cfg,
    player,
    serial,
    issuedAt,
    verifyBase,
    historical: opts.historical,
  });
  const pdf = await renderCertificate(view);
  const prefix = repo.clearanceObjectPrefix(tenant, c.fromClubId, c.id);
  const meta: CertificateMeta = {
    serial,
    objectKey: `${isLocalUploadsMode() ? 'local/' : ''}${prefix}certificate-${serial}.pdf`,
    contentType: PDF,
    generatedAt: issuedAt,
    template: view.template,
    sha256: createHash('sha256').update(pdf).digest('hex'),
    ...(opts.historical ? { historical: true } : {}),
  };

  await storeObject(meta.objectKey, pdf);
  try {
    await repo.setClearanceCertificate(tenant, c, meta);
  } catch (err) {
    await removeObject(meta.objectKey);
    if (err instanceof repo.CertificateRaceError) {
      const winner = await repo.getClearance(tenant, fromClubId, clearanceId);
      if (winner?.certificateMeta) return { meta: winner.certificateMeta, created: false };
    }
    throw err;
  }
  const record = await buildRecord({ tenant, clearance: c, cfg, player, meta, signer });
  await repo.putCertificateRecord(record);
  return { meta, created: true };
}
