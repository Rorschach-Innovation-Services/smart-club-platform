/**
 * Tuskers (KZN Inland) one-time import — player rosters from the clubs' nominal rolls
 * (Phase 2 of plans/tuskers-compliance-import-plan.md).
 *
 *   npx tsx src/import-tuskers-roster.ts --dir "<pack>" --parse-only [--allow-missing-id]
 *   npx sst shell --stage <stage> -- npm --prefix packages/api run import-tuskers-roster -- \
 *     --dir "<pack>"                                             # dry-run
 *   … --confirm --add-missing-leagues                            # write (id-based rows)
 *   … --confirm --add-missing-leagues --allow-missing-id         # also dob-only rows
 *   … --revert [--confirm]
 *
 * See docs/runbooks/tuskers-compliance-import.md. Runs AFTER import-tuskers-compliance.ts
 * (createPlayer needs the club rows).
 *
 * Shell mirrors import-titans-roster.ts (parse-only / dry-run / confirm / revert, dry-run
 * and confirm report the same set, fail-closed cross-club duplicates via
 * findCrossClubDuplicates, reconcilePlayerCount per touched club). The parsing layer is
 * tuskers-specific (tuskers-roster-parse.ts): per-source colMaps with an asserted header
 * row, the team from the SHEET, Lancashire's BirthDate trichotomy + Status filter, and an
 * intra-club dedupe (first source/sheet wins) that collapses Howick's DIV 1/2/3 repeats
 * and Standard's roll-vs-CSA-return overlap.
 *
 * Tenant leagues gate (the titans ensureLeaguesConfigured pattern): every league key a
 * written row lands in must exist in TenantConfig.leagues; `--add-missing-leagues`
 * appends exactly the referenced-and-missing TUSKERS_LEAGUES entries. After confirm,
 * each touched club's `leagues[]` is unioned with the keys its players landed in.
 *
 * PII: only fully masked IDs (`maskId`) are ever printed; no name or dob appears in any
 * report line — `<sheet> row <n>` locates the source row.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import {
  CLUB_MAP,
  ROSTER_SOURCES,
  ROSTER_NON_SOURCES,
  SKIP_ROSTER,
  TUSKERS_LEAGUES,
  type RosterSource,
} from './tuskers-import-map.js';
import { classifyAll, walkDocs } from './import-tuskers-compliance.js';
import { findCrossClubDuplicates, type RosterRow } from './roster-parse.js';
import {
  REGISTERED_BY,
  dedupeClubRows,
  headerDrift,
  parseTuskersSheet,
  planLeagueAdditions,
  rosterSourceProblems,
  sheetSetDrift,
  unionClubLeagues,
  worksheetToGrid,
  type DedupeHit,
  type SheetRow,
  type TuskersRosterException,
  type TuskersSheetResult,
} from './tuskers-roster-parse.js';

type RepoModule = typeof import('./repo.js');

const TENANT = 'tuskers';

// ───────────────────────── CLI ─────────────────────────

interface Args {
  dir: string;
  parseOnly: boolean;
  confirm: boolean;
  club?: string;
  allowMissingId: boolean;
  addMissingLeagues: boolean;
  revert: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dir: '',
    parseOnly: false,
    confirm: false,
    allowMissingId: false,
    addMissingLeagues: false,
    revert: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i] ?? '';
    else if (a === '--parse-only') args.parseOnly = true;
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--club') args.club = argv[++i];
    else if (a === '--allow-missing-id') args.allowMissingId = true;
    else if (a === '--add-missing-leagues') args.addMissingLeagues = true;
    else if (a === '--revert') args.revert = true;
    else throw new Error(`unknown flag ${a}`);
  }
  // Silently-ignored combinations are errors: an operator must never believe a flag
  // took effect when it didn't.
  if (args.parseOnly && args.confirm) {
    throw new Error('--parse-only never writes — drop --confirm (or drop --parse-only to write)');
  }
  if (args.revert) {
    if (args.dir) throw new Error('--revert takes no --dir');
    if (args.club !== undefined) throw new Error('--revert takes no --club');
    if (args.parseOnly) throw new Error('--revert takes no --parse-only');
    if (args.allowMissingId) throw new Error('--revert takes no --allow-missing-id');
    if (args.addMissingLeagues) throw new Error('--revert takes no --add-missing-leagues');
    return args;
  }
  if (!args.dir) throw new Error('requires --dir "<Tuskers pack folder>" (or --revert)');
  return args;
}

// ───────────────────────── Source coverage ─────────────────────────

/**
 * Fail closed on any roster file the config doesn't account for: every ROSTER_SOURCES
 * file must exist, and every nominalRoll-classified file of an importable (non
 * SKIP_ROSTER) club must be either a source or a documented ROSTER_NON_SOURCES entry.
 */
