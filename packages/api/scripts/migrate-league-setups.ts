/**
 * One-off, ADDITIVE migration: give every league that still runs on the deprecated
 * `competitions[]` its one `setup: { structureId, calendarId }`, and move each
 * competition's `matchFormat.overs` onto its structure (`CompetitionStructure.overs`).
 *
 * Nothing is stripped. `competitions[]` (and `note`, and stage `ladder`/`outcome`) stay
 * exactly as stored — the old build keeps reading competitions, the new build reads setup,
 * so either build can run against a migrated config and rollback is free. A later,
 * separate cleanup script retires the inert array after burn-in.
 *
 * Per tenant, per league with `competitions.length >= 1` and no `setup`:
 *   - Kept competition, by CALENDAR RECENCY: the one whose calendar has the latest block
 *     `end` (a calendar that no longer exists sorts oldest; ties keep array order). The
 *     league's `setup` becomes that competition's `{ structureId, calendarId }`.
 *   - Extras (every other competition) are REPORTED and the run exits 1 — the prod gate:
 *     extras mean a split-league decision is owed before `--confirm`. The league still
 *     migrates on the kept stream.
 *   - Overs, for EVERY competition (kept and extra), tenant leagues in order, each league's
 *     competitions in array order: a competition's `matchFormat.overs` is written onto its
 *     structure. The first value a structure receives (or the `overs` it already stored)
 *     stays on it. A competition whose overs CONFLICT gets a per-league clone of the
 *     ORIGINAL structure — id `st-<origId>-<leagueKey>` (`-<overs>` appended if that id is
 *     already taken by a clone with different overs), name suffixed " · <N> overs", stages
 *     deep-copied, `source` unset, `overs` = the competition's. When the cloning
 *     competition is the KEPT one, the league's setup points at the clone. Extras' clones
 *     exist so the split decision has a structure ready.
 *   - Report-only: kept competitions carrying `excludeTeamIds` (re-cut entrants with Edit
 *     entrants — the new model does not honour exclusions); kept competitions with no
 *     overs whose structure now carries overs from another competition; GENERATED runs of
 *     the league whose snapshot root name/overs differ from the migrated structure's
 *     (what a later first-time stage generate, or a rebase, would adopt); UNGENERATED runs
 *     whose followed calendar changes (snapshot calendar id ≠ new setup.calendarId — these
 *     silently re-date).
 *
 * A league that already carries `setup` is never touched (even if competitions[] remain).
 *
 * Per tenant, under `--confirm`: the config is RE-READ, planned, validated with the SAME
 * validators the operator route runs (validateCalendars, validateStructures,
 * validateSetups — never the deprecated competitions validator), a full pre-image backup
 * is written, then one whole-item put. A tenant that fails validation, backup or write is
 * skipped whole and reported — never partially written.
 *
 * Exit status (`main`): 1 for an unknown flag; 1 (dry-run AND --confirm) when any tenant
 * was skipped or any unmigrated league had extra competitions; 0 otherwise — including a
 * fully migrated re-run whose leagues still carry inert competitions[].
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/migrate-league-setups.ts             (dry-run)
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/migrate-league-setups.ts --dry-run   (explicit dry-run)
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/migrate-league-setups.ts --confirm   (writes)
 *   … --confirm --backup-dir=<dir>   (backups elsewhere; default packages/api/)
 *
 * Backups: `packages/api/league-setups-backup-<tenant>-<ISO>.json` — the tenant's full
 * config exactly as read before the put (gitignored by `packages/api/*-backup-*.json`).
 * RESTORE: the file is a complete TenantConfig; put it back whole, e.g.
 *   sst shell --stage <stage> -- npx tsx -e "import('./packages/api/src/repo.ts').then(async r => r.putTenantConfig(JSON.parse(require('fs').readFileSync('<file>','utf8'))))"
 * Only needed if the migrated config itself is wrong — rolling back the BUILD needs no
 * restore, since competitions[] is still there.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as repo from '../src/repo.js';
import { validateCalendars, validateSetups, validateStructures } from '../src/config-validation.js';
import type {
  Competition,
  CompetitionStructure,
  League,
  SeasonCalendar,
  SeasonRun,
  TenantConfig,
} from '../src/types.js';

/** packages/api — where backups land unless `--backup-dir` says otherwise. */
const DEFAULT_BACKUP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_STRUCTURE_NAME = 80;

