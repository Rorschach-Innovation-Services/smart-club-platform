/**
 * One-off migration: rewrite `StageSchedule.blockId` (a concrete block on the calendar the
 * structure was authored against) into `StageSchedule.blockIndex` (a 0-based position into
 * whichever calendar the competition binds), and drop `CompetitionStructure.calendarId` —
 * both provenance the ordinal-ref model no longer needs. See the "Ordinal block refs"
 * decision in docs/architecture/0008-configurable-league-structures.md.
 *
 * Two kinds of stages carry the legacy shape, both handled here:
 *   1. `TenantConfig.structures[].stages` — the reusable structure templates.
 *   2. `SeasonRun.structureSnapshot.stages` — a FROZEN copy taken when a season started.
 *      A run's snapshot resolves against its OWN `calendarSnapshot` only (see below), not
 *      the tenant's live calendar list — that snapshot IS the authoritative calendar for
 *      that run, by design (ADR 0008's "never reshape a season already in flight").
 *
 * Resolution per config-structure stage, most-known answer first:
 *   1. The calendar named by whichever competition binds this stage's structure
 *      (`League.competitions[].structureId === structure.id`, then `.calendarId`).
 *   2. Failing that, `structure.calendarId` — the authorial answer recorded when the
 *      structure was built, before any competition bound it. More specific than coverage:
 *      it names ONE calendar the human intended, not merely a calendar that happens to
 *      qualify.
 *   3. Failing that, the one calendar in the tenant's config that HAS a block with this
 *      id — unambiguous only when exactly one calendar qualifies.
 * A stage that resolves neither way is reported and left untouched — guessing would
 * silently place a stage in the wrong half of the wrong season, which is worse than
 * leaving it on the legacy shape for a human to look at.
 *
 * A structure keeps its `calendarId` if ANY of its stages is still unresolved after this
 * pass — a human working the unresolved report needs it to finish the job by hand. Only a
 * structure with every legacy `blockId` stage fully resolved sheds `calendarId`.
 *
 * Resolution per season-run stage is simpler: there is exactly one candidate calendar (the
 * run's own `calendarSnapshot`), so no binding/coverage question arises — either the
 * snapshot has a block with this id, or the stage is unresolved and reported.
 *
 * Only stages still carrying legacy `blockId` are touched; a stage already on
 * `blockIndex` (nothing to migrate) is left exactly as it is.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/migrate-block-index.ts            (dry-run)
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/migrate-block-index.ts --dry-run   (explicit dry-run)
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/migrate-block-index.ts --confirm   (writes)
 *
 * NOT run against any AWS environment as part of this change — dry-run against dev before
 * ever passing --confirm anywhere.
 */
import { pathToFileURL } from 'node:url';
import * as repo from '../src/repo.js';
import type { Competition, League, SeasonCalendar, SeasonRun, TenantConfig } from '../src/types.js';

/** The pre-migration stage shape, still on disk for any structure not yet touched. */
interface LegacyStageSchedule {
  blockId?: string;
  blockIndex?: number;
  [key: string]: unknown;
}

interface LegacyStage {
  id: string;
  name: string;
  schedule: LegacyStageSchedule;
  [key: string]: unknown;
}

interface LegacyStructure {
  id: string;
  name: string;
  calendarId?: string;
  stages: LegacyStage[];
  [key: string]: unknown;
}

export interface UnresolvedStage {
  tenant: string;
  structureId: string;
  structureName: string;
  stageId: string;
  stageName: string;
  blockId: string;
  reason: /** No competition binds this structure, `structure.calendarId` (if any) doesn't
     *  cover this block either, and no calendar does. */
    | 'no-binding-no-coverage'
    /** No competition binds this structure, `structure.calendarId` (if any) doesn't cover
     *  this block either, and MORE THAN ONE calendar does — picking one would be a guess. */
    | 'no-binding-ambiguous-coverage'
    /** A competition binds this structure, but the bound calendar has no such block — the
     *  data is already inconsistent, so falling back to `calendarId`/coverage would be a
     *  second guess. */
    | 'bound-calendar-missing-block'
    /** SEVERAL competitions bind this structure to DIFFERENT calendars — the most-known
     *  answer disagrees with itself, so picking one would let league order decide. */
    | 'ambiguous-bindings';
}

