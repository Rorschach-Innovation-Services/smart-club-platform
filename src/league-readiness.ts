/**
 * League readiness — can this league start a season, and if not, who has to do what?
 *
 * The admin Leagues page and the Start a season modal both answer that question, so it is
 * worked out once, here, as a pure function of data the console already holds: the
 * league's operator-created setup (`league.setup`, ADR 0014), the live structures and
 * calendars it names, the clubs registered for it, and the season runs already started.
 *
 * Authority is unchanged: only the platform OPERATOR sets a league's setup. Everything this
 * module says about a missing or ended setup is therefore phrased as a request to the
 * operator, never as something the admin can fix here.
 *
 * Status precedence (one per league):
 *   1. `running`      — a season run for the league whose calendar has not ended
 *   2. `needs-setup`  — no setup, its structure or calendar is gone, or its dates are over
 *   3. `needs-sides`  — fewer than two sides from affiliated clubs
 *   4. `ready`        — nothing stands in the way of Start season
 *
 * `canStart` is separate from `status`: a league with a season running can still start a
 * season under another label (the server allows one run per league per label), so the
 * Start a season modal keeps it selectable, while the Leagues page leads with Open season.
 */
import { daysBetween, formatIsoDate, todayIso } from '../packages/engine/src/calendar';
import {
  isAffiliated as isAffiliatedClub,
  leagueParticipants,
  type ClubSidesSource,
} from '../packages/engine/src/leagues';
import type {
  CompetitionStructure,
  League,
  SeasonCalendar,
  SeasonRun,
  Series,
} from '../packages/engine/src/types';

/** The four things a league can be, as far as starting a season goes. */
export type LeagueReadinessStatus = 'running' | 'needs-setup' | 'needs-sides' | 'ready';

/** Why the operator is needed. More than one can apply (structure AND calendar gone). */
export type SetupProblem = 'no-setup' | 'structure-missing' | 'calendar-missing' | 'calendar-ended';

/** Where one stage of a season has got to, in the order the admin works through them. */
export type StageStep = 'awaiting-entrants' | 'entrants-confirmed' | 'generated' | 'released';

/** The fewest affiliated sides a season can start with (a fixture needs two). */
export const MIN_SIDES = 2;

/** The club shape readiness reads — a pick of `Club`, loose so tests can pass a sketch. */
export type ReadinessClub = ClubSidesSource & { leagues?: string[]; affiliation?: string };

export interface StageProgress {
  name: string;
  step: StageStep;
  /** "Stage 1 · Double round: entrants confirmed". */
  line: string;
}

export interface RunSummary {
  id: string;
  seasonLabel: string;
  /** True while the run's calendar still has days to play; false for a past season. */
  running: boolean;
  stages: StageProgress[];
  /** One line for the whole season: the first stage not yet released, or "all released". */
  progress: string;
}

export interface LeagueReadiness {
  league: League;
  status: LeagueReadinessStatus;
  /** True when Start season would be accepted for some label (see the module comment). */
  canStart: boolean;
  setup: {
    /** "T20 League · 20 overs" — absent when the league has no setup or it is gone. */
    structureLabel?: string;
    structureVersion?: number;
    calendarLabel?: string;
    /** First block start / last block end, `YYYY-MM-DD`; absent for a calendar with no blocks. */
    start?: string;
    end?: string;
  } | null;
  setupProblems: SetupProblem[];
  /** The setup's calendar when every block has finished, else null. */
  calendarEnded: { label: string; end: string } | null;
  sides: {
    /** Every side registered for the league (a multi-team club counts each side). */
    registered: number;
    /** Sides whose club has submitted its affiliation — the ones a season draws on. */
    affiliated: number;
    /** Clubs registered for the league but not affiliated, with how many sides each. */
    unaffiliatedClubs: Array<{ id: string; name: string; sides: number }>;
  };
  /** The running season, else the most recent past one, else null. */
  run: RunSummary | null;
  /** A few words: why this league is (or isn't) ready. Used beside disabled options. */
  reason: string;
  /** One sentence: what happens next, and who does it. */
  nextStep: string;
  /** A ready-to-paste request for the operator; only when `status` is `needs-setup`. */
  operatorRequest?: string;
}

