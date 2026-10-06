/**
 * Lions (Central Gauteng Lions / CGL) one-time import — compliance documents from the
 * cleaned CGL compliance pack (Phase 0: Downloads/Lions/prepared/compliance/).
 *
 *   npx tsx src/import-lions-compliance.ts --parse-only [--dir "<pack>"]
 *   npx sst shell --stage <stage> -- npm --prefix packages/api run import-lions-compliance -- \
 *     [--dir "<pack>"]                                                                 # dry-run
 *   … --confirm                                                                        # write
 *   … --confirm --skip-docs                                                            # clubs only, no S3/doc writes
 *   … --revert [--all [--erase-preexisting]] [--confirm]
 *
 * Copy-and-trim of import-tuskers-compliance.ts (the planb→titans→tuskers lineage — the
 * shared core is deliberately NOT refactored out). Differences from tuskers:
 * - Clubs normally PRE-EXIST: the Phase 2 affiliation import creates the whole lions club
 *   universe, so this import usually only MERGES (fills absent doc-key seeds) and attaches
 *   docs. If affiliation hasn't run, a doc club is created (with its CLUB_MAP district
 *   resolved against the tenant config) and recorded in this import's own created-clubs
 *   manifest. No chair is written — officer data is the affiliation/contacts imports' job.
 * - Only DOC_CLUBS (CLUB_MAP clubs with a pack folder, minus Orange Farm) are touched.
 * - Per-club district (four CGL districts) via resolveLionsDistricts — never hardcoded.
 * - No `--map-club` (lions clubs all derive their ids from the same CLUB_MAP).
 * - `--dir` defaults to the prepared pack path.
 * Everything else is kept in behaviour: fail-closed parse, content-hash dedupe,
 * FILE_OVERRIDES (incl. `{ club, docKey }` reassignment), catalogue coverage + MIME
 * validation, merge-never-clobber doc uploads, a single audit note, content-addressed S3
 * keys, the write-before-create created-clubs manifest, and revert (incl.
 * revertManifestGate).
 *
 * Fail-closed by design: an unclassified compliance file, a folder not in CLUB_MAP, a doc
 * club with zero classified docs, or a tenant catalogue that doesn't cover every doc key
 * all abort the run with a printed report — a confidently wrong import on prod is worse
 * than an incomplete one.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Club, RequiredDoc } from './types.js';
import {
  resolveRequiredDocs,
  resolveDistricts,
  activeRequiredDocs,
  DOC_FORMAT_MIME,
  acceptedMimes,
  multiFileLimits,
  normalizeDocMeta,
  docMetaValue,
  unavailableDeclared,
  type DocFileEntry,
  type NormalizedDocMeta,
} from './catalogue.js';
import {
  CLUB_MAP,
  DOC_CLUBS,
  ROOT_UNIQUE_FOLDER,
  type ClubMapEntry,
  type LionsDistrict,
  classifyFile,
  LIONS_DOC_KEYS,
  MULTI_FILE_DOC_KEYS,
  resolveLionsDistricts,
} from './lions-import-map.js';
import { deriveTeamPlanCounts } from './team-plan.js';

type RepoModule = typeof import('./repo.js');

const TENANT = 'lions';
/** The cleaned Phase 0 pack (read-only). Overridable with --dir. */
const DEFAULT_DIR = '/Users/carlton/Downloads/Lions/prepared/compliance';
// District: per club, from CLUB_MAP (four CGL districts). The NAMES are resolved at run
// time from the tenant config (resolveLionsDistricts), never hardcoded — club.district must
// equal a configured name exactly. Applied only to clubs this import CREATES.
/** Audit marker: updateClub actor + note author. */
const IMPORT_MARKER = 'import:lions-compliance-2026';
const AUDIT_NOTE = `Imported from the CGL (Lions) compliance pack (${IMPORT_MARKER})`;
/** Content-addressed S3 keys carry this marker so a re-run is idempotent and revert can
 * tell an import-authored doc from an admin's real upload. */
const IMPORT_KEY_MARKER = '-import-';

/**
 * True iff `objectKey` is one THIS import wrote for exactly this club+docKey —
 * anchored to the `${TENANT}/${clubId}/${docKey}-import-…` prefix `contentAddressedKey`
 * actually produces, never a bare `.includes(IMPORT_KEY_MARKER)` substring test (a docKey
 * ending `-import` would otherwise make a rep's genuine upload falsely match). Two
 * destructive paths depend on this: `isPristine` and the revert-strip S3 delete.
 */
function isImportObjectKey(objectKey: string, clubId: string, docKey: string): boolean {
  return objectKey.startsWith(`${TENANT}/${clubId}/${docKey}${IMPORT_KEY_MARKER}`);
}
const CLUB_COLORS = ['#0E3529', '#215F47', '#4B8A6C', '#B89B4A', '#E7DDC6', '#8C5A3B'];

