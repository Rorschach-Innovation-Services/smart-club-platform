/**
 * ScorecardConfirmations cron entry point (sst.config.ts `ScorecardConfirmations`, Mondays
 * 05:00 UTC = 07:00 SAST). The run itself lives in `scorecard-confirmations-run.ts` so the API's
 * operator route can share it without loading this Lambda wrapper.
 */
import '../instrument.js'; // MUST be first — inits Sentry before any client is built
import { Sentry } from '../instrument.js';
import { runScorecardConfirmations } from './scorecard-confirmations-run.js';

export * from './scorecard-confirmations-run.js';

// wrapHandler flushes queued Sentry events before the Lambda returns and captures anything that
// escapes the run (e.g. the tenant-registry read).
export const handler = Sentry.wrapHandler(async () => runScorecardConfirmations());
