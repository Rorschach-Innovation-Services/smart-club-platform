/**
 * Scorer register — request validation for the routes in index.ts. Pure: no repo, no clock.
 *
 * The union's scorers, appointed per fixture (a scorer and a backup) on the officials item
 * beside the umpires (FIXOFFICIALS#, see keys.ts). Smart club only for now: medicoach has no
 * per-person fixture assignment (its scorers hold an institution-wide Scorer role), so this is
 * the union's roster of who scores which game. See docs/architecture/0017-match-week-office.md.
 */
import { HttpError } from './auth.js';
import type { Scorer } from './types.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ScorerInput {
  displayName?: string;
  fullName?: string | null;
  phone?: string | null;
  email?: string | null;
  active?: boolean;
}

function optionalText(body: Record<string, unknown>, key: string, max: number) {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw new HttpError(400, `${key} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${key} is too long`);
  return t || null;
}

/** Validate a POST (`create`) or PATCH (`patch`) body; `null`/'' clears an optional field. */
export function parseScorerInput(raw: unknown, mode: 'create' | 'patch'): ScorerInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HttpError(400, 'body must be an object');
  const body = raw as Record<string, unknown>;
  const out: ScorerInput = {};
  if (body.displayName !== undefined || mode === 'create') {
    if (typeof body.displayName !== 'string' || !body.displayName.trim())
      throw new HttpError(400, 'displayName is required');
    const name = body.displayName.trim().replace(/\s+/g, ' ');
    if (name.length > 80) throw new HttpError(400, 'displayName is too long');
    if (!/[\p{L}\p{N}]/u.test(name))
      throw new HttpError(400, 'displayName needs at least one letter or digit');
    out.displayName = name;
  }
  const fullName = optionalText(body, 'fullName', 120);
  if (fullName !== undefined) out.fullName = fullName;
  const phone = optionalText(body, 'phone', 30);
  if (phone !== undefined) out.phone = phone;
  const email = optionalText(body, 'email', 254);
  if (email !== undefined) {
    if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'email is not valid');
    out.email = email;
  }
  if (body.active !== undefined) {
    if (mode === 'create') throw new HttpError(400, 'a new scorer is always active');
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'active must be a boolean');
    out.active = body.active;
  }
  return out;
}

/** Deterministic id stem for a new scorer: `s-` + a slug of the display name. */
export function scorerIdFor(displayName: string): string {
  const slug = displayName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `s-${slug || 'scorer'}`;
}

/** Same name as an active scorer already in the register (case/spacing-insensitive)? */
export function findScorerNameClash(
  name: string,
  scorers: Scorer[],
  selfId?: string,
): Scorer | undefined {
  const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return scorers.find((x) => x.active && x.id !== selfId && key(x.displayName) === key(name));
}

/** Apply a validated input to a record (create: `base` is undefined). */
export function applyScorerInput(
  base: Scorer | undefined,
  input: ScorerInput,
  id: string,
  at: string,
): Scorer {
  const next: Scorer = {
    ...(base ?? { id, displayName: '', active: true, createdAt: at }),
    id,
    updatedAt: at,
  };
  if (input.displayName !== undefined) next.displayName = input.displayName;
  for (const k of ['fullName', 'phone', 'email'] as const) {
    const v = input[k];
    if (v === undefined) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  if (input.active !== undefined) next.active = input.active;
  return next;
}