/**
 * Stable (non-timestamped) manifest of every club id this import has ever CREATED (never
 * merely merged into) across every `--confirm` run — the positive signal `--revert --all`
 * uses to distinguish "safe to erase outright" from "pre-existed the import, only
 * merged". Same reasoning as the Titans import (see CREATED_CLUBS_MANIFEST_PATH in
 * import-titans-compliance.ts): `onboardedVia`, the audit note and `club.version` can't
 * discriminate; recording creation at the moment it happens can't drift.
 *
 * Persisted INCREMENTALLY (write-before-create, one id at a time — see runConfirm), so an
 * interrupted run never loses the ids it already created.
 */
const LEGACY_CREATED_CLUBS_MANIFEST_PATH = './lions-import-created-clubs.json';

/**
 * Stage-scoped manifest path, so a dev run's evidence can never steer a prod revert (or
 * vice versa): `./lions-import-created-clubs.<stage>.json`. The stage comes from
 * `SST_STAGE` when set, else from `SST_RESOURCE_App` — the JSON `{"name","stage"}` that
 * `sst shell` injects for every run (verified in the sst v3.19 binary; it is what the sst
 * SDK's `Resource.App.stage` reads, and the same SST_RESOURCE_* mechanism env.ts already
 * relies on for the table and bucket). Outside `sst shell` (neither set) it falls back to
 * the legacy unsuffixed name. Pure over `env` for testing.
 */
function createdClubsManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  let stage = env.SST_STAGE?.trim();
  if (!stage && env.SST_RESOURCE_App) {
    try {
      const app = JSON.parse(env.SST_RESOURCE_App) as { stage?: unknown };
      if (typeof app.stage === 'string') stage = app.stage.trim();
    } catch {
      throw new Error('SST_RESOURCE_App is set but is not valid JSON — cannot resolve the stage');
    }
  }
  if (!stage) return LEGACY_CREATED_CLUBS_MANIFEST_PATH;
  if (!/^[A-Za-z0-9_-]+$/.test(stage)) throw new Error(`unsafe stage name "${stage}"`);
  return `./lions-import-created-clubs.${stage}.json`;
}

/**
 * Three-way read result — "absent" and "corrupt" are NOT interchangeable. Revert may
 * treat both as "no positive evidence"; confirm must abort on "corrupt" rather than
 * clobber every id a prior run recorded.
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
      // Finder metadata, never a pack document.
      if (entry === '.DS_Store') continue;
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
  /** The club the file is imported INTO — its folder's club, unless a FILE_OVERRIDES
   * `{ club, docKey }` reassignment moved it. */
  club: ClubMapEntry | undefined;
  docKey: string | undefined;
  skipReason: string | undefined;
  /** Set only when a reassignment moved this file out of its folder's club. */
  reassignedFrom: ClubMapEntry | undefined;
}

function classifyAll(files: FileEntry[]): {
  classified: ClassifiedFile[];
  unclassified: FileEntry[];
  unmappedFolders: string[];
  /** Reassignment targets that name a club id not in CLUB_MAP — a map-file bug, fails
   * the parse phase closed rather than importing into a club that doesn't exist. */
  badReassignments: string[];
} {
  const clubByFolder = new Map(
    CLUB_MAP.filter((c) => c.folder !== null).map((c) => [c.folder as string, c]),
  );
  const clubById = new Map(CLUB_MAP.map((c) => [c.id, c]));
  const classified: ClassifiedFile[] = [];
  const unclassified: FileEntry[] = [];
  const unmappedFolders = new Set<string>();
  const badReassignments: string[] = [];
  for (const f of files) {
    const folderClub = clubByFolder.get(f.folder);
    // ROOT_UNIQUE_FOLDER has no club of its own — classifyFile only places its files via
    // explicit FILE_OVERRIDES, and a club-less doc result is caught below.
    if (!folderClub && f.folder !== ROOT_UNIQUE_FOLDER) unmappedFolders.add(f.folder);
    // A file directly at the pack root has no folder at all.
    if (!f.rel.includes('/')) unmappedFolders.add(`(pack root) ${f.rel}`);
    const result = classifyFile(f.rel, f.filename);
    if (result.kind === 'unclassified') {
      unclassified.push(f);
      continue;
    }
    let club = folderClub;
    let reassignedFrom: ClubMapEntry | undefined;
    if (result.kind === 'doc' && result.club !== undefined) {
      const target = clubById.get(result.club);
      if (!target) {
        badReassignments.push(`${f.rel} → unknown club id "${result.club}"`);
        continue;
      }
      if (target.id !== folderClub?.id) reassignedFrom = folderClub;
      club = target;
    }
    if (result.kind === 'doc' && !club) {
      badReassignments.push(`${f.rel} → "${result.docKey}" but the file has no club`);
      continue;
    }
    classified.push({
      ...f,
      club,
      docKey: result.kind === 'doc' ? result.docKey : undefined,
      skipReason: result.kind === 'skip' ? result.reason : undefined,
      reassignedFrom,
    });
  }
  return { classified, unclassified, unmappedFolders: [...unmappedFolders], badReassignments };
}

async function sha256File(abs: string): Promise<string> {
  const bytes = await readFile(abs);
  return createHash('sha256').update(bytes).digest('hex');
}

/** Within one club × docKey group, dedupe byte-identical files (MCC's "MCC letter
 * 2024.pdf" / "SLA Doc MCC.pdf", Greytown's two fee-payment PDFs) — first-seen
 * (alphabetical by rel path) wins, the rest are reported and excluded from upload. Never
 * a filename heuristic: content hash is the only thing that decides "same document". */
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

