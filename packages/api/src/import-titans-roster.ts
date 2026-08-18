/**
 * Titans one-time import — player rosters, from each club's memberDatabase compliance
 * document (found via the SAME filename classifier import-titans-compliance.ts uses).
 *
 *   npx tsx src/import-titans-roster.ts --dir "<pack>/Compliance Documents" --parse-only
 *   npx sst shell --stage <stage> -- npm --prefix packages/api run import-titans-roster -- \
 *     --dir "…/Compliance Documents"                          # dry-run
 *   … --confirm                                                # write
 *   … --confirm --allow-missing-id                             # also write dob-only rows
 *   … --revert [--confirm]
 *
 * See docs/runbooks/titans-compliance-import.md.
 *
 * Runs AFTER import-titans-compliance.ts — createPlayer requires the club row to exist.
 *
 * PII: only ever prints a fully masked idNumber (`*************`), never a partial or
 * full one — the exception report's "<sheet> row <n>" already locates the source row
 * precisely, so even a masked DOB prefix adds nothing operationally. Fail-closed on
 * cross-club duplicates (matched on the resolved naturalKey, so a dob-only identity is
 * covered too — excludes all claimant rows rather than guessing which club is right)
 * and, in strict mode (the default), on any row whose ID doesn't clean up to a real
 * 13-digit RSA ID with a valid Luhn check digit — see roster-normalize.ts's cleanIdCell.
 * A date-plausible ID that fails only the checksum is reported separately
 * (`bad-id-checksum`) rather than silently promoted or hard-aborted.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import type { PlayerRegistration } from './types.js';
import { CLUB_MAP, classifyFile, SKIP_ROSTER, type ClubMapEntry } from './titans-import-map.js';
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

type RepoModule = typeof import('./repo.js');

const TENANT = 'titans';
const REGISTERED_BY = 'import:titans-compliance-2026';

/** Mask an RSA ID for any printed output — never the full number (PII), and never even
 * a partial prefix: the first 6 digits of an RSA ID ARE a full date of birth, and every
 * exception report already carries "<sheet> row <n>", which locates the source row
 * precisely — the DOB adds nothing operationally and is PII on its own. */
export function maskId(id: string): string {
  return '*'.repeat(id.length);
}

// ───────────────────────── Find each club's memberDatabase file ─────────────────────────

interface FileEntry {
  rel: string;
  abs: string;
  folder: string;
  filename: string;
}

async function walkDocs(dir: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  async function walk(current: string, relBase: string) {
    for (const entry of await readdir(current)) {
      const abs = path.join(current, entry);
      const st = await stat(abs);
      const rel = relBase ? `${relBase}/${entry}` : entry;
      if (st.isDirectory()) await walk(abs, rel);
      else out.push({ rel, abs, folder: rel.split('/')[0], filename: entry });
    }
  }
  await walk(dir, '');
  return out;
}

/** Locate each CLUB_MAP club's memberDatabase file via the same classifier the
 * compliance import uses. A club with none, or more than one (after FILE_OVERRIDES
 * skips are applied), is reported and excluded — never guessed at. */
async function findMemberDatabaseFiles(
  dir: string,
): Promise<{ byClub: Map<string, FileEntry>; missing: ClubMapEntry[]; ambiguous: string[] }> {
  const files = await walkDocs(dir);
  const clubByFolder = new Map(CLUB_MAP.map((c) => [c.folder, c]));
  const byClub = new Map<string, FileEntry>();
  const ambiguous: string[] = [];
  for (const f of files) {
    const club = clubByFolder.get(f.folder);
    if (!club) continue;
    const result = classifyFile(f.rel, f.filename);
    if (result.kind !== 'doc' || result.docKey !== 'memberDatabase') continue;
    if (byClub.has(club.id)) {
      ambiguous.push(`${club.name}: both "${byClub.get(club.id)!.rel}" and "${f.rel}"`);
      continue;
    }
    byClub.set(club.id, f);
  }
  const missing = CLUB_MAP.filter(
    (c) => !byClub.has(c.id) && !SKIP_ROSTER.some((s) => s.clubId === c.id),
  );
  return { byClub, missing, ambiguous };
}

