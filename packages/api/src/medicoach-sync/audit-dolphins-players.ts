/**
 * Read-only smart-club side of the dolphins duplicate-player / medicoach coverage audit
 * (ADR 0019 player sync). Two files land in `--out <dir>`:
 *
 *   sc-audit-report.md                 masked, human-readable (initials + birth year, natural
 *                                      keys cut to 8 chars, never an ID number)
 *   smartclub-<tenant>-players.json    the machine export the medicoach-side coverage script
 *                                      reads: one entry per PERSON with the sync's own intent
 *                                      (`intentOf`, never a reimplementation of placement)
 *
 *   npx sst shell --stage dev -- npm --prefix packages/api run audit-dolphins-players -- \
 *     --tenant dolphins --out ~/audits/dolphins-2026-10
 *
 * Writes NOTHING to DynamoDB: per-club player Queries via `loadPlayerSyncSnapshot` (the
 * sibling audit's read path) plus the two SYNC-partition Queries. The JSON export carries
 * full natural keys (unsalted ID hashes) and refs: keep it local, delete it after the audit.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { refs } from '../medicoach-bundle.js';
import { normalizeId } from '../player-identity.js';
import type {
  PendingPlayerSync,
  PlayerRegistration,
  PlayerSyncReview,
  TenantConfig,
} from '../types.js';
import { nameDobKey, playerSyncEnabled } from './player-placement.js';
import { intentOf, loadPlayerSyncSnapshot, type PlayerSyncSnapshot } from './players.js';

const USAGE = 'usage: audit-dolphins-players --tenant <t> --out <dir>';

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n${USAGE}`);
    this.name = 'UsageError';
  }
}

export function parseArgs(argv: string[]): { tenant: string; out: string } {
  let tenant: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    if (flag === '--tenant') tenant = value();
    else if (flag === '--out') out = value();
    else throw new UsageError(`unknown argument: ${flag}`);
  }
  if (!tenant) throw new UsageError('--tenant is required');
  if (!out) throw new UsageError('--out is required');
  return { tenant, out };
}

/**
 * Stage from `SST_STAGE`, else `SST_RESOURCE_App`'s `stage` (what `sst shell` injects — the
 * import-titans-compliance.ts resolver). `'unknown'` outside sst shell. Pure over `env`.
 */
export function resolveStage(env: NodeJS.ProcessEnv = process.env): string {
  let stage = env.SST_STAGE?.trim();
  if (!stage && env.SST_RESOURCE_App) {
    try {
      const app = JSON.parse(env.SST_RESOURCE_App) as { stage?: unknown };
      if (typeof app.stage === 'string') stage = app.stage.trim();
    } catch {
      throw new Error('SST_RESOURCE_App is set but is not valid JSON — cannot resolve the stage');
    }
  }
  return stage || 'unknown';
}

/* ─────────────────────────── Masking ─────────────────────────── */

/** "Thabo Nkosi" → "T.N." (initials only). */
export function initials(firstName: unknown, lastName: unknown): string {
  const parts = `${String(firstName ?? '')} ${String(lastName ?? '')}`.split(/\s+/).filter(Boolean);
  return parts.length ? parts.map((p) => `${p[0].toUpperCase()}.`).join('') : '∅';
}

export function birthYearOf(dob: unknown): number | null {
  const m = /^(\d{4})/.exec(String(dob ?? '').trim());
  return m ? Number(m[1]) : null;
}

const nk8 = (nk: string) => nk.slice(0, 8);

export type IdKind = 'sa-id' | 'passport' | 'none';

/** How the row's natural key was derived (see playerNaturalKey in player-identity.ts). */
export function idKindOf(r: Pick<PlayerRegistration, 'idType' | 'idNumber'>): IdKind {
  if (!normalizeId(r.idNumber)) return 'none';
  return (r.idType ?? 'sa-id') === 'passport' ? 'passport' : 'sa-id';
}

/* ─────────────────────────── Export contract ─────────────────────────── */