async function sourceCoverageProblems(dir: string): Promise<string[]> {
  const problems = rosterSourceProblems(ROSTER_SOURCES, new Set(TUSKERS_LEAGUES.map((l) => l.key)));
  for (const src of ROSTER_SOURCES) {
    try {
      await stat(path.join(dir, src.file));
    } catch {
      problems.push(`roster source not found: ${src.file}`);
    }
    if (!CLUB_MAP.some((c) => c.id === src.clubId))
      problems.push(`${src.file}: clubId "${src.clubId}" not in CLUB_MAP`);
    if (SKIP_ROSTER.some((s) => s.clubId === src.clubId))
      problems.push(`${src.file}: club "${src.clubId}" is on SKIP_ROSTER`);
  }
  const accounted = new Set([
    ...ROSTER_SOURCES.map((s) => s.file),
    ...ROSTER_NON_SOURCES.map((s) => s.file),
  ]);
  const { classified } = classifyAll(await walkDocs(dir));
  for (const f of classified) {
    if (f.docKey !== 'nominalRoll' || !f.club) continue;
    if (SKIP_ROSTER.some((s) => s.clubId === f.club!.id)) continue;
    if (!accounted.has(f.rel))
      problems.push(`nominalRoll file not in ROSTER_SOURCES or ROSTER_NON_SOURCES: ${f.rel}`);
  }
  return problems;
}

// ───────────────────────── Parse ─────────────────────────

interface ParsedSource {
  source: RosterSource;
  sheets: TuskersSheetResult[];
}

async function parseSource(
  dir: string,
  source: RosterSource,
  runNow: string,
  allowMissingId: boolean,
): Promise<{ parsed: ParsedSource | null; problems: string[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(dir, source.file));
  const problems = sheetSetDrift(
    wb.worksheets.map((ws) => ws.name),
    source,
  );
  const sheets: TuskersSheetResult[] = [];
  for (const spec of source.sheets) {
    const ws = wb.getWorksheet(spec.name);
    if (!ws) continue; // reported by sheetSetDrift
    const grid = worksheetToGrid(ws);
    const drift = headerDrift(grid, spec);
    if (drift) {
      problems.push(`${source.file} ${drift}`);
      continue;
    }
    sheets.push(parseTuskersSheet(grid, spec, { clubId: source.clubId, runNow, allowMissingId }));
  }
  return { parsed: problems.length ? null : { source, sheets }, problems };
}

interface ClubParse {
  clubId: string;
  clubName: string;
  sheets: Array<{ file: string; result: TuskersSheetResult }>;
  kept: SheetRow[];
  dupes: DedupeHit[];
}

function formatException(e: TuskersRosterException): string {
  const extra = e.maskedId ? ` (${e.maskedId})` : e.detail ? ` (status "${e.detail}")` : '';
  return `${e.sheet} row ${e.rowNumber}: ${e.reason}${extra}`;
}

