/**
 * EMCU club codes — the short, readable code each EMCU club's MediCoach scorer logins are built
 * from (`scorer<n>.<code>@medicoach.co.za`). The table lives in `emcu-club-codes.json` (SC club
 * id → code), committed here and ALSO read by the MediCoach `create-emcu-scorers` script, so a
 * code is the same on both sides. Codes are per CLUB ID: Simplex's lettered sides (A/B/C) all
 * map to the one `simplex-reservoir-hills-crimson` club and share its code.
 *
 * PURE apart from `loadClubCodes` (one file read). No AWS, no notify modules.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** A club code: 3–8 lowercase letters/digits (the local-part after `scorer<n>.`). */
export const CLUB_CODE_RE = /^[a-z0-9]{3,8}$/;

/** The committed table's path (the CLI's `--codes` default). */
export const DEFAULT_CLUB_CODES_PATH = fileURLToPath(
  new URL('./emcu-club-codes.json', import.meta.url),
);

/**
 * Problems with a club-code table: not a flat string→string object, a code outside
 * `[a-z0-9]{3,8}`, a code used by two clubs, or a required club id with no code. Extra ids
 * (e.g. a club that joined an EMCU league after the workbook) are allowed. Empty ⇒ valid. PURE.
 */
export function validateClubCodes(table: unknown, requiredClubIds: readonly string[]): string[] {
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    return ['club-code table must be a JSON object of clubId → code'];
  }
  const problems: string[] = [];
  const byCode = new Map<string, string[]>();
  for (const [clubId, code] of Object.entries(table as Record<string, unknown>)) {
    if (typeof code !== 'string') {
      problems.push(`${clubId}: code must be a string`);
      continue;
    }
    if (!CLUB_CODE_RE.test(code)) problems.push(`${clubId}: code "${code}" is not [a-z0-9]{3,8}`);
    byCode.set(code, [...(byCode.get(code) ?? []), clubId]);
  }
  for (const [code, ids] of byCode) {
    if (ids.length > 1) problems.push(`code "${code}" is used by ${ids.join(', ')}`);
  }
  const have = table as Record<string, unknown>;
  for (const id of [...new Set(requiredClubIds)].sort()) {
    if (typeof have[id] !== 'string') problems.push(`${id}: no club code`);
  }
  return problems;
}

/** Read a club-code table from disk (unvalidated — run `validateClubCodes` on it). */
export async function loadClubCodes(
  path: string = DEFAULT_CLUB_CODES_PATH,
): Promise<Record<string, string>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, string>;
}