export interface LeagueSetupPlan {
  tenant: string;
  leagueKey: string;
  /** The kept competition. */
  competitionId: string;
  competitionLabel: string;
  setup: { structureId: string; calendarId: string };
  /** True when the kept competition's overs conflicted and setup points at its clone. */
  onClone: boolean;
}

export interface ExtraCompetition {
  tenant: string;
  leagueKey: string;
  competitionId: string;
  label: string;
  structureId: string;
  calendarId: string;
}

export interface OversWrite {
  tenant: string;
  structureId: string;
  overs: number;
  /** The competition whose overs were written first. */
  leagueKey: string;
  competitionId: string;
}

export interface StructureClone {
  tenant: string;
  leagueKey: string;
  competitionId: string;
  fromStructureId: string;
  cloneId: string;
  overs: number;
  /** The kept competition cloned ⇒ the league's setup points at the clone. */
  kept: boolean;
}

export interface ExcludedTeamsNote {
  tenant: string;
  leagueKey: string;
  competitionId: string;
  excludeTeamIds: string[];
}

export interface InheritedOversNote {
  tenant: string;
  leagueKey: string;
  competitionId: string;
  structureId: string;
  overs: number;
}

export interface FormatDrift {
  tenant: string;
  runId: string;
  leagueKey: string;
  seasonLabel: string;
  snapshot: { name: string; overs?: number };
  migrated: { structureId: string; name: string; overs?: number };
}

export interface CalendarChange {
  tenant: string;
  runId: string;
  leagueKey: string;
  seasonLabel: string;
  fromCalendarId: string;
  toCalendarId: string;
}

export interface LeagueSetupSkip {
  tenant: string;
  reason: string;
}

export interface MigrateLeagueSetupsResult {
  tenantsScanned: number;
  /** Leagues with competitions and no setup, across every tenant. */
  leaguesFound: number;
  /** Leagues planned (dry-run) or written (--confirm). */
  leaguesMigrated: number;
  /** Leagues left alone because they already carry `setup`, competitions[] or not. */
  alreadySetUp: number;
  plans: LeagueSetupPlan[];
  extras: ExtraCompetition[];
  oversWritten: OversWrite[];
  clones: StructureClone[];
  excludedTeams: ExcludedTeamsNote[];
  inheritedOvers: InheritedOversNote[];
  formatDrift: FormatDrift[];
  calendarChanges: CalendarChange[];
  skipped: LeagueSetupSkip[];
  /** Backup files written under --confirm. */
  backups: string[];
}

/** The storage calls the migration makes — the real repo unless a test substitutes one. */
export type MigrationStore = Pick<
  typeof repo,
  'listTenants' | 'listSeasonRuns' | 'getTenantConfig' | 'putTenantConfig'
>;

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A calendar's last playing day; '' (sorts oldest) when the calendar is gone or empty. */
function latestEnd(calendars: SeasonCalendar[], calendarId: string): string {
  const cal = calendars.find((c) => c.id === calendarId);
  return (cal?.blocks ?? []).reduce((max, b) => (b.end > max ? b.end : max), '');
}

/** Index of the competition on the most recent calendar; ties keep array order. */
function keptIndex(comps: Competition[], calendars: SeasonCalendar[]): number {
  let best = 0;
  let bestEnd = latestEnd(calendars, comps[0].calendarId);
  for (let i = 1; i < comps.length; i++) {
    const end = latestEnd(calendars, comps[i].calendarId);
    if (end > bestEnd) {
      best = i;
      bestEnd = end;
    }
  }
  return best;
}

/** True while the run's calendar still follows live config (mirrors the API's isUngenerated). */
function isUngenerated(run: SeasonRun): boolean {
  return (
    !run.calendarFrozenAt &&
    !(run.stages ?? []).some((stage) => (stage?.groups ?? []).some((g) => !!g?.seriesId))
  );
}

function cloneName(name: string, overs: number): string {
  const suffix = ` · ${overs} overs`;
  return name.slice(0, MAX_STRUCTURE_NAME - suffix.length).trimEnd() + suffix;
}

type Notes = Pick<
  MigrateLeagueSetupsResult,
  | 'extras'
  | 'oversWritten'
  | 'clones'
  | 'excludedTeams'
  | 'inheritedOvers'
  | 'formatDrift'
  | 'calendarChanges'
>;

interface TenantPlan {
  config: TenantConfig;
  plans: LeagueSetupPlan[];
  notes: Notes;
  alreadySetUp: number;
}

const emptyNotes = (): Notes => ({
  extras: [],
  oversWritten: [],
  clones: [],
  excludedTeams: [],
  inheritedOvers: [],
  formatDrift: [],
  calendarChanges: [],
});

