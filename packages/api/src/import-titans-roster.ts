/**
 * Titans one-time import — player rosters, from each club's memberDatabase compliance
 * document (found via the SAME filename classifier import-titans-compliance.ts uses).
 *
 *   npx tsx src/import-titans-roster.ts --dir "<pack>/Compliance Documents" --parse-only
 *   npx sst shell --stage <stage> -- npm --prefix packages/api run import-titans-roster -- \
 *     --dir "…/Compliance Documents"                          # dry-run
 *   … --confirm                                                # write
 *   … --confirm --allow-missing-id                             # also write dob-only rows
 *   … --confirm --marker import:titans-compliance-2026-topup  # stamp a separate batch
 *   … --revert --marker <marker> [--confirm]                  # --marker is REQUIRED here
 *
 * Partial packs (Oct 2026 top-up): only clubs whose folder is present in --dir are in
 * scope; the rest are listed as out of scope and never parsed or written. On a partial
 * pack the in-run cross-club duplicate check can't see the other clubs' players, so the
 * dry-run/confirm phases ALSO check every writable identity against the live tenant
 * (repo.findPlayerAcrossClubs) and print an expected-collision report (already present
 * at its own club vs new) before anything is written.
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
import {
  CLUB_MAP,
  classifyFile,
  scopeClubs,
  SKIP_ROSTER,
  type ClubMapEntry,
} from './titans-import-map.js';
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
/**
 * Default provenance stamp (`registeredBy`) for an IMPORT run — the August 2026 batch's
 * marker, kept as the default for full back-compat. A later batch passes its own
 * `--marker` (the Oct 2026 top-up uses `import:titans-compliance-2026-topup`) so it can
 * be reverted independently. Revert has NO default: see parseArgs.
 */
const DEFAULT_MARKER = 'import:titans-compliance-2026';
/** Markers live in the `import:` namespace — disjoint from the operator roster intake's
 * `intake:*` stamps, so a revert can never select intake-written players. */
const MARKER_PREFIX = 'import:';

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
async function findMemberDatabaseFiles(dir: string): Promise<{
  byClub: Map<string, FileEntry>;
  missing: ClubMapEntry[];
  ambiguous: string[];
  inScope: ClubMapEntry[];
  outOfScope: ClubMapEntry[];
}> {
  const files = await walkDocs(dir);
  // Partial-pack scoping: a club is in scope iff its folder is present in --dir.
  const { inScope, outOfScope } = scopeClubs(files.map((f) => f.folder));
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
  // Only an IN-SCOPE club without a memberDatabase is a failure — an out-of-scope club
  // simply isn't in this pack. A full pack scopes to all 21, so that case is unchanged.
  const missing = inScope.filter(
    (c) => !byClub.has(c.id) && !SKIP_ROSTER.some((s) => s.clubId === c.id),
  );
  return { byClub, missing, ambiguous, inScope, outOfScope };
}

// ───────────────────────── Row → PlayerRegistration ─────────────────────────

async function parseClubRoster(
  file: FileEntry,
  clubId: string,
  runNow: string,
  allowMissingId: boolean,
  registeredBy: string = DEFAULT_MARKER,
): Promise<{ sheets: Array<{ name: string; result: ParseSheetResult | null }> }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.abs);
  const sheets = wb.worksheets.map((ws) => {
    const result = parseRosterSheet(ws, clubId, runNow, {
      allowMissingId,
      juniorLeagueKeys: DEFAULT_JUNIOR_LEAGUE_KEYS,
    });
    // parseRosterSheet is tenant-neutral and never stamps provenance — this run's
    // marker (--marker, default DEFAULT_MARKER) is applied here, once, right after parsing.
    if (result) for (const r of result.rows) r.player.registeredBy = registeredBy;
    return { name: ws.name, result };
  });
  return { sheets };
}

// ───────────────────────── Live (tenant-wide) checks ─────────────────────────

type ClaimRow = { clubId: string; clubName: string; row: RosterRow };

/**
 * The live counterpart of findCrossClubDuplicates. On a PARTIAL pack the in-run check
 * only compares the clubs in this pack with each other — a new TUT player already
 * registered at one of the other (out-of-scope) clubs would sail through. So every
 * writable row's naturalKey is also looked up at every OTHER club on the live tenant;
 * any hit excludes that row and is reported — the same exclude-and-report semantics as
 * the in-run gate (the live row stays as is; this import never resolves which club is
 * right). PII: id-based matches print masked, dob-only matches print no value at all.
 * `lookup` is injected (repo.findPlayerAcrossClubs in the CLI) so this stays testable.
 */