/** The season-run counterpart of `UnresolvedStage` — a run has no binding/coverage
 *  question, only its own frozen calendar, so there is nothing to distinguish by reason. */
export interface UnresolvedRunStage {
  tenant: string;
  runId: string;
  structureName: string;
  stageId: string;
  stageName: string;
  blockId: string;
}

export interface MigrateBlockIndexResult {
  tenantsScanned: number;
  tenantsChanged: number;
  stagesMigrated: number;
  unresolved: UnresolvedStage[];
  runsScanned: number;
  runsChanged: number;
  runStagesMigrated: number;
  unresolvedRuns: UnresolvedRunStage[];
}

/**
 * The calendar the competitions binding `structureId` agree on. Structures are reusable
 * blueprints, so SEVERAL competitions can bind one structure — to different calendars.
 * Taking the first would let league sort order decide which calendar a stage migrates
 * against, silently wrong when positions differ; distinct calendars are therefore
 * reported as ambiguous, mirroring the coverage guard.
 */
function boundCalendar(
  structureId: string,
  leagues: League[],
  calendars: SeasonCalendar[],
):
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | { kind: 'one'; calendar: SeasonCalendar | undefined } {
  const ids = [
    ...new Set(
      leagues
        .flatMap((lg): Competition[] => lg.competitions ?? [])
        .filter((c) => c.structureId === structureId)
        .map((c) => c.calendarId),
    ),
  ];
  if (ids.length === 0) return { kind: 'none' };
  if (ids.length > 1) return { kind: 'ambiguous' };
  return { kind: 'one', calendar: calendars.find((cal) => cal.id === ids[0]) };
}

/** Every calendar whose blocks include `blockId` — the caller decides what "one" means. */
function coveringCalendars(blockId: string, calendars: SeasonCalendar[]): SeasonCalendar[] {
  return calendars.filter((cal) => cal.blocks.some((b) => b.id === blockId));
}

/**
 * Migrate one tenant's structures in memory. Returns the rewritten structures (only
 * changed where resolvable), the count of stages actually migrated, and every stage that
 * could not be resolved. Never touches `repo` — the caller decides whether to persist.
 */
function migrateTenantStructures(
  tenant: string,
  structures: LegacyStructure[],
  leagues: League[],
  calendars: SeasonCalendar[],
): {
  structures: LegacyStructure[];
  migrated: number;
  calendarIdsDropped: number;
  unresolved: UnresolvedStage[];
} {
  let migrated = 0;
  let calendarIdsDropped = 0;
  const unresolved: UnresolvedStage[] = [];

  const next = structures.map((structure) => {
    let structureHasUnresolved = false;
    const authored = structure.calendarId
      ? calendars.find((cal) => cal.id === structure.calendarId)
      : undefined;

    const stages = structure.stages.map((stage) => {
      const legacyBlockId = stage.schedule?.blockId;
      if (typeof legacyBlockId !== 'string' || !legacyBlockId) return stage; // already migrated or unset

      const bound = boundCalendar(structure.id, leagues, calendars);
      let cal: SeasonCalendar | undefined;
      let reason: UnresolvedStage['reason'] | undefined;
      if (bound.kind === 'ambiguous') {
        // Bindings name different calendars — the more-known answer disagrees with
        // itself, and falling through to `calendarId`/coverage would quietly pick a
        // side. Reported for a human, like ambiguous coverage.
        reason = 'ambiguous-bindings';
      } else if (bound.kind === 'one' && bound.calendar) {
        // A binding is the more-known answer, so it is never second-guessed against
        // `calendarId`/coverage — a bound calendar missing the block is a genuine
        // inconsistency to report, not a cue to go looking elsewhere.
        cal = bound.calendar.blocks.some((b) => b.id === legacyBlockId)
          ? bound.calendar
          : undefined;
        if (!cal) reason = 'bound-calendar-missing-block';
      } else if (authored && authored.blocks.some((b) => b.id === legacyBlockId)) {
        // The authorial answer: the calendar the structure itself recorded before any
        // competition ever bound to it. More specific than coverage — it names the ONE
        // calendar the human intended, not merely one that happens to qualify.
        cal = authored;
      } else {
        const covering = coveringCalendars(legacyBlockId, calendars);
        if (covering.length === 1) {
          cal = covering[0];
        } else if (covering.length > 1) {
          reason = 'no-binding-ambiguous-coverage';
        } else {
          reason = 'no-binding-no-coverage';
        }
      }

      const index = cal?.blocks.findIndex((b) => b.id === legacyBlockId) ?? -1;
      if (!cal || index < 0) {
        structureHasUnresolved = true;
        unresolved.push({
          tenant,
          structureId: structure.id,
          structureName: structure.name,
          stageId: stage.id,
          stageName: stage.name,
          blockId: legacyBlockId,
          reason: reason ?? 'no-binding-no-coverage',
        });
        return stage;
      }

      migrated++;
      const { blockId: _blockId, ...restSchedule } = stage.schedule;
      void _blockId;
      return { ...stage, schedule: { ...restSchedule, blockIndex: index } };
    });

    // `calendarId` survives on a structure that STILL has an unresolved legacy stage —
    // a human resolving it by hand needs the authorial answer to still be there. Only a
    // structure with every legacy stage now migrated sheds it.
    if (structureHasUnresolved) return { ...structure, stages };

    if ('calendarId' in structure) calendarIdsDropped++;
    const { calendarId: _calendarId, ...restStructure } = structure;
    void _calendarId;
    return { ...restStructure, stages };
  });

  return { structures: next, migrated, calendarIdsDropped, unresolved };
}