/** "T20 League · 20 overs" — a structure's name with its overs when it sets them. */
export function structureFormatLabel(structure: Pick<CompetitionStructure, 'name' | 'overs'>) {
  return structure.overs ? `${structure.name} · ${structure.overs} overs` : structure.name;
}

/**
 * True when every block of `calendar` finished before `today` (and it has any). A league
 * whose setup calendar has ended has nothing to start a season on until the operator
 * renews its dates; a run whose calendar has ended is a past season.
 */
function calendarHasEnded(calendar: SeasonCalendar | undefined, today: string): boolean {
  if (!calendar || calendar.blocks.length === 0) return false;
  return calendar.blocks.every((b) => daysBetween(b.end, today) > 0);
}

const STEP_LABEL: Record<StageStep, string> = {
  'awaiting-entrants': 'waiting for entrants',
  'entrants-confirmed': 'entrants confirmed',
  generated: 'fixtures generated',
  released: 'released',
};

/** Where one stage has got to, reading its groups' series for the release state. */
function stageStep(
  stageRun: SeasonRun['stages'][number] | undefined,
  seriesById: Map<string, Pick<Series, 'released'>>,
): StageStep {
  if (!stageRun) return 'awaiting-entrants';
  const groups = stageRun.groups ?? [];
  const seriesIds = groups.map((g) => g.seriesId).filter((id): id is string => !!id);
  if (
    groups.length > 0 &&
    seriesIds.length === groups.length &&
    seriesIds.every((id) => seriesById.get(id)?.released)
  )
    return 'released';
  if (stageRun.status === 'generated' || stageRun.status === 'complete' || seriesIds.length > 0)
    return 'generated';
  if (stageRun.status === 'ready') return 'entrants-confirmed';
  return 'awaiting-entrants';
}

/** A season run's stage-by-stage progress, in the structure's order. */
export function runProgress(
  run: SeasonRun,
  series: ReadonlyArray<Pick<Series, 'id' | 'released'>> = [],
  today: string = todayIso(),
): RunSummary {
  const seriesById = new Map(series.map((s) => [s.id, s]));
  const specs = run.structureSnapshot?.stages ?? [];
  const stages = specs.map((spec, i) => {
    const step = stageStep(
      run.stages.find((s) => s.specId === spec.id),
      seriesById,
    );
    return { name: spec.name, step, line: `Stage ${i + 1} · ${spec.name}: ${STEP_LABEL[step]}` };
  });
  const next = stages.findIndex((s) => s.step !== 'released');
  const progress =
    stages.length === 0
      ? 'No stages'
      : next === -1
        ? stages.length === 1
          ? 'Released'
          : `All ${stages.length} stages released`
        : `Stage ${next + 1} of ${stages.length}: ${STEP_LABEL[stages[next].step]}`;
  return {
    id: run.id,
    seasonLabel: run.seasonLabel,
    running: !calendarHasEnded(run.calendarSnapshot, today),
    stages,
    progress,
  };
}

/** Newest first: by when the run was created, then by label. */
function byNewest(a: SeasonRun, b: SeasonRun): number {
  const at = a.createdAt ?? '';
  const bt = b.createdAt ?? '';
  if (at !== bt) return at < bt ? 1 : -1;
  return a.seasonLabel < b.seasonLabel ? 1 : a.seasonLabel > b.seasonLabel ? -1 : 0;
}

/** "the structure", "the season calendar", "the structure and season calendar". */
function missingParts(problems: SetupProblem[]): string {
  const parts: string[] = [];
  if (problems.includes('structure-missing')) parts.push('structure');
  if (problems.includes('calendar-missing')) parts.push('season calendar');
  return parts.join(' and ');
}

