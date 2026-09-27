/**
 * One stage-group of a season run → one Series (ADR 0008).
 *
 * The single definition of the series object a generated stage persists. The stage
 * generate route (`generateStage` in ./generate.ts, called by
 * `POST /season-runs/:id/stages/:specId/generate`) and the cohort seeder
 * (packages/api/src/seed-cohort.ts) both build through here, so the id a re-seed writes is
 * byte-identical to the one the console's generate writes, and both carry the same schedule
 * binding (`roundsPerDay`, `activateFrom`) rather than two hand-kept copies drifting.
 *
 * Match format comes from the league's setup structure (`format`): its name becomes the
 * series' `seriesType` and its `overs` the series' `maxOvers` (absent ⇒ 50).
 */
import type { TeamParticipant } from './leagues';
import type { Competition, IsoDate, League, SeasonRun, Series, StageSpec } from './types';

/**
 * The match format a series is built with — read off the league's setup structure (the
 * run's structure snapshot first). `structureName` → `seriesType` (absent ⇒ the stage
 * name); `overs` → `maxOvers` (absent ⇒ 50).
 */
export interface StageSeriesFormat {
  structureName?: string;
  overs?: number;
}

/** The per-group inputs — the fields of the console's `GenerateGroupPayload` read here. */
export interface StageSeriesGroup {
  groupId: string;
  groupLabel: string;
  entrants: string[];
  fixtures: unknown[];
  startDate: IsoDate;
  league?: Pick<League, 'label'>;
  format?: StageSeriesFormat;
  /**
   * @deprecated Superseded by `format`; deleted in WS6. Honoured only when `format` is
   * absent, so callers not yet moved to `format` build exactly what they did before.
   */
  competition?: Pick<Competition, 'label' | 'matchFormat'>;
}

export interface BuildStageSeriesArgs {
  run: Pick<SeasonRun, 'id' | 'leagueKey'> & {
    calendarSnapshot: Pick<SeasonRun['calendarSnapshot'], 'id'>;
  };
  stage: StageSpec;
  /** The block `stage.schedule.blockIndex` resolves to on the run's calendar snapshot. */
  blockId: string;
  group: StageSeriesGroup;
  /** True when the stage has more than one group — the group label joins the name. */
  multi: boolean;
  /**
   * Every side registered for the league (`leagueParticipants`). Filtered to the group's
   * entrants and snapshotted onto the series, so a later roster edit can't orphan it.
   */
  leagueTeams: readonly TeamParticipant[];
  /**
   * @deprecated The competitionDefaults-derived overs fallback; deleted in WS6. Ignored
   * whenever `group.format` is given (the new path's fallback is an inline 50).
   */
  defaultOvers?: number;
}

export function buildStageSeries({
  run,
  stage,
  blockId,
  group: p,
  multi,
  leagueTeams,
  defaultOvers,
}: BuildStageSeriesArgs): Series {
  const participants = leagueTeams
    .filter((t) => p.entrants.includes(t.teamId))
    .map((t) => ({
      teamId: t.teamId,
      clubId: t.clubId,
      name: t.name,
      ...(t.venue ? { venue: t.venue } : {}),
      ...(Number.isFinite(t.lat) ? { lat: t.lat } : {}),
      ...(Number.isFinite(t.lon) ? { lon: t.lon } : {}),
    }));
  return {
    id: `s-${run.id}-${stage.id}-${p.groupId}`,
    name: `${p.league?.label ?? run.leagueKey} · ${stage.name}${multi ? ` · ${p.groupLabel}` : ''}`,
    startDate: p.startDate,
    teams: p.entrants,
    participants,
    fixtures: p.fixtures,
    schedule: {
      calendarId: run.calendarSnapshot.id,
      blockId,
      cadence: stage.schedule.cadence,
      ...(stage.schedule.slots?.length ? { slots: stage.schedule.slots } : {}),
      // Persisted for addFixture + validation parity on THIS stored series — a stage
      // regenerate reads roundsPerDay off the structureSnapshot instead, so a season
      // run keeps its own snapshot until an admin explicitly adopts a newer structure
      // version (POST /season-runs/:id/rebase, the Seasons panel's "Review changes").
      ...(stage.schedule.roundsPerDay === 2 ? { roundsPerDay: 2 as const } : {}),
    },
    ...(stage.schedule.activateFrom ? { activateFrom: stage.schedule.activateFrom } : {}),
    seasonRunId: run.id,
    stageSpecId: stage.id,
    groupId: p.groupId,
    ...formatFields(p, stage, defaultOvers),
    kind: 'series',
    released: false,
    releasedAt: null,
    version: 1,
  };
}

/** `maxOvers` + `seriesType`: from `format` when given, else the deprecated competition path. */
function formatFields(
  p: StageSeriesGroup,
  stage: StageSpec,
  defaultOvers: number | undefined,
): { maxOvers: number; seriesType: string } {
  if (p.format)
    return { maxOvers: p.format.overs ?? 50, seriesType: p.format.structureName ?? stage.name };
  return {
    maxOvers: p.competition?.matchFormat?.overs ?? defaultOvers ?? 50,
    seriesType: p.competition?.label ?? stage.name,
  };
}