/**
 * Migrate one season run's frozen `structureSnapshot` in memory, resolving every legacy
 * `blockId` against the run's OWN `calendarSnapshot` — the one calendar a run can ever be
 * scheduled against, so there is no binding or coverage question to ask, only whether the
 * snapshot itself has the block. Same `calendarId`-survives-if-unresolved rule as a config
 * structure. Never touches `repo` — the caller decides whether to persist.
 */
function migrateSeasonRunSnapshot(
  tenant: string,
  run: SeasonRun,
): {
  structureSnapshot: LegacyStructure;
  migrated: number;
  calendarIdDropped: number;
  unresolved: UnresolvedRunStage[];
} {
  const structureSnapshot = run.structureSnapshot as unknown as LegacyStructure;
  const calendarSnapshot = run.calendarSnapshot;
  let migrated = 0;
  let structureHasUnresolved = false;
  const unresolved: UnresolvedRunStage[] = [];

  const stages = structureSnapshot.stages.map((stage) => {
    const legacyBlockId = stage.schedule?.blockId;
    if (typeof legacyBlockId !== 'string' || !legacyBlockId) return stage;

    const index = calendarSnapshot.blocks.findIndex((b) => b.id === legacyBlockId);
    if (index < 0) {
      structureHasUnresolved = true;
      unresolved.push({
        tenant,
        runId: run.id,
        structureName: structureSnapshot.name,
        stageId: stage.id,
        stageName: stage.name,
        blockId: legacyBlockId,
      });
      return stage;
    }

    migrated++;
    const { blockId: _blockId, ...restSchedule } = stage.schedule;
    void _blockId;
    return { ...stage, schedule: { ...restSchedule, blockIndex: index } };
  });

  if (structureHasUnresolved) {
    return {
      structureSnapshot: { ...structureSnapshot, stages },
      migrated,
      calendarIdDropped: 0,
      unresolved,
    };
  }
  const calendarIdDropped = 'calendarId' in structureSnapshot ? 1 : 0;
  const { calendarId: _calendarId, ...restStructure } = structureSnapshot;
  void _calendarId;
  return {
    structureSnapshot: { ...restStructure, stages } as LegacyStructure,
    migrated,
    calendarIdDropped,
    unresolved,
  };
}