function printClubReport(club: ClubParse, allowMissingId: boolean): number {
  console.log(`\n  ${club.clubName} (${club.clubId})`);
  console.log(
    `     ${'sheet'.padEnd(24)} ${'league'.padEnd(16)} ${'rows'.padStart(5)} ${'valid'.padStart(6)} ${'exc'.padStart(5)}`,
  );
  let rows = 0;
  let valid = 0;
  let dobOnly = 0;
  let withheld = 0;
  let blankStatus = 0;
  const exceptions: TuskersRosterException[] = [];
  const byReason = new Map<string, number>();
  const unknownGender: string[] = [];
  const unknownRace: string[] = [];
  // Standard has two source files, both with a premier sheet — tag rows by file there.
  const multiFile = new Set(club.sheets.map((s) => s.file)).size > 1;
  for (const { file, result } of club.sheets) {
    const label = multiFile
      ? `${path.basename(file, '.xlsx').slice(0, 12)}/${result.sheet}`
      : result.sheet;
    console.log(
      `     ${label.padEnd(24)} ${(result.leagueKey ?? '(no team)').padEnd(16)} ${String(result.totalDataRows).padStart(5)} ${String(result.rows.length).padStart(6)} ${String(result.exceptions.length).padStart(5)}`,
    );
    rows += result.totalDataRows;
    valid += result.rows.length;
    dobOnly += result.rows.filter((r) => r.missingId).length;
    withheld += result.dobOnlyWithheld;
    blankStatus += result.blankStatus;
    unknownGender.push(...result.unknownGenderRaw);
    unknownRace.push(...result.unknownRaceRaw);
    for (const e of result.exceptions) {
      exceptions.push(e);
      byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);
    }
  }
  const noTeam = club.kept.filter((r) => !r.row.player.team).length;
  console.log(
    `     total: rows=${rows} valid=${valid}${allowMissingId ? ` (dob-only=${dobOnly})` : ''} ` +
      `→ ${club.kept.length} distinct after intra-club dedupe (${club.dupes.length} repeat appearance(s)); ` +
      `exceptions=${exceptions.length}` +
      (byReason.size ? ` [${[...byReason].map(([r, n]) => `${r}=${n}`).join(', ')}]` : ''),
  );
  if (withheld)
    console.log(
      `     ↳ ${withheld} dob-only row(s) withheld in strict mode (in bad-id above) — re-run with --allow-missing-id to import them`,
    );
  if (blankStatus)
    console.log(
      `     ↳ ${blankStatus} row(s) with a BLANK Status imported (Active + blank import)`,
    );
  if (noTeam)
    console.log(
      `     ↳ ${noTeam} distinct player(s) import with NO team (3rds/4ths — union to confirm where they play)`,
    );
  for (const [label, raws] of [
    ['gender', unknownGender],
    ['race', unknownRace],
  ] as const) {
    if (!raws.length) continue;
    const distinct = [...new Set(raws)]
      .slice(0, 10)
      .map((s) => (s.length > 40 ? `${s.slice(0, 40)}…` : s));
    console.log(`     ↳ unknown ${label}: ${raws.length} row(s): ${distinct.join(', ')}`);
  }
  if (club.dupes.length) {
    const shown = club.dupes.slice(0, 12);
    for (const d of shown)
      console.log(
        `     dedupe: ${d.sheet} row ${d.rowNumber} ≙ ${d.keptSheet} row ${d.keptRowNumber} (kept; via ${d.via})`,
      );
    if (club.dupes.length > shown.length)
      console.log(`     … and ${club.dupes.length - shown.length} more repeat appearance(s)`);
  }
  for (const e of exceptions.slice(0, 20)) console.log(`     ${formatException(e)}`);
  if (exceptions.length > 20) console.log(`     … and ${exceptions.length - 20} more exception(s)`);
  return exceptions.length;
}

// ───────────────────────── Leagues ─────────────────────────

