/**
 * Lions (Central Gauteng Lions / CGL) one-time import — the club universe, from the CGL
 * 2026/27 affiliation Google-Form export plus the fixtures-/T20-/compliance-only clubs in
 * lions-import-map.ts CLUB_MAP.
 *
 *   npx tsx src/import-lions-affiliation.ts --parse-only [--file <xlsx>] [--signoff <md>]
 *   npx sst shell --stage <stage> -- npm --prefix packages/api run import-lions-affiliation -- \
 *     [--file <xlsx>]                                                    # dry-run
 *   … --confirm [--club <id>]                                            # write
 *   … --revert [--confirm]                                               # delete created clubs
 *
 * Skeleton copied from import-tuskers-compliance.ts (the planb→titans→tuskers lineage — the
 * shared core is deliberately NOT refactored out). What this import writes, per club:
 *   - CREATE (absent club): Club record with name, district (resolved against the tenant's
 *     configured district names at run time), doc-key seeds from the tenant catalogue, and —
 *     for affiliated clubs — chair name, `exco.chair` / `exco.sec` {name, email, cell}, home
 *     ground (main + additional facility names) and `leagues` (only keys that already exist
 *     in the tenant config).
 *   - MERGE (club already exists): fill ABSENT fields only, never clobber.
 *   - One audit note per club carrying the affiliation summary (facilities, groundsman,
 *     player count, player-database link, signatory) — Club has no structured field for
 *     those, and new Club fields are deliberately not invented here.
 * It does NOT create USER#/membership items or send anything (Phase 4's contacts import).
 *
 * Fail-closed by design: an unknown club name, an unrecognised district, a CLUB_MAP/
 * affiliation mismatch, a district that disagrees with CLUB_MAP, or a tenant without config
 * / catalogue / the four CGL districts all abort with a printed report.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import type { Club, RequiredDoc } from './types.js';
import { activeRequiredDocs, resolveDistricts } from './catalogue.js';
import {
  CLUB_MAP,
  LIONS_DISTRICTS,
  resolveLionsDistricts,
  type ClubMapEntry,
  type LionsDistrict,
} from './lions-import-map.js';
import {
  parseAffiliationWorkbook,
  leagueKeysOf,
  type AffiliationRecord,
  type ParsedAffiliation,
} from './lions-affiliation-parse.js';
import { deriveTeamPlanCounts } from './team-plan.js';

type RepoModule = typeof import('./repo.js');

const TENANT = 'lions';
/** Audit marker: updateClub actor + note author. */
const IMPORT_MARKER = 'import:lions-affiliation-2026';
const AUDIT_NOTE_PREFIX = `Imported from the CGL 2026/27 club list (${IMPORT_MARKER})`;
const DEFAULT_FILE = '/Users/carlton/Downloads/Lions/CGL Affiliation 2026_27 (Responses) (2).xlsx';
const CLUB_COLORS = ['#0E3529', '#215F47', '#4B8A6C', '#B89B4A', '#E7DDC6', '#8C5A3B'];

// ───────────────────────── Created-clubs manifest ─────────────────────────

/**
 * Stable manifest of every club id this import has CREATED (never merely merged into),
 * across every `--confirm` run — the positive evidence `--revert` needs to delete only what
 * it created. Persisted incrementally (write-before-create). Stage-scoped exactly like the
 * tuskers import (SST_STAGE, else SST_RESOURCE_App's stage, else the legacy unsuffixed name).
 */
const LEGACY_CREATED_CLUBS_MANIFEST_PATH = './lions-affiliation-created-clubs.json';

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
  return `./lions-affiliation-created-clubs.${stage}.json`;
}

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

// ───────────────────────── CLI args ─────────────────────────

