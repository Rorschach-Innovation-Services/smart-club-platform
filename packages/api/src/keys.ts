/**
 * DynamoDB key builders — the single source of truth for the tenant-scoped
 * single-table layout. Every tenant-owned item is partitioned under
 * `TENANT#<t>#…`; this prefix IS the tenant-isolation boundary, so all reads and
 * writes must go through these helpers and never hand-build a key.
 *
 * See docs/architecture/data-model.md for the full access-pattern → key mapping.
 */

export type EntityType = 'CLUB' | 'SERIES' | 'USER';

const tenantPrefix = (tenant: string) => `TENANT#${tenant}`;

/** Tenant config item (branding, deadline, knownClubs, requiredDocs override). */
export const tenantConfigKey = (tenant: string) => ({
  pk: tenantPrefix(tenant),
  sk: 'CONFIG',
});

/** A single club. */
export const clubKey = (tenant: string, clubId: string) => ({
  pk: `${tenantPrefix(tenant)}#CLUB#${clubId}`,
  sk: 'META',
});

/** gsi1 attributes that make a club listable within its tenant. */
export const clubGsi1 = (tenant: string, name: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#CLUB`,
  gsi1sk: name,
});

/** gsi1pk used to query every club in a tenant. */
export const clubsListGsi1pk = (tenant: string) => `${tenantPrefix(tenant)}#TYPE#CLUB`;

/** A single series (fixtures embedded). */
export const seriesKey = (tenant: string, seriesId: string) => ({
  pk: `${tenantPrefix(tenant)}#SERIES#${seriesId}`,
  sk: 'META',
});

export const seriesGsi1 = (tenant: string, startDate: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#SERIES`,
  gsi1sk: startDate ?? '',
});

export const seriesListGsi1pk = (tenant: string) => `${tenantPrefix(tenant)}#TYPE#SERIES`;

/** A player registration, partitioned under its club; naturalKey gives dedup. */
export const playerKey = (tenant: string, clubId: string, naturalKey: string) => ({
  pk: `${tenantPrefix(tenant)}#CLUB#${clubId}`,
  sk: `PLAYER#${naturalKey}`,
});

/** pk + sk-prefix to query all registrations for a club. */
export const playersListKey = (tenant: string, clubId: string) => ({
  pk: `${tenantPrefix(tenant)}#CLUB#${clubId}`,
  skPrefix: 'PLAYER#',
});

/**
 * Registration-link token. GLOBAL (not tenant-prefixed) and self-describing:
 * the item carries { tenant, clubId } so the public /register route resolves the
 * tenant from the token, never from the request host.
 */
export const tokenKey = (token: string) => ({
  pk: `TOKEN#${token}`,
  sk: 'META',
});

/** A user profile (memberships live here — source of truth for PreTokenGen). */
export const userKey = (sub: string) => ({
  pk: `USER#${sub}`,
  sk: 'META',
});

/**
 * Per-membership marker item: one per (user, tenant) so a user with multiple
 * memberships is enumerable under EVERY tenant they belong to (a single GSI on
 * the META item could only index one tenant). Listed via gsi1 for offboarding.
 */
export const userTenantMarkerKey = (sub: string, tenant: string) => ({
  pk: `USER#${sub}`,
  sk: `TENANT#${tenant}`,
});

/** gsi1 attributes that make a user-tenant marker listable within a tenant. */
export const userGsi1 = (tenant: string, email: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#USER`,
  gsi1sk: email,
});

export const usersListGsi1pk = (tenant: string) => `${tenantPrefix(tenant)}#TYPE#USER`;

/** Prefix used to erase an entire tenant's non-user items. */
export const tenantErasurePrefix = (tenant: string) => `${tenantPrefix(tenant)}#`;
