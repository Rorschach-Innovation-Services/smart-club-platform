/**
 * Possible-match detection for official self-registrations (docs/api/officials.md). Most
 * people registering through the public link are already on the register without contact
 * details, so the admin is shown a RANKED list of candidates to merge into, never a single
 * guess: sheet names collide ("S.Naidoo" twice) and scorer names vary.
 *
 * Pure: shared by the API (GET /umpires, /scorers annotate pending records) and, if wanted,
 * the frontend.
 */
import { normaliseUmpireAlias } from './umpires.js';

export type PossibleMatchReason = 'phone' | 'name' | 'surname-initial';

export interface PossibleMatch {
  id: string;
  displayName: string;
  reason: PossibleMatchReason;
}

/** The fields the matcher reads; both Umpire and Scorer satisfy it. */
export interface MatchableOfficial {
  id: string;
  displayName: string;
  fullName?: string;
  aliases?: string[];
  phone?: string;
  active: boolean;
  mergedInto?: string;
  erasedAt?: string;
  pending?: true;
}

export const MAX_POSSIBLE_MATCHES = 5;

const RANK: Record<PossibleMatchReason, number> = { phone: 0, name: 1, 'surname-initial': 2 };

/** A South African number in one comparable form (0XXXXXXXXX), else its bare digits. */
export function comparablePhone(raw: string | undefined): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (/^27\d{9}$/.test(digits)) return `0${digits.slice(2)}`;
  return digits;
}

/**
 * First initial + surname of a name in either form the register uses: the sheet form
 * "A.Ngubane" / "A. Ngubane", or a full name "Andile Ngubane". The surname is the LAST
 * token; null when the name has fewer than two tokens.
 */
export function initialAndSurname(
  name: string | undefined,
): { initial: string; surname: string } | null {
  const tokens = (name ?? '')
    .split(/[\s.]+/)
    .map((t) => normaliseUmpireAlias(t))
    .filter(Boolean);
  if (tokens.length < 2) return null;
  return { initial: tokens[0][0], surname: tokens[tokens.length - 1] };
}

/** The umpire sheet form of a name: "Andile", "Ngubane" → "A.Ngubane". */
export function umpireSheetName(firstNames: string, surname: string): string {
  const first = firstNames.trim();
  return `${first.charAt(0).toUpperCase()}.${surname.trim()}`;
}

/**
 * Ranked candidates for one pending record: same phone, then an exact normalised name
 * (display/full name or an umpire alias), then the same surname + first initial. Only
 * ACTIVE, unmerged, unerased, non-pending records are candidates; at most `max`, best first,
 * ties by display name.
 */
export function findPossibleMatches(
  subject: Pick<MatchableOfficial, 'id' | 'displayName' | 'fullName' | 'phone'>,
  register: MatchableOfficial[],
  max = MAX_POSSIBLE_MATCHES,
): PossibleMatch[] {
  const phone = comparablePhone(subject.phone);
  const names = new Set(
    [subject.displayName, subject.fullName]
      .map((n) => normaliseUmpireAlias(n ?? ''))
      .filter(Boolean),
  );
  const parts = [subject.displayName, subject.fullName]
    .map(initialAndSurname)
    .filter((p): p is { initial: string; surname: string } => !!p);
  const out: PossibleMatch[] = [];
  for (const c of register) {
    if (c.id === subject.id || !c.active || c.mergedInto || c.erasedAt || c.pending) continue;
    let reason: PossibleMatchReason | null = null;
    if (phone && comparablePhone(c.phone) === phone) reason = 'phone';
    else {
      const keys = [c.displayName, c.fullName]
        .map((n) => normaliseUmpireAlias(n ?? ''))
        .concat(c.aliases ?? []);
      if (keys.some((k) => k && names.has(k))) reason = 'name';
      else {
        const theirs = [c.displayName, c.fullName].map(initialAndSurname);
        if (
          theirs.some(
            (t) => t && parts.some((p) => p.surname === t.surname && p.initial === t.initial),
          )
        )
          reason = 'surname-initial';
      }
    }
    if (reason) out.push({ id: c.id, displayName: c.displayName, reason });
  }
  return out
    .sort((a, b) => RANK[a.reason] - RANK[b.reason] || a.displayName.localeCompare(b.displayName))
    .slice(0, max);
}
