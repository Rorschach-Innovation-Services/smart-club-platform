/**
 * One-off migration: rewrite every season run stored under the retired flat-season
 * sentinel (`competitionId === '__flat__'`) onto a real competition in tenant config, so
 * the build that rejects `__flat__` (POST /season-runs, and a client with no synthesized
 * flat path) can still read, regenerate and rebase them.
 *
 * Per flat run:
 *   - Structure: one PER RUN, minted from the run's own snapshot — `id: 'st-flat-<run.id>'`,
 *     version 1, `templateId: 'flat-round-robin'`, `source: 'migration'`. The stage id
 *     (`stage-1`) and every schedule field are kept exactly: that is what keeps each
 *     series' `stageSpecId`, `run.stages[].specId` and the series ids valid across a later
 *     rebase.
 *   - Calendar, most-known answer first:
 *       1. the snapshot's id is an OPERATOR calendar already in config → reuse it. (A
 *          flat run's snapshot may differ from it — a clamped first-round start — but the
 *          snapshot stays the run's authoritative calendar; only the binding is shared.)
 *       2. a config calendar whose blocks equal the snapshot's [{start,end}] → reuse it,
 *          and rewrite `run.calendarSnapshot.id` + every series `schedule.calendarId` of
 *          that run to it (block ids are untouched: run-backed series validate against
 *          the snapshot, which keeps its own).
 *       3. otherwise append the snapshot as a real calendar (id kept, label = the run's
 *          season label).
 *     Custom-date flat runs share one id per LEAGUE (`cal-flat-<leagueKey>`), so two
 *     seasons of one league collide on it with different dates. Rule 1 therefore only
 *     trusts a `cal-flat-` id when its blocks match; a colliding snapshot falls through
 *     to rule 2/3 and, when appended, takes `<snapshot id>-<run.id>` (rewritten like 2).
 *   - Competition: `cmp-flat-<run.id>`, labelled with the run's `flatFormat.seriesType`,
 *     appended to the run's league. A run whose league no longer exists is reported and
 *     skipped.
 *   - Run: `competitionId` → the new competition, `structureSnapshot` → the minted
 *     structure (same content; new id/version/templateId/source), `flatFormat` dropped.
 *
 * Writes, in crash-safe order, per tenant: config (whole-item put, after the SAME
 * calendar/structure/competition validators the operator route runs, planned against a
 * config re-read immediately before the put — TenantConfig has no version guard), then each
 * run's series (version-checked), then the run itself (version-checked, so an in-flight
 * admin PATCH 409s and refetches rather than writing the sentinel back). The run is the
 * "done" marker: a crash part-way leaves it on `__flat__`, and a re-run converges — minted
 * ids are deterministic and replaced in place. Idempotent: a second run finds nothing.
 *
 * A run (or tenant) that fails for any reason is recorded as skipped with the reason and
 * the migration carries on; the summary always prints, and `--confirm` exits 1 when
 * anything was skipped.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/migrate-flat-runs.ts            (dry-run)
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/migrate-flat-runs.ts --dry-run   (explicit dry-run)
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/migrate-flat-runs.ts --confirm   (writes)
 *
 * Run on dev, then prod, BEFORE deploying a build that rejects `__flat__` — see
 * docs/runbooks/configurable-league-structures.md §8.
 */
import { pathToFileURL } from 'node:url';
import * as repo from '../src/repo.js';
import { VersionConflictError } from '../src/repo.js';
import {
  validateCalendars,
  validateCompetitions,
  validateStructures,
} from '../src/config-validation.js';
import type {
  Competition,
  CompetitionStructure,
  League,
  SeasonCalendar,
  SeasonRun,
  Series,
  TenantConfig,
} from '../src/types.js';

const FLAT_COMPETITION_ID = '__flat__';
/** The id prefix the flat-season client minted for a custom-dates calendar. */
const FLAT_CALENDAR_PREFIX = 'cal-flat-';

