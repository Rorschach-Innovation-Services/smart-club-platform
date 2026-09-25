/**
 * What the admin is told when `POST /season-runs/:id/stages/:specId/generate` refuses with a
 * structured 409. The generic "refresh" line is right for a version race, but these
 * carry something the admin can act on, so each gets its own copy: what happened, then
 * what to do. The rest of the season/fixtures copy lives beside this, in `error-copy.ts`.
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
 * generate refusals (the caller then falls back to its generic copy). A refusal that landed
 * after some groups were already written (`details.written`) always says which, whatever
 * else it is — the stage is then half-replaced, not untouched.
 */
export function seasonConflictMessage(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const base = structuredConflictMessage(err);
  const written = err.details?.written;
  if (Array.isArray(written) && written.length)
    return `${(base ?? err.message).replace(/\.$/, '')}. ${written.length} series ${written.length === 1 ? 'was' : 'were'} already replaced: ${written.join(', ')}`;
  return base;
}

function structuredConflictMessage(err: ApiError): string | null {
  if (err.status !== 409) return null;
  if (err.code === 'awaiting_entrants')
    return "This stage's teams haven't been confirmed yet. Open the stage and Confirm entrants first.";
  if (err.code === 'does_not_fit') return doesNotFitMessage(err.message);
  if (err.code === 'no_block')
    return 'This stage points at a playing block that no longer exists on the calendar. Ask your operator to fix the structure\'s "Plays in" setting.';
  if (err.code === 'competition_unbound')
    return "This league's competition was removed from the operator console. Quick-start a new season, or ask your operator to re-bind one.";
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

/**
 * The materialisation summary names the group, the block and the shortfall, and usually
 * already ends with the engine's own advice ("Shorten the cadence, start earlier, or
 * extend Block 1.") — so the advice is added only when the summary has none.
 */
function doesNotFitMessage(summary: string): string {
  const detail = summary.trim().replace(/\.$/, '');
  if (/shorten the cadence/i.test(detail))
    return `The fixtures don't fit the playing block: ${detail}.`;
  return `The fixtures don't fit the playing block: ${detail}. Shorten the cadence, reduce rounds, or extend the block in the season calendar.`;
}