/** The copyable request line for the operator. */
function operatorRequestFor(
  label: string,
  problems: SetupProblem[],
  ended: { label: string; end: string } | null,
): string {
  if (problems.includes('no-setup'))
    return `Please set up ${label} for a season: it needs a structure and a season calendar.`;
  const missing = missingParts(problems);
  if (missing)
    return `Please fix the season setup for ${label}: its ${missing} no longer ${
      missing.includes(' and ') ? 'exist' : 'exists'
    }, so it needs a new one.`;
  return `Please renew the season dates for ${label}: its calendar ${ended?.label ?? ''} ended on ${
    ended ? formatIsoDate(ended.end) : 'an earlier date'
  }.`;
}

/** Short reason for a setup problem, e.g. beside a disabled option. */
function setupReason(problems: SetupProblem[]): string {
  if (problems.includes('no-setup')) return 'not set up by your operator';
  const missing = missingParts(problems);
  if (missing) return `${missing} missing — ask your operator`;
  return 'season dates have ended — ask your operator';
}

export interface ReadinessInput {
  clubs: ReadonlyArray<ReadinessClub>;
  structures: ReadonlyArray<CompetitionStructure>;
  calendars: ReadonlyArray<SeasonCalendar>;
  runs: ReadonlyArray<SeasonRun>;
  /** For the release state of generated stages. Absent ⇒ no stage reads as released. */
  series?: ReadonlyArray<Pick<Series, 'id' | 'released'>>;
  /** `YYYY-MM-DD`; injectable so tests can pin the clock. */
  today?: string;
  /** Whether a club counts as affiliated. Defaults to the engine's `isAffiliated`. */
  isAffiliated?: (club: ReadinessClub) => boolean;
}

/** One league's readiness. See the module comment for the rules. */
export function leagueReadiness(league: League, input: ReadinessInput): LeagueReadiness {
  const today = input.today ?? todayIso();
  const affiliatedFn = input.isAffiliated ?? isAffiliatedClub;

  // ── Setup ──
  const problems: SetupProblem[] = [];
  let setup: LeagueReadiness['setup'] = null;
  let calendarEnded: LeagueReadiness['calendarEnded'] = null;
  if (!league.setup) {
    problems.push('no-setup');
  } else {
    const structure = input.structures.find((s) => s.id === league.setup!.structureId);
    const calendar = input.calendars.find((c) => c.id === league.setup!.calendarId);
    if (!structure) problems.push('structure-missing');
    if (!calendar) problems.push('calendar-missing');
    if (calendarHasEnded(calendar, today)) {
      problems.push('calendar-ended');
      calendarEnded = {
        label: calendar!.label,
        end: calendar!.blocks[calendar!.blocks.length - 1].end,
      };
    }
    const blocks = calendar?.blocks ?? [];
    setup = {
      structureLabel: structure ? structureFormatLabel(structure) : undefined,
      structureVersion: structure?.version,
      calendarLabel: calendar?.label,
      start: blocks[0]?.start,
      end: blocks[blocks.length - 1]?.end,
    };
  }

  // ── Sides (every registered side; a multi-team club counts each one) ──
  const all = leagueParticipants([...input.clubs], league.key);
  const affiliated = all.filter((p) => affiliatedFn(p.club)).length;
  const unaffiliatedClubs: LeagueReadiness['sides']['unaffiliatedClubs'] = [];
  for (const p of all) {
    if (affiliatedFn(p.club)) continue;
    const seen = unaffiliatedClubs.find((c) => c.id === p.clubId);
    if (seen) seen.sides += 1;
    else unaffiliatedClubs.push({ id: p.clubId, name: p.club.name, sides: 1 });
  }
  const sides = { registered: all.length, affiliated, unaffiliatedClubs };

  // ── Season runs: the running one, else the latest ──
  const runs = input.runs.filter((r) => r.leagueKey === league.key).sort(byNewest);
  const summaries = runs.map((r) => runProgress(r, input.series ?? [], today));
  const run = summaries.find((s) => s.running) ?? summaries[0] ?? null;

  const enoughSides = affiliated >= MIN_SIDES;
  const canStart = problems.length === 0 && enoughSides;
  const status: LeagueReadinessStatus = run?.running
    ? 'running'
    : problems.length
      ? 'needs-setup'
      : !enoughSides
        ? 'needs-sides'
        : 'ready';

  const sidesLine = `${sides.registered} registered, ${sides.affiliated} affiliated`;
  let reason: string;
  let nextStep: string;
  let operatorRequest: string | undefined;
  switch (status) {
    case 'running':
      reason = `season ${run!.seasonLabel} running`;
      nextStep = `Open the season to carry on — ${run!.progress}.`;
      break;
    case 'needs-setup':
      reason = setupReason(problems);
      operatorRequest = operatorRequestFor(league.label, problems, calendarEnded);
      nextStep = problems.includes('no-setup')
        ? 'Ask your operator to set this league up: they choose its structure and season calendar.'
        : problems.includes('calendar-ended') && !missingParts(problems)
          ? 'Ask your operator to renew this league’s season dates.'
          : `Ask your operator to replace the ${missingParts(problems)} this league’s setup points at.`;
      break;
    case 'needs-sides':
      reason = `needs sides — ${sidesLine}`;
      nextStep =
        sides.registered >= MIN_SIDES
          ? `At least ${MIN_SIDES} sides from affiliated clubs are needed. Chase the clubs below to submit their affiliation.`
          : `At least ${MIN_SIDES} sides from affiliated clubs are needed. Clubs register for this league on their affiliation form.`;
      break;
    default:
      reason = 'ready to start';
      nextStep = 'Start the season: pick a season label and the stages are created for you.';
  }

  return {
    league,
    status,
    canStart,
    setup,
    setupProblems: problems,
    calendarEnded,
    sides,
    run,
    reason,
    nextStep,
    operatorRequest,
  };
}