export type CalendarAction = 'reuse' | 'reuse (dates match)' | 'append';

export interface FlatRunPlan {
  tenant: string;
  runId: string;
  leagueKey: string;
  calendarAction: CalendarAction;
  calendarId: string;
  structureId: string;
  competitionId: string;
  /** Series of this run whose `schedule.calendarId` is rewritten (0 unless the id changes). */
  seriesRewritten: number;
}

export interface FlatRunSkip {
  tenant: string;
  /** Absent ⇒ the whole tenant was skipped. */
  runId?: string;
  reason: string;
}

export interface MigrateFlatRunsResult {
  tenantsScanned: number;
  /** Flat runs found across every tenant. */
  runsFound: number;
  /** Runs planned (dry-run) or written (--confirm). */
  runsMigrated: number;
  plans: FlatRunPlan[];
  skipped: FlatRunSkip[];
}

const blocksEqual = (a: SeasonCalendar['blocks'], b: SeasonCalendar['blocks']): boolean =>
  a.length === b.length && a.every((blk, i) => blk.start === b[i].start && blk.end === b[i].end);

/** Replace-by-id or append — a re-run after a partial write converges instead of duplicating. */
function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  return list.some((x) => x.id === item.id)
    ? list.map((x) => (x.id === item.id ? item : x))
    : [...list, item];
}

interface TenantPlan {
  config: TenantConfig;
  runs: Array<{ plan: FlatRunPlan; run: SeasonRun; next: SeasonRun; series: Series[] }>;
}

/**
 * Plan one tenant's migration in memory. Never touches `repo` for writes — the caller
 * decides whether to persist. Returns undefined (with a skip recorded) when the resulting
 * config would fail validation.
 */