export interface ExportIntent {
  op: 'upsert' | 'remove';
  /** The desired medicoach team refs (empty for `remove`). */
  teamRefs: string[];
  /** upsert: the club medicoach gets the details from. */
  primaryClubId?: string;
  veteransClubId?: string;
  eligibleRows?: number;
  /** remove: why. */
  reason?: string;
}

export interface ExportPlayer {
  ref: string;
  naturalKey: string;
  maskedName: string;
  birthYear: number | null;
  dobMissing: boolean;
  idKind: IdKind;
  clubs: Array<{ clubId: string; status: string; placeholder: boolean; team: string | null }>;
  intent: ExportIntent | null;
  intentError?: string;
  backlog: 'review' | 'pending' | null;
}

export interface PlayersExport {
  generatedAt: string;
  tenant: string;
  stage: string;
  syncFeatureFlags: {
    features: TenantConfig['features'] | null;
    integrations: TenantConfig['integrations'] | null;
    /** Derived: features.medicoachSync AND integrations.medicoach.playerSync. */
    playerSyncEnabled: boolean;
  };
  players: ExportPlayer[];
}

/* ─────────────────────────── Audit ─────────────────────────── */

const statusOf = (r: PlayerRegistration) => r.status ?? 'active';

/** The row whose name/dob represents the person: active non-placeholder first. */
function representative(rows: PlayerRegistration[]): PlayerRegistration | undefined {
  return (
    rows.find((r) => r.placeholder !== true && statusOf(r) === 'active') ??
    rows.find((r) => r.placeholder !== true) ??
    rows[0]
  );
}

export interface MultiClubGroup {
  nk: string;
  maskedName: string;
  birthYear: number | null;
  rows: Array<{ club: string; status: string; placeholder: boolean }>;
  /** Legitimate groups only: why (clearance-pending / placeholder / history). */
  why?: string;
}

export interface MaskedRow {
  nk: string;
  maskedName: string;
  birthYear: number | null;
  club: string;
  status: string;
  placeholder: boolean;
  /** Unauditable bucket only. */
  missing?: string;
}

export interface AuditResult {
  export: PlayersExport;
  multiClub: { legitimate: MultiClubGroup[]; suspicious: MultiClubGroup[] };
  noIdRows: MaskedRow[];
  passportRows: MaskedRow[];
  unauditableRows: MaskedRow[];
  reviews: Array<{
    nk: string;
    maskedName: string;
    birthYear: number | null;
    reason: string;
    club: string;
    detectedAt: string;
    candidates: number;
  }>;
  pending: Array<{
    nk: string;
    maskedName: string;
    op: string;
    parked: boolean;
    eraseFirst: boolean;
    attempts: number;
    missingTeamRefs: number;
    enqueuedAt: string;
    hasRows: boolean;
  }>;
}