/**
 * Plan one tenant in memory. Never writes. Returns the plan even when validation fails,
 * with `error` set — the caller reports the extras either way, and writes nothing.
 */
function planTenant(
  config: TenantConfig,
  runs: SeasonRun[],
): { plan: TenantPlan; error?: string } | undefined {
  const tenant = config.tenant;
  const calendars = config.calendars ?? [];
  const originals = new Map((config.structures ?? []).map((s) => [s.id, s]));
  let structures: CompetitionStructure[] = (config.structures ?? []).map((s) => ({ ...s }));
  const notes = emptyNotes();
  const plans: LeagueSetupPlan[] = [];
  let alreadySetUp = 0;

  // The overs each structure holds so far — seeded from what it already stores.
  const assigned = new Map<string, number>();
  for (const s of structures) if (s.overs !== undefined) assigned.set(s.id, s.overs);

  const leagues: League[] = (config.leagues ?? []).map((lg) => {
    const comps = lg.competitions ?? [];
    if (lg.setup !== undefined) {
      if (comps.length > 0) alreadySetUp++;
      return lg;
    }
    if (comps.length === 0) return lg;

    const kept = keptIndex(comps, calendars);
    let setupStructureId = comps[kept].structureId;
    let onClone = false;

    comps.forEach((comp, i) => {
      if (i !== kept)
        notes.extras.push({
          tenant,
          leagueKey: lg.key,
          competitionId: comp.id,
          label: comp.label,
          structureId: comp.structureId,
          calendarId: comp.calendarId,
        });
      const overs = comp.matchFormat?.overs;
      const original = originals.get(comp.structureId);
      if (overs === undefined || !original) return;
      const held = assigned.get(comp.structureId);
      if (held === undefined) {
        assigned.set(comp.structureId, overs);
        structures = structures.map((s) => (s.id === comp.structureId ? { ...s, overs } : s));
        notes.oversWritten.push({
          tenant,
          structureId: comp.structureId,
          overs,
          leagueKey: lg.key,
          competitionId: comp.id,
        });
        return;
      }
      if (held === overs) return;

      // Conflict: a per-league clone of the ORIGINAL structure carries this competition's overs.
      let cloneId = `st-${comp.structureId}-${lg.key}`;
      const existing = structures.find((s) => s.id === cloneId);
      if (existing && existing.overs !== overs) cloneId = `${cloneId}-${overs}`;
      if (!structures.some((s) => s.id === cloneId)) {
        const { source: _source, ...rest } = original;
        void _source;
        structures = [
          ...structures,
          {
            ...structuredClone(rest),
            id: cloneId,
            name: cloneName(original.name, overs),
            overs,
          },
        ];
      }
      notes.clones.push({
        tenant,
        leagueKey: lg.key,
        competitionId: comp.id,
        fromStructureId: comp.structureId,
        cloneId,
        overs,
        kept: i === kept,
      });
      if (i === kept) {
        setupStructureId = cloneId;
        onClone = true;
      }
    });

    const keptComp = comps[kept];
    if (keptComp.excludeTeamIds?.length)
      notes.excludedTeams.push({
        tenant,
        leagueKey: lg.key,
        competitionId: keptComp.id,
        excludeTeamIds: [...keptComp.excludeTeamIds],
      });
    const setup = { structureId: setupStructureId, calendarId: keptComp.calendarId };
    plans.push({
      tenant,
      leagueKey: lg.key,
      competitionId: keptComp.id,
      competitionLabel: keptComp.label,
      setup,
      onClone,
    });
    return { ...lg, setup };
  });

  if (plans.length === 0 && alreadySetUp === 0) return undefined;

  // Report passes over the final structures.
  for (const p of plans) {
    const migrated = structures.find((s) => s.id === p.setup.structureId);
    const keptComp = (config.leagues ?? [])
      .find((l) => l.key === p.leagueKey)
      ?.competitions?.find((c) => c.id === p.competitionId);
    if (migrated && keptComp && keptComp.matchFormat?.overs === undefined && migrated.overs)
      notes.inheritedOvers.push({
        tenant,
        leagueKey: p.leagueKey,
        competitionId: p.competitionId,
        structureId: migrated.id,
        overs: migrated.overs,
      });
    for (const run of runs) {
      if (run.leagueKey !== p.leagueKey) continue;
      if (isUngenerated(run)) {
        if (run.calendarSnapshot?.id !== p.setup.calendarId)
          notes.calendarChanges.push({
            tenant,
            runId: run.id,
            leagueKey: p.leagueKey,
            seasonLabel: run.seasonLabel,
            fromCalendarId: run.calendarSnapshot?.id ?? '(none)',
            toCalendarId: p.setup.calendarId,
          });
        continue;
      }
      if (!migrated) continue;
      const snap = run.structureSnapshot;
      // The generate route reads overs snapshot-first, live structure only as fallback.
      const effectiveOvers = snap.overs ?? migrated.overs;
      if (snap.name !== migrated.name || effectiveOvers !== migrated.overs)
        notes.formatDrift.push({
          tenant,
          runId: run.id,
          leagueKey: p.leagueKey,
          seasonLabel: run.seasonLabel,
          snapshot: { name: snap.name, ...(snap.overs !== undefined ? { overs: snap.overs } : {}) },
          migrated: {
            structureId: migrated.id,
            name: migrated.name,
            ...(migrated.overs !== undefined ? { overs: migrated.overs } : {}),
          },
        });
    }
  }

  const plan: TenantPlan = {
    config: { ...config, structures, leagues },
    plans,
    notes,
    alreadySetUp,
  };
  if (plans.length === 0) return { plan };
  // The SAME guards the operator route runs — never persist a config it would refuse.
  try {
    validateCalendars(calendars);
    validateStructures(structures);
    validateSetups(leagues, structures, calendars);
  } catch (err) {
    return { plan, error: `the migrated config would not validate: ${reasonOf(err)}` };
  }
  return { plan };
}

