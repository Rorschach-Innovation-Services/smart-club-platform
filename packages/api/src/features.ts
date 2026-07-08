/**
 * Per-tenant feature flags, stored as `TenantConfig.features` (a plain boolean map)
 * and read through hasFeature() so each flag carries its own default — absent flags
 * never mean "off" universally. Known flags and their defaults are documented on
 * the TenantConfig type (types.ts).
 */
import type { TenantConfig } from './types.js';

/**
 * Read a tenant feature flag. Returns the stored boolean when present, else `def`.
 * Tolerates a null/undefined config (e.g. a failed config read) and non-boolean
 * junk on the row (falls back to the default rather than truthiness).
 */
export function hasFeature(
  cfg: TenantConfig | null | undefined,
  key: string,
  def = false,
): boolean {
  const value = cfg?.features?.[key];
  return typeof value === 'boolean' ? value : def;
}
