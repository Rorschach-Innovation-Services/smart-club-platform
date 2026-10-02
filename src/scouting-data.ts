/**
 * Scouting datasets — one ScoutingEvent per league or tournament with ball-by-ball or
 * scorecard stats (from Medicoach Live exports). The platform itself holds fixtures, not
 * scores, so performance data arrives as a prepared dataset; every dashboard derives from
 * these fields. Real data is confidential (selection use) and kept out of the repo.
 */

import { SAMPLE_TOURNAMENT, SAMPLE_CLUB_MATCH } from './scouting-sample';
import type { ScoutMatch } from './scouting-matches';

export type HubCode = string;

export interface ScoutPlayer {
  name: string;
  hub: HubCode;
  /** Matches in which the player batted, bowled or fielded. */
  m: number;
  runs: number | null;
  balls: number | null;
  /** High score; a trailing * means not out. */
  hs: string | null;
  avg: number | null;
  sr: number | null;
  fours: number | null;
  sixes: number | null;
  ballsBowled: number | null;
  wkts: number | null;
  runsConceded: number | null;
  econ: number | null;
  best: string | null;
  ct: number | null;
  st: number | null;
  ro: number | null;
}

export interface ScoutTeamResult {
  date: string;
  event: string;
  stage: string;
  opp: HubCode;
  overs: number;
  batted: string;
  scored: string;
  conceded: string;
  result: string;
}

export interface ScoutTeam {
  code: HubCode;
  name: string;
  placing: string;
  played: number;
  won: number;
  lost: number;
  runsScored: number;
  runRate: number;
  runsConceded: number;
  concededRate: number;
  wickets: number;
  extrasConceded: number;
  /** League-table position — tournaments only. */
  fiftyOver?: { pos: number; p: number; w: number; l: number; pts: number; nrr: string };
  t20Placing?: string;
  discipline: {
    legalBalls: number;
    wides: number;
    noBalls: number;
    extras: number;
    extrasPer10: number;
  };
  results: ScoutTeamResult[];
}

export interface ScoutFixture {
  date: string;
  event: string;
  stage: string;
  overs: number;
  venue: string;
  battingFirst: string;
  chasing: string;
  result: string;
}

export type Recommendation = 'Priority selection' | 'Extended squad' | 'Monitor';

export interface ScoutProfile {
  kind: 'batter' | 'bowler';
  rank: number;
  name: string;
  hub: HubCode;
  role: string;
  /** Scout index (0–100) from the source report's group-stage scouting profiles. */
  index: number;
  recommendation: Recommendation;
  nextStep: string;
}

export interface ScoutingEvent {
  id: string;
  kind: 'tournament' | 'league';
  name: string;
  ageGroup: string;
  competitions: string[];
  dates: { from: string; to: string };
  venue: string;
  source: string;
  totals: {
    matches: number;
    hubs: number;
    players: number;
    legalBalls: number;
    overs: string;
    runs: number;
    wickets: number;
    runRate: number;
    extras: number;
    fours: number;
    sixes: number;
    dotPct: number;
  };
  /** Per-competition comparison (source report §1.1). */
  byCompetition: {
    label: string;
    matches: number;
    players: number;
    runs: number;
    wickets: number;
    runRate: number;
    dotPct: number;
    extrasPct: number;
  }[];
  champions: { competition: string; team: HubCode }[];
  players: ScoutPlayer[];
  teams: ScoutTeam[];
  fixtures: ScoutFixture[];
  profiles: ScoutProfile[];
  /** Match-by-match scorecards (summary-only where the source has none). */
  matches: ScoutMatch[];
}

/**
 * Real datasets live in src/scouting-local/*.ts (git-ignored — they hold minors' names
 * and confidential selection notes), each default-exporting a ScoutingEvent. When none
 * are present (a fresh clone, CI, deploys) the anonymised samples are used.
 */
const local = Object.values(
  import.meta.glob<{ default: ScoutingEvent }>('./scouting-local/*.ts', { eager: true }),
)
  .map((m) => m.default)
  .filter(Boolean)
  .sort((a, b) => b.dates.to.localeCompare(a.dates.to));

export const SCOUTING_EVENTS: ScoutingEvent[] = local.length
  ? local
  : [SAMPLE_TOURNAMENT, SAMPLE_CLUB_MATCH];