function printTenant(label: string, plan: TenantPlan, log: (line: string) => void): void {
  if (plan.plans.length === 0) return;
  const rows = [
    ['league', 'kept competition', 'structure', 'calendar'],
    ...plan.plans.map((p) => [
      p.leagueKey,
      p.competitionLabel,
      `${p.setup.structureId}${p.onClone ? ' (clone)' : ''}`,
      p.setup.calendarId,
    ]),
  ];
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  log(`${label}:`);
  for (const r of rows) log('  ' + r.map((cell, col) => cell.padEnd(widths[col])).join('  '));
  const n = plan.notes;
  for (const e of n.extras)
    log(
      `  ! extra competition: ${e.leagueKey} · "${e.label}" (${e.competitionId}) — structure ${e.structureId}, calendar ${e.calendarId}`,
    );
  for (const o of n.oversWritten)
    log(`  overs: ${o.structureId} ← ${o.overs} (from ${o.leagueKey} · ${o.competitionId})`);
  for (const c of n.clones)
    log(
      `  clone: ${c.fromStructureId} → ${c.cloneId} at ${c.overs} overs for ${c.leagueKey} · ${c.competitionId}${c.kept ? ' (setup points here)' : ' (extra — for the split decision)'}`,
    );
  for (const x of n.excludedTeams)
    log(
      `  ! excluded teams on ${x.leagueKey} · ${x.competitionId}: ${x.excludeTeamIds.join(', ')} — re-cut entrants via Edit entrants`,
    );
  for (const i of n.inheritedOvers)
    log(
      `  ! ${i.leagueKey} · ${i.competitionId} had no overs; its structure ${i.structureId} now carries ${i.overs}`,
    );
  for (const d of n.formatDrift)
    log(
      `  ! generated run ${d.runId} (${d.leagueKey} ${d.seasonLabel}): snapshot "${d.snapshot.name}"/${d.snapshot.overs ?? '-'} overs vs structure "${d.migrated.name}"/${d.migrated.overs ?? '-'} overs`,
    );
  for (const c of n.calendarChanges)
    log(
      `  ! ungenerated run ${c.runId} (${c.leagueKey} ${c.seasonLabel}) will re-date: ${c.fromCalendarId} → ${c.toCalendarId}`,
    );
}

const isoStamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

