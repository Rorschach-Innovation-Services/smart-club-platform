/* ─── Typo- and order-tolerant name matching for player searches ─── */

/**
 * Mirrors `normalizeName` in packages/api/src/captain-lookup.ts (the frontend can't import
 * the API package): strip accents, lowercase, collapse whitespace. One deliberate divergence:
 * captain-lookup is an equality normalizer and deletes punctuation; here punctuation becomes a
 * space (a token boundary), so "Naidoo-Pillay" searches as two tokens.
 */
export const normalizeText = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Levenshtein distance, capped — only used to rescue near-miss spellings. */
export function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 'exact' = the whole query is a substring of the name, or every query token is a substring of a name token; 'fuzzy' = at least one needed a typo rescue. */
export type FuzzyTier = 'exact' | 'fuzzy';

// tol 2 at >=6 letters conflates some common SA surname families (naidoo/naidu-variants,
// pillay/pillai) — accepted because fuzzy hits rank after exact; tighten to >=7 if noisy.
const tolerance = (len: number) => (len < 4 ? 0 : len < 6 ? 1 : 2);

/**
 * Token-based, order-independent: every query token must match SOME name token (tokens may
 * be reused), by substring (prefix or infix) or within an edit-distance tolerance scaled to the token's length.
 * An empty query matches everything at tier 'exact'.
 */
export function fuzzyMatchName(query: string, name: string): FuzzyTier | null {
  const q0 = normalizeText(query);
  if (!q0) return 'exact';
  const n0 = normalizeText(name);
  // Fast pre-check: a whole-string fragment (incl. cross-token, e.g. "o nd") is an exact hit.
  if (n0.includes(q0)) return 'exact';
  const qTokens = q0.split(' ');
  const nTokens = n0.split(' ').filter(Boolean);
  let tier: FuzzyTier = 'exact';
  for (const q of qTokens) {
    if (nTokens.some((n) => n.includes(q))) continue;
    const tol = tolerance(q.length);
    if (tol > 0 && nTokens.some((n) => editDistance(q, n, tol) <= tol)) {
      tier = 'fuzzy';
      continue;
    }
    return null;
  }
  return tier;
}

/** Stable partition: exact-tier items first, fuzzy after, each keeping incoming order. */
export function byTier<T>(items: Array<{ item: T; tier: FuzzyTier }>): T[] {
  return [
    ...items.filter((x) => x.tier === 'exact').map((x) => x.item),
    ...items.filter((x) => x.tier === 'fuzzy').map((x) => x.item),
  ];
}
