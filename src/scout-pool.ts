/**
 * A scouting pool: players rated elsewhere (a national scouting report, a club league) that a
 * professional team can track and consider for a call-up. Indices are on the source report's
 * own scale — 100 = that player's league average — so they compare players within a pool, not
 * across leagues of different strength (the report says the same: no league-strength
 * adjustment).
 *
 * Real pools are confidential and live in src/scouting-local/pool-*.ts (git-ignored); the
 * anonymised sample below is used when none are present.
 */

export type PoolRole = 'Batter' | 'Bowler' | 'All-rounder' | 'Wicketkeeper';

export interface PoolPlayer {
  name: string;
  club: string;
  /** Provincial union, e.g. "Gauteng". */
  union: string;
  league?: string;
  role: PoolRole;
  games: number | null;
  bat?: {
    inns?: number;
    runs: number;
    balls: number;
    sr: number;
    avg?: number | null;
    hs?: string;
    fours?: number;
    sixes?: number;
    /** Strike-rate index, 100 = league average. */
    srIdx?: number;
    /** Batting index (runs per innings × strike rate), 100 = league average. */
    batIdx?: number;
  };
  bowl?: {
    overs: string;
    runs: number;
    wkts: number;
    econ: number;
    dotPct?: number;
    best?: string;
    type?: string;
    /** Bowling index (economy × wicket rate), 100 = league average. */
    bowlIdx?: number;
  };
  /** Catches, stumpings and run-outs. */
  fielding?: number;
  /** The report's overall impact score (per game, all disciplines). */
  impact?: number;
  /** The report lists the player appears in, e.g. "Top 30 impact", "Powerplay hitters". */
  lists: string[];
  /** The scout's note, when the report profiles the player. */
  note?: string;
}

export interface ScoutPool {
  id: string;
  name: string;
  gender: 'men' | 'women';
  format: string;
  source: string;
  /** When the report was compiled (ISO date). */
  date: string;
  players: PoolPlayer[];
}