function planTenant(
  config: TenantConfig,
  flatRuns: SeasonRun[],
  allSeries: Series[],
  skipped: FlatRunSkip[],
): TenantPlan | undefined {
  const tenant = config.tenant;
  const originalCalendarIds = new Set((config.calendars ?? []).map((c) => c.id));
  let calendars = [...(config.calendars ?? [])];
  let structures = [...(config.structures ?? [])];
  let leagues: League[] = (config.leagues ?? []).map((l) => ({ ...l }));
  const runs: TenantPlan['runs'] = [];

  for (const run of flatRuns) {
    const leagueIdx = leagues.findIndex((l) => l.key === run.leagueKey);
    if (leagueIdx < 0) {
      skipped.push({
        tenant,
        runId: run.id,
        reason: `league "${run.leagueKey}" no longer exists`,
      });
      continue;
    }

    // ── Calendar ──
    const snap = run.calendarSnapshot;
    const sameId = calendars.find((c) => c.id === snap.id);
    let calendarId: string;
    let calendarAction: CalendarAction;
    if (
      sameId &&
      originalCalendarIds.has(snap.id) &&
      (!snap.id.startsWith(FLAT_CALENDAR_PREFIX) || blocksEqual(sameId.blocks, snap.blocks))
    ) {
      calendarId = snap.id;
      calendarAction = 'reuse';
    } else if (sameId && blocksEqual(sameId.blocks, snap.blocks)) {
      // Appended earlier in THIS pass by another run with the same dates.
      calendarId = snap.id;
      calendarAction = 'reuse';
    } else {
      const byDates = calendars.find((c) => blocksEqual(c.blocks, snap.blocks));
      if (byDates) {
        calendarId = byDates.id;
        calendarAction = 'reuse (dates match)';
      } else {
        calendarId = sameId ? `${snap.id}-${run.id}` : snap.id;
        calendarAction = 'append';
        calendars = upsert(calendars, { ...snap, id: calendarId, label: run.seasonLabel });
      }
    }

    // ── Structure: one per run, the snapshot's content under a real identity ──
    const structure: CompetitionStructure = {
      ...run.structureSnapshot,
      id: `st-flat-${run.id}`,
      name: run.structureSnapshot.name ?? 'Flat season',
      version: 1,
      templateId: 'flat-round-robin',
      source: 'migration',
    };
    structures = upsert(structures, structure);

    // ── Competition on the run's league ──
    const seriesType = run.flatFormat?.seriesType;
    const overs = run.flatFormat?.overs;
    const competition: Competition = {
      id: `cmp-flat-${run.id}`,
      label: seriesType ?? 'Flat season',
      matchFormat: {
        ...(seriesType !== undefined ? { label: seriesType } : {}),
        ...(overs !== undefined ? { overs } : {}),
      },
      structureId: structure.id,
      calendarId,
    };
    const lg = leagues[leagueIdx];
    leagues = leagues.map((l, i) =>
      i === leagueIdx ? { ...lg, competitions: upsert(lg.competitions ?? [], competition) } : l,
    );

    // ── Series of this run naming the old calendar id ──
    const series =
      calendarId === snap.id
        ? []
        : allSeries.filter(
            (s) =>
              s.seasonRunId === run.id &&
              s.schedule !== undefined &&
              s.schedule.calendarId !== calendarId,
          );

    const { flatFormat: _flatFormat, ...rest } = run;
    void _flatFormat;
    const next: SeasonRun = {
      ...rest,
      competitionId: competition.id,
      structureSnapshot: structure,
      calendarSnapshot: { ...snap, id: calendarId },
    };

    runs.push({
      plan: {
        tenant,
        runId: run.id,
        leagueKey: run.leagueKey,
        calendarAction,
        calendarId,
        structureId: structure.id,
        competitionId: competition.id,
        seriesRewritten: series.length,
      },
      run,
      next,
      series,
    });
  }

  if (runs.length === 0) return undefined;
  // The SAME guards the operator route runs — a migration must never persist a config
  // that route would refuse.
  try {
    validateCalendars(calendars);
    validateStructures(structures);
    validateCompetitions(leagues, structures, calendars);
  } catch (err) {
    for (const r of runs) skipped.push({ tenant, runId: r.run.id, reason: 'tenant skipped' });
    skipped.push({
      tenant,
      reason: `the migrated config would not validate: ${(err as Error).message}`,
    });
    return undefined;
  }
  return { config: { ...config, calendars, structures, leagues }, runs };
}

function printTable(tenant: string, plans: FlatRunPlan[], log: (line: string) => void): void {
  const rows = [
    ['run', 'league', 'calendar', 'structure', 'competition', 'series rewritten'],
    ...plans.map((p) => [
      p.runId,
      p.leagueKey,
      `${p.calendarAction} ${p.calendarId}`,
      p.structureId,
      p.competitionId,
      String(p.seriesRewritten),
    ]),
  ];
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  log(`${tenant}:`);
  for (const r of rows) log('  ' + r.map((cell, col) => cell.padEnd(widths[col])).join('  '));
}

/** The storage calls the migration makes — the real repo unless a test substitutes one. */
export type MigrationStore = Pick<
  typeof repo,
  | 'listTenants'
  | 'listSeasonRuns'
  | 'listSeries'
  | 'getTenantConfig'
  | 'putTenantConfig'
  | 'updateSeries'
  | 'updateSeasonRun'
