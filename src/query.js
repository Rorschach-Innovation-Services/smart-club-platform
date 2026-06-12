/**
 * Shared TanStack Query client + query-key factory.
 *
 * Keys are tenant-scoped so switching tenants never serves another's cache.
 * Mutations live in main.jsx (so they keep the prototype's handler signatures);
 * they call api.js then invalidate these keys.
 */
import { QueryClient } from '@tanstack/react-query';
import { getActiveTenant } from './api.js';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const t = () => getActiveTenant() ?? 'unknown';

export const qk = {
  tenant: () => ['tenant', t()],
  me: () => ['me', t()],
  clubs: () => ['clubs', t()],
  club: (id) => ['club', t(), id],
  series: () => ['series', t()],
  users: () => ['users', t()],
  players: (clubId) => ['players', t(), clubId],
  clearances: (clubId) => ['clearances', t(), clubId],
  allClearances: () => ['clearances-all', t()],
  clubDirectory: () => ['club-directory', t()],
  signupLink: () => ['signup-link', t()],
};
