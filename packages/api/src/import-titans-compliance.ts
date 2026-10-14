/**
 * Titans one-time import — clubs, compliance documents, and (with --with-teams) league
 * team rosters, from the union's extracted compliance pack + league-structure workbook.
 *
 *   npx tsx src/import-titans-compliance.ts \
 *     --dir "<pack>/Compliance Documents" --structure "<pack>/Titans….xlsx" --parse-only
 *   npx sst shell --stage <stage> -- npm --prefix packages/api run import-titans-compliance -- \
 *     --dir "…/Compliance Documents" --structure "…/Titans….xlsx"                    # dry-run
 *   … --confirm                                                                        # write
 *   … --confirm --with-teams                                                           # + leagues/teamRosters
 *   … --confirm --skip-docs                                                            # clubs only, no S3/doc writes
 *   … --revert [--club <id>] [--all [--erase-preexisting]] [--confirm]
 *
 * Top-up / partial packs (Oct 2026): only clubs whose folder is present in --dir are in
 * scope (the rest are listed as out of scope and never touched); --structure is optional
 * (only --with-teams needs it); entry-form team mode replaces it for a top-up:
 *   … --dir "…/Compliance Documents" --teams-from-entry --entry-forms "…/entry-forms" [--skip-docs] [--confirm]
 *
 * See docs/runbooks/titans-compliance-import.md.
 *
 * WHY split from the roster import (import-titans-roster.ts): a memberDatabase workbook
 * needs the CLUB rows to exist first (createPlayer requires the club), and the two are
 * independently re-runnable/revertable — same reasoning as PlanB's fixtures-vs-clubs
 * split in the prereqs script.
 *
 * Fail-closed by design, mirroring import-planb-fixtures.ts: an unclassified compliance
 * file, an unresolved structure-sheet team token, an empty mapped section, or a tenant
 * catalogue that doesn't cover every DOC_RULES key all abort the run with a printed
 * report — a confidently wrong import on prod is worse than an incomplete one.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import type { Club, ClubTeam, RequiredDoc } from './types.js';
import {
  resolveRequiredDocs,
  activeRequiredDocs,
  DOC_FORMAT_MIME,
  acceptedMimes,
  multiFileLimits,
  normalizeDocMeta,
  docMetaValue,
  unavailableDeclared,
  OVERARCHING_DISTRICT,
  type DocFileEntry,
  type NormalizedDocMeta,
} from './catalogue.js';
import {
  CLUB_MAP,
  type ClubMapEntry,
  classifyFile,
  TITANS_DOC_KEYS,
  MULTI_FILE_DOC_KEYS,
  parseStructureWorkbook,
  summarizeByClub,
  isKnownStructureAnomaly,
  KNOWN_STRUCTURE_ANOMALIES,
  EXTRA_LEAGUES,
  scopeClubs,
  leagueKeyForEntryLabel,
  WOMENS_AGGREGATE,
  type StructureSection,
} from './titans-import-map.js';
import { deriveTeamPlanCounts } from './team-plan.js';
import { parseEntryFormWorkbook, type EntryFormRow } from './entry-form-parse.js';

type RepoModule = typeof import('./repo.js');

const TENANT = 'titans';
const DISTRICT = 'Tshwane';
const AUDIT_NOTE = 'Imported from Titans compliance pack (import:titans-compliance-2026)';
/** Content-addressed S3 keys carry this marker so a re-run is idempotent and revert can
 * tell an import-authored doc from an admin's real upload. */
const IMPORT_KEY_MARKER = '-import-';

/**
 * True iff `objectKey` is one THIS import wrote for exactly this club+docKey —
 * anchored to the `${TENANT}/${clubId}/${docKey}-import-…` prefix `contentAddressedKey`
 * actually produces, never a bare `.includes(IMPORT_KEY_MARKER)` substring test.
 * `DOC_KEY_RE` (titans-import-map.ts) permits `-`, so a docKey ending `-import` or
 * containing `-import-` could make a rep's genuine upload for that key falsely match an
 * unanchored substring test. Two destructive paths depend on this being correct:
 * `isPristine` (eligibility for full club deletion) and the revert-strip S3 delete.
 */
function isImportObjectKey(objectKey: string, clubId: string, docKey: string): boolean {
  return objectKey.startsWith(`${TENANT}/${clubId}/${docKey}${IMPORT_KEY_MARKER}`);
}
const CLUB_COLORS = ['#0E3529', '#215F47', '#4B8A6C', '#B89B4A', '#E7DDC6', '#8C5A3B'];

/**
 * Stable (non-timestamped) manifest of every club id this import has ever CREATED
 * (never merely merged into) across every `--confirm` run — the positive signal
 * `--revert --all` uses to distinguish "safe to erase outright" from "pre-existed the
 * import, only merged". Chosen over the alternatives: `onboardedVia` is typed to the
 * single existing value `'self-signup'` and isn't ours to repurpose (types.ts is out of
 * scope for this import); the audit note is appended to BOTH created and merged clubs
 * (see AUDIT_NOTE), so it can't discriminate between them; a club's `version` isn't a
 * reliable signal either (a freshly created club stays at version 1 only until the very
 * next merge/doc-upload write touches it, which routinely happens later in the SAME
 * run). Recording creation at the moment it happens is the only signal that can never
 * drift from what actually occurred.
 *
 * Persisted INCREMENTALLY (one id at a time, as each club is created — see
 * runConfirm), never accumulated in memory and flushed once at the end of the club
 * loop: an interrupted run (throttle, expired credentials, Ctrl-C) must never lose the
 * ids it already created, or a later `--revert --all` mis-classifies them as
 * pre-existing and refuses to delete them — the exact inversion of the bug this
 * manifest exists to prevent.
 *
 * STAGE-SCOPED (Oct 2026 top-up): `./titans-import-created-clubs.<stage>.json`. The
 * original unsuffixed path was stage-agnostic, and club ids are derived from names —
 * identical on every stage. A dev rehearsal that CREATES tut-cricket-club would record
 * that id, and a later prod `--revert --all` run from the same directory would read it as
 * "this import created the prod club" and hard-delete a live prod club. The stage now
 * keys the file, so dev evidence can never steer a prod revert.
 *
 * The LEGACY unsuffixed file (`LEGACY_CREATED_CLUBS_MANIFEST_PATH`) is the manifest of
 * the August 2026 PROD import only. It is never read automatically; if a prod revert ever
 * needs it, rename it to `titans-import-created-clubs.prod.json` by hand (see the
 * runbook). Both CLIs warn when it is sitting in the working directory.
 */
const LEGACY_CREATED_CLUBS_MANIFEST_PATH = './titans-import-created-clubs.json';

/**
 * Stage from `SST_STAGE`, else from `SST_RESOURCE_App` (the `{"name","stage"}` JSON
 * `sst shell` injects — what the sst SDK's `Resource.App.stage` reads; same mechanism as
 * import-tuskers-compliance.ts). Neither set (plain `npx tsx`, e.g. --parse-only) →
 * `'unknown'`, `resolved: false` — callers warn. Pure over `env` for testing.
 */
function resolveManifestStage(env: NodeJS.ProcessEnv = process.env): {
  stage: string;
  resolved: boolean;
} {
  let stage = env.SST_STAGE?.trim();
  if (!stage && env.SST_RESOURCE_App) {
    try {
      const app = JSON.parse(env.SST_RESOURCE_App) as { stage?: unknown };
      if (typeof app.stage === 'string') stage = app.stage.trim();
    } catch {
      throw new Error('SST_RESOURCE_App is set but is not valid JSON — cannot resolve the stage');
    }
  }
  if (!stage) return { stage: 'unknown', resolved: false };
  if (!/^[A-Za-z0-9_-]+$/.test(stage)) throw new Error(`unsafe stage name "${stage}"`);
  return { stage, resolved: true };
}

function createdClubsManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  return `./titans-import-created-clubs.${resolveManifestStage(env).stage}.json`;
}

/** Print the manifest-path warnings every confirm/revert run should surface: an
 * unresolved stage (manifest falls back to `.unknown.json`), and a legacy unsuffixed
 * manifest sitting in the working directory (never read — see above). */
async function warnManifestContext(): Promise<void> {
  if (!resolveManifestStage().resolved) {
    console.warn(
      `⚠ stage not resolvable (no SST_STAGE / SST_RESOURCE_App — not under sst shell?): the ` +
        `created-clubs manifest falls back to ${createdClubsManifestPath()}.`,
    );
  }
  try {
    await stat(LEGACY_CREATED_CLUBS_MANIFEST_PATH);
    console.warn(
      `⚠ legacy ${LEGACY_CREATED_CLUBS_MANIFEST_PATH} found in the working directory — it is the ` +
        `August 2026 PROD manifest and is NOT read by this run (using ${createdClubsManifestPath()}).`,
    );
  } catch {
    // absent — the normal case
  }
}

/**
 * Three-way read result — "absent" and "corrupt" are NOT interchangeable. The revert
 * (read) path may treat both as "no positive evidence available" (never "zero clubs
 * created"), same as before. The confirm (write) path must NOT: silently proceeding
 * with an empty set when the file is present-but-corrupt would clobber every id a prior
 * run recorded the moment this run's manifest write lands — see the caller's handling.
 */
type ManifestReadResult =
  | { kind: 'absent' }
  | { kind: 'corrupt'; detail: string }
  | { kind: 'ok'; ids: Set<string> };

