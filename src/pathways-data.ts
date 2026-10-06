/**
 * Where the Pathways results come from. A union's results exports are confidential-adjacent
 * (real schools and clubs) and live in src/scouting-local/results/*.csv (git-ignored); with
 * none present (CI, deploys, a fresh clone) the invented Highveld sample is used.
 */
import { parseResults, type PathMatch } from './pathways';
import { SAMPLE_RESULTS_CSV } from './pathways-sample';

const files = import.meta.glob<string>('./scouting-local/results/*.csv', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const seen = new Set<string>();
const local: PathMatch[] = Object.values(files)
  .flatMap((text) => parseResults(text))
  .filter((m) => !seen.has(m.id) && seen.add(m.id))
  .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

export const PATHWAYS_IS_SAMPLE = local.length === 0;
export const PATH_MATCHES: PathMatch[] = PATHWAYS_IS_SAMPLE
  ? parseResults(SAMPLE_RESULTS_CSV)
  : local;
