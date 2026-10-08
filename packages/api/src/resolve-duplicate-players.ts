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
 * spanning clubs, or without exactly one sha256 key, is NEEDS-CHOICE (no default). A row that
 * is clearance-pending, or a key named by an open clearance (canonical or inbound mirror), open
 * registration review or pending veterans request, is BLOCKED. `docOnlyOnStale` flags a
 * survivor with no ID document where a stale row holds one. `purgeCertificates` defaults false.
 * Actions: `merge-into:<survivorNk>` | `distinct` | `skip`.
 *
 * CONFIRM (per merge-into): JSON backup of every row first; field-fill the survivor (its own
 * non-empty values always win) via updatePlayer, `veteransClubId` via setPlayerVeteransClub (so
 * the VETAFFIL record follows the write-on-activation invariant); carry the stale row's ID
 * document(s) when the survivor has none and delete that row with `keepDocs` so the carried S3
 * objects survive; purge certificates only when opted in; append each deleted key to
 * deleted-nks.json (input for tombstone-deleted-players). `distinct` → putPlayerDistinct.
 * Blocks are re-checked against live state and refused, never forced. Re-running skips what is
 * already done. NEVER uses erasePlayerData (its name/email/cell scrub would hit the survivor).
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { duplicateKeyGroups } from './medicoach-sync/audit-player-duplicates.js';
import { distinctPair, nameDobKey } from './medicoach-sync/player-placement.js';
import { loadPlayerSyncSnapshot, type PlayerSyncSnapshot } from './medicoach-sync/players.js';
import { purgePlayerCertificates } from './player-certificate-purge.js';
import type { PlayerRegistration } from './types.js';

type RepoModule = typeof import('./repo.js');