async function findLiveCrossClubDuplicates(
  rows: ClaimRow[],
  lookup: (
    naturalKey: string,
    excludeClubId: string,
  ) => Promise<Array<{ clubId: string; clubName: string; status?: string }>>,
): Promise<{ duplicateNaturalKeys: Set<string>; report: string[] }> {
  const duplicateNaturalKeys = new Set<string>();
  const report: string[] = [];
  for (const { clubId, clubName, row } of rows) {
    const hits = await lookup(row.player.naturalKey, clubId);
    if (hits.length === 0) continue;
    duplicateNaturalKeys.add(`${clubId}::${row.player.naturalKey}`);
    const id = row.player.idNumber;
    const identityLabel = id ? maskId(id) : 'dob-only match';
    report.push(
      `${identityLabel}: ${clubName} row ${row.rowNumber} — already registered at ` +
        hits.map((h) => `${h.clubName}${h.status ? ` (${h.status})` : ''}`).join(', '),
    );
  }
  return { duplicateNaturalKeys, report };
}

/**
 * Per-club "already present vs new" counts for the rows about to be written, by
 * point-getting each (club, naturalKey). Idempotency only holds if a row resolves to the
 * SAME identity form (ID vs name+dob — player-identity.ts) as when it was first
 * imported; a drifted row is a duplicate player, not a no-op, and createPlayer's
 * conditional write can't tell. This makes that visible BEFORE the write. Counts only —
 * no identities printed. `exists` is injected (repo.getPlayer in the CLI).
 */
async function expectedCollisionReport(
  rows: ClaimRow[],
  exists: (clubId: string, naturalKey: string) => Promise<boolean>,
): Promise<Array<{ clubId: string; clubName: string; alreadyPresent: number; new: number }>> {
  const byClub = new Map<
    string,
    { clubId: string; clubName: string; alreadyPresent: number; new: number }
  >();
  for (const { clubId, clubName, row } of rows) {
    let entry = byClub.get(clubId);
    if (!entry) {
      entry = { clubId, clubName, alreadyPresent: 0, new: 0 };
      byClub.set(clubId, entry);
    }
    if (await exists(clubId, row.player.naturalKey)) entry.alreadyPresent++;
    else entry.new++;
  }
  return [...byClub.values()];
}

// ───────────────────────── CLI ─────────────────────────

interface Args {
  dir: string;
  parseOnly: boolean;
  confirm: boolean;
  club?: string;
  allowMissingId: boolean;
  revert: boolean;
  /** Provenance stamp written on (import) / selected by (revert) — see DEFAULT_MARKER. */
  marker: string;
  /** True iff --marker was passed. Revert refuses to run without it. */
  markerExplicit: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dir: '',
    parseOnly: false,
    confirm: false,
    allowMissingId: false,
    revert: false,
    marker: DEFAULT_MARKER,
    markerExplicit: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i] ?? '';
    else if (a === '--parse-only') args.parseOnly = true;
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--club') args.club = argv[++i];
    else if (a === '--allow-missing-id') args.allowMissingId = true;
    else if (a === '--revert') args.revert = true;
    else if (a === '--marker') {
      args.marker = (argv[++i] ?? '').trim();
      args.markerExplicit = true;
    } else throw new Error(`unknown flag ${a}`);
  }
  if (args.markerExplicit) {
    if (!args.marker.startsWith(MARKER_PREFIX) || args.marker.length <= MARKER_PREFIX.length)
      throw new Error(`--marker must start with "${MARKER_PREFIX}" (got "${args.marker}")`);
  }
  if (args.revert) {
    // No default on revert: the default marker is the AUGUST batch's, so a bare
    // `--revert` meant to undo a top-up would instead select every August player.
    if (!args.markerExplicit)
      throw new Error(
        `--revert requires an explicit --marker (e.g. --marker ${DEFAULT_MARKER}-topup) — ` +
          'there is deliberately no default, so a revert can never select the wrong batch',
      );
    if (args.dir) throw new Error('--revert takes no --dir');
    return args;
  }
  if (!args.dir) throw new Error('requires --dir "<Compliance Documents>" (or --revert)');
  return args;
}

// ───────────────────────── Revert ─────────────────────────