// ───────────────────────── Row → PlayerRegistration ─────────────────────────

export interface RosterException {
  rowNumber: number;
  sheet: string;
  reason: 'bad-id' | 'no-usable-identity' | 'bad-id-checksum';
  maskedId?: string;
}

export interface RosterRow {
  player: PlayerRegistration;
  hadRealId: boolean;
  /** True when written only because of --allow-missing-id (a resolvable dob, no usable id). */
  missingId: boolean;
}

interface ParseSheetResult {
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
}

function isJuniorHeader(columns: HeaderMap): boolean {
  return columns.ageGroup !== undefined;
}

/** Parse one worksheet's data rows into candidate PlayerRegistration rows + exceptions.
 * `allowMissingId` decides whether a resolvable-dob-but-no-ID row is INCLUDED here as a
 * dob-only row, or routed to the exception list — the caller still applies strict-mode
 * filtering identically either way via this single flag, so dry-run and confirm report
 * the exact same set. */
function parseSheet(
  ws: ExcelJS.Worksheet,
  clubId: string,
  runNow: string,
  allowMissingId: boolean,
): ParseSheetResult | null {
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
  };
  const junior = isJuniorHeader(header.columns);

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
    }
    if (!firstName && !lastName) return; // blank row — not counted, not an exception

    result.totalDataRows++;

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
        // --allow-missing-id.
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
    // and the platform has no per-team senior league key from this pack.
    const team =
      junior && header.columns.ageGroup !== undefined
        ? ageGroupToLeagueKey(cellString(row.getCell(header.columns.ageGroup + 1).value)).value
        : undefined;

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
      ...(idNumber ? { idNumber, idType: 'sa-id' } : {}),
      ...(gender ? { gender } : {}),
      ...(race ? { race } : {}),
      ...(team ? { team } : {}),
    };
    result.rows.push({ player, hadRealId, missingId });
  });

  return result;
}

async function parseClubRoster(
  file: FileEntry,
  clubId: string,
  runNow: string,
  allowMissingId: boolean,
): Promise<{ sheets: Array<{ name: string; result: ParseSheetResult | null }> }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.abs);
  const sheets = wb.worksheets.map((ws) => ({
    name: ws.name,
    result: parseSheet(ws, clubId, runNow, allowMissingId),
  }));
  return { sheets };
}

// ───────────────────────── Cross-club duplicate ID detection ─────────────────────────