export function buildAudit(input: {
  tenant: string;
  stage: string;
  generatedAt: string;
  snap: PlayerSyncSnapshot;
  reviews: PlayerSyncReview[];
  pending: PendingPlayerSync[];
}): AuditResult {
  const { tenant, snap } = input;
  const reviewNks = new Set(input.reviews.map((r) => r.naturalKey));
  const pendingNks = new Set(input.pending.map((p) => p.naturalKey));
  const clubName = (id: string) => snap.clubsById.get(id)?.name ?? id;

  const players: ExportPlayer[] = [];
  const legitimate: MultiClubGroup[] = [];
  const suspicious: MultiClubGroup[] = [];
  const noIdRows: MaskedRow[] = [];
  const passportRows: MaskedRow[] = [];
  const unauditableRows: MaskedRow[] = [];

  for (const nk of [...snap.rowsByNk.keys()].sort()) {
    const rows = snap.rowsByNk.get(nk) ?? [];
    const rep = representative(rows);
    const maskedName = initials(rep?.firstName, rep?.lastName);
    const birthYear = birthYearOf(rep?.dob);

    let intent: ExportIntent | null = null;
    let intentError: string | undefined;
    try {
      const it = intentOf(snap, nk);
      intent =
        it.op === 'upsert'
          ? {
              op: 'upsert',
              teamRefs: it.teamRefs,
              primaryClubId: it.primary.clubId,
              ...(it.veteransClubId ? { veteransClubId: it.veteransClubId } : {}),
              eligibleRows: it.eligibleRows,
            }
          : { op: 'remove', teamRefs: [], reason: it.reason };
    } catch (err) {
      intentError = err instanceof Error ? err.message : String(err);
    }

    players.push({
      ref: refs.player(tenant, nk),
      naturalKey: nk,
      maskedName,
      birthYear,
      dobMissing: !rows.some((r) => String(r.dob ?? '').trim()),
      idKind: rep ? idKindOf(rep) : 'none',
      clubs: rows.map((r) => ({
        clubId: r.clubId,
        status: statusOf(r),
        placeholder: r.placeholder === true,
        team: r.team ?? null,
      })),
      intent,
      ...(intentError !== undefined ? { intentError } : {}),
      backlog: reviewNks.has(nk) ? 'review' : pendingNks.has(nk) ? 'pending' : null,
    });

    // Same natural key at 2+ clubs.
    const clubIds = new Set(rows.map((r) => r.clubId));
    if (clubIds.size >= 2) {
      const activeClubs = new Set(
        rows.filter((r) => r.placeholder !== true && statusOf(r) === 'active').map((r) => r.clubId),
      );
      const group: MultiClubGroup = {
        nk,
        maskedName,
        birthYear,
        rows: rows.map((r) => ({
          club: clubName(r.clubId),
          status: statusOf(r),
          placeholder: r.placeholder === true,
        })),
      };
      if (activeClubs.size >= 2) suspicious.push(group);
      else {
        const why: string[] = [];
        if (rows.some((r) => statusOf(r) === 'clearance-pending')) why.push('clearance-pending');
        if (rows.some((r) => r.placeholder === true)) why.push('placeholder');
        if (!why.length) why.push('history (inactive / clearance-rejected side)');
        legitimate.push({ ...group, why: why.join(' + ') });
      }
    }

    for (const r of rows) {
      const masked: MaskedRow = {
        nk,
        maskedName: initials(r.firstName, r.lastName),
        birthYear: birthYearOf(r.dob),
        club: clubName(r.clubId),
        status: statusOf(r),
        placeholder: r.placeholder === true,
      };
      const kind = idKindOf(r);
      if (kind === 'none') noIdRows.push(masked);
      else if (kind === 'passport') passportRows.push(masked);
      // The duplicate guard never matches a placeholder or an empty name+dob key.
      if (r.placeholder !== true && !nameDobKey(r)) {
        const missing = [
          ...(!String(r.dob ?? '').trim() ? ['dob'] : []),
          ...(!`${r.firstName ?? ''}${r.lastName ?? ''}`.trim() ? ['name'] : []),
        ];
        unauditableRows.push({ ...masked, missing: missing.join(' + ') || 'name/dob' });
      }
    }
  }

  const rowsOf = (nk: string) => snap.rowsByNk.get(nk) ?? [];
  const reviews = [...input.reviews]
    .sort((a, b) => a.naturalKey.localeCompare(b.naturalKey))
    .map((r) => {
      const [first, ...rest] = String(r.playerName ?? '').split(/\s+/);
      return {
        nk: r.naturalKey,
        maskedName: initials(first, rest.join(' ')),
        birthYear: birthYearOf(r.dob),
        reason: r.reason,
        club: r.clubName ?? '—',
        detectedAt: r.detectedAt,
        candidates: r.candidates?.length ?? 0,
      };
    });
  const pending = [...input.pending]
    .sort((a, b) => a.naturalKey.localeCompare(b.naturalKey))
    .map((p) => {
      const rep = representative(rowsOf(p.naturalKey));
      return {
        nk: p.naturalKey,
        maskedName: rep ? initials(rep.firstName, rep.lastName) : '∅',
        op: p.op ?? 'sync',
        parked: p.parked === true,
        eraseFirst: p.eraseFirst === true,
        attempts: p.attempts ?? 0,
        missingTeamRefs: p.missingTeamRefs?.length ?? 0,
        enqueuedAt: p.enqueuedAt,
        hasRows: rowsOf(p.naturalKey).length > 0,
      };
    });

  const config = snap.config;
  return {
    export: {
      generatedAt: input.generatedAt,
      tenant,
      stage: input.stage,
      syncFeatureFlags: {
        features: config?.features ?? null,
        integrations: config?.integrations ?? null,
        playerSyncEnabled: playerSyncEnabled(config),
      },
      players,
    },
    multiClub: { legitimate, suspicious },
    noIdRows,
    passportRows,
    unauditableRows,
    reviews,
    pending,
  };
}