// ───────────────────────── Reporting ─────────────────────────

function printClassificationTable(classified: ClassifiedFile[], unclassified: FileEntry[]) {
  console.log(`\n── File classification (${classified.length + unclassified.length} files)`);
  const byFolder = new Map<string, ClassifiedFile[]>();
  for (const f of classified) {
    if (!byFolder.has(f.folder)) byFolder.set(f.folder, []);
    byFolder.get(f.folder)!.push(f);
  }
  for (const folder of [...byFolder.keys()].sort()) {
    const files = byFolder.get(folder)!.sort((a, b) => a.rel.localeCompare(b.rel));
    console.log(`  [${folder}]`);
    for (const f of files) {
      // Path inside the club folder — some clubs nest (Jeppe, Wanderers, extracted/).
      const inner = f.rel.slice(folder.length + 1);
      if (f.skipReason) {
        console.log(`     ${'SKIP'.padEnd(22)} ${inner}\n        ↳ ${f.skipReason}`);
        continue;
      }
      const label = f.reassignedFrom
        ? `${f.docKey} → REASSIGNED to ${f.club?.id}`
        : f.folder === ROOT_UNIQUE_FOLDER
          ? `${f.docKey} → ${f.club?.id}`
          : (f.docKey ?? '?');
      console.log(`     ${label.padEnd(22)} ${inner}`);
    }
  }
  if (unclassified.length) {
    console.log(`\n  ✗ ${unclassified.length} UNCLASSIFIED file(s):`);
    for (const f of unclassified) console.log(`     ${f.rel}`);
  }
}

function printDocCoverageTable(classified: ClassifiedFile[]) {
  console.log(`\n── Per-club doc-key coverage (raw file counts, pre-dedupe)`);
  for (const club of DOC_CLUBS) {
    const mine = classified.filter((f) => f.club?.id === club.id && f.docKey);
    const byKey = new Map<string, number>();
    for (const f of mine) byKey.set(f.docKey!, (byKey.get(f.docKey!) ?? 0) + 1);
    const summary = [...byKey.entries()].map(([k, n]) => `${k}(${n})`).join(', ') || 'NO DOCS';
    const missing = LIONS_DOC_KEYS.filter((k) => !byKey.has(k));
    console.log(`  ${club.name}: ${summary}`);
    if (missing.length) console.log(`     ↳ no file for: ${missing.join(', ')}`);
  }
}

/**
 * Would-upload preview, computable at Phase P (parse-only) since it only needs local
 * file bytes (via dedupeGroup's content hashing) — no DynamoDB/S3 access. What it can't
 * know without a real tenant (already-stored no-ops, MIME validation against the
 * configured catalogue) is reported by the dry-run phase, which calls the real
 * runDocUploadPhase read-only.
 */
async function printDocUploadPreview(classified: ClassifiedFile[]): Promise<void> {
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
  for (const club of DOC_CLUBS) {
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
    `\n  ${totalRaw} classified doc file(s) → would upload ${totalDistinct} distinct (${totalRaw - totalDistinct} byte-identical duplicate(s) skipped).`,
  );
}

// ───────────────────────── CLI ─────────────────────────

interface Args {
  dir: string;
  parseOnly: boolean;
  confirm: boolean;
  club?: string;
  skipDocs: boolean;
  revert: boolean;
  all: boolean;
  /** Revert only. Separate, explicit opt-in to erase a club this import only MERGED
   * into (i.e. one that pre-existed the import) — see runRevert's comment. `--all`
   * alone never touches a pre-existing club's real data. */
  erasePreexisting: boolean;
}

function parseArgs(argv: string[]): Args {
  let dirGiven = false;
  const args: Args = {
    dir: DEFAULT_DIR,
    parseOnly: false,
    confirm: false,
    skipDocs: false,
    revert: false,
    all: false,
    erasePreexisting: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') {
      args.dir = argv[++i] ?? '';
      dirGiven = true;
    } else if (a === '--parse-only') args.parseOnly = true;
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--club') args.club = argv[++i];
    else if (a === '--skip-docs') args.skipDocs = true;
    else if (a === '--revert') args.revert = true;
    else if (a === '--all') args.all = true;
    else if (a === '--erase-preexisting') args.erasePreexisting = true;
    else throw new Error(`unknown flag ${a}`);
  }
  if (args.erasePreexisting && !(args.revert && args.all)) {
    throw new Error('--erase-preexisting only makes sense with --revert --all');
  }
  // Reject flag combinations that would otherwise be silently ignored — an operator who
  // types `--revert --club x` expects a scoped revert, which does not exist.
  if (args.parseOnly && args.confirm) {
    throw new Error('--parse-only never writes — drop --confirm (or drop --parse-only to write)');
  }
  if (args.revert) {
    if (dirGiven) throw new Error('--revert takes no --dir');
    if (args.club !== undefined) throw new Error('--revert takes no --club');
    return args;
  }
  if (!args.dir) throw new Error('--dir needs a value (the prepared CGL compliance pack folder)');
  if (args.club !== undefined && !DOC_CLUBS.some((c) => c.id === args.club))
    throw new Error(
      `--club "${args.club}" is not a doc club (a CLUB_MAP club with a compliance folder)`,
    );
  return args;
}

