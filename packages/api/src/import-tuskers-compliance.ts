/**
 * Tuskers (KwaZulu-Natal Inland Cricket Union) one-time import — clubs and compliance
 * documents, from the union's extracted compliance pack.
 *
 *   npx tsx src/import-tuskers-compliance.ts --dir "<pack>" --parse-only
 *   npx sst shell --stage <stage> -- npm --prefix packages/api run import-tuskers-compliance -- \
 *     --dir "<pack>"                                                                   # dry-run
 *   … --confirm                                                                        # write
 *   … --confirm --skip-docs                                                            # clubs only, no S3/doc writes
 *   … --revert [--all [--erase-preexisting]] [--confirm]
 *
 * See docs/runbooks/tuskers-compliance-import.md.
 *
 * Copy-and-trim of import-titans-compliance.ts (the planb→titans lineage precedent — the
 * shared core is deliberately NOT refactored out as part of this import). The pack ships
 * no league-structure workbook, so there is no `--structure`/`--with-teams`/
 * `--add-missing-leagues` phase at all: clubs are created with no leagues, no team plan
 * and no ground. Everything else is kept verbatim in behaviour: fail-closed parse,
 * content-hash dedupe, FILE_OVERRIDES (extended with a `{ club, docKey }` reassignment),
 * catalogue coverage + MIME validation, merge-never-clobber doc uploads, a single audit
 * note, content-addressed S3 keys, the write-before-create created-clubs manifest, and
 * revert (incl. revertManifestGate).
 *
 * Fail-closed by design: an unclassified compliance file, a folder not in CLUB_MAP, a
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
  type ClubMapEntry,
  classifyFile,
  TUSKERS_DOC_KEYS,
  MULTI_FILE_DOC_KEYS,
  parseMapClubArgs,
  effectiveClubId,
  mapTargetsMissing,
  clubWriteDecision,
  resolveTuskersDistrict,
} from './tuskers-import-map.js';
import { deriveTeamPlanCounts } from './team-plan.js';

type RepoModule = typeof import('./repo.js');

const TENANT = 'tuskers';
// District: every club's KZNICU District Teams form says Umgungundlovu (Greytown's has one
// stray "Uthukela" line — see the runbook). The NAME is resolved at run time from the
// tenant config (resolveTuskersDistrict), never hardcoded: dev calls it "uMgungundlovu
// Cricket District", prod "uMgungundlovu District", and club.district must equal the
// configured name exactly. It is applied only to clubs this import CREATES.
/** Audit marker: updateClub actor + note author. */
const IMPORT_MARKER = 'import:tuskers-compliance-2026';
const AUDIT_NOTE = `Imported from Tuskers (KZN Inland) compliance pack (${IMPORT_MARKER})`;
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
const LEGACY_CREATED_CLUBS_MANIFEST_PATH = './tuskers-import-created-clubs.json';

