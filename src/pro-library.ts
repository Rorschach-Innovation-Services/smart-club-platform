/**
 * The matches the professional-team pages work from: the platform's match library (uploaded
 * by the operator, shared by every union) when it has any; otherwise the local files or the
 * invented sample (pro-data.ts). The page loads them once and hands them down by context.
 */
import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getProMatches } from './api';
import { PRO_IS_SAMPLE, PRO_MATCHES } from './pro-data';
import type { ProMatch } from './pro-scorecards';
import { qk } from './query';

export type ProSource = 'library' | 'local' | 'sample';

export interface ProData {
  matches: ProMatch[];
  source: ProSource;
  loading: boolean;
  /** Matches with every delivery. */
  withBalls: number;
}

const ballsIn = (ms: ProMatch[]) =>
  ms.filter((m) => (m.innings ?? []).some((i) => (i.balls?.length ?? 0) > 0)).length;

const fallback = (): ProData => ({
  matches: PRO_MATCHES,
  source: PRO_IS_SAMPLE ? 'sample' : 'local',
  loading: false,
  withBalls: ballsIn(PRO_MATCHES),
});

export function useProMatches(): ProData {
  const q = useQuery({
    queryKey: qk.proMatches(),
    queryFn: getProMatches,
    staleTime: 10 * 60_000,
    retry: false,
  });
  if (q.isPending) return { ...fallback(), loading: true };
  const lib = q.data ?? [];
  if (!lib.length) return fallback();
  const matches = [...lib].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return { matches, source: 'library', loading: false, withBalls: ballsIn(matches) };
}

const Ctx = createContext<ProMatch[] | null>(null);
export const ProMatchesProvider = Ctx.Provider;
/** Every match (all franchises) the page was given; the fallback outside a provider. */
export const useAllProMatches = () => useContext(Ctx) ?? PRO_MATCHES;