/* ─────────────────────────── Report ─────────────────────────── */

const yr = (y: number | null) => (y === null ? '????' : String(y));

export function renderReport(a: AuditResult): string {
  const e = a.export;
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);
  const rowTable = (rows: MaskedRow[], extra = false) => {
    if (!rows.length) return push('_none_', '');
    push(
      `| key | name | born | club | status | placeholder${extra ? ' | missing' : ''} |`,
      `|---|---|---|---|---|---${extra ? '|---' : ''}|`,
    );
    for (const r of rows)
      push(
        `| ${nk8(r.nk)} | ${r.maskedName} | ${yr(r.birthYear)} | ${r.club} | ${r.status} | ${r.placeholder ? 'yes' : ''}${extra ? ` | ${r.missing ?? ''}` : ''} |`,
      );
    push('');
  };
  const groupList = (groups: MultiClubGroup[]) => {
    if (!groups.length) return push('_none_', '');
    for (const g of groups)
      push(
        `- ${nk8(g.nk)} ${g.maskedName} (${yr(g.birthYear)})${g.why ? ` — ${g.why}` : ''}: ` +
          g.rows
            .map((r) => `${r.club} [${r.status}${r.placeholder ? ', placeholder' : ''}]`)
            .join(', '),
      );
    push('');
  };
  const persons = e.players.length;
  const rows = e.players.reduce((n, p) => n + p.clubs.length, 0);
  const upserts = e.players.filter((p) => p.intent?.op === 'upsert').length;
  const removes = e.players.filter((p) => p.intent?.op === 'remove').length;
  const intentErrors = e.players.filter((p) => p.intentError !== undefined).length;
  const personsOf = (rs: MaskedRow[]) => new Set(rs.map((r) => r.nk)).size;

  push(
    `# Smart Club player audit — ${e.tenant} (${e.stage})`,
    '',
    `Generated ${e.generatedAt}. Read-only. Names are initials, keys are cut to 8 characters, no ID numbers.`,
    '',
    '## Sync feature flags',
    '',
    '```json',
    JSON.stringify(e.syncFeatureFlags, null, 2),
    '```',
    '',
    `Player sync enabled: **${e.syncFeatureFlags.playerSyncEnabled ? 'yes' : 'no'}**`,
    '',
    '## Totals',
    '',
    `- persons (natural keys): ${persons}`,
    `- player rows: ${rows}`,
    `- sync intent: ${upserts} upsert, ${removes} remove, ${intentErrors} errored`,
    '',
    '## Same natural key at 2+ clubs',
    '',
    `### Suspicious — active at 2+ clubs, non-placeholder (${a.multiClub.suspicious.length})`,
    '',
  );
  groupList(a.multiClub.suspicious);
  push(`### Legitimate (${a.multiClub.legitimate.length})`, '');
  groupList(a.multiClub.legitimate);
  push(
    `## Rows keyed without an ID (name + DOB natural key) — ${a.noIdRows.length} rows, ${personsOf(a.noIdRows)} persons`,
    '',
  );
  rowTable(a.noIdRows);
  push(
    `## Passport-keyed rows — ${a.passportRows.length} rows, ${personsOf(a.passportRows)} persons`,
    '',
  );
  rowTable(a.passportRows);
  push(
    `## Unauditable for duplicates (blank DOB or name) — ${a.unauditableRows.length} rows, ${personsOf(a.unauditableRows)} persons`,
    '',
    'The name + DOB duplicate guard (`nameDobKey`) produces no key for these rows, so they are never grouped.',
    '',
  );
  rowTable(a.unauditableRows, true);
  push(`## Sync backlog`, '', `### PLAYERREVIEW# (${a.reviews.length})`, '');
  if (!a.reviews.length) push('_none_', '');
  else {
    push(
      '| key | name | born | reason | club | detected | candidates |',
      '|---|---|---|---|---|---|---|',
    );
    for (const r of a.reviews)
      push(
        `| ${nk8(r.nk)} | ${r.maskedName} | ${yr(r.birthYear)} | ${r.reason} | ${r.club} | ${r.detectedAt} | ${r.candidates} |`,
      );
    push('');
  }
  const parked = a.pending.filter((p) => p.parked).length;
  const orphan = a.pending.filter((p) => !p.hasRows).length;
  push(
    `### PENDINGPLAYERSYNC# (${a.pending.length}: ${parked} parked, ${orphan} with no player rows)`,
    '',
  );
  if (!a.pending.length) push('_none_', '');
  else {
    push(
      '| key | name | op | parked | erase first | attempts | missing teams | enqueued |',
      '|---|---|---|---|---|---|---|---|',
    );
    for (const p of a.pending)
      push(
        `| ${nk8(p.nk)} | ${p.maskedName} | ${p.op} | ${p.parked ? 'yes' : ''} | ${p.eraseFirst ? 'yes' : ''} | ${p.attempts} | ${p.missingTeamRefs} | ${p.enqueuedAt} |`,
      );
    push('');
  }
  return lines.join('\n');
}