/**
 * Stage-scoped manifest path, so a dev run's evidence can never steer a prod revert (or
 * vice versa): `./tuskers-import-created-clubs.<stage>.json`. The stage comes from
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
  return `./tuskers-import-created-clubs.${stage}.json`;
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
  const clubByFolder = new Map(CLUB_MAP.map((c) => [c.folder, c]));
  const clubById = new Map(CLUB_MAP.map((c) => [c.id, c]));
  const classified: ClassifiedFile[] = [];
  const unclassified: FileEntry[] = [];
  const unmappedFolders = new Set<string>();
  const badReassignments: string[] = [];
  for (const f of files) {
    const folderClub = clubByFolder.get(f.folder);
    if (!folderClub) unmappedFolders.add(f.folder);
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
    const files = byFolder.get(folder)!.sort((a, b) => a.filename.localeCompare(b.filename));
    console.log(`  [${folder}]`);
    for (const f of files) {
      const label = f.skipReason
        ? 'SKIP'
        : f.reassignedFrom
          ? `${f.docKey} → REASSIGNED to ${f.club?.id}`
          : (f.docKey ?? '?');
      console.log(`     ${label.padEnd(22)} ${f.filename}`);
    }
  }
  if (unclassified.length) {
    console.log(`\n  ✗ ${unclassified.length} UNCLASSIFIED file(s):`);
    for (const f of unclassified) console.log(`     ${f.rel}`);
  }
}

function printDocCoverageTable(classified: ClassifiedFile[]) {
  console.log(`\n── Per-club doc-key coverage (raw file counts, pre-dedupe)`);
  for (const club of CLUB_MAP) {
    const mine = classified.filter((f) => f.club?.id === club.id && f.docKey);
    const byKey = new Map<string, number>();
    for (const f of mine) byKey.set(f.docKey!, (byKey.get(f.docKey!) ?? 0) + 1);
    const summary = [...byKey.entries()].map(([k, n]) => `${k}(${n})`).join(', ') || 'NO DOCS';
    const missing = TUSKERS_DOC_KEYS.filter((k) => !byKey.has(k));
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
  for (const club of CLUB_MAP) {
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
  /** `--map-club <clubMapId>=<existingId>` (repeatable): CLUB_MAP club → pre-existing
   * tenant club id, for every write/read keyed on club id. Validated by parseMapClubArgs;
   * the targets' existence is checked against the tenant in every repo-touching phase. */
  mapping: Map<string, string>;
}

function parseArgs(argv: string[]): Args {
  const mapClub: string[] = [];
  const args: Args = {
    dir: '',
    parseOnly: false,
    confirm: false,
    skipDocs: false,
    revert: false,
    all: false,
    erasePreexisting: false,
    mapping: new Map(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i] ?? '';
    else if (a === '--parse-only') args.parseOnly = true;
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--club') args.club = argv[++i];
    else if (a === '--skip-docs') args.skipDocs = true;
    else if (a === '--revert') args.revert = true;
    else if (a === '--all') args.all = true;
    else if (a === '--erase-preexisting') args.erasePreexisting = true;
    else if (a === '--map-club') mapClub.push(argv[++i] ?? '');
    else throw new Error(`unknown flag ${a}`);
  }
  args.mapping = parseMapClubArgs(mapClub);
  if (args.erasePreexisting && !(args.revert && args.all)) {
    throw new Error('--erase-preexisting only makes sense with --revert --all');
  }
  // Reject flag combinations that would otherwise be silently ignored — an operator who
  // types `--revert --club x` expects a scoped revert, which does not exist.
  if (args.parseOnly && args.confirm) {
    throw new Error('--parse-only never writes — drop --confirm (or drop --parse-only to write)');
  }
  if (args.revert) {
    if (args.dir) throw new Error('--revert takes no --dir');
    if (args.club !== undefined) throw new Error('--revert takes no --club');
    return args;
  }
  if (!args.dir) throw new Error('requires --dir "<Tuskers pack folder>" (or --revert)');
  return args;
}

// ───────────────────────── Club building ─────────────────────────

function buildClubDocsSeed(activeDocs: RequiredDoc[]): Record<string, boolean> {
  const docs: Record<string, boolean> = {};
  for (const d of activeDocs) docs[d.key] = false;
  return docs;
}

/** No structure workbook exists for this union: no leagues, no team plan, no ground —
 * those are set up later through the season wizard / admin console. */
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
    // Name only, from the club's own documents (see CLUB_MAP). Lands on CREATE only —
    // the merge path fills absent doc-key seeds and never touches chair.
    chair: club.chair,
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
 * Pure fail-closed gate behind runParsePhase — every reason the parse phase refuses to
 * continue. Includes a docKey outside TUSKERS_DOC_KEYS (a FILE_OVERRIDES/DOC_RULES typo):
 * `acceptedMimes(undefined)` falls back to the legacy pdf/doc/docx default, so without
 * this check a typo'd key on a pdf would sail through MIME validation and be written to
 * a doc key the tenant catalogue doesn't have.
 */
