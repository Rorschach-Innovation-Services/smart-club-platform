/**
 * Tenant org copy + feature flags.
 *
 * `resolveCopy` is the frontend twin of the API's `orgCopy` (packages/api/src/branding.ts):
 * both implement the same fallback chain over `branding.copy` so emails and UI copy agree.
 * `useCopy`/`useFeature` read the already-populated `qk.tenant()` react-query cache
 * (fetched once by AppRoutes in main.tsx) — cache hits only, no extra network traffic
 * and no prop threading through Shell.
 */
import { useQuery } from '@tanstack/react-query';
import { qk } from './query';
import * as api from './api';
import type { TenantBranding } from './types';

/** The resolved, never-undefined copy slots the UI renders. */
export interface ResolvedCopy {
  orgName: string;
  orgShort: string;
  office: string;
  admin: string;
  cohortName: string;
  heroTitle: string;
  heroBlurb: string;
  crumbRoot: string;
  welcome: string;
  eyebrow: string;
  support: string;
  footer: string;
}

/**
 * Resolve branding copy with neutral defaults, so every call site renders sensible
 * text before the tenant payload lands (first paint) and for tenants that haven't
 * customised a slot. Mirrors `orgCopy` on the API — keep the chains in sync.
 */
export function resolveCopy(branding?: Partial<TenantBranding> | null): ResolvedCopy {
  const copy = branding?.copy ?? {};
  const orgName = branding?.name || branding?.title || 'Smart Club';
  const orgShort = copy.orgShort || orgName;
  return {
    orgName,
    orgShort,
    office: copy.office || `${orgShort} office`,
    admin: copy.admin || `${orgShort} administrators`,
    cohortName: copy.cohortName || `${orgShort} cohort`,
    heroTitle: copy.heroTitle || `From your club to the ${orgShort}.`,
    heroBlurb:
      copy.heroBlurb ||
      `Affiliated clubs join the ${orgName} ecosystem — fixtures, talent ID and league readiness, all in one place.`,
    crumbRoot: copy.crumbRoot || orgShort,
    welcome: copy.welcome || 'Sign in',
    eyebrow: copy.eyebrow || orgName,
    support: copy.support || '',
    footer: copy.footer || 'Powered by Medicoach',
  };
}

/**
 * Read the tenant payload from the shared react-query cache. staleTime Infinity so
 * these (many) hook instances never trigger their own refetch — main.tsx owns the
 * fetch/refresh lifecycle on the same key.
 */
function useTenantPayload() {
  const { data } = useQuery({
    queryKey: qk.tenant(),
    queryFn: api.getTenant,
    retry: 0,
    staleTime: Infinity,
  });
  return data;
}

/** Resolved org copy for the active tenant (neutral defaults until branding loads). */
export function useCopy(): ResolvedCopy {
  return resolveCopy(useTenantPayload()?.branding);
}

/**
 * Per-tenant feature flag from the GET /tenant payload; absent key ⇒ `def`.
 * Mirrors the API's hasFeature: only an explicit boolean counts — any other
 * value (corrupt row, string "false", etc.) falls back to the default.
 */
export function useFeature(key: string, def = false): boolean {
  const v = useTenantPayload()?.features?.[key];
  return typeof v === 'boolean' ? v : def;
}
