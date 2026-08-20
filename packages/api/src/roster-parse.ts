/**
 * Tenant-neutral player-roster spreadsheet parsing — the exceljs-coupled layer above
 * roster-normalize.ts's pure column/cell helpers. Moved out of import-titans-roster.ts
 * (self-serve onboarding, ADR 0009 follow-up) so the Titans CLI and a future operator
 * roster-intake route share one implementation (the normalizeDocMeta/player-identity
 * precedent) instead of drifting apart. The CLI keeps its shell — file walking, args,
 * REGISTERED_BY, revert — and calls `parseRosterSheet` per worksheet.
 *
 * PII: only ever returns a fully masked idNumber (`*************`) on an exception row,
 * never a partial or full one — see `maskId`.
 */
import ExcelJS from 'exceljs';
import type { PlayerRegistration } from './types.js';
import {
  findHeaderRow,
  cellString,
  cellDobIso,
  cleanIdCell,
  normalizeGender,
  normalizeRace,
  ageGroupToLeagueKey,
  splitFullName,
  collapseWhitespace,
  type HeaderMap,
} from './roster-normalize.js';
import { playerNaturalKey, dobFromSaId, computeIsMinor } from './player-identity.js';

/** Mask an RSA ID for any printed/returned output — never the full number (PII), and
 * never even a partial prefix: the first 6 digits of an RSA ID ARE a full date of birth,
 * and every exception carries `{sheet, rowNumber}`, which locates the source row
 * precisely — the DOB adds nothing operationally and is PII on its own. */
export function maskId(id: string): string {
  return '*'.repeat(id.length);
}

export interface RosterException {
  rowNumber: number;
  sheet: string;
  reason:
    | 'bad-id'
    | 'no-usable-identity'
    | 'bad-id-checksum'
    | 'unmapped-age-group'
    | 'missing-surname';
  maskedId?: string;
}

export interface RosterRow {
  player: PlayerRegistration;
  hadRealId: boolean;
  /** True when written only because of allowMissingId (a resolvable dob, no usable id). */
  missingId: boolean;
  /** Real sheet row number (ExcelJS's own numbering, matching RosterException.rowNumber) —
   * carried through so a caller building a review table (the operator roster wizard) can
   * reference the exact source row without re-deriving it from array position, which would
   * desync the moment an earlier row is filtered into exceptions. */
  rowNumber: number;
}

export interface ParseSheetResult {
  rows: RosterRow[];
  exceptions: RosterException[];
  totalDataRows: number;
  /**
   * Whether this sheet's header carried an ID-number column at all. Several clubs
   * submitted the "Date of Birth" variant of the union template instead (Adelaar,
   * Eersterust, Hammanskraal), where EVERY row is legitimately dob-only. Without this
   * flag those clubs report as hundreds of identical `bad-id` exceptions in strict
   * mode, which reads like corrupt data rather than "this club used the other form".
   */
  hasIdColumn: boolean;
  /** As-typed cell text for every gender value NormalizeResult couldn't recognise —
   * rolled into the per-club unknown-demographics report, never silently dropped. */
  unknownGenderRaw: string[];
  /** Same, for race. */
  unknownRaceRaw: string[];
  /** Distinct raw age-band strings seen on a junior sheet, each with the league key it
   * mapped to (or null when unmapped) — the data source for the operator's junior
   * age-band confirm table, and for surfacing bands `ageGroupToLeagueKey` can't place. */
  ageGroupRaws: Array<{ raw: string; leagueKey: string | null }>;
}

export function isJuniorHeader(columns: HeaderMap): boolean {
  return columns.ageGroup !== undefined;
}

export interface ParseRosterSheetOptions {
  allowMissingId: boolean;
  /** League keys eligible for a junior age-band mapping. The Titans CLI passes its fixed
   * u9/u11/u13/u15 set; a tenant-driven caller derives this from the tenant's own
   * leagues (`/^u\d+$/`). */
  juniorLeagueKeys: Set<string>;
  /** Raw age-band string → league key overrides (an operator's confirm-table edits).
   * Consulted before the `ageGroupToLeagueKey` heuristic; an override outside
   * `juniorLeagueKeys` is ignored (falls through to the heuristic/unmapped path) so a
   * caller can't smuggle in a league the tenant doesn't have. */
  ageGroupMap?: Record<string, string>;
}

/** Parse one worksheet's data rows into candidate PlayerRegistration rows + exceptions.
 * `allowMissingId` decides whether a resolvable-dob-but-no-ID row is INCLUDED here as a
 * dob-only row, or routed to the exception list — the caller still applies strict-mode
 * filtering identically either way via this single flag, so dry-run and confirm report
 * the exact same set. */
