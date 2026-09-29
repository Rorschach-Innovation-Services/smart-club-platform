/**
 * Per-tenant certificate settings (operator-only TenantConfig fields): template choice and
 * the organisation contact footer.
 */
import { HttpError } from '../auth.js';
import type { CertificateTemplate, OrgContact, TenantConfig } from '../types.js';

export const CERT_TEMPLATES: readonly CertificateTemplate[] = ['classic', 'confirmation'];

/** The tenant's effective certificate template: the configured one, else 'classic'. */
export function resolveCertTemplate(
  cfg?: Pick<TenantConfig, 'clearanceCertTemplate'> | null,
): CertificateTemplate {
  const t = cfg?.clearanceCertTemplate;
  return t && CERT_TEMPLATES.includes(t) ? t : 'classic';
}

/** 400 unless `v` is a known template. */
export function validateCertTemplate(v: unknown): CertificateTemplate {
  if (typeof v !== 'string' || !CERT_TEMPLATES.includes(v as CertificateTemplate)) {
    throw new HttpError(400, `clearanceCertTemplate must be one of: ${CERT_TEMPLATES.join(', ')}`);
  }
  return v as CertificateTemplate;
}

const ORG_CONTACT_FIELDS = ['regNo', 'address', 'phone', 'website', 'email'] as const;
const ORG_CONTACT_MAX = 200;

/**
 * Validate + normalise an orgContact patch: an object of optional strings (≤200 chars each),
 * trimmed, blanks dropped, unknown keys rejected. Returns the cleaned object ({} is valid —
 * it clears the footer).
 */
export function validateOrgContact(v: unknown): OrgContact {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new HttpError(400, 'orgContact must be an object');
  }
  const out: OrgContact = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!(ORG_CONTACT_FIELDS as readonly string[]).includes(k)) {
      throw new HttpError(400, `orgContact: unknown field "${k}"`);
    }
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') throw new HttpError(400, `orgContact.${k} must be a string`);
    const s = raw.trim();
    if (s.length > ORG_CONTACT_MAX) {
      throw new HttpError(400, `orgContact.${k} must be at most ${ORG_CONTACT_MAX} characters`);
    }
    if (s) out[k as keyof OrgContact] = s;
  }
  return out;
}