/** Readiness for every league, in catalogue order. */
export function leaguesReadiness(
  leagues: ReadonlyArray<League>,
  input: ReadinessInput,
): LeagueReadiness[] {
  return leagues.map((l) => leagueReadiness(l, input));
}

/** How many leagues are in each status — the Leagues page's summary strip. */
export function readinessCounts(
  list: ReadonlyArray<Pick<LeagueReadiness, 'status'>>,
): Record<LeagueReadinessStatus, number> {
  const counts: Record<LeagueReadinessStatus, number> = {
    ready: 0,
    'needs-setup': 0,
    'needs-sides': 0,
    running: 0,
  };
  for (const r of list) counts[r.status] += 1;
  return counts;
}

/**
 * The summary strip's parts, things to act on first, zero counts left out:
 * "3 ready to start", "2 need operator setup", "1 needs sides", "4 running".
 */
export function readinessSummaryParts(
  counts: Record<LeagueReadinessStatus, number>,
): Array<{ status: LeagueReadinessStatus; count: number; text: string }> {
  const verb = (n: number) => (n === 1 ? 'needs' : 'need');
  const parts: Array<{ status: LeagueReadinessStatus; count: number; text: string }> = [
    { status: 'ready', count: counts.ready, text: 'ready to start' },
    {
      status: 'needs-setup',
      count: counts['needs-setup'],
      text: `${verb(counts['needs-setup'])} operator setup`,
    },
    {
      status: 'needs-sides',
      count: counts['needs-sides'],
      text: `${verb(counts['needs-sides'])} sides`,
    },
    { status: 'running', count: counts.running, text: 'running' },
  ];
  return parts.filter((p) => p.count > 0);
}

/** "3 ready to start · 2 need operator setup · 1 needs sides · 4 running". */
export function readinessSummaryLine(counts: Record<LeagueReadinessStatus, number>): string {
  return readinessSummaryParts(counts)
    .map((p) => `${p.count} ${p.text}`)
    .join(' · ');
}

/** The heading each status reads as on the page. */
export const STATUS_LABEL: Record<LeagueReadinessStatus, string> = {
  running: 'Season running',
  'needs-setup': 'Needs operator setup',
  'needs-sides': 'Needs sides',
  ready: 'Ready to start',
};