// ───────────────────────── Club building ─────────────────────────

function buildClubDocsSeed(activeDocs: RequiredDoc[]): Record<string, boolean> {
  const docs: Record<string, boolean> = {};
  for (const d of activeDocs) docs[d.key] = false;
  return docs;
}

/** Only reached when the affiliation import hasn't created the club: a bare club — no
 * leagues, team plan, ground or officers (the affiliation/fixtures/contacts imports own
 * those, and their fill-absent merges complete it later). */
function buildClub(
  club: ClubMapEntry,
  activeDocs: RequiredDoc[],
  index: number,
  district: string,
): Club {
  const { teams, women, juniors } = deriveTeamPlanCounts({});
  return {
    id: club.id,
    name: club.name,
    district,
    sub: '',
    chair: '',
    affiliation: 'not_started',
    cqi: 0,
    docs: buildClubDocsSeed(activeDocs),
    players: 0,
    teams,
    women,
    juniors,
    color: CLUB_COLORS[index % CLUB_COLORS.length],
    ground: {},
    leagues: [],
    version: 1,
  } as Club;
}

// ───────────────────────── Phase P (parse) ─────────────────────────

async function runParsePhase(args: Args): Promise<{ classified: ClassifiedFile[] } | null> {
  const files = await walkDocs(args.dir);
  const { classified, unclassified, unmappedFolders, badReassignments } = classifyAll(files);
  printClassificationTable(classified, unclassified);
  printDocCoverageTable(classified);
  await printDocUploadPreview(classified);

  const hardFailures = parseHardFailures({
    classified,
    unclassified,
    unmappedFolders,
    badReassignments,
    singleFileClashes: await singleFileClashes(classified),
  });

  if (hardFailures.length) {
    console.error(`\n✗ Refusing to continue:\n${hardFailures.map((f) => `   ${f}`).join('\n')}`);
    process.exitCode = 1;
    return null;
  }

  console.log('\n✓ Parse phase clean.');
  return { classified };
}

/**
 * Single-file doc keys a club would get more than one DISTINCT (post-dedupe) file for. The
 * upload phase would report these as clashes and skip them; at parse time they are a
 * map-file decision still to be made (pick one file, move the rest to clubRecords or skip).
 */
