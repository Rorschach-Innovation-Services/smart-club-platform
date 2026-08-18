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
import { CLUB_MAP, classifyFile, SKIP_ROSTER, type ClubMapEntry } from './titans-import-map.js';
import { DEFAULT_JUNIOR_LEAGUE_KEYS } from './roster-normalize.js';
import {
  maskId,
  findCrossClubDuplicates,
  parseRosterSheet,
  type ParseSheetResult,
  type RosterRow,
} from './roster-parse.js';

type RepoModule = typeof import('./repo.js');

const TENANT = 'titans';
const REGISTERED_BY = 'import:titans-compliance-2026';

export { maskId, findCrossClubDuplicates };

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

async function parseClubRoster(
  file: FileEntry,
  clubId: string,
  runNow: string,
  allowMissingId: boolean,
): Promise<{ sheets: Array<{ name: string; result: ParseSheetResult | null }> }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.abs);
  const sheets = wb.worksheets.map((ws) => {
    const result = parseRosterSheet(ws, clubId, runNow, {
      allowMissingId,
      juniorLeagueKeys: DEFAULT_JUNIOR_LEAGUE_KEYS,
    });
    // parseRosterSheet is tenant-neutral and never stamps provenance — this CLI's fixed
    // registeredBy is applied here, once, right after parsing.
    if (result) for (const r of result.rows) r.player.registeredBy = REGISTERED_BY;
    return { name: ws.name, result };
  });
  return { sheets };
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

export { findMemberDatabaseFiles, parseClubRoster };
