/**
 * Resolve duplicate smart-club player identities through a reviewed decisions file
 * (dolphins duplicate-remediation, Phase 1).
 *
 *   # 1. plan (READ-ONLY): decisions.json (full keys, mode 600) + decisions-review.md (masked)
 *   npx sst shell --stage prod -- npm --prefix packages/api run resolve-duplicate-players -- \
 *     --tenant dolphins --out ~/audits/dolphins-dups
 *   # 2. a human edits decisions.json (`action`, `purgeCertificates`) using the review md
 *   # 3. apply
 *   npx sst shell --stage prod -- npm --prefix packages/api run resolve-duplicate-players -- \
 *     --tenant dolphins --out ~/audits/dolphins-dups --confirm --decisions ~/audits/dolphins-dups/decisions.json
 *
 * WHAT A GROUP IS — the audit-player-duplicates grouping (same normalised name + dob under
 * different natural keys, reused via duplicateKeyGroups), plus every natural key rostered at
 * more than one club (listed only; never actioned here — a person active at two clubs is a
 * clearance problem, not a deletion).
 *
 * PLAN RULES (per group): default survivor = the one sha256-hex natural key (preferring an
 * active row, then the richer row); every other key is stale (the legacy slug rows). A group
 * whose non-placeholder rows span clubs, without exactly one sha256 key, or holding a pair an
 * admin confirmed distinct (PLAYERDISTINCT) is NEEDS-CHOICE (no default). A row that is
 * clearance-pending, or a key named by an open clearance (canonical or inbound mirror), open
 * registration review or pending veterans request, is BLOCKED. `docOnlyOnStale` flags a
 * survivor with no ID document where a stale row holds one. `purgeCertificates` defaults false.
 * Actions: `merge-into:<survivorNk or its 8-char ref>` | `distinct` | `skip`. A plan never
 * overwrites an existing decisions.json (the edited one) unless --force.
 *
 * CONFIRM: the WHOLE file is validated first (shape, actions, keys) — any problem aborts the run
 * before anything is written (exit 2). Each merge is then re-derived from live rows: new
 * identities with the group's name + dob, rows of the group's keys at clubs the file does not
 * list, a vanished survivor, a confirmed-distinct pair inside the merge, a legacy-slug survivor
 * while the group holds a sha256 key, or a live blocker each refuse that group ("re-plan").
 * deleted-nks.json is preflighted for writability before any write, and each key is recorded
 * there (fsynced) BEFORE its row is deleted (write-ahead), so a crash can never lose a record;
 * an "already merged" re-run backfills any missing record. Per merge-into: JSON backup of every
 * row first; field-fill the survivor (its own non-empty values always win; each dropped stale
 * value is logged) via updatePlayer, `veteransClubId` via setPlayerVeteransClub (so the
 * VETAFFIL record follows the write-on-activation invariant); carry the stale row's ID
 * document(s) when the survivor has none and delete that row with `keepDocs` so the carried S3
 * objects survive; purge certificates only when opted in. Placeholder rows of the survivor key
 * are left untouched. `distinct` → putPlayerDistinct for the pairs not already marked. Re-running
 * skips what is already done. NEVER uses erasePlayerData (its name/email/cell scrub would hit
 * the survivor).
 *
 * EXIT CODES: 0 success (incl. nothing to do) · 1 fatal error · 2 usage/validation error,
 * nothing applied (incl. an unwritable out dir / deleted-nks.json caught by the preflight) ·
 * 4 run completed but one or more entries were refused (partial).
 */
