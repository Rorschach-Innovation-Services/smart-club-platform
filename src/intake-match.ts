/**
 * Pure matching for the operator bulk document intake — folder/file names in a client's
 * submission pack → (club, doc type) pairs the review table can render and the operator
 * can correct.
 *
 * Deliberately dumb and deliberately pure. Every client structures a pack differently, so
 * this never tries to be right: it scores candidates, exposes a confidence, and hands
 * anything below the bar to the review UI as `unmatched` for a human to resolve. The one
 * tunable lives on the tenant's own catalogue (`RequiredDoc.matchHints`) rather than in a
 * hardcoded alias table here — a new client tunes classification by editing its doc
 * catalogue in the operator console, not by shipping code.
 *
 * No React, no network: the wizard imports these, and intake-match.test.ts pins them.
 */
import type { RequiredDoc } from './types';

/** A club as the matcher needs to see it (the operator overview projection is a superset). */
export interface MatchClub {
  id: string;
  name: string;
}

/** One file pulled out of a zip or folder pick, before any matching. */
export interface IntakeFile {
  /** Stable per-file id (index-derived is fine — the UI keys rows on it). */
  id: string;
  /**
   * Path segments INSIDE the pack, outermost first, excluding the filename itself.
   * Carried in full (not just the first level) so a nested `Region/Club/file.pdf`
   * layout is one new strategy function rather than a re-plumb.
   */
  segments: string[];
  /** File name including extension. */
  name: string;
  size: number;
  /** Resolved MIME type (browsers report '' for .doc/.xls — callers resolve by extension). */
  mime: string;
}

export type MatchStatus =
  | 'ready'
  | 'unmatched-club'
  | 'unmatched-doc'
  | 'duplicate'
  | 'conflict'
  | 'too-large'
  | 'excluded';

export interface IntakeRow {
  file: IntakeFile;
  clubId: string | null;
  /** 1 = exact, descending through the tiers; 0 when unmatched. */
  clubConfidence: number;
  docKey: string | null;
  docConfidence: number;
  status: MatchStatus;
  /** Human-readable why, shown in the review table when the row isn't `ready`. */
  note?: string;
  /**
   * True when the resolved (club, doc) pair already has a stored single-file document —
   * committing this row DELETES the existing S3 object and replaces it. Status stays
   * `ready` (the match itself is fine; this is a policy flag, not a matching failure), so
   * callers must explicitly default such rows to excluded/needs-attention rather than
   * committing a silent replace. Never set for multi-file docs — those accumulate files,
   * they don't get replaced by one more. Set by `flagExistingDocs`.
   */
  replacesExisting?: boolean;
}

// Junk the OS or the archive format adds — never worth showing the operator.
const JUNK = /^(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini|~\$)/i;
/** Copy markers Windows/macOS/Drive append when a file is duplicated in a pack. */
const COPY_SUFFIX = /(\s*\(\d+\)|\s*-?\s*copy)+$/i;

/** True for files that should never reach the review table at all. */
export function isJunkFile(file: { name: string; segments?: string[] }): boolean {
  if (JUNK.test(file.name)) return true;
  return (file.segments ?? []).some((s) => JUNK.test(s));
}

/**
 * Lowercase, strip punctuation, drop generic club words, join. A frontend port of
 * `normaliseName` in packages/api/src/venue-clash.ts (the SPA can't import from
 * packages/api) — keep the stopword list in step with it. Distinguishing words are kept
 * on purpose: "Pretoria East" must never collapse onto "Pretoria".
 */
export function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !['cricket', 'club', 'clube', 'cc', 'association'].includes(w))
    .join('');
}

/** Filename stem with the extension and any "(1)"/" - Copy" marker removed. */
export function baseStem(fileName: string): string {
  const stem = fileName.replace(/\.[a-z0-9]+$/i, '');
  return stem.replace(COPY_SUFFIX, '').trim();
}

export interface ClubIndex {
  clubs: MatchClub[];
  byNorm: Map<string, MatchClub>;
  byId: Map<string, MatchClub>;
}

export function buildClubIndex(clubs: MatchClub[]): ClubIndex {
  const byNorm = new Map<string, MatchClub>();
  const byId = new Map<string, MatchClub>();
  for (const c of clubs) {
    // First writer wins: two clubs normalising alike is a data problem the operator
    // resolves in the review table, not something to silently pick a winner for.
    if (!byNorm.has(normalise(c.name))) byNorm.set(normalise(c.name), c);
    byId.set(c.id, c);
  }
  return { clubs, byNorm, byId };
}

