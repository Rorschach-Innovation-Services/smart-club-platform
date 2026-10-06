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
import { ApiError } from './api';
import type { TenantBranding, TransferWindowStatus } from './types';
import { currentSeasonLabel } from './data';
import {
  resolveVertical,
  type ModuleKey,
  type TermKey,
  type VerticalProfile,
  type VerticalTerms,
} from './vertical';

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
  tagline: string;
  support: string;
  footer: string;
}

/**
 * Resolve branding copy with neutral defaults, so every call site renders sensible
 * text before the tenant payload lands (first paint) and for tenants that haven't
 * customised a slot. Mirrors `orgCopy` on the API — keep the chains in sync. The defaults
 * that name the member organisation ("club") come from the vertical's terms, so a football
 * tenant reads "school" without overriding each slot; explicit `branding.copy` still wins.
 */
export function resolveCopy(
  branding?: Partial<TenantBranding> | null,
  terms: VerticalTerms = resolveVertical().terms,
): ResolvedCopy {
  const copy = branding?.copy ?? {};
  const orgName = branding?.name || branding?.title || 'Smart Club';
  const orgShort = copy.orgShort || orgName;
  return {
    orgName,
    orgShort,
    office: copy.office || `${orgShort} office`,
    admin: copy.admin || `${orgShort} administrators`,
    cohortName: copy.cohortName || `${orgShort} cohort`,
    heroTitle: copy.heroTitle || `From your ${terms.club} to the ${orgShort}.`,
    heroBlurb:
      copy.heroBlurb ||
      `Affiliated ${terms.clubs} join the ${orgName} ecosystem — fixtures, talent ID and league readiness, all in one place.`,
    crumbRoot: copy.crumbRoot || orgShort,
    welcome: copy.welcome || 'Sign in',
    eyebrow: copy.eyebrow || orgName,
    // Sport-neutral default: the platform half only. The sport half ("· Cricket
    // Services") is a per-tenant override — never a global default, or football
    // tenants would show the wrong sport. Cricket tenants seed the full string.
    tagline: copy.tagline || 'Smart Club Integration',
    support: copy.support || '',
    footer: copy.footer || 'Powered by Medicoach',
  };
}

/**
 * The one set of GET /tenant query options every observer of qk.tenant() shares, so whichever
 * observer happens to start the fetch gets the same retry net. A function, not a const:
 * qk.tenant() reads the active tenant at call time. Retry: a 404 is NOT transient (the slug
 * names no tenant — common on the wildcard host for an unclaimed subdomain), so don't retry it
 * (also stops subdomain-scanning bots tripling the DynamoDB reads); anything else retries up
 * to twice. staleTime is left to each observer: AppRoutes keeps the client default (focus
 * refresh), the branding hooks below pin Infinity.
 */
export function tenantQueryOptions() {
  return {
    queryKey: qk.tenant(),
    queryFn: api.getTenant,
    retry: (count: number, err: unknown) =>
      !(err instanceof ApiError && err.status === 404) && count < 2,
  };
}

/**
 * Read the tenant payload from the shared react-query cache. staleTime Infinity so
 * these (many) hook instances never trigger their own refetch — main.tsx owns the
 * fetch/refresh lifecycle on the same key.
 */
function useTenantPayload() {
  const { data } = useQuery({ ...tenantQueryOptions(), staleTime: Infinity });
  return data;
}

/**
 * True once GET /tenant has settled (success or error). Pages that must not paint the cricket
 * fallback for a non-cricket tenant (e.g. the public registration form) gate on this. Uses the
 * shared tenantQueryOptions (queryFn + 404-aware retry): in the app AppRoutes already observes
 * the same key (no duplicate fetch), but a page mounted without it (tests) still fetches rather
 * than waiting forever — and a transient failure is retried before it counts as settled.
 */
export function useTenantSettled(): boolean {
  const q = useQuery({ ...tenantQueryOptions(), staleTime: Infinity });
  return q.isSuccess || q.isError;
}

/** Resolved org copy for the active tenant (neutral defaults until branding loads). */
export function useCopy(): ResolvedCopy {
  const tenant = useTenantPayload();
  return resolveCopy(tenant?.branding, resolveVertical(tenant).terms);
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

/** The active tenant's sport vertical profile (cricket until the payload loads / when unset). */
export function useVertical(): VerticalProfile {
  return resolveVertical(useTenantPayload());
}

/**
 * Whether a module (veterans / cqi / compliance / clearances) is on — mirrors the API's
 * hasModule: the `module.<key>` flag when stored, else the vertical's default.
 */
export function useModule(module: ModuleKey): boolean {
  const tenant = useTenantPayload();
  const v = tenant?.features?.[`module.${module}`];
  return typeof v === 'boolean' ? v : resolveVertical(tenant).moduleDefaults[module];
}

/** One vertical term, e.g. useTerm('Club') ⇒ 'Club' (cricket) / 'School' (football). */
export function useTerm(key: TermKey): string {
  return useVertical().terms[key];
}

/**
 * The SERVER-computed transfer-window status for today (absent ⇒ no windows ⇒ unrestricted).
 * Never derive this from the device clock.
 */
export function useTransferWindowStatus(): TransferWindowStatus | undefined {
  return useTenantPayload()?.transferWindowStatus;
}

/** The tenant's display season label; absent ⇒ the built-in current season label. */
export function useSeasonLabel(): string {
  return useTenantPayload()?.seasonLabel?.trim() || currentSeasonLabel();
}