async function singleFileClashes(classified: ClassifiedFile[]): Promise<string[]> {
  const groups = new Map<string, ClassifiedFile[]>();
  for (const f of classified) {
    if (!f.docKey || !f.club || MULTI_FILE_DOC_KEYS.has(f.docKey)) continue;
    const k = `${f.club.id}::${f.docKey}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const out: string[] = [];
  for (const [groupKey, files] of groups) {
    const { keep } = await dedupeGroup(files);
    if (keep.length > 1)
      out.push(`${groupKey.replace('::', '/')}: ${keep.map((f) => f.rel).join(', ')}`);
  }
  return out;
}

/**
 * Pure fail-closed gate behind runParsePhase — every reason the parse phase refuses to
 * continue. Includes a docKey outside LIONS_DOC_KEYS (a FILE_OVERRIDES/DOC_RULES typo):
 * `acceptedMimes(undefined)` falls back to the legacy pdf/doc/docx default, so without
 * this check a typo'd key on a pdf would sail through MIME validation and be written to
 * a doc key the tenant catalogue doesn't have.
 */
function parseHardFailures(input: {
  classified: ClassifiedFile[];
  unclassified: FileEntry[];
  unmappedFolders: string[];
  badReassignments: string[];
  singleFileClashes?: string[];
}): string[] {
  const { classified, unclassified, unmappedFolders, badReassignments } = input;
  const clashes = input.singleFileClashes ?? [];
  const noDocsClubs = DOC_CLUBS.filter(
    (c) => !classified.some((f) => f.club?.id === c.id && f.docKey),
  );
  const unknownDocKeys = classified.filter(
    (f) => f.docKey !== undefined && !LIONS_DOC_KEYS.includes(f.docKey),
  );

  const hardFailures: string[] = [];
  if (clashes.length)
    hardFailures.push(
      `single-file doc key(s) with more than one distinct file: ${clashes.join('; ')}`,
    );
  if (unknownDocKeys.length)
    hardFailures.push(
      `docKey(s) not in LIONS_DOC_KEYS (FILE_OVERRIDES/DOC_RULES typo?): ${unknownDocKeys
        .map((f) => `${f.rel} → "${f.docKey}"`)
        .join('; ')}`,
    );
  if (unclassified.length)
    hardFailures.push(`${unclassified.length} unclassified file(s) — see above`);
  if (unmappedFolders.length)
    hardFailures.push(`folder(s) not in CLUB_MAP: ${unmappedFolders.join(', ')}`);
  if (badReassignments.length)
    hardFailures.push(
      `FILE_OVERRIDES reassignment(s) to unknown/no clubs: ${badReassignments.join('; ')}`,
    );
  if (noDocsClubs.length)
    hardFailures.push(
      `doc club(s) with zero classified docs (folder missing from --dir?): ${noDocsClubs
        .map((c) => `${c.name} [${c.folder}]`)
        .join(', ')}`,
    );
  return hardFailures;
}

// ───────────────────────── Phase 1/2 (dry-run / confirm) ─────────────────────────

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
 * Pure problem-list builder behind `assertCatalogueCoverage` — split out so the
 * (deliberately two-directional) multiFile checks can be unit-tested without a repo/
 * tenant config. Forward: every `MULTI_FILE_DOC_KEYS` entry must BE configured multiFile
 * in the catalogue with a cap that holds the busiest club. Reverse: no OTHER
 * `LIONS_DOC_KEYS` entry may be configured multiFile — `buildDocMetaValue` dispatches
 * purely on `MULTI_FILE_DOC_KEYS`, so a mismatch in either direction writes the wrong
 * docMeta shape, and in the reverse case silently discards a club rep's genuine file.
 * These CLIs write through repo and so bypass the route validation that would otherwise
 * catch a too-small cap.
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
  for (const key of LIONS_DOC_KEYS) {
    if (MULTI_FILE_DOC_KEYS.has(key)) continue;
    const def = active.find((d) => d.key === key);
    if (def?.multiFile) {
      problems.push(
        `"${key}" is configured multiFile in the tenant catalogue, but this import treats it ` +
          'as single-file (only ' +
          `${[...MULTI_FILE_DOC_KEYS].join('/')} are multi-file) — a club with an existing rep ` +
          'file for this key would have that file silently discarded. Either unmark multiFile ' +
          'for this key in the operator portal, or add it to MULTI_FILE_DOC_KEYS in ' +
          'lions-import-map.ts.',
      );
    }
  }
  return problems;
}

async function assertCatalogueCoverage(
  repo: RepoModule,
  neededPerMultiKey: Map<string, number>,
): Promise<RequiredDoc[]> {
  const config = await repo.getTenantConfig(TENANT);
  if (!config)
    throw new Error(
      `tenant "${TENANT}" has no config — create the tenant first (runbook prerequisites).`,
    );
  const active = activeRequiredDocs(config);
  const configuredKeys = new Set(resolveRequiredDocs(config).map((d) => d.key));
  const missing = LIONS_DOC_KEYS.filter((k) => !configuredKeys.has(k));
  if (missing.length) {
    throw new Error(
      `tenant "${TENANT}" requiredDocs catalogue is missing key(s) this import needs: ` +
        `${missing.join(', ')}. Run configure-tenant-docs ${TENANT} --confirm first.`,
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
 * not a hardcoded copy of it: `isImportObjectKey` is the only consumer, and isPristine +
 * the revert-strip S3 delete both depend on the pair agreeing. If they drifted, revert
 * would silently recognise nothing and leave PII (registration forms, nominal rolls with
 * RSA IDs) in a bucket with no lifecycle rule (ADR 0009).
 */
function contentAddressedKey(clubId: string, docKey: string, sha256: string, ext: string): string {
  return `${TENANT}/${clubId}/${docKey}${IMPORT_KEY_MARKER}${sha256.slice(0, 16)}.${ext}`;
}

async function runConfirm(
  repo: RepoModule,
  args: Args,
  classified: ClassifiedFile[],
  activeDocs: RequiredDoc[],
  districtNames: Record<LionsDistrict, string>,
): Promise<void> {
  const existing = await repo.listClubs(TENANT);
  const existingById = new Map(existing.map((c) => [c.id, c]));
  const docClubsExisting = existing.filter((c) => DOC_CLUBS.some((m) => m.id === c.id));

  const backupPath = `./lions-import-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(backupPath, JSON.stringify(docClubsExisting, null, 2));
  console.log(
    `Backup written: ${backupPath} (${docClubsExisting.length} existing lions doc club(s))`,
  );

  const targets = args.club ? DOC_CLUBS.filter((c) => c.id === args.club) : DOC_CLUBS;
  if (args.club && targets.length === 0) throw new Error(`--club "${args.club}" not a doc club`);

  // A present-but-unparseable manifest must never be silently overwritten with only this
  // run's ids — only "absent" is safe to start from empty; "corrupt" aborts loudly.
  const manifestResult = await readCreatedClubsManifest();
  if (manifestResult.kind === 'corrupt') {
    throw new Error(
      `${createdClubsManifestPath()} exists but is unreadable/malformed (${manifestResult.detail}) ` +
        '— refusing to continue: writing through it now would silently discard every club id a ' +
        'prior run recorded. Fix the file by hand or move it aside before re-running --confirm.',
    );
  }
  const manifest = manifestResult.kind === 'ok' ? manifestResult.ids : new Set<string>();

  console.log(`· created-clubs manifest: ${createdClubsManifestPath()}`);

  let created = 0;
  let merged = 0;
  for (const [i, club] of targets.entries()) {
    const built = buildClub(club, activeDocs, i, districtNames[club.district]);
    const already = existingById.get(club.id);
    if (!already) {
      // Write-before-create: the id is durable BEFORE `createClub` is attempted, so a
      // crash mid-create can never leave an unrecorded creation (a false negative that
      // `--revert --all` would mistake for a pre-existing club). A definitive failure
      // afterwards leaves only an inert false positive — revert only visits clubs that
      // actually exist on the tenant.
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
      // admin, club rep or the affiliation import has already written. The only field this
      // import contributes to an existing club is missing doc-key seeds.
      const patch: Partial<Club> = {};
      const missingDocs = Object.keys(built.docs).filter((k) => current.docs?.[k] === undefined);
      if (missingDocs.length) {
        patch.docs = { ...current.docs, ...Object.fromEntries(missingDocs.map((k) => [k, false])) };
      }
      if (Object.keys(patch).length) {
        await repo.updateClub(TENANT, club.id, patch, IMPORT_MARKER, new Date().toISOString());
        merged++;
      }
      // Guard against duplicate notes on re-runs (the runbook encourages re-running
      // --confirm after a partial revert).
      const noteAlreadyPresent = (current.notes ?? []).some((n) => n.text === AUDIT_NOTE);
      if (!noteAlreadyPresent) {
        await repo.appendClubNote(TENANT, club.id, {
          id: `note_${Date.now()}_${club.id}`,
          text: AUDIT_NOTE,
          author: IMPORT_MARKER,
          at: new Date().toISOString(),
        });
      }
    }
  }
  console.log(`· clubs: ${created} created, ${merged} merged`);
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
 * docMeta normalization is IMPORTED from catalogue.ts, never replicated: this script
 * writes docMeta through `repo`, bypassing the routes, so it must agree with them exactly
 * on every historical stored shape.
 */

function unionDocFiles(stored: DocFileEntry[], incoming: DocFileEntry[]): DocFileEntry[] {
  const byKey = new Map(stored.map((f) => [f.objectKey, f]));
  for (const f of incoming) byKey.set(f.objectKey, f);
  return [...byKey.values()];
}

/** Re-wrap normalized state as the stored docMeta value for one key — single- and
 * multi-file alike carry `markedCompliant`/`at`/`courseBooked`/`courseDate` forward when
 * present. The multi-file shape comes straight from the shared `docMetaValue` the routes
 * use; only the single-file shape is assembled here (the routes build that one inline). */
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
  // Single-file: exactly one entry (dedupeGroup + the clash check enforce this), still
  // carrying markedCompliant/at forward if an admin had set them.
  // A club's unavailable declaration is deliberately NOT carried here: a real file
  // supersedes a single-file declaration (the portal and record route treat it so).
  const only = files[files.length - 1];
  return norm.markedCompliant ? { ...only, markedCompliant: true, at: norm.at } : only;
}