const USAGE =
  'usage: resolve-duplicate-players --tenant <t> --out <dir> [--plan | --confirm --decisions <file>]';

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n${USAGE}`);
    this.name = 'UsageError';
  }
}

export interface Args {
  tenant: string;
  out: string;
  mode: 'plan' | 'confirm';
  decisions?: string;
}

export function parseArgs(argv: string[]): Args {
  let tenant: string | undefined;
  let out: string | undefined;
  let decisions: string | undefined;
  let plan = false;
  let confirm = false;
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (!v || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--tenant') tenant = value(++i, flag);
    else if (flag === '--out') out = value(++i, flag);
    else if (flag === '--decisions') decisions = value(++i, flag);
    else if (flag === '--plan') plan = true;
    else if (flag === '--confirm') confirm = true;
    else throw new UsageError(`unknown argument: ${flag}`);
  }
  if (!tenant) throw new UsageError('--tenant is required');
  if (!out) throw new UsageError('--out is required');
  if (plan && confirm) throw new UsageError('--plan and --confirm are exclusive');
  if (confirm && !decisions) throw new UsageError('--confirm needs --decisions <file>');
  if (!confirm && decisions) throw new UsageError('--decisions is only read with --confirm');
  return { tenant, out, mode: confirm ? 'confirm' : 'plan', ...(decisions ? { decisions } : {}) };
}

// ── Decisions file ──

export type EntryStatus =
  | 'PROPOSED'
  | 'NEEDS-CHOICE'
  | 'BLOCKED'
  | 'OUT-OF-BAND'
  | 'SETTLED'
  | 'INFO';

export interface RowSummary {
  naturalKey: string;
  clubId: string;
  club: string;
  status: string;
  placeholder: boolean;
  idKind: string;
  hasIdDoc: boolean;
  keyKind: 'sha256' | 'legacy-slug';
}

export interface DecisionEntry {
  id: string;
  kind: 'name-dob-group' | 'same-key-multi-club';
  status: EntryStatus;
  reason: string;
  naturalKeys: string[];
  rows: RowSummary[];
  /** The proposed survivor (PROPOSED only) — informational; `action` is what runs. */
  survivor: string | null;
  docOnlyOnStale: boolean;
  /** User-editable: purge the deleted rows' transfer certificates (default false). */
  purgeCertificates: boolean;
  blockedBy: string[];
  /** User-editable: `merge-into:<survivorNk>` | `distinct` | `skip`. */
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
}

export const isShaKey = (nk: string): boolean => /^[0-9a-f]{64}$/.test(nk);
/**
 * A key as printed to the terminal / review md: a sha256 key's first 8 chars; a legacy slug key
 * (which can embed a name, dob or plaintext ID) is hashed first, so no fragment of it is shown.
 * decisions.json alone carries full keys.
 */
const cut = (nk: string): string =>
  `${(isShaKey(nk) ? nk : createHash('sha256').update(nk).digest('hex')).slice(0, 8)}…`;
const statusOf = (r: Pick<PlayerRegistration, 'status'>): string => r.status ?? 'active';

function idKindOf(r: PlayerRegistration): string {
  if (!String(r.idNumber ?? '').trim()) return 'none';
  return r.idType ?? 'sa-id';
}

/** Non-empty own fields — the "richer row" tie-break. */
function richness(r: PlayerRegistration): number {
  return Object.values(r).filter((v) => v !== undefined && v !== null && v !== '').length;
}

function summarise(snap: PlayerSyncSnapshot, r: PlayerRegistration): RowSummary {
  return {
    naturalKey: r.naturalKey,
    clubId: r.clubId,
    club: snap.clubsById.get(r.clubId)?.name ?? r.clubId,
    status: statusOf(r),
    placeholder: r.placeholder === true,
    idKind: idKindOf(r),
    hasIdDoc: !!r.idDocMeta?.objectKey,
    keyKind: isShaKey(r.naturalKey) ? 'sha256' : 'legacy-slug',
  };
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
  const [clearances, reviews, vetreqs] = await Promise.all([
    repo.listAllClearances(tenant),
    repo.listAllReviews(tenant),
    repo.listAllVeteransRequests(tenant),
  ]);
  const seen = new Set<string>();
  for (const c of clearances)
    if (c.status === 'pending') {
      seen.add(c.id);
      add(c.playerNaturalKey, `CLEARANCE#${c.id}`);
    }
  for (const clubId of clubIds)
    for (const c of await repo.listInboundForDest(tenant, clubId))
      if (c.status === 'pending' && !seen.has(c.id))
        add(c.playerNaturalKey, `INBOUND_CLEARANCE#${c.id}`);
  for (const r of reviews) if (r.status === 'open') add(r.playerNaturalKey, `REGREVIEW#${r.id}`);
  for (const v of vetreqs) if (v.status === 'pending') add(v.playerNaturalKey, `VETREQ#${v.id}`);
  return open;
}

/** Live blockers for a set of rows + keys: clearance-pending rows and open records. */
function blockersFor(
  rows: Array<Pick<PlayerRegistration, 'naturalKey' | 'clubId' | 'status'>>,
  keys: string[],
  open: OpenRecords,
): string[] {
  const out: string[] = [];
  for (const r of rows)
    if (r.status === 'clearance-pending')
      out.push(`PLAYER#${r.naturalKey} at ${r.clubId} is clearance-pending`);
  for (const nk of keys) for (const what of open.get(nk) ?? []) out.push(what);
  return out;
}

// ── Plan ──

/** Survivor ranking: sha256 key, then an active row, then the richer row, then key order. */
function rankKeys(snap: PlayerSyncSnapshot, keys: string[]): string[] {
  const score = (nk: string) => {
    const rows = snap.rowsByNk.get(nk) ?? [];
    return {
      sha: isShaKey(nk) ? 1 : 0,
      active: rows.some((r) => statusOf(r) === 'active') ? 1 : 0,
      rich: Math.max(0, ...rows.map(richness)),
    };
  };
  return [...keys].sort((a, b) => {
    const x = score(a);
    const y = score(b);
    return y.sha - x.sha || y.active - x.active || y.rich - x.rich || a.localeCompare(b);
  });
}