import { createHash } from 'node:crypto';
import { access, chmod, constants, mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { duplicateKeyGroups } from './medicoach-sync/audit-player-duplicates.js';
import { distinctPair, nameDobKey, playerSyncEnabled } from './medicoach-sync/player-placement.js';
import { loadPlayerSyncSnapshot, type PlayerSyncSnapshot } from './medicoach-sync/players.js';
import { purgePlayerCertificates } from './player-certificate-purge.js';
import type { PlayerRegistration } from './types.js';

type RepoModule = typeof import('./repo.js');

export const EXIT = { ok: 0, fatal: 1, usage: 2, partial: 4 } as const;

const USAGE = [
  'usage: resolve-duplicate-players --tenant <t> --out <dir> [--plan [--force] | --confirm --decisions <file>]',
  '  --plan       (default) read-only; writes <dir>/decisions.json + decisions-review.md.',
  '               Refuses to overwrite an existing decisions.json unless --force.',
  '  --confirm    applies <file> after validating all of it; backups + deleted-nks.json go to <dir>.',
  '  exit codes:  0 done (incl. nothing to do) · 1 fatal error · 2 usage/validation error, nothing',
  '               applied (incl. an unwritable --out / deleted-nks.json) · 4 completed, but one or',
  '               more entries were refused (partial).',
].join('\n');

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n${USAGE}`);
    this.name = 'UsageError';
  }
}

/** `--help`: print the usage and exit 0. */
export class HelpRequested extends Error {
  constructor(readonly usage: string = USAGE) {
    super(usage);
    this.name = 'HelpRequested';
  }
}

/** Bad input (decisions file, deleted-nks file, unknown tenant, overwrite refusal): nothing applied. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** The CLI exit code for an error thrown out of main(). */
export function exitCodeFor(err: unknown): number {
  const name = (err as { name?: string })?.name;
  if (name === 'HelpRequested') return EXIT.ok;
  if (name === 'UsageError' || name === 'ValidationError') return EXIT.usage;
  return EXIT.fatal;
}

export interface Args {
  tenant: string;
  out: string;
  mode: 'plan' | 'confirm';
  decisions?: string;
  force?: true;
}

export function parseArgs(argv: string[]): Args {
  let tenant: string | undefined;
  let out: string | undefined;
  let decisions: string | undefined;
  let plan = false;
  let confirm = false;
  let force = false;
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (!v || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') throw new HelpRequested();
    if (flag === '--tenant') tenant = value(++i, flag);
    else if (flag === '--out') out = value(++i, flag);
    else if (flag === '--decisions') decisions = value(++i, flag);
    else if (flag === '--plan') plan = true;
    else if (flag === '--confirm') confirm = true;
    else if (flag === '--force') force = true;
    else throw new UsageError(`unknown argument: ${flag}`);
  }
  if (!tenant) throw new UsageError('--tenant is required');
  if (!out) throw new UsageError('--out is required');
  if (plan && confirm) throw new UsageError('--plan and --confirm are exclusive');
  if (confirm && !decisions) throw new UsageError('--confirm needs --decisions <file>');
  if (!confirm && decisions) throw new UsageError('--decisions is only read with --confirm');
  if (confirm && force) throw new UsageError('--force only applies to --plan');
  return {
    tenant,
    out,
    mode: confirm ? 'confirm' : 'plan',
    ...(decisions ? { decisions } : {}),
    ...(force ? { force: true as const } : {}),
  };
}

// ── Decisions file ──

export type EntryStatus =
  | 'PROPOSED'
  | 'NEEDS-CHOICE'
  | 'BLOCKED'
  | 'OUT-OF-BAND'
  | 'SETTLED'
  | 'INFO';
const STATUSES: readonly EntryStatus[] = [
  'PROPOSED',
  'NEEDS-CHOICE',
  'BLOCKED',
  'OUT-OF-BAND',
  'SETTLED',
  'INFO',
];
const KINDS = ['name-dob-group', 'same-key-multi-club'] as const;

export interface RowSummary {
  naturalKey: string;
  /** The masked key exactly as decisions-review.md prints it — match the two files by this. */
  ref?: string;
  clubId: string;
  club: string;
  status: string;
  placeholder: boolean;
  idKind: string;
  hasIdDoc: boolean;
  keyKind: 'sha256' | 'legacy-slug';
  team?: string;
  /** YYYY-MM-DD of the row's createdAt. */
  created?: string;
  registeredVia?: string;
  veteransClub?: string;
}

export interface DecisionEntry {
  id: string;
  kind: 'name-dob-group' | 'same-key-multi-club';
  status: EntryStatus;
  /** Initials + birth year (who this entry is), so decisions.json is readable on its own. */
  who?: string;
  reason: string;
  naturalKeys: string[];
  rows: RowSummary[];
  /** The proposed survivor (PROPOSED only) — informational; `action` is what runs. */
  survivor: string | null;
  docOnlyOnStale: boolean;
  /** User-editable: purge the deleted rows' transfer certificates (default false). */
  purgeCertificates: boolean;
  blockedBy: string[];
  /** Pairs of this group's keys an admin confirmed are different people (never merged). */
  distinctPairs?: Array<[string, string]>;
  /** How the rows' ID numbers compare, masked (no digits). */
  idHint?: string;
  /** Other entries naming one of this entry's keys. */
  seeAlso?: string[];
  /** User-editable: `merge-into:<survivorNk or ref>` | `distinct` | `skip`. */
  action: string;
}

export interface DecisionsFile {
  tenant: string;
  generatedAt: string;
  entries: DecisionEntry[];
}

export interface DeletedNk {
  tenant: string;
  naturalKey: string;
  clubIds: string[];
  /** Set by tombstone-deleted-players once the erase tombstone is queued. */
  tombstonedAt?: string;
}

export const isShaKey = (nk: string): boolean => /^[0-9a-f]{64}$/.test(nk);
/**
 * A key as printed to the terminal / review md: a sha256 key's first 8 chars; a legacy slug key
 * (which can embed a name, dob or plaintext ID) is hashed first, so no fragment of it is shown.
 * decisions.json alone carries full keys. Shared with tombstone-deleted-players so the two
 * CLIs' outputs cross-reference.
 */
export const maskKey = (nk: string): string =>
  `${(isShaKey(nk) ? nk : createHash('sha256').update(nk).digest('hex')).slice(0, 8)}…`;
const cut = maskKey;
const statusOf = (r: Pick<PlayerRegistration, 'status'>): string => r.status ?? 'active';
const isPlaceholder = (r: Pick<PlayerRegistration, 'placeholder'>) => r.placeholder === true;

function idKindOf(r: PlayerRegistration): string {
  if (!String(r.idNumber ?? '').trim()) return 'none';
  return r.idType ?? 'sa-id';
}

/** Non-empty own fields — the "richer row" tie-break. */
function richness(r: PlayerRegistration): number {
  return Object.values(r).filter((v) => v !== undefined && v !== null && v !== '').length;
}

function summarise(clubsById: Map<string, { name: string }>, r: PlayerRegistration): RowSummary {
  return {
    naturalKey: r.naturalKey,
    ref: cut(r.naturalKey),
    clubId: r.clubId,
    club: clubsById.get(r.clubId)?.name ?? r.clubId,
    status: statusOf(r),
    placeholder: isPlaceholder(r),
    idKind: idKindOf(r),
    hasIdDoc: !!r.idDocMeta?.objectKey,
    keyKind: isShaKey(r.naturalKey) ? 'sha256' : 'legacy-slug',
    ...(r.team ? { team: r.team } : {}),
    ...(r.createdAt ? { created: String(r.createdAt).slice(0, 10) } : {}),
    ...(r.registeredVia ? { registeredVia: r.registeredVia } : {}),
    ...(r.veteransClub ? { veteransClub: r.veteransClub } : {}),
  };
}

/** Stable entry id from the sorted keys, so "approve G-1a2b3c" survives a re-plan. */
function stableId(prefix: 'G' | 'K', keys: string[], taken: Set<string>): string {
  const h = createHash('sha256')
    .update([...keys].sort().join('\n'))
    .digest('hex');
  for (let n = 6; n <= h.length; n++) {
    const id = `${prefix}-${h.slice(0, n)}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
  throw new Error('entry id collision');
}

/** A masked comparison of the rows' ID numbers: never a digit, only how they differ. */
function idHint(rows: PlayerRegistration[]): string {
  const withId = rows.filter((r) => String(r.idNumber ?? '').trim());
  if (withId.length === 0) return 'no row carries an ID number';
  if (withId.length === 1) return 'only one row carries an ID number';
  const norm = (r: PlayerRegistration) =>
    String(r.idNumber)
      .toUpperCase()
      .replace(/[^0-9A-Z]/g, '');
  const numbers = [...new Set(withId.map(norm))];
  if (numbers.length === 1) {
    const nats = new Set(
      withId.map((r) =>
        String(r.nationality ?? '')
          .trim()
          .toLowerCase(),
      ),
    );
    const types = new Set(withId.map((r) => r.idType ?? 'sa-id'));
    if (types.size > 1) return 'same document number, ID type differs';
    if (nats.size > 1) return 'same document number, nationality differs';
    return 'same ID number on every row';
  }
  if (numbers.length === 2 && numbers[0].length === numbers[1].length) {
    let d = 0;
    for (let i = 0; i < numbers[0].length; i++) if (numbers[0][i] !== numbers[1][i]) d++;
    return `ID numbers differ in ${d} character(s)`;
  }
  return `${numbers.length} different ID numbers`;
}

// ── Open records that block a delete ──

/** naturalKey → the open records naming it. */
export type OpenRecords = Map<string, string[]>;

type OpenRecordsRepo = Pick<
  RepoModule,
  'listAllClearances' | 'listInboundForDest' | 'listAllReviews' | 'listAllVeteransRequests'
>;

/**
 * Every OPEN record that addresses a person by natural key: pending clearances (canonical
 * CLEARANCE# via the gsi1, plus each club's INBOUND_CLEARANCE# mirrors — a mirror whose
 * canonical sits off the listing still blocks), open REGREVIEW# rows and pending VETREQ# rows.
 * A clearance names its direction (from → to club) so the operator need not look it up.
 */
export async function loadOpenRecords(
  repo: OpenRecordsRepo,
  tenant: string,
  clubIds: string[],
): Promise<OpenRecords> {
  const open: OpenRecords = new Map();
  const add = (nk: string | undefined, what: string) => {
    if (!nk) return;
    const list = open.get(nk) ?? [];
    if (!list.includes(what)) list.push(what);
    open.set(nk, list);
  };
  const dir = (c: {
    fromClubName?: string;
    fromClubId?: string;
    toClubName?: string;
    toClubId?: string;
  }) => `(${c.fromClubName || c.fromClubId || '?'} → ${c.toClubName || c.toClubId || '?'})`;
  const [clearances, reviews, vetreqs] = await Promise.all([
    repo.listAllClearances(tenant),
    repo.listAllReviews(tenant),
    repo.listAllVeteransRequests(tenant),
  ]);
  const seen = new Set<string>();
  for (const c of clearances)
    if (c.status === 'pending') {
      seen.add(c.id);
      add(c.playerNaturalKey, `CLEARANCE#${c.id} ${dir(c)}`);
    }
  for (const clubId of clubIds)
    for (const c of await repo.listInboundForDest(tenant, clubId))
      if (c.status === 'pending' && !seen.has(c.id))
        add(c.playerNaturalKey, `INBOUND_CLEARANCE#${c.id} ${dir(c)}`);
  for (const r of reviews) if (r.status === 'open') add(r.playerNaturalKey, `REGREVIEW#${r.id}`);
  for (const v of vetreqs) if (v.status === 'pending') add(v.playerNaturalKey, `VETREQ#${v.id}`);
  return open;
}