/** Levenshtein distance, capped — only used to rescue near-miss spellings. */
function editDistance(a: string, b: string, cap: number): number {
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

/**
 * Resolve a raw label (a folder name, or a filename stem) to one of the tenant's clubs.
 * Tiers, most to least certain: exact normalised name → club id → the label containing
 * (or contained by) a club's normalised name → a small edit distance. Anything weaker is
 * unmatched — the review table's club picker is the accepted answer for alias-grade
 * mismatches (a pack folder called "DACC" for "Differently Abled Cricket Club" is not
 * something string distance should be guessing at).
 */
export function matchClub(
  raw: string,
  index: ClubIndex,
): { club: MatchClub | null; confidence: number } {
  const n = normalise(raw);
  if (!n) return { club: null, confidence: 0 };
  const exact = index.byNorm.get(n);
  if (exact) return { club: exact, confidence: 1 };
  const byId = index.byId.get(raw.trim().toLowerCase());
  if (byId) return { club: byId, confidence: 0.95 };
  // Containment, longest match wins so "pretoriaeast" beats "pretoria".
  let best: { club: MatchClub; score: number } | null = null;
  for (const c of index.clubs) {
    const cn = normalise(c.name);
    if (!cn) continue;
    if (n.includes(cn) || cn.includes(n)) {
      const score = Math.min(cn.length, n.length) / Math.max(cn.length, n.length);
      if (!best || cn.length > normalise(best.club.name).length) best = { club: c, score };
    }
  }
  if (best) return { club: best.club, confidence: 0.6 + 0.2 * best.score };
  // Last resort: one or two typos in a name of reasonable length.
  const cap = n.length >= 8 ? 2 : 1;
  let near: { club: MatchClub; dist: number } | null = null;
  for (const c of index.clubs) {
    const d = editDistance(n, normalise(c.name), cap);
    if (d <= cap && (!near || d < near.dist)) near = { club: c, dist: d };
  }
  if (near) return { club: near.club, confidence: 0.5 };
  return { club: null, confidence: 0 };
}

/**
 * Score a filename against one doc definition. `matchHints` carry the client-specific
 * vocabulary ("league entry", "databse" — clients misspell consistently); the doc's own
 * name and key are scored too so a catalogue with no hints still classifies the obvious
 * cases. Longer hits score higher, so "club health tracker" beats a bare "club".
 */
function scoreDoc(fileName: string, doc: RequiredDoc): number {
  const hay = ` ${fileName.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const candidates = [
    ...(doc.matchHints ?? []).map((h) => ({ term: h, weight: 1 })),
    { term: doc.name, weight: 0.8 },
    { term: doc.key.replace(/([a-z])([A-Z])/g, '$1 $2'), weight: 0.7 },
  ];
  let best = 0;
  for (const { term, weight } of candidates) {
    const t = term
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    if (!t) continue;
    if (hay.includes(` ${t} `) || hay.includes(`${t} `) || hay.includes(` ${t}`)) {
      // Length-scaled so a specific multi-word hit outranks a generic single word.
      best = Math.max(best, weight * Math.min(1, 0.4 + t.length / 25));
    }
  }
  return best;
}

/**
 * Classify a filename against the tenant's catalogue. Only active, file-kind docs are
 * candidates — a form doc has nothing to upload, and an archived one is no longer
 * collected. Ties and weak scores return null so the row lands in the review table.
 */
export function matchDoc(
  fileName: string,
  docs: RequiredDoc[],
): { doc: RequiredDoc | null; confidence: number } {
  const candidates = docs.filter((d) => !d.archived && d.kind !== 'form');
  const scored = candidates
    .map((doc) => ({ doc, score: scoreDoc(fileName, doc) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { doc: null, confidence: 0 };
  // An outright tie between two doc types is a genuine ambiguity — let a human pick.
  if (scored.length > 1 && scored[1].score === scored[0].score) return { doc: null, confidence: 0 };
  return { doc: scored[0].doc, confidence: scored[0].score };
}

/**
 * Flag rows whose files are the same document arriving twice — the "(1)" / " - Copy"
 * pairs every hand-assembled pack accumulates. Keyed on club + doc + copy-stripped stem
 * + byte size, so two genuinely different agreements are never collapsed. The FIRST
 * occurrence stays `ready`; later ones become `duplicate` (excluded by default, and the
 * operator can re-include any of them).
 */
export function findDuplicates(rows: IntakeRow[]): IntakeRow[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    if (row.status !== 'ready') return row;
    const key = `${row.clubId}|${row.docKey}|${normalise(baseStem(row.file.name))}|${row.file.size}`;
    if (seen.has(key)) {
      return { ...row, status: 'duplicate' as const, note: 'Looks like a copy of another file' };
    }
    seen.add(key);
    return row;
  });
}

/**
 * Flag two DIFFERENT files competing for the same single-file doc on one club — only one
 * can be stored, so the operator must exclude one (or the catalogue should make that doc
 * multi-file). Multi-file docs legitimately take many and are left alone.
 */
export function findConflicts(rows: IntakeRow[], docs: RequiredDoc[]): IntakeRow[] {
  const singleFile = new Set(docs.filter((d) => !d.multiFile).map((d) => d.key));
  const taken = new Set<string>();
  return rows.map((row) => {
    if (row.status !== 'ready' || !row.docKey || !singleFile.has(row.docKey)) return row;
    const key = `${row.clubId}|${row.docKey}`;
    if (taken.has(key)) {
      return {
        ...row,
        status: 'conflict' as const,
        note: 'Another file is already mapped to this document — only one can be stored',
      };
    }
    taken.add(key);
    return row;
  });
}

/**
 * Flag rows whose resolved (club, doc) pair already has a stored single-file document.
 * `findConflicts` only catches two files IN THE BATCH competing for one doc slot — this
 * catches the batch colliding with what the club ALREADY has on record, which committing
 * would silently overwrite (and S3-delete the prior object). Only single-file docs are
 * checked: a multi-file doc's existing files are additive, never replaced by one more.
 * Status is left `ready` on purpose — callers own the "needs explicit opt-in" policy via
 * `replacesExisting`, this function only detects the fact.
 */
export function flagExistingDocs(
  rows: IntakeRow[],
  docs: RequiredDoc[],
  hasExistingDoc: (clubId: string, docKey: string) => boolean,
): IntakeRow[] {
  const singleFile = new Set(docs.filter((d) => !d.multiFile).map((d) => d.key));
  return rows.map((row) => {
    const replaces =
      row.status === 'ready' &&
      !!row.clubId &&
      !!row.docKey &&
      singleFile.has(row.docKey) &&
      hasExistingDoc(row.clubId, row.docKey);
    if (!replaces) {
      return row.replacesExisting ? { ...row, replacesExisting: false } : row;
    }
    return {
      ...row,
      replacesExisting: true,
      note: row.note ?? 'Already uploaded for this club — including this will replace it',
    };
  });
}

/** 10 MB — mirrors MAX_DOC_BYTES on the API; a bigger file can't be recorded. */
export const MAX_INTAKE_BYTES = 10 * 1024 * 1024;

/**
 * A pack layout. Each strategy turns raw files into rows; adding a client-specific
 * layout means adding one function here, not touching the wizard. Every strategy
 * receives the FULL path segments, so nesting is a matter of which segment it reads.
 */
export interface IntakeStrategy {
  key: string;
  label: string;
  hint: string;
  run: (files: IntakeFile[], index: ClubIndex, docs: RequiredDoc[]) => IntakeRow[];
}

function baseRow(file: IntakeFile): IntakeRow {
  return {
    file,
    clubId: null,
    clubConfidence: 0,
    docKey: null,
    docConfidence: 0,
    status: 'ready',
  };
}

/** Apply club+doc results and the size gate to one row. */
function settle(
  row: IntakeRow,
  club: { club: MatchClub | null; confidence: number },
  doc: { doc: RequiredDoc | null; confidence: number },
): IntakeRow {
  const next: IntakeRow = {
    ...row,
    clubId: club.club?.id ?? null,
    clubConfidence: club.confidence,
    docKey: doc.doc?.key ?? null,
    docConfidence: doc.confidence,
  };
  if (next.file.size > MAX_INTAKE_BYTES) {
    return { ...next, status: 'too-large', note: 'Over the 10 MB limit' };
  }
  if (!next.clubId) return { ...next, status: 'unmatched-club', note: 'Pick a club' };
  if (!next.docKey) return { ...next, status: 'unmatched-doc', note: 'Pick a document type' };
  return next;
}

/**
 * Folder-per-club: the club name is a directory, the doc type is in the filename. The
 * DEEPEST segment that resolves to a club wins, so `Region/Club/file.pdf` and
 * `Club/file.pdf` both work without a separate nested strategy.
 */
const folderPerClub: IntakeStrategy = {
  key: 'folder-per-club',
  label: 'One folder per club',
  hint: 'Each club has its own folder; the document type comes from the file name.',
  run: (files, index, docs) =>
    files.map((file) => {
      let best: { club: MatchClub | null; confidence: number } = { club: null, confidence: 0 };
      for (const seg of file.segments) {
        const hit = matchClub(seg, index);
        if (hit.club && hit.confidence >= best.confidence) best = hit;
      }
      return settle(baseRow(file), best, matchDoc(file.name, docs));
    }),
};

/**
 * Flat: everything in one directory, the club name embedded in the file name. Matched
 * against the copy-stripped stem so "PHSOB Club Health Tracker (1).xlsx" still resolves.
 */
const flat: IntakeStrategy = {
  key: 'flat',
  label: 'All files together',
  hint: 'No folders — the club name is part of each file name.',
  run: (files, index, docs) =>
    files.map((file) =>
      settle(baseRow(file), matchClub(baseStem(file.name), index), matchDoc(file.name, docs)),
    ),
};

export const INTAKE_STRATEGIES: IntakeStrategy[] = [folderPerClub, flat];

/**
 * Full pass: strategy → duplicate detection → single-file conflict detection. Junk files
 * are dropped before matching so they never reach the operator.
 */
export function buildRows(
  files: IntakeFile[],
  index: ClubIndex,
  docs: RequiredDoc[],
  strategyKey: string,
): IntakeRow[] {
  const strategy = INTAKE_STRATEGIES.find((s) => s.key === strategyKey) ?? folderPerClub;
  const usable = files.filter((f) => !isJunkFile(f) && f.size > 0);
  return findConflicts(findDuplicates(strategy.run(usable, index, docs)), docs);
}

/** Rows the commit step will actually act on. */
export const committableRows = (rows: IntakeRow[]): IntakeRow[] =>
  rows.filter((r) => r.status === 'ready' && r.clubId && r.docKey);
