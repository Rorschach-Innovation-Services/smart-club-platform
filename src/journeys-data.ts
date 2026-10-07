/**
 * Where the player journeys come from. A union's own records of who played where (school, club,
 * representative weeks, the franchise) are confidential and live in src/scouting-local/ as
 * `journeys*.ts` files exporting `JOURNEY_PLAYERS: JourneyPlayer[]` (git-ignored). With none
 * present (CI, deploys, a fresh clone, or before the union has supplied them) an invented set of
 * players is used, and the pages say so.
 */
import type { JourneyPlayer } from './journeys';
import { samplePlayers } from './journeys-sample';

const files = import.meta.glob<{ JOURNEY_PLAYERS?: JourneyPlayer[] }>(
  './scouting-local/journeys*.ts',
  { eager: true },
);

const local: JourneyPlayer[] = Object.values(files).flatMap((m) => m.JOURNEY_PLAYERS ?? []);

export const JOURNEYS_ARE_SAMPLE = local.length === 0;
export const JOURNEY_PLAYERS: JourneyPlayer[] = JOURNEYS_ARE_SAMPLE ? samplePlayers() : local;
