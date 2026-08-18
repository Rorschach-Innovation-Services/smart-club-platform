/**
 * Player identity derivation — the natural key, RSA-ID date-of-birth oracle, and ID
 * normalisation shared by the registration routes and the import CLIs.
 *
 * Extracted from index.ts (the club-id.ts precedent: import CLIs write through repo and
 * cannot import index.ts, but MUST produce byte-identical natural keys — a divergent key
 * would silently duplicate a player and break dedup/transfers forever).
 */
import { createHash } from 'node:crypto';
import type { PlayerRegistration } from './types.js';

/**
 * Idempotent dedup key for a person within a club. SHARED by the public-link path
 * and the in-portal chair form so the same person can't be registered twice (once
 * per path). Keys on the player's OWN identity — their ID number — NOT on contact
 * fields: a parent/guardian legitimately reuses one email/cell across siblings, so
 * keying on contact collapsed distinct children into one identity and blocked the
 * 2nd+ child (the transfer flow already resolves players by idNumber, so this aligns).
 * The identity is namespaced by idType + nationality because passport numbers are
 * unique only within an issuing country; a bare passport number would false-collide
 * two different foreign players. RSA IDs are nationally unique, scoped under `sa-id`.
 * Caveat: nationality is free text (not enum-validated), so a passport holder who
 * re-registers with a different spelling ("Zimbabwean" vs "Zimbabwe") escapes dedup —
 * best-effort, same class of gap the prior email-vs-cell key had.
 * Falls back to name+dob only when no idNumber is present (should not happen — it is
 * required on both paths), so the identity is never derived from an empty string.
 *
 * The result is a sha256 hash of that identity, NOT the plaintext: this key is both the
 * DynamoDB sk and the `:nk` URL segment in the id-doc endpoints, so hashing keeps the raw
 * national ID out of id-doc URLs, API access logs, and Sentry (POPIA data-minimisation).
 * Hashing is deterministic, so dedup and the cross-path guarantee are unchanged; the
 * plaintext idNumber lives only in the item's `idNumber` attribute (transfers match on it).
 */
export function playerNaturalKey(body: Partial<PlayerRegistration>): string {
  const id = normalizeId(body.idNumber);
  const identity = id
    ? (body.idType ?? 'sa-id') === 'passport'
      ? `passport-${normalizeId(body.nationality)}-${id}`
      : `sa-id-${id}`
    : `${body.firstName}-${body.lastName}-${body.dob}`;
  return createHash('sha256').update(identity.toLowerCase()).digest('hex');
}

/**
 * Derive an ISO date of birth from a 13-digit RSA ID (YYMMDD…). The century digit is
 * absent, so we pivot year-relative (not on a frozen constant): assume the 2000s, and
 * fall back to the 1900s only if that lands in the future. This self-updates each year,
 * so it never silently rots. Returns null if the digits don't form a real date.
 */
export function dobFromSaId(idNumber: string): string | null {
  if (!/^\d{13}$/.test(idNumber)) return null;
  const yy = Number(idNumber.slice(0, 2));
  const mm = Number(idNumber.slice(2, 4));
  const dd = Number(idNumber.slice(4, 6));
  const currentYear = new Date().getFullYear();
  const year = 2000 + yy <= currentYear ? 2000 + yy : 1900 + yy;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const iso = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getTime() > Date.now()) return null;
  // Guard against rollover (e.g. 0230 → Mar 02): the parsed date must match the inputs.
  if (d.getUTCMonth() + 1 !== mm || d.getUTCDate() !== dd) return null;
  return iso;
}

/** Plausibility floor for a self-asserted passport DOB (rejects obviously-bogus dates). */
export const MIN_DOB = '1920-01-01';

/**
 * Resolve a player's date of birth. SA citizens (default) derive it from the forgery-
 * resistant 13-digit RSA ID. Non-SA citizens (`idType: 'passport'`) supply it directly —
 * there is no oracle to derive it from a passport, so the client value is trusted, bounded
 * only by a future-date and plausibility-floor check. Returns null if it can't be resolved.
 */
export function resolvePlayerDob(body: Partial<PlayerRegistration>): string | null {
  if (body.idType === 'passport') {
    if (!body.dob) return null;
    const d = new Date(body.dob);
    if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() || body.dob < MIN_DOB) return null;
    return body.dob;
  }
  return dobFromSaId(body.idNumber!);
}

/** Normalise an ID for storage/matching — trims and upper-cases (passports are alphanumeric). */
export function normalizeId(idNumber: string | undefined): string {
  return (idNumber || '').trim().toUpperCase();
}

/** Whether a person with this ISO date of birth is under 18 right now. */
export function computeIsMinor(dob: string): boolean {
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return false;
  const eighteen = new Date(born);
  eighteen.setFullYear(eighteen.getFullYear() + 18);
  return eighteen.getTime() > Date.now();
}
