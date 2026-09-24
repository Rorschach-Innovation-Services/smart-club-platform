/**
 * Tuskers roster parsing — the colMap-driven layer between the real KZN Inland workbooks
 * and PlayerRegistration rows. Pure apart from `worksheetToGrid` (a thin exceljs
 * adapter); everything else takes plain `SheetGrid`s so test/import-tuskers-roster.test.ts
 * can drive it with synthetic rows (the real rolls are PII).
 *
 * Deliberately NOT `parseRosterSheet` (roster-parse.ts): its fuzzy header detection
 * targets the Titans union template, and here the TEAM comes from the SHEET, not an
 * age-group column. Each source instead declares its exact header row (`header`) and an
 * explicit header-cell → field map (`colMap`) in tuskers-import-map.ts; the header is
 * asserted cell-for-cell and any drift aborts. Identity semantics are REUSED, never
 * reimplemented: cleanIdCell/cellDobIso/normalize* from roster-normalize.ts and
 * playerNaturalKey/dobFromSaId/computeIsMinor from player-identity.ts — the same helpers
 * the Titans import and the registration routes use, so natural keys can never drift.
 *
 * PII: exceptions only ever carry a fully masked id (`maskId`), never a partial one, and
 * no dob or name is ever put in a report line — `<sheet> row <n>` locates the source row.
 */
import type ExcelJS from 'exceljs';
import type { PlayerRegistration } from './types.js';
import {
  cellString,
  cellDobIso,
  cleanIdCell,
  collapseWhitespace,
  normalizeGender,
  normalizeRace,
  splitFullName,
} from './roster-normalize.js';
import { playerNaturalKey, dobFromSaId, computeIsMinor, MIN_DOB } from './player-identity.js';
import { maskId, type RosterException, type RosterRow } from './roster-parse.js';
import type { RosterSheetSpec, RosterSource, TuskersRosterField } from './tuskers-import-map.js';

/** Provenance stamped on every imported player; revert deletes exactly these. Same
 * marker as the compliance import's audit actor. */
export const REGISTERED_BY = 'import:tuskers-compliance-2026';

// ───────────────────────── Grid ─────────────────────────

/** One worksheet as plain data. `cells[0]` is column A; `rowNumber` is the real 1-based
 * sheet row (blank rows are simply absent, as with exceljs' eachRow). */
export interface SheetGrid {
  name: string;
  rows: Array<{ rowNumber: number; cells: unknown[] }>;
}

export function worksheetToGrid(ws: ExcelJS.Worksheet): SheetGrid {
  const rows: SheetGrid['rows'] = [];
  ws.eachRow((row, rowNumber) => {
    const cells: unknown[] = [];
    for (let c = 1; c <= ws.columnCount; c++) cells.push(row.getCell(c).value);
    rows.push({ rowNumber, cells });
  });
  return { name: ws.name, rows };
}

// ───────────────────────── Spec validation + header assertion ─────────────────────────

/**
 * Static sanity of the ROSTER_SOURCES config itself (pure — unit-tested and re-checked by
 * the CLI): every colMap key is a header cell exactly once, a sheet names either a
 * fullName column or a firstName+lastName pair, no field is mapped twice, and every
 * league key is in `allowedLeagueKeys`.
 */