/** Live blockers for a set of rows + keys: clearance-pending rows and open records. */
function blockersFor(
  rows: Array<Pick<PlayerRegistration, 'naturalKey' | 'clubId' | 'status'>>,
  keys: string[],
  open: OpenRecords,
  clubName: (id: string) => string,
): string[] {
  const out: string[] = [];
  for (const r of rows)
    if (r.status === 'clearance-pending')
      out.push(`PLAYER#${r.naturalKey} at ${clubName(r.clubId)} is clearance-pending`);
  for (const nk of keys) for (const what of open.get(nk) ?? []) out.push(what);
  return out;
}

function pairsOf(keys: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++) out.push(distinctPair(keys[i], keys[j]));
  return out;
}

// ── Plan ──

/** Survivor ranking: sha256 key, then an active row, then the richer row, then key order. */
function rankKeys(snap: PlayerSyncSnapshot, keys: string[]): string[] {
  const score = (nk: string) => {
    const rows = snap.rowsByNk.get(nk) ?? [];
    return {
      sha: isShaKey(nk) ? 1 : 0,
      active: rows.some((r) => statusOf(r) === 'active' && !isPlaceholder(r)) ? 1 : 0,
      rich: Math.max(0, ...rows.map(richness)),
    };
  };
  return [...keys].sort((a, b) => {
    const x = score(a);
    const y = score(b);
    return y.sha - x.sha || y.active - x.active || y.rich - x.rich || a.localeCompare(b);
  });
}

function initials(r: Pick<PlayerRegistration, 'firstName' | 'lastName'> | undefined): string {
  const i = (s: unknown) =>
    String(s ?? '')
      .trim()
      .charAt(0)
      .toUpperCase();
  const out = [i(r?.firstName), i(r?.lastName)].filter(Boolean).join('.');
  return out ? `${out}.` : '∅';
}

function whoOf(rows: PlayerRegistration[]): string {
  const first = rows.find((r) => !isPlaceholder(r)) ?? rows[0];
  return `${initials(first)} (${String(first?.dob ?? '').slice(0, 4) || '????'})`;
}

/** Review order: what needs a human first, listed-only last. */
const SECTIONS: Array<{ title: string; statuses: EntryStatus[] }> = [
  { title: 'Needs your decision', statuses: ['NEEDS-CHOICE'] },
  { title: 'Proposed (review)', statuses: ['PROPOSED'] },
  { title: 'Blocked', statuses: ['BLOCKED', 'OUT-OF-BAND'] },
  { title: 'Listed only', statuses: ['SETTLED', 'INFO'] },
];
const sectionRank = (s: EntryStatus) => SECTIONS.findIndex((x) => x.statuses.includes(s));

export function buildDecisions(
  snap: PlayerSyncSnapshot,
  open: OpenRecords,
  tenant: string,
  at: string,
): DecisionsFile {
  const entries: DecisionEntry[] = [];
  const taken = new Set<string>();
  const clubName = (id: string) => snap.clubsById.get(id)?.name ?? id;
  for (const group of duplicateKeyGroups(snap)) {
    const rows = group.keys.flatMap((nk) => snap.rowsByNk.get(nk) ?? []);
    const blockedBy = blockersFor(rows, group.keys, open, clubName);
    // A lingering placeholder row is not a club the person plays for.
    const clubs = new Set(rows.filter((r) => !isPlaceholder(r)).map((r) => r.clubId));
    const shaKeys = group.keys.filter(isShaKey);
    const distinctPairs = pairsOf(group.keys).filter((p) => snap.distinct.has(p.join('#')));
    let status: EntryStatus;
    let reason: string;
    let survivor: string | null = null;
    if (group.allConfirmedDistinct) {
      status = 'SETTLED';
      reason = 'every pair already confirmed distinct by an admin';
    } else if (blockedBy.length) {
      status = 'BLOCKED';
      reason = 'settle the open record(s) first, then re-plan';
    } else if (distinctPairs.length) {
      status = 'NEEDS-CHOICE';
      reason =
        `an admin confirmed ${distinctPairs.map(([a, b]) => `${cut(a)} ≠ ${cut(b)}`).join(', ')} ` +
        '(PLAYERDISTINCT): --confirm refuses any merge that would combine a confirmed-distinct ' +
        'pair — choose `distinct` or `skip`';
    } else if (clubs.size > 1) {
      status = 'NEEDS-CHOICE';
      reason =
        'rows span clubs — a sporting decision: set action to merge-into:<key> of the club that keeps the player';
    } else if (shaKeys.length !== 1) {
      status = 'NEEDS-CHOICE';
      reason = `${shaKeys.length} sha256 keys in the group — which ID is correct is a human call`;
    } else {
      status = 'PROPOSED';
      reason = 'same club; sha256-keyed row survives, legacy slug row(s) merged into it';
      // Exactly one sha key and rankKeys puts sha first: a slug survivor is never proposed.
      survivor = rankKeys(snap, group.keys)[0];
    }
    const survivorRows = survivor ? (snap.rowsByNk.get(survivor) ?? []) : [];
    const staleRows = survivor ? rows.filter((r) => r.naturalKey !== survivor) : [];
    entries.push({
      id: stableId('G', group.keys, taken),
      kind: 'name-dob-group',
      status,
      who: whoOf(rows),
      reason,
      naturalKeys: group.keys,
      rows: rows.map((r) => summarise(snap.clubsById, r)),
      survivor,
      docOnlyOnStale:
        !!survivor &&
        !survivorRows.some((r) => r.idDocMeta?.objectKey) &&
        staleRows.some((r) => r.idDocMeta?.objectKey),
      purgeCertificates: false,
      blockedBy,
      ...(distinctPairs.length ? { distinctPairs } : {}),
      idHint: idHint(rows.filter((r) => !isPlaceholder(r))),
      action: survivor ? `merge-into:${survivor}` : 'skip',
    });
  }

  for (const nk of [...snap.rowsByNk.keys()].sort()) {
    const rows = snap.rowsByNk.get(nk) ?? [];
    if (new Set(rows.map((r) => r.clubId)).size < 2) continue;
    const blockedBy = blockersFor(rows, [nk], open, clubName);
    const active = rows.filter((r) => statusOf(r) === 'active' && !isPlaceholder(r)).length;
    const status: EntryStatus = active >= 2 ? 'OUT-OF-BAND' : blockedBy.length ? 'BLOCKED' : 'INFO';
    entries.push({
      id: stableId('K', [nk], taken),
      kind: 'same-key-multi-club',
      status,
      who: whoOf(rows),
      reason:
        status === 'OUT-OF-BAND'
          ? 'one identity active at two clubs — resolve through the clearance flow, never here'
          : 'one identity rostered at several clubs (listed only; never actioned here)',
      naturalKeys: [nk],
      rows: rows.map((r) => summarise(snap.clubsById, r)),
      survivor: null,
      docOnlyOnStale: false,
      purgeCertificates: false,
      blockedBy,
      action: 'skip',
    });
  }

  // Cross-reference entries naming the same key (a person in a group AND listed multi-club).
  for (const e of entries) {
    const also = entries
      .filter((o) => o !== e && o.naturalKeys.some((k) => e.naturalKeys.includes(k)))
      .map((o) => o.id);
    if (also.length) e.seeAlso = also;
  }
  // Stable sort: the review order (needs a decision first), snapshot order within a section.
  const ordered = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => sectionRank(a.e.status) - sectionRank(b.e.status) || a.i - b.i)
    .map((x) => x.e);
  return { tenant, generatedAt: at, entries: ordered };
}

