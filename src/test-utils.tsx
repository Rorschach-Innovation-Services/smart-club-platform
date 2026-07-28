/**
 * Shared helpers for the component suites.
 *
 * The only thing here is a render that supplies the app's real providers. Components deep
 * in `admin.tsx` read tenant copy through react-query, and the alternative to giving them
 * a real QueryClient is mocking a hook — which would test the mock, not the component.
 */
import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';

/**
 * A client configured for tests: no retries (a failure should surface immediately rather
 * than after three silent attempts) and no caching between renders, so one suite's data
 * can never leak into the next.
 */
export function testQueryClient(seed?: Array<[readonly unknown[], unknown]>) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  for (const [key, value] of seed ?? []) client.setQueryData(key, value);
  return client;
}

/** `render` with the providers the app mounts in production. */
export function renderWithProviders(
  ui: ReactElement,
  { seed }: { seed?: Array<[readonly unknown[], unknown]> } = {},
) {
  const client = testQueryClient(seed);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...render(ui, { wrapper }) };
}
