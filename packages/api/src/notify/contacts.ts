/**
 * Shared contact resolution for club notices. Kept free of the Hono app (index.ts) so non-HTTP
 * entry points — e.g. the fixture-reminders cron — can resolve a chair without dragging the
 * whole API bundle and its top-level side effects in.
 *
 * The single implementation lives in `../club-contacts.ts` (also used by the captain's-report
 * recipient fallback); this module re-exports it for the notify-side callers.
 */
export { chairContactOf } from '../club-contacts.js';