/** The masked review: initials + birth year, keys cut to 8 chars, no ID numbers. */
export function renderReview(file: DecisionsFile): string {
  const lines: string[] = [`# Duplicate players — ${file.tenant} (${file.generatedAt})`, ''];
  if (!file.entries.length) {
    lines.push('No duplicates found. Nothing to decide.', '');
    return lines.join('\n');
  }
  lines.push(
    'Edit `decisions.json` (same folder), not this file. Per entry set `action` to',
    '`merge-into:<key>` (the full key from decisions.json, or the 8-character ref shown here,',
    'e.g. `merge-into:1a2b3c4d`), `distinct` or `skip`, and `purgeCertificates` to true only to',
    'destroy the merged-away rows’ transfer certificates. Rows in decisions.json carry the same',
    '`ref` as this file. BLOCKED / OUT-OF-BAND / same-key entries are never actioned; settle them',
    'and re-plan. A merge that would combine a pair an admin confirmed distinct is always refused.',
    '',
    '_PII: decisions.json, backup-*.json and deleted-nks.json hold full keys and ID numbers (mode',
    '600). Delete the backups once the merges are verified; keep deleted-nks.json until',
    'tombstone-deleted-players has run with --confirm._',
    '',
  );
  const counts = new Map<string, number>();
  for (const e of file.entries) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  lines.push(
    `Entries: ${file.entries.length} — ${[...counts].map(([s, n]) => `${s} ${n}`).join(', ')}`,
    '',
  );
  for (const section of SECTIONS) {
    const inSection = file.entries.filter((e) => section.statuses.includes(e.status));
    if (!inSection.length) continue;
    lines.push(`# ${section.title} (${inSection.length})`, '');
    for (const e of inSection) renderEntry(e, lines);
  }
  return lines.join('\n');
}

