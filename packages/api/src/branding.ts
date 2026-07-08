/**
 * Org-copy resolution — the single fallback chain from a tenant's branding to the
 * display strings the API interpolates (emails, invite copy, signup responses).
 * The frontend ships a twin resolver (src/branding.ts `resolveCopy`) with the SAME
 * slot names and fallbacks — keep them in lockstep.
 */
import type { TenantConfig } from './types.js';

/** Resolved org identity — every field is guaranteed non-empty. */
export interface OrgCopy {
  /** Full org display name, e.g. "Hollywoodbets Dolphins". */
  name: string;
  /** Header/<title> name, e.g. "Dolphins Pipeline". */
  title: string;
  /** Short handle for compound copy, e.g. "Dolphins". */
  orgShort: string;
  /** Sign-off/contact label, e.g. "Dolphins office". */
  office: string;
  /** Cohort label, e.g. "Dolphins Pipeline cohort". */
  cohort: string;
}

/**
 * Resolve a tenant's org copy with graceful fallbacks, so a minimally-configured
 * (or missing) tenant still yields sensible neutral strings:
 *
 *   name     = branding.name || branding.title || cfg.tenant || 'Smart Club'
 *   title    = branding.title || name
 *   orgShort = copy.orgShort || name
 *   office   = copy.office || `${orgShort} office`
 *   cohort   = copy.cohortName || `${orgShort} cohort`
 *
 * Accepts a partial config (or null) so callers that only hold a slug — or whose
 * config read failed — can still resolve, falling back to the slug / 'Smart Club'.
 */
export function orgCopy(cfg?: Partial<Pick<TenantConfig, 'branding' | 'tenant'>> | null): OrgCopy {
  const branding = cfg?.branding;
  const copy = branding?.copy ?? {};
  const name = branding?.name || branding?.title || cfg?.tenant || 'Smart Club';
  const title = branding?.title || name;
  const orgShort = copy.orgShort || name;
  const office = copy.office || `${orgShort} office`;
  const cohort = copy.cohortName || `${orgShort} cohort`;
  return { name, title, orgShort, office, cohort };
}