interface Args {
  file: string;
  parseOnly: boolean;
  confirm: boolean;
  club?: string;
  revert: boolean;
  /** Write the CGL club-list sign-off markdown here after a clean parse. */
  signoff?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { file: DEFAULT_FILE, parseOnly: false, confirm: false, revert: false };
  let fileGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') {
      args.file = argv[++i] ?? '';
      fileGiven = true;
    } else if (a === '--parse-only') args.parseOnly = true;
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--club') args.club = argv[++i];
    else if (a === '--revert') args.revert = true;
    else if (a === '--signoff') args.signoff = argv[++i];
    else throw new Error(`unknown flag ${a}`);
  }
  if (args.parseOnly && args.confirm) {
    throw new Error('--parse-only never writes — drop --confirm (or drop --parse-only to write)');
  }
  if (fileGiven && !args.file) throw new Error('--file needs a path');
  if (args.signoff === '') throw new Error('--signoff needs a path');
  if (args.club !== undefined && !CLUB_MAP.some((c) => c.id === args.club)) {
    throw new Error(`--club "${args.club}" is not a CLUB_MAP club id`);
  }
  if (args.revert) {
    if (fileGiven) throw new Error('--revert takes no --file');
    if (args.club !== undefined) throw new Error('--revert takes no --club');
    if (args.parseOnly) throw new Error('--revert takes no --parse-only');
    if (args.signoff !== undefined) throw new Error('--revert takes no --signoff');
  }
  return args;
}

// ───────────────────────── Club plan (pure) ─────────────────────────

export interface ClubPlanEntry {
  entry: ClubMapEntry;
  /** The (deduped) affiliation response, when the club submitted one. */
  record: AffiliationRecord | undefined;
}

/**
 * Join CLUB_MAP with the parsed responses and cross-check them. Hard failures: a rejected
 * row; a club the map says is affiliated with no response (or vice versa); a response whose
 * district disagrees with the map's.
 */
export function buildClubPlan(
  parsed: ParsedAffiliation,
  clubs: ClubMapEntry[] = CLUB_MAP,
): { plan: ClubPlanEntry[]; hardFailures: string[] } {
  const byId = new Map(parsed.records.map((r) => [r.club.id, r]));
  const hardFailures: string[] = [];
  for (const r of parsed.rejected)
    hardFailures.push(`row ${r.rowNumber} ("${r.rawClubName}"): ${r.reason}`);
  const plan = clubs.map((entry) => ({ entry, record: byId.get(entry.id) }));
  for (const { entry, record } of plan) {
    const mapSaysAffiliated = entry.sources.includes('affiliation');
    if (mapSaysAffiliated && !record)
      hardFailures.push(
        `${entry.name}: CLUB_MAP lists an affiliation source but no response resolved to it`,
      );
    if (!mapSaysAffiliated && record)
      hardFailures.push(
        `${entry.name}: has an affiliation response (row ${record.rowNumber}) but CLUB_MAP does not list 'affiliation' as a source`,
      );
    if (record && record.district !== entry.district)
      hardFailures.push(
        `${entry.name}: form says district "${record.district}" (raw "${record.rawDistrict}") but CLUB_MAP says "${entry.district}"`,
      );
    if (record && entry.districtGuess)
      hardFailures.push(`${entry.name}: has a response, so its district must not be a guess`);
  }
  return { plan, hardFailures };
}

// ───────────────────────── Reporting ─────────────────────────

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function sourceLabel(entry: ClubMapEntry): string {
  return entry.sources.join('+');
}

function printParseReport(parsed: ParsedAffiliation): void {
  console.log(
    `\n── Affiliation responses: ${parsed.responseCount} row(s) read from "${parsed.sheetName}", ` +
      `${parsed.records.length} club(s) after dedupe`,
  );
  for (const d of parsed.duplicates) {
    for (const x of d.discarded)
      console.log(
        `  ⚠ duplicate submission for ${d.clubId}: discarded row ${x.rowNumber} (${x.timestamp}, "${x.rawClubName}") — ` +
          `kept LATER row ${d.kept.rowNumber} (${d.kept.timestamp}, "${d.kept.rawClubName}")`,
      );
  }
  if (parsed.rejected.length) {
    console.log(`\n  ✗ ${parsed.rejected.length} REJECTED row(s):`);
    for (const r of parsed.rejected)
      console.log(`     row ${r.rowNumber} "${r.rawClubName}": ${r.reason}`);
  }
  const warned = parsed.records.filter((r) => r.warnings.length);
  if (warned.length) {
    console.log(`\n── Data-quality warnings (reported, not blocking)`);
    for (const r of warned)
      console.log(`  ${r.club.name} (row ${r.rowNumber}): ${r.warnings.join('; ')}`);
  }
  const multi = parsed.records.filter(
    (r) => r.chairman.cell.extra.length || r.secretary.cell.extra.length,
  );
  for (const r of multi)
    console.log(`  · ${r.club.name}: a contact cell carried 2+ numbers — first one used`);
  const landlines = parsed.records.filter(
    (r) => r.chairman.cell.landline || r.secretary.cell.landline,
  );
  for (const r of landlines)
    console.log(`  · ${r.club.name}: a chairman/secretary number looks like a landline`);
}