async function ensureLeaguesConfigured(
  repo: RepoModule,
  args: Args,
  referencedKeys: Set<string>,
): Promise<void> {
  const config = await repo.getTenantConfig(TENANT);
  if (!config) throw new Error(`tenant "${TENANT}" has no config — create the tenant first.`);
  const configured = new Set((config.leagues ?? []).map((l) => l.key));
  const { missing, addable, unknown } = planLeagueAdditions(
    configured,
    referencedKeys,
    TUSKERS_LEAGUES,
  );
  if (unknown.length) {
    throw new Error(
      `roster references league key(s) not configured on "${TENANT}" and not in ` +
        `TUSKERS_LEAGUES: ${unknown.join(', ')}. Configure them in the operator console first.`,
    );
  }
  if (missing.length === 0) {
    console.log(`✓ All ${referencedKeys.size} referenced league key(s) are configured.`);
    return;
  }
  const keys = addable.map((l) => l.key).join(', ');
  if (!args.confirm) {
    console.log(
      `· leagues: ${keys} missing from the tenant config — ` +
        (args.addMissingLeagues
          ? 'will be appended on --confirm.'
          : 'pass --add-missing-leagues (or add them in the operator console) before --confirm.'),
    );
    return;
  }
  if (!args.addMissingLeagues) {
    throw new Error(
      `TenantConfig.leagues is missing ${keys} — re-run with --add-missing-leagues to append ` +
        'them, or add them in the operator console first.',
    );
  }
  const next = [
    ...(config.leagues ?? []),
    // Each entry carries its own district (div-1/2/3 are uMgungundlovu-scoped).
    ...addable,
  ];
  await repo.putTenantConfig({ ...config, leagues: next });
  console.log(`✓ appended league(s) to ${TENANT}: ${keys}`);
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

  if (args.club && !CLUB_MAP.some((c) => c.id === args.club))
    throw new Error(`--club "${args.club}" not in CLUB_MAP`);

  console.log('── SKIP_ROSTER (no identity data — report to the union)');
  for (const s of SKIP_ROSTER) {
    const name = CLUB_MAP.find((c) => c.id === s.clubId)?.name ?? s.clubId;
    console.log(`  ${name}: ${s.reason}`);
  }
  console.log('\n── Nominal rolls deliberately not used as roster sources');
  for (const s of ROSTER_NON_SOURCES) console.log(`  ${s.file}: ${s.reason}`);
  if (args.club && SKIP_ROSTER.some((s) => s.clubId === args.club)) {
    console.log(`\n--club ${args.club} is on SKIP_ROSTER — nothing to import.`);
    return;
  }

  const coverage = await sourceCoverageProblems(args.dir);
  if (coverage.length) {
    console.error(`\n✗ Refusing to continue:\n${coverage.map((p) => `   ${p}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }

  // Every source is ALWAYS parsed, even under --club: cross-club duplicate detection must
  // see every club's claimants, or a scoped run would write a player another club also
  // claims. --club only narrows what is reported and written.
  const runNow = new Date().toISOString();
  const drift: string[] = [];
  const byClub = new Map<string, ClubParse>();
  for (const source of ROSTER_SOURCES) {
    const { parsed, problems } = await parseSource(args.dir, source, runNow, args.allowMissingId);
    drift.push(...problems);
    if (!parsed) continue;
    const clubName = CLUB_MAP.find((c) => c.id === source.clubId)!.name;
    if (!byClub.has(source.clubId))
      byClub.set(source.clubId, {
        clubId: source.clubId,
        clubName,
        sheets: [],
        kept: [],
        dupes: [],
      });
    const club = byClub.get(source.clubId)!;
    for (const result of parsed.sheets) club.sheets.push({ file: source.file, result });
  }
  if (drift.length) {
    console.error(
      `\n✗ Refusing to continue — workbook drift against ROSTER_SOURCES:\n${drift.map((p) => `   ${p}`).join('\n')}`,
    );
    process.exitCode = 1;
    return;
  }

  const allRows: Array<{ clubId: string; clubName: string; row: RosterRow }> = [];
  for (const club of byClub.values()) {
    const ordered: SheetRow[] = club.sheets.flatMap(({ result }) =>
      result.rows.map((row) => ({ sheet: result.sheet, row })),
    );
    const { kept, dupes } = dedupeClubRows(ordered);
    club.kept = kept;
    club.dupes = dupes;
    for (const { row } of kept) allRows.push({ clubId: club.clubId, clubName: club.clubName, row });
  }

  const reportClubs = [...byClub.values()].filter((c) => !args.club || c.clubId === args.club);
  console.log(
    `\n── Per-club roster parse report${args.allowMissingId ? ' (--allow-missing-id)' : ' (strict: id-based rows only)'}`,
  );
  let totalExceptions = 0;
  for (const club of reportClubs) totalExceptions += printClubReport(club, args.allowMissingId);

  const { duplicateNaturalKeys, report: dupReport } = findCrossClubDuplicates(allRows);
  if (dupReport.length) {
    console.log(
      `\n✗ ${dupReport.length} cross-club duplicate identity match(es) — ALL claimants excluded from writing:`,
    );
    for (const d of dupReport) console.log(`   ${d}`);
  }
  const candidates = allRows.filter((r) => !args.club || r.clubId === args.club);
  const writable = candidates.filter(
    (r) => !duplicateNaturalKeys.has(`${r.clubId}::${r.row.player.naturalKey}`),
  );
  const referenced = new Set(
    writable.flatMap((r) => (r.row.player.team ? [r.row.player.team] : [])),
  );
  const { unknown } = planLeagueAdditions(new Set(), referenced, TUSKERS_LEAGUES);
  if (unknown.length)
    throw new Error(`league key(s) not in TUSKERS_LEAGUES: ${unknown.join(', ')}`);

  console.log(
    `\n${writable.length} player row(s) eligible to write — ${candidates.length} distinct player(s) built, ` +
      `${candidates.length - writable.length} withheld as cross-club duplicates, ` +
      `${totalExceptions} row(s) in the exception reports above.`,
  );
  console.log(
    `League keys referenced by eligible rows: ${[...referenced].sort().join(', ') || '(none)'}`,
  );

  if (args.parseOnly) {
    console.log('\n[parse-only] Parsing clean — nothing touched DynamoDB.');
    return;
  }

  const repo = await import('./repo.js');
  await ensureLeaguesConfigured(repo, args, referenced);

  const writeClubs = [...new Set(writable.map((r) => r.clubId))];
  const missingClubs: string[] = [];
  const existingKeys = new Map<string, Set<string>>();
  for (const clubId of writeClubs) {
    if (!(await repo.getClub(TENANT, clubId))) {
      missingClubs.push(clubId);
      continue;
    }
    existingKeys.set(
      clubId,
      new Set((await repo.listPlayers(TENANT, clubId)).map((p) => p.naturalKey)),
    );
  }
  if (missingClubs.length) {
    const msg = `club(s) not on "${TENANT}": ${missingClubs.join(', ')} — run import-tuskers-compliance --confirm first`;
    if (args.confirm) throw new Error(msg);
    console.log(`⚠ ${msg}`);
  }

  if (!args.confirm) {
    let wouldCreate = 0;
    let already = 0;
    for (const { clubId, row } of writable) {
      if (existingKeys.get(clubId)?.has(row.player.naturalKey)) already++;
      else wouldCreate++;
    }
    console.log(`\n· players: would create ${wouldCreate}, ${already} already present`);
    console.log('\nRe-run with --confirm to write.');
    return;
  }

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

  // Merge, never remove: a club whose leagues[] is never set reads as zero everywhere
  // league-scoped (the dolphins "Insights zero" lesson). Covers already-present rows too,
  // so a re-run heals a club whose earlier run wrote players but not leagues.
  for (const clubId of writeClubs) {
    const landed = new Set(
      writable
        .filter((r) => r.clubId === clubId && r.row.player.team)
        .map((r) => r.row.player.team!),
    );
    const club = await repo.getClub(TENANT, clubId);
    if (!club) continue;
    const next = unionClubLeagues(club.leagues, landed);
    if (!next) continue;
    await repo.updateClub(
      TENANT,
      clubId,
      { leagues: next },
      REGISTERED_BY,
      new Date().toISOString(),
    );
    console.log(`· ${clubId}: leagues → ${next.join(', ')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { parseArgs, sourceCoverageProblems };