function renderEntry(e: DecisionEntry, lines: string[]): void {
  lines.push(`## ${e.id} · ${e.status} · ${e.who ?? '∅'}`);
  lines.push(`- kind: ${e.kind}`);
  lines.push(`- ${e.reason}`);
  if (e.status === 'PROPOSED' && e.action.startsWith('merge-into:'))
    lines.push(`- proposed action: \`merge-into:${cut(e.action.slice('merge-into:'.length))}\``);
  else if (e.status === 'NEEDS-CHOICE')
    lines.push('- action: **no default — decide** (`merge-into:<ref>`, `distinct` or `skip`)');
  else lines.push('- action: listed only — not actionable here');
  if (e.idHint) lines.push(`- ID numbers: ${e.idHint}`);
  if (e.distinctPairs?.length)
    lines.push(
      `- confirmed distinct by an admin: ${e.distinctPairs.map(([a, b]) => `${cut(a)} ≠ ${cut(b)}`).join(', ')}`,
    );
  if (e.docOnlyOnStale) lines.push('- **DOC-ONLY-ON-STALE**: the ID document is carried over');
  const withDoc = e.rows.filter((r) => r.hasIdDoc);
  if (!e.survivor && withDoc.length && withDoc.length < e.rows.length)
    lines.push(
      `- ID document held only by: ${withDoc.map((r) => `${cut(r.naturalKey)} at ${r.club}`).join(', ')} (carried to the survivor if it has none)`,
    );
  if (e.blockedBy.length) lines.push(`- blocked by: ${e.blockedBy.map(maskBlocker).join('; ')}`);
  if (e.seeAlso?.length) lines.push(`- see also: ${e.seeAlso.join(', ')}`);
  lines.push(
    '',
    '| ref | kind | club | status | placeholder | id | id doc | team | created | via | veterans |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of e.rows)
    lines.push(
      `| ${cut(r.naturalKey)}${r.naturalKey === e.survivor ? ' (survivor)' : ''} | ${r.keyKind} | ${r.club} | ${r.status} | ${r.placeholder ? 'yes' : ''} | ${r.idKind} | ${r.hasIdDoc ? 'yes' : ''} | ${r.team ?? ''} | ${r.created ?? ''} | ${r.registeredVia ?? ''} | ${r.veteransClub ?? ''} |`,
    );
  lines.push('');
}

type PlanRepo = Parameters<typeof loadPlayerSyncSnapshot>[0] & OpenRecordsRepo;

/** Refuse a tenant with neither a config nor a club (a typo'd --tenant). */
export async function assertTenantExists(
  repo: Pick<RepoModule, 'getTenantConfig' | 'listClubs'>,
  tenant: string,
): Promise<void> {
  if (await repo.getTenantConfig(tenant)) return;
  if ((await repo.listClubs(tenant)).length) return;
  throw new ValidationError(`unknown tenant "${tenant}" (no tenant config and no clubs)`);
}

/** The --plan pass. Takes a READ-ONLY repo surface: the type itself admits no write. */
export async function runPlan(
  repo: PlanRepo,
  tenant: string,
  outDir: string,
  at = new Date().toISOString(),
  opts: { force?: boolean } = {},
): Promise<DecisionsFile> {
  await assertTenantExists(repo, tenant);
  const jsonPath = path.join(outDir, 'decisions.json');
  if (!opts.force && (await exists(jsonPath)))
    throw new ValidationError(
      `${jsonPath} already exists (it may hold your edits) — move or rename it, or pass --force to overwrite`,
    );
  const snap = await loadPlayerSyncSnapshot(repo, tenant);
  const open = await loadOpenRecords(repo, tenant, [...snap.clubsById.keys()]);
  const file = buildDecisions(snap, open, tenant, at);
  await mkdir(outDir, { recursive: true });
  await writePrivate(jsonPath, JSON.stringify(file, null, 2));
  await writePrivate(path.join(outDir, 'decisions-review.md'), renderReview(file));
  return file;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Write a mode-600 file durably: temp file, fsync, rename over the target. */
async function writePrivate(file: string, body: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  const fh = await open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

// ── Validation (the whole file, before anything is written) ──

/** Resolve an action's `merge-into:` target: a full key, or the 8-char ref (with or without …). */
function resolveTarget(target: string, keys: string[]): string | 'ambiguous' | null {
  if (keys.includes(target)) return target;
  const ref = target.replace(/…$/, '');
  if (!/^[0-9a-f]{8}$/.test(ref)) return null;
  const hits = keys.filter((k) => cut(k) === `${ref}…`);
  return hits.length === 1 ? hits[0] : hits.length > 1 ? 'ambiguous' : null;
}

/**
 * Validate a parsed decisions file in full. Returns a normalised copy (`merge-into:` resolved to
 * full keys); throws one ValidationError naming every problem. Nothing is read from the table.
 */
export function validateDecisionsFile(raw: unknown, tenant: string): DecisionsFile {
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ValidationError(
      'the decisions file must be a JSON object { tenant, generatedAt, entries } as written by --plan',
    );
  const f = raw as Record<string, unknown>;
  if (typeof f.tenant !== 'string' || !f.tenant)
    throw new ValidationError('the decisions file has no "tenant" — is this a --plan output?');
  if (f.tenant !== tenant)
    throw new ValidationError(`the decisions file is for tenant "${f.tenant}", not "${tenant}"`);
  if (!Array.isArray(f.entries))
    throw new ValidationError(
      'the decisions file has no "entries" array — is this a --plan output?',
    );
  const ids = new Set<string>();
  const entries: DecisionEntry[] = [];
  f.entries.forEach((rawEntry: unknown, i: number) => {
    const where = `entries[${i}]`;
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      problems.push(`${where}: not an object`);
      return;
    }
    const e = rawEntry as Record<string, unknown>;
    const label = typeof e.id === 'string' && e.id ? `${e.id} (${where})` : where;
    const bad = (msg: string) => problems.push(`${label}: ${msg}`);
    if (typeof e.id !== 'string' || !e.id) bad('missing "id"');
    else if (ids.has(e.id)) bad(`duplicate id "${e.id}"`);
    else ids.add(e.id);
    if (!KINDS.includes(e.kind as (typeof KINDS)[number])) bad(`unknown kind "${String(e.kind)}"`);
    if (!STATUSES.includes(e.status as EntryStatus)) bad(`unknown status "${String(e.status)}"`);
    const keys = e.naturalKeys;
    const keysOk =
      Array.isArray(keys) &&
      keys.length > 0 &&
      keys.every((k) => typeof k === 'string' && k.length > 0) &&
      new Set(keys).size === keys.length;
    if (!keysOk) bad('"naturalKeys" must be a non-empty array of distinct, non-empty strings');
    const rows = e.rows;
    if (
      !Array.isArray(rows) ||
      !rows.every(
        (r) =>
          r &&
          typeof r === 'object' &&
          typeof (r as RowSummary).naturalKey === 'string' &&
          typeof (r as RowSummary).clubId === 'string' &&
          (r as RowSummary).clubId.length > 0 &&
          (!keysOk || (keys as string[]).includes((r as RowSummary).naturalKey)),
      )
    )
      bad('"rows" must list { naturalKey (one of naturalKeys), clubId } objects');
    if (e.purgeCertificates !== undefined && typeof e.purgeCertificates !== 'boolean')
      bad(`"purgeCertificates" must be true or false, not ${JSON.stringify(e.purgeCertificates)}`);
    if (e.blockedBy !== undefined && !Array.isArray(e.blockedBy))
      bad('"blockedBy" must be an array');
    let action = typeof e.action === 'string' ? e.action.trim() : undefined;
    if (action === undefined) bad('missing "action"');
    else if (action === 'skip' || action === 'distinct') {
      /* ok */
    } else if (action.startsWith('merge-into:')) {
      const target = action.slice('merge-into:'.length).trim();
      const resolved = keysOk ? resolveTarget(target, keys as string[]) : null;
      if (resolved === 'ambiguous')
        bad(`merge-into:${target} matches more than one key — use the full key`);
      else if (!resolved) bad('merge-into names a key that is not in this group');
      else action = `merge-into:${resolved}`;
    } else bad(`unknown action "${action}" — expected merge-into:<key>, distinct or skip`);
    entries.push({
      ...(e as unknown as DecisionEntry),
      action: action ?? '',
      purgeCertificates: e.purgeCertificates === true,
      blockedBy: Array.isArray(e.blockedBy) ? (e.blockedBy as string[]) : [],
    });
  });
  if (problems.length)
    throw new ValidationError(
      `the decisions file has ${problems.length} problem(s) — nothing was applied:\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
  return {
    tenant,
    generatedAt: typeof f.generatedAt === 'string' ? f.generatedAt : '',
    entries,
  };
}

/** Strict schema for deleted-nks.json (shared with tombstone-deleted-players). */
export function validateDeletedEntries(raw: unknown, file: string): DeletedNk[] {
  if (!Array.isArray(raw))
    throw new ValidationError(`${file} must be a JSON array of { tenant, naturalKey, clubIds }`);
  const problems: string[] = [];
  raw.forEach((e: unknown, i: number) => {
    const where = `[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      problems.push(`${where}: not an object`);
      return;
    }
    const d = e as Record<string, unknown>;
    if (typeof d.tenant !== 'string' || !d.tenant) problems.push(`${where}: missing "tenant"`);
    if (typeof d.naturalKey !== 'string' || !d.naturalKey.trim())
      problems.push(`${where}: "naturalKey" must be a non-empty string`);
    if (!Array.isArray(d.clubIds) || !d.clubIds.every((c) => typeof c === 'string' && c))
      problems.push(`${where}: "clubIds" must be an array of club ids`);
    if (d.tombstonedAt !== undefined && typeof d.tombstonedAt !== 'string')
      problems.push(`${where}: "tombstonedAt" must be a string`);
  });
  if (problems.length)
    throw new ValidationError(
      `${file} is malformed (${problems.length} problem(s)) — nothing was done:\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
  // Dedupe: one entry per tenant + key, club ids merged. When duplicates disagree on
  // tombstonedAt, an UNSTAMPED record wins (it means the key was deleted again after the
  // tombstone, so the erase must run again); otherwise the newest stamp is kept.
  const out: DeletedNk[] = [];
  for (const d of raw as DeletedNk[]) {
    const hit = out.find((o) => o.tenant === d.tenant && o.naturalKey === d.naturalKey);
    if (!hit) {
      out.push({ ...d, clubIds: [...new Set(d.clubIds)] });
      continue;
    }
    for (const c of d.clubIds) if (!hit.clubIds.includes(c)) hit.clubIds.push(c);
    if (hit.tombstonedAt === undefined || d.tombstonedAt === undefined) delete hit.tombstonedAt;
    else if (d.tombstonedAt > hit.tombstonedAt) hit.tombstonedAt = d.tombstonedAt;
  }
  return out;
}

/** Read + validate a deleted-nks file; a missing file is an empty list. */
export async function readDeleted(file: string): Promise<DeletedNk[]> {
  let body: string;
  try {
    body = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return [];
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    throw new ValidationError(`${file}: not valid JSON — ${(err as Error).message}`);
  }
  return validateDeletedEntries(raw, file);
}

/** Read + parse a JSON input file, naming the file on any failure (exit 2). */
export async function readJsonInput(file: string): Promise<unknown> {
  let body: string;
  try {
    body = await readFile(file, 'utf8');
  } catch (err) {
    throw new ValidationError(`cannot read ${file}: ${(err as { code?: string }).code ?? err}`);
  }
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new ValidationError(`${file}: not valid JSON — ${(err as Error).message}`);
  }
}

// ── Confirm ──

/** Ordinary fields filled from the stale row where the survivor's is empty. */
export const FILL_FIELDS = [
  'transferNote',
  'lastClub',
  'battingHand',
  'bowlingHand',
  'battingType',
  'bowlerType',
  'isAllRounder',
  'isWk',
  'position',
] as const satisfies ReadonlyArray<keyof PlayerRegistration>;

/** Free-text fields whose dropped value is never printed (only its length). */
const MASKED_FIELDS = new Set<string>(['transferNote']);

function isEmptyField(field: string, v: unknown): boolean {
  if (v === undefined || v === null) return true;
  // bowlerType '' is a real value ("not a bowler"), so only absence counts as empty there.
  return field !== 'bowlerType' && v === '';
}

type ApplyRepo = Pick<
  RepoModule,
  | 'getPlayer'
  | 'getTenantConfig'
  | 'listPlayers'
  | 'listPlayerDistinctPairs'
  | 'updatePlayer'
  | 'setPlayerVeteransClub'
  | 'deletePlayer'
  | 'deleteUploadObjects'
  | 'putPlayerDistinct'
  | 'listClubs'
  | 'listClearancesForSource'
  | 'purgeClearanceCertificate'
> &
  OpenRecordsRepo;

export interface DroppedValue {
  id: string;
  field: string;
  kept: string;
  dropped: string;
}

export interface ApplyReport {
  merged: string[];
  distinct: string[];
  skipped: string[];
  alreadyDone: string[];
  refused: Array<{ id: string; why: string }>;
  deleted: DeletedNk[];
  /** Keys deleted by an earlier run whose record was missing, recorded now. */
  backfilled: string[];
  /** Stale values that lost to the survivor's own value (masked where free text). */
  conflicts: DroppedValue[];
  backupPath: string | null;
  deletedPath: string | null;
  /** The tenant's player sync was on: the deletes queued ordinary change rows. */
  syncOn: boolean;
}

interface Prepared {
  entry: DecisionEntry;
  op: 'merge' | 'distinct';
  survivor?: PlayerRegistration;
  stale?: PlayerRegistration[];
  pairs?: Array<[string, string]>;
  backupRows: PlayerRegistration[];
}

const errName = (err: unknown) => (err as { name?: string })?.name ?? 'error';
const show = (field: string, v: unknown) =>
  MASKED_FIELDS.has(field) ? `[text, ${String(v).length} chars]` : JSON.stringify(v);

/** Every live row of the tenant, by key, plus the name+dob index (placeholders excluded). */
async function loadLive(
  repo: Pick<RepoModule, 'listPlayers'>,
  tenant: string,
  clubIds: string[],
): Promise<{ rowsByNk: Map<string, PlayerRegistration[]>; byNameDob: Map<string, Set<string>> }> {
  const rowsByNk = new Map<string, PlayerRegistration[]>();
  const byNameDob = new Map<string, Set<string>>();
  const CONCURRENCY = 8;
  for (let i = 0; i < clubIds.length; i += CONCURRENCY) {
    const slice = clubIds.slice(i, i + CONCURRENCY);
    // eslint-disable-next-line no-await-in-loop -- sequential slices, each internally parallel
    const rosters = await Promise.all(slice.map((c) => repo.listPlayers(tenant, c)));
    for (const roster of rosters)
      for (const p of roster) {
        rowsByNk.set(p.naturalKey, [...(rowsByNk.get(p.naturalKey) ?? []), p]);
        if (isPlaceholder(p)) continue;
        const key = nameDobKey(p);
        if (!key) continue;
        const set = byNameDob.get(key) ?? new Set<string>();
        set.add(p.naturalKey);
        byNameDob.set(key, set);
      }
  }
  return { rowsByNk, byNameDob };
}

/** Preflight: the out dir and deleted-nks.json must be writable before anything changes. */
async function preflightWritable(outDir: string, deletedPath: string): Promise<void> {
  try {
    await mkdir(outDir, { recursive: true });
    await access(outDir, constants.W_OK);
    if (await exists(deletedPath)) await (await open(deletedPath, 'r+')).close();
  } catch (err) {
    const e = err as { code?: string; path?: string };
    // Nothing was applied: a usage/validation-class refusal (exit 2), not a fatal error.
    throw new ValidationError(
      `cannot write ${e.path ?? deletedPath} (${e.code ?? errName(err)}) — fix it and re-run; nothing was changed`,
    );
  }
}

/**
 * The --confirm pass: validate the whole file, derive every group from live rows (no writes),
 * preflight the output, back up, then apply.
 */
export async function applyDecisions(
  repo: ApplyRepo,
  tenant: string,
  rawFile: unknown,
  outDir: string,
  log: (line: string) => void = console.log,
  at = new Date().toISOString(),
): Promise<ApplyReport> {
  const file = validateDecisionsFile(rawFile, tenant);
  await assertTenantExists(repo, tenant);
  const report: ApplyReport = {
    merged: [],
    distinct: [],
    skipped: [],
    alreadyDone: [],
    refused: [],
    deleted: [],
    backfilled: [],
    conflicts: [],
    backupPath: null,
    deletedPath: null,
    syncOn: false,
  };
  const clubs = await repo.listClubs(tenant);
  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  const nameOf = (id: string) => clubName.get(id) ?? id;
  const [open, live, distinctLive, config] = await Promise.all([
    loadOpenRecords(
      repo,
      tenant,
      clubs.map((c) => c.id),
    ),
    loadLive(
      repo,
      tenant,
      clubs.map((c) => c.id),
    ),
    repo.listPlayerDistinctPairs(tenant),
    repo.getTenantConfig(tenant),
  ]);
  report.syncOn = playerSyncEnabled(config);
  const rowsOf = (nk: string) => live.rowsByNk.get(nk) ?? [];
  const refuse = (id: string, why: string) => {
    report.refused.push({ id, why });
    log(`  ✗ ${id} refused — ${why}`);
  };

  const deletedPath = path.join(outDir, 'deleted-nks.json');
  const deleted = await readDeleted(deletedPath);
  const isRecorded = (nk: string) =>
    deleted.some((d) => d.tenant === tenant && d.naturalKey === nk);
  const backfill: Array<{ id: string; nk: string; clubIds: string[] }> = [];

  // Pass 1: derive each actionable entry from live state. No writes.
  const prepared: Prepared[] = [];
  for (const entry of file.entries) {
    const action = entry.action;
    if (action === 'skip') {
      report.skipped.push(entry.id);
      continue;
    }
    if (entry.kind === 'same-key-multi-club') {
      refuse(entry.id, 'same-key multi-club entries are listed only, never actioned');
      continue;
    }
    if (entry.status === 'OUT-OF-BAND') {
      refuse(entry.id, 'OUT-OF-BAND — resolve through the clearance flow');
      continue;
    }
    const keys = entry.naturalKeys;
    const liveRows = keys.flatMap(rowsOf);
    const blockers = blockersFor(liveRows, keys, open, nameOf);
    if (blockers.length) {
      refuse(entry.id, `BLOCKED (live): ${blockers.map(maskBlocker).join('; ')}`);
      continue;
    }

    if (action === 'distinct') {
      const missing = pairsOf(keys).filter((p) => !distinctLive.has(p.join('#')));
      if (!missing.length) {
        report.alreadyDone.push(entry.id);
        log(`  = ${entry.id} already confirmed distinct`);
        continue;
      }
      prepared.push({ entry, op: 'distinct', pairs: missing, backupRows: liveRows });
      continue;
    }

    // merge-into:<key> (validated + resolved to a full key of this group)
    const survivorNk = action.slice('merge-into:'.length);
    const staleKeys = keys.filter((k) => k !== survivorNk);
    if (!isShaKey(survivorNk) && keys.some(isShaKey)) {
      refuse(
        entry.id,
        `merge-into ${cut(survivorNk)} is a legacy slug key but the group holds a sha256 key — ` +
          'the canonical direction is into the sha256 row (it carries the ID number); choose merge-into:<sha256 key>',
      );
      continue;
    }
    const marked = pairsOf(keys).filter((p) => distinctLive.has(p.join('#')));
    if (marked.length) {
      refuse(
        entry.id,
        `an admin confirmed ${marked.map(([a, b]) => `${cut(a)} ≠ ${cut(b)}`).join(', ')} are different ` +
          'people (PLAYERDISTINCT) — this merge would combine them; refused regardless of the file',
      );
      continue;
    }
    const people = liveRows.filter((r) => !isPlaceholder(r));
    const nds = new Set(people.map((r) => nameDobKey(r)));
    if (nds.size > 1 || nds.has('')) {
      refuse(
        entry.id,
        'rows no longer share one name + date of birth — a row was edited since the plan, or the file was; re-plan',
      );
      continue;
    }
    const survivorRows = rowsOf(survivorNk).filter((r) => !isPlaceholder(r));
    if (survivorRows.length === 0) {
      refuse(
        entry.id,
        'the survivor row is gone (deleted, moved or re-keyed since the plan); re-plan',
      );
      continue;
    }
    if (survivorRows.length > 1) {
      refuse(
        entry.id,
        `the survivor key has rows at ${survivorRows.length} clubs (${survivorRows.map((r) => nameOf(r.clubId)).join(', ')}) — ` +
          'an OUT-OF-BAND identity; resolve it through the clearance flow first, then re-plan',
      );
      continue;
    }
    // Live re-derivation (both directions): new identities with this name + dob, and rows of
    // the group's keys at clubs the plan did not list. A listed stale row that is simply gone
    // (no row of that key anywhere) is an earlier run's delete, not drift.
    const nd = [...nds][0];
    const extra = [...(live.byNameDob.get(nd) ?? [])].filter((k) => !keys.includes(k));
    if (extra.length) {
      refuse(
        entry.id,
        `${extra.length} identit${extra.length === 1 ? 'y' : 'ies'} with this name + date of birth appeared since the plan (${extra.map(cut).join(', ')}); re-plan`,
      );
      continue;
    }
    const listed = new Set(entry.rows.map((r) => `${r.naturalKey}\u0000${r.clubId}`));
    const unlisted = liveRows.filter((r) => !listed.has(`${r.naturalKey}\u0000${r.clubId}`));
    if (unlisted.length) {
      refuse(
        entry.id,
        `rows appeared since the plan: ${unlisted.map((r) => `${cut(r.naturalKey)} at ${nameOf(r.clubId)}`).join(', ')}; re-plan`,
      );
      continue;
    }
    const stale = staleKeys.flatMap(rowsOf);
    const outOfBand = staleKeys.filter(
      (k) => rowsOf(k).filter((r) => !isPlaceholder(r) && statusOf(r) === 'active').length > 1,
    );
    if (outOfBand.length) {
      refuse(
        entry.id,
        `${outOfBand.map(cut).join(', ')} is active at more than one club — a clearance problem; never deleted here`,
      );
      continue;
    }
    if (!stale.length) {
      report.alreadyDone.push(entry.id);
      log(`  = ${entry.id} already merged (no stale row left)`);
      for (const nk of staleKeys)
        if (!isRecorded(nk))
          backfill.push({
            id: entry.id,
            nk,
            clubIds: [
              ...new Set(entry.rows.filter((r) => r.naturalKey === nk).map((r) => r.clubId)),
            ],
          });
      continue;
    }
    prepared.push({
      entry,
      op: 'merge',
      survivor: survivorRows[0],
      stale,
      backupRows: liveRows,
    });
  }

  if (!prepared.length && !backfill.length) {
    log('Nothing to apply.');
    return report;
  }

  // Preflight BEFORE any write: a run that cannot record what it deletes must not start.
  await preflightWritable(outDir, deletedPath);
  report.deletedPath = deletedPath;
  const persistDeleted = () => writePrivate(deletedPath, JSON.stringify(deleted, null, 2));
  /** Returns an undo for a write-ahead record whose delete then failed. */
  const recordDeleted = async (nk: string, clubIds: string[]) => {
    let hit = deleted.find((d) => d.tenant === tenant && d.naturalKey === nk);
    const created = !hit;
    const added: string[] = [];
    if (!hit) {
      hit = { tenant, naturalKey: nk, clubIds: [] };
      deleted.push(hit);
    }
    for (const c of clubIds)
      if (!hit.clubIds.includes(c)) {
        hit.clubIds.push(c);
        added.push(c);
      }
    // A key deleted again after a tombstone (re-registered, merged again) needs a new one.
    const tombstonedAt = hit.tombstonedAt;
    delete hit.tombstonedAt;
    await persistDeleted();
    return async () => {
      if (created) deleted.splice(deleted.indexOf(hit), 1);
      else {
        hit.clubIds = hit.clubIds.filter((c) => !added.includes(c));
        if (tombstonedAt) hit.tombstonedAt = tombstonedAt;
      }
      await persistDeleted();
    };
  };

  for (const b of backfill) {
    await recordDeleted(b.nk, b.clubIds);
    report.backfilled.push(b.nk);
    log(
      `  + ${b.id} recorded ${cut(b.nk)} in deleted-nks.json (deleted by an earlier run; record was missing)`,
    );
  }
  if (!prepared.length) return report;

  // Backup of every row of every group about to be touched — BEFORE any table write.
  const backupPath = path.join(outDir, `backup-${at.replace(/[:.]/g, '-')}.json`);
  await writePrivate(
    backupPath,
    JSON.stringify(
      {
        tenant,
        at,
        groups: prepared.map((p) => ({
          id: p.entry.id,
          action: p.entry.action,
          rows: p.backupRows,
        })),
      },
      null,
      2,
    ),
  );
  report.backupPath = backupPath;
  log(`Backup written: ${backupPath}`);

  // Pass 2: apply.
  const total = prepared.length;
  let n = 0;
  for (const p of prepared) {
    const tag = `[${++n}/${total}] ${p.entry.id}`;
    if (p.op === 'distinct') {
      for (const [a, b] of p.pairs!) await repo.putPlayerDistinct(tenant, a, b);
      report.distinct.push(p.entry.id);
      log(`  ✓ ${tag} confirmed distinct (${p.pairs!.length} new pair(s))`);
      continue;
    }

    const survivor = p.survivor!;
    const stale = p.stale!;
    const conflict = (field: string, kept: string, dropped: string) => {
      report.conflicts.push({ id: p.entry.id, field, kept, dropped });
      log(`    conflict ${p.entry.id} ${field}: kept ${kept}, dropped ${dropped}`);
    };

    // Field fill: the survivor's non-empty values always win; first stale row with a value fills.
    const patch: Partial<PlayerRegistration> = {};
    const filled: string[] = [];
    for (const field of FILL_FIELDS) {
      const own = survivor[field];
      if (!isEmptyField(field, own)) {
        for (const s of stale)
          if (!isEmptyField(field, s[field]) && JSON.stringify(s[field]) !== JSON.stringify(own))
            conflict(
              field,
              show(field, own),
              `${show(field, s[field])} (from ${cut(s.naturalKey)})`,
            );
        continue;
      }
      const from = stale.find((s) => !isEmptyField(field, s[field]));
      if (!from) continue;
      (patch as Record<string, unknown>)[field] = from[field];
      filled.push(field);
      for (const s of stale)
        if (
          s !== from &&
          !isEmptyField(field, s[field]) &&
          JSON.stringify(s[field]) !== JSON.stringify(from[field])
        )
          conflict(
            field,
            show(field, from[field]),
            `${show(field, s[field])} (from ${cut(s.naturalKey)})`,
          );
    }
    // ID documents: carry when the survivor has none, so the person's only document survives.
    const carried = new Set<string>();
    for (const field of ['idDocMeta', 'previousIdDocMeta'] as const) {
      if (survivor[field]?.objectKey) {
        for (const s of stale)
          if (s[field]?.objectKey && s[field]!.objectKey !== survivor[field]!.objectKey)
            conflict(
              field,
              "the survivor's own document",
              `the document of ${cut(s.naturalKey)} (deleted)`,
            );
        continue;
      }
      const from = stale.find((s) => s[field]?.objectKey);
      if (!from) continue;
      patch[field] = from[field];
      carried.add(from[field]!.objectKey);
      filled.push(field);
    }
    if (filled.length) {
      try {
        await repo.updatePlayer(tenant, survivor.clubId, survivor.naturalKey, {
          ...patch,
          version: survivor.version ?? 0,
        });
      } catch (err) {
        refuse(p.entry.id, `survivor fill failed (${errName(err)}) — nothing deleted; re-plan`);
        continue;
      }
    }
    // Veterans affiliation: through the veterans path so VETAFFIL ⇔ active row holds.
    const vetName = (id: string) => clubName.get(id) ?? id;
    if (survivor.veteransClubId) {
      for (const s of stale)
        if (s.veteransClubId && s.veteransClubId !== survivor.veteransClubId)
          conflict(
            'veterans club',
            vetName(survivor.veteransClubId),
            `${vetName(s.veteransClubId)} (its VETAFFIL record goes with ${cut(s.naturalKey)})`,
          );
    } else {
      const from = stale.find((s) => s.veteransClubId);
      const vetId = from?.veteransClubId;
      if (vetId && vetId !== survivor.clubId && clubName.has(vetId)) {
        try {
          await repo.setPlayerVeteransClub(
            tenant,
            survivor.clubId,
            survivor.naturalKey,
            { id: vetId, name: clubName.get(vetId)! },
            'admin',
          );
          filled.push('veteransClubId');
        } catch (err) {
          refuse(p.entry.id, `veterans fill failed (${errName(err)}) — nothing deleted; re-run`);
          continue;
        }
        for (const s of stale)
          if (s !== from && s.veteransClubId && s.veteransClubId !== vetId)
            conflict('veterans club', vetName(vetId), vetName(s.veteransClubId));
      } else if (vetId) {
        conflict(
          'veterans club',
          '(none)',
          `${vetName(vetId)} — not carried (the survivor's own club, or not on the system)`,
        );
      }
    }

    // Delete the stale rows (+ certificates only when opted in). Any object the survivor
    // references after the fill — carried now, carried by an earlier partial run, or simply
    // shared with the stale row — must survive the stale row's delete.
    const survivorRefs = new Set(
      [
        (patch.idDocMeta ?? survivor.idDocMeta)?.objectKey,
        (patch.previousIdDocMeta ?? survivor.previousIdDocMeta)?.objectKey,
      ].filter((k): k is string => !!k),
    );
    const kept = (k: string) => carried.has(k) || survivorRefs.has(k);
    let deletedRows = 0;
    let failed = false;
    for (const s of stale) {
      const docKeys = [s.idDocMeta?.objectKey, s.previousIdDocMeta?.objectKey].filter(
        (k): k is string => !!k,
      );
      const keepDocs = docKeys.some(kept);
      // Write-ahead: the key is on disk (fsynced) before its row can disappear.
      const undo = await recordDeleted(s.naturalKey, [s.clubId]);
      try {
        await repo.deletePlayer(tenant, s, keepDocs ? { keepDocs: true } : {});
      } catch (err) {
        // The row is still there: take the record back so the file only lists real deletes.
        if (await repo.getPlayer(tenant, s.clubId, s.naturalKey).catch(() => null)) await undo();
        refuse(
          p.entry.id,
          `delete of ${cut(s.naturalKey)} at ${nameOf(s.clubId)} failed (${errName(err)}) — mid-transfer or gone`,
        );
        failed = true;
        continue;
      }
      // keepDocs keeps every object of the row; drop the ones the survivor does NOT reference.
      if (keepDocs) {
        const orphaned = docKeys.filter((k) => !kept(k));
        if (orphaned.length) await repo.deleteUploadObjects(orphaned);
      }
      report.deleted.push({ tenant, naturalKey: s.naturalKey, clubIds: [s.clubId] });
      deletedRows++;
      if (p.entry.purgeCertificates === true) {
        const purged = await purgePlayerCertificates(repo, tenant, s.clubId, s.naturalKey);
        log(`    ${p.entry.id}: purged ${purged} certificate(s) of ${cut(s.naturalKey)}`);
      }
    }
    const summary = `filled [${filled.join(', ') || 'nothing'}], deleted ${deletedRows} of ${stale.length} stale row(s)`;
    if (failed) {
      log(`  ! ${tag} PARTIALLY applied into ${cut(survivor.naturalKey)} — ${summary}; re-run`);
      continue;
    }
    report.merged.push(p.entry.id);
    log(`  ✓ ${tag} merged into ${cut(survivor.naturalKey)} — ${summary}`);
  }
  return report;
}