async function readCreatedClubsManifest(): Promise<ManifestReadResult> {
  let raw: string;
  try {
    raw = await readFile(createdClubsManifestPath(), 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'corrupt', detail: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    return {
      kind: 'corrupt',
      detail: `invalid JSON — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string')) {
    return { kind: 'corrupt', detail: 'expected a JSON array of club id strings' };
  }
  return { kind: 'ok', ids: new Set(parsed) };
}

async function writeCreatedClubsManifest(ids: Set<string>): Promise<void> {
  await writeFile(createdClubsManifestPath(), JSON.stringify([...ids].sort(), null, 2));
}

// ───────────────────────── File-tree walk + classification ─────────────────────────

interface FileEntry {
  /** Relative path "Folder/filename.ext", forward slashes — matches FILE_OVERRIDES keys. */
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

interface ClassifiedFile extends FileEntry {
  club: ClubMapEntry | undefined;
  docKey: string | undefined;
  skipReason: string | undefined;
}

function classifyAll(files: FileEntry[]): {
  classified: ClassifiedFile[];
  unclassified: FileEntry[];
  unmappedFolders: string[];
} {
  const clubByFolder = new Map(CLUB_MAP.map((c) => [c.folder, c]));
  const classified: ClassifiedFile[] = [];
  const unclassified: FileEntry[] = [];
  const unmappedFolders = new Set<string>();
  for (const f of files) {
    const club = clubByFolder.get(f.folder);
    if (!club) unmappedFolders.add(f.folder);
    const result = classifyFile(f.rel, f.filename);
    if (result.kind === 'unclassified') {
      unclassified.push(f);
      continue;
    }
    classified.push({
      ...f,
      club,
      docKey: result.kind === 'doc' ? result.docKey : undefined,
      skipReason: result.kind === 'skip' ? result.reason : undefined,
    });
  }
  return { classified, unclassified, unmappedFolders: [...unmappedFolders] };
}

async function sha256File(abs: string): Promise<string> {
  const bytes = await readFile(abs);
  return createHash('sha256').update(bytes).digest('hex');
}

/** Within one club × docKey group, dedupe byte-identical files (Irene Villagers' MOU
 * "(1)" copies) — first-seen (alphabetical by rel path) wins, the rest are reported and
 * excluded from upload. Never a filename heuristic: content hash is the only thing that
 * decides "these are the same document twice". */
async function dedupeGroup(
  files: ClassifiedFile[],
): Promise<{ keep: ClassifiedFile[]; dupesOf: Map<string, string> }> {
  const sorted = [...files].sort((a, b) => a.rel.localeCompare(b.rel));
  const seen = new Map<string, ClassifiedFile>(); // sha256 -> kept file
  const keep: ClassifiedFile[] = [];
  const dupesOf = new Map<string, string>(); // dupe rel -> kept rel
  for (const f of sorted) {
    const hash = await sha256File(f.abs);
    const existing = seen.get(hash);
    if (existing) {
      dupesOf.set(f.rel, existing.rel);
      continue;
    }
    seen.set(hash, f);
    keep.push(f);
  }
  return { keep, dupesOf };
}

// ───────────────────────── Structure workbook ─────────────────────────

async function loadStructureSections(structurePath: string): Promise<StructureSection[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(structurePath);
  return parseStructureWorkbook(wb);
}

// ───────────────────────── Reporting ─────────────────────────

function printClassificationTable(classified: ClassifiedFile[], unclassified: FileEntry[]) {
  console.log(`\n── File classification (${classified.length + unclassified.length} files)`);
  const byClub = new Map<string, ClassifiedFile[]>();
  for (const f of classified) {
    const key = f.folder;
    if (!byClub.has(key)) byClub.set(key, []);
    byClub.get(key)!.push(f);
  }
  for (const folder of [...byClub.keys()].sort()) {
    const files = byClub.get(folder)!;
    const parts = files.map((f) =>
      f.skipReason ? `SKIP(${f.filename})` : `${f.docKey}(${f.filename})`,
    );
    console.log(`  [${folder}] ${parts.join('; ')}`);
  }
  if (unclassified.length) {
    console.log(`\n  ✗ ${unclassified.length} UNCLASSIFIED file(s):`);
    for (const f of unclassified) console.log(`     ${f.rel}`);
  }
}

function printDocCoverageTable(classified: ClassifiedFile[], clubs: ClubMapEntry[]) {
  console.log(`\n── Per-club doc-key coverage (${clubs.length} in-scope club(s))`);
  for (const club of clubs) {
    const mine = classified.filter((f) => f.club?.id === club.id && f.docKey);
    const byKey = new Map<string, number>();
    for (const f of mine) byKey.set(f.docKey!, (byKey.get(f.docKey!) ?? 0) + 1);
    const summary = [...byKey.entries()].map(([k, n]) => `${k}(${n})`).join(', ') || 'NO DOCS';
    console.log(`  ${club.name}: ${summary}`);
  }
}

/**
 * Would-upload preview, computable at Phase P (parse-only) since it only needs local
 * file bytes (via dedupeGroup's content hashing) — no DynamoDB/S3 access, and so no
 * `sst shell`. Reports the same dedupe collapse the actual upload phase
 * (runDocUploadPhase) will apply, per club/key, so an operator can see "7 files → 4
 * distinct" before ever touching a real stage. What this canNOT know without a real
 * tenant to compare against — which files are already stored (no-op skips) and MIME
 * validation against the tenant's configured catalogue — is reported instead by the
 * dry-run phase (Phase 1, `sst shell`, no --confirm), which calls the real
 * runDocUploadPhase read-only.
 */
async function printDocUploadPreview(
  classified: ClassifiedFile[],
  clubs: ClubMapEntry[],
): Promise<void> {
  console.log(`\n── Doc upload preview (post-dedupe; no-op/already-current only known at Phase 1)`);
  const groups = new Map<string, ClassifiedFile[]>();
  for (const f of classified) {
    if (!f.club || !f.docKey) continue;
    const key = `${f.club.id}::${f.docKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }
  let totalRaw = 0;
  let totalDistinct = 0;
  for (const club of clubs) {
    const keysForClub = [...groups.keys()].filter((k) => k.startsWith(`${club.id}::`));
    if (keysForClub.length === 0) continue;
    const parts: string[] = [];
    for (const groupKey of keysForClub.sort()) {
      const docKey = groupKey.split('::')[1];
      const files = groups.get(groupKey)!;
      const { keep, dupesOf } = await dedupeGroup(files);
      totalRaw += files.length;
      totalDistinct += keep.length;
      parts.push(
        dupesOf.size
          ? `${docKey}: ${files.length} file(s) → would upload ${keep.length} (${dupesOf.size} byte-identical duplicate(s) skipped)`
          : `${docKey}: would upload ${keep.length}`,
      );
    }
    console.log(`  ${club.name}: ${parts.join('; ')}`);
  }
  console.log(
    `\n  ${totalRaw} classified doc file(s) → ${totalDistinct} distinct → would upload ${totalDistinct} (${totalRaw - totalDistinct} byte-identical duplicate(s) skipped).`,
  );
}

function printStructureReport(sections: StructureSection[]): {
  unresolvedTokens: Array<{ section: string; sheet: string; raw: string }>;
  emptySections: string[];
} {
  console.log(`\n── Structure sections (${sections.length})`);
  const unresolvedTokens: Array<{ section: string; sheet: string; raw: string }> = [];
  const knownAnomalies: Array<{ section: string; sheet: string; raw: string }> = [];
  const emptySections: string[] = [];
  for (const s of sections) {
    const unresolved = s.rows.filter((r) => !r.club);
    console.log(
      `  [${s.sheet}] "${s.header}" -> ${s.leagueKey ?? 'UNMAPPED (reported only)'} : ${s.rows.length} rows` +
        (unresolved.length ? `  *** ${unresolved.length} UNRESOLVED` : ''),
    );
    for (const r of unresolved) {
      const entry = { section: s.header, sheet: s.sheet, raw: r.raw };
      if (isKnownStructureAnomaly(s.sheet, s.header, r.raw)) knownAnomalies.push(entry);
      else unresolvedTokens.push(entry);
    }
    if (s.rows.length === 0) emptySections.push(`${s.sheet} · ${s.header}`);
  }
  if (knownAnomalies.length) {
    console.log(
      `\n  ⚠ ${knownAnomalies.length} KNOWN data anomaly/anomalies (reviewed exception, excluded from team counts, NOT aborting):`,
    );
    for (const t of knownAnomalies) {
      const reason = KNOWN_STRUCTURE_ANOMALIES.find(
        (a) => a.sheet === t.sheet && a.header === t.section && a.raw === t.raw,
      )?.reason;
      console.log(`     [${t.sheet}] "${t.section}": "${t.raw}" — ${reason}`);
    }
  }
  if (unresolvedTokens.length) {
    console.log(`\n  ✗ ${unresolvedTokens.length} unresolved team token(s):`);
    for (const t of unresolvedTokens) console.log(`     [${t.sheet}] "${t.section}": "${t.raw}"`);
  }
  return { unresolvedTokens, emptySections };
}

// ───────────────────────── CLI ─────────────────────────

interface Args {
  dir: string;
  /** Union structure workbook. Optional since the Oct 2026 top-up: only `--with-teams`
   * (the legacy structure-driven team path) requires it. */
  structure: string;
  /** Entry-form team mode: diff each in-scope club's league-entry form against its
   * stored team plan and (on --confirm) write only the leagues that differ. Mutually
   * exclusive with --with-teams and --structure. Requires --entry-forms. */
  teamsFromEntry: boolean;
  /** Directory of `<CLUB_MAP.folder>.xlsx` entry forms (xlsx Save-As copies of the
   * union's `.xls` originals). */
  entryForms: string;
  parseOnly: boolean;
  confirm: boolean;
  club?: string;
  withTeams: boolean;
  skipDocs: boolean;
  revert: boolean;
  all: boolean;
  /** Revert only. Separate, explicit opt-in to erase a club this import only MERGED
   * into (i.e. one that pre-existed the import) — see runRevert's comment. `--all`
   * alone never touches a pre-existing club's real data. */
  erasePreexisting: boolean;
  /** With --with-teams / --teams-from-entry: append any EXTRA_LEAGUES entries
   * (Women's/Veterans) missing from TenantConfig.leagues before writing teams. Without
   * it, a team plan that references an unconfigured league key aborts — never writes a
   * dangling key. */
  addMissingLeagues: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dir: '',
    structure: '',
    teamsFromEntry: false,
    entryForms: '',
    parseOnly: false,
    confirm: false,
    withTeams: false,
    skipDocs: false,
    revert: false,
    all: false,
    erasePreexisting: false,
    addMissingLeagues: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i] ?? '';
    else if (a === '--structure') args.structure = argv[++i] ?? '';
    else if (a === '--teams-from-entry') args.teamsFromEntry = true;
    else if (a === '--entry-forms') args.entryForms = argv[++i] ?? '';
    else if (a === '--parse-only') args.parseOnly = true;
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--club') args.club = argv[++i];
    else if (a === '--with-teams') args.withTeams = true;
    else if (a === '--skip-docs') args.skipDocs = true;
    else if (a === '--revert') args.revert = true;
    else if (a === '--all') args.all = true;
    else if (a === '--erase-preexisting') args.erasePreexisting = true;
    else if (a === '--add-missing-leagues') args.addMissingLeagues = true;
    else throw new Error(`unknown flag ${a}`);
  }
  if (args.erasePreexisting && !(args.revert && args.all)) {
    throw new Error('--erase-preexisting only makes sense with --revert --all');
  }
  if (args.revert) {
    if (args.dir || args.structure || args.teamsFromEntry || args.entryForms)
      throw new Error('--revert takes no --dir/--structure/--teams-from-entry/--entry-forms');
    return args;
  }
  if (!args.dir) throw new Error('requires --dir "<Compliance Documents>" (or --revert)');
  // --structure is optional now; the legacy structure-driven team write still needs it.
  if (args.withTeams && !args.structure)
    throw new Error('--with-teams requires --structure "<xlsx>"');
  if (args.teamsFromEntry) {
    // Two team sources at once would leave "which plan wins" to code order — refuse.
    if (args.withTeams || args.structure)
      throw new Error('--teams-from-entry is mutually exclusive with --with-teams/--structure');
    if (!args.entryForms)
      throw new Error('--teams-from-entry requires --entry-forms "<dir of <folder>.xlsx>"');
  } else if (args.entryForms) {
    throw new Error('--entry-forms only makes sense with --teams-from-entry');
  }
  return args;
}

// ───────────────────────── Club building ─────────────────────────

function buildClubDocsSeed(activeDocs: RequiredDoc[]): Record<string, boolean> {
  const docs: Record<string, boolean> = {};
  for (const d of activeDocs) docs[d.key] = false;
  return docs;
}

interface TeamPlan {
  leagues: string[];
  leagueTeams: Record<string, number>;
  teamRosters: Record<string, ClubTeam[]>;
}

function buildTeamPlan(
  club: ClubMapEntry,
  summary: ReturnType<typeof summarizeByClub> extends Map<string, infer V> ? V | undefined : never,
): TeamPlan {
  const leagues: string[] = [];
  const leagueTeams: Record<string, number> = {};
  const teamRosters: TeamPlan['teamRosters'] = {};
  if (!summary) return { leagues, leagueTeams, teamRosters };
  for (const [key, count] of summary.leagueTeamCounts) {
    leagues.push(key);
    leagueTeams[key] = count;
    // teamRosters ONLY when a league's count >= 2 — mirrors seed-cohort.ts's rule so a
    // club later edited in the admin console converges onto the same tm_ ids. Team NAMES
    // and per-side VENUES come from the sheet itself ("TUKS 2" at "GROENKLOOF OVAL"),
    // not a generated A/B/C label — the sheet's side labels are what the union and the
    // clubs actually call these teams, and the venue is the half of the sheet's data
    // that a bare count silently discarded. tm_ ids stay index-based (never derived
    // from the label) so re-runs and later admin edits converge on the same ids.
    if (count >= 2) {
      const sides = summary.leagueSides.get(key) ?? [];
      teamRosters[key] = Array.from({ length: count }, (_, n) => {
        const side = sides[n];
        return {
          id: `tm_${club.id}_${key}_${n}`,
          name: side?.label || `${club.name} ${String.fromCharCode(65 + n)}`,
          ...(side?.venue ? { venue: side.venue } : {}),
        };
      });
    }
  }
  return { leagues, leagueTeams, teamRosters };
}

function buildClub(
  club: ClubMapEntry,
  activeDocs: RequiredDoc[],
  summary: ReturnType<typeof summarizeByClub> extends Map<string, infer V> ? V | undefined : never,
  withTeams: boolean,
  index: number,
  /** --teams-from-entry, club not yet on the tenant: the entry-form plan IS the initial
   * plan (it wins over the structure-driven one, which can't be in play anyway —
   * parseArgs makes the two modes mutually exclusive). */
  planOverride?: TeamPlan,
): Club {
  const plan = planOverride ?? (withTeams ? buildTeamPlan(club, summary) : null);
  // Total team count across every league this club fields, plus the denormalized
  // women's/junior side counts (dashboard KPIs) — derived from the same plan so they can
  // never disagree with leagueTeams. A clubs-only run (no plan) is teams:1, women/
  // juniors:0.
  const { teams, women, juniors } = deriveTeamPlanCounts(plan?.leagueTeams ?? {});
  return {
    id: club.id,
    name: club.name,
    district: DISTRICT,
    sub: '',
    chair: 'Pending — see club committee document',
    affiliation: 'not_started',
    cqi: 0,
    docs: buildClubDocsSeed(activeDocs),
    players: 0,
    teams,
    women,
    juniors,
    color: CLUB_COLORS[index % CLUB_COLORS.length],
    ground: summary?.firstTeamVenue ? { venue: summary.firstTeamVenue } : {},
    leagues: plan?.leagues ?? [],
    ...(plan && Object.keys(plan.leagueTeams).length ? { leagueTeams: plan.leagueTeams } : {}),
    ...(plan && Object.keys(plan.teamRosters).length ? { teamRosters: plan.teamRosters } : {}),
    version: 1,
  } as Club;
}

// ───────────────────────── Entry-form teams (--teams-from-entry) ─────────────────────────

/** The parts of a stored Club that make up its team plan. */
interface StoredTeamPlan {
  leagues: string[];
  leagueTeams?: Record<string, number>;
  teamRosters?: Record<string, ClubTeam[]>;
}

const EMPTY_STORED_PLAN: StoredTeamPlan = { leagues: [] };

function storedPlanOf(club: Club | null | undefined): StoredTeamPlan {
  if (!club) return EMPTY_STORED_PLAN;
  return {
    leagues: club.leagues ?? [],
    leagueTeams: club.leagueTeams,
    teamRosters: club.teamRosters,
  };
}

/** Stored side count for a league: 0 if the club isn't in it; else leagueTeams[key],
 * absent ⇒ 1 (types.ts: "Teams entered per league key … absent ⇒ 1"). */
function storedCount(stored: StoredTeamPlan, key: string): number {
  if (!stored.leagues.includes(key)) return 0;
  return stored.leagueTeams?.[key] ?? 1;
}

/**
 * Fail-closed checks on one club's parsed entry form, before any diff is trusted:
 * an unknown label (not in ENTRY_LEAGUE_MAP), two rows resolving to the same league key,
 * and a non-blank requested count that isn't a whole number. The last is stricter than
 * the parser (which reads it as 0): a 0 against a stored league is an UPDATE that would
 * DELETE that league's teams, so "2 teams"-style free text must abort, not shrink.
 */
function entryFormProblems(rows: EntryFormRow[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const r of rows) {
    const key = leagueKeyForEntryLabel(r.label);
    if (key === undefined) {
      problems.push(
        `row ${r.rowNumber}: unknown league label "${r.label}" (add it to ENTRY_LEAGUE_MAP)`,
      );
      continue;
    }
    if (r.countRaw !== undefined) {
      problems.push(
        `row ${r.rowNumber} "${r.label}": requested count "${r.countRaw}" is not a whole number`,
      );
    }
    if (key === null) continue;
    const prior = seen.get(key);
    if (prior) problems.push(`rows "${prior}" and "${r.label}" both resolve to league "${key}"`);
    else seen.set(key, r.label);
  }
  return problems;
}

type EntryDiffAction = 'none' | 'UPDATE' | 'manual';

interface EntryDiffRow {
  /** Form label, or "(not on form)" for a stored league no form row covers. */
  label: string;
  /** Tenant league key, WOMENS_AGGREGATE, or null (recognised, no tenant league). */
  leagueKey: string | null;
  stored: number;
  requested: number;
  action: EntryDiffAction;
  /** The form's home-venue cell — used for any generated (growth) side. */
  venue: string;
  note?: string;
}

/**
 * Diff one club's (problem-free — see entryFormProblems) entry form against its stored
 * team plan. Pure.
 *   - mapped league: requested ≠ stored → UPDATE (the only rows ever written).
 *   - null-mapped label (Reserve/President/Junior Girls): non-zero → `manual` (union
 *     follow-up), never written, never minted as a league.
 *   - WOMENS_AGGREGATE: compared to the SUM of stored `womens-*` counts; a mismatch is
 *     `manual` — which women's league a side belongs in is the union's call.
 *   - a stored league no form row covers (other than `womens-*`): `none`, kept verbatim.
 * Rows that are 0 on both sides are omitted (nothing to say).
 */
function diffEntryForm(rows: EntryFormRow[], stored: StoredTeamPlan): EntryDiffRow[] {
  const out: EntryDiffRow[] = [];
  const covered = new Set<string>();
  for (const r of rows) {
    const key = leagueKeyForEntryLabel(r.label);
    if (key === undefined) continue; // entryFormProblems already aborted on this
    if (key === null) {
      if (r.count > 0)
        out.push({
          label: r.label,
          leagueKey: null,
          stored: 0,
          requested: r.count,
          action: 'manual',
          venue: r.venue,
          note: 'no tenant league for this entry — union follow-up',
        });
      continue;
    }
    if (key === WOMENS_AGGREGATE) {
      const womensKeys = stored.leagues.filter((k) => k.startsWith('womens-'));
      for (const k of womensKeys) covered.add(k);
      const sum = womensKeys.reduce((t, k) => t + storedCount(stored, k), 0);
      if (sum === 0 && r.count === 0) continue;
      out.push({
        label: r.label,
        leagueKey: WOMENS_AGGREGATE,
        stored: sum,
        requested: r.count,
        action: sum === r.count ? 'none' : 'manual',
        venue: r.venue,
        note:
          sum === r.count
            ? `sum of ${womensKeys.join(' + ') || 'womens-*'}`
            : "women's placement is the union's call — never written",
      });
      continue;
    }
    covered.add(key);
    const s = storedCount(stored, key);
    if (s === 0 && r.count === 0) continue;
    out.push({
      label: r.label,
      leagueKey: key,
      stored: s,
      requested: r.count,
      action: s === r.count ? 'none' : 'UPDATE',
      venue: r.venue,
    });
  }
  for (const key of stored.leagues) {
    if (covered.has(key)) continue;
    out.push({
      label: '(not on form)',
      leagueKey: key,
      stored: storedCount(stored, key),
      requested: storedCount(stored, key),
      action: 'none',
      venue: '',
      note: 'no form row for this league — kept as stored',
    });
  }
  return out;
}

/**
 * Apply a diff's UPDATE rows to the stored plan. Pure. Only UPDATE leagues change;
 * every other league keeps its stored count and roster entries VERBATIM (August's side
 * names/venues survive).
 *   - requested 0 → league removed (leagues[], leagueTeams, teamRosters).
 *   - requested 1 → teamRosters[key] DELETED, not truncated: rosters exist only for
 *     counts ≥ 2 (types.ts — "present ONLY for leagues with leagueTeams[key] >= 2").
 *   - shrink to n ≥ 2 → truncated from the end.
 *   - growth → generated `tm_${clubId}_${key}_${i}` ids appended (index-based like
 *     buildTeamPlan, bumped past any id already in use), with the form's home venue.
 * Every removed/added tm_ id is returned so the caller can report it.
 */
function applyEntryFormDiff(
  club: { id: string; name: string },
  stored: StoredTeamPlan,
  diff: EntryDiffRow[],
): { plan: TeamPlan; droppedTeamIds: string[]; addedTeamIds: string[] } {
  const leagues = [...stored.leagues];
  const leagueTeams: Record<string, number> = { ...(stored.leagueTeams ?? {}) };
  for (const k of leagues) leagueTeams[k] ??= 1;
  const teamRosters: Record<string, ClubTeam[]> = { ...(stored.teamRosters ?? {}) };
  const droppedTeamIds: string[] = [];
  const addedTeamIds: string[] = [];

  for (const d of diff) {
    if (d.action !== 'UPDATE' || !d.leagueKey) continue;
    const key = d.leagueKey;
    const n = d.requested;
    const prev = teamRosters[key] ?? [];
    if (n === 0) {
      const at = leagues.indexOf(key);
      if (at >= 0) leagues.splice(at, 1);
      delete leagueTeams[key];
      droppedTeamIds.push(...prev.map((t) => t.id));
      delete teamRosters[key];
      continue;
    }
    if (!leagues.includes(key)) leagues.push(key);
    leagueTeams[key] = n;
    if (n === 1) {
      droppedTeamIds.push(...prev.map((t) => t.id));
      delete teamRosters[key];
      continue;
    }
    if (prev.length >= n) {
      droppedTeamIds.push(...prev.slice(n).map((t) => t.id));
      teamRosters[key] = prev.slice(0, n);
      continue;
    }
    const next = [...prev];
    const used = new Set(Object.values(teamRosters).flatMap((r) => r.map((t) => t.id)));
    let i = next.length;
    while (next.length < n) {
      let id = `tm_${club.id}_${key}_${i++}`;
      while (used.has(id)) id = `tm_${club.id}_${key}_${i++}`;
      used.add(id);
      next.push({
        id,
        name: `${club.name} ${String.fromCharCode(65 + next.length)}`,
        ...(d.venue ? { venue: d.venue } : {}),
      });
      addedTeamIds.push(id);
    }
    teamRosters[key] = next;
  }
  // leagueTeams only for leagues the club is in (a stale entry would skew the counters).
  for (const k of Object.keys(leagueTeams)) if (!leagues.includes(k)) delete leagueTeams[k];
  return { plan: { leagues, leagueTeams, teamRosters }, droppedTeamIds, addedTeamIds };
}

function printEntryDiff(clubName: string, diff: EntryDiffRow[], storedKnown: boolean): void {
  console.log(`\n  ${clubName}`);
  console.log(
    `    ${'league'.padEnd(46)} ${'stored'.padStart(6)} ${'requested'.padStart(9)}  action`,
  );
  if (diff.length === 0) console.log('    (no teams requested or stored)');
  for (const d of diff) {
    const league = `${d.label} → ${d.leagueKey === null ? '(none)' : d.leagueKey === WOMENS_AGGREGATE ? "women's (sum)" : d.leagueKey}`;
    const stored = storedKnown ? String(d.stored) : '?';
    const action = storedKnown || d.action === 'manual' ? d.action : 'request';
    console.log(
      `    ${league.padEnd(46)} ${stored.padStart(6)} ${String(d.requested).padStart(9)}  ${action}${d.note ? ` — ${d.note}` : ''}`,
    );
  }
}

/** Read `<dir>/<club.folder>.xlsx` for every in-scope club. A missing file, a missing
 * Sheet1, or any entryFormProblems is a hard failure (returned, never thrown). */
async function loadEntryForms(
  dir: string,
  clubs: ClubMapEntry[],
): Promise<{ forms: Map<string, EntryFormRow[]>; failures: string[] }> {
  const forms = new Map<string, EntryFormRow[]>();
  const failures: string[] = [];
  for (const club of clubs) {
    const file = path.join(dir, `${club.folder}.xlsx`);
    try {
      await stat(file);
    } catch {
      failures.push(`${club.name}: entry form not found at ${file}`);
      continue;
    }
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.readFile(file);
    } catch (err) {
      failures.push(
        `${club.name}: cannot read ${file} as .xlsx (${err instanceof Error ? err.message : String(err)}) — ` +
          'BIFF .xls must be Save-As .xlsx first',
      );
      continue;
    }
    let rows: EntryFormRow[];
    try {
      rows = parseEntryFormWorkbook(wb).rows;
    } catch (err) {
      failures.push(`${club.name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (rows.length === 0) {
      failures.push(`${club.name}: no SENIORS/JUNIORS league rows found in ${file}`);
      continue;
    }
    const problems = entryFormProblems(rows);
    if (problems.length) {
      failures.push(...problems.map((p) => `${club.name}: ${p}`));
      continue;
    }
    forms.set(club.id, rows);
  }
  return { forms, failures };
}

// ───────────────────────── Phase P (parse) ─────────────────────────

/** Print the scope header every run shows — in-scope clubs, and ALWAYS the out-of-scope
 * list (even when empty), so a folder missing from a pack can never go unnoticed. */
function printScope(inScope: ClubMapEntry[], outOfScope: ClubMapEntry[]): void {
  console.log(
    `\n── Pack scope: ${inScope.length} club(s) in scope, ${outOfScope.length} out of scope`,
  );
  console.log(`  in scope:     ${inScope.map((c) => c.name).join(', ') || '(none)'}`);
  console.log(
    `  out of scope: ${outOfScope.map((c) => c.name).join(', ') || '(none — full pack)'}` +
      (outOfScope.length ? '  ← no folder in --dir; NOT parsed, checked or written' : ''),
  );
}

async function runParsePhase(args: Args): Promise<{
  classified: ClassifiedFile[];
  sections: StructureSection[];
  summary: ReturnType<typeof summarizeByClub>;
  inScope: ClubMapEntry[];
  entryForms: Map<string, EntryFormRow[]>;
} | null> {
  const files = await walkDocs(args.dir);
  const { classified, unclassified, unmappedFolders } = classifyAll(files);
  // Partial-pack scoping: only clubs whose folder is present in --dir are in play.
  const { inScope, outOfScope } = scopeClubs(files.map((f) => f.folder));
  printScope(inScope, outOfScope);
  printClassificationTable(classified, unclassified);
  printDocCoverageTable(classified, inScope);
  await printDocUploadPreview(classified, inScope);

  // --structure is optional (only --with-teams needs it — parseArgs enforces that).
  // Without it there is no structure report and no summary: clubs built here carry no
  // structure-derived ground venue or plan.
  const sections = args.structure ? await loadStructureSections(args.structure) : [];
  const { unresolvedTokens, emptySections } = args.structure
    ? printStructureReport(sections)
    : { unresolvedTokens: [], emptySections: [] };
  const summary = summarizeByClub(sections);

  let entryForms = new Map<string, EntryFormRow[]>();
  let entryFailures: string[] = [];
  if (args.teamsFromEntry) {
    ({ forms: entryForms, failures: entryFailures } = await loadEntryForms(
      args.entryForms,
      inScope,
    ));
    console.log(`\n── Entry-form team requests (stored plans compared at dry-run)`);
    for (const club of inScope) {
      const rows = entryForms.get(club.id);
      if (rows) printEntryDiff(club.name, diffEntryForm(rows, EMPTY_STORED_PLAN), false);
    }
  }

  const noDocsClubs = inScope.filter(
    (c) => !classified.some((f) => f.club?.id === c.id && f.docKey),
  );

  const hardFailures: string[] = [];
  if (inScope.length === 0)
    hardFailures.push(`no CLUB_MAP club folder found in --dir "${args.dir}" — nothing in scope`);
  if (args.club && !inScope.some((c) => c.id === args.club))
    hardFailures.push(
      CLUB_MAP.some((c) => c.id === args.club)
        ? `--club "${args.club}" is out of scope (no folder for it in --dir)`
        : `--club "${args.club}" not in CLUB_MAP`,
    );
  for (const f of entryFailures) hardFailures.push(`entry form — ${f}`);
  if (unclassified.length)
    hardFailures.push(`${unclassified.length} unclassified file(s) — see above`);
  if (unmappedFolders.length)
    hardFailures.push(`folder(s) not in CLUB_MAP: ${unmappedFolders.join(', ')}`);
  if (unresolvedTokens.length)
    hardFailures.push(`${unresolvedTokens.length} unresolved structure team token(s) — see above`);
  if (emptySections.length)
    hardFailures.push(`empty mapped section(s): ${emptySections.join(', ')}`);
  if (noDocsClubs.length)
    hardFailures.push(
      `club(s) with zero classified docs: ${noDocsClubs.map((c) => c.name).join(', ')}`,
    );

  if (hardFailures.length) {
    console.error(`\n✗ Refusing to continue:\n${hardFailures.map((f) => `   ${f}`).join('\n')}`);
    process.exitCode = 1;
    return null;
  }

  console.log('\n✓ Parse phase clean.');
  return { classified, sections, summary, inScope, entryForms };
}

// ───────────────────────── Phase 1/2/3 (dry-run / confirm) ─────────────────────────

/**
 * Largest post-dedupe file count any single club has, per multi-file doc key. Reuses
 * dedupeGroup so this can never disagree with what the upload phase actually stores.
 */
async function maxFilesNeededPerMultiKey(
  classified: ClassifiedFile[],
): Promise<Map<string, number>> {
  const groups = new Map<string, ClassifiedFile[]>();
  for (const f of classified) {
    if (!f.docKey || !f.club || !MULTI_FILE_DOC_KEYS.has(f.docKey)) continue;
    const k = `${f.club.id}::${f.docKey}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const worst = new Map<string, number>();
  for (const [groupKey, files] of groups) {
    const docKey = groupKey.split('::')[1];
    const { keep } = await dedupeGroup(files);
    worst.set(docKey, Math.max(worst.get(docKey) ?? 0, keep.length));
  }
  return worst;
}

/**
 * The catalogue must not merely CONTAIN this import's keys — it must be shaped to hold
 * what the pack actually carries. `neededPerMultiKey` is the largest post-dedupe file
 * count any single club has for each multi-file key (Irene Villagers ships 4 distinct
 * facility MOUs, Centurion Kavaliers 3 AGM documents). Checked here, at dry-run, because
 * these CLIs write through repo and so bypass the route validation that would otherwise
 * catch a too-small cap — without this the import would happily store more files than
 * the tenant's own catalogue permits, and the next append through the API would fail on
 * data this script created.
 */
/**
 * Pure problem-list builder behind `assertCatalogueCoverage` — split out so the
 * (deliberately two-directional) multiFile checks can be unit-tested without a repo/
 * tenant config. Checks both directions: every `MULTI_FILE_DOC_KEYS` entry must BE
 * configured multiFile in the catalogue (forward), and no OTHER `TITANS_DOC_KEYS` entry
 * may be configured multiFile (reverse) — `buildDocMetaValue` dispatches purely on
 * `MULTI_FILE_DOC_KEYS`, not on the catalogue's own `multiFile` flag, so a mismatch in
 * either direction makes the import write the wrong docMeta shape. In the reverse case
 * that silently discards a club rep's genuine file (see the loop's own comment).
 */
function catalogueCoverageProblems(
  active: RequiredDoc[],
  neededPerMultiKey: Map<string, number>,
): string[] {
  const problems: string[] = [];
  for (const key of MULTI_FILE_DOC_KEYS) {
    const def = active.find((d) => d.key === key);
    if (!def) {
      problems.push(`"${key}" is archived or absent — this import stores several files under it`);
      continue;
    }
    if (!def.multiFile) {
      problems.push(
        `"${key}" is configured single-file, but the pack has clubs with more than one ` +
          `(mark it multiFile in the operator portal)`,
      );
      continue;
    }
    const needed = neededPerMultiKey.get(key) ?? 0;
    const cap = multiFileLimits(def).max;
    if (needed > cap) {
      problems.push(
        `"${key}" allows maxFiles=${cap} but one club needs ${needed} — raise the cap first`,
      );
    }
  }
  // Reverse direction: the loop above only checks that every MULTI_FILE_DOC_KEYS entry
  // IS configured multiFile. It never checks the opposite — an operator marking some
  // OTHER TITANS_DOC_KEYS entry (say "committee") multiFile in the portal. buildDocMetaValue
  // dispatches purely on MULTI_FILE_DOC_KEYS (not on the catalogue's own multiFile flag),
  // so it would still write a single-file `{objectKey}` shape into that key — and if the
  // club already has an import file plus a rep's genuine file in `files[]`, the
  // single-file dispatch (`files[files.length - 1]`) silently discards the rep's file.
  for (const key of TITANS_DOC_KEYS) {
    if (MULTI_FILE_DOC_KEYS.has(key)) continue;
    const def = active.find((d) => d.key === key);
    if (def?.multiFile) {
      problems.push(
        `"${key}" is configured multiFile in the tenant catalogue, but this import treats it ` +
          'as single-file (only ' +
          `${[...MULTI_FILE_DOC_KEYS].join('/')} are multi-file) — a club with an existing rep ` +
          'file for this key would have that file silently discarded. Either unmark multiFile ' +
          'for this key in the operator portal, or add it to MULTI_FILE_DOC_KEYS in ' +
          'titans-import-map.ts.',
      );
    }
  }
  return problems;
}

/**
 * Every league key the team plan references must exist in TenantConfig.leagues before a
 * club record may point at it — a dangling key silently hides those teams from every
 * picker and breaks player registration for that league. Keys in EXTRA_LEAGUES
 * (Women's/Veterans, which the tenant wasn't originally configured with) are appended on
 * `--add-missing-leagues` in confirm mode, mirroring the operator LeaguesCard's entry
 * shape; anything else missing is a hard abort — a genuinely new competition must be
 * configured deliberately, never minted as a side effect of an import.
 */
async function ensureLeaguesConfigured(
  repo: RepoModule,
  args: Args,
  referencedKeys: Set<string>,
): Promise<void> {
  const config = await repo.getTenantConfig(TENANT);
  if (!config) throw new Error(`tenant "${TENANT}" has no config — has it been created?`);
  const configured = new Set((config.leagues ?? []).map((l) => l.key));
  const missing = [...referencedKeys].filter((k) => !configured.has(k));
  if (missing.length === 0) {
    console.log(`✓ All ${referencedKeys.size} referenced league keys are configured.`);
    return;
  }
  const addable = EXTRA_LEAGUES.filter((l) => missing.includes(l.key));
  const unknown = missing.filter((k) => !EXTRA_LEAGUES.some((l) => l.key === k));
  if (unknown.length) {
    throw new Error(
      `team plan references league key(s) not configured on "${TENANT}" and not in ` +
        `EXTRA_LEAGUES: ${unknown.join(', ')}. Configure them in the operator console first.`,
    );
  }
  if (!args.confirm) {
    console.log(
      `· leagues: ${addable.map((l) => l.key).join(', ')} missing from the tenant config — ` +
        (args.addMissingLeagues
          ? 'will be appended on --confirm.'
          : 'pass --add-missing-leagues (or add them in the operator console) before --confirm.'),
    );
    return;
  }
  if (!args.addMissingLeagues) {
    throw new Error(
      `TenantConfig.leagues is missing ${addable.map((l) => l.key).join(', ')} — re-run with ` +
        '--add-missing-leagues to append them, or add them in the operator console first.',
    );
  }
  const next = [
    ...(config.leagues ?? []),
    ...addable.map((l) => ({ ...l, district: OVERARCHING_DISTRICT })),
  ];
  await repo.putTenantConfig({ ...config, leagues: next });
  console.log(`✓ appended league(s) to ${TENANT}: ${addable.map((l) => l.key).join(', ')}`);
}

async function assertCatalogueCoverage(
  repo: RepoModule,
  neededPerMultiKey: Map<string, number>,
): Promise<RequiredDoc[]> {
  const config = await repo.getTenantConfig(TENANT);
  if (!config) throw new Error(`tenant "${TENANT}" has no config — has it been created?`);
  const active = activeRequiredDocs(config);
  const configuredKeys = new Set(resolveRequiredDocs(config).map((d) => d.key));
  const missing = TITANS_DOC_KEYS.filter((k) => !configuredKeys.has(k));
  if (missing.length) {
    throw new Error(
      `tenant "${TENANT}" requiredDocs catalogue is missing key(s) this import needs: ` +
        `${missing.join(', ')}. Configure them on the tenant (operator portal) before importing.`,
    );
  }
  const problems = catalogueCoverageProblems(active, neededPerMultiKey);
  if (problems.length) {
    throw new Error(
      `tenant "${TENANT}" requiredDocs catalogue cannot hold this pack:\n  - ${problems.join('\n  - ')}`,
    );
  }
  return active;
}

function docFileExtension(filename: string): string {
  return path.extname(filename).slice(1).toLowerCase();
}

/**
 * The ONLY producer of import-authored object keys — and it must use IMPORT_KEY_MARKER,
 * not a hardcoded copy of it. `isImportObjectKey` is the only consumer, and two
 * destructive paths depend on the pair agreeing: `isPristine` (which decides whether a
 * club may be deleted outright) and the revert strip's S3 delete. If a literal here
 * drifted from the constant, revert would silently recognise nothing — reporting success
 * while leaving member databases full of ID numbers and minors' data in the bucket, which
 * has no lifecycle rule to catch them (ADR 0009).
 */
function contentAddressedKey(clubId: string, docKey: string, sha256: string, ext: string): string {
  return `${TENANT}/${clubId}/${docKey}${IMPORT_KEY_MARKER}${sha256.slice(0, 16)}.${ext}`;
}

async function runConfirm(
  repo: RepoModule,
  args: Args,
  classified: ClassifiedFile[],
  summary: ReturnType<typeof summarizeByClub>,
  activeDocs: RequiredDoc[],
  inScope: ClubMapEntry[],
  entryForms: Map<string, EntryFormRow[]>,
): Promise<void> {
  await warnManifestContext();
  const existing = await repo.listClubs(TENANT);
  const existingById = new Map(existing.map((c) => [c.id, c]));
  const titansExisting = existing.filter((c) => CLUB_MAP.some((m) => m.id === c.id));

  const backupPath = `./titans-import-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(backupPath, JSON.stringify(titansExisting, null, 2));
  console.log(`Backup written: ${backupPath} (${titansExisting.length} existing titans club(s))`);

  // Scoped to the clubs whose folder is in --dir: a partial pack must never merge into,
  // audit-note, or (on a fresh stage) create the clubs it carries nothing for.
  const targets = args.club ? inScope.filter((c) => c.id === args.club) : inScope;
  if (targets.length === 0) throw new Error('no in-scope club to write (check --dir/--club)');

  // A present-but-unparseable manifest must never be silently overwritten with only
  // this run's ids — that would discard every previously recorded creation the moment
  // the first `manifest.add` below fires. Only "absent" (no file yet) is safe to start
  // from empty; "corrupt" aborts loudly so the operator fixes/moves the file first.
  const manifestResult = await readCreatedClubsManifest();
  if (manifestResult.kind === 'corrupt') {
    throw new Error(
      `${createdClubsManifestPath()} exists but is unreadable/malformed (${manifestResult.detail}) ` +
        '— refusing to continue: writing through it now would silently discard every club id a ' +
        'prior run recorded. Fix the file by hand or move it aside before re-running --confirm.',
    );
  }
  const manifest = manifestResult.kind === 'ok' ? manifestResult.ids : new Set<string>();

  let created = 0;
  let merged = 0;
  let teamPlansWritten = 0;
  for (const club of targets) {
    const already = existingById.get(club.id);
    const entryRows = args.teamsFromEntry ? entryForms.get(club.id) : undefined;
    // --teams-from-entry on a club that doesn't exist yet (the dev rehearsal): the entry
    // form's plan becomes the club's initial plan via buildClub.
    const initialEntryPlan =
      entryRows && !already
        ? applyEntryFormDiff(club, EMPTY_STORED_PLAN, diffEntryForm(entryRows, EMPTY_STORED_PLAN))
            .plan
        : undefined;
    // Colour by CLUB_MAP position (not scoped-target position) so a partial pack picks
    // the same colour a full-pack run would have.
    const built = buildClub(
      club,
      activeDocs,
      summary.get(club.id),
      args.withTeams,
      CLUB_MAP.indexOf(club),
      initialEntryPlan,
    );
    if (!already) {
      // Write-before-create: the id is persisted to the manifest BEFORE `createClub` is
      // even attempted, not after it succeeds. The danger this manifest exists to
      // prevent is a FALSE NEGATIVE — a club genuinely created but never recorded,
      // which `--revert --all` then treats as pre-existing and refuses to delete (see
      // this const's module-level comment). Recording first closes that gap entirely:
      // even a crash mid-`createClub` (Ctrl-C, a throttle whose response never
      // arrives) can't produce an unrecorded creation, because the id is already
      // durable before the call is made. The opposite failure mode — `createClub`
      // definitively fails afterwards — leaves a harmless FALSE POSITIVE: `--revert
      // --all` only ever iterates clubs that actually exist on the tenant (`mine`,
      // filtered from `repo.listClubs`), so a manifest id with no matching club is
      // silently never visited. A false positive here is inert; a false negative is
      // exactly the bug this manifest exists to prevent — so the write-before variant
      // is the safer of the two orderings.
      if (!manifest.has(club.id)) {
        manifest.add(club.id);
        await writeCreatedClubsManifest(manifest);
      }
      try {
        await repo.createClub(TENANT, built);
        created++;
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
        // Lost a race with a concurrent run — fall through to the merge path below.
      }
    }
    const current = already ?? (await repo.getClub(TENANT, club.id));
    if (current) {
      // Merge: fill ONLY absent fields — never clobber real chair/exco/CQI progress an
      // admin or club rep has already entered.
      const patch: Partial<Club> = {};
      if (!current.ground?.venue && built.ground.venue) patch.ground = built.ground;
      // Team plan (--with-teams): for a club THIS import created (manifest-proven) that
      // no one has touched since (affiliation still 'not_started' — reps don't exist
      // until they're invited, and an admin edit or affiliation submit moves the state),
      // the import OWNS the plan and replaces it wholesale. That is what lets a re-run
      // deliver corrections and enrichments — new league keys (Women's/Veterans), sheet
      // side names, per-side venues — to clubs the first pass already wrote with the
      // fill-absent rule alone, which would otherwise freeze the first pass's output
      // forever. A pre-existing club, or one whose affiliation has moved, keeps the
      // conservative fill-absent behaviour: someone else's data may be in there.
      const ownsTeamPlan =
        args.withTeams && manifest.has(club.id) && current.affiliation === 'not_started';
      if (ownsTeamPlan && built.leagues.length) {
        patch.leagues = built.leagues;
        patch.leagueTeams = built.leagueTeams;
        patch.teamRosters = built.teamRosters;
        patch.teams = built.teams;
        patch.women = built.women;
        patch.juniors = built.juniors;
      } else {
        if ((!current.leagues || current.leagues.length === 0) && built.leagues.length)
          patch.leagues = built.leagues;
        if (args.withTeams) {
          if (!current.leagueTeams && built.leagueTeams) patch.leagueTeams = built.leagueTeams;
          if (!current.teamRosters && built.teamRosters) patch.teamRosters = built.teamRosters;
        }
      }
      // --teams-from-entry: diff the entry form against what is stored NOW and write only
      // where a league differs (see diffEntryForm/applyEntryFormDiff). A club created a
      // moment ago from the same form diffs clean. The patch pins `version` to the club
      // as read at the top of this run, so an admin edit landing in between fails the
      // write (VersionConflictError) instead of being silently overwritten.
      if (entryRows) {
        const stored = storedPlanOf(current);
        const diff = diffEntryForm(entryRows, stored);
        printEntryDiff(club.name, diff, true);
        if (diff.some((d) => d.action === 'UPDATE')) {
          const { plan, droppedTeamIds, addedTeamIds } = applyEntryFormDiff(club, stored, diff);
          const counts = deriveTeamPlanCounts(plan.leagueTeams);
          patch.leagues = plan.leagues;
          patch.leagueTeams = plan.leagueTeams;
          patch.teamRosters = plan.teamRosters;
          patch.teams = counts.teams;
          patch.women = counts.women;
          patch.juniors = counts.juniors;
          patch.version = current.version;
          teamPlansWritten++;
          if (droppedTeamIds.length)
            console.log(`    dropped team id(s): ${droppedTeamIds.join(', ')}`);
          if (addedTeamIds.length) console.log(`    added team id(s): ${addedTeamIds.join(', ')}`);
        }
      }
      const missingDocs = Object.keys(built.docs).filter((k) => current.docs?.[k] === undefined);
      if (missingDocs.length) {
        patch.docs = { ...current.docs, ...Object.fromEntries(missingDocs.map((k) => [k, false])) };
      }
      if (Object.keys(patch).length) {
        await repo.updateClub(
          TENANT,
          club.id,
          patch,
          'import:titans-compliance-2026',
          new Date().toISOString(),
        );
        merged++;
      }
      // Guard against duplicate notes on re-runs — the runbook explicitly encourages
      // re-running --confirm after a partial revert, and an unconditional append would
      // accumulate an identical note every time.
      const noteAlreadyPresent = (current.notes ?? []).some((n) => n.text === AUDIT_NOTE);
      if (!noteAlreadyPresent) {
        await repo.appendClubNote(TENANT, club.id, {
          id: `note_${Date.now()}_${club.id}`,
          text: AUDIT_NOTE,
          author: 'import:titans-compliance-2026',
          at: new Date().toISOString(),
        });
      }
    }
  }
  console.log(`· clubs: ${created} created, ${merged} merged`);
  if (args.teamsFromEntry)
    console.log(`· team plans: ${teamPlansWritten} club(s) updated from entry forms`);
  console.log(
    `· created-clubs manifest: ${createdClubsManifestPath()} has ${manifest.size} club(s) ` +
      'recorded as created by this import across all runs (persisted incrementally as each ' +
      'club was created, not batched at the end).',
  );

  if (args.skipDocs) {
    console.log('· --skip-docs: doc upload phase skipped.');
    return;
  }
  await runDocUploadPhase(repo, args, classified, activeDocs);
}

/**
 * docMeta normalization is IMPORTED from catalogue.ts, not replicated here. This script
 * writes docMeta through `repo`, bypassing the routes, so it must agree with them exactly
 * on every historical stored shape — a hand-copied replica that drifted would silently
 * corrupt real compliance records on a production write. Same reasoning as club-id.ts and
 * player-identity.ts. `normalizeDocMeta` handles the multi-file `{ files: [...] }`
 * wrapper, a legacy single-file `{ objectKey, … }` object, and the admin
 * `{ markedCompliant, at }` sentinel with or without a stored file.
 */

function unionDocFiles(stored: DocFileEntry[], incoming: DocFileEntry[]): DocFileEntry[] {
  const byKey = new Map(stored.map((f) => [f.objectKey, f]));
  for (const f of incoming) byKey.set(f.objectKey, f);
  return [...byKey.values()];
}

/** Re-wrap normalized state as the stored docMeta value for one key — single- and
 * multi-file alike carry `markedCompliant`/`at`/`courseBooked`/`courseDate` forward
 * when present, never dropping an admin's sentinel just because this import also has a
 * file for the same key. The multi-file shape comes straight from the shared
 * `docMetaValue` the routes use; only the single-file shape (a bare object, no `files`
 * wrapper) is assembled here, because the routes build that one inline. */
function buildDocMetaValue(
  docKey: string,
  files: DocFileEntry[],
  norm: NormalizedDocMeta,
): unknown {
  if (MULTI_FILE_DOC_KEYS.has(docKey)) {
    // `norm` as the extra: course booking AND a club's unavailable declaration ride
    // through a re-run merge, exactly as on the routes.
    return docMetaValue(files, norm.markedCompliant, norm.at, norm);
  }
  // Single-file: exactly one entry (dedupeGroup + the clash check below enforce this),
  // still carrying markedCompliant/at forward if an admin had set them.
  // A club's unavailable declaration is deliberately NOT carried here: a real file
  // supersedes a single-file declaration (the portal and record route treat it so).
  const only = files[files.length - 1];
  return norm.markedCompliant ? { ...only, markedCompliant: true, at: norm.at } : only;
}

/**
 * Fail-closed validation of every target file's resolved MIME type against its doc
 * definition's `accepts` — the same check the HTTP presign route applies (see
 * `acceptedMimes` in catalogue.ts), which these CLIs would otherwise bypass entirely
 * (they write through `repo`/S3 directly, not through the route). Run before ANY S3
 * write (and even in dry-run, since `runDocUploadPhase` is now also called from the
 * dry-run path) — an unresolvable/unaccepted format must be caught before --confirm,
 * never discovered after upload.
 */
function validateDocMimes(targets: ClassifiedFile[], activeDocs: RequiredDoc[]): void {
  const defByKey = new Map(activeDocs.map((d) => [d.key, d]));
  const offenders: string[] = [];
  for (const f of targets) {
    if (!f.club || !f.docKey) continue;
    const ext = docFileExtension(f.filename);
    const mime = DOC_FORMAT_MIME[ext as keyof typeof DOC_FORMAT_MIME] ?? 'application/octet-stream';
    const def = defByKey.get(f.docKey);
    const accepted = acceptedMimes(def);
    if (!(mime in accepted)) {
      const acceptedExts = Object.values(accepted).join(', ') || '(none configured)';
      offenders.push(
        `${f.club.id}/${f.docKey}: "${f.rel}" resolves to ${mime}${ext ? ` (.${ext})` : ' (no extension)'} — catalogue accepts: ${acceptedExts}`,
      );
    }
  }
  if (offenders.length) {
    throw new Error(
      `${offenders.length} file(s) fail the tenant's accepted-type validation — the ` +
        `HTTP upload route would reject these, and this script writes through repo/S3 ` +
        `directly so bypasses that check unless done here:\n  - ${offenders.join('\n  - ')}`,
    );
  }
}

async function runDocUploadPhase(
  repo: RepoModule,
  args: Args,
  classified: ClassifiedFile[],
  activeDocs: RequiredDoc[],
): Promise<void> {
  const targets = args.club ? classified.filter((f) => f.club?.id === args.club) : classified;

  // Fail-closed MIME validation runs first, before any dedupe/hash/S3 work — see
  // validateDocMimes's own comment.
  validateDocMimes(targets, activeDocs);

  // Only mint an S3 client (and require UPLOADS_BUCKET) when actually writing — the
  // dry-run path calls this same function purely to REPORT what would happen, and must
  // stay strictly read-only (no S3 client needed at all when nothing will be sent).
  let s3: import('@aws-sdk/client-s3').S3Client | null = null;
  let bucket: string | undefined;
  if (args.confirm) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    // env.ts's helper, not bare process.env: under `sst shell` the bucket name arrives
    // via the SST resource (Resource.Uploads.name), not an exported env var.
    const { uploadsBucket } = await import('./env.js');
    bucket = uploadsBucket();
    s3 = new S3Client({});
  }
  const { PutObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');

  const defByKey = new Map(activeDocs.map((d) => [d.key, d]));

  // Group by (clubId, docKey) so a multi-file doc uploads/reports as one unit and a
  // single-file doc's accidental duplicate is caught before any write.
  const groups = new Map<string, ClassifiedFile[]>();
  for (const f of targets) {
    if (!f.club || !f.docKey) continue;
    const key = `${f.club.id}::${f.docKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }

  let uploaded = 0;
  let skippedNoop = 0;
  let deduped = 0;
  const clashes: string[] = [];
  const verb = args.confirm ? 'uploaded' : 'would upload';

  for (const [groupKey, files] of groups) {
    const [clubId, docKey] = groupKey.split('::');
    const { keep, dupesOf } = await dedupeGroup(files);
    deduped += dupesOf.size;
    if (dupesOf.size) {
      for (const [dupe, kept] of dupesOf)
        console.log(`  dedupe: "${dupe}" is byte-identical to "${kept}" — skipped`);
    }
    if (!MULTI_FILE_DOC_KEYS.has(docKey) && keep.length > 1) {
      clashes.push(
        `${clubId}/${docKey}: ${keep.length} distinct (non-duplicate) files for a single-file doc — ${keep.map((f) => f.rel).join(', ')}`,
      );
      continue;
    }

    // The club may not exist yet in dry-run (created only in Phase 2/3) — never a
    // reason to hide what would upload; only a genuine anomaly once --confirm has
    // already run the club create/merge phase before this one.
    const club = await repo.getClub(TENANT, clubId);
    if (!club) {
      if (args.confirm) {
        console.log(`  skip: club "${clubId}" not found (create it first)`);
        continue;
      }
    }
    const norm = normalizeDocMeta(club?.docMeta?.[docKey]);

    // Never clobber a NON-import file already present for a single-file doc — a club
    // rep's real upload through the portal is never overwritten by this import.
    //
    // Checks EVERY entry, not just files[0]: a key that was multiFile at some point can
    // have accumulated [import, repUpload] and since been flipped back to single-file in
    // the portal. files[0] alone would then look import-authored, no clash would be
    // recorded, and the single-file write below (which keeps only the last entry) would
    // both drop the rep's record AND list their object as superseded — deleting it.
    const foreign = norm.files.find((f) => !isImportObjectKey(f.objectKey, clubId, docKey));
    if (!MULTI_FILE_DOC_KEYS.has(docKey) && foreign) {
      clashes.push(
        `${clubId}/${docKey}: existing non-import objectKey present — left untouched (${foreign.objectKey})`,
      );
      continue;
    }

    const newEntries: DocFileEntry[] = [];
    let anyNew = false;
    for (const f of keep) {
      const bytes = await readFile(f.abs);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const ext = docFileExtension(f.filename);
      const objectKey = contentAddressedKey(clubId, docKey, hash, ext);
      const mime =
        DOC_FORMAT_MIME[ext as keyof typeof DOC_FORMAT_MIME] ?? 'application/octet-stream';

      const alreadyThere =
        norm.files.some((e) => e.objectKey === objectKey) ||
        newEntries.some((e) => e.objectKey === objectKey);
      if (alreadyThere) {
        skippedNoop++;
        continue;
      }
      if (args.confirm && s3 && bucket) {
        await s3.send(
          new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: bytes, ContentType: mime }),
        );
      }
      newEntries.push({
        objectKey,
        size: bytes.length,
        contentType: mime,
        uploadedAt: new Date().toISOString(),
      });
      anyNew = true;
      uploaded++;
    }
    if (!anyNew) continue;
    if (!club) continue; // dry-run, club doesn't exist yet — reported via `uploaded` count only

    if (args.confirm) {
      const docMeta = { ...(club.docMeta ?? {}) };
      const merged = unionDocFiles(norm.files, newEntries);
      docMeta[docKey] = buildDocMetaValue(docKey, merged, norm);
      const { min } = multiFileLimits(defByKey.get(docKey));
      const docs = {
        ...club.docs,
        [docKey]:
          norm.markedCompliant ||
          norm.courseBooked ||
          (MULTI_FILE_DOC_KEYS.has(docKey) && unavailableDeclared(norm, defByKey.get(docKey))) ||
          merged.length >= min,
      };
      // Single-file re-run with changed bytes: unionDocFiles keeps every distinct
      // objectKey (content-addressed, so a changed pack file mints a new key), but
      // buildDocMetaValue's single-file dispatch stores only `merged[merged.length -
      // 1]` — every earlier entry is a SUPERSEDED object nothing will reference once
      // this write lands. ADR 0009 deliberately has no lifecycle rule, so an
      // unreferenced import object is a permanent PII orphan (member databases, ID
      // numbers) unless deleted here.
      const supersededKeys =
        !MULTI_FILE_DOC_KEYS.has(docKey) && merged.length > 1
          ? merged.slice(0, -1).map((f) => f.objectKey)
          : [];
      await repo.updateClub(
        TENANT,
        clubId,
        { docs, docMeta },
        'import:titans-compliance-2026',
        new Date().toISOString(),
      );
      // Deleted only AFTER the updateClub write lands, never before — deleting first
      // and then having the write fail would strand a live docMeta pointer at an
      // object that no longer exists.
      for (const key of supersededKeys) {
        try {
          await s3!.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
          console.log(
            `  cleanup: deleted superseded S3 object ${key} (single-file doc "${docKey}" replaced by a re-run)`,
          );
        } catch (err) {
          // Best-effort, same as the revert-strip path — an orphaned S3 object is a
          // cleanup nuisance, not a reason to abandon a DynamoDB write already landed.
          console.warn(`  ⚠ failed to delete superseded S3 object ${key}:`, err);
        }
      }
    }
  }

  console.log(
    `\n· docs: ${uploaded} ${verb}, ${skippedNoop} already-current (no-op), ${deduped} byte-identical duplicate(s) skipped`,
  );
  if (clashes.length) {
    console.log(`  ⚠ ${clashes.length} clash(es) reported, left untouched:`);
    for (const c of clashes) console.log(`     ${c}`);
  }
}

// ───────────────────────── Revert ─────────────────────────

function isPristine(club: Club): boolean {
  if (club.affiliation !== 'not_started') return false;
  const docMeta = club.docMeta ?? {};
  for (const [docKey, value] of Object.entries(docMeta)) {
    const m = value as { objectKey?: string; files?: { objectKey: string }[] } | null;
    if (m?.objectKey && !isImportObjectKey(m.objectKey, club.id, docKey)) return false;
    if (m?.files?.some((f) => !isImportObjectKey(f.objectKey, club.id, docKey))) return false;
  }
  return true;
}

/**
 * Decide what `--revert` does when the created-clubs manifest isn't usable. Split out of
 * runRevert — like catalogueCoverageProblems — so both destructive branches can be
 * unit-tested without a repo, a tenant config, or a real manifest on disk. Pure.
 *
 * `refuse` for `--all --erase-preexisting`: without positive evidence this run cannot
 * tell an import-created club from a pre-existing one it merely merged into, so that flag
 * can no longer mean what it says — every non-pristine CLUB_MAP club would be treated as
 * "pre-existing, force it" and fully deleted. Refusing beats guessing.
 * `warn` for a bare `--all`: the fallback to pristine-only really is safe there.
 */
export function revertManifestGate(
  args: { all?: boolean; erasePreexisting?: boolean },
  manifestResult: { kind: 'absent' } | { kind: 'corrupt'; detail: string } | { kind: 'ok' },
): { kind: 'proceed' } | { kind: 'warn'; message: string } | { kind: 'refuse'; message: string } {
  if (!args.all || manifestResult.kind === 'ok') return { kind: 'proceed' };
  const why =
    manifestResult.kind === 'corrupt'
      ? `is present but unreadable/malformed (${manifestResult.detail})`
      : 'is missing';
  if (args.erasePreexisting) {
    return {
      kind: 'refuse',
      message:
        `--revert --all --erase-preexisting requires a readable ${createdClubsManifestPath()}, ` +
        `which ${why}. Without it, every non-pristine CLUB_MAP club would be treated as ` +
        '"pre-existing, force it" and fully deleted — refusing rather than guessing. Restore ' +
        'or fix the manifest, or omit --erase-preexisting to strip import docs only.',
    };
  }
  return {
    kind: 'warn',
    message:
      `⚠ --all requested but ${createdClubsManifestPath()} ${why} — this import cannot ` +
      'positively tell an import-created club apart from a pre-existing one it only merged ' +
      'into, so --all is falling back to pristine-only deletion (same as no --all).',
  };
}

async function runRevert(repo: RepoModule, args: Args): Promise<void> {
  await warnManifestContext();
  // NOTE (prod): every import-authored objectKey shares the `-import-` marker, so a plain
  // `--revert` strips the AUGUST import's docs too, not just a later top-up's. Recovery
  // for a bad top-up doc is fix-the-pack-and-re-run, never a prod revert (runbook).
  //
  // --club narrows the revert to one club — it used to be parsed and silently ignored
  // here, so `--revert --club x` reverted EVERY CLUB_MAP club.
  if (args.club && !CLUB_MAP.some((m) => m.id === args.club))
    throw new Error(`--club "${args.club}" not in CLUB_MAP`);
  const clubs = await repo.listClubs(TENANT);
  const mine = clubs.filter(
    (c) => CLUB_MAP.some((m) => m.id === c.id) && (!args.club || c.id === args.club),
  );
  if (mine.length === 0) {
    console.log('Nothing to revert.');
    return;
  }

  // `mine` = every CLUB_MAP club currently on the tenant, which includes clubs this
  // import only MERGED into — a pre-existing club with a real chair/exco/roster that
  // happened to also need a missing ground/leagues field filled. `--all` must never
  // erase one of those; it forces the delete only for clubs the manifest positively
  // confirms THIS import created. See LEGACY_CREATED_CLUBS_MANIFEST_PATH's comment for why
  // this signal (not onboardedVia / the audit note / club.version) is the robust one.
  const manifestResult = args.all
    ? await readCreatedClubsManifest()
    : ({ kind: 'absent' } as const);
  const gate = revertManifestGate(args, manifestResult);
  if (gate.kind === 'refuse') throw new Error(gate.message);
  if (gate.kind === 'warn') console.log(gate.message);
  const createdManifest = manifestResult.kind === 'ok' ? manifestResult.ids : null;

  // S3 client for the strip path's object deletion (fix for orphaned import uploads —
  // see the strip loop below). Lazy + only required when actually deleting.
  let s3: import('@aws-sdk/client-s3').S3Client | null = null;
  let bucket: string | undefined;
  let DeleteObjectCommand: typeof import('@aws-sdk/client-s3').DeleteObjectCommand | undefined;
  if (args.confirm) {
    const mod = await import('@aws-sdk/client-s3');
    DeleteObjectCommand = mod.DeleteObjectCommand;
    // env.ts's helper, not bare process.env — see runDocUploadPhase.
    const { uploadsBucket } = await import('./env.js');
    bucket = uploadsBucket();
    s3 = new mod.S3Client({});
  }

  let deletedClubs = 0;
  let strippedClubs = 0;
  let deletedObjects = 0;
  for (const club of mine) {
    const playerCount = (await repo.listPlayers(TENANT, club.id)).length;
    const pristine = playerCount === 0 && isPristine(club);
    const createdByImport = createdManifest?.has(club.id) ?? false;
    const forcedPreexisting = args.all && args.erasePreexisting && !createdByImport && !pristine;
    const eligibleForFullDelete = pristine || (args.all && createdByImport) || forcedPreexisting;

    if (eligibleForFullDelete) {
      const reason = pristine
        ? ''
        : createdByImport
          ? ' — NOT pristine, import-created, --all forced'
          : ' — NOT pristine, PRE-EXISTING club, --erase-preexisting forced';
      console.log(
        `${args.confirm ? 'delete' : '[dry-run] would delete'}  ${club.id}  (${club.name}${reason})`,
      );
      if (args.confirm) {
        await repo.eraseClubData(TENANT, club);
        deletedClubs++;
      }
      continue;
    }
    if (args.all && !pristine && !createdByImport) {
      console.log(
        `  skip: ${club.id}  (${club.name}) — pre-existing club this import only merged into; ` +
          'pass --erase-preexisting (with --all) to force, or omit --all to strip its import docs.',
      );
      continue;
    }

    // Not eligible for full delete: strip only import-marked doc keys, and delete the
    // S3 objects those keys reference — every import-uploaded document (including
    // member databases full of names, race, ID numbers, minors) otherwise stays in the
    // bucket unreferenced forever (ADR 0009 deliberately has no lifecycle rule).
    const docMeta = { ...(club.docMeta ?? {}) };
    const docs = { ...club.docs };
    let stripped = 0;
    const objectKeysToDelete: string[] = [];
    for (const [key, value] of Object.entries(docMeta)) {
      const m = value as { objectKey?: string; files?: { objectKey: string }[] } | null;
      const isImportSingle = m?.objectKey ? isImportObjectKey(m.objectKey, club.id, key) : false;
      const isImportMulti =
        m?.files?.length && m.files.every((f) => isImportObjectKey(f.objectKey, club.id, key));
      if (isImportSingle) objectKeysToDelete.push(m!.objectKey!);
      if (isImportMulti) for (const f of m!.files!) objectKeysToDelete.push(f.objectKey);
      if (isImportSingle || isImportMulti) {
        delete docMeta[key];
        docs[key] = false;
        stripped++;
      }
    }
    if (stripped > 0) {
      console.log(
        `${args.confirm ? 'strip' : '[dry-run] would strip'}  ${club.id}  (${club.name}) — ` +
          `${stripped} import-marked doc key(s), ${objectKeysToDelete.length} S3 object(s)`,
      );
      if (args.confirm) {
        // Record FIRST, delete after — same ordering as every other path that drops an
        // object (the API's replace/delete routes, the intake commit, the doc-upload
        // phase above). Deleting first and then failing the write would leave docMeta
        // pointing at keys that no longer exist: view-url would presign a 404 for a
        // document the portal still shows as uploaded, with nothing recording why.
        await repo.updateClub(
          TENANT,
          club.id,
          { docs, docMeta },
          'import:titans-compliance-2026',
          new Date().toISOString(),
        );
        strippedClubs++;
        for (const key of objectKeysToDelete) {
          try {
            await s3!.send(new DeleteObjectCommand!({ Bucket: bucket, Key: key }));
            deletedObjects++;
          } catch (err) {
            // Best-effort, same as the API routes' own doc-replace/delete paths — an
            // orphaned S3 object is a cleanup nuisance, not a reason to abandon the
            // DynamoDB revert already in progress for this club.
            console.warn(`  ⚠ failed to delete S3 object ${key}:`, err);
          }
        }
      }
    }
  }
  console.log(
    args.confirm
      ? `Reverted: ${deletedClubs} club(s) deleted, ${strippedClubs} club(s) stripped of import ` +
          `docs (${deletedObjects} S3 object(s) deleted).`
      : 'Re-run with --confirm to apply.',
  );
}

// ───────────────────────── Main ─────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.revert) {
    const repo = await import('./repo.js');
    await runRevert(repo, args);
    return;
  }

  const parsed = await runParsePhase(args);
  if (!parsed) return;
  if (args.parseOnly) {
    console.log(
      '\n[parse-only] Parsing clean — nothing touched DynamoDB/S3. Re-run without --parse-only to check the tenant catalogue and (with --confirm) write.',
    );
    return;
  }

  const repo = await import('./repo.js');
  // Post-dedupe worst case per multi-file key: the catalogue's maxFiles has to clear the
  // busiest club, and dedupe (content hash) is what decides the real count — Irene
  // Villagers' 7 MOU files are only 4 distinct documents.
  const neededPerMultiKey = await maxFilesNeededPerMultiKey(parsed.classified);
  const activeDocs = await assertCatalogueCoverage(repo, neededPerMultiKey);
  console.log(`\n✓ Tenant catalogue covers all ${TITANS_DOC_KEYS.length} required doc keys.`);

  if (args.withTeams) {
    const referencedKeys = new Set<string>();
    for (const summary of parsed.summary.values())
      for (const key of summary.leagueTeamCounts.keys()) referencedKeys.add(key);
    await ensureLeaguesConfigured(repo, args, referencedKeys);
  }

  // Scoped exactly like runConfirm's targets — the dry-run must preview what --confirm
  // will touch, never the full CLUB_MAP on a partial pack.
  const targets = args.club ? parsed.inScope.filter((c) => c.id === args.club) : parsed.inScope;
  if (targets.length === 0) throw new Error('no in-scope club to write (check --dir/--club)');

  if (args.teamsFromEntry) {
    // Every tenant league key a form REQUESTS sides in must already be configured — a
    // genuinely new competition is never minted by an import (EXTRA_LEAGUES aside, which
    // still needs --add-missing-leagues). Null-mapped and women's-aggregate rows are
    // never written, so they reference nothing.
    const referencedKeys = new Set<string>();
    for (const club of targets) {
      for (const r of parsed.entryForms.get(club.id) ?? []) {
        const key = leagueKeyForEntryLabel(r.label);
        if (key && key !== WOMENS_AGGREGATE && r.count > 0) referencedKeys.add(key);
      }
    }
    await ensureLeaguesConfigured(repo, args, referencedKeys);
  }

  if (!args.confirm) {
    const existing = await repo.listClubs(TENANT);
    const existingById = new Map(existing.map((c) => [c.id, c]));
    console.log('\n── Dry-run diff');
    for (const club of targets) {
      const action = existingById.has(club.id) ? 'MERGE (fill absent fields only)' : 'CREATE';
      console.log(`  ${club.name} (${club.id}): ${action}`);
    }
    if (args.teamsFromEntry) {
      console.log(
        '\n── Entry-form team diff (only UPDATE rows are written on --confirm; ' +
          '"manual" rows are union follow-ups, never written)',
      );
      for (const club of targets) {
        const rows = parsed.entryForms.get(club.id);
        if (!rows) continue;
        const current = existingById.get(club.id);
        const stored = storedPlanOf(current);
        const diff = diffEntryForm(rows, stored);
        printEntryDiff(
          `${club.name}${current ? '' : ' (CREATE — the form becomes the initial plan)'}`,
          diff,
          true,
        );
        if (diff.some((d) => d.action === 'UPDATE')) {
          const { droppedTeamIds, addedTeamIds } = applyEntryFormDiff(club, stored, diff);
          if (droppedTeamIds.length)
            console.log(`    would drop team id(s): ${droppedTeamIds.join(', ')}`);
          if (addedTeamIds.length)
            console.log(`    would add team id(s): ${addedTeamIds.join(', ')}`);
        }
      }
    }
    if (args.skipDocs) {
      console.log('\n· --skip-docs: doc upload phase skipped.');
    } else {
      // Read-only preview of the doc-upload phase — same code path --confirm runs,
      // gated internally on args.confirm so nothing is ever written to S3/DynamoDB here.
      await runDocUploadPhase(repo, args, parsed.classified, activeDocs);
    }
    console.log(
      `\nRe-run with --confirm to write. ${args.skipDocs ? '(--skip-docs: no S3/doc writes)' : ''}${args.withTeams ? ' (--with-teams: leagues/teamRosters included)' : ''}${args.teamsFromEntry ? ' (--teams-from-entry: UPDATE rows above included)' : ''}`,
    );
    return;
  }

  await runConfirm(
    repo,
    args,
    parsed.classified,
    parsed.summary,
    activeDocs,
    parsed.inScope,
    parsed.entryForms,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export {
  classifyAll,
  walkDocs,
  buildClub,
  buildTeamPlan,
  isPristine,
  isImportObjectKey,
  contentAddressedKey,
  normalizeDocMeta,
  unionDocFiles,
  buildDocMetaValue,
  validateDocMimes,
  catalogueCoverageProblems,
  readCreatedClubsManifest,
  writeCreatedClubsManifest,
  createdClubsManifestPath,
  resolveManifestStage,
  LEGACY_CREATED_CLUBS_MANIFEST_PATH,
  parseArgs,
  entryFormProblems,
  diffEntryForm,
  applyEntryFormDiff,
  EMPTY_STORED_PLAN,
};