export async function migrateLeagueSetups(
  opts: {
    confirm?: boolean;
    log?: (line: string) => void;
    store?: MigrationStore;
    backupDir?: string;
  } = {},
): Promise<MigrateLeagueSetupsResult> {
  const confirm = opts.confirm ?? false;
  const log = opts.log ?? console.log;
  const store = opts.store ?? repo;
  const backupDir = opts.backupDir ?? DEFAULT_BACKUP_DIR;

  const tenants = await store.listTenants();
  const result: MigrateLeagueSetupsResult = {
    tenantsScanned: tenants.length,
    leaguesFound: 0,
    leaguesMigrated: 0,
    alreadySetUp: 0,
    plans: [],
    ...emptyNotes(),
    skipped: [],
    backups: [],
  };
  const addNotes = (n: Notes): void => {
    for (const k of Object.keys(n) as Array<keyof Notes>)
      (result[k] as unknown[]).push(...(n[k] as unknown[]));
  };

  for (const listed of tenants) {
    const tenant = listed.tenant;
    try {
      // Under --confirm, plan against the config as it is right before the put: a settings
      // save since the tenant list was read must not be overwritten by an older copy.
      const config = confirm ? await store.getTenantConfig(tenant) : listed;
      if (!config) {
        result.skipped.push({
          tenant,
          reason: 'tenant disappeared during the migration — nothing written',
        });
        continue;
      }
      const hasWork = (config.leagues ?? []).some(
        (l) => l.setup === undefined && (l.competitions?.length ?? 0) > 0,
      );
      const runs = hasWork ? await store.listSeasonRuns(tenant) : [];
      const planned = planTenant(config, runs);
      if (!planned) continue;
      const { plan, error } = planned;
      result.alreadySetUp += plan.alreadySetUp;
      result.leaguesFound += plan.plans.length;
      addNotes(plan.notes);
      if (plan.plans.length === 0) continue;

      printTenant(`${confirm ? '' : '[dry-run] '}${tenant}`, plan, log);
      if (error) {
        result.skipped.push({ tenant, reason: error });
        continue;
      }
      if (!confirm) {
        result.plans.push(...plan.plans);
        result.leaguesMigrated += plan.plans.length;
        continue;
      }

      let backupPath: string;
      try {
        await mkdir(backupDir, { recursive: true });
        backupPath = join(backupDir, `league-setups-backup-${tenant}-${isoStamp()}.json`);
        await writeFile(backupPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
      } catch (err) {
        result.skipped.push({
          tenant,
          reason: `backup failed — nothing written: ${reasonOf(err)}`,
        });
        continue;
      }
      result.backups.push(backupPath);
      try {
        await store.putTenantConfig(plan.config);
      } catch (err) {
        result.skipped.push({ tenant, reason: `config write failed: ${reasonOf(err)}` });
        continue;
      }
      log(`  backup: ${backupPath}`);
      result.plans.push(...plan.plans);
      result.leaguesMigrated += plan.plans.length;
    } catch (err) {
      result.skipped.push({ tenant, reason: `could not be read: ${reasonOf(err)}` });
    }
  }

  for (const s of result.skipped) log(`  ✗ skipped: ${s.tenant} — ${s.reason}`);
  if (result.alreadySetUp > 0)
    log(
      `${result.alreadySetUp} league(s) already set up — left untouched; their inert competitions[] await the cleanup script`,
    );
  if (result.extras.length > 0)
    log(
      `STOP: ${result.extras.length} extra competition(s) found — bring this report back for a split-league decision`,
    );
  log(
    confirm
      ? `migration complete: ${result.leaguesMigrated} of ${result.leaguesFound} league(s) set up`
      : `dry-run complete: ${result.leaguesMigrated} of ${result.leaguesFound} league(s) would be set up. Re-run with --confirm.`,
  );
  return result;
}

/**
 * The CLI, minus `process.exit`: returns the exit status. 1 for an unknown flag; 1 (in
 * either mode) when any tenant was skipped or any extra competition was found on a
 * league this run migrated or would migrate; 0 otherwise.
 */
export async function main(
  args: string[],
  opts: {
    log?: (line: string) => void;
    error?: (line: string) => void;
    store?: MigrationStore;
  } = {},
): Promise<number> {
  let confirm = false;
  let backupDir: string | undefined;
  for (const arg of args) {
    if (arg === '--confirm') confirm = true;
    else if (arg === '--dry-run') confirm = false;
    else if (arg.startsWith('--backup-dir=') && arg.length > '--backup-dir='.length)
      backupDir = arg.slice('--backup-dir='.length);
    else {
      (opts.error ?? console.error)(
        `unknown flag "${arg}" — usage: migrate-league-setups [--dry-run|--confirm] [--backup-dir=<dir>]`,
      );
      return 1;
    }
  }
  const result = await migrateLeagueSetups({
    confirm,
    log: opts.log,
    store: opts.store,
    backupDir,
  });
  return result.skipped.length > 0 || result.extras.length > 0 ? 1 : 0;
}

// Only run as a CLI — a test can import migrateLeagueSetups / main directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((status) => process.exit(status))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
