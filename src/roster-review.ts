/**
 * Roster wizard — pure review/decision module (2.1). No React, no network: every
 * live number the roster wizard shows (per-club summaries, cross-club duplicate
 * pairs, the committable count on the Continue/Commit buttons) is derived here so
 * the wizard component stays a thin DOM/network shell, exactly the platform-intake
 * precedent (buildRows/findDuplicates/findConflicts in intake-match.ts).
 *
 * ── CROSS-CLUB DUPLICATE PARITY ──
 * `detectCrossClubDuplicates` is a hand-port of the server's
 * `findCrossClubDuplicates` (packages/api/src/roster-parse.ts) — src/ cannot import
 * packages/api, so the grouping rule is reproduced here rather than shared as code.
 * Parity is pinned by shared-fixtures/cross-club-duplicates.json, asserted
 * identically by this module's test suite and the server's, so an operator-resolved
 * conflict never resurfaces as a server-side exclusion (or vice versa). The rule:
 * a player identity is id-based (`sa-id-<id>`, normalized/lowercased) when an
 * idNumber is present, else dob-only (name+dob, normalized/lowercased) — an
 * id-based identity NEVER pairs with a dob-only identity even when the name+dob
 * happen to match, because one row structurally can't prove the other is the same
 * person (see shared-fixtures' rows 7/8 note). Two rows conflict only when their
 * identity is claimed by MORE THAN ONE club.
 */
import type { RosterDraftRow, RosterIntakeException, RosterIntakeParseResponse } from './types';

/* ─── Row identity ─── */

/** Stable key for one draft row within a club's parse — `clubId::sheet::rowNumber`.
 *  Used as the decision-reducer key and the duplicate-group row key. */
export function rosterRowKey(clubId: string, sheet: string, rowNumber: number): string {
  return `${clubId}::${sheet}::${rowNumber}`;
}

/* ─── Per-club summaries (review step) ─── */

/** One club's parse result plus the operator's current per-club inputs — the
 *  wizard's per-club state, fed straight into buildClubSummaries. */
export interface ClubParseState {
  clubId: string;
  clubName: string;
  /** Undefined while the club hasn't been parsed yet (not selected, or still queued). */
  parse?: RosterIntakeParseResponse;
  allowMissingId: boolean;
}

/** Exception counts grouped by machine `reason` key (e.g. 'missing-id',
 *  'bad-checksum', 'unmapped-age-group') — drives the review screen's exception
 *  pills, one pill per reason present. */
export type ExceptionsByReason = Record<string, number>;

export interface ClubSummary {
  clubId: string;
  clubName: string;
  /** False when parse hasn't run yet, or the stored file is unparseable (PDF/scan). */
  parseable: boolean;
  /** Present when `parseable` is false — the server's `reason`, or 'not-parsed-yet'. */
  reason?: string;
  totalDataRows: number;
  validRowCount: number;
  exceptionsByReason: ExceptionsByReason;
  totalExceptions: number;
  dobOnlyCount: number;
  /** 'dob-variant' when every sheet that carried rows has no ID column — the trigger
   *  for the "No ID column — DOB variant" template pill and the allowMissingId
   *  auto-suggest. 'standard' otherwise (including the not-yet-parsed/unparseable
   *  cases, where there's nothing to judge the template from). */
  template: 'standard' | 'dob-variant';
  unknownGenderRaw: string[];
  unknownRaceRaw: string[];
  /** The count shown beside the allowMissingId toggle — this club's `missing-id`
   *  exception count specifically (not the total exception count). */
  missingIdExceptionCount: number;
  allowMissingId: boolean;
}

function countExceptionsByReason(exceptions: RosterIntakeException[]): ExceptionsByReason {
  const out: ExceptionsByReason = {};
  for (const e of exceptions) out[e.reason] = (out[e.reason] ?? 0) + 1;
  return out;
}

/** Per-club summary rows for the review step's summary table — one row per club,
 *  independent of whether it's currently expanded to row-level detail. */