export function parseRosterSheet(
  ws: ExcelJS.Worksheet,
  clubId: string,
  runNow: string,
  options: ParseRosterSheetOptions,
): ParseSheetResult | null {
  const { allowMissingId, juniorLeagueKeys, ageGroupMap } = options;

  // eachRow SKIPS EMPTY ROWS, so the array index here is NOT the real sheet row number —
  // rowNumbers[] tracks ExcelJS's real (rowNumber) per collected row in parallel, so the
  // header row's TRUE sheet row number can be recovered below regardless of any blank
  // rows above/among the data (common in these hand-assembled workbooks).
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  ws.eachRow((row, rowNumber) => {
    const vals: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) vals.push(cellString(row.getCell(c).value));
    rows.push(vals);
    rowNumbers.push(rowNumber);
  });
  const header = findHeaderRow(rows);
  if (!header) return null;
  const headerRealRowNumber = rowNumbers[header.rowIndex];

  const result: ParseSheetResult = {
    rows: [],
    exceptions: [],
    totalDataRows: 0,
    hasIdColumn: header.columns.idNumber !== undefined,
    unknownGenderRaw: [],
    unknownRaceRaw: [],
    ageGroupRaws: [],
  };
  const junior = isJuniorHeader(header.columns);
  const ageGroupRawsSeen = new Map<string, string | null>();

  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRealRowNumber) return; // header row and anything at/above it

    let firstName: string;
    let lastName: string;
    if (header.columns.fullName !== undefined) {
      const split = splitFullName(cellString(row.getCell(header.columns.fullName + 1).value));
      firstName = split.firstName;
      lastName = split.lastName;
    } else {
      firstName = collapseWhitespace(
        cellString(row.getCell((header.columns.firstName ?? -1) + 1).value),
      );
      lastName = collapseWhitespace(
        cellString(row.getCell((header.columns.lastName ?? -1) + 1).value),
      );
      if (!lastName && firstName.includes(' ')) {
        // Adelaar's senior sheet is a template variant with the FULL NAME in the "Name"
        // column and the "Surname" column left blank ("Stephan Pretorius" + "") — split
        // the LAST word off as the surname, keeping a multi-word first name intact
        // ("Xavier Zinzan Sanna" → firstName "Xavier Zinzan", lastName "Sanna"), the same
        // reversible rule splitFullName already applies to a genuine combined-column
        // template. Fires ONLY when the surname cell is blank: a row where the surname
        // column HAS a value skips this branch entirely and is untouched, so the natural
        // keys of already-imported Titans prod players are unaffected — every one of
        // them came through with a populated surname column, and a blank-surname row like
        // this one previously FAILED the intake commit validator outright ("firstName and
        // lastName are required"), so no committed row ever had this shape to begin with.
        const split = splitFullName(firstName);
        firstName = split.firstName;
        lastName = split.lastName;
      }
    }
    if (!firstName && !lastName) return; // blank row — not counted, not an exception

    result.totalDataRows++;

    if (!lastName) {
      // A single-word name with no surname anywhere (column blank/absent, and nothing to
      // split) — never silently commit a half-named row. The commit validator requires
      // both firstName and lastName, so a row this module can't safely resolve becomes an
      // explicit exception the operator can see and fix at source, instead of one bad row
      // 400ing the whole club's batch.
      result.exceptions.push({ rowNumber, sheet: ws.name, reason: 'missing-surname' });
      return;
    }

    let idNumber: string | undefined;
    let dob: string | null = null;
    let hadRealId = false;
    let missingId = false;

    if (header.columns.idNumber !== undefined) {
      const raw = row.getCell(header.columns.idNumber + 1).value;
      const cleaned = cleanIdCell(raw, dobFromSaId);
      if (cleaned.kind === 'valid' || cleaned.kind === 'padded') {
        idNumber = cleaned.idNumber;
        dob = dobFromSaId(idNumber);
        hadRealId = true;
      } else if (cleaned.kind === 'date-mangled') {
        // The "ID" column is actually carrying a DOB (DACC's junior sheet, Sinoville's
        // senior sheet) — usable as dob-only identity, never as an idNumber.
        dob = cleaned.isoDate;
      } else if (cleaned.kind === 'bad-checksum') {
        // Date-plausible but the Luhn check digit doesn't match — the dominant error
        // mode in hand-typed member databases (transposed digits). Never promoted to a
        // usable id/naturalKey (a wrong checksum silently breaks future dedup) and never
        // auto-included as dob-only either — routed to the exception report under its
        // own reason so an operator can see the count and decide, regardless of
        // allowMissingId.
        result.exceptions.push({
          rowNumber,
          sheet: ws.name,
          reason: 'bad-id-checksum',
          maskedId: maskId(cleaned.idNumber),
        });
        return;
      }
      // cleaned.kind === 'invalid' → dob stays null unless a separate dob column below resolves it.
    }
    if (!dob && header.columns.dob !== undefined) {
      dob = cellDobIso(row.getCell(header.columns.dob + 1).value);
    }

    if (!hadRealId) {
      if (!dob) {
        // No valid ID AND no resolvable dob from any column — no identity to build a
        // player from at all (name alone is never enough for playerNaturalKey).
        result.exceptions.push({
          rowNumber,
          sheet: ws.name,
          reason: 'no-usable-identity',
        });
        return;
      }
      missingId = true;
      if (!allowMissingId) {
        result.exceptions.push({
          rowNumber,
          sheet: ws.name,
          reason: 'bad-id',
          maskedId: idNumber ? maskId(idNumber) : undefined,
        });
        return;
      }
    }

    const genderResult =
      header.columns.gender !== undefined
        ? normalizeGender(cellString(row.getCell(header.columns.gender + 1).value))
        : undefined;
    if (genderResult?.unknownRaw) result.unknownGenderRaw.push(genderResult.unknownRaw);
    const gender = genderResult?.value;
    const raceResult =
      header.columns.race !== undefined
        ? normalizeRace(cellString(row.getCell(header.columns.race + 1).value))
        : undefined;
    if (raceResult?.unknownRaw) result.unknownRaceRaw.push(raceResult.unknownRaw);
    const race = raceResult?.value;

    // team (league key) only for junior sheets — senior sheets carry no age-group column
    // and the platform has no per-team senior league key from this pack. A junior row
    // whose band maps to nothing is NEVER silently written team-less — it becomes an
    // `unmapped-age-group` exception, and every distinct raw band (mapped or not) is
    // recorded in ageGroupRaws for the operator's confirm table.
    let team: string | undefined;
    if (junior && header.columns.ageGroup !== undefined) {
      const rawAgeGroup = collapseWhitespace(
        cellString(row.getCell(header.columns.ageGroup + 1).value),
      );
      if (!ageGroupRawsSeen.has(rawAgeGroup)) {
        const override = ageGroupMap?.[rawAgeGroup];
        const mapped =
          override && juniorLeagueKeys.has(override)
            ? override
            : ageGroupToLeagueKey(rawAgeGroup, juniorLeagueKeys).value;
        ageGroupRawsSeen.set(rawAgeGroup, mapped ?? null);
      }
      team = ageGroupRawsSeen.get(rawAgeGroup) ?? undefined;
      if (!team) {
        result.exceptions.push({
          rowNumber,
          sheet: ws.name,
          reason: 'unmapped-age-group',
        });
        return;
      }
    }

    const base: Partial<PlayerRegistration> = {
      clubId,
      firstName,
      lastName,
      dob: dob!,
      idType: 'sa-id',
      ...(idNumber ? { idNumber } : {}),
    };
    // registeredBy is left for the caller to stamp — provenance is caller-specific (the
    // Titans CLI's `import:titans-compliance-2026` vs. a future intake route's
    // `intake:roster:<slug>:<date>:<operator>`), so this tenant-neutral module never
    // hardcodes it.
    const player: PlayerRegistration = {
      naturalKey: playerNaturalKey(base),
      clubId,
      firstName,
      lastName,
      dob: dob!,
      isMinor: computeIsMinor(dob!),
      consentAt: runNow,
      createdAt: runNow,
      registeredVia: 'portal',
      ...(idNumber ? { idNumber, idType: 'sa-id' } : {}),
      ...(gender ? { gender } : {}),
      ...(race ? { race } : {}),
      ...(team ? { team } : {}),
    };
    result.rows.push({ player, hadRealId, missingId, rowNumber });
  });

  result.ageGroupRaws = [...ageGroupRawsSeen].map(([raw, leagueKey]) => ({ raw, leagueKey }));
  return result;
}