function printClubTable(plan: ClubPlanEntry[]): void {
  console.log(`\n── Club universe (${plan.length} clubs)`);
  console.log(
    `  ${pad('club id', 42)} ${pad('district', 14)} ${pad('sources', 40)} affiliation (Sat | Sun)`,
  );
  for (const { entry, record } of plan) {
    const district = entry.districtGuess ? `${entry.district}*` : entry.district;
    const aff = record
      ? `row ${record.rowNumber}: ${record.saturday.tokens.join(',') || '-'} | ${record.sunday.tokens.join(',') || '-'}`
      : '(no response)';
    console.log(
      `  ${pad(entry.id, 42)} ${pad(district, 14)} ${pad(sourceLabel(entry), 40)} ${aff}`,
    );
  }
  const count = (pred: (e: ClubMapEntry) => boolean) => plan.filter((p) => pred(p.entry)).length;
  const affiliated = count((e) => e.sources.includes('affiliation'));
  const fixturesOnly = count(
    (e) =>
      !e.sources.includes('affiliation') &&
      (e.sources.includes('fixtures') || e.sources.includes('t20')),
  );
  const complianceOnly = count((e) => e.sources.length === 1 && e.sources[0] === 'compliance');
  console.log(
    `\n  ${affiliated} affiliated, ${fixturesOnly} fixtures/T20-only, ${complianceOnly} compliance-only` +
      ` (* = district is a best guess — no affiliation response)`,
  );
  for (const d of LIONS_DISTRICTS)
    console.log(`  ${pad(d, 14)} ${plan.filter((p) => p.entry.district === d).length} club(s)`);
  const flagged = plan.filter((p) => p.entry.flags.length);
  if (flagged.length) {
    console.log(`\n── Judgment calls (for the CGL sign-off)`);
    for (const { entry } of flagged)
      for (const f of entry.flags) console.log(`  ⚑ ${entry.name}: ${f}`);
  }
}

// ───────────────────────── Club building (pure) ─────────────────────────

/** Exco slot value — name/email/cell only, the Titans contacts import's shape. */
function excoValue(c: AffiliationRecord['chairman']): Record<string, string> | undefined {
  if (!c.name && !c.email && !c.cell.cell) return undefined;
  return { name: c.name, email: c.email, ...(c.cell.cell ? { cell: c.cell.cell } : {}) };
}

function excoOf(record: AffiliationRecord | undefined): Record<string, unknown> | undefined {
  if (!record) return undefined;
  const exco: Record<string, unknown> = {};
  const chair = excoValue(record.chairman);
  const sec = excoValue(record.secretary);
  if (chair) exco.chair = chair;
  if (sec) exco.sec = sec;
  return Object.keys(exco).length ? exco : undefined;
}

function groundOf(record: AffiliationRecord | undefined): Club['ground'] {
  if (!record || !record.facilities.mainName) return {};
  const ground: Club['ground'] = { venue: record.facilities.mainName };
  if (record.facilities.additional.length)
    ground.secondaryVenue = record.facilities.additional.join('; ');
  return ground;
}

/** The league keys a club is assigned: its ticked divisions that exist on the tenant. */
export function assignableLeagues(
  record: AffiliationRecord | undefined,
  configuredLeagueKeys: Set<string>,
): { assign: string[]; missing: string[] } {
  if (!record) return { assign: [], missing: [] };
  const wanted = leagueKeysOf(record);
  return {
    assign: wanted.filter((k) => configuredLeagueKeys.has(k)),
    missing: wanted.filter((k) => !configuredLeagueKeys.has(k)),
  };
}

export function buildClub(
  plan: ClubPlanEntry,
  activeDocs: RequiredDoc[],
  index: number,
  district: string,
  leagues: string[],
): Club {
  const { teams, women, juniors } = deriveTeamPlanCounts({});
  const exco = excoOf(plan.record);
  return {
    id: plan.entry.id,
    name: plan.entry.name,
    district,
    sub: '',
    chair: plan.record?.chairman.name ?? '',
    affiliation: 'not_started',
    cqi: 0,
    docs: Object.fromEntries(activeDocs.map((d) => [d.key, false])),
    players: 0,
    teams,
    women,
    juniors,
    color: CLUB_COLORS[index % CLUB_COLORS.length],
    ground: groundOf(plan.record),
    leagues,
    ...(exco ? { exco } : {}),
    version: 1,
  } as Club;
}

