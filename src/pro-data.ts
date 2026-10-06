/**
 * Where the professional-team data comes from when the platform's match library is empty. The
 * franchise's exports and the scouting pools are confidential and live in src/scouting-local/
 * (git-ignored): scorecards and ball-by-ball as the exports' own CSV files in
 * scouting-local/pro/ (read and paired exactly as an upload would be, src/match-import.ts),
 * pools as scouting-local/pool-*.ts. With none present (CI, deploys, a fresh clone) the
 * invented sample is used.
 */
import { planImport, readFile } from './match-import';
import type { ProMatch } from './pro-scorecards';
import { SAMPLE_POOL, SAMPLE_PRO_MATCHES } from './pro-sample';
import type { ScoutPool } from './scout-pool';

const csvFiles = import.meta.glob<string>('./scouting-local/pro/*.csv', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const localMatches: ProMatch[] = planImport(
  [],
  Object.entries(csvFiles).map(([path, text]) => readFile(path.split('/').pop() ?? path, text)),
).save.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

const poolFiles = import.meta.glob<{ default: ScoutPool }>(
  ['./scouting-local/pool-*.ts', '!./scouting-local/*.test.ts'],
  { eager: true },
);
const localPools = Object.values(poolFiles)
  .map((m) => m.default)
  .filter(Boolean);

export const PRO_IS_SAMPLE = localMatches.length === 0;
export const PRO_MATCHES: ProMatch[] = PRO_IS_SAMPLE ? SAMPLE_PRO_MATCHES : localMatches;
export const POOLS_ARE_SAMPLE = localPools.length === 0;
export const SCOUT_POOLS: ScoutPool[] = localPools.length ? localPools : [SAMPLE_POOL];