// ───────────────────────── Cross-club duplicate ID detection ─────────────────────────

/**
 * Fail-closed: any player identity — id-based OR dob-only — claimed by more than one
 * club is reported and ALL claimants are excluded from writing, never a guess at which
 * club is authoritative.
 *
 * Matched on the resolved `naturalKey`, not the raw idNumber: under allowMissingId (the
 * documented CORRECT mode for the Titans pack — see the runbook) a dob-only row has no
 * idNumber at all, so keying on idNumber alone would silently exempt every dob-only
 * duplicate from this check, letting the same person land in two clubs' rosters.
 * naturalKey already encodes id-based identity as `sa-id-<id>` and dob-only identity as
 * a hash of name+dob, so this one map catches both without special-casing either.
 */
export function findCrossClubDuplicates(
  allRows: Array<{ clubId: string; clubName: string; row: RosterRow }>,
): { duplicateNaturalKeys: Set<string>; report: string[] } {
  const byKey = new Map<string, Array<{ clubId: string; clubName: string; row: RosterRow }>>();
  for (const entry of allRows) {
    const key = entry.row.player.naturalKey;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(entry);
  }
  const duplicateNaturalKeys = new Set<string>();
  const report: string[] = [];
  for (const [key, claimants] of byKey) {
    const distinctClubs = new Set(claimants.map((c) => c.clubId));
    if (distinctClubs.size <= 1) continue;
    const id = claimants[0].row.player.idNumber;
    // Never print a raw dob (PII) here — an id-based match is reported masked; a
    // dob-only match is reported without any identifying value at all.
    const identityLabel = id ? maskId(id) : 'dob-only match';
    report.push(
      `${identityLabel}: claimed by ${[...distinctClubs].map((cid) => claimants.find((c) => c.clubId === cid)!.clubName).join(', ')}`,
    );
    for (const { clubId } of claimants) duplicateNaturalKeys.add(`${clubId}::${key}`);
  }
  return { duplicateNaturalKeys, report };
}