/**
 * The single audit note per club. Carries what Club has no structured field for (the
 * player database link, player count, facilities detail, groundsman, signatory) so an
 * admin sees it in the club's communication log.
 */
export function auditNoteText(plan: ClubPlanEntry): string {
  const { entry, record } = plan;
  if (!record) {
    return `${AUDIT_NOTE_PREFIX}. No affiliation response — club appears in: ${entry.sources.join(', ')}.`;
  }
  const f = record.facilities;
  const parts = [
    `${AUDIT_NOTE_PREFIX}. Affiliation form submitted ${record.timestamp.toISOString().slice(0, 10)}` +
      (record.signedBy ? ` by ${record.signedBy}` : '') +
      (record.signedDate ? ` (dated ${record.signedDate})` : '') +
      '.',
    `Saturday: ${record.saturday.tokens.join(', ') || 'none'}. Sunday: ${record.sunday.tokens.join(', ') || 'none'}.`,
    `Players registered (as stated): ${record.playerCountRaw || 'not given'}.`,
    `Player database: ${[record.playerDatabaseUrl, ...record.extraDatabaseUrls].filter(Boolean).join(' , ') || 'not uploaded'}.`,
    `Facilities (${f.countRaw || '?'}): main ${f.mainName || '?'}${f.mainDetails ? ` (${f.mainDetails})` : ''}` +
      `${f.additional.length ? `; additional ${f.additional.join('; ')}` : ''}. ` +
      `Turf fields: ${f.turfRaw || '?'}, astro fields: ${f.astroRaw || '?'}. Ownership: ${f.ownership || '?'}.`,
    `Head groundsman: ${f.groundsmanName || 'not given'}${f.groundsmanCell.cell ? ` (${f.groundsmanCell.cell})` : ''}.`,
  ];
  if (record.clubUnavailableDates)
    parts.push(`Club unavailable dates: ${record.clubUnavailableDates}.`);
  if (f.unavailableDates) parts.push(`Facility unavailable dates: ${f.unavailableDates}.`);
  return parts.join('\n');
}

// ───────────────────────── Sign-off artifact (pure) ─────────────────────────

const SOURCE_WORDS: Record<string, string> = {
  affiliation: 'Affiliation form',
  fixtures: 'League fixtures',
  t20: 'T20 fixtures',
  compliance: 'Compliance documents',
};

function mdEscape(s: string): string {
  return s.replace(/\|/g, '\\|');
}

/**
 * The CGL club-list sign-off (devil's-advocate amendment 4): every club with its final name,
 * district, the sources it appears in, and every other spelling that will be treated as the
 * same club — plus a flagged section for the judgment calls. Written for a union
 * administrator, not an engineer.
 */
