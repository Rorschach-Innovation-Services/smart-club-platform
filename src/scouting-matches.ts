/** Match scorecard types (Medicoach Live). Team fields are team codes. */

export interface ScoutBatRow {
  n: string;
  pos: number;
  r: number;
  b: number;
  f4: number;
  f6: number;
  /** Dismissal as scored, e.g. "c Name b Name", "b Name", "run out", "not out". */
  out: string;
}
export interface ScoutBowlRow {
  n: string;
  o: string;
  m: number;
  r: number;
  w: number;
  wd: number;
  nb: number;
  dots: number;
}
export interface ScoutInnings {
  bat: string;
  fld: string;
  total: number;
  wkts: number;
  overs: string;
  extras: number;
  exb: { w: number; nb: number; b: number; lb: number };
  batting: ScoutBatRow[];
  bowling: ScoutBowlRow[];
  fow: { wkt: number; score: number; batter: string; over: string }[];
  /** [over number, runs in the over, wickets in the over] */
  perOver: [number, number, number][];
  /**
   * Ball by ball, when the source has it (Medicoach Live):
   * [over, ball, batter, bowler, runs off bat, extra type, extra runs, wicket 0/1, zone].
   * Zone is 0–7 in Medicoach's order (third man … fine leg), -1 when no scoring shot.
   */
  balls?: [number, number, string, string, number, string, number, number, number][];
}
export interface ScoutMatch {
  id: string;
  date: string;
  /** Format, e.g. 'T20', '50-Over', 'T50'. */
  event: string;
  stage: string;
  overs: number;
  venue: string;
  home: string;
  away: string;
  winner: string | null;
  result: string;
  innings: ScoutInnings[] | null;
  summary?: { bat: string; total: number; wkts: number; overs: string }[];
}