/**
 * Fail-closed validation of every target file's resolved MIME type against its doc
 * definition's `accepts` — the same check the HTTP presign route applies (`acceptedMimes`
 * in catalogue.ts), which this CLI would otherwise bypass entirely. Runs before ANY S3
 * write, and in dry-run too.
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

  // Fail-closed MIME validation runs first, before any dedupe/hash/S3 work.
  validateDocMimes(targets, activeDocs);

  // Only mint an S3 client (and require UPLOADS_BUCKET) when actually writing — the
  // dry-run path calls this same function purely to REPORT what would happen.
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

    // The club may not exist yet in dry-run (created only by --confirm) — never a reason
    // to hide what would upload; only a genuine anomaly once --confirm has already run
    // the club create/merge phase.
    const club = await repo.getClub(TENANT, clubId);
    if (!club) {
      if (args.confirm) {
        console.log(`  skip: club "${clubId}" not found (create it first)`);
        continue;
      }
    }
    const norm = normalizeDocMeta(club?.docMeta?.[docKey]);

    // Never clobber a NON-import file already present for a single-file doc. Checks EVERY
    // entry, not just files[0] — a key flipped from multiFile back to single-file can hold
    // [import, repUpload].
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
      // Single-file re-run with changed bytes: every earlier entry is a SUPERSEDED object
      // nothing will reference once this write lands — a permanent PII orphan (no
      // lifecycle rule, ADR 0009) unless deleted here.
      const supersededKeys =
        !MULTI_FILE_DOC_KEYS.has(docKey) && merged.length > 1
          ? merged.slice(0, -1).map((f) => f.objectKey)
          : [];
      await repo.updateClub(
        TENANT,
        clubId,
        { docs, docMeta },
        IMPORT_MARKER,
        new Date().toISOString(),
      );
      // Deleted only AFTER the updateClub write lands — deleting first and then failing
      // the write would strand a live docMeta pointer at a missing object.
      for (const key of supersededKeys) {
        try {
          await s3!.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
          console.log(
            `  cleanup: deleted superseded S3 object ${key} (single-file doc "${docKey}" replaced by a re-run)`,
          );
        } catch (err) {
          // Best-effort — an orphaned S3 object is a cleanup nuisance, not a reason to
          // abandon a DynamoDB write already landed.
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
 * Decide what `--revert` does when the created-clubs manifest isn't usable. Pure, so both
 * destructive branches can be unit-tested without a repo or a manifest on disk.
 *
 * `refuse` for `--all --erase-preexisting`: without positive evidence this run cannot tell
 * an import-created club from a pre-existing one, so every non-pristine doc club would be
 * treated as "pre-existing, force it" and fully deleted. Refusing beats guessing.
 * `warn` for a bare `--all`: the fallback to strip-only really is safe there.
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
        `which ${why}. Without it, every non-pristine doc club would be treated as ` +
        '"pre-existing, force it" and fully deleted — refusing rather than guessing. Restore ' +
        'or fix the manifest, or omit --erase-preexisting to strip import docs only.',
    };
  }
  return {
    kind: 'warn',
    message:
      `⚠ --all requested but ${createdClubsManifestPath()} ${why} — this import cannot ` +
      'positively tell an import-created club apart from a pre-existing one it only merged ' +
      'into, so --all is falling back to strip-only (no club is deleted).',
  };
}

/**
 * Pure revert decision for one doc club. Unlike tuskers (whose import created every club),
 * lions clubs are normally created by the AFFILIATION import, and a freshly affiliated club
 * looks "pristine" (not_started, no rep docs, no players) — so pristine alone NEVER deletes
 * here. A club is deleted only when this import's own manifest says it CREATED it (and it is
 * pristine, or `--all` forces it), or `--all --erase-preexisting` explicitly forces it.
 * Everything else has only its import-marked docs stripped.
 */