/* ─────────────────────────── CLI ─────────────────────────── */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { tenant } = args;
  const stage = resolveStage();
  const repo = await import('../repo.js');
  // Reads only: per-club player Queries + the SYNC partition's two prefixes.
  const [snap, reviews, pending] = await Promise.all([
    loadPlayerSyncSnapshot(repo, tenant),
    repo.listPlayerReviews(tenant),
    repo.listPendingPlayerSync(tenant),
  ]);
  const audit = buildAudit({
    tenant,
    stage,
    generatedAt: new Date().toISOString(),
    snap,
    reviews,
    pending,
  });

  const dir = path.resolve(args.out);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const reportPath = path.join(dir, 'sc-audit-report.md');
  const exportPath = path.join(dir, `smartclub-${tenant}-players.json`);
  for (const [file, body] of [
    [reportPath, renderReport(audit)],
    [exportPath, JSON.stringify(audit.export, null, 2)],
  ] as const) {
    await writeFile(file, body, { mode: 0o600 });
    // `mode` only applies when the file is created; tighten an existing file too.
    await chmod(file, 0o600);
  }
  console.log(`\nplayer audit — ${tenant} (${stage}, read-only)`);
  console.log(`  persons                 ${audit.export.players.length}`);
  console.log(`  suspicious multi-club   ${audit.multiClub.suspicious.length}`);
  console.log(`  legitimate multi-club   ${audit.multiClub.legitimate.length}`);
  console.log(`  rows without an ID      ${audit.noIdRows.length}`);
  console.log(`  passport rows           ${audit.passportRows.length}`);
  console.log(`  unauditable rows        ${audit.unauditableRows.length}`);
  console.log(`  reviews / pending       ${audit.reviews.length} / ${audit.pending.length}`);
  console.log(`\n✓ ${reportPath} (masked)`);
  console.log(`✓ ${exportPath} (natural keys: keep local, delete after the audit)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}
