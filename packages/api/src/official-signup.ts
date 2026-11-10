/**
 * Official self-registration (public `POST /official-signup?t=`) and the pending-merge plan
 * (`POST /umpires/:id/merge`, `/scorers/:id/merge` with a pending source). Contract:
 * docs/api/officials.md. Pure: no repo, no Hono context, no clock.
 */
import { randomUUID } from 'node:crypto';
import { HttpError } from './auth.js';
import { comparablePhone, umpireSheetName } from '../../engine/src/officialMatches.js';
import type { Scorer, Umpire } from './types.js';

export type SignupRole = 'umpire' | 'scorer';

export const isSignupRole = (r: unknown): r is SignupRole => r === 'umpire' || r === 'scorer';

/** Submissions per token per hour: a link posted to a big WhatsApp group must not throttle. */
export const OFFICIAL_SIGNUPS_PER_HOUR = 120;

/** Pending records per role per tenant: a ceiling on a flood of NEW registrations. */
export const MAX_PENDING_OFFICIALS = 300;

const NAME_PART_MAX = 60;
const DISPLAY_MAX = 80;
const FULL_MAX = 120;

/**
 * The register-create body (fed to parseUmpireInput / parseScorerInput, which enforce the
 * remaining limits) built from a public submission. Throws 400 on anything invalid.
 */
export function signupBodyFrom(
  raw: unknown,
  role: SignupRole,
  normalizeCell: (s: string) => string | null,
): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HttpError(400, 'invalid request body');
  const b = raw as Record<string, unknown>;
  const text = (k: string) => {
    const v = b[k];
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') throw new HttpError(400, `${k} must be text`);
    return v.trim().replace(/\s+/g, ' ');
  };
  const firstNames = text('firstNames');
  const surname = text('surname');
  if (!firstNames || !surname) throw new HttpError(400, 'first names and surname are required');
  if (!/[\p{L}\p{N}]/u.test(firstNames) || !/[\p{L}\p{N}]/u.test(surname))
    throw new HttpError(400, 'names need at least one letter');
  if (firstNames.length > NAME_PART_MAX || surname.length > NAME_PART_MAX)
    throw new HttpError(400, `names must be ${NAME_PART_MAX} characters or fewer`);
  if (b.consent !== true)
    throw new HttpError(400, 'please confirm consent to the register holding your details');
  const fullName = `${firstNames} ${surname}`;
  const displayName = role === 'umpire' ? umpireSheetName(firstNames, surname) : fullName;
  if (fullName.length > FULL_MAX || displayName.length > DISPLAY_MAX)
    throw new HttpError(400, 'that name is too long for the register');
  const phoneRaw = text('phone');
  if (!phoneRaw) throw new HttpError(400, 'a cell number is required');
  const phone = normalizeCell(phoneRaw);
  if (!phone) throw new HttpError(400, 'phone must be a valid South African cell number');
  const out: Record<string, string> = { displayName, fullName, phone };
  const email = text('email');
  if (email) out.email = email.toLowerCase();
  if (role === 'scorer') {
    const idNumber = text('idNumber');
    if (idNumber) out.idNumber = idNumber;
    const address = text('address');
    if (address) out.address = address;
    const emergency = text('emergencyPhone');
    if (emergency) {
      const n = normalizeCell(emergency);
      if (!n) throw new HttpError(400, 'emergencyPhone must be a valid South African cell number');
      out.emergencyPhone = n;
    }
  }
  return out;
}

export type ContactField = 'phone' | 'email';
export type ContactChoice = Partial<Record<ContactField, 'source' | 'target'>>;

export interface ContactConflict {
  field: ContactField;
  source: string;
  target: string;
}

/** Validate the optional `contact` choice of a pending-merge body. */
export function parseContactChoice(raw: unknown): ContactChoice {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new HttpError(400, 'contact must be an object');
  const out: ContactChoice = {};
  for (const f of ['phone', 'email'] as const) {
    const v = (raw as Record<string, unknown>)[f];
    if (v === undefined) continue;
    if (v !== 'source' && v !== 'target')
      throw new HttpError(400, `contact.${f} must be 'source' or 'target'`);
    out[f] = v;
  }
  return out;
}

const sameValue = (field: string, a: string, b: string) =>
  field === 'phone' || field === 'emergencyPhone'
    ? comparablePhone(a) === comparablePhone(b)
    : field === 'email'
      ? a.trim().toLowerCase() === b.trim().toLowerCase()
      : a === b;

/**
 * Fill the target's blank fields from a pending submission. Phone/email the target already
 * holds with a DIFFERENT value need an explicit choice; without one the conflicts come back
 * and nothing is applied. Other held fields always keep the target's value. Aliases are never
 * moved; consentAt and source are carried.
 */
export function planPendingMerge<T extends Umpire | Scorer>(
  role: SignupRole,
  source: T,
  target: T,
  choice: ContactChoice,
  at: string,
): { next: T; conflicts: ContactConflict[] } {
  const fields =
    role === 'scorer'
      ? (['fullName', 'phone', 'email', 'idNumber', 'emergencyPhone', 'address'] as const)
      : (['fullName', 'phone', 'email'] as const);
  const next = { ...target, updatedAt: at } as T & Record<string, unknown>;
  const conflicts: ContactConflict[] = [];
  for (const f of fields) {
    const sv = (source as unknown as Record<string, unknown>)[f] as string | undefined;
    const tv = (target as unknown as Record<string, unknown>)[f] as string | undefined;
    if (!sv) continue;
    if (!tv) {
      next[f] = sv;
      continue;
    }
    if (sameValue(f, sv, tv)) continue;
    if (f === 'phone' || f === 'email') {
      const c = choice[f];
      if (!c) conflicts.push({ field: f, source: sv, target: tv });
      else if (c === 'source') next[f] = sv;
    }
  }
  if (source.consentAt) next.consentAt = source.consentAt;
  if (source.source) next.source = source.source;
  return { next: next as T, conflicts };
}

/**
 * Create under the id stem, or a suffixed id when the stem is taken. Two same-name
 * submissions can race past the `taken` snapshot, so an id collision on the conditional
 * create (`isCollision`) retries with a fresh suffix, at most 5 times, instead of failing the
 * public request. Returns the id written.
 */
export async function createWithFreshId(
  stem: string,
  taken: Set<string>,
  create: (id: string) => Promise<unknown>,
  isCollision: (err: unknown) => boolean,
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = attempt === 0 && !taken.has(stem) ? stem : `${stem}-${randomUUID().slice(0, 6)}`;
    try {
      await create(id);
      return id;
    } catch (err) {
      if (!isCollision(err)) throw err;
    }
  }
  throw new HttpError(503, 'please try again');
}