export function revertAction(input: {
  pristine: boolean;
  createdByImport: boolean;
  all: boolean;
  erasePreexisting: boolean;
}): 'delete-created' | 'delete-forced' | 'strip' {
  const { pristine, createdByImport, all, erasePreexisting } = input;
  if (createdByImport && (pristine || all)) return 'delete-created';
  if (!createdByImport && all && erasePreexisting) return 'delete-forced';
  return 'strip';
}

/**
 * The revert-strip for one club: remove every import-authored file, never a rep's upload.
 * A key holding only import files (single `objectKey` or a `files` array) is deleted and its
 * `docs` flag cleared. A `files` array MIXING import and rep-uploaded entries keeps the key
 * with just the rep's files, its markedCompliant/course/unavailable state carried through
 * `docMetaValue`, and its `docs` flag recomputed exactly as the write path computes it.
 * Returns the S3 keys of the removed import files for the caller to delete AFTER the
 * record write lands. PURE.
 */
function stripImportDocs(
  club: Pick<Club, 'id' | 'docs' | 'docMeta'>,
  defByKey: Map<string, RequiredDoc>,
): {
  docs: Record<string, boolean>;
  docMeta: Record<string, unknown>;
  stripped: number;
  objectKeysToDelete: string[];
} {
  const docMeta: Record<string, unknown> = { ...(club.docMeta ?? {}) };
  const docs: Record<string, boolean> = { ...club.docs };
  let stripped = 0;
  const objectKeysToDelete: string[] = [];
  for (const [key, value] of Object.entries(docMeta)) {
    const m = value as { objectKey?: string; files?: DocFileEntry[] } | null;
    if (m?.objectKey && !Array.isArray(m.files)) {
      if (!isImportObjectKey(m.objectKey, club.id, key)) continue;
      objectKeysToDelete.push(m.objectKey);
      delete docMeta[key];
      docs[key] = false;
      stripped++;
      continue;
    }
    if (!m?.files?.length) continue;
    const imported = m.files.filter((f) => isImportObjectKey(f.objectKey, club.id, key));
    if (!imported.length) continue;
    for (const f of imported) objectKeysToDelete.push(f.objectKey);
    stripped++;
    const remaining = m.files.filter((f) => !isImportObjectKey(f.objectKey, club.id, key));
    if (!remaining.length) {
      delete docMeta[key];
      docs[key] = false;
      continue;
    }
    const norm = normalizeDocMeta(m);
    const def = defByKey.get(key);
    docMeta[key] = docMetaValue(remaining, norm.markedCompliant, norm.at, norm);
    docs[key] =
      norm.markedCompliant ||
      norm.courseBooked ||
      unavailableDeclared(norm, def) ||
      remaining.length >= multiFileLimits(def).min;
  }
  return { docs, docMeta, stripped, objectKeysToDelete };
}