>;

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function migrateFlatRuns(
  opts: { confirm?: boolean; log?: (line: string) => void; store?: MigrationStore } = {},
): Promise<MigrateFlatRunsResult> {
  const confirm = opts.confirm ?? false;
  const log = opts.log ?? console.log;
  const store = opts.store ?? repo;

  const tenants = await store.listTenants();
  const result: MigrateFlatRunsResult = {
    tenantsScanned: tenants.length,
    runsFound: 0,
    runsMigrated: 0,
    plans: [],
    skipped: [],
  };

  for (const listed of tenants) {
    const tenant = listed.tenant;
    try {
      const flatRuns = (await store.listSeasonRuns(tenant)).filter(
        (r) => r.competitionId === FLAT_COMPETITION_ID,
      );
      if (flatRuns.length === 0) continue;
      result.runsFound += flatRuns.length;

      const allSeries = await store.listSeries(tenant);
      // Under --confirm, plan against the config as it is right before the put: the
      // tenant list was read at the start, and a settings save since then must not be
      // overwritten by a whole-item put built from the older copy.
      const config = confirm ? await store.getTenantConfig(tenant) : listed;
      if (!config) {
        for (const r of flatRuns)
          result.skipped.push({ tenant, runId: r.id, reason: 'tenant skipped' });
        result.skipped.push({
          tenant,
          reason: 'tenant disappeared during the migration — nothing written',
        });
        continue;
      }
      const planned = planTenant(config, flatRuns, allSeries, result.skipped);
      if (!planned) continue;

      const plans = planned.runs.map((r) => r.plan);
      printTable(`${confirm ? '' : '[dry-run] '}${tenant}`, plans, log);

      if (!confirm) {
        result.plans.push(...plans);
        result.runsMigrated += plans.length;
        continue;
      }

      try {
        await store.putTenantConfig(planned.config);
      } catch (err) {
        for (const r of planned.runs)
          result.skipped.push({ tenant, runId: r.run.id, reason: 'tenant skipped' });
        result.skipped.push({ tenant, reason: `config write failed: ${reasonOf(err)}` });
        continue;
      }
      for (const { plan, run, next, series } of planned.runs) {
        try {
          for (const s of series)
            await store.updateSeries(tenant, s.id, {
              version: s.version,
              schedule: { ...s.schedule!, calendarId: plan.calendarId },
            });
          await store.updateSeasonRun(tenant, run.id, {
            ...next,
            version: run.version,
            // An explicit undefined drops the stored attribute: the repo merges the patch
            // over the stored item and marshals with removeUndefinedValues.
            flatFormat: undefined,
          });
        } catch (err) {
          result.skipped.push({
            tenant,
            runId: run.id,
            reason:
              err instanceof VersionConflictError
                ? 'changed while migrating (version conflict) — re-run to finish it'
                : `write failed: ${reasonOf(err)} — re-run to finish it`,
          });
          continue;
        }
        result.plans.push(plan);
        result.runsMigrated++;
      }
    } catch (err) {
      // A read failed for this tenant: record it and carry on with the others.
      result.skipped.push({ tenant, reason: `could not be read: ${reasonOf(err)}` });
    }
  }

  for (const s of result.skipped)
    log(`  ✗ skipped: ${s.tenant}${s.runId ? ` · run "${s.runId}"` : ''} — ${s.reason}`);

  log(
    confirm
      ? `migration complete: ${result.runsMigrated} of ${result.runsFound} flat run(s) migrated`
      : `dry-run complete: ${result.runsMigrated} of ${result.runsFound} flat run(s) would migrate. Re-run with --confirm.`,
  );
  return result;
}

/**
 * The CLI, minus `process.exit`: returns the exit status. 1 for an unknown flag, and 1
 * under --confirm when any run or tenant was skipped (so a wrapper script notices an
 * unfinished migration); 0 otherwise. A dry-run's skips are the report, not a failure.
 */
export async function main(
  args: string[],
  opts: {
    log?: (line: string) => void;
    error?: (line: string) => void;
    store?: MigrationStore;
  } = {},
): Promise<number> {
  const flag = args[0];
  if (flag && flag !== '--dry-run' && flag !== '--confirm') {
    (opts.error ?? console.error)(
      `unknown flag "${flag}" — usage: migrate-flat-runs [--dry-run|--confirm]`,
    );
    return 1;
  }
  const confirm = flag === '--confirm';
  const result = await migrateFlatRuns({ confirm, log: opts.log, store: opts.store });
  return confirm && result.skipped.length > 0 ? 1 : 0;
}

// Only run as a CLI — a test can import migrateFlatRuns / main directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((status) => process.exit(status))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