export function renderSignoffMarkdown(plan: ClubPlanEntry[], parsed: ParsedAffiliation): string {
  const out: string[] = [];
  const guessed = plan.filter((p) => p.entry.districtGuess);
  out.push('# Central Gauteng Lions — club list for confirmation (2026/27)');
  out.push('');
  out.push(
    'Before the clubs are set up on the Smart Club platform, please check the list below. ' +
      'Each row is ONE club. The "Also written as" column lists the other ways the club\'s name ' +
      'appears in the documents you sent us — all of them will be treated as that same club.',
  );
  out.push('');
  out.push('**Please reply by 7 October 2026** with any corrections, in particular:');
  out.push('');
  out.push('1. Two rows that are really the same club (we will join them).');
  out.push('2. One row that is really two different clubs (we will split it).');
  out.push('3. A club name spelled wrong, or in the wrong district.');
  out.push('');
  out.push(
    'If we have not heard back by 7 October we will go ahead with this list as it stands. ' +
      'Where we were unsure whether two names are the same club, we have kept them as ' +
      'separate clubs — it is easy to join two clubs later, but very hard to separate one.',
  );
  out.push('');
  out.push(
    `In total: **${plan.length} clubs** — ${plan.filter((p) => p.record).length} sent an ` +
      `affiliation form (${parsed.responseCount} forms received; ` +
      `${parsed.duplicates.reduce((n, d) => n + d.discarded.length, 0)} duplicate), ` +
      `${plan.filter((p) => !p.record && (p.entry.sources.includes('fixtures') || p.entry.sources.includes('t20'))).length} ` +
      `appear only in the fixtures, and ` +
      `${plan.filter((p) => p.entry.sources.length === 1 && p.entry.sources[0] === 'compliance').length} ` +
      'appear only in the compliance documents.',
  );
  out.push('');
  out.push('## Items that need your decision');
  out.push('');
  for (const { entry } of plan.filter((p) => p.entry.flags.length)) {
    for (const f of entry.flags) out.push(`- **${entry.name}** — ${f}`);
  }
  if (guessed.length) {
    out.push(
      `- **District to confirm** — these clubs did not send an affiliation form, so we have ` +
        `assumed their district: ${guessed.map((p) => `${p.entry.name} (${p.entry.district})`).join(', ')}.`,
    );
  }
  out.push(
    '- **Not clubs** — "Macrocomm Round 1" to "Macrocomm Round 4" in the Saturday fixture ' +
      'sheets are T20 cup placeholders, not clubs; they have been left out.',
  );
  out.push('');
  for (const d of LIONS_DISTRICTS) {
    const rows = plan.filter((p) => p.entry.district === d);
    if (!rows.length) continue;
    out.push(`## ${d} (${rows.length} clubs)`);
    out.push('');
    out.push('| # | Club name | Appears in | Also written as |');
    out.push('|---|---|---|---|');
    rows
      .slice()
      .sort((a, b) => a.entry.name.localeCompare(b.entry.name))
      .forEach(({ entry, record }, i) => {
        const spellings = new Set(
          [...entry.aliases, ...(record ? [record.rawClubName] : [])].filter(
            (a) => a.trim().toLowerCase() !== entry.name.toLowerCase(),
          ),
        );
        const name = `${entry.name}${entry.districtGuess ? ' *(district assumed)*' : ''}${entry.flags.length ? ' ⚑' : ''}`;
        out.push(
          `| ${i + 1} | ${mdEscape(name)} | ${entry.sources.map((s) => SOURCE_WORDS[s]).join(', ')} | ${mdEscape([...spellings].join('; ') || '—')} |`,
        );
      });
    out.push('');
  }
  out.push('⚑ = see "Items that need your decision" above.');
  out.push('');
  return out.join('\n');
}

// ───────────────────────── Phase P (parse) ─────────────────────────

async function runParsePhase(
  args: Args,
): Promise<{ parsed: ParsedAffiliation; plan: ClubPlanEntry[] } | null> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(args.file);
  const parsed = parseAffiliationWorkbook(wb);
  printParseReport(parsed);
  const { plan, hardFailures } = buildClubPlan(parsed);
  printClubTable(plan);
  if (hardFailures.length) {
    console.error(`\n✗ Refusing to continue:\n${hardFailures.map((f) => `   ${f}`).join('\n')}`);
    process.exitCode = 1;
    return null;
  }
  console.log('\n✓ Parse phase clean.');
  if (args.signoff) {
    await writeFile(args.signoff, renderSignoffMarkdown(plan, parsed));
    console.log(`✓ CGL club-list sign-off written: ${args.signoff}`);
  }
  return { parsed, plan };
}

// ───────────────────────── Phase 1/2 (dry-run / confirm) ─────────────────────────

interface TenantContext {
  activeDocs: RequiredDoc[];
  districtNames: Record<LionsDistrict, string>;
  leagueKeys: Set<string>;
}

async function loadTenantContext(repo: RepoModule): Promise<TenantContext> {
  const config = await repo.getTenantConfig(TENANT);
  if (!config)
    throw new Error(
      `tenant "${TENANT}" has no config — create the tenant first (operator portal), then re-run.`,
    );
  if (!config.requiredDocs?.length)
    throw new Error(
      `tenant "${TENANT}" has no requiredDocs catalogue — run configure-tenant-docs ${TENANT} --confirm first.`,
    );
  const districts = resolveLionsDistricts(resolveDistricts(config));
  if (districts.kind === 'error')
    throw new Error(`tenant "${TENANT}" districts: ${districts.message}`);
  const leagueKeys = new Set((config.leagues ?? []).map((l) => l.key));
  return {
    activeDocs: activeRequiredDocs(config),
    districtNames: districts.byDistrict,
    leagueKeys,
  };
}