export function buildClubSummaries(clubs: ClubParseState[]): ClubSummary[] {
  return clubs.map((c): ClubSummary => {
    const base = {
      clubId: c.clubId,
      clubName: c.clubName,
      allowMissingId: c.allowMissingId,
    };
    const parse = c.parse;
    if (!parse) {
      return {
        ...base,
        parseable: false,
        reason: 'not-parsed-yet',
        totalDataRows: 0,
        validRowCount: 0,
        exceptionsByReason: {},
        totalExceptions: 0,
        dobOnlyCount: 0,
        template: 'standard',
        unknownGenderRaw: [],
        unknownRaceRaw: [],
        missingIdExceptionCount: 0,
      };
    }
    if (!parse.parseable) {
      return {
        ...base,
        parseable: false,
        reason: (parse as { parseable: false; reason: string }).reason,
        totalDataRows: 0,
        validRowCount: 0,
        exceptionsByReason: {},
        totalExceptions: 0,
        dobOnlyCount: 0,
        template: 'standard',
        unknownGenderRaw: [],
        unknownRaceRaw: [],
        missingIdExceptionCount: 0,
      };
    }
    const sheetsWithRows = parse.sheets.filter((s) => !s.skipped && s.totalDataRows > 0);
    const template: ClubSummary['template'] =
      sheetsWithRows.length > 0 && sheetsWithRows.every((s) => !s.hasIdColumn)
        ? 'dob-variant'
        : 'standard';
    const allExceptions = parse.sheets.flatMap((s) => s.exceptions);
    const exceptionsByReason = countExceptionsByReason(allExceptions);
    return {
      ...base,
      parseable: true,
      totalDataRows: parse.sheets.reduce((n, s) => n + s.totalDataRows, 0),
      validRowCount: parse.sheets.reduce((n, s) => n + s.rows.length, 0),
      exceptionsByReason,
      totalExceptions: allExceptions.length,
      dobOnlyCount: parse.dobOnlyCount,
      template,
      unknownGenderRaw: [...new Set(parse.sheets.flatMap((s) => s.unknownGenderRaw))],
      unknownRaceRaw: [...new Set(parse.sheets.flatMap((s) => s.unknownRaceRaw))],
      missingIdExceptionCount: exceptionsByReason['missing-id'] ?? 0,
    };
  });
}

/* ─── Cross-club duplicate detection (hand-port of the server) ─── */

export interface DuplicateCandidateRow {
  clubId: string;
  clubName: string;
  firstName: string;
  lastName: string;
  dob: string;
  idNumber?: string;
}

export interface CrossClubDuplicateGroup<T extends DuplicateCandidateRow = DuplicateCandidateRow> {
  /** Not the server's sha256 natural key — a plain, human-legible identity string is
   *  all a client-side grouping key needs (never compared against the server's
   *  hashed value, only used to group rows within this one pass). */
  identityKey: string;
  rows: T[];
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** The row's grouping identity — id-based when an idNumber is present, dob-only
 *  otherwise. Mirrors packages/api's playerNaturalKey format (`sa-id-<id>` vs
 *  `firstName-lastName-dob`) without hashing, and deliberately keeps the two
 *  formats non-overlapping so an id-based identity can never collide with a
 *  dob-only one. */
function identityKey(r: DuplicateCandidateRow): string {
  return r.idNumber
    ? `id:${normalize(r.idNumber)}`
    : `dob:${normalize(r.firstName)}|${normalize(r.lastName)}|${r.dob}`;
}

/** Groups of rows whose identity is claimed by more than one club — the in-batch
 *  half of the server's cross-club duplicate check (the other half, an
 *  already-registered player elsewhere, can only be known server-side and comes
 *  back as `crossClubConflicts` on the commit response). Rows sharing an identity
 *  WITHIN one club are not reported (within-club dedupe is a separate concern). */
