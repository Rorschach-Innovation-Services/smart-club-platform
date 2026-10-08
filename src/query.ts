/**
 * Shared TanStack Query client + query-key factory.
 *
 * Keys are tenant-scoped so switching tenants never serves another's cache.
 * Mutations live in main.jsx (so they keep the prototype's handler signatures);
 * they call api.js then invalidate these keys.
 */
import { QueryClient } from '@tanstack/react-query';
import { getActiveTenant } from './api';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      // Refresh when the user returns to the tab so a screen left open updates
      // without navigating. Gated by staleTime (30s), so it never fires inside the
      // sub-second GSI-write window that the clubs/club setQueryData seeds protect.
      refetchOnWindowFocus: true,
    },
  },
});

const t = () => getActiveTenant() ?? 'unknown';

export const qk = {
  tenant: () => ['tenant', t()],
  // Global, not tenant-scoped: a certificate serial resolves its own tenant server-side.
  certificateVerify: (serial: string) => ['certificate-verify', serial],
  me: () => ['me', t()],
  clubs: () => ['clubs', t()],
  club: (id: string) => ['club', t(), id],
  series: () => ['series', t()],
  seasonRuns: () => ['season-runs', t()],
  venues: () => ['venues', t()],
  umpires: () => ['umpires', t()],
  captainsReports: () => ['captains-reports', t()],
  captainsReportContactGaps: () => ['captains-report-contact-gaps', t()],
  medicoachSync: () => ['medicoach-sync', t()],
  medicoachPlayerReviews: () => ['medicoach-sync', t(), 'player-reviews'],
  clubCaptainsReports: (clubId: string) => ['club-captains-reports', t(), clubId],
  clubCaptainsReport: (id: string) => ['club-captains-report', t(), id],
  // Every clubCaptainsReport entry, for invalidation; must match its first element.
  clubCaptainsReportPrefix: () => ['club-captains-report'],
  // Global: the token names its own tenant.
  linkedCaptainsReport: (token: string) => ['captains-report-link', token],
  tenantConfig: () => ['tenant-config', t()],
  users: () => ['users', t()],
  players: (clubId: string) => ['players', t(), clubId],
  // Prefix of every club's roster query — invalidates them all at once (tenant-wide erasure).
  playersAll: () => ['players', t()],
  clearances: (clubId: string) => ['clearances', t(), clubId],
  // Prefix of every club's clearance query.
  clearancesAllClubs: () => ['clearances', t()],
  allClearances: () => ['clearances-all', t()],
  allRegistrationReviews: () => ['registration-reviews-all', t()],
  demographics: () => ['demographics', t()],
  clubDirectory: () => ['club-directory', t()],
  veteransAffiliates: (clubId: string) => ['veterans-affiliates', t(), clubId],
  // Veterans squad-selection requests (ADR 0013): a club's inbound (it is the primary club) +
  // outbound (it is the veterans club) requests; and the admin cohort-wide list.
  veteransRequests: (clubId: string) => ['veterans-requests', t(), clubId],
  allVeteransRequests: () => ['veterans-requests-all', t()],
  // The finder search is keyed on the (debounced) query so each term caches independently.
  veteransCandidates: (clubId: string, q: string) => ['veterans-candidates', t(), clubId, q],
  // Fixture postponements (ADR 0015): a club's inbound + outbound requests; the admin list;
  // and the date picker's clash hints, keyed on the candidate move.
  postponements: (clubId: string) => ['postponements', t(), clubId],
  allPostponements: () => ['postponements-all', t()],
  clashHints: (clubId: string, seriesId: string, fixtureId: string, date: string, time: string) => [
    'clash-hints',
    t(),
    clubId,
    seriesId,
    fixtureId,
    date,
    time,
  ],
  signupLink: () => ['signup-link', t()],
  // Operator portal keys are deliberately NOT tenant-scoped: /platform/* is
  // tenant-independent (the slug in the key names the MANAGED tenant, not the host's).
  platformTenants: () => ['platform-tenants'],
  platformTenant: (slug: string) => ['platform-tenant', slug],
  platformTenantOverview: (slug: string) => ['platform-tenant-overview', slug],
  platformTenantReps: (slug: string) => ['platform-tenant-reps', slug],
  // Cross-tenant.
  platformCaptainsReportScorecards: (days: number, status: string, tenant: string) => [
    'platform-captains-report-scorecards',
    days,
    status,
    tenant,
  ],
};
