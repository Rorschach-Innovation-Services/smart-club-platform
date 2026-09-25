/**
 * Knockout forward references — the server-side entry point.
 *
 * A knockout bracket's later rounds reference earlier fixtures by a reserved-prefix
 * pseudo-id (`win:f3`) because the winner isn't known when fixtures are generated, and
 * the platform has no results model. See ADR 0008.
 *
 * The labelling itself lives in the engine (packages/engine/src/formats.ts), the same code
 * the admin and club fixture views run, so a club reading "Winner of Semi-final 1" in the
 * portal sees the same words in its emailed schedule. This wrapper only adapts the API's
 * loosely typed inputs (a stored series' `fixtures: unknown[]`, an arbitrary team id).
 */
import { slotRefLabel as engineSlotRefLabel, type SlotFixture } from '../../engine/src/formats.js';

/**
 * A human label for a forward reference — "Winner of Semi-final 1", or `null` when the
 * id is an ordinary team. Without this a broadcast schedule reads "TBA vs TBA" for every
 * fixture past the first knockout round.
 */
export function slotRefLabel(id: unknown, fixtures: unknown[] = []): string | null {
  if (typeof id !== 'string') return null;
  return engineSlotRefLabel(id, (Array.isArray(fixtures) ? fixtures : []) as SlotFixture[]);
}