/**
 * Fail-closed: any player identity — id-based OR dob-only — claimed by more than one
 * club is reported and ALL claimants are excluded from writing, never a guess at which
 * club is authoritative.
 *
 * Matched on the resolved `naturalKey`, not the raw idNumber: under --allow-missing-id
 * (the documented CORRECT mode for this pack — see the runbook) a dob-only row has no
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

// ───────────────────────── CLI ─────────────────────────

interface Args {
  dir: string;
  parseOnly: boolean;
  confirm: boolean;
  club?: string;
  allowMissingId: boolean;
  revert: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dir: '',
    parseOnly: false,
    confirm: false,
    allowMissingId: false,
    revert: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i] ?? '';
    else if (a === '--parse-only') args.parseOnly = true;
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--club') args.club = argv[++i];
    else if (a === '--allow-missing-id') args.allowMissingId = true;
    else if (a === '--revert') args.revert = true;
    else throw new Error(`unknown flag ${a}`);
  }
  if (args.revert) {
    if (args.dir) throw new Error('--revert takes no --dir');
    return args;
  }
  if (!args.dir) throw new Error('requires --dir "<Compliance Documents>" (or --revert)');
  return args;
}

// ───────────────────────── Revert ─────────────────────────

async function runRevert(repo: RepoModule, confirm: boolean): Promise<void> {
  let totalDeleted = 0;
  const touchedClubs = new Set<string>();
  for (const club of CLUB_MAP) {
    const players = await repo.listPlayers(TENANT, club.id);
    const mine = players.filter((p) => p.registeredBy === REGISTERED_BY);
    if (mine.length === 0) continue;
    console.log(
      `${confirm ? 'delete' : '[dry-run] would delete'}  ${mine.length} player(s) — ${club.name}`,
    );
    if (confirm) {
      for (const p of mine) await repo.deletePlayer(TENANT, p);
      touchedClubs.add(club.id);
      totalDeleted += mine.length;
    }
  }
  if (confirm) {
    for (const clubId of touchedClubs) await repo.reconcilePlayerCount(TENANT, clubId);
    console.log(`Reverted ${totalDeleted} imported player(s) across ${touchedClubs.size} club(s).`);
  } else {
    console.log('Re-run with --confirm to delete these.');
  }
}

// ───────────────────────── Main ─────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.revert) {
    const repo = await import('./repo.js');
    await runRevert(repo, args.confirm);
    return;
  }

  const { byClub, missing, ambiguous } = await findMemberDatabaseFiles(args.dir);
  if (ambiguous.length) {
    console.error(
      `✗ Refusing to continue — ambiguous memberDatabase file(s):\n${ambiguous.map((m) => `   ${m}`).join('\n')}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log('── SKIP_ROSTER (unimportable, documented exceptions)');
  for (const s of SKIP_ROSTER) console.log(`  ${s.clubId}: ${s.reason}`);
  if (missing.length) {
    console.error(
      `\n✗ Refusing to continue — club(s) with no memberDatabase file and not on SKIP_ROSTER: ${missing.map((c) => c.name).join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  const runNow = new Date().toISOString();
  const targets = args.club ? CLUB_MAP.filter((c) => c.id === args.club) : CLUB_MAP;
  if (args.club && targets.length === 0) throw new Error(`--club "${args.club}" not in CLUB_MAP`);

  const allRows: Array<{ clubId: string; clubName: string; row: RosterRow }> = [];
  const perClubReport: string[] = [];
  let totalExceptions = 0;

  for (const club of targets) {
    if (SKIP_ROSTER.some((s) => s.clubId === club.id)) continue;
    const file = byClub.get(club.id)!;
    const { sheets } = await parseClubRoster(file, club.id, runNow, args.allowMissingId);

    let parsed = 0;
    let valid = 0;
    let missingIdCount = 0;
    let exceptions = 0;
    let checksumFailures = 0;
    // A club whose sheets ALL used the "Date of Birth" template has no ID column to fail
    // on — its rows are dob-only by construction, not corrupt.
    let sheetsWithIdColumn = 0;
    let dataSheets = 0;
    const exceptionDetails: string[] = [];
    const unknownGenderRaw: string[] = [];
    const unknownRaceRaw: string[] = [];
    for (const { name, result } of sheets) {
      if (!result) continue; // no header detected on this sheet — not a data sheet
      dataSheets++;
      if (result.hasIdColumn) sheetsWithIdColumn++;
      parsed += result.totalDataRows;
      unknownGenderRaw.push(...result.unknownGenderRaw);
      unknownRaceRaw.push(...result.unknownRaceRaw);
      for (const r of result.rows) {
        valid++;
        if (r.missingId) missingIdCount++;
        allRows.push({ clubId: club.id, clubName: club.name, row: r });
      }
      for (const e of result.exceptions) {
        exceptions++;
        if (e.reason === 'bad-id-checksum') checksumFailures++;
        exceptionDetails.push(
          `${name} row ${e.rowNumber}: ${e.reason}${e.maskedId ? ` (${e.maskedId})` : ''}`,
        );
      }
    }
    totalExceptions += exceptions;
    perClubReport.push(
      `  ${club.name}: parsed=${parsed} valid=${valid}${args.allowMissingId ? ` (of which dob-only=${missingIdCount})` : ''} exceptions=${exceptions}${checksumFailures ? ` (of which bad-checksum=${checksumFailures})` : ''}`,
    );
    // Name the TEMPLATE-level cause before listing rows. Three clubs submitted the union's
    // "Date of Birth" form, which has no ID column at all: in strict mode every one of
    // their rows fails as `bad-id`, and without this line the operator reads hundreds of
    // identical failures as corrupt data instead of "re-run with --allow-missing-id".
    if (dataSheets > 0 && sheetsWithIdColumn === 0) {
      perClubReport.push(
        args.allowMissingId
          ? `     ↳ template has no ID-number column (Date of Birth variant) — rows import as dob-only`
          : `     ↳ template has no ID-number column (Date of Birth variant) — EVERY row fails in strict mode; re-run with --allow-missing-id to import these`,
      );
    }
    // Unknown race/gender values are never silently dropped — surfaced here per club so
    // an operator can see exactly what the sheet said (capped, both in count and length).
    for (const [label, raws] of [
      ['gender', unknownGenderRaw],
      ['race', unknownRaceRaw],
    ] as const) {
      if (raws.length === 0) continue;
      const distinct = [...new Set(raws)];
      const shown = distinct.slice(0, 10).map((s) => (s.length > 40 ? `${s.slice(0, 40)}…` : s));
      const more = distinct.length > 10 ? ` (+${distinct.length - 10} more distinct)` : '';
      perClubReport.push(
        `     ↳ unknown ${label}: ${raws.length} row(s), ${distinct.length} distinct value(s): ${shown.join(', ')}${more}`,
      );
    }
    if (exceptionDetails.length) {
      for (const d of exceptionDetails.slice(0, 20)) perClubReport.push(`     ${d}`);
      if (exceptionDetails.length > 20)
        perClubReport.push(`     … and ${exceptionDetails.length - 20} more`);
    }
  }

  console.log(`\n── Per-club roster parse report`);
  for (const line of perClubReport) console.log(line);
  console.log(`\nTotal exceptions across all clubs: ${totalExceptions}`);

  const { duplicateNaturalKeys, report: dupReport } = findCrossClubDuplicates(allRows);
  if (dupReport.length) {
    console.log(
      `\n✗ ${dupReport.length} cross-club duplicate identity match(es) — ALL claimants excluded from writing:`,
    );
    for (const d of dupReport) console.log(`   ${d}`);
  }
  const writable = allRows.filter(
    (r) => !duplicateNaturalKeys.has(`${r.clubId}::${r.row.player.naturalKey}`),
  );
  // Report against the CANDIDATE set (rows that survived parsing), not the raw row count:
  // saying "of N parsed" when N is the valid count read as though nothing was dropped.
  console.log(
    `\n${writable.length} player row(s) eligible to write — ${allRows.length} usable row(s) built, ` +
      `${allRows.length - writable.length} withheld as cross-club duplicates, ` +
      `${totalExceptions} row(s) in the exception reports above.`,
  );

  if (args.parseOnly) {
    console.log('\n[parse-only] Parsing clean — nothing touched DynamoDB.');
    return;
  }

  if (!args.confirm) {
    console.log('\nRe-run with --confirm to write.');
    return;
  }

  const repo = await import('./repo.js');
  let createdCount = 0;
  let alreadyPresent = 0;
  const touchedClubs = new Set<string>();
  for (const { clubId, row } of writable) {
    try {
      await repo.createPlayer(TENANT, row.player);
      createdCount++;
      touchedClubs.add(clubId);
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        alreadyPresent++;
        continue;
      }
      throw err;
    }
  }
  for (const clubId of touchedClubs) await repo.reconcilePlayerCount(TENANT, clubId);
  console.log(`\n· players: ${createdCount} created, ${alreadyPresent} already present`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { findMemberDatabaseFiles, parseSheet, parseClubRoster };