export function buildDecisions(
  snap: PlayerSyncSnapshot,
  open: OpenRecords,
  tenant: string,
  at: string,
): DecisionsFile {
  const entries: DecisionEntry[] = [];
  let g = 0;
  for (const group of duplicateKeyGroups(snap)) {
    const rows = group.keys.flatMap((nk) => snap.rowsByNk.get(nk) ?? []);
    const blockedBy = blockersFor(rows, group.keys, open);
    const clubs = new Set(rows.map((r) => r.clubId));
    const shaKeys = group.keys.filter(isShaKey);
    let status: EntryStatus;
    let reason: string;
    let survivor: string | null = null;
    if (group.allConfirmedDistinct) {
      status = 'SETTLED';
      reason = 'every pair already confirmed distinct by an admin';
    } else if (blockedBy.length) {
      status = 'BLOCKED';
      reason = 'settle the open record(s) first, then re-plan';
    } else if (clubs.size > 1) {
      status = 'NEEDS-CHOICE';
      reason =
        'rows span clubs — a sporting decision: set action to merge-into:<nk> of the club that keeps the player';
    } else if (shaKeys.length !== 1) {
      status = 'NEEDS-CHOICE';
      reason = `${shaKeys.length} sha256 keys in the group — which ID is correct is a human call`;
    } else {
      status = 'PROPOSED';
      reason = 'same club; sha256-keyed row survives, legacy slug row(s) merged into it';
      survivor = rankKeys(snap, group.keys)[0];
    }
    const survivorRows = survivor ? (snap.rowsByNk.get(survivor) ?? []) : [];
    const staleRows = survivor ? rows.filter((r) => r.naturalKey !== survivor) : [];
    entries.push({
      id: `G${String(++g).padStart(2, '0')}`,
      kind: 'name-dob-group',
      status,
      reason,
      naturalKeys: group.keys,
      rows: rows.map((r) => summarise(snap, r)),
      survivor,
      docOnlyOnStale:
        !!survivor &&
        !survivorRows.some((r) => r.idDocMeta?.objectKey) &&
        staleRows.some((r) => r.idDocMeta?.objectKey),
      purgeCertificates: false,
      blockedBy,
      action: survivor ? `merge-into:${survivor}` : 'skip',
    });
  }

  let k = 0;
  for (const nk of [...snap.rowsByNk.keys()].sort()) {
    const rows = snap.rowsByNk.get(nk) ?? [];
    if (new Set(rows.map((r) => r.clubId)).size < 2) continue;
    const blockedBy = blockersFor(rows, [nk], open);
    const active = rows.filter((r) => statusOf(r) === 'active' && r.placeholder !== true).length;
    const status: EntryStatus = active >= 2 ? 'OUT-OF-BAND' : blockedBy.length ? 'BLOCKED' : 'INFO';
    entries.push({
      id: `K${String(++k).padStart(2, '0')}`,
      kind: 'same-key-multi-club',
      status,
      reason:
        status === 'OUT-OF-BAND'
          ? 'one identity active at two clubs — resolve through the clearance flow, never here'
          : 'one identity rostered at several clubs (listed only; never actioned here)',
      naturalKeys: [nk],
      rows: rows.map((r) => summarise(snap, r)),
      survivor: null,
      docOnlyOnStale: false,
      purgeCertificates: false,
      blockedBy,
      action: 'skip',
    });
  }
  return { tenant, generatedAt: at, entries };
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

/** The masked review: initials + birth year, keys cut to 8 chars, no ID numbers. */
export function renderReview(file: DecisionsFile, snap: PlayerSyncSnapshot): string {
  const lines: string[] = [
    `# Duplicate players — ${file.tenant} (${file.generatedAt})`,
    '',
    'Edit `decisions.json` (same folder), not this file. Per entry set `action` to',
    '`merge-into:<full survivor key>`, `distinct` or `skip`, and `purgeCertificates` to true only',
    'to destroy the merged-away rows’ transfer certificates. BLOCKED / OUT-OF-BAND / same-key',
    'entries are never actioned; settle them and re-plan.',
    '',
  ];
  const counts = new Map<string, number>();
  for (const e of file.entries) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  lines.push(
    `Entries: ${file.entries.length} — ${[...counts].map(([s, n]) => `${s} ${n}`).join(', ')}`,
    '',
  );
  for (const e of file.entries) {
    const first = snap.rowsByNk.get(e.naturalKeys[0])?.[0];
    const who = `${initials(first)} (${String(first?.dob ?? '').slice(0, 4) || '????'})`;
    lines.push(`## ${e.id} · ${e.status} · ${who}`);
    lines.push(`- kind: ${e.kind}`);
    lines.push(`- ${e.reason}`);
    const action = e.action.startsWith('merge-into:')
      ? `merge-into:${cut(e.action.slice('merge-into:'.length))}`
      : e.action;
    lines.push(`- proposed action: \`${action}\``);
    if (e.docOnlyOnStale) lines.push('- **DOC-ONLY-ON-STALE**: the ID document is carried over');
    if (e.blockedBy.length) lines.push(`- blocked by: ${e.blockedBy.map(maskBlocker).join('; ')}`);
    lines.push('', '| key | kind | club | status | placeholder | id | id doc |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const r of e.rows)
      lines.push(
        `| ${cut(r.naturalKey)}${r.naturalKey === e.survivor ? ' (survivor)' : ''} | ${r.keyKind} | ${r.club} | ${r.status} | ${r.placeholder ? 'yes' : ''} | ${r.idKind} | ${r.hasIdDoc ? 'yes' : ''} |`,
      );
    lines.push('');
  }
  return lines.join('\n');
}

type PlanRepo = Parameters<typeof loadPlayerSyncSnapshot>[0] & OpenRecordsRepo;

/** The --plan pass. Takes a READ-ONLY repo surface: the type itself admits no write. */
export async function runPlan(
  repo: PlanRepo,
  tenant: string,
  outDir: string,
  at = new Date().toISOString(),
): Promise<DecisionsFile> {
  const snap = await loadPlayerSyncSnapshot(repo, tenant);
  const open = await loadOpenRecords(repo, tenant, [...snap.clubsById.keys()]);
  const file = buildDecisions(snap, open, tenant, at);
  await mkdir(outDir, { recursive: true });
  await writePrivate(path.join(outDir, 'decisions.json'), JSON.stringify(file, null, 2));
  await writePrivate(path.join(outDir, 'decisions-review.md'), renderReview(file, snap));
  return file;
}

async function writePrivate(file: string, body: string): Promise<void> {
  await writeFile(file, body, { mode: 0o600 });
  await chmod(file, 0o600); // an existing file keeps its old mode on overwrite
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

function isEmptyField(field: string, v: unknown): boolean {
  if (v === undefined || v === null) return true;
  // bowlerType '' is a real value ("not a bowler"), so only absence counts as empty there.
  return field !== 'bowlerType' && v === '';
}

type ApplyRepo = Pick<
  RepoModule,
  | 'getPlayer'
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

export interface ApplyReport {
  merged: string[];
  distinct: string[];
  skipped: string[];
  alreadyDone: string[];
  refused: Array<{ id: string; why: string }>;
  deleted: DeletedNk[];
  backupPath: string | null;
}

interface Prepared {
  entry: DecisionEntry;
  op: 'merge' | 'distinct';
  survivorNk?: string;
  live: Array<{ summary: RowSummary; row: PlayerRegistration | null }>;
}

const errName = (err: unknown) => (err as { name?: string })?.name ?? 'error';

/** The --confirm pass: validate everything (no writes), back up, then apply. */
export async function applyDecisions(
  repo: ApplyRepo,
  tenant: string,
  file: DecisionsFile,
  outDir: string,
  log: (line: string) => void = console.log,
  at = new Date().toISOString(),
): Promise<ApplyReport> {
  if (file.tenant !== tenant)
    throw new Error(`decisions file is for tenant "${file.tenant}", not "${tenant}"`);
  const report: ApplyReport = {
    merged: [],
    distinct: [],
    skipped: [],
    alreadyDone: [],
    refused: [],
    deleted: [],
    backupPath: null,
  };
  const clubs = await repo.listClubs(tenant);
  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  const open = await loadOpenRecords(
    repo,
    tenant,
    clubs.map((c) => c.id),
  );
  const refuse = (id: string, why: string) => {
    report.refused.push({ id, why });
    log(`  ✗ ${id} refused — ${why}`);
  };

  // Pass 1: validate + read live rows. No writes.
  const prepared: Prepared[] = [];
  for (const entry of file.entries) {
    const action = String(entry.action ?? '').trim();
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
    let op: Prepared['op'];
    let survivorNk: string | undefined;
    if (action === 'distinct') op = 'distinct';
    else if (action.startsWith('merge-into:')) {
      op = 'merge';
      survivorNk = action.slice('merge-into:'.length);
      if (!entry.naturalKeys.includes(survivorNk)) {
        refuse(entry.id, 'merge-into names a key that is not in this group');
        continue;
      }
    } else {
      refuse(entry.id, `unknown action "${action}"`);
      continue;
    }
    const live = await Promise.all(
      entry.rows.map(async (summary) => ({
        summary,
        row: await repo.getPlayer(tenant, summary.clubId, summary.naturalKey),
      })),
    );
    const liveRows = live.flatMap((l) => (l.row ? [l.row] : []));
    const blockers = blockersFor(liveRows, entry.naturalKeys, open);
    if (blockers.length) {
      refuse(entry.id, `BLOCKED (live): ${blockers.map(maskBlocker).join('; ')}`);
      continue;
    }
    if (op === 'merge') {
      // Only `action` / `purgeCertificates` are meant to be edited: every live row of a merge
      // group must still carry the one name + dob that defined it, so a key spliced into the
      // file can never send an unrelated person's row to the delete below.
      const keys = new Set(liveRows.map((r) => nameDobKey(r)));
      if (keys.size !== 1 || keys.has('')) {
        refuse(
          entry.id,
          'rows no longer share one name + date of birth — the file was edited; re-plan',
        );
        continue;
      }
      const survivors = live.filter((l) => l.summary.naturalKey === survivorNk && l.row);
      if (survivors.length !== 1) {
        refuse(entry.id, `the survivor has ${survivors.length} live row(s); need exactly 1`);
        continue;
      }
      if (!live.some((l) => l.summary.naturalKey !== survivorNk && l.row)) {
        report.alreadyDone.push(entry.id);
        log(`  = ${entry.id} already merged (no stale row left)`);
        continue;
      }
    }
    prepared.push({ entry, op, survivorNk, live });
  }

  if (!prepared.length) {
    log('Nothing to apply.');
    return report;
  }

  // Backup of every row of every group about to be touched — BEFORE any write.
  await mkdir(outDir, { recursive: true });
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
          rows: p.live.flatMap((l) => (l.row ? [l.row] : [])),
        })),
      },
      null,
      2,
    ),
  );
  report.backupPath = backupPath;
  log(`Backup written: ${backupPath}`);

  const deletedPath = path.join(outDir, 'deleted-nks.json');
  const deleted = await readDeleted(deletedPath);
  const recordDeleted = async (nk: string, clubId: string) => {
    const hit = deleted.find((d) => d.tenant === tenant && d.naturalKey === nk);
    if (hit) {
      if (!hit.clubIds.includes(clubId)) hit.clubIds.push(clubId);
    } else deleted.push({ tenant, naturalKey: nk, clubIds: [clubId] });
    await writePrivate(deletedPath, JSON.stringify(deleted, null, 2));
  };

  // Pass 2: apply.
  for (const p of prepared) {
    if (p.op === 'distinct') {
      const keys = p.entry.naturalKeys;
      for (let i = 0; i < keys.length; i++)
        for (let j = i + 1; j < keys.length; j++) {
          const [a, b] = distinctPair(keys[i], keys[j]);
          await repo.putPlayerDistinct(tenant, a, b);
        }
      report.distinct.push(p.entry.id);
      log(`  ✓ ${p.entry.id} confirmed distinct (${keys.length} keys)`);
      continue;
    }

    const survivor = p.live.find((l) => l.summary.naturalKey === p.survivorNk && l.row)!.row!;
    const stale = p.live
      .filter((l) => l.summary.naturalKey !== p.survivorNk && l.row)
      .map((l) => l.row!);

    // Field fill: the survivor's non-empty values always win; first stale row with a value fills.
    const patch: Partial<PlayerRegistration> = {};
    const filled: string[] = [];
    for (const field of FILL_FIELDS) {
      if (!isEmptyField(field, survivor[field])) continue;
      const from = stale.find((s) => !isEmptyField(field, s[field]));
      if (!from) continue;
      (patch as Record<string, unknown>)[field] = from[field];
      filled.push(field);
    }
    // ID documents: carry when the survivor has none, so the person's only document survives.
    const carried = new Set<string>();
    for (const field of ['idDocMeta', 'previousIdDocMeta'] as const) {
      if (survivor[field]?.objectKey) continue;
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
    if (!survivor.veteransClubId) {
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
      } else if (vetId) {
        log(`    note ${p.entry.id}: stale veterans club not carried (own club or not on system)`);
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
      try {
        await repo.deletePlayer(tenant, s, keepDocs ? { keepDocs: true } : {});
      } catch (err) {
        refuse(
          p.entry.id,
          `delete of ${cut(s.naturalKey)} at ${s.clubId} failed (${errName(err)}) — mid-transfer or gone`,
        );
        failed = true;
        continue;
      }
      // keepDocs keeps every object of the row; drop the ones the survivor does NOT reference.
      if (keepDocs) {
        const orphaned = docKeys.filter((k) => !kept(k));
        if (orphaned.length) await repo.deleteUploadObjects(orphaned);
      }
      await recordDeleted(s.naturalKey, s.clubId);
      report.deleted.push({ tenant, naturalKey: s.naturalKey, clubIds: [s.clubId] });
      deletedRows++;
      if (p.entry.purgeCertificates === true) {
        const n = await purgePlayerCertificates(repo, tenant, s.clubId, s.naturalKey);
        log(`    ${p.entry.id}: purged ${n} certificate(s) of ${cut(s.naturalKey)}`);
      }
    }
    const summary = `filled [${filled.join(', ') || 'nothing'}], deleted ${deletedRows} of ${stale.length} stale row(s)`;
    if (failed) {
      log(
        `  ! ${p.entry.id} PARTIALLY applied into ${cut(survivor.naturalKey)} — ${summary}; re-run`,
      );
      continue;
    }
    report.merged.push(p.entry.id);
    log(`  ✓ ${p.entry.id} merged into ${cut(survivor.naturalKey)} — ${summary}`);
  }
  return report;
}