export function rosterSourceProblems(
  sources: RosterSource[],
  allowedLeagueKeys: Set<string>,
): string[] {
  const problems: string[] = [];
  for (const src of sources) {
    const seenSheets = new Set<string>();
    for (const sheet of src.sheets) {
      const where = `${src.file} [${sheet.name}]`;
      if (seenSheets.has(sheet.name)) problems.push(`${where}: sheet listed twice`);
      seenSheets.add(sheet.name);
      if (sheet.leagueKey !== null && !allowedLeagueKeys.has(sheet.leagueKey))
        problems.push(`${where}: league key "${sheet.leagueKey}" not in TUSKERS_LEAGUES`);
      const fields = new Set<TuskersRosterField>();
      for (const [headerText, field] of Object.entries(sheet.colMap)) {
        const hits = sheet.header.filter((h) => h === headerText).length;
        if (hits !== 1)
          problems.push(`${where}: colMap header "${headerText}" appears ${hits}× in header`);
        if (fields.has(field)) problems.push(`${where}: field "${field}" mapped twice`);
        fields.add(field);
      }
      const hasName = fields.has('fullName') || (fields.has('firstName') && fields.has('lastName'));
      if (!hasName) problems.push(`${where}: colMap needs fullName or firstName+lastName`);
      if (fields.has('fullName') && (fields.has('firstName') || fields.has('lastName')))
        problems.push(`${where}: fullName mapped alongside firstName/lastName`);
    }
    for (const ignored of src.ignoredSheets ?? []) {
      if (seenSheets.has(ignored.name))
        problems.push(`${src.file} [${ignored.name}]: both parsed and ignored`);
    }
  }
  return problems;
}

/** The sheet's actual header cells (trimmed strings, trailing blanks dropped), or null if
 * the header row is absent altogether. */