function parseHardFailures(input: {
  classified: ClassifiedFile[];
  unclassified: FileEntry[];
  unmappedFolders: string[];
  badReassignments: string[];
}): string[] {
  const { classified, unclassified, unmappedFolders, badReassignments } = input;
  const noDocsClubs = CLUB_MAP.filter(
    (c) => !classified.some((f) => f.club?.id === c.id && f.docKey),
  );
  const unknownDocKeys = classified.filter(
    (f) => f.docKey !== undefined && !TUSKERS_DOC_KEYS.includes(f.docKey),
  );

  const hardFailures: string[] = [];
  if (unknownDocKeys.length)
    hardFailures.push(
      `docKey(s) not in TUSKERS_DOC_KEYS (FILE_OVERRIDES/DOC_RULES typo?): ${unknownDocKeys
        .map((f) => `${f.rel} → "${f.docKey}"`)
        .join('; ')}`,
    );
  if (unclassified.length)
    hardFailures.push(`${unclassified.length} unclassified file(s) — see above`);
  if (unmappedFolders.length)
    hardFailures.push(`folder(s) not in CLUB_MAP: ${unmappedFolders.join(', ')}`);
  if (badReassignments.length)
    hardFailures.push(
      `FILE_OVERRIDES reassignment(s) to unknown clubs: ${badReassignments.join('; ')}`,
    );
  if (noDocsClubs.length)
    hardFailures.push(
      `club(s) with zero classified docs: ${noDocsClubs.map((c) => c.name).join(', ')}`,
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
 * `TUSKERS_DOC_KEYS` entry may be configured multiFile — `buildDocMetaValue` dispatches
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
  for (const key of TUSKERS_DOC_KEYS) {
    if (MULTI_FILE_DOC_KEYS.has(key)) continue;
    const def = active.find((d) => d.key === key);
    if (def?.multiFile) {
      problems.push(
        `"${key}" is configured multiFile in the tenant catalogue, but this import treats it ` +
          'as single-file (only ' +
          `${[...MULTI_FILE_DOC_KEYS].join('/')} are multi-file) — a club with an existing rep ` +
          'file for this key would have that file silently discarded. Either unmark multiFile ' +
          'for this key in the operator portal, or add it to MULTI_FILE_DOC_KEYS in ' +
          'tuskers-import-map.ts.',
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
  const missing = TUSKERS_DOC_KEYS.filter((k) => !configuredKeys.has(k));
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
  district: string,
): Promise<void> {
  const existing = await repo.listClubs(TENANT);
  const existingById = new Map(existing.map((c) => [c.id, c]));
  const tuskersExisting = existing.filter((c) =>
    CLUB_MAP.some((m) => effectiveClubId(m.id, args.mapping) === c.id),
  );

  const backupPath = `./tuskers-import-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(backupPath, JSON.stringify(tuskersExisting, null, 2));
  console.log(`Backup written: ${backupPath} (${tuskersExisting.length} existing tuskers club(s))`);

  const targets = args.club ? CLUB_MAP.filter((c) => c.id === args.club) : CLUB_MAP;
  if (args.club && targets.length === 0) throw new Error(`--club "${args.club}" not in CLUB_MAP`);

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

  // Every create-vs-merge decision is made (and every mapped target re-checked) BEFORE the
  // first write: a mapped club is never created.
  const existingIds = new Set(existingById.keys());
  const decisions = targets.map((club) => ({
    club,
    decision: clubWriteDecision(club.id, args.mapping, existingIds),
  }));
  const aborts = decisions.flatMap(({ decision }) =>
    decision.action === 'abort' ? [decision.reason] : [],
  );
  if (aborts.length) throw new Error(`refusing to write:\n  - ${aborts.join('\n  - ')}`);
  console.log(`· created-clubs manifest: ${createdClubsManifestPath()}`);

  let created = 0;
  let merged = 0;
  for (const [i, { club: mapEntry, decision }] of decisions.entries()) {
    if (decision.action === 'abort') continue; // unreachable — aborted above
    // A mapped club is written under the EXISTING tenant club's id throughout.
    const club = { ...mapEntry, id: decision.clubId };
    const built = buildClub(club, activeDocs, i, district);
    const already = existingById.get(club.id);
    if (!already && decision.action === 'create') {
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
      // admin or club rep has already entered. With no structure workbook the only field
      // this import can contribute to an existing club is missing doc-key seeds.
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
  // Keyed on the EFFECTIVE club id: a --map-club'd club's docs go to the existing tenant
  // club (S3 prefix, docMeta, clash checks all follow from this one key).
  const groups = new Map<string, ClassifiedFile[]>();
  for (const f of targets) {
    if (!f.club || !f.docKey) continue;
    const key = `${effectiveClubId(f.club.id, args.mapping)}::${f.docKey}`;
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
 * an import-created club from a pre-existing one, so every non-pristine CLUB_MAP club
 * would be treated as "pre-existing, force it" and fully deleted. Refusing beats guessing.
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
  const clubs = await repo.listClubs(TENANT);
  const missingTargets = mapTargetsMissing(args.mapping, new Set(clubs.map((c) => c.id)));
  if (missingTargets.length) throw new Error(missingTargets.join('\n'));
  console.log(`· created-clubs manifest: ${createdClubsManifestPath()}`);
  // Mapped clubs are reverted under their EXISTING tenant id. They are never in the
  // created-clubs manifest (a mapped club is never created), so --all never force-deletes
  // one; only its import-marked docs are stripped.
  const mine = clubs.filter((c) =>
    CLUB_MAP.some((m) => effectiveClubId(m.id, args.mapping) === c.id),
  );
  if (mine.length === 0) {
    console.log('Nothing to revert.');
    return;
  }

  // `mine` includes clubs this import only MERGED into. `--all` forces the delete only
  // for clubs the manifest positively confirms THIS import created.
  const manifestResult = args.all
    ? await readCreatedClubsManifest()
    : ({ kind: 'absent' } as const);
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

    // Not eligible for full delete: strip only import-marked doc keys, and delete the S3
    // objects those keys reference (no lifecycle rule would ever clean them up).
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
  console.log(`\n✓ Tenant catalogue covers all ${TUSKERS_DOC_KEYS.length} required doc keys.`);

  const targets = args.club ? CLUB_MAP.filter((c) => c.id === args.club) : CLUB_MAP;
  if (args.club && targets.length === 0) throw new Error(`--club "${args.club}" not in CLUB_MAP`);

  // District + mapping targets are resolved against the LIVE tenant in dry-run and
  // confirm alike (parse-only never needs them), fail-closed.
  const config = await repo.getTenantConfig(TENANT);
  const districtResult = resolveTuskersDistrict(resolveDistricts(config));
  if (districtResult.kind === 'error')
    throw new Error(`tenant "${TENANT}" district: ${districtResult.message}`);
  const district = districtResult.district;
  console.log(`✓ District for created clubs: "${district}"`);
  const existingIds = new Set((await repo.listClubs(TENANT)).map((c) => c.id));
  const missingTargets = mapTargetsMissing(args.mapping, existingIds);
  if (missingTargets.length) throw new Error(missingTargets.join('\n'));
  for (const [from, to] of args.mapping) console.log(`✓ --map-club ${from} → ${to} (exists)`);

  if (!args.confirm) {
    console.log('\n── Dry-run diff');
    for (const club of targets) {
      const decision = clubWriteDecision(club.id, args.mapping, existingIds);
      // (An 'abort' can't reach here — missing map targets already threw above.)
      const action =
        decision.action === 'abort'
          ? `ABORT — ${decision.reason}`
          : decision.action === 'merge'
            ? 'MERGE (fill absent fields only)'
            : `CREATE in "${district}"`;
      const idLabel =
        args.mapping.has(club.id) && decision.action !== 'abort'
          ? `${club.id} → ${decision.clubId}`
          : club.id;
      console.log(`  ${club.name} (${idLabel}): ${action}`);
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

  await runConfirm(repo, args, parsed.classified, activeDocs, district);
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
  classifyAll,
  walkDocs,
  buildClub,
  isPristine,
  isImportObjectKey,
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