export async function migrateBlockIndex(
  opts: { confirm?: boolean; log?: (line: string) => void } = {},
): Promise<MigrateBlockIndexResult> {
  const confirm = opts.confirm ?? false;
  const log = opts.log ?? console.log;

  const tenants = await repo.listTenants();
  const result: MigrateBlockIndexResult = {
    tenantsScanned: tenants.length,
    tenantsChanged: 0,
    stagesMigrated: 0,
    unresolved: [],
    runsScanned: 0,
    runsChanged: 0,
    runStagesMigrated: 0,
    unresolvedRuns: [],
  };

  for (const config of tenants) {
    const structures = (config.structures ?? []) as unknown as LegacyStructure[];
    const {
      structures: next,
      migrated,
      calendarIdsDropped,
      unresolved,
    } = migrateTenantStructures(
      config.tenant,
      structures,
      config.leagues ?? [],
      config.calendars ?? [],
    );

    result.unresolved.push(...unresolved);
    // A structure can be change-worthy without any stage migrating: a re-run after a
    // partial migration still needs to shed leftover `calendarId` fields.
    if (migrated > 0 || calendarIdsDropped > 0) {
      result.tenantsChanged++;
      result.stagesMigrated += migrated;
      log(
        `${confirm ? '' : '[dry-run] '}${config.tenant}: ${migrated} stage(s) → blockIndex` +
          (calendarIdsDropped ? `, ${calendarIdsDropped} calendarId field(s) dropped` : '') +
          (unresolved.length ? `, ${unresolved.length} unresolved (left untouched)` : ''),
      );

      if (confirm) {
        const updated: TenantConfig = {
          ...config,
          structures: next as unknown as TenantConfig['structures'],
        };
        await repo.putTenantConfig(updated);
      }
    }

    // Season runs are scanned for EVERY tenant regardless of whether its config changed
    // — a run's frozen snapshot is independent of the live structure it was copied from.
    const runs = await repo.listSeasonRuns(config.tenant);
    result.runsScanned += runs.length;
    for (const run of runs) {
      const {
        structureSnapshot,
        migrated: runMigrated,
        calendarIdDropped,
        unresolved: runUnresolved,
      } = migrateSeasonRunSnapshot(config.tenant, run);

      result.unresolvedRuns.push(...runUnresolved);
      if (runMigrated === 0 && calendarIdDropped === 0) continue;

      result.runsChanged++;
      result.runStagesMigrated += runMigrated;
      log(
        `${confirm ? '' : '[dry-run] '}${config.tenant}: season run "${run.id}": ${runMigrated} stage(s) → blockIndex` +
          (calendarIdDropped ? `, calendarId field dropped` : '') +
          (runUnresolved.length ? `, ${runUnresolved.length} unresolved (left untouched)` : ''),
      );

      if (confirm) {
        // Snapshots are normally immutable via `PATCH /season-runs/:id` (stripped, not
        // rejected — see docs/api/series.md). This is a migration, not a season edit, so
        // it writes through the repo directly and preserves `version` exactly: the shape
        // is rewritten, not the season's content, and there is no reason to trip a
        // concurrent stage-entrant PATCH's optimistic-concurrency check.
        await repo.putSeasonRun(config.tenant, {
          ...run,
          structureSnapshot: structureSnapshot as unknown as SeasonRun['structureSnapshot'],
        });
      }
    }
  }

  for (const u of result.unresolved) {
    log(
      `  ✗ unresolved: ${u.tenant} · "${u.structureName}" · stage "${u.stageName}" ` +
        `(blockId "${u.blockId}", ${u.reason}) — NOT written`,
    );
  }
  for (const u of result.unresolvedRuns) {
    log(
      `  ✗ unresolved (season run): ${u.tenant} · run "${u.runId}" · "${u.structureName}" · ` +
        `stage "${u.stageName}" (blockId "${u.blockId}") — NOT written`,
    );
  }

  const totalUnresolved = result.unresolved.length + result.unresolvedRuns.length;
  log(
    confirm
      ? `migration complete: ${result.stagesMigrated} stage(s) across ${result.tenantsChanged} tenant(s), ` +
          `${result.runStagesMigrated} season-run stage(s) across ${result.runsChanged} run(s)` +
          (totalUnresolved ? ` (${totalUnresolved} unresolved)` : '')
      : `dry-run complete: ${result.stagesMigrated} stage(s) across ${result.tenantsChanged} tenant(s), ` +
          `${result.runStagesMigrated} season-run stage(s) across ${result.runsChanged} run(s) would change` +
          (totalUnresolved ? ` (${totalUnresolved} unresolved)` : '') +
          '. Re-run with --confirm.',
  );

  return result;
}

async function main(): Promise<void> {
  const flag = process.argv[2];
  if (flag && flag !== '--dry-run' && flag !== '--confirm') {
    console.error(`unknown flag "${flag}" — usage: migrate-block-index [--dry-run|--confirm]`);
    process.exit(1);
  }
  await migrateBlockIndex({ confirm: flag === '--confirm' });
}

// Only run as a CLI — a test can import migrateBlockIndex directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