function actualHeader(grid: SheetGrid, headerRow: number): string[] | null {
  const row = grid.rows.find((r) => r.rowNumber === headerRow);
  if (!row) return null;
  const cells = row.cells.map((c) => cellString(c));
  while (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/** Cell-for-cell header assertion. Returns a drift message, or null when it matches. */
export function headerDrift(grid: SheetGrid, spec: RosterSheetSpec): string | null {
  const actual = actualHeader(grid, spec.headerRow);
  if (!actual) return `[${grid.name}] header row ${spec.headerRow} is empty/missing`;
  const expected = [...spec.header];
  if (actual.length === expected.length && actual.every((c, i) => c === expected[i])) return null;
  return (
    `[${grid.name}] header row ${spec.headerRow} drifted:\n` +
    `       expected ${JSON.stringify(expected)}\n` +
    `       actual   ${JSON.stringify(actual)}`
  );
}

/** Workbook-level drift: every spec sheet must exist, and every worksheet must be either
 * parsed or explicitly ignored. */
export function sheetSetDrift(workbookSheetNames: string[], source: RosterSource): string[] {
  const problems: string[] = [];
  const present = new Set(workbookSheetNames);
  const known = new Set([
    ...source.sheets.map((s) => s.name),
    ...(source.ignoredSheets ?? []).map((s) => s.name),
  ]);
  for (const s of source.sheets)
    if (!present.has(s.name)) problems.push(`${source.file}: sheet "${s.name}" not found`);
  for (const name of workbookSheetNames)
    if (!known.has(name))
      problems.push(`${source.file}: unexpected sheet "${name}" (not in ROSTER_SOURCES)`);
  return problems;
}

// ───────────────────────── Identity resolution ─────────────────────────

/** Zimbabwean national ID shape (`NN-NNNNNNNaNN`, optionally `…a-NN`). */
const ZIM_ID_RE = /^\d{2}-?\d{6,7}[A-Z]-?\d{2}$/i;

/** A compact `yyyymmdd` date → ISO, only when it is a real calendar date that is neither
 * in the future nor before the MIN_DOB plausibility floor. */
export function yyyymmddToIso(s: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d)
    return null;
  const iso = date.toISOString().slice(0, 10);
  if (iso < MIN_DOB || date.getTime() > Date.now()) return null;
  return iso;
}

export type IdentityResolution =
  | { kind: 'id'; idNumber: string }
  | { kind: 'dob'; dob: string }
  | { kind: 'blank' }
  | { kind: 'foreign'; masked: string }
  | { kind: 'bad-checksum'; masked: string }
  | { kind: 'invalid'; masked: string };

/**
 * Lancashire's `BirthDate` column — identity values, NOT dates:
 *   blank                         → no identity (exception)
 *   Zimbabwean national ID        → `foreign`: no DOB derivable (exception foreign-id-no-dob)
 *   8-digit `yyyymmdd`            → dob-only (needs --allow-missing-id)
 *   anything else                 → cleanIdCell: a valid RSA ID, a date-mangled cell
 *                                   (dob-only), a bad checksum, or invalid.
 */
export function resolveIdentityCell(raw: unknown): IdentityResolution {
  const s = (cellString(raw) || (typeof raw === 'number' ? String(raw) : '')).trim();
  if (!s && !(raw instanceof Date)) return { kind: 'blank' };
  if (ZIM_ID_RE.test(s)) return { kind: 'foreign', masked: maskId(s) };
  if (/^\d{8}$/.test(s)) {
    const iso = yyyymmddToIso(s);
    return iso ? { kind: 'dob', dob: iso } : { kind: 'invalid', masked: maskId(s) };
  }
  return fromCleanId(raw);
}

/** A plain ID-number cell (union template / CSA team return). */
export function resolveIdCell(raw: unknown): IdentityResolution {
  const s = (cellString(raw) || (typeof raw === 'number' ? String(raw) : '')).trim();
  if (!s && !(raw instanceof Date)) return { kind: 'blank' };
  return fromCleanId(raw);
}

function fromCleanId(raw: unknown): IdentityResolution {
  const cleaned = cleanIdCell(raw, dobFromSaId);
  switch (cleaned.kind) {
    case 'valid':
    case 'padded':
      return { kind: 'id', idNumber: cleaned.idNumber };
    case 'date-mangled':
      return cleaned.isoDate
        ? { kind: 'dob', dob: cleaned.isoDate }
        : { kind: 'invalid', masked: '' };
    case 'bad-checksum':
      return { kind: 'bad-checksum', masked: maskId(cleaned.idNumber) };
    case 'invalid':
      return cleaned.cleaned
        ? { kind: 'invalid', masked: maskId(cleaned.cleaned) }
        : { kind: 'blank' };
  }
}

// ───────────────────────── Sheet parsing ─────────────────────────

export interface TuskersRosterException {
  rowNumber: number;
  sheet: string;
  reason: RosterException['reason'] | 'foreign-id-no-dob' | 'excluded-status';
  maskedId?: string;
  /** Non-PII context: the raw Status value for `excluded-status`. */
  detail?: string;
}

export interface TuskersSheetResult {
  sheet: string;
  leagueKey: string | null;
  rows: RosterRow[];
  exceptions: TuskersRosterException[];
  /** Non-blank-name rows (every one lands in `rows` or `exceptions`). */
  totalDataRows: number;
  /** Rows with a BLANK Status cell that were imported (reported; Active + blank import). */
  blankStatus: number;
  /** dob-only rows withheld because --allow-missing-id was not passed (also in
   * `exceptions` as `bad-id` — the Titans vocabulary — counted here for the hint line). */
  dobOnlyWithheld: number;
  unknownGenderRaw: string[];
  unknownRaceRaw: string[];
}

/**
 * Source-specific race spellings seen in Lancashire's CSA export, mapped onto values
 * normalizeRace already recognises BEFORE it runs (race is demographic, not identity —
 * the shared helper stays untouched). Anything else unrecognised is still reported.
 */
const TUSKERS_RACE_SYNONYMS: Record<string, string> = {
  col: 'Coloured',
  'black african': 'African',
};

export interface ParseTuskersSheetOptions {
  clubId: string;
  runNow: string;
  allowMissingId: boolean;
}

export function parseTuskersSheet(
  grid: SheetGrid,
  spec: RosterSheetSpec,
  options: ParseTuskersSheetOptions,
): TuskersSheetResult {
  const { clubId, runNow, allowMissingId } = options;
  const colOf = (field: TuskersRosterField): number | undefined => {
    const entry = Object.entries(spec.colMap).find(([, f]) => f === field);
    return entry ? spec.header.indexOf(entry[0]) : undefined;
  };
  const cols = {
    firstName: colOf('firstName'),
    lastName: colOf('lastName'),
    fullName: colOf('fullName'),
    idNumber: colOf('idNumber'),
    dob: colOf('dob'),
    identityOrDob: colOf('identityOrDob'),
    gender: colOf('gender'),
    race: colOf('race'),
    status: colOf('status'),
  };
  const cell = (cells: unknown[], col: number | undefined): unknown =>
    col === undefined ? undefined : cells[col];
  const text = (cells: unknown[], col: number | undefined): string =>
    collapseWhitespace(cellString(cell(cells, col)));

  const result: TuskersSheetResult = {
    sheet: spec.name,
    leagueKey: spec.leagueKey,
    rows: [],
    exceptions: [],
    totalDataRows: 0,
    blankStatus: 0,
    dobOnlyWithheld: 0,
    unknownGenderRaw: [],
    unknownRaceRaw: [],
  };
  const except = (rowNumber: number, e: Omit<TuskersRosterException, 'rowNumber' | 'sheet'>) =>
    result.exceptions.push({ rowNumber, sheet: spec.name, ...e });

  for (const { rowNumber, cells } of grid.rows) {
    if (rowNumber <= spec.headerRow) continue;

    let firstName: string;
    let lastName: string;
    if (cols.fullName !== undefined) {
      ({ firstName, lastName } = splitFullName(text(cells, cols.fullName)));
    } else {
      firstName = text(cells, cols.firstName);
      lastName = text(cells, cols.lastName);
      // Same rule as parseRosterSheet: a full name typed into the first-name column with
      // the surname cell blank is split at its last space.
      if (!lastName && firstName.includes(' '))
        ({ firstName, lastName } = splitFullName(firstName));
    }
    if (!firstName && !lastName) continue; // blank / row-number-only row
    result.totalDataRows++;

    if (cols.status !== undefined) {
      const status = text(cells, cols.status);
      if (!status) result.blankStatus++;
      else if (status.toLowerCase() !== 'active') {
        except(rowNumber, { reason: 'excluded-status', detail: status });
        continue;
      }
    }

    if (!lastName) {
      except(rowNumber, { reason: 'missing-surname' });
      continue;
    }

    const identity: IdentityResolution =
      cols.identityOrDob !== undefined
        ? resolveIdentityCell(cell(cells, cols.identityOrDob))
        : cols.idNumber !== undefined
          ? resolveIdCell(cell(cells, cols.idNumber))
          : { kind: 'blank' };
    if (identity.kind === 'foreign') {
      except(rowNumber, { reason: 'foreign-id-no-dob', maskedId: identity.masked });
      continue;
    }
    if (identity.kind === 'bad-checksum') {
      except(rowNumber, { reason: 'bad-id-checksum', maskedId: identity.masked });
      continue;
    }

    let idNumber: string | undefined;
    let dob: string | null = null;
    if (identity.kind === 'id') {
      idNumber = identity.idNumber;
      dob = dobFromSaId(idNumber);
    } else if (identity.kind === 'dob') {
      dob = identity.dob;
    }
    if (!dob && cols.dob !== undefined) dob = cellDobIso(cell(cells, cols.dob));

    const hadRealId = idNumber !== undefined;
    if (!hadRealId) {
      if (!dob) {
        // A non-blank ID cell that didn't clean up is a bad ID; nothing at all is simply
        // no identity. Name alone is never enough for playerNaturalKey.
        if (identity.kind === 'invalid')
          except(rowNumber, { reason: 'bad-id', maskedId: identity.masked || undefined });
        else except(rowNumber, { reason: 'no-usable-identity' });
        continue;
      }
      if (!allowMissingId) {
        result.dobOnlyWithheld++;
        except(rowNumber, {
          reason: 'bad-id',
          maskedId: identity.kind === 'invalid' && identity.masked ? identity.masked : undefined,
        });
        continue;
      }
    }

    const genderResult =
      cols.gender !== undefined ? normalizeGender(text(cells, cols.gender)) : undefined;
    if (genderResult?.unknownRaw) result.unknownGenderRaw.push(genderResult.unknownRaw);
    const rawRace = text(cells, cols.race);
    const raceResult =
      cols.race !== undefined
        ? normalizeRace(TUSKERS_RACE_SYNONYMS[rawRace.toLowerCase()] ?? rawRace)
        : undefined;
    if (raceResult?.unknownRaw) result.unknownRaceRaw.push(raceResult.unknownRaw);

    // Built exactly as parseRosterSheet builds it (same naturalKey base, same fields), so
    // a player imported here is indistinguishable from a Titans-imported one.
    const base: Partial<PlayerRegistration> = {
      clubId,
      firstName,
      lastName,
      dob: dob!,
      idType: 'sa-id',
      ...(idNumber ? { idNumber } : {}),
    };
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
      registeredBy: REGISTERED_BY,
      ...(idNumber ? { idNumber, idType: 'sa-id' as const } : {}),
      ...(genderResult?.value ? { gender: genderResult.value } : {}),
      ...(raceResult?.value ? { race: raceResult.value } : {}),
      ...(spec.leagueKey ? { team: spec.leagueKey } : {}),
    };
    result.rows.push({ player, hadRealId, missingId: !hadRealId, rowNumber });
  }
  return result;
}