export function detectCrossClubDuplicates<T extends DuplicateCandidateRow>(
  rows: T[],
): CrossClubDuplicateGroup<T>[] {
  const byKey = new Map<string, T[]>();
  for (const row of rows) {
    const key = identityKey(row);
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }
  const groups: CrossClubDuplicateGroup<T>[] = [];
  for (const [key, claimants] of byKey) {
    if (new Set(claimants.map((r) => r.clubId)).size <= 1) continue;
    groups.push({ identityKey: key, rows: claimants });
  }
  return groups;
}

/* ─── Decision reducer ─── */

export type RowDecision = 'include' | 'exclude';

/** Per-row include/exclude overrides, keyed by `rosterRowKey`. Rows absent from
 *  this map default to 'include' (parsed rows with no exception are committable
 *  by default; the review screen only needs to record deviations). */
export type RosterDecisions = Record<string, RowDecision>;

export type RosterDecisionAction =
  | { type: 'include'; key: string }
  | { type: 'exclude'; key: string }
  /** "Keep-in-A" / "Keep-in-B" (or the Nth side of an N-way conflict): keep exactly
   *  one row of a duplicate group, exclude every other row in that group. */
  | { type: 'keep-only'; groupKeys: string[]; keep: string }
  /** "Exclude both" (or "exclude all" for an N-way conflict). */
  | { type: 'exclude-group'; groupKeys: string[] };

/** Applies one operator decision to the decisions map, returning a new map
 *  (never mutates the input — safe to use directly as a useState updater). */
export function applyRosterDecision(
  state: RosterDecisions,
  action: RosterDecisionAction,
): RosterDecisions {
  switch (action.type) {
    case 'include':
      return { ...state, [action.key]: 'include' };
    case 'exclude':
      return { ...state, [action.key]: 'exclude' };
    case 'keep-only': {
      const next = { ...state };
      for (const key of action.groupKeys) next[key] = key === action.keep ? 'include' : 'exclude';
      return next;
    }
    case 'exclude-group': {
      const next = { ...state };
      for (const key of action.groupKeys) next[key] = 'exclude';
      return next;
    }
    default:
      return state;
  }
}

/** True once every row in the group has an explicit decision recorded — the
 *  Continue-blocking condition ("Continue blocked until all resolved"). A group
 *  with no decisions recorded yet is unresolved, even though every row defaults
 *  to 'include' (an unexamined conflict is not a resolved one). */
export function isDuplicateGroupResolved<
  T extends { clubId: string; sheet: string; rowNumber: number },
>(group: { rows: T[] }, decisions: RosterDecisions): boolean {
  return group.rows.every(
    (r) => decisions[rosterRowKey(r.clubId, r.sheet, r.rowNumber)] !== undefined,
  );
}

/* ─── Committable counts (drives every live number) ─── */

export interface RosterCommittableRow {
  clubId: string;
  sheet: string;
  rowNumber: number;
}

export interface CommittableCounts {
  totalRows: number;
  includedRows: number;
  excludedRows: number;
  duplicateGroups: number;
  unresolvedDuplicateGroups: number;
  /** The number that actually goes to commit: included rows, but ONLY once every
   *  duplicate group is resolved — mirrors the review screen's Continue gate so the
   *  commit button and the Continue button never disagree on what's ready. */
  committable: number;
}

export function committableCounts(
  rows: RosterCommittableRow[],
  decisions: RosterDecisions,
  duplicateGroups: CrossClubDuplicateGroup<RosterCommittableRow & DuplicateCandidateRow>[],
): CommittableCounts {
  let includedRows = 0;
  for (const r of rows) {
    const key = rosterRowKey(r.clubId, r.sheet, r.rowNumber);
    if ((decisions[key] ?? 'include') === 'include') includedRows++;
  }
  const unresolvedDuplicateGroups = duplicateGroups.filter(
    (g) => !isDuplicateGroupResolved(g, decisions),
  ).length;
  return {
    totalRows: rows.length,
    includedRows,
    excludedRows: rows.length - includedRows,
    duplicateGroups: duplicateGroups.length,
    unresolvedDuplicateGroups,
    committable: unresolvedDuplicateGroups === 0 ? includedRows : 0,
  };
}