function printLeagueNote(ctx: TenantContext, plan: ClubPlanEntry[]): void {
  if (ctx.leagueKeys.size === 0) {
    console.log(
      '· tenant has NO leagues configured yet — league assignment skipped for every club ' +
        '(the Phase 5 fixtures bootstrap creates them; sync-club-leagues runs after the fixtures import).',
    );
    return;
  }
  const missing = new Set<string>();
  for (const p of plan)
    for (const k of assignableLeagues(p.record, ctx.leagueKeys).missing) missing.add(k);
  if (missing.size)
    console.log(
      `· affiliation division(s) with no league on the tenant (not assigned): ${[...missing].sort().join(', ')}`,
    );
}

/** Fill-absent-only patch for a club that already exists. Pure. */
export function mergePatch(current: Club, built: Club): Partial<Club> {
  const patch: Partial<Club> = {};
  const missingDocs = Object.keys(built.docs).filter((k) => current.docs?.[k] === undefined);
  if (missingDocs.length)
    patch.docs = { ...current.docs, ...Object.fromEntries(missingDocs.map((k) => [k, false])) };
  if (!current.district && built.district) patch.district = built.district;
  if (!current.chair && built.chair) patch.chair = built.chair;
  const slotEmpty = (v: unknown) => {
    const s = v as { name?: string; email?: string } | undefined;
    return !s || (!s.name && !s.email);
  };
  const exco = { ...(current.exco ?? {}) };
  let excoChanged = false;
  for (const [slot, value] of Object.entries(built.exco ?? {})) {
    if (slotEmpty(exco[slot])) {
      exco[slot] = value;
      excoChanged = true;
    }
  }
  if (excoChanged) patch.exco = exco;
  if (!current.ground?.venue && built.ground.venue)
    patch.ground = { ...current.ground, ...built.ground };
  if (!current.leagues?.length && built.leagues.length) patch.leagues = built.leagues;
  return patch;
}

async function runDryRun(repo: RepoModule, args: Args, plan: ClubPlanEntry[]): Promise<void> {
  const ctx = await loadTenantContext(repo);
  console.log(
    `\n✓ Tenant "${TENANT}" config found; districts → ${LIONS_DISTRICTS.map((d) => `${d}="${ctx.districtNames[d]}"`).join(', ')}`,
  );
  printLeagueNote(ctx, plan);
  const existing = new Map((await repo.listClubs(TENANT)).map((c) => [c.id, c]));
  const targets = args.club ? plan.filter((p) => p.entry.id === args.club) : plan;
  console.log('\n── Dry-run diff');
  for (const [i, p] of targets.entries()) {
    const leagues = assignableLeagues(p.record, ctx.leagueKeys).assign;
    const built = buildClub(p, ctx.activeDocs, i, ctx.districtNames[p.entry.district], leagues);
    const current = existing.get(p.entry.id);
    if (!current) {
      const bits = [
        `CREATE in "${built.district}"`,
        built.exco ? `exco: ${Object.keys(built.exco).join('+')}` : 'no contacts',
        built.ground.venue ? `ground "${built.ground.venue}"` : 'no ground',
        `leagues: ${leagues.join(',') || '-'}`,
      ];
      console.log(`  ${p.entry.name} (${p.entry.id}): ${bits.join(' · ')}`);
    } else {
      const patch = mergePatch(current, built);
      const fields = Object.keys(patch);
      console.log(
        `  ${p.entry.name} (${p.entry.id}): MERGE — ${fields.length ? `fill ${fields.join(', ')}` : 'nothing absent'}`,
      );
    }
  }
  console.log(`  created-clubs manifest: ${createdClubsManifestPath()}`);
  console.log('\nRe-run with --confirm to write.');
}