// ───────────────────────── Intra-club dedupe ─────────────────────────

export interface SheetRow {
  sheet: string;
  row: RosterRow;
}

export interface DedupeHit {
  sheet: string;
  rowNumber: number;
  keptSheet: string;
  keptRowNumber: number;
  /** `naturalKey`: same identity. `name+dob`: an id-based and a dob-only row (or two
   * rows whose IDs differ) for the same name AND date of birth — the same person under
   * two different natural keys, which would otherwise become two player rows. */
  via: 'naturalKey' | 'name+dob';
}

/**
 * First occurrence wins (callers pass rows in ROSTER_SOURCES → sheet → row order, i.e.
 * senior-competition-first); every later appearance is dropped and REPORTED, never a
 * second player row. Matches on naturalKey, and additionally on lower-cased name + dob so
 * an id-based row and a dob-only row for the same person can't both be written.
 */
export function dedupeClubRows(rows: SheetRow[]): { kept: SheetRow[]; dupes: DedupeHit[] } {
  const byKey = new Map<string, SheetRow>();
  const byPerson = new Map<string, SheetRow>();
  const kept: SheetRow[] = [];
  const dupes: DedupeHit[] = [];
  for (const entry of rows) {
    const p = entry.row.player;
    const personKey = `${p.firstName.toLowerCase()}|${p.lastName.toLowerCase()}|${p.dob}`;
    const hit = byKey.get(p.naturalKey);
    const personHit = hit ? undefined : byPerson.get(personKey);
    const first = hit ?? personHit;
    if (first) {
      dupes.push({
        sheet: entry.sheet,
        rowNumber: entry.row.rowNumber,
        keptSheet: first.sheet,
        keptRowNumber: first.row.rowNumber,
        via: hit ? 'naturalKey' : 'name+dob',
      });
      continue;
    }
    byKey.set(p.naturalKey, entry);
    byPerson.set(personKey, entry);
    kept.push(entry);
  }
  return { kept, dupes };
}

// ───────────────────────── League gating ─────────────────────────

/**
 * Which referenced league keys are missing from the tenant, and whether each is addable
 * (in TUSKERS_LEAGUES) or unknown (abort). Keys never referenced by a written row are
 * never appended.
 */
export function planLeagueAdditions(
  configuredKeys: Set<string>,
  referencedKeys: Set<string>,
  catalogue: Array<{ key: string; label: string; group: string; district: string }>,
): {
  missing: string[];
  addable: Array<{ key: string; label: string; group: string; district: string }>;
  unknown: string[];
} {
  const missing = [...referencedKeys].filter((k) => !configuredKeys.has(k)).sort();
  const addable = catalogue.filter((l) => missing.includes(l.key));
  const unknown = missing.filter((k) => !catalogue.some((l) => l.key === k));
  return { missing, addable, unknown };
}

/** Union (never remove) a club's leagues[] with the keys its written players landed in.
 * Returns null when nothing new would be added. */
export function unionClubLeagues(
  current: string[] | undefined,
  landed: Set<string>,
): string[] | null {
  const existing = current ?? [];
  const added = [...landed].filter((k) => !existing.includes(k)).sort();
  return added.length ? [...existing, ...added] : null;
}