function maskBlocker(b: string): string {
  return b.replace(/PLAYER#([^ ]+)/, (_m, k: string) => `PLAYER#${cut(k)}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repo = await import('./repo.js');
  if (args.mode === 'plan') {
    const file = await runPlan(repo, args.tenant, args.out, undefined, { force: !!args.force });
    console.log(`\nresolve-duplicate-players — ${args.tenant} (plan, read-only)`);
    if (!file.entries.length) {
      console.log('No duplicates found. Nothing to decide.');
      return;
    }
    const counts = new Map<string, number>();
    for (const e of file.entries) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
    for (const [s, n] of counts) console.log(`  ${s.padEnd(14)} ${n}`);
    console.log(`\nWrote ${path.join(args.out, 'decisions.json')} (mode 600, full keys)`);
    console.log(`      ${path.join(args.out, 'decisions-review.md')} (masked)`);
    console.log('Edit decisions.json, then re-run with --confirm --decisions <file>.');
    return;
  }
  const raw = await readJsonInput(args.decisions!);
  console.log(`\nresolve-duplicate-players — ${args.tenant} (CONFIRM)`);
  const report = await applyDecisions(repo, args.tenant, raw, args.out);
  console.log(
    `\nmerged ${report.merged.length}, distinct ${report.distinct.length}, skipped ${report.skipped.length}, ` +
      `already done ${report.alreadyDone.length}, refused ${report.refused.length}, rows deleted ${report.deleted.length}`,
  );
  if (report.refused.length) {
    console.log('\nRefused (nothing changed for these unless marked PARTIALLY above):');
    for (const r of report.refused) console.log(`  ${r.id} — ${r.why}`);
  }
  if (report.conflicts.length) {
    console.log('\nDropped values (the survivor kept its own; the stale value is in the backup):');
    for (const c of report.conflicts)
      console.log(`  ${c.id} ${c.field}: kept ${c.kept}, dropped ${c.dropped}`);
  }
  if (report.deleted.length || report.backfilled.length) {
    const del = report.deletedPath ?? path.join(args.out, 'deleted-nks.json');
    console.log(`\nDeleted keys recorded in ${del}`);
    console.log(
      `Next: once the player sync is on, run tombstone-deleted-players --tenant ${args.tenant} --deleted ${del}` +
        ' (dry run first, then --confirm) to dispose of their medicoach refs.',
    );
    if (report.syncOn)
      console.log(
        'The player sync is ON: these deletes queued ordinary change rows; tombstone-deleted-players --confirm ' +
          'replaces them with erase tombstones — run it now.',
      );
  }
  if (report.backupPath)
    console.log(
      '\nPII: the backup, decisions.json and deleted-nks.json hold full keys and ID numbers (mode 600). ' +
        'Delete the backup once the merges are verified; keep deleted-nks.json until it is tombstoned.',
    );
  if (report.refused.length) {
    console.log('\nRESULT: partial — one or more entries were refused (exit 4).');
    process.exitCode = EXIT.partial;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    if (err instanceof HelpRequested) {
      console.log(err.usage);
      process.exit(EXIT.ok);
    }
    console.error(err instanceof Error ? err.message : err);
    process.exit(exitCodeFor(err));
  });
}
