/**
 * What the admin is told when `POST /season-runs/:id/stages/:specId/generate` refuses with a
 * structured 409. The generic "refresh" line is right for a version race, but these two
 * carry something the admin can act on, so they get their own copy.
 */
import { ApiError } from './api';
import type { Clash } from './types';

/** How many clashes a toast names before summarising the rest. */
const MAX_LISTED = 3;

/** One clash as a line: "Round 3 · Kingsmead · Home v Away clashes with <series>". */
export function describeClash(c: Clash): string {
  const parts: string[] = [];
  if (c.round != null) parts.push(`Round ${c.round}`);
  if (c.ground) parts.push(c.ground);
  if (c.home || c.away) parts.push(`${c.home ?? '?'} v ${c.away ?? '?'}`);
  return `${parts.join(' · ')} clashes with ${c.with.seriesName || c.with.seriesId}`;
}

/**
 * The toast for a generate refusal, or `null` when the error is not one of the structured
 * generate 409s (the caller then falls back to its generic copy).
 */
export function generateConflictMessage(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  if (err.code === 'released_overwrite')
    return "Some of this stage's fixtures are released; the console will ask before replacing them";
  if (err.code === 'venue_clash') {
    const clashes = (err.details?.clashes as Clash[] | undefined) ?? [];
    if (!clashes.length) return `${err.message}. Fix these in the fixtures list`;
    const listed = clashes.slice(0, MAX_LISTED).map(describeClash);
    const more = clashes.length - listed.length;
    return `${listed.join('; ')}${more > 0 ? ` (and ${more} more)` : ''}. Fix these in the fixtures list`;
  }
  return null;
}
