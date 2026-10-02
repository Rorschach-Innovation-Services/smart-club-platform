/**
 * Shared contact resolution for club notices. Kept free of the Hono app (index.ts) so non-HTTP
 * entry points — e.g. the fixture-reminders cron — can resolve a chair without dragging the
 * whole API bundle and its top-level side effects in.
 */
import type { Club } from '../types.js';

/**
 * The chair contact for a club's notices: the `exco.chair` sub-record (name/email/cell), falling
 * back to the flat `club.chair` name when exco has no chair name. `exco` is loosely typed here
 * (it also carries governance fields we never notify on) so we read only the three contact fields.
 */
export function chairContactOf(club: Club): { name: string; email?: string; cell?: string } {
  const chair = (
    club.exco as Record<string, { email?: string; cell?: string; name?: string }> | undefined
  )?.chair;
  return { name: chair?.name || club.chair || '', email: chair?.email, cell: chair?.cell };
}