async function runConfirm(repo: RepoModule, args: Args, plan: ClubPlanEntry[]): Promise<void> {
  const ctx = await loadTenantContext(repo);
  printLeagueNote(ctx, plan);
  const existingClubs = await repo.listClubs(TENANT);
  const existingById = new Map(existingClubs.map((c) => [c.id, c]));
  const mine = existingClubs.filter((c) => CLUB_MAP.some((m) => m.id === c.id));
  const backupPath = `./lions-affiliation-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(backupPath, JSON.stringify(mine, null, 2));
  console.log(`Backup written: ${backupPath} (${mine.length} existing lions club(s))`);

  const manifestResult = await readCreatedClubsManifest();
  if (manifestResult.kind === 'corrupt') {
    throw new Error(
      `${createdClubsManifestPath()} exists but is unreadable/malformed (${manifestResult.detail}) ` +
        '— refusing to continue: writing through it would discard every club id a prior run ' +
        'recorded. Fix the file by hand or move it aside before re-running --confirm.',
    );
  }
  const manifest = manifestResult.kind === 'ok' ? manifestResult.ids : new Set<string>();
  console.log(`· created-clubs manifest: ${createdClubsManifestPath()}`);

  const targets = args.club ? plan.filter((p) => p.entry.id === args.club) : plan;
  let created = 0;
  let merged = 0;
  for (const [i, p] of targets.entries()) {
    const leagues = assignableLeagues(p.record, ctx.leagueKeys).assign;
    const built = buildClub(p, ctx.activeDocs, i, ctx.districtNames[p.entry.district], leagues);
    const already = existingById.get(p.entry.id);
    if (!already) {
      // Write-before-create (see import-tuskers-compliance.ts runConfirm).
      if (!manifest.has(p.entry.id)) {
        manifest.add(p.entry.id);
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
    const current = already ?? (await repo.getClub(TENANT, p.entry.id));
    if (!current) continue;
    if (already) {
      const patch = mergePatch(current, built);
      if (Object.keys(patch).length) {
        await repo.updateClub(TENANT, p.entry.id, patch, IMPORT_MARKER, new Date().toISOString());
        merged++;
      }
    }
    // One audit note per club, never duplicated on re-runs.
    if (!(current.notes ?? []).some((n) => n.text.startsWith(AUDIT_NOTE_PREFIX))) {
      await repo.appendClubNote(TENANT, p.entry.id, {
        id: `note_${Date.now()}_${p.entry.id}`,
        text: auditNoteText(p),
        author: IMPORT_MARKER,
        at: new Date().toISOString(),
      });
    }
  }
  console.log(`· clubs: ${created} created, ${merged} merged (fill-absent only)`);
  console.log(
    `· created-clubs manifest: ${createdClubsManifestPath()} has ${manifest.size} club(s) recorded as created by this import.`,
  );
}

// ───────────────────────── Revert ─────────────────────────

/** A club with nothing but what this import wrote: no affiliation progress, no documents. */
export function isPristine(club: Club): boolean {
  if (club.affiliation !== 'not_started') return false;
  if (Object.keys(club.docMeta ?? {}).length) return false;
  if (Object.values(club.docs ?? {}).some(Boolean)) return false;
  return true;
}

async function runRevert(repo: RepoModule, args: Args): Promise<void> {
  const manifestResult = await readCreatedClubsManifest();
  if (manifestResult.kind !== 'ok') {
    throw new Error(
      `--revert needs a readable ${createdClubsManifestPath()} (it ${manifestResult.kind === 'absent' ? 'is missing' : `is corrupt: ${manifestResult.detail}`}) — ` +
        'without it this import cannot tell a club it created from one that pre-existed. Nothing deleted.',
    );
  }
  const created = manifestResult.ids;
  const clubs = (await repo.listClubs(TENANT)).filter((c) => created.has(c.id));
  if (!clubs.length) {
    console.log('Nothing to revert.');
    return;
  }
  let deleted = 0;
  for (const club of clubs) {
    const players = (await repo.listPlayers(TENANT, club.id)).length;
    if (players > 0 || !isPristine(club)) {
      console.log(
        `  skip: ${club.id} (${club.name}) — has ${players} player(s) / documents / affiliation progress; ` +
          'revert later importers (roster → contacts → compliance → fixtures) first.',
      );
      continue;
    }
    console.log(
      `${args.confirm ? 'delete' : '[dry-run] would delete'}  ${club.id}  (${club.name})`,
    );
    if (args.confirm) {
      await repo.eraseClubData(TENANT, club);
      deleted++;
    }
  }
  console.log(
    args.confirm ? `Reverted: ${deleted} club(s) deleted.` : 'Re-run with --confirm to apply.',
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
      '\n[parse-only] Parsing clean — nothing touched DynamoDB. Re-run without --parse-only (under sst shell) for the dry-run diff.',
    );
    return;
  }
  const repo = await import('./repo.js');
  if (!args.confirm) {
    await runDryRun(repo, args, parsed.plan);
    return;
  }
  await runConfirm(repo, args, parsed.plan);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export {
  parseArgs,
  createdClubsManifestPath,
  LEGACY_CREATED_CLUBS_MANIFEST_PATH,
  IMPORT_MARKER,
  TENANT,
};