async function runRevert(repo: RepoModule, confirm: boolean, marker: string): Promise<void> {
  console.log(`── Roster revert — marker: ${marker}${confirm ? '' : ' [dry-run]'}`);
  let totalDeleted = 0;
  const touchedClubs = new Set<string>();
  for (const club of CLUB_MAP) {
    const players = await repo.listPlayers(TENANT, club.id);
    const mine = players.filter((p) => p.registeredBy === marker);
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
    await runRevert(repo, args.confirm, args.marker);
    return;
  }

  console.log(
    `── Roster import — marker: ${args.marker}${args.markerExplicit ? '' : ' (default)'}` +
      ` · mode: ${args.parseOnly ? 'parse-only' : args.confirm ? 'CONFIRM (writes)' : 'dry-run'}`,
  );
  const { byClub, missing, ambiguous, inScope, outOfScope } = await findMemberDatabaseFiles(
    args.dir,
  );
  console.log(
    `── Pack scope: ${inScope.length} club(s) in scope, ${outOfScope.length} out of scope\n` +
      `  in scope:     ${inScope.map((c) => c.name).join(', ') || '(none)'}\n` +
      `  out of scope: ${outOfScope.map((c) => c.name).join(', ') || '(none — full pack)'}` +
      (outOfScope.length ? '  ← no folder in --dir; NOT parsed or written' : ''),
  );
  if (inScope.length === 0) {
    console.error(`✗ Refusing to continue — no CLUB_MAP club folder found in --dir "${args.dir}"`);
    process.exitCode = 1;
    return;
  }
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
  // Targets are the in-scope clubs only — the old CLUB_MAP-wide loop dereferenced
  // byClub.get(id)! for every club and crashed on the first one absent from a partial pack.
  const targets = args.club ? inScope.filter((c) => c.id === args.club) : inScope;
  if (args.club && targets.length === 0)
    throw new Error(
      CLUB_MAP.some((c) => c.id === args.club)
        ? `--club "${args.club}" is out of scope (no folder for it in --dir)`
        : `--club "${args.club}" not in CLUB_MAP`,
    );

  const allRows: Array<{ clubId: string; clubName: string; row: RosterRow }> = [];
  const perClubReport: string[] = [];
  let totalExceptions = 0;

  for (const club of targets) {
    if (SKIP_ROSTER.some((s) => s.clubId === club.id)) continue;
    const file = byClub.get(club.id);
    // Unreachable after the `missing` gate above (every in-scope, non-SKIP_ROSTER club has
    // a file) — kept as a loud failure rather than a non-null assertion.
    if (!file) throw new Error(`internal: no memberDatabase file for in-scope ${club.id}`);
    const { sheets } = await parseClubRoster(
      file,
      club.id,
      runNow,
      args.allowMissingId,
      args.marker,
    );

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

  // Live checks (dry-run AND confirm; never --parse-only, which must stay AWS-free).
  const repo = await import('./repo.js');
  const liveClubs = await repo.listClubs(TENANT);
  const { duplicateNaturalKeys: liveDupKeys, report: liveDupReport } =
    await findLiveCrossClubDuplicates(writable, (naturalKey, excludeClubId) =>
      repo.findPlayerAcrossClubs(TENANT, naturalKey, excludeClubId, liveClubs),
    );
  if (liveDupReport.length) {
    console.log(
      `\n✗ ${liveDupReport.length} row(s) whose identity is ALREADY registered at another club on ` +
        'the live tenant — excluded from writing (same rule as the in-run cross-club gate):',
    );
    for (const d of liveDupReport) console.log(`   ${d}`);
  } else {
    console.log(`\n✓ Live cross-club check: no writable identity is registered at another club.`);
  }
  const toWrite = writable.filter(
    (r) => !liveDupKeys.has(`${r.clubId}::${r.row.player.naturalKey}`),
  );

  const collisions = await expectedCollisionReport(toWrite, async (clubId, naturalKey) =>
    Boolean(await repo.getPlayer(TENANT, clubId, naturalKey)),
  );
  console.log(
    `\n── Expected-collision report (point-get of each writable (club, identity) — an ` +
      `inflated "new" count for a club already imported means its rows now resolve to a ` +
      `different identity form than before; stop and investigate before --confirm)`,
  );
  for (const c of collisions)
    console.log(`  ${c.clubName}: ${c.alreadyPresent} already present (skipped), ${c.new} new`);
  console.log(
    `\n${toWrite.length} row(s) to write after the live check ` +
      `(${writable.length - toWrite.length} withheld as live cross-club duplicates).`,
  );

  if (!args.confirm) {
    console.log('\nRe-run with --confirm to write.');
    return;
  }

  let createdCount = 0;
  let alreadyPresent = 0;
  const touchedClubs = new Set<string>();
  for (const { clubId, row } of toWrite) {
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
  console.log(
    `\n· players: ${createdCount} created, ${alreadyPresent} already present (marker ${args.marker})`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export {
  findMemberDatabaseFiles,
  parseClubRoster,
  parseArgs,
  findLiveCrossClubDuplicates,
  expectedCollisionReport,
  DEFAULT_MARKER,
};
