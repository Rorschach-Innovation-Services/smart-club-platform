/**
 * Public web-address label → tenant resolution (ADR 0024).
 *
 * The slug is a tenant's fixed internal ID; its web address uses a separate label that an
 * operator can change (`westernprovincecricket` served at `cobras.club.medicoach.co.za`). One
 * rule for every label a client presents (Host, Origin, dev `x-tenant`, `?tenant=`):
 *
 *   1. a `PUBLICADDR#<label>` record exists: `active` → its tenant; `retired` → unknown
 *   2. else a `TENANT#<label>` CONFIG row exists → that tenant (never renamed: label = slug)
 *   3. else unknown
 *
 * Caching: hits only, 60s TTL, bounded. A miss is never cached (it costs two GetItems and the
 * key is caller-supplied, so caching misses would let a caller fill the cache), and a thrown
 * read is never cached and propagates — resolution fails closed (500), it never guesses.
 * Known limit: after an address change, OTHER warm containers keep honouring (and building
 * links to) the old label for up to the TTL; this container clears its cache at once.
 *
 * repo.ts is imported lazily: auth.ts (and through it every module that imports HttpError) and
 * origins.ts depend on this file, and repo reads TABLE_NAME at load, which pure modules and
 * their unit tests do not set.
 */

const TTL_MS = 60_000;
const MAX_ENTRIES = 500;

/** A presentable label: one lowercase DNS label. Anything else is unknown without a read. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type Entry = { value: string; expires: number };
const labelToTenant = new Map<string, Entry>();
const tenantToLabel = new Map<string, Entry>();

const repo = () => import('./repo.js');

function cacheGet(map: Map<string, Entry>, key: string): string | undefined {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(map: Map<string, Entry>, key: string, value: string): void {
  map.delete(key);
  // Bounded: evict the oldest insertion (Map keeps insertion order).
  while (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value as string);
  map.set(key, { value, expires: Date.now() + TTL_MS });
}

/** Drop every cached resolution in this container (address change, tenant create/erase, tests). */
export function clearPublicAddressCache(): void {
  labelToTenant.clear();
  tenantToLabel.clear();
}

/**
 * The tenant a presented label belongs to, or null when the label is unknown or retired.
 * Throws on a DynamoDB error (fail closed).
 */
export async function resolvePublicLabel(label: string): Promise<string | null> {
  if (!LABEL_RE.test(label)) return null;
  const cached = cacheGet(labelToTenant, label);
  if (cached) return cached;
  const r = await repo();
  const [record, config] = await Promise.all([
    r.getPublicLabelRecord(label),
    r.getTenantConfig(label),
  ]);
  let tenant: string | null = null;
  if (record) tenant = record.status === 'active' ? record.tenant : null;
  else if (config) tenant = label;
  if (tenant) cacheSet(labelToTenant, label, tenant);
  return tenant;
}

/**
 * The label a tenant's web address uses: its address record's `publicSlug`, else its slug.
 * Cached like resolvePublicLabel (the value always exists, so every read is a hit). Throws on a
 * DynamoDB error.
 */
export async function publicLabelFor(tenant: string): Promise<string> {
  const cached = cacheGet(tenantToLabel, tenant);
  if (cached) return cached;
  const address = await (await repo()).getTenantPublicAddress(tenant);
  const label = address?.publicSlug ?? tenant;
  cacheSet(tenantToLabel, tenant, label);
  return label;
}
