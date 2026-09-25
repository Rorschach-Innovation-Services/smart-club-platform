/**
 * One stage-group of a season run → one Series (ADR 0008).
 *
 * The single definition of the series object a generated stage persists. The stage
 * generate route (`generateStage` in ./generate.ts, called by
 * `POST /season-runs/:id/stages/:specId/generate`) and the cohort seeder
 * (packages/api/src/seed-cohort.ts) both build through here, so the id a re-seed writes is
 * byte-identical to the one the console's generate writes, and both carry the same schedule
 * binding (`roundsPerDay`, `activateFrom`) rather than two hand-kept copies drifting.
 */
import type { TeamParticipant } from './leagues';
import type { Competition, IsoDate, League, SeasonRun, Series, StageSpec } from './types';

/** The per-group inputs — the fields of the console's `GenerateGroupPayload` read here. */
export interface StageSeriesGroup {
  groupId: string;
  groupLabel: string;
  entrants: string[];
  fixtures: unknown[];
  startDate: IsoDate;
  league?: Pick<League, 'label'>;
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
   * Overs when the competition's match format names none: the tenant's first configured
   * match format (`competitionDefaults.matchFormats[0].overs`). Absent ⇒ 50.
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
    maxOvers: p.competition?.matchFormat?.overs ?? defaultOvers ?? 50,
    seriesType: p.competition?.label ?? stage.name,
    kind: 'series',
    released: false,
    releasedAt: null,
    version: 1,
  };
}