function maskBlocker(b: string): string {
  return b.replace(/PLAYER#([^ ]+)/, (_m, k: string) => `PLAYER#${cut(k)}`);
}

async function readDeleted(file: string): Promise<DeletedNk[]> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as DeletedNk[];
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return [];
    throw err;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repo = await import('./repo.js');
  if (args.mode === 'plan') {
    const file = await runPlan(repo, args.tenant, args.out);
    const counts = new Map<string, number>();
    for (const e of file.entries) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
    console.log(`\nresolve-duplicate-players — ${args.tenant} (plan, read-only)`);
    for (const [s, n] of counts) console.log(`  ${s.padEnd(14)} ${n}`);
    console.log(`\nWrote ${path.join(args.out, 'decisions.json')} (mode 600, full keys)`);
    console.log(`      ${path.join(args.out, 'decisions-review.md')} (masked)`);
    console.log('Edit decisions.json, then re-run with --confirm --decisions <file>.');
    return;
  }
  const file = JSON.parse(await readFile(args.decisions!, 'utf8')) as DecisionsFile;
  console.log(`\nresolve-duplicate-players — ${args.tenant} (CONFIRM)`);
  const report = await applyDecisions(repo, args.tenant, file, args.out);
  console.log(
    `\nmerged ${report.merged.length}, distinct ${report.distinct.length}, skipped ${report.skipped.length}, ` +
      `already done ${report.alreadyDone.length}, refused ${report.refused.length}, rows deleted ${report.deleted.length}`,
  );
  if (report.deleted.length)
    console.log(`Deleted keys appended to ${path.join(args.out, 'deleted-nks.json')}`);
  if (report.refused.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}
