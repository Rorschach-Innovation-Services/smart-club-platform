/**
 * Read-time detail for a held player review (ADR 0019), so the admin card can be decided
 * without opening two registrations side by side. A review stores only names, dob and club;
 * this loads the registration rows behind the subject and each smart-club candidate with
 * targeted point reads (club resolved by name, else one BatchGetItem across the tenant's clubs,
 * 100 keys per call) — never a table scan.
 *
 * Output never carries a full ID number: the last four characters and whether an SA ID passes
 * its checksum are enough to tell a typo from a different document.
 */
import { compactIdNumber, normalizeId } from '../player-identity.js';
import { luhnValid } from '../roster-normalize.js';
import type { Club, PlayerRegistration, PlayerSyncReview } from '../types.js';

/** What the card shows about one registration. Absent fields = no smart-club row found. */
export interface ReviewIdentityDetail {
  /** Last four characters of the stored ID number, or null when none is stored. */
  idLast4: string | null;
  /** SA ID passes its Luhn checksum (13 digits). Null for passports or no ID. */
  idValid: boolean | null;
  /** When the registration was created. */
  registeredAt: string | null;
  /** Keyed by an older scheme (not a sha256 of the ID) — usually an email-era registration. */
  legacyKey: boolean;
}

export interface ReviewCandidateDetail extends ReviewIdentityDetail {
  /** Same ID number as the held player once spaces and dashes are ignored. */
  sameIdIgnoringSpaces: boolean;
  /**
   * The fields that differ from the held player: `name`, `dob`, `club`, `id`. IDs equal once
   * spaces/dashes are ignored are NOT `id`; when they differ only in spacing the list carries
   * `id-spacing` instead (the card says "same ID apart from spacing").
   */
  diff: string[];
}

export interface ReviewDetailRepo {
  listClubs(tenant: string): Promise<Club[]>;
  getPlayer(tenant: string, clubId: string, naturalKey: string): Promise<PlayerRegistration | null>;
  batchGetPlayers(
    tenant: string,
    pairs: Array<{ clubId: string; naturalKey: string }>,
  ): Promise<{ rows: PlayerRegistration[]; unresolved: number }>;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** "S 0556434" and "S0556434" are the same document (compacted + normalised). */
const compactId = (id: string | undefined): string => normalizeId(compactIdNumber(id));

/** Checksum verdict: SA IDs only. */
export function idValidity(row: Pick<PlayerRegistration, 'idNumber' | 'idType'> | null) {
  const id = compactId(row?.idNumber);
  if (!id || row?.idType === 'passport') return null;
  return /^\d{13}$/.test(id) && luhnValid(id);
}

export function identityDetail(
  naturalKey: string,
  row: PlayerRegistration | null,
): ReviewIdentityDetail {
  const id = compactId(row?.idNumber);
  return {
    idLast4: id ? id.slice(-4) : null,
    idValid: idValidity(row),
    registeredAt: row?.createdAt ?? null,
    legacyKey: !SHA256_HEX.test(naturalKey),
  };
}

const norm = (v: string | null | undefined) => (v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Fields where the candidate differs from the subject (rows, else the review's own fields). */
export function diffFields(
  subject: {
    name: string;
    dob: string | null;
    club: string | null;
    row: PlayerRegistration | null;
  },
  cand: { name: string; dob: string | null; club: string | null; row: PlayerRegistration | null },
): string[] {
  const diff: string[] = [];
  if (norm(subject.name) !== norm(cand.name)) diff.push('name');
  if ((subject.dob ?? '') !== (cand.dob ?? '')) diff.push('dob');
  if (norm(subject.club) !== norm(cand.club)) diff.push('club');
  const a = (subject.row?.idNumber ?? '').trim().toUpperCase();
  const b = (cand.row?.idNumber ?? '').trim().toUpperCase();
  if (compactId(a) !== compactId(b)) diff.push('id');
  else if (a !== b) diff.push('id-spacing');
  return diff;
}

/** Newest active row, else newest of any status. */
function pick(rows: PlayerRegistration[]): PlayerRegistration | null {
  const sorted = [...rows].sort((a, b) =>
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
  );
  return sorted.find((r) => (r.status ?? 'active') === 'active') ?? sorted[0] ?? null;
}

/**
 * Loader with a per-request cache. Tries the club the review names first (one GetItem);
 * otherwise one BatchGetItem over the tenant's other clubs (≤100 keys per call).
 */
export function rowLoader(repo: ReviewDetailRepo, tenant: string) {
  let clubs: Promise<Club[]> | null = null;
  const cache = new Map<string, Promise<PlayerRegistration | null>>();
  const load = async (nk: string, clubName: string | null) => {
    clubs ??= repo.listClubs(tenant);
    const all = await clubs;
    const named = all.find((c) => norm(c.name) === norm(clubName));
    if (named) {
      const row = await repo.getPlayer(tenant, named.id, nk);
      if (row) return row;
    }
    const others = all.filter((c) => c !== named);
    if (!others.length) return null;
    const { rows } = await repo.batchGetPlayers(
      tenant,
      others.map((c) => ({ clubId: c.id, naturalKey: nk })),
    );
    return pick(rows);
  };
  return (nk: string, clubName: string | null) => {
    const key = `${nk}|${norm(clubName)}`;
    if (!cache.has(key)) cache.set(key, load(nk, clubName));
    return cache.get(key)!;
  };
}

/**
 * The review with detail added. Medicoach candidates (no smart-club row) are left as they are.
 * Keeps every candidate's `naturalKey` — the route strips it before responding.
 */
export async function enrichPlayerReview(
  review: PlayerSyncReview,
  load: ReturnType<typeof rowLoader>,
): Promise<
  PlayerSyncReview & {
    subject: ReviewIdentityDetail;
    candidates: Array<PlayerSyncReview['candidates'][number] & Partial<ReviewCandidateDetail>>;
  }
> {
  const subjectRow = await load(review.naturalKey, review.clubName);
  const subject = {
    name: review.playerName,
    dob: review.dob,
    club: review.clubName,
    row: subjectRow,
  };
  const candidates = await Promise.all(
    review.candidates.map(async (c) => {
      if (!c.naturalKey) return c;
      const row = await load(c.naturalKey, c.institutionName);
      const a = compactId(subjectRow?.idNumber);
      return {
        ...c,
        ...identityDetail(c.naturalKey, row),
        sameIdIgnoringSpaces: !!a && a === compactId(row?.idNumber),
        diff: diffFields(subject, { name: c.name, dob: c.dob, club: c.institutionName, row }),
      };
    }),
  );
  return { ...review, subject: identityDetail(review.naturalKey, subjectRow), candidates };
}
