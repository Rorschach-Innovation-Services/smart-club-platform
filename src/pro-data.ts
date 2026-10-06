/**
 * Where the professional-team data comes from. The franchise's scorecard CSVs and the scouting
 * pools are confidential and live in src/scouting-local/ (git-ignored): scorecards as the
 * export's own CSV files in scouting-local/pro/, pools as scouting-local/pool-*.ts. With none
 * present (CI, deploys, a fresh clone) the invented sample is used.
 */
import { parseScorecards, type ProMatch } from './pro-scorecards';
import { SAMPLE_POOL, SAMPLE_PRO_MATCHES } from './pro-sample';
import type { ScoutPool } from './scout-pool';

const csvFiles = import.meta.glob<string>('./scouting-local/pro/*.csv', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const localMatches = parseScorecards(
  Object.entries(csvFiles).map(([path, text]) => ({ name: path.split('/').pop() ?? path, text })),
);

const poolFiles = import.meta.glob<{ default: ScoutPool }>(
  ['./scouting-local/pool-*.ts', '!./scouting-local/*.test.ts'],
  { eager: true },
);
const localPools = Object.values(poolFiles)
  .map((m) => m.default)
  .filter(Boolean);

export const PRO_IS_SAMPLE = localMatches.length === 0;
export const PRO_MATCHES: ProMatch[] = PRO_IS_SAMPLE ? SAMPLE_PRO_MATCHES : localMatches;
export const SCOUT_POOLS: ScoutPool[] = localPools.length ? localPools : [SAMPLE_POOL];