async function runRevert(repo: RepoModule, args: Args): Promise<void> {
  const clubs = await repo.listClubs(TENANT);
  console.log(`· created-clubs manifest: ${createdClubsManifestPath()}`);
  const mine = clubs.filter((c) => DOC_CLUBS.some((m) => m.id === c.id));
  if (mine.length === 0) {
    console.log('Nothing to revert.');
    return;
  }

  // `mine` is mostly clubs this import only MERGED into (affiliation created them). The
  // manifest is read on every revert — it is the only evidence that allows a delete.
  const manifestResult = await readCreatedClubsManifest();
  if (!args.all && manifestResult.kind === 'corrupt')
    console.log(
      `⚠ ${createdClubsManifestPath()} is unreadable (${manifestResult.detail}) — no club will be deleted; import docs are stripped only.`,
    );
  const gate = revertManifestGate(args, manifestResult);
  if (gate.kind === 'refuse') throw new Error(gate.message);
  if (gate.kind === 'warn') console.log(gate.message);
  const createdManifest = manifestResult.kind === 'ok' ? manifestResult.ids : null;

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

  // The catalogue decides whether a partly-stripped multi-file key still satisfies its doc.
  const defByKey = new Map(
    activeRequiredDocs(await repo.getTenantConfig(TENANT)).map((d) => [d.key, d]),
  );

  let deletedClubs = 0;
  let strippedClubs = 0;
  let deletedObjects = 0;
  for (const club of mine) {
    const playerCount = (await repo.listPlayers(TENANT, club.id)).length;
    const pristine = playerCount === 0 && isPristine(club);
    const createdByImport = createdManifest?.has(club.id) ?? false;
    const action = revertAction({
      pristine,
      createdByImport,
      all: args.all,
      erasePreexisting: args.erasePreexisting,
    });

    if (action !== 'strip') {
      const reason =
        action === 'delete-forced'
          ? ' — PRE-EXISTING club, --erase-preexisting forced'
          : pristine
            ? ' — import-created, pristine'
            : ' — NOT pristine, import-created, --all forced';
      console.log(
        `${args.confirm ? 'delete' : '[dry-run] would delete'}  ${club.id}  (${club.name}${reason})`,
      );
      if (args.confirm) {
        await repo.eraseClubData(TENANT, club);
        deletedClubs++;
      }
      continue;
    }

    // Not eligible for full delete: strip only import-authored doc files, and delete the S3
    // objects they reference (no lifecycle rule would ever clean them up).
    const { docs, docMeta, stripped, objectKeysToDelete } = stripImportDocs(club, defByKey);
    if (stripped > 0) {
      console.log(
        `${args.confirm ? 'strip' : '[dry-run] would strip'}  ${club.id}  (${club.name}) — ` +
          `${stripped} doc key(s) with import files, ${objectKeysToDelete.length} S3 object(s)`,
      );
      if (args.confirm) {
        // Record FIRST, delete after — deleting first and then failing the write would
        // leave docMeta pointing at keys that no longer exist.
        await repo.updateClub(
          TENANT,
          club.id,
          { docs, docMeta },
          IMPORT_MARKER,
          new Date().toISOString(),
        );
        strippedClubs++;
        for (const key of objectKeysToDelete) {
          try {
            await s3!.send(new DeleteObjectCommand!({ Bucket: bucket, Key: key }));
            deletedObjects++;
          } catch (err) {
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
  const neededPerMultiKey = await maxFilesNeededPerMultiKey(parsed.classified);
  const activeDocs = await assertCatalogueCoverage(repo, neededPerMultiKey);
  console.log(`\n✓ Tenant catalogue covers all ${LIONS_DOC_KEYS.length} required doc keys.`);

  const targets = args.club ? DOC_CLUBS.filter((c) => c.id === args.club) : DOC_CLUBS;

  // Districts are resolved against the LIVE tenant in dry-run and confirm alike
  // (parse-only never needs them), fail-closed.
  const config = await repo.getTenantConfig(TENANT);
  const districtResult = resolveLionsDistricts(resolveDistricts(config));
  if (districtResult.kind === 'error')
    throw new Error(`tenant "${TENANT}" districts: ${districtResult.message}`);
  const districtNames = districtResult.byDistrict;
  console.log(
    `✓ Districts for created clubs: ${Object.entries(districtNames)
      .map(([d, n]) => `${d} → "${n}"`)
      .join(', ')}`,
  );
  const existingIds = new Set((await repo.listClubs(TENANT)).map((c) => c.id));

  if (!args.confirm) {
    console.log('\n── Dry-run diff');
    const toCreate = targets.filter((c) => !existingIds.has(c.id));
    if (toCreate.length)
      console.log(
        `  ⚠ ${toCreate.length} doc club(s) don't exist yet — has the affiliation import run on this stage?`,
      );
    for (const club of targets) {
      const action = existingIds.has(club.id)
        ? 'MERGE (fill absent doc-key seeds only)'
        : `CREATE in "${districtNames[club.district]}"`;
      console.log(`  ${club.name} (${club.id}): ${action}`);
    }
    console.log(`  created-clubs manifest: ${createdClubsManifestPath()}`);
    if (args.skipDocs) {
      console.log('\n· --skip-docs: doc upload phase skipped.');
    } else {
      // Read-only preview — same code path --confirm runs, gated internally on
      // args.confirm so nothing is ever written to S3/DynamoDB here.
      await runDocUploadPhase(repo, args, parsed.classified, activeDocs);
    }
    console.log(
      `\nRe-run with --confirm to write. ${args.skipDocs ? '(--skip-docs: no S3/doc writes)' : ''}`,
    );
    return;
  }

  await runConfirm(repo, args, parsed.classified, activeDocs, districtNames);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export {
  parseArgs,
  parseHardFailures,
  singleFileClashes,
  classifyAll,
  walkDocs,
  buildClub,
  isPristine,
  isImportObjectKey,
  stripImportDocs,
  contentAddressedKey,
  normalizeDocMeta,
  unionDocFiles,
  buildDocMetaValue,
  validateDocMimes,
  catalogueCoverageProblems,
  maxFilesNeededPerMultiKey,
  readCreatedClubsManifest,
  writeCreatedClubsManifest,
  createdClubsManifestPath,
  LEGACY_CREATED_CLUBS_MANIFEST_PATH,
  TENANT,
};
export type { ClassifiedFile, FileEntry };
